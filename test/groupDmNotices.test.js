/**
 * A group DM's history says who was invited, who joined, who left and who
 * was removed. The rows hold ids and names only (the app writes the words),
 * are sent live as group-notice, and never count as unread messages.
 *
 *   node --test test/groupDmNotices.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { io } = require('socket.io-client');
const Database = require('better-sqlite3');

const PORT = 3406;
const BASE = `http://localhost:${PORT}`;
const DATA = path.join(os.tmpdir(), `haven-group-notices-${Date.now()}`);

let server;

const post = (p, body) => new Promise((res, rej) => {
  const d = JSON.stringify(body);
  const r = http.request({ host: 'localhost', port: PORT, path: p, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) } },
    (x) => { let b = ''; x.on('data', (c) => (b += c)); x.on('end', () => { try { res(JSON.parse(b)); } catch { res({ raw: b }); } }); });
  r.on('error', rej); r.write(d); r.end();
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const register = (username) =>
  post('/api/auth/register', { username, password: 'grouptest123', eulaVersion: '2.0', ageVerified: true });
const clients = [];
function connect(token) {
  const s = io(BASE, { auth: { token }, transports: ['websocket'], forceNew: true });
  clients.push(s);
  return new Promise((res, rej) => { s.on('connect', () => res(s)); s.on('connect_error', rej); });
}
function next(sock, event, filter = () => true, ms = 4000) {
  return new Promise((res) => {
    const t = setTimeout(() => { sock.off(event, h); res(null); }, ms);
    const h = (data) => { if (!filter(data)) return; clearTimeout(t); sock.off(event, h); res(data); };
    sock.on(event, h);
  });
}
const readDb = (sql, ...args) => {
  const db = new Database(path.join(DATA, 'haven.db'), { readonly: true, fileMustExist: true });
  try { return db.prepare(sql).all(...args); } finally { db.close(); }
};
const jwk = (x) => ({ kty: 'EC', crv: 'P-256', x, y: `y${x}` });
const epochFor = (users) => ({
  keys: users.map((u) => ({ recipientId: u.user.id, wrappedKey: JSON.stringify({ v: 1, iv: 'AAAAAAAAAAAAAAAA', ct: `w${u.user.id}` }) })),
  sig: 'c2lnbmVk',
  roster: users.map((u) => ({ id: u.user.id, ecdhJwk: jwk(`e${u.user.id}`), signJwk: jwk(`s${u.user.id}`) })),
});

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
  fs.rmSync(DATA, { recursive: true, force: true, maxRetries: 5 });
});

const users = {};
const socks = {};

async function makeGroup(creator, joiners) {
  const opened = next(socks[creator], 'group-dm-opened');
  socks[creator].emit('start-group-dm', { userIds: joiners.map((n) => users[n].user.id), name: `G-${creator}-${joiners.join('')}` });
  const { code } = await opened;
  for (const n of joiners) {
    const joined = next(socks[n], 'group-dm-opened', (d) => d.code === code);
    socks[n].emit('accept-group-dm', { code });
    assert.ok(await joined, `${n} joined`);
  }
  const published = next(socks[creator], 'group-epoch-published', (d) => d.code === code);
  socks[creator].emit('publish-group-epoch', { code, epoch: 1, ...epochFor([creator, ...joiners].map((n) => users[n])) });
  assert.ok(await published, 'first key published');
  return code;
}
const membersOf = (code) => readDb('SELECT cm.user_id FROM channel_members cm JOIN channels c ON c.id = cm.channel_id WHERE c.code = ? ORDER BY cm.user_id', code)
  .map((r) => r.user_id);
const ids = (...names) => names.map((n) => users[n].user.id).sort((a, b) => a - b);

test('setup', async () => {
  for (const n of ['admin', 'bob', 'carol', 'dave', 'erin']) {
    users[n] = await register(n);
    socks[n] = await connect(users[n].token);
    socks[n].emit('publish-public-key', { jwk: jwk(n) });
    socks[n].emit('publish-signing-key', { jwk: jwk(`s${n}`) });
  }
  await wait(600);
});

const notices = (code) => readDb("SELECT m.user_id, m.content FROM messages m JOIN channels c ON c.id = m.channel_id WHERE c.code = ? AND m.type = 'notice' ORDER BY m.id", code)
  .map((r) => ({ ...JSON.parse(r.content), actor: r.user_id }));

test('invites, joins, leaves and removals leave a line in the group', async () => {
  const code = await makeGroup('bob', ['carol', 'dave']);
  let n = notices(code);
  assert.deepStrictEqual(n.map((x) => x.event), ['invited', 'joined', 'joined']);
  assert.strictEqual(n[0].actor, users.bob.user.id);
  assert.deepStrictEqual(n[0].users.map((u) => u.id), ids('carol', 'dave'));
  assert.strictEqual(n[0].users[0].name, 'carol');
  assert.ok(n.every((x) => x.by.id === x.actor), 'the row belongs to whoever acted');
  assert.strictEqual(n[1].actor, users.carol.user.id);

  const live = next(socks.carol, 'group-notice', (d) => d.channelCode === code);
  socks.bob.emit('invite-group-dm', { code, userIds: [users.admin.user.id, users.erin.user.id] });
  const got = await live;
  assert.ok(got, 'members are told live');
  assert.strictEqual(got.message.type, 'notice');
  assert.deepStrictEqual(JSON.parse(got.message.content).users.map((u) => u.id), ids('admin', 'erin'));

  // Inviting someone already invited adds nothing.
  socks.bob.emit('invite-group-dm', { code, userIds: [users.erin.user.id] });
  await wait(400);
  assert.strictEqual(notices(code).length, 4);

  const erinIn = next(socks.erin, 'group-dm-opened', (d) => d.code === code);
  socks.erin.emit('accept-group-dm', { code });
  assert.ok(await erinIn);
  socks.admin.emit('decline-group-dm', { code });
  await wait(300);

  socks.carol.emit('leave-group-dm', { code, attachments: [] });
  await wait(400);
  socks.bob.emit('remove-group-member', { code, userId: users.dave.user.id });
  await wait(400);
  n = notices(code);
  assert.deepStrictEqual(n.map((x) => x.event), ['invited', 'joined', 'joined', 'invited', 'joined', 'left', 'removed']);
  assert.strictEqual(n[4].actor, users.erin.user.id);
  assert.strictEqual(n[5].actor, users.carol.user.id);
  assert.strictEqual(n[6].actor, users.bob.user.id);
  assert.deepStrictEqual(n[6].users.map((u) => u.id), [users.dave.user.id]);
});

test('notices are not unread messages', async () => {
  const code = await makeGroup('admin', ['bob', 'carol']);
  const list = next(socks.bob, 'channels-list');
  socks.bob.emit('get-channels');
  const chans = await list;
  const g = (chans || []).find((c) => c.code === code);
  assert.ok(g, 'group is listed');
  assert.strictEqual(g.unreadCount, 0);
});

test('someone who joins later is sent nothing from before they joined', async () => {
  const code = await makeGroup('bob', ['carol', 'dave']);
  const envelope = (ct) => JSON.stringify({ v: 3, e: 1, prev: null, iv: 'AAAAAAAAAAAAAAAA', ct, sig: 'c2ln' });
  socks.bob.emit('send-message', { code, content: envelope('b2xk') });
  await wait(400);
  socks.bob.emit('pin-message', { messageId: readDb('SELECT MAX(m.id) AS id FROM messages m JOIN channels c ON c.id = m.channel_id WHERE c.code = ?', code)[0].id });
  // Join times are kept to the second.
  await wait(1200);
  socks.bob.emit('invite-group-dm', { code, userIds: [users.erin.user.id] });
  const joined = next(socks.erin, 'group-dm-opened', (d) => d.code === code);
  socks.erin.emit('accept-group-dm', { code });
  assert.ok(await joined);
  await wait(1200);
  socks.bob.emit('send-message', { code, content: envelope('bmV3') });
  await wait(400);

  const history = next(socks.erin, 'message-history', (d) => d.channelCode === code);
  socks.erin.emit('get-messages', { code });
  const got = await history;
  const cts = got.messages.filter((m) => m.type !== 'notice').map((m) => JSON.parse(m.content).ct);
  assert.deepStrictEqual(cts, ['bmV3']);
  assert.ok(got.messages.some((m) => m.type === 'notice' && JSON.parse(m.content).event === 'joined'));

  const older = next(socks.erin, 'message-history', (d) => d.channelCode === code);
  socks.erin.emit('get-messages', { code, before: got.messages[0].id });
  assert.deepStrictEqual((await older).messages, []);

  const pins = next(socks.erin, 'pinned-messages', (d) => d.channelCode === code);
  socks.erin.emit('get-pinned-messages', { code });
  assert.deepStrictEqual((await pins).pins, []);

  const list = next(socks.erin, 'channels-list');
  socks.erin.emit('get-channels');
  assert.strictEqual((await list).find((c) => c.code === code).unreadCount, 1);

  const carolHistory = next(socks.carol, 'message-history', (d) => d.channelCode === code);
  socks.carol.emit('get-messages', { code });
  assert.strictEqual((await carolHistory).messages.filter((m) => m.type !== 'notice').length, 2, 'earlier members keep everything');
});
