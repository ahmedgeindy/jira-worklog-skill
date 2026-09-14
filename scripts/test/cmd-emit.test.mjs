// skills/jira-worklog/scripts/test/cmd-emit.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { psQuote, renderPsCommand, emitManifest } from '../cmd/emit.mjs'
import { checkCmd, checkWrite, fileTokenStore } from '../cmd/guard.mjs'
import { hashPlan } from '../lib/plan.mjs'

const ME = 'me-1'
const BIN = 'C:/twg/twg.exe'

// A month total low enough that the write-time ceiling re-check is never what
// these tests trip over; the ceiling has its own suite. Capacity below is 6
// workdays x 8h = 48h, so 7h of writes sits around 15%.
const LOW_MONTH = () => ({ seconds: 0, status: 'OK', reason: '', countedWorklogIds: [], candidates: [] })

function makePlan(over = {}) {
  const p = {
    accountId: ME, zone: 'Asia/Riyadh',
    months: [{
      month: '2026-09', from: '2026-09-01', to: '2026-09-08',
      loggedSeconds: 0, plannedSeconds: 25200, capacitySeconds: 6 * 8 * 3600,
      capacityOverridden: false, hoursPerDay: 8, ceilingPercent: 105,
      percent: 14.58, explain: ['  MONTH 2026-09: capacity 48.00h'],
    }],
    days: [{
      date: '2026-09-08', existingSeconds: 0, status: 'MEETS',
      entries: [{
        key: 'PROJ-323', numericId: '999', site: 'x.atlassian.net',
        seconds: 25200, started: '2026-09-08T09:00:00.000+0300',
        comment: 'reviewed the migrator PR',
        fingerprint: 'abc123', dedupeState: 'CLEAR', hoursSource: 'stated',
        existingSecondsOnIssue: 0, evidence: [],
        // Ruling 1: a real plan always freezes a numeric estimateBefore on every
        // entry. Mirrored in the default fixture here so it matches what
        // cmd/plan.mjs actually produces.
        estimateBefore: 0,
        ...over,
      }],
    }],
  }
  p.planHash = hashPlan(p)
  return p
}

/** In-memory approval-token store standing in for cmd/guard.mjs's fileTokenStore. */
function makeTokenStore(seed = []) {
  const set = new Set(seed)
  return {
    put: (fp) => { set.add(fp) },
    has: (fp) => set.has(fp),
    take: (fp) => {
      const had = set.has(fp)
      set.delete(fp)
      return had
    },
  }
}

test('psQuote single-quotes and doubles an embedded apostrophe', () => {
  assert.equal(psQuote('plain'), "'plain'")
  assert.equal(psQuote("it's done"), "'it''s done'")
})

test('a rendered command carries all five mandatory flags', () => {
  const [row] = emitManifest(makePlan(), '2026-09-08', BIN)
  for (const f of ['--time-spent-seconds', '--started', '--adjust-estimate', '--notify-users', '--comment-format']) {
    assert.ok(row.command.includes(f), `missing ${f}`)
  }
  assert.ok(row.command.includes("'leave'"))
  assert.ok(row.command.includes("'false'"))
})

test('a rendered command contains no PowerShell chaining or redirection', () => {
  const [row] = emitManifest(makePlan(), '2026-09-08', BIN)
  for (const bad of ['&&', '||', '2>&1', '`', ';']) {
    assert.equal(row.command.includes(bad), false, `command must not contain ${bad}`)
  }
})

test('a comment carrying a shell metacharacter is REFUSED at emit time', () => {
  const p = makePlan({ comment: 'ran `whoami` $env:PATH' })
  assert.throws(() => emitManifest(p, '2026-09-08', BIN), /unsafe character/i)
})

// Fix 3: `"` is inert inside the single-quoted PowerShell argument itself, but
// the agent loop re-wraps the emitted line as `--cmd "<line>"` for check-cmd —
// an embedded `"` there breaks the outer quoting and can desync check-cmd's
// byte-equality comparison from what actually runs. Refuse at emit time.
test('a comment carrying a double quote is REFUSED at emit time', () => {
  const p = makePlan({ comment: 'said "hi"' })
  assert.throws(() => emitManifest(p, '2026-09-08', BIN), /unsafe character/i)
})

