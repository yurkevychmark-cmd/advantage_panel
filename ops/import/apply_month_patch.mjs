#!/usr/bin/env node
// Write hand-checked corrections of existing months into the finance-portal database — safely and repeatably.
//
//   node apply_month_patch.mjs [--apply] < patch.json        (without --apply: dry run, nothing is written)
//
// patch.json: { kind: "finportal-month-patch", source, months: { "<month_key>": { before: <data>, after: <data> } } }
// — `before` is the month exactly as it was in the backup the patch was built from, `after` is what it should become.
// Runs on the server next to the backup (FINPORTAL_SUPABASE_URL / FINPORTAL_SERVICE_ROLE_KEY from backup.env — the key
// is only read from the environment, never printed). Rules:
//   * A month is written only if the database still holds exactly `before` (canonical JSON). If someone changed it
//     since the backup → skipped, nothing is merged: rebuild the patch from a fresh backup.
//   * The write is a compare-and-set on data._rev (the portal's own save protocol), so a portal open at the same
//     moment gets a normal "changed elsewhere" conflict instead of a silent overwrite.
//   * A month already equal to `after` reports "unchanged": re-running cannot apply anything twice.
// Afterwards it re-reads the database and proves: patched months hold exactly `after`, record ids are unique, and every
// other month and global_settings are byte-identical (sha256 of canonical JSON) to before.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const BASE = (process.env.FINPORTAL_SUPABASE_URL || '').replace(/\/+$/, '');
const KEY = process.env.FINPORTAL_SERVICE_ROLE_KEY || '';
const APPLY = process.argv.includes('--apply');
const die = (m) => { console.error(`apply_month_patch: ${m}`); process.exit(1); };
if (!BASE || !KEY) die('FINPORTAL_SUPABASE_URL and FINPORTAL_SERVICE_ROLE_KEY must be set (backup.env)');

const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
const canon = (v) => JSON.stringify(v === undefined ? null : v, (k, val) => (val && typeof val === 'object' && !Array.isArray(val)) ? Object.keys(val).sort().reduce((o, key) => { o[key] = val[key]; return o; }, {}) : val);
const sha = (v) => createHash('sha256').update(canon(v)).digest('hex').slice(0, 16);
const noRev = (d) => { const { _rev, ...rest } = d || {}; return rest; };

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
if (p.kind !== 'finportal-month-patch' || !p.months || !Object.keys(p.months).length) die('stdin is not a month patch');
const keys = Object.keys(p.months);
for (const k of keys) {
  if (!/^\d{4}-\d{1,2}$/.test(k) || !p.months[k].before || !p.months[k].after) die(`bad month ${k}`);
  const ids = [...(p.months[k].after.transactions || []), ...(p.months[k].after.expenses || [])].map(r => r.id);
  if (ids.some(id => !id) || new Set(ids).size !== ids.length) die(`${k}: missing or duplicate record ids in "after"`);
}

console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} · ${p.source || 'patch'} · ${keys.length} months`);
const before = await snapshot();
if (!before.gs) die('global_settings row 1 not found');

const result = {};
for (const k of keys) {
  const { before: was, after: want } = p.months[k];
  const cur = before.months[k];
  if (cur === undefined) { result[k] = 'SKIPPED: no such month in the database'; continue; }
  if (canon(noRev(cur)) === canon(noRev(want))) { result[k] = 'unchanged'; continue; }
  if (canon(cur) !== canon(was)) { result[k] = 'SKIPPED: changed since the backup — rebuild the patch from a fresh backup'; continue; }
  const base = cur._rev ?? null;
  const data = { ...want, _rev: (typeof base === 'number' ? base : 0) + 1 };
  if (!APPLY) { result[k] = `would update (${(cur.expenses || []).length} → ${(want.expenses || []).length} expenses)`; continue; }
  const filter = base === null ? 'data->>_rev=is.null' : `data->>_rev=eq.${encodeURIComponent(String(base))}`;
  const up = await rest('PATCH', `monthly_data?month_key=eq.${encodeURIComponent(k)}&${filter}`, { data }, 'return=representation');
  result[k] = up && up.length === 1 ? 'updated' : 'SKIPPED: changed in the portal meanwhile (revision moved) — run again';
}
for (const k of keys) console.log(`  ${k.padEnd(8)} ${result[k]}`);

// ---- proof from the database itself
const after = await snapshot();
const problems = [];
for (const k of keys) {
  if (!APPLY || !/^(updated|unchanged)$/.test(result[k])) continue;
  if (canon(noRev(after.months[k])) !== canon(noRev(p.months[k].after))) problems.push(`${k}: stored month differs from the patch`);
}
const dbIds = Object.values(after.months).flatMap(d => [...(d?.transactions || []), ...(d?.expenses || [])].map(r => r.id)).filter(Boolean);
const dupes = dbIds.filter((id, i) => dbIds.indexOf(id) !== i);
if (dupes.length) problems.push(`duplicate record ids in the database: ${[...new Set(dupes)].slice(0, 5).join(', ')}`);
const untouched = Object.keys(before.months).filter(k => !keys.includes(k));
const changed = untouched.filter(k => sha(before.months[k]) !== sha(after.months[k]));
if (changed.length) problems.push(`months outside the patch changed meanwhile: ${changed.join(', ')} (by someone else? check)`);
if (sha(after.gs) !== sha(before.gs)) problems.push('global_settings changed meanwhile');
console.log(`check: ${untouched.length} other months byte-identical (sha256) ${changed.length ? '✗' : '✓'} · global_settings unchanged ${sha(after.gs) === sha(before.gs) ? '✓' : '✗'} · `
  + `${dbIds.length} record ids in the database, ${dupes.length} duplicates`);
if (problems.length) { console.log('PROBLEMS:\n  ' + problems.join('\n  ')); process.exit(2); }
console.log(APPLY ? 'OK' : 'OK (dry run — nothing written)');
