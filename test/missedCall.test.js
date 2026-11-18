'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { io } = require('socket.io-client');
const PORT = 3431;
const BASE = `http://localhost:${PORT}`;
const DATA = path.join(os.tmpdir(), `haven-missed-call-${Date.now()}`);
let server;
const users = {};
const socks = {};
const post = (p, body) => new Promise((res, rej) => {
  const d = JSON.stringify(body);
  const r = http.request({ host: 'localhost', port: PORT, path: p, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) } },
    (x) => { let b = ''; x.on('data', (c) => (b += c)); x.on('end', () => { try { res(JSON.parse(b)); } catch { res({ raw: b }); } }); });
  r.on('error', rej); r.write(d); r.end();
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const connect = (token) => new Promise((res, rej) => { const s = io(BASE, { auth: { token }, transports: ['websocket'], forceNew: true }); s.on('connect', () => res(s)); s.on('connect_error', rej); });
const next = (sock, event, filter = () => true, ms = 4000) => new Promise((res) => {
  const t = setTimeout(() => { sock.off(event, h); res(null); }, ms);
  const h = (data) => { if (!filter(data)) return; clearTimeout(t); sock.off(event, h); res(data); };
  sock.on(event, h);
});
test.before(async () => {
  fs.mkdirSync(DATA, { recursive: true });
  server = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), HAVEN_DATA_DIR: DATA, ADMIN_USERNAME: 'admin', FORCE_HTTP: 'true' }, stdio: 'ignore' });
  for (let i = 0; ; i++) {
    try { await new Promise((res, rej) => http.get(`${BASE}/api/health`, (r) => (r.statusCode === 200 ? res() : rej())).on('error', rej)); break; } catch { if (i > 60) throw new Error('server did not start'); await wait(500); }
  }
  for (const n of ['admin', 'bob', 'carol']) {
    users[n] = await post('/api/auth/register', { username: n, password: 'misscall123', eulaVersion: '2.0', ageVerified: true });
    socks[n] = await connect(users[n].token);
  }
  await wait(400);
});
test.after(async () => {
  for (const s of Object.values(socks)) s.close();
  server.kill();
  await wait(300);
  fs.rmSync(DATA, { recursive: true, force: true });
});
test('a call that is hung up before anyone answers is kept in the DM for both people, and counts as unread (#5901)', async () => {
  const opened = next(socks.bob, 'dm-opened');
  socks.bob.emit('start-dm', { targetUserId: users.carol.user.id });
  const { code } = await opened;
  await wait(300);
  const ringing = next(socks.carol, 'dm-call-ring', (d) => d.code === code);
  socks.bob.emit('voice-join', { code });
  assert.ok(await ringing, 'carol is rung');
  const liveCarol = next(socks.carol, 'new-message', (d) => d.channelCode === code);
  const liveBob = next(socks.bob, 'new-message', (d) => d.channelCode === code);
  socks.bob.emit('voice-leave', { code });
  const [c, b] = await Promise.all([liveCarol, liveBob]);
  assert.ok(c && b, 'both people are told live');
  assert.strictEqual(c.message.type, 'missed_call');
  assert.strictEqual(c.message.content, 'Missed call from bob');
  assert.strictEqual(c.message.user_id, users.bob.user.id);
  assert.strictEqual(c.message.system, true);
  const history = next(socks.carol, 'message-history', (d) => d.channelCode === code);
  socks.carol.emit('get-messages', { code });
  const h = await history;
  const row = h.messages.find((m) => m.type === 'missed_call');
  assert.ok(row, 'it is in the history');
  assert.strictEqual(row.id, c.message.id);
  assert.strictEqual(row.system, true);
  assert.strictEqual(row.user_id, users.bob.user.id);
  assert.ok(row.created_at, 'with the time of the call');
  const list = next(socks.carol, 'channels-list');
  socks.carol.emit('get-channels');
  const dm = ((await list) || []).find((ch) => ch.code === code);
  assert.strictEqual(dm.unreadCount, 1);
});
