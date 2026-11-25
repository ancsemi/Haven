'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { validHighScore } = require('../src/highScores');

test('high scores are safe integers within the game ceiling', () => {
  assert.equal(validHighScore('flappy', 42), 42);
  assert.equal(validHighScore('flappy', 0), 0);
  assert.equal(validHighScore('flappy', 100001), null);
  assert.equal(validHighScore('arcade-pool', 3790), 3790);
  assert.equal(validHighScore('arcade-pool', 4001), null);
  assert.equal(validHighScore('arcade-minigolf', 1001), null);
  assert.equal(validHighScore('other', 999999999), 999999999);
  assert.equal(validHighScore('other', 1e300), null);
  assert.equal(validHighScore('other', 2 ** 53), null);
  assert.equal(validHighScore('other', -1), null);
  assert.equal(validHighScore('other', 1.5), null);
  assert.equal(validHighScore('other', '5'), null);
  assert.equal(validHighScore('__proto__', 5), 5);
});
