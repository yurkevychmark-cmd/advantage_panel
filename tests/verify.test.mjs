// Finance portal tests. Runs the BUILT app (v10/app.<hash>.js) in a Node sandbox with React/DOM stubbed, then calls
// the portal's own pure functions (FIN.*, date/JSON helpers) — so these tests check the formulas that actually ship.
// Optional: FINPORTAL_BACKUP=<full-backup.json> also sanity-checks every month of a real backup (no NaN, money equation).
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const appFile = readdirSync(join(ROOT, 'v10')).find(f => /^app\.[0-9a-f]{10}\.js$/.test(f));
if (!appFile) { console.error('no v10/app.<hash>.js — run ./build.sh'); process.exit(1); }

// ---- sandbox: just enough browser for the app's top level to run (components are defined, nothing renders) ----
const noop = () => {};
const hook = (v) => [v, noop];
const React = { createElement: (...args) => { React.lastCall = args; return null; }, Fragment: 'F', useState: (v) => hook(typeof v === 'function' ? v() : v), useEffect: noop, useRef: (v) => ({ current: v }), useCallback: (f) => f, useMemo: (f) => f() };
const store = {};
const ctx = {
  React, ReactDOM: { createRoot: () => ({ render: noop }) },
  document: { getElementById: () => ({}), addEventListener: noop, removeEventListener: noop, visibilityState: 'visible' },
  localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
  fetch: () => Promise.reject(new Error('no network in tests')),
  console, setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, JSON, Promise,
};
ctx.window = ctx; ctx.globalThis = ctx;
vm.createContext(ctx);
// Declare library globals the way the real UMD bundles do (`var supabase = …`), so a top-level name clash in the app
// fails here exactly as it would in the browser ("Identifier 'supabase' has already been declared").
vm.runInContext("var supabase = { createClient: function () { return { auth: {}, from: function () { return {}; } }; } };", ctx, { filename: 'vendor-stub.js' });
vm.runInContext(readFileSync(join(ROOT, 'v10', appFile), 'utf8'), ctx, { filename: appFile });
const T = ctx.__ADV_PORTAL__;
if (!T || !T.FIN) { console.error('app did not expose window.__ADV_PORTAL__ — top-level script failed?'); process.exit(1); }

// ---- tiny runner ----
let pass = 0, fail = 0;
const near = (a, b) => Math.abs(a - b) < 0.005;
const t = (name, fn) => { try { fn(); pass++; console.log('  ✓ ' + name); } catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + e.message); } };
const eq = (got, want, what = '') => { const ok = typeof want === 'number' ? near(got, want) : JSON.stringify(got) === JSON.stringify(want); if (!ok) throw new Error(`${what} expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`); };

// ---- fixture: three months around a year boundary ----
const W = [{ id: 'a' }, { id: 'b' }];
const deal = (o) => ({ status: 'received', payment: 1000, costTax: 100, agencyRev: 162, workerPay: { a: { amount: 369 }, b: { amount: 369 } }, ...o });
const monthData = {
  '2026-10': { carryover: 50, transactions: [deal({ platforma: 'Main', date: '05.11' }), deal({ status: 'pending', platforma: 'Main', date: '06.11' })],
    expenses: [{ persona: 'Main', cost: 100, date: '10.11' }, { persona: 'Main', cost: 108, currency: 'EUR', origAmount: 100, fxRate: 1.08, date: '12.11.2026' }],
    transfers: [{ fromAcc: 'Main', toAcc: 'Second', amount: 40, fee: 2 }], cashouts: [{ fromAcc: 'Main', sentUsdt: 30 }] },
  // December: no carryover stored → previous closing; deal with partner commission (5%)
  '2026-11': { transactions: [deal({ platforma: 'Personal > Second', date: '20.12', partnerRate: 5, costTax: 50, agencyRev: 162, workerPay: { a: { amount: 369 }, b: { amount: 369 } } })], expenses: [] },
  // January 2027: an expense dated 28.12 (written in January) and an undated one
  '2027-0': { transactions: [], expenses: [{ persona: 'Second', cost: 20, date: '28.12' }, { persona: 'Second', cost: 7, date: '' }] },
};
const accounts = [
  { name: 'Main', limit: 10000, reconciliations: [{ ts: 1, actual: 10 }, { ts: 5, actual: 77.5 }] },
  { name: 'Second', limit: 0 },
  { name: 'Wallet', kind: 'personal' },
];

