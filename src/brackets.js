'use strict';

// Bracket channels: a channel with is_bracket set shows single-elimination
// tournaments instead of a message log. A bracket stores its entrants in seed
// order and the results reported so far. Who meets whom is worked out from
// those two, so a bracket never stores a match that could disagree with them.
//
// Seeds pair the usual way (1 v 16, 8 v 9, ... in a field of 16), so the top
// two seeds can only meet in the final. A field that is not a power of two
// gets byes, which go to the top seeds and move them on without a match.
//
// Matches are named by round (0 is the first) and slot (0 is the top). A
// result is { winner, note }: winner 0 is the upper side of the match. A
// result can change or be cleared only while the match it feeds is still
// undecided, so a later result never rests on one that moved under it.

const LIMITS = { title: 100, description: 1000, entrant: 60, note: 60, minEntrants: 2, maxEntrants: 64 };
const MAX_PER_CHANNEL = 200;
const BYE = -1;

function ensureTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS brackets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      entrants TEXT NOT NULL,
      results TEXT NOT NULL DEFAULT '{}',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_brackets_channel ON brackets(channel_id);
  `);
}

// Seed numbers, top to bottom of the first round, for a field of `size` (a
// power of two). Each step mirrors the seeds so every pair adds up the same.
function seedOrder(size) {
  let order = [1];
  while (order.length < size) {
    const sum = order.length * 2 + 1;
    order = order.flatMap(s => [s, sum - s]);
  }
  return order;
}

// Every round's matches. A side is an entrant's index, BYE, or null while the
// match that feeds it is undecided. A bye match moves its entrant on.
function layout(count, results) {
  let size = 2;
  while (size < count) size *= 2;
  let feed = seedOrder(size).map(s => (s <= count ? s - 1 : BYE));
  const rounds = [];
  for (let r = 0; feed.length > 1; r++) {
    const round = [];
    const next = [];
    for (let i = 0; i < feed.length / 2; i++) {
      const sides = [feed[2 * i], feed[2 * i + 1]];
      const bye = sides.includes(BYE);
      const ready = !bye && sides[0] !== null && sides[1] !== null;
      const res = ready ? results[`${r}:${i}`] : null;
      const winner = bye ? (sides[0] === BYE ? 1 : 0) : (res ? res.winner : null);
      round.push({ round: r, slot: i, sides, winner, note: (res && res.note) || '', bye });
      next.push(winner === null ? null : sides[winner]);
    }
    rounds.push(round);
    feed = next;
  }
  return { rounds, champion: feed[0] };
}

const blank = (v) => v === undefined || v === null || v === '';
const parseJson = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };
const hasResults = (row) => Object.keys(parseJson(row.results, {})).length > 0;

// Checks a bracket sent by a client. For an edit, `base` is the stored row and
// any field left out keeps its value. Returns { bracket } in column form, or
// { error } with a message to show.
function parseBracket(input, base = null) {
  if (!input || typeof input !== 'object') return { error: 'Invalid bracket' };
  const has = (k) => Object.prototype.hasOwnProperty.call(input, k);
  const title = has('title') ? input.title : (base ? base.title : undefined);
  if (typeof title !== 'string' || !title.trim()) return { error: 'Give the bracket a name' };
  if (title.trim().length > LIMITS.title) return { error: `Names can be up to ${LIMITS.title} characters` };
  const description = has('description') ? input.description : (base ? base.description : '');
  if (!blank(description) && (typeof description !== 'string' || description.length > LIMITS.description)) {
    return { error: `Details can be up to ${LIMITS.description} characters` };
  }
  const entrants = has('entrants') ? input.entrants : (base ? parseJson(base.entrants, []) : undefined);
  if (!Array.isArray(entrants) || entrants.some(e => typeof e !== 'string')) return { error: 'List the entrants' };
  const names = entrants.map(e => e.trim());
  if (names.length < LIMITS.minEntrants) return { error: `A bracket needs at least ${LIMITS.minEntrants} entrants` };
  if (names.length > LIMITS.maxEntrants) return { error: `A bracket can have up to ${LIMITS.maxEntrants} entrants` };
  if (names.some(n => !n)) return { error: 'Every entrant needs a name' };
  if (names.some(n => n.length > LIMITS.entrant)) return { error: `Entrant names can be up to ${LIMITS.entrant} characters` };
  // Results belong to places in the bracket. Renaming keeps them; a different
  // field size would move every match, so it waits for the results to go.
  if (base && hasResults(base) && names.length !== parseJson(base.entrants, []).length) {
    return { error: 'Clear the results before changing how many entrants there are' };
  }
  return { bracket: { title: title.trim(), description: blank(description) ? '' : description.trim(), entrants: names } };
}

const COLS = `b.*, u.username AS creator_username, u.display_name AS creator_display_name`;

// What a client sees: the stored fields plus every match, worked out.
function shape(row) {
  const entrants = parseJson(row.entrants, []);
  const { rounds, champion } = layout(entrants.length, parseJson(row.results, {}));
  return {
    id: row.id,
    title: row.title,
    description: row.description || '',
    entrants,
    rounds,
    champion: champion === undefined || champion === null ? null : champion,
    createdBy: row.created_by,
    creatorName: row.creator_display_name || row.creator_username || null,
    updatedAt: row.updated_at,
  };
}

// A channel's brackets, newest first.
function list(db, channelId) {
  return db.prepare(`SELECT ${COLS} FROM brackets b LEFT JOIN users u ON u.id = b.created_by
    WHERE b.channel_id = ? ORDER BY b.id DESC LIMIT ${MAX_PER_CHANNEL}`).all(channelId).map(shape);
}

function getRow(db, id) {
  return db.prepare('SELECT * FROM brackets WHERE id = ?').get(id) || null;
}

function getBracket(db, id) {
  const row = db.prepare(`SELECT ${COLS} FROM brackets b LEFT JOIN users u ON u.id = b.created_by WHERE b.id = ?`).get(id);
  return row ? shape(row) : null;
}

function createBracket(db, channelId, userId, b) {
  const n = db.prepare('SELECT COUNT(*) AS n FROM brackets WHERE channel_id = ?').get(channelId).n;
  if (n >= MAX_PER_CHANNEL) return { error: 'This channel has as many brackets as it can hold. Delete an old one first' };
  const r = db.prepare('INSERT INTO brackets (channel_id, created_by, title, description, entrants) VALUES (?, ?, ?, ?, ?)')
    .run(channelId, userId, b.title, b.description, JSON.stringify(b.entrants));
  return { id: Number(r.lastInsertRowid) };
}

function updateBracket(db, id, b) {
  db.prepare('UPDATE brackets SET title = ?, description = ?, entrants = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(b.title, b.description, JSON.stringify(b.entrants), id);
}

function deleteBracket(db, id) {
  db.prepare('DELETE FROM brackets WHERE id = ?').run(id);
}

// Checks a result sent by a client: { round, slot, winner: 0 | 1 | null, note }.
// null clears the result.
function parseResult(input) {
  if (!input || typeof input !== 'object') return { error: 'Invalid result' };
  const { round, slot, winner } = input;
  if (!Number.isInteger(round) || round < 0 || !Number.isInteger(slot) || slot < 0) return { error: 'Match not found' };
  if (winner !== null && winner !== 0 && winner !== 1) return { error: 'Pick a winner' };
  const note = blank(input.note) ? '' : input.note;
  if (typeof note !== 'string' || note.trim().length > LIMITS.note) return { error: `Notes can be up to ${LIMITS.note} characters` };
  return { result: { round, slot, winner, note: winner === null ? '' : note.trim() } };
}

// Records, changes or clears a match result. Returns { error } when the match
// cannot take it.
function setResult(db, row, res) {
  const results = parseJson(row.results, {});
  const { rounds } = layout(parseJson(row.entrants, []).length, results);
  const match = rounds[res.round] && rounds[res.round][res.slot];
  if (!match) return { error: 'Match not found' };
  if (match.bye) return { error: 'That entrant has a bye' };
  if (match.sides.includes(null)) return { error: 'That match is still waiting for its entrants' };
  const next = rounds[res.round + 1] && rounds[res.round + 1][res.slot >> 1];
  if (res.winner !== match.winner && next && next.winner !== null) {
    return { error: 'The next match already has a result. Clear that one first' };
  }
  const key = `${res.round}:${res.slot}`;
  if (res.winner === null) delete results[key];
  else results[key] = res.note ? { winner: res.winner, note: res.note } : { winner: res.winner };
  db.prepare('UPDATE brackets SET results = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(JSON.stringify(results), row.id);
  return { ok: true };
}

module.exports = {
  LIMITS, BYE, ensureTables, seedOrder, layout, parseBracket, parseResult,
  list, getRow, getBracket, createBracket, updateBracket, deleteBracket, setResult,
};
