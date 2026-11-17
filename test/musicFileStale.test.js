'use strict';

/**
 * Listen Together with an uploaded file: when a track is skipped or replaced,
 * the old <audio> fires its pause a moment later. That late pause used to be
 * sent to the server and paused the next track for everyone.
 *
 *   node --test test/musicFileStale.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadMethods() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'modules', 'app-music-file.js'), 'utf8');
  const context = vm.createContext({ module: { exports: {} }, console, t: (k) => k, document: {} });
  vm.runInContext(src.replace(/^export default/m, 'module.exports ='), context);
  return context.module.exports;
}

function fakeAudio() {
  const handlers = {};
  return {
    handlers,
    ended: false,
    volume: 1,
    addEventListener(ev, fn) { (handlers[ev] ||= []).push(fn); },
    fire(ev) { for (const fn of handlers[ev] || []) fn(); },
    pause() {},
    play() { return Promise.resolve(); },
  };
}

test('a replaced track\'s late pause is not sent to the server', () => {
  const app = Object.create(loadMethods());
  const sent = [];
  app._emitMusicControl = (action) => sent.push(action);
  app._emitMusicFinished = () => sent.push('finished');
  app._setMusicPlayingUi = () => {};
  app._shouldSuppressMusicBroadcasts = () => false;

  const first = fakeAudio();
  app._initMusicFilePlayer(first, 50);
  first.fire('pause');
  assert.deepEqual(sent, ['pause'], 'the playing track still reports a pause');

  app._stopMusicFilePlayer();
  const second = fakeAudio();
  app._initMusicFilePlayer(second, 50);
  sent.length = 0;
  first.fire('pause');
  first.fire('ended');
  assert.deepEqual(sent, [], 'the old track says nothing');

  second.fire('pause');
  assert.deepEqual(sent, ['pause'], 'the new track reports as usual');
});
