// Your status: the status picker, activity sharing, and going idle
// automatically when the server asks for it.

export default {

// ═══════════════════════════════════════════════════════
// ── User Status Picker ────────────────────────────────
// ═══════════════════════════════════════════════════════

_setupStatusPicker() {
  const userBar = document.querySelector('.user-bar');
  if (!userBar) return;

  // Insert status dot to the right of the username block. The dot sits inside
  // a real <button> so it looks and behaves like the control it has always
  // been. On its own an 8px dot reads as a status indicator, not something
  // clickable. _updateStatusPickerUI still owns the inner dot's classes.
  const statusBtn = document.createElement('button');
  statusBtn.id = 'user-status-btn';
  statusBtn.className = 'status-picker-btn';
  statusBtn.type = 'button';
  statusBtn.title = t('app.profile.set_status');
  statusBtn.setAttribute('aria-label', t('app.profile.set_status'));

  const statusDot = document.createElement('span');
  statusDot.id = 'user-status-dot';
  statusDot.className = 'user-dot status-picker-dot';
  statusBtn.appendChild(statusDot);
  statusBtn.addEventListener('click', (e) => { e.stopPropagation(); this._toggleStatusPicker(); });

  const userNames = userBar.querySelector('.user-names');
  if (userNames && userNames.nextSibling) {
    userBar.insertBefore(statusBtn, userNames.nextSibling);
  } else {
    userBar.appendChild(statusBtn);
  }

  // Build dropdown (opens downward to avoid clipping)
  const picker = document.createElement('div');
  picker.id = 'status-picker';
  picker.className = 'status-picker';
  picker.style.display = 'none';
  picker.innerHTML = `
    <div class="status-option" data-status="online"><span class="user-dot"></span> ${t('app.profile.online')}</div>
    <div class="status-option" data-status="away"><span class="user-dot away"></span> ${t('app.profile.away')}</div>
    <div class="status-option" data-status="dnd"><span class="user-dot dnd"></span> ${t('app.profile.dnd')}</div>
    <div class="status-option" data-status="invisible"><span class="user-dot invisible"></span> ${t('app.profile.invisible')}</div>
    <div class="status-text-row">
      <input type="text" id="status-text-input" placeholder="${t('app.profile.custom_status_placeholder')}" maxlength="128">
    </div>
    <div class="status-activity-row">
      <div class="status-activity-label">${t('app.profile.share_activity_title')}</div>
      <label class="status-activity-toggle" title="${t('app.profile.share_activity_hint')}">
        <span>${t('app.profile.music_activity')}</span>
        <input type="checkbox" id="status-music-activity">
      </label>
      <label class="status-activity-toggle" title="${t('app.profile.share_activity_hint')}">
        <span>${t('app.profile.game_activity')}</span>
        <input type="checkbox" id="status-game-activity">
      </label>
    </div>
  `;
  userBar.appendChild(picker);

  picker.querySelectorAll('.status-option').forEach(opt => {
    opt.addEventListener('click', () => {
      const status = opt.dataset.status;
      const statusText = document.getElementById('status-text-input').value.trim();
      // Track whether user manually chose a non-online status (away/dnd/invisible)
      this._manualStatusOverride = (status !== 'online');
      if (!this.socket?.connected) {
        // Queue status change for when socket reconnects
        this._pendingStatus = { status, statusText };
        this._showToast(t('toasts.status_pending_reconnect'), 'info');
      } else {
        this.socket.emit('set-status', { status, statusText });
      }
      picker.style.display = 'none';
    });
  });

  document.getElementById('status-text-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const statusText = e.target.value.trim();
      this.socket.emit('set-status', { status: this.userStatus, statusText });
      picker.style.display = 'none';
    }
  });

  // Quick activity toggles. Same two server-side preferences the Activity
  // section in Settings writes, so the two stay in lockstep either way.
  const bindQuickActivity = (el, kind, prefKey) => {
    if (!el) return;
    el.addEventListener('change', () => {
      if (el.checked && !this._activityProviderReady(kind)) {
        // Nothing is linked that could produce this activity yet, so flipping
        // the preference here would be a no-op the user can't diagnose. Send
        // them to the full Activity section, which explains the setup and is
        // where the account connections live.
        el.checked = false;
        picker.style.display = 'none';
        this._openActivitySettings();
        return;
      }
      const v = String(el.checked);
      if (this._userPrefs) this._userPrefs[prefKey] = v;
      this.socket?.emit('set-preference', { key: prefKey, value: v });
      // The sub-preferences do nothing while the master switch is off. Turning
      // one on from here turns the master on too, rather than showing a ticked
      // box that shares nothing.
      if (el.checked && this._userPrefs?.share_activity === 'false') {
        this._userPrefs.share_activity = 'true';
        this.socket?.emit('set-preference', { key: 'share_activity', value: 'true' });
      }
      this._syncActivityUI?.();
      this._syncStatusPickerActivity();
    });
  };
  bindQuickActivity(document.getElementById('status-music-activity'), 'music', 'share_music_activity');
  bindQuickActivity(document.getElementById('status-game-activity'),  'game',  'share_game_activity');

  // Close picker on outside click
  document.addEventListener('click', (e) => {
    if (!picker.contains(e.target) && !statusBtn.contains(e.target)) {
      picker.style.display = 'none';
    }
  });
},

