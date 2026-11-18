'use strict';

/**
 * Profile banner color. A member picks a color, or leaves it to follow the
 * color their avatar gives; with neither the card uses their name color.
 * Both colors end up in a style attribute on everyone's screen, so only an
 * exact #rrggbb is ever stored or handed out.
 *
 *   node --test test/profileBannerColor.integration.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { io } = require('socket.io-client');
const { createHarness } = require('./socketServerHarness');

const PORT = 3537;
const h = createHarness(PORT, 'profile-banner-color');
test.before(() => h.start());
test.after(() => h.stop());

// A 1x1 PNG, enough for the avatar upload to accept.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

function uploadAvatar(token, avatarColor) {
  const form = new FormData();
  if (avatarColor !== undefined) form.append('avatarColor', avatarColor);
  form.append('avatar', new Blob([PNG], { type: 'image/png' }), 'a.png');
  return fetch(`http://localhost:${PORT}/api/upload-avatar`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form,
  });
}

async function card(sock, userId) {
  const got = h.next(sock, 'user-profile', (p) => p.id === userId);
  sock.emit('get-user-profile', { userId });
  return got;
}

// Send a banner color and report what came back: the saved color, or the
// error text.
async function setBanner(sock, color) {
  const saved = h.next(sock, 'banner-color-updated');
  const refused = h.next(sock, 'error-msg');
  sock.emit('set-banner-color', { color });
  const result = await Promise.race([saved.then((d) => d && { saved: d.color }), refused.then((e) => e && { error: e })]);
  return result;
}

test('a picked color is saved, shown on the card, and comes back with the session', async () => {
  const me = await h.register('painter');
  const other = await h.register('viewer');
  const sock = await h.connect(me.token);
  const viewer = await h.connect(other.token);

  assert.deepStrictEqual(await setBanner(sock, '#3A7BFF'), { saved: '#3a7bff' }, 'stored lowercase');
  assert.strictEqual((await card(viewer, me.id)).bannerColor, '#3a7bff');

  const again = io(`http://localhost:${PORT}`, { auth: { token: me.token }, transports: ['websocket'], forceNew: true });
  const info = await new Promise((res) => {
    const timer = setTimeout(() => res(null), 5000);
    again.once('session-info', (d) => { clearTimeout(timer); res(d); });
  });
  again.disconnect();
  assert.strictEqual(info.bannerColor, '#3a7bff');

  assert.deepStrictEqual(await setBanner(sock, null), { saved: null }, 'null goes back to following the avatar');
  assert.strictEqual((await card(viewer, me.id)).bannerColor, null, 'no avatar, so the card uses the name color');
});

test('anything but an exact #rrggbb is refused and leaves the color alone', async () => {
  const me = await h.register('mallory');
  const sock = await h.connect(me.token);
  assert.deepStrictEqual(await setBanner(sock, '#112233'), { saved: '#112233' });

  const attempts = [
    'red', '#fff', '#11223344', '#12345g', '112233', ' #112233x',
    '#000000;background:url(https://evil.example/x)',
    '#000000)" onmouseover="alert(1)',
    'url(javascript:alert(1))', 'expression(alert(1))', 'var(--accent)',
    '#000000\n', '', 123, {}, [], true,
  ];
  for (const bad of attempts) {
    const r = await setBanner(sock, bad);
    assert.ok(r && r.error, `refused: ${JSON.stringify(bad)}`);
  }
  // A missing color is not a reset either.
  sock.emit('set-banner-color', {});
  sock.emit('set-banner-color', 'x');
  assert.strictEqual((await card(sock, me.id)).bannerColor, '#112233');
});

test('the avatar color is the default banner, only while there is an avatar', async () => {
  const me = await h.register('photog');
  const sock = await h.connect(me.token);

  let r = await uploadAvatar(me.token, '#C0FFEE');
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await card(sock, me.id)).bannerColor, '#c0ffee', 'follows the avatar');

  assert.deepStrictEqual(await setBanner(sock, '#010203'), { saved: '#010203' });
  assert.strictEqual((await card(sock, me.id)).bannerColor, '#010203', 'a picked color wins');
  await setBanner(sock, null);

  // A malformed color from the upload is dropped, not stored.
  r = await uploadAvatar(me.token, 'red;background:url(x)');
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await card(sock, me.id)).bannerColor, null);

  await uploadAvatar(me.token, '#abcdef');
  assert.strictEqual((await card(sock, me.id)).bannerColor, '#abcdef');
  r = await fetch(`http://localhost:${PORT}/api/remove-avatar`, {
    method: 'POST', headers: { Authorization: `Bearer ${me.token}`, 'Content-Type': 'application/json' },
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await card(sock, me.id)).bannerColor, null, 'removing the avatar drops its color');
});
