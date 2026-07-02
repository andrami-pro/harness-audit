#!/usr/bin/env node
// destructive-guard — PreToolUse[Bash] hook.
// Denies a short, unambiguous list of destructive shell commands.
// Conservative by design: when in doubt, allow (exit 0, no output).

const DENY_PATTERNS = [
  // rm -rf (any flag order) against /, ~, $HOME, or a bare wildcard
  { re: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*)\s+(\/|~\/?|\$HOME|\*)(\s|$)/, why: 'rm -rf against root, home or bare wildcard' },
  // git checkout with force flags discarding local state
  { re: /\bgit\s+checkout\s+[^&|;]*(--force|-f)(\s|$)/, why: 'git checkout --force discards local changes' },
  // git clean wiping untracked files + dirs, forced
  { re: /\bgit\s+clean\s+[^&|;]*-[a-zA-Z]*f[a-zA-Z]*d?x/, why: 'git clean -fdx wipes untracked files irrecoverably' },
  // git reset --hard to a remote ref (silent history loss)
  { re: /\bgit\s+reset\s+--hard\s+origin\//, why: 'git reset --hard origin/* discards local commits' },
  // mkfs / dd straight onto a block device
  { re: /\b(mkfs\.|dd\s+[^&|;]*of=\/dev\/)/, why: 'direct write to a block device' },
];

function main(input) {
  let payload;
  try {
    payload = JSON.parse(input);
  } catch {
    return; // not our JSON — stay silent, never block on parse errors
  }
  const command = payload?.tool_input?.command;
  if (typeof command !== 'string') return;

  for (const { re, why } of DENY_PATTERNS) {
    if (re.test(command)) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: `harness-audit destructive-guard: blocked (${why}). Run it manually in your own terminal if you really mean it.`,
        },
      }));
      return;
    }
  }
}

let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => { main(raw); process.exit(0); });
