'use strict';

// Following the audit log live, for bot accounts (src/auditStream.js).
//
//   subscribe-audit-log { actions? } -> { ok, lastId } or { error }
//     actions: the action names to get, such as ['user_ban', 'user_warn'];
//     left out for all of them. Subscribing again replaces the list.
//     lastId is the newest row now: rows up to it are caught up with
//     get-audit-log { afterId }, rows after it arrive as audit-entry.
//   unsubscribe-audit-log -> { ok }
//
// Then audit-entry gives each new row, shaped as a get-audit-log row, and
// audit-log-unsubscribed { reason } says the bot was dropped, which happens
// when it can no longer read the log.

const MAX_ACTIONS = 200;

module.exports = function register(socket, ctx) {
  const { auditStream } = ctx;
  const reply = (cb) => (typeof cb === 'function' ? cb : () => {});

  socket.on('subscribe-audit-log', (data, callback) => {
    // emit('subscribe-audit-log', cb) with no data puts the callback first.
    if (typeof data === 'function') { callback = data; data = undefined; }
    const done = reply(callback);
    if (!socket.user) return;
    if (!socket.user.botAccount) return done({ error: 'Only bot accounts can follow the audit log' });
    if (!auditStream.canRead(socket)) return done({ error: 'You don\'t have permission to read the audit log' });

    let actions = null;
    const asked = data && typeof data === 'object' ? data.actions : undefined;
    if (asked !== undefined && asked !== null) {
      if (!Array.isArray(asked) || !asked.length || asked.length > MAX_ACTIONS
        || !asked.every(a => typeof a === 'string' && a.length > 0 && a.length <= 60)) {
        return done({ error: `actions must be a list of 1 to ${MAX_ACTIONS} action names, or left out for all of them` });
      }
      actions = new Set(asked);
    }
    try {
      done({ ok: true, lastId: auditStream.subscribe(socket, actions) });
    } catch (err) {
      console.warn('[audit-stream] subscribe failed:', err.message);
      auditStream.unsubscribe(socket);
      done({ error: 'Could not follow the audit log' });
    }
  });

  socket.on('unsubscribe-audit-log', (data, callback) => {
    auditStream.unsubscribe(socket);
    reply(typeof data === 'function' ? data : callback)({ ok: true });
  });

  socket.on('disconnect', () => auditStream.unsubscribe(socket));
};
