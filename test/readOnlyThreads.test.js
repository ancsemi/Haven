'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
function load(file, document) {
  const context = vm.createContext({ module: { exports: {} }, document, localStorage: { getItem: () => null, setItem() {} }, t: k => k, console });
  vm.runInContext(read(file).replace(/^export default/m, 'module.exports ='), context, { filename: file });
  return context.module.exports;
}
const node = () => { const classes = new Set(); return { style: {}, textContent: '', hidden: false, classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)), contains: c => classes.has(c) } }; };
function makeApp({ readOnly = 1, isAdmin = false, override = false, isDm = 0 } = {}) {
  const els = { 'thread-panel': node(), 'thread-closed-note': node(), 'thread-closed-text': node(), 'thread-input': { value: 'hello' }, messages: null, 'thread-messages': null };
  const buttons = { reply: node(), quote: node(), thread: node(), react: node() };
  const document = { getElementById: id => els[id] || null, querySelectorAll: sel => sel.startsWith('#messages :is(') ? [buttons.reply, buttons.quote, buttons.thread] : [] };
  const app = Object.assign(Object.create(null), load('public/js/modules/app-channel-context.js', document), load('public/js/modules/app-threads.js', document), {
    user: { id: 2, isAdmin },
    currentChannel: 'news0001',
    channels: [{ code: 'news0001', read_only: readOnly, is_dm: isDm, canOverrideReadOnly: override, reactions_enabled: 1 }],
    _hasPerm: () => false,
  });
  return { app, els, buttons };
}
test('only members who cannot post in a read-only channel are blocked', () => {
  assert.equal(makeApp().app._channelBlocksPosting(), true);
  assert.equal(makeApp({ override: true }).app._channelBlocksPosting(), false);
  assert.equal(makeApp({ isAdmin: true }).app._channelBlocksPosting(), false);
  assert.equal(makeApp({ readOnly: 0 }).app._channelBlocksPosting(), false);
  assert.equal(makeApp({ isDm: 1 }).app._channelBlocksPosting(), false);
  assert.equal(makeApp().app._channelBlocksPosting('missing1'), false);
});
test('the thread panel takes no replies and says why in a read-only channel', () => {
  const { app, els } = makeApp();
  app._applyThreadClosed(false);
  assert.equal(els['thread-panel'].classList.contains('thread-locked'), true);
  assert.equal(els['thread-closed-note'].style.display, '');
  assert.equal(els['thread-closed-text'].textContent, 'thread_runtime.read_only_no_replies');
});
test('members with Read-Only Override keep the thread reply box', () => {
  const { app, els } = makeApp({ override: true });
  app._applyThreadClosed(false);
  assert.equal(els['thread-panel'].classList.contains('thread-locked'), false);
  assert.equal(els['thread-closed-note'].style.display, 'none');
});
test('rendered reply, quote and thread buttons follow the read-only switch', () => {
  const { app, buttons } = makeApp();
  app._applyReactionLock();
  assert.deepEqual([buttons.reply, buttons.quote, buttons.thread].map(b => b.hidden), [true, true, true]);
  app.channels[0].read_only = 0;
  app._applyReactionLock();
  assert.deepEqual([buttons.reply, buttons.quote, buttons.thread].map(b => b.hidden), [false, false, false]);
});
test('a blocked thread send stops before reaching the server', () => {
  const { app } = makeApp();
  const toasts = [];
  let emitted = 0;
  Object.assign(app, { _activeThreadParent: 7, _autoEmoteWords: (text) => text, _showToast: (m, k) => toasts.push([m, k]), socket: { emit: () => { emitted++; } } });
  app._sendThreadMessage();
  assert.equal(emitted, 0);
  assert.deepEqual(toasts, [['thread_runtime.read_only_no_replies', 'error']]);
});
test('the message toolbar hides reply, quote and thread while posting is blocked, and the context menu leaves them out', () => {
  // Drawn hidden rather than left out, so they come back when the channel
  // stops being read-only.
  const toolbar = read('public/js/modules/app-messages.js');
  assert.match(toolbar, /data-action="reply" title="\$\{t\('msg_toolbar\.reply'\)\}"\$\{postBlocked \? ' hidden' : ''\}/);
  assert.match(toolbar, /data-action="quote" title="\$\{t\('msg_toolbar\.quote'\)\}"\$\{postBlocked \? ' hidden' : ''\}/);
  assert.match(toolbar, /data-action="thread" title="\$\{t\('msg_toolbar\.thread'\)\}"\$\{postBlocked \? ' hidden' : ''\}/);
  const menu = read('public/js/modules/app-message-tools.js');
  assert.match(menu, /if \(!postBlocked\) items\.push\(`<button class="channel-ctx-item" data-action="reply">/);
  assert.match(menu, /if \(!isDm && !postBlocked\) items\.push\(`<button class="channel-ctx-item" data-action="thread">/);
  assert.ok(JSON.parse(read('public/locales/en.json')).thread_runtime.read_only_no_replies);
});
