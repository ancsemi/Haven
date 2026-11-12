'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ROOT = path.join(__dirname, '..');
const load = (name, globals) => {
  const context = vm.createContext({ module: { exports: {} }, exports: {}, ...globals });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'public/js/modules', name), 'utf8').replace(/^export default/m, 'module.exports ='), context, { filename: name });
  return context.module.exports;
};
const timeouts = [];
const bar = { style: { display: 'none' }, textContent: '' };
const globals = { document: { getElementById: id => (id === 'timeout-notice' ? bar : null) }, t: (key, vars) => `${key}:${vars.count}`, setTimeout: (fn, ms) => timeouts.push({ fn, ms }) - 1, clearTimeout: () => {} };
test('a timeout refusal shows how long is left above the message box and hides it when the time is up', () => {
  const { _showTimeoutNotice } = load('app-socket.js', globals);
  const self = {};
  _showTimeoutNotice.call(self, 'You are in a timeout for 30 more minutes');
  assert.equal(bar.style.display, 'flex');
  assert.equal(bar.textContent, 'toasts.timeout_notice_other:30');
  assert.equal(timeouts.at(-1).ms, 30 * 60000);
  timeouts.at(-1).fn();
  assert.equal(bar.style.display, 'none');
  _showTimeoutNotice.call(self, 'You are in a timeout for 1 more minute');
  assert.equal(bar.textContent, 'toasts.timeout_notice_one:1');
});
test('other refusals leave the notice alone', () => {
  const { _showTimeoutNotice } = load('app-socket.js', globals);
  bar.style.display = 'none';
  _showTimeoutNotice.call({}, 'Message too long');
  _showTimeoutNotice.call({}, undefined);
  assert.equal(bar.style.display, 'none');
});
test('the error-msg listener restores a refused forum post and shows the notice only for a timeout', () => {
  const handlers = {};
  const calls = [];
  const self = new Proxy({ socket: { on: (ev, fn) => { handlers[ev] = fn; } } }, { get: (target, key) => key in target ? target[key] : (...args) => { calls.push([String(key), ...args]); } });
  const methods = load('app-socket-channels.js', { document: { getElementById: () => null, addEventListener() {}, querySelector: () => null }, window: {}, localStorage: { getItem: () => null }, t: k => k });
  try { methods._listenPresenceAndVoice.call(self); } catch (err) { assert.fail(`listener setup threw: ${err.message}`); }
  assert.equal(typeof handlers['error-msg'], 'function');
  calls.length = 0;
  handlers['error-msg']('You are in a timeout for 5 more minutes');
  assert.deepEqual(calls.map(c => c[0]).filter(k => ['_forumRestoreDraft', '_showTimeoutNotice', '_showToast'].includes(k)), ['_forumRestoreDraft', '_showTimeoutNotice', '_showToast']);
  calls.length = 0;
  handlers['error-msg']('Message too long');
  assert.deepEqual(calls.map(c => c[0]).filter(k => ['_forumRestoreDraft', '_showTimeoutNotice', '_showToast'].includes(k)), ['_showToast']);
});
