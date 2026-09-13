import test from 'node:test'
import assert from 'node:assert/strict'

import { describeTwgFailure } from '../lib/twgstatus.mjs'

// Captured verbatim from `twg whoami` with an empty APPDATA, twg 1.2.8, exit 77.
const AUTH_REQUIRED = JSON.stringify({
  ok: false,
  error: {
    code: 'AUTH_REQUIRED',
    kind: 'twg',
    mode: 'oauth',
    statusCode: 401,
    message: 'authentication required. No valid credentials found.',
    summary: "You're not signed in. Run `twg login --force` to authenticate with your Atlassian account.",
    remediation: { command: 'twg login --force', env: ['TWG_TOKEN', 'TWG_USER'] },
  },
}, null, 2)

// The regression this whole module exists for.
test('the AUTH_REQUIRED envelope is a FAILURE, not an OK line', () => {
  const v = describeTwgFailure(77, AUTH_REQUIRED)
  assert.equal(v.ok, false)
  assert.equal(v.code, 'AUTH_REQUIRED')
})

test('the fix comes from twg itself, including the --force an author guessed wrong', () => {
  const v = describeTwgFailure(77, AUTH_REQUIRED)
  assert.equal(v.fix, 'twg login --force')
  assert.match(v.summary, /not signed in/i)
})

test('a JSON envelope is still caught when the exit code is a deceptive 0', () => {
  // Belt and braces: neither signal alone is trusted.
  const v = describeTwgFailure(0, AUTH_REQUIRED)
  assert.equal(v.ok, false)
})

test('non-zero with unparseable output fails rather than guessing a cause', () => {
  const v = describeTwgFailure(3, 'Unable to connect. Is the computer able to access the url?')
  assert.equal(v.ok, false)
  assert.match(v.summary, /exited 3/)
  assert.match(v.summary, /Unable to connect/)
  assert.equal(v.fix, null)
})

test('a process that could not be spawned is a failure, not an empty success', () => {
  const v = describeTwgFailure(null, '')
  assert.equal(v.ok, false)
  assert.equal(v.code, 'ENOENT')
})

test('exit 0 with no output is NOT success - whoami must say who', () => {
  const v = describeTwgFailure(0, '   \n  ')
  assert.equal(v.ok, false)
  assert.match(v.summary, /printed nothing/)
})

test('a real whoami passes and reports the name', () => {
  const real = '\n  Example Dev\n  Account ID:    712020:00000000-1111\n  Status:        active\n'
  const v = describeTwgFailure(0, real)
  assert.equal(v.ok, true)
  assert.equal(v.summary, 'Example Dev')
})

test('prose mentioning a brace does not get mistaken for an envelope', () => {
  const v = describeTwgFailure(0, 'signed in as { nobody }')
  assert.equal(v.ok, true)
})
