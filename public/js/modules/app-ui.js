// Page setup: _setupUI wires every part of the page by calling each area's
// _bind method in turn. Also here: the header search and pinned-message
// buttons, the sidebar collapse, the encryption menu, keyboard shortcuts,
// games, member search, file uploads, resizable sidebars, and the donors list.

export default {

_setupUI() {
  // Each area of the page wires its own controls, in this order.
  this._bindComposer();
  this._bindChannelMenu();
  this._bindVoiceControls();
  this._bindSearchAndPins();
  this._bindMediaGallery();
  this._bindAppChrome();
  this._bindMessageClicks();
  this._bindThreadAndDmPanels();
  this._bindComposerPickers();
  this._bindMessageActions();
  this._bindComposerModals();
  this._bindPeople();
  this._bindAdminModeration();
  this._bindSettings();
  this._bindAdminControls();
  this._bindMemberSearch();
},

_bindSearchAndPins() {
  // Search — the panel/cache/pager live in app-search.js. Here we just wire
  // the header input to it. The panel persists across channel switches and
  // only closes on its own X (or this input's close button).
  this._searchInit();
  let searchTimeout = null;
  document.getElementById('search-toggle-btn').addEventListener('click', () => {
    this._searchToggle();
  });
  document.getElementById('search-close-btn').addEventListener('click', () => {
    this._searchClose();
  });
  document.getElementById('search-input').addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    const q = e.target.value.trim();
    // DMs match substrings locally (2 chars is fine); public search uses the
    // server tokenizer's minimum (trigram needs 3). (search-overhaul phase 2)
    const ch = (this.channels || []).find(c => c.code === this.currentChannel);
    const min = (ch && ch.is_dm) ? 2 : (this._searchMinChars || 2);
    if (q.length >= min && this.currentChannel) {
      searchTimeout = setTimeout(() => this._searchRun(q), 400);
    } else if (!q) {
      document.getElementById('search-panel').style.display = 'none';
    }
  });
  document.getElementById('search-input').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') this._searchClose();
    else if (e.key === 'Enter') {
      const q = e.target.value.trim();
      if (q) { this._searchSaveRecent(q); this._searchRun(q); }
    }
  });

  // Pinned messages panel
  document.getElementById('pinned-toggle-btn').addEventListener('click', () => {
    const panel = document.getElementById('pinned-panel');
    if (panel.style.display === 'block') {
      panel.style.display = 'none';
    } else if (this.currentChannel) {
      this.socket.emit('get-pinned-messages', { code: this.currentChannel });
    }
  });
  document.getElementById('pinned-close').addEventListener('click', () => {
    document.getElementById('pinned-panel').style.display = 'none';
  });

  // Open pinned messages in fullscreen (maximized PiP)
  const pinnedFullscreenBtn = document.getElementById('pinned-fullscreen-btn');
  if (pinnedFullscreenBtn) pinnedFullscreenBtn.addEventListener('click', () => {
    document.getElementById('pinned-panel').style.display = 'none';
    this._openPinsPiP?.(this._lastPins || []);
    const panel = document.getElementById('pins-pip-panel');
    if (panel) panel.classList.add('pins-pip-maximized');
  });

  // Pop pinned messages out to the floating PiP panel
  const pinnedPopupBtn = document.getElementById('pinned-popup-btn');
  if (pinnedPopupBtn) pinnedPopupBtn.addEventListener('click', () => {
    // Hide the sidebar panel first
    document.getElementById('pinned-panel').style.display = 'none';
    this._openPinsPiP?.(this._lastPins || []);
  });

  // Pins PiP: close button
  const pinsPipClose = document.getElementById('pins-pip-close');
  if (pinsPipClose) pinsPipClose.addEventListener('click', () => this._closePinsPiP?.());

  // Pins PiP: fullscreen toggle button
  const pinsPipFullscreen = document.getElementById('pins-pip-fullscreen');
  if (pinsPipFullscreen) pinsPipFullscreen.addEventListener('click', () => {
    const panel = document.getElementById('pins-pip-panel');
    if (panel) panel.classList.toggle('pins-pip-maximized');
  });

  // Pins PiP: pop-in button — close PiP and re-open the sidebar panel
  const pinsPipPopin = document.getElementById('pins-pip-popin');
  if (pinsPipPopin) pinsPipPopin.addEventListener('click', () => {
    this._closePinsPiP?.();
    if (this.currentChannel) this.socket.emit('get-pinned-messages', { code: this.currentChannel });
  });

  // Pins PiP: delegated click handler for the pin list
  // - Click on an item   → jump to message (PiP stays open)
  // - Click on unpin btn → confirm modal + socket emit
  const pinsPipList = document.getElementById('pins-pip-list');
  if (pinsPipList) {
    pinsPipList.addEventListener('click', async (e) => {
      // Unpin button — handled first; stops propagation so item click doesn't also fire
      const unpinBtn = e.target.closest('.pinned-unpin-btn');
      if (unpinBtn) {
        e.stopPropagation();
        const msgId = parseInt(unpinBtn.dataset.msgId, 10);
        if (!msgId) return;
        const ok = await this._showConfirmModal?.(t('confirm.unpin_message'), '');
        if (ok) this.socket.emit('unpin-message', { messageId: msgId });
        return;
      }
      // Click anywhere else on a pinned item → jump to that message in the channel
      const item = e.target.closest('.pinned-item');
      if (item) {
        const msgId = parseInt(item.dataset.msgId, 10);
        if (msgId) this._jumpToMessage?.(msgId);
      }
    });
  }
},

