// Phones and the mobile app: the slide-out panels, the mobile server list,
// the iOS keyboard fix, and the bridge to the mobile app shell.

export default {

// ═══════════════════════════════════════════════════════
// MOBILE: hamburger, overlay, swipe gestures
// ═══════════════════════════════════════════════════════

_setupMobile() {
  const menuBtn = document.getElementById('mobile-menu-btn');
  const usersBtn = document.getElementById('mobile-users-btn');
  const overlay = document.getElementById('mobile-overlay');
  const appBody = document.getElementById('app-body');

  // Hamburger: toggle left sidebar
  menuBtn.addEventListener('click', () => {
    const isOpen = appBody.classList.toggle('mobile-sidebar-open');
    appBody.classList.remove('mobile-right-open');
    if (isOpen) overlay.classList.add('active');
    else overlay.classList.remove('active');
  });

  // Users button: toggle right sidebar
  usersBtn.addEventListener('click', () => {
    const isOpen = appBody.classList.toggle('mobile-right-open');
    appBody.classList.remove('mobile-sidebar-open');
    if (isOpen) overlay.classList.add('active');
    else overlay.classList.remove('active');
  });

  // Overlay click: close everything
  overlay.addEventListener('click', () => this._closeMobilePanels());

  // Close buttons inside panels
  document.getElementById('mobile-sidebar-close')?.addEventListener('click', () => this._closeMobilePanels());
  document.getElementById('mobile-right-close')?.addEventListener('click', () => this._closeMobilePanels());

  // Close sidebar when switching channels on mobile
  const origSwitch = this.switchChannel.bind(this);
  this.switchChannel = (code) => {
    origSwitch(code);
    this._closeMobilePanels();
  };

  // Swipe gesture support (touch)
  let touchStartX = 0;
  let touchStartY = 0;
  const SWIPE_THRESHOLD = 60;

  document.addEventListener('touchstart', (e) => {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
  }, { passive: true });

  document.addEventListener('touchend', (e) => {
    const dx = e.changedTouches[0].clientX - touchStartX;
    const dy = e.changedTouches[0].clientY - touchStartY;
    // Only process horizontal swipes (not scrolling)
    if (Math.abs(dx) < SWIPE_THRESHOLD || Math.abs(dy) > Math.abs(dx)) return;

    if (dx > 0 && touchStartX < 40) {
      // Swipe right from left edge → open left sidebar
      appBody.classList.add('mobile-sidebar-open');
      appBody.classList.remove('mobile-right-open');
      overlay.classList.add('active');
    } else if (dx < 0 && touchStartX > window.innerWidth - 40) {
      // Swipe left from right edge → open right sidebar
      appBody.classList.add('mobile-right-open');
      appBody.classList.remove('mobile-sidebar-open');
      overlay.classList.add('active');
    } else if (dx < 0 && appBody.classList.contains('mobile-sidebar-open')) {
      this._closeMobilePanels();
    } else if (dx > 0 && appBody.classList.contains('mobile-right-open')) {
      this._closeMobilePanels();
    }
  }, { passive: true });

  // ── Mobile server dropdown ──
  const mobileServerBtn = document.getElementById('mobile-server-btn');
  const mobileServerMenu = document.getElementById('mobile-server-menu');
  if (mobileServerBtn && mobileServerMenu) {
    mobileServerBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._renderMobileServerList();
      mobileServerMenu.classList.toggle('open');
    });
    document.addEventListener('click', () => mobileServerMenu.classList.remove('open'));
    mobileServerMenu.addEventListener('click', (e) => e.stopPropagation());
    document.getElementById('mobile-server-add-btn')?.addEventListener('click', () => {
      mobileServerMenu.classList.remove('open');
      this._editingServerUrl = null;
      document.getElementById('add-server-modal-title').textContent = t('modals.add_server.title');
      document.getElementById('add-server-modal').style.display = 'flex';
      document.getElementById('add-server-name-input').value = '';
      document.getElementById('server-url-input').value = '';
      document.getElementById('server-url-input').disabled = false;
      document.getElementById('add-server-icon-input').value = '';
      document.getElementById('save-server-btn').textContent = t('modals.add_server.add_btn');
      document.getElementById('add-server-name-input').focus();
    });
  }

  // ── Mobile message actions: ⋯ button ──
  // Detect touch capability broadly: matchMedia OR ontouchstart presence.
  const isTouchDevice = window.matchMedia('(hover: none) and (pointer: coarse)').matches
                     || window.matchMedia('(pointer: coarse)').matches
                     || 'ontouchstart' in window
                     || navigator.maxTouchPoints > 0;
  if (isTouchDevice) {
    const messagesEl = document.getElementById('messages');
    let _suppressDismissUntil = 0;
    // Hide the old floating singleton "⋯" button; each message now has its own
    const oldMoreBtn = document.getElementById('msg-more-btn');
    if (oldMoreBtn) oldMoreBtn.style.display = 'none';

    const _deselectAll = () => {
      messagesEl.querySelectorAll('.msg-selected').forEach(el => {
        el.classList.remove('msg-selected');
        const toolbar = el.querySelector('.msg-toolbar');
        if (toolbar) toolbar.style.removeProperty('display');
      });
    };

    const _selectMsg = (msgEl) => {
      if (!msgEl) return;
      _deselectAll();
      msgEl.classList.add('msg-selected');
      // Touch interactions often emit a synthetic click right after selection.
      // Ignore dismiss logic briefly so the toolbar stays open.
      _suppressDismissUntil = Date.now() + 450;
      // Force immediate visual update on touch browsers where class-based
      // CSS can paint one interaction late.
      const toolbar = msgEl.querySelector('.msg-toolbar');
      if (toolbar) toolbar.style.setProperty('display', 'flex', 'important');
      if (navigator.vibrate) navigator.vibrate(15);
      requestAnimationFrame(() => {
        if (!msgEl.classList.contains('msg-selected')) return;
        const tb = msgEl.querySelector('.msg-toolbar');
        if (tb) tb.style.setProperty('display', 'flex', 'important');
      });
    };

    // Suppress the browser's native context menu so it doesn't
    // compete with our custom toolbar.
    messagesEl.addEventListener('contextmenu', (e) => {
      if (e.target.classList.contains('chat-image')) return;
      const msgEl = e.target.closest('.message, .message-compact');
      if (msgEl) e.preventDefault();
    });

    // ── Inline ⋯ button: always visible on each message ──
    // Tapping it toggles msg-selected which reveals the full toolbar.
    messagesEl.addEventListener('click', (e) => {
      const dotsBtn = e.target.closest('.msg-dots-btn');
      if (dotsBtn) {
        e.stopPropagation();
        e.preventDefault();
        const msgEl = dotsBtn.closest('.message, .message-compact');
        if (!msgEl) return;
        const wasSelected = msgEl.classList.contains('msg-selected');
        _deselectAll();
        if (!wasSelected) _selectMsg(msgEl);
        return;
      }
      // Any non-toolbar/non-dots tap should dismiss the current toolbar.
      // This keeps mobile behavior consistent: tap elsewhere = close actions.
      if (!e.target.closest('.msg-toolbar')) {
        if (Date.now() < _suppressDismissUntil) return;
        _deselectAll();
      }
      // Let toolbar button taps through
      if (e.target.closest('.msg-toolbar')) return;
      // Let interactive elements through
      if (e.target.closest('a') || e.target.closest('.reaction-badge') ||
          e.target.closest('.spoiler') || e.target.closest('.reply-banner')) return;
      // Don't interfere with author/avatar clicks (profile popup)
      if (e.target.closest('.message-author') || e.target.closest('.message-avatar') ||
          e.target.closest('.message-avatar-img')) return;
      // Let images through (lightbox etc)
      if (e.target.closest('img')) return;
    });

    // Dismiss on touch outside messages
    document.addEventListener('touchstart', (e) => {
      if (e.target.closest('.msg-toolbar') || e.target.closest('.msg-dots-btn')) return;
      if (!e.target.closest('#messages')) {
        _deselectAll();
      }
    }, { passive: true });

    // Deselect when focusing input area
    document.getElementById('message-input').addEventListener('focus', () => {
      _deselectAll();
    });

    // Deselect on significant scroll (debounced, threshold-based)
    let _scrollStart = null;
    messagesEl.addEventListener('scroll', () => {
      if (_scrollStart === null) _scrollStart = messagesEl.scrollTop;
      if (Math.abs(messagesEl.scrollTop - _scrollStart) > 30) {
        _deselectAll();
        _scrollStart = null;
      }
    }, { passive: true });
    messagesEl.addEventListener('touchstart', () => {
      _scrollStart = messagesEl.scrollTop;
    }, { passive: true });
  }
},

