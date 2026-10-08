#!/usr/bin/env node
// Write a sheets_import.py payload into the finance-portal database (Supabase) — safely and repeatably.
//
//   node apply_import.mjs [--apply] < payload.json        (without --apply: dry run, nothing is written)
//
// Runs on the server next to the backup (FINPORTAL_SUPABASE_URL / FINPORTAL_SERVICE_ROLE_KEY from backup.env — the key
// is only read from the environment, never printed). Rules:
//   * Only the payload's target months are touched, never a month of 2026 or later.
//   * A month is written only if it is empty or holds nothing but records of an earlier run of this import
//     (every deal/expense has importedFrom "sheets…", no transfers/cash-outs). Anything entered by hand → skipped.
//   * The write is a compare-and-set on data._rev (the portal's own save protocol), so a portal open at the same
//     moment gets a normal "changed elsewhere" conflict instead of a silent overwrite.
//   * Same payload again → every month reports "unchanged" and nothing is written: re-running cannot duplicate.
//   * Departed members are appended to global_settings.workers by their fixed ids; existing members are untouched.
// Afterwards it re-reads the database and proves: target months hold exactly the payload, ids are unique, and every
// other month, the existing workers, accounts and products are byte-identical (sha256 of canonical JSON) to before.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const BASE = (process.env.FINPORTAL_SUPABASE_URL || '').replace(/\/+$/, '');
const KEY = process.env.FINPORTAL_SERVICE_ROLE_KEY || '';
const APPLY = process.argv.includes('--apply');
const die = (m) => { console.error(`apply_import: ${m}`); process.exit(1); };
if (!BASE || !KEY) die('FINPORTAL_SUPABASE_URL and FINPORTAL_SERVICE_ROLE_KEY must be set (backup.env)');

const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
const canon = (v) => JSON.stringify(v === undefined ? null : v, (k, val) => (val && typeof val === 'object' && !Array.isArray(val)) ? Object.keys(val).sort().reduce((o, key) => { o[key] = val[key]; return o; }, {}) : val);
const sha = (v) => createHash('sha256').update(canon(v)).digest('hex').slice(0, 16);
const ym = (k) => { const [y, m] = k.split('-').map(Number); return y * 12 + m; };
const isImported = (r) => typeof r?.importedFrom === 'string' && r.importedFrom.startsWith('sheets');

