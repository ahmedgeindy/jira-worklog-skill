// skills/jira-worklog/scripts/test/cmd-emit.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { psQuote, renderPsCommand, emitManifest } from '../cmd/emit.mjs'
import { checkCmd, checkWrite, fileTokenStore } from '../cmd/guard.mjs'
import { hashPlan } from '../lib/plan.mjs'
import { markerFor } from '../lib/dedup.mjs'

const ME = 'me-1'
const BIN = 'C:/twg/twg.exe'

function makePlan(over = {}) {
  const p = {
    accountId: ME, zone: 'Asia/Riyadh',
    days: [{
      date: '2026-09-08', existingSeconds: 0, status: 'MEETS',
      entries: [{
        key: 'PROJ-323', numericId: '999', site: 'x.atlassian.net',
        seconds: 25200, started: '2026-09-08T09:00:00.000+0300',
        comment: `reviewed the migrator PR ${markerFor('abc123')}`,
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
  const p = makePlan({ comment: 'ran `whoami` $env:PATH [twl:abc123]' })
  assert.throws(() => emitManifest(p, '2026-09-08', BIN), /unsafe character/i)
})

// Fix 3: `"` is inert inside the single-quoted PowerShell argument itself, but
// the agent loop re-wraps the emitted line as `--cmd "<line>"` for check-cmd —
// an embedded `"` there breaks the outer quoting and can desync check-cmd's
// byte-equality comparison from what actually runs. Refuse at emit time.
test('a comment carrying a double quote is REFUSED at emit time', () => {
  const p = makePlan({ comment: 'said "hi" [twl:abc123]' })
  assert.throws(() => emitManifest(p, '2026-09-08', BIN), /unsafe character/i)
})

test('check-cmd accepts the byte-identical line and leaves an approval token', () => {
  const p = makePlan()
  const [row] = emitManifest(p, '2026-09-08', BIN)
  const tokens = makeTokenStore()
  const deps = { checkWindow: () => [], bin: BIN, tokens }
  const r = checkCmd({ plan: p, date: '2026-09-08', cmd: row.command, deps })
  assert.equal(r.ok, true)
  assert.equal(tokens.has('abc123'), true)
})

test('check-cmd REJECTS a line that drifted by one character, and leaves no token', () => {
  const p = makePlan()
  const [row] = emitManifest(p, '2026-09-08', BIN)
  const tampered = row.command.replace("'25200'", "'28800'")
  const tokens = makeTokenStore()
  const deps = { checkWindow: () => [], bin: BIN, tokens }
  const r = checkCmd({ plan: p, date: '2026-09-08', cmd: tampered, deps })
  assert.equal(r.ok, false)
  assert.match(r.reason, /does not match the manifest/i)
  assert.equal(tokens.has('abc123'), false)
})

test('check-cmd REJECTS when the server drifted since plan time, and leaves no token', () => {
  const p = makePlan()
  const [row] = emitManifest(p, '2026-09-08', BIN)
  const tokens = makeTokenStore()
  const deps = { bin: BIN, checkWindow: () => [{ author: { accountId: ME }, timeSpentSeconds: 25200 }], tokens }
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
  const deps = { checkWindow: () => [{ author: { accountId: ME }, timeSpentSeconds: 25200 }], bin: BIN, tokens }
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
  const deps = { checkWindow: () => [{ timeSpentSeconds: 999 }], bin: BIN, tokens }
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
  const deps = { checkWindow: () => [], bin: BIN, tokens }
  const r = checkCmd({ plan: p, date: '2026-09-08', cmd: row.command, deps })
  assert.equal(r.ok, true)
  assert.equal(tokens.has('abc123'), true)
})

test('check-write confirms exactly one row carrying this fingerprint marker (token present)', () => {
  const p = makePlan()
  const deps = {
    checkWindow: () => [{
      id: '5001', author: { accountId: ME }, timeSpentSeconds: 25200,
      comment: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: `x ${markerFor('abc123')}` }] }] },
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

test('check-write fails on TWO rows carrying the same marker (double-log, token present)', () => {
  const p = makePlan()
  const row = {
    id: '5001', author: { accountId: ME }, timeSpentSeconds: 25200,
    comment: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: markerFor('abc123') }] }] },
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
      id: '5001', author: { accountId: ME }, timeSpentSeconds: 25200,
      comment: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: markerFor('abc123') }] }] },
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
      id: '5001', author: { accountId: ME }, timeSpentSeconds: 25200,
      comment: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: `x ${markerFor('abc123')}` }] }] },
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

  const cc = checkCmd({ plan: p, date: '2026-09-08', cmd: row.command, deps: { checkWindow: () => [], bin: BIN, tokens } })
  assert.equal(cc.ok, true)

  const r = checkWrite({
    plan: p, date: '2026-09-08', key: 'PROJ-323',
    deps: {
      checkWindow: () => [{
        id: '5001', author: { accountId: ME }, timeSpentSeconds: 25200,
        comment: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: `x ${markerFor('abc123')}` }] }] },
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
    id: '5001', author: { accountId: ME }, timeSpentSeconds: 25200,
    comment: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: `x ${markerFor('abc123')}` }] }] },
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