_closeMobilePanels() {
  const appBody = document.getElementById('app-body');
  const overlay = document.getElementById('mobile-overlay');
  appBody.classList.remove('mobile-sidebar-open', 'mobile-right-open');
  overlay.classList.remove('active');
},

_renderMobileServerList() {
  const list = document.getElementById('mobile-server-list');
  if (!list || !this.serverManager) return;
  const servers = this.serverManager.getAll();
  if (servers.length === 0) {
    list.innerHTML = `<div style="padding:8px 10px;color:var(--text-muted);font-size:0.75rem;">${t('servers.no_servers')}</div>`;
    return;
  }
  list.innerHTML = servers.map(s => {
    const initial = s.name.charAt(0).toUpperCase();
    const online = s.status.online;
    const dotClass = online === true ? 'online' : online === false ? 'offline' : 'unknown';
    const iconUrl = s.icon || (s.status.icon || null);
    const bustedIcon = iconUrl ? this._withCacheBust(iconUrl) : null;
    const iconHtml = bustedIcon
      ? `<img src="${this._escapeHtml(bustedIcon)}" class="msrv-icon" alt="" crossorigin="anonymous">`
      + `<span class="msrv-initial" style="display:none">${initial}</span>`
      : `<span class="msrv-initial">${initial}</span>`;
    return `<a class="mobile-server-item" href="${this._escapeHtml(s.url)}" target="_blank" rel="noopener">
      <span class="msrv-dot ${dotClass}"></span>
      ${iconHtml}
      <span>${this._escapeHtml(s.name)}</span>
    </a>`;
  }).join('');
  list.querySelectorAll('.msrv-icon').forEach(img => {
    img.addEventListener('error', () => {
      img.style.display = 'none';
      if (img.nextElementSibling) img.nextElementSibling.style.display = '';
    });
  });
},

