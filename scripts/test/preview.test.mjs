// skills/jira-worklog/scripts/test/preview.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { render, renderThenPersist } from '../lib/preview.mjs'
import { emitManifest } from '../cmd/emit.mjs'

const BIN = 'C:/twg/twg.exe'

const ENTRY = {
  key: 'PROJ-323', seconds: 10800, started: '2026-09-08T09:00:00.000+0300',
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
  assert.equal(out.includes('PROJ-345'), false)
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

// --- task-14 Fix B: a USER_SUPPLIED comment must be labelled at the gate,
// the same way derived hours already are. ---

test('a USER_SUPPLIED comment is labelled at the gate', () => {
  const day = { ...DAY, entries: [{ ...ENTRY, commentSource: 'USER_SUPPLIED' }] }
  assert.match(render({ ...PLAN, days: [day] }, day, BIN), /USER_SUPPLIED/)
})

test('an EVIDENCED comment does NOT render the USER_SUPPLIED label - negative control', () => {
  const day = { ...DAY, entries: [{ ...ENTRY, commentSource: 'EVIDENCED' }] }
  assert.equal(/USER_SUPPLIED/.test(render({ ...PLAN, days: [day] }, day, BIN)), false)
})

// --- Feature 1: the start time must be visible on the entry line itself, not
// only inside the rendered command at the bottom of the block. ---

test('the entry line surfaces the actual clock time, not just inside the rendered command', () => {
  const day = { ...DAY, entries: [{ ...ENTRY, started: '2026-09-08T11:00:00.000+0300', startAt: '11:00' }] }
  const out = render({ ...PLAN, days: [day] }, day, BIN)
  const entryLine = out.split('\n').find((l) => l.includes(ENTRY.key) && !l.trim().startsWith('&'))
  assert.match(entryLine, /@11:00/)
})

test('a pinned (@HH:MM) entry is labelled PINNED at the gate', () => {
  const day = { ...DAY, entries: [{ ...ENTRY, started: '2026-09-08T11:00:00.000+0300', startAt: '11:00' }] }
  const out = render({ ...PLAN, days: [day] }, day, BIN)
  assert.match(out, /PINNED/)
})

test('an entry with no explicit start time is NOT labelled PINNED - negative control', () => {
  const out = render(PLAN, DAY, BIN) // ENTRY carries no startAt
  assert.equal(/PINNED/.test(out), false)
})

test('two entries for the same issue at different pinned times both show their own clock time', () => {
  const other = { ...ENTRY, seconds: 9000, started: '2026-09-08T13:00:00.000+0300', startAt: '13:00', fingerprint: 'def456' }
  const day = { ...DAY, entries: [{ ...ENTRY, started: '2026-09-08T11:00:00.000+0300', startAt: '11:00' }, other] }
  const out = render({ ...PLAN, days: [day] }, day, BIN)
  assert.match(out, /@11:00/)
  assert.match(out, /@13:00/)
})

// --- task-14 Fix A #3: a crash while rendering the preview must never leave a
// stale plan file behind for a later --expect-hash to be pointed at. The real
// bug lived in timelog.mjs, which used to writeFileSync the plan BEFORE
// rendering (and even before calling locateTwg()). renderThenPersist is the
// extracted, injectable primitive that fixes the ordering: render every day
// first, and only call the injected `persist` callback if that succeeds. ---

test('renderThenPersist does NOT persist when rendering throws', () => {
  const badDay = { date: '2026-09-08', existingSeconds: 0, entries: [{ ...ENTRY, started: undefined }] }
  let persisted = false
  assert.throws(
    () => renderThenPersist({ ...PLAN, days: [badDay] }, BIN, () => { persisted = true }),
    /started/i,
  )
  assert.equal(persisted, false, 'a render failure must never reach the persist callback')
})

test('renderThenPersist DOES persist once every day has rendered successfully (positive control)', () => {
  let persisted = false
  const blocks = renderThenPersist(PLAN, BIN, () => { persisted = true })
  assert.equal(persisted, true)
  assert.equal(blocks.length, 1)
  assert.match(blocks[0], /DAY 2026-09-08/)
})

test('renderThenPersist renders every day before persisting, not just the first', () => {
  const day2 = { ...DAY, date: '2026-09-09' }
  let persisted = false
  const blocks = renderThenPersist({ ...PLAN, days: [DAY, day2] }, BIN, () => { persisted = true })
  assert.equal(persisted, true)
  assert.equal(blocks.length, 2)
})

test('renderThenPersist requires the twg binary path just like render does', () => {
  assert.throws(() => renderThenPersist(PLAN, undefined, () => {}), /byte-identical|binary/i)
})
