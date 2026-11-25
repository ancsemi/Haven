'use strict';

// The live audit log for bot accounts (src/auditStream.js): rows go out once
// committed, in order, as get-audit-log shapes them for the bot; a bot that
// loses the permission is dropped.

const assert = require('node:assert/strict');
const test = require('node:test');
const Database = require('better-sqlite3');

const { createAuditStream, hideChannelCodes, isNoteAbout } = require('../src/auditStream');

function setup() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    actor_id INTEGER, actor_username TEXT, action TEXT NOT NULL, target_type TEXT, target_id INTEGER, target_name TEXT, details TEXT)`);
  const allowed = new Set();
  const stream = createAuditStream({ db, userHasPermission: (id, p) => p === 'view_audit_log' && allowed.has(id) });
  const insert = (action, { target_id = null, target_name = null, details = null } = {}) => {
    const info = db.prepare('INSERT INTO audit_log (action, target_id, target_name, details) VALUES (?, ?, ?, ?)')
      .run(action, target_id, target_name, details);
    stream.publish(Number(info.lastInsertRowid));
    return Number(info.lastInsertRowid);
  };
  return { db, stream, insert, allowed };
}

function fakeSocket(id, { botAccount = true, isAdmin = false } = {}) {
  const got = [];
  return { user: { id, botAccount, isAdmin }, connected: true, got, emit: (ev, data) => got.push([ev, data]) };
}

const tick = () => new Promise(res => setImmediate(res));
const entries = (s) => s.got.filter(([ev]) => ev === 'audit-entry').map(([, row]) => row);

test('rows go out in order with a UTC time, only the actions asked for', async () => {
  const { stream, insert, allowed } = setup();
  const bot = fakeSocket(7);
  allowed.add(7);
  const lastId = stream.subscribe(bot, new Set(['user_ban', 'user_warn']));
  assert.equal(lastId, 0);
  const ban = insert('user_ban', { target_id: 3 });
  insert('emoji_add');
  const warn = insert('user_warn', { target_id: 4 });
  await tick();
  const rows = entries(bot);
  assert.deepEqual(rows.map(r => r.id), [ban, warn]);
  assert.match(rows[0].created_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.equal(rows[0].target_id, 3);
});

test('a row from a rolled-back write never goes out, and one that reuses its id does', async () => {
  const { db, stream, insert, allowed } = setup();
  const bot = fakeSocket(7);
  allowed.add(7);
  stream.subscribe(bot, null);
  const failed = db.transaction(() => { insert('user_ban'); throw new Error('rolled back'); });
  assert.throws(failed, /rolled back/);
  insert('user_kick');
  await tick();
  assert.deepEqual(entries(bot).map(r => r.action), ['user_kick']);
});

test('channel codes are hidden from all but the admin', async () => {
  const { stream, insert, allowed } = setup();
  const bot = fakeSocket(7);
  const adminBot = fakeSocket(8, { isAdmin: true });
  allowed.add(7);
  stream.subscribe(bot, null);
  stream.subscribe(adminBot, null);
  insert('invite_code_create', { target_name: 'lobby', details: JSON.stringify({ code: 'a1b2c3d4' }) });
  await tick();
  assert.equal(JSON.parse(entries(bot)[0].details).code, '(code hidden)');
  assert.equal(JSON.parse(entries(adminBot)[0].details).code, 'a1b2c3d4');
});

test('a bot gets no note about itself, and is dropped once it cannot read the log', async () => {
  const { stream, insert, allowed } = setup();
  const bot = fakeSocket(7);
  allowed.add(7);
  stream.subscribe(bot, null);
  insert('user_note', { target_id: 7, details: JSON.stringify({ note: 'x', caseId: 1 }) });
  insert('mod_case_revoke', { target_id: 7, details: JSON.stringify({ caseId: 1, type: 'note' }) });
  insert('user_note', { target_id: 3, details: JSON.stringify({ note: 'y', caseId: 2 }) });
  await tick();
  assert.deepEqual(entries(bot).map(r => r.target_id), [3]);

  allowed.delete(7);
  insert('role_revoke', { target_id: 7 });
  await tick();
  assert.equal(entries(bot).length, 1);
  assert.equal(bot.got.at(-1)[0], 'audit-log-unsubscribed');
  assert.equal(stream.has(bot), false);
});

test('only a bot account that can read the log may follow it', () => {
  const { stream, allowed } = setup();
  allowed.add(5);
  allowed.add(7);
  assert.equal(stream.canRead(fakeSocket(5, { botAccount: false })), false);
  assert.equal(stream.canRead(fakeSocket(6)), false);
  assert.equal(stream.canRead(fakeSocket(7)), true);
  assert.equal(stream.canRead(fakeSocket(1, { isAdmin: true })), true);
});

test('the note check and code hiding match get-audit-log', () => {
  assert.equal(isNoteAbout({ action: 'user_note', target_id: 7 }, 7), true);
  assert.equal(isNoteAbout({ action: 'user_note', target_id: 3 }, 7), false);
  assert.equal(isNoteAbout({ action: 'mod_case_revoke', target_id: 7, details: '{"type":"warn"}' }, 7), false);
  assert.equal(isNoteAbout({ action: 'mod_case_revoke', target_id: 7, details: 'not json' }, 7), false);
  const row = { id: 1, target_name: 'code deadbeef', details: null };
  assert.equal(hideChannelCodes(row).target_name, 'code (code hidden)');
  assert.equal(row.target_name, 'code deadbeef', 'the row itself is left alone');
});
