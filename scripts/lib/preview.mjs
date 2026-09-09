// skills/jira-worklog/scripts/lib/preview.mjs
import { buildAddArgv, hashPlan } from './plan.mjs'
import { weekdayOf, isWorkday } from './tz.mjs'

const FLOOR_SECONDS = 7 * 3600

const hours = (s) => `${(s / 3600).toFixed(1)}h`

/** Render an argv array as the literal command, with no shell quoting games. */
export function renderArgv(argv) {
  return ['twg', ...argv]
    .map((t) => (/\s/.test(t) ? `"${t}"` : t))
    .join(' ')
}

export function render(plan, day) {
  const lines = []
  const weekday = weekdayOf(day.date)
  const planned = day.entries.reduce((a, e) => a + Number(e.seconds), 0)
  const total = Number(day.existingSeconds ?? 0) + planned

  lines.push(`DAY ${day.date} (${weekday})`)
  if (!isWorkday(day.date)) {
    lines.push(`  !! ${weekday} is outside the Sunday-Thursday work week (87/87 of your worklogs).`)
    lines.push('  !! To proceed you must restate the date explicitly. Do not answer y.')
  }
  lines.push(`  already on server: ${hours(day.existingSeconds ?? 0)}`)
  lines.push('')

  for (const e of day.entries) {
    lines.push(`  ${e.key}  ${hours(e.seconds)}  [${e.dedupeState}]${e.hoursSource === 'derived' ? '  (hours DERIVED by the model, not stated by you)' : ''}`)
    if (e.dedupeState === 'EXISTING') {
      lines.push(`      you already have ${hours(e.existingSecondsOnIssue ?? 0)} on this issue for this day`)
    }
    lines.push(`      comment: ${e.comment}`)
    for (const ev of e.evidence ?? []) {
      lines.push(`      evidence: ${ev.source} @ ${ev.timestamp} :: ${ev.fragment}`)
    }
    lines.push(`      ${renderArgv(buildAddArgv(e))}`)
    lines.push('')
  }

  lines.push(`  resulting day total: ${hours(total)}`)
  if (total < FLOOR_SECONDS) {
    // States the fact and the floor. Never computes what would close the gap,
    // never names an issue to put it on (decision D1a).
    lines.push(`  STATUS: SHORT - this day will hold ${hours(total)}; company policy floor is 7h.`)
  } else {
    lines.push('  STATUS: MEETS the 7h floor')
  }
  lines.push('')
  lines.push(`  planHash: ${hashPlan(plan)}`)
  lines.push('  This approves exactly the rows above, for exactly this date.')
  return lines.join('\n')
}
