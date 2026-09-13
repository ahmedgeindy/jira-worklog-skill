#!/usr/bin/env node
// End-to-end test of the PUBLISHED artefact, exercised the way a teammate meets it:
//
//   npm pack  ->  install the tarball into a clean prefix  ->  run the package bin
//   from a different cwd, against a throwaway HOME.
//
// Running setup from the repo is not this test. The repo's cwd happens to contain the
// right files, which is precisely how a dropped `cwd` option went unnoticed while the
// verification step printed a confident "264 tests pass from the installed copy"
// having tested the repo instead.
//
// Every scenario asserts an exit code AND substrings, because an exit code alone
// cannot tell "installed and verified" from "installed nothing and said so nicely".
//
//   node tools/e2e-setup.mjs [--keep]
//
// Exit 0 all scenarios passed, 1 a scenario failed, 2 could not set up.

import { execFileSync } from 'node:child_process'
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync,
  rmSync, lstatSync,
} from 'node:fs'
import { tmpdir, platform } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const IS_WINDOWS = platform() === 'win32'
const KEEP = process.argv.includes('--keep')

const NPM_CLI = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
const npmArgv = (argv) =>
  (existsSync(NPM_CLI) ? [process.execPath, [NPM_CLI, ...argv]] : ['npm', argv])

function sh(cmd, argv, opts = {}) {
  try {
    return { status: 0, out: execFileSync(cmd, argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }) }
  } catch (err) {
    if (err?.code === 'ENOENT') return { status: null, out: '' }
    return { status: typeof err?.status === 'number' ? err.status : 1, out: `${err?.stdout ?? ''}${err?.stderr ?? ''}` }
  }
}

const work = mkdtempSync(join(tmpdir(), 'jwl-e2e-'))
const say = (s) => console.log(s)

// ---------------------------------------------------------------- build + install

say(`workspace: ${work}\n`)

const prefix = join(work, 'prefix')
mkdirSync(prefix, { recursive: true })
writeFileSync(join(prefix, 'package.json'), '{"name":"e2e-host","version":"1.0.0","private":true}\n')

say('packing...')
const packed = sh(...npmArgv(['pack', '--pack-destination', prefix]), { cwd: ROOT })
if (packed.status !== 0) { console.error('npm pack failed\n' + packed.out); process.exit(2) }
const tgz = readdirSync(prefix).find((f) => f.endsWith('.tgz'))
if (!tgz) { console.error('no tarball produced'); process.exit(2) }
say(`packed ${tgz}`)

say('installing the tarball into a clean prefix...')
const inst = sh(...npmArgv(['install', '--no-audit', '--no-fund', `./${tgz}`]), { cwd: prefix })
if (inst.status !== 0) { console.error('install failed\n' + inst.out); process.exit(2) }

const pkgName = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).name
const entry = join(prefix, 'node_modules', pkgName, 'scripts', 'setup.mjs')
if (!existsSync(entry)) { console.error(`installed entry missing: ${entry}`); process.exit(2) }

const binLink = join(prefix, 'node_modules', '.bin', 'jira-worklog' + (IS_WINDOWS ? '.cmd' : ''))
say(`bin link: ${existsSync(binLink) ? 'present' : 'MISSING'}`)
say('')

// cwd for every run: somewhere that is NOT the repo and NOT the installed package.
const elsewhere = join(work, 'elsewhere')
mkdirSync(elsewhere, { recursive: true })

/** A throwaway HOME with the harness dirs a teammate would have. */
function freshHome(name, { claude = true, codex = true, extraSkills = [] } = {}) {
  const home = join(work, `home-${name}`)
  if (claude) mkdirSync(join(home, '.claude', 'skills'), { recursive: true })
  if (codex) mkdirSync(join(home, '.codex', 'skills'), { recursive: true })
  else mkdirSync(home, { recursive: true })
  for (const s of extraSkills) {
    const d = join(home, '.claude', 'skills', s)
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, 'SKILL.md'), `---\nname: ${s}\ndescription: unrelated skill, must survive\n---\n\nleave me alone\n`)
  }
  return home
}

function runSetup(home, args, extraEnv = {}) {
  const env = { ...process.env, USERPROFILE: home, HOME: home, ...extraEnv }
  return sh(process.execPath, [entry, ...args], { cwd: elsewhere, env, timeout: 900_000 })
}

