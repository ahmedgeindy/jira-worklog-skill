#!/usr/bin/env node
// One command that gets a teammate from "cloned this" to "the skill is installed
// and twg can talk to Jira". Deliberately does four small things and refuses
// rather than improvising when any of them is not true.
//
// What it will NEVER do:
//   - download or execute an installer for twg (no curl|sh, no MSI fetch). If twg
//     is missing you get a pointer to Atlassian's own instructions and exit 2.
//     A setup script that installs a binary from a URL it chose is a supply-chain
//     decision, and it is not this script's to make.
//   - write a worklog, or anything else, to Jira.
//   - overwrite an existing skill directory it did not obviously install itself.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, mkdirSync, rmSync, cpSync, symlinkSync, lstatSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const IS_WINDOWS = platform() === 'win32'

const argv = new Set(process.argv.slice(2))
const OPT = {
  link: argv.has('--link'),
  force: argv.has('--force'),
  noUpgrade: argv.has('--no-upgrade'),
}

let failed = false
const ok = (m) => console.log(`  OK    ${m}`)
const info = (m) => console.log(`        ${m}`)
const warn = (m) => console.log(`  SKIP  ${m}`)
const bad = (m) => {
  failed = true
  console.log(`  FAIL  ${m}`)
}
const step = (n, m) => console.log(`\n[${n}] ${m}`)

/** twg is a normal CLI; we only ever read from it here. Returns null if it is not on PATH. */
function twg(args, { timeout = 120_000 } = {}) {
  try {
    return execFileSync(IS_WINDOWS ? 'twg.exe' : 'twg', args, {
      encoding: 'utf8',
      timeout,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (err) {
    // ENOENT means not installed; a non-zero exit still carries useful stdout.
    if (err?.code === 'ENOENT') return null
    return err?.stdout ?? err?.stderr ?? ''
  }
}

// ---------------------------------------------------------------- 1. node

step(1, 'Node version')
const major = Number(process.versions.node.split('.')[0])
if (major >= 18) ok(`node ${process.versions.node}`)
else bad(`node ${process.versions.node} — this skill needs 18 or newer`)

// ---------------------------------------------------------------- 2. twg

step(2, 'twg CLI')
const version = twg(['--version'], { timeout: 20_000 })
if (version === null) {
  bad('twg is not on your PATH.')
  info('')
  info('Install it from Atlassian, then run this again:')
  info('  https://developer.atlassian.com/platform/twg-cli/')
  info('')
  info('This script will not download an installer for you, by design.')
  console.log('')
  process.exit(2)
}
ok(`twg ${version.trim()}`)

if (OPT.noUpgrade) {
  warn('twg upgrade skipped (--no-upgrade)')
} else {
  // Measured on twg 1.2.8 (2026-09-13): when the binary is already current this
  // is a true no-op — it does not even run the skills refresh. When it does
  // upgrade, the refresh rewrites only twg's OWN bundle; a forced refresh with an
  // unrelated skill directory present left that directory byte-identical.
  // That is why this is safe to run unattended. Re-measure if twg changes.
  info('running twg upgrade (self-update; touches only twg\'s own skills)')
  const out = twg(['upgrade', '-y'], { timeout: 300_000 }) ?? ''
  for (const line of out.trim().split(/\r?\n/).filter(Boolean)) info(line)
  ok('twg upgrade finished')
}

// ---------------------------------------------------------------- 3. login

step(3, 'Jira authentication')
const who = twg(['whoami'], { timeout: 60_000 }) ?? ''
// twg prints the account to stdout on success; on failure it says so in prose.
// Treat "does not look like an account" as not-logged-in rather than guessing.
if (/unable to connect/i.test(who)) {
  bad('twg cannot reach Jira.')
  info(who.trim())
  info('')
  info('If you are running inside a sandbox, this message is usually NOT a network')
  info('problem — see references/codex.md, "twg says Unable to connect".')
} else if (!who.trim() || /not (logged|authenticated)|please log ?in/i.test(who)) {
  bad('twg is not logged in. Run:  twg login')
} else {
  ok(who.trim().split(/\r?\n/)[0])
}

// ---------------------------------------------------------------- 4. install

step(4, 'Install the skill')

// Only the files a harness needs to run the skill. Tests come along on purpose:
// they are the smoke check a teammate runs when they suspect something is off.
const PAYLOAD = ['SKILL.md', 'README.md', 'references', 'scripts']

const targets = [
  { harness: 'Claude Code', dir: join(homedir(), '.claude', 'skills', 'jira-worklog') },
  { harness: 'Codex CLI', dir: join(homedir(), '.codex', 'skills', 'jira-worklog') },
]

// A directory we installed has our SKILL.md in it. Anything else in that path is
// someone's own work and we stop rather than overwrite it.
function isOurs(dir) {
  try {
    return readFileSync(join(dir, 'SKILL.md'), 'utf8').includes('name: jira-worklog')
  } catch {
    return false
  }
}

for (const { harness, dir } of targets) {
  const parent = dirname(dirname(dir)) // ~/.claude or ~/.codex
  if (!existsSync(parent)) {
    warn(`${harness} — ${parent} does not exist, harness not installed here`)
    continue
  }

  if (existsSync(dir) || isLink(dir)) {
    if (!OPT.force && !isOurs(dir) && !isLink(dir)) {
      bad(`${harness} — ${dir} already exists and is not this skill. Move it aside, or pass --force.`)
      continue
    }
    rmSync(dir, { recursive: true, force: true })
  }

  try {
    if (OPT.link) {
      mkdirSync(dirname(dir), { recursive: true })
      // 'junction' is the only link type Windows grants without elevation.
      symlinkSync(ROOT, dir, IS_WINDOWS ? 'junction' : 'dir')
      ok(`${harness} — linked ${dir} -> ${ROOT}`)
    } else {
      mkdirSync(dir, { recursive: true })
      for (const entry of PAYLOAD) {
        const from = join(ROOT, entry)
        if (existsSync(from)) cpSync(from, join(dir, entry), { recursive: true })
      }
      ok(`${harness} — copied to ${dir}`)
    }
  } catch (err) {
    bad(`${harness} — ${err.message}`)
    continue
  }

  // Verify what we just wrote is actually loadable, rather than trusting the copy.
  const skillFile = join(dir, 'SKILL.md')
  if (!existsSync(skillFile)) {
    bad(`${harness} — ${skillFile} is missing after install`)
  } else if (!/^---\r?\n[\s\S]*?\bname:\s*jira-worklog\b/m.test(readFileSync(skillFile, 'utf8'))) {
    bad(`${harness} — ${skillFile} has no usable 'name: jira-worklog' frontmatter`)
  }
}

function isLink(p) {
  try {
    return lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}

// ---------------------------------------------------------------- verdict

console.log('')
if (failed) {
  console.log('Setup did NOT complete. Fix the FAIL lines above and run it again.')
  process.exit(2)
}

console.log('Setup complete.')
console.log('')
console.log('One thing this script cannot check for you: open a NEW agent session and')
console.log('confirm the skill is listed. Discovery is the harness\'s job, not ours —')
console.log('a copied file is not proof the harness found it.')
console.log('')
console.log('Then read the "Check the safety model holds on YOUR machine" section of')
console.log('README.md before the first real write. It is not boilerplate.')
