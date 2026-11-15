'use strict';

// A small stand-in DOM for tests of code that builds elements itself (the
// call settings panel). It covers what that code uses: attributes, children,
// text, events, styles, simple selectors and an HTML parser for fixtures.
// Not a general DOM.

const REFLECTED = ['id', 'title', 'type', 'min', 'max', 'placeholder'];

class FakeText {
  constructor(text) { this.nodeType = 3; this.textContent = String(text); this.parentNode = null; }
}

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.nodeType = 1;
    this.tagName = String(tagName).toLowerCase();
    this.ownerDocument = ownerDocument;
    this.childNodes = [];
    this.parentNode = null;
    this.attributes = {};
    this.style = {};
    this.dataset = {};
    this.listeners = {};
    this._value = undefined;
    this.disabled = false;
    this.hidden = false;
    const classes = new Set();
    this.classList = {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, force) => {
        const on = force === undefined ? !classes.has(c) : force;
        if (on) classes.add(c); else classes.delete(c);
        return on;
      },
      _all: () => [...classes],
    };
  }

  get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
  get parentElement() { return this.parentNode; }
  get options() { return this.children.filter((c) => c.tagName === 'option'); }
  get firstChild() { return this.childNodes[0] || null; }

  get className() { return this.attributes.class || this.classList._all().join(' '); }
  set className(v) { this.attributes.class = String(v); String(v).split(/\s+/).filter(Boolean).forEach((c) => this.classList.add(c)); }

  get textContent() {
    return this.childNodes.map((n) => n.textContent).join('');
  }
  set textContent(v) {
    this.childNodes.forEach((n) => { n.parentNode = null; });
    this.childNodes = [];
    if (v !== '' && v != null) this.appendChild(new FakeText(v));
  }

  get value() {
    if (this.tagName === 'select') {
      const opts = this.options;
      if (this._value !== undefined && opts.some((o) => o.value === this._value)) return this._value;
      return opts.length ? opts[0].value : '';
    }
    if (this._value !== undefined) return this._value;
    return this.attributes.value !== undefined ? this.attributes.value : '';
  }
  set value(v) { this._value = String(v); }

  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
  append(...nodes) { nodes.forEach((n) => this.appendChild(typeof n === 'string' ? new FakeText(n) : n)); }
  removeChild(child) {
    this.childNodes = this.childNodes.filter((n) => n !== child);
    child.parentNode = null;
    return child;
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  replaceChildren(...nodes) {
    this.childNodes.forEach((n) => { n.parentNode = null; });
    this.childNodes = [];
    this.append(...nodes);
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === 'class') {
      this.classList._all().forEach((c) => this.classList.remove(c));
      String(value).split(/\s+/).filter(Boolean).forEach((c) => this.classList.add(c));
    }
    if (name.startsWith('data-')) {
      this.dataset[name.slice(5).replace(/-([a-z])/g, (_, l) => l.toUpperCase())] = String(value);
    }
    if (name === 'disabled') this.disabled = true;
  }
  getAttribute(name) {
    if (name === 'class') return this.className || null;
    return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
  }
  hasAttribute(name) { return this.getAttribute(name) !== null; }
  removeAttribute(name) { delete this.attributes[name]; }

  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  removeEventListener(type, fn) {
    this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn);
  }
  /** Run the listeners for an event, the way the browser would. */
  dispatch(type, extra = {}) {
    const event = {
      type, target: this, currentTarget: this, defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() {},
      ...extra,
    };
    for (const fn of [...(this.listeners[type] || [])]) fn(event);
    return event;
  }
  listenerCount() {
    return Object.values(this.listeners).reduce((n, list) => n + list.length, 0);
  }

  focus() { if (this.ownerDocument) this.ownerDocument.activeElement = this; }
  blur() {
    if (this.ownerDocument && this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = null;
    this.dispatch('blur');
  }
  select() {}

  cloneNode(deep) {
    const copy = new FakeElement(this.tagName, this.ownerDocument);
    Object.entries(this.attributes).forEach(([k, v]) => copy.setAttribute(k, v));
    if (this._value !== undefined) copy._value = this._value;
    if (deep) this.childNodes.forEach((n) => copy.appendChild(n.nodeType === 3 ? new FakeText(n.textContent) : n.cloneNode(true)));
    return copy;
  }

  _matches(selector) {
    if (selector === '*') return true;
    const parts = selector.match(/^([a-z0-9]+)?(#[\w-]+)?((?:\.[\w-]+)*)(?:\[([\w-]+)(?:="([^"]*)")?\])?$/i);
    if (!parts) return false;
    const [, tag, id, classes, attr, attrValue] = parts;
    if (tag && this.tagName !== tag.toLowerCase()) return false;
    if (id && this.attributes.id !== id.slice(1)) return false;
    if (classes) for (const c of classes.split('.').filter(Boolean)) if (!this.classList.contains(c)) return false;
    if (attr) {
      const v = this.getAttribute(attr);
      if (v === null) return false;
      if (attrValue !== undefined && v !== attrValue) return false;
    }
    return true;
  }
  querySelectorAll(selector) {
    const selectors = selector.split(',').map((s) => s.trim());
    const found = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (selectors.some((s) => child._matches(s))) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }

  /** Attributes as the browser would serialize them (static markup only). */
  serializedAttributes() {
    const out = { ...this.attributes };
    if (this.classList._all().length) out.class = this.classList._all().join(' ');
    return out;
  }
}
REFLECTED.forEach((name) => {
  Object.defineProperty(FakeElement.prototype, name, {
    get() { return this.attributes[name] ?? ''; },
    set(v) { this.setAttribute(name, v); },
  });
});

function makeDocument() {
  const doc = {
    activeElement: null,
    createElement: (tag) => new FakeElement(tag, doc),
    createTextNode: (text) => new FakeText(text),
    getElementById(id) { return doc.body.querySelector(`#${id}`); },
  };
  doc.body = new FakeElement('body', doc);
  return doc;
}

// ── HTML fixture parser: tags, attributes and text; no scripts or comments ─
const VOID = new Set(['input', 'br', 'img', 'hr']);

function parseHtml(html) {
  const root = { tag: '#root', attrs: {}, children: [] };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<\/([a-z0-9]+)\s*>|<([a-z0-9]+)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)/gi;
  const unescape = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
  let m;
  while ((m = re.exec(html))) {
    const [all, closing, opening, rawAttrs, selfClose, text] = m;
    if (all.startsWith('<!--')) continue;
    if (closing) { stack.pop(); continue; }
    if (opening) {
      const attrs = {};
      const attrRe = /([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
      let a;
      while ((a = attrRe.exec(rawAttrs || ''))) {
        attrs[a[1]] = unescape(a[2] ?? a[3] ?? a[4] ?? '');
      }
      const node = { tag: opening.toLowerCase(), attrs, children: [] };
      stack[stack.length - 1].children.push(node);
      if (!VOID.has(node.tag) && !selfClose) stack.push(node);
      continue;
    }
    if (text && text.trim() !== '') {
      stack[stack.length - 1].children.push({ text: unescape(text).replace(/\s+/g, ' ') });
    }
  }
  return root.children;
}

/** The same tree shape as parseHtml, from a FakeElement. */
function toTree(node) {
  if (node.nodeType === 3) return { text: node.textContent.replace(/\s+/g, ' ') };
  return {
    tag: node.tagName,
    attrs: node.serializedAttributes(),
    children: node.childNodes
      .filter((c) => !(c.nodeType === 3 && c.textContent.trim() === ''))
      .map(toTree),
  };
}

module.exports = { FakeElement, FakeText, makeDocument, parseHtml, toTree };
