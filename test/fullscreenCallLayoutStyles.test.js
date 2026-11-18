'use strict';

/**
 * Fullscreen call controls, stylesheet side: the layout and state colors that
 * the fullscreen tile and its toolbar rely on.
 *
 *   node --test test/fullscreenCallLayoutStyles.test.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const stylesheet = fs.readFileSync(
  path.join(__dirname, '..', 'public/css/style-streams-markdown.css'),
  'utf8'
);
const rules = [...stylesheet.matchAll(/([^{}]+)\{([^{}]*)\}/gs)].map(([, selectorText, declarations]) => ({
  selectors: selectorText
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .trim()
    .split(',')
    .map(selector => selector.trim())
    .filter(Boolean),
  declarations
}));

function declarationsFor(selector) {
  const rule = rules.find(candidate => candidate.selectors.includes(selector));
  assert.ok(rule, `Missing CSS rule for ${selector}`);
  return rule.declarations;
}

test('fullscreen tile layout applies through the app fullscreen class', () => {
  for (const selector of ['.webcam-tile.is-fullscreen', '.screen-share-tile.is-fullscreen']) {
    const declarations = declarationsFor(selector);
    assert.match(declarations, /position:\s*fixed\s*!important/);
    assert.match(declarations, /inset:\s*0\s*!important/);
    assert.match(declarations, /display:\s*flex\s*!important/);
    assert.match(declarations, /align-items:\s*center/);
    assert.match(declarations, /justify-content:\s*center/);
    assert.match(declarations, /width:\s*100vw\s*!important/);
    assert.match(declarations, /height:\s*100vh\s*!important/);
    assert.match(declarations, /max-width:\s*none\s*!important/);
    assert.match(declarations, /max-height:\s*none\s*!important/);
  }
});

test('fullscreen video fills the viewport and contains media for either tile type', () => {
  for (const selector of [
    '.webcam-tile.is-fullscreen video',
    '.screen-share-tile.is-fullscreen video'
  ]) {
    const declarations = declarationsFor(selector);
    assert.match(declarations, /width:\s*100%\s*!important/);
    assert.match(declarations, /height:\s*100%\s*!important/);
    assert.match(declarations, /max-width:\s*100vw\s*!important/);
    assert.match(declarations, /max-height:\s*100vh\s*!important/);
    assert.match(declarations, /object-fit:\s*contain/);
  }
});

test('fullscreen CSS separates standard and WebKit-only pseudo-class selectors', () => {
  for (const rule of rules) {
    const hasStandardFullscreen = rule.selectors.some(selector => selector.includes(':fullscreen'));
    const hasWebkitFullscreen = rule.selectors.some(selector => selector.includes(':-webkit-full-screen'));
    assert.equal(
      hasStandardFullscreen && hasWebkitFullscreen,
      false,
      `Do not mix standard and WebKit fullscreen selectors: ${rule.selectors.join(', ')}`
    );
  }
});

test('fullscreen sharing is green and leave is a red circle with its themed X', () => {
  const sharing = declarationsFor('.fullscreen-call-control.sharing');
  assert.match(sharing, /background:\s*var\(--success\)/);
  assert.match(sharing, /color:\s*var\(--success-text\)/);

  const leave = declarationsFor('.fullscreen-call-control.fullscreen-call-leave');
  assert.match(leave, /border-radius:\s*50%/);
  assert.match(leave, /background:\s*var\(--danger\)/);
  assert.match(leave, /color:\s*var\(--danger-text\)/);
});

test('the stream grid covers the fullscreen tile and places its cells itself', () => {
  const grid = declarationsFor('.fullscreen-stream-grid:not([hidden])');
  assert.match(grid, /position:\s*absolute/);
  assert.match(grid, /inset:\s*0/);

  const cell = declarationsFor('.fullscreen-stream-cell');
  assert.match(cell, /position:\s*absolute/);
  assert.match(cell, /overflow:\s*hidden/);
});

test('grid cells contain their stream so a shape change before the next layout is not cropped', () => {
  const video = declarationsFor('.fullscreen-stream-cell video');
  assert.match(video, /object-fit:\s*contain\s*!important/);
  assert.match(video, /width:\s*100%\s*!important/);
  assert.match(video, /height:\s*100%\s*!important/);
});

test("while the grid shows, it covers the tile's own video and hides its label", () => {
  // The stall watchdog counts frames of the tile's own video, and a video
  // that is display:none may stop counting them, so it is covered, not hidden.
  assert.match(declarationsFor('.fullscreen-stream-grid:not([hidden])'), /background:\s*#000/);
  assert.equal(rules.some(rule => rule.selectors.some(selector => /fullscreen-grid-active > video/.test(selector))), false);
  for (const label of [
    '.webcam-tile.is-fullscreen.fullscreen-grid-active > .webcam-tile-label',
    '.screen-share-tile.is-fullscreen.fullscreen-grid-active > .screen-share-tile-label',
  ]) {
    assert.match(declarationsFor(label), /display:\s*none\s*!important/);
  }
});

test('the stream list is a popup like call settings, and the old dropdown is gone', () => {
  const popover = declarationsFor('.fullscreen-stream-popover:not([hidden])');
  assert.match(popover, /position:\s*absolute/);
  assert.match(popover, /bottom:\s*calc\(100% \+ 0\.625rem\)/);
  assert.match(popover, /overflow:\s*auto/);
  assert.equal(stylesheet.includes('.fullscreen-stream-select'), false);
});
