// All Jira-zone date math. Pure: no I/O, no spawning, no network.
//
// Invariants this module exists to protect:
//  - the IANA zone name is the source of truth; a bare offset loses per-date DST
//  - twg's --started-after/--started-before are STRICTLY exclusive on both ends
//  - --started must be 'yyyy-MM-ddTHH:mm:ss.SSS+0300' (millis, colon-less offset)

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
// Company work week, established from 87/87 of this user's worklogs.
const WORKDAYS = new Set(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday'])

function assertIsoDate(d) {
  if (!DATE_RE.test(d)) throw new Error(`expected YYYY-MM-DD, got ${JSON.stringify(d)}`)
}

/** Offset of `zone` on the calendar date `isoDate`, as '+0300' (no colon). */
export function offsetFor(zone, isoDate) {
  assertIsoDate(isoDate)
  // Probe at 12:00 UTC: far from any DST transition instant, so the offset we
  // read is the one that governs the bulk of that local day.
  const probe = new Date(`${isoDate}T12:00:00Z`)
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    timeZoneName: 'longOffset',
  }).formatToParts(probe)
  const name = parts.find((p) => p.type === 'timeZoneName')?.value ?? ''
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(name)
  if (!m) {
    if (name === 'GMT') return '+0000'
    throw new Error(`cannot resolve offset for zone ${zone} on ${isoDate}: got "${name}"`)
  }
  return `${m[1]}${m[2]}${m[3]}`
}

function withColon(off) {
  return `${off.slice(0, 3)}:${off.slice(3)}`
}

export function addDays(isoDate, n) {
  assertIsoDate(isoDate)
  const ms = Date.parse(`${isoDate}T00:00:00Z`) + n * 86400000
  return new Date(ms).toISOString().slice(0, 10)
}

/** Epoch ms of local midnight on `isoDate` and on the following day. */
export function dayBounds(zone, isoDate) {
  assertIsoDate(isoDate)
  const next = addDays(isoDate, 1)
  const e0 = Date.parse(`${isoDate}T00:00:00.000${withColon(offsetFor(zone, isoDate))}`)
  const e1 = Date.parse(`${next}T00:00:00.000${withColon(offsetFor(zone, next))}`)
  if (!Number.isFinite(e0) || !Number.isFinite(e1)) {
    throw new Error(`cannot compute day bounds for ${isoDate} in ${zone}`)
  }
  return { e0, e1 }
}

/**
 * The window to send to twg. Both twg bounds are STRICTLY exclusive (proven to
 * 1ms in both directions), so the lower bound is widened by 1ms; without this a
 * worklog started at exactly 00:00:00.000 local is invisible to its own day.
 */
export function queryWindow(zone, isoDate) {
  const { e0, e1 } = dayBounds(zone, isoDate)
  return { after: e0 - 1, before: e1 }
}

/** The only known-good --started format, from live reads. */
export function startedString(zone, isoDate, hms) {
  assertIsoDate(isoDate)
  // The hour is bounded at 23 on purpose: 24:00:00 formats into a string that
  // PARSES as 00:00 the NEXT day, filing the worklog onto the wrong Jira date
  // while still looking like a valid past instant to assertNotFuture.
  if (!/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(hms)) {
    throw new Error(`expected HH:mm:ss inside a single day, got ${hms}`)
  }
  return `${isoDate}T${hms}.000${offsetFor(zone, isoDate)}`
}

/** Which Jira calendar day an instant falls on, in `zone`. */
export function dayOfInstant(epochMs, zone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(epochMs))
  const get = (t) => parts.find((p) => p.type === t).value
  return `${get('year')}-${get('month')}-${get('day')}`
}

export function weekdayOf(isoDate) {
  assertIsoDate(isoDate)
  return WEEKDAYS[new Date(`${isoDate}T00:00:00Z`).getUTCDay()]
}

export function isWorkday(isoDate) {
  return WORKDAYS.has(weekdayOf(isoDate))
}

/** Refuse a future INSTANT, not merely a future calendar date. */
export function assertNotFuture(startedIso, nowMs) {
  const t = Date.parse(String(startedIso).replace(/([+-]\d{2})(\d{2})$/, '$1:$2'))
  if (!Number.isFinite(t)) throw new Error(`unparseable started value: ${startedIso}`)
  if (t > nowMs) {
    throw new Error(`refusing to log a worklog in the future: ${startedIso} is after now`)
  }
}

/**
 * True when the machine's calendar date and the Jira zone's calendar date
 * disagree right now. When true, every relative day word ("today") is a HARD
 * STOP and the caller must demand an explicit date.
 */
export function localVsJiraDateDiffers(zone, nowMs) {
  const local = new Date(nowMs)
  const localDay = [
    local.getFullYear(),
    String(local.getMonth() + 1).padStart(2, '0'),
    String(local.getDate()).padStart(2, '0'),
  ].join('-')
  return localDay !== dayOfInstant(nowMs, zone)
}
