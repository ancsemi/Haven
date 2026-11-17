'use strict';

/**
 * A spoiler stays hidden wherever a message is shown as plain text: reply
 * previews, the Threads list, forum cards and notifications.
 *
 *   node --test test/spoilerPreviews.test.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const { maskSpoilers } = require('../src/socketHandlers/helpers');

const MOD = (name) => fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'modules', name), 'utf8');

function loadApp() {
  const methods = {};
  for (const name of ['app-message-content.js', 'app-forum.js']) {
    const context = vm.createContext({ module: { exports: {} }, console, t: (k) => k, document: {}, localStorage: {}, window: {} });
    vm.runInContext(MOD(name).replace(/^export default/m, 'module.exports ='), context, { filename: name });
    Object.assign(methods, context.module.exports);
  }
  const app = Object.create(methods);
  app._isImageUrl = (l) => /\.png$/.test(l);
  return app;
}

test('a reply preview hides the spoiler and keeps the rest', () => {
  const app = loadApp();
  assert.equal(app._replyPreviewText('the butler ||did it|| in the end'), 'the butler ▒▒▒ in the end');
  assert.equal(app._replyPreviewText('||one|| and ||two||'), '▒▒▒ and ▒▒▒');
});

test('bars inside code are not a spoiler, the same as on the message itself', () => {
  const app = loadApp();
  assert.equal(app._replyPreviewText('use `a || b || c` here'), 'use `a || b || c` here');
  assert.equal(app._maskSpoilers('```\nx || y || z\n```'), '```\nx || y || z\n```');
  assert.equal(app._replyPreviewText('this || that'), 'this || that', 'a lone pair of bars is ordinary text');
});

test('a long message cut off inside a spoiler still hides it', () => {
  const app = loadApp();
  const cut = ('a'.repeat(190) + ' ||the secret').slice(0, 200);
  assert.ok(!app._replyPreviewText(cut).includes('the secre'));
  assert.ok(app._replyPreviewText(cut).endsWith('▒▒▒'));
});

test('forum titles and snippets hide it too', () => {
  const app = loadApp();
  assert.equal(app._forumTitleOf({ content: 'Ending: ||he lives||\nmore' }), 'Ending: ▒▒▒');
  assert.equal(app._forumSnippetOf({ content: 'Title\nreal ending ||he lives||' }), 'real ending ▒▒▒');
});

test('the reply bars and notifications read through the mask', () => {
  const content = MOD('app-message-content.js');
  const pip = MOD('app-pip-panels.js');
  const unread = MOD('app-channel-unread.js');
  const bar = /const content = this\._replyPreviewText\(msgEl\.dataset\.rawContent \|\|/;
  assert.match(content, bar);
  assert.match(pip, bar);
  assert.match(unread, /rawContent = this\._maskSpoilers\(rawContent\)/);
});

test('phone notifications hide it, by the same rule as the client', () => {
  assert.equal(maskSpoilers('the butler ||did it||'), 'the butler ▒▒▒');
  assert.equal(maskSpoilers('`a || b || c`'), '`a || b || c`');
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'src', 'socketHandlers', 'index.js'), 'utf8'), /displayContent = maskSpoilers\(displayContent\);\n\s+const body = /);
  const app = loadApp();
  for (const sample of ['||x|| y ||z||', '`||x||` ||y||', 'no spoilers', '']) {
    assert.equal(maskSpoilers(sample), app._maskSpoilers(sample), 'client and server agree');
  }
});