_bindAppChrome() {
  // Right sidebar collapse toggle (persisted to localStorage)
  const sidebarToggle = document.getElementById('sidebar-toggle-btn');
  const rightSidebar = document.getElementById('right-sidebar');

  function applySidebarCollapsed(collapsed) {
    rightSidebar.classList.toggle('collapsed', collapsed);
    sidebarToggle.classList.toggle('is-collapsed', collapsed);
    sidebarToggle.textContent = collapsed ? '\u276E' : '\u276F'; // ❮ or ❯
    window._updateSbToggleRight?.();
  }
  // Exposed so the search panel can temporarily un-collapse the sidebar it
  // overlays, then restore the user's preference on close. (search-overhaul)
  this._applySidebarCollapsed = applySidebarCollapsed;

  // Default is expanded; only collapse if explicitly saved as '1'
  applySidebarCollapsed(localStorage.getItem('haven-sidebar-collapsed') === '1');

  sidebarToggle.addEventListener('click', () => {
    const collapsed = !rightSidebar.classList.contains('collapsed');
    applySidebarCollapsed(collapsed);
    localStorage.setItem('haven-sidebar-collapsed', collapsed ? '1' : '0');
  });

  // E2E lock menu dropdown toggle
  document.getElementById('e2e-menu-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const dd = document.getElementById('e2e-dropdown');
    dd.style.display = dd.style.display === 'none' ? 'block' : 'none';
  });
  // Close dropdown on outside click
  document.addEventListener('click', () => {
    const dd = document.getElementById('e2e-dropdown');
    if (dd) dd.style.display = 'none';
  });
  document.getElementById('e2e-dropdown')?.addEventListener('click', (e) => e.stopPropagation());

  // E2E verification code button (inside dropdown)
  document.getElementById('e2e-verify-btn')?.addEventListener('click', () => {
    document.getElementById('e2e-dropdown').style.display = 'none';
    this._requireE2E(() => this._showE2EVerification());
  });

  // E2E recover-from-backup button — re-fetches the server-side encrypted
  // backup and unwraps it with the user's password. Works even when the
  // local key is in ghost-state or IndexedDB is stale. Does NOT generate
  // new keys, so existing encrypted messages remain readable once recovered.
  document.getElementById('e2e-recover-btn')?.addEventListener('click', () => {
    document.getElementById('e2e-dropdown').style.display = 'none';
    this._recoverE2EFromBackup();
  });

  // E2E reset encryption keys button (inside dropdown)
  // Reset does NOT go through _requireE2E — it must work even when E2E
  // can't initialize (e.g. server backup can't be decrypted after password change).
  document.getElementById('e2e-reset-btn')?.addEventListener('click', () => {
    document.getElementById('e2e-dropdown').style.display = 'none';
    this._showE2EResetConfirmation();
  });

  // E2E password prompt modal handlers
  document.getElementById('e2e-pw-submit-btn')?.addEventListener('click', () => this._submitE2EPassword());
  document.getElementById('e2e-pw-cancel-btn')?.addEventListener('click', () => this._closeE2EPasswordModal());
  document.getElementById('e2e-pw-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') this._submitE2EPassword();
  });
  document.getElementById('e2e-password-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'e2e-password-modal') this._closeE2EPasswordModal();
  });

  // Rate limit tracking for E2E password prompt
  this._e2ePwAttempts = [];
  this._e2ePwLocked = false;
  this._e2ePwPendingAction = null;

  // Global keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    // Type-to-focus: start typing anywhere and the message box takes over.
    // No preventDefault, so the browser inserts the keystroke into the newly
    // focused textarea — nothing is dropped.
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && !e.isComposing) {
      const ae = document.activeElement;
      const tag = ae?.tagName;
      const editing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || ae?.isContentEditable;
      // getClientRects().length is 0 for hidden elements, incl. fixed overlays
      const popupOpen = [...document.querySelectorAll(
        '.modal-overlay, #quick-switcher-overlay, #theme-popup, #search-container, .context-menu'
      )].some(el => el.getClientRects().length > 0);
      const msgInput = document.getElementById('message-input');
      const msgArea = document.getElementById('message-area');
      if (!editing && !popupOpen && this.currentChannel && msgInput && msgArea && msgArea.style.display !== 'none') {
        msgInput.focus();
      }
    }

    // Ctrl+F = search
    if ((e.ctrlKey || e.metaKey) && e.key === 'f' && this.currentChannel) {
      e.preventDefault();
      const sc = document.getElementById('search-container');
      sc.style.display = 'flex';
      document.getElementById('search-input').focus();
    }
    // Ctrl+K = quick channel switcher
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      this._openQuickSwitcher();
    }
    // Ctrl+E = toggle emoji picker (open/close)
    if ((e.ctrlKey || e.metaKey) && e.key === 'e' && this.currentChannel) {
      e.preventDefault();
      this._emojiPickerContext = 'main';
      this._toggleEmojiPicker();
    }
    // Alt+ArrowUp/Down = navigate channels
    if (e.altKey && !e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      this._navigateChannel(e.key === 'ArrowUp' ? -1 : 1);
    }
    // Alt+Shift+ArrowUp/Down = navigate to next/prev unread channel
    if (e.altKey && e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      this._navigateUnreadChannel(e.key === 'ArrowUp' ? -1 : 1);
    }
    // Escape = close modals, search, theme popup, quick switcher
    if (e.key === 'Escape') {
      document.getElementById('search-container').style.display = 'none';
      document.getElementById('search-panel').style.display = 'none';
      document.getElementById('theme-popup').style.display = 'none';
      document.getElementById('quick-switcher-overlay')?.remove();
      document.querySelectorAll('.modal-overlay').forEach(m => {
        const wasOpen = m.style.display && m.style.display !== 'none';
        m.style.display = 'none';
        // Same signal as the modal ✕, so a modal can drop unsaved state.
        if (wasOpen) m.dispatchEvent(new CustomEvent('modal-dismiss'));
      });
      // Close the emoji picker too. Reuse its toggle so the parent/anchor
      // restore runs, and only when it's open so Escape can't open it.
      const emojiPicker = document.getElementById('emoji-picker');
      if (emojiPicker && emojiPicker.style.display === 'flex') this._toggleEmojiPicker();
      // Close the GIF picker too, matching the emoji picker's Escape behavior.
      const gifPicker = document.getElementById('gif-picker');
      if (gifPicker && gifPicker.style.display === 'flex') gifPicker.style.display = 'none';
    }
  });

  // Escape (no modifiers) with nothing else to close → jump to the latest
  // message, same as the jump-to-bottom button. Runs in the CAPTURE phase so it
  // inspects overlays/dropdowns *before* the bubble-phase handlers above (and
  // the message-input dropdown handlers) close them. If any closeable UI is
  // open we bail and let those handlers run, so Escape never both dismisses a
  // popup and jumps. Gated on an active channel with the message view visible.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    if (!this.currentChannel) return;
    const msgArea = document.getElementById('message-area');
    if (!msgArea || msgArea.style.display === 'none') return;
    // An in-progress message edit owns Escape (it cancels the edit) and its
    // handler sits on the textarea in the bubble phase, so this capture-phase
    // listener would otherwise scroll away from — or, on a trimmed window,
    // re-render out of existence — the box being typed into. Editing an old
    // message is exactly the scrolled-up case, so check it first.
    if (document.querySelector('.edit-textarea')) return;
    // getClientRects().length is 0 for hidden/display:none nodes — same popup
    // detection the type-to-focus guard uses above.
    // The PiP DM, thread and pins panels each own Escape for their own input;
    // jumping the main channel behind them is never what was meant. Haven's
    // context menu is .channel-ctx-menu — there is no .context-menu element.
    const somethingOpen = [...document.querySelectorAll(
      '.modal-overlay, #quick-switcher-overlay, #theme-popup, #search-container, ' +
      '#search-panel, #image-lightbox, .image-lightbox, #emoji-picker, ' +
      '#gif-picker, .channel-ctx-menu, #emoji-dropdown, #slash-dropdown, ' +
      '#mention-dropdown, #channel-dropdown, #persona-dropdown, #ferry-dropdown, #gif-slash-picker, ' +
      '#dm-pip-panel, #thread-panel, #pins-pip-panel'
    )].some(el => el.getClientRects().length > 0);
    if (somethingOpen) return;
    this._jumpToLatest();
  }, true);

  // Theme popup toggle
  document.getElementById('theme-popup-toggle')?.addEventListener('click', () => {
    const popup = document.getElementById('theme-popup');
    popup.style.display = popup.style.display === 'none' ? 'block' : 'none';
  });
  document.getElementById('theme-popup-close')?.addEventListener('click', () => {
    document.getElementById('theme-popup').style.display = 'none';
  });

  // Logout
  document.getElementById('logout-btn').addEventListener('click', () => {
    if (this.voice && this.voice.inVoice) this.voice.leave();
    this._clearChannelCodeMap?.();
    localStorage.removeItem('haven_token');
    localStorage.removeItem('haven_user');
    localStorage.removeItem('haven_sync_key');
    window.location.href = '/';
  });

  // ── Games / Activities system ─────────────────────────────
  // Registry of available games — add new games here
  this._gamesRegistry = [
    { id: 'flappy', name: 'Shippy Container', icon: '🚢', path: '/games/flappy.html', description: t('activities_registry.flappy') },
    { id: 'flight', name: 'Flight', icon: '✈️', path: '/games/flash.html?swf=/games/roms/flight-759879f9.swf&title=Flight', description: t('activities_registry.flight'), type: 'flash' },
    { id: 'learn-to-fly-3', name: 'Learn to Fly 3', icon: '🐧', path: '/games/flash.html?swf=/games/roms/learn-to-fly-3.swf&title=Learn%20to%20Fly%203', description: t('activities_registry.learn_to_fly'), type: 'flash' },
    { id: 'bubble-tanks-3', name: 'Bubble Tanks 3', icon: '🫧', path: '/games/flash.html?swf=/games/roms/Bubble%20Tanks%203.swf&title=Bubble%20Tanks%203', description: t('activities_registry.bubble_tanks'), type: 'flash' },
    { id: 'tanks', name: 'Tanks', icon: '🪖', path: '/games/flash.html?swf=/games/roms/tanks.swf&title=Tanks', description: t('activities_registry.tanks'), type: 'flash' },
    { id: 'super-smash-flash-2', name: 'Super Smash Flash 2', icon: '⚔️', path: '/games/flash.html?swf=/games/roms/SuperSmash.swf&title=Super%20Smash%20Flash%202', description: t('activities_registry.super_smash'), type: 'flash' },
    { id: 'io-games', name: '.io Games', icon: '🌐', path: '/games/io-games.html', description: t('activities_registry.io_games'), type: 'browser' },
  ];

  // Generic postMessage bridge for any game (scores + leaderboard)
  if (!this._gameScoreListenerAdded) {
    window.addEventListener('message', (e) => {
      if (e.origin !== window.location.origin) return;
      // Handle score submissions: { type: '<gameId>-score', score: N } or { type: 'game-score', game: '<id>', score: N }
      if (e.data && typeof e.data.score === 'number') {
        let gameId = null;
        if (e.data.type === 'game-score' && e.data.game) {
          gameId = e.data.game;
        } else if (typeof e.data.type === 'string' && e.data.type.endsWith('-score')) {
          gameId = e.data.type.replace(/-score$/, '');
        }
        if (gameId && /^[a-z0-9_-]{1,32}$/.test(gameId)) {
          this.socket.emit('submit-high-score', { game: gameId, score: e.data.score });
        }
      }
      // Handle leaderboard requests from game iframes/windows
      if (e.data && e.data.type === 'get-leaderboard') {
        const gid = e.data.game || 'flappy';
        const scores = this.highScores?.[gid] || [];
        const target = e.source || (this._gameIframe?.contentWindow);
        try { target?.postMessage({ type: 'leaderboard-data', leaderboard: scores }, e.origin); } catch { /* game frame closed mid-reply */ }
      }
    });
    this._gameScoreListenerAdded = true;
  }

  // Activities button → open launcher modal
  document.getElementById('activities-btn')?.addEventListener('click', () => this._openActivitiesModal());

  // Close activities modal
  document.getElementById('close-activities-btn')?.addEventListener('click', () => this._closeActivitiesModal());
  document.getElementById('activities-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'activities-modal') this._closeActivitiesModal();
  });

  // Game iframe controls
  document.getElementById('game-iframe-close')?.addEventListener('click', () => this._closeGameIframe());
  document.getElementById('game-iframe-popout')?.addEventListener('click', () => this._popoutGame());

  // Game volume slider — forward volume changes into the game iframe
  const gameVolSlider = document.getElementById('game-volume-slider');
  const gameVolPct = document.getElementById('game-volume-pct');
  if (gameVolSlider) {
    gameVolSlider.addEventListener('input', () => {
      const val = parseInt(gameVolSlider.value);
      if (gameVolPct) gameVolPct.textContent = val + '%';
      // Post volume message into the game iframe
      try {
        const iframe = document.getElementById('game-iframe');
        if (iframe?.contentWindow) {
          iframe.contentWindow.postMessage({ type: 'set-volume', volume: val / 100 }, window.location.origin);
        }
      } catch { /* game frame closed or not loaded yet */ }
    });
  }
},

