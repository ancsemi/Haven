'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
test('the app shell clips its overflow, so nothing can scroll the whole app out of place', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public/css/style-status-effects.css'), 'utf8');
  const rule = (css.match(/^#app \{[^}]*\}/m) || [''])[0];
  assert.match(rule, /overflow: hidden;\s*overflow: clip;/);
});
