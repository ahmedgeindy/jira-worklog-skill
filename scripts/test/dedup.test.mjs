// skills/jira-worklog/scripts/test/dedup.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fingerprint, markerFor, flattenAdf, classify, checkWindow } from '../lib/dedup.mjs'

const ME = '712020:862ee292-a94d-488e-9f54-f5cb50dfd07b'
const FP = fingerprint({ accountId: ME, key: 'HCFM-323', isoDate: '2026-09-08', seconds: 10800 })

test('fingerprint is stable and excludes comment text', () => {
  const a = fingerprint({ accountId: ME, key: 'HCFM-323', isoDate: '2026-09-08', seconds: 10800 })
  const b = fingerprint({ accountId: ME, key: 'HCFM-323', isoDate: '2026-09-08', seconds: 10800 })
  assert.equal(a, b)
  assert.notEqual(a, fingerprint({ accountId: ME, key: 'HCFM-323', isoDate: '2026-09-08', seconds: 7200 }))
})

test('flattenAdf tree-walks for text nodes - a substring test on the object would fail', () => {
  const adf = {
    type: 'doc', version: 1,
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'fix the ivr with bulk' }] }],
  }
  assert.equal(flattenAdf(adf), 'fix the ivr with bulk')
})

test('an ABSENT comment key does not throw and yields empty text', () => {
  assert.equal(flattenAdf(undefined), '')
  assert.equal(flattenAdf(null), '')
})

test('flattenAdf tolerates a plain string comment', () => {
  assert.equal(flattenAdf('already plain'), 'already plain')
})

test('tier 1: my marker present means DUPLICATE', () => {
  const rows = [{ author: { accountId: ME }, timeSpentSeconds: 999, comment: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: `work ${markerFor(FP)}` }] }] } }]
  assert.equal(classify(rows, { accountId: ME, seconds: 10800, fp: FP }), 'DUPLICATE')
})

test('tier 2: same author, same day, same issue, same seconds means DUPLICATE', () => {
  const rows = [{ author: { accountId: ME }, timeSpentSeconds: 10800 }]
  assert.equal(classify(rows, { accountId: ME, seconds: 10800, fp: FP }), 'DUPLICATE')
})

test('tier 3: same author/day/issue with DIFFERENT seconds is EXISTING, never CLEAR', () => {
  const rows = [{ author: { accountId: ME }, timeSpentSeconds: 7200 }]
  assert.equal(classify(rows, { accountId: ME, seconds: 10800, fp: FP }), 'EXISTING')
})

test('only other authors present means CLEAR for me', () => {
  const rows = [{ author: { accountId: 'someone-else' }, timeSpentSeconds: 25200 }]
  assert.equal(classify(rows, { accountId: ME, seconds: 10800, fp: FP }), 'CLEAR')
})

test('no rows at all means CLEAR', () => {
  assert.equal(classify([], { accountId: ME, seconds: 10800, fp: FP }), 'CLEAR')
})

test('a row with no author accountId is AMBIGUOUS, not CLEAR', () => {
  const rows = [{ timeSpentSeconds: 3600 }]
  assert.equal(classify(rows, { accountId: ME, seconds: 10800, fp: FP }), 'AMBIGUOUS')
})

// --- I1: checkWindow is the ONLY live read standing between a re-run and a
// double-log, and classify([]) is CLEAR, which authorises the write. So its zero
// must be positively controlled (spec 3.3) exactly as daytotal's pageWorklogs
// is. meta.pagination.total is the FILTERED count (probed live: an issue with 12
// lifetime worklogs returned total 1 for a one-day window), so the comparison is
// sound and cannot misfire. ---

const WINDOW_ARGS = { key: 'HCFM-323', accountId: ME, zone: 'Asia/Riyadh', isoDate: '2026-09-08' }

function fakeRun(res) {
  return (argv) => {
    assert.ok(argv.includes('--started-after') && argv.includes('--started-before'))
    return { exit: 0, failures: [], request: null, ...res }
  }
}

test('checkWindow returns the rows when the count matches the declared total', () => {
  const rows = [{ id: '1', author: { accountId: ME }, timeSpentSeconds: 3600 }]
  const out = checkWindow({ ...WINDOW_ARGS, deps: { run: fakeRun({ data: rows, meta: { pagination: { total: 1 } } }) } })
  assert.deepEqual(out, rows)
})

test('checkWindow accepts a proven ZERO, so a genuinely clean day still passes', () => {
  const out = checkWindow({ ...WINDOW_ARGS, deps: { run: fakeRun({ data: [], meta: { pagination: { total: 0 } } }) } })
  assert.deepEqual(out, [])
  assert.equal(classify(out, { accountId: ME, seconds: 10800, fp: FP }), 'CLEAR')
})

test('checkWindow reads the {worklogs: []} shape as well as a bare array', () => {
  const rows = [{ id: '1', author: { accountId: ME }, timeSpentSeconds: 3600 }]
  const out = checkWindow({ ...WINDOW_ARGS, deps: { run: fakeRun({ data: { worklogs: rows }, meta: { pagination: { total: 1 } } }) } })
  assert.deepEqual(out, rows)
})

test('checkWindow THROWS when the rows returned disagree with meta.pagination.total', () => {
  // Truncated window: 1 row of a declared 4. Without this the dedup read reports
  // "only this one row" and a second worklog gets written over the top.
  const deps = { run: fakeRun({ data: [{ id: '1', author: { accountId: ME } }], meta: { pagination: { total: 4 } } }) }
  assert.throws(() => checkWindow({ ...WINDOW_ARGS, deps }), /1 row\(s\) but meta\.pagination\.total is 4/)
})

test('checkWindow THROWS when there is no positive control at all', () => {
  const deps = { run: fakeRun({ data: [], meta: null }) }
  assert.throws(() => checkWindow({ ...WINDOW_ARGS, deps }), /no meta\.pagination\.total/i)
})

test('checkWindow THROWS on an unrecognised shape instead of returning an empty list', () => {
  // Previously this returned [], classify([]) said CLEAR, and an unreadable
  // response authorised the write.
  const deps = { run: fakeRun({ data: { unexpected: true }, meta: { pagination: { total: 0 } } }) }
  assert.throws(() => checkWindow({ ...WINDOW_ARGS, deps }), /unrecognised worklog query shape/i)
})

test('checkWindow still refuses an untrustworthy read (exit 3, failures, exact:false)', () => {
  const partial = { run: () => ({ exit: 3, data: [], failures: [], meta: { pagination: { total: 0 } } }) }
  assert.throws(() => checkWindow({ ...WINDOW_ARGS, deps: partial }), /exit 3/)

  const failed = { run: () => ({ exit: 0, data: [], failures: ['boom'], meta: { pagination: { total: 0 } } }) }
  assert.throws(() => checkWindow({ ...WINDOW_ARGS, deps: failed }), /failures/)
})

test('checkWindow still guards the parseInt echo trap', () => {
  const deps = {
    run: () => ({
      exit: 0, data: [], failures: [],
      meta: { pagination: { total: 0 } },
      request: { startedAfter: 2026, startedBefore: 2026 },
    }),
  }
  assert.throws(() => checkWindow({ ...WINDOW_ARGS, deps }), /echo mismatch/i)
})
