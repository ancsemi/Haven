'use strict';

/**
 * Desktop custom status discoverability (#5859): the user bar shows your own
 * status (or "Set status"), clicking it opens the picker, and the picker has a
 * clear Set status entry that focuses the text field.
 *
 *   node --test test/statusDiscoverability.test.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'public/js/modules/app-status.js'),
  'utf8'
);

function makeClassList(initial = []) {
  const values = new Set(initial);
  return {
    add: (v) => values.add(v),
    remove: (v) => values.delete(v),
    contains: (v) => values.has(v),
    toggle(v, force) {
      const on = force === undefined ? !values.has(v) : !!force;
      if (on) values.add(v);
      else values.delete(v);
      return on;
    },
    toString() { return [...values].join(' '); },
  };
}

class FakeElement {
  constructor(tagName) {
    this.tagName = String(tagName || 'div').toUpperCase();
    this.children = [];
    this.classList = makeClassList();
    this.style = {};
    this.dataset = {};
    this.attributes = {};
    this.listeners = {};
    this.parentNode = null;
    this.nextSibling = null;
    this._text = '';
    this.value = '';
    this.id = '';
    this.className = '';
    this.title = '';
    this.type = '';
    this.innerHTML = '';
  }
  set className(v) {
    this._className = v;
    this.classList = makeClassList(String(v || '').split(/\s+/).filter(Boolean));
  }
  get className() { return this._className || ''; }
  set textContent(v) { this._text = String(v ?? ''); }
  get textContent() { return this._text; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name]; }
  appendChild(child) {
    child.parentNode = this;
    if (this.children.length) this.children[this.children.length - 1].nextSibling = child;
    this.children.push(child);
    return child;
  }
  insertBefore(child, before) {
    child.parentNode = this;
    const i = this.children.indexOf(before);
    if (i < 0) return this.appendChild(child);
    this.children.splice(i, 0, child);
    return child;
  }
  querySelector(sel) {
    if (sel === '.user-names') return this.children.find(c => c.className.includes('user-names')) || null;
    if (sel.startsWith('#')) {
      const id = sel.slice(1);
      return this._findId(id);
    }
    return null;
  }
  querySelectorAll(sel) {
    if (sel === '.status-option') {
      const out = [];
      const walk = (el) => {
        if (el.className && el.className.split(/\s+/).includes('status-option')) out.push(el);
        (el.children || []).forEach(walk);
      };
      walk(this);
      return out;
    }
    return [];
  }
  _findId(id) {
    if (this.id === id) return this;
    for (const c of this.children) {
      const hit = c._findId?.(id);
      if (hit) return hit;
    }
    return null;
  }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  contains(node) {
    let n = node;
    while (n) {
      if (n === this) return true;
      n = n.parentNode;
    }
    return false;
  }
  focus() { this._focused = true; }
  select() { this._selected = true; }
}

function load() {
  const userNames = new FakeElement('div');
  userNames.className = 'user-names';
  const currentUser = new FakeElement('span');
  currentUser.id = 'current-user';
  currentUser.className = 'current-user';
  const loginName = new FakeElement('span');
  loginName.id = 'login-name';
  loginName.className = 'login-name';
  userNames.appendChild(currentUser);
  userNames.appendChild(loginName);

  const userBar = new FakeElement('div');
  userBar.className = 'user-bar';
  userBar.appendChild(userNames);

  const byId = new Map();
  const document = {
    querySelector: (sel) => (sel === '.user-bar' ? userBar : null),
    getElementById: (id) => byId.get(id) || userBar._findId(id) || null,
    createElement: (tag) => {
      const el = new FakeElement(tag);
      const desc = Object.getOwnPropertyDescriptor(FakeElement.prototype, 'id')
        || { configurable: true, enumerable: true, writable: true };
      // Track ids when set
      Object.defineProperty(el, 'id', {
        get() { return this._id || ''; },
        set(v) { this._id = v; if (v) byId.set(v, el); },
        configurable: true,
      });
      return el;
    },
    addEventListener() {},
  };

  // Patch append/insert to register ids from innerHTML-created tree: the picker
  // is built via innerHTML string, so FakeElement needs a simple parser.
  const origCreate = document.createElement;
  document.createElement = (tag) => {
    const el = origCreate(tag);
    Object.defineProperty(el, 'innerHTML', {
      get() { return this._innerHTML || ''; },
      set(html) {
        this._innerHTML = html;
        // Minimal parse for the options and input we care about.
        this.children = [];
        const optionRe = /<div class="status-option([^"]*)"([^>]*)>([\s\S]*?)<\/div>/g;
        let m;
        while ((m = optionRe.exec(html))) {
          const opt = document.createElement('div');
          opt.className = ('status-option' + m[1]).trim();
          const focus = /data-focus-custom="1"/.test(m[2]);
          const status = /data-status="([^"]+)"/.exec(m[2]);
          if (focus) opt.dataset.focusCustom = '1';
          if (status) opt.dataset.status = status[1];
          opt._text = m[3].replace(/<[^>]+>/g, '').trim();
          this.appendChild(opt);
        }
        if (html.includes('status-text-input')) {
          const input = document.createElement('input');
          input.id = 'status-text-input';
          this.appendChild(input);
        }
      },
      configurable: true,
    });
    return el;
  };

  const sandbox = {
    module: { exports: {} },
    exports: {},
    document,
    window: { innerWidth: 1200, innerHeight: 800 },
    t: (key) => key,
    console,
    setTimeout,
    clearTimeout,
    Object, Array, String, Math, JSON, Error, Promise, RegExp,
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(
    SOURCE.replace(/^\uFEFF/, '').replace(/^export default/m, 'module.exports ='),
    context,
    { filename: 'app-status.js' }
  );
  const app = Object.create(context.module.exports);
  app.userStatus = 'online';
  app.userStatusText = '';
  app.socket = { connected: true, emit() {} };
  app._userPrefs = {};
  app._showToast = () => {};
  app._syncStatusPickerActivity = context.module.exports._syncStatusPickerActivity;
  return { app, document, userBar, userNames, byId };
}

test('user bar shows Set status and a Set status picker entry', () => {
  const { app, document } = load();
  app._setupStatusPicker();
  const line = document.getElementById('user-bar-status-text');
  assert.ok(line, 'status line under the name');
  assert.equal(line.textContent, 'app.profile.set_status');
  assert.ok(line.classList.contains('is-empty'));

  const picker = document.getElementById('status-picker');
  assert.ok(picker);
  const setEntry = picker.children.find((c) => c.dataset.focusCustom === '1');
  assert.ok(setEntry, 'picker has Set status entry');
  assert.match(setEntry.textContent, /set_status/);
});

test('status text fills the user bar and clears the empty state', () => {
  const { app, document } = load();
  app._setupStatusPicker();
  app.userStatusText = 'coding';
  app._updateStatusPickerUI();
  const line = document.getElementById('user-bar-status-text');
  assert.equal(line.textContent, 'coding');
  assert.equal(line.classList.contains('is-empty'), false);
  assert.equal(document.getElementById('status-text-input').value, 'coding');
});

test('Set status picker entry focuses the custom status field', () => {
  const { app, document } = load();
  app._setupStatusPicker();
  app.userStatusText = 'brb';
  app._updateStatusPickerUI();
  const picker = document.getElementById('status-picker');
  picker.style.display = 'block';
  const setEntry = picker.children.find((c) => c.dataset.focusCustom === '1');
  setEntry.listeners.click.forEach((fn) => fn());
  const input = document.getElementById('status-text-input');
  assert.equal(input.value, 'brb');
  assert.equal(input._focused, true);
  assert.equal(picker.style.display, 'block', 'focusing custom status keeps the picker open');
});
