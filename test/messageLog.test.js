'use strict';

// Deleted and edited messages for bot accounts (src/messageLog.js): who,
// whose and when always; the text only while the admin allows it; only
// channels the bot can read; never DMs, groups or self-destructing messages.

const assert = require('node:assert/strict');
const test = require('node:test');
const Database = require('better-sqlite3');

const { createMessageLog } = require('../src/messageLog');

function setup() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT);
    CREATE TABLE channels (id INTEGER PRIMARY KEY, code TEXT, name TEXT, is_dm INTEGER DEFAULT 0, is_group INTEGER DEFAULT 0, role_gate TEXT);
    CREATE TABLE channel_members (channel_id INTEGER, user_id INTEGER);
    CREATE TABLE messages (id INTEGER PRIMARY KEY, channel_id INTEGER, user_id INTEGER, content TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, thread_id INTEGER, destruct_at DATETIME,
      is_webhook INTEGER DEFAULT 0, webhook_username TEXT);
    CREATE TABLE server_settings (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO users VALUES (3, 'bob', 'Bob'), (7, 'modbot', NULL), (9, 'mod', NULL);
    INSERT INTO channels (id, code, name) VALUES (1, 'aaaaaaaa', 'lobby'), (2, 'bbbbbbbb', 'secret');
    INSERT INTO channels (id, code, name, is_dm) VALUES (3, 'cccccccc', NULL, 1);
    INSERT INTO channel_members VALUES (1, 7), (1, 3), (2, 3), (3, 3), (3, 7);
  `);
  const perms = new Set([7]);
  const log = createMessageLog({ db, userHasPermission: (id, p) => p === 'view_audit_log' && perms.has(id), roleGateAllows: () => true });
  let next = 100;
  const post = (channelId, content, extra = {}) => {
    const id = next++;
    db.prepare('INSERT INTO messages (id, channel_id, user_id, content, thread_id, destruct_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, channelId, extra.userId ?? 3, content, extra.threadId ?? null, extra.destructAt ?? null);
    return id;
  };
  const remove = (ids) => { for (const id of ids) db.prepare('DELETE FROM messages WHERE id = ? OR thread_id = ?').run(id, id); };
  const textOn = (on) => db.prepare("INSERT OR REPLACE INTO server_settings VALUES ('bots_see_message_text', ?)").run(on ? 'true' : 'false');
  return { db, log, perms, post, remove, textOn };
}

function fakeBot(id = 7) {
  const got = [];
  return { user: { id, botAccount: true, isAdmin: false }, connected: true, got, emit: (ev, data) => got.push([ev, data]) };
}
const events = (bot, name) => bot.got.filter(([ev]) => ev === name).map(([, d]) => d);
const MOD = { id: 9, username: 'mod', displayName: 'mod' };

test('a delete says whose, who and when, and the text only once the admin allows it', () => {
  const { log, post, remove, textOn } = setup();
  const bot = fakeBot();
  log.subscribe(bot);

  const a = post(1, 'first');
  let snap = log.capture(1, [a]);
  remove([a]);
  log.deleted(snap, MOD);
  const [off] = events(bot, 'mod-message-deleted');
  assert.equal(off.textIncluded, false);
  assert.deepEqual(off.channel, { id: 1, code: 'aaaaaaaa', name: 'lobby' });
  assert.deepEqual(off.by, MOD);
  assert.equal(off.messages.length, 1);
  assert.deepEqual(off.messages[0].author, { id: 3, username: 'bob', displayName: 'Bob' });
  assert.match(off.messages[0].createdAt, /Z$/);
  assert.ok(!('content' in off.messages[0]));

  textOn(true);
  const b = post(1, 'second');
  snap = log.capture(1, [b]);
  remove([b]);
  log.deleted(snap, MOD);
  const on = events(bot, 'mod-message-deleted')[1];
  assert.equal(on.textIncluded, true);
  assert.equal(on.messages[0].content, 'second');
});

test('an edit carries the text before and after only with the toggle on', () => {
  const { db, log, post, textOn } = setup();
  const bot = fakeBot();
  log.subscribe(bot);
  const id = post(1, 'old words');
  let snap = log.captureEdit(1, id);
  db.prepare('UPDATE messages SET content = ? WHERE id = ?').run('new words', id);
  log.edited(snap, 'new words');
  const off = events(bot, 'mod-message-edited')[0];
  assert.equal(off.message.id, id);
  assert.deepEqual(off.by, { id: 3, username: 'bob', displayName: 'Bob' });
  assert.ok(!('before' in off.message) && !('after' in off.message));

  textOn(true);
  snap = log.captureEdit(1, id);
  log.edited(snap, 'newer words');
  const on = events(bot, 'mod-message-edited')[1];
  assert.equal(on.message.before, 'new words');
  assert.equal(on.message.after, 'newer words');
});

test('thread replies go with their message; self-destructing ones never show', () => {
  const { log, post, remove } = setup();
  const bot = fakeBot();
  log.subscribe(bot);
  const head = post(1, 'head');
  const reply = post(1, 'reply', { threadId: head });
  post(1, 'timed reply', { threadId: head, destructAt: '2030-01-01 00:00:00' });
  const snap = log.capture(1, [head]);
  remove([head]);
  log.deleted(snap, MOD);
  assert.deepEqual(events(bot, 'mod-message-deleted')[0].messages.map(m => m.id), [head, reply]);

  const timed = post(1, 'timed', { destructAt: '2030-01-01 00:00:00' });
  assert.equal(log.capture(1, [timed]), null);
});

test('only channels the bot can read, never a DM, and nothing read with no bot listening', () => {
  const { log, post } = setup();
  assert.equal(log.capture(1, [post(1, 'nobody listens')]), null);
  const bot = fakeBot();
  log.subscribe(bot);
  assert.equal(log.capture(3, [post(3, 'a dm')]), null);
  log.deleted(log.capture(2, [post(2, 'in secret')]), MOD);
  assert.equal(events(bot, 'mod-message-deleted').length, 0);
});

test('a bot that loses View Audit Log is dropped', () => {
  const { log, perms, post } = setup();
  const bot = fakeBot();
  assert.equal(log.canFollow({ user: { id: 7, botAccount: false } }), false);
  assert.equal(log.canFollow(bot), true);
  log.subscribe(bot);
  perms.delete(7);
  log.deleted(log.capture(1, [post(1, 'x')]), MOD);
  assert.equal(events(bot, 'mod-message-deleted').length, 0);
  assert.equal(bot.got.at(-1)[0], 'message-changes-unsubscribed');
  assert.equal(log.has(bot), false);
});
