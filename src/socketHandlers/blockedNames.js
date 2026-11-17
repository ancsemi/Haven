'use strict';

// Blocked names, the admin's screen (rules in src/blockedNames.js).
//
//   get-blocked-names                 -> { words, matches } or { error }
//   set-blocked-names { words }       -> { words, matches } or { error }
//
// matches lists the members whose name already has a blocked word in it, so
// the admin can rename or remove them: the list only stops new names.

const { KEY, parseBlockedNames, blockedWordIn, readBlockedNames } = require('../blockedNames');

const MATCH_LIMIT = 200;

module.exports = function register(socket, ctx) {
  const { db, logAudit } = ctx;

  function matchesFor(words) {
    if (!words.length) return [];
    const out = [];
    for (const u of db.prepare('SELECT id, username, display_name FROM users ORDER BY id').iterate()) {
      const word = blockedWordIn(u.username, words) || (u.display_name && blockedWordIn(u.display_name, words));
      if (!word) continue;
      out.push({ id: u.id, username: u.username, displayName: u.display_name || u.username, word });
      if (out.length >= MATCH_LIMIT) break;
    }
    return out;
  }

  socket.on('get-blocked-names', (cb) => {
    const reply = typeof cb === 'function' ? cb : () => {};
    if (!socket.user.isAdmin) return reply({ error: 'Only the admin can see blocked names' });
    try {
      const words = readBlockedNames(db);
      reply({ words, matches: matchesFor(words) });
    } catch (err) {
      console.warn('[blocked-names] load failed:', err.message);
      reply({ error: 'Could not load blocked names' });
    }
  });

  socket.on('set-blocked-names', (data, cb) => {
    const reply = typeof cb === 'function' ? cb : () => {};
    if (!socket.user.isAdmin) return reply({ error: 'Only the admin can change blocked names' });
    if (!data || typeof data.words !== 'string' || data.words.length > 20000) return reply({ error: 'Invalid request' });
    try {
      const words = parseBlockedNames(data.words);
      db.prepare('INSERT OR REPLACE INTO server_settings (key, value) VALUES (?, ?)').run(KEY, words.join('\n'));
      // The count only: the words themselves stay out of the log.
      if (typeof logAudit === 'function') {
        logAudit({ actor: socket.user, action: 'blocked_names_update', target_type: 'setting', target_id: null,
          target_name: KEY, details: { count: words.length } });
      }
      reply({ words, matches: matchesFor(words) });
    } catch (err) {
      console.warn('[blocked-names] save failed:', err.message);
      reply({ error: 'Could not save blocked names' });
    }
  });
};
