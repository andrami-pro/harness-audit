#!/usr/bin/env node
// skill-inventory.js — every skill and command installed for this machine and project, read from disk.
// Node >= 18, zero dependencies, read-only.
//
// Two plugins read it: harness-guards' loop-stats.js (the dashboard's inventory block) and
// harness-loops' prompt-router hook (the skills it may suggest). A plugin installs alone and cannot
// reach a sibling's files, so each ships its own copy; scripts/validate.js fails when the copies drift.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const stderrWarn = (m) => process.stderr.write(`warn: ${m}\n`);

// The `description:` of a frontmatter block, whatever YAML shape it takes. A block scalar (`>`, `>-`,
// `|`, `|+`…) keeps its text on the indented lines below the key, and a plain or quoted value may
// continue on them: reading only the key's own line returned the indicator itself, and the router
// offered Jev a quarter of the installed skills described as ">-".
function frontmatterDescription(fm) {
  const lines = fm.split('\n');
  const i = lines.findIndex((l) => /^description:/.test(l));
  if (i === -1) return '';
  const head = lines[i].slice('description:'.length).trim();
  const body = [];
  for (const l of lines.slice(i + 1)) {
    if (l.trim() && !/^\s/.test(l)) break;
    body.push(l.trim());
  }
  const text = /^[>|][0-9+-]*$/.test(head) ? body.join(' ') : [head, ...body].join(' ');
  return text.trim().replace(/^["']|["']$/g, '');
}

// What the skill's own files say: how much context it costs, when it was last touched, whether it
// has ever been through a learning loop. Every field is read from disk; none is inferred.
function skillFacts(file) {
  const md = fs.existsSync(file) && fs.statSync(file).isDirectory() ? path.join(file, 'SKILL.md') : file;
  let words = 0;
  let ageDays = null;
  let description = '';
  try {
    const text = fs.readFileSync(md, 'utf8');
    words = text.split(/\s+/).filter(Boolean).length;
    ageDays = Math.floor((Date.now() - fs.statSync(md).mtimeMs) / 864e5);
    const fm = /^---\n([\s\S]*?)\n---/.exec(text);
    if (fm) description = frontmatterDescription(fm[1]).replace(/\s+/g, ' ').slice(0, 160);
  } catch { /* a command file or an unreadable skill: the facts stay empty, never guessed */ }
  let learnings = null;
  const lp = path.join(path.dirname(md), 'LEARNINGS.md');
  if (fs.existsSync(lp)) {
    try { learnings = (fs.readFileSync(lp, 'utf8').match(/^##\s+\d{4}-\d{2}-\d{2}/gm) || []).length; }
    catch { learnings = 0; }
  }
  return { words, ageDays, description, learnings };
}

// Every place a skill can be installed for this machine. Read-only, and tolerant of every one of
// them being absent: most projects have two of these five.
function inventorySkills(repo, { warn = stderrWarn } = {}) {
  const readJson = (file) => {
    if (!fs.existsSync(file)) return null;
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { warn(`${path.basename(file)}: ${e.code || 'unparseable'} — skipped`); return null; }
  };
  const ls = (dir) => {
    try { return fs.readdirSync(dir); }
    catch (e) { if (e.code !== 'ENOENT') warn(`${dir}: ${e.code}`); return []; }
  };
  const home = os.homedir();
  const out = [];
  const seen = new Set();
  const add = (name, source, file, enabled = true) => {
    const key = `${source}:${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name, source, path: file, enabled, ...skillFacts(file) });
  };
  const scanSkills = (dir, source) => {
    for (const e of ls(dir)) {
      if (fs.existsSync(path.join(dir, e, 'SKILL.md'))) add(e, source, path.join(dir, e), true);
    }
  };
  const scanCommands = (dir, source) => {
    for (const f of ls(dir).filter((f) => f.endsWith('.md'))) add(f.replace(/\.md$/, ''), source, path.join(dir, f), true);
  };

  scanSkills(path.join(repo, '.claude', 'skills'), 'project');
  scanSkills(path.join(repo, '.agents', 'skills'), 'project-agents');
  scanSkills(path.join(home, '.claude', 'skills'), 'user');
  scanSkills(path.join(home, '.agents', 'skills'), 'user-agents');
  scanCommands(path.join(repo, '.claude', 'commands'), 'project-command');
  scanCommands(path.join(home, '.claude', 'commands'), 'user-command');

  // Plugins: only the ones installed for this user or for this very project, and only the ones the
  // settings still enable. A disabled plugin is installed-but-off, which is a third state, not zero.
  const installed = readJson(path.join(home, '.claude', 'plugins', 'installed_plugins.json'));
  let enabledMap = {};
  const settings = readJson(path.join(home, '.claude', 'settings.json'));
  // Only this one key is read. The rest of settings.json is none of the dashboard's business.
  if (settings && settings.enabledPlugins && typeof settings.enabledPlugins === 'object') enabledMap = settings.enabledPlugins;
  for (const [key, entries] of Object.entries((installed && installed.plugins) || {})) {
    const pluginName = key.split('@')[0];
    const enabled = enabledMap[key] !== false;
    for (const inst of entries || []) {
      if (inst.scope !== 'user' && path.resolve(String(inst.projectPath || '')) !== repo) continue;
      const base = inst.installPath;
      if (!base) continue;
      for (const e of ls(path.join(base, 'skills'))) {
        if (fs.existsSync(path.join(base, 'skills', e, 'SKILL.md'))) add(`${pluginName}:${e}`, 'plugin', path.join(base, 'skills', e), enabled);
      }
      for (const f of ls(path.join(base, 'commands')).filter((f) => f.endsWith('.md'))) {
        add(f.replace(/\.md$/, ''), 'plugin-command', path.join(base, 'commands', f), enabled);
      }
    }
  }
  // Role files are not skills, but the DISPATCH rule needs to know a role exists before it can say
  // the human is doing that role's dispatching by hand.
  const roles = ls(path.join(repo, '.claude', 'agents')).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, ''));
  return { skills: out, roles };
}

module.exports = { inventorySkills, skillFacts, frontmatterDescription };
