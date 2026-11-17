'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'modules', 'app-ui.js'), 'utf8');
const block = src.slice(src.indexOf('// Type-to-focus'), src.indexOf('// Ctrl+F = search'));
test('Ctrl or Cmd+V with nothing focused hands the paste to the message box', () => {
  assert.match(block, /const pasteKey = \(e\.ctrlKey \|\| e\.metaKey\) && !e\.altKey && e\.key\.toLowerCase\(\) === 'v';/);
  assert.match(block, /if \(\(pasteKey \|\| e\.key\.length === 1 && !e\.ctrlKey && !e\.metaKey && !e\.altKey\) && !e\.isComposing\)/);
  assert.match(block, /msgInput\.focus\(\);/);
});
test('typing a shortcut other than paste still leaves focus alone', () => {
  assert.doesNotMatch(block, /e\.ctrlKey \|\| e\.metaKey\) && !e\.altKey && e\.key\.length === 1/);
  assert.match(block, /!editing && !popupOpen/);
});
