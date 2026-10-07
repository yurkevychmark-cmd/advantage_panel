#!/usr/bin/env node
// Ротація копій бази у сховищі: 7 денних, 4 тижневі, 6 місячних. Старіші зникають самі.
//
//   node rotate.mjs <тека> [--dry-run]
//
// Правило — як у restic forget --keep-daily 7 --keep-weekly 4 --keep-monthly 6:
// ідемо від найсвіжішої копії; у кожному кошику (день, ISO-тиждень, місяць)
// лишається найсвіжіша копія періоду, доки кошик не наповнився. Одна копія може
// закривати кілька кошиків одразу (сьогоднішня — і денна, і тижнева, і місячна).
//
// Копія — це db-<база>-<UTCмітка>.dump.age разом із супутниками (.sha256, .counts,
// .verified) і roles-<мітка>.sql.age. Імена видалених дописуються в .rotated, щоб
// rsync не тягнув їх із сервера знову, доки там лежить своя тижнева черга.

import fs from 'node:fs';
import path from 'node:path';

const KEEP = { daily: 7, weekly: 4, monthly: 6 };
const [dir, flag] = process.argv.slice(2);
if (!dir) { console.error('usage: rotate.mjs <dir> [--dry-run]'); process.exit(2); }
const dry = flag === '--dry-run';

const STAMP = /^db-.+-(\d{8}T\d{6}Z)\.dump\.age$/;
const toDate = (s) => new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z`);

function isoWeek(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return `${t.getUTCFullYear()}-W${String(Math.ceil(((t - yearStart) / 86400000 + 1) / 7)).padStart(2, '0')}`;
}
const PERIOD = {
  daily: (d) => d.toISOString().slice(0, 10),
  weekly: isoWeek,
  monthly: (d) => d.toISOString().slice(0, 7),
};

const files = fs.readdirSync(dir);
const snaps = files
  .map((f) => ({ f, m: f.match(STAMP) }))
  .filter((x) => x.m)
  .map(({ f, m }) => ({ file: f, stamp: m[1], date: toDate(m[1]) }))
  .sort((a, b) => b.date - a.date);

const reasons = new Map();
for (const [bucket, n] of Object.entries(KEEP)) {
  let last = null, kept = 0;
  for (const s of snaps) {
    if (kept >= n) break;
    const p = PERIOD[bucket](s.date);
    if (p === last) continue;
    last = p; kept++;
    reasons.set(s.file, [...(reasons.get(s.file) || []), bucket]);
  }
}

const drop = snaps.filter((s) => !reasons.has(s.file));
const tombstones = [];
for (const s of drop) {
  const related = files.filter((f) => f.startsWith(s.file) || f === `roles-${s.stamp}.sql.age`);
  for (const f of related) {
    if (!dry) fs.rmSync(path.join(dir, f), { force: true });
    tombstones.push(f);
  }
}
if (!dry && tombstones.length) fs.appendFileSync(path.join(dir, '.rotated'), tombstones.join('\n') + '\n');

for (const s of snaps) console.log(`${reasons.has(s.file) ? 'keep' : 'drop'} ${s.file}${reasons.has(s.file) ? '  [' + reasons.get(s.file).join(', ') + ']' : ''}`);
console.log(`kept ${snaps.length - drop.length}, dropped ${drop.length}${dry ? ' (dry run)' : ''}`);
