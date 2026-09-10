'use strict';

// Chromium's native drag-and-drop never auto-scrolls a nested overflow
// container, so a channel dragged to the edge of a long sidebar stopped
// there. _makeEdgeScroller drives the scroll from dragover. Its DOM behaviour
// was checked in a real Chromium (scrolls at both edges, idles in the middle,
// stops on demand); this test locks the wiring.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'modules', 'app-channels.js'), 'utf8');

test('the edge scroller exists and walks up to the element that really scrolls', () => {
  assert.match(src, /_makeEdgeScroller\(listEl, edge = 48, maxSpeed = 18\)/);
  assert.match(src, /getComputedStyle\(el\)\.overflowY/);
});

test('channel and DM drag handlers feed it on dragover and stop it on drop and cleanup', () => {
  const channel = src.slice(src.indexOf('_setupChannelDragDrop() {'), src.indexOf('_setupDmDragDrop() {'));
  const dm = src.slice(src.indexOf('_setupDmDragDrop() {'));
  for (const [name, block] of [['channel', channel], ['dm', dm]]) {
    assert.match(block, /const edge = this\._makeEdgeScroller\(/, `${name}: scroller created`);
    assert.match(block, /edge\.onDragOver\(e\.clientY\)/, `${name}: dragover drives it`);
    assert.ok((block.match(/edge\.stop\(\)/g) || []).length >= 2, `${name}: stopped on drop and in cleanup`);
  }
});
