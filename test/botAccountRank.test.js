'use strict';

// Whoever holds a bot's token acts with the bot's roles, so only the admin
// manages a bot that outranks them, and a bot never takes the admin's name.

const assert = require('node:assert/strict');
const test = require('node:test');
const Database = require('better-sqlite3');
const bots = require('../src/botAccounts');

function freshDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, avatar TEXT, is_admin INTEGER DEFAULT 0,
      is_bot INTEGER DEFAULT 0, bot_disabled INTEGER DEFAULT 0, bot_created_by INTEGER);
    CREATE TABLE roles (id INTEGER PRIMARY KEY, name TEXT, level INTEGER, color TEXT, color2 TEXT, color_shimmer INTEGER DEFAULT 0,
      icon TEXT, transparent INTEGER DEFAULT 0, scope TEXT DEFAULT 'server');
    CREATE TABLE user_roles (user_id INTEGER, role_id INTEGER, channel_id INTEGER, custom_level INTEGER);
    CREATE TABLE user_preferences (user_id INTEGER, key TEXT, value TEXT, PRIMARY KEY (user_id, key));
    CREATE TABLE blocked_names (name TEXT);
    INSERT INTO roles (id, name, level) VALUES (1, 'User', 1), (2, 'Mod', 50);
    INSERT INTO users (id, username, is_admin, is_bot, bot_created_by) VALUES
      (1, 'owner', 1, 0, NULL), (2, 'maker', 0, 0, NULL), (3, 'manager', 0, 0, NULL),
      (10, 'helper', 0, 1, 2), (11, 'modbot', 0, 1, 2), (12, 'rootbot', 1, 1, 2);
    INSERT INTO user_roles (user_id, role_id) VALUES (2, 1), (3, 1), (10, 1), (11, 2);
  `);
  bots.ensureTable(db);
  return db;
}

const hasPerm = (id, perm) => id === 3 && perm === 'manage_bots';

test('a Bot Creator and a Bot Manager manage a bot of their own rank or lower', () => {
  const db = freshDb();
  assert.equal(bots.access(db, { id: 2, isAdmin: false }, 10, hasPerm).full, false);
  assert.equal(bots.access(db, { id: 3, isAdmin: false }, 10, hasPerm).full, true);
});

test('a bot that outranks them, or is the admin, is the admin\'s alone to manage', () => {
  const db = freshDb();
  for (const actor of [{ id: 2, isAdmin: false }, { id: 3, isAdmin: false }]) {
    assert.equal(bots.access(db, actor, 11, hasPerm), null, `outranked, user ${actor.id}`);
    assert.equal(bots.access(db, actor, 12, hasPerm), null, `admin bot, user ${actor.id}`);
  }
  assert.equal(bots.access(db, { id: 1, isAdmin: true }, 11, hasPerm).full, true);
  assert.equal(bots.access(db, { id: 1, isAdmin: true }, 12, hasPerm).full, true);
});

test('a bot cannot take the admin name', () => {
  const db = freshDb();
  assert.ok(bots.checkName(db, 'Admin').error);
  assert.ok(bots.checkName(db, 'admin', 10).error);
});
