// scripts/test/cmd-plan-ceiling.test.mjs
//
// The month-to-date progress ceiling, at the level where it actually refuses.
// lib/capacity's own tests cover the arithmetic; these cover the wiring, which
// is where the interesting failures live (a dep that silently defaults, a
// multi-day run that measures each day alone).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runPlan } from '../cmd/plan.mjs'
import { hashPlan } from '../lib/plan.mjs'
import { assertPlanIntegrity } from '../lib/planfile.mjs'

const ME = 'me-1'
const IDENT = { accountId: ME, zone: 'Asia/Riyadh', displayName: 'Test' }
const H = (n) => n * 3600

// 2026-09-14 is a Monday; Sep 1-14 holds 10 Sun-Thu workdays = 80h capacity.
const TODAY = Date.parse('2026-09-14T12:00:00+03:00')

function deps({ monthLogged = 0, monthStatus = 'OK', existing = 0, seen = null } = {}) {
  return {
    resolveIdentity: () => IDENT,
    dayTotal: () => ({ seconds: existing, status: 'OK', reason: '', countedWorklogIds: [], candidates: [] }),
    monthTotal: (a) => {
      if (seen) seen.push(a)
      return {
        seconds: monthLogged,
        status: monthStatus,
        reason: monthStatus === 'OK' ? '' : 'JQL returned 3 issue(s) with my time but the author-filtered sum is 0',
        countedWorklogIds: [], candidates: [],
      }
    },
    checkWindow: () => [],
    bundle: () => ({
      perIssue: { 'PROJ-223': [{ source: 'jira-changelog', timestamp: 't', fragment: 'status: In Progress' }] },
      commentSource: 'EVIDENCED', bundleHash: 'bh',
    }),
    resolveIssue: (key) => ({ key, numericId: '999', site: 'example.atlassian.net', summary: 'migration work' }),
    readEstimate: () => 0,
    now: () => TODAY,
  }
}

const LINE = 'PROJ-223 7.5h'

test('a plan that pushes the month over 105% is REFUSED', () => {
  // 78h already logged + 7.5h planned = 85.5h against 80h capacity = 106.9%.
  assert.throws(
    () => runPlan({ lines: [LINE], isoDate: ['2026-09-14'], deps: deps({ monthLogged: H(78) }) }),
    (e) => {
      assert.match(e.message, /PROGRESS CEILING/)
      assert.match(e.message, /106\.9% of capacity; the ceiling is 105%/)
      assert.match(e.message, /capacity 80\.00h = 10 workdays/)
      assert.match(e.message, /over the ceiling by 1\.50h/)
      assert.match(e.message, /--capacity-hours/, 'the refusal must name the way out')
      return true
    },
  )
})

test('the refusal states the arithmetic, so nobody has to interpret it', () => {
  // feedback_self_sufficient_guide: what failed, the numbers behind it, and the
  // next action -- never a bare threshold the operator has to reverse-engineer.
  try {
    runPlan({ lines: [LINE], isoDate: ['2026-09-14'], deps: deps({ monthLogged: H(100) }) })
    assert.fail('expected a refusal')
  } catch (e) {
    assert.match(e.message, /already on server 100\.00h \+ this plan 7\.50h = 107\.50h/)
    assert.match(e.message, /105% ceiling = 84\.00h/)
    assert.match(e.message, /Nothing was planned/)
  }
})

test('a plan landing exactly on 105% is allowed', () => {
  // 76.5h logged + 7.5h = 84.00h = exactly 105% of 80h.
  const plan = runPlan({ lines: [LINE], isoDate: ['2026-09-14'], deps: deps({ monthLogged: H(76.5) }) })
  assert.equal(plan.months.length, 1)
  assert.equal(plan.months[0].percent, 105)
  assert.equal(plan.months[0].capacitySeconds, H(80))
})

test('one second past 105% is refused', () => {
  assert.throws(
    () => runPlan({ lines: ['PROJ-223 7.5h'], isoDate: ['2026-09-14'], deps: deps({ monthLogged: H(76.5) + 1 }) }),
    /PROGRESS CEILING/,
  )
})