test('check-cmd accepts the byte-identical line and leaves an approval token', () => {
  const p = makePlan()
  const [row] = emitManifest(p, '2026-09-08', BIN)
  const tokens = makeTokenStore()
  const deps = { checkWindow: () => [], monthTotal: LOW_MONTH, bin: BIN, tokens }
  const r = checkCmd({ plan: p, date: '2026-09-08', cmd: row.command, deps })
  assert.equal(r.ok, true)
  assert.equal(tokens.has('abc123'), true)
})

test('check-cmd REJECTS a line that drifted by one character, and leaves no token', () => {
  const p = makePlan()
  const [row] = emitManifest(p, '2026-09-08', BIN)
  const tampered = row.command.replace("'25200'", "'28800'")
  const tokens = makeTokenStore()
  const deps = { checkWindow: () => [], monthTotal: LOW_MONTH, bin: BIN, tokens }
  const r = checkCmd({ plan: p, date: '2026-09-08', cmd: tampered, deps })
  assert.equal(r.ok, false)
  assert.match(r.reason, /does not match the manifest/i)
  assert.equal(tokens.has('abc123'), false)
})

test('check-cmd REJECTS when the server drifted since plan time, and leaves no token', () => {
  const p = makePlan()
  const [row] = emitManifest(p, '2026-09-08', BIN)
  const tokens = makeTokenStore()
  const deps = { bin: BIN, checkWindow: () => [{ author: { accountId: ME }, timeSpentSeconds: 25200 }], monthTotal: LOW_MONTH, tokens }
  const r = checkCmd({ plan: p, date: '2026-09-08', cmd: row.command, deps })
  assert.equal(r.ok, false)
  assert.match(r.reason, /drift/i)
  assert.equal(tokens.has('abc123'), false)
})

test('checkCmd throws if deps.tokens is missing, rather than silently skipping bypass detection', () => {
  const p = makePlan()
  const [row] = emitManifest(p, '2026-09-08', BIN)
  const deps = { checkWindow: () => [], bin: BIN }
  assert.throws(() => checkCmd({ plan: p, date: '2026-09-08', cmd: row.command, deps }), /deps\.tokens/)
})

// --- Fix 1: checkCmd must not let a live DUPLICATE/AMBIGUOUS through just
// because the plan already froze that same state. Three distinct cases plus
// the CLEAR baseline. ---

test('checkCmd: plan-time DUPLICATE + live DUPLICATE still fails (regression)', () => {
  const p = makePlan({ dedupeState: 'DUPLICATE' })
  const [row] = emitManifest(p, '2026-09-08', BIN)
  const tokens = makeTokenStore()
  // Same accountId + same seconds as the plan -> classify() returns DUPLICATE.
  const deps = { checkWindow: () => [{ author: { accountId: ME }, timeSpentSeconds: 25200 }], monthTotal: LOW_MONTH, bin: BIN, tokens }
  const r = checkCmd({ plan: p, date: '2026-09-08', cmd: row.command, deps })
  assert.equal(r.ok, false)
  assert.match(r.reason, /DUPLICATE/)
  assert.match(r.reason, /stop/i)
  assert.equal(tokens.has('abc123'), false)
})

test('checkCmd: plan-time AMBIGUOUS + live AMBIGUOUS still fails', () => {
  const p = makePlan({ dedupeState: 'AMBIGUOUS' })
  const [row] = emitManifest(p, '2026-09-08', BIN)
  const tokens = makeTokenStore()
  // A row with no author.accountId at all -> classify() returns AMBIGUOUS.
  const deps = { checkWindow: () => [{ timeSpentSeconds: 999 }], monthTotal: LOW_MONTH, bin: BIN, tokens }
  const r = checkCmd({ plan: p, date: '2026-09-08', cmd: row.command, deps })
  assert.equal(r.ok, false)
  assert.match(r.reason, /AMBIGUOUS/)
  assert.match(r.reason, /stop/i)
  assert.equal(tokens.has('abc123'), false)
})

