#!/usr/bin/env node
// sync-workflows — SessionStart hook. Keeps ~/.claude/harness/<name>.js equal to the copy this plugin ships,
// and, in a project whose develop-phase is a wrapper, <project>/.claude/harness/<name>.js too.
//
// A project's develop-phase wrapper calls the global script by path, and the plugin's own path carries its
// version (…/cache/<marketplace>/harness-loops/<version>/), so it moves on every update. This copies each
// workflows/*.js to one path that never moves, at every session start, only when the content differs.
// A plugin update therefore reaches every project's next run without touching any project. Silent, never
// decides anything, and any failure exits 0: a stale copy is better than a session that will not start.
//
// Why a copy inside the project: workflow({scriptPath}) only loads a file the session can already read — the
// working directory or a directory added to it (measured 2026-10-10 in a plain session: "scriptPath must be a
// script path this tool returned, or a file you can already read"). ~/.claude/harness/ is neither, so the
// wrapper reads the project copy first. That copy ignores itself (.claude/harness/.gitignore = *).
//
// jev.js rides along to ~/.claude/harness/ only: develop-phase's routeByJev seat runs it from a shell, which
// reads $HOME whatever the session may load, so the project copy does not need it.
//
//   HARNESS_WORKFLOWS_DIR overrides the destination (tests).

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SRC = path.join(__dirname, '..', '..', 'workflows');
const JEV = path.join(__dirname, '..', 'jev.js');

function destDir() {
  return process.env.HARNESS_WORKFLOWS_DIR || path.join(os.homedir(), '.claude', 'harness');
}

// A project gets a copy only when its develop-phase is a wrapper (it calls the loop with workflow(ref)).
function projectDir(cwd) {
  if (!cwd) return null;
  try {
    const wrapper = fs.readFileSync(path.join(cwd, '.claude', 'workflows', 'develop-phase.js'), 'utf8');
    return /workflow\(ref/.test(wrapper) ? path.join(cwd, '.claude', 'harness') : null;
  } catch { return null; }
}

function copyIfChanged(src, dest) {
  const body = fs.readFileSync(src);
  const target = path.join(dest, path.basename(src));
  try { if (fs.readFileSync(target).equals(body)) return; } catch { /* absent: write it */ }
  fs.mkdirSync(dest, { recursive: true });
  // Write then rename: a run reading the file mid-update sees the old script or the new one, never half.
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, target);
}

function syncInto(dest) {
  for (const f of fs.readdirSync(SRC).filter((x) => x.endsWith('.js'))) copyIfChanged(path.join(SRC, f), dest);
}

function sync(cwd) {
  syncInto(destDir());
  copyIfChanged(JEV, destDir());
  const local = projectDir(cwd);
  if (!local) return;
  syncInto(local);
  const ignore = path.join(local, '.gitignore');
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '# Copy of the global develop-phase loop, kept current by harness-loops. Never commit it.\n*\n');
}

if (require.main === module) {
  let raw = '';
  process.stdin.on('data', (c) => { raw += c; });
  process.stdin.on('end', () => {
    try {
      const p = JSON.parse(raw || '{}');
      if (!p.hook_event_name || p.hook_event_name === 'SessionStart') sync(p.cwd || process.env.CLAUDE_PROJECT_DIR);
    } catch { /* never worth failing a session start over */ }
    process.exit(0);
  });
}

module.exports = { sync, destDir, projectDir, SRC, JEV };
