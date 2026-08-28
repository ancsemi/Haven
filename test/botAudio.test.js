'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  BotAudioManager,
  detectAudioFormat,
  inspectAudioFile,
  MAX_AUDIO_BYTES,
  MAX_AUDIO_QUEUE_ITEMS
} = require('../src/botAudio');

const MP3_FIXTURE = Buffer.from(
  '/+M4wAAAAAAAAAAAAEluZm8AAAAPAAAABQAAAkAAgICAgICAgICAgICAgICAgICAgKCgoKCgoKCgoKCgoKCgoKCgoKCgwMDAwMDAwMDAwMDAwMDAwMDAwMDg4ODg4ODg4ODg4ODg4ODg4ODg4P//////////////////////////AAAAAExhdmM2Mi4xMQAAAAAAAAAAAAAAACQCwAAAAAAAAAJAs2BBWAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/+MYxAAAAANIAAAAAExBTUUzLjEwMSAoYmV0YSAzKVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVMQU1FMy4xMDEgKGJldGEgMylV/+MYxDsAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV/+MYxHYAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV/+MYxLEAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV/+MYxMQAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV',
  'base64'
);
const OGG_FIXTURE = Buffer.from(
  'T2dnUwACAAAAAAAAAADEMvzjAAAAABsxH4kBE09wdXNIZWFkAQE4AUAfAAAAAABPZ2dTAAAAAAAAAAAAAMQy/OMBAAAAktKiWgE9T3B1c1RhZ3MMAAAATGF2ZjYyLjMuMTAwAQAAAB0AAABlbmNvZGVyPUxhdmM2Mi4xMS4xMDAgbGlib3B1c09nZ1MABPgTAAAAAAAAxDL84wIAAAD89JJqBgcGBgYGBggL5jsjq2AICKyzDsYICKyzDsYICKyzDsYICKyzDsYICKyzDsY=',
  'base64'
);

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

function createHarness(dir, options = {}) {
  const events = [];
  const io = {
    to(room) {
      return {
        except(excludedRoom) {
          return {
            emit(event, payload) { events.push({ room, excludedRoom, event, payload }); }
          };
        }
      };
    }
  };
  return { manager: new BotAudioManager(io, dir, options), events };
}

function queueEntry(dir, overrides = {}) {
  const playbackId = overrides.playbackId || `play-${Math.random()}`;
  return {
    playbackId,
    accessToken: `token-${playbackId}`,
    webhookId: 1,
    botName: 'Audio Bot',
    channelCode: '1234abcd',
    audioUrl: `/api/bot-audio/${playbackId}`,
    filePath: path.join(dir, `${playbackId}.wav`),
    mime: 'audio/wav',
    durationMs: 60000,
    ...overrides
  };
}

test('detectAudioFormat identifies supported magic bytes', () => {
  assert.equal(detectAudioFormat(Buffer.from('RIFF0000WAVE')).extension, '.wav');
  assert.equal(detectAudioFormat(Buffer.from('OggS00000000')).extension, '.ogg');
  assert.equal(detectAudioFormat(Buffer.from('ID3000000000')).extension, '.mp3');
  assert.equal(detectAudioFormat(Buffer.from([0xff, 0xfb, 0x90, 0x00])).extension, '.mp3');
  assert.equal(detectAudioFormat(Buffer.from([0xff, 0xf1, 0x50, 0x80])), null, 'ADTS AAC is not MP3');
  assert.equal(detectAudioFormat(Buffer.from([0xff, 0xfd, 0x90, 0x00])), null, 'MPEG Layer II is not MP3');
  assert.equal(detectAudioFormat(Buffer.from('not audio')), null);
});

test('inspectAudioFile validates MP3, WAV, and OGG bytes and duration', async t => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'haven-bot-audio-formats-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const samples = [
    ['sample.mp3', MP3_FIXTURE, '.mp3'],
    ['sample.wav', createPcmWav(), '.wav'],
    ['sample.ogg', OGG_FIXTURE, '.ogg']
  ];

  for (const [name, contents, extension] of samples) {
    const filePath = path.join(dir, name);
    await fs.promises.writeFile(filePath, contents);
    const result = await inspectAudioFile(filePath);
    assert.equal(result.extension, extension);
    assert.ok(result.durationMs >= 50, `${name} should have a measurable duration`);
  }
});

