# The frozen twg worklog contract

Every item below was established by a live read-only probe against
`example.atlassian.net` on 2026-09-09/10, and each quotes the command that proved it so a
future maintainer can **re-verify rather than trust**. `scripts/preflight.mjs` re-asserts the five
mandatory flags at runtime; if it stops the run, start here.

twg version at time of probing: **1.2.7**. Binary is not on PATH:
`%LOCALAPPDATA%\Programs\twg\bin\twg.exe`.

---

## 1. Write contract — every `worklog add` carries all five

```
--time-spent-seconds <int>
--started <yyyy-MM-ddTHH:mm:ss.SSS+0300>
--adjust-estimate leave
--notify-users false
--comment-format plain
```

**twg injects no defaults**, so Jira's own defaults apply to anything omitted:
`adjustEstimate=auto` (decrements the remaining estimate) and `notifyUsers=true` (emails every
watcher — 12 worklogs on one issue in 6 seconds was observed as 12 emails).

> `twg help describe "jira workitem worklog add"` — options list carries no defaults for
> `--adjust-estimate` or `--notify-users`, and there is no `--dry-run`.

**`--started` is mandatory.** twg only trims the value; it does not validate it. Omitting it lets
Jira default `started` to the server receipt instant, which would collapse a multi-day backfill
onto today with exit 0 on every call. The read-observed format is the only known-good one:

> `worklog query --issue-id PROJ-3234` → `"started": "2026-06-01T12:52:00.000+0300"`
> — millis present, offset colon-less.

## 2. Time is seconds only — `1d` is 8h here, not 24h

> `worklog query --issue-id PROJ-141` → `timeSpent "1d 10m"` with
> `timeSpentSeconds 29400`. 29400 − 600 = 28800 = 8h.
>
> `twg api "jira:/rest/api/3/issue/PROJ-276?fields=timetracking"` →
> `originalEstimate "3d"`, `originalEstimateSeconds 86400` ⇒ 28800/day.
> **86400 also equals 24h — a deceptive coincidence.**

A 7h day cannot be expressed in `d`/`w` units at all. Never `--time-spent`; never a bare number
(Jira documents that as minutes); never both time flags — twg sends both with undefined precedence.

## 3. Both date bounds are STRICTLY exclusive

Proven to 1 ms in both directions:

