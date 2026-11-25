'use strict';

// Overview channels: a channel with is_overview set shows a front page for
// the server instead of a message log. The page gathers what the viewer can
// already read elsewhere: the next events in calendar channels, the newest
// posts in announcement channels and the forum topics with the latest
// activity. Only channels the viewer is a member of, and whose role gate
// they pass, are looked at, so the page never shows more than their sidebar.
// NSFW channels and NSFW posts stay off it unless the overview channel is
// NSFW itself. Posts that are meant to go away (burn after reading,
// self-destructing) are left out, and texts are cut to an excerpt.

const cal = require('./calendarEvents');

const LIMITS = { events: 7, announcements: 5, topics: 5 };
const EXCERPT = 300;

// The name a post shows: a persona's or webhook's name before the account's.
const AUTHOR = `COALESCE(m.persona_username, m.webhook_username, u.display_name, u.username, '[Deleted User]') AS author`;
const KEPT = `m.thread_id IS NULL AND COALESCE(m.burn_seconds, 0) = 0 AND m.destruct_at IS NULL AND COALESCE(m.type, 'user') = 'user'`;

const excerpt = (text) => String(text || '').slice(0, EXCERPT);
// SQLite keeps times as 'YYYY-MM-DD HH:MM:SS' in UTC; a browser would read
// that as local time, so they go out as ISO 8601 with the zone.
const utc = (s) => (!s || /(Z|[+-]\d\d:?\d\d)$/.test(s) ? s : `${s.replace(' ', 'T')}Z`);

// The channels the page draws from, by kind.
function sources(db, user, roleGateAllows, nsfw) {
  const rows = db.prepare(`SELECT c.id, c.code, c.name, c.role_gate, c.is_calendar, c.is_forum, c.is_overview, c.notification_type
    FROM channels c JOIN channel_members cm ON cm.channel_id = c.id AND cm.user_id = ?
    WHERE c.is_dm = 0 AND COALESCE(c.is_group, 0) = 0
      AND (c.is_calendar = 1 OR c.is_forum = 1 OR c.notification_type = 'announcement')
      ${nsfw ? '' : 'AND COALESCE(c.is_nsfw, 0) = 0'}`).all(user.id);
  return rows.filter(ch => user.isAdmin || roleGateAllows(user.id, ch));
}

function announcements(db, ids, nsfw) {
  if (!ids.length) return [];
  return db.prepare(`SELECT m.id, m.channel_id, m.content, m.created_at, m.user_id, ${AUTHOR}
    FROM messages m LEFT JOIN users u ON u.id = m.user_id
    WHERE m.channel_id IN (SELECT value FROM json_each(?)) AND ${KEPT} ${nsfw ? '' : 'AND COALESCE(m.nsfw, 0) = 0'}
    ORDER BY m.created_at DESC, m.id DESC LIMIT ?`).all(JSON.stringify(ids), LIMITS.announcements)
    .map(r => ({ id: r.id, channelId: r.channel_id, author: r.author, userId: r.user_id, excerpt: excerpt(r.content), createdAt: utc(r.created_at) }));
}

// Latest activity is the newest reply, or the topic itself when it has none,
// as in the forum's own Active order.
function topics(db, ids, nsfw) {
  if (!ids.length) return [];
  return db.prepare(`SELECT t.*, (SELECT COUNT(*) FROM messages r WHERE r.thread_id = t.id) AS replies FROM (
      SELECT m.id, m.channel_id, m.title, m.content, m.created_at, m.closed, m.user_id, ${AUTHOR},
        COALESCE((SELECT MAX(r.created_at) FROM messages r WHERE r.thread_id = m.id), m.created_at) AS activity_at
      FROM messages m LEFT JOIN users u ON u.id = m.user_id
      WHERE m.channel_id IN (SELECT value FROM json_each(?)) AND ${KEPT} ${nsfw ? '' : 'AND COALESCE(m.nsfw, 0) = 0'}
      ORDER BY activity_at DESC, m.id DESC LIMIT ?
    ) t ORDER BY t.activity_at DESC, t.id DESC`).all(JSON.stringify(ids), LIMITS.topics)
    .map(r => ({
      id: r.id, channelId: r.channel_id, title: r.title || '', excerpt: excerpt(r.content), author: r.author, userId: r.user_id,
      replies: r.replies, closed: !!r.closed, createdAt: utc(r.created_at), activityAt: utc(r.activity_at),
    }));
}

// The page for `user`. `nsfw` is whether the overview channel is NSFW.
// `watch` lists the channels it drew from, so the client knows which live
// changes call for a fresh copy.
function build(db, user, roleGateAllows, { nsfw = false, now = Date.now() } = {}) {
  const chans = sources(db, user, roleGateAllows, nsfw);
  const byId = new Map(chans.map(c => [c.id, c]));
  const ids = (keep) => chans.filter(keep).map(c => c.id);
  const place = ({ channelId, ...item }) => ({ ...item, channelCode: byId.get(channelId).code, channelName: byId.get(channelId).name });
  return {
    events: cal.upcoming(db, ids(c => c.is_calendar), user.id, now, LIMITS.events).map(place),
    announcements: announcements(db, ids(c => c.notification_type === 'announcement' && !c.is_calendar && !c.is_forum && !c.is_overview), nsfw).map(place),
    topics: topics(db, ids(c => c.is_forum), nsfw).map(place),
    watch: chans.map(c => c.code),
  };
}

module.exports = { LIMITS, build };
