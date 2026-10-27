#!/usr/bin/env node
// model-lineup.js — resolves and validates ~/.agents/model-lineup.json (D25): one file,
// zero deps, shared by install.sh --lineup, the SKILL.md onboarding step, loop-stats.js's
// LINEUP block, and validate.js's fixture check — one place for the family/guardrail logic
// instead of three copies that drift apart.
//
// CLI:
//   node model-lineup.js resolve --target <name> --file <path>
//   node model-lineup.js resolve --target <name> [--global <path>] [--project <path>]
//     Prints the resolved {role: {model, provider?, family, stamp}} map as JSON, plus
//     hardViolation / softViolations / providerFallbacks / unknownModels.
//     Exit 0  — no hard violation (softViolations may still be present; the caller decides).
//     Exit 2  — hard violation (reviewer and implementer share a model family, D25a). Never
//               confirmable: the caller must reject, not prompt.
//     Exit 1  — usage error or unreadable file.
//
//   node model-lineup.js check [--global <path>] [--project <path>] [--catalog <path>] [--probe]
//     Validates every provider-qualified entry against the live `pi --list-models` catalog.
//     Exit 0 — all present, or no catalog reachable. Exit 1 — an entry names a model nothing serves.
//
//   node model-lineup.js ui [--global <path>]
//     Editor de la matriz rol x harness. Sin TTY imprime la matriz y valida, sin editar.
//
//   node model-lineup.js advise [--offline] [--no-probe]
//     Asesor semanal (lineup-advise.js): rankings × precio × datos → ~/.agents/lineup-advice.md
//
//   node model-lineup.js ollama-sync
//     Regenera el bloque `ollama` de ~/.pi/agent/models.json desde `ollama list`.
//
//   node model-lineup.js record-exception --project <path> --role <r> --model <m> --note <text>
//     Appends a confirmed SOFT-guardrail exception to the PROJECT lineup file (creating it if
//     needed) under confirmedExceptions[]. Never touches the global file or any invariant check.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

// 'explainer' is the read-only question seat: it answers "where is X / what state is this in /
// why was this decided" from the graph, STATUS.md and docs, and never proposes work. It is in the
// line-up for one reason — a role that answers questions all day at implementer prices is the
// cheapest thing in the harness to get wrong, and it is the natural home for a free-tier model.
// 'scout' is develop-phase's first seat: read-only, it gathers context (graph, STATUS, PRD) into a
// short brief so the analyst and the implementer start from it instead of re-exploring the repo at
// their own prices. High volume, low difficulty — it wants a long context and a low price, not depth.
// 'creativo' is the design seat (PRD-005): screens, layouts, visual polish, interface copy. Its
// ranking is driven primarily by LMArena WebDev, because "best at coding" and "best at UI" are not the
// same leaderboard — see PROFILES.creativo in lineup-advise.js.
const ROLES = ['scout', 'architect', 'orchestrator', 'implementer', 'reviewer', 'preflight', 'scorer', 'critic', 'judge', 'explainer', 'creativo'];

// Targets whose harness accepts a non-Anthropic `provider` (Pi, Kilo, OpenCode per D25). Every
// other target — Claude Code chief among them — only understands bare Anthropic model ids, so a
// provider field there is not an error, just unsupported: it falls back to `defaults` with a warning.
// 'kilo-loops' (F9's commands+agents port) is a distinct install.sh target from 'kilo' (the
// skill-only target this set predates) — both write into a Kilo harness, so both belong here.
const MULTI_PROVIDER_TARGETS = new Set(['pi', 'kilo', 'kilo-loops', 'opencode']);

// Identical criterion to loop-stats.js's baseModel(): `claude-opus-4-8[1m]` and
// `claude-haiku-4-5-20251001` are the same model as their bare id — the context-window suffix
// carries no family change and the trailing digits are a pinned snapshot date, not a different
// tier. Replicated here (not required from loop-stats.js) because loop-stats.js runs its own
// main() unconditionally on load — requiring it would execute the dashboard, not just borrow a
// function. Keep these two definitions byte-identical; a drift here is a drift in what
// "independent family" means between the two tools that both claim to enforce it.
const baseModel = (m) => String(m || 'unknown').trim().replace(/\[[^\]]*\]$/, '').replace(/-\d{8}$/, '');

