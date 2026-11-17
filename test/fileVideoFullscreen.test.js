'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'public/js/modules/app-voice-controls.js'), 'utf8');
function setup() {
  const asked = [];
  const state = { desktop: false };
  class Element { requestFullscreen(opts) { asked.push(this.name); return opts; } }
  const context = vm.createContext({ module: { exports: {} }, Element, document: { documentElement: { hasAttribute: (n) => state.desktop && n === 'data-desktop-app' } }, localStorage: {}, t: (k) => k });
  vm.runInContext(source.replace(/^export default/m, 'module.exports ='), context, { filename: 'app-voice-controls.js' });
  context.module.exports._redirectFileVideoFullscreen();
  const make = (name, classes = [], wrap = null) => Object.assign(new Element(), { name, classList: { contains: (c) => classes.includes(c) }, closest: (s) => (s === '.file-video-wrap' ? wrap : null) });
  return { asked, state, make };
}
test('a file video in a browser asks its wrapper to go fullscreen', () => {
  const { asked, make } = setup();
  make('video', ['file-video'], make('wrap')).requestFullscreen();
  assert.deepEqual(asked, ['wrap']);
});
test('the desktop attribute is checked when fullscreen is asked, not when the page starts', () => {
  const { asked, state, make } = setup();
  state.desktop = true;
  make('video', ['file-video'], make('wrap')).requestFullscreen();
  assert.deepEqual(asked, ['video']);
});
test('a file video without a wrapper and any other element ask for themselves', () => {
  const { asked, make } = setup();
  make('lone', ['file-video']).requestFullscreen();
  make('tile', ['screen-share-tile'], make('wrap')).requestFullscreen();
  assert.deepEqual(asked, ['lone', 'tile']);
});
test('options reach the browser', () => {
  const { make } = setup();
  const opts = { navigationUI: 'hide' };
  assert.equal(make('video', ['file-video'], make('wrap')).requestFullscreen(opts), opts);
});