// ═══════════════════════════════════════════════════════
// MOBILE SIDEBAR SERVER BUBBLES
// ═══════════════════════════════════════════════════════

_renderMobileSidebarServers() {
  const scroll = document.getElementById('mobile-servers-scroll');
  if (!scroll || !this.serverManager) return;
  // The same servers as the desktop rail: not this one, and a server
  // reachable at two addresses only once.
  const servers = this.serverManager.railServers(window.location.origin);
  if (servers.length === 0) {
    scroll.innerHTML = `<span class="mobile-servers-empty">${t('servers.no_servers')}</span>`;
    return;
  }
  scroll.innerHTML = servers.map(s => {
    const initial = s.name.charAt(0).toUpperCase();
    const online = s.status.online;
    const dotClass = online === true ? 'online' : online === false ? 'offline' : 'unknown';
    const iconUrl = s.icon || (s.status.icon || null);
    const bustedIcon = iconUrl ? this._withCacheBust(iconUrl) : null;
    const iconHtml = bustedIcon
      ? `<img src="${this._escapeHtml(bustedIcon)}" alt="${this._escapeHtml(initial)}" class="mobile-srv-icon-img" crossorigin="anonymous">`
      : `<span>${this._escapeHtml(initial)}</span>`;
    return `<a class="mobile-srv-bubble" href="${this._escapeHtml(s.url)}" target="_blank" rel="noopener" title="${this._escapeHtml(s.name)}">
      ${iconHtml}
      <span class="msrv-status ${dotClass}"></span>
    </a>`;
  }).join('');

  // CSP-safe: handle broken server icons, fall back to letter initial
  scroll.querySelectorAll('.mobile-srv-icon-img').forEach(img => {
    img.addEventListener('error', () => {
      const initial = img.alt || '?';
      const span = document.createElement('span');
      span.textContent = initial;
      img.replaceWith(span);
    });
  });
},

_setupMobileSidebarServers() {
  // Toggle collapse
  const toggle = document.getElementById('mobile-servers-toggle');
  const arrow = document.getElementById('mobile-servers-arrow');
  const row = document.getElementById('mobile-servers-row');
  if (toggle && row) {
    const collapsed = localStorage.getItem('haven_mobile_servers_collapsed') === '1';
    if (collapsed) {
      arrow?.classList.add('collapsed');
      row.classList.add('collapsed');
    }
    toggle.addEventListener('click', () => {
      const isCollapsed = row.classList.toggle('collapsed');
      arrow?.classList.toggle('collapsed', isCollapsed);
      localStorage.setItem('haven_mobile_servers_collapsed', isCollapsed ? '1' : '0');
    });
  }
  // Add-server button
  document.getElementById('mobile-srv-add-btn')?.addEventListener('click', () => {
    this._editingServerUrl = null;
    document.getElementById('add-server-modal-title').textContent = t('modals.add_server.title');
    document.getElementById('add-server-modal').style.display = 'flex';
    document.getElementById('add-server-name-input').value = '';
    document.getElementById('server-url-input').value = '';
    document.getElementById('server-url-input').disabled = false;
    document.getElementById('add-server-icon-input').value = '';
    document.getElementById('save-server-btn').textContent = t('modals.add_server.add_btn');
    document.getElementById('add-server-name-input').focus();
  });
  // Initial render
  this._renderMobileSidebarServers();
},

