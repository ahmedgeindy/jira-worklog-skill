// skills/jira-worklog/scripts/test/daytotal.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildDayJql, buildNarrowDayJql, sumAuthorSeconds, dayTotal } from '../lib/daytotal.mjs'
import { toEnvelope } from '../lib/twg.mjs'

const ME = '712020:862ee292-a94d-488e-9f54-f5cb50dfd07b'

test('JQL uses absolute dates and only >= and <', () => {
  const jql = buildDayJql('2026-09-08')
  assert.match(jql, /worklogAuthor = currentUser\(\)/)
  assert.match(jql, /worklogDate >= "2026-09-07"/)
  assert.match(jql, /worklogDate < "2026-09-10"/)
  // > and <= silently round the bound to end-of-day
  assert.equal(/worklogDate >[^=]/.test(jql), false)
  assert.equal(jql.includes('<='), false)
})

test('the CONTROL JQL is exactly one day wide', () => {
  const jql = buildNarrowDayJql('2026-09-08')
  assert.match(jql, /worklogDate >= "2026-09-08"/)
  assert.match(jql, /worklogDate < "2026-09-09"/)
  assert.equal(jql.includes('<='), false)
})

test('sumAuthorSeconds counts only my rows, from timeSpentSeconds', () => {
  const rows = [
    { id: '1', author: { accountId: ME }, timeSpentSeconds: 10800, timeSpent: '3h' },
    { id: '2', author: { accountId: 'someone-else' }, timeSpentSeconds: 25200, timeSpent: '7h' },
    { id: '3', author: { accountId: ME }, timeSpentSeconds: 7200, timeSpent: '2h' },
  ]
  assert.equal(sumAuthorSeconds(rows, ME), 18000)
})

test('a real multi-author fixture contributes ZERO to my total', () => {
  const fx = JSON.parse(readFileSync(new URL('./fixtures/worklog-query-multiauthor.json', import.meta.url)))
  const rows = fx.data ?? fx
  assert.ok(rows.length > 0, 'fixture must not be empty')
  assert.equal(sumAuthorSeconds(rows, ME), 0)
})

test('the display string is never parsed - 1d is 8h here, not 24h', () => {
  const rows = [{ id: '1', author: { accountId: ME }, timeSpentSeconds: 29400, timeSpent: '1d 10m' }]
  assert.equal(sumAuthorSeconds(rows, ME), 29400)
})

test('a truncated page aborts as UNKNOWN instead of undercounting', () => {
  const deps = {
    run: (argv) => {
      if (argv.includes('query') && argv.includes('--jql')) {
        return { exit: 0, data: { issues: [{ key: 'HCFM-1' }] }, failures: [], meta: null }
      }
      return {
        exit: 0, failures: [], request: null,
        data: [{ id: '1', author: { accountId: ME }, timeSpentSeconds: 3600 }],
        meta: { pagination: { total: 9 } }, // says 9, gave 1
      }
    },
  }
  const r = dayTotal({ zone: 'Asia/Riyadh', accountId: ME, isoDate: '2026-09-08', deps })
  assert.equal(r.status, 'UNKNOWN')
  assert.match(r.reason, /pagination/i)
})

test('JQL finding issues while the filtered sum is 0 is UNKNOWN, not 0h', () => {
  const deps = {
    run: (argv) => {
      if (argv.includes('--jql')) return { exit: 0, data: { issues: [{ key: 'HCFM-1' }] }, failures: [], meta: null }
      return {
        exit: 0, failures: [], request: null,
        data: [{ id: '1', author: { accountId: 'not-me' }, timeSpentSeconds: 3600 }],
        meta: { pagination: { total: 1 } },
      }
    },
  }
  const r = dayTotal({ zone: 'Asia/Riyadh', accountId: ME, isoDate: '2026-09-08', deps })
  assert.equal(r.status, 'UNKNOWN')
})

test('no candidate issues at all is a legitimate 0h', () => {
  const deps = { run: () => ({ exit: 0, data: { issues: [] }, failures: [], meta: null }) }
  const r = dayTotal({ zone: 'Asia/Riyadh', accountId: ME, isoDate: '2026-09-08', deps })
  assert.equal(r.status, 'OK')
  assert.equal(r.seconds, 0)
})

test('extraKeys are unioned into the candidate set to blunt JQL index lag', () => {
  const seen = []
  const deps = {
    run: (argv) => {
      if (argv.includes('--jql')) return { exit: 0, data: { issues: [] }, failures: [], meta: null }
      seen.push(argv[argv.indexOf('--issue-id') + 1])
      return { exit: 0, data: [], failures: [], meta: { pagination: { total: 0 } }, request: null }
    },
  }
  dayTotal({ zone: 'Asia/Riyadh', accountId: ME, isoDate: '2026-09-08', extraKeys: ['HCFM-345'], deps })
  assert.deepEqual(seen, ['HCFM-345'])
})

