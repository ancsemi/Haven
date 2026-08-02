/**
 * @name Braid Layout
 * @description Vastly simplified two-edge layout: folds the server rail into the sidebar, tucks header extras into a kebab menu, merges message runs into cards, and calms the chrome. Pairs with the Braid / Braid Light themes.
 * @author Amnibro
 * @version 1.1
 */
class BraidLayout {
  start() {
    this._hidden = new Map();          // el -> { display, hadHidden }
    this._lsPrev = new Map();          // localStorage key -> previous value (null = absent)
    this._listeners = [];              // [target, type, fn, opts]
    this._collapsedAdded = [];         // elements we added a class to
    HavenApi.DOM.addStyle('BraidLayoutCSS', BraidLayout._LAYOUT_CSS);
    HavenApi.DOM.addStyle('BraidShapeCSS', BraidLayout._SHAPE_CSS);
    HavenApi.DOM.addStyle('BraidFormCSS', BraidLayout._FORM_CSS);
    HavenApi.DOM.addStyle('BraidMotionCSS', BraidLayout._MOTION_CSS);
    document.documentElement.setAttribute('data-braid-layout', '1');
    document.documentElement.setAttribute('data-braid-form', '1');
    this._paintOwn();
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
    console.log('[BraidLayout] Started');
  }

