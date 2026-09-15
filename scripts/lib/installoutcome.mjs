// scripts/lib/installoutcome.mjs
//
// What a twg install attempt actually achieved. Pure: no I/O, no spawning.
//
// This lives here rather than inline in setup.mjs because it was inline, and that
// made it unprovable. The recovery branch only runs when the vendor installer fails
// in one specific way, and on 2026-09-15 CI went green without ever entering it --
// Atlassian's consent prompt simply did not fire that run. A recovery path nothing
// has exercised is indistinguishable from a broken one, and "green because the bug
// did not happen" is not evidence the handling works.
//
// The decision is genuinely simple; the value is that it can now be tested for all
// four outcomes instead of waiting for a vendor to misbehave on cue.

/** Text fragments that mean the installer stopped to ask a human something. */
const PROMPT_MARKERS = [
  /\[y\/N\]/i,
  /\[yes\/no\]/i,
  /I agree and want to continue/i,
  /Customer Agreement/i,
]

/** Did the installer's output end in a question nobody could answer? */
export function looksLikePrompt(out) {
  const text = String(out ?? '')
  return PROMPT_MARKERS.some((re) => re.test(text))
}

/**
 * Classify an install attempt.
 *
 * @param {object} a
 * @param {boolean} a.ok            the installer exited 0
 * @param {string}  [a.why]         the installer's failure summary
 * @param {string}  [a.out]         the installer's own output
 * @param {string|null} a.binaryAfter  path to a working twg found AFTER the attempt,
 *                                     or null. Asking the disk is the whole point:
 *                                     install.ps1 places and PATHs the binary and
 *                                     only THEN runs `twg setup finalize`, so a
 *                                     non-zero exit does not mean nothing landed.
 * @returns {{state:'installed'|'salvaged'|'failed', prompted:boolean, notes:string[]}}
 */
export function classifyInstall({ ok, why = '', out = '', binaryAfter }) {
  const prompted = looksLikePrompt(out)

  if (ok) {
    return binaryAfter
      ? { state: 'installed', prompted, notes: [] }
      : {
        state: 'failed',
        prompted,
        notes: ['the installer reported success but the binary was not found afterwards'],
      }
  }

  if (!binaryAfter) {
    return { state: 'failed', prompted, notes: [why].filter(Boolean) }
  }

  // Non-zero exit, binary present and runnable.
  const notes = [
    'The vendor installer did not finish cleanly, but the binary is present',
    'and runs, so setup continued. What it did not complete was its own final',
    'step (`twg setup finalize`).',
  ]
  if (prompted) {
    notes.push(
      '',
      // Deliberately not auto-answered anywhere in this package. Accepting
      // Atlassian's Customer Agreement on someone else's behalf is not a thing an
      // install script gets to do, however convenient a --yes would be. twg asks
      // the human itself on first interactive use, which is where it belongs.
      'It stopped on Atlassian\'s terms-of-use prompt. Nothing here will answer',
      'that for you: run `twg login` (or any twg command) once yourself and',
      'accept it there.',
    )
  }
  return { state: 'salvaged', prompted, notes }
}
