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

test('an UNKNOWN read reports NO number at all - not 0.00 hours', () => {
  // dayTotal returns seconds: 0 on every UNKNOWN branch. Rendering that as
  // serverHours "0.00" beside verdict "UNKNOWN" is the false-zero reading spec
  // 3.3 forbids: a reader skims the number, not the verdict.
  const deps = { dayTotal: () => ({ seconds: 0, status: 'UNKNOWN', reason: 'control failed' }) }
  const day = runVerify({ plan: PLAN, deps }).days[0]
  assert.equal(day.serverHours, null)
  assert.equal(day.serverSeconds, null)
  assert.equal(JSON.stringify(day).includes('0.00'), false)
})

test('an OK read still reports the number, in both units', () => {
  const deps = { dayTotal: () => ({ seconds: 7 * 3600, status: 'OK', reason: '' }) }
  const day = runVerify({ plan: PLAN, deps }).days[0]
  assert.equal(day.serverHours, '7.00')
  assert.equal(day.serverSeconds, 25200)
})

test('a genuine, positively-controlled 0h day still reports 0.00 rather than null', () => {
  const deps = { dayTotal: () => ({ seconds: 0, status: 'OK', reason: 'no candidate issues' }) }
  const day = runVerify({ plan: PLAN, deps }).days[0]
  assert.equal(day.verdict, 'SHORT')
  assert.equal(day.serverHours, '0.00')
})

test('the report states what green proves and what it does not', () => {
  const deps = { dayTotal: () => ({ seconds: 7 * 3600, status: 'OK', reason: '' }) }
  assert.match(runVerify({ plan: PLAN, deps }).caveat, /does not prove/i)
})
