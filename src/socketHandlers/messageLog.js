'use strict';

// Hearing of deleted and edited messages, for bot accounts (src/messageLog.js).
//
//   subscribe-message-changes -> { ok, textIncluded } or { error }
//     textIncluded says whether the admin lets bots see the text right now;
//     it is checked again at every event, and each event says too.
//   unsubscribe-message-changes -> { ok }
//
// Then mod-message-deleted and mod-message-edited arrive, and
// message-changes-unsubscribed { reason } says the bot was dropped, which
// happens when it can no longer read the audit log.

module.exports = function register(socket, ctx) {
  const { messageLog } = ctx;
  const reply = (cb) => (typeof cb === 'function' ? cb : () => {});

  socket.on('subscribe-message-changes', (data, callback) => {
    // emit('subscribe-message-changes', cb) with no data puts the callback first.
    const done = reply(typeof data === 'function' ? data : callback);
    if (!socket.user) return;
    if (!socket.user.botAccount) return done({ error: 'Only bot accounts can follow message changes' });
    if (!messageLog.canFollow(socket)) return done({ error: 'You don\'t have permission to read the audit log' });
    messageLog.subscribe(socket);
    done({ ok: true, textIncluded: messageLog.textAllowed() });
  });

  socket.on('unsubscribe-message-changes', (data, callback) => {
    messageLog.unsubscribe(socket);
    reply(typeof data === 'function' ? data : callback)({ ok: true });
  });

  socket.on('disconnect', () => messageLog.unsubscribe(socket));
};
