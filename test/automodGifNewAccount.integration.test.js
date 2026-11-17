'use strict';

/**
 * The new-account link wait is for links people paste. A GIF sent from the
 * GIF picker is a link to the GIF service's image host, and a new member who
 * tried the picker used to be struck and then muted for it.
 *
 *   node --test test/automodGifNewAccount.integration.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { createHarness, wait } = require('./socketServerHarness');

const h = createHarness(3505, 'automod-gif');

test.before(() => h.start());
test.after(() => h.stop());

test('a new account can send GIFs but not other links', async () => {
  const admin = await h.register('admin');
  const bob = await h.register('bob');
  const A = await h.connect(admin.token);
  const B = await h.connect(bob.token);

  A.emit('update-server-setting', { key: 'automod_enabled', value: 'true' });
  A.emit('update-server-setting', { key: 'automod_link_min_account_hours', value: '24' });
  const made = h.next(A, 'channels-list', (chs) => Array.isArray(chs) && chs.some((c) => c.name === 'chat'));
  A.emit('create-channel', { name: 'chat' });
  const chat = (await made).find((c) => c.name === 'chat');
  B.emit('join-channel', { code: chat.code });
  await wait(300);
  B.emit('enter-channel', { code: chat.code });
  await wait(200);

  const gif = 'https://media4.giphy.com/media/abc123/giphy.gif';
  const got = h.next(B, 'new-message', (d) => d && d.message && d.message.content === gif);
  B.emit('send-message', { code: chat.code, content: gif });
  assert.ok(await got, 'the GIF went through');

  const refused = h.next(B, 'new-message', (d) => d && d.message && d.message.content.includes('example.org'), 1500);
  B.emit('send-message', { code: chat.code, content: 'look https://example.org/page' });
  assert.strictEqual(await refused, null, 'a pasted link still waits');
});
