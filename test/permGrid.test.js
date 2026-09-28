// Permissions grid (Settings → Permissions): the seeded defaults, the Users
// tab chips going through assign-role / revoke-role, and set-user-server-perms
// leaving alone anything the grid did not show or the editor may not touch.
//
// Boots a real server on a scratch data dir and drives it over socket.io.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { io } = require('socket.io-client');

const PORT = 3394;
const BASE = `http://localhost:${PORT}`;
const DATA = path.join(os.tmpdir(), `haven-permgrid-${Date.now()}`);

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

const ask = (sock, event, payload) => new Promise((res) => sock.emit(event, payload, res));

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

test('permissions grid: defaults, chips, and per-user ticks', async (t) => {
  const admin = await post('/api/auth/register', { username: 'admin', password: 'permgrid123', eulaVersion: '2.0', ageVerified: true });
  const bob = await post('/api/auth/register', { username: 'bob', password: 'permgrid123', eulaVersion: '2.0', ageVerified: true });
  const cara = await post('/api/auth/register', { username: 'cara', password: 'permgrid123', eulaVersion: '2.0', ageVerified: true });
  assert.ok(admin.token && bob.token && cara.token, 'three accounts registered');

  const A = await connect(admin.token);
  const C = await connect(cara.token);
  await wait(300);

  const { roles: seeded } = await ask(A, 'get-roles', {});
  const byName = Object.fromEntries(seeded.map((r) => [r.name, r]));

  await t.test('a new server seeds Member (auto-assign), Mod and Channel Mod', () => {
    assert.ok(byName.Member && byName.Mod && byName['Channel Mod'], `seeded: ${seeded.map((r) => r.name).join(', ')}`);
    assert.strictEqual(byName.Member.auto_assign, 1);
    assert.strictEqual(byName['Channel Mod'].scope, 'channel');
    assert.ok(byName.Mod.permissions.includes('manage_tags'), 'Mod can manage tags like the Server Mod on main');
  });

  await t.test('get-perm-panel lists server roles with perms and every user with role ids', async () => {
    const panel = await ask(A, 'get-perm-panel', {});
    assert.ok(Array.isArray(panel.roles) && Array.isArray(panel.users), 'panel has roles and users');
    assert.ok(panel.roles.every((r) => r.scope === 'server' && r.level > 0), 'only server roles above level 0');
    const bobRow = panel.users.find((u) => u.id === bob.user.id);
    assert.ok(bobRow && bobRow.roleIds.includes(byName.Member.id), 'bob holds the auto-assigned Member role');
    const denied = await ask(C, 'get-perm-panel', {});
    assert.ok(denied.error, 'someone without manage_roles cannot open the panel');
  });

  const helper = await ask(A, 'create-role', { name: 'Helper', level: 10, color: '#00ff00', permissions: ['upload_files'] });
  assert.ok(helper.roleId, 'helper role created');

  await t.test('chips add and remove one role, other roles stay', async () => {
    assert.ok((await ask(A, 'assign-role', { userId: bob.user.id, roleId: helper.roleId })).success);
    let panel = await ask(A, 'get-perm-panel', {});
    let ids = panel.users.find((u) => u.id === bob.user.id).roleIds;
    assert.ok(ids.includes(byName.Member.id) && ids.includes(helper.roleId), 'bob now holds Member and Helper');

    assert.ok((await ask(A, 'revoke-role', { userId: bob.user.id, roleId: helper.roleId })).success);
    panel = await ask(A, 'get-perm-panel', {});
    ids = panel.users.find((u) => u.id === bob.user.id).roleIds;
    assert.ok(ids.includes(byName.Member.id) && !ids.includes(helper.roleId), 'Helper is gone, Member stays');
  });

  await t.test('the old replace-every-role event is gone', async () => {
    const res = await Promise.race([
      ask(A, 'set-user-server-role', { userId: bob.user.id, roleId: helper.roleId }),
      wait(1500).then(() => 'no-handler'),
    ]);
    assert.strictEqual(res, 'no-handler');
  });

  await t.test('a tick only touches the permissions the grid showed', async () => {
    // Give bob something the grid does not show.
    let res = await ask(A, 'set-user-server-perms', { userId: bob.user.id, permissions: ['transfer_admin'], known: ['transfer_admin'] });
    assert.ok(res.success && res.permissions.includes('transfer_admin'), 'admin granted transfer_admin as an override');

    // Now tick use_tts off with a grid that never mentioned transfer_admin.
    res = await ask(A, 'set-user-server-perms', { userId: bob.user.id, permissions: [], known: ['use_tts'] });
    assert.ok(res.success, 'save ok');
    assert.ok(!res.permissions.includes('use_tts'), 'use_tts is off');
    assert.ok(res.permissions.includes('transfer_admin'), 'transfer_admin survived a save that did not list it');
    assert.ok(res.permissions.includes('view_history'), 'a Member perm the grid did not list is untouched');

    // Ticking it back on works too.
    res = await ask(A, 'set-user-server-perms', { userId: bob.user.id, permissions: ['use_tts'], known: ['use_tts'] });
    assert.ok(res.permissions.includes('use_tts') && res.permissions.includes('transfer_admin'));

    const log = await ask(A, 'get-audit-log', { action: 'user_perms_update' });
    assert.ok(log.rows && log.rows.length >= 3, 'each save wrote an audit entry');
    const last = JSON.parse(log.rows[0].details);
    assert.deepStrictEqual(last.granted, ['use_tts']);
    assert.strictEqual(log.rows[0].target_id, bob.user.id);
  });

  await t.test('a non-admin editor cannot strip what they do not hold, nor edit above their level', async () => {
    // cara: level 40, manage_roles but no ban_user.
    const editor = await ask(A, 'create-role', { name: 'Editor', level: 40, color: '#0000ff', permissions: ['manage_roles', 'promote_user', 'view_history'] });
    assert.ok((await ask(A, 'assign-role', { userId: cara.user.id, roleId: editor.roleId })).success);
    // bob: ban_user as an admin-granted override on Member.
    let res = await ask(A, 'set-user-server-perms', { userId: bob.user.id, permissions: ['ban_user'], known: ['ban_user'] });
    assert.ok(res.permissions.includes('ban_user'));
    await wait(200);

    res = await ask(C, 'set-user-server-perms', { userId: bob.user.id, permissions: [], known: ['ban_user', 'view_history', 'use_tts'] });
    assert.ok(res.success, `cara can save: ${res.error || ''}`);
    assert.ok(res.permissions.includes('ban_user'), 'ban_user stays: cara does not hold it');
    assert.ok(res.permissions.includes('transfer_admin'), 'admin-only override stays');
    assert.ok(!res.permissions.includes('view_history'), 'view_history, which cara holds, is off');

    res = await ask(C, 'set-user-server-perms', { userId: bob.user.id, permissions: ['transfer_admin', 'ban_user', 'view_history'], known: ['transfer_admin', 'ban_user', 'view_history'] });
    assert.ok(res.permissions.includes('view_history'), 'view_history back on');

    // bob outranks cara now: she cannot touch him.
    const boss = await ask(A, 'create-role', { name: 'Boss', level: 60, color: '#ff00ff', permissions: [] });
    assert.ok((await ask(A, 'assign-role', { userId: bob.user.id, roleId: boss.roleId })).success);
    await wait(200);
    res = await ask(C, 'set-user-server-perms', { userId: bob.user.id, permissions: [], known: ['view_history'] });
    assert.ok(res.error && /level/i.test(res.error), `refused above her level: ${res.error}`);
    res = await ask(C, 'assign-role', { userId: bob.user.id, roleId: boss.roleId });
    assert.ok(res.error, 'a chip for a role at or above her level is refused');
  });

  await t.test('Reset to Default seeds the same three roles', async () => {
    const res = await ask(A, 'reset-roles-to-default', {});
    assert.ok(res.success || !res.error, `reset ok: ${res.error || ''}`);
    const { roles } = await ask(A, 'get-roles', {});
    assert.deepStrictEqual(roles.map((r) => r.name).sort(), ['Channel Mod', 'Member', 'Mod']);
  });

  A.close(); C.close();
});
