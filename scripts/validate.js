#!/usr/bin/env node
// validate.js — the package's own preflight gate.
// A methodology that preaches executable rubrics must be able to say no to itself.
// Run: node scripts/validate.js   (exit 0 = releasable, non-zero = fix first)

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const results = [];
// Three states, not two. A check that could not run is not a check that passed: counting it green is
// how a gate reports "all clear" over ground nobody looked at. `skip(reason)` renders ⊘ and is excluded
// from the pass count, so the summary can never claim coverage it does not have.
class Skipped extends Error {}
const skip = (reason) => { throw new Skipped(reason); };
const check = (name, fn) => {
  try {
    const detail = fn();
    results.push({ name, state: 'pass', detail: detail || '' });
  } catch (e) {
    if (e instanceof Skipped) results.push({ name, state: 'skip', detail: e.message });
    else results.push({ name, state: 'fail', detail: e.message.split('\n')[0] });
  }
};
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const mustExist = (rel) => { if (!fs.existsSync(path.join(ROOT, rel))) throw new Error(`${rel} missing`); };
const globMd = (dir) => {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs).filter((f) => f.endsWith('.md')).map((f) => path.join(dir, f)).sort();
};
const walk = (dir) => {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]))
    .sort();
};
// Three plugins in one marketplace (PRD-004 D1). Each installs alone, so each check reads the plugin that
// ships the file; the helpers below read the shipped set across all three.
const PLUGINS = ['harness-audit', 'harness-loops', 'harness-guards'];
const LOOPS = 'plugins/harness-loops';
// Where each disclosure lives since the READMEs were split (PRD-004 step 5): the root README is for a newcomer,
// each plugin README for its own job, docs/ for the detail no README has room for.
const READMES = ['README.md', ...PLUGINS.map((p) => `plugins/${p}/README.md`)];
const AUDIT_README = 'plugins/harness-audit/README.md';
const LOOPS_README = 'plugins/harness-loops/README.md';
const COMPAT_DOC = 'docs/compatibility.md';
const commandsMd = () => PLUGINS.flatMap((p) => globMd(`plugins/${p}/commands`)).sort();
const agentsMd = () => PLUGINS.flatMap((p) => globMd(`plugins/${p}/agents`)).sort();
const commandPath = (name) => commandsMd().find((f) => path.basename(f) === `${name}.md`) || `commands/${name}.md`;
// Hook script paths are relative to the plugin that installs them (${CLAUDE_PLUGIN_ROOT}).
const hookManifests = () => PLUGINS
  .map((p) => `plugins/${p}/hooks/hooks.json`)
  .filter((rel) => fs.existsSync(path.join(ROOT, rel)))
  .map((rel) => ({ rel, dir: path.dirname(path.dirname(rel)), hooks: JSON.parse(read(rel)).hooks || {} }));
const slugOfPath = (p) => p.replace(/[/.]/g, '-');
const hasFrontmatterField = (rel, field) => {
  const s = read(rel);
  if (!/^---\n/.test(s)) throw new Error(`${rel} missing frontmatter`);
  const fm = s.split('---')[1] ?? '';
  // `\s` spans the newline: `field:\s*\S+` reads the NEXT key's name as this field's value.
  if (!new RegExp(`^${field}:[ \\t]*\\S`, 'm').test(fm)) throw new Error(`${rel} frontmatter missing ${field}`);
};

check('every plugin.json valid + required fields', () => {
  return PLUGINS.map((name) => {
    const p = JSON.parse(read(`plugins/${name}/.claude-plugin/plugin.json`));
    for (const f of ['name', 'description', 'version']) if (!p[f]) throw new Error(`plugins/${name}: missing field: ${f}`);
    if (p.name !== name) throw new Error(`plugins/${name}/.claude-plugin/plugin.json names itself '${p.name}'`);
    return `${p.name}@${p.version}`;
  }).join(' · ');
});

check('marketplace.json valid + lists the three plugins, each at its own folder', () => {
  const m = JSON.parse(read('.claude-plugin/marketplace.json'));
  if (!m.name) throw new Error('missing field: name');
  const listed = (m.plugins || []).map((p) => `${p.name}=${p.source}`).sort();
  const expected = PLUGINS.map((p) => `${p}=./plugins/${p}`).sort();
  if (listed.join() !== expected.join()) throw new Error(`plugins[] is ${listed.join(', ')}; expected ${expected.join(', ')}`);
  return listed.join(' · ');
});

// What each plugin ships, pinned. The union is what the single plugin shipped at 2.9.0 — one skill, six
// commands, seven agents, seven hook scripts — plus sync-workflows (PRD-004 step 2), so the split moved
// files and dropped none.
const SPLIT = {
  'harness-audit': { skills: ['harness-audit'], commands: [], agents: [], hooks: [] },
  'harness-loops': {
    skills: [],
    commands: ['iterate', 'orchestrate', 'review-loop', 'skill-loop'],
    agents: ['correctness-critic', 'domain-critic', 'process-optimizer', 'safety-critic', 'scorer', 'skill-improver', 'style-critic'],
    hooks: ['jev-nudge', 'prompt-router', 'sync-workflows'],
  },
  'harness-guards': {
    skills: [],
    commands: ['dashboard-harness', 'session-review'],
    agents: [],
    hooks: ['block-no-verify', 'destructive-guard', 'loop-telemetry', 'repeat-tool-guard', 'secret-scan'],
  },
};
// A module two plugins need ships in each of them, byte for byte; the first plugin listed holds the
// copy you edit.
const SHARED = {
  'scripts/model-lineup.js': ['harness-audit', 'harness-loops', 'harness-guards'],
  'scripts/skill-inventory.js': ['harness-guards', 'harness-loops'],
};
// model-lineup.js loads these only for its `advise` and `ui` subcommands, which only harness-audit's
// bin/lineup and bin/lineup-advise call. The copies in the other plugins never reach them.
const LAZY_REQUIRES = { 'model-lineup.js': new Set(['lineup-advise.js', 'lineup-ui.js']) };

const listDir = (abs) => { try { return fs.readdirSync(abs, { withFileTypes: true }); } catch { return []; } };
const walkAbs = (abs) => listDir(abs)
  .flatMap((e) => (e.isDirectory() ? walkAbs(path.join(abs, e.name)) : [path.join(abs, e.name)]));

function componentsOf(dir) {
  const names = (sub, keep) => listDir(path.join(dir, sub)).filter(keep).map((e) => e.name.replace(/\.md$/, '')).sort();
  const manifest = path.join(dir, 'hooks', 'hooks.json');
  const hookText = fs.existsSync(manifest) ? fs.readFileSync(manifest, 'utf8') : '';
  return {
    skills: names('skills', (e) => e.isDirectory() && fs.existsSync(path.join(dir, 'skills', e.name, 'SKILL.md'))),
    commands: names('commands', (e) => e.name.endsWith('.md')),
    agents: names('agents', (e) => e.name.endsWith('.md')),
    hooks: [...new Set((hookText.match(/scripts\/hooks\/[\w-]+\.js/g) || []).map((s) => path.basename(s, '.js')))].sort(),
  };
}

const componentDiff = (dir, expected) => Object.keys(expected)
  .filter((k) => componentsOf(dir)[k].join() !== expected[k].join())
  .map((k) => `${k} = [${componentsOf(dir)[k].join(', ')}], expected [${expected[k].join(', ')}]`);