test('checkCmd: plan-time EXISTING + live EXISTING passes (top-up flow, regression)', () => {
  const p = makePlan({ dedupeState: 'EXISTING' })
  const [row] = emitManifest(p, '2026-09-08', BIN)
  const tokens = makeTokenStore()
  // Same accountId, different seconds, no marker -> classify() returns EXISTING,
  // matching the plan. This is the "close a SHORT day with a top-up" flow and
  // must pass rather than being blocked as drift or as a duplicate.
  const deps = {
    checkWindow: () => [{ author: { accountId: ME }, timeSpentSeconds: 3600, comment: {} }],
    monthTotal: LOW_MONTH,
    bin: BIN, tokens,
  }
  const r = checkCmd({ plan: p, date: '2026-09-08', cmd: row.command, deps })
  assert.equal(r.ok, true)
  assert.equal(tokens.has('abc123'), true)
})

test('checkCmd: CLEAR passes', () => {
  const p = makePlan({ dedupeState: 'CLEAR' })
  const [row] = emitManifest(p, '2026-09-08', BIN)
  const tokens = makeTokenStore()
  const deps = { checkWindow: () => [], monthTotal: LOW_MONTH, bin: BIN, tokens }
  const r = checkCmd({ plan: p, date: '2026-09-08', cmd: row.command, deps })
  assert.equal(r.ok, true)
  assert.equal(tokens.has('abc123'), true)
})

test('check-write confirms exactly one row matching the planned started+seconds (token present)', () => {
  const p = makePlan()
  const deps = {
    checkWindow: () => [{
      id: '5001', author: { accountId: ME }, timeSpentSeconds: 25200, started: '2026-09-08T09:00:00.000+0300',
      comment: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }] },
    }],
    readEstimate: () => 0,
    tokens: makeTokenStore(['abc123']),
  }
  const r = checkWrite({ plan: p, date: '2026-09-08', key: 'PROJ-323', deps })
  assert.equal(r.ok, true)
  assert.equal(r.worklogId, '5001')
})

test('check-write fails when the write did not land (token present)', () => {
  const p = makePlan()
  const deps = { checkWindow: () => [], readEstimate: () => 0, tokens: makeTokenStore(['abc123']) }
  assert.equal(checkWrite({ plan: p, date: '2026-09-08', key: 'PROJ-323', deps }).ok, false)
})

// Fix 2: an unknown --date must fail cleanly with a domain reason, not throw a
// raw TypeError from `plan.days.find(...).entries.find(...)`.
test('check-write fails with a clear reason (not a raw TypeError) when --date names a day the plan does not contain', () => {
  const p = makePlan()
  const deps = { checkWindow: () => [], readEstimate: () => 0, tokens: makeTokenStore(['abc123']) }
  assert.doesNotThrow(() => checkWrite({ plan: p, date: '2099-01-01', key: 'PROJ-323', deps }))
  const r = checkWrite({ plan: p, date: '2099-01-01', key: 'PROJ-323', deps })
  assert.equal(r.ok, false)
  assert.match(r.reason, /no day|contains no day/i)
})

test('check-write fails on TWO rows matching the planned started+seconds (double-log, token present)', () => {
  const p = makePlan()
  const row = {
    id: '5001', author: { accountId: ME }, timeSpentSeconds: 25200, started: '2026-09-08T09:00:00.000+0300',
    comment: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }] },
  }
  const deps = { checkWindow: () => [row, { ...row, id: '5002' }], readEstimate: () => 0, tokens: makeTokenStore(['abc123']) }
  const r = checkWrite({ plan: p, date: '2026-09-08', key: 'PROJ-323', deps })
  assert.equal(r.ok, false)
  assert.match(r.reason, /2 rows|duplicate/i)
})

