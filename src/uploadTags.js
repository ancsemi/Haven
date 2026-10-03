'use strict';

// ── Upload tagging (attachment tags) ────────────────────────────────────────
// A GLOBAL, server-wide tag vocabulary that users attach to file/image uploads
// at send time. Distinct from the per-channel forum-topic tags (channels.
// forum_tags + messages.tags JSON) — those are a different feature that happens
// to share the word "tag".
//
//   upload_tags       — the vocabulary (one row per distinct tag name)
//   attachment_tags   — the association (message + file → tag)
//
// Applying an existing tag is open to any uploader; minting a NEW tag is gated
// by the manage_tags permission (enforced by the caller via `canCreate`). New
// tags are committed here on message send (get-or-create by normalized name),
// never speculatively from the composer — an abandoned draft leaves no orphans.

// Defaults, plus the hard technical ceilings the admin setting is clamped to.
// The live values come from server_settings (max_tags_per_attachment,
// max_tag_len) via effectiveLimits(); these are the fallbacks and bounds.
const MAX_TAG_LEN = 20;          // default; hard ceiling for the admin setting
const MAX_TAG_LEN_CEIL = 50;
const MAX_TAGS_PER_ATTACHMENT = 3;    // default; hard ceiling for the setting
const MAX_TAGS_CEIL = 10;

// Read the admin-configured limits from server_settings, clamped to the ceilings
// above and falling back to the defaults. Tolerant: a missing table or bad value
// yields the defaults so tagging never breaks on a partial/old DB.
function clampInt(raw, lo, hi, def) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(lo, Math.min(hi, n));
}
function effectiveLimits(db) {
  let maxTags = MAX_TAGS_PER_ATTACHMENT, maxLen = MAX_TAG_LEN;
  try {
    const get = db.prepare('SELECT value FROM server_settings WHERE key = ?');
    maxTags = clampInt(get.get('max_tags_per_attachment')?.value, 1, MAX_TAGS_CEIL, MAX_TAGS_PER_ATTACHMENT);
    maxLen  = clampInt(get.get('max_tag_len')?.value, 1, MAX_TAG_LEN_CEIL, MAX_TAG_LEN);
  } catch { /* keep defaults */ }
  return { maxTags, maxLen };
}

// Letters (any script), digits, space, hyphen, underscore. Everything else —
// control chars, punctuation, emoji — is rejected so tags stay clean, terse and
// reusable. Display keeps the user's casing; matching/dedupe is case-folded.
const TAG_CHARS = /^[\p{L}\p{N} _-]+$/u;

// Normalize a raw tag string into { name, norm } or null when it can't be a
// valid tag. `name` is the trimmed, whitespace-collapsed display form; `norm`
// is its case-folded key used for uniqueness and lookup.
function normalizeTagName(raw, maxLen = MAX_TAG_LEN) {
  if (typeof raw !== 'string') return null;
  const name = raw.trim().replace(/\s+/g, ' ');
  if (!name || name.length > maxLen) return null;
  if (!TAG_CHARS.test(name)) return null;
  return { name, norm: name.toLocaleLowerCase() };
}

