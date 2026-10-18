/**
 * Ferry forum bridging: a Discord forum pairs with a Haven forum, posts and
 * replies cross both ways, and which topic is which post survives a restart.
 *
 * Needs a running Haven server. Boots one on a scratch port and data dir,
 * pointed at the stand-in Discord in test/fakeDiscord.js, so no real bot,
 * token or network is involved:
 *   node --test test/ferryForums.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { io } = require('socket.io-client');
const {
  startFakeDiscord, GUILD_ID, TEXT_ID, FORUM_ID, TAG_BUG, TAG_STAFF,
} = require('./fakeDiscord');

const PORT = 3412;
const DISCORD_PORT = 3413;
const BASE = `http://localhost:${PORT}`;
const DATA = path.join(os.tmpdir(), `haven-ferry-forums-${Date.now()}`);
// Shaped like a bot token so the format check passes. It only ever reaches
// the fake Discord on this machine.
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
function threadOf(sock, parentId) {
  const p = next(sock, 'thread-messages', (d) => d && d.parentId === parentId);
  sock.emit('get-thread-messages', { parentId });
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
// Uploads through Haven's own endpoint, so the server records who owns it.
// Answers with the stored name.
async function uploadFile(token, name, size, scope = 'channel') {
  const fd = new FormData();
  fd.append('scope', scope);
  fd.append('file', new Blob([Buffer.alloc(size, 9)], { type: 'text/plain' }), name);
  const r = await fetch(`${BASE}/api/upload-file`, { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd });
  const j = await r.json();
  return j && typeof j.url === 'string' ? j.url.replace('/uploads/', '') : null;
}
// Files written straight into uploads/ are news to the media index; the admin
// rebuilds it, as anyone adding files by hand would.
async function reindex(token) {
  const r = await fetch(`${BASE}/api/admin/media/reconcile`, { method: 'POST', headers: { Authorization: 'Bearer ' + token } });
  assert.strictEqual(r.status, 200, 'media index rebuilt');
}
const tagsOf = (m) => (Array.isArray(m.tags) ? m.tags : JSON.parse(m.tags || '[]'));

async function bootServer() {
  server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env, PORT: String(PORT), HAVEN_DATA_DIR: DATA, ADMIN_USERNAME: 'admin', FORCE_HTTP: 'true',
      // Ferry only honours the stand-in Discord addresses under NODE_ENV=test.
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
}

function stopServer() {
  return new Promise((res) => {
    if (!server || server.exitCode !== null) return res();
    server.once('exit', () => res());
    server.kill();
  });
}

test.before(async () => {
  fs.mkdirSync(DATA, { recursive: true });
  discord = await startFakeDiscord(DISCORD_PORT);
  await bootServer();
});

test.after(async () => {
  await stopServer();
  await discord?.close();
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch {}
});

const ALICE = { id: '1300000000000000100', username: 'alice', global_name: 'Alice', avatar: null, discriminator: '0' };
const BOB = { id: '1300000000000000101', username: 'bob', global_name: 'Bob', avatar: null, discriminator: '0' };

function discordMessage(id, channelId, author, content, extra = {}) {
  return { id, channel_id: channelId, guild_id: GUILD_ID, type: 0, content, author, attachments: [], embeds: [], mentions: [], ...extra };
}
function discordThread(id, name, appliedTags = [], extra = {}) {
  return { id, guild_id: GUILD_ID, parent_id: FORUM_ID, type: 11, name, applied_tags: appliedTags,
    thread_metadata: { archived: false, locked: false }, ...extra };
}

test('a Discord forum and a Haven forum carry posts and replies both ways', async (t) => {
  const admin = await post('/api/auth/register', { username: 'admin', password: 'ferryforums123', eulaVersion: '2.0', ageVerified: true });
  assert.ok(admin.token, 'admin registered');
  let A = await connect(admin.token);
  const errors = [];
  A.on('error-msg', (m) => errors.push(m));

  // ── Ferry connected to the fake Discord ──
  const tokenOk = next(A, 'ferry:token-ok');
  A.emit('ferry:set-token', { token: FAKE_TOKEN });
  assert.ok(await tokenOk, 'the fake Discord accepted the token');
  A.emit('ferry:set-option', { key: 'ferry_enabled', value: true });
  const getConfig = async () => {
    const p = next(A, 'ferry:config');
    A.emit('ferry:get-config');
    return p;
  };
  const connected = await until(async () => {
    const c = await getConfig();
    return c && c.state.connected && c.guilds.length ? c : null;
  }, 10000);
  assert.ok(connected, 'Ferry connected to the fake gateway');
  const dChannels = connected.guilds[0].channels;
  assert.strictEqual(dChannels.find((c) => c.id === FORUM_ID).forum, true, 'the Discord forum is offered and marked as a forum');
  assert.strictEqual(dChannels.find((c) => c.id === TEXT_ID).forum, false);
  assert.strictEqual(dChannels.find((c) => c.id === TEXT_ID).hidden, false, 'a public channel is not flagged');

  // A private channel the bot's role was never added to is flagged for the
  // pairing form, and the flag clears once Discord lets the bot back in.
  const textWith = (overwrites) => ({ id: TEXT_ID, name: 'general', type: 0, parent_id: null, guild_id: GUILD_ID, permission_overwrites: overwrites });
  discord.dispatch('CHANNEL_UPDATE', textWith([{ id: GUILD_ID, type: 0, allow: '0', deny: '1024' }]));
  assert.ok(await until(async () => (await getConfig()).guilds[0].channels.find((c) => c.id === TEXT_ID).hidden), 'a private channel is flagged');
  discord.dispatch('CHANNEL_UPDATE', textWith([]));
  assert.ok(await until(async () => !(await getConfig()).guilds[0].channels.find((c) => c.id === TEXT_ID).hidden), 'the flag clears');

  // ── A Haven forum and a Haven chat channel ──
  let list = next(A, 'channels-list', (chs) => Array.isArray(chs) && chs.some((c) => c.name === 'help'));
  A.emit('create-channel', { name: 'help', isForum: true });
  let channels = await list;
  const forum = channels.find((c) => c.name === 'help');
  assert.strictEqual(forum.is_forum, 1);
  list = next(A, 'channels-list', (chs) => Array.isArray(chs) && chs.some((c) => c.name === 'chat'));
  A.emit('create-channel', { name: 'chat' });
  channels = await list;
  const chat = channels.find((c) => c.name === 'chat');
  A.emit('set-forum-tags', { code: forum.code, tags: [{ name: 'bug' }, { name: 'Staff' }] });
  await wait(200);
  A.emit('enter-channel', { code: forum.code });
  await wait(200);

  await t.test('a forum only pairs with a forum', async () => {
    let err = next(A, 'error-msg');
    A.emit('ferry:create-link', { channelCode: chat.code, guildId: GUILD_ID, discordChannelId: FORUM_ID, direction: 'both' });
    assert.match(await err || '', /Haven forum/);
    err = next(A, 'error-msg');
    A.emit('ferry:create-link', { channelCode: forum.code, guildId: GUILD_ID, discordChannelId: TEXT_ID, direction: 'both' });
    assert.match(await err || '', /Discord forum/);

    const cfg = next(A, 'ferry:config', (c) => c.links.length === 1);
    A.emit('ferry:create-link', { channelCode: forum.code, guildId: GUILD_ID, discordChannelId: FORUM_ID, direction: 'both', outMode: 'command' });
    const c = await cfg;
    assert.ok(c, 'the forum pairing was made');
    assert.strictEqual(c.links[0].discord_channel_type, 15);
    assert.strictEqual(c.links[0].out_mode, 'all', 'a forum pairing always mirrors');
  });

  const TH1 = discord.newId();
  let topic1;
  await t.test('a Discord post becomes a Haven topic', async () => {
    discord.dispatch('THREAD_CREATE', discordThread(TH1, 'Crash on start', [TAG_BUG, TAG_STAFF], { newly_created: true }));
    discord.dispatch('MESSAGE_CREATE', discordMessage(TH1, TH1, ALICE, 'It crashes right away',
      { attachments: [{ url: 'https://cdn.discordapp.com/attachments/1/2/shot.png' }] }));
    topic1 = await until(async () => (await history(A, forum.code)).messages.find((m) => m.title === 'Crash on start'));
    assert.ok(topic1, 'the topic arrived');
    assert.match(topic1.content, /It crashes right away/);
    assert.match(topic1.content, /shot\.png/, 'the attachment came along as a link');
    assert.deepStrictEqual(tagsOf(topic1).sort(), ['Staff', 'bug'], 'tags matched by name, Haven spelling kept');
    assert.ok(topic1.is_webhook, 'shown as a relayed author');
    assert.strictEqual(topic1.webhook_username, 'Alice');
  });

  let TH_CONFIG;
  await t.test('a post whose first message beats its THREAD_CREATE still arrives', async () => {
    const TH = TH_CONFIG = discord.newId();
    discord.dispatch('MESSAGE_CREATE', discordMessage(TH, TH, BOB, 'Where is the config file?'));
    await wait(150);
    discord.dispatch('THREAD_CREATE', discordThread(TH, 'Config location'));
    const got = await until(async () => (await history(A, forum.code)).messages.find((m) => m.title === 'Config location'));
    assert.ok(got);
  });

  await t.test('a Discord reply becomes a Haven reply, and its edit follows', async () => {
    const id = discord.newId();
    const live = next(A, 'new-thread-message', (d) => d && d.parentId === topic1.id && d.message.content === 'Same here');
    discord.dispatch('MESSAGE_CREATE', discordMessage(id, TH1, BOB, 'Same here'));
    const liveMsg = await live;
    assert.ok(liveMsg, 'the reply was broadcast live');
    assert.strictEqual(liveMsg.message.username, '[BOT] Bob', 'marked as relayed when it arrives');
    assert.strictEqual(liveMsg.message.webhook_username, 'Bob', 'the stored name stays bare');
    const thread = await until(async () => {
      const th = await threadOf(A, topic1.id);
      return th.messages.some((m) => m.content === 'Same here') ? th : null;
    });
    assert.ok(thread, 'the reply landed in the topic');
    const reply = thread.messages.find((m) => m.content === 'Same here');
    assert.strictEqual(reply.username, '[BOT] Bob', 'marked as relayed in thread history, prefixed once');
    assert.strictEqual(thread.parentUsername, '[BOT] Alice', 'the relayed topic author is marked too');
    discord.dispatch('MESSAGE_UPDATE', { id, channel_id: TH1, guild_id: GUILD_ID, content: 'Same here, on Linux', author: BOB, mentions: [] });
    assert.ok(await until(async () => (await threadOf(A, topic1.id)).messages.find((m) => m.content === 'Same here, on Linux')));
  });

  let topic2;
  let TH2;
  await t.test('a Haven topic becomes a Discord post through the webhook', async () => {
    const before = discord.executions.length;
    A.emit('send-message', { code: forum.code, content: 'Haven body text', title: 'From Haven', tags: ['bug'] });
    const exec = await until(() => discord.executions.slice(before).find((e) => e.body && e.body.thread_name));
    assert.ok(exec, 'Discord was asked to make a post');
    assert.strictEqual(exec.body.thread_name, 'From Haven');
    assert.strictEqual(exec.body.content, 'Haven body text');
    assert.strictEqual(exec.body.username, 'admin', 'shown as the Haven author');
    assert.deepStrictEqual(exec.body.applied_tags, [TAG_BUG]);
    assert.strictEqual(exec.threadId, null, 'a new post, not a reply');
    topic2 = (await history(A, forum.code)).messages.find((m) => m.title === 'From Haven');
    assert.ok(topic2);
  });

  await t.test('a Haven reply goes into that post with thread_id', async () => {
    const before = discord.executions.length;
    await new Promise((res) => A.emit('send-thread-message', { parentId: topic2.id, content: 'reply from haven' }, res));
    const exec = await until(() => discord.executions.slice(before).find((e) => e.body && e.body.content === 'reply from haven'));
    assert.ok(exec, 'the reply went to Discord');
    assert.ok(exec.threadId, 'into a thread');
    assert.ok(!exec.body.thread_name, 'not as a new post');
    // The fake Discord names a new post after its first message, which is
    // what the webhook call that made it answered with.
    TH2 = exec.threadId;
  });

  await t.test('our own relays echoing back from Discord are not copied again', async () => {
    const hookId = [...discord.webhooks.values()][0].id;
    // With other bots relayed, our own webhook id is the only thing standing
    // between an echo and a duplicate, so that is the guard under test.
    A.emit('ferry:set-option', { key: 'ferry_relay_bots', value: true });
    await wait(300);
    const sentBefore = discord.executions.length;
    discord.dispatch('THREAD_CREATE', discordThread(TH2, 'From Haven', [TAG_BUG], { newly_created: true }));
    discord.dispatch('MESSAGE_CREATE', discordMessage(TH2, TH2, { id: hookId, username: 'admin', bot: true }, 'Haven body text', { webhook_id: hookId }));
    discord.dispatch('MESSAGE_CREATE', discordMessage(discord.newId(), TH2, { id: hookId, username: 'admin', bot: true }, 'reply from haven', { webhook_id: hookId }));
    discord.dispatch('MESSAGE_CREATE', discordMessage(discord.newId(), TH2, ALICE, 'answer from discord'));
    const thread = await until(async () => {
      const th = await threadOf(A, topic2.id);
      return th.messages.some((m) => m.content === 'answer from discord') ? th : null;
    });
    assert.ok(thread, 'the real Discord reply arrived');
    assert.deepStrictEqual(thread.messages.map((m) => m.content), ['reply from haven', 'answer from discord'], 'no echoed copies');
    const topics = (await history(A, forum.code)).messages.filter((m) => m.title === 'From Haven');
    assert.strictEqual(topics.length, 1, 'the echoed post did not become a second topic');
    await wait(300);
    assert.strictEqual(discord.executions.length, sentBefore, 'nothing from Discord was sent back to Discord');
  });

  await t.test('the links survive a restart', async () => {
    A.close();
    const identifiedBefore = discord.identified;
    await stopServer();
    await bootServer();
    A = await connect(admin.token);
    A.on('error-msg', (m) => errors.push(m));
    A.emit('enter-channel', { code: forum.code });
    assert.ok(await until(() => discord.identified > identifiedBefore && discord.connections > 0, 10000), 'Ferry reconnected');
    await wait(300);

    // Discord to Haven: the fake guild sends no threads on connect, so only
    // the stored link can route this.
    discord.dispatch('MESSAGE_CREATE', discordMessage(discord.newId(), TH1, ALICE, 'after the restart'));
    assert.ok(await until(async () => (await threadOf(A, topic1.id)).messages.find((m) => m.content === 'after the restart')));

    // Haven to Discord.
    const before = discord.executions.length;
    await new Promise((res) => A.emit('send-thread-message', { parentId: topic2.id, content: 'still linked' }, res));
    const exec = await until(() => discord.executions.slice(before).find((e) => e.body && e.body.content === 'still linked'));
    assert.ok(exec);
    assert.strictEqual(exec.threadId, TH2);
  });

  await t.test('renaming, retagging and locking a Discord post update its topic', async () => {
    // After the restart Ferry has no earlier state for these posts (the fake
    // guild sends no threads), so their first update only teaches it the
    // current state and changes nothing in Haven.
    discord.dispatch('THREAD_UPDATE', discordThread(TH1, 'Something else', [], { thread_metadata: { archived: true, locked: true } }));
    discord.dispatch('THREAD_UPDATE', discordThread(TH_CONFIG, 'Config location', []));
    await wait(500);
    const untouched = (await history(A, forum.code)).messages.find((m) => m.id === topic1.id);
    assert.strictEqual(untouched.title, 'Crash on start', 'an update with nothing to compare against is not applied');
    assert.ok(!untouched.closed);
    discord.dispatch('THREAD_UPDATE', discordThread(TH1, 'Crash on start', [TAG_BUG, TAG_STAFF]));
    await wait(300);
    assert.deepStrictEqual(tagsOf((await history(A, forum.code)).messages.find((m) => m.id === topic1.id)).sort(), ['Staff', 'bug']);

    discord.dispatch('THREAD_UPDATE', discordThread(TH1, 'Crash on start (solved)', []));
    const renamed = await until(async () => (await history(A, forum.code)).messages
      .find((m) => m.id === topic1.id && m.title === 'Crash on start (solved)'));
    assert.ok(renamed, 'retitled');
    assert.deepStrictEqual(tagsOf(renamed), [], 'retagged');
    assert.ok(!renamed.closed, 'still open');
    discord.dispatch('THREAD_UPDATE', discordThread(TH_CONFIG, 'Config location', [], { thread_metadata: { archived: true, locked: true } }));
    assert.ok(await until(async () => (await history(A, forum.code)).messages.find((m) => m.title === 'Config location' && m.closed)), 'locked closes it');
  });

  await t.test('Discord archiving a post does not undo Haven moderation of its topic', async () => {
    const TH = discord.newId();
    discord.dispatch('THREAD_CREATE', discordThread(TH, 'Printer jam', [TAG_BUG], { newly_created: true }));
    discord.dispatch('MESSAGE_CREATE', discordMessage(TH, TH, BOB, 'Paper stuck again'));
    const topic = await until(async () => (await history(A, forum.code)).messages.find((m) => m.title === 'Printer jam'));
    assert.ok(topic);

    // A Haven moderator retitles, retags and closes it.
    const updated = next(A, 'topic-updated', (d) => d && d.messageId === topic.id);
    A.emit('set-topic-meta', { messageId: topic.id, title: 'Printer jam (see FAQ)', tags: ['Staff'], closed: true });
    assert.ok(await updated);

    // Discord archives the quiet post, then a message wakes it up again.
    discord.dispatch('THREAD_UPDATE', discordThread(TH, 'Printer jam', [TAG_BUG], { thread_metadata: { archived: true, locked: false } }));
    discord.dispatch('THREAD_UPDATE', discordThread(TH, 'Printer jam', [TAG_BUG]));
    await wait(500);
    let now = (await history(A, forum.code)).messages.find((m) => m.id === topic.id);
    assert.strictEqual(now.title, 'Printer jam (see FAQ)', 'the Haven title stays');
    assert.deepStrictEqual(tagsOf(now), ['Staff'], 'the Haven tags stay');
    assert.ok(now.closed, 'the topic stays closed');

    // A real rename on Discord still comes across, and only the name changes.
    discord.dispatch('THREAD_UPDATE', discordThread(TH, 'Printer jam fixed', [TAG_BUG]));
    now = await until(async () => (await history(A, forum.code)).messages.find((m) => m.id === topic.id && m.title === 'Printer jam fixed'));
    assert.ok(now, 'the Discord rename applied');
    assert.deepStrictEqual(tagsOf(now), ['Staff'], 'tags Discord did not change stay as Haven set them');
    assert.ok(now.closed, 'still closed, Discord did not unlock anything');
  });

  await t.test('an NSFW Haven topic is not sent to a Discord forum that is not age-restricted', async () => {
    const before = discord.executions.length;
    const held = next(A, 'error-msg', (m) => /NSFW/.test(m || ''));
    A.emit('send-message', { code: forum.code, content: 'Not for work', title: 'Spicy', nsfw: true });
    assert.match(await held || '', /age-restricted/, 'the author is told it stayed in Haven');
    const topic = await until(async () => (await history(A, forum.code)).messages.find((m) => m.title === 'Spicy'));
    assert.ok(topic && topic.nsfw, 'the topic was made in Haven');
    const cfg = next(A, 'ferry:config');
    A.emit('ferry:get-config');
    assert.match((await cfg).links[0].last_error || '', /NSFW/, 'the pairing says why');

    await new Promise((res) => A.emit('send-thread-message', { parentId: topic.id, content: 'spicy reply' }, res));
    await wait(500);
    assert.ok(!discord.executions.slice(before).some((e) => e.body && (e.body.thread_name === 'Spicy' || e.body.content === 'spicy reply')),
      'neither the topic nor its reply reached Discord');

    // Once Discord says the forum is age-restricted, NSFW topics go through.
    discord.dispatch('CHANNEL_UPDATE', { ...discord.forumChannel(), guild_id: GUILD_ID, nsfw: true });
    await wait(200);
    A.emit('send-message', { code: forum.code, content: 'Also not for work', title: 'Spicy two', nsfw: true });
    assert.ok(await until(() => discord.executions.slice(before).find((e) => e.body && e.body.thread_name === 'Spicy two')),
      'sent to an age-restricted forum');
    discord.dispatch('CHANNEL_UPDATE', { ...discord.forumChannel(), guild_id: GUILD_ID });
    await wait(200);
  });

  await t.test('a post deleted on Discord closes its topic and unlinks it', async () => {
    discord.dispatch('THREAD_DELETE', { id: TH1, guild_id: GUILD_ID, parent_id: FORUM_ID, type: 11 });
    const closed = await until(async () => (await history(A, forum.code)).messages.find((m) => m.id === topic1.id && m.closed));
    assert.ok(closed, 'the topic is closed');
    discord.dispatch('MESSAGE_CREATE', discordMessage(discord.newId(), TH1, BOB, 'into the void'));
    await wait(500);
    const th = await threadOf(A, topic1.id);
    assert.ok(!th.messages.some((m) => m.content === 'into the void'));
  });

  await t.test('a topic deleted in Haven is unlinked and stays deleted', async () => {
    A.emit('delete-message', { messageId: topic2.id, channelCode: forum.code });
    await until(async () => !(await history(A, forum.code)).messages.some((m) => m.id === topic2.id));
    discord.dispatch('MESSAGE_CREATE', discordMessage(discord.newId(), TH2, BOB, 'late reply'));
    await wait(500);
    const topics = (await history(A, forum.code)).messages.filter((m) => m.title === 'From Haven');
    assert.strictEqual(topics.length, 0, 'the reply did not bring the topic back');
  });

  // #5773: replies in a thread of a paired Discord chat channel land in a
  // Haven thread, under the copy of the message the thread started from.
  await t.test('a thread in a paired chat channel becomes a Haven thread', async () => {
    const cfg = next(A, 'ferry:config', (c) => c.links.some((l) => l.discord_channel_id === TEXT_ID));
    A.emit('ferry:create-link', { channelCode: chat.code, guildId: GUILD_ID, discordChannelId: TEXT_ID, direction: 'both' });
    assert.ok(await cfg, 'the chat pairing was made');

    const START = discord.newId();
    discord.dispatch('MESSAGE_CREATE', discordMessage(START, TEXT_ID, ALICE, 'Anyone tried the new build?'));
    const copy = await until(async () => (await history(A, chat.code)).messages.find((m) => m.content === 'Anyone tried the new build?'));
    assert.ok(copy, 'the chat line came across');

    discord.dispatch('THREAD_CREATE', { id: START, guild_id: GUILD_ID, parent_id: TEXT_ID, type: 11, name: 'New build',
      thread_metadata: { archived: false, locked: false } });
    await wait(200);
    discord.dispatch('MESSAGE_CREATE', discordMessage(discord.newId(), START, BOB, 'Works for me'));
    const reply = await until(async () => (await threadOf(A, copy.id)).messages.find((m) => m.content === 'Works for me'));
    assert.ok(reply, 'the thread reply hangs from the message the thread started from');
    const chatAfter = (await history(A, chat.code)).messages;
    assert.ok(!chatAfter.some((m) => m.content === 'Works for me'), 'the reply is not a chat line');

    // A thread started on its own gets a line with its name to hang from.
    const LONE = discord.newId();
    discord.dispatch('THREAD_CREATE', { id: LONE, guild_id: GUILD_ID, parent_id: TEXT_ID, type: 11, name: 'Side chat',
      thread_metadata: { archived: false, locked: false } });
    await wait(200);
    discord.dispatch('MESSAGE_CREATE', discordMessage(discord.newId(), LONE, ALICE, 'first in the side chat'));
    const root = await until(async () => (await history(A, chat.code)).messages.find((m) => m.content === '🧵 Side chat'));
    assert.ok(root, 'a line names the thread');
    const sideReply = await until(async () => (await threadOf(A, root.id)).messages.find((m) => m.content === 'first in the side chat'));
    assert.ok(sideReply, 'the reply is in that thread');
    discord.dispatch('MESSAGE_CREATE', discordMessage(discord.newId(), LONE, BOB, 'second'));
    await until(async () => (await threadOf(A, root.id)).messages.some((m) => m.content === 'second'));
    const roots = (await history(A, chat.code)).messages.filter((m) => m.content === '🧵 Side chat');
    assert.strictEqual(roots.length, 1, 'the next reply reuses the same line');
  });

  // A picture or file sent in Haven goes to Discord as an upload, not as a
  // /uploads/ path Discord cannot open. One past Discord's 10 MB stays behind.
  await t.test('Haven uploads go to Discord as attachments', async () => {
    const uploads = path.join(DATA, 'uploads');
    fs.mkdirSync(uploads, { recursive: true });
    fs.writeFileSync(path.join(uploads, '1790000000000-aaaa1111.png'), Buffer.alloc(2048, 7));
    fs.writeFileSync(path.join(uploads, '1790000000001-bbbb2222.pdf'), Buffer.alloc(4096, 3));
    fs.writeFileSync(path.join(uploads, '1790000000002-cccc3333.mp4'), Buffer.alloc(11 * 1024 * 1024, 1));
    await reindex(admin.token);
    // Mirror everything from the chat pairing, so a plain message goes out.
    const got = next(A, 'ferry:config');
    A.emit('ferry:get-config');
    const chatLink = (await got).links.find((l) => l.discord_channel_id === TEXT_ID);
    const updated = next(A, 'ferry:config', (c) => c.links.some((l) => l.id === chatLink.id && l.out_mode === 'all'));
    A.emit('ferry:update-link', { id: chatLink.id, outMode: 'all' });
    assert.ok(await updated, 'the pairing mirrors every message');
    A.emit('enter-channel', { code: chat.code });
    await wait(200);
    const before = discord.executions.length;
    A.emit('send-message', { code: chat.code, content: 'Image send test.\n/uploads/1790000000000-aaaa1111.png' });
    const pic = await until(() => discord.executions.slice(before).find((e) => e.body && e.body.content === 'Image send test.'));
    assert.ok(pic, 'the text went without the path');
    assert.deepStrictEqual(pic.body.files.map((f) => [f.filename, f.size]), [['1790000000000-aaaa1111.png', 2048]]);
    assert.deepStrictEqual(pic.body.attachments, [{ id: 0, filename: '1790000000000-aaaa1111.png' }]);

    A.emit('send-message', { code: chat.code, content: '[file:Quarterly report.pdf](/uploads/1790000000001-bbbb2222.pdf|4 KB)' });
    const doc = await until(() => discord.executions.slice(before).find((e) => e.body && e.body.files && e.body.files.some((f) => f.filename === 'Quarterly report.pdf')));
    assert.ok(doc, 'a file goes under its own name');
    assert.strictEqual(doc.body.content, '');

    A.emit('send-message', { code: chat.code, content: 'big one /uploads/1790000000002-cccc3333.mp4' });
    const big = await until(() => discord.executions.slice(before).find((e) => e.body && /^big one/.test(e.body.content || '')));
    assert.ok(big, 'the message still went');
    assert.ok(!big.body.files, 'nothing over 10 MB was uploaded');
    assert.strictEqual(big.body.content, 'big one (too large to send to Discord)');
  });

  await t.test('attachments addressed to Discord in an on-command pairing go along', async () => {
    const uploads = path.join(DATA, 'uploads');
    fs.writeFileSync(path.join(uploads, '1790000000003-dddd4444.png'), Buffer.alloc(1024, 5));
    fs.writeFileSync(path.join(uploads, '1790000000004-eeee5555.png'), Buffer.alloc(512, 6));
    await reindex(admin.token);
    const got = next(A, 'ferry:config');
    A.emit('ferry:get-config');
    const chatLink = (await got).links.find((l) => l.discord_channel_id === TEXT_ID);
    const updated = next(A, 'ferry:config', (c) => c.links.some((l) => l.id === chatLink.id && l.out_mode === 'command'));
    A.emit('ferry:update-link', { id: chatLink.id, outMode: 'command' });
    assert.ok(await updated, 'the pairing only sends what is addressed to it');
    const before = discord.executions.length;
    A.emit('send-message', { code: chat.code, content: '/uploads/1790000000003-dddd4444.png', isImage: true });
    A.emit('send-message', { code: chat.code, content: '=>Test Guild#general /uploads/1790000000003-dddd4444.png', isImage: true, bundled: true });
    const pic = await until(() => discord.executions.slice(before).find((e) => e.body && e.body.files && e.body.files.some((f) => f.filename === '1790000000003-dddd4444.png')));
    assert.ok(pic, 'the addressed picture was uploaded');
    assert.strictEqual(discord.executions.slice(before).filter((e) => e.body && e.body.files).length, 1, 'the unaddressed one stayed in Haven');
    A.emit('send-message', { code: chat.code, content: '=>#general spoiler-img:/uploads/1790000000004-eeee5555.png', isImage: true });
    const spoiler = await until(() => discord.executions.slice(before).find((e) => e.body && e.body.files && e.body.files.some((f) => f.filename === 'SPOILER_1790000000004-eeee5555.png')));
    assert.ok(spoiler, 'a spoilered picture goes as a Discord spoiler');
    assert.strictEqual(spoiler.body.content, '');
  });

  await t.test('a Discord DM carries Haven attachments as uploads', async () => {
    const reconnected = discord.identified;
    A.emit('ferry:set-option', { key: 'ferry_allow_dms', value: true });
    await until(() => discord.identified > reconnected, 8000);
    await wait(300);
    const before = discord.botMessages.length;
    A.emit('send-message', { code: chat.code, content: '=>@Alice here it is /uploads/1790000000003-dddd4444.png', ferryDiscordUserId: ALICE.id });
    const dm = await until(() => discord.botMessages.slice(before)[0]);
    assert.ok(dm, 'the DM was sent');
    assert.match(dm.body.content, /here it is/);
    assert.doesNotMatch(dm.body.content, /\/uploads\//, 'no Haven path in the DM text');
    assert.deepStrictEqual(dm.body.files.map((f) => [f.filename, f.size]), [['1790000000003-dddd4444.png', 1024]]);
  });

  // A message names its files as plain paths, so anyone could name someone
  // else's. Only the sender's own uploads go to Discord.
  await t.test("only the sender's own uploads go to Discord", async () => {
    const roles = (await getConfig()).roles;
    const memberRole = roles.find((r) => r.name === 'Member');
    const granted = next(A, 'ferry:config', (c) => c.roles.some((r) => r.id === memberRole.id && r.can_ferry));
    A.emit('ferry:set-role-permission', { roleId: memberRole.id, allowed: true });
    assert.ok(await granted, 'members may use Ferry');

    const member = await post('/api/auth/register', { username: 'ferrymember', password: 'ownuploads123', eulaVersion: '2.0', ageVerified: true });
    assert.ok(member.token, 'member registered');
    const M = await connect(member.token);
    const notices = [];
    M.on('error-msg', (m) => notices.push(m));
    M.emit('join-channel', { code: chat.code });
    await wait(300);
    M.emit('enter-channel', { code: chat.code });
    await wait(200);

    const mine = await uploadFile(member.token, 'mine.txt', 3000);
    const theirs = await uploadFile(admin.token, 'theirs.txt', 2000);
    const private_ = await uploadFile(member.token, 'private.bin', 1000, 'dm');
    assert.ok(mine && theirs && private_, 'the uploads were made');
    const OWNERLESS = '1790000000003-dddd4444.png';   // on disk with no owner on record
    const OWN_NOTICE = /^Only your own uploads go to Discord, so 1 file stayed in Haven$/;
    const sent = (before, fn) => until(() => discord.executions.slice(before).find(fn));

    let before = discord.executions.length;
    M.emit('send-message', { code: chat.code, content: `=>#general my notes [file:Notes.txt](/uploads/${mine}|3 KB)` });
    const own = await sent(before, (e) => e.body && e.body.content === 'my notes');
    assert.ok(own, "the member's message went");
    assert.deepStrictEqual(own.body.files.map((f) => [f.filename, f.size]), [['Notes.txt', 3000]], 'with their own file');
    M.emit('send-message', { code: chat.code, content: `=>#general spoiler-img:/uploads/${mine}` });
    assert.ok(await sent(before, (e) => e.body && e.body.files && e.body.files.some((f) => f.filename === `SPOILER_${mine}`)), 'their own spoiler too');
    assert.deepStrictEqual(notices, [], 'nothing to report');

    before = discord.executions.length;
    M.emit('send-message', { code: chat.code, content: `=>#general look at this /uploads/${theirs}` });
    const other = await sent(before, (e) => e.body && e.body.content === 'look at this');
    assert.ok(other, 'the text still went');
    assert.ok(!other.body.files, "without someone else's file");
    assert.doesNotMatch(other.body.content, /uploads/, 'not even as a link');
    assert.ok(await until(() => notices.some((n) => OWN_NOTICE.test(n))), 'the member was told why');

    notices.length = 0;
    M.emit('send-message', { code: chat.code, content: `=>#general an old one /uploads/${OWNERLESS}` });
    const old = await sent(before, (e) => e.body && e.body.content === 'an old one');
    assert.ok(old && !old.body.files, 'a file with no owner on record stays in Haven');
    assert.ok(await until(() => notices.some((n) => OWN_NOTICE.test(n))), 'and the member was told');

    // A message that was only someone else's file sends nothing at all.
    notices.length = 0;
    M.emit('send-message', { code: chat.code, content: `=>#general [file:theirs.txt](/uploads/${theirs}|2 KB)` });
    assert.ok(await until(() => notices.some((n) => OWN_NOTICE.test(n))), 'told once');
    await wait(400);
    assert.strictEqual(discord.executions.length - before, 2, 'nothing else reached Discord');

    // The same in a Discord DM.
    notices.length = 0;
    const dmBefore = discord.botMessages.length;
    M.emit('send-message', { code: chat.code, content: `=>@Alice see this /uploads/${theirs}`, ferryDiscordUserId: ALICE.id });
    const dm = await until(() => discord.botMessages.slice(dmBefore)[0]);
    assert.ok(dm, 'the DM went');
    assert.match(dm.body.content, /see this/);
    assert.ok(!dm.body.files, "without someone else's file");
    assert.ok(await until(() => notices.some((n) => OWN_NOTICE.test(n))), 'the member was told');

    // The admin may send any member's channel upload, but not their DM files.
    before = discord.executions.length;
    A.emit('send-message', { code: chat.code, content: `=>#general from a member /uploads/${mine}` });
    const fromAdmin = await sent(before, (e) => e.body && e.body.content === 'from a member');
    assert.ok(fromAdmin, "the admin's message went");
    assert.deepStrictEqual(fromAdmin.body.files.map((f) => f.filename), [mine], "with the member's file");
    const adminNotice = next(A, 'error-msg', (m) => OWN_NOTICE.test(m));
    A.emit('send-message', { code: chat.code, content: `=>#general private /uploads/${private_}` });
    assert.ok(await adminNotice, "a member's DM file is not the admin's to send");
    const priv = await sent(before, (e) => e.body && e.body.content === 'private');
    assert.ok(priv && !priv.body.files, 'it stayed in Haven');
    errors.splice(0, errors.length, ...errors.filter((e) => !OWN_NOTICE.test(e)));
    M.close();
  });

  assert.deepStrictEqual(errors.filter((e) => !/forum|Sent to Discord/i.test(e)), [], 'no unexpected errors');
  A.close();
});
