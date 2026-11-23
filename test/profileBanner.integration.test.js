'use strict';

/**
 * Profile banner pictures. A banner uploads like an avatar: anyone signed in
 * and not banned, held to its own size limit, with the file's bytes checked
 * against its type. The card and the session only ever hand out a local
 * /uploads/ path, so a banner can't point at an outside server.
 *
 *   node --test test/profileBanner.integration.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Database = require('better-sqlite3');
const { io } = require('socket.io-client');
const { createHarness } = require('./socketServerHarness');

const PORT = 3538;
const h = createHarness(PORT, 'profile-banner');
test.before(() => h.start());
test.after(() => h.stop());

// A 1x1 PNG, enough for the upload to accept.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

function upload(route, token, bytes, type = 'image/png', name = 'b.png') {
  const form = new FormData();
  form.append('banner', new Blob([bytes], { type }), name);
  return fetch(`http://localhost:${PORT}${route}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form,
  });
}
const uploadBanner = (token, bytes, type, name) => upload('/api/upload-banner', token, bytes, type, name);

async function card(sock, userId) {
  const got = h.next(sock, 'user-profile', (p) => p.id === userId);
  sock.emit('get-user-profile', { userId });
  return got;
}

async function sessionInfo(token) {
  const s = io(`http://localhost:${PORT}`, { auth: { token }, transports: ['websocket'], forceNew: true });
  const info = await new Promise((res) => {
    const timer = setTimeout(() => res(null), 5000);
    s.once('session-info', (d) => { clearTimeout(timer); res(d); });
  });
  s.disconnect();
  return info;
}

test('a banner uploads, shows on the card and in the session, and can be removed', async () => {
  const me = await h.register('bannerista');
  const other = await h.register('onlooker');
  const viewer = await h.connect(other.token);

  const r = await uploadBanner(me.token, PNG);
  assert.strictEqual(r.status, 200);
  const { url } = await r.json();
  assert.match(url, /^\/uploads\/[\w\-.]+\.png$/);

  assert.strictEqual((await card(viewer, me.id)).banner, url);
  assert.strictEqual((await sessionInfo(me.token)).banner, url);

  const gone = await fetch(`http://localhost:${PORT}/api/remove-banner`, {
    method: 'POST', headers: { Authorization: `Bearer ${me.token}`, 'Content-Type': 'application/json' },
  });
  assert.strictEqual(gone.status, 200);
  assert.strictEqual((await card(viewer, me.id)).banner, null);
});

test('a banner needs a signed in account and real image bytes', async () => {
  const me = await h.register('trickster');
  assert.strictEqual((await uploadBanner('not-a-token', PNG)).status, 401);
  // Text dressed up as a PNG is refused on its bytes.
  const fake = await uploadBanner(me.token, Buffer.from('<svg onload="alert(1)"></svg>'), 'image/png');
  assert.strictEqual(fake.status, 400);
  // Not an image type at all.
  const svg = await uploadBanner(me.token, Buffer.from('<svg></svg>'), 'image/svg+xml', 'b.svg');
  assert.strictEqual(svg.status, 400);
});

test('banners have their own size limit, which only takes 1 to 20 MB', async () => {
  const admin = await h.register('admin');
  const A = await h.connect(admin.token);
  const me = await h.register('bigbanner');
  const settings = async () => new Promise((res) => { A.once('server-settings', res); A.emit('get-server-settings'); });

  assert.strictEqual((await settings()).max_banner_mb, '5', 'defaults to 5 MB');
  A.emit('update-server-setting', { key: 'max_banner_mb', value: '21' });
  A.emit('update-server-setting', { key: 'max_banner_mb', value: '0' });
  A.emit('update-server-setting', { key: 'max_banner_mb', value: '1' });
  await new Promise((r) => setTimeout(r, 300));
  assert.strictEqual((await settings()).max_banner_mb, '1', 'out of range values are ignored');

  // A PNG header padded past 1 MB: real enough to pass the byte check.
  const big = Buffer.concat([PNG, Buffer.alloc(1024 * 1024 + 10)]);
  const r = await uploadBanner(me.token, big);
  assert.strictEqual(r.status, 400);
  assert.match((await r.json()).error, /Banner must be under 1 MB/);
  // The avatar limit is separate and still allows it.
  const form = new FormData();
  form.append('avatar', new Blob([big], { type: 'image/png' }), 'a.png');
  const av = await fetch(`http://localhost:${PORT}/api/upload-avatar`, {
    method: 'POST', headers: { Authorization: `Bearer ${me.token}` }, body: form,
  });
  assert.strictEqual(av.status, 200, 'avatar limit is still 2 MB');
  A.emit('update-server-setting', { key: 'max_banner_mb', value: '5' });
});

test('a banner that is not a local upload path is never handed out', async () => {
  const me = await h.register('sneaky');
  const sock = await h.connect(me.token);
  // Stand in for a row written some other way.
  const db = new Database(path.join(h.dataDir, 'haven.db'));
  try {
    for (const bad of ['https://evil.example/track.png', '//evil.example/x.png', '/api/admin', 'javascript:alert(1)', '/uploads/a b.png']) {
      db.prepare('UPDATE users SET banner = ? WHERE id = ?').run(bad, me.id);
      assert.strictEqual((await card(sock, me.id)).banner, null, `card refuses ${bad}`);
      assert.strictEqual((await sessionInfo(me.token)).banner, null, `session refuses ${bad}`);
    }
  } finally {
    db.close();
  }
});
