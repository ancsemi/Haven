'use strict';

/**
 * Fenced code blocks: a word after the opening fence is a language name only
 * when the line ends there. "```ls haven```" on one line is all code.
 *
 *   node --test test/codeBlocks.test.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const MODULES = ['app-utilities.js', 'app-message-content.js', 'app-context.js', 'app-message-actions.js'].map(name => ({
  name,
  source: fs.readFileSync(path.join(ROOT, 'public/js/modules', name), 'utf8'),
}));

function fakeElement() {
  let text = '';
  return {
    set textContent(v) { text = String(v); },
    get textContent() { return text; },
    get innerHTML() { return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); },
  };
}

function loadApp({ clipboard, onDocumentClick, onDocumentListener } = {}) {
  const sandbox = {
    document: {
      documentElement: { lang: 'en-US' },
      querySelectorAll: () => [],
      createElement: () => fakeElement(),
      addEventListener: (type, handler) => {
        if (type === 'click') onDocumentClick?.(handler);
        onDocumentListener?.(type, handler);
      },
    },
    window: { addEventListener: () => {} },
    navigator: { languages: ['en-US'], clipboard },
    requestAnimationFrame: callback => { callback(); return 1; },
    setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 1, clearTimeout: () => {},
    Intl, Date, Number, Math, JSON, String, Array, Object, RegExp, Error,
    t: (key) => key,
    console,
  };
  const methods = {};
  for (const mod of MODULES) {
    const context = vm.createContext({ module: { exports: {} }, exports: {}, ...sandbox });
    vm.runInContext(mod.source.replace(/^export default/m, 'module.exports ='), context, { filename: mod.name });
    Object.assign(methods, context.module.exports);
  }
  const app = Object.create(methods);
  app.user = { id: 1, username: 'tester' };
  app.channels = [];
  app.channelMembers = [];
  app._nicknames = {};
  return app;
}

const block = (html) => {
  const m = html.match(/<div class="code-block"([^>]*)>(.*?)<pre><code>([\s\S]*?)<\/code><\/pre><\/div>/);
  assert.ok(m, 'renders a code block: ' + html);
  return { lang: (m[1].match(/data-lang="([^"]*)"/) || [])[1] || '', code: m[3] };
};

test('a one-line block keeps its first word', () => {
  const app = loadApp();
  assert.deepEqual(block(app._formatContent('```chmod +x haven/start.sh```')), { lang: '', code: 'chmod +x haven/start.sh' });
  assert.deepEqual(block(app._formatContent('```ls haven```')), { lang: '', code: 'ls haven' });
  assert.deepEqual(block(app._formatContent('```haven```')), { lang: '', code: 'haven' });
});

test('a word alone on the opening line is the language', () => {
  const app = loadApp();
  assert.deepEqual(block(app._formatContent('```js\nconst a = 1;\n```')), { lang: 'js', code: 'const a = 1;' });
  assert.deepEqual(block(app._formatContent('```bash  \nsudo ls\n```')), { lang: 'bash', code: 'sudo ls' });
});

test('a block that starts on the next line has no language and no leading blank line', () => {
  const app = loadApp();
  assert.deepEqual(block(app._formatContent('```\nsudo firewall-cmd --reload\n```')), { lang: '', code: 'sudo firewall-cmd --reload' });
});

test('fenced blocks render an accessible copy button', () => {
  const app = loadApp();
  const html = app._formatContent('```js\nconst answer = 42;\n```');
  assert.match(html, /<button type="button" class="code-block-copy"[^>]*aria-label="common\.copy"[^>]*>common\.copy<\/button>/);
});

test('copying a code block writes the exact code text and shows copied feedback', async () => {
  const copied = [];
  const app = loadApp({ clipboard: { writeText: async text => copied.push(text) } });
  const codeText = 'const answer = 42;\nnextLine();';
  const codeBlock = { querySelector: () => ({ textContent: codeText }) };
  const button = {
    dataset: { copyLabel: 'common.copy' },
    textContent: 'common.copy',
    closest: selector => selector === '.code-block' ? codeBlock : null,
    isConnected: false,
  };

  await app._copyCodeBlock(button);

  assert.deepEqual(copied, [codeText]);
  assert.equal(button.textContent, '✓ common.copied');
});

test('delegated clicks on code-copy buttons invoke copying and stop the click', () => {
  let clickHandler;
  const app = loadApp({ onDocumentClick: handler => { clickHandler = handler; } });
  const button = {};
  let copiedButton = null;
  app._copyCodeBlock = clicked => { copiedButton = clicked; };
  app._bindCodeBlockCopy();

  let prevented = false;
  let stopped = false;
  clickHandler({
    target: { closest: selector => selector === '.code-block-copy' ? button : null },
    preventDefault: () => { prevented = true; },
    stopPropagation: () => { stopped = true; },
  });

  assert.equal(copiedButton, button);
  assert.equal(prevented, true);
  assert.equal(stopped, true);

  prevented = false;
  clickHandler({
    target: { closest: () => null },
    preventDefault: () => { prevented = true; },
    stopPropagation: () => {},
  });
  assert.equal(prevented, false);
});

test('hover delegation shifts the copy button only when it overlaps the message toolbar', () => {
  const listeners = {};
  const app = loadApp({ onDocumentListener: (type, handler) => { listeners[type] = handler; } });
  app._bindCodeBlockCopy();
  assert.equal(typeof listeners.pointerover, 'function');
  assert.equal(typeof listeners.pointerout, 'function');

  const makeMessage = (buttonRect, toolbarRect) => {
    let shifted = false;
    const button = {
      getBoundingClientRect: () => shifted
        ? { left: 8, right: 48, top: 4, bottom: 24 }
        : buttonRect,
    };
    const block = {
      querySelector: () => button,
      classList: {
        add: () => { shifted = true; },
        remove: () => { shifted = false; },
      },
    };
    const toolbar = { getBoundingClientRect: () => toolbarRect };
    const message = {
      querySelector: () => toolbar,
      querySelectorAll: selector => selector === '.code-block' ? [block] : [],
      contains: () => false,
      matches: () => true,
    };
    return { message, isShifted: () => shifted };
  };
  const hover = message => listeners.pointerover({
    target: { closest: () => message },
    relatedTarget: null,
  });

  const overlapping = makeMessage(
    { left: 180, right: 220, top: 4, bottom: 24 },
    { left: 190, right: 250, top: 0, bottom: 36 },
  );
  hover(overlapping.message);
  assert.equal(overlapping.isShifted(), true);
  listeners.pointerout({ target: { closest: () => overlapping.message }, relatedTarget: null });
  assert.equal(overlapping.isShifted(), false);

  const separate = makeMessage(
    { left: 180, right: 220, top: 4, bottom: 24 },
    { left: 20, right: 80, top: 0, bottom: 36 },
  );
  hover(separate.message);
  assert.equal(separate.isShifted(), false);
});
