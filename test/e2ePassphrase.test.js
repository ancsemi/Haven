/**
 * A separate encryption passphrase.
 *
 * The encrypted-DM key backup is normally locked with the login password,
 * which the server receives at every sign-in. An account can lock it with a
 * passphrase of its own instead. The server never sees that passphrase; it
 * only records which of the two the backup uses, so the client knows whether
 * to derive the key from the password or ask for the passphrase.
 *
 *   node --test test/e2ePassphrase.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { io } = require('socket.io-client');

const PORT = 3393;
const BASE = `http://localhost:${PORT}`;
const DATA = path.join(os.tmpdir(), `haven-e2e-passphrase-${Date.now()}`);
const PASSWORD = 'passphrase-test-123';

let server;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const post = (p, body) => new Promise((res, rej) => {
  const d = JSON.stringify(body);
  const r = http.request({ host: 'localhost', port: PORT, path: p, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) } },
    (x) => { let b = ''; x.on('data', (c) => (b += c)); x.on('end', () => { try { res(JSON.parse(b)); } catch { res({ raw: b }); } }); });
  r.on('error', rej); r.write(d); r.end();
});

const login = () => post('/api/auth/login', { username: 'ppuser', password: PASSWORD, eulaVersion: '2.0', ageVerified: true });

// Connects and returns the socket with the session-info it was greeted with.
function connect(token) {
  const s = io(BASE, { auth: { token }, transports: ['websocket'], forceNew: true });
  return new Promise((res, rej) => {
    s.once('session-info', (info) => res({ s, info }));
    s.on('connect_error', rej);
  });
}

function storeBackup(s, extra) {
  return new Promise((res) => {
    const t = setTimeout(() => res(false), 4000);
    s.once('encrypted-key-stored', () => { clearTimeout(t); res(true); });
    s.emit('store-encrypted-key', { encryptedKey: 'wrapped-key', salt: 'salt', ...extra });
  });
}

test.before(async () => {
  fs.mkdirSync(DATA, { recursive: true });
  server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), HAVEN_DATA_DIR: DATA, FORCE_HTTP: 'true' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 60; i++) {
    try {
      await new Promise((res, rej) => http.get(`${BASE}/api/health`, (r) => (r.statusCode === 200 ? res() : rej())).on('error', rej));
      return;
    } catch { await wait(500); }
  }
  throw new Error('server did not start');
});

test.after(() => { server?.kill(); try { fs.rmSync(DATA, { recursive: true, force: true }); } catch {} });

test('the backup says whether it uses the password or a passphrase', async () => {
  const reg = await post('/api/auth/register', { username: 'ppuser', password: PASSWORD, eulaVersion: '2.0', ageVerified: true });
  assert.ok(reg.token, 'registered');

  const first = await connect(reg.token);
  assert.equal(first.info.e2ePassphrase, false, 'a new account uses its password');
  assert.equal((await login()).user.e2ePassphrase, false);

  assert.ok(await storeBackup(first.s, { separatePassphrase: true }));
  assert.equal((await login()).user.e2ePassphrase, true, 'sign-in tells the client to ask for the passphrase');
  const second = await connect((await login()).token);
  assert.equal(second.info.e2ePassphrase, true, 'and so does session-info');

  // A re-upload that says nothing about it (key reset, older client) leaves it alone.
  assert.ok(await storeBackup(second.s, {}));
  assert.equal((await login()).user.e2ePassphrase, true);

  assert.ok(await storeBackup(second.s, { separatePassphrase: false }));
  assert.equal((await login()).user.e2ePassphrase, false, 'and back to the password');

  first.s.close();
  second.s.close();
});
