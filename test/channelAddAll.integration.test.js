'use strict';

/**
 * "Add all members" on a channel that already exists: everyone on the server
 * becomes a member, for whoever may tick the switch when making a channel.
 * Private channels and banned people are left alone.
 *
 *   node --test test/channelAddAll.integration.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createHarness } = require('./socketServerHarness');

const h = createHarness(3591, 'channel-add-all');
test.before(() => h.start());
test.after(() => h.stop());

test('add everyone to an existing channel', async (t) => {
  const admin = await h.register('admin');
  const helper = await h.register('helper');
  const member = await h.register('member');
  const banned = await h.register('banned');
  const A = await h.connect(admin.token);
  const db = new Database(path.join(h.dataDir, 'haven.db'));
  db.pragma('busy_timeout = 5000');
  t.after(() => db.close());

  const insert = db.prepare('INSERT INTO channels (name, code, created_by, is_private) VALUES (?, ?, ?, ?)');
  const open = insert.run('roles', 'abcd1234', admin.id, 0).lastInsertRowid;
  insert.run('secret', 'abcd5678', admin.id, 1);
  const join = db.prepare('INSERT INTO channel_members (channel_id, user_id) VALUES (?, ?)');
  join.run(open, admin.id);
  join.run(open, helper.id);
  db.prepare('INSERT INTO bans (user_id, banned_by) VALUES (?, ?)').run(banned.id, admin.id);
  const members = (id) => db.prepare('SELECT user_id FROM channel_members WHERE channel_id = ?').all(id).map(r => r.user_id);

  // Someone without Invite Users or Manage Server cannot.
  const H = await h.connect(helper.token);
  const refused = await h.ask(H, 'add-all-members', { code: 'abcd1234' });
  assert.ok(refused.error, JSON.stringify(refused));
  assert.ok(!members(open).includes(member.id));

  const res = await h.ask(A, 'add-all-members', { code: 'abcd1234' });
  assert.ok(res.success, JSON.stringify(res));
  const now = members(open);
  assert.ok(now.includes(member.id), 'the member is in now');
  assert.ok(!now.includes(banned.id), 'banned people are left out');
  assert.strictEqual(res.added, now.length - 2, 'counts only the people it added');

  assert.strictEqual((await h.ask(A, 'add-all-members', { code: 'abcd1234' })).added, 0, 'nobody twice');
  const priv = await h.ask(A, 'add-all-members', { code: 'abcd5678' });
  assert.match(priv.error || '', /private/i, 'a private channel stays invite-only');

  A.disconnect(); H.disconnect();
});

test('add picked people, on public and private channels', async (t) => {
  const admin = await h.register('padmin');
  const creator = await h.register('pcreator');
  const one = await h.register('pone');
  const two = await h.register('ptwo');
  const banned = await h.register('pbanned');
  const db = new Database(path.join(h.dataDir, 'haven.db'));
  db.pragma('busy_timeout = 5000');
  t.after(() => db.close());
  // The server's admin was registered by the first test; make this one an admin too.
  db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(admin.id);
  const A = await h.connect(admin.token);
  const C = await h.connect(creator.token);
  const O = await h.connect(one.token);

  const insert = db.prepare('INSERT INTO channels (name, code, created_by, is_private) VALUES (?, ?, ?, ?)');
  const open = insert.run('lounge', 'bcde1234', admin.id, 0).lastInsertRowid;
  const priv = insert.run('club', 'bcde5678', creator.id, 1).lastInsertRowid;
  const join = db.prepare('INSERT INTO channel_members (channel_id, user_id) VALUES (?, ?)');
  join.run(open, admin.id); join.run(open, one.id); join.run(priv, creator.id);
  db.prepare('INSERT INTO bans (user_id, banned_by) VALUES (?, ?)').run(banned.id, admin.id);
  const members = (id) => db.prepare('SELECT user_id FROM channel_members WHERE channel_id = ?').all(id).map(r => r.user_id);

  // The picker lists people, marks who is already in, and leaves banned people out.
  const list = await h.ask(A, 'get-channel-add-members', { code: 'bcde1234' });
  assert.ok(Array.isArray(list.users), JSON.stringify(list));
  assert.ok(list.users.find(u => u.id === one.id).inChannel);
  assert.ok(!list.users.some(u => u.id === banned.id));

  // A plain member cannot add people to a public channel.
  const refused = await h.ask(O, 'add-channel-members', { code: 'bcde1234', userIds: [two.id] });
  assert.ok(refused.error, JSON.stringify(refused));
  assert.ok(!members(open).includes(two.id));

  const res = await h.ask(A, 'add-channel-members', { code: 'bcde1234', userIds: [two.id, banned.id, one.id] });
  assert.strictEqual(res.added, 1, 'only the new, unbanned person counts');
  assert.ok(members(open).includes(two.id));
  assert.ok(!members(open).includes(banned.id));

  // A private channel's creator may pick people, as with an invite.
  const byCreator = await h.ask(C, 'add-channel-members', { code: 'bcde5678', userIds: [one.id] });
  assert.strictEqual(byCreator.added, 1, JSON.stringify(byCreator));
  // Someone else may not.
  const byOther = await h.ask(O, 'add-channel-members', { code: 'bcde5678', userIds: [two.id] });
  assert.ok(byOther.error, JSON.stringify(byOther));
  assert.ok(!members(priv).includes(two.id));

  A.disconnect(); C.disconnect(); O.disconnect();
});

test('add everyone stays out of hidden-code channels and private parents, and leaves guests', async (t) => {
  const inviter = await h.register('hinviter');
  const other = await h.register('hother');
  const guest = await h.register('hguest');
  const db = new Database(path.join(h.dataDir, 'haven.db'));
  db.pragma('busy_timeout = 5000');
  t.after(() => db.close());
  db.prepare('UPDATE users SET is_guest = 1 WHERE id = ?').run(guest.id);

  // Someone who may invite people, but is not the admin.
  const role = Number(db.prepare("INSERT INTO roles (name, level, scope, color) VALUES ('Inviter', 20, 'server', '#ccc')").run().lastInsertRowid);
  db.prepare("INSERT INTO role_permissions (role_id, permission, allowed) VALUES (?, 'invite_users', 1)").run(role);
  db.prepare('INSERT INTO user_roles (user_id, role_id, channel_id) VALUES (?, ?, NULL)').run(inviter.id, role);

  const insert = db.prepare('INSERT INTO channels (name, code, created_by, is_private, code_visibility, parent_channel_id) VALUES (?, ?, ?, ?, ?, ?)');
  const open = insert.run('town', 'cdef0001', other.id, 0, 'public', null).lastInsertRowid;
  const hidden = insert.run('hidden', 'cdef0002', other.id, 0, 'private', null).lastInsertRowid;
  const parent = insert.run('vault', 'cdef0003', other.id, 1, 'public', null).lastInsertRowid;
  const sub = insert.run('vault-sub', 'cdef0004', other.id, 0, 'public', parent).lastInsertRowid;
  const join = db.prepare('INSERT INTO channel_members (channel_id, user_id) VALUES (?, ?)');
  for (const id of [open, hidden, parent, sub]) join.run(id, inviter.id);
  const members = (id) => db.prepare('SELECT user_id FROM channel_members WHERE channel_id = ?').all(id).map(r => r.user_id);

  const I = await h.connect(inviter.token);
  for (const [code, id] of [['cdef0002', hidden], ['cdef0004', sub]]) {
    const res = await h.ask(I, 'add-all-members', { code });
    assert.ok(res.error, code + ' ' + JSON.stringify(res));
    assert.deepStrictEqual(members(id), [inviter.id], code + ' gained nobody');
  }

  const res = await h.ask(I, 'add-all-members', { code: 'cdef0001' });
  assert.ok(res.success, JSON.stringify(res));
  assert.ok(members(open).includes(other.id), 'members are added to a public channel');
  assert.ok(!members(open).includes(guest.id), 'a guest is not, unless the admin does it');

  I.disconnect();
});

test('manage members: add and remove together, remove all, and who may remove whom', async (t) => {
  const admin = await h.register('madmin');
  const creator = await h.register('mcreator');
  const mod = await h.register('mmod');
  const senior = await h.register('msenior');
  const one = await h.register('mone');
  const two = await h.register('mtwo');
  const guest = await h.register('mguest');
  const db = new Database(path.join(h.dataDir, 'haven.db'));
  db.pragma('busy_timeout = 5000');
  t.after(() => db.close());
  db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(admin.id);
  db.prepare('UPDATE users SET is_guest = 1 WHERE id = ?').run(guest.id);

  const role = (name, level, perm, shown = 1) => {
    const id = Number(db.prepare("INSERT INTO roles (name, level, scope, color, show_on_profile) VALUES (?, ?, 'server', '#ccc', ?)").run(name, level, shown).lastInsertRowid);
    if (perm) db.prepare('INSERT INTO role_permissions (role_id, permission, allowed) VALUES (?, ?, 1)').run(id, perm);
    return id;
  };
  const give = db.prepare('INSERT INTO user_roles (user_id, role_id, channel_id) VALUES (?, ?, NULL)');
  give.run(mod.id, role('MInviter', 30, 'invite_users'));
  give.run(senior.id, role('MSenior', 60, null));
  const secret = role('MSecret', 10, null, 0);
  give.run(one.id, secret);

  const insert = db.prepare('INSERT INTO channels (name, code, created_by, is_private) VALUES (?, ?, ?, ?)');
  const open = insert.run('plaza', 'def00001', admin.id, 0).lastInsertRowid;
  const priv = insert.run('den', 'def00002', creator.id, 1).lastInsertRowid;
  const join = db.prepare('INSERT INTO channel_members (channel_id, user_id) VALUES (?, ?)');
  for (const u of [admin, mod, senior, one, guest]) join.run(open, u.id);
  for (const u of [creator, one, senior]) join.run(priv, u.id);
  // Someone left with no channel at all is put back in the public ones by
  // the channel list, so everyone here keeps a second channel.
  const spare = insert.run('spare', 'def00003', admin.id, 0).lastInsertRowid;
  for (const u of [admin, creator, mod, senior, one, two]) join.run(spare, u.id);
  const members = (id) => db.prepare('SELECT user_id FROM channel_members WHERE channel_id = ? ORDER BY user_id').all(id).map(r => r.user_id);

  const A = await h.connect(admin.token);
  const M = await h.connect(mod.token);
  const C = await h.connect(creator.token);
  const O = await h.connect(one.token);

  // The list says who each person may take out, and hides a hidden role.
  const list = await h.ask(M, 'get-channel-add-members', { code: 'def00001' });
  const row = (id) => list.users.find(u => u.id === id);
  assert.ok(list.canAdd, JSON.stringify(list.error));
  assert.strictEqual(row(one.id).removable, true, 'a member ranked below');
  assert.strictEqual(row(senior.id).removable, false, 'someone ranked above');
  assert.strictEqual(row(admin.id).removable, false, 'the admin');
  assert.strictEqual(row(mod.id).removable, false, 'yourself');
  assert.strictEqual(row(two.id).removable, false, 'not a member');
  assert.ok(!list.users.some(u => u.id === guest.id), 'guests are the admin\'s to manage');
  assert.ok(!list.roles.some(r => r.name === 'MSecret') && !row(one.id).roles.includes(secret), 'a hidden role stays hidden');
  assert.ok((await h.ask(A, 'get-channel-add-members', { code: 'def00001' })).roles.some(r => r.name === 'MSecret'), 'the admin sees it');

  // Someone who may only remove (Kick, no Invite) sees the people in the
  // channel, not every account on the server.
  give.run(senior.id, role('MKicker', 20, 'kick_user'));
  const S = await h.connect(senior.token);
  const kickList = await h.ask(S, 'get-channel-add-members', { code: 'def00001' });
  assert.strictEqual(kickList.canAdd, false, JSON.stringify(kickList.error));
  assert.deepStrictEqual(kickList.users.map(u => u.id).sort((a, b) => a - b), [admin.id, mod.id, senior.id, one.id].sort((a, b) => a - b));
  assert.ok(!kickList.users.some(u => u.id === two.id || u.id === creator.id), 'nobody from outside the channel');

  // Add one and remove one in a single save; the ones out of reach stay.
  const res = await h.ask(M, 'update-channel-members', { code: 'def00001', add: [two.id], remove: [one.id, senior.id, admin.id, mod.id, guest.id] });
  assert.deepStrictEqual([res.added, res.removed], [1, 1], JSON.stringify(res));
  assert.deepStrictEqual(members(open), [admin.id, mod.id, senior.id, two.id, guest.id].sort((a, b) => a - b));

  // A plain member may do neither.
  const refused = await h.ask(O, 'update-channel-members', { code: 'def00001', remove: [two.id] });
  assert.ok(refused.error, JSON.stringify(refused));
  assert.ok(members(open).includes(two.id));

  // A private channel's creator removes anyone else in it, whatever their rank.
  const byCreator = await h.ask(C, 'update-channel-members', { code: 'def00002', remove: [one.id, senior.id, creator.id] });
  assert.strictEqual(byCreator.removed, 2, JSON.stringify(byCreator));
  assert.deepStrictEqual(members(priv), [creator.id]);

  // Remove all, by the admin: everyone but the admin goes.
  const everyone = members(open);
  const all = await h.ask(A, 'update-channel-members', { code: 'def00001', remove: everyone });
  assert.strictEqual(all.removed, everyone.length - 1, JSON.stringify(all));
  assert.deepStrictEqual(members(open), [admin.id]);

  assert.ok((await h.ask(A, 'update-channel-members', { code: 'def00001', add: [], remove: [] })).error, 'nothing to do');
  assert.ok((await h.ask(A, 'update-channel-members', { code: 'def00001', add: ['x'] })).error, 'ids only');

  A.disconnect(); M.disconnect(); C.disconnect(); O.disconnect();
});
