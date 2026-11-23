'use strict';

/**
 * "View Channel Members" hides the members everywhere (#5931). Someone
 * without it sees only themselves in the member sidebar and the @mention
 * list, and cannot open a new DM with a member; once they are given a role
 * that has it, the next update shows everyone.
 *
 *   node --test test/memberViewPermission.integration.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createHarness, wait } = require('./socketServerHarness');

const PORT = 3501;
const h = createHarness(PORT, 'member-view');

test.before(() => h.start());
test.after(() => h.stop());

test('someone without View Channel Members sees only themselves until they are let in', async (t) => {
  const admin = await h.register('admin');
  const member = await h.register('member');
  const newbie = await h.register('newbie');
  const A = await h.connect(admin.token);
  const db = new Database(path.join(h.dataDir, 'haven.db'));
  db.pragma('busy_timeout = 5000');
  t.after(() => db.close());

  const made = h.next(A, 'channels-list', (chs) => Array.isArray(chs) && chs.some(c => c.name === 'lobby'));
  A.emit('create-channel', { name: 'lobby' });
  const lobby = (await made).find(c => c.name === 'lobby');
  assert.ok(lobby, 'the channel exists');

  // A server that holds new arrivals back: the first role cannot see
  // members, and a Verified role can.
  db.prepare("DELETE FROM role_permissions WHERE permission = 'view_channel_members'").run();
  const verified = Number(db.prepare("INSERT INTO roles (name, level, scope, color) VALUES ('Verified', 10, 'server', '#ccc')").run().lastInsertRowid);
  db.prepare("INSERT INTO role_permissions (role_id, permission, allowed) VALUES (?, 'view_channel_members', 1)").run(verified);
  db.prepare('INSERT INTO user_roles (user_id, role_id, channel_id) VALUES (?, ?, NULL)').run(member.id, verified);
  for (const id of [member.id, newbie.id]) {
    db.prepare('INSERT OR IGNORE INTO channel_members (channel_id, user_id) VALUES (?, ?)').run(lobby.id, id);
  }

  const inLobby = (d) => d && d.channelCode === lobby.code;
  const ids = (d) => d.users.map(u => u.id).sort((a, b) => a - b);
  const everyone = [admin.id, member.id, newbie.id].sort((a, b) => a - b);

  // The sidebar.
  const M = await h.connect(member.token);
  const N = await h.connect(newbie.token);
  const seenByMember = h.next(M, 'online-users', (d) => inLobby(d) && d.users.length === 3);
  const seenByNewbie = h.next(N, 'online-users', inLobby);
  for (const s of [A, M, N]) s.emit('enter-channel', { code: lobby.code });
  assert.deepEqual(ids(await seenByMember), everyone, 'a member sees everyone');
  assert.deepEqual(ids(await seenByNewbie), [newbie.id], 'the new arrival sees only themselves');
  const more = await h.next(N, 'online-users', (d) => inLobby(d) && d.users.length > 1, 1200);
  assert.equal(more, null, 'and no later update shows more');

  // The @mention list.
  const mentions = async (sock) => {
    const got = h.next(sock, 'channel-members', inLobby);
    sock.emit('get-channel-members', { code: lobby.code });
    return (await got).members.map(m => m.id).sort((a, b) => a - b);
  };
  assert.deepEqual(await mentions(M), everyone);
  assert.deepEqual(await mentions(N), [newbie.id]);

  // A new DM.
  const refused = h.next(N, 'error-msg');
  N.emit('start-dm', { targetUserId: member.id });
  assert.match(String(await refused), /cannot message this person yet/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM channels WHERE is_dm = 1').get().n, 0, 'no conversation was made');

  // A member can still write to them, and they can answer in that one.
  const opened = h.next(M, 'dm-opened');
  M.emit('start-dm', { targetUserId: newbie.id });
  const dm = await opened;
  assert.ok(dm && dm.code, 'the member opened a DM');
  const reopened = h.next(N, 'dm-opened');
  N.emit('start-dm', { targetUserId: member.id });
  assert.equal((await reopened).code, dm.code, 'the existing conversation opens');

  // Let in: the next member list update shows everyone.
  db.prepare('INSERT INTO user_roles (user_id, role_id, channel_id) VALUES (?, ?, NULL)').run(newbie.id, verified);
  const full = h.next(N, 'online-users', (d) => inLobby(d) && d.users.length === 3);
  const M2 = await h.connect(member.token);
  M2.emit('enter-channel', { code: lobby.code });
  M.emit('set-status', { status: 'away' });
  assert.deepEqual(ids(await full), everyone, 'everyone shows once they have the role');
  assert.deepEqual(await mentions(N), everyone);
  const withAdmin = h.next(N, 'dm-opened');
  N.emit('start-dm', { targetUserId: admin.id });
  assert.ok((await withAdmin)?.code, 'and they can start a DM');
  await wait(50);
});
