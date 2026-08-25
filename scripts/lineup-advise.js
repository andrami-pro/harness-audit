#!/usr/bin/env node
// lineup-advise.js — el asesor semanal del line-up (D25d).
//
// Cruza tres cosas que por separado ya se consultan a mano y juntas nunca: los rankings (inteligencia,
// código, agentes), el precio, y la política de datos de quien sirve el modelo. Produce, por rol, los
// tres mejores candidatos del catálogo que Pi puede asignar de verdad, y el diff contra el line-up
// actual. No aplica nada: sugiere, y `/line-up` en Pi (o `bin/lineup`) aplica.
//
//   node lineup-advise.js [--out <dir>] [--project <path>] [--offline] [--fixtures <dir>] [--no-probe] [--json]
//
// Fuentes (cada una aislada: si falla, el informe lo dice y sigue con las demás):
//   AA        artificialanalysis.ai/api/v2/data/llms/models   (key gratuita, 100 req/día; 1 req aquí)
//   LMArena   datasets-server.huggingface.co, dataset lmarena-ai/leaderboard-dataset (sin auth)
//   SWE-bench raw.githubusercontent.com/SWE-bench/swe-bench.github.io/master/data/leaderboards.json
//   OpenRouter openrouter.ai/api/v1/models (+ /endpoints solo para los gratis, para saber quién sirve)
//   Pi        `pi --list-models` — lo único que de verdad se puede escribir en el line-up.
//
// Los nombres de un mismo modelo difieren por fuente (`claude-opus-5-high` / `Claude Opus 5 (High)` /
// `anthropic/claude-opus-5`). normalize() los reduce a una clave común; lo que no case va a la sección
// "No pude mapear" del informe — nunca se descarta en silencio, porque un modelo que no mapea es
// exactamente el que el usuario no sabe que existe.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { execFileSync } = require('node:child_process');

const { ROLES, familyOf, mergeLineups, MULTI_PROVIDER_TARGETS } = require('./model-lineup.js');
const ALIASES = require('./lineup-aliases.json');

const HOME = os.homedir();
const AGENTS_DIR = path.join(HOME, '.agents');
const CACHE_DIR = path.join(AGENTS_DIR, 'cache', 'lineup-advise');
const GLOBAL_LINEUP = path.join(AGENTS_DIR, 'model-lineup.json');
const SECRETS = path.join(AGENTS_DIR, 'secrets.env');
const TODAY = new Date().toISOString().slice(0, 10);

// ── Perfil por rol: qué métrica manda, qué es obligatorio, cuánto pesa el precio ────────────────
// `metrics` son claves de la tabla de métricas por modelo (abajo); se promedian los z-scores de las
// disponibles. `price` es λ en  score = z − λ·log10(1 + $out/M): bajo para roles que escriben poco
// (architect), máximo para los que corren todo el día (explainer, preflight).
// `sensitive` = el rol ve código del proyecto; en repos `client` no se le asigna un proveedor que
// retiene prompts.
// Independencia entre asientos (D25a extendida). El reviewer no puede ser la familia del implementer,
// y tampoco quien juzga la disputa entre ambos ni quien critica o puntúa el resultado: "revisión
// independiente" con el mismo modelo en las dos sillas es autocrítica con otro sombrero. El precio
// hace que un modelo fuerte y gratis gane TODOS los roles a la vez; esto es lo que lo impide.
const INDEPENDENT_OF = {
  reviewer: ['implementer'],
  judge:    ['implementer', 'reviewer'],
  critic:   ['implementer'],
  scorer:   ['implementer'],
};

const PROFILES = {
  architect:    { metrics: ['intelligence', 'lm_hard'],                        minCtx: 200_000, price: 0.3, sensitive: true },
  orchestrator: { metrics: ['agentic', 'lm_agent'],                            minCtx: 500_000, price: 0.7, sensitive: true, tools: true },
  implementer:  { metrics: ['coding', 'swe', 'lm_coding'],                     minOut: 64_000,  price: 0.7, sensitive: true, tools: true },
  reviewer:     { metrics: ['coding', 'swe', 'lm_coding'],                     minOut: 32_000,  price: 0.7, sensitive: true, tools: true },
  critic:       { metrics: ['coding'],                                         minCtx: 128_000, price: 1.2, sensitive: true },
  scorer:       { metrics: ['intelligence'],                                   json: true,      price: 1.2 },
  judge:        { metrics: ['intelligence'],                                   json: true,      price: 0.3 },
  preflight:    { metrics: [],                                                 tools: true,     price: 2.0 },
  explainer:    { metrics: ['intelligence'],                                   minCtx: 256_000, price: 2.0 },
};

