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

// --- task-14 Fix B: an optional user-supplied comment, introduced by ' :: '.
// The hours token still sits between the key and the separator. ---

test('a :: separator carries a user-supplied comment; hours still sit before it', () => {
  const r = parseLine('PROJ-323 3h :: reviewed the migrator PR and fixed the parity check')
  assert.equal(r.key, 'PROJ-323')
  assert.equal(r.seconds, 10800)
  assert.equal(r.hoursSource, 'stated')
  assert.equal(r.comment, 'reviewed the migrator PR and fixed the parity check')
})

test('a URL line with :: still resolves the key/host and carries the comment', () => {
  const r = parseLine('https://example.atlassian.net/browse/PROJ-345 2h :: paired on the fix with Sam')
  assert.equal(r.key, 'PROJ-345')
  assert.equal(r.host, 'example.atlassian.net')
  assert.equal(r.seconds, 7200)
  assert.equal(r.comment, 'paired on the fix with Sam')
})

test('a line with no :: carries comment: null, not undefined or empty string', () => {
  const r = parseLine('PROJ-323 3h')
  assert.equal(r.comment, null)
})

test('an empty comment after :: is refused rather than silently treated as none', () => {
  assert.throws(() => parseLine('PROJ-323 3h :: '), /comment/i)
  assert.throws(() => parseLine('PROJ-323 3h ::   '), /comment/i)
})

// --- Feature 1: an optional explicit '@HH:MM' start time, sitting after the
// hours and before any ' :: ' comment. ---

test('an @HH:MM start time is parsed into startAt, and does not leak into hours', () => {
  const r = parseLine('PROJ-345 1h @11:00 :: daily standup')
  assert.equal(r.key, 'PROJ-345')
  assert.equal(r.seconds, 3600)
  assert.equal(r.startAt, '11:00')
  assert.equal(r.comment, 'daily standup')
})

test('@HH:MM works with decimal hours and no comment', () => {
  const r = parseLine('PROJ-345 2.5h @13:00')
  assert.equal(r.seconds, 9000)
  assert.equal(r.startAt, '13:00')
  assert.equal(r.comment, null)
})

test('a line with no @ carries startAt: null, not undefined', () => {
  const r = parseLine('PROJ-324 8h :: development work')
  assert.equal(r.startAt, null)
  assert.equal(r.seconds, 28800)
})

test('a line with no hours at all still yields startAt: null alongside seconds: null', () => {
  const r = parseLine('PROJ-323')
  assert.equal(r.startAt, null)
  assert.equal(r.seconds, null)
})

test('@HH:MM glued directly onto the hours token with no separating space is still caught', () => {
  // A per-token '@' scan would see '1h@11:00' as a single token starting with
  // '1', never notice the '@', and let parseHours's word-boundary match
  // silently consume just the '1h' - dropping the start time with no error at
  // all. This must be refused-or-parsed the same as the spaced form, never
  // silently ignored.
  const r = parseLine('PROJ-345 1h@11:00 :: daily standup')
  assert.equal(r.seconds, 3600)
  assert.equal(r.startAt, '11:00')
})

test('the boundary values 00:00 and 23:59 are valid start times', () => {
  assert.equal(parseLine('PROJ-323 1h @00:00').startAt, '00:00')
  assert.equal(parseLine('PROJ-323 1h @23:59').startAt, '23:59')
})

test('24:00 is refused: it parses as midnight the NEXT Jira day downstream', () => {
  // Same trap lib/tz.mjs#startedString guards against for the sequenced case;
  // an explicit start time must be bound by the identical reasoning.
  assert.throws(() => parseLine('PROJ-323 1h @24:00'), /invalid @HH:MM|00:00-23:59/i)
})

test('an out-of-range or malformed @ value is refused with a clear message, not silently mis-parsed', () => {
  assert.throws(() => parseLine('PROJ-323 1h @25:00'), /invalid @HH:MM/i)
  assert.throws(() => parseLine('PROJ-323 1h @9:00'), /invalid @HH:MM/i) // single-digit hour: not HH:MM
  assert.throws(() => parseLine('PROJ-323 1h @11:5'), /invalid @HH:MM/i) // single-digit minute
  assert.throws(() => parseLine('PROJ-323 1h @not-a-time'), /invalid @HH:MM/i)
})

test('more than one @HH:MM token on a line is refused rather than picking one', () => {
  assert.throws(() => parseLine('PROJ-323 1h @11:00 @13:00'), /only one @HH:MM/i)
})

test('a bare trailing @ with nothing after it is refused, not silently dropped', () => {
  assert.throws(() => parseLine('PROJ-323 3h @'), /invalid @HH:MM/i)
})

// --- A colon means the clock form and NOTHING else.
// '7:30h' used to fall through to the h/m scanner, which matched '30h' and
// returned 30 hours for a line a human wrote meaning 7h30m. Exit 0, plausible
// number, four times the intended time. Found from a real prompt. ---

test('7:30h is 7.5h, not 30h - a trailing unit must not defeat the clock form', () => {
  assert.equal(parseHours('7:30h'), 27000)
  assert.equal(parseHours('7:30 h'), 27000)
  assert.equal(parseHours('07:30h'), 27000)
})

test('the plain clock form still works and agrees with every other spelling of 7.5h', () => {
  const want = 27000
  for (const s of ['7:30', '7.5h', '7h 30m', '450m', '7:30h']) {
    assert.equal(parseHours(s), want, `${s} should be ${want}s`)
  }
})

test('a colon with a nonsense unit is refused rather than guessed', () => {
  assert.throws(() => parseHours('7:30m'), /cannot parse|clock/i)
  assert.throws(() => parseHours('7:30x'), /cannot parse|clock/i)
})

test('an out-of-range clock value is still refused, with or without the trailing h', () => {
  assert.throws(() => parseHours('7:60'), /cannot parse|clock/i)
  assert.throws(() => parseHours('7:60h'), /cannot parse|clock/i)
  assert.throws(() => parseHours('7:5h'), /cannot parse|clock/i)
})
