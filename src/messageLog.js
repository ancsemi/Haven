'use strict';

// Deleted and edited messages, for bot accounts that keep a mod log. A bot
// with View Audit Log subscribes and hears of every delete and edit in a
// server channel it can read: which message, whose, who did it and when.
// The text comes too only while the admin allows it (bots_see_message_text,
// Settings, Bots & data, off to start): what was deleted, and the text
// before and after an edit. DMs and groups never, and no self-destructing
// message, which is meant to vanish. Haven keeps none of it, so a bot that
// is offline misses what happens meanwhile.
//
// A handler takes a snapshot of what it is about to delete or edit
// (capture, captureEdit), makes the change, and only then hands the
// snapshot over (deleted, edited), so a change that failed is never sent.
// Thread replies that go with a deleted message are in its snapshot. With
// no bot listening nothing is read.
//
// Events: mod-message-deleted, mod-message-edited, and
// message-changes-unsubscribed { reason } for a bot that lost View Audit Log.

const { utcStamp } = require('./socketHandlers/helpers');

const ROW_SELECT = `SELECT m.id, m.user_id, m.content, m.created_at, m.thread_id, m.destruct_at,
    m.is_webhook, m.webhook_username, u.username, COALESCE(u.display_name, u.username) AS display_name
  FROM messages m LEFT JOIN users u ON u.id = m.user_id`;

function createMessageLog({ db, userHasPermission, roleGateAllows }) {
  const subscribers = new Set();

  const canFollow = (socket) => {
    try {
      return !!socket.user && !!socket.user.botAccount
        && (socket.user.isAdmin || userHasPermission(socket.user.id, 'view_audit_log'));
    } catch (err) {
      console.warn('[message-log] permission check failed:', err.message);
      return false;
    }
  };

  // The same test as reading the channel: a member who passes its gate.
  const canRead = (socket, channel) => {
    if (!db.prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?').get(channel.id, socket.user.id)) return false;
    return socket.user.isAdmin || roleGateAllows(socket.user.id, channel);
  };

  const textAllowed = () =>
    db.prepare("SELECT value FROM server_settings WHERE key = 'bots_see_message_text'").get()?.value === 'true';

  // A server channel, or null for a DM or group, which are never logged.
  const channelFor = (channelId) => {
    const ch = db.prepare('SELECT id, code, name, is_dm, is_group, role_gate FROM channels WHERE id = ?').get(channelId);
    return ch && !ch.is_dm && !ch.is_group ? ch : null;
  };

  const author = (r) => (r.user_id != null && r.username != null
    ? { id: r.user_id, username: r.username, displayName: r.display_name }
    : r.is_webhook ? { webhook: r.webhook_username || null } : null);

  const messageOut = (r) => ({
    id: r.id, threadId: r.thread_id || null, createdAt: utcStamp(r.created_at), author: author(r),
  });

  // To each bot that may hear it; build(withText) gives the payload.
  function send(event, channel, build) {
    const text = textAllowed();
    let payload = null;
    for (const socket of subscribers) {
      if (!socket.connected) { subscribers.delete(socket); continue; }
      if (!canFollow(socket)) {
        subscribers.delete(socket);
        socket.emit('message-changes-unsubscribed', { reason: 'You no longer have permission to read the audit log' });
        continue;
      }
      if (!canRead(socket, channel)) continue;
      socket.emit(event, payload || (payload = build(text)));
    }
  }

  const channelOut = (ch) => ({ id: ch.id, code: ch.code, name: ch.name });

  return {
    canFollow,
    textAllowed,

    // Before deleting: the messages, and the thread replies under them.
    capture(channelId, ids) {
      if (!subscribers.size || !Array.isArray(ids) || !ids.length) return null;
      const channel = channelFor(channelId);
      if (!channel) return null;
      const list = ids.filter(Number.isInteger);
      if (!list.length) return null;
      const ph = list.map(() => '?').join(',');
      const rows = db.prepare(`${ROW_SELECT} WHERE m.channel_id = ? AND (m.id IN (${ph}) OR m.thread_id IN (${ph})) ORDER BY m.id`)
        .all(channelId, ...list, ...list)
        .filter(r => !r.destruct_at);
      return rows.length ? { channel, rows } : null;
    },

    // After the delete went through. by: { id, username, displayName } for
    // a person, { webhook } for a webhook.
    deleted(snapshot, by) {
      if (!snapshot || !subscribers.size) return;
      const at = new Date().toISOString();
      send('mod-message-deleted', snapshot.channel, (text) => ({
        channel: channelOut(snapshot.channel), by: by || null, at, textIncluded: text,
        messages: snapshot.rows.map(r => (text ? { ...messageOut(r), content: r.content } : messageOut(r))),
      }));
    },

    // Before editing: the message as it stands.
    captureEdit(channelId, messageId) {
      if (!subscribers.size || !Number.isInteger(messageId)) return null;
      const channel = channelFor(channelId);
      if (!channel) return null;
      const row = db.prepare(`${ROW_SELECT} WHERE m.channel_id = ? AND m.id = ?`).get(channelId, messageId);
      return row && !row.destruct_at ? { channel, row } : null;
    },

    // After the edit went through. Only the author edits, so they are `by`.
    edited(snapshot, after) {
      if (!snapshot || !subscribers.size) return;
      const at = new Date().toISOString();
      const { row } = snapshot;
      send('mod-message-edited', snapshot.channel, (text) => ({
        channel: channelOut(snapshot.channel), by: author(row), at, textIncluded: text,
        message: text ? { ...messageOut(row), before: row.content, after } : messageOut(row),
      }));
    },

    subscribe(socket) { subscribers.add(socket); },
    unsubscribe(socket) { return subscribers.delete(socket); },
    has(socket) { return subscribers.has(socket); },
  };
}

module.exports = { createMessageLog };
