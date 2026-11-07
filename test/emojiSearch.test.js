'use strict';
// The emoji list offers people as a man or a woman.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { parseEmojiTest } = require('../src/emoji');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const data = parseEmojiTest(read('src/emoji-test.txt'));
const offered = new Set(Object.values(data.categories).flat());

test('gender-neutral people are left out when a man and a woman version exist', () => {
  for (const glyph of ['🧑', '🤷', '🙋', '🧑‍💻', '👮', '🧑‍🎄', '🫄', '🧒', '🧓', '🧑‍🤝‍🧑', '👪', '💏', '🏃', '🏃‍➡️']) {
    assert.ok(data.hidden.includes(glyph), `${glyph} should be left out`);
    assert.ok(!offered.has(glyph), `${glyph} should not be in the picker`);
    assert.equal(data.names[glyph], undefined, `${glyph} should not be searchable`);
  }
});

test('the man and woman versions stay, and so do people with no gendered version', () => {
  for (const glyph of ['👨', '👩', '🤷‍♂️', '🤷‍♀️', '👨‍💻', '👩‍💻', '🎅', '🤶', '👦', '👧', '👫', '👶', '🥷', '🏂', '🫂', '👍']) {
    assert.ok(offered.has(glyph), `${glyph} should be in the picker`);
  }
  assert.ok(!data.hidden.some(g => /^(man|woman|boy|girl)\b/.test(data.names[g] || '')));
});

test('the built-in list used before the server answers has no gender-neutral people', () => {
  const app = read('public/js/app.js');
  const block = app.slice(app.indexOf('this.emojiCategories = {'), app.indexOf('// Flat list for quick access'));
  const names = app.slice(app.indexOf('this.emojiNames = {'), app.indexOf('};', app.indexOf('this.emojiNames = {')));
  const builtIn = new Set([...block.matchAll(/'([^']+)'/g), ...names.matchAll(/'([^']+)':/g)].map(m => m[1]));
  const left = data.hidden.filter(g => builtIn.has(g) || builtIn.has(g.replace(/️/g, '')));
  assert.deepEqual(left, []);
});
