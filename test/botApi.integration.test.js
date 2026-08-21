'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const test = require('node:test');
const Database = require('better-sqlite3');

function createPcmWav(durationSeconds = 2, sampleRate = 8000) {
  const samples = Math.floor(durationSeconds * sampleRate);
  const dataSize = samples * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

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

async function uploadAudioWhileRevoking(baseUrl, token, audio, dataDir) {
  const boundary = `haven-test-${Date.now()}`;
  const prefix = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="speech.wav"\r\n` +
    'Content-Type: audio/wav\r\n\r\n'
  );
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
  const responsePromise = new Promise((resolve, reject) => {
    const request = http.request(`${baseUrl}/api/webhooks/${token}/audio`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` }
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    request.on('error', reject);
    request.write(prefix);
    request.write(audio.subarray(0, 44));

    (async () => {
      const audioDir = path.join(dataDir, 'uploads', 'bot-audio');
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline && (await fs.promises.readdir(audioDir)).length === 0) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      if ((await fs.promises.readdir(audioDir)).length === 0) throw new Error('Upload did not start');
      const db = new Database(path.join(dataDir, 'haven.db'));
      db.prepare('UPDATE webhooks SET can_use_voice = 0 WHERE token = ?').run(token);
      db.close();
      request.end(Buffer.concat([audio.subarray(44), suffix]));
    })().catch(error => {
      request.destroy(error);
      reject(error);
    });
  });
  return responsePromise;
}

async function startAndAbortAudioUpload(baseUrl, token, dataDir) {
  const boundary = `haven-abort-${Date.now()}`;
  const prefix = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="speech.wav"\r\n` +
    'Content-Type: audio/wav\r\n\r\n'
  );
  const request = http.request(`${baseUrl}/api/webhooks/${token}/audio`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` }
  });
  request.on('error', () => {});
  request.write(prefix);
  request.write(createPcmWav().subarray(0, 44));

  const audioDir = path.join(dataDir, 'uploads', 'bot-audio');
  const startedDeadline = Date.now() + 3000;
  while (Date.now() < startedDeadline && (await fs.promises.readdir(audioDir)).length === 0) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok((await fs.promises.readdir(audioDir)).length > 0, 'Aborted upload did not start');
  request.destroy();

  const cleanupDeadline = Date.now() + 3000;
  while (Date.now() < cleanupDeadline && (await fs.promises.readdir(audioDir)).length > 0) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('bot REST API serves presence, bulk delete, and dynamic audio end to end', async t => {
  const root = path.resolve(__dirname, '..');
  const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'haven-bot-api-test-'));
  const token = 'a'.repeat(64);
  const port = await availablePort();
  const env = {
    ...process.env,
    HAVEN_DATA_DIR: dataDir,
    FORCE_HTTP: 'true',
    HOST: '127.0.0.1',
    PORT: String(port)
  };

  const seed = spawnSync(process.execPath, ['-e', `
    const fs = require('fs');
    const path = require('path');
    const { initDatabase } = require('./src/database');
    const db = initDatabase();
    const user = db.prepare("INSERT INTO users (username, password_hash, is_admin) VALUES ('owner', 'x', 1)").run();
    const channel = db.prepare("INSERT INTO channels (name, code, created_by, is_dm, voice_enabled, soundboard_enabled) VALUES ('Bots', 'abcd1234', ?, 0, 1, 1)").run(user.lastInsertRowid);
    db.prepare('INSERT INTO channel_members (channel_id, user_id) VALUES (?, ?)').run(channel.lastInsertRowid, user.lastInsertRowid);
    db.prepare('INSERT INTO webhooks (channel_id, name, token, created_by, can_moderate, can_use_voice) VALUES (?, ?, ?, ?, 1, 1)').run(channel.lastInsertRowid, 'Test Bot', '${token}', user.lastInsertRowid);
    const insertMessage = db.prepare('INSERT INTO messages (channel_id, user_id, content) VALUES (?, ?, ?)');
    insertMessage.run(channel.lastInsertRowid, user.lastInsertRowid, '/uploads/shared.txt');
    insertMessage.run(channel.lastInsertRowid, user.lastInsertRowid, 'one');
    insertMessage.run(channel.lastInsertRowid, user.lastInsertRowid, 'two');
    insertMessage.run(channel.lastInsertRowid, user.lastInsertRowid, '/uploads/shared.txt');
    fs.writeFileSync(path.join(process.env.HAVEN_DATA_DIR, 'uploads', 'shared.txt'), 'shared');
    db.close();
  `], { cwd: root, env, encoding: 'utf8' });
  assert.equal(seed.status, 0, seed.stderr || seed.stdout);

  let logs = '';
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
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

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForServer(`${baseUrl}/api/webhooks/${token}/voice/channels`, child, () => logs);

  const presenceResponse = await fetch(`${baseUrl}/api/webhooks/${token}/voice/channels`);
  assert.equal(presenceResponse.status, 200);
  assert.deepEqual(await presenceResponse.json(), {
    channels: [{ code: 'abcd1234', name: 'Bots', members: 0, bots: 0 }]
  });

  const deleteResponse = await fetch(`${baseUrl}/api/webhooks/${token}/messages?limit=2`, { method: 'DELETE' });
  assert.equal(deleteResponse.status, 200);
  const deleted = await deleteResponse.json();
  assert.equal(deleted.deleted, 2);
  assert.equal(deleted.message_ids.length, 2);
  assert.equal((await fetch(`${baseUrl}/uploads/shared.txt`)).status, 200);

  const form = new FormData();
  form.append('audio', new Blob([createPcmWav()], { type: 'audio/wav' }), 'speech.wav');
  form.append('channel_code', 'abcd1234');
  const audioResponse = await fetch(`${baseUrl}/api/webhooks/${token}/audio`, { method: 'POST', body: form });
  const audioBody = await audioResponse.text();
  assert.equal(audioResponse.status, 202, audioBody);
  const audio = JSON.parse(audioBody);
  assert.equal(audio.channel_code, 'abcd1234');
  assert.equal(audio.queued, false);

  const skipResponse = await fetch(`${baseUrl}/api/webhooks/${token}/audio/skip`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel_code: 'abcd1234' })
  });
  assert.equal(skipResponse.status, 200);
  assert.equal((await skipResponse.json()).skipped, true);

  const audioDir = path.join(dataDir, 'uploads', 'bot-audio');
  while ((await fs.promises.readdir(audioDir)).length > 0) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  await startAndAbortAudioUpload(baseUrl, token, dataDir);
  assert.deepEqual(await fs.promises.readdir(audioDir), []);

  const revokedUpload = await uploadAudioWhileRevoking(baseUrl, token, createPcmWav(), dataDir);
  assert.equal(revokedUpload.status, 403, revokedUpload.body);
  assert.match(revokedUpload.body, /voice permission/);
  assert.deepEqual(await fs.promises.readdir(audioDir), []);
});