_bindMemberSearch() {
  // Member search in the right sidebar. Re-rendering the roster from the last
  // payload rather than asking the server keeps typing instant and costs the
  // server nothing.
  const userSearch = document.getElementById('user-search');
  const userSearchClear = document.getElementById('user-search-clear');
  const applyUserFilter = (value) => {
    this._userFilter = value;
    if (userSearchClear) userSearchClear.style.display = value ? '' : 'none';
    if (this._lastOnlineUsers) this._renderOnlineUsers(this._lastOnlineUsers);
  };
  userSearch?.addEventListener('input', (e) => applyUserFilter(e.target.value));
  userSearch?.addEventListener('keydown', (e) => {
    // Escape clears rather than just blurring, which is what the key does in
    // every other search box in the app.
    if (e.key === 'Escape' && userSearch.value) {
      e.stopPropagation();
      userSearch.value = '';
      applyUserFilter('');
    }
  });
  userSearchClear?.addEventListener('click', () => {
    if (userSearch) userSearch.value = '';
    applyUserFilter('');
    userSearch?.focus();
  });

  document.getElementById('open-invite-links-btn')?.addEventListener('click', () => {
    this._openInviteLinksModal();
  });
  document.getElementById('right-btn-invite-popout')?.addEventListener('click', () => {
    this._openInviteLinksModal();
  });
  document.getElementById('aml-view-invite-btn')?.addEventListener('click', () => {
    this._openInviteLinksModal();
  });
  document.getElementById('close-invite-links-btn')?.addEventListener('click', () => {
    const modal = document.getElementById('invite-links-modal');
    if (modal) modal.style.display = 'none';
  });
  document.getElementById('invite-links-modal')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) e.currentTarget.style.display = 'none';
  });
},

