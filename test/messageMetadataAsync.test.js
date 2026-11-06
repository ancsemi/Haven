'use strict';

// The real Socket.IO handlers use SQLite, or PostgreSQL for just the converted
// key/receipt queries. Message-body persistence remains on legacy SQLite in
// this batch; a send exercises its real post-send cursor update.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setImmediate: nextTurn } = require('node:timers/promises');
const { Server } = require('socket.io');
const { io: connect } = require('socket.io-client');
const http = require('node:http');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-message-metadata-'));
process.env.HAVEN_DATA_DIR = DATA;
process.env.JWT_SECRET = 'message-metadata-test-secret';
delete process.env.HAVEN_DATABASE_URL;
const database = require('../src/database');
const db = database.initDatabase();
const sqliteAsync = db.async;
const { createPostgresFixture } = require('./postgresHarness');
const permissions = require('../src/socketHandlers/permissions')(db);
const key = name => ({ kty: 'EC', crv: 'P-256', x: name, y: 'y-' + name });
const users = {};
for (const name of ['alice', 'bob', 'admin']) {
  users[name] = db.prepare('INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, ?)')
    .run(name, 'fixture', name === 'admin' ? 1 : 0).lastInsertRowid;
}
const pub = { ...key('public-alice'), key_ops: ['deriveKey'] };
const sign = key('signing-alice');
db.prepare('UPDATE users SET public_key = ?, signing_key = ?, encrypted_private_key = ?, e2e_key_salt = ?, signing_backup = ? WHERE id = ?')
  .run(JSON.stringify(pub), JSON.stringify(sign), 'alice-encrypted-backup', 'alice-salt', 'alice-signing-backup', users.alice);
db.prepare('UPDATE users SET public_key = ?, signing_key = ?, encrypted_private_key = ?, e2e_key_salt = ? WHERE id = ?')
  .run(JSON.stringify(key('public-bob')), JSON.stringify(key('signing-54')), 'bob-private-backup', 'bob-private-salt', users.bob);
// The clock and fp spelling deliberately disagree with publication order.
// SQLite's rowid and the PostgreSQL insertion sequence must both win.
const history = [];
for (let i = 0; i < 55; i++) {
  const jwk = key('signing-' + i);
  history.push(jwk);
  db.prepare('INSERT INTO user_signing_keys (user_id, fp, jwk, created_at) VALUES (?, ?, ?, ?)')
    .run(users.bob, 'fp-' + String(100 - i), JSON.stringify(jwk), i === 54 ? '2000-01-01 00:00:00' : '2026-01-01 00:00:00');
}
db.prepare('INSERT INTO user_signing_keys (user_id, fp, jwk) VALUES (?, ?, ?)')
  .run(users.alice, 'alice-key', JSON.stringify(sign));
const rooms = {};
let codeNumber = 0x10000000;
for (const [name, dm] of [['room', 0], ['dm', 1], ['private', 0], ['empty', 0], ['threadOnly', 0], ['forum', 0], ['emptyForum', 0], ['zero', 0]]) {
  const code = (++codeNumber).toString(16);
  const id = db.prepare('INSERT INTO channels (name, code, is_dm) VALUES (?, ?, ?)').run(name, code, dm).lastInsertRowid;
  rooms[name] = { id, code };
  db.prepare('INSERT INTO channel_members (channel_id, user_id) VALUES (?, ?)').run(id, users.alice);
  if (name === 'room' || name === 'dm') db.prepare('INSERT INTO channel_members (channel_id, user_id) VALUES (?, ?)').run(id, users.bob);
}
const post = (room, text, thread = null) => db.prepare('INSERT INTO messages (channel_id, user_id, content, thread_id) VALUES (?, ?, ?, ?)')
  .run(rooms[room].id, users.bob, text, thread).lastInsertRowid;
const roomFirst = post('room', 'first');
const roomLast = post('room', 'latest top-level');
post('room', 'thread reply', roomFirst);
post('dm', 'first DM');
const dmLast = post('dm', 'latest DM');
const privatePost = post('private', 'private message');
post('threadOnly', 'only a thread reply', roomFirst);
db.prepare('UPDATE channels SET is_forum = 1 WHERE id IN (?, ?)').run(rooms.forum.id, rooms.emptyForum.id);
const forumFirst = post('forum', 'first topic');
const forumReply = post('forum', 'topic reply', forumFirst);
const forumEmpty = post('forum', 'topic without replies');
db.prepare('INSERT INTO messages (id, channel_id, user_id, content) VALUES (0, ?, ?, ?)').run(rooms.zero.id, users.bob, 'id zero');
const baselineMessageId = db.prepare('SELECT MAX(id) AS id FROM messages').get().id;

