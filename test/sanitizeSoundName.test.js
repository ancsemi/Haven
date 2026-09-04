'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { sanitizeSoundName } = require('../src/socketHandlers/helpers');

test('sound names keep emoji, letters, numbers, spaces, and _/-', () => {
  assert.equal(sanitizeSoundName('🎉 Party'), '🎉 Party');
  assert.equal(sanitizeSoundName('Air Horn 📯'), 'Air Horn 📯');
  assert.equal(sanitizeSoundName('👍'), '👍');
  assert.equal(sanitizeSoundName('foo_bar-baz'), 'foo_bar-baz');
  assert.equal(sanitizeSoundName('café'), 'café');
  assert.equal(sanitizeSoundName('音效'), '音效');
});

test('sound names keep ZWJ emoji sequences', () => {
  assert.equal(sanitizeSoundName('👨‍👩‍👧‍👦 family'), '👨‍👩‍👧‍👦 family');
});

test('sound names strip angle brackets and punctuation noise', () => {
  assert.equal(sanitizeSoundName('Hello <script>'), 'Hello script');
  assert.equal(sanitizeSoundName('!!!'), '');
});

test('sound names collapse whitespace and trim', () => {
  assert.equal(sanitizeSoundName('  loud   horn  '), 'loud horn');
});

test('sound names are capped at 30 code points', () => {
  assert.equal(sanitizeSoundName('🎉'.repeat(40)), '🎉'.repeat(30));
  assert.equal([...sanitizeSoundName('a'.repeat(50))].length, 30);
});

test('non-strings and empty input become empty', () => {
  assert.equal(sanitizeSoundName(''), '');
  assert.equal(sanitizeSoundName(null), '');
  assert.equal(sanitizeSoundName(undefined), '');
  assert.equal(sanitizeSoundName(12), '');
});
