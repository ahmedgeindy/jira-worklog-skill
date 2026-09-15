// scripts/test/preflight-cli.test.mjs
//
// The entry points must PARSE and RUN. Nothing else in this suite imports
// scripts/setup.mjs, so a syntax error in it is invisible to `npm test`: 347 tests
// passed green on 2026-09-15 while setup.mjs had a broken regex literal in it and
// could not start at all. The only thing that caught it was running the command.
//
// These tests execute each CLI with a harmless argument and assert it got far
// enough to print its own usage. They are deliberately dumb -- the point is that a
// file which cannot be parsed can never reach a unit test.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const bin = (rel) => fileURLToPath(new URL(rel, import.meta.url))

/** Run a CLI, returning {status, out}; never throws on a non-zero exit. */
function runCli(script, argv) {
  try {
    const out = execFileSync(process.execPath, [script, ...argv], {
      encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { status: 0, out }
  } catch (e) {
    return {
      status: typeof e?.status === 'number' ? e.status : 1,
      out: `${e?.stdout ?? ''}${e?.stderr ?? ''}`,
    }
  }
}

test('setup.mjs parses and prints its usage', () => {
  const r = runCli(bin('../setup.mjs'), ['--help'])
  assert.equal(r.status, 0, `--help should exit 0, got ${r.status}: ${r.out.slice(0, 300)}`)
  assert.match(r.out, /Usage:\s+npx/)
  assert.match(r.out, /--no-install-twg/)
  // A SyntaxError surfaces on stderr and never reaches the usage text.
  assert.equal(/SyntaxError|ReferenceError|TypeError/.test(r.out), false, r.out.slice(0, 300))
})

test('setup.mjs refuses an unknown subcommand rather than crashing', () => {
  const r = runCli(bin('../setup.mjs'), ['wat'])
  assert.equal(r.status, 2)
  assert.match(r.out, /Unknown subcommand/)
})

test('timelog.mjs parses and prints its usage', () => {
  const r = runCli(bin('../timelog.mjs'), [])
  // It exits non-zero without a subcommand; what matters is that it RAN.
  assert.match(r.out, /usage: timelog\.mjs plan/)
  assert.equal(/SyntaxError|ReferenceError/.test(r.out), false, r.out.slice(0, 300))
})

test('every shipped script is at least syntactically valid', () => {
  // The broad version of the two tests above: `node --check` every .mjs the package
  // ships, so a parse error anywhere fails the suite rather than waiting for a user
  // to run that particular file.
  const root = fileURLToPath(new URL('../', import.meta.url))

  const files = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) {
        if (name !== 'test' && name !== 'fixtures') walk(p)
      } else if (name.endsWith('.mjs')) files.push(p)
    }
  }
  walk(root)
  assert.ok(files.length >= 10, `expected to find the shipped scripts, found ${files.length}`)

  for (const f of files) {
    const r = runCli('--check', [f])
    assert.equal(r.status, 0, `node --check failed for ${f}:\n${r.out.slice(0, 300)}`)
  }
})
