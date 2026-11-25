'use strict';

/**
 * Message counts over the socket: anyone may count their own messages;
 * someone else's, and the activity, take what a member's moderation history
 * takes, and the activity covers only channels the asker can read.
 *
 *   node --test test/messageStats.integration.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { createHarness, wait } = require('./socketServerHarness');

const h = createHarness(3664, 'message-stats');

test.before(() => h.start());
test.after(() => h.stop());

test('message counts go to the member themselves and to staff', async () => {
  const admin = await h.register('admin');
  const bob = await h.register('bobeight');
  const carol = await h.register('caroleight');
  const A = await h.connect(admin.token);
  const B = await h.connect(bob.token);
  const C = await h.connect(carol.token);

  const made = h.next(A, 'channels-list', (chs) => Array.isArray(chs) && chs.some((c) => c.name === 'lobby'));
  A.emit('create-channel', { name: 'lobby' });
  const lobby = (await made).find((c) => c.name === 'lobby');
  B.emit('join-channel', { code: lobby.code });
  await wait(300);
  B.emit('enter-channel', { code: lobby.code });
  await wait(150);
  for (const content of ['one', 'two']) {
    const seen = h.next(B, 'new-message', (d) => d && d.message && d.message.content === content);
    B.emit('send-message', { code: lobby.code, content });
    await seen;
  }

  const own = await h.ask(B, 'get-member-message-stats', { userId: bob.id });
  assert.ok(own.ok, JSON.stringify(own));
  assert.strictEqual(own.channel, 2);
  assert.strictEqual(own.total, 2);
  assert.match(own.lastAt, /Z$/);
  assert.match((await h.ask(C, 'get-member-message-stats', { userId: bob.id })).error, /permission/);
  assert.strictEqual((await h.ask(A, 'get-member-message-stats', { userId: bob.id })).total, 2);
  assert.match((await h.ask(A, 'get-member-message-stats', { userId: 999999 })).error, /not found/);

  assert.match((await h.ask(C, 'get-message-activity', {})).error, /permission/);
  const all = await h.ask(A, 'get-message-activity', { days: 7, utcOffsetMinutes: -300 });
  assert.ok(all.ok, JSON.stringify(all));
  assert.strictEqual(all.byDay.length, 7);
  assert.strictEqual(all.byHour.length, 24);
  assert.ok(all.total >= 2);
  assert.strictEqual((await h.ask(A, 'get-message-activity', { channelCode: lobby.code })).total, 2);
  assert.ok((await h.ask(A, 'get-message-activity', { days: 0 })).error);

  // A moderator counts the channels they are in: the open one, but not a
  // private one they were never added to. (Removing carol from the lobby
  // would not last: someone left in no channel at all is put back in the
  // default ones.)
  const mod = (await h.ask(A, 'get-roles', {})).roles.find((r) => r.name === 'Mod');
  assert.ok((await h.ask(A, 'assign-role', { userId: carol.id, roleId: mod.id })).success);
  assert.strictEqual((await h.ask(C, 'get-member-message-stats', { userId: bob.id })).total, 2);
  assert.strictEqual((await h.ask(C, 'get-message-activity', { channelCode: lobby.code })).total, 2);
  const madePrivate = h.next(A, 'channels-list', (chs) => Array.isArray(chs) && chs.some((c) => c.name === 'hideout'));
  A.emit('create-channel', { name: 'hideout', isPrivate: true });
  const hideout = (await madePrivate).find((c) => c.name === 'hideout');
  assert.ok((await h.ask(A, 'get-message-activity', { channelCode: hideout.code })).ok);
  assert.match((await h.ask(C, 'get-message-activity', { channelCode: hideout.code })).error, /not found/);
});
