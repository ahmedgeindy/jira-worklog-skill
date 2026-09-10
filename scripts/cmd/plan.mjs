// skills/jira-worklog/scripts/cmd/plan.mjs
import { parseLine } from '../lib/urls.mjs'
import { sequenceStarts, hashPlan, validateComment, sanitizeCommentText } from '../lib/plan.mjs'
import { fingerprint, markerFor, classify } from '../lib/dedup.mjs'
import { isWorkday, weekdayOf, assertNotFuture, localVsJiraDateDiffers } from '../lib/tz.mjs'
import { UNSAFE_CHARS } from '../lib/psline.mjs'

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

    // Two lines for the same issue on the same day are refused UNLESS each is
    // unambiguously a separate, deliberate activity — an explicit, DIFFERENT
    // @HH:MM start time on each (parseLine's `startAt`). Four cases:
    //
    //  1. neither line carries an explicit @HH:MM  -> REFUSE. Indistinguishable
    //     from an accidentally repeated input line: the SAME fingerprint would
    //     result when the hours also match (emit prints the write twice), and
    //     even when they don't, the first write flips the second entry's live
    //     dedupe state so check-cmd aborts the day half-committed. This is
    //     today's original guard, message unchanged.
    //  2. both carry an explicit @HH:MM and the times DIFFER -> ALLOW. Two
    //     deliberate, distinct activities on the same issue and day — the
    //     entire point of this feature (a same-issue standup at 11:00 and a
    //     separate block of work at 13:00).
    //  3. both carry the SAME explicit @HH:MM -> REFUSE. A genuine collision:
    //     two worklogs at the identical instant are indistinguishable
    //     afterwards, and unlike case 1, re-running plan later does not
    //     resolve it — the times themselves are equal, not merely unstated.
    //  4. exactly one line carries an explicit @HH:MM -> REFUSE. The implicit
    //     line is placed by the sequencer (lib/plan.mjs#sequenceStarts) at
    //     09:00 plus its own cumulative duration, which could silently
    //     coincide with the pinned line's time — exactly the ambiguity this
    //     guard exists to prevent.
    const seenByKey = new Map()
    for (const p of parsed) {
      const prior = seenByKey.get(p.key)
      if (prior) {
        for (const q of prior) {
          if (p.startAt == null && q.startAt == null) {
            throw new Error(
              `refusing ${p.key} twice on ${date}: one issue may appear at most once per day in a plan. ` +
              'Combine the lines into a single total, or add the second block by re-running plan ' +
              'after the first one has landed (decision D1c). To log two distinct activities on the ' +
              'same issue and day instead, give each line its own @HH:MM start time.',
            )
          } else if (p.startAt != null && q.startAt != null) {
            if (p.startAt === q.startAt) {
              throw new Error(
                `refusing ${p.key} twice on ${date} at the identical start time @${p.startAt}: two worklogs ` +
                'at the same instant are indistinguishable afterwards. Give one of them a different @HH:MM, ' +
                'or combine them into a single line if they really are the same session.',
              )
            }
            // Different explicit times: two deliberate, distinct activities — allowed.
            // (checked against every prior entry for this key, not just the first)
          } else {
            const pinned = p.startAt ?? q.startAt
            throw new Error(
              `refusing ${p.key} twice on ${date}: one line pins @${pinned} and the other has no explicit ` +
              'start time. The implicit line is placed by the sequencer and could silently land on that ' +
              'same pinned time. Give the implicit line its own @HH:MM too, or combine the lines into a ' +
              'single total.',
            )
          }
        }
        prior.push(p)
      } else {
        seenByKey.set(p.key, [p])
      }
    }
    const keys = [...new Set(parsed.map((p) => p.key))]

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
        // The explicit '@HH:MM' from the input line, if any (else null).
        // Consumed by sequenceStarts below to pin this entry's clock time.
        startAt: p.startAt ?? null,
        // Ruling 1 (task-11 vs task-12 step 4): every entry always carries a numeric
        // estimateBefore, frozen at plan time. cmd/guard.mjs's checkWrite compares the
        // post-write remaining estimate against this. If it were left undefined, the
        // `before > 0` guard there would be false and the ESTIMATE_CLOBBERED check would
        // silently never fire — closing a risk with a check that cannot fire.
        estimateBefore: Number(deps.readEstimate(p.key)),
        evidence: evidence.perIssue[p.key] ?? [],
        // task-14 Fix B: the ' :: ' comment the human typed on the input line,
        // if any. Carried only as far as the comment-building step below,
        // which strips it back off before the entry is returned - it is raw,
        // pre-sanitize input and must never be the thing planHash covers.
        userComment: p.comment ?? null,
      }
    })

    entries = sequenceStarts(identity.zone, date, entries)

    // The day verdict is computed BEFORE the comments, because decision D1b puts
    // the breach INTO that day's worklog comments. Every entry's seconds has
    // already been validated as non-null by the map above, so this sum is real
    // arithmetic and not a null coercion.
    const plannedSeconds = entries.reduce((a, e) => a + Number(e.seconds), 0)
    const totalSeconds = dt.seconds + plannedSeconds
    const status = totalSeconds < FLOOR_SECONDS ? 'SHORT' : 'MEETS'

    // Case 2 above (both explicit, different times) is allowed by the guard
    // above, but lib/dedup.mjs#fingerprint deliberately excludes `started` —
    // it hashes only accountId|key|isoDate|seconds. Two ALLOWED entries whose
    // DURATIONS also happen to match therefore produce the identical
    // fingerprint marker, so emit would print the same [twl:<fp>] on both
    // lines and check-write would classify the second write as DUPLICATE
    // against the first once it lands (see lib/dedup.mjs#classify — never
    // changed by this feature, per spec). That is a real write-time failure,
    // not a cosmetic one, so it is refused here at plan time rather than only
    // noted in a preview.
    const seenFingerprints = new Map()
    entries = entries.map((e) => {
      assertNotFuture(e.started, nowMs)
      const fp = fingerprint({ accountId: identity.accountId, key: e.key, isoDate: date, seconds: e.seconds })
      if (seenFingerprints.has(fp)) {
        throw new Error(
          `refusing ${e.key} twice on ${date}: entries at @${seenFingerprints.get(fp)} and ` +
          `@${e.startAt ?? '(sequenced)'} both plan ${e.seconds}s, so they share the SAME dedup fingerprint ` +
          '(accountId+issue+day+seconds — start time is not part of it). The second write would be ' +
          'misclassified as DUPLICATE against the first once it lands. Vary one duration by at least a ' +
          'minute, or combine the two lines into one.',
        )
      }
      seenFingerprints.set(fp, e.startAt ?? '(sequenced)')
      const rows = deps.checkWindow({ key: e.key, accountId: identity.accountId, zone: identity.zone, isoDate: date })
      const mine = rows.filter((r) => r?.author?.accountId === identity.accountId)
      // Validate the BODY, before the [twl:<fp>] marker is appended. The fingerprint is
      // a 16-char lowercase hex string, which is byte-for-byte what validateComment's
      // TOKEN_RE treats as an unverified commit SHA — validating the marker-bearing text
      // would make every comment fail as "names things absent from the evidence bundle".
      // The marker is tool metadata, not a claim that needs grounding, so it is appended
      // only after validation passes.
      //
      // task-14 Fix B: a ' :: ' comment on the input line is USER_SUPPLIED - a
      // human wrote it, so grounding is meaningless and skipped. Everything
      // else is EVIDENCED and still fully grounded (Fix A must not weaken
      // that). Both paths sanitize the same way (Fix A) and both are rejected
      // outright if sanitization cannot make the result shell-safe, rather
      // than letting an exotic character reach lib/psline.mjs later.
      let body
      let commentSource
      if (e.userComment) {
        const userBody = sanitizeCommentText(e.userComment)
        if (!userBody) throw new Error(`comment rejected for ${e.key}: user comment is empty after sanitization`)
        // D1b applies to a USER_SUPPLIED comment too - a human wrote it, but the
        // breach record still needs to land somewhere a manager reads, and the
        // sanitize pass here is a no-op on the suffix (see appendBreachNote).
        body = sanitizeCommentText(appendBreachNote(userBody, { status, totalSeconds }))
        commentSource = 'USER_SUPPLIED'
      } else {
        body = sanitizeCommentText(appendBreachNote(buildCommentBody(e), { status, totalSeconds }))
        const v = validateComment(body, e.evidence)
        if (!v.ok) throw new Error(`comment rejected for ${e.key}: ${v.reason}`)
        commentSource = 'EVIDENCED'
      }
      if (UNSAFE_CHARS.test(body)) {
        throw new Error(`comment rejected for ${e.key}: still unsafe after sanitization`)
      }
      const comment = `${body} ${markerFor(fp)}`
      const { userComment: _userComment, ...frozen } = e
      return {
        ...frozen,
        fingerprint: fp,
        comment,
        commentSource,
        dedupeState: classify(rows, { accountId: identity.accountId, seconds: e.seconds, fp }),
        existingSecondsOnIssue: mine.reduce((a, r) => a + Number(r.timeSpentSeconds ?? 0), 0),
      }
    })

    return {
      date, weekday: weekdayOf(date), isWorkday: isWorkday(date),
      existingSeconds: dt.seconds, plannedSeconds, totalSeconds,
      status,
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
 *
 * The EVIDENCED body only - the D1b breach suffix is applied afterwards by
 * appendBreachNote, to whichever body (this one, or a USER_SUPPLIED comment)
 * was actually chosen. See appendBreachNote for why that is one function.
 */
function buildCommentBody(entry) {
  const facts = (entry.evidence ?? []).map((e) => e.fragment).join(', ')
  const body = facts || 'work logged'
  return body.replace(/;/g, ',')
}

/**
 * Decision D1b: a SHORT day carries its breach into that day's worklog comment,
 * because a gitignored local ledger is never read by a manager and this is. It
 * states the hours the day will hold and the floor — never the difference,
 * never an issue to put it on (D1a). The spec writes that note with a ';';
 * a ';' would make the whole line unemittable, so it is written with a ','.
 *
 * This is the ONLY place that knows that wording, applied to whichever comment
 * body was chosen - EVIDENCED (buildCommentBody, above) or USER_SUPPLIED (the
 * human's own ' :: ' text). A SHORT day loses its policy record either way if
 * this is skipped for one of the two sources, which is exactly the task-14
 * Fix B regression this closes: USER_SUPPLIED bypassed buildCommentBody (and
 * therefore this note) entirely.
 *
 * The suffix is plain letters/digits/spaces/'.'/',' - nothing sanitizeCommentText
 * touches - so it survives being appended either before or after the caller's
 * own sanitize pass, and it can never itself introduce a shell-unsafe character.
 */
function appendBreachNote(body, day) {
  if (day?.status !== 'SHORT') return body
  return `${body}. logged ${(Number(day.totalSeconds) / 3600).toFixed(1)}h, below the 7h policy floor`
}
