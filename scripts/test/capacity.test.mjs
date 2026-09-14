// scripts/test/capacity.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  HOURS_PER_DAY, CEILING_PERCENT,
  monthBounds, workdaysInRange, monthWindow, capacitySeconds, ceilingVerdict, explain,
} from '../lib/capacity.mjs'

const H = (n) => n * 3600

test('September 2026 month-to-date reproduces the live figures exactly', () => {
  // The numbers this rail was built from, read off the server on 2026-09-14:
  // 113.50h logged against 80.00h capacity = 141.9%. If this test ever drifts,
  // the model stopped matching the thing it was calibrated against.
  const [w] = monthWindow({ todayIso: '2026-09-14', plannedDates: ['2026-09-14'] })
  assert.deepEqual(w, { month: '2026-09', from: '2026-09-01', to: '2026-09-14' })

  const cap = capacitySeconds({ fromIso: w.from, toIso: w.to })
  assert.equal(cap, H(80), '10 Sun-Thu workdays x 8h')

  const v = ceilingVerdict({ loggedSeconds: H(113.5), plannedSeconds: 0, capacitySeconds: cap })
  assert.equal(v.ok, false)
  assert.equal(v.percent.toFixed(1), '141.9')
  assert.equal(v.excessSeconds, H(29.5))
})

test('the 105% boundary is exact to the second', () => {
  // A float ratio (capacity * 1.05) cannot promise this. The comparison is
  // integer: total * 100 <= capacity * 105.
  const cap = H(80)
  assert.equal(ceilingVerdict({ loggedSeconds: H(84), plannedSeconds: 0, capacitySeconds: cap }).ok, true,
    'exactly 105.0% must PASS')
  assert.equal(ceilingVerdict({ loggedSeconds: H(84) + 1, plannedSeconds: 0, capacitySeconds: cap }).ok, false,
    'one second over 105.0% must REFUSE')
  // The split between logged and planned must not change the verdict.
  assert.equal(ceilingVerdict({ loggedSeconds: H(80), plannedSeconds: H(4), capacitySeconds: cap }).ok, true)
  assert.equal(ceilingVerdict({ loggedSeconds: H(80), plannedSeconds: H(4) + 1, capacitySeconds: cap }).ok, false)
})

test('removing 30h from the live over-log lands under the ceiling', () => {
  const v = ceilingVerdict({ loggedSeconds: H(113.5 - 30), plannedSeconds: 0, capacitySeconds: H(80) })
  assert.equal(v.ok, true)
  assert.equal(v.percent.toFixed(1), '104.4')
})

test('workdaysInRange counts Sunday-Thursday only', () => {
  // 2026-09-01 is a Tuesday; 09-04 Fri and 09-05 Sat are not workdays.
  assert.equal(workdaysInRange('2026-09-01', '2026-09-03'), 3)
  assert.equal(workdaysInRange('2026-09-04', '2026-09-05'), 0, 'Fri+Sat')
  assert.equal(workdaysInRange('2026-09-01', '2026-09-14'), 10)
  assert.equal(workdaysInRange('2026-09-01', '2026-09-30'), 22)
  assert.equal(workdaysInRange('2026-09-10', '2026-09-01'), 0, 'reversed range is empty, not negative')
})

test('workdaysInRange is not fooled by a DST shift inside the range', () => {
  // Riyadh has no DST, but the loop steps in fixed 86400000ms increments over
  // UTC midnights, so a zone that does shift must not drop or double a day.
  // October 2026 contains the Europe/Cairo-vs-Riyadh divergence date (10-30).
  // Sun 10-25 .. Thu 10-29 is 5, Fri 10-30 and Sat 10-31 are out, Sun 11-01 ..
  // Thu 11-05 is 5 more. Verified against Intl weekday names, not counted by eye.
  assert.equal(workdaysInRange('2026-10-25', '2026-11-05'), 10)
  assert.equal(workdaysInRange('2026-10-30', '2026-10-31'), 0, 'the Fri/Sat straddling the shift')
})

test('monthBounds handles month lengths and leap years', () => {
  assert.deepEqual(monthBounds('2026-09-14'), { first: '2026-09-01', last: '2026-09-30' })
  assert.deepEqual(monthBounds('2026-02-10'), { first: '2026-02-01', last: '2026-02-28' })
  assert.deepEqual(monthBounds('2028-02-10'), { first: '2028-02-01', last: '2028-02-29' })
  assert.deepEqual(monthBounds('2026-12-31'), { first: '2026-12-01', last: '2026-12-31' })
})

test('backfilling an earlier day does not shrink the window', () => {
  // The days since the backfilled one still happened, so capacity still accrued.
  const [w] = monthWindow({ todayIso: '2026-09-14', plannedDates: ['2026-09-02'] })
  assert.deepEqual(w, { month: '2026-09', from: '2026-09-01', to: '2026-09-14' })
})

