'use strict';

// Sub-servers: a server can split its channels into sub-servers, each with a
// name, an emoji and, if the server wants, roles a member needs to see it.
// The sidebar shows one sub-server at a time; a channel without one belongs
// to the main server. A sub-channel always sits in its parent's sub-server.
//
// Required roles are not checked here. A sub-server's roles are written onto
// every channel in it as that channel's own required roles (channels.role_gate,
// applied through applyRoleGate), so everything that already honors those
// (channel lists, messages, push, the overview, membership) honors the
// sub-server's too. A channel in a sub-server with required roles takes them
// as they are and cannot set different ones of its own.

const { parseRoleGate } = require('./roleGate');

const LIMITS = { name: 40, icon: 16, max: 50 };

function ensureTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS subservers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      icon TEXT NOT NULL DEFAULT '',
      role_gate TEXT DEFAULT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

// Checks a name and emoji sent by a client. For an edit, `base` is the stored
// row and a field left out keeps its value. Returns { subserver } or { error }.
function parseSubserver(input, base = null) {
  if (!input || typeof input !== 'object') return { error: 'Invalid sub-server' };
  const has = (k) => Object.prototype.hasOwnProperty.call(input, k);
  const name = has('name') ? input.name : (base ? base.name : undefined);
  if (typeof name !== 'string' || !name.trim()) return { error: 'Give the sub-server a name' };
  if (name.trim().length > LIMITS.name) return { error: `Names can be up to ${LIMITS.name} characters` };
  const icon = has('icon') ? input.icon : (base ? base.icon : '');
  if (icon !== null && icon !== undefined && typeof icon !== 'string') return { error: 'Invalid emoji' };
  const glyph = (icon || '').trim();
  if (glyph.length > LIMITS.icon || /[<>]/.test(glyph)) return { error: 'Pick one emoji' };
  return { subserver: { name: name.trim(), icon: glyph } };
}

// What a client sees. Only people who manage sub-servers see which roles one needs.
function shape(row, withGate) {
  const gate = parseRoleGate(row.role_gate);
  const out = { id: row.id, name: row.name, icon: row.icon || '', position: row.position, gated: !!gate };
  if (withGate) out.roleGate = gate;
  return out;
}

function all(db) {
  return db.prepare('SELECT * FROM subservers ORDER BY position, id').all();
}

function get(db, id) {
  return Number.isInteger(id) && id > 0 ? db.prepare('SELECT * FROM subservers WHERE id = ?').get(id) || null : null;
}

// A member sees a sub-server without required roles, or one whose roles they
// hold server-wide. Admins see them all.
function canSee(user, row, roleGateAllows) {
  return !!row && (user.isAdmin || !parseRoleGate(row.role_gate) || roleGateAllows(user.id, { id: 0, role_gate: row.role_gate }));
}

function visibleTo(db, user, roleGateAllows) {
  return all(db).filter(s => canSee(user, s, roleGateAllows));
}

function create(db, s) {
  const n = db.prepare('SELECT COUNT(*) AS n, MAX(position) AS p FROM subservers').get();
  if (n.n >= LIMITS.max) return { error: `A server can have up to ${LIMITS.max} sub-servers` };
  const r = db.prepare('INSERT INTO subservers (name, icon, position) VALUES (?, ?, ?)').run(s.name, s.icon, (n.p ?? -1) + 1);
  return { id: Number(r.lastInsertRowid) };
}

function update(db, id, s) {
  db.prepare('UPDATE subservers SET name = ?, icon = ? WHERE id = ?').run(s.name, s.icon, id);
}

function setGate(db, id, stored) {
  db.prepare('UPDATE subservers SET role_gate = ? WHERE id = ?').run(stored, id);
}

// Its channels go back to the main server and keep their required roles, so
// nothing opens up by surprise.
function remove(db, id) {
  db.transaction(() => {
    db.prepare('UPDATE channels SET subserver_id = NULL WHERE subserver_id = ?').run(id);
    db.prepare('DELETE FROM subservers WHERE id = ?').run(id);
  })();
}

// `ids` must name every sub-server once, in the new order.
function reorder(db, ids) {
  const have = all(db).map(s => s.id);
  if (!Array.isArray(ids) || ids.length !== have.length || new Set(ids).size !== ids.length || !ids.every(id => have.includes(id))) {
    return { error: 'Invalid order' };
  }
  const set = db.prepare('UPDATE subservers SET position = ? WHERE id = ?');
  db.transaction(() => ids.forEach((id, i) => set.run(i, id)))();
  return { ok: true };
}

function channelsIn(db, id) {
  return db.prepare('SELECT id, code, name, is_private FROM channels WHERE subserver_id = ? AND is_dm = 0').all(id);
}

// The sub-server whose required roles a channel takes, if it has any.
function gateFor(db, channelId) {
  const row = db.prepare(`SELECT s.* FROM channels c JOIN subservers s ON s.id = c.subserver_id
    WHERE c.id = ? AND s.role_gate IS NOT NULL`).get(channelId);
  return row && parseRoleGate(row.role_gate) ? row : null;
}

// Moves a channel and its sub-channels into a sub-server (null for the main
// server). Returns the channels that moved.
function place(db, channelId, subserverId) {
  const moved = db.prepare('SELECT id, code, name, is_private FROM channels WHERE (id = ? OR parent_channel_id = ?) AND is_dm = 0').all(channelId, channelId);
  db.prepare('UPDATE channels SET subserver_id = ? WHERE (id = ? OR parent_channel_id = ?) AND is_dm = 0').run(subserverId, channelId, channelId);
  return moved;
}

// A deleted role stops being required. Returns the sub-servers that changed.
function dropRole(db, roleId) {
  const changed = [];
  for (const s of all(db)) {
    const gate = parseRoleGate(s.role_gate);
    if (!gate || !gate.roles.includes(roleId)) continue;
    const rest = gate.roles.filter(r => r !== roleId);
    setGate(db, s.id, rest.length ? JSON.stringify({ mode: gate.mode, roles: rest }) : null);
    changed.push(s.id);
  }
  return changed;
}

module.exports = {
  LIMITS, ensureTables, parseSubserver, shape, all, get, canSee, visibleTo, create, update, setGate,
  remove, reorder, channelsIn, gateFor, place, dropRole,
};
