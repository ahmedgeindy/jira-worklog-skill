// skills/jira-worklog/scripts/lib/capacity.mjs
//
// Month-to-date capacity and the progress ceiling. Pure: no I/O, no spawning.
//
// Why this exists: the day-level rails (7h floor, 12h plausibility ceiling) are
// per-day and cannot see an aggregate. A backfill that puts a defensible 7.5h on
// each of nine days passes every per-day check and still lands the month at
// 141.9% of capacity, which is what happened on 2026-09-14 (113.5h against 80h).
// Over-logging is not symmetric with under-logging: a short day is a policy gap
// you can close tomorrow, an over-claim is already on someone's report. So this
// is a REFUSAL, not the warning the floor is.
//
// The numbers are deliberately printed rather than just applied. Capacity is
// per-person in the real report - colleagues on the same dashboard show 80h,
// 72h and 64h for the same fortnight, i.e. 8h/day against DIFFERENT day counts
// (leave, start dates, part-time). This module cannot know any of that, so it
// states the model it used and takes an override instead of silently guessing.

import { weekdayOf } from './tz.mjs'

/** Company default. Matches the report tool's denominator: capacity / 8 is a whole day count. */
export const HOURS_PER_DAY = 8

/**
 * Integer percent, never a float ratio. `total * 100 > capacity * PERCENT` is
 * exact, so a month landing on precisely 105.0% passes and one second more
 * refuses. A `ratio = 1.05` multiply cannot promise that.
 */
