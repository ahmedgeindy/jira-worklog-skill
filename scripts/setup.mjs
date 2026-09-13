#!/usr/bin/env node
// One command that takes a fresh machine to a working, verified install.
//
//   npx <package> setup
//
// Six checks, each of which can only pass by actually being true. It refuses rather
// than improvising, and it never writes to Jira.
//
// What it will NOT do unless you explicitly ask:
//   - install twg. Missing twg prints Atlassian's own documented commands and exits 2.
//     `--install-twg` runs the vendor installer, and prints the exact command first.
//     Choosing a URL to fetch a binary from is a supply-chain decision; it stays yours.
//   - overwrite a skill directory it did not install (see --force).

import { execFileSync } from 'node:child_process'
import {
  existsSync, readFileSync, mkdirSync, rmSync, rmdirSync, cpSync, symlinkSync, lstatSync,
} from 'node:fs'
import { homedir, platform } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describeTwgFailure } from './lib/twgstatus.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const IS_WINDOWS = platform() === 'win32'

// Verified against Atlassian's own docs, 2026-09-13. An earlier version of this file
// shipped a developer.atlassian.com URL that 404s -- it was never checked.
const TWG_DOCS = 'https://developer.atlassian.com/platform/teamwork-graph/twg-cli/getting-started/installation/'
const TWG_INSTALL = IS_WINDOWS
  ? ['curl.exe -fsSL https://teamwork-graph.atlassian.com/cli/install.ps1 -o twg-install.ps1',
     'powershell -ExecutionPolicy Bypass -File .\\twg-install.ps1']
  : ['curl -fsSL --retry 2 https://teamwork-graph.atlassian.com/cli/install | bash']

const args = process.argv.slice(2)
const flags = new Set(args.filter((a) => a.startsWith('-')))
const words = args.filter((a) => !a.startsWith('-'))

const OPT = {
  link: flags.has('--link'),
  force: flags.has('--force'),
  noUpgrade: flags.has('--no-upgrade'),
  installTwg: flags.has('--install-twg'),
  verbose: flags.has('--verbose'),
}

function usage(message) {
  if (message) console.log(`${message}\n`)
  console.log('Usage:  npx <package> setup [options]\n')
  console.log('  --install-twg   install twg with Atlassian\'s documented installer if missing')
  console.log('  --no-upgrade    do not run `twg upgrade`')
  console.log('  --link          symlink/junction instead of copying (repo clones only)')
  console.log('  --force         replace a target directory that is not this skill')
  console.log('  --verbose       show every command\'s output')
  process.exit(message ? 2 : 0)
}

if (flags.has('--help') || flags.has('-h')) usage(null)
if (words.length === 0) usage('Missing subcommand.')
if (words[0] !== 'setup' || words.length > 1) usage(`Unknown subcommand: ${words.join(' ')}`)

// ---------------------------------------------------------------- reporting

let failed = false
const lines = []
const pass = (label, detail) => lines.push(`  ✓ ${label}${detail ? `  ${detail}` : ''}`)
const skip = (label, detail) => lines.push(`  - ${label}${detail ? `  ${detail}` : ''}`)
const fail = (label, detail) => {
  failed = true
  lines.push(`  ✗ ${label}${detail ? `  ${detail}` : ''}`)
}
const note = (text) => lines.push(`      ${text}`)
const flush = () => {
  console.log(lines.join('\n'))
  lines.length = 0
}

console.log('')

// Running npm is awkward to do safely on Windows. `npm` is a .cmd shim, and since
// the CVE-2024-27980 fix Node refuses to execFile a .cmd at all without a shell --
// but with a shell, arguments are concatenated instead of escaped (DEP0190), so a
// temp path containing a space would be re-split by cmd.exe.
//
// Both problems disappear by running npm's own JS entry point with the node binary
// we are already inside: no shim, no shell, no quoting.
const NPM_CLI = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
const npmArgv = (argv) =>
  (existsSync(NPM_CLI) ? [process.execPath, [NPM_CLI, ...argv]] : ['npm', argv])

