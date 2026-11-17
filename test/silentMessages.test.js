'use strict';

// Silent messages: "@silent" up front (or the composer's toggle) sends a
// message nobody gets a sound, pop-up or push for. Push is checked for real:
// the server is pointed at a stand-in FCM relay and the test counts what it
// is sent.
//
//   node --test test/silentMessages.test.js

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');
const { takeSilent } = require('../src/silentMessages');
const { createHarness, wait } = require('./socketServerHarness');

test('the @silent prefix is taken off and marks the message', () => {
  assert.deepEqual(takeSilent('@silent hi there'), { silent: true, content: 'hi there' });
  assert.deepEqual(takeSilent('@SILENT  shout'), { silent: true, content: 'shout' });
  assert.deepEqual(takeSilent('@silent\nline two'), { silent: true, content: 'line two' });
  assert.deepEqual(takeSilent('  @silent @bob look'), { silent: true, content: '@bob look' });
});

test('anything else is left alone', () => {
  assert.deepEqual(takeSilent('hi @silent'), { silent: false, content: 'hi @silent' });
  assert.deepEqual(takeSilent('@silently'), { silent: false, content: '@silently' });
  assert.deepEqual(takeSilent('@silent'), { silent: false, content: '@silent' }, 'never leaves an empty message');
  assert.deepEqual(takeSilent('@silent   '), { silent: false, content: '@silent   ' });
  assert.deepEqual(takeSilent('plain', true), { silent: true, content: 'plain' }, 'the toggle');
  assert.deepEqual(takeSilent('plain', 'yes'), { silent: false, content: 'plain' }, 'only a real true counts');
  assert.deepEqual(takeSilent(null), { silent: false, content: '' });
});

test('the message box takes the prefix off before sending, an encrypted DM included', async () => {
  const { pathToFileURL } = require('node:url');
  const M = (await import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'modules', 'app-silent.js')).href)).default;
  assert.deepEqual(M._silentSplit('@silent hello'), { silent: true, content: 'hello' });
  assert.deepEqual(M._silentSplit('@silent'), { silent: false, content: '@silent' });
  assert.deepEqual(M._silentSplit('@silent', true), { silent: true, content: '' }, 'with attachments the prefix alone is enough');
  assert.deepEqual(M._silentSplit('say @silent'), { silent: false, content: 'say @silent' });
});

// ── Against a running server ─────────────────────────────────────────────
const relayed = [];
let relay;
const h = createHarness(3515, 'silent-messages');

test.before(async () => {
  relay = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try { relayed.push(JSON.parse(body)); } catch { relayed.push({ raw: body }); }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ success: 1, failure: 0, failedTokens: [] }));
    });
  });
  await new Promise((r) => relay.listen(0, '127.0.0.1', r));
  process.env.FCM_RELAY_URL = `http://127.0.0.1:${relay.address().port}/push`;
  process.env.FCM_PUSH_KEY = 'silent-test';
  await h.start();
});
test.after(async () => {
  await h.stop();
  await new Promise((r) => relay.close(r));
});

const readDb = (sql, ...args) => {
  const db = new Database(path.join(h.dataDir, 'haven.db'), { readonly: true, fileMustExist: true });
  try { return db.prepare(sql).get(...args); } finally { db.close(); }
};
// Pushes that reached the relay for this token since `from`.
const pushesFor = (token, from) => relayed.slice(from).filter((p) => Array.isArray(p.tokens) && p.tokens.includes(token));
async function waitForPush(token, from, ms = 4000) {
  for (let t = 0; t < ms; t += 100) {
    if (pushesFor(token, from).length) return true;
    await wait(100);
  }
  return false;
}

