'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const I18N_SOURCE = fs.readFileSync(path.join(ROOT, 'public/js/i18n.js'), 'utf8');

function jsonResponse(value) {
  return { ok: true, status: 200, json: async () => value };
}

async function createI18n({ storedLocale, languages = ['en-US'], defaultLocale = '', fetchOverride } = {}) {
  const storage = new Map();
  if (storedLocale !== undefined) storage.set('haven_locale', storedLocale);
  const requests = [];
  const listeners = new Map();
  let reloads = 0;
  const localStorage = {
    getItem: key => storage.has(key) ? storage.get(key) : null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: key => storage.delete(key)
  };
  const document = {
    readyState: 'complete',
    documentElement: { lang: '' },
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true
  };
  const fetch = async (url, options) => {
    requests.push(url);
    if (fetchOverride) {
      const response = fetchOverride(url, options);
      if (response !== undefined) return response;
    }
    if (url === '/api/public-config') return jsonResponse({ default_locale: defaultLocale });
    const locale = String(url).match(/\/locales\/([a-z]+)\.json$/)?.[1] || 'en';
    return jsonResponse({ marker: locale });
  };
  const window = {
    document,
    location: { reload: () => { reloads++; } },
    addEventListener: (type, listener) => listeners.set(type, listener)
  };
  const context = vm.createContext({
    window,
    document,
    navigator: { language: languages[0], languages },
    localStorage,
    fetch,
    AbortController,
    CustomEvent: class CustomEvent {
      constructor(type, init) { this.type = type; this.detail = init?.detail; }
    },
    Event: class Event {},
    console,
    setTimeout,
    clearTimeout
  });
  vm.runInContext(I18N_SOURCE, context, { filename: 'i18n.js' });
  await window.i18n.init();
  return {
    i18n: window.i18n,
    storage,
    requests,
    listeners,
    document,
    get reloads() { return reloads; }
  };
}

test('automatic language follows the first supported browser language without freezing it', async () => {
  const env = await createI18n({ languages: ['xx-ZZ', 'pt-BR'] });
  assert.equal(env.i18n.locale, 'pt');
  assert.equal(env.i18n.preference, 'auto');
  assert.equal(env.document.documentElement.lang, 'pt');
  assert.equal(env.storage.has('haven_locale'), false);
  assert.ok(env.listeners.has('languagechange'));
  env.listeners.get('languagechange')();
  assert.equal(env.reloads, 1);
});

test('automatic language honors the server default before browser languages', async () => {
  const env = await createI18n({ storedLocale: 'auto', languages: ['pt-BR'], defaultLocale: 'fr' });
  assert.equal(env.i18n.locale, 'fr');
  assert.equal(env.i18n.preference, 'auto');
  assert.equal(env.storage.get('haven_locale'), 'auto');
});

test('an explicit language remains authoritative over server and browser defaults', async () => {
  const env = await createI18n({ storedLocale: 'de', languages: ['pt-BR'], defaultLocale: 'fr' });
  assert.equal(env.i18n.locale, 'de');
  assert.equal(env.i18n.preference, 'de');
  assert.equal(env.requests.includes('/api/public-config'), false);
  env.listeners.get('languagechange')();
  assert.equal(env.reloads, 0);
});

test('changing language persists once and reloads without waiting for another fetch', async () => {
  const env = await createI18n({ storedLocale: 'en' });
  const requestCount = env.requests.length;
  await env.i18n.setLocale('pt');
  assert.equal(env.storage.get('haven_locale'), 'pt');
  assert.equal(env.i18n.preference, 'pt');
  assert.equal(env.reloads, 1);
  assert.equal(env.requests.length, requestCount);

  await env.i18n.setLocale('auto');
  assert.equal(env.storage.get('haven_locale'), 'auto');
  assert.equal(env.reloads, 2);
});

test('a slower stale locale response cannot overwrite the latest load', async () => {
  let resolveFrench;
  const frenchResponse = new Promise(resolve => { resolveFrench = resolve; });
  const env = await createI18n({
    storedLocale: 'en',
    fetchOverride: url => url === '/locales/fr.json' ? frenchResponse : undefined
  });

  const staleLoad = env.i18n.load('fr');
  const latestLoad = env.i18n.load('pt');
  await latestLoad;
  resolveFrench(jsonResponse({ marker: 'fr' }));
  await staleLoad;
  assert.equal(env.i18n.locale, 'pt');
  assert.equal(env.i18n.t('marker'), 'pt');
});

test('language controls use bundled Brazilian artwork instead of OS flag emoji', () => {
  const indexHtml = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  const appHtml = fs.readFileSync(path.join(ROOT, 'public/app.html'), 'utf8');
  const authSelect = indexHtml.match(/<select id="auth-lang-select"[\s\S]*?<\/select>/)?.[0] || '';
  const appSelect = appHtml.match(/<select id="language-select"[\s\S]*?<\/select>/)?.[0] || '';

  assert.match(I18N_SOURCE, /pt:\s*'br'/);
  assert.equal(fs.existsSync(path.join(ROOT, 'public/emoji/flags/br.svg')), true);
  assert.match(authSelect, /value="auto"/);
  assert.match(appSelect, /value="auto"/);
  assert.doesNotMatch(authSelect + appSelect, /[\u{1F1E6}-\u{1F1FF}]/u);
  assert.match(fs.readFileSync(path.join(ROOT, 'public/js/auth.js'), 'utf8'), /buildLocalePicker\(langSelect\)/);
});

test('the custom language picker preserves visible focus and listbox keyboard navigation', () => {
  const css = fs.readFileSync(path.join(ROOT, 'public/css/style.css'), 'utf8');
  assert.match(css, /\.lang-picker-btn:focus-visible,[\s\S]*\.lang-picker-item:focus-visible/);
  for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Escape']) {
    assert.match(I18N_SOURCE, new RegExp(`event\\.key === '${key}'`));
  }
  assert.match(I18N_SOURCE, /close\(true\)/);
  assert.ok((I18N_SOURCE.match(/event\.stopPropagation\(\)/g) || []).length >= 4);
});