console.log('\nFinance formulas (' + appFile + ')');
t('money equation: balanced deal → 0, unbalanced → the gap', () => {
  eq(T.FIN.rowDiff(deal({}), W), 0, 'balanced');
  eq(T.FIN.rowDiff(deal({ agencyRev: 150 }), W), 12, 'unbalanced');
});
t('partner commission by rate and by amount', () => {
  eq(T.FIN.partnerCommission({ payment: 1000, partnerRate: 5 }), 50);
  eq(T.FIN.partnerCommission({ payment: 1000, partnerAmount: 33 }), 33);
});
t('month totals count confirmed deals only; expenses in USD (EUR 100 @1.08 = $108)', () => {
  eq(T.FIN.monthTotals(monthData['2026-10']), { turnover: 1000, revenue: 162, costs: 100, pendingPayment: 1000, pendingRev: 162, expenses: 208 });
});
t('carryover: stored value wins; missing → previous month closing; chains across the year', () => {
  eq(T.FIN.carryInfo(monthData, 2026, 10), { carry: 50, stored: 50, computed: 0 });
  eq(T.FIN.carryInfo(monthData, 2026, 11).carry, 162 - 208 + 50, 'Dec');        // Nov closing = 4
  eq(T.FIN.carryInfo(monthData, 2027, 0).carry, 4 + 162 - 0, 'Jan');            // Dec closing = 166
  eq(T.FIN.carryInfo(monthData, 2027, 1).carry, 166 - 27, 'Feb (no row)');      // Jan closing = 139
});
t('account balances: REV − expenses − transfers out (with fee) + in − cash-outs; personal accounts excluded', () => {
  const u = T.FIN.accountUsage(accounts, monthData);
  eq(u.map(a => a.name), ['Main', 'Second'], 'agency only');
  eq(u[0].accountBudget, 162 - 208 - 42 - 30, 'Main');
  eq(u[0].cashOutTotal, 30, 'Main cash-outs');
  eq(u[1].accountBudget, 162 + 40 - 27, 'Second ("Personal > Second" resolves to Second)');
  eq(u[0].used, 1000 + 208 + 42, 'Main turnover');
});
t('agency balance = latest verified balance of reconciled accounts only', () => {
  const b = T.FIN.agencyBalance(T.FIN.accountUsage(accounts, monthData));
  eq(b.total, 77.5); eq(b.reconciledCount, 1); eq(b.lastTs, 5); eq(b.uncounted.map(a => a.name), ['Second']);
});
t('period report across the year boundary (28.12 written in January counts in December)', () => {
  const dec = T.FIN.periodReport(monthData, '2026-12-01', '2026-12-31');
  eq([dec.deals, dec.revenue, dec.expenses, dec.costs], [1, 162, 20, 100]);
  const cross = T.FIN.periodReport(monthData, '2026-12-15', '2027-01-15');
  eq([cross.deals, cross.expenses, cross.undated], [1, 27, 1], 'undated Jan expense on 1 Jan');
  const jan = T.FIN.periodReport(monthData, '2027-01-02', '2027-01-31');
  eq([jan.deals, jan.expenses], [0, 0]);
  eq(T.FIN.periodReport(monthData, '2027-01-02', '2026-01-01'), null, 'reversed range');
});
t('dates: year added to new entries, closest year for old DD.MM, compact display, month copy keeps the year', () => {
  eq(T.withYear('5', 9, 2026), '05.10.2026');
  eq(T.withYear('28.12', 0, 2027), '28.12.2026');
  eq(T.withYear('03.01', 11, 2026), '03.01.2027');
  eq(T.withYear('1.2.27', 0, 2026), '01.02.2027');
  eq(T.recordISO('28.12', '2027-0'), '2026-12-28');
  eq(T.recordISO('?', '2026-1'), '');
  eq(T.shortDate('28.12.2026', 2026), '28.12'); eq(T.shortDate('28.12.2026', 2027), '28.12.26');
  eq(T.incrementDate('05.12.2026'), '05.01.2027'); eq(T.incrementDate('05.03'), '05.04');
});
t('save engine helpers: canonical JSON ignores key order; revision split', () => {
  eq(T.canon({ b: 1, a: { d: 2, c: 3 } }) === T.canon({ a: { c: 3, d: 2 }, b: 1 }), true);
  eq(T.splitRev({ _rev: 4, x: 1 }), [{ x: 1 }, 4]); eq(T.splitRev({ x: 1 }), [{ x: 1 }, null]);
});
t('parseNum tolerates money strings', () => { eq(T.parseNum('$1,5'), 1.5); eq(T.parseNum(''), 0); eq(T.parseNum('abc'), 0); });
t('new expenses default to USD', () => { eq([T.EMPTY_EXPENSE.currency, T.EMPTY_EXPENSE.fxRate], ['USD', 1]); });

