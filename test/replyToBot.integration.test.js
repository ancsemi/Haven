/**
 * Reply-to-bot banner (#5564): replyContext must show "[BOT] Name", not
 * "[Deleted User]", for webhook parents with null user_id.
 *
 *   node --test test/replyToBot.integration.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { io } = require('socket.io-client');

const PORT = 3399;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = path.join(os.tmpdir(), `haven-reply-bot-${Date.now()}`);

let server;

const post = (p, body) => new Promise((res, rej) => {
  const d = JSON.stringify(body);
  const r = http.request({
    host: '127.0.0.1', port: PORT, path: p, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) },
  }, (x) => {
    let b = '';
    x.on('data', (c) => (b += c));
    x.on('end', () => {
      try { res({ status: x.statusCode, body: JSON.parse(b) }); }
      catch { res({ status: x.statusCode, body: { raw: b } }); }
    });
  });
  r.on('error', rej);
  r.write(d);
  r.end();
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(token) {
  const s = io(BASE, { auth: { token }, transports: ['websocket'], forceNew: true });
  return new Promise((res, rej) => {
    s.on('connect', () => res(s));
    s.on('connect_error', rej);
  });
}

function next(sock, event, filter = () => true, ms = 4000) {
  return new Promise((res) => {
    const t = setTimeout(() => { sock.off(event, h); res(null); }, ms);
    const h = (data) => {
      if (!filter(data)) return;
      clearTimeout(t);
      sock.off(event, h);
      res(data);
    };
    sock.on(event, h);
  });
}

function history(sock, code) {
  const p = next(sock, 'message-history', (d) => d && d.channelCode === code);
  sock.emit('get-messages', { code });
  return p;
}

test.before(async () => {
  fs.mkdirSync(DATA, { recursive: true });
  server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      FORCE_HTTP: 'true',
      HAVEN_DATA_DIR: DATA,
      ADMIN_USERNAME: 'admin',
    },
    stdio: 'ignore',
  });
  for (let i = 0; i < 60; i++) {
    try {
      await new Promise((res, rej) =>
        http.get(`${BASE}/api/health`, (r) => (r.statusCode === 200 ? res() : rej())).on('error', rej)
      );
      return;
    } catch {
      await wait(500);
    }
  }
  throw new Error('server did not start');
});

test.after(() => {
  server?.kill();
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('replying to a webhook bot keeps [BOT] name in replyContext', async () => {
  const admin = await post('/api/auth/register', {
    username: 'admin',
    password: 'replybottest123',
    eulaVersion: '2.0',
    ageVerified: true,
  });
  assert.ok(admin.body.token, 'admin registered');
  const sock = await connect(admin.body.token);

  const list = next(sock, 'channels-list', (chs) => Array.isArray(chs) && chs.some((c) => c.name === 'bots'));
  sock.emit('create-channel', { name: 'bots' });
  const channels = await list;
  assert.ok(channels, 'channel list arrived');
  const code = channels.find((c) => c.name === 'bots').code;

  const created = next(sock, 'webhook-created', (w) => w && w.name === 'LOLbot');
  sock.emit('create-webhook', { channelCode: code, name: 'LOLbot' });
  const webhook = await created;
  assert.ok(webhook?.token, 'webhook token issued');
  assert.equal(webhook.token.length, 64);

  sock.emit('enter-channel', { code });
  await wait(200);

  const botPost = await post(`/api/webhooks/${webhook.token}`, {
    content: 'lol',
    username: 'LOLbot',
  });
  assert.equal(botPost.status, 200, `bot post failed: ${JSON.stringify(botPost.body)}`);
  const botId = botPost.body.message_id;
  assert.ok(botId, 'bot message id returned');

  // Live path: human reply to the bot message.
  const live = next(
    sock,
    'new-message',
    (d) => d && d.channelCode === code && d.message?.reply_to === botId
  );
  sock.emit('send-message', {
    code,
    content: 'replying to lolbot',
    replyTo: botId,
  });
  const liveMsg = await live;
  assert.ok(liveMsg, 'live reply arrived');
  assert.equal(liveMsg.message.replyContext?.username, '[BOT] LOLbot');
  assert.equal(liveMsg.message.replyContext?.user_id, null);
  assert.equal(liveMsg.message.replyContext?.content, 'lol');

  // History path: reload and confirm the same banner author.
  const h = await history(sock, code);
  assert.ok(h, 'history arrived');
  const reply = h.messages.find((m) => m.reply_to === botId);
  assert.ok(reply, 'reply present in history');
  assert.equal(reply.replyContext?.username, '[BOT] LOLbot');
  assert.notEqual(reply.replyContext?.username, '[Deleted User]');

  const bot = h.messages.find((m) => m.id === botId);
  assert.ok(bot, 'bot message in history');
  assert.equal(bot.username, '[BOT] LOLbot');

  sock.close();
});
