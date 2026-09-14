// scripts/test/monthtotal.test.mjs
//
// monthTotal feeds the progress ceiling. Its one catastrophic failure mode is a
// FALSE ZERO: a zero clears the ceiling for any plan at all, turning the rail
// into an authorisation. Most of what is tested here is the machinery that
// refuses to return a number it cannot stand behind.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { monthTotal } from '../lib/daytotal.mjs'
import { toEnvelope } from '../lib/twg.mjs'

const ME = '712020:00000000-1111-2222-3333-444444444444'
const ZONE = 'Asia/Riyadh'

const ok = (payload) => ({ ...toEnvelope(payload), exit: 0 })

/** started string in the exact shape twg returns ('...T09:00:00.000+0300'). */
const at = (isoDate, hms = '09:00:00') => `${isoDate}T${hms}.000+0300`

function wl(id, isoDate, hours, accountId = ME, hms = '09:00:00') {
  return { id, author: { accountId }, timeSpentSeconds: hours * 3600, started: at(isoDate, hms) }
}

/**
 * A fake twg. `issues` is what JQL discovery returns; `rows` maps issue key to
 * its worklog rows.
 */
function fakeRun({ issues = [], rows = {}, calls = null } = {}) {
  return (argv) => {
    if (calls) calls.push(argv)
    if (argv[1] === 'workitem' && argv[2] === 'query') {
      return ok({ data: { issues: issues.map((key) => ({ key })) } })
    }
    if (argv[3] === 'query') {
      const key = argv[argv.indexOf('--issue-id') + 1]
      return ok({ data: rows[key] ?? [] })
    }
    throw new Error(`unexpected argv: ${argv.join(' ')}`)
  }
}

test('sums only my rows across the range', () => {
  const r = monthTotal({
    zone: ZONE, accountId: ME, fromIso: '2026-09-01', toIso: '2026-09-14',
    deps: {
      run: fakeRun({
        issues: ['PROJ-223', 'PROJ-345'],
        rows: {
          'PROJ-223': [wl('1', '2026-09-01', 7.5), wl('2', '2026-09-02', 7.5)],
          // A colleague's 7h on the same issue-day must not be counted: an
          // unfiltered per-issue read measured 36h against a true 15h once.
          'PROJ-345': [wl('3', '2026-09-01', 1), wl('4', '2026-09-01', 7, 'someone-else')],
        },
      }),
    },
  })
  assert.equal(r.status, 'OK')
  assert.equal(r.seconds, 16 * 3600)
  assert.deepEqual(r.countedWorklogIds, ['1', '2', '3'])
})

test('a missing accountId is UNKNOWN, never 0', () => {
  // With accountId undefined the author filter matches nothing and every sum
  // reads 0 -- the exact bug that once nearly authorised a backfill on top of
  // 53h of existing time.
  const r = monthTotal({
    zone: ZONE, accountId: undefined, fromIso: '2026-09-01', toIso: '2026-09-14',
    deps: { run: fakeRun({ issues: ['PROJ-223'], rows: { 'PROJ-223': [wl('1', '2026-09-01', 7.5)] } }) },
  })
  assert.equal(r.status, 'UNKNOWN')
  assert.match(r.reason, /no accountId/)
})

test('POSITIVE CONTROL: JQL found my time but the sum is 0 -> UNKNOWN', () => {
  // Rows exist, none of them mine. Either the read or the identity is wrong;
  // reporting 0 would clear the ceiling.
  const r = monthTotal({
    zone: ZONE, accountId: ME, fromIso: '2026-09-01', toIso: '2026-09-14',
    deps: { run: fakeRun({ issues: ['PROJ-223'], rows: { 'PROJ-223': [wl('1', '2026-09-01', 7.5, 'someone-else')] } }) },
  })
  assert.equal(r.status, 'UNKNOWN')
  assert.equal(r.seconds, 0)
  assert.match(r.reason, /author-filtered sum is 0/)
  assert.match(r.reason, /rows exist, none mine/)
})

test('POSITIVE CONTROL fires when no rows come back at all', () => {
  const r = monthTotal({
    zone: ZONE, accountId: ME, fromIso: '2026-09-01', toIso: '2026-09-14',
    deps: { run: fakeRun({ issues: ['PROJ-223'], rows: { 'PROJ-223': [] } }) },
  })
  assert.equal(r.status, 'UNKNOWN')
  assert.match(r.reason, /no rows returned at all/)
})