test('inspectAudioFile rejects invalid bytes, excessive duration, and excessive size', async t => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'haven-bot-audio-limits-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const invalidPath = path.join(dir, 'invalid.upload');
  const disguisedPath = path.join(dir, 'id3-asf.upload');
  const durationPath = path.join(dir, 'too-long.wav');
  const boundaryPath = path.join(dir, 'boundary.wav');
  const sizePath = path.join(dir, 'too-large.wav');
  await fs.promises.writeFile(invalidPath, 'not audio');
  await fs.promises.writeFile(disguisedPath, Buffer.concat([
    Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0]),
    Buffer.from([0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11, 0xa6, 0xd9, 0x00, 0xaa, 0x00, 0x62, 0xce, 0x6c]),
    Buffer.alloc(100)
  ]));
  await fs.promises.writeFile(durationPath, createPcmWav(301, 1));
  await fs.promises.writeFile(boundaryPath, createPcmWav(300, 1));
  await fs.promises.writeFile(sizePath, createPcmWav());
  await fs.promises.truncate(sizePath, MAX_AUDIO_BYTES + 1);

  await assert.rejects(inspectAudioFile(invalidPath), /valid MP3, WAV, or OGG/);
  await assert.rejects(inspectAudioFile(disguisedPath), /duration|valid audio/);
  await assert.rejects(inspectAudioFile(durationPath), /300 seconds or shorter/);
  assert.equal((await inspectAudioFile(boundaryPath)).durationMs, 300000);
  await assert.rejects(inspectAudioFile(sizePath), /10 MB or smaller/);
});

test('BotAudioManager queues, advances, isolates controls, and expires capabilities', async t => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'haven-bot-audio-queue-'));
  let now = 1000;
  const timers = [];
  const { manager, events } = createHarness(dir, {
    now: () => now,
    setTimer(fn, delay) {
      const timer = { fn, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer) { timer.cleared = true; }
  });
  t.after(() => {
    manager.shutdown();
    return fs.promises.rm(dir, { recursive: true, force: true });
  });

  const first = queueEntry(dir, { playbackId: 'first', durationMs: 100 });
  const second = queueEntry(dir, { playbackId: 'second', webhookId: 2, durationMs: 100 });
  const third = queueEntry(dir, { playbackId: 'third', webhookId: 2, durationMs: 100 });
  await fs.promises.writeFile(first.filePath, createPcmWav());
  await fs.promises.writeFile(second.filePath, createPcmWav());
  await fs.promises.writeFile(third.filePath, createPcmWav());

  assert.deepEqual(manager.enqueue(first), { playbackId: 'first', position: 0, queued: false });
  assert.deepEqual(manager.enqueue(second), { playbackId: 'second', position: 1, queued: true });
  assert.equal(events[0].excludedRoom, 'bot-sockets');
  assert.equal(manager.getPlayable('first', first.accessToken).filePath, first.filePath);
  assert.equal(manager.skip('1234abcd', 2).playbackId, 'second');
  assert.equal(manager.enqueue(third).queued, true);
  assert.equal(manager.getCurrent('1234abcd').playbackId, 'first');

  now = 1100;
  assert.equal(manager.getPlayable('first', first.accessToken), null);
  assert.equal(manager.getCurrent('1234abcd'), null);
  timers[0].fn();
  assert.equal(manager.getCurrent('1234abcd').playbackId, 'third');
  assert.equal(events.filter(item => item.event === 'bot-audio-play').length, 2);
  assert.deepEqual(manager.stop('1234abcd', 2), { stopped: true, removed: 1 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fs.existsSync(first.filePath), false);
  assert.equal(fs.existsSync(second.filePath), false);
  assert.equal(fs.existsSync(third.filePath), false);
});

