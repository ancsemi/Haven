/**
 * @name Braid Layout
 * @description Vastly simplified two-edge layout: folds the server rail into the sidebar, docks the full voice controls bottom-left, tucks header extras into a kebab menu, merges message runs into cards, and calms the chrome. One-key toggle (Ctrl+Shift+B) between Braid and the classic layout. Suspends itself while Mod Mode edits the layout. Pairs with the Braid / Braid Light themes.
 * @author Amnibro
 * @version 1.5
 */
class BraidLayout {
  start() {
    this._permListeners = [];          // survive disengage; removed only in stop()
    this._engaged = false;
    HavenApi.DOM.addStyle('BraidPillCSS', BraidLayout._PILL_CSS);
    this._buildReturnPill();
    // One shortcut, both directions: the way back must never be buried.
    // Ctrl+Alt+B is the browser-safe twin (Chrome eats Ctrl+Shift+B on web).
    const kd = (e) => {
      if (e.ctrlKey && (e.shiftKey || e.altKey) && (e.key === 'B' || e.key === 'b')) {
        e.preventDefault();
        this._toggleLayout();
      }
    };
    document.addEventListener('keydown', kd, true);
    this._permListeners.push([document, 'keydown', kd, true]);
    if (HavenApi.Data.load('BraidLayout', 'layoutOn', '1') !== '0') this._engage();
    else console.log('[BraidLayout] Started dormant — classic layout (pill or Ctrl+Shift+B to re-engage)');
  }

  _toggleLayout() {
    this._engaged ? this._disengage() : this._engage();
  }

