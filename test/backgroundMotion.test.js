'use strict';

// Looping decoration is paused while Haven is in the background (#5911).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

test('the page is marked as in the background while hidden or unfocused', async () => {
  const mod = (await import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'modules', 'app-accessibility.js')).href)).default;
  const classes = new Set();
  const listeners = {};
  const doc = {
    hidden: false,
    focused: true,
    hasFocus() { return this.focused; },
    documentElement: { classList: { toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)) } },
    addEventListener: (name, fn) => { listeners[name] = fn; },
  };
  global.document = doc;
  global.window = { addEventListener: (name, fn) => { listeners[name] = fn; } };
  try {
    mod._setupBackgroundMotion.call(mod);
    assert.equal(classes.has('haven-background'), false);
    doc.focused = false;
    listeners.focus();
    assert.equal(classes.has('haven-background'), true, 'another window has the keyboard');
    doc.focused = true;
    listeners.focus();
    assert.equal(classes.has('haven-background'), false);
    doc.hidden = true;
    listeners.visibilitychange();
    assert.equal(classes.has('haven-background'), true, 'hidden');
  } finally {
    delete global.document;
    delete global.window;
  }
});

test('the shimmer and the theme effects stop in the background', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'style-roles-layout-polls.css'), 'utf8');
  const rule = /html\.haven-background \.role-gradient\.role-shimmer,[^{]*\{\s*animation-play-state:\s*paused;\s*\}/.exec(css);
  assert.ok(rule);
  assert.match(rule[0], /\[class\^="fx-"\]/);
});
