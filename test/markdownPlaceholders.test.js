'use strict';

/**
 * The markdown renderer sets links, images and other pieces aside behind
 * NUL-delimited placeholders and puts them back at the end. Typed text that
 * looked like a placeholder used to be swapped for the real piece, so a
 * message could drop a link's HTML inside an image's alt attribute.
 *
 *   node --test test/markdownPlaceholders.test.js
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
    location: { href: 'https://haven.example/app', origin: 'https://haven.example' },
    setInterval: () => 0, clearInterval: () => {},
    Intl, Date, Number, Math, JSON, String, Array, Object, RegExp, Error, URL,
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

const imgTags = (html) => html.match(/<img\b[^>]*>/g) || [];

test('a typed placeholder cannot pull a link into an image attribute', () => {
  const app = loadApp();
  const html = app._formatContent('![\u0000MDLINK_1\u0000](https://example.com/a.png)[x](https://example.com/" onerror="alert(1))');
  assert.ok(!html.includes('\u0000'), 'no NUL survives');
  for (const tag of imgTags(html)) {
    assert.ok(!/alt="[^"]*</.test(tag), 'alt holds no markup: ' + tag);
    assert.ok(!/onerror/i.test(tag), 'no injected handler: ' + tag);
  }
});

test('typed placeholders for every kind stay plain text', () => {
  const app = loadApp();
  for (const kind of ['MDLINK_0', 'AUTOLINK_0', 'COLOR_0', 'ENDCOLOR', 'TIMESTAMP_0', 'CODEBLOCK_0', 'INLINECODE_0']) {
    const html = app._formatContent(`a\u0000${kind}\u0000b https://example.com/page c#ff0000red#c`);
    assert.ok(!html.includes('\u0000'), kind + ': no NUL survives');
    assert.ok(html.includes(`a${kind}b`), kind + ': typed text stays as typed: ' + html);
    assert.equal((html.match(/<a\b/g) || []).length, 1, kind + ': one real link');
    assert.equal((html.match(/<span style="color:#ff0000">/g) || []).length, 1, kind + ': one colour span');
  }
});

test('a colour span or timestamp inside a link URL never lands in the href', () => {
  const app = loadApp();
  for (const input of ['[x](https://a.com/c#112233y#c)', '[x](https://a.com/<t:1>)', '![x](https://a.com/<t:1>.png)', 'https://a.com/c#112233y#c']) {
    const html = app._formatContent(input);
    assert.ok(!html.includes('\u0000'), input + ': no NUL survives');
    for (const m of html.matchAll(/(?:href|src)="([^"]*)"/g)) {
      assert.ok(!/[<>]/.test(m[1]), input + ': no markup inside the URL: ' + html);
    }
    for (const tag of html.match(/<a\b[^>]*>/g) || []) {
      assert.ok(!/<a\b[^>]*</.test(tag), input + ': link tag holds no markup: ' + tag);
    }
  }
});

test('other control characters are stripped, line breaks and tabs kept', () => {
  const app = loadApp();
  const html = app._formatContent('one\u0001\u0007\u001B\u007Ftwo\nthree\tfour');
  assert.ok(!/[\u0000-\u0008\u000B-\u001F\u007F]/.test(html));
  assert.ok(html.includes('onetwo<br>three\tfour'), html);
});

test('ordinary markdown still renders', () => {
  const app = loadApp();
  const html = app._formatContent('**hi** [site](https://example.com/x) `code` c#00ff00green#c');
  assert.ok(html.includes('<strong>hi</strong>'));
  assert.ok(/<a href="https:\/\/example\.com\/x"[^>]*data-masked-link="true">site<\/a>/.test(html), html);
  assert.ok(html.includes('<code class="inline-code">code</code>'));
  assert.ok(html.includes('<span style="color:#00ff00">green</span>'));
});

test('a link inside backticks stays plain text', () => {
  const app = loadApp();
  const html = app._formatContent('run `curl https://example.com/api?a=1&b=2` then see https://example.com/doc');
  assert.ok(html.includes('<code class="inline-code">curl https://example.com/api?a=1&amp;b=2</code>'), html);
  assert.equal((html.match(/<a href=/g) || []).length, 1, 'only the link outside the code is clickable: ' + html);
  assert.ok(app._formatContent('`**not bold** @everyone`').includes('<code class="inline-code">**not bold** @everyone</code>'));
});

test('a file card only renders for this server\'s uploads', () => {
  const app = loadApp();
  const local = app._formatContent('[file:song.mp3](/uploads/abc.mp3|1 MB)');
  assert.ok(local.includes('<audio') && local.includes('src="/uploads/abc.mp3"'), local);
  for (const url of ['https://evil.example/x.mp3', '//evil.example/x.mp4', 'data:audio/mp3;base64,AAAA', 'https://evil.example/x.pdf']) {
    const html = app._formatContent(`[file:a.${url.split('.').pop()}](${url}|1 MB)`);
    assert.ok(!/<(audio|video|a)\b/.test(html) && !html.includes('file-attachment'), url + ' renders as text: ' + html);
  }
});