_copyTextFallback(text, onCopied) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    onCopied?.();
  } catch { /* could not copy */ }
},

// ═══════════════════════════════════════════════════════
// SERVER BAR — multi-server with live status
// ═══════════════════════════════════════════════════════

/** (#5381) Lock down the UI for guest accounts:
 *  hide the DM pane + split handle, hide settings affordances that
 *  rely on password (E2E, recovery, etc.), and badge their nickname. */
_applyGuestMode() {
  if (!this.user || !this.user.isGuest) return;
  const dmPane = document.getElementById('dm-pane');
  if (dmPane) dmPane.style.display = 'none';
  const dmPip = document.getElementById('dm-pip-panel');
  if (dmPip) dmPip.style.display = 'none';
  document.body.classList.add('is-guest');
},

// ═══════════════════════════════════════════════════════
// IMAGE UPLOAD — button, paste, drag & drop
// ═══════════════════════════════════════════════════════

_setupImageUpload() {
  const fileInput = document.getElementById('file-input');
  const uploadBtn = document.getElementById('upload-btn');
  const messageArea = document.getElementById('message-area');

  uploadBtn.addEventListener('click', () => {
    if (!this.currentChannel) return this._showToast(t('toasts.select_channel_first'), 'error');
    fileInput.click();
  });

  // The picker, the clipboard and a drop can all hand over several files at
  // once; every one of them queues, up to the admin's cap. (#5561)
  fileInput.addEventListener('change', () => {
    if (!fileInput.files.length) return;
    this._queueComposerFiles(fileInput.files);
    fileInput.value = '';
  });

  // Paste from clipboard — images (incl. SVG) get queued for preview; non-image
  // files now also queue (#5417) rather than uploading on paste.
  document.getElementById('message-input').addEventListener('paste', (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files = Array.from(items).filter(i => i.kind === 'file').map(i => i.getAsFile()).filter(Boolean);
    if (!files.length) return;
    e.preventDefault();
    this._queueComposerFiles(files);
  });

  // Drag & drop — QUEUE instead of uploading immediately
  messageArea.addEventListener('dragover', (e) => {
    e.preventDefault();
    messageArea.classList.add('drag-over');
  });

  messageArea.addEventListener('dragleave', () => {
    messageArea.classList.remove('drag-over');
  });

  messageArea.addEventListener('drop', (e) => {
    e.preventDefault();
    messageArea.classList.remove('drag-over');
    this._queueComposerFiles(e.dataTransfer?.files);
  });
},