// "Family" = model line, and the HARD guardrail (D25a) is the only thing standing on it, so it has
// to survive every id shape that can reach it — including the ones this file itself emits.
//
//   claude-opus-4-8                ─┐
//   claude-opus-4-8[1m]             │  all one family: claude-opus
//   nvidia-nim/claude-opus-4-8     ─┘  (stampValue() writes this shape for multi-provider targets;
//                                       routing the same weights through another API does not make
//                                       a second, independent reviewer — so the provider prefix is
//                                       stripped before the tier is read, never after)
//   claude-3-5-sonnet-20241022     ── claude-sonnet: the legacy id puts the version BEFORE the
//                                     tier, so the tier is found by scanning segments, not by
//                                     position.
//
// Non-Anthropic ids (`zai/glm-5.2`, `nvidia-nim/zai/glm-5.2`) have no tier vocabulary to anchor on;
// they fall back to the provider-stripped id minus its trailing version (`glm`) — for the same
// reason, so that the same open-weight model reached through two providers is one family, not two.
const CLAUDE_TIERS = ['opus', 'fable', 'sonnet', 'haiku', 'mythos'];
const dropProvider = (id) => id.slice(id.lastIndexOf('/') + 1);

function familyOf(entry) {
  const bare = dropProvider(baseModel(entry && entry.model));
  if (/^claude[-.]/.test(bare)) {
    const tier = bare.split(/[-.]/).find((seg) => CLAUDE_TIERS.includes(seg));
    if (tier) return `claude-${tier}`;
  }
  const stripped = bare.replace(/[-.]?\d+(?:\.\d+)*$/, '');
  return stripped || bare;
}

// Model ids this repo has priced or named anywhere (loop-stats.js PRICE_PER_MTOK, the D25 schema
// example). An id outside this list is not an error — new models ship faster than this file gets
// updated — it is a warning: "no guardrail data for this id, proceeding anyway." Matched on the
// provider-stripped id, so a provider-qualified Anthropic id is recognized rather than warned about
// while its family silently goes unchecked.
const KNOWN_MODEL_PATTERNS = [/^claude-(opus|fable|sonnet|haiku|mythos)-/, /^claude-\d/, /^glm-/];
const isKnownModel = (id) => KNOWN_MODEL_PATTERNS.some((re) => re.test(dropProvider(baseModel(id))));

// The SOFT guardrail (D25b): invariants this repo has already decided and encoded elsewhere
// (validate.js's "no stale model lineup" check). New entries here must have a real prior decision
// behind them — this list is not a place to park opinions, only decisions.
const KNOWN_INVARIANTS = [
  {
    id: 'no-haiku-preflight',
    role: 'preflight',
    test: (resolved) => resolved.preflight && /haiku/i.test(baseModel(resolved.preflight.model)),
    message: (resolved) => `preflight is set to "${resolved.preflight.model}" — this contradicts the `
      + '2026-07-02 decision to retire Haiku from the line-up. Confirm for THIS project only?',
  },
];

// The frontmatter `model:` field Claude Code agents use today is a short alias (`opus`, `fable`,
// `sonnet` — see agents/scorer.md), not the full id the lineup schema stores. Non-Anthropic targets
// have no such convention documented yet (that is F9's job); a provider-qualified id is the most
// honest thing to write until then.
function stampValue(target, entry) {
  if (!MULTI_PROVIDER_TARGETS.has(target)) return familyOf(entry).replace(/^claude-/, '');
  // Trimmed: a stray space in the lineup would otherwise land in the frontmatter this stamps.
  const id = String(entry.model || '').trim();
  return entry.provider ? `${String(entry.provider).trim()}/${id}` : id;
}

