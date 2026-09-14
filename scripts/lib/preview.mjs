// skills/jira-worklog/scripts/lib/preview.mjs
import { buildAddArgv, hashPlan } from './plan.mjs'
import { renderPsCommand } from './psline.mjs'
import { weekdayOf, isWorkday } from './tz.mjs'

const FLOOR_SECONDS = 7 * 3600
const CEILING_SECONDS = 12 * 3600
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
    if (e.issueVocabMismatch) {
      lines.push(`      ?? this comment shares no wording with the issue "${e.summary ?? ''}" - is this the right issue?`)
    }
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
  } else if (total >= CEILING_SECONDS) {
    // The floor was the only threshold checked here, so a 19h day rendered as
    // "MEETS the 7h floor" and read as approval. State the number instead.
    lines.push(`  STATUS: EXCEEDS - this day will hold ${hours(total)}, over the ${hours(CEILING_SECONDS)} plausibility ceiling. VERIFY before approving.`)
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

/**
 * The month-to-date progress block, printed once after every day's gate.
 *
 * A plan that reaches this point is already UNDER the ceiling - cmd/plan.mjs
 * refuses above it - so this block is not a warning, it is the arithmetic behind
 * a number the human is about to make true. It exists because "105%" in this
 * tool and "105%" on the company dashboard are only the same number if the
 * capacity model matches, and the model here (Sun-Thu workdays x 8h, or an
 * operator override) cannot see leave or a mid-month start. Printing the model
 * makes a mismatch visible instead of silent.
 */
export function renderMonths(plan) {
  const months = plan.months ?? []
  if (months.length === 0) {
    // Never render an empty, reassuring block. A plan without a month section
    // was produced by something that did not run the ceiling check.
    return 'MONTH PROGRESS: not evaluated for this plan.'
  }
  const lines = ['MONTH-TO-DATE PROGRESS']
  for (const m of months) {
    lines.push(...m.explain)
    const headroom = (m.capacitySeconds * m.ceilingPercent) / 100 - (m.loggedSeconds + m.plannedSeconds)
    lines.push(`    room left under the ceiling after this plan: ${(headroom / 3600).toFixed(2)}h`)
    if (m.capacityOverridden) {
      lines.push('    !! capacity was supplied by you, not measured. The ceiling is only as right as that number.')
    }
  }
  return lines.join('\n')
}