// ---------------------------------------------------------------- scenarios

const results = []
function check(name, { status, out }, expect) {
  const problems = []
  if (expect.exit !== undefined && status !== expect.exit) problems.push(`exit ${status}, wanted ${expect.exit}`)
  for (const s of expect.includes ?? []) if (!out.includes(s)) problems.push(`missing ${JSON.stringify(s)}`)
  for (const s of expect.excludes ?? []) if (out.includes(s)) problems.push(`must NOT contain ${JSON.stringify(s)}`)
  for (const fn of expect.also ?? []) { const p = fn(); if (p) problems.push(p) }
  results.push({ name, ok: problems.length === 0, problems, out })
  say(`${problems.length === 0 ? 'PASS' : 'FAIL'}  ${name}`)
  for (const p of problems) say(`        ${p}`)
}

// 1. clean install on a machine that has twg and is signed in
const h1 = freshHome('clean')
check('clean install', runSetup(h1, ['setup', '--no-upgrade']), {
  exit: 0,
  includes: ['✓ Node.js', '✓ npm', '✓ twg', '✓ Jira sign-in', '✓ dependencies',
    '✓ jira-worklog', '(new)', '✓ verification', 'Ready.'],
  excludes: ['0 tests'],
  also: [() => (existsSync(join(h1, '.claude', 'skills', 'jira-worklog', '.jira-worklog-install.json'))
    ? null : 'install manifest was not written')],
})

// 2. the verification really ran the INSTALLED copy, not the repo
check('verification counts come from the installed copy', results.at(-1), {
  also: [() => {
    const m = /✓ verification\s+(\d+) tests pass/.exec(results.at(-1).out)
    if (!m) return 'no verification count in the output'
    if (Number(m[1]) === 0) return 'zero tests reported as a pass'
    const n = readdirSync(join(h1, '.claude', 'skills', 'jira-worklog', 'scripts', 'test'))
      .filter((f) => f.endsWith('.test.mjs')).length
    return n > 0 ? null : 'installed copy has no test files yet verification passed'
  }],
})

// 3. re-running is idempotent and reports the version truthfully
check('repeated setup is idempotent', runSetup(h1, ['setup', '--no-upgrade']), {
  exit: 0,
  includes: ['(current, reinstalled)', 'Ready.'],
})

// 4. twg already present -> the installer must NOT run.
// --no-upgrade deliberately: without it this scenario runs `twg upgrade` on the
// machine of whoever ran the tests, so the day Atlassian ships a new version, running
// the test suite would silently replace their binary. The assertions below prove what
// this scenario is for -- that nothing gets installed -- without that side effect.
check('twg already installed', runSetup(freshHome('twgok'), ['setup', '--no-upgrade']), {
  exit: 0,
  includes: ['✓ twg'],
  excludes: ['installing it from Atlassian', '(installed)'],
})

// 5. twg missing, auto-install declined -> must fail with the OFFICIAL instructions
const noTwgEnv = {
  PATH: join(process.env.SystemRoot ?? 'C:\\Windows', 'System32'),
  Path: join(process.env.SystemRoot ?? 'C:\\Windows', 'System32'),
  LOCALAPPDATA: join(work, 'empty-localappdata'),
}
check('twg missing + --no-install-twg', runSetup(freshHome('notwg'), ['setup', '--no-install-twg'], noTwgEnv), {
  exit: 2,
  includes: ['✗ twg', 'teamwork-graph.atlassian.com/cli/install',
    'NOT distributed on npm', 'Setup stopped'],
  excludes: ['Ready.'],
})

// 6. Jira auth missing -> non-zero, quoting twg's own remediation
check('Jira auth missing', runSetup(freshHome('noauth'), ['setup', '--no-upgrade'],
  { APPDATA: join(work, 'empty-appdata') }), {
  exit: 2,
  includes: ['✗ Jira sign-in', 'twg login --force', 'Not ready.'],
  excludes: ['Ready.'],
})