  stop() {
    if (this._obs) { this._obs.disconnect(); this._obs = null; }
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
    console.log('[BraidLayout] Stopped');
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
    while (bar.firstChild) strip.appendChild(bar.firstChild);
    bar.dataset.braidFolded = '1';
    bar.setAttribute('aria-hidden', 'true');
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
    const header = document.querySelector('.channel-header');
    if (!header || header.querySelector('.braid-more-wrap')) return;
    const wrap = document.createElement('div');
    wrap.className = 'braid-more-wrap';
    wrap.innerHTML =
      '<button type="button" class="braid-more-btn" id="braid-more-btn" title="More" aria-label="More">' +
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">' +
      '<circle cx="12" cy="5" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="12" cy="19" r="1.2"/></svg></button>' +
      '<div class="braid-more-menu" id="braid-more-menu" role="menu"></div>';
    const voice = header.querySelector('.voice-controls');
    if (voice) header.insertBefore(wrap, voice);
    else header.appendChild(wrap);
    const menu = wrap.querySelector('#braid-more-menu');
    const btn = wrap.querySelector('#braid-more-btn');
    const addItem = (label, onClick, muted) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.innerHTML = muted ? `${label} <span class="muted">${muted}</span>` : label;
      b.addEventListener('click', () => { menu.classList.remove('open'); onClick(); });
      menu.appendChild(b);
    };
    const toggleHtmlClass = (cls) => document.documentElement.classList.toggle(cls);
    addItem('People & voice', () => this._setPeopleOpen(!document.documentElement.classList.contains('braid-people-open')), 'right panel');
    addItem('Soundboard', () => toggleHtmlClass('braid-sound-open'), 'toggle');
    addItem('Status bar', () => toggleHtmlClass('braid-status-open'), 'debug footer');
    [
      { id: 'search-toggle-btn', label: 'Search messages' },
      { id: 'pinned-toggle-btn', label: 'Pinned messages' },
      { id: 'gallery-toggle-btn', label: 'Files & media' },
      { id: 'copy-code-btn', label: 'Copy channel code' },
      { id: 'channel-code-settings-btn', label: 'Channel code settings' },
      { id: 'e2e-menu-btn', label: 'Encryption' },
    ].forEach((it) => {
      const src = document.getElementById(it.id);
      if (!src) return;
      addItem(it.label, () => src.click());
    });
    const desktopBanner = document.getElementById('desktop-app-banner');
    if (desktopBanner) addItem('Desktop app', () => (desktopBanner.querySelector('a') || desktopBanner).click(), 'download');
    const androidBanner = document.getElementById('android-beta-banner');
    if (androidBanner) addItem('Android app', () => androidBanner.click(), 'download');
    addItem('Settings', () => {
      document.getElementById('open-settings-btn')?.click();
      document.getElementById('mobile-settings-btn')?.click();
    });
    const peopleHdr = document.getElementById('mobile-users-btn');
    if (peopleHdr) {
      this._listen(peopleHdr, 'click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this._setPeopleOpen(!document.documentElement.classList.contains('braid-people-open'));
      }, true);
    }
    const sideMembers = document.getElementById('sidebar-members-btn');
    if (sideMembers) {
      if (sideMembers.style.display === 'none') sideMembers.style.display = '';
      this._listen(sideMembers, 'click', (e) => {
        e.preventDefault();
        this._setPeopleOpen(!document.documentElement.classList.contains('braid-people-open'));
      });
    }
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.classList.toggle('open');
    });
    this._listen(document, 'click', (e) => {
      if (!wrap.contains(e.target)) menu.classList.remove('open');
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
    this._foldServersIntoSidebar();
    this._hideEdgeChrome();
    this._quietChips();
    this._markRuns();
  }

  // Run position for the merged cards, desktop twin of Haven-Mobile's
  // braidForm(). This is deliberately NOT :has(+ .message-compact) —
  // Chromium re-runs :has() invalidation on every sibling insert, which
  // made a 600-message channel load go quadratic (622ms vs 80ms).
  // Attribute marking here is O(n) per observer batch.
  _markRuns() {
    const runOf = (first, last) => (first ? (last ? 'solo' : 'start') : (last ? 'end' : 'mid'));
    document.querySelectorAll('.messages > .message, .messages > .message-compact').forEach((el) => {
      const next = el.nextElementSibling;
      const v = runOf(el.classList.contains('message'), !next || !next.classList.contains('message-compact'));
      if (el.getAttribute('data-braid-run') !== v) el.setAttribute('data-braid-run', v);
    });
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
html[data-braid-layout="1"]{--sidebar-width:17.5rem;--braid-bar-h:3rem}
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
html[data-braid-layout="1"] .sidebar{width:var(--sidebar-width)!important;min-width:15rem!important;max-width:21.25rem!important;flex:0 0 var(--sidebar-width)!important;background:var(--bg-secondary)!important;border-right:1px solid var(--border)!important;display:flex!important;flex-direction:column!important;position:relative;z-index:5}
html[data-braid-layout="1"] .braid-server-strip{display:flex;align-items:center;gap:.375rem;padding:.625rem .625rem .5rem;overflow-x:auto;border-bottom:1px solid var(--border);flex-shrink:0;scrollbar-width:thin}
html[data-braid-layout="1"] .braid-server-strip .server-icon{width:2.25rem!important;height:2.25rem!important;min-width:2.25rem;border-radius:.6875rem!important;flex-shrink:0;position:relative}
html[data-braid-layout="1"] .braid-server-strip .server-separator{display:none}
html[data-braid-layout="1"] .sidebar-header{order:0;padding:.625rem .75rem!important;border-bottom:1px solid var(--border)!important;background:color-mix(in srgb,var(--bg-secondary) 92%,transparent)!important;backdrop-filter:saturate(180%) blur(14px);-webkit-backdrop-filter:saturate(180%) blur(14px)}
html[data-braid-layout="1"] .brand{margin-bottom:.5rem!important;gap:.5rem!important}
html[data-braid-layout="1"] .brand-text{font-size:.9375rem!important;font-weight:650!important;letter-spacing:-.03em!important;text-transform:none!important}
html[data-braid-layout="1"] .user-bar{border-radius:.75rem!important;padding:.5rem .625rem!important;gap:.5rem!important;background:var(--bg-tertiary)!important;border:1px solid var(--border)!important}
html[data-braid-layout="1"] .sidebar-mod-container{order:1;flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;padding:2px 0 .375rem}
html[data-braid-layout="1"] .sidebar-section[data-mod-id="join"],
html[data-braid-layout="1"] .sidebar-section#admin-controls{order:3;border:0!important;padding:2px .625rem!important;margin:0!important}
html[data-braid-layout="1"] .sidebar-section[data-mod-id="join"] .section-label,
html[data-braid-layout="1"] .sidebar-section#admin-controls .section-label{font-size:.71875rem!important;letter-spacing:0!important;text-transform:none!important;font-weight:550!important;color:var(--text-muted)!important;margin:2px 0!important;padding:.4375rem .5rem;border-radius:.625rem}
html[data-braid-layout="1"] .sidebar-section[data-mod-id="join"] .section-label:hover,
html[data-braid-layout="1"] .sidebar-section#admin-controls .section-label:hover{background:var(--bg-hover);color:var(--text-primary)}
html[data-braid-layout="1"] .sidebar-section[data-mod-id="join"].braid-collapsed .collapsible-section-body,
html[data-braid-layout="1"] .sidebar-section#admin-controls.braid-collapsed .collapsible-section-body,
html[data-braid-layout="1"] #join-section-body.collapsed,
html[data-braid-layout="1"] #create-section-body.collapsed{display:none!important}
html[data-braid-layout="1"] .sidebar-split{order:1;flex:1;min-height:0;display:flex;flex-direction:column;border:0!important}
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
html[data-braid-layout="1"] .braid-more-wrap{position:relative}
html[data-braid-layout="1"] .braid-more-btn{width:2.125rem;height:2.125rem;border:0;border-radius:.625rem;background:transparent;color:var(--text-muted);cursor:pointer;display:grid;place-items:center}
html[data-braid-layout="1"] .braid-more-btn:hover{background:var(--bg-hover);color:var(--text-primary)}
html[data-braid-layout="1"] .braid-more-menu{display:none;position:absolute;right:0;top:calc(100% + .375rem);min-width:13.75rem;z-index:50;background:var(--bg-card);border:1px solid var(--border);border-radius:.875rem;box-shadow:0 16px 48px -12px rgba(0,0,0,.22),var(--braid-shadow,0 1px 2px rgba(0,0,0,.2));padding:.375rem}
html[data-braid-layout="1"] .braid-more-menu.open{display:block}
html[data-braid-layout="1"] .braid-more-menu button{display:flex;width:100%;align-items:center;gap:.5rem;border:0;background:transparent;padding:.5625rem .625rem;border-radius:.625rem;font-size:.8125rem;font-weight:550;color:var(--text-primary);cursor:pointer;text-align:left}
html[data-braid-layout="1"] .braid-more-menu button:hover{background:var(--bg-hover)}
html[data-braid-layout="1"] .braid-more-menu .muted{color:var(--text-muted);font-size:.71875rem;font-weight:450;margin-left:auto}
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
--braid-me:color-mix(in srgb,var(--accent) 12%,var(--bg-secondary));
--braid-me-line:color-mix(in srgb,var(--accent) 35%,var(--border));
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
html[data-braid-form="1"] .message>.message-row>.message-body,
html[data-braid-form="1"] .message-compact>.message-body{position:relative;flex:1 1 auto;min-width:0;background:var(--braid-bub);border:1px solid var(--braid-line);border-top:0;border-radius:0;padding:.3125rem .8125rem}
html[data-braid-form="1"] .message[data-braid-run="start"]>.message-row>.message-body,
html[data-braid-form="1"] .message[data-braid-run="solo"]>.message-row>.message-body{border-top:1px solid var(--braid-line);border-top-left-radius:var(--braid-r);border-top-right-radius:var(--braid-r);padding-top:.5625rem;margin-top:.5rem}
html[data-braid-form="1"] .message[data-braid-run="end"]>.message-row>.message-body,
html[data-braid-form="1"] .message[data-braid-run="solo"]>.message-row>.message-body,
html[data-braid-form="1"] .message-compact[data-braid-run="end"]>.message-body{border-bottom-left-radius:var(--braid-r);border-bottom-right-radius:var(--braid-r);padding-bottom:.5625rem;margin-bottom:.5rem}
html[data-braid-form="1"] .message-compact>.message-body::before{content:'';position:absolute;left:.8125rem;right:.8125rem;top:0;border-top:1px dashed var(--braid-seam);pointer-events:none}
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

// Register with the plugin loader's _win scope
if (typeof _win !== 'undefined') _win.BraidLayout = BraidLayout;
