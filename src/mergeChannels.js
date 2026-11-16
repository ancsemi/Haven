'use strict';

// "Merge into...": an admin folds one channel into another. Made for a Ferry
// migration that met channels copied by hand beforehand: the import brings
// the Discord history into channels of its own, next to the copies that hold
// the setup and whatever was said in Haven since. The socket handler
// (socketHandlers/channelMerge.js) checks who may merge; this file holds the
// rules and the database change.
//
// The rules:
//  - the channel merged into keeps everything that makes it that channel:
//    name, code, topic, category, type, permissions, roles, members and read
//    gates. Nobody gains or loses access to it, and the source's settings
//    are dropped with it
//  - every message of the source moves over unchanged, threads and all, as
//    "Move to..." moves them (src/moveMessages.js). The feed is ordered by
//    time, so the two histories read as one
//  - a Discord message that is in both channels is kept once. Which Discord
//    message a Haven one is comes from discord_message_id, or from the Ferry
//    map (src/ferryReplies.js) for messages relayed before that column was
//    filled. The copy in the channel merged into stays, unless only the
//    source's copy is protected
//  - a message re-posted by hand from Discord (same text, posted in Haven
//    after the Discord one) is found and listed, but only goes when the admin
//    ticks it: matching text is a guess, an exact Discord id is not. The
//    Discord copy stays, since it has the real author and time
//  - a copy that goes leaves its replies, reactions, pin and Ferry pairing to
//    the copy that stays, so nothing that answered it is lost
//  - a protected message never goes. Two protected copies of one Discord
//    message refuse the merge
//  - the source's Ferry links, webhooks, scheduled messages and role menus
//    move over, so a bridge or a bot keeps working. A Ferry link the target
//    already has for the same Discord channel is not doubled. The source's
//    Discord channel id moves too when the target has none, so a later
//    history import lands in the merged channel instead of making a new one
//  - someone who was caught up in the target stays caught up: the history
//    that comes in is old, and should not read as thousands of new messages
//  - text into text, forum into forum, and a blog forum only into a blog
//    forum. A channel with sub-channels has them moved or merged first, and
//    a DM is never merged
//
// Everything runs in one transaction, planned again inside it, so what was
// previewed and what happens cannot drift apart.

const forumBlog = require('./forumBlog');
const { keptSql } = require('./protectedMessages');
const { keepForumTags } = require('./moveMessages');

// How many re-post matches a preview lists. The merge itself checks every
// ticked id against its own plan, so a cut list only means fewer to tick.
const MAX_LISTED = 500;

// Why these two channels cannot be merged, or null.
function refusal(db, from, to) {
  if (!from || !to) return 'Channel not found';
  if (from.id === to.id) return 'Pick a different channel to merge into';
  if (from.is_dm || to.is_dm) return 'Direct messages cannot be merged';
  if (!!from.is_forum !== !!to.is_forum) return 'A forum can only be merged into another forum';
  if (forumBlog.blogOn(db, from.id) !== forumBlog.blogOn(db, to.id)) {
    return 'A blog forum can only be merged into another blog forum';
  }
  if (to.text_enabled === 0) return 'Turn text on in the channel you merge into first';
  if (db.prepare('SELECT 1 FROM channels WHERE parent_channel_id = ? LIMIT 1').get(from.id)) {
    return 'Move or merge this channel\'s sub-channels first';
  }
  return null;
}

// The same text, the way a copy and paste would leave it.
function normalize(content) {
  return typeof content === 'string' ? content.replace(/\s+/g, ' ').trim() : '';
}

// Every message of a channel with the Discord message it is, if any.
function withDiscordIds(db, channelId) {
  return db.prepare(`
    SELECT m.id, m.thread_id, m.created_at, m.user_id, m.is_webhook, m.imported_from,
      ${keptSql('m')} AS kept,
      COALESCE(m.discord_message_id,
        (SELECT MIN(f.discord_message_id) FROM ferry_message_map f WHERE f.haven_message_id = m.id)) AS discord_id
    FROM messages m WHERE m.channel_id = ?
  `).all(channelId);
}

