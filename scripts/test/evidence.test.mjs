// skills/jira-worklog/scripts/test/evidence.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { redact, changelogEvidence } from '../lib/evidence.mjs'

test('a line naming a password is DROPPED, not masked', () => {
  assert.equal(redact('Postgres pwd (app_admin) exposed; rotation req\'d'), null)
  assert.equal(redact('set PASSWORD=hunter2'), null)
  assert.equal(redact('token: abc123'), null)
  assert.equal(redact('PAT embedded in clone url'), null)
})

test('an IPv4 address is dropped', () => {
  assert.equal(redact('deployed to 107.22.24.149 ok'), null)
})

test('a 40-char hex SHA is NOT a credential and survives', () => {
  const line = 'fixed in da681292c0000000000000000000000000000000'
  assert.equal(redact(line), line)
})

test('ordinary prose survives untouched', () => {
  assert.equal(redact('reviewed the migrator PR and fixed the parity check'), 'reviewed the migrator PR and fixed the parity check')
})

test('changelog evidence keeps only MY entries on the target day', () => {
  const ME = 'me-123'
  const deps = {
    run: () => ({
      exit: 0, failures: [], meta: null,
      data: {
        values: [
          { author: { accountId: ME }, created: '2026-09-08T11:00:00.000+0300', items: [{ field: 'status', toString: 'In Progress' }] },
          { author: { accountId: 'other' }, created: '2026-09-08T12:00:00.000+0300', items: [{ field: 'status', toString: 'Done' }] },
          { author: { accountId: ME }, created: '2026-09-07T11:00:00.000+0300', items: [{ field: 'status', toString: 'To Do' }] },
        ],
      },
    }),
  }
  const ev = changelogEvidence({ key: 'PROJ-323', isoDate: '2026-09-08', accountId: ME, zone: 'Asia/Riyadh', deps })
  assert.equal(ev.length, 1)
  assert.match(ev[0].fragment, /In Progress/)
  assert.equal(ev[0].source, 'jira-changelog')
})

test('changelog evidence is empty rather than throwing when the API is unavailable', () => {
  const deps = { run: () => { throw new Error('401 scope does not match') } }
  assert.deepEqual(changelogEvidence({ key: 'X-1', isoDate: '2026-09-08', accountId: 'me', zone: 'Asia/Riyadh', deps }), [])
})
