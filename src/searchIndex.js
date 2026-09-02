'use strict';

// ── FTS5 full-text search index for messages (search-overhaul phase 2) ──────
// messages_fts is an external-content FTS5 table shadowing messages.content,
// kept in sync by three triggers. messages is the source of truth; the index
// is disposable, so switching tokenizers just drops and rebuilds it (lossless).
//
// The tokenizer is admin-selected via HAVEN_SEARCH_TOKENIZER and reconciled at
// boot: no-op when the live table already matches, otherwise a clean rebuild.
// ensureSearchIndex() runs synchronously during DB init, before the server
// listens, so search is never served from a half-built index.

const VALID_TOKENIZERS = ['trigram', 'unicode61', 'porter'];
const DEFAULT_TOKENIZER = 'unicode61';

// FTS5 tokenize= clause per option. porter layers stemming over unicode61.
const TOKENIZE_CLAUSE = {
  trigram:   'trigram',
  unicode61: 'unicode61',
  porter:    'porter unicode61',
};

let activeTokenizer = DEFAULT_TOKENIZER;

function getConfiguredTokenizer() {
  const raw = (process.env.HAVEN_SEARCH_TOKENIZER || '').trim().toLowerCase();
  if (!raw) return DEFAULT_TOKENIZER;
  if (VALID_TOKENIZERS.includes(raw)) return raw;
  console.warn(`[search] Unknown HAVEN_SEARCH_TOKENIZER "${raw}", falling back to "${DEFAULT_TOKENIZER}". Valid options: ${VALID_TOKENIZERS.join(', ')}.`);
  return DEFAULT_TOKENIZER;
}

function getActiveTokenizer() { return activeTokenizer; }

// Minimum query length that can match. Trigram indexes 3-char sequences, so it
// cannot substring-match shorter queries; word tokenizers are fine at 2.
function minQueryChars(tokenizer = activeTokenizer) {
  return tokenizer === 'trigram' ? 3 : 2;
}

// Turn free-text into a safe FTS5 MATCH expression. Every term is wrapped in
// double quotes (internal quotes doubled) so user input can never inject FTS
// syntax. Word tokenizers get a trailing * for prefix matching ("app" -> apple);
// trigram already matches substrings so it needs none.
function buildMatchQuery(text, tokenizer = activeTokenizer) {
  const terms = String(text || '')
    .split(/\s+/)
    .filter(Boolean)
    .map(term => '"' + term.replace(/"/g, '""') + '"');
  if (!terms.length) return null;
  if (tokenizer === 'trigram') return terms.join(' ');
  return terms.map(term => term + '*').join(' ');
}

// Read the tokenizer the live messages_fts table was built with, straight from
// its stored DDL (authoritative; a settings row could drift). null = no table.
function detectExistingTokenizer(db) {
  const row = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'messages_fts'"
  ).get();
  if (!row || !row.sql) return null;
  const m = row.sql.match(/tokenize\s*=\s*'([^']*)'/i);
  if (!m) return 'unicode61'; // FTS5 default when tokenize= is omitted
  const clause = m[1].trim().toLowerCase();
  if (clause.startsWith('trigram')) return 'trigram';
  if (clause.startsWith('porter'))  return 'porter';
  return 'unicode61';
}

function dropIndex(db) {
  db.exec(`
    DROP TRIGGER IF EXISTS messages_ai;
    DROP TRIGGER IF EXISTS messages_ad;
    DROP TRIGGER IF EXISTS messages_au;
    DROP TABLE IF EXISTS messages_fts;
  `);
}

function createIndex(db, tokenizer) {
  const clause = TOKENIZE_CLAUSE[tokenizer] || TOKENIZE_CLAUSE[DEFAULT_TOKENIZER];
  db.exec(`
    CREATE VIRTUAL TABLE messages_fts USING fts5(
      content,
      content='messages',
      content_rowid='id',
      tokenize='${clause}'
    );
    CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
    END;
    CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
    END;
    CREATE TRIGGER messages_au AFTER UPDATE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
      INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
    END;
  `);
}

// Reconcile the on-disk index with the configured tokenizer. Safe to call every
// boot: no-op when correct, full drop + rebuild when missing or changed. The
// whole switch runs in one transaction, so an interrupted/restart-loop boot
// rolls back and simply retries next time. It cannot corrupt the DB.
function ensureSearchIndex(db) {
  const desired = getConfiguredTokenizer();
  activeTokenizer = desired;

  const existing = detectExistingTokenizer(db);
  console.log(`[search] Current tokenizer: "${existing || 'none'}" | configured: "${desired}".`);

  if (existing === desired) {
    console.log('[search] Tokenizer unchanged, no migration needed.');
    return;
  }

  console.log(`[search] Detected new tokenizer "${desired}", performing clean migration now....`);
  const t0 = Date.now();
  const migrate = db.transaction(() => {
    if (existing) dropIndex(db);
    createIndex(db, desired);
    db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild');");
  });
  migrate();
  const count = db.prepare('SELECT count(*) AS n FROM messages_fts').get().n;
  console.log(`[search] Index rebuilt with "${desired}" (${count} messages) in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
}

module.exports = {
  ensureSearchIndex,
  getActiveTokenizer,
  minQueryChars,
  buildMatchQuery,
  VALID_TOKENIZERS,
  DEFAULT_TOKENIZER,
};
