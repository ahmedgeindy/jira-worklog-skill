---
name: jira-worklog
description: Use when logging time to Jira from issue URLs or keys with hours, reviewing what is already logged for a day, or checking a day against the 7h policy floor. Drives scripts/timelog.mjs through plan, a human gate, guarded writes, and verify — against Asia/Riyadh Jira days and a Sunday–Thursday work week. Handles backdating, duplicate detection against live server state, evidence-backed worklog comments, and estimate protection. Use for "log my time", "log 3h on HCFM-323", "what did I log yesterday", "check my day against policy", or a pasted list of Jira URLs with hours.
---

## Overview

Logging time is a write to a system of record that this skill **cannot undo** — `worklog delete`
and `worklog update` are unreachable by construction. Everything here exists to make the write
correct the first time.

All arithmetic lives in `scripts/timelog.mjs`. Do not reproduce it in prose, do not compute hours
or day boundaries yourself, and do not paraphrase the twg flags — the frozen contract is in
`references/twg-worklog-contract.md`, and the script asserts it at runtime.

Load `Skill(twg-jira)` for Jira semantics rather than restating them.

**The script never spawns a write.** `assertArgvSafe` refuses to spawn `worklog add` at all, so no
code path inside `scripts/` can commit time. Writes exist only as literal PowerShell lines that
`emit` renders for a human to see, carrying the real issue key, seconds and timestamp.

*Who executes that line, and what makes executing it a consented act, is harness-specific* — the
reasoning does not transfer between harnesses and must not be guessed. Read the file for the
harness you are in **before step 5**:

| Harness | File |
|---|---|
| Claude Code | `references/claude-code.md` |
| Codex CLI | `references/codex.md` |

If you are in neither, stop at the gate and say so. Do not improvise a write path.

## Safety rails

0. **Consent comes from a human in chat.** If this session is a subagent, a background task, a
   piped/print run, or `codex exec`, produce the preview and stop. Never issue a write line.
   `codex exec` has no `--ask-for-approval` flag in any form — there is no human in it (measured
   2026-09-11, codex-cli 0.153.4).
1. **Never create hours the user did not state.** No gap arithmetic, no suggested issue to absorb
   a shortfall.
2. **Never delete or update a worklog**, and never pass `--override-editable`. Not constructible.
3. **Every write line comes from `emit`.** Never hand-type or edit one.
4. **Every write is preceded by `check-cmd` and followed by `check-write`.** No exceptions.
5. **A zero that cannot be positively controlled is UNKNOWN, and UNKNOWN aborts.** Report it; do
   not retry into a write.
6. **Paste the preview verbatim.** Never summarize it, never author the user's acknowledgement.
7. **Halt the whole day on the first failure** and report the exact boundary — which entries
   landed, which did not.

## Procedure

### 1. Collect

Issue URLs or keys, hours for each, and the target date. If the user says "today" or "yesterday",
resolve it to an explicit `YYYY-MM-DD` and **say which date you resolved it to**.

Input is one entry per line on stdin:

```
HCFM-323 3h
https://istnetworks-dev.atlassian.net/browse/HCFM-345 2h
HCFM-350 2h :: reviewed the migrator PR and fixed the parity check
```

`3h`, `2.5h`, `90m`, `1h 30m`, `1:30` and a bare `7` (meaning hours) all parse. `d`/`w` units are
refused on purpose — on this site `1d` is 8h, not 24h.

Everything after ` :: ` is a **user-supplied comment**. Use it whenever the user tells you what
they did; it is also the only way to log an issue whose Jira activity that day is too thin to
describe itself. Without it the comment is composed from that issue's changelog and must quote it.

### 2. Check the calendar before planning

The work week is **Sunday–Thursday**. If the target date is a Friday or Saturday, show the
resolved date and the weekday spelled out, and ask the user to **restate the date**. Do not accept
a bare "yes" — a weekend target is far more often a date-resolution mistake than a real shift.

Before any multi-day run, ask the user to name leave days and public holidays in the range and
exclude them before the first preview. Never infer leave from Jira.

### 3. Plan

```
node skills/jira-worklog/scripts/timelog.mjs plan --date <YYYY-MM-DD> --out plan.json
```