test('BotAudioManager enforces a global per-bot limit and cleans channel, rotation, and shutdown state', async t => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'haven-bot-audio-global-'));
  const { manager, events } = createHarness(dir);
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));

  for (let index = 0; index < MAX_AUDIO_QUEUE_ITEMS; index++) {
    const entry = queueEntry(dir, {
      playbackId: `item-${index}`,
      webhookId: 9,
      channelCode: index % 2 ? 'aaaaaaaa' : 'bbbbbbbb'
    });
    await fs.promises.writeFile(entry.filePath, createPcmWav());
    assert.equal(manager.enqueue(entry).error, undefined);
  }
  const rejected = manager.enqueue(queueEntry(dir, {
    playbackId: 'too-many', webhookId: 9, channelCode: 'cccccccc'
  }));
  assert.match(rejected.error, /queue is full/);
  assert.equal(manager.getScopes().some(scope => scope.channelCode === 'cccccccc'), false);

  assert.equal(manager.renameChannel('aaaaaaaa', 'dddddddd'), true);
  assert.equal(manager.getScopes().some(scope => scope.channelCode === 'aaaaaaaa'), false);
  assert.equal(manager.stopChannel('dddddddd'), 12);
  assert.ok(events.some(item => item.room === 'voice:dddddddd' && item.payload.reason === 'channel-deleted'));
  assert.equal(manager.shutdown(), 13);
  assert.deepEqual(manager.getScopes(), []);
  assert.deepEqual(await fs.promises.readdir(dir), []);
});

test('VoiceManager keeps bot audio scoped to voice, output, deafen, and disconnect state', async t => {
  const previous = { Audio: global.Audio, document: global.document, localStorage: global.localStorage };
  t.after(() => {
    global.Audio = previous.Audio;
    global.document = previous.document;
    global.localStorage = previous.localStorage;
  });
  const audios = [];
  class FakeAudio {
    constructor(src) {
      this.src = src;
      this.readyState = 1;
      this.duration = 10;
      this.volume = 1;
      this.listeners = new Map();
      this.paused = false;
      audios.push(this);
    }
    addEventListener(event, listener) { this.listeners.set(event, listener); }
    play() { this.played = true; return Promise.resolve(); }
    pause() { this.paused = true; }
    setSinkId(deviceId) { this.sinkId = deviceId; return Promise.resolve(); }
    removeAttribute(name) { if (name === 'src') this.src = ''; }
    load() { this.loaded = true; }
  }
  global.Audio = FakeAudio;
  global.document = { querySelectorAll: () => [] };
  global.localStorage = {
    getItem: key => key === 'haven_output_device' ? 'headset' : null,
    setItem() {},
    removeItem() {}
  };
  delete require.cache[require.resolve('../public/js/voice.js')];
  const { VoiceManager } = require('../public/js/voice.js');
  const voice = Object.assign(Object.create(VoiceManager.prototype), {
    socket: { connected: true, emit() {} },
    inVoice: true,
    currentChannel: '1234abcd',
    isMuted: false,
    isDeafened: false,
    isScreenSharing: false,
    isWebcamActive: false,
    _botAudio: null,
    _noiseGateInterval: null,
    _localTalkInterval: null,
    analysers: new Map(),
    peers: new Map(),
    gainNodes: new Map(),
    screenGainNodes: new Map(),
    screenSharers: new Set(),
    _screenDelivered: new Set(),
    webcamUsers: new Set(),
    rawStream: null,
    localStream: null,
    audioCtx: null,
    _disconnectTimers: {}
  });

  assert.equal(voice.playBotAudio({
    playbackId: 'wrong', channelCode: 'ffffffff', audioUrl: '/wrong', offsetMs: 0
  }), false);
  assert.equal(voice.playBotAudio({
    playbackId: 'current', channelCode: '1234abcd', audioUrl: '/audio', offsetMs: 1000
  }), true);
  await Promise.resolve();
  await Promise.resolve();
  assert.ok(audios[0].currentTime >= 1 && audios[0].currentTime < 1.1);
  assert.equal(audios[0].volume, 1);
  assert.equal(audios[0].sinkId, 'headset');
  const originalLog = console.log;
  console.log = () => {};
  try { await voice.switchOutputDevice('speakers'); } finally { console.log = originalLog; }
  assert.equal(audios[0].sinkId, 'speakers');
  voice.toggleDeafen();
  assert.equal(audios[0].volume, 0);
  voice.toggleDeafen();
  assert.equal(audios[0].volume, 1);
  assert.equal(voice.stopBotAudio('stale'), false);
  voice._softLeave();
  assert.equal(audios[0].paused, true);
  assert.equal(voice._botAudio, null);
  assert.equal(voice.currentChannel, null);

});
