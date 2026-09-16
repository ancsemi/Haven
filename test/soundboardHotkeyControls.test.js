'use strict';

// The sidebar soundboard rendered a read-only hotkey chip, so a key bound
// there could only be cleared from the Sound Manager grid. Both layouts now
// share one markup helper and one handler binder. The DOM behaviour was
// checked in a real Chromium (clear removes the binding and re-renders, Set
// starts recording, clicks on the controls never play the sound).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const file = path.join(__dirname, '..', 'public', 'js', 'modules', 'app-media.js');
const src = fs.readFileSync(file, 'utf8');
let M;
test.before(async () => { M = (await import(pathToFileURL(file).href)).default; });

test('one markup helper serves the chip with a clear control and the set link', () => {
  const app = Object.assign({}, M, { _escapeHtml: (s) => String(s) });
  global.t = (k) => k;
  assert.match(app._sbHotkeyControlsHtml('Door', 'F5'), /sb-hotkey-clear" data-sound="Door"/);
  assert.match(app._sbHotkeyControlsHtml('Door', undefined), /sb-hotkey-set" data-sound="Door"/);
  delete global.t;
});

test('the grid, the pop-out and the sidebar all go through the shared helpers', () => {
  const sidebar = src.slice(src.indexOf("_renderSoundboardSidebar(filter = '') {"), src.indexOf('_popOutSoundboard() {'));
  const grid = src.slice(src.indexOf("_renderSoundboard(filter = '') {"));
  assert.match(sidebar, /_sbHotkeyControlsHtml\(s\.name, hk\)/);
  assert.match(sidebar, /_bindSbHotkeyControls\(grid, hotkeyMap/);
  assert.match(grid, /_sbHotkeyControlsHtml\(s\.name, hotkeyMap\[s\.name\]\)/);
  assert.match(grid, /_bindSbHotkeyControls\(grid, hotkeyMap/);
  assert.doesNotMatch(src.slice(src.indexOf("_renderSoundboard(filter = '') {")), /querySelectorAll\('\.sb-hotkey-clear'\)/, 'no second copy of the clear handler');
  assert.match(src, /id="sb-pip-grid" class="soundboard-grid sb-pip-grid"/, 'pop-out grid gets the list-mode styles');
});
