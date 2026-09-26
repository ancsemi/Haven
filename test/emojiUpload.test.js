'use strict';

// Uploading one custom emoji (#5694). The square cropper redraws a single
// frame, so an animated WebP or PNG has to skip it the way a GIF does, and the
// cropper can zoom out until a wide picture fits whole inside the square.

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const modulePath = path.join(__dirname, '..', 'public', 'js', 'modules', 'app-media.js');
let M;
test.before(async () => {
  M = Object.assign({}, (await import(pathToFileURL(modulePath).href)).default);
});

const ascii = (s) => [...s].map(c => c.charCodeAt(0));
const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];

function webp(animated) {
  // RIFF....WEBP, then a VP8X chunk whose first flags byte (offset 20) says
  // whether the file is animated.
  const bytes = [...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WEBP'), ...ascii('VP8X'), 10, 0, 0, 0, animated ? 0x02 : 0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  return new Blob([new Uint8Array(bytes)]);
}

function png(animated) {
  const chunk = (type, len) => [...u32(len), ...ascii(type), ...new Array(len).fill(0), 0, 0, 0, 0];
  const bytes = [0x89, ...ascii('PNG'), 13, 10, 26, 10, ...chunk('IHDR', 13), ...(animated ? chunk('acTL', 8) : []), ...chunk('IDAT', 4)];
  return new Blob([new Uint8Array(bytes)]);
}

test('animated WebP and PNG are recognised, still ones are not', async () => {
  assert.equal(await M._isAnimatedImage(webp(true)), true);
  assert.equal(await M._isAnimatedImage(webp(false)), false);
  assert.equal(await M._isAnimatedImage(png(true)), true);
  assert.equal(await M._isAnimatedImage(png(false)), false);
  assert.equal(await M._isAnimatedImage(new Blob([new Uint8Array([1, 2, 3])])), false);
});

test('a picture smaller than the square sits in its middle; a larger one covers it', () => {
  const app = Object.assign({}, M);
  // 400x100 zoomed all the way out: 256x64, centred.
  app._cropState = { img: { width: 400, height: 100 }, scale: 0.64, ox: -50, oy: 0 };
  app._clampEmojiCrop();
  assert.equal(app._cropState.ox, 0);
  assert.equal(app._cropState.oy, 96);
  // The same picture filling the square can only slide sideways within itself.
  app._cropState = { img: { width: 400, height: 100 }, scale: 2.56, ox: 50, oy: 30 };
  app._clampEmojiCrop();
  assert.equal(app._cropState.ox, 0);
  assert.equal(app._cropState.oy, 0);
  app._cropState.ox = -2000;
  app._clampEmojiCrop();
  assert.equal(app._cropState.ox, 256 - 1024);
});