// ── util ──────────────────────────────────────────────────────────────────────────────────────────
function opt(argv, name, def) {
  const i = argv.indexOf(name);
  return i === -1 || i === argv.length - 1 ? def : argv[i + 1];
}

function readSecret(name) {
  if (process.env[name]) return process.env[name];
  try {
    const line = fs.readFileSync(SECRETS, 'utf8').split('\n').find((l) => l.startsWith(`${name}=`));
    return line ? line.slice(name.length + 1).trim() : null;
  } catch { return null; }
}

// El datasets-server de HF devuelve 500 "the dataset index is loading" a ratos y 200 al siguiente
// intento; un solo intento convertiría ese parpadeo en "LMArena FALLÓ" una semana de cada tres.
async function fetchJson(url, headers = {}, timeoutMs = 60_000) {
  const waits = [4000, 10000, 20000];
  for (let attempt = 0; ; attempt++) {
    try { return await fetchOnce(url, headers, timeoutMs); }
    catch (e) {
      const transient = /HTTP (5\d\d|429)/.test(e.message) || /timeout/.test(e.message);
      if (!transient || attempt >= waits.length) throw e;
      await new Promise((r) => setTimeout(r, waits[attempt]));
    }
  }
}

function fetchOnce(url, headers = {}, timeoutMs = 60_000, hops = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'user-agent': 'lineup-advise/1 (harness-audit)', ...headers } }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && hops < 3) {
        res.resume();
        return fetchOnce(res.headers.location, headers, timeoutMs, hops + 1).then(resolve, reject);
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} ${url.slice(0, 80)} — ${body.slice(0, 120)}`));
        try { resolve(JSON.parse(body)); } catch (e) { reject(new Error(`JSON inválido de ${url.slice(0, 80)}: ${e.message}`)); }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout ${timeoutMs}ms ${url.slice(0, 80)}`)));
    req.on('error', reject);
  });
}

const K = (s) => (s >= 1_000_000 ? `${(s / 1_000_000).toFixed(s % 1_000_000 ? 1 : 0)}M` : s >= 1000 ? `${Math.round(s / 1000)}K` : String(s));
const money = (x) => (x == null ? '?' : x === 0 ? 'gratis' : `$${x.toFixed(2)}`);

// ── normalización de nombres ──────────────────────────────────────────────────────────────────────
// Lo que sobra en un nombre y no en otro: la organización delante, el nivel de razonamiento detrás
// (`-high`, `(max)`), la fecha de snapshot, el `:free` de OpenRouter. Se quita todo eso y lo que queda
// es la clave. `max` se quita también cuando es nivel de esfuerzo, y eso colisiona con modelos que se
// LLAMAN max (qwen3.8-max): se resuelve porque las dos caras de la comparación pasan por la misma
// función, así que la colisión es simétrica y el alias manual (lineup-aliases.json) desempata.
const EFFORT = /[-_ ]?(xhigh|high|medium|low|minimal|max|thinking|reasoning|instruct|it|preview|latest|adaptive)\b/g;
function normalize(name) {
  let s = String(name || '').toLowerCase().trim();
  s = s.replace(/\([^)]*\)/g, ' ');                 // "(High)", "(Adaptive Reasoning, Max Effort)"
  s = s.replace(/:(free|batch|thinking|online)$/, '');
  s = s.slice(s.lastIndexOf('/') + 1);              // organización delante
  s = s.replace(/[-_ ]?\d{4}-?\d{2}-?\d{2}\b/g, ''); // fechas
  s = s.replace(/[-_ ]?\d{4}\b/g, (m) => (/^[-_ ]?20\d\d$/.test(m) ? '' : m));
  s = s.replace(EFFORT, '');
  s = s.replace(/[^a-z0-9]/g, '');
  return s;
}

// ── fuentes ───────────────────────────────────────────────────────────────────────────────────────
function cachePath(src) { return path.join(CACHE_DIR, `${src}-${TODAY}.json`); }
function latestCache(src, fixturesDir) {
  const dir = fixturesDir || CACHE_DIR;
  const candidates = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.startsWith(`${src}-`) && f.endsWith('.json')).sort().reverse()
    : [];
  if (!candidates.length) return null;
  return { file: path.join(dir, candidates[0]), data: JSON.parse(fs.readFileSync(path.join(dir, candidates[0]), 'utf8')) };
}

