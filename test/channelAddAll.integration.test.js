'use strict';

/**
 * "Add all members" on a channel that already exists: everyone on the server
 * becomes a member, for whoever may tick the switch when making a channel.
 * Private channels and banned people are left alone.
 *
 *   node --test test/channelAddAll.integration.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createHarness } = require('./socketServerHarness');

const h = createHarness(3591, 'channel-add-all');
test.before(() => h.start());
test.after(() => h.stop());

test('add everyone to an existing channel', async (t) => {
  const admin = await h.register('admin');
  const helper = await h.register('helper');
  const member = await h.register('member');
  const banned = await h.register('banned');
  const A = await h.connect(admin.token);
  const db = new Database(path.join(h.dataDir, 'haven.db'));
  db.pragma('busy_timeout = 5000');
  t.after(() => db.close());

  const insert = db.prepare('INSERT INTO channels (name, code, created_by, is_private) VALUES (?, ?, ?, ?)');
  const open = insert.run('roles', 'abcd1234', admin.id, 0).lastInsertRowid;
  insert.run('secret', 'abcd5678', admin.id, 1);
  const join = db.prepare('INSERT INTO channel_members (channel_id, user_id) VALUES (?, ?)');
  join.run(open, admin.id);
  join.run(open, helper.id);
  db.prepare('INSERT INTO bans (user_id, banned_by) VALUES (?, ?)').run(banned.id, admin.id);
  const members = (id) => db.prepare('SELECT user_id FROM channel_members WHERE channel_id = ?').all(id).map(r => r.user_id);

  // Someone without Invite Users or Manage Server cannot.
  const H = await h.connect(helper.token);
  const refused = await h.ask(H, 'add-all-members', { code: 'abcd1234' });
  assert.ok(refused.error, JSON.stringify(refused));
  assert.ok(!members(open).includes(member.id));

  const res = await h.ask(A, 'add-all-members', { code: 'abcd1234' });
  assert.ok(res.success, JSON.stringify(res));
  const now = members(open);
  assert.ok(now.includes(member.id), 'the member is in now');
  assert.ok(!now.includes(banned.id), 'banned people are left out');
  assert.strictEqual(res.added, now.length - 2, 'counts only the people it added');

  assert.strictEqual((await h.ask(A, 'add-all-members', { code: 'abcd1234' })).added, 0, 'nobody twice');
  const priv = await h.ask(A, 'add-all-members', { code: 'abcd5678' });
  assert.match(priv.error || '', /private/i, 'a private channel stays invite-only');

  A.disconnect(); H.disconnect();
});
