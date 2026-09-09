// skills/jira-worklog/scripts/lib/dedup.mjs
import { createHash } from 'node:crypto'
import { queryWindow } from './tz.mjs'
import { run as realRun, assertTrustworthy, assertEcho } from './twg.mjs'

/**
 * Identity of a planned worklog. Comment text is EXCLUDED so a reworded comment
 * on a re-run still matches.
 */
export function fingerprint({ accountId, key, isoDate, seconds }) {
  return createHash('sha256')
    .update(`v1|${accountId}|${key}|${isoDate}|${seconds}`)
    .digest('hex')
    .slice(0, 16)
}

export function markerFor(fp) {
  return `[twl:${fp}]`
}

/**
 * Worklog comments come back as ADF objects, and the `comment` key is ABSENT
 * (not null) when there is none. A substring test on the object silently never
 * matches, so the tree must be walked for type==='text' nodes.
 */
export function flattenAdf(comment) {
  if (comment == null) return ''
  if (typeof comment === 'string') return comment
  const out = []
  const walk = (n) => {
    if (!n || typeof n !== 'object') return
    if (n.type === 'text' && typeof n.text === 'string') out.push(n.text)
    const kids = Array.isArray(n.content) ? n.content : []
    for (const k of kids) walk(k)
  }
  walk(comment)
  return out.join('').trim()
}

/**
 * Three-tier ladder. Tier 3 deliberately EXCLUDES seconds: if I already have
 * any time on this issue for this day, the answer is EXISTING, never CLEAR.
 */
export function classify(rows, { accountId, seconds, fp }) {
  const list = rows ?? []
  if (list.some((r) => r && r.author?.accountId === undefined)) return 'AMBIGUOUS'

  const mine = list.filter((r) => r?.author?.accountId === accountId)
  if (mine.length === 0) return 'CLEAR'

  const marker = markerFor(fp)
  if (mine.some((r) => flattenAdf(r.comment).includes(marker))) return 'DUPLICATE'
  if (mine.some((r) => Number(r.timeSpentSeconds) === Number(seconds))) return 'DUPLICATE'
  return 'EXISTING'
}

/** Live REST read of the (issue, day) window. Never a local ledger. */
export function checkWindow({ key, accountId, zone, isoDate, deps = {} }) {
  const run = deps.run ?? realRun
  const w = queryWindow(zone, isoDate)
  const argv = [
    'jira', 'workitem', 'worklog', 'query',
    '--issue-id', key,
    '--started-after', String(w.after),
    '--started-before', String(w.before),
    '--first', '100',
    '-o', 'json',
  ]
  const res = run(argv)
  assertTrustworthy(res, `dedup read ${key}`)
  if (res.request) assertEcho({ startedAfter: w.after, startedBefore: w.before }, res.request)
  return Array.isArray(res.data) ? res.data : (res.data?.worklogs ?? [])
}