  // Everything visual lives between _engage and _disengage, so "back to
  // normal" is one click without touching the plugin toggle in Settings.
  _engage() {
    if (this._engaged) return;
    this._engaged = true;
    HavenApi.Data.save('BraidLayout', 'layoutOn', '1');
    this._hidden = new Map();          // el -> { display, hadHidden }
    this._lsPrev = new Map();          // localStorage key -> previous value (null = absent)
    this._listeners = [];              // [target, type, fn, opts]
    this._collapsedAdded = [];         // elements we added a class to
    this._moved = [];                  // [el, origParent, origNextSibling] for relocations
    HavenApi.DOM.addStyle('BraidLayoutCSS', BraidLayout._LAYOUT_CSS);
    HavenApi.DOM.addStyle('BraidShapeCSS', BraidLayout._SHAPE_CSS);
    HavenApi.DOM.addStyle('BraidFormCSS', BraidLayout._FORM_CSS);
    HavenApi.DOM.addStyle('BraidMotionCSS', BraidLayout._MOTION_CSS);
    document.documentElement.setAttribute('data-braid-layout', '1');
    document.documentElement.setAttribute('data-braid-form', '1');
    this._paintOwn();
    this._themeBottomIcons();
    this._applyTextScales();
    // Channel switches get the hex loader moment
    this._listen(document, 'click', (e) => {
      if (e.target.closest && e.target.closest('.channel-item')) this._showHexLoader();
    }, true);
    // Mod Mode (Haven's layout editor) must see the real chrome to drag
    // it around — suspend the whole Braid layer while it is editing and
    // come back when it saves. body class changes are attribute
    // mutations, which the main childList observer deliberately ignores.
    this._suspended = false;
    this._modObs = new MutationObserver(() => {
      const editing = document.body.classList.contains('mod-mode-on');
      if (editing && !this._suspended) this._suspend();
      else if (!editing && this._suspended) this._resume();
    });
    this._modObs.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    this._collapseJoinCreate();
    this._setPeopleOpen(false);
    this._buildMoreMenu();
    this._applyLayout();
    let scheduled = false;
    let applying = false;
    // childList-only observer: _applyLayout mutates style/attributes and its
    // one-time builds are idempotent, so the observer can't feed back on itself.
    this._obs = new MutationObserver(() => {
      if (applying || scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        if (applying) return;
        applying = true;
        try { this._applyLayout(); }
        finally { applying = false; }
      });
    });
    this._obs.observe(document.getElementById('app-body') || document.body, { childList: true, subtree: true });
    console.log('[BraidLayout] Engaged');
  }

  stop() {
    this._disengage(false);
    for (const [t, type, fn, opts] of this._permListeners || []) t.removeEventListener(type, fn, opts);
    this._permListeners = [];
    document.getElementById('braid-return-pill')?.remove();
    document.getElementById('braid-mod-done')?.remove();
    HavenApi.DOM.removeStyle('BraidPillCSS');
    console.log('[BraidLayout] Stopped');
  }

  // persist=false is the plugin-loader disable path: tearing the layer down
  // must not overwrite the user's Braid/classic preference.
  _disengage(persist = true) {
    if (!this._engaged) return;
    this._engaged = false;
    if (persist) HavenApi.Data.save('BraidLayout', 'layoutOn', '0');
    if (this._obs) { this._obs.disconnect(); this._obs = null; }
    if (this._modObs) { this._modObs.disconnect(); this._modObs = null; }
    document.getElementById('braid-mod-done')?.remove();
    this._unfoldVoiceDock();
    this._restoreBottomIcons();
    document.getElementById('braid-text-sliders')?.remove();
    document.getElementById('braid-hex-overlay')?.remove();
    document.documentElement.style.removeProperty('--braid-chat-scale');
    document.documentElement.style.removeProperty('--braid-ui-scale');
    // Unfold the server rail back to its own column
    const bar = document.getElementById('server-bar');
    const strip = document.getElementById('braid-server-strip');
    if (bar && strip) {
      while (strip.firstChild) bar.appendChild(strip.firstChild);
      delete bar.dataset.braidFolded;
      bar.removeAttribute('aria-hidden');
    }
    strip?.remove();
    document.querySelector('.braid-more-wrap')?.remove();
    document.getElementById('braid-more-menu')?.remove();
    document.getElementById('braid-theme-btn')?.remove();
    document.getElementById('braid-classic-btn')?.remove();
    document.getElementById('braid-apps-drawer')?.remove();
    // Restore everything we hid
    for (const [el, prev] of this._hidden) {
      el.style.display = prev.display;
      if (!prev.hadHidden) el.removeAttribute('hidden');
    }
    this._hidden.clear();
    // Restore the right sidebar to interactive state
    const right = document.getElementById('right-sidebar');
    if (right) { right.style.display = ''; right.style.width = ''; right.style.opacity = ''; right.style.pointerEvents = ''; }
    // Undo collapse classes we added (leave ones the user already had)
    for (const [el, cls] of this._collapsedAdded) el.classList.remove(cls);
    this._collapsedAdded = [];
    // Restore localStorage keys we introduced
    for (const [key, prev] of this._lsPrev) {
      try { prev === null ? localStorage.removeItem(key) : localStorage.setItem(key, prev); } catch {}
    }
    this._lsPrev.clear();
    for (const [t, type, fn, opts] of this._listeners) t.removeEventListener(type, fn, opts);
    this._listeners = [];
    document.documentElement.classList.remove('braid-people-open', 'braid-sound-open', 'braid-status-open');
    document.documentElement.removeAttribute('data-braid-layout');
    document.documentElement.removeAttribute('data-braid-form');
    document.querySelectorAll('[data-braid-run]').forEach((el) => el.removeAttribute('data-braid-run'));
    HavenApi.DOM.removeStyle('BraidLayoutCSS');
    HavenApi.DOM.removeStyle('BraidMotionCSS');
    HavenApi.DOM.removeStyle('BraidShapeCSS');
    HavenApi.DOM.removeStyle('BraidFormCSS');
    HavenApi.DOM.removeStyle('BraidFormOwn');
    console.log('[BraidLayout] Disengaged — classic layout');
  }

  // The classic-mode switch lives INSIDE the stock bottom-left icon bar,
  // right next to the theme button — a peer of the other settings, never
  // floating over them. Falls back to a fixed pill only if the bar is gone.
  _buildReturnPill() {
    if (document.getElementById('braid-return-pill')) return;
    const pill = document.createElement('button');
    pill.type = 'button';
    pill.id = 'braid-return-pill';
    pill.title = 'Braid layout (Ctrl+Shift+B)';
    pill.setAttribute('aria-label', 'Switch to Braid layout');
    pill.innerHTML =
      '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2.5 20.2 7.25v9.5L12 21.5 3.8 16.75v-9.5Z"/></svg>';
    pill.addEventListener('click', () => this._engage());
    const bar = document.querySelector('.sidebar-bottom-bar');
    if (bar) {
      pill.className = 'sidebar-bottom-btn braid-return-btn';
      const themeBtn = document.getElementById('theme-popup-toggle');
      themeBtn && themeBtn.parentElement === bar ? bar.insertBefore(pill, themeBtn.nextSibling) : bar.prepend(pill);
    } else {
      pill.className = 'braid-return-float';
      document.body.appendChild(pill);
    }
  }

  // While Mod Mode edits the layout Braid steps aside — this is the one
  // unmissable way back out of the editor.
  _showModDone() {
    if (document.getElementById('braid-mod-done')) return;
    const done = document.createElement('button');
    done.type = 'button';
    done.id = 'braid-mod-done';
    done.innerHTML = '✓ Done editing layout';
    done.addEventListener('click', () => {
      const mm = window.app && window.app.modMode;
      if (mm) mm.toggle();
      else document.getElementById('mod-mode-settings-toggle')?.click();
    });
    document.body.appendChild(done);
  }

  _listen(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    this._listeners.push([target, type, fn, opts]);
  }

  _setLS(key, value) {
    try {
      if (!this._lsPrev.has(key)) this._lsPrev.set(key, localStorage.getItem(key));
      localStorage.setItem(key, value);
    } catch {}
  }

  _hide(el) {
    if (!el) return;
    if (!this._hidden.has(el)) this._hidden.set(el, { display: el.style.display === 'none' ? '' : el.style.display, hadHidden: el.hasAttribute('hidden') });
    if (el.style.display !== 'none') el.style.display = 'none';
    if (!el.hasAttribute('hidden')) el.setAttribute('hidden', '');
  }

  _addClass(el, cls) {
    if (!el || el.classList.contains(cls)) return;
    el.classList.add(cls);
    this._collapsedAdded.push([el, cls]);
  }

  _foldServersIntoSidebar() {
    const bar = document.getElementById('server-bar');
    const sidebar = document.querySelector('.sidebar');
    if (!bar || !sidebar || bar.dataset.braidFolded === '1') return;
    let strip = sidebar.querySelector('.braid-server-strip');
    if (!strip) {
      strip = document.createElement('div');
      strip.className = 'braid-server-strip';
      strip.id = 'braid-server-strip';
      const header = sidebar.querySelector('.sidebar-header');
      if (header) sidebar.insertBefore(strip, header);
      else sidebar.prepend(strip);
    }
    // Mod Mode's drag handles stay OUT of the strip — folding them in
    // hides them from the editor's own cleanup and they leak, one per
    // edit session. Anything mod-owned rides in the (hidden) bar.
    strip.querySelectorAll('.mod-panel-handle').forEach((h) => bar.appendChild(h));
    [...bar.children].forEach((el) => {
      if (!el.classList.contains('mod-panel-handle')) strip.appendChild(el);
    });
    bar.dataset.braidFolded = '1';
    bar.setAttribute('aria-hidden', 'true');
  }

  // ── Voice dock ───────────────────────────────────────────
  // Stock keeps every in-call control — camera, screen share, soundboard,
  // listen-together, the settings panel with the stream quality pickers —
  // inside the right sidebar, which Braid hides. Relocate the real
  // elements (all voice JS is getElementById-based, and their CSS is
  // ancestor-free) into a dock above the bottom-left Menu, so a call has
  // its full controls without opening the People panel. Original DOM
  // positions are recorded and restored LIFO on suspend/disengage.
  _foldVoiceDock() {
    if (this._suspended || document.getElementById('braid-voice-dock')) return;
    const bottom = document.querySelector('.sidebar-bottom');
    const panel = document.getElementById('voice-panel');
    if (!bottom || !panel) return;
    const dock = document.createElement('div');
    dock.id = 'braid-voice-dock';
    bottom.insertBefore(dock, bottom.firstChild);
    const adopt = (el, parent, before) => {
      if (!el) return;
      this._moved.push([el, el.parentNode, el.nextSibling]);
      parent.insertBefore(el, before || null);
    };
    adopt(document.getElementById('voice-settings-panel'), dock);
    adopt(panel, dock);
    // Both mute/deafen pairs (header pair is default, bottom-bar pair is
    // the haven_sidebar_voice_controls opt-in — stock shows one at a time)
    const anchor = panel.firstChild;
    adopt(document.getElementById('voice-mute-btn-header'), panel, anchor);
    adopt(document.getElementById('voice-deafen-btn-header'), panel, anchor);
    adopt(document.getElementById('voice-mute-btn'), panel, anchor);
    adopt(document.getElementById('voice-deafen-btn'), panel, anchor);
    const people = document.createElement('button');
    people.type = 'button';
    people.id = 'braid-voice-people-btn';
    people.className = 'voice-panel-btn';
    people.title = 'People & voice panel';
    people.innerHTML =
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="8" r="3.2"/><path d="M3.5 19c.6-3 2.8-4.7 5.5-4.7s4.9 1.7 5.5 4.7"/><path d="M16 5.4a3.2 3.2 0 0 1 0 5.9M17.8 14.6c1.5.7 2.4 2 2.7 4"/></svg>';
    people.addEventListener('click', () => this._setPeopleOpen(!document.documentElement.classList.contains('braid-people-open')));
    panel.insertBefore(people, document.getElementById('voice-settings-toggle'));
  }

  _unfoldVoiceDock() {
    document.getElementById('braid-voice-people-btn')?.remove();
    for (const [el, parent, next] of [...(this._moved || [])].reverse()) {
      try { parent.insertBefore(el, next && next.parentNode === parent ? next : null); } catch {}
    }
    this._moved = [];
    document.getElementById('braid-voice-dock')?.remove();
  }

  _collapseJoinCreate() {
    if (localStorage.getItem('haven_join_collapsed') === null) this._setLS('haven_join_collapsed', '1');
    if (localStorage.getItem('haven_create_collapsed') === null) this._setLS('haven_create_collapsed', '1');
    document.querySelectorAll('#join-section-body, #create-section-body').forEach((el) => this._addClass(el, 'collapsed'));
    document.querySelectorAll('#join-section-arrow, #create-section-arrow').forEach((el) => this._addClass(el, 'collapsed'));
    document.querySelectorAll('.sidebar-section[data-mod-id="join"], #admin-controls').forEach((s) => this._addClass(s, 'braid-collapsed'));
  }

  _hideEdgeChrome() {
    // Banners are inline-hidden (their features live in the kebab menu).
    // Soundboard and status bar are hidden by CSS only, so the kebab
    // toggles can bring them back via the braid-sound-open /
    // braid-status-open classes.
    ['desktop-app-banner', 'android-beta-banner', 'update-banner', 'sidebar-toggle-btn'].forEach((id) => {
      this._hide(document.getElementById(id));
    });
    document.querySelectorAll('.sidebar-collapse-btn').forEach((el) => this._hide(el));
    if (!document.documentElement.classList.contains('braid-people-open')) {
      const right = document.getElementById('right-sidebar');
      if (right) {
        this._addClass(right, 'collapsed');
        if (right.style.display !== 'none') right.style.display = 'none';
      }
    }
    this._setLS('haven_hide_desktop_banner', '1');
    this._setLS('haven_hide_android_banner', '1');
    this._setLS('haven_members_collapsed', '1');
  }

  _setPeopleOpen(open) {
    document.documentElement.classList.toggle('braid-people-open', !!open);
    const right = document.getElementById('right-sidebar');
    if (!right) return;
    if (open) {
      right.classList.remove('collapsed');
      right.style.display = '';
      right.style.width = '';
      right.style.opacity = '';
      right.style.pointerEvents = '';
    } else {
      this._addClass(right, 'collapsed');
      if (right.style.display !== 'none') right.style.display = 'none';
    }
  }

  _buildMoreMenu() {
    if (document.querySelector('.braid-more-wrap')) return;
    // The hamburger lives bottom-left, where the icon bar it absorbed
    // used to be — the popups it opens (themes, activities) anchor down
    // there, so the menu and its children share a corner.
    const bar = document.querySelector('.sidebar-bottom-bar');
    const header = document.querySelector('.channel-header');
    const host = bar || header;
    if (!host) return;
    const wrap = document.createElement('div');
    wrap.className = 'braid-more-wrap';
    wrap.innerHTML =
      '<button type="button" class="braid-more-btn" id="braid-more-btn" title="Menu" aria-label="Menu" aria-expanded="false">' +
      '<span class="braid-ham"><span class="braid-ham-line"></span><span class="braid-ham-line"></span><span class="braid-ham-line"></span></span>' +
      '<span class="braid-ham-label">Menu</span></button>';
    host.prepend(wrap);
    // Themes and the layout switch keep first-class seats next to the Menu
    // — always one click, never buried.
    if (bar && !document.getElementById('braid-theme-btn')) {
      const mk = (id, title, paths, onClick) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.id = id;
        b.className = 'braid-bar-btn';
        b.title = title;
        b.setAttribute('aria-label', title);
        b.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
        b.addEventListener('click', onClick);
        bar.appendChild(b);
      };
      mk('braid-theme-btn', 'Themes',
        '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 0 0 18c1.2 0 1.8-.9 1.8-1.8 0-.5-.2-.9-.5-1.3-.3-.4-.5-.8-.5-1.3 0-1 .8-1.8 1.8-1.8H17a4 4 0 0 0 4-4c0-4.4-4-7.8-9-7.8Z"/><circle cx="7.5" cy="11.5" r=".6"/><circle cx="10.5" cy="7.5" r=".6"/><circle cx="15" cy="7.5" r=".6"/>',
        () => document.getElementById('theme-popup-toggle')?.click());
      mk('braid-classic-btn', 'Classic layout (Ctrl+Shift+B)',
        '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M9 4v16M3 9h6"/>',
        () => this._disengage());
    }
    // The menu lives on <body>: the blurred header is a containing block
    // (backdrop-filter) with overflow:hidden, which would trap and clip
    // even a position:fixed dropdown rendered inside it.
    const menu = document.createElement('div');
    menu.className = 'braid-more-menu';
    menu.id = 'braid-more-menu';
    menu.setAttribute('role', 'menu');
    document.body.appendChild(menu);
    const btn = wrap.querySelector('#braid-more-btn');
    // One hamburger absorbs the header extras AND the old bottom-left
    // icon bar — every Haven feature keeps a door, just behind one
    // animated menu instead of chrome on two edges.
    let itemIndex = 0;
    const mi = (paths) =>
      `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
    const addLabel = (text) => {
      const d = document.createElement('div');
      d.className = 'braid-menu-label';
      d.textContent = text;
      d.style.setProperty('--i', itemIndex++);
      menu.appendChild(d);
    };
    // icon + short label; muted hints are reserved for shortcuts only —
    // the menu reads as a glanceable list, not a paragraph.
    const addItem = (icon, label, onClick, muted) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.innerHTML = `<span class="braid-mi">${mi(icon)}</span><span>${label}</span>${muted ? `<span class="muted">${muted}</span>` : ''}`;
      b.style.setProperty('--i', itemIndex++);
      b.addEventListener('click', () => { closeMenu(); onClick(); });
      menu.appendChild(b);
    };
    const addProxy = (id, icon, label, muted) => {
      const src = document.getElementById(id);
      if (src) addItem(icon, label, () => src.click(), muted);
    };
    const toggleHtmlClass = (cls) => document.documentElement.classList.toggle(cls);
    const closeMenu = () => {
      menu.classList.remove('open');
      wrap.classList.remove('open');
      btn.setAttribute('aria-expanded', 'false');
    };
    const I = {
      search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.2-3.2"/>',
      pin: '<path d="M12 21v-6M8 3h8l-1.5 6.5L18 12H6l3.5-2.5Z"/>',
      media: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="m4 18 5-5 3 3 4-4 4 4"/>',
      copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
      code: '<path d="m9 8-4 4 4 4M15 8l4 4-4 4"/>',
      lock: '<rect x="4.5" y="10.5" width="15" height="9.5" rx="2.5"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>',
      people: '<circle cx="9" cy="8" r="3.2"/><path d="M3.5 19c.6-3 2.8-4.7 5.5-4.7s4.9 1.7 5.5 4.7"/><path d="M16 5.4a3.2 3.2 0 0 1 0 5.9M17.8 14.6c1.5.7 2.4 2 2.7 4"/>',
      sound: '<path d="M9 18V6l10-2v11.5"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="15.5" r="2.5"/>',
      pulse: '<path d="M3 12h4l2.5-6 4 12L16 12h5"/>',
      grid: '<rect x="4" y="4" width="16" height="16" rx="2.5"/><path d="M4 9h16M4 15h16M9 4v16M15 4v16"/>',
      classic: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M9 4v16M3 9h6"/>',
      palette: '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 0 0 18c1.2 0 1.8-.9 1.8-1.8 0-.5-.2-.9-.5-1.3-.3-.4-.5-.8-.5-1.3 0-1 .8-1.8 1.8-1.8H17a4 4 0 0 0 4-4c0-4.4-4-7.8-9-7.8Z"/><circle cx="7.5" cy="11.5" r=".6"/><circle cx="10.5" cy="7.5" r=".6"/><circle cx="15" cy="7.5" r=".6"/>',
      game: '<path d="M6 9h4M8 7v4M15 8.5h.01M17.5 11h.01"/><path d="M17.3 5H6.7a4.7 4.7 0 0 0-4.6 4L1.3 14a3.2 3.2 0 0 0 5.7 2.6L8.6 14h6.8l1.6 2.6A3.2 3.2 0 0 0 22.7 14l-.8-5a4.7 4.7 0 0 0-4.6-4Z"/>',
      gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.01a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55h.01a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.01a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1Z"/>',
      heart: '<path d="M12 20.3 4.8 13a4.7 4.7 0 0 1 6.6-6.6l.6.6.6-.6a4.7 4.7 0 0 1 6.6 6.6Z"/>',
      desktop: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
      phone: '<rect x="7" y="3" width="10" height="18" rx="2.5"/><path d="M11 18h2"/>',
    };
    addLabel('Channel');
    addProxy('search-toggle-btn', I.search, 'Search');
    addProxy('pinned-toggle-btn', I.pin, 'Pinned');
    addProxy('gallery-toggle-btn', I.media, 'Files & media');
    addProxy('copy-code-btn', I.copy, 'Copy code');
    addProxy('channel-code-settings-btn', I.code, 'Code settings');
    addProxy('e2e-menu-btn', I.lock, 'Encryption');
    addLabel('View');
    addItem(I.people, 'People & voice', () => this._setPeopleOpen(!document.documentElement.classList.contains('braid-people-open')));
    addItem(I.sound, 'Soundboard', () => toggleHtmlClass('braid-sound-open'));
    addItem(I.pulse, 'Status bar', () => toggleHtmlClass('braid-status-open'));
    addItem(I.grid, 'Edit layout', () => {
      const mm = window.app && window.app.modMode;
      if (mm) mm.toggle();
      else document.getElementById('mod-mode-settings-toggle')?.click();
    });
    addItem(I.classic, 'Classic layout', () => this._disengage(), 'Ctrl⇧B');
    addLabel('App');
    addProxy('theme-popup-toggle', I.palette, 'Themes');
    addProxy('activities-btn', I.game, 'Activities');
    addProxy('sidebar-members-btn', I.people, 'All members');
    addItem(I.gear, 'Settings', () => {
      document.getElementById('open-settings-btn')?.click();
      document.getElementById('mobile-settings-btn')?.click();
    });
    addProxy('donors-btn', I.heart, 'Support Haven');
    const desktopBanner = document.getElementById('desktop-app-banner');
    if (desktopBanner) addItem(I.desktop, 'Desktop app', () => (desktopBanner.querySelector('a') || desktopBanner).click());
    const androidBanner = document.getElementById('android-beta-banner');
    if (androidBanner) addItem(I.phone, 'Android app', () => androidBanner.click());
    const peopleHdr = document.getElementById('mobile-users-btn');
    if (peopleHdr) {
      this._listen(peopleHdr, 'click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this._setPeopleOpen(!document.documentElement.classList.contains('braid-people-open'));
      }, true);
    }
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const opening = !menu.classList.contains('open');
      menu.classList.toggle('open', opening);
      wrap.classList.toggle('open', opening);
      btn.setAttribute('aria-expanded', opening ? 'true' : 'false');
    });
    this._listen(document, 'click', (e) => {
      if (!wrap.contains(e.target) && !menu.contains(e.target)) closeMenu();
    });
  }

  _quietChips() {
    const vc = document.querySelector('.voice-controls');
    if (!vc) return;
    vc.querySelectorAll('button, .pill, .chip, span, div').forEach((el) => {
      const t = (el.textContent || '').toLowerCase();
      if (t.includes('get the desktop') || t.includes('android app')) this._hide(el);
    });
  }

  _applyLayout() {
    if (this._suspended) return;
    this._foldServersIntoSidebar();
    this._foldVoiceDock();
    this._hideEdgeChrome();
    this._quietChips();
    this._markRuns();
    this._themeBottomIcons();
    this._themeSettingsNav();
    this._injectTextSliders();
  }

  // ── Text size sliders (Settings → Text Size card) ────────
  _applyTextScales() {
    const chat = parseFloat(HavenApi.Data.load('BraidLayout', 'chatScale', '1')) || 1;
    const ui = parseFloat(HavenApi.Data.load('BraidLayout', 'uiScale', '1')) || 1;
    document.documentElement.style.setProperty('--braid-chat-scale', chat);
    document.documentElement.style.setProperty('--braid-ui-scale', ui);
  }

  _injectTextSliders() {
    if (document.getElementById('braid-text-sliders')) return;
    const anchor = document.getElementById('section-font-size');
    if (!anchor) return;
    const card = document.createElement('div');
    card.className = 'settings-section';
    card.id = 'braid-text-sliders';
    const row = (id, label, min, max) => `
      <div style="display:flex;align-items:center;gap:.75rem;margin-top:.625rem">
        <span style="flex:0 0 7.5rem;font-size:.8125rem;color:var(--text-secondary)">${label}</span>
        <input type="range" id="${id}" min="${min}" max="${max}" step="5" style="flex:1;accent-color:var(--accent)">
        <span id="${id}-val" style="flex:0 0 3rem;text-align:right;font-size:.75rem;color:var(--text-muted)"></span>
      </div>`;
    card.innerHTML = `
      <h5 class="settings-section-subtitle">🪢 Braid text size</h5>
      <p style="font-size:.75rem;color:var(--text-muted);margin:.25rem 0 0">Continuous sliders, layered on top of Zoom — chat text and interface text scale independently.</p>
      ${row('braid-chat-scale', 'Chat text', 80, 160)}
      ${row('braid-ui-scale', 'Interface text', 85, 140)}`;
    anchor.after(card);
    const wire = (id, key) => {
      const input = card.querySelector(`#${id}`);
      const val = card.querySelector(`#${id}-val`);
      const current = Math.round((parseFloat(HavenApi.Data.load('BraidLayout', key, '1')) || 1) * 100);
      input.value = current;
      val.textContent = `${current}%`;
      input.addEventListener('input', () => {
        const scale = parseInt(input.value, 10) / 100;
        val.textContent = `${input.value}%`;
        HavenApi.Data.save('BraidLayout', key, String(scale));
        document.documentElement.style.setProperty(key === 'chatScale' ? '--braid-chat-scale' : '--braid-ui-scale', scale);
      });
    };
    wire('braid-chat-scale', 'chatScale');
    wire('braid-ui-scale', 'uiScale');
  }

  // ── Hex loader ───────────────────────────────────────────
  _showHexLoader() {
    if (this._suspended || document.getElementById('braid-hex-overlay')) return;
    const main = document.querySelector('.main');
    if (!main) return;
    const overlay = document.createElement('div');
    overlay.id = 'braid-hex-overlay';
    overlay.innerHTML = '<span class="braid-hex-loader" role="status" aria-label="Loading"></span>';
    main.appendChild(overlay);
    setTimeout(() => overlay.classList.add('braid-fade'), 520);
    setTimeout(() => overlay.remove(), 740);
  }

  // ── Mod Mode interop ─────────────────────────────────────
  // While the layout editor is active the Braid gates come off and the
  // server rail unfolds, so every draggable section and panel handle is
  // real and visible. On exit the layer re-applies — and honours any
  // custom section order the user just saved (see _evalOrderCSS).
  _suspend() {
    this._suspended = true;
    this._showModDone();
    this._unfoldVoiceDock();
    const bar = document.getElementById('server-bar');
    const strip = document.getElementById('braid-server-strip');
    if (bar && strip) {
      while (strip.firstChild) bar.appendChild(strip.firstChild);
      delete bar.dataset.braidFolded;
      bar.removeAttribute('aria-hidden');
      bar.style.display = '';
    }
    const right = document.getElementById('right-sidebar');
    if (right) right.style.display = '';
    document.documentElement.removeAttribute('data-braid-layout');
    document.documentElement.removeAttribute('data-braid-form');
  }

  _resume() {
    this._suspended = false;
    document.getElementById('braid-mod-done')?.remove();
    document.documentElement.setAttribute('data-braid-layout', '1');
    document.documentElement.setAttribute('data-braid-form', '1');
    this._setPeopleOpen(document.documentElement.classList.contains('braid-people-open'));
    this._applyLayout();
  }

  // ── Themed bottom-left icons ─────────────────────────────
  // The stock buttons are colored emoji, which fight every palette.
  // Swap them for line icons drawn with currentColor so they follow
  // the theme like the rest of the chrome; originals are stashed for
  // stop(). Buttons added later (voice mute/deafen appear on join)
  // are themed by the observer pass.
  _themeBottomIcons() {
    const svg = (paths) =>
      `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
    const icons = {
      'theme-popup-toggle': svg('<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 0 0 18c1.2 0 1.8-.9 1.8-1.8 0-.5-.2-.9-.5-1.3-.3-.4-.5-.8-.5-1.3 0-1 .8-1.8 1.8-1.8H17a4 4 0 0 0 4-4c0-4.4-4-7.8-9-7.8Z"/><circle cx="7.5" cy="11.5" r=".6"/><circle cx="10.5" cy="7.5" r=".6"/><circle cx="15" cy="7.5" r=".6"/>'),
      'activities-btn': svg('<path d="M6 9h4M8 7v4M15 8.5h.01M17.5 11h.01"/><path d="M17.3 5H6.7a4.7 4.7 0 0 0-4.6 4L1.3 14a3.2 3.2 0 0 0 5.7 2.6L8.6 14h6.8l1.6 2.6A3.2 3.2 0 0 0 22.7 14l-.8-5a4.7 4.7 0 0 0-4.6-4Z"/>'),
      'sidebar-members-btn': svg('<circle cx="9" cy="8" r="3.2"/><path d="M3.5 19c.6-3 2.8-4.7 5.5-4.7s4.9 1.7 5.5 4.7"/><path d="M16 5.4a3.2 3.2 0 0 1 0 5.9M17.8 14.6c1.5.7 2.4 2 2.7 4"/>'),
      'mobile-settings-btn': svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.01a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55h.01a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.01a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1Z"/>'),
      'donors-btn': svg('<path d="M12 20.3 4.8 13a4.7 4.7 0 0 1 6.6-6.6l.6.6.6-.6a4.7 4.7 0 0 1 6.6 6.6Z"/>'),
    };
    // voice mute/deafen deliberately absent: they live in the voice dock
    // now, where _syncMuteDeafenButtons rewrites textContent on every
    // state change — an injected SVG would be clobbered mid-call anyway.
    Object.entries(icons).forEach(([id, markup]) => {
      const btn = document.getElementById(id);
      if (!btn || btn.dataset.braidIcon === '1') return;
      btn.dataset.braidIcon = '1';
      btn.dataset.braidOrig = btn.innerHTML;
      btn.innerHTML = markup;
    });
  }

  _restoreBottomIcons() {
    document.querySelectorAll('[data-braid-icon="1"]').forEach((btn) => {
      btn.innerHTML = btn.dataset.braidOrig || btn.innerHTML;
      delete btn.dataset.braidIcon;
      delete btn.dataset.braidOrig;
    });
  }

  // ── Themed settings-nav icons ────────────────────────────
  // Same treatment as the old bottom-left buttons: the leading emoji on
  // every nav row (and the User/Admin tabs) becomes a currentColor line
  // glyph, so the rail follows the palette. Unmapped rows get the Haven
  // hexagon. Idempotent per element; originals restore on disable.
  _themeSettingsNav() {
    const svg = (paths, size = 15) =>
      `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
    const hex = '<path d="M12 2.5 20.2 7.25v9.5L12 21.5 3.8 16.75v-9.5Z"/>';
    const map = {
      'section-language': '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14.5 14.5 0 0 1 0 18M12 3a14.5 14.5 0 0 0 0 18"/>',
      'section-density': '<rect x="3" y="3" width="18" height="18" rx="2.5"/><path d="M9 3v18M3 9h6"/>',
      'section-font-size': '<path d="M4 19 10 5h1.5L17.5 19M6.2 14h8.1M19 12v7M16.5 14.5 19 12l2.5 2.5"/>',
      'section-emoji-size': '<circle cx="12" cy="12" r="9"/><path d="M8.5 14.5a4.5 4.5 0 0 0 7 0M9 9.5h.01M15 9.5h.01"/>',
      'section-role-display': '<path d="M12 2.7 20 7v10l-8 4.3L4 17V7Z"/><circle cx="12" cy="10" r="2.2"/><path d="M8.5 16.2c.7-1.8 1.9-2.7 3.5-2.7s2.8.9 3.5 2.7"/>',
      'section-toolbar-icons': '<path d="M14.7 6.3a4 4 0 0 0-5.2 5.2L4 17l3 3 5.5-5.5a4 4 0 0 0 5.2-5.2l-2.6 2.6-2.4-2.4Z"/>',
      'section-image-display': '<rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="m4 18 5-5 3 3 4-4 4 4"/>',
      'section-embed-size': '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="m10.5 9 4.5 3-4.5 3Z"/>',
      'section-statusbar': '<path d="M3 12h4l2.5-6 4 12L16 12h5"/>',
      'section-chat-behavior': '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 21l1.9-5.4A8 8 0 1 1 21 12Z"/>',
      'section-soundboard-mode': '<path d="M9 18V6l10-2v11.5"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="15.5" r="2.5"/>',
      'section-sounds': '<path d="M4 10v4h3.5L12 18V6l-4.5 4Z"/><path d="M15.5 9a4.2 4.2 0 0 1 0 6M18 6.7a8 8 0 0 1 0 10.6"/>',
      'section-push': '<path d="M18 9a6 6 0 1 0-12 0c0 6-2.5 7-2.5 7h17S18 15 18 9"/><path d="M10.3 20a2 2 0 0 0 3.4 0"/>',
      'section-activity': '<circle cx="12" cy="12" r="2"/><path d="M7.5 7.5a6.4 6.4 0 0 0 0 9M16.5 7.5a6.4 6.4 0 0 1 0 9M4.6 4.6a10.5 10.5 0 0 0 0 14.8M19.4 4.6a10.5 10.5 0 0 1 0 14.8"/>',
      'section-score-badges': '<circle cx="12" cy="9" r="5.5"/><path d="m8.8 13.7-1.5 6.8 4.7-2.7 4.7 2.7-1.5-6.8"/>',
      'section-password': '<rect x="4.5" y="10.5" width="15" height="9.5" rx="2.5"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3M12 14.5v2"/>',
      'section-two-factor': '<path d="M12 2.7 20 6.5v5.2c0 4.8-3.2 8.2-8 9.6-4.8-1.4-8-4.8-8-9.6V6.5Z"/><path d="m8.8 12 2.2 2.2 4.2-4.4"/>',
      'section-recovery': '<circle cx="8.5" cy="8.5" r="5"/><path d="m12 12 8.5 8.5M17 17l2-2M14.5 19.5l2-2"/>',
      'section-account': '<circle cx="12" cy="8.5" r="4"/><path d="M4.5 20c.9-4 3.7-6 7.5-6s6.6 2 7.5 6"/>',
      'section-plugins': '<path d="M10 3.5V6H7a2 2 0 0 0-2 2v3H2.5v2H5v3a2 2 0 0 0 2 2h3v2.5h2V18h3a2 2 0 0 0 2-2v-3h2.5v-2H19V8a2 2 0 0 0-2-2h-3V3.5Z"/>',
      'section-debug': '<rect x="8" y="7" width="8" height="11" rx="4"/><path d="M12 7V4.5M6 10H3.5M20.5 10H18M6 15H3.5M20.5 15H18M9 5.5 7.5 4M15 5.5 16.5 4"/>',
      'section-modmode': '<path d="M4 9h16M4 15h16M9 4v16M15 4v16"/><rect x="4" y="4" width="16" height="16" rx="2.5"/>',
    };
    document.querySelectorAll('.settings-nav-item').forEach((item) => {
      if (item.dataset.braidIcon === '1') return;
      item.dataset.braidIcon = '1';
      item.dataset.braidOrig = item.innerHTML;
      const label = item.querySelector('span');
      const paths = map[item.dataset.target] || hex;
      if (label) {
        item.innerHTML = svg(paths);
        item.appendChild(label);
      } else {
        const text = item.textContent.replace(/^[^\p{L}\p{N}]+\s*/u, '').trim();
        item.innerHTML = `${svg(paths)}<span>${text}</span>`;
      }
    });
    document.querySelectorAll('.settings-tab').forEach((tab) => {
      if (tab.dataset.braidIcon === '1') return;
      tab.dataset.braidIcon = '1';
      tab.dataset.braidOrig = tab.innerHTML;
      const label = tab.querySelector('span');
      const paths = tab.dataset.tab === 'admin'
        ? '<path d="M12 2.7 20 6.5v5.2c0 4.8-3.2 8.2-8 9.6-4.8-1.4-8-4.8-8-9.6V6.5Z"/>'
        : '<circle cx="12" cy="8.5" r="4"/><path d="M4.5 20c.9-4 3.7-6 7.5-6s6.6 2 7.5 6"/>';
      if (label) {
        tab.innerHTML = svg(paths, 13);
        tab.appendChild(label);
      }
    });
  }

  // Run position for the merged cards, desktop twin of Haven-Mobile's
  // braidForm(). This is deliberately NOT :has(+ .message-compact) —
  // Chromium re-runs :has() invalidation on every sibling insert, which
  // made a 600-message channel load go quadratic (622ms vs 80ms).
  // Attribute marking here is O(n) per observer batch.
  //
  // Runs chain on AUTHOR, not on the app's compact grouping: consecutive
  // posts by the same user (same persona, no explicit break_chain, not a
  // system notice) merge into one card even when the app rendered them as
  // separate full .message elements. A continuing .message gets
  // data-braid-cont="1" — its avatar/header hide and its timestamp
  // surfaces in the gutter on hover via data-time-short.
  _markRuns() {
    const runOf = (first, last) => (first ? (last ? 'solo' : 'start') : (last ? 'end' : 'mid'));
    const chainKey = (el) => {
      if (!el || (!el.classList.contains('message') && !el.classList.contains('message-compact'))) return null;
      if (el.classList.contains('system-message') || el.classList.contains('announcement')) return null;
      return `${el.dataset.userId || '?'}|${el.dataset.personaId || ''}`;
    };
    const nodes = [...document.querySelectorAll('.messages > .message, .messages > .message-compact')];
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      const key = chainKey(el);
      const prevKey = i > 0 ? chainKey(nodes[i - 1]) : null;
      const nextEl = i + 1 < nodes.length ? nodes[i + 1] : null;
      const nextKey = chainKey(nextEl);
      const first = !key || key !== prevKey || el.dataset.breakChain === '1';
      const last = !key || key !== nextKey || (nextEl && nextEl.dataset.breakChain === '1');
      const v = runOf(first, last);
      if (el.getAttribute('data-braid-run') !== v) el.setAttribute('data-braid-run', v);
      const cont = !first && el.classList.contains('message') ? '1' : null;
      if (cont) { if (el.getAttribute('data-braid-cont') !== '1') el.setAttribute('data-braid-cont', '1'); }
      else if (el.hasAttribute('data-braid-cont')) el.removeAttribute('data-braid-cont');
    }
    document.querySelectorAll('.channel-item').forEach((el) => {
      const prev = el.previousElementSibling;
      const next = el.nextElementSibling;
      const v = runOf(!prev || !prev.classList.contains('channel-item'), !next || !next.classList.contains('channel-item'));
      if (el.getAttribute('data-braid-run') !== v) el.setAttribute('data-braid-run', v);
    });
  }

  // Own messages get an accent-tinted card, like mobile.
  _paintOwn() {
    let id = null;
    try { id = (JSON.parse(localStorage.getItem('haven_user') || 'null') || {}).id; } catch {}
    if (!id) { HavenApi.DOM.removeStyle('BraidFormOwn'); return; }
    const sel = `html[data-braid-form="1"] .message[data-user-id="${id}"]>.message-row>.message-body,` +
      `html[data-braid-form="1"] .message-compact[data-user-id="${id}"]>.message-body`;
    HavenApi.DOM.addStyle('BraidFormOwn',
      `${sel}{background:var(--braid-me);border-color:var(--braid-me-line)}` +
      sel.split(',').map((s) => s + ':hover').join(',') +
      `{background:color-mix(in srgb,var(--accent) 18%,var(--bg-secondary))}`);
  }
}

