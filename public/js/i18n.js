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
  // Precedence:
  //   1. localStorage `haven_locale` (the user's explicit choice)
  //   2. server-configured `default_locale` from /api/public-config (#5386)
  //   3. browser language
  //   4. DEFAULT ('en')
  async function _detect() {
    const stored = localStorage.getItem('haven_locale');
    if (stored && SUPPORTED.includes(stored)) return stored;
    // Try server default — only blocks for first-time visitors with no stored
    // choice, and uses a short timeout so a slow/offline server can't hang init.
    try {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 1500);
      const res = await fetch('/api/public-config', { signal: ctrl.signal });
      clearTimeout(timeout);
      if (res.ok) {
        const cfg = await res.json();
        if (cfg && typeof cfg.default_locale === 'string' && SUPPORTED.includes(cfg.default_locale)) {
          return cfg.default_locale;
        }
      }
    } catch { /* offline / not ready — fall through to browser detection */ }
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
      const locale = await _detect();
      await load(locale);
      if (document.readyState === 'loading') {
        await new Promise(r => document.addEventListener('DOMContentLoaded', r, { once: true }));
      }
      applyDOM();
    })();
    return _ready;
  }

  // ── Change locale at runtime (e.g. from a language picker) ───────────
  // Reloads the page after persisting the choice. applyDOM() only refreshes
  // elements with data-i18n* attributes, so anything rendered dynamically by
  // JS (channel list, messages, settings sections built on the fly, etc.) would
  // otherwise keep its old-language text and make it look like the switch
  // didn't take effect (#5386).
  async function setLocale(locale) {
    if (!SUPPORTED.includes(locale)) locale = DEFAULT;
    // Persist immediately so the post-reload init picks up the new choice even
    // if the locale JSON fetch is slow or fails.
    try { localStorage.setItem('haven_locale', locale); } catch {}
    await load(locale);
    applyDOM();
    document.dispatchEvent(new CustomEvent('haven:localechange', { detail: { locale } }));
    // Hard reload to re-render dynamic content in the new language.
    try { window.location.reload(); } catch {}
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

// Kick off init from the module itself so app.html doesn't need an inline
// <script>i18n.init()</script> call. The page CSP forbids inline scripts
// (no 'unsafe-inline' in script-src), and the inline tag was being refused on
// strict clients (e.g. Haven Desktop preload), leaving the page stuck on
// "Loading Haven…". init() is idempotent — auth.js's await still resolves
// against the same shared promise.
I18n.init();
