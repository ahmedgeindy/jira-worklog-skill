# Harness: Claude Code — how a write gets executed

Read this at **step 5.2** of `SKILL.md`. It covers only the write-execution step; every other rail,
`--expect-hash`, the approval token and `check-write` are shared and unchanged.

## The mechanism

Run the emitted line **as your own PowerShell tool call**, exactly as `emit` produced it.

## Why that is a consented act — VERIFY THIS ON YOUR MACHINE FIRST

The safety argument rests on an **asymmetry in your own permission settings**, not on anything
intrinsic to Claude Code. It holds when:

- `Bash(node *)` is allowlisted — so the scripts' reads run without pestering you, and
- there is **no broad `PowerShell(*)` allow**, and `deny` does not interfere — so a PowerShell tool
  call the *agent* issues still raises a permission prompt.

That prompt renders the real issue key, seconds and timestamp, and it is the human's last look at
the payload before it commits. It is also why `assertArgvSafe` refuses to spawn `worklog add`:
without that refusal a script could commit time through the allowlisted `node` path silently.

**Check your own settings before the first live write.** Open `.claude/settings.local.json` (and
your user-level settings) and confirm there is no `PowerShell(*)`-style blanket allow. A quick
empirical check is better than reading the file: run any trivial PowerShell command and confirm
you are prompted.

If PowerShell is blanket-allowed in your setup, this asymmetry does not exist and the gate is
decorative — use the Codex procedure in `references/codex.md` instead, where the human pastes the
line themselves and consent does not depend on harness settings at all.

## If the prompt does not appear

Stop. A write line that executes without a prompt means the asymmetry above no longer holds, and
the gate has silently become decorative. Report it rather than continuing the day.