_toggleStatusPicker() {
  const picker = document.getElementById('status-picker');
  // Anchor on the button, which is the visible surface now, falling back to the
  // dot so nothing breaks if the markup is ever built the old way.
  const dot = document.getElementById('user-status-btn') || document.getElementById('user-status-dot');
  // Preferences can change from the Settings panel (or another device) while
  // the picker sits in the DOM, so re-read them every time it opens.
  this._syncStatusPickerActivity();
  if (picker.style.display !== 'none' && picker.style.display !== '') {
    picker.style.display = 'none';
    return;
  }
  // Position the fixed picker relative to the status dot
  if (dot) {
    const rect = dot.getBoundingClientRect();
    const isMobile = window.innerWidth <= 480;
    // On mobile, center horizontally and open above the user bar
    if (isMobile) {
      picker.style.left = '10px';
      picker.style.right = '10px';
      picker.style.width = 'auto';
      picker.style.bottom = (window.innerHeight - rect.top + 4) + 'px';
      picker.style.top = 'auto';
      // Clamp so it doesn't go above the safe area
      const maxBottom = window.innerHeight - 10;
      const computedBottom = window.innerHeight - rect.top + 4;
      if (computedBottom > maxBottom) {
        picker.style.bottom = maxBottom + 'px';
      }
    } else {
      picker.style.left = rect.left + 'px';
      picker.style.right = 'auto';
      picker.style.width = '220px';
      // Open above or below depending on space
      const spaceBelow = window.innerHeight - rect.bottom;
      if (spaceBelow > 220) {
        picker.style.top = (rect.bottom + 4) + 'px';
        picker.style.bottom = 'auto';
      } else {
        picker.style.bottom = (window.innerHeight - rect.top + 4) + 'px';
        picker.style.top = 'auto';
      }
    }
  }
  picker.style.display = 'block';
},

// Is there anything linked that could actually produce this kind of activity?
// Haven's own music player shares without a connection, but it only runs while
// you're listening in a voice channel, so a linked provider is still the right
// signal for whether the toggle has anything to do day to day.
_activityProviderReady(kind) {
  const linked = new Set((this._connections?.connections || []).map(c => c.provider));
  return kind === 'music'
    ? (linked.has('lastfm') || linked.has('spotify'))
    : linked.has('steam');
},

// Open Settings on the Activity section (master switch + connections).
// Mirrors the pattern used by the recovery-codes and push notices.
_openActivitySettings() {
  document.getElementById('open-settings-btn')?.click();
  setTimeout(() => {
    document.querySelector('.settings-nav-item[data-target="section-activity"]')?.click();
  }, 150);
},

