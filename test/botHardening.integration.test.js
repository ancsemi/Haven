'use strict';

// Bot and webhook hardening end to end: banned creators, creator permissions
// for moderation bots, own-message deletes, avatar URLs, high scores, invite
// links and the Discord emote cache.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const test = require('node:test');
const Database = require('better-sqlite3');

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
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited early:\n${output()}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch { /* not listening yet */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Server did not become ready:\n${output()}`);
}

test('bot and webhook hardening', async t => {
  const root = path.resolve(__dirname, '..');
  const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'haven-bot-hardening-'));
  const tokens = { a: 'a'.repeat(64), b: 'b'.repeat(64), memberMod: 'c'.repeat(64), banned: 'd'.repeat(64), adminMod: 'e'.repeat(64) };
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
    const addUser = (name, admin) => Number(db.prepare("INSERT INTO users (username, password_hash, display_name, is_admin) VALUES (?, 'x', ?, ?)").run(name, name, admin ? 1 : 0).lastInsertRowid);
    const owner = addUser('owner', true);
    const member = addUser('member', false);
    const target = addUser('target', false);
    const outcast = addUser('outcast', false);
    db.prepare('INSERT INTO bans (user_id, banned_by, reason) VALUES (?, ?, ?)').run(outcast, owner, 'test');
    const channel = Number(db.prepare("INSERT INTO channels (name, code, created_by, is_dm) VALUES ('Bots', 'abcd1234', ?, 0)").run(owner).lastInsertRowid);
    for (const id of [owner, member, target, outcast]) db.prepare('INSERT INTO channel_members (channel_id, user_id) VALUES (?, ?)').run(channel, id);
    const addBot = (name, token, by, mod) => Number(db.prepare('INSERT INTO webhooks (channel_id, name, token, created_by, can_moderate) VALUES (?, ?, ?, ?, ?)').run(channel, name, token, by, mod).lastInsertRowid);
    addBot('Bot A', '${tokens.a}', owner, 0);
    addBot('Bot B', '${tokens.b}', owner, 0);
    addBot('Member Mod', '${tokens.memberMod}', member, 1);
    addBot('Outcast Bot', '${tokens.banned}', outcast, 0);
    addBot('Admin Mod', '${tokens.adminMod}', owner, 1);
    fs.writeFileSync(path.join(process.env.HAVEN_DATA_DIR, 'fixture.json'), JSON.stringify({
      target,
      memberToken: jwt.sign({ id: member, username: 'member', pwv: 1 }, process.env.JWT_SECRET),
    }));
    db.close();
  `], { cwd: root, env, encoding: 'utf8' });
  assert.equal(seed.status, 0, seed.stderr || seed.stdout);
  const fixture = JSON.parse(await fs.promises.readFile(path.join(dataDir, 'fixture.json'), 'utf8'));

  let logs = '';
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => { logs += chunk; });
  child.stderr.on('data', chunk => { logs += chunk; });
  let db = null;
  t.after(async () => {
    db?.close();
    if (child.exitCode === null) child.kill('SIGTERM');
    await Promise.race([
      child.exitCode === null ? new Promise(resolve => child.once('exit', resolve)) : Promise.resolve(),
      new Promise(resolve => setTimeout(resolve, 3000))
    ]);
    if (child.exitCode === null) child.kill('SIGKILL');
    await fs.promises.rm(dataDir, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${port}`;
  await waitForServer(`${base}/api/health`, child, () => logs);
  const post = (token, body) => fetch(`${base}/api/webhooks/${token}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });

  // A banned creator's bot cannot post.
  assert.equal((await post(tokens.banned, { content: 'hi' })).status, 404);

  // Avatar URLs: https and uploads only; names lose markup characters.
  const fromA = await post(tokens.a, { content: 'from a', avatar_url: 'http://tracker.example/p.png', username: '<b>Ann\u0007</b>' });
  assert.equal(fromA.status, 200);
  const aId = (await fromA.json()).message_id;
  const fromB = await post(tokens.b, { content: 'from b', avatar_url: 'https://cdn.example/b.png' });
  const bId = (await fromB.json()).message_id;
  db = new Database(path.join(dataDir, 'haven.db'));
  const rowA = db.prepare('SELECT webhook_avatar, webhook_username, webhook_id FROM messages WHERE id = ?').get(aId);
  assert.equal(rowA.webhook_avatar, null);
  assert.equal(rowA.webhook_username, 'bAnn/b');
  assert.equal(db.prepare('SELECT webhook_avatar FROM messages WHERE id = ?').get(bId).webhook_avatar, 'https://cdn.example/b.png');

  // A bot edits its own messages, not another bot's, and not into nothing.
  const patch = (token, id, body) => fetch(`${base}/api/webhooks/${token}/messages/${id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  assert.equal((await patch(tokens.a, bId, { content: 'hijacked' })).status, 403);
  assert.equal((await patch(tokens.a, aId, { content: '   ' })).status, 400);
  assert.equal((await patch(tokens.a, 999999, { content: 'x' })).status, 404);
  const edited = await patch(tokens.a, aId, { content: '  from a, edited  ' });
  assert.equal(edited.status, 200);
  assert.equal((await edited.json()).message_id, aId);
  const rowEdited = db.prepare('SELECT content, edited_at FROM messages WHERE id = ?').get(aId);
  assert.equal(rowEdited.content, 'from a, edited');
  assert.ok(rowEdited.edited_at);
  assert.equal(db.prepare('SELECT content FROM messages WHERE id = ?').get(bId).content, 'from b');

  // A bot without moderation deletes its own messages, not another bot's.
  const del = (token, id) => fetch(`${base}/api/webhooks/${token}/messages/${id}`, { method: 'DELETE' });
  assert.equal((await del(tokens.a, bId)).status, 403);
  assert.equal((await del(tokens.a, aId)).status, 200);
  assert.ok(db.prepare('SELECT 1 FROM messages WHERE id = ?').get(bId));

  // A moderation bot needs its creator to hold the permission.
  const ban = token => fetch(`${base}/api/webhooks/${token}/moderation/ban`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: fixture.target })
  });
  const refused = await ban(tokens.memberMod);
  assert.equal(refused.status, 403);
  assert.match((await refused.json()).error, /no longer has this moderation permission/);
  assert.equal((await ban(tokens.adminMod)).status, 200);
  // The same goes for deleting other people's messages.
  assert.equal((await del(tokens.memberMod, bId)).status, 403);
  assert.equal((await fetch(`${base}/api/webhooks/${tokens.memberMod}/messages?limit=1`, { method: 'DELETE' })).status, 403);
  assert.ok(db.prepare('SELECT 1 FROM messages WHERE id = ?').get(bId));

  // High scores: safe integers under the ceiling only.
  const score = value => fetch(`${base}/api/high-scores`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${fixture.memberToken}` },
    body: `{"game":"flappy","score":${value}}`
  });
  assert.equal((await score('1e300')).status, 400);
  assert.equal((await score('9007199254740993')).status, 400);
  assert.equal((await score('"12"')).status, 400);
  assert.equal((await score('12')).status, 200);

  // Invite links redirect the same way whether or not the code exists.
  const invite = await fetch(`${base}/invite/nosuchcode`, { redirect: 'manual' });
  assert.equal(invite.status, 302);
  assert.equal(invite.headers.get('location'), '/app?invite=nosuchcode');

  // The Discord emote cache answers members only.
  assert.equal((await fetch(`${base}/api/ferry/emote/123456789012345678.png`)).status, 401);
  const asMember = await fetch(`${base}/api/ferry/emote/123456789012345678.png`, { headers: { Authorization: `Bearer ${fixture.memberToken}` } });
  assert.equal(asMember.status, 404, 'past the sign-in check; the bridge is off here');
});