// ═══════════════════════════════════════════════════════
// COLLAPSIBLE SIDEBAR SECTIONS (Join / Create)
// ═══════════════════════════════════════════════════════

_setupCollapsibleSections() {
  const sections = [
    { toggle: 'join-section-toggle', arrow: 'join-section-arrow', body: 'join-section-body', key: 'haven_join_collapsed' },
    { toggle: 'create-section-toggle', arrow: 'create-section-arrow', body: 'create-section-body', key: 'haven_create_collapsed' },
  ];
  sections.forEach(({ toggle, arrow, body, key }) => {
    const toggleEl = document.getElementById(toggle);
    const arrowEl = document.getElementById(arrow);
    const bodyEl = document.getElementById(body);
    if (!toggleEl || !bodyEl) return;

    // Restore saved state (default = expanded)
    const saved = localStorage.getItem(key);
    if (saved === '1') {
      arrowEl?.classList.add('collapsed');
      bodyEl.classList.add('collapsed');
    }

    toggleEl.addEventListener('click', () => {
      const isCollapsed = bodyEl.classList.toggle('collapsed');
      arrowEl?.classList.toggle('collapsed', isCollapsed);
      localStorage.setItem(key, isCollapsed ? '1' : '0');
    });
  });
},

// ── Upload with progress bar ───────────────────────────
// Every in-flight request is kept in _activeUploads so the bar's × can abort
// them. The general file queue fires its uploads without awaiting, so there
// can be several at once — hence a set, and hence hiding the bar only once
// the last one settles rather than whenever any single one does.
_uploadWithProgress(url, formData) {
  return new Promise((resolve, reject) => {
    const bar = document.getElementById('upload-progress-bar');
    const fill = document.getElementById('upload-progress-fill');
    const text = document.getElementById('upload-progress-text');
    if (bar) { bar.style.display = 'flex'; }
    if (fill) { fill.style.width = '0%'; }
    if (text) { text.textContent = t('common.uploading'); }

    if (!this._activeUploads) this._activeUploads = new Set();

    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('Authorization', `Bearer ${this.token}`);

    const settle = () => {
      this._activeUploads.delete(xhr);
      if (bar && this._activeUploads.size === 0) bar.style.display = 'none';
    };

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) {
        const pct = Math.round((e.loaded / e.total) * 100);
        if (fill) fill.style.width = pct + '%';
        if (text) text.textContent = `${pct}%`;
      }
    });

    xhr.addEventListener('load', () => {
      settle();
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(JSON.parse(xhr.responseText)); }
        catch { reject(new Error(t('toasts.invalid_json_response'))); }
      } else {
        let errMsg = t('toasts.upload_failed_status', { status: xhr.status });
        try { const d = JSON.parse(xhr.responseText); errMsg = d.error || errMsg; } catch { /* no JSON error body: keep the status message */ }
        reject(new Error(errMsg));
      }
    });

    xhr.addEventListener('error', () => {
      settle();
      reject(new Error(t('toasts.upload_connection_failed')));
    });

    xhr.addEventListener('abort', () => {
      settle();
      // Flagged so the callers can skip their own "upload failed" toast —
      // cancelling on purpose isn't an error, and the cancel already toasts.
      const err = new Error(t('toasts.upload_cancelled'));
      err.aborted = true;
      reject(err);
    });

    this._activeUploads.add(xhr);
    xhr.send(formData);
  });
},

// The × on the progress bar. Aborts everything currently in flight and tells
// the queue loops to stop, since cancelling one file out of a batch and then
// watching the rest go up anyway isn't what the button looks like it does.
_cancelUploads() {
  const active = this._activeUploads ? [...this._activeUploads] : [];
  if (active.length === 0) return;
  this._uploadsCancelled = true;
  active.forEach(xhr => { try { xhr.abort(); } catch { /* already settled */ } });
  this._showToast(t('toasts.upload_cancelled'), 'info');
},