// Reflect the current preferences on the quick toggles. A box is only ticked
// when something would actually be shared: the master switch is on, the
// sub-preference is on, AND an account is linked that can produce it. Both
// sub-preferences default to on when absent, so without the readiness check a
// brand new user would open this menu and see both already ticked while
// nothing was being shared at all. Showing them off means ticking one routes
// to the Activity settings, which is where the setup actually happens.
_syncStatusPickerActivity() {
  const prefs = this._userPrefs || {};
  const master = prefs.share_activity !== 'false';
  const music = document.getElementById('status-music-activity');
  const game  = document.getElementById('status-game-activity');
  // Absent sub-preference means "on", matching the server's read in activity.js.
  if (music) music.checked = master && prefs.share_music_activity !== 'false'
                             && this._activityProviderReady('music');
  if (game)  game.checked  = master && prefs.share_game_activity  !== 'false'
                             && this._activityProviderReady('game');
},

_updateStatusPickerUI() {
  const dot = document.getElementById('user-status-dot');
  if (dot) {
    dot.className = 'user-dot status-picker-dot';
    if (this.userStatus === 'away') dot.classList.add('away');
    else if (this.userStatus === 'dnd') dot.classList.add('dnd');
    else if (this.userStatus === 'invisible') dot.classList.add('invisible');
  }
},

// ═══════════════════════════════════════════════════════
// ── Idle Detection (server-configured auto-away) ───────
// ═══════════════════════════════════════════════════════

_setupIdleDetection() {
  const autoAwayEnabled = () => this.serverSettings.auto_away_enabled !== 'false';
  const idleTimeout = () => (Number(this.serverSettings.auto_away_visible_minutes) || 5) * 60 * 1000;
  const hiddenTimeout = () => (Number(this.serverSettings.auto_away_hidden_minutes) || 2) * 60 * 1000;
  let lastActivity = Date.now();
  let idleEmitPending = false;

  const scheduleIdle = () => {
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (!autoAwayEnabled()) {
      return;
    }
    const scheduledDelay = document.hidden ? hiddenTimeout() : idleTimeout();
    this.idleTimer = setTimeout(() => {
      goIdle();
    }, scheduledDelay);
  };

  const goIdle = () => {
    if (autoAwayEnabled() && this.userStatus === 'online' && !this._manualStatusOverride) {
      this.userStatus = 'away';  // optimistic local update (server confirms via status-updated)
      this._updateStatusPickerUI();
      this.socket.emit('set-status', { status: 'away', statusText: this.userStatusText });
    }
  };

  const goOnline = () => {
    if (this.userStatus === 'away' && !this._manualStatusOverride) {
      this.userStatus = 'online';  // optimistic local update
      this._updateStatusPickerUI();
      this.socket.emit('set-status', { status: 'online', statusText: this.userStatusText });
    }
  };

  const resetIdle = () => {
    lastActivity = Date.now();
    // Restore from away if needed (debounced, only emit once)
    if (this.userStatus === 'away' && !this._manualStatusOverride && !idleEmitPending) {
      idleEmitPending = true;
      setTimeout(() => { idleEmitPending = false; goOnline(); }, 300);
    }
    // Notify server of activity for AFK voice tracking (throttled to once per 15s)
    if (this.voice?.inVoice && (!this._lastVoiceActivityPing || Date.now() - this._lastVoiceActivityPing > 15000)) {
      this._lastVoiceActivityPing = Date.now();
      this.socket.emit('voice-activity');
    }
    scheduleIdle();
  };
  this._refreshIdleTimeout = scheduleIdle;
  // Expose so voice speech detection can reset idle & presence
  this._resetIdle = resetIdle;

  // Only fire on intentional input, NOT mousemove (micro-jitters keep resetting)
  ['keydown', 'click', 'scroll', 'touchstart', 'mousedown'].forEach(evt => {
    document.addEventListener(evt, resetIdle, { passive: true });
  });

  // Tab visibility: go idle faster when tab is hidden, come back when visible
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      scheduleIdle('tab hidden');
    } else {
      resetIdle();
    }
  });

  resetIdle();
},

};
