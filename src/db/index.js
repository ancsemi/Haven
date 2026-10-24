'use strict';

// Choose where Haven's tables live. SQLite stays the default while callers
// move to an awaited interface. PostgreSQL queries can be tested separately
// before its schema and the remaining synchronous calls are migrated.

function fromEnv(env = process.env) {
  const url = String(env.HAVEN_DATABASE_URL || '').trim();
  if (url) {
    if (!/^postgres(ql)?:\/\//i.test(url)) {
      throw new Error('HAVEN_DATABASE_URL must be a postgres:// or postgresql:// URL');
    }
    const { PostgresDatabase } = require('./postgres');
    return new PostgresDatabase({ url });
  }

  const { DB_PATH } = require('../paths');
  const { SqliteDatabase } = require('./sqlite');
  return new SqliteDatabase(DB_PATH);
}

module.exports = { fromEnv };
