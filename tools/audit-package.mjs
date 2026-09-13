#!/usr/bin/env node
// Audit the ACTUAL tarball npm would publish -- not the working tree.
//
// `npm pack` applies the files whitelist, .npmignore and npm's own built-in rules,
// so the working tree is not what ships. Auditing the source directory would pass
// against the wrong thing, which is worse than not auditing at all.
//
//   node scripts/audit-package.mjs              # secrets + pii + internal (always fatal)
//   node scripts/audit-package.mjs --public     # also fails on org-identifying strings
//   node scripts/audit-package.mjs --self-test  # prove the audit can still catch a leak
//
// Exit 0 clean, 1 findings, 2 could not run.
//
// This file and its tests live in tools/ and are deliberately OUTSIDE the package
// `files` whitelist. They are full of specimen credentials -- an audit whose test
// vectors ship would have to exempt its own paths from scanning, and a scanner with
// exemptions is one edit away from exempting the thing that matters. Keeping the
// specimens out of the tarball means this audit runs with NO exemptions at all.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { auditFiles, summarize } from './pkgaudit.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = new Set(process.argv.slice(2))
const PUBLIC = argv.has('--public')
const SELF_TEST = argv.has('--self-test')

const SEVERITIES = PUBLIC
  ? ['secret', 'pii', 'internal', 'org']
  : ['secret', 'pii', 'internal']

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, acc)
    else acc.push(full)
  }
  return acc
}

/** Pack, extract, and return every shipped file as {path, text}. */
function packAndRead(extraFile) {
  const work = mkdtempSync(join(tmpdir(), 'jwl-audit-'))
  try {
    if (extraFile) writeFileSync(join(ROOT, extraFile.name), extraFile.body)

    // Run npm's own JS entry with this node binary: no .cmd shim (which Node will
    // not execFile since CVE-2024-27980) and no shell (which would re-split `work`
    // if the temp path contained a space). See the same note in scripts/setup.mjs.
    const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
    const [cmd, argv] = existsSync(npmCli)
      ? [process.execPath, [npmCli, 'pack', '--pack-destination', work]]
      : ['npm', ['pack', '--pack-destination', work]]
    execFileSync(cmd, argv, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
    const tgz = readdirSync(work).find((f) => f.endsWith('.tgz'))
    if (!tgz) throw new Error('npm pack produced no tarball')

    // `tar` ships with Windows 10+ and every CI image we target.
    execFileSync('tar', ['xzf', tgz], { cwd: work, stdio: ['ignore', 'pipe', 'pipe'] })

    const base = join(work, 'package')
    return walk(base).map((full) => ({
      path: relative(base, full).replace(/\\/g, '/'),
      text: readFileSync(full, 'utf8'),
    }))
  } finally {
    if (extraFile) rmSync(join(ROOT, extraFile.name), { force: true })
    rmSync(work, { recursive: true, force: true })
  }
}

// ------------------------------------------------------------ self test

// A clean report is only meaningful if the audit could have failed. Plant a secret
// in a file the whitelist DOES ship and confirm it is caught; if this control does
// not fire, every green run above it is unfalsifiable.
if (SELF_TEST) {
  console.log('Positive control: planting a fake credential in a shipped path...\n')
  const planted = packAndRead({
    name: 'references/SELFTEST-planted.md',
    body: 'token: TESTVECTOR_REDACTED\n',
  })
  const shipped = planted.find((f) => f.path === 'references/SELFTEST-planted.md')
  if (!shipped) {
    console.log('INCONCLUSIVE — the planted file was not included in the tarball,')
    console.log('so this run proves nothing about the scanner. Check the files whitelist.')
    process.exit(2)
  }
  const caught = auditFiles(planted, { severities: SEVERITIES })
    .filter((f) => f.path === 'references/SELFTEST-planted.md')
  if (caught.length === 0) {
    console.log('CONTROL FAILED — a planted credential was NOT detected.')
    console.log('The audit is not protecting you. Fix the rules before publishing.')
    process.exit(1)
  }
  console.log(`CONTROL PASSED — planted credential caught by rule "${caught[0].id}".`)
  console.log('The scanner can still fail, so a clean result below means something.\n')
}

// ------------------------------------------------------------ the real audit

let files
try {
  files = packAndRead(null)
} catch (err) {
  console.error(`Could not build the package to audit it: ${err.message}`)
  process.exit(2)
}

const totalBytes = files.reduce((n, f) => n + Buffer.byteLength(f.text), 0)
console.log(`Auditing the published tarball: ${files.length} files, ${(totalBytes / 1024).toFixed(1)} kB unpacked`)
console.log(`Mode: ${PUBLIC ? 'PUBLIC (org-identifying strings are fatal)' : 'private (org strings reported, not fatal)'}\n`)

const findings = auditFiles(files, { severities: SEVERITIES })
const groups = summarize(findings)

if (groups.length === 0) {
  console.log('CLEAN — no credentials, PII, workspace leakage')
  if (PUBLIC) console.log('        and no org-identifying strings')
  console.log('')
  console.log(`${files.length} files cleared for publication.`)
  process.exit(0)
}

for (const g of groups) {
  console.log(`[${g.severity.toUpperCase()}] ${g.id} — ${g.why} (${g.hits.length})`)
  for (const h of g.hits.slice(0, 8)) {
    console.log(`    ${h.path}:${h.line}  ${JSON.stringify(h.sample)}`)
  }
  if (g.hits.length > 8) console.log(`    ... and ${g.hits.length - 8} more`)
  console.log('')
}

// In private mode org-identifying strings are expected and informational; anything
// else is a leak. In public mode everything listed is a blocker.
const fatal = findings.filter((f) => PUBLIC || f.severity !== 'org')
if (fatal.length === 0) {
  console.log('No blockers for a PRIVATE publish.')
  console.log('Re-run with --public before publishing publicly: the org-identifying')
  console.log('strings above would become world-readable.')
  process.exit(0)
}

console.log(`REFUSING — ${fatal.length} finding(s) must not be published.`)
process.exit(1)