// Intercept clicks on concealed media. Returns true when the click was
// consumed (so the caller skips opening the lightbox):
//  - a "hidden image" placeholder → reveal the image in place
//  - an unrevealed spoiler image → reveal it (next click opens the lightbox)
_maybeRevealConcealed(e) {
  const ph = e.target.closest && e.target.closest('.hidden-image');
  if (ph) { this._revealHiddenImage(ph); return true; }
  const sp = e.target.closest && e.target.closest('.spoiler-media');
  if (sp && !sp.classList.contains('revealed')) {
    sp.classList.add('revealed');
    return true;
  }
  // Spoilered link embed (the link was wrapped in ||spoiler||) → reveal the
  // card in place; blurred children have pointer-events disabled, so the
  // click lands on the card and this consumes it before the embed's own
  // controls or link fire.
  const lp = e.target.closest && e.target.closest('.link-preview.lp-spoiler');
  if (lp && !lp.classList.contains('revealed')) {
    lp.classList.add('revealed');
    return true;
  }
  return false;
},

async _uploadImage(file, targetCode, bundled = false, personaPrefix = '', spoiler = false, opts = {}) {
  if (!this.currentChannel && !targetCode) return;
  // The queue stores the per-image spoiler choice on the File object itself.
  if (!spoiler && file && file._spoiler) spoiler = true;
  // Capture the target channel NOW (before any await) so a mid-upload channel
  // switch doesn't send the image to the wrong channel.
  const targetChannel = targetCode || this.currentChannel;
  const _maxMb = this._uploadCapMb();
  if (file.size > _maxMb * 1024 * 1024) {
    return this._showToast(t('toasts.image_too_large', { max: _maxMb }), 'error');
  }

  // Detect E2E DM — encrypt file bytes before uploading
  // A DM picture that can't be encrypted goes up only if the sender agrees.
  const ch = this.channels.find(c => c.code === targetChannel);
  const isDm = ch && ch.is_dm && ch.dm_target;
  const gate = isDm ? await this._dmSendGate(targetChannel) : { partner: null };
  if (!gate) { this._uploadsCancelled = true; return; }
  const partner = gate.partner;

  if (partner) {
    // E2E path: encrypt file → upload as opaque blob → send encrypted text marker
    try {
      const arrayBuffer = await file.arrayBuffer();
      const encrypted = await this.e2e.encryptBytes(arrayBuffer, partner.userId, partner.publicKeyJwk);
      const blob = new Blob([encrypted], { type: 'application/octet-stream' });
      const formData = new FormData();
      formData.append('scope', 'dm');
      formData.append('file', blob, 'e2e-image.enc');
      const data = await this._uploadWithProgress('/api/upload-file', formData);
      const mime = file.type || 'image/png';
      const marker = `${spoiler ? 'spoiler-img:' : ''}e2e-img:${mime}:${data.url}`;
      const encryptedText = await this.e2e.encrypt(marker, partner.userId, partner.publicKeyJwk);
      this.socket.emit('send-message', {
        code: targetChannel,
        content: encryptedText,
        encrypted: true,
        // So deleting the message removes the file too (#5699).
        files: [data.url],
        ...(bundled && { bundled: true })
      });
      this.notifications.play('sent');
    } catch (err) {
      if (err?.aborted) return;
      console.error('[E2E] Image encryption failed:', err);
      const detail = err?.message ? ` — ${err.message}` : '';
      this._showToast(`${t('toasts.encrypted_image_failed')}${detail}`, 'error');
    }
    return;
  }

  try {
    // SVG must use /api/upload-file (the raster-only /api/upload rejects it)
    let data;
    const uploadScope = isDm ? 'dm' : 'channel';
    if (file.type === 'image/svg+xml') {
      const fd = new FormData();
      fd.append('scope', uploadScope);
      fd.append('file', file);
      data = await this._uploadWithProgress('/api/upload-file', fd);
    } else {
      const formData = new FormData();
      formData.append('scope', uploadScope);
      formData.append('image', file);
      data = await this._uploadWithProgress('/api/upload', formData);
    }

    // Send the image URL as a message to the channel that was active at upload time.
    // Prepend persona prefix if this image is bundled with a persona text message.
    const line = personaPrefix + (spoiler ? 'spoiler-img:' : '') + data.url;
    // A forum topic sent with text collects its picture lines and goes out as
    // one message instead (#5653).
    if (opts.returnContent) return line;
    this.socket.emit('send-message', {
      code: targetChannel,
      content: line,
      isImage: true,
      ...(bundled && { bundled: true }),
      ...(file && file._tags && file._tags.length ? { attachmentTags: file._tags } : {})
    });
    if (file && file._tags && file._tags.length) this._recordFrequentTags(file._tags);
    this.notifications.play('sent');
  } catch (err) {
    if (err?.aborted) return;
    this._showToast(err.message || t('toasts.upload_failed'), 'error');
  }
},

// ═══════════════════════════════════════════════════════
// ── General File Upload ───────────────────────────────
// ═══════════════════════════════════════════════════════

_setupFileUpload() {
  // Merged into upload-btn — no separate file button needed.
  // The unified upload button opens a file picker that accepts all types;
  // images are queued (with preview), other files upload immediately.
},

_handleFileUpload(input) {
  if (!input.files.length || !this.currentChannel) return;
  const file = input.files[0];
  this._uploadGeneralFile(file);
  input.value = '';
},

