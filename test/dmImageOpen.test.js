'use strict';

/**
 * Opening a picture from an encrypted DM: a desktop browser gets a new tab
 * with the decrypted copy, while a phone, an installed app window or the
 * Android app gets Haven's own viewer, since a new tab there cannot read the
 * decrypted copy and showed a white page (#5853).
 *
 *   node --test test/dmImageOpen.test.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'public/js/modules/app-media.js'), 'utf8');

function loadApp({ userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0', standalone = false, framed = false } = {}) {
  const opened = [];
  const window = {
    open: (url, target) => { opened.push({ url, target }); return {}; },
    matchMedia: (q) => ({ matches: standalone && q.includes('standalone') }),
  };
  window.top = framed ? {} : window;
  let n = 0;
  const sandbox = {
    window,
    document: { getElementById: () => null, querySelectorAll: () => [] },
    navigator: { userAgent },
    URL: { createObjectURL: () => `blob:haven/${++n}`, revokeObjectURL: () => {} },
    setTimeout: () => 0,
    t: (key) => key,
    console, Promise, Object, Array, RegExp, String, Math, JSON, Error,
  };
  const context = vm.createContext({ module: { exports: {} }, exports: {}, ...sandbox });
  vm.runInContext(SOURCE.replace(/^﻿/, '').replace(/^export default/m, 'module.exports ='), context, { filename: 'app-media.js' });
  const app = Object.create(context.module.exports);
  app.lightboxed = [];
  app._openLightbox = (src, img) => { app.lightboxed.push(img); };
  app._e2eImageBlob = () => Promise.resolve({ type: 'image/png' });
  app._isMobileApp = false;
  return { app, opened };
}

const DM_IMAGE = { src: 'blob:haven/dead', dataset: { e2eSrc: '/uploads/1760-abc.enc' } };
const settle = () => new Promise(r => setImmediate(r));

test('a desktop browser opens the decrypted picture in a new tab', async () => {
  const { app, opened } = loadApp();
  app._openImageInNewTab(DM_IMAGE);
  await settle();
  assert.equal(opened.length, 1);
  assert.match(opened[0].url, /^blob:haven\//);
  assert.equal(app.lightboxed.length, 0);
});

for (const [name, opts] of [
  ['an Android phone', { userAgent: 'Mozilla/5.0 (Linux; Android 15; wv) Chrome/140.0 Mobile' }],
  ['an iPhone', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148' }],
  ['an installed app window', { standalone: true }],
  ['Haven inside the Android app', { framed: true }],
]) {
  test(`${name} shows the picture in Haven's viewer instead`, async () => {
    const { app, opened } = loadApp(opts);
    app._openImageInNewTab(DM_IMAGE);
    await settle();
    assert.equal(opened.length, 0);
    assert.deepEqual(app.lightboxed, [DM_IMAGE]);
  });
}

test('a picture that is a plain link still opens in a new tab on a phone', async () => {
  const { app, opened } = loadApp({ userAgent: 'Mozilla/5.0 (Linux; Android 15) Chrome/140.0 Mobile' });
  app._lazyRealSrc = (img) => img.src;
  app._openImageInNewTab({ src: '/uploads/1760-abc.png', dataset: {} });
  await settle();
  assert.equal(opened.length, 1);
  assert.equal(opened[0].url, '/uploads/1760-abc.png');
  assert.equal(app.lightboxed.length, 0);
});
