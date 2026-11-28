'use strict';

/**
 * The welcome message a new member gets. {total} counts the members with
 * them, the picture they pick on the sign up form goes on the message when
 * the admin turned that on (the same upload, linked, never a copy), and the
 * greeted name carries what the client needs to open their profile card.
 *
 *   node --test test/welcomeMessage.integration.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { createHarness, wait } = require('./socketServerHarness');

const PORT = 3771;
const h = createHarness(PORT, 'welcome-message');
test.before(() => h.start());
test.after(() => h.stop());

// A 1x1 PNG, enough for the avatar upload to accept.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

async function uploadAvatar(token, signup) {
  const form = new FormData();
  if (signup) form.append('signup', '1');
  form.append('avatar', new Blob([PNG], { type: 'image/png' }), 'a.png');
  const res = await fetch(`http://localhost:${PORT}/api/upload-avatar`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form,
  });
  return (await res.json()).url;
}

test('a sign up picture and the member count reach the welcome message', async () => {
  const admin = await h.register('admin');
  const A = await h.connect(admin.token);
  const made = h.next(A, 'channels-list', (chs) => Array.isArray(chs) && chs.some((c) => c.name === 'lobby'));
  A.emit('create-channel', { name: 'lobby' });
  // A new channel posts welcome messages unless the admin turns them off.
  const lobby = (await made).find((c) => c.name === 'lobby');
  A.emit('update-server-setting', { key: 'welcome_message', value: 'Hi {user}, member {total}!' });
  A.emit('update-server-setting', { key: 'welcome_attach_avatar', value: 'true' });
  A.emit('enter-channel', { code: lobby.code });
  await wait(300);

  const greeted = h.next(A, 'welcome-message', (d) => d.message.welcomeName === 'newbie');
  const newbie = await h.register('newbie');
  const { message } = await greeted;
  assert.strictEqual(message.content, 'Hi newbie, member 2!', 'the admin and the newcomer');
  assert.strictEqual(message.persona_avatar, null, 'no picture yet');

  const attached = h.next(A, 'welcome-avatar');
  const url = await uploadAvatar(newbie.token, true);
  assert.deepStrictEqual(await attached, { channelCode: lobby.code, messageId: message.id, avatar: url });

  const again = h.next(A, 'welcome-avatar', () => true, 1000);
  await uploadAvatar(newbie.token, true);
  assert.strictEqual(await again, null, 'only the first picture, only once');

  const history = h.next(A, 'message-history', (d) => d.channelCode === lobby.code);
  A.emit('get-messages', { code: lobby.code });
  const saved = (await history).messages.find((m) => m.id === message.id);
  assert.strictEqual(saved.persona_avatar, url, 'the same upload, linked');
  assert.strictEqual(saved.welcomeName, 'newbie');

  const later = await h.register('later');
  const notSignup = h.next(A, 'welcome-avatar', () => true, 1000);
  await uploadAvatar(later.token, false);
  assert.strictEqual(await notSignup, null, 'a picture from Edit Profile is not attached');

  A.emit('update-server-setting', { key: 'welcome_attach_avatar', value: 'false' });
  await wait(200);
  const plain = await h.register('plain');
  const off = h.next(A, 'welcome-avatar', () => true, 1000);
  await uploadAvatar(plain.token, true);
  assert.strictEqual(await off, null, 'nothing is attached while the setting is off');
});
