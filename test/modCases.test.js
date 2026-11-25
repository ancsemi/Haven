'use strict';

// Moderation history (#5759): records come from warnings and notes, and from
// the audit log for kicks, mutes and bans; the member's own view leaves out
// notes and names; revoking keeps the record but takes its points away.

const assert = require('node:assert/strict');
const test = require('node:test');
const Database = require('better-sqlite3');

const modCases = require('../src/modCases');
const register = require('../src/socketHandlers/modCases');

function freshDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, is_admin INTEGER DEFAULT 0)');
  db.prepare('INSERT INTO users (id, username, is_admin) VALUES (1, ?, 1), (2, ?, 0), (3, ?, 0), (4, ?, 0)').run('admin', 'mod', 'bob', 'eve');
  modCases.ensureTable(db);
  return db;
}

// A socket that records what the handlers registered, for calling them.
function fakeSocket(user, db, { perms = [], levels = {} } = {}) {
  const handlers = {};
  const emitted = [];
  const audit = [];
  const socket = { user, on: (ev, fn) => { handlers[ev] = fn; }, emit: (...a) => emitted.push(a) };
  const io = { sockets: { sockets: new Map() } };
  register(socket, {
    io, db,
    userHasPermission: (_id, p) => user.isAdmin || perms.includes(p),
    getUserEffectiveLevel: (id) => levels[id] ?? 0,
    logAudit: (entry) => audit.push(entry),
  });
  const call = (ev, data) => new Promise(res => handlers[ev](data, res));
  return { call, emitted, audit };
}

test('kicks, mutes and bans from the audit log land on the history; auto-mod is named as such', () => {
  const db = freshDb();
  modCases.fromAudit(db, { action: 'user_mute', actorId: 2, actorName: 'mod', targetId: 3, details: { durationMinutes: 10, reason: 'calm down' } });
  modCases.fromAudit(db, { action: 'automod_ban', actorId: 3, actorName: 'bob', targetId: 3, details: { strikes: 5 } });
  modCases.fromAudit(db, { action: 'role_create', actorId: 1, actorName: 'admin', targetId: 3, details: {} });
  const rows = modCases.list(db, 3);
  assert.deepEqual(rows.map(r => r.type).sort(), ['ban', 'mute']);
  assert.equal(rows.find(r => r.type === 'ban').actor, 'Auto-mod');
  assert.equal(rows.find(r => r.type === 'mute').durationMinutes, 10);
});

test('a moderator warns with a reason; the member sees it without the notes or who acted', async () => {
  const db = freshDb();
  const mod = fakeSocket({ id: 2, isAdmin: false, displayName: 'mod' }, db, { perms: ['kick_user'], levels: { 2: 25, 3: 0 } });
  assert.equal((await mod.call('warn-user', { userId: 3, reason: '   ' })).ok, false);
  const warned = await mod.call('warn-user', { userId: 3, reason: 'Spam', severity: 4 });
  assert.equal(warned.ok, true);
  assert.equal(warned.points, 4);
  assert.equal((await mod.call('add-mod-note', { userId: 3, text: 'watch' })).ok, true);

  const bob = fakeSocket({ id: 3, isAdmin: false }, db);
  const own = await bob.call('get-mod-history', { userId: 3 });
  assert.deepEqual(own.cases.map(c => c.type), ['warn']);
  assert.ok(!('actor' in own.cases[0]));
  assert.equal(own.canAdd, false);
  assert.equal((await bob.call('get-pending-warnings', {})).warnings.length, 1);
});

test('warnings and notes go on the audit log with the id of their history record', async () => {
  const db = freshDb();
  const mod = fakeSocket({ id: 2, isAdmin: false, displayName: 'mod' }, db, { perms: ['kick_user'], levels: { 2: 25, 3: 0 } });
  const warned = await mod.call('warn-user', { userId: 3, reason: 'Spam', severity: 2 });
  const noted = await mod.call('add-mod-note', { userId: 3, text: 'keeps posting links' });
  assert.deepEqual(mod.audit.map(e => e.action), ['user_warn', 'user_note']);
  assert.equal(mod.audit[0].details.caseId, warned.id);
  assert.deepEqual(mod.audit[1].details, { note: 'keeps posting links', caseId: noted.id });
  assert.equal(mod.audit[1].target_id, 3);
  // A refused note leaves no row.
  await mod.call('add-mod-note', { userId: 3, text: '  ' });
  assert.equal(mod.audit.length, 2);
});

test('a history record made from the audit log gives back its id', () => {
  const db = freshDb();
  const id = modCases.fromAudit(db, { action: 'user_ban', actorId: 2, actorName: 'mod', targetId: 3, details: { reason: 'spam' } });
  assert.equal(modCases.get(db, id).type, 'ban');
  assert.equal(modCases.fromAudit(db, { action: 'role_create', actorId: 1, targetId: 3, details: {} }), null);
});

test('nobody warns someone at or above their rank, an admin, or themselves; plain members cannot look', async () => {
  const db = freshDb();
  const mod = fakeSocket({ id: 2, isAdmin: false }, db, { perms: ['kick_user'], levels: { 2: 25, 4: 25 } });
  assert.equal((await mod.call('warn-user', { userId: 4, reason: 'x' })).ok, false);
  assert.equal((await mod.call('warn-user', { userId: 1, reason: 'x' })).ok, false);
  assert.equal((await mod.call('warn-user', { userId: 2, reason: 'x' })).ok, false);
  const bob = fakeSocket({ id: 3, isAdmin: false }, db);
  assert.equal((await bob.call('get-mod-history', { userId: 4 })).ok, false);
  assert.equal((await bob.call('warn-user', { userId: 4, reason: 'x' })).ok, false);
});

test('a revoked record stays in the history but its points drop off', async () => {
  const db = freshDb();
  const admin = fakeSocket({ id: 1, isAdmin: true, displayName: 'admin' }, db);
  const { id } = await admin.call('warn-user', { userId: 3, reason: 'Spam', severity: 5 });
  assert.equal(modCases.points(db, 3), 5);
  assert.equal((await admin.call('revoke-mod-case', { id })).ok, true);
  assert.equal(modCases.points(db, 3), 0);
  const rows = modCases.list(db, 3);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].revoked, true);
  assert.equal(rows[0].revokedBy, 'admin');
  // An acknowledged or revoked warning is not shown again.
  assert.equal(modCases.unseenWarnings(db, 3).length, 0);
});
