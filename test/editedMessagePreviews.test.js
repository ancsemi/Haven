'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const run = async (isResult, isDm = false) => {
  const calls = [];
  const content = { appendChild() {}, set innerHTML(v) { calls.push('content'); } };
  const el = { dataset: {}, classList: { contains: c => isResult && c === 'search-result-item' }, querySelector: s => s === '.edited-tag' ? {} : content };
  const context = vm.createContext({ module: { exports: {} }, HavenE2E: { isEncrypted: () => false }, document: { querySelectorAll: () => [el] }, t: k => k });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public/js/modules/app-socket-events.js'), 'utf8').replace(/^export default/m, 'module.exports ='), context);
  const handlers = {};
  const record = name => () => { calls.push(name); };
  const app = { ...context.module.exports, currentChannel: 'aaaaaaaa', socket: { on: (ev, h) => { handlers[ev] = h; }, emit() {} }, _formatContent: s => s, _roleMenuText: (id, s) => s, _isDmContainer: () => isDm,
    ...Object.fromEntries(['_fetchLinkPreviews', '_searchDeferEmbeds', '_setupVideos', '_decryptE2EImages', '_decryptE2EFiles', '_enforceDmLinkPolicy'].map(n => [n, record(n)])) };
  app._listenMessageChanges();
  await handlers['message-edited']({ channelCode: 'aaaaaaaa', messageId: 7, content: 'https://example.com/new', editedAt: '2026-11-25T00:00:00Z' });
  return calls;
};
test('an edited message gets its link cards and players again', async () => {
  assert.deepEqual(await run(false), ['content', '_fetchLinkPreviews', '_setupVideos', '_decryptE2EImages', '_decryptE2EFiles']);
});
test('an edited DM message is checked against the link policy again', async () => {
  assert.equal((await run(false, true)).at(-1), '_enforceDmLinkPolicy');
});
test('an edited search result keeps its embeds behind the Load button', async () => {
  assert.deepEqual(await run(true), ['content', '_searchDeferEmbeds', '_setupVideos']);
});
