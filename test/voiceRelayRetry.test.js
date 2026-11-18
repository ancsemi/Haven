'use strict';

// A relayed track that fails to attach once is tried again, and a periodic
// check picks up anything still missing, so nobody stays silent for a whole
// call (#5908).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

function loadSession() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'voice-relay.js'), 'utf8');
  const win = {};
  const ctx = { window: win, document: {}, localStorage: { getItem: () => null }, console, setTimeout, clearTimeout, setInterval, clearInterval, Promise };
  vm.runInNewContext(src, ctx);
  return win.HavenRelaySession;
}

function makeSession({ consumeFailures = 0, resumeFailures = 0 } = {}) {
  const Session = loadSession();
  const calls = { consume: 0, resume: 0 };
  const socket = { on() {}, off() {}, emit() {} };
  const tracks = [];
  const s = new Session(socket, 'abcd1234', { onTrack: t => tracks.push(t), onTrackEnded() {} });
  s.device = { rtpCapabilities: {} };
  s.recvTransport = {
    async consume({ id, producerId }) {
      return { id, producerId, track: { id: 't-' + producerId }, on() {}, close() {} };
    }
  };
  s._request = async (event, data) => {
    if (event === 'relay:consume') {
      calls.consume++;
      if (calls.consume <= consumeFailures) throw new Error('transport not connected');
      return { consumer: { id: 'c' + calls.consume, producerId: data.producerId, kind: 'audio', rtpParameters: {}, userId: 7, source: 'mic' } };
    }
    if (event === 'relay:resume') {
      calls.resume++;
      if (calls.resume <= resumeFailures) throw new Error('resume failed');
      return {};
    }
    if (event === 'relay:producers') return { producers: [{ producerId: 'p1' }] };
    return {};
  };
  return { s, calls, tracks };
}

test('a failed consume is retried until it attaches', { timeout: 10000 }, async () => {
  const { s, calls } = makeSession({ consumeFailures: 2 });
  await s._consumeWithRetry({ producerId: 'p1' });
  assert.equal(calls.consume, 3);
  assert.ok(s.consumers.has('p1'));
  s.close();
});

test('a consume whose resume failed is redone, not left paused', { timeout: 10000 }, async () => {
  const { s, calls } = makeSession({ resumeFailures: 1 });
  await s._consumeWithRetry({ producerId: 'p1' });
  assert.equal(calls.consume, 2);
  assert.equal(calls.resume, 2);
  assert.ok(s.consumers.has('p1'));
  s.close();
});

test('two requests for the same track at once make one consumer', async () => {
  const { s, calls } = makeSession();
  await Promise.all([s._consumeWithRetry({ producerId: 'p1' }), s._consumeWithRetry({ producerId: 'p1' })]);
  assert.equal(calls.consume, 1);
  s.close();
});

test('resync picks up a track that was missing', async () => {
  const { s } = makeSession();
  assert.equal(s.consumers.size, 0);
  await s.resync();
  assert.ok(s.consumers.has('p1'));
  s.close();
});

test('retries stop once the session is closed', { timeout: 10000 }, async () => {
  const { s, calls } = makeSession({ consumeFailures: 99 });
  const run = s._consumeWithRetry({ producerId: 'p1' });
  s.close();
  await run;
  assert.equal(calls.consume, 1);
});
