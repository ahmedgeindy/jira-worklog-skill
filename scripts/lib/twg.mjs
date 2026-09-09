// The ONLY module that spawns a process. Everything else is pure or calls this.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { FORBIDDEN_TOKENS, FORBIDDEN_SUBCOMMANDS } from './version.mjs'

/** Locate twg. Bare name first, then the documented Windows install path. */
export function locateTwg() {
  const local = process.env.LOCALAPPDATA
  const candidates = [
    'twg',
    local ? join(local, 'Programs', 'twg', 'bin', 'twg.exe') : null,
  ].filter(Boolean)

  for (const c of candidates) {
    if (c === 'twg') {
      const probe = spawnSync(c, ['--version'], { shell: false, encoding: 'utf8' })
      if (!probe.error && probe.status === 0) return c
      continue
    }
    if (existsSync(c)) return c
  }
  throw new Error(
    'twg not found. Tried PATH and %LOCALAPPDATA%\\Programs\\twg\\bin\\twg.exe',
  )
}

/**
 * Refuse to construct an argv this skill must never issue. This is the rail
 * that makes "never delete a worklog" an invariant instead of an instruction.
 */
export function assertArgvSafe(argv) {
  for (const tok of argv) {
    const t = String(tok)
    if (FORBIDDEN_TOKENS.includes(t)) {
      throw new Error(`forbidden token in argv: ${t}`)
    }
  }
  const wl = argv.indexOf('worklog')
  if (wl !== -1) {
    const sub = argv[wl + 1]
    if (FORBIDDEN_SUBCOMMANDS.includes(sub)) {
      throw new Error(`forbidden worklog subcommand: ${sub}`)
    }
  }
}

/**
 * Assert the server echoed back exactly the scalar parameters we sent.
 * Guards the parseInt trap: --started-after "2026-04-20T00:00:00+03:00" is
 * accepted with no error and echoed as 2026, silently disabling the filter.
 */
export function assertEcho(sent, request) {
  for (const [k, v] of Object.entries(sent)) {
    if (!(k in (request ?? {}))) {
      throw new Error(`echo mismatch: server did not echo ${k}`)
    }
    if (request[k] !== v) {
      throw new Error(
        `echo mismatch on ${k}: sent ${JSON.stringify(v)}, server echoed ${JSON.stringify(request[k])}`,
      )
    }
  }
}

/**
 * twg -o json does NOT print JSON to stdout; it prints a YAML block naming a
 * temp file. Handle both that and a direct JSON print.
 */
export function parseStdout(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return { jsonPath: null, inline: null }

  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      return { jsonPath: null, inline: JSON.parse(text) }
    } catch {
      /* fall through to the YAML shape */
    }
  }

  const m = /^\s*stdout:\s*"?([^"\n]+)"?\s*$/m.exec(text)
  return { jsonPath: m ? m[1].trim() : null, inline: null }
}

/**
 * Run a twg command. Returns the parsed envelope.
 * exit 0 = ok, 1 = error, 3 = partial. 3, a non-empty failures[], or
 * exact:false are all UNKNOWN to callers — never treat them as empty results.
 */
export function run(argv, opts = {}) {
  assertArgvSafe(argv)
  const bin = opts.bin ?? locateTwg()
  // NOTE: shell:false is what makes the entire PowerShell quoting/2>&1 trap
  // family unreachable. Never switch this to a command string.
  const res = spawnSync(bin, argv, {
    shell: false,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: opts.timeoutMs ?? 120000,
  })

  if (res.error) throw new Error(`twg spawn failed: ${res.error.message}`)

  const { jsonPath, inline } = parseStdout(res.stdout)
  let payload = inline
  if (jsonPath) {
    if (!existsSync(jsonPath)) {
      throw new Error(`twg named an output file that does not exist: ${jsonPath}`)
    }
    try {
      payload = JSON.parse(readFileSync(jsonPath, 'utf8'))
    } catch (e) {
      throw new Error(`twg output file is not valid JSON (${jsonPath}): ${e.message}`)
    }
  }

  const envelope = (payload && !Array.isArray(payload)) ? payload : { data: payload }
  return {
    exit: res.status,
    data: envelope.data ?? payload,
    request: envelope.request ?? null,
    meta: envelope.meta ?? null,
    failures: envelope.failures ?? [],
    stderr: res.stderr,
  }
}

/** Throw unless the result is a trustworthy, complete read. */
export function assertTrustworthy(result, what) {
  if (result.exit === 3) throw new Error(`UNKNOWN: ${what} returned exit 3 (partial)`)
  if (result.exit !== 0) throw new Error(`UNKNOWN: ${what} exited ${result.exit}: ${result.stderr ?? ''}`)
  if (Array.isArray(result.failures) && result.failures.length) {
    throw new Error(`UNKNOWN: ${what} reported failures: ${JSON.stringify(result.failures)}`)
  }
  if (result.meta && result.meta.exact === false) {
    throw new Error(`UNKNOWN: ${what} returned exact:false`)
  }
}
