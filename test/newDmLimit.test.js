'use strict';

/**
 * Starting new DMs. A new DM shows up in the other person's list, so one
 * account may start only so many new conversations an hour, and a new
 * account waits before starting one when the server has a posting wait.
 * Opening a conversation that already exists is never limited.
 *
 * Boots a server on a scratch port and data dir:
 *   node --test test/newDmLimit.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { io } = require('socket.io-client');

const PORT = 3421;
const BASE = `http://localhost:${PORT}`;
const DATA = path.join(os.tmpdir(), `haven-new-dm-limit-${Date.now()}`);
const LIMIT = 20;

let server;

const post = (p, body) => new Promise((res, rej) => {
  const d = JSON.stringify(body);
  const r = http.request({ host: 'localhost', port: PORT, path: p, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) } }, (resp) => {
    let out = ''; resp.on('data', (c) => { out += c; }); resp.on('end', () => res(JSON.parse(out || '{}')));
  });
  r.on('error', rej); r.end(d);
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const register = (username) => post('/api/auth/register', { username, password: 'dmlimit12345', eulaVersion: '2.0', ageVerified: true });

const clients = [];
function connect(token) {
  const s = io(BASE, { auth: { token }, transports: ['websocket'], forceNew: true });
  clients.push(s);
  return new Promise((res, rej) => { s.on('connect', () => res(s)); s.on('connect_error', rej); });
}
// Starts a DM and resolves with what came back: an opened DM, an error, or a wait.
function startDm(sock, targetUserId) {
  return new Promise((res) => {
    const done = (kind) => (data) => { cleanup(); res({ kind, data }); };
    const opened = done('opened'), failed = done('error'), held = done('wait');
    const t = setTimeout(() => { cleanup(); res({ kind: 'none' }); }, 4000);
    function cleanup() { clearTimeout(t); sock.off('dm-opened', opened); sock.off('error-msg', failed); sock.off('new-account-wait', held); }
    sock.on('dm-opened', opened); sock.on('error-msg', failed); sock.on('new-account-wait', held);
    sock.emit('start-dm', { targetUserId });
  });
}

test.before(async () => {
  fs.mkdirSync(DATA, { recursive: true });
  server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), HAVEN_DATA_DIR: DATA, ADMIN_USERNAME: 'admin', FORCE_HTTP: 'true' },
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
test.after(async () => {
  clients.forEach((s) => s.close());
  if (server && server.exitCode === null) {
    const exited = new Promise((r) => server.once('exit', r));
    server.kill();
    await exited;
  }
  fs.rmSync(DATA, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

test('one account can start only so many new DMs an hour; existing ones and admins are not limited', async () => {
  const admin = await register('admin');
  const sender = await register('dmsender');
  const t1 = await register('dmtarget1');
  const t2 = await register('dmtarget2');

  // The sender already started LIMIT - 1 conversations this hour. Written
  // straight into the database: registering that many accounts would trip
  // the sign-up rate limit.
  const Database = require('better-sqlite3');
  const db = new Database(path.join(DATA, 'haven.db'));
  const addDm = db.prepare("INSERT INTO channels (name, code, created_by, is_dm) VALUES ('DM', ?, ?, 1)");
  for (let i = 0; i < LIMIT - 1; i++) addDm.run(`seed${String(i).padStart(4, '0')}`, sender.user.id);
  db.close();

  const S = await connect(sender.token);
  assert.equal((await startDm(S, t1.user.id)).kind, 'opened', 'the last one in the hour opens');
  const over = await startDm(S, t2.user.id);
  assert.equal(over.kind, 'error');
  assert.match(over.data, /new conversations/);

  // Opening one that already exists still works, and notes to self are not counted.
  assert.equal((await startDm(S, t1.user.id)).kind, 'opened');
  assert.equal((await startDm(S, sender.user.id)).kind, 'opened');

  // The admin is not limited.
  const adb = new Database(path.join(DATA, 'haven.db'));
  const addAdminDm = adb.prepare("INSERT INTO channels (name, code, created_by, is_dm) VALUES ('DM', ?, ?, 1)");
  for (let i = 0; i < LIMIT; i++) addAdminDm.run(`adm${String(i).padStart(5, '0')}`, admin.user.id);
  adb.close();
  const A = await connect(admin.token);
  assert.equal((await startDm(A, t2.user.id)).kind, 'opened');
});

test('with a posting wait set, a new account waits before starting a DM', async () => {
  const adminLogin = await post('/api/auth/login', { username: 'admin', password: 'dmlimit12345', eulaVersion: '2.0', ageVerified: true });
  assert.ok(adminLogin.token, 'admin logs in');
  const A = await connect(adminLogin.token);
  A.emit('update-server-setting', { key: 'automod_enabled', value: 'true' });
  A.emit('update-server-setting', { key: 'automod_new_account_post_minutes', value: '30' });
  await wait(500);

  const fresh = await register('dmfresh');
  const other = await register('dmother');
  const F = await connect(fresh.token);
  const r = await startDm(F, other.user.id);
  assert.equal(r.kind, 'wait');
  assert.ok(r.data.minutes > 0);
  // A note to self is allowed.
  assert.equal((await startDm(F, fresh.user.id)).kind, 'opened');

  A.emit('update-server-setting', { key: 'automod_new_account_post_minutes', value: '0' });
  await wait(500);
  assert.equal((await startDm(F, other.user.id)).kind, 'opened', 'opens once the wait is off');
});
