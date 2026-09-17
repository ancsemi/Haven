'use strict';

/**
 * Release notes come from a third-party GitHub repository. The extension
 * update flow displays that Markdown as plain text in its confirmation modal,
 * so HTML-looking content must never become active DOM.
 *
 *   node --test test/extensionUpdateModal.test.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const ADMIN_SOURCE = fs.readFileSync(
  path.join(ROOT, 'public/js/modules/app-admin.js'),
  'utf8',
);

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function loadModal() {
  const buttons = new Map();
  let overlay;

  function fakeElement() {
    let text = null;
    let html = '';
    return {
      style: {},
      addEventListener() {},
      set textContent(value) { text = String(value); },
      get textContent() { return text || ''; },
      set innerHTML(value) { text = null; html = String(value); },
      get innerHTML() { return text === null ? html : escapeHtml(text); },
      querySelector(selector) {
        if (!buttons.has(selector)) {
          const listeners = {};
          buttons.set(selector, {
            addEventListener(type, handler) { listeners[type] = handler; },
            click() { listeners.click(); },
            focus() {},
          });
        }
        return buttons.get(selector);
      },
      remove() {},
    };
  }

  const document = {
    body: { appendChild(element) { overlay = element; } },
    createElement: () => fakeElement(),
    addEventListener() {},
    removeEventListener() {},
  };
  const context = vm.createContext({
    module: { exports: {} }, exports: {}, document,
    setTimeout: handler => { handler(); return 1; },
    t: key => ({
      'modals.common.cancel': 'Cancel',
      'modals.common.confirm': 'Confirm',
      'modals.common.warning': 'Warning',
    }[key] || key),
  });
  vm.runInContext(
    ADMIN_SOURCE.replace(/^export default/m, 'module.exports ='),
    context,
    { filename: 'app-admin.js' },
  );
  const app = Object.create(context.module.exports);
  app._escapeHtml = value => escapeHtml(value).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  return { app, buttons, getOverlay: () => overlay };
}

test('GitHub release notes are inert text in the update confirmation', async () => {
  const { app, buttons, getOverlay } = loadModal();
  const notes = '# Changes\n<img src=x onerror="globalThis.pwned=true">\n<script>globalThis.pwned=true</script>';
  const result = app._showExtensionUpdateConfirm(
    'Update extension',
    notes,
    'Only install code you trust.',
    'I understand, update',
  );
  const html = getOverlay().innerHTML;

  assert.doesNotMatch(html, /<img\b|<script\b|onerror="/i);
  assert.match(html, /# Changes\n&lt;img src=x onerror=&quot;globalThis\.pwned=true&quot;&gt;/);
  assert.match(html, /&lt;script&gt;globalThis\.pwned=true&lt;\/script&gt;/);
  buttons.get('#extension-update-cancel').click();
  assert.equal(await result, false);
});
