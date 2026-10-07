#!/usr/bin/env node
// Знімок бази фінпорталу (Supabase) для нічного бекапу — JSON у stdout, далі його шифрує age (finportal-backup.sh).
//
//   node finportal-dump.mjs --counts <файл>
//
// Що потрапляє в знімок: УСІ рядки public.global_settings і public.monthly_data (секретний ключ обходить RLS)
// і всі файли зі сховища інвойсів (Storage, бакет FINPORTAL_INVOICE_BUCKET) — base64 разом із sha256.
// Формат верхнього рівня збігається з кнопкою Settings → Full backup (global_settings / monthly_data), тож
// розшифрований знімок годиться і для `FINPORTAL_BACKUP=… ./verify.sh`.
//
// --counts пише поруч підрахунок для навчального відновлення (restore-drill.sh): кількість рядків і sha256
// канонічного JSON кожної таблиці, кількість файлів. Відкритих даних там немає.
//
// Секрет — лише через змінну оточення FINPORTAL_SERVICE_ROLE_KEY (backup.env, chmod 600). Значення нікуди не пишеться.
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const BASE = (process.env.FINPORTAL_SUPABASE_URL || '').replace(/\/+$/, '');
const KEY = process.env.FINPORTAL_SERVICE_ROLE_KEY || '';
const BUCKET = process.env.FINPORTAL_INVOICE_BUCKET || 'invoices';
const countsPath = (() => { const i = process.argv.indexOf('--counts'); return i > 0 ? process.argv[i + 1] : null; })();
const die = (m) => { process.stderr.write(`finportal-dump: ${m}\n`); process.exit(1); };
if (!BASE || !KEY) die('FINPORTAL_SUPABASE_URL і FINPORTAL_SERVICE_ROLE_KEY мають бути задані (backup.env)');

const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };
const canon = (v) => JSON.stringify(v === undefined ? null : v, (k, val) => (val && typeof val === 'object' && !Array.isArray(val)) ? Object.keys(val).sort().reduce((o, key) => { o[key] = val[key]; return o; }, {}) : val);
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

async function getJson(path, init = {}) {
  const r = await fetch(BASE + path, { ...init, headers: { ...H, ...(init.headers || {}) } });
  const text = await r.text();
  if (!r.ok) { const e = new Error(`${init.method || 'GET'} ${path.split('?')[0]} → HTTP ${r.status}: ${text.slice(0, 160)}`); e.status = r.status; e.body = text; throw e; }
  return JSON.parse(text);
}

async function table(name, order) {
  const rows = await getJson(`/rest/v1/${name}?select=*&order=${order}`);
  if (!Array.isArray(rows)) die(`${name}: відповідь не масив`);
  return rows;
}

async function listAll(prefix = '') {
  const out = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await getJson(`/storage/v1/object/list/${BUCKET}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prefix, limit: 1000, offset, sortBy: { column: 'name', order: 'asc' } }) });
    for (const it of page) {
      const p = prefix ? `${prefix}/${it.name}` : it.name;
      if (it.id === null) out.push(...await listAll(p));            // тека
      else if (it.name !== '.emptyFolderPlaceholder') out.push({ path: p, size: it.metadata?.size ?? null, contentType: it.metadata?.mimetype ?? null });
    }
    if (page.length < 1000) break;
  }
  return out;
}

async function storageFiles() {
  let list;
  try { list = await listAll(); }
  catch (e) {
    // Бакета ще немає (до перенесення інвойсів) — це не помилка бекапу
    if (/not.?found|does not exist/i.test(e.body || e.message)) return { bucket: BUCKET, missing: true, files: [] };
    throw e;
  }
  const files = [];
  for (const f of list) {
    const r = await fetch(`${BASE}/storage/v1/object/${BUCKET}/${f.path.split('/').map(encodeURIComponent).join('/')}`, { headers: H });
    if (!r.ok) throw new Error(`download ${f.path} → HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    files.push({ ...f, size: buf.length, sha256: sha(buf), base64: buf.toString('base64') });
  }
  return { bucket: BUCKET, missing: false, files };
}

try {
  const [global_settings, monthly_data, storage] = await Promise.all([table('global_settings', 'id'), table('monthly_data', 'month_key'), storageFiles()]);
  if (!global_settings.length) die('global_settings порожня — ключ не той або доступ закрито (бекап не пишемо)');
  const snapshot = { kind: 'advantage-finportal-server-backup', version: 1, exportedAt: new Date().toISOString(), source: new URL(BASE).host, global_settings, monthly_data, storage };
  if (countsPath) {
    writeFileSync(countsPath, [
      `public.global_settings|${global_settings.length}`,
      `public.monthly_data|${monthly_data.length}`,
      `storage.${BUCKET}|${storage.files.length}`,
      `sha.public.global_settings|${sha(canon(global_settings))}`,
      `sha.public.monthly_data|${sha(canon(monthly_data))}`,
      `sha.storage.${BUCKET}|${sha(canon(storage.files.map(f => [f.path, f.sha256])))}`,
    ].join('\n') + '\n', { mode: 0o600 });
  }
  process.stdout.write(JSON.stringify(snapshot));
} catch (e) { die(e.message); }
