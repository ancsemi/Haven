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
const MODULES = ['app-utilities.js', 'app-message-content.js', 'app-context.js'].map(name => ({
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

function loadApp() {
  const sandbox = {
    document: { documentElement: { lang: 'en-US' }, querySelectorAll: () => [], createElement: () => fakeElement() },
    navigator: { languages: ['en-US'] },
    setInterval: () => 0, clearInterval: () => {},
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
