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
  if (!new RegExp(`${field}:\\s*\\S+`).test(fm)) throw new Error(`${rel} frontmatter missing ${field}`);
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
  const s = read('skills/harness-audit/SKILL.md');
  if (!/^---\n/.test(s)) throw new Error('no frontmatter');
  const fm = s.split('---')[1];
  if (!/name:\s*\S+/.test(fm)) throw new Error('frontmatter missing name');
  if (!/description:\s*\S+/.test(fm)) throw new Error('frontmatter missing description');
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

check('no private contract leaks in commands/, agents/, benchmarks/', () => {
  const files = [...walk('commands'), ...walk('agents'), ...walk('benchmarks')];
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

let failed = 0;
for (const r of results) {
  failed += r.ok ? 0 : 1;
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
}
console.log(`${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
