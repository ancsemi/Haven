'use strict';

/**
 * Sharing a Spotify playlist in Listen Together queues the playlist's songs,
 * found on YouTube, in order. It used to play one song named after the
 * playlist. Podcast episodes and songs YouTube does not have are left out.
 *
 *   node --test test/spotifyPlaylist.integration.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { createHarness, wait } = require('./socketServerHarness');

const h = createHarness(3513, 'spotify-playlist');
// NODE_OPTIONS reads a backslash in quotes as an escape, so forward slashes.
const STUB = path.join(__dirname, 'fixtures', 'spotifyFetchStub.js').replace(/\\/g, '/');

test.before(async () => {
  const prev = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = `${prev ? prev + ' ' : ''}--require "${STUB}"`;
  try { await h.start(); } finally {
    if (prev === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = prev;
  }
});
test.after(() => h.stop());

test('a Spotify playlist queues its songs in order', async () => {
  const admin = await h.register('admin');
  const A = await h.connect(admin.token);

  const list = h.next(A, 'channels-list', (c) => Array.isArray(c) && c.some((x) => x.name === 'jams'));
  A.emit('create-channel', { name: 'jams' });
  const code = (await list).find((c) => c.name === 'jams').code;
  const inVoice = h.next(A, 'voice-existing-users', (d) => d && d.channelCode === code);
  A.emit('voice-join', { code });
  assert.ok(await inVoice, 'in the call');

  const playing = h.next(A, 'music-shared', (d) => d && d.url, 10000);
  const queued = h.next(A, 'music-queue-update', (d) => d && d.channelCode === code && d.queue.length === 2, 10000);
  const done = h.next(A, 'toast', (d) => d && /Spotify playlist/.test(d.message), 10000);
  A.emit('music-share', { code, url: 'https://open.spotify.com/playlist/MIX1?si=abc' });

  const first = await playing;
  assert.equal(first.url, 'https://www.youtube.com/watch?v=songvideo01', 'the first song plays');
  assert.equal(first.resolvedFrom, 'spotify');
  const { queue } = await queued;
  assert.deepEqual(queue.map((e) => e.url), [
    'https://www.youtube.com/watch?v=songvideo02',
    'https://www.youtube.com/watch?v=songvideo03',
  ], 'the rest follow in order, without the episode or the missing song');
  assert.deepEqual(queue.map((e) => e.title), ['Song 2 - Band B, Guest', 'Song 3 - Band C']);
  assert.match((await done).message, /added 3 tracks from a Spotify playlist \(1 not found on YouTube\)/);

  const failed = h.next(A, 'error-msg', (m) => /Spotify playlist/.test(m), 10000);
  A.emit('music-share', { code, url: 'https://open.spotify.com/playlist/PRIVATE1' });
  assert.match(await failed, /private or empty/, 'a playlist that cannot be read says so');

  await wait(100);
  A.disconnect();
});
