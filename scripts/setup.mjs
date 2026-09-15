#!/usr/bin/env node
// One command that takes a fresh machine to a working, verified install:
//
//   npx <package>@latest setup
//
// Seven checks. Each can only print a tick by actually being true, and the run exits
// non-zero if any of them cannot. It never writes to Jira.
//
// On twg: if twg is missing this installs it, using Atlassian's own installer from
// their own pinned domain -- the same script their docs tell you to run by hand. It
// is fetched over HTTPS, the exact command is printed before it runs, and
// `--no-install-twg` opts out. This is a deliberate change from an earlier version
// that refused to install anything: a teammate should not need to know a flag to get
// a working machine. What has NOT changed is that no other binary, mirror, or
// third-party URL is ever fetched, and that a failed install is reported as a failure
// with the official instructions rather than papered over.

import { execFileSync } from 'node:child_process'
import {
  existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync, mkdtempSync,
  rmSync, rmdirSync, unlinkSync, cpSync, symlinkSync, lstatSync,
} from 'node:fs'
import { homedir, platform, tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describeTwgFailure } from './lib/twgstatus.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const IS_WINDOWS = platform() === 'win32'

// Verified against Atlassian's published docs, 2026-09-13, and both installer scripts
// were read before being wired in as the default path. An earlier version of this
// file shipped a developer.atlassian.com URL that 404s; it had never been checked.
const TWG_DOCS = 'https://developer.atlassian.com/platform/teamwork-graph/twg-cli/getting-started/installation/'
const TWG_INSTALL_URL = IS_WINDOWS
  ? 'https://teamwork-graph.atlassian.com/cli/install.ps1'
  : 'https://teamwork-graph.atlassian.com/cli/install'

// Where each installer puts the binary, read out of the installers themselves:
//   install.ps1 -> Join-Path $env:LOCALAPPDATA "Programs\twg\bin"
//   install.sh  -> "${INSTALL_DIR_OVERRIDE:-${HOME}/.local/bin}"
// Both add that directory to the USER PATH and then print "open a new terminal",
// which this process cannot do. So after installing we look here directly rather
// than asking a PATH that will not be refreshed until the next shell.
//
// INSTALL_DIR_OVERRIDE redirects BOTH the probe above and the --install-dir /
// -InstallDir argument passed to the installer, so the two cannot disagree. It is
// what makes the install path testable on a machine that already has twg without
// touching the real one.
//
// Note it is ours, not the installer's: install.sh opens with
// `INSTALL_DIR_OVERRIDE=""`, wiping any inherited value, so setting it in the
// environment and expecting the installer to read it installs to the default
// location while this probe looks elsewhere -- a successful install reported as a
// missing binary. That is exactly what happened on the first Linux and macOS run.
const TWG_BIN_DIR = process.env.INSTALL_DIR_OVERRIDE
  ? resolve(process.env.INSTALL_DIR_OVERRIDE)
  : IS_WINDOWS
    ? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Programs', 'twg', 'bin')
    : join(homedir(), '.local', 'bin')
// The twg release to install. PINNED, and overridable with TWG_VERSION.
//
// Not pinned for caution's sake -- pinned because `latest` moved UNDER us and broke
// the Windows install path. Measured 2026-09-15: `latest` resolved to v1.1.0 when it
// had been v1.2.8 the day before, i.e. it went BACKWARDS. v1.1.0's `twg setup
// finalize` does not honour the `--yes` the installer passes it, so it prompts
//     Continue? [yes/no]:
// and a non-interactive setup blocks until it is killed.
//
// The vendor's own shell installer does not have this problem, because it checks for
// a terminal before handing finalize one:
//     if { : < /dev/tty; } 2>/dev/null; then ... finalize < /dev/tty
// install.ps1 computes the same thing (Test-ControllingTerminal) but uses it only for
// telemetry and runs finalize with a live console regardless -- so the hang is
// Windows-only, which is exactly why the Windows CI job exists.
//
// `twg upgrade` runs later in this setup, so pinning the INSTALL does not pin the
// installed binary: a machine ends up current anyway, just via a path that cannot
// stop and ask a question nobody is there to answer.
const TWG_VERSION = process.env.TWG_VERSION || '1.2.8'

