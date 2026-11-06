'use strict';

// PostgreSQL app/startup tests require manually commenting out the explicit
// throw in src/database.js initDatabaseAsync() during migration. Restore the
// throw before committing: ordinary server startup must remain blocked.

// Starts server.js, not a subset of its handlers. This catches synchronous
// startup reads and browser bootstrap calls that the query harness cannot.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { setTimeout: wait } = require('node:timers/promises');
const { io } = require('socket.io-client');

function packet(socket, event, matches = () => true) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('Timed out waiting for ' + event)); }, 10000);
    const done = data => { if (matches(data)) { cleanup(); resolve(data); } };
    const failed = error => { cleanup(); reject(new Error(String(error))); };
    function cleanup() { clearTimeout(timer); socket.off(event, done); socket.off('error-msg', failed); }
    socket.on(event, done);
    socket.once('error-msg', failed);
  });
}

test('the real PostgreSQL app supports signup, login and public-room browsing', {
  skip: !process.env.HAVEN_TEST_POSTGRES_URL, timeout: 120000,
}, async t => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-postgres-app-'));
  process.env.HAVEN_DATA_DIR = data;
  const { Client } = require('../src/db/pgAddon').loadPg();
  const admin = new Client({ connectionString: process.env.HAVEN_TEST_POSTGRES_URL });
  await admin.connect();
  const schema = 'haven_app_' + crypto.randomBytes(8).toString('hex');
  await admin.query('CREATE SCHEMA "' + schema + '"');
  const url = new URL(process.env.HAVEN_TEST_POSTGRES_URL);
  url.searchParams.set('options', '-c search_path=' + schema);
  const { PostgresDatabase } = require('../src/db/postgres');
  const db = new PostgresDatabase({ url: url.href });
  const port = await new Promise(resolve => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => { const n = probe.address().port; probe.close(() => resolve(n)); });
  });
  const base = 'http://127.0.0.1:' + port;
  const sockets = [];
  let server, output = '';
  async function stop() {
    if (!server || server.exitCode !== null) return;
    const child = server;
    await new Promise(resolve => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 6000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      child.kill('SIGTERM');
    });
  }
  t.after(async () => {
    for (const socket of sockets) socket.disconnect();
    await stop();
    await db.close();
    await admin.query('DROP SCHEMA "' + schema + '" CASCADE');
    await admin.end();
    fs.rmSync(data, { recursive: true, force: true });
  });
  async function start() {
    output = '';
    server = spawn(process.execPath, ['server.js'], {
      cwd: path.join(__dirname, '..'), env: {
        ...process.env, HAVEN_DATA_DIR: data, HAVEN_DATABASE_URL: url.href, HAVEN_POSTGRES_PREVIEW: '1',
        JWT_SECRET: 'postgres-app-test-secret', ADMIN_USERNAME: 'admin', ADMIN_RESET_PASSWORD: '',
        FORCE_HTTP: 'true', HOST: '127.0.0.1', PORT: String(port),
      }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout.on('data', chunk => { output += chunk; });
    server.stderr.on('data', chunk => { output += chunk; });
    for (let i = 0; i < 120; i++) {
      if (server.exitCode !== null) throw new Error('Server exited: ' + output);
      try {
        const res = await fetch(base + '/api/health', { signal: AbortSignal.timeout(500) });
        if (res.ok) return;
      } catch { /* starting */ }
      await wait(250);
    }
    throw new Error('Server did not start: ' + output);
  }
  async function request(route, method = 'GET', body, token) {
    const res = await fetch(base + route, {
      method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000),
    });
    return { status: res.status, body: await res.json() };
  }
  const password = 'safe-preview-password-45';
  const signup = (username, extra = {}) => request('/api/auth/register', 'POST', { username, password, eulaVersion: '2.0', ageVerified: true, ...extra });
  const setting = (key, value) => db.prepare('INSERT INTO server_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  async function connect(token) {
    const socket = io(base, { autoConnect: false, auth: { token }, transports: ['websocket'], forceNew: true, reconnection: false });
    sockets.push(socket);
    const session = packet(socket, 'session-info');
    const connected = new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
    socket.connect();
    await connected;
    return { socket, session: await session };
  }
  async function emit(socket, event, response, data) {
    const result = packet(socket, response);
    socket.emit(event, data);
    return result;
  }
  let alice, room, adminAccount, peerAccount;
  await start();
  await t.test('serves the page, public configuration and one versioned schema without SQLite', async () => {
    assert.equal((await fetch(base)).status, 200);
    assert.equal((await request('/api/public-config')).status, 200);
    assert.equal((await request('/api/auth/registration-info')).status, 200);
    assert.equal(fs.existsSync(path.join(data, 'haven.db')), false);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM haven_schema_migrations').get()).n, 3);
  });
  await t.test('case-folded concurrent signups allocate one admin and one identity', async () => {
    const admins = await Promise.all([signup('admin'), signup('ADMIN')]);
    assert.deepEqual(admins.map(r => r.status).sort(), [200, 400]);
    adminAccount = admins.find(r => r.status === 200).body;
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1').get()).n, 1);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM user_roles ur JOIN users u ON ur.user_id = u.id WHERE u.is_admin = 1').get()).n, 2);
    const names = await Promise.all([signup('Alice'), signup('aLiCe')]);
    assert.deepEqual(names.map(r => r.status).sort(), [200, 400]);
    alice = names.find(r => r.status === 200).body;
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM eula_acceptances WHERE user_id = ?').get(alice.user.id)).n, 1);
  });
  await t.test('rejects invalid registration and login and validates a normal session', async () => {
    assert.equal((await signup('ab')).status, 400);
    assert.equal((await signup('noage', { ageVerified: false })).status, 400);
    assert.equal((await signup('noterms', { eulaVersion: '' })).status, 400);
    assert.equal((await request('/api/auth/login', 'POST', { username: 'alice', password: 'wrong', eulaVersion: '2.0', ageVerified: true })).status, 401);
    const login = await request('/api/auth/login', 'POST', { username: 'ALICE', password, eulaVersion: '2.0', ageVerified: true });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    alice = login.body;
    assert.equal((await request('/api/auth/validate', 'GET', undefined, alice.token)).status, 200);
    assert.equal((await request('/api/auth/validate')).status, 401);
  });
  await t.test('browser bootstrap APIs read PostgreSQL and unmigrated actions fail explicitly', async () => {
    for (const route of ['/api/themes','/api/plugins','/api/sounds','/api/emojis','/api/stickers','/api/standard-emojis',
      '/api/user-sound-prefs','/api/user/channel-prefs','/api/personas','/api/connection-address','/api/media-token','/api/ice-servers',
      '/api/bot-commands','/api/push/vapid-key','/api/auth/totp/status','/api/auth/recovery-codes/status','/api/auth/user-servers']) {
      const result = await request(route, 'GET', undefined, alice.token);
      assert.equal(result.status, 200, route + ': ' + JSON.stringify(result.body));
    }
    assert.equal((await request('/api/personas')).status, 401);
    const disabled = await request('/api/auth/change-password', 'POST', {}, alice.token);
    assert.equal(disabled.status, 501);
    assert.equal(disabled.body.code, 'postgres_preview_unsupported');
    assert.equal((await request('/API/AUTH/change-password/', 'POST', {}, alice.token)).status, 501);
    assert.equal((await request('/API/PERSONAS/', 'GET', undefined, alice.token)).status, 200);
  });
  await t.test('a real socket receives its session, lists and enters General and reads history', async () => {
    const { socket, session } = await connect(alice.token);
    assert.equal(session.id, alice.user.id);
    assert.equal(session.isAdmin, false);
    assert.ok(session.roles.some(r => r.name === 'Member'));
    const channels = await emit(socket, 'get-channels', 'channels-list');
    room = channels.find(ch => ch.name === 'General');
    assert.ok(room?.code);
    await setting('turnstile_secret_key', 'private-captcha-secret');
    await setting('ferry_bot_token', 'private-ferry-token');
    const settings = await emit(socket, 'get-server-settings', 'server-settings');
    assert.equal(settings.turnstile_secret_key, undefined);
    assert.equal(settings.ferry_bot_token, undefined);
    assert.equal(settings.registration_token, undefined);
    assert.deepEqual(await emit(socket, 'get-preferences', 'preferences'), {});
    assert.deepEqual(await emit(socket, 'set-preference', 'preference-saved', { key: 'time_format', value: '24h' }), { key: 'time_format', value: '24h' });
    socket.emit('enter-channel', { code: room.code });
    const members = await emit(socket, 'get-channel-members', 'channel-members', { code: room.code });
    assert.ok(members.members.some(u => u.id === alice.user.id));
    const post = await db.prepare("INSERT INTO messages (channel_id, user_id, content) VALUES (?, ?, 'hello from PostgreSQL') RETURNING id").get(room.id, alice.user.id);
    const history = await emit(socket, 'get-messages', 'message-history', { code: room.code });
    assert.equal(history.messages.at(-1).id, post.id);
    assert.equal(history.messages.at(-1).content, 'hello from PostgreSQL');
    socket.emit('mark-read', { code: room.code, messageId: post.id });
    await emit(socket, 'get-preferences', 'preferences'); // waits behind mark-read in the per-socket queue
    assert.equal((await db.prepare('SELECT last_read_message_id FROM read_positions WHERE user_id = ? AND channel_id = ?').get(alice.user.id, room.id)).last_read_message_id, post.id);
    const backup = await emit(socket, 'get-encrypted-key', 'encrypted-key-result');
    assert.equal(backup.hasPublicKey, false);
    const { publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const jwk = publicKey.export({ format: 'jwk' });
    await emit(socket, 'publish-public-key', 'public-key-published', { jwk });
    await emit(socket, 'store-encrypted-key', 'encrypted-key-stored', { encryptedKey: 'opaque-key', salt: 'salt', separatePassphrase: false });
    assert.equal((await emit(socket, 'get-encrypted-key', 'encrypted-key-result')).encryptedKey, 'opaque-key');
    await emit(socket, 'publish-signing-key', 'signing-key-published', { jwk });
    assert.deepEqual(await emit(socket, 'get-signing-key', 'signing-key-result', { userId: alice.user.id }), { userId: alice.user.id, jwk, keys: [jwk] });
    await emit(socket, 'store-signing-backup', 'signing-backup-stored', { backup: 'opaque-signing-backup' });
    assert.equal((await emit(socket, 'get-encrypted-key', 'encrypted-key-result')).signingBackup, 'opaque-signing-backup');
    const newer = await db.prepare("INSERT INTO messages (channel_id, user_id, content) VALUES (?, ?, 'latest top-level') RETURNING id").get(room.id, alice.user.id);
    await db.prepare("INSERT INTO messages (channel_id, user_id, content, thread_id) VALUES (?, ?, 'thread reply', ?)").run(room.id, alice.user.id, post.id);
    const peer = await connect(alice.token);
    socket.emit('mark-read', { code: room.code, messageId: newer.id });
    peer.socket.emit('mark-read', { code: room.code, messageId: post.id });
    await Promise.all([emit(socket, 'get-preferences', 'preferences'), emit(peer.socket, 'get-preferences', 'preferences')]);
    assert.equal((await db.prepare('SELECT last_read_message_id FROM read_positions WHERE user_id = ? AND channel_id = ?').get(alice.user.id, room.id)).last_read_message_id, newer.id);
    peer.socket.disconnect();
    await db.prepare('DELETE FROM read_positions WHERE user_id = ? AND channel_id = ?').run(alice.user.id, room.id);
    socket.emit('mark-read-channel', { code: room.code });
    await emit(socket, 'get-preferences', 'preferences');
    assert.equal((await db.prepare('SELECT last_read_message_id FROM read_positions WHERE user_id = ? AND channel_id = ?').get(alice.user.id, room.id)).last_read_message_id, newer.id);
    const unsupported = packet(socket, 'error-msg');
    socket.emit('create-channel', { name: 'unconverted' });
    assert.match(await unsupported, /not available/);
    assert.equal(await db.prepare("SELECT id FROM channels WHERE name = 'unconverted'").get(), undefined);
    socket.disconnect();
  });
  await t.test('real PostgreSQL sockets mark all rooms and forum topics read and synchronize thread receipts', async () => {
    const forum = await db.prepare("INSERT INTO channels (name, code, is_forum) VALUES ('Read forum', 'e3333333', 1) RETURNING id").get();
    await db.prepare('INSERT INTO channel_members (channel_id, user_id) VALUES (?, ?)').run(forum.id, alice.user.id);
    const parent = await db.prepare("INSERT INTO messages (channel_id, user_id, content) VALUES (?, ?, 'topic') RETURNING id").get(forum.id, alice.user.id);
    const reply = await db.prepare("INSERT INTO messages (channel_id, user_id, content, thread_id) VALUES (?, ?, 'reply', ?) RETURNING id").get(forum.id, alice.user.id, parent.id);
    const empty = await db.prepare("INSERT INTO messages (channel_id, user_id, content) VALUES (?, ?, 'empty topic') RETURNING id").get(forum.id, alice.user.id);
    const { socket } = await connect(alice.token);
    const peer = await connect(alice.token);
    const ack = (client, event, data = {}) => new Promise((resolve, reject) => client.timeout(10000).emit(event, data, (err, result) => err ? reject(err) : resolve(result)));
    try {
      assert.deepEqual(await ack(socket, 'get-thread-read-state', { parentIds: [parent.id, empty.id] }), { reads: { [parent.id]: 0, [empty.id]: 0 } });
      const threadRead = packet(peer.socket, 'thread-read');
      socket.emit('mark-thread-read', { parentId: parent.id });
      assert.deepEqual(await threadRead, { channelCode: 'e3333333', parentId: parent.id });
      assert.deepEqual(await ack(socket, 'get-thread-read-state', { parentIds: [parent.id] }), { reads: { [parent.id]: reply.id } });
      const selfRead = packet(socket, 'forum-read'), peerRead = packet(peer.socket, 'forum-read');
      socket.emit('mark-forum-read', { code: 'e3333333' });
      assert.deepEqual(await selfRead, { channelCode: 'e3333333' });
      assert.deepEqual(await peerRead, { channelCode: 'e3333333' });
      assert.deepEqual(await ack(peer.socket, 'get-thread-read-state', { parentIds: [parent.id, empty.id] }), {
        reads: { [parent.id]: reply.id, [empty.id]: 0 },
      });
      const result = await ack(socket, 'mark-all-read');
      assert.deepEqual(result, { ok: true, channels: 2 });
      assert.equal((await db.prepare('SELECT last_read_message_id FROM read_positions WHERE user_id = ? AND channel_id = ?').get(alice.user.id, forum.id)).last_read_message_id, empty.id);
      peerAccount = (await signup('ReceiptOutsider')).body;
      const outside = await connect(peerAccount.token);
      try {
        outside.socket.emit('mark-thread-read', { parentId: parent.id });
        outside.socket.emit('mark-forum-read', { code: 'e3333333' });
        await emit(outside.socket, 'get-preferences', 'preferences');
        assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM thread_reads WHERE user_id = ?').get(peerAccount.user.id)).n, 0);
        assert.deepEqual(await ack(outside.socket, 'get-thread-read-state', { parentIds: [parent.id] }), { reads: {} });
      } finally { outside.socket.disconnect(); }
    } finally {
      socket.disconnect(); peer.socket.disconnect();
      await db.prepare('DELETE FROM channels WHERE id = ?').run(forum.id);
    }
  });
  await t.test('members send room text and replies with live delivery, history and read receipts', async st => {
    const bob = peerAccount;
    const { socket } = await connect(alice.token);
    const other = (await connect(bob.token)).socket;
    const peer = (await connect(alice.token)).socket;
    st.after(() => { socket.disconnect(); other.disconnect(); peer.disconnect(); });
    await Promise.all([socket, other, peer].map(client => emit(client, 'get-channels', 'channels-list')));

    const received = packet(other, 'new-message');
    const own = await emit(socket, 'send-message', 'new-message', { code: room.code, content: '@silent /break hello from a socket' });
    assert.deepEqual(await received, own);
    assert.equal(own.message.content, 'hello from a socket');
    assert.equal(own.message.silent, true);
    assert.equal(own.message.break_chain, 1);

    const reply = await emit(other, 'send-message', 'new-message', { code: room.code, content: 'a reply', replyTo: own.message.id });
    assert.equal(reply.message.replyContext.content, own.message.content);
    const history = await emit(other, 'get-messages', 'message-history', { code: room.code });
    assert.equal(history.messages.at(-1).id, reply.message.id);
    assert.equal(history.messages.at(-1).created_at, reply.message.created_at);
    assert.deepEqual(history.messages.at(-1).replyContext, reply.message.replyContext);
    assert.equal(history.lastReadMessageId, reply.message.id);
    const receipt = packet(peer, 'channel-read', data => data.channelCode === room.code && data.messageId === reply.message.id);
    socket.emit('mark-read-channel', { code: room.code });
    await receipt;

    await db.prepare('UPDATE channels SET slow_mode_interval = 30 WHERE id = ?').run(room.id);
    st.after(() => db.prepare('UPDATE channels SET slow_mode_interval = 0 WHERE id = ?').run(room.id));
    const refusals = [];
    for (const client of [socket, peer]) client.on('error-msg', error => refusals.push(error));
    const counted = packet(other, 'new-message', value => value.message.content.startsWith('slow mode '));
    socket.emit('send-message', { code: room.code, content: 'slow mode first device' });
    peer.emit('send-message', { code: room.code, content: 'slow mode second device' });
    await counted;
    await Promise.all([socket, peer].map(client => emit(client, 'get-preferences', 'preferences')));
    assert.equal(refusals.length, 1);
    assert.match(refusals[0], /Slow mode/);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM messages WHERE content LIKE 'slow mode %'").get()).n, 1);
  });
  await t.test('PostgreSQL preview refuses restricted posts and filters message and status text', async st => {
    const { socket } = await connect(alice.token);
    st.after(() => socket.disconnect());
    const send = content => emit(socket, 'send-message', 'error-msg', { code: room.code, content });
    const patch = await db.prepare("SELECT value FROM server_settings WHERE key = 'automod_words'").get();
    st.after(async () => {
      if (patch) await setting('automod_words', patch.value);
      else await db.prepare("DELETE FROM server_settings WHERE key = 'automod_words'").run();
      await db.prepare('UPDATE channels SET read_only = 0 WHERE id = ?').run(room.id);
      await db.prepare('DELETE FROM mutes WHERE user_id = ?').run(alice.user.id);
    });
    const before = await db.prepare('SELECT COUNT(*) AS n FROM messages WHERE channel_id = ?').get(room.id);
    await setting('automod_words', JSON.stringify([{ name: 'preview test', words: ['filteredword'], strikes: 1 }]));
    assert.match(await send('filteredword'), /word this server does not allow/);
    assert.match(await emit(socket, 'set-status', 'error-msg', { status: 'dnd', statusText: 'filteredword' }), /word this server does not allow/);
    await db.prepare('UPDATE channels SET read_only = 1 WHERE id = ?').run(room.id);
    assert.match(await send('read only'), /read-only/);
    await db.prepare('UPDATE channels SET read_only = 0 WHERE id = ?').run(room.id);
    await db.prepare("INSERT INTO mutes (user_id, muted_by, expires_at) VALUES (?, ?, (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') + INTERVAL '5 minutes')")
      .run(alice.user.id, alice.user.id);
    assert.match(await send('timed out'), /timeout/);
    assert.deepEqual(await db.prepare('SELECT COUNT(*) AS n FROM messages WHERE channel_id = ?').get(room.id), before);
    assert.equal((await db.prepare('SELECT status_text FROM users WHERE id = ?').get(alice.user.id)).status_text, '');
  });
  await t.test('DM opens are unique, ciphertext stays opaque, and status respects membership and invisibility', async st => {
    const bob = peerAccount;
    const { socket } = await connect(alice.token);
    const other = (await connect(bob.token)).socket;
    const peer = (await connect(alice.token)).socket;
    const oldVisibility = await db.prepare("SELECT value FROM server_settings WHERE key = 'member_visibility'").get();
    st.after(async () => {
      socket.disconnect(); other.disconnect(); peer.disconnect();
      await db.prepare('DELETE FROM channels WHERE is_dm = 1 AND created_by IN (?, ?)').run(alice.user.id, bob.user.id);
      await db.prepare("UPDATE users SET status = 'online', status_text = '' WHERE id = ?").run(alice.user.id);
      if (oldVisibility) await setting('member_visibility', oldVisibility.value);
      else await db.prepare("DELETE FROM server_settings WHERE key = 'member_visibility'").run();
    });
    await setting('member_visibility', 'online');
    const a = packet(socket, 'dm-opened'), b = packet(other, 'dm-opened');
    socket.emit('start-dm', { targetUserId: bob.user.id });
    other.emit('start-dm', { targetUserId: alice.user.id });
    const [dm, reverse] = await Promise.all([a, b]);
    assert.equal(dm.id, reverse.id);
    assert.equal(dm.dm_target.id, bob.user.id);
    assert.equal(reverse.dm_target.id, alice.user.id);
    await Promise.all([socket, other].map(client => emit(client, 'get-preferences', 'preferences')));
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM channels WHERE is_dm = 1').get()).n, 1);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM channel_members WHERE channel_id = ?').get(dm.id)).n, 2);

    const ciphertext = JSON.stringify({ v: 1, iv: 'opaque-iv', ct: 'opaque-ciphertext' });
    const delivered = packet(other, 'new-message');
    const sent = await emit(socket, 'send-message', 'new-message', { code: dm.code, content: ciphertext, encrypted: true });
    assert.equal((await delivered).message.content, ciphertext);
    const history = await emit(other, 'get-messages', 'message-history', { code: dm.code });
    assert.equal(history.messages.at(-1).id, sent.message.id);
    assert.equal(history.messages.at(-1).content, ciphertext);
    assert.match(await emit(socket, 'send-message', 'error-msg', { code: dm.code, content: 'plaintext' }), /end-to-end encrypted/);
    const typing = packet(other, 'user-typing');
    socket.emit('typing', { code: dm.code });
    assert.equal((await typing).userId, alice.user.id);

    const dmPresence = packet(other, 'online-users', value => value.channelCode === dm.code &&
      value.users.some(user => user.id === alice.user.id && user.status === 'dnd'));
    const update = packet(peer, 'status-updated');
    const status = await emit(socket, 'set-status', 'status-updated', { status: 'dnd', statusText: '  working  ' });
    assert.deepEqual(status, { status: 'dnd', statusText: 'working' });
    assert.deepEqual(await update, status);
    assert.equal((await dmPresence).users.find(user => user.id === alice.user.id).statusText, 'working');
    assert.deepEqual(await db.prepare('SELECT status, status_text FROM users WHERE id = ?').get(alice.user.id), { status: 'dnd', status_text: 'working' });

    const hidden = packet(other, 'online-users', value => value.channelCode === dm.code &&
      !value.users.some(user => user.id === alice.user.id));
    await emit(socket, 'set-status', 'status-updated', { status: 'invisible', statusText: 'working' });
    await hidden;
    const outsider = (await connect(adminAccount.token)).socket;
    st.after(() => outsider.disconnect());
    assert.match(await emit(outsider, 'get-messages', 'error-msg', { code: dm.code }), /not a member/i);
    assert.match(await emit(outsider, 'send-message', 'error-msg', { code: dm.code, content: ciphertext }), /not a member/i);

    await db.prepare('DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?').run(dm.id, bob.user.id);
    let leaked = false;
    other.on('new-message', () => { leaked = true; });
    await emit(socket, 'send-message', 'new-message', { code: dm.code, content: ciphertext });
    await emit(other, 'get-preferences', 'preferences');
    assert.equal(leaked, false, 'a removed member still in the Socket.IO room receives no message');
    assert.match(await emit(other, 'get-messages', 'error-msg', { code: dm.code }), /not a member/i);

    const notes = await emit(other, 'start-dm', 'dm-opened', { targetUserId: bob.user.id });
    assert.equal(notes.is_self_dm, 1);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM channel_members WHERE channel_id = ?').get(notes.id)).n, 1);
    const savedNote = await emit(other, 'send-message', 'new-message', { code: notes.code, content: ciphertext });
    assert.equal(savedNote.message.content, ciphertext);

    await emit(socket, 'set-status', 'status-updated', { status: 'away', statusText: 'working' });
    const active = packet(peer, 'status-updated', value => value.status === 'online');
    const reconnected = await connect(alice.token);
    st.after(() => reconnected.socket.disconnect());
    assert.equal(reconnected.session.status, 'online');
    assert.deepEqual(await active, { status: 'online', statusText: 'working' });
  });
  await t.test('the initial browser burst includes roles, notices and scoped admin reads', async () => {
    const { socket } = await connect(alice.token);
    assert.ok((await emit(socket, 'get-roles', 'roles-list')).some(role => role.name === 'Member' && role.permissions.length));
    assert.deepEqual(await emit(socket, 'get-group-invites', 'group-dm-invites'), { invites: [] });
    assert.deepEqual(await emit(socket, 'get-recovery-notice-state', 'recovery-notice-state'), { show: true });
    const warnings = await new Promise(resolve => socket.emit('get-pending-warnings', {}, resolve));
    assert.deepEqual(warnings, { ok: true, warnings: [] });
    assert.deepEqual(await emit(socket, 'get-automod-domains', 'automod-domain-list'), []);
    assert.deepEqual(await emit(socket, 'get-automod-log', 'automod-log', { limit: 20 }), { entries: [], hostCounts: [] });
    await emit(socket, 'ping-check', 'pong-check');
    assert.deepEqual(await emit(socket, 'get-connections', 'connections'), { connections: [], available: { steam: false, spotify: false, lastfm: false } });
    assert.deepEqual(await emit(socket, 'get-listening', 'listening-state'), { token: null });
    const role = await db.prepare("INSERT INTO roles (name) VALUES ('Inviter') RETURNING id").get();
    await db.prepare("INSERT INTO role_permissions (role_id, permission, allowed) VALUES (?, 'invite_users', 1)").run(role.id);
    await db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)').run(alice.user.id, role.id);
    const owner = await db.prepare('SELECT id FROM users WHERE is_admin = 1').get();
    await db.prepare("INSERT INTO invite_codes (code, created_by) VALUES ('mine', ?), ('someone-elses', ?)").run(alice.user.id, owner.id);
    const mine = await emit(socket, 'get-invite-codes', 'invite-codes-list');
    assert.deepEqual(mine.map(row => row.code), ['mine']);
    socket.disconnect();
    const adminLogin = await request('/api/auth/login', 'POST', { username: 'admin', password, eulaVersion: '2.0', ageVerified: true });
    const moderator = await connect(adminLogin.body.token);
    assert.ok((await emit(moderator.socket, 'get-invite-codes', 'invite-codes-list')).some(row => row.code === 'someone-elses'));
    assert.ok((await emit(moderator.socket, 'get-automod-domains', 'automod-domain-list')).length > 10);
    assert.deepEqual(await emit(moderator.socket, 'get-media-cache-stats', 'media-cache-stats'), { items: 0, bytes: 0 });
    assert.deepEqual(await emit(moderator.socket, 'get-automod-log', 'automod-log', {}), { entries: [], hostCounts: [] });
    moderator.socket.disconnect();
    await db.prepare('DELETE FROM user_roles WHERE role_id = ?').run(role.id);
    await db.prepare('DELETE FROM role_permissions WHERE role_id = ?').run(role.id);
    await db.prepare('DELETE FROM roles WHERE id = ?').run(role.id);
  });
  await t.test('private and role-gated rooms refuse reads and read-position writes', async () => {
    const privateRoom = await db.prepare("INSERT INTO channels (name, code, is_private) VALUES ('Private', 'e1111111', 1) RETURNING id").get();
    const role = await db.prepare("INSERT INTO roles (name) VALUES ('Required role') RETURNING id").get();
    const gated = await db.prepare("INSERT INTO channels (name, code, role_gate) VALUES ('Gated', 'e2222222', ?) RETURNING id")
      .get(JSON.stringify({ mode: 'all', roles: [role.id] }));
    await db.prepare('INSERT INTO channel_members (channel_id, user_id) VALUES (?, ?)').run(gated.id, alice.user.id);
    const { socket } = await connect(alice.token);
    const channels = await emit(socket, 'get-channels', 'channels-list');
    assert.equal(channels.some(ch => ch.id === privateRoom.id || ch.id === gated.id), false);
    for (const code of ['e1111111', 'e2222222']) {
      const error = packet(socket, 'error-msg');
      socket.emit('get-messages', { code });
      assert.match(await error, /member|role/);
    }
    const error = packet(socket, 'error-msg');
    socket.emit('mark-read', { code: 'e1111111', messageId: 1 });
    assert.match(await error, /member/);
    assert.equal(await db.prepare('SELECT 1 FROM read_positions WHERE user_id = ? AND channel_id = ?').get(alice.user.id, privateRoom.id), undefined);
    socket.disconnect();
    await db.prepare('DELETE FROM channels WHERE id IN (?, ?)').run(privateRoom.id, gated.id);
    await db.prepare('DELETE FROM roles WHERE id = ?').run(role.id);
  });
  await t.test('single-use invites cannot be consumed twice across concurrent registrations', async () => {
    await setting('registration_token_enabled', 'true');
    await setting('invites_bypass_registration_token', 'true');
    await setting('registration_token', 'private-token');
    await db.prepare("INSERT INTO invite_codes (code, max_uses, enabled) VALUES ('single-use', 1, 1)").run();
    const results = await Promise.all([signup('inviteone', { inviteCode: 'single-use' }), signup('invitetwo', { inviteCode: 'single-use' })]);
    assert.deepEqual(results.map(r => r.status).sort(), [200, 403]);
    const invite = await db.prepare("SELECT id, spent FROM invite_codes WHERE code = 'single-use'").get();
    assert.equal(invite.spent, 1);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM invite_code_uses WHERE invite_code_id = ?').get(invite.id)).n, 1);
    assert.equal((await signup('needsinvite')).status, 403);
    await setting('registration_token_enabled', 'false');
  });
  await t.test('a late signup failure rolls back the identity, invite use and EULA together', async () => {
    await setting('registration_token_enabled', 'true');
    await db.prepare("INSERT INTO invite_codes (code, max_uses) VALUES ('rollback-invite', 1)").run();
    await db.exec(`CREATE FUNCTION refuse_test_eula() RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id AND username = 'rollbackuser') THEN
          RAISE EXCEPTION 'test registration failure';
        END IF;
        RETURN NEW;
      END
    $$;
    CREATE TRIGGER refuse_test_eula BEFORE INSERT ON eula_acceptances FOR EACH ROW EXECUTE FUNCTION refuse_test_eula();`);
    try {
      assert.equal((await signup('rollbackuser', { inviteCode: 'rollback-invite' })).status, 500);
      assert.equal(await db.prepare("SELECT id FROM users WHERE username = 'rollbackuser'").get(), undefined);
      assert.equal((await db.prepare("SELECT spent FROM invite_codes WHERE code = 'rollback-invite'").get()).spent, 0);
    } finally {
      await db.exec('DROP TRIGGER refuse_test_eula ON eula_acceptances; DROP FUNCTION refuse_test_eula()');
      await setting('registration_token_enabled', 'false');
    }
  });
  await t.test('whitelist and CAPTCHA gates stay enforced', async () => {
    await setting('whitelist_enabled', 'true');
    assert.equal((await signup('blocked')).status, 403);
    await db.prepare("INSERT INTO whitelist (username) VALUES ('aLLoWeD')").run();
    assert.equal((await signup('allowed')).status, 200);
    await setting('whitelist_enabled', 'false');
    await setting('registration_captcha_enabled', 'true');
    assert.equal((await signup('nocaptcha')).status, 400);
    await setting('registration_captcha_enabled', 'false');
  });
  await t.test('sessions and media tokens reject bans and password-version revocations', async () => {
    const { socket } = await connect(alice.token);
    const media = (await request('/api/media-token', 'GET', undefined, alice.token)).body.token;
    assert.equal((await request('/api/media-proxy?mt=' + media)).status, 400);
    await db.prepare('INSERT INTO bans (user_id, banned_by, reason) VALUES (?, ?, ?)').run(alice.user.id, alice.user.id, 'test');
    assert.equal((await request('/api/personas', 'GET', undefined, alice.token)).status, 403);
    assert.equal((await request('/api/media-proxy?mt=' + media)).status, 401);
    const disconnected = new Promise(resolve => socket.once('disconnect', resolve));
    socket.emit('get-channels');
    await disconnected;
    await db.prepare('DELETE FROM bans WHERE user_id = ?').run(alice.user.id);
    await db.prepare('UPDATE users SET password_version = password_version + 1 WHERE id = ?').run(alice.user.id);
    assert.equal((await request('/api/auth/validate', 'GET', undefined, alice.token)).status, 401);
    assert.equal((await request('/api/media-proxy?mt=' + media)).status, 401);
  });
  await t.test('unmigrated second-factor and temporary-password logins fail explicitly', async () => {
    await db.prepare('UPDATE users SET totp_enabled = 1 WHERE id = ?').run(alice.user.id);
    const result = await request('/api/auth/login', 'POST', { username: 'alice', password, eulaVersion: '2.0', ageVerified: true });
    assert.equal(result.status, 501);
    assert.equal(result.body.code, 'postgres_preview_unsupported');
    await db.prepare('UPDATE users SET totp_enabled = 0 WHERE id = ?').run(alice.user.id);
  });
  await t.test('a restart preserves identities, settings and the default room', async () => {
    const before = await db.prepare('SELECT value FROM server_settings WHERE key = ?').get('server_fingerprint');
    await stop();
    await start();
    assert.deepEqual(await db.prepare('SELECT value FROM server_settings WHERE key = ?').get('server_fingerprint'), before);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM channels').get()).n, 1);
    assert.equal((await request('/api/auth/login', 'POST', { username: 'alice', password, eulaVersion: '2.0', ageVerified: true })).status, 200);
    assert.equal(fs.existsSync(path.join(data, 'haven.db')), false);
    assert.doesNotMatch(output, /unhandled|TypeError|SyntaxError/);
  });
});
