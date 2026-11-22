'use strict';

// A bot account's embeds and buttons are read by AutoMod like its text, and
// the Admin role holds no admin-only permission that could pass to whoever
// (or whatever bot) is later given the role.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');
const botComponents = require('../src/botComponents');
const { createAdminRole, trimAdminRolePerms } = require('../src/roleDefaults');
const { ADMIN_ONLY_PERMS, VALID_ROLE_PERMS } = require('../src/socketHandlers/helpers');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('every word and link a member would see is handed to AutoMod', () => {
  const parts = botComponents.clean({
    embeds: [{
      title: 'Title', description: 'Body', url: 'https://one.example/a', author: { name: 'Author', url: 'https://two.example/b' },
      footer: { text: 'Footer' }, fields: [{ name: 'Field', value: 'see https://three.example/c' }],
    }],
    components: [
      { type: 1, components: [{ type: 2, style: 5, label: 'Open', url: 'https://four.example/d' }, { type: 2, label: 'Vote', custom_id: 'v' }] },
      { type: 1, components: [{ type: 3, custom_id: 's', placeholder: 'Pick one', options: [{ label: 'Red', value: 'r', description: 'https://five.example/e' }] }] },
    ],
  });
  assert.equal(parts.error, undefined);
  const text = botComponents.plainText(parts);
  for (const word of ['Title', 'Body', 'one.example', 'Author', 'two.example', 'Footer', 'Field', 'three.example', 'Open', 'four.example', 'Vote', 'Pick one', 'Red', 'five.example']) {
    assert.ok(text.includes(word), `${word} is checked`);
  }
  assert.equal(botComponents.plainText({}), '');
});

test('sending and editing bot parts both go through AutoMod', () => {
  const messages = read('src/socketHandlers/messages.js');
  assert.equal((messages.match(/parts\.any && enforceAutomod\(botComponents\.plainText\(parts\)/g) || []).length, 2, 'a message and a thread reply');
  assert.match(read('src/socketHandlers/botInteractions.js'), /!ctx\.enforceAutomod \|\| ctx\.enforceAutomod\(botComponents\.plainText\(parts\)/);
});

function freshDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE roles (id INTEGER PRIMARY KEY, name TEXT, level INTEGER, scope TEXT, color TEXT, icon TEXT);
    CREATE TABLE role_permissions (role_id INTEGER, permission TEXT, allowed INTEGER, PRIMARY KEY (role_id, permission));
    CREATE TABLE server_settings (key TEXT PRIMARY KEY, value TEXT);
  `);
  return db;
}
const perms = (db, id) => db.prepare('SELECT permission FROM role_permissions WHERE role_id = ?').all(id).map(r => r.permission);

test('a new Admin role holds every permission but the admin-only ones', () => {
  const db = freshDb();
  const held = perms(db, createAdminRole(db));
  assert.deepEqual(held.filter(p => ADMIN_ONLY_PERMS.includes(p)), []);
  assert.equal(held.length, VALID_ROLE_PERMS.length - ADMIN_ONLY_PERMS.length);
});

test('an older Admin role loses its admin-only permissions once, and only that role', () => {
  const db = freshDb();
  const insert = db.prepare('INSERT INTO role_permissions (role_id, permission, allowed) VALUES (?, ?, 1)');
  db.exec("INSERT INTO roles (id, name, level, scope) VALUES (7, 'Admin', 99, 'server'), (8, 'Co-owner', 90, 'server')");
  for (const id of [7, 8]) for (const p of ['manage_server', 'transfer_admin', 'kick_user']) insert.run(id, p);
  db.prepare("INSERT INTO server_settings (key, value) VALUES ('admin_role_id', '7')").run();

  trimAdminRolePerms(db);
  assert.deepEqual(perms(db, 7), ['kick_user']);
  assert.deepEqual(perms(db, 8).sort(), ['kick_user', 'manage_server', 'transfer_admin'], 'a role the admin set up on purpose is left alone');

  // The admin puts one back on purpose afterwards: it stays.
  insert.run(7, 'manage_server');
  trimAdminRolePerms(db);
  assert.ok(perms(db, 7).includes('manage_server'));
});
