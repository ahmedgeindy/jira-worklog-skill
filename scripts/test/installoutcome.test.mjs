// scripts/test/installoutcome.test.mjs
//
// The four outcomes of a twg install attempt. These exist because the recovery
// branch was inline in setup.mjs and therefore only reachable when Atlassian's
// installer misbehaved -- CI went green on 2026-09-15 without entering it once,
// because the consent prompt did not fire that run. Passing because the bug did
// not occur says nothing about whether the handling is correct.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyInstall, looksLikePrompt } from '../lib/installoutcome.mjs'

const BIN = 'C:/x/twg.exe'

// The real output captured from the failing Windows runner, trimmed.
const EULA_OUTPUT = `
Added D:\\a\\_temp\\fresh-home\\AppData\\Local\\Programs\\twg\\bin to your user PATH.

Welcome to Teamwork Graph CLI!

By selecting I agree, you agree that use of Teamwork Graph CLI is governed by
the Atlassian Customer Agreement and acknowledge the Atlassian Privacy Policy.

I agree and want to continue [y/N]
`

test('clean install: exit 0 and the binary is there', () => {
  const r = classifyInstall({ ok: true, out: 'Installed: twg 1.2.8', binaryAfter: BIN })
  assert.equal(r.state, 'installed')
  assert.deepEqual(r.notes, [])
})

test('SALVAGED: the installer failed but the binary landed anyway', () => {
  // install.ps1 places and PATHs the binary and only THEN runs `twg setup finalize`.
  // A non-zero exit therefore does not mean nothing was installed.
  const r = classifyInstall({
    ok: false, why: 'installer exited 1', out: EULA_OUTPUT, binaryAfter: BIN,
  })
  assert.equal(r.state, 'salvaged')
  assert.equal(r.prompted, true)
  const text = r.notes.join('\n')
  assert.match(text, /binary is present/)
  assert.match(text, /terms-of-use prompt/)
  assert.match(text, /Nothing here will answer/)
  assert.match(text, /run `twg login`/)
})

test('a salvage with no prompt says so without inventing a legal explanation', () => {
  const r = classifyInstall({
    ok: false, why: 'installer exited 1', out: 'network reset by peer', binaryAfter: BIN,
  })
  assert.equal(r.state, 'salvaged')
  assert.equal(r.prompted, false)
  assert.equal(/terms-of-use/.test(r.notes.join('\n')), false)
})

test('FAILED: the installer failed and nothing landed', () => {
  const r = classifyInstall({
    ok: false, why: 'download failed (exit 22)', out: '404', binaryAfter: null,
  })
  assert.equal(r.state, 'failed')
  assert.deepEqual(r.notes, ['download failed (exit 22)'])
})

test('FAILED: exit 0 but no binary is a failure, not a pass', () => {
  // The installer claiming success is not evidence. Ask the disk.
  const r = classifyInstall({ ok: true, out: 'all good!', binaryAfter: null })
  assert.equal(r.state, 'failed')
  assert.match(r.notes.join(' '), /reported success but the binary was not found/)
})

test('the prompt detector fires on every shape the vendor uses', () => {
  assert.equal(looksLikePrompt('I agree and want to continue [y/N]'), true)
  assert.equal(looksLikePrompt('Continue? [yes/no]:'), true)
  assert.equal(looksLikePrompt('governed by the Atlassian Customer Agreement'), true)
  assert.equal(looksLikePrompt('Installed: twg 1.2.8\nDone.'), false)
  assert.equal(looksLikePrompt(''), false)
  assert.equal(looksLikePrompt(undefined), false)
})

test('a terms prompt is NEVER auto-answered anywhere in the returned guidance', () => {
  // The whole point. If this package ever grows a flag that accepts Atlassian's
  // agreement on the user's behalf, this test is where it should be argued about.
  const r = classifyInstall({ ok: false, out: EULA_OUTPUT, binaryAfter: BIN })
  const text = r.notes.join('\n')
  assert.equal(/--yes|--accept|auto-accept|answering yes/i.test(text), false,
    'guidance must not offer to accept the agreement for the user')
  assert.match(text, /once yourself/)
})
