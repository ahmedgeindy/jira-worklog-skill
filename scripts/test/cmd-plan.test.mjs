// skills/jira-worklog/scripts/test/cmd-plan.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runPlan } from '../cmd/plan.mjs'

const ME = 'me-1'
const IDENT = { accountId: ME, zone: 'Asia/Riyadh', displayName: 'Test' }

function deps({ dayTotalStatus = 'OK', existing = 0 } = {}) {
  return {
    resolveIdentity: () => IDENT,
    dayTotal: () => ({ seconds: existing, status: dayTotalStatus, reason: 'ctl', countedWorklogIds: [], candidates: [] }),
    checkWindow: () => [],
    bundle: () => ({
      perIssue: { 'PROJ-323': [{ source: 'jira-changelog', timestamp: 't', fragment: 'status: In Progress' }] },
      commentSource: 'EVIDENCED', bundleHash: 'bh',
    }),
    resolveIssue: (key) => ({ key, numericId: '999', site: 'example.atlassian.net' }),
    now: () => Date.parse('2026-09-09T10:00:00+03:00'),
    // Ruling 1 (task-11 vs task-12 step 4): plan.mjs calls deps.readEstimate(p.key) and
    // records estimateBefore on every entry from the very first version of this file.
    readEstimate: () => 0,
  }
}

test('a plan freezes numericId, site, started, fingerprint and planHash', () => {
  const p = runPlan({ lines: ['PROJ-323 3h'], isoDate: '2026-09-08', deps: deps() })
  const e = p.days[0].entries[0]
  assert.equal(e.numericId, '999')
  assert.equal(e.site, 'example.atlassian.net')
  assert.equal(e.started, '2026-09-08T09:00:00.000+0300')
  assert.ok(e.fingerprint)
  assert.ok(p.planHash)
})

test('an UNKNOWN day total aborts the plan - never treated as 0h', () => {
  assert.throws(
    () => runPlan({ lines: ['PROJ-323 3h'], isoDate: '2026-09-08', deps: deps({ dayTotalStatus: 'UNKNOWN' }) }),
    /UNKNOWN/,
  )
})

test('a host that does not match the resolved site aborts', () => {
  const d = deps()
  assert.throws(
    () => runPlan({ lines: ['https://someothercorp.atlassian.net/browse/PROJ-323 3h'], isoDate: '2026-09-08', deps: d }),
    /site/i,
  )
})

test('a SHORT day still produces a plan - it is written, then flagged', () => {
  const p = runPlan({ lines: ['PROJ-323 2h'], isoDate: '2026-09-08', deps: deps() })
  assert.equal(p.days[0].status, 'SHORT')
  assert.equal(p.days[0].entries.length, 1)
})

test('existing server time counts toward the floor', () => {
  const p = runPlan({ lines: ['PROJ-323 2h'], isoDate: '2026-09-08', deps: deps({ existing: 5 * 3600 }) })
  assert.equal(p.days[0].status, 'MEETS')
})

test('every entry carries a numeric estimateBefore', () => {
  // The pilot's "--adjust-estimate leave" check compares against this. If it is
  // undefined, checkWrite's `before > 0` is false and the estimate check SILENTLY
  // SKIPS - closing a risk with a check that cannot fire.
  const p = runPlan({ lines: ['PROJ-323 3h'], isoDate: '2026-09-08', deps: deps() })
  assert.equal(typeof p.days[0].entries[0].estimateBefore, 'number')
})

test('more than 5 days in one plan is refused', () => {
  const lines = ['PROJ-323 7h']
  const dates = ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-06', '2026-09-07', '2026-09-08']
  assert.throws(
    () => runPlan({ lines, isoDate: dates, deps: deps() }),
    /max 5 days/i,
  )
})

// Beyond the brief: a real multi-field changelog fragment already contains an
// internal '; ' (lib/evidence.mjs joins a changelog event's items that way).
// Verifies cmd/plan.mjs's buildCommentBody neutralises it before emit ever sees
// it - cmd/emit.mjs's UNSAFE check refuses any comment containing ';'.
test('a comment built from a multi-field evidence fragment carries no semicolon', () => {
  const d = deps()
  d.bundle = () => ({
    perIssue: {
      'PROJ-323': [
        { source: 'jira-changelog', timestamp: 't1', fragment: 'status: In Progress; assignee: Jane Doe' },
        { source: 'jira-changelog', timestamp: 't2', fragment: 'status: Done' },
      ],
    },
    commentSource: 'EVIDENCED', bundleHash: 'bh',
  })
  const p = runPlan({ lines: ['PROJ-323 3h'], isoDate: '2026-09-08', deps: d })
  const comment = p.days[0].entries[0].comment
  assert.equal(comment.includes(';'), false)
  assert.ok(comment.includes('In Progress'))
})