BraidLayout._LAYOUT_CSS = `
/* Button fills mix from text-primary, not a fixed surface: guaranteed
   contrast against the ground in light AND dark palettes alike. */
html[data-braid-layout="1"]{--sidebar-width:17.5rem;--braid-bar-h:3rem;--braid-btn-bg:color-mix(in srgb,var(--text-primary) 7%,var(--bg-secondary));--braid-btn-bg-hover:color-mix(in srgb,var(--text-primary) 13%,var(--bg-secondary));--braid-btn-line:color-mix(in srgb,var(--text-primary) 18%,var(--border))}
html[data-braid-layout="1"] .channel-topic-bar{background:transparent!important;border-bottom:0!important;padding:.125rem 1.75rem .375rem!important;font-size:.71875rem!important;min-height:0!important;line-height:1.4!important;color:var(--text-muted)!important}
html[data-braid-layout="1"] .sidebar-section[data-mod-id="join"] .section-label,
html[data-braid-layout="1"] .sidebar-section#admin-controls .section-label{padding:.3125rem .5rem!important}
html[data-braid-layout="1"] .user-bar{padding:.5rem .625rem!important}
html[data-braid-layout="1"] .sidebar-bottom-bar{padding:.375rem .5rem!important}
html[data-braid-layout="1"] .message-input-area .icon-btn,
html[data-braid-layout="1"] .message-input-area>button,
html[data-braid-layout="1"] .message-input-container .icon-btn{width:2rem;height:2rem}
html[data-braid-layout="1"] body,
html[data-braid-layout="1"] #app{overflow:hidden}
html[data-braid-layout="1"] #app-body{display:flex!important;flex-direction:row!important;min-height:0;height:100%}
html[data-braid-layout="1"] .server-bar{display:none!important}
/* width deliberately NOT !important — the stock resize handle writes an
   inline style.width (persisted as haven_sidebar_width) and must win */
html[data-braid-layout="1"] .sidebar{width:var(--sidebar-width);min-width:12.5rem;max-width:25rem;flex:0 0 auto!important;background:var(--bg-secondary)!important;border-right:1px solid var(--border)!important;display:flex!important;flex-direction:column!important;position:relative;z-index:5}
html[data-braid-layout="1"] .braid-server-strip{display:flex;align-items:center;gap:.3125rem;padding:.625rem .625rem .5rem;overflow-x:auto;border-bottom:1px solid var(--border);flex-shrink:0;scrollbar-width:none}
html[data-braid-layout="1"] .braid-server-strip::-webkit-scrollbar{display:none;width:0;height:0}
html[data-braid-layout="1"] .braid-server-strip .server-icon{width:2.25rem!important;height:2.25rem!important;min-width:2.25rem;border-radius:.6875rem!important;flex-shrink:0;position:relative}
/* #server-list is a plain block div — inside the horizontal strip its
   children would stack vertically (exactly what broke multi-server
   setups). Flex it inline so every icon rides the same row. */
html[data-braid-layout="1"] .braid-server-strip #server-list{display:flex;align-items:center;gap:.3125rem;min-width:0;flex-shrink:0}
html[data-braid-layout="1"] .braid-server-strip .server-separator{width:1px;height:1.375rem;background:var(--border);border-radius:0;margin:0 .1875rem;flex-shrink:0}
html[data-braid-layout="1"] .braid-server-strip .server-icon-img{border-radius:inherit}
html[data-braid-layout="1"] .braid-server-strip .server-status-dot{width:.625rem;height:.625rem;bottom:-2px;right:-2px;border-width:2px}
html[data-braid-layout="1"] .braid-server-strip .server-icon.manage-servers,
html[data-braid-layout="1"] .braid-server-strip .server-icon.sync-servers{background:var(--braid-btn-bg)}
html[data-braid-layout="1"] .braid-server-strip .server-icon.add-server{border-color:var(--braid-btn-line)}
html[data-braid-layout="1"] .braid-server-strip .server-icon.add-server,
html[data-braid-layout="1"] .braid-server-strip .server-icon.manage-servers,
html[data-braid-layout="1"] .braid-server-strip .server-icon.sync-servers{width:1.875rem!important;height:1.875rem!important;min-width:1.875rem;border-radius:.5625rem!important}
html[data-braid-layout="1"] .braid-server-strip .server-icon.add-server{margin-left:auto}
html[data-braid-layout="1"] .braid-server-strip .server-icon.add-server .server-icon-text{font-size:1rem}
html[data-braid-layout="1"] .braid-server-strip .server-icon.manage-servers .server-icon-text,
html[data-braid-layout="1"] .braid-server-strip .server-icon.sync-servers .server-icon-text{font-size:.875rem}
html[data-braid-layout="1"] .sidebar-header{order:0;padding:.625rem .75rem!important;border-bottom:1px solid var(--border)!important;background:color-mix(in srgb,var(--bg-secondary) 92%,transparent)!important;backdrop-filter:saturate(180%) blur(14px);-webkit-backdrop-filter:saturate(180%) blur(14px)}
html[data-braid-layout="1"] .brand{margin-bottom:.5rem!important;gap:.5rem!important}
html[data-braid-layout="1"] .brand-text{font-size:.9375rem!important;font-weight:650!important;letter-spacing:-.03em!important;text-transform:none!important}
html[data-braid-layout="1"] .user-bar{border-radius:.75rem!important;padding:.5rem .625rem!important;gap:.5rem!important;background:var(--braid-btn-bg)!important;border:1px solid var(--braid-btn-line)!important}
html[data-braid-layout="1"] .sidebar-mod-container{order:1;flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;padding:2px 0 .375rem}
html[data-braid-layout="1"] .sidebar-section[data-mod-id="join"],
html[data-braid-layout="1"] .sidebar-section#admin-controls{border:0!important;padding:2px .625rem!important;margin:0!important}
html:not([data-braid-layout="1"]) .braid-more-wrap,
html:not([data-braid-layout="1"]) .braid-more-menu,
html:not([data-braid-layout="1"]) .braid-bar-btn,
html:not([data-braid-layout="1"]) .braid-server-strip{display:none!important}
html[data-braid-layout="1"] .sidebar-section[data-mod-id="join"] .section-label,
html[data-braid-layout="1"] .sidebar-section#admin-controls .section-label{font-size:.71875rem!important;letter-spacing:0!important;text-transform:none!important;font-weight:550!important;color:var(--text-muted)!important;margin:2px 0!important;padding:.4375rem .5rem;border-radius:.625rem}
html[data-braid-layout="1"] .sidebar-section[data-mod-id="join"] .section-label:hover,
html[data-braid-layout="1"] .sidebar-section#admin-controls .section-label:hover{background:var(--bg-hover);color:var(--text-primary)}
html[data-braid-layout="1"] .sidebar-section[data-mod-id="join"].braid-collapsed .collapsible-section-body,
html[data-braid-layout="1"] .sidebar-section#admin-controls.braid-collapsed .collapsible-section-body,
html[data-braid-layout="1"] #join-section-body.collapsed,
html[data-braid-layout="1"] #create-section-body.collapsed{display:none!important}
html[data-braid-layout="1"] .sidebar-split{flex:1;min-height:0;display:flex;flex-direction:column;border:0!important}
html[data-braid-layout="1"] .channel-section{flex:1;min-height:0;padding:2px .375rem .375rem!important;border:0!important}
html[data-braid-layout="1"] .dm-section-pane{flex:0 0 auto;max-height:28%;padding:2px .375rem .375rem!important;border-top:1px solid var(--border)!important}
html[data-braid-layout="1"] .section-label.channels-toggle,
html[data-braid-layout="1"] .section-label.dm-section-label{font-size:.625rem!important;font-weight:650!important;letter-spacing:.12em!important;text-transform:uppercase!important;color:var(--text-muted)!important;margin:.5rem .5rem .25rem!important}
html[data-braid-layout="1"] .channel-item{margin:1px .375rem!important;padding:.5rem .625rem!important;border-radius:.625rem!important}
html[data-braid-layout="1"] .channel-item.active{background:var(--bg-active)!important}
html[data-braid-layout="1"] .sidebar-bottom{order:4;border-top:1px solid var(--border)!important;background:var(--bg-secondary)!important;flex-shrink:0}
html[data-braid-layout="1"] .sidebar-bottom-bar{padding:.5rem!important;gap:2px!important;display:flex;align-items:center}
html[data-braid-layout="1"] .sidebar-bottom-btn{width:2.125rem;height:2.125rem;border-radius:.625rem!important;border:0!important;background:transparent!important;color:var(--text-muted)!important}
html[data-braid-layout="1"] .sidebar-bottom-btn:hover{background:var(--bg-hover)!important;color:var(--text-primary)!important}
html[data-braid-layout="1"] .theme-popup{position:fixed!important;left:1rem!important;bottom:4rem!important;top:auto!important;right:auto!important;width:min(18.75rem,calc(100vw - 2.5rem))!important;max-height:min(60vh,30rem)!important;overflow:auto!important;z-index:80!important;border-radius:1rem!important;border:1px solid var(--border)!important;box-shadow:0 16px 48px -12px rgba(0,0,0,.28),var(--braid-shadow,0 1px 2px rgba(0,0,0,.2))!important;background:var(--bg-card)!important;padding:.75rem!important}
html[data-braid-layout="1"] .main{flex:1!important;min-width:0!important;display:flex!important;flex-direction:column!important;background:var(--bg-primary)!important;position:relative}
html[data-braid-layout="1"] .channel-header{flex:0 0 var(--braid-bar-h)!important;min-height:var(--braid-bar-h)!important;max-height:var(--braid-bar-h)!important;padding:0 .75rem 0 1rem!important;gap:.375rem!important;overflow:hidden;display:flex;align-items:center!important;background:color-mix(in srgb,var(--bg-secondary) 90%,transparent)!important;backdrop-filter:saturate(180%) blur(16px)!important;-webkit-backdrop-filter:saturate(180%) blur(16px)!important;border-bottom:1px solid var(--border)!important}
html[data-braid-layout="1"] #channel-header-name{font-size:.90625rem!important;font-weight:650!important;letter-spacing:-.02em!important;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:min(40vw,20rem)}
html[data-braid-layout="1"] .header-actions-box{display:flex!important;align-items:center;gap:2px!important;padding:0!important;border:0!important;background:transparent!important}
html[data-braid-layout="1"] .header-actions-box .channel-code-tag,
html[data-braid-layout="1"] .header-actions-box #copy-code-btn,
html[data-braid-layout="1"] .header-actions-box #channel-code-settings-btn,
html[data-braid-layout="1"] .header-actions-box .header-actions-divider{display:none!important}
html[data-braid-layout="1"] .header-actions-box .icon-btn{width:2.125rem;height:2.125rem;border-radius:.625rem;color:var(--text-muted)}
html[data-braid-layout="1"] .header-actions-box .icon-btn:hover{background:var(--bg-hover);color:var(--text-primary)}
html[data-braid-layout="1"] #desktop-app-banner,
html[data-braid-layout="1"] #android-beta-banner,
html[data-braid-layout="1"] #update-banner{display:none!important;visibility:hidden!important;pointer-events:none!important;width:0!important;height:0!important;overflow:hidden!important;margin:0!important;padding:0!important}
html[data-braid-layout="1"] .voice-controls{display:flex;align-items:center;gap:.25rem;margin-left:auto;flex-shrink:0}
html[data-braid-layout="1"] .voice-active-indicator,
html[data-braid-layout="1"] .btn-voice{border-radius:999px!important;border:1px solid var(--border)!important;background:var(--bg-tertiary)!important;color:var(--text-secondary)!important;font-size:.75rem!important;font-weight:550!important;padding:.25rem .625rem!important;box-shadow:none!important}
html[data-braid-layout="1"] .voice-active-indicator{background:color-mix(in srgb,var(--accent) 10%,var(--bg-tertiary))!important;border-color:color-mix(in srgb,var(--accent) 28%,var(--border))!important;color:var(--accent)!important}
html[data-braid-layout="1"] .voice-controls button[style*="background"],
html[data-braid-layout="1"] .voice-controls div[style*="background"],
html[data-braid-layout="1"] .voice-controls span[style*="background"]{background:var(--bg-tertiary)!important;color:var(--text-secondary)!important;border:1px solid var(--border)!important;border-radius:999px!important;box-shadow:none!important}
/* ── Voice dock ── the relocated stock controls, bottom-left. Camera,
   screen share, soundboard, listen-together, settings (stream quality
   lives in there), people, leave — every streaming option in reach. */
html[data-braid-layout="1"] #braid-voice-dock{flex-shrink:0;display:flex;flex-direction:column;min-width:0}
html[data-braid-layout="1"] #braid-voice-dock .voice-panel{border-top:1px solid var(--border)!important;border-bottom:0!important;background:var(--bg-secondary)!important;padding:.4375rem .5rem!important;gap:.25rem!important;justify-content:flex-start!important;flex-wrap:wrap}
html[data-braid-layout="1"] #braid-voice-dock .voice-panel-btn,
html[data-braid-layout="1"] #braid-voice-dock .voice-header-btn{width:2rem;height:2rem;border-radius:.625rem!important;border:1px solid var(--braid-btn-line)!important;background:var(--braid-btn-bg)!important;color:var(--text-primary)!important;font-size:.875rem;display:inline-flex;align-items:center;justify-content:center;padding:0;line-height:1;cursor:pointer;transition:background .15s,color .15s,border-color .15s,transform .12s}
html[data-braid-layout="1"] #braid-voice-dock .voice-panel-btn:hover,
html[data-braid-layout="1"] #braid-voice-dock .voice-header-btn:hover{background:var(--braid-btn-bg-hover)!important;color:var(--text-primary)!important;border-color:color-mix(in srgb,var(--accent) 40%,var(--braid-btn-line))!important}
html[data-braid-layout="1"] #braid-voice-dock .voice-panel-btn:active,
html[data-braid-layout="1"] #braid-voice-dock .voice-header-btn:active{transform:scale(.92)}
html[data-braid-layout="1"] #braid-voice-dock .voice-panel-btn.active,
html[data-braid-layout="1"] #braid-voice-dock .voice-header-btn.active{background:color-mix(in srgb,var(--accent) 16%,var(--bg-tertiary))!important;border-color:var(--accent)!important;color:var(--accent)!important}
html[data-braid-layout="1"] #braid-voice-dock .voice-panel-btn.sharing{background:color-mix(in srgb,var(--success) 18%,var(--bg-tertiary))!important;border-color:var(--success)!important;color:var(--success)!important}
html[data-braid-layout="1"] #braid-voice-dock .voice-panel-btn.muted,
html[data-braid-layout="1"] #braid-voice-dock .voice-header-btn.muted{background:color-mix(in srgb,var(--warning) 20%,var(--bg-tertiary))!important;border-color:var(--warning)!important;color:var(--warning)!important}
html[data-braid-layout="1"] #braid-voice-dock .voice-panel-divider{height:1.375rem;margin:0 .25rem;background:var(--border)}
html[data-braid-layout="1"] #braid-voice-dock .voice-panel-leave{margin-left:auto;width:2rem;height:2rem;font-size:.75rem;background:color-mix(in srgb,var(--danger) 14%,var(--bg-tertiary))!important;border-color:color-mix(in srgb,var(--danger) 45%,var(--border))!important;color:var(--danger)!important}
html[data-braid-layout="1"] #braid-voice-dock .voice-panel-leave:hover{background:var(--danger)!important;color:#fff!important;border-color:var(--danger)!important}
html[data-braid-layout="1"] #braid-voice-dock .voice-settings-panel{border-top:1px solid var(--border)!important;border-bottom:0!important;background:var(--bg-secondary)!important;max-height:min(46vh,21rem);overflow:auto;padding:.625rem .75rem!important;scrollbar-width:thin}
html[data-braid-layout="1"] #braid-voice-dock .voice-settings-select{border-radius:.5625rem!important;border:1px solid var(--border)!important;background:var(--bg-input,var(--bg-tertiary))!important}
html[data-braid-layout="1"] #braid-voice-dock .voice-settings-section-label{font-size:.625rem;font-weight:650;letter-spacing:.12em;text-transform:uppercase;color:var(--text-muted)}
/* The in-call status bar rides between dock and Menu — same quiet chrome */
html[data-braid-layout="1"] .sidebar-bottom .voice-bar{border-top:1px solid var(--border)!important;background:var(--bg-secondary)!important;padding:.375rem .625rem!important;box-shadow:none!important}
html[data-braid-layout="1"] .sidebar-bottom .voice-bar-channel{font-size:.71875rem;color:var(--text-muted)}
html[data-braid-layout="1"] .sidebar-bottom .voice-bar-badge{border-radius:999px!important;font-size:.59375rem;border:1px solid var(--braid-btn-line);background:var(--braid-btn-bg)}
html[data-braid-layout="1"] .sidebar-bottom .voice-bar-leave{border-radius:.625rem!important;box-shadow:none!important;background:var(--braid-btn-bg)!important;border:1px solid var(--braid-btn-line)!important;color:var(--text-primary)!important}
html[data-braid-layout="1"] .sidebar-bottom .voice-bar-leave:hover{background:color-mix(in srgb,var(--danger) 18%,var(--bg-secondary))!important;border-color:var(--danger)!important;color:var(--danger)!important}
html[data-braid-layout="1"] .message-area{flex:1;min-height:0;display:flex;flex-direction:column}
html[data-braid-layout="1"] .messages{padding:1.125rem 1.75rem .5rem!important;width:100%;box-sizing:border-box}
html[data-braid-layout="1"] .message-input-area,
html[data-braid-layout="1"] .message-input-container{padding:.5rem 1rem .75rem!important;width:100%;box-sizing:border-box;border-top:1px solid var(--border)!important;background:color-mix(in srgb,var(--bg-secondary) 94%,transparent)!important}
html[data-braid-layout="1"] .right-sidebar,
html[data-braid-layout="1"] .right-sidebar.collapsed,
html[data-braid-layout="1"] #right-sidebar{display:none!important;width:0!important;min-width:0!important;max-width:0!important;border:0!important;opacity:0!important;pointer-events:none!important;overflow:hidden!important}
html[data-braid-layout="1"].braid-people-open .right-sidebar,
html[data-braid-layout="1"].braid-people-open #right-sidebar{display:flex!important;width:var(--right-width,16.25rem)!important;min-width:12.5rem!important;max-width:22.5rem!important;opacity:1!important;pointer-events:auto!important;overflow:hidden!important;background:var(--bg-secondary)!important;border-left:1px solid var(--border)!important;flex:0 0 auto!important}
html[data-braid-layout="1"] .sidebar-collapse-btn,
html[data-braid-layout="1"] #sidebar-toggle-btn,
html[data-braid-layout="1"] .status-bar,
html[data-braid-layout="1"] #status-bar,
html[data-braid-layout="1"] .status-bar-toggle-tab,
html[data-braid-layout="1"] #status-bar-toggle,
html[data-braid-layout="1"] #soundboard-sidebar,
html[data-braid-layout="1"] .soundboard-sidebar{display:none!important;visibility:hidden!important;pointer-events:none!important}
html[data-braid-layout="1"].braid-sound-open #soundboard-sidebar,
html[data-braid-layout="1"].braid-sound-open .soundboard-sidebar{display:flex!important;visibility:visible!important;pointer-events:auto!important}
html[data-braid-layout="1"].braid-status-open .status-bar,
html[data-braid-layout="1"].braid-status-open #status-bar{display:flex!important;visibility:visible!important;pointer-events:auto!important}
html[data-braid-layout="1"] .sidebar-bottom-bar{display:flex!important;padding:.5rem .625rem!important;gap:.375rem!important}
html[data-braid-layout="1"] .sidebar-bottom-bar>*:not(.braid-more-wrap):not(.braid-bar-btn){display:none!important}
html[data-braid-layout="1"] .braid-bar-btn{flex:0 0 auto;width:2.5rem;height:2.5rem;display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--braid-btn-line)!important;border-radius:.75rem;background:var(--braid-btn-bg);color:var(--text-secondary);cursor:pointer;padding:0;transition:background .15s,color .15s,border-color .15s,transform .12s}
html[data-braid-layout="1"] .braid-bar-btn:hover{background:var(--braid-btn-bg-hover);color:var(--accent);border-color:color-mix(in srgb,var(--accent) 40%,var(--braid-btn-line))!important}
html[data-braid-layout="1"] .braid-bar-btn:active{transform:scale(.93)}
html[data-braid-layout="1"] .braid-more-wrap{position:relative;flex:1;display:flex}
html[data-braid-layout="1"] .braid-more-btn{flex:1;display:flex;align-items:center;gap:.625rem;height:2.5rem;padding:0 .875rem;border:1px solid var(--braid-btn-line)!important;border-radius:.75rem;background:var(--braid-btn-bg);color:var(--text-primary);cursor:pointer;font-size:calc(.8125rem*var(--braid-ui-scale,1));font-weight:600;letter-spacing:-.01em;transition:background .15s,color .15s,border-color .15s}
html[data-braid-layout="1"] .braid-more-btn:hover{background:var(--braid-btn-bg-hover);color:var(--text-primary);border-color:color-mix(in srgb,var(--accent) 40%,var(--braid-btn-line))!important}
html[data-braid-layout="1"] .braid-ham-label{pointer-events:none}
html[data-braid-layout="1"] .braid-ham{display:flex;flex-direction:column;justify-content:center;gap:.25rem;width:1.0625rem;height:1.0625rem}
html[data-braid-layout="1"] .braid-ham-line{display:block;height:2px;width:100%;border-radius:2px;background:currentColor;transition:transform .28s cubic-bezier(.16,1,.3,1),opacity .18s ease;transform-origin:center}
html[data-braid-layout="1"] .braid-more-wrap.open .braid-more-btn{color:var(--accent);background:color-mix(in srgb,var(--accent) 12%,transparent)}
html[data-braid-layout="1"] .braid-more-wrap.open .braid-ham-line:nth-child(1){transform:translateY(.375rem) rotate(45deg)}
html[data-braid-layout="1"] .braid-more-wrap.open .braid-ham-line:nth-child(2){opacity:0;transform:scaleX(.2)}
html[data-braid-layout="1"] .braid-more-wrap.open .braid-ham-line:nth-child(3){transform:translateY(-.375rem) rotate(-45deg)}
html[data-braid-layout="1"] .braid-more-menu{display:none;position:fixed;left:1rem;bottom:3.875rem;top:auto;right:auto;min-width:15rem;max-height:min(72vh,34rem);overflow:auto;z-index:90;background:var(--bg-card);border:1px solid var(--border);border-radius:.875rem;box-shadow:0 16px 48px -12px rgba(0,0,0,.28),var(--braid-shadow,0 1px 2px rgba(0,0,0,.2));padding:.375rem;transform-origin:bottom left}
html[data-braid-layout="1"] .braid-more-menu.open{display:block;animation:braid-menu-pop .22s cubic-bezier(.16,1,.3,1) both}
@keyframes braid-menu-pop{from{opacity:0;transform:scale(.92) translateY(.375rem)}to{opacity:1;transform:none}}
@keyframes braid-item-in{from{opacity:0;transform:translateY(.375rem)}to{opacity:1;transform:none}}
html[data-braid-layout="1"] .braid-more-menu.open>button,
html[data-braid-layout="1"] .braid-more-menu.open>.braid-menu-label{animation:braid-item-in .3s cubic-bezier(.16,1,.3,1) both;animation-delay:calc(var(--i,0)*18ms)}
html[data-braid-layout="1"] .braid-menu-label{font-size:.59375rem;font-weight:650;letter-spacing:.13em;text-transform:uppercase;color:var(--text-muted);padding:.5rem .625rem .25rem}
html[data-braid-layout="1"] .braid-more-menu button{display:flex;width:100%;align-items:center;gap:.625rem;border:0;background:transparent;padding:.5rem .625rem;border-radius:.625rem;font-size:calc(.8125rem*var(--braid-ui-scale,1));font-weight:550;color:var(--text-primary);cursor:pointer;text-align:left}
html[data-braid-layout="1"] .braid-more-menu button:hover{background:var(--bg-hover)}
html[data-braid-layout="1"] .braid-mi{display:flex;flex:0 0 auto;opacity:.7}
html[data-braid-layout="1"] .braid-more-menu button:hover .braid-mi{opacity:1;color:var(--accent)}
html[data-braid-layout="1"] .braid-more-menu .muted{color:var(--text-muted);font-size:.71875rem;font-weight:450;margin-left:auto}
@media (prefers-reduced-motion: reduce){
html[data-braid-layout="1"] .braid-more-menu.open,html[data-braid-layout="1"] .braid-more-menu.open>button,html[data-braid-layout="1"] .braid-more-menu.open>.braid-menu-label{animation:none!important}
html[data-braid-layout="1"] .braid-ham-line{transition:none!important}
}
html[data-braid-layout="1"] .welcome-content{text-align:center;max-width:36ch;padding:2rem 1.25rem;margin:auto}
html[data-braid-layout="1"] .welcome-content h2{font-size:1.625rem;font-weight:680;letter-spacing:-.035em;margin:0 0 .625rem}
html[data-braid-layout="1"] .welcome-content p{color:var(--text-muted);font-size:.9375rem;line-height:1.5}
@media (max-width:53.75rem){
html[data-braid-layout="1"] .messages{padding:.875rem .75rem!important;max-width:none}
html[data-braid-layout="1"] .server-bar{display:none!important}
html[data-braid-layout="1"].braid-people-open .right-sidebar{position:fixed;right:0;top:0;bottom:0;z-index:40;max-width:86vw!important}
}
`;


