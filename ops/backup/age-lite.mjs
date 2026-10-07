#!/usr/bin/env node
// Мінімальний age (X25519) на вбудованому crypto Node — для Mac, де age немає.
//
//   node age-lite.mjs keygen <файл-ключа>        → пише приватний ключ (600), друкує публічний age1…
//   node age-lite.mjs recipient <файл-ключа>     → публічний ключ із приватного
//   node age-lite.mjs decrypt <файл-ключа> <файл.age> [вихід]   → розшифрувати (за замовчуванням stdout)
//
// Формат — age-encryption.org/v1, сумісний зі справжнім age: ключі, згенеровані
// тут, приймає `age -r`, і файли, зашифровані справжнім age, тут відкриваються
// (звірено на сервері 02.10.2026). Для відновлення на сервері годиться і
// справжній `age -d -i <файл-ключа>` — формат ключа той самий.

import crypto from 'node:crypto';
import fs from 'node:fs';

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

function polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i];
  }
  return chk >>> 0;
}
const hrpExpand = (hrp) => [...hrp].map((c) => c.charCodeAt(0) >> 5).concat([0], [...hrp].map((c) => c.charCodeAt(0) & 31));

function convertBits(data, from, to, pad) {
  let acc = 0, bits = 0;
  const out = [];
  for (const v of data) {
    acc = (acc << from) | v;
    bits += from;
    while (bits >= to) { bits -= to; out.push((acc >> bits) & ((1 << to) - 1)); }
  }
  if (pad && bits > 0) out.push((acc << (to - bits)) & ((1 << to) - 1));
  else if (!pad && (bits >= from || ((acc << (to - bits)) & ((1 << to) - 1)))) throw new Error('bech32: зайві біти');
  return out;
}

function bech32Encode(hrp, bytes) {
  const data = convertBits(bytes, 8, 5, true);
  const mod = polymod(hrpExpand(hrp).concat(data, [0, 0, 0, 0, 0, 0])) ^ 1;
  const checksum = Array.from({ length: 6 }, (_, i) => (mod >>> (5 * (5 - i))) & 31);
  return hrp + '1' + data.concat(checksum).map((d) => CHARSET[d]).join('');
}

function bech32Decode(str) {
  const s = str.toLowerCase();
  const pos = s.lastIndexOf('1');
  const hrp = s.slice(0, pos);
  const data = [...s.slice(pos + 1)].map((c) => {
    const i = CHARSET.indexOf(c);
    if (i < 0) throw new Error('bech32: чужий символ');
    return i;
  });
  if (polymod(hrpExpand(hrp).concat(data)) !== 1) throw new Error('bech32: контрольна сума не сходиться');
  return { hrp, bytes: Buffer.from(convertBits(data.slice(0, -6), 5, 8, false)) };
}

const b64 = (buf) => Buffer.from(buf).toString('base64url').replace(/=+$/, '');
const unb64 = (s) => Buffer.from(s, 'base64');

// X25519 через KeyObject: сирі 32 байти ↔ JWK.
const privKey = (raw) => crypto.createPrivateKey({ key: { kty: 'OKP', crv: 'X25519', d: b64(raw), x: b64(publicFromPrivate(raw)) }, format: 'jwk' });
const pubKey = (raw) => crypto.createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: b64(raw) }, format: 'jwk' });
function publicFromPrivate(raw) {
  const k = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), raw]), format: 'der', type: 'pkcs8' });
  return unb64(crypto.createPublicKey(k).export({ format: 'jwk' }).x);
}
const x25519 = (priv, pub) => crypto.diffieHellman({ privateKey: privKey(priv), publicKey: pubKey(pub) });
const hkdf = (ikm, salt, info) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from(info), 32));

function openChaCha(key, nonce, sealed) {
  const d = crypto.createDecipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
  d.setAuthTag(sealed.subarray(sealed.length - 16));
  return Buffer.concat([d.update(sealed.subarray(0, sealed.length - 16)), d.final()]);
}

