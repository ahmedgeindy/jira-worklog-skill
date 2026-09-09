// skills/jira-worklog/scripts/cmd/emit.mjs
// Renders the write commands the AGENT will run as its own tool calls.
// This module NEVER spawns. Nothing here can write to Jira.
import { buildAddArgv } from '../lib/plan.mjs'
import { psQuote, renderPsCommand } from '../lib/psline.mjs'

// psQuote / renderPsCommand live in lib/psline.mjs so that lib/preview.mjs can
// render the gate through the SAME renderer. Re-exported here because this is
// where callers (and the tests) have always found them.
export { psQuote, renderPsCommand }

/**
 * One literal command per entry, in write order.
 * Issues with no prior write history go FIRST: if one cannot accept a worklog
 * at all, that surfaces before the rest of the day is committed.
 *
 * NOTE: this function only ever CONSTRUCTS a `worklog add` argv (via
 * buildAddArgv) and renders it to text. It never calls lib/twg.mjs's run(), so
 * nothing here can reach a live Jira write — and since the I4 fix, run() itself
 * refuses a `worklog add` argv outright, so that is now an invariant rather
 * than an absence of callers.
 */
export function emitManifest(plan, date, bin) {
  const day = plan.days.find((d) => d.date === date)
  if (!day) throw new Error(`plan contains no day ${date}`)

  const ordered = [...day.entries].sort(
    (a, b) => Number(a.existingSecondsOnIssue ?? 0) - Number(b.existingSecondsOnIssue ?? 0),
  )

  return ordered.map((e) => ({
    fingerprint: e.fingerprint,
    key: e.key,
    seconds: e.seconds,
    command: renderPsCommand(buildAddArgv(e), bin),
  }))
}
