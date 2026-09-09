#!/usr/bin/env node
// CLI entry. Routes plan / emit / check-cmd / check-write / verify.
// This file NEVER spawns a worklog write; the agent issues those as its own tool calls.
// There is no `apply` subcommand and there must never be one — see
// .superpowers/sdd/2026-09-09-jira-worklog-skill/task-12-brief.md.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { runPlan } from './cmd/plan.mjs'
import { emitManifest } from './cmd/emit.mjs'
import { checkCmd, checkWrite, fileTokenStore } from './cmd/guard.mjs'
import { runVerify } from './cmd/verify.mjs'
import { renderThenPersist } from './lib/preview.mjs'
import { loadPlanFile } from './lib/planfile.mjs'
import { resolveIdentity } from './lib/identity.mjs'
import { dayTotal } from './lib/daytotal.mjs'
import { checkWindow } from './lib/dedup.mjs'
import { bundle } from './lib/evidence.mjs'
import { run, assertTrustworthy, locateTwg } from './lib/twg.mjs'

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}

function resolveIssue(key) {
  const res = run(['jira', 'workitem', 'get', key, '-o', 'json'])
  assertTrustworthy(res, `workitem get ${key}`)
  const d = Array.isArray(res.data) ? res.data[0] : res.data
  if (!d?.id) throw new Error(`HARD STOP: cannot resolve ${key} (nonexistent or no permission)`)
  return { key, numericId: String(d.id), site: new URL(d.url).host }
}

/**
 * Ruling 1 (task-11 vs task-12 step 4): read the current remaining estimate so
 * cmd/plan.mjs can freeze it as estimateBefore, and so cmd/guard.mjs's
 * checkWrite can detect the estimate moving out from under a "leave" write.
 */
function readEstimate(key) {
  const res = run(['jira', 'workitem', 'get', key, '-o', 'json'])
  assertTrustworthy(res, `estimate read ${key}`)
  const d = Array.isArray(res.data) ? res.data[0] : res.data
  const tt = d?.timetracking
  // An ABSENT timetracking block is UNKNOWN, never "no estimate" — it is
  // byte-identical to a mistyped field path.
  if (tt === undefined) throw new Error(`UNKNOWN: no timetracking block on ${key}`)
  return Number(tt.remainingEstimateSeconds ?? 0)
}

const LIVE_DEPS = {
  resolveIdentity, dayTotal, checkWindow, bundle, resolveIssue, readEstimate,
  now: () => Date.now(),
}

const cmd = process.argv[2]

/**
 * Decision D3a: the planHash prefix printed at the gate must come back via
 * --expect-hash. loadPlanFile also re-derives the hash and refuses a plan file
 * that no longer matches its own stored planHash, so a hand-edited `seconds`,
 * accountId or dedupeState cannot reach a guard. Both gates are mandatory on
 * every command that stands next to a write.
 */
function loadPlan({ requireExpectHash = true } = {}) {
  try {
    return loadPlanFile({
      path: arg('plan', 'worklog-plan.json'),
      expectHash: arg('expect-hash'),
      requireExpectHash,
    })
  } catch (e) {
    process.stderr.write(`${e.message}\n`)
    process.exit(1)
  }
  return null // unreachable; keeps the control flow explicit
}

/** Approval tokens live beside the plan file, so check-cmd and check-write agree on where. */
function tokenStoreForPlan() {
  return fileTokenStore(dirname(resolve(arg('plan', 'worklog-plan.json'))))
}

if (cmd === 'plan') {
  const lines = readFileSync(0, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean)
  const dates = String(arg('date')).split(',').map((s) => s.trim())
  const plan = runPlan({ lines, isoDate: dates, deps: LIVE_DEPS })
  // The gate renders through the SAME renderer, with the SAME binary path, that
  // `emit` will use — so the line the human approves is byte-identical to the
  // line the agent runs.
  //
  // locateTwg() and every day's render() run BEFORE the plan file is written
  // (task-14 Fix A #3): a crash in either — e.g. a comment that reaches
  // renderPsCommand still carrying an unsafe character — must never leave a
  // stale plan file on disk that a later --expect-hash could be pointed at.
  const bin = locateTwg()
  const out = arg('out', 'worklog-plan.json')
  const blocks = renderThenPersist(plan, bin, () => writeFileSync(out, JSON.stringify(plan, null, 2)))
  for (const block of blocks) {
    process.stdout.write(`${block}\n\n`)
  }
  process.stdout.write(`plan written to ${out}\n`)
} else if (cmd === 'emit') {
  const plan = loadPlan()
  for (const row of emitManifest(plan, arg('date'), locateTwg())) {
    process.stdout.write(`${row.key}\t${row.fingerprint}\t${row.command}\n`)
  }
} else if (cmd === 'check-cmd') {
  const plan = loadPlan()
  const r = checkCmd({ plan, date: arg('date'), cmd: arg('cmd'), deps: { checkWindow, bin: locateTwg(), tokens: tokenStoreForPlan() } })
  process.stdout.write(r.ok ? 'OK\n' : `ABORT: ${r.reason}\n`)
  process.exit(r.ok ? 0 : 1)
} else if (cmd === 'check-write') {
  const plan = loadPlan()
  const r = checkWrite({ plan, date: arg('date'), key: arg('key'), deps: { checkWindow, readEstimate, tokens: tokenStoreForPlan() } })
  process.stdout.write(r.ok ? `OK worklog ${r.worklogId}\n` : `FAIL: ${r.reason}\n`)
  process.exit(r.ok ? 0 : 1)
} else if (cmd === 'verify') {
  // Read-only and post-hoc: the plan-file self-check still runs, but there is no
  // approval to bind here, so --expect-hash is optional (and honoured if given).
  const plan = loadPlan({ requireExpectHash: false })
  const r = runVerify({ plan, deps: { dayTotal } })
  process.stdout.write(`${JSON.stringify({ days: r.days, caveat: r.caveat }, null, 2)}\n`)
  process.exit(r.exitCode)
} else {
  process.stderr.write(
    `unknown command: ${cmd ?? '(none)'}\n` +
    'usage: timelog.mjs plan --date YYYY-MM-DD --out plan.json\n' +
    '       timelog.mjs emit --plan plan.json --date YYYY-MM-DD --expect-hash <planHash>\n' +
    '       timelog.mjs check-cmd --plan plan.json --date YYYY-MM-DD --expect-hash <planHash> --cmd "<literal line>"\n' +
    '       timelog.mjs check-write --plan plan.json --date YYYY-MM-DD --expect-hash <planHash> --key <KEY>\n' +
    '       timelog.mjs verify --plan plan.json\n' +
    '\n' +
    '--expect-hash is the planHash printed at the approval gate. It is REQUIRED on\n' +
    'emit, check-cmd and check-write: one approval covers exactly the rows that were\n' +
    'on screen, for exactly that date (decision D3a).\n',
  )
  process.exit(2)
}
