# Releasing

Distribution is npm; the source of truth stays this GitHub repo. Everything below is
verified against npm's docs and this repo's own tooling, 2026-09-13.

## Before anything: the gates

```bash
npm test                      # full suite, no network, no Jira access
npm run audit:selftest        # proves the audit can still catch a planted credential
npm run audit                 # what the tarball ACTUALLY contains (private rules)
npm run audit:public          # stricter: also fails on org-identifying strings
npm run e2e                   # 12 scenarios against the installed tarball
```

`npm run e2e` is the one that catches what unit tests cannot. It packs, installs the
tarball into a throwaway prefix, and runs the package bin from a different cwd
against a disposable `HOME`, asserting an exit code *and* substrings for each of:
clean install, repeat run, twg present, twg missing, Jira auth missing, a foreign
directory in the target path, unrelated skills beside ours, no harness directory at
all, `--link` under npx, junction-target survival, and an unknown subcommand.

Running setup from the repo is not a substitute. The repo's own directory happens to
contain the right files, which is exactly how a dropped `cwd` went unnoticed while
the verification step confidently reported passes it had collected from the repo
rather than from the installed copy.

### Where each platform is proven

| Platform | How | What it covers |
|---|---|---|
| Windows | `npm run e2e` locally | all 12 scenarios, signed in |
| Linux | `.github/workflows/e2e.yml` (`ubuntu-latest`) | fresh-machine auto-install + 13 scenarios |
| macOS | same workflow (`macos-latest`) | fresh-machine auto-install + 13 scenarios |

A GitHub runner has no Jira session, so the harness takes `--no-jira`: it then
requires every other check to tick and the **only** failure to be sign-in. Asserting
merely "exit 2" would pass for a run that failed for six unrelated reasons.

`--allow-twg-install` adds the auto-install scenario, which downloads and runs the
vendor installer for real. It refuses to run unless `HOME` is inside the harness's own
workspace — the installer appends to the shell profile at `$HOME`, which on a
developer machine is their `.zshrc`.

Running the Unix path on real Unix found two bugs that Windows could not: `rmdirSync`
on a POSIX symlink throws `ENOTDIR` (so `--link` then re-run *crashed*), and the shell
installer wipes `INSTALL_DIR_OVERRIDE` from the environment at line 20, so redirecting
the install needs the `--install-dir` flag instead.

`npm run audit` packs a real tarball and scans the extracted files, because the
`files` whitelist — not the working tree — decides what ships. Auditing the source
directory would be a check that passes against the wrong thing.

### The one thing the audit cannot check

Every rule in `tools/pkgaudit.mjs` matches a SHAPE — a token, a key, a host, an id.
Nothing matches arbitrary prose, and captured prose is where real data actually
hides. A raw `worklog query` capture pasted into a fixture carries a colleague's
name, a customer's name and an incident description, and only the first two are
shaped like anything a rule can find.

Two have now shipped past a CLEAN verdict: the original multiauthor fixture, and a
real customer worklog comment ("fix the ivr…") that sat in `scripts/test/` — a
directory inside the `files` whitelist — while `audit:public` cleared 46 files.

So the rule is procedural, not technical: **never paste a raw API capture into a
fixture.** Hand-write the rows, or redact every free-text field before the file is
saved. The audit cannot catch this for you.

`audit:selftest` exists because a scanner nobody has watched fail proves nothing. It
plants a fake credential inside a path the whitelist ships and requires the scanner
to catch it before the real report is believed.

## Scope: decided — `@ahmedgeindy/jira-worklog`

Chosen by the repository owner, 2026-09-14. `package.json` carries that name and
`publishConfig.access: "public"`.

`publishConfig.access` is not optional for a scoped package. npm defaults a scope to
`restricted`, a restricted publish requires a paid plan, and a first publish without
this line fails with **E402**.

A company-named scope (`@istnetworks/...`) is deliberately **not** used: on npm,
whoever creates an organisation owns it, so creating a company-named scope from a
personal account puts the company's namespace under one employee's login. That is a
company decision made with a company account, not a technical step taken in passing.
Moving later is cheap — publish the same tarball under the company scope and
`npm deprecate` the personal one with a pointer.

A published name is effectively permanent: the unpublish window is 72 hours and the
name stays taken afterwards.

### The remaining gate

`"private": true` is still in `package.json`. It is the last thing standing between
this repo and a publish, and it is deliberate. Removing it is a one-line diff that
belongs in its own release commit, made by the owner when they intend to publish:

```diff
-  "private": true,
```

(This file is not in the package `files` whitelist, so the company name here never
ships. `npm run audit` scans the tarball, not the repo, which is why it stays clean.)

## The first release is manual. It cannot be automated.

npm will not let you configure a trusted publisher for a package that does not exist
yet — the setting lives on the package's own settings page. So:

1. **You** sign in locally. Claude cannot do this step and will not handle npm
   credentials.
   ```bash
   npm login
   npm whoami          # must print your username
   ```
2. Remove `"private": true` from `package.json` in a deliberate release commit, and
   set `publishConfig.access` (`restricted` for a private package, `public` for a
   public one).
3. Run every gate above one more time.
4. Publish the first version by hand:
   ```bash
   npm publish
   ```
5. On npmjs.com → the package → **Settings → Trusted publisher**, add:
   - Publisher: GitHub Actions
   - Organization/user: `ahmedgeindy`
   - Repository: `jira-worklog-skill`
   - Workflow filename: `publish.yml`
6. If you created a granular token for step 4, **revoke it now.** It existed only to
   cover the first publish.

## Every release after that

```bash
# bump the version in package.json, commit it
git tag v1.0.1
git push origin v1.0.1
```

The tag fires `.github/workflows/publish.yml`, which refuses unless:

- the tag matches `package.json`'s version exactly,
- `"private": true` is gone,
- `npm test` passes,
- the package-content audit passes, self-test first.

It publishes with OIDC. There is no `NPM_TOKEN` in the repository, by design.

To rehearse without publishing: Actions → Publish to npm → Run workflow, leaving
`dry_run` checked.

## Provenance — and why it is off

npm's docs: *"Provenance generation is not supported for private repositories, even
when publishing public packages."* This repo is private, so `--provenance` would fail
the publish and is deliberately not passed.

Making the repo public to gain provenance is **not** a free change. Two things would
become world-readable:

1. The org-identifying strings `npm run audit:public` lists — the internal Atlassian
   site name and real Jira issue keys.
2. **Git history still contains the original unredacted test fixture** — a raw
   `worklog query` capture with a colleague's real Jira identity and a customer's
   incident description in it. The working tree is clean; history is not. Redacting
   the tip was not enough, and going public would need that history squashed or
   rewritten first.

## Version numbers

The skill's behaviour is a safety contract, so treat it like one:

- **patch** — docs, comments, test-only changes.
- **minor** — new capability that cannot change what an existing plan writes.
- **major** — anything that could change the hours, dates, or issue a given input
  produces, **or that refuses an input the previous version accepted**. Two
  concrete examples so far:
  - The `7:30h` parser fix: same input, different number.
  - The 105% month progress ceiling. It refuses plans that used to be written,
    and it changed `hashPlan`'s canonical form (plans now carry `months`), so
    **every plan file written by an earlier version is unusable** — `emit` and
    the guards reject it. `lib/planfile.mjs` names that cause explicitly rather
    than reporting it as tampering, but the break is real and belongs in the
    release notes, not just the diff. Plan files are short-lived by design
    (written, approved, emitted, done), so the blast radius is one in-flight
    plan per user, not stored data.
