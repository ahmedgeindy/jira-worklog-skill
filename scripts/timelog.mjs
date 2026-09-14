#!/usr/bin/env node
// CLI entry. Routes plan / emit / check-cmd / check-write / verify.
// This file NEVER spawns a worklog write; the agent issues those as its own tool calls.
// There is no `apply` subcommand and there must never be one — see
// .superpowers/sdd/2026-09-09-jira-worklog-skill/task-12-brief.md.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'
import { runPlan } from './cmd/plan.mjs'
import { emitManifest } from './cmd/emit.mjs'
import { checkCmd, checkWrite, fileTokenStore } from './cmd/guard.mjs'
import { runVerify } from './cmd/verify.mjs'
import { renderThenPersist, renderMonths } from './lib/preview.mjs'
import { loadPlanFile } from './lib/planfile.mjs'
import { resolveIdentity } from './lib/identity.mjs'
import { dayTotal, monthTotal } from './lib/daytotal.mjs'
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
  // summary feeds the issue-mismatch warning in cmd/plan.mjs. Absent is fine —
  // the check simply does not fire — but it must never be invented.
  return { key, numericId: String(d.id), site: new URL(d.url).host, summary: d.summary ?? null }
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
  resolveIdentity, dayTotal, monthTotal, checkWindow, bundle, resolveIssue, readEstimate,
  now: () => Date.now(),
}

/**
 * --capacity-hours overrides the computed month capacity (Sun-Thu workdays x 8h).
 * It exists because the real report is per-person: colleagues on the same
 * dashboard show 80h, 72h and 64h for one fortnight, i.e. the same 8h/day
 * against different day counts. This tool cannot see leave, a mid-month start
 * or a part-time contract, so it states the model it used and takes a correction
 * rather than silently guessing. The value is recorded in the plan file.
 */
function capacityHoursArg() {
  const raw = arg("capacity-hours")
  if (raw === null) return null
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) {
    process.stderr.write(`PLAN REFUSED: --capacity-hours must be a positive number of hours, got ${JSON.stringify(raw)}.\n\nNothing was written.\n`)
    process.exit(2)
  }
  return n
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

/**
 * Manifest mode: one plan file per day, each with its own planHash.
 *
 * `plan --date a,b,c` applies the SAME entry lines to every date, so a backfill
 * where each day has its own comment needed one invocation per day (a real run
 * did 31). Manifest mode takes `YYYY-MM-DD<TAB><entry line>` on stdin and
 * groups by date.
 *
 * It does NOT widen decision D4. D4 caps one APPROVAL at 5 days; here each day
 * is planned separately and carries its own hash, so one approval still covers
 * exactly one day. Only generation is batched — every gate, guard and write is
 * unchanged and still per-day.
 */
const MANIFEST_MAX_DAYS = 31

function runManifest() {
  const raw = readFileSync(0, 'utf8').split('\n').map((s) => s.replace(/\s+$/, '')).filter((s) => s.trim())
  const byDate = new Map()
  for (const [i, row] of raw.entries()) {
    const m = /^(\d{4}-\d{2}-\d{2})[\t ]+(.*)$/.exec(row)
    if (!m) {
      process.stderr.write(
        `PLAN REFUSED: manifest line ${i + 1} is not "<YYYY-MM-DD><TAB><entry line>": ${JSON.stringify(row)}\n\n` +
        'Nothing was written. No plan file was created.\n',
      )
      process.exit(2)
    }
    if (!byDate.has(m[1])) byDate.set(m[1], [])
    byDate.get(m[1]).push(m[2].trim())
  }

  const dates = [...byDate.keys()].sort()
  if (dates.length > MANIFEST_MAX_DAYS) {
    process.stderr.write(`PLAN REFUSED: manifest names ${dates.length} days; max ${MANIFEST_MAX_DAYS} per run.\n\nNothing was written.\n`)
    process.exit(2)
  }

  const outDir = arg('out-dir')
  if (!outDir) {
    process.stderr.write('PLAN REFUSED: --out-dir is required in manifest mode (one plan file per day).\n\nNothing was written.\n')
    process.exit(2)
  }
  mkdirSync(resolve(outDir), { recursive: true })

  const bin = locateTwg()
  const capacityHours = capacityHoursArg()
  const summary = []
  // Manifest mode calls runPlan ONCE PER DATE, and nothing is written between
  // days, so every call reads the SAME unchanged server total. Without this
  // accumulator five 7.5h days would each measure the month alone and each pass
  // a ceiling that the five of them together break.
  const pendingByMonth = {}
  let lastPlan = null
  for (const date of dates) {
    let plan
    try {
      plan = runPlan({ lines: byDate.get(date), isoDate: [date], deps: LIVE_DEPS, pendingByMonth, capacityHours })
    } catch (e) {
      process.stderr.write(
        `PLAN REFUSED on ${date}: ${e.message}\n\n` +
        `${summary.length} earlier day(s) were written to ${outDir}; ${date} and everything after it were not.\n`,
      )
      process.exit(2)
    }
    const out = join(resolve(outDir), `${date}.json`)
    const blocks = renderThenPersist(plan, bin, () => writeFileSync(out, JSON.stringify(plan, null, 2)))
    for (const block of blocks) process.stdout.write(`${block}\n\n`)
    const d = plan.days[0]
    const ym = date.slice(0, 7)
    pendingByMonth[ym] = (pendingByMonth[ym] ?? 0) + Number(d.plannedSeconds)
    lastPlan = plan
    summary.push({ date, hash: plan.planHash, entries: d.entries.length, status: d.status })
  }

  // Scope, printed AFTER every preview so it is the last thing on screen: the
  // human is approving N separate days, and SKILL.md requires the full scope
  // before the first gate.
  process.stdout.write(`SCOPE: ${summary.length} days, ${summary.reduce((a, s) => a + s.entries, 0)} writes, plan files in ${outDir}\n`)
  for (const s of summary) {
    process.stdout.write(`  ${s.date}  ${String(s.entries).padStart(2)} entr${s.entries === 1 ? 'y' : 'ies'}  ${s.status.padEnd(7)} --expect-hash ${s.hash}\n`)
  }
  // The month block comes from the LAST plan: it is the only one whose
  // pendingSeconds covers every earlier day, so it is the only one stating the
  // month total the whole run would actually produce.
  if (lastPlan) process.stdout.write(`\n${renderMonths(lastPlan)}\n`)
  const exceeds = summary.filter((s) => s.status === 'EXCEEDS')
  if (exceeds.length) {
    process.stdout.write(`\n  ${exceeds.length} day(s) EXCEED the plausibility ceiling: ${exceeds.map((s) => s.date).join(', ')}\n`)
  }
}