// Five minutes, not fifteen. A real install takes seconds; the only thing that ever
// consumed the old 900s budget was the vendor installer sitting on a prompt, and a
// quarter of an hour of silence tells the operator nothing that a fast failure and
// the installer's own output would not tell them better.
const INSTALL_TIMEOUT_MS = 300_000

const TWG_EXE = IS_WINDOWS ? 'twg.exe' : 'twg'

const MANIFEST = '.jira-worklog-install.json'

const args = process.argv.slice(2)
const flags = new Set(args.filter((a) => a.startsWith('-')))
const words = args.filter((a) => !a.startsWith('-'))

const OPT = {
  link: flags.has('--link'),
  force: flags.has('--force'),
  noUpgrade: flags.has('--no-upgrade'),
  noInstallTwg: flags.has('--no-install-twg'),
  verbose: flags.has('--verbose'),
}

function usage(message) {
  if (message) console.log(`${message}\n`)
  console.log('Usage:  npx <package>@latest setup [options]\n')
  console.log('  --no-install-twg   do not install twg if it is missing')
  console.log('  --no-upgrade       do not run `twg upgrade`')
  console.log('  --link             symlink/junction instead of copying (repo clones only)')
  console.log('  --force            replace a target directory that is not this skill')
  console.log('  --verbose          show each command\'s output')
  process.exit(message ? 2 : 0)
}

if (flags.has('--help') || flags.has('-h')) usage(null)
if (words.length === 0) usage('Missing subcommand.')
if (words[0] !== 'setup' || words.length > 1) usage(`Unknown subcommand: ${words.join(' ')}`)

// ---------------------------------------------------------------- reporting

let failed = false
const lines = []
const pass = (l, d) => lines.push(`  ✓ ${l}${d ? `  ${d}` : ''}`)
const skip = (l, d) => lines.push(`  - ${l}${d ? `  ${d}` : ''}`)
const fail = (l, d) => { failed = true; lines.push(`  ✗ ${l}${d ? `  ${d}` : ''}`) }
const note = (t) => lines.push(`      ${t}`)
const flush = () => { console.log(lines.join('\n')); lines.length = 0 }

console.log('')

// Running npm is awkward to do safely on Windows: `npm` is a .cmd shim that Node
// refuses to execFile since the CVE-2024-27980 fix, and shell:true concatenates
// arguments instead of escaping them (DEP0190). Running npm's own JS entry with the
// node binary we are already inside sidesteps both.
const NPM_CLI = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
const npmArgv = (argv) =>
  (existsSync(NPM_CLI) ? [process.execPath, [NPM_CLI, ...argv]] : ['npm', argv])

/**
 * Run a command for its output. Returns {status, out}; status null = not on PATH.
 *
 * `cwd` is destructured explicitly. An earlier version took only `timeout`, so the
 * cwd passed by the verification step was silently dropped and the child inherited
 * this process's directory -- which, run from a clone, made the installed-copy check
 * test the repo instead, and report a confident pass either way.
 */
