'use strict';

/**
 * Fullscreen call controls change only the client, so the Socket.IO events a
 * call already uses must keep working across a reconnect.
 *
 *   node --test test/fullscreenCallCompatibility.test.js
 */

const assert = require('node:assert/strict');
const net = require('node:net');
const test = require('node:test');
const { createHarness, wait } = require('./socketServerHarness');

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('the pre-change voice event contract survives a stale client reconnect', { timeout: 60000 }, async () => {
  const port = await reservePort();
  const harness = createHarness(port, `fullscreen-compat-${Date.now()}`);
  await harness.start();
  try {
    const admin = await harness.register('admin');
    const legacy = await harness.register('legacyclient');
    const currentSocket = await harness.connect(admin.token);
    const legacySocket = await harness.connect(legacy.token);

    const created = harness.next(currentSocket, 'channels-list', channels =>
      Array.isArray(channels) && channels.some(channel => channel.name === 'compatibility-room'));
    currentSocket.emit('create-channel', { name: 'compatibility-room' });
    const code = (await created).find(channel => channel.name === 'compatibility-room').code;
    legacySocket.emit('join-channel', { code });
    await wait(250);

    const currentJoined = harness.next(currentSocket, 'voice-existing-users', data => data?.channelCode === code);
    currentSocket.emit('voice-join', { code });
    assert.ok(await currentJoined, 'the current client joins using the existing voice-join contract');
    const legacyJoined = harness.next(legacySocket, 'voice-existing-users', data => data?.channelCode === code);
    legacySocket.emit('voice-join', { code });
    assert.ok(await legacyJoined, 'the pre-change client joins using the same event and payload');

    const initialScreen = harness.next(currentSocket, 'screen-share-started', data => data?.userId === legacy.id);
    const screenAck = await harness.ask(legacySocket, 'screen-share-started', {
      code, hasAudio: false, streamId: 'legacy-screen-before-reconnect'
    });
    assert.equal(screenAck?.ok, true);
    assert.equal((await initialScreen)?.streamId, 'legacy-screen-before-reconnect');
    const initialCamera = harness.next(currentSocket, 'webcam-started', data => data?.userId === legacy.id);
    legacySocket.emit('webcam-started', { code, streamId: 'legacy-camera-before-reconnect' });
    assert.equal((await initialCamera)?.streamId, 'legacy-camera-before-reconnect');

    legacySocket.disconnect();
    const reconnected = new Promise(resolve => legacySocket.once('connect', resolve));
    legacySocket.connect();
    await reconnected;

    const legacyRejoined = harness.next(legacySocket, 'voice-existing-users', data => data?.channelCode === code);
    const currentSawRejoin = harness.next(currentSocket, 'voice-user-joined', data =>
      data?.channelCode === code && data?.user?.id === legacy.id);
    legacySocket.emit('voice-join', { code });
    assert.ok(await legacyRejoined, 'the stale connection can rejoin after reconnecting');
    assert.ok(await currentSawRejoin, 'the current client sees the legacy client rejoin');

    const reconnectedScreen = harness.next(currentSocket, 'screen-share-started', data => data?.userId === legacy.id);
    const reconnectedScreenAck = await harness.ask(legacySocket, 'screen-share-started', {
      code, hasAudio: false, streamId: 'legacy-screen-after-reconnect'
    });
    assert.equal(reconnectedScreenAck?.ok, true);
    assert.equal((await reconnectedScreen)?.streamId, 'legacy-screen-after-reconnect');
    const reconnectedCamera = harness.next(currentSocket, 'webcam-started', data => data?.userId === legacy.id);
    legacySocket.emit('webcam-started', { code, streamId: 'legacy-camera-after-reconnect' });
    assert.equal((await reconnectedCamera)?.streamId, 'legacy-camera-after-reconnect');

    const screenStopped = harness.next(currentSocket, 'screen-share-stopped', data => data?.userId === legacy.id);
    const stopAck = await harness.ask(legacySocket, 'screen-share-stopped', { code });
    assert.equal(stopAck?.ok, true);
    assert.ok(await screenStopped, 'the current client receives the legacy stop event');
    const cameraStopped = harness.next(currentSocket, 'webcam-stopped', data => data?.userId === legacy.id);
    legacySocket.emit('webcam-stopped', { code });
    assert.ok(await cameraStopped, 'the current client receives the legacy camera stop event');

    const legacyLeft = harness.next(currentSocket, 'voice-user-left', data =>
      data?.channelCode === code && data?.user?.id === legacy.id);
    legacySocket.emit('voice-leave', { code });
    assert.ok(await legacyLeft, 'the legacy client can leave voice without changing text-channel membership');
    assert.ok((await harness.channels(legacySocket)).some(channel => channel.code === code),
      'voice-leave leaves the legacy client in the text channel');
  } finally {
    await harness.stop();
  }
});
