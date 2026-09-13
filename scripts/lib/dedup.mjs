// skills/jira-worklog/scripts/lib/dedup.mjs
import { createHash } from 'node:crypto'
import { queryWindow } from './tz.mjs'
import { run as realRun, assertTrustworthy, assertEcho } from './twg.mjs'

/**
 * Identity of a planned worklog. Comment text is EXCLUDED so a reworded comment
 * on a re-run still matches.
 *
 * v2 adds `started`. v1 hashed only accountId|key|isoDate|seconds, so two
 * entries cmd/plan.mjs explicitly ALLOWS — same issue, same day, distinct
 * '@HH:MM', identical duration — collided on one fingerprint. They shared a
 * single approval token, so the second check-write reported GUARD BYPASSED
 * against a write that was perfectly legitimate.
 *
 * Bumping the version invalidates plan files written by an earlier build:
 * planHash covers the entries, so loadPlanFile refuses them rather than
 * silently checking the wrong entry. Re-run `plan`.
 */
export function fingerprint({ accountId, key, isoDate, seconds, started }) {
  return createHash('sha256')
    .update(`v2|${accountId}|${key}|${isoDate}|${seconds}|${started ?? ''}`)
    .digest('hex')
    .slice(0, 16)
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
 *
 * There used to be a tier above the duration check: a '[twl:<fingerprint>]'
 * marker appended to every comment, matched here to recognise an exact re-run.
 * It was removed because it put tool metadata in front of every human who reads
 * a worklog in Jira. Re-run protection is unchanged in practice — a re-run
 * plans the same duration on the same issue and day, so the duration check
 * below still returns DUPLICATE and check-cmd still aborts before any write.
 * What is lost is only the ability to tell "this exact entry" from "some other
 * entry of the same length"; cmd/guard.mjs#checkWrite now does that with
 * started+seconds instead.
 */
export function classify(rows, { accountId, seconds }) {
  const list = rows ?? []
  if (list.some((r) => r && r.author?.accountId === undefined)) return 'AMBIGUOUS'

  const mine = list.filter((r) => r?.author?.accountId === accountId)
  if (mine.length === 0) return 'CLEAR'

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
