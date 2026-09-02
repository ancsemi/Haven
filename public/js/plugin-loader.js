/**
 * Haven Plugin & Theme Loader
 * 
 * Plugins:  Drop .plugin.js files into Haven/plugins/
 * Themes:   Drop .theme.css files into Haven/themes/
 * 
 * Plugin format:
 *   /** @name MyPlugin  @description Does things  @author Me  @version 1.0 *​/
 *   class MyPlugin {
 *     start() { /* called when enabled *​/ }
 *     stop()  { /* called when disabled *​/ }
 *   }
 * 
 * Theme format:
 *   /** @name MyTheme  @description Dark neon  @author Me  @version 1.0 *​/
 *   :root { --bg-primary: #000; ... }
 */

window.HavenPluginLoader = (function () {
  'use strict';

  // ═══════════════════════════════════════════════════════
  //  HavenApi — exposed to plugins as window.HavenApi
  // ═══════════════════════════════════════════════════════

  const HavenApi = {
    // ── DOM helpers ──
    DOM: {
      /** Add a CSS class string to <head> */
      addStyle(id, css) {
        this.removeStyle(id);
        const el = document.createElement('style');
        el.id = `haven-plugin-style-${id}`;
        el.textContent = css;
        document.head.appendChild(el);
        return el;
      },
      removeStyle(id) {
        document.getElementById(`haven-plugin-style-${id}`)?.remove();
      },
      /** Query inside the app */
      query(sel) { return document.querySelector(sel); },
      queryAll(sel) { return [...document.querySelectorAll(sel)]; },
    },

    // Structural layout plugins are mutually exclusive. Acquiring the shared
    // owner before moving regions prevents two reversible plugins from saving
    // each other's temporary DOM as their native restore point.
    Layout: {
      _owner: null,
      _reservedOwner: null,
      acquire(owner) {
        const id = String(owner || '').trim();
        if (!id || (this._reservedOwner && this._reservedOwner !== id)
            || (this._owner && this._owner !== id)) return false;
        if (this._owner === id) return true;
        this._owner = id;
        document.documentElement.setAttribute('data-haven-layout-owner', id);
        document.dispatchEvent(new CustomEvent('haven:layout-owner-change', { detail: { owner: id } }));
        return true;
      },
      release(owner) {
        if (this._owner !== String(owner || '').trim()) return false;
        this._owner = null;
        document.documentElement.removeAttribute('data-haven-layout-owner');
        document.dispatchEvent(new CustomEvent('haven:layout-owner-change', { detail: { owner: null } }));
        return true;
      },
      _reserve(owner) {
        this._reservedOwner = String(owner || '').trim() || null;
      },
      _clearReservation(owner) {
        const id = String(owner || '').trim() || null;
        if (this._reservedOwner !== id) return false;
        this._reservedOwner = null;
        return true;
      },
      get owner() { return this._owner; },
    },

    // ── Data (localStorage wrapper) ──
    Data: {
      save(pluginName, key, value) {
        const store = JSON.parse(localStorage.getItem('haven_plugin_data') || '{}');
        if (!store[pluginName]) store[pluginName] = {};
        store[pluginName][key] = value;
        localStorage.setItem('haven_plugin_data', JSON.stringify(store));
      },
      load(pluginName, key, fallback = null) {
        const store = JSON.parse(localStorage.getItem('haven_plugin_data') || '{}');
        return store[pluginName]?.[key] ?? fallback;
      },
      delete(pluginName, key) {
        const store = JSON.parse(localStorage.getItem('haven_plugin_data') || '{}');
        if (store[pluginName]) { delete store[pluginName][key]; }
        localStorage.setItem('haven_plugin_data', JSON.stringify(store));
      },
    },

    // ── UI helpers ──
    UI: {
      showToast(message, type = 'info') {
        if (window.app && window.app._showToast) {
          window.app._showToast(message, type);
        }
      },
      /** Show a simple confirm dialog — returns a Promise<boolean> */
      confirm(title, message) {
        return new Promise(resolve => {
          const result = window.confirm(`${title}\n\n${message}`);
          resolve(result);
        });
      },
    },

    // ── Patcher — monkey-patch methods reversibly ──
    Patcher: {
      _patches: new Map(),

      before(id, obj, method, fn) {
        return this._patch(id, obj, method, fn, 'before');
      },
      after(id, obj, method, fn) {
        return this._patch(id, obj, method, fn, 'after');
      },
      instead(id, obj, method, fn) {
        return this._patch(id, obj, method, fn, 'instead');
      },

      _patch(id, obj, method, fn, type) {
        const original = obj[method];
        if (typeof original !== 'function') return;

        const patchKey = `${id}::${method}`;
        if (!this._patches.has(patchKey)) {
          this._patches.set(patchKey, { original, obj, method, hooks: [] });
        }
        const entry = this._patches.get(patchKey);
        entry.hooks.push({ type, fn, id });

        obj[method] = function (...args) {
          let result;
          // Run 'before' hooks
          for (const h of entry.hooks) {
            if (h.type === 'before') h.fn.call(this, args);
          }
          // Run 'instead' or original
          const insteadHook = entry.hooks.find(h => h.type === 'instead');
          if (insteadHook) {
            result = insteadHook.fn.call(this, args, entry.original.bind(this));
          } else {
            result = entry.original.apply(this, args);
          }
          // Run 'after' hooks
          for (const h of entry.hooks) {
            if (h.type === 'after') {
              const r = h.fn.call(this, args, result);
              if (r !== undefined) result = r;
            }
          }
          return result;
        };

        return () => this.unpatchAll(id);
      },

      unpatchAll(id) {
        for (const [key, entry] of this._patches) {
          entry.hooks = entry.hooks.filter(h => h.id !== id);
          if (entry.hooks.length === 0) {
            entry.obj[entry.method] = entry.original;
            this._patches.delete(key);
          }
        }
      }
    },

    // ── Socket access ──
    get socket() { return window.app?.socket || null; },

    // ── Current user ──
    get currentUser() { return window.app?.user || null; },

    // ── Channels ──
    get channels() { return window.app?.channels || []; },

    // ── Current channel ──
    get currentChannel() { return window.app?.currentChannel || null; },
  };

  window.HavenApi = HavenApi;


  // ═══════════════════════════════════════════════════════
  //  Plugin Manager
  // ═══════════════════════════════════════════════════════

  const loadedPlugins = new Map();  // name → { instance, meta, enabled }
  const loadedThemes  = new Map();  // name → { meta, enabled, linkEl }
  const ThemeCompat = window.HavenThemeCompat;

  function detectSafeMode() {
    if (ThemeCompat?.isSafeMode?.(window.location) === true) return true;
    let requested = null;
    try { requested = new URLSearchParams(window.location.search).get('haven-safe-mode'); } catch {}
    try {
      if (requested === '1') sessionStorage.setItem('haven_safe_mode', '1');
      if (requested === '0') sessionStorage.removeItem('haven_safe_mode');
      if (requested === '0') return false;
      return requested === '1'
        || document.documentElement.hasAttribute('data-haven-safe-mode')
        || sessionStorage.getItem('haven_safe_mode') === '1';
    } catch {
      return requested === '1' || document.documentElement.hasAttribute('data-haven-safe-mode');
    }
  }

  const safeMode = detectSafeMode();
  function detectRecoveryPending() {
    if (ThemeCompat?.isResetPending?.() === true) return true;
    try { return sessionStorage.getItem('haven_customizations_reset_pending') === '1'; } catch { return false; }
  }

  function clearSafeMode() {
    ThemeCompat?.clearSafeMode?.();
    try { sessionStorage.removeItem('haven_safe_mode'); } catch {}
  }

  function clearResetPending() {
    ThemeCompat?.clearResetPending?.();
    try { sessionStorage.removeItem('haven_customizations_reset_pending'); } catch {}
  }

  function resetLocalCustomizations() {
    try {
      localStorage.setItem('haven_theme', 'haven');
      localStorage.setItem('haven_enabled_themes', '[]');
      localStorage.setItem('haven_enabled_plugins', '[]');
      sessionStorage.setItem('haven_customizations_reset_pending', '1');
    } catch {}
  }

  function urlWithoutSafeMode() {
    const fromHelper = ThemeCompat?.urlWithoutSafeMode?.(window.location);
    if (fromHelper) return fromHelper;
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete('haven-safe-mode');
      return `${url.pathname}${url.search}${url.hash}`;
    } catch {
      return '/app.html';
    }
  }

  let recoveryPending = detectRecoveryPending();
  const suppressExtensions = safeMode || recoveryPending;
  let themeMetadataReady = false;
  let pendingFileTheme = null;

  function storedList(key) {
    try {
      const value = JSON.parse(localStorage.getItem(key) || '[]');
      return Array.isArray(value) ? value.filter(item => typeof item === 'string') : [];
    } catch {
      return [];
    }
  }

  function getEnabledPlugins() {
    return storedList('haven_enabled_plugins');
  }
  function setEnabledPlugins(list) {
    localStorage.setItem('haven_enabled_plugins', JSON.stringify(list));
  }
  function getEnabledThemes() {
    return storedList('haven_enabled_themes');
  }
  function setEnabledThemes(list) {
    localStorage.setItem('haven_enabled_themes', JSON.stringify(list));
  }
  // Published themes are what the theme picker offers, so only one can be
  // active at a time. Unpublished ones are additive CSS tweaks that stack on
  // top of whatever theme is selected.
  function isPublishedTheme(file) {
    return !!loadedThemes.get(file)?.meta?.published;
  }
  function getActiveFileTheme() {
    const saved = localStorage.getItem('haven_theme') || '';
    return saved.startsWith('file:') ? saved.slice(5) : null;
  }

  function isThemeCompatible(meta) {
    return !!meta && meta.compatible !== false
      && meta.compatibility !== 'invalid'
      && meta.compatibility !== 'unsupported';
  }

  function registerSuppressedPlugin(meta) {
    if (loadedPlugins.has(meta.file)) return;
    loadedPlugins.set(meta.file, {
      instance: null,
      meta,
      enabled: getEnabledPlugins().includes(meta.file),
      suppressed: true,
    });
  }

  // ── Load a single plugin ──
  async function loadPlugin(meta) {
    if (loadedPlugins.has(meta.file)) return;
    if (suppressExtensions) {
      registerSuppressedPlugin(meta);
      return;
    }
    try {
      const resp = await fetch(`/plugins/${meta.file}?_=${Date.now()}`);
      const code = await resp.text();

      // Execute in a Function scope so plugins can define classes
      // Pass globalThis as _win so plugins can register classes via _win.ClassName = ...
      const factory = new Function('HavenApi', '_win', code + '\n;return (typeof module !== "undefined" && module.exports) || (typeof exports !== "undefined" ? exports : null);');
      const exported = factory(HavenApi, globalThis);

      // The plugin should place its class on window, or we find the last class defined
      // Convention: plugin sets module.exports = ClassName or _win.PluginName = class { ... }
      // We'll look for any new class on window that has start()/stop()
      let PluginClass = null;

      if (exported && typeof exported === 'function' && exported.prototype.start) {
        PluginClass = exported;
      } else {
        // Try to find a class whose name matches the file
        const baseName = meta.file.replace('.plugin.js', '');
        if (window[baseName] && typeof window[baseName] === 'function') {
          PluginClass = window[baseName];
        } else {
          // Fallback: look for any class defined via the code — we wrap it
          // The code itself may call _win.XYZ = class { ... }
          // Just re-execute looking for the return value
          const fn2 = new Function('HavenApi', '_win', code + '\n;return typeof start === "function" ? { start, stop: typeof stop === "function" ? stop : () => {} } : null;');
          const obj = fn2(HavenApi, globalThis);
          if (obj) PluginClass = function() { this.start = obj.start; this.stop = obj.stop || (() => {}); };
        }
      }

      if (!PluginClass) {
        console.warn(`[Haven Plugins] Could not find plugin class in ${meta.file}`);
        return;
      }

      const instance = new PluginClass();
      const enabled = getEnabledPlugins().includes(meta.file);
      loadedPlugins.set(meta.file, { instance, meta, enabled });

      if (enabled) {
        try { instance.start(); } catch (err) { console.error(`[Plugin ${meta.name}] start() error:`, err); }
      }
    } catch (err) {
      console.error(`[Haven Plugins] Failed to load ${meta.file}:`, err);
    }
  }

  // ── Enable / disable a plugin ──
  function enablePlugin(file) {
    const p = loadedPlugins.get(file);
    if (!p || p.enabled || suppressExtensions || !p.instance) return;
    p.enabled = true;
    try { p.instance.start(); } catch (err) { console.error(`[Plugin ${p.meta.name}] start() error:`, err); }
    const list = getEnabledPlugins();
    if (!list.includes(file)) { list.push(file); setEnabledPlugins(list); }
    renderPluginUI();
  }

  function disablePlugin(file) {
    const p = loadedPlugins.get(file);
    if (!p || !p.enabled) return;
    p.enabled = false;
    if (p.instance) {
      try {
        p.instance.stop();
        HavenApi.Patcher.unpatchAll(p.meta.name || file);
        HavenApi.DOM.removeStyle(p.meta.name || file);
      } catch (err) { console.error(`[Plugin ${p.meta.name}] stop() error:`, err); }
    }
    const list = getEnabledPlugins().filter(f => f !== file);
    setEnabledPlugins(list);
    renderPluginUI();
  }

  // ── Load a theme ──
  function loadTheme(meta) {
    const compatible = isThemeCompatible(meta);
    const existing = loadedThemes.get(meta.file);
    if (existing) {
      existing.meta = meta;
      existing.compatible = compatible;
      existing.suppressed = existing.enabled && (!compatible || suppressExtensions);
      const shouldInject = existing.enabled && compatible && !suppressExtensions
        && (!meta.published || getActiveFileTheme() === meta.file);
      if (!shouldInject && existing.linkEl) {
        existing.linkEl.remove();
        existing.linkEl = null;
      }
      if (shouldInject && !existing.linkEl) {
        const linkEl = document.createElement('link');
        linkEl.rel = 'stylesheet';
        linkEl.href = `/themes/${encodeURIComponent(meta.file)}?_=${Date.now()}`;
        linkEl.id = `haven-theme-${meta.file}`;
        document.head.appendChild(linkEl);
        existing.linkEl = linkEl;
      }
      return;
    }
    const configured = getEnabledThemes().includes(meta.file);
    // A published theme is only injected when it is the selected one; leaving a
    // previously-selected one in the enabled list must not stack it on top of
    // whatever theme is active now.
    const shouldInject = configured && compatible && !suppressExtensions
      && (!meta.published || getActiveFileTheme() === meta.file);
    let linkEl = null;
    if (shouldInject) {
      linkEl = document.createElement('link');
      linkEl.rel = 'stylesheet';
      linkEl.href = `/themes/${encodeURIComponent(meta.file)}?_=${Date.now()}`;
      linkEl.id = `haven-theme-${meta.file}`;
      document.head.appendChild(linkEl);
    }
    loadedThemes.set(meta.file, {
      meta,
      enabled: configured,
      compatible,
      suppressed: configured && (!compatible || suppressExtensions),
      linkEl,
    });
  }

  function enableTheme(file) {
    const t = loadedThemes.get(file);
    if (!t || t.enabled || suppressExtensions || !t.compatible) return;
    // A published theme is one of the picker's choices, not a stackable tweak —
    // turning it on means selecting it, so the two surfaces stay in agreement.
    if (t.meta.published) {
      applyFileTheme(file);
      return;
    }
    t.enabled = true;
    const linkEl = document.createElement('link');
    linkEl.rel = 'stylesheet';
    linkEl.href = `/themes/${file}?_=${Date.now()}`;
    linkEl.id = `haven-theme-${file}`;
    document.head.appendChild(linkEl);
    t.linkEl = linkEl;
    const list = getEnabledThemes();
    if (!list.includes(file)) { list.push(file); setEnabledThemes(list); }
    renderPluginUI();
  }

  function disableTheme(file) {
    const t = loadedThemes.get(file);
    if (!t || !t.enabled) return;
    t.enabled = false;
    if (t.linkEl) { t.linkEl.remove(); t.linkEl = null; }
    t.suppressed = false;
    document.getElementById(`haven-theme-${file}`)?.remove();
    const list = getEnabledThemes().filter(f => f !== file);
    setEnabledThemes(list);
    // Turning off the selected published theme deselects it, which means falling
    // back to the built-in default rather than leaving the picker pointing at a
    // stylesheet that is no longer loaded.
    if (t.meta.published && getActiveFileTheme() === file) selectBuiltinTheme('haven');
    renderPluginUI();
  }

  // Switch back to a built-in data-theme, mirroring what a theme-picker button
  // does in theme.js (which isn't reachable from here as a function).
  function selectBuiltinTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    document.documentElement.removeAttribute('data-haven-theme-pending');
    localStorage.setItem('haven_theme', theme);
    document.querySelectorAll('.theme-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.theme === theme);
    });
    if (window.havenSocket && window.havenSocket.connected) {
      window.havenSocket.emit('set-preference', { key: 'theme', value: theme });
    }
    if (!suppressExtensions && typeof applyEffects === 'function') {
      applyEffects(typeof _getStoredEffectMode === 'function' ? _getStoredEffectMode() : 'auto');
    }
    if (!suppressExtensions && typeof showEffectEditorIfDynamic === 'function') showEffectEditorIfDynamic(theme);
  }

  function persistThemePreference(theme) {
    return new Promise(resolve => {
      const socket = window.havenSocket;
      if (!socket) return resolve(false);

      let settled = false;
      let send;
      let connectionTimer = null;
      let saveTimer = null;
      const finish = value => {
        if (settled) return;
        settled = true;
        if (connectionTimer) clearTimeout(connectionTimer);
        if (saveTimer) clearTimeout(saveTimer);
        socket.off?.('preference-saved', onSaved);
        if (send) socket.off?.('connect', send);
        resolve(value);
      };
      const onSaved = data => {
        if (data?.key === 'theme' && data.value === theme) finish(true);
      };
      send = () => {
        if (connectionTimer) clearTimeout(connectionTimer);
        socket.on?.('preference-saved', onSaved);
        socket.emit('set-preference', { key: 'theme', value: theme });
        saveTimer = setTimeout(() => finish(false), 1200);
      };

      if (socket.connected) send();
      else {
        socket.once?.('connect', send);
        connectionTimer = setTimeout(() => finish(false), 1500);
      }
    });
  }

  function fallbackToHaven(file, notify = true, syncPreference = false) {
    document.querySelectorAll('link[id^="haven-theme-"]').forEach(link => link.remove());
    document.documentElement.setAttribute('data-theme', 'haven');
    document.documentElement.removeAttribute('data-haven-theme-pending');
    localStorage.setItem('haven_theme', 'haven');
    setEnabledThemes(getEnabledThemes().filter(name => name !== file));
    const record = loadedThemes.get(file);
    if (record) {
      record.enabled = false;
      record.suppressed = false;
      record.linkEl = null;
    }
    document.querySelectorAll('.theme-btn').forEach(button => {
      button.classList.toggle('active', button.dataset.theme === 'haven');
    });
    if (!suppressExtensions && typeof applyEffects === 'function') {
      const fxMode = typeof _getStoredEffectMode === 'function' ? _getStoredEffectMode() : 'auto';
      applyEffects(fxMode, 'haven');
    }
    if (!suppressExtensions && typeof showEffectEditorIfDynamic === 'function') {
      showEffectEditorIfDynamic('haven');
    }
    if (syncPreference) void persistThemePreference('haven');
    if (notify) HavenApi.UI.showToast(t('settings.plugins_section.theme_fallback'), 'warning');
    renderPluginUI();
  }

  async function resetCustomizations() {
    resetLocalCustomizations();
    recoveryPending = true;
    document.querySelectorAll('link[id^="haven-theme-"]').forEach(link => link.remove());
    document.documentElement.setAttribute('data-theme', 'haven');
    loadedPlugins.forEach(plugin => { plugin.enabled = false; });
    loadedThemes.forEach(theme => {
      theme.enabled = false;
      theme.suppressed = false;
      theme.linkEl = null;
    });
    renderPluginUI();

    const saved = await persistThemePreference('haven');
    if (saved) {
      recoveryPending = false;
      clearResetPending();
      clearSafeMode();
      window.location.assign(urlWithoutSafeMode());
      return;
    }
    setupSafeModeUI();
    HavenApi.UI.showToast(t('settings.plugins_section.reset_sync_pending'), 'warning');
  }

  function setupSafeModeUI() {
    const notice = document.getElementById('extension-safe-mode-notice');
    if (!notice) return;
    notice.style.display = suppressExtensions ? '' : 'none';
    const exitButton = document.getElementById('extension-safe-mode-exit-btn');
    if (exitButton) exitButton.style.display = safeMode && !recoveryPending ? '' : 'none';
    if (recoveryPending) {
      const title = document.getElementById('extension-safe-mode-title');
      const description = document.getElementById('extension-safe-mode-desc');
      if (title) title.textContent = t('settings.plugins_section.recovery_pending_title');
      if (description) description.textContent = t('settings.plugins_section.recovery_pending_desc');
    }
    if (!suppressExtensions || notice.dataset.bound === '1') return;
    notice.dataset.bound = '1';
    document.getElementById('extension-reset-btn')?.addEventListener('click', resetCustomizations);
    document.getElementById('extension-safe-mode-exit-btn')?.addEventListener('click', () => {
      clearSafeMode();
      window.location.assign(urlWithoutSafeMode());
    });
  }


  // ═══════════════════════════════════════════════════════
  //  Settings UI Rendering
  // ═══════════════════════════════════════════════════════

  function themeCompatibilityLabel(meta) {
    if (meta.compatibility === 'compatible') return `Theme API ${meta.themeApi}`;
    if (!meta.compatibility || meta.compatibility === 'legacy') return t('settings.plugins_section.legacy_theme');
    if (meta.compatibility === 'invalid') return t('settings.plugins_section.invalid_theme_api');
    return t('settings.plugins_section.unsupported_theme_api');
  }

  function renderPluginUI() {
    const container = document.getElementById('plugin-list');
    const themeContainer = document.getElementById('theme-list');
    if (!container || !themeContainer) return;

    // Plugins
    if (loadedPlugins.size === 0) {
      container.innerHTML = `<p class="plugin-empty">${t('settings.plugins_section.no_plugins')}</p>`;
    } else {
      container.innerHTML = '';
      for (const [file, p] of loadedPlugins) {
        const card = document.createElement('div');
        card.className = 'plugin-card';
        const suppressedLabel = suppressExtensions && p.enabled
          ? ` • ${escHtml(t('settings.plugins_section.suppressed_safe_mode'))}`
          : '';
        const toggleDisabled = suppressExtensions && !p.enabled;
        card.innerHTML = `
          <div class="plugin-card-info">
            <div class="plugin-card-name">${escHtml(p.meta.name || file)}</div>
            <div class="plugin-card-desc">${escHtml(p.meta.description || '')}</div>
            <div class="plugin-card-meta">${escHtml(p.meta.author || '')}${p.meta.version ? ' • v' + escHtml(p.meta.version) : ''}${suppressedLabel}</div>
          </div>
          <label class="plugin-toggle">
            <input type="checkbox" ${p.enabled ? 'checked' : ''} ${toggleDisabled ? 'disabled' : ''}>
            <span class="plugin-toggle-slider"></span>
          </label>
        `;
        const toggle = card.querySelector('input[type="checkbox"]');
        toggle.addEventListener('change', () => {
          if (toggle.checked) enablePlugin(file); else disablePlugin(file);
        });
        container.appendChild(card);
      }
    }

    // Themes
    if (loadedThemes.size === 0) {
      themeContainer.innerHTML = '<p class="plugin-empty">No themes found. Drop <code>.theme.css</code> files into the <code>themes/</code> folder.</p>';
    } else {
      themeContainer.innerHTML = '';
      for (const [file, themeRecord] of loadedThemes) {
        const card = document.createElement('div');
        card.className = 'plugin-card';
        const compatibilityLabel = themeCompatibilityLabel(themeRecord.meta);
        const suppressedLabel = themeRecord.suppressed
          ? ` • ${escHtml(suppressExtensions
            ? t('settings.plugins_section.suppressed_safe_mode')
            : t('settings.plugins_section.incompatible_theme'))}`
          : '';
        const toggleDisabled = (!themeRecord.compatible || suppressExtensions) && !themeRecord.enabled;
        card.innerHTML = `
          <div class="plugin-card-info">
            <div class="plugin-card-name">${escHtml(themeRecord.meta.name || file)}</div>
            <div class="plugin-card-desc">${escHtml(themeRecord.meta.description || '')}</div>
            <div class="plugin-card-meta">${escHtml(themeRecord.meta.author || '')}${themeRecord.meta.version ? ' • v' + escHtml(themeRecord.meta.version) : ''} • ${escHtml(compatibilityLabel)}${suppressedLabel}</div>
          </div>
          <label class="plugin-toggle">
            <input type="checkbox" ${themeRecord.enabled ? 'checked' : ''} ${toggleDisabled ? 'disabled' : ''}>
            <span class="plugin-toggle-slider"></span>
          </label>
        `;
        const toggle = card.querySelector('input[type="checkbox"]');
        toggle.addEventListener('change', () => {
          if (toggle.checked) enableTheme(file); else disableTheme(file);
        });
        themeContainer.appendChild(card);
      }
    }
  }

  function escHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }


  // ═══════════════════════════════════════════════════════
  //  Init — fetch & load all plugins and themes
  // ═══════════════════════════════════════════════════════

  async function fetchList(url) {
    try {
      const response = await fetch(url);
      if (!response.ok) return null;
      const value = await response.json();
      return Array.isArray(value) ? value : null;
    } catch {
      return null;
    }
  }

  async function init(forceThemeRefresh = false) {
    try {
      const [pluginRes, themeRes] = await Promise.all([
        fetchList('/api/plugins'),
        ThemeCompat?.fetchThemes?.(fetch, forceThemeRefresh) || fetchList('/api/themes'),
      ]);

      const authoritativeThemes = Array.isArray(themeRes);
      if (authoritativeThemes) {
        const availableFiles = new Set(themeRes.map(theme => theme.file));
        for (const [file, record] of loadedThemes) {
          if (availableFiles.has(file)) continue;
          record.linkEl?.remove();
          loadedThemes.delete(file);
        }
        ThemeCompat?.cacheThemes?.(themeRes);
        themeMetadataReady = true;
      } else {
        // A network or response error is not proof that a saved theme vanished.
        // Keep the preference and show the Haven base until metadata can be retried.
        document.documentElement.removeAttribute('data-haven-theme-pending');
      }

      // Load themes first. Safe mode records them without injecting CSS.
      for (const t of themeRes || []) loadTheme(t);

      // loadPlugin() only records metadata while extensions are suppressed, so
      // no plugin file is fetched or evaluated in safe/recovery mode.
      for (const p of pluginRes || []) await loadPlugin(p);

      if (authoritativeThemes) injectPublishedThemeButtons(themeRes);

      if (!suppressExtensions && authoritativeThemes) {
        const requested = pendingFileTheme || (getActiveFileTheme()
          ? { file: getActiveFileTheme(), persist: false, syncFallback: false }
          : null);
        pendingFileTheme = null;
        if (requested) {
          const record = loadedThemes.get(requested.file);
          if (record?.compatible) {
            applyFileTheme(requested.file, requested.persist, requested.syncFallback);
          }
          else fallbackToHaven(requested.file, true, requested.syncFallback);
        }
      }

      setupSafeModeUI();
      renderPluginUI();
      if (recoveryPending) {
        const saved = await persistThemePreference('haven');
        if (saved) {
          recoveryPending = false;
          clearResetPending();
          clearSafeMode();
          window.location.assign(urlWithoutSafeMode());
          return;
        }
        HavenApi.UI.showToast(t('settings.plugins_section.reset_sync_pending'), 'warning');
      }
      console.log(`[Haven] Loaded ${loadedPlugins.size} plugin(s), ${loadedThemes.size} theme(s)${suppressExtensions ? ' (suppressed)' : ''}`);
    } catch (err) {
      console.warn('[Haven] Plugin/theme init error:', err);
    }
  }

  /**
   * Inject published .theme.css files as selectable buttons into #theme-selector.
   * These behave just like built-in themes but apply an external CSS file.
   */
  function injectPublishedThemeButtons(themeRes) {
    const selector = document.getElementById('theme-selector');
    if (!selector) return;
    const published = themeRes.filter(t => t.published && isThemeCompatible(t));

    // Remove any previously injected custom-theme buttons (in case of re-init)
    selector.querySelectorAll('.theme-btn[data-custom-theme]').forEach(b => b.remove());

    for (const theme of published) {
      const btn = document.createElement('button');
      btn.className = 'theme-btn';
      btn.dataset.theme = `file:${theme.file}`;
      btn.dataset.customTheme = '1';
      btn.title = theme.name || theme.file;
      if (suppressExtensions) btn.disabled = true;
      const icon = document.createElement('span');
      icon.className = 'theme-icon';
      icon.textContent = theme.icon || '🎨';
      btn.appendChild(icon);

      btn.addEventListener('click', () => {
        // Apply the file theme exclusively
        const applied = applyFileTheme(theme.file);
        // Notify the socket if available
        if (applied && window.havenSocket && window.havenSocket.connected) {
          window.havenSocket.emit('set-preference', { key: 'theme', value: `file:${theme.file}` });
        }
      });

      selector.appendChild(btn);
    }

  }

  /**
   * Apply a .theme.css file as the active theme.
   * Clears built-in theme vars, removes other injected theme links,
   * and injects the chosen file's link.
   * @param {string} file  - e.g. "mytheme.theme.css"
   * @param {boolean} [persist=true] - whether to save to localStorage
   */
  function applyFileTheme(file, persist = true, syncFallback = true) {
    if (!file || suppressExtensions) return false;
    if (!themeMetadataReady) {
      pendingFileTheme = { file, persist, syncFallback };
      return false;
    }
    const selected = loadedThemes.get(file);
    if (!selected || !selected.compatible) {
      fallbackToHaven(file, true, syncFallback);
      return false;
    }

    // Clear inline custom-theme vars (from the triangle editor / rgb cycle)
    if (typeof clearCustomVars === 'function') clearCustomVars();
    if (typeof stopRgbCycle === 'function') stopRgbCycle();

    // Hide custom/rgb editors if open
    document.getElementById('custom-theme-editor')?._hide?.();
    document.getElementById('rgb-theme-editor')?._hide?.();

    loadedThemes.forEach(t => {
      t.enabled = false;
      t.suppressed = false;
      t.linkEl = null;
    });

    // The link injection, the 'haven' layout base, persistence and the button
    // active state are shared with the login page, so they live in theme.js and
    // are called from here rather than written out twice. Everything below this
    // point is plugin-loader's own bookkeeping, which the login page has no use
    // for. (#5537)
    const linkEl = applyPublishedThemeBase(file, persist, selected.meta);
    if (!linkEl) {
      fallbackToHaven(file, true, syncFallback);
      return false;
    }
    const t = loadedThemes.get(file);
    if (t) { t.enabled = true; t.suppressed = false; t.linkEl = linkEl; }

    // Selecting a published theme deselects any other one, so drop the others
    // from the enabled list — otherwise the Settings toggles claim a theme is
    // on while the picker shows a different one as active.
    const kept = getEnabledThemes().filter(f =>
      f !== file && !isPublishedTheme(f) && loadedThemes.get(f)?.compatible !== false
    );
    setEnabledThemes([file, ...kept]);

    // Re-inject user-enabled custom CSS tweaks (non-published themes) on top of the new base.
    reapplyEnabledThemes(file);
    renderPluginUI();

    // Built-in theme buttons re-run the effect layer on every switch; file themes
    // have to do the same or the previous theme's overlays (FFX water, Matrix rain,
    // Nord snow…) keep running on top of the new one. Guarded because theme.js
    // isn't guaranteed to be loaded wherever the loader runs.
    if (!suppressExtensions && typeof applyEffects === 'function') {
      const fxMode = typeof _getStoredEffectMode === 'function' ? _getStoredEffectMode() : 'auto';
      applyEffects(fxMode);
    }
    if (!suppressExtensions && typeof showEffectEditorIfDynamic === 'function') {
      showEffectEditorIfDynamic(`file:${file}`);
    }
    document.documentElement.removeAttribute('data-haven-theme-pending');
    return true;
  }

  // Re-inject the user-enabled CSS tweaks that are missing from the DOM.
  // Called after any theme switch that removes haven-theme-* links.
  // The active theme is skipped (it was just injected, and re-adding it would
  // move it after the tweaks meant to override it) and so is every other
  // published theme, which is a selectable theme rather than an overlay.
  function reapplyEnabledThemes(activeFile = getActiveFileTheme()) {
    if (suppressExtensions) return;
    const enabledList = getEnabledThemes();
    for (const file of enabledList) {
      if (file === activeFile) continue;
      if (isPublishedTheme(file)) continue;
      const t = loadedThemes.get(file);
      if (!t?.compatible) continue;
      if (document.getElementById(`haven-theme-${file}`)) continue; // already present
      const linkEl = document.createElement('link');
      linkEl.rel = 'stylesheet';
      linkEl.href = `/themes/${encodeURIComponent(file)}?_=${Date.now()}`;
      linkEl.id = `haven-theme-${file}`;
      document.head.appendChild(linkEl);
      if (t) { t.enabled = true; t.suppressed = false; t.linkEl = linkEl; }
    }
  }

  // Start when the app is ready
  if (document.readyState === 'complete') {
    setTimeout(init, 500);
  } else {
    window.addEventListener('load', () => setTimeout(init, 500));
  }

  return {
    loadedPlugins,
    loadedThemes,
    enablePlugin,
    disablePlugin,
    enableTheme,
    disableTheme,
    renderPluginUI,
    applyFileTheme,
    reapplyEnabledThemes,
    refresh: () => init(true),
  };
})();
