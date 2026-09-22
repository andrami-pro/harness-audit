#!/usr/bin/env node
// jev-setup — turn TypeSafe Jev on for this machine, or say why it is off.
//
//   jev-setup            report status; without a key and on a TTY, ask for one, store it, ping
//   jev-setup --status   exit 0 = key present, 3 = absent (install.sh reads this)
//   jev-setup --key <k>  store the key without asking, then ping
//   jev-setup --ping     one round trip; prints OK or the error; never writes
//
// The key lives in ~/.agents/secrets.env (mode 0600), the file lineup-advise already reads — one
// place, outside every repo, never committed. Storing it is the whole consent: from then on every
// Jev path in this package is live on this machine, in every project. `TYPESAFE_API_KEY=off` in the
// same file pauses it without deleting it.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const jev = require('./jev.js');

function storeKey(key) {
  const dir = path.dirname(jev.SECRETS);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let lines = [];
  try { lines = fs.readFileSync(jev.SECRETS, 'utf8').split('\n'); } catch { /* new file */ }
  const kept = lines.filter((l) => !l.startsWith(`${jev.KEY_NAME}=`));
  while (kept.length && kept[kept.length - 1] === '') kept.pop();
  kept.push(`${jev.KEY_NAME}=${key}`);
  fs.writeFileSync(jev.SECRETS, `${kept.join('\n')}\n`, { mode: 0o600 });
  fs.chmodSync(jev.SECRETS, 0o600);
}

async function ping() {
  try {
    const p = await jev.noul('2 and 1', 'Is the first number greater than the second?', { timeoutMs: 15000, waits: [] });
    if (!(p >= 0 && p <= 1)) throw new Error(`unexpected answer ${p}`);
    process.stdout.write(`OK — api.typesafe.ai answered (p=${p.toFixed(2)})\n`);
    return 0;
  } catch (e) {
    process.stdout.write(`FAILED — ${e.message}\n`);
    return e.status === 401 ? 4 : 1;
  }
}

function askKey() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('Do you have a TypeSafe (Jev) API key? Paste it, or press Enter to skip: ', (a) => { rl.close(); resolve(a.trim()); });
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const st = jev.status();
  if (argv.includes('--status')) {
    process.stdout.write(st.enabled ? `on (${st.source})\n` : 'off\n');
    process.exit(st.enabled ? 0 : 3);
  }
  if (argv.includes('--ping')) {
    if (!st.enabled) { process.stdout.write('off — no TYPESAFE_API_KEY\n'); process.exit(3); }
    process.exit(await ping());
  }
  const ki = argv.indexOf('--key');
  let key = ki !== -1 ? argv[ki + 1] : null;
  if (key === undefined || key === '') { process.stderr.write('usage: jev-setup [--status|--ping|--key <key>]\n'); process.exit(1); }
  if (!key) {
    if (st.enabled) { process.stdout.write(`Jev is on (${st.source}). Pinging…\n`); process.exit(await ping()); }
    if (!process.stdin.isTTY) { process.stdout.write('off — no TYPESAFE_API_KEY and no TTY to ask for one. Use --key <key>.\n'); process.exit(3); }
    key = await askKey();
    if (!key) { process.stdout.write('Skipped. Jev stays off; nothing leaves this machine.\n'); process.exit(3); }
  }
  storeKey(key);
  process.stdout.write(`Stored ${jev.KEY_NAME} in ${jev.SECRETS} (0600). Pinging…\n`);
  process.exit(await ping());
}

main().catch((e) => { process.stderr.write(`jev-setup: ${e.message}\n`); process.exit(1); });
