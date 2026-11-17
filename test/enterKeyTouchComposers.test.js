'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const modules = path.join(__dirname, '..', 'public', 'js', 'modules');
let M;
test.before(async () => { M = (await import(pathToFileURL(path.join(modules, 'app-composer.js')).href)).default; });
const enterSends = (coarse, hidden, e = {}) => {
  global.window = { matchMedia: (q) => ({ matches: coarse && q === '(hover: none) and (pointer: coarse)' }) };
  global.document = { documentElement: { hasAttribute: (a) => hidden && a === 'data-hide-send-btn' } };
  try { return M._enterSends(e); } finally { delete global.window; delete global.document; }
};
test('a desktop or laptop keeps Enter as send', () => assert.equal(enterSends(false, false), true));
test('a phone or tablet makes plain Enter a new line', () => assert.equal(enterSends(true, false), false));
test('Ctrl+Enter and Cmd+Enter still act on a phone or tablet', () => {
  assert.equal(enterSends(true, false, { ctrlKey: true }), true);
  assert.equal(enterSends(true, false, { metaKey: true }), true);
});
test('Hide the Send button keeps Enter as send on a phone or tablet', () => assert.equal(enterSends(true, true), true));
test('the message box, thread box, DM pop-out and message edit all ask before sending on Enter', () => {
  const count = (file) => (fs.readFileSync(path.join(modules, file), 'utf8').match(/e\.key === 'Enter' && !e\.shiftKey && this\._enterSends\(e\)/g) || []).length;
  assert.equal(count('app-composer.js'), 1);
  assert.equal(count('app-pip-panels.js'), 2);
  assert.equal(count('app-message-content.js'), 1);
});
