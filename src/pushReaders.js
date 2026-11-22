'use strict';

// Who may be sent a push for a message in a channel.
//
// A push shows the sender, the channel and the start of the message, on a
// lock screen and through a push service. So it goes only to people who
// could open the channel and read the message there. Being a member is
// not enough on its own:
//
//   - a ban leaves the person's membership rows and push subscriptions;
//   - a channel with required roles keeps rows for people who do not hold
//     them (rows added by hand, or from before the roles were required).
//
// pushReaders() looks the channel and its bans up once per message and
// returns a test for one user id. If either lookup fails nobody passes:
// a missed notification is better than message text sent to someone who
// was removed.

function pushReaders(db, channelId, roleGateAllows) {
  let channel;
  let banned;
  let admins;
  try {
    channel = db.prepare('SELECT id, role_gate, is_dm FROM channels WHERE id = ?').get(channelId);
    banned = new Set(db.prepare(`
      SELECT b.user_id FROM bans b JOIN channel_members cm ON cm.user_id = b.user_id WHERE cm.channel_id = ?
    `).all(channelId).map(r => r.user_id));
    admins = new Set(db.prepare('SELECT id FROM users WHERE is_admin = 1').all().map(r => r.id));
  } catch (err) {
    console.warn('[push] could not check who may read the channel, sending no push:', err.message);
    return () => false;
  }
  if (!channel) return () => false;
  const gated = !channel.is_dm && !!channel.role_gate;
  const verdict = new Map();
  return (userId) => {
    if (banned.has(userId)) return false;
    if (!gated || admins.has(userId)) return true;
    if (!verdict.has(userId)) {
      let ok = false;
      try { ok = !!roleGateAllows(userId, channel); } catch (err) { console.warn('[push] required-role check failed, no push for that person:', err.message); }
      verdict.set(userId, ok);
    }
    return verdict.get(userId);
  };
}

module.exports = { pushReaders };
