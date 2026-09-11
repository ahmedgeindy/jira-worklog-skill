# Harness: Claude Code — how a write gets executed

Read this at **step 5.2** of `SKILL.md`. It covers only the write-execution step; every other rail,
`--expect-hash`, the approval token and `check-write` are shared and unchanged.

## The mechanism

Run the emitted line **as your own PowerShell tool call**, exactly as `emit` produced it.

## Why that is a consented act here

Verified in `/path/to/repo\.claude\settings.local.json`:

- `Bash(node *)` is allowlisted.
- `ask` and `deny` are both **empty**.
- There is **no broad `PowerShell(*)` rule**.

So the asymmetry that carries the safety argument is: anything the *script* runs via Node is
pre-approved and silent, while a PowerShell tool call the *agent* issues still raises a permission
prompt. That prompt renders the real issue key, seconds and timestamp, and it is the human's last
look at the payload before it commits.

This is why `assertArgvSafe` refuses to spawn `worklog add`: without that refusal, a script could
commit time through the allowlisted `node` path with no prompt at all.

**This paragraph is specific to this machine's settings file.** It is not a property of Claude
Code in general, and it is false under Codex — see `references/codex.md`. If the settings file
changes (a `PowerShell(*)` allow appears, or `deny` stops being empty), re-derive it before
trusting it.

## If the prompt does not appear

Stop. A write line that executes without a prompt means the asymmetry above no longer holds, and
the gate has silently become decorative. Report it rather than continuing the day.
