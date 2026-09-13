// What must never leave this repo inside a published tarball.
// Pure: takes {path, text} records, returns findings. No I/O, so the rules can be
// tested against planted secrets instead of hoped about.
//
// The audit exists because a one-time manual check does not survive contact with a
// second release. It caught a real leak once already: a test fixture that was a raw
// `worklog query` capture carrying a colleague's Jira identity and a customer's
// incident description.

// Values that LOOK like the thing we ban but are deliberate placeholders. Anything
// added here must be obviously fake on sight -- that is the whole safety property.
export const ALLOWED = [
  'aaaaaaaaaaaaaaaaaaaaaaaa',
  '712020:00000000-1111-2222-3333-444444444444',
  '712020:00000000-1111',
  'dev@example.com',
  'example.atlassian.net',
  'user@example.com',
]

export const RULES = [
  // ---- credentials and secrets: never acceptable, in any mode ----
  { id: 'atlassian-token', severity: 'secret', re: /\bAT[AC]TT[A-Za-z0-9_-]{8,}/g,
    why: 'Atlassian API token' },
  { id: 'bearer', severity: 'secret', re: /\bbearer\s+[A-Za-z0-9._~+/-]{16,}/gi,
    why: 'Authorization bearer token' },
  { id: 'private-key', severity: 'secret', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
    why: 'private key block' },
  { id: 'aws-key', severity: 'secret', re: /\bAKIA[0-9A-Z]{16}\b/g, why: 'AWS access key id' },
  { id: 'vendor-token', severity: 'secret',
    re: /\b(ghp_|gho_|ghs_|github_pat_|npm_|xox[baprs]-)[A-Za-z0-9_]{16,}/g,
    why: 'GitHub / npm / Slack token' },
  { id: 'assigned-secret', severity: 'secret',
    // The ["']? after the key name is load-bearing: in JSON a leaked secret reads
    // "client_secret": "...", so the closing quote sits between the key and the
    // colon. Without it this rule missed the single most common shape of all.
    re: /\b(api[_-]?key|apikey|secret|password|passwd|client_secret|access[_-]?token)\b["']?\s*[:=]\s*["']?[A-Za-z0-9_\-/+]{12,}/gi,
    why: 'a secret assigned to a variable or key' },

  // ---- personal and customer data ----
  { id: 'jira-account-id', severity: 'pii', re: /\b[0-9a-f]{24}\b/g,
    why: 'looks like a real Jira accountId' },
  { id: 'atlassian-uuid-account', severity: 'pii',
    re: /\b\d{6}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g,
    why: 'looks like a real Atlassian account uuid' },
  { id: 'email', severity: 'pii', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    why: 'email address' },
  { id: 'cloud-uuid', severity: 'pii',
    re: /\b[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/g,
    why: 'Atlassian cloud id / v4 uuid' },

  // ---- workspace leakage ----
  { id: 'remember-data', severity: 'internal', re: /\.remember\b|today-20\d\d-\d\d-\d\d|core-memories/g,
    why: 'local .remember session data' },
  { id: 'local-path', severity: 'internal',
    re: /[A-Za-z]:[\\/](Users|ISt)[\\/][A-Za-z0-9_-]+|\/home\/[a-z0-9_-]+\//g,
    why: 'an absolute path from somebody\'s machine' },
  { id: 'workspace-repo', severity: 'internal', re: /hivecfm-workspace|hivecfm-core|HiveFormbricks/g,
    why: 'an unrelated repository name' },

  // ---- org-identifying: only a problem when publishing publicly ----
  { id: 'internal-host', severity: 'org', re: /[A-Za-z0-9-]*istnetworks[A-Za-z0-9-]*/g,
    why: 'internal Atlassian site name' },
  { id: 'internal-issue-key', severity: 'org', re: /\bHCFM-\d+\b/g,
    why: 'real internal Jira issue key' },
  { id: 'customer-name', severity: 'org', re: /\bSERA\b|\bSTC-?BH\b|\bZain(?:-?BH)?\b|\bJawwy\b/gi,
    why: 'customer name' },
]

/** Strip allowlisted placeholders so they cannot trip a rule. */
function redactAllowed(text) {
  let out = text
  for (const a of ALLOWED) out = out.split(a).join(''.repeat(a.length))
  return out
}

/**
 * @param {{path: string, text: string}[]} files
 * @param {{severities?: string[]}} [opts] which severities to report (default: all)
 * @returns {{path,id,severity,why,sample,line}[]}
 */
export function auditFiles(files, opts = {}) {
  const want = opts.severities ?? ['secret', 'pii', 'internal', 'org']
  const findings = []

  for (const { path, text } of files) {
    const clean = redactAllowed(String(text ?? ''))
    for (const rule of RULES) {
      if (!want.includes(rule.severity)) continue
      // Rules carry /g, and a RegExp with /g is stateful across calls.
      const re = new RegExp(rule.re.source, rule.re.flags)
      let m
      while ((m = re.exec(clean)) !== null) {
        findings.push({
          path,
          id: rule.id,
          severity: rule.severity,
          why: rule.why,
          sample: m[0].slice(0, 48),
          line: clean.slice(0, m.index).split('\n').length,
        })
        if (m[0].length === 0) re.lastIndex += 1
      }
    }
  }
  return findings
}

/** Group findings by rule id, for a readable report. */
export function summarize(findings) {
  const by = new Map()
  for (const f of findings) {
    if (!by.has(f.id)) by.set(f.id, { id: f.id, severity: f.severity, why: f.why, hits: [] })
    by.get(f.id).hits.push(f)
  }
  return [...by.values()].sort((a, b) => {
    const order = { secret: 0, pii: 1, internal: 2, org: 3 }
    return order[a.severity] - order[b.severity] || a.id.localeCompare(b.id)
  })
}
