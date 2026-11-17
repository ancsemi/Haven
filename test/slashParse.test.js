'use strict';

/**
 * A slash command's text can be long: several lines, links, "and/or". A long
 * /tts used to post as plain text with "/tts" in front and never speak.
 *
 *   node --test test/slashParse.test.js
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const { parseSlash } = require('../src/slashParse');

test('a plain command and its text', () => {
  assert.deepEqual({ ...parseSlash('/tts hi') }, { cmd: 'tts', arg: 'hi' });
  assert.deepEqual({ ...parseSlash('/SHRUG') }, { cmd: 'shrug', arg: '' });
});

test('the text may run over several lines', () => {
  assert.deepEqual({ ...parseSlash('/tts first line\nsecond line\n\nthird') }, { cmd: 'tts', arg: 'first line\nsecond line\n\nthird' });
  assert.deepEqual({ ...parseSlash('/tts\nstarts on the next line') }, { cmd: 'tts', arg: 'starts on the next line' });
});

test('the text may hold slashes', () => {
  assert.equal(parseSlash('/tts this and/or that').arg, 'this and/or that');
  assert.equal(parseSlash('/tts see https://example.com/a/b').arg, 'see https://example.com/a/b');
});

test('a path is still just a message', () => {
  for (const text of ['/usr/bin/foo', '/uploads/a.png', '/usr/bin/foo and more', '/tts:stop', 'not a command', '/ tts', '/123']) {
    assert.equal(parseSlash(text), null, text);
  }
});
