'use strict';

/**
 * Protected messages survive every delete: their author, the admin, a bulk
 * delete, a ban scrub, the clear and delete timers, self-destruct, deleting
 * the channel and deleting the account. Unprotected messages beside them go
 * as before.
 *
 *   node --test test/protectedMessages.integration.test.js
 *
 * Takes a little over a minute: the channel timers are swept once a minute.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createHarness, wait } = require('./socketServerHarness');

const h = createHarness(3428, 'protected');
const REFUSAL = 'This message is protected. Unprotect it first.';

let db;
test.before(async () => {
  await h.start();
  db = new Database(path.join(h.dataDir, 'haven.db'));
  db.pragma('busy_timeout = 5000');
});
test.after(() => {
  if (db) db.close();
  return h.stop();
});

const row = (id) => db.prepare('SELECT id, user_id, content, is_archived, destruct_at FROM messages WHERE id = ?').get(id);

async function idOf(content) {
  for (let i = 0; i < 40; i++) {
    const r = db.prepare('SELECT id FROM messages WHERE content = ?').get(content);
    if (r) return r.id;
    await wait(100);
  }
  throw new Error(`message never arrived: ${content}`);
}

async function send(sock, code, content, extra = {}) {
  sock.emit('send-message', { code, content, ...extra });
  return idOf(content);
}

async function protect(sock, code, messageId) {
  sock.emit('enter-channel', { code });
  await wait(100);
  const done = h.next(sock, 'message-archived', (d) => d && d.messageId === messageId);
  sock.emit('archive-message', { messageId });
  assert.ok(await done, `message ${messageId} was protected`);
}

async function makeChannel(sock, name) {
  const created = h.next(sock, 'channels-list', (chs) => Array.isArray(chs) && chs.some((c) => c.name === name));
  sock.emit('create-channel', { name });
  return (await created).find((c) => c.name === name);
}

async function until(check, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await wait(1000);
  }
  return check();
}

test('protected messages survive every delete path', async () => {
  const admin = await h.register('admin');
  const bob = await h.register('bob');
  const carol = await h.register('carol');
  const dave = await h.register('dave');
  const A = await h.connect(admin.token);
  const B = await h.connect(bob.token);
  const C = await h.connect(carol.token);
  const D = await h.connect(dave.token);

  const ev = await makeChannel(A, 'evidence');
  for (const s of [B, C, D]) s.emit('join-channel', { code: ev.code });
  await wait(400);
  B.emit('enter-channel', { code: ev.code });
  A.emit('enter-channel', { code: ev.code });
  await wait(200);

  // Author and admin deletes are refused.
  const bobKept = await send(B, ev.code, 'bob: kept');
  const bobGone = await send(B, ev.code, 'bob: goes');
  await protect(A, ev.code, bobKept);
  let refused = h.next(B, 'error-msg', (m) => m === REFUSAL);
  B.emit('delete-message', { messageId: bobKept, channelCode: ev.code });
  assert.ok(await refused, 'the author is told it is protected');
  refused = h.next(A, 'error-msg', (m) => m === REFUSAL);
  A.emit('delete-message', { messageId: bobKept, channelCode: ev.code });
  assert.ok(await refused, 'the admin is told it is protected');
  assert.ok(row(bobKept), 'still there after the author and admin tried');
  // Nor can the author rewrite or blank it.
  refused = h.next(B, 'error-msg', (m) => m === REFUSAL);
  B.emit('edit-message', { messageId: bobKept, channelCode: ev.code, content: 'rewritten' });
  assert.ok(await refused, 'an edit is refused too');
  assert.strictEqual(row(bobKept).content, 'bob: kept', 'the text is unchanged');

  // A single delete of an unprotected message still works.
  const deleted = h.next(A, 'message-deleted', (d) => d && d.messageId === bobGone);
  B.emit('delete-message', { messageId: bobGone, channelCode: ev.code });
  assert.ok(await deleted);
  assert.strictEqual(row(bobGone), undefined);

  // Bulk delete keeps the protected one, and a thread head holding a protected reply.
  const bulkGone = await send(A, ev.code, 'admin: bulk goes');
  const head = await send(A, ev.code, 'admin: thread head');
  A.emit('send-thread-message', { parentId: head, content: 'admin: protected reply' });
  const reply = await idOf('admin: protected reply');
  A.emit('send-thread-message', { parentId: head, content: 'admin: plain reply goes' });
  const replyGone = await idOf('admin: plain reply goes');
  await protect(A, ev.code, reply);
  refused = h.next(A, 'error-msg', (m) => /protected reply/.test(m));
  A.emit('delete-message', { messageId: head, channelCode: ev.code });
  assert.ok(await refused, 'a thread head holding a protected reply is refused');
  const bulk = await h.ask(A, 'delete-messages', { code: ev.code, messageIds: [bobKept, bulkGone, head, reply, replyGone] });
  assert.ok(bulk && bulk.success, JSON.stringify(bulk));
  assert.strictEqual(bulk.deleted, 2);
  assert.ok(row(bobKept) && row(head) && row(reply), 'protected, and the head holding one, stay');
  assert.strictEqual(row(bulkGone), undefined);
  assert.strictEqual(row(replyGone), undefined, 'an unprotected reply under the kept head goes');

  // Ban with scrub.
  C.emit('enter-channel', { code: ev.code });
  await wait(100);
  const carolKept = await send(C, ev.code, 'carol: kept');
  const carolGone = await send(C, ev.code, 'carol: goes');
  await protect(A, ev.code, carolKept);
  A.emit('ban-user', { userId: carol.id, scrubMessages: true });
  assert.ok(await until(() => !row(carolGone), 5000), 'the ban scrub removed the unprotected message');
  assert.ok(row(carolKept), 'the ban scrub left the protected message');

  // Self-destruct: a protected message's timer stops, and so does a thread
  // head's when its reply is protected.
  const sdKept = await send(A, ev.code, 'admin: self-destruct kept', { destructSeconds: 4 });
  const sdGone = await send(A, ev.code, 'admin: self-destruct goes', { destructSeconds: 1 });
  const sdHead = await send(A, ev.code, 'admin: self-destruct head', { destructSeconds: 4 });
  A.emit('send-thread-message', { parentId: sdHead, content: 'admin: reply under timed head' });
  const sdReply = await idOf('admin: reply under timed head');
  await protect(A, ev.code, sdKept);
  await protect(A, ev.code, sdReply);
  assert.ok(await until(() => !row(sdGone), 6000), 'the unprotected self-destruct message went');
  assert.ok(await until(() => row(sdKept)?.destruct_at === null && row(sdHead)?.destruct_at === null, 5000), 'protected-message timers were turned off at their deadlines');
  assert.ok(row(sdKept), 'the protected self-destruct message stayed');
  assert.strictEqual(row(sdKept).destruct_at, null);
  assert.ok(row(sdHead), 'the timed head holding a protected reply stayed');
  assert.strictEqual(row(sdHead).destruct_at, null, 'its timer was turned off');

  // Deleting the channel is refused while it holds protected messages.
  refused = h.next(A, 'error-msg', (m) => /holds protected messages/.test(m));
  A.emit('delete-channel', { code: ev.code });
  assert.ok(await refused, 'delete-channel is refused');
  assert.ok(db.prepare('SELECT 1 FROM channels WHERE id = ?').get(ev.id), 'the channel is still there');

  // Account deletion keeps the protected message, unattributed.
  D.emit('enter-channel', { code: ev.code });
  await wait(100);
  const daveKept = await send(D, ev.code, 'dave: kept');
  const daveGone = await send(D, ev.code, 'dave: goes');
  await protect(A, ev.code, daveKept);
  const gone = await h.ask(D, 'self-delete-account', { password: 'access12345', scrubMessages: true });
  assert.ok(gone && gone.success, JSON.stringify(gone));
  assert.strictEqual(row(daveGone), undefined, 'the scrub removed the unprotected message');
  assert.ok(row(daveKept), 'the protected message outlived the account');
  assert.strictEqual(row(daveKept).user_id, null);

  // Timers: a clear timer and a delete timer, both due now. The sweep runs
  // once a minute.
  const clr = await makeChannel(A, 'cleared');
  const del = await makeChannel(A, 'expiring');
  const clrKept = await send(A, clr.code, 'clear: kept');
  const clrGone = await send(A, clr.code, 'clear: goes');
  const delKept = await send(A, del.code, 'delete: kept');
  const delGone = await send(A, del.code, 'delete: goes');
  await protect(A, clr.code, clrKept);
  await protect(A, del.code, delKept);
  db.prepare("UPDATE channels SET expires_at = datetime('now', '-1 minute'), auto_delete_mode = 'clear', auto_delete_interval_hours = 1 WHERE id = ?").run(clr.id);
  db.prepare("UPDATE channels SET expires_at = datetime('now', '-1 minute'), auto_delete_mode = 'delete' WHERE id = ?").run(del.id);
  assert.ok(await until(() => !row(clrGone) && !row(delGone), 75000), 'both timers ran');
  assert.ok(row(clrKept), 'the clear timer left the protected message');
  assert.ok(row(delKept), 'the delete timer left the protected message');
  const kept = db.prepare('SELECT id, expires_at FROM channels WHERE id = ?').get(del.id);
  assert.ok(kept, 'the delete timer kept the channel');
  assert.strictEqual(kept.expires_at, null, 'and turned its timer off');

  // Unprotecting is the way back: then the delete goes through.
  A.emit('enter-channel', { code: ev.code });
  await wait(100);
  const unprotected = h.next(A, 'message-unarchived', (d) => d && d.messageId === bobKept);
  A.emit('unarchive-message', { messageId: bobKept });
  assert.ok(await unprotected);
  const finallyGone = h.next(A, 'message-deleted', (d) => d && d.messageId === bobKept);
  A.emit('delete-message', { messageId: bobKept, channelCode: ev.code });
  assert.ok(await finallyGone);
  assert.strictEqual(row(bobKept), undefined);
});
