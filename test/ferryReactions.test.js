/**
 * Reactions across Ferry (src/ferryReactions.js): a reaction on Discord shows
 * on the Haven copy under the Discord name, and a reaction on Haven puts the
 * bot's reaction on the Discord copy until the last one is taken off.
 *
 * Boots Haven on a scratch port, pointed at the stand-in Discord in
 * test/fakeDiscord.js:
 *   node --test test/ferryReactions.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { io } = require('socket.io-client');
const { startFakeDiscord, GUILD_ID, TEXT_ID, BOT_ID } = require('./fakeDiscord');

const PORT = 3429;
const DISCORD_PORT = 3430;
const BASE = `http://localhost:${PORT}`;
const DATA = path.join(os.tmpdir(), `haven-ferry-reactions-${Date.now()}`);
const FAKE_TOKEN = 'FAKE' + 'x'.repeat(66);

let server;
let discord;

const post = (p, body) => new Promise((res, rej) => {
  const d = JSON.stringify(body);
  const r = http.request({ host: 'localhost', port: PORT, path: p, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) } },
    (x) => { let b = ''; x.on('data', (c) => (b += c)); x.on('end', () => { try { res(JSON.parse(b)); } catch { res({ raw: b }); } }); });
  r.on('error', rej); r.write(d); r.end();
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function connect(token) {
  const s = io(BASE, { auth: { token }, transports: ['websocket'], forceNew: true });
  return new Promise((res, rej) => { s.on('connect', () => res(s)); s.on('connect_error', rej); });
}
function next(sock, event, filter = () => true, ms = 4000) {
  return new Promise((res) => {
    const t = setTimeout(() => { sock.off(event, h); res(null); }, ms);
    const h = (data) => { if (!filter(data)) return; clearTimeout(t); sock.off(event, h); res(data); };
    sock.on(event, h);
  });
}
function history(sock, code) {
  const p = next(sock, 'message-history', (d) => d && d.channelCode === code);
  sock.emit('get-messages', { code });
  return p;
}
async function until(fn, ms = 6000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await wait(100);
  }
  return null;
}

test.before(async () => {
  fs.mkdirSync(DATA, { recursive: true });
  discord = await startFakeDiscord(DISCORD_PORT);
  server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env, PORT: String(PORT), HAVEN_DATA_DIR: DATA, ADMIN_USERNAME: 'admin', FORCE_HTTP: 'true',
      NODE_ENV: 'test',
      FERRY_TEST_DISCORD_API: `http://127.0.0.1:${DISCORD_PORT}`,
      FERRY_TEST_DISCORD_GATEWAY: `ws://127.0.0.1:${DISCORD_PORT}`,
    },
    stdio: 'ignore',
  });
  for (let i = 0; i < 60; i++) {
    try {
      await new Promise((res, rej) => http.get(`${BASE}/api/health`, (r) => (r.statusCode === 200 ? res() : rej())).on('error', rej));
      return;
    } catch { await wait(500); }
  }
  throw new Error('server did not start');
});

test.after(async () => {
  await new Promise((res) => {
    if (!server || server.exitCode !== null) return res();
    server.once('exit', () => res());
    server.kill();
  });
  await discord?.close();
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* temp dir */ }
});

const ALICE = { id: '1300000000000000100', username: 'alice', global_name: 'Alice', avatar: null, discriminator: '0' };
const BOB = { id: '1300000000000000101', username: 'bob', global_name: 'Bob', avatar: null, discriminator: '0' };
const reactionEvent = (messageId, user, name, extra = {}) => ({
  user_id: user.id, message_id: messageId, channel_id: TEXT_ID, guild_id: GUILD_ID,
  emoji: { id: null, name }, member: { user, nick: null, roles: [] }, ...extra,
});