/* ── iOS Keyboard Layout Fix ────────────────────────── */
// iOS Safari (both standalone PWA and browser) doesn't always shrink the
// viewport reliably when the virtual keyboard opens.  We use the
// visualViewport API to detect the keyboard height and resize #app so
// the message input stays visible above the keyboard.

_setupIOSKeyboard() {
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  // ── Safe-area probing (all mobile, but especially iOS) ──
  // env(safe-area-inset-*) sometimes returns 0 even on notched devices
  // (e.g. certain iOS versions in browser vs PWA mode, or when CSS env()
  //  isn't evaluated). We probe the actual value via a hidden element and
  // set CSS custom properties with a minimum floor as fallback.
  if (isIOS || /Android/.test(navigator.userAgent)) {
    const isMobile = window.innerWidth <= 768;
    if (isMobile) {
      document.body.classList.add(isIOS ? 'is-ios' : 'is-android');

      // Detect standalone PWA mode
      if (isIOS && (window.navigator.standalone || window.matchMedia('(display-mode: standalone)').matches)) {
        document.body.classList.add('is-ios-pwa');
      }

      // Probe env(safe-area-inset-top) by measuring a hidden div
      const probe = document.createElement('div');
      probe.style.cssText = 'position:fixed;top:0;left:0;width:1px;pointer-events:none;visibility:hidden;'
        + 'height:env(safe-area-inset-top,0px);height:constant(safe-area-inset-top)';
      document.body.appendChild(probe);

      requestAnimationFrame(() => {
        const measuredTop = probe.offsetHeight;
        probe.style.cssText = 'position:fixed;bottom:0;left:0;width:1px;pointer-events:none;visibility:hidden;'
          + 'height:env(safe-area-inset-bottom,0px);height:constant(safe-area-inset-bottom)';

        requestAnimationFrame(() => {
          const measuredBottom = probe.offsetHeight;
          document.body.removeChild(probe);

          // Determine minimum safe-area for this device
          let minTop = 0, minBottom = 0;
          if (isIOS) {
            const h = window.screen.height;
            // iPhone X+ / Dynamic Island (screen height >= 812pt)
            if (h >= 812) { minTop = 47; minBottom = 34; }
            // Older iPhones
            else { minTop = 20; minBottom = 0; }
          }

          const safeTop = Math.max(measuredTop, minTop);
          const safeBottom = Math.max(measuredBottom, minBottom);
          const root = document.documentElement;
          root.style.setProperty('--safe-top', safeTop + 'px');
          root.style.setProperty('--safe-bottom', safeBottom + 'px');
        });
      });
    }
  }

  if (!window.visualViewport || !isIOS) return;

  const app = document.getElementById('app');
  const messages = document.getElementById('messages');

  const onViewportResize = () => {
    const kbHeight = window.innerHeight - window.visualViewport.height;
    // Only apply when keyboard is actually open (threshold avoids toolbar jitter)
    if (kbHeight > 50) {
      app.style.height = window.visualViewport.height + 'px';
      document.body.classList.add('ios-keyboard-open');
      // Scroll messages to bottom so user sees latest while typing
      if (messages) requestAnimationFrame(() => messages.scrollTop = messages.scrollHeight);
    } else {
      app.style.height = '';
      document.body.classList.remove('ios-keyboard-open');
    }
  };

  window.visualViewport.addEventListener('resize', onViewportResize);
  window.visualViewport.addEventListener('scroll', onViewportResize);
},

/* ── Mobile App Bridge (Capacitor shell ↔ Haven) ───── */