// 7. a DIFFERENT skill already occupies the target path -> refuse, leave it intact
const h7 = freshHome('occupied')
const occupied = join(h7, '.claude', 'skills', 'jira-worklog')
mkdirSync(occupied, { recursive: true })
writeFileSync(join(occupied, 'SKILL.md'), '---\nname: someone-elses-thing\n---\nnot ours\n')
check('non-skill directory in the target path is refused', runSetup(h7, ['setup', '--no-upgrade']), {
  exit: 2,
  includes: ['a different skill already occupies that path', '--force'],
  also: [() => (readFileSync(join(occupied, 'SKILL.md'), 'utf8').includes('someone-elses-thing')
    ? null : 'the foreign SKILL.md was modified')],
})

// 8. unrelated skills beside ours are untouched
const h8 = freshHome('neighbours', { extraSkills: ['twg-jira', 'brandkit', 'some-team-skill'] })
check('unrelated skills are preserved', runSetup(h8, ['setup', '--no-upgrade']), {
  exit: 0,
  includes: ['Ready.'],
  also: [() => {
    for (const s of ['twg-jira', 'brandkit', 'some-team-skill']) {
      const f = join(h8, '.claude', 'skills', s, 'SKILL.md')
      if (!existsSync(f)) return `${s} was deleted`
      if (!readFileSync(f, 'utf8').includes('leave me alone')) return `${s} was modified`
    }
    return null
  }],
})

// 9. no harness directory at all -> installing nowhere is NOT success
check('no harness directory is a failure', runSetup(freshHome('nohome', { claude: false, codex: false }), ['setup', '--no-upgrade']), {
  exit: 2,
  includes: ['installed nowhere', 'Not ready.'],
  excludes: ['Ready.'],
})

// 10. --link is refused under npx, where ROOT is a prunable cache
check('--link refused under npx', runSetup(freshHome('npxlink'), ['setup', '--link', '--no-upgrade'],
  { npm_command: 'exec' }), {
  exit: 2,
  includes: ['--link cannot be used under npx'],
  excludes: ['Ready.'],
})

// 11. Windows junction safety: a junction target must survive replacement.
//     Node's recursive remove has historically followed a reparse point and deleted
//     through it, which under --link is the repo.
{
  const jtarget = join(work, 'junction-target')
  mkdirSync(jtarget, { recursive: true })
  writeFileSync(join(jtarget, 'canary.txt'), 'must survive\n')
  const h11 = freshHome('junction')
  const link = join(h11, '.claude', 'skills', 'jira-worklog')
  let made = true
  try {
    execFileSync(process.execPath,
      ['-e', 'require("fs").symlinkSync(process.argv[1],process.argv[2],process.argv[3])',
        jtarget, link, IS_WINDOWS ? 'junction' : 'dir'], { stdio: 'ignore' })
  } catch { made = false }

  if (!made) {
    results.push({ name: 'junction target survives replacement', ok: true, problems: [], out: '' })
    say('PASS  junction target survives replacement (skipped: cannot create links here)')
  } else {
    check('junction target survives replacement', runSetup(h11, ['setup', '--no-upgrade']), {
      exit: 0,
      also: [
        () => (existsSync(join(jtarget, 'canary.txt')) ? null : 'THE JUNCTION TARGET WAS DELETED'),
        () => (lstatSync(link).isSymbolicLink() ? 'the junction was not replaced by a real directory' : null),
      ],
    })
  }
}

// 12. unknown subcommand is rejected rather than silently running setup
check('unknown subcommand rejected', runSetup(freshHome('badcmd'), ['instal']), {
  exit: 2, includes: ['Unknown subcommand'], excludes: ['✓ Node.js'],
})

// ---------------------------------------------------------------- verdict

say('')
const failures = results.filter((r) => !r.ok)
say(`${results.length - failures.length}/${results.length} scenarios passed`)

// Cleanup must never decide the verdict. On Windows a just-exited child, an indexer
// or a virus scanner can still hold a handle inside the workspace, and rmSync then
// throws EBUSY/EPERM -- which would turn a clean 12/12 into a stack trace and a
// non-zero exit that says nothing about the package.
if (!KEEP) {
  try {
    rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch (err) {
    say(`(could not remove ${work}: ${err.code ?? err.message} — left in place)`)
  }
} else say(`kept: ${work}`)

if (failures.length) {
  say('')
  for (const f of failures) {
    say(`--- ${f.name} ---`)
    say(f.out.trim().split('\n').slice(-18).join('\n'))
  }
  process.exit(1)
}
process.exit(0)
