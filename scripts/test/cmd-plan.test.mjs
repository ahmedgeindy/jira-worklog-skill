// skills/jira-worklog/scripts/test/cmd-plan.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runPlan } from '../cmd/plan.mjs'
import { buildAddArgv } from '../lib/plan.mjs'
import { renderPsCommand } from '../lib/psline.mjs'

const BIN = 'C:/twg/twg.exe'

const ME = 'me-1'
const IDENT = { accountId: ME, zone: 'Asia/Riyadh', displayName: 'Test' }

function deps({ dayTotalStatus = 'OK', existing = 0 } = {}) {
  return {
    resolveIdentity: () => IDENT,
    dayTotal: () => ({ seconds: existing, status: dayTotalStatus, reason: 'ctl', countedWorklogIds: [], candidates: [] }),
    checkWindow: () => [],
    bundle: () => ({
      perIssue: {
        'HCFM-323': [{ source: 'jira-changelog', timestamp: 't', fragment: 'status: In Progress' }],
        'HCFM-324': [{ source: 'jira-changelog', timestamp: 't', fragment: 'status: In Review' }],
      },
      commentSource: 'EVIDENCED', bundleHash: 'bh',
    }),
    resolveIssue: (key) => ({ key, numericId: '999', site: 'istnetworks-dev.atlassian.net' }),
    now: () => Date.parse('2026-09-09T10:00:00+03:00'),
    // Ruling 1 (task-11 vs task-12 step 4): plan.mjs calls deps.readEstimate(p.key) and
    // records estimateBefore on every entry from the very first version of this file.
    readEstimate: () => 0,
  }
}

test('a plan freezes numericId, site, started, fingerprint and planHash', () => {
  const p = runPlan({ lines: ['HCFM-323 3h'], isoDate: '2026-09-08', deps: deps() })
  const e = p.days[0].entries[0]
  assert.equal(e.numericId, '999')
  assert.equal(e.site, 'istnetworks-dev.atlassian.net')
  assert.equal(e.started, '2026-09-08T09:00:00.000+0300')
  assert.ok(e.fingerprint)
  assert.ok(p.planHash)
})

test('an UNKNOWN day total aborts the plan - never treated as 0h', () => {
  assert.throws(
    () => runPlan({ lines: ['HCFM-323 3h'], isoDate: '2026-09-08', deps: deps({ dayTotalStatus: 'UNKNOWN' }) }),
    /UNKNOWN/,
  )
})

test('a host that does not match the resolved site aborts', () => {
  const d = deps()
  assert.throws(
    () => runPlan({ lines: ['https://someothercorp.atlassian.net/browse/HCFM-323 3h'], isoDate: '2026-09-08', deps: d }),
    /site/i,
  )
})

test('a SHORT day still produces a plan - it is written, then flagged', () => {
  const p = runPlan({ lines: ['HCFM-323 2h'], isoDate: '2026-09-08', deps: deps() })
  assert.equal(p.days[0].status, 'SHORT')
  assert.equal(p.days[0].entries.length, 1)
})

test('existing server time counts toward the floor', () => {
  const p = runPlan({ lines: ['HCFM-323 2h'], isoDate: '2026-09-08', deps: deps({ existing: 5 * 3600 }) })
  assert.equal(p.days[0].status, 'MEETS')
})

test('every entry carries a numeric estimateBefore', () => {
  // The pilot's "--adjust-estimate leave" check compares against this. If it is
  // undefined, checkWrite's `before > 0` is false and the estimate check SILENTLY
  // SKIPS - closing a risk with a check that cannot fire.
  const p = runPlan({ lines: ['HCFM-323 3h'], isoDate: '2026-09-08', deps: deps() })
  assert.equal(typeof p.days[0].entries[0].estimateBefore, 'number')
})

