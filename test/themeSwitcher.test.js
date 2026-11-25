'use strict';

// theme.js runs in a small fake page here: enough DOM for the theme picker
// and the Custom editor, so the tests can see which colors end up on :root.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const THEME_SOURCE = fs.readFileSync(path.join(ROOT, 'public/js/theme.js'), 'utf8');
const ThemeCompat = require('../public/js/theme-compat');
const { readCoreCss } = require('./coreCss');

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: key => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => { values.set(key, String(value)); },
    removeItem: key => { values.delete(key); },
    has: key => values.has(key),
  };
}

function inlineStyle() {
  const props = new Map();
  return {
    props,
    setProperty: (key, value) => { props.set(key, String(value)); },
    removeProperty: key => { props.delete(key); },
    getPropertyValue: key => props.get(key) || '',
  };
}

function element(id) {
  const attributes = new Map();
  return {
    id,
    style: inlineStyle(),
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute: (name, value) => { attributes.set(name, String(value)); },
    getAttribute: name => (attributes.has(name) ? attributes.get(name) : null),
    removeAttribute: name => { attributes.delete(name); },
    hasAttribute: name => attributes.has(name),
    addEventListener() {},
    querySelectorAll: () => [],
    querySelector: () => null,
    appendChild: child => child,
  };
}

// A 2D context that accepts every drawing call and draws nothing.
function canvasContext() {
  return new Proxy({}, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === 'createImageData') return () => ({ data: [] });
      return () => {};
    },
  });
}

function canvas(id) {
  return Object.assign(element(id), {
    width: 12,
    height: 12,
    getContext: () => canvasContext(),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 12, height: 12 }),
  });
}

function loadThemePage(stored = {}, { computedColor = '' } = {}) {
  const page = { computedColor };
  const localStorage = memoryStorage(stored);
  const sessionStorage = memoryStorage();
  const root = element('html');
  const nodes = new Map([
    ['theme-selector', element('theme-selector')],
    ['custom-theme-editor', element('custom-theme-editor')],
    ['custom-hue-bar', canvas('custom-hue-bar')],
    ['custom-triangle', canvas('custom-triangle')],
    ['custom-theme-swatch', element('custom-theme-swatch')],
  ]);
  const timers = [];
  const document = {
    documentElement: root,
    body: element('body'),
    head: element('head'),
    hidden: false,
    getElementById: id => nodes.get(id) || null,
    querySelectorAll: () => [],
    querySelector: () => null,
    createElement: tag => element(tag),
    addEventListener() {},
  };
  const window = {
    location: { href: 'http://localhost/app', search: '' },
    HavenThemeCompat: ThemeCompat,
    addEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {} }),
  };
  const context = {
    window,
    document,
    localStorage,
    sessionStorage,
    console,
    setTimeout: fn => { timers.push(fn); return timers.length; },
    clearTimeout() {},
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
    getComputedStyle: () => ({ getPropertyValue: () => '', color: page.computedColor }),
    URLSearchParams,
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
  };
  window.document = document;
  window.localStorage = localStorage;
  vm.createContext(context);
  vm.runInContext(THEME_SOURCE, context, { filename: 'theme.js' });
  const runTimers = () => { while (timers.length) timers.shift()(); };
  Object.assign(page, { context, root, nodes, localStorage, runTimers });
  return page;
}

test('a fresh account keeps Haven colors instead of the Custom palette', () => {
  const page = loadThemePage();
  page.context.initThemeSwitcher('theme-selector');
  page.runTimers();

  assert.equal(page.root.style.props.get('--bg-primary'), undefined, 'no Custom color on :root');
  assert.equal(page.root.style.props.get('--accent'), undefined, 'no Custom accent on :root');
  assert.equal(page.localStorage.has('haven_custom_hsv'), false, 'loading the page does not save a Custom color');
  assert.ok(page.nodes.get('custom-theme-swatch').style.background, 'the Custom button still shows its color');
});

test('a built-in theme is not covered by a Custom color saved earlier', () => {
  const page = loadThemePage({
    haven_theme: 'discord',
    haven_custom_hsv: JSON.stringify({ h: 120, s: 0.8, v: 0.9 }),
  });
  page.context.initThemeSwitcher('theme-selector');
  page.runTimers();

  assert.equal(page.root.style.props.get('--bg-primary'), undefined);
});