async function withCache(src, opts, fetcher) {
  if (opts.offline) {
    const c = latestCache(src, opts.fixtures);
    if (!c) return { ok: false, error: `sin caché para ${src} (corre una vez con red)`, rows: [] };
    return { ok: true, rows: c.data.rows, fetchedAt: c.data.fetchedAt, note: `caché ${path.basename(c.file)}` };
  }
  try {
    const rows = await fetcher();
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(cachePath(src), JSON.stringify({ fetchedAt: new Date().toISOString(), rows }));
    return { ok: true, rows, fetchedAt: new Date().toISOString() };
  } catch (e) {
    const c = latestCache(src, null);
    if (c) return { ok: true, rows: c.data.rows, fetchedAt: c.data.fetchedAt, note: `FALLÓ la red (${e.message}); usando caché ${path.basename(c.file)}` };
    return { ok: false, error: e.message, rows: [] };
  }
}

async function srcAA(opts) {
  return withCache('aa', opts, async () => {
    const key = readSecret('ARTIFICIAL_ANALYSIS_API_KEY');
    if (!key) throw new Error('falta ARTIFICIAL_ANALYSIS_API_KEY (env o ~/.agents/secrets.env)');
    const d = await fetchJson('https://artificialanalysis.ai/api/v2/data/llms/models', { 'x-api-key': key });
    return (d.data || []).map((r) => {
      const ev = r.evaluations || {};
      const p = r.pricing || {};
      // No hay índice agéntico como tal; terminal-bench hard y τ²-bench son lo más cercano.
      const ag = [ev.terminalbench_hard, ev.tau2].filter((x) => x != null);
      return {
        name: r.name, slug: r.slug, creator: r.model_creator && r.model_creator.slug,
        intelligence: ev.artificial_analysis_intelligence_index, coding: ev.artificial_analysis_coding_index,
        agentic: ag.length ? (ag.reduce((a, b) => a + b, 0) / ag.length) * 100 : null,
        price_in: p.price_1m_input_tokens, price_out: p.price_1m_output_tokens, tps: r.median_output_tokens_per_second,
      };
    });
  });
}

async function srcLMArena(opts) {
  return withCache('lmarena', opts, async () => {
    const base = 'https://datasets-server.huggingface.co';
    const ds = 'dataset=lmarena-ai%2Fleaderboard-dataset';
    const out = [];
    const pull = async (url, tag, scoreKey) => {
      for (let offset = 0; ; offset += 100) {
        const d = await fetchJson(`${url}&offset=${offset}&length=100`);
        for (const r of d.rows || []) out.push({ tag, model: r.row.model_name, score: r.row[scoreKey], rank: r.row.rank, org: r.row.organization });
        if (!d.rows || d.rows.length < 100 || offset + 100 >= (d.num_rows_total || 0)) break;
      }
    };
    // `coding` y `hard_prompts` no son configs: son valores de la columna `category` dentro de `text`.
    for (const cat of ['coding', 'hard_prompts']) {
      await pull(`${base}/filter?${ds}&config=text&split=latest&where=%22category%22%3D%27${cat}%27`, `lm_${cat === 'hard_prompts' ? 'hard' : cat}`, 'rating');
    }
    await pull(`${base}/rows?${ds}&config=webdev&split=latest`, 'lm_webdev', 'rating');
    await pull(`${base}/rows?${ds}&config=agent&split=latest`, 'lm_agent', 'score');
    return out;
  });
}

async function srcSWE(opts) {
  return withCache('swebench', opts, async () => {
    const d = await fetchJson('https://raw.githubusercontent.com/SWE-bench/swe-bench.github.io/master/data/leaderboards.json', {}, 180_000);
    const v = (d.leaderboards || []).find((l) => l.name === 'Verified');
    if (!v) throw new Error('leaderboards.json sin tabla Verified');
    const best = new Map();
    for (const r of v.results || []) {
      if (!r.model_display || r.model_display === 'Multiple' || r.resolved == null) continue;
      const prev = best.get(r.model_display);
      if (!prev || r.resolved > prev.resolved) best.set(r.model_display, { model: r.model_display, resolved: r.resolved, agent: r.agent, date: r.date });
    }
    return [...best.values()];
  });
}