const timers = [];
const nativeInterval = global.setInterval;
const intervalMock = test.mock.method(global, 'setInterval', (...args) => {
  const timer = nativeInterval(...args);
  timers.push(timer);
  timer.unref();
  return timer;
});
let registerUsers, registerGroups, registerMessages;
try {
  registerUsers = require('../src/socketHandlers/users');
  registerGroups = require('../src/socketHandlers/groupE2E');
  registerMessages = require('../src/socketHandlers/messages');
} finally { intervalMock.mock.restore(); }

const server = http.createServer();
const sockets = new Server(server);
let base;
const clients = [];
const immediateMarkers = [];
sockets.use((socket, next) => {
  const name = socket.handshake.auth.name || 'alice';
  if (!users[name]) return next(new Error('Unknown fixture user'));
  socket.user = { id: users[name], username: name, displayName: name, isAdmin: name === 'admin' };
  next();
});
sockets.on('connection', socket => {
  const ctx = {
    io: sockets, db,
    state: { channelUsers: new Map(), voiceUsers: new Map(), slowModeTracker: new Map() },
    ...permissions,
    automod: { newAccountWaitMinutes: () => 0 },
    floodCheck: () => false, touchVoiceActivity: () => {}, enforceAutomod: () => false,
    parseFerryTarget: () => null, ferryRelay: () => {}, ferryRelayReply: () => {},
    sendPushNotifications: () => {}, fireWebhookCallbacks: () => {},
    processSlashCommand: (command, arg) => command === 'me' ? { content: '*alice ' + arg + '*' } : null,
  };
  const pending = new Set();
  const on = socket.on;
  socket.on = function(event, handler) {
    return on.call(this, event, (...args) => {
      const result = handler(...args);
      if (result && typeof result.then === 'function') {
        pending.add(result);
        result.then(() => pending.delete(result), () => pending.delete(result));
      }
      return result;
    });
  };
  require('../src/socketHandlers/threadReadState')(socket, ctx);
  registerUsers(socket, ctx);
  registerGroups(socket, ctx);
  for (const row of db.prepare('SELECT c.code FROM channels c JOIN channel_members cm ON cm.channel_id = c.id WHERE cm.user_id = ?').all(socket.user.id)) socket.join('channel:' + row.code);
  const registrationTimers = test.mock.method(global, 'setInterval', (...args) => {
    const timer = nativeInterval(...args);
    timers.push(timer);
    timer.unref();
    return timer;
  });
  try { registerMessages(socket, ctx); }
  finally { registrationTimers.mock.restore(); }
  socket.on = on;
  socket.on('send-message', () => {
    if (db.async.kind === 'sqlite') {
      immediateMarkers.push(db.prepare('SELECT last_read_message_id FROM read_positions WHERE user_id = ? ORDER BY last_read_message_id DESC LIMIT 1').get(socket.user.id)?.last_read_message_id);
    }
  });
  socket.on('test-barrier', async (_data, callback) => {
    await Promise.all([...pending]);
    await (db.async || db).prepare('SELECT 1').get();
    callback({ ok: true });
  });
});
test.before(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
});
test.after(async () => {
  clients.forEach(client => client.disconnect());
  await new Promise(resolve => sockets.close(resolve));
  timers.forEach(clearInterval);
  db.close();
  fs.rmSync(DATA, { recursive: true, force: true });
});
function packet(client, event) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('Timed out: ' + event)); }, 5000);
    const done = value => { cleanup(); resolve(value); };
    const error = value => { cleanup(); reject(new Error(String(value))); };
    function cleanup() { clearTimeout(timer); client.off(event, done); client.off('error-msg', error); }
    client.once(event, done);
    client.once('error-msg', error);
  });
}
async function ask(client, event, response, data) {
  const result = packet(client, response);
  client.emit(event, data);
  return result;
}
async function open(name) {
  const client = connect(base, { auth: { name }, transports: ['websocket'], forceNew: true, reconnection: false });
  clients.push(client);
  await new Promise((resolve, reject) => { client.once('connect', resolve); client.once('connect_error', reject); });
  return client;
}
const ack = (client, event, data = {}) => new Promise((resolve, reject) => client.timeout(5000).emit(event, data, (err, result) => err ? reject(err) : resolve(result)));
const barrier = client => new Promise((resolve, reject) => client.timeout(5000).emit('test-barrier', {}, (err, result) => err ? reject(err) : resolve(result)));
const tables = ['users', 'user_signing_keys', 'channels', 'channel_members', 'messages', 'read_positions', 'thread_reads'];

