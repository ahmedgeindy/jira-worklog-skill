// skills/jira-worklog/scripts/lib/psline.mjs
// The single renderer of a PowerShell write line.
//
// cmd/emit.mjs (the manifest the agent actually runs) and lib/preview.mjs (the
// line the human approves at the gate) BOTH render through here, so
// "previewed == written" is a property of the code rather than a habit. Two
// renderers in two modules IS the drift hazard, so there is only one.
import { assertNoForbiddenTokens } from './twg.mjs'

// Anything that could change how PowerShell parses the line, or that would let a
// comment smuggle a second command in. Refused at render time, not escaped.
//
// `"` is included even though every argument is single-quoted (so `"` is
// inert to PowerShell in the write command itself): the agent loop
// re-wraps the emitted line as `--cmd "<line>"` for check-cmd, and an
// embedded `"` there breaks the outer quoting, which can make check-cmd's
// byte-equality comparison see a different string than the one that
// actually runs. Refusing at render time is strictly safer than escaping it.
const UNSAFE = /["`$;&|<>\r\n\u0000]/

// Exported so callers that build comment text (lib/plan.mjs's
// sanitizeCommentText / cmd/plan.mjs) can verify a candidate is actually safe
// BEFORE handing it to psQuote, using the exact same rule rather than a
// hand-copied approximation of it.
export const UNSAFE_CHARS = UNSAFE

export function psQuote(arg) {
  const s = String(arg)
  if (UNSAFE.test(s)) {
    throw new Error(`unsafe character in argument, refusing to emit: ${JSON.stringify(s)}`)
  }
  return `'${s.replace(/'/g, "''")}'`
}

/**
 * `& 'C:/twg/twg.exe' 'jira' 'workitem' … ` — no chaining, no redirection.
 *
 * Uses assertNoForbiddenTokens, not assertArgvSafe: this renders TEXT for a
 * human and for the agent's own tool call, and the text it renders is a
 * `worklog add`, which assertArgvSafe refuses outright so that nothing in this
 * process can ever spawn one (see lib/twg.mjs).
 */
export function renderPsCommand(argv, bin) {
  assertNoForbiddenTokens(argv)
  return [`& ${psQuote(bin)}`, ...argv.map(psQuote)].join(' ')
}
