/**
 * Security headers in plain-HTTP mode.
 *
 * A Haven with no certificate runs plain HTTP. It used to send
 * upgrade-insecure-requests and HSTS anyway, so a remote visitor's browser
 * re-requested every stylesheet and script over https on a port with nothing
 * listening for TLS: unstyled page, dead buttons. Whoever set it up saw a
 * perfect page, because browsers treat localhost as trustworthy and skip the
 * upgrade. The Windows installer produces exactly this state when OpenSSL is
 * missing, so it reached a self-hoster (2026-09-05).
 *
 *   node --test test/httpModeHeaders.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');

const PORT = 3397;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = path.join(os.tmpdir(), `haven-httpmode-${Date.now()}`);

let server;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const head = (p) => new Promise((res, rej) => {
  http.get(`${BASE}${p}`, (r) => { r.resume(); res(r.headers); }).on('error', rej);
});

test.before(async () => {
  fs.mkdirSync(DATA, { recursive: true });
  // No certs in the data dir and no FORCE_HTTP: the accidental plain-HTTP mode.
  const env = { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', HAVEN_DATA_DIR: DATA, ADMIN_USERNAME: 'admin' };
  delete env.FORCE_HTTP;
  delete env.SSL_CERT_PATH;
  delete env.SSL_KEY_PATH;
  server = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {
    try {
      await new Promise((res, rej) =>
        http.get(`${BASE}/api/health`, (r) => (r.statusCode === 200 ? res() : rej())).on('error', rej));
      return;
    } catch { await wait(500); }
  }
  throw new Error('server did not start');
});

test.after(() => {
  server?.kill();
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('plain HTTP does not tell browsers to upgrade every request', async () => {
  const h = await head('/');
  const csp = h['content-security-policy'] || '';
  assert.ok(csp, 'a CSP is still sent');
  assert.ok(!/upgrade-insecure-requests/.test(csp), `CSP must not upgrade on plain HTTP: ${csp}`);
});

test('plain HTTP does not claim HSTS', async () => {
  const h = await head('/');
  assert.equal(h['strict-transport-security'], undefined);
});

test('the rest of the CSP is untouched', async () => {
  const csp = (await head('/'))['content-security-policy'] || '';
  for (const directive of ["default-src 'self'", "object-src 'none'", "base-uri 'self'", "frame-ancestors 'self'"]) {
    assert.ok(csp.includes(directive), `${directive} still present`);
  }
});

test('the login page and its assets load over plain HTTP', async () => {
  // The visible half of the bug: these are the requests a browser upgraded.
  for (const p of ['/', '/css/style.css', '/js/auth.js']) {
    const status = await new Promise((res, rej) => {
      http.get(`${BASE}${p}`, (r) => { r.resume(); res(r.statusCode); }).on('error', rej);
    });
    assert.equal(status, 200, `${p} served`);
  }
});