// --- I3: consecutive backfill. The wide discovery window [D-1, D+2) is right
// for finding candidates and WRONG as a control. Driving the second control off
// it meant: log 7h on Aug 2, then plan Aug 3 -> the wide query finds that issue
// (because of Aug 2), the Aug-3-windowed read finds none of mine, UNKNOWN, plan
// aborts. Day 1 of a backfill worked; day 2 onward never did. ---

test('the day AFTER a logged day reads as a clean 0h, not a false UNKNOWN', () => {
  const jqls = []
  const deps = {
    run: (argv) => {
      const i = argv.indexOf('--jql')
      if (i !== -1) {
        const jql = argv[i + 1]
        jqls.push(jql)
        // Wide discovery reaches back to 2026-09-07 and finds yesterday's issue.
        // The narrow control, exactly [2026-09-08, 2026-09-09), finds nothing.
        const isWide = jql.includes('>= "2026-09-07"')
        return { exit: 0, data: { issues: isWide ? [{ key: 'HCFM-1' }] : [] }, failures: [], meta: null }
      }
      // The day-windowed per-issue read correctly returns nothing for today.
      return { exit: 0, data: [], failures: [], request: null, meta: { pagination: { total: 0 } } }
    },
  }
  const r = dayTotal({ zone: 'Asia/Riyadh', accountId: ME, isoDate: '2026-09-08', deps })
  assert.equal(r.status, 'OK')
  assert.equal(r.seconds, 0)
  assert.equal(jqls.length, 2, 'discovery and control are two distinct queries')
  assert.equal(jqls.some((q) => q.includes('>= "2026-09-08"') && q.includes('< "2026-09-09"')), true)
  // The wide query still drives candidate discovery, so yesterday's issue is read.
  assert.deepEqual(r.candidates, ['HCFM-1'])
})

test('the control still fires when MY OWN day really cannot be read', () => {
  // Same shape as above, but the narrow control DOES name an issue for this day
  // and the author-filtered sum is still 0. That is a broken read, not a clean day.
  const deps = {
    run: (argv) => {
      if (argv.includes('--jql')) return { exit: 0, data: { issues: [{ key: 'HCFM-1' }] }, failures: [], meta: null }
      return {
        exit: 0, failures: [], request: null,
        data: [{ id: '1', author: { accountId: 'not-me' }, timeSpentSeconds: 3600 }],
        meta: { pagination: { total: 1 } },
      }
    },
  }
  const r = dayTotal({ zone: 'Asia/Riyadh', accountId: ME, isoDate: '2026-09-08', deps })
  assert.equal(r.status, 'UNKNOWN')
  assert.match(r.reason, /2026-09-08/)
})

// --- I2: the pagination loop. pageInfo is TOP-LEVEL in the envelope, so reading
// only meta.pageInfo made the cursor permanently null and page 2 unreachable. ---

test('a top-level pageInfo.nextCursor is followed, and page 2 is counted', () => {
  const page1 = JSON.parse(readFileSync(new URL('./fixtures/worklog-query-page1.json', import.meta.url)))
  const page2 = {
    data: [{ id: '188208', author: { accountId: ME }, timeSpentSeconds: 7200, timeSpent: '2h' }],
    request: page1.request,
    meta: page1.meta,
    pageInfo: { hasNextPage: false, nextCursor: null },
  }
  const afters = []
  const deps = {
    run: (argv) => {
      if (argv.includes('--jql')) return { exit: 0, data: { issues: [{ key: 'HCFM-1' }] }, failures: [], meta: null }
      const i = argv.indexOf('--after')
      afters.push(i === -1 ? null : argv[i + 1])
      // Shaped by the SAME envelope function run() uses, so this exercises the
      // real surfacing path rather than a hand-built object.
      return { ...toEnvelope(i === -1 ? page1 : page2), exit: 0 }
    },
  }
  const r = dayTotal({ zone: 'Asia/Riyadh', accountId: ME, isoDate: '2026-09-08', deps })
  assert.deepEqual(afters, [null, 'cursor-page-2'], 'page 2 must actually be requested')
  assert.equal(r.status, 'OK')
  assert.equal(r.seconds, 10800 + 7200) // both pages, mine only
  assert.deepEqual(r.countedWorklogIds, ['188207', '188208'])
})

test('a cursor that never advances aborts instead of re-reading page 1 forever', () => {
  const page1 = JSON.parse(readFileSync(new URL('./fixtures/worklog-query-page1.json', import.meta.url)))
  let calls = 0
  const deps = {
    run: (argv) => {
      if (argv.includes('--jql')) return { exit: 0, data: { issues: [{ key: 'HCFM-1' }] }, failures: [], meta: null }
      calls += 1
      return { ...toEnvelope(page1), exit: 0 } // always the same cursor
    },
  }
  const r = dayTotal({ zone: 'Asia/Riyadh', accountId: ME, isoDate: '2026-09-08', deps })
  assert.equal(r.status, 'UNKNOWN')
  assert.match(r.reason, /cursor did not advance/i)
  assert.equal(calls, 2)
})