BraidLayout._FORM_CSS = `
html[data-braid-form="1"]{
--braid-r:.875rem;
--braid-bub:var(--bg-hover,var(--bg-card));
--braid-line:var(--border);
--braid-seam:color-mix(in srgb,var(--border) 55%,var(--braid-bub));
--braid-me:color-mix(in srgb,var(--accent) 8%,var(--bg-secondary));
--braid-me-line:color-mix(in srgb,var(--accent) 26%,var(--border));
--braid-gutter:3.625rem;
}
html[data-braid-form="1"] .message,
html[data-braid-form="1"] .message-compact{background:transparent!important;border:0!important;border-radius:0!important;box-shadow:none!important;margin:0!important}
html[data-braid-form="1"] .messages{gap:0!important}
html[data-braid-form="1"] .message{padding:0 1.125rem 0 .625rem!important}
html[data-braid-form="1"] .message-compact{padding:0 1.125rem 0 var(--braid-gutter)!important}
html[data-braid-form="1"] .message-row{padding:0!important;gap:.75rem!important;align-items:flex-start}
html[data-braid-form="1"] .message-avatar,
html[data-braid-form="1"] .message-avatar-img{width:2.25rem!important;height:2.25rem!important;min-width:2.25rem!important;box-sizing:border-box!important;border:0!important;margin:0!important}
html[data-braid-form="1"] .message:hover,
html[data-braid-form="1"] .message-compact:hover{background:transparent!important}
/* No internal horizontal borders inside a run — every body keeps only its
   side rails; the run's top and bottom edges are drawn by start/end alone.
   (The old base rule left border-bottom on every body, which stacked a
   solid line under the dotted seam and read as a full-width divider.) */
html[data-braid-form="1"] .message>.message-row>.message-body,
html[data-braid-form="1"] .message-compact>.message-body{position:relative;flex:1 1 auto;min-width:0;background:var(--braid-bub);border:1px solid var(--braid-line);border-top:0;border-bottom:0;border-radius:0;padding:.4375rem .9375rem}
html[data-braid-form="1"] .message[data-braid-run="start"]>.message-row>.message-body,
html[data-braid-form="1"] .message[data-braid-run="solo"]>.message-row>.message-body{border-top:1px solid var(--braid-line);border-top-left-radius:var(--braid-r);border-top-right-radius:var(--braid-r);padding-top:.6875rem;margin-top:.625rem}
html[data-braid-form="1"] .message[data-braid-run="end"]>.message-row>.message-body,
html[data-braid-form="1"] .message[data-braid-run="solo"]>.message-row>.message-body,
html[data-braid-form="1"] .message-compact[data-braid-run="end"]>.message-body{border-bottom:1px solid var(--braid-line);border-bottom-left-radius:var(--braid-r);border-bottom-right-radius:var(--braid-r);padding-bottom:.6875rem;margin-bottom:.625rem}
/* the only separator inside a run: a small centered dotted seam */
html[data-braid-form="1"] .message-compact>.message-body::before,
html[data-braid-form="1"] .message[data-braid-cont="1"]>.message-row>.message-body::before{content:'';position:absolute;left:50%;transform:translateX(-50%);width:min(7rem,45%);top:0;border-top:1px dotted color-mix(in srgb,var(--braid-seam) 75%,transparent);pointer-events:none}
/* a .message continuing another author-run: no repeated avatar/header —
   the gutter keeps its width, and the post's own time shows there on hover */
html[data-braid-form="1"] .message[data-braid-cont="1"]{position:relative}
html[data-braid-form="1"] .message[data-braid-cont="1"] .message-avatar,
html[data-braid-form="1"] .message[data-braid-cont="1"] .message-avatar-img{visibility:hidden}
html[data-braid-form="1"] .message[data-braid-cont="1"]>.message-row>.message-body>.message-header{display:none}
html[data-braid-form="1"] .message[data-braid-cont="1"]:hover::before{content:attr(data-time-short);position:absolute;left:.625rem;top:.5rem;width:2.25rem;text-align:center;font-size:.5625rem;line-height:1.2;color:var(--text-muted);pointer-events:none}
html[data-braid-form="1"] .message>.message-row>.message-body:hover,
html[data-braid-form="1"] .message-compact>.message-body:hover{background:color-mix(in srgb,var(--bg-active) 40%,var(--braid-bub))}
html[data-braid-form="1"] .message-user-sep{border-top:0!important;padding-top:0!important}
html[data-braid-form="1"] .message.system-message>.message-row>.message-body,
html[data-braid-form="1"] .message.announcement>.message-row>.message-body{background:transparent;border:0;border-radius:0}
html[data-braid-form="1"] .channel-item{position:relative;margin:0 .5rem!important;border:1px solid var(--braid-line)!important;border-top:0!important;border-radius:0!important;background:var(--braid-bub)}
html[data-braid-form="1"] .channel-item[data-braid-run="start"],
html[data-braid-form="1"] .channel-item[data-braid-run="solo"]{border-top:1px solid var(--braid-line)!important;border-top-left-radius:.75rem!important;border-top-right-radius:.75rem!important;margin-top:.25rem!important}
html[data-braid-form="1"] .channel-item[data-braid-run="end"],
html[data-braid-form="1"] .channel-item[data-braid-run="solo"]{border-bottom-left-radius:.75rem!important;border-bottom-right-radius:.75rem!important;margin-bottom:.25rem!important}
html[data-braid-form="1"] .channel-item[data-braid-run="mid"]::before,
html[data-braid-form="1"] .channel-item[data-braid-run="end"]::before{content:'';position:absolute;left:.75rem;right:.75rem;top:0;border-top:1px dashed var(--braid-seam);pointer-events:none}
html[data-braid-form="1"] .channel-item:hover{background:color-mix(in srgb,var(--bg-active) 45%,var(--braid-bub))}
html[data-braid-form="1"] .channel-item.active{background:color-mix(in srgb,var(--accent) 16%,var(--bg-secondary));border-color:var(--accent)!important}
html[data-braid-form="1"] .channel-item.active::before,
html[data-braid-form="1"] .channel-item.active + .channel-item::before{display:none!important}
html[data-braid-form="1"] .reaction,
html[data-braid-form="1"] .reaction-add,
html[data-braid-form="1"] .message-reactions>*{border-radius:999px!important}
html[data-braid-form="1"] .message-input-area textarea,
html[data-braid-form="1"] .message-input-container textarea{background:var(--bg-primary)!important}
`;

