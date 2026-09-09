// The frozen twg write contract. Preflight asserts these still exist before any run.
// Each entry is justified in ../../references/twg-worklog-contract.md.

export const REQUIRED_ADD_FLAGS = Object.freeze([
  '--time-spent-seconds',
  '--started',
  '--adjust-estimate',
  '--notify-users',
  '--comment-format',
])

// Tokens whose presence anywhere in a constructed argv is a hard error.
// --time-spent is forbidden because on this site 1d = 8h, not 24h, and the
// display-string path has no safe reading.
export const FORBIDDEN_TOKENS = Object.freeze([
  '--override-editable', '--input-json', '--variables-json', '--time-spent', '2>&1',
])

export const FORBIDDEN_SUBCOMMANDS = Object.freeze(['delete', 'update'])

/**
 * Assert the live `twg help describe "jira workitem worklog add"` output still
 * advertises every flag this skill depends on. A renamed or removed flag must
 * stop the run and point at references/twg-worklog-contract.md.
 */
export function checkContract(helpText) {
  const missing = REQUIRED_ADD_FLAGS.filter(
    // word-boundary match so `--time-spent` never satisfies `--time-spent-seconds`
    (flag) => !new RegExp(`${flag}(?![\\w-])`).test(helpText),
  )
  return { ok: missing.length === 0, missing }
}
