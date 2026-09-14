// skills/jira-worklog/scripts/lib/planfile.mjs
// The ONE way a frozen plan re-enters this tool.
//
// Decision D3a: "the planHash prefix is printed in the gate and required back
// via --expect-hash". Everything the guards trust — plan.accountId (the dedup
// filter), estimateBefore, dedupeState, seconds, started, comment — lives in a
// JSON file the calling agent owns and can rewrite between the human's `y` and
// the write. Without this module: the human approves preview A (2h), the agent
// re-runs `plan` with a different split, and emit / check-cmd / check-write all
// validate against the NEW file and go green on hours nobody ever saw.
//
// Two independent gates, both required:
//   1. self-check   — hashPlan(plan) must equal the stored plan.planHash, so a
//                     hand-edited field is caught even if the human re-types the
//                     prefix they were shown.
//   2. --expect-hash — the prefix the human read at the gate must prefix-match
//                     the recomputed hash, so a WHOLESALE re-plan (internally
//                     consistent, different hours) is caught too.
import { readFileSync } from 'node:fs'
import { hashPlan } from './plan.mjs'

// A 1-character prefix matches 1 in 16 plans; that is not a gate. The gate
// prints all 12 hex characters, so requiring half of them is free to the human
// and leaves a forger a 1-in-16-million coincidence.
export const MIN_EXPECT_HASH_LENGTH = 6

/**
 * Recompute the hash, refuse a plan that disagrees with its own stored hash,
 * and refuse an --expect-hash that does not prefix-match. Returns the
 * recomputed hash.
 */
export function assertPlanIntegrity(plan, expectHash, { requireExpectHash = true } = {}) {
  if (!plan || typeof plan !== 'object' || !Array.isArray(plan.days)) {
    throw new Error('ABORT: this is not a worklog plan (no days[])')
  }
  const recomputed = hashPlan(plan)

  if (!plan.planHash) {
    throw new Error('ABORT: plan file carries no planHash; re-run `plan` and approve the preview it prints')
  }
  // A plan written before the progress ceiling existed has no `months` key,
  // and hashPlan's canonical form now includes one - so its stored hash can
  // never match and it would otherwise be reported as "changed since it was
  // previewed". That is the right REFUSAL with an accusing and untrue reason:
  // nobody edited the file. Name the real cause, because the operator should
  // never have to work out that a tool upgrade is what broke their plan.
  if (!Array.isArray(plan.months)) {
    throw new Error(
      'ABORT: this plan file was written before the 105% month progress ceiling existed, so it was ' +
      'never checked against it (no `months` block). Nothing here may be written. Re-run `plan` ' +
      'and approve the new preview.',
    )
  }
  if (String(plan.planHash) !== recomputed) {
    throw new Error(
      `ABORT: this plan file has changed since it was previewed — stored planHash ${plan.planHash}, ` +
      `recomputed ${recomputed}. Nothing here may be written. Re-run \`plan\` and re-approve the preview.`,
    )
  }

  const prefix = String(expectHash ?? '').trim().toLowerCase()
  if (!prefix) {
    if (!requireExpectHash) return recomputed
    throw new Error(
      'ABORT: --expect-hash is required. Paste back the planHash printed at the approval gate ' +
      `(at least ${MIN_EXPECT_HASH_LENGTH} characters). One approval covers exactly the rows that were on screen.`,
    )
  }
  if (prefix.length < MIN_EXPECT_HASH_LENGTH) {
    throw new Error(
      `ABORT: --expect-hash ${prefix} is too short to be a gate; give at least ${MIN_EXPECT_HASH_LENGTH} characters of the planHash.`,
    )
  }
  if (!recomputed.startsWith(prefix)) {
    throw new Error(
      `ABORT: --expect-hash ${prefix} does not match this plan (planHash ${recomputed}). ` +
      'You are about to write rows other than the ones that were approved.',
    )
  }
  return recomputed
}

/** Read a plan file and run both gates before any caller can touch it. */
export function loadPlanFile({ path, expectHash, requireExpectHash = true, deps = {} }) {
  const read = deps.readFile ?? ((p) => readFileSync(p, 'utf8'))
  let plan
  try {
    plan = JSON.parse(read(path))
  } catch (e) {
    throw new Error(`ABORT: cannot read plan file ${path}: ${e.message}`)
  }
  assertPlanIntegrity(plan, expectHash, { requireExpectHash })
  return plan
}
