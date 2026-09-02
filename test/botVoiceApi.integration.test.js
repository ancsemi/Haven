'use strict';

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
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited early:\n${output()}`);
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Server did not become ready:\n${output()}`);
}

test('voice channels endpoint enforces permission and creator scope end to end', async t => {
  const root = path.resolve(__dirname, '..');
  const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'haven-bot-voice-test-'));
  const token = 'c'.repeat(64);
  const port = await availablePort();
  const env = {
    ...process.env,
    HAVEN_DATA_DIR: dataDir,
    FORCE_HTTP: 'true',
    HOST: '127.0.0.1',
    PORT: String(port)
  };

  const seed = spawnSync(process.execPath, ['-e', `
    const { initDatabase } = require('./src/database');
    const db = initDatabase();
    const owner = db.prepare("INSERT INTO users (username, password_hash, is_admin) VALUES ('owner', 'x', 0)").run();
    const assigned = db.prepare("INSERT INTO channels (name, code, created_by, is_dm, voice_enabled, position) VALUES ('Assigned', '11111111', ?, 0, 1, 1)").run(owner.lastInsertRowid);
    const member = db.prepare("INSERT INTO channels (name, code, created_by, is_dm, voice_enabled, position) VALUES ('Member', '22222222', ?, 0, 1, 2)").run(owner.lastInsertRowid);
    db.prepare("INSERT INTO channels (name, code, created_by, is_dm, voice_enabled, position) VALUES ('Disabled', '33333333', ?, 0, 0, 3)").run(owner.lastInsertRowid);
    db.prepare("INSERT INTO channels (name, code, created_by, is_dm, voice_enabled, position) VALUES ('Restricted', '44444444', ?, 0, 1, 4)").run(owner.lastInsertRowid);
    db.prepare("INSERT INTO channels (name, code, created_by, is_dm, voice_enabled, position) VALUES ('Private DM', '55555555', ?, 1, 1, 5)").run(owner.lastInsertRowid);
    db.prepare('INSERT INTO channel_members (channel_id, user_id) VALUES (?, ?)').run(member.lastInsertRowid, owner.lastInsertRowid);
    db.prepare('INSERT INTO webhooks (channel_id, name, token, created_by, can_use_voice) VALUES (?, ?, ?, ?, 1)').run(assigned.lastInsertRowid, 'Voice Bot', '${token}', owner.lastInsertRowid);
    db.close();
  `], { cwd: root, env, encoding: 'utf8' });
  assert.equal(seed.status, 0, seed.stderr || seed.stdout);

  let logs = '';
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', chunk => { logs += chunk; });
  child.stderr.on('data', chunk => { logs += chunk; });
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    await Promise.race([
      new Promise(resolve => child.once('exit', resolve)),
      new Promise(resolve => setTimeout(resolve, 3000))
    ]);
    await fs.promises.rm(dataDir, { recursive: true, force: true });
  });

  const url = `http://127.0.0.1:${port}/api/webhooks/${token}/voice/channels`;
  const response = await waitForServer(url, child, () => logs);
  assert.deepEqual(await response.json(), {
    channels: [
      { code: '11111111', name: 'Assigned', members: 0, bots: 0 },
      { code: '22222222', name: 'Member', members: 0, bots: 0 }
    ]
  });

  const db = new Database(path.join(dataDir, 'haven.db'));
  db.prepare('UPDATE webhooks SET can_use_voice = 0 WHERE token = ?').run(token);
  db.close();
  const revoked = await fetch(url);
  assert.equal(revoked.status, 403);
  assert.deepEqual(await revoked.json(), { error: 'This bot does not have voice permission' });
});
