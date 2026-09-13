# jira-worklog

An agent skill for logging time to Jira through the [`twg`](https://developer.atlassian.com/) CLI.

You give it issue keys and hours. It reads live server state, shows you a preview, waits for you to
approve it, then writes one entry at a time with a guard on each side.

**Logging time is a write to a system of record that this skill cannot undo.** `worklog delete` and
`worklog update` are unreachable by construction — `assertArgvSafe` refuses to spawn them. Everything
here exists to make the write correct the first time.

---

## Before you try it

Two things, and setup handles the rest:

1. **Node 18+ and npm.** Zero runtime dependencies; the tests use `node:test`.
2. **A Jira account whose worklogs you are allowed to write**, and one `twg login`.

You do **not** need to install twg yourself — setup does it. The only step it cannot
do for you is signing in, because that is an interactive browser login; it tells you
the exact command when it is needed.

```bash
npm test          # 287 tests, no network, no Jira access needed
```

## Install

One command, on a fresh machine:

```bash
npx <package-name>@latest setup
```

```
  ✓ Node.js       v22.14.0
  ✓ npm           v11.5.1
  ✓ twg           v1.2.8 (installed)
  ✓ Jira sign-in  Your Name
  ✓ dependencies  none required (zero runtime dependencies)
  ✓ jira-worklog  v1.0.0 (new) — 2 locations
  ✓ verification  264 tests pass from the installed copy

Ready.
```

That is the whole onboarding. There is no second command, and no flag a teammate
has to know about: if twg is missing it is installed, and if it is present it is
upgraded.

Every line can only appear by actually being true. `twg` runs the binary,
`Jira sign-in` runs `twg whoami`, and `verification` runs the installed copy's own
test suite from the directory it was installed into. Any check that fails prints
`✗`, says exactly what to run, and exits 2 — nothing after it is reported as fine.

From a clone instead of npm:

```bash
git clone https://github.com/ahmedgeindy/jira-worklog-skill.git
cd jira-worklog-skill
npm run setup       # same thing
```

| Harness | Where the skill lands |
|---|---|
| Claude Code | `~/.claude/skills/jira-worklog/` |
| Codex CLI | `~/.codex/skills/jira-worklog/` |

A harness whose config directory does not exist is skipped with a `-` line. If
*neither* exists that is a failure — installing nowhere is not success.

**Flags** (none of them needed for normal use): `--no-install-twg` leaves twg alone
when it is missing; `--no-upgrade` skips `twg upgrade`; `--link` symlinks instead of
copying, for people working *on* the skill (refused under `npx`, where the source is
a cache npm prunes); `--force` replaces a directory that is not this skill.

### Updating, and running it twice

`npx <package-name>@latest setup` is also the update command. Re-running is safe:

- the installed copy carries `.jira-worklog-install.json`, so setup reports what
  actually happened — `v1.0.0 (new)`, `v1.0.0 (current, reinstalled)`, or
  `v1.0.0 → v1.0.1 (updated)` — rather than claiming an update it did not make;
- `twg upgrade` runs, which is a no-op when twg is already current;
- **only** `jira-worklog` is touched. Every other skill directory beside it is left
  exactly as it was, and a directory that is not this skill is refused rather than
  replaced.

Use `@latest`: npx caches aggressively, and without it you can silently re-run an
old version.

### If twg is missing

twg is a standalone binary and is **not** on npm — it needs no Node at all. Setup
installs it for you, using Atlassian's own installer from Atlassian's own domain:

| Platform | What setup runs |
|---|---|
| Windows | downloads `https://teamwork-graph.atlassian.com/cli/install.ps1`, then `powershell -NoProfile -ExecutionPolicy Bypass -File <it> -Yes -SkipLogin -SkipSkills` |
| macOS / Linux | downloads `https://teamwork-graph.atlassian.com/cli/install`, then `bash <it> --yes --skip-login --skip-skills` |

Docs: <https://developer.atlassian.com/platform/teamwork-graph/twg-cli/getting-started/installation/>

The exact command is printed before it runs. Three details worth knowing:

- **`--skip-login`** — the installer would otherwise open an interactive browser
  login, which cannot complete inside a non-interactive setup and would hang it.
  Signing in stays a separate, visible step.
- **`--skip-skills`** — the installer would otherwise install twg's own agent-skill
  bundles. That is a side effect on directories you did not ask this command to
  touch.
- **The installer updates your user `PATH` and says "open a new terminal."** Setup
  cannot open one, so it looks for the binary directly in the documented install
  directory (`%LOCALAPPDATA%\Programs\twg\bin`, or `~/.local/bin`) instead of
  trusting a `PATH` that will not refresh until your next shell. You will still want
  a new terminal before running `twg` yourself, and setup says so.

Nothing else is ever downloaded — no mirrors, no third-party URLs, no other
binaries. If the install fails for any reason, setup exits 2 and prints the official
commands rather than continuing as though twg were present.

### If you are not signed in to Jira

Setup fails that check and quotes twg's own error and its own fix — not a guess:

```
  ✗ Jira sign-in  You're not signed in. Run `twg login --force` to authenticate...
      run:  twg login --force

Not ready. Fix the ✗ lines above and run this again.
```

Exit code 2. It does not pretend the machine is ready.

### One check setup cannot do for you

Open a **new** agent session and confirm the skill is listed. A copied file is not
proof the harness found it; discovery is the harness's job. On Claude Code you
should see `jira-worklog` in the skill list, and asking for it by name should pull
it in.

### About `twg upgrade` running unattended

Measured on twg 1.2.8, 2026-09-13. Its help text says it will "silently refresh
detected installed skills with overwrite", which reads alarming. What it actually
does:

- when the binary is already current, it is a **complete no-op** — it does not even
  run the skills refresh;
- when forced (`--refresh-skills`), it rewrote **only** `.twg-install.json`
  timestamps inside twg's own `twg-*` bundles. A canary skill directory sitting
  beside them came through byte-identical, and the file count was unchanged.

That is why step 2 is safe to run without asking.

**What that did not measure:** twg was already current, so the path where it
genuinely upgrades never ran. That path does download and execute Atlassian's
own installer under `-y`. That is twg updating itself from its own vendor, which
is a different thing from this script picking a URL to fetch a binary from — but
if you would rather make that call yourself, pass `--no-upgrade` and run
`twg upgrade` by hand. Re-measure if twg's behaviour changes.

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

## How to ask for it — writing a prompt that works

You talk to this skill in ordinary language. The agent turns what you say into the
`plan / emit / guard / verify` loop below. So the prompt only has to be **specific**,
not formatted.

A prompt that works:

```
Use the jira-worklog skill. Issue PROJ-223. Every Sunday-Thursday from
2026-08-02 to 2026-09-13, 7.5h starting @09:00. Skip any day that already
has my time on it. Show me the day-by-day plan before writing anything.
```

Five things make that one work, and each is a real mistake somebody made first.

**1. Name the work item, and name the right one.**
`PROJ-223`, not "this task" or "the migration one". The skill logs where you point
it. The most expensive mistake available here is a confidently-executed backfill
onto the wrong key — the hours are right, the dates are right, and 230 hours land
on somebody else's issue.

**2. Give explicit dates, never relative ones.**
"last month until now" means one thing in your head and a different thing next
Tuesday. Worse, it is silent about days that already hold time. Write
`2026-08-02 to 2026-09-13` and say what to do about days that already have
something: *skip*, or *add on top*. That single clause is the difference between
7.5h days and 19h days.

**3. Write hours the skill can't misread.**
`7.5h` or `7h30m`. `7:30` and `7:30h` also work now — but an earlier version read
`7:30h` as **thirty hours**, because the scanner matched the `30h` and threw the
rest away. Exit code 0, plausible number, four times the real time. Fixed, tested,
and the reason `d`/`w` units are refused outright: on a Jira site `1d` is usually
8h, not 24h, and guessing wrong there is a 3× error nobody notices.

**4. Ask for the plan before the write.**
"Show me the day-by-day plan before writing anything." The skill is built to stop
there anyway, but saying it out loud means you get the table — date, hours, running
day total, and the `STATUS` of each day — while it is still free to change your mind.

**5. Don't ask it to invent the comment text.**
"write the details from our work history" is **not something this skill does.** It
grounds a comment in the issue's own Jira changelog, or in words you supply. Given
neither, it refuses with `no evidence for this issue on this day; the comment must
come from the user` — on purpose. A worklog comment is a claim about what a person
did; a plausible-sounding guess is the one thing worse than a blank.

If you do want comments, hand it the material:

```
...7.5h @09:00, and use these notes for the comments: <paste your standup
notes, or point me at the file>. One line per day, no invention.
```

or just let it fall back to the changelog:

```
...7.5h @09:00, comments from each issue's own Jira history where there is any,
blank where there isn't.
```

### The same prompt, written badly

For contrast — this is a real first draft, and every numbered problem above is in it:

```
/jira-worklog use this task PROJ-133 log all last month until now our working
daily on migration 7:30h and for details log write getting from our history
working on it
```

`/jira-worklog` resolved to nothing — not because the slash form is wrong, but
because the skill was not installed anywhere the harness looks. `npm run setup`
fixes that; afterwards, asking for the skill by name always works, and clients
that expose skills as slash commands will offer it as `/jira-worklog` too.
Then: `PROJ-133` was the wrong issue; "last month until now" is unresolvable;
`7:30h` used to mean 30 hours; and "from our history" asks for something the
skill refuses to do.

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

Say you spent Tuesday 12 January on **PROJ-223**. Here is the whole loop with real output.

### Input formats — the issue is named by key or by URL

Every line is `<issue> <hours> [@HH:MM] [:: comment]`. All of these name the same work item:

```
PROJ-223 7.5h
proj-223 7.5h                                              # case is normalised
https://yoursite.atlassian.net/browse/PROJ-223 7.5h        # browse URL
https://yoursite.atlassian.net/jira/software/c/projects/HCFM/boards/12?selectedIssue=PROJ-223 7.5h
```

Hours accept `7.5h`, `7h 30m`, `450m`, `7:30`, or a bare `7.5` (meaning hours).
**`1d` and `1w` are refused** — on a Jira site `1d` is 8h, not 24h, and a silent 3× error on a
timesheet is not worth the convenience.

Pasting a URL is checked, not trusted: the host in the URL must match the site the key actually
resolves to, and the key is read from the **path**, so a poisoned `?jql=key=PROJ-999` cannot
override `/browse/PROJ-223`.

### 1. Plan — read-only, touches nothing

```bash
echo 'PROJ-223 7.5h @09:00 :: parity engine checkpoint resume fix, 2114 tests green' \
  | node scripts/timelog.mjs plan --date 2026-01-12 --out plan.json
```

```
DAY 2026-01-12 (Tuesday)
  already on server: 0.0h

  PROJ-223  7.5h  @09:00  (start PINNED by you)  [CLEAR]  (comment USER_SUPPLIED, not evidence-derived)
      comment: parity engine checkpoint resume fix, 2114 tests green
      & 'twg' 'jira' 'workitem' 'worklog' 'add' '--issue-id' 'PROJ-223' '--time-spent-seconds' '27000' '--started' '2026-01-12T09:00:00.000+0300' '--adjust-estimate' 'leave' '--notify-users' 'false' '--comment-format' 'plain' '--comment' 'parity engine checkpoint resume fix, 2114 tests green' '-o' 'json'

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
  --expect-hash 64c830368fd8 --key PROJ-223
# -> OK worklog 227701
```

This re-reads Jira and finds the row by `started` + `timeSpentSeconds`. It catches the nasty case:
the call times out locally but Jira committed anyway. Retrying blind would double-log.

### Two entries on one work item, same day

Allowed only when each has its own explicit `@HH:MM` — otherwise it is indistinguishable from a
repeated line:

```
PROJ-223 1h   @11:00 :: daily standup
PROJ-223 2.5h @13:00 :: data-bug investigation
```

### Several work items across several days

```bash
printf '%s\n' \
  '2026-01-12\tPROJ-223 7.5h @09:00 :: parity engine checkpoint resume fix' \
  '2026-01-13\tPROJ-223 4h   @09:00 :: pagination fix on 1.55M invitations' \
  '2026-01-13\tPROJ-345 1h   @11:00 :: daily standup' \
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
  PROJ-223  7.5h  @09:00  [DUPLICATE]
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
      ?? this comment shares no wording with the issue "data import tool" -
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
- **`7:30h` used to parse as 30 hours.** The h/m scanner is a global match, so it found the `30h`
  inside the clock form and discarded the `7:`. Exit 0, plausible number, 4x the intended time. A
  `:` now commits the string to `H:MM` and anything else after it is refused rather than guessed at.
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

## Distribution

GitHub is the source of truth; npm is the delivery channel. Releases are cut from a
tag and published by `.github/workflows/publish.yml` using npm trusted publishing
(OIDC) — there is no publish token in this repository.

**Not published yet.** `package.json` still carries `"private": true`, which makes
`npm publish` refuse. That is a deliberate catch, not an oversight: see
[RELEASING.md](RELEASING.md) for the first-release procedure, which cannot be
automated because npm will not configure a trusted publisher for a package that does
not exist yet.

Before any release, two gates run against the tarball that would actually ship:

```bash
npm run audit:selftest   # plants a credential and requires the scanner to catch it
npm run audit            # scans the real packed tarball, not the working tree
npm run audit:public     # stricter, for a public package
```

The audit exists because a one-time manual check does not survive a second release.
It has already caught one real leak: a test fixture that was a raw `worklog query`
capture carrying a colleague's Jira identity and a customer's incident description.

## Layout

```
SKILL.md                          the procedure the agent follows
references/claude-code.md         how a write executes under Claude Code, and why that is consent
references/codex.md               the same for Codex CLI - a different mechanism, for real reasons
references/twg-worklog-contract.md  13 sections, each quoting the command that proved it
scripts/setup.mjs                 `npm run setup` - verify twg, self-update it, install the skill
scripts/timelog.mjs               CLI: plan / emit / check-cmd / check-write / verify
scripts/lib/                      tz, urls, twg, twgstatus, identity, daytotal, dedup, evidence, plan, preview
scripts/test/                     264 tests (287 with the tools/ suites)
tools/                            release gates, NOT shipped in the package
  pkgaudit.mjs                    the forbidden-content rules (pure, unit tested)
  audit-package.mjs               packs a real tarball and scans what would ship
  e2e-setup.mjs                   12 scenarios against the installed tarball
```

## Reading the commit history

It is worth skimming. Most of the guards exist because something silently produced a plausible
wrong number, and the commit message says what and how it was caught. Several were found only by
running the thing against a real instance — reviewers reading the diff missed them.
