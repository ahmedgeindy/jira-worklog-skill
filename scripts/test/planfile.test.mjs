// skills/jira-worklog/scripts/test/planfile.test.mjs
//
// Decision D3a: the planHash prefix printed at the gate is required back via
// --expect-hash. Before this module existed, planHash was computed, printed and
// NEVER read: the human approved preview A (2h), the agent could re-run `plan`
// with a different split, and emit / check-cmd / check-write all validated
// against the NEW file and went green on hours nobody ever saw.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadPlanFile, assertPlanIntegrity, MIN_EXPECT_HASH_LENGTH } from '../lib/planfile.mjs'
import { hashPlan } from '../lib/plan.mjs'
import { runPlan } from '../cmd/plan.mjs'

const ME = 'me-1'
const CLI = fileURLToPath(new URL('../timelog.mjs', import.meta.url))

function makePlan(over = {}) {
  const p = {
    version: 1, accountId: ME, zone: 'Asia/Riyadh',
    days: [{
      date: '2026-09-08', existingSeconds: 0, status: 'MEETS',
      entries: [{
        key: 'PROJ-323', numericId: '999', site: 'x.atlassian.net',
        seconds: 25200, started: '2026-09-08T09:00:00.000+0300',
        comment: 'status: In Progress',
        fingerprint: 'abc123', dedupeState: 'CLEAR', hoursSource: 'stated',
        existingSecondsOnIssue: 0, estimateBefore: 0, evidence: [],
        ...over,
      }],
    }],
  }
  p.planHash = hashPlan(p)
  return p
}

/** Load from an injected reader so no test touches the real filesystem. */
function load(plan, expectHash, opts = {}) {
  return loadPlanFile({
    path: 'plan.json', expectHash, ...opts,
    deps: { readFile: () => JSON.stringify(plan) },
  })
}

test('happy path: an untouched plan with the right --expect-hash loads', () => {
  const p = makePlan()
  const loaded = load(p, p.planHash)
  assert.equal(loaded.days[0].entries[0].seconds, 25200)
})

test('a shortened but correct prefix of the planHash is accepted', () => {
  const p = makePlan()
  assert.ok(load(p, p.planHash.slice(0, MIN_EXPECT_HASH_LENGTH)))
})

test('seconds hand-edited in the plan file AFTER the gate is refused', () => {
  // The human approved 7h. The file now says 8h and still carries the old hash.
  const p = makePlan()
  p.days[0].entries[0].seconds = 28800
  assert.throws(() => load(p, p.planHash), /changed since it was previewed/i)
})

test('a hand-edited accountId is refused: it IS the dedup filter', () => {
  // Point the dedup filter at a colleague and every checkWindow read comes back
  // CLEAR, because none of THEIR rows are mine.
  const p = makePlan()
  p.accountId = 'someone-else'
  assert.throws(() => load(p, p.planHash), /changed since it was previewed/i)
})

test('a hand-edited dedupeState is refused: it IS what the drift check compares against', () => {
  const p = makePlan()
  p.days[0].entries[0].dedupeState = 'EXISTING'
  assert.throws(() => load(p, p.planHash), /changed since it was previewed/i)
})

test('a hand-edited estimateBefore is refused: it decides whether ESTIMATE_CLOBBERED can fire', () => {
  const p = makePlan({ estimateBefore: 230400 })
  p.days[0].entries[0].estimateBefore = 0 // now the guard can never fire
  assert.throws(() => load(p, p.planHash), /changed since it was previewed/i)
})

test('a WHOLESALE re-plan (internally consistent, different hours) is caught by --expect-hash', () => {
  // This is the C1 failure in full: the file is self-consistent, so the hash
  // self-check passes. Only the prefix the human actually read stops it.
  const approved = makePlan()
  const replanned = makePlan({ seconds: 28800 })
  assert.notEqual(replanned.planHash, approved.planHash)
  assert.doesNotThrow(() => assertPlanIntegrity(replanned, replanned.planHash))
  assert.throws(() => load(replanned, approved.planHash), /does not match this plan/i)
})

test('a MISSING --expect-hash is refused, not treated as "no opinion"', () => {
  const p = makePlan()
  assert.throws(() => load(p, undefined), /--expect-hash is required/i)
  assert.throws(() => load(p, ''), /--expect-hash is required/i)
})

test('a one-character --expect-hash is refused: 1-in-16 is not a gate', () => {
  const p = makePlan()
  assert.throws(() => load(p, p.planHash.slice(0, 1)), /too short/i)
})