function readJsonSafe(p) {
  if (!p || !fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { throw new Error(`cannot parse ${p}: ${e.message}`); }
}

function deepMergeRole(base, over) {
  const out = { ...(base || {}) };
  for (const k of Object.keys(over || {})) out[k] = { ...(base && base[k]), ...over[k] };
  return out;
}

// Global sets the baseline; the project file overrides individual roles on top of it — not a
// wholesale replacement. `--file <path>` in the CLI skips this merge entirely: a path takes the
// file exactly as written, which is what a test fixture wants.
function mergeLineups(global, project) {
  const g = global || { version: 1, defaults: {}, harness: {} };
  const p = project || {};
  const defaults = deepMergeRole(g.defaults, p.defaults);
  const harnessKeys = new Set([...Object.keys(g.harness || {}), ...Object.keys(p.harness || {})]);
  const harness = {};
  for (const k of harnessKeys) harness[k] = deepMergeRole((g.harness || {})[k], (p.harness || {})[k]);
  return { version: g.version || p.version || 1, defaults, harness };
}

// `harness.<target>.<role>` wins over `defaults.<role>` (the PRD's resolution rule, verbatim). A
// provider unsupported by the target is not applied — it falls back to `defaults[role]`, which by
// construction carries no `provider` field.
function resolveLineup(lineup, target) {
  const defaults = lineup.defaults || {};
  const overrides = (lineup.harness && lineup.harness[target]) || {};
  const multiProvider = MULTI_PROVIDER_TARGETS.has(target);
  const resolved = {};
  const providerFallbacks = [];
  const unknownModels = new Set();

  for (const role of ROLES) {
    let entry = overrides[role] || defaults[role];
    if (!entry) continue;
    if (entry.provider && entry.provider !== 'anthropic' && !multiProvider) {
      providerFallbacks.push({ role, provider: entry.provider, model: entry.model, target });
      entry = defaults[role];
      if (!entry) continue;
    }
    if (!isKnownModel(entry.model)) unknownModels.add(entry.model);
    resolved[role] = { ...entry, family: familyOf(entry), stamp: stampValue(target, entry) };
  }
  return { resolved, providerFallbacks, unknownModels: [...unknownModels] };
}

// D25a — HARD, never confirmable. Independence property: the reviewer must not share the
// implementer's model line, or "independent review" degrades to self-critique wearing a different
// badge. No exception path exists for this one on purpose.
function hardViolation(resolved) {
  const rev = resolved.reviewer;
  const impl = resolved.implementer;
  if (!rev || !impl) return null;
  if (rev.family !== impl.family) return null;
  return `reviewer (${rev.model}, family ${rev.family}) and implementer (${impl.model}, family `
    + `${impl.family}) share a model family — the independence property (D25a) forbids this. Not `
    + 'confirmable: edit the line-up, this cannot be overridden.';
}

// D25b — SOFT, confirmable per project. Returns every known invariant the resolved line-up
// contradicts; the caller (install.sh / the SKILL onboarding flow) decides how to ask.
function softViolations(resolved) {
  return KNOWN_INVARIANTS.filter((inv) => inv.test(resolved))
    .map((inv) => ({
      id: inv.id, role: inv.role, model: resolved[inv.role] && resolved[inv.role].model,
      message: inv.message(resolved),
    }));
}

function recordException(projectPath, role, model, note) {
  const current = readJsonSafe(projectPath) || { version: 1, defaults: {}, harness: {} };
  current.confirmedExceptions = current.confirmedExceptions || [];
  current.confirmedExceptions.push({ role, model, confirmedAt: new Date().toISOString(), note: note || '' });
  fs.mkdirSync(path.dirname(projectPath), { recursive: true });
  fs.writeFileSync(projectPath, `${JSON.stringify(current, null, 2)}\n`);
  return current;
}

function opt(argv, name, def) {
  const i = argv.indexOf(name);
  return i === -1 || i === argv.length - 1 ? def : argv[i + 1];
}

function cmdResolve(argv) {
  const target = opt(argv, '--target', null);
  if (!target) {
    process.stderr.write('usage: model-lineup.js resolve --target <name> (--file <path> | [--global <path>] [--project <path>])\n');
    process.exit(1);
  }
  const filePath = opt(argv, '--file', null);
  let lineup;
  try {
    if (filePath) {
      lineup = readJsonSafe(filePath);
      if (!lineup) { process.stderr.write(`model-lineup.js: no lineup at ${filePath}\n`); process.exit(1); }
    } else {
      const global = readJsonSafe(opt(argv, '--global', null));
      const project = readJsonSafe(opt(argv, '--project', null));
      if (!global && !project) {
        process.stderr.write('model-lineup.js: no lineup found (checked --global and --project paths)\n');
        process.exit(1);
      }
      lineup = mergeLineups(global, project);
    }
  } catch (e) {
    process.stderr.write(`model-lineup.js: ${e.message}\n`);
    process.exit(1);
  }

  const { resolved, providerFallbacks, unknownModels } = resolveLineup(lineup, target);
  const hard = hardViolation(resolved);
  const soft = softViolations(resolved);
  const out = { ok: !hard, target, resolved, hardViolation: hard, softViolations: soft, providerFallbacks, unknownModels };
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  if (hard) { process.stderr.write(`model-lineup.js: HARD violation — ${hard}\n`); process.exit(2); }
  process.exit(0);
}

function cmdRecordException(argv) {
  const projectPath = opt(argv, '--project', null);
  const role = opt(argv, '--role', null);
  const model = opt(argv, '--model', null);
  const note = opt(argv, '--note', '');
  if (!projectPath || !role || !model) {
    process.stderr.write('usage: model-lineup.js record-exception --project <path> --role <r> --model <m> [--note <text>]\n');
    process.exit(1);
  }
  const written = recordException(projectPath, role, model, note);
  process.stdout.write(`${JSON.stringify(written, null, 2)}\n`);
}

// D25c — the catalog check. `provider` and `model` are free strings in the lineup file; nothing in
// resolve() can tell `nvidia-nim/zai/glm-5.2` (which no registry serves) from `nvidia/z-ai/glm-5.2`
// (which Pi serves today), so a typo there does not fail loudly — it fails at dispatch, minutes in,
// as a timeout with no diagnosis. This check reads the catalog from the harness itself
// (`pi --list-models`, the same registry Pi resolves against) and matches every provider-qualified
// entry against it.
//
//   node model-lineup.js check [--global <path>] [--project <path>] [--file <path>] [--catalog <path>]
//     Exit 0 — every checkable entry exists (or no catalog is reachable: a machine without pi
//              installed cannot be told its line-up is wrong).
//     Exit 1 — an entry names a provider/model pair the catalog does not have.
//
// Only `harness.<multi-provider target>` entries are checked. `defaults` holds bare Anthropic ids
// aimed at Claude Code, whose registry is NOT Pi's — Pi lists no `claude-opus-5` — and failing a
// working line-up over that would make the check a liar.
function loadCatalog(catalogPath) {
  let text = null;
  if (catalogPath) {
    try { text = fs.readFileSync(catalogPath, 'utf8'); }
    catch (e) { return { pairs: null, reason: `cannot read ${catalogPath}: ${e.message}` }; }
  } else {
    try {
      text = require('node:child_process')
        .execFileSync('pi', ['--list-models'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch { return { pairs: null, reason: 'pi --list-models unavailable (pi not installed or not on PATH)' }; }
  }
  const pairs = new Set();
  const providers = new Set();
  for (const line of String(text).split('\n')) {
    const m = line.trim().match(/^(\S+)\s+(\S+)/);
    if (!m || m[1] === 'provider') continue;   // skip the header row
    pairs.add(`${m[1]}/${m[2]}`);
    providers.add(m[1]);
  }
  return pairs.size ? { pairs, providers } : { pairs: null, reason: 'catalog parsed to zero models' };
}

// Same id, different punctuation, is the failure this check exists for (`zai/` vs `z-ai/`), so the
// suggestion is matched on the id with every non-alphanumeric character removed rather than on an
// edit distance — it names the intended model exactly instead of ranking three plausible ones.
const squash = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

function catalogProblems(lineup, catalog) {
  const problems = [];
  for (const [target, roles] of Object.entries(lineup.harness || {})) {
    if (!MULTI_PROVIDER_TARGETS.has(target)) continue;
    for (const [role, entry] of Object.entries(roles || {})) {
      if (!entry || !entry.provider) continue;
      const provider = String(entry.provider).trim();
      const model = String(entry.model || '').trim();
      const pair = `${provider}/${model}`;
      if (catalog.pairs.has(pair)) continue;
      const wanted = squash(model);
      const suggestions = [...catalog.pairs].filter((p) => {
        const i = p.indexOf('/');
        return squash(p.slice(i + 1)) === wanted;
      });
      problems.push({ target, role, pair, providerKnown: catalog.providers.has(provider), suggestions });
    }
  }
  return problems;
}

// The catalog is a claim, not a fact. Measured 2026-08-24: `pi --list-models` still advertised
// `nvidia/z-ai/glm-5.2` and `nvidia/moonshotai/kimi-k2.6` while the endpoints answered 410 and 404 —
// so a line-up can pass the catalog check and still hang every dispatch. Probing is the only thing
// that distinguishes "listed" from "answers": one throwaway request per distinct model.
function probeModel(id, timeoutMs) {
  try {
    const out = require('node:child_process').execFileSync(
      'pi', ['-p', 'Responde solo: ok', '--model', id],
      { encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const text = String(out).trim();
    if (!text) return { ok: false, reason: 'respuesta vacía' };
    // A provider error arrives as normal output, not a non-zero exit — so the status code has to be
    // read out of the text or a 403 would count as a healthy model.
    const err = text.match(/\b(4\d\d|5\d\d)\b[^\n]*/);
    return err ? { ok: false, reason: err[0].slice(0, 120) } : { ok: true };
  } catch (e) {
    if (e.killed || e.signal) return { ok: false, reason: `sin respuesta en ${Math.round(timeoutMs / 1000)}s` };
    return { ok: false, reason: String(e.message || e).slice(0, 120) };
  }
}

function cmdCheck(argv) {
  const filePath = opt(argv, '--file', null);
  let lineup;
  try {
    lineup = filePath
      ? readJsonSafe(filePath)
      : mergeLineups(readJsonSafe(opt(argv, '--global', null)), readJsonSafe(opt(argv, '--project', null)));
  } catch (e) {
    process.stderr.write(`model-lineup.js: ${e.message}\n`);
    process.exit(1);
  }
  if (!lineup || (!lineup.defaults && !lineup.harness)) {
    process.stderr.write('model-lineup.js: no lineup found (checked --file, --global and --project paths)\n');
    process.exit(1);
  }

  const catalog = loadCatalog(opt(argv, '--catalog', null));
  if (!catalog.pairs) {
    process.stdout.write(`model-lineup.js check: SKIPPED — ${catalog.reason}\n`);
    process.exit(0);
  }

  const problems = catalogProblems(lineup, catalog);
  if (!problems.length) {
    process.stdout.write(`model-lineup.js check: ok — every provider-qualified entry exists in a catalog of ${catalog.pairs.size} models\n`);
    if (!argv.includes('--probe')) process.exit(0);
  }

  if (argv.includes('--probe')) {
    const timeoutMs = Number(opt(argv, '--probe-timeout', '90')) * 1000;
    const ids = new Set();
    for (const [target, roles] of Object.entries(lineup.harness || {})) {
      if (!MULTI_PROVIDER_TARGETS.has(target)) continue;
      for (const entry of Object.values(roles || {})) {
        if (entry && entry.provider) ids.add(`${String(entry.provider).trim()}/${String(entry.model || '').trim()}`);
      }
    }
    let dead = 0;
    for (const id of [...ids].sort()) {
      const r = probeModel(id, timeoutMs);
      if (r.ok) process.stdout.write(`  ok    ${id}\n`);
      else { dead += 1; process.stdout.write(`  MUERTO ${id} — ${r.reason}\n`); }
    }
    if (dead || problems.length) {
      process.stderr.write(`model-lineup.js check: ${dead} modelo(s) listado(s) que no responden, ${problems.length} fuera del catálogo\n`);
      process.exit(1);
    }
    process.stdout.write(`model-lineup.js check: ${ids.size} modelo(s) responden\n`);
    process.exit(0);
  }
  for (const p of problems) {
    const hint = p.suggestions.length
      ? ` — did you mean ${p.suggestions.join(' or ')}?`
      : p.providerKnown
        ? ` — provider "${p.pair.slice(0, p.pair.indexOf('/'))}" exists but serves no such model`
        : ` — provider "${p.pair.slice(0, p.pair.indexOf('/'))}" is not in the catalog`;
    process.stderr.write(`model-lineup.js check: harness.${p.target}.${p.role} = ${p.pair} not found${hint}\n`);
  }
  process.exit(1);
}

function main() {
  const [cmd, ...argv] = process.argv.slice(2);
  if (cmd === 'resolve') return cmdResolve(argv);
  if (cmd === 'record-exception') return cmdRecordException(argv);
  if (cmd === 'check') return cmdCheck(argv);
  if (cmd === 'advise') {
    // Mismo motivo que `ui`: el asesor hace red y tarda un minuto; nadie que haga `require` de este
    // archivo para leer un id debe cargarlo.
    process.argv = [process.argv[0], require('node:path').join(__dirname, 'lineup-advise.js'), ...argv];
    return require('./lineup-advise.js');
  }
  if (cmd === 'ui' || cmd === 'ollama-sync') {
    // The editor lives in its own file: it is TTY code (raw mode, redraws) and this one is required
    // by validate.js, install.sh and loop-stats.js, none of which should load a terminal UI to read a
    // model id. `ollama-sync` rides along because it edits the catalog this editor reads.
    process.argv = [process.argv[0], require('node:path').join(__dirname, 'lineup-ui.js'),
      ...(cmd === 'ollama-sync' ? ['ollama-sync'] : []), ...argv];
    return require('./lineup-ui.js').main();
  }
  process.stderr.write(`model-lineup.js: unknown command '${cmd || ''}' — usage: resolve | check | ui | advise | ollama-sync | record-exception\n`);
  process.exit(1);
}


module.exports = {
  ROLES, baseModel, familyOf, isKnownModel, mergeLineups, resolveLineup,
  hardViolation, softViolations, recordException, MULTI_PROVIDER_TARGETS, KNOWN_INVARIANTS,
  loadCatalog, catalogProblems,
};

// Exported before main() runs: lineup-ui.js requires this file, and this file dispatches `ui` into
// lineup-ui.js — a cycle where whichever side runs first must already have published its exports.
if (require.main === module) main();
