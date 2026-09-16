'use strict';
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const len = n => n < 0x80 ? Buffer.from([n]) : n < 0x100 ? Buffer.from([0x81, n]) : n < 0x10000 ? Buffer.from([0x82, n >> 8, n & 0xff]) : Buffer.from([0x83, n >> 16, (n >> 8) & 0xff, n & 0xff]);
const tlv = (tag, body) => Buffer.concat([Buffer.from([tag]), len(body.length), body]);
const seq = (...parts) => tlv(0x30, Buffer.concat(parts));
const set = (...parts) => tlv(0x31, Buffer.concat(parts));
const int = buf => tlv(0x02, buf[0] & 0x80 ? Buffer.concat([Buffer.from([0]), buf]) : buf);
const oid = s => { const p = s.split('.').map(Number), out = [40 * p[0] + p[1]]; for (const v of p.slice(2)) { const b = []; let x = v; do { b.unshift(x & 0x7f); x = Math.floor(x / 128); } while (x); for (let i = 0; i < b.length - 1; i++) b[i] |= 0x80; out.push(...b); } return tlv(0x06, Buffer.from(out)); };
const utf8 = s => tlv(0x0c, Buffer.from(s, 'utf8'));
const time = d => { const iso = d.toISOString().replace(/[-:T]/g, ''); return d.getUTCFullYear() >= 2050 ? tlv(0x18, Buffer.from(iso.slice(0, 14) + 'Z')) : tlv(0x17, Buffer.from(iso.slice(2, 14) + 'Z')); };
const bits = buf => tlv(0x03, Buffer.concat([Buffer.from([0]), buf]));
const octets = buf => tlv(0x04, buf);
const ctx = (n, body) => tlv(0xa0 | n, body);
const SHA256_RSA = seq(oid('1.2.840.113549.1.1.11'), Buffer.from([0x05, 0x00]));
const name = cn => seq(set(seq(oid('2.5.4.3'), utf8(cn))));
const isIp4 = s => /^\d{1,3}(\.\d{1,3}){3}$/.test(s);
const generalName = n => isIp4(n) ? tlv(0x87, Buffer.from(n.split('.').map(Number))) : tlv(0x82, Buffer.from(n, 'ascii'));
const ext = (id, critical, value) => seq(oid(id), critical ? Buffer.from([0x01, 0x01, 0xff]) : Buffer.alloc(0), octets(value));
const pem = (label, der) => `-----BEGIN ${label}-----\n${der.toString('base64').replace(/(.{64})/g, '$1\n').trim()}\n-----END ${label}-----\n`;
const localNames = () => { const names = new Set(['localhost', '127.0.0.1']); for (const ifaces of Object.values(os.networkInterfaces())) for (const i of ifaces || []) i.family === 'IPv4' && !i.internal && names.add(i.address); const host = os.hostname(); /^[A-Za-z0-9.-]{1,63}$/.test(host) && names.add(host.toLowerCase()); return [...names]; };
function generate({ cn = 'Haven', names = localNames(), days = 3650 } = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const serial = crypto.randomBytes(16);
  serial[0] = (serial[0] & 0x7f) | 0x40;
  const now = new Date(Date.now() - 60000);
  const sans = [...new Set([cn, ...names].filter(n => n && (isIp4(n) || /^[A-Za-z0-9.-]+$/.test(n))))];
  const tbs = seq(ctx(0, int(Buffer.from([2]))), int(serial), SHA256_RSA, name(cn), seq(time(now), time(new Date(now.getTime() + days * 86400000))), name(cn), publicKey.export({ type: 'spki', format: 'der' }), ctx(3, seq(ext('2.5.29.17', false, tlv(0x30, Buffer.concat(sans.map(generalName)))), ext('2.5.29.19', true, seq(Buffer.from([0x01, 0x01, 0xff]))), ext('2.5.29.37', false, seq(oid('1.3.6.1.5.5.7.3.1'))))));
  return { cert: pem('CERTIFICATE', seq(tbs, SHA256_RSA, bits(crypto.sign('sha256', tbs, privateKey)))), key: privateKey.export({ type: 'pkcs8', format: 'pem' }), names: sans };
}
function ensureCerts(certsDir, opts) {
  const certPath = path.join(certsDir, 'cert.pem'), keyPath = path.join(certsDir, 'key.pem');
  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) return { certPath, keyPath, created: false };
  fs.mkdirSync(certsDir, { recursive: true });
  const { cert, key, names } = generate(opts);
  fs.writeFileSync(keyPath, key, { mode: 0o600 });
  fs.writeFileSync(certPath, cert);
  return { certPath, keyPath, created: true, names };
}
module.exports = { generate, ensureCerts, localNames };
