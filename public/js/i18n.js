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
  let _fallback = null;   // English base map for per-key fallback (#5451)
  let _locale = 'en';
  let _preference = 'auto';
  let _ready = null;  // shared init promise — ensures init() is only run once
  let _loadVersion = 0;
  let _languageChangeBound = false;

  // Locales available — add entries here as you create new locale files
  const SUPPORTED = ['en', 'fr', 'de', 'es', 'pl', 'ru', 'zh', 'pt'];
  const DEFAULT   = 'en';
  const FLAGS = { en: 'gb', fr: 'fr', de: 'de', es: 'es', pl: 'pl', ru: 'ru', zh: 'cn', pt: 'br' };

  function _browserLocale() {
    const languages = Array.isArray(navigator.languages) && navigator.languages.length
      ? navigator.languages
      : [navigator.language || DEFAULT];
    for (const language of languages) {
      const locale = String(language || '').split('-')[0].toLowerCase();
      if (SUPPORTED.includes(locale)) return locale;
    }
    return DEFAULT;
  }

  // ── Detect preferred locale ──────────────────────────────────────────
  // Precedence:
  //   1. localStorage `haven_locale` (the user's explicit choice)
  //   2. server-configured `default_locale` from /api/public-config (#5386)
  //   3. browser language
  //   4. DEFAULT ('en')
  async function _detect() {
    let stored = null;
    try { stored = localStorage.getItem('haven_locale'); } catch {}
    if (stored && SUPPORTED.includes(stored)) {
      _preference = stored;
      return stored;
    }
    _preference = 'auto';
    // Try server default — only blocks for first-time visitors with no stored
    // choice (or an explicit Automatic choice), and uses a short timeout so a
    // slow/offline server can't hang init.
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
    return _browserLocale();
  }

  // ── Load a locale JSON file ──────────────────────────────────────────
  async function load(locale) {
    if (!SUPPORTED.includes(locale)) locale = DEFAULT;
    const version = ++_loadVersion;
    try {
      const res = await fetch(`/locales/${locale}.json`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const translations = await res.json();
      let fallback = _fallback;
      if (locale !== DEFAULT && !fallback) {
        try {
          const fb = await fetch(`/locales/${DEFAULT}.json`);
          if (fb.ok) fallback = await fb.json();
        } catch { /* no fallback available — t() shows raw keys as before */ }
      }
      // A slower earlier request must never overwrite a newer language choice.
      if (version !== _loadVersion) return false;
      _translations = translations;
      _locale = locale;
      document.documentElement.lang = locale;
      // Keep an English base so a key missing from a non-English locale falls
      // back to readable English instead of a raw dotted key (#5451).
      if (locale === DEFAULT) {
        _fallback = translations;
      } else if (fallback) {
        _fallback = fallback;
      }
      return true;
    } catch (err) {
      if (version !== _loadVersion) return false;
      console.warn(`[i18n] Failed to load locale "${locale}":`, err.message);
      if (locale !== DEFAULT) {
        console.info(`[i18n] Falling back to "${DEFAULT}"`);
        return load(DEFAULT);
      }
      return false;
    }
  }

  // ── Translate a dot-notation key with optional interpolation ─────────
  // Example: t('toasts.channel_created', { name: 'general', code: 'ABC' })
  //          → 'Channel "#general" created!\nCode: ABC'
  function _lookup(tree, key) {
    return key.split('.').reduce(
      (obj, k) => (obj != null && Object.prototype.hasOwnProperty.call(obj, k) ? obj[k] : null),
      tree
    );
  }

  function t(key, params = {}) {
    let val = _lookup(_translations, key);
    // Fall back to English for keys the active locale is missing, so the UI
    // shows real text instead of a raw dotted key like "modals.foo.title"
    // (#5451). The raw key is only returned when English lacks it too — a
    // genuine gap worth surfacing.
    if ((val === null || val === undefined) && _fallback && _fallback !== _translations) {
      val = _lookup(_fallback, key);
    }
    if (val === null || val === undefined) {
      // Key not found anywhere — return the raw key so the gap is visible.
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
      if (!_languageChangeBound && typeof window.addEventListener === 'function') {
        _languageChangeBound = true;
        window.addEventListener('languagechange', () => {
          if (_preference === 'auto') {
            try { window.location.reload(); } catch {}
          }
        });
      }
    })();
    return _ready;
  }

  // ── Change locale at runtime (e.g. from a language picker) ───────────
  // Persist first and reload immediately. Waiting for a locale fetch here lets
  // rapid selections finish out of order, and dynamically rendered UI still
  // needs a full render in the selected language.
  async function setLocale(locale) {
    const preference = locale === 'auto' ? 'auto' : (SUPPORTED.includes(locale) ? locale : DEFAULT);
    _preference = preference;
    try { localStorage.setItem('haven_locale', preference); } catch {}
    try {
      window.location.reload();
      return;
    } catch { /* non-browser test harness or embedded view without reload */ }
    const resolved = await _detect();
    await load(resolved);
    applyDOM();
    document.dispatchEvent(new CustomEvent('haven:localechange', { detail: { locale: resolved, preference } }));
  }

  function _escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[char]);
  }

  // Native <option> elements cannot contain images and several Linux/Windows
  // font stacks render regional-indicator emoji as letters. Keep the select as
  // the source of truth while presenting bundled, OS-independent SVG flags.
  function buildLocalePicker(target) {
    const select = typeof target === 'string' ? document.querySelector(target) : target;
    if (!select) return null;
    if (select.dataset.havenPicker) {
      select._havenPickerSync?.();
      return select._havenPickerSync || null;
    }
    select.dataset.havenPicker = '1';

    const options = Array.from(select.options).map(option => ({
      value: option.value,
      label: option.textContent.trim() || option.value,
      flag: FLAGS[option.value] || null,
      automatic: option.value === 'auto' || option.value === ''
    }));
    const wrap = document.createElement('div');
    wrap.className = 'lang-picker';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'lang-picker-btn';
    button.setAttribute('aria-haspopup', 'listbox');
    button.setAttribute('aria-expanded', 'false');
    const list = document.createElement('div');
    list.className = 'lang-picker-list';
    list.setAttribute('role', 'listbox');
    list.hidden = true;

    const faceFor = option => {
      const icon = option.flag
        ? `<img class="lang-flag" src="/emoji/flags/${option.flag}.svg" alt="">`
        : `<span class="lang-flag lang-flag-text${option.automatic ? ' lang-flag-auto' : ''}" aria-hidden="true">${option.automatic ? 'A' : _escapeHtml(option.value.toUpperCase())}</span>`;
      return `${icon}<span class="lang-name">${_escapeHtml(option.label)}</span>`;
    };
    list.innerHTML = options.map(option =>
      `<button type="button" class="lang-picker-item" role="option" data-value="${_escapeHtml(option.value)}">${faceFor(option)}</button>`
    ).join('');

    const items = Array.from(list.querySelectorAll('.lang-picker-item'));
    const close = (restoreFocus = false) => {
      list.hidden = true;
      button.setAttribute('aria-expanded', 'false');
      document.removeEventListener('click', onOutside, true);
      if (restoreFocus) button.focus();
    };
    const focusSelected = () => {
      const selected = items.find(item => item.getAttribute('aria-selected') === 'true') || items[0];
      selected?.focus();
    };
    const open = (moveFocus = false) => {
      list.hidden = false;
      button.setAttribute('aria-expanded', 'true');
      setTimeout(() => document.addEventListener('click', onOutside, true), 0);
      if (moveFocus) focusSelected();
    };
    const onOutside = event => { if (!wrap.contains(event.target)) close(); };
    const sync = () => {
      const current = options.find(option => option.value === select.value) || options[0];
      if (!current) return;
      button.innerHTML = `${faceFor(current)}<span class="lang-caret">▾</span>`;
      list.querySelectorAll('.lang-picker-item').forEach(item => {
        const selected = item.dataset.value === current.value;
        item.classList.toggle('active', selected);
        item.setAttribute('aria-selected', String(selected));
      });
    };

    button.addEventListener('click', event => {
      event.stopPropagation();
      if (list.hidden) open(event.detail === 0); else close();
    });
    button.addEventListener('keydown', event => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        event.stopPropagation();
        open(true);
      } else if (event.key === 'Escape' && !list.hidden) {
        event.preventDefault();
        event.stopPropagation();
        close(true);
      }
    });
    list.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close(true);
        return;
      }
      const current = event.target.closest('.lang-picker-item');
      if (!current) return;
      const index = items.indexOf(current);
      let nextIndex = null;
      if (event.key === 'ArrowDown') nextIndex = (index + 1) % items.length;
      else if (event.key === 'ArrowUp') nextIndex = (index - 1 + items.length) % items.length;
      else if (event.key === 'Home') nextIndex = 0;
      else if (event.key === 'End') nextIndex = items.length - 1;
      if (nextIndex !== null) {
        event.preventDefault();
        event.stopPropagation();
        items[nextIndex]?.focus();
      }
    });
    items.forEach(item => {
      item.addEventListener('click', event => {
        event.stopPropagation();
        select.value = item.dataset.value;
        sync();
        close();
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
    });

    select._havenPickerSync = sync;
    sync();
    wrap.appendChild(button);
    wrap.appendChild(list);
    select.parentElement.insertBefore(wrap, select);
    select.classList.add('lang-select-hidden');
    return sync;
  }

  function syncLocalePicker(target) {
    const select = typeof target === 'string' ? document.querySelector(target) : target;
    select?._havenPickerSync?.();
  }

  return {
    init,
    load,
    setLocale,
    buildLocalePicker,
    syncLocalePicker,
    t,
    applyDOM,
    get locale()    { return _locale; },
    get preference(){ return _preference; },
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
