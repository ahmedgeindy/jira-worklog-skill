import test from 'node:test'
import assert from 'node:assert/strict'

import { auditFiles, summarize, ALLOWED } from './pkgaudit.mjs'

// ---------------------------------------------------------------- specimens
//
// Every value below is FAKE. They are assembled from pieces rather than written
// out so that this file contains no string that a secret scanner can match: a
// literal `ghp_...` here would be flagged by GitHub, by corporate DLP and by
// every auditor who ever clones this repo, and each of them would have to spend
// the same effort reaching the same conclusion. At runtime these are byte-identical
// to the literals they replace, so every rule below is exercised exactly as before.
//
// The AWS value is that vendor's own documented example key. The Atlassian and
// GitHub shapes are sequential alphabets. None has ever been a live credential.
const ATLASSIAN_TOKEN = `ATATT3${'xFfGF0'}abcdefghij1234567890`
const GITHUB_TOKEN = `gh${'p'}_abcdefghijklmnopqrstuvwxyz0123456789`
const AWS_KEY = `AKIA${'IOSFODNN7'}EXAMPLE`
const AWS_KEY_2 = `AKIA${'IOSFODNN7'}EXAMPLB`
const PRIVATE_KEY_HEADER = `-----BEGIN ${'RSA'} PRIVATE KEY-----`
const BEARER = `Bearer ${'TESTVECTOR_REDACTED'}.abcdefghijkl`
const CLIENT_SECRET_LINE = `"client${'_'}secret": "TESTVECTOR_REDACTED"`
const PASSWORD_LINE = `pass${'word'}=TESTVECTOR_REDACTED`

// Synthetic stand-ins for real data that used to sit here. The rules match the
// SHAPE, so a fabricated account id and address prove exactly as much as the
// author's own did -- and this file is not the place to keep either.
const ACCOUNT_ID = '712020:11111111-2222-3333-4444-555555555555'
const CLOUD_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

// The org name IS the thing internal-host and internal-org match, so it cannot be
// swapped for a placeholder without the test ceasing to test anything. Assembled
// at runtime for the same reason as the specimens above.
const ORG = `ist${'networks'}`
const INTERNAL_HOST = `${ORG}-dev.atlassian.net`
const INTERNAL_EMAIL = `a.person@${ORG}.com`

const scan = (text, opts) => auditFiles([{ path: 'f.mjs', text }], opts)
const ids = (text, opts) => scan(text, opts).map((f) => f.id)

// ---------------------------------------------------------------- positive controls
//
// These are the tests that matter. A scanner nobody has watched fail is not
// evidence of anything, so each ban has a planted example proving it fires.

test('an Atlassian API token is caught', () => {
  assert.ok(ids(`const t = "${ATLASSIAN_TOKEN}"`).includes('atlassian-token'))
})

test('a bearer header is caught', () => {
  assert.ok(ids(`Authorization: ${BEARER}`).includes('bearer'))
})

test('a private key block is caught', () => {
  assert.ok(ids(PRIVATE_KEY_HEADER).includes('private-key'))
})

test('an AWS key id is caught', () => {
  assert.ok(ids(AWS_KEY).includes('aws-key'))
})

test('a GitHub and an npm token are caught', () => {
  assert.ok(ids(GITHUB_TOKEN).includes('vendor-token'))
  assert.ok(ids('TESTVECTOR_REDACTED').includes('vendor-token'))
})

test('a secret assigned to a key is caught', () => {
  assert.ok(ids(CLIENT_SECRET_LINE).includes('assigned-secret'))
  assert.ok(ids(PASSWORD_LINE).includes('assigned-secret'))
})

test('a real-looking Jira accountId is caught', () => {
  assert.ok(ids('"accountId": "a1b2c3d4e5f60718293a4b5c"').includes('jira-account-id'))
})

test('a real Atlassian account uuid is caught', () => {
  assert.ok(ids(ACCOUNT_ID).includes('atlassian-uuid-account'))
})

test('a cloud id is caught', () => {
  assert.ok(ids('00000000-0000-0000-0000-000000000000').includes('cloud-uuid'))
})

test('a real email address is caught', () => {
  assert.ok(ids(`contact ${INTERNAL_EMAIL} for access`).includes('email'))
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
  assert.ok(ids(`https://${INTERNAL_HOST}/browse/X-1`, sev).includes('internal-host'))
  assert.ok(ids(`the ${ORG} tenant`, sev).includes('internal-org'))
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
  const text = `https://${INTERNAL_HOST}/browse/PROJ-223 :: STC-BH sync`
  const priv = ids(text, { severities: ['secret', 'pii', 'internal'] })
  assert.deepEqual(priv, [], 'private mode must not flag org strings')

  const pub = ids(text, { severities: ['secret', 'pii', 'internal', 'org'] })
  assert.ok(pub.includes('internal-host'))
  assert.ok(pub.includes('internal-issue-key'))
  assert.ok(pub.includes('customer-name'))
})

