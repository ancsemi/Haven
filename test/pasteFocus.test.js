'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'modules', 'app-ui.js'), 'utf8');
const block = src.slice(src.indexOf('// Type-to-focus'), src.indexOf('// Ctrl+F = search'));
test('Ctrl or Cmd+V with nothing focused hands the paste to the message box', () => {
  assert.match(block, /const pasteKey = \(e\.ctrlKey \|\| e\.metaKey\) && !e\.altKey && this\._shortcutKey\(e\) === 'v';/);
  assert.match(block, /if \(\(pasteKey \|\| e\.key\.length === 1 && !e\.ctrlKey && !e\.metaKey && !e\.altKey\) && !e\.isComposing\)/);
  assert.match(block, /msgInput\.focus\(\);/);
});
test('typing a shortcut other than paste still leaves focus alone', () => {
  assert.doesNotMatch(block, /e\.ctrlKey \|\| e\.metaKey\) && !e\.altKey && e\.key\.length === 1/);
  assert.match(block, /!editing && !popupOpen/);
});
const method = (name) => { const i = src.indexOf(`\n${name}(`) + 1; return src.slice(i, src.indexOf('\n},\n', i) + 3); };
const load = (globals) => vm.runInNewContext(`({${method('_shortcutKey')}${method('_pasteIfKeyMissed')}})`, { Date, setTimeout: (f) => f(), ...globals });
const key = (k, code) => ({ key: k, code });
test('a shortcut follows the letter on the key, or the key position for a non-Latin layout', () => {
  const m = load({});
  assert.equal(m._shortcutKey(key('v', 'KeyC')), 'v');
  assert.equal(m._shortcutKey(key('V', 'KeyV')), 'v');
  assert.equal(m._shortcutKey(key('м', 'KeyV')), 'v');
  assert.equal(m._shortcutKey(key('Enter', 'Enter')), 'enter');
  assert.equal(m._shortcutKey(key('1', 'Digit1')), '1');
});
test('a paste the browser did not make is made from the clipboard in a text box only', () => {
  const run = (active, lastPasteAt) => {
    const m = load({ document: { activeElement: active } });
    const pasted = [];
    m._lastPasteAt = lastPasteAt;
    m._pasteFromClipboard = (el) => pasted.push(el);
    m._pasteIfKeyMissed();
    return pasted.length;
  };
  assert.equal(run({ tagName: 'TEXTAREA' }), 1);
  assert.equal(run({ tagName: 'INPUT', type: 'text' }), 1);
  assert.equal(run({ tagName: 'TEXTAREA' }, Date.now() + 1000), 0);
  assert.equal(run({ tagName: 'TEXTAREA', readOnly: true }), 0);
  assert.equal(run({ tagName: 'INPUT', type: 'checkbox' }), 0);
  assert.equal(run({ tagName: 'BUTTON' }), 0);
  assert.equal(run(null), 0);
});
