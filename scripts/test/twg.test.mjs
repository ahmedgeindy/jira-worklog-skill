import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertArgvSafe, assertEcho, parseStdout } from '../lib/twg.mjs'

test('a normal read argv passes', () => {
  assert.doesNotThrow(() => assertArgvSafe(
    ['jira', 'workitem', 'worklog', 'query', '--issue-id', 'PROJ-323', '-o', 'json'],
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
