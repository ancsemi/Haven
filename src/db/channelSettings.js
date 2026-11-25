'use strict';

const { isString, sanitizeText } = require('../socketHandlers/helpers');

function roomForSettings(db, code, columns = '*') {
  const lock = db.kind === 'postgres' ? ' FOR NO KEY UPDATE' : '';
  return db.prepare(`SELECT ${columns} FROM channels WHERE code = ? AND is_dm = 0${lock}`).get(code);
}

// Column names come from the handlers' fixed settings mappings.
function updateRoomSettings(db, channelId, values) {
  const columns = Object.keys(values).map(column => column + ' = ?').join(', ');
  return db.prepare(`UPDATE channels SET ${columns} WHERE id = ?`).run(...Object.values(values), channelId);
}

function renameRoom(db, room, name) {
  // Old mentions still find the room (#5602). Keep the most recent names
  // first and drop a name when the room comes back to it.
  let former = [];
  try { former = JSON.parse(room.former_names || '[]'); } catch { /* start a new list */ }
  if (!Array.isArray(former)) former = [];
  former = [room.name, ...former]
    .filter((n, i, arr) => typeof n === 'string' && n && n.toLowerCase() !== name.toLowerCase() && arr.indexOf(n) === i)
    .slice(0, 10);
  return updateRoomSettings(db, room.id, { name, former_names: JSON.stringify(former) });
}

// Organize tags that differ only in case go under one heading.
function normalizeCategory(db, raw, ownId = 0) {
  const category = typeof raw === 'string' ? raw.trim().slice(0, 30) : '';
  if (!category) return null;
  const row = db.prepare(
    'SELECT category FROM channels WHERE category IS NOT NULL AND id != ? AND ' + db.sql.caseInsensitiveEqual('category')
  ).get(ownId, category);
  return db.kind === 'postgres' ? row.then(existing => existing?.category ?? category) : row?.category ?? category;
}

function roomTopic(value) {
  return isString(value, 0, 256) ? sanitizeText(value.trim()) : '';
}

function subchannelSortMode(data) {
  if (data.mode === 'alpha' || data.enabled === true) return 1;
  if (data.mode === 'created') return 2;
  if (data.mode === 'oldest') return 3;
  if (data.mode === 'dynamic') return 4;
  return 0;
}

function roomsForReorder(db, codes) {
  const pg = db.kind === 'postgres';
  const columns = pg ? 'id, code, role_gate, parent_channel_id' : 'parent_channel_id';
  const marks = codes.map(() => '?').join(',');
  // Lock in the same order when two editors move overlapping sets of rooms.
  const lock = pg ? ' ORDER BY id FOR NO KEY UPDATE' : '';
  return db.prepare(`SELECT ${columns} FROM channels WHERE code IN (${marks}) AND is_dm = 0${lock}`).all(...codes);
}

function roomPositionUpdate(db) {
  return db.prepare('UPDATE channels SET position = ? WHERE code = ?');
}

module.exports = {
  roomForSettings, updateRoomSettings, renameRoom, normalizeCategory, roomTopic, subchannelSortMode,
  roomsForReorder, roomPositionUpdate,
};
