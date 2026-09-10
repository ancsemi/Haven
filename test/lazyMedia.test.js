'use strict';

// Inline images used to fetch the moment a message rendered and stayed decoded
// for all 100 DOM messages. The lazy media queue in app-media.js fetches them
// near the viewport, closest first, a few at a time, and unloads them again
// far away. These tests drive the pure parts and the emitted markup.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const modulePath = path.join(__dirname, '..', 'public', 'js', 'modules', 'app-media.js');
let MOD, M;
test.before(async () => {
  MOD = (await import(pathToFileURL(modulePath).href)).default;
  // The wrapper only defers while the loader is running.
  M = Object.assign({}, MOD, { _lazyMedia: {} });
});

test('a src attribute becomes a blank placeholder plus data-lazy-src', () => {
  const out = M._lazySrcAttr('src="/uploads/a.png"');
  assert.match(out, /^src="data:image\/gif;base64,[A-Za-z0-9+/=]+" data-lazy-src="\/uploads\/a\.png"$/);
  const proxied = M._lazySrcAttr('src="/api/media-proxy?u=x" data-mp-origin="https://x"');
  assert.match(proxied, /data-lazy-src="\/api\/media-proxy\?u=x" data-mp-origin="https:\/\/x"$/);
  assert.equal(M._lazySrcAttr('data-mp-src="https://x"'), 'data-mp-src="https://x"', 'no src, nothing to defer');
  assert.equal(MOD._lazySrcAttr('src="/uploads/a.png"'), 'src="/uploads/a.png"', 'loader not running, nothing deferred');
});

test('the unloaded blank carries the picture\'s own size', () => {
  const blank = M._lazySizedBlank(640, 480);
  assert.match(blank, /^data:image\/svg\+xml,/);
  assert.match(decodeURIComponent(blank), /width='640' height='480'/);
});

test('distance is zero on screen and grows with the gap above or below', () => {
  assert.equal(M._lazyDistance({ top: 100, bottom: 200 }, 800), 0);
  assert.equal(M._lazyDistance({ top: -50, bottom: 10 }, 800), 0);
  assert.equal(M._lazyDistance({ top: 1300, bottom: 1400 }, 800), 500);
  assert.equal(M._lazyDistance({ top: -700, bottom: -600 }, 800), 600);
});

test('closest images start first and never more than the parallel limit', () => {
  const pending = [
    { img: 'far', distance: 900 },
    { img: 'here', distance: 0 },
    { img: 'near', distance: 120 },
    { img: 'mid', distance: 400 },
  ];
  assert.deepEqual(M._lazyPickNext(pending, 0, 3), ['here', 'near', 'mid']);
  assert.deepEqual(M._lazyPickNext(pending, 2, 3), ['here']);
  assert.deepEqual(M._lazyPickNext(pending, 3, 3), []);
});

test('the real URL wins over the placeholder for the lightbox', () => {
  assert.equal(M._lazyRealSrc({ dataset: { lazySrc: '/uploads/b.png' }, getAttribute: () => 'data:x' }), '/uploads/b.png');
  assert.equal(M._lazyRealSrc({ dataset: {}, getAttribute: () => '/uploads/c.png' }), '/uploads/c.png');
  assert.equal(M._lazyRealSrc(null), '');
});

test('chat images and stickers are emitted through the lazy wrapper', () => {
  const utils = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'modules', 'app-utilities.js'), 'utf8');
  assert.match(utils, /_lazySrcAttr\(`src="\$\{this\._escapeHtml\(u\)\}"`\)\} class="chat-image"/);
  assert.match(utils, /_lazySrcAttr\(this\._imgSrcAttr\(u\)\)\} class="chat-image"/);
  assert.match(utils, /_lazySrcAttr\(`src="\$\{this\._escapeHtml\(str\.trim\(\)\)\}"`\)\} class="sticker-img"/);
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  assert.match(app, /this\._setupLazyMedia\(\);/);
});
