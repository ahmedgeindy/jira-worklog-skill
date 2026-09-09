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
import { render } from './lib/preview.mjs'
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

function loadPlan() {
  return JSON.parse(readFileSync(arg('plan', 'worklog-plan.json'), 'utf8'))
}

/** Approval tokens live beside the plan file, so check-cmd and check-write agree on where. */
function tokenStoreForPlan() {
  return fileTokenStore(dirname(resolve(arg('plan', 'worklog-plan.json'))))
}

if (cmd === 'plan') {
  const lines = readFileSync(0, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean)
  const dates = String(arg('date')).split(',').map((s) => s.trim())
  const plan = runPlan({ lines, isoDate: dates, deps: LIVE_DEPS })
  const out = arg('out', 'worklog-plan.json')
  writeFileSync(out, JSON.stringify(plan, null, 2))
  for (const day of plan.days) {
    process.stdout.write(`${render(plan, day)}\n\n`)
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
  const plan = loadPlan()
  const r = runVerify({ plan, deps: { dayTotal } })
  process.stdout.write(`${JSON.stringify({ days: r.days, caveat: r.caveat }, null, 2)}\n`)
  process.exit(r.exitCode)
} else {
  process.stderr.write(
    `unknown command: ${cmd ?? '(none)'}\n` +
    'usage: timelog.mjs plan --date YYYY-MM-DD --out plan.json\n' +
    '       timelog.mjs emit --plan plan.json --date YYYY-MM-DD\n' +
    '       timelog.mjs check-cmd --plan plan.json --date YYYY-MM-DD --cmd "<literal line>"\n' +
    '       timelog.mjs check-write --plan plan.json --date YYYY-MM-DD --key <KEY>\n' +
    '       timelog.mjs verify --plan plan.json\n',
  )
  process.exit(2)
}
