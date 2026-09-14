// skills/jira-worklog/scripts/lib/daytotal.mjs
import { queryWindow, addDays, dayOfInstant } from './tz.mjs'
import { run as realRun, assertTrustworthy, assertEcho } from './twg.mjs'

/**
 * Candidate DISCOVERY. Absolute dates only, and only >= and < — `>` and `<=`
 * silently round the bound up to end-of-day. Widened by one day on each side so
 * an issue whose worklogDate lands on the neighbouring Jira day is still read.
 *
 * This width is fine for discovery (a superfluous candidate just gets a
 * per-issue read that returns nothing for this day) and WRONG as a control —
 * see buildNarrowDayJql.
 */
export function buildDayJql(isoDate) {
  const from = addDays(isoDate, -1)
  const to = addDays(isoDate, 2)
  return `worklogAuthor = currentUser() AND worklogDate >= "${from}" AND worklogDate < "${to}"`
}

/**
 * The CONTROL query: exactly the day in question.
 *
 * The second control asks "JQL says I logged on this day, so why did the
 * author-filtered sum come back 0?". Driving that off the WIDE query made
 * consecutive backfill impossible: log 7h on an issue on Aug 2, then plan
 * Aug 3 — the wide query finds that issue (because of Aug 2), the Aug-3-windowed
 * per-issue read correctly finds none of yours, and the day is declared UNKNOWN.
 * Day 1 of a backfill worked, day 2 onward never did. It failed safe and blocked
 * the whole job.
 */
export function buildNarrowDayJql(isoDate) {
  const to = addDays(isoDate, 1)
  return `worklogAuthor = currentUser() AND worklogDate >= "${isoDate}" AND worklogDate < "${to}"`
}

/**
 * Sum ONLY the caller's rows, and only from timeSpentSeconds.
 * A per-issue worklog query returns every author (measured: 36h unfiltered vs a
 * true 15h), and the timeSpent display string uses site units where 1d = 8h.
 */
export function sumAuthorSeconds(rows, accountId) {
  return (rows ?? [])
    .filter((r) => r?.author?.accountId === accountId)
    .reduce((acc, r) => acc + Number(r.timeSpentSeconds ?? 0), 0)
}

function pageWorklogs(run, key, window) {
  const rows = []
  let after = null
  let declaredTotal = null

  for (let guard = 0; guard < 200; guard += 1) {
    const argv = [
      'jira', 'workitem', 'worklog', 'query',
      '--issue-id', key,
      '--started-after', String(window.after),
      '--started-before', String(window.before),
      '--first', '100',
      '-o', 'json',
    ]
    if (after !== null) argv.push('--after', String(after))

    const res = run(argv)
    assertTrustworthy(res, `worklog query ${key}`)
    // Guard the parseInt trap: an ISO string is accepted and echoed as 2026.
    if (res.request) {
      assertEcho({ startedAfter: window.after, startedBefore: window.before }, res.request)
    }

    const batch = Array.isArray(res.data) ? res.data : (res.data?.worklogs ?? [])
    rows.push(...batch)
    declaredTotal = res.meta?.pagination?.total ?? declaredTotal

    // pageInfo is TOP-LEVEL in the envelope (probed live: meta.pageInfo does not
    // exist). Reading only meta.* made this loop dead code — the cursor was
    // always null, so page 2 was never fetched and a >100-row day truncated
    // silently. lib/twg.mjs surfaces both placements; both are read here.
    const next = res.pageInfo?.nextCursor ?? res.meta?.pageInfo?.nextCursor ?? res.meta?.nextCursor ?? null
    if (!next || batch.length === 0) break
    if (next === after) {
      throw new Error(
        `pagination cursor did not advance on ${key} (still ${next}); refusing to re-read the same page`,
      )
    }
    after = next
  }

  return { rows, declaredTotal }
}

/**
 * The two-step author-filtered day total.
 * Returns status 'UNKNOWN' whenever the number cannot be positively controlled.
 * UNKNOWN must abort the caller — a false zero authorizes a full 7h overwrite.
 */
