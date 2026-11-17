'use strict';

/**
 * Players in chat share one set of controls: drawn icons, playing controls and
 * view controls in separate groups, with Theater and Fullscreen on video.
 *
 *   node --test test/mediaControls.test.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

function load({ fullscreen = true } = {}) {
  const app = {};
  for (const file of ['app-media-playback.js', 'app-link-previews.js']) {
    const context = vm.createContext({
      module: { exports: {} }, console, t: (k) => k, URL, URLSearchParams,
      localStorage: { getItem: () => null, setItem() {} },
      document: { fullscreenEnabled: fullscreen },
    });
    vm.runInContext(read(`public/js/modules/${file}`).replace(/^export default/m, 'module.exports ='), context);
    Object.assign(app, context.module.exports);
  }
  app._embedSize = () => 'medium';
  app._escapeHtml = (s) => s;
  return app;
}

test('the controls are drawn icons, not emoji or text symbols', () => {
  const a = load();
  const html = a._ytVolumeHtml() + a._mediaViewHtml() + a._embedHeaderHtml('YouTube', false);
  assert.doesNotMatch(html, /[🔊🔇🔁📌⤢▾▸]/u);
  for (const btn of html.match(/<button[^>]*>/g)) assert.match(btn, /class="media-btn/, btn);
});

test('a YouTube card has playing controls, then view controls with theater and fullscreen', () => {
  const a = load();
  const html = a._embedHeaderHtml('YouTube', false, a._ytVolumeHtml(), a._mediaViewHtml());
  const order = ['lp-site', 'lp-mute', 'media-loop', 'media-keep', 'lp-size', 'media-theater-btn', 'media-fullscreen-btn', 'lp-collapse'];
  const at = order.map(c => html.indexOf(c));
  assert.ok(at.every(n => n >= 0), `all present: ${at}`);
  assert.deepEqual(at, [...at].sort((x, y) => x - y));
  assert.equal(html.match(/class="media-controls"/g).length, 2);
});

test('a link card with nothing to play has only its size and collapse', () => {
  const html = load()._embedHeaderHtml('Example', false);
  assert.match(html, /lp-size/);
  assert.match(html, /lp-collapse/);
  assert.doesNotMatch(html, /media-theater-btn|media-fullscreen-btn|lp-mute/);
});

test('an uploaded video gets theater and fullscreen, a sound does not', () => {
  const a = load();
  assert.match(a._mediaControlsHtml('video'), /media-theater-btn[\s\S]*media-fullscreen-btn/);
  assert.doesNotMatch(a._mediaControlsHtml('audio'), /media-theater-btn|media-fullscreen-btn/);
  assert.match(a._mediaControlsHtml('audio', '<i id="extra"></i>'), /id="extra"/);
});

test('fullscreen is not offered where the page cannot do it', () => {
  const html = load({ fullscreen: false })._mediaViewHtml();
  assert.match(html, /media-theater-btn/);
  assert.doesNotMatch(html, /media-fullscreen-btn/);
});

test('every label the controls use exists in English', () => {
  const m = JSON.parse(read('public/locales/en.json')).app.messages;
  for (const key of ['embed_size', 'embed_size_note', 'embed_theater', 'embed_theater_on', 'embed_fullscreen', 'embed_mute', 'embed_unmute', 'embed_volume', 'expand', 'collapse']) {
    assert.ok(m[key], key);
  }
});

test('theater is as wide as the chat and never taller than the window', () => {
  const css = read('public/css/style-media-controls.css');
  assert.match(css, /body \.link-preview\.media-theater,\s*body \.file-attachment\.media-theater \{[^}]*max-width: none/);
  assert.match(css, /\.link-preview--yt\.media-theater \.link-preview-yt \{[^}]*100vh/);
  assert.match(read('public/css/style.css'), /style-media-controls\.css\?v=/);
});

test('the size button opens the menu instead of cycling, and fullscreen targets the player', () => {
  const links = read('public/js/modules/app-link-previews.js');
  assert.match(links, /this\._openEmbedSizeMenu\(sizeBtn\)/);
  assert.match(read('public/js/modules/app-media-playback.js'), /querySelector\('\.link-preview-yt iframe, video'\)/);
  assert.match(read('public/js/modules/app-appearance.js'), /\.lp-size-label/);
});
