'use strict';

// Embeds, buttons and dropdowns on bot messages (src/botComponents.js):
// what a bot may send, and the whole round trip. A bot posts a message with
// an embed, buttons and a dropdown; a member clicks; the bot's callback hears
// a signed interaction; the bot edits the message to grey the button out.
//
//   node --test test/botComponents.test.js

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');
const parts = require('../src/botComponents');
const { createHarness, wait } = require('./socketServerHarness');

const button = (custom_id, extra = {}) => ({ type: 2, style: 1, label: custom_id, custom_id, ...extra });
const row = (...components) => ({ type: 1, components });
const select = (extra = {}) => ({ type: 3, custom_id: 'pick', options: [{ label: 'Red', value: 'r' }, { label: 'Blue', value: 'b' }, { label: 'Green', value: 'g' }], ...extra });

test('a Discord-shaped payload is kept as sent', () => {
  const body = {
    embeds: [{
      title: 'Build #12', description: '**passed**', url: 'https://ci.example.com/12', color: 0x57F287,
      timestamp: '2026-11-20T10:00:00Z', author: { name: 'CI', icon_url: 'https://ci.example.com/a.png' },
      footer: { text: 'main' }, thumbnail: { url: 'https://ci.example.com/t.png' }, image: { url: '/uploads/shot.png' },
      fields: [{ name: 'Tests', value: '412', inline: true }, { name: 'Time', value: '3m' }],
    }],
    components: [
      row(button('rerun'), { type: 2, style: 5, label: 'Open', url: 'https://ci.example.com/12' }, button('stop', { style: 4, emoji: { name: '🛑' } })),
      row(select({ placeholder: 'Colour', min_values: 1, max_values: 2 })),
    ],
  };
  const out = parts.clean(body);
  assert.equal(out.error, undefined);
  assert.equal(out.embeds[0].title, 'Build #12');
  assert.equal(out.embeds[0].timestamp, '2026-11-20T10:00:00.000Z');
  assert.deepEqual(out.embeds[0].image, { url: '/uploads/shot.png' });
  assert.deepEqual(out.embeds[0].fields[0], { name: 'Tests', value: '412', inline: true });
  assert.equal(out.components[0].components[1].url, 'https://ci.example.com/12');
  assert.equal(out.components[0].components[1].custom_id, undefined, 'a link button has no custom_id');
  assert.deepEqual(out.components[0].components[2].emoji, { name: '🛑' });
  assert.equal(out.components[1].components[0].max_values, 2);
  assert.deepEqual(parts.clean({}), { embeds: null, components: null }, 'left out is not the same as empty');
});