test('an account that chose Custom keeps its Custom palette', () => {
  const hsv = { h: 120, s: 0.8, v: 0.9 };
  const page = loadThemePage({ haven_theme: 'custom', haven_custom_hsv: JSON.stringify(hsv) });
  page.context.initThemeSwitcher('theme-selector');
  page.runTimers();

  const expected = page.context.generateCustomPalette(hsv.h, hsv.s, hsv.v, hsv.s, false);
  assert.equal(page.root.style.props.get('--bg-primary'), expected['--bg-primary']);
  assert.equal(page.root.style.props.get('--accent'), expected['--accent']);
});

test('Custom chosen from the server applies even before a color was ever saved', () => {
  const page = loadThemePage();
  page.context.initThemeSwitcher('theme-selector');
  page.runTimers();
  page.context.applyThemeFromServer('custom', true, true);

  assert.ok(page.root.style.props.get('--bg-primary'), 'the default Custom palette is applied');
  assert.equal(page.localStorage.getItem('haven_theme'), 'custom');
});

test('every theme gets light or dark native controls from its own background', () => {
  const light = new Set(['gospel', 'win95', 'daylight', 'cloudy', 'lemonade', 'strawberry', 'amni-scient-light.theme.css', 'braid-light.theme.css']);
  const themes = new Map();
  const core = readCoreCss();
  for (const [, name, color] of core.matchAll(/\[data-theme="([a-z0-9]+)"\]\s*\{[^}]*?--bg-primary:\s*([^;]+);/g)) themes.set(name, color);
  const haven = core.match(/:root,\s*\[data-theme="haven"\]\s*\{[^}]*?--bg-primary:\s*([^;]+);/);
  themes.set('haven', haven[1]);
  const themeDir = path.join(ROOT, 'themes');
  for (const file of fs.readdirSync(themeDir).filter(f => f.endsWith('.theme.css'))) {
    const css = fs.readFileSync(path.join(themeDir, file), 'utf8');
    themes.set(file, css.match(/--bg-primary:\s*([^;]+);/)[1]);
    // A theme that names its scheme must agree with what its colors say.
    const declared = css.match(/color-scheme:\s*(light|dark)\s*;/);
    if (declared) assert.equal(ThemeCompat.colorSchemeFor(themes.get(file)), declared[1], file);
  }
  assert.ok(themes.size > 30, 'built-in and file themes were all found');
  for (const [name, color] of themes) {
    assert.equal(ThemeCompat.colorSchemeFor(color), light.has(name) ? 'light' : 'dark', `${name} (${color})`);
  }
});

test('the color scheme reader understands the color syntaxes a theme can use', () => {
  assert.equal(ThemeCompat.colorSchemeFor('#fff'), 'light');
  assert.equal(ThemeCompat.colorSchemeFor('#000000'), 'dark');
  assert.equal(ThemeCompat.colorSchemeFor('#F3F2EF'), 'light');
  assert.equal(ThemeCompat.colorSchemeFor('rgb(250, 248, 245)'), 'light');
  assert.equal(ThemeCompat.colorSchemeFor('rgb(25 27 40)'), 'dark');
  assert.equal(ThemeCompat.colorSchemeFor('rgba(245, 247, 250, 0.95)'), 'light');
  assert.equal(ThemeCompat.colorSchemeFor('color(srgb 0.98 0.97 0.96)'), 'light');
  assert.equal(ThemeCompat.colorSchemeFor('rgba(0, 0, 0, 0)'), null, 'transparent says nothing');
  assert.equal(ThemeCompat.colorSchemeFor('oklch(0.9 0.1 200)'), null);
  assert.equal(ThemeCompat.colorSchemeFor(''), null);
  assert.equal(ThemeCompat.colorSchemeFor('#12'), null);
});

test('Custom and RGB set the scheme from their light or dark base', () => {
  const page = loadThemePage();
  for (const hue of [0, 60, 120, 200, 260, 320]) {
    page.context.applyCustomVars(page.context.generateCustomPalette(hue, 0.75, 0.95, 0.75, true));
    assert.equal(page.root.getAttribute('data-color-scheme'), 'light', `light base, hue ${hue}`);
    page.context.applyCustomVars(page.context.generateCustomPalette(hue, 0.75, 0.95, 0.75, false));
    assert.equal(page.root.getAttribute('data-color-scheme'), 'dark', `dark base, hue ${hue}`);
  }
  assert.equal(page.localStorage.getItem('haven_color_scheme'), 'dark', 'stored for the next first paint');
});

test('switching to a built-in theme measures its background again', () => {
  const page = loadThemePage({}, { computedColor: 'rgb(25, 27, 40)' });
  page.runTimers();
  assert.equal(page.root.getAttribute('data-color-scheme'), 'dark');

  page.computedColor = 'rgb(250, 248, 245)';
  page.context.applyThemeFromServer('daylight', true, true);
  page.runTimers();
  assert.equal(page.root.getAttribute('data-color-scheme'), 'light');
  assert.equal(page.localStorage.getItem('haven_color_scheme'), 'light');
});

