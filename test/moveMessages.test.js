'use strict';

/**
 * "Move to...": selected messages go to another channel, and a message's
 * thread comes along (src/moveMessages.js and the move-messages handler).
 *
 *   node --test test/moveMessages.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createHarness, wait } = require('./socketServerHarness');
const threadNotify = require('../src/threadNotify');

const PORT = 3472;
const h = createHarness(PORT, 'move-messages');

test.before(() => h.start());
test.after(() => h.stop());

const move = (sock, fromChannel, toChannel, messageIds) => h.ask(sock, 'move-messages', { fromChannel, toChannel, messageIds });

test('moving messages to another channel', async (t) => {
  const admin = await h.register('admin');
  const mod = await h.register('mod');
  const bob = await h.register('bob');
  const A = await h.connect(admin.token);
  const M = await h.connect(mod.token);
  const B = await h.connect(bob.token);
  const db = new Database(path.join(h.dataDir, 'haven.db'));
  db.pragma('busy_timeout = 5000');
  t.after(() => db.close());

  const roles = (await h.ask(A, 'get-roles', {})).roles;
  assert.ok((await h.ask(A, 'assign-role', { userId: mod.id, roleId: roles.find((r) => r.name === 'Mod').id })).success);

  async function makeChannel(name) {
    A.emit('create-channel', { name });
    for (let i = 0; i < 30; i++) {
      const row = db.prepare('SELECT id, code FROM channels WHERE name = ?').get(name);
      if (row) {
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
  const row = (id) => db.prepare('SELECT channel_id, thread_id, reply_to, is_archived, destruct_at, content FROM messages WHERE id = ?').get(id);
  const history = (sock, code) => new Promise((res) => {
    sock.once('message-history', res);
    sock.emit('get-messages', { code });
  });

  const talk = await makeChannel('talk');
  const other = await makeChannel('other');
  A.emit('enter-channel', { code: talk.code });
  B.emit('enter-channel', { code: talk.code });
  await wait(200);

  await t.test('a member without Delete Messages is refused', async () => {
    const m = post(talk.id, bob.id, 'mine');
    assert.match((await move(B, talk.code, other.code, [m])).error || '', /permissions/);
    assert.equal(row(m).channel_id, talk.id);
  });

  await t.test('a moved message brings its thread, with what the replies carry, and nothing reads as new', async () => {
    const left = post(talk.id, admin.id, 'stays in talk');
    const root = post(talk.id, bob.id, 'has a thread', null, left);
    const r1 = post(talk.id, mod.id, 'reply 1', root);
    const r2 = post(talk.id, admin.id, 'reply 2', root, r1);
    const r3 = post(talk.id, bob.id, 'reply 3 quoting talk', root, left);
    const loose = post(talk.id, mod.id, 'a plain message');
    db.prepare('INSERT INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?)').run(r1, bob.id, '👍');
    db.prepare('INSERT INTO pinned_messages (message_id, channel_id, pinned_by) VALUES (?, ?, ?)').run(r2, talk.id, admin.id);
    db.prepare('INSERT INTO pinned_messages (message_id, channel_id, pinned_by) VALUES (?, ?, ?)').run(root, talk.id, admin.id);
    db.prepare('UPDATE messages SET is_archived = 1 WHERE id = ?').run(r1);
    db.prepare("UPDATE messages SET destruct_at = '2099-01-01T00:00:00.000Z' WHERE id = ?").run(r2);
    db.prepare('UPDATE messages SET content = ? WHERE id = ?').run(['reply 3 quoting talk', '/uploads/a.png'].join('\n'), r3);
    // Bob read the thread to the end; mod still has reply 3 to read.
    db.prepare('INSERT INTO thread_reads (user_id, thread_id, last_read_reply_id) VALUES (?, ?, ?)').run(bob.id, root, r3);
    db.prepare('INSERT INTO thread_reads (user_id, thread_id, last_read_reply_id) VALUES (?, ?, ?)').run(mod.id, root, r2);

    const B2 = await h.connect(bob.token);
    B2.emit('enter-channel', { code: other.code });
    await wait(150);
    const gone = h.next(B, 'messages-moved', (d) => d && d.messageIds.includes(root));
    const arrived = h.next(B2, 'messages-received', (d) => d && d.messageIds.includes(root));
    const quiet = h.next(B2, 'new-thread-message', () => true, 800);
    const quietHere = h.next(B, 'new-thread-message', () => true, 800);

    const r = await move(M, talk.code, other.code, [loose, root]);
    assert.deepStrictEqual(r, { success: true, moved: 2, brought: 3, kept: 0 });

    const g = await gone;
    assert.deepStrictEqual(g.messageIds, [root, loose]);
    assert.equal(g.toChannel, other.code);
    const a = await arrived;
    assert.equal(a.fromChannel, talk.code);
    assert.deepStrictEqual(a.messageIds, [root, loose]);
    assert.deepStrictEqual(a.brought, [r1, r2, r3]);
    assert.equal(await quiet, null, 'no new-thread-message in the destination');
    assert.equal(await quietHere, null, 'nor in the source');

    for (const id of [root, r1, r2, r3, loose]) assert.equal(row(id).channel_id, other.id);
    for (const id of [r1, r2, r3]) assert.equal(row(id).thread_id, root, 'still replies in the same thread');
    assert.equal(row(left).channel_id, talk.id);
    assert.equal(row(r1).is_archived, 1, 'still protected');
    assert.equal(row(r2).destruct_at, '2099-01-01T00:00:00.000Z', 'self-destruct timer kept');
    assert.equal(row(r3).content.split('\n')[1], '/uploads/a.png', 'attachment kept');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reactions WHERE message_id = ?').get(r1).n, 1);
    for (const id of [root, r2]) {
      assert.equal(db.prepare('SELECT channel_id FROM pinned_messages WHERE message_id = ?').get(id).channel_id, other.id, 'the pin follows');
    }
    assert.equal(row(root).reply_to, null, 'the banner to a message left in talk goes');
    assert.equal(row(r3).reply_to, null, 'on a reply too');
    assert.equal(row(r2).reply_to, r1, 'a banner to a reply that came along stays');

    assert.equal(threadNotify.newCounts(db, bob.id, [{ id: root, userId: bob.id }]).get(root), 0, 'bob stays caught up');
    assert.equal(threadNotify.newCounts(db, mod.id, [{ id: root, userId: bob.id }]).get(root), 1, 'mod still has reply 3 to read');

    const there = await history(B2, other.code);
    const moved = there.messages.find((m) => m.id === root);
    assert.ok(moved, 'the message is in the destination feed');
    assert.equal(moved.thread.count, 3, 'reply count');
    assert.equal(moved.thread.lastReplyId, r3, 'latest activity');
    assert.ok(!there.messages.some((m) => [r1, r2, r3].includes(m.id)), 'replies stay out of the feed');
    const here = await history(B, talk.code);
    assert.ok(!here.messages.some((m) => [root, loose, r1, r2, r3].includes(m.id)), 'nothing left in the source feed');

    const thread = await new Promise((res) => {
      B2.once('thread-messages', res);
      B2.emit('get-thread-messages', { parentId: root });
    });
    assert.deepStrictEqual(thread.messages.map((m) => m.id), [r1, r2, r3]);
    B2.disconnect();
  });

  await t.test('a reply selected along with its root moves once', async () => {
    const root = post(talk.id, admin.id, 'root');
    const r1 = post(talk.id, bob.id, 'r1', root);
    const r2 = post(talk.id, bob.id, 'r2', root);
    const r = await move(A, talk.code, other.code, [r1, root, r2, r1]);
    assert.deepStrictEqual(r, { success: true, moved: 1, brought: 2, kept: 0 });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE id IN (?, ?, ?) AND channel_id = ?').get(root, r1, r2, other.id).n, 3);
    assert.equal(row(r1).thread_id, root);
  });

  await t.test('a reply whose root is not selected stays in its thread', async () => {
    const root = post(talk.id, admin.id, 'root that stays');
    const reply = post(talk.id, bob.id, 'a reply', root);
    const loose = post(talk.id, bob.id, 'loose');
    const gone = h.next(B, 'messages-moved', (d) => d && d.messageIds.includes(loose));
    const r = await move(A, talk.code, other.code, [loose, reply]);
    assert.deepStrictEqual(r, { success: true, moved: 1, brought: 0, kept: 1 });
    assert.deepStrictEqual((await gone).messageIds, [loose]);
    assert.equal(row(loose).channel_id, other.id);
    assert.deepStrictEqual([row(reply).channel_id, row(reply).thread_id], [talk.id, root], 'left where it was');

    const only = await move(A, talk.code, other.code, [reply]);
    assert.match(only.error || '', /replies in a thread/);
    assert.equal(row(reply).channel_id, talk.id);
    assert.match((await move(A, talk.code, other.code, [root, loose])).error || '', /not found in the source channel/, 'a message already moved');
    assert.equal(row(root).channel_id, talk.id, 'nothing moved');
  });

  await t.test('two moves at once: one wins and the thread stays together', async () => {
    const third = await makeChannel('third');
    const root = post(talk.id, admin.id, 'contested');
    const r1 = post(talk.id, bob.id, 'r1', root);
    const [x, y] = await Promise.all([move(A, talk.code, other.code, [root]), move(M, talk.code, third.code, [root])]);
    assert.equal([x, y].filter((r) => r && r.success).length, 1, 'exactly one wins');
    assert.match(x.error || y.error, /not found in the source channel/);
    assert.equal(row(root).channel_id, row(r1).channel_id, 'the reply went with its root');
    assert.ok([other.id, third.id].includes(row(root).channel_id));
  });

  await t.test('a moved thread can be replied to in its new channel', async () => {
    const root = post(talk.id, bob.id, 'moving on');
    post(talk.id, admin.id, 'old reply', root);
    assert.ok((await move(A, talk.code, other.code, [root])).success);
    B.emit('enter-channel', { code: other.code });
    await wait(150);
    const live = h.next(B, 'new-thread-message', (d) => d && d.parentId === root);
    B.emit('send-thread-message', { parentId: root, content: 'a new reply' });
    const d = await live;
    assert.ok(d, 'the new reply goes out');
    assert.equal(d.channelCode, other.code);
    assert.equal(db.prepare('SELECT channel_id FROM messages WHERE thread_id = ? ORDER BY id DESC LIMIT 1').get(root).channel_id, other.id);
  });

  await t.test('role menus stay where they are', async () => {
    const menu = post(talk.id, admin.id, 'pick a role');
    const loose = post(talk.id, admin.id, 'a plain message');
    db.prepare("INSERT INTO role_menus (message_id, channel_id, created_by, title, data) VALUES (?, ?, ?, 't', '[]')").run(menu, talk.id, admin.id);
    assert.match((await move(A, talk.code, other.code, [loose, menu])).error || '', /Role menus/);
    assert.equal(row(menu).channel_id, talk.id);
    assert.equal(row(loose).channel_id, talk.id, 'nothing moved');
    assert.equal(db.prepare('SELECT channel_id FROM role_menus WHERE message_id = ?').get(menu).channel_id, talk.id);
  });

  await t.test('a forum topic paired with a Discord post stays where it is', async () => {
    const topic = post(talk.id, bob.id, 'paired topic');
    const reply = post(talk.id, admin.id, 'a reply', topic);
    db.prepare(`INSERT INTO ferry_forum_threads (topic_message_id, channel_id, guild_id, discord_forum_id, discord_thread_id, origin)
      VALUES (?, ?, 'g', 'f', 't1', 'haven')`).run(topic, talk.id);
    assert.match((await move(A, talk.code, other.code, [topic])).error || '', /Discord/);
    assert.equal(row(topic).channel_id, talk.id);
    assert.equal(row(reply).channel_id, talk.id);
    assert.equal(db.prepare('SELECT channel_id FROM ferry_forum_threads WHERE topic_message_id = ?').get(topic).channel_id, talk.id, 'still paired');
  });

  await t.test('a blog forum takes and gives whole topics, forum to forum only (#5809)', async () => {
    const blog = await makeChannel('journal');
    for (const permission of ['forum', 'forum_blog']) {
      A.emit('toggle-channel-permission', { code: blog.code, permission });
      await wait(150);
    }
    const shelf = await makeChannel('shelf');
    A.emit('toggle-channel-permission', { code: shelf.code, permission: 'forum' });
    await wait(150);
    const entry = post(blog.id, admin.id, 'a post');
    const more = post(blog.id, admin.id, 'more of the post', entry);
    const comment = post(blog.id, bob.id, 'a comment', entry);
    const chat = post(talk.id, bob.id, 'chat line');
    assert.match((await move(A, blog.code, talk.code, [entry])).error || '', /blog forum/, 'not out to a chat channel');
    assert.match((await move(A, talk.code, blog.code, [chat])).error || '', /blog forum/, 'not in from a chat channel');
    assert.match((await move(A, blog.code, shelf.code, [comment])).error || '', /staying put|whole topics/, 'not a reply on its own');
    assert.equal(row(entry).channel_id, blog.id);
    assert.equal(row(chat).channel_id, talk.id);

    const done = await move(A, blog.code, shelf.code, [entry]);
    assert.ok(!done.error, done.error);
    for (const id of [entry, more, comment]) assert.equal(row(id).channel_id, shelf.id, 'the topic moves with its post and comments');
    const back = await move(A, shelf.code, blog.code, [entry]);
    assert.ok(!back.error, back.error);
    assert.equal(row(comment).channel_id, blog.id, 'and back into the blog forum');
  });

  await t.test('a topic moved to another forum keeps only the tags that forum has (#5809)', async () => {
    const bugs = await makeChannel('bugs');
    const ideas = await makeChannel('ideas');
    for (const ch of [bugs, ideas]) {
      A.emit('toggle-channel-permission', { code: ch.code, permission: 'forum' });
      await wait(150);
    }
    db.prepare('UPDATE channels SET forum_tags = ? WHERE id = ?').run(JSON.stringify([{ name: 'crash' }, { name: 'ui' }]), bugs.id);
    db.prepare('UPDATE channels SET forum_tags = ? WHERE id = ?').run(JSON.stringify([{ name: 'ui' }, { name: 'later' }]), ideas.id);
    const topic = post(bugs.id, bob.id, 'make the button blue');
    db.prepare('UPDATE messages SET title = ?, tags = ? WHERE id = ?').run('Blue button', JSON.stringify(['crash', 'ui']), topic);
    const reply = post(bugs.id, admin.id, 'not a bug', topic);
    const res = await move(A, bugs.code, ideas.code, [topic]);
    assert.ok(res.success, res.error);
    const moved = db.prepare('SELECT channel_id, title, tags FROM messages WHERE id = ?').get(topic);
    assert.equal(moved.channel_id, ideas.id);
    assert.equal(moved.title, 'Blue button', 'the title comes along');
    assert.deepEqual(JSON.parse(moved.tags), ['ui'], 'the old forum\'s other tag goes');
    assert.equal(row(reply).channel_id, ideas.id, 'the replies come along');
  });

  await t.test('each move is in the audit log, naming where it went', async () => {
    await wait(100);
    const rows = db.prepare("SELECT actor_id, target_type, target_id, target_name, details FROM audit_log WHERE action = 'messages_move' ORDER BY id").all();
    assert.equal(rows.length, 8, 'one per move that went through, none for refused ones');
    assert.equal(rows[0].actor_id, mod.id);
    assert.equal(rows[0].target_type, 'channel');
    assert.equal(rows[0].target_id, other.id);
    assert.equal(rows[0].target_name, 'other');
    const details = JSON.parse(rows[0].details);
    assert.equal(details.fromChannel, 'talk');
    assert.equal(details.messages, 2);
    assert.equal(details.broughtReplies, 3);
    assert.equal(details.messageIds.length, 2);
    assert.equal(JSON.parse(rows[2].details).messages, 1, 'a reply that stayed is not counted');
  });
});
