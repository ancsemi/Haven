'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '..', 'public/js/modules/app-messages.js'), 'utf8');
const head = source.slice(source.indexOf('_createMessageEl(msg, prevMsg) {'), source.indexOf('  const isImage = this._isImageUrl(msg.content);'));
const body = head.slice(head.indexOf('{') + 1);
const create = new Function('t', 'document', `return function(msg, prevMsg) {${body} return null; };`);
const el = () => ({ dataset: {}, className: '', textContent: '' });
const t = (key, vars = {}) => `${key}${vars.name ? `:${vars.name}` : ''}`;
const draw = (msg, user = { id: 2 }) => create(t, { createElement: el }).call({ user, _getNickname: (id, name) => `nick-${name}`, _formatTime: (iso) => `at ${iso}` }, msg);
test('a missed call is drawn as a system line with who called and when (#5901)', () => {
  const row = draw({ id: 9, type: 'missed_call', user_id: 1, username: 'Ann', created_at: '2026-11-17T10:00:00Z' });
  assert.equal(row.className, 'system-message missed-call-notice');
  assert.equal(row.dataset.type, 'missed_call');
  assert.equal(row.dataset.msgId, 9);
  assert.equal(row.textContent, 'calls.missed:nick-Ann · at 2026-11-17T10:00:00Z');
});
test('the caller sees that nobody answered, and a name is only ever text', () => {
  assert.equal(draw({ id: 9, type: 'missed_call', user_id: 2, username: 'Me', created_at: 'x' }).textContent, 'calls.missed_own · at x');
  assert.equal(draw({ id: 9, type: 'missed_call', user_id: 1, username: '<b>x</b>', created_at: 'x' }).textContent, 'calls.missed:nick-<b>x</b> · at x');
});
test('an ordinary message is left to the normal drawing', () => {
  assert.equal(draw({ id: 9, type: 'user', user_id: 1, username: 'Ann' }), null);
});
