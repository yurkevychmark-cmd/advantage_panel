#!/usr/bin/env node
// After-import proof with the portal's OWN formulas: runs the built app (v10/app.<hash>.js, same sandbox as
// tests/verify.test.mjs) and checks the live database against the sheets and against the pre-import state.
//
//   node portal_check.mjs <payload.json> <after.json> [<before.json>]
//     after / before — database snapshots in the Full-backup format (finportal-dump.mjs output, or a decrypted
//     nightly backup); process substitution works, so nothing has to be written to disk:
//     node portal_check.mjs payload.json <(ssh … node finportal-dump.mjs) <(node age-lite.mjs decrypt KEY old.dump.age)
//
// 1) every total each sheet shows = FIN.monthTotals / per-person pay of that month in the database (after the
//    differences the payload explains: amounts typed as text, cells outside the sheet's SUM range)
// 2) with <before>: account balances and limit usage (FIN.accountUsage), agency balance, and the carryover of
//    every month from 2025-08 on are exactly what they were before the import.
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const appFile = readdirSync(join(ROOT, 'v10')).find(f => /^app\.[0-9a-f]{10}\.js$/.test(f));
const noop = () => {};
const React = { createElement: () => null, Fragment: 'F', useState: (v) => [typeof v === 'function' ? v() : v, noop], useEffect: noop, useRef: (v) => ({ current: v }), useCallback: (f) => f, useMemo: (f) => f() };
const ctx = { React, ReactDOM: { createRoot: () => ({ render: noop }) }, document: { getElementById: () => ({}), addEventListener: noop, removeEventListener: noop, visibilityState: 'visible' },
  localStorage: { getItem: () => null, setItem: noop, removeItem: noop }, fetch: () => Promise.reject(new Error('offline')),
  console, setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, JSON, Promise };
ctx.window = ctx; ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext("var supabase = { createClient: function () { return { auth: {}, from: function () { return {}; } }; } };", ctx);
vm.runInContext(readFileSync(join(ROOT, 'v10', appFile), 'utf8'), ctx, { filename: appFile });
const T = ctx.__ADV_PORTAL__;

const [payloadPath, afterPath, beforePath] = process.argv.slice(2);
const p = JSON.parse(readFileSync(payloadPath, 'utf8'));
const load = (f) => { const b = JSON.parse(readFileSync(f, 'utf8')); return { gs: b.global_settings[0], md: Object.fromEntries(b.monthly_data.map(r => [r.month_key, T.splitRev(r.data)[0]])) }; };
const after = load(afterPath);
const names = Object.fromEntries((after.gs.workers || []).map(w => [w.id, w.name]));
const MON = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');
const near = (a, b) => Math.abs(a - b) < 0.005;
let bad = 0;

console.log(`portal formulas from ${appFile}\n1) sheets vs database (FIN.monthTotals, per-person pay)`);
for (const [k, rc] of Object.entries(p.reconcile)) {
  const m = after.md[k];
  if (!m) { console.log(`  ✗ ${k}: month missing in the database`); bad++; continue; }
  const tot = T.FIN.monthTotals(m);
  const pay = {};
  (m.transactions || []).forEach(t => Object.entries(t.workerPay || {}).forEach(([id, x]) => { const a = T.parseNum(x.amount); if (a) pay[names[id] || id] = (pay[names[id] || id] || 0) + a; }));
  const actual = (f) => f.startsWith('pay:') ? (pay[f.slice(4)] || 0) : f === 'revenue' ? tot.revenue : f === 'turnover' ? tot.turnover : tot.expenses;
  const res = [];
  for (const c of rc.checks) {
    if (c.shown === null) continue;
    const expl = c.outsideRange.reduce((s, x) => s + x[2], 0) - c.notImported.reduce((s, x) => s + x[2], 0) + c.textAmounts.reduce((s, x) => s + x[2], 0);
    const ok = near(c.shown + expl, actual(c.field));
    if (!ok) { bad++; res.push(`✗ ${c.field}: sheet ${c.shown}${expl ? ` (+${expl} explained)` : ''} ≠ portal ${actual(c.field)}`); }
    else res.push(c.field);
  }
  const [y, mi] = k.split('-').map(Number);
  const fails = res.filter(r => r.startsWith('✗'));
  console.log(`  ${fails.length ? '✗' : '✓'} ${MON[mi]} ${y}: turnover ${tot.turnover} · REV ${tot.revenue} · expenses ${+tot.expenses.toFixed(2)} · ${res.length - fails.length}/${res.length} sheet totals match${fails.length ? '\n      ' + fails.join('\n      ') : ''}`);
}

if (beforePath) {
  const before = load(beforePath);
  console.log('2) today\'s numbers before vs after the import');
  const ua = T.FIN.accountUsage(after.gs.accounts, after.md), ub = T.FIN.accountUsage(before.gs.accounts, before.md);
  const accDiff = ub.filter((a, i) => !near(a.accountBudget, ua[i].accountBudget) || !near(a.used, ua[i].used)).map(a => a.name);
  if (accDiff.length) bad++;
  console.log(`  ${accDiff.length ? '✗' : '✓'} ${ub.length} agency accounts: balance and limit usage unchanged${accDiff.length ? ' — changed: ' + accDiff.join(', ') : ''}`);
  const aa = T.FIN.agencyBalance(ua).total, ab = T.FIN.agencyBalance(ub).total;
  if (!near(aa, ab)) bad++;
  console.log(`  ${near(aa, ab) ? '✓' : '✗'} agency balance $${ab.toFixed(2)} → $${aa.toFixed(2)}`);
  const later = Object.keys(before.md).filter(k => { const [y, m] = k.split('-').map(Number); return y * 12 + m >= 2025 * 12 + 8; });
  const carryDiff = later.filter(k => { const [y, m] = k.split('-').map(Number); return !near(T.FIN.carryInfo(before.md, y, m).carry, T.FIN.carryInfo(after.md, y, m).carry); });
  if (carryDiff.length) bad++;
  console.log(`  ${carryDiff.length ? '✗' : '✓'} carryover of ${later.length} months from Sep 2025 on unchanged${carryDiff.length ? ' — changed: ' + carryDiff.join(', ') : ''}`);
  const tb = T.FIN.periodReport(before.md, '2025-09-01', '2027-12-31'), ta = T.FIN.periodReport(after.md, '2025-09-01', '2027-12-31');
  const same = ['turnover', 'revenue', 'expenses', 'deals'].every(f => near(tb[f], ta[f]));
  if (!same) bad++;
  console.log(`  ${same ? '✓' : '✗'} period report 01.09.2025–31.12.2027 unchanged (turnover ${ta.turnover}, REV ${ta.revenue}, expenses ${+ta.expenses.toFixed(2)}, ${ta.deals} deals)`);
}
console.log(bad ? `\n${bad} PROBLEM(S)` : '\nALL CHECKS PASS');
process.exit(bad ? 1 : 0);