function readIdentity(path) {
  const line = fs.readFileSync(path, 'utf8').split('\n').find((l) => l.startsWith('AGE-SECRET-KEY-1'));
  if (!line) throw new Error(`у ${path} немає AGE-SECRET-KEY`);
  const { hrp, bytes } = bech32Decode(line.trim());
  if (hrp !== 'age-secret-key-' || bytes.length !== 32) throw new Error('це не ключ age X25519');
  return bytes;
}

function decrypt(identity, file) {
  const ours = publicFromPrivate(identity);
  const headerEnd = file.indexOf('\n---');
  if (!file.subarray(0, 22).equals(Buffer.from('age-encryption.org/v1\n')) || headerEnd < 0) throw new Error('це не файл age v1');
  const macLineEnd = file.indexOf('\n', headerEnd + 1);
  const lines = file.subarray(0, headerEnd).toString('latin1').split('\n').slice(1);
  const macB64 = file.subarray(headerEnd + 5, macLineEnd).toString('latin1');

  // Стензи: «-> тип аргументи», далі тіло base64 рядками по 64, останній коротший.
  let fileKey = null;
  for (let i = 0; i < lines.length; ) {
    const args = lines[i++].split(' ');
    let body = '';
    for (;;) { const l = lines[i++]; body += l; if (l.length < 64) break; }
    if (args[1] !== 'X25519' || fileKey) continue;
    const share = unb64(args[2]);
    const wrapKey = hkdf(x25519(identity, share), Buffer.concat([share, ours]), 'age-encryption.org/v1/X25519');
    try { fileKey = openChaCha(wrapKey, Buffer.alloc(12), unb64(body)); } catch { /* не наш одержувач */ }
  }
  if (!fileKey) throw new Error('цей ключ не відкриває файл');

  const mac = crypto.createHmac('sha256', hkdf(fileKey, Buffer.alloc(0), 'header')).update(file.subarray(0, headerEnd + 4)).digest();
  if (!mac.equals(unb64(macB64))) throw new Error('MAC заголовка не сходиться — файл пошкоджено');

  const payload = file.subarray(macLineEnd + 1);
  const key = hkdf(fileKey, payload.subarray(0, 16), 'payload');
  const CHUNK = 64 * 1024 + 16;
  const out = [];
  for (let off = 16, n = 0; off < payload.length; off += CHUNK, n++) {
    const last = off + CHUNK >= payload.length;
    const nonce = Buffer.alloc(12);
    nonce.writeBigUInt64BE(BigInt(n), 3);
    nonce[11] = last ? 1 : 0;
    try { out.push(openChaCha(key, nonce, payload.subarray(off, Math.min(off + CHUNK, payload.length)))); }
    catch { throw new Error(`блок ${n} не пройшов автентифікацію — файл пошкоджено або обрізано`); }
  }
  return Buffer.concat(out);
}

// `… | head` закриває канал раніше — це не помилка розшифрування.
process.stdout.on('error', (e) => { if (e.code === 'EPIPE') process.exit(0); throw e; });

const [cmd, a, b, c] = process.argv.slice(2);
try {
if (cmd === 'keygen' && a) {
  if (fs.existsSync(a)) throw new Error(`${a} уже існує — не перезаписую`);
  const raw = crypto.randomBytes(32);
  const recipient = bech32Encode('age', publicFromPrivate(raw));
  const secret = bech32Encode('age-secret-key-', raw).toUpperCase();
  fs.writeFileSync(a, `# created: ${new Date().toISOString()}\n# public key: ${recipient}\n${secret}\n`, { mode: 0o600 });
  console.log(recipient);
} else if (cmd === 'recipient' && a) {
  console.log(bech32Encode('age', publicFromPrivate(readIdentity(a))));
} else if (cmd === 'decrypt' && a && b) {
  const plain = decrypt(readIdentity(a), fs.readFileSync(b));
  if (c) fs.writeFileSync(c, plain, { mode: 0o600 }); else process.stdout.write(plain);
} else {
  console.error('usage: age-lite.mjs keygen <key> | recipient <key> | decrypt <key> <file.age> [out]');
  process.exit(2);
}
} catch (e) {
  console.error(`age-lite: ${e.message}`);
  process.exit(1);
}
