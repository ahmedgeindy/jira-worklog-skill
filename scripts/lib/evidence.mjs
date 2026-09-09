// skills/jira-worklog/scripts/lib/evidence.mjs
import { createHash } from 'node:crypto'
import { run as realRun, assertTrustworthy } from './twg.mjs'
import { dayOfInstant } from './tz.mjs'

// Words that mark a line as carrying a secret. Whole-line DROP, not masking:
// masking leaves the surrounding context, which is often enough to reconstruct.
const SECRET_WORDS = /\b(pwd|passwd|password|secret|token|pat|apikey|api[_-]?key|credential|bearer|private[_-]?key)\b/i
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/
const IPV6 = /\b(?:[0-9a-f]{1,4}:){4,}[0-9a-f]{0,4}\b/i

/** Returns the line, or null when the line must never leave this machine. */
export function redact(line) {
  const s = String(line ?? '')
  if (!s.trim()) return null
  if (SECRET_WORDS.test(s)) return null
  if (IPV4.test(s)) return null
  if (IPV6.test(s)) return null
  return s
}

/**
 * The ONLY source that carries author + timestamp + what-changed together.
 * `status` from `workitem get` is a STATE, not an event, and narrating it as a
 * transition is fabrication (4 of HCFM-323's 6 entries belong to someone else).
 * GET-only against a hardcoded path (decision D2).
 */
export function changelogEvidence({ key, isoDate, accountId, zone, deps = {} }) {
  const run = deps.run ?? realRun
  let res
  try {
    res = run(['api', `jira:/rest/api/3/issue/${key}/changelog`])
    assertTrustworthy(res, `changelog ${key}`)
  } catch {
    return [] // absence of evidence, never an invented fact
  }

  const values = res.data?.values ?? []
  return values
    .filter((v) => v?.author?.accountId === accountId)
    .filter((v) => {
      const t = Date.parse(String(v.created).replace(/([+-]\d{2})(\d{2})$/, '$1:$2'))
      return Number.isFinite(t) && dayOfInstant(t, zone) === isoDate
    })
    .map((v) => ({
      source: 'jira-changelog',
      timestamp: v.created,
      fragment: (v.items ?? [])
        .map((i) => `${i.field}: ${i.toString ?? ''}`.trim())
        .join('; '),
    }))
    .filter((e) => e.fragment.length > 0)
}

export function hashBundle(perIssue) {
  return createHash('sha256')
    .update(JSON.stringify(perIssue))
    .digest('hex')
    .slice(0, 16)
}

/**
 * Assemble the per-issue evidence for one day.
 * commentSource is USER_SUPPLIED_REQUIRED when no same-day primary source
 * exists — the skill must then ask rather than invent.
 */
export function bundle({ isoDate, keys, zone, accountId, deps = {} }) {
  const perIssue = {}
  for (const key of keys) {
    perIssue[key] = changelogEvidence({ key, isoDate, accountId, zone, deps })
  }
  const any = Object.values(perIssue).some((v) => v.length > 0)
  return {
    perIssue,
    commentSource: any ? 'EVIDENCED' : 'USER_SUPPLIED_REQUIRED',
    bundleHash: hashBundle(perIssue),
  }
}