test('a plan with no planHash at all is refused', () => {
  const p = makePlan()
  delete p.planHash
  assert.throws(() => load(p, 'abcdef'), /no planHash/i)
})

test('verify may load without --expect-hash, but the self-check still runs', () => {
  const p = makePlan()
  assert.doesNotThrow(() => load(p, null, { requireExpectHash: false }))
  p.days[0].entries[0].seconds = 28800
  assert.throws(() => load(p, null, { requireExpectHash: false }), /changed since it was previewed/i)
})

test('a real plan survives the JSON round-trip the production path performs', () => {
  // `plan` writes JSON to disk and `emit` reads it back. If any hashed field did
  // not survive that round-trip, every emit would refuse with "changed since it
  // was previewed" and the tool would be unusable.
  const deps = {
    resolveIdentity: () => ({ accountId: ME, zone: 'Asia/Riyadh', displayName: 'T' }),
    dayTotal: () => ({ seconds: 5 * 3600, status: 'OK', reason: '', countedWorklogIds: [], candidates: [] }),
    checkWindow: () => [],
    bundle: () => ({
      perIssue: { 'PROJ-323': [{ source: 'jira-changelog', timestamp: 't', fragment: 'status: In Progress' }] },
      commentSource: 'EVIDENCED', bundleHash: 'bh',
    }),
    resolveIssue: (key) => ({ key, numericId: '999', site: 'example.atlassian.net' }),
    now: () => Date.parse('2026-09-09T10:00:00+03:00'),
    readEstimate: () => 230400,
  }
  const plan = runPlan({ lines: ['PROJ-323 3h'], isoDate: '2026-09-08', deps })

  const dir = mkdtempSync(join(tmpdir(), 'twl-plan-'))
  try {
    const path = join(dir, 'worklog-plan.json')
    writeFileSync(path, JSON.stringify(plan, null, 2))
    const loaded = loadPlanFile({ path, expectHash: plan.planHash })
    assert.equal(hashPlan(loaded), plan.planHash)
    assert.equal(loaded.days[0].entries[0].estimateBefore, 230400)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// --- The CLI wiring itself. These spawn `node timelog.mjs`, never twg: the plan
// gate runs before locateTwg() is ever called, and PATH/LOCALAPPDATA are emptied
// in the child so that even a regression cannot reach a twg binary. ---

function runCli(args, plan) {
  const dir = mkdtempSync(join(tmpdir(), 'twl-cli-'))
  try {
    const path = join(dir, 'worklog-plan.json')
    writeFileSync(path, JSON.stringify(plan, null, 2))
    return spawnSync(process.execPath, [CLI, ...args, '--plan', path], {
      encoding: 'utf8',
      env: { ...process.env, PATH: '', Path: '', LOCALAPPDATA: '' },
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

for (const command of ['emit', 'check-cmd', 'check-write']) {
  test(`${command} REFUSES to run without --expect-hash`, () => {
    const p = makePlan()
    const r = runCli([command, '--date', '2026-09-08'], p)
    assert.equal(r.status, 1)
    assert.match(r.stderr, /--expect-hash is required/i)
  })

  test(`${command} REFUSES a wrong --expect-hash`, () => {
    const p = makePlan()
    const r = runCli([command, '--date', '2026-09-08', '--expect-hash', 'deadbeef'], p)
    assert.equal(r.status, 1)
    assert.match(r.stderr, /does not match this plan/i)
  })

  test(`${command} REFUSES a plan file edited after the gate`, () => {
    const p = makePlan()
    const approved = p.planHash
    p.days[0].entries[0].seconds = 28800
    const r = runCli([command, '--date', '2026-09-08', '--expect-hash', approved], p)
    assert.equal(r.status, 1)
    assert.match(r.stderr, /changed since it was previewed/i)
  })
}

test('positive control: with the correct --expect-hash the gate passes and emit proceeds', () => {
  // Proves the three refusals above are the GATE talking and not a CLI that
  // fails on everything. With the hash accepted, emit gets as far as looking for
  // twg — which this child process deliberately cannot find.
  const p = makePlan()
  const r = runCli(['emit', '--date', '2026-09-08', '--expect-hash', p.planHash], p)
  assert.equal(/expect-hash|previewed/i.test(r.stderr), false)
  assert.match(r.stderr, /twg not found/i)
})
