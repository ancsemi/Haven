'use strict';

// Key reads use the selected connection's awaited interface. SQLite keeps its
// rowid ordering; PostgreSQL records publication order in an insertion sequence.
module.exports = function createEncryptionKeyReads(db) {
  const driver = () => db.async || db;
  return {
    async publicKey(userId) {
      return driver().prepare('SELECT public_key FROM users WHERE id = ?').get(userId);
    },
    async encryptedKey(userId) {
      return driver().prepare('SELECT encrypted_private_key, e2e_key_salt, public_key, signing_key, signing_backup FROM users WHERE id = ?').get(userId);
    },
    async signingKeys(userId) {
      const current = driver();
      const order = current.kind === 'postgres' ? 'insertion_id' : 'rowid';
      // Current key and history used to be read without yielding on SQLite.
      // One statement retains that snapshot when a rotation happens mid-read.
      const rows = await current.prepare(`
        SELECT u.signing_key, history.jwk
        FROM users u LEFT JOIN (
          SELECT jwk, ${order} AS key_order FROM user_signing_keys
          WHERE user_id = ? ORDER BY ${order} DESC LIMIT 50
        ) history ON 1 = 1
        WHERE u.id = ? ORDER BY history.key_order DESC
      `).all(userId, userId);
      return { row: rows[0], keys: rows.filter(row => row.jwk !== null) };
    },
  };
};