test('a genuinely empty range is OK 0, because the same query found nothing', () => {
  // No control can disagree with this one: the query that would have found work
  // is the query that came back empty.
  const r = monthTotal({
    zone: ZONE, accountId: ME, fromIso: '2026-09-01', toIso: '2026-09-14',
    deps: { run: fakeRun({ issues: [] }) },
  })
  assert.equal(r.status, 'OK')
  assert.equal(r.seconds, 0)
})

test('a row whose Jira day falls outside the range is excluded', () => {
  // The lower bound is widened by 1ms because twg's bounds are strictly
  // exclusive, which can admit a worklog started at 23:59:59.999 the day
  // before. The per-row day check is what keeps that out of the total.
  const r = monthTotal({
    zone: ZONE, accountId: ME, fromIso: '2026-09-02', toIso: '2026-09-03',
    deps: {
      run: fakeRun({
        issues: ['PROJ-223'],
        rows: {
          'PROJ-223': [
            wl('early', '2026-09-01', 8, ME, '23:59:59'),
            wl('in', '2026-09-02', 7.5),
            wl('also-in', '2026-09-03', 2),
            wl('late', '2026-09-04', 8, ME, '00:00:00'),
          ],
        },
      }),
    },
  })
  assert.equal(r.status, 'OK')
  assert.equal(r.seconds, 9.5 * 3600)
  assert.deepEqual(r.countedWorklogIds, ['in', 'also-in'])
})

test('the JQL is absolute, half-open, and never uses > or <=', () => {
  const calls = []
  monthTotal({
    zone: ZONE, accountId: ME, fromIso: '2026-09-01', toIso: '2026-09-14',
    deps: { run: fakeRun({ issues: [], calls }) },
  })
  const jql = calls[0][calls[0].indexOf('--jql') + 1]
  assert.match(jql, /worklogAuthor = currentUser\(\)/)
  assert.match(jql, /worklogDate >= "2026-09-01"/)
  assert.match(jql, /worklogDate < "2026-09-15"/, 'half-open: the day AFTER toIso')
  assert.equal(/worklogDate >[^=]/.test(jql), false)
  assert.equal(jql.includes('<='), false)
})

test('a pagination mismatch is UNKNOWN, not a short total', () => {
  const run = (argv) => {
    if (argv[2] === 'query') return ok({ data: { issues: [{ key: 'PROJ-223' }] } })
    // Says 5 rows exist, hands back 1.
    return ok({ data: [wl('1', '2026-09-01', 7.5)], meta: { pagination: { total: 5 } } })
  }
  const r = monthTotal({ zone: ZONE, accountId: ME, fromIso: '2026-09-01', toIso: '2026-09-14', deps: { run } })
  assert.equal(r.status, 'UNKNOWN')
  assert.match(r.reason, /pagination mismatch/)
})

test('a failed discovery is UNKNOWN, not an empty month', () => {
  const run = () => { throw new Error('network is down') }
  const r = monthTotal({ zone: ZONE, accountId: ME, fromIso: '2026-09-01', toIso: '2026-09-14', deps: { run } })
  assert.equal(r.status, 'UNKNOWN')
  assert.match(r.reason, /JQL month discovery failed: network is down/)
})

test('a failed per-issue read is UNKNOWN, not a partial total', () => {
  const run = (argv) => {
    if (argv[2] === 'query') return ok({ data: { issues: [{ key: 'PROJ-223' }] } })
    throw new Error('exit 3 (partial)')
  }
  const r = monthTotal({ zone: ZONE, accountId: ME, fromIso: '2026-09-01', toIso: '2026-09-14', deps: { run } })
  assert.equal(r.status, 'UNKNOWN')
  assert.match(r.reason, /worklog read failed on PROJ-223/)
})

test('extraKeys are read even when JQL does not name them', () => {
  // JQL is index-backed and lags a worklog entered minutes ago; an issue this
  // plan touches must be read regardless.
  const calls = []
  const r = monthTotal({
    zone: ZONE, accountId: ME, fromIso: '2026-09-01', toIso: '2026-09-14',
    extraKeys: ['PROJ-999'],
    deps: { run: fakeRun({ issues: [], rows: { 'PROJ-999': [wl('1', '2026-09-01', 3)] }, calls }) },
  })
  assert.equal(r.status, 'OK')
  assert.equal(r.seconds, 3 * 3600)
  assert.ok(calls.some((c) => c.includes('PROJ-999')))
})
