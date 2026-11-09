'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const { cleanEmojiFavorites, EMOJI_FAVORITES_MAX } = require('../src/builtinEmojis');
const { createHarness, wait } = require('./socketServerHarness');
const ROOT = path.join(__dirname, '..');
const h = createHarness(3593, 'emoji-favorites');
let M;
test.before(async () => {
  global.t = (key) => key;
  M = (await import(pathToFileURL(path.join(ROOT, 'public/js/modules/app-emoji-picker.js')).href)).default;
  await h.start();
});
test.after(() => h.stop());
const app = (prefs, received = true) => {
  const sent = [];
  return Object.assign(Object.create(M), { _userPrefs: prefs, _prefsReceived: received, socket: { emit: (...a) => sent.push(a) }, sent });
};
const saved = (a) => JSON.parse(a._userPrefs.emoji_favorites);
test('the server keeps only emoji, once each, up to the limit', () => {
  assert.equal(cleanEmojiFavorites('not json'), null);
  assert.equal(cleanEmojiFavorites('{"a":1}'), null);
  assert.equal(cleanEmojiFavorites('[]'), '[]');
  assert.equal(cleanEmojiFavorites(JSON.stringify(['😀', '😀', ':os_windows:', '<b>x</b>', 7, 'hello', '👍'])), JSON.stringify(['😀', ':os_windows:', '👍']));
  assert.equal(JSON.parse(cleanEmojiFavorites(JSON.stringify(Array.from({ length: 90 }, (_, i) => String.fromCodePoint(0x1F600 + i))))).length, EMOJI_FAVORITES_MAX);
});
test('starring adds to the front, starring again removes, and each change is saved to the account', () => {
  const a = app({});
  a._toggleEmojiFavorite('😀');
  a._toggleEmojiFavorite('🔥');
  assert.deepEqual(saved(a), ['🔥', '😀']);
  assert.deepEqual(a._getEmojiFavorites(), ['🔥', '😀']);
  a._toggleEmojiFavorite('🔥');
  assert.deepEqual(saved(a), ['😀']);
  assert.deepEqual(a.sent.at(-1), ['set-preference', { key: 'emoji_favorites', value: '["😀"]' }]);
  a._toggleEmojiFavorite('😀');
  assert.deepEqual(a.sent.at(-1), ['set-preference', { key: 'emoji_favorites', value: '[]' }]);
});
test('nothing is saved before the account preferences have arrived, so a saved list is never overwritten', () => {
  const a = app(undefined, false);
  a._toggleEmojiFavorite('😀');
  assert.deepEqual(a.sent, []);
  assert.deepEqual(a._getEmojiFavorites(), []);
});
test('a damaged saved list counts as empty', () => {
  assert.deepEqual(app({ emoji_favorites: '{oops' })._getEmojiFavorites(), []);
  assert.deepEqual(app({ emoji_favorites: '"x"' })._getEmojiFavorites(), []);
});
test('the list is capped at the limit, newest first', () => {
  const a = app({});
  for (let i = 0; i < EMOJI_FAVORITES_MAX + 5; i++) a._toggleEmojiFavorite(String.fromCodePoint(0x1F600 + i));
  assert.equal(saved(a).length, EMOJI_FAVORITES_MAX);
  assert.equal(saved(a)[0], String.fromCodePoint(0x1F600 + EMOJI_FAVORITES_MAX + 4));
});
test('a favorite is saved on the account, comes back on another device, and bad lists are refused', async () => {
  const user = await h.register('favfan');
  const one = await h.connect(user.token);
  const ask = (sock) => new Promise((res) => { sock.once('preferences', res); sock.emit('get-preferences'); });
  assert.equal((await ask(one)).emoji_favorites, undefined);
  one.emit('set-preference', { key: 'emoji_favorites', value: JSON.stringify(['🔥', '🔥', 'junk', ':os_linux:']) });
  await wait(300);
  const two = await h.connect(user.token);
  assert.equal((await ask(two)).emoji_favorites, JSON.stringify(['🔥', ':os_linux:']));
  two.emit('set-preference', { key: 'emoji_favorites', value: 'not a list' });
  two.emit('set-preference', { key: 'emoji_favorites', value: JSON.stringify(Array(400).fill('🔥')) });
  await wait(300);
  assert.equal((await ask(two)).emoji_favorites, JSON.stringify(['🔥', ':os_linux:']));
  two.emit('set-preference', { key: 'emoji_favorites', value: '[]' });
  await wait(300);
  assert.equal((await ask(one)).emoji_favorites, '[]');
});
test('the picker opens with a Favorites section and both pickers bind the star gesture', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public/js/modules/app-emoji-picker.js'), 'utf8');
  assert.match(src, /const allCategories = \{ Favorites: \[\] \};/);
  assert.match(src, /'Favorites':'🌟'/);
  assert.equal((src.match(/(?:this|self)\._bindEmojiFavorite\(btn, emoji,/g) || []).length, 2);
  const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/locales/en.json'), 'utf8'));
  assert.ok(en.emoji.categories.favorites && en.emoji.favorites_hint);
});
