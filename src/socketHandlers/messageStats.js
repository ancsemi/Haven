'use strict';

// Message counts (src/messageStats.js), for staff and the bots they run.
//
//   get-member-message-stats { userId }
//     -> { ok, userId, channel, thread, forumTopic, forumReply, dm, groupDm,
//          total, firstAt, lastAt } or { error }
//   get-message-activity { days?, utcOffsetMinutes?, channelCode? }
//     -> { ok, days, utcOffsetMinutes, total, byDay: [{ date, count }],
//          byHour: [24 counts] } or { error }
//     the server channels the asker can read, or the one named; 30 days and
//     UTC unless asked otherwise.
//
// Anyone may count their own messages. Anyone else's, and the activity, take
// what seeing a member's moderation history takes: kick, mute or ban
// members, or View Audit Log.

const stats = require('../messageStats');
const { isInt } = require('./helpers');

const STAFF_PERMS = ['kick_user', 'mute_user', 'ban_user', 'view_audit_log'];

module.exports = function register(socket, ctx) {
  const { db, userHasPermission, roleGateAllows } = ctx;
  const reply = (cb) => (typeof cb === 'function' ? cb : () => {});

  // Any error denies.
  const isStaff = () => {
    try {
      return socket.user.isAdmin || STAFF_PERMS.some(p => userHasPermission(socket.user.id, p));
    } catch (err) {
      console.warn('[message-stats] permission check failed:', err.message);
      return false;
    }
  };

  // The server channels this person can read: a member who passes the gate.
  const readableChannels = () => {
    if (socket.user.isAdmin) return db.prepare('SELECT id, code FROM channels WHERE is_dm = 0').all();
    return db.prepare(`SELECT c.id, c.code, c.role_gate FROM channels c
      JOIN channel_members cm ON cm.channel_id = c.id AND cm.user_id = ? WHERE c.is_dm = 0`).all(socket.user.id)
      .filter(c => roleGateAllows(socket.user.id, c));
  };

  socket.on('get-member-message-stats', (data, callback) => {
    const done = reply(callback);
    if (!socket.user) return;
    const userId = data && isInt(data.userId) ? data.userId : null;
    if (!userId) return done({ error: 'Invalid request' });
    if (userId !== socket.user.id && !isStaff()) return done({ error: 'You don\'t have permission to see this' });
    if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId)) return done({ error: 'Member not found' });
    try {
      done({ ok: true, userId, ...stats.memberStats(db, userId) });
    } catch (err) {
      console.warn('[message-stats] member count failed:', err.message);
      done({ error: 'Could not count the messages' });
    }
  });

  socket.on('get-message-activity', (data, callback) => {
    // emit('get-message-activity', cb) with no options puts the callback first.
    if (typeof data === 'function') { callback = data; data = undefined; }
    const done = reply(callback);
    if (!socket.user) return;
    if (!isStaff()) return done({ error: 'You don\'t have permission to see this' });
    const opts = data && typeof data === 'object' ? data : {};
    try {
      let channels = readableChannels();
      if (opts.channelCode !== undefined) {
        const one = channels.find(c => c.code === opts.channelCode);
        if (!one) return done({ error: 'Channel not found' });
        channels = [one];
      }
      const result = stats.activity(db, channels.map(c => c.id), {
        days: opts.days === undefined ? 30 : opts.days,
        utcOffsetMinutes: opts.utcOffsetMinutes === undefined ? 0 : opts.utcOffsetMinutes,
      });
      if (!result) return done({ error: `days must be 1 to ${stats.MAX_DAYS}, and utcOffsetMinutes -720 to 840` });
      done({ ok: true, ...result });
    } catch (err) {
      console.warn('[message-stats] activity count failed:', err.message);
      done({ error: 'Could not count the messages' });
    }
  });
};
