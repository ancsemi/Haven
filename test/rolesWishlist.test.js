/**
 * Role templates, role-gated channels, per-role upload caps, channel
 * templates and self-assign role menus.
 *
 * Needs a running Haven server. Boots one on a scratch port and data dir:
 *   node --test test/rolesWishlist.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { io } = require('socket.io-client');

const PORT = 3397;
const BASE = `http://localhost:${PORT}`;
const DATA = path.join(os.tmpdir(), `haven-roles-${Date.now()}`);

let server;

const post = (p, body) => new Promise((res, rej) => {
  const d = JSON.stringify(body);
  const r = http.request({ host: 'localhost', port: PORT, path: p, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) } },
    (x) => { let b = ''; x.on('data', (c) => (b += c)); x.on('end', () => { try { res(JSON.parse(b)); } catch { res({ raw: b }); } }); });
  r.on('error', rej); r.write(d); r.end();
});

// One-file multipart POST to /api/upload-file with a bearer token.
const upload = (token, name, bytes) => new Promise((res, rej) => {
  const boundary = '----haven' + Date.now();
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([head, bytes, tail]);
  const r = http.request({ host: 'localhost', port: PORT, path: '/api/upload-file', method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length, Authorization: `Bearer ${token}` } },
    (x) => { let b = ''; x.on('data', (c) => (b += c)); x.on('end', () => { let j = null; try { j = JSON.parse(b); } catch {} res({ status: x.statusCode, body: j }); }); });
  r.on('error', rej); r.write(body); r.end();
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

const ask = (sock, event, payload) => new Promise((res) => sock.emit(event, payload, res));

function channelsOf(sock) {
  const p = next(sock, 'channels-list', (chs) => Array.isArray(chs));
  sock.emit('get-channels');
  return p;
}

function history(sock, code, opts = {}) {
  const p = next(sock, 'message-history', (d) => d && d.channelCode === code, 2500);
  const err = next(sock, 'error-msg', () => true, 2500);
  sock.emit('get-messages', { code, ...opts });
  return Promise.race([p.then((d) => (d ? { history: d } : null)), err.then((e) => (e ? { error: e } : null))]).then((r) => r || {});
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

test('roles wishlist: gates, caps, menus, templates', async (t) => {
  const admin = await post('/api/auth/register', { username: 'admin', password: 'rolestest123', eulaVersion: '2.0', ageVerified: true });
  assert.ok(admin.token, 'admin registered');
  const bob = await post('/api/auth/register', { username: 'bob', password: 'rolestest123', eulaVersion: '2.0', ageVerified: true });
  assert.ok(bob.token, 'bob registered');
  const cara = await post('/api/auth/register', { username: 'cara', password: 'rolestest123', eulaVersion: '2.0', ageVerified: true });
  assert.ok(cara.token, 'cara registered');

  const A = await connect(admin.token);
  const B = await connect(bob.token);
  const C = await connect(cara.token);
  await wait(300);

  // A channel everyone is in, so the gate is the only thing between bob and it.
  let list = next(A, 'channels-list', (chs) => Array.isArray(chs) && chs.some((c) => c.name === 'gated'));
  A.emit('create-channel', { name: 'gated', addAllMembers: true });
  let channels = await list;
  assert.ok(channels, 'gated channel created');
  const gated = channels.find((c) => c.name === 'gated').code;
  await wait(300);

  const alpha = await ask(A, 'create-role', { name: 'Alpha', level: 5, color: '#ff0000', permissions: ['upload_files'] });
  const beta = await ask(A, 'create-role', { name: 'Beta', level: 5, color: '#00ff00', permissions: ['upload_files'], maxUploadMb: 5 });
  const gamma = await ask(A, 'create-role', { name: 'Gamers', level: 0, color: '#0000ff' });
  assert.ok(alpha.roleId && beta.roleId && gamma.roleId, 'three roles created');

  await t.test('per-role upload cap rides along on the role', async () => {
    const { roles } = await ask(A, 'get-roles', {});
    assert.strictEqual(roles.find((r) => r.id === beta.roleId).max_upload_mb, 5);
    assert.strictEqual(roles.find((r) => r.id === alpha.roleId).max_upload_mb, null);
  });

  await t.test('a gate needing ALL roles hides the channel until every role is held', async () => {
    let chs = await channelsOf(B);
    assert.ok(chs.some((c) => c.code === gated), 'bob sees the channel before the gate');

    const res = await ask(A, 'set-channel-role-gate', { code: gated, mode: 'all', roles: [alpha.roleId, beta.roleId] });
    assert.deepStrictEqual(res.roleGate, { mode: 'all', roles: [alpha.roleId, beta.roleId] });
    await wait(300);

    chs = await channelsOf(B);
    assert.ok(!chs.some((c) => c.code === gated), 'bob loses the channel with no roles');
    const h = await history(B, gated);
    assert.ok(h.error && /role/i.test(h.error), `history refused: ${h.error}`);

    await ask(A, 'assign-role', { userId: bob.user.id, roleId: alpha.roleId });
    await wait(300);
    chs = await channelsOf(B);
    assert.ok(!chs.some((c) => c.code === gated), 'one of two roles is not enough for ALL');

    await ask(A, 'assign-role', { userId: bob.user.id, roleId: beta.roleId });
    await wait(300);
    chs = await channelsOf(B);
    assert.ok(chs.some((c) => c.code === gated), 'both roles open the channel');
    const ok = await history(B, gated);
    assert.ok(ok.history, 'history loads once the gate passes');

    const adminChs = await channelsOf(A);
    assert.ok(adminChs.some((c) => c.code === gated), 'admins are never gated');
  });

  await t.test('ANY mode opens the channel with one of the roles', async () => {
    await ask(A, 'revoke-role', { userId: bob.user.id, roleId: beta.roleId });
    await ask(A, 'set-channel-role-gate', { code: gated, mode: 'any', roles: [alpha.roleId, beta.roleId] });
    await wait(300);
    const chs = await channelsOf(B);
    assert.ok(chs.some((c) => c.code === gated), 'alpha alone is enough for ANY');
    const gate = JSON.parse(chs.find((c) => c.code === gated).role_gate);
    assert.strictEqual(gate.mode, 'any');
    await ask(A, 'assign-role', { userId: bob.user.id, roleId: beta.roleId });
    await wait(200);
  });

  await t.test('deleting a role drops it from every gate', async () => {
    await ask(A, 'delete-role', { roleId: alpha.roleId });
    await wait(300);
    const chs = await channelsOf(A);
    const gate = JSON.parse(chs.find((c) => c.code === gated).role_gate);
    assert.deepStrictEqual(gate.roles, [beta.roleId]);
  });

  await t.test('the upload cap is the server setting, raised by a role', async () => {
    A.emit('update-server-setting', { key: 'max_upload_mb', value: '1' });
    await wait(300);
    const bobSettings = await new Promise((res) => { B.once('server-settings', (s) => res(s)); B.emit('get-server-settings'); });
    assert.strictEqual(bobSettings.max_upload_mb, '1');
    assert.strictEqual(bobSettings.max_upload_mb_effective, '5', 'bob holds Beta (5 MB)');
    const caraSettings = await new Promise((res) => { C.once('server-settings', (s) => res(s)); C.emit('get-server-settings'); });
    assert.strictEqual(caraSettings.max_upload_mb_effective, '1', 'cara has no cap-raising role');

    const twoMb = Buffer.alloc(2 * 1024 * 1024, 7);
    const okUp = await upload(bob.token, 'big.bin', twoMb);
    assert.strictEqual(okUp.status, 200, `bob's 2 MB upload accepted: ${JSON.stringify(okUp.body)}`);
    const noUp = await upload(cara.token, 'big.bin', twoMb);
    assert.strictEqual(noUp.status, 400, 'cara is held to the 1 MB server cap');
    assert.match(noUp.body.error, /max 1 MB/);
  });

  await t.test('a role menu hands out roles by click and by reaction', async () => {
    const made = next(A, 'channels-list', (chs) => Array.isArray(chs) && chs.some((c) => c.name === 'general'));
    A.emit('create-channel', { name: 'general', addAllMembers: true });
    const chs = await made;
    const general = chs.find((c) => c.name === 'general').code;
    await wait(300);
    B.emit('enter-channel', { code: general });
    await wait(200);
    const incoming = next(B, 'new-message', (d) => d && d.message && d.message.roleMenu);
    const posted = await ask(A, 'create-role-menu', { code: general, title: 'Pick a game', roles: [{ roleId: gamma.roleId, emoji: '🎮' }] });
    assert.ok(posted.messageId, `menu posted: ${JSON.stringify(posted)}`);
    const msg = await incoming;
    assert.ok(msg, 'bob received the menu message');
    assert.deepStrictEqual(msg.message.roleMenu.roles.map((r) => [r.id, r.emoji, r.name]), [[gamma.roleId, '🎮', 'Gamers']]);
    assert.deepStrictEqual(msg.message.roleMenu.held, []);
    assert.ok(msg.message.reactions.some((r) => r.emoji === '🎮'), 'the emoji chip is seeded');

    // Click path.
    let rolesPush = next(B, 'roles-updated', (d) => d && Array.isArray(d.roles));
    const clicked = await ask(B, 'toggle-self-role', { messageId: posted.messageId, roleId: gamma.roleId });
    assert.strictEqual(clicked.held, true);
    const pushed = await rolesPush;
    assert.ok(pushed.roles.some((r) => r.id === gamma.roleId || r.role_id === gamma.roleId || r.name === 'Gamers'), 'bob now holds Gamers');

    // The history carries what the reader holds.
    const h = await history(B, general);
    const menuMsg = h.history.messages.find((m) => m.id === posted.messageId);
    assert.deepStrictEqual(menuMsg.roleMenu.held, [gamma.roleId]);

    // Reaction path: taking the emoji back drops the role, adding it again grants it.
    let flip = next(B, 'self-role-updated', (d) => d && d.roleId === gamma.roleId && d.held === false);
    B.emit('remove-reaction', { messageId: posted.messageId, emoji: '🎮' });
    assert.ok(await flip, 'removing the reaction dropped the role');
    flip = next(B, 'self-role-updated', (d) => d && d.roleId === gamma.roleId && d.held === true);
    B.emit('add-reaction', { messageId: posted.messageId, emoji: '🎮' });
    assert.ok(await flip, 'reacting again granted the role');

    // Someone with no say over roles cannot post a menu.
    const denied = await ask(C, 'create-role-menu', { code: general, roles: [{ roleId: gamma.roleId, emoji: '🎮' }] });
    assert.ok(denied.error, 'cara cannot post a role menu');
  });

  await t.test('channel templates send the rest of the setup with the name', async () => {
    const list2 = next(A, 'channels-list', (chs) => Array.isArray(chs) && chs.some((c) => c.name === 'news' && c.read_only === 1));
    A.emit('create-channel', { name: 'news', addAllMembers: true, readOnly: true, announcement: true, topic: 'Read me first', slowMode: 15 });
    const chs = await list2;
    assert.ok(chs, 'the news channel came back read-only');
    const news = chs.find((c) => c.name === 'news');
    assert.strictEqual(news.notification_type, 'announcement');
    assert.strictEqual(news.topic, 'Read me first');
    assert.strictEqual(news.slow_mode_interval, 15);

    // Saved templates are a server setting behind manage_server.
    A.emit('update-server-setting', { key: 'channel_templates', value: JSON.stringify([{ name: 'Newsroom', fields: { readOnly: true, announcement: true } }]) });
    await wait(300);
    const s = await new Promise((res) => { B.once('server-settings', (x) => res(x)); B.emit('get-server-settings'); });
    assert.deepStrictEqual(JSON.parse(s.channel_templates)[0].name, 'Newsroom');
  });

  A.close(); B.close(); C.close();
});
