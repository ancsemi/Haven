(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.HavenThemeCompat = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const CACHE_KEY = 'haven_theme_compatibility';
  const CACHE_SCHEMA = 1;
  const SAFE_MODE_KEY = 'haven_safe_mode';
  const RESET_PENDING_KEY = 'haven_customizations_reset_pending';
  let themeRequest = null;

  function getStorage(storage, fallbackName) {
    if (storage) return storage;
    try { return globalThis[fallbackName]; } catch { return null; }
  }

  function cacheThemes(themes, storage) {
    const target = getStorage(storage, 'localStorage');
    if (!target || !Array.isArray(themes)) return;

    const entries = {};
    for (const theme of themes) {
      if (!theme || typeof theme.file !== 'string') continue;
      const compatibility = typeof theme.compatibility === 'string'
        ? theme.compatibility
        : 'legacy';
      entries[theme.file] = {
        compatible: theme.compatible !== false && !['invalid', 'unsupported'].includes(compatibility),
        compatibility,
        themeApi: Number.isInteger(theme.themeApi) ? theme.themeApi : null,
        themeApiDeclared: theme.themeApiDeclared == null ? null : String(theme.themeApiDeclared),
      };
    }

    try {
      target.setItem(CACHE_KEY, JSON.stringify({ schema: CACHE_SCHEMA, themes: entries }));
    } catch { /* storage unavailable */ }
  }

  function getCachedTheme(file, storage) {
    if (typeof file !== 'string' || !file) return null;
    const target = getStorage(storage, 'localStorage');
    if (!target) return null;
    try {
      const cache = JSON.parse(target.getItem(CACHE_KEY) || 'null');
      if (!cache || cache.schema !== CACHE_SCHEMA || typeof cache.themes !== 'object') return null;
      return cache.themes[file] || null;
    } catch {
      return null;
    }
  }

  function fetchThemes(fetcher, force = false) {
    if (themeRequest && !force) return themeRequest;
    let request = fetcher;
    if (typeof request !== 'function') {
      try { request = globalThis.fetch?.bind(globalThis); } catch { request = null; }
    }
    if (typeof request !== 'function') return Promise.resolve(null);

    themeRequest = new Promise(resolve => {
      let settled = false;
      let timer = null;
      const finish = value => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(value);
      };
      timer = setTimeout(() => finish(null), 5000);
      Promise.resolve()
        .then(() => request('/api/themes'))
        .then(response => {
          if (!response || response.ok === false) throw new Error('Theme metadata request failed');
          return response.json();
        })
        .then(themes => finish(Array.isArray(themes) ? themes : null))
        .catch(() => finish(null));
    });
    return themeRequest;
  }

  function requestedSafeMode(locationLike) {
    try {
      return new URLSearchParams(locationLike?.search || '').get('haven-safe-mode');
    } catch {
      return null;
    }
  }

  function isSafeMode(locationLike, storage) {
    const session = getStorage(storage, 'sessionStorage');
    const requested = requestedSafeMode(locationLike || globalThis.location);
    try {
      if (requested === '1') session?.setItem(SAFE_MODE_KEY, '1');
      if (requested === '0') session?.removeItem(SAFE_MODE_KEY);
      return requested === '1' || (requested !== '0' && session?.getItem(SAFE_MODE_KEY) === '1');
    } catch {
      return requested === '1';
    }
  }

  function clearSafeMode(storage) {
    const session = getStorage(storage, 'sessionStorage');
    try { session?.removeItem(SAFE_MODE_KEY); } catch { /* storage unavailable */ }
  }

  function markResetPending(storage) {
    const session = getStorage(storage, 'sessionStorage');
    try { session?.setItem(RESET_PENDING_KEY, '1'); } catch { /* storage unavailable */ }
  }

  function isResetPending(storage) {
    const session = getStorage(storage, 'sessionStorage');
    try { return session?.getItem(RESET_PENDING_KEY) === '1'; } catch { return false; }
  }

  function clearResetPending(storage) {
    const session = getStorage(storage, 'sessionStorage');
    try { session?.removeItem(RESET_PENDING_KEY); } catch { /* storage unavailable */ }
  }

  function resetLocalCustomizations(local, session) {
    const storage = getStorage(local, 'localStorage');
    try {
      storage?.setItem('haven_theme', 'haven');
      storage?.setItem('haven_enabled_themes', '[]');
      storage?.setItem('haven_enabled_plugins', '[]');
    } catch { /* storage unavailable */ }
    markResetPending(session);
  }

  function urlWithoutSafeMode(locationLike) {
    try {
      const url = new URL(locationLike?.href || globalThis.location.href);
      url.searchParams.delete('haven-safe-mode');
      return `${url.pathname}${url.search}${url.hash}`;
    } catch {
      return '/';
    }
  }

  return {
    CACHE_KEY,
    SAFE_MODE_KEY,
    RESET_PENDING_KEY,
    cacheThemes,
    getCachedTheme,
    fetchThemes,
    isSafeMode,
    clearSafeMode,
    markResetPending,
    isResetPending,
    clearResetPending,
    resetLocalCustomizations,
    urlWithoutSafeMode,
  };
});
