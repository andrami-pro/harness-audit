#!/usr/bin/env node
// sync-workflows — SessionStart hook. Keeps ~/.claude/harness/<name>.js equal to the copy this plugin ships.
//
// A project's develop-phase wrapper calls the global script by path, and the plugin's own path carries its
// version (…/cache/<marketplace>/harness-loops/<version>/), so it moves on every update. This copies each
// workflows/*.js to one path that never moves, at every session start, only when the content differs.
// A plugin update therefore reaches every project's next run without touching any project. Silent, never
// decides anything, and any failure exits 0: a stale copy is better than a session that will not start.
//
//   HARNESS_WORKFLOWS_DIR overrides the destination (tests).

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SRC = path.join(__dirname, '..', '..', 'workflows');

function destDir() {
  return process.env.HARNESS_WORKFLOWS_DIR || path.join(os.homedir(), '.claude', 'harness');
}

function sync() {
  const dest = destDir();
  for (const f of fs.readdirSync(SRC).filter((x) => x.endsWith('.js'))) {
    const body = fs.readFileSync(path.join(SRC, f));
    const target = path.join(dest, f);
    try { if (fs.readFileSync(target).equals(body)) continue; } catch { /* absent: write it */ }
    fs.mkdirSync(dest, { recursive: true });
    // Write then rename: a run reading the file mid-update sees the old script or the new one, never half.
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, target);
  }
}

if (require.main === module) {
  let raw = '';
  process.stdin.on('data', (c) => { raw += c; });
  process.stdin.on('end', () => {
    try {
      const p = JSON.parse(raw || '{}');
      if (!p.hook_event_name || p.hook_event_name === 'SessionStart') sync();
    } catch { /* never worth failing a session start over */ }
    process.exit(0);
  });
}

module.exports = { sync, destDir, SRC };
