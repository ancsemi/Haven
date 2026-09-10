/**
 * A certless Haven makes its own certificate at first start.
 *
 * Without FORCE_HTTP and with nothing in the data directory, the server must
 * come up on HTTPS with a certificate it wrote itself, so a clean Windows
 * install without OpenSSL is not quietly left on HTTP.
 *
 *   node --test test/autoCert.integration.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const PORT = 3396;
const DATA = path.join(os.tmpdir(), `haven-autocert-${Date.now()}`);

let server;
let log = '';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const getJson = (mod, opts) => new Promise((res, rej) => {
  mod.get(opts, (r) => {
    let b = '';
    r.on('data', (c) => (b += c));
    r.on('end', () => res({ status: r.statusCode, body: b }));
  }).on('error', rej);
});

test.before(async () => {
  fs.mkdirSync(DATA, { recursive: true });
  const env = { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', HAVEN_DATA_DIR: DATA, ADMIN_USERNAME: 'admin' };
  delete env.FORCE_HTTP;
  delete env.SSL_CERT_PATH;
  delete env.SSL_KEY_PATH;
  server = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', (c) => { log += c; });
  server.stderr.on('data', (c) => { log += c; });
  for (let i = 0; i < 60; i++) {
    try {
      const r = await getJson(https, { host: '127.0.0.1', port: PORT, path: '/api/health', rejectUnauthorized: false, agent: false, headers: { Connection: 'close' } });
      if (r.status === 200) return;
    } catch { /* not up yet */ }
    await wait(500);
  }
  throw new Error('server did not come up on HTTPS:\n' + log);
});

test.after(() => {
  server?.kill();
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('the server wrote a certificate and key into the data directory', () => {
  const certPath = path.join(DATA, 'certs', 'cert.pem');
  const keyPath = path.join(DATA, 'certs', 'key.pem');
  assert.ok(fs.existsSync(certPath), 'cert.pem exists');
  assert.ok(fs.existsSync(keyPath), 'key.pem exists');
  const cert = new crypto.X509Certificate(fs.readFileSync(certPath));
  assert.equal(cert.subject, 'CN=Haven');
  assert.match(cert.subjectAltName, /IP Address:127\.0\.0\.1/);
  assert.equal(cert.checkPrivateKey(crypto.createPrivateKey(fs.readFileSync(keyPath))), true);
});

test('it said so on the console', () => {
  assert.match(log, /Generated a self-signed certificate|made a self-signed one/);
  assert.match(log, /HTTPS enabled/);
});

test('the HTTPS headers are back on now that HTTPS is real', async () => {
  const r = await new Promise((res, rej) => {
    https.get({ host: '127.0.0.1', port: PORT, path: '/', rejectUnauthorized: false, agent: false, headers: { Connection: 'close' } }, (x) => { x.resume(); res(x.headers); }).on('error', rej);
  });
  assert.match(r['content-security-policy'] || '', /upgrade-insecure-requests/);
  assert.ok(r['strict-transport-security'], 'HSTS sent over HTTPS');
});

test('plain HTTP on that port is refused, not served', async () => {
  await assert.rejects(
    getJson(http, { host: '127.0.0.1', port: PORT, path: '/api/health', agent: false, headers: { Connection: 'close' } }),
    () => true
  );
});
