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

  function getEnabledPlugins() {
    return JSON.parse(localStorage.getItem('haven_enabled_plugins') || '[]');
  }
  function setEnabledPlugins(list) {
    localStorage.setItem('haven_enabled_plugins', JSON.stringify(list));
  }
  function getEnabledThemes() {
    return JSON.parse(localStorage.getItem('haven_enabled_themes') || '[]');
  }
  function setEnabledThemes(list) {
    localStorage.setItem('haven_enabled_themes', JSON.stringify(list));
  }

  // ── Load a single plugin ──
  async function loadPlugin(meta) {
    if (loadedPlugins.has(meta.file)) return;
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
    if (!p || p.enabled) return;
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
    try {
      p.instance.stop();
      HavenApi.Patcher.unpatchAll(p.meta.name || file);
      HavenApi.DOM.removeStyle(p.meta.name || file);
    } catch (err) { console.error(`[Plugin ${p.meta.name}] stop() error:`, err); }
    const list = getEnabledPlugins().filter(f => f !== file);
    setEnabledPlugins(list);
    renderPluginUI();
  }

  // ── Load a theme ──
  function loadTheme(meta) {
    if (loadedThemes.has(meta.file)) return;
    const enabled = getEnabledThemes().includes(meta.file);
    let linkEl = null;
    if (enabled) {
      linkEl = document.createElement('link');
      linkEl.rel = 'stylesheet';
      linkEl.href = `/themes/${meta.file}?_=${Date.now()}`;
      linkEl.id = `haven-theme-${meta.file}`;
      document.head.appendChild(linkEl);
    }
    loadedThemes.set(meta.file, { meta, enabled, linkEl });
  }

  function enableTheme(file) {
    const t = loadedThemes.get(file);
    if (!t || t.enabled) return;
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
    document.getElementById(`haven-theme-${file}`)?.remove();
    const list = getEnabledThemes().filter(f => f !== file);
    setEnabledThemes(list);
    renderPluginUI();
  }


  // ═══════════════════════════════════════════════════════
  //  Settings UI Rendering
  // ═══════════════════════════════════════════════════════

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
        card.innerHTML = `
          <div class="plugin-card-info">
            <div class="plugin-card-name">${escHtml(p.meta.name || file)}</div>
            <div class="plugin-card-desc">${escHtml(p.meta.description || '')}</div>
            <div class="plugin-card-meta">${escHtml(p.meta.author || '')}${p.meta.version ? ' • v' + escHtml(p.meta.version) : ''}</div>
          </div>
          <label class="plugin-toggle">
            <input type="checkbox" ${p.enabled ? 'checked' : ''}>
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
      for (const [file, t] of loadedThemes) {
        const card = document.createElement('div');
        card.className = 'plugin-card';
        card.innerHTML = `
          <div class="plugin-card-info">
            <div class="plugin-card-name">${escHtml(t.meta.name || file)}</div>
            <div class="plugin-card-desc">${escHtml(t.meta.description || '')}</div>
            <div class="plugin-card-meta">${escHtml(t.meta.author || '')}${t.meta.version ? ' • v' + escHtml(t.meta.version) : ''}</div>
          </div>
          <label class="plugin-toggle">
            <input type="checkbox" ${t.enabled ? 'checked' : ''}>
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

  async function init() {
    try {
      const [pluginRes, themeRes] = await Promise.all([
        fetch('/api/plugins').then(r => r.json()).catch(() => []),
        fetch('/api/themes').then(r => r.json()).catch(() => []),
      ]);

      // Load themes first (instant CSS injection)
      for (const t of themeRes) loadTheme(t);

      // Load plugins (may need network fetch + eval)
      for (const p of pluginRes) await loadPlugin(p);

      renderPluginUI();
      injectPublishedThemeButtons(themeRes);
      console.log(`[Haven] Loaded ${loadedPlugins.size} plugin(s), ${loadedThemes.size} theme(s)`);
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
    const published = themeRes.filter(t => t.published);
    if (published.length === 0) return;

    // Remove any previously injected custom-theme buttons (in case of re-init)
    selector.querySelectorAll('.theme-btn[data-custom-theme]').forEach(b => b.remove());

    for (const theme of published) {
      const btn = document.createElement('button');
      btn.className = 'theme-btn';
      btn.dataset.theme = `file:${theme.file}`;
      btn.dataset.customTheme = '1';
      btn.title = theme.name || theme.file;
      const icon = document.createElement('span');
      icon.className = 'theme-icon';
      icon.textContent = theme.icon || '🎨';
      btn.appendChild(icon);

      btn.addEventListener('click', () => {
        // Apply the file theme exclusively
        applyFileTheme(theme.file);
        // Notify the socket if available
        if (window.havenSocket && window.havenSocket.connected) {
          window.havenSocket.emit('set-preference', { key: 'theme', value: `file:${theme.file}` });
        }
      });

      selector.appendChild(btn);
    }

    // Restore active state if a file theme is saved
    const saved = localStorage.getItem('haven_theme') || '';
    if (saved.startsWith('file:')) {
      selector.querySelectorAll('.theme-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.theme === saved);
      });
      applyFileTheme(saved.slice(5), false);
    }
  }

  /**
   * Apply a .theme.css file as the active theme.
   * Clears built-in theme vars, removes other injected theme links,
   * and injects the chosen file's link.
   * @param {string} file  - e.g. "mytheme.theme.css"
   * @param {boolean} [persist=true] - whether to save to localStorage
   */
  function applyFileTheme(file, persist = true) {
    // Clear inline custom-theme vars (from the triangle editor / rgb cycle)
    if (typeof clearCustomVars === 'function') clearCustomVars();
    if (typeof stopRgbCycle === 'function') stopRgbCycle();

    // Hide custom/rgb editors if open
    document.getElementById('custom-theme-editor')?._hide?.();
    document.getElementById('rgb-theme-editor')?._hide?.();

    // Remove all previously injected file-theme links
    document.querySelectorAll('link[id^="haven-theme-"]').forEach(l => l.remove());
    loadedThemes.forEach((t, f) => { t.enabled = false; t.linkEl = null; });

    // Inject the chosen file
    const linkEl = document.createElement('link');
    linkEl.rel = 'stylesheet';
    linkEl.href = `/themes/${file}?_=${Date.now()}`;
    linkEl.id = `haven-theme-${file}`;
    document.head.appendChild(linkEl);
    const t = loadedThemes.get(file);
    if (t) { t.enabled = true; t.linkEl = linkEl; }

    // Use 'haven' as the base data-theme so layout CSS is stable;
    // the injected stylesheet overrides the :root vars since it loads later.
    document.documentElement.setAttribute('data-theme', 'haven');

    if (persist) {
      localStorage.setItem('haven_theme', `file:${file}`);
    }

    // Update active state on all theme buttons
    document.querySelectorAll('.theme-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.theme === `file:${file}`);
    });
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
    refresh: init,
  };
})();
