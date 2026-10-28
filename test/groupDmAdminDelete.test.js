/**
 * The server admin deletes a group DM for everyone (#5740).
 *
 * Only an admin can: not a member, not the group's creator. It removes the
 * group with its messages, keys and invites, moves the members' attachments
 * aside, and every member's app (and a pending invitee's) is told at once.
 * An admin outside the group can do it too, through Delete DM.
 *
 * Boots a server on a scratch port and data dir:
 *   node --test test/groupDmAdminDelete.test.js
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

const PORT = 3404;
const BASE = `http://localhost:${PORT}`;
const DATA = path.join(os.tmpdir(), `haven-group-admin-delete-${Date.now()}`);

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
async function upload(token) {
  const fd = new FormData();
  fd.append('scope', 'dm');
  fd.append('file', new Blob([Buffer.from('encrypted group attachment stand-in')], { type: 'application/octet-stream' }), 'e2e-file.enc');
  const r = await fetch(`${BASE}/api/upload-file`, { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd });
  return r.json();
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

/** A group started by `creator`, joined by `joiners`, with `pending` left invited. */
async function makeGroup(creator, joiners, pending = []) {
  const opened = next(socks[creator], 'group-dm-opened');
  socks[creator].emit('start-group-dm', { userIds: [...joiners, ...pending].map((n) => users[n].user.id), name: `G-${creator}-${joiners.join('')}` });
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
const groupRows = (code) => {
  const ch = readDb('SELECT id FROM channels WHERE code = ?', code)[0];
  if (!ch) return null;
  const count = (table) => readDb(`SELECT COUNT(*) AS n FROM ${table} WHERE channel_id = ?`, ch.id)[0].n;
  return { keys: count('dm_group_keys'), epochs: count('dm_group_epochs'), invites: count('dm_group_invites') };
};

test('setup', async () => {
  for (const n of ['admin', 'bob', 'carol', 'dave', 'erin']) {
    users[n] = await register(n);
    socks[n] = await connect(users[n].token);
    socks[n].emit('publish-public-key', { jwk: jwk(n) });
    socks[n].emit('publish-signing-key', { jwk: jwk(`s${n}`) });
  }
  await wait(600);
});

test('a member who is not the server admin cannot delete a group for everyone, the creator included', async () => {
  const code = await makeGroup('bob', ['admin', 'carol']);
  for (const n of ['carol', 'bob']) {
    const refused = next(socks[n], 'error-msg', (m) => /server admin/.test(m));
    const gone = next(socks.admin, 'channel-deleted', (d) => d.code === code, 800);
    socks[n].emit('delete-group-dm-for-everyone', { code });
    assert.ok(await refused, `${n} is refused`);
    assert.strictEqual(await gone, null, 'nobody loses the group');
  }
  assert.ok(groupRows(code), 'the group is still there');

  // Someone outside the group cannot either, by either route.
  const refused = next(socks.erin, 'error-msg');
  socks.erin.emit('delete-dm', { code, confirmed: true });
  assert.ok(await refused, 'Delete DM from outside is refused');
  const refused2 = next(socks.erin, 'error-msg');
  socks.erin.emit('delete-group-dm-for-everyone', { code });
  assert.ok(await refused2, 'and so is the direct request');
  assert.ok(groupRows(code), 'the group is still there');
});

test('the admin deletes a group for everyone: members and invitees are told, keys and files go', async () => {
  const code = await makeGroup('bob', ['admin', 'carol'], ['dave']);
  assert.deepStrictEqual(groupRows(code), { keys: 3, epochs: 1, invites: 1 });
  const file = await upload(users.bob.token);
  assert.ok(file.url, 'bob uploaded an attachment');
  const rel = file.url.replace('/uploads/', '');
  assert.ok(fs.existsSync(path.join(DATA, 'uploads', rel)));

  const order = [];
  socks.carol.on('group-dm-deleted', (d) => d.code === code && order.push('group-dm-deleted'));
  socks.carol.on('channel-deleted', (d) => d.code === code && order.push('channel-deleted'));
  const bobGone = next(socks.bob, 'channel-deleted', (d) => d.code === code);
  const carolGone = next(socks.carol, 'channel-deleted', (d) => d.code === code);
  const daveTold = next(socks.dave, 'group-dm-deleted', (d) => d.code === code);
  const adminTold = next(socks.admin, 'group-dm-deleted', (d) => d.code === code);
  socks.admin.emit('delete-group-dm-for-everyone', { code, attachments: [file.url] });

  assert.ok(await bobGone, 'the creator loses it at once');
  assert.ok(await carolGone, 'so does every other member');
  assert.ok(await daveTold, 'a pending invitee is told, so the invite goes away');
  assert.ok(await adminTold, 'the admin hears it is done');
  assert.deepStrictEqual(order, ['group-dm-deleted', 'channel-deleted'], 'members hear which group it was before it goes');
  assert.strictEqual(groupRows(code), null, 'the channel is gone');
  const leftovers = ['dm_group_keys', 'dm_group_epochs', 'dm_group_invites', 'dm_group_rewrap_requests']
    .map((t) => readDb(`SELECT COUNT(*) AS n FROM ${t} WHERE channel_id NOT IN (SELECT id FROM channels)`)[0].n);
  assert.deepStrictEqual(leftovers, [0, 0, 0, 0], 'no key or invite rows are left behind');
  assert.ok(!fs.existsSync(path.join(DATA, 'uploads', rel)), 'the attachment was moved out of uploads');
  assert.ok(fs.readdirSync(path.join(DATA, 'uploads', 'deleted-attachments'), { recursive: true }).some((f) => String(f).includes(rel)),
    'into deleted-attachments');

  const accept = next(socks.dave, 'error-msg');
  socks.dave.emit('accept-group-dm', { code });
  assert.ok(await accept, 'the old invite no longer works');
});

test('an admin outside the group can delete it for everyone through Delete DM', async () => {
  const code = await makeGroup('bob', ['carol', 'dave']);
  const told = next(socks.carol, 'group-dm-deleted', (d) => d.code === code);
  const gone = next(socks.dave, 'channel-deleted', (d) => d.code === code);
  socks.admin.emit('delete-dm', { code, confirmed: true });
  assert.ok(await told, 'members are told');
  assert.ok(await gone, 'and lose it at once');
  assert.strictEqual(groupRows(code), null, 'the group is gone');
});

test('an admin demoted since connecting is refused', async () => {
  const code = await makeGroup('bob', ['carol', 'erin']);
  // Hand the admin flag to nobody behind the open connection's back.
  const db = new Database(path.join(DATA, 'haven.db'));
  try { db.prepare('UPDATE users SET is_admin = 0 WHERE id = ?').run(users.admin.user.id); } finally { db.close(); }
  const refused = next(socks.admin, 'error-msg', (m) => /server admin/.test(m));
  socks.admin.emit('delete-dm', { code, confirmed: true });
  assert.ok(await refused, 'the stale admin flag is not enough');
  assert.ok(groupRows(code), 'the group is still there');
});
