'use strict';

/**
 * Taking replies out of a thread, back into its channel (src/moveOutOfThread.js
 * and move-messages-out-of-thread in socketHandlers/moveToThread.js).
 *
 *   node --test test/moveOutOfThread.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createHarness, wait } = require('./socketServerHarness');

const PORT = 3474;
const h = createHarness(PORT, 'move-out-of-thread');

test.before(() => h.start());
test.after(() => h.stop());

const unthread = (sock, parentId, messageIds) => h.ask(sock, 'move-messages-out-of-thread', { parentId, messageIds });

test('taking replies out of a thread', async (t) => {
  const admin = await h.register('admin');
  const mod = await h.register('mod');
  const bob = await h.register('bob');
  const carol = await h.register('carol');
  const A = await h.connect(admin.token);
  const M = await h.connect(mod.token);
  const B = await h.connect(bob.token);
  const C = await h.connect(carol.token);
  const db = new Database(path.join(h.dataDir, 'haven.db'));
  db.pragma('busy_timeout = 5000');
  t.after(() => db.close());

  const roles = (await h.ask(A, 'get-roles', {})).roles;
  assert.ok((await h.ask(A, 'assign-role', { userId: mod.id, roleId: roles.find((r) => r.name === 'Mod').id })).success);

  async function makeChannel(name, perms = []) {
    A.emit('create-channel', { name });
    for (let i = 0; i < 30; i++) {
      const row = db.prepare('SELECT id, code FROM channels WHERE name = ?').get(name);
      if (row) {
        for (const permission of perms) {
          A.emit('toggle-channel-permission', { code: row.code, permission });
          await wait(150);
        }
        for (const s of [A, M, B]) { s.emit('join-channel', { code: row.code }); await wait(100); }
        return row;
      }
      await wait(100);
    }
    throw new Error(`channel ${name} was not created`);
  }

  let minute = 0;
  const post = (channelId, userId, content, threadId = null, replyTo = null) => {
    minute += 1;
    const at = `2026-01-01 ${String(10 + Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}:00`;
    return Number(db.prepare('INSERT INTO messages (channel_id, user_id, content, created_at, thread_id, reply_to) VALUES (?, ?, ?, ?, ?, ?)')
      .run(channelId, userId, content, at, threadId, replyTo).lastInsertRowid);
  };
  const threadIdOf = (id) => db.prepare('SELECT thread_id FROM messages WHERE id = ?').get(id).thread_id;
  const replyCount = (rootId) => db.prepare('SELECT COUNT(*) AS n FROM messages WHERE thread_id = ?').get(rootId).n;

  const talk = await makeChannel('talk');
  const other = await makeChannel('other');
  A.emit('enter-channel', { code: talk.code });
  B.emit('enter-channel', { code: talk.code });
  await wait(200);

  await t.test('a member without Delete Messages is refused, and so is someone outside the channel', async () => {
    const root = post(talk.id, bob.id, 'root');
    const r1 = post(talk.id, bob.id, 'one', root);
    assert.match((await unthread(B, root, [r1])).error || '', /permissions/);
    db.prepare('DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?').run(talk.id, carol.id);
    assert.match((await unthread(C, root, [r1])).error || '', /no longer exists/);
    assert.equal(threadIdOf(r1), root, 'nothing moved');
  });

  await t.test('whoever moved messages into a thread can take them out again', async () => {
    const base = post(talk.id, admin.id, 'base');
    const loose = post(talk.id, bob.id, 'loose');
    assert.ok((await h.ask(M, 'move-messages-to-thread', { code: talk.code, rootId: base, messageIds: [loose] })).success);
    assert.equal(threadIdOf(loose), base);
    const r = await unthread(M, base, [loose]);
    assert.deepStrictEqual(r, { success: true, moved: 1, toChannel: talk.code });
    assert.equal(threadIdOf(loose), null);
  });

  await t.test('replies land in the channel with what they carry, and everyone hears', async () => {
    const root = post(talk.id, admin.id, 'the root');
    const first = post(talk.id, bob.id, 'first reply', root, root);
    const second = post(talk.id, mod.id, 'second reply', root);
    const third = post(talk.id, bob.id, 'third reply', root, first);
    const staying = post(talk.id, admin.id, 'stays in the thread', root);
    const later = post(talk.id, bob.id, 'a later channel message');
    db.prepare('INSERT INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?)').run(first, mod.id, '👍');
    db.prepare('INSERT INTO pinned_messages (message_id, channel_id, pinned_by) VALUES (?, ?, ?)').run(second, talk.id, admin.id);
    db.prepare("UPDATE messages SET destruct_at = '2099-01-01T00:00:00.000Z' WHERE id = ?").run(third);
    const before = db.prepare('SELECT id, user_id, created_at, reply_to FROM messages WHERE id IN (?, ?, ?) ORDER BY id').all(first, second, third);

    const out = h.next(B, 'messages-unthreaded', (d) => d && d.parentId === root);
    const chip = h.next(B, 'thread-updated', (d) => d && d.parentId === root);
    const quiet = h.next(B, 'new-message', () => true, 800);
    const r = await unthread(M, root, [third, first, second]);
    assert.deepStrictEqual(r, { success: true, moved: 3, toChannel: talk.code });

    const ev = await out;
    assert.equal(ev.channelCode, talk.code);
    assert.deepStrictEqual(ev.messageIds, [first, second, third]);
    const summary = (await chip).thread;
    assert.equal(summary.count, 1, 'only the reply left behind counts');
    assert.equal(summary.lastReplyId, staying);
    assert.equal(await quiet, null, 'no new-message, so no sounds or unread markers');

    const after = db.prepare('SELECT id, user_id, created_at, reply_to, channel_id, thread_id FROM messages WHERE id IN (?, ?, ?) ORDER BY id').all(first, second, third);
    for (let i = 0; i < 3; i++) {
      assert.equal(after[i].thread_id, null);
      assert.equal(after[i].channel_id, talk.id);
      assert.equal(after[i].user_id, before[i].user_id);
      assert.equal(after[i].created_at, before[i].created_at, 'original time kept, so it sits where it was written');
      assert.equal(after[i].reply_to, before[i].reply_to, 'reply banners kept');
    }
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reactions WHERE message_id = ?').get(first).n, 1);
    assert.equal(db.prepare('SELECT channel_id FROM pinned_messages WHERE message_id = ?').get(second).channel_id, talk.id);
    assert.equal(db.prepare('SELECT destruct_at FROM messages WHERE id = ?').get(third).destruct_at, '2099-01-01T00:00:00.000Z');
    assert.equal(threadIdOf(staying), root);

    // The channel feed lists them, in time order, before the later message.
    const hist = h.next(B, 'message-history', (d) => d && d.channelCode === talk.code);
    B.emit('get-messages', { code: talk.code });
    const ids = ((await hist) || {}).messages.map((m) => m.id);
    const at = (id) => ids.indexOf(id);
    assert.ok(at(first) > at(root) && at(second) > at(first) && at(third) > at(second) && at(later) > at(third), JSON.stringify(ids));
    assert.ok(!ids.includes(staying));
  });

  await t.test('taking every reply out leaves an empty thread', async () => {
    const root = post(talk.id, admin.id, 'lonely root');
    const a = post(talk.id, bob.id, 'a', root);
    const b = post(talk.id, bob.id, 'b', root);
    const chip = h.next(B, 'thread-updated', (d) => d && d.parentId === root);
    assert.ok((await unthread(A, root, [a, b])).success);
    const summary = (await chip).thread;
    assert.equal(summary.count, 0);
    assert.equal(summary.lastReplyId, null);
    assert.equal(replyCount(root), 0);
    assert.equal(threadIdOf(root), null, 'the root stays where it was');
  });

  await t.test('the root message cannot be moved this way, nor replies from elsewhere', async () => {
    const root = post(talk.id, admin.id, 'root');
    const reply = post(talk.id, bob.id, 'reply', root);
    const otherRoot = post(talk.id, admin.id, 'another root');
    const otherReply = post(talk.id, bob.id, 'another reply', otherRoot);
    const plain = post(talk.id, bob.id, 'plain message');
    const elsewhere = post(other.id, admin.id, 'elsewhere');
    const elsewhereReply = post(other.id, admin.id, 'elsewhere reply', elsewhere);

    assert.match((await unthread(A, root, [root])).error || '', /already in the channel/);
    assert.match((await unthread(A, root, [reply, root])).error || '', /already in the channel/);
    assert.match((await unthread(A, root, [otherReply])).error || '', /no longer replies in this thread/);
    assert.match((await unthread(A, root, [plain])).error || '', /no longer replies in this thread/);
    assert.match((await unthread(A, root, [elsewhereReply])).error || '', /no longer replies in this thread/);
    assert.match((await unthread(A, reply, [reply])).error || '', /already in the channel|no longer exists/);
    assert.match((await unthread(A, otherReply, [reply])).error || '', /no longer exists/, 'a reply is not a thread');
    assert.match((await unthread(A, root, [])).error || '', /between 1 and 200/);
    assert.match((await unthread(A, 0, [reply])).error || '', /Invalid message/);
    assert.equal(threadIdOf(reply), root, 'nothing moved');
    assert.equal(threadIdOf(otherReply), otherRoot);
  });

  await t.test('two moves at once take a reply once', async () => {
    const root = post(talk.id, admin.id, 'root');
    const reply = post(talk.id, bob.id, 'reply', root);
    const [r1, r2] = await Promise.all([unthread(A, root, [reply]), unthread(M, root, [reply])]);
    assert.equal([r1, r2].filter((r) => r && r.success).length, 1, 'exactly one wins');
    assert.match(r1.error || r2.error, /no longer replies/);
  });

  await t.test('blog forums and DMs are refused', async () => {
    const blog = await makeChannel('journal', ['forum', 'forum_blog']);
    const p = post(blog.id, admin.id, 'a post');
    const piece = post(blog.id, admin.id, 'a piece', p);
    assert.match((await unthread(A, p, [piece])).error || '', /blog/);
    assert.equal(threadIdOf(piece), p);

    const dm = Number(db.prepare("INSERT INTO channels (name, code, created_by, is_dm) VALUES ('dm', 'abcdef34', ?, 1)").run(admin.id).lastInsertRowid);
    db.prepare('INSERT INTO channel_members (channel_id, user_id) VALUES (?, ?), (?, ?)').run(dm, admin.id, dm, bob.id);
    const hi = post(dm, admin.id, 'hi');
    const there = post(dm, bob.id, 'there', hi);
    assert.match((await unthread(A, hi, [there])).error || '', /DMs/);
  });

  await t.test('a reply taken out of a forum topic becomes a topic, and no chip goes out', async () => {
    const forum = await makeChannel('board', ['forum']);
    const topic = post(forum.id, admin.id, 'a topic');
    const reply = post(forum.id, bob.id, 'a reply worth its own topic', topic);
    A.emit('enter-channel', { code: forum.code });
    await wait(150);
    const out = h.next(A, 'messages-unthreaded', (d) => d && d.parentId === topic);
    const chip = h.next(A, 'thread-updated', (d) => d && d.parentId === topic, 800);
    assert.ok((await unthread(A, topic, [reply])).success);
    assert.ok(await out);
    assert.equal(await chip, null, 'the forum reloads instead, so no topic is bumped');
    assert.equal(threadIdOf(reply), null);
  });

  await t.test('each move is in the audit log', async () => {
    await wait(100);
    const rows = db.prepare("SELECT actor_id, target_type, target_id, target_name, details FROM audit_log WHERE action = 'messages_move_out_of_thread' ORDER BY id").all();
    assert.equal(rows.length, 5);
    assert.equal(rows[0].actor_id, mod.id);
    assert.equal(rows[0].target_type, 'channel');
    assert.equal(rows[0].target_id, talk.id);
    assert.equal(rows[0].target_name, 'talk');
    const details = JSON.parse(rows[1].details);
    assert.equal(details.messages, 3);
    assert.equal(typeof details.thread, 'number');
  });
});
