'use strict';

/**
 * With a mouse, a message's toolbar sits at its bottom: beside the reaction
 * chips when it has some, in the corner when not, and always within the list.
 *
 *   node --test test/messageToolbarPlacement.test.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

function load({ fine = true } = {}) {
  const context = vm.createContext({
    module: { exports: {} }, console, t: (k) => k, document: {},
    window: { matchMedia: () => ({ matches: fine }) },
  });
  const src = fs.readFileSync(path.join(ROOT, 'public/js/modules/app-message-actions.js'), 'utf8');
  vm.runInContext(src.replace(/^export default/m, 'module.exports ='), context);
  return Object.create(context.module.exports);
}

const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });

function message({ chips = [], box = rect(100, 100, 800, 80), barBottom = 178, listBottom = 700 }) {
  const bar = {
    style: {}, offsetWidth: 130, offsetHeight: 34, offsetParent: { getBoundingClientRect: () => box },
    getBoundingClientRect: () => rect(760, barBottom - 34, 130, 34),
  };
  return {
    bar,
    querySelector: (sel) => {
      if (sel.includes('toolbar')) return bar;
      if (sel === '.reactions-row') return chips.length ? { children: chips.map(c => ({ getBoundingClientRect: () => c })) } : null;
      return null;
    },
    closest: () => ({ getBoundingClientRect: () => rect(100, 50, 800, listBottom - 50) }),
  };
}

test('with reaction chips it sits just after the last one, level with them', () => {
  const m = message({ chips: [rect(150, 150, 40, 24), rect(194, 150, 40, 24)] });
  load()._placeMessageToolbar(m);
  assert.equal(m.bar.style.left, `${234 - 100 + 8}px`);
  assert.equal(m.bar.style.right, 'auto');
  assert.equal(m.bar.style.bottom, `${180 - 174 - (34 - 24) / 2}px`);
});

test('chips that wrap: it follows the last row', () => {
  const m = message({ chips: [rect(150, 120, 600, 24), rect(150, 150, 40, 24)] });
  load()._placeMessageToolbar(m);
  assert.equal(m.bar.style.left, `${190 - 100 + 8}px`);
});

test('no chips, or no room beside them: the corner from the stylesheet stands', () => {
  const none = message({});
  load()._placeMessageToolbar(none);
  assert.equal(none.bar.style.left, '');
  assert.equal(none.bar.style.bottom, '');

  const wide = message({ chips: [rect(150, 150, 700, 24)] });
  load()._placeMessageToolbar(wide);
  assert.equal(wide.bar.style.left, '', 'it would run off the message');
});

test('on a message running past the bottom of the list it stays in view', () => {
  const m = message({ box: rect(100, 100, 800, 1400), barBottom: 1498, listBottom: 700 });
  load()._placeMessageToolbar(m);
  assert.equal(m.bar.style.bottom, `${2 + 798 + 4}px`);
});

test('a touch screen keeps the toolbar where its stylesheet puts it', () => {
  const m = message({ chips: [rect(150, 150, 40, 24)] });
  m.bar.style = { left: 'stale', right: 'stale', bottom: 'stale' };
  load({ fine: false })._placeMessageToolbar(m);
  assert.deepEqual({ ...m.bar.style }, { left: '', right: '', bottom: '' });
  const css = fs.readFileSync(path.join(ROOT, 'public/css/style-emoji-reactions-threads.css'), 'utf8');
  assert.match(css, /@media \(hover: hover\) and \(pointer: fine\) \{\s*\.msg-toolbar,\s*\.thread-msg-toolbar \{\s*top: auto;\s*bottom: 2px;/, 'the move is for mice only');
});