// Pull the first /uploads/<file> path out of a message body. Attachment
// messages carry exactly one — either a bare image URL or a [file:name](url|
// size) wrapper — so the first match identifies the file being tagged.
function extractUploadPath(content) {
  const m = String(content || '').match(/\/uploads\/[^\s)|"'<>]+/);
  return m ? m[0] : null;
}

// Escape LIKE wildcards so a query of "50%" or "a_b" matches literally.
function escapeLike(s) {
  return String(s).replace(/[\\%_]/g, ch => '\\' + ch);
}

// Search the vocabulary for the composer's tag picker. Returns [{ id, name }].
// An empty query browses the whole vocabulary (the picker lists everything when
// it first opens); a non-empty one is a prefix match, which stays on the UNIQUE
// index and cheap. Both are capped so a huge vocabulary can't flood the popup.
function searchTags(db, query, limit = 50) {
  const lim = Math.max(1, Math.min(100, limit | 0));
  const raw = String(query || '').trim();
  if (!raw) {
    return db.prepare('SELECT id, name FROM upload_tags ORDER BY name_norm LIMIT ?').all(lim);
  }
  const norm = normalizeTagName(raw);
  if (!norm) return [];
  return db.prepare(
    `SELECT id, name FROM upload_tags
      WHERE name_norm LIKE ? ESCAPE '\\'
      ORDER BY name_norm LIMIT ?`
  ).all(escapeLike(norm.norm) + '%', lim);
}

// Attach `tagNames` to the file `content` carries, writing attachment_tags rows
// for the given message. Existing tags are reused; unknown names are minted only
// when `canCreate` is true (manage_tags) and otherwise silently dropped. Invalid
// names are skipped; the list is deduped and capped. One transaction; tolerant
// by design — the caller treats tagging as non-critical and never fails a send
// over it. Returns the applied tag names.
// Normalize, dedupe (by case-folded key, first-seen order) and cap a raw tag
// name list into [{ name, norm }]. Shared by the send-time and edit-time paths.
function pickTags(tagNames, { maxTags = MAX_TAGS_PER_ATTACHMENT, maxLen = MAX_TAG_LEN } = {}) {
  const seen = new Set();
  const picked = [];
  for (const raw of Array.isArray(tagNames) ? tagNames : []) {
    const norm = normalizeTagName(raw, maxLen);
    if (!norm || seen.has(norm.norm)) continue;
    seen.add(norm.norm);
    picked.push(norm);
    if (picked.length >= maxTags) break;
  }
  return picked;
}

// Resolve `picked` tags to ids (minting unknown ones only when canCreate) and
// link each to (messageId, relPath). Existing links are left alone (OR IGNORE).
// Caller owns the transaction. Returns the applied display names.
function linkPickedTags(db, { messageId, relPath, picked, userId, canCreate }) {
  const findTag   = db.prepare('SELECT id FROM upload_tags WHERE name_norm = ?');
  const insertTag = db.prepare('INSERT INTO upload_tags (name, name_norm, created_by) VALUES (?, ?, ?)');
  const linkTag   = db.prepare('INSERT OR IGNORE INTO attachment_tags (message_id, rel_path, tag_id) VALUES (?, ?, ?)');
  const applied = [];
  for (const { name, norm } of picked) {
    let row = findTag.get(norm);
    if (!row) {
      if (!canCreate) continue;   // applying is open; creating needs manage_tags
      const res = insertTag.run(name, norm, userId || null);
      row = { id: res.lastInsertRowid };
    }
    linkTag.run(messageId, relPath, row.id);
    applied.push(name);
  }
  return applied;
}

function applyTagsToMessage(db, { messageId, content, tagNames, userId, canCreate, maxTags, maxLen }) {
  const relPath = extractUploadPath(content);
  if (!relPath || !Array.isArray(tagNames) || !tagNames.length) return [];
  const picked = pickTags(tagNames, { maxTags, maxLen });
  if (!picked.length) return [];
  let applied = [];
  db.transaction(() => {
    applied = linkPickedTags(db, { messageId, relPath, picked, userId, canCreate });
  })();
  return applied;
}

// Replace the full tag set on a message's attachment (retroactive edit). Unlike
// applyTagsToMessage this is not additive: it clears the message's existing
// links first, so an empty list removes every tag. Returns the applied names.
function setMessageTags(db, { messageId, content, tagNames, userId, canCreate, maxTags, maxLen }) {
  const relPath = extractUploadPath(content);
  if (!relPath) return [];
  const picked = pickTags(tagNames, { maxTags, maxLen });
  let applied = [];
  db.transaction(() => {
    db.prepare('DELETE FROM attachment_tags WHERE message_id = ?').run(messageId);
    applied = linkPickedTags(db, { messageId, relPath, picked, userId, canCreate });
  })();
  return applied;
}

// ── Admin tag management (Phase 4) ──────────────────────────────────────────
// The admin Tags panel manages the vocabulary directly: add a tag, rename it, or
// delete it. Rename and delete are HARD and destructive by decision (no soft
// delete) — they propagate to every attachment through the tag_id the
// association carries. messageTargetsForTag is the shared iteration both use to
// tell the caller which messages changed, so it can rebroadcast live footers.

// The full vocabulary with a usage count per tag, for the management list.
function listAllTags(db) {
  return db.prepare(
    `SELECT ut.id, ut.name, COUNT(at.tag_id) AS uses
       FROM upload_tags ut
       LEFT JOIN attachment_tags at ON at.tag_id = ut.id
      GROUP BY ut.id
      ORDER BY ut.name_norm`
  ).all();
}

// Every message that carries a given tag, with its channel code — the shared
// "iterate the attachments list" step behind rename and delete. Collected
// BEFORE the mutation so the caller can recompute and rebroadcast those
// messages' footers afterwards.
function messageTargetsForTag(db, tagId) {
  return db.prepare(
    `SELECT DISTINCT at.message_id AS messageId, c.code AS channelCode
       FROM attachment_tags at
       JOIN messages m ON m.id = at.message_id
       JOIN channels c ON c.id = m.channel_id
      WHERE at.tag_id = ?`
  ).all(tagId);
}

// Mint a vocabulary entry from the admin panel. get-or-create by normalized
// name: returns { error:'invalid' } for a bad name, { error:'exists', id, name }
// if it already exists, else { id, name }.
function createTag(db, { name, userId, maxLen = MAX_TAG_LEN }) {
  const norm = normalizeTagName(name, maxLen);
  if (!norm) return { error: 'invalid' };
  const existing = db.prepare('SELECT id, name FROM upload_tags WHERE name_norm = ?').get(norm.norm);
  if (existing) return { error: 'exists', id: existing.id, name: existing.name };
  const res = db.prepare(
    'INSERT INTO upload_tags (name, name_norm, created_by) VALUES (?, ?, ?)'
  ).run(norm.name, norm.norm, userId || null);
  return { id: res.lastInsertRowid, name: norm.name };
}

// Rename a tag in place. A rename whose normalized form collides with a
// DIFFERENT existing tag is a MERGE: this tag's links are repointed onto the
// existing one (deduped) and this tag row is dropped, so no duplicate vocabulary
// entry is created. Returns { ok, merged, targets } (targets = affected messages
// gathered before the change) or { error }.
function renameTag(db, { tagId, newName, maxLen = MAX_TAG_LEN }) {
  const tag = db.prepare('SELECT id, name, name_norm FROM upload_tags WHERE id = ?').get(tagId);
  if (!tag) return { error: 'not_found' };
  const norm = normalizeTagName(newName, maxLen);
  if (!norm) return { error: 'invalid' };

  // Same key (only a casing/spacing change): just update the display name.
  if (norm.norm === tag.name_norm) {
    if (norm.name !== tag.name) {
      db.prepare('UPDATE upload_tags SET name = ? WHERE id = ?').run(norm.name, tag.id);
    }
    return { ok: true, merged: false, targets: messageTargetsForTag(db, tag.id) };
  }

  const targets = messageTargetsForTag(db, tag.id);
  const collision = db.prepare('SELECT id FROM upload_tags WHERE name_norm = ? AND id != ?').get(norm.norm, tag.id);
  db.transaction(() => {
    if (collision) {
      // Repoint links onto the surviving tag; OR IGNORE drops rows that would
      // duplicate an existing (message, file, tag) association, and the follow-up
      // delete clears those skipped leftovers. Then retire this tag.
      db.prepare('UPDATE OR IGNORE attachment_tags SET tag_id = ? WHERE tag_id = ?').run(collision.id, tag.id);
      db.prepare('DELETE FROM attachment_tags WHERE tag_id = ?').run(tag.id);
      db.prepare('DELETE FROM upload_tags WHERE id = ?').run(tag.id);
    } else {
      db.prepare('UPDATE upload_tags SET name = ?, name_norm = ? WHERE id = ?').run(norm.name, norm.norm, tag.id);
    }
  })();
  return { ok: true, merged: !!collision, targets };
}

// Hard-delete a tag and every attachment association it has. Returns
// { ok, targets } (affected messages, gathered before deletion) or { error }.
function deleteTag(db, { tagId }) {
  const tag = db.prepare('SELECT id FROM upload_tags WHERE id = ?').get(tagId);
  if (!tag) return { error: 'not_found' };
  const targets = messageTargetsForTag(db, tag.id);
  db.transaction(() => {
    db.prepare('DELETE FROM attachment_tags WHERE tag_id = ?').run(tag.id);
    db.prepare('DELETE FROM upload_tags WHERE id = ?').run(tag.id);
  })();
  return { ok: true, targets };
}

module.exports = {
  MAX_TAG_LEN,
  MAX_TAG_LEN_CEIL,
  MAX_TAGS_PER_ATTACHMENT,
  MAX_TAGS_CEIL,
  effectiveLimits,
  normalizeTagName,
  extractUploadPath,
  escapeLike,
  searchTags,
  applyTagsToMessage,
  setMessageTags,
  listAllTags,
  messageTargetsForTag,
  createTag,
  renameTag,
  deleteTag,
};
