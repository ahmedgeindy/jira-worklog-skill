// skills/jira-worklog/scripts/lib/plan.mjs
import { createHash } from 'node:crypto'
import { startedString } from './tz.mjs'

const DAY_START_SECONDS = 9 * 3600

function hms(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  const s = totalSeconds % 60
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':')
}

/**
 * Sequence entries from 09:00 by cumulative planned duration.
 * Stacking every entry at 09:00 asserts simultaneous work sessions; 09:00 also
 * keeps every entry far from both exclusive filter bounds and from midnight.
 *
 * At >= 15h cumulative the cursor reaches 24:00:00, which startedString would
 * happily format as `2026-09-08T24:00:00.000+0300` — a string that PARSES as
 * 00:00 the NEXT Jira day, lands the worklog on the wrong date, and slips past
 * assertNotFuture because it is still in the past. Refuse it here with a domain
 * error rather than emitting a plausible-looking wrong day.
 */
export function sequenceStarts(zone, isoDate, entries) {
  let cursor = 0
  return entries.map((e) => {
    const startSeconds = DAY_START_SECONDS + cursor
    if (startSeconds >= 86400) {
      throw new Error(
        `refusing to sequence ${e.key ?? 'an entry'} at ${hms(startSeconds)} on ${isoDate}: ` +
        'the cumulative plan for this day runs past midnight, and such a start time silently ' +
        'files onto the NEXT Jira day. Split these entries across days or reduce the hours.',
      )
    }
    const started = startedString(zone, isoDate, hms(startSeconds))
    cursor += Number(e.seconds)
    return { ...e, started }
  })
}

/** The single place a write argv is constructed. Preview and apply both use it. */
export function buildAddArgv(entry) {
  if (!entry?.started) throw new Error('refusing to build an add argv without a started value')
  if (!Number.isInteger(Number(entry.seconds)) || Number(entry.seconds) <= 0) {
    throw new Error(`refusing a non-positive integer seconds value: ${entry.seconds}`)
  }
  return [
    'jira', 'workitem', 'worklog', 'add',
    '--issue-id', String(entry.key),
    '--time-spent-seconds', String(entry.seconds),
    '--started', String(entry.started),
    '--adjust-estimate', 'leave',
    '--notify-users', 'false',
    '--comment-format', 'plain',
    '--comment', String(entry.comment ?? ''),
    '-o', 'json',
  ]
}

const TOKEN_RE = /\b([A-Z][A-Z0-9]+-\d+|[0-9a-f]{7,40}|[\w.-]+\.(?:ts|js|mjs|tsx|md|json|prisma|sql|cs))\b/g

/**
 * The strings from one evidence fragment that are allowed to ground a comment.
 *
 * A fragment is `field: value` pairs joined by '; ' (lib/evidence.mjs). The old
 * rule split on /[;:]/ and accepted any piece >= 4 characters, so
 * `status: In Progress` contributed the bare word `status` — and
 * `validateComment('Reviewed status and fixed the auth bug', ev)` returned ok.
 * That is the exact fabrication this guard exists to stop: a generic field NAME
 * is vocabulary any invented sentence can contain by accident.
 *
 * So a candidate is either the whole `field: value` segment quoted verbatim, or
 * the VALUE side of it — never the field name alone — and it must be meaningful:
 * multi-word, or at least 8 characters.
 */
function groundingTokens(fragment) {
  const out = new Set()
  for (const raw of String(fragment ?? '').split(';')) {
    const segment = raw.trim()
    if (!segment) continue
    const colon = segment.indexOf(':')
    const value = colon === -1 ? segment : segment.slice(colon + 1).trim()
    for (const candidate of [segment, value]) {
      if (!candidate) continue
      if (/\s/.test(candidate) || candidate.length >= 8) out.add(candidate)
    }
  }
  return [...out]
}

/**
 * A comment may only name things the frozen evidence bundle actually contains.
 * This is what stops a plausible-sounding but invented worklog narrative.
 */
export function validateComment(text, bundleForIssue) {
  const s = String(text ?? '')
  const trimmed = s.trim()
  if (trimmed.startsWith('{')) {
    try {
      if (JSON.parse(trimmed)?.type === 'doc') {
        return { ok: false, reason: 'comment looks like raw ADF; send plain text' }
      }
    } catch { /* not JSON, fine */ }
  }

  const fragments = (bundleForIssue ?? []).map((e) => e.fragment).filter(Boolean)
  if (fragments.length === 0) {
    return { ok: false, reason: 'no evidence for this issue on this day; the comment must come from the user' }
  }

  const haystack = fragments.join(' | ')
  const claimed = [...s.matchAll(TOKEN_RE)].map((m) => m[1])
  const unsupported = claimed.filter((t) => !haystack.includes(t))
  if (unsupported.length) {
    return { ok: false, reason: `comment names things absent from the evidence bundle: ${unsupported.join(', ')}` }
  }

  // Token-absence is NOT a pass. A comment naming nothing checkable ("fixed the auth
  // bug") would otherwise sail through - the exact fabrication this guard exists to
  // stop. Require the comment to quote some of the evidence.
  const grounded = fragments.some((f) => groundingTokens(f).some((t) => s.includes(t)))
  if (!grounded) {
    return { ok: false, reason: 'comment is not grounded in any evidence fragment for this issue' }
  }

  return { ok: true, reason: '' }
}

/**
 * Hash everything that defines the write, ignoring volatile bookkeeping.
 *
 * "Everything that defines the write" includes the fields the GUARDS trust, not
 * just the ones Jira receives: plan.accountId is the dedup filter (a hand-edited
 * one makes every dedup read look at a colleague's rows and report CLEAR),
 * dedupeState is what cmd/guard.mjs's drift check compares against, and
 * estimateBefore is what makes its ESTIMATE_CLOBBERED check able to fire at all.
 * All of them come from a JSON file the calling agent owns, so all of them are
 * inside the hash that lib/planfile.mjs re-checks on every load.
 */
export function hashPlan(plan) {
  const canonical = {
    accountId: plan.accountId ?? null,
    zone: plan.zone ?? null,
    days: (plan.days ?? []).map((d) => ({
      date: d.date,
      entries: (d.entries ?? []).map((e) => ({
        key: e.key, numericId: e.numericId ?? null, site: e.site ?? null,
        seconds: e.seconds, started: e.started ?? null,
        comment: e.comment ?? null, fingerprint: e.fingerprint ?? null,
        hoursSource: e.hoursSource ?? null,
        dedupeState: e.dedupeState ?? null,
        estimateBefore: e.estimateBefore ?? null,
        existingSecondsOnIssue: e.existingSecondsOnIssue ?? null,
        evidence: e.evidence ?? [],
      })),
    })),
  }
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 12)
}
