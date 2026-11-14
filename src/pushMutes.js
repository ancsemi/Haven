'use strict';

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// True when the text pings @name as a whole word, the way the client checks
// it (app-socket-channels.js): @bob does not ping bobby.
function pingsName(text, name) {
  if (!name) return false;
  return new RegExp(`(?<![\\w@])@${escapeRe(name)}(?!\\w)`, 'i').test(text);
}

const pingsEveryone = (text) => /(?<![\w@])@(everyone|here)\b/i.test(text);

// Who gets no push for a message because of their own mutes
// (public/js/modules/app-server-mute.js):
//   - a member they muted for themselves sends them none at all;
//   - a muted server sends none except for DMs, and with "except @mentions"
//     also for messages that mention them (or @everyone / @here) or reply
//     to them.
// Returns a Set of user ids to leave out.
function quietRecipients(db, { channelId, senderUserId, messageContent, replyToUserId }) {
  const quiet = new Set();
  const isDm = !!(db.prepare('SELECT is_dm FROM channels WHERE id = ?').get(channelId) || {}).is_dm;
  const text = String(messageContent || '');
  const everyone = pingsEveryone(text);
  const mentions = (u) => everyone || u.user_id === Number(replyToUserId) || pingsName(text, u.username) || pingsName(text, u.display_name);
  const rows = db.prepare(`
    SELECT p.user_id, p.key, p.value, u.username, u.display_name
    FROM user_preferences p JOIN users u ON u.id = p.user_id
    WHERE p.key IN ('server_mute', 'muted_users')
  `).all();
  for (const r of rows) {
    if (r.key === 'muted_users') {
      let ids = [];
      try { ids = JSON.parse(r.value); } catch { ids = []; } // unreadable list: nobody muted
      if (Array.isArray(ids) && ids.map(Number).includes(Number(senderUserId))) quiet.add(r.user_id);
    } else if (!isDm) {
      if (r.value === 'all' || (r.value === 'mentions' && !mentions(r))) quiet.add(r.user_id);
    }
  }
  return quiet;
}

// A device set to notify only for mentions (Settings > Sounds, Notifications
// off) still gets a push for a DM, a reply to you, or a message that pings
// you, @everyone / @here, or a role you hold. Returns the Set of the given
// user ids this message is one of those for.
function pingedRecipients(db, { channelId, messageContent, replyToUserId, userIds }) {
  const ids = [...new Set((userIds || []).map(Number).filter(Number.isInteger))];
  if (!ids.length) return new Set();
  const isDm = !!(db.prepare('SELECT is_dm FROM channels WHERE id = ?').get(channelId) || {}).is_dm;
  if (isDm || pingsEveryone(String(messageContent || ''))) return new Set(ids);
  const text = String(messageContent || '');
  const pinged = new Set();
  if (replyToUserId != null && ids.includes(Number(replyToUserId))) pinged.add(Number(replyToUserId));
  if (!text.includes('@')) return pinged;
  const ph = ids.map(() => '?').join(',');
  for (const u of db.prepare(`SELECT id, username, display_name FROM users WHERE id IN (${ph})`).all(...ids)) {
    if (pingsName(text, u.username) || pingsName(text, u.display_name)) pinged.add(u.id);
  }
  const roles = db.prepare(`
    SELECT ur.user_id, r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id
    WHERE ur.user_id IN (${ph}) AND (ur.channel_id IS NULL OR ur.channel_id = ?)
      AND COALESCE(r.mentionable, 1) = 1
  `).all(...ids, channelId);
  for (const r of roles) if (pingsName(text, r.name)) pinged.add(r.user_id);
  return pinged;
}

module.exports = { quietRecipients, pingedRecipients };