_setupMobileBridge() {
  // Only activate when running inside the mobile app's iframe
  this._isMobileApp = (window !== window.top);
  if (!this._isMobileApp) return;

  // Add a body class so CSS can adapt for mobile-app context
  document.body.classList.add('haven-mobile-app');

  // Listen for messages from the Capacitor shell
  window.addEventListener('message', (e) => {
    const data = e.data;
    if (!data || typeof data.type !== 'string') return;

    switch (data.type) {
      case 'haven:back':
        this._handleMobileBack();
        break;

      case 'haven:fcm-token':
        // Receive FCM token from native layer → send to server
        if (data.token && this.socket?.connected) {
          this.socket.emit('register-fcm-token', { token: data.token });
        }
        this._fcmToken = data.token;
        break;

      case 'haven:mobile-init':
        // Shell confirms we're in mobile app
        this._mobilePlatform = data.platform || 'unknown';
        break;

      case 'haven:push-received':
        // In-app push notification received while app is open
        if (data.notification) {
          const n = data.notification;
          const title = n.title || 'Haven';
          const body = n.body || '';
          this._showToast(`${title}: ${body}`, 'info');
        }
        break;

      case 'haven:push-action':
        // User tapped a push notification → switch to that channel
        if (data.data?.channelCode) {
          this.switchChannel(data.data.channelCode);
        }
        break;

      case 'haven:resume':
        // App returned to foreground: reconnect socket if needed
        if (this.socket && !this.socket.connected) {
          this.socket.connect();
        }
        break;

      case 'haven:keyboard':
        // Keyboard visibility changed
        if (data.visible) {
          document.body.classList.add('native-keyboard-open');
        } else {
          document.body.classList.remove('native-keyboard-open');
        }
        break;
    }
  });

  // Notify the shell that Haven is loaded and ready
  this._postToShell({ type: 'haven:ready' });

  // If user logs out, tell the shell
  const origLogout = this._logout?.bind(this);
  const logoutBtn = document.getElementById('logout-btn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', () => {
      this._postToShell({ type: 'haven:disconnect' });
    }, { capture: true });
  }

  // Send theme color to shell so status bar can match
  this._reportThemeColor();

  // Watch for theme changes and re-report
  const themeObs = new MutationObserver(() => {
    setTimeout(() => this._reportThemeColor(), 100);
  });
  themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
},

_postToShell(msg) {
  if (!this._isMobileApp) return;
  try { window.parent.postMessage(msg, '*'); } catch (err) { console.warn('[Shell] postMessage failed', err); }
},

_handleMobileBack() {
  // Priority order: close the most "on-top" UI element first

  // 1. Any open modal overlays
  const openModals = document.querySelectorAll('.modal-overlay');
  for (const m of openModals) {
    if (m.style.display && m.style.display !== 'none') {
      m.style.display = 'none';
      return;
    }
  }

  // 2. Search container / results
  const search = document.getElementById('search-container');
  if (search && search.style.display !== 'none' && search.style.display !== '') {
    search.style.display = 'none';
    document.getElementById('search-panel').style.display = 'none';
    return;
  }

  // 3. Theme popup
  const themePopup = document.getElementById('theme-popup');
  if (themePopup && themePopup.style.display !== 'none' && themePopup.style.display !== '') {
    themePopup.style.display = 'none';
    return;
  }

  // 4. Voice settings panel
  const voicePanel = document.getElementById('voice-settings-panel');
  if (voicePanel && voicePanel.classList.contains('open')) {
    voicePanel.classList.remove('open');
    return;
  }

  // 5. Mobile sidebars (left or right)
  const appBody = document.getElementById('app-body');
  if (appBody.classList.contains('mobile-sidebar-open') || appBody.classList.contains('mobile-right-open')) {
    this._closeMobilePanels();
    return;
  }

  // 6. GIF picker
  const gifPanel = document.getElementById('gif-panel');
  if (gifPanel && gifPanel.style.display !== 'none' && gifPanel.style.display !== '') {
    gifPanel.style.display = 'none';
    return;
  }

  // 7. Emoji picker
  const emojiPicker = document.querySelector('emoji-picker');
  if (emojiPicker && emojiPicker.style.display !== 'none' && emojiPicker.style.display !== '') {
    emojiPicker.style.display = 'none';
    return;
  }

  // Nothing to close: tell shell
  this._postToShell({ type: 'haven:back-exhausted' });
},

_reportThemeColor() {
  if (!this._isMobileApp) return;
  // Read the computed background of the top bar or body
  const topBar = document.querySelector('.top-bar') || document.querySelector('.sidebar');
  if (topBar) {
    const bg = getComputedStyle(topBar).backgroundColor;
    // Convert rgb(r,g,b) → hex
    const match = bg.match(/(\d+)/g);
    if (match && match.length >= 3) {
      const hex = '#' + match.slice(0, 3).map(n => parseInt(n).toString(16).padStart(2, '0')).join('');
      this._postToShell({ type: 'haven:theme-color', color: hex });
    }
  }
},

};