export function dayTotal({ zone, accountId, isoDate, extraKeys = [], deps = {} }) {
  const run = deps.run ?? realRun
  const window = queryWindow(zone, isoDate)

  let discovered = []
  try {
    const res = run(['jira', 'workitem', 'query', '--jql', buildDayJql(isoDate), '-o', 'json'])
    assertTrustworthy(res, 'JQL day discovery')
    discovered = (res.data?.issues ?? []).map((i) => i.key)
  } catch (e) {
    return { seconds: 0, status: 'UNKNOWN', reason: `JQL discovery failed: ${e.message}`, countedWorklogIds: [], candidates: [] }
  }

  // The control set: issues JQL says carry MY time on THIS day specifically.
  let discoveredOnDay = []
  try {
    const res = run(['jira', 'workitem', 'query', '--jql', buildNarrowDayJql(isoDate), '-o', 'json'])
    assertTrustworthy(res, 'JQL day control')
    discoveredOnDay = (res.data?.issues ?? []).map((i) => i.key)
  } catch (e) {
    return { seconds: 0, status: 'UNKNOWN', reason: `JQL day control failed: ${e.message}`, countedWorklogIds: [], candidates: [] }
  }

  // Union with the narrow control's own keys and with keys this session already
  // touched: JQL is index-backed (agg) and can lag behind a worklog entered in
  // the Jira UI minutes ago. The wide query has no positive control on its own
  // completeness, so if it truncates or misses an issue that the narrow query
  // names, that issue must still get a per-issue read - otherwise its hours
  // silently vanish from the total while status stays OK.
  const candidates = [...new Set([...discovered, ...discoveredOnDay, ...extraKeys])]
  if (candidates.length === 0) {
    return { seconds: 0, status: 'OK', reason: 'no candidate issues', countedWorklogIds: [], candidates }
  }

  let seconds = 0
  const countedWorklogIds = []
  let sawAnyRow = false

  for (const key of candidates) {
    let page
    try {
      page = pageWorklogs(run, key, window)
    } catch (e) {
      return { seconds: 0, status: 'UNKNOWN', reason: `worklog read failed on ${key}: ${e.message}`, countedWorklogIds: [], candidates }
    }

    if (page.declaredTotal !== null && page.rows.length !== page.declaredTotal) {
      return {
        seconds: 0, status: 'UNKNOWN', candidates, countedWorklogIds: [],
        reason: `pagination mismatch on ${key}: collected ${page.rows.length}, meta.pagination.total ${page.declaredTotal}`,
      }
    }

    if (page.rows.length) sawAnyRow = true
    for (const r of page.rows) {
      if (r?.author?.accountId === accountId) {
        seconds += Number(r.timeSpentSeconds ?? 0)
        countedWorklogIds.push(r.id)
      }
    }
  }

  // Second control, driven off the NARROW query: JQL says I logged on THIS day,
  // but the author filter found nothing. Something is wrong with the read — do
  // not report 0h. (An issue discovered only by the wide window is expected to
  // contribute nothing here; that is a neighbouring day, not a failed read.)
  if (discoveredOnDay.length > 0 && seconds === 0) {
    return {
      seconds: 0, status: 'UNKNOWN', candidates, countedWorklogIds,
      reason: `JQL returned ${discoveredOnDay.length} issue(s) with my time on ${isoDate} but the author-filtered sum is 0${sawAnyRow ? ' (rows exist, none mine)' : ' (no rows returned at all)'}`,
    }
  }

  return { seconds, status: 'OK', reason: '', countedWorklogIds, candidates }
}

/**
 * Author-filtered total over a DATE RANGE, for the month-to-date capacity check
 * (lib/capacity.mjs). Same two-step shape as dayTotal, and for the same reason:
 * a per-issue worklog query returns every author, and an unverified zero here is
 * worse than a day-level one. A false zero makes the ceiling check PASS - it
 * would authorise exactly the over-log the ceiling exists to refuse - so the
 * positive control below is the load-bearing part of this function, not a
 * nicety. It returns UNKNOWN rather than a number it cannot stand behind.
 */
