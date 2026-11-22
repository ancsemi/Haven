'use strict';

// Groups are roles anyone can give themselves, so what a group carries must
// not become a way around the admin's limits.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('guests and bots are refused before any group is looked up', () => {
  const src = read('src/socketHandlers/roles.js');
  const handler = src.slice(src.indexOf("socket.on('update-groups'"));
  const refusal = handler.indexOf('socket.user.isGuest || socket.user.botAccount');
  assert.ok(refusal > 0 && refusal < handler.indexOf('SELECT'), 'the refusal comes before the first query');
});

test('only the admin sets how much a role may upload', () => {
  const src = read('src/socketHandlers/roles.js');
  assert.match(src, /const maxUploadMb = socket\.user\.isAdmin && isInt\(data\.maxUploadMb\)/);
  assert.match(src, /if \(data\.maxUploadMb !== undefined && socket\.user\.isAdmin\)/);
});

test('a group does not shield an account from bulk remove, a real role does', () => {
  const src = read('src/socketHandlers/moderation.js');
  assert.equal((src.match(/r\.auto_assign = 0 AND r\.level > 0\)/g) || []).length, 2, 'the preview and the removal agree');

  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, is_admin INTEGER DEFAULT 0);
    CREATE TABLE roles (id INTEGER PRIMARY KEY, level INTEGER, auto_assign INTEGER DEFAULT 0);
    CREATE TABLE user_roles (user_id INTEGER, role_id INTEGER);
    INSERT INTO roles (id, level, auto_assign) VALUES (1, 1, 1), (2, 0, 0), (3, 50, 0);
    INSERT INTO users (id) VALUES (10), (11), (12);
    INSERT INTO user_roles (user_id, role_id) VALUES (10, 1), (11, 1), (11, 2), (12, 3);
  `);
  const removable = db.prepare(`
    SELECT u.id FROM users u WHERE u.is_admin = 0
      AND NOT EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
                      WHERE ur.user_id = u.id AND r.auto_assign = 0 AND r.level > 0)
    ORDER BY u.id`).all().map(r => r.id);
  assert.deepEqual(removable, [10, 11]);
});
