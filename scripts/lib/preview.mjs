// skills/jira-worklog/scripts/lib/preview.mjs
import { buildAddArgv, hashPlan } from './plan.mjs'
import { renderPsCommand } from './psline.mjs'
import { weekdayOf, isWorkday } from './tz.mjs'

const FLOOR_SECONDS = 7 * 3600
// Indent of the command line inside a preview block. The command itself is
// byte-identical to cmd/emit.mjs's manifest line; only this prefix differs.
const CMD_INDENT = '      '

const hours = (s) => `${(s / 3600).toFixed(1)}h`

// The entry's clock time, straight out of `started` ('...T11:00:00.000+0300').
// Rendered here because previously the start time was visible ONLY inside the
// rendered command at the bottom of the block — a human approving the gate at
// a glance could easily miss that two lines for the same issue landed at
// different times (or, worse, the same time).
function startClock(started) {
  const m = /T(\d{2}:\d{2}):\d{2}\./.exec(String(started ?? ''))
  return m ? m[1] : '??:??'
}

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
    // task-14 Fix B: a USER_SUPPLIED comment is labelled at the gate the same
    // way DERIVED hours already are - the human must be able to see which
    // comments they authored and which the tool composed from evidence.
    const commentLabel = e.commentSource === 'USER_SUPPLIED' ? '  (comment USER_SUPPLIED, not evidence-derived)' : ''
    // A pinned '@HH:MM' is labelled the same way DERIVED hours and
    // USER_SUPPLIED comments already are, so the human can see at a glance
    // which entries they placed on the clock themselves versus which the
    // sequencer placed for them.
    const startLabel = e.startAt ? '  (start PINNED by you)' : ''
    lines.push(`  ${e.key}  ${hours(e.seconds)}  @${startClock(e.started)}${startLabel}  [${e.dedupeState}]${e.hoursSource === 'derived' ? '  (hours DERIVED by the model, not stated by you)' : ''}${commentLabel}`)
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

/**
 * Render every day's preview FIRST, and only call `persist` once every one of
 * them has rendered without throwing (task-14 Fix A #3).
 *
 * timelog.mjs's `plan` command used to writeFileSync the plan to disk, then
 * call render() per day. Anything that made a day unrenderable — including,
 * before Fix A's sanitization, an ordinary evidence value like 'R&D' making
 * buildAddArgv/psQuote refuse the comment — crashed AFTER the file already
 * existed on disk, leaving a stale plan file that a later --expect-hash could
 * be pointed at even though no human ever saw its preview. Building every
 * block before the single `persist` call makes that ordering a property of
 * this function rather than of the caller remembering to get it right.
 */
export function renderThenPersist(plan, bin, persist) {
  const blocks = plan.days.map((day) => render(plan, day, bin))
  persist()
  return blocks
}
