'use strict';

// The mentions:me search filter behind the @ button in the account bar:
// @yourname as a whole word, or a reply to you, never your own messages.

const assert = require('node:assert/strict');
const test = require('node:test');
const Database = require('better-sqlite3');
const { mentionsMeCondition, unreadMentionsQuery } = require('../src/mentionFilter');

function matches(rows) {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE messages (id INTEGER PRIMARY KEY, channel_id INTEGER, user_id INTEGER, content TEXT, reply_to INTEGER)');
  const ins = db.prepare('INSERT INTO messages (id, user_id, content, reply_to) VALUES (?, ?, ?, ?)');
  rows.forEach(r => ins.run(r.id, r.user, r.text, r.reply || null));
  const cond = mentionsMeCondition(1, 'Bob');
  return db.prepare(`SELECT m.id FROM messages m WHERE ${cond.sql} ORDER BY m.id`).all(...cond.params).map(r => r.id);
}

test('finds @mentions of you as a whole word, in any case', () => {
  assert.deepEqual(matches([
    { id: 1, user: 2, text: 'hey @bob' },
    { id: 2, user: 2, text: '@BOB, look at this' },
    { id: 3, user: 2, text: 'thanks @bob!' },
    { id: 4, user: 2, text: 'line one\n@bob\nline three' },
  ]), [1, 2, 3, 4]);
});

test('skips longer names, email addresses and plain text', () => {
  assert.deepEqual(matches([
    { id: 1, user: 2, text: 'hey @bobby' },
    { id: 2, user: 2, text: 'write to x@bob.com' },
    { id: 3, user: 2, text: 'bob said hi' },
    { id: 4, user: 2, text: 'hey @bob_2' },
  ]), []);
});

test('finds replies to your messages but never your own messages', () => {
  assert.deepEqual(matches([
    { id: 1, user: 1, text: 'my question' },
    { id: 2, user: 2, text: 'an answer', reply: 1 },
    { id: 3, user: 1, text: 'note to self @bob' },
    { id: 4, user: 3, text: 'other thread', reply: 2 },
    { id: 5, user: null, text: '@bob from a deleted account' },
  ]), [2, 5]);
});

test('refuses names that are not login names', () => {
  assert.equal(mentionsMeCondition(1, 'bob*'), null);
  assert.equal(mentionsMeCondition(1, ''), null);
  assert.equal(mentionsMeCondition(0, 'bob'), null);
});
test('lists unread mentions and replies after the read position, newest kept', () => {
  const db = new Database(':memory:');
  db.exec("CREATE TABLE messages (id INTEGER PRIMARY KEY, channel_id INTEGER, user_id INTEGER, content TEXT, reply_to INTEGER, thread_id INTEGER, type TEXT)");
  const ins = db.prepare('INSERT INTO messages (id, channel_id, user_id, content, reply_to, thread_id, type) VALUES (?, ?, ?, ?, ?, ?, ?)');
  [[1, 7, 1, 'my question', null, null, null], [2, 7, 2, 'hey @bob', null, null, null], [3, 7, 2, 'an answer', 1, null, null], [4, 7, 2, 'hey @bobby or x@bob.com', null, null, null], [5, 7, 2, 'in a thread @bob', null, 9, null], [7, 7, 1, 'note to self @bob', null, null, null], [8, 8, 2, '@bob elsewhere', null, null, null], [9, 7, null, '@BOB, imported', null, null, null], [10, 7, 2, '@bob joined', null, null, 'notice']].forEach(r => ins.run(...r));
  const q = unreadMentionsQuery(1, 'Bob');
  const ids = after => q.pick(db.prepare(q.sql).all(...q.params(7, after)));
  assert.deepEqual(ids(0), [2, 3, 9]);
  assert.deepEqual(ids(2), [3, 9]);
  assert.deepEqual(unreadMentionsQuery(1, 'bob', 2).pick([{ id: 3, to_me: 1 }, { id: 2, content: '@bob' }, { id: 1, content: '@bob' }]), [2, 3]);
  assert.equal(unreadMentionsQuery(1, 'bob*'), null);
});
