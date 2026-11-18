'use strict';

// A bot can send files with its message (multipart/form-data), so forwarded
// pictures live on the server instead of on links that expire.

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

// The smallest valid PNG (1x1, transparent).
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
  '1f15c4890000000d49444154789c6300010000000500010d0a2db40000000049454e44ae426082', 'hex');

test('a bot can post pictures and files that are stored on the server', async t => {
  const root = path.resolve(__dirname, '..');
  const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'haven-webhook-files-'));
  const okToken = 'f'.repeat(64);
  const noUploadToken = 'g'.repeat(64);
  const port = await availablePort();
  const env = {
    ...process.env,
    HAVEN_DATA_DIR: dataDir,
    FORCE_HTTP: 'true',
    HOST: '127.0.0.1',
    JWT_SECRET: 'c'.repeat(64),
    PORT: String(port)
  };

  const seed = spawnSync(process.execPath, ['-e', `
    const { initDatabase } = require('./src/database');
    const db = initDatabase();
    const admin = db.prepare("INSERT INTO users (username, password_hash, display_name, is_admin) VALUES ('owner', 'x', 'Owner', 1)").run();
    const plain = db.prepare("INSERT INTO users (username, password_hash, display_name) VALUES ('plain', 'x', 'Plain')").run();
    const channel = db.prepare("INSERT INTO channels (name, code, created_by, is_dm) VALUES ('Bots', 'abcd1234', ?, 0)").run(admin.lastInsertRowid);
    db.prepare('INSERT INTO webhooks (channel_id, name, token, created_by) VALUES (?, ?, ?, ?)').run(channel.lastInsertRowid, 'Relay', '${okToken}', admin.lastInsertRowid);
    db.prepare('INSERT INTO webhooks (channel_id, name, token, created_by) VALUES (?, ?, ?, ?)').run(channel.lastInsertRowid, 'NoUpload', '${noUploadToken}', plain.lastInsertRowid);
    db.prepare("INSERT OR REPLACE INTO server_settings (key, value) VALUES ('blocked_upload_extensions', 'exe')").run();
    // Everyone may upload by default; this person is denied it on their own.
    db.prepare("INSERT INTO user_role_perms (user_id, role_id, permission, allowed) VALUES (?, (SELECT id FROM roles ORDER BY id LIMIT 1), 'upload_files', 0)").run(plain.lastInsertRowid);
    db.close();
  `], { cwd: root, env, encoding: 'utf8' });
  assert.equal(seed.status, 0, seed.stderr || seed.stdout);

  let logs = '';
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => { logs += chunk; });
  child.stderr.on('data', chunk => { logs += chunk; });
  let db;
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

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForServer(`${baseUrl}/api/health`, child, () => logs);
  const post = (token, form) => fetch(`${baseUrl}/api/webhooks/${token}`, { method: 'POST', body: form });

  // A picture and a text file with a caption, the message in payload_json.
  const form = new FormData();
  form.append('payload_json', JSON.stringify({ content: 'Forwarded', username: 'Pooh' }));
  form.append('files[0]', new Blob([PNG], { type: 'image/png' }), 'cat.png');
  form.append('files[1]', new Blob(['hello'], { type: 'text/plain' }), 'notes (draft).txt');
  const res = await post(okToken, form);
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));

  db = new Database(path.join(dataDir, 'haven.db'), { readonly: true });
  const msg = db.prepare('SELECT content, webhook_username FROM messages WHERE id = ?').get(body.message_id);
  assert.equal(msg.webhook_username, 'Pooh');
  const lines = msg.content.split('\n');
  assert.equal(lines[0], 'Forwarded');
  assert.match(lines[1], /^\/uploads\/[\w-]+\.png$/);
  assert.match(lines[2], /^\[file:notes _draft_\.txt\]\(\/uploads\/[\w-]+\.txt\|5 B\)$/);

  // The files are really served back.
  const pic = await fetch(baseUrl + lines[1]);
  assert.equal(pic.status, 200);
  const owned = db.prepare('SELECT COUNT(*) AS n FROM upload_ownership WHERE user_id = 1').get().n;
  assert.equal(owned, 2);

  // Plain form fields work too, and a picture alone needs no text.
  const plainForm = new FormData();
  plainForm.append('file', new Blob([PNG], { type: 'image/png' }), 'only.png');
  const plainRes = await post(okToken, plainForm);
  assert.equal(plainRes.status, 200);

  // A blocked type is refused and nothing posts.
  const blocked = new FormData();
  blocked.append('content', 'nope');
  blocked.append('files[0]', new Blob(['MZ'], { type: 'application/octet-stream' }), 'setup.exe');
  const blockedRes = await post(okToken, blocked);
  assert.equal(blockedRes.status, 400);
  assert.match((await blockedRes.json()).error, /\.exe files/);

  // A bot made by someone who may not upload cannot send files.
  const denied = new FormData();
  denied.append('files[0]', new Blob([PNG], { type: 'image/png' }), 'x.png');
  const deniedRes = await post(noUploadToken, denied);
  assert.equal(deniedRes.status, 403);

  // An unknown token is refused before any file is read.
  const unknown = new FormData();
  unknown.append('files[0]', new Blob([PNG], { type: 'image/png' }), 'x.png');
  assert.equal((await post('h'.repeat(64), unknown)).status, 404);

  // Files cannot ride on an ephemeral message (it is never stored).
  const eph = new FormData();
  eph.append('payload_json', JSON.stringify({ content: 'hi', ephemeral: true, recipient_id: 1 }));
  eph.append('files[0]', new Blob([PNG], { type: 'image/png' }), 'x.png');
  assert.equal((await post(okToken, eph)).status, 400);

  // A picture that is not really one is kept as a plain file card.
  const fake = new FormData();
  fake.append('files[0]', new Blob(['<html>'], { type: 'image/png' }), 'fake.png');
  const fakeRes = await post(okToken, fake);
  const fakeBody = await fakeRes.json();
  if (fakeRes.status === 200) {
    const fakeMsg = db.prepare('SELECT content FROM messages WHERE id = ?').get(fakeBody.message_id);
    assert.match(fakeMsg.content, /^\[file:/);
  } else {
    assert.equal(fakeRes.status, 400);
  }

  // JSON posts still work as before.
  const json = await fetch(`${baseUrl}/api/webhooks/${okToken}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'plain text' })
  });
  assert.equal(json.status, 200);

  // Nothing refused was left behind in the upload folders.
  const posted = db.prepare("SELECT content FROM messages WHERE is_webhook = 1").all().map(r => r.content).join('\n');
  const kept = fs.readdirSync(path.join(dataDir, 'uploads')).filter(n => /^\d+-[0-9a-f]{16}\./.test(n));
  for (const name of kept) assert.ok(posted.includes(name), `${name} is in uploads/ but in no message`);
});
