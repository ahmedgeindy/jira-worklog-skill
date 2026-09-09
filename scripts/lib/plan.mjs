// skills/jira-worklog/scripts/lib/plan.mjs
import { createHash } from 'node:crypto'
import { startedString } from './tz.mjs'

const DAY_START = '09:00:00'

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
 */
export function sequenceStarts(zone, isoDate, entries) {
  const base = 9 * 3600
  let cursor = 0
  return entries.map((e) => {
    const started = startedString(zone, isoDate, hms(base + cursor))
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
  const grounded = fragments.some((f) =>
    f.split(/[;:]/).map((w) => w.trim()).filter((w) => w.length >= 4).some((w) => s.includes(w)))
  if (!grounded) {
    return { ok: false, reason: 'comment is not grounded in any evidence fragment for this issue' }
  }

  return { ok: true, reason: '' }
}

/** Hash everything that defines the write, ignoring volatile bookkeeping. */
export function hashPlan(plan) {
  const canonical = (plan.days ?? []).map((d) => ({
    date: d.date,
    entries: (d.entries ?? []).map((e) => ({
      key: e.key, numericId: e.numericId ?? null, site: e.site ?? null,
      seconds: e.seconds, started: e.started ?? null,
      comment: e.comment ?? null, fingerprint: e.fingerprint ?? null,
      hoursSource: e.hoursSource ?? null,
      evidence: e.evidence ?? [],
    })),
  }))
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 12)
}
