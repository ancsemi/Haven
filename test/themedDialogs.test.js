'use strict';

/**
 * The browser draws confirm(), alert() and prompt() in its own plain style,
 * outside the theme. The app asks through its own dialogs (_confirm, _alert,
 * _showPromptModal) instead.
 *
 *   node --test test/themedDialogs.test.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..', 'public', 'js');
// The plugin API's confirm() falls back to the browser's only before the app exists.
const ALLOWED = new Set(['plugin-loader.js']);

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? files(path.join(dir, e.name)) : e.name.endsWith('.js') ? [path.join(dir, e.name)] : []);
}

test('no plain browser dialogs in the app', () => {
  const found = [];
  for (const file of files(ROOT)) {
    if (ALLOWED.has(path.basename(file))) continue;
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line)) return;
      if (/(?<![\w.$])(?:window\.)?(confirm|alert|prompt)\(/.test(line.replace(/(?<![\w.$])window\./g, ''))
        && !/^\s*(async\s+)?(confirm|alert|prompt)\s*\(/.test(line)) {
        found.push(`${path.relative(ROOT, file)}:${i + 1}: ${line.trim().slice(0, 100)}`);
      }
    });
  }
  assert.deepEqual(found, []);
});
