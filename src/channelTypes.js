'use strict';

// Channel types: a named set of Channel Functions with its own sidebar icon.
//
// An admin makes "Hangout 🎧" once (voice on, text off, ...) and sets channels
// to it. The channel takes the type's functions, and the sidebar shows the
// type's icon instead of a row of separate ones. The channel stays linked:
// editing the type changes every channel that has it. Changing one function on
// a channel by hand takes it out of its type, so the icon never claims
// something that is no longer true.

// The Channel Functions a type sets, in the order the editor shows them.
const FUNCTIONS = ['text', 'media', 'reactions', 'read_only', 'voice', 'streams', 'music', 'soundboard'];
const COLUMN = {
  text: 'text_enabled', media: 'media_enabled', reactions: 'reactions_enabled', read_only: 'read_only',
  voice: 'voice_enabled', streams: 'streams_enabled', music: 'music_enabled', soundboard: 'soundboard_enabled',
};
// These only work in voice, so a type with voice off has them off too.
const NEEDS_VOICE = ['streams', 'music', 'soundboard'];

const MAX_TYPES = 50;
const NAME_MAX = 32;
const ICON_MAX = 12; // an emoji or a short word, counted in characters

const SEED = [
  { name: 'Voice only', icon: '🔊', functions: { text: 0, media: 0, reactions: 1, read_only: 0, voice: 1, streams: 1, music: 1, soundboard: 1 } },
  { name: 'Text only', icon: '💬', functions: { text: 1, media: 1, reactions: 1, read_only: 0, voice: 0, streams: 0, music: 0, soundboard: 0 } },
  { name: 'Announcements', icon: '📢', functions: { text: 1, media: 1, reactions: 1, read_only: 1, voice: 0, streams: 0, music: 0, soundboard: 0 } },
];

function ensureChannelTypes(db) {
  const isNew = !db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'channel_types'").get();
  db.exec(`
    CREATE TABLE IF NOT EXISTS channel_types (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      icon       TEXT NOT NULL,
      functions  TEXT NOT NULL,
      position   INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  if (!db.prepare('PRAGMA table_info(channels)').all().some(c => c.name === 'type_id')) {
    db.exec('ALTER TABLE channels ADD COLUMN type_id INTEGER DEFAULT NULL');
  }
  // A few to start from, only on the first run, so deleting them sticks.
  if (isNew) {
    const insert = db.prepare('INSERT INTO channel_types (name, icon, functions, position) VALUES (?, ?, ?, ?)');
    SEED.forEach((s, i) => insert.run(s.name, s.icon, JSON.stringify(s.functions), i));
  }
}

const chars = (s) => [...s].length;

// The functions object a type stores: every function present, 0 or 1, and the
// voice-only ones off when voice is.
function normalizeFunctions(input) {
  const out = {};
  for (const fn of FUNCTIONS) out[fn] = input && input[fn] ? 1 : 0;
  if (!out.voice) for (const fn of NEEDS_VOICE) out[fn] = 0;
  return out;
}

// { name, icon, functions } from what a client sent, or { error }.
function normalizeType(data) {
  if (!data || typeof data !== 'object') return { error: 'Invalid channel type' };
  const name = typeof data.name === 'string' ? data.name.trim().replace(/\s+/g, ' ') : '';
  const icon = typeof data.icon === 'string' ? data.icon.trim() : '';
  if (!name) return { error: 'Give the type a name' };
  if (chars(name) > NAME_MAX) return { error: `The name can be at most ${NAME_MAX} characters` };
  if (!icon) return { error: 'Pick an icon for the sidebar' };
  if (chars(icon) > ICON_MAX) return { error: `The icon can be at most ${ICON_MAX} characters` };
  if (/[\u0000-\u001f\u007f]/.test(name + icon)) return { error: 'Invalid characters' };
  return { name, icon, functions: normalizeFunctions(data.functions) };
}

function parseRow(row) {
  let functions = {};
  try { functions = JSON.parse(row.functions); } catch (err) { console.warn('[channelTypes] unreadable functions for type', row.id, err.message); }
  return { id: row.id, name: row.name, icon: row.icon, functions: normalizeFunctions(functions) };
}

function listTypes(db) {
  const counts = new Map(db.prepare('SELECT type_id, COUNT(*) AS n FROM channels WHERE type_id IS NOT NULL AND is_dm = 0 GROUP BY type_id').all().map(r => [r.type_id, r.n]));
  return db.prepare('SELECT * FROM channel_types ORDER BY position, id').all()
    .map(row => ({ ...parseRow(row), channelCount: counts.get(row.id) || 0 }));
}

function getType(db, id) {
  const row = Number.isInteger(id) ? db.prepare('SELECT * FROM channel_types WHERE id = ?').get(id) : null;
  return row ? parseRow(row) : null;
}

// Which of the type's functions differ from the channel's, as [fn, value].
function changesFor(channel, functions) {
  return FUNCTIONS
    .map(fn => [fn, functions[fn]])
    .filter(([fn, value]) => (channel[COLUMN[fn]] ? 1 : 0) !== value);
}

module.exports = {
  FUNCTIONS, COLUMN, NEEDS_VOICE, MAX_TYPES, NAME_MAX, ICON_MAX,
  ensureChannelTypes, normalizeType, normalizeFunctions, listTypes, getType, changesFor,
};