export const CEILING_PERCENT = 105

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const WORKDAYS = new Set(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday'])

function assertIsoDate(d, what = 'date') {
  if (!DATE_RE.test(String(d))) throw new Error(`${what}: expected YYYY-MM-DD, got ${JSON.stringify(d)}`)
}

/** First and last calendar day of `isoDate`'s month. */
export function monthBounds(isoDate) {
  assertIsoDate(isoDate)
  const [y, m] = isoDate.split('-').map(Number)
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate() // day 0 of next month
  return {
    first: `${isoDate.slice(0, 7)}-01`,
    last: `${isoDate.slice(0, 7)}-${String(last).padStart(2, '0')}`,
  }
}

/** Sunday-Thursday days in [fromIso, toIso], inclusive. Reversed range -> 0. */
export function workdaysInRange(fromIso, toIso) {
  assertIsoDate(fromIso, 'from')
  assertIsoDate(toIso, 'to')
  let n = 0
  const end = Date.parse(`${toIso}T00:00:00Z`)
  for (let t = Date.parse(`${fromIso}T00:00:00Z`); t <= end; t += 86400000) {
    if (WORKDAYS.has(weekdayOf(new Date(t).toISOString().slice(0, 10)))) n += 1
  }
  return n
}

/**
 * The month-to-date window(s) to measure, for a plan touching `plannedDates`
 * while the Jira-zone calendar reads `todayIso`. One entry per month the plan
 * touches, because a 5-day plan may straddle a month boundary and each month
 * has its own capacity.
 *
 * Backfilling an earlier day does not shrink capacity (the days since still
 * happened), and planning a later day inside this month does not stretch the
 * window past that day. A plan in a PAST month gets that whole month: its
 * capacity stopped accruing at the month end, not at today.
 */
export function monthWindow({ todayIso, plannedDates }) {
  assertIsoDate(todayIso, 'today')
  const dates = [...plannedDates].sort()
  if (dates.length === 0) throw new Error('monthWindow: no planned dates')
  for (const d of dates) assertIsoDate(d, 'planned date')
  const months = [...new Set(dates.map((d) => d.slice(0, 7)))]
  return months.map((ym) => {
    const inMonth = dates.filter((d) => d.startsWith(ym))
    const { first, last } = monthBounds(inMonth[0])
    const latestPlanned = inMonth[inMonth.length - 1]
    const todayMonth = todayIso.slice(0, 7)
    let through
    if (todayMonth === ym) through = todayIso > latestPlanned ? todayIso : latestPlanned
    else if (todayMonth > ym) through = last // the month is over; all of it accrued
    else through = latestPlanned // a future month has accrued nothing yet
    return { month: ym, from: first, to: through > last ? last : through }
  })
}

export function capacitySeconds({ fromIso, toIso, hoursPerDay = HOURS_PER_DAY }) {
  if (!Number.isFinite(hoursPerDay) || hoursPerDay <= 0) {
    throw new Error(`capacity: hoursPerDay must be a positive number, got ${JSON.stringify(hoursPerDay)}`)
  }
  return workdaysInRange(fromIso, toIso) * hoursPerDay * 3600
}

/**
 * The verdict. `loggedSeconds` is what the server already holds for the window;
 * `plannedSeconds` is what this run would add on top (including anything an
 * earlier day of the same multi-day run has already been previewed but has not
 * landed yet - see cmd/plan.mjs's pendingSeconds).
 *
 * Returns ok:false together with every number that produced it, so the refusal
 * can be re-derived by hand. A verdict nobody can audit is the same false-green
 * class as a check that passes against the wrong thing.
 */
export function ceilingVerdict({
  loggedSeconds,
  plannedSeconds,
  capacitySeconds: cap,
  ceilingPercent = CEILING_PERCENT,
}) {
  const logged = Number(loggedSeconds)
  const planned = Number(plannedSeconds)
  const capSec = Number(cap)
  if (!Number.isFinite(logged) || !Number.isFinite(planned) || !Number.isFinite(capSec)) {
    throw new Error('ceilingVerdict: loggedSeconds, plannedSeconds and capacitySeconds must all be numbers')
  }
  const total = logged + planned
  const ceilingSeconds = Math.round((capSec * ceilingPercent) / 100)

  if (capSec === 0) {
    // Zero workdays in the window. Any positive total is infinite percent, and
    // reporting "0%" here would be a silent pass on exactly the case where the
    // model does not apply. Refuse, and say which assumption broke.
    return {
      ok: total === 0,
      total, logged, planned,
      capacitySeconds: 0, ceilingSeconds: 0, percent: null, excessSeconds: total,
      reason: total === 0
        ? ''
        : 'capacity is 0 (no Sunday-Thursday workdays in the window), so progress cannot be computed',
    }
  }

  // Exact integer comparison: 105.0% passes, 105.0% plus one second refuses.
  const ok = total * 100 <= capSec * ceilingPercent
  return {
    ok,
    total, logged, planned,
    capacitySeconds: capSec,
    ceilingSeconds,
    percent: (total * 100) / capSec,
    excessSeconds: ok ? 0 : total - ceilingSeconds,
    reason: ok
      ? ''
      : `month-to-date would reach ${((total * 100) / capSec).toFixed(1)}% of capacity; the ceiling is ${ceilingPercent}%`,
  }
}

const h = (s) => `${(s / 3600).toFixed(2)}h`

/** One auditable line per fact. The operator must be able to redo this arithmetic. */
export function explain({
  window,
  verdict,
  hoursPerDay = HOURS_PER_DAY,
  capacityOverridden = false,
  ceilingPercent = CEILING_PERCENT,
}) {
  const days = workdaysInRange(window.from, window.to)
  const model = capacityOverridden
    ? `capacity ${h(verdict.capacitySeconds)} (OVERRIDDEN via --capacity-hours; computed value was ${days} workdays x ${hoursPerDay}h)`
    : `capacity ${h(verdict.capacitySeconds)} = ${days} workdays (Sun-Thu, ${window.from}..${window.to}) x ${hoursPerDay}h`
  return [
    `  MONTH ${window.month}: ${model}`,
    `    already on server ${h(verdict.logged)} + this plan ${h(verdict.planned)} = ${h(verdict.total)}` +
      (verdict.percent === null ? '' : ` (${verdict.percent.toFixed(1)}%)`),
    `    ${ceilingPercent}% ceiling = ${h(verdict.ceilingSeconds)}`,
  ]
}
