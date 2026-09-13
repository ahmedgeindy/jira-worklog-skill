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
  assert.ok(ids('const t = "ATATT3xFfGF0abcdefghij1234567890"').includes('atlassian-token'))
})

test('a bearer header is caught', () => {
  assert.ok(ids('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abcdefghijkl').includes('bearer'))
})

test('a private key block is caught', () => {
  assert.ok(ids('-----BEGIN RSA PRIVATE KEY-----').includes('private-key'))
})

test('an AWS key id is caught', () => {
  assert.ok(ids('AKIAIOSFODNN7EXAMPLE').includes('aws-key'))
})

test('a GitHub and an npm token are caught', () => {
  assert.ok(ids('ghp_abcdefghijklmnopqrstuvwxyz0123456789').includes('vendor-token'))
  assert.ok(ids('npm_abcdefghijklmnopqrstuvwxyz0123456789').includes('vendor-token'))
})

test('a secret assigned to a key is caught', () => {
  assert.ok(ids('"client_secret": "s3cr3t-value-long-enough"').includes('assigned-secret'))
  assert.ok(ids('password=hunter2hunter2hunter2').includes('assigned-secret'))
})

test('a real-looking Jira accountId is caught', () => {
  assert.ok(ids('"accountId": "604f241d06cbba006ad6517c"').includes('jira-account-id'))
})

test('a real Atlassian account uuid is caught', () => {
  assert.ok(ids('712020:862ee292-a94d-488e-9f54-f5cb50dfd07b').includes('atlassian-uuid-account'))
})

test('a cloud id is caught', () => {
  assert.ok(ids('11ba363a-dd30-4170-8717-8c2be7b91130').includes('cloud-uuid'))
})

test('a real email address is caught', () => {
  assert.ok(ids('contact ahmed.genidy@istnetworks.com for access').includes('email'))
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
  assert.ok(ids('https://istnetworks-dev.atlassian.net/browse/X-1', sev).includes('internal-host'))
  assert.ok(ids('the istnetworks tenant', sev).includes('internal-org'))
  assert.ok(ids('logged 2h on HCFM-223', sev).includes('internal-issue-key'))
  assert.ok(ids('the HiveCFM migrator', sev).includes('internal-product'))
  assert.ok(ids('hive-cfm core', sev).includes('internal-product'))
  assert.ok(ids('source DB ISTServiceEdge', sev).includes('internal-product'))
})

test('the synthetic replacements the scrub introduced are clean', () => {
  const sev = { severities: ['secret', 'pii', 'internal', 'org'] }
  assert.deepEqual(ids('https://example.atlassian.net/browse/PROJ-323 2h', sev), [])
  assert.deepEqual(ids('proj-323 normalises to PROJ-323', sev), [])
  assert.deepEqual(ids('Development - data import tool', sev), [])
  assert.deepEqual(ids('Postgres pwd (app_admin) exposed', sev), [])
})

test('org-identifying strings are found but are NOT reported in private mode', () => {
  const text = 'https://istnetworks-dev.atlassian.net/browse/HCFM-223 :: STC-BH sync'
  const priv = ids(text, { severities: ['secret', 'pii', 'internal'] })
  assert.deepEqual(priv, [], 'private mode must not flag org strings')

  const pub = ids(text, { severities: ['secret', 'pii', 'internal', 'org'] })
  assert.ok(pub.includes('internal-host'))
  assert.ok(pub.includes('internal-issue-key'))
  assert.ok(pub.includes('customer-name'))
})

test('a secret is fatal in BOTH modes - severity tiers never excuse a credential', () => {
  const text = 'ATATT3xFfGF0abcdefghij1234567890'
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
  const two = 'AKIAIOSFODNN7EXAMPLE and AKIAIOSFODNN7EXAMPLB'
  assert.equal(scan(two).filter((f) => f.id === 'aws-key').length, 2)
})

test('rule state does not leak between files', () => {
  const findings = auditFiles([
    { path: 'a.mjs', text: 'AKIAIOSFODNN7EXAMPLE' },
    { path: 'b.mjs', text: 'AKIAIOSFODNN7EXAMPLE' },
  ])
  assert.equal(findings.filter((f) => f.id === 'aws-key').length, 2)
  assert.deepEqual(findings.map((f) => f.path).sort(), ['a.mjs', 'b.mjs'])
})

test('findings carry a line number that points at the hit', () => {
  const [f] = scan('line one\nline two\nAKIAIOSFODNN7EXAMPLE\n')
  assert.equal(f.line, 3)
})

test('summarize groups by rule and puts secrets first', () => {
  const groups = summarize(auditFiles([
    { path: 'a', text: 'https://istnetworks-dev.atlassian.net' },
    { path: 'b', text: 'AKIAIOSFODNN7EXAMPLE' },
  ], { severities: ['secret', 'pii', 'internal', 'org'] }))
  assert.equal(groups[0].severity, 'secret')
})