/** Upload any file via /api/upload-file — used by drag & drop, paste, and 📎 button */
_uploadGeneralFile(file, targetCode) {
  const code = targetCode || this.currentChannel;
  if (!code) return this._showToast(t('media.select_channel_first'), 'error');
  // Block media uploads if disabled in this channel
  const _ugCh = this.channels.find(c => c.code === code);
  if (_ugCh && _ugCh.media_enabled === 0) {
    return this._showToast(t('media.uploads_disabled'), 'error');
  }
  const maxMb = this._uploadCapMb();
  if (file.size > maxMb * 1024 * 1024) {
    this._showToast(t('media.file_too_large', { maxMb }), 'error');
    return;
  }

  // E2E DM path (#5310, #5308): if this channel is an E2E DM, encrypt the
  // file bytes before upload and send the metadata as an encrypted text
  // message. Without this, drag-drop / 📎 / paste / PiP-paste of any non-image
  // file (and any image pasted into the PiP) lands plaintext on the server
  // filesystem, defeating the DM's E2E guarantee.
  this._maybeUploadEncryptedDmFile(file, code, _ugCh).then(handled => {
    if (handled) return;

    const formData = new FormData();
    // Tells the server which column this lands in on the admin storage
    // report. It only ever splits this uploader's own total. (#5521)
    formData.append('scope', _ugCh && _ugCh.is_dm ? 'dm' : 'channel');
    formData.append('file', file);
    this._uploadWithProgress('/api/upload-file', formData)
    .then(data => {
      if (data.error) {
        this._showToast(data.error, 'error');
        return;
      }
      // Send as a message with file attachment format
      const sizeStr = this._formatFileSize(data.fileSize);
      let content;
      if (data.isImage) {
        content = data.url; // images render inline already
      } else {
        // Use a special file attachment format: [file:name](url|size)
        content = `[file:${data.originalName}](${data.url}|${sizeStr})`;
      }
      this.socket.emit('send-message', {
        code,
        content,
        replyTo: (code === this.currentChannel && this.replyingTo) ? this.replyingTo.id : null,
        ...(file && file._tags && file._tags.length ? { attachmentTags: file._tags } : {})
      });
      if (file && file._tags && file._tags.length) this._recordFrequentTags(file._tags);
      this.notifications.play('sent');
      if (code === this.currentChannel) this._clearReply();
    })
    .catch(err => {
      if (err?.aborted) return;
      this._showToast(err.message || t('settings.admin.upload_failed'), 'error');
    });
  });
},

/**
 * If `code` is an E2E DM and the partner key is available, encrypt `file`,
 * upload as an opaque blob, then send the metadata as an encrypted
 * `e2e-file:{json}` text message. Returns true if handled (sent, or the
 * sender backed out of sending it unencrypted), false when the caller should
 * upload it as it is. (#5310, #5308)
 */
async _maybeUploadEncryptedDmFile(file, code, ch) {
  if (!ch || !ch.is_dm || !ch.dm_target) return false;
  const gate = await this._dmSendGate(code);
  if (!gate) return true;
  const partner = gate.partner;
  if (!partner) return false;
  try {
    const arrayBuffer = await file.arrayBuffer();
    const encrypted = await this.e2e.encryptBytes(arrayBuffer, partner.userId, partner.publicKeyJwk);
    const blob = new Blob([encrypted], { type: 'application/octet-stream' });
    const formData = new FormData();
    formData.append('scope', 'dm');
    formData.append('file', blob, 'e2e-file.enc');
    const data = await this._uploadWithProgress('/api/upload-file', formData);
    if (!data || !data.url) {
      this._showToast(t('toasts.encrypted_image_failed'), 'error');
      return true;
    }
    const meta = JSON.stringify({
      mime: file.type || 'application/octet-stream',
      size: file.size,
      url: data.url,
      name: file.name || 'file'
    });
    // Images (including SVG) use e2e-img: so they render inline (#5309)
    const isImage = (file.type || '').startsWith('image/');
    const marker = isImage
      ? `e2e-img:${file.type || 'image/png'}:${data.url}`
      : `e2e-file:${meta}`;
    const encryptedText = await this.e2e.encrypt(marker, partner.userId, partner.publicKeyJwk);
    this.socket.emit('send-message', {
      code,
      content: encryptedText,
      encrypted: true,
      // The server cannot see this inside the encrypted text; naming it lets
      // deleting the message remove the file too (#5699).
      files: [data.url],
      replyTo: (code === this.currentChannel && this.replyingTo) ? this.replyingTo.id : null
    });
    this.notifications.play('sent');
    if (code === this.currentChannel) this._clearReply();
    return true;
  } catch (err) {
    if (err?.aborted) return true;
    console.error('[E2E] File encryption failed:', err);
    const _detail = err?.message ? ` — ${err.message}` : '';
    this._showToast(`${t('toasts.encrypted_image_failed')}${_detail}`, 'error');
    return true;
  }
},

_formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
},

// ═══════════════════════════════════════════════════════
// ── Resizable Sidebars ─────────────────────────────────

