'use strict';

// A # in an unquoted .env value cuts it short (#5824); Haven names those keys.

const assert = require('node:assert/strict');
const test = require('node:test');
const { cutAtHash } = require('../src/envHash');

test('keys with a # inside an unquoted value are named', () => {
  const env = [
    'TURN_SECRET=abc#def',
    'QUOTED="abc#def"',
    'SINGLE=\'abc#def\'',
    'NOTE=value # a comment on purpose',
    '# TURN_URL=turn:example.com#x',
    'EMPTY=',
    'export OTHER=x#y',
    'PORT=3000',
  ].join('\n');
  assert.deepEqual(cutAtHash(env), ['TURN_SECRET', 'OTHER']);
});
