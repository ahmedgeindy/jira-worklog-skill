// skills/jira-worklog/scripts/test/dedup.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fingerprint, markerFor, flattenAdf, classify } from '../lib/dedup.mjs'

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