async function srcOpenRouter(opts) {
  return withCache('openrouter', opts, async () => {
    const d = await fetchJson('https://openrouter.ai/api/v1/models');
    const rows = (d.data || []).map((m) => {
      const p = m.pricing || {};
      // Strings a propósito: "0" es gratis, "-1" es "variable" (los routers) y NO es gratis.
      const free = p.prompt === '0' && p.completion === '0';
      const num = (s) => (s == null || s === '-1' ? null : Number(s) * 1e6);
      return {
        id: m.id, ctx: m.context_length, max_out: m.top_provider && m.top_provider.max_completion_tokens,
        price_in: free ? 0 : num(p.prompt), price_out: free ? 0 : num(p.completion),
        params: m.supported_parameters || [], free, provider: null,
      };
    }).filter((m) => !/lyria|text-to-image|image-edit/.test(m.id));
    // Solo para los gratis: quién sirve de verdad. Es lo que decide la política de datos, y son ~20
    // llamadas, no 400.
    for (const m of rows.filter((r) => r.free)) {
      try {
        const e = await fetchJson(`https://openrouter.ai/api/v1/models/${m.id}/endpoints`);
        const ep = (e.data && e.data.endpoints || [])[0];
        if (ep) { m.provider = ep.provider_name; m.quant = ep.quantization; }
      } catch { /* sin endpoint = sin proveedor conocido; queda "unknown" */ }
    }
    return rows;
  });
}

function srcPi(opts) {
  if (opts.offline && opts.fixtures) {
    const c = latestCache('pi', opts.fixtures);
    if (c) return { ok: true, rows: c.data.rows, note: `fixture ${path.basename(c.file)}` };
  }
  try {
    const out = execFileSync('pi', ['--list-models'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000 });
    const size = (s) => (s.endsWith('M') ? parseFloat(s) * 1e6 : s.endsWith('K') ? parseFloat(s) * 1e3 : parseFloat(s) || 0);
    const rows = [];
    for (const line of out.split('\n')) {
      const m = line.trim().match(/^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)/);
      if (!m || m[1] === 'provider') continue;
      rows.push({ provider: m[1], id: m[2], ctx: size(m[3]), max_out: size(m[4]), thinking: m[5] === 'yes', images: m[6] === 'yes' });
    }
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(cachePath('pi'), JSON.stringify({ fetchedAt: new Date().toISOString(), rows }));
    return { ok: true, rows };
  } catch (e) {
    const c = latestCache('pi', opts.fixtures);
    if (c) return { ok: true, rows: c.data.rows, note: `pi no disponible; caché ${path.basename(c.file)}` };
    return { ok: false, error: `pi --list-models: ${e.message}`, rows: [] };
  }
}

// ── cruce ─────────────────────────────────────────────────────────────────────────────────────────
function policyFor(piModel, orRow) {
  const P = ALIASES.providers || {};
  if (piModel.provider === 'openrouter') {
    // El proveedor real es el primer segmento del id (anthropic/, z-ai/, stealth/) salvo en los gratis,
    // donde manda quien sirve el endpoint (Decart sirviendo glm-5.2:free no es Z.ai).
    const served = orRow && orRow.provider ? orRow.provider.toLowerCase() : null;
    const bare = piModel.model || piModel.id;
    const org = bare.includes('/') ? bare.slice(0, bare.indexOf('/')) : null;
    const key = served && P[served] ? served : (org && P[org] ? org : null);
    const entry = key ? P[key] : null;
    return { policy: entry ? entry.policy : 'unknown', who: served || org || 'openrouter', source: entry ? entry.source : (P.openrouter || {}).source };
  }
  const entry = P[piModel.provider];
  return { policy: entry ? entry.policy : 'unknown', who: piModel.provider, source: entry && entry.source };
}

