'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ROOT = path.join(__dirname, '..');
const MODULES = ['app-utilities.js', 'app-message-content.js', 'app-context.js', 'app-message-actions.js'].map(name => ({ name, source: fs.readFileSync(path.join(ROOT, 'public/js/modules', name), 'utf8') }));
const fakeElement = () => {
  let text = '';
  return { set textContent(v) { text = String(v); }, get textContent() { return text; }, get innerHTML() { return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); } };
};
const loadApp = () => {
  const sandbox = {
    document: { documentElement: { lang: 'en-US' }, querySelectorAll: () => [], createElement: () => fakeElement(), addEventListener: () => {} },
    window: { addEventListener: () => {} },
    navigator: { languages: ['en-US'] },
    requestAnimationFrame: callback => { callback(); return 1; },
    setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 1, clearTimeout: () => {},
    Intl, Date, Number, Math, JSON, String, Array, Object, RegExp, Error, t: (key) => key, console,
  };
  const methods = {};
  for (const mod of MODULES) {
    const context = vm.createContext({ module: { exports: {} }, exports: {}, ...sandbox });
    vm.runInContext(mod.source.replace(/^export default/m, 'module.exports ='), context, { filename: mod.name });
    Object.assign(methods, context.module.exports);
  }
  const app = Object.create(methods);
  Object.assign(app, { user: { id: 1, username: 'tester' }, channels: [], channelMembers: [], _nicknames: {} });
  return app;
};
test('a line that starts with -# and a space is small text', () => {
  assert.equal(loadApp()._formatContent('-# small note'), '<small class="chat-subtext">small note</small>');
});
test('small text keeps the formatting inside it and the lines around it', () => {
  assert.equal(loadApp()._formatContent('before\n-# **bold** note\nafter'), 'before<br><small class="chat-subtext"><strong>bold</strong> note</small><br>after');
});
test('consecutive small lines each become small text with no blank line between', () => {
  assert.equal(loadApp()._formatContent('-# one\n-# two'), '<small class="chat-subtext">one</small><br><small class="chat-subtext">two</small>');
});
test('small text sits under a heading and next to a list', () => {
  const html = loadApp()._formatContent('# Title\n-# sub\n- item');
  assert.match(html, /<div class="chat-heading chat-h1">Title<\/div>.*<small class="chat-subtext">sub<\/small>.*<ul class="chat-list"><li>item<\/li><\/ul>/);
});
test('-# in the middle of a line, without a space, or with nothing after it stays as typed', () => {
  const app = loadApp();
  assert.equal(app._formatContent('look -# here'), 'look -# here');
  assert.equal(app._formatContent('-#nospace'), '-#nospace');
  assert.doesNotMatch(app._formatContent('-# '), /chat-subtext/);
});
test('markup typed inside small text is still escaped', () => {
  assert.equal(loadApp()._formatContent('-# <b>x</b>'), '<small class="chat-subtext">&lt;b&gt;x&lt;/b&gt;</small>');
});
test('the formatting menu offers Small text', () => {
  assert.match(fs.readFileSync(path.join(ROOT, 'public/js/modules/app-composer.js'), 'utf8'), /\{ key: 'subtext',\s+before: '-# ', after: '', block: true \}/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(ROOT, 'public/locales/en.json'), 'utf8')).format_picker.subtext, 'Small text');
});
