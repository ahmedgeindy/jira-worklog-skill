// skills/jira-worklog/scripts/test/identity.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveIdentity, assertAccountId } from '../lib/identity.mjs'

const MYSELF = {
  accountId: '712020:862ee292-a94d-488e-9f54-f5cb50dfd07b',
  emailAddress: 'ahmed.genidy@istnetworks.com',
  displayName: 'Ahmed Genidy',
  timeZone: 'Asia/Riyadh',
}

test('identity comes from /myself, which carries the IANA zone', () => {
  const calls = []
  const fakeRun = (argv) => { calls.push(argv); return { exit: 0, data: MYSELF, failures: [], meta: null } }
  const id = resolveIdentity({ run: fakeRun })
  assert.equal(id.accountId, MYSELF.accountId)
  assert.equal(id.zone, 'Asia/Riyadh')
  assert.equal(calls.length, 1)
})

test('identity is NEVER derived from a worklog query', () => {
  const fakeRun = (argv) => {
    assert.equal(argv.includes('worklog'), false, 'identity must not read worklogs')
    return { exit: 0, data: MYSELF, failures: [], meta: null }
  }
  resolveIdentity({ run: fakeRun })
})

test('a bare offset instead of an IANA name is REFUSED, not accepted', () => {
  const fakeRun = () => ({ exit: 0, data: { ...MYSELF, timeZone: '+03:00' }, failures: [], meta: null })
  assert.throws(() => resolveIdentity({ run: fakeRun }), /IANA/i)
})

test('a missing timeZone aborts rather than defaulting', () => {
  const fakeRun = () => ({ exit: 0, data: { accountId: 'x' }, failures: [], meta: null })
  assert.throws(() => resolveIdentity({ run: fakeRun }), /timeZone/i)
})

test('assertAccountId catches a filter using the wrong identity', () => {
  assert.throws(() => assertAccountId('someone-else', MYSELF.accountId), /accountId/i)
  assert.doesNotThrow(() => assertAccountId(MYSELF.accountId, MYSELF.accountId))
})