test('what Discord refuses is refused, with a reason', () => {
  const bad = (body, re) => assert.match(parts.clean(body).error || '', re);
  bad({ embeds: {} }, /embeds must be an array/);
  bad({ embeds: Array(11).fill({ title: 'x' }) }, /up to 10/);
  bad({ embeds: [{ title: 'x'.repeat(257) }] }, /title is longer than 256/);
  bad({ embeds: [{ color: 0x1000000, title: 'x' }] }, /color/);
  bad({ embeds: [{ color: 5 }] }, /is empty/);
  bad({ embeds: [{ title: 'x', url: 'javascript:alert(1)' }] }, /http or https/);
  bad({ embeds: [{ title: 'x', image: { url: 'http://plain.example.com/a.png' } }] }, /https link or a \/uploads\//);
  bad({ embeds: [{ fields: [{ name: 'only a name' }] }] }, /needs a name and a value/);
  bad({ embeds: [{ description: 'x'.repeat(4000) }, { description: 'x'.repeat(2500) }] }, /more than 6000/);
  bad({ components: Array(6).fill(row(button('a'))) }, /up to 5 action rows/);
  bad({ components: [button('loose')] }, /must be an action row/);
  bad({ components: [row(...'abcdef'.split('').map(c => button(c)))] }, /more than 5 buttons/);
  bad({ components: [row(button('a'), button('a'))] }, /used twice/);
  bad({ components: [row(select(), button('a'))] }, /cannot hold anything else/);
  bad({ components: [row({ type: 2, style: 5, label: 'x' })] }, /needs a url/);
  bad({ components: [row({ type: 2, style: 1, custom_id: 'x' })] }, /label or an emoji/);
  bad({ components: [row({ type: 2, style: 6, custom_id: 'x', label: 'x' })] }, /style must be 1 to 5/);
  bad({ components: [row(select({ options: [] }))] }, /at least one option/);
  bad({ components: [row(select({ max_values: 4 }))] }, /max_values/);
  bad({ components: [row({ type: 8, custom_id: 'ch' })] }, /unsupported type/);
});

test('a pick must come from the list, as many as it allows', () => {
  const s = parts.clean({ components: [row(select({ min_values: 1, max_values: 2 }))] }).components[0].components[0];
  assert.deepEqual(parts.checkValues(s, ['r', 'b']), { values: ['r', 'b'] });
  assert.ok(parts.checkValues(s, ['x']).error);
  assert.ok(parts.checkValues(s, []).error);
  assert.ok(parts.checkValues(s, ['r', 'b', 'g']).error);
  assert.ok(parts.checkValues(s, 'r').error);
  assert.deepEqual(parts.checkValues({ type: 2 }, ['ignored']), { values: [] });
});

const box = (custom_id, extra = {}) => ({ type: 4, custom_id, label: custom_id, ...extra });
const form = (...boxes) => ({ custom_id: 'f', title: 'Form', components: boxes.map(b => row(b)) });

test('a form keeps Discord\'s shape, its boxes held to the message limit', () => {
  const m = parts.cleanModal(form(box('name', { max_length: 4000 }), box('idea', { style: 2, min_length: 10, required: false, value: 'one\ntwo' })), 2000);
  assert.equal(m.error, undefined);
  assert.equal(m.components[0].components[0].max_length, 2000, 'lowered to the server limit');
  assert.equal(m.components[0].components[0].required, true);
  assert.equal(m.components[1].components[0].value, 'one\ntwo');
  const bad = (raw, re) => assert.match(parts.cleanModal(raw, 2000).error || '', re);
  bad({ ...form(box('a')), title: '' }, /title is required/);
  bad({ ...form(box('a')), title: 'x'.repeat(46) }, /longer than 45/);
  bad(form(), /1 to 5 action rows/);
  bad(form(...'abcdef'.split('').map(c => box(c))), /1 to 5 action rows/);
  bad(form(box('a'), box('a')), /used twice/);
  bad(form(button('b')), /text input \(type 4\)/);
  bad({ ...form(), components: [row(box('a'), box('b'))] }, /one text input/);
  bad(form(box('a', { style: 3 })), /style must be 1/);
  bad(form(box('a', { label: '' })), /label is required/);
  bad(form(box('a', { min_length: 5, max_length: 4 })), /max_length/);
  bad(form(box('a', { value: 'one\ntwo' })), /one line/);
  bad(form(box('a', { value: 'x‮y' })), /invisible/);
});

test('what someone types is checked against the form', () => {
  const m = parts.cleanModal(form(box('name', { max_length: 40 }), box('idea', { style: 2, min_length: 5, required: false })), 2000);
  const send = (name, idea) => parts.checkModalSubmit(m, [{ custom_id: 'name', value: name }, { custom_id: 'idea', value: idea }]);
  // Any language, with the joiners Persian needs, and whole emoji.
  for (const ok of ['Alice', 'Zoë', 'Привет', '你好', 'می‌خواهم', 'Tiếng Việt', '👨‍👩‍👧 🏴󠁧󠁢󠁳󠁣󠁴󠁿 1️⃣']) {
    assert.deepEqual(send(ok, ''), { fields: [{ custom_id: 'name', value: ok }, { custom_id: 'idea', value: '' }] }, ok);
  }
  assert.equal(send('a', 'one\r\ntwo\tthree').fields[1].value, 'one\ntwo\tthree');
  // Nothing that hides or reorders text.
  for (const sneaky of ['invoice‮fdp.exe', 'a​b', 'x⁦y', 'tag\u{E0041}', 'blankㅤ', 'nul\u0000', 'x\u{F8FF}', 'Ź̂̃̄̅']) {
    assert.ok(send(sneaky, '').error, JSON.stringify(sneaky));
  }
  assert.match(send('a\nb', '').error, /one line/);
  assert.match(send('', '').error, /required/);
  assert.match(send('a', 'abc').error, /at least 5/);
  assert.match(send('x'.repeat(41), '').error, /up to 40/);
  // Only the form's own boxes, once each.
  assert.equal(parts.checkModalSubmit(m, [{ custom_id: 'name', value: 'a' }, { custom_id: 'other', value: 'x' }]).error, 'Invalid request');
  assert.equal(parts.checkModalSubmit(m, [{ custom_id: 'name', value: 'a' }, { custom_id: 'name', value: 'b' }]).error, 'Invalid request');
  assert.equal(parts.checkModalSubmit(m, 'a').error, 'Invalid request');
});

const h = createHarness(3647, 'bot-components');
let hook;
let hookReply = 'ok';
const heard = [];
test.before(async () => {
  hook = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => { heard.push({ headers: req.headers, body }); res.end(hookReply); });
  });
  await new Promise((r) => hook.listen(0, '127.0.0.1', r));
  process.env.HAVEN_ALLOW_PRIVATE_CALLBACKS = 'true';
  await h.start();
});
test.after(async () => {
  await h.stop();
  await new Promise((r) => hook.close(r));
});