// ---- interface look (new / classic) ----
t('new look re-colours: hex (incl. #rgb and #rrggbbaa), accent rgba, fonts, auto-fit grids; status colours stay', () => {
  eq(T.reTheme('1px solid #2a2a2a'), '1px solid #232A32', 'border');
  eq(T.reTheme('#333'), '#2A323B', '#rgb');
  eq(T.reTheme('#4ADE8055'), '#34D39955', 'alpha suffix kept');
  eq(T.reTheme('rgba(239,68,68,.12)'), 'rgba(16,185,129,.12)', 'red accent → emerald');
  eq(T.reTheme('#F87171'), '#F87171', 'negative red unchanged');
  eq(T.reTheme("'DM Sans',sans-serif"), "'Inter',sans-serif", 'font');
  eq(T.reTheme('repeat(auto-fit, minmax(360px, 1fr))'), 'repeat(auto-fit, minmax(min(360px, 100%), 1fr))', 'grid');
});
t('classic look: elements are created exactly as before; new look re-colours and marks cards', () => {
  const mode = T.UI.mode;
  const props = { style: { background: '#1A1A1A', borderRadius: 12 } };
  try {
    T.UI.mode = 'classic';
    ctx.React.createElement('div', props, 'x');
    if (React.lastCall[1] !== props) throw new Error('classic: props were changed');
    T.UI.mode = 'new';
    ctx.React.createElement('div', props, 'x');
    eq([React.lastCall[1].style.background, React.lastCall[1].className, props.style.background], ['#151A20', 'ui-card', '#1A1A1A'], 'new');
  } finally { T.UI.mode = mode; }
});

// ---- optional: a real backup ----
if (process.env.FINPORTAL_BACKUP) {
  console.log('\nReal backup: ' + process.env.FINPORTAL_BACKUP);
  const b = JSON.parse(readFileSync(process.env.FINPORTAL_BACKUP, 'utf8'));
  const md = Object.fromEntries(b.monthly_data.map(r => [r.month_key, T.splitRev(r.data)[0]]));
  const gs = b.global_settings[0] || {};
  t('every month computes finite totals and carryover', () => {
    for (const k of Object.keys(md)) {
      const m = T.FIN.monthTotals(md[k]); const [y, mi] = k.split('-').map(Number); const c = T.FIN.carryInfo(md, y, mi);
      for (const [f, v] of Object.entries({ ...m, carry: c.carry })) if (!Number.isFinite(v)) throw new Error(`${k} ${f} = ${v}`);
    }
  });
  t('account balances and agency balance are finite', () => {
    const u = T.FIN.accountUsage(gs.accounts || [], md); const ab = T.FIN.agencyBalance(u);
    if (!u.every(a => Number.isFinite(a.accountBudget)) || !Number.isFinite(ab.total)) throw new Error('NaN balance');
    console.log(`      ${u.length} agency accounts · agency balance $${ab.total.toFixed(2)} (${ab.reconciledCount} reconciled)`);
  });
  t('money equation holds on confirmed deals (reports unbalanced ones)', () => {
    const bad = [];
    for (const [k, m] of Object.entries(md)) (m.transactions || []).filter(T.FIN.isReceived).forEach(x => { const d = T.FIN.rowDiff(x, gs.workers || []); if (Math.abs(d) > 0.01) bad.push(`${k} ${x.client || '?'} ${d.toFixed(2)}`); });
    console.log(`      ${bad.length} unbalanced confirmed deal(s)${bad.length ? ': ' + bad.slice(0, 5).join('; ') : ''}`);
  });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