test('check-write reports ESTIMATE_CLOBBERED when the estimate moved (token present)', () => {
  const p = makePlan({ existingSecondsOnIssue: 0, estimateBefore: 230400 })
  const deps = {
    checkWindow: () => [{
      id: '5001', author: { accountId: ME }, timeSpentSeconds: 25200, started: '2026-09-08T09:00:00.000+0300',
      comment: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }] },
    }],
    readEstimate: () => 205200,
    tokens: makeTokenStore(['abc123']),
  }
  const r = checkWrite({ plan: p, date: '2026-09-08', key: 'PROJ-323', deps })
  assert.equal(r.ok, false)
  assert.match(r.reason, /ESTIMATE_CLOBBERED/)
})

// --- Ruling 2: guard-bypass detection (prose over the brief's code block) ---

test('check-write reports GUARD BYPASSED when no approval token exists (agent skipped check-cmd)', () => {
  const p = makePlan()
  const deps = {
    checkWindow: () => [{
      id: '5001', author: { accountId: ME }, timeSpentSeconds: 25200, started: '2026-09-08T09:00:00.000+0300',
      comment: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }] },
    }],
    readEstimate: () => 0,
    tokens: makeTokenStore(), // empty - check-cmd never ran for this fingerprint
  }
  const r = checkWrite({ plan: p, date: '2026-09-08', key: 'PROJ-323', deps })
  assert.equal(r.ok, false)
  assert.match(r.reason, /GUARD BYPASSED/)
})

test('the realistic flow: check-cmd running first leaves the token check-write needs', () => {
  const p = makePlan()
  const [row] = emitManifest(p, '2026-09-08', BIN)
  const tokens = makeTokenStore()

  const cc = checkCmd({ plan: p, date: '2026-09-08', cmd: row.command, deps: { checkWindow: () => [], monthTotal: LOW_MONTH, bin: BIN, tokens } })
  assert.equal(cc.ok, true)

  const r = checkWrite({
    plan: p, date: '2026-09-08', key: 'PROJ-323',
    deps: {
      checkWindow: () => [{
        id: '5001', author: { accountId: ME }, timeSpentSeconds: 25200, started: '2026-09-08T09:00:00.000+0300',
        comment: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }] },
      }],
      readEstimate: () => 0,
      tokens,
    },
  })
  assert.equal(r.ok, true)
  assert.equal(r.worklogId, '5001')
})

test('the approval token is single-use: a second check-write without a fresh check-cmd is bypassed', () => {
  const p = makePlan()
  const tokens = makeTokenStore(['abc123'])
  const rows = [{
    id: '5001', author: { accountId: ME }, timeSpentSeconds: 25200, started: '2026-09-08T09:00:00.000+0300',
    comment: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }] },
  }]
  const deps = { checkWindow: () => rows, readEstimate: () => 0, tokens }

  const first = checkWrite({ plan: p, date: '2026-09-08', key: 'PROJ-323', deps })
  assert.equal(first.ok, true)

  const second = checkWrite({ plan: p, date: '2026-09-08', key: 'PROJ-323', deps })
  assert.equal(second.ok, false)
  assert.match(second.reason, /GUARD BYPASSED/)
})

test('checkWrite throws if deps.tokens is missing, rather than silently skipping bypass detection', () => {
  const p = makePlan()
  const deps = { checkWindow: () => [], readEstimate: () => 0 }
  assert.throws(() => checkWrite({ plan: p, date: '2026-09-08', key: 'PROJ-323', deps }), /deps\.tokens/)
})

// --- Feature 2 fallout: cmd/plan.mjs now allows more than one entry per
// (key, day) when each carries a distinct '@HH:MM'. `key` alone can then no
// longer name exactly one entry for check-write's post-write reconciliation -
// it must disambiguate by fingerprint instead of silently guessing the first
// match (which would check the WRONG entry's estimate/fingerprint whenever
// the agent confirms the second write). ---

