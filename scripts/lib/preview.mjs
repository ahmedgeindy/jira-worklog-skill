// skills/jira-worklog/scripts/lib/preview.mjs
import { buildAddArgv, hashPlan } from './plan.mjs'
import { renderPsCommand } from './psline.mjs'
import { weekdayOf, isWorkday } from './tz.mjs'

const FLOOR_SECONDS = 7 * 3600
// Indent of the command line inside a preview block. The command itself is
// byte-identical to cmd/emit.mjs's manifest line; only this prefix differs.
const CMD_INDENT = '      '

const hours = (s) => `${(s / 3600).toFixed(1)}h`

/**
 * Render the approval gate for one day.
 *
 * `bin` is REQUIRED and is the same twg path cmd/emit.mjs is given, because the
 * line rendered here goes through the SAME renderer (lib/psline.mjs) as the line
 * the agent actually runs. Previously this module had its own `twg … "x"`
 * renderer while emit produced `& 'bin' 'x'`, so the human approved bytes that
 * were never executed and "preview == write" was not a property of anything.
 */
export function render(plan, day, bin) {
  if (!bin) {
    throw new Error(
      'render requires the twg binary path: the previewed line must be byte-identical to the emitted write line',
    )
  }
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
    lines.push(`${CMD_INDENT}${renderPsCommand(buildAddArgv(e), bin)}`)
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
  lines.push('  Pass it back verbatim: --expect-hash <planHash> on emit, check-cmd and check-write.')
  return lines.join('\n')
}