// Installed, ${CLAUDE_PLUGIN_ROOT} is the plugin's own cache folder, and a sibling plugin's files are
// not in it. So every path a plugin names — in its manifests and prose, its require() calls, its bin
// wrappers — has to resolve inside its own folder.
function selfContainmentProblems(dir) {
  const problems = [];
  const files = walkAbs(dir);
  const relOf = (f) => path.relative(dir, f);
  for (const f of files.filter((x) => /\.(md|json)$/.test(x))) {
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/\$\{CLAUDE_PLUGIN_ROOT(?::-[^}]*)?\}\/([\w./-]*\w)/g)) {
      if (!fs.existsSync(path.join(dir, m[1]))) problems.push(`${relOf(f)} names \${CLAUDE_PLUGIN_ROOT}/${m[1]}, which this plugin does not ship`);
    }
  }
  for (const f of files.filter((x) => x.endsWith('.js'))) {
    const t = fs.readFileSync(f, 'utf8');
    const lazy = LAZY_REQUIRES[path.basename(f)] || new Set();
    const targets = [
      ...[...t.matchAll(/require\(\s*'(\.{1,2}\/[^']+)'\s*\)/g)].map((m) => m[1]),
      ...[...t.matchAll(/join\(__dirname((?:\s*,\s*'[^']*')+)\s*\)/g)]
        .map((m) => path.join(...m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean))),
    ];
    for (const rel of targets) {
      const abs = path.resolve(path.dirname(f), rel);
      if ([abs, `${abs}.js`, `${abs}.json`].some((p) => fs.existsSync(p)) || lazy.has(path.basename(rel))) continue;
      problems.push(`${relOf(f)} loads ${rel}, which this plugin does not ship`);
    }
    try { execFileSync('node', ['--check', f], { stdio: 'pipe' }); } catch { problems.push(`${relOf(f)} does not parse`); }
  }
  for (const e of listDir(path.join(dir, 'bin'))) {
    const f = path.join(dir, 'bin', e.name);
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/\/\.\.\/scripts" && pwd\)\/([\w.-]+)/g)) {
      if (!fs.existsSync(path.join(dir, 'scripts', m[1]))) problems.push(`${relOf(f)} runs scripts/${m[1]}, which this plugin does not ship`);
    }
  }
  return problems;
}

// Every hook command, run exactly as hooks.json spells it, with ${CLAUDE_PLUGIN_ROOT} set to the plugin
// folder and HOME set to a scratch dir (the telemetry hook writes under HOME, Jev reads its key there).
const HOOK_PAYLOADS = {
  PreToolUse: 'pre-tool-use-bash-desc-1.json',
  UserPromptSubmit: 'user-prompt-submit.json',
  SessionStart: 'session-start.json',
  Stop: 'stop.json',
  SubagentStop: 'subagent-stop.json',
};
function hookRunProblems(dir) {
  const manifest = path.join(dir, 'hooks', 'hooks.json');
  if (!fs.existsSync(manifest)) return [];
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-hookrun-'));
  const env = { PATH: process.env.PATH, HOME: scratch, TMPDIR: scratch, CLAUDE_PLUGIN_ROOT: dir };
  const problems = [];
  for (const [event, entries] of Object.entries(JSON.parse(fs.readFileSync(manifest, 'utf8')).hooks || {})) {
    const fixture = HOOK_PAYLOADS[event];
    if (!fixture) { problems.push(`no payload fixture for ${event} — add one to HOOK_PAYLOADS`); continue; }
    const input = fs.readFileSync(path.join(ROOT, 'scripts/fixtures/hooks', fixture), 'utf8');
    for (const h of entries.flatMap((e) => e.hooks || [])) {
      try {
        execFileSync('sh', ['-c', h.command], { input, env, cwd: scratch, stdio: 'pipe', timeout: 15000 });
      } catch (e) {
        problems.push(`${event} \`${h.command}\` exited ${e.status}: ${String(e.stderr || '').trim().split('\n')[0]}`);
      }
    }
  }
  fs.rmSync(scratch, { recursive: true, force: true });
  return problems;
}

function isolationReport(name, dir) {
  const problems = [
    ...componentDiff(dir, SPLIT[name]),
    ...selfContainmentProblems(dir),
    ...hookRunProblems(dir),
  ];
  if (problems.length) throw new Error(`${name} alone: ${problems.join(' · ')}`);
  const c = componentsOf(dir);
  return `${name}: ${c.skills.length}s/${c.commands.length}c/${c.agents.length}a/${c.hooks.length}h`;
}

// PRD-004 step 1: the split changes where files live, not what ships. Each plugin is copied ALONE into
// an empty directory — the shape of its install cache — and must still resolve every path it names
// and run every hook it installs.
//
// Negative controls (2026-10-10, each applied on a committed tree, observed, reverted — all exit 1):
//   plugins/harness-loops/scripts/skill-inventory.js deleted ......................................
//     "harness-loops alone: scripts/hooks/prompt-router.js loads ../skill-inventory.js, which this
//      plugin does not ship"
//   prompt-router.js pointed back at '../loop-stats.js' (the pre-split import) .....................
//     "harness-loops alone: scripts/hooks/prompt-router.js loads ../loop-stats.js, which this plugin
//      does not ship"
//   agents/scorer.md moved from harness-loops to harness-guards ....................................
//     "harness-loops alone: agents = [correctness-critic, …, style-critic], expected [… scorer, …]"
//   secret-scan.js renamed to secret-scan2.js in harness-guards' hooks.json only ...................
//     "harness-guards alone: hooks = [… secret-scan2], expected [… secret-scan] · PreToolUse … exited"
check('each plugin is self-contained: copied alone, every path it names resolves inside it and every hook runs', () => {
  const union = { skills: [], commands: [], agents: [], hooks: [] };
  const lines = PLUGINS.map((name) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `harness-alone-${name}-`));
    const dir = path.join(tmp, name);
    fs.cpSync(path.join(ROOT, 'plugins', name), dir, { recursive: true });
    try {
      for (const k of Object.keys(union)) union[k].push(...componentsOf(dir)[k]);
      return isolationReport(name, dir);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
  const totals = Object.entries(union).map(([k, v]) => `${v.length} ${k}`).join(', ');
  if (totals !== '1 skills, 6 commands, 7 agents, 8 hooks') throw new Error(`the three plugins ship ${totals}; expected 2.9.0's 1 skills, 6 commands, 7 agents, 7 hooks + sync-workflows`);
  return `${lines.join(' · ')} — union ${totals}`;
});

// Negative control (2026-10-10, reverted): one line appended to harness-guards' model-lineup.js — exit 1,
// "plugins/harness-guards/scripts/model-lineup.js drifted from plugins/harness-audit/scripts/model-lineup.js".
check('a module two plugins need ships byte-identical in each of them', () => {
  for (const [rel, [owner, ...copies]] of Object.entries(SHARED)) {
    const canonical = read(`plugins/${owner}/${rel}`);
    for (const p of copies) {
      if (read(`plugins/${p}/${rel}`) !== canonical) {
        throw new Error(`plugins/${p}/${rel} drifted from plugins/${owner}/${rel} — edit the ${owner} copy, then cp it over`);
      }
    }
  }
  return Object.entries(SHARED).map(([rel, ps]) => `${path.basename(rel)} ×${ps.length}`).join(' · ');
});

// The same claim through the real installer: `claude plugin install` into a throwaway
// CLAUDE_CONFIG_DIR, one plugin at a time, then the isolation report over the copy it installed.
// It never touches ~/.claude. Without the CLI it is unrun, never green.
check('each plugin installs ALONE through `claude plugin install` and its installed copy is self-contained', () => {
  try { execFileSync('claude', ['--version'], { stdio: 'pipe', timeout: 30000 }); }
  catch { skip('no `claude` CLI on PATH — the copied-alone check above still ran'); }
  return PLUGINS.map((name) => {
    const cfg = fs.mkdtempSync(path.join(os.tmpdir(), `harness-install-${name}-`));
    const run = (args) => execFileSync('claude', args, {
      env: { ...process.env, CLAUDE_CONFIG_DIR: cfg }, stdio: 'pipe', encoding: 'utf8', timeout: 120000,
    });
    try {
      run(['plugin', 'marketplace', 'add', ROOT]);
      run(['plugin', 'install', `${name}@harness-audit`]);
      const installed = JSON.parse(run(['plugin', 'list', '--json']));
      if (installed.length !== 1 || installed[0].id !== `${name}@harness-audit`) {
        throw new Error(`installing ${name} left [${installed.map((p) => p.id).join(', ')}] installed`);
      }
      return isolationReport(name, installed[0].installPath);
    } finally {
      fs.rmSync(cfg, { recursive: true, force: true });
    }
  }).join(' · ');
});

check('SKILL.md exists with name + description frontmatter', () => {
  hasFrontmatterField('plugins/harness-audit/skills/harness-audit/SKILL.md', 'name');
  hasFrontmatterField('plugins/harness-audit/skills/harness-audit/SKILL.md', 'description');
});

check('companion templates present', () => {
  mustExist('plugins/harness-audit/skills/harness-audit/rubric-template.md');
  mustExist('plugins/harness-audit/skills/harness-audit/verifier-protocol.md');
  mustExist('WHITEPAPER.md');
  mustExist('README.md');
  mustExist('LICENSE');
});

check('verifier-protocol has the negative-control self-test', () => {
  if (!/negative control|negative-control/i.test(read('plugins/harness-audit/skills/harness-audit/verifier-protocol.md'))) {
    throw new Error('missing negative-control section (v2 requirement)');
  }
});

check('no stale model lineup (Haiku must not be the preflight tier)', () => {
  const files = ['plugins/harness-audit/skills/harness-audit/SKILL.md', 'WHITEPAPER.md', ...READMES, 'docs/loops.md', COMPAT_DOC, ...commandsMd(), ...agentsMd()];
  for (const rel of files) {
    const hits = read(rel).split('\n')
      .map((l, i) => ({ l, n: i + 1 }))
      .filter(({ l }) => /haiku/i.test(l) && /preflight/i.test(l));
    if (hits.length) throw new Error(`${rel}:${hits[0].n} still pairs Haiku with preflight`);
  }
  return `${files.length} files scanned`;
});

check('benchmark figures are hedged, not asserted', () => {
  const files = ['plugins/harness-audit/skills/harness-audit/SKILL.md', 'WHITEPAPER.md', ...commandsMd(), ...agentsMd()];
  for (const rel of files) {
    const t = read(rel);
    if (/89\s*%/.test(t) && !/directional|illustrative|not (yet )?(independently )?reproduced/i.test(t)) {
      throw new Error(`${rel} cites 89% without a directional/unreproduced hedge`);
    }
  }
  return `${files.length} files scanned`;
});

check('every commands/*.md has a frontmatter description', () => {
  const files = commandsMd();
  if (!files.length) throw new Error('commands/ is empty — the plugin ships no loop');
  for (const rel of files) hasFrontmatterField(rel, 'description');
  return `${files.length} command(s) checked`;
});

check('every agents/*.md has a frontmatter description', () => {
  const files = agentsMd();
  if (!files.length) throw new Error('agents/ is empty — the plugin ships no critics');
  for (const rel of files) hasFrontmatterField(rel, 'description');
  return `${files.length} agent(s) checked`;
});

// Claude Code parses frontmatter leniently, so an unquoted scalar carrying `: ` inside it — every
// `Cost: medium` in a description — works here and breaks everywhere else: GitHub renders a YAML error
// instead of the file, and Pi's strict loader drops the command without a word. Three loops shipped
// invisible on Pi for exactly this. The lenient host is the one that lets it through, so the gate has
// to be stricter than the host it runs on.
//
// Negative control (2026-07-13, reverted): quotes stripped from commands/orchestrate.md's description
// — exit 1, "commands/orchestrate.md: 'description' is an unquoted YAML scalar containing ': '".
check('every frontmatter survives a STRICT YAML parser (GitHub, Pi), not just a lenient one', () => {
  const files = [...commandsMd(), ...agentsMd()];
  if (!files.length) throw new Error('nothing scanned — the gate would pass vacuously');
  for (const rel of files) {
    const m = /^---\n([\s\S]*?)\n---/.exec(read(rel));
    if (!m) throw new Error(`${rel}: no frontmatter block`);
    for (const line of m[1].split('\n')) {
      const kv = /^([\w-]+):\s*(.*)$/.exec(line);
      if (!kv) continue;
      const value = kv[2];
      if (value && !/^["'[{]/.test(value) && /:\s/.test(value)) {
        throw new Error(`${rel}: '${kv[1]}' is an unquoted YAML scalar containing ': ' — GitHub errors, Pi drops it silently`);
      }
    }
  }
  return `${files.length} frontmatter block(s) strict-YAML safe`;
});

// Pins the command count the README's catalog promises: 5 loops that have a command (skill-loop,
// orchestrate, review-loop, iterate, session-review — Loop 1 is a pattern, not a command, by design)
// plus 1 observer (dashboard, which iterates on nothing and costs no tokens). A 7th command shipped
// without updating the README catalog would drift silently; so would a command that lost its
// argument-hint, which is the piece `/command` autocomplete and the SlashCommand tool both read.
//
// The cap is the anti-proliferation gate, and it is a gate precisely because raising it is not free:
// a new file has to argue for itself in a PRD before it argues for itself here. F10 raised it from 4
// to 5 for session-review; PRD-003 §4 raises it from 5 to 6 for dashboard, on the grounds that the
// observer is not a loop and that folding it into session-review would put a free report behind a
// model pass that is deliberately run once a fortnight.
//
// Negative controls (2026-07-12, both reverted): argument-hint stripped from commands/iterate.md —
// exit 1, "commands/iterate.md frontmatter missing argument-hint"; an extra command copied in —
// exit 1, "commands/*.md = 7, expected exactly 6" (2026-09-06, reverted).
check('exactly 6 commands — 5 loops and 1 observer — each with description + argument-hint', () => {
  const files = commandsMd();
  if (files.length !== 6) throw new Error(`commands/*.md = ${files.length}, expected exactly 6`);
  for (const rel of files) {
    hasFrontmatterField(rel, 'description');
    hasFrontmatterField(rel, 'argument-hint');
  }
  return `${files.length} command(s), all with argument-hint`;
});

// The catalog table is the honesty-gated deliverable of F7 (DoD-3): a loop only gets a row once it has a
// real recorded run. If the header survives but a body row is silently dropped by a later edit, this
// check would still pass — that's an editorial risk, not a structural one, and out of scope for a command
// this cheap. What this check guards is the coarser, more common failure: the whole table gone missing.
//
// Negative control (2026-07-12, reverted): dropped the "Stops when" column from the header row —
// exit 1, "README missing the five-loops catalog table header".
// A README is read by someone deciding whether to install; past 150 lines it stops being read (PRD-004 §8).
// The detail lives in docs/, linked. Every relative link in a README or in docs/ has to land on a file.
//
// Negative controls (2026-10-10, each applied, observed, reverted — all exit 1):
//   80 lines of filler appended to plugins/harness-loops/README.md .................................
//     "plugins/harness-loops/README.md is 210 lines — the limit is 150"
//   the link to docs/compatibility.md pointed at docs/compat.md ......................................
//     "README.md links to docs/compat.md, which does not exist"
check('every README is at most 150 lines, the root says which plugin to install, and no relative link is broken', () => {
  for (const rel of READMES) {
    const n = read(rel).split('\n').length;
    if (n > 150) throw new Error(`${rel} is ${n} lines — the limit is 150`);
  }
  if (!/## Which plugin do I need\?/.test(read('README.md'))) throw new Error('the root README lost its "Which plugin do I need?" table');
  const docs = [...READMES, 'docs/loops.md', COMPAT_DOC, 'docs/lineup-advisor.md'];
  let links = 0;
  for (const rel of docs) {
    for (const m of read(rel).matchAll(/\]\(([^)#\s]+)(#[^)]*)?\)/g)) {
      if (/^[a-z]+:/i.test(m[1])) continue;
      links++;
      const target = path.normalize(path.join(path.dirname(rel), m[1]));
      if (!fs.existsSync(path.join(ROOT, target))) throw new Error(`${rel} links to ${target}, which does not exist`);
    }
  }
  return `${READMES.map((r) => `${path.basename(path.dirname(r)) === '.' ? 'root' : path.basename(path.dirname(r))} ${read(r).split('\n').length}`).join(' · ')} lines · ${links} relative links resolve`;
});

check('README documents the loop catalog (table header present)', () => {
  const t = read(LOOPS_README);
  if (!/\|\s*Your situation\s*\|\s*Loop\s*\|\s*Command\s*\|\s*Cost\s*\|\s*Stops when\s*\|/.test(t)) {
    throw new Error('README missing the five-loops catalog table header');
  }
});

// Graphify is a first-class prerequisite (D21): critics and the scorer query the graph instead of
// grepping cold. If the Prerequisites section loses the install one-liner, a new user hits an
// undocumented dependency the moment a loop runs a critic.
//
// Negative control (2026-07-12, reverted): replaced the section body with generic toolchain prose —
// exit 1, "Prerequisites section does not mention Graphify".
check('README documents Graphify as a prerequisite', () => {
  const t = read(LOOPS_README);
  if (!/### Prerequisites/.test(t)) throw new Error('README missing a Prerequisites section');
  const section = t.split('### Prerequisites')[1].split(/\n### /)[0];
  if (!/graphify/i.test(section)) throw new Error('Prerequisites section does not mention Graphify');
  if (!/uv tool install graphifyy|pipx install graphifyy|pip install graphifyy/.test(section)) {
    throw new Error('Prerequisites section missing the graphifyy install one-liner');
  }
});

// The terms this gate hunts are, by definition, the ones that must never appear in a public file —
// so they cannot live in this file either. Writing your clients' names into the door that guards them
// publishes them. They load from `private-terms.json`, which is gitignored; `private-terms.example.json`
// ships the shape and nothing else. A fork inherits the gate, never the terms.
//
// Matching is substring, not word: the leak that shipped inside a benchmark fixture was glued to its
// neighbour (`<name>_agent`), where a word boundary finds nothing. A term listed under `fenced` is the
// exception — one that hides inside innocent hyphenation and must not fire on it.
function loadPrivateTerms() {
  const file = path.join(ROOT, 'private-terms.json');
  if (!fs.existsSync(file)) return null;
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [
    ...(cfg.substring || []).map((t) => new RegExp(esc(t), 'i')),
    ...(cfg.fenced || []).map((t) => new RegExp(`(?<![a-z])${esc(t)}(?![a-z])`, 'i')),
  ];
}

// Negative control — a term from private-terms.json planted in the telemetry fixture: exit 1,
// sess-0001.jsonl:2 (2026-07-12). Re-verified 2026-07-13 after the terms moved out of this file.
check('no private contract leaks in commands/, agents/, benchmarks/, scripts/, docs/, skills/', () => {
  const leaks = loadPrivateTerms();
  // No terms file is not a pass. A gate that reports green because it was given nothing to look for is
  // the exact failure this repo keeps finding: absence of evidence read as evidence of absence.
  if (!leaks) skip('no private-terms.json — nothing was scanned (copy private-terms.example.json to enable)');
  if (!leaks.length) throw new Error('private-terms.json has no terms — the gate would pass vacuously');
  const files = [...walk('plugins'), ...walk('benchmarks'), ...walk('scripts'), ...walk('docs')];
  if (!files.length) throw new Error('nothing scanned — the gate would pass vacuously');
  for (const rel of files) {
    read(rel).split('\n').forEach((line, i) => {
      for (const re of leaks) {
        if (re.test(line)) throw new Error(`${rel}:${i + 1} leaks a private term (pattern withheld — see private-terms.json)`);
      }
    });
  }
  return `${files.length} files scanned against ${leaks.length} private term(s)`;
});

check('every hooks.json valid + every referenced script exists in its own plugin and parses', () => {
  const rels = hookManifests().flatMap(({ dir, hooks }) => (JSON.stringify(hooks).match(/scripts\/hooks\/[\w-]+\.js/g) || [])
    .map((s) => path.join(dir, s)));
  if (rels.length < 3) throw new Error(`expected ≥3 hook scripts referenced, found ${rels.length}`);
  for (const rel of new Set(rels)) {
    mustExist(rel);
    execFileSync('node', ['--check', path.join(ROOT, rel)], { stdio: 'pipe' });
  }
  return `${new Set(rels).size} scripts across ${hookManifests().length} manifests`;
});

// hooks.json is the only place a guard is installed and the README table is the only place a user
// learns what runs on every one of their tool calls. A guard added to one and not the other is a
// hook nobody consented to. So every PreToolUse script is bound to a table row, and the headline
// count in the install section is bound to the set — "three hooks" over a file that installs four is
// the README lying by one, which is still lying.
//
// Negative controls (2026-08-25, each applied, observed, reverted — all exit 1):
//   the repeat-tool-guard row struck from the README table ........................................
//     "README never discloses the PreToolUse guard 'repeat-tool-guard' — it runs on every tool call
//      and the install section does not say so"
//   "four guards that run on every session" reverted to "three" ....................................
//     "README's install sentence does not count four guards — hooks.json installs 4"
check('README discloses every PreToolUse guard hooks.json installs', () => {
  const h = { hooks: {} };
  for (const { hooks } of hookManifests()) {
    for (const [event, entries] of Object.entries(hooks)) h.hooks[event] = [...(h.hooks[event] || []), ...entries];
  }
  const scriptsOf = (event) => (h.hooks[event] || []).flatMap((g) => g.hooks.map((x) => {
    const m = /scripts\/hooks\/([\w-]+)\.js/.exec(x.command);
    return m ? m[1] : null;
  })).filter(Boolean);
  const guards = new Set(scriptsOf('PreToolUse'));
  if (guards.size < 3) throw new Error(`expected ≥3 PreToolUse guards in hooks.json, found ${guards.size}`);
  const t = read('README.md');
  const install = t.split('### Option 2')[0];
  for (const g of guards) {
    if (!new RegExp(`^\\|\\s*\`${g}\``, 'm').test(install)) {
      throw new Error(`README never discloses the PreToolUse guard '${g}' — it runs on every tool call and the install section does not say so`);
    }
  }
  // The same rule for every other event: a hook that runs on each prompt or each session start and
  // is named nowhere in the install section is a hook nobody consented to, guard or not.
  for (const event of Object.keys(h.hooks)) {
    if (event === 'PreToolUse') continue;
    for (const g of new Set(scriptsOf(event))) {
      if (!new RegExp(`^\\|\\s*\`${g}\``, 'm').test(install)) {
        throw new Error(`README never discloses the ${event} hook '${g}' in the install section`);
      }
    }
  }
  const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven'];
  const sentence = install.split('\n').find((l) => /guards that run on every session/.test(l));
  if (!sentence) throw new Error('README lost the "guards that run on every session" sentence that introduces the table');
  if (!new RegExp(`\\b${WORDS[guards.size]}\\b guards that run`).test(sentence)) {
    throw new Error(`README's install sentence does not count ${WORDS[guards.size]} guards — hooks.json installs ${guards.size}`);
  }
  return `${guards.size} PreToolUse guards, each in the README table`;
});

// The hook is the only writer of loop-telemetry.ndjson and the dashboard is the only reader: nothing
// validates the line shape at runtime, and the hook swallows its own errors by design (a dashboard is
// never worth failing a turn over). So a renamed field, a dropped agentType, or a line written for an
// event the schema does not cover fails silently, in production, for weeks — the exact shape of escape
// #4. This check is the only place that shape is asserted.
//
// Negative controls (2026-07-12, each applied, observed, reverted — all exit 1):
//   `ts` dropped from the emitted line .............. "emitted line missing required key ts"
//   EVENTS gate removed (every payload appended) .... "PreToolUse payload wrote a line — the hook must
//                                                      only emit on SubagentStop|Stop"
//   agentType stamped as p.agent_type ?? 'unknown' .. "Stop line carries agentType — an absent agent
//                                                      type is a fact, not a hole to fill"
check('loop-telemetry hook emits a schema-valid ndjson line', () => {
  const script = path.join(ROOT, 'plugins/harness-guards/scripts/hooks/loop-telemetry.js');
  mustExist('plugins/harness-guards/scripts/hooks/loop-telemetry.js');
  execFileSync('node', ['--check', script], { stdio: 'pipe' });

  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'loop-telemetry-')), 'telemetry.ndjson');
  const fire = (fixture) => execFileSync('node', [script], {
    input: read(path.join('scripts/fixtures/hooks', fixture)),
    env: { ...process.env, LOOP_TELEMETRY_FILE: out },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  fire('subagent-stop.json');
  fire('stop.json');
  fire('other-event.json');

  const lines = fs.readFileSync(out, 'utf8').split('\n').filter(Boolean);
  if (lines.length !== 2) {
    throw new Error(`${lines.length} line(s) written, expected 2 — a PreToolUse payload wrote a line: the hook must only emit on SubagentStop|Stop`);
  }

  const KEYS = new Set(['event', 'ts', 'sessionId', 'agentType']);
  const [sub, stop] = lines.map((l) => JSON.parse(l));
  for (const line of [sub, stop]) {
    for (const k of ['event', 'ts', 'sessionId']) {
      if (typeof line[k] !== 'string' || !line[k]) throw new Error(`emitted line missing required key ${k}`);
    }
    for (const k of Object.keys(line)) if (!KEYS.has(k)) throw new Error(`emitted line carries unknown key ${k}`);
    if (!Number.isFinite(Date.parse(line.ts))) throw new Error(`ts is not a parseable timestamp: ${line.ts}`);
    if (line.sessionId !== '0f2c9b41-demo') throw new Error(`sessionId lost: ${line.sessionId}`);
  }
  if (sub.event !== 'SubagentStop' || stop.event !== 'Stop') throw new Error('event name not carried through');
  if (sub.agentType !== 'implementer') throw new Error(`agentType lost: ${sub.agentType}`);
  if ('agentType' in stop) throw new Error('Stop line carries agentType — an absent agent type is a fact, not a hole to fill');

  fs.rmSync(path.dirname(out), { recursive: true, force: true });
  return '2 lines · SubagentStop+agentType, Stop';
});

// The guard is advisory by construction: it may only ever ADD context, never decide. Everything that
// makes it useful is invisible at runtime — canonical arguments (so a reordered key is the same call),
// the reset on a different call, the reset on a human prompt, per-session isolation — and everything
// that would make it dangerous is one line away (a `permissionDecision`). This check pins both sides.
//
// Negative controls (2026-08-25, each applied, observed, reverted — all exit 1):
//   canonical() replaced with plain JSON.stringify ...................................................
//     "call 3 (same arguments, keys reordered) did not fire — canonicalization is broken"
//   the `count = 1` reset on a different hash removed (counter keeps climbing) .......................
//     "another session's calls advanced this session's chain" — not the predicted message: with no
//     reset the chain sits at 7 after the different call (no threshold there), and the next call is
//     the 8th, which fires. Same defect, caught one assertion later.
//   permissionDecision: 'deny' added to the emitted object ...........................................
//     "the guard emitted a permissionDecision — it is advisory and may never decide"
//   the UserPromptSubmit branch removed ..............................................................
//     "a human prompt did not reset the chain — repetition across an interjection is not a loop"
//   the top-level `description` no longer stripped before hashing ....................................
//     "three Bash calls differing only in description did not fire — description is narration, not
//      the call" — this one was found live before it was a control: the first real session ran the
//     same grep three times with three descriptions and the guard stayed silent.
check('repeat-tool-guard emits additionalContext at run 3 and 5, not at 2 or 4, and never a permissionDecision', () => {
  const script = path.join(ROOT, 'plugins/harness-guards/scripts/hooks/repeat-tool-guard.js');
  mustExist('plugins/harness-guards/scripts/hooks/repeat-tool-guard.js');
  execFileSync('node', ['--check', script], { stdio: 'pipe' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repeat-tool-guard-'));
  const fire = (input) => execFileSync('node', [script], {
    input, env: { ...process.env, REPEAT_TOOL_GUARD_DIR: dir }, stdio: ['pipe', 'pipe', 'pipe'],
  }).toString();
  const fx = (name) => read(path.join('scripts/fixtures/hooks', name));
  const A = fx('pre-tool-use-repeat-a.json');
  const A2 = fx('pre-tool-use-repeat-a-reordered.json');
  const B = fx('pre-tool-use-repeat-b.json');
  const OTHER = fx('pre-tool-use-repeat-a-other-session.json');
  const PROMPT = fx('user-prompt-submit.json');

  const parse = (out, where) => {
    let o;
    try { o = JSON.parse(out); } catch { throw new Error(`${where}: stdout is not JSON: ${out.slice(0, 80)}`); }
    const h = o.hookSpecificOutput;
    if (!h || h.hookEventName !== 'PreToolUse') throw new Error(`${where}: hookSpecificOutput.hookEventName is not PreToolUse`);
    if (typeof h.additionalContext !== 'string' || !h.additionalContext) throw new Error(`${where}: additionalContext missing or empty`);
    if ('permissionDecision' in h || 'permissionDecisionReason' in h) throw new Error(`${where}: the guard emitted a permissionDecision — it is advisory and may never decide`);
    for (const k of Object.keys(o)) if (k !== 'hookSpecificOutput') throw new Error(`${where}: unknown top-level key ${k}`);
    return h.additionalContext;
  };

  if (fire(A) !== '') throw new Error('call 1 fired — the first call is never a repeat');
  if (fire(A2) !== '') throw new Error('call 2 fired — the threshold is 3');
  const out3 = fire(A);
  if (out3 === '') throw new Error('call 3 (same arguments, keys reordered) did not fire — canonicalization is broken');
  const third = parse(out3, 'call 3');
  if (!/3 consecutive/.test(third)) throw new Error('call 3 fired without its count');
  if (fire(A) !== '') throw new Error('call 4 fired — thresholds are 3, 5, 8');
  const fifth = parse(fire(A), 'call 5');
  if (!/5 consecutive/.test(fifth) || !/"pattern":"TODO"/.test(fifth)) throw new Error('call 5 did not carry the count and the canonical arguments');
  if (fire(B) !== '') throw new Error('a DIFFERENT call fired — it starts a new chain at 1');
  if (fire(A) !== '') throw new Error('call after a DIFFERENT call fired at 3 — the chain did not reset');
  // Another session's chain is its own: three calls there fire there and leave this one untouched.
  fire(OTHER); fire(OTHER);
  parse(fire(OTHER), 'other session, call 3');
  if (fire(A) !== '') throw new Error('another session\'s calls advanced this session\'s chain');
  // A human prompt resets: the demo chain sits at 2 (A, A) — after the prompt, A must be 1 again.
  if (fire(PROMPT) !== '') throw new Error('UserPromptSubmit wrote to stdout — it only resets');
  if (fire(A) !== '') throw new Error('a human prompt did not reset the chain — repetition across an interjection is not a loop');
  if (fire('not json') !== '') throw new Error('garbage stdin produced output');
  if (fire(fx('other-event.json')) !== '') throw new Error('a non-PreToolUse payload produced output');
  // The first live run: three identical Bash commands, zero reminders. The model had written a fresh
  // `description` on each ("(1/3)", "(2/3)", "(3/3)") and the chain never formed. Narration is not
  // the call.
  fire(fx('pre-tool-use-bash-desc-1.json')); fire(fx('pre-tool-use-bash-desc-2.json'));
  const bash3 = fire(fx('pre-tool-use-bash-desc-3.json'));
  if (bash3 === '' || !/3 consecutive identical `Bash`/.test(bash3)) {
    throw new Error('three Bash calls differing only in description did not fire — description is narration, not the call');
  }

  fs.rmSync(dir, { recursive: true, force: true });
  return 'fires at 3 and 5, resets on a different call and on a human prompt, ignores description, isolated per session, never decides';
});

check('install.sh parses (sh -n)', () => {
  mustExist('install.sh');
  execFileSync('sh', ['-n', path.join(ROOT, 'install.sh')], { stdio: 'pipe' });
});

// The transcript format is internal to Claude Code and can change without notice. These assertions are
// derived facts, not file-existence: each one dies if a shape this parser depends on moves. Asserting
// only that the fixture parses would guard the neighbouring failure mode, not the one that happens.
//
// Negative control (verifier-protocol.md: a check that can only say PASS is a broken thermometer).
// Each mutation was applied to the fixture, observed, and reverted — 2026-07-12, all exit 1:
//   usage → usageX in an agent jsonl ......... totals.runs = 6, expected 8
//   ephemeral_1h_input_tokens → ..._1h_in .... totals.cacheWrite5m = 1500, expected 500
//   truncated line at sess-0001.jsonl:2 ...... totals.runs = 7, expected 8
//   journal agentId → agent_id ............... totals.runs = 5, expected 8
//   workflowProgress label → "" .............. workflow agent join lost
check('loop-stats reconstructs the pinned telemetry fixture', () => {
  const script = path.join(ROOT, 'plugins/harness-guards/scripts/loop-stats.js');
  mustExist('plugins/harness-guards/scripts/loop-stats.js');
  execFileSync('node', ['--check', script], { stdio: 'pipe' });

  const raw = execFileSync('node', [script, '--root', path.join(ROOT, 'scripts/fixtures/telemetry'),
    '--project', 'demo', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const d = JSON.parse(raw);

  // usage.* summed across the session, the Task subagent and both workflow agents. The 5m/1h split is
  // asserted separately: cache_creation_input_tokens covers for a renamed subkey, so the collapsed
  // cacheWrite total stays right while every 1h write silently reprices at the cheaper 5m rate.
  const totals = { runs: 8, in: 17000, out: 2180, cacheRead: 25100, cacheWrite: 1500, cacheWrite5m: 500, cacheWrite1h: 1000 };
  for (const [k, want] of Object.entries(totals)) {
    if (d.totals[k] !== want) throw new Error(`totals.${k} = ${d.totals[k]}, expected ${want}`);
  }
  if (d.warnings !== 0) throw new Error(`${d.warnings} line(s) became unreadable`);

  // journal.agentId ↔ agent-<id>.jsonl ↔ workflowProgress.label: without the join these agents are
  // unlabelled and their tokens land nowhere.
  const rows = Object.fromEntries(d.agents.map((a) => [`${a.agentType}·${a.model}`, a]));
  const impl = rows['implementer·claude-opus-4-8'];
  if (!impl || !rows['reviewer·claude-fable-5']) throw new Error('workflow agent join lost');
  if (impl.out !== 1000) throw new Error(`joined implementer out = ${impl.out}, expected 1000`);

  const [wf] = d.workflows;
  if (!wf || wf.name !== 'develop-phase') throw new Error('workflow run record lost');
  if (wf.rounds !== 1 || wf.verdict !== 'APROBADO') throw new Error(`verdict/rounds drifted: ${wf.rounds}/${wf.verdict}`);
  if (wf.durationMs !== 1500000) throw new Error(`duration = ${wf.durationMs}, expected 1500000`);

  if (d.prompts.total !== 3) throw new Error(`prompts.total = ${d.prompts.total}, expected 3`);
  if (d.prompts.top[0].count !== 2) throw new Error('recurring-prompt count drifted');

  // an unpriced model must degrade to n/a, never to a guessed number or a crash
  if (typeof impl.costUsd !== 'number' || impl.costUsd <= 0) throw new Error('cost estimate lost');
  if (d.unpricedModels.length !== 1) throw new Error(`unpriced models = ${d.unpricedModels.length}, expected 1`);

  return `${d.totals.runs} runs · ${d.workflows.length} workflow · $${d.totals.costUsd.toFixed(2)} est.`;
});

// The clean fixture above only proves the happy path — a check that can only PASS is not a gate
// (process.md §0). This second fixture pins a truncated line and a non-JSON line, so a regression that
// turns readJsonl's skip-with-warning into a crash breaks CI, not a reverted manual mutation.
//
// Negative control: readJsonl's per-line try/catch removed (JSON.parse(line) left unguarded) —
// the truncated line now throws past parseSession into aggregate(), which aborts the whole run instead
// of skipping the one line: `loop-stats: Unterminated string in JSON at position 169 (line 1 column 170)`,
// exit 1 — and this check fails with it. Reverted (2026-07-12).
check('loop-stats degrades gracefully on the broken telemetry fixture', () => {
  const script = path.join(ROOT, 'plugins/harness-guards/scripts/loop-stats.js');
  const raw = execFileSync('node', [script, '--root', path.join(ROOT, 'scripts/fixtures/telemetry'),
    '--project', 'demo-broken', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const d = JSON.parse(raw);

  if (d.warnings !== 2) throw new Error(`warnings = ${d.warnings}, expected 2 (truncated line + non-JSON line)`);
  if (d.totals.runs !== 1) throw new Error(`totals.runs = ${d.totals.runs}, expected 1 — only the clean turn should survive`);

  return `${d.warnings} warnings · ${d.totals.runs} run survived`;
});

// `--project` takes a path as readily as a slug. The two are not interchangeable in one case that
// bites daily: Claude Code slugs the *realpath* of the cwd, so a project reached through a symlinked
// parent (~/Documents/pro-projects -> ~/projects/pro-projects here) has its telemetry under the
// realpath slug while every record inside still reports the symlink path as its cwd. Passing the
// path the user actually types must find the directory anyway, and a miss must name what was tried.
//
// Negative controls (2026-09-06, each applied, observed, reverted — all exit 1):
//   realpathSync dropped from slugCandidates .... symlinked-path candidates = 1, expected 2
//   candidate loop replaced by args.project ..... path form throws "no telemetry under ..."
check('loop-stats resolves --project from a slug, a path and a symlinked path', () => {
  const script = path.join(ROOT, 'plugins/harness-guards/scripts/loop-stats.js');
  const { slugCandidates } = require(script);

  const plain = slugCandidates('/workspace/demo');
  if (plain.length !== 1 || plain[0] !== '-workspace-demo') throw new Error(`path slug = ${JSON.stringify(plain)}`);
  const asSlug = slugCandidates('-workspace-demo');
  if (asSlug.length !== 1 || asSlug[0] !== '-workspace-demo') throw new Error('a slug must pass through untouched');

  const real = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-real-')));
  const linkDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-link-')));
  const link = path.join(linkDir, 'via-symlink');
  fs.symlinkSync(real, link);
  const both = slugCandidates(link);
  if (both.length !== 2) throw new Error(`symlinked-path candidates = ${both.length}, expected 2`);
  if (both[0] !== slugOfPath(real)) throw new Error('realpath slug must be tried first');
  if (both[1] !== slugOfPath(link)) throw new Error('the literal path must stay as a fallback candidate');

  // A path form must reach the same fixture the slug form reaches.
  const root = path.join(ROOT, 'scripts/fixtures/telemetry');
  const viaSlug = execFileSync('node', [script, '--root', root, '--project', 'demo', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (JSON.parse(viaSlug).totals.runs !== 8) throw new Error('slug form regressed');

  // And a miss must print the candidates, not just the first one.
  let stderr = '';
  try {
    execFileSync('node', [script, '--root', root, '--project', '/nonexistent/project-x', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    throw new Error('a missing project must exit non-zero');
  } catch (e) {
    stderr = String(e.stderr || '');
    if (!/tried: /.test(stderr)) throw new Error(`error must name the candidates tried, got: ${stderr.split('\n')[0]}`);
    if (!/available:/.test(stderr)) throw new Error('error must still list the available slugs');
  }
  return 'slug · path · symlinked path all resolve';
});

// --from-json re-renders a saved aggregate without re-walking the transcripts; --json-out saves it.
// The pair is what lets /dashboard and /session-review share one parse instead of paying for two.
//
// Negative control (2026-09-06, applied, observed, reverted): --from-json branch removed from main()
// so the flag fell through to a live aggregate — exit 1, "no telemetry under ... tried: -tmp-...".
check('loop-stats round-trips its aggregate through --json-out / --from-json', () => {
  const script = path.join(ROOT, 'plugins/harness-guards/scripts/loop-stats.js');
  const root = path.join(ROOT, 'scripts/fixtures/telemetry');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-json-'));
  const out = path.join(tmp, 'demo.json');

  execFileSync('node', [script, '--root', root, '--project', 'demo', '--json-out', out], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const saved = JSON.parse(fs.readFileSync(out, 'utf8'));
  if (saved.totals.runs !== 8) throw new Error(`--json-out wrote totals.runs = ${saved.totals.runs}, expected 8`);

  // Rendered from the file alone: --root points nowhere, so a live parse would abort.
  const rendered = execFileSync('node', [script, '--root', path.join(tmp, 'no-such-root'), '--from-json', out],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (!/LOOP-STATS/.test(rendered)) throw new Error('--from-json did not render the saved aggregate');
  return '--json-out → --from-json renders without touching transcripts';
});

// The signals fixture pins every transcript shape the operator blocks read. It exists because those
// shapes are internal and undocumented: a Claude Code release that renames `compactMetadata` or
// stops writing hook attachments must break CI here rather than quietly zero a column.
//
// Three of its records exist only to be NOT counted, which is the half of the fixture that matters:
// a prompt that mentions destructive-guard by name, a failed grep whose OUTPUT quotes a guard's
// blocked message (this repo greps its own transcripts, so a matcher that is not anchored at the
// start of the result invents fires out of its own logs), and a `Round 1.` turn a loop wrote to its
// own subagent — byte-identical to a keystroke, and only its shape gives it away.
//
// Negative controls (2026-09-06, each applied by hand, observed, reverted — all exit 1):
//   GUARD_FIRE unanchored (/harness-audit .../ without ^) ... destructive-guard fires = 1, expected 0
//   looksAgentAuthored disabled ............................ droppedAgentShaped = 0, expected 1
//   dedup window 60s → 0s .................................. dedupedRecords = 0, expected 1
//   Task-only spawn lookup (the pre-P0 code) ............... reviewer row absent — agent lands as "subagent"
//   hook attachments keyed per record instead of per toolUseID  otherHooks[0].runs = 3, expected 2
check('loop-stats mines tools, guards and hygiene from the signals fixture', () => {
  const script = path.join(ROOT, 'plugins/harness-guards/scripts/loop-stats.js');
  const raw = execFileSync('node', [script, '--root', path.join(ROOT, 'scripts/fixtures/telemetry'),
    '--project', 'demo-signals', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const d = JSON.parse(raw);
  if (d.warnings !== 0) throw new Error(`${d.warnings} line(s) became unreadable`);

  // tools: five Bash calls, four of which failed — three the same way, one blocked by a guard.
  const bash = d.tools.byName.find((r) => r.name === 'Bash');
  if (!bash || bash.calls !== 6 || bash.errors !== 5) throw new Error(`Bash = ${JSON.stringify(bash)}, expected 6 calls / 5 errors`);
  if (d.tools.totalCalls !== 10) throw new Error(`totalCalls = ${d.tools.totalCalls}, expected 10`);
  if (d.tools.errorClusters.length !== 1) throw new Error(`errorClusters = ${d.tools.errorClusters.length}, expected 1`);
  const [cluster] = d.tools.errorClusters;
  if (cluster.count !== 3 || cluster.tool !== 'Bash') throw new Error(`cluster = ${cluster.count}×${cluster.tool}, expected 3×Bash`);
  // A blocked call and a refused call are the guard and the human, never a crash to cluster.
  if (/no-verify|doesn't want to proceed/.test(cluster.sample)) throw new Error('a guard fire or a denial leaked into the crash clusters');

  if (d.tools.denials.count !== 1) throw new Error(`denials = ${d.tools.denials.count}, expected 1`);
  if (d.tools.denials.reasons[0].reason !== 'use the helper, do not inline it') {
    throw new Error(`denial reason = ${JSON.stringify(d.tools.denials.reasons[0].reason)}`);
  }
  if (d.tools.denials.reasons[0].tool !== 'Edit') throw new Error('the denial must name the tool it refused');
  if (d.tools.subagents.byType.reviewer !== 1) throw new Error('Agent spawn lost — subagent_type never reached the count');
  if (d.tools.planMode.exitPlanMode !== 1 || d.tools.planMode.sessionsWithPlanMode !== 1) throw new Error('plan mode not detected');
  if (d.tools.apiErrors !== 1) throw new Error(`apiErrors = ${d.tools.apiErrors}, expected 1`);

  // The Agent spawn also has to name the row its tokens land in.
  if (!d.agents.some((a) => a.agentType === 'reviewer')) throw new Error('Agent-spawned subagent lost its role — check the Task|Agent join');

  // guards: one real fire, and one guard named in prose that must stay at zero.
  const guards = Object.fromEntries(d.guards.pluginGuards.map((g) => [g.name, g.fires]));
  if (guards['block-no-verify'] !== 1) throw new Error(`block-no-verify fires = ${guards['block-no-verify']}, expected 1`);
  if (guards['destructive-guard'] !== 0) throw new Error('a guard merely named — in a prompt, or inside a failed grep of the logs — was counted as a fire');
  if (d.guards.otherHooks.length !== 1) throw new Error(`otherHooks = ${d.guards.otherHooks.length}, expected 1 (two attachments, one hook)`);
  if (d.guards.otherHooks[0].runs !== 2 || d.guards.otherHooks[0].nonZeroExit !== 1) {
    throw new Error(`hook runs/nonZero = ${d.guards.otherHooks[0].runs}/${d.guards.otherHooks[0].nonZeroExit}, expected 2/1`);
  }

  // hygiene: 10 user turns, minus one agent-shaped and one duplicate, is 8 events.
  const h = d.hygiene;
  if (d.prompts.total !== 10) throw new Error(`prompts.total = ${d.prompts.total}, expected 10`);
  if (h.humanPrompts !== 8) throw new Error(`humanPrompts = ${h.humanPrompts}, expected 8`);
  if (h.droppedAgentShaped !== 1) throw new Error(`droppedAgentShaped = ${h.droppedAgentShaped}, expected 1`);
  if (h.dedupedRecords !== 1) throw new Error(`dedupedRecords = ${h.dedupedRecords}, expected 1`);
  if (h.continuations.count !== 3 || h.continuations.afterAgentTurn !== 3) {
    throw new Error(`continuations = ${h.continuations.count}/${h.continuations.afterAgentTurn}, expected 3/3`);
  }
  if (h.corrections.count !== 1 || h.corrections.proxy !== true) throw new Error('the correction count must be 1 and must carry proxy: true');
  if (h.interrupts !== 1) throw new Error(`interrupts = ${h.interrupts}, expected 1`);
  if (h.compactions.count !== 1 || h.compactions.auto !== 1 || h.compactions.avgPreTokens !== 500000) {
    throw new Error(`compactions = ${JSON.stringify(h.compactions)}`);
  }
  if (h.modelSwitches.count !== 2 || h.modelSwitches.targets['opus[1m]'] !== 2) throw new Error('model switches lost — the wrapper tags arrive in either order');
  if (h.slashCommands['/grilling'] !== 1) throw new Error('a skill-backed slash command must be counted even when <command-message> comes first');
  if (h.skillCalls.grilling !== 1) throw new Error('Skill tool invocation lost');

  // The clean fixture must stay clean: new parsers may not invent signals where there are none.
  const old = JSON.parse(execFileSync('node', [script, '--root', path.join(ROOT, 'scripts/fixtures/telemetry'),
    '--project', 'demo', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  if (old.prompts.total !== 3) throw new Error(`the signal parsers moved prompts.total to ${old.prompts.total}`);
  if (old.hygiene.continuations.count !== 0 || old.hygiene.interrupts !== 0) throw new Error('hygiene invented a signal on the clean fixture');
  if (old.guards.pluginGuards.some((g) => g.fires)) throw new Error('a guard fired on a fixture with no blocked call');

  return `${d.tools.totalCalls} calls · 1 cluster ×3 · 1 denial · 1 guard fire · ${h.humanPrompts} human prompts`;
});

// The half of the dashboard that says what to do about itself: what is installed against what ran,
// what the last /session-review proposed against what the repo now contains, and the rules that turn
// both into cards. HOME is pointed at an empty directory so the user-level skill roots and the
// installed-plugin manifest cannot make this check depend on the machine it runs on.
//
// The assertion that matters most is the set of rules that stayed SILENT. A rule engine that fires
// on everything is the horoscope this repo keeps refusing to ship, and the thresholds are the only
// thing standing between the two: 3 continuations is below the floor of 5, 1 denial is below 3,
// 2 model switches are below 5. All three are present in the fixture, and none of them may fire.
//
// Negative controls (2026-09-06, each applied by hand, observed, reverted — all exit 1):
//   continue-token threshold 5 → 2 .................... cards gained continue-token
//   grepContract made case-sensitive .................. humanizer card = pending, expected promoted
//   DISPATCH/HABIT cards given state 'pending' ........ latest.pending = 4, expected 2
//   parseReviewCards regex loosened to /^▸/ ........... 5 cards parsed from a 4-card report
//   usedNotInstalled counting typed /names again ...... usedNotInstalled = [model], expected []
check('loop-stats reads the skill inventory, the review lifecycle, and fires cards only on evidence', () => {
  const script = path.join(ROOT, 'plugins/harness-guards/scripts/loop-stats.js');
  const root = path.join(ROOT, 'scripts/fixtures/telemetry');
  const repo = path.join(ROOT, 'scripts/fixtures/repo');
  const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-home-'));
  const run = (args) => JSON.parse(execFileSync('node', [script, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HOME: emptyHome },
  }));

  const d = run(['--root', root, '--project', 'demo-signals', '--repo', repo, '--json']);

  // inventory: two project skills, one of them invoked in the transcript.
  if (d.skills.bySource.project !== 2) throw new Error(`project skills = ${d.skills.bySource.project}, expected 2`);
  const grilling = d.skills.used.find((u) => u.name === 'grilling');
  if (!grilling || grilling.viaSkillTool !== 1 || grilling.viaSlash !== 1) {
    throw new Error(`grilling = ${JSON.stringify(grilling)}, expected 1 via the Skill tool and 1 typed`);
  }
  // advice: the unused project skill is an uninstall candidate with the 'unused' reason and its own
  // word count; the used one is kept; a typed built-in (/model) is neither. Outcomes: grilling was
  // followed by a bare «continua», which is counted, and by nothing that looks like a correction.
  // caught: the receipt is a list of events, each one traceable. The repo fixture holds one promoted
  // review card, one A/B row, one verified and one falsified prediction; the signals transcript holds
  // one guard fire (block-no-verify) and no rejected workflow. 1+1+1+1+1 = 5, plus the fixture's
  // LEARNINGS.md entries. The advisory repeat-tool-guard never counts as a catch.
  const cg = d.caught;
  if (!cg) throw new Error('caught missing');
  if (cg.guardFires.length !== 1 || cg.guardFires[0].name !== 'block-no-verify' || cg.guardFires[0].fires !== 1) throw new Error(`caught.guardFires = ${JSON.stringify(cg.guardFires)}`);
  if (cg.promoted.length !== 1) throw new Error(`caught.promoted = ${cg.promoted.length}, expected 1`);
  if (cg.ab.length !== 1 || cg.predictions.verified !== 1 || cg.predictions.falsified !== 1) throw new Error(`caught savings drifted: ${JSON.stringify({ ab: cg.ab.length, p: cg.predictions })}`);
  if (cg.total !== 5 + cg.learnings) throw new Error(`caught.total = ${cg.total}, expected ${5 + cg.learnings}`);
  if (!d.cards.some((c) => c.rule === 'harness-caught')) throw new Error('harness-caught card did not fire on a fixture with 5 events');
  const adv = d.skills.advice;
  if (!adv || JSON.stringify(adv.keep) !== '["grilling"]') throw new Error(`advice.keep = ${JSON.stringify(adv && adv.keep)}`);
  if (adv.uninstall.length !== 1 || adv.uninstall[0].name !== 'unused-one') throw new Error(`advice.uninstall = ${JSON.stringify(adv.uninstall)}`);
  if (adv.uninstall[0].reasons[0].code !== 'unused' || adv.uninstall[0].words !== 17) throw new Error(`uninstall reason drifted: ${JSON.stringify(adv.uninstall[0].reasons)}`);
  if (adv.improve.length !== 0) throw new Error(`advice.improve fired on one use: ${JSON.stringify(adv.improve)}`);
  const oc = d.hygiene.skillOutcomes.grilling;
  if (!oc || oc.uses !== 1 || oc.continued !== 1 || oc.corrected !== 0) throw new Error(`skillOutcomes.grilling = ${JSON.stringify(oc)}`);
  if (JSON.stringify(d.skills.installedNotUsed.project) !== JSON.stringify(['unused-one'])) {
    throw new Error(`installedNotUsed.project = ${JSON.stringify(d.skills.installedNotUsed.project)}`);
  }
  // A typed /model is a built-in, not a skill someone deleted.
  if (d.skills.usedNotInstalled.length !== 0) throw new Error(`usedNotInstalled = ${JSON.stringify(d.skills.usedNotInstalled)}, expected []`);
  if (!d.skills.roles.includes('reviewer')) throw new Error('.claude/agents roles not read');

  // lifecycle: four cards, one promoted by a term that IS in the contract, one pending because its
  // term is not, one skill card pending because nothing of that name is installed, one n/a.
  const rv = d.reviews;
  if (!rv || !rv.latest) throw new Error('the session-review report was not found');
  if (rv.latest.cards.length !== 4) throw new Error(`cards parsed = ${rv.latest.cards.length}, expected 4`);
  const byState = rv.latest.cards.map((c) => `${c.type}:${c.state}`);
  const want = ['AGENTS.md RULE:promoted', 'AGENTS.md RULE:pending', 'SKILL CANDIDATE:pending', 'HABIT:n/a'];
  if (JSON.stringify(byState) !== JSON.stringify(want)) throw new Error(`states = ${JSON.stringify(byState)}`);
  if (!/^AGENTS\.md:\d+$/.test(rv.latest.cards[0].evidence)) throw new Error(`promotion evidence = ${rv.latest.cards[0].evidence}, expected AGENTS.md:<line>`);
  if (rv.latest.promoted !== 1 || rv.latest.pending !== 2) throw new Error(`promoted/pending = ${rv.latest.promoted}/${rv.latest.pending}, expected 1/2`);

  // cards: exactly the three the evidence supports, and not one of the three below threshold.
  const fired = d.cards.map((c) => c.rule).sort();
  const expected = ['harness-caught', 'repeated-crash', 'review-pending', 'review-stale'];
  if (JSON.stringify(fired) !== JSON.stringify(expected)) throw new Error(`cards = ${JSON.stringify(fired)}, expected ${JSON.stringify(expected)}`);
  for (const belowThreshold of ['continue-token', 'denials-as-rules', 'manual-model-switch', 'skill-shelfware']) {
    if (!d.rulesSilent.includes(belowThreshold)) throw new Error(`${belowThreshold} fired below its threshold`);
  }
  for (const c of d.cards) {
    if (!c.evidence || !c.doesNotProve || !c.source) throw new Error(`card ${c.rule} is missing evidence, its limits, or its source field`);
  }

  // Without --repo there is no contract to grep and no report to read: absent, not empty.
  const noRepo = run(['--root', root, '--project', 'demo-signals', '--json']);
  if (noRepo.reviews !== null) throw new Error('reviews must be null when no repo carries a report');
  if (noRepo.cards.some((c) => c.rule === 'review-pending')) throw new Error('a lifecycle card fired with no lifecycle to read');

  // And a project with the same repo but a clean transcript fires only the lifecycle cards: a card
  // needs evidence in the window, not merely a repo that has one.
  const clean = run(['--root', root, '--project', 'demo', '--repo', repo, '--json']);
  if (clean.cards.some((c) => c.rule === 'repeated-crash')) throw new Error('a crash card fired on a transcript with no failures');

  return `${d.skills.installed} skills · ${rv.latest.cards.length} review cards (${rv.latest.promoted} promoted) · ${d.cards.length} cards · ${d.rulesSilent.length} silent`;
});

// /dashboard's whole claim is that it costs nothing: the script counts, the command prints. A version
// of it that opened a .jsonl "for more context" would be a token-hungry command wearing a free one's
// description, and the failure would be invisible — the report would still render.
//
// It also has to survive the two installs. Under the plugin, ${CLAUDE_PLUGIN_ROOT} resolves; under
// `install.sh --target claude`, which copies scripts/ next to the commands, only the :-.claude
// fallback does. A command that hardcodes either one is broken in the other.
//
// Negative controls (2026-09-06, each applied, observed, reverted — all exit 1):
//   ${CLAUDE_PLUGIN_ROOT} without the :-.claude fallback ... "must use the ${CLAUDE_PLUGIN_ROOT:-.claude} form"
//   disable-model-invocation removed ...................... "must be manual-only"
//   a Read of a .jsonl added to the body .................. "must not read transcripts itself"
check('dashboard-harness runs the script and never parses transcripts itself', () => {
  const rel = commandPath('dashboard-harness');
  mustExist(rel);
  hasFrontmatterField(rel, 'description');
  hasFrontmatterField(rel, 'argument-hint');
  const body = read(rel);

  if (!/\$\{CLAUDE_PLUGIN_ROOT:-\.claude\}\/scripts\/loop-stats\.js/.test(body)) {
    throw new Error('dashboard must use the ${CLAUDE_PLUGIN_ROOT:-.claude} form — the bare variable is undefined under install.sh --target claude, and a bare relative path resolves against the user\'s cwd');
  }
  if (!/^disable-model-invocation:\s*true\s*$/m.test(body.split('---')[1] || '')) {
    throw new Error('dashboard must be manual-only: half of what it renders is about the human');
  }
  if (!/allowed-tools:.*Bash\(node:\*\)/.test(body)) throw new Error('dashboard must be allowed to run the script');
  // The command may name .jsonl when it explains why it does NOT read one; what it may not do is
  // instruct a read of one.
  if (/\b(Read|Grep|Glob)\b[^\n]{0,80}\.jsonl/.test(body)) {
    throw new Error('dashboard must not read transcripts itself — the script counts, the command prints');
  }
  if (!/do not (parse|read) a `?\.jsonl/i.test(body)) {
    throw new Error('dashboard must say, in the body, that it does not parse transcripts — the rule is load-bearing and invisible when broken');
  }

  // PRD-003 is what the raised command cap points at; a cap raised without its argument is just a
  // bigger cap.
  const prd = read('docs/prds/PRD-003-operator-dashboard.md');
  if (!/Why a sixth command/.test(prd)) throw new Error('PRD-003 must carry the argument for the sixth command');
  return 'manual-only · plugin-root fallback · counts nothing itself';
});

// --all walks every project on the machine, and the property that matters is what it does with the
// one it cannot read: a corrupt slug is a row in failedProjects, never an abort. The telemetry
// fixture root carries a deliberately broken project for exactly this, so the assertion is not
// hypothetical.
//
// --brief is the other half of the same bargain: /session-review pays for a context window, so the
// script hands it the judgment fields and withholds the accounting. A field nobody reads is vapour,
// and a key set that drifts silently is how the brief stops being brief.
//
// Negative controls (2026-09-06, each applied by hand, observed, reverted — all exit 1):
//   aggregate() called outside the try/catch in aggregateAll ... the whole run aborts on demo-broken
//   'agents' added to BRIEF_KEYS ............................... brief carries the accounting again
//   --repo forwarded into each project of --all ................ every project reports one repo's cards
check('loop-stats aggregates every project under --all, and --brief withholds the accounting', () => {
  const script = path.join(ROOT, 'plugins/harness-guards/scripts/loop-stats.js');
  const root = path.join(ROOT, 'scripts/fixtures/telemetry');
  const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-all-'));
  const run = (args) => JSON.parse(execFileSync('node', [script, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HOME: emptyHome },
  }));

  const all = run(['--root', root, '--all', '--json']);
  if (all.mode !== 'all') throw new Error('--all must mark its own aggregate');
  const names = all.projects.map((p) => p.project).sort();
  if (JSON.stringify(names) !== JSON.stringify(['demo', 'demo-broken', 'demo-signals'])) {
    throw new Error(`--all projects = ${JSON.stringify(names)}`);
  }
  // The broken project is READ, not skipped: its two unreadable lines are warnings on its own row.
  if (all.failedProjects.length !== 0) throw new Error(`failedProjects = ${JSON.stringify(all.failedProjects)}, expected none`);
  const broken = all.projects.find((p) => p.project === 'demo-broken');
  if (broken.warnings !== 2) throw new Error(`demo-broken warnings = ${broken.warnings}, expected 2 — a project that degraded must say so on its own row`);
  if (all.totals.projects !== 3) throw new Error(`totals.projects = ${all.totals.projects}`);
  const grilling = all.skills.find((sk) => sk.name === 'grilling');
  if (!grilling || grilling.count !== 1 || grilling.projects !== 1) throw new Error(`cross-project skills = ${JSON.stringify(all.skills)}`);
  // Cross-project prompts are deliberately absent: eight identical words mean different things in
  // two repositories, and a "top prompt" pooled across them is a category error.
  if (all.prompts !== undefined) throw new Error('--all must not pool recurring prompts across projects');

  // --brief: exactly the judgment fields, and none of the accounting.
  const mod = require(script);
  const brief = run(['--root', root, '--project', 'demo-signals', '--repo', path.join(ROOT, 'scripts/fixtures/repo'), '--json', '--brief']);
  const keys = Object.keys(brief).sort();
  const want = mod.BRIEF_KEYS.slice().sort();
  if (JSON.stringify(keys) !== JSON.stringify(want)) throw new Error(`brief keys = ${JSON.stringify(keys)}, expected ${JSON.stringify(want)}`);
  for (const accounting of ['agents', 'totals', 'timeline', 'workflows', 'savings', 'lineup', 'loopRuns']) {
    if (brief[accounting] !== undefined) throw new Error(`--brief carries ${accounting}, which a judgment pass never reads`);
  }
  // …but it must still carry the fields §1 of the command promises.
  for (const promised of [brief.tools.denials, brief.tools.errorClusters, brief.cards, brief.reviews,
    brief.skills.installedNotUsed, brief.prompts.top]) {
    if (promised === undefined) throw new Error('--brief dropped a field /session-review section 1 promises');
  }
  if (brief.hygiene.droppedAgentShaped === undefined || brief.hygiene.dedupedRecords === undefined) {
    throw new Error('--brief must carry the two counts section 2 tells the model to report');
  }

  // The card line format is a parser contract, and the command has to keep writing it.
  const cmd = read(commandPath('session-review'));
  // The flag has to be on the invocation, not merely explained in the prose next to it.
  const invocation = (cmd.match(/^.*loop-stats\.js.*$/m) || [''])[0];
  if (!/--brief/.test(invocation)) throw new Error('/session-review must pass --brief on the command line — without it the loop pays for the accounting too');
  if (!/▸ LIFECYCLE/.test(cmd)) throw new Error('/session-review must emit the LIFECYCLE card the dashboard reads back');
  if (!/loop-stats.{0,40}pars/is.test(cmd)) throw new Error('/session-review must say that its card lines are parsed back, or the next author will restyle them');
  const parsed = mod.parseReviewCards('▸ **HABIT**             10 turns are only «continua» ×10\n▸ not a card\n');
  if (parsed.length !== 1 || parsed[0].type !== 'HABIT' || parsed[0].count !== 10) {
    throw new Error(`the card parser drifted from the format the command writes: ${JSON.stringify(parsed)}`);
  }

  return `${all.projects.length} projects · ${all.failedProjects.length} unreadable · brief = ${keys.length} keys`;
});

// D25a — the HARD guardrail is the one piece of F11 that must never have a confirmable escape
// hatch: a lineup that puts the reviewer in the implementer's model family has to be rejected by
// construction, not by a prompt someone can click through. So each fixture below pins an id shape
// that reaches familyOf() and that a naive comparison lets through:
//
//   invalid-same-family ....... opus-4-7 vs opus-4-8 — same line, different version. A full-string
//                               compare misses it.
//   invalid-provider-qualified  nvidia-nim/claude-opus-4-8 vs claude-opus-4-8 — same weights behind
//                               a provider prefix, and NOT a hypothetical: stampValue() emits
//                               exactly this `provider/model` shape for multi-provider targets, so
//                               a stamped value copied back into a lineup would blind the one rule
//                               D25 declares non-confirmable.
//   invalid-legacy-id ......... claude-3-5-sonnet-20241022 vs claude-sonnet-5 — the legacy id puts
//                               the version BEFORE the tier, so a position-based parse reads the
//                               family as "claude-3".
//
// Negative controls — each mutation applied, observed, reverted (2026-07-12, all exit 1):
//   reviewer in invalid-same-family.json → claude-fable-5 (a genuinely different family) ..........
//     resolve exited 0 instead of 2 → "accepted a lineup where reviewer and implementer share a
//     model family (invalid-same-family.json) — the independence property (D25a) did not fire"
//   familyOf's dropProvider() removed (tier read from the raw id, provider prefix intact) .........
//     nvidia-nim/claude-opus-4-8 resolved to family "nvidia-nim/claude-opus-4" ≠ "claude-opus",
//     resolve exited 0 → "…(invalid-provider-qualified.json) — the independence property (D25a)
//     did not fire". This is the finding's own failure mode, not a neighbour's.
//   familyOf's segment scan → positional /^claude-([a-z]+)-/ ......................................
//     claude-3-5-sonnet-20241022 resolved to family "claude-3-5-sonnet" ≠ "claude-sonnet",
//     resolve exited 0 → "…(invalid-legacy-id.json) — the independence property (D25a) did not fire"
check('model-lineup.js rejects same-family reviewer/implementer fixtures', () => {
  const script = path.join(ROOT, 'plugins/harness-audit/scripts/model-lineup.js');
  mustExist('plugins/harness-audit/scripts/model-lineup.js');
  execFileSync('node', ['--check', script], { stdio: 'pipe' });

  execFileSync('node', [script, 'resolve', '--target', 'claude',
    '--file', path.join(ROOT, 'scripts/fixtures/lineup/valid.json')], { stdio: 'pipe' });

  const rejected = ['invalid-same-family.json', 'invalid-provider-qualified.json', 'invalid-legacy-id.json'];
  for (const fixture of rejected) {
    let status = null;
    try {
      execFileSync('node', [script, 'resolve', '--target', 'claude',
        '--file', path.join(ROOT, 'scripts/fixtures/lineup', fixture)], { stdio: 'pipe' });
    } catch (e) { status = e.status; }
    if (status === null) {
      throw new Error(`accepted a lineup where reviewer and implementer share a model family (${fixture}) — the independence property (D25a) did not fire`);
    }
    if (status !== 2) throw new Error(`${fixture}: expected exit 2 (hard violation), got ${status}`);
  }

  return `valid fixture resolves clean, ${rejected.length} same-family fixtures rejected (exit 2)`;
});

// D25c — `check` is the only thing in this repo that reads the *live* model registry, and it exists
// because a line-up can be perfectly valid JSON, pass every guardrail above, and still name a model
// no provider serves. That is not hypothetical: `~/.agents/model-lineup.json` shipped
// `nvidia-nim/zai/glm-5.2` for months (the real pair is `nvidia/z-ai/glm-5.2`) and the only symptom
// was a scorer dispatch that hung 120s and exited 1 — no error naming the model.
//
// The catalog is pinned to a fixture, not read from `pi --list-models`, so this check means the same
// thing on a machine without pi installed. The live path is exercised by hand; the parse is shared.
//
// Negative controls — each mutation applied, observed, reverted (2026-08-20, both exit 1):
//   squash() → identity (exact string compare for suggestions) ....................................
//     still exit 1, but the message lost "did you mean nvidia/z-ai/glm-5.2?" → the check would name
//     a problem without naming the fix, which is the whole value here.
//   catalogProblems() skipping entries whose provider is unknown ..................................
//     nvidia-nim/zai/glm-5.2 passed silently, exit 0 → "check accepted a model no catalog serves".
check('model-lineup.js check catches a lineup naming a model no provider serves', () => {
  const script = path.join(ROOT, 'plugins/harness-audit/scripts/model-lineup.js');
  const catalog = path.join(ROOT, 'scripts/fixtures/lineup/catalog-pi.txt');
  mustExist('scripts/fixtures/lineup/catalog-pi.txt');
  mustExist('scripts/fixtures/lineup/invalid-catalog-miss.json');

  execFileSync('node', [script, 'check', '--file', path.join(ROOT, 'scripts/fixtures/lineup/valid.json'),
    '--catalog', catalog], { stdio: 'pipe' });

  let status = null;
  let stderr = '';
  try {
    execFileSync('node', [script, 'check', '--file', path.join(ROOT, 'scripts/fixtures/lineup/invalid-catalog-miss.json'),
      '--catalog', catalog], { stdio: 'pipe' });
  } catch (e) { status = e.status; stderr = String(e.stderr || ''); }
  if (status === null) throw new Error('check accepted a lineup naming a model no catalog serves (invalid-catalog-miss.json)');
  if (status !== 1) throw new Error(`invalid-catalog-miss.json: expected exit 1, got ${status}`);
  if (!stderr.includes('nvidia/z-ai/glm-5.2')) {
    throw new Error(`check named the problem but not the fix — stderr lacks the corrected id: ${stderr.trim()}`);
  }

  // A machine without pi must not fail the line-up it cannot read a catalog for.
  const skipped = execFileSync('node', [script, 'check', '--file', path.join(ROOT, 'scripts/fixtures/lineup/valid.json'),
    '--catalog', path.join(ROOT, 'scripts/fixtures/lineup/does-not-exist.txt')], { encoding: 'utf8' });
  if (!/SKIPPED/.test(skipped)) throw new Error(`an unreadable catalog should SKIP, not pass silently: ${skipped.trim()}`);

  return 'valid lineup passes · wrong pair rejected (exit 1) and the corrected id named · unreadable catalog skips';
});

// The editor is the only way a model id is supposed to enter the line-up, so its non-TTY path is the
// one this check can reach: it must print the matrix and run the same gates, never open raw mode.
// (A TUI that grabbed stdin here would hang the preflight instead of failing it.)
//
// Negative controls — each mutation applied, observed, reverted (2026-08-20):
//   the isTTY guard in main() removed .................. process.stdin.setRawMode threw
//     "The "process.stdin" property must be TTY" → the check failed, which is the point: a pipe must
//     never reach the interactive path.
//   paint() always returning the escape wrapper ........ the piped matrix carried \x1b[2m around every
//     cell → "static output must be pipe-safe" fired.
check('lineup-ui prints and validates the matrix without a TTY', () => {
  const script = path.join(ROOT, 'plugins/harness-audit/scripts/lineup-ui.js');
  mustExist('plugins/harness-audit/scripts/lineup-ui.js');
  mustExist('plugins/harness-audit/bin/lineup');
  execFileSync('node', ['--check', script], { stdio: 'pipe' });

  const catalog = path.join(ROOT, 'scripts/fixtures/lineup/catalog-pi.txt');
  const out = execFileSync('node', [script, '--global', path.join(ROOT, 'scripts/fixtures/lineup/valid.json'),
    '--catalog', catalog], { encoding: 'utf8' });
  for (const role of ['architect', 'implementer', 'reviewer', 'judge']) {
    if (!out.includes(role)) throw new Error(`the printed matrix is missing the ${role} row`);
  }
  if (!out.includes('nvidia/z-ai/glm-5.2')) throw new Error('the printed matrix does not show the pi override');
  if (out.includes('\x1b[')) throw new Error('static output must be pipe-safe — it still carries ANSI escapes');
  if (!/✓/.test(out)) throw new Error(`a valid lineup should print the ok marker: ${out}`);

  let status = null;
  let bad = '';
  try {
    bad = execFileSync('node', [script, '--global', path.join(ROOT, 'scripts/fixtures/lineup/invalid-catalog-miss.json'),
      '--catalog', catalog], { encoding: 'utf8' });
  } catch (e) { status = e.status; bad = String(e.stdout || ''); }
  if (status !== 1) throw new Error(`a lineup naming a nonexistent model must exit 1 from the viewer, got ${status}`);
  if (!bad.includes('nvidia/z-ai/glm-5.2')) throw new Error('the viewer flagged the bad entry without naming the corrected id');

  return 'matrix printed pipe-safe · valid lineup ✓ · unknown model exits 1 and names the fix';
});

// D25d — the advisor is the only thing in this repo that turns "which model is best" into a number,
// and the only way to keep a number honest is to pin the inputs. The fixtures are five real snapshots
// (AA, LMArena, SWE-bench, OpenRouter, `pi --list-models`) trimmed to ~18 models, chosen so that every
// rule the advisor claims to enforce has a case that would violate it:
//   stealth/ox-alpha ....... free, RETAINS prompts, and — in the AA fixture only — given a synthetic
//                            coding index of 90 so that it WOULD win every code role on merit. The real
//                            AA has no row for it; the synthetic row is labelled as such in the fixture.
//                            Without that row the privacy rule is never the operative filter (a model
//                            with no metrics is dropped earlier) and the check would pass by accident.
//   claude-opus-5:batch .... async endpoint → never a candidate
//   ~deepseek/...-latest ... floating alias → never a candidate
//   openrouter/free ........ random router → only ever the explainer
//   kimi-k3 on 3 providers . the same weights, so the reviewer must land in a different FAMILY (D25a),
//                            not merely on a different provider
//
// Negative controls — each mutation applied, observed, reverted (2026-08-25):
//   `sensitive` dropped from the implementer profile → ox-alpha ranked #1 for implementer (coding 90,
//     free) → "sees code, yet a retains model was suggested for a client repo". Before the synthetic AA
//     row existed this mutation did NOT fire — recorded here because that is the whole reason the row
//     is in the fixture.
//   `excludeFamily` not passed for reviewer → reviewer top-1 = kimi-k3 = implementer top-1 → D25a check
//     fired.
check('lineup-advise produces a report from pinned fixtures and honours privacy + D25a', () => {
  const script = path.join(ROOT, 'plugins/harness-audit/scripts/lineup-advise.js');
  const fixtures = path.join(ROOT, 'scripts/fixtures/advise');
  mustExist('plugins/harness-audit/scripts/lineup-advise.js');
  mustExist('plugins/harness-audit/scripts/lineup-aliases.json');
  for (const f of ['aa', 'lmarena', 'swebench', 'openrouter', 'pi']) mustExist(`scripts/fixtures/advise/${f}-2026-08-25.json`);
  execFileSync('node', ['--check', script], { stdio: 'pipe' });

  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'advise-'));
  // A lineup file that does not exist → advisor falls back to an empty current lineup, sensitivity `client`.
  execFileSync('node', [script, '--offline', '--no-probe', '--fixtures', fixtures, '--out', out,
    '--project', path.join(out, 'none.json')], { stdio: 'pipe', env: { ...process.env, HOME: out } });

  const md = fs.readFileSync(path.join(out, 'lineup-advice.md'), 'utf8');
  for (const section of ['## Fuentes', '## Diff contra el line-up actual', '## Top 3 por rol', '## Gratis en OpenRouter hoy', '## No pude mapear']) {
    if (!md.includes(section)) throw new Error(`report is missing the section "${section}"`);
  }
  const json = JSON.parse(fs.readFileSync(path.join(out, 'lineup-advice.json'), 'utf8'));
  if (json.sensitivity !== 'client') throw new Error(`default sensitivity should be client, got ${json.sensitivity}`);

  // Pinned here, NOT read from the script's PROFILES: a mutation that drops `sensitive` from a profile
  // would otherwise drop the assertion with it and the check would pass for the wrong reason (it did,
  // the first time).
  const CODE_FACING = new Set(['architect', 'orchestrator', 'implementer', 'reviewer', 'critic']);
  const { familyOf } = require(path.join(ROOT, 'plugins/harness-audit/scripts/model-lineup.js'));
  for (const [role, list] of Object.entries(json.suggestions)) {
    for (const s of list) {
      if (s.id.endsWith(':batch')) throw new Error(`${role}: a :batch endpoint was offered (${s.id})`);
      if (s.model.startsWith('~')) throw new Error(`${role}: a floating ~alias was offered (${s.id})`);
      if (s.model === 'openrouter/free' && role !== 'explainer') throw new Error(`${role}: the random free router was offered`);
      if (CODE_FACING.has(role) && s.data.policy === 'retains') throw new Error(`${role} sees code, yet a retains model was suggested for a client repo (${s.id})`);
      // The user's rule, verbatim: NIM's free tier is for answering questions about the project, never
      // for a seat that runs for an afternoon. A free model is not a free afternoon.
      if (s.provider === 'nvidia' && role !== 'explainer') throw new Error(`${role}: an NVIDIA NIM model was suggested for a long-running role (${s.id}) — quota rule not applied`);
      if (s.provider === 'openrouter' && s.price_out === 0 && !['explainer', 'preflight'].includes(role)) throw new Error(`${role}: an OpenRouter free-tier model was suggested for a long-running role (${s.id})`);
    }
  }
  const impl = json.suggestions.implementer[0];
  const rev = json.suggestions.reviewer[0];
  if (!impl || !rev) throw new Error('fixtures must yield an implementer and a reviewer suggestion');
  if (familyOf({ model: impl.model }) === familyOf({ model: rev.model })) {
    throw new Error(`reviewer top-1 (${rev.id}) shares the implementer's family (${impl.id}) — D25a not applied`);
  }
  if (!md.includes('stealth/ox-alpha') || !md.includes('RETIENE')) throw new Error('the free-models table must list ox-alpha with its retention note');

  return `report rendered · ${Object.keys(json.suggestions).length} roles · retains never on code roles · NIM/free only on short roles · reviewer ${familyOf({ model: rev.model })} ≠ implementer ${familyOf({ model: impl.model })}`;
});

// The shipped `model:` values in agents/*.md are the exact thing a reader opening one of those files
// on GitHub reacts to — "why is this hardcoded?" — so the README has to answer it where that reader
// lands, in the vocabulary the code actually enforces, not a softer paraphrase. Grounded three ways so
// none of the three assertions below can drift from what's real: the tiers named come from the actual
// frontmatter (not a hardcoded guess), the independence wording is checked against hardViolation()'s
// real message, and the "why not delete it" consequence has to name the mechanism (inherits the
// session's model) and the concrete failure mode (mirror), not just assert "independence" as a virtue.
//
// Negative control (2026-07-13, reverted): "D25a" deleted from the README section's independence
// sentence — exit 1, "README never explains the independence guardrail in the vocabulary
// model-lineup.js actually uses (family / D25a)".
check("README documents the default model line-up and why `model:` can't just be deleted", () => {
  const t = read(AUDIT_README);
  if (!/## The default model line-up/i.test(t)) throw new Error('README lost the model-line-up disclosure section');
  const section = t.split(/## The default model line-up[^\n]*\n/i)[1].split(/\n## /)[0];

  const tiers = new Set();
  for (const rel of agentsMd()) {
    const m = /^model:\s*(\S+)/m.exec(read(rel).split('---')[1] || '');
    if (m) tiers.add(m[1]);
  }
  if (!tiers.size) throw new Error('no agents/*.md carries a model: field — nothing to disclose (this check is stale)');
  for (const tier of tiers) {
    if (!new RegExp(`\\b${tier}\\b`).test(section)) {
      throw new Error(`README's model-line-up section never names the "${tier}" tier agents/*.md actually ships`);
    }
  }

  const { hardViolation } = require(path.join(ROOT, 'plugins/harness-audit/scripts/model-lineup.js'));
  const sameFamily = {
    reviewer: { model: 'claude-sonnet-4-5', family: 'claude-sonnet' },
    implementer: { model: 'claude-sonnet-4-5', family: 'claude-sonnet' },
  };
  const msg = hardViolation(sameFamily);
  if (!msg || !/family/i.test(msg) || !/D25a/.test(msg)) {
    throw new Error("hardViolation()'s message no longer mentions family/D25a — the fixture grounding this check is stale");
  }
  if (!/family/i.test(section) || !/D25a/.test(section)) {
    throw new Error('README never explains the independence guardrail in the vocabulary model-lineup.js actually uses (family / D25a)');
  }

  const CONSEQUENCE = /delet\w*[\s\S]{0,400}(inherit|session)|(?:inherit|session)[\s\S]{0,400}delet\w*/i;
  if (!CONSEQUENCE.test(section)) {
    throw new Error('README never explains what deleting model: actually does (every agent inherits the session model) — it only asserts the guardrail without the mechanism');
  }
  if (!/mirror/i.test(section)) {
    throw new Error('README never names the concrete failure mode (reviewer becomes a mirror of the implementer)');
  }

  return `${tiers.size} model tier(s) named (${[...tiers].join(', ')}), independence wording matched to model-lineup.js, deletion consequence explained`;
});

// The SAVINGS block is the one place this repo could lie at scale, so every path by which it could
// print a number nobody measured is pinned here:
//   · the A/B delta, recomputed from the raw arm scores and never trusted from the record's own `gap`;
//   · the prediction tally, read from the ledger table only. The fixture's process-log.md carries the
//     trap a real one carries: prose that still reads "Result: 0 escapes. VERIFIED." for a prediction
//     the ledger records as FALSIFIED, kept unedited because the mis-measurement was the finding. A
//     parser that greps the body scores that falsification as a success — the dishonesty D17 forbids;
//   · the three ways of having no token Δ (never metered / metered per round but not per arm / one arm
//     only), which must stay apart: a round total is both arms collapsed, so splitting it fabricates a
//     Δ of 0, and an unmetered arm reads as 0 to anything that sums it — the Δ becomes the other arm;
//   · the `{total}` shape, which is what a harness that never splits in/out can actually produce: both
//     arms still ran, and refusing their Δ on a formatting technicality throws a measurement away;
//   · the tally's `unknown`, which must reach the rendered line. A row the parser cannot read that is
//     silently dropped reads as "0 falsified" — the ledger's falsification would vanish;
//   · outcomes in Spanish as well as English: the plugin is English, the process-log it reads is not
//     necessarily. An English-only parser turns a real Spanish ledger into a confident "0 falsified";
//   · an absent ledger and one whose rows this parser cannot read, which are two different facts. One
//     return value for both makes the block print a false why about a file that exists.
//
// Negative controls (2026-07-12, each applied, observed, reverted — all exit 1):
//   the outcome matched against the whole document instead of the row's outcome cell ...............
//     "predictions: 0 verified / 3 falsified / 0 pending / 0 unknown, expected 1/1/1/0" — the parser
//     stops reading the ledger and starts reading prose, which is the failure this check exists for
//   OUTCOME ordered verified-before-falsified, so a corrected row keeps its superseded word .........
//     "predictions: 2 verified / 0 falsified / 1 pending / 0 unknown, expected 1/1/1/0" — the ledger's
//     falsification read as a win, because the row that carries both words was scored on the wrong one
//   abRuns trusting the record's own `gap` field instead of recomputing from the arms ...............
//     "A/B deltaScore = undefined, expected 7 (mean 21 with-skill − mean 14 without)"
//   armTokens falling back to the round's collapsed tokens, `last.armTokens || (last.tokens && {...})`
//     — the plausible shortcut, not an impossible one ...............................................
//     "round-metered A/B must report deltaTokens n/a, got 0 — a round total is both arms collapsed"
//   OUTCOME reduced to its Spanish spellings (/falsad/, /verificad/, /pendiente/) ...................
//     "predictions: 0 verified / 0 falsified / 0 pending / 3 unknown, expected 1/1/1/0"
//   the `unknown` row dropped from renderSavings ...................................................
//     "the render hides 1 unreadable row(s) — a dropped row reads as '0 falsified'"
//   renderSavings printing a fixed "not recorded (v1 schema)" instead of the record's own reason ....
//     "the unmetered reason never reaches the rendered line" — the v2 record was told it was v1
//   armTotal reading in/out only, so a harness that reports one number per run measures nothing ......
//     "total-shape A/B deltaTokens = 0, expected 9000 — a harness that reports one number per run
//      still measured both arms" — 0, not n/a: the shape it cannot read sums to zero on both arms
//   armTokens accepted with one arm present, the missing arm summed as 0 ............................
//     "one-arm A/B must report deltaTokens n/a, got 30000 — a round total is both arms collapsed"
//   parsePredictions returning the same `null` for an absent file and for a ledger it parsed no row
//   from (`if (!rows.length) return null`) — the render then states "/iterate has never run here"
//   about a process-log.md that exists and carries a falsification .................................
//     "a present ledger this parser cannot read is reported as absent: 'PREDICT no process-log.md —
//      /iterate has never run here'"
check('loop-stats scores the savings fixture from the ledger, not the prose', () => {
  const script = path.join(ROOT, 'plugins/harness-guards/scripts/loop-stats.js');
  const stats = (repo, ...flags) => execFileSync('node', [script,
    '--root', path.join(ROOT, 'scripts/fixtures/telemetry'), '--project', 'demo', '--repo', repo, ...flags],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  const { savings } = JSON.parse(stats(path.join(ROOT, 'scripts/fixtures/repo'), '--json'));

  const p = savings.predictions;
  if (p.verified !== 1 || p.falsified !== 1 || p.pending !== 1 || p.unknown !== 0) {
    throw new Error(`predictions: ${p.verified} verified / ${p.falsified} falsified / ${p.pending} pending / ${p.unknown} unknown, expected 1/1/1/0`);
  }
  if (p.rows.find((r) => r.version === 'v2').outcome !== 'falsified') {
    throw new Error('the falsified prediction was scored from the superseded prose, not the ledger');
  }

  const [ab] = savings.ab;
  if (!ab) throw new Error('A/B run lost — no counterfactual row');
  if (ab.deltaScore !== 7) throw new Error(`A/B deltaScore = ${ab.deltaScore}, expected 7 (mean 21 with-skill − mean 14 without)`);
  if (ab.scoreMax !== 25) throw new Error(`A/B scoreMax = ${ab.scoreMax}, expected 25`);
  if (ab.deltaTokens !== 10500) throw new Error(`A/B deltaTokens = ${ab.deltaTokens}, expected 10500 (v2 per-arm tokens)`);

  const arms = { withSkill: [20], withoutSkill: [10] };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-savings-'));
  const runs = path.join(tmp, 'docs/harness-dev/loop-runs');
  fs.mkdirSync(runs, { recursive: true });
  // Neither record can yield a token counterfactual, and each must say a different true reason why:
  // one was never metered, the other was metered per round — a total that already contains both arms.
  fs.writeFileSync(path.join(runs, '2026-01-01-skill-loop-unmetered.json'),
    JSON.stringify({ run: 'unmetered', loop: 'skill-loop', rounds: [{ n: 1, arms }] }));
  fs.writeFileSync(path.join(runs, '2026-01-02-skill-loop-round-metered.json'), JSON.stringify({
    run: 'round-metered',
    loop: 'skill-loop',
    rounds: [{ n: 1, arms, startedAt: '2026-01-02T10:00:00Z', endedAt: '2026-01-02T10:12:00Z', tokens: { in: 41000, out: 6200 } }],
  }));
  // A harness that reports one number per run and no in/out split still produced the counterfactual:
  // both arms ran. Refusing its `{total}` shape would drop a measured Δ on a formatting technicality.
  fs.writeFileSync(path.join(runs, '2026-01-03-skill-loop-total-shape.json'), JSON.stringify({
    run: 'total-shape',
    loop: 'skill-loop',
    rounds: [{ n: 1, arms, armTokens: { withSkill: { total: 30000 }, withoutSkill: { total: 21000 } } }],
  }));
  // One arm metered is no counterfactual at all: the missing arm reads as 0 to any code that sums it,
  // and the Δ becomes the whole cost of the arm that was measured.
  fs.writeFileSync(path.join(runs, '2026-01-04-skill-loop-one-arm.json'), JSON.stringify({
    run: 'one-arm',
    loop: 'skill-loop',
    rounds: [{ n: 1, arms, armTokens: { withSkill: { in: 26000, out: 4000 } } }],
  }));
  // The private ledger this dashboard was built for is written in Spanish, and one of its rows is a
  // falsification. Plus a row whose outcome is neither language: it must surface as unreadable.
  fs.writeFileSync(path.join(runs, 'process-log.md'), [
    '| v | fecha | cambio | predicción | resuelve | resultado |',
    '|---|---|---|---|---|---|',
    '| v1 | 2026-01-02 | §1 | rondas bajan de 4 a 3 | la próxima corrida | **VERIFICADA** — 3 rondas |',
    '| v2 | 2026-01-09 | §0 | escapes ≤ 1 | el próximo commit | **FALSADA — ≥3 escapes** |',
    '| v3 | 2026-01-16 | §3 | se reporta, no se resuelve en silencio | la próxima fase | pendiente |',
    '| v4 | 2026-01-23 | §2 | menos rondas | la próxima corrida | se verá |',
    '',
  ].join('\n'));

  const out = JSON.parse(stats(tmp, '--json'));
  const byRun = Object.fromEntries(out.savings.ab.map((a) => [a.run, a]));
  const ansiTmp = stats(tmp);

  const total = byRun['total-shape'];
  if (!total || total.deltaTokens !== 9000) {
    throw new Error(`total-shape A/B deltaTokens = ${total && total.deltaTokens}, expected 9000 — a harness that reports one number per run still measured both arms`);
  }

  for (const [run, reason] of [
    ['unmetered', /no tokens recorded/i],
    ['round-metered', /not per arm/i],
    ['one-arm', /only one arm/i],
  ]) {
    const a = byRun[run];
    if (!a) throw new Error(`A/B run ${run} lost`);
    if (a.deltaTokens !== null) throw new Error(`${run} A/B must report deltaTokens n/a, got ${a.deltaTokens} — a round total is both arms collapsed`);
    if (!reason.test(a.tokensReason || '')) throw new Error(`${run} A/B states a false reason: "${a.tokensReason}"`);
    // The reason has to reach the screen, not just the JSON: a rendered reason that contradicts the
    // record ("v1 schema") is a false why on a block whose whole contract is to show a true one.
    if (!reason.test(ansiTmp)) throw new Error(`the ${run} reason never reaches the rendered line`);
  }

  const es = out.savings.predictions;
  if (es.verified !== 1 || es.falsified !== 1 || es.pending !== 1 || es.unknown !== 1) {
    throw new Error(`Spanish ledger: ${es.verified} verified / ${es.falsified} falsified / ${es.pending} pending / ${es.unknown} unknown, expected 1/1/1/1`);
  }
  if (!/1 unreadable/.test(ansiTmp)) {
    const line = (ansiTmp.split('\n').find((l) => l.includes('PREDICT')) || '').trim();
    throw new Error(`the render hides ${es.unknown} unreadable row(s) — a dropped row reads as "0 falsified": "${line}"`);
  }
  // A ledger whose columns this parser cannot read is not an absent ledger. The PRD never fixed the
  // table's shape, so the row it carries a falsification in may parse to nothing here — and "no
  // process-log.md, /iterate has never run" would then be a false why about a file that exists.
  const blind = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-blind-'));
  const blindRuns = path.join(blind, 'docs/harness-dev/loop-runs');
  fs.mkdirSync(blindRuns, { recursive: true });
  fs.writeFileSync(path.join(blindRuns, 'process-log.md'), [
    '| v | fecha | cambio | predicción | resultado |',
    '|---|---|---|---|---|',
    '| v1 | 2026-01-09 | §0 | escapes ≤ 1 | ❌ FALSADA — 10 findings |',
    '',
  ].join('\n'));
  const blindAnsi = stats(blind);
  const blindLine = (blindAnsi.split('\n').find((l) => l.includes('PREDICT')) || '').trim();
  if (!/ledger unreadable/.test(blindAnsi) || /never run/.test(blindLine)) {
    throw new Error(`a present ledger this parser cannot read is reported as absent: "${blindLine}"`);
  }
  fs.rmSync(blind, { recursive: true, force: true });
  fs.rmSync(tmp, { recursive: true, force: true });

  return `Δscore +${ab.deltaScore}/25 · Δtok +${ab.deltaTokens} · en+es ledgers · unreadable rows and unreadable ledger rendered`;
});

// A schema field no command writes is vapour: the dashboard reads it, a fixture in this very file
// proves it renders, and no run in the wild will ever carry it. That is process.md §0 one layer up —
// a capability nothing can feed is a wish, not a feature — and it is how the Δ tokens row shipped its
// first round: green against a fixture the same diff had written, while `grep -rn armTokens commands/`
// returned nothing. This check binds each consumer field to the command that has to produce it.
//
// Negative controls (2026-07-12, each applied, observed, reverted — both exit 1):
//   `armTokens` struck from commands/skill-loop.md .. "skill-loop must instruct armTokens: the Δ tokens
//                                                      row of loop-stats has no other producer"
//   `startedAt` struck from commands/iterate.md ..... "iterate writes a loop-runs JSON but never
//                                                      instructs the v2 round field(s): startedAt"
check('every loop command produces the v2 schema the dashboard reads', () => {
  const V2 = ['startedAt', 'endedAt', 'tokens'];
  for (const cmd of ['orchestrate', 'iterate', 'review-loop', 'skill-loop']) {
    const src = read(commandPath(cmd));
    const missing = V2.filter((f) => !src.includes(`"${f}"`));
    if (missing.length) {
      throw new Error(`${cmd} writes a loop-runs JSON but never instructs the v2 round field(s): ${missing.join(', ')}`);
    }
  }
  const ab = read(commandPath('skill-loop'));
  if (!ab.includes('"armTokens"') || !/withSkill[\s\S]{0,120}withoutSkill/.test(ab)) {
    throw new Error('skill-loop must instruct armTokens: the Δ tokens row of loop-stats has no other producer');
  }
  return '4 commands instruct startedAt/endedAt/tokens · skill-loop instructs armTokens';
});

// Pi's prompt-template loader parses frontmatter as STRICT YAML, and a file that fails to parse is
// DISCARDED IN SILENCE — no error, no warning, the template just never appears. So a Pi frontmatter
// value is only real if a strict YAML parser would accept it. This repo has no YAML dependency and is
// not adding one, so this reimplements the one rule that actually bit: a plain (unquoted) scalar
// containing `: ` is a mapping indicator, not text, and YAML rejects the line ("mapping values are not
// allowed in this context"). Three of this repo's five descriptions contain one (`Cost: medium`,
// `converge: the`, `keep. Cost: medium-h`) — and for one commit, `/orchestrate`, `/iterate` and
// `/skill-loop` were written to disk and silently thrown away by Pi's loader. Measured with
// `pi --mode rpc` + `get_commands`: 2 of 5 templates registered. The check that was supposed to prevent
// exactly this counted FILES WRITTEN, which is the neighbouring failure mode and not the one that
// happened. That is §0 with the paint still wet: a check aimed one inch off the target is decoration.
function assertPiFrontmatterLoads(rel, pairs) {
  for (const [k, v] of pairs) {
    const value = String(v);
    const quoted = (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"));
    if (!quoted && /:\s/.test(value)) {
      throw new Error(`${rel}: Pi cannot load this template — frontmatter '${k}' is an unquoted YAML scalar containing ': ', which strict YAML reads as a mapping. Pi's loader will discard the file in silence and the command will not exist.`);
    }
    if (!quoted && /^[>|&*!%@`]/.test(value)) {
      throw new Error(`${rel}: Pi cannot load this template — frontmatter '${k}' is an unquoted YAML scalar opening with the reserved indicator '${value[0]}'.`);
    }
  }
}

// F9's port is a schema TRANSFORM, not a copy — the risk is not "the file is missing" (the four
// checks above already catch that) but "the file exists and is wrong": a command that silently
// drops `description`, an agent whose `permission`/`tools` block is malformed YAML, or a Pi agent
// missing the `name` field pi-subagents requires to discover it at all. Every real commands/*.md and
// agents/*.md in this repo is round-tripped through both transforms so a schema drift in either
// source corpus fails here before it fails a user's install.
//
// Negative control for the F12 strict-YAML hardening (2026-07-13, applied, observed, reverted — exit 1):
//   port-loops.js's `yamlQuote` reduced to the identity function, so descriptions emit unquoted .....
//     "commands/iterate.md: Pi cannot load this template — frontmatter 'description' is an unquoted
//      YAML scalar containing ': '…" — the exact defect real Pi exhibited, now caught before install
//
// Negative controls (2026-07-12, each applied by hand, observed, reverted — all exit 1):
//   transformAgentPi's `if (!name) throw` guard deleted, then run against this check's own
//   no-name fixture ................................................................................
//     "transformAgentPi accepted a fixture with no name field" — the function stopped refusing a
//     source that would have shipped a nameless, undiscoverable pi-subagents agent
//   parseFrontmatter's `if (idx === -1) throw` guard deleted, then run against this check's own
//   multi-line-value fixture .......................................................................
//     "parseFrontmatter accepted a multi-line value instead of refusing it" — instead of throwing,
//     the second line silently became its own bogus frontmatter key (`  Writ: "  Write"`)
//   TOOL_MAP.Bash.permission renamed 'bash' -> 'shell' (no such OpenCode/Kilo permission key) ......
//     "agents/correctness-critic.md: opencode/kilo port emits unknown permission key 'shell'" — a
//     permission key neither harness's documented vocabulary recognizes grants nothing at runtime
check('port-loops.js transforms every real command/agent into valid target frontmatter', () => {
  const script = path.join(ROOT, 'scripts/port-loops.js');
  execFileSync('node', ['--check', script], { stdio: 'pipe' });
  const port = require(script);

  const OC_PERMISSION_KEYS = new Set(['read', 'edit', 'glob', 'grep', 'list', 'bash', 'task',
    'external_directory', 'todowrite', 'webfetch', 'websearch', 'lsp', 'skill', 'question', 'doom_loop']);

  for (const rel of commandsMd()) {
    const { fm, body } = port.parseFrontmatter(read(rel));
    const { fm: out } = port.transformCommandOpenCodeKilo(fm);
    const description = out.find(([k]) => k === 'description');
    if (!description || !description[1]) throw new Error(`${rel}: ported command lost its description`);
    for (const dropped of ['argument-hint', 'allowed-tools', 'disable-model-invocation']) {
      if (out.some(([k]) => k === dropped)) throw new Error(`${rel}: ported command still carries Claude-only field '${dropped}'`);
    }

    // F12: Pi gets commands too now (prompt templates, .pi/prompts/) — except the ones it cannot run.
    if (port.PI_UNPORTABLE_COMMANDS.has(path.basename(rel, '.md'))) continue;
    const { fm: piOut, body: piBody } = port.transformCommandPi(fm, body);
    const piDescription = piOut.find(([k]) => k === 'description');
    if (!piDescription || !piDescription[1]) throw new Error(`${rel}: pi-ported command lost its description`);
    for (const dropped of port.PI_COMMAND_DROPPED_FIELDS) {
      if (piOut.some(([k]) => k === dropped)) throw new Error(`${rel}: pi-ported command still carries Claude-only field '${dropped}'`);
    }
    // The blocker this check missed the first time: every value has to SURVIVE Pi's strict-YAML
    // frontmatter loader. See assertPiFrontmatterLoads — a file Pi cannot parse is discarded in
    // silence, so "the file was written" proves nothing at all.
    assertPiFrontmatterLoads(rel, piOut);
    const leftoverTaskRef = /\bTask tool\b|\bTask calls\b|subagent_type|\.claude\/agents|each Task returned|`Task`\s|AskUserQuestion|CLAUDE_PLUGIN_ROOT/.exec(piBody);
    if (leftoverTaskRef) throw new Error(`${rel}: pi-ported command body still reads "${leftoverTaskRef[0]}" — a Claude Code-only reference that does not resolve on Pi`);
    // Pi's own prompt-template engine substitutes $ARGUMENTS/$@ natively (docs/prompt-templates.md)
    // — every source command that uses it must keep using it, not have it rewritten into prose.
    if (body.includes('$ARGUMENTS') && !piBody.includes('$ARGUMENTS')) {
      throw new Error(`${rel}: pi-ported command body dropped $ARGUMENTS — it is a real, working substitution on Pi, not dead text`);
    }
  }

  for (const rel of agentsMd()) {
    const { fm } = port.parseFrontmatter(read(rel));

    const { fm: ocOut } = port.transformAgentOpenCodeKilo(fm);
    if (!ocOut.some(([k, v]) => k === 'mode' && v === 'subagent')) throw new Error(`${rel}: opencode/kilo port missing mode: subagent`);
    const perm = (ocOut.find(([k]) => k === 'permission') || [])[1];
    if (perm) {
      for (const k of Object.keys(perm)) {
        if (!OC_PERMISSION_KEYS.has(k)) throw new Error(`${rel}: opencode/kilo port emits unknown permission key '${k}'`);
      }
    }

    const { fm: piOut } = port.transformAgentPi(fm);
    const piName = piOut.find(([k]) => k === 'name');
    if (!piName || !piName[1]) throw new Error(`${rel}: pi port missing required name field`);
    if (!piOut.some(([k, v]) => k === 'defaultContext' && v === 'fresh')) throw new Error(`${rel}: pi port missing defaultContext: fresh`);
  }

  // A malformed source (a multi-line frontmatter value this line-based parser cannot read) must be
  // refused, not silently mis-split into a bogus extra key.
  let threw = false;
  try {
    port.parseFrontmatter('---\ntools: Read\n  Write\ndescription: x\n---\nbody');
  } catch (e) { threw = /flat key: value/.test(e.message); }
  if (!threw) throw new Error('parseFrontmatter accepted a multi-line value instead of refusing it');

  // A Pi agent fixture missing `name` (the field pi-subagents needs to discover it at all) must
  // refuse to transform rather than write a nameless, undiscoverable agent file.
  let piThrew = false;
  try {
    port.transformAgentPi(port.parseFrontmatter('---\ndescription: no name here\ntools: read\n---\nbody').fm);
  } catch (e) { piThrew = /missing name/.test(e.message); }
  if (!piThrew) throw new Error('transformAgentPi accepted a fixture with no name field');

  return `${commandsMd().length} command(s) + ${agentsMd().length} agent(s) round-tripped through opencode/kilo + pi`;
});

// Every capability the port DESTROYS has to be named in the README, because the README is the only
// place a user finds out. This is the check the F9 review should not have had to be: the first draft
// dropped `disable-model-invocation` (the veto that keeps two token-hungry loops and one that analyses
// the human from auto-firing), left a code comment claiming the loss was "documented as a README
// caveat", and shipped no such caveat — while the README went on asserting the veto still held. The
// code was right and the documentation lied, in a repo whose whole product is not lying. So: each
// destroyed guardrail is bound to the prose that has to disclose it, and the binding is executable.
//
// Negative controls (2026-07-12, each applied, observed, reverted — all exit 1):
//   the `disable-model-invocation` paragraph struck from README §Compatibility ....................
//     "README never discloses that the port drops 'disable-model-invocation' — the manual-only veto
//      on /review-loop, /iterate and /session-review does not exist on OpenCode/Kilo"
//     NOTE: this control FAILED TO BITE on the first version of this check (exit 0) — the matrix row
//     alone matched its regex, so a README that had deleted the entire explanatory paragraph still
//     passed. The check was tightened to demand the CONSEQUENCE in prose, not the fact in a cell,
//     and only then did the control fire. Recorded because it is the whole argument for §0: this
//     check was decoration for the length of one commit, and nothing but the control said so.
//   the correctness-critic/WebSearch caveat struck from the README ................................
//     "README never discloses that correctness-critic loses WebSearch on Pi"
//
// F12 RECOLOCATION (2026-07-13, not a deletion): the assertion that used to sit here — "README never
// states plainly that the loop COMMANDS do not port to Pi" — checked a claim that turned out to be
// FALSE. F9 concluded Pi could not run the loop commands at all; it can, via pi-subagents, exactly like
// the agents already required it (see README §Compatibility, "Loops on Pi, in full"). Deleting that
// check outright would leave this file with no memory that the claim was ever tested; instead it is
// replaced below with its mirror image — a check that the README now asserts the TRUE thing (loops run
// on Pi) and keeps asserting the two caveats that are still true (WebSearch, the model alias). A second,
// new check (further down) binds that capability to `install.sh` actually delivering it.
// Negative controls for the recolocated assertions (2026-07-13, each applied, observed, reverted — all
// exit 1):
//   `destDirsFor('pi').commands` reverted to `null` in port-loops.js .............................
//     "port-loops.js no longer ports commands to Pi — the README says it does; one of the two is lying"
//   the "preserved on Pi — by construction" sentence struck from README §Compatibility .............
//     "README no longer states that the manual-only veto survives on Pi by construction"
//   the Pi model-alias caveat paragraph struck from README §Compatibility ..........................
//     "README never discloses that the model: alias is unresolved on Pi too"
check('README discloses every guardrail the port destroys', () => {
  const port = require(path.join(ROOT, 'scripts/port-loops.js'));
  const t = read(COMPAT_DOC);

  // Not "is the string present anywhere" — the disclosure has to sit in the section a reader lands on
  // from the install instructions, or it is a caveat hidden from the person who needs it.
  if (!/## Compatibility across harnesses/.test(t)) throw new Error('README lost the compatibility matrix section');
  const compat = t.split('## Compatibility across harnesses')[1].split(/\n## /)[0];

  // What the transform actually destroys, asked of the transform itself rather than assumed here: a
  // future field silently added to the drop list fails this check until the README names it too.
  const cmdDrops = new Set();
  for (const rel of commandsMd()) {
    port.transformCommandOpenCodeKilo(port.parseFrontmatter(read(rel)).fm).dropped.forEach((d) => cmdDrops.add(d));
  }
  if (!cmdDrops.has('disable-model-invocation')) {
    throw new Error('the command transform no longer reports dropping disable-model-invocation — either it is carried now (update this check) or the report was lost (a silent drop)');
  }
  // Not satisfied by the matrix row: a table cell reading "❌ no equivalent" is a fact a reader can
  // skim past without learning the consequence. The disclosure has to name what the loss DOES —
  // the three loops become auto-dispatchable — in prose, or it has not been made. (The first version
  // of this check accepted the matrix row alone and its negative control passed 0/3; that is how a
  // check becomes decoration.)
  const CONSEQUENCE = /auto-dispatch(?:able|ed)?[\s\S]{0,400}(review-loop|iterate|session-review)|(review-loop|iterate|session-review)[\s\S]{0,400}auto-dispatch(?:able|ed)?/i;
  if (!/disable-model-invocation/.test(compat) || !CONSEQUENCE.test(compat)) {
    throw new Error("README never discloses that the port drops 'disable-model-invocation' — the manual-only veto on /review-loop, /iterate and /session-review does not exist on OpenCode/Kilo");
  }

  // Pi gets the loops too now (F12) — asked of the transform itself, not assumed: if a future change
  // silently un-ports commands from Pi, this fails until the README is corrected back down with it.
  if (port.destDirsFor('pi').commands === null) {
    throw new Error('port-loops.js no longer ports commands to Pi — the README says it does; one of the two is lying');
  }
  if (!/preserved on Pi[\s\S]{0,40}— by construction/i.test(compat)) {
    throw new Error('README no longer states that the manual-only veto survives on Pi by construction');
  }
  // Command frontmatter never carries `model:` (verified against the transform itself, not assumed) —
  // the caveat is about the 7 ported AGENTS, and it has to say so for Pi specifically, not just for
  // OpenCode/Kilo Code.
  for (const rel of commandsMd()) {
    if (port.transformCommandPi(port.parseFrontmatter(read(rel)).fm, port.parseFrontmatter(read(rel)).body).fm.some(([k]) => k === 'model')) {
      throw new Error(`${rel}: pi-ported command now carries a model: field — the README's "no commands carry model:" claim is stale`);
    }
  }
  if (!/model:`? line is still a Claude Code alias on Pi/i.test(compat)) {
    throw new Error('README never discloses that the model: alias is unresolved on Pi too, not just on OpenCode/Kilo Code');
  }
  // A loop the port WITHHOLDS is a disclosure too — and the one most easily mistaken for a bug.
  for (const name of port.PI_UNPORTABLE_COMMANDS) {
    // One sentence may cover both withheld commands ("/session-review and /dashboard do not port to
    // Pi"), which is how a reader wants to read it. The name still has to appear immediately before
    // the claim, so a user searching for their command lands on the disclosure either way.
    if (!new RegExp(`\`?/${name}\`?[^.\n]{0,40}\\bdoe?s? not port to Pi`, 'i').test(compat)) {
      throw new Error(`README never states that /${name} does not port to Pi — a user who types it and gets nothing has no way to know that is by design`);
    }
  }

  // The fact seat losing its only route to facts is a caveat, not a footnote.
  const piDrops = port.transformAgentPi(port.parseFrontmatter(read(`${LOOPS}/agents/correctness-critic.md`)).fm).dropped;
  if (piDrops.includes('WebSearch') && !/correctness-critic[\s\S]{0,300}WebSearch/i.test(compat)) {
    throw new Error('README never discloses that correctness-critic loses WebSearch on Pi');
  }

  return 'disable-model-invocation dropped on OpenCode/Kilo · Pi loops preserved by construction + model alias · correctness-critic loses WebSearch on Pi';
});

// F12: the check above binds the README's PROSE to the transform's behavior; this one binds it to
// `install.sh` — the thing a user actually runs — and, crucially, to what PI ITSELF WILL ACCEPT.
//
// The first version of this check counted files in `.pi/prompts/` and called that success. Real Pi
// (`pi --mode rpc`, `get_commands`) then registered 2 of the 5 it had "installed": the other three had
// an unquoted `: ` in their description and Pi's strict-YAML loader binned them without a word. Writing
// a file the loader discards is not installing a loop. So every template this installer writes is now
// re-parsed here through the same strict-YAML rule Pi applies (assertPiFrontmatterLoads) — the check
// fails for the reason a user would actually experience ("Pi cannot load this template"), not for the
// adjacent one that was easy to assert ("the file is not there").
//
// Negative controls (2026-07-13, each applied by hand, observed, reverted — all exit 1):
//   port-loops.js's `yamlQuote` reduced to the identity (descriptions emit unquoted, exactly as they
//   did when real Pi silently dropped 3 of 5) ......................................................
//     ".pi/prompts/iterate.md: Pi cannot load this template — frontmatter 'description' is an unquoted
//      YAML scalar containing ': '…"
//   `PI_UNPORTABLE_COMMANDS` emptied, so session-review ports to Pi again .........................
//     "install.sh --target pi wrote 5 prompt template(s), expected 4 — session-review shells out to
//      ${CLAUDE_PLUGIN_ROOT}/scripts/loop-stats.js and cannot run on Pi"
check("install.sh --target pi installs templates Pi can actually load", () => {
  execFileSync('sh', ['-n', path.join(ROOT, 'install.sh')], { stdio: 'pipe' });
  const port = require(path.join(ROOT, 'scripts/port-loops.js'));

  const clean = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-pi-clean-'));
  execFileSync('sh', ['-c', `sh "${path.join(ROOT, 'install.sh')}" --target pi --skip-graphify --skip-subagent-check 2>&1`], { cwd: clean });

  const promptDir = path.join(clean, '.pi/prompts');
  const promptFiles = fs.existsSync(promptDir) ? fs.readdirSync(promptDir).filter((f) => f.endsWith('.md')).sort() : [];
  const expected = commandsMd().map((f) => path.basename(f))
    .filter((f) => !port.PI_UNPORTABLE_COMMANDS.has(path.basename(f, '.md'))).sort();
  if (promptFiles.length !== expected.length) {
    throw new Error(`install.sh --target pi wrote ${promptFiles.length} prompt template(s), expected ${expected.length} — session-review shells out to \${CLAUDE_PLUGIN_ROOT}/scripts/loop-stats.js and cannot run on Pi`);
  }
  for (const name of port.PI_UNPORTABLE_COMMANDS) {
    if (promptFiles.includes(`${name}.md`)) throw new Error(`install.sh --target pi wrote ${name}.md, a command that cannot run on Pi — it would look like a working loop and die on its first command`);
  }

  // The blocker: does PI accept these files, or does its loader bin them? Same strict-YAML rule,
  // applied to what actually landed on disk — not to what the transform said it would write.
  for (const f of promptFiles) {
    const src = fs.readFileSync(path.join(promptDir, f), 'utf8');
    const { fm, body } = port.parseFrontmatter(src);
    assertPiFrontmatterLoads(`.pi/prompts/${f}`, fm);
    if (!fm.some(([k]) => k === 'description')) throw new Error(`.pi/prompts/${f}: no description — Pi falls back to the first body line in autocomplete`);
    // Asserted against the FILE, not against PI_UNPORTABLE_COMMANDS: deriving "what may be installed"
    // from the same constant that decides what gets installed is a tautology that can never fail. The
    // real, independent property is that nothing Pi is asked to run may reach for a Claude Code
    // plugin-runtime variable — a path that resolves to nothing and dies on the first command.
    if (body.includes('CLAUDE_PLUGIN_ROOT')) {
      throw new Error(`.pi/prompts/${f}: installed to Pi but its body reads \${CLAUDE_PLUGIN_ROOT} — a Claude Code plugin-runtime variable that is empty on Pi, pointing at a script this target never installs. It would look like a working loop and die on its first command.`);
    }
  }

  const agentFiles = fs.existsSync(path.join(clean, '.pi/agents'))
    ? fs.readdirSync(path.join(clean, '.pi/agents')).filter((f) => f.endsWith('.md')) : [];
  if (agentFiles.length !== 7) throw new Error(`install.sh --target pi wrote ${agentFiles.length} agent(s) in .pi/agents, expected 7`);

  return `${promptFiles.length} prompt(s) Pi's strict-YAML loader accepts + ${agentFiles.length} agents · session-review correctly withheld`;
});

// loop-gate.js is the one step in a loop that no agent wrote, so it is the one step whose failure
// nothing else would report: a chair reading a seat's JSON as prose cannot see that `line: 900` is past
// the end of a 40-line file, and it will aggregate that finding and hand it to a human as evidence.
// The fixtures pin each defect class the gate exists to refuse, and the scorecard pins the arithmetic —
// the number the gate opens on, now computed instead of produced by whichever model holds the chair.
//
// Negative controls (2026-08-09, each applied, observed, reverted — all exit 1). The observed message
// is quoted, not the one predicted when the control was written; two of the three came back different:
//   anchorError's fs.existsSync branch removed (a path is trusted if it is a non-empty string) ......
//     "malformed findings exited 1, expected 2 (repair-and-retry)" — NOT the predicted "did not catch
//     the anchor". Without the guard, statSync threw ENOENT uncaught and the gate DIED on a bad
//     finding instead of reporting it: a seat's malformed reply would have taken the whole round with
//     it, a worse failure than the one the control was aimed at, and visible only by running it. The
//     fs calls in anchorError were wrapped in try/catch because of this control, and re-running it
//     against the hardened gate then produced the message originally aimed for: "the gate did not
//     catch an anchor at a file not in the repo". Both runs are recorded: the first found the bug.
//   scoreOf counting `applies: false` criteria into the denominator .................................
//     "gate arithmetic drifted: SCORECARD OK: 5 criteria (11 weight counted) | SCORE: 36/100 ·
//     BLOCKERS: 2" — predicted 40/100; the real drift is larger and it moves the BLOCKER count too,
//     because a criterion with nothing to bind to starts failing a gate it was never part of.
//   the `applies: false with no evidence` rule struck from checkScorecard .........................
//     "the gate lets an unjustified applies:false through — the one exit a criterion has" (as predicted)
check('loop-gate refuses malformed seat output and computes the gate arithmetic', () => {
  const script = path.join(ROOT, 'plugins/harness-loops/scripts/loop-gate.js');
  mustExist('plugins/harness-loops/scripts/loop-gate.js');
  execFileSync('node', ['--check', script], { stdio: 'pipe' });

  const run = (args) => {
    try {
      return { status: 0, out: execFileSync('node', [script, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), err: '' };
    } catch (e) {
      return { status: e.status, out: e.stdout || '', err: e.stderr || '' };
    }
  };
  const gate = (fixture) => run(['check-findings', path.join(ROOT, 'scripts/fixtures/findings', fixture), '--root', ROOT, '--seat', 'style']);

  const ok = gate('valid-findings.json');
  if (ok.status !== 0) throw new Error(`the gate rejected valid findings: ${ok.err.split('\n')[0]}`);

  const bad = gate('invalid-findings.json');
  if (bad.status !== 2) throw new Error(`malformed findings exited ${bad.status}, expected 2 (repair-and-retry)`);
  for (const [needle, why] of [
    ['reserved key "id"', 'a seat that named its own finding'],
    ['does not exist: scripts/does-not-exist.js', 'an anchor at a file not in the repo'],
    ['past the end of README.md', 'an anchor past the end of a real file'],
    ['severity "critical"', 'a severity outside the fixed ladder'],
    ['unknown key "confidence"', 'a key the contract does not have'],
    ['missing "fix"', 'a finding that names no action'],
  ]) {
    if (!bad.err.includes(needle)) throw new Error(`the gate did not catch ${why} (no "${needle}" in its report)`);
  }

  const card = gate('valid-scorecard.json');
  if (card.status !== 0) throw new Error(`the gate rejected a valid scorecard: ${card.err.split('\n')[0]}`);
  // 5 criteria, one applies:false. Counted weight = 3+3+1+1 = 8; passed = 3+1 = 4 -> 50, one failed blocker.
  if (!/SCORE: 50\/100 · BLOCKERS: 1/.test(card.out)) throw new Error(`gate arithmetic drifted: ${card.out.trim().replace(/\n/g, ' | ')}`);

  const badCard = gate('invalid-scorecard.json');
  if (badCard.status !== 2) throw new Error(`malformed scorecard exited ${badCard.status}, expected 2`);
  if (!/applies: false with no evidence/.test(badCard.err)) {
    throw new Error('the gate lets an unjustified applies:false through — the one exit a criterion has');
  }
  if (!/FAILED but "findings" is empty/.test(badCard.err)) {
    throw new Error('the gate lets a failed criterion through with no finding — a score with no fix behind it');
  }

  // resume: a half-written run is either resumable or it is a question for a human. It is never
  // something to reconcile, which is the one behaviour that would silently restart a paid-for round.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-resume-'));
  const mk = (name, files) => {
    const d = path.join(tmp, name);
    fs.mkdirSync(d, { recursive: true });
    for (const [f, body] of Object.entries(files)) fs.writeFileSync(path.join(d, f), body);
    return d;
  };
  const states = [
    ['NO_RUN', mk('empty', {}), 0, /NO_RUN/],
    ['resumable', mk('two', { 'round-1.json': '{"n":1}', 'round-2.json': '{"n":2}' }), 0, /COMPLETED_ROUNDS: 2\nRESUME_FROM: 3/],
    ['complete', mk('done', { 'round-1.json': '{"n":1}', '2026-01-01-orchestrate-x.json': '{"verdict":"APROBADO"}' }), 0, /RUN_COMPLETE/],
    ['gap', mk('gap', { 'round-1.json': '{"n":1}', 'round-3.json': '{"n":3}' }), 2, /AMBIGUOUS_RUN_STATE/],
    ['unreadable', mk('broken', { 'round-1.json': '{"n":1}', 'round-2.json': '{"n":2' }), 2, /AMBIGUOUS_RUN_STATE/],
  ];
  for (const [name, dir, wantStatus, wantText] of states) {
    const r = run(['resume', dir]);
    if (r.status !== wantStatus) throw new Error(`resume/${name} exited ${r.status}, expected ${wantStatus}`);
    if (!wantText.test(r.out + r.err)) throw new Error(`resume/${name} reported "${(r.out + r.err).trim().split('\n')[0]}"`);
  }
  fs.rmSync(tmp, { recursive: true, force: true });

  return `6 defect classes refused · SCORE/BLOCKERS computed · ${states.length} resume states`;
});

// A gate nothing calls is the same vapour as a schema field nothing writes (see the v2-schema check
// above): loop-gate.js could pass every fixture in this file while no loop in the repo ever ran it.
// This binds each half of the gate to the commands that have to produce the call.
//
// Negative controls (2026-08-09, each applied, observed, reverted — both exit 1):
//   the check-findings block struck from commands/orchestrate.md ...................................
//     "orchestrate dispatches seats but never gates their JSON — loop-gate.js check-findings has no
//      producer"
//   Bash(node:*) struck from commands/review-loop.md's allowed-tools ...............................
//     "review-loop calls node but its allowed-tools does not permit it — the gate would be denied at
//      the first round"
//   the `:-` default stripped back to a bare ${CLAUDE_PLUGIN_ROOT} in commands/orchestrate.md ......
//     three checks fired at once, which is the correct shape for this one: the two Pi-port checks
//     ("pi-ported command body still reads CLAUDE_PLUGIN_ROOT", ".pi/prompts/orchestrate.md: installed
//     to Pi but its body reads ${CLAUDE_PLUGIN_ROOT}") plus this one, "orchestrate calls loop-gate.js
//     through a bare ${CLAUDE_PLUGIN_ROOT} — a copied-commands install is silently ungated again".
//     Verified end to end as well: `install.sh --target claude --lineup` in a clean repo, then the
//     command's own line with the variable unset — `NO_RUN`, exit 0, gate resolved from .claude/scripts.
//   the "report the run as ungated" sentence struck from commands/orchestrate.md ...................
//     "orchestrate never says what to do when loop-gate.js is absent — a copied-commands install
//      crashes on the missing script and the chair is left with no instruction, so an ungated run
//      reports as a gated one". Added after shipping the gate one version with this hole open: the
//      gate reached two loops that install.sh copies WITHOUT scripts/, and nothing said so.
check('the panel and build loops actually run their seats through loop-gate', () => {
  for (const cmd of ['orchestrate', 'review-loop', 'iterate']) {
    const src = read(commandPath(cmd));
    if (!/loop-gate\.js" check-findings/.test(src)) {
      throw new Error(`${cmd} dispatches seats but never gates their JSON — loop-gate.js check-findings has no producer`);
    }
    if (!/loop-gate\.js" resume/.test(src)) {
      throw new Error(`${cmd} never checks for a run already in progress — a chair that dies mid-run re-pays for every round`);
    }
    if (!/round-<n>\.json/.test(src)) {
      throw new Error(`${cmd} never writes a per-round file — resume has nothing to count and always reports NO_RUN`);
    }
    if (!/AMBIGUOUS_RUN_STATE/.test(src)) {
      throw new Error(`${cmd} never says what to do when the run state is ambiguous — the one case that must reach a human`);
    }
    if (!/Bash\(node:\*\)/.test(src)) {
      throw new Error(`${cmd} calls node but its allowed-tools does not permit it — the gate would be denied at the first round`);
    }
    // `${CLAUDE_PLUGIN_ROOT}` only resolves inside the Claude Code plugin runtime, and install.sh
    // copies commands/ and agents/ into a project WITHOUT ever copying scripts/. So a copied-commands
    // install runs `node "/scripts/loop-gate.js"` and gets a module-not-found stack trace — which is
    // neither of the two exit codes the command tells the chair how to read. Every gate call has to
    // carry its own fallback, and the run has to be REPORTED as ungated: silence there turns a missing
    // gate into a passing one, which is the failure mode this whole file exists to refuse.
    if (!/If that command is not available/.test(src) || !/ungated/.test(src)) {
      throw new Error(`${cmd} never says what to do when loop-gate.js is absent — a copied-commands install crashes on the missing script and the chair is left with no instruction, so an ungated run reports as a gated one`);
    }
    // A BARE ${CLAUDE_PLUGIN_ROOT} forced a choice nobody should have to make: install the plugin and
    // get the gate but not your own model line-up, or copy the commands locally and get the line-up
    // but not the gate. The `:-` default removes it — the copied install resolves `.claude/scripts`,
    // which install.sh now populates. Reintroducing a bare reference silently restores the trade-off.
    if (/\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/loop-gate/.test(src)) {
      throw new Error(`${cmd} calls loop-gate.js through a bare \${CLAUDE_PLUGIN_ROOT} — that resolves to nothing outside the plugin runtime, so a copied-commands install is silently ungated again`);
    }    // The build loop's builder seat reports a handoff; a handoff nobody shape-checks is a status the
    // chair takes on trust from the seat it is also driving.
    if (cmd === 'iterate' && !/loop-gate\.js" check-handoff/.test(src)) {
      throw new Error('iterate dispatches a builder but never gates its handoff — loop-gate.js check-handoff has no producer');
    }
  }
  const inst = read('install.sh');
  if (!/SCRIPT_DEST/.test(inst) || !/scripts\/\*\.js/.test(inst)) {
    throw new Error('install.sh copies commands/ without copying scripts/ beside them — the commands\' .claude/scripts fallback would point at an empty directory');
  }
  return '3 loops gate their seats, resume their runs, degrade honestly, and resolve the gate with or without the plugin';
});

// A handoff is the one seat output that is ABOUT the seat's own work — "I am done, here is why" — and
// the one a chair most wants to believe. The gate cannot check the claim; it can refuse the shapes
// that let a claim hide: a status outside the set, evidence that is empty, a block nobody named.
//
// Negative controls (2026-08-25, each applied, observed, reverted — all exit 1):
//   HANDOFF_STATUSES widened to accept 'done' ......................................................
//     "a foreign status with a stray blocker was not reported as both defects" — the stray-blocker
//     rule still fired (exit 2), so the first version of this check PASSED the control: it matched
//     `status "done"` inside the blocker message and never asked for the set violation itself. Now it
//     demands both messages.
//   the blocked-without-blocker rule struck ..........................................................
//     "invalid-handoff.json passed with a blocked status and no blocker"
//   the "handoff" example struck from commands/iterate.md §6 ........................................
//     "iterate never records the builder's handoff in its run JSON — the gate checks a field no loop
//      writes"
check('loop-gate check-handoff refuses a malformed handoff and accepts a complete one', () => {
  const script = path.join(ROOT, 'plugins/harness-loops/scripts/loop-gate.js');
  const gate = require(script);
  const run = (fixture, seat) => {
    try {
      const out = execFileSync('node', [script, 'check-handoff', path.join(ROOT, 'scripts/fixtures/findings', fixture), '--seat', seat], { stdio: ['pipe', 'pipe', 'pipe'] });
      return { code: 0, out: out.toString(), err: '' };
    } catch (e) {
      return { code: e.status, out: (e.stdout || '').toString(), err: (e.stderr || '').toString() };
    }
  };
  const ok = run('valid-handoff.json', 'builder');
  if (ok.code !== 0 || !/HANDOFF OK: complete/.test(ok.out)) throw new Error(`valid-handoff.json refused: exit ${ok.code} ${ok.err.split('\n')[0]}`);
  const agg = run('valid-run-with-handoff.json', 'chair');
  if (agg.code !== 0) throw new Error(`a run aggregate carrying a valid handoff was refused: ${agg.err.split('\n')[0]}`);

  const bad = run('invalid-handoff.json', 'builder');
  if (bad.code !== 2) throw new Error(`invalid-handoff.json exited ${bad.code}, expected 2`);
  for (const must of ['blocked with no blocker', '"evidence" is empty', 'empty "summary"', 'unknown key "confidence"']) {
    if (!bad.err.includes(must)) throw new Error(`invalid-handoff.json passed a rule it breaks — missing error: ${must}`);
  }
  const status = run('invalid-handoff-status.json', 'builder');
  if (status.code !== 2) throw new Error('invalid-handoff-status.json passed the gate — status "done" is outside the fixed set');
  if (!/the set is fixed/.test(status.err) || !/is not blocked/.test(status.err)) throw new Error('a foreign status with a stray blocker was not reported as both defects');

  if (gate.checkHandoff({ status: 'continue', summary: 'x', evidence: ['y'] }).length) throw new Error('checkHandoff refused a minimal valid continue');
  if (!gate.checkHandoff({ status: 'continue', summary: 'x', evidence: 'y' }).length) throw new Error('checkHandoff accepted evidence as a bare string');

  // The field has to have a producer, or the gate checks a shape no loop ever writes.
  if (!/"handoff"/.test(read(commandPath('iterate')))) {
    throw new Error('iterate never records the builder\'s handoff in its run JSON — the gate checks a field no loop writes');
  }
  return 'valid + aggregate accepted; 4 defect classes refused with self-repairable errors';
});

// The budget gate has three answers, not two, for the same reason validate.js itself does: a manifest
// that budgets nothing must not read as "every doc is within budget", and a budgeted file that has
// been renamed away must not read as "no longer over". Both are silent passes a rubric row would
// happily record as PASS.
//
// Negative controls (2026-08-25, each applied, observed, reverted — all exit 1):
//   `words > budget` flipped to `>=` .................................................................
//     "within.json: exit 1, expected 0" — within.json budgets docs/short.md at exactly its word count,
//     so the ceiling itself is the fixture: at-the-ceiling must be within, not over
//   the missing-file branch removed (a missing file counted as 0 words) ..............................
//     "missing.json: exit 0, expected 1 — a renamed file silently orphaned its budget"
//   the empty-manifest refusal removed ...............................................................
//     "empty.json: exit 0, expected 2 — a manifest that budgets nothing passed"
check('check-doc-budgets exits 1 over budget, 0 within, 2 with no manifest', () => {
  const script = path.join(ROOT, 'plugins/harness-audit/scripts/check-doc-budgets.js');
  mustExist('plugins/harness-audit/scripts/check-doc-budgets.js');
  execFileSync('node', ['--check', script], { stdio: 'pipe' });
  const root = path.join(ROOT, 'scripts/fixtures/doc-budgets');
  const run = (manifest) => {
    try {
      return { code: 0, out: execFileSync('node', [script, '--root', root, '--manifest', manifest], { stdio: ['pipe', 'pipe', 'pipe'] }).toString() };
    } catch (e) {
      return { code: e.status, out: (e.stdout || '').toString() + (e.stderr || '').toString() };
    }
  };
  const expect = (manifest, code, re) => {
    const r = run(manifest);
    if (r.code !== code) throw new Error(`${manifest}: exit ${r.code}, expected ${code}`);
    if (re && !re.test(r.out)) throw new Error(`${manifest}: output does not match ${re}`);
  };
  expect('within.json', 0, /✓ docs\/short\.md 38\/38/);
  expect('over.json', 1, /✗ docs\/long\.md \d+\/100 \(\+\d+ over\)/);
  expect('missing.json', 1, /docs\/gone\.md MISSING/);
  expect('empty.json', 2, /budgets nothing/);
  expect('absent.json', 2, /not found/);
  const { countWords } = require(script);
  if (countWords('a  b\nc\t d ') !== 4) throw new Error(`countWords miscounts: ${countWords('a  b\nc\t d ')}`);
  return 'within → 0, over/missing → 1, empty/absent manifest → 2';
});

// The four Pillar-4 criteria live in two places by design — the audit table the skill reads and the
// rubric template it emits from — and two copies of a criterion drift unless something says so. The
// ADR and postmortem rows are flagged aspirational in the skill (most repos have neither directory,
// and an absent postmortem dir is not a gap to fabricate incidents into); the gate pins the flag too.
//
// Negative controls (2026-08-25, each applied, observed, reverted — all exit 1):
//   the doc-budgets row struck from rubric-template.md ...............................................
//     "rubric-template.md lacks the criterion marker 'check-doc-budgets.js'"
//   ⚠ removed from the ADR row in SKILL.md ...........................................................
//     "SKILL.md's ADR-lifecycle row is not flagged ⚠ aspirational"
check('rubric-template and SKILL.md both carry the four Pillar-4 criteria, and the ADR/postmortem rows are flagged aspirational', () => {
  const rubric = read('plugins/harness-audit/skills/harness-audit/rubric-template.md');
  const skill = read('plugins/harness-audit/skills/harness-audit/SKILL.md');
  const markers = ['Alternatives considered', 'why the safety nets missed it', 'check-doc-budgets.js', 'proven by mutation'];
  for (const m of markers) {
    if (!rubric.includes(m)) throw new Error(`rubric-template.md lacks the criterion marker '${m}'`);
    if (!skill.includes(m)) throw new Error(`SKILL.md lacks the criterion marker '${m}'`);
  }
  if (!skill.includes('repeat-tool-guard.js')) throw new Error('SKILL.md Pillar 3 never names the loop-hygiene guard this plugin ships');
  for (const [label, m] of [['ADR-lifecycle', 'Alternatives considered'], ['postmortem', 'why the safety nets missed it']]) {
    const row = skill.split('\n').find((l) => l.startsWith('|') && l.includes(m));
    if (!row) throw new Error(`SKILL.md has no audit-table row carrying '${m}'`);
    if (!row.includes('⚠')) throw new Error(`SKILL.md's ${label} row is not flagged ⚠ aspirational`);
  }
  return '4 criteria in both files; ADR + postmortem rows ⚠';
});

// F13 — the capability table is the authority on what the port destroys, and its whole purpose is that
// install.sh and README §Compatibility stop being two independent retellings of the same caveats. So
// every row has to reach the reader in both places: the README in prose, install.sh by printing the
// table rather than its own copy. A row added here with no README disclosure fails this gate.
//
// Negative controls (2026-08-09, each applied, observed, reverted — all exit 1):
//   the loop-gate paragraph struck from README §Compatibility .....................................
//     FIRST RUN: exit 0. The control DID NOT BITE. The marker was still satisfied by the matrix row
//     naming the same feature, so a README that had deleted the entire explanation still passed —
//     the identical trap the guardrail check above records falling into, repeated one check later by
//     someone who had just read that comment. The matrix rows are now stripped before matching, and
//     only then did it fire: "opencode: README §Compatibility never discloses the lost capability
//     'loop-gate'". Recorded because the check was decoration for the length of one edit, and nothing
//     but the control said so.
//   install.sh's `node "$PORTER" --capabilities` calls replaced with the old inline echo blocks .....
//     "install.sh no longer prints the capability table — its warnings are a second copy of it again"
//   HARNESS_CAPABILITIES.pi.lost emptied ..........................................................
//     "pi declares no lost capability — the table would pass vacuously"
check('README and install.sh both disclose every capability the port table destroys', () => {
  const port = require(path.join(ROOT, 'scripts/port-loops.js'));
  const t = read(COMPAT_DOC);
  if (!/## Compatibility across harnesses/.test(t)) throw new Error('README lost the compatibility matrix section');
  const compatFull = t.split('## Compatibility across harnesses')[1].split(/\n## /)[0];
  // The MATRIX ROWS ARE STRIPPED before matching, and that is the whole point of this check rather
  // than an optimisation. Its first version matched the section as a whole, and the negative control
  // for the newest row (delete the loop-gate paragraph) PASSED: the marker was still satisfied by the
  // table cell that names the same feature. A cell reading "⚠️ degraded" is a fact a reader skims past
  // without learning the consequence — the same lesson the guardrail check above records learning the
  // hard way, arriving one check later. So the disclosure must live in prose, where the loss is
  // explained, and a matrix row alone can no longer stand in for it.
  const compat = compatFull.split('\n').filter((l) => !l.trim().startsWith('|')).join('\n');

  const targets = Object.entries(port.HARNESS_CAPABILITIES);
  if (!targets.length) throw new Error('HARNESS_CAPABILITIES is empty — this check would pass vacuously');

  let rows = 0;
  for (const [target, cap] of targets) {
    if (!cap.lost || !cap.lost.length) throw new Error(`${target} declares no lost capability — the table would pass vacuously`);
    const report = port.capabilityReport(target);
    for (const lost of cap.lost) {
      rows += 1;
      if (!lost.readmeMarker || !lost.warning || !lost.warning.length) {
        throw new Error(`${target}/${lost.id} is missing its readmeMarker or its warning text`);
      }
      // Matched against the section a reader lands on from the install instructions, never the whole
      // file: a caveat three sections away is a caveat hidden from the person who needs it.
      if (!new RegExp(lost.readmeMarker, 'i').test(compat)) {
        throw new Error(`${target}: README §Compatibility never discloses the lost capability '${lost.id}'`);
      }
      if (!report.includes(lost.warning[0])) {
        throw new Error(`${target}: capabilityReport() drops the warning for '${lost.id}' — install-time silence on a real loss`);
      }
    }
  }

  const inst = read('install.sh');
  if (!/--capabilities/.test(inst)) {
    throw new Error('install.sh no longer prints the capability table — its warnings are a second copy of it again');
  }
  return `${rows} capability row(s) across ${targets.length} targets, disclosed in README + install.sh`;
});

// D25a is enforced on the LINE-UP (model-lineup.js exits 2 on a same-family reviewer/implementer) —
// but a validated line-up governs nothing until it reaches the agent files, and for a long time it did
// not: the stamper's role→file map knew only the plugin's own agents, so implementer.md and
// reviewer.md, the two files the whole rule exists for, were the two it skipped. In a real project both
// were found still carrying `model: opus`, which is the independence property failing silently with a
// green line-up sitting beside it. An agent with no `model:` line at all was skipped too — and that is
// the same failure wearing different clothes, because both roles then inherit the session's model.
//
// The other half of this check is destruction: `cp -R agents/.` overwrote a project's customized
// domain-critic.md — the exact file README §domain-critic tells you to write — inside the one command
// a user runs to pin their own models.
//
// Negative controls (2026-08-10, each applied, observed, reverted — all exit 1):
//   implementer.md|reviewer.md removed from the stamper's case arms .................................
//     "implementer.md has no model: line after --lineup — it inherits the session model, and so does
//      reviewer.md, which is the independence property collapsing in silence" — not the predicted
//      "kept model: sonnet": the fixture's implementer ships with no model: at all, which is the shape
//      the real project had, so an unmapped role and a dropped insert branch fail identically. Both
//      end in the same place and it is the place that matters: two roles on one model.
//   the cmp -s guard removed, `cp` restored to unconditional .......................................
//     "install.sh overwrote a customized domain-critic.md — the file README tells users to write"
//   the awk insert branch dropped (only `grep -q '^model:'` files stamped) ..........................
//     "implementer.md has no model: line after --lineup — it inherits the session model, and so does
//      reviewer.md, which is the independence property collapsing in silence"
check('install.sh --lineup stamps the project roles and never clobbers a customized agent', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-stamp-'));
  const agents = path.join(tmp, '.claude/agents');
  fs.mkdirSync(path.join(tmp, '.agents'), { recursive: true });
  fs.mkdirSync(agents, { recursive: true });

  // A project line-up so this check does not depend on whatever the machine's global file says.
  fs.writeFileSync(path.join(tmp, '.agents/model-lineup.json'), JSON.stringify({
    version: 1,
    defaults: {
      architect: { model: 'claude-fable-5' }, orchestrator: { model: 'claude-fable-5' },
      implementer: { model: 'claude-opus-5' }, reviewer: { model: 'claude-fable-5' },
      preflight: { model: 'claude-sonnet-5' }, scorer: { model: 'claude-fable-5' },
      critic: { model: 'claude-sonnet-5' }, judge: { model: 'claude-fable-5' },
    },
  }));

  const MARK = 'CUSTOM-DOMAIN-CONTRACT-DO-NOT-CLOBBER';
  const fm = (name, extra) => `---\nname: ${name}\ndescription: "fixture"\n${extra}---\n\nbody\n`;
  fs.writeFileSync(path.join(agents, 'domain-critic.md'), fm('domain-critic', 'model: sonnet\n').replace('body', MARK));
  fs.writeFileSync(path.join(agents, 'implementer.md'), fm('implementer', ''));      // no model: at all
  fs.writeFileSync(path.join(agents, 'reviewer.md'), fm('reviewer', 'model: opus\n')); // same family as implementer
  fs.writeFileSync(path.join(agents, 'no-frontmatter.md'), '# not an agent\nprose\n');

  const wfDir = path.join(tmp, 'harness-workflows');
  execFileSync('sh', [path.join(ROOT, 'install.sh'), '--target', 'claude', '--lineup',
    '--skip-graphify', '--yes'], { cwd: tmp, stdio: 'pipe', env: { ...process.env, HARNESS_WORKFLOWS_DIR: wfDir } });
  // The wrapper the skill writes calls the global loop by path; without the plugin, install.sh puts it there.
  if (!fs.existsSync(path.join(wfDir, 'develop-phase.js'))
    || read('plugins/harness-loops/workflows/develop-phase.js') !== fs.readFileSync(path.join(wfDir, 'develop-phase.js'), 'utf8')) {
    throw new Error('install.sh --target claude did not copy the global develop-phase loop where the wrapper calls it');
  }

  const modelOf = (f) => {
    const src = fs.readFileSync(path.join(agents, f), 'utf8');
    const block = /^---\n([\s\S]*?)\n---/.exec(src);
    return block ? (/^model:\s*(\S+)/m.exec(block[1]) || [])[1] : undefined;
  };

  if (!fs.readFileSync(path.join(agents, 'domain-critic.md'), 'utf8').includes(MARK)) {
    throw new Error('install.sh overwrote a customized domain-critic.md — the file README tells users to write');
  }

  const impl = modelOf('implementer.md');
  const rev = modelOf('reviewer.md');
  if (!impl) {
    throw new Error('implementer.md has no model: line after --lineup — it inherits the session model, and so does reviewer.md, which is the independence property collapsing in silence');
  }
  if (impl !== 'opus') throw new Error(`implementer.md kept model: ${impl} — the stamper skipped the role D25a is about`);
  if (!rev) throw new Error('reviewer.md lost its model: line');
  // The property, not the literal: whatever the line-up resolves to, these two may never be the same.
  const { familyOf } = require(path.join(ROOT, 'plugins/harness-audit/scripts/model-lineup.js'));
  const ALIAS = { fable: 'claude-fable-5', opus: 'claude-opus-5', sonnet: 'claude-sonnet-5', haiku: 'claude-haiku-4-5-20251001' };
  const famOf = (a) => familyOf({ model: ALIAS[a] || a });
  if (famOf(impl) === famOf(rev)) {
    throw new Error(`after --lineup, implementer (${impl}) and reviewer (${rev}) resolve to the same family ${famOf(impl)} — D25a passed on the line-up and failed on the files`);
  }
  if (modelOf('no-frontmatter.md') !== undefined) {
    throw new Error('a file with no frontmatter was stamped — Claude Code never registers it, so the model: line is decoration on prose');
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  return `implementer=${impl} · reviewer=${rev} (${famOf(impl)} ≠ ${famOf(rev)}) · custom agent preserved · frontmatter-less file left alone`;
});

// ── TypeSafe Jev ──────────────────────────────────────────────────────────────────────────────────
// Every Jev path is off unless a key is present, and the tests must be true on a machine that has
// one: each child process below runs with HOME pointed at an empty dir and TYPESAFE_API_KEY removed,
// so a developer's real key is never what the gate measured. JEV_MOCK_FILE stands in for the API.
const jevEnv = (extra = {}) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-home-'));
  const env = { ...process.env, HOME: home, ...extra };
  delete env.TYPESAFE_API_KEY;
  if (!('JEV_MOCK_FILE' in extra)) delete env.JEV_MOCK_FILE;
  return { env, home };
};
const jevMock = (name) => path.join(ROOT, 'scripts/fixtures/jev', name);
const runNode = (args, env, input) => {
  try {
    return { code: 0, out: execFileSync('node', args, { env, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }), err: '' };
  } catch (e) { return { code: e.status, out: e.stdout || '', err: e.stderr || '' }; }
};

// Negative control (2026-09-22, applied, observed, reverted — exit 1):
//   readKey() stops honouring the `off` sentinel in secrets.env ....................................
//     "TYPESAFE_API_KEY=off in secrets.env did not pause the client"
check('jev client is a no-op without a key, reads the secrets file, and honours JEV_MOCK_FILE', () => {
  mustExist('plugins/harness-loops/scripts/jev.js');
  const script = path.join(ROOT, 'plugins/harness-loops/scripts/jev.js');
  execFileSync('node', ['--check', script], { stdio: 'pipe' });
  const probe = (env) => runNode(['-e', `
    const j = require(${JSON.stringify(script)});
    j.noul('x', 'y', { waits: [] }).then((p) => console.log('P', p), (e) => console.log('E', e.code || e.message));
  `], env);
  const off = probe(jevEnv().env);
  if (!/^E JEV_DISABLED/m.test(off.out)) throw new Error(`without a key the client answered: ${off.out.trim() || off.err.trim()}`);
  const { env, home } = jevEnv();
  fs.mkdirSync(path.join(home, '.agents'));
  fs.writeFileSync(path.join(home, '.agents', 'secrets.env'), 'TYPESAFE_API_KEY=off\n');
  if (!/^E JEV_DISABLED/m.test(probe(env).out)) throw new Error('TYPESAFE_API_KEY=off in secrets.env did not pause the client');
  const st = runNode(['-e', `console.log(JSON.stringify(require(${JSON.stringify(script)}).status()))`], { ...env, TYPESAFE_API_KEY: 'k' });
  if (!/"source":"env"/.test(st.out)) throw new Error(`env key not reported as source env: ${st.out}`);
  const mock = probe(jevEnv({ JEV_MOCK_FILE: jevMock('mock-noul.json') }).env);
  if (!/^P 0\.97/m.test(mock.out)) throw new Error(`mock did not answer 0.97: ${mock.out.trim() || mock.err.trim()}`);
  const fail = probe(jevEnv({ JEV_MOCK_FILE: jevMock('mock-fail.json') }).env);
  if (!/^E timeout/m.test(fail.out)) throw new Error(`mock-fail did not surface as a timeout: ${fail.out.trim()}`);
  return 'disabled without a key · `off` sentinel honoured · env > secrets · mock answers and fails on demand';
});

// The dedupe replaces a sentence addressed to the chair with arithmetic. The controls that matter:
// a blocker at p=0.90 is NEW (its bar is 0.95), a minor at 0.91 is carried, an exact restatement is
// carried without any request, a different file is never paired, and without a key the output
// says exact-only and counts what is left for the chair — never silently new, never silently gone.
//
// Negative control (2026-09-22, applied, observed, reverted — exit 1):
//   DEDUPE_BLOCKER_THRESHOLD lowered to 0.85 ........................................................
//     "mock NEW line wrong — a blocker at p=0.90 must stay new" — and the eval check went red with it,
//     because the eval reads the same constant instead of keeping its own copy.
check('loop-gate dedupe counts NEW arithmetically, never hides a blocker, and degrades to exact-only', () => {
  const script = path.join(ROOT, 'plugins/harness-loops/scripts/loop-gate.js');
  const prev = path.join(ROOT, 'scripts/fixtures/findings/dedupe-prev.json');
  const cur = path.join(ROOT, 'scripts/fixtures/findings/dedupe-current.json');
  const off = runNode([script, 'dedupe', prev, cur], jevEnv().env);
  if (off.code !== 0) throw new Error(`no-key run exited ${off.code}: ${off.err.trim()}`);
  if (!/^DEDUPE: exact-only \(no TYPESAFE_API_KEY\)/m.test(off.out)) throw new Error(`no-key run did not announce exact-only: ${off.out}`);
  if (!/^NEW: blocker 1 major 2 minor 1/m.test(off.out)) throw new Error(`no-key NEW line wrong: ${off.out}`);
  if (!/^UNJUDGED: 2 pair/m.test(off.out)) throw new Error('no-key run did not count the pairs left for the chair');

  const out = path.join(jevEnv().home, 'dedupe.json');
  const on = runNode([script, 'dedupe', prev, cur, '--out', out], jevEnv({ JEV_MOCK_FILE: jevMock('mock-dedupe.json') }).env);
  if (on.code !== 0) throw new Error(`mock run exited ${on.code}: ${on.err.trim()}`);
  if (!/^DEDUPE: jev \(2 pair\(s\), 1 request/m.test(on.out)) throw new Error(`mock run header wrong: ${on.out}`);
  if (!/^NEW: blocker 1 major 2 minor 0/m.test(on.out)) throw new Error(`mock NEW line wrong — a blocker at p=0.90 must stay new: ${on.out}`);
  if (!/^CARRIED: blocker 0 major 1 minor 1/m.test(on.out)) throw new Error(`mock CARRIED line wrong: ${on.out}`);
  if (!/R2-F1 major restates R1-F1 \(p=1\.00, exact\)/.test(on.out)) throw new Error('the exact restatement is not printed under CARRIED');
  const report = JSON.parse(fs.readFileSync(out, 'utf8'));
  const byId = Object.fromEntries(report.findings.map((f) => [f.id, f]));
  if (byId['R2-F3'].new !== true || byId['R2-F3'].p !== 0.9) throw new Error('blocker R2-F3 at p=0.90 was deduped — the blocker bar is 0.95');
  if (byId['R2-F2'].new !== false || byId['R2-F2'].restates !== 'R1-F1') throw new Error('minor R2-F2 at p=0.91 was not carried');
  if (byId['R2-F4'].via !== 'no-candidate') throw new Error('a different file was paired');

  const broken = runNode([script, 'dedupe', prev, cur], jevEnv({ JEV_MOCK_FILE: jevMock('mock-fail.json') }).env);
  if (broken.code !== 0 || !/^DEDUPE: exact-only \(jev unavailable: timeout/m.test(broken.out)) throw new Error(`API failure did not degrade to exact-only with its reason: ${broken.out} ${broken.err}`);
  const bad = runNode([script, 'dedupe', prev, path.join(ROOT, 'scripts/fixtures/findings/valid-findings.json')], jevEnv().env);
  if (bad.code !== 2 || !/missing "id"/.test(bad.err)) throw new Error('an un-aggregated findings array (no id/critic) was accepted — dedupe runs after the chair assigns ids');
  return 'exact-only without a key · blocker at 0.90 stays new · minor at 0.91 carried · API failure announced · un-aggregated input refused (exit 2)';
});

// Negative control (2026-09-22, applied, observed, reverted — exit 1):
//   the router's race timer lifted from BUDGET_MS to 5000 ..........................................
//     "a slow API held the prompt for 4040ms — the budget is 1500"
check('prompt-router emits one advisory UserPromptSubmit context under budget and never decides', () => {
  const script = path.join(ROOT, 'plugins/harness-loops/scripts/hooks/prompt-router.js');
  mustExist('plugins/harness-loops/scripts/hooks/prompt-router.js');
  execFileSync('node', ['--check', script], { stdio: 'pipe' });
  const fx = (name) => read(path.join('scripts/fixtures/hooks', name));
  const withSkill = (extra) => {
    const e = jevEnv(extra);
    fs.mkdirSync(path.join(e.home, '.claude', 'skills', 'harness-audit'), { recursive: true });
    fs.writeFileSync(path.join(e.home, '.claude', 'skills', 'harness-audit', 'SKILL.md'), '---\nname: harness-audit\ndescription: audit a harness\n---\n');
    fs.mkdirSync(path.join(e.home, '.claude', 'skills', 'harness-audit:harness-audit'), { recursive: true });
    fs.writeFileSync(path.join(e.home, '.claude', 'skills', 'harness-audit:harness-audit', 'SKILL.md'), '---\nname: x\ndescription: audit a harness\n---\n');
    return { ...e.env, PROMPT_ROUTER_DIR: path.join(e.home, 'router-cache') };
  };
  if (runNode([script], jevEnv().env, fx('user-prompt-submit-jev.json')).out !== '') throw new Error('the router spoke without a key');
  const mockEnv = withSkill({ JEV_MOCK_FILE: jevMock('mock-router.json') });
  if (runNode([script], mockEnv, fx('user-prompt-submit-slash.json')).out !== '') throw new Error('the router spoke on a slash command — the human already chose');
  if (runNode([script], mockEnv, fx('other-event.json')).out !== '') throw new Error('a non-UserPromptSubmit payload produced output');
  const r = runNode([script], mockEnv, fx('user-prompt-submit-jev.json'));
  let o;
  try { o = JSON.parse(r.out); } catch { throw new Error(`stdout is not JSON: ${r.out.slice(0, 80)} ${r.err.slice(0, 120)}`); }
  const h = o.hookSpecificOutput;
  if (!h || h.hookEventName !== 'UserPromptSubmit') throw new Error('hookEventName is not UserPromptSubmit');
  if (!/likely skill `harness-audit:harness-audit` \(p=0\.71\)/.test(h.additionalContext)) throw new Error(`skill suggestion missing: ${h.additionalContext}`);
  if (!/subagent tier sonnet \(p=0\.62\)/.test(h.additionalContext)) throw new Error(`tier suggestion missing: ${h.additionalContext}`);
  for (const k of Object.keys(o)) if (k !== 'hookSpecificOutput') throw new Error(`unknown top-level key ${k}`);
  if ('decision' in o || 'permissionDecision' in h) throw new Error('the router decided — it is advisory only');
  const t0 = Date.now();
  const slow = runNode([script], withSkill({ JEV_MOCK_FILE: jevMock('mock-slow.json') }), fx('user-prompt-submit-jev.json'));
  const ms = Date.now() - t0;
  if (slow.code !== 0 || slow.out !== '') throw new Error(`a slow API produced output or a non-zero exit: ${slow.out}`);
  if (ms > 2500) throw new Error(`a slow API held the prompt for ${ms}ms — the budget is 1500`);
  return `silent without key / on slash / on other events · skill + tier suggested from mock · slow API dropped in ${ms}ms · never decides`;
});

// skill-inventory read only the line of the `description:` key, so a YAML block scalar came back as its
// indicator: 26 of the 102 skills on the author's machine reached the router described as ">-" or ">"
// (docs/harness-dev/loop-runs/2026-10-10-jev-router-before-fix.skills.json). Both shipped copies are run.
//
// Negative control (2026-10-10, applied, observed, reverted — exit 1):
//   frontmatterDescription() returns the key's own line, block scalar or not ...........................
//     "plugins/harness-guards/scripts/skill-inventory.js: folded (>) read as ">" — the text is on the indented lines below the key"
check('skill-inventory reads a folded (>, >-) and a literal (|) description, not the indicator', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-inv-'));
  const cases = {
    folded: ['>', 'description: >\n  Rewrites a draft so it reads\n  as a person wrote it.\nname: folded', 'Rewrites a draft so it reads as a person wrote it.'],
    'folded-strip': ['>-', 'name: folded-strip\ndescription: >-\n  Folded, stripped.\n\n  Second paragraph.\nmetadata:\n  a: 1', 'Folded, stripped. Second paragraph.'],
    literal: ['|', 'description: |\n  Line one.\n  Line two.\nname: literal', 'Line one. Line two.'],
    plain: ['plain', 'name: plain\ndescription: A plain one-liner', 'A plain one-liner'],
    quoted: ['quoted', 'description: "Quoted, with: a colon"\nname: quoted', 'Quoted, with: a colon'],
  };
  try {
    for (const [name, [, fm]] of Object.entries(cases)) {
      fs.mkdirSync(path.join(repo, '.claude', 'skills', name), { recursive: true });
      fs.writeFileSync(path.join(repo, '.claude', 'skills', name, 'SKILL.md'), `---\n${fm}\n---\n# ${name}\n`);
    }
    for (const p of ['harness-guards', 'harness-loops']) {
      const rel = `plugins/${p}/scripts/skill-inventory.js`;
      delete require.cache[path.join(ROOT, rel)];
      const { skills } = require(path.join(ROOT, rel)).inventorySkills(repo, { warn: () => {} });
      for (const [name, [shape, , want]] of Object.entries(cases)) {
        const got = (skills.find((s) => s.source === 'project' && s.name === name) || {}).description;
        if (got !== want) throw new Error(`${rel}: ${name} (${shape}) read as ${JSON.stringify(got)} — the text is on the indented lines below the key`);
      }
    }
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
  return 'both copies: > · >- · | · plain · quoted each read as their text, and a following key ends the block';
});

check('jev-nudge fires once a day and only while Jev is off; jev-setup reports status by exit code', () => {
  const nudge = path.join(ROOT, 'plugins/harness-loops/scripts/hooks/jev-nudge.js');
  const setup = path.join(ROOT, 'plugins/harness-loops/scripts/jev-setup.js');
  for (const f of ['plugins/harness-loops/scripts/hooks/jev-nudge.js', 'plugins/harness-loops/scripts/jev-setup.js', 'plugins/harness-loops/bin/jev-setup']) mustExist(f);
  execFileSync('node', ['--check', nudge], { stdio: 'pipe' });
  execFileSync('node', ['--check', setup], { stdio: 'pipe' });
  const start = read('scripts/fixtures/hooks/session-start.json');
  const e = jevEnv();
  const env = { ...e.env, JEV_NUDGE_DIR: path.join(e.home, 'nudge') };
  const first = runNode([nudge], env, start);
  let o;
  try { o = JSON.parse(first.out); } catch { throw new Error(`first start did not nudge: ${first.out.slice(0, 80)}`); }
  if (o.hookSpecificOutput.hookEventName !== 'SessionStart' || !/bin\/jev-setup/.test(o.hookSpecificOutput.additionalContext)) throw new Error('the nudge does not name bin/jev-setup');
  if (runNode([nudge], env, start).out !== '') throw new Error('the nudge fired twice in one day');
  if (runNode([nudge], { ...env, TYPESAFE_API_KEY: 'k', JEV_NUDGE_DIR: path.join(e.home, 'nudge2') }, start).out !== '') throw new Error('the nudge fired with a key present');
  if (runNode([nudge], env, read('scripts/fixtures/hooks/other-event.json')).out !== '') throw new Error('a non-SessionStart payload produced output');
  if (runNode([setup, '--status'], e.env).code !== 3) throw new Error('jev-setup --status without a key must exit 3');
  if (runNode([setup, '--status'], { ...e.env, TYPESAFE_API_KEY: 'k' }).code !== 0) throw new Error('jev-setup --status with a key must exit 0');
  const h = JSON.parse(read(`${LOOPS}/hooks/hooks.json`)).hooks;
  if (!JSON.stringify(h.SessionStart || []).includes('jev-nudge.js')) throw new Error('hooks.json does not install jev-nudge on SessionStart');
  if (!JSON.stringify(h.UserPromptSubmit || []).includes('prompt-router.js')) throw new Error('hooks.json does not install prompt-router on UserPromptSubmit');
  const inst = read('install.sh');
  if (!/--skip-jev/.test(inst) || !/jev-setup\.js" --status/.test(inst)) throw new Error('install.sh never asks about a Jev key (or cannot be told not to)');
  if (!/"\$ASSUME_YES" -eq 0 \] && \[ -t 0 \]/.test(inst)) throw new Error('install.sh may ask for a Jev key non-interactively or under --yes — consent is never a CI default');
  return 'nudge once/day · silent with a key · setup exit 3/0 · both hooks wired · install.sh asks only on a TTY';
});

check('the panel loops route round-2 dedupe through loop-gate and degrade honestly', () => {
  for (const cmd of ['orchestrate', 'review-loop']) {
    const src = read(commandPath(cmd));
    if (!/loop-gate\.js" dedupe/.test(src)) throw new Error(`${cmd} never runs loop-gate.js dedupe — "new vs restated" is back in the chair's hands`);
    if (!/`NEW:`/.test(src) || !/exact-only/.test(src) || !/UNJUDGED/.test(src)) throw new Error(`${cmd} does not tell the chair how to read DEDUPE/NEW/UNJUDGED`);
    if (/Judge by meaning, not by string equality\./.test(src)) throw new Error(`${cmd} still asks the chair to judge restatements by meaning as the primary path`);
  }
  const pi = read('scripts/port-loops.js');
  if (!/loop-gate\.js" dedupe/.test(pi)) throw new Error('port-loops.js has no Pi substitution for the dedupe block — the ported command would call a script Pi never installs');
  return 'orchestrate + review-loop call dedupe from round 2, read NEW:, disclose exact-only · Pi port degrades it to a hand-check';
});

check('README discloses Jev: the env var, the endpoint, what leaves the machine, and the off-by-default guarantee', () => {
  const t = read(LOOPS_README);
  for (const must of ['TYPESAFE_API_KEY', 'api.typesafe.ai', 'bin/jev-setup', 'exact-only', 'prompt-router', 'jev-nudge']) {
    if (!t.includes(must)) throw new Error(`README never mentions ${must}`);
  }
  if (!/## Jev/.test(t)) throw new Error('README has no §Jev');
  const sec = t.split(/^## Jev/m)[1].split(/^## /m)[0];
  if (!/transcript/i.test(sec) || !/never/i.test(sec)) throw new Error('§Jev does not say transcripts never leave the machine');
  if (!/United States|US-hosted|hosted in the US/.test(sec) || !/SCC/.test(sec)) throw new Error('§Jev does not state where the data goes and under which transfer clauses');
  // The operator reads the tier criterion in the README; Jev reads it in jev.js. One wording, or the
  // README describes a router that is not the one running.
  for (const [tier, criterion] of Object.entries(require(path.join(ROOT, 'plugins/harness-loops/scripts/jev.js')).TIERS)) {
    if (!sec.includes(`**${tier}** — ${criterion}`)) throw new Error(`§Jev does not print the ${tier} criterion exactly as jev.js TIERS has it`);
  }
  if (!/routeByJev/.test(sec) || !/jev_router_eval\.js/.test(sec)) throw new Error('§Jev does not say what routeByJev sends or what the router eval measured');
  return '§Jev present · env var, endpoint, setup command, degradation mode, both hooks, data flow and residency disclosed · tier criterion matches jev.js';
});

// The only check here that touches the network, and it is opt-in twice: a key AND JEV_LIVE=1.
check('jev live smoke — one noul round trip to api.typesafe.ai', () => {
  const script = path.join(ROOT, 'plugins/harness-loops/scripts/jev.js');
  if (process.env.JEV_LIVE !== '1') skip('set JEV_LIVE=1 (and a TYPESAFE_API_KEY) to run the live round trip');
  if (!require(script).isEnabled()) skip('no TYPESAFE_API_KEY — nothing to ping');
  const r = runNode([path.join(ROOT, 'plugins/harness-loops/scripts/jev-setup.js'), '--ping'], process.env);
  if (r.code !== 0 || !/^OK/.test(r.out)) throw new Error(`ping failed: ${r.out.trim()} ${r.err.trim()}`);
  return r.out.trim();
});

const DEVELOP_PHASE = 'plugins/harness-loops/workflows/develop-phase.js';

// The develop-phase loop is code every project runs (through its wrapper), so a bug in it ships to
// every repo the audit touches. Two lived there: the reviewer's verdict was `includes('APPROVED')`,
// and the preflight's was `includes('pass') || includes('exit:0')` over a seat's prose — which reads
// "3 passed, 2 failed", "bypass", and a SKIP followed by the gate's closing PASS banner as green.
// This check runs the template itself with stub seats, so it asserts behaviour, not spelling.
//
// Negative controls (2026-09-22, each applied, observed, reverted — all exit 1):
//   reviewer verdict back to includes('APPROVED') .................................................
//     "'not APPROVED' in a [FAIL] line approved the change — the verdict is the last line, whole"
//   preflightPassed = exitCode === 0 (skipped ignored) .............................................
//     "exit 0 with a SKIP passed — a skipped check is not a passed one"
//   Pi mirror only, back to a substring test on the log ............................................
//     "a clean exit 0 did not pass" — predicted the SKIP message; it failed one case earlier, because a
//     clean gate whose log never says the word is red to a substring test too. The mirror is checked.
check('develop-phase loop decides from the verdict line and the exit code, and a SKIP is not a PASS', () => {
  const harness = `
    const fs = require('fs');
    const src = fs.readFileSync(process.argv[1], 'utf8').replace(/^export /m, '');
    const AsyncFn = Object.getPrototypeOf(async function () {}).constructor;
    const run = (review, pf) => new AsyncFn('args', 'agent', 'log', 'phase', src)(
      { maxIter: 1 },
      async (_p, o) => (o.label === 'preflight' ? pf : String(o.label).startsWith('review') ? review : 'impl'),
      () => {}, () => {});
    const pf = (exitCode, skipped = [], tail = '') => ({ exitCode, skipped, failedCheck: exitCode ? 'test' : null, tail });
    (async () => {
      const out = {};
      out.pass = await run('[PASS] a — x\\nAPPROVED', pf(0));
      out.skip = await run('[PASS] a — x\\n**APPROVED**', pf(0, ['SKIP: token absent'], 'SKIP: token absent\\nPASS'));
      out.fail = await run('[PASS] a — x\\nAPPROVED', pf(1, [], 'Tests: 3 passed, 2 failed'));
      out.prose = await run('[FAIL] b — not APPROVED yet\\nREJECTED', pf(0));
      console.log(JSON.stringify(Object.fromEntries(Object.entries(out).map(([k, r]) => [k, [r.approved, r.preflightPassed, r.handoff.status]]))));
    })().catch((e) => console.log('THREW ' + e.message));
  `;
  const seen = [];
  for (const rel of [DEVELOP_PHASE]) {
    const out = execFileSync('node', ['-e', harness, path.join(ROOT, rel)], { encoding: 'utf8' }).trim();
    if (out.startsWith('THREW')) throw new Error(`${rel}: the develop-phase loop throws when run — ${out.slice(6)}`);
    const r = JSON.parse(out);
    const want = { pass: [true, true, 'complete'], skip: [true, false, 'continue'], fail: [true, false, 'continue'], prose: [false, true, 'blocked'] };
    for (const [k, v] of Object.entries(want)) {
      if (JSON.stringify(r[k]) !== JSON.stringify(v)) {
        const why = { pass: 'a clean exit 0 did not pass', skip: 'exit 0 with a SKIP passed — a skipped check is not a passed one', fail: "exit 1 with '3 passed' in the log passed — the verdict is the exit code, not a word in the output", prose: "'not APPROVED' in a [FAIL] line approved the change — the verdict is the last line, whole" }[k];
        throw new Error(`${rel}: ${why} (got ${JSON.stringify(r[k])})`);
      }
    }
    seen.push('global loop');
  }
  return `${seen.join(' + ')}: pass → complete · SKIP → continue · exit 1 → continue · "not APPROVED" → blocked`;
});

// The template also carries the seats around the loop: a scout and an analyst before the implementer, and a
// reviewer that may be another vendor's model reached through scripts/external-review.sh. Each is a way for
// the gate to go quiet wrong: a blocker that the implementer ignores, a reviewer that shares the
// implementer's family, an external review whose verdict is never read, or a dead seat that hangs the run.
// The check runs the template with stub seats and asserts what each case actually did.
//
// Negative controls (2026-09-26, each applied to the skill template, observed, reverted — all exit 1):
//   the familyOf() guard commented out ...............................................................
//     "a reviewer of the implementer's own family ran — D25a is enforced at run time, no seat may start"
//   the analyst's `BLOCKER:` prefix compared against `BLOCKED:` .......................................
//     "the implementer ran after the analyst reported a blocker — it must stop before any implementer token"
check('develop-phase loop: a blocker stops before the implementer, a same-family reviewer is refused, an external verdict is read, a dead seat degrades', () => {
  const harness = (mdPath) => {
    const fs = require('fs');
    const src = fs.readFileSync(mdPath, 'utf8').replace(/^export /m, '');
    const AsyncFn = Object.getPrototypeOf(async function () {}).constructor;
    const pf = { exitCode: 0, skipped: [], failedCheck: null, tail: '' };
    const run = async (args, seat) => {
      const calls = [];
      const agent = async (prompt, o) => { calls.push({ label: String(o.label), model: o.model, prompt }); return seat(String(o.label)); };
      const out = await new AsyncFn('args', 'agent', 'log', 'phase', src)(args, agent, () => {}, () => {});
      return { status: out.handoff.status, approved: out.approved, calls };
    };
    const ok = (l) => (l === 'preflight' ? pf : l.startsWith('review') ? '[PASS] a — x\nAPPROVED' : l === 'scout' ? 'BRIEF-TEXT' : l === 'analyst' ? 'PLAN-TEXT' : 'impl');
    const ext = (verdict) => (l) => (l.startsWith('review') ? { output: verdict } : ok(l));
    const EXT = 'openrouter/acme/model-x';
    const labels = (r) => r.calls.map((c) => c.label);
    (async () => {
      const blocker = await run({ maxIter: 1 }, (l) => (l === 'analyst' ? 'BLOCKER: which tenant?' : ok(l)));
      const family = await run({ maxIter: 1, reviewerModel: 'opus' }, ok);
      const familyExt = await run({ maxIter: 1, reviewerModel: 'openrouter/anthropic/claude-opus-5.5' }, ok);
      const yes = await run({ maxIter: 1, reviewerModel: EXT }, ext('[PASS] a — x\nAPPROVED'));
      const no = await run({ maxIter: 1, reviewerModel: EXT }, ext('[FAIL] a — x\nREJECTED'));
      const deadScout = await run({ maxIter: 1 }, (l) => (l === 'scout' ? null : ok(l)));
      const deadReviewer = await run({ maxIter: 1 }, (l) => (l.startsWith('review') ? null : ok(l)));
      const plain = await run({ maxIter: 1, preparer: false }, ok);
      console.log(JSON.stringify({
        blocker: [blocker.status, labels(blocker).some((l) => l.startsWith('impl'))],
        family: [family.status, family.calls.length, familyExt.status, familyExt.calls.length],
        external: [yes.approved, yes.calls.find((c) => c.label.startsWith('review')).prompt.includes(`scripts/external-review.sh ${EXT}`), no.approved, no.status],
        deadScout: [deadScout.approved, deadScout.calls.find((c) => c.label.startsWith('impl')).prompt.includes('BRIEF:')],
        deadReviewer: deadReviewer.status,
        plain: labels(plain).filter((l) => l === 'scout' || l === 'analyst').length,
      }));
    })().catch((e) => console.log('THREW ' + e.message));
  };
  const seen = [];
  for (const rel of [DEVELOP_PHASE]) {
    const out = execFileSync('node', ['-e', `(${harness})(process.argv[1])`, path.join(ROOT, rel)], { encoding: 'utf8' }).trim();
    if (out.startsWith('THREW')) throw new Error(`${rel}: the develop-phase loop throws when run — ${out.slice(6)}`);
    const r = JSON.parse(out);
    const want = {
      blocker: [['blocked', false], 'the implementer ran after the analyst reported a blocker — it must stop before any implementer token'],
      family: [['blocked', 0, 'blocked', 0], "a reviewer of the implementer's own family ran — D25a is enforced at run time, no seat may start"],
      external: [[true, true, false, 'blocked'], "an external reviewer's verdict was not read from its output, or the bridge was not called with the model id"],
      deadScout: [[true, false], 'a dead scout changed the run — it must continue and the implementer must not receive a brief that does not exist'],
      deadReviewer: ['blocked', 'a dead reviewer seat did not end in a blocked handoff'],
      plain: [0, 'preparer: false still ran the scout or the analyst'],
    };
    for (const [k, [v, why]] of Object.entries(want)) {
      if (JSON.stringify(r[k]) !== JSON.stringify(v)) throw new Error(`${rel}: ${why} (got ${JSON.stringify(r[k])})`);
    }
    seen.push('global loop');
  }
  return `${seen.join(' + ')}: blocker → stop before implementer · same family → refused before any seat · external verdict read · dead scout degrades · dead reviewer → blocked · preparer:false skips both`;
});

// The first live run of the global loop (2026-10-11, notion-impac-pilotage, ticket PRD-008/01) went wrong in a
// way no stub had shown: a seat sees the parent conversation. The review relay seat obeyed the human's last chat
// message ("make the commit"), committed before the review with the harness's Co-Authored-By line, and the reviewer
// then judged an empty diff; another round, the relay refused to send code to the bridge and returned REJECTED with
// no [FAIL] line, and the loop spun its five rounds with nothing for the implementer to fix.
//
// Negative controls (2026-10-11, each applied, observed, reverted — all exit 1):
//   SEAT_RULES dropped from the review relay prompt ...................................................
//     "a seat's prompt does not open with the isolation rules — it may obey the chat instead of the loop"
//   the no-[FAIL] stop commented out ..................................................................
//     "a rejection without a [FAIL] line looped — it must stop after one round, there is nothing to fix"
//   the BRIDGE NOT RUN stop commented out ...........................................................
//     "a bridge that did not run was looped on — it must stop and say the bridge did not run"
check('develop-phase loop: every seat is told its prompt is its only instruction, only the commit seat commits, a review without a [FAIL] line or a bridge that did not run stops the loop', () => {
  const harness = (file) => {
    const fs = require('fs');
    const src = fs.readFileSync(file, 'utf8').replace(/^export /m, '');
    const AsyncFn = Object.getPrototypeOf(async function () {}).constructor;
    const pf = { exitCode: 0, skipped: [], failedCheck: null, tail: '' };
    const run = async (args, review) => {
      const calls = [];
      const agent = async (prompt, o) => {
        const l = String(o.label); calls.push({ label: l, prompt });
        if (l === 'preflight') return pf;
        if (l === 'commit') return { committed: true, hash: 'abc1234', message: 'feat: x', note: 'a.ts' };
        if (l.startsWith('review')) return review(l);
        return l === 'scout' ? 'BRIEF' : l === 'analyst' ? 'PLAN' : 'impl';
      };
      const out = await new AsyncFn('args', 'agent', 'log', 'phase', src)(args, agent, () => {}, () => {});
      return { out, calls, impls: calls.filter((c) => c.label.startsWith('impl')).length };
    };
    const EXT = 'openrouter/acme/model-x';
    (async () => {
      const ok = await run({ maxIter: 3, commit: true }, () => '[PASS] a — x\nAPPROVED');
      const okExt = await run({ maxIter: 3, reviewerModel: EXT }, () => ({ output: '[PASS] a — x\nAPPROVED' }));
      const isolated = [...ok.calls, ...okExt.calls].every((c) => c.prompt.startsWith('You are one seat of an automated develop-phase loop'));
      const noGit = [...ok.calls, ...okExt.calls].filter((c) => c.label !== 'commit').every((c) => c.prompt.includes('Never commit, stage, stash, push or switch branches'));
      const commitSeat = ok.calls.find((c) => c.label === 'commit');
      const bare = await run({ maxIter: 5 }, () => 'Commit created: 963f2c9 on the branch.\nREJECTED');
      const refused = await run({ maxIter: 5, reviewerModel: EXT }, () => ({ output: 'BRIDGE NOT RUN: it sends code to a third party\nREJECTED' }));
      const realFail = await run({ maxIter: 2 }, () => '- [FAIL] tests — none added\nREJECTED');
      console.log(JSON.stringify({
        isolated, noGit, commitSeat: [!!commitSeat, !!commitSeat && !commitSeat.prompt.includes('Never commit, stage')],
        bare: [bare.out.handoff.status, bare.impls, /without naming a \[FAIL\]/.test(bare.out.handoff.summary)],
        refused: [refused.out.handoff.status, refused.impls, /bridge did not run/.test(refused.out.handoff.summary)],
        realFail: [realFail.out.handoff.status, realFail.impls, realFail.out.handoff.evidence.includes('[FAIL] tests — none added')],
      }));
    })().catch((e) => console.log('THREW ' + e.message));
  };
  const out = execFileSync('node', ['-e', `(${harness})(process.argv[1])`, path.join(ROOT, DEVELOP_PHASE)], { encoding: 'utf8' }).trim();
  if (out.startsWith('THREW')) throw new Error(`the develop-phase loop throws when run — ${out.slice(6)}`);
  const r = JSON.parse(out);
  const want = {
    isolated: [true, "a seat's prompt does not open with the isolation rules — it may obey the chat instead of the loop"],
    noGit: [true, 'a seat other than the commit seat was not told it never commits'],
    commitSeat: [[true, true], 'the commit seat is missing, or was told never to commit'],
    bare: [['blocked', 1, true], 'a rejection without a [FAIL] line looped — it must stop after one round, there is nothing to fix'],
    refused: [['blocked', 1, true], 'a bridge that did not run was looped on — it must stop and say the bridge did not run'],
    realFail: [['blocked', 2, true], 'a real [FAIL] line (even as a list item) did not keep the loop going, or did not reach the evidence'],
  };
  for (const [k, [v, why]] of Object.entries(want)) {
    if (JSON.stringify(r[k]) !== JSON.stringify(v)) throw new Error(`${why} (got ${JSON.stringify(r[k])})`);
  }
  return 'isolation rules on every seat · only the commit seat commits · no [FAIL] → stop after 1 round · bridge not run → stop · a listed [FAIL] keeps looping';
});

// A project no longer forks the loop: whatever it customized lives in its wrapper's config. So every key
// a fork used to hard-code has to reach the seat it was for, or the migration silently drops it. The
// config below is the pilot's (notion-impac-pilotage), the first fork migrated.
//
// Negative controls (2026-10-10, each applied, observed, reverted — all exit 1):
//   `lang` ignored (commit prompt hard-coded to English) ............................................
//     "lang 'fr' did not reach the commit prompt — the message is a deliverable in the project's language"
//   APPROVE set reduced to 'APPROVED' ................................................................
//     "the project's bridge answered APROBADO and the loop read it as a rejection"
check('develop-phase loop honours every wrapper config key a fork used to hard-code', () => {
  const harness = (file) => {
    const src = require('fs').readFileSync(file, 'utf8').replace(/^export /m, '');
    const AsyncFn = Object.getPrototypeOf(async function () {}).constructor;
    const pf = { exitCode: 0, skipped: [], failedCheck: null, tail: '' };
    const run = async (args, seat) => {
      const calls = [];
      const agent = async (prompt, o) => { calls.push({ ...o, prompt }); return seat(String(o.label)); };
      const out = await new AsyncFn('args', 'agent', 'log', 'phase', src)(args, agent, () => {}, () => {});
      return { out, calls, by: (p) => calls.find((c) => c.label.startsWith(p)) };
    };
    const ok = (l) => (l === 'preflight' ? pf : l === 'commit' ? { committed: true, hash: 'abc123', message: 'feat: x', note: '' }
      : l.startsWith('review') ? { output: '[PASS] a — x\nAPROBADO' } : l === 'scout' ? 'BRIEF' : l === 'analyst' ? 'PLAN' : 'impl');
    const CFG = {
      task: 'T', maxIter: 1, lang: 'fr', preflight: 'pnpm preflight',
      models: { scout: 'haiku', analyst: 'opus', implementer: 'opus', reviewer: 'openrouter/xiaomi/mimo-v2.6-pro' },
      agentTypes: { scout: 'Explore', implementer: 'implementer' },
      context: ['STATUS.md', 'docs/client-context/'],
      forbidden: ['wrangler deploy', 'pnpm deploy*'],
      implementerRules: ['Read ~/.agents/skills/ponytail/SKILL.md first.'],
      externalReview: 'scripts/revue-externe.sh',
      commit: true, commitRules: ['No Co-Authored-By line.'], integrate: 'scripts/integrer.sh',
    };
    (async () => {
      const r = await run(CFG, ok);
      const off = await run({ ...CFG, commit: false }, ok);
      const red = await run(CFG, (l) => (l === 'preflight' ? { ...pf, exitCode: 1, failedCheck: 'test' } : ok(l)));
      const noGit = await run({ ...CFG, commit: false, integrate: undefined, doneStep: 'keep the backups in data-ouputs/' }, ok);
      const withPrd = await run({ ...CFG, prd: 'docs/prds/PRD-007-x.md', analystRules: ['Name the negative guard.'] }, ok);
      console.log(JSON.stringify({
        approved: r.out.approved && r.out.handoff.status === 'complete',
        lang: /in French/.test((r.by('commit') || {}).prompt) && /No Co-Authored-By line\./.test((r.by('commit') || {}).prompt),
        staging: [/git add -- </.test((r.by('commit') || {}).prompt), ((r.by('commit') || {}).prompt || '').replace(/NEVER[^\n]*/, '').includes('git add -A'), ((r.by('commit') || {}).prompt || '').includes("IMPLEMENTER'S REPORT:\nimpl")],
        bridge: r.by('review').prompt.includes('scripts/revue-externe.sh openrouter/xiaomi/mimo-v2.6-pro'),
        preflight: r.by('preflight').prompt.includes('pnpm preflight; echo'),
        types: [r.by('scout').agentType, r.by('impl').agentType, r.by('analyst').agentType ?? null],
        forbidden: /FORBIDDEN, never run: wrangler deploy, pnpm deploy\*/.test(r.by('impl').prompt) && r.by('impl').prompt.includes('ponytail'),
        context: r.by('scout').prompt.includes('STATUS.md, docs/client-context/'),
        integrate: r.out.nextStep.includes('committed abc123, then scripts/integrer.sh'),
        noCommit: [off.calls.some((c) => c.label === 'commit'), red.calls.some((c) => c.label === 'commit')],
        doneStep: noGit.out.nextStep.endsWith('keep the backups in data-ouputs/') && !/git add/.test(noGit.out.nextStep),
        prdWithContext: withPrd.by('scout').prompt.includes('docs/client-context/, docs/prds/PRD-007-x.md'),
        analystRules: withPrd.by('analyst').prompt.includes('Name the negative guard.'),
      }));
    })().catch((e) => console.log('THREW ' + e.message));
  };
  const out = execFileSync('node', ['-e', `(${harness})(process.argv[1])`, path.join(ROOT, DEVELOP_PHASE)], { encoding: 'utf8' }).trim();
  if (out.startsWith('THREW')) throw new Error(`the loop throws under the pilot's config — ${out.slice(6)}`);
  const r = JSON.parse(out);
  const want = {
    approved: [true, "the project's bridge answered APROBADO and the loop read it as a rejection"],
    lang: [true, "lang 'fr' did not reach the commit prompt — the message is a deliverable in the project's language"],
    staging: [[true, false, true], "the commit seat may sweep the user's uncommitted work: it must stage the implementer's files by name, never git add -A"],
    bridge: [true, 'externalReview did not replace the bridge path'],
    preflight: [true, "the project's preflight command did not reach the preflight seat"],
    types: [['Explore', 'implementer', null], 'agentTypes did not reach the seats (or leaked to one it does not name)'],
    forbidden: [true, 'forbidden or implementerRules did not reach the implementer'],
    context: [true, "context did not reach the scout's reading list"],
    integrate: [true, 'integrate is missing from nextStep after a commit'],
    noCommit: [[false, false], 'the commit seat ran with commit:false or after a red preflight'],
    doneStep: [true, 'doneStep did not replace the git advice for a project whose code git does not track'],
    prdWithContext: [true, "a per-run prd was dropped because the project sets context — the seats never saw this run's spec"],
    analystRules: [true, 'analystRules did not reach the analyst'],
  };
  for (const [k, [v, why]] of Object.entries(want)) {
    if (JSON.stringify(r[k]) !== JSON.stringify(v)) throw new Error(`${why} (got ${JSON.stringify(r[k])})`);
  }
  return 'lang · bridge verdict in the project\'s language · externalReview · preflight · agentTypes · forbidden · context · commit only when green, staging the run\'s files by name · integrate · doneStep';
});

// The wrapper is the one file the audit writes into every project, and the only route to the loop.
// workflow() does not expand `~` (probed 2026-10-10: "Workflow script file not found: ~/…"), so the
// wrapper names the copy by absolute path and falls back to the plugin's workflow by name. Only "not
// there" may fall through: a loop that fails inside must not be started a second time.
//
// Negative control (2026-10-10, reverted): the catch made unconditional — exit 1, "an error from inside
// the loop fell through to the next route — the seats would run twice".
// routeByJev hands the implementer's model to a classifier, and the corpus showed the dangerous error is
// the downgrade (opus work called haiku at p=0.99). So jev.js decideTier() caps it — one tier at most,
// never below sonnet — and the loop keeps the line-up, with the reason written down, on everything else: a
// confidence under the measured threshold, a tier the seat relays outside those rules, a tier that would make
// the reviewer review its own family, a dead seat, no key. The rules run as a pure function, the loop with
// stub seats, the CLI against the mock.
//
// Negative controls (2026-10-10 and 2026-10-11, each applied, observed, reverted — all exit 1):
//   the D25a clause dropped from the routing decision ................................................
//     "a routed fable implementer shares the reviewer's family — D25a outranks the router (got ["fable",false])"
//   decideTier() without the sonnet floor ...........................................................
//     "decideTier(sonnet ← haiku p=0.9): implementer sonnet, Jev haiku — got haiku, want null: never below sonnet"
check('develop-phase routeByJev: a downgrade goes one tier at most and never below sonnet, only at or above the threshold, never into the reviewer\'s family, and the run records why', () => {
  const cli = path.join(ROOT, 'plugins/harness-loops/scripts/jev.js');
  const { decideTier, ROUTE_TIER_THRESHOLD: T } = require(cli);
  const rules = [
    ['opus', 'haiku', 0.99, 'sonnet', 'one tier down at most'],
    ['opus', 'sonnet', 0.95, 'sonnet', 'a one-tier downgrade above the threshold'],
    ['sonnet', 'haiku', 0.9, null, 'never below sonnet'],
    ['fable', 'haiku', 0.95, 'opus', 'one tier down at most'],
    ['opus', 'fable', 0.95, 'fable', 'an upgrade is not capped'],
    ['opus', 'sonnet', 0.5, null, 'under the threshold nothing moves'],
    ['claude-opus-5-5', 'haiku', 0.95, 'sonnet', 'a full model id is read as its tier'],
    ['openrouter/acme/model-x', 'sonnet', 0.95, null, 'no Claude tier to route from'],
  ];
  for (const [configured, suggested, p, want, why] of rules) {
    const got = decideTier({ configured, suggested, p, threshold: 0.8 }).tier;
    if (got !== want) throw new Error(`decideTier(${configured} ← ${suggested} p=${p}): implementer ${configured}, Jev ${suggested} — got ${got}, want ${want}: ${why}`);
  }
  if (decideTier({ configured: 'opus', suggested: 'sonnet', p: 0.99, threshold: null }).tier !== null) throw new Error('with no measured threshold decideTier still routed');
  const harness = (file) => {
    const src = require('fs').readFileSync(file, 'utf8').replace(/^export /m, '');
    const AsyncFn = Object.getPrototypeOf(async function () {}).constructor;
    const pf = { exitCode: 0, skipped: [], failedCheck: null, tail: '' };
    const run = async (args, route) => {
      const calls = [];
      const agent = async (prompt, o) => {
        calls.push({ label: String(o.label), model: o.model, prompt });
        const l = String(o.label);
        return l === 'route' ? route : l === 'preflight' ? pf : l.startsWith('review') ? '[PASS] a — x\nAPPROVED' : l === 'scout' ? 'B' : l === 'analyst' ? 'P' : 'impl';
      };
      const out = await new AsyncFn('args', 'agent', 'log', 'phase', src)({ task: 'T', maxIter: 1, routeByJev: true, ...args }, agent, () => {}, () => {});
      return { r: out.routing, impl: (calls.find((c) => c.label.startsWith('impl')) || {}).model, calls };
    };
    const ok = { enabled: true, suggested: 'haiku', p: 0.99, threshold: 0.8, tier: 'sonnet', reason: 'p=0.99 ≥ 0.8: haiku → sonnet (one tier down at most)', error: null };
    (async () => {
      const routed = await run({}, ok);
      const kept = await run({}, { ...ok, suggested: 'sonnet', p: 0.7, tier: null, reason: 'p=0.7 < threshold 0.8' });
      const relayed = await run({}, { ...ok, tier: 'haiku' });
      const family = await run({}, { ...ok, suggested: 'fable', tier: 'fable', reason: 'p=0.99 ≥ 0.8: fable' });
      const dead = await run({}, null);
      const off = await run({}, { ...ok, enabled: false, suggested: null, p: null, tier: null, reason: null, error: 'Jev off (no TYPESAFE_API_KEY)' });
      const unset = await run({ routeByJev: undefined }, ok);
      const custom = await run({ jevScript: '/opt/jev.js', task: 'two\nlines', models: { implementer: 'claude-opus-5-5' } }, ok);
      console.log(JSON.stringify({
        routed: [routed.impl, routed.r.decision, routed.r.configured, routed.r.suggested, /one tier down/.test(routed.r.reason), routed.calls[0].label, routed.calls[0].model],
        kept: [kept.impl, kept.r.decision, kept.r.reason],
        relayed: [relayed.impl, /outside jev\.js's rules/.test(relayed.r.reason)],
        family: [family.impl, /reviewer's family/.test(family.r.reason)],
        dead: [dead.impl, dead.r.decision],
        off: [off.impl, off.r.reason],
        unset: [unset.r, unset.calls.some((c) => c.label === 'route')],
        prompt: [custom.calls[0].prompt.includes("node /opt/jev.js route --configured claude-opus-5-5 <<'JEV_TASK_END'\ntwo\nlines\nJEV_TASK_END")],
      }));
    })().catch((e) => console.log('THREW ' + e.message));
  };
  const out = execFileSync('node', ['-e', `(${harness})(process.argv[1])`, path.join(ROOT, DEVELOP_PHASE)], { encoding: 'utf8' }).trim();
  if (out.startsWith('THREW')) throw new Error(`the develop-phase loop throws with routeByJev — ${out.slice(6)}`);
  const r = JSON.parse(out);
  const want = {
    routed: [['sonnet', 'jev', 'opus', 'haiku', true, 'route', 'haiku'], "jev.js's capped tier did not reach the implementer, or the route seat is not the first, haiku seat"],
    kept: [['opus', 'lineup', 'p=0.7 < threshold 0.8'], "a tier jev.js kept did not keep the line-up with jev.js's reason"],
    relayed: [['opus', true], 'a seat relaying haiku past the sonnet floor routed the implementer'],
    family: [['opus', true], "a routed fable implementer shares the reviewer's family — D25a outranks the router"],
    dead: [['opus', 'lineup'], 'a dead route seat did not fall back to the line-up'],
    off: [['opus', 'Jev off (no TYPESAFE_API_KEY)'], 'without a key the run did not keep the line-up and say why'],
    unset: [[null, false], 'routeByJev unset still ran the route seat — it is opt-in'],
    prompt: [[true], 'the route seat does not pass the configured implementer and the task on stdin to the configured jev.js'],
  };
  for (const [k, [v, why]] of Object.entries(want)) {
    if (JSON.stringify(r[k]) !== JSON.stringify(v)) throw new Error(`${why} (got ${JSON.stringify(r[k])})`);
  }
  const parse = (x) => { try { return JSON.parse(x.out); } catch { throw new Error(`jev.js route printed no JSON: ${x.out} ${x.err}`); } };
  const offCli = parse(runNode([cli, 'route', '--configured', 'opus'], jevEnv().env, 'rename the constant'));
  if (offCli.enabled !== false || !/Jev off/.test(offCli.error)) throw new Error(`jev.js route without a key: ${JSON.stringify(offCli)}`);
  const onCli = parse(runNode([cli, 'route', '--configured', 'opus'], jevEnv({ JEV_MOCK_FILE: jevMock('mock-router.json') }).env, 'rename the constant'));
  if (onCli.suggested !== 'sonnet' || onCli.p !== 0.62 || onCli.threshold !== T || onCli.tier !== (0.62 >= T ? 'sonnet' : null)) throw new Error(`jev.js route with the mock: ${JSON.stringify(onCli)}`);
  if (runNode([cli, 'route'], jevEnv().env, 'x').code !== 1) throw new Error('jev.js route without --configured did not refuse — the caps need the configured tier');
  return `caps: one tier down, sonnet floor, upgrades free · threshold ${T} · relayed haiku, reviewer's family, dead seat, no key → line-up with the reason · opt-in`;
});

check('develop-phase wrapper: config + per-run args reach the loop, a missing copy falls back, an inner error does not', () => {
  const tpl = read('plugins/harness-audit/skills/harness-audit/develop-phase-wrapper.js');
  const left = tpl.match(/__[A-Z]+__/g) || [];
  for (const ph of ['__LANG__', '__PREFLIGHT__', '__MODELS__', '__CONTEXT__', '__FORBIDDEN__', '__HOME__']) {
    if (!left.includes(ph)) throw new Error(`the wrapper template lost its ${ph} placeholder — SKILL.md Step 4b tells the audit to fill it`);
  }
  const src = tpl.replace('__LANG__', 'fr').replace('__PREFLIGHT__', 'pnpm preflight')
    .replace('__MODELS__', "{ reviewer: 'fable', implementer: 'opus' }").replace('__CONTEXT__', "['STATUS.md']")
    .replace('__FORBIDDEN__', "['wrangler deploy']").replace('__HOME__', '/home/u').replace(/^export /m, '');
  if (/__[A-Z]+__/.test(src)) throw new Error(`the wrapper template has an undocumented placeholder: ${src.match(/__[A-Z]+__/)[0]}`);
  const harness = (code) => {
    const AsyncFn = Object.getPrototypeOf(async function () {}).constructor;
    const run = async (args, impl) => {
      const tried = [];
      const workflow = async (ref, a) => { tried.push(typeof ref === 'string' ? ref : ref.scriptPath); return impl(ref, a, tried.length); };
      try { return { out: await new AsyncFn('args', 'workflow', code)(args, workflow), tried }; }
      catch (e) { return { threw: e.message, tried }; }
    };
    const notFound = (ref) => { throw new Error(typeof ref === 'string' ? `workflow('${ref}'): no workflow with that name` : `Workflow script file not found: ${ref.scriptPath}`); };
    (async () => {
      const direct = await run({ task: 'T', models: { reviewer: 'openrouter/x/y' } }, (ref, a) => a);
      const str = await run('just a task', (ref, a) => a);
      const json = await run('{"task": "from json", "maxIter": 2}', (ref, a) => a);
      const fallback = await run({ task: 'T' }, (ref, a, n) => (n === 1 ? notFound(ref) : { via: ref }));
      const unreadable = (ref) => { throw new Error(`workflow({scriptPath: '${ref.scriptPath}'}): scriptPath must be a script path this tool returned, or a file you can already read (the working directory or a directory you have added)`); };
      const outside = await run({ task: 'T' }, (ref, a, n) => (n < 3 ? (n === 1 ? notFound(ref) : unreadable(ref)) : { via: ref }));
      const none = await run({ task: 'T' }, notFound);
      const inner = await run({ task: 'T' }, () => { throw new Error('agent crashed inside the loop'); });
      console.log(JSON.stringify({
        merged: [direct.out.lang, direct.out.preflight, direct.out.task, direct.out.models.reviewer, direct.out.models.implementer, direct.out.forbidden[0]],
        path: direct.tried,
        str: str.out.task,
        json: [json.out.task, json.out.maxIter],
        fallback: [fallback.out && fallback.out.via && fallback.out.via.scriptPath, fallback.tried.length],
        outside: [outside.out && outside.out.via, outside.tried.length],
        none: none.out && none.out.handoff.status,
        inner: [Boolean(inner.threw), inner.tried.length],
      }));
    })().catch((e) => console.log('THREW ' + e.message));
  };
  const out = execFileSync('node', ['-e', `(${harness})(${JSON.stringify(src)})`], { encoding: 'utf8' }).trim();
  if (out.startsWith('THREW')) throw new Error(`the wrapper throws — ${out.slice(6)}`);
  const r = JSON.parse(out);
  const want = {
    merged: [['fr', 'pnpm preflight', 'T', 'openrouter/x/y', 'opus', 'wrangler deploy'], 'config and per-run args are not merged (run args win, models merge key by key)'],
    path: [['.claude/harness/develop-phase.js'], "the first route is not the project's own copy — the only one every session can read"],
    str: ['just a task', 'a string arg did not become the task'],
    json: [['from json', 2], 'args passed as a JSON string were read as the task instead of as args'],
    fallback: [['/home/u/.claude/harness/develop-phase.js', 2], 'a missing project copy did not fall back to the copy under $HOME'],
    outside: [['harness-loops:develop-phase', 3], 'a copy the session may not read did not fall back to the plugin workflow'],
    none: ['blocked', 'with neither route the wrapper did not return a blocked handoff'],
    inner: [[true, 1], 'an error from inside the loop fell through to the next route — the seats would run twice'],
  };
  for (const [k, [v, why]] of Object.entries(want)) {
    if (JSON.stringify(r[k]) !== JSON.stringify(v)) throw new Error(`${why} (got ${JSON.stringify(r[k])})`);
  }
  return 'placeholders documented · run args override config · project copy, then $HOME copy, then plugin name · falls through on not-found and on unreadable · blocked when none · inner error never retried';
});

check('sync-workflows keeps the stable copy equal to the shipped loop, and only rewrites it when it differs', () => {
  const hook = path.join(ROOT, 'plugins/harness-loops/scripts/hooks/sync-workflows.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-sync-'));
  const env = { PATH: process.env.PATH, HOME: dir, HARNESS_WORKFLOWS_DIR: path.join(dir, 'harness') };
  const start = read('scripts/fixtures/hooks/session-start.json');
  const target = path.join(dir, 'harness', 'develop-phase.js');
  try {
    execFileSync('node', [hook], { input: start, env, stdio: 'pipe' });
    if (fs.readFileSync(target, 'utf8') !== read(DEVELOP_PHASE)) throw new Error('first session start did not copy the loop');
    if (fs.readFileSync(path.join(dir, 'harness', 'jev.js'), 'utf8') !== read('plugins/harness-loops/scripts/jev.js')) {
      throw new Error("jev.js was not copied next to the loop — routeByJev's seat runs ~/.claude/harness/jev.js");
    }
    const before = fs.statSync(target).mtimeMs;
    execFileSync('node', [hook], { input: start, env, stdio: 'pipe' });
    if (fs.statSync(target).mtimeMs !== before) throw new Error('an identical copy was rewritten — every session start would touch it');
    fs.writeFileSync(target, '// stale');
    execFileSync('node', [hook], { input: start, env, stdio: 'pipe' });
    if (fs.readFileSync(target, 'utf8') !== read(DEVELOP_PHASE)) throw new Error('a stale copy was not replaced — a plugin update would never reach the projects');
    const leftovers = fs.readdirSync(path.join(dir, 'harness')).filter((f) => f.endsWith('.tmp'));
    if (leftovers.length) throw new Error(`temp files left behind: ${leftovers.join(', ')}`);
    const out = execFileSync('node', [hook], { input: read('scripts/fixtures/hooks/other-event.json'), env, encoding: 'utf8' });
    if (out !== '') throw new Error('the hook printed something — it must stay silent');
    // A project whose develop-phase is a wrapper gets its own copy (the one every session may read), ignored by git.
    const proj = path.join(dir, 'proj');
    const plain = path.join(dir, 'plain');
    fs.mkdirSync(path.join(proj, '.claude', 'workflows'), { recursive: true });
    fs.mkdirSync(path.join(plain, '.claude', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(proj, '.claude', 'workflows', 'develop-phase.js'), 'for (const ref of GLOBAL) { await workflow(ref, merged) }');
    fs.writeFileSync(path.join(plain, '.claude', 'workflows', 'develop-phase.js'), '// a fork: the loop itself');
    for (const cwd of [proj, plain]) {
      execFileSync('node', [hook], { input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', cwd }), env, stdio: 'pipe' });
    }
    if (fs.readFileSync(path.join(proj, '.claude', 'harness', 'develop-phase.js'), 'utf8') !== read(DEVELOP_PHASE)) throw new Error('a project with a wrapper got no copy of the loop it can read');
    if (!/^\*$/m.test(fs.readFileSync(path.join(proj, '.claude', 'harness', '.gitignore'), 'utf8'))) throw new Error("the project copy is not ignored by git — someone's git add -A would commit it");
    if (fs.existsSync(path.join(plain, '.claude', 'harness'))) throw new Error('a project without a wrapper got a copy it never asked for');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return 'copies on first start · leaves an identical copy alone · replaces a stale one · atomic · silent · project copy only behind a wrapper, git-ignored';
});

// The dedupe's thresholds were chosen, not measured; the eval is what measures them. Offline this
// asserts the eval's own arithmetic: a corpus that stays well-formed and balanced, exit 3 without a
// key (nothing measured is not a pass), a classifier that carries everything → exit 1 naming the
// hidden new blockers, one that carries nothing → exit 0 with the missed restatements listed.
//
// Negative controls (2026-09-22, each applied, observed, reverted — all exit 1):
//   the eval's bar() stripped of the blocker rule ..................................................
//     "at p=0.90 the eval carried a new blocker — it lost the 0.95 blocker bar loop-gate applies"
//   two corpus cases put on the same critic + file .................................................
//     "corpus invalid: cases[26] (c27) shares critic + file with another case"
check('jev dedupe eval: corpus balanced, exit 3 without a key, exit 1 when a new blocker is hidden', () => {
  const script = path.join(ROOT, 'benchmarks/jev_dedupe_eval.js');
  mustExist('benchmarks/jev_dedupe_eval.js');
  mustExist('benchmarks/jev-dedupe/corpus.json');
  const { validateCorpus } = require(script);
  const corpus = JSON.parse(read('benchmarks/jev-dedupe/corpus.json'));
  const errors = validateCorpus(corpus);
  if (errors.length) throw new Error(`corpus invalid: ${errors[0]}`);
  const restated = corpus.cases.filter((c) => c.restates !== null);
  const fresh = corpus.cases.filter((c) => c.restates === null);
  if (restated.length < 10 || fresh.length < 10) throw new Error(`corpus too lopsided to measure both errors: ${restated.length} restated / ${fresh.length} new (need ≥10 each)`);
  const newBlockers = fresh.filter((c) => c.current.severity === 'blocker').length;
  if (newBlockers < 4) throw new Error(`only ${newBlockers} new blockers — the error that matters needs ≥4 chances to happen`);
  const off = runNode([script], jevEnv().env);
  if (off.code !== 3 || !/NOT MEASURED/.test(off.out)) throw new Error(`without a key the eval exited ${off.code}: ${off.out.trim()}`);
  const all = runNode([script], jevEnv({ JEV_MOCK_FILE: jevMock('mock-noul.json') }).env);
  if (all.code !== 1 || !/VERDICT: FAIL/.test(all.out) || !/c04 blocker/.test(all.out)) throw new Error(`a classifier that carries everything did not fail the eval: exit ${all.code}`);
  // p = 0.90 everywhere sits between the two bars: every non-blocker is carried, no blocker is. If the
  // eval ever drops the blocker bar, c04 shows up in the hidden list.
  const mid = runNode([script], jevEnv({ JEV_MOCK_FILE: jevMock('mock-090.json') }).env);
  if (mid.code !== 1 || !/c05 major/.test(mid.out)) throw new Error(`at p=0.90 the eval did not hide the new majors it should: exit ${mid.code}`);
  if (/c04 blocker|c06 blocker|c12 blocker/.test(mid.out)) throw new Error('at p=0.90 the eval carried a new blocker — it lost the 0.95 blocker bar loop-gate applies');
  const none = runNode([script], jevEnv({ JEV_MOCK_FILE: jevMock('mock-dedupe.json') }).env);
  if (none.code !== 0 || !/VERDICT: PASS/.test(none.out) || !/MISSED at loop-gate/.test(none.out)) throw new Error(`a classifier that carries nothing did not pass with its misses listed: exit ${none.code}`);
  return `${corpus.cases.length} cases (${restated.length} restated / ${fresh.length} new, ${newBlockers} new blockers) · off → 3 · carry-all → 1 · p=0.90 hides majors, never blockers · carry-none → 0`;
});

check('jev dedupe eval — live, against api.typesafe.ai', () => {
  if (process.env.JEV_LIVE !== '1') skip('set JEV_LIVE=1 (and a TYPESAFE_API_KEY) to measure the dedupe thresholds live');
  if (!require(path.join(ROOT, 'plugins/harness-loops/scripts/jev.js')).isEnabled()) skip('no TYPESAFE_API_KEY — nothing to measure');
  const r = runNode([path.join(ROOT, 'benchmarks/jev_dedupe_eval.js')], process.env);
  const verdict = (r.out.match(/^VERDICT: .*$/m) || [''])[0];
  if (r.code !== 0) throw new Error(verdict || `eval exited ${r.code}: ${r.err.trim()}`);
  return verdict.replace(/^VERDICT: /, '');
});

// The router eval decides whether routeByJev may act, so its arithmetic is pinned offline: the corpus stays
// labelled against the frozen skill snapshot and wide enough to measure every tier; without a key it
// measures nothing (exit 3); it always runs two passes; a mock that answers "sonnet, p=0.62" to everything
// scores exactly the sonnet rows and is not routable. The threshold is the CUMULATIVE reading — the lowest
// cut-off whose kept predictions (≥ MIN_N) reach 0.9 together, the decision "route everything above p" —
// and two passes combine to the higher one. Downgrades replay jev.js decideTier(), and no downgrade at all
// (fewer than MIN_N) is no evidence for routing.
//
// Negative control (2026-10-11, applied, observed, reverted — exit 1):
//   sweep() back to the holds-from-there-on reading (threshold = holdThreshold) .........................
//     "the threshold is not the cumulative one — 'route everything above p' keeps 37/39 at 0.4 (got none)"
check('jev router eval: corpus labelled against the snapshot, two passes, cumulative threshold, capped downgrades scored', () => {
  const script = path.join(ROOT, 'benchmarks/jev_router_eval.js');
  for (const f of ['benchmarks/jev_router_eval.js', 'benchmarks/fixtures/router_corpus.jsonl', 'benchmarks/fixtures/router_skills.json']) mustExist(f);
  const { readCorpus, validate: validateCorpus, sweep, downgrades, combine, evaluate } = require(script);
  const rows = readCorpus(path.join(ROOT, 'benchmarks/fixtures/router_corpus.jsonl'));
  const errors = validateCorpus(rows, JSON.parse(read('benchmarks/fixtures/router_skills.json')));
  if (errors.length) throw new Error(`corpus invalid: ${errors[0]}`);
  const tiers = Object.fromEntries(Object.keys(require(path.join(ROOT, 'plugins/harness-loops/scripts/jev.js')).TIERS).map((t) => [t, rows.filter((r) => r.tier === t).length]));
  if (Object.values(tiers).some((n) => n < 10)) throw new Error(`a tier has fewer than 10 rows: ${JSON.stringify(tiers)}`);
  const withSkill = rows.filter((r) => r.skill !== 'none').length;
  if (withSkill < 15 || rows.length - withSkill < 15) throw new Error(`skill/none too lopsided: ${withSkill}/${rows.length - withSkill}`);
  const off = runNode([script], jevEnv().env);
  if (off.code !== 3 || !/NOT MEASURED/.test(off.out)) throw new Error(`without a key the eval exited ${off.code}: ${off.out.trim()}`);
  const mock = runNode([script], jevEnv({ JEV_MOCK_FILE: jevMock('mock-router.json') }).env);
  const sonnet = ((100 * tiers.sonnet) / rows.length).toFixed(1);
  if (mock.code !== 1 || !mock.out.includes(`× 2 passes`) || !mock.out.includes(`TIER top-1 ${sonnet}% [${sonnet}%–${sonnet}%]`) || !/VERDICT: NOT ROUTABLE/.test(mock.out)) {
    throw new Error(`a mock that always answers sonnet did not score ${sonnet}% over two passes and stay unroutable: exit ${mock.code} ${mock.out.split('\n')[1] || mock.err.trim()}`);
  }
  const mk = (spec, label = 'opus') => {
    const rs = []; const ps = [];
    for (const [n, p, right] of spec) for (let i = 0; i < n; i++) { rs.push({ tier: label }); ps.push({ tier: { choice: right ? label : 'haiku', p } }); }
    return [rs, ps];
  };
  // a: 5 wrong at 0.35, 10 right at 0.5, 9 right at 0.97, 1 wrong at 0.995 → 0.3 keeps 19/25, 0.4 keeps 19/20.
  // b: 5 wrong at 0.35, 30 right at 0.5, 7 right and 2 wrong at 0.97 → 0.4 keeps 37/39 (95%), yet 0.6 and up
  //    keep 7/9: cumulative 0.4, holds-from-there-on none. c: only 4 predictions ever clear 0.4 → none.
  const th = (spec) => sweep(...mk(spec), 'tier', false);
  const a = th([[5, 0.35, false], [10, 0.5, true], [9, 0.97, true], [1, 0.995, false]]);
  const b = th([[5, 0.35, false], [30, 0.5, true], [7, 0.97, true], [2, 0.97, false]]);
  const c = th([[10, 0.35, false], [4, 0.995, true]]);
  if (!a.threshold || a.threshold.t !== 0.4) throw new Error(`19 of 20 right from 0.4 up gave threshold ${a.threshold && a.threshold.t}, expected 0.4`);
  if (!b.threshold || b.threshold.t !== 0.4) throw new Error(`the threshold is not the cumulative one — 'route everything above p' keeps 37/39 at 0.4 (got ${b.threshold ? b.threshold.t : 'none'})`);
  if (b.holdThreshold !== null) throw new Error('the holds-from-there-on reading accepted a cut-off that drops to 78% above it');
  if (c.threshold !== null) throw new Error(`a cut-off with fewer than MIN_N predictions vouched for routing (${c.threshold.t})`);
  // Downgrades from opus at threshold 0.8: haiku→sonnet on a haiku task (right), haiku→sonnet on an opus task
  // (wrong), sonnet on a sonnet task (right); under the threshold, the configured tier and an upgrade are not scored.
  const dRows = ['haiku', 'opus', 'sonnet', 'opus', 'fable', 'opus'].map((tier, i) => ({ id: `d${i}`, tier }));
  const dPreds = [['haiku', 0.9], ['haiku', 0.99], ['sonnet', 0.85], ['sonnet', 0.7], ['fable', 0.9], ['opus', 0.95]].map(([choice, p]) => ({ tier: { choice, p } }));
  const d = downgrades(dRows, dPreds, 0.8);
  if (d.decisions !== 3 || d.right !== 2 || d.upgrades !== 1 || d.wrong[0].id !== 'd1') throw new Error(`downgrade replay wrong: ${JSON.stringify({ decisions: d.decisions, right: d.right, upgrades: d.upgrades })}`);
  // Two passes: thresholds 0.4 and 0.5 combine to 0.5; all-sonnet tasks routed down from opus → routable.
  // A corpus Jev reads perfectly but never downgrades has no evidence for the caps → not routable.
  const pass = (spec, label) => {
    const [rs, ps] = mk(spec, label);
    const full = rs.map((r, i) => ({ ...r, id: `x${i}`, skill: 'none' }));
    return [full, evaluate(full, { none: 'x' }, ps.map((p) => ({ ...p, skill: { choice: 'none', p: 1 }, ms: 1 })))];
  };
  const [r1, e1] = pass([[5, 0.35, false], [20, 0.5, true]], 'sonnet');
  const [, e2] = pass([[5, 0.45, false], [20, 0.55, true]], 'sonnet');
  const both = combine(r1, [e1, e2]);
  if (both.threshold !== 0.5 || !both.routable) throw new Error(`two passes at 0.4 and 0.5 gave threshold ${both.threshold}, routable ${both.routable} — want 0.5, routable`);
  const [r3, e3] = pass([[20, 0.9, true]], 'opus');
  if (combine(r3, [e3, e3]).routable) throw new Error('no downgrade at all counted as evidence that downgrades are safe');
  return `${rows.length} prompts (${Object.entries(tiers).map(([t, n]) => `${t} ${n}`).join(' / ')} · ${withSkill} with a skill) · off → 3 · always-sonnet → ${sonnet}% ×2, not routable · cumulative threshold, higher pass wins · downgrades replayed`;
});

check('jev router eval — live, against api.typesafe.ai', () => {
  if (process.env.JEV_LIVE !== '1') skip('set JEV_LIVE=1 (and a TYPESAFE_API_KEY) to measure the router live');
  if (!require(path.join(ROOT, 'plugins/harness-loops/scripts/jev.js')).isEnabled()) skip('no TYPESAFE_API_KEY — nothing to measure');
  const r = runNode([path.join(ROOT, 'benchmarks/jev_router_eval.js')], process.env);
  const verdict = (r.out.match(/^VERDICT: .*$/m) || [''])[0];
  if (r.code === 2 || r.code === 3 || !verdict) throw new Error(verdict || `eval exited ${r.code}: ${r.err.trim()}`);
  return verdict.replace(/^VERDICT: /, '');
});

// develop-phase-pi.js holds the loop in code, so the loop is tested with a fake `pi` on PATH that answers
// per seat (HARNESS_SEAT) — no network, no model. Four runs: a clean pass that commits, a same-family
// line-up refused before any seat, an analyst BLOQUEO that stops before the implementer, and a gate that
// exits 0 with a SKIP line, which must not count as a pass.
check('develop-phase-pi: loop in code — pass commits, D25a refuses, BLOQUEO stops, SKIP is not a PASS', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-pi-'));
  const bin = path.join(tmp, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'pi'), `#!/bin/sh
case "$HARNESS_SEAT" in
  scout) echo "brief: sum.js:1" ;;
  analyst) if [ -n "$FAKE_BLOCK" ]; then echo "BLOQUEO: falta decidir"; else echo "1. sum.js"; fi ;;
  implementer-*) echo "module.exports = 2;" > sum.js; echo "sum.js cambiado" ;;
  reviewer-*) printf '[PASS] a — x\\n**APROBADO**\\n' ;;
  commit) echo "fix: ajusta sum" ;;
esac
`, { mode: 0o755 });
  const lineup = (reviewer) => {
    const f = path.join(tmp, `lineup-${reviewer}.json`);
    const e = (model) => ({ provider: 'fake', model });
    fs.writeFileSync(f, JSON.stringify({ version: 1, defaults: {}, harness: { pi: {
      scout: e('scout-1'), architect: e('arch-1'), orchestrator: e('orch-1'), implementer: e('impl-1'), reviewer: e(reviewer),
    } } }));
    return f;
  };
  const repo = (name) => {
    const d = path.join(tmp, name);
    fs.mkdirSync(d);
    execFileSync('sh', ['-c', 'git init -q && echo "module.exports = 1;" > sum.js && git add -A && git -c user.email=t@t -c user.name=t commit -qm init'], { cwd: d });
    return d;
  };
  const run = (name, { reviewer = 'rev-1', preflight = 'true', env = {} } = {}) => {
    const cwd = repo(name);
    const r = require('node:child_process').spawnSync('node', [path.join(ROOT, 'plugins/harness-loops/scripts/develop-phase-pi.js'), '--task', 't', '--max-iter', '1', '--no-jev', '--no-tmux', '--preflight', preflight], {
      cwd, encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, MODEL_LINEUP_PATH: lineup(reviewer), GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', ...env },
    });
    let out = null;
    try { out = JSON.parse(r.stdout); } catch { /* refused runs print no JSON */ }
    return { code: r.status, out, err: r.stderr, log: execFileSync('git', ['log', '--oneline'], { cwd, encoding: 'utf8' }).trim().split('\n') };
  };
  const pass = run('pass');
  if (pass.code !== 0 || pass.out.handoff.status !== 'complete' || !pass.out.commit.committed || pass.log[0].indexOf('fix: ajusta sum') === -1) {
    throw new Error(`clean run did not complete and commit: exit ${pass.code} ${pass.err.slice(-300)}`);
  }
  const fam = run('family', { reviewer: 'impl-2' });
  if (fam.code !== 2 || fam.out || !/D25a|family/.test(fam.err)) throw new Error(`same-family reviewer not refused: exit ${fam.code}`);
  const cl = run('claude', { reviewer: 'claude-fable-5' });
  if (cl.code !== 2 || cl.out || !/non-Claude/.test(cl.err)) throw new Error(`a Claude seat on Pi was not refused: exit ${cl.code}`);
  const block = run('block', { env: { FAKE_BLOCK: '1' } });
  if (block.code !== 1 || block.out.handoff.status !== 'blocked' || block.out.iterations !== 0) throw new Error('BLOQUEO did not stop before the implementer');
  const skipRun = run('skip', { preflight: 'echo "SKIP notion:verify"; exit 0' });
  if (skipRun.code !== 1 || skipRun.out.preflightPassed || skipRun.out.commit || skipRun.out.handoff.status !== 'continue') throw new Error('exit 0 with a SKIP line counted as a pass');
  fs.rmSync(tmp, { recursive: true, force: true });
  return 'pass → complete + commit · same family → exit 2 · BLOQUEO → blocked at 0 iter · SKIP → continue, no commit';
});

const GLYPH = { pass: '✓', fail: '✗', skip: '⊘' };
let failed = 0, skipped = 0;
for (const r of results) {
  if (r.state === 'fail') failed++;
  if (r.state === 'skip') skipped++;
  console.log(`${GLYPH[r.state]} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
}
const passed = results.length - failed - skipped;
console.log(`${passed}/${results.length} checks passed${skipped ? ` · ${skipped} NOT VERIFIED (⊘ above — not green, just unrun)` : ''}`);
process.exit(failed ? 1 : 0);
