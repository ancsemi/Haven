'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const test = require('node:test');
const Database = require('better-sqlite3');
const WebSocket = require('ws');

async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForServer(url, child, output) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited early:\n${output()}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Server did not become ready:\n${output()}`);
}

function connectChannelSocket(baseUrl, token, channelCode) {
  const socketUrl = baseUrl.replace(/^http/, 'ws') + '/socket.io/?EIO=4&transport=websocket';
  const ws = new WebSocket(socketUrl);
  const events = [];
  const waiters = [];

  function pushEvent(event, payload) {
    events.push({ event, payload });
    for (let index = waiters.length - 1; index >= 0; index--) {
      const waiter = waiters[index];
      if (waiter.event !== event || !waiter.predicate(payload)) continue;
      waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(payload);
    }
  }

  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out joining Socket.IO channel')), 5000);
    ws.on('message', raw => {
      const packet = raw.toString();
      if (packet === '2') return ws.send('3');
      if (packet.startsWith('0')) {
        ws.send(`40${JSON.stringify({ token })}`);
        return;
      }
      if (packet.startsWith('44')) {
        clearTimeout(timer);
        reject(new Error(`Socket.IO authentication failed: ${packet}`));
        return;
      }
      if (packet.startsWith('40')) {
        ws.send(`42${JSON.stringify(['join-channel', { code: channelCode }])}`);
        return;
      }
      if (!packet.startsWith('42')) return;
      const [event, payload] = JSON.parse(packet.slice(2));
      pushEvent(event, payload);
      if (event === 'channel-joined' && payload?.code === channelCode) {
        clearTimeout(timer);
        resolve();
      }
    });
    ws.once('error', reject);
  });

  function waitFor(event, predicate = () => true, timeoutMs = 3000) {
    const existing = events.find(item => item.event === event && predicate(item.payload));
    if (existing) return Promise.resolve(existing.payload);
    return new Promise((resolve, reject) => {
      const waiter = { event, predicate, resolve, timer: null };
      waiter.timer = setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index !== -1) waiters.splice(index, 1);
        reject(new Error(`Timed out waiting for ${event}`));
      }, timeoutMs);
      waiters.push(waiter);
    });
  }

  function checkpoint() {
    return events.length;
  }

  function eventsSince(index, event) {
    return events.slice(index)
      .filter(item => item.event === event)
      .map(item => item.payload);
  }

  return { ws, ready, waitFor, checkpoint, eventsSince };
}

test('webhook bulk delete enforces moderation and cleans related data end to end', async t => {
  const root = path.resolve(__dirname, '..');
  const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'haven-webhook-bulk-delete-'));
  const modToken = 'm'.repeat(64);
  const noModToken = 'n'.repeat(64);
  const port = await availablePort();
  const env = {
    ...process.env,
    HAVEN_DATA_DIR: dataDir,
    FORCE_HTTP: 'true',
    HOST: '127.0.0.1',
    JWT_SECRET: 'b'.repeat(64),
    PORT: String(port)
  };

  const seed = spawnSync(process.execPath, ['-e', `
    const fs = require('fs');
    const path = require('path');
    const jwt = require('jsonwebtoken');
    const { initDatabase } = require('./src/database');
    const db = initDatabase();
    const user = db.prepare("INSERT INTO users (username, password_hash, display_name, is_admin) VALUES ('owner', 'x', 'Owner', 1)").run();
    const otherUser = db.prepare("INSERT INTO users (username, password_hash, display_name) VALUES ('other', 'x', 'Other')").run();
    db.prepare("UPDATE users SET avatar = '/UPLOADS/%61vatar-protected.txt' WHERE id = ?").run(user.lastInsertRowid);
    const channel = db.prepare("INSERT INTO channels (name, code, created_by, is_dm) VALUES ('Bots', 'abcd1234', ?, 0)").run(user.lastInsertRowid);
    const otherChannel = db.prepare("INSERT INTO channels (name, code, created_by, is_dm) VALUES ('Other', 'abcd5678', ?, 0)").run(user.lastInsertRowid);
    const dmChannel = db.prepare("INSERT INTO channels (name, code, created_by, is_dm) VALUES ('DM', 'abcd9012', ?, 1)").run(user.lastInsertRowid);
    db.prepare('INSERT INTO channel_members (channel_id, user_id) VALUES (?, ?)').run(channel.lastInsertRowid, user.lastInsertRowid);
    db.prepare('INSERT INTO channel_members (channel_id, user_id) VALUES (?, ?)').run(otherChannel.lastInsertRowid, user.lastInsertRowid);
    db.prepare('INSERT INTO webhooks (channel_id, name, token, created_by, can_moderate) VALUES (?, ?, ?, ?, 1)').run(channel.lastInsertRowid, 'Mod Bot', '${modToken}', user.lastInsertRowid);
    db.prepare('INSERT INTO webhooks (channel_id, name, token, created_by, can_moderate) VALUES (?, ?, ?, ?, 0)').run(channel.lastInsertRowid, 'Plain Bot', '${noModToken}', user.lastInsertRowid);

    const insertMessage = db.prepare('INSERT INTO messages (channel_id, user_id, content, created_at) VALUES (?, ?, ?, ?)');
    const survivorShared = insertMessage.run(channel.lastInsertRowid, user.lastInsertRowid, 'keep /uploads/local-shared.txt', '2026-01-01 00:00:00');
    const survivorPlain = insertMessage.run(channel.lastInsertRowid, user.lastInsertRowid, 'keep this too', '2026-01-02 00:00:00');
    const parent = insertMessage.run(
      channel.lastInsertRowid,
      user.lastInsertRowid,
      'remove /uploads/local-shared.txt /uploads/global-shared.txt /uploads/slash-shared.txt /uploads/dot-shared.txt /uploads/windows-shared.txt /uploads/../escape-victim.txt /uploads/avatar-protected.txt /uploads/protected.mp3 /uploads/private.txt /uploads/dm-edited.txt',
      '2026-01-03 00:00:00'
    );
    const threadReply = db.prepare('INSERT INTO messages (channel_id, user_id, content, thread_id, reply_to, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      channel.lastInsertRowid,
      user.lastInsertRowid,
      'reply /uploads/orphan.txt',
      parent.lastInsertRowid,
      parent.lastInsertRowid,
      '2026-01-03 00:01:00'
    );
    const inlineReply = db.prepare('INSERT INTO messages (channel_id, user_id, content, reply_to, created_at) VALUES (?, ?, ?, ?, ?)').run(
      channel.lastInsertRowid,
      user.lastInsertRowid,
      'inline reply /uploads/inline-orphan.txt',
      parent.lastInsertRowid,
      '2019-01-01 00:00:00'
    );
    const importedOld = insertMessage.run(channel.lastInsertRowid, user.lastInsertRowid, 'imported old message', '2020-01-01 00:00:00');
    const windowsAlias = '/uploads/folder' + String.fromCharCode(92) + '..' + String.fromCharCode(92) + 'windows-shared.txt';
    const external = insertMessage.run(otherChannel.lastInsertRowid, user.lastInsertRowid, 'other /UPLOADS/%67lobal-shared.txt /uploads//slash-shared.txt /uploads/folder/../dot-shared.txt ' + windowsAlias, '2026-01-04 00:00:00');
    db.prepare("INSERT INTO messages (channel_id, user_id, content, created_at, edited_at) VALUES (?, ?, 'encrypted payload', '2010-01-01 00:00:00', '2019-01-01 00:00:00')").run(dmChannel.lastInsertRowid, user.lastInsertRowid);
    db.prepare("INSERT INTO messages (channel_id, user_id, content, created_at) VALUES (?, ?, 'unrelated encrypted payload', '2026-06-01 00:00:00')").run(dmChannel.lastInsertRowid, otherUser.lastInsertRowid);

    const addReaction = db.prepare("INSERT INTO reactions (message_id, user_id, emoji) VALUES (?, ?, 'ok')");
    const addPin = db.prepare('INSERT INTO pinned_messages (message_id, channel_id, pinned_by) VALUES (?, ?, ?)');
    for (const id of [parent.lastInsertRowid, threadReply.lastInsertRowid, inlineReply.lastInsertRowid]) {
      addReaction.run(id, user.lastInsertRowid);
      addPin.run(id, channel.lastInsertRowid, user.lastInsertRowid);
    }
    db.prepare('INSERT INTO custom_sounds (name, filename, uploaded_by) VALUES (?, ?, ?)').run('Protected', 'protected.mp3', user.lastInsertRowid);
    const ownChannelUpload = db.prepare("INSERT INTO upload_ownership (rel_path, user_id, bytes, scope, created_at) VALUES (?, ?, ?, 'channel', '2020-01-01 00:00:00')");
    for (const relPath of ['local-shared.txt', 'global-shared.txt', 'slash-shared.txt', 'dot-shared.txt', 'windows-shared.txt', 'escape-victim.txt', 'avatar-protected.txt', 'protected.mp3', 'orphan.txt', 'inline-orphan.txt']) {
      ownChannelUpload.run(relPath, user.lastInsertRowid, 7);
    }
    db.prepare("INSERT INTO upload_ownership (rel_path, user_id, bytes, scope, created_at) VALUES (?, ?, ?, 'channel', '2018-01-01 00:00:00')").run('dm-edited.txt', user.lastInsertRowid, 7);
    db.prepare("INSERT INTO upload_ownership (rel_path, user_id, bytes, scope) VALUES (?, ?, ?, 'dm')").run('private.txt', user.lastInsertRowid, 7);

    const uploads = path.join(process.env.HAVEN_DATA_DIR, 'uploads');
    fs.writeFileSync(path.join(uploads, 'local-shared.txt'), 'shared');
    fs.writeFileSync(path.join(uploads, 'global-shared.txt'), 'global');
    fs.writeFileSync(path.join(uploads, 'slash-shared.txt'), 'slash');
    fs.writeFileSync(path.join(uploads, 'dot-shared.txt'), 'dot');
    fs.writeFileSync(path.join(uploads, 'windows-shared.txt'), 'windows');
    fs.writeFileSync(path.join(uploads, 'escape-victim.txt'), 'escape');
    fs.writeFileSync(path.join(uploads, 'avatar-protected.txt'), 'avatar');
    fs.writeFileSync(path.join(uploads, 'orphan.txt'), 'orphan');
    fs.writeFileSync(path.join(uploads, 'inline-orphan.txt'), 'inline');
    fs.writeFileSync(path.join(uploads, 'protected.mp3'), 'sound');
    fs.writeFileSync(path.join(uploads, 'private.txt'), 'private');
    fs.writeFileSync(path.join(uploads, 'dm-edited.txt'), 'dm edited');
    const fixture = {
      humanToken: jwt.sign({ id: Number(user.lastInsertRowid), username: 'owner', pwv: 1 }, process.env.JWT_SECRET),
      survivorShared: Number(survivorShared.lastInsertRowid),
      survivorPlain: Number(survivorPlain.lastInsertRowid),
      parent: Number(parent.lastInsertRowid),
      threadReply: Number(threadReply.lastInsertRowid),
      inlineReply: Number(inlineReply.lastInsertRowid),
      importedOld: Number(importedOld.lastInsertRowid),
      external: Number(external.lastInsertRowid)
    };
    fs.writeFileSync(path.join(process.env.HAVEN_DATA_DIR, 'fixture.json'), JSON.stringify(fixture));
    db.close();
  `], { cwd: root, env, encoding: 'utf8' });
  assert.equal(seed.status, 0, seed.stderr || seed.stdout);

  const fixture = JSON.parse(await fs.promises.readFile(path.join(dataDir, 'fixture.json'), 'utf8'));
  let logs = '';
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', chunk => { logs += chunk; });
  child.stderr.on('data', chunk => { logs += chunk; });
  let socket;
  t.after(async () => {
    socket?.terminate();
    if (child.exitCode === null) child.kill('SIGTERM');
    await Promise.race([
      child.exitCode === null ? new Promise(resolve => child.once('exit', resolve)) : Promise.resolve(),
      new Promise(resolve => setTimeout(resolve, 3000))
    ]);
    if (child.exitCode === null) child.kill('SIGKILL');
    await fs.promises.rm(dataDir, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForServer(`${baseUrl}/api/health`, child, () => logs);
  const channelSocket = connectChannelSocket(baseUrl, fixture.humanToken, 'abcd1234');
  socket = channelSocket.ws;
  await channelSocket.ready;

  const noPermission = await fetch(`${baseUrl}/api/webhooks/${noModToken}/messages?limit=1`, { method: 'DELETE' });
  assert.equal(noPermission.status, 403);
  assert.deepEqual(await noPermission.json(), { error: 'This bot does not have moderation permission' });

  const missingBot = await fetch(`${baseUrl}/api/webhooks/${'x'.repeat(64)}/messages?limit=1`, { method: 'DELETE' });
  assert.equal(missingBot.status, 404);

  for (const query of ['', '?limit=0', '?limit=1.5', '?limit=101', '?limit=abc']) {
    const response = await fetch(`${baseUrl}/api/webhooks/${modToken}/messages${query}`, { method: 'DELETE' });
    assert.equal(response.status, 400, query || 'missing limit');
    assert.match((await response.json()).error, /between 1 and 100/);
  }

  const firstCheckpoint = channelSocket.checkpoint();
  const parentEvent = channelSocket.waitFor(
    'message-deleted',
    payload => payload?.messageId === fixture.parent
  );
  const replyEvent = channelSocket.waitFor(
    'message-deleted',
    payload => payload?.messageId === fixture.threadReply
  );
  const inlineReplyEvent = channelSocket.waitFor(
    'message-deleted',
    payload => payload?.messageId === fixture.inlineReply
  );
  const firstDelete = await fetch(`${baseUrl}/api/webhooks/${modToken}/messages?limit=1`, { method: 'DELETE' });
  assert.equal(firstDelete.status, 200);
  assert.deepEqual(await firstDelete.json(), { success: true, deleted: 3 });
  assert.deepEqual(await Promise.all([parentEvent, replyEvent, inlineReplyEvent]), [
    { channelCode: 'abcd1234', messageId: fixture.parent },
    { channelCode: 'abcd1234', messageId: fixture.threadReply },
    { channelCode: 'abcd1234', messageId: fixture.inlineReply }
  ]);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.deepEqual(
    channelSocket.eventsSince(firstCheckpoint, 'message-deleted').sort((a, b) => a.messageId - b.messageId),
    [
      { channelCode: 'abcd1234', messageId: fixture.parent },
      { channelCode: 'abcd1234', messageId: fixture.threadReply },
      { channelCode: 'abcd1234', messageId: fixture.inlineReply }
    ]
  );

  const db = new Database(path.join(dataDir, 'haven.db'));
  db.pragma('foreign_keys = ON');
  const deletedIds = [fixture.parent, fixture.threadReply, fixture.inlineReply];
  const placeholders = deletedIds.map(() => '?').join(',');
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM messages WHERE id IN (${placeholders})`).get(...deletedIds).count, 0);
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM reactions WHERE message_id IN (${placeholders})`).get(...deletedIds).count, 0);
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM pinned_messages WHERE message_id IN (${placeholders})`).get(...deletedIds).count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages WHERE id IN (?, ?, ?)').get(fixture.survivorShared, fixture.survivorPlain, fixture.importedOld).count, 3);

  const uploads = path.join(dataDir, 'uploads');
  const deletedUploads = path.join(uploads, 'deleted-attachments');
  assert.equal(fs.existsSync(path.join(uploads, 'local-shared.txt')), true);
  assert.equal(fs.existsSync(path.join(deletedUploads, 'local-shared.txt')), false);
  assert.equal(fs.existsSync(path.join(uploads, 'global-shared.txt')), true);
  assert.equal(fs.existsSync(path.join(uploads, 'slash-shared.txt')), true);
  assert.equal(fs.existsSync(path.join(uploads, 'dot-shared.txt')), true);
  assert.equal(fs.existsSync(path.join(uploads, 'windows-shared.txt')), process.platform === 'win32');
  assert.equal(fs.existsSync(path.join(uploads, 'escape-victim.txt')), true);
  assert.equal(fs.existsSync(path.join(uploads, 'avatar-protected.txt')), true);
  assert.equal(fs.existsSync(path.join(uploads, 'orphan.txt')), false);
  assert.equal(fs.existsSync(path.join(deletedUploads, 'orphan.txt')), true);
  assert.equal(fs.existsSync(path.join(uploads, 'inline-orphan.txt')), false);
  assert.equal(fs.existsSync(path.join(deletedUploads, 'inline-orphan.txt')), true);
  assert.equal(fs.existsSync(path.join(uploads, 'protected.mp3')), true);
  assert.equal(fs.existsSync(path.join(uploads, 'private.txt')), true);
  assert.equal(fs.existsSync(path.join(uploads, 'dm-edited.txt')), true);

  const secondCheckpoint = channelSocket.checkpoint();
  const survivorSharedEvent = channelSocket.waitFor(
    'message-deleted',
    payload => payload?.messageId === fixture.survivorShared
  );
  const survivorPlainEvent = channelSocket.waitFor(
    'message-deleted',
    payload => payload?.messageId === fixture.survivorPlain
  );
  const secondDelete = await fetch(`${baseUrl}/api/webhooks/${modToken}/messages?limit=2`, { method: 'DELETE' });
  assert.equal(secondDelete.status, 200);
  assert.deepEqual(await secondDelete.json(), { success: true, deleted: 2 });
  await Promise.all([survivorSharedEvent, survivorPlainEvent]);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.deepEqual(
    channelSocket.eventsSince(secondCheckpoint, 'message-deleted').sort((a, b) => a.messageId - b.messageId),
    [
      { channelCode: 'abcd1234', messageId: fixture.survivorShared },
      { channelCode: 'abcd1234', messageId: fixture.survivorPlain }
    ]
  );

  assert.equal(fs.existsSync(path.join(uploads, 'local-shared.txt')), false);
  assert.equal(fs.existsSync(path.join(deletedUploads, 'local-shared.txt')), true);
  assert.equal(fs.existsSync(path.join(uploads, 'global-shared.txt')), true);
  assert.equal(fs.existsSync(path.join(uploads, 'slash-shared.txt')), true);
  assert.equal(fs.existsSync(path.join(uploads, 'dot-shared.txt')), true);
  assert.equal(fs.existsSync(path.join(uploads, 'windows-shared.txt')), process.platform === 'win32');
  assert.equal(fs.existsSync(path.join(uploads, 'escape-victim.txt')), true);
  assert.equal(fs.existsSync(path.join(uploads, 'avatar-protected.txt')), true);
  assert.equal(fs.existsSync(path.join(uploads, 'protected.mp3')), true);
  assert.equal(fs.existsSync(path.join(uploads, 'private.txt')), true);
  assert.equal(fs.existsSync(path.join(uploads, 'dm-edited.txt')), true);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages WHERE channel_id = (SELECT id FROM channels WHERE code = ?)').get('abcd1234').count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages WHERE id = ?').get(fixture.importedOld).count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages WHERE id = ?').get(fixture.external).count, 1);

  const importedEvent = channelSocket.waitFor(
    'message-deleted',
    payload => payload?.messageId === fixture.importedOld
  );
  const thirdDelete = await fetch(`${baseUrl}/api/webhooks/${modToken}/messages?limit=1`, { method: 'DELETE' });
  assert.equal(thirdDelete.status, 200);
  assert.deepEqual(await thirdDelete.json(), { success: true, deleted: 1 });
  await importedEvent;

  const emptyDelete = await fetch(`${baseUrl}/api/webhooks/${modToken}/messages?limit=1`, { method: 'DELETE' });
  assert.equal(emptyDelete.status, 200);
  assert.deepEqual(await emptyDelete.json(), { success: true, deleted: 0 });

  const userId = db.prepare('SELECT id FROM users WHERE username = ?').get('owner').id;
  const channelId = db.prepare('SELECT id FROM channels WHERE code = ?').get('abcd1234').id;
  const otherChannelId = db.prepare('SELECT id FROM channels WHERE code = ?').get('abcd5678').id;
  fs.writeFileSync(path.join(uploads, 'legacy.txt'), 'legacy');
  const singleMessage = db.prepare(`
    INSERT INTO messages (channel_id, user_id, content, created_at)
    VALUES (?, ?, '/uploads/global-shared.txt /uploads/protected.mp3 /uploads/private.txt /uploads/legacy.txt', '2026-12-01 00:00:00')
  `).run(channelId, userId);
  const singleEvent = channelSocket.waitFor(
    'message-deleted',
    payload => payload?.messageId === Number(singleMessage.lastInsertRowid)
  );
  const singleDelete = await fetch(
    `${baseUrl}/api/webhooks/${noModToken}/messages/${singleMessage.lastInsertRowid}`,
    { method: 'DELETE' }
  );
  assert.equal(singleDelete.status, 200);
  assert.deepEqual(await singleDelete.json(), { success: true });
  await singleEvent;
  assert.equal(fs.existsSync(path.join(uploads, 'global-shared.txt')), false);
  assert.equal(fs.existsSync(path.join(uploads, 'protected.mp3')), false);
  assert.equal(fs.existsSync(path.join(uploads, 'private.txt')), false);
  assert.equal(fs.existsSync(path.join(uploads, 'legacy.txt')), false);

  const crossParent = db.prepare(
    "INSERT INTO messages (channel_id, user_id, content, created_at) VALUES (?, ?, 'cross parent', '2027-01-01 00:00:00')"
  ).run(channelId, userId);
  const crossReply = db.prepare(
    "INSERT INTO messages (channel_id, user_id, content, thread_id, created_at) VALUES (?, ?, 'cross reply', ?, '2027-01-01 00:01:00')"
  ).run(otherChannelId, userId, crossParent.lastInsertRowid);
  const crossCheckpoint = channelSocket.checkpoint();
  const crossDelete = await fetch(`${baseUrl}/api/webhooks/${modToken}/messages?limit=1`, { method: 'DELETE' });
  assert.equal(crossDelete.status, 409);
  assert.deepEqual(await crossDelete.json(), { error: 'Related replies exist in another channel' });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages WHERE id IN (?, ?)').get(crossParent.lastInsertRowid, crossReply.lastInsertRowid).count, 2);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.deepEqual(channelSocket.eventsSince(crossCheckpoint, 'message-deleted'), []);
  db.prepare('DELETE FROM messages WHERE id = ?').run(crossReply.lastInsertRowid);
  db.prepare('DELETE FROM messages WHERE id = ?').run(crossParent.lastInsertRowid);

  const rollbackFirst = db.prepare(
    "INSERT INTO messages (channel_id, user_id, content, created_at) VALUES (?, ?, '/uploads/rollback.txt', '2027-02-01 00:00:00')"
  ).run(channelId, userId);
  const rollbackSecond = db.prepare(
    "INSERT INTO messages (channel_id, user_id, content, created_at) VALUES (?, ?, '/uploads/rollback.txt', '2027-02-02 00:00:00')"
  ).run(channelId, userId);
  for (const id of [rollbackFirst.lastInsertRowid, rollbackSecond.lastInsertRowid]) {
    db.prepare("INSERT INTO reactions (message_id, user_id, emoji) VALUES (?, ?, 'rollback')").run(id, userId);
    db.prepare('INSERT INTO pinned_messages (message_id, channel_id, pinned_by) VALUES (?, ?, ?)').run(id, channelId, userId);
  }
  fs.writeFileSync(path.join(uploads, 'rollback.txt'), 'rollback');
  db.exec(`
    CREATE TRIGGER fail_webhook_bulk_delete
    BEFORE DELETE ON messages
    WHEN OLD.id = ${Number(rollbackFirst.lastInsertRowid)}
    BEGIN
      SELECT RAISE(ABORT, 'blocked by test');
    END
  `);
  const rollbackCheckpoint = channelSocket.checkpoint();
  const rollbackDelete = await fetch(`${baseUrl}/api/webhooks/${modToken}/messages?limit=2`, { method: 'DELETE' });
  assert.equal(rollbackDelete.status, 500);
  assert.deepEqual(await rollbackDelete.json(), { error: 'Failed to delete messages' });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages WHERE id IN (?, ?)').get(rollbackFirst.lastInsertRowid, rollbackSecond.lastInsertRowid).count, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM reactions WHERE message_id IN (?, ?)').get(rollbackFirst.lastInsertRowid, rollbackSecond.lastInsertRowid).count, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM pinned_messages WHERE message_id IN (?, ?)').get(rollbackFirst.lastInsertRowid, rollbackSecond.lastInsertRowid).count, 2);
  assert.equal(fs.existsSync(path.join(uploads, 'rollback.txt')), true);
  assert.equal(fs.existsSync(path.join(deletedUploads, 'rollback.txt')), false);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.deepEqual(channelSocket.eventsSince(rollbackCheckpoint, 'message-deleted'), []);
  db.exec('DROP TRIGGER fail_webhook_bulk_delete');
  db.close();
});
