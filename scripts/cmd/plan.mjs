// skills/jira-worklog/scripts/cmd/plan.mjs
import { parseLine } from '../lib/urls.mjs'
import { sequenceStarts, hashPlan, validateComment } from '../lib/plan.mjs'
import { fingerprint, markerFor, classify } from '../lib/dedup.mjs'
import { isWorkday, weekdayOf, assertNotFuture, localVsJiraDateDiffers } from '../lib/tz.mjs'

const FLOOR_SECONDS = 7 * 3600
const MAX_DAYS = 5

export function runPlan({ lines, isoDate, deps = {} }) {
  const dates = Array.isArray(isoDate) ? isoDate : [isoDate]
  if (dates.length > MAX_DAYS) {
    throw new Error(`refusing ${dates.length} days: max 5 days per run (decision D4)`)
  }

  const identity = deps.resolveIdentity()
  const nowMs = deps.now()
  if (localVsJiraDateDiffers(identity.zone, nowMs)) {
    throw new Error(
      'HARD STOP: the machine calendar date and the Jira calendar date differ right now. ' +
      'Relative day words are ambiguous — pass an explicit --date.',
    )
  }

  const days = dates.map((date) => {
    const parsed = lines.map((l) => parseLine(l))
    const keys = parsed.map((p) => p.key)

    const evidence = deps.bundle({ isoDate: date, keys, zone: identity.zone, accountId: identity.accountId })

    const dt = deps.dayTotal({ zone: identity.zone, accountId: identity.accountId, isoDate: date, extraKeys: keys })
    if (dt.status !== 'OK') {
      throw new Error(`UNKNOWN day total for ${date}: ${dt.reason}. Refusing to plan against an unverified number.`)
    }

    let entries = parsed.map((p) => {
      const resolved = deps.resolveIssue(p.key)
      if (p.host && p.host !== resolved.site) {
        throw new Error(`site mismatch on ${p.key}: pasted host ${p.host}, resolved site ${resolved.site}`)
      }
      if (p.seconds == null) throw new Error(`no hours given for ${p.key}`)
      return {
        key: p.key, numericId: resolved.numericId, site: resolved.site,
        seconds: p.seconds, hoursSource: p.hoursSource,
        // Ruling 1 (task-11 vs task-12 step 4): every entry always carries a numeric
        // estimateBefore, frozen at plan time. cmd/guard.mjs's checkWrite compares the
        // post-write remaining estimate against this. If it were left undefined, the
        // `before > 0` guard there would be false and the ESTIMATE_CLOBBERED check would
        // silently never fire — closing a risk with a check that cannot fire.
        estimateBefore: Number(deps.readEstimate(p.key)),
        evidence: evidence.perIssue[p.key] ?? [],
      }
    })

    entries = sequenceStarts(identity.zone, date, entries)

    entries = entries.map((e) => {
      assertNotFuture(e.started, nowMs)
      const fp = fingerprint({ accountId: identity.accountId, key: e.key, isoDate: date, seconds: e.seconds })
      const rows = deps.checkWindow({ key: e.key, accountId: identity.accountId, zone: identity.zone, isoDate: date })
      const mine = rows.filter((r) => r?.author?.accountId === identity.accountId)
      // Validate the BODY, before the [twl:<fp>] marker is appended. The fingerprint is
      // a 16-char lowercase hex string, which is byte-for-byte what validateComment's
      // TOKEN_RE treats as an unverified commit SHA — validating the marker-bearing text
      // would make every comment fail as "names things absent from the evidence bundle".
      // The marker is tool metadata, not a claim that needs grounding, so it is appended
      // only after validation passes.
      const body = buildCommentBody(e)
      const v = validateComment(body, e.evidence)
      if (!v.ok) throw new Error(`comment rejected for ${e.key}: ${v.reason}`)
      const comment = `${body} ${markerFor(fp)}`
      return {
        ...e,
        fingerprint: fp,
        comment,
        dedupeState: classify(rows, { accountId: identity.accountId, seconds: e.seconds, fp }),
        existingSecondsOnIssue: mine.reduce((a, r) => a + Number(r.timeSpentSeconds ?? 0), 0),
      }
    })

    const planned = entries.reduce((a, e) => a + e.seconds, 0)
    const total = dt.seconds + planned

    return {
      date, weekday: weekdayOf(date), isWorkday: isWorkday(date),
      existingSeconds: dt.seconds, plannedSeconds: planned, totalSeconds: total,
      status: total < FLOOR_SECONDS ? 'SHORT' : 'MEETS',
      commentSource: evidence.commentSource, bundleHash: evidence.bundleHash,
      entries,
    }
  })

  const plan = { version: 1, accountId: identity.accountId, zone: identity.zone, days }
  plan.planHash = hashPlan(plan)
  return plan
}

/**
 * Facts are joined with ', ' rather than '; ': a single changelog event that
 * touched multiple fields already contains an internal '; ' (lib/evidence.mjs
 * joins its items that way), and cmd/emit.mjs's UNSAFE check REFUSES to render
 * any comment containing ';' (it could be read as a PowerShell statement
 * separator). Any semicolon that survives from a fragment's own text is
 * stripped too, so a real multi-field changelog entry never reaches emit as an
 * unemittable comment.
 */
function buildCommentBody(entry) {
  const facts = (entry.evidence ?? []).map((e) => e.fragment).join(', ')
  const body = facts || 'work logged'
  return body.replace(/;/g, ',')
}