BraidLayout._SHAPE_CSS = `
html[data-braid-layout="1"]{--radius:.875rem;--radius-sm:.75rem}
html[data-braid-layout="1"] ::-webkit-scrollbar{width:.5rem;height:.5rem}
html[data-braid-layout="1"] ::-webkit-scrollbar-thumb{background:var(--border-light);border-radius:999px;border:2px solid transparent;background-clip:padding-box}
html[data-braid-layout="1"] :focus-visible{outline:2px solid color-mix(in srgb,var(--accent) 55%,transparent);outline-offset:2px;border-radius:.5rem}
html[data-braid-layout="1"] .icon-btn{border-radius:.625rem}
html[data-braid-layout="1"] .message{border-radius:.875rem!important}
html[data-braid-layout="1"] .message:hover{background:color-mix(in srgb,var(--bg-hover) 80%,transparent)!important;box-shadow:none!important}
html[data-braid-layout="1"] .message-row{gap:.875rem!important;padding:.5rem .75rem!important}
html[data-braid-layout="1"] .message-avatar,
html[data-braid-layout="1"] .message-avatar-img{width:2.375rem!important;height:2.375rem!important;border-radius:.75rem!important;border:0!important;box-shadow:none!important}
html[data-braid-layout="1"] .message-author,
html[data-braid-layout="1"] .message-username{font-weight:650;letter-spacing:-.01em}
html[data-braid-layout="1"] .message-text,
html[data-braid-layout="1"] .message-content{line-height:1.58!important;letter-spacing:-.01em}
html[data-braid-layout="1"] .btn-send,
html[data-braid-layout="1"] .thread-send-btn{border-radius:.875rem!important;box-shadow:none!important}
html[data-braid-layout="1"] .input-row input{border-radius:.625rem}
html[data-braid-layout="1"] .input-row input:focus{border-color:color-mix(in srgb,var(--accent) 45%,var(--border));box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 12%,transparent)}
html[data-braid-layout="1"] .btn-sm,
html[data-braid-layout="1"] .btn-secondary,
html[data-braid-layout="1"] .btn.secondary,
html[data-braid-layout="1"] .btn-primary,
html[data-braid-layout="1"] .btn-accent,
html[data-braid-layout="1"] .profile-dm-btn,
html[data-braid-layout="1"] .btn-admin-save{border-radius:.75rem!important;box-shadow:none!important}
html[data-braid-layout="1"] .modal,
html[data-braid-layout="1"] .modal-content,
html[data-braid-layout="1"] .settings-modal,
html[data-braid-layout="1"] .dialog,
html[data-braid-layout="1"] .settings-panel{border-radius:1.125rem!important;border:1px solid var(--border)!important}
html[data-braid-layout="1"] .settings-tab,
html[data-braid-layout="1"] .settings-nav-item,
html[data-braid-layout="1"] .sound-tab{border-radius:.625rem!important}
html[data-braid-layout="1"] .settings-tab.active,
html[data-braid-layout="1"] .settings-nav-item.active,
html[data-braid-layout="1"] .sound-tab.active{background:color-mix(in srgb,var(--accent) 16%,var(--bg-tertiary))!important;color:var(--accent)!important;border:1px solid color-mix(in srgb,var(--accent) 30%,transparent)!important}
html[data-braid-layout="1"] .context-menu,
html[data-braid-layout="1"] .dropdown-menu,
html[data-braid-layout="1"] .msg-toolbar{border-radius:.875rem!important;border:1px solid var(--border)!important}
html[data-braid-layout="1"] .profile-popup,
html[data-braid-layout="1"] .profile-card{border-radius:1rem!important;border:1px solid var(--border)!important}
html[data-braid-layout="1"] .theme-btn{border-radius:.75rem!important}
html[data-braid-layout="1"] .reaction,
html[data-braid-layout="1"] .reaction-chip,
html[data-braid-layout="1"] .reaction-badge{border-radius:999px!important}
html[data-braid-layout="1"] .toast,
html[data-braid-layout="1"] .notification-toast,
html[data-braid-layout="1"] .chip-toast{border-radius:999px!important;backdrop-filter:blur(10px)}
html[data-braid-layout="1"] .jump-to-bottom{border-radius:999px!important;border:1px solid var(--border-light)!important}
html[data-braid-layout="1"] .inline-code,
html[data-braid-layout="1"] code{border-radius:.375rem!important}
html[data-braid-layout="1"] .mention{border-radius:.375rem!important}
html[data-braid-layout="1"] .user-item,
html[data-braid-layout="1"] .member-item{margin:2px .625rem;padding:.625rem .75rem;border-radius:.75rem}
html[data-braid-layout="1"] .user-item:hover,
html[data-braid-layout="1"] .member-item:hover{background:var(--bg-hover)}
html[data-braid-layout="1"] .message-input-area textarea,
html[data-braid-layout="1"] .message-input-container textarea{border-radius:1.25rem!important;border:1px solid var(--border-light)!important;transition:border-color .15s,box-shadow .15s}
html[data-braid-layout="1"] .message-input-area textarea:focus,
html[data-braid-layout="1"] .message-input-container textarea:focus{border-color:color-mix(in srgb,var(--accent) 45%,var(--border))!important;box-shadow:0 0 0 4px color-mix(in srgb,var(--accent) 12%,transparent)!important}
html[data-braid-layout="1"] .music-panel-controls button,
html[data-braid-layout="1"] .music-btn{border-radius:.625rem!important}
html[data-braid-layout="1"] .sidebar-bottom-btn svg{display:block}

/* ── Modern settings ── the long scrolling column becomes cards, the
   nav becomes a pill rail, and the inline hairline separators between
   sections go away (the cards carry the separation). */
html[data-braid-layout="1"] .modal-settings{border-radius:1.25rem!important;overflow:hidden}
html[data-braid-layout="1"] .settings-header{padding:.875rem 1.25rem!important;border-bottom:1px solid var(--border)!important;background:color-mix(in srgb,var(--bg-secondary) 92%,transparent)!important;backdrop-filter:saturate(180%) blur(16px);-webkit-backdrop-filter:saturate(180%) blur(16px);gap:.75rem}
html[data-braid-layout="1"] .settings-header h3{font-size:1rem!important;font-weight:650!important;letter-spacing:-.02em!important}
html[data-braid-layout="1"] .settings-tab-bar{background:var(--bg-tertiary)!important;border:1px solid var(--border)!important;border-radius:.75rem!important;padding:3px!important;gap:2px!important}
html[data-braid-layout="1"] .settings-tab{border-radius:.5625rem!important;border:0!important;padding:.375rem .875rem!important;font-weight:550!important}
html[data-braid-layout="1"] .settings-close-btn{width:2.125rem;height:2.125rem;border-radius:.625rem!important;border:0!important;background:transparent!important;color:var(--text-muted)!important;font-size:1.125rem;display:grid;place-items:center}
html[data-braid-layout="1"] .settings-close-btn:hover{background:var(--bg-hover)!important;color:var(--text-primary)!important}
html[data-braid-layout="1"] .settings-nav{background:var(--bg-secondary)!important;border-right:1px solid var(--border)!important;padding:.625rem .5rem .625rem .625rem!important}
html[data-braid-layout="1"] .settings-nav-group-label{font-size:.625rem!important;font-weight:650!important;letter-spacing:.12em!important;text-transform:uppercase!important;color:var(--text-muted)!important;margin:.875rem .375rem .25rem!important}
/* Full-width pills. Stock uses a hanging-indent hack (padding-left
   1.625rem + negative text-indent) so wrapped lines clear the leading
   emoji — with a real icon element that hack would push the first line
   left OUT of the pill, which is why highlights never covered the row. */
html[data-braid-layout="1"] .settings-nav-item{display:flex!important;align-items:center;gap:.5rem;width:100%;box-sizing:border-box;border-radius:.625rem!important;padding:.4375rem .625rem!important;text-indent:0!important;margin:1px 0!important;font-size:calc(.8125rem*var(--braid-ui-scale,1))!important;font-weight:550!important;border:1px solid transparent!important}
html[data-braid-layout="1"] .settings-nav-item svg{flex:0 0 auto;opacity:.75}
html[data-braid-layout="1"] .settings-nav-item:hover{background:var(--bg-hover)!important}
html[data-braid-layout="1"] .settings-nav-item.active{background:color-mix(in srgb,var(--accent) 14%,var(--bg-tertiary))!important;color:var(--accent)!important;border:1px solid color-mix(in srgb,var(--accent) 28%,transparent)!important}
html[data-braid-layout="1"] .settings-nav-item.active svg{opacity:1}
html[data-braid-layout="1"] .settings-tab svg{margin-right:.375rem;vertical-align:-.1875rem}
html[data-braid-layout="1"] .settings-section{background:var(--bg-card)!important;border:1px solid var(--border)!important;border-top:1px solid var(--border)!important;border-radius:1rem!important;padding:1rem 1.125rem!important;margin:0 0 .75rem!important}
html[data-braid-layout="1"] .settings-section-subtitle{font-weight:650!important;letter-spacing:-.015em!important}
html[data-braid-layout="1"] .settings-section select,
html[data-braid-layout="1"] .settings-section input[type="text"],
html[data-braid-layout="1"] .settings-section input[type="password"],
html[data-braid-layout="1"] .settings-section input[type="number"]{border-radius:.625rem!important;border:1px solid var(--border)!important;background:var(--bg-input)!important;padding:.5rem .75rem!important}

/* ── Haven logo glow-up ── the brand hexagon breathes in the accent */
@keyframes braid-logo-breathe{
0%,100%{filter:drop-shadow(0 0 2px color-mix(in srgb,var(--accent) 45%,transparent)) drop-shadow(0 0 7px color-mix(in srgb,var(--accent) 22%,transparent))}
50%{filter:drop-shadow(0 0 4px color-mix(in srgb,var(--accent) 70%,transparent)) drop-shadow(0 0 14px color-mix(in srgb,var(--accent) 38%,transparent))}
}
html[data-braid-layout="1"] .brand .logo-sm,
html[data-braid-layout="1"] .sidebar-header .logo-sm{color:var(--accent)!important;animation:braid-logo-breathe 3.6s ease-in-out infinite;transition:transform .45s cubic-bezier(.16,1,.3,1);display:inline-block}
html[data-braid-layout="1"] .brand:hover .logo-sm{transform:rotate(120deg) scale(1.12)}
@media (prefers-reduced-motion: reduce){
html[data-braid-layout="1"] .brand .logo-sm,html[data-braid-layout="1"] .sidebar-header .logo-sm{animation:none!important;filter:drop-shadow(0 0 4px color-mix(in srgb,var(--accent) 40%,transparent))}
}

/* ── Hexagonal loading indicator ── a mint hex ring that spins while a
   solid core hexagon pulses inside it; also reskins the setup wizard's
   stock circular spinner. */
@keyframes braid-hex-spin{to{transform:rotate(360deg)}}
@keyframes braid-hex-pulse{0%,100%{transform:scale(.55);opacity:.5}50%{transform:scale(.8);opacity:1}}
html[data-braid-layout="1"] .braid-hex-loader{position:relative;width:2.75rem;height:2.75rem;display:inline-block}
html[data-braid-layout="1"] .braid-hex-loader::before{content:'';position:absolute;inset:0;background:conic-gradient(from 0deg,transparent 0 40%,var(--accent) 78%,transparent 78.5%);clip-path:polygon(50% 0,93.3% 25%,93.3% 75%,50% 100%,6.7% 75%,6.7% 25%,50% 0,50% 12%,17% 31%,17% 69%,50% 88%,83% 69%,83% 31%,50% 12%);animation:braid-hex-spin 1.1s linear infinite}
html[data-braid-layout="1"] .braid-hex-loader::after{content:'';position:absolute;inset:0;background:var(--accent);clip-path:polygon(50% 0,93.3% 25%,93.3% 75%,50% 100%,6.7% 75%,6.7% 25%);animation:braid-hex-pulse 1.4s ease-in-out infinite}
html[data-braid-layout="1"] #braid-hex-overlay{position:absolute;inset:0;z-index:30;display:grid;place-items:center;background:color-mix(in srgb,var(--bg-primary) 55%,transparent);backdrop-filter:blur(2px);-webkit-backdrop-filter:blur(2px);opacity:1;transition:opacity .2s ease}
html[data-braid-layout="1"] #braid-hex-overlay.braid-fade{opacity:0}
html[data-braid-layout="1"] .wizard-spinner{border:0!important;border-radius:0!important;width:2.75rem!important;height:2.75rem!important;background:conic-gradient(from 0deg,transparent 0 40%,var(--accent) 78%,transparent 78.5%);clip-path:polygon(50% 0,93.3% 25%,93.3% 75%,50% 100%,6.7% 75%,6.7% 25%,50% 0,50% 12%,17% 31%,17% 69%,50% 88%,83% 69%,83% 31%,50% 12%);animation:braid-hex-spin 1.1s linear infinite!important}
@media (prefers-reduced-motion: reduce){
html[data-braid-layout="1"] .braid-hex-loader::before,html[data-braid-layout="1"] .braid-hex-loader::after,html[data-braid-layout="1"] .wizard-spinner{animation:none!important}
}

/* ── Text size sliders ── two continuous scales layered over rem zoom:
   chat text and UI chrome text, both live-adjustable from Settings. */
html[data-braid-layout="1"] .message-text,
html[data-braid-layout="1"] .message-content{font-size:calc(.9375rem*var(--braid-chat-scale,1))!important}
html[data-braid-layout="1"] .message-header .message-author{font-size:calc(.875rem*var(--braid-chat-scale,1))!important}
html[data-braid-layout="1"] .channel-name{font-size:calc(.875rem*var(--braid-ui-scale,1))!important}
html[data-braid-layout="1"] .brand-text{font-size:calc(1rem*var(--braid-ui-scale,1))!important}
html[data-braid-layout="1"] #channel-header-name{font-size:calc(.90625rem*var(--braid-ui-scale,1))!important}
html[data-braid-layout="1"] .section-label{font-size:calc(.625rem*var(--braid-ui-scale,1))!important}
html[data-braid-layout="1"] .settings-nav-item{font-size:calc(.8125rem*var(--braid-ui-scale,1))!important}
html[data-braid-layout="1"] .current-user{font-size:calc(.8125rem*var(--braid-ui-scale,1))!important}
html[data-braid-layout="1"] .user-item,html[data-braid-layout="1"] .member-item{font-size:calc(.8125rem*var(--braid-ui-scale,1))}
`;

