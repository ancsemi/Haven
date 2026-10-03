'use strict';

/**
 * Release notes come from a third-party GitHub repository. The extension
 * update flow displays that Markdown as plain text in its confirmation modal,
 * so HTML-looking content must never become active DOM. A broken extension
 * also stays visible as an inert error row without hiding healthy updates.
 *
 *   node --test test/extensionUpdateModal.test.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const CONTROLS_SOURCE = fs.readFileSync(
  path.join(ROOT, 'public/js/modules/app-admin-controls.js'),
  'utf8',
);

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function loadControls(extensions = []) {
  const buttons = new Map();
  let overlay;

  function fakeElement(tagName = 'div') {
    let text = null;
    let html = '';
    const listeners = {};
    return {
      tagName: tagName.toUpperCase(),
      className: '',
      children: [],
      style: {},
      addEventListener(type, handler) { listeners[type] = handler; },
      click() { return listeners.click(); },
      appendChild(element) { this.children.push(element); },
      replaceChildren() { this.children = []; },
      get childElementCount() { return this.children.length; },
      set textContent(value) { text = String(value); },
      get textContent() { return text || ''; },
      set innerHTML(value) { text = null; html = String(value); },
      get innerHTML() { return text === null ? html : escapeHtml(text); },
      querySelectorAll(selector) {
        const matches = [];
        for (const child of this.children) {
          if (selector.startsWith('.')
            ? child.className.split(' ').includes(selector.slice(1))
            : child.tagName === selector.toUpperCase()) matches.push(child);
          matches.push(...child.querySelectorAll(selector));
        }
        return matches;
      },
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

  const elements = new Map([
    ['extension-update-check', fakeElement('button')],
    ['extension-update-status', fakeElement()],
    ['extension-update-results', fakeElement()],
  ]);
  const document = {
    body: { appendChild(element) { overlay = element; } },
    createElement: tagName => fakeElement(tagName),
    getElementById: id => elements.get(id),
    addEventListener() {},
    removeEventListener() {},
  };
  const context = vm.createContext({
    module: { exports: {} }, exports: {}, document,
    fetch: async () => ({ ok: true, json: async () => ({ extensions }) }),
    setTimeout: handler => { handler(); return 1; },
    t: key => ({
      'modals.common.cancel': 'Cancel',
      'modals.common.confirm': 'Confirm',
      'modals.common.warning': 'Warning',
    }[key] || key),
  });
  vm.runInContext(
    CONTROLS_SOURCE.replace(/^export default/m, 'module.exports ='),
    context,
    { filename: 'app-admin-controls.js' },
  );
  const app = Object.create(context.module.exports);
  app._escapeHtml = value => escapeHtml(value).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  return { app, buttons, elements, getOverlay: () => overlay };
}

test('GitHub release notes are inert text in the update confirmation', async () => {
  const { app, buttons, getOverlay } = loadControls();
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

test('a broken extension remains an inert error row alongside a healthy update', async () => {
  const brokenFile = '<img src=x onerror="globalThis.pwned=true">.plugin.js';
  const error = 'Invalid @version <script>globalThis.pwned=true</script>';
  const { app, elements } = loadControls([
    { type: 'plugin', file: brokenFile, error, offers: [] },
    {
      type: 'theme', file: 'Healthy.theme.css', version: '1.0.0', repo: 'owner/healthy',
      offers: [{ action: 'install', version: '1.1.0', releaseUrl: 'https://github.com/owner/healthy/releases/tag/v1.1.0', token: 'offer' }],
    },
  ]);
  app._setupExtensionUpdates();
  await elements.get('extension-update-check').click();

  const cards = elements.get('extension-update-results').children;
  assert.equal(cards.length, 2);
  const broken = cards[0];
  const name = broken.querySelectorAll('.plugin-card-name')[0];
  assert.equal(name.textContent, brokenFile);
  assert.equal(name.innerHTML, escapeHtml(brokenFile));
  const descriptions = broken.querySelectorAll('.plugin-card-desc');
  assert.equal(descriptions.length, 1, 'missing repository does not produce an empty description');
  assert.equal(descriptions[0].textContent, error);
  assert.equal(descriptions[0].innerHTML, escapeHtml(error));
  assert.equal(broken.querySelectorAll('button').length, 0);
  assert.equal(broken.querySelectorAll('a').length, 0);

  const healthy = cards[1];
  assert.equal(healthy.querySelectorAll('.plugin-card-name')[0].textContent, 'Healthy.theme.css · 1.0.0');
  assert.equal(healthy.querySelectorAll('.plugin-card-desc')[0].textContent, 'owner/healthy');
  assert.equal(healthy.querySelectorAll('button').length, 1);
  assert.equal(healthy.querySelectorAll('a').length, 1);
  assert.equal(elements.get('extension-update-check').disabled, false);
});