// What a merge of `from` into `to` would do, without doing it.
//   pairs     [{ drop, keep }] exact Discord duplicates, dropped for certain
//   reposts   [{ drop, keep }] text matches, dropped only when ticked
//   counts    what moves, for the preview
function plan(db, from, to) {
  const why = refusal(db, from, to);
  if (why) return { error: why };

  const src = withDiscordIds(db, from.id);
  const dst = withDiscordIds(db, to.id);

  // Exact duplicates. Each Discord message is kept once: the target's copy,
  // unless only the source's is protected. A copy that heads a thread never
  // folds into a reply, which would nest threads, so when one copy is a reply
  // and the other is not, the reply is the one that goes.
  const heads = new Set();
  for (const m of [...src, ...dst]) if (m.thread_id) heads.add(m.thread_id);
  const canFold = (drop, keep) => !drop.kept && !(keep.thread_id && heads.has(drop.id));
  const dstByDiscord = new Map();
  for (const m of dst) if (m.discord_id && !dstByDiscord.has(m.discord_id)) dstByDiscord.set(m.discord_id, m);
  const pairs = [];
  const gone = new Set();
  for (const s of src) {
    const d = s.discord_id ? dstByDiscord.get(s.discord_id) : null;
    if (!d || gone.has(d.id)) continue;
    const order = s.thread_id && !d.thread_id ? [s, d] : !s.thread_id && d.thread_id ? [d, s] : [s, d];
    const drop = order.find(m => canFold(m, m === s ? d : s));
    if (!drop) return { error: 'Both channels hold a protected copy of the same message. Unprotect one first.' };
    const keep = drop === s ? d : s;
    pairs.push({ drop: drop.id, keep: keep.id });
    gone.add(drop.id);
  }

  // Re-posts: a Haven message posted by a person, with the text of a Discord
  // message in the other channel that is older than it. Each Discord message
  // answers for one re-post, earliest first. Only texts that some re-post
  // could match are kept from the other side, which can be a whole import.
  const reposts = [];
  const byTime = (a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id - b.id);
  const topTexts = db.prepare('SELECT id, content FROM messages WHERE channel_id = ? AND thread_id IS NULL');
  const matchAcross = (havenSide, havenChannel, discordSide, discordChannel) => {
    const candidates = new Map(havenSide
      .filter(m => !m.discord_id && !m.thread_id && !m.kept && m.user_id && !m.is_webhook && !m.imported_from && !gone.has(m.id))
      .map(m => [m.id, m]));
    if (!candidates.size) return;
    const wanted = new Map();
    for (const r of topTexts.iterate(havenChannel)) {
      const text = candidates.has(r.id) ? normalize(r.content) : '';
      if (text) wanted.set(r.id, text);
    }
    const texts = new Set(wanted.values());
    const meta = new Map(discordSide.map(m => [m.id, m]));
    const originals = new Map();
    for (const r of topTexts.iterate(discordChannel)) {
      const m = meta.get(r.id);
      if (!m || !m.discord_id || gone.has(m.id)) continue;
      const text = normalize(r.content);
      if (!texts.has(text)) continue;
      if (!originals.has(text)) originals.set(text, []);
      originals.get(text).push(m);
    }
    for (const list of originals.values()) list.sort(byTime);
    for (const m of [...candidates.values()].filter(m => wanted.has(m.id)).sort(byTime)) {
      const list = originals.get(wanted.get(m.id));
      const i = list ? list.findIndex(o => o.created_at <= m.created_at) : -1;
      if (i < 0) continue;
      reposts.push({ drop: m.id, keep: list[i].id });
      list.splice(i, 1);
    }
  };
  matchAcross(dst, to.id, src, from.id);
  matchAcross(src, from.id, dst, to.id);

  const count = (sql) => db.prepare(sql).get(from.id).n;
  return {
    pairs,
    reposts,
    counts: {
      messages: src.length,
      duplicates: pairs.length,
      webhooks: count('SELECT COUNT(*) AS n FROM webhooks WHERE channel_id = ?'),
      scheduled: count('SELECT COUNT(*) AS n FROM scheduled_messages WHERE channel_id = ?'),
      roleMenus: count('SELECT COUNT(*) AS n FROM role_menus WHERE channel_id = ?'),
      ferryLinks: count('SELECT COUNT(*) AS n FROM ferry_links WHERE channel_id = ?'),
    },
  };
}

// The preview the admin reads before merging: counts, and the re-posts with
// enough of each side to judge them.
function preview(db, from, to) {
  const p = plan(db, from, to);
  if (p.error) return p;
  const msg = db.prepare(`
    SELECT m.id, m.channel_id, m.content, m.created_at,
      COALESCE(m.webhook_username, u.display_name, u.username) AS author
    FROM messages m LEFT JOIN users u ON u.id = m.user_id WHERE m.id = ?
  `);
  const side = (id) => {
    const r = msg.get(id);
    return { id: r.id, inSource: r.channel_id === from.id, author: r.author || '', at: r.created_at, content: String(r.content || '').slice(0, 300) };
  };
  return {
    counts: p.counts,
    repostCount: p.reposts.length,
    reposts: p.reposts.slice(0, MAX_LISTED).map(r => ({ drop: side(r.drop), keep: side(r.keep) })),
  };
}

