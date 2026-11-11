'use strict';

/**
 * Media-only channels (text_enabled === 0, media_enabled !== 0) hide text-only
 * composer controls while keeping the composer container, upload button, and Send
 * button visible so attached media can be sent.
 *
 *   node --test test/mediaOnlyComposer.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CHANNELS_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'modules', 'app-channels.js'),
  'utf8',
);
const SOCKET_CHANNELS_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'modules', 'app-socket-channels.js'),
  'utf8',
);
const STATUS_CSS = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'css', 'style-status-effects.css'),
  'utf8',
);

function makeElement(id) {
  const attrs = new Set();
  return {
    id,
    style: { display: '' },
    toggleAttribute(name, force) {
      const next = force === undefined ? !attrs.has(name) : !!force;
      if (next) attrs.add(name);
      else attrs.delete(name);
      return next;
    },
    hasAttribute(name) {
      return attrs.has(name);
    },
  };
}

function makeApp(user = { isAdmin: false }) {
  const elements = {
    'message-input-area': makeElement('message-input-area'),
    'message-input': makeElement('message-input'),
    'send-btn': makeElement('send-btn'),
    'emoji-btn': makeElement('emoji-btn'),
    'gif-btn': makeElement('gif-btn'),
    'poll-btn': makeElement('poll-btn'),
    'time-btn': makeElement('time-btn'),
    'time-divider': makeElement('time-divider'),
    'upload-btn': makeElement('upload-btn'),
  };
  const dividers = [makeElement('div0'), makeElement('div1'), makeElement('div2')];

  const document = {
    getElementById: (id) => elements[id] || null,
    querySelectorAll: (sel) => (sel === '.input-actions-box .input-actions-divider' ? dividers : []),
  };

  const context = vm.createContext({
    module: { exports: {} },
    console,
    t: (k) => k,
    document,
    localStorage: {},
    window: { innerWidth: 1280 },
  });
  vm.runInContext(CHANNELS_SRC.replace(/^export default/m, 'module.exports ='), context);

  const app = Object.create(context.module.exports);
  app.user = user;
  app._updateReadOnlyNote = () => {};
  app._applyReactionLock = () => {};
  return { app, elements, dividers };
}

test('keeps send button and composer visible in a media-only channel', () => {
  const { app, elements, dividers } = makeApp();
  app._updateComposerVisibility({
    code: 'mediaonly',
    text_enabled: 0,
    media_enabled: 1,
    read_only: 0,
  });

  assert.equal(elements['message-input-area'].style.display, '');
  assert.equal(elements['message-input-area'].hasAttribute('data-text-off'), true);
  assert.equal(elements['send-btn'].style.display, '');
  assert.equal(elements['upload-btn'].style.display, '');
  assert.equal(elements['message-input'].style.display, 'none');
  assert.equal(elements['emoji-btn'].style.display, 'none');
  assert.equal(elements['gif-btn'].style.display, 'none');
  assert.equal(elements['poll-btn'].style.display, 'none');
  assert.equal(elements['time-btn'].style.display, 'none');
  assert.equal(dividers[0].style.display, 'none');
  assert.equal(dividers[1].style.display, 'none');
  assert.equal(dividers[2].style.display, 'none');
});

test('hides send button and composer when both text and media are disabled', () => {
  const { app, elements } = makeApp();
  app._updateComposerVisibility({
    code: 'voiceonly',
    text_enabled: 0,
    media_enabled: 0,
    read_only: 0,
  });

  assert.equal(elements['message-input-area'].style.display, 'none');
  assert.equal(elements['send-btn'].style.display, 'none');
  assert.equal(elements['upload-btn'].style.display, 'none');
});

test('restores text input and send button when switching back to a standard channel', () => {
  const { app, elements, dividers } = makeApp();
  app._updateComposerVisibility({ code: 'mediaonly', text_enabled: 0, media_enabled: 1, read_only: 0 });
  app._updateComposerVisibility({ code: 'general00', text_enabled: 1, media_enabled: 1, read_only: 0 });

  assert.equal(elements['message-input-area'].style.display, '');
  assert.equal(elements['message-input-area'].hasAttribute('data-text-off'), false);
  assert.equal(elements['message-input'].style.display, '');
  assert.equal(elements['send-btn'].style.display, '');
  assert.equal(elements['upload-btn'].style.display, '');
  assert.equal(dividers[0].style.display, '');
});

test('socket channel updates reuse _updateComposerVisibility and hide-send preference spares media-only channels', () => {
  assert.match(SOCKET_CHANNELS_SRC, /this\._updateComposerVisibility\?\.\(curCh\)/);
  assert.match(STATUS_CSS, /\[data-hide-send-btn\]\s+#message-input-area:not\(\[data-text-off\]\)\s+#send-btn\s*\{\s*display:\s*none\s*!important;\s*\}/);
});