test('pendingSeconds closes the manifest hole: day 2 sees what day 1 will write', () => {
  // Manifest mode calls runPlan ONCE PER DATE and nothing is written between
  // days, so every call reads the same unchanged server total. Alone, each of
  // these two days passes. Together they break the ceiling, and only the
  // accumulator can see that.
  const d = deps({ monthLogged: H(70) })

  // Day 1 alone: 70 + 7.5 = 77.5h = 96.9%. Fine.
  const day1 = runPlan({ lines: [LINE], isoDate: ['2026-09-13'], deps: d, pendingByMonth: {} })
  assert.equal(day1.months[0].percent.toFixed(1), '96.9')

  // Day 2 measured ALONE would read the same 70h and also pass -- the bug.
  const day2Alone = runPlan({ lines: [LINE], isoDate: ['2026-09-14'], deps: d, pendingByMonth: {} })
  assert.ok(day2Alone.months[0].percent < 105, 'day 2 in isolation passes, which is exactly the trap')

  // Day 2 carrying day 1's pending 7.5h: 70 + 7.5 + 7.5 = 85h = 106.3%. Refused.
  assert.throws(
    () => runPlan({ lines: [LINE], isoDate: ['2026-09-14'], deps: d, pendingByMonth: { '2026-09': H(7.5) } }),
    /106\.3% of capacity/,
  )
})

test("pending hours are charged to their OWN month, not every month", () => {
  // MANIFEST_MAX_DAYS is 31, so one run can straddle a month boundary. A scalar
  // accumulator would charge September's pending hours against October too and
  // print arithmetic that does not add up.
  const d = deps({ monthLogged: H(70) })
  const plan = runPlan({
    lines: [LINE], isoDate: ['2026-09-14'], deps: d,
    pendingByMonth: { '2026-08': H(40) }, // a different month's pending time
  })
  // 70 logged + 7.5 planned = 77.5h, untouched by August's 40h.
  assert.equal(plan.months[0].plannedSeconds, H(7.5))
  assert.equal(plan.months[0].percent.toFixed(1), '96.9')
})

test('a missing deps.monthTotal throws rather than skipping the ceiling', () => {
  // A default no-op would disable this rail for every caller that forgot to
  // wire it -- the same false-green class as a check that passes against the
  // wrong thing. There is no silent-skip path.
  const d = deps()
  delete d.monthTotal
  assert.throws(
    () => runPlan({ lines: [LINE], isoDate: ['2026-09-14'], deps: d }),
    /requires deps\.monthTotal/,
  )
})

test('an UNKNOWN month total aborts instead of being treated as zero', () => {
  // A false zero here would CLEAR the ceiling for any plan at all -- it is the
  // one failure mode that turns this rail into an authorisation.
  assert.throws(
    () => runPlan({ lines: [LINE], isoDate: ['2026-09-14'], deps: deps({ monthStatus: 'UNKNOWN' }) }),
    (e) => {
      assert.match(e.message, /UNKNOWN month-to-date total for 2026-09/)
      assert.match(e.message, /Refusing to check the progress ceiling against an unverified number/)
      return true
    },
  )
})

test('--capacity-hours raises the ceiling and is recorded as an override', () => {
  // Someone whose real month is 22 workdays cannot be held to a 10-workday
  // capacity. The override is honoured and LABELLED -- never presented as a
  // measurement.
  const plan = runPlan({
    lines: [LINE], isoDate: ['2026-09-14'], deps: deps({ monthLogged: H(100) }), capacityHours: 176,
  })
  assert.equal(plan.months[0].capacitySeconds, H(176))
  assert.equal(plan.months[0].capacityOverridden, true)
  assert.match(plan.months[0].explain.join('\n'), /OVERRIDDEN via --capacity-hours/)
})

test('a nonsense --capacity-hours is refused, not coerced', () => {
  for (const bad of [0, -8, 'lots', NaN]) {
    assert.throws(
      () => runPlan({ lines: [LINE], isoDate: ['2026-09-14'], deps: deps(), capacityHours: bad }),
      /--capacity-hours must be a positive number/,
      `capacityHours=${JSON.stringify(bad)}`,
    )
  }
})