test('silent messages reach everyone, marked, and push nobody', async () => {
  const admin = await h.register('admin');
  const bob = await h.register('bob');
  const A = await h.connect(admin.token);
  const B = await h.connect(bob.token);
  await wait(300);

  const list = h.next(A, 'channels-list', (c) => Array.isArray(c) && c.some((x) => x.name === 'quiet'));
  A.emit('create-channel', { name: 'quiet' });
  const code = (await list).find((c) => c.name === 'quiet').code;
  B.emit('join-channel', { code });
  await wait(300);
  A.emit('enter-channel', { code });
  B.emit('enter-channel', { code });
  await wait(200);

  // Bob's phone, with his app in the background.
  const phone = 'phone-' + crypto.randomBytes(8).toString('hex');
  B.emit('register-fcm-token', { token: phone });
  B.emit('visibility-change', { visible: false });
  await wait(300);

  // A normal message pushes him; this is what the silent one must not do.
  let from = relayed.length;
  A.emit('send-message', { code, content: 'loud hello @bob' });
  assert.equal(await waitForPush(phone, from), true, 'a normal message is pushed');

  from = relayed.length;
  const got = h.next(B, 'new-message', (d) => d.channelCode === code && /quiet hello/.test(d.message.content));
  A.emit('send-message', { code, content: '@silent quiet hello @bob' });
  const msg = await got;
  assert.ok(msg, 'the silent message is delivered');
  assert.equal(msg.message.silent, true);
  assert.equal(msg.message.content, 'quiet hello @bob', 'the prefix is gone, the mention stays');
  assert.equal(await waitForPush(phone, from, 1500), false, 'no push for a silent message, mention or not');
  const row = readDb('SELECT content, silent FROM messages WHERE id = ?', msg.message.id);
  assert.deepEqual({ ...row }, { content: 'quiet hello @bob', silent: 1 });

  // The composer's toggle does the same without the prefix.
  from = relayed.length;
  const toggled = h.next(B, 'new-message', (d) => d.channelCode === code && d.message.content === 'by toggle');
  A.emit('send-message', { code, content: 'by toggle', silent: true });
  assert.equal((await toggled).message.silent, true);
  assert.equal(await waitForPush(phone, from, 1200), false);

  // History keeps the mark; ordinary messages carry none.
  const history = h.next(A, 'message-history', (d) => d && d.channelCode === code);
  A.emit('get-messages', { code });
  const hist = (await history).messages;
  assert.equal(hist.find((m) => m.content === 'quiet hello @bob').silent, true);
  assert.equal(hist.find((m) => m.content === 'loud hello @bob').silent, undefined);

  // A silent thread reply: marked, prefix gone.
  const parentId = msg.message.id;
  const reply = h.next(B, 'new-thread-message', (d) => d.parentId === parentId);
  A.emit('send-thread-message', { parentId, content: '@silent in the thread' });
  const r = await reply;
  assert.ok(r, 'the thread reply arrives');
  assert.equal(r.message.silent, true);
  assert.equal(r.message.content, 'in the thread');
  const thread = h.next(A, 'thread-messages', (d) => d && d.parentId === parentId);
  A.emit('get-thread-messages', { parentId });
  const th = await thread;
  assert.equal(th.messages.find((m) => m.content === 'in the thread').silent, true);

  // A bot can post silently too.
  const botToken = crypto.randomBytes(32).toString('hex');
  const db = new Database(path.join(h.dataDir, 'haven.db'), { fileMustExist: true });
  try {
    const chId = db.prepare('SELECT id FROM channels WHERE code = ?').get(code).id;
    db.prepare('INSERT INTO webhooks (channel_id, name, token, created_by) VALUES (?, ?, ?, ?)').run(chId, 'Quiet Bot', botToken, admin.id);
  } finally { db.close(); }
  const fromBot = h.next(B, 'new-message', (d) => d.channelCode === code && d.message.is_webhook);
  const posted = await fetch(`http://localhost:3515/api/webhooks/${botToken}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: '@silent bot news' }),
  });
  assert.equal(posted.status, 200);
  const bm = await fromBot;
  assert.equal(bm.message.silent, true);
  assert.equal(bm.message.content, 'bot news');
});

test('a silent DM pushes nobody but still counts as unread', async () => {
  const carol = await h.register('carol');
  const dave = await h.register('dave');
  const C = await h.connect(carol.token);
  const D = await h.connect(dave.token);
  await wait(300);
  const phone = 'phone-' + crypto.randomBytes(8).toString('hex');
  D.emit('register-fcm-token', { token: phone });
  D.emit('visibility-change', { visible: false });

  const opened = h.next(C, 'dm-opened');
  C.emit('start-dm', { targetUserId: dave.id });
  const dm = await opened;
  assert.ok(dm && dm.code, 'DM opened');
  await wait(400);

  let from = relayed.length;
  C.emit('send-message', { code: dm.code, content: 'loud dm' });
  assert.equal(await waitForPush(phone, from), true, 'a normal DM is pushed');

  // An encrypted DM cannot carry the prefix in readable text, so the
  // client sends the flag; plain text with the prefix works as well.
  from = relayed.length;
  const got = h.next(D, 'new-message', (d) => d.channelCode === dm.code && d.message.content === 'quiet dm');
  C.emit('send-message', { code: dm.code, content: 'quiet dm', silent: true });
  assert.equal((await got).message.silent, true);
  const got2 = h.next(D, 'new-message', (d) => d.channelCode === dm.code && d.message.content === 'quiet again');
  C.emit('send-message', { code: dm.code, content: '@silent quiet again' });
  assert.equal((await got2).message.silent, true);
  assert.equal(await waitForPush(phone, from, 1500), false, 'no push for silent DMs');

  const list = h.next(D, 'channels-list', (c) => Array.isArray(c) && c.some((x) => x.code === dm.code));
  D.emit('get-channels');
  const ch = (await list).find((x) => x.code === dm.code);
  assert.equal(ch.unreadCount, 3, 'all three DMs are unread, the silent ones included');
});
