'use strict';

/**
 * "Merge into...": the admin folds a channel into another, for the duplicates
 * a Ferry import leaves next to channels copied by hand (src/mergeChannels.js
 * and socketHandlers/channelMerge.js).
 *
 *   node --test test/mergeChannels.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createHarness, wait } = require('./socketServerHarness');
const { normalize } = require('../src/mergeChannels');

const PORT = 3541;
const h = createHarness(PORT, 'merge-channels');

test.before(() => h.start());
test.after(() => h.stop());

const previewOf = (sock, fromCode, toCode) => h.ask(sock, 'merge-channels-preview', { fromCode, toCode });
const merge = (sock, fromCode, toCode, dropReposts = []) => h.ask(sock, 'merge-channels', { fromCode, toCode, dropReposts });

test('re-posts match on text the way a paste leaves it', () => {
  assert.equal(normalize('  hello\n\n  there  '), 'hello there');
  assert.equal(normalize(null), '');
});

test('merging a Ferry import into the channel copied by hand', async (t) => {
  const admin = await h.register('admin');
  const bob = await h.register('bob');
  const A = await h.connect(admin.token);
  const B = await h.connect(bob.token);
  const db = new Database(path.join(h.dataDir, 'haven.db'));
  db.pragma('busy_timeout = 5000');
  t.after(() => db.close());

  async function makeChannel(name) {
    A.emit('create-channel', { name });
    for (let i = 0; i < 30; i++) {
      const row = db.prepare('SELECT id, code FROM channels WHERE name = ?').get(name);
      if (row) {
        for (const s of [A, B]) { s.emit('join-channel', { code: row.code }); await wait(100); }
        return row;
      }
      await wait(100);
    }
    throw new Error(`channel ${name} was not created`);
  }

  const post = (channelId, { userId = null, content, at, discordId = null, threadId = null, replyTo = null, author = null }) =>
    Number(db.prepare(`INSERT INTO messages (channel_id, user_id, content, created_at, discord_message_id, thread_id, reply_to, webhook_username, imported_from)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(channelId, userId, content, at, discordId, threadId, replyTo, author, userId ? null : 'discord').lastInsertRowid);
  const row = (id) => db.prepare('SELECT channel_id, thread_id, reply_to FROM messages WHERE id = ?').get(id);

  await t.test('only the admin can merge', async () => {
    const x = await makeChannel('x');
    const y = await makeChannel('y');
    assert.match((await previewOf(B, x.code, y.code)).error, /admin/);
    assert.match((await merge(B, x.code, y.code)).error, /admin/);
    assert.ok(db.prepare('SELECT 1 FROM channels WHERE id = ?').get(x.id));
  });

  await t.test('the two histories become one, each Discord message once', async () => {
    const hand = await makeChannel('general');          // copied by hand, had a Ferry link
    const imported = await makeChannel('general-2');    // made by the history import

    // The hand-made copy: its own chat, a paste of a Discord message, and a
    // message Ferry relayed while it was linked.
    const live = post(hand.id, { userId: bob.id, content: 'said in Haven', at: '2026-10-01 10:00:00' });
    const pasted = post(hand.id, { userId: admin.id, content: 'welcome   to the guild', at: '2026-09-20 09:00:00' });
    const relayedHere = post(hand.id, { content: 'raid tonight', at: '2026-09-15 20:00:00', discordId: '1000000000000000003', author: 'Kira' });
    // An older relay with only the Ferry map to say which Discord message it is.
    const mappedHere = post(hand.id, { content: 'gg', at: '2026-09-16 20:00:00', author: 'Kira' });
    db.prepare("INSERT INTO ferry_message_map (haven_message_id, discord_message_id, discord_channel_id) VALUES (?, '1000000000000000004', '900000000000000001')").run(mappedHere);

    // The import: the same Discord history.
    const original = post(imported.id, { content: 'welcome to the guild', at: '2023-01-01 12:00:00', discordId: '1000000000000000001', author: 'Kira' });
    const old = post(imported.id, { content: 'first!', at: '2023-01-01 12:01:00', discordId: '1000000000000000002', author: 'Sam' });
    const dupe = post(imported.id, { content: 'raid tonight', at: '2026-09-15 20:00:00', discordId: '1000000000000000003', author: 'Kira' });
    const dupeReply = post(imported.id, { content: 'count me in', at: '2026-09-15 20:05:00', discordId: '1000000000000000005', author: 'Sam', threadId: dupe });
    const answersDupe = post(imported.id, { content: 'same', at: '2026-09-15 20:06:00', discordId: '1000000000000000006', author: 'Lee', replyTo: dupe });
    const mappedThere = post(imported.id, { content: 'gg', at: '2026-09-16 20:00:00', discordId: '1000000000000000004', author: 'Kira' });
    db.prepare("INSERT INTO reactions (message_id, user_id, emoji) VALUES (?, ?, '🔥')").run(dupe, bob.id);

    // The import's setup that should come along, and the hand copy's that stays.
    db.prepare("UPDATE channels SET discord_channel_id = '900000000000000001', topic = 'imported topic' WHERE id = ?").run(imported.id);
    db.prepare("UPDATE channels SET topic = 'my topic' WHERE id = ?").run(hand.id);
    db.prepare("INSERT INTO ferry_links (channel_id, guild_id, discord_channel_id) VALUES (?, '800000000000000001', '900000000000000001')").run(hand.id);
    db.prepare("INSERT INTO ferry_links (channel_id, guild_id, discord_channel_id) VALUES (?, '800000000000000001', '900000000000000001')").run(imported.id);
    db.prepare("INSERT INTO ferry_links (channel_id, guild_id, discord_channel_id) VALUES (?, '800000000000000001', '900000000000000002')").run(imported.id);
    db.prepare("INSERT INTO webhooks (channel_id, name, token) VALUES (?, 'raid-bot', 'tok-merge-test')").run(imported.id);

    // Bob had read all of the hand copy; the imported history must not read
    // as new to him.
    db.prepare('INSERT OR REPLACE INTO read_positions (user_id, channel_id, last_read_message_id) VALUES (?, ?, ?)').run(bob.id, hand.id, mappedHere);

    const p = await previewOf(A, imported.code, hand.code);
    assert.equal(p.counts.messages, 6);
    assert.equal(p.counts.duplicates, 2, 'one by discord id, one through the Ferry map');
    assert.equal(p.counts.webhooks, 1);
    assert.equal(p.repostCount, 1);
    assert.equal(p.reposts[0].drop.id, pasted);
    assert.equal(p.reposts[0].keep.id, original);
    assert.equal(p.reposts[0].keep.author, 'Kira');

    B.emit('enter-channel', { code: imported.code });
    await wait(150);
    const told = h.next(B, 'channel-merged');
    const r = await merge(A, imported.code, hand.code, [pasted]);
    assert.ok(r.success, JSON.stringify(r));
    assert.deepStrictEqual({ moved: r.moved, duplicates: r.duplicates, reposts: r.reposts }, { moved: 4, duplicates: 2, reposts: 1 });
    assert.deepStrictEqual(await told, { code: imported.code, into: hand.code, name: 'general' });

    assert.equal(db.prepare('SELECT 1 FROM channels WHERE id = ?').get(imported.id), undefined, 'the import is gone');
    const ch = db.prepare('SELECT topic, discord_channel_id FROM channels WHERE id = ?').get(hand.id);
    assert.equal(ch.topic, 'my topic', 'the hand copy keeps its setup');
    assert.equal(ch.discord_channel_id, '900000000000000001', 'a later history import finds the merged channel');

    for (const id of [live, relayedHere, mappedHere, original, old, dupeReply, answersDupe]) assert.equal(row(id).channel_id, hand.id, `message ${id} is in the merged channel`);
    for (const id of [pasted, dupe, mappedThere]) assert.equal(row(id), undefined, `message ${id} went`);
    assert.equal(row(dupeReply).thread_id, relayedHere, 'the reply hangs from the copy that stayed');
    assert.equal(row(answersDupe).reply_to, relayedHere, 'the answer points at the copy that stayed');
    assert.ok(db.prepare("SELECT 1 FROM reactions WHERE message_id = ? AND emoji = '🔥'").get(relayedHere), 'the reaction came along');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE channel_id = ? AND discord_message_id = ?').get(hand.id, '1000000000000000003').n, 1);

    const links = db.prepare('SELECT discord_channel_id FROM ferry_links WHERE channel_id = ? ORDER BY discord_channel_id').all(hand.id).map(l => l.discord_channel_id);
    assert.deepStrictEqual(links, ['900000000000000001', '900000000000000002'], 'no doubled bridge');
    assert.equal(db.prepare("SELECT channel_id FROM webhooks WHERE token = 'tok-merge-test'").get().channel_id, hand.id);

    const latest = db.prepare('SELECT MAX(id) AS n FROM messages WHERE channel_id = ? AND thread_id IS NULL').get(hand.id).n;
    assert.equal(db.prepare('SELECT last_read_message_id AS n FROM read_positions WHERE user_id = ? AND channel_id = ?').get(bob.id, hand.id).n, latest);
  });

  await t.test('an unticked re-post stays', async () => {
    const a = await makeChannel('lfg');
    const b = await makeChannel('lfg-2');
    const pasted = post(a.id, { userId: admin.id, content: 'need a healer', at: '2026-05-01 10:00:00' });
    post(b.id, { content: 'need a healer', at: '2024-05-01 10:00:00', discordId: '1100000000000000001', author: 'Sam' });
    // Said in Haven before the Discord message: not a re-post of it.
    const earlier = post(a.id, { userId: bob.id, content: 'lol', at: '2024-01-01 10:00:00' });
    post(b.id, { content: 'lol', at: '2024-06-01 10:00:00', discordId: '1100000000000000002', author: 'Sam' });
    const p = await previewOf(A, b.code, a.code);
    assert.deepStrictEqual(p.reposts.map(r => r.drop.id), [pasted]);
    assert.ok((await merge(A, b.code, a.code, [])).success);
    assert.equal(row(pasted).channel_id, a.id);
    assert.equal(row(earlier).channel_id, a.id);
  });

  await t.test('what cannot be merged is refused and nothing changes', async () => {
    const text = await makeChannel('text');
    const forum = await makeChannel('forum');
    db.prepare('UPDATE channels SET is_forum = 1 WHERE id = ?').run(forum.id);
    assert.match((await merge(A, forum.code, text.code)).error, /forum/);
    assert.match((await merge(A, text.code, text.code)).error, /different/);

    const parent = await makeChannel('parent');
    const sub = await makeChannel('sub');
    db.prepare('UPDATE channels SET parent_channel_id = ? WHERE id = ?').run(parent.id, sub.id);
    assert.match((await merge(A, parent.code, text.code)).error, /sub-channels/);

    const p1 = await makeChannel('prot-1');
    const p2 = await makeChannel('prot-2');
    const m1 = post(p1.id, { content: 'keep me', at: '2024-01-01 10:00:00', discordId: '1200000000000000001', author: 'Sam' });
    const m2 = post(p2.id, { content: 'keep me', at: '2024-01-01 10:00:00', discordId: '1200000000000000001', author: 'Sam' });
    db.prepare('UPDATE messages SET is_archived = 1 WHERE id IN (?, ?)').run(m1, m2);
    assert.match((await merge(A, p1.code, p2.code)).error, /protected/);
    assert.equal(row(m1).channel_id, p1.id);
    for (const c of [forum, parent, p1]) assert.ok(db.prepare('SELECT 1 FROM channels WHERE id = ?').get(c.id));
  });

  await t.test('a message that is a reply on one side and heads a thread on the other', async () => {
    const a = await makeChannel('thr-a');
    const b = await makeChannel('thr-b');
    // In the import it heads a thread; in the hand copy Ferry put it in one.
    const head = post(a.id, { content: 'patch notes', at: '2024-02-01 10:00:00', discordId: '1400000000000000001', author: 'Sam' });
    const reply = post(a.id, { content: 'nice', at: '2024-02-01 10:05:00', discordId: '1400000000000000002', author: 'Lee', threadId: head });
    const root = post(b.id, { content: 'news', at: '2024-02-01 09:00:00', discordId: '1400000000000000003', author: 'Sam' });
    const asReply = post(b.id, { content: 'patch notes', at: '2024-02-01 10:00:00', discordId: '1400000000000000001', author: 'Sam', threadId: root });
    const r = await merge(A, a.code, b.code);
    assert.ok(r.success, JSON.stringify(r));
    assert.equal(r.duplicates, 1);
    assert.equal(row(asReply), undefined, 'the reply copy went');
    assert.deepStrictEqual(row(head), { channel_id: b.id, thread_id: null, reply_to: null });
    assert.equal(row(reply).thread_id, head, 'its thread is whole');
  });

  await t.test('a protected copy in the source is the one that stays', async () => {
    const a = await makeChannel('keep-a');
    const b = await makeChannel('keep-b');
    const there = post(a.id, { content: 'evidence', at: '2024-01-01 10:00:00', discordId: '1300000000000000001', author: 'Sam' });
    const here = post(b.id, { content: 'evidence', at: '2024-01-01 10:00:00', discordId: '1300000000000000001', author: 'Sam' });
    db.prepare('UPDATE messages SET is_archived = 1 WHERE id = ?').run(there);
    assert.ok((await merge(A, a.code, b.code)).success);
    assert.equal(row(there).channel_id, b.id);
    assert.equal(row(here), undefined);
  });
});