function buildTable(src, catalog) {
  const byKey = new Map();
  const aliasKey = new Map(Object.entries(ALIASES.aliases || {}).map(([name, piId]) => [name, normalize(piId)]));
  // `:batch` son endpoints asíncronos (horas de latencia a cambio de precio): no sirven para un agente
  // interactivo, y ofrecerlos solo haría que el precio ganara a la realidad.
  // `~org/model-latest` son alias flotantes de OpenRouter: apuntan a lo que el proveedor decida esa
  // semana, y un line-up debe nombrar el modelo que se evaluó, no un puntero.
  // models.json puede declarar modelos de ollama que no están descargados (o sin ollama instalado);
  // sugerir uno de esos es sugerir un 404 local.
  const ollamaIds = new Set();
  try {
    for (const l of execFileSync('ollama', ['list'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).split('\n').slice(1)) {
      const id = l.trim().split(/\s+/)[0]; if (id) ollamaIds.add(id);
    }
  } catch { /* sin ollama: sin candidatos ollama */ }
  const models = catalog.filter((m) => !m.id.endsWith(':batch') && !m.id.startsWith('~') && (m.provider !== 'ollama' || ollamaIds.has(m.id))).map((m) => ({
    key: normalize(m.id), id: `${m.provider}/${m.id}`, provider: m.provider, model: m.id,
    ctx: m.ctx, max_out: m.max_out, metrics: {}, price_in: null, price_out: null, params: null, free: false, from: new Set(),
  }));
  for (const m of models) { if (!byKey.has(m.key)) byKey.set(m.key, []); byKey.get(m.key).push(m); }
  const unmapped = [];
  const attach = (srcName, name, fn) => {
    const key = aliasKey.get(name) || normalize(name);
    const hits = byKey.get(key);
    if (!hits) { unmapped.push({ source: srcName, name }); return; }
    for (const m of hits) { fn(m); m.from.add(srcName); }
  };
  // Un mismo modelo aparece en AA en varias variantes de esfuerzo; la que manda es la mejor — es lo
  // que el modelo PUEDE hacer, y el esfuerzo se elige después con `:high` en la propia llamada.
  const maxInto = (m, k, v) => { if (v != null && (m.metrics[k] == null || v > m.metrics[k])) m.metrics[k] = v; };
  for (const r of src.aa.rows) attach('AA', r.slug, (m) => {
    maxInto(m, 'intelligence', r.intelligence); maxInto(m, 'coding', r.coding); maxInto(m, 'agentic', r.agentic);
    if (m.price_out == null && r.price_out != null) { m.price_in = r.price_in; m.price_out = r.price_out; }
    m.aaName = r.name;
  });
  for (const r of src.lmarena.rows) attach('LMArena', r.model, (m) => maxInto(m, r.tag, r.score));
  for (const r of src.swebench.rows) attach('SWE-bench', r.model, (m) => maxInto(m, 'swe', r.resolved));
  const orById = new Map(src.openrouter.rows.map((r) => [r.id, r]));
  for (const m of models) {
    const or = m.provider === 'openrouter' ? orById.get(m.model) : orById.get(m.model) || null;
    if (or) {
      m.params = or.params; m.free = m.provider === 'openrouter' ? or.free : m.free;
      if (m.provider === 'openrouter') { m.price_in = or.price_in; m.price_out = or.price_out; }
      else if (m.price_out == null) { m.price_in = or.price_in; m.price_out = or.price_out; }
    }
    if (m.provider === 'nvidia' || m.provider === 'ollama') { m.free = true; m.price_in = 0; m.price_out = 0; }
    Object.assign(m, { data: policyFor(m, or) });
    m.note = (ALIASES.notes || {})[m.model] || (ALIASES.notes || {})[m.id] || null;
  }
  // Los ids de OpenRouter que Pi no lista igual siguen siendo útiles como "gratis hoy"
  const freeOR = src.openrouter.rows.filter((r) => r.free).map((r) => ({ ...r, data: policyFor({ provider: 'openrouter', id: r.id }, r), note: (ALIASES.notes || {})[r.id] || null }));
  return { models, unmapped, freeOR };
}

// ── puntuación ────────────────────────────────────────────────────────────────────────────────────
function zscores(models, key) {
  const vals = models.map((m) => m.metrics[key]).filter((v) => v != null);
  if (vals.length < 3) return () => null;
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length) || 1;
  return (m) => (m.metrics[key] == null ? null : (m.metrics[key] - mean) / sd);
}

