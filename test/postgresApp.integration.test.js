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

function packet(socket, event) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('Timed out waiting for ' + event)); }, 10000);
    const done = data => { cleanup(); resolve(data); };
    const failed = error => { cleanup(); reject(new Error(String(error))); };
    function cleanup() { clearTimeout(timer); socket.off(event, done); socket.off('error-msg', failed); }
    socket.once(event, done);
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
  let alice, room;
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
