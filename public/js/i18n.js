// ── Haven i18n Engine ─────────────────────────────────────────────────────
// Lightweight, dependency-free translation system for vanilla JS.
//
// Usage in JS:   t('auth.login.submit')
//                t('toasts.channel_created', { name: 'general', code: 'ABCD1234' })
// Usage in HTML: <button data-i18n="auth.login.submit">Login</button>
//                <input data-i18n-placeholder="app.sidebar.join_placeholder">
//                <button data-i18n-title="app.actions.logout">...</button>
// ──────────────────────────────────────────────────────────────────────────

const I18n = (() => {
  let _translations = {};
  let _locale = 'en';
  let _ready = null;  // shared init promise — ensures init() is only run once

  // Locales available — add entries here as you create new locale files
  const SUPPORTED = ['en', 'fr', 'de', 'es', 'pl', 'ru', 'zh'];
  const DEFAULT   = 'en';

  // ── Detect preferred locale ──────────────────────────────────────────
  function _detect() {
    const stored = localStorage.getItem('haven_locale');
    if (stored && SUPPORTED.includes(stored)) return stored;
    const browser = (navigator.language || 'en').split('-')[0].toLowerCase();
    return SUPPORTED.includes(browser) ? browser : DEFAULT;
  }

  // ── Load a locale JSON file ──────────────────────────────────────────
  async function load(locale) {
    try {
      const res = await fetch(`/locales/${locale}.json`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      _translations = await res.json();
      _locale = locale;
      document.documentElement.lang = locale;
      localStorage.setItem('haven_locale', locale);
    } catch (err) {
      console.warn(`[i18n] Failed to load locale "${locale}":`, err.message);
      if (locale !== DEFAULT) {
        console.info(`[i18n] Falling back to "${DEFAULT}"`);
        await load(DEFAULT);
      }
    }
  }

  // ── Translate a dot-notation key with optional interpolation ─────────
  // Example: t('toasts.channel_created', { name: 'general', code: 'ABC' })
  //          → 'Channel "#general" created!\nCode: ABC'
  function t(key, params = {}) {
    const val = key.split('.').reduce(
      (obj, k) => (obj != null && Object.prototype.hasOwnProperty.call(obj, k) ? obj[k] : null),
      _translations
    );
    if (val === null || val === undefined) {
      // Key not found — return the raw key so missing translations are visible
      return key;
    }
    let str = String(val);
    for (const [k, v] of Object.entries(params)) {
      str = str.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), String(v));
    }
    return str;
  }

  // ── Apply data-i18n* attributes to DOM elements ──────────────────────
  // Can be scoped to a subtree by passing a root element.
  function applyDOM(root = document) {
    // Text content
    root.querySelectorAll('[data-i18n]').forEach(el => {
      const val = t(el.dataset.i18n);
      if (val !== el.dataset.i18n) el.textContent = val;
    });
    // innerHTML (use sparingly, only for trusted keys with HTML entities/tags)
    root.querySelectorAll('[data-i18n-html]').forEach(el => {
      const val = t(el.dataset.i18nHtml);
      if (val !== el.dataset.i18nHtml) el.innerHTML = val;
    });
    // Placeholder attributes
    root.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
      const val = t(el.dataset.i18nPlaceholder);
      if (val !== el.dataset.i18nPlaceholder) el.placeholder = val;
    });
    // Title attributes (tooltips)
    root.querySelectorAll('[data-i18n-title]').forEach(el => {
      const val = t(el.dataset.i18nTitle);
      if (val !== el.dataset.i18nTitle) el.title = val;
    });
    // ARIA labels
    root.querySelectorAll('[data-i18n-aria-label]').forEach(el => {
      const val = t(el.dataset.i18nAriaLabel);
      if (val !== el.dataset.i18nAriaLabel) el.setAttribute('aria-label', val);
    });
  }

  // ── Initialise: detect locale, load file, apply DOM ──────────────────
  // Idempotent: multiple callers share the same promise so the fetch
  // only happens once, regardless of how many times init() is called.
  function init() {
    if (_ready) return _ready;
    _ready = (async () => {
      const locale = _detect();
      await load(locale);
      if (document.readyState === 'loading') {
        await new Promise(r => document.addEventListener('DOMContentLoaded', r, { once: true }));
      }
      applyDOM();
    })();
    return _ready;
  }

  // ── Change locale at runtime (e.g. from a language picker) ───────────
  async function setLocale(locale) {
    if (!SUPPORTED.includes(locale)) locale = DEFAULT;
    await load(locale);
    applyDOM();
    // Re-run any page-specific setup that renders dynamic content
    document.dispatchEvent(new CustomEvent('haven:localechange', { detail: { locale } }));
  }

  return {
    init,
    load,
    setLocale,
    t,
    applyDOM,
    get locale()    { return _locale; },
    get supported() { return [...SUPPORTED]; },
  };
})();

// ── Global helpers ───────────────────────────────────────────────────────
window.i18n = I18n;

/** Shorthand: t('key') or t('key', { param: value }) */
window.t = (key, params) => I18n.t(key, params);
