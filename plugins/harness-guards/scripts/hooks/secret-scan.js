#!/usr/bin/env node
// secret-scan — PreToolUse[Write|Edit] hook.
// Denies writes whose content contains an unambiguous credential pattern.
// Conservative by design: short list, high-precision patterns only.

const SECRET_PATTERNS = [
  { re: /sk-(ant-|proj-)?[A-Za-z0-9_-]{20,}/, why: 'API secret key (sk-…)' },
  { re: /ghp_[A-Za-z0-9]{36,}/, why: 'GitHub personal access token (ghp_…)' },
  { re: /github_pat_[A-Za-z0-9_]{22,}/, why: 'GitHub fine-grained token (github_pat_…)' },
  { re: /AKIA[0-9A-Z]{16}/, why: 'AWS access key ID (AKIA…)' },
  { re: /-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/, why: 'PEM private key block' },
  { re: /xox[baprs]-[A-Za-z0-9-]{10,}/, why: 'Slack token (xox…)' },
];

function main(input) {
  let payload;
  try {
    payload = JSON.parse(input);
  } catch {
    return;
  }
  const ti = payload?.tool_input ?? {};
  // Write uses `content`; Edit uses `new_string`.
  const content = [ti.content, ti.new_string].filter((s) => typeof s === 'string').join('\n');
  if (!content) return;

  for (const { re, why } of SECRET_PATTERNS) {
    if (re.test(content)) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: `harness-audit secret-scan: blocked — the content looks like it contains a ${why}. Secrets belong in env vars or a secret store, never in tracked files.`,
        },
      }));
      return;
    }
  }
}

let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => { main(raw); process.exit(0); });