Entry lines go in on stdin. The command prints the gate preview and writes `plan.json`.

`plan` aborts rather than guess when: a day total cannot be positively controlled; an issue does
not resolve; the pasted host does not match the resolved site; a date is in the future; the
machine's calendar date and the Jira calendar date currently disagree; or two lines name the same
issue. Report the abort and its reason — do not work around it.

### 4. Gate

**Paste the rendered preview verbatim into chat.** It shows every entry, its evidence, the literal
command, the resulting day total, the 7h verdict, and a `planHash`.

Ask the user to confirm **this date and these rows**. One confirmation authorizes exactly what is
on screen. A blanket "yes to everything" is not consent to a later plan.

Labels the user needs to see and you must not gloss over:

- `USER_SUPPLIED` — that comment is the user's own words.
- `hours DERIVED by the model` — you split a stated total across issues rather than being given
  each number. Say so out loud and get it confirmed separately.
- `EXISTING` — the user already has time on that issue for that day. It is still writable; the
  gate is where they decide.

### 5. Write, one entry at a time

`--expect-hash` is **mandatory** on every command below. Use the `planHash` prefix printed at the
gate — it is what binds the approval to the artifact.

```
node skills/jira-worklog/scripts/timelog.mjs emit --plan plan.json --date <D> --expect-hash <hash>
```

Then, for each emitted line **in the order given**:

1. `node ...\timelog.mjs check-cmd --plan plan.json --date <D> --expect-hash <hash> --cmd "<line>"`
   → must print `OK`.
2. Execute that exact line, unmodified, **by the mechanism your harness's reference file
   specifies** — `references/claude-code.md` or `references/codex.md`. The two differ in who runs
   the line and in what supplies the consent; picking the wrong one removes the human. Never
   substitute one for the other, and never invent a third.
3. `node ...\timelog.mjs check-write --plan plan.json --date <D> --expect-hash <hash> --key <KEY>`
   → must print `OK worklog <id>`.
4. Anything other than `OK` at step 1 or 3: **stop the whole day.** Report which entries landed.

`check-cmd` leaves an approval token that `check-write` consumes. Skipping step 1 makes step 3
report `GUARD BYPASSED`. Nothing can *prevent* a skipped guard once the trigger is outside the
script — this is what makes it loud.

### 6. Verify

```
node skills/jira-worklog/scripts/timelog.mjs verify --plan plan.json
```

Report the per-day verdict and repeat the script's caveat about what `PASS` does and does not
prove. `UNKNOWN` is not a pass.

## The 7h floor

Policy is **≥ 7h per working day**. This skill logs the hours the user states, then reports the
day as `SHORT` when the server total falls under the floor, and records that fact in the day's
worklog comments so it is visible to a reviewer.

It never computes what would close the gap and never proposes an issue to absorb it. Do not do
either yourself.

**To close a short day:** re-run `plan` for the same date with additional entries. The day-total
read sees the existing time, so the new entries land on top of it with dedup intact.

## Duplicate states

- `CLEAR` — nothing of the user's on that issue/day.
- `EXISTING` — the user has time there already, at a different duration. Writable; the gate decides.
- `DUPLICATE` — same issue, same day, same duration, or this exact plan entry already written.
  **Refused at write time**, always. If the user genuinely worked two identical-length sessions on
  one issue in a day, combine them into one entry rather than trying to write both.
- `AMBIGUOUS` — a row came back without an author. Refused; investigate before writing.

## Scope limits

- **Max 5 days per run.** Print the full scope before the first gate: days, total hours, number of
  writes, number of runs.
- **One `planHash` covers every day in a plan**, so the user cannot approve day one and refuse day
  two. For a first run, or any run you are not certain of, **plan a single day at a time**.
- A day with no evidence and no user-supplied comments is presented as *"no evidence you worked —
  skipping"*. It needs the user to affirmatively add it.

## When something is wrong

Say what failed, the resolved host, the date, and the exact reason the script gave. Never ask the
user to interpret a stack trace, and never re-run a failed write "to see if it works this time" —
a write that timed out locally may already have committed, which is what `check-write` is for.
