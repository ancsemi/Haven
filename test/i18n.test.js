'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const I18N_SOURCE = fs.readFileSync(path.join(ROOT, 'public/js/i18n.js'), 'utf8');

function flattenLocale(value, prefix = '', result = new Map()) {
  for (const [key, child] of Object.entries(value)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === 'object' && !Array.isArray(child)) {
      flattenLocale(child, fullKey, result);
    } else {
      result.set(fullKey, child);
    }
  }
  return result;
}

function filesUnder(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(file) : [file];
  });
}

function placeholders(value) {
  return [...String(value).matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g)].map(match => match[1]).sort();
}

function duplicateJsonKeys(source) {
  const scopes = [];
  const duplicates = [];
  const tokens = /"(?:\\.|[^"\\])*"\s*:|"(?:\\.|[^"\\])*"|[{}[\]]/g;

  for (const match of source.matchAll(tokens)) {
    const token = match[0];
    if (token === '{') scopes.push(new Set());
    else if (token === '[') scopes.push(null);
    else if (token === '}' || token === ']') scopes.pop();
    else if (token.endsWith(':')) {
      const key = JSON.parse(token.replace(/\s*:$/, ''));
      const scope = scopes.at(-1);
      if (scope?.has(key)) duplicates.push(key);
      scope?.add(key);
    }
  }

  return duplicates;
}

function literalTranslationKeys(source) {
  const keys = [];

  for (const call of source.matchAll(/\bt\s*\(/g)) {
    const start = call.index + call[0].length;
    let end = start;
    let depth = 1;

    while (end < source.length && depth > 0) {
      const char = source[end];
      const next = source[end + 1];
      if (char === '/' && next === '/') {
        end = source.indexOf('\n', end + 2);
        if (end === -1) end = source.length;
        continue;
      }
      if (char === '/' && next === '*') {
        const close = source.indexOf('*/', end + 2);
        end = close === -1 ? source.length : close + 2;
        continue;
      }
      if (char === '"' || char === "'" || char === '`') {
        const quote = char;
        for (end++; end < source.length; end++) {
          if (source[end] === '\\') end++;
          else if (source[end] === quote) break;
        }
      } else if (char === '(') {
        depth++;
      } else if (char === ')') {
        depth--;
        if (depth === 0) break;
      } else if (char === ',' && depth === 1) {
        break;
      }
      end++;
    }

    const firstArgument = source.slice(start, end);
    for (const literal of firstArgument.matchAll(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g)) {
      const value = literal[0].slice(1, -1);
      if (value.includes('.')) keys.push(value);
    }
  }

  return keys;
}

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

test('password visibility controls remain translatable after early initialization', () => {
  const source = fs.readFileSync(path.join(ROOT, 'public/js/password-eye.js'), 'utf8');
  assert.match(source, /btn\.dataset\.i18nAriaLabel = 'auth\.aria\.show_password'/);
  assert.match(source, /btn\.dataset\.i18nAriaLabel = ariaKey/);
});

test('English and Portuguese catalogs have matching keys and placeholders', () => {
  const localeDir = path.join(ROOT, 'public/locales');
  const english = flattenLocale(JSON.parse(fs.readFileSync(path.join(localeDir, 'en.json'), 'utf8')));
  const portuguese = flattenLocale(JSON.parse(fs.readFileSync(path.join(localeDir, 'pt.json'), 'utf8')));

  assert.deepEqual([...portuguese.keys()].sort(), [...english.keys()].sort());
  for (const [key, value] of english) {
    assert.deepEqual(placeholders(portuguese.get(key)), placeholders(value), `placeholder mismatch for ${key}`);
  }
});

test('maintained locale catalogs do not contain duplicate object keys', () => {
  assert.deepEqual(duplicateJsonKeys('{"a":1,"a":2}'), ['a']);
  assert.deepEqual(duplicateJsonKeys('{"a":1,"nested":{"a":2}}'), []);

  const localeDir = path.join(ROOT, 'public/locales');
  for (const locale of ['en', 'pt']) {
    const source = fs.readFileSync(path.join(localeDir, `${locale}.json`), 'utf8');
    assert.deepEqual(duplicateJsonKeys(source), [], `${locale}.json contains duplicate object keys`);
  }
});

test('literal translation references exist in both maintained catalogs', () => {
  const publicDir = path.join(ROOT, 'public');
  const localeDir = path.join(publicDir, 'locales');
  const english = flattenLocale(JSON.parse(fs.readFileSync(path.join(localeDir, 'en.json'), 'utf8')));
  const portuguese = flattenLocale(JSON.parse(fs.readFileSync(path.join(localeDir, 'pt.json'), 'utf8')));
  const references = new Map();

  for (const file of filesUnder(publicDir).filter(name => /\.(?:html|js)$/.test(name))) {
    const source = fs.readFileSync(file, 'utf8');
    const relative = path.relative(ROOT, file);
    for (const match of source.matchAll(/data-i18n(?:-(?:html|placeholder|title|aria-label|alt|label))?="([^"]+)"/g)) {
      references.set(match[1], relative);
    }
    for (const key of literalTranslationKeys(source)) {
      references.set(key, relative);
    }
  }

  for (const [key, file] of references) {
    assert.equal(english.has(key), true, `missing English key ${key}, referenced by ${file}`);
    assert.equal(portuguese.has(key), true, `missing Portuguese key ${key}, referenced by ${file}`);
  }
});

test('HTML translations preserve required code and emphasis markup', () => {
  const appHtml = fs.readFileSync(path.join(ROOT, 'public/app.html'), 'utf8');
  const keys = [
    ['modals.edit_profile.personas_hint', { code: 2, strong: 0 }],
    ['settings.admin.oidc_desc', { code: 1, strong: 0 }],
    ['settings.admin.backup_restore_warning', { code: 1, strong: 1 }]
  ];

  for (const locale of ['en', 'pt']) {
    const catalog = flattenLocale(JSON.parse(fs.readFileSync(path.join(ROOT, `public/locales/${locale}.json`), 'utf8')));
    for (const [key, expectedTags] of keys) {
      assert.match(appHtml, new RegExp(`data-i18n-html="${key.replaceAll('.', '\\.')}"`));
      const value = catalog.get(key);
      for (const [tag, count] of Object.entries(expectedTags)) {
        assert.equal((value.match(new RegExp(`<${tag}>`, 'g')) || []).length, count, `${locale}.${key} has the wrong number of <${tag}> tags`);
        assert.equal((value.match(new RegExp(`</${tag}>`, 'g')) || []).length, count, `${locale}.${key} has the wrong number of </${tag}> tags`);
      }
    }
  }
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
