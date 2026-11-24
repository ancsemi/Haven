'use strict';

/**
 * A bot account hears of deleted and edited messages in channels it can
 * read: whose, who and when always, and the text only once the admin turns
 * on "Let bots see the text of deleted and edited messages".
 *
 *   node --test test/messageLog.integration.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { createHarness, wait } = require('./socketServerHarness');

const h = createHarness(3663, 'message-log');

test.before(() => h.start());
test.after(() => h.stop());

async function makeChannel(A, name) {
  const made = h.next(A, 'channels-list', (chs) => Array.isArray(chs) && chs.some((c) => c.name === name));
  A.emit('create-channel', { name });
  return (await made).find((c) => c.name === name);
}

async function say(sock, code, content) {
  const seen = h.next(sock, 'new-message', (d) => d && d.message && d.message.content === content);
  sock.emit('send-message', { code, content });
  return (await seen).message.id;
}

test('a bot hears of deletes and edits, with the text only when the admin allows it', async () => {
  const admin = await h.register('admin');
  const bob = await h.register('bobseven');
  const A = await h.connect(admin.token);
  const B = await h.connect(bob.token);
  const lobby = await makeChannel(A, 'lobby');

  // A new bot joins the channels a new member gets, so the one it must not
  // hear from is made after it.
  const made = await h.ask(A, 'create-bot', { name: 'logbot' });
  const R = await h.connect(made.token);
  const secret = await makeChannel(A, 'secret');
  for (const ch of [lobby, secret]) B.emit('join-channel', { code: ch.code });
  R.emit('join-channel', { code: lobby.code });
  await wait(300);
  for (const sock of [A, B]) sock.emit('enter-channel', { code: lobby.code });
  await wait(200);

  const deletes = [];
  const edits = [];
  R.on('mod-message-deleted', (e) => deletes.push(e));
  R.on('mod-message-edited', (e) => edits.push(e));

  assert.match((await h.ask(B, 'subscribe-message-changes', {})).error, /bot accounts/);
  assert.match((await h.ask(R, 'subscribe-message-changes', {})).error, /permission/);
  const mod = (await h.ask(A, 'get-roles', {})).roles.find((r) => r.name === 'Mod');
  assert.ok((await h.ask(A, 'assign-role', { userId: made.bot.id, roleId: mod.id })).success);
  assert.deepStrictEqual(await h.ask(R, 'subscribe-message-changes', {}), { ok: true, textIncluded: false });

  // Off: whose, who and when, no words.
  const first = await say(B, lobby.code, 'first words');
  B.emit('edit-message', { messageId: first, channelCode: lobby.code, content: 'second words' });
  await wait(200);
  B.emit('delete-message', { messageId: first, channelCode: lobby.code });
  await wait(200);
  assert.strictEqual(edits.length, 1);
  assert.strictEqual(edits[0].message.id, first);
  assert.strictEqual(edits[0].by.id, bob.id);
  assert.ok(!('before' in edits[0].message));
  assert.strictEqual(deletes.length, 1);
  assert.strictEqual(deletes[0].textIncluded, false);
  assert.strictEqual(deletes[0].by.id, bob.id);
  assert.strictEqual(deletes[0].channel.name, 'lobby');
  assert.deepStrictEqual(deletes[0].messages.map((m) => [m.id, m.author.id, 'content' in m]), [[first, bob.id, false]]);

  // Only the admin turns the text on.
  B.emit('update-server-setting', { key: 'bots_see_message_text', value: 'true' });
  await wait(150);
  const changed = h.next(A, 'server-setting-changed', (d) => d && d.key === 'bots_see_message_text');
  A.emit('update-server-setting', { key: 'bots_see_message_text', value: 'true' });
  await changed;

  // On: the words, and a thread reply goes with its message.
  const head = await say(B, lobby.code, 'thread head');
  const replied = h.next(B, 'new-thread-message', (d) => d && d.message && d.message.content === 'a reply');
  B.emit('send-thread-message', { parentId: head, content: 'a reply' });
  const reply = (await replied).message.id;
  const other = await say(B, lobby.code, 'another one');
  B.emit('edit-message', { messageId: other, channelCode: lobby.code, content: 'another one, edited' });
  await wait(200);
  assert.strictEqual(edits[1].message.before, 'another one');
  assert.strictEqual(edits[1].message.after, 'another one, edited');
  const bulk = await h.ask(A, 'delete-messages', { code: lobby.code, messageIds: [head, other] });
  assert.ok(bulk.success, JSON.stringify(bulk));
  await wait(150);
  assert.strictEqual(deletes.length, 2);
  assert.strictEqual(deletes[1].textIncluded, true);
  assert.strictEqual(deletes[1].by.id, admin.id);
  assert.deepStrictEqual(deletes[1].messages.map((m) => [m.id, m.content]).sort((x, y) => x[0] - y[0]),
    [[head, 'thread head'], [reply, 'a reply'], [other, 'another one, edited']].sort((x, y) => x[0] - y[0]));

  // A webhook deleting is named as one.
  const hookMade = h.next(A, 'webhook-created', (w) => w && w.name === 'Cleaner');
  A.emit('create-webhook', { channelCode: lobby.code, name: 'Cleaner' });
  const hook = await hookMade;
  const posted = await h.post(`/api/webhooks/${hook.token}`, { content: 'from the webhook' });
  assert.ok(posted.success, JSON.stringify(posted));
  const gone = await fetch(`http://localhost:3663/api/webhooks/${hook.token}/messages/${posted.message_id}`, { method: 'DELETE' });
  assert.strictEqual(gone.status, 200);
  await wait(150);
  assert.strictEqual(deletes.length, 3);
  assert.deepStrictEqual(deletes[2].by, { webhook: 'Cleaner' });
  assert.strictEqual(deletes[2].messages[0].content, 'from the webhook');

  // A channel the bot is not in stays out of it.
  B.emit('enter-channel', { code: secret.code });
  await wait(100);
  const hidden = await say(B, secret.code, 'not for the bot');
  B.emit('delete-message', { messageId: hidden, channelCode: secret.code });
  await wait(200);
  assert.strictEqual(deletes.length, 3);
});
