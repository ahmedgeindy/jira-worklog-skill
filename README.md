# jira-worklog

An agent skill for logging time to Jira through the [`twg`](https://developer.atlassian.com/) CLI.

You give it issue keys and hours. It reads live server state, shows you a preview, waits for you to
approve it, then writes one entry at a time with a guard on each side.

**Logging time is a write to a system of record that this skill cannot undo.** `worklog delete` and
`worklog update` are unreachable by construction — `assertArgvSafe` refuses to spawn them. Everything
here exists to make the write correct the first time.

---

## Before you try it

1. **`twg` installed and logged in.** `twg whoami` must print your name and account id.
2. **Node 18+.** Zero runtime dependencies; the tests use `node:test`.
3. **A Jira account whose worklogs you are allowed to write.**

```bash
npm test          # 252 tests, no network, no Jira access needed
```

## Install

Copy or symlink this directory to wherever your agent reads skills from:

| Harness | Location |
|---|---|
| Claude Code | `~/.claude/skills/jira-worklog/` or `<project>/.claude/skills/jira-worklog/` |
| Codex CLI | `~/.codex/skills/jira-worklog/` |

On Windows a junction avoids keeping two copies in sync:

```powershell
New-Item -ItemType Junction -Path "$env:USERPROFILE\.claude\skills\jira-worklog" -Target "<path to this repo>"
```

## First: check the safety model holds on YOUR machine

This is not boilerplate. The skill's guarantee depends on your harness raising a permission prompt
for the write line, and that is a property of **your** settings, not of the tool.

- **Claude Code** — read `references/claude-code.md`. Short version: `Bash(node *)` allowlisted so
  reads are quiet, and *no* blanket `PowerShell(*)` allow so writes still prompt. Verify empirically:
  run any trivial PowerShell command and confirm you get prompted.
- **Codex CLI** — read `references/codex.md`. Codex persists every "always allow" click as an
  argv-prefix rule, so a blanket `powershell.exe -Command` allow may already exist and pre-approve
  every write. Under Codex the procedure is different by design: the agent prints the line and
  **you** paste it, so consent does not depend on harness settings at all.

If PowerShell is blanket-allowed in your setup, the Claude Code gate is decorative. Use the Codex
procedure instead.

## Try it — one entry, one hour, one scratch issue

Do this before any backfill. It exercises the whole loop for the price of one worklog you can live
with.

```bash
# 1. plan — read-only. Prints a preview and a planHash.
echo 'YOUR-123 1h @09:00 :: trying out the worklog skill' \
  | node scripts/timelog.mjs plan --date 2026-01-15 --out plan.json

# 2. read the preview. Check the date, the hours, the resulting day total,
#    the STATUS line, and the literal command. Note the planHash.

# 3. emit the write line
node scripts/timelog.mjs emit --plan plan.json --date 2026-01-15 --expect-hash <planHash>

# 4. guard it  -> must print OK
node scripts/timelog.mjs check-cmd --plan plan.json --date 2026-01-15 \
  --expect-hash <planHash> --cmd "<the emitted line>"

# 5. run that exact line (see your harness's reference file for how)

# 6. verify it landed  -> must print "OK worklog <id>"
node scripts/timelog.mjs check-write --plan plan.json --date 2026-01-15 \
  --expect-hash <planHash> --key YOUR-123
```

Anything other than `OK` at step 4 or 6 stops the day. That is the design, not a bug.

### Backfilling several days

`plan --date a,b,c` applies the *same* entry lines to every date. When each day needs its own
comment, use manifest mode — one plan file per day, each with its own hash:

```bash
printf '2026-01-13\tYOUR-123 7h :: schema convergence\n2026-01-14\tYOUR-123 6h :: parity checks\n' \
  | node scripts/timelog.mjs plan --manifest --out-dir ./plans
```

Each day still gets its own gate, its own guards and its own writes. Only generation is batched.

---

## Worked example: a real work item, start to finish

Say you spent Tuesday 12 January on **HCFM-223**. Here is the whole loop with real output.

### Input formats — the issue is named by key or by URL

Every line is `<issue> <hours> [@HH:MM] [:: comment]`. All of these name the same work item:

```
HCFM-223 7.5h
hcfm-223 7.5h                                              # case is normalised
https://yoursite.atlassian.net/browse/HCFM-223 7.5h        # browse URL
https://yoursite.atlassian.net/jira/software/c/projects/HCFM/boards/12?selectedIssue=HCFM-223 7.5h
```

Hours accept `7.5h`, `7h 30m`, `450m`, `7:30`, or a bare `7.5` (meaning hours).
**`1d` and `1w` are refused** — on a Jira site `1d` is 8h, not 24h, and a silent 3× error on a
timesheet is not worth the convenience.

Pasting a URL is checked, not trusted: the host in the URL must match the site the key actually
resolves to, and the key is read from the **path**, so a poisoned `?jql=key=HCFM-999` cannot
override `/browse/HCFM-223`.

### 1. Plan — read-only, touches nothing

```bash
echo 'HCFM-223 7.5h @09:00 :: parity engine checkpoint resume fix, 2114 tests green' \
  | node scripts/timelog.mjs plan --date 2026-01-12 --out plan.json
```

```
DAY 2026-01-12 (Tuesday)
  already on server: 0.0h

  HCFM-223  7.5h  @09:00  (start PINNED by you)  [CLEAR]  (comment USER_SUPPLIED, not evidence-derived)
      comment: parity engine checkpoint resume fix, 2114 tests green
      & 'twg' 'jira' 'workitem' 'worklog' 'add' '--issue-id' 'HCFM-223' '--time-spent-seconds' '27000' '--started' '2026-01-12T09:00:00.000+0300' '--adjust-estimate' 'leave' '--notify-users' 'false' '--comment-format' 'plain' '--comment' 'parity engine checkpoint resume fix, 2114 tests green' '-o' 'json'

  resulting day total: 7.5h
  STATUS: MEETS the 7h floor

  planHash: 64c830368fd8
```

Read it. `[CLEAR]` means you have no time on that issue that day. `already on server` is what is
there now — **the day total counts existing time**, so this is how you see a day heading over.

### 2. Emit and guard

```bash
node scripts/timelog.mjs emit --plan plan.json --date 2026-01-12 --expect-hash 64c830368fd8
node scripts/timelog.mjs check-cmd --plan plan.json --date 2026-01-12 \
  --expect-hash 64c830368fd8 --cmd "<the emitted line, verbatim>"
# -> OK
```

`check-cmd` re-reads the server and compares the line byte-for-byte against the plan. `OK` also
leaves an approval token that step 4 consumes.

### 3. Run that exact line

Per your harness (`references/claude-code.md` or `references/codex.md`). Jira answers with the new
worklog id:

```
"started": "2026-01-12T09:00:00.000+0300",
"timeSpent": "7h 30m",
"id": "227701",
```

### 4. Verify it landed — against the server, not the response

```bash
node scripts/timelog.mjs check-write --plan plan.json --date 2026-01-12 \
  --expect-hash 64c830368fd8 --key HCFM-223
# -> OK worklog 227701
```

This re-reads Jira and finds the row by `started` + `timeSpentSeconds`. It catches the nasty case:
the call times out locally but Jira committed anyway. Retrying blind would double-log.

### Two entries on one work item, same day

Allowed only when each has its own explicit `@HH:MM` — otherwise it is indistinguishable from a
repeated line:

```
HCFM-223 1h   @11:00 :: daily standup
HCFM-223 2.5h @13:00 :: STC-BH data-bug investigation
```

### Several work items across several days

```bash
printf '%s\n' \
  '2026-01-12\tHCFM-223 7.5h @09:00 :: parity engine checkpoint resume fix' \
  '2026-01-13\tHCFM-223 4h   @09:00 :: pagination fix on 1.55M invitations' \
  '2026-01-13\tHCFM-345 1h   @11:00 :: daily standup' \
  | node scripts/timelog.mjs plan --manifest --out-dir ./plans
```

Ends with a scope table — one `--expect-hash` per day, and any day over the ceiling called out:

```
SCOPE: 2 days, 3 writes, plan files in ./plans
  2026-01-12   1 entry  MEETS   --expect-hash 64c830368fd8
  2026-01-13   2 entries MEETS  --expect-hash bf0e336821ea
```

### What a refusal looks like

Refusals are instructions, never stack traces. Re-running a day you already wrote:

```
  HCFM-223  7.5h  @09:00  [DUPLICATE]
...
ABORT: DUPLICATE at write time (unchanged from plan time — an earlier plan/write
for this day was never resolved) — refusing to write, stop this day and reconcile manually
```

A day heading somewhere implausible:

```
  STATUS: EXCEEDS - this day will hold 19.0h, over the 12.0h plausibility ceiling.
  VERIFY before approving.
```

A comment that does not sound like the work item it is going on:

```
      comment: rewrote the marketing landing page copy
      ?? this comment shares no wording with the issue "guided MSSQL->PG Migrator" -
         is this the right issue?
```

That last one is a warning, not a block — you decide.

---

## What it refuses to do

- **Invent hours.** No gap arithmetic, no suggesting an issue to absorb a shortfall.
- **Delete or update a worklog.** Not constructible.
- **Trust a zero.** A day total that cannot be positively controlled is `UNKNOWN`, and `UNKNOWN`
  aborts. A plausible wrong number is worse than an error.
- **Write more than 5 days under one approval.**
- **Write without a `--expect-hash` that matches the plan you approved.**

## Things that will bite you (all measured, not theorised)

- **`1d` is 8h on a Jira site, not 24h.** `d`/`w` units are refused outright; use hours or minutes.
- **`--started-after` with an ISO string is `parseInt`-truncated** to the year, i.e. epoch 1970. The
  filter silently becomes a no-op and returns everything. Integer epoch-ms only.
- **`--started-after` / `--started-before` are strictly exclusive.** A day window must be sent as
  `(dayStart - 1, nextDayStart)` or a 00:00:00.000 entry vanishes.
- **A per-issue worklog query returns every author.** There is no server-side author filter. One
  shared "team activities" issue measured roughly double the truth until filtered client-side.
- **twg injects no defaults**, so Jira's hostile ones apply: `adjustEstimate=auto` decrements the
  remaining estimate and `notifyUsers=true` emails every watcher. Every write here passes
  `--adjust-estimate leave --notify-users false --comment-format plain --started`.
- **Your Jira profile timezone is what counts**, not your machine's. They drift apart at DST
  boundaries, and an evening entry then lands on the wrong Jira day.
- **The work week is configurable per site.** This skill assumes Sunday–Thursday; if yours is
  Monday–Friday, change it before your first run or it will fabricate and skip the wrong days.

## Layout

```
SKILL.md                          the procedure the agent follows
references/claude-code.md         how a write executes under Claude Code, and why that is consent
references/codex.md               the same for Codex CLI - a different mechanism, for real reasons
references/twg-worklog-contract.md  13 sections, each quoting the command that proved it
scripts/timelog.mjs               CLI: plan / emit / check-cmd / check-write / verify
scripts/lib/                      tz, urls, twg, identity, daytotal, dedup, evidence, plan, preview
scripts/test/                     252 tests
```

## Reading the commit history

It is worth skimming. Most of the guards exist because something silently produced a plausible
wrong number, and the commit message says what and how it was caught. Several were found only by
running the thing against a real instance — reviewers reading the diff missed them.