test('the month read is asked for the right window and the plan issue keys', () => {
  const seen = []
  runPlan({ lines: [LINE], isoDate: ['2026-09-14'], deps: deps({ seen }) })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].fromIso, '2026-09-01')
  assert.equal(seen[0].toIso, '2026-09-14')
  assert.equal(seen[0].accountId, ME, 'without this the author filter matches nothing and every sum reads 0')
  assert.equal(seen[0].zone, 'Asia/Riyadh')
  assert.deepEqual(seen[0].extraKeys, ['PROJ-223'])
})

test('the month block is part of what planHash covers', () => {
  // It is rendered at the gate, so it changes what the approval MEANS. A
  // hand-edited plan.json must not be able to show a comfortable percentage
  // over a month that really stands at 140%.
  const plan = runPlan({ lines: [LINE], isoDate: ['2026-09-14'], deps: deps({ monthLogged: H(40) }) })
  const before = plan.planHash

  const tampered = structuredClone(plan)
  tampered.months[0].loggedSeconds = H(4)
  delete tampered.planHash
  assert.notEqual(hashPlan(tampered), before, 'editing the month total must change the hash')
})

test('a backfill into a past month is measured against that whole month', () => {
  // August is over. Its capacity stopped accruing at the month end.
  const seen = []
  runPlan({ lines: [LINE], isoDate: ['2026-08-05'], deps: deps({ seen, monthLogged: H(100) }) })
  assert.equal(seen[0].fromIso, '2026-08-01')
  assert.equal(seen[0].toIso, '2026-08-31')
})

test('a plan written before the ceiling existed is refused BY NAME, not blamed on the user', () => {
  // hashPlan's canonical form gained a months key, so an old plan file can never
  // match its own stored hash. Refusing is right - it was never checked against
  // the ceiling - but "changed since it was previewed" accuses the operator of an
  // edit they did not make, and sends them looking for a tamper that is not there.
  const preCeiling = {
    version: 1, accountId: ME, zone: 'Asia/Riyadh', planHash: 'aaaaaaaaaaaa',
    days: [{ date: '2026-09-13', entries: [] }],
  }
  assert.throws(
    () => assertPlanIntegrity(preCeiling, null, { requireExpectHash: false }),
    (e) => {
      assert.match(e.message, /before the 105% month progress ceiling existed/)
      assert.match(e.message, /Nothing here may be written/)
      assert.equal(/changed since it was previewed/.test(e.message), false,
        'must not accuse the operator of editing the file')
      return true
    },
  )
})

test('a v2 plan that really was edited still gets the tamper message', () => {
  // The new guard must not swallow the case it sits in front of.
  const tampered = {
    version: 2, accountId: ME, zone: 'Asia/Riyadh', planHash: 'aaaaaaaaaaaa', months: [],
    days: [{ date: '2026-09-13', entries: [] }],
  }
  assert.throws(
    () => assertPlanIntegrity(tampered, null, { requireExpectHash: false }),
    /changed since it was previewed/,
  )
})

// --------------------------------------------------- the breach-note wording
//
// 13 worklog comments on the live server still read "logged 3.5h, below the 7h
// policy floor" on days that now hold 11h. That wording was unqualified, so it
// described a moving number and became false the moment the day was topped up.
// Those rows are historical and this skill cannot edit them -- worklog update is
// unreachable by construction. What it CAN do is never write that sentence again.

test('a SHORT day records the hours AS OF LOGGING, never as a bare claim', () => {
  const d = deps({ existing: 0, monthLogged: 0 })
  const plan = runPlan({ lines: ['PROJ-223 2h :: pair debugging'], isoDate: ['2026-09-14'], deps: d })
  const comment = plan.days[0].entries[0].comment

  assert.match(comment, /at time of logging this day held 2\.0h, below the 7h policy floor/)
  // The failure mode itself: the note must never assert a present-tense total.
  assert.equal(
    /(?<!at time of logging this day held )\blogged \d/.test(comment), false,
    'an unqualified "logged Xh" claim goes stale the moment the day is topped up',
  )
})

test('a day that MEETS the floor carries no breach note at all', () => {
  const d = deps({ existing: 0, monthLogged: 0 })
  const plan = runPlan({ lines: ['PROJ-223 7.5h :: full day on the migrator'], isoDate: ['2026-09-14'], deps: d })
  assert.equal(/policy floor/.test(plan.days[0].entries[0].comment), false)
})
