'use strict';
// The emoji list offers people as a man or a woman, and search finds emoji by
// the words people actually type.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { parseEmojiTest } = require('../src/emoji');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const data = parseEmojiTest(read('src/emoji-test.txt'));
const offered = new Set(Object.values(data.categories).flat());

test('gender-neutral people are left out when a man and a woman version exist', () => {
  for (const glyph of ['🧑', '🤷', '🙋', '🧑‍💻', '👮', '🧑‍🎄', '🫄', '🧒', '🧓', '🧑‍🤝‍🧑', '👪', '💏', '🏃', '🏃‍➡️', '🫃', '🧔‍♀️', '👰‍♂️', '🤵‍♀️']) {
    assert.ok(data.hidden.includes(glyph), `${glyph} should be left out`);
    assert.ok(!offered.has(glyph), `${glyph} should not be in the picker`);
    assert.equal(data.names[glyph], undefined, `${glyph} should not be searchable`);
  }
});

test('the man and woman versions stay, and so do people with no gendered version', () => {
  for (const glyph of ['👨', '👩', '🤷‍♂️', '🤷‍♀️', '👨‍💻', '👩‍💻', '🎅', '🤶', '👦', '👧', '👫', '👶', '🥷', '🏂', '🫂', '👍', '🤰', '🧔‍♂️', '👰‍♀️', '🤵‍♂️']) {
    assert.ok(offered.has(glyph), `${glyph} should be in the picker`);
  }
});

test('the built-in list used before the server answers has no gender-neutral people', () => {
  const app = read('public/js/app.js');
  const block = app.slice(app.indexOf('this.emojiCategories = {'), app.indexOf('// Flat list for quick access'));
  const names = app.slice(app.indexOf('this.emojiNames = {'), app.indexOf('};', app.indexOf('this.emojiNames = {')));
  const builtIn = new Set([...block.matchAll(/'([^']+)'/g), ...names.matchAll(/'([^']+)':/g)].map(m => m[1]));
  const left = data.hidden.filter(g => builtIn.has(g) || builtIn.has(g.replace(/️/g, '')));
  assert.deepEqual(left, []);
});

function searcher() {
  const load = (file) => {
    const src = read(file).replace(/^import .*$/gm, '').replace(/^export default/m, 'module.exports =');
    const ctx = vm.createContext({ module: { exports: {} }, console });
    vm.runInContext(src, ctx, { filename: file });
    return ctx.module.exports;
  };
  const slang = load('public/js/modules/emoji-slang.js');
  const app = Object.assign({}, load('public/js/modules/app-emoji-search.js'));
  app._getEmojiPunctAliases = () => ({ '?': 'question' });
  app.emojiNames = { ...data.names, '👆': 'point up' };
  app.emojis = Object.values(data.categories).flat();
  const keywords = JSON.parse(read('public/emoji-keywords.json'));
  for (const [glyph, words] of Object.entries(slang)) keywords[glyph] = `${keywords[glyph] || ''} ${words}`;
  app.emojiKeywords = keywords;
  return app;
}

test('chat words find the emoji people mean', () => {
  const app = searcher();
  for (const [query, glyph] of [['this', '👆'], ['dead', '💀'], ['lol', '😂'], ['sus', '🤨'], ['idk', '🤷‍♂️'], ['yes sir', '🫡'], ['goat', '🐐']]) {
    assert.ok(app._emojiSearch(query).includes(glyph), `"${query}" should find ${glyph}`);
  }
});

test('keywords match from the start of a word, and names rank first', () => {
  const app = searcher();
  const ok = app._emojiSearch('ok');
  assert.ok(!ok.includes('📖'), '"ok" should not find "book"');
  assert.ok(ok.indexOf('🆗') < ok.indexOf('👍'), 'a name match comes before a keyword match');
  assert.equal(app._emojiSearchScore('😀', ''), 0);
  assert.equal(app._emojiSearchScore('😀', 'zzqx'), -1);
  assert.ok(app._emojiSearch('?').includes('❓'), 'punctuation still finds its emoji');
});

test('search never offers a left-out person', () => {
  const app = searcher();
  const found = new Set(['person', 'shrug', 'technologist', 'claus', 'family', 'run'].flatMap(q => app._emojiSearch(q)));
  assert.deepEqual(data.hidden.filter(g => found.has(g)), []);
});
