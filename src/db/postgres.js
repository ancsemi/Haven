'use strict';

// Temporary migration adapter until all app calls support PostgreSQL. The
// SQLite compatibility bridge and preview startup guard can then be removed;
// pg stays an on-demand add-on selected by HAVEN_DATABASE_URL.
//
// It supports positional ? bindings, get/all/run and connection-pinned
// transactions. Full application support is still in progress; the opt-in
// browser preview initializes its own PostgreSQL schema.

// Translate only placeholders, leaving SQL strings, identifiers, comments
// and PostgreSQL dollar-quoted bodies alone. Values always go through pg's
// parameter binding; they are never interpolated into the SQL.
function compile(sql) {
  if (typeof sql !== 'string') throw new TypeError('SQL must be a string');
  let text = '';
  let count = 0;
  for (let i = 0; i < sql.length;) {
    const start = i;
    const c = sql[i];
    if (c === "'" || c === '"') {
      const escaped = c === "'" && /[eE]/.test(sql[i - 1] || '') && !/[\w$]/.test(sql[i - 2] || '');
      i++;
      let closed = false;
      while (i < sql.length) {
        if (escaped && sql[i] === '\\') { i += 2; continue; }
        if (sql[i++] === c) {
          if (sql[i] === c) { i++; continue; }
          closed = true;
          break;
        }
      }
      if (!closed) throw new Error('Unterminated SQL quote');
    } else if (sql.startsWith('--', i)) {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end + 1;
    } else if (sql.startsWith('/*', i)) {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth) {
        if (sql.startsWith('/*', i)) { depth++; i += 2; }
        else if (sql.startsWith('*/', i)) { depth--; i += 2; }
        else i++;
      }
      if (depth) throw new Error('Unterminated SQL comment');
    } else if (c === '$' && !/[\w$]/.test(sql[i - 1] || '') && /^\$(?:[A-Za-z_]\w*)?\$/.test(sql.slice(i))) {
      const tag = sql.slice(i).match(/^\$(?:[A-Za-z_]\w*)?\$/)[0];
      const end = sql.indexOf(tag, i + tag.length);
      if (end === -1) throw new Error('Unterminated SQL dollar quote');
      i = end + tag.length;
    } else if (c === '?') {
      text += '$' + (++count);
      i++;
      continue;
    } else if (c === '@' && /[A-Za-z_]/.test(sql[i + 1] || '')) {
      throw new Error('PostgreSQL named bindings are not supported yet; use positional ? parameters');
    } else {
      i++;
    }
    text += sql.slice(start, i);
  }
  return { text, count };
}

class PostgresDatabase {
  constructor({ url, pool } = {}) {
    this.kind = 'postgres';
    // Identifiers are schema-owned, not request values.
    this.sql = { caseInsensitiveEqual: column => `LOWER("${String(column).replace(/"/g, '""')}") = LOWER(?)` };
    this.async = this;
    if (!pool && !String(url || '').trim()) throw new Error('A PostgreSQL URL is required');
    this._url = url;
    // Like S3, selecting this backend installs its pinned client. An injected
    // pool lets tests exercise the adapter without installing anything.
    this._pg = pool ? null : require('./pgAddon').loadPg();
    this._pool = pool || null;
    this._closed = false;
    this._closing = null;
  }

  _getPool() {
    if (this._closed) throw new Error('The database connection is not open');
    if (!this._pool) {
      const { Pool, types } = this._pg;
      this._pool = new Pool({
        connectionString: this._url, max: 10, connectionTimeoutMillis: 5000,
        // Dates in the app are UTC strings, as on SQLite. pg's default Date
        // parser would reinterpret timestamp-without-zone in the host's zone.
        types: { getTypeParser: (oid, format) => oid === 1114 || oid === 1082 ? value => value : types.getTypeParser(oid, format) },
      });
      // An idle pool error must not crash the process. Report the code only;
      // connection strings can contain a password.
      this._pool.on('error', err => console.warn('[db] PostgreSQL idle connection failed:', err.code || 'connection error'));
    }
    return this._pool;
  }

  async _query(compiled, params) {
    if (this._closed) throw new Error('The database connection is not open');
    if (params.length !== compiled.count) {
      throw new Error(`Expected ${compiled.count} SQL parameters, got ${params.length}`);
    }
    const result = await this._getPool().query(compiled.text, params);
    if (Array.isArray(result)) throw new Error('PostgreSQL queries must contain a single statement');

    // pg returns int8 (ids and COUNT(*)) as strings. Keep the same numeric
    // rows SQLite callers receive, and refuse integers JS cannot represent.
    for (const field of result.fields || []) {
      if (field.dataTypeID !== 20) continue;
      for (const row of result.rows) {
        if (row[field.name] == null) continue;
        const n = Number(row[field.name]);
        if (!Number.isSafeInteger(n)) throw new Error('PostgreSQL integer exceeds JavaScript safe integer range');
        row[field.name] = n;
      }
    }
    return result;
  }

  prepare(sql) {
    let compiled;
    const query = async (params) => {
      if (!compiled) compiled = compile(sql);
      return this._query(compiled, params);
    };
    return {
      get: async (...params) => (await query(params)).rows[0],
      all: async (...params) => (await query(params)).rows,
      run: async (...params) => ({ changes: (await query(params)).rowCount || 0 }),
    };
  }

  // Schema files are trusted application SQL. Query callers still go through
  // prepare(), which rejects multiple result sets and binds all user values.
  async exec(sql) {
    await this._getPool().query(sql);
  }

  async withTransaction(fn) {
    if (this._transactionClient) throw new Error('Nested PostgreSQL transactions are not supported');
    const client = await this._getPool().connect();
    const tx = new PostgresDatabase({ pool: client });
    tx._transactionClient = true;
    let rollbackError;
    try {
      await client.query('BEGIN');
      const result = await fn(tx);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (failure) { rollbackError = failure; }
      throw err;
    } finally {
      tx._closed = true;
      // A client that could not roll back cannot safely return to the pool.
      client.release(rollbackError);
    }
  }

  close() {
    if (!this._closing) {
      this._closed = true;
      this._closing = this._pool ? this._pool.end() : Promise.resolve();
    }
    return this._closing;
  }
}

module.exports = { PostgresDatabase };
