'use strict';

// The mentions:me search filter behind the @ button in the account bar:
// @yourname as a whole word, or a reply to you, never your own messages.

const assert = require('node:assert/strict');
const test = require('node:test');
const Database = require('better-sqlite3');
const { mentionsMeCondition } = require('../src/mentionFilter');

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
