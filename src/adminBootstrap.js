'use strict';

const { grantAdminRole } = require('./roleDefaults');

// An async caller may have seen no admin before yielding. The recovery
// decision and all role writes still run together on the legacy SQLite
// connection; PostgreSQL bootstrap stays blocked during the migration.
module.exports = function bootstrapAdmin(db, userId, adminUsername) {
  return db.transaction(() => {
    const user = db.prepare('SELECT username, is_admin FROM users WHERE id = ?').get(userId);
    if (!user) return 0;
    const anyAdmin = db.prepare('SELECT id FROM users WHERE is_admin = 1 LIMIT 1').get();
    if (!anyAdmin && user.username.toLowerCase() === adminUsername && !user.is_admin) {
      db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(userId);
      grantAdminRole(db, userId);
      user.is_admin = 1;
    }
    return user.is_admin;
  })();
};
