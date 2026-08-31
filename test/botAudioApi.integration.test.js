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
const WebSocket = require('ws');

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

function connectVoiceSocket(baseUrl, auth, channelCode) {
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
    const timer = setTimeout(() => reject(new Error('Timed out joining Socket.IO voice')), 5000);
    ws.on('message', raw => {
      const packet = raw.toString();
      if (packet === '2') return ws.send('3');
      if (packet.startsWith('0')) {
        ws.send(`40${JSON.stringify(auth)}`);
        return;
      }
      if (packet.startsWith('44')) {
        clearTimeout(timer);
        reject(new Error(`Socket.IO authentication failed: ${packet}`));
        return;
      }
      if (packet.startsWith('40')) {
        ws.send(`42${JSON.stringify(['voice-join', { code: channelCode }])}`);
        return;
      }
      if (!packet.startsWith('42')) return;
      const payload = JSON.parse(packet.slice(2));
      pushEvent(payload[0], payload[1]);
      if (payload[0] === 'voice-existing-users' && payload[1]?.channelCode === channelCode) {
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

  return { ws, ready, waitFor };
}

async function waitForEmptyDirectory(dir) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if ((await fs.promises.readdir(dir)).length === 0) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.deepEqual(await fs.promises.readdir(dir), []);
}

async function startAndAbortUpload(baseUrl, token, dataDir) {
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
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && (await fs.promises.readdir(audioDir)).length === 0) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok((await fs.promises.readdir(audioDir)).length > 0, 'Aborted upload did not start');
  request.destroy();
  await waitForEmptyDirectory(audioDir);
}

async function uploadWhileRevoking(baseUrl, token, audio, dataDir) {
  const boundary = `haven-revoke-${Date.now()}`;
  const prefix = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="speech.wav"\r\n` +
    'Content-Type: audio/wav\r\n\r\n'
  );
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
  return new Promise((resolve, reject) => {
    const request = http.request(`${baseUrl}/api/webhooks/${token}/audio`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` }
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        body: Buffer.concat(chunks).toString()
      }));
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
      assert.ok((await fs.promises.readdir(audioDir)).length > 0, 'Revoked upload did not start');
      const db = new Database(path.join(dataDir, 'haven.db'));
      db.prepare('UPDATE webhooks SET can_use_voice = 0 WHERE token = ?').run(token);
      db.close();
      request.end(Buffer.concat([audio.subarray(44), suffix]));
    })().catch(error => {
      request.destroy(error);
      reject(error);
    });
  });
}