test('reactions cross the bridge both ways', async () => {
  const admin = await post('/api/auth/register', { username: 'admin', password: 'ferryreact123', eulaVersion: '2.0', ageVerified: true });
  assert.ok(admin.token, 'admin registered');
  const A = await connect(admin.token);

  const tokenOk = next(A, 'ferry:token-ok');
  A.emit('ferry:set-token', { token: FAKE_TOKEN });
  assert.ok(await tokenOk, 'the fake Discord accepted the token');
  A.emit('ferry:set-option', { key: 'ferry_enabled', value: true });
  const config = async () => { const p = next(A, 'ferry:config'); A.emit('ferry:get-config'); return p; };
  assert.ok(await until(async () => { const c = await config(); return c && c.state.connected && c.guilds.length; }, 10000), 'Ferry connected');

  const listed = next(A, 'channels-list', (l) => Array.isArray(l) && l.some((c) => c.name === 'chat'));
  A.emit('create-channel', { name: 'chat' });
  const chat = (await listed).find((c) => c.name === 'chat');
  const linked = next(A, 'ferry:config', (c) => c.links.some((l) => l.discord_channel_id === TEXT_ID));
  A.emit('ferry:create-link', { channelCode: chat.code, guildId: GUILD_ID, discordChannelId: TEXT_ID, direction: 'both', outMode: 'all' });
  assert.ok(await linked, 'the channel is paired');
  A.emit('enter-channel', { code: chat.code });
  await history(A, chat.code);

  // ── Discord to Haven ──
  const FROM_ALICE = discord.newId();
  discord.dispatch('MESSAGE_CREATE', { id: FROM_ALICE, channel_id: TEXT_ID, guild_id: GUILD_ID, type: 0, content: 'Hello from Discord',
    author: ALICE, attachments: [], embeds: [], mentions: [] });
  const copy = await until(async () => (await history(A, chat.code)).messages.find((m) => m.content === 'Hello from Discord'));
  assert.ok(copy, 'the Discord message reached Haven');

  let update = next(A, 'reactions-updated', (d) => d.messageId === copy.id);
  discord.dispatch('MESSAGE_REACTION_ADD', reactionEvent(FROM_ALICE, BOB, '👍'));
  update = await update;
  assert.ok(update, 'Haven heard about the Discord reaction');
  assert.deepStrictEqual(update.reactions.map((r) => [r.emoji, r.username]), [['👍', 'Bob (Discord)']]);
  const again = (await history(A, chat.code)).messages.find((m) => m.id === copy.id);
  assert.deepStrictEqual(again.reactions.map((r) => r.username), ['Bob (Discord)'], 'and it is there after a reload');

  // The bot's own reactions stand for Haven people, so they are not carried back.
  discord.dispatch('MESSAGE_REACTION_ADD', reactionEvent(FROM_ALICE, { id: BOT_ID, username: 'FerryBot' }, '🎉'));
  await wait(400);
  assert.strictEqual((await history(A, chat.code)).messages.find((m) => m.id === copy.id).reactions.length, 1);

  update = next(A, 'reactions-updated', (d) => d.messageId === copy.id);
  discord.dispatch('MESSAGE_REACTION_REMOVE', { user_id: BOB.id, message_id: FROM_ALICE, channel_id: TEXT_ID, guild_id: GUILD_ID, emoji: { id: null, name: '👍' } });
  assert.deepStrictEqual((await update).reactions, [], 'taking it off on Discord takes it off on Haven');

  // ── Haven to Discord ──
  A.emit('add-reaction', { messageId: copy.id, emoji: '🔥' });
  const put = await until(() => discord.reactions.find((r) => r.method === 'PUT' && r.messageId === FROM_ALICE));
  assert.deepStrictEqual(put && [put.channelId, put.emoji], [TEXT_ID, '🔥'], 'the bot reacts on Discord');
  A.emit('remove-reaction', { messageId: copy.id, emoji: '🔥' });
  const del = await until(() => discord.reactions.find((r) => r.method === 'DELETE' && r.messageId === FROM_ALICE));
  assert.strictEqual(del && del.emoji, '🔥', 'and takes it back when the last one goes');

  // A message written on Haven goes out through the webhook; reacting to it reaches its Discord copy.
  const before = discord.executions.length;
  A.emit('send-message', { code: chat.code, content: 'Hello from Haven' });
  const sent = await until(() => discord.executions.slice(before).find((e) => e.body && /Hello from Haven/.test(e.body.content)));
  assert.ok(sent, 'the Haven message went to Discord');
  const mine = (await history(A, chat.code)).messages.find((m) => m.content === 'Hello from Haven');
  A.emit('add-reaction', { messageId: mine.id, emoji: '✅' });
  const put2 = await until(() => discord.reactions.find((r) => r.method === 'PUT' && r.messageId === sent.result.id));
  assert.strictEqual(put2 && put2.emoji, '✅');

  A.disconnect();
});