export function monthTotal({ zone, accountId, fromIso, toIso, extraKeys = [], deps = {} }) {
  const run = deps.run ?? realRun
  if (!accountId) {
    return { seconds: 0, status: 'UNKNOWN', reason: 'no accountId: the author filter would match nothing and every sum would read 0', countedWorklogIds: [], candidates: [] }
  }

  // Both bounds come from the same tz helpers a single day uses: the lower edge
  // widened by 1ms (twg's bounds are strictly exclusive on both ends) and the
  // upper edge at local midnight opening the day AFTER toIso.
  const window = { after: queryWindow(zone, fromIso).after, before: queryWindow(zone, toIso).before }

  const jql = `worklogAuthor = currentUser() AND worklogDate >= "${fromIso}" AND worklogDate < "${addDays(toIso, 1)}"`
  let discovered = []
  try {
    const res = run(['jira', 'workitem', 'query', '--jql', jql, '-o', 'json'])
    assertTrustworthy(res, 'JQL month discovery')
    discovered = (res.data?.issues ?? []).map((i) => i.key)
  } catch (e) {
    return { seconds: 0, status: 'UNKNOWN', reason: `JQL month discovery failed: ${e.message}`, countedWorklogIds: [], candidates: [] }
  }

  const candidates = [...new Set([...discovered, ...extraKeys])]
  if (candidates.length === 0) {
    // No issue in the whole range carries my time. Unlike the day case this is
    // reported as a real zero only because the SAME query that would have found
    // work is the one that came back empty - there is no narrower control that
    // could disagree with it.
    return { seconds: 0, status: 'OK', reason: 'no candidate issues in range', countedWorklogIds: [], candidates }
  }

  let seconds = 0
  const countedWorklogIds = []
  let sawAnyRow = false

  for (const key of candidates) {
    let page
    try {
      page = pageWorklogs(run, key, window)
    } catch (e) {
      return { seconds: 0, status: 'UNKNOWN', reason: `worklog read failed on ${key}: ${e.message}`, countedWorklogIds: [], candidates }
    }
    if (page.declaredTotal !== null && page.rows.length !== page.declaredTotal) {
      return {
        seconds: 0, status: 'UNKNOWN', candidates, countedWorklogIds,
        reason: `pagination mismatch on ${key}: collected ${page.rows.length}, meta.pagination.total ${page.declaredTotal}`,
      }
    }
    if (page.rows.length) sawAnyRow = true
    for (const r of page.rows) {
      if (r?.author?.accountId !== accountId) continue
      // The window is already the range, but a row is only counted when its own
      // Jira calendar day lands inside it: the 1ms widening at the lower edge
      // can otherwise admit a worklog started at 23:59:59.999 the day before.
      const day = dayOfInstant(Date.parse(String(r.started).replace(/([+-]\d{2})(\d{2})$/, '$1:$2')), zone)
      if (day < fromIso || day > toIso) continue
      seconds += Number(r.timeSpentSeconds ?? 0)
      countedWorklogIds.push(r.id)
    }
  }

  // POSITIVE CONTROL. JQL says I logged inside this range, but the author filter
  // summed to nothing: the read is broken, not the month empty. Reporting 0 here
  // would clear the ceiling for any plan at all.
  if (discovered.length > 0 && seconds === 0) {
    return {
      seconds: 0, status: 'UNKNOWN', candidates, countedWorklogIds,
      reason: `JQL returned ${discovered.length} issue(s) with my time in ${fromIso}..${toIso} but the author-filtered sum is 0${sawAnyRow ? ' (rows exist, none mine)' : ' (no rows returned at all)'}`,
    }
  }

  return { seconds, status: 'OK', reason: '', countedWorklogIds, candidates }
}
