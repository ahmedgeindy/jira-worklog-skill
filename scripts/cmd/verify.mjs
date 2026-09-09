// skills/jira-worklog/scripts/cmd/verify.mjs
const FLOOR_SECONDS = 7 * 3600

/**
 * Independent post-run read. Recomputes the 7h verdict from SERVER state, so a
 * day that became short during apply (a skipped duplicate, an aborted entry) is
 * surfaced with the same prominence as a plan-time short.
 */
export function runVerify({ plan, deps }) {
  const days = plan.days.map((d) => {
    const keys = (d.entries ?? []).map((e) => e.key)
    const dt = deps.dayTotal({
      zone: plan.zone, accountId: plan.accountId, isoDate: d.date, extraKeys: keys,
    })
    const verdict = dt.status !== 'OK'
      ? 'UNKNOWN'
      : (dt.seconds >= FLOOR_SECONDS ? 'PASS' : 'SHORT')
    return {
      date: d.date, verdict,
      serverSeconds: dt.seconds, serverHours: (dt.seconds / 3600).toFixed(2),
      reason: dt.reason, countedWorklogIds: dt.countedWorklogIds ?? [],
    }
  })

  return {
    days,
    exitCode: days.every((d) => d.verdict === 'PASS') ? 0 : 1,
    caveat:
      'PASS proves the server now reports >= 7h authored by this account on this day. ' +
      'It does not prove the hours are accurate, that they describe work this human personally did, ' +
      'or that the issue keys were the intended ones.',
  }
}
