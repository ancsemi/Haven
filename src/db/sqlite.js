'use strict';

// SQLite's connection settings, statement cache and schema inspection live
// here so database.js can build Haven's schema through a selected driver.
// Legacy methods stay synchronous during the migration. The async facade
// gives converted callers real promises for get/all/run, including failures.
// SQLite work still runs on the main thread; a worker driver can come later.

const Database = require('better-sqlite3');
const path = require('path');

// ── Prepared-statement cache ──────────────────────────────
// Every `db.prepare(sql)` allocates a native sqlite3_stmt.  In
// socketHandlers.js the same queries are prepared on every socket event,
// creating hundreds of native objects that only get freed when V8 GC
// collects the JS wrapper.  Under load, GC can't keep up and Oilpan
// hits a fatal "large allocation" error.
//
// This cache wraps db.prepare() so duplicate SQL strings reuse the same
// Statement object.  Node.js is single-threaded, so concurrent access is
// not a concern.  Dynamic SQL (e.g. `IN (?,?,?)`) still works; each
// unique SQL string just gets its own cache entry.
const MAX_STMT_CACHE = 500;   // safety cap, shouldn't be hit in practice

// The usual reason Haven cannot open its database is file ownership: the data
// folder (or haven.db in it) belongs to another user than the one Haven runs
// as, for example after copying it in from another machine or starting Haven
// once outside its container. Say that plainly instead of a bare SQLite error.
function explainOpenFailure(err, filename) {
  const code = String(err && err.code || '');
  if (!/^SQLITE_(CANTOPEN|READONLY|PERM|AUTH)/.test(code) && err.code !== 'EACCES') return err;
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const who = uid === null ? 'the user Haven runs as' : `the user Haven runs as (uid ${uid})`;
  const e = new Error(
    `Haven cannot open its database at ${filename} (${code || err.message}). ` +
    `The folder ${path.dirname(filename)} and everything in it must be readable and writable by ${who}. ` +
    'If you copied the data in from elsewhere, or ran Haven outside its container, fix the owner of those files. ' +
    'In Docker or Podman, restarting the container fixes it when it can; otherwise run ' +
    '"chown -R 1000:1000 <data folder>" (Docker) or "podman unshare chown -R 1000:1000 <data folder>" (rootless Podman) on the host.'
  );
  e.cause = err;
  return e;
}

const quoteIdentifier = (name) => '"' + String(name).replace(/"/g, '""') + '"';

class SqliteDatabase extends Database {
  constructor(filename) {
    try {
      super(filename);
    } catch (err) {
      throw explainOpenFailure(err, filename);
    }
    this.kind = 'sqlite';
    // A statement belongs to its connection. Reopening a database must never
    // return a statement from a previous, closed connection.
    this._stmtCache = new Map();

    // Column names come from Haven's schema. Keep SQLite's NOCASE index
    // usable while PostgreSQL expresses the same comparison with LOWER().
    this.sql = { caseInsensitiveEqual: column => `${quoteIdentifier(column)} = ? COLLATE NOCASE` };

    // Keep one connection and cache for both interfaces, so awaited reads see
    // the same data as legacy writes. Prepare inside each async method so
    // preparation errors are promise rejections too. Transactions stay on
    // the legacy interface until async transaction isolation is implemented.
    this.async = {
      kind: this.kind,
      sql: this.sql,
      prepare: (sql) => ({
        get: async (...params) => this.prepare(sql).get(...params),
        all: async (...params) => this.prepare(sql).all(...params),
        run: async (...params) => this.prepare(sql).run(...params),
      }),
    };

    try {
      // ── Performance settings (memory-conscious) ────────────
      // These were originally set much higher (64 MB cache, 256 MB mmap) which
      // combined to reserve ~320 MB of native memory for SQLite alone.  On the
      // Haven Desktop machine that also runs Electron + a renderer, that left
      // too little headroom and caused the Oilpan OOM crash.
      this.pragma('journal_mode = WAL');
      this.pragma('foreign_keys = ON');
      this.pragma('synchronous = NORMAL');       // safe with WAL, 2-3x faster writes
      this.pragma('cache_size = -8000');          // 8 MB page cache (was 64 MB, overkill for a chat app)
      this.pragma('busy_timeout = 5000');         // wait up to 5 s on lock contention
      this.pragma('temp_store = MEMORY');         // keep temp tables in RAM
      // Deleted rows are overwritten with zeros instead of lingering in the file
      // until the space is reused, so deleted messages cannot be read back out of
      // haven.db with a text editor (#5699).
      this.pragma('secure_delete = ON');
      this.pragma('mmap_size = 33554432');        // 32 MB memory-mapped I/O (was 256 MB)

      // Hard-cap SQLite's own heap usage so it can never run away
      this.pragma('soft_heap_limit = 33554432');  // 32 MB soft limit; SQLite tries to stay under
      this.pragma('hard_heap_limit = 67108864');  // 64 MB hard ceiling
    } catch (err) {
      this.close();
      throw explainOpenFailure(err, filename);
    }
  }

  // ── Statement cache: intercept db.prepare() ──────────
  prepare(sql) {
    let stmt = this._stmtCache.get(sql);
    if (stmt) return stmt;
    // Safety cap: if cache grows too large (dynamic SQL), clear older entries
    if (this._stmtCache.size >= MAX_STMT_CACHE) {
      // Remove oldest ~half of entries
      const keys = [...this._stmtCache.keys()];
      for (let i = 0; i < keys.length / 2; i++) this._stmtCache.delete(keys[i]);
    }
    stmt = super.prepare(sql);
    this._stmtCache.set(sql, stmt);
    return stmt;
  }

  hasTable(table) {
    return !!this.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  }

  // ── Bringing an older database up to date ──────────────
  // A server that updates keeps its database and gains whatever columns the
  // new version adds. Ask SQLite what a table already has rather than running
  // a query and treating any error as "column missing": that way a real
  // failure stops startup with a clear message instead of being mistaken for
  // a column that is already there.
  hasColumn(table, column) {
    return this.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all().some(c => c.name === column);
  }

  // Definitions come from Haven's schema, never from user input.
  // Adds the column when it is missing. True when it was added, so a step
  // that also fills in existing rows can run only that once.
  addColumn(table, column, definition) {
    if (this.hasColumn(table, column)) return false;
    try {
      this.exec(`ALTER TABLE ${quoteIdentifier(table)} ADD COLUMN ${quoteIdentifier(column)} ${definition}`);
    } catch (err) {
      throw new Error(`Database upgrade failed while adding ${table}.${column}: ${err.message}`);
    }
    return true;
  }

  close() {
    this._stmtCache.clear();
    return super.close();
  }
}

module.exports = { SqliteDatabase };