_setupResizableSidebars() {
  // Left sidebar resize (delta-based so it works with mod-mode panel repositioning)
  const sidebar = document.querySelector('.sidebar');
  const leftHandle = document.getElementById('sidebar-resize-handle');
  if (sidebar && leftHandle) {
    const savedLeft = localStorage.getItem('haven_sidebar_width');
    if (savedLeft) sidebar.style.width = savedLeft + 'px';

    let dragging = false, startX = 0, startW = 0;
    leftHandle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      dragging = true;
      startX = e.clientX;
      startW = sidebar.getBoundingClientRect().width;
      leftHandle.classList.add('dragging');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      // Flip direction when mod mode has moved this sidebar to the right
      const factor = sidebar.dataset.panelPos === 'right' ? -1 : 1;
      let w = startW + (e.clientX - startX) * factor;
      w = Math.max(200, Math.min(400, w));
      sidebar.style.width = w + 'px';
    });
    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      leftHandle.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      localStorage.setItem('haven_sidebar_width', parseInt(sidebar.style.width));
    });
  }

  // Right sidebar resize (delta-based)
  const rightSidebar = document.getElementById('right-sidebar');
  const rightHandle = document.getElementById('right-sidebar-resize-handle');
  if (rightSidebar && rightHandle) {
    const savedRight = localStorage.getItem('haven_right_sidebar_width');
    if (savedRight) rightSidebar.style.width = savedRight + 'px';

    let dragging = false, startX = 0, startW = 0;
    rightHandle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      dragging = true;
      startX = e.clientX;
      startW = rightSidebar.getBoundingClientRect().width;
      rightHandle.classList.add('dragging');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      // Default right-side: shrinks when moving right; flip if mod moved it left
      const factor = rightSidebar.dataset.panelPos === 'left' ? 1 : -1;
      let w = startW + (e.clientX - startX) * factor;
      w = Math.max(200, Math.min(400, w));
      rightSidebar.style.width = w + 'px';
      window._updateSbToggleRight?.(); // keep both collapse btns aligned during drag
    });
    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      rightHandle.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      localStorage.setItem('haven_right_sidebar_width', parseInt(rightSidebar.style.width));
      window._updateSbToggleRight?.();
    });
  }

  // Sidebar split handle (channels/DM divider)
  const splitHandle = document.getElementById('sidebar-split-handle');
  const splitContainer = document.getElementById('sidebar-split');
  const channelsPane = document.getElementById('channels-pane');
  const dmPane = document.getElementById('dm-pane');
  if (splitHandle && splitContainer && channelsPane && dmPane) {
    const savedRatio = localStorage.getItem('haven_sidebar_split_ratio');
    if (savedRatio) {
      channelsPane.style.flex = `${savedRatio} 1 0`;
      dmPane.style.flex = `${1 - parseFloat(savedRatio)} 1 0`;
    }

    let dragging = false;
    splitHandle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      dragging = true;
      splitHandle.classList.add('dragging');
      document.body.style.cursor = 'row-resize';
      document.body.style.userSelect = 'none';
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const rect = splitContainer.getBoundingClientRect();
      const y = e.clientY - rect.top;
      const total = rect.height;
      let ratio = y / total;
      ratio = Math.max(0.05, Math.min(0.95, ratio));
      channelsPane.style.flex = `${ratio} 1 0`;
      dmPane.style.flex = `${1 - ratio} 1 0`;
    });
    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      splitHandle.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      const chFlex = parseFloat(channelsPane.style.flex) || 0.6;
      localStorage.setItem('haven_sidebar_split_ratio', chFlex);
    });
  }
},

_initDonorsModal() {
  const modal = document.getElementById('donors-modal');
  if (!modal) return;

  let donorData = null;

  const renderDonorList = (sort) => {
    const sg = document.getElementById('sponsors-grid');
    const dg = document.getElementById('donors-grid');
    sg.innerHTML = '';
    dg.innerHTML = '';
    if (!donorData) return;
    const sponsors = sort === 'featured' && donorData.featuredSponsors ? donorData.featuredSponsors : (donorData.sponsors || []);
    const allDonors = sort === 'featured' && donorData.featuredDonors ? donorData.featuredDonors : (donorData.donors || []);
    const sponsorSet = new Set(sponsors.map(n => n.toLowerCase()));
    const donors = allDonors.filter(n => !sponsorSet.has(n.toLowerCase()));
    sponsors.forEach(n => { const s = document.createElement('span'); s.className = 'donor-chip donor-sponsor'; s.textContent = n; sg.appendChild(s); });
    donors.forEach(n => { const s = document.createElement('span'); s.className = 'donor-chip'; s.textContent = n; dg.appendChild(s); });
  };

  // Fetch donor/sponsor list from server
  fetch('/api/donors').then(r => r.json()).then(d => {
    donorData = d;
    // Show toggle if featured order is available
    if (d.featuredSponsors || d.featuredDonors) {
      const toggle = document.getElementById('donors-sort-toggle');
      if (toggle) toggle.style.display = '';
    }
    renderDonorList('chronological');
  }).catch((err) => { console.warn('[Donors] could not load the donor list', err); });

  // Sort toggle buttons
  document.getElementById('donors-sort-toggle')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.donors-sort-btn');
    if (!btn) return;
    document.querySelectorAll('.donors-sort-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    renderDonorList(btn.dataset.sort);
  });

  // Open on heart button click
  document.getElementById('donors-btn')?.addEventListener('click', () => {
    modal.style.display = 'flex';
  });

  // Close on X button
  document.getElementById('donors-close-btn')?.addEventListener('click', () => {
    modal.style.display = 'none';
  });

  // Close on overlay click
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.style.display = 'none';
  });
},

};
