// skills/jira-worklog/scripts/test/preview.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { render } from '../lib/preview.mjs'
import { emitManifest } from '../cmd/emit.mjs'

const BIN = 'C:/twg/twg.exe'

const ENTRY = {
  key: 'HCFM-323', seconds: 10800, started: '2026-09-08T09:00:00.000+0300',
  comment: 'moved to In Progress', dedupeState: 'CLEAR', hoursSource: 'stated',
  fingerprint: 'abc123', existingSecondsOnIssue: 0,
  evidence: [{ source: 'jira-changelog', timestamp: '2026-09-08T11:00:00.000+0300', fragment: 'status: In Progress' }],
}

const DAY = { date: '2026-09-08', existingSeconds: 0, entries: [ENTRY] }
const PLAN = { accountId: 'me-1', zone: 'Asia/Riyadh', days: [DAY] }

/** Every PowerShell write line rendered inside a preview block. */
function previewCommandLines(out) {
  return out.split('\n').filter((l) => l.trim().startsWith('&'))
}

test('the previewed line is BYTE-IDENTICAL to the line emit tells the agent to run', () => {
  // The old version of this test asserted renderArgv(buildAddArgv(E)) ===
  // renderArgv(buildAddArgv(E)) — a pure function equal to itself, which proves
  // nothing and passed happily while preview rendered `twg … "x"` and emit
  // rendered `& 'bin' 'x'`. This compares the two ACTUAL producers.
  const [row] = emitManifest(PLAN, DAY.date, BIN)
  const rendered = previewCommandLines(render(PLAN, DAY, BIN))
  assert.equal(rendered.length, 1)
  assert.equal(rendered[0].trim(), row.command)
  assert.equal(rendered[0], `      ${row.command}`)
})

test('that byte-comparison is sensitive: a one-field difference breaks it', () => {
  // Control for the test above. If this passes too, the comparison proves nothing.
  const other = { ...DAY, entries: [{ ...ENTRY, seconds: 25200 }] }
  const [row] = emitManifest({ ...PLAN, days: [other] }, DAY.date, BIN)
  const rendered = previewCommandLines(render(PLAN, DAY, BIN))
  assert.notEqual(rendered[0].trim(), row.command)
})

test('the previewed line carries the write contract and no shell chaining', () => {
  const [line] = previewCommandLines(render(PLAN, DAY, BIN))
  assert.ok(line.includes("'--adjust-estimate' 'leave'"))
  assert.ok(line.includes("'--notify-users' 'false'"))
  assert.ok(line.includes("'--time-spent-seconds' '10800'"))
  for (const bad of ['&&', '||', '2>&1', '`', ';']) {
    assert.equal(line.includes(bad), false, `preview line must not contain ${bad}`)
  }
})

test('render REFUSES to draw a gate without the binary it will be run with', () => {
  assert.throws(() => render(PLAN, DAY), /byte-identical|binary/i)
})

test('preview spells out the weekday', () => {
  assert.match(render(PLAN, DAY, BIN), /Tuesday/)
})

test('a Friday renders the restate-the-date challenge, not a y prompt', () => {
  const fri = { ...DAY, date: '2026-09-11' }
  const out = render({ ...PLAN, days: [fri] }, fri, BIN)
  assert.match(out, /Friday/)
  assert.match(out, /restate the date/i)
})

test('an EXISTING dedupe state never renders the word CLEAR', () => {
  const day = { ...DAY, entries: [{ ...ENTRY, dedupeState: 'EXISTING', existingSecondsOnIssue: 10800 }] }
  const out = render({ ...PLAN, days: [day] }, day, BIN)
  assert.match(out, /EXISTING/)
  assert.equal(/\bCLEAR\b/.test(out), false)
})

test('a SHORT day states hours and the floor but computes NO fillable gap', () => {
  const short = { ...DAY, entries: [{ ...ENTRY, seconds: 18000 }] } // 5h
  const out = render({ ...PLAN, days: [short] }, short, BIN)
  assert.match(out, /SHORT/)
  assert.match(out, /5\.0h/)
  assert.match(out, /7h/)
  // must never suggest how much to add, or where
  assert.equal(/2\.0h (short|remaining|to add)/i.test(out), false)
  assert.equal(out.includes('HCFM-345'), false)
})

test('derived hours are labelled as model-authored', () => {
  const day = { ...DAY, entries: [{ ...ENTRY, hoursSource: 'derived' }] }
  assert.match(render({ ...PLAN, days: [day] }, day, BIN), /derived/i)
})

test('every entry renders its evidence line', () => {
  assert.match(render(PLAN, DAY, BIN), /jira-changelog/)
})

test('the gate tells the human the planHash must come back via --expect-hash', () => {
  assert.match(render(PLAN, DAY, BIN), /--expect-hash/)
})