function rankRole(role, models, sensitivity, excludeFamilies) {
  const p = PROFILES[role];
  const z = Object.fromEntries(p.metrics.map((k) => [k, zscores(models, k)]));
  const out = [];
  for (const m of models) {
    const why = [];
    if (p.minCtx && m.ctx < p.minCtx) continue;
    if (p.minOut && m.max_out < p.minOut) continue;
    if (p.tools && m.params && !m.params.includes('tools')) continue;
    if (p.json && m.params && !m.params.some((x) => x === 'structured_outputs' || x === 'response_format')) continue;
    if (m.model === 'openrouter/free' && role !== 'explainer') continue;
    if (excludeFamilies && excludeFamilies.has(familyOf({ model: m.model }))) continue;
    // Cuota del proveedor: NIM (40 rpm, créditos finitos) y ollama (CPU) solo aspiran a los roles que
    // su límite aguanta. Que un modelo sea gratis no lo hace apto para una tarde de implementación.
    const allowedRoles = ((ALIASES.providers || {})[m.provider] || {}).roles;
    if (allowedRoles && !allowedRoles.includes(role)) continue;
    const freeRoles = (ALIASES.freeTierRoles || {}).roles;
    if (m.free && m.provider === 'openrouter' && freeRoles && !freeRoles.includes(role)) continue;
    if (p.sensitive && sensitivity === 'client' && m.data.policy === 'retains') continue;
    const zs = p.metrics.map((k) => z[k](m)).filter((v) => v != null);
    if (p.metrics.length && !zs.length) continue;         // sin ninguna métrica no hay ranking, solo adivinar
    const quality = zs.length ? zs.reduce((a, b) => a + b, 0) / zs.length : 0;
    const priceOut = m.price_out == null ? 5 : m.price_out;  // desconocido se trata como caro, no como gratis
    const score = quality - p.price * Math.log10(1 + priceOut);
    if (m.data.policy === 'unknown' && p.sensitive) why.push('política de datos no verificada');
    if (m.price_out == null) why.push('precio desconocido');
    if (m.provider === 'nvidia') why.push('cuota NIM: 40 rpm');
    if (m.free && m.provider === 'openrouter') why.push('free OR: 20 rpm, 50-1000/día');
    out.push({ m, score, quality, zs: zs.length, why });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 3);
}

function currentLineup(projectPath) {
  const read = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
  const g = read(GLOBAL_LINEUP);
  const pr = projectPath ? read(projectPath) : null;
  const merged = mergeLineups(g, pr);
  const sensitivity = (pr && pr.sensitivity) || (g && g.sensitivity) || 'client';
  const pi = (merged.harness && merged.harness.pi) || {};
  return { pi, sensitivity };
}

