/**
 * Deleting a parent channel takes its sub-channels with it.
 *
 * The parent link is ON DELETE SET NULL, so the sub-channels used to survive
 * their parent's deletion as top-level channels nobody had created. The delete
 * handler now removes them in the same transaction.
 *
 * Boots a server on a scratch port and data dir:
 *   node --test test/deleteParentChannel.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { io } = require('socket.io-client');

const PORT = 3395;
const BASE = `http://localhost:${PORT}`;
const DATA = path.join(os.tmpdir(), `haven-delete-parent-${Date.now()}`);

let server;
const sockets = [];

const post = (p, body) => new Promise((res, rej) => {
  const d = JSON.stringify(body);
  const r = http.request({ host: 'localhost', port: PORT, path: p, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) } },
    (x) => { let b = ''; x.on('data', (c) => (b += c)); x.on('end', () => { try { res(JSON.parse(b)); } catch { res({ raw: b }); } }); });
  r.on('error', rej); r.write(d); r.end();
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function connect(token) {
  const s = io(BASE, { auth: { token }, transports: ['websocket'], forceNew: true });
  sockets.push(s);
  return new Promise((res, rej) => { s.on('connect', () => res(s)); s.on('connect_error', rej); });
}
function next(sock, event, filter = () => true, ms = 4000) {
  return new Promise((res) => {
    const t = setTimeout(() => { sock.off(event, h); res(null); }, ms);
    const h = (data) => { if (!filter(data)) return; clearTimeout(t); sock.off(event, h); res(data); };
    sock.on(event, h);
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
// Close every client socket here as well as at the end of the test, so a
// failed assertion cannot leave one reconnecting forever and hang the runner.
test.after(() => {
  for (const s of sockets) { try { s.close(); } catch {} }
  server?.kill();
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch {}
});

test('deleting a parent channel removes its sub-channels instead of promoting them', async () => {
  const admin = await post('/api/auth/register', { username: 'admin', password: 'deletetest123', eulaVersion: '2.0', ageVerified: true });
  assert.ok(admin.token, 'admin registered');
  const A = await connect(admin.token);

  const parentSeen = next(A, 'channels-list', (chs) => Array.isArray(chs) && chs.some((c) => c.name === 'parent'));
  A.emit('create-channel', { name: 'parent' });
  const parent = (await parentSeen).find((c) => c.name === 'parent');
  assert.ok(parent && parent.code, 'parent created');

  const subsSeen = next(A, 'channels-list', (chs) => Array.isArray(chs) &&
    chs.some((c) => c.name === 'child-b' && c.parent_channel_id === parent.id));
  A.emit('create-sub-channel', { parentCode: parent.code, name: 'child-a' });
  await wait(150);
  A.emit('create-sub-channel', { parentCode: parent.code, name: 'child-b' });
  const withSubs = await subsSeen;
  assert.ok(withSubs, 'sub-channels created');
  assert.equal(withSubs.filter((c) => c.parent_channel_id === parent.id).length, 2, 'both sub-channels sit under the parent');

  // A bystander channel proves the delete is scoped to the parent's own tree.
  const otherSeen = next(A, 'channels-list', (chs) => Array.isArray(chs) && chs.some((c) => c.name === 'bystander'));
  A.emit('create-channel', { name: 'bystander' });
  assert.ok(await otherSeen, 'bystander created');

  const gone = next(A, 'channels-list', (chs) => Array.isArray(chs) && !chs.some((c) => c.name === 'parent'));
  A.emit('delete-channel', { code: parent.code });
  const after = await gone;
  assert.ok(after, 'a channel list arrived without the parent');
  const names = after.map((c) => c.name);
  assert.ok(!names.includes('child-a') && !names.includes('child-b'),
    `sub-channels were deleted with the parent, got: ${names.join(', ')}`);
  assert.ok(!after.some((c) => (c.name === 'child-a' || c.name === 'child-b') && !c.parent_channel_id),
    'no sub-channel was promoted to top level');
  assert.ok(names.includes('bystander'), 'the unrelated channel is untouched');

  A.close();
});
