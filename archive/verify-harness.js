#!/usr/bin/env node
/*
 * ADvantage Finance Portal — verification harness
 * -----------------------------------------------
 * Purpose: independently re-derive every dashboard number from the raw month
 * backups using the SAME formulas as the portal (index.html), and assert the
 * core money-flow invariant on every deal:
 *
 *     payment === costTax + agencyRev + Σ workerPay(amount)   (received deals)
 *
 * This is the regression baseline. Any change to the portal (v11) must keep
 * these numbers identical and keep the invariant green. Run:
 *
 *     node verify-harness.js [path-to-backups-dir]
 *
 * Default backups dir: ~/Downloads
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const DIR = process.argv[2] || path.join(os.homedir(), 'Downloads');
const parseNum = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
const isReceived = (t) => t.status === 'received';
const fmt = (n) => '$' + Math.round(n).toLocaleString('en-US');

// --- load month backups ---
const files = fs.readdirSync(DIR).filter(f => /^advantage-backup-2026-\d+\.json$/.test(f))
  .sort((a, b) => (+a.match(/-(\d+)\.json$/)[1]) - (+b.match(/-(\d+)\.json$/)[1]));
if (!files.length) { console.error('No advantage-backup-2026-N.json files in', DIR); process.exit(1); }
const months = files.map(f => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')));

// --- derive "current workers" the way the portal would (keys present in the latest month) ---
const latest = months[months.length - 1];
const CUR = new Set();
latest.transactions.forEach(t => Object.keys(t.workerPay || {}).forEach(id => CUR.add(id)));
// detect orphans: ids that appear in any month but are NOT current (deleted workers)
const orphans = new Set();
months.forEach(m => m.transactions.forEach(t => Object.keys(t.workerPay || {}).forEach(id => { if (!CUR.has(id)) orphans.add(id); })));

const MN = { '2026-0': 'Січень', '2026-1': 'Лютий', '2026-2': 'Березень', '2026-3': 'Квітень', '2026-4': 'Травень', '2026-5': 'Червень' };

// --- per-deal invariant check ---
let invariantFails = 0, pendingHang = 0;
const failRows = [];
for (const d of months) {
  for (const t of d.transactions) {
    if (!isReceived(t)) continue;
    const wp = t.workerPay || {};
    let sw = 0, swPaid = 0;
    for (const id in wp) { if (!CUR.has(id)) continue; const a = parseNum(wp[id].amount); sw += a; if (wp[id].paid) swPaid += a; }
    const diff = parseNum(t.payment) - sw - parseNum(t.costTax) - parseNum(t.agencyRev);
    if (Math.abs(diff) > 1) { invariantFails++; failRows.push(`  ✗ ${MN[d.month]} · ${t.client} · ${t.service}: leftover ${fmt(diff)}`); }
    pendingHang += (sw - swPaid);
  }
}

// --- per-month + cumulative reserve (carryover) ---
console.log('='.repeat(64));
console.log('ADvantage — verification harness');
console.log('backups:', files.join(', '));
console.log('current workers:', [...CUR].join(', '));
console.log('orphaned (deleted, excluded):', [...orphans].join(', ') || '(none)');
console.log('='.repeat(64));

console.log('\nМіс      | turnover | agencyRev | costTax | Σworker(нарах) | expenses | reserveΔ | reserve∑');
let reserve = 0, T = { turnover: 0, agencyRev: 0, costTax: 0, worker: 0, workerPaid: 0, exp: 0 };
for (const d of months) {
  let turnover = 0, agencyRev = 0, costTax = 0, worker = 0, workerPaid = 0;
  for (const t of d.transactions) {
    if (!isReceived(t)) continue;
    turnover += parseNum(t.payment); agencyRev += parseNum(t.agencyRev); costTax += parseNum(t.costTax);
    const wp = t.workerPay || {};
    for (const id in wp) { if (!CUR.has(id)) continue; const a = parseNum(wp[id].amount); worker += a; if (wp[id].paid) workerPaid += a; }
  }
  const exp = (d.expenses || []).reduce((s, e) => s + parseNum(e.cost), 0);
  const rDelta = agencyRev - exp; reserve += rDelta;
  T.turnover += turnover; T.agencyRev += agencyRev; T.costTax += costTax; T.worker += worker; T.workerPaid += workerPaid; T.exp += exp;
  console.log(`${(MN[d.month] || d.month).padEnd(8)} | ${String(Math.round(turnover)).padStart(8)} | ${String(Math.round(agencyRev)).padStart(9)} | ${String(Math.round(costTax)).padStart(7)} | ${String(Math.round(worker)).padStart(14)} | ${String(Math.round(exp)).padStart(8)} | ${String(Math.round(rDelta)).padStart(8)} | ${String(Math.round(reserve)).padStart(8)}`);
}
console.log(`РАЗОМ    | ${String(Math.round(T.turnover)).padStart(8)} | ${String(Math.round(T.agencyRev)).padStart(9)} | ${String(Math.round(T.costTax)).padStart(7)} | ${String(Math.round(T.worker)).padStart(14)} | ${String(Math.round(T.exp)).padStart(8)} | ${String(Math.round(T.agencyRev - T.exp)).padStart(8)} | ${String(Math.round(reserve)).padStart(8)}`);

// --- per-worker paid vs allocated ---
console.log('\nПер-воркер (весь період): нараховано / виплачено');
const wt = {};
for (const d of months) for (const t of d.transactions) { if (!isReceived(t)) continue; const wp = t.workerPay || {};
  for (const id in wp) { if (!CUR.has(id)) continue; wt[id] = wt[id] || { a: 0, p: 0 }; const a = parseNum(wp[id].amount); wt[id].a += a; if (wp[id].paid) wt[id].p += a; } }
Object.entries(wt).sort((a, b) => b[1].a - a[1].a).forEach(([id, v]) => console.log(`  ${id.padEnd(10)} нарах ${fmt(v.a).padStart(9)} · випл ${fmt(v.p).padStart(9)}`));

// --- founder take (46gbotb + cm0t5nm) ---
const fA = (wt['46gbotb']?.a || 0) + (wt['cm0t5nm']?.a || 0);
const fP = (wt['46gbotb']?.p || 0) + (wt['cm0t5nm']?.p || 0);
console.log(`\nЗАСНОВНИКИ разом: нараховано ${fmt(fA)} (кожному ~${fmt(fA / 2)}) · виплачено ${fmt(fP)}`);

// --- verdict ---
console.log('\n' + '='.repeat(64));
console.log(`ІНВАРІАНТ payment = costTax + agencyRev + Σworker: ${invariantFails === 0 ? 'PASS ✅ (0 незбалансованих угод)' : 'FAIL ❌ (' + invariantFails + ')'}`);
if (invariantFails) failRows.forEach(r => console.log(r));
console.log(`Нараховано-але-не-виплачено (висить людям): ${fmt(pendingHang)}`);
console.log('='.repeat(64));
process.exit(invariantFails === 0 ? 0 : 1);
