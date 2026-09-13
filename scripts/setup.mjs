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
import {
  existsSync, readFileSync, mkdirSync, rmSync, rmdirSync, cpSync, symlinkSync, lstatSync,
} from 'node:fs'
import { homedir, platform } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describeTwgFailure } from './lib/twgstatus.mjs'

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

/**
 * twg is a normal CLI; we only ever read from it here.
 * Returns {status, out}. status null means it is not on PATH.
 *
 * The exit code is returned, not discarded. An earlier version of this file
 * returned only the text and judged it by regex; twg answers an unauthenticated
 * `whoami` with a JSON envelope that matched no pattern, so setup printed
 * "OK {" and reported a 401 as a successful login.
 */
function twg(args, { timeout = 120_000 } = {}) {
  try {
    const out = execFileSync(IS_WINDOWS ? 'twg.exe' : 'twg', args, {
      encoding: 'utf8',
      timeout,
      stdio: ['ignore', 'pipe', 'pipe'],
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

// ---------------------------------------------------------------- 1. node

step(1, 'Node version')
const major = Number(process.versions.node.split('.')[0])
if (major >= 18) ok(`node ${process.versions.node}`)
else bad(`node ${process.versions.node} — this skill needs 18 or newer`)

// ---------------------------------------------------------------- 2. twg

step(2, 'twg CLI')
const version = twg(['--version'], { timeout: 20_000 })
if (version.status === null) {
  bad('twg is not on your PATH.')
  info('')
  info('Install it from Atlassian, then run this again:')
  info('  https://developer.atlassian.com/platform/twg-cli/')
  info('')
  info('This script will not download an installer for you, by design.')
  console.log('')
  process.exit(2)
}
ok(`twg ${version.out.trim()}`)

if (OPT.noUpgrade) {
  warn('twg upgrade skipped (--no-upgrade)')
} else {
  // Measured on twg 1.2.8 (2026-09-13): when the binary is already current this
  // is a true no-op — it does not even run the skills refresh. When forced, the
  // refresh rewrote only twg's OWN bundle metadata; an unrelated skill directory
  // placed beside it came through byte-identical.
  //
  // NOT measured: the path where twg is actually out of date. That one really does
  // download and run Atlassian's installer under `-y`. That is twg updating itself
  // from its own vendor, which is a different thing from this script choosing a URL
  // to fetch a binary from — but if you would rather decide that yourself, pass
  // --no-upgrade and run `twg upgrade` by hand.
  info("running twg upgrade (twg self-update; touches only twg's own skills)")
  const up = twg(['upgrade', '-y'], { timeout: 300_000 })
  for (const line of up.out.trim().split(/\r?\n/).filter(Boolean)) info(line)
  if (up.status === 0) ok('twg upgrade finished')
  else bad(`twg upgrade exited ${up.status} — see the lines above`)
}

// ---------------------------------------------------------------- 3. login

step(3, 'Jira authentication')
const who = twg(['whoami'], { timeout: 60_000 })
const verdict = describeTwgFailure(who.status, who.out)
if (verdict.ok) {
  ok(verdict.summary)
} else {
  bad(verdict.summary)
  // twg's own remediation beats anything written here by hand — the first draft
  // of this file guessed "twg login" when twg itself says "twg login --force".
  if (verdict.fix) info(`run:  ${verdict.fix}`)
  if (/unable to connect/i.test(who.out)) {
    info('')
    info('If you are running inside a sandbox, "Unable to connect" is usually NOT')
    info('a network problem — see references/codex.md, "twg says Unable to connect".')
  }
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

function isLink(p) {
  try {
    return lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}

// A directory we installed has our SKILL.md in it. Anything else in that path is
// someone's own work and we stop rather than overwrite it.
function isOurs(dir) {
  try {
    return readFileSync(join(dir, 'SKILL.md'), 'utf8').includes('name: jira-worklog')
  } catch {
    return false
  }
}

let installed = 0

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
    if (isLink(dir)) {
      // NEVER rmSync a junction. Node's recursive remove has historically hit
      // EPERM on a Windows reparse point, fallen back to a stat that FOLLOWS the
      // link, and deleted the TARGET's contents — which under --link is this repo.
      // rmdirSync unlinks the reparse point itself and never descends.
      // Node 25 here was measured not to follow; the engines floor is 18, and
      // those versions were not measured. Cheap to be certain.
      rmdirSync(dir)
    } else {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  try {
    if (OPT.link) {
      mkdirSync(dirname(dir), { recursive: true })
      // 'junction' is the only link type Windows grants without elevation.
      symlinkSync(ROOT, dir, IS_WINDOWS ? 'junction' : 'dir')
      installed += 1
      ok(`${harness} — linked ${dir} -> ${ROOT}`)
    } else {
      mkdirSync(dir, { recursive: true })
      for (const entry of PAYLOAD) {
        const from = join(ROOT, entry)
        if (existsSync(from)) cpSync(from, join(dir, entry), { recursive: true })
      }
      installed += 1
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

// A run that installed nothing is a no-op, and reporting "complete" for a no-op is
// how somebody ends up believing the skill is present when it is not.
if (installed === 0) {
  bad('no harness directory was found, so the skill was installed nowhere.')
  info('Expected ~/.claude (Claude Code) or ~/.codex (Codex CLI) to exist.')
  info('Create the one you use, or copy this directory there yourself.')
}

// ---------------------------------------------------------------- verdict

console.log('')
if (failed) {
  console.log('Setup did NOT complete. Fix the FAIL lines above and run it again.')
  process.exit(2)
}

console.log(`Setup complete — installed to ${installed} location${installed === 1 ? '' : 's'}.`)
console.log('')
console.log('One thing this script cannot check for you: open a NEW agent session and')
console.log("confirm the skill is listed. Discovery is the harness's job, not ours —")
console.log('a copied file is not proof the harness found it.')
console.log('')
console.log('Then read the "Check the safety model holds on YOUR machine" section of')
console.log('README.md before the first real write. It is not boilerplate.')
