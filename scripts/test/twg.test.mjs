import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { assertArgvSafe, assertNoForbiddenTokens, assertEcho, parseStdout, toEnvelope } from '../lib/twg.mjs'
import { buildAddArgv } from '../lib/plan.mjs'
import { renderPsCommand } from '../lib/psline.mjs'

test('a normal read argv passes', () => {
  assert.doesNotThrow(() => assertArgvSafe(
    ['jira', 'workitem', 'worklog', 'query', '--issue-id', 'HCFM-323', '-o', 'json'],
  ))
})

test('worklog delete and update are unreachable', () => {
  assert.throws(() => assertArgvSafe(['jira', 'workitem', 'worklog', 'delete', '--id', '1']), /forbidden/i)
  assert.throws(() => assertArgvSafe(['jira', 'workitem', 'worklog', 'update', '--id', '1']), /forbidden/i)
})

test('--override-editable and raw JSON payload flags are unreachable', () => {
  assert.throws(() => assertArgvSafe(['jira', 'x', '--override-editable']), /forbidden/i)
  assert.throws(() => assertArgvSafe(['jira', 'x', '--input-json', '{}']), /forbidden/i)
  assert.throws(() => assertArgvSafe(['jira', 'x', '--variables-json', '{}']), /forbidden/i)
})

test('--time-spent is forbidden but --time-spent-seconds is allowed', () => {
  assert.throws(() => assertArgvSafe(['a', '--time-spent', '7h']), /forbidden/i)
  assert.doesNotThrow(() => assertArgvSafe(['a', '--time-spent-seconds', '25200']))
})

test('a shell redirection token can never appear in argv', () => {
  assert.throws(() => assertArgvSafe(['a', '2>&1']), /forbidden/i)
})

// --- I4: `worklog add` must not be SPAWNABLE. There is no write path in this
// tree today, but that is an absence of callers, not an invariant. run() calls
// assertArgvSafe, so a future one-line run(buildAddArgv(e)) now throws instead
// of spawning an unprompted Jira write from the allowlisted `node` process. ---

test('spawning a worklog add is refused outright', () => {
  const argv = buildAddArgv({
    key: 'HCFM-323', seconds: 25200,
    started: '2026-09-08T09:00:00.000+0300', comment: 'x',
  })
  assert.throws(() => assertArgvSafe(argv), /refusing to SPAWN a worklog add/i)
  assert.throws(
    () => assertArgvSafe(['jira', 'workitem', 'worklog', 'add', '--issue-id', 'X-1']),
    /refusing to SPAWN/i,
  )
})

test('but BUILDING and RENDERING an add still works - text cannot write to Jira', () => {
  const entry = {
    key: 'HCFM-323', seconds: 25200,
    started: '2026-09-08T09:00:00.000+0300', comment: 'status: In Progress',
  }
  const argv = buildAddArgv(entry)
  assert.ok(argv.includes('--adjust-estimate'))
  assert.doesNotThrow(() => assertNoForbiddenTokens(argv))
  const line = renderPsCommand(argv, 'C:/twg/twg.exe')
  assert.match(line, /'worklog' 'add'/)
})

test('the renderer-level check still refuses delete and update', () => {
  assert.throws(() => assertNoForbiddenTokens(['jira', 'workitem', 'worklog', 'delete']), /forbidden/i)
  assert.throws(() => assertNoForbiddenTokens(['jira', 'x', '--override-editable']), /forbidden/i)
})

test('assertEcho catches the parseInt truncation trap', () => {
  // twg silently accepts an ISO string and truncates it to 2026 (= epoch 1970),
  // turning the filter into a no-op that returns EVERY row.
  assert.throws(
    () => assertEcho({ startedAfter: 1776632400000 }, { startedAfter: 2026 }),
    /echo mismatch/i,
  )
})

test('assertEcho passes when the server echoed exactly what was sent', () => {
  assert.doesNotThrow(() => assertEcho(
    { startedAfter: 1776632400000, startedBefore: 1776718800000 },
    { startedAfter: 1776632400000, startedBefore: 1776718800000, other: 'ignored' },
  ))
})

test('parseStdout finds the temp file path twg names instead of printing JSON', () => {
  const raw = [
    'output_files:',
    '  stdout: "C:/tmp/twg/stdout.json"',
    '  compact: "C:/tmp/twg/compact.json"',
  ].join('\n')
  assert.equal(parseStdout(raw).jsonPath, 'C:/tmp/twg/stdout.json')
})

test('parseStdout handles inline JSON when twg printed it directly', () => {
  const r = parseStdout('[{"id":"1"}]')
  assert.equal(r.jsonPath, null)
  assert.deepEqual(r.inline, [{ id: '1' }])
})

// --- I2: pageInfo is TOP-LEVEL in the envelope. Surfacing only meta.* left
// lib/daytotal.mjs's cursor permanently null, so its pagination loop was dead
// code and a >100-row day truncated silently. ---

test('toEnvelope surfaces a TOP-LEVEL pageInfo from a recorded response', () => {
  const fx = JSON.parse(readFileSync(new URL('./fixtures/worklog-query-page1.json', import.meta.url)))
  assert.equal(fx.meta.pageInfo, undefined, 'fixture must have pageInfo at the top level only')
  const env = toEnvelope(fx)
  assert.equal(env.pageInfo.nextCursor, 'cursor-page-2')
  assert.equal(env.meta.pagination.total, 2)
  assert.equal(env.request.startedAfter, 1788814799999)
  assert.equal(env.data.length, 1)
})

test('toEnvelope still reads a pageInfo nested under meta, if it is ever moved there', () => {
  const env = toEnvelope({ data: [], meta: { pageInfo: { nextCursor: 'c9' } } })
  assert.equal(env.pageInfo.nextCursor, 'c9')
})

test('toEnvelope wraps a bare array payload and reports no cursor', () => {
  const env = toEnvelope([{ id: '1' }])
  assert.deepEqual(env.data, [{ id: '1' }])
  assert.equal(env.pageInfo, null)
  assert.deepEqual(env.failures, [])
})