// ── informe ───────────────────────────────────────────────────────────────────────────────────────
function render(result) {
  const L = [];
  const { sources, current, sensitivity, suggestions, freeOR, unmapped, probe } = result;
  L.push(`# Asesor de line-up — ${TODAY}`, '');
  L.push(`Sensibilidad del repo: **${sensitivity}**${sensitivity === 'client' ? ' (los roles que ven código no reciben proveedores que retienen prompts)' : ''}.`, '');
  L.push('## Fuentes', '');
  for (const [k, s] of Object.entries(sources)) {
    L.push(`- ${k}: ${s.ok ? `${s.rows.length} filas` : `**FALLÓ** — ${s.error}`}${s.note ? ` _(${s.note})_` : ''}${s.fetchedAt ? ` · ${s.fetchedAt.slice(0, 16)}` : ''}`);
  }
  L.push('', 'SWE-bench Verified son cifras que cada laboratorio reporta con su propio agente; sirven para ordenar, no para comparar al décimo. LMArena `agent` es una puntuación distinta (0-1), se usa solo como z-score.', '');
  L.push('Reglas fijas: NIM (40 rpm, créditos finitos) y los gratis de OpenRouter (20 rpm, 50-1000/día) solo aspiran a `explainer`/`preflight` (NIM solo `explainer`); ollama solo si el modelo está descargado. Familias independientes: reviewer ≠ implementer; judge ≠ implementer y reviewer; critic y scorer ≠ implementer. En repo `client`, ningún proveedor que retiene prompts en roles que ven código.', '');

  L.push('## Diff contra el line-up actual', '', '| rol | actual | sugerido | por qué |', '|---|---|---|---|');
  for (const role of ROLES) {
    const cur = current[role] ? `${current[role].provider}/${current[role].model}` : '—';
    const top = suggestions[role] && suggestions[role][0];
    if (!top) { L.push(`| ${role} | ${cur} | _(sin candidato que cumpla el perfil)_ | |`); continue; }
    const same = top.m.id === cur;
    const reason = same ? 'ya es el mejor según las fuentes' : `${p2(top, PROFILES[role].metrics)}${top.why.length ? ` · ⚠ ${top.why.join(', ')}` : ''}`;
    L.push(`| ${role} | ${cur} | ${same ? '=' : `**${top.m.id}**`} | ${reason} |`);
  }
  L.push('');

  L.push('## Top 3 por rol', '');
  for (const role of ROLES) {
    const p = PROFILES[role];
    L.push(`### ${role} — ${p.metrics.length ? p.metrics.join(' + ') : 'cualquiera con tools'}; precio λ=${p.price}${p.minCtx ? `; ctx ≥ ${K(p.minCtx)}` : ''}${p.minOut ? `; salida ≥ ${K(p.minOut)}` : ''}${p.json ? '; JSON estricto' : ''}`, '');
    const list = suggestions[role] || [];
    if (!list.length) { L.push('_(ningún candidato cumple los requisitos duros)_', ''); continue; }
    L.push('| # | modelo | métricas | $in/$out por M | ctx / out | datos | notas |', '|---|---|---|---|---|---|---|');
    list.forEach((s, i) => L.push(`| ${i + 1} | \`${s.m.id}\` | ${p2(s)} | ${money(s.m.price_in)} / ${money(s.m.price_out)} | ${K(s.m.ctx)} / ${K(s.m.max_out)} | ${s.m.data.policy} (${s.m.data.who}) | ${[...s.why, s.m.note ? '⚠ ver notas' : ''].filter(Boolean).join('; ')} |`));
    L.push('');
  }

  L.push('## Gratis en OpenRouter hoy', '', 'Límites: 20 req/min; 50 req/día sin compra, 1.000/día con ≥ $10 acumulados (de por vida). Una cuenta en negativo bloquea también los gratis.', '');
  L.push('| id | ctx / out | sirve | datos | JSON | tools | nota |', '|---|---|---|---|---|---|---|');
  for (const f of freeOR.sort((a, b) => (b.ctx || 0) - (a.ctx || 0))) {
    const json = f.params.includes('structured_outputs') ? 'strict' : f.params.includes('response_format') ? 'format' : '—';
    L.push(`| \`${f.id}\` | ${K(f.ctx || 0)} / ${K(f.max_out || 0)} | ${f.provider || '?'}${f.quant && f.quant !== 'unknown' ? ` ${f.quant}` : ''} | ${f.data.policy} | ${json} | ${f.params.includes('tools') ? 'sí' : '—'} | ${f.note ? f.note : ''} |`);
  }
  L.push('');

  if (probe) {
    L.push('## Probe del line-up sugerido', '', '```', probe.trim(), '```', '');
  }

  L.push('## No pude mapear', '', 'Nombres que alguna fuente rankea y que no casaron con ningún id del catálogo de Pi. Si alguno es un modelo que sí tienes, añádelo a `scripts/lineup-aliases.json`.', '');
  const bySrc = {};
  for (const u of unmapped) (bySrc[u.source] = bySrc[u.source] || new Set()).add(u.name);
  for (const [s, names] of Object.entries(bySrc)) L.push(`- **${s}** (${names.size}): ${[...names].slice(0, 40).join(', ')}${names.size > 40 ? ', …' : ''}`);
  L.push('');
  L.push('---', 'Datos: Artificial Analysis (artificialanalysis.ai), LMArena (lmarena.ai, CC-BY-4.0), SWE-bench (swebench.com), OpenRouter (openrouter.ai). Aplica cambios con `/line-up` en Pi o `bin/lineup` en terminal; nada de esto se aplica solo.');
  return L.join('\n');

  function p2(s, only) {
    const parts = [];
    for (const k of only && only.length ? only : ['intelligence', 'coding', 'agentic', 'swe', 'lm_coding', 'lm_hard', 'lm_webdev', 'lm_agent']) {
      if (s.m.metrics[k] != null) parts.push(`${k}=${k.startsWith('lm_') && k !== 'lm_agent' ? Math.round(s.m.metrics[k]) : Number(s.m.metrics[k]).toFixed(k === 'lm_agent' ? 3 : 1)}`);
    }
    return parts.join(' ') || '—';
  }
}