test('a secret is fatal in BOTH modes - severity tiers never excuse a credential', () => {
  const text = ATLASSIAN_TOKEN
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
  const two = `${AWS_KEY} and ${AWS_KEY_2}`
  assert.equal(scan(two).filter((f) => f.id === 'aws-key').length, 2)
})

test('rule state does not leak between files', () => {
  const findings = auditFiles([
    { path: 'a.mjs', text: AWS_KEY },
    { path: 'b.mjs', text: AWS_KEY },
  ])
  assert.equal(findings.filter((f) => f.id === 'aws-key').length, 2)
  assert.deepEqual(findings.map((f) => f.path).sort(), ['a.mjs', 'b.mjs'])
})

test('findings carry a line number that points at the hit', () => {
  const [f] = scan(`line one\nline two\n${AWS_KEY}\n`)
  assert.equal(f.line, 3)
})

test('summarize groups by rule and puts secrets first', () => {
  const groups = summarize(auditFiles([
    { path: 'a', text: INTERNAL_HOST },
    { path: 'b', text: AWS_KEY },
  ], { severities: ['secret', 'pii', 'internal', 'org'] }))
  assert.equal(groups[0].severity, 'secret')
})

// ------------------------------------------------- unknown issue-key prefixes
//
// Regression pair for the THIRD false green in this scanner (2026-09-14).
// `audit:public` printed "CLEAN ... and no org-identifying strings / 46 files
// cleared for publication" while references/twg-worklog-contract.md -- a file
// inside the `files` whitelist -- carried PROJ-3234 three times, plus CXOPS,
// K2227759, U2633237 and EAK21GEOO keys. The rule listed the one prefix that had
// caused trouble before, so it only ever knew about leaks somebody had already
// found. The test is now inverted: an unrecognised prefix is a finding.

test('an issue key with an unrecognised prefix is caught', () => {
  const sev = { severities: ['org'] }
  assert.ok(ids('see ACMECORP-4242 for details', sev).includes('unknown-issue-key'))
  assert.ok(ids('ZZTOP-7', sev).includes('unknown-issue-key'))
})

test('the specific prefixes that shipped under a CLEAN verdict are all caught now', () => {
  // Each of these sat in a shipped file while the audit reported no org strings.
  const sev = { severities: ['org'] }
  for (const key of ['PROJ-3234', 'PROJ-17', 'PROJ-1', 'PROJ-141', 'PROJ-39', 'PROJ-281']) {
    const found = ids(`worklog query --issue-id ${key}`, sev)
    assert.ok(
      found.includes('unknown-issue-key') || found.includes('internal-issue-key'),
      `${key} must be caught, got ${JSON.stringify(found)}`,
    )
  }
})

test('the placeholder keys this package uses in its own docs are NOT flagged', () => {
  // The rule has to stay usable: if PROJ-323 tripped it, every example in SKILL.md
  // would be a finding and the whole check would get switched off.
  const sev = { severities: ['org'] }
  for (const key of ['PROJ-323', 'YOUR-123', 'TEST-1', 'EXAMPLE-99', 'ACME-5']) {
    assert.equal(
      ids(`log 3h on ${key}`, sev).includes('unknown-issue-key'), false,
      `${key} must not be flagged`,
    )
  }
})

test('standards identifiers sharing the shape are not flagged', () => {
  const sev = { severities: ['org'] }
  for (const s of ['CVE-2024', 'RFC-3339', 'ISO-8601', 'SHA-256', 'UTF-8']) {
    assert.equal(ids(s, sev).includes('unknown-issue-key'), false, `${s} must not be flagged`)
  }
})

test('a key inside a character class is not read as an issue key', () => {
  // `[A-Z0-9]` in this package's own regex source contains the substring 'Z0-9'.
  // Without the lookbehind the scanner reports its own rule file as a leak.
  const sev = { severities: ['org'] }
  assert.equal(ids('const re = /[A-Z0-9]-\\d+/g', sev).includes('unknown-issue-key'), false)
})

test('the widened internal-issue-key rule covers HIVEDEV as well as HCFM', () => {
  const sev = { severities: ['org'] }
  assert.ok(ids('PROJ-223', sev).includes('internal-issue-key'))
  assert.ok(ids('PROJ-3234', sev).includes('internal-issue-key'))
  // and still with no word-boundary anchor, which was the SECOND false green
  assert.ok(ids('\tPROJ-223', sev).includes('internal-issue-key'))
  assert.ok(ids('key%3DPROJ-3234', sev).includes('internal-issue-key'))
})
