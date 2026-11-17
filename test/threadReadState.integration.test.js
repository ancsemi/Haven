'use strict';

/**
 * The thread mention bell is kept per device. A device asks on startup how
 * far this account has read in the threads it remembers mentions in, so a
 * thread read on another device does not ring again days later. Opening a
 * thread on one device also tells the others right away.
 *
 *   node --test test/threadReadState.integration.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { createHarness, wait } = require('./socketServerHarness');

const h = createHarness(3509, 'thread-read-state');

test.before(() => h.start());
test.after(() => h.stop());

test('read state answers how far a thread was read, and other devices hear about it', async () => {
  const admin = await h.register('admin');
  const bob = await h.register('bob');
  const desk = await h.connect(admin.token);
  const laptop = await h.connect(admin.token);
  const B = await h.connect(bob.token);

  const made = h.next(desk, 'channels-list', (chs) => Array.isArray(chs) && chs.some((c) => c.name === 'talk'));
  desk.emit('create-channel', { name: 'talk' });
  const talk = (await made).find((c) => c.name === 'talk');
  B.emit('join-channel', { code: talk.code });
  await wait(300);
  for (const s of [desk, B]) s.emit('enter-channel', { code: talk.code });
  await wait(200);

  const parent = h.next(desk, 'new-message', (d) => d && d.message && d.message.content === 'plans?');
  desk.emit('send-message', { code: talk.code, content: 'plans?' });
  const parentId = (await parent).message.id;
  B.emit('send-thread-message', { parentId, content: 'saturday @admin' });
  await wait(400);

  let state = await h.ask(laptop, 'get-thread-read-state', { parentIds: [parentId, 999999] });
  assert.deepStrictEqual(state.reads, { [parentId]: 0 }, 'not read yet; unknown threads left out');

  const heard = h.next(laptop, 'thread-read', (d) => d && d.parentId === parentId);
  desk.emit('get-thread-messages', { parentId });
  assert.ok(await heard, 'the other device is told');
  state = await h.ask(laptop, 'get-thread-read-state', { parentIds: [parentId] });
  assert.ok(state.reads[parentId] > parentId, 'read up to the reply');

  const outsider = await h.register('carol');
  const C = await h.connect(outsider.token);
  state = await h.ask(C, 'get-thread-read-state', { parentIds: [parentId] });
  assert.deepStrictEqual(state.reads, {}, 'nothing about a channel she is not in');
});
