# Harness: Codex CLI — how a write gets executed

Read this at **step 5.2** of `SKILL.md`. It covers only the write-execution step; every other rail,
`--expect-hash`, the approval token and `check-write` are shared and unchanged.

Measured against **codex-cli 0.153.4** on Windows, 2026-09-11. Full evidence in
`docs/superpowers/specs/2026-09-11-jira-worklog-codex-port.md`.

## The mechanism: the human pastes

```
emit → check-cmd (writes the approval token)
     → PRINT the line and STOP
     → the human pastes it into their own PowerShell window
     → check-write → verify
```

**Print the line. Do not execute it. Do not offer to execute it.** Say plainly that the user runs
it themselves and that you will wait.

Then continue at step 5.3 (`check-write`) once they confirm it ran. `check-write` reads live server
state, so it verifies the write actually landed — you are not taking their word for it.

## Why the Claude Code reasoning does not transfer

Do **not** carry over the sentence "`Bash(node *)` is allowlisted here with an empty ask/deny
list." It is a fact about one `settings.local.json` and is false here. Three measured reasons:

**1. A blanket rule already pre-approves every PowerShell command.**
`~/.codex/rules/default.rules` line 255 is a two-element prefix:

```
prefix_rule(pattern=["C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "-Command"], decision="allow")
```

It matches *any* `powershell.exe -Command <anything>`. One "always allow" click generalized into a
standing allow. 78 of the 414 rules in that file are similarly broad.

Deleting line 255 is hygiene, **not** a fix — the next such click regenerates one. This design
therefore assumes the rules file is dirty and does not depend on it.

**2. `on-request` is model-decided, not harness-enforced.**
`codex --help` defines it as *"The model decides when to ask the user for approval."* An
instruction telling the model not to write is exactly as strong as the model's compliance with it,
which is not a safety mechanism.

**3. `codex exec` has no human in it at all.**
`--ask-for-approval` exists only on the interactive `codex` TUI; `codex exec` rejects the flag
outright. The enum is `on-request | never`.

## Hard refusals under Codex

- **Refuse to run under `codex exec`.** Produce the preview and stop (rail 0).
- **Refuse** `--dangerously-bypass-approvals-and-sandbox`, `--ask-for-approval never`, and
  `--approve-for-me` for any session running this skill. Each removes the human entirely.
- **Never** execute the write line yourself, by any tool, under any phrasing of the request. The
  paste step *is* the consent.

## What still protects you here

Under Codex the scripts run **unprompted** — line 255 sees to that. That is safe only because
`assertArgvSafe` refuses to spawn `worklog add`, so no script path can commit time no matter what
invokes it. **That invariant carries more weight under Codex than under Claude Code, not less.**
Never relax it, and never add an `apply` subcommand.

Everything else fires unchanged: `--expect-hash` binding, the `check-cmd` approval token,
`GUARD BYPASSED` on a missing token, and the estimate-clobber comparison in `check-write`.

## Troubleshooting: twg says "Unable to connect"

```
$ codex sandbox -- twg.exe whoami
Unable to connect. Is the computer able to access the url?
```

**This message is misleading — it is not a network problem.** Measured from inside the same
sandbox, with filesystem enforcement demonstrably active (`EPERM` writing to `C:\Users\AG-Dev\`):

```
$ codex sandbox -- node -e "fetch('https://istnetworks-dev.atlassian.net/status',{method:'HEAD'})..."
NET_OK 200
```

The real cause is that twg's own state lives under the tree the Windows restricted-token sandbox
blocks:

- `%APPDATA%\twg\` — `auth.conf`, `auth_oauth.conf`, `consent.json`
- `%LOCALAPPDATA%\twg\Cache\`

Likely remedy, **untested as of 2026-09-11**:

```
codex --add-dir "%APPDATA%\twg" --add-dir "%LOCALAPPDATA%\twg"
```

Do not reach for `--sandbox danger-full-access` to make the symptom go away. Verify the `--add-dir`
form first and record the result here.

## Prerequisite

If `codex doctor` reports `✗ config could not be loaded`, Codex cannot execute anything — not this
skill, not a sandbox probe. On this machine that was a zeroed `~/.codex/config.toml` (6597 NUL
bytes) producing `TOML parse error at line 1, column 6598`. Fix it before running any of the above.

## Unresolved

Do not guess these into a procedure. Each needs a working Codex and a real session:

1. Whether Codex reads a **project-level** skills directory.
2. `AGENTS.md` discovery and merge order; whether Codex reads `CLAUDE.md` at all.
3. The effective **default** `approval_policy` (the enum is known; no `[default:]` is documented).
4. Whether a **project** `.rules` file can `deny` what the user file `allow`s.
5. Whether `--add-dir` actually fixes the twg sandbox failure above.
6. Whether Codex follows directory junctions when scanning `~/.codex/skills`.
