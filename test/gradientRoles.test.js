'use strict';

/**
 * Gradient role colors: a role can draw names as a gradient from its color
 * to a second color, optionally shimmering. Covers saving the new fields,
 * rejecting bad colors, carrying them to every place a role color reaches a
 * client, and the client helpers that paint names with them.
 *
 * Boots a server on a scratch port and data dir:
 *   node --test test/gradientRoles.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const { io } = require('socket.io-client');

const ROOT = path.join(__dirname, '..');
const PORT = 3417;
const BASE = `http://localhost:${PORT}`;
const DATA = path.join(os.tmpdir(), `haven-gradient-roles-${Date.now()}`);

let server;

const post = (p, body) => new Promise((res, rej) => {
  const d = JSON.stringify(body);
  const r = http.request({ host: 'localhost', port: PORT, path: p, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) } },
    (x) => { let b = ''; x.on('data', (c) => (b += c)); x.on('end', () => { try { res(JSON.parse(b)); } catch { res({ raw: b }); } }); });
  r.on('error', rej); r.write(d); r.end();
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const register = (username) => post('/api/auth/register', { username, password: 'gradient-pass-321', eulaVersion: '2.0', ageVerified: true });
const ask = (sock, event, payload) => new Promise((res) => sock.emit(event, payload, res));

// The same fill-in the web client does for slimmed member entries (app-socket.js).
const fillMember = (u) => ({
  highScore: 0, statusText: '', avatar: null, avatarShape: 'circle', border: null,
  borderTransform: null, animateProfile: 'trigger', isGuest: false, role: null, activity: null,
  ...u,
});

function client(token, deltas) {
  const s = io(BASE, { auth: deltas ? { token, presenceDeltas: 1 } : { token }, transports: ['websocket'], forceNew: true });
  s.lists = new Map();
  s.on('online-users', (d) => s.lists.set(d.channelCode, d.slim ? d.users.map(fillMember) : d.users));
  s.on('online-users-delta', (d) => {
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

const roleById = async (sock, id) => (await ask(sock, 'get-roles', {})).roles.find(r => r.id === id);
const member = (sock, code, username) => (sock.lists.get(code) || []).find(u => u.username === username);

test.before(async () => {
  fs.mkdirSync(DATA, { recursive: true });
  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
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

test('gradient roles: saved, validated and carried to clients', async (t) => {
  const admin = await register('admin');
  const bob = await register('bob');
  const dave = await register('dave');
  assert.ok(admin.token && bob.token && dave.token, 'all registered');

  const A = await client(admin.token, true);
  const made = next(A, 'channels-list', (chs) => Array.isArray(chs) && chs.some((c) => c.name === 'lounge'));
  A.emit('create-channel', { name: 'lounge' });
  const code = (await made).find((c) => c.name === 'lounge').code;
  A.emit('enter-channel', { code });
  const B = await client(bob.token, true);
  const L = await client(dave.token, false);   // an older app, full lists only
  for (const s of [B, L]) { s.emit('join-channel', { code }); await wait(100); s.emit('enter-channel', { code }); }
  await wait(800);

  const rare = await ask(A, 'create-role', { name: 'Rare', level: 5, color: '#ff0000', color2: '#0000ff', shimmer: true });
  assert.ok(rare.roleId, 'gradient role created');

  await t.test('create stores the end color and shimmer', async () => {
    const r = await roleById(A, rare.roleId);
    assert.strictEqual(r.color, '#ff0000');
    assert.strictEqual(r.color2, '#0000ff');
    assert.strictEqual(r.color_shimmer, 1);
  });

  await t.test('a role without an end color is a plain color, as before', async () => {
    const plain = await ask(A, 'create-role', { name: 'Plain', level: 3, color: '#00aa00', shimmer: true });
    const r = await roleById(A, plain.roleId);
    assert.strictEqual(r.color2, null);
    assert.strictEqual(r.color_shimmer, 0, 'shimmer means nothing without a gradient');
  });

  await t.test('bad end colors are refused like bad colors', async () => {
    for (const bad of ['red', 'url(x)', '#12345g', '#1234567', 'javascript:alert(1)', 42, { a: 1 }]) {
      const res = await ask(A, 'create-role', { name: 'Bad', level: 2, color: '#123456', color2: bad, shimmer: true });
      const r = await roleById(A, res.roleId);
      assert.strictEqual(r.color2, null, `color2 ${JSON.stringify(bad)} stored as no color`);
      assert.strictEqual(r.color_shimmer, 0);
      await ask(A, 'delete-role', { roleId: res.roleId });
    }
  });

  await t.test('update changes, keeps and clears the gradient', async () => {
    const tmp = await ask(A, 'create-role', { name: 'Tmp', level: 4, color: '#111111', color2: '#222222' });
    let res = await ask(A, 'update-role', { roleId: tmp.roleId, color2: '#abc', shimmer: true });
    assert.ok(res.success);
    let r = await roleById(A, tmp.roleId);
    assert.strictEqual(r.color2, '#abc');
    assert.strictEqual(r.color_shimmer, 1);

    await ask(A, 'update-role', { roleId: tmp.roleId, name: 'Tmp2' });
    r = await roleById(A, tmp.roleId);
    assert.strictEqual(r.color2, '#abc', 'an edit that does not send color2 leaves the gradient alone');
    assert.strictEqual(r.color_shimmer, 1);

    await ask(A, 'update-role', { roleId: tmp.roleId, shimmer: false });
    assert.strictEqual((await roleById(A, tmp.roleId)).color_shimmer, 0);

    await ask(A, 'update-role', { roleId: tmp.roleId, color2: 'not-a-color', shimmer: true });
    r = await roleById(A, tmp.roleId);
    assert.strictEqual(r.color2, null, 'a bad end color clears the gradient');
    assert.strictEqual(r.color_shimmer, 0, 'and its shimmer');

    await ask(A, 'update-role', { roleId: tmp.roleId, color2: null });
    assert.strictEqual((await roleById(A, tmp.roleId)).color2, null);
    await ask(A, 'delete-role', { roleId: tmp.roleId });
  });

  await t.test('duplicate carries the gradient', async () => {
    // Duplicate in the role editor re-creates the role from its row; this is
    // the payload it sends (app-roles.js).
    const src = fs.readFileSync(path.join(ROOT, 'public/js/modules/app-roles.js'), 'utf8');
    const dup = src.slice(src.indexOf("getElementById('duplicate-role-btn')?.addEventListener"));
    assert.match(dup.slice(0, 1500), /color2: role\.color2 \|\| null,\s*shimmer: !!role\.color_shimmer,/);

    const orig = await roleById(A, rare.roleId);
    const copy = await ask(A, 'create-role', {
      name: 'Rare (copy)', level: orig.level, color: orig.color, color2: orig.color2 || null,
      shimmer: !!orig.color_shimmer, transparent: !!orig.transparent, permissions: orig.permissions,
    });
    const r = await roleById(A, copy.roleId);
    assert.strictEqual(r.color2, '#0000ff');
    assert.strictEqual(r.color_shimmer, 1);
    await ask(A, 'delete-role', { roleId: copy.roleId });
  });

  await ask(A, 'assign-role', { userId: bob.user.id, roleId: rare.roleId });
  await wait(1500);

  await t.test('member list entries carry the gradient, slim or whole', async () => {
    for (const [who, sock] of [['deltas client', A], ['older client', L]]) {
      const entry = member(sock, code, 'bob');
      assert.ok(entry && entry.role, `${who} sees bob with a role`);
      assert.strictEqual(entry.role.color, '#ff0000');
      assert.strictEqual(entry.role.color2, '#0000ff', `${who} gets the end color`);
      assert.strictEqual(entry.role.color_shimmer, 1, `${who} gets the shimmer`);
    }
    const adminEntry = member(A, code, 'admin');
    assert.ok(adminEntry && adminEntry.role, 'the admin has their Admin role');
    assert.ok(!('color2' in adminEntry.role), 'a plain role sends no gradient fields');
    assert.deepStrictEqual(member(A, code, 'bob'), member(L, code, 'bob'), 'same entry either way');
  });

  await t.test('a transparent role on top leaves the gradient role styling the name', async () => {
    const ghost = await ask(A, 'create-role', { name: 'Ghost', level: 40, color: '#999999', transparent: true });
    await ask(A, 'assign-role', { userId: bob.user.id, roleId: ghost.roleId });
    await wait(1500);
    const entry = member(A, code, 'bob');
    assert.strictEqual(entry.role.name, 'Rare');
    assert.strictEqual(entry.role.color2, '#0000ff');
  });

  await t.test('a message author is styled by their member entry, which has the gradient', async () => {
    const got = next(A, 'new-message', (d) => d && d.channelCode === code && d.message && d.message.content === 'shiny');
    B.emit('send-message', { code, content: 'shiny' });
    const msg = await got;
    assert.ok(msg, 'message arrived');
    const author = member(A, code, 'bob');
    assert.strictEqual(author.id, msg.message.user_id);
    assert.strictEqual(author.role.color2, '#0000ff');
    // The chat renders that author through the shared helper.
    const src = fs.readFileSync(path.join(ROOT, 'public/js/modules/app-messages.js'), 'utf8');
    assert.match(src, /this\._roleNameHtml\(onlineUser\.role, authorText\)/);
    assert.match(src, /<span class="message-author" style="color:\$\{authorColor\}"[^\n]*>\$\{authorHtml\}<\/span>/);
  });

  await t.test('profile cards, role lookups and voice rosters carry it', async () => {
    const profile = next(A, 'user-profile', (p) => p && p.id === bob.user.id);
    A.emit('get-user-profile', { userId: bob.user.id });
    const p = await profile;
    const shown = p.roles.find(r => r.name === 'Rare');
    assert.strictEqual(shown.color2, '#0000ff');
    assert.strictEqual(shown.color_shimmer, 1);

    const roles = next(A, 'user-roles', (d) => d && d.userId === bob.user.id);
    A.emit('get-user-roles', { userId: bob.user.id });
    const ur = await roles;
    assert.strictEqual(ur.highestRole.name, 'Rare');
    assert.strictEqual(ur.highestRole.color2, '#0000ff');
    assert.strictEqual(ur.roles.find(r => r.name === 'Rare').color2, '#0000ff');

    const voice = next(A, 'voice-users-update', (d) => d && d.channelCode === code && d.users.some(u => u.id === bob.user.id));
    B.emit('voice-join', { code });
    const v = await voice;
    assert.ok(v, 'bob joined voice');
    const vb = v.users.find(u => u.id === bob.user.id);
    assert.strictEqual(vb.roleColor, '#ff0000', 'the old field is unchanged');
    assert.strictEqual(vb.roleColor2, '#0000ff');
    assert.strictEqual(vb.roleShimmer, true);
    B.emit('voice-leave', { code });
  });

  await t.test('Reset to Default leaves stock roles without gradients', async () => {
    const res = await ask(A, 'reset-roles-to-default', {});
    assert.ok(res.success);
    const { roles } = await ask(A, 'get-roles', {});
    assert.ok(roles.length > 0);
    for (const r of roles) {
      assert.strictEqual(r.color2, null, `${r.name} has no end color`);
      assert.strictEqual(r.color_shimmer, 0);
    }
  });

  for (const s of [A, B, L]) s.close();
});

// ── client helpers ────────────────────────────────────────────────────────
function loadApp() {
  const source = fs.readFileSync(path.join(ROOT, 'public/js/modules/app-utilities.js'), 'utf8');
  const store = new Map();
  const context = vm.createContext({
    module: { exports: {} }, exports: {},
    document: {
      documentElement: { lang: 'en-US' }, querySelectorAll: () => [],
      createElement: () => {
        let text = '';
        return {
          set textContent(v) { text = String(v); },
          get innerHTML() { return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); },
        };
      },
    },
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) },
    navigator: { languages: ['en-US'] },
    setInterval: () => 0, clearInterval: () => {},
    Intl, Date, Number, Math, JSON, String, Array, Object, RegExp, Error, Map, Set,
    t: (key) => key, console,
  });
  vm.runInContext(source.replace(/^export default/m, 'module.exports ='), context, { filename: 'app-utilities.js' });
  const app = Object.create(context.module.exports);
  app._escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  app._store = store;
  return app;
}

test('a plain role leaves the name text alone', () => {
  const app = loadApp();
  assert.strictEqual(app._roleNameHtml({ color: '#ff0000' }, 'Bob <3'), 'Bob &lt;3');
  assert.strictEqual(app._roleNameHtml(null, 'Bob'), 'Bob');
  assert.strictEqual(app._roleFill({ color: '#ff0000' }, '#aaa'), '#ff0000');
  assert.strictEqual(app._roleFill(null, '#aaa'), '#aaa');
});

test('a gradient role wraps the name in a gradient span, shimmering when asked', () => {
  const app = loadApp();
  const still = app._roleNameHtml({ color: '#ff0000', color2: '#0000ff', color_shimmer: 0 }, 'Bob');
  assert.strictEqual(still, '<span class="role-gradient" style="--role-c1:#ff0000;--role-c2:#0000ff">Bob</span>');
  const moving = app._roleNameHtml({ color: '#ff0000', color2: '#0000ff', color_shimmer: 1 }, 'Bob');
  assert.match(moving, /class="role-gradient role-shimmer"/);
  assert.strictEqual(app._roleFill({ color: '#ff0000', color2: '#0000ff' }), 'linear-gradient(90deg, #ff0000, #0000ff)');
  // The flat voice shape works the same way.
  assert.match(app._roleNameHtml({ roleColor: '#ff0000', roleColor2: '#0000ff', roleShimmer: true }, 'Bob'), /role-shimmer/);
});

test('unsafe colors never reach the page', () => {
  const app = loadApp();
  assert.strictEqual(app._roleNameHtml({ color: '#ff0000', color2: 'red;background:url(x)' }, 'Bob'), 'Bob');
  assert.strictEqual(app._roleNameHtml({ color: 'expression(x)', color2: '#0000ff' }, 'Bob'), 'Bob', 'no start color, no gradient');
  assert.strictEqual(app._roleLook({ color: '#ff0000', color2: null, color_shimmer: 1 }).shimmer, false);
});

test('chat names follow the role display setting', () => {
  const app = loadApp();
  const role = { color: '#ff0000', color2: '#0000ff' };
  app._lastOnlineUsers = [{ id: 5, username: 'bob', role }];
  assert.strictEqual(app._chatNameRole(5), role);
  assert.strictEqual(app._chatNameRole(6), null, 'unknown user');
  app._store.set('haven-role-display', 'dot');
  assert.strictEqual(app._chatNameRole(5), null, 'names are not role colored in dot mode');
});

test('shimmer is CSS only and stops for reduced motion', () => {
  const css = require('./coreCss').readCoreCss();
  assert.match(css, /\.role-gradient\.role-shimmer \{[^}]*animation: role-shimmer/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.role-gradient\.role-shimmer \{ animation: none; \}/);
});
