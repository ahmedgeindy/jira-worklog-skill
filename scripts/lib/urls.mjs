// Pasted line -> {host, key, seconds, hoursSource}. Pure: no I/O.

const KEY_RE = /\b([A-Za-z][A-Za-z0-9]*-\d+)\b/

/**
 * Hours as a human types them -> seconds.
 * d/w units are REFUSED: on this site 1d = 8h = 28800s, not 24h, and a silent
 * misreading of that is a 3x timesheet error.
 */
export function parseHours(text) {
  const s = String(text ?? '').trim().toLowerCase()
  if (!s) throw new Error('cannot parse hours from an empty value')
  if (/\d\s*[dw]\b/.test(s)) {
    throw new Error(`d/w units are not supported (1d is 8h here, not 24h); use hours or minutes: ${text}`)
  }

  const clock = /^(\d+):([0-5]\d)$/.exec(s)
  if (clock) return Number(clock[1]) * 3600 + Number(clock[2]) * 60

  let seconds = 0
  let matched = false
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)\s*(h|m)\b/g)) {
    matched = true
    seconds += Number(m[1]) * (m[2] === 'h' ? 3600 : 60)
  }
  if (matched) return Math.round(seconds)

  // bare number means HOURS
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 3600)

  throw new Error(`cannot parse hours from ${JSON.stringify(text)}`)
}

function extractKey(token) {
  const noFragment = String(token).split('#')[0]
  let host = null
  let path = noFragment
  let query = ''

  if (/^https?:\/\//i.test(noFragment)) {
    let u
    try {
      u = new URL(noFragment)
    } catch {
      return { host: null, key: null }
    }
    host = u.host
    path = u.pathname
    query = decodeURIComponent(u.search)
  }

  // PATH wins. A poisoned '?jql=key=PROJ-999' must never beat '/browse/PROJ-323'.
  const fromPath = KEY_RE.exec(path)
  if (fromPath) return { host, key: fromPath[1].toUpperCase() }

  const fromQuery = /selectedIssue=([A-Za-z][A-Za-z0-9]*-\d+)/.exec(query)
  if (fromQuery) return { host, key: fromQuery[1].toUpperCase() }

  return { host, key: null }
}

// ' :: ' (space colon colon space) introduces an optional user-supplied
// comment (task-14 Fix B). The hours token still sits between the key and the
// separator: 'PROJ-323 3h :: reviewed the migrator PR and fixed the parity check'.
//
// Searched for on the RAW (not fully-trimmed) line deliberately: trimming the
// whole line first would eat a trailing ' :: ' with nothing after it, so a
// human who typed the separator and then left the comment blank would get
// silent "no comment" instead of a clear refusal.
const COMMENT_SEP = ' :: '

/** 'https://.../browse/PROJ-323 2h' -> {host, key, seconds, hoursSource, comment} */
export function parseLine(line) {
  const raw = String(line ?? '')
  if (!raw.trim()) throw new Error('cannot parse an empty line')

  const sepIndex = raw.indexOf(COMMENT_SEP)
  let comment = null
  let head = raw
  if (sepIndex !== -1) {
    head = raw.slice(0, sepIndex)
    comment = raw.slice(sepIndex + COMMENT_SEP.length).trim()
    if (!comment) throw new Error('empty comment after the :: separator')
  }
  head = head.trim()

  const [token, ...rest] = head.split(/\s+/)
  const { host, key } = extractKey(token)
  if (!key) throw new Error(`no issue key found in ${JSON.stringify(token)}`)

  const hoursText = rest.join(' ').trim()
  if (!hoursText) return { host, key, seconds: null, hoursSource: 'derived', comment }
  return { host, key, seconds: parseHours(hoursText), hoursSource: 'stated', comment }
}
