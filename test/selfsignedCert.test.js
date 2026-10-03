'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const { generate, ensureCerts, localNames } = require('../src/selfsignedCert');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-cert-'));
const made = ensureCerts(dir);
const certPem = fs.readFileSync(made.certPath, 'utf8');
const keyPem = fs.readFileSync(made.keyPath, 'utf8');
const x509 = new crypto.X509Certificate(certPem);
test('writes cert.pem and key.pem once and leaves them alone after that', () => {
  assert.equal(made.created, true);
  assert.match(certPem, /^-----BEGIN CERTIFICATE-----\n[\s\S]+\n-----END CERTIFICATE-----\n$/);
  assert.match(keyPem, /^-----BEGIN PRIVATE KEY-----/);
  const again = ensureCerts(dir);
  assert.equal(again.created, false);
  assert.equal(fs.readFileSync(again.certPath, 'utf8'), certPem);
});
test('parses as a v3 self-signed cert that Node itself trusts as its own issuer', () => {
  assert.equal(x509.subject, 'CN=Haven');
  assert.equal(x509.issuer, 'CN=Haven');
  assert.equal(x509.verify(x509.publicKey), true);
  assert.equal(x509.checkPrivateKey(crypto.createPrivateKey(keyPem)), true);
  assert.ok(x509.ca);
  assert.ok(new Date(x509.validTo).getTime() - new Date(x509.validFrom).getTime() > 3649 * 86400000);
  assert.deepEqual(x509.keyUsage, ['1.3.6.1.5.5.7.3.1']);
});
test('SAN covers localhost, the loopback IP, the LAN IPv4s and the hostname', () => {
  const san = x509.subjectAltName;
  assert.match(san, /DNS:localhost/);
  assert.match(san, /IP Address:127\.0\.0\.1/);
  for (const n of localNames()) assert.ok(san.includes(/^\d/.test(n) ? `IP Address:${n}` : `DNS:${n}`), `${n} missing from ${san}`);
  assert.equal(x509.checkHost('localhost'), 'localhost');
  assert.equal(x509.checkIP('127.0.0.1'), '127.0.0.1');
});
test('custom names and CN land in the SAN, junk is dropped, and 2050+ expiry still parses', () => {
  const r = generate({ cn: 'haven.example.org', names: ['10.0.0.5', 'bad name!', 'box'], days: 365 * 30 });
  const c = new crypto.X509Certificate(r.cert);
  assert.equal(c.subject, 'CN=haven.example.org');
  assert.equal(c.subjectAltName, 'DNS:haven.example.org, IP Address:10.0.0.5, DNS:box');
  assert.equal(new Date(c.validTo).getUTCFullYear() >= 2050, true);
  assert.equal(c.verify(c.publicKey), true);
});
test('a real TLS handshake succeeds against the generated pair', async () => {
  const server = https.createServer({ cert: certPem, key: keyPem }, (req, res) => res.end('ok'));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const body = await new Promise((resolve, reject) => https.get({ host: '127.0.0.1', port, path: '/', ca: certPem, servername: 'localhost' }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d)); }).on('error', reject));
  server.close();
  assert.equal(body, 'ok');
});
