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

/** Recognise the row array in either response shape, or refuse. */
function extractRows(data) {
  if (Array.isArray(data)) return data
  if (data && Array.isArray(data.worklogs)) return data.worklogs
  throw new Error(
    `UNKNOWN: unrecognised worklog query shape (${JSON.stringify(data)?.slice(0, 120)}); ` +
    'an unreadable response is not an empty day',
  )
}

/**
 * Live REST read of the (issue, day) window. Never a local ledger.
 *
 * This is the ONLY live read standing between a re-run and a double-log:
 * classify([]) is CLEAR, and CLEAR authorises the write. So the zero it can
 * return must be positively controlled (spec 3.3), exactly as
 * lib/daytotal.mjs's pageWorklogs does — before this, an unexpected shape
 * returned [] and a truncated page returned a short list, and both read as
 * "nothing here, go ahead".
 *
 * meta.pagination.total is the FILTERED count, not the issue's lifetime count
 * (probed live 2026-09-09: an issue with 12 lifetime worklogs returned total 1
 * for a one-day window), so comparing it against rows.length is sound and does
 * not misfire.
 */
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

  const rows = extractRows(res.data)

  const declared = res.meta?.pagination?.total
  if (typeof declared !== 'number' || !Number.isInteger(declared)) {
    throw new Error(
      `UNKNOWN: dedup read ${key} carried no meta.pagination.total, so its row count cannot be ` +
      'positively controlled. A zero that cannot be proven is not a zero.',
    )
  }
  if (rows.length !== declared) {
    throw new Error(
      `UNKNOWN: dedup read ${key} returned ${rows.length} row(s) but meta.pagination.total is ${declared}; ` +
      'the window is truncated or filtered differently than assumed — refusing to call it CLEAR.',
    )
  }

  return rows
}
