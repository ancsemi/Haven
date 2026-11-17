'use strict';

/**
 * Scrubbing a spammer's messages (src/scrubMessages.js). A kick with "Scrub
 * messages" deleted the rows but told no screen, so the spam stayed in view
 * and a moderator's bulk delete of it then failed with "You don't have
 * permission" (the rows were gone). A ban made without the scrub had no way
 * to do it afterwards. Now:
 *  - the kick's scrub takes the messages off every open screen
 *  - the banned list can scrub a banned person's messages afterwards
 *  - a bulk delete of messages that are already gone succeeds
 *
 *   node --test test/scrubMessages.integration.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createHarness, wait } = require('./socketServerHarness');

const PORT = 3478;
const h = createHarness(PORT, 'scrub-messages');

test.before(() => h.start());
test.after(() => h.stop());

test('scrubbing a spammer', async (t) => {
  const admin = await h.register('admin');
  const mod = await h.register('modthree');
  const spammer = await h.register('spambot');
  const bystander = await h.register('reader');
  const A = await h.connect(admin.token);
  const db = new Database(path.join(h.dataDir, 'haven.db'));
  db.pragma('busy_timeout = 5000');
  t.after(() => db.close());

  const roles = (await h.ask(A, 'get-roles', {})).roles;
  assert.ok((await h.ask(A, 'assign-role', { userId: mod.id, roleId: roles.find((r) => r.name === 'Mod').id })).success);

  const mk = async (name) => {
    A.emit('create-channel', { name });
    for (let i = 0; i < 30; i++) {
      await wait(100);
      const row = db.prepare('SELECT id, code FROM channels WHERE name = ?').get(name);
      if (row) return row;
    }
    throw new Error('no channel');
  };
  const general = await mk('general');
  const other = await mk('other');
  const M = await h.connect(mod.token);
  const S = await h.connect(spammer.token);
  const R = await h.connect(bystander.token);
  for (const ch of [general, other]) for (const s of [M, S, R]) { s.emit('join-channel', { code: ch.code }); await wait(80); }
  const post = (channelId, content, extra = {}) => Number(db.prepare(
    'INSERT INTO messages (channel_id, user_id, content, is_archived, thread_id) VALUES (?, ?, ?, ?, ?)'
  ).run(channelId, extra.userId || spammer.id, content, extra.archived ? 1 : 0, extra.threadId || null).lastInsertRowid);
  const left = (channelId) => db.prepare('SELECT content FROM messages WHERE user_id = ? AND channel_id = ? ORDER BY id').all(spammer.id, channelId).map((r) => r.content);

  await t.test('a kick\'s scrub takes the spam off every open screen', async () => {
    const spam = [post(general.id, 'buy now'), post(general.id, 'buy again')];
    post(other.id, 'spam elsewhere');
    M.emit('enter-channel', { code: general.code });
    R.emit('enter-channel', { code: general.code });
    await wait(200);
    const seen = h.next(R, 'messages-purged', (d) => d && d.channelCode === general.code);
    M.emit('kick-user', { userId: spammer.id, reason: 'spam', scrubMessages: true, scrubScope: 'server' });
    const purged = await seen;
    assert.ok(purged, 'the bystander\'s screen was told');
    assert.equal(purged.userId, spammer.id);
    assert.deepEqual(left(general.id), [], 'gone from the channel');
    assert.deepEqual(left(other.id), ['spam elsewhere'], 'a moderator\'s kick scrubs only its own channel');

    // The moderator, whose screen still showed them, deletes them anyway.
    const res = await h.ask(M, 'delete-messages', { code: general.code, messageIds: spam });
    assert.ok(res.success, `already gone counts as done, not "no permission": ${JSON.stringify(res)}`);
    // One at a time too: the message comes off their screen instead of nothing happening.
    const single = h.next(M, 'message-deleted', (d) => d && d.messageId === spam[0]);
    M.emit('delete-message', { messageId: spam[0], channelCode: general.code });
    assert.ok(await single, 'a single delete of a message that is gone clears it from the screen');
  });

  await t.test('the banned list scrubs a banned person afterwards', async () => {
    post(other.id, 'more spam');
    post(other.id, 'protected evidence', { archived: true });
    const topic = post(general.id, 'someone else asks', { userId: bystander.id });
    post(general.id, 'spam in a thread', { threadId: topic });

    const notBanned = await h.ask(A, 'scrub-user-messages', { userId: bystander.id });
    assert.match(notBanned.error || '', /banned/, 'only for someone who is banned');

    A.emit('ban-user', { userId: spammer.id, reason: 'spam' });
    for (let i = 0; i < 30 && !db.prepare('SELECT 1 FROM bans WHERE user_id = ?').get(spammer.id); i++) await wait(100);
    const R2 = h.next(R, 'messages-purged', (d) => d && d.channelCode === other.code, 5000);
    R.emit('enter-channel', { code: other.code });
    const done = await h.ask(M, 'scrub-user-messages', { userId: spammer.id });
    assert.ok(done.ok, JSON.stringify(done));
    assert.equal(done.deleted, 3, 'everything but the protected message, in every channel');
    assert.ok(await R2, 'open screens are told');
    assert.deepEqual(left(other.id), ['protected evidence']);
    assert.deepEqual(left(general.id), []);
    assert.ok(db.prepare('SELECT 1 FROM messages WHERE id = ?').get(topic), 'other people\'s messages stay');
    const audit = db.prepare("SELECT details FROM audit_log WHERE action = 'user_scrub'").get();
    assert.equal(JSON.parse(audit.details).deleted, 3);
  });

  await t.test('nobody scrubs someone of their own rank or above', async () => {
    A.emit('ban-user', { userId: mod.id, reason: 'test' });
    for (let i = 0; i < 30 && !db.prepare('SELECT 1 FROM bans WHERE user_id = ?').get(mod.id); i++) await wait(100);
    const self = await h.ask(R, 'scrub-user-messages', { userId: mod.id });
    assert.ok(self.error, 'a member without Ban is refused');
  });
});