async function rest(method, path, body, prefer) {
  const r = await fetch(`${BASE}/rest/v1/${path}`, { method, headers: { ...H, ...(prefer ? { Prefer: prefer } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  if (!r.ok) { const e = new Error(`${method} ${path.split('?')[0]} → HTTP ${r.status}: ${text.slice(0, 200)}`); e.status = r.status; throw e; }
  return text ? JSON.parse(text) : null;
}
const snapshot = async () => {
  const [gs] = await rest('GET', 'global_settings?select=*&id=eq.1');
  const rows = await rest('GET', 'monthly_data?select=month_key,data&order=month_key');
  return { gs, months: Object.fromEntries(rows.map(r => [r.month_key, r.data])) };
};

const p = JSON.parse(readFileSync(0, 'utf8'));
if (p.kind !== 'finportal-sheets-import' || !Array.isArray(p.targets) || !p.months) die('stdin is not a sheets_import.py payload');
for (const k of p.targets) {
  if (!/^\d{4}-\d{1,2}$/.test(k) || !p.months[k]) die(`bad target ${k}`);
  if (Math.floor(ym(k) / 12) >= 2026) die(`refusing to touch ${k}: months of 2026+ are live data`);
}
const allIds = p.targets.flatMap(k => [...p.months[k].transactions, ...p.months[k].expenses].map(r => r.id));
if (new Set(allIds).size !== allIds.length) die('payload has duplicate record ids');

console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} · ${p.targets.length} target months · ${allIds.length} records · ${p.workersToAdd.length} departed members`);
const before = await snapshot();
if (!before.gs) die('global_settings row 1 not found');

// ---- departed members
const workers = before.gs.workers || [];
const byId = new Set(workers.map(w => w.id));
const toAdd = [];
for (const w of p.workersToAdd) {
  if (byId.has(w.id)) continue;
  const clash = workers.find(x => x.name.trim().toLowerCase() === w.name.trim().toLowerCase());
  if (clash) die(`a member named "${w.name}" already exists with another id — re-run sheets_import.py with a fresh backup as --roster`);
  toAdd.push(w);
}
console.log(`workers: ${workers.length} in the portal · to add ${toAdd.length}${toAdd.length ? ' (' + toAdd.map(w => `${w.name} left ${w.leftAt}`).join(', ') + ')' : ''}`);
if (APPLY && toAdd.length) {
  const up = await rest('PATCH', 'global_settings?id=eq.1', { workers: [...workers, ...toAdd] }, 'return=representation');
  if (!up || up.length !== 1) die('global_settings: the update touched no row');
}

// ---- months
const result = {};
for (const k of p.targets) {
  const want = p.months[k];
  const cur = before.months[k];
  if (cur === undefined) {
    const data = { transactions: want.transactions, expenses: want.expenses, transfers: [], cashouts: [], carryover: 0, _rev: 1 };
    if (APPLY) {
      try { await rest('POST', 'monthly_data', { month_key: k, data }, 'return=representation'); result[k] = 'inserted'; }
      catch (e) { result[k] = e.status === 409 ? 'skipped: created by someone meanwhile — run again' : `ERROR ${e.message}`; }
    } else result[k] = 'would insert (no row yet)';
    continue;
  }
  const d = cur || {};
  const foreign = [...(d.transactions || []), ...(d.expenses || [])].filter(r => !isImported(r)).length + (d.transfers || []).length + (d.cashouts || []).length;
  if (foreign) { result[k] = `SKIPPED: ${foreign} record(s) not from this import — left untouched`; continue; }
  if (canon(d.transactions || []) === canon(want.transactions) && canon(d.expenses || []) === canon(want.expenses)) { result[k] = 'unchanged'; continue; }
  const base = d._rev ?? null;
  const next = (typeof base === 'number' ? base : 0) + 1;
  const data = { ...d, transactions: want.transactions, expenses: want.expenses, _rev: next };
  if (!APPLY) { result[k] = `would update (${(d.transactions || []).length + (d.expenses || []).length} → ${want.transactions.length + want.expenses.length} records)`; continue; }
  const filter = base === null ? 'data->>_rev=is.null' : `data->>_rev=eq.${encodeURIComponent(String(base))}`;
  const up = await rest('PATCH', `monthly_data?month_key=eq.${encodeURIComponent(k)}&${filter}`, { data }, 'return=representation');
  result[k] = up && up.length === 1 ? 'updated' : 'SKIPPED: changed in the portal meanwhile (revision moved) — run again';
}
for (const k of p.targets) console.log(`  ${k.padEnd(8)} ${result[k]}  (${p.months[k].transactions.length} deals, ${p.months[k].expenses.length} expenses)`);

// ---- proof from the database itself
const after = await snapshot();
const problems = [];
for (const k of p.targets) {
  if (!APPLY || !/^(inserted|updated|unchanged)$/.test(result[k])) continue;
  const d = after.months[k] || {};
  if (canon(d.transactions) !== canon(p.months[k].transactions) || canon(d.expenses) !== canon(p.months[k].expenses)) problems.push(`${k}: stored records differ from the payload`);
}
const dbIds = Object.values(after.months).flatMap(d => [...(d?.transactions || []), ...(d?.expenses || [])].map(r => r.id)).filter(Boolean);
const dupes = dbIds.filter((id, i) => dbIds.indexOf(id) !== i);
if (dupes.length) problems.push(`duplicate record ids in the database: ${[...new Set(dupes)].slice(0, 5).join(', ')}`);
const untouched = Object.keys(before.months).filter(k => !p.targets.includes(k));
const changed = untouched.filter(k => sha(before.months[k]) !== sha(after.months[k]));
if (changed.length) problems.push(`months outside the import changed meanwhile: ${changed.join(', ')} (by someone else? check)`);
const oldWorkers = after.gs.workers.filter(w => byId.has(w.id));
if (sha(oldWorkers) !== sha(workers)) problems.push('existing workers differ from before');
if (sha(after.gs.accounts) !== sha(before.gs.accounts) || sha(after.gs.products) !== sha(before.gs.products)) problems.push('accounts/products differ from before');
const imported = Object.values(after.months).flatMap(d => [...(d?.transactions || []), ...(d?.expenses || [])]).filter(isImported).length;
console.log(`check: ${untouched.length} other months byte-identical (sha256) ${changed.length ? '✗' : '✓'} · existing ${workers.length} workers, accounts, products unchanged ${problems.some(x => /workers|accounts/.test(x)) ? '✗' : '✓'} · `
  + `${dbIds.length} record ids in the database, ${dupes.length} duplicates · imported records in the database: ${imported} · members: ${after.gs.workers.length}`);
if (problems.length) { console.log('PROBLEMS:\n  ' + problems.join('\n  ')); process.exit(2); }
console.log(APPLY ? 'OK' : 'OK (dry run — nothing written)');
