'use strict';

// Message counts (src/messageStats.js): a member's messages by kind, and
// activity by day and hour in the asker's time zone. Counts only.

const assert = require('node:assert/strict');
const test = require('node:test');
const Database = require('better-sqlite3');

const { memberStats, activity } = require('../src/messageStats');

function setup() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE channels (id INTEGER PRIMARY KEY, is_dm INTEGER DEFAULT 0, is_group INTEGER DEFAULT 0,
      is_self_dm INTEGER DEFAULT 0, is_forum INTEGER DEFAULT 0);
    CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, channel_id INTEGER, user_id INTEGER, thread_id INTEGER,
      is_webhook INTEGER DEFAULT 0, type TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    INSERT INTO channels (id, is_dm, is_group, is_self_dm, is_forum) VALUES
      (1, 0, 0, 0, 0), (2, 0, 0, 0, 1), (3, 1, 0, 0, 0), (4, 1, 1, 0, 0), (5, 1, 0, 1, 0), (6, 0, 0, 0, 0);
  `);
  const post = (channel, user, { thread = null, webhook = 0, type = null, at = null } = {}) => {
    const info = at
      ? db.prepare('INSERT INTO messages (channel_id, user_id, thread_id, is_webhook, type, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(channel, user, thread, webhook, type, at)
      : db.prepare('INSERT INTO messages (channel_id, user_id, thread_id, is_webhook, type) VALUES (?, ?, ?, ?, ?)').run(channel, user, thread, webhook, type);
    return Number(info.lastInsertRowid);
  };
  return { db, post };
}

test('a member\'s messages are counted by kind, leaving out notes to self, webhooks and notices', () => {
  const { db, post } = setup();
  const top = post(1, 3, { at: '2026-01-02 10:00:00' });
  post(1, 3, { thread: top });
  post(1, 3);
  const topic = post(2, 3);
  post(2, 3, { thread: topic });
  post(2, 3, { thread: topic });
  post(3, 3);
  post(4, 3);
  post(4, 3);
  post(5, 3);
  post(1, 3, { webhook: 1 });
  post(1, 3, { type: 'welcome' });
  post(1, 4);
  const s = memberStats(db, 3);
  assert.deepEqual(
    { channel: s.channel, thread: s.thread, forumTopic: s.forumTopic, forumReply: s.forumReply, dm: s.dm, groupDm: s.groupDm, total: s.total },
    { channel: 2, thread: 1, forumTopic: 1, forumReply: 2, dm: 1, groupDm: 2, total: 9 });
  assert.equal(s.firstAt, '2026-01-02T10:00:00Z');
  assert.match(s.lastAt, /Z$/);
  assert.deepEqual(memberStats(db, 99), { channel: 0, thread: 0, forumTopic: 0, forumReply: 0, dm: 0, groupDm: 0, total: 0, firstAt: null, lastAt: null });
});

test('activity counts the channels given, by day and by the asker\'s hour', () => {
  const { db, post } = setup();
  post(1, 3);
  post(1, 4);
  post(6, 3);
  post(3, 3);
  post(1, 3, { at: db.prepare("SELECT datetime('now', '-40 days') AS t").get().t });

  const utc = activity(db, [1], { days: 30 });
  assert.equal(utc.total, 2);
  assert.equal(utc.byDay.length, 30);
  assert.equal(utc.byDay.at(-1).count, 2);
  assert.equal(utc.byDay.at(-1).date, new Date().toISOString().slice(0, 10));
  assert.equal(utc.byHour[new Date().getUTCHours()], 2);

  // An hour ahead of UTC, the same messages land an hour later.
  const ahead = activity(db, [1, 6], { days: 30, utcOffsetMinutes: 60 });
  assert.equal(ahead.total, 3);
  assert.equal(ahead.byHour[new Date(Date.now() + 3600000).getUTCHours()], 3);
  assert.equal(ahead.byDay.at(-1).date, new Date(Date.now() + 3600000).toISOString().slice(0, 10));

  assert.equal(activity(db, [1], { days: 60 }).total, 3, 'a longer range reaches the older one');
  assert.equal(activity(db, [], {}).total, 0);
  assert.equal(activity(db, [1], { days: 0 }), null);
  assert.equal(activity(db, [1], { days: 366 }), null);
  assert.equal(activity(db, [1], { utcOffsetMinutes: 900 }), null);
  assert.equal(activity(db, [1], { utcOffsetMinutes: 1.5 }), null);
});
