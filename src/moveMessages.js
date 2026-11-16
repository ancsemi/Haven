'use strict';

// "Move to...": selected messages go to another channel. The socket handler
// (move-messages in socketHandlers/messages.js) checks who may move what;
// this file holds the rules and the database change. "Move here as thread"
// is the other kind of move, in moveToThread.js.
//
// The rules:
//  - a selected message with a thread brings its replies, and they stay its
//    replies: same thread, same order, same reply count and latest activity.
//    Left behind they would hang under a message that is no longer there
//  - a selected reply whose root is selected too moves once, with its root
//  - a selected reply whose root is not selected stays in its thread. The
//    channel feed only shows top-level messages, so such a reply means the
//    selection is out of date (someone else moved that message into a thread
//    meanwhile). Pulling it out of that thread on its own would undo their
//    move and lose its context; Move here as thread refuses the same case.
//    The rest of the selection still moves, and when nothing else is left
//    the move is refused
//  - nothing about a message changes but its channel: author, times,
//    reactions, attachments, pins, protection and self-destruct timers stay.
//    Read positions in a thread go by message id, which does not change, so
//    nobody gets an "N new" marker for replies they had already seen
//  - a reply banner that points at a message left behind is dropped, as
//    Move here as thread does, so the other channel's readers do not see a
//    line of a message from a channel they may not be able to open
//  - role menus stay where they are. Who can take a role from a menu goes by
//    the menu's channel (membership and its role gate), and the person who
//    placed it chose that audience. A mover only needs Delete Messages, not
//    the right to hand out roles, so moving a menu from a gated channel into
//    an open one would hand its roles to people it was never meant for. A
//    role manager can post a new menu where they want it
//  - a forum topic paired with a Discord post through Ferry stays put. The
//    pairing belongs to the Ferry link between this channel and one Discord
//    forum, so in another channel it would match no link: Discord replies
//    would keep landing in the old channel under a topic that left it, and
//    Haven replies would stop crossing. Unpairing it quietly would be worse
//  - to or from a blog forum, only whole topics, forum to forum (#5809).
//    There, who wrote a reply decides whether it is part of the post or a
//    comment, and that is worked out from the messages themselves
//    (src/forumBlog.js), so a topic that moves with all its replies reads the
//    same way in its new forum as turning blog mode on or off would show it.
//    A single reply pulled out of a post, or a chat message dropped in, would
//    land as a post of its own, so those stay refused. Move here as thread
//    refuses blog forums altogether
//
// Everything runs in one transaction, checked again inside it, so two moves
// at once cannot both move the same message.

const { MAX_SELECTED, dropStrayBanners, placeholders } = require('./moveToThread');
const forumBlog = require('./forumBlog');

// `from` and `to` are channels rows. Returns { error } or what moved:
//   moved   the selected top-level ids, which leave the source feed
//   brought replies that came along in the threads of those messages
//   kept    selected replies that stayed in their thread
function moveToChannel(db, { from, to, messageIds }) {
  const ids = [...new Set((Array.isArray(messageIds) ? messageIds : []).filter(id => Number.isInteger(id) && id > 0))];

  const run = db.transaction(() => {
    if (!from || !to) return { error: 'Channel not found' };
    if (from.id === to.id) return { error: 'Invalid channels' };
    if (from.is_dm || to.is_dm) return { error: 'Cannot move messages to or from DMs' };
    const blog = forumBlog.blogOn(db, from.id) || forumBlog.blogOn(db, to.id);
    if (blog && !(from.is_forum && to.is_forum)) return { error: 'Messages cannot be moved into or out of a blog forum' };
    if (ids.length === 0 || ids.length > MAX_SELECTED) return { error: `Select between 1 and ${MAX_SELECTED} messages` };

    const rows = db.prepare(`SELECT id, thread_id FROM messages WHERE id IN (${placeholders(ids.length)}) AND channel_id = ?`)
      .all(...ids, from.id);
    if (rows.length !== ids.length) return { error: 'Some messages were not found in the source channel' };

    const selected = new Set(ids);
    const tops = [];
    const kept = [];
    for (const r of rows) {
      if (!r.thread_id) tops.push(r.id);
      else if (!selected.has(r.thread_id)) kept.push(r.id);
      // else: it moves with its root
    }
    if (tops.length === 0) return { error: 'Those messages are replies in a thread that is staying put' };
    if (blog && kept.length) return { error: 'In a blog forum only whole topics can be moved' };
    tops.sort((a, b) => a - b);
    kept.sort((a, b) => a - b);

    const tph = placeholders(tops.length);
    const moving = `SELECT id FROM messages WHERE id IN (${tph}) OR thread_id IN (${tph})`;
    if (db.prepare(`SELECT 1 FROM role_menus WHERE message_id IN (${moving}) LIMIT 1`).get(...tops, ...tops)) {
      return { error: 'Role menus cannot be moved to another channel' };
    }
    if (db.prepare(`SELECT 1 FROM ferry_forum_threads WHERE topic_message_id IN (${tph}) LIMIT 1`).get(...tops)) {
      return { error: 'A topic linked to a Discord post cannot be moved to another channel' };
    }
    const brought = db.prepare(`SELECT id FROM messages WHERE thread_id IN (${tph}) ORDER BY id`).all(...tops).map(r => r.id);

    dropStrayBanners(db, tops, to.id);
    db.prepare(`UPDATE messages SET channel_id = ? WHERE id IN (${tph}) OR thread_id IN (${tph})`).run(to.id, ...tops, ...tops);
    db.prepare(`UPDATE pinned_messages SET channel_id = ? WHERE channel_id != ?
      AND message_id IN (${moving})`)
      .run(to.id, to.id, ...tops, ...tops);
    keepForumTags(db, to.id, tops);

    return { moved: tops, brought, kept };
  });
  return run();
}

// A topic moved into a forum takes on that forum's setup (#5809): it keeps
// the tags the new forum also has, and the old forum's other tags go, since
// nobody there could filter by them or pick them again.
function keepForumTags(db, channelId, topIds) {
  const dest = db.prepare('SELECT is_forum, forum_tags FROM channels WHERE id = ?').get(channelId);
  if (!dest || !dest.is_forum) return;
  let names = new Set();
  try {
    const list = JSON.parse(dest.forum_tags || '[]');
    if (Array.isArray(list)) names = new Set(list.map(t => t && t.name).filter(Boolean));
  } catch (err) {
    // A damaged tag list counts as no tags: the topics move without theirs.
    console.warn('[Move] unreadable forum tags on channel', channelId, err.message);
  }
  const rows = db.prepare(`SELECT id, tags FROM messages WHERE id IN (${placeholders(topIds.length)}) AND tags IS NOT NULL`).all(...topIds);
  const update = db.prepare('UPDATE messages SET tags = ? WHERE id = ?');
  for (const r of rows) {
    let tags = [];
    try { tags = JSON.parse(r.tags); } catch (err) { console.warn('[Move] unreadable tags on message', r.id, err.message); }
    const kept = Array.isArray(tags) ? tags.filter(name => names.has(name)) : [];
    update.run(kept.length ? JSON.stringify(kept) : null, r.id);
  }
}

module.exports = { moveToChannel, keepForumTags };