for (const backend of ['sqlite', 'postgres']) {
  test(backend + ' DM key reads and message read positions', {
    skip: backend === 'postgres' && !process.env.HAVEN_TEST_POSTGRES_URL,
  }, async t => {
    db.prepare('DELETE FROM messages WHERE id > ?').run(baselineMessageId);
    const fixture = backend === 'postgres' ? await createPostgresFixture(db, tables) : null;
    const driver = fixture ? fixture.db : sqliteAsync;
    if (fixture) {
      await driver.exec('CREATE UNIQUE INDEX metadata_thread_read_key ON thread_reads (user_id, thread_id); CREATE UNIQUE INDEX metadata_read_position_key ON read_positions (user_id, channel_id); ALTER TABLE user_signing_keys ADD COLUMN insertion_id BIGINT');
      // Test fixtures preserve source rowids, not a production data migration.
      for (const row of db.prepare('SELECT rowid, user_id, fp FROM user_signing_keys').all()) {
        await driver.prepare('UPDATE user_signing_keys SET insertion_id = ? WHERE user_id = ? AND fp = ?').run(row.rowid, row.user_id, row.fp);
      }
    }
    db.async = driver;
    const alice = await open('alice'), bob = await open('bob'), admin = await open('admin');
    t.after(async () => {
      [alice, bob, admin].forEach(client => client.disconnect());
      db.async = sqliteAsync;
      if (fixture) await fixture.close();
    });
    const clear = () => driver.prepare('DELETE FROM read_positions').run();
    const cursor = (user, room) => driver.prepare('SELECT last_read_message_id FROM read_positions WHERE user_id = ? AND channel_id = ?').get(users[user], rooms[room].id);

    await t.test('public keys and private backups keep their original payload and account boundaries', async st => {
      if (fixture) st.mock.method(db, 'prepare', () => { throw new Error('Legacy SQLite key read reached'); });
      assert.deepEqual(await ask(alice, 'get-public-key', 'public-key-result', { userId: String(users.bob) }), { userId: users.bob, jwk: key('public-bob') });
      assert.deepEqual(await ask(alice, 'get-public-key', 'public-key-result', { userId: 99999 }), { userId: 99999, jwk: null });
      const backup = await ask(alice, 'get-encrypted-key', 'encrypted-key-result', { userId: users.bob });
      assert.deepEqual(backup, {
        encryptedKey: 'alice-encrypted-backup', salt: 'alice-salt', hasPublicKey: true,
        publicKey: key('public-alice'), signingKey: sign, signingBackup: 'alice-signing-backup', state: 'present',
      });
      assert.deepEqual(await ask(admin, 'get-encrypted-key', 'encrypted-key-result'), {
        encryptedKey: null, salt: null, hasPublicKey: false, publicKey: null, signingKey: null, signingBackup: null, state: 'empty',
      });
    });
    await t.test('signing history returns the newest 50 insertions, independently of clock and fingerprint order', async st => {
      if (fixture) st.mock.method(db, 'prepare', () => { throw new Error('Legacy SQLite key read reached'); });
      const result = await ask(alice, 'get-signing-key', 'signing-key-result', { userId: users.bob });
      assert.deepEqual(result, { userId: users.bob, jwk: key('signing-54'), keys: history.slice(-50).reverse() });
      assert.deepEqual(await ask(alice, 'get-signing-key', 'signing-key-result', { userId: 99999 }), { userId: 99999, jwk: null, keys: [] });
    });
    await t.test('current signing key and history come from one snapshot during a rotation', async st => {
      const prepare = driver.prepare.bind(driver);
      const rotated = key('rotated-during-read');
      let injected = false;
      st.mock.method(driver, 'prepare', sql => {
        const statement = prepare(sql);
        if (!sql.includes('signing_key')) return statement;
        return Object.fromEntries(['get', 'all', 'run'].map(method => [method, async (...params) => {
          const value = await statement[method](...params);
          if (!injected) {
            injected = true;
            await prepare('UPDATE users SET signing_key = ? WHERE id = ?').run(JSON.stringify(rotated), users.bob);
            if (fixture) {
              await prepare('INSERT INTO user_signing_keys (user_id, fp, jwk, insertion_id) VALUES (?, ?, ?, ?)').run(users.bob, 'snapshot-key', JSON.stringify(rotated), 5000);
            } else {
              await prepare('INSERT INTO user_signing_keys (user_id, fp, jwk) VALUES (?, ?, ?)').run(users.bob, 'snapshot-key', JSON.stringify(rotated));
            }
          }
          return value;
        }]));
      });
      try {
        const result = await ask(alice, 'get-signing-key', 'signing-key-result', { userId: users.bob });
        assert.equal(injected, true);
        assert.deepEqual(result, { userId: users.bob, jwk: key('signing-54'), keys: history.slice(-50).reverse() });
      } finally {
        await prepare('UPDATE users SET signing_key = ? WHERE id = ?').run(JSON.stringify(key('signing-54')), users.bob);
        await prepare('DELETE FROM user_signing_keys WHERE user_id = ? AND fp = ?').run(users.bob, 'snapshot-key');
      }
    });
    await t.test('key queries await delayed rows and never emit unresolved promises', async st => {
      const prepare = driver.prepare.bind(driver);
      let queries = 0;
      st.mock.method(driver, 'prepare', sql => Object.fromEntries(['get', 'all', 'run'].map(method => [method, async (...params) => {
        await nextTurn(); queries++;
        return prepare(sql)[method](...params);
      }])));
      assert.deepEqual((await ask(alice, 'get-public-key', 'public-key-result', { userId: users.bob })).jwk, key('public-bob'));
      assert.equal((await ask(alice, 'get-encrypted-key', 'encrypted-key-result')).encryptedKey, 'alice-encrypted-backup');
      assert.equal((await ask(alice, 'get-signing-key', 'signing-key-result', { userId: users.bob })).keys.length, 50);
      assert.equal(queries, 3);
    });
    await t.test('failed key reads report failure instead of pretending a key or backup is missing', async st => {
      st.mock.method(console, 'error', () => {});
      const unavailable = st.mock.method(driver, 'prepare', () => ({
        async get() { throw new Error('backend unavailable'); },
        async all() { throw new Error('backend unavailable'); },
      }));
      await assert.rejects(ask(alice, 'get-public-key', 'public-key-result', { userId: users.bob }), /Failed to get public key/);
      await assert.rejects(ask(alice, 'get-signing-key', 'signing-key-result', { userId: users.bob }), /Failed to get signing key/);
      assert.equal((await ask(alice, 'get-encrypted-key', 'encrypted-key-result')).state, 'error');
      unavailable.mock.restore();
      const prepare = driver.prepare.bind(driver);
      st.mock.method(driver, 'prepare', sql => sql.includes('FROM user_signing_keys')
        ? { async all() { throw new Error('history unavailable'); } } : prepare(sql));
      await assert.rejects(ask(alice, 'get-signing-key', 'signing-key-result', { userId: users.bob }), /Failed to get signing key/);
    });
    await t.test('malformed stored key JSON uses the existing backup error state', async st => {
      st.mock.method(console, 'error', () => {});
      await driver.prepare("UPDATE users SET signing_key = 'broken-json' WHERE id = ?").run(users.alice);
      try { assert.equal((await ask(alice, 'get-encrypted-key', 'encrypted-key-result')).state, 'error'); }
      finally { await driver.prepare('UPDATE users SET signing_key = ? WHERE id = ?').run(JSON.stringify(sign), users.alice); }
    });
    await t.test('room and DM receipts are membership-bound and never move backwards', async st => {
      await clear();
      if (fixture) st.mock.method(db, 'prepare', () => { throw new Error('Legacy SQLite receipt read reached'); });
      for (const room of ['room', 'dm']) {
        alice.emit('mark-read', { code: rooms[room].code, messageId: 20 });
        alice.emit('mark-read', { code: rooms[room].code, messageId: 3 });
        await barrier(alice);
        assert.deepEqual(await cursor('alice', room), { last_read_message_id: 20 });
        assert.equal(await cursor('bob', room), undefined);
      }
      bob.emit('mark-read', { code: rooms.private.code, messageId: 100 });
      admin.emit('mark-read', { code: rooms.room.code, messageId: 100 });
      await barrier(bob); await barrier(admin);
      assert.equal(await cursor('bob', 'private'), undefined);
      assert.equal(await cursor('admin', 'room'), undefined, 'admin is not a substitute for membership');
    });
    await t.test('a stored receipt reaches every device of that account and nobody else', async () => {
      await clear();
      const second = await open('alice');
      const seen = { alice: [], second: [], bob: [] };
      const watch = [[alice, seen.alice], [second, seen.second], [bob, seen.bob]].map(([client, list]) => {
        const listener = data => list.push({ channelCode: data.channelCode, messageId: data.messageId });
        client.on('channel-read', listener);
        return () => client.off('channel-read', listener);
      });
      // A barrier answered on a socket comes after anything the server sent it
      // before, so nothing is left in flight when the lists are read.
      const settle = async () => { await barrier(alice); await barrier(second); await barrier(bob); };
      try {
        alice.emit('mark-read', { code: rooms.room.code, messageId: roomLast });
        await settle();
        const expected = [{ channelCode: rooms.room.code, messageId: roomLast }];
        assert.deepEqual(seen.alice, expected, 'the device that read it is told too');
        assert.deepEqual(seen.second, expected, 'the account\'s other device is told');
        assert.deepEqual(seen.bob, [], 'another account is never told');

        // A receipt the server refused (not a member) tells nobody.
        for (const list of Object.values(seen)) list.length = 0;
        bob.emit('mark-read', { code: rooms.private.code, messageId: 100 });
        alice.emit('mark-read', { code: "bad';--", messageId: 40 });
        await settle();
        assert.deepEqual([seen.alice, seen.second, seen.bob], [[], [], []]);

        // Marking a whole channel read reports the latest top-level message.
        alice.emit('mark-read-channel', { code: rooms.dm.code });
        await settle();
        assert.deepEqual(seen.second, [{ channelCode: rooms.dm.code, messageId: dmLast }]);
        assert.deepEqual(seen.bob, []);

        // An empty channel stays unread, so there is nothing to clear.
        for (const list of Object.values(seen)) list.length = 0;
        alice.emit('mark-read-channel', { code: rooms.empty.code });
        await settle();
        assert.deepEqual(seen.second, []);

        // Mark everything read: one entry per channel that has messages.
        for (const list of Object.values(seen)) list.length = 0;
        await ack(alice, 'mark-all-read');
        await settle();
        const byCode = Object.fromEntries(seen.second.map(read => [read.channelCode, read.messageId]));
        assert.equal(byCode[rooms.room.code], roomLast);
        assert.equal(byCode[rooms.dm.code], dmLast);
        assert.equal(rooms.empty.code in byCode, false);
        assert.equal(rooms.threadOnly.code in byCode, false);
        assert.deepEqual(seen.alice, seen.second);
        assert.deepEqual(seen.bob, []);
      } finally {
        watch.forEach(stop => stop());
        second.disconnect();
      }
    });
    await t.test('marking a whole room or DM excludes thread replies and leaves empty channels alone', async () => {
      await clear();
      for (const [room, latest] of [['room', roomLast], ['dm', dmLast]]) {
        alice.emit('mark-read-channel', { code: rooms[room].code });
        await barrier(alice);
        assert.deepEqual(await cursor('alice', room), { last_read_message_id: latest });
      }
      for (const room of ['empty', 'threadOnly']) {
        alice.emit('mark-read-channel', { code: rooms[room].code });
        await barrier(alice);
        assert.equal(await cursor('alice', room), undefined);
      }
      bob.emit('mark-read-channel', { code: rooms.private.code });
      await barrier(bob);
      assert.equal(await cursor('bob', 'private'), undefined);
    });
    await t.test('invalid receipt inputs retain the existing silent refusals', async () => {
      await clear();
      for (const messageId of [0, -1, '22', null, 1.5]) alice.emit('mark-read', { code: rooms.dm.code, messageId });
      alice.emit('mark-read', { code: "bad';--", messageId: 40 });
      await barrier(alice);
      assert.equal(await cursor('alice', 'room'), undefined);
      assert.equal(await cursor('alice', 'dm'), undefined);
    });
    await t.test('concurrent receipts from two devices keep the greatest marker', async () => {
      await clear();
      const second = await open('alice');
      try {
        for (const [client, id] of [[alice, 50], [second, 15], [alice, 35], [second, 80]]) client.emit('mark-read', { code: rooms.room.code, messageId: id });
        await barrier(alice); await barrier(second);
        assert.deepEqual(await cursor('alice', 'room'), { last_read_message_id: 80 });
      } finally { second.disconnect(); }
    });
    for (const event of ['mark-read', 'mark-read-channel']) {
      await t.test(event + ' rechecks membership inside the write when removal happens during a delayed query', async st => {
        await clear();
        const prepare = driver.prepare.bind(driver);
        let release, started, completed;
        const gate = new Promise(resolve => { release = resolve; });
        const reached = new Promise(resolve => { started = resolve; });
        const done = new Promise(resolve => { completed = resolve; });
        st.mock.method(driver, 'prepare', sql => {
          const statement = prepare(sql);
          if (!sql.includes('INSERT INTO read_positions')) return statement;
          return { ...statement, async run(...params) {
            started(); await gate;
            try { return await statement.run(...params); }
            finally { completed(); }
          } };
        });
        alice.emit(event, { code: rooms.room.code, messageId: roomLast });
        await reached;
        try {
          await prepare('DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?').run(rooms.room.id, users.alice);
          release();
          await done;
          assert.equal(await cursor('alice', 'room'), undefined);
        } finally {
          release();
          await prepare('INSERT INTO channel_members (channel_id, user_id) VALUES (?, ?)').run(rooms.room.id, users.alice);
        }
      });
    }
    await t.test('receipt failures are caught and a later receipt still succeeds', async st => {
      await clear();
      st.mock.method(console, 'error', () => {});
      const prepare = driver.prepare.bind(driver);
      const mock = st.mock.method(driver, 'prepare', sql => sql.includes('INSERT INTO read_positions')
        ? { async run() { throw new Error('backend unavailable'); } } : prepare(sql));
      alice.emit('mark-read', { code: rooms.room.code, messageId: roomLast });
      alice.emit('mark-read-channel', { code: rooms.dm.code });
      await barrier(alice);
      mock.mock.restore();
      assert.equal(await cursor('alice', 'room'), undefined);
      assert.equal(await cursor('alice', 'dm'), undefined);
      alice.emit('mark-read', { code: rooms.room.code, messageId: roomLast });
      await barrier(alice);
      assert.deepEqual(await cursor('alice', 'room'), { last_read_message_id: roomLast });
    });
    await t.test('mark-all-read covers every joined room and DM, excludes replies, and preserves its channel count', async () => {
      await clear();
      await driver.prepare('INSERT INTO read_positions (user_id, channel_id, last_read_message_id) VALUES (?, ?, ?)').run(users.alice, rooms.zero.id, 500);
      assert.deepEqual(await ack(alice, 'mark-all-read'), { ok: true, channels: 5 });
      for (const [room, latest] of [['room', roomLast], ['dm', dmLast], ['private', privatePost], ['forum', forumEmpty], ['zero', 500]]) {
        assert.deepEqual(await cursor('alice', room), { last_read_message_id: latest });
      }
      for (const room of ['empty', 'threadOnly', 'emptyForum']) assert.equal(await cursor('alice', room), undefined);
      assert.deepEqual(await ack(bob, 'mark-all-read'), { ok: true, channels: 2 });
      assert.equal(await cursor('bob', 'private'), undefined);
      assert.deepEqual(await ack(admin, 'mark-all-read'), { ok: true, channels: 0 });
      await driver.prepare('UPDATE read_positions SET last_read_message_id = 9000 WHERE user_id = ? AND channel_id = ?').run(users.alice, rooms.room.id);
      assert.deepEqual(await ack(alice, 'mark-all-read'), { ok: true, channels: 5 });
      assert.equal((await cursor('alice', 'room')).last_read_message_id, 9000);
    });
    await t.test('a failed mark-all-read rolls back the entire batch and acknowledges the failure', async st => {
      await clear();
      st.mock.method(console, 'error', () => {});
      if (fixture) {
        await driver.exec(`CREATE FUNCTION refuse_metadata_cursor() RETURNS TRIGGER LANGUAGE plpgsql AS $$
          BEGIN IF NEW.channel_id = ${rooms.dm.id} THEN RAISE EXCEPTION 'receipt test failure'; END IF; RETURN NEW; END $$;
          CREATE TRIGGER refuse_metadata_cursor BEFORE INSERT ON read_positions FOR EACH ROW EXECUTE FUNCTION refuse_metadata_cursor();`);
      } else {
        db.exec(`CREATE TEMP TRIGGER refuse_metadata_cursor BEFORE INSERT ON read_positions
          WHEN NEW.channel_id = ${rooms.dm.id} BEGIN SELECT RAISE(ABORT, 'receipt test failure'); END;`);
      }
      try {
        assert.deepEqual(await ack(alice, 'mark-all-read'), { error: 'Could not mark everything read' });
        assert.equal((await driver.prepare('SELECT COUNT(*) AS n FROM read_positions').get()).n, 0);
      } finally {
        if (fixture) await driver.exec('DROP TRIGGER refuse_metadata_cursor ON read_positions; DROP FUNCTION refuse_metadata_cursor()');
        else db.exec('DROP TRIGGER refuse_metadata_cursor');
      }
      assert.deepEqual(await ack(alice, 'mark-all-read'), { ok: true, channels: 5 });
    });
    await t.test('two devices marking all read cannot lower an existing cursor', async () => {
      await clear();
      const peer = await open('alice');
      try {
        alice.emit('mark-read', { code: rooms.room.code, messageId: 9000 });
        await barrier(alice);
        assert.deepEqual(await Promise.all([ack(alice, 'mark-all-read'), ack(peer, 'mark-all-read')]), [
          { ok: true, channels: 5 }, { ok: true, channels: 5 },
        ]);
        assert.equal((await cursor('alice', 'room')).last_read_message_id, 9000);
      } finally { peer.disconnect(); }
    });
    const threadCursor = (user, parent) => driver.prepare('SELECT last_read_reply_id FROM thread_reads WHERE user_id = ? AND thread_id = ?').get(users[user], parent);
    await t.test('forum receipts cover its topics, including no replies, and notify every device of this account', async () => {
      await driver.prepare('DELETE FROM thread_reads').run();
      const peer = await open('alice');
      let other = 0;
      const onOther = () => other++;
      bob.on('forum-read', onOther);
      try {
        const selfRead = packet(alice, 'forum-read'), peerRead = packet(peer, 'forum-read');
        alice.emit('mark-forum-read', { code: ' ' + rooms.forum.code + ' ' });
        assert.deepEqual(await selfRead, { channelCode: rooms.forum.code });
        assert.deepEqual(await peerRead, { channelCode: rooms.forum.code });
        assert.deepEqual(await threadCursor('alice', forumFirst), { last_read_reply_id: forumReply });
        assert.deepEqual(await threadCursor('alice', forumEmpty), { last_read_reply_id: 0 });
        assert.equal(await threadCursor('alice', forumReply), undefined, 'a reply is not a topic');
        assert.equal(other, 0);
        await driver.prepare('UPDATE thread_reads SET last_read_reply_id = 9000 WHERE user_id = ? AND thread_id = ?').run(users.alice, forumFirst);
        await ask(alice, 'mark-forum-read', 'forum-read', { code: rooms.forum.code });
        assert.equal((await threadCursor('alice', forumFirst)).last_read_reply_id, 9000);
        assert.deepEqual(await ask(alice, 'mark-forum-read', 'forum-read', { code: rooms.emptyForum.code }), { channelCode: rooms.emptyForum.code });
      } finally { bob.off('forum-read', onOther); peer.disconnect(); }
    });
    await t.test('forum receipts refuse nonmembers and non-forums while keeping the admin exemption', async () => {
      await driver.prepare('DELETE FROM thread_reads').run();
      bob.emit('mark-forum-read', { code: rooms.forum.code });
      alice.emit('mark-forum-read', { code: rooms.room.code });
      alice.emit('mark-forum-read', { code: "bad';--" });
      await barrier(bob); await barrier(alice);
      assert.equal((await driver.prepare('SELECT COUNT(*) AS n FROM thread_reads').get()).n, 0);
      await ask(admin, 'mark-forum-read', 'forum-read', { code: rooms.forum.code });
      assert.equal((await threadCursor('admin', forumFirst)).last_read_reply_id, forumReply);
    });
    await t.test('thread receipts notify the other devices, retain the greatest reply, and handle an empty topic', async () => {
      await driver.prepare('DELETE FROM thread_reads').run();
      const peer = await open('alice');
      let own = 0, other = 0;
      const onOwn = () => own++, onOther = () => other++;
      alice.on('thread-read', onOwn); bob.on('thread-read', onOther);
      try {
        const heard = packet(peer, 'thread-read');
        alice.emit('mark-thread-read', { parentId: forumFirst });
        assert.deepEqual(await heard, { channelCode: rooms.forum.code, parentId: forumFirst });
        assert.equal((await threadCursor('alice', forumFirst)).last_read_reply_id, forumReply);
        assert.equal(own, 0); assert.equal(other, 0);
        await driver.prepare('UPDATE thread_reads SET last_read_reply_id = 9000 WHERE user_id = ? AND thread_id = ?').run(users.alice, forumFirst);
        const repeated = packet(peer, 'thread-read');
        alice.emit('mark-thread-read', { parentId: forumFirst });
        await repeated;
        assert.equal((await threadCursor('alice', forumFirst)).last_read_reply_id, 9000);
        const empty = packet(peer, 'thread-read');
        alice.emit('mark-thread-read', { parentId: forumEmpty });
        await empty;
        assert.equal((await threadCursor('alice', forumEmpty)).last_read_reply_id, 0);
      } finally { alice.off('thread-read', onOwn); bob.off('thread-read', onOther); peer.disconnect(); }
    });
    await t.test('thread receipts refuse nonmembers, reply ids and invalid inputs while admins may mark a nonjoined thread', async () => {
      await driver.prepare('DELETE FROM thread_reads').run();
      bob.emit('mark-thread-read', { parentId: privatePost });
      for (const parentId of [forumReply, 999999, String(forumFirst), 1.5, null]) alice.emit('mark-thread-read', { parentId });
      await barrier(bob); await barrier(alice);
      assert.equal((await driver.prepare('SELECT COUNT(*) AS n FROM thread_reads').get()).n, 0);
      admin.emit('mark-thread-read', { parentId: forumFirst });
      await barrier(admin);
      assert.equal((await threadCursor('admin', forumFirst)).last_read_reply_id, forumReply);
    });
    for (const [event, method, data] of [
      ['mark-forum-read', 'run', { code: rooms.forum.code }],
      ['mark-thread-read', 'get', { parentId: forumFirst }],
    ]) {
      await t.test(event + ' checks membership when its delayed write executes', async st => {
        await driver.prepare('DELETE FROM thread_reads').run();
        const prepare = driver.prepare.bind(driver);
        let release, started;
        const gate = new Promise(resolve => { release = resolve; });
        const reached = new Promise(resolve => { started = resolve; });
        st.mock.method(driver, 'prepare', sql => {
          const statement = prepare(sql);
          if (!sql.includes('INSERT INTO thread_reads')) return statement;
          return { ...statement, async [method](...params) {
            started(); await gate;
            return statement[method](...params);
          } };
        });
        alice.emit(event, data);
        await reached;
        try {
          await prepare('DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?').run(rooms.forum.id, users.alice);
          release();
          await barrier(alice);
          assert.equal(await threadCursor('alice', forumFirst), undefined);
          assert.equal(await threadCursor('alice', forumEmpty), undefined);
        } finally {
          release();
          await prepare('INSERT INTO channel_members (channel_id, user_id) VALUES (?, ?)').run(rooms.forum.id, users.alice);
        }
      });
    }
    await t.test('thread read state keeps membership, unread zeroes and its original response shape', async st => {
      await driver.prepare('DELETE FROM thread_reads').run();
      if (fixture) st.mock.method(db, 'prepare', () => { throw new Error('Legacy SQLite thread lookup reached'); });
      assert.deepEqual(await ack(alice, 'get-thread-read-state', { parentIds: [forumFirst, forumEmpty, forumReply, 999999, forumFirst, '1', null, -1] }), {
        reads: { [forumFirst]: 0, [forumEmpty]: 0 },
      });
      alice.emit('mark-thread-read', { parentId: forumFirst });
      await barrier(alice);
      assert.deepEqual(await ack(alice, 'get-thread-read-state', { parentIds: [forumFirst] }), { reads: { [forumFirst]: forumReply } });
      assert.deepEqual(await ack(bob, 'get-thread-read-state', { parentIds: [forumFirst, privatePost] }), { reads: {} });
      assert.deepEqual(await ack(admin, 'get-thread-read-state', { parentIds: [forumFirst] }), { reads: {} }, 'admin still needs membership for this lookup');
      assert.deepEqual(await ack(alice, 'get-thread-read-state', {}), { reads: {} });
    });
    await t.test('thread read state caps a deduplicated request at 200 parents', async () => {
      const ids = Array.from({ length: 205 }, (_, i) => 100000 + i);
      for (const id of ids) await driver.prepare('INSERT INTO messages (id, channel_id, user_id, content) VALUES (?, ?, ?, ?)').run(id, rooms.room.id, users.alice, 'remembered thread');
      try {
        const result = await ack(alice, 'get-thread-read-state', { parentIds: [ids[0], ...ids] });
        assert.deepEqual(Object.keys(result.reads).map(Number), ids.slice(0, 200));
      } finally { await driver.prepare('DELETE FROM messages WHERE id >= ?').run(ids[0]); }
    });
    await t.test('failed thread read-state lookups retain the empty response instead of leaking unread data', async st => {
      st.mock.method(console, 'warn', () => {});
      const prepare = driver.prepare.bind(driver);
      st.mock.method(driver, 'prepare', sql => sql.includes('COALESCE(tr.last_read_reply_id')
        ? { async all() { throw new Error('backend unavailable'); } } : prepare(sql));
      assert.deepEqual(await ack(alice, 'get-thread-read-state', { parentIds: [forumFirst] }), { reads: {} });
    });
    await t.test('actual room, encrypted-DM and slash-command sends advance the sender cursor', async () => {
      await clear();
      for (const [room, content] of [
        ['room', 'hello from a room'],
        ['dm', JSON.stringify({ v: 1, iv: 'opaque-iv', ct: 'opaque-ciphertext' })],
        ['room', '/me waves'],
      ]) {
        const before = immediateMarkers.length;
        const sent = await ask(alice, 'send-message', 'new-message', { code: rooms[room].code, content, encrypted: room === 'dm' });
        await barrier(alice);
        assert.deepEqual(await cursor('alice', room), { last_read_message_id: sent.message.id });
        assert.equal(db.prepare('SELECT content FROM messages WHERE id = ?').get(sent.message.id).content, sent.message.content);
        if (!fixture) assert.equal(immediateMarkers[before], sent.message.id, 'SQLite marker is stored before the event handler yields');
      }
    });
    await t.test('failure of a post-send marker does not undo or suppress the message', async st => {
      await clear();
      const prepare = driver.prepare.bind(driver);
      st.mock.method(driver, 'prepare', sql => sql.includes('INSERT INTO read_positions')
        ? { async run() { throw new Error('marker unavailable'); } } : prepare(sql));
      const sent = await ask(alice, 'send-message', 'new-message', { code: rooms.room.code, content: 'still delivered' });
      await barrier(alice);
      assert.equal(db.prepare('SELECT content FROM messages WHERE id = ?').get(sent.message.id).content, 'still delivered');
      assert.equal(await cursor('alice', 'room'), undefined);
    });
  });
}
