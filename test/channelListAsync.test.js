'use strict';

// A password login followed by the real get-channels Socket.IO handler.
// The legacy list is the SQLite behavior oracle; PostgreSQL must return the
// same private-room, role-gate, DM and unread fields without reading SQLite.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setImmediate: nextTurn } = require('node:timers/promises');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-channel-list-async-'));
process.env.HAVEN_DATA_DIR = DATA;
process.env.JWT_SECRET = 'channel-list-async-secret';
delete process.env.HAVEN_DATABASE_URL;
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
const { io: connect } = require('socket.io-client');
const database = require('../src/database');
const { createPostgresFixture } = require('./postgresHarness');
const createPermissions = require('../src/socketHandlers/permissions');
const createChannelLists = require('../src/socketHandlers/channelList');
const registerChannels = require('../src/socketHandlers/channels');
const db = database.initDatabase();
const sqliteAsync = db.async;
require('../src/forumUnread').ensureTable(db);
db.exec('DELETE FROM channel_members; DELETE FROM messages; DELETE FROM channels;');
const password = 'channeltest12345';
const hash = bcrypt.hashSync(password, 4);
const users = {};
for (const [name, admin, guest] of [['admin', 1, 0], ['alice', 0, 0], ['bob', 0, 0], ['moderator', 0, 0], ['healer', 0, 0], ['guest', 0, 1]]) {
  users[name] = db.prepare('INSERT INTO users (username, password_hash, is_admin, is_guest) VALUES (?, ?, ?, ?)').run(name, hash, admin, guest).lastInsertRowid;
}
db.prepare('UPDATE users SET display_name = ?, avatar_shape = ? WHERE id = ?').run('Bobby', 'hex', users.bob);
const makeRole = (name, permissions) => {
  const id = db.prepare("INSERT INTO roles (name, scope, level) VALUES (?, 'server', 40)").run(name).lastInsertRowid;
  for (const permission of permissions) db.prepare('INSERT INTO role_permissions (role_id, permission, allowed) VALUES (?, ?, 1)').run(id, permission);
  return id;
};
const gatedRole = makeRole('Gated', []);
const seeAllRole = makeRole('See all', ['view_all_channels']);
const scopedRole = makeRole('Room manager', ['manage_channel_settings', 'kick_user', 'read_only_override']);
db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)').run(users.moderator, seeAllRole);
const channels = {};
let code = 0x10000000;
function channel(name, opts = {}) {
  const id = db.prepare(`
    INSERT INTO channels (name, code, created_by, is_dm, is_group, is_private, code_visibility, read_only, is_forum, role_gate, parent_channel_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(name, (++code).toString(16), users.bob, opts.dm || 0, opts.group || 0, opts.private || 0,
    opts.private ? 'private' : 'public', opts.readOnly || 0, opts.forum || 0,
    opts.gate ? JSON.stringify({ mode: 'all', roles: [gatedRole] }) : null, opts.parent || null).lastInsertRowid;
  channels[name] = id;
  return id;
}
const general = channel('general');
// Upstream's channel-type link must survive both sync and async room lists.
db.prepare('UPDATE channels SET type_id = ? WHERE id = ?').run(2, general);
const privateRoom = channel('private', { private: 1 });
const gated = channel('gated', { gate: true, private: 1 });
const readOnly = channel('read-only', { readOnly: 1 });
const child = channel('child', { parent: privateRoom });
const forum = channel('forum', { forum: 1 });
const dm = channel('dm', { dm: 1 });
const self = channel('self', { dm: 1 });
const group = channel('group', { dm: 1, group: 1 });
const otherDm = channel('other-dm', { dm: 1 });
const member = db.prepare('INSERT INTO channel_members (channel_id, user_id, joined_at) VALUES (?, ?, ?)');
for (const id of [general, privateRoom, gated, readOnly, child, forum, dm, self, group]) member.run(id, users.alice, '2026-01-02 10:00:00');
for (const id of [dm, group, otherDm]) member.run(id, users.bob, '2026-01-02 10:00:00');
member.run(otherDm, users.moderator, '2026-01-02 10:00:00');
member.run(general, users.moderator, '2026-01-02 10:00:00');
db.prepare('INSERT INTO dm_group_invites (channel_id, user_id, invited_by) VALUES (?, ?, ?)').run(group, users.guest, users.alice);
db.prepare('INSERT INTO user_roles (user_id, role_id, channel_id) VALUES (?, ?, ?)').run(users.alice, scopedRole, privateRoom);
db.prepare('INSERT INTO user_roles (user_id, role_id, channel_id) VALUES (?, ?, ?)').run(users.alice, scopedRole, readOnly);
db.prepare('INSERT INTO user_role_perms (user_id, role_id, permission, allowed, channel_id) VALUES (?, ?, ?, 0, ?)').run(users.alice, scopedRole, 'manage_sub_channels', privateRoom);
db.prepare("INSERT OR REPLACE INTO server_settings (key, value) VALUES ('default_join_channels', ?)").run(JSON.stringify([general]));
const post = db.prepare('INSERT INTO messages (channel_id, user_id, content, type, thread_id, created_at) VALUES (?, ?, ?, ?, ?, ?)');
const first = post.run(general, users.bob, 'read', 'user', null, '2026-01-03 00:00:00').lastInsertRowid;
post.run(general, null, 'imported', 'user', null, '2026-01-03 00:01:00');
post.run(general, users.alice, 'own', 'user', null, '2026-01-03 00:02:00');
post.run(general, users.bob, 'notice', 'notice', null, '2026-01-03 00:03:00');
post.run(general, users.bob, 'reply', 'user', first, '2026-01-03 00:04:00');
post.run(group, users.bob, 'before joining', 'user', null, '2026-01-01 00:00:00');
post.run(group, users.bob, 'after joining', 'user', null, '2026-01-03 00:00:00');
const topic = post.run(forum, users.bob, 'topic', 'user', null, '2026-01-03 00:00:00').lastInsertRowid;
post.run(forum, users.bob, 'reply', 'user', topic, '2026-01-03 00:01:00');
db.prepare('INSERT INTO read_positions (user_id, channel_id, last_read_message_id) VALUES (?, ?, ?)').run(users.alice, general, first);
const permissions = createPermissions(db);
const lists = createChannelLists({ db, userHasPermission: permissions.userHasPermission, roleGateAllows: permissions.roleGateAllows });

const intervals = [];
const nativeSetInterval = global.setInterval;
const intervalMock = test.mock.method(global, 'setInterval', (...args) => {
  const timer = nativeSetInterval(...args);
  intervals.push(timer);
  return timer;
});
let auth;
try { auth = require('../src/auth'); }
finally { intervalMock.mock.restore(); }
const app = express();
app.use(express.json());
app.use('/api/auth', auth.router);
let server, sockets, base;
const clients = [];
test.before(async () => {
  server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
  sockets = new Server(server);
  sockets.use(async (socket, next) => {
    const user = await auth.verifyTokenAsync(socket.handshake.auth.token);
    if (!user) return next(new Error('Invalid token'));
    socket.user = user;
    next();
  });
  sockets.on('connection', socket => registerChannels(socket, {
    io: sockets, db, state: { channelUsers: new Map(), voiceUsers: new Map(), activeMusic: new Map(), musicQueues: new Map() },
    ...permissions, ...lists,
  }));
});
test.after(async () => {
  for (const client of clients) client.disconnect();
  if (sockets) await new Promise(resolve => sockets.close(resolve));
  for (const timer of intervals) clearInterval(timer);
  db.close();
  fs.rmSync(DATA, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function signIn(username = 'alice') {
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, eulaVersion: '2.0', ageVerified: true }),
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(res.status, 200);
  return res.json();
}
async function openSocket(token) {
  const client = connect(base, { auth: { token }, transports: ['websocket'], forceNew: true, reconnection: false });
  clients.push(client);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Socket connection timed out')), 10000);
    client.once('connect', () => { clearTimeout(timer); resolve(); });
    client.once('connect_error', err => { clearTimeout(timer); reject(err); });
  });
  return client;
}
async function requestList(client) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('Channel list timed out')); }, 10000);
    const success = value => { cleanup(); resolve(value); };
    const failure = value => { cleanup(); reject(new Error(value)); };
    const cleanup = () => { clearTimeout(timer); client.off('channels-list', success); client.off('error-msg', failure); };
    client.once('channels-list', success);
    client.once('error-msg', failure);
    client.emit('get-channels');
  });
}
const plain = value => JSON.parse(JSON.stringify(value));
const tables = [
  'users', 'bans', 'server_settings', 'eula_acceptances', 'channels', 'channel_members',
  'roles', 'user_roles', 'role_permissions', 'user_role_perms', 'messages', 'read_positions',
  'dm_group_invites', 'thread_reads', 'forum_topic_mutes',
];

for (const backend of ['sqlite', 'postgres']) {
  test(`${backend} login and room-list flow`, { skip: backend === 'postgres' && !process.env.HAVEN_TEST_POSTGRES_URL }, async (t) => {
    const fixture = backend === 'postgres' ? await createPostgresFixture(db, tables) : null;
    const driver = fixture ? fixture.db : sqliteAsync;
    if (fixture) {
      await driver.prepare('CREATE UNIQUE INDEX channel_members_key ON channel_members (channel_id, user_id)').run();
      await driver.prepare('CREATE UNIQUE INDEX eula_acceptance_key ON eula_acceptances (user_id, version)').run();
    }
    db.async = driver;
    t.after(async () => { db.async = sqliteAsync; if (fixture) await fixture.close(); });

    await t.test('the async list matches every SQLite visibility, unread and DM field', async () => {
      for (const name of ['alice', 'admin', 'moderator', 'guest', 'healer']) {
        const expected = plain(lists.getEnrichedChannels(users[name], name === 'admin'));
        const actual = plain(await lists.getEnrichedChannelsAsync(users[name], name === 'admin'));
        assert.deepEqual(actual, expected, name);
      }
      const aliceList = await lists.getEnrichedChannelsAsync(users.alice, false);
      const byName = Object.fromEntries(aliceList.map(ch => [ch.name, ch]));
      assert.equal(byName.general.type_id, 2);
      assert.equal(byName.general.unreadCount, 1, 'imported messages count; own, notices and thread replies do not');
      assert.equal(byName.group.unreadCount, 1, 'pre-membership history stays excluded');
      assert.equal(byName.forum.forumUnread, 1);
      assert.equal(byName.gated, undefined);
      assert.equal(byName['other-dm'], undefined);
      assert.equal(byName.private.canManageSettings, true);
      assert.equal(byName.child.canManageSettings, true);
      assert.equal(byName.private.canManageSubs, false);
      assert.equal(byName['read-only'].canOverrideReadOnly, true);
      assert.equal(byName.dm.dm_target.avatarShape, 'hex');
      assert.equal(byName.self.is_self_dm, 1);
      assert.equal(byName.group.group_pending[0].id, users.guest);
      assert.equal(byName.dm.display_code, null);
      assert.equal(byName.dm.code_visibility, undefined);
    });

    await t.test('a password login leads to a real Socket.IO room list and room membership', async (t) => {
      const expected = plain(lists.getEnrichedChannels(users.alice, false));
      if (fixture) t.mock.method(db, 'prepare', () => { throw new Error('Legacy SQLite read reached'); });
      const login = await signIn();
      const client = await openSocket(login.token);
      try {
        assert.deepEqual(await requestList(client), expected);
        const socket = sockets.sockets.sockets.get(client.id);
        for (const ch of expected) assert.ok(socket.rooms.has('channel:' + ch.code));
      } finally { client.disconnect(); }
    });

    await t.test('concurrent list requests preserve existing membership flags and avoid duplicate memberships', async () => {
      // Moderator auto-joins must preserve a hand-added row's flag.
      const row = await driver.prepare('SELECT auto_all_channels FROM channel_members WHERE channel_id = ? AND user_id = ?').get(general, users.moderator);
      await Promise.all(Array.from({ length: 4 }, () => lists.getEnrichedChannelsAsync(users.moderator, false)));
      assert.deepEqual(await driver.prepare('SELECT auto_all_channels FROM channel_members WHERE channel_id = ? AND user_id = ?').get(general, users.moderator), row);
      await driver.prepare('DELETE FROM channel_members WHERE user_id = ?').run(users.healer);
      const repaired = await Promise.all(Array.from({ length: 4 }, () => lists.getEnrichedChannelsAsync(users.healer, false)));
      assert.ok(repaired.every(chans => chans.some(ch => ch.id === general)));
      const memberships = await driver.prepare('SELECT channel_id FROM channel_members WHERE user_id = ?').all(users.healer);
      assert.equal(new Set(memberships.map(row => row.channel_id)).size, memberships.length);
      assert.deepEqual(memberships, [{ channel_id: general }]);
    });

    if (fixture) {
      await t.test('every query can complete on a later turn without returning promises in the payload', async (t) => {
        const prepare = driver.prepare.bind(driver);
        const queries = new Set();
        t.mock.method(driver, 'prepare', sql => Object.fromEntries(['get', 'all', 'run'].map(method => [
          method, async (...params) => { await nextTurn(); queries.add(sql); return prepare(sql)[method](...params); },
        ])));
        const expected = plain(lists.getEnrichedChannels(users.alice, false));
        const result = await lists.getEnrichedChannelsAsync(users.alice, false);
        assert.deepEqual(plain(result), expected);
        assert.ok(queries.size >= 12, 'the full list uses the converted backend');
      });

      await t.test('a rejected room query emits an error without joining any rooms', async (t) => {
        const login = await signIn();
        const client = await openSocket(login.token);
        t.mock.method(console, 'error', () => {});
        const prepare = driver.prepare.bind(driver);
        t.mock.method(driver, 'prepare', sql => ({
          async get(...params) { return prepare(sql).get(...params); },
          async all(...params) {
            if (sql.includes('FROM read_positions')) throw new Error('backend unavailable');
            return prepare(sql).all(...params);
          },
        }));
        try {
          await assert.rejects(requestList(client), /Could not load channels/);
          const socket = sockets.sockets.sockets.get(client.id);
          assert.deepEqual([...socket.rooms], [client.id]);
        } finally { client.disconnect(); }
      });

      await t.test('a failed override lookup denies the permission instead of bypassing an explicit deny', async (t) => {
        const asyncPermissions = require('../src/socketHandlers/asyncPermissions')(driver);
        const prepare = driver.prepare.bind(driver);
        t.mock.method(console, 'error', () => {});
        t.mock.method(driver, 'prepare', sql => ({
          async get(...params) {
            if (sql.includes('FROM user_role_perms')) throw new Error('backend unavailable');
            return prepare(sql).get(...params);
          },
        }));
        assert.equal(await asyncPermissions.userHasPermission(users.alice, 'manage_channel_settings', privateRoom), false);
      });
      await t.test('the production socket middleware reads PostgreSQL profiles and refuses bans and revoked tokens', async (t) => {
        const gateway = new Server();
        const gates = [];
        t.mock.method(gateway, 'use', fn => { gates.push(fn); return gateway; });
        const startupTimers = [];
        const originalInterval = global.setInterval;
        const timerMock = t.mock.method(global, 'setInterval', (...args) => {
          const timer = originalInterval(...args);
          startupTimers.push(timer);
          return timer;
        });
        try {
          require('../src/socketHandlers').setupSocketHandlers(gateway, db, { isIpBanned: () => false });
        } finally {
          timerMock.mock.restore();
        }
        t.after(() => {
          for (const timer of startupTimers) clearInterval(timer);
          gateway.removeAllListeners();
        });
        const original = await driver.prepare('SELECT display_name FROM users WHERE id = ?').get(users.alice);
        const token = jwt.sign({ id: users.alice, username: 'alice', pwv: 1 }, process.env.JWT_SECRET);
        const gate = gates[gates.length - 1];
        const check = async value => {
          const socket = { handshake: { auth: { token: value }, address: '127.0.0.1', headers: {} } };
          const error = await new Promise(resolve => gate(socket, resolve));
          return { error, socket };
        };
        try {
          await driver.prepare('UPDATE users SET display_name = ? WHERE id = ?').run('PostgreSQL profile', users.alice);
          const result = await check(token);
          assert.equal(result.error, undefined);
          assert.equal(result.socket.user.displayName, 'PostgreSQL profile');
          await driver.prepare('INSERT INTO bans (user_id, reason) VALUES (?, ?)').run(users.alice, 'test ban');
          assert.match((await check(token)).error.message, /banned/);
          await driver.prepare('DELETE FROM bans WHERE user_id = ?').run(users.alice);
          await driver.prepare('UPDATE users SET password_version = 2 WHERE id = ?').run(users.alice);
          assert.match((await check(token)).error.message, /Invalid token/);
          const challenge = jwt.sign({ id: users.alice, purpose: 'totp_challenge' }, process.env.JWT_SECRET);
          assert.match((await check(challenge)).error.message, /Invalid token/);
        } finally {
          await driver.prepare('DELETE FROM bans WHERE user_id = ?').run(users.alice);
          await driver.prepare('UPDATE users SET display_name = ?, password_version = 1 WHERE id = ?').run(original.display_name, users.alice);
        }
      });
    } else {
      await t.test('SQLite still finishes membership changes and joins before the promise yields', async () => {
        const rooms = [];
        const result = lists.getEnrichedChannelsAsync(users.alice, false, room => rooms.push(room));
        assert.ok(result instanceof Promise);
        assert.ok(rooms.length > 0, 'no check/write gap was introduced in SQLite');
        assert.equal((await result).length, rooms.length);
      });
    }
  });
}