test('a click reaches the bot, signed, and the bot can change the message', async () => {
  const admin = await h.register('admin');
  const bob = await h.register('bob');
  const A = await h.connect(admin.token);
  const B = await h.connect(bob.token);
  await wait(300);
  const list = h.next(A, 'channels-list', (c) => Array.isArray(c) && c.some((x) => x.name === 'bots'));
  A.emit('create-channel', { name: 'bots' });
  const code = (await list).find((c) => c.name === 'bots').code;
  B.emit('join-channel', { code });
  await wait(300);
  B.emit('enter-channel', { code });
  await wait(200);

  const token = crypto.randomBytes(32).toString('hex');
  const secret = 'shh';
  const db = new Database(path.join(h.dataDir, 'haven.db'), { fileMustExist: true });
  try {
    const chId = db.prepare('SELECT id FROM channels WHERE code = ?').get(code).id;
    db.prepare('INSERT INTO webhooks (channel_id, name, token, created_by, callback_url, callback_secret) VALUES (?, ?, ?, ?, ?, ?)')
      .run(chId, 'Poll Bot', token, admin.id, `http://127.0.0.1:${hook.address().port}/hook`, secret);
  } finally { db.close(); }
  const api = (p, method, body) => fetch(`http://localhost:3647/api/webhooks/${token}${p}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });

  // An embed alone is a whole message: no text needed.
  const arrives = h.next(B, 'new-message', (d) => d.channelCode === code && d.message.is_webhook);
  const posted = await api('', 'POST', {
    embeds: [{ title: 'Lunch?', color: 0x5865F2 }],
    components: [row(button('yes', { style: 3 }), button('no', { style: 4 })), row(select())],
  });
  assert.equal(posted.status, 200);
  const { message_id: mid } = await posted.json();
  const live = await arrives;
  assert.equal(live.message.content, '');
  assert.equal(live.message.embeds[0].title, 'Lunch?');
  assert.equal(live.message.components.length, 2);

  // History carries them too.
  const hist = h.next(B, 'message-history', (d) => d && d.channelCode === code);
  B.emit('get-messages', { code });
  const loaded = (await hist).messages.find((m) => m.id === mid);
  assert.equal(loaded.embeds[0].color, 0x5865F2);
  assert.equal(loaded.components[0].components[0].custom_id, 'yes');

  // A click goes to the bot, signed with its secret.
  assert.deepEqual(await h.ask(B, 'bot-interaction', { messageId: mid, customId: 'yes' }), { ok: true });
  const click = heard.at(-1);
  assert.equal(click.headers['x-haven-event'], 'interaction');
  assert.equal(click.headers['x-haven-signature'], 'sha256=' + crypto.createHmac('sha256', secret).update(click.body).digest('hex'));
  const payload = JSON.parse(click.body);
  assert.equal(payload.channelId, code);
  assert.equal(payload.interaction.custom_id, 'yes');
  assert.equal(payload.interaction.message_id, mid);
  assert.equal(payload.interaction.component_type, 2);
  assert.equal(payload.interaction.user.id, bob.id);

  assert.deepEqual(await h.ask(B, 'bot-interaction', { messageId: mid, customId: 'pick', values: ['b'] }), { ok: true });
  assert.deepEqual(JSON.parse(heard.at(-1).body).interaction.values, ['b']);

  // Nothing the message does not offer gets through.
  const count = heard.length;
  assert.ok((await h.ask(B, 'bot-interaction', { messageId: mid, customId: 'nope' })).error);
  assert.ok((await h.ask(B, 'bot-interaction', { messageId: mid, customId: 'pick', values: ['purple'] })).error);
  assert.equal(heard.length, count, 'the bot was not bothered');

  // The bot answers a pick with a form. Only Bob gets it, and what he types
  // goes back to the bot once.
  hookReply = JSON.stringify({ type: 9, data: { custom_id: 'lunch-form', title: 'Where to?', components: [row(box('place', { max_length: 4000 }))] } });
  const opened = h.next(B, 'bot-modal');
  assert.deepEqual(await h.ask(B, 'bot-interaction', { messageId: mid, customId: 'pick', values: ['r'] }), { ok: true });
  hookReply = 'ok';
  const shown = await opened;
  assert.equal(shown.title, 'Where to?');
  assert.equal(shown.components[0].components[0].max_length, 2000);
  const fill = (sock, value) => h.ask(sock, 'submit-bot-modal', { formId: shown.formId, fields: [{ custom_id: 'place', value }] });
  assert.ok((await fill(A, 'x')).error, 'only the person who clicked');
  assert.match((await fill(B, 'caf‮é')).error, /invisible/);
  assert.deepEqual(await fill(B, 'Café Zoë'), { ok: true });
  const submitted = JSON.parse(heard.at(-1).body).interaction;
  assert.equal(submitted.type, 'modal_submit');
  assert.equal(submitted.custom_id, 'lunch-form');
  assert.equal(submitted.message_id, mid);
  assert.deepEqual(submitted.fields, [{ custom_id: 'place', value: 'Café Zoë' }]);
  assert.equal(submitted.user.id, bob.id);
  assert.ok((await fill(B, 'again')).error, 'a form is sent once');

  // A form the bot got wrong is refused, with the reason.
  hookReply = JSON.stringify({ type: 9, data: { custom_id: 'x', title: '', components: [row(box('a'))] } });
  assert.match((await h.ask(B, 'bot-interaction', { messageId: mid, customId: 'pick', values: ['r'] })).error, /title is required/);
  hookReply = 'ok';

  // The bot greys the button out; text stays as it was.
  const swapped = h.next(B, 'message-bot-parts', (d) => d.messageId === mid);
  const edited = await api(`/messages/${mid}`, 'PATCH', { components: [row(button('yes', { disabled: true }))] });
  assert.equal(edited.status, 200);
  const update = await swapped;
  assert.equal(update.components[0].components[0].disabled, true);
  assert.equal(update.embeds[0].title, 'Lunch?', 'embeds left out stay');
  assert.ok((await h.ask(B, 'bot-interaction', { messageId: mid, customId: 'yes' })).error, 'a greyed-out button does nothing');

  // A bad payload is refused with the reason; buttons cannot be ephemeral.
  const refused = await api('', 'POST', { components: [row(button('a'), button('a'))] });
  assert.equal(refused.status, 400);
  assert.match((await refused.json()).error, /used twice/);
  const eph = await api('', 'POST', { content: 'x', ephemeral: true, recipient_id: bob.id, components: [row(button('a'))] });
  assert.equal(eph.status, 400);
});
