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
 * Sequence entries from 09:00 by cumulative planned duration, EXCEPT an entry
 * that names its own `startAt` ('HH:MM', from an '@HH:MM' input token) is
 * PINNED there instead. Stacking every implicit entry at 09:00 asserts
 * simultaneous work sessions; 09:00 also keeps every entry far from both
 * exclusive filter bounds and from midnight.
 *
 * Rule (simplest defensible one, chosen deliberately): a pinned entry neither
 * consumes nor is shifted by the implicit cursor. The implicit entries
 * sequence from 09:00 purely by their OWN cumulative duration, exactly as if
 * the pinned entries were not in the list at all. Two independent facts drove
 * this over "pinned entries also advance the cursor":
 *  - a caller pins a time because they know it is correct; letting an
 *    unrelated implicit entry silently shift because someone else's line
 *    carried an '@' would be a surprising action-at-a-distance no caller asked
 *    for;
 *  - the motivating case (a fixed 11:00 standup INSIDE an 09:00-17:00 implicit
 *    dev-work block) requires the two ranges to overlap on the calendar, so
 *    "no overlap allowed" cannot be the rule either. Overlap between a pinned
 *    entry and an implicit one is therefore deliberately never checked here -
 *    pinning is the operator asserting the time is correct.
 *
 * At >= 15h cumulative among the IMPLICIT entries the cursor reaches 24:00:00,
 * which startedString would happily format as `2026-09-08T24:00:00.000+0300` —
 * a string that PARSES as 00:00 the NEXT Jira day, lands the worklog on the
 * wrong date, and slips past assertNotFuture because it is still in the past.
 * Refuse it here with a domain error rather than emitting a plausible-looking
 * wrong day. A pinned entry can never trigger this refusal - its clock time is
 * taken verbatim, never added to the cursor.
 */
export function sequenceStarts(zone, isoDate, entries) {
  let cursor = 0
  return entries.map((e) => {
    if (e.startAt) {
      const started = startedString(zone, isoDate, `${e.startAt}:00`)
      return { ...e, started }
    }
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

/**
 * Neutralise characters lib/psline.mjs's UNSAFE regex refuses, so a perfectly
 * ordinary evidence value (R&D, Q1 > Q2, a $ in a summary) never crashes
 * `plan` with a raw stack trace (task-14 Fix A). Replace where a replacement
 * preserves meaning; remove the rest. Pure - never throws, so it is also safe
 * to use on the GROUNDING side of validateComment below, where a candidate
 * that happens to contain something exotic must degrade gracefully rather
 * than abort the comparison.
 *
 * Applied ONLY to comment text (and, transiently, to grounding candidates
 * derived from evidence for comparison purposes) - never to the stored
 * evidence[] fragments themselves, which are the audit trail under planHash.
 */
export function sanitizeCommentText(text) {
  return String(text ?? '')
    .replace(/&/g, 'and')
    .replace(/</g, 'lt')
    .replace(/>/g, 'gt')
    .replace(/\|/g, '/')
    .replace(/[`$;"\r\n]/g, '')
    .replace(/ {2,}/g, ' ')
    .trim()
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

  // The comment text `s` reaches here already sanitized (cmd/plan.mjs applies
  // sanitizeCommentText before calling validateComment - task-14 Fix A), so an
  // evidence value like 'R&D' is compared as it will actually appear: 'RandD'.
  // Sanitizing each fragment before joining (not the joined haystack as a
  // whole) matters: sanitizing can CREATE a new substring the raw fragment
  // never had (e.g. 'R&D.md' -> 'RandD.md', which TOKEN_RE's filename
  // alternative can match) - if the haystack were built from raw fragments,
  // that would be falsely flagged as unsupported.
  const haystack = fragments.map((f) => sanitizeCommentText(f)).join(' | ')
  const claimed = [...s.matchAll(TOKEN_RE)].map((m) => m[1])
  const unsupported = claimed.filter((t) => !haystack.includes(t))
  if (unsupported.length) {
    return { ok: false, reason: `comment names things absent from the evidence bundle: ${unsupported.join(', ')}` }
  }

  // Token-absence is NOT a pass. A comment naming nothing checkable ("fixed the auth
  // bug") would otherwise sail through - the exact fabrication this guard exists to
  // stop. Require the comment to quote some of the evidence.
  //
  // groundingTokens still runs on the RAW fragment: it splits on ';' to keep
  // multiple changelog fields independently groundable, and sanitizing the
  // whole fragment first (removing ';') would merge two fields into one
  // longer candidate and break that. Only the extracted CANDIDATE is
  // sanitized, right before the comparison against `s`.
  const grounded = fragments.some((f) => groundingTokens(f).some((t) => s.includes(sanitizeCommentText(t))))
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
        // whether the human pinned this entry's clock time via '@HH:MM' or left
        // it to the sequencer. `started` already differs whenever the resulting
        // clock time differs, but a hand-edited plan.json could flip this flag
        // while leaving `started` numerically unchanged (e.g. a pinned 09:00
        // entry re-marked as sequenced); that changes what the human actually
        // approved at the gate (lib/preview.mjs's PINNED label), so it belongs
        // in what loadPlanFile's hash re-check protects.
        startAt: e.startAt ?? null,
        // task-14 Fix B: whether the comment was written by the human
        // (USER_SUPPLIED, grounding skipped) or composed by the tool from
        // evidence (EVIDENCED, grounding enforced) changes what the approval
        // actually means, so it must be inside the hash the human approves.
        commentSource: e.commentSource ?? null,
        dedupeState: e.dedupeState ?? null,
        estimateBefore: e.estimateBefore ?? null,
        existingSecondsOnIssue: e.existingSecondsOnIssue ?? null,
        evidence: e.evidence ?? [],
      })),
    })),
  }
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 12)
}
