// Sounds: notification sounds and their settings, the soundboard (sidebar,
// pop-out and hotkeys), uploading sounds, and assigning sounds to events.

export default {

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// SOUND MANAGER (Full Popout — Admin + User)
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

_setupSoundManagement() {
  this.customSounds = [];
  this._soundHotkeys = JSON.parse(localStorage.getItem('haven_sound_hotkeys') || '{}'); // { hotkey: soundName }
  this._recordingHotkeyFor = null; // soundName currently recording hotkey
  this._soundCooldowns = {};       // hotkey

  this._soundPrefs = {}; // { soundName: { hidden, customOrder } }
  this._showHiddenSounds = false;
  this._soundboardSidebarMode = localStorage.getItem('haven_soundboard_sidebar_mode') === 'true';
  this._soundboardListMode = localStorage.getItem('haven_soundboard_list_mode') === 'true';
  this._loadUserSoundPrefs();

  // Open from admin "Manage Sounds" button
  const openBtn = document.getElementById('open-sound-manager-btn');
  if (openBtn) {
    openBtn.addEventListener('click', () => this._openSoundModal('manage'));
  }
  // Open from user "Sound Manager" button
  const openUserBtn = document.getElementById('open-sound-manager-user-btn');
  if (openUserBtn) {
    openUserBtn.addEventListener('click', () => this._openSoundModal('soundboard'));
  }

  // Close sound modal
  document.getElementById('close-sound-modal-btn')?.addEventListener('click', () => {
    document.getElementById('sound-modal').style.display = 'none';
  });
  document.getElementById('sound-modal')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) e.currentTarget.style.display = 'none';
  });

  // Close soundboard sidebar panel (no longer needed — toggle btn handles this)

  // Soundboard sidebar toggle button
  document.getElementById('sb-sidebar-toggle-btn')?.addEventListener('click', () => {
    this._toggleSoundboardSidebar();
  });

  // Soundboard sidebar resize handle
  {
    const sbPanel = document.getElementById('sb-sidebar-panel');
    const sbResizeHandle = document.getElementById('sb-sidebar-resize-handle');
    if (sbPanel && sbResizeHandle) {
      const savedWidth = localStorage.getItem('haven_sb_sidebar_width');
      if (savedWidth) sbPanel.style.width = savedWidth + 'px';

      let sbDragging = false, sbStartX = 0, sbStartW = 0;
      sbResizeHandle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        sbDragging = true;
        sbStartX = e.clientX;
        sbStartW = sbPanel.getBoundingClientRect().width;
        sbResizeHandle.classList.add('dragging');
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
      });
      document.addEventListener('mousemove', (e) => {
        if (!sbDragging) return;
        let w = sbStartW + (sbStartX - e.clientX);
        w = Math.max(160, Math.min(420, w));
        sbPanel.style.width = w + 'px';
        window._updateSbToggleRight?.(); // keep voice/users btn aligned during drag
      });
      document.addEventListener('mouseup', () => {
        if (!sbDragging) return;
        sbDragging = false;
        sbResizeHandle.classList.remove('dragging');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        localStorage.setItem('haven_sb_sidebar_width', parseInt(sbPanel.style.width));
        window._updateSbToggleRight?.();
      });
    }
  }

  // Tab switching
  document.querySelectorAll('.sound-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.sound-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.sound-tab-content').forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      const target = document.getElementById(`sound-tab-${tab.dataset.tab}`);
      if (target) target.classList.add('active');
    });
  });

  // Upload button (admin)
  const uploadBtn = document.getElementById('sound-upload-btn');
  const fileInput = document.getElementById('sound-file-input');
  const nameInput = document.getElementById('sound-name-input');
  if (uploadBtn && fileInput) {
    uploadBtn.addEventListener('click', async () => {
      const file = fileInput.files[0];
      const name = nameInput ? nameInput.value.trim() : '';
      if (!file) return this._showToast(t('media_runtime.sound.select_file'), 'error');
      if (!name) return this._showToast(t('media_runtime.sound.enter_name'), 'error');
      const maxSoundKb = parseInt(this.serverSettings?.max_sound_kb) || 1024;
      if (file.size > maxSoundKb * 1024) return this._showToast(t('media_runtime.sound.too_large', { max: maxSoundKb >= 1024 ? (maxSoundKb / 1024) + ' MB' : maxSoundKb + ' KB' }), 'error');

      const formData = new FormData();
      formData.append('sound', file);
      formData.append('name', name);

      try {
        this._showToast(t('media_runtime.sound.uploading'), 'info');
        const res = await fetch('/api/upload-sound', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${this.token}` },
          body: formData
        });
        if (!res.ok) {
          let errMsg = t('toasts.upload_failed_status', { status: res.status });
          try { const d = await res.json(); errMsg = d.error || errMsg; } catch { /* no JSON error body: keep the status message */ }
          return this._showToast(errMsg, 'error');
        }
        this._showToast(t('media_runtime.sound.uploaded', { name }), 'success');
        fileInput.value = '';
        nameInput.value = '';
        this._loadCustomSounds();
      } catch {
        this._showToast(t('toasts.upload_failed'), 'error');
      }
    });
  }

  
  // Show/hide hidden sounds toggle
  const showHiddenCheckbox = document.getElementById('soundboard-show-hidden');
  if (showHiddenCheckbox) {
    showHiddenCheckbox.addEventListener('change', (e) => {
      this._showHiddenSounds = e.target.checked;
      this._renderSoundboard(
        this._soundboardPip
          ? (document.getElementById('sb-pip-search')?.value?.trim() || '')
          : (document.getElementById('soundboard-search')?.value?.trim() || '')
      );
    });
  }

  // List view mode toggle (popup/pip grid layout — separate from sidebar mode)
  const listModeCheckbox = document.getElementById('soundboard-list-mode');
  if (listModeCheckbox) {
    listModeCheckbox.checked = this._soundboardListMode;
    listModeCheckbox.addEventListener('change', (e) => {
      this._soundboardListMode = e.target.checked;
      localStorage.setItem('haven_soundboard_list_mode', this._soundboardListMode ? 'true' : 'false');
      this._renderSoundboard(
        this._soundboardPip
          ? (document.getElementById('sb-pip-search')?.value?.trim() || '')
          : (document.getElementById('soundboard-search')?.value?.trim() || '')
      );
    });
  }

  // Sidebar layout toggle — closes the popup and opens the sidebar panel
  const _applySoundboardSidebarMode = (val) => {
    this._soundboardSidebarMode = val;
    localStorage.setItem('haven_soundboard_sidebar_mode', val ? 'true' : 'false');
    // Sync all sidebar mode checkboxes (popup + settings page)
    ['soundboard-sidebar-mode', 'soundboard-sidebar-mode-settings'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.checked = val;
    });
    const panel = document.getElementById('sb-sidebar-panel');
    const toggleBtn = document.getElementById('sb-sidebar-toggle-btn');
    if (val) {
      // Close modal/pip, open sidebar panel
      document.getElementById('sound-modal').style.display = 'none';
      if (panel) {
        panel.classList.remove('sb-hidden');
        this._renderSoundboardSidebar();
        const search = document.getElementById('sb-sidebar-search');
        if (search && !search._sbListenerAttached) {
          search._sbListenerAttached = true;
          search.addEventListener('input', () => this._renderSoundboardSidebar(search.value.trim()));
        }
      }
      if (toggleBtn) { toggleBtn.style.display = ''; this._setSbToggleArrow(toggleBtn, true); }
      window._updateSbToggleRight?.();
    } else {
      // Hide sidebar panel and toggle button
      if (panel) panel.classList.add('sb-hidden');
      if (toggleBtn) toggleBtn.style.display = 'none';
      window._updateSbToggleRight?.();
    }
  };
  // Bind sidebar mode checkboxes
  ['soundboard-sidebar-mode', 'soundboard-sidebar-mode-settings'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.checked = this._soundboardSidebarMode;
      el.addEventListener('change', (e) => _applySoundboardSidebarMode(e.target.checked));
    }
  });

  // Init: show toggle button when sidebar mode is enabled, but keep panel CLOSED until user clicks
  {
    const panel = document.getElementById('sb-sidebar-panel');
    const toggleBtn = document.getElementById('sb-sidebar-toggle-btn');
    // Always start with panel hidden — user must click to open it
    if (panel) panel.classList.add('sb-hidden');
    if (toggleBtn) {
      // Show the toggle arrow button if sidebar mode is on
      if (this._soundboardSidebarMode) {
        toggleBtn.style.display = '';
        this._setSbToggleArrow(toggleBtn, false);
      } else {
        toggleBtn.style.display = 'none';
      }
    }
    // Clear any stale hidden state
    localStorage.removeItem('haven_sb_sidebar_hidden');
    // Define the helper now (app-ui and app-admin will also call it).
    // Layout is: ... | main | sb-panel | right-sidebar (voice/users)
    // - Voice/users toggle btn sits at the LEFT edge of right-sidebar (right:width-of-voice when open, right:0 when collapsed).
    // - Soundboard toggle btn sits at the LEFT edge of sb-panel, which is also offset by voice width.
    // Both buttons are staggered vertically in CSS so they never visually collide when both end up at right:0.
    window._updateSbToggleRight = () => {
      const sbPanel    = document.getElementById('sb-sidebar-panel');
      const rightSb    = document.getElementById('right-sidebar');
      const voiceBtn   = document.getElementById('sidebar-toggle-btn');
      const sbBtn      = document.getElementById('sb-sidebar-toggle-btn');
      const sbOpen     = sbPanel && !sbPanel.classList.contains('sb-hidden');
      // Below 900px the voice/users panel stops being a column in the row and
      // becomes a fixed overlay driven by the Members button. It still reports
      // its full width, so counting it pushed this button a panel's width in
      // from the edge and left it sitting alone in the message area, open or
      // closed. Out of flow means it takes no horizontal space. (#5534)
      const voiceInFlow = rightSb && !['fixed', 'absolute'].includes(getComputedStyle(rightSb).position);
      const voiceOpen  = voiceInFlow && !rightSb.classList.contains('collapsed');

      // `useRendered=false` places the button off the panel's *requested*
      // width (style.width / default) so it slides smoothly while the panel's
      // width transition is still animating. `useRendered=true` re-reads the
      // *actual* laid-out width once the animation settles — this closes the
      // gap that appeared when a narrow window let flex-shrink squeeze the
      // panel below its requested width (min-width:200px floor), leaving the
      // toggle stranded to the left of the panel's real edge.
      const place = (useRendered) => {
        const sbWidth = sbOpen
          ? (useRendered ? (sbPanel.offsetWidth || parseInt(sbPanel.style.width) || 220)
                         : (parseInt(sbPanel.style.width) || sbPanel.offsetWidth || 220))
          : 0;
        const voiceWidth = voiceOpen
          ? (useRendered ? (rightSb.offsetWidth || parseInt(rightSb.style.width) || 240)
                         : (parseInt(rightSb.style.width) || rightSb.offsetWidth || 240))
          : 0;
        if (voiceBtn) voiceBtn.style.right = voiceWidth + 'px';
        if (sbBtn) {
          sbBtn.style.right = (voiceWidth + sbWidth) + 'px';
          // When the sb panel is OPEN, the toggle button sits at the panel's
          // left edge — a horizontal position the voice/users toggle never
          // occupies. Align it with the voice header (top: 72px) so it stops
          // visually crowding the first content row, which under the prior
          // 114px stagger looked like an overlap with the top of the sound
          // list. When the panel is CLOSED, both toggles can end up at
          // right:0, so restore the 114px stagger to keep them from stacking.
          sbBtn.style.top = sbOpen ? '72px' : '114px';
        }
      };

      place(false);                       // immediate: target width (smooth during anim)
      clearTimeout(window._sbToggleRealignTimer);
      window._sbToggleRealignTimer = setTimeout(() => place(true), 300); // settle: real width
    };
    window._updateSbToggleRight();

    // The button's position is an inline `right` written by the code above, so
    // it only stays correct while something calls it. It was called on the
    // toggles and on a resize-handle drag, but nothing else -- so any other
    // change to the panel's real width left the button behind, sitting away
    // from the panel edge with a gap. Resizing the window is the obvious one:
    // the panel is a flex item that shrinks before its requested width, and no
    // resize listener ever re-placed the button.
    //
    // Watching the panels themselves catches every cause rather than the two
    // that were wired up: window resize, flex-shrink, the interface zoom
    // changing rem sizes, and a stream or soundboard opening and reflowing the
    // row. The observer only reads the panels and writes to the buttons, so it
    // cannot retrigger itself.
    if (!window._sbToggleResizeObserver && typeof ResizeObserver === 'function') {
      window._sbToggleResizeObserver = new ResizeObserver(() => {
        window._updateSbToggleRight?.();
      });
      for (const id of ['right-sidebar', 'sb-sidebar-panel']) {
        const el = document.getElementById(id);
        if (el) window._sbToggleResizeObserver.observe(el);
      }
    }
  }


  // Soundboard search
  const searchInput = document.getElementById('soundboard-search');
  if (searchInput) {
    searchInput.addEventListener('input', () => this._renderSoundboard(searchInput.value.trim()));
  }

  // Soundboard popout button
  document.getElementById('soundboard-popout-btn')?.addEventListener('click', () => this._popOutSoundboard());

  // Global hotkey listener
  document.addEventListener('keydown', (e) => {
    // Ignore key-repeat events (holding a key down)
    if (e.repeat) return;

    // If recording a hotkey for a sound, wait for a non-modifier key
    if (this._recordingHotkeyFor) {
      // Let modifier-only presses pass so the user can build combos
      if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;
      e.preventDefault();
      const hk = this._buildHotkeyString(e);
      if (hk === 'Escape') {
        this._recordingHotkeyFor = null;
        this._renderSoundboard();
        return;
      }
      // Remove any old binding with same hotkey
      Object.keys(this._soundHotkeys).forEach(k => {
        if (this._soundHotkeys[k] === this._recordingHotkeyFor) delete this._soundHotkeys[k];
      });
      this._soundHotkeys[hk] = this._recordingHotkeyFor;
      localStorage.setItem('haven_sound_hotkeys', JSON.stringify(this._soundHotkeys));
      this._showToast(t('media_runtime.sound.hotkey_set', { hotkey: hk, name: this._recordingHotkeyFor }), 'success');
      this._recordingHotkeyFor = null;
      this._renderSoundboard();
      return;
    }
    // Check if a bound hotkey was pressed (only when not typing in inputs)
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    const hk = this._buildHotkeyString(e);
    const soundName = this._soundHotkeys[hk];
    if (soundName && this.customSounds) {
      // Cooldown: prevent rapid re-trigger (300ms minimum between plays)
      const now = Date.now();
      if (this._soundCooldowns[hk] && now - this._soundCooldowns[hk] < 300) return;
      this._soundCooldowns[hk] = now;
      const s = this.customSounds.find(cs => cs.name === soundName);
      if (s) {
        e.preventDefault();
        this._playSoundFile(s.url);
      }
    }
  });

  // Load custom sounds on init
  this._loadCustomSounds();
},

_buildHotkeyString(e) {
  const parts = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  const key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  if (!['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) parts.push(key);
  return parts.join('+');
},

_openSoundModal(tab = 'soundboard') {
  const modal = document.getElementById('sound-modal');
  if (!modal) return;
  // If the soundboard is already popped out AND the caller wants the soundboard
  // tab, bring the PiP into focus instead of reopening the modal. For 'assign'
  // and 'manage' tabs we still open the modal — the popout only holds the
  // soundboard view, so other tabs would otherwise be unreachable while
  // popped out (#5419, including the admin Custom Sounds button which goes
  // through this path with tab='manage').
  if (this._soundboardPip && tab === 'soundboard') {
    this._soundboardPip.style.zIndex = '10001';
    setTimeout(() => { if (this._soundboardPip) this._soundboardPip.style.zIndex = '10000'; }, 400);
    return;
  }
  // In sidebar mode, open the sidebar panel instead of the modal (for the soundboard tab)
  if (this._soundboardSidebarMode && tab === 'soundboard') {
    this._toggleSoundboardSidebar();
    return;
  }
  // Show admin tab only if user is admin or has manage_soundboard permission
  const adminTab = modal.querySelector('.sound-tab-admin');
  if (adminTab) adminTab.style.display = (this.user?.is_admin || this._hasPerm('manage_soundboard')) ? '' : 'none';
  // Activate requested tab
  modal.querySelectorAll('.sound-tab').forEach(t => t.classList.remove('active'));
  modal.querySelectorAll('.sound-tab-content').forEach(c => c.classList.remove('active'));
  const tabBtn = modal.querySelector(`.sound-tab[data-tab="${tab}"]`);
  const tabContent = document.getElementById(`sound-tab-${tab}`);
  if (tabBtn) tabBtn.classList.add('active');
  if (tabContent) tabContent.classList.add('active');
  modal.style.display = 'flex';
  // Sync popout button state
  const popoutBtn = document.getElementById('soundboard-popout-btn');
  if (popoutBtn) { popoutBtn.textContent = '\u29c9'; popoutBtn.title = t('media_runtime.sound.popout'); }
  this._renderSoundboard();
  this._renderAssignTab();
},

_closeSoundboardForVoiceLeave() {
  // Called from _leaveVoice. The soundboard is gated to voice-only use,
  // so when the user leaves voice we close any open soundboard surface:
  // sidebar panel, modal, or popped-out PiP.
  const panel = document.getElementById('sb-sidebar-panel');
  if (panel && !panel.classList.contains('sb-hidden')) {
    this._toggleSoundboardSidebar();
  }
  const modal = document.getElementById('sound-modal');
  if (modal && modal.style.display && modal.style.display !== 'none') {
    modal.style.display = 'none';
  }
  if (this._soundboardPip) {
    this._popInSoundboard(false);
  }
},

// Both dock handles sit on the right edge with their panel to the right, so
// the arrow shows which way that panel moves when clicked: an open panel will
// slide right and shut, a closed one will slide left and open. The members
// handle already read that way and the soundboard one was doing the opposite,
// which looked backwards sitting directly under it. (#5534)
_setSbToggleArrow(btn, open) {
  if (!btn) return;
  (btn.querySelector('.sb-toggle-arrow') || btn).textContent = open ? '\u276F' : '\u276E';
},

_toggleSoundboardSidebar() {
  const panel = document.getElementById('sb-sidebar-panel');
  const btn = document.getElementById('sb-sidebar-toggle-btn');
  if (!panel) return;
  const isNowHidden = !panel.classList.contains('sb-hidden');
  panel.classList.toggle('sb-hidden', isNowHidden);
  localStorage.setItem('haven_sb_sidebar_hidden', isNowHidden ? '1' : '0');
  this._setSbToggleArrow(btn, !isNowHidden);
  if (!isNowHidden) {
    this._renderSoundboardSidebar();
    const search = document.getElementById('sb-sidebar-search');
    if (search && !search._sbListenerAttached) {
      search._sbListenerAttached = true;
      search.addEventListener('input', () => this._renderSoundboardSidebar(search.value.trim()));
    }
  }
  window._updateSbToggleRight?.();
},

// Hotkey chip with its clear control, or the "Set hotkey" link. Shared by the
// Sound Manager grid/list, the pop-out and the sidebar list, so every layout
// can bind and unbind a key (the sidebar used to render a read-only chip).
_sbHotkeyControlsHtml(name, hk) {
  const n = this._escapeHtml(name);
  return hk
    ? `<span class="sb-hotkey-row">
         <span class="sb-hotkey">${this._escapeHtml(hk)}</span>
         <span class="sb-hotkey-clear" data-sound="${n}" title="${t('media_runtime.sound.remove_hotkey')}">&times;</span>
       </span>`
    : `<span class="sb-hotkey-set" data-sound="${n}">${t('media_runtime.sound.set_hotkey')}</span>`;
},

// Set / clear / right-click-to-record on every .soundboard-btn inside grid.
// rerender() redraws the layout that owns the grid after a clear.
_bindSbHotkeyControls(grid, hotkeyMap, rerender) {
  grid.querySelectorAll('.sb-hotkey-set').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const name = el.dataset.sound;
      this._recordingHotkeyFor = name;
      const btn = el.closest('.soundboard-btn');
      if (btn) btn.classList.add('hotkey-recording');
      this._showToast(t('media_runtime.sound.press_hotkey', { name }), 'info');
    });
  });
  grid.querySelectorAll('.sb-hotkey-clear').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const name = el.dataset.sound;
      const hk = hotkeyMap[name];
      if (!hk) return;
      delete this._soundHotkeys[hk];
      localStorage.setItem('haven_sound_hotkeys', JSON.stringify(this._soundHotkeys));
      this._showToast(t('media_runtime.sound.hotkey_removed', { name }), 'info');
      rerender();
    });
  });
  grid.querySelectorAll('.soundboard-btn').forEach(btn => {
    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (e.target.closest('.sb-hotkey-clear')) return;
      const name = btn.dataset.name;
      this._recordingHotkeyFor = name;
      btn.classList.add('hotkey-recording');
      this._showToast(t('media_runtime.sound.press_hotkey', { name }), 'info');
    });
  });
},

_renderSoundboardSidebar(filter = '') {
  const grid = document.getElementById('sb-sidebar-grid');
  if (!grid) return;
  const all = (this.customSounds || []).filter(s =>
    (!filter || s.name.toLowerCase().includes(filter.toLowerCase())) &&
    (!this._soundPrefs[s.name]?.hidden || this._showHiddenSounds)
  );
  const hotkeyMap = {};
  Object.entries(this._soundHotkeys).forEach(([hk, name]) => { hotkeyMap[name] = hk; });

  if (all.length === 0) {
    grid.innerHTML = `<p class="muted-text">${t(filter ? 'media_runtime.sound.no_matches' : 'modals.sound_manager.no_sounds')}</p>`;
    return;
  }

  // Split into custom (user-uploaded) and built-in groups. Custom always shows first.
  const customSounds  = all.filter(s => !s.builtin);
  const builtinSounds = all.filter(s =>  s.builtin);

  const renderBtn = (s) => {
    const hk = hotkeyMap[s.name];
    const hotkeyHtml = this._sbHotkeyControlsHtml(s.name, hk);
    return `<button class="soundboard-btn${this._soundPrefs[s.name]?.hidden ? ' hidden-sound' : ''}" data-name="${this._escapeHtml(s.name)}" data-url="${this._escapeHtml(s.url)}"><span class="sb-name">${this._escapeHtml(s.name)}</span>${hotkeyHtml}</button>`;
  };

  // Persisted open/closed state for each group (default: both open).
  const customOpen  = localStorage.getItem('haven_sb_sidebar_custom_open')  !== '0';
  const builtinOpen = localStorage.getItem('haven_sb_sidebar_builtin_open') !== '0';

  const renderGroup = (label, sounds, openKey, isOpen) => {
    if (sounds.length === 0) return '';
    return `
      <details class="sb-sidebar-group" data-open-key="${openKey}"${isOpen ? ' open' : ''}>
        <summary class="sb-sidebar-group-label">${label} <span class="sb-sidebar-group-count">${sounds.length}</span></summary>
        <div class="sb-sidebar-group-body">${sounds.map(renderBtn).join('')}</div>
      </details>
    `;
  };

  grid.innerHTML =
    renderGroup('Custom',  customSounds,  'haven_sb_sidebar_custom_open',  customOpen) +
    renderGroup('Built-in', builtinSounds, 'haven_sb_sidebar_builtin_open', builtinOpen);

  grid.querySelectorAll('.soundboard-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      if (e.target.closest('.sb-hotkey-clear') || e.target.closest('.sb-hotkey-set')) return;
      this._playSoundFile(btn.dataset.url);
    });
  });
  this._bindSbHotkeyControls(grid, hotkeyMap, () => this._renderSoundboardSidebar(filter));
  // Persist open/closed state of each category.
  grid.querySelectorAll('details.sb-sidebar-group').forEach(d => {
    d.addEventListener('toggle', () => {
      localStorage.setItem(d.dataset.openKey, d.open ? '1' : '0');
    });
  });
},

_popOutSoundboard() {
  if (this._soundboardPip) {
    this._popInSoundboard();
    return;
  }

  // Close the modal
  document.getElementById('sound-modal').style.display = 'none';

  const pip = document.createElement('div');
  pip.id = 'sb-pip-overlay';
  pip.className = 'sb-pip-overlay';
  pip.innerHTML = `
    <div class="music-pip-header" id="sb-pip-drag">
      <button class="music-pip-btn" id="sb-pip-popin" title="${t('media_runtime.sound.pop_back_in')}">\u29c8</button>
      <span class="music-pip-label">\uD83C\uDFB5 Soundboard</span>
      <button class="music-pip-btn" id="sb-pip-close" title="${t('modals.common.close')}">\u2715</button>
    </div>
    <div class="sb-pip-body">
      <div class="sound-search-row" style="padding:0;margin-bottom:0">
        <input type="text" id="sb-pip-search" placeholder="${t('modals.sound_manager.search_placeholder')}" class="settings-text-input" style="flex:1;font-size:0.75rem">
      </div>
      <div id="sb-pip-grid" class="soundboard-grid sb-pip-grid"></div>
    </div>
  `;
  document.body.appendChild(pip);
  this._soundboardPip = pip;

  this._renderSoundboard();

  document.getElementById('sb-pip-search').addEventListener('input', (e) => {
    this._renderSoundboard(e.target.value.trim());
  });
  document.getElementById('sb-pip-popin').addEventListener('click', () => this._popInSoundboard(true));
  document.getElementById('sb-pip-close').addEventListener('click', () => this._popInSoundboard(false));

  this._initPipDrag(pip, document.getElementById('sb-pip-drag'));
},

_popInSoundboard(reopen = false) {
  if (!this._soundboardPip) return;
  this._soundboardPip.remove();
  this._soundboardPip = null;
  if (reopen) this._openSoundModal('soundboard');
},

_playSoundFile(url) {
  try {
    const vol = Math.max(0, Math.min(1, this.notifications.volume * this.notifications.volume));
    // If in voice chat, route through VC so other users hear the sound too
    if (this.voice && this.voice.inVoice) {
      // Respect the per-channel soundboard toggle for the voice channel the
      // user is currently in. When an admin turns the soundboard off there,
      // sounds can't be played into that VC by anyone.
      const vcCode = this.voice.currentChannel;
      const vcCh = vcCode && Array.isArray(this.channels) ? this.channels.find(c => c.code === vcCode) : null;
      if (vcCh && vcCh.soundboard_enabled === 0) {
        return this._showToast(t('media.soundboard_disabled'), 'error');
      }
      if (this.voice.playSoundToVC(url, vol)) return;
    }
    // Fallback: play locally only
    const audio = new Audio(url);
    audio.volume = vol;
    audio.play().catch(() => { /* autoplay blocked until the next click; nothing to recover */ });
  } catch { /* audio not available */ }
},

async _loadCustomSounds() {
  try {
    const res = await fetch('/api/sounds', {
      headers: { 'Authorization': `Bearer ${this.token}` }
    });
    if (!res.ok) return;
    const data = await res.json();
    const sounds = data.sounds || [];
    this.customSounds = sounds; // [{name, url}]

    // Update all notification sound select dropdowns
    this._updateSoundSelects(sounds);

    // Render admin sound list
    this._renderSoundList(sounds);

    // Render soundboard if modal is visible or PiP is open
    if (document.getElementById('sound-modal')?.style.display === 'flex' || this._soundboardPip) {
      this._renderSoundboard();
      this._renderAssignTab();
    }
    // Re-render sidebar panel if it's visible
    const sbPanel = document.getElementById('sb-sidebar-panel');
    if (sbPanel && !sbPanel.classList.contains('sb-hidden')) {
      this._renderSoundboardSidebar(document.getElementById('sb-sidebar-search')?.value?.trim() || '');
    }
  } catch (err) { console.warn('[Sounds] could not load custom sounds', err); }
},

async _loadUserSoundPrefs() {
  try {
    const res = await fetch('/api/user-sound-prefs', {
      headers: { 'Authorization': `Bearer ${this.token}` }
    });
    if (!res.ok) return;
    const data = await res.json();
    this._soundPrefs = data.prefs || {};
  } catch { /* non-critical – run with empty prefs if endpoint unavailable */ }
},

async _saveUserSoundPrefs() {
  try {
    await fetch('/api/user-sound-prefs', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ prefs: this._soundPrefs })
    });
  } catch (err) { console.warn('[Sounds] could not save sound preferences', err); }
},

_updateSoundSelects(sounds) {
  // Update ALL 5 notification selects with custom sounds
  const selects = ['notif-msg-sound', 'notif-sent-sound', 'notif-mention-sound', 'notif-join-sound', 'notif-leave-sound'];
  selects.forEach(id => {
    const sel = document.getElementById(id);
    if (!sel) return;

    // Remember current value
    const currentVal = sel.value;

    // Remove old custom options
    sel.querySelectorAll('option[data-custom]').forEach(o => o.remove());
    sel.querySelectorAll('optgroup[data-custom-group]').forEach(o => o.remove());

    const noneOpt = sel.querySelector('option[value="none"]');

    // Add custom sounds optgroup
    const builtins = sounds.filter(s => s.builtin);
    const customs  = sounds.filter(s => !s.builtin);

    if (builtins.length > 0) {
      const builtinGroup = document.createElement('optgroup');
      builtinGroup.label = `🎙️ ${t('modals.sound_manager.group_builtin')}`;
      builtinGroup.dataset.customGroup = '1';
      builtins.forEach(s => {
        const opt = document.createElement('option');
        opt.value = `custom:${s.name}`;
        opt.textContent = s.name;
        opt.dataset.custom = '1';
        opt.dataset.url = s.url;
        builtinGroup.appendChild(opt);
      });
      sel.insertBefore(builtinGroup, noneOpt);
    }

    if (customs.length > 0) {
      const customGroup = document.createElement('optgroup');
      customGroup.label = `🎵 ${t('modals.sound_manager.group_custom')}`;
      customGroup.dataset.customGroup = '1';
      customs.forEach(s => {
        const opt = document.createElement('option');
        opt.value = `custom:${s.name}`;
        opt.textContent = s.name;
        opt.dataset.custom = '1';
        opt.dataset.url = s.url;
        customGroup.appendChild(opt);
      });
      sel.insertBefore(customGroup, noneOpt);
    }

    // Restore value
    sel.value = currentVal;
  });
},

_renderSoundList(sounds) {
  const list = document.getElementById('custom-sounds-list');
  if (!list) return;

  const builtins = sounds.filter(s => s.builtin);
  const custom   = sounds.filter(s => !s.builtin);

  if (builtins.length === 0 && custom.length === 0) {
    list.innerHTML = `<p class="muted-text">${t('modals.sound_manager.no_custom_sounds')}</p>`;
    return;
  }

  const builtinHtml = builtins.length === 0 ? '' : `
    <details class="sound-section">
      <summary class="sound-section-label">${t('modals.sound_manager.group_builtin')}</summary>
      ${builtins.map(s => `
        <div class="custom-sound-item" data-name="${this._escapeHtml(s.name)}">
          <span class="custom-sound-name">${this._escapeHtml(s.name)}</span>
          <button class="btn-xs sound-preview-btn" data-url="${this._escapeHtml(s.url)}" title="${t('modals.sound_manager.preview_btn')}">&#x25B6;</button>
          <button class="btn-xs sound-delete-btn" data-name="${this._escapeHtml(s.name)}" title="${t('modals.sound_manager.delete_btn')}">&#x1F5D1;</button>
        </div>
      `).join('')}
    </details>
  `;

  const customHtml = custom.length === 0 ? '' : `
    <details class="sound-section" open>
      <summary class="sound-section-label">${t('modals.sound_manager.group_custom')}</summary>
      ${custom.map(s => `
        <div class="custom-sound-item" data-name="${this._escapeHtml(s.name)}">
          <span class="custom-sound-name">${this._escapeHtml(s.name)}</span>
          <button class="btn-xs sound-preview-btn" data-url="${this._escapeHtml(s.url)}" title="${t('modals.sound_manager.preview_btn')}">&#x25B6;</button>
          <button class="btn-xs sound-rename-btn" data-name="${this._escapeHtml(s.name)}" title="${t('modals.sound_manager.rename_btn')}">&#x270F;</button>
          <button class="btn-xs sound-delete-btn" data-name="${this._escapeHtml(s.name)}" title="${t('modals.sound_manager.delete_btn')}">&#x1F5D1;</button>
        </div>
      `).join('')}
    </details>
  `;

  // Custom first, then built-in
  list.innerHTML = customHtml + builtinHtml;


  // Preview buttons
  list.querySelectorAll('.sound-preview-btn').forEach(btn => {
    btn.addEventListener('click', () => this._playSoundFile(btn.dataset.url));
  });

  // Rename buttons
  list.querySelectorAll('.sound-rename-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const item = btn.closest('.custom-sound-item');
      const nameSpan = item.querySelector('.custom-sound-name');
      const oldName = btn.dataset.name;
      // Replace span with input
      const input = document.createElement('input');
      input.type = 'text';
      input.value = oldName;
      input.maxLength = 30;
      input.className = 'custom-sound-name-input';
      nameSpan.replaceWith(input);
      input.focus();
      input.select();

      const doRename = async () => {
        const newName = input.value.trim();
        if (!newName || newName === oldName) {
          // Revert
          const span = document.createElement('span');
          span.className = 'custom-sound-name';
          span.textContent = oldName;
          input.replaceWith(span);
          return;
        }
        try {
          const res = await fetch(`/api/sounds/${encodeURIComponent(oldName)}`, {
            method: 'PATCH',
            headers: { 'Authorization': `Bearer ${this.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ newName })
          });
          if (res.ok) {
            // Update hotkey bindings
            Object.keys(this._soundHotkeys).forEach(k => {
              if (this._soundHotkeys[k] === oldName) this._soundHotkeys[k] = newName;
            });
            localStorage.setItem('haven_sound_hotkeys', JSON.stringify(this._soundHotkeys));
            this._showToast(t('media_runtime.sound.renamed', { name: newName }), 'success');
            this._loadCustomSounds();
          } else {
            let errMsg = t('media_runtime.sound.rename_failed');
            try { const d = await res.json(); errMsg = d.error || errMsg; } catch { /* no JSON error body: keep the status message */ }
            this._showToast(errMsg, 'error');
            const span = document.createElement('span');
            span.className = 'custom-sound-name';
            span.textContent = oldName;
            input.replaceWith(span);
          }
        } catch {
          this._showToast(t('media_runtime.sound.rename_failed'), 'error');
        }
      };

      input.addEventListener('blur', doRename);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
        if (e.key === 'Escape') { input.value = oldName; input.blur(); }
      });
    });
  });

  // Delete buttons
  list.querySelectorAll('.sound-delete-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const name = btn.dataset.name;
      try {
        const res = await fetch(`/api/sounds/${encodeURIComponent(name)}`, {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${this.token}` }
        });
        if (res.ok) {
          this._showToast(t('media_runtime.sound.deleted', { name }), 'success');
          // Clean up hotkey
          Object.keys(this._soundHotkeys).forEach(k => {
            if (this._soundHotkeys[k] === name) delete this._soundHotkeys[k];
          });
          localStorage.setItem('haven_sound_hotkeys', JSON.stringify(this._soundHotkeys));
          this._loadCustomSounds();
        } else {
          this._showToast(t('media_runtime.delete_failed'), 'error');
        }
      } catch {
        this._showToast(t('media_runtime.delete_failed'), 'error');
      }
    });
  });
},

// ── Soundboard Tab ─────────────────────────────────────

_renderSoundboard(filter = '') {
  // Render into both the modal grid and the PiP grid if it's open
  const grids = [];
  const modalGrid = document.getElementById('soundboard-grid');
  if (modalGrid) grids.push(modalGrid);
  const pipGrid = this._soundboardPip ? document.getElementById('sb-pip-grid') : null;
  if (pipGrid) grids.push(pipGrid);
  if (grids.length === 0) return;

  let sounds = (this.customSounds || []).filter(s =>
    (!filter || s.name.toLowerCase().includes(filter.toLowerCase())) &&
    (!this._soundPrefs[s.name]?.hidden || this._showHiddenSounds)
  );

  // Reverse lookup: soundName → hotkey
  const hotkeyMap = {};
  Object.entries(this._soundHotkeys).forEach(([hk, name]) => { hotkeyMap[name] = hk; });

  const html = sounds.length === 0
    ? `<p class="muted-text" style="grid-column:1/-1">${t(filter ? 'media_runtime.sound.no_matches' : 'modals.sound_manager.no_sounds')}</p>`
    : sounds.map(s => {
        const hotkeyHtml = this._sbHotkeyControlsHtml(s.name, hotkeyMap[s.name]);
        return `<button class="soundboard-btn${this._soundPrefs[s.name]?.hidden ? ' hidden-sound' : ''}" data-name="${this._escapeHtml(s.name)}" data-url="${this._escapeHtml(s.url)}"><span class="sb-hide-btn" data-sound="${this._escapeHtml(s.name)}" title="${t(this._soundPrefs[s.name]?.hidden ? 'media_runtime.sound.show' : 'media_runtime.sound.hide')}">👁️</span><span class="sb-name">${this._escapeHtml(s.name)}</span>
          ${hotkeyHtml}
        </button>`;
      }).join('');

  grids.forEach(grid => {
    grid.innerHTML = html;
    if (sounds.length === 0) return;

    // Apply list mode class to popup/pip grids
    if (this._soundboardListMode) grid.classList.add('list-mode');
    else grid.classList.remove('list-mode');

    // Click the main button area to play
    grid.querySelectorAll('.soundboard-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        if (e.target.closest('.sb-hotkey-clear') || e.target.closest('.sb-hotkey-set')) return;
        this._playSoundFile(btn.dataset.url);
      });
    });

    const currentFilter = () => this._soundboardPip
      ? (document.getElementById('sb-pip-search')?.value?.trim() || '')
      : (document.getElementById('soundboard-search')?.value?.trim() || '');
    this._bindSbHotkeyControls(grid, hotkeyMap, () => this._renderSoundboard(currentFilter()));

    // Hide / show button (👁️)
    grid.querySelectorAll('.sb-hide-btn').forEach(el => {
      el.addEventListener('click', async (e) => {
        e.stopPropagation();
        const name = el.dataset.sound;
        if (!this._soundPrefs[name]) this._soundPrefs[name] = {};
        this._soundPrefs[name].hidden = !this._soundPrefs[name].hidden;
        await this._saveUserSoundPrefs();
        const searchVal = this._soundboardPip
          ? (document.getElementById('sb-pip-search')?.value?.trim() || '')
          : (document.getElementById('soundboard-search')?.value?.trim() || '');
        this._renderSoundboard(searchVal);
      });
    });

  });
},

// ── Assign to Events Tab ───────────────────────────────

_renderAssignTab() {
  const builtinSounds = [
    { value: 'ping', label: 'Ping' }, { value: 'chime', label: 'Chime' },
    { value: 'blip', label: 'Blip' }, { value: 'bell', label: 'Bell' },
    { value: 'drop', label: 'Drop' }, { value: 'alert', label: 'Alert' },
    { value: 'chord', label: 'Chord' }, { value: 'swoosh', label: 'Swoosh' },
    { value: 'none', label: t('media_runtime.none') },
  ];
  const customs = (this.customSounds || []).map(s => ({
    value: `custom:${s.name}`, label: s.name, url: s.url, builtin: !!s.builtin
  }));
  const fileBuiltins = customs.filter(s => s.builtin);
  const userCustoms  = customs.filter(s => !s.builtin);

  const events = [
    { selectId: 'assign-msg-sound', event: 'message', notifSelect: 'notif-msg-sound' },
    { selectId: 'assign-sent-sound', event: 'sent', notifSelect: 'notif-sent-sound' },
    { selectId: 'assign-mention-sound', event: 'mention', notifSelect: 'notif-mention-sound' },
    { selectId: 'assign-join-sound', event: 'join', notifSelect: 'notif-join-sound' },
    { selectId: 'assign-leave-sound', event: 'leave', notifSelect: 'notif-leave-sound' },
  ];

  events.forEach(({ selectId, event, notifSelect }) => {
    const sel = document.getElementById(selectId);
    if (!sel) return;

    // Build options
    sel.innerHTML = '';
    const builtinGroup = document.createElement('optgroup');
    builtinGroup.label = '🔊 Built-in';
    builtinSounds.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.value;
      opt.textContent = s.label;
      builtinGroup.appendChild(opt);
    });
    sel.appendChild(builtinGroup);

    if (fileBuiltins.length > 0) {
      const fbGroup = document.createElement('optgroup');
      fbGroup.label = '🎙️ Sounds';
      fileBuiltins.forEach(s => {
        const opt = document.createElement('option');
        opt.value = s.value;
        opt.textContent = s.label;
        opt.dataset.url = s.url;
        fbGroup.appendChild(opt);
      });
      sel.appendChild(fbGroup);
    }

    if (userCustoms.length > 0) {
      const customGroup = document.createElement('optgroup');
      customGroup.label = '🎵 Custom';
      userCustoms.forEach(s => {
        const opt = document.createElement('option');
        opt.value = s.value;
        opt.textContent = s.label;
        opt.dataset.url = s.url;
        customGroup.appendChild(opt);
      });
      sel.appendChild(customGroup);
    }

    // Sync with current notification setting
    sel.value = this.notifications.sounds[event] || 'none';
    // Replace the native dropdown with a custom one constrained to the modal,
    // so long sound lists don't render a native popup that overflows the
    // Haven window (#5418 follow-up). Idempotent — re-renders sync the label.
    this._enhanceSelectAsCustom?.(sel);

    // On change, update the main notification select + play preview
    sel.addEventListener('change', () => {
      const val = sel.value;
      this.notifications.setSound(event, val);
      // Sync the main settings select
      const mainSel = document.getElementById(notifSelect);
      if (mainSel) mainSel.value = val;
      // Play preview
      this.notifications.play(event);
    });
  });
},

};
