'use strict';

/**
 * Fullscreen stream grid layout: how several streams of different shapes are
 * placed on one screen. Streams keep their order and are split into rows; each
 * row shares a height and each stream takes the width its shape needs.
 *
 *   node --test test/fullscreenStreamGridLayout.test.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'public/js/modules/app-screen-webcam.js'),
  'utf8'
);

function loadLayout() {
  const context = vm.createContext({ module: { exports: {} }, t: key => key });
  vm.runInContext(source.replace(/^export default/m, 'module.exports ='), context, {
    filename: 'app-screen-webcam.js',
  });
  const methods = context.module.exports;
  return (...args) => methods._computeFullscreenGridLayout(...args);
}

const layout = loadLayout();
const WIDE = 16 / 9;
const TALL = 9 / 16;

function rowsOf(rects) {
  const rows = [];
  for (const rect of rects) {
    const row = rows.find(item => Math.abs(item.y - rect.y) < 0.5);
    if (row) row.count++;
    else rows.push({ y: rect.y, count: 1 });
  }
  return rows.sort((a, b) => a.y - b.y).map(row => row.count);
}

function assertInside(rects, width, height) {
  for (const rect of rects) {
    assert.ok(rect.x >= -0.5 && rect.y >= -0.5, `rect starts on screen: ${JSON.stringify(rect)}`);
    assert.ok(rect.x + rect.w <= width + 0.5, `rect fits the width: ${JSON.stringify(rect)}`);
    assert.ok(rect.y + rect.h <= height + 0.5, `rect fits the height: ${JSON.stringify(rect)}`);
  }
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i];
      const b = rects[j];
      const overlap = a.x < b.x + b.w - 0.5 && b.x < a.x + a.w - 0.5 &&
        a.y < b.y + b.h - 0.5 && b.y < a.y + a.h - 0.5;
      assert.equal(overlap, false, `rects ${i} and ${j} overlap`);
    }
  }
}

test('one stream fills the screen at its own shape', () => {
  const { rects } = layout([WIDE], 1600, 900, { gap: 8 });
  assert.equal(rects.length, 1);
  assert.ok(Math.abs(rects[0].w - 1600) < 1);
  assert.ok(Math.abs(rects[0].h - 900) < 1);
});

test('every cell keeps the shape of its stream', () => {
  const ratios = [WIDE, TALL, 4 / 3, 21 / 9, 1];
  const { rects } = layout(ratios, 1600, 900, { gap: 8 });
  rects.forEach((rect, index) => {
    assert.ok(Math.abs(rect.w / rect.h - ratios[index]) < 0.01, `cell ${index} keeps its shape`);
  });
});

test('two wide streams sit side by side on a wide screen', () => {
  const { rects } = layout([WIDE, WIDE], 1600, 900, { gap: 8 });
  assert.deepEqual(rowsOf(rects), [2]);
  assertInside(rects, 1600, 900);
});

test('two wide streams stack on a screen held upright', () => {
  const { rects } = layout([WIDE, WIDE], 900, 1600, { gap: 8 });
  assert.deepEqual(rowsOf(rects), [1, 1]);
  assertInside(rects, 900, 1600);
});

test('a phone camera held upright gets a narrow slot beside a wide share', () => {
  const { rects } = layout([WIDE, TALL], 1600, 900, { gap: 8 });
  assert.deepEqual(rowsOf(rects), [2]);
  assert.ok(Math.abs(rects[0].h - rects[1].h) < 0.5, 'one row shares a height');
  assert.ok(rects[1].w < rects[0].w / 2, 'the upright camera is narrow');
  assertInside(rects, 1600, 900);
});

test('an ultrawide share takes its own row above two wide streams', () => {
  const { rects } = layout([32 / 9, WIDE, WIDE], 1600, 900, { gap: 8 });
  assert.deepEqual(rowsOf(rects), [1, 2]);
  assertInside(rects, 1600, 900);
});

test('streams keep their order across the rows', () => {
  const { rects } = layout([WIDE, WIDE, WIDE, WIDE, WIDE], 1600, 900, { gap: 8 });
  for (let i = 1; i < rects.length; i++) {
    const before = rects[i - 1];
    const here = rects[i];
    assert.ok(here.y > before.y + 0.5 || (Math.abs(here.y - before.y) < 0.5 && here.x > before.x),
      `stream ${i} comes after stream ${i - 1}`);
  }
  assertInside(rects, 1600, 900);
});

test('the layout is centered on the screen', () => {
  const { rects } = layout([TALL], 1600, 900, { gap: 8 });
  const centerX = rects[0].x + rects[0].w / 2;
  const centerY = rects[0].y + rects[0].h / 2;
  assert.ok(Math.abs(centerX - 800) < 1);
  assert.ok(Math.abs(centerY - 450) < 1);
});

test('a slightly better split does not replace the current one', () => {
  const first = layout([WIDE, WIDE], 1600, 900, { gap: 8 });
  const sameAgain = layout([WIDE, WIDE], 1600, 900, { gap: 8, previousKey: first.key });
  assert.equal(sameAgain.key, first.key);

  // Stacked rows score a little lower here than side by side, so a layout
  // already stacked stays stacked instead of flipping.
  const stackedKey = '1,1';
  const kept = layout([WIDE, WIDE], 1600, 900, { gap: 8, previousKey: stackedKey });
  assert.equal(kept.key, stackedKey);
  assert.deepEqual(rowsOf(kept.rects), [1, 1]);
});

test('a much better split replaces the current one', () => {
  // An upright camera stacked under a wide share is far smaller than side by side.
  const result = layout([WIDE, TALL], 1600, 900, { gap: 8, previousKey: '1,1' });
  assert.equal(result.key, '2');
});

test('a previous split for a different number of streams is ignored', () => {
  const result = layout([WIDE, WIDE, WIDE], 1600, 900, { gap: 8, previousKey: '1,1' });
  assert.notEqual(result.key, '1,1');
  assert.equal(result.rects.length, 3);
});

test('many streams are laid out quickly and stay on screen', () => {
  const ratios = Array.from({ length: 16 }, (_, index) => (index % 3 === 0 ? TALL : WIDE));
  const started = process.hrtime.bigint();
  const { rects } = layout(ratios, 1920, 1080, { gap: 8 });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(rects.length, 16);
  assertInside(rects, 1920, 1080);
  assert.ok(elapsedMs < 50, `took ${elapsedMs}ms`);
});

test('no streams give no cells, and a screen with no size does not break', () => {
  assert.equal(layout([], 1600, 900, { gap: 8 }).rects.length, 0);
  const [rect] = layout([WIDE], 0, 0, { gap: 8 }).rects;
  assert.deepEqual([rect.x, rect.y, rect.w, rect.h], [0, 0, 0, 0]);
});