test('more than 5 days in one plan is refused', () => {
  const lines = ['HCFM-323 7h']
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
      'HCFM-323': [
        { source: 'jira-changelog', timestamp: 't1', fragment: 'status: In Progress; assignee: Jane Doe' },
        { source: 'jira-changelog', timestamp: 't2', fragment: 'status: Done' },
      ],
    },
    commentSource: 'EVIDENCED', bundleHash: 'bh',
  })
  const p = runPlan({ lines: ['HCFM-323 3h'], isoDate: '2026-09-08', deps: d })
  const comment = p.days[0].entries[0].comment
  assert.equal(comment.includes(';'), false)
  assert.ok(comment.includes('In Progress'))
})

// --- I6 / decision D1b: a SHORT day must carry its breach into that day's
// worklog comment. A gitignored local ledger is never read by a manager. ---

test('a SHORT day writes the breach into every one of that day\'s comments', () => {
  const p = runPlan({ lines: ['HCFM-323 2h', 'HCFM-324 3h'], isoDate: '2026-09-08', deps: deps() })
  assert.equal(p.days[0].status, 'SHORT')
  for (const e of p.days[0].entries) {
    assert.match(e.comment, /logged 5\.0h, below the 7h policy floor/)
  }
})

test('the breach states the WHOLE day, server time included, not just what is being written', () => {
  const p = runPlan({ lines: ['HCFM-323 2h'], isoDate: '2026-09-08', deps: deps({ existing: 3 * 3600 }) })
  assert.equal(p.days[0].status, 'SHORT')
  assert.match(p.days[0].entries[0].comment, /logged 5\.0h/)
})

test('the breach note never computes the gap or names an issue to fill it (D1a)', () => {
  const p = runPlan({ lines: ['HCFM-323 2h'], isoDate: '2026-09-08', deps: deps() })
  const c = p.days[0].entries[0].comment
  assert.match(c, /logged 2\.0h, below the 7h policy floor/)
  // The ONLY hour figures in the comment are the day total and the floor. The
  // difference between them - the fillable gap - is never computed anywhere.
  assert.deepEqual([...c.matchAll(/\d+(?:\.\d+)?h\b/g)].map((m) => m[0]), ['2.0h', '7h'])
  assert.equal(/short by|remaining|to add|gap/i.test(c), false)
  assert.equal(c.includes('HCFM-345'), false)
})

test('a day that MEETS the floor carries no breach text', () => {
  const p = runPlan({ lines: ['HCFM-323 7h'], isoDate: '2026-09-08', deps: deps() })
  assert.equal(p.days[0].status, 'MEETS')
  assert.equal(/policy floor/i.test(p.days[0].entries[0].comment), false)
})