test('a plan in a past month measures that whole month', () => {
  // August is over: its capacity stopped accruing at the month end, not at today.
  const [w] = monthWindow({ todayIso: '2026-09-14', plannedDates: ['2026-08-05'] })
  assert.deepEqual(w, { month: '2026-08', from: '2026-08-01', to: '2026-08-31' })
})

test('a plan straddling a month boundary yields one window per month', () => {
  const ws = monthWindow({ todayIso: '2026-10-02', plannedDates: ['2026-09-30', '2026-10-01'] })
  assert.equal(ws.length, 2)
  assert.deepEqual(ws[0], { month: '2026-09', from: '2026-09-01', to: '2026-09-30' })
  assert.deepEqual(ws[1], { month: '2026-10', from: '2026-10-01', to: '2026-10-02' })
})

test('a future date inside this month extends the window to that date', () => {
  const [w] = monthWindow({ todayIso: '2026-09-14', plannedDates: ['2026-09-20'] })
  assert.equal(w.to, '2026-09-20')
})

test('the window never runs past the end of its own month', () => {
  const [w] = monthWindow({ todayIso: '2026-09-30', plannedDates: ['2026-09-30'] })
  assert.equal(w.to, '2026-09-30')
})

test('zero capacity REFUSES rather than reporting a comfortable 0%', () => {
  // No Sun-Thu day in the window. A "0%" pass here would clear the ceiling on
  // exactly the case where the model does not apply.
  const v = ceilingVerdict({ loggedSeconds: H(8), plannedSeconds: 0, capacitySeconds: 0 })
  assert.equal(v.ok, false)
  assert.equal(v.percent, null)
  assert.match(v.reason, /capacity is 0/)
  // Nothing logged against no capacity is not a breach.
  assert.equal(ceilingVerdict({ loggedSeconds: 0, plannedSeconds: 0, capacitySeconds: 0 }).ok, true)
})

test('a non-numeric input throws instead of coercing to a passing verdict', () => {
  // Number(undefined) is NaN and every comparison with NaN is false, so an
  // unguarded `total > limit` would read as "not over" and PASS.
  assert.throws(
    () => ceilingVerdict({ loggedSeconds: undefined, plannedSeconds: 0, capacitySeconds: H(80) }),
    /must all be numbers/,
  )
  assert.throws(
    () => ceilingVerdict({ loggedSeconds: 0, plannedSeconds: null, capacitySeconds: 'eighty' }),
    /must all be numbers/,
  )
})

test('capacitySeconds refuses a nonsense hoursPerDay', () => {
  assert.throws(() => capacitySeconds({ fromIso: '2026-09-01', toIso: '2026-09-14', hoursPerDay: 0 }), /positive number/)
  assert.throws(() => capacitySeconds({ fromIso: '2026-09-01', toIso: '2026-09-14', hoursPerDay: -8 }), /positive number/)
})

test('a malformed date is rejected, not silently treated as a boundary', () => {
  assert.throws(() => workdaysInRange('2026-9-1', '2026-09-14'), /expected YYYY-MM-DD/)
  assert.throws(() => monthWindow({ todayIso: 'today', plannedDates: ['2026-09-01'] }), /expected YYYY-MM-DD/)
  assert.throws(() => monthWindow({ todayIso: '2026-09-14', plannedDates: ['Sept 1'] }), /expected YYYY-MM-DD/)
  assert.throws(() => monthWindow({ todayIso: '2026-09-14', plannedDates: [] }), /no planned dates/)
})

test('explain prints arithmetic the operator can redo by hand', () => {
  const [w] = monthWindow({ todayIso: '2026-09-14', plannedDates: ['2026-09-14'] })
  const cap = capacitySeconds({ fromIso: w.from, toIso: w.to })
  const v = ceilingVerdict({ loggedSeconds: H(70), plannedSeconds: H(7.5), capacitySeconds: cap })
  const out = explain({ window: w, verdict: v }).join('\n')
  assert.match(out, /10 workdays \(Sun-Thu, 2026-09-01\.\.2026-09-14\) x 8h/)
  assert.match(out, /80\.00h/)
  assert.match(out, /70\.00h \+ this plan 7\.50h = 77\.50h/)
  assert.match(out, /96\.9%/)
  assert.match(out, /105% ceiling = 84\.00h/)
})

test('an overridden capacity SAYS it was overridden', () => {
  // The whole point of the override is that the tool cannot see leave or a
  // mid-month start. A ceiling computed from a number the operator supplied
  // must never be presented as a measurement.
  const [w] = monthWindow({ todayIso: '2026-09-14', plannedDates: ['2026-09-14'] })
  const v = ceilingVerdict({ loggedSeconds: H(60), plannedSeconds: 0, capacitySeconds: H(64) })
  const out = explain({ window: w, verdict: v, capacityOverridden: true }).join('\n')
  assert.match(out, /OVERRIDDEN via --capacity-hours/)
  assert.match(out, /computed value was 10 workdays x 8h/)
})

test('the published constants are the documented ones', () => {
  assert.equal(HOURS_PER_DAY, 8)
  assert.equal(CEILING_PERCENT, 105)
})
