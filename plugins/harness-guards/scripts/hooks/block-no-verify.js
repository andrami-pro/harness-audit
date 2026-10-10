#!/usr/bin/env node
// block-no-verify — PreToolUse[Bash] hook.
// Denies git commit/push/merge with --no-verify (or -n on commit),
// which silently skips the pre-commit / pre-push gates the harness relies on.

const RE_NO_VERIFY = /\bgit\s+(commit|push|merge)\b[^&|;]*--no-verify\b/;
const RE_COMMIT_N = /\bgit\s+commit\b[^&|;]*(\s-n\b|\s-[a-zA-Z]*n[a-zA-Z]*m\b)/;

function main(input) {
  let payload;
  try {
    payload = JSON.parse(input);
  } catch {
    return;
  }
  const command = payload?.tool_input?.command;
  if (typeof command !== 'string') return;

  if (RE_NO_VERIFY.test(command) || RE_COMMIT_N.test(command)) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'harness-audit block-no-verify: blocked — bypassing pre-commit/pre-push hooks defeats the verification pillar. Fix what the hook complains about instead.',
      },
    }));
  }
}

let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => { main(raw); process.exit(0); });
