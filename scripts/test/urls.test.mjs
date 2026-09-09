import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseLine, parseHours } from '../lib/urls.mjs'

test('parseHours understands the formats a human types', () => {
  assert.equal(parseHours('3h'), 10800)
  assert.equal(parseHours('2.5h'), 9000)
  assert.equal(parseHours('90m'), 5400)
  assert.equal(parseHours('1h 30m'), 5400)
  assert.equal(parseHours('1:30'), 5400)
  assert.equal(parseHours('7'), 25200)
})

test('parseHours rejects d/w units outright', () => {
  assert.throws(() => parseHours('1d'), /not supported/i)
  assert.throws(() => parseHours('1w'), /not supported/i)
})

test('parseHours rejects nonsense rather than defaulting', () => {
  assert.throws(() => parseHours(''), /cannot parse/i)
  assert.throws(() => parseHours('soon'), /cannot parse/i)
})

test('path key beats a poisoned query-string key', () => {
  const r = parseLine('https://example.atlassian.net/browse/PROJ-323?jql=key%3DPROJ-999 2h')
  assert.equal(r.key, 'PROJ-323')
  assert.equal(r.host, 'example.atlassian.net')
  assert.equal(r.seconds, 7200)
})

test('board URL with selectedIssue is accepted via the query string', () => {
  const r = parseLine('https://example.atlassian.net/jira/software/c/projects/HCFM/boards/12?selectedIssue=PROJ-345 1h')
  assert.equal(r.key, 'PROJ-345')
})

test('a bare lowercase key is normalised and carries no host', () => {
  const r = parseLine('PROJ-323 4h')
  assert.equal(r.key, 'PROJ-323')
  assert.equal(r.host, null)
})

test('fragments are stripped', () => {
  assert.equal(parseLine('https://x.atlassian.net/browse/PROJ-323#icft=PROJ-323 1h').key, 'PROJ-323')
})

test('a foreign host is preserved so the caller can assert against the resolved site', () => {
  const r = parseLine('https://someothercorp.atlassian.net/browse/PROJ-345 1h')
  assert.equal(r.host, 'someothercorp.atlassian.net')
})

test('a line with no hours yields seconds null and hoursSource derived', () => {
  const r = parseLine('PROJ-323')
  assert.equal(r.seconds, null)
  assert.equal(r.hoursSource, 'derived')
})

test('an unresolvable line throws rather than guessing', () => {
  assert.throws(() => parseLine('https://example.com/nothing-here 2h'), /no issue key/i)
})
