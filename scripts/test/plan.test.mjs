// skills/jira-worklog/scripts/test/plan.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sequenceStarts, validateComment, buildAddArgv, hashPlan } from '../lib/plan.mjs'

test('start times sequence by cumulative duration, not stacked at 09:00', () => {
  const out = sequenceStarts('Asia/Riyadh', '2026-09-08', [
    { key: 'A-1', seconds: 10800 }, // 3h
    { key: 'A-2', seconds: 7200 },  // 2h
    { key: 'A-3', seconds: 7200 },  // 2h
  ])
  assert.equal(out[0].started, '2026-09-08T09:00:00.000+0300')
  assert.equal(out[1].started, '2026-09-08T12:00:00.000+0300')
  assert.equal(out[2].started, '2026-09-08T14:00:00.000+0300')
})

test('buildAddArgv carries all five mandatory flags', () => {
  const argv = buildAddArgv({
    key: 'PROJ-323', seconds: 10800,
    started: '2026-09-08T09:00:00.000+0300', comment: 'did the thing',
  })
  for (const f of ['--time-spent-seconds', '--started', '--adjust-estimate', '--notify-users', '--comment-format']) {
    assert.ok(argv.includes(f), `missing ${f}`)
  }
  assert.equal(argv[argv.indexOf('--adjust-estimate') + 1], 'leave')
  assert.equal(argv[argv.indexOf('--notify-users') + 1], 'false')
  assert.equal(argv[argv.indexOf('--comment-format') + 1], 'plain')
  assert.equal(argv[argv.indexOf('--time-spent-seconds') + 1], '10800')
})

test('buildAddArgv never emits --time-spent or a d/w unit', () => {
  const argv = buildAddArgv({ key: 'A-1', seconds: 28800, started: '2026-09-08T09:00:00.000+0300', comment: 'x' })
  assert.equal(argv.includes('--time-spent'), false)
  assert.equal(argv.some((t) => /^\d+[dw]$/.test(t)), false)
})

test('buildAddArgv refuses to build without a started value', () => {
  assert.throws(() => buildAddArgv({ key: 'A-1', seconds: 3600, comment: 'x' }), /started/i)
})

test('validateComment rejects a fact absent from the evidence bundle', () => {
  const ev = [{ source: 'jira-changelog', timestamp: 't', fragment: 'status: In Progress' }]
  assert.equal(validateComment('moved to In Progress', ev).ok, true)
  assert.equal(validateComment('fixed PROJ-999 and merged abc1234', ev).ok, false)
})

test('a comment grounded in NOTHING is rejected, not silently allowed', () => {
  // Token-absence must not be a pass. 'fixed the auth bug' names no filename, SHA or
  // key, so a pure token check would return ok - the exact fabrication the guard exists
  // to stop. When evidence exists, the comment must quote some of it.
  const ev = [{ source: 'jira-changelog', timestamp: 't', fragment: 'status: In Progress' }]
  const r = validateComment('fixed the auth bug', ev)
  assert.equal(r.ok, false)
  assert.match(r.reason, /not grounded/i)
})

test('with NO evidence at all, any comment is refused - the caller must ask the user', () => {
  assert.equal(validateComment('anything', []).ok, false)
})

test('validateComment rejects a comment that is secretly ADF', () => {
  const ev = [{ source: 's', timestamp: 't', fragment: 'anything' }]
  const r = validateComment('{"type":"doc","version":1,"content":[]}', ev)
  assert.equal(r.ok, false)
  assert.match(r.reason, /adf/i)
})

test('hashPlan is stable across runs and ignores volatile fields', () => {
  const a = { runId: 'r1', generatedAt: 1, days: [{ date: '2026-09-08', entries: [{ key: 'A-1', seconds: 3600 }] }] }
  const b = { runId: 'r2', generatedAt: 2, days: [{ date: '2026-09-08', entries: [{ key: 'A-1', seconds: 3600 }] }] }
  assert.equal(hashPlan(a), hashPlan(b))
})

test('hashPlan changes when an entry changes', () => {
  const a = { days: [{ date: '2026-09-08', entries: [{ key: 'A-1', seconds: 3600 }] }] }
  const b = { days: [{ date: '2026-09-08', entries: [{ key: 'A-1', seconds: 7200 }] }] }
  assert.notEqual(hashPlan(a), hashPlan(b))
})
