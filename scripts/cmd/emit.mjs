// skills/jira-worklog/scripts/cmd/emit.mjs
// Renders the write commands the AGENT will run as its own tool calls.
// This module NEVER spawns. Nothing here can write to Jira.
import { buildAddArgv } from '../lib/plan.mjs'
import { assertArgvSafe } from '../lib/twg.mjs'

// Anything that could change how PowerShell parses the line, or that would let a
// comment smuggle a second command in. Refused at emit time, not escaped.
//
// `"` is included even though every argument is single-quoted (so `"` is
// inert to PowerShell in the write command itself): the agent loop
// re-wraps the emitted line as `--cmd "<line>"` for check-cmd, and an
// embedded `"` there breaks the outer quoting, which can make check-cmd's
// byte-equality comparison see a different string than the one that
// actually runs. Refusing at emit time is strictly safer than escaping it.
const UNSAFE = /["`$;&|<>\r\n\u0000]/

export function psQuote(arg) {
  const s = String(arg)
  if (UNSAFE.test(s)) {
    throw new Error(`unsafe character in argument, refusing to emit: ${JSON.stringify(s)}`)
  }
  return `'${s.replace(/'/g, "''")}'`
}

/** `& 'C:/twg/twg.exe' 'jira' 'workitem' … ` — no chaining, no redirection. */
export function renderPsCommand(argv, bin) {
  assertArgvSafe(argv)
  return [`& ${psQuote(bin)}`, ...argv.map(psQuote)].join(' ')
}

/**
 * One literal command per entry, in write order.
 * Issues with no prior write history go FIRST: if one cannot accept a worklog
 * at all, that surfaces before the rest of the day is committed.
 *
 * NOTE: this function only ever CONSTRUCTS a `worklog add` argv (via
 * buildAddArgv) and renders it to text. It never calls lib/twg.mjs's run(), so
 * nothing here can reach a live Jira write — see timelog.mjs and
 * task-11-13-report.md's Step 6 grep for the proof.
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