function run(cmd, argv, { timeout = 120_000, cwd, env } = {}) {
  try {
    const out = execFileSync(cmd, argv, {
      encoding: 'utf8', timeout, cwd, env, stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { status: 0, out }
  } catch (err) {
    if (err?.code === 'ENOENT') return { status: null, out: '' }
    return {
      status: typeof err?.status === 'number' ? err.status : 1,
      out: `${err?.stdout ?? ''}${err?.stderr ?? ''}`,
    }
  }
}

// twg is addressed by an explicit path once we know one, so a PATH that has not been
// refreshed since the installer ran cannot make a working install look absent.
let TWG = TWG_EXE
const twg = (argv, opts) => run(TWG, argv, opts)

function locateTwg() {
  if (run(TWG_EXE, ['--version'], { timeout: 30_000 }).status === 0) return TWG_EXE
  const direct = join(TWG_BIN_DIR, TWG_EXE)
  if (existsSync(direct) && run(direct, ['--version'], { timeout: 30_000 }).status === 0) return direct
  return null
}

// ---------------------------------------------------------------- 1. Node.js

const nodeMajor = Number(process.versions.node.split('.')[0])
if (nodeMajor >= 18) pass('Node.js', `v${process.versions.node}`)
else fail('Node.js', `v${process.versions.node} — needs v18 or newer`)

// ---------------------------------------------------------------- 2. npm

const npmV = run(...npmArgv(['--version']), { timeout: 60_000 })
if (npmV.status === 0) pass('npm', `v${npmV.out.trim()}`)
else fail('npm', 'not found on PATH — reinstall Node.js')

// ---------------------------------------------------------------- 3. twg

function officialInstructions() {
  note('Install it with Atlassian\'s own documented command:')
  if (IS_WINDOWS) {
    note(`  curl.exe -fsSL ${TWG_INSTALL_URL} -o twg-install.ps1`)
    note('  powershell -ExecutionPolicy Bypass -File .\\twg-install.ps1')
  } else {
    note(`  curl -fsSL --retry 2 ${TWG_INSTALL_URL} | bash`)
  }
  note('')
  note(`Docs: ${TWG_DOCS}`)
  note('twg is a standalone binary and is NOT distributed on npm.')
}

/**
 * Which PowerShell to run the vendor installer with, and with what environment.
 *
 * Two separate hazards, both measured on a clean windows-latest runner:
 *
 *  1. PSModulePath contamination. If this process was started from PowerShell 7,
 *     the inherited PSModulePath points at PowerShell 7's module directories.
 *     Windows PowerShell 5.1 then cannot resolve its OWN bundled modules, and
 *     Microsoft.PowerShell.Utility is one of them -- so `Get-FileHash` does not
 *     exist, and the installer dies verifying its download's SHA256:
 *         Get-FileHash : The term 'Get-FileHash' is not recognized ...
 *     Deleting the variable makes each host fall back to its own defaults, which
 *     is what a normally-launched shell would have had.
 *
 *  2. pwsh is not always present, and powershell.exe is not always present either
 *     (Windows 11 ships both today; a trimmed image may not). Prefer pwsh, which
 *     is what a current Windows box runs interactively, and fall back.
 *
 * This is not a CI-only concern: a teammate running `npx ... setup` from a
 * PowerShell 7 prompt hits exactly hazard 1 on their own machine.
 */
function powershellFor() {
  const env = { ...process.env }
  delete env.PSModulePath

  for (const exe of ['pwsh.exe', 'powershell.exe']) {
    const probe = run(exe, ['-NoProfile', '-Command', 'exit 0'], { timeout: 60_000, env })
    if (probe.status === 0) return { exe, env }
  }
  // Neither probed clean; use the one Windows has always shipped and let the
  // installer's own output explain what went wrong.
  return { exe: 'powershell.exe', env }
}

/**
 * Install twg with the vendor's own installer.
 *
 * --skip-login and --skip-skills are passed deliberately. Otherwise the installer
 * starts an interactive browser login -- which cannot work in a non-interactive
 * setup and would hang it -- and installs twg's own agent-skill bundles, a side
 * effect on directories this command was not asked to touch.
 */
function installTwg() {
  const work = mkdtempSync(join(tmpdir(), 'twg-install-'))
  try {
    const script = join(work, IS_WINDOWS ? 'twg-install.ps1' : 'twg-install.sh')
    note(`fetching ${TWG_INSTALL_URL}`)

    const curl = IS_WINDOWS ? 'curl.exe' : 'curl'
    const dl = run(curl, ['-fsSL', '--retry', '2', TWG_INSTALL_URL, '-o', script], { timeout: 300_000 })
    if (dl.status === null) {
      return { ok: false, why: `${curl} is not available${IS_WINDOWS ? ' (Windows 10 1803 or newer ships it)' : ''}` }
    }
    if (dl.status !== 0 || !existsSync(script)) {
      return { ok: false, why: `download failed (exit ${dl.status})`, out: dl.out }
    }

    // If we are probing a non-default directory, the installer has to be told the
    // same thing, or it installs to its default and we then declare a successful
    // install missing. The shell installer reads INSTALL_DIR_OVERRIDE from the
    // environment it inherits; PowerShell takes an explicit -InstallDir.
    const override = process.env.INSTALL_DIR_OVERRIDE

    if (IS_WINDOWS) {
      const argv = [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
        '-Yes', '-SkipLogin', '-SkipSkills',
        '-Version', TWG_VERSION,
        ...(override ? ['-InstallDir', resolve(override)] : []),
      ]
      const { exe, env } = powershellFor()
      note(`${exe} -NoProfile -ExecutionPolicy Bypass -File <downloaded> -Yes -SkipLogin -SkipSkills${override ? ' -InstallDir …' : ''}`)
      flush()
      const r = run(exe, argv, { timeout: INSTALL_TIMEOUT_MS, env })
      return r.status === 0 ? { ok: true } : { ok: false, why: `installer exited ${r.status}`, out: r.out }
    }

    // --install-dir, NOT the INSTALL_DIR_OVERRIDE environment variable. The shell
    // installer opens with `INSTALL_DIR_OVERRIDE=""`, which clobbers any inherited
    // value, so passing it through the environment silently does nothing: the
    // installer writes to ~/.local/bin while we look somewhere else, and a perfectly
    // successful install gets reported as "the binary was not found afterwards".
    const shArgs = [script, '--yes', '--skip-login', '--skip-skills',
      '--version', TWG_VERSION,
      ...(override ? ['--install-dir', resolve(override)] : [])]
    note(`bash <downloaded> --yes --skip-login --skip-skills${override ? ' --install-dir …' : ''}`)
    flush()
    const r = run('bash', shArgs, { timeout: INSTALL_TIMEOUT_MS })
    return r.status === 0 ? { ok: true } : { ok: false, why: `installer exited ${r.status}`, out: r.out }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

let twgOk = false
let found = locateTwg()
let installedTwgNow = false

if (!found && !OPT.noInstallTwg) {
  note('twg not found — installing it from Atlassian:')
  const res = installTwg()
  if (!res.ok) {
    fail('twg', `automatic install failed: ${res.why}`)
    // The vendor installer's OWN output, always -- not only under --verbose.
    // "installer exited 1" on its own tells the operator nothing they can act on
    // and sends them to re-run the thing that just failed. Whatever the installer
    // said about why is the only useful content here, so it is printed before the
    // manual instructions rather than hidden behind a flag nobody passes on the
    // first run. (Found by the Windows CI job: a genuine clean-machine install
    // failure that reported exactly one unactionable line.)
    if (res.out && res.out.trim()) {
      note('')
      note('The installer said:')
      for (const line of res.out.trim().split(/\r?\n/).slice(-15)) note(`  ${line}`)
    }
    // Name the one failure mode whose output looks like success right up to the
    // last line. The vendor installer ends by running `twg setup finalize`, which
    // can ask a question; there is nobody here to answer it, so the process sits
    // until the timeout and every line before the prompt reads like a clean run.
    if (/\[yes\/no\]|\[y\/N\]|Continue\?/i.test(res.out ?? '')) {
      note('')
      note('That last line is a PROMPT: the installer is waiting for an answer, and')
      note('this setup has no terminal to give it one. It is not a download or a')
      note('permissions problem, and re-running will hang in the same place.')
      note(`Install once by hand with the command below, or pin a different release`)
      note(`with TWG_VERSION=<version> (this run asked for ${TWG_VERSION}).`)
    }
    note('')
    officialInstructions()
    flush()
    console.log('\nSetup stopped: twg is required and could not be installed automatically.\n')
    process.exit(2)
  }
  // The installer updates the USER PATH and prints "open a new terminal"; this
  // process will never see that, so look where it installs to.
  found = locateTwg()
  installedTwgNow = true
}

if (!found) {
  if (OPT.noInstallTwg) fail('twg', 'not installed (--no-install-twg was passed)')
  else {
    fail('twg', 'the installer reported success but the binary was not found afterwards')
    note(`Looked on PATH and in ${TWG_BIN_DIR}`)
  }
  note('')
  officialInstructions()
  flush()
  console.log('\nSetup stopped: twg is required.\n')
  process.exit(2)
}

TWG = found
const version = twg(['--version'], { timeout: 30_000 })
let detail = `v${version.out.trim()}`

if (installedTwgNow) {
  detail += ' (installed)'
  twgOk = true
} else if (OPT.noUpgrade) {
  detail += ' (upgrade skipped)'
  twgOk = true
} else {
  // Measured on twg 1.2.8: a no-op when already current -- it does not even run the
  // skills refresh -- and when forced, the refresh rewrote only twg's own bundle
  // metadata, leaving an unrelated skill directory beside it byte-identical.
  // `twg upgrade` is also Atlassian's own documented upgrade path.
  const up = twg(['upgrade', '-y'], { timeout: 900_000 })
  if (up.status !== 0) {
    fail('twg', `upgrade exited ${up.status}`)
    note(up.out.trim().split(/\r?\n/).slice(-3).join(' / '))
  } else {
    const now = twg(['--version'], { timeout: 30_000 })
    const after = now.status === 0 ? now.out.trim() : version.out.trim()
    detail = /up to date/i.test(up.out) ? `v${after} (current)` : `v${after} (upgraded)`
    twgOk = true
  }
  if (OPT.verbose) note(up.out.trim())
}
if (twgOk) pass('twg', detail)

// ---------------------------------------------------------------- 4. Jira auth

const who = twg(['whoami'], { timeout: 90_000 })
const verdict = describeTwgFailure(who.status, who.out)
if (verdict.ok) {
  pass('Jira sign-in', verdict.summary)
} else {
  fail('Jira sign-in', verdict.summary)
  // twg's own remediation beats anything written here by hand: the first draft of
  // this file guessed `twg login` where twg itself says `twg login --force`.
  if (verdict.fix) note(`run:  ${verdict.fix}`)
  if (installedTwgNow) note('twg was just installed, so signing in is the remaining step.')
  if (/unable to connect/i.test(who.out)) {
    note('Inside a sandbox this message is usually NOT a network problem —')
    note('see references/codex.md, "twg says Unable to connect".')
  }
}

// ---------------------------------------------------------------- 5. dependencies

// There are none. Reporting "installed dependencies" when nothing was installed is
// the decorative green this project exists to avoid. If a real dependency is ever
// added, this installs it instead of continuing to claim there are none.
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const deps = Object.keys(pkg.dependencies ?? {})
if (deps.length === 0) {
  pass('dependencies', 'none required (zero runtime dependencies)')
} else if (existsSync(join(ROOT, 'node_modules'))) {
  pass('dependencies', `${deps.length} already installed`)
} else {
  const inst = run(...npmArgv(['install', '--omit=dev', '--no-audit', '--no-fund']), { timeout: 600_000 })
  if (inst.status === 0) pass('dependencies', `${deps.length} installed`)
  else fail('dependencies', `npm install exited ${inst.status}`)
}

// ---------------------------------------------------------------- 6. the skill

const PAYLOAD = ['SKILL.md', 'README.md', 'references', 'scripts']
const targets = [
  { harness: 'Claude Code', dir: join(homedir(), '.claude', 'skills', 'jira-worklog') },
  { harness: 'Codex CLI', dir: join(homedir(), '.codex', 'skills', 'jira-worklog') },
]

const isLink = (p) => {
  try { return lstatSync(p).isSymbolicLink() } catch { return false }
}

/** What we previously installed here, if anything. */
function readManifest(dir) {
  try { return JSON.parse(readFileSync(join(dir, MANIFEST), 'utf8')) } catch { return null }
}

// A directory is ours if it carries our manifest, or our SKILL.md frontmatter (which
// is how installs made before the manifest existed identify themselves). Anything
// else belongs to somebody else and is never replaced without --force.
function isOurs(dir) {
  const m = readManifest(dir)
  if (m?.name === 'jira-worklog') return true
  try { return readFileSync(join(dir, 'SKILL.md'), 'utf8').includes('name: jira-worklog') }
  catch { return false }
}

// Under npx, ROOT is a cache directory npm prunes without warning: a junction into it
// would dangle silently and the skill would disappear mid-session.
const UNDER_NPX = ROOT.includes(`${join('_npx')}`) || process.env.npm_command === 'exec'
if (OPT.link && UNDER_NPX) {
  fail('jira-worklog', '--link cannot be used under npx')
  note('ROOT here is an npx cache directory npm prunes without warning, so the')
  note('junction would dangle. Clone the repo and run --link from there.')
}

let installed = 0
const installedDirs = []
const transitions = []

if (!(OPT.link && UNDER_NPX)) {
  for (const { harness, dir } of targets) {
    const parent = dirname(dirname(dir))
    if (!existsSync(parent)) { skip(harness, `${parent} not present`); continue }

    const before = readManifest(dir)

    if (existsSync(dir) || isLink(dir)) {
      if (!OPT.force && !isOurs(dir) && !isLink(dir)) {
        fail(harness, 'a different skill already occupies that path')
        note(`${dir} — move it aside, or pass --force`)
        continue
      }
      // NEVER rmSync a link. Node's recursive remove has historically hit EPERM on a
      // Windows reparse point, fallen back to a stat that FOLLOWS the link, and
      // deleted the TARGET -- which under --link is the repo itself.
      //
      // How you remove the link is platform-specific, and getting it wrong is not
      // cosmetic: rmdirSync on a POSIX symlink throws ENOTDIR and crashed setup
      // outright, so on macOS and Linux `--link` followed by any later run died
      // before printing a single line. A Windows junction is a directory reparse
      // point and rmdir is the right call there; a POSIX symlink is unlinked.
      if (isLink(dir)) {
        try {
          if (IS_WINDOWS) rmdirSync(dir)
          else unlinkSync(dir)
        } catch {
          // Whichever call is wrong for this filesystem, the other one is right.
          if (IS_WINDOWS) unlinkSync(dir)
          else rmdirSync(dir)
        }
      } else rmSync(dir, { recursive: true, force: true })
    }

    try {
      if (OPT.link) {
        mkdirSync(dirname(dir), { recursive: true })
        symlinkSync(ROOT, dir, IS_WINDOWS ? 'junction' : 'dir')
      } else {
        mkdirSync(dir, { recursive: true })
        for (const entry of PAYLOAD) {
          const from = join(ROOT, entry)
          if (existsSync(from)) cpSync(from, join(dir, entry), { recursive: true })
        }
        // package.json is not part of the payload, so without this the installed copy
        // would carry no version at all and "update the skill when required" would be
        // a claim with nothing behind it.
        writeFileSync(join(dir, MANIFEST), `${JSON.stringify({
          name: 'jira-worklog',
          version: pkg.version,
          installedAt: new Date().toISOString(),
          source: UNDER_NPX ? 'npx' : ROOT,
        }, null, 2)}\n`)
      }
      installed += 1
      installedDirs.push({ harness, dir })
      transitions.push(
        OPT.link ? 'linked'
          : !before ? `v${pkg.version} (new)`
            : before.version === pkg.version ? `v${pkg.version} (current, reinstalled)`
              : `v${before.version} → v${pkg.version} (updated)`,
      )
    } catch (err) {
      fail(harness, err.message)
    }
  }
}

if (installed === 0 && !(OPT.link && UNDER_NPX)) {
  fail('jira-worklog', 'no harness directory found — installed nowhere')
  note('Expected ~/.claude (Claude Code) or ~/.codex (Codex CLI) to exist.')
} else if (installed > 0) {
  pass('jira-worklog', `${transitions[0]} — ${installed} location${installed === 1 ? '' : 's'}`)
  for (const { harness, dir } of installedDirs) note(`${harness}: ${dir}`)
}

// ---------------------------------------------------------------- 7. verification

// Prove the installed copy RUNS, rather than trusting that the copy succeeded.
// Reads only: the suite touches no network and writes nothing to Jira.
//
// "0 tests passed" is a FAILURE. Exit 0 from a runner that found nothing is exactly
// what a bad glob, a wrong cwd, or a botched copy produces, and it is
// indistinguishable from success unless you refuse it.
function countsFrom(text) {
  // node --test uses the spec reporter on a TTY and TAP when piped; accept both.
  const grab = (key) => {
    const m = new RegExp('^(?:#|\\u2139)\\s*' + key + '\\s+(\\d+)', 'm').exec(text)
    return m ? Number(m[1]) : null
  }
  return { tests: grab('tests'), passed: grab('pass'), failures: grab('fail') }
}

if (installed > 0) {
  const { dir } = installedDirs[0]
  const frontmatter = /^---\r?\n[\s\S]*?\bname:\s*jira-worklog\b/m
    .test(readFileSync(join(dir, 'SKILL.md'), 'utf8'))

  // Forward slashes, NOT path.join: node --test treats each argument as a glob, and a
  // backslash is an ESCAPE inside one, so 'scripts\test\x.test.mjs' reduces to
  // 'scriptstestx.test.mjs' and matches nothing -- the runner then exits 0 having run
  // nothing at all.
  let testFiles = []
  try {
    testFiles = readdirSync(join(dir, 'scripts', 'test'))
      .filter((f) => f.endsWith('.test.mjs'))
      .map((f) => `scripts/test/${f}`)
  } catch { /* handled by the empty check below */ }

  if (!frontmatter) {
    fail('verification', 'the installed SKILL.md has no usable frontmatter')
  } else if (testFiles.length === 0) {
    fail('verification', 'no test files found in the installed copy')
    note(`Looked in ${join(dir, 'scripts', 'test')}`)
  } else {
    const t = run(process.execPath, ['--test', ...testFiles], { timeout: 300_000, cwd: dir })
    const { tests, passed, failures } = countsFrom(t.out)

    if (t.status !== 0) {
      fail('verification', `the installed copy's tests failed (exit ${t.status})`)
      for (const l of t.out.trim().split(/\r?\n/).slice(-4)) note(l)
    } else if (tests === null) {
      fail('verification', 'could not read a test count from the runner output')
      note('An unreadable result is treated as failure, not assumed to be success.')
    } else if (tests === 0) {
      fail('verification', `the runner exited 0 but ran NO tests (${testFiles.length} files present)`)
      note('Exit 0 with nothing run proves nothing, so it counts as a failure.')
    } else if (failures) {
      fail('verification', `${failures} of ${tests} tests failed in the installed copy`)
    } else {
      pass('verification', `${passed ?? tests} tests pass from the installed copy`)
    }
  }
} else {
  skip('verification', 'nothing installed to verify')
}

// ---------------------------------------------------------------- verdict

flush()
console.log('')

if (failed) {
  console.log('Not ready. Fix the ✗ lines above and run this again.\n')
  process.exit(2)
}

console.log('Ready.')
console.log('')
if (installedTwgNow) {
  console.log(`twg was installed to ${TWG_BIN_DIR} and added to your user PATH.`)
  console.log('Open a new terminal before running `twg` yourself — this session\'s')
  console.log('PATH predates the install.')
  console.log('')
}
console.log('Open a NEW agent session and ask for the jira-worklog skill by name.')
console.log('Discovery is the harness\'s job — a copied file is not proof it was found.')
console.log('')
console.log('Before your first real write, read the "safety model" section of README.md.')
console.log('It is not boilerplate: the guarantee depends on YOUR permission settings.')
console.log('')
