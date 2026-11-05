'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'public/js/modules/app-messages.js'), 'utf8');
const VIEW = 400;
const HEIGHT = 50;
function setup() {
  const observers = [];
  const context = vm.createContext({
    module: { exports: {} },
    requestAnimationFrame: () => 0,
    setTimeout: () => 0,
    MutationObserver: class {
      constructor(cb) { this.cb = cb; this.watching = true; observers.push(this); }
      observe() {}
      disconnect() { this.watching = false; }
    }
  });
  vm.runInContext(SOURCE.replace(/^export default/m, 'module.exports ='), context);
  const container = {
    scrollTop: 0,
    clientHeight: VIEW,
    children: [],
    getBoundingClientRect: () => ({ top: 0, bottom: VIEW, height: VIEW }),
    querySelectorAll() { return this.children.slice(); },
    insertBefore(fragment) { this.children.unshift(...fragment.nodes); },
    removeChild(el) { this.children.splice(this.children.indexOf(el), 1); },
    contains(el) { return this.children.includes(el); },
    get scrollHeight() { return this.children.reduce((sum, el) => sum + el.height, 0); },
    get firstChild() { return this.children[0] || null; },
    get firstElementChild() { return this.children[0] || null; },
    get lastElementChild() { return this.children[this.children.length - 1] || null; }
  };
  context.document = {
    getElementById: () => container,
    createDocumentFragment: () => ({ nodes: [], appendChild(node) { this.nodes.push(node); } })
  };
  const make = (id, images = []) => {
    const el = {
      dataset: { msgId: String(id) },
      height: HEIGHT,
      images,
      querySelectorAll: (sel) => (sel === 'img' ? el.images : []),
      getBoundingClientRect() {
        const top = container.children.slice(0, container.children.indexOf(el)).reduce((sum, c) => sum + c.height, 0) - container.scrollTop;
        return { top, bottom: top + el.height, height: el.height };
      }
    };
    return el;
  };
  const app = Object.assign({}, context.module.exports, {
    _suppressCoupleCheck: false,
    _coupledToBottom: false,
    _imageOnPrepend: null,
    _createMessageEl(msg) { return make(msg.id, this._imageOnPrepend && msg.id === 1 ? [this._imageOnPrepend] : []); },
    _fetchLinkPreviews() {},
    _setupVideos() {},
    _decryptE2EImages() {},
    _decryptE2EFiles() {},
    _isDmContainer: () => false,
    _wireBurnMessages() {}
  });
  for (let i = 100; i < 120; i++) container.children.push(make(i));
  container.scrollTop = 0;
  return { app, container, observers, make };
}
const older = (n) => Array.from({ length: n }, (_, i) => ({ id: i + 1 }));
const topVisible = (container) => container.children.find((el) => el.getBoundingClientRect().bottom > 0);
const offsetOf = (el) => el.getBoundingClientRect().top;
test('late growth in older messages keeps a reader who has not moved', () => {
  const { app, container, observers } = setup();
  container.scrollTop = 120;
  const reading = topVisible(container);
  const before = offsetOf(reading);
  app._prependMessages(older(30));
  assert.equal(offsetOf(reading), before);
  container.children[3].height += 120;
  observers[0].cb();
  assert.equal(offsetOf(reading), before);
  assert.equal(observers[0].watching, true);
});
test('late growth does not pull back a reader who scrolled on', () => {
  const { app, container, observers } = setup();
  container.scrollTop = 120;
  app._prependMessages(older(30));
  container.scrollTop -= 1000;
  const reached = container.scrollTop;
  container.children[3].height += 120;
  observers[0].cb();
  assert.equal(container.scrollTop, reached);
  assert.equal(observers[0].watching, false);
});
test('an image finishing in older messages does not pull back a reader who scrolled on', () => {
  const { app, container } = setup();
  const listeners = {};
  app._imageOnPrepend = { complete: false, addEventListener: (type, fn) => { listeners[type] = fn; } };
  container.scrollTop = 120;
  app._prependMessages(older(30));
  container.scrollTop -= 1000;
  const reached = container.scrollTop;
  container.children[3].height += 120;
  listeners.load();
  assert.equal(container.scrollTop, reached);
});
test('an image finishing in older messages still holds a reader who has not moved', () => {
  const { app, container } = setup();
  const listeners = {};
  app._imageOnPrepend = { complete: false, addEventListener: (type, fn) => { listeners[type] = fn; } };
  container.scrollTop = 120;
  const reading = topVisible(container);
  const before = offsetOf(reading);
  app._prependMessages(older(30));
  container.children[3].height += 120;
  listeners.error();
  assert.equal(offsetOf(reading), before);
});
