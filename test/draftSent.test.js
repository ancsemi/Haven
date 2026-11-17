'use strict';

// A sent message must not come back as a draft on the next visit. Sending
// empties the box without an input event, so the text saved while typing
// used to stay in the draft store until a channel switch or page hide, and
// Haven Desktop closing skips both.
//
//   node --test test/draftSent.test.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

function setup() {
  const data = new Map();
  const localStorage = { getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)) };
  const src = fs.readFileSync(path.join(ROOT, 'public/js/modules/app-drafts.js'), 'utf8');
  const context = vm.createContext({ module: { exports: {} }, localStorage, console, document: {}, window: {} });
  vm.runInContext(src.replace(/^export default/m, 'module.exports ='), context, { filename: 'app-drafts.js' });
  const app = { ...context.module.exports, user: { id: 7 }, currentChannel: 'aaaaaaaa' };
  return { app, saved: () => JSON.parse(data.get('haven_drafts_7') || '{}') };
}

test('sending forgets the saved draft of that channel only', () => {
  const { app, saved } = setup();
  app._draftKeep('aaaaaaaa', 'hello there');
  app._draftKeep('bbbbbbbb', 'half typed');
  app._draftPersist();
  app._draftSent();
  assert.deepEqual(saved(), { bbbbbbbb: 'half typed' });
});

test('every place the send path empties the box forgets the draft', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public/js/modules/app-messages.js'), 'utf8');
  const clears = src.match(/input\.value = '';[^\n]*/g) || [];
  assert.ok(clears.length > 0);
  for (const line of clears) assert.match(line, /this\._draftSent\?\.\(\)/);
});
