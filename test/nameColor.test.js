'use strict';

// Someone who holds several colored roles can pick which one colors their
// name. Only the color moves; the role shown as theirs stays the highest.

const assert = require('node:assert/strict');
const test = require('node:test');
const Database = require('better-sqlite3');
const createPermissions = require('../src/socketHandlers/permissions');
const nameColor = require('../src/nameColor');
const registerNameColor = require('../src/socketHandlers/nameColor');

function freshDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE roles (id INTEGER PRIMARY KEY, name TEXT, level INTEGER, color TEXT, color2 TEXT, color_shimmer INTEGER DEFAULT 0,
      icon TEXT, transparent INTEGER DEFAULT 0, scope TEXT DEFAULT 'server');
    CREATE TABLE user_roles (user_id INTEGER, role_id INTEGER, channel_id INTEGER, custom_level INTEGER);
    CREATE TABLE user_preferences (user_id INTEGER, key TEXT, value TEXT, PRIMARY KEY (user_id, key));
    INSERT INTO roles (id, name, level, color, color2, color_shimmer, transparent) VALUES
      (1, 'User', 1, '#111111', NULL, 0, 0),
      (2, 'Green', 0, '#00ff00', NULL, 0, 0),
      (3, 'Sunset', 0, '#ff0000', '#ffff00', 1, 0),
      (4, 'Hidden', 0, '#0000ff', NULL, 0, 1),
      (5, 'Plain', 0, NULL, NULL, 0, 0),
      (6, 'Mod', 50, '#aa0000', '#00aa00', 1, 0);
    INSERT INTO user_roles (user_id, role_id) VALUES (10, 1), (10, 2), (10, 3), (10, 4), (10, 5), (11, 1), (12, 6), (12, 2);
  `);
  return db;
}

test('with no choice the highest role that shows colors the name', () => {
  const db = freshDb();
  const { getUserHighestRole } = createPermissions(db);
  const role = getUserHighestRole(10);
  assert.equal(role.name, 'User');
  assert.equal(role.color, '#111111');
  assert.equal(role.own_color, undefined);
});

test('a chosen role lends its colors and leaves the role itself alone', () => {
  const db = freshDb();
  const { getUserHighestRole } = createPermissions(db);
  nameColor.setChoice(db, 10, 3);
  const role = getUserHighestRole(10);
  assert.equal(role.id, 1);
  assert.equal(role.name, 'User');
  assert.equal(role.level, 1);
  assert.deepEqual([role.color, role.color2, role.color_shimmer], ['#ff0000', '#ffff00', 1]);
  assert.deepEqual([role.own_color, role.own_color2, role.own_color_shimmer], ['#111111', null, 0]);

  nameColor.setChoice(db, 12, 2);
  const mod = getUserHighestRole(12);
  assert.equal(mod.name, 'Mod');
  assert.deepEqual([mod.color, mod.color2, mod.color_shimmer], ['#00ff00', null, 0], 'a plain choice drops the gradient');
  assert.deepEqual([mod.own_color, mod.own_color2, mod.own_color_shimmer], ['#aa0000', '#00aa00', 1]);
});

test('a choice that cannot be used is ignored', () => {
  const db = freshDb();
  const { getUserHighestRole } = createPermissions(db);
  for (const id of [4, 5, 6, 99]) {
    nameColor.setChoice(db, 10, id);
    assert.equal(getUserHighestRole(10).color, '#111111', `role ${id}`);
  }
  nameColor.setChoice(db, 10, 2);
  assert.equal(getUserHighestRole(10).color, '#00ff00');
  db.prepare('DELETE FROM user_roles WHERE user_id = 10 AND role_id = 2').run();
  assert.equal(getUserHighestRole(10).color, '#111111', 'the role was taken away');
  nameColor.setChoice(db, 10, null);
  assert.equal(nameColor.chosenRoleId(db, 10), null);
});

function connect(db, userId) {
  const perms = createPermissions(db);
  const handlers = {};
  const refreshed = [];
  const socket = { user: { id: userId }, on: (name, fn) => { handlers[name] = fn; } };
  registerNameColor(socket, {
    db,
    state: { channelUsers: new Map([['abc', new Map([[userId, {}]])], ['zzz', new Map()]]), voiceUsers: new Map([['abc', new Map([[userId, {}]])]]) },
    getUserAllRoles: perms.getUserAllRoles,
    emitOnlineUsers: code => refreshed.push(`list:${code}`),
    emitDmPresence: id => refreshed.push(`dm:${id}`),
    broadcastVoiceUsers: code => refreshed.push(`voice:${code}`),
  });
  return { handlers, refreshed, perms };
}

test('the choices are the colored roles a person holds that show', () => {
  const db = freshDb();
  const { handlers } = connect(db, 10);
  let got = null;
  handlers['get-name-color'](data => { got = data; });
  assert.deepEqual(got.choices.map(r => r.name).sort(), ['Green', 'Sunset', 'User']);
  assert.equal(got.chosen, null);
});

test('only a role you hold can be picked, and picking refreshes the lists you are in', () => {
  const db = freshDb();
  const { handlers, refreshed, perms } = connect(db, 11);
  let got = null;
  handlers['set-name-color']({ roleId: 3 }, data => { got = data; });
  assert.deepEqual(got, { error: 'not-held' });
  assert.equal(nameColor.chosenRoleId(db, 11), null);
  assert.deepEqual(refreshed, []);

  const mine = connect(db, 10);
  mine.handlers['set-name-color']({ roleId: 2 }, data => { got = data; });
  assert.equal(got.chosen, 2);
  assert.equal(perms.getUserHighestRole(10).color, '#00ff00');
  assert.deepEqual(mine.refreshed, ['list:abc', 'dm:10', 'voice:abc']);

  mine.handlers['set-name-color']({ roleId: null }, data => { got = data; });
  assert.equal(got.chosen, null);
  assert.equal(perms.getUserHighestRole(10).color, '#111111');
});
