'use strict';

/**
 * Hide media (Settings > Chat & media): pictures and videos wait behind a
 * click-to-show tag, and the tooltip that replaced the browser's stays inside
 * the window.
 *
 *   node --test test/hideMedia.test.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const MODULES = ['app-utilities.js', 'app-message-content.js', 'app-context.js', 'app-media.js'].map(name => ({
  name,
  source: fs.readFileSync(path.join(ROOT, 'public/js/modules', name), 'utf8'),
}));

function fakeElement() {
  let text = '';
  return {
    set textContent(v) { text = String(v); },
    get textContent() { return text; },
    get innerHTML() { return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); },
  };
}

function loadApp(stored = {}) {
  const sandbox = {
    document: { documentElement: { lang: 'en-US' }, querySelectorAll: () => [], createElement: () => fakeElement() },
    navigator: { languages: ['en-US'] },
    location: { href: 'https://haven.example/app', origin: 'https://haven.example' },
    window: { location: { origin: 'https://haven.example' } },
    localStorage: { getItem: (k) => (k in stored ? stored[k] : null), setItem: (k, v) => { stored[k] = v; } },
    setInterval: () => 0, clearInterval: () => {},
    Intl, Date, Number, Math, JSON, String, Array, Object, RegExp, Error, URL, Set, Map,
    t: (key) => key,
    console,
  };
  const methods = {};
  for (const mod of MODULES) {
    const context = vm.createContext({ module: { exports: {} }, exports: {}, ...sandbox });
    vm.runInContext(mod.source.replace(/^﻿/, '').replace(/^export default/m, 'module.exports ='), context, { filename: mod.name });
    Object.assign(methods, context.module.exports);
  }
  const app = Object.create(methods);
  app.user = { id: 1, username: 'tester' };
  app.channels = [];
  app.channelMembers = [];
  app._nicknames = {};
  app._lazySrcAttr = (a) => a;
  app._imgSrcAttr = (u) => `src="${u}"`;
  app._mediaControlsHtml = () => '<span class="media-controls"></span>';
  return app;
}

const LINES = {
  upload: '/uploads/1760-abc.png',
  remote: 'https://media.tenor.com/abc/cat.gif',
  video: '[file:clip.mp4](/uploads/1760-abc.mp4|3.1 MB)',
  e2e: 'e2e-img:image/png:/uploads/1760-abc.enc',
};

test('off by default: pictures and videos show as before', () => {
  const app = loadApp();
  assert.match(app._formatContent(LINES.upload), /<img [^>]*class="chat-image"/);
  assert.match(app._formatContent(LINES.video), /<video /);
  assert.match(app._formatContent(LINES.e2e), /data-e2e-src="\/uploads\/1760-abc.enc"/);
  assert.doesNotMatch(app._formatContent(LINES.upload), /hidden-image/);
});

test('on: every kind waits behind the click-to-show tag', () => {
  const app = loadApp({ 'haven-hide-media': 'true' });
  for (const [kind, line] of Object.entries(LINES)) {
    const html = app._formatContent(line);
    assert.match(html, /class="hidden-image"/, kind);
    assert.doesNotMatch(html, /<img |<video /, kind);
  }
});

test('a held video keeps its name and size, and says it is a video', () => {
  const app = loadApp({ 'haven-hide-media': 'true' });
  const html = app._formatContent(LINES.video);
  assert.match(html, /<span class="file-name">clip\.mp4<\/span>/);
  assert.match(html, /\(3\.1 MB\)/);
  assert.match(html, /data-hidden-kind="video"/);
  assert.match(html, /data-hidden-src="\/uploads\/1760-abc\.mp4"/);
  assert.match(html, /app\.messages\.video_hidden/);
  assert.doesNotMatch(html, /media-controls/, 'no player controls without a player');
});

test('an encrypted picture keeps its path and type for when it is shown', () => {
  const app = loadApp({ 'haven-hide-media': 'true' });
  const html = app._formatContent(LINES.e2e);
  assert.match(html, /data-hidden-src="\/uploads\/1760-abc\.enc"/);
  assert.match(html, /data-hidden-kind="image\/png"/);
});

test('pictures sent together are not drawn as a grid while hidden', () => {
  const app = loadApp({ 'haven-hide-media': 'true' });
  app._mediaGridRun = () => { throw new Error('grid should not be asked for'); };
  const html = app._formatContent('look\n/uploads/1.png\n/uploads/2.png');
  assert.equal((html.match(/class="hidden-image"/g) || []).length, 2);
});

test('a revealed picture stays shown when the message is drawn again', () => {
  const app = loadApp({ 'haven-hide-media': 'true' });
  app._revealedMedia = new Set([app._normalizeImgSrc(LINES.upload)]);
  assert.match(app._formatContent(LINES.upload), /<img /);
  assert.match(app._formatContent('/uploads/other.png'), /hidden-image/);
});

test('link cards start folded while hidden, until opened', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public/js/modules/app-link-previews.js'), 'utf8');
  const context = vm.createContext({ module: { exports: {} }, console, t: (k) => k, URL, URLSearchParams, localStorage: { getItem: () => null, setItem() {} }, document: {} });
  vm.runInContext(src.replace(/^export default/m, 'module.exports ='), context);
  const app = Object.create(context.module.exports);
  app._collapsedEmbeds = new Set();
  let hidden = false;
  app._hideMediaOn = () => hidden;
  assert.equal(app._embedFolded('https://example.com/a'), false);
  hidden = true;
  assert.equal(app._embedFolded('https://example.com/a'), true);
  app._openedEmbeds = new Set(['https://example.com/a']);
  assert.equal(app._embedFolded('https://example.com/a'), false);
});

test('the tooltip stays inside the window', async () => {
  const { placeTooltip } = await import(pathToFileURL(path.join(ROOT, 'public/js/modules/tooltips.js')).href);
  const view = { width: 1000, height: 700 };
  const size = { width: 320, height: 60 };
  assert.deepEqual(placeTooltip({ x: 100, y: 100 }, size, view), { left: 100, top: 118 }, 'under the pointer');
  const right = placeTooltip({ x: 990, y: 100 }, size, view);
  assert.equal(right.left + size.width, view.width - 8, 'pulled in from the right edge');
  const low = placeTooltip({ x: 100, y: 690 }, size, view);
  assert.ok(low.top + size.height <= view.height - 8 && low.top < 690, 'above the pointer near the bottom');
  const wide = placeTooltip({ x: 50, y: 50 }, { width: 2000, height: 60 }, view);
  assert.equal(wide.left, 8, 'never off the left edge');
});
