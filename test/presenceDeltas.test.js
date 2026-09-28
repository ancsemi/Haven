/**
 * Member lists sent as changes only.
 *
 * A client that connects with presenceDeltas gets a channel's whole member
 * list once, then only the members that changed (online-users-delta), with
 * default-valued fields left out. An older client without the flag keeps
 * getting whole lists. Both must end up showing exactly the same members,
 * and an invisible member must stay hidden from everyone but themselves.
 *
 * Boots a server on a scratch port and data dir:
 *   node --test test/presenceDeltas.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { io } = require('socket.io-client');

const PORT = 3400;
const BASE = `http://localhost:${PORT}`;
const DATA = path.join(os.tmpdir(), `haven-presence-deltas-${Date.now()}`);

let server;

const post = (p, body) => new Promise((res, rej) => {
  const d = JSON.stringify(body);
  const r = http.request({ host: 'localhost', port: PORT, path: p, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) } },
    (x) => { let b = ''; x.on('data', (c) => (b += c)); x.on('end', () => { try { res(JSON.parse(b)); } catch { res({ raw: b }); } }); });
  r.on('error', rej); r.write(d); r.end();
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const register = (username) => post('/api/auth/register', { username, password: 'presence-test-123', eulaVersion: '2.0', ageVerified: true });

// The same fill-in and merge the web client does (app-socket.js).
const fillMember = (u) => ({
  highScore: 0, statusText: '', avatar: null, avatarShape: 'circle', border: null,
  borderTransform: null, animateProfile: 'trigger', isGuest: false, role: null, activity: null,
  ...u,
});

function client(token, deltas) {
  const s = io(BASE, { auth: deltas ? { token, presenceDeltas: 1 } : { token }, transports: ['websocket'], forceNew: true });
  s.lists = new Map();
  s.deltas = 0;
  s.slimSeen = false;
  s.on('online-users', (d) => {
    const users = d.slim ? d.users.map(fillMember) : d.users;
    s.lists.set(d.channelCode, users);
  });
  s.on('online-users-delta', (d) => {
    s.deltas++;
    if (d.upsert.some(u => !('avatarShape' in u))) s.slimSeen = true;
    const list = s.lists.get(d.channelCode);
    if (!list) return;
    const upsert = d.upsert.map(fillMember);
    const drop = new Set([...d.remove, ...upsert.map(u => u.id)]);
    s.lists.set(d.channelCode, list.filter(u => !drop.has(u.id)).concat(upsert));
  });
  return new Promise((res, rej) => { s.on('connect', () => res(s)); s.on('connect_error', rej); });
}
function next(sock, event, filter = () => true, ms = 4000) {
  return new Promise((res) => {
    const t = setTimeout(() => { sock.off(event, h); res(null); }, ms);
    const h = (data) => { if (!filter(data)) return; clearTimeout(t); sock.off(event, h); res(data); };
    sock.on(event, h);
  });
}
const view = (sock, code) => [...(sock.lists.get(code) || [])]
  .sort((a, b) => a.id - b.id)
  .map(u => JSON.stringify(u, Object.keys(u).sort()));
const names = (sock, code) => (sock.lists.get(code) || []).map(u => u.username).sort();

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

test('changes-only member lists match the full lists older clients get', async () => {
  const [admin, bob, carol, dave] = [await register('admin'), await register('bob'), await register('carol'), await register('dave')];
  assert.ok(admin.token && bob.token && carol.token && dave.token, 'all registered');

  const A = await client(admin.token, true);
  const made = next(A, 'channels-list', (chs) => Array.isArray(chs) && chs.some((c) => c.name === 'lounge'));
  A.emit('create-channel', { name: 'lounge' });
  const code = (await made).find((c) => c.name === 'lounge').code;
  A.emit('enter-channel', { code });

  const B = await client(bob.token, true);
  const C = await client(carol.token, true);
  const L = await client(dave.token, false);   // an older app
  for (const s of [B, C, L]) { s.emit('join-channel', { code }); await wait(100); s.emit('enter-channel', { code }); }
  await wait(1500);

  assert.deepStrictEqual(names(A, code), ['admin', 'bob', 'carol', 'dave'], 'everyone listed for a deltas client');
  assert.deepStrictEqual(names(L, code), ['admin', 'bob', 'carol', 'dave'], 'everyone listed for an older client');
  assert.deepStrictEqual(view(A, code), view(L, code), 'same entries either way');

  // A status change reaches the deltas client as a change only.
  const before = A.deltas;
  B.emit('set-status', { status: 'away', statusText: 'brb' });
  await wait(1200);
  assert.ok(A.deltas > before, 'the change came as a delta');
  assert.ok(A.slimSeen, 'delta entries leave default fields out');
  const bobSeen = A.lists.get(code).find(u => u.username === 'bob');
  assert.strictEqual(bobSeen.status, 'away');
  assert.strictEqual(bobSeen.statusText, 'brb');
  assert.strictEqual(bobSeen.avatarShape, 'circle', 'defaults are filled back in');
  assert.deepStrictEqual(view(A, code), view(L, code), 'still the same entries after the change');
  assert.strictEqual(L.deltas, 0, 'the older client never gets deltas');

  // Carol goes invisible: gone for everyone else, still there for herself.
  C.emit('set-status', { status: 'invisible', statusText: '' });
  await wait(1200);
  assert.deepStrictEqual(names(A, code), ['admin', 'bob', 'dave'], 'hidden from a deltas client');
  assert.deepStrictEqual(names(L, code), ['admin', 'bob', 'dave'], 'hidden from an older client');
  const self = C.lists.get(code).find(u => u.username === 'carol');
  assert.ok(self && self.status === 'invisible', 'she still sees herself, as invisible');

  // ...and back.
  C.emit('set-status', { status: 'online', statusText: '' });
  await wait(1200);
  assert.deepStrictEqual(names(A, code), ['admin', 'bob', 'carol', 'dave'], 'back for a deltas client');
  assert.deepStrictEqual(view(A, code), view(L, code), 'same entries once visible again');

  // Leaving drops the member from both kinds of list.
  B.disconnect();
  await wait(1500);
  assert.deepStrictEqual(names(A, code), ['admin', 'carol', 'dave'], 'bob gone for a deltas client');
  assert.deepStrictEqual(names(L, code), ['admin', 'carol', 'dave'], 'bob gone for an older client');
  assert.deepStrictEqual(view(A, code), view(L, code), 'same entries at the end');

  // Entering the channel again brings the whole list, as on switching back.
  const full = next(A, 'online-users', (d) => d.channelCode === code);
  A.emit('enter-channel', { code });
  assert.ok(await full, 'a whole list arrives on entering the channel again');

  for (const s of [A, C, L]) s.disconnect();
});
