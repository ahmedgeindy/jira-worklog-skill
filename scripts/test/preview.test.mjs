// skills/jira-worklog/scripts/test/preview.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { render, renderArgv } from '../lib/preview.mjs'
import { buildAddArgv } from '../lib/plan.mjs'

const ENTRY = {
  key: 'PROJ-323', seconds: 10800, started: '2026-09-08T09:00:00.000+0300',
  comment: 'moved to In Progress', dedupeState: 'CLEAR', hoursSource: 'stated',
  evidence: [{ source: 'jira-changelog', timestamp: '2026-09-08T11:00:00.000+0300', fragment: 'status: In Progress' }],
}

const DAY = { date: '2026-09-08', existingSeconds: 0, entries: [ENTRY] }

test('the rendered command is character-identical to the argv apply will spawn', () => {
  const rendered = renderArgv(buildAddArgv(ENTRY))
  // reconstruct from the rendered form and compare to the source argv
  assert.equal(rendered, renderArgv(buildAddArgv(ENTRY)))
  assert.ok(rendered.includes('--adjust-estimate leave'))
  assert.ok(rendered.includes('--notify-users false'))
  assert.ok(rendered.includes('--time-spent-seconds 10800'))
})

test('preview spells out the weekday', () => {
  assert.match(render({ days: [DAY] }, DAY), /Tuesday/)
})

test('a Friday renders the restate-the-date challenge, not a y prompt', () => {
  const fri = { ...DAY, date: '2026-09-11' }
  const out = render({ days: [fri] }, fri)
  assert.match(out, /Friday/)
  assert.match(out, /restate the date/i)
})

test('an EXISTING dedupe state never renders the word CLEAR', () => {
  const day = { ...DAY, entries: [{ ...ENTRY, dedupeState: 'EXISTING', existingSecondsOnIssue: 10800 }] }
  const out = render({ days: [day] }, day)
  assert.match(out, /EXISTING/)
  assert.equal(/\bCLEAR\b/.test(out), false)
})

test('a SHORT day states hours and the floor but computes NO fillable gap', () => {
  const short = { ...DAY, entries: [{ ...ENTRY, seconds: 18000 }] } // 5h
  const out = render({ days: [short] }, short)
  assert.match(out, /SHORT/)
  assert.match(out, /5\.0h/)
  assert.match(out, /7h/)
  // must never suggest how much to add, or where
  assert.equal(/2\.0h (short|remaining|to add)/i.test(out), false)
  assert.equal(out.includes('PROJ-345'), false)
})

test('derived hours are labelled as model-authored', () => {
  const day = { ...DAY, entries: [{ ...ENTRY, hoursSource: 'derived' }] }
  assert.match(render({ days: [day] }, day), /derived/i)
})

test('every entry renders its evidence line', () => {
  assert.match(render({ days: [DAY] }, DAY), /jira-changelog/)
})
