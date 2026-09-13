// Turn a twg invocation's (exitCode, output) into a verdict a human can act on.
// Pure: no I/O, so the failure paths are testable without breaking your login.
//
// This exists because the first version of setup.mjs judged `twg whoami` by
// pattern-matching its prose and ignored the exit code entirely. Unauthenticated,
// twg emits a JSON error object starting with '{' -- which matched nothing, so
// setup printed "OK {" and declared authentication fine. A plausible-looking
// green on the single most likely failure a new teammate hits.

/**
 * @param {number|null} status exit code; null when the process could not be spawned
 * @param {string} out combined stdout+stderr
 * @returns {{ok: boolean, summary: string, fix: string|null, code: string|null}}
 */
export function describeTwgFailure(status, out) {
  const text = String(out ?? '')

  // twg exits non-zero AND prints a JSON envelope on error. Prefer the envelope:
  // it carries twg's own remediation command, which beats anything we'd invent.
  // (Measured: `twg whoami` with no credentials exits 77 with code AUTH_REQUIRED
  // and remediation.command "twg login --force" -- note the --force, which an
  // earlier hand-written hint got wrong.)
  let envelope = null
  const brace = text.indexOf('{')
  if (brace !== -1) {
    try {
      const parsed = JSON.parse(text.slice(brace))
      if (parsed && typeof parsed === 'object' && 'ok' in parsed) envelope = parsed
    } catch {
      // not JSON, or truncated -- fall through to the exit code
    }
  }

  if (envelope && envelope.ok === false) {
    const err = envelope.error ?? {}
    return {
      ok: false,
      summary: err.summary || err.message || 'twg reported a failure',
      fix: err.remediation?.command ?? null,
      code: err.code ?? null,
    }
  }

  if (status === null) {
    return { ok: false, summary: 'twg could not be started', fix: null, code: 'ENOENT' }
  }
  if (status !== 0) {
    // Non-zero with no envelope we can read. Say so plainly rather than guessing
    // at the cause from the prose -- guessing is how the original bug happened.
    return {
      ok: false,
      summary: `twg exited ${status}` + (text.trim() ? `: ${firstLine(text)}` : ''),
      fix: null,
      code: null,
    }
  }

  // Exit 0 but nothing printed is not success either -- `whoami` must say who.
  if (!text.trim()) {
    return { ok: false, summary: 'twg exited 0 but printed nothing', fix: null, code: null }
  }

  return { ok: true, summary: firstLine(text), fix: null, code: null }
}

function firstLine(text) {
  return String(text).trim().split(/\r?\n/).find((l) => l.trim()) ?? ''
}