// ── main ──────────────────────────────────────────────────────────────────────────────────────────
async function main() {
  const argv = process.argv.slice(2);
  const opts = {
    offline: argv.includes('--offline'), fixtures: opt(argv, '--fixtures', null),
    out: opt(argv, '--out', AGENTS_DIR), project: opt(argv, '--project', path.join(process.cwd(), '.agents', 'model-lineup.json')),
    probe: argv.includes('--probe') || (!argv.includes('--no-probe') && !argv.includes('--offline')), json: argv.includes('--json'),
  };
  const [aa, lmarena, swebench, openrouter] = await Promise.all([srcAA(opts), srcLMArena(opts), srcSWE(opts), srcOpenRouter(opts)]);
  const pi = srcPi(opts);
  const sources = { AA: aa, LMArena: lmarena, 'SWE-bench': swebench, OpenRouter: openrouter, Pi: pi };
  if (!pi.ok) { process.stderr.write(`lineup-advise: sin catálogo de Pi no hay nada que sugerir — ${pi.error}\n`); process.exit(1); }

  const { models, unmapped, freeOR } = buildTable({ aa, lmarena, swebench, openrouter }, pi.rows);
  const { pi: current, sensitivity } = currentLineup(opts.project);

  // Orden de resolución: implementer y reviewer primero, porque los demás asientos se definen contra
  // ellos. `suggestions` se rellena en ese orden y INDEPENDENT_OF lee lo ya decidido.
  const suggestions = {};
  const order = ['implementer', 'reviewer', ...ROLES.filter((r) => r !== 'implementer' && r !== 'reviewer')];
  for (const role of order) {
    const excl = new Set((INDEPENDENT_OF[role] || [])
      .map((dep) => suggestions[dep] && suggestions[dep][0] && familyOf({ model: suggestions[dep][0].m.model }))
      .filter(Boolean));
    suggestions[role] = rankRole(role, models, sensitivity, excl);
  }

  let probe = null;
  if (opts.probe) {
    const proposed = { version: 1, defaults: {}, harness: { pi: {} } };
    for (const role of ROLES) if (suggestions[role][0]) proposed.harness.pi[role] = { provider: suggestions[role][0].m.provider, model: suggestions[role][0].m.model };
    const tmp = path.join(os.tmpdir(), `lineup-advise-${process.pid}.json`);
    fs.writeFileSync(tmp, JSON.stringify(proposed));
    try {
      probe = execFileSync('node', [path.join(__dirname, 'model-lineup.js'), 'check', '--file', tmp, '--probe'], { encoding: 'utf8', timeout: 20 * 60 * 1000, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { probe = `${e.stdout || ''}\n${e.stderr || ''}`; }
    fs.unlinkSync(tmp);
  }

  const result = { date: TODAY, sensitivity, sources: Object.fromEntries(Object.entries(sources).map(([k, s]) => [k, { ok: s.ok, rows: s.rows, error: s.error, note: s.note, fetchedAt: s.fetchedAt }])), current, suggestions, freeOR, unmapped, probe };
  fs.mkdirSync(opts.out, { recursive: true });
  const md = render(result);
  fs.writeFileSync(path.join(opts.out, 'lineup-advice.md'), md);
  fs.writeFileSync(path.join(opts.out, 'lineup-advice.json'), JSON.stringify({
    ...result,
    sources: Object.fromEntries(Object.entries(result.sources).map(([k, s]) => [k, { ok: s.ok, n: s.rows.length, error: s.error, note: s.note, fetchedAt: s.fetchedAt }])),
    suggestions: Object.fromEntries(Object.entries(suggestions).map(([r, l]) => [r, l.map((s) => ({ id: s.m.id, provider: s.m.provider, model: s.m.model, score: +s.score.toFixed(3), metrics: s.m.metrics, price_in: s.m.price_in, price_out: s.m.price_out, ctx: s.m.ctx, max_out: s.m.max_out, data: s.m.data, why: s.why, note: s.m.note }))])),
    freeOR: freeOR.map((f) => ({ id: f.id, ctx: f.ctx, max_out: f.max_out, provider: f.provider, data: f.data, params: f.params, note: f.note })),
  }, null, 2));
  if (opts.json) process.stdout.write(`${JSON.stringify({ suggestions: Object.fromEntries(Object.entries(suggestions).map(([r, l]) => [r, l.map((s) => s.m.id)])) })}\n`);
  else process.stdout.write(`${md}\n`);
}

if (require.main === module) main().catch((e) => { process.stderr.write(`lineup-advise: ${e.stack || e}\n`); process.exit(1); });

module.exports = { normalize, PROFILES, INDEPENDENT_OF, rankRole, buildTable, render, srcAA, srcLMArena, srcSWE, srcOpenRouter, srcPi };
