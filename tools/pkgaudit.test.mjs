import test from 'node:test'
import assert from 'node:assert/strict'

import { auditFiles, summarize, ALLOWED } from './pkgaudit.mjs'

const scan = (text, opts) => auditFiles([{ path: 'f.mjs', text }], opts)
const ids = (text, opts) => scan(text, opts).map((f) => f.id)

// ---------------------------------------------------------------- positive controls
//
// These are the tests that matter. A scanner nobody has watched fail is not
// evidence of anything, so each ban has a planted example proving it fires.

test('an Atlassian API token is caught', () => {
  assert.ok(ids('const t = "TESTVECTOR_REDACTED"').includes('atlassian-token'))
})

test('a bearer header is caught', () => {
  assert.ok(ids('Authorization: Bearer TESTVECTOR_REDACTED').includes('bearer'))
})

test('a private key block is caught', () => {
  assert.ok(ids('TESTVECTOR_REDACTED_KEY_MARKER').includes('private-key'))
})

test('an AWS key id is caught', () => {
  assert.ok(ids('TESTVECTOR_REDACTED').includes('aws-key'))
})

test('a GitHub and an npm token are caught', () => {
  assert.ok(ids('TESTVECTOR_REDACTED').includes('vendor-token'))
  assert.ok(ids('TESTVECTOR_REDACTED').includes('vendor-token'))
})

test('a secret assigned to a key is caught', () => {
  assert.ok(ids('"client_secret": "TESTVECTOR_REDACTED"').includes('assigned-secret'))
  assert.ok(ids('password=TESTVECTOR_REDACTED').includes('assigned-secret'))
})

test('a real-looking Jira accountId is caught', () => {
  assert.ok(ids('"accountId": "a1b2c3d4e5f60718293a4b5c"').includes('jira-account-id'))
})

test('a real Atlassian account uuid is caught', () => {
  assert.ok(ids('712020:00000000-1111-2222-3333-444444444444').includes('atlassian-uuid-account'))
})

test('a cloud id is caught', () => {
  assert.ok(ids('00000000-0000-0000-0000-000000000000').includes('cloud-uuid'))
})

test('a real email address is caught', () => {
  assert.ok(ids('contact dev@example.com for access').includes('email'))
})

test('.remember data and a local path are caught', () => {
  assert.ok(ids('see .remember/today-2026-09-13.md').includes('remember-data'))
  assert.ok(ids('F:\\ISt\\HiveFormbricks\\thing').includes('local-path'))
  assert.ok(ids('/home/agdev/secrets').includes('local-path'))
})

test('an unrelated repo name is caught', () => {
  assert.ok(ids('hivecfm-workspace/skills').includes('workspace-repo'))
})

// ---------------------------------------------------------------- the org tier

test('the strings removed in the public scrub are all detectable', () => {
  // Positive controls for the scrub itself. Without these, "audit:public is CLEAN"
  // only says nobody has pasted a real example back in *that the old rules knew about*.
  const sev = { severities: ['secret', 'pii', 'internal', 'org'] }
  assert.ok(ids('https://example.atlassian.net/browse/X-1', sev).includes('internal-host'))
  assert.ok(ids('the istnetworks tenant', sev).includes('internal-org'))
  assert.ok(ids('logged 2h on PROJ-223', sev).includes('internal-issue-key'))
  assert.ok(ids('the HiveCFM migrator', sev).includes('internal-product'))
  assert.ok(ids('hive-cfm core', sev).includes('internal-product'))
  assert.ok(ids('source DB ISTServiceEdge', sev).includes('internal-product'))
})

