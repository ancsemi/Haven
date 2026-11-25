'use strict';

// Docs channels: a channel with is_docs set holds documents instead of a
// message log. A document is a title and a body written in the same Markdown
// as messages, kept as one current version. Its author edits it; with
// "shared" on, everyone who may post in the channel can edit it too.
//
// Every save names the version it started from. A save that started from an
// older version than the stored one is refused as a conflict and handed the
// stored document, so two people writing at once never silently overwrite
// each other; the second chooses what to keep.

// Socket messages are capped at 64 KB (server.js), so a body is kept under
// that once JSON-encoded, whatever its characters.
const LIMITS = { title: 120, body: 50000, bytes: 63000 };
const MAX_PER_CHANNEL = 500;

function ensureTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS docs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      shared INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 1,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_docs_channel ON docs(channel_id);
  `);
}

// Checks a document sent by a client. For an edit, `base` is the stored row
// and a field left out keeps its value. Returns { doc } or { error }.
function parseDoc(input, base = null) {
  if (!input || typeof input !== 'object') return { error: 'Invalid document' };
  const has = (k) => Object.prototype.hasOwnProperty.call(input, k);
  const title = has('title') ? input.title : (base ? base.title : undefined);
  const body = has('body') ? input.body : (base ? base.body : '');
  if (typeof title !== 'string' || !title.trim()) return { error: 'Give the document a title' };
  if (title.trim().length > LIMITS.title) return { error: `Titles can be up to ${LIMITS.title} characters` };
  if (body !== null && body !== undefined && typeof body !== 'string') return { error: 'Invalid document' };
  const text = (body || '').replace(/\r\n?/g, '\n');
  if (text.length > LIMITS.body) return { error: `A document can be up to ${LIMITS.body.toLocaleString('en-US')} characters` };
  if (Buffer.byteLength(JSON.stringify(text)) > LIMITS.bytes) return { error: 'This document is too large to save in one piece. Split it into two documents.' };
  const shared = has('shared') ? !!input.shared : (base ? !!base.shared : false);
  return { doc: { title: title.trim(), body: text.replace(/\s+$/, ''), shared } };
}

const COLS = `d.*, c.username AS creator_username, c.display_name AS creator_display_name,
  e.username AS editor_username, e.display_name AS editor_display_name`;
const FROM = 'FROM docs d LEFT JOIN users c ON c.id = d.created_by LEFT JOIN users e ON e.id = d.updated_by';

// Words are runs of non-space holding a letter or digit, so Markdown marks
// such as "#" or "-" do not count.
const words = (text) => (text.match(/\S+/g) || []).filter(w => /[\p{L}\p{N}]/u.test(w)).length;

// What a client sees. Lists leave the body out; one document carries it.
function shape(row, withBody) {
  const out = {
    id: row.id,
    title: row.title,
    shared: !!row.shared,
    version: row.version,
    words: words(row.body || ''),
    createdBy: row.created_by,
    creatorName: row.creator_display_name || row.creator_username || null,
    updatedBy: row.updated_by,
    editorName: row.editor_display_name || row.editor_username || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (withBody) out.body = row.body || '';
  return out;
}

function getRow(db, id) {
  return Number.isInteger(id) && id > 0 ? db.prepare('SELECT * FROM docs WHERE id = ?').get(id) || null : null;
}

function getDoc(db, id) {
  const row = db.prepare(`SELECT ${COLS} ${FROM} WHERE d.id = ?`).get(id);
  return row ? shape(row, true) : null;
}

// A channel's documents, most recently changed first.
function list(db, channelId) {
  return db.prepare(`SELECT ${COLS} ${FROM} WHERE d.channel_id = ? ORDER BY d.updated_at DESC, d.id DESC`)
    .all(channelId).map(r => shape(r, false));
}

function createDoc(db, channelId, userId, doc) {
  const n = db.prepare('SELECT COUNT(*) AS n FROM docs WHERE channel_id = ?').get(channelId).n;
  if (n >= MAX_PER_CHANNEL) return { error: `A channel can hold up to ${MAX_PER_CHANNEL} documents` };
  const r = db.prepare(`INSERT INTO docs (channel_id, title, body, shared, created_by, updated_by)
    VALUES (?, ?, ?, ?, ?, ?)`).run(channelId, doc.title, doc.body, doc.shared ? 1 : 0, userId, userId);
  return { id: Number(r.lastInsertRowid) };
}

// Saves over version `from`. Returns { ok } or { conflict } when someone
// saved a newer version first.
function updateDoc(db, id, userId, doc, from) {
  const r = db.prepare(`UPDATE docs SET title = ?, body = ?, shared = ?, updated_by = ?, version = version + 1,
    updated_at = CURRENT_TIMESTAMP WHERE id = ? AND version = ?`).run(doc.title, doc.body, doc.shared ? 1 : 0, userId, id, from);
  return r.changes ? { ok: true } : { conflict: true };
}

function removeDoc(db, id) {
  db.prepare('DELETE FROM docs WHERE id = ?').run(id);
}

module.exports = { LIMITS, MAX_PER_CHANNEL, ensureTables, parseDoc, getRow, getDoc, list, createDoc, updateDoc, removeDoc };
