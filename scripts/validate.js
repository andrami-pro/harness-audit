#!/usr/bin/env node
// validate.js — the package's own preflight gate.
// A methodology that preaches executable rubrics must be able to say no to itself.
// Run: node scripts/validate.js   (exit 0 = releasable, non-zero = fix first)

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const results = [];
const check = (name, fn) => {
  try {
    const detail = fn();
    results.push({ name, ok: true, detail: detail || '' });
  } catch (e) {
    results.push({ name, ok: false, detail: e.message.split('\n')[0] });
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
const hasFrontmatterField = (rel, field) => {
  const s = read(rel);
  if (!/^---\n/.test(s)) throw new Error(`${rel} missing frontmatter`);
  const fm = s.split('---')[1] ?? '';
  // `\s` spans the newline: `field:\s*\S+` reads the NEXT key's name as this field's value.
  if (!new RegExp(`^${field}:[ \\t]*\\S`, 'm').test(fm)) throw new Error(`${rel} frontmatter missing ${field}`);
};

check('plugin.json valid + required fields', () => {
  const p = JSON.parse(read('.claude-plugin/plugin.json'));
  for (const f of ['name', 'description', 'version']) if (!p[f]) throw new Error(`missing field: ${f}`);
  return `${p.name}@${p.version}`;
});

check('marketplace.json valid + lists the plugin', () => {
  const m = JSON.parse(read('.claude-plugin/marketplace.json'));
  if (!m.name) throw new Error('missing field: name');
  if (!Array.isArray(m.plugins) || !m.plugins.some((p) => p.name === 'harness-audit')) {
    throw new Error('plugins[] must include harness-audit');
  }
});

check('SKILL.md exists with name + description frontmatter', () => {
  hasFrontmatterField('skills/harness-audit/SKILL.md', 'name');
  hasFrontmatterField('skills/harness-audit/SKILL.md', 'description');
});

check('companion templates present', () => {
  mustExist('skills/harness-audit/rubric-template.md');
  mustExist('skills/harness-audit/verifier-protocol.md');
  mustExist('WHITEPAPER.md');
  mustExist('README.md');
  mustExist('LICENSE');
});

check('verifier-protocol has the negative-control self-test', () => {
  if (!/negative control|negative-control/i.test(read('skills/harness-audit/verifier-protocol.md'))) {
    throw new Error('missing negative-control section (v2 requirement)');
  }
});

check('no stale model lineup (Haiku must not be the preflight tier)', () => {
  const files = ['skills/harness-audit/SKILL.md', 'WHITEPAPER.md', 'README.md', ...globMd('commands'), ...globMd('agents')];
  for (const rel of files) {
    const hits = read(rel).split('\n')
      .map((l, i) => ({ l, n: i + 1 }))
      .filter(({ l }) => /haiku/i.test(l) && /preflight/i.test(l));
    if (hits.length) throw new Error(`${rel}:${hits[0].n} still pairs Haiku with preflight`);
  }
  return `${files.length} files scanned`;
});

check('benchmark figures are hedged, not asserted', () => {
  const files = ['skills/harness-audit/SKILL.md', 'WHITEPAPER.md', ...globMd('commands'), ...globMd('agents')];
  for (const rel of files) {
    const t = read(rel);
    if (/89\s*%/.test(t) && !/directional|illustrative|not (yet )?(independently )?reproduced/i.test(t)) {
      throw new Error(`${rel} cites 89% without a directional/unreproduced hedge`);
    }
  }
  return `${files.length} files scanned`;
});

check('every commands/*.md has a frontmatter description', () => {
  const files = globMd('commands');
  if (!files.length) throw new Error('commands/ is empty — the plugin ships no loop');
  for (const rel of files) hasFrontmatterField(rel, 'description');
  return `${files.length} command(s) checked`;
});

check('every agents/*.md has a frontmatter description', () => {
  const files = globMd('agents');
  if (!files.length) throw new Error('agents/ is empty — the plugin ships no critics');
  for (const rel of files) hasFrontmatterField(rel, 'description');
  return `${files.length} agent(s) checked`;
});

// Each pattern is a leak that reached a public file, or the private contract that is the reason
// anyone would pay for the audit. A leak glues itself to its neighbours: the one that shipped inside a
// benchmark fixture was `REDACTED_agent`, where `\b` finds no boundary at all — so these names match as
// substrings, not as words. `xx-yy` is the single exception: it hides inside innocent hyphenation
// (`files-config`, `types-core`), so it alone is fenced against adjacent letters.
const PRIVATE_LEAKS = [
  /(?<![a-z])es[-_]co(?![a-z])/i,
  /REDACTED/i,
  /persona-a|persona-b|persona-c|persona-d/i,
  /persona-e|persona-f|persona-g|persona-h/i,
  /REDACTED|REDACTED|REDACTED|REDACTED/i,
];

check('no private contract leaks in commands/, agents/, benchmarks/, fixtures/', () => {
  const files = [...walk('commands'), ...walk('agents'), ...walk('benchmarks'), ...walk('scripts/fixtures')];
  if (!files.length) throw new Error('nothing scanned — the gate would pass vacuously');
  for (const rel of files) {
    read(rel).split('\n').forEach((line, i) => {
      for (const re of PRIVATE_LEAKS) {
        if (re.test(line)) throw new Error(`${rel}:${i + 1} leaks private contract — matched ${re}`);
      }
    });
  }
  return `${files.length} files scanned`;
});

check('hooks.json valid + every referenced script exists and parses', () => {
  const h = JSON.parse(read('hooks/hooks.json'));
  const cmds = JSON.stringify(h).match(/scripts\/hooks\/[\w-]+\.js/g) || [];
  if (cmds.length < 3) throw new Error(`expected ≥3 hook scripts referenced, found ${cmds.length}`);
  for (const rel of new Set(cmds)) {
    mustExist(rel);
    execFileSync('node', ['--check', path.join(ROOT, rel)], { stdio: 'pipe' });
  }
  return `${new Set(cmds).size} scripts`;
});

check('install.sh parses (sh -n)', () => {
  mustExist('install.sh');
  execFileSync('sh', ['-n', path.join(ROOT, 'install.sh')], { stdio: 'pipe' });
});

// The transcript format is internal to Claude Code and can change without notice. These assertions are
// derived facts, not file-existence: each one dies if a shape this parser depends on moves. Asserting
// only that the fixture parses would guard the neighbouring failure mode, not the one that happens.
check('loop-stats reconstructs the pinned telemetry fixture', () => {
  const script = path.join(ROOT, 'scripts/loop-stats.js');
  mustExist('scripts/loop-stats.js');
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

let failed = 0;
for (const r of results) {
  failed += r.ok ? 0 : 1;
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
}
console.log(`${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
