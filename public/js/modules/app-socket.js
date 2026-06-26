export default {

// ── Socket Event Listeners ────────────────────────────

_setupSocketListeners() {
  // Authoritative user info pushed by server on every connect
  this.socket.on('session-info', (data) => {
    this.user = { ...this.user, ...data };
    this.user.roles = data.roles || [];
    this.user.effectiveLevel = data.effectiveLevel || 0;
    this.user.permissions = data.permissions || [];
    if (this.voice && data.id) this.voice.localUserId = data.id;
    if (data.status) {
      this.userStatus = data.status;
      this.userStatusText = data.statusText || '';
      this._manualStatusOverride = (data.status !== 'online' && data.status !== 'away');
      this._updateStatusPickerUI();
    }
    // Sync avatar shape from server
    if (data.avatarShape) {
      this.user.avatarShape = data.avatarShape;
      this._avatarShape = data.avatarShape;
      this._pendingAvatarShape = data.avatarShape;
      localStorage.setItem('haven_avatar_shape', data.avatarShape);
      // Update shape picker UI
      const picker = document.getElementById('avatar-shape-picker');
      if (picker) {
        picker.querySelectorAll('.avatar-shape-btn').forEach(btn => {
          btn.classList.toggle('active', btn.dataset.shape === data.avatarShape);
        });
      }
    }
    localStorage.setItem('haven_user', JSON.stringify(this.user));
    // (#5394) Merge server-stored nicknames. Server is authoritative for any
    // key it knows about; localStorage keeps anything the server doesn't have yet.
    if (data.nicknames && typeof data.nicknames === 'object') {
      const serverNicks = data.nicknames;
      const localNicks = this._nicknames || {};
      // Migrate: push localStorage-only nicknames to the server once.
      const toSync = {};
      for (const [id, nick] of Object.entries(localNicks)) {
        if (nick && !serverNicks[id]) toSync[id] = nick;
      }
      if (Object.keys(toSync).length) this.socket.emit('set-nicknames-bulk', { nicknames: toSync });
      // Server wins on conflict.
      this._nicknames = { ...localNicks, ...serverNicks };
      localStorage.setItem('haven_nicknames', JSON.stringify(this._nicknames));
    }
    // Init E2E encryption AFTER socket is fully connected & server handlers registered
    if (!this._e2eInitDone) {
      this._e2eInitDone = true;
      this._initE2E();
    }
    // Show server version in status bar
    if (data.version) {
      const vEl = document.getElementById('status-version');
      if (vEl) vEl.textContent = 'v' + data.version;
    }
    // Refresh display name + admin UI with authoritative data
    document.getElementById('current-user').textContent = this.user.displayName || this.user.username;
    const loginEl = document.getElementById('login-name');
    if (loginEl) loginEl.textContent = `@${this.user.username}`;
    // Update avatar preview in settings if present
    this._updateAvatarPreview();
    // Show admin/mod controls based on role level
    const canModerate = this.user.isAdmin || this.user.effectiveLevel >= 25;
    const canCreateChannel = this.user.isAdmin || this._hasPerm('create_channel');
    document.getElementById('admin-controls').style.display = canCreateChannel ? 'block' : 'none';
    if (this.user.isAdmin) {
      document.getElementById('admin-mod-panel').style.display = 'block';
    } else {
      document.getElementById('admin-mod-panel').style.display = (canModerate || this._hasPerm('manage_emojis') || this._hasPerm('manage_stickers') || this._hasPerm('manage_soundboard') || this._hasPerm('view_audit_log')) ? 'block' : 'none';
    }
    document.getElementById('sidebar-members-btn').style.display = (this.user.isAdmin || canModerate || this._hasPerm('view_all_members') || this._hasPerm('view_channel_members')) ? '' : 'none';
  });

  // Roles updated (from admin assigning/revoking)
  this.socket.on('roles-updated', (data) => {
    this.user.roles = data.roles || [];
    this.user.effectiveLevel = data.effectiveLevel || 0;
    this.user.permissions = data.permissions || [];
    localStorage.setItem('haven_user', JSON.stringify(this.user));
    // Refresh UI to reflect new permissions
    const canModerate = this.user.isAdmin || this.user.effectiveLevel >= 25;
    const canCreateChannel = this.user.isAdmin || this._hasPerm('create_channel');
    document.getElementById('admin-controls').style.display = canCreateChannel ? 'block' : 'none';
    document.getElementById('admin-mod-panel').style.display = (canModerate || this._hasPerm('manage_emojis') || this._hasPerm('manage_stickers') || this._hasPerm('manage_soundboard') || this._hasPerm('view_audit_log')) ? 'block' : 'none';
    document.getElementById('sidebar-members-btn').style.display = (this.user.isAdmin || canModerate || this._hasPerm('view_all_members') || this._hasPerm('view_channel_members')) ? '' : 'none';
    this._showToast(t('toasts.roles_updated'), 'info');
  });

  // Avatar updated confirmation (from socket broadcast by other tabs/reconnect)
  this.socket.on('avatar-updated', (data) => {
    if (data && data.url !== undefined) {
      this.user.avatar = data.url;
      localStorage.setItem('haven_user', JSON.stringify(this.user));
      this._updateAvatarPreview();
    }
  });

  // (#5426) A custom sound/emoji/sticker was added or removed by an admin.
  // Re-fetch the affected library so the change shows up live for everyone
  // instead of only after an app restart.
  this.socket.on('library-updated', (data) => {
    const kind = data && data.kind;
    if (kind === 'sounds') this._loadCustomSounds?.();
    else if (kind === 'emojis') this._loadCustomEmojis?.();
    else if (kind === 'stickers') this._loadStickers?.();
  });

  this.socket.on('connect', () => {
    this._setLed('connection-led', 'on');
    this._setLed('status-server-led', 'on');
    document.getElementById('status-server-text').textContent = 'Connected';
    this._lastConnectTime = Date.now();
    this._authErrorStreak = 0;
    this._startPingMonitor();
    // (#self-absent-voice-panel) Cancel any pending soft-leave from a brief
    // socket blip — we reconnected before the 2 s deadline, so the voice
    // session is still live and just needs to rebind its socketId on the
    // server side via voice-rejoin (handled below).
    if (this._voiceDisconnectTimer) {
      clearTimeout(this._voiceDisconnectTimer);
      this._voiceDisconnectTimer = null;
    }
    // Re-join channel after reconnect (server lost our room membership)
    this.socket.emit('visibility-change', { visible: !document.hidden });
    this.socket.emit('get-channels');
    this.socket.emit('get-server-settings');

    // (#5399 follow-up) Reconcile per-channel mute prefs with the server
    // once per session so the server can honor them when fanning out
    // pushes. Guarded internally — safe to call on every reconnect.
    this._bootstrapChannelPrefs?.();

    // (#5391) Watchdog: if the socket connects but channels-list never
    // arrives, the session is in a broken state that the auth middleware
    // didn't catch (DB hiccup mid-handshake, getEnrichedChannels throwing,
    // user row out of sync, etc.). The visible symptom is the sidebar
    // sitting empty forever and the user not knowing whether to refresh.
    // After 10 s of silence, fall back to a deterministic HTTP token check
    // and either retry once or kick to /login. Cleared as soon as
    // channels-list lands (see the channels-list handler below).
    if (this._channelsWatchdog) clearTimeout(this._channelsWatchdog);
    this._channelsListGotResponse = false;
    this._channelsWatchdog = setTimeout(async () => {
      if (this._channelsListGotResponse) return;
      try {
        const resp = await fetch('/api/auth/validate', {
          headers: { 'Authorization': 'Bearer ' + (localStorage.getItem('haven_token') || '') }
        });
        if (resp.status === 401 || resp.status === 404) {
          // Token is stale or user row gone — same outcome as a socket
          // 'Invalid token' / 'Session expired'. Kick to login.
          localStorage.removeItem('haven_token');
          localStorage.removeItem('haven_user');
          localStorage.removeItem('haven_sync_key');
          window.location.href = '/';
          return;
        }
      } catch {
        // Network failure — leave it alone, the user can refresh manually.
        return;
      }
      // Token is valid but channels never came. Retry once before giving up.
      if (!this._channelsListGotResponse && this.socket?.connected) {
        console.warn('[#5391] channels-list missing after 10s, retrying get-channels');
        this.socket.emit('get-channels');
        setTimeout(() => {
          if (!this._channelsListGotResponse) {
            // Server clearly can't fulfil get-channels for this session —
            // a full reload picks up any server-side fix and re-runs the
            // auth handshake from scratch.
            console.warn('[#5391] channels-list still missing after retry, forcing reload');
            window.location.reload();
          }
        }, 5000);
      }
    }, 10000);
    if (this.currentChannel) {
      this.socket.emit('enter-channel', { code: this.currentChannel });
      // Reset pagination — reconnect replaces message list
      this._oldestMsgId = null;
      this._noMoreHistory = false;
      this._loadingHistory = false;
      this._historyBefore = null;
      this._newestMsgId = null;
      this._noMoreFuture = true;
      this._loadingFuture = false;
      this._historyAfter = null;
      this.socket.emit('get-messages', { code: this.currentChannel });
      this.socket.emit('get-channel-members', { code: this.currentChannel });
      // Request fresh voice list for this channel
      this.socket.emit('request-voice-users', { code: this.currentChannel });
    }
    // Re-join voice if we were in voice before reconnect
    if (this.voice && this.voice.inVoice && this.voice.currentChannel) {
      this.socket.emit('voice-rejoin', { code: this.voice.currentChannel });
      if (this.voice.isMuted) this.socket.emit('voice-mute-state', { code: this.voice.currentChannel, muted: true });
      if (this.voice.isDeafened) this.socket.emit('voice-deafen-state', { code: this.voice.currentChannel, deafened: true });
      // (#5427) When the socket flaps (common on the web client behind certain
      // proxies/browsers), this fast-path rejoin keeps the existing peer
      // connections instead of rebuilding them — but if ICE silently died
      // during the outage, some peers end up with no audio while others are
      // fine. The auto-recovery on connectionstatechange can take up to 8s and
      // can miss an event that fired while we were disconnected. Once signaling
      // is back, proactively ICE-restart only the peers that are actually
      // broken so audio comes back without a manual leave/rejoin.
      setTimeout(() => {
        if (this.socket?.connected) this.voice._healPeerConnections?.();
      }, 1500);
    } else if (this.voice && this.voice._softLeftChannel) {
      // (#5347 v3.15.4) The socket dropped while we were in voice; _softLeave
      // tore down local audio but kept the channel intent. Re-init the mic
      // and announce ourselves via voice-rejoin so peers tear down their
      // stale RTCPeerConnections via voice-user-left and we get fresh ones.
      // This is the proper rejoin path — the localStorage setTimeout(1500)
      // fallback below uses voice.join which doesn't do that, leaving peers
      // with dead audio paths even after "rejoin".
      const rejoinChannel = this.voice._softLeftChannel;
      this.voice._softLeftChannel = null;
      (async () => {
        try {
          const ok = await this.voice.join(rejoinChannel);
          if (ok) {
            this._updateVoiceButtons(true);
            this._updateVoiceStatus(true);
            this._updateVoiceBar();
          }
        } catch (e) {
          console.warn('[Voice] reconnect rejoin failed:', e);
        }
      })();
    } else {
      // Check localStorage for saved voice channel (persists across page refreshes / server restarts)
      try {
        const savedVoiceChannel = localStorage.getItem('haven_voice_channel');
        if (savedVoiceChannel && /^[a-f0-9]{8}$/i.test(savedVoiceChannel)) {
          // Auto-rejoin saved voice channel after delay (wait for channels to load)
          setTimeout(async () => {
            if (this.voice && !this.voice.inVoice) {
              console.log('[Voice] Auto-rejoining saved voice channel:', savedVoiceChannel);
              const ok = await this.voice.join(savedVoiceChannel);
              if (ok) {
                this._updateVoiceButtons(true);
                this._updateVoiceStatus(true);
                this._updateVoiceBar();
              }
            }
          }, 1500);
        }
      } catch {}
    }
    // Apply any queued status change from when we were disconnected
    if (this._pendingStatus) {
      this.socket.emit('set-status', this._pendingStatus);
      this._pendingStatus = null;
    }
    // Show recovery-codes feature notice once per user (dismissible)
    if (!localStorage.getItem('haven_recovery_notice_v1')) {
      setTimeout(() => this._showRecoveryNotice(), 2500);
    }
  });
  document.addEventListener('visibilitychange', () => {
    this.socket?.emit('visibility-change', { visible: !document.hidden });
    // Track when we went hidden so we can detect long sleeps on resume
    // (PC suspend/lock for hours leaves a "zombie" socket that the client
    // thinks is connected but the server has long since dropped via ping
    // timeout — the result is empty member lists and no chat history on
    // wake until you switch channels twice). (#post-sleep-channel-desync)
    if (document.hidden) {
      this._hiddenAt = Date.now();
      return;
    }
    const hiddenForMs = this._hiddenAt ? (Date.now() - this._hiddenAt) : 0;
    this._hiddenAt = null;
    // Mobile fix: when returning to foreground, ensure socket is connected and refresh data
    if (!document.hidden) {
      // After a long hidden period (>30 s) the socket is almost certainly
      // a zombie even if .connected reports true — Chromium throttles
      // background tabs and macOS/Windows suspend network I/O during
      // sleep. Force a clean reconnect cycle so the 'connect' handler
      // does the full resync (enter-channel, get-messages, members,
      // voice users, voice-rejoin) rather than relying on the partial
      // refresh below.
      if (hiddenForMs > 30000 && this.socket) {
        try { this.socket.disconnect(); } catch {}
        try { this.socket.connect(); } catch {}
        return;
      }
      if (this.socket && !this.socket.connected) {
        this.socket.connect();
      }
      // Delayed fallback: on some mobile browsers the WebSocket dies moments
      // after the tab resumes rather than before, so the immediate check above
      // might see it as "still connected."  Retry a couple of seconds later.
      setTimeout(() => {
        if (this.socket && !this.socket.connected) this.socket.connect();
      }, 2500);
      // Browsers don't compute layout accurately while a tab is hidden, so
      // scrollToBottom during a background reconnect often undershoots.
      // Defer to requestAnimationFrame so the browser recalculates layout
      // before we read scrollHeight — avoids jumping to wrong position.
      if (this._coupledToBottom) {
        this._suppressCoupleCheck = true;
        requestAnimationFrame(() => {
          this._scrollToBottom(true);
          this._suppressCoupleCheck = false;
        });
      }

      // Skip heavy refresh if we just handled a 'connect' event (avoids doubled emits)
      const sinceLast = Date.now() - (this._lastConnectTime || 0);
      if (sinceLast < 3000) return;
      // Re-fetch current channel messages + member list to catch anything missed
      // Only do a full reset if coupled to bottom — if the user was browsing
      // history before the tab switch, preserve their position by skipping the
      // reset so _renderMessages doesn't yank them to the latest messages.
      if (this.currentChannel && this.socket?.connected) {
        // (#post-sleep-channel-desync) Re-emit enter-channel so the server
        // re-adds this socket to its channelUsers map for this code. Without
        // this, subsequent online-users broadcasts compute the roster from
        // a stale map and the user sees an empty member list — exactly the
        // symptom reported after a multi-hour PC sleep.
        this.socket.emit('enter-channel', { code: this.currentChannel });
        if (this._coupledToBottom) {
          this._oldestMsgId = null;
          this._noMoreHistory = false;
          this._loadingHistory = false;
          this._historyBefore = null;
          this._newestMsgId = null;
          this._noMoreFuture = true;
          this._loadingFuture = false;
          this._historyAfter = null;
          this.socket.emit('get-messages', { code: this.currentChannel });
        }
        this.socket.emit('get-channel-members', { code: this.currentChannel });
        // Pull a fresh online-users + voice roster so the right-side panels
        // aren't stuck on whatever stale snapshot was rendered before sleep.
        this.socket.emit('request-online-users', { code: this.currentChannel });
        this.socket.emit('request-voice-users', { code: this.currentChannel });
      }
      // Re-fetch channels in case list changed while backgrounded
      this.socket?.emit('get-channels');
      
      // Mobile voice fix: check if we should be in voice but got disconnected
      try {
        const savedVoiceChannel = localStorage.getItem('haven_voice_channel');
        if (savedVoiceChannel && this.voice && !this.voice.inVoice && this.socket?.connected) {
          console.log('[Voice] Mobile foreground — rejoining voice channel:', savedVoiceChannel);
          setTimeout(async () => {
            if (this.voice && !this.voice.inVoice) {
              const ok = await this.voice.join(savedVoiceChannel);
              if (ok) {
                this._updateVoiceButtons(true);
                this._updateVoiceStatus(true);
                this._updateVoiceBar();
              }
            }
          }, 500);
        }
      } catch {}
    }
  });

  // iOS Safari bfcache: page is restored from cache (back/forward nav or tab switch)
  // without a visibilitychange event — reconnect if the socket is stale.
  window.addEventListener('pageshow', (e) => {
    if (e.persisted && this.socket && !this.socket.connected) {
      this.socket.connect();
    }
  });

  // ── Wake-from-sleep detector (#post-sleep-channel-desync round 2) ──
  // The visibilitychange-based fix above ONLY catches scenarios where the
  // browser fires a hidden→visible transition. On Windows, locking the PC
  // (Win+L) does NOT hide the window from the browser's perspective — the
  // lock screen is an OS overlay, not a window state change. So after a
  // multi-hour lock, visibilitychange never fires on unlock, and the
  // previous fix never runs. Result: empty member list, empty chat,
  // zombie socket that the client thinks is still connected.
  //
  // Timer drift detection works regardless of visibility: when the OS
  // suspends or throttles JS execution, setInterval ticks pause. On wake,
  // the next tick fires immediately with a huge gap from the previous
  // tick. If that gap exceeds the threshold, we know the process was
  // suspended and the socket is almost certainly a zombie.
  this._lastWakeCheck = Date.now();
  if (this._wakeCheckInterval) clearInterval(this._wakeCheckInterval);
  this._wakeCheckInterval = setInterval(() => {
    const now = Date.now();
    const drift = now - this._lastWakeCheck;
    this._lastWakeCheck = now;
    // Threshold: 30 s. Normal tick is 5 s, so even with heavy GC pauses
    // or main-thread blocking we won't false-positive at 30 s.
    if (drift > 30000) {
      console.log(`[wake-detect] resumed after ${Math.round(drift/1000)}s, forcing socket resync`);
      this._forceFullResync('wake-from-sleep');
    }
  }, 5000);

  // Window focus is another reliable wake signal on Windows: when the user
  // unlocks the PC and clicks back into the Haven window, focus fires even
  // if visibilitychange didn't. We debounce against the wake detector so
  // we don't double-cycle the socket within a few seconds.
  window.addEventListener('focus', () => {
    const sinceLastResync = Date.now() - (this._lastForcedResync || 0);
    if (sinceLastResync < 5000) return;
    // Cheap liveness probe: emit a ping-check and force-resync if no pong
    // arrives within 4 s. Avoids needlessly cycling the socket on a quick
    // window-switch where the connection is actually fine.
    if (!this.socket?.connected) {
      this._forceFullResync('focus-disconnected');
      return;
    }
    const probeStart = Date.now();
    let acked = false;
    const ackHandler = () => { acked = true; };
    this.socket.once('pong-check', ackHandler);
    try { this.socket.emit('ping-check'); } catch {}
    setTimeout(() => {
      this.socket?.off('pong-check', ackHandler);
      if (!acked) {
        console.log(`[wake-detect] no pong in 4s on focus (probe ${Date.now()-probeStart}ms), zombie socket — forcing resync`);
        this._forceFullResync('focus-zombie');
      }
    }, 4000);
  });

  this.socket.on('disconnect', () => {
    this._setLed('connection-led', 'danger pulse');
    this._setLed('status-server-led', 'danger pulse');
    document.getElementById('status-server-text').textContent = 'Disconnected';
    document.getElementById('status-ping').textContent = '--';
    // (#self-absent-voice-panel — Desktop "lost myself in voice" follow-up)
    // Previously we _softLeave()'d the voice session immediately on every
    // disconnect. Socket.io aggressively reconnects within a few hundred ms
    // on transient network blips (especially Electron suspending the
    // renderer momentarily), and the immediate teardown caused a cascade:
    //   1. inVoice flips to false → defensive self-injection no longer
    //      happens → voice panel shows everyone except us.
    //   2. The reconnect path then has to rebuild the mic + AudioContext +
    //      every RTCPeerConnection, which is heavy and prone to ICE failures
    //      that other peers interpret as us "going stale".
    // Defer the teardown by 2 s; if we reconnect first (the common case),
    // skip the soft-leave entirely. The reconnect handler will issue
    // `voice-rejoin` which rebinds our voice slot to the new socketId.
    if (this.voice && this.voice.inVoice) {
      if (this._voiceDisconnectTimer) clearTimeout(this._voiceDisconnectTimer);
      this._voiceDisconnectTimer = setTimeout(() => {
        this._voiceDisconnectTimer = null;
        if (this.socket?.connected) return; // reconnected in time
        if (!(this.voice && this.voice.inVoice)) return;
        console.warn('[Voice] socket still down after 2s — soft-leaving voice');
        this.voice._softLeave();
        this._updateVoiceButtons(false);
        this._updateVoiceStatus(false);
        this._updateVoiceBar();
      }, 2000);
    }
  });

  this.socket.on('connect_error', (err) => {
    // Don't kick during password change — socket will reconnect with fresh token
    if (this._justChangedPassword) return;
    // These messages come from the socket.io auth middleware and are
    // 100% deterministic (JWT verify failure / user row mismatch / pwv bump).
    // They are NEVER transient, so we redirect to /login on the first one
    // instead of stranding the user on an empty channel list. (#5375)
    if (err.message === 'Invalid token' || err.message === 'Authentication required' || err.message === 'Session expired') {
      localStorage.removeItem('haven_token');
      localStorage.removeItem('haven_user');
      localStorage.removeItem('haven_sync_key');
      window.location.href = '/';
      return;
    }
    this._setLed('connection-led', 'danger');
    this._setLed('status-server-led', 'danger');
    document.getElementById('status-server-text').textContent = 'Error';
  });

  // Password was changed on this or another session — force re-login
  this.socket.on('force-logout', (data) => {
    if (data && data.reason === 'password_changed') {
      // If WE just changed the password, skip the kick — we already have the fresh token
      if (this._justChangedPassword) {
        this._justChangedPassword = false;
        return;
      }
      localStorage.removeItem('haven_token');
      localStorage.removeItem('haven_user');
      window.location.href = '/';
    } else if (data && data.reason === 'totp_enabled') {
      // If WE just enabled TOTP, skip the kick — we already have the fresh token
      if (this._justEnabledTotp) {
        this._justEnabledTotp = false;
        return;
      }
      localStorage.removeItem('haven_token');
      localStorage.removeItem('haven_user');
      window.location.href = '/';
    }
  });

  this.socket.on('channels-list', (channels) => {
    // (#5391) Cancel the channels-not-arriving watchdog
    this._channelsListGotResponse = true;
    if (this._channelsWatchdog) {
      clearTimeout(this._channelsWatchdog);
      this._channelsWatchdog = null;
    }
    // Detect if currentChannel's code was rotated while disconnected (stale code).
    // Capture the channel's ID from the old list before overwriting it.
    let rotatedChannelId = null;
    if (this.currentChannel && !channels.find(c => c.code === this.currentChannel)) {
      const oldEntry = this.channels.find(c => c.code === this.currentChannel);
      if (oldEntry) rotatedChannelId = oldEntry.id;
    }

    // Preserve any DM channels that were added client-side (via dm-opened
    // events). The server only sends server channels in channels-list, so
    // overwriting would wipe DM entries and break E2E decryption until the
    // user reopens the DM.
    const existingDMs = (this.channels || []).filter(c => c.is_dm);
    this.channels = channels;
    for (const dm of existingDMs) {
      if (!this.channels.find(c => c.code === dm.code)) {
        this.channels.push(dm);
      }
    }
    // Seed client-side unreadCounts from server-reported values so the
    // desktop badge, tab title, and DM section badge stay in sync.
    // Only import counts for channels we haven't touched yet this session.
    // Skip muted channels entirely — server has no knowledge of client-side
    // mute state, so bot/webhook messages can leave stale unread counts on
    // the server that would otherwise re-appear on every reconnect.
    const _mutedChsAtSeed = new Set(JSON.parse(localStorage.getItem('haven_muted_channels') || '[]'));
    for (const ch of channels) {
      if (_mutedChsAtSeed.has(ch.code)) {
        // Pre-populate with 0 so future channels-list snapshots won't re-seed.
        if (!(ch.code in this.unreadCounts)) this.unreadCounts[ch.code] = 0;
        continue;
      }
      if (!(ch.code in this.unreadCounts) && ch.unreadCount > 0) {
        this.unreadCounts[ch.code] = ch.unreadCount;
      }
    }
    this._renderChannels();
    // Push accurate totals to the desktop shell / tab title immediately
    this._updateTabTitle();
    this._updateDesktopBadge();
    this._updateDmSectionBadge();
    // Request fresh voice counts so sidebar indicators are always correct
    // (covers cases where initial push arrived before DOM was ready)
    this.socket.emit('get-voice-counts');

    // Auto-join via invite link (vanity code or channel code in query param)
    const urlParams = new URLSearchParams(window.location.search);
    const inviteCode = urlParams.get('invite');
    if (inviteCode && !this._inviteHandled) {
      this._inviteHandled = true;
      this.socket.emit('join-channel', { code: inviteCode });
      sessionStorage.removeItem('haven_pending_invite');
      // Clean up the URL
      const cleanUrl = window.location.pathname;
      window.history.replaceState({}, '', cleanUrl);
    }

    // Channel / message deep link (?channel=CODE[&message=ID])
    const linkChannel = urlParams.get('channel');
    const linkMessage = urlParams.get('message');
    if (linkChannel && !this._channelLinkHandled) {
      this._channelLinkHandled = true;
      sessionStorage.removeItem('haven_pending_channel');
      sessionStorage.removeItem('haven_pending_message');
      const known = (channels || []).some(c => c.code === linkChannel);
      const go = () => {
        this.switchChannel(linkChannel);
        if (linkMessage) {
          const msgId = parseInt(linkMessage, 10);
          if (!isNaN(msgId)) {
            // Wait briefly for messages to load before jumping
            setTimeout(() => this._jumpToMessage(msgId), 600);
          }
        }
      };
      if (known) {
        go();
      } else {
        // Do not auto-join by deep link. Message/channel links are for members
        // who already have channel access.
        this._showToast?.(t('toasts.channel_link_unavailable') || 'Channel not available on this server', 'error');
      }
      window.history.replaceState({}, '', window.location.pathname);
    }

    // Re-evaluate input area visibility for the current channel (read-only, text/media toggles may have changed)
    if (this.currentChannel) {
      const curCh = this.channels.find(c => c.code === this.currentChannel);
      if (curCh) {
        const msgInputArea = document.getElementById('message-input-area');
        const _textOff = curCh.text_enabled === 0;
        const _mediaOff = curCh.media_enabled === 0;
        const _isReadOnly = curCh.read_only === 1 && !this.user?.isAdmin && !this._hasPerm('read_only_override');
        if (msgInputArea) msgInputArea.style.display = (_isReadOnly || (_textOff && _mediaOff)) ? 'none' : '';
      }
    }

    // If the channel code rotated while we were disconnected, re-enter with the
    // new code so messages, reactions, and presence start working again.
    if (rotatedChannelId !== null) {
      const updated = channels.find(c => c.id === rotatedChannelId);
      if (updated) {
        this.currentChannel = updated.code;
        const codeDisplay = document.getElementById('channel-code-display');
        if (codeDisplay) codeDisplay.textContent = updated.display_code || updated.code;
        this.socket.emit('enter-channel', { code: this.currentChannel });
        this._oldestMsgId = null;
        this._noMoreHistory = false;
        this._loadingHistory = false;
        this._historyBefore = null;
        this._newestMsgId = null;
        this._noMoreFuture = true;
        this._loadingFuture = false;
        this._historyAfter = null;
        this.socket.emit('get-messages', { code: this.currentChannel });
        this.socket.emit('get-channel-members', { code: this.currentChannel });
      }
    }
  });

  // Channel renamed — update header if we're in that channel
  this.socket.on('channel-renamed', (data) => {
    if (data.code === this.currentChannel) {
      const el = document.getElementById('channel-header-name');
      el.textContent = '# ' + data.name;
      // Clear scramble cache so the effect picks up the renamed channel
      delete el.dataset.originalText;
      el._scrambling = false;
    }
  });

  this.socket.on('channel-created', (channel) => {
    this.channels.push(channel);
    this._renderChannels();
    this._showToast(t('toasts.channel_created', { name: channel.name, code: channel.code }), 'success');
    this.switchChannel(channel.code);
  });

  this.socket.on('channel-joined', (channel) => {
    if (!this.channels.find(c => c.code === channel.code)) {
      this.channels.push(channel);
      this._renderChannels();
    }
    this.switchChannel(channel.code);
  });

  this.socket.on('message-history', async (data) => {
    // (#post-sleep-channel-desync round 2) Clear the switch-channel safety
    // timer as soon as history arrives for the channel we last switched to.
    // This is what tells us the get-messages round-trip actually completed.
    if (this._pendingChannelHistoryCode === data.channelCode) {
      this._pendingChannelHistoryCode = null;
      if (this._switchChannelSafetyTimer) {
        clearTimeout(this._switchChannelSafetyTimer);
        this._switchChannelSafetyTimer = null;
      }
    }
    // DM PiP: if this history is for the active PiP DM, render it there.
    // We render the PiP regardless of currentChannel so the loading
    // placeholder always clears even when the same DM is also the active
    // main channel (e.g. user opened the DM in fullscreen previously,
    // then opened the PiP — issue: SerChiz v3.10.3).
    if (this._activeDMPip && data.channelCode === this._activeDMPip) {
      // E2E: ensure partner key is fetched before decrypting (self-DMs included)
      const pipCh = this.channels.find(c => c.code === data.channelCode);
      if (pipCh && pipCh.is_dm && pipCh.dm_target && !this._dmPublicKeys[pipCh.dm_target.id]) {
        await this._fetchDMPartnerKey(pipCh);
      }
      await this._decryptMessages(data.messages, data.channelCode);
      this._renderDMPiPHistory?.(data.messages);
      // If the PiP DM isn't ALSO the current channel, we're done.
      if (data.channelCode !== this.currentChannel) return;
      // Otherwise fall through so the main pane renders too.
    }
    if (data.channelCode !== this.currentChannel) return;
    // E2E: decrypt DM messages before rendering
    await this._decryptMessages(data.messages);

    // Self-healing key fetch: if the partner key was absent during decryption
    // (e.g. the pre-fetch in _recoverE2EFromBackup timed out before this
    // message-history arrived), kick off a background request now.
    // When public-key-result arrives the permanent listener calls
    // _retryDecryptForUser which re-fetches messages with decryption working.
    {
      const _e2eCh = this.channels && this.channels.find(c => c.code === this.currentChannel);
      if (_e2eCh && _e2eCh.is_dm && _e2eCh.dm_target && !this._dmPublicKeys[_e2eCh.dm_target.id]) {
        this._fetchDMPartnerKey(_e2eCh); // fire-and-forget
      }
    }

    if (this._historyBefore) {
      // Pagination request — prepend older messages
      this._historyBefore = null;
      if (data.messages.length === 0) {
        this._noMoreHistory = true;
        this._loadingHistory = false;
        return;
      }
      if (data.messages.length < 80) this._noMoreHistory = true;
      this._oldestMsgId = data.messages[0].id;
      this._prependMessages(data.messages);
      // Release lock AFTER DOM manipulation so scroll-triggered re-requests
      // don't fire while _prependMessages is adjusting scroll position.
      this._loadingHistory = false;
    } else if (this._historyAfter) {
      // Forward pagination — append newer messages
      this._historyAfter = null;
      if (data.messages.length === 0) {
        this._noMoreFuture = true;
        this._loadingFuture = false;
        return;
      }
      if (data.messages.length < 80) this._noMoreFuture = true;
      this._newestMsgId = data.messages[data.messages.length - 1].id;
      this._appendMessages(data.messages);
      this._loadingFuture = false;
    } else if (data.around) {
      // Jump-to-message — replace everything and scroll to target
      if (data.messages.length > 0) {
        this._oldestMsgId = data.messages[0].id;
        this._newestMsgId = data.messages[data.messages.length - 1].id;
      }
      this._noMoreHistory = false;
      this._noMoreFuture = false;
      this._loadingHistory = false;
      this._loadingFuture = false;
      this._historyBefore = null;
      this._historyAfter = null;
      // _jumpTargetId is already set by _jumpToMessage — _renderMessages reads it
      this._renderMessages(data.messages);
    } else {
      // Initial load — replace everything
      this._noMoreFuture = true;
      if (data.messages.length > 0) {
        this._oldestMsgId = data.messages[0].id;
        this._newestMsgId = data.messages[data.messages.length - 1].id;
        if (data.messages.length < 80) this._noMoreHistory = true;
      } else {
        this._noMoreHistory = true;
      }
      this._renderMessages(data.messages, data.lastReadMessageId);
    }

    // Re-append any pending E2E notice (survives message re-render after key change)
    if (this._pendingE2ENotice) {
      this._appendE2ENotice(this._pendingE2ENotice);
      this._pendingE2ENotice = null;
    }

    // Update pin indicator dot for the active channel
    if (typeof data.pinnedCount === 'number' && data.channelCode === this.currentChannel) {
      this._updatePinIndicator?.(data.pinnedCount);
    }
  });

  // ── Infinite scroll: load older messages on scroll-to-top ──
  const msgContainer = document.getElementById('messages');
  if (msgContainer) {
    // Track whether the user is "coupled" to the bottom of the feed.
    // Simple rule: near bottom → true, scrolled up at all → false.
    this._coupledToBottom = true;
    let lastScrollTop = msgContainer.scrollTop;
    const jumpBtn = document.getElementById('jump-to-bottom');
    msgContainer.addEventListener('scroll', () => {
      if (this._suppressCoupleCheck) return;
      const st = msgContainer.scrollTop;
      const dist = msgContainer.scrollHeight - msgContainer.clientHeight - st;
      if (dist < 200 && this._noMoreFuture !== false) {
        // Only couple if the DOM contains the actual latest messages.
        // When newer messages have been trimmed, the scroll "bottom" is
        // artificial and re-coupling would yank the user forward.
        this._coupledToBottom = true;
      } else if (st < lastScrollTop) {
        // User scrolled up — decouple immediately
        this._coupledToBottom = false;
      }
      lastScrollTop = st;
      // Show/hide jump-to-bottom button
      if (jumpBtn) {
        if (dist > 400) jumpBtn.classList.add('visible');
        else jumpBtn.classList.remove('visible');
      }
    }, { passive: true });

    // Jump-to-bottom click handler
    if (jumpBtn) {
      jumpBtn.addEventListener('click', () => {
        this._scrollToBottom(true);
        this._coupledToBottom = true;
        jumpBtn.classList.remove('visible');
      });
    }

    this._historyDebounce = 0; // timestamp of last history request
    msgContainer.addEventListener('scroll', () => {
      if (this._suppressCoupleCheck) return;
      const now = Date.now();
      if (msgContainer.scrollTop < 200 && !this._noMoreHistory && !this._loadingHistory && this._oldestMsgId && this.currentChannel && now - this._historyDebounce > 300) {
        this._loadingHistory = true;
        this._historyBefore = this._oldestMsgId;
        this._historyDebounce = now;
        // Uncouple from bottom so incoming messages don't auto-scroll
        // while the user is browsing history.
        this._coupledToBottom = false;
        this.socket.emit('get-messages', {
          code: this.currentChannel,
          before: this._oldestMsgId
        });
      }
      // Forward pagination: load newer messages when near the bottom and
      // the DOM window doesn't extend to the latest messages.
      const distBottom = msgContainer.scrollHeight - msgContainer.clientHeight - msgContainer.scrollTop;
      if (distBottom < 200 && !this._noMoreFuture && !this._loadingFuture && this._newestMsgId && this.currentChannel && now - this._historyDebounce > 300) {
        this._loadingFuture = true;
        this._historyAfter = this._newestMsgId;
        this._historyDebounce = now;
        this.socket.emit('get-messages', {
          code: this.currentChannel,
          after: this._newestMsgId
        });
      }
    });
  }

  this.socket.on('new-message', async (data) => {
    // E2E: ensure partner key is available before decrypting
    const msgCh = this.channels.find(c => c.code === data.channelCode);
    if (msgCh && msgCh.is_dm && msgCh.dm_target && !this._dmPublicKeys[msgCh.dm_target.id]) {
      await this._fetchDMPartnerKey(msgCh);
    }
    // E2E: decrypt single message if encrypted
    await this._decryptMessages([data.message], data.channelCode);

    // DM PiP: if message is for the active PiP DM, append to the floating panel
    if (this._activeDMPip && data.channelCode === this._activeDMPip) {
      this._appendDMPiPMessage?.(data.message);
    }

    if (data.channelCode === this.currentChannel) {
      const isOwnMessage = data.message.user_id === this.user.id;
      // Treat the channel as "not actively being read" when the page is
      // hidden — this happens for backgrounded server BrowserViews in
      // Desktop, and for any tab the user has alt-tabbed away from. We
      // still want to append the message so it's there when they come
      // back, but we skip mark-read and bump the unread badge instead.
      const isActivelyViewing = !document.hidden;

      // If the user is scrolled into history and the DOM window has been
      // trimmed (doesn't include the latest messages), skip appending —
      // the message will be loaded via forward pagination when the user
      // scrolls back down.  Exception: own messages always snap to present.
      if (this._noMoreFuture !== false || isOwnMessage) {
        if (isOwnMessage && this._noMoreFuture === false) {
          // User sent a message while browsing history — snap back to
          // the present by doing a fresh load of the channel.
          this._oldestMsgId = null;
          this._noMoreHistory = false;
          this._loadingHistory = false;
          this._historyBefore = null;
          this._newestMsgId = null;
          this._noMoreFuture = true;
          this._loadingFuture = false;
          this._historyAfter = null;
          this.socket.emit('get-messages', { code: this.currentChannel });
        } else {
          this._appendMessage(data.message, isOwnMessage);
          this._newestMsgId = data.message.id;
        }
        if (isActivelyViewing) {
          this._markRead(data.message.id);
          // Clear any stale badge — but only when the user has actually seen
          // the new message (coupled to the bottom of the feed).
          if (this._coupledToBottom && this.unreadCounts[data.channelCode]) {
            this.unreadCounts[data.channelCode] = 0;
            this._updateBadge(data.channelCode);
          }
        } else if (!isOwnMessage) {
          // Page hidden (backgrounded server view, alt-tabbed, minimised) —
          // count it as unread even though it's the "current" channel, so
          // the sidebar dot + taskbar badge actually fire.
          // Skip the unread bump for muted channels — muting should also silence badges.
          const _hiddenMutedChs = JSON.parse(localStorage.getItem('haven_muted_channels') || '[]');
          if (!_hiddenMutedChs.includes(data.channelCode)) {
            this.unreadCounts[data.channelCode] = (this.unreadCounts[data.channelCode] || 0) + 1;
            this._updateBadge(data.channelCode);
          }
        }
      }
      if (data.message.user_id !== this.user.id) {
        const _mutedChs = JSON.parse(localStorage.getItem('haven_muted_channels') || '[]');
        const _isMuted = _mutedChs.includes(data.channelCode) || localStorage.getItem('haven_server_muted') === '1';
        if (!_isMuted) {
          // Check if message contains @mention of current user.
          // Escape regex chars and use non-word lookahead so usernames
          // containing spaces or symbols still match. (#5273)
          const _meEsc = (this.user.username || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const mentionRegex = new RegExp(`@${_meEsc}(?!\\w)`, 'i');
          const everyoneRegex = /(?<![\w@])@(everyone|here)\b/i;
          const _notifCh = this.channels.find(c => c.code === data.channelCode);
          const _isAnnouncement = _notifCh && _notifCh.notification_type === 'announcement';
          const _isReplyToMe = data.message.replyContext && data.message.replyContext.user_id === this.user.id;
          const _isDm = _notifCh && _notifCh.is_dm;
          const _isMention = mentionRegex.test(data.message.content) || everyoneRegex.test(data.message.content);
          const _notifOpts = _isMention ? { isMention: true } : _isReplyToMe ? { isReply: true } : _isDm ? { isDm: true } : null;
          if (_isMention) {
            this.notifications.play('mention', { isMention: true });
          } else if (_isReplyToMe) {
            this.notifications.play('reply', { isReply: true });
          } else if (_isDm) {
            this.notifications.play('message', { isDm: true });
          } else {
            this.notifications.play(_isAnnouncement ? 'announcement' : 'message');
          }
          // Fire native OS notification if tab is hidden (alt-tabbed, minimised, etc.)
          if (document.hidden) {
            this._fireNativeNotification(data.message, data.channelCode, _notifOpts);
          }
        }
      }
      // TTS: speak the message aloud for all listeners
      if (data.message.tts) {
        this.notifications.speak(`${this._getNickname(data.message.user_id, data.message.username)} says: ${data.message.content}`);
      }
    } else {
      const _mutedChs2 = JSON.parse(localStorage.getItem('haven_muted_channels') || '[]');
      const _isMuted2 = _mutedChs2.includes(data.channelCode) || localStorage.getItem('haven_server_muted') === '1';
      // If this message is for the active DM PiP and the user is actively
      // viewing the app, treat it as read instead of bumping the unread
      // badge — the message is already visible in the floating PiP panel.
      const _inActivePiP = this._activeDMPip && data.channelCode === this._activeDMPip && !document.hidden;
      // Only count unread for messages from other users — own message echoes arriving after a
      // channel switch (race condition) would otherwise trigger a ghost badge.
      if (data.message.user_id !== this.user.id) {
        if (_inActivePiP) {
          // Keep the PiP DM cleared and tell the server we've read it.
          // Emit synchronously (not via the shared `_markReadTimer` debounce):
          // the timer is `clearTimeout`'d every time the user switches main
          // channels, and a debounced PiP mark-read used to get dropped on
          // the floor whenever the user clicked anything else within 500 ms,
          // leaving the server's read position stale.  After the next
          // unrelated `channels-list` snapshot the unread count would pop
          // back up on the sidebar and the OS would re-notify the same
          // already-read message.  Server uses MAX so the immediate emit
          // can't ever clobber a newer real id.
          this.unreadCounts[data.channelCode] = 0;
          this._updateBadge(data.channelCode);
          try { this.socket.emit('mark-read', { code: data.channelCode, messageId: data.message.id }); } catch {}
          try { this._updateDmSectionBadge?.(); } catch {}
          try { this._updateTabTitle?.(); } catch {}
          try { this._updateDesktopBadge?.(); } catch {}
        } else if (!_isMuted2) {
          this.unreadCounts[data.channelCode] = (this.unreadCounts[data.channelCode] || 0) + 1;
          this._updateBadge(data.channelCode);
        }
      }
      // Don't play notification sounds for your own messages in other channels
      if (data.message.user_id !== this.user.id && !_isMuted2) {
        // Check @mention even in other channels (escape username, no \b so spaces work). (#5273)
        const _meEsc2 = (this.user.username || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const mentionRegex = new RegExp(`@${_meEsc2}(?!\\w)`, 'i');
        const everyoneRegex2 = /(?<![\w@])@(everyone|here)\b/i;
        const _notifCh2 = this.channels.find(c => c.code === data.channelCode);
        const _isAnnouncement2 = _notifCh2 && _notifCh2.notification_type === 'announcement';
        const _isReplyToMe2 = data.message.replyContext && data.message.replyContext.user_id === this.user.id;
        const _isDm2 = _notifCh2 && _notifCh2.is_dm;
        const _isMention2 = mentionRegex.test(data.message.content) || everyoneRegex2.test(data.message.content);
        const _notifOpts2 = _isMention2 ? { isMention: true } : _isReplyToMe2 ? { isReply: true } : _isDm2 ? { isDm: true } : null;
        if (_isMention2) {
          this.notifications.play('mention', { isMention: true });
        } else if (_isReplyToMe2) {
          this.notifications.play('reply', { isReply: true });
        } else if (_isDm2) {
          this.notifications.play('message', { isDm: true });
        } else {
          this.notifications.play(_isAnnouncement2 ? 'announcement' : 'message');
        }
        // Fire native OS notification when tab/window is not visible
        this._fireNativeNotification(data.message, data.channelCode, _notifOpts2);
      }
    }

    // Update latestMessageId for dynamic sort
    const msgChannel = this.channels.find(c => c.code === data.channelCode);
    if (msgChannel && data.message.id > (msgChannel.latestMessageId || 0)) {
      msgChannel.latestMessageId = data.message.id;
      // Re-sort sidebar if this channel's parent uses dynamic sort
      const parent = msgChannel.parent_channel_id
        ? this.channels.find(c => c.id === msgChannel.parent_channel_id)
        : null;
      if ((parent && parent.sort_alphabetical === 4) ||
          (!msgChannel.parent_channel_id && (localStorage.getItem('haven_server_sort_mode') === 'dynamic' ||
            (!localStorage.getItem('haven_server_sort_mode') && this.serverSettings?.channel_sort_mode === 'dynamic')))) {
        this._renderChannels();
      }
    }
  });

  this.socket.on('online-users', (data) => {
    if (data.channelCode === this.currentChannel) {
      // In 'all' mode the list includes offline members too; only count truly online users
      const trueOnlineCount = data.visibilityMode === 'all'
        ? data.users.filter(u => u.online).length
        : data.users.length;
      this.onlineCount = trueOnlineCount;
      this._renderOnlineUsers(data.users);
      document.getElementById('status-online-count').textContent = trueOnlineCount;
      // Refresh online overlay if open
      const overlay = document.getElementById('online-overlay');
      if (overlay && overlay.style.display !== 'none') {
        this._renderOnlineOverlay();
      }
    }
  });

  this.socket.on('voice-users-update', (data) => {
    // (#5347 follow-up) Re-render the voice participant list whenever the
    // user is either viewing the channel OR currently in voice on it.
    const isViewing = data.channelCode === this.currentChannel;
    const isInVoice = !!(this.voice && this.voice.inVoice && this.voice.currentChannel === data.channelCode);
    // (#5347 v3.16.1) Defensively filter ourselves out of the user list
    // when we're NOT in voice on this channel. Guards against an in-flight
    // broadcast that was queued before our voice-leave was processed
    // (or reaches us out of order) re-populating the panel with our own
    // entry after we've clicked Leave.
    let users = Array.isArray(data.users) ? data.users : [];
    const myId = this.user && this.user.id;
    if (myId && !isInVoice) {
      users = users.filter(u => u.id !== myId);
    }
    // If we ARE in voice here but the server snapshot doesn't include us
    // (race: request-voice-users arrived before voice-join was processed,
    // or pruneStaleVoiceUsers briefly evicted our stale socket entry during
    // a reconnect window before voice-rejoin re-registered us), inject our
    // own entry from local state so the panel never shows us as absent
    // while the voice bar says "Voice Connected". (#self-absent-voice-panel)
    if (isInVoice && myId && !users.some(u => u.id === myId)) {
      console.warn('[VoiceSelfHeal] Server roster missing self — injecting + emitting voice-rejoin', {
        channel: data.channelCode,
        rosterIds: users.map(u => u && u.id),
        myId,
        socketId: this.socket?.id,
        socketConnected: !!this.socket?.connected
      });
      users = [
        {
          id: myId,
          username: this.user.displayName || this.user.username,
          roleColor: this.user.roleColor || null,
          isMuted: !!(this.voice && this.voice.isMuted),
          isDeafened: !!(this.voice && this.voice.isDeafened)
        },
        ...users
      ];
      // Self-heal: it's not enough to just patch the UI. If the server's
      // roster doesn't include us, peers also don't have our updated
      // socketId and our audio is silently broken until we manually leave
      // and rejoin (the exact "I have to leave and rejoin, and that kicks
      // everyone else" pattern reported repeatedly). Ask the server to
      // rebind our voice slot via voice-rejoin, which broadcasts
      // voice-user-left for any stale entry of us and re-adds us with the
      // current socketId so peers re-negotiate cleanly. Throttle to once
      // per ~3 s so we don't spam if the server's still missing us.
      const now = Date.now();
      if ((now - (this._lastVoiceSelfHealAt || 0)) > 3000 && this.socket?.connected) {
        this._lastVoiceSelfHealAt = now;
        console.warn('[Voice] Self missing from roster — emitting voice-rejoin');
        this.socket.emit('voice-rejoin', { code: data.channelCode });
      }
    }
    if ((isViewing || isInVoice) && localStorage.getItem('haven_hide_voice_panel') !== 'true') {
      this._renderVoiceUsers(users, data.channelCode);
    }
    // (#5347 v3.15.4) Keep the left sidebar in sync with the right panel.
    // Previously the right panel was driven by voice-users-update and the
    // left sidebar by voice-count-update, and the two could drift if one
    // event arrived stale or out of order (the user saw both users on the
    // right but only themselves on the left). Both stores are now updated
    // from this single authoritative event so they cannot disagree.
    const usersForSidebar = users.map(u => ({
      id: u.id, username: u.username,
      isMuted: !!u.isMuted, isDeafened: !!u.isDeafened
    }));
    if (usersForSidebar.length > 0) {
      this.voiceCounts[data.channelCode] = usersForSidebar.length;
      this.voiceChannelUsers[data.channelCode] = usersForSidebar;
    } else {
      delete this.voiceCounts[data.channelCode];
      delete this.voiceChannelUsers[data.channelCode];
    }
    this._updateChannelVoiceIndicators();
    // Keep voice bar up to date
    if (isInVoice) {
      this._updateVoiceBar();
    }
  });

  // Lightweight sidebar voice count — fires for every voice join/leave.
  // Kept for cross-channel notifications (the user gets count updates for
  // channels they're not currently viewing) and as a safety net if a
  // voice-users-update is dropped. The voice-users-update handler is the
  // primary source of truth.
  this.socket.on('voice-count-update', (data) => {
    // (#5347 v3.16.1) Same defensive self-filter as voice-users-update —
    // if we're not actually in voice on this channel, strip ourselves
    // from the broadcast so a stale message can't keep our own entry on
    // the sidebar after we've left.
    let usersList = Array.isArray(data.users) ? data.users : [];
    let count = typeof data.count === 'number' ? data.count : usersList.length;
    const myId = this.user && this.user.id;
    const inThisVoice = !!(this.voice && this.voice.inVoice && this.voice.currentChannel === data.code);
    if (myId && !inThisVoice && usersList.some(u => u.id === myId)) {
      usersList = usersList.filter(u => u.id !== myId);
      count = Math.max(0, count - 1);
    }
    // Symmetric self-inject: if we ARE in voice on this channel but the
    // count snapshot doesn't include us (race after server restart /
    // reconnect, briefly pruned-then-re-registered), add ourselves so the
    // sidebar badge doesn't drop below the real number and the channel
    // voice list under the indicator still shows us. (#missing-self-voice-panel)
    if (myId && inThisVoice && !usersList.some(u => u.id === myId)) {
      usersList = [{
        id: myId,
        username: (this.user.displayName || this.user.username),
        isMuted: !!(this.voice && this.voice.isMuted),
        isDeafened: !!(this.voice && this.voice.isDeafened)
      }, ...usersList];
      count = count + 1;
    }
    if (count > 0) {
      this.voiceCounts[data.code] = count;
      this.voiceChannelUsers[data.code] = usersList;
    } else {
      delete this.voiceCounts[data.code];
      delete this.voiceChannelUsers[data.code];
    }
    this._updateChannelVoiceIndicators();
  });

  this.socket.on('user-typing', (data) => {
    if (data.channelCode === this.currentChannel) {
      this._showTyping(data.username);
    }
  });

  this.socket.on('user-joined', (data) => {
    if (data.channelCode === this.currentChannel) {
      this._appendSystemMessage(t('header.messages.user_joined', { name: this._getNickname(data.user.id, data.user.username) }));
      this.notifications.play('join');
      // Show configurable welcome message if set
      const welcomeTemplate = this.serverSettings?.welcome_message;
      if (welcomeTemplate) {
        const welcomeText = welcomeTemplate.replace(/\{user\}/gi, this._getNickname(data.user.id, data.user.username));
        this._appendWelcomeMessage(welcomeText);
      }
    }
  });

  this.socket.on('channel-deleted', (data) => {
    this.channels = this.channels.filter(c => c.code !== data.code);
    this._renderChannels();
    // Disconnect from voice if the user is in the deleted channel's voice
    if (this.voice && this.voice.inVoice && this.voice.currentChannel === data.code) {
      this._leaveVoice();
    }
    if (this.currentChannel === data.code) {
      this._renderVoiceUsers([]);
      this.currentChannel = null;
      this._showWelcome();
      this._showToast(t('toasts.channel_deleted'), 'error');
    }
  });

  // #5390 — sister event of channel-deleted: messages were wiped via the
  // auto-clear self-destruct mode but the channel itself still exists.
  // If the user is viewing the affected channel, refetch its messages by
  // resetting the view. Otherwise nothing visual needs to change.
  this.socket.on('channel-messages-cleared', (data) => {
    if (!data || !data.code) return;
    if (this.currentChannel === data.code) {
      try { this.switchChannel(data.code); } catch (e) { console.warn('[auto-clear] re-switch failed:', e); }
      this._showToast('🧹 Channel messages were auto-cleared', 'info');
    }
  });

  // ── Temporary voice channel events (#163) ──────────────
  this.socket.on('temp-channel-created', (channel) => {
    if (!this.channels.find(c => c.code === channel.code)) {
      this.channels.push(channel);
      this._renderChannels();
    }
  });

  this.socket.on('temp-channel-join-voice', (data) => {
    if (!data || !data.code) return;
    // Switch to the new temp channel and auto-join voice
    this.switchChannel(data.code);
    setTimeout(() => this._joinVoice(), 500);
  });

  this.socket.on('error-msg', (msg) => {
    this._showToast(msg, 'error');
  });

  this.socket.on('toast', (data) => {
    if (data && data.message) this._showToast(data.message, data.type || 'info');
  });

  this.socket.on('pong-check', () => {
    if (this._pingStart) {
      const latency = Date.now() - this._pingStart;
      document.getElementById('status-ping').textContent = latency;
    }
  });

  // ── Reactions ──────────────────────────────────────
  this.socket.on('reactions-updated', (data) => {
    if (data.channelCode === this.currentChannel || data.channelCode === this._activeDMPip) {
      this._updateMessageReactions(data.messageId, data.reactions);
    }
  });

  // ── Threads ───────────────────────────────────────
  this.socket.on('thread-messages', async (data) => {
    if (data.parentUsername) {
      this._setThreadParentHeader({
        userId: data.parentUserId || null,
        username: data.parentUsername,
        avatar: data.parentAvatar || null,
        avatarShape: data.parentAvatarShape || 'circle'
      });
    }

    // E2E: thread lives inside a DM channel — decrypt parent + messages
    // before rendering so the preview/header and message bodies show plain text.
    const channelCode = data.channelCode || this.currentChannel;
    if (data.parentContent && window.HavenE2E && HavenE2E.isEncrypted(data.parentContent)) {
      const wrapper = [{ content: data.parentContent }];
      try { await this._decryptMessages(wrapper, channelCode); } catch {}
      data.parentContent = wrapper[0].content;
    }
    if (data.messages && data.messages.length) {
      try { await this._decryptMessages(data.messages, channelCode); } catch {}
    }

    // Update parent preview from server (authoritative source)
    if (data.parentContent) {
      const preview = document.getElementById('thread-parent-preview');
      if (preview) {
        const text = data.parentContent.length > 120 ? data.parentContent.substring(0, 120) + '…' : data.parentContent;
        preview.textContent = text;
      }
    }
    const container = document.getElementById('thread-messages');
    if (!container) return;
    container.innerHTML = '';
    if (data.messages) {
      data.messages.forEach(msg => this._appendThreadMessage(msg));
    }
  });

  this.socket.on('new-thread-message', async (data) => {
    // Detect @mentions / replies-to-self in thread messages, even when the
    // thread (or even the channel) is not currently open. Server broadcasts
    // new-thread-message to the entire channel room, so all members get it.
    const msg = data && data.message;
    if (msg && msg.user_id !== this.user.id) {
      const _mutedChs = JSON.parse(localStorage.getItem('haven_muted_channels') || '[]');
      const _isMuted = _mutedChs.includes(data.channelCode);
      const _meEsc = (this.user.username || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const mentionRegex = _meEsc ? new RegExp(`@${_meEsc}(?!\\w)`, 'i') : null;
      const everyoneRegex = /(?<![\w@])@(everyone|here)\b/i;
      const _isMention = (mentionRegex && mentionRegex.test(msg.content || '')) || everyoneRegex.test(msg.content || '');
      const _isReplyToMe = msg.replyContext && msg.replyContext.user_id === this.user.id;
      if ((_isMention || _isReplyToMe) && !_isMuted) {
        this._recordThreadMention(data.channelCode, data.parentId, msg);
        if (!_isMuted) this.notifications.play('mention', { isMention: true });
        if (document.hidden) {
          this._fireNativeNotification(
            { ...msg, content: `[thread] ${msg.content || ''}` },
            data.channelCode,
            { isMention: true }
          );
        }
      }
    }
    if (data.channelCode !== this.currentChannel) return;
    // If this thread is open, append the message
    if (this._activeThreadParent === data.parentId) {
      // E2E: decrypt before render for DM threads
      if (data.message) {
        try { await this._decryptMessages([data.message], data.channelCode); } catch {}
      }
      this._appendThreadMessage(data.message);
    }
  });

  this.socket.on('thread-updated', (data) => {
    if (data.channelCode !== this.currentChannel) return;
    this._updateThreadPreview(data.parentId, data.thread);
  });

  // ── Polls ─────────────────────────────────────────
  this.socket.on('poll-updated', (data) => {
    if (data.channelCode === this.currentChannel) {
      this._updatePollVotes(data.messageId, data.votes, data.totalVotes);
    }
  });

  // ── Music sharing ────────────────────────────────
  this.socket.on('music-shared', (data) => {
    this._handleMusicShared(data);
  });
  this.socket.on('music-stopped', (data) => {
    this._handleMusicStopped(data);
  });
  this.socket.on('music-control', (data) => {
    this._handleMusicControl(data);
  });
  this.socket.on('music-seek', (data) => {
    this._handleMusicSeek(data);
  });
  this.socket.on('music-search-results', (data) => {
    this._showMusicSearchResults(data);
  });
  this.socket.on('music-queue-update', (data) => {
    this._updateMusicQueueState(data);
  });

  // ── Voice kicked ────────────────────────────────
  this.socket.on('voice-kicked', (data) => {
    // Server forcibly removed us from voice — tear down locally
    if (this.voice && this.voice.inVoice) {
      this.voice.leave();
      this._updateVoiceButtons(false);
      this._updateVoiceStatus(false);
      this._updateVoiceBar();
      this._showToast(t('toasts.kicked_from_voice', { by: data.kickedBy || t('toasts.a_moderator') }), 'error');
    }
  });

  // ── Stream viewer tracking ───────────────────────
  this._streamInfo = []; // Array of { sharerId, sharerName, viewers: [{ id, username }] }
  this.socket.on('stream-viewers-update', (data) => {
    this._streamInfo = data.streams || [];
    this._updateStreamViewerBadges();
    // Always re-render voice users so the LIVE viewer count updates
    // regardless of which text channel the user is viewing
    if (this._lastVoiceUsers) {
      this._renderVoiceUsers(this._lastVoiceUsers);
    }
  });

  // ── Channel members (for @mentions) ────────────────
  this.socket.on('channel-members', (data) => {
    if (data.channelCode === this.currentChannel) {
      const wasEmpty = !this.channelMembers || this.channelMembers.length === 0;
      this.channelMembers = data.members;
      // First load can render messages before members arrive, so the
      // mention regex falls back to login names. Re-render once members
      // are known so display names + valid-mention filtering kick in. (#5273)
      if (wasEmpty && this._lastRenderedMessages && this._lastRenderedMessages.length) {
        try { this._renderMessages(this._lastRenderedMessages, this._lastRenderedReadId); } catch {}
      }
    }
  });

  // ── Channel topic changed ───────────────────────
  this.socket.on('channel-topic-changed', (data) => {
    const ch = this.channels.find(c => c.code === data.code);
    if (ch) ch.topic = data.topic;
    if (data.code === this.currentChannel) {
      this._updateTopicBar(data.topic);
    }
  });

  // ── DM opened ───────────────────────────────────
  this.socket.on('dm-opened', (data) => {
    if (!this.channels.find(c => c.code === data.code)) {
      this.channels.push(data);
      this._renderChannels();
    }
    // E2E: pre-fetch partner's public key for new DMs
    if (data.is_dm && data.dm_target) {
      this._fetchDMPartnerKey(data);
    }
    // Auto-expand DM section when a DM opens
    const dmList = document.getElementById('dm-list');
    if (dmList && dmList.style.display === 'none') {
      dmList.style.display = '';
      const arrow = document.querySelector('.dm-toggle-arrow');
      if (arrow) arrow.classList.remove('collapsed');
      localStorage.setItem('haven_dm_collapsed', false);
    }
    // Open the new/existing DM as a PiP overlay rather than switching the
    // active channel. Single-click on the sidebar entry, the "Message [User]"
    // button, and right-click → DM all funnel through here.
    this._openDMPiP?.(data.code);
    // Scroll the DM channel into view in the sidebar
    const dmEl = document.querySelector(`.channel-item[data-code="${data.code}"]`);
    if (dmEl) dmEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    // Re-enable any disabled DM buttons
    document.querySelectorAll('.user-dm-btn[disabled]').forEach(b => { b.disabled = false; b.style.opacity = ''; });
  });

  // ── Channel code rotated (dynamic codes) ────────
  this.socket.on('channel-code-rotated', (data) => {
    const ch = this.channels.find(c => c.id === data.channelId);
    if (ch) {
      const wasViewing = this.currentChannel === data.oldCode;
      const wasInVoiceHere = !!(this.voice && this.voice.currentChannel === data.oldCode);
      ch.code = data.newCode;
      // Update display_code too (admins see real code, non-admins see masked)
      if (ch.display_code && ch.display_code !== '••••••••') ch.display_code = data.newCode;
      // Update currentChannel BEFORE re-rendering so the active highlight is correct
      if (wasViewing) {
        this.currentChannel = data.newCode;
      }
      // CRITICAL (#5347): if we're in voice on the rotated channel, the
      // voice manager is still holding the OLD code as its currentChannel.
      // Without updating it, every voice-rejoin / request-voice-users /
      // voice-mute-state / etc. sent from this client uses the old code,
      // the server can't find it (the DB row's code column was just
      // updated), and we get the infinite "server says voice channel is
      // gone" loop. Migrate every voice-side code reference too.
      if (this.voice) {
        if (wasInVoiceHere) {
          this.voice.currentChannel = data.newCode;
          console.log(`[Voice] channel code rotated mid-call: ${data.oldCode} -> ${data.newCode}`);
        }
        if (this.voice._softLeftChannel === data.oldCode) {
          this.voice._softLeftChannel = data.newCode;
        }
      }
      this._renderChannels();
      // If currently viewing this channel, update the header code display
      if (this.currentChannel === data.newCode) {
        const codeDisplay = document.getElementById('channel-code-display');
        if (codeDisplay) codeDisplay.textContent = ch.display_code || data.newCode;
      }
      // If the code changed while we were actively viewing this channel,
      // any in-flight old-code history/presence replies are now ignored by
      // the exact channelCode guards in the listeners below. Re-issue the
      // active-channel fetches immediately under the new code so the chat
      // pane and member sidebar don't sit blank until the user manually
      // switches away and back.
      if (wasViewing) {
        this._oldestMsgId = null;
        this._noMoreHistory = false;
        this._loadingHistory = false;
        this._historyBefore = null;
        this._newestMsgId = null;
        this._noMoreFuture = true;
        this._loadingFuture = false;
        this._historyAfter = null;

        this.socket.emit('enter-channel', { code: data.newCode });
        this.socket.emit('get-messages', { code: data.newCode });
        this.socket.emit('get-channel-members', { code: data.newCode });
        this.socket.emit('request-online-users', { code: data.newCode });
        this.socket.emit('request-voice-users', { code: data.newCode });

        if (this._switchChannelSafetyTimer) clearTimeout(this._switchChannelSafetyTimer);
        this._pendingChannelHistoryCode = data.newCode;
        this._switchChannelSafetyTimer = setTimeout(() => {
          if (this._pendingChannelHistoryCode === data.newCode && this.currentChannel === data.newCode) {
            console.warn(`[channel-code-rotated] no message-history for ${data.newCode} within 5s - forcing resync`);
            this._forceFullResync?.('channel-code-rotated-timeout');
          }
        }, 5000);
      } else if (wasInVoiceHere) {
        this.socket.emit('request-voice-users', { code: data.newCode });
      }
      if (this.user.isAdmin) {
        this._showToast(t('toasts.channel_code_rotated', { name: ch.name }), 'info');
      }
    }
  });

  // ── Channel code settings updated ───────────────
  this.socket.on('channel-code-settings-updated', (data) => {
    const ch = this.channels.find(c => c.id === data.channelId);
    if (ch && data.settings) {
      ch.code_visibility = data.settings.code_visibility;
      ch.code_mode = data.settings.code_mode;
      ch.code_rotation_type = data.settings.code_rotation_type;
      ch.code_rotation_interval = data.settings.code_rotation_interval;
    }
  });

  // ── Webhook events ──────────────────────────────
  this.socket.on('webhook-created', (wh) => {
    // Show token once
    const reveal = document.getElementById('webhook-token-reveal');
    const urlDisplay = document.getElementById('webhook-url-display');
    const baseUrl = window.location.origin;
    urlDisplay.value = `${baseUrl}/api/webhooks/${wh.token}`;
    reveal.style.display = 'block';
    // Refresh the list
    const code = document.getElementById('webhook-modal')._channelCode;
    if (code) this.socket.emit('get-webhooks', { channelCode: code });
  });
  this.socket.on('webhooks-list', (data) => {
    this._renderWebhookList(data.webhooks, data.channelCode);
  });
  this.socket.on('webhook-deleted', (data) => {
    const code = document.getElementById('webhook-modal')._channelCode;
    if (code) this.socket.emit('get-webhooks', { channelCode: code });
  });
  this.socket.on('webhook-toggled', (data) => {
    const code = document.getElementById('webhook-modal')._channelCode;
    if (code) this.socket.emit('get-webhooks', { channelCode: code });
  });
  this.socket.on('bot-updated', (msg) => {
    this._showToast(msg, 'success');
  });

  // ── Status updated ──────────────────────────────
  this.socket.on('status-updated', (data) => {
    this.userStatus = data.status;
    this.userStatusText = data.statusText;
    this._updateStatusPickerUI();
  });

  // ── User profile popup data ─────────────────────
  this._isHoverPopup = false;
  this._hoverProfileTimer = null;
  this._hoverCloseTimer = null;
  this._hoverAutoCloseTimer = null;
  this._hoverFadeTimeout = null;
  this._hoverTarget = null;

  this.socket.on('user-profile', (profile) => {
    this._showProfilePopup(profile);
  });

  this.socket.on('bio-updated', (data) => {
    this.user.bio = data.bio || '';
    this._showToast('Bio updated', 'success');
  });

  // ── Username rename ──────────────────────────────
  this.socket.on('renamed', (data) => {
    this.token = data.token;
    this.user = data.user;
    if (this.voice && data.user.id) this.voice.localUserId = data.user.id;
    localStorage.setItem('haven_token', data.token);
    localStorage.setItem('haven_user', JSON.stringify(data.user));
    document.getElementById('current-user').textContent = data.user.displayName || data.user.username;
    const loginEl = document.getElementById('login-name');
    if (loginEl) loginEl.textContent = `@${data.user.username}`;
    this._showToast(`Display name changed to "${data.user.displayName || data.user.username}"`, 'success');
    // Refresh admin UI in case admin status changed
    this.user.permissions = data.user.permissions || this.user.permissions || [];
    const canCreate = data.user.isAdmin || this._hasPerm('create_channel');
    document.getElementById('admin-controls').style.display = canCreate ? 'block' : 'none';
    if (data.user.isAdmin) {
      document.getElementById('admin-mod-panel').style.display = 'block';
    } else {
      document.getElementById('admin-mod-panel').style.display = 'none';
    }
  });

  this.socket.on('user-renamed', (data) => {
    if (data.channelCode === this.currentChannel) {
      this._appendSystemMessage(t('header.messages.user_renamed', { oldName: data.oldName, newName: data.newName }));
    }
  });

  // Update DM sidebar names when a user renames
  this.socket.on('dm-name-updated', (data) => {
    if (!data || !data.userId || !data.newName) return;
    let needsRender = false;
    for (const ch of this.channels) {
      if (ch.is_dm && ch.dm_target && ch.dm_target.id === data.userId) {
        ch.dm_target.username = data.newName;
        needsRender = true;
      }
    }
    if (needsRender) {
      this._renderChannels(this.channels);
      // Update channel header if currently viewing a DM with this user
      const curCh = this.channels.find(c => c.code === this.currentChannel);
      if (curCh && curCh.is_dm && curCh.dm_target && curCh.dm_target.id === data.userId) {
        const headerName = document.querySelector('.channel-info h3');
        if (headerName) headerName.textContent = `@ ${this._getNickname(data.userId, data.newName)}`;
      }
    }
  });

  // ── Message edit / delete ──────────────────────────
  this.socket.on('message-edited', async (data) => {    if (data.channelCode === this.currentChannel || data.channelCode === this._activeDMPip) {
      const msgEls = document.querySelectorAll(`[data-msg-id="${data.messageId}"]`);
      if (!msgEls.length) return;
      // E2E: decrypt once if needed (same content for both copies)
      let displayContent = data.content;
      if (HavenE2E.isEncrypted(data.content)) {
        const partner = this._getE2EPartnerFor(data.channelCode);
        if (partner) {
          try {
            const plain = await this.e2e.decrypt(data.content, partner.userId, partner.publicKeyJwk);
            if (plain !== null) displayContent = plain;
            else displayContent = t('header.messages.decrypt_failed');
          } catch { displayContent = t('header.messages.decrypt_failed'); }
        } else {
          displayContent = t('header.messages.decrypt_failed');
        }
      }
      msgEls.forEach((msgEl) => {
        const contentEl = msgEl.querySelector('.message-content, .thread-msg-content');
        if (!contentEl) return;
        contentEl.innerHTML = this._formatContent(displayContent);
        msgEl.dataset.rawContent = displayContent;
        let editedTag = msgEl.querySelector('.edited-tag');
        if (!editedTag) {
          editedTag = document.createElement('span');
          editedTag.className = 'edited-tag';
          editedTag.title = t('header.messages.edited_at', { date: new Date(data.editedAt).toLocaleString() });
          editedTag.textContent = t('header.messages.edited');
          contentEl.appendChild(editedTag);
        }
      });
    }
  });

  // ── Bulk purge: admin replaced all of a user's messages with placeholder text ──
  this.socket.on('user-messages-purged', (data) => {
    if (!data || !data.channelCode) return;
    const placeholder = data.placeholder || 'User banned.';
    if (data.channelCode === this.currentChannel) {
      const userMsgs = document.querySelectorAll(`[data-user-id="${data.userId}"]`);
      userMsgs.forEach(msgEl => {
        const contentEl = msgEl.querySelector('.message-content, .thread-msg-content');
        if (contentEl) {
          try { contentEl.innerHTML = this._formatContent(placeholder); }
          catch { contentEl.textContent = placeholder; }
        }
        msgEl.dataset.rawContent = placeholder;
      });
    }
  });

  this.socket.on('message-deleted', (data) => {
    if (data.channelCode === this.currentChannel || data.channelCode === this._activeDMPip) {
      const msgEls = document.querySelectorAll(`[data-msg-id="${data.messageId}"]`);
      msgEls.forEach((msgEl) => {
        const next = msgEl.nextElementSibling;
        if (next && next.classList.contains('message-compact')) {
          try { this._promoteCompactToFull(next); } catch (e) { /* don't let promotion failure block removal */ }
        }
        msgEl.remove();
      });
    }
  });

  // ── Bot soundboard trigger ───────────────────────
  this.socket.on('play-sound', (data) => {
    if (data.channelCode === this.currentChannel && data.soundUrl) {
      this._playSoundFile(data.soundUrl);
    }
  });

  // ── Messages moved (source channel) ──────────────
  this.socket.on('messages-moved', (data) => {
    if (data.channelCode === this.currentChannel) {
      for (const id of data.messageIds) {
        const msgEl = document.querySelector(`[data-msg-id="${id}"]`);
        if (msgEl) {
          const next = msgEl.nextElementSibling;
          if (next && next.classList.contains('message-compact')) {
            try { this._promoteCompactToFull(next); } catch {}
          }
          msgEl.remove();
        }
      }
    }
  });

  // ── Messages received (destination channel) ──────
  this.socket.on('messages-received', (data) => {
    if (data.channelCode === this.currentChannel) {
      // Reload the channel to show the moved messages in correct order
      this.socket.emit('join-channel', { code: this.currentChannel }, () => {});
    }
  });

  // ── Pin / Unpin ──────────────────────────────────
  this.socket.on('message-pinned', (data) => {
    if (data.channelCode === this.currentChannel) {
      const msgEl = document.querySelector(`#messages [data-msg-id="${data.messageId}"]`);
      if (msgEl) {
        msgEl.classList.add('pinned');
        msgEl.dataset.pinned = '1';
        // Add pin tag to header
        const header = msgEl.querySelector('.message-header');
        if (header && !header.querySelector('.pinned-tag')) {
          header.insertAdjacentHTML('beforeend', '<span class="pinned-tag" title="Pinned message">📌</span>');
        }
        // Update toolbar: swap pin → unpin
        const pinBtn = msgEl.querySelector('[data-action="pin"]');
        if (pinBtn) { pinBtn.dataset.action = 'unpin'; pinBtn.title = 'Unpin'; }
      }
      this._appendSystemMessage(`📌 ${t('header.messages.pinned_by', { name: data.pinnedBy })}`);
      this._markPinUnread?.(data.messageId);
      this._bumpPinIndicator?.(1);

      // If the Pins PiP is open, silently re-fetch the updated pin list so the
      // new pin appears without requiring the user to reopen anything.
      const pinsPipPanel = document.getElementById('pins-pip-panel');
      if (pinsPipPanel && pinsPipPanel.style.display !== 'none' && this._pinsPipChannelCode === this.currentChannel) {
        this._pinsPipSilentRefresh = true;
        this.socket.emit('get-pinned-messages', { code: this.currentChannel });
      }
    }
  });

  this.socket.on('message-unpinned', (data) => {
    if (data.channelCode === this.currentChannel) {
      const msgEl = document.querySelector(`#messages [data-msg-id="${data.messageId}"]`);
      if (msgEl) {
        msgEl.classList.remove('pinned');
        delete msgEl.dataset.pinned;
        const tag = msgEl.querySelector('.pinned-tag');
        if (tag) tag.remove();
        // Update toolbar: swap unpin → pin
        const unpinBtn = msgEl.querySelector('[data-action="unpin"]');
        if (unpinBtn) { unpinBtn.dataset.action = 'pin'; unpinBtn.title = 'Pin'; }
      }
      // Remove from pinned sidebar panel if it's open
      const pinnedItem = document.querySelector(`#pinned-panel .pinned-item[data-msg-id="${data.messageId}"]`);
      if (pinnedItem) {
        pinnedItem.remove();
        const count = document.getElementById('pinned-count');
        const remaining = document.querySelectorAll('#pinned-list .pinned-item').length;
        count.textContent = `📌 ${t(remaining !== 1 ? 'pinned_panel.count_other' : 'pinned_panel.count_one', { count: remaining })}`;
        if (remaining === 0) {
          document.getElementById('pinned-list').innerHTML = `<p class="muted-text" style="padding:12px">${t('pinned_panel.no_messages')}</p>`;
        }
      }
      // Remove from Pins PiP if it's open — same DOM surgery, no re-fetch needed
      const pipItem = document.querySelector(`#pins-pip-list .pinned-item[data-msg-id="${data.messageId}"]`);
      if (pipItem) {
        pipItem.remove();
        const pipList = document.getElementById('pins-pip-list');
        if (pipList && !pipList.querySelector('.pinned-item')) {
          pipList.innerHTML = `<p class="muted-text" style="padding:12px">${t('pinned_panel.no_messages')}</p>`;
        }
      }
      // Keep the cached _lastPins in sync so a subsequent pop-out isn't stale
      if (this._lastPins) {
        this._lastPins = this._lastPins.filter(p => p.id !== data.messageId);
      }
      this._appendSystemMessage(`📌 ${t('header.messages.message_unpinned')}`);
      this._bumpPinIndicator?.(-1);
    }
  });

  this.socket.on('pinned-messages', async (data) => {
    if (data.channelCode === this.currentChannel) {
      // Decrypt E2E-encrypted pinned messages in DMs before rendering
      if (data.pins && data.pins.length) {
        await this._decryptMessages(data.pins, data.channelCode);
      }
      this._renderPinnedPanel(data.pins);
      // The user just opened the pinned panel and saw everything in it —
      // mark all current pin ids as seen so the unread dot clears.
      this._markPinsSeen?.(data.pins || []);
    }
  });

  // ── Channel Media Gallery (#5350) ──
  this.socket.on('channel-media', (data) => {
    if (!data || data.channelCode !== this.currentChannel) return;
    this._renderMediaGallery?.(data);
  });

  this.socket.on('message-archived', (data) => {
    if (data.channelCode === this.currentChannel) {
      const msgEl = document.querySelector(`[data-msg-id="${data.messageId}"]`);
      if (msgEl) {
        msgEl.classList.add('archived');
        msgEl.dataset.archived = '1';
        const header = msgEl.querySelector('.message-header');
        if (header && !header.querySelector('.archived-tag')) {
          header.insertAdjacentHTML('beforeend', '<span class="archived-tag" title="Protected from cleanup">🛡️</span>');
        }
        // For compact messages, add tag to content
        const content = msgEl.querySelector('.message-content');
        if (msgEl.classList.contains('message-compact') && content && !content.querySelector('.archived-tag')) {
          content.insertAdjacentHTML('afterbegin', '<span class="archived-tag" title="Protected from cleanup">🛡️</span>');
        }
        // Update toolbar: swap archive → unarchive
        const archBtn = msgEl.querySelector('[data-action="archive"]');
        if (archBtn) { archBtn.dataset.action = 'unarchive'; archBtn.title = 'Unprotect'; }
      }
      this._appendSystemMessage(`🛡️ ${t('header.messages.protected_by', { name: data.archivedBy })}`);
    }
  });

  this.socket.on('message-unarchived', (data) => {
    if (data.channelCode === this.currentChannel) {
      const msgEl = document.querySelector(`[data-msg-id="${data.messageId}"]`);
      if (msgEl) {
        msgEl.classList.remove('archived');
        delete msgEl.dataset.archived;
        const tag = msgEl.querySelector('.archived-tag');
        if (tag) tag.remove();
        // Also remove from compact message content
        const contentTag = msgEl.querySelector('.message-content .archived-tag');
        if (contentTag) contentTag.remove();
        // Update toolbar: swap unarchive → archive
        const unarchBtn = msgEl.querySelector('[data-action="unarchive"]');
        if (unarchBtn) { unarchBtn.dataset.action = 'archive'; unarchBtn.title = 'Protect from cleanup'; }
      }
      this._appendSystemMessage(`🛡️ ${t('header.messages.message_unprotected')}`);
    }
  });

  // ── Admin moderation events ────────────────────────
  this.socket.on('kicked', (data) => {
    this._showToast(data.reason ? t('toasts.kicked_from_server_reason', { reason: data.reason }) : t('toasts.kicked_from_server'), 'error');
    if (this.currentChannel === data.channelCode) {
      this.currentChannel = null;
      this._showWelcome();
    }
  });

  this.socket.on('banned', (data) => {
    this._showToast(data.reason ? t('toasts.banned_from_server_reason', { reason: data.reason }) : t('toasts.banned_from_server'), 'error');
    setTimeout(() => {
      localStorage.removeItem('haven_token');
      localStorage.removeItem('haven_user');
      window.location.href = '/';
    }, 3000);
  });

  this.socket.on('muted', (data) => {
    this._showToast(data.reason ? t('toasts.muted_reason', { duration: data.duration, reason: data.reason }) : t('toasts.muted', { duration: data.duration }), 'error');
  });

  this.socket.on('ban-list', (data) => {
    this._renderBanList(data);
  });

  this.socket.on('ip-ban-list', (data) => {
    this._renderIpBanList(data);
  });

  this.socket.on('deleted-users-list', (data) => {
    this._renderDeletedUsersList(data);
  });

  this.socket.on('user-deleted', (data) => {
    // Remove from cached members list so the popup updates without a full refresh
    if (this._allMembersData) {
      this._allMembersData = this._allMembersData.filter(m => m.id !== data.userId);
      this._filterAllMembers();
    }
  });

  // ── Server settings ────────────────────────────────
  this.socket.on('server-settings', (settings) => {
    this.serverSettings = settings;
    this._applyServerSettings();
    this._maybeShowSetupWizard();
  });

  this.socket.on('server-setting-changed', (data) => {
    this.serverSettings[data.key] = data.value;
    this._applyServerSettings();
  });

  // ── Webhooks list ──────────────────────────────────
  this.socket.on('webhooks-list', (data) => {
    this._renderWebhooksList(data.webhooks || []);
    // Also update bot modal sidebar if open
    if (document.getElementById('bot-modal')?.style.display === 'flex') {
      this._renderBotSidebar(data.webhooks || []);
      // Re-show detail panel if a bot was selected
      if (this._selectedBotId) {
        const stillExists = (data.webhooks || []).find(w => w.id === this._selectedBotId);
        if (stillExists) this._showBotDetail(this._selectedBotId);
        else {
          this._selectedBotId = null;
          document.getElementById('bot-detail-panel').innerHTML = `<p class="muted-text" style="padding:20px;text-align:center">${t('settings.admin.bots_select_hint')}</p>`;
        }
      }
    }
  });

  // ── User preferences (persistent theme etc.) ───────
  this.socket.on('preferences', (prefs) => {
    this._userPrefs = prefs || {};
    if (prefs.theme) {
      // User has a saved personal theme preference — apply it
      applyThemeFromServer(prefs.theme);
    } else if (this.serverSettings.default_theme) {
      // No personal preference — apply the server's default theme
      applyThemeFromServer(this.serverSettings.default_theme);
    }
    // Sync hide-own-score toggle to the server's stored value so reopening
    // settings on a fresh device shows the correct state.
    if (prefs.hide_score_badge != null) {
      try { localStorage.setItem('haven_hide_own_score', prefs.hide_score_badge); } catch {}
      const ownToggle = document.getElementById('hide-own-score');
      if (ownToggle) ownToggle.checked = prefs.hide_score_badge === 'true';
    }
  });

  // ── Burn-after-read DM events (#5280) ──────────────
  this.socket.on('message-burning', (data) => {
    if (!data || !data.messageId) return;
    const el = document.querySelector(`#messages [data-msg-id="${data.messageId}"], #dm-pip-messages [data-msg-id="${data.messageId}"]`);
    if (!el) return;
    el.dataset.burnStartedAt = data.burningStartedAt || new Date().toISOString();
    el.dataset.burnSeconds = String(data.burnSeconds || 0);
    // Remove the static "pending" flame label once the countdown is live
    el.querySelector('.burn-pending-label')?.remove();
    this._startBurnCountdown?.(el, data.burnSeconds, el.dataset.burnStartedAt);
  });

  this.socket.on('message-burned', (data) => {
    if (!data || !data.messageId) return;
    document.querySelectorAll(`[data-msg-id="${data.messageId}"]`).forEach(el => {
      this._replaceBurnedMessage?.(el);
    });
  });

  // ── Search results ─────────────────────────────────
  this.socket.on('search-results', (data) => {
    const panel = document.getElementById('search-results-panel');
    const list = document.getElementById('search-results-list');
    const count = document.getElementById('search-results-count');
    if (data.isDM) {
      count.textContent = t('header.search_results_other', { count: 0, query: this._escapeHtml(data.query) });
      list.innerHTML = `<p class="muted-text" style="padding:12px">Search is not available in DMs because messages are end-to-end encrypted.</p>`;
      panel.style.display = 'block';
      return;
    }

    // Build header with active filters
    let filterInfo = '';
    if (data.filters) {
      const tags = [];
      if (data.filters.from) tags.push(`<span class="search-filter-tag">from:${this._escapeHtml(data.filters.from)}</span>`);
      if (data.filters.in) tags.push(`<span class="search-filter-tag">in:#${this._escapeHtml(data.filters.in)}</span>`);
      if (data.filters.has) tags.push(`<span class="search-filter-tag">has:${this._escapeHtml(data.filters.has)}</span>`);
      if (tags.length) filterInfo = `<div class="search-filter-tags">${tags.join(' ')}</div>`;
    }

    count.innerHTML = t(data.results.length === 1 ? 'header.search_results_one' : 'header.search_results_other', { count: data.results.length, query: this._escapeHtml(data.query) }) + filterInfo;

    // Strip filters from query for highlight
    const highlightQuery = data.query.replace(/\b(?:from|in|has):\S+/gi, '').trim();

    list.innerHTML = data.results.length === 0
      ? `<p class="muted-text" style="padding:12px">${t('header.search_no_results')}</p>`
      : data.results.map(r => `
        <div class="search-result-item" data-msg-id="${r.id}">
          <span class="search-result-author" style="color:${this._getUserColor(r.username)}">${this._escapeHtml(this._getNickname(r.user_id, r.username))}</span>
          <span class="search-result-time">${this._formatTime(r.created_at)}</span>
          <div class="search-result-content">${highlightQuery ? this._highlightSearch(this._escapeHtml(r.content), highlightQuery) : this._escapeHtml(r.content)}</div>
        </div>
      `).join('');
    panel.style.display = 'block';

    // Click to scroll to message
    list.querySelectorAll('.search-result-item').forEach(item => {
      item.addEventListener('click', () => {
        const msgId = parseInt(item.dataset.msgId, 10);
        // Close the search panel so the user can see the result
        panel.style.display = 'none';
        document.getElementById('search-container').style.display = 'none';
        document.getElementById('search-input').value = '';
        this._jumpToMessage(msgId);
      });
    });
  });

  // ── High Scores ──────────────────────────────────
  this.socket.on('high-scores', (data) => {
    this.highScores[data.game] = data.leaderboard;
    // Re-render online users to update score badges
    if (this._lastOnlineUsers) {
      this._renderOnlineUsers(this._lastOnlineUsers);
    }
    // Relay to game window or iframe if open
    try { if (this._gameWindow && !this._gameWindow.closed) this._gameWindow.postMessage({ type: 'leaderboard-data', leaderboard: data.leaderboard }, window.location.origin); } catch {}
    try { if (this._gameIframe) this._gameIframe.contentWindow?.postMessage({ type: 'leaderboard-data', leaderboard: data.leaderboard }, window.location.origin); } catch {}
  });

  this.socket.on('new-high-score', (data) => {
    const gameName = this._gamesRegistry?.find(g => g.id === data.game)?.name || data.game;
    this._showToast(`🏆 ${t('toasts.record_set', { user: this._getNickname(data.user_id, data.username), game: gameName, score: data.score })}`, 'success');
  });

  // ── Voice roster watchdog ───────────────────────────────────────────
  // The user has repeatedly reported that after a while in voice on the
  // desktop client, they vanish from BOTH the right voice panel and the
  // left sidebar voice indicator while peers still see them (and audio
  // often still works). Every prior fix relied on the server pushing a
  // fresh `voice-users-update` to trigger the self-heal in that handler,
  // but if no one else mutes/joins/leaves nothing arrives and the bad
  // state sticks until the user manually leaves and rejoins.
  //
  // This watchdog runs every 10 s while we're in voice and the socket
  // is connected. It actively pulls a fresh roster from the server
  // (`request-voice-users`), which causes the server to emit a private
  // `voice-users-update` back to us. The existing self-heal in that
  // handler (file `app-socket.js`, search "Self-heal") will then detect
  // we're missing and emit `voice-rejoin` to rebind our voice slot.
  //
  // The interval is also a no-op when we're NOT in voice, so it costs
  // one tiny socket emit every 10 s in the worst case.
  if (!this._voiceRosterWatchdog) {
    this._voiceRosterWatchdog = setInterval(() => {
      try {
        if (!this.socket?.connected) return;
        if (!this.voice || !this.voice.inVoice) return;
        const code = this.voice.currentChannel;
        if (!code || !/^[a-f0-9]{8}$/i.test(code)) return;
        // Check what we last rendered. If we already know we're missing,
        // log loudly so it's easy to spot in DevTools when the glitch hits.
        const myId = this.user && this.user.id;
        const lastUsers = Array.isArray(this._lastVoiceUsers) ? this._lastVoiceUsers : [];
        const selfPresentLocally = myId && lastUsers.some(u => u && u.id === myId);
        if (myId && !selfPresentLocally) {
          console.warn('[VoiceWatchdog] Self ABSENT from local roster while inVoice — polling server', {
            channel: code,
            inVoice: this.voice.inVoice,
            socketConnected: !!this.socket?.connected,
            lastUserCount: lastUsers.length
          });
        } else {
          // Quiet trace, useful when the user grabs a console dump after a glitch.
          if (window.HAVEN_DEBUG_VOICE) {
            console.debug('[VoiceWatchdog] tick', { channel: code, lastUserCount: lastUsers.length });
          }
        }
        this.socket.emit('request-voice-users', { code, iAmInVoice: true });
      } catch (e) {
        console.warn('[VoiceWatchdog] tick failed:', e);
      }
    }, 10000);
  }
},

// ── Force a full socket resync ────────────────────────
// Cycles the socket and lets the existing 'connect' handler do the full
// re-fetch (enter-channel, get-messages, get-channel-members,
// request-voice-users). Used by the wake-from-sleep detector and the
// window-focus zombie probe. Debounced via _lastForcedResync so multiple
// triggers within a few seconds collapse to one cycle.
_forceFullResync(reason) {
  const now = Date.now();
  if (now - (this._lastForcedResync || 0) < 3000) return;
  this._lastForcedResync = now;
  console.log(`[force-resync] reason=${reason}, socket.connected=${!!this.socket?.connected}`);
  if (!this.socket) return;
  try { this.socket.disconnect(); } catch {}
  try { this.socket.connect(); } catch {}
  // Defensive: if for some reason 'connect' doesn't fire within 6 s,
  // emit the resync requests anyway against the current socket so the
  // user at least gets channel data refreshed. (The connect handler is
  // the authoritative path — this is purely a belt-and-braces.)
  setTimeout(() => {
    if (this.socket?.connected && this.currentChannel) {
      // Only do this if connect handler didn't already run very recently.
      const sinceConnect = Date.now() - (this._lastConnectTime || 0);
      if (sinceConnect > 5000) {
        try { this.socket.emit('enter-channel', { code: this.currentChannel }); } catch {}
        try { this.socket.emit('get-messages', { code: this.currentChannel }); } catch {}
        try { this.socket.emit('get-channel-members', { code: this.currentChannel }); } catch {}
        try { this.socket.emit('request-online-users', { code: this.currentChannel }); } catch {}
        try { this.socket.emit('request-voice-users', { code: this.currentChannel }); } catch {}
      }
    }
  }, 6000);
},

};
