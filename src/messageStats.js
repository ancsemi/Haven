'use strict';

// Message counts, for staff and for bots that keep a member's record.
// Counts only: never a word of any message, and never who someone writes to.
//
// memberStats: one member's messages by kind, server-wide, DMs included,
//   with the first and last one's time. A member's own post counts, as for
//   badges: not a webhook's, not a system notice. Notes to self are left out.
// activity: how many messages went to the server channels the asker can
//   read, by day and by hour of the day, over the last `days` days. Days and
//   hours are in the asker's time zone, given as minutes from UTC (a fixed
//   offset, so a summer time change is not followed).
//
// A deleted message is not counted: its row is gone.

const { utcStamp } = require('./socketHandlers/helpers');

const COUNTED = "m.user_id IS NOT NULL AND COALESCE(m.is_webhook, 0) = 0 AND COALESCE(m.type, 'user') = 'user'";
const SELF_DM = 'c.is_dm = 1 AND COALESCE(c.is_group, 0) = 0 AND COALESCE(c.is_self_dm, 0) = 1';

const MAX_DAYS = 365;
const MIN_OFFSET = -720;
const MAX_OFFSET = 840;

function memberStats(db, userId) {
  const row = db.prepare(`
    SELECT
      SUM(CASE WHEN c.is_dm = 0 AND COALESCE(c.is_forum, 0) = 0 AND m.thread_id IS NULL THEN 1 ELSE 0 END) AS channel,
      SUM(CASE WHEN c.is_dm = 0 AND COALESCE(c.is_forum, 0) = 0 AND m.thread_id IS NOT NULL THEN 1 ELSE 0 END) AS thread,
      SUM(CASE WHEN c.is_dm = 0 AND c.is_forum = 1 AND m.thread_id IS NULL THEN 1 ELSE 0 END) AS forumTopic,
      SUM(CASE WHEN c.is_dm = 0 AND c.is_forum = 1 AND m.thread_id IS NOT NULL THEN 1 ELSE 0 END) AS forumReply,
      SUM(CASE WHEN c.is_dm = 1 AND COALESCE(c.is_group, 0) = 0 THEN 1 ELSE 0 END) AS dm,
      SUM(CASE WHEN c.is_dm = 1 AND c.is_group = 1 THEN 1 ELSE 0 END) AS groupDm,
      MIN(m.created_at) AS firstAt, MAX(m.created_at) AS lastAt
    FROM messages m JOIN channels c ON c.id = m.channel_id
    WHERE m.user_id = ? AND ${COUNTED} AND NOT (${SELF_DM})
  `).get(userId);
  const n = (v) => v || 0;
  const counts = {
    channel: n(row.channel), thread: n(row.thread), forumTopic: n(row.forumTopic),
    forumReply: n(row.forumReply), dm: n(row.dm), groupDm: n(row.groupDm),
  };
  return {
    ...counts,
    total: Object.values(counts).reduce((a, b) => a + b, 0),
    firstAt: utcStamp(row.firstAt) || null, lastAt: utcStamp(row.lastAt) || null,
  };
}

// '+90 minutes' / '-300 minutes', as SQLite's date modifiers take them.
const shift = (minutes) => `${minutes >= 0 ? '+' : ''}${minutes} minutes`;

// channelIds: the server channels to count. Gives null when the options are
// out of range, so the caller can say so.
function activity(db, channelIds, { days = 30, utcOffsetMinutes = 0 } = {}) {
  if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) return null;
  if (!Number.isInteger(utcOffsetMinutes) || utcOffsetMinutes < MIN_OFFSET || utcOffsetMinutes > MAX_OFFSET) return null;

  // Local midnight `days - 1` days ago, as a UTC time to compare against.
  const local = shift(utcOffsetMinutes);
  const since = db.prepare('SELECT datetime(date(\'now\', ?, ?), ?) AS t')
    .get(local, `-${days - 1} days`, shift(-utcOffsetMinutes)).t;
  const today = db.prepare("SELECT date('now', ?) AS d").get(local).d;

  const byDate = new Map();
  const byHour = new Array(24).fill(0);
  if (channelIds.length) {
    // One channel at a time, so each count walks the (channel, time) index.
    const q = db.prepare(`
      SELECT date(m.created_at, ?) AS d, CAST(strftime('%H', m.created_at, ?) AS INTEGER) AS h, COUNT(*) AS n
      FROM messages m
      WHERE m.channel_id = ? AND m.created_at >= ? AND ${COUNTED}
      GROUP BY d, h
    `);
    for (const id of channelIds) {
      for (const r of q.all(local, local, id, since)) {
        byDate.set(r.d, (byDate.get(r.d) || 0) + r.n);
        byHour[r.h] += r.n;
      }
    }
  }

  // Every day in the range, quiet ones as 0, oldest first.
  const byDay = [];
  const end = new Date(`${today}T00:00:00Z`);
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(end.getTime() - i * 86400000).toISOString().slice(0, 10);
    byDay.push({ date, count: byDate.get(date) || 0 });
  }
  return { days, utcOffsetMinutes, total: byHour.reduce((a, b) => a + b, 0), byDay, byHour };
}

module.exports = { memberStats, activity, MAX_DAYS };
