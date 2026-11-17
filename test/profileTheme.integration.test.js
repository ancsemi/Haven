'use strict';

/**
 * Profile themes: two colors a profile card fades between, top to bottom.
 * Both are exact #rrggbb or there is no theme; nothing else is stored or
 * handed out, since the colors end up in a style on everyone's screen. The
 * readability math the card uses is checked here too.
 *
 *   node --test test/profileTheme.integration.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const Database = require('better-sqlite3');
const { io } = require('socket.io-client');
const { createHarness } = require('./socketServerHarness');

const PORT = 3539;
const h = createHarness(PORT, 'profile-theme');
test.before(() => h.start());
test.after(() => h.stop());

async function card(sock, userId) {
  const got = h.next(sock, 'user-profile', (p) => p.id === userId);
  sock.emit('get-user-profile', { userId });
  return got;
}

async function setTheme(sock, data) {
  const saved = h.next(sock, 'profile-theme-updated');
  const refused = h.next(sock, 'error-msg');
  sock.emit('set-profile-theme', data);
  return Promise.race([saved.then((d) => d && { saved: d.theme }), refused.then((e) => e && { error: e })]);
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

test('a theme is saved, shown on the card and in the session, and can be turned off', async () => {
  const me = await h.register('themer');
  const other = await h.register('looker');
  const sock = await h.connect(me.token);
  const viewer = await h.connect(other.token);

  assert.strictEqual((await card(viewer, me.id)).profileTheme, null, 'no theme to start');
  assert.deepStrictEqual(await setTheme(sock, { top: '#D24FC4', bottom: '#4b1a9a' }),
    { saved: { top: '#d24fc4', bottom: '#4b1a9a' } }, 'stored lowercase');
  assert.deepStrictEqual((await card(viewer, me.id)).profileTheme, { top: '#d24fc4', bottom: '#4b1a9a' });
  assert.deepStrictEqual((await sessionInfo(me.token)).profileTheme, { top: '#d24fc4', bottom: '#4b1a9a' });

  assert.deepStrictEqual(await setTheme(sock, { top: null, bottom: null }), { saved: null });
  assert.strictEqual((await card(viewer, me.id)).profileTheme, null);
});

test('anything but two exact colors, or both null, is refused and changes nothing', async () => {
  const me = await h.register('mischief');
  const sock = await h.connect(me.token);
  await setTheme(sock, { top: '#111111', bottom: '#222222' });

  const attempts = [
    { top: '#111111', bottom: null }, { top: null, bottom: '#222222' }, { top: '#111111' }, {},
    { top: '#111111', bottom: 'red' }, { top: '#fff', bottom: '#000' },
    { top: '#000000;background:url(https://evil.example/x)', bottom: '#000000' },
    { top: '#000000', bottom: 'var(--accent)' }, { top: '#000000\n', bottom: '#000000' },
    { top: 1, bottom: 2 }, { top: [], bottom: {} },
  ];
  for (const bad of attempts) {
    const r = await setTheme(sock, bad);
    assert.ok(r && r.error, `refused: ${JSON.stringify(bad)}`);
  }
  assert.deepStrictEqual((await card(sock, me.id)).profileTheme, { top: '#111111', bottom: '#222222' });
});

test('a half set or malformed theme in the database is never handed out', async () => {
  const me = await h.register('halfway');
  const sock = await h.connect(me.token);
  const db = new Database(path.join(h.dataDir, 'haven.db'));
  try {
    for (const [top, bottom] of [['#111111', null], ['#111111', 'url(x)'], ['red', 'blue']]) {
      db.prepare('UPDATE users SET profile_theme_top = ?, profile_theme_bottom = ? WHERE id = ?').run(top, bottom, me.id);
      assert.strictEqual((await card(sock, me.id)).profileTheme, null, `card refuses ${top} / ${bottom}`);
      assert.strictEqual((await sessionInfo(me.token)).profileTheme, null, `session refuses ${top} / ${bottom}`);
    }
  } finally {
    db.close();
  }
});

test('one text color on a glass panel reads at 4.5:1 or better over the whole fade, whatever the colors', async () => {
  // The card's color math, from the browser module as it ships.
  const modulePath = path.join(__dirname, '..', 'public/js/modules/app-profile-theme.js');
  const theme = (await import(pathToFileURL(modulePath).href)).default;
  const glassFor = (...args) => theme._profileThemeGlass(...args);
  const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  const mix = (c, o, a) => c.map((v, k) => v * (1 - a) + o[k] * a);
  // Oklab and OKLCH written out separately from the module's, as a check on it.
  const M1 = [[0.4122214708, 0.5363325363, 0.0514459929], [0.2119034982, 0.6806995451, 0.1073969566], [0.0883024619, 0.2817188376, 0.6299787005]];
  const M2 = [[0.2104542553, 0.7936177850, -0.0040720468], [1.9779984951, -2.4285922050, 0.4505937099], [0.0259040371, 0.7827717662, -0.8086757660]];
  const M2i = [[1, 0.3963377774, 0.2158037573], [1, -0.1055613458, -0.0638541728], [1, -0.0894841775, -1.2914855480]];
  const M1i = [[4.0767416621, -3.3077115913, 0.2309699292], [-1.2684380046, 2.6097574011, -0.3413193965], [-0.0041960863, -0.7034186147, 1.7076956610]];
  const mul = (M, v) => M.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]);
  const oklab = (c) => mul(M2, mul(M1, c.map(lin)).map(Math.cbrt));
  const unOklab = (o) => mul(M1i, mul(M2i, o).map((x) => x ** 3))
    .map((c) => Math.min(1, Math.max(0, c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)));
  // OKLCH, the shorter way round the hue; no chroma means no hue of its own.
  const oklch = (x, y, t) => {
    const [A, B] = [oklab(x), oklab(y)].map(([L, a, b]) => [L, Math.hypot(a, b), Math.atan2(b, a)]);
    if (A[1] < 1e-4) A[2] = B[2];
    if (B[1] < 1e-4) B[2] = A[2];
    const dh = ((B[2] - A[2] + 3 * Math.PI) % (2 * Math.PI)) - Math.PI;
    const L = A[0] + (B[0] - A[0]) * t, C = A[1] + (B[1] - A[1]) * t, h = A[2] + dh * t;
    return unOklab([L, C * Math.cos(h), C * Math.sin(h)]);
  };
  // What a browser draws: OKLCH where it can (and Oklab too where an end
  // is all but gray, since browsers differ there), plain RGB where not.
  const chroma = (hex) => { const [, a, b] = oklab(rgb(hex)); return Math.hypot(a, b); };
  const modes = [
    { oklch: true, blends: (top, bottom) => [oklch, ...(Math.min(chroma(top), chroma(bottom)) < 0.02 ? [(x, y, t) => unOklab(mix(oklab(x), oklab(y), t))] : [])] },
    { oklch: false, blends: () => [(x, y, t) => mix(x, y, t)] },
  ];
  const pairs = [
    ['#000000', '#ffffff'], ['#ffffff', '#000000'], ['#ff0000', '#00ff00'], ['#ffff00', '#0000ff'],
    ['#d24fc4', '#4b1a9a'], ['#808080', '#808080'], ['#ffffff', '#ffff00'], ['#101020', '#203040'],
    ['#777777', '#787878'], ['#5f5f5f', '#a0a0a0'], ['#e53e3e', '#2ec27e'], ['#0000ff', '#ffa500'],
    ['#ff00ff', '#00ffff'], ['#f7a1e0', '#7f3f9f'], ['#8fe8a0', '#7f3f9f'], ['#90ee90', '#f4d03f'],
    ['#00ff00', '#ff00ff'], ['#ffff00', '#8000ff'], ['#808080', '#ff0000'], ['#dc8add', '#63452c'],
  ];
  for (const mode of modes) for (const [top, bottom] of pairs) {
    const name = `${top} to ${bottom} (${mode.oklch ? 'OKLCH' : 'plain'})`;
    const { ink, alpha } = glassFor(top, bottom, mode.oklch);
    assert.ok(ink === 'light' || ink === 'dark', `${name}: one text color`);
    assert.ok(alpha >= 0.25 && alpha <= 0.9, `${name}: glass ${alpha} is at least 25%`);
    const glass = ink === 'light' ? [0, 0, 0] : [1, 1, 1];
    const text = ink === 'light' ? [1, 1, 1] : [0, 0, 0];
    for (const blend of mode.blends(top, bottom)) {
      for (let i = 0; i <= 40; i++) {
        const bg = mix(blend(rgb(top), rgb(bottom), i / 40), glass, alpha);
        const [x, z] = [lum(text), lum(bg)];
        const ratio = (Math.max(x, z) + 0.05) / (Math.min(x, z) + 0.05);
        assert.ok(ratio >= 4.5, `${name}, ${ink} text at ${i}/40 down the fade: ${ratio.toFixed(2)}:1`);
      }
    }
  }
  // Colors that read on their own still get the panel, at its lightest.
  assert.deepStrictEqual(glassFor('#ffffff', '#ffff00', true), { ink: 'dark', alpha: 0.25 });
});