test('every native select and its options use the theme input colors', () => {
  const core = readCoreCss();
  assert.match(core, /:where\(:root\)\s*\{\s*color-scheme:\s*dark;\s*\}/);
  assert.match(core, /:where\(:root\[data-color-scheme="light"\]\)\s*\{\s*color-scheme:\s*light;\s*\}/);
  const select = core.match(/:where\(select\)\s*\{([^}]*)\}/);
  assert.ok(select, 'a base rule for every select');
  assert.match(select[1], /background-color:\s*var\(--bg-input\)/);
  assert.match(select[1], /color:\s*var\(--text-primary\)/);
  assert.match(select[1], /border:\s*1px solid var\(--border\)/);
  assert.match(core, /:where\(select:focus\)\s*\{\s*border-color:\s*var\(--accent\);\s*\}/);
  const option = core.match(/:where\(select option, select optgroup\)\s*\{([^}]*)\}/);
  assert.ok(option, 'a base rule for every option');
  assert.match(option[1], /background-color:\s*var\(--bg-input\)/);
  assert.match(option[1], /color:\s*var\(--text-primary\)/);
});
test('Custom without a separate highlight color makes the palette it always did', () => {
  const page = loadThemePage();
  const golden = { '120,0.8,0.9,false': ['#2ee62e', '#59ff59', '#12b312', 'rgba(46,230,46, 0.31)', '#f252f2', '#111811'], '260,0.75,0.95,false': ['#793df2', '#9966ff', '#531dbf', 'rgba(121,61,242, 0.30)', '#bef255', '#131118'], '30,0.4,0.6,true': ['#997a5c', '#bfa78f', '#664d33', 'rgba(153,122,92, 0.23)', '#3b648c', '#fbf7f4'], '200,1,1,true': ['#0092db', '#26b7ff', '#0070a8', 'rgba(0,170,255, 0.35)', '#8c4b2a', '#ecf6fb'] };
  for (const [key, want] of Object.entries(golden)) {
    const [h, s, v, light] = key.split(',');
    const p = page.context.generateCustomPalette(+h, +s, +v, +s, light === 'true');
    assert.deepEqual([p['--accent'], p['--accent-hover'], p['--accent-dim'], p['--accent-glow'], p['--text-link'], p['--bg-primary']], want);
    assert.deepEqual(page.context.generateCustomPalette(+h, +s, +v, +s, light === 'true', { h: +h, s: +s, v: +v }), p);
  }
});
test('a separate highlight color changes the accent and link colors and leaves the background alone', () => {
  const page = loadThemePage();
  const plain = page.context.generateCustomPalette(120, 0.8, 0.9, 0.8, false);
  const split = page.context.generateCustomPalette(120, 0.8, 0.9, 0.8, false, { h: 20, s: 0.9, v: 0.95 });
  const alone = page.context.generateCustomPalette(20, 0.9, 0.95, 0.8, false);
  for (const key of ['--accent', '--accent-hover', '--accent-dim', '--accent-glow', '--text-link']) {
    assert.equal(split[key], alone[key]);
    assert.notEqual(split[key], plain[key]);
  }
  for (const key of ['--bg-primary', '--bg-secondary', '--bg-card', '--border', '--text-primary', '--success', '--danger']) assert.equal(split[key], plain[key]);
});
test('an account with a saved highlight color gets it on Custom and a damaged one is ignored', () => {
  const hsv = { h: 120, s: 0.8, v: 0.9, a: { h: 20, s: 0.9, v: 0.95 } };
  const page = loadThemePage({ haven_theme: 'custom', haven_custom_hsv: JSON.stringify(hsv) });
  page.context.initThemeSwitcher('theme-selector');
  page.runTimers();
  const expected = page.context.generateCustomPalette(120, 0.8, 0.9, 0.8, false, hsv.a);
  assert.equal(page.root.style.props.get('--accent'), expected['--accent']);
  assert.equal(page.root.style.props.get('--bg-primary'), expected['--bg-primary']);
  const bad = loadThemePage({ haven_theme: 'custom', haven_custom_hsv: JSON.stringify({ h: 120, s: 0.8, v: 0.9, a: { h: 'x' } }) });
  bad.context.initThemeSwitcher('theme-selector');
  bad.runTimers();
  assert.equal(bad.root.style.props.get('--accent'), page.context.generateCustomPalette(120, 0.8, 0.9, 0.8, false)['--accent']);
});
