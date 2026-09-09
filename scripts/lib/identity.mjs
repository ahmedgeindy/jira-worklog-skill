// skills/jira-worklog/scripts/lib/identity.mjs
import { run as realRun, assertTrustworthy } from './twg.mjs'

// GET-only, hardcoded. No user-supplied path ever reaches `twg api` (decision D2).
const MYSELF_PATH = 'jira:/rest/api/3/myself'

/**
 * Resolve the caller's accountId and IANA timezone, once per run.
 *
 * MUST NOT be derived from `worklog query --first 1`: a per-issue worklog query
 * returns EVERY author's rows, so that route returns whoever logged first
 * (verified: EAK21GEOO-281 returns Habiba Hossam). A wrong accountId poisons
 * the day total and the dedup filter simultaneously.
 */
export function resolveIdentity(deps = {}) {
  const run = deps.run ?? realRun
  const res = run(['api', MYSELF_PATH])
  assertTrustworthy(res, 'twg api /myself')

  const me = res.data
  if (!me?.accountId) throw new Error('UNKNOWN: /myself returned no accountId')

  const zone = me.timeZone
  if (!zone) {
    throw new Error('UNKNOWN: /myself returned no timeZone; cannot do Jira-day math safely')
  }
  if (!/^[A-Za-z]+\/[A-Za-z_+-]+/.test(zone)) {
    throw new Error(
      `refusing a non-IANA timezone ${JSON.stringify(zone)}: a bare offset loses per-date DST correctness`,
    )
  }

  return { accountId: me.accountId, zone, displayName: me.displayName ?? null }
}

export function assertAccountId(used, resolved) {
  if (used !== resolved) {
    throw new Error(`accountId mismatch: filtering on ${used} but identity resolved to ${resolved}`)
  }
}
