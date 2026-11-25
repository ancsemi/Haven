'use strict';

/**
 * Sub-servers: a server splits its channels into sub-servers, and a sub-server
 * can need roles. Its roles are written onto every channel in it, so members
 * without them see neither the sub-server nor its channels, and holding the
 * role opens both. Only Manage Server changes sub-servers.
 *
 *   node --test test/subservers.integration.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createHarness, wait } = require('./socketServerHarness');
const { parseSubserver } = require('../src/subservers');

const h = createHarness(3581, 'subservers');
test.before(() => h.start());
test.after(() => h.stop());

test('parseSubserver checks the name and emoji', () => {
  assert.match(parseSubserver({ name: '  ' }).error, /name/);
  assert.match(parseSubserver({ name: 'x'.repeat(41) }).error, /40/);
  assert.match(parseSubserver({ name: 'Art', icon: '<b>' }).error, /one emoji/);
  assert.match(parseSubserver({ name: 'Art', icon: 'x'.repeat(17) }).error, /one emoji/);
  assert.deepStrictEqual(parseSubserver({ name: ' Art ', icon: ' 🎨 ' }).subserver, { name: 'Art', icon: '🎨' });
  assert.deepStrictEqual(parseSubserver({ icon: '🔞' }, { name: 'Late', icon: '' }).subserver, { name: 'Late', icon: '🔞' });
});

test('sub-servers: grouping channels, required roles, and who may change them', async (t) => {
  const admin = await h.register('admin');
  const ana = await h.register('ana');
  const ben = await h.register('ben');
  const A = await h.connect(admin.token);
  const N = await h.connect(ana.token);
  const B = await h.connect(ben.token);
  const db = new Database(path.join(h.dataDir, 'haven.db'));
  db.pragma('busy_timeout = 5000');
  t.after(() => db.close());

  const row = (name) => db.prepare('SELECT * FROM channels WHERE name = ?').get(name);
  const make = async (name, extra) => {
    A.emit('create-channel', { name, addAllMembers: true, ...extra });
    let r;
    for (let i = 0; i < 30 && !r; i++) { await wait(100); r = row(name); }
    assert.ok(r, `channel ${name} made`);
    await wait(150);
    return r;
  };
  const names = async (sock) => (await h.channels(sock)).map(c => c.name);
  const list = (sock) => h.ask(sock, 'subserver-list', {});
  const gateOf = (name) => JSON.parse(row(name).role_gate || 'null');

  const adult = (await h.ask(A, 'create-role', { name: 'Adult', level: 5, color: '#aa3377', permissions: [] })).roleId;
  const helper = (await h.ask(A, 'create-role', { name: 'Helper', level: 10, color: '#3377aa', permissions: ['manage_server'] })).roleId;
  assert.ok(adult && helper, 'roles made');

  // Only Manage Server changes sub-servers; every member can list them.
  assert.match((await h.ask(B, 'subserver-create', { name: 'Mine' })).error, /Manage Server/);
  assert.deepStrictEqual(await list(B), { ok: true, canManage: false, subservers: [] });
  assert.match((await h.ask(A, 'subserver-create', { name: ' ' })).error, /name/);

  const told = h.next(B, 'subservers-changed');
  const art = (await h.ask(A, 'subserver-create', { name: 'Art', icon: '🎨' })).subserver;
  assert.notStrictEqual(await told, null, 'members hear about a new sub-server');
  const dark = (await h.ask(A, 'subserver-create', { name: 'After Dark', icon: '🔞' })).subserver;
  assert.deepStrictEqual([art.position, dark.position], [0, 1]);
  assert.deepStrictEqual((await list(B)).subservers.map(s => [s.name, s.icon, s.gated, 'roleGate' in s]), [['Art', '🎨', false, false], ['After Dark', '🔞', false, false]]);

  const lounge = await make('lounge');
  const gallery = await make('gallery');
  const late = await make('late-night');

  // A channel moves into a sub-server; the channel list says which.
  assert.deepStrictEqual(await h.ask(A, 'channel-set-subserver', { code: gallery.code, subserverId: art.id }), { ok: true });
  const seen = await h.channels(B);
  assert.strictEqual(seen.find(c => c.name === 'gallery').subserver_id, art.id);
  assert.strictEqual(seen.find(c => c.name === 'lounge').subserver_id, null);
  assert.match((await h.ask(A, 'channel-set-subserver', { code: gallery.code, subserverId: 9999 })).error, /not found/);

  // Required roles: unknown roles are dropped, and members without the role
  // lose sight of the sub-server and every channel in it.
  assert.deepStrictEqual(await h.ask(A, 'channel-set-subserver', { code: late.code, subserverId: dark.id }), { ok: true });
  const gated = await h.ask(A, 'subserver-update', { id: dark.id, mode: 'any', roles: [adult, 99999] });
  assert.deepStrictEqual(gated.subserver.roleGate, { mode: 'any', roles: [adult] });
  assert.deepStrictEqual(gateOf('late-night'), { mode: 'any', roles: [adult] }, 'the channel takes the sub-server roles');
  assert.deepStrictEqual((await list(B)).subservers.map(s => s.name), ['Art']);
  assert.deepStrictEqual((await list(A)).subservers.map(s => [s.name, s.gated]), [['Art', false], ['After Dark', true]]);
  assert.ok(!(await names(B)).includes('late-night'), 'ben no longer sees the gated channel');
  assert.match((await h.ask(A, 'set-channel-role-gate', { code: late.code, mode: 'any', roles: [] })).error, /After Dark sub-server/);

  // New channels and sub-channels take the roles too.
  const after = await make('after-art', { subserverId: dark.id });
  assert.strictEqual(after.subserver_id, dark.id);
  assert.deepStrictEqual(gateOf('after-art'), { mode: 'any', roles: [adult] });
  A.emit('create-sub-channel', { parentCode: late.code, name: 'late-sub' });
  for (let i = 0; i < 30 && !row('late-sub'); i++) await wait(100);
  assert.strictEqual(row('late-sub').subserver_id, dark.id);
  assert.deepStrictEqual(gateOf('late-sub'), { mode: 'any', roles: [adult] });
  assert.match((await h.ask(A, 'channel-set-subserver', { code: row('late-sub').code, subserverId: art.id })).error, /parent/);

  // Holding the role opens the sub-server and its channels; losing it closes
  // them. Ben's client is told to ask for the sub-servers again.
  const ping = h.next(B, 'subservers-changed');
  assert.ok((await h.ask(A, 'assign-role', { userId: ben.id, roleId: adult })).success);
  assert.notStrictEqual(await ping, null, 'a role change tells the member');
  await wait(300);
  assert.deepStrictEqual((await list(B)).subservers.map(s => s.name), ['Art', 'After Dark']);
  assert.ok((await names(B)).includes('late-night'), 'ben sees the channel with the role');
  assert.ok((await h.ask(A, 'revoke-role', { userId: ben.id, roleId: adult })).success);
  await wait(300);
  assert.ok(!(await names(B)).includes('late-night'));

  // A manager who is not the admin: may manage what they can see, not a
  // sub-server whose roles they lack, and not roles on a private channel.
  assert.ok((await h.ask(A, 'assign-role', { userId: ana.id, roleId: helper })).success);
  await wait(200);
  const anaList = await list(N);
  assert.strictEqual(anaList.canManage, true);
  assert.deepStrictEqual(anaList.subservers.map(s => s.name), ['Art']);
  assert.match((await h.ask(N, 'subserver-update', { id: dark.id, name: 'Mine now' })).error, /not found/);
  assert.match((await h.ask(N, 'subserver-delete', { id: dark.id })).error, /not found/);
  assert.match((await h.ask(N, 'channel-set-subserver', { code: lounge.code, subserverId: dark.id })).error, /not found/);
  const secret = await make('secret', { isPrivate: true });
  db.prepare('INSERT OR IGNORE INTO channel_members (channel_id, user_id) VALUES (?, ?)').run(secret.id, ana.id);
  assert.ok((await h.ask(N, 'subserver-update', { id: art.id, mode: 'any', roles: [helper] })).ok, 'ana gates Art');
  assert.match((await h.ask(N, 'channel-set-subserver', { code: secret.code, subserverId: art.id })).error, /Only the admin/);
  assert.deepStrictEqual(gateOf('gallery'), { mode: 'any', roles: [helper] });
  assert.ok((await h.ask(N, 'subserver-update', { id: art.id, roles: [] })).ok, 'ana clears the roles');
  assert.strictEqual(row('gallery').role_gate, null, 'clearing the sub-server roles clears its channels');
  assert.ok((await names(B)).includes('gallery'));

  // Moving out keeps the roles, so nothing opens up by surprise.
  assert.deepStrictEqual(await h.ask(A, 'channel-set-subserver', { code: after.code, subserverId: null }), { ok: true });
  assert.strictEqual(row('after-art').subserver_id, null);
  assert.deepStrictEqual(gateOf('after-art'), { mode: 'any', roles: [adult] });
  assert.deepStrictEqual(await h.ask(A, 'set-channel-role-gate', { code: after.code, mode: 'any', roles: [] }), { success: true, roleGate: null }, 'outside a sub-server the channel sets its own');

  // Order, then a deleted role stops being required.
  assert.match((await h.ask(A, 'subserver-reorder', { ids: [dark.id] })).error, /Invalid order/);
  assert.deepStrictEqual(await h.ask(A, 'subserver-reorder', { ids: [dark.id, art.id] }), { ok: true });
  assert.deepStrictEqual((await list(A)).subservers.map(s => s.name), ['After Dark', 'Art']);
  const dropped = h.next(A, 'subservers-changed');
  assert.ok((await h.ask(A, 'delete-role', { roleId: adult })).success);
  assert.notStrictEqual(await dropped, null);
  assert.strictEqual((await list(A)).subservers.find(s => s.id === dark.id).gated, false);
  assert.deepStrictEqual((await list(B)).subservers.map(s => s.name), ['After Dark', 'Art']);

  // Deleting a sub-server sends its channels to the main server with their roles.
  assert.ok((await h.ask(A, 'subserver-update', { id: dark.id, mode: 'all', roles: [helper] })).ok);
  assert.deepStrictEqual(await h.ask(A, 'subserver-delete', { id: dark.id }), { ok: true });
  assert.strictEqual(row('late-night').subserver_id, null);
  assert.strictEqual(row('late-sub').subserver_id, null);
  assert.deepStrictEqual(gateOf('late-night'), { mode: 'all', roles: [helper] });
  assert.deepStrictEqual((await list(A)).subservers.map(s => s.name), ['Art']);
});