function pushSecondEntry(p, over = {}) {
  p.days[0].entries.push({
    key: 'PROJ-323', numericId: '999', site: 'x.atlassian.net',
    seconds: 9000, started: '2026-09-08T13:00:00.000+0300', startAt: '13:00',
    comment: 'paired with Sam',
    fingerprint: 'def456', dedupeState: 'CLEAR', hoursSource: 'stated',
    existingSecondsOnIssue: 0, evidence: [], estimateBefore: 0,
    ...over,
  })
  p.planHash = hashPlan(p)
  return p
}

test('check-write refuses to guess when the plan has more than one entry for --key on --date, and no --fingerprint was given', () => {
  const p = pushSecondEntry(makePlan())
  const deps = { checkWindow: () => [], readEstimate: () => 0, tokens: makeTokenStore(['abc123', 'def456']) }
  const r = checkWrite({ plan: p, date: '2026-09-08', key: 'PROJ-323', deps })
  assert.equal(r.ok, false)
  assert.match(r.reason, /2 entries/i)
  assert.match(r.reason, /--fingerprint/)
})

test('check-write disambiguates by --fingerprint when the plan has two entries for the same key/day', () => {
  const p = pushSecondEntry(makePlan())
  const deps = {
    checkWindow: () => [{
      id: '5002', author: { accountId: ME }, timeSpentSeconds: 9000, started: '2026-09-08T13:00:00.000+0300',
      comment: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }] },
    }],
    readEstimate: () => 0,
    tokens: makeTokenStore(['def456']),
  }
  const r = checkWrite({ plan: p, date: '2026-09-08', key: 'PROJ-323', fingerprint: 'def456', deps })
  assert.equal(r.ok, true)
  assert.equal(r.worklogId, '5002')
})

// --- The marker used to be what told one entry's row from another's. These
// pin the started+seconds match that replaced it. ---

test('check-write picks the row for THIS entry when a same-length row exists at another start time', () => {
  // Two 2.5h entries on one issue/day, 11:00 and 13:00. Both rows are on the
  // server. Confirming the 13:00 entry must return ITS row (5002), never 5001 -
  // a seconds-only match would pick whichever came first.
  const p = pushSecondEntry(makePlan())
  const deps = {
    checkWindow: () => [
      { id: '5001', author: { accountId: ME }, timeSpentSeconds: 9000, started: '2026-09-08T11:00:00.000+0300' },
      { id: '5002', author: { accountId: ME }, timeSpentSeconds: 9000, started: '2026-09-08T13:00:00.000+0300' },
    ],
    readEstimate: () => 0,
    tokens: makeTokenStore(['def456']),
  }
  const r = checkWrite({ plan: p, date: '2026-09-08', key: 'PROJ-323', fingerprint: 'def456', deps })
  assert.equal(r.ok, true)
  assert.equal(r.worklogId, '5002')
})

test('check-write does NOT accept a row of the right length at the WRONG start time as proof the write landed', () => {
  // Same length, different time: the write did not land. Matching on seconds
  // alone would report a false OK here and the entry would be silently skipped.
  const p = makePlan()
  const deps = {
    checkWindow: () => [
      { id: '5009', author: { accountId: ME }, timeSpentSeconds: 25200, started: '2026-09-08T15:00:00.000+0300' },
    ],
    readEstimate: () => 0,
    tokens: makeTokenStore(['abc123']),
  }
  const r = checkWrite({ plan: p, date: '2026-09-08', key: 'PROJ-323', deps })
  assert.equal(r.ok, false)
  assert.match(r.reason, /did not land/i)
})

test('check-write ignores another author\'s row at the same start time and duration', () => {
  // PROJ-345 really does carry a second person's worklogs; an unfiltered read
  // there measured roughly double the truth.
  const p = makePlan()
  const deps = {
    checkWindow: () => [
      { id: '7777', author: { accountId: 'someone-else' }, timeSpentSeconds: 25200, started: '2026-09-08T09:00:00.000+0300' },
    ],
    readEstimate: () => 0,
    tokens: makeTokenStore(['abc123']),
  }
  const r = checkWrite({ plan: p, date: '2026-09-08', key: 'PROJ-323', deps })
  assert.equal(r.ok, false)
  assert.match(r.reason, /did not land/i)
})

