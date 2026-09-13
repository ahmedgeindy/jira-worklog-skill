// skills/jira-worklog/scripts/cmd/guard.mjs
// Read-only guards the agent must call around every write. No spawning of writes.
import { existsSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { emitManifest } from './emit.mjs'
import { classify } from '../lib/dedup.mjs'

/**
 * Real, on-disk approval-token store (Ruling 2: guard-bypass detection).
 *
 * The write itself is triggered OUTSIDE this process — the agent's own
 * PowerShell tool call — so nothing in-process can PREVENT an agent from
 * issuing that line without ever calling check-cmd first; its permission
 * prompt looks identical either way. A file beside the plan is the only
 * channel check-write has to tell "check-cmd ran for this exact fingerprint"
 * apart from "it did not": one token per fingerprint, written on a successful
 * check-cmd, consumed (checked-and-deleted) by check-write.
 */
export function fileTokenStore(dir) {
  const pathFor = (fp) => join(dir, `.jira-worklog-approved-${fp}`)
  return {
    put(fp) {
      writeFileSync(pathFor(fp), String(Date.now()))
    },
    has(fp) {
      return existsSync(pathFor(fp))
    },
    take(fp) {
      const p = pathFor(fp)
      const had = existsSync(p)
      if (had) {
        try {
          unlinkSync(p)
        } catch {
          /* already gone; `had` still correctly reports it existed at check time */
        }
      }
      return had
    },
  }
}

function requireTokens(deps) {
  if (!deps?.tokens) {
    throw new Error(
      'deps.tokens is required (fileTokenStore(dir) in production, a test double in tests) — ' +
      'refusing to run with guard-bypass detection silently disabled',
    )
  }
  return deps.tokens
}

/**
 * Called BEFORE the agent runs a write line. Two independent checks:
 *  1. the literal line is byte-identical to the frozen manifest entry
 *     (restores "previewed == written" now that the shell is on the write path)
 *  2. live server state still matches what the plan saw
 * On success, records an approval token for this fingerprint (Ruling 2) so
 * check-write can tell a legitimate write from a bypassed one.
 */
export function checkCmd({ plan, date, cmd, deps }) {
  const tokens = requireTokens(deps)
  const manifest = emitManifest(plan, date, deps.bin)
  const entry = manifest.find((m) => m.command === cmd)
  if (!entry) {
    return {
      ok: false, entry: null,
      reason: 'the command does not match the manifest byte-for-byte; refusing. Re-run plan and use the emitted line verbatim.',
    }
  }

  const planned = plan.days
    .find((d) => d.date === date)
    .entries.find((e) => e.fingerprint === entry.fingerprint)

  const rows = deps.checkWindow({ key: planned.key, accountId: plan.accountId, zone: plan.zone, isoDate: date })
  const state = classify(rows, { accountId: plan.accountId, seconds: planned.seconds, fp: planned.fingerprint })

  // A live DUPLICATE/AMBIGUOUS always stops the day, regardless of what the
  // plan froze — including a plan that itself was already frozen as
  // DUPLICATE/AMBIGUOUS (e.g. an accidental re-run of `plan` for a day already
  // committed). This must NOT be folded into the drift check below: an
  // unchanged DUPLICATE/AMBIGUOUS state would otherwise satisfy
  // `state === planned.dedupeState` and pass.
  if (state === 'DUPLICATE' || state === 'AMBIGUOUS') {
    const driftNote = state !== planned.dedupeState
      ? ` (drift since plan time: was ${planned.dedupeState})`
      : ' (unchanged from plan time — an earlier plan/write for this day was never resolved)'
    return { ok: false, entry, reason: `${state} at write time${driftNote} — refusing to write, stop this day and reconcile manually` }
  }

  // Otherwise, only a CHANGE in state since plan time is a problem. This is
  // what lets the required top-up flow work: when a day is under the 7h floor,
  // re-running `plan` for entries already on the issue that day correctly
  // classifies them as EXISTING (matching what the plan itself recorded), and
  // that must pass so the human can approve it in the preview.
  if (state !== planned.dedupeState) {
    return { ok: false, entry, reason: `drift since plan time: was ${planned.dedupeState}, now ${state} (possible duplicate) — stop this day` }
  }

  tokens.put(entry.fingerprint)
  return { ok: true, entry, reason: '' }
}

/**
 * Called AFTER the agent runs a write line. Reads from the SERVER, so it also
 * catches the case where the call timed out locally but Jira committed.
 *
 * Ruling 2 (guard-bypass detection, prose over the brief's code block): the
 * agent could run the PowerShell write line directly, skipping check-cmd — its
 * permission prompt looks identical to the legitimate flow, so the human
 * approves a write whose drift check never ran. Nothing in-process can PREVENT
 * that now that the trigger lives outside the script, so this makes it LOUD
 * instead of silent: check-write requires the approval token check-cmd left
 * behind, and consumes it (take: check-and-delete) UNCONDITIONALLY before
 * doing anything else — one check-cmd authorizes exactly one check-write, so a
 * retry always forces a fresh drift check.
 */
export function checkWrite({ plan, date, key, fingerprint, deps }) {
  const tokens = requireTokens(deps)
  const day = plan.days.find((d) => d.date === date)
  if (!day) return { ok: false, reason: `plan contains no day ${date}` }
  const matches = day.entries.filter((e) => e.key === key)
  if (matches.length === 0) return { ok: false, reason: `plan has no entry for ${key} on ${date}` }

  // The duplicate-key guard in cmd/plan.mjs now allows more than one entry per
  // (key, day) when each carries its own distinct '@HH:MM' start time, so
  // `key` alone no longer names exactly one entry — picking matches[0] here
  // would silently check the WRONG entry's fingerprint/estimate whenever the
  // agent is confirming the second write. Fall back to the fingerprint the
  // matching check-cmd call already approved (and the token store is already
  // keyed on) to disambiguate, rather than guessing.
  let planned
  if (matches.length === 1) {
    planned = matches[0]
  } else if (fingerprint) {
    planned = matches.find((e) => e.fingerprint === fingerprint)
    if (!planned) {
      return {
        ok: false,
        reason: `plan has ${matches.length} entries for ${key} on ${date}, none with fingerprint ${fingerprint}`,
      }
    }
  } else {
    return {
      ok: false,
      reason: `plan has ${matches.length} entries for ${key} on ${date} (distinct start times) — pass ` +
        `--fingerprint to disambiguate: ${matches.map((m) => `${m.fingerprint} @${m.started}`).join(', ')}`,
    }
  }

  const authorized = tokens.take(planned.fingerprint)
  if (!authorized) {
    return { ok: false, reason: 'GUARD BYPASSED: write issued without check-cmd (no approval token found for this fingerprint)' }
  }

  // Identify the row this write produced by (started, timeSpentSeconds) rather
  // than by a marker embedded in the comment. Both fields are frozen in the
  // plan and present on every row, so nothing tool-shaped has to appear in
  // text a human reads in Jira.
  //
  // BOTH fields are required. `started` alone gives a false DUPLICATE in the
  // legitimate top-up case (1h already at 09:00, now planning 2h at 09:00 —
  // classify says EXISTING, the write lands, and two rows then share the same
  // `started`). `seconds` alone cannot separate two entries of equal length on
  // the same day.
  //
  // Compared as epoch ms: Jira echoes the offset in its own formatting, so a
  // string compare against the planned value is not reliable.
  const wantStarted = Date.parse(planned.started)
  const wantSeconds = Number(planned.seconds)
  if (!Number.isFinite(wantStarted)) {
    return { ok: false, reason: `plan entry for ${key} on ${date} has an unparseable started (${planned.started})` }
  }

  const rows = deps.checkWindow({ key, accountId: plan.accountId, zone: plan.zone, isoDate: date })
  const mine = rows.filter(
    (r) => r?.author?.accountId === plan.accountId &&
      Date.parse(r.started) === wantStarted &&
      Number(r.timeSpentSeconds) === wantSeconds,
  )

  const want = `${planned.started} / ${wantSeconds}s`
  if (mine.length === 0) return { ok: false, reason: `no worklog matching ${want} found on ${key} for ${date}; the write did not land` }
  if (mine.length > 1) return { ok: false, reason: `found ${mine.length} rows matching ${want} on ${key} — duplicate write, stop and reconcile manually` }

  const before = planned.estimateBefore ?? 0
  if (before > 0) {
    const after = deps.readEstimate(key)
    if (after !== before) {
      return { ok: false, worklogId: String(mine[0].id), reason: `ESTIMATE_CLOBBERED: remaining estimate went ${before} -> ${after}` }
    }
  }

  return { ok: true, worklogId: String(mine[0].id), reason: '' }
}
