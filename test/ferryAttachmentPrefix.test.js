'use strict';
// Attachments addressed to Discord (#5795). Since #5799 the text and its
// attachments go out as one message, so the Discord target in the text covers
// them; attachments sent without text, and the messages past the first ten,
// carry the target themselves.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ROOT = path.join(__dirname, '..');
const FILES = ['app-messages.js', 'app-attachments.js', 'app-ferry.js', 'app-media-grid.js', 'app-silent.js'];
function loadApp(globals) {
  const methods = {};
  FILES.forEach(name => {
    const context = vm.createContext({ module: { exports: {} }, console, ...globals });
    const src = fs.readFileSync(path.join(ROOT, 'public/js/modules', name), 'utf8')
      .replace(/^export default/m, 'module.exports =')
      .replace(/^export const /gm, 'const ');
    vm.runInContext(src, context, { filename: name });
    Object.assign(methods, context.module.exports);
  });
  return methods;
}
const pic = (n) => ({ type: 'image/png', name: `p${n}.png`, line: `/uploads/p${n}.png` });
const doc = { type: 'application/pdf', name: 'a.pdf', line: '[file:a.pdf](/uploads/a.pdf|1 KB)' };
function makeApp(value, { images = [], files = [], dm = null } = {}) {
  const input = { value, style: {}, focus() {}, dispatchEvent() {} };
  const emitted = [];
  const methods = loadApp({ document: { getElementById: id => (id === 'message-input' ? input : null), querySelector: () => null }, t: k => k, Event: class {} });
  const app = Object.assign(Object.create(null), methods, {
    currentChannel: 'aaaaaaaa',
    channels: [{ code: 'aaaaaaaa', is_dm: 0 }],
    socket: { connected: true, emit: (ev, data) => emitted.push([ev, data]) },
    notifications: { play() {} },
    user: { username: 'u' },
    _imageQueue: images,
    _fileQueue: files,
    _ferryDm: dm,
    _ferryTargets: { aaaaaaaa: { enabled: true, trigger: '=>', targets: [{ guild_name: 'Test Guild', discord_channel_name: 'general' }] } },
    _destructField: () => ({}),
    _highlightDefault: () => false,
    _autoEmoteWords: (text) => text,
    _setHighlightArmed() {},
    _clearReply() {},
    _hideMentionDropdown() {},
    _hideSlashDropdown() {},
    _renderImageQueue() {},
    _isForumChannel: () => false,
    _maxAttachments: () => 50,
    _dmSendGate: async () => ({ partner: null }),
    _mediaUploadLine: async (file) => ({ line: file.line, url: file.line.replace(/^.*?(\/uploads\/[^|)]+).*$/, '$1') }),
  });
  return { app, emitted };
}
const settle = () => new Promise(r => setTimeout(r, 50));
const contents = (emitted) => emitted.map(([, d]) => d.content);

test('a picture sent with a Discord target goes in the same message as the target', async () => {
  const { app, emitted } = makeApp('=>Test Guild#general look', { images: [pic(1)] });
  await app._sendMessage();
  await settle();
  assert.deepEqual(contents(emitted), ['=>Test Guild#general look\n/uploads/p1.png']);
  assert.equal(emitted[0][1].bundled, undefined);
});

test('a target with only attachments sends no empty text and still addresses them', async () => {
  const { app, emitted } = makeApp('=>#general', { images: [pic(1)], files: [doc] });
  await app._sendMessage();
  await settle();
  assert.deepEqual(contents(emitted), [`=>#general /uploads/p1.png\n${doc.line}`]);
  assert.equal(emitted[0][1].isImage, true);
  assert.equal(emitted[0][1].bundled, undefined);
});

test('a Discord DM target hands its user id to the attachments', async () => {
  const { app, emitted } = makeApp('=>@Alice hi', { images: [pic(1)], files: [doc], dm: { id: '1300000000000000100', label: '@Alice' } });
  await app._sendMessage();
  await settle();
  assert.deepEqual(contents(emitted), [`=>@Alice hi\n/uploads/p1.png\n${doc.line}`]);
  assert.equal(emitted[0][1].ferryDiscordUserId, '1300000000000000100');
});

test('past ten, the further messages carry the target themselves', async () => {
  const images = Array.from({ length: 12 }, (_, i) => pic(i + 1));
  const { app, emitted } = makeApp('=>Test Guild#general trip', { images });
  await app._sendMessage();
  await settle();
  assert.equal(emitted.length, 2);
  assert.equal(emitted[0][1].content.split('\n').length, 11);
  assert.equal(emitted[1][1].content, '=>Test Guild#general /uploads/p11.png\n/uploads/p12.png');
  assert.equal(emitted[1][1].bundled, true);
});

test('an unknown target and plain text leave the text as it was', async () => {
  for (const text of ['=>Nowhere#x hi', 'just text', '::Alter hello']) {
    const { app, emitted } = makeApp(text, { images: [pic(1)] });
    await app._sendMessage();
    await settle();
    assert.deepEqual(contents(emitted), [`${text}\n/uploads/p1.png`], text);
  }
});