test('the breach text is emittable: no semicolon or other refused character', () => {
  const p = runPlan({ lines: ['HCFM-323 2h'], isoDate: '2026-09-08', deps: deps() })
  assert.equal(/["`$;&|<>\r\n]/.test(p.days[0].entries[0].comment), false)
})

// --- Duplicate input lines. Two entries for one issue on one day derive the
// same fingerprint when the hours match, so emit prints the write twice. ---

test('two identical input lines are refused at PLAN time', () => {
  assert.throws(
    () => runPlan({ lines: ['HCFM-323 3h', 'HCFM-323 3h'], isoDate: '2026-09-08', deps: deps() }),
    /twice on 2026-09-08/i,
  )
})

test('the same issue twice with DIFFERENT hours is refused too', () => {
  // Not a fingerprint collision, but the first write flips the second entry's
  // live dedupe state, so check-cmd would abort the day half-committed.
  assert.throws(
    () => runPlan({ lines: ['HCFM-323 3h', 'HCFM-323 2h'], isoDate: '2026-09-08', deps: deps() }),
    /at most once per day/i,
  )
})

test('two DIFFERENT issues on one day are still fine', () => {
  const p = runPlan({ lines: ['HCFM-323 3h', 'HCFM-324 4h'], isoDate: '2026-09-08', deps: deps() })
  assert.equal(p.days[0].entries.length, 2)
  assert.equal(p.days[0].entries[0].fingerprint === p.days[0].entries[1].fingerprint, false)
})

// --- task-14 Fix A: real changelog values (&, >, $, ...) must not crash plan. ---

test('a changelog fragment containing an ordinary ampersand produces a valid, renderable comment', () => {
  const d = deps()
  d.bundle = () => ({
    perIssue: { 'HCFM-323': [{ source: 'jira-changelog', timestamp: 't', fragment: 'team: R&D' }] },
    commentSource: 'EVIDENCED', bundleHash: 'bh',
  })
  const p = runPlan({ lines: ['HCFM-323 3h'], isoDate: '2026-09-08', deps: d })
  const e = p.days[0].entries[0]
  assert.equal(/["`$;&|<>\r\n]/.test(e.comment), false)
  assert.match(e.comment, /RandD/)
  // Must actually render through the SAME renderer emit uses, without throwing.
  assert.doesNotThrow(() => renderPsCommand(buildAddArgv(e), BIN))
})

test('changelog fragments with >, $ and | do not crash plan either', () => {
  const d = deps()
  d.bundle = () => ({
    perIssue: { 'HCFM-323': [{ source: 'jira-changelog', timestamp: 't', fragment: 'summary: Q1 > Q2, budget $500, a|b' }] },
    commentSource: 'EVIDENCED', bundleHash: 'bh',
  })
  const p = runPlan({ lines: ['HCFM-323 3h'], isoDate: '2026-09-08', deps: d })
  const e = p.days[0].entries[0]
  assert.equal(/["`$;&|<>\r\n]/.test(e.comment), false)
  assert.doesNotThrow(() => renderPsCommand(buildAddArgv(e), BIN))
})

// --- task-14 Fix B: thin evidence (a cleared field) is currently unloggable
// via the EVIDENCED path, and must remain refused there - but become loggable
// via a user-supplied `::` comment. ---

test('thin evidence (a cleared field) is still REJECTED on the EVIDENCED path - grounding is not weakened', () => {
  const d = deps()
  d.bundle = () => ({
    perIssue: { 'HCFM-323': [{ source: 'jira-changelog', timestamp: 't', fragment: 'status:' }] },
    commentSource: 'EVIDENCED', bundleHash: 'bh',
  })
  assert.throws(
    () => runPlan({ lines: ['HCFM-323 3h'], isoDate: '2026-09-08', deps: d }),
    /comment rejected|not grounded/i,
  )
})

test('the SAME thin-evidence issue is loggable via a user-supplied :: comment, and grounding is skipped', () => {
  const d = deps()
  d.bundle = () => ({
    perIssue: { 'HCFM-323': [{ source: 'jira-changelog', timestamp: 't', fragment: 'status:' }] },
    commentSource: 'EVIDENCED', bundleHash: 'bh',
  })
  const p = runPlan({
    lines: ['HCFM-323 3h :: reviewed the migrator PR and fixed the parity check'],
    isoDate: '2026-09-08', deps: d,
  })
  const e = p.days[0].entries[0]
  assert.equal(e.commentSource, 'USER_SUPPLIED')
  assert.match(e.comment, /reviewed the migrator PR and fixed the parity check/)
})

test('an evidence-derived comment (no ::) is still labelled EVIDENCED', () => {
  const p = runPlan({ lines: ['HCFM-323 3h'], isoDate: '2026-09-08', deps: deps() })
  assert.equal(p.days[0].entries[0].commentSource, 'EVIDENCED')
})

test('a user comment that quotes nothing from the evidence is ACCEPTED - a human wrote it', () => {
  const p = runPlan({
    lines: ['HCFM-323 3h :: paired with Sam on an unrelated hotfix'],
    isoDate: '2026-09-08', deps: deps(),
  })
  const e = p.days[0].entries[0]
  assert.equal(e.commentSource, 'USER_SUPPLIED')
  assert.match(e.comment, /paired with Sam on an unrelated hotfix/)
})

test('the raw userComment field never survives into the persisted entry (it is not hashed)', () => {
  const p = runPlan({
    lines: ['HCFM-323 3h :: reviewed the migrator PR and fixed the parity check'],
    isoDate: '2026-09-08', deps: deps(),
  })
  assert.equal('userComment' in p.days[0].entries[0], false)
})

// --- D1b regression (task-14 Fix B bypassed buildCommentBody entirely for
// USER_SUPPLIED comments, so a SHORT day logged with the user's own comment
// silently lost the policy breach record). ---

test('REGRESSION: a USER_SUPPLIED comment on a SHORT day still carries the breach note', () => {
  const p = runPlan({
    lines: ['HCFM-323 2h :: paired with Sam on an unrelated hotfix'],
    isoDate: '2026-09-08', deps: deps(),
  })
  assert.equal(p.days[0].status, 'SHORT')
  const e = p.days[0].entries[0]
  assert.equal(e.commentSource, 'USER_SUPPLIED')
  assert.match(e.comment, /paired with Sam on an unrelated hotfix/)
  assert.match(e.comment, /logged 2\.0h, below the 7h policy floor/)
})

test('a USER_SUPPLIED comment on a day that MEETS the floor does not carry the breach note', () => {
  const p = runPlan({
    lines: ['HCFM-323 7h :: paired with Sam on an unrelated hotfix'],
    isoDate: '2026-09-08', deps: deps(),
  })
  assert.equal(p.days[0].status, 'MEETS')
  const e = p.days[0].entries[0]
  assert.equal(e.commentSource, 'USER_SUPPLIED')
  assert.match(e.comment, /paired with Sam on an unrelated hotfix/)
  assert.equal(/policy floor/i.test(e.comment), false)
})

test('an EVIDENCED comment on a SHORT day still carries the breach note and still passes grounding', () => {
  // If the breach suffix broke validateComment's grounding/token checks, runPlan
  // would throw here instead of returning - so a returned plan IS the proof that
  // grounding still holds with the suffix appended.
  const p = runPlan({ lines: ['HCFM-323 2h'], isoDate: '2026-09-08', deps: deps() })
  assert.equal(p.days[0].status, 'SHORT')
  const e = p.days[0].entries[0]
  assert.equal(e.commentSource, 'EVIDENCED')
  assert.match(e.comment, /status: In Progress/)
  assert.match(e.comment, /logged 2\.0h, below the 7h policy floor/)
})

test('the rendered PowerShell line for a SHORT-day USER_SUPPLIED entry is still emittable', () => {
  const p = runPlan({
    lines: ['HCFM-323 2h :: paired with Sam on an unrelated hotfix'],
    isoDate: '2026-09-08', deps: deps(),
  })
  const e = p.days[0].entries[0]
  assert.equal(/["`$;&|<>\r\n]/.test(e.comment), false)
  assert.doesNotThrow(() => renderPsCommand(buildAddArgv(e), BIN))
})

test('a SHORT day does not let the breach suffix rescue a user comment that sanitizes to nothing', () => {
  // Pins the ordering inside the USER_SUPPLIED branch: the emptiness check must
  // run on the user's own text BEFORE appendBreachNote runs, so a comment that
  // is pure shell-unsafe garbage is still refused - not silently replaced by a
  // comment consisting of nothing but the policy-floor sentence.
  assert.throws(
    () => runPlan({ lines: ['HCFM-323 2h :: $$$'], isoDate: '2026-09-08', deps: deps() }),
    /comment rejected.*empty after sanitization/i,
  )
})

test('a day flipping SHORT to MEETS changes planHash - the comment text is inside the hash', () => {
  const shortPlan = runPlan({ lines: ['HCFM-323 2h'], isoDate: '2026-09-08', deps: deps({ existing: 0 }) })
  const meetsPlan = runPlan({ lines: ['HCFM-323 2h'], isoDate: '2026-09-08', deps: deps({ existing: 5 * 3600 }) })
  assert.equal(shortPlan.days[0].status, 'SHORT')
  assert.equal(meetsPlan.days[0].status, 'MEETS')
  assert.notEqual(shortPlan.planHash, meetsPlan.planHash)
})