/** Run a command for its output. Returns {status, out}; status null = not on PATH. */
function run(cmd, argv, { timeout = 120_000 } = {}) {
  try {
    const out = execFileSync(cmd, argv, {
      encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'],
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
const twg = (argv, opts) => run(IS_WINDOWS ? 'twg.exe' : 'twg', argv, opts)

// ---------------------------------------------------------------- 1. Node.js

const nodeMajor = Number(process.versions.node.split('.')[0])
if (nodeMajor >= 18) pass('Node.js', `v${process.versions.node}`)
else fail('Node.js', `v${process.versions.node} — needs v18 or newer`)

// ---------------------------------------------------------------- 2. npm

const npmV = run(...npmArgv(['--version']), { timeout: 60_000 })
if (npmV.status === 0) pass('npm', `v${npmV.out.trim()}`)
else fail('npm', 'not found on PATH — reinstall Node.js')

// ---------------------------------------------------------------- 3. twg

let twgOk = false
let version = twg(['--version'], { timeout: 30_000 })

if (version.status === null && OPT.installTwg) {
  note('twg not found; installing with Atlassian\'s documented installer:')
  for (const c of TWG_INSTALL) note(`  ${c}`)
  flush()
  const shell = IS_WINDOWS ? 'powershell.exe' : 'bash'
  const shellArgs = IS_WINDOWS
    ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', TWG_INSTALL.join('; ')]
    : ['-lc', TWG_INSTALL[0]]
  const inst = run(shell, shellArgs, { timeout: 600_000 })
  if (inst.status !== 0) console.log(inst.out.trim())
  version = twg(['--version'], { timeout: 30_000 })
}

if (version.status === null) {
  fail('twg', 'not installed')
  note('')
  note('Install it with Atlassian\'s own documented command:')
  for (const c of TWG_INSTALL) note(`  ${c}`)
  note('')
  note(`Docs: ${TWG_DOCS}`)
  note('twg is a standalone binary and is NOT distributed on npm.')
  note('Re-run with --install-twg to have this script run the above for you.')
  flush()
  console.log('\nSetup stopped: twg is required and will not be installed without your say-so.\n')
  process.exit(2)
} else {
  let detail = `v${version.out.trim()}`
  if (!OPT.noUpgrade) {
    // Measured on twg 1.2.8: a no-op when already current (it does not even run the
    // skills refresh), and a forced refresh rewrote only twg's own bundle metadata --
    // an unrelated skill directory beside it came through byte-identical.
    // `twg upgrade` is also Atlassian's documented upgrade path.
    const up = twg(['upgrade', '-y'], { timeout: 600_000 })
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
  } else {
    twgOk = true
    detail += ' (upgrade skipped)'
  }
  if (twgOk) pass('twg', detail)
}

// ---------------------------------------------------------------- 4. Jira auth

const who = twg(['whoami'], { timeout: 90_000 })
const verdict = describeTwgFailure(who.status, who.out)
if (verdict.ok) {
  pass('Jira sign-in', verdict.summary)
} else {
  fail('Jira sign-in', verdict.summary)
  if (verdict.fix) note(`run:  ${verdict.fix}`)
  if (/unable to connect/i.test(who.out)) {
    note('Inside a sandbox this message is usually NOT a network problem —')
    note('see references/codex.md, "twg says Unable to connect".')
  }
}

// ---------------------------------------------------------------- 5. dependencies

// There are none, and saying "installed dependencies" when nothing was installed is
// the kind of decorative green this project exists to avoid. If a real dependency is
// ever added, this installs it rather than continuing to claim there are none.
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

// ---------------------------------------------------------------- 6. install

const PAYLOAD = ['SKILL.md', 'README.md', 'references', 'scripts']
const targets = [
  { harness: 'Claude Code', dir: join(homedir(), '.claude', 'skills', 'jira-worklog') },
  { harness: 'Codex CLI', dir: join(homedir(), '.codex', 'skills', 'jira-worklog') },
]

const isLink = (p) => {
  try { return lstatSync(p).isSymbolicLink() } catch { return false }
}
const isOurs = (dir) => {
  try { return readFileSync(join(dir, 'SKILL.md'), 'utf8').includes('name: jira-worklog') }
  catch { return false }
}

// Under npx, ROOT is a cache directory npm prunes without warning. A junction into it
// would dangle silently and the skill would vanish mid-session.
const UNDER_NPX = ROOT.includes(`${join('_npx')}`) || process.env.npm_command === 'exec'
if (OPT.link && UNDER_NPX) {
  fail('install', '--link cannot be used under npx')
  note('ROOT here is an npx cache directory that npm prunes without warning,')
  note('so the junction would dangle. Clone the repo and run --link from there.')
}

let installed = 0
const installedDirs = []

if (!(OPT.link && UNDER_NPX)) {
  for (const { harness, dir } of targets) {
    const parent = dirname(dirname(dir))
    if (!existsSync(parent)) { skip(harness, `${parent} not present`); continue }

    if (existsSync(dir) || isLink(dir)) {
      if (!OPT.force && !isOurs(dir) && !isLink(dir)) {
        fail(harness, 'a different skill already occupies that path')
        note(`${dir} — move it aside, or pass --force`)
        continue
      }
      // NEVER rmSync a junction: Node's recursive remove has historically hit EPERM on
      // a Windows reparse point, fallen back to a stat that FOLLOWS it, and deleted the
      // target — which under --link is the repo. rmdirSync unlinks without descending.
      if (isLink(dir)) rmdirSync(dir)
      else rmSync(dir, { recursive: true, force: true })
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
      }
      installed += 1
      installedDirs.push({ harness, dir })
    } catch (err) {
      fail(harness, err.message)
    }
  }
}

if (installed === 0 && !(OPT.link && UNDER_NPX)) {
  fail('jira-worklog', 'no harness directory found — installed nowhere')
  note('Expected ~/.claude (Claude Code) or ~/.codex (Codex CLI) to exist.')
} else if (installed > 0) {
  pass('jira-worklog', `installed to ${installed} location${installed === 1 ? '' : 's'}`)
  for (const { harness, dir } of installedDirs) note(`${harness}: ${dir}`)
}

// ---------------------------------------------------------------- 7. verification

// Prove the installed copy runs, rather than trusting that the copy succeeded.
// Reads only: the suite touches no network and writes nothing to Jira.
if (installed > 0) {
  const { dir } = installedDirs[0]
  const t = run(process.execPath, ['--test', 'scripts/test/*.test.mjs'], {
    timeout: 300_000, cwd: dir,
  })
  const m = /^# pass (\d+)/m.exec(t.out) ?? /pass (\d+)/.exec(t.out)
  const count = m ? m[1] : '?'
  const frontmatter = /^---\r?\n[\s\S]*?\bname:\s*jira-worklog\b/m
    .test(readFileSync(join(dir, 'SKILL.md'), 'utf8'))

  if (t.status === 0 && frontmatter) pass('verification', `${count} tests pass from the installed copy`)
  else if (!frontmatter) fail('verification', 'installed SKILL.md has no usable frontmatter')
  else {
    fail('verification', `the installed copy's own tests failed (exit ${t.status})`)
    note(t.out.trim().split(/\r?\n/).slice(-4).join(' / '))
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
console.log('Open a NEW agent session and ask for the jira-worklog skill by name.')
console.log('Discovery is the harness\'s job — a copied file is not proof it was found.')
console.log('')
console.log('Before your first real write, read the "safety model" section of README.md.')
console.log('It is not boilerplate: the guarantee depends on YOUR permission settings.')
console.log('')
