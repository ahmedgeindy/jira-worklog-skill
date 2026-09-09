// skills/jira-worklog/scripts/test/plan.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sequenceStarts, validateComment, buildAddArgv, hashPlan, sanitizeCommentText } from '../lib/plan.mjs'

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

test('a cumulative plan that would cross midnight is REFUSED, not silently moved to the next day', () => {
  // At >= 15h cumulative the cursor reaches 24:00:00, which formats as
  // '2026-09-08T24:00:00.000+0300' - a string that PARSES as 00:00 on 2026-09-09
  // and still looks like the past to assertNotFuture. The worklog would land on
  // the wrong Jira day with no error anywhere.
  assert.throws(
    () => sequenceStarts('Asia/Riyadh', '2026-09-08', [
      { key: 'A-1', seconds: 28800 }, { key: 'A-2', seconds: 28800 }, { key: 'A-3', seconds: 28800 },
    ]),
    /past midnight/i,
  )
})

test('the last start time that still fits inside the day is allowed', () => {
  const out = sequenceStarts('Asia/Riyadh', '2026-09-08', [
    { key: 'A-1', seconds: 14 * 3600 }, { key: 'A-2', seconds: 1800 },
  ])
  assert.equal(out[1].started, '2026-09-08T23:00:00.000+0300')
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

// --- I5: the grounding check had a real hole. Splitting fragments on /[;:]/ let
// a changelog fragment 'status: In Progress' contribute the bare word 'status',
// so a sentence that merely used that generic field NAME was declared grounded. ---

test('a generic FIELD NAME cannot ground a comment', () => {
  const ev = [{ source: 'jira-changelog', timestamp: 't', fragment: 'status: In Progress' }]
  const r = validateComment('Reviewed status and fixed the auth bug', ev)
  assert.equal(r.ok, false, 'the bare word "status" must not count as evidence')
  assert.match(r.reason, /not grounded/i)
})

test('other bare field names are just as dead', () => {
  const ev = [{ source: 'jira-changelog', timestamp: 't', fragment: 'assignee: Jane Doe; summary: rewrite the parser' }]
  assert.equal(validateComment('updated the assignee and the summary', ev).ok, false)
  assert.equal(validateComment('assignee: Jane Doe', ev).ok, true)
})

test('a short single word from the VALUE side cannot ground a comment either', () => {
  const ev = [{ source: 'jira-changelog', timestamp: 't', fragment: 'status: Done' }]
  assert.equal(validateComment('Done deliberating about the roadmap', ev).ok, false)
})

test('quoting the whole field: value segment DOES ground a comment', () => {
  // This is the ordinary path: cmd/plan.mjs builds the body out of the fragments
  // themselves, and a one-word value like 'Done' must not make that unemittable.
  const ev = [{ source: 'jira-changelog', timestamp: 't', fragment: 'status: Done' }]
  assert.equal(validateComment('status: Done', ev).ok, true)
})

test('a fragment with no field name at all is usable when it is meaningful', () => {
  const ev = [{ source: 'jira-changelog', timestamp: 't', fragment: 'rewrote the pagination loop' }]
  assert.equal(validateComment('rewrote the pagination loop', ev).ok, true)
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

test('the SHORT-day breach note does not break grounding or the token check', () => {
  // Decision D1b appends this to the body, so it must survive validateComment.
  const ev = [{ source: 'jira-changelog', timestamp: 't', fragment: 'status: In Progress' }]
  const r = validateComment('status: In Progress. logged 5.0h, below the 7h policy floor', ev)
  assert.equal(r.ok, true, r.reason)
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

test('hashPlan covers every field the GUARDS trust, not just the ones Jira receives', () => {
  const base = {
    accountId: 'me-1', zone: 'Asia/Riyadh',
    days: [{
      date: '2026-09-08',
      entries: [{ key: 'A-1', seconds: 3600, dedupeState: 'CLEAR', estimateBefore: 230400, existingSecondsOnIssue: 0 }],
    }],
  }
  const h = hashPlan(base)
  const mutate = (fn) => { const c = structuredClone(base); fn(c); return hashPlan(c) }

  assert.notEqual(h, mutate((c) => { c.accountId = 'someone-else' }), 'accountId is the dedup filter')
  assert.notEqual(h, mutate((c) => { c.zone = 'Africa/Cairo' }), 'zone drives every day boundary')
  assert.notEqual(h, mutate((c) => { c.days[0].entries[0].dedupeState = 'EXISTING' }), 'dedupeState is the drift baseline')
  assert.notEqual(h, mutate((c) => { c.days[0].entries[0].estimateBefore = 0 }), 'estimateBefore decides if ESTIMATE_CLOBBERED can fire')
  assert.notEqual(h, mutate((c) => { c.days[0].entries[0].existingSecondsOnIssue = 99 }))
})

// --- task-14 Fix A: a real changelog value must never crash `plan`. ---

test('sanitizeCommentText replaces meaning-preserving characters rather than dropping them', () => {
  assert.equal(sanitizeCommentText('R&D'), 'RandD')
  assert.equal(sanitizeCommentText('Q1 > Q2'), 'Q1 gt Q2')
  assert.equal(sanitizeCommentText('a < b'), 'a lt b')
  assert.equal(sanitizeCommentText('foo | bar'), 'foo / bar')
})

test('sanitizeCommentText removes characters with no safe replacement', () => {
  const s = sanitizeCommentText('cost is $5; say "hi" `now`\r\n')
  assert.equal(/["`$;\r\n]/.test(s), false)
  assert.match(s, /cost is 5/)
})

test('sanitizeCommentText collapses the double spaces a removal can leave behind', () => {
  assert.equal(sanitizeCommentText('a "b" c'), 'a b c')
})

test('sanitizeCommentText output is always safe for lib/psline.mjs to render', () => {
  const inputs = ['R&D', 'Q1 > Q2 < Q3', 'a $summary with `backticks`', 'semi;colon"quote', 'crlf\r\nhere']
  for (const i of inputs) {
    assert.equal(/["`$;&|<>\r\n\u0000]/.test(sanitizeCommentText(i)), false, `unsafe survivor from ${JSON.stringify(i)}`)
  }
})

// --- Fix A #2: sanitizing the comment must not silently break grounding. ---

test('an evidence fragment with an ampersand still grounds the (necessarily rewritten) comment', () => {
  const ev = [{ source: 'jira-changelog', timestamp: 't', fragment: 'team: R&D' }]
  const comment = sanitizeCommentText('team: R&D') // what cmd/plan.mjs actually builds and sanitizes
  const r = validateComment(comment, ev)
  assert.equal(r.ok, true, r.reason)
})

test('a claimed filename that only exists post-sanitization is still supported, not falsely flagged', () => {
  // Concrete hole: fragment 'summary: rework R&D.md' sanitizes to '...RandD.md'.
  // TOKEN_RE's filename alternative matches 'RandD.md' in the (sanitized)
  // comment. If the unsupported-token haystack were built from the RAW
  // fragment ('R&D.md'), this would be falsely rejected as fabricated.
  const ev = [{ source: 'jira-changelog', timestamp: 't', fragment: 'summary: rework R&D.md' }]
  const comment = sanitizeCommentText('summary: rework R&D.md')
  const r = validateComment(comment, ev)
  assert.equal(r.ok, true, r.reason)
})

test('sanitization does not weaken the fabrication guard - the existing rejection still holds', () => {
  // Regression control for the change above: a comment inventing a claim must
  // still be rejected even though the grounding comparison now sanitizes both
  // sides. No ampersand or other special character is involved here at all.
  const ev = [{ source: 'jira-changelog', timestamp: 't', fragment: 'status: In Progress' }]
  const r = validateComment('Reviewed status and fixed the auth bug', ev)
  assert.equal(r.ok, false)
  assert.match(r.reason, /not grounded/i)
})

// --- task-14 Fix B: commentSource must be part of the approved hash. ---

test('hashPlan changes when only commentSource changes - approval binds to who wrote the text', () => {
  const a = { days: [{ date: '2026-09-08', entries: [{ key: 'A-1', seconds: 3600, comment: 'x', commentSource: 'EVIDENCED' }] }] }
  const b = { days: [{ date: '2026-09-08', entries: [{ key: 'A-1', seconds: 3600, comment: 'x', commentSource: 'USER_SUPPLIED' }] }] }
  assert.notEqual(hashPlan(a), hashPlan(b))
})
