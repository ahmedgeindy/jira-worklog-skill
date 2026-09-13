# Releasing

Distribution is npm; the source of truth stays this GitHub repo. Everything below is
verified against npm's docs and this repo's own tooling, 2026-09-13.

## Before anything: the gates

```bash
npm test                      # full suite, no network, no Jira access
npm run audit:selftest        # proves the audit can still catch a planted credential
npm run audit                 # what the tarball ACTUALLY contains (private rules)
npm run audit:public          # stricter: also fails on org-identifying strings
```

`npm run audit` packs a real tarball and scans the extracted files, because the
`files` whitelist — not the working tree — decides what ships. Auditing the source
directory would be a check that passes against the wrong thing.

`audit:selftest` exists because a scanner nobody has watched fail proves nothing. It
plants a fake credential inside a path the whitelist ships and requires the scanner
to catch it before the real report is believed.

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
  produces. The `7:30h` parser fix was exactly this: same input, different number.
