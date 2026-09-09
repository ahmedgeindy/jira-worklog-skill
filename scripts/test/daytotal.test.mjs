// skills/jira-worklog/scripts/test/daytotal.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildDayJql, sumAuthorSeconds, dayTotal } from '../lib/daytotal.mjs'

const ME = '712020:00000000-1111-2222-3333-444444444444'

test('JQL uses absolute dates and only >= and <', () => {
  const jql = buildDayJql('2026-09-08')
  assert.match(jql, /worklogAuthor = currentUser\(\)/)
  assert.match(jql, /worklogDate >= "2026-09-07"/)
  assert.match(jql, /worklogDate < "2026-09-10"/)
  // > and <= silently round the bound to end-of-day
  assert.equal(/worklogDate >[^=]/.test(jql), false)
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
        return { exit: 0, data: { issues: [{ key: 'PROJ-1' }] }, failures: [], meta: null }
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
      if (argv.includes('--jql')) return { exit: 0, data: { issues: [{ key: 'PROJ-1' }] }, failures: [], meta: null }
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
  dayTotal({ zone: 'Asia/Riyadh', accountId: ME, isoDate: '2026-09-08', extraKeys: ['PROJ-345'], deps })
  assert.deepEqual(seen, ['PROJ-345'])
})