if (cmd === 'plan' && process.argv.includes('--manifest')) {
  runManifest()
} else if (cmd === 'plan') {
  const lines = readFileSync(0, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean)
  const dates = String(arg('date')).split(',').map((s) => s.trim())
  // Every refusal in runPlan is a DECISION the operator has to act on - a
  // duplicate key, an UNKNOWN day total, a site mismatch, a future date. Those
  // must read as instructions, not as a Node stack trace: the operator should
  // never have to interpret an exception to learn what the tool refused and why.
  let plan
  try {
    plan = runPlan({ lines, isoDate: dates, deps: LIVE_DEPS, capacityHours: capacityHoursArg() })
  } catch (e) {
    process.stderr.write(`PLAN REFUSED: ${e.message}\n\nNothing was written. No plan file was created.\n`)
    process.exit(2)
  }
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
  process.stdout.write(`${renderMonths(plan)}\n\n`)
  process.stdout.write(`plan written to ${out}\n`)
} else if (cmd === 'emit') {
  const plan = loadPlan()
  for (const row of emitManifest(plan, arg('date'), locateTwg())) {
    process.stdout.write(`${row.key}\t${row.fingerprint}\t${row.command}\n`)
  }
} else if (cmd === 'check-cmd') {
  const plan = loadPlan()
  const r = checkCmd({ plan, date: arg('date'), cmd: arg('cmd'), deps: { checkWindow, monthTotal, bin: locateTwg(), tokens: tokenStoreForPlan() } })
  process.stdout.write(r.ok ? 'OK\n' : `ABORT: ${r.reason}\n`)
  process.exit(r.ok ? 0 : 1)
} else if (cmd === 'check-write') {
  const plan = loadPlan()
  // --fingerprint is optional and only needed to disambiguate when the plan
  // carries more than one entry for --key on --date (two distinct @HH:MM
  // start times on the same issue and day); checkWrite reports exactly that
  // if it is required and missing.
  const r = checkWrite({
    plan, date: arg('date'), key: arg('key'), fingerprint: arg('fingerprint'),
    deps: { checkWindow, readEstimate, tokens: tokenStoreForPlan() },
  })
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
    'usage: timelog.mjs plan --date YYYY-MM-DD --out plan.json [--capacity-hours <h>]\n' +
    '       timelog.mjs emit --plan plan.json --date YYYY-MM-DD --expect-hash <planHash>\n' +
    '       timelog.mjs check-cmd --plan plan.json --date YYYY-MM-DD --expect-hash <planHash> --cmd "<literal line>"\n' +
    '       timelog.mjs check-write --plan plan.json --date YYYY-MM-DD --expect-hash <planHash> --key <KEY> [--fingerprint <fp>]\n' +
    '       (--fingerprint is only required when --key has more than one entry that day, i.e. two\n' +
    '       distinct @HH:MM start times on the same issue)\n' +
    '       timelog.mjs verify --plan plan.json\n' +
    '\n' +
    '--expect-hash is the planHash printed at the approval gate. It is REQUIRED on\n' +
    'emit, check-cmd and check-write: one approval covers exactly the rows that were\n' +
    'on screen, for exactly that date (decision D3a).\n',
  )
  process.exit(2)
}
