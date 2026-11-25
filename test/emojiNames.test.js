'use strict';
/**
 * Custom emoji names take letters and digits of any script plus _ and -, 2 to
 * 32 characters. <, > and : and white space stay out, and names made before
 * (ASCII, 1 to 30 characters) keep working.
 *
 *   node --test test/emojiNames.test.js
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { NAMED_EMOJI_RE, isEmojiName, cleanEmojiName, isUsableEmoji, isPortableEmoji } = require('../src/builtinEmojis');
const { createHarness } = require('./socketServerHarness');
const ROOT = path.join(__dirname, '..');
const PORT = 3731;
const h = createHarness(PORT, 'emoji-names');
const GOOD = ['ab', 'party_parrot', 'Kappa', 'x-1', 'Привет', '笑顔', 'ナイス', 'العربية', 'हिन्दी', 'ไทย', 'café', 'ñandú', '٣٤', 'a'.repeat(32), '𠀀𠀁'];
const BAD = ['', 'a', 'a'.repeat(33), 'a:b', ':ab', 'ab:', '<ab>', 'a<b', 'a>b', 'a b', 'a\tb', 'a\nb', 'a b', 'a​b', 'a.b', 'a/b', '😀😀', 'ab️', '́ab', null, undefined, 7];
test('names in any script are accepted, and the forbidden characters are refused', () => {
  for (const n of GOOD) assert.ok(isEmojiName(n), n);
  for (const n of BAD) assert.ok(!isEmojiName(n), String(n));
});
test(':name: parses for any script and never across a forbidden character', () => {
  for (const n of [...GOOD, 'a']) assert.equal(NAMED_EMOJI_RE.exec(`:${n}:`)?.[1], n, n);
  for (const t of ['::', ':a:b:', ':<a>:', ':a b:', ':a>:', ':a<:', ':a​b:', `:${'a'.repeat(33)}:`]) assert.equal(NAMED_EMOJI_RE.exec(t), null, t);
});
test('cleaning keeps what is allowed and drops the rest', () => {
  assert.equal(cleanEmojiName('  <Party:Parrot> '), 'PartyParrot');
  assert.equal(cleanEmojiName('привет мир'), 'приветмир');
  assert.equal(cleanEmojiName('é'), 'é');
  assert.equal(cleanEmojiName('a'.repeat(40)), 'a'.repeat(32));
  assert.equal(cleanEmojiName('😀:<>'), '');
  assert.equal(cleanEmojiName(null), '');
});
test('names that exist keep working as reactions and role emoji', () => {
  const rows = new Set(['partyparrot', 'Привет', 'a', 'x'.repeat(30)]);
  const db = { prepare: () => ({ get: (lower, exact) => (rows.has(lower) || rows.has(exact) ? { 1: 1 } : undefined) }) };
  for (const ok of [':partyparrot:', ':PartyParrot:', ':Привет:', ':a:', `:${'x'.repeat(30)}:`, ':flag_us:', ':os_linux:', '🎮']) assert.ok(isUsableEmoji(db, ok), ok);
  for (const bad of [':nope:', ':привет2:', ':a<b:', ':a:b:', '::', ':<x>:', `:${'x'.repeat(33)}:`, 'a'.repeat(80)]) assert.ok(!isUsableEmoji(db, bad), bad);
  assert.ok(!isPortableEmoji(':Привет:'), 'a custom one still does not travel in a template');
});
function client(file) {
  const src = fs.readFileSync(path.join(ROOT, 'public/js/modules', file), 'utf8').replace(/^import .*$/gm, '');
  const context = vm.createContext({ module: { exports: {} }, console, localStorage: { getItem: () => 'true' }, t: (k) => k });
  vm.runInContext(src.replace(/^export default/m, 'module.exports ='), context, { filename: file });
  return context.module.exports;
}
test('the web client resolves, renders and counts :name: in any script', () => {
  const utilities = client('app-utilities.js');
  const content = client('app-message-content.js');
  const customEmojis = ['Привет', '笑顔', 'ab', 'Kappa'].map((n) => ({ name: n, url: `/uploads/${encodeURIComponent(n)}.png` }));
  const app = { ...utilities, ...content, builtinEmojis: [], customEmojis, _escapeHtml: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') };
  assert.equal(app._findNamedEmoji('привет').name, 'Привет');
  assert.equal(app._findNamedEmoji('笑顔').name, '笑顔');
  assert.equal(app._findNamedEmoji('KAPPA').name, 'Kappa');
  assert.equal(app._findNamedEmoji('missing'), null);
  assert.equal(app._findNamedEmoji('é'), null);
  assert.ok(app._isEmojiOnly(':Привет: :笑顔:'));
  assert.ok(app._isEmojiOnly(':kappa:'));
  assert.ok(!app._isEmojiOnly(':Привет: hi'));
  assert.ok(!app._isEmojiOnly(':nobody:'));
  assert.equal(app._autoEmoteWords('hello Привет 笑顔 world'), 'hello :Привет: :笑顔: world');
  assert.equal(app._autoEmoteWords('hello Kappa'), 'hello :Kappa:');
});
test('the server takes, cleans and refuses names on upload', async (t) => {
  await h.start();
  t.after(() => h.stop());
  const admin = await h.register('admin');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  const auth = { Authorization: `Bearer ${admin.token}` };
  const send = async (route, field, name, file) => {
    const fd = new FormData();
    name && fd.append('name', name);
    fd.append(field, new Blob([png], { type: 'image/png' }), file);
    const res = await fetch(`http://localhost:${PORT}${route}`, { method: 'POST', headers: auth, body: fd });
    return { status: res.status, ...(await res.json()) };
  };
  const names = async () => (await (await fetch(`http://localhost:${PORT}/api/emojis`, { headers: auth })).json()).emojis.map((e) => e.name).sort();
  for (const n of ['Привет', '笑顔', 'party_parrot', 'x-1']) assert.equal((await send('/api/upload-emoji', 'emoji', n, 'a.png')).name, n, n);
  assert.equal((await send('/api/upload-emoji', 'emoji', '<Bad:Name>', 'a.png')).name, 'BadName', 'forbidden characters never reach a stored name');
  assert.equal((await send('/api/upload-emoji', 'emoji', 'two words', 'a.png')).name, 'twowords');
  assert.equal((await send('/api/upload-emoji', 'emoji', 'é'.repeat(40), 'a.png')).name, 'é'.repeat(32));
  for (const n of ['a', ':', '<>', '😀']) {
    const r = await send('/api/upload-emoji', 'emoji', n, 'a.png');
    assert.ok(r.status === 400 || (r.name && isEmojiName(r.name)), `${n} ${JSON.stringify(r)}`);
  }
  const bulk = await send('/api/upload-emojis', 'emojis', '', 'Смех.png');
  assert.equal(bulk.uploaded[0].name, 'Смех');
  assert.equal((await send('/api/upload-emojis', 'emojis', '', 'a.png')).errors.length, 1, 'a one-letter file name is refused');
  const stored = await names();
  assert.ok(stored.every(isEmojiName), stored.join(','));
  assert.ok(stored.every((n) => !/[<>:\s]/u.test(n)));
  assert.ok(stored.includes('Привет') && stored.includes('笑顔') && stored.includes('Смех'));
  const del = await fetch(`http://localhost:${PORT}/api/emojis/${encodeURIComponent('Привет')}`, { method: 'DELETE', headers: auth });
  assert.equal(del.status, 200);
  assert.ok(!(await names()).includes('Привет'));
});
