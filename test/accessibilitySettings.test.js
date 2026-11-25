'use strict';

// Settings > Accessibility: message text size, spacing, a readable font, high
// contrast, reduce motion, underlined links and larger click targets.
// theme-init.js reads and applies every option before first paint and hands
// the same functions to the settings page as window.HavenA11y, so most of
// this runs that file the way a browser does and checks what lands on <html>.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { readCoreCss } = require('./coreCss');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const THEME_INIT_SOURCE = read('public/js/theme-init.js');

class MemoryStorage {
  constructor(initial = {}) { this.values = new Map(Object.entries(initial)); }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

function runThemeInit(stored = {}, { osReduce = false } = {}) {
  const attributes = new Map();
  const props = new Map();
  const classes = new Set();
  const events = [];
  const queryListeners = [];
  const motionQuery = {
    matches: osReduce,
    addEventListener(type, fn) { queryListeners.push(fn); },
  };
  const documentElement = {
    style: {
      setProperty(name, value) { props.set(name, value); },
      removeProperty(name) { props.delete(name); },
    },
    classList: {
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      contains(name) { return classes.has(name); },
    },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    removeAttribute(name) { attributes.delete(name); },
    hasAttribute(name) { return attributes.has(name); },
  };
  const document = {
    documentElement,
    head: { appendChild() {} },
    createElement() { return {}; },
    getElementById() { return null; },
    dispatchEvent(event) { events.push(event); },
  };
  const localStorage = new MemoryStorage(stored);
  const window = {
    location: { search: '' },
    scrollX: 0,
    scrollY: 0,
    scrollTo() {},
    addEventListener() {},
    matchMedia(query) {
      assert.equal(query, '(prefers-reduced-motion: reduce)');
      return motionQuery;
    },
  };
  vm.runInNewContext(THEME_INIT_SOURCE, {
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    URLSearchParams,
    document,
    history: {},
    localStorage,
    sessionStorage: new MemoryStorage(),
    setTimeout() { return 1; },
    window,
  });
  const flipOs = (matches) => {
    motionQuery.matches = matches;
    queryListeners.forEach((fn) => fn());
  };
  return { attributes, props, classes, events, localStorage, window, flipOs };
}

test('a fresh device gets every option at its default before first paint', () => {
  const { attributes, props, classes } = runThemeInit();
  assert.equal(props.get('--msg-text-scale'), '1');
  assert.equal(attributes.get('data-text-size'), '100');
  assert.equal(attributes.get('data-line-spacing'), 'normal');
  assert.equal(attributes.get('data-letter-spacing'), 'normal');
  assert.equal(attributes.get('data-readable-font'), 'theme');
  assert.equal(attributes.get('data-contrast'), 'normal');
  assert.equal(attributes.get('data-reduce-motion'), 'system');
  assert.equal(attributes.get('data-underline-links'), 'off');
  assert.equal(attributes.get('data-large-targets'), 'off');
  assert.equal(classes.has('reduce-motion'), false);
});

test('saved options are on <html> before first paint', () => {
  const { attributes, props, classes } = runThemeInit({
    'haven-text-size': '150',
    'haven-line-spacing': 'loose',
    'haven-letter-spacing': 'wide',
    'haven-readable-font': 'hyperlegible',
    'haven-contrast': 'high',
    'haven-reduce-motion': 'on',
    'haven-underline-links': '1',
    'haven-large-targets': '1',
  });
  assert.equal(props.get('--msg-text-scale'), '1.5');
  assert.equal(attributes.get('data-text-size'), '150');
  assert.equal(attributes.get('data-line-spacing'), 'loose');
  assert.equal(attributes.get('data-letter-spacing'), 'wide');
  assert.equal(attributes.get('data-readable-font'), 'hyperlegible');
  assert.equal(attributes.get('data-contrast'), 'high');
  assert.equal(attributes.get('data-underline-links'), 'on');
  assert.equal(attributes.get('data-large-targets'), 'on');
  assert.equal(classes.has('reduce-motion'), true);
});

test('out-of-range and unknown values fall back instead of breaking the page', () => {
  const big = runThemeInit({ 'haven-text-size': '900', 'haven-line-spacing': 'huge', 'haven-readable-font': 'comic' });
  assert.equal(big.attributes.get('data-text-size'), '200');
  assert.equal(big.attributes.get('data-line-spacing'), 'normal');
  assert.equal(big.attributes.get('data-readable-font'), 'theme');
  const small = runThemeInit({ 'haven-text-size': '10' });
  assert.equal(small.props.get('--msg-text-scale'), '0.8');
});

test('"Follow system" tracks the OS setting, live, and announces the change', () => {
  const page = runThemeInit({}, { osReduce: true });
  assert.equal(page.classes.has('reduce-motion'), true);
  assert.equal(page.events.length, 0, 'nothing to announce on the first paint');
  page.flipOs(false);
  assert.equal(page.classes.has('reduce-motion'), false);
  assert.deepEqual(page.events.map((e) => [e.type, e.detail.reduce]), [['haven:reduce-motion-change', false]]);
});

test('an explicit Off wins over the OS, and On wins without it', () => {
  assert.equal(runThemeInit({ 'haven-reduce-motion': 'off' }, { osReduce: true }).classes.has('reduce-motion'), false);
  assert.equal(runThemeInit({ 'haven-reduce-motion': 'on' }, { osReduce: false }).classes.has('reduce-motion'), true);
});

test('the settings page re-applies through window.HavenA11y after saving', () => {
  const page = runThemeInit();
  page.localStorage.setItem('haven-reduce-motion', 'on');
  page.localStorage.setItem('haven-text-size', '125');
  page.window.HavenA11y.apply(page.window.HavenA11y.read());
  assert.equal(page.props.get('--msg-text-scale'), '1.25');
  assert.equal(page.classes.has('reduce-motion'), true);
  assert.equal(page.window.HavenA11y.reducedMotion(), true);
  assert.equal(page.events.at(-1).type, 'haven:reduce-motion-change');
});

test('reduced motion keeps the CRT effect class off the first frame', () => {
  const { classes } = runThemeInit({ haven_effects: '["crt"]', 'haven-reduce-motion': 'on' });
  assert.equal(classes.has('fx-crt'), false);
  assert.equal(runThemeInit({ haven_effects: '["crt"]' }).classes.has('fx-crt'), true);
});

test('every reduced-motion rule keys off the one html.reduce-motion class', () => {
  const css = readCoreCss();
  assert.doesNotMatch(css, /prefers-reduced-motion/, 'the OS setting reaches CSS only through theme-init.js');
  assert.match(css, /html\.reduce-motion \.role-gradient\.role-shimmer \{ animation: none; \}/);
  assert.match(css, /html\.reduce-motion \*,/);
});

test('message text, the message boxes and code blocks scale, and only once a size is picked', () => {
  const css = read('public/css/style-accessibility.css');
  const scaled = (selector, base) => new RegExp(`:root\\[data-text-size\\]:not\\(\\[data-text-size="100"\\]\\) ${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{ font-size: calc\\(${base.replace('.', '\\.')}rem \\* var\\(--msg-text-scale, 1\\)\\) !important; \\}`);
  for (const [selector, base] of [
    ['.message-content', '0.875'],
    ['.thread-msg-content', '0.8125'],
    ['.thread-topic-body', '0.95'],
    ['.code-block pre', '0.8125'],
    [':is(.message-input-area textarea, .edit-textarea)', '0.875'],
    ['.thread-input', '0.8125'],
  ]) assert.match(css, scaled(selector, base), `${selector} scales`);
  // A topic body is also .message-content, so its own size must come later to win the tie.
  assert.ok(css.indexOf(') .thread-topic-body {') > css.indexOf(') .message-content {'));
  // The phone layout keeps the message box at 1rem or more, or iOS zooms in on focus.
  assert.match(css, /font-size: max\(1rem, calc\(0\.875rem \* var\(--msg-text-scale, 1\)\)\) !important;/);
});

test('density and the pop-out DM keep their own message size under a picked text size', () => {
  const css = read('public/css/style-accessibility.css');
  for (const [selector, base] of [
    ['[data-density="compact"] .message-content', '0.8125'],
    ['[data-density="spacious"] .message-content', '0.9375'],
    [' .dm-pip-messages .message-content', '0.8125'],
    [' .dm-pip-input', '0.8125'],
  ]) {
    assert.ok(css.includes(`:root[data-text-size]:not([data-text-size="100"])${selector} { font-size: calc(${base}rem * var(--msg-text-scale, 1)) !important; }`), `${selector.trim()} scales from ${base}rem`);
  }
  // Each comes after the plain message rule, so it wins where both match.
  assert.ok(css.indexOf('.dm-pip-messages .message-content {') > css.indexOf('[data-density="spacious"] .message-content {'));
  assert.ok(css.indexOf('[data-density="compact"] .message-content {') > css.indexOf(') .message-content {'));
});

test('the readable fonts are self-hosted with their licenses', () => {
  const css = read('public/css/style-accessibility.css');
  const files = [...css.matchAll(/url\('\/fonts\/([^']+)'\)/g)].map((m) => m[1]);
  assert.ok(files.length >= 6);
  for (const file of files) {
    const buf = fs.readFileSync(path.join(ROOT, 'public/fonts', file));
    assert.equal(buf.subarray(0, 4).toString('latin1'), 'wOF2', `${file} is a woff2 file`);
  }
  assert.match(read('public/fonts/OFL-AtkinsonHyperlegible.txt'), /SIL Open Font License, Version 1\.1/);
  assert.match(read('public/fonts/OFL-OpenDyslexic.txt'), /Reserved Font Name OpenDyslexic/);
  const notice = read('public/fonts/NOTICE.txt');
  assert.match(notice, /Atkinson Hyperlegible/);
  assert.match(notice, /OpenDyslexic/);
});

test('theme effects stand down under reduced motion and come back after', () => {
  const src = read('public/js/theme.js');
  assert.match(src, /if \(mode === 'none' \|\| _motionReduced\(\)\) return;/);
  assert.match(src, /document\.addEventListener\('haven:reduce-motion-change', \(\) => \{\s*if \(_lastEffectsArgs\) applyEffects\(\.\.\._lastEffectsArgs\);/);
  // The RGB theme holds its colors instead of cycling.
  assert.match(src, /if \(document\.hidden \|\| _motionReduced\(\)\)/);
});

test('animated pictures wait for hover when motion is reduced', () => {
  const src = read('public/js/modules/app-appearance.js');
  assert.match(src, /return this\._motionReduced\(\) \? 'hover' : 'always';/);
  assert.match(src, /if \(v === 'always' && !this\._motionReduced\(\)\) return v;/);
  // Custom emoji are pictures in chat too.
  assert.doesNotMatch(src, /img\.chat-image\[data-chat-animated-src\]/);
});

test('no scroll glides past reduced motion', () => {
  const dir = path.join(ROOT, 'public/js/modules');
  for (const file of fs.readdirSync(dir)) {
    assert.doesNotMatch(fs.readFileSync(path.join(dir, file), 'utf8'), /behavior: 'smooth'/, `${file} should use this._scrollBehavior()`);
  }
});

test('every control in the Accessibility section has a name', () => {
  const html = read('public/app.html');
  const start = html.indexOf('<div class="settings-section" id="section-zoom"');
  const section = html.slice(start, html.indexOf('<!-- Emoji Reaction Size -->', start));
  for (const id of ['ui-zoom-slider', 'text-size-slider', 'text-size-out-btn', 'text-size-in-btn']) {
    assert.match(section, new RegExp(`id="${id}"[^>]*aria-label="`), `${id} has an aria-label`);
  }
  for (const id of ['line-spacing-picker', 'letter-spacing-picker', 'reduce-motion-picker', 'readable-font-select']) {
    const labelled = section.match(new RegExp(`id="${id}"[^>]*aria-labelledby="([^"]+)"`));
    assert.ok(labelled, `${id} is labelled`);
    assert.match(section, new RegExp(`id="${labelled[1]}"`), `${id}'s label exists`);
  }
  for (const id of ['a11y-high-contrast', 'a11y-underline-links', 'a11y-large-targets']) {
    assert.match(section, new RegExp(`<label class="toggle-row">\\s*<span[^>]*>[^<]+</span>\\s*<input type="checkbox" id="${id}">`), `${id} sits in its label`);
  }
});

test('icon-only buttons in the channel header and message box have a name', () => {
  const html = read('public/app.html');
  for (const id of ['search-toggle-btn', 'pinned-toggle-btn', 'gallery-toggle-btn', 'threads-toggle-btn', 'upload-btn', 'emoji-btn', 'poll-btn', 'time-btn', 'format-btn', 'voice-btn', 'composer-plus-btn', 'send-btn']) {
    assert.match(html, new RegExp(`<button id="${id}"[^>]*data-i18n-aria-label="[^"]+" aria-label="[^"]+"`), `${id} has a translated aria-label`);
  }
});

test('the settings nav rows are keyboard reachable and say which picker button is on', () => {
  const settings = read('public/js/modules/app-settings.js');
  assert.match(settings, /item\.tabIndex = 0;/);
  assert.match(settings, /if \(e\.key !== 'Enter' && e\.key !== ' '\) return;/);
  assert.match(read('public/js/modules/app-appearance.js'), /btn\.setAttribute\('aria-pressed', on \? 'true' : 'false'\);/);
});

test('every Accessibility string the page asks for exists in en.json', () => {
  const en = JSON.parse(read('public/locales/en.json'));
  const html = read('public/app.html');
  const keys = [...html.matchAll(/data-i18n(?:-title|-aria-label)?="(settings\.accessibility\.[^"]+|settings\.nav\.accessibility)"/g)].map((m) => m[1]);
  assert.ok(keys.length > 20);
  for (const key of keys) {
    const value = key.split('.').reduce((o, k) => (o ? o[k] : undefined), en);
    assert.equal(typeof value, 'string', `${key} is in en.json`);
  }
});
test('Lite mode is off on a fresh device and on <html> before first paint when saved', () => {
  const fresh = runThemeInit();
  assert.equal(fresh.attributes.get('data-lite-mode'), 'off');
  assert.equal(fresh.classes.has('lite-mode'), false);
  assert.equal(fresh.classes.has('reduce-motion'), false);
  const on = runThemeInit({ 'haven-lite-mode': '1', 'haven-reduce-motion': 'off' });
  assert.equal(on.attributes.get('data-lite-mode'), 'on');
  assert.equal(on.classes.has('lite-mode'), true);
  assert.equal(on.classes.has('reduce-motion'), true, 'Lite mode reuses Reduce Motion, even when that is set to Off');
  assert.equal(on.window.HavenA11y.lite(), true);
});

test('switching Lite mode live announces it and releases Reduce Motion again', () => {
  const page = runThemeInit();
  page.localStorage.setItem('haven-lite-mode', '1');
  page.window.HavenA11y.apply(page.window.HavenA11y.read());
  assert.deepEqual(page.events.map((e) => e.type), ['haven:reduce-motion-change', 'haven:lite-mode-change']);
  page.localStorage.removeItem('haven-lite-mode');
  page.window.HavenA11y.apply(page.window.HavenA11y.read());
  assert.equal(page.classes.has('lite-mode'), false);
  assert.equal(page.classes.has('reduce-motion'), false);
  assert.deepEqual(page.events.slice(2).map((e) => [e.type, e.detail.lite ?? e.detail.reduce]), [['haven:reduce-motion-change', false], ['haven:lite-mode-change', false]]);
});

test('Lite mode keeps its own reduce-motion pick when the OS already asks for calm', () => {
  const page = runThemeInit({ 'haven-lite-mode': '1' }, { osReduce: true });
  page.localStorage.removeItem('haven-lite-mode');
  page.window.HavenA11y.apply(page.window.HavenA11y.read());
  assert.equal(page.classes.has('reduce-motion'), true);
  assert.deepEqual(page.events.map((e) => e.type), ['haven:lite-mode-change']);
});

test('Lite mode drops the blur, hides preview pictures and has its switch and strings', () => {
  const css = readCoreCss();
  assert.match(css, /html\.lite-mode \*,[\s\S]*?backdrop-filter: none !important;/);
  assert.match(css, /html\.lite-mode :is\(\.lp-image, \.lp-avatar, \.lp-play, \.link-preview-gallery\) \{\s*display: none !important;/);
  const html = read('public/app.html');
  assert.match(html, /id="section-lite-mode"[\s\S]*?<label class="toggle-row">\s*<span[^>]*>[^<]+<\/span>\s*<input type="checkbox" id="a11y-lite-mode">/);
  assert.match(html, /data-target="section-lite-mode"/);
  assert.match(read('public/js/modules/app-accessibility.js'), /\['a11y-lite-mode', 'haven-lite-mode', '1', 'lite'\]/);
  const en = JSON.parse(read('public/locales/en.json'));
  for (const key of ['settings.nav.lite_mode', 'settings.lite_mode.title', 'settings.lite_mode.label', 'settings.lite_mode.hint']) {
    assert.equal(typeof key.split('.').reduce((o, k) => (o ? o[k] : undefined), en), 'string', `${key} is in en.json`);
  }
});

test('Lite mode makes chat pictures, stickers, previews and videos load less', () => {
  const links = read('public/js/modules/app-link-previews.js');
  assert.match(links, /if \(!src \|\| this\._liteOn\(\)\) return;/);
  assert.match(links, /const hasGallery = !lite && /);
  assert.match(links, /data\.image && !lite/);
  assert.match(links, /this\._liteOn\(\) && !this\._openedEmbeds\?\.has\(url\)/);
  assert.match(read('public/js/modules/app-appearance.js'), /img:is\(\.chat-image, \.custom-emoji, \.sticker-img\)/);
  for (const file of ['app-media-grid.js', 'app-media-gallery.js', 'app-message-content.js']) assert.match(read(`public/js/modules/${file}`), /this\._liteOn\(\) \? 'none' : 'metadata'/, file);
});