// Folds message `drop` into `keep`: what pointed at the one that goes points
// at the one that stays, then it goes.
function fold(db, drop, keep) {
  db.prepare('UPDATE messages SET reply_to = ? WHERE reply_to = ?').run(keep, drop);
  db.prepare('UPDATE messages SET thread_id = ? WHERE thread_id = ?').run(keep, drop);
  db.prepare('INSERT OR IGNORE INTO reactions (message_id, user_id, emoji, created_at) SELECT ?, user_id, emoji, created_at FROM reactions WHERE message_id = ?').run(keep, drop);
  db.prepare('DELETE FROM reactions WHERE message_id = ?').run(drop);
  if (!db.prepare('SELECT 1 FROM pinned_messages WHERE message_id = ?').get(keep)) {
    db.prepare('UPDATE pinned_messages SET message_id = ? WHERE message_id = ?').run(keep, drop);
  }
  db.prepare('DELETE FROM pinned_messages WHERE message_id = ?').run(drop);
  db.prepare('UPDATE OR IGNORE ferry_message_map SET haven_message_id = ? WHERE haven_message_id = ?').run(keep, drop);
  db.prepare('DELETE FROM ferry_message_map WHERE haven_message_id = ?').run(drop);
  db.prepare('UPDATE OR IGNORE ferry_forum_threads SET topic_message_id = ? WHERE topic_message_id = ?').run(keep, drop);
  db.prepare('DELETE FROM messages WHERE id = ?').run(drop);
}

// Merges `from` into `to`. `dropReposts` are the re-post ids the admin ticked;
// any the plan does not list as a re-post are ignored. Returns { error } or
// { moved, duplicates, reposts }.
function mergeChannels(db, { from, to, dropReposts = [] }) {
  const ticked = new Set((Array.isArray(dropReposts) ? dropReposts : []).filter(id => Number.isInteger(id) && id > 0));

  const run = db.transaction(() => {
    const p = plan(db, from, to);
    if (p.error) return p;
    const folds = [...p.pairs, ...p.reposts.filter(r => ticked.has(r.drop))];

    // Read positions go by message id, so they are worked out before anything
    // moves: who had read all of the target, and how far each had read.
    const latestTop = (channelId) => db.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM messages WHERE channel_id = ? AND thread_id IS NULL').get(channelId).n;
    const targetLatest = latestTop(to.id);
    const positions = db.prepare(`
      SELECT t.user_id, t.last_read_message_id AS here, s.last_read_message_id AS there
      FROM read_positions t LEFT JOIN read_positions s ON s.user_id = t.user_id AND s.channel_id = ?
      WHERE t.channel_id = ?
    `).all(from.id, to.id);

    for (const f of folds) fold(db, f.drop, f.keep);

    // The source's bridges and bots come along, without doubling a Ferry link
    // the target already has.
    db.prepare(`DELETE FROM ferry_links WHERE channel_id = ? AND discord_channel_id IN
      (SELECT discord_channel_id FROM ferry_links WHERE channel_id = ?)`).run(from.id, to.id);
    db.prepare('UPDATE ferry_links SET channel_id = ? WHERE channel_id = ?').run(to.id, from.id);
    db.prepare('UPDATE OR IGNORE ferry_forum_threads SET channel_id = ? WHERE channel_id = ?').run(to.id, from.id);
    for (const table of ['webhooks', 'scheduled_messages', 'role_menus']) {
      db.prepare(`UPDATE ${table} SET channel_id = ? WHERE channel_id = ?`).run(to.id, from.id);
    }
    const discordId = db.prepare('SELECT discord_channel_id FROM channels WHERE id = ?');
    const carried = discordId.get(from.id).discord_channel_id;
    if (carried && !discordId.get(to.id).discord_channel_id) {
      db.prepare('UPDATE channels SET discord_channel_id = NULL WHERE id = ?').run(from.id);
      db.prepare('UPDATE channels SET discord_channel_id = ? WHERE id = ?').run(carried, to.id);
    }

    const moved = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE channel_id = ?').get(from.id).n;
    const topIds = db.prepare('SELECT id FROM messages WHERE channel_id = ? AND thread_id IS NULL').all(from.id).map(r => r.id);
    db.prepare('UPDATE messages SET channel_id = ? WHERE channel_id = ?').run(to.id, from.id);
    db.prepare('UPDATE pinned_messages SET channel_id = ? WHERE channel_id = ?').run(to.id, from.id);
    if (topIds.length) keepForumTags(db, to.id, topIds);

    const latest = latestTop(to.id);
    const setPos = db.prepare('UPDATE read_positions SET last_read_message_id = ? WHERE user_id = ? AND channel_id = ?');
    for (const r of positions) {
      const next = r.here >= targetLatest ? latest : Math.max(r.here, r.there || 0);
      if (next !== r.here) setPos.run(next, r.user_id, to.id);
    }

    // What is left of the source is its own setup, which cascades with it.
    db.prepare('DELETE FROM channel_members WHERE channel_id = ?').run(from.id);
    db.prepare('DELETE FROM channels WHERE id = ?').run(from.id);

    return { moved, duplicates: p.pairs.length, reposts: folds.length - p.pairs.length };
  });
  return run();
}

module.exports = { mergeChannels, preview, normalize };
