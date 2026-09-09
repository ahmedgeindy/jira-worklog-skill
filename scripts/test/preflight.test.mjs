import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkContract, REQUIRED_ADD_FLAGS } from '../lib/version.mjs'

test('REQUIRED_ADD_FLAGS lists exactly the five mandatory flags', () => {
  assert.deepEqual([...REQUIRED_ADD_FLAGS].sort(), [
    '--adjust-estimate', '--comment-format', '--notify-users',
    '--started', '--time-spent-seconds',
  ])
})

test('checkContract passes when help text mentions every required flag', () => {
  const help = REQUIRED_ADD_FLAGS.join(' ') + ' --comment --expand'
  assert.deepEqual(checkContract(help), { ok: true, missing: [] })
})

test('checkContract reports the flags that vanished', () => {
  const help = '--started --comment --time-spent'
  const r = checkContract(help)
  assert.equal(r.ok, false)
  assert.deepEqual(r.missing.sort(), ['--adjust-estimate', '--comment-format', '--notify-users', '--time-spent-seconds'])
})

test('checkContract does not accept --time-spent as --time-spent-seconds', () => {
  assert.equal(checkContract('--time-spent').missing.includes('--time-spent-seconds'), true)
})