BraidLayout._MOTION_CSS = `
@keyframes braid-msg-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
@keyframes braid-pop{from{transform:scale(.82);opacity:0}to{transform:scale(1);opacity:1}}
@keyframes braid-fade{from{opacity:0}to{opacity:1}}
html[data-braid-layout="1"] .message,html[data-braid-layout="1"] .message-compact{animation:braid-msg-in .18s cubic-bezier(.16,1,.3,1) both}
html[data-braid-layout="1"] .messages{animation:braid-fade .22s ease-out both}
html[data-braid-layout="1"] .reaction,html[data-braid-layout="1"] .message-reactions>*{animation:braid-pop .16s cubic-bezier(.16,1,.3,1) both;transition:transform .12s ease,background .15s ease,border-color .15s ease}
html[data-braid-layout="1"] .reaction:hover,html[data-braid-layout="1"] .message-reactions>*:hover{transform:translateY(-1px)}
html[data-braid-layout="1"] .reaction:active,html[data-braid-layout="1"] .message-reactions>*:active{transform:scale(.94)}
html[data-braid-layout="1"] .channel-item{transition:background .15s ease,border-color .15s ease,transform .12s ease}
html[data-braid-layout="1"] .channel-item:active{transform:scale(.99)}
html[data-braid-layout="1"] .btn-send,html[data-braid-layout="1"] .icon-btn{transition:transform .12s ease,background .15s ease,color .15s ease}
html[data-braid-layout="1"] .btn-send:active,html[data-braid-layout="1"] .icon-btn:active{transform:scale(.92)}
html[data-braid-layout="1"] .message-input-area textarea,html[data-braid-layout="1"] .message-input-container textarea{transition:border-color .15s ease,box-shadow .15s ease,background .15s ease}
html[data-braid-layout="1"] .typing-indicator,html[data-braid-layout="1"] .typing-text{animation:braid-fade .2s ease-out both}
html[data-braid-layout="1"] .msg-toolbar,html[data-braid-layout="1"] .context-menu,html[data-braid-layout="1"] .dropdown-menu{animation:braid-pop .13s cubic-bezier(.16,1,.3,1) both;transform-origin:top right}
html[data-braid-layout="1"] .theme-popup,html[data-braid-layout="1"] .modal-content,html[data-braid-layout="1"] .settings-panel{animation:braid-msg-in .2s cubic-bezier(.16,1,.3,1) both}
@media (prefers-reduced-motion: reduce){
html[data-braid-layout="1"] .message,html[data-braid-layout="1"] .message-compact,html[data-braid-layout="1"] .messages,html[data-braid-layout="1"] .reaction,html[data-braid-layout="1"] .message-reactions>*,html[data-braid-layout="1"] .typing-indicator,html[data-braid-layout="1"] .typing-text,html[data-braid-layout="1"] .msg-toolbar,html[data-braid-layout="1"] .context-menu,html[data-braid-layout="1"] .dropdown-menu,html[data-braid-layout="1"] .theme-popup,html[data-braid-layout="1"] .modal-content,html[data-braid-layout="1"] .settings-panel{animation:none!important}
html[data-braid-layout="1"] .channel-item,html[data-braid-layout="1"] .btn-send,html[data-braid-layout="1"] .icon-btn,html[data-braid-layout="1"] .reaction{transition:none!important;transform:none!important}
}
`;

