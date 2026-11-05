'use strict';

// After older history is prepended, late realigns (images, link previews)
// must not fight the reader who has already scrolled on. Measured against
// the bug in #5858: a MutationObserver kept restoring the prepend-time
// anchor for up to 15 seconds.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('late prepend realigns stop when the reader scrolls', () => {
  const src = read('public/js/modules/app-messages.js');
  const block = src.slice(src.indexOf('_prependMessages(messages) {'));
  const section = block.slice(0, block.indexOf('_appendMessages(messages) {'));
  assert.match(section, /let lateRealign = true;/);
  assert.match(section, /const stopLateRealign = \(\) =>/);
  assert.match(section, /const maybeRealign = \(\) =>/);
  assert.match(section, /\['wheel', 'touchstart', 'keydown', 'mousedown'\]/);
  assert.match(section, /container\.addEventListener\(ev, stopLateRealign/);
  assert.match(section, /setTimeout\(stopLateRealign, 15000\)/);
  assert.doesNotMatch(section, /setTimeout\(\(\) => mo\.disconnect\(\), 15000\)/);
  assert.doesNotMatch(
    section,
    /img\.addEventListener\('load', \(\) => \{ if \(!this\._coupledToBottom\) realign\(\); \}/,
  );
});

test('after the reader scrolls, a late mutation must not restore the old scrollTop', () => {
  // Same sequence as the issue: prepend, user scrolls further, content grows.
  let scrollTop = 2000;
  const afterPrepend = 2000;
  let lateRealign = true;
  const realign = () => { if (lateRealign) scrollTop = afterPrepend; };
  const stopLateRealign = () => { lateRealign = false; };
  const maybeRealign = () => { if (!lateRealign) return; realign(); };

  // Reader keeps scrolling up.
  scrollTop = 1000;
  stopLateRealign();
  assert.equal(scrollTop, 1000);

  // Link preview / image arrives in a prepended message.
  maybeRealign();
  assert.equal(scrollTop, 1000);

  // Without the stop, the same mutation would snap back:
  lateRealign = true;
  scrollTop = 1000;
  maybeRealign();
  assert.equal(scrollTop, 2000);
});