test('check-write with an UNKNOWN --fingerprint against a multi-entry key fails cleanly, not by picking a wrong entry', () => {
  const p = pushSecondEntry(makePlan())
  const deps = { checkWindow: () => [], readEstimate: () => 0, tokens: makeTokenStore(['abc123', 'def456']) }
  const r = checkWrite({ plan: p, date: '2026-09-08', key: 'PROJ-323', fingerprint: 'nonexistent', deps })
  assert.equal(r.ok, false)
  assert.match(r.reason, /none with fingerprint/i)
})

test('check-write still works with no --fingerprint when the key has exactly one entry (backward compatible)', () => {
  const p = makePlan()
  const deps = {
    checkWindow: () => [{
      id: '5001', author: { accountId: ME }, timeSpentSeconds: 25200, started: '2026-09-08T09:00:00.000+0300',
      comment: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }] },
    }],
    readEstimate: () => 0,
    tokens: makeTokenStore(['abc123']),
  }
  const r = checkWrite({ plan: p, date: '2026-09-08', key: 'PROJ-323', deps })
  assert.equal(r.ok, true)
  assert.equal(r.worklogId, '5001')
})

// The real, disk-backed token store. Every test above uses the in-memory double;
// this exercises the actual production path (put/has/take against a real file
// named `.jira-worklog-approved-<fingerprint>`) in an isolated temp dir, so a bug
// in the filename or path join would be caught here rather than only in prod.
test('fileTokenStore puts, checks and consumes a real approval-token file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'twl-'))
  try {
    const tokens = fileTokenStore(dir)
    assert.equal(tokens.has('abc123'), false)

    tokens.put('abc123')
    assert.equal(tokens.has('abc123'), true)
    assert.equal(existsSync(join(dir, '.jira-worklog-approved-abc123')), true)

    assert.equal(tokens.take('abc123'), true)
    assert.equal(tokens.has('abc123'), false)
    assert.equal(existsSync(join(dir, '.jira-worklog-approved-abc123')), false)

    // Consuming twice is a no-op the second time, not a throw.
    assert.equal(tokens.take('abc123'), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// The progress ceiling, re-checked at WRITE time.
//
// cmd/plan.mjs evaluates the ceiling when the plan is built. Between the human
// approving it and the write actually happening, the month can move: time typed
// into the Jira UI, a second session, or the earlier entries of this same plan
// landing one at a time. Without this, a plan approved at 100% can be written
// past 105% and nothing ever looks again.
// ---------------------------------------------------------------------------

test('checkCmd REFUSES when the month moved past the ceiling since plan time', () => {
  const p = makePlan()
  const [row] = emitManifest(p, '2026-09-08', BIN)
  const tokens = makeTokenStore()
  // The plan froze capacity at 48h, so the ceiling is 50.4h. The month now holds
  // 48h and this write adds 7h: 55h, over.
  const deps = {
    checkWindow: () => [], bin: BIN, tokens,
    monthTotal: () => ({ seconds: 48 * 3600, status: 'OK', reason: '', countedWorklogIds: [], candidates: [] }),
  }
  const r = checkCmd({ plan: p, date: '2026-09-08', cmd: row.command, deps })
  assert.equal(r.ok, false)
  assert.match(r.reason, /PROGRESS CEILING at write time/)
  assert.match(r.reason, /month moved since this plan was approved/)
  assert.equal(tokens.has('abc123'), false, 'no approval token may be issued for a refused write')
})

test('the write-time refusal states the live number, the write, and the ceiling', () => {
  const p = makePlan()
  const [row] = emitManifest(p, '2026-09-08', BIN)
  const deps = {
    checkWindow: () => [], bin: BIN, tokens: makeTokenStore(),
    monthTotal: () => ({ seconds: 48 * 3600, status: 'OK', reason: '', countedWorklogIds: [], candidates: [] }),
  }
  const r = checkCmd({ plan: p, date: '2026-09-08', cmd: row.command, deps })
  assert.match(r.reason, /month now holds 48\.00h/)
  assert.match(r.reason, /this write of 7\.00h/)
  assert.match(r.reason, /would make it 55\.00h/)
  assert.match(r.reason, /48\.00h capacity/)
  assert.match(r.reason, /ceiling 50\.40h/)
})

test('an UNKNOWN live month refuses the write rather than reading as zero', () => {
  // A false zero here would clear the ceiling for every write that follows.
  const p = makePlan()
  const [row] = emitManifest(p, '2026-09-08', BIN)
  const tokens = makeTokenStore()
  const deps = {
    checkWindow: () => [], bin: BIN, tokens,
    monthTotal: () => ({ seconds: 0, status: 'UNKNOWN', reason: 'author-filtered sum is 0', countedWorklogIds: [], candidates: [] }),
  }
  const r = checkCmd({ plan: p, date: '2026-09-08', cmd: row.command, deps })
  assert.equal(r.ok, false)
  assert.match(r.reason, /UNKNOWN month-to-date total for 2026-09/)
  assert.equal(tokens.has('abc123'), false)
})

test('a missing deps.monthTotal throws rather than skipping the write-time ceiling', () => {
  const p = makePlan()
  const [row] = emitManifest(p, '2026-09-08', BIN)
  assert.throws(
    () => checkCmd({
      plan: p, date: '2026-09-08', cmd: row.command,
      deps: { checkWindow: () => [], bin: BIN, tokens: makeTokenStore() },
    }),
    /checkCmd requires deps\.monthTotal/,
  )
})

test('a plan with no month block for that date is refused, not waved through', () => {
  const p = makePlan()
  p.months = [] // a hand-built or truncated plan
  const [row] = emitManifest(p, '2026-09-08', BIN)
  const r = checkCmd({
    plan: p, date: '2026-09-08', cmd: row.command,
    deps: { checkWindow: () => [], bin: BIN, tokens: makeTokenStore(), monthTotal: LOW_MONTH },
  })
  assert.equal(r.ok, false)
  assert.match(r.reason, /no month block for 2026-09/)
})

test('capacity is taken FROZEN from the plan, never recomputed at write time', () => {
  // A capacity recomputed here would GROW as the month advances, loosening the
  // ceiling exactly when the write is closest to happening. The plan froze 48h,
  // so this must still be 48h.
  const p = makePlan()
  const [row] = emitManifest(p, '2026-09-08', BIN)
  const r = checkCmd({
    plan: p, date: '2026-09-08', cmd: row.command,
    deps: {
      checkWindow: () => [], bin: BIN, tokens: makeTokenStore(),
      monthTotal: () => ({ seconds: 44 * 3600, status: 'OK', reason: '', countedWorklogIds: [], candidates: [] }),
    },
  })
  // 44 + 7 = 51h. Against the frozen 48h capacity the ceiling is 50.4h, so this
  // refuses. Against a full-month 176h capacity it would pass -- that is the bug.
  assert.equal(r.ok, false)
  assert.match(r.reason, /48\.00h capacity/)
})

test('a write that keeps the month under the ceiling still passes', () => {
  // The rail must not simply always refuse.
  const p = makePlan()
  const [row] = emitManifest(p, '2026-09-08', BIN)
  const tokens = makeTokenStore()
  const r = checkCmd({
    plan: p, date: '2026-09-08', cmd: row.command,
    deps: {
      checkWindow: () => [], bin: BIN, tokens,
      monthTotal: () => ({ seconds: 40 * 3600, status: 'OK', reason: '', countedWorklogIds: [], candidates: [] }),
    },
  })
  assert.equal(r.ok, true, '40 + 7 = 47h against a 50.4h ceiling')
  assert.equal(tokens.has('abc123'), true)
})
