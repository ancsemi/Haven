'use strict';

// The visual effects pick lived only in localStorage, so a desktop launch that
// landed on a different storage origin came back with the theme's default
// effects while the theme itself survived through user_preferences. The pick
// now round-trips through the server like the theme does.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('the server accepts an effects preference and allows a JSON array in it', () => {
  const src = read('src/socketHandlers/users.js');
  assert.match(src, /'effects',/);
  assert.match(src, /key === 'effects' \? 400 : 50/);
});

test('every effects write in the picker goes through _persistEffects', () => {
  const src = read('public/js/theme.js');
  const writes = src.match(/localStorage\.setItem\('haven_effects'/g) || [];
  assert.equal(writes.length, 3, 'only the legacy migration, _persistEffects and the server sync write the key');
  assert.match(src, /function _persistEffects\(raw\)/);
  assert.match(src, /socket\.emit\('set-preference', \{ key: 'effects', value: raw \}\)/);
  assert.match(src, /function syncEffectsFromServer\(raw\)/);
});

test('the preferences handler restores effects before it applies the theme', () => {
  const src = read('public/js/modules/app-socket.js');
  const sync = src.indexOf('syncEffectsFromServer(prefs.effects)');
  const theme = src.indexOf('applyThemeFromServer(prefs.theme, true, true)');
  assert.ok(sync > 0 && theme > sync, 'effects restored first, then theme applied');
});