> `--started-after 1776698400000` (== the row's exact `started`) → **0 rows**
> `--started-after 1776698399999` (1 ms earlier) → **1 row**
> `--started-before 1776698400000` → **0 rows**
> `--started-before 1776698400001` → **1 row**

A worklog started at exactly `00:00:00.000` local is therefore invisible to a naive day window.
`lib/tz.mjs#queryWindow` widens the lower bound by 1 ms; send `(dayStartMs - 1, nextDayStartMs)`.

## 4. Epoch bounds must be INTEGER MILLISECONDS

An ISO string is accepted with **no error** and silently parseInt-truncated, disabling the filter:

> `--started-after "2026-04-20T00:00:00+03:00"` → returned **all 5 rows**;
> request echo showed `"startedAfter": 2026` (= epoch 1970).

`lib/twg.mjs#assertEcho` guards this by comparing what was sent against the server's echo.

## 5. `meta.pagination.total` is the FILTERED count, and it is present even when empty

> `worklog query --issue-id PROJ-3234 --started-after 1780261199999 --started-before 1780347600000`
> (a one-day window on an issue with 12 lifetime worklogs) → `data` 1 row,
> `meta.pagination {startAt:0, maxResults:5000, total:1}`.
>
> Same issue, an **empty** window (2026-01-15) → `data` 0 rows,
> `meta.pagination {startAt:0, maxResults:5000, total:0}`.

So `rows.length !== meta.pagination.total` is a sound truncation check, and an **absent**
`meta.pagination.total` means a broken or unrecognised read — not an empty day. Do not add an
escape hatch for it.

**`pageInfo` is TOP-LEVEL in the envelope, not under `meta`.** `meta.pageInfo` does not exist.
The cursor is a plain decimal `startAt` offset string; `--after N` skips N.

## 6. A per-issue worklog query returns EVERY author

There is no server-side author filter. Every sum must filter client-side on the accountId from
`/myself`.

> `worklog query --issue-id PROJ-141` → 5 rows, all authored by a colleague, none by the caller.
> Measured on one real day: unfiltered **36h** vs a true **15h** (2.4×).

**Never derive identity from a worklog read.** `worklog query --first 1` returns whoever logged
first — on `PROJ-281` that is a colleague, not the caller. A wrong accountId poisons the day
total and the dedup filter simultaneously, and both produce plausible numbers with exit 0.

## 7. Identity and timezone come from `/myself`

> `twg api "jira:/rest/api/3/myself"` → `accountId`, `emailAddress`, `displayName`,
> `"timeZone": "Asia/Riyadh"`.
>
> `twg whoami` carries **no** timezone field.
> `twg api "jira:/rest/api/3/configuration"` → `401 Unauthorized; scope does not match`.

Cache only the **IANA name**, never a bare offset — an offset loses per-date DST correctness. The
machine here is `Africa/Cairo` (base UTC+02:00, currently +03:00); Egypt DST ends **2026-10-30**,
after which machine and Jira diverge by 1h. `EDT` in this environment's timestamps means **Egypt**
Daylight Time, not Eastern.

## 8. A zero is never proof of zero

> An unknown JQL field, a bogus `worklogAuthor` value, and the date format `27/Oct/25` all return
> **0 issues, exit 0, no error.** Only syntax errors raise.
>
> `work query` returned a well-formed `total: 0 / exact: false` body alongside a backend 500.

Treat `exit 3`, a non-empty `failures[]`, `meta.exact === false`, and a parse failure as
**UNKNOWN**, and abort. A false zero authorizes a full 7h overwrite.

## 9. Day totals need two steps

There is no cross-issue worklog command.

1. JQL discovery: `worklogAuthor = currentUser() AND worklogDate >= "D-1" AND worklogDate < "D+2"` —
   absolute dates, and **only `>=` and `<`**. `>` and `<=` silently round the bound to end-of-day.
2. A paged per-issue `worklog query`, author-filtered, asserting `collected == meta.pagination.total`.

Never use `workitem get`.worklog — it is hard-capped at `maxResults 20` (`PROJ-18` has 39). Never
use issue-level `timespent` — it is lifetime-all-authors (372.25h observed against a true 15.00h).
JQL `timespent` is **minutes**; REST is **seconds**.

`worklog changed --since` is unusable for a personal day total: site-wide, all authors, no issue
key, and keyed on `updatedTime` rather than `started`.

## 10. Response shapes

Comments are **ADF objects**, and the `comment` key is **absent** (not null) when there is none, so
a marker check must tree-walk for `type === 'text'` nodes and tolerate the missing key.

> `worklog query --issue-id PROJ-17` → `comment: {type:"doc", version:1, content:[{type:"paragraph",
> content:[{type:"text", text:"investigated the reported defect"}]}]}`
> All 12 rows on `PROJ-3234` have no `comment` key at all.

`data.issueId` is the **numeric** id; `data.self` ends with the **worklog** id
(`/issue/57826/worklog/188207`). Verify a write against the numeric id captured at resolve time —
comparing `self` to the issue key can never match.

`--expand properties` works and returns `properties: []` on every row here, so the machine-readable
fingerprint channel is readable but its round-trip is **unverified** until a live write tests it.

## 11. Resolution and permission

An unresolvable issue is a **hard stop, never a skip**: a nonexistent key and a no-permission key
return the identical string, `"Issue does not exist or you do not have permission to see it."`

Jira acceptance is not a correctness signal — resolved/Done issues accept worklogs with no
`--override-editable` (18/18 worklogs on `PROJ-39` postdate its resolution date).

twg resolves the cloud ID from the **host** in a pasted URL, so the host is worth asserting:

> `workitem get "https://someothercorp.atlassian.net/browse/PROJ-345"` → exit 1,
> `Failed to resolve cloud ID for site … 404`.

## 12. Shell and output

`twg -o json` does **not** print JSON to stdout — it names a temp file in a YAML block.
`--agent-fields` cannot index arrays; `--fields` is rejected on `workitem query`.

**Never append `2>&1` in PowerShell.** PS 5.1 wraps native stderr in ErrorRecords and sets `$?`
false on exit 0, destroying the only partial-failure signal (exit 0/1/3).

Build argv **arrays** and spawn with `shell: false`. There is no `--dry-run`, `--explain`, or
`--print-request` anywhere in twg, so any preview must be rendered from the exact argv.

## 13. Still unverified — closable only by a live write

- Whether `--properties-json` round-trips (every row here returns `properties: []`).
- Whether `--adjust-estimate leave` actually leaves the estimate. twg forwards the value verbatim
  with no client-side choices list, and the add response carries no timetracking fields, so a typo
  or a server-side rename falls through to Jira's `auto` and silently decrements.
  `check-write` **detects** the damage; it cannot prevent the first one.
- Which `--started` formats Jira accepts. Only the read-observed form is known-good; `+03:00` with
  a colon, `Z`, a missing `.SSS`, and an omitted offset are all untested.
- Whether `--site` is honoured on a write, and what happens when both time flags are sent.
- Whether an issue with `timetracking: {}` and zero worklogs ever (e.g. `PROJ-345`) can accept a
  worklog at all. Zero-history issues are ordered **first** within a day to surface this early.
- JQL search-index lag. Pasted keys bypass JQL for dedup (live REST), but day-total *discovery* is
  JQL (`meta.backend: agg`), so a worklog entered in the Jira UI minutes earlier can be missed.
