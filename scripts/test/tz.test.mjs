import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  offsetFor, dayBounds, queryWindow, startedString, dayOfInstant,
  addDays, weekdayOf, isWorkday, assertNotFuture,
} from '../lib/tz.mjs'

const RIYADH = 'Asia/Riyadh'
const CAIRO = 'Africa/Cairo'

test('Riyadh has no DST: same offset before and after the Egypt transition', () => {
  assert.equal(offsetFor(RIYADH, '2026-10-25'), '+0300')
  assert.equal(offsetFor(RIYADH, '2026-11-15'), '+0300')
})

test('Cairo DOES shift across 2026-10-30 - this is the trap being guarded', () => {
  assert.equal(offsetFor(CAIRO, '2026-10-25'), '+0300')
  assert.equal(offsetFor(CAIRO, '2026-11-15'), '+0200')
})

test('offset string is colon-less', () => {
  assert.match(offsetFor(RIYADH, '2026-09-09'), /^[+-]\d{4}$/)
})

test('startedString has millis and a colon-less offset', () => {
  assert.equal(
    startedString(RIYADH, '2026-09-08', '09:00:00'),
    '2026-09-08T09:00:00.000+0300',
  )
})

test('a Riyadh-midnight worklog is INSIDE the widened window and OUTSIDE the naive one', () => {
  const D = '2026-09-08'
  const { e0, e1 } = dayBounds(RIYADH, D)
  const midnight = e0
  assert.equal(midnight > e0 && midnight < e1, false)
  const w = queryWindow(RIYADH, D)
  assert.equal(midnight > w.after && midnight < w.before, true)
})

test('queryWindow widens the lower bound by exactly 1ms and leaves the upper at next midnight', () => {
  const D = '2026-09-08'
  const { e0, e1 } = dayBounds(RIYADH, D)
  assert.deepEqual(queryWindow(RIYADH, D), { after: e0 - 1, before: e1 })
})

test('dayOfInstant maps an instant to the Jira calendar day, not the machine one', () => {
  const a = Date.parse('2026-11-15T22:30:00+02:00')
  assert.equal(dayOfInstant(a, RIYADH), '2026-11-15')
  const b = Date.parse('2026-11-15T23:30:00+02:00')
  assert.equal(dayOfInstant(b, RIYADH), '2026-11-16')
})

test('work week is Sunday-Thursday', () => {
  assert.equal(weekdayOf('2026-09-06'), 'Sunday')
  assert.equal(isWorkday('2026-09-06'), true)
  assert.equal(isWorkday('2026-09-10'), true)
  assert.equal(isWorkday('2026-09-11'), false)
  assert.equal(isWorkday('2026-09-12'), false)
})

test('assertNotFuture refuses a future INSTANT, not merely a future date', () => {
  const now = Date.parse('2026-09-09T10:00:00+03:00')
  assert.doesNotThrow(() => assertNotFuture('2026-09-09T09:00:00.000+0300', now))
  assert.throws(
    () => assertNotFuture('2026-09-09T15:00:00.000+0300', now),
    /future/i,
  )
})

test('addDays crosses month and year boundaries', () => {
  assert.equal(addDays('2026-09-30', 1), '2026-10-01')
  assert.equal(addDays('2026-01-01', -1), '2025-12-31')
})