// Self-contained (no braid keyframes/vars assumed): this sheet is the one
// piece that stays loaded while the layout is disengaged, so the way back
// exists even with every Braid layer torn down.
BraidLayout._PILL_CSS = `
#braid-return-pill.braid-return-btn{color:var(--accent,#00ff9d)!important;border:1px solid color-mix(in srgb,var(--accent,#00ff9d) 35%,transparent)!important;border-radius:.625rem}
#braid-return-pill.braid-return-btn:hover{background:color-mix(in srgb,var(--accent,#00ff9d) 14%,transparent)!important}
#braid-return-pill.braid-return-btn svg{display:block;margin:auto}
#braid-return-pill.braid-return-float{position:fixed;left:.875rem;bottom:.875rem;z-index:120;display:inline-flex;align-items:center;justify-content:center;width:2.5rem;height:2.5rem;border-radius:999px;border:1px solid var(--border,#333a46);background:var(--bg-card,var(--bg-secondary,#12151c));color:var(--accent,#00ff9d);cursor:pointer;box-shadow:0 10px 28px -10px rgba(0,0,0,.45)}
html[data-braid-layout="1"] #braid-return-pill{display:none!important}
body.mod-mode-on #braid-return-pill{display:none!important}
#braid-mod-done{position:fixed;left:50%;bottom:5.75rem;transform:translateX(-50%);z-index:200;display:inline-flex;align-items:center;gap:.5rem;padding:.6875rem 1.25rem;border-radius:999px;border:1px solid color-mix(in srgb,var(--accent,#00ff9d) 55%,transparent);background:var(--accent,#00ff9d);color:var(--bg-primary,#0b0d12);font-family:inherit;font-size:.8125rem;font-weight:700;letter-spacing:-.01em;line-height:1;cursor:pointer;box-shadow:0 14px 36px -10px rgba(0,0,0,.5);transition:transform .12s,filter .15s}
#braid-mod-done:hover{filter:brightness(1.08)}
#braid-mod-done:active{transform:translateX(-50%) scale(.96)}
`;

// Register with the plugin loader's _win scope
if (typeof _win !== 'undefined') _win.BraidLayout = BraidLayout;
