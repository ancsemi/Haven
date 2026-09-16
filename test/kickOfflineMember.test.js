/**
 * Kicking a member who is not online.
 *
 * Kick used to refuse anyone who was not in the channel's live presence map
 * ("User is not currently online in this channel (use ban instead)"), so a
 * member who had gone offline could not be removed at all. Kicking is a
 * membership change; only the live parts need a connection.
 *
 * Boots a server on a scratch port and data dir:
 *   node --test test/kickOfflineMember.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { io } = require('socket.io-client');

const PORT = 3398;
const BASE = `http://localhost:${PORT}`;
const DATA = path.join(os.tmpdir(), `haven-kick-offline-${Date.now()}`);

let server;

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
test.after(() => { server?.kill(); try { fs.rmSync(DATA, { recursive: true, force: true }); } catch {} });

test('an admin can kick a member who has gone offline', async () => {
  const admin = await post('/api/auth/register', { username: 'admin', password: 'kicktest123', eulaVersion: '2.0', ageVerified: true });
  const bob = await post('/api/auth/register', { username: 'bob', password: 'kicktest123', eulaVersion: '2.0', ageVerified: true });
  assert.ok(admin.token && bob.token, 'both registered');
  const A = await connect(admin.token);

  const list = next(A, 'channels-list', (chs) => Array.isArray(chs) && chs.some((c) => c.name === 'lounge'));
  A.emit('create-channel', { name: 'lounge' });
  const code = (await list).find((c) => c.name === 'lounge').code;
  A.emit('enter-channel', { code });
  await wait(200);

  // Bob joins, shows up, then leaves the building.
  const B = await connect(bob.token);
  const seen = next(A, 'online-users', (d) => d && d.channelCode === code && d.users.some((u) => u.username === 'bob'));
  B.emit('join-channel', { code });
  await wait(300);
  B.emit('enter-channel', { code });
  const online = await seen;
  assert.ok(online, 'bob was seen online in the channel');
  const bobId = online.users.find((u) => u.username === 'bob').id;
  const gone = next(A, 'online-users', (d) => d && d.channelCode === code && !d.users.some((u) => u.username === 'bob'));
  B.close();
  assert.ok(await gone, 'bob is offline now');

  // The kick lands anyway.
  const errors = [];
  A.on('error-msg', (m) => errors.push(m));
  const toast = next(A, 'toast', (d) => d && /Kicked bob/.test(d.message));
  const notice = next(A, 'new-message', (d) => d && d.channelCode === code && d.message && /bob was kicked/.test(d.message.content));
  A.emit('kick-user', { userId: bobId });
  const t = await toast;
  assert.ok(t && t.type === 'success', 'the admin gets a success toast, not a red error');
  assert.ok(await notice, 'the channel hears that bob was kicked');
  assert.deepStrictEqual(errors.filter((m) => /not currently online|not in this channel/.test(m)), [], 'no refusal');

  // Kicking someone who was never a member is still refused.
  const refusal = next(A, 'error-msg', (m) => /not in this channel/.test(m));
  A.emit('kick-user', { userId: bobId });
  assert.ok(await refusal, 'a second kick of a non-member is refused');

  A.close();
});