test('an issue key is caught even without a word boundary before it', () => {
  // The regression that made audit:public report CLEAN with four real keys still in
  // the package. Both the scrubber and this rule anchored on \b, and in '\tPROJ-223'
  // and 'key%3DPROJ-999' the preceding character is a word character, so no boundary
  // exists. Two checks sharing one assumption are one check.
  const sev = { severities: ['org'] }
  assert.ok(ids('\\tPROJ-223 7.5h', sev).includes('internal-issue-key'), 'after \\t escape')
  assert.ok(ids('?jql=key%3DPROJ-999', sev).includes('internal-issue-key'), 'after %3D')
  assert.ok(ids('xPROJ-1', sev).includes('internal-issue-key'), 'glued to a letter')
  assert.ok(ids('see PROJ-42 please', sev).includes('internal-issue-key'), 'lowercase')
})

test('the synthetic replacements the scrub introduced are clean', () => {
  const sev = { severities: ['secret', 'pii', 'internal', 'org'] }
  assert.deepEqual(ids('https://example.atlassian.net/browse/PROJ-323 2h', sev), [])
  assert.deepEqual(ids('proj-323 normalises to PROJ-323', sev), [])
  assert.deepEqual(ids('Development - data import tool', sev), [])
  assert.deepEqual(ids('Postgres pwd (app_admin) exposed', sev), [])
})

test('org-identifying strings are found but are NOT reported in private mode', () => {
  const text = 'https://example.atlassian.net/browse/PROJ-223 :: STC-BH sync'
  const priv = ids(text, { severities: ['secret', 'pii', 'internal'] })
  assert.deepEqual(priv, [], 'private mode must not flag org strings')

  const pub = ids(text, { severities: ['secret', 'pii', 'internal', 'org'] })
  assert.ok(pub.includes('internal-host'))
  assert.ok(pub.includes('internal-issue-key'))
  assert.ok(pub.includes('customer-name'))
})

test('a secret is fatal in BOTH modes - severity tiers never excuse a credential', () => {
  const text = 'TESTVECTOR_REDACTED'
  assert.ok(ids(text, { severities: ['secret', 'pii', 'internal'] }).includes('atlassian-token'))
  assert.ok(ids(text, { severities: ['secret'] }).includes('atlassian-token'))
})

// ---------------------------------------------------------------- negative controls
//
// A scanner that flags its own placeholders gets muted by whoever runs it next.

test('the deliberate placeholders do not trip anything', () => {
  for (const placeholder of ALLOWED) {
    assert.deepEqual(ids(`value: ${placeholder}`), [], `${placeholder} must not be flagged`)
  }
})

test('the redacted fixture values are clean', () => {
  const redacted = '{"accountId":"aaaaaaaaaaaaaaaaaaaaaaaa","displayName":"Another Teammate"}'
  assert.deepEqual(ids(redacted), [])
})

test('ordinary skill prose is clean', () => {
  assert.deepEqual(ids('Run `twg whoami` and check the account id it prints.'), [])
})

// ---------------------------------------------------------------- mechanics

test('a global rule reports EVERY occurrence, not just the first', () => {
  const two = 'TESTVECTOR_REDACTED and TESTVECTOR_REDACTED2'
  assert.equal(scan(two).filter((f) => f.id === 'aws-key').length, 2)
})

test('rule state does not leak between files', () => {
  const findings = auditFiles([
    { path: 'a.mjs', text: 'TESTVECTOR_REDACTED' },
    { path: 'b.mjs', text: 'TESTVECTOR_REDACTED' },
  ])
  assert.equal(findings.filter((f) => f.id === 'aws-key').length, 2)
  assert.deepEqual(findings.map((f) => f.path).sort(), ['a.mjs', 'b.mjs'])
})

test('findings carry a line number that points at the hit', () => {
  const [f] = scan('line one\nline two\nTESTVECTOR_REDACTED\n')
  assert.equal(f.line, 3)
})

test('summarize groups by rule and puts secrets first', () => {
  const groups = summarize(auditFiles([
    { path: 'a', text: 'https://example.atlassian.net' },
    { path: 'b', text: 'TESTVECTOR_REDACTED' },
  ], { severities: ['secret', 'pii', 'internal', 'org'] }))
  assert.equal(groups[0].severity, 'secret')
})
