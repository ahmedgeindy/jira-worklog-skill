// skills/jira-worklog/scripts/test/cmd-verify.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runVerify } from '../cmd/verify.mjs'

const PLAN = { accountId: 'me', zone: 'Asia/Riyadh', days: [{ date: '2026-09-08', entries: [{ key: 'A-1' }] }] }

test('a day that became SHORT during apply is reported as prominently as a plan-time short', () => {
  const deps = { dayTotal: () => ({ seconds: 4 * 3600, status: 'OK', reason: '' }) }
  const r = runVerify({ plan: PLAN, deps })
  assert.equal(r.days[0].verdict, 'SHORT')
  assert.equal(r.exitCode, 1)
})

test('a day meeting the floor passes', () => {
  const deps = { dayTotal: () => ({ seconds: 7 * 3600, status: 'OK', reason: '' }) }
  const r = runVerify({ plan: PLAN, deps })
  assert.equal(r.days[0].verdict, 'PASS')
  assert.equal(r.exitCode, 0)
})

test('an UNKNOWN read is reported as UNKNOWN, never as a pass', () => {
  const deps = { dayTotal: () => ({ seconds: 0, status: 'UNKNOWN', reason: 'control failed' }) }
  const r = runVerify({ plan: PLAN, deps })
  assert.equal(r.days[0].verdict, 'UNKNOWN')
  assert.equal(r.exitCode, 1)
})

test('the report states what green proves and what it does not', () => {
  const deps = { dayTotal: () => ({ seconds: 7 * 3600, status: 'OK', reason: '' }) }
  assert.match(runVerify({ plan: PLAN, deps }).caveat, /does not prove/i)
})