test('dynamic bot audio requires live voice and cleans capabilities, aborts, and revokes end to end', async t => {
  const root = path.resolve(__dirname, '..');
  const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'haven-bot-audio-api-'));
  const botToken = 'a'.repeat(64);
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
    const channel = db.prepare("INSERT INTO channels (name, code, created_by, is_dm, voice_enabled) VALUES ('Bots', 'abcd1234', ?, 0, 1)").run(user.lastInsertRowid);
    db.prepare('INSERT INTO channel_members (channel_id, user_id) VALUES (?, ?)').run(channel.lastInsertRowid, user.lastInsertRowid);
    db.prepare('INSERT INTO webhooks (channel_id, name, token, created_by, can_use_voice) VALUES (?, ?, ?, ?, 1)').run(channel.lastInsertRowid, 'Test Bot', '${botToken}', user.lastInsertRowid);
    const humanToken = jwt.sign({ id: Number(user.lastInsertRowid), username: 'owner', pwv: 1 }, process.env.JWT_SECRET);
    fs.writeFileSync(path.join(process.env.HAVEN_DATA_DIR, 'human-token.txt'), humanToken);
    db.close();
  `], { cwd: root, env, encoding: 'utf8' });
  assert.equal(seed.status, 0, seed.stderr || seed.stdout);

  let logs = '';
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => { logs += chunk; });
  child.stderr.on('data', chunk => { logs += chunk; });
  const sockets = [];
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    if (child.exitCode === null) child.kill('SIGTERM');
    await Promise.race([
      child.exitCode === null ? new Promise(resolve => child.once('exit', resolve)) : Promise.resolve(),
      new Promise(resolve => setTimeout(resolve, 3000))
    ]);
    if (child.exitCode === null) child.kill('SIGKILL');
    await fs.promises.rm(dataDir, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForServer(`${baseUrl}/api/webhooks/${botToken}/voice/channels`, child, () => logs);

  const absentForm = new FormData();
  absentForm.append('audio', new Blob([createPcmWav()], { type: 'audio/wav' }), 'speech.wav');
  const absentResponse = await fetch(`${baseUrl}/api/webhooks/${botToken}/audio`, {
    method: 'POST', body: absentForm
  });
  assert.equal(absentResponse.status, 409);

  const bot = connectVoiceSocket(baseUrl, { botToken }, 'abcd1234');
  sockets.push(bot.ws);
  await bot.ready;
  const humanToken = await fs.promises.readFile(path.join(dataDir, 'human-token.txt'), 'utf8');
  const human = connectVoiceSocket(baseUrl, { token: humanToken }, 'abcd1234');
  sockets.push(human.ws);
  await human.ready;

  const playEvent = human.waitFor('bot-audio-play');
  const form = new FormData();
  form.append('audio', new Blob([createPcmWav()], { type: 'audio/wav' }), 'speech.wav');
  form.append('channel_code', 'abcd1234');
  const uploadResponse = await fetch(`${baseUrl}/api/webhooks/${botToken}/audio`, {
    method: 'POST', body: form
  });
  const uploadText = await uploadResponse.text();
  assert.equal(uploadResponse.status, 202, uploadText);
  const uploaded = JSON.parse(uploadText);
  assert.equal(uploaded.channel_code, 'abcd1234');
  assert.equal(uploaded.queued, false);

  const playback = await playEvent;
  assert.equal(playback.playbackId, uploaded.playback_id);
  assert.equal((await fetch(`${baseUrl}${playback.audioUrl}`)).status, 200);

  const staticFilename = `${uploaded.playback_id}.wav`;
  assert.equal(fs.existsSync(path.join(dataDir, 'uploads', 'bot-audio', staticFilename)), true);
  for (const blockedPath of [
    `/uploads/bot-audio/${staticFilename}`,
    `/uploads/bot%2Daudio/${staticFilename}`,
    `/uploads//bot-audio/${staticFilename}`,
    `/uploads/bot-audio%2F${staticFilename}`
  ]) {
    assert.equal((await fetch(`${baseUrl}${blockedPath}`)).status, 404, blockedPath);
  }

  const skipResponse = await fetch(`${baseUrl}/api/webhooks/${botToken}/audio/skip`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel_code: 'abcd1234' })
  });
  assert.equal(skipResponse.status, 200);
  assert.equal((await skipResponse.json()).skipped, true);
  assert.equal((await fetch(`${baseUrl}${playback.audioUrl}`)).status, 404);

  const audioDir = path.join(dataDir, 'uploads', 'bot-audio');
  await waitForEmptyDirectory(audioDir);

  const nextPlayEvent = human.waitFor(
    'bot-audio-play',
    payload => payload.playbackId !== uploaded.playback_id
  );
  for (let index = 0; index < 2; index++) {
    const queuedForm = new FormData();
    queuedForm.append('audio', new Blob([createPcmWav()], { type: 'application/octet-stream' }), `queued-${index}.wav`);
    queuedForm.append('channel_code', 'abcd1234');
    const queuedResponse = await fetch(`${baseUrl}/api/webhooks/${botToken}/audio`, {
      method: 'POST', body: queuedForm
    });
    assert.equal(queuedResponse.status, 202, await queuedResponse.text());
  }
  const nextPlayback = await nextPlayEvent;
  const wrongCapability = nextPlayback.audioUrl.replace(/[a-f0-9]$/, character => character === '0' ? '1' : '0');
  assert.equal((await fetch(`${baseUrl}${wrongCapability}`)).status, 404);
  const stopResponse = await fetch(
    `${baseUrl}/api/webhooks/${botToken}/audio/current?channel_code=abcd1234`,
    { method: 'DELETE' }
  );
  assert.equal(stopResponse.status, 200);
  const stopped = await stopResponse.json();
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.removed, 2);
  assert.equal((await fetch(`${baseUrl}${nextPlayback.audioUrl}`)).status, 404);
  await waitForEmptyDirectory(audioDir);

  await startAndAbortUpload(baseUrl, botToken, dataDir);
  assert.deepEqual(await fs.promises.readdir(audioDir), []);

  const revoked = await uploadWhileRevoking(baseUrl, botToken, createPcmWav(), dataDir);
  assert.equal(revoked.status, 403, revoked.body);
  assert.match(revoked.body, /voice permission/i);
  await waitForEmptyDirectory(audioDir);

  const unavailableCapability = `/api/bot-audio/${'0'.repeat(8)}-${'0'.repeat(4)}-${'0'.repeat(4)}-${'0'.repeat(4)}-${'0'.repeat(12)}/${'0'.repeat(48)}`;
  let limitedResponse;
  for (let requestCount = 0; requestCount < 121; requestCount++) {
    limitedResponse = await fetch(`${baseUrl}${unavailableCapability}`);
    if (limitedResponse.status === 429) break;
    assert.equal(limitedResponse.status, 404);
  }
  assert.equal(limitedResponse.status, 429, 'Bot audio playback route was not rate limited');
});
