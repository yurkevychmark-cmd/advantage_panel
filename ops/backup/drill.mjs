#!/usr/bin/env node
// Помічник навчального відновлення фінпорталу (restore-drill.sh). Обидва режими читають stdin і нічого не пишуть на диск.
//
//   node drill.mjs sql    < розшифрований-знімок.json   → SQL: схема + усі рядки (у stdout); перевіряє sha256 кожного файлу інвойсу
//   node drill.mjs verify <файл.counts> < вивантаження-з-відновленої-бази.json
//                                                        → звіряє кількість рядків і sha256 канонічного JSON кожної таблиці
//                                                          з тим, що зняв finportal-dump.mjs у мить бекапу; код 1 при розбіжності
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const canon = (v) => JSON.stringify(v === undefined ? null : v, (k, val) => (val && typeof val === 'object' && !Array.isArray(val)) ? Object.keys(val).sort().reduce((o, key) => { o[key] = val[key]; return o; }, {}) : val);
const sha = (x) => createHash('sha256').update(x).digest('hex');
const readStdin = () => readFileSync(0, 'utf8');
const lit = (v) => v === null || v === undefined ? 'null' : `'${String(v).replace(/'/g, "''")}'`;
const jlit = (v) => v === null || v === undefined ? 'null' : `${lit(JSON.stringify(v))}::jsonb`;
const [mode, countsFile] = process.argv.slice(2);

if (mode === 'sql') {
  const b = JSON.parse(readStdin());
  if (!Array.isArray(b.global_settings) || !Array.isArray(b.monthly_data)) { console.error('знімок без global_settings / monthly_data'); process.exit(1); }
  const files = (b.storage && b.storage.files) || [];
  const bad = files.filter(f => sha(Buffer.from(f.base64 || '', 'base64')) !== f.sha256);
  if (bad.length) { console.error(`файли інвойсів пошкоджені: ${bad.map(f => f.path).join(', ')}`); process.exit(1); }
  const out = ['\\set ON_ERROR_STOP on', 'begin;', readFileSync(join(HERE, 'schema.sql'), 'utf8')];
  for (const r of b.global_settings) out.push(`insert into public.global_settings (id, workers, accounts, products) values (${Number(r.id)}, ${jlit(r.workers)}, ${jlit(r.accounts)}, ${jlit(r.products)});`);
  for (const r of b.monthly_data) out.push(`insert into public.monthly_data (month_key, data) values (${lit(r.month_key)}, ${jlit(r.data)});`);
  out.push('commit;');
  process.stdout.write(out.join('\n') + '\n');
  console.error(`sql: ${b.global_settings.length} + ${b.monthly_data.length} рядків, файлів інвойсів ${files.length} (sha256 усіх збігся)`);
} else if (mode === 'verify') {
  const r = JSON.parse(readStdin());
  const got = {
    'public.global_settings': String((r.global_settings || []).length),
    'public.monthly_data': String((r.monthly_data || []).length),
    'sha.public.global_settings': sha(canon(r.global_settings || [])),
    'sha.public.monthly_data': sha(canon(r.monthly_data || [])),
  };
  const want = Object.fromEntries(readFileSync(countsFile, 'utf8').trim().split('\n').map(l => l.split('|')));
  let bad = 0;
  for (const k of Object.keys(got)) {
    const ok = want[k] === got[k];
    if (!ok) bad++;
    console.log(`  ${ok ? 'OK ' : 'BAD'} ${k}: у мить бекапу ${k.startsWith('sha.') ? (want[k] || '—').slice(0, 12) : want[k]}, відновлено ${k.startsWith('sha.') ? got[k].slice(0, 12) : got[k]}`);
  }
  process.exit(bad ? 1 : 0);
} else {
  console.error('usage: drill.mjs sql | verify <counts>'); process.exit(2);
}
