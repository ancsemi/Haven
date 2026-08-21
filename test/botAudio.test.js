'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  BotAudioManager,
  detectAudioFormat,
  inspectAudioFile
} = require('../src/botAudio');

function createPcmWav(durationSeconds = 0.1, sampleRate = 8000) {
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

test('detectAudioFormat identifies supported magic bytes', () => {
  assert.equal(detectAudioFormat(Buffer.from('RIFF0000WAVE')).extension, '.wav');
  assert.equal(detectAudioFormat(Buffer.from('OggS00000000')).extension, '.ogg');
  assert.equal(detectAudioFormat(Buffer.from('ID3000000000')).extension, '.mp3');
  assert.equal(detectAudioFormat(Buffer.from([0xff, 0xfb, 0x00, 0x00])).extension, '.mp3');
  assert.equal(detectAudioFormat(Buffer.from('not audio')), null);
});

test('inspectAudioFile validates bytes and reads duration', async t => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'haven-bot-audio-test-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const validPath = path.join(dir, 'sample.upload');
  const invalidPath = path.join(dir, 'invalid.upload');
  await fs.promises.writeFile(validPath, createPcmWav());
  await fs.promises.writeFile(invalidPath, 'not audio');

  const result = await inspectAudioFile(validPath);
  assert.equal(result.extension, '.wav');
  assert.ok(result.durationMs >= 90 && result.durationMs <= 110);
  await assert.rejects(inspectAudioFile(invalidPath), /valid MP3, WAV, or OGG/);
});

test('BotAudioManager isolates controls by webhook and removes temporary files', async t => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'haven-bot-queue-test-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const events = [];
  const io = {
    to(room) {
      return {
        emit(event, payload) {
          events.push({ room, event, payload });
        }
      };
    }
  };
  const manager = new BotAudioManager(io, dir);
  const firstPath = path.join(dir, 'first.wav');
  const secondPath = path.join(dir, 'second.wav');
  await fs.promises.writeFile(firstPath, createPcmWav());
  await fs.promises.writeFile(secondPath, createPcmWav());

  const first = manager.enqueue({
    playbackId: 'first', webhookId: 1, botName: 'One', channelCode: '1234abcd',
    audioUrl: '/uploads/bot-audio/first.wav', filePath: firstPath, durationMs: 60000
  });
  const second = manager.enqueue({
    playbackId: 'second', webhookId: 2, botName: 'Two', channelCode: '1234abcd',
    audioUrl: '/uploads/bot-audio/second.wav', filePath: secondPath, durationMs: 60000
  });

  assert.equal(first.queued, false);
  assert.equal(second.queued, true);
  assert.deepEqual(manager.getScopes(), [
    { webhookId: 1, channelCode: '1234abcd' },
    { webhookId: 2, channelCode: '1234abcd' }
  ]);
  assert.equal(events[0].event, 'bot-audio-play');
  assert.equal(manager.skip('1234abcd', 2).playbackId, 'second');
  assert.deepEqual(manager.getScopes(), [{ webhookId: 1, channelCode: '1234abcd' }]);
  assert.equal(manager.getCurrent('1234abcd').playbackId, 'first');
  assert.equal(manager.renameChannel('1234abcd', '8765dcba'), true);
  assert.deepEqual(manager.getScopes(), [{ webhookId: 1, channelCode: '8765dcba' }]);
  assert.equal(manager.getCurrent('1234abcd'), null);
  assert.equal(manager.getCurrent('8765dcba').playbackId, 'first');
  assert.deepEqual(manager.stop('8765dcba', 1), { stopped: true, removed: 1 });

  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fs.existsSync(firstPath), false);
  assert.equal(fs.existsSync(secondPath), false);
  assert.equal(events.at(-1).event, 'bot-audio-stop');
  assert.equal(events.at(-1).room, 'voice:8765dcba');
});

test('BotAudioManager enforces a global per-bot limit and clears deleted channels', async t => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'haven-bot-global-queue-test-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const events = [];
  const io = {
    to(room) {
      return { emit(event, payload) { events.push({ room, event, payload }); } };
    }
  };
  const manager = new BotAudioManager(io, dir);
  const paths = [];
  for (let index = 0; index < 25; index++) {
    const filePath = path.join(dir, `${index}.wav`);
    paths.push(filePath);
    await fs.promises.writeFile(filePath, createPcmWav());
    const result = manager.enqueue({
      playbackId: `item-${index}`,
      webhookId: 9,
      botName: 'Limited',
      channelCode: index % 2 ? 'aaaaaaaa' : 'bbbbbbbb',
      audioUrl: `/audio/${index}`,
      filePath,
      durationMs: 60000
    });
    assert.equal(result.error, undefined);
  }
  const rejected = manager.enqueue({
    playbackId: 'too-many', webhookId: 9, botName: 'Limited', channelCode: 'cccccccc',
    audioUrl: '/audio/rejected', filePath: path.join(dir, 'rejected.wav'), durationMs: 60000
  });
  assert.match(rejected.error, /queue is full/);
  assert.equal(manager.getScopes().some(scope => scope.channelCode === 'cccccccc'), false);

  assert.equal(manager.stopChannel('aaaaaaaa'), 12);
  assert.equal(manager.getCurrent('aaaaaaaa'), null);
  assert.equal(manager.getScopes().some(scope => scope.channelCode === 'aaaaaaaa'), false);
  assert.ok(events.some(item => item.room === 'voice:aaaaaaaa' && item.payload.reason === 'channel-deleted'));
  assert.equal(manager.stopWebhook(9), 13);

  await new Promise(resolve => setImmediate(resolve));
  for (const filePath of paths) assert.equal(fs.existsSync(filePath), false);
});
