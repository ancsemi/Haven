'use strict';

// "Back to the channel": selected replies in a thread come out of it and
// become ordinary messages in the thread's own channel. It undoes "Move here
// as thread" (moveToThread.js), so the socket handler gives it the same
// permission (socketHandlers/moveToThread.js); this file holds the rules and
// the database change.
//
// The rules:
//  - only replies come out, and all from the one thread named. The message
//    the thread hangs from already sits in the channel, so it is refused
//    rather than quietly skipped: the panel never offers it, so asking for
//    it means a stale or hand-made request
//  - they stay in the same channel and only stop being replies: author,
//    times, reactions, attachments, pins, protection, self-destruct timers
//    and reply banners all stay. The channel lists by original time, so they
//    land where they were written
//  - a thread left with no replies is left as one would be after deleting
//    them: its message stays, its read positions too
//  - not in DMs (no threads there) and not in a blog forum, where a reply is
//    either part of a post or a comment on it; pulled out, either would land
//    as a post of its own, which Move to... refuses for the same reason
//
// Everything runs in one transaction, checked again inside it, so two moves
// at once cannot both take the same reply.

const forumBlog = require('./forumBlog');
const { MAX_SELECTED, placeholders } = require('./moveToThread');

// `channel` is a channels row, rootId the message the thread hangs from.
// Returns { error } or { moved }: the reply ids now in the channel feed.
function moveOutOfThread(db, { channel, rootId, messageIds }) {
  const ids = [...new Set((Array.isArray(messageIds) ? messageIds : []).filter(id => Number.isInteger(id) && id > 0))];
  if (!Number.isInteger(rootId) || rootId <= 0) return { error: 'Invalid message' };

  const run = db.transaction(() => {
    if (!channel) return { error: 'Channel not found' };
    if (channel.is_dm) return { error: 'Cannot move messages to or from DMs' };
    if (forumBlog.blogOn(db, channel.id)) return { error: 'Replies cannot be taken out of a post in a blog forum' };
    if (ids.length === 0 || ids.length > MAX_SELECTED) return { error: `Select between 1 and ${MAX_SELECTED} messages` };
    if (ids.includes(rootId)) return { error: 'The message a thread starts from is already in the channel' };

    const root = db.prepare('SELECT id, channel_id, thread_id FROM messages WHERE id = ?').get(rootId);
    if (!root || root.channel_id !== channel.id || root.thread_id) return { error: 'That thread no longer exists' };

    const rows = db.prepare(`SELECT id FROM messages WHERE id IN (${placeholders(ids.length)}) AND channel_id = ? AND thread_id = ?`)
      .all(...ids, channel.id, rootId);
    if (rows.length !== ids.length) return { error: 'Some selected messages are no longer replies in this thread' };

    db.prepare(`UPDATE messages SET thread_id = NULL WHERE id IN (${placeholders(ids.length)})`).run(...ids);
    return { moved: [...ids].sort((a, b) => a - b) };
  });
  return run();
}

module.exports = { moveOutOfThread };
