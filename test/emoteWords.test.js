'use strict';

// Custom emote names keep their capitals, and an opt-in setting turns a bare
// word that is exactly an emote's name into that emote when a message is sent
// (#5895), the way Twitch and 7TV chat works: no colons, no picker.
//
//   node --test test/emoteWords.test.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { createHarness } = require('./socketServerHarness');

const ROOT = path.join(__dirname, '..');
const PORT = 3641;
const h = createHarness(PORT, 'emote-words');

function storage(seed = {}) {
  const data = new Map(Object.entries(seed));
  return { getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)) };
}

function app(names, on = true) {
  const src = fs.readFileSync(path.join(ROOT, 'public/js/modules/app-utilities.js'), 'utf8');
  const context = vm.createContext({ module: { exports: {} }, console, localStorage: storage(on ? { 'haven-emote-words': 'true' } : {}), t: (k) => k });
  vm.runInContext(src.replace(/^export default/m, 'module.exports ='), context, { filename: 'app-utilities.js' });
  return { ...context.module.exports, builtinEmojis: [{ name: 'gadsden', url: '/b/gadsden.png' }], customEmojis: names.map((n) => ({ name: n, url: `/uploads/${n}.png` })) };
}

test('a name is found as typed first, then in any capitals', () => {
  const a = app(['HOLY', 'holy', 'Kappa']);
  assert.equal(a._findNamedEmoji('HOLY').url, '/uploads/HOLY.png');
  assert.equal(a._findNamedEmoji('holy').url, '/uploads/holy.png');
  assert.equal(a._findNamedEmoji('kappa').name, 'Kappa');
  assert.equal(a._findNamedEmoji('KAPPA').name, 'Kappa');
  assert.equal(a._findNamedEmoji('gadsden').url, '/b/gadsden.png');
  assert.equal(a._findNamedEmoji('missing'), null);
});

test('bare words that are exactly an emote name become the emote', () => {
  const a = app(['HOLY', 'pog', 'pepe-sad']);
  assert.equal(a._autoEmoteWords('HOLY'), ':HOLY:');
  assert.equal(a._autoEmoteWords('that was HOLY pog moment'), 'that was :HOLY: :pog: moment');
  assert.equal(a._autoEmoteWords('pepe-sad\nHOLY\tpog'), ':pepe-sad:\n:HOLY:\t:pog:');
  assert.equal(a._autoEmoteWords('holy Holy POG'), 'holy Holy POG');
  assert.equal(a._autoEmoteWords('HOLY, (pog) pog! pogs'), 'HOLY, (pog) pog! pogs');
});

test('code, links, mentions, tokens and slash commands are left alone', () => {
  const a = app(['HOLY', 'pog']);
  const same = ['`HOLY pog`', '```\nHOLY\npog\n```', 'see https://x.test/pog', '@pog #HOLY', ':HOLY: :pog:', '<:HOLY:123456789012345678>', '/shrug HOLY', '||HOLY||'];
  same.forEach((s) => assert.equal(a._autoEmoteWords(s), s, s));
  assert.equal(a._autoEmoteWords('pog `pog` pog'), ':pog: `pog` :pog:');
  assert.equal(a._autoEmoteWords('```\npog\n``` pog'), '```\npog\n``` :pog:');
});

test('it does nothing until the setting is on, or with no emotes', () => {
  assert.equal(app(['HOLY'], false)._autoEmoteWords('HOLY'), 'HOLY');
  assert.equal(app([])._autoEmoteWords('HOLY'), 'HOLY');
  assert.equal(app(['HOLY'])._autoEmoteWords(''), '');
});

test('the server keeps an emote name as uploaded', async (t) => {
  await h.start();
  t.after(() => h.stop());
  const admin = await h.register('admin');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  const send = async (route, field, name, file) => {
    const fd = new FormData();
    name && fd.append('name', name);
    fd.append(field, new Blob([png], { type: 'image/png' }), file);
    return (await fetch(`http://localhost:${PORT}${route}`, { method: 'POST', headers: { Authorization: `Bearer ${admin.token}` }, body: fd })).json();
  };
  assert.equal((await send('/api/upload-emoji', 'emoji', 'HOLY', 'a.png')).name, 'HOLY');
  assert.equal((await send('/api/upload-emoji', 'emoji', 'holy', 'b.png')).name, 'holy');
  assert.equal((await send('/api/upload-emojis', 'emojis', '', 'Kappa.png')).uploaded[0].name, 'Kappa');
  const list = await (await fetch(`http://localhost:${PORT}/api/emojis`, { headers: { Authorization: `Bearer ${admin.token}` } })).json();
  assert.deepEqual(list.emojis.map((e) => e.name).sort(), ['HOLY', 'Kappa', 'holy']);
  const del = await fetch(`http://localhost:${PORT}/api/emojis/HOLY`, { method: 'DELETE', headers: { Authorization: `Bearer ${admin.token}` } });
  assert.equal(del.status, 200);
  const after = await (await fetch(`http://localhost:${PORT}/api/emojis`, { headers: { Authorization: `Bearer ${admin.token}` } })).json();
  assert.deepEqual(after.emojis.map((e) => e.name).sort(), ['Kappa', 'holy']);
});
