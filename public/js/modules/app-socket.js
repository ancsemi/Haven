// The socket connection: setting up every listener (_setupSocketListeners
// calls each area's _listen method in turn), connecting, reconnecting and
// waking from sleep, and keeping channel codes in step when they rotate.

export default {

_migrateChannelCodeState(oldCode, newCode) {
  if (!oldCode || !newCode || oldCode === newCode) return;
  const migrateObjectKey = store => {
    if (!store || !Object.prototype.hasOwnProperty.call(store, oldCode)) return false;
    store[newCode] = store[oldCode];
    delete store[oldCode];
    return true;
  };
  migrateObjectKey(this.unreadCounts);
  migrateObjectKey(this.voiceCounts);
  migrateObjectKey(this.voiceChannelUsers);
  migrateObjectKey(this._pinnedCountByChannel);
  migrateObjectKey(this._unreadPinIdByChannel);
  if (migrateObjectKey(this._threadMentions)) this._persistThreadMentions?.();

  for (const property of [
    'currentChannel',
    '_lastVoiceUsersChannel',
    '_pendingChannelHistoryCode',
    '_pinsPipChannelCode',
    '_organizeParentCode'
  ]) {
    if (this[property] === oldCode) this[property] = newCode;
  }
  if (this.voice?.currentChannel === oldCode) this.voice.currentChannel = newCode;
  if (this.voice?._softLeftChannel === oldCode) this.voice._softLeftChannel = newCode;
  if (this.voice?._joiningChannelCode === oldCode) this.voice._joiningChannelCode = newCode;
  for (const channel of this.channels || []) {
    if (channel.afk_sub_code === oldCode) channel.afk_sub_code = newCode;
  }
  const createSubModal = document.getElementById('create-sub-modal');
  if (createSubModal?._parentCode === oldCode) createSubModal._parentCode = newCode;

  try {
    if (localStorage.getItem('haven_voice_channel') === oldCode) {
      localStorage.setItem('haven_voice_channel', newCode);
    }
  } catch { /* storage blocked: the saved voice channel keeps the old code and simply will not auto-rejoin */ }
  for (const key of ['haven_muted_channels', 'haven_hidden_channels']) {
    try {
      const values = JSON.parse(localStorage.getItem(key) || '[]');
      if (!Array.isArray(values) || !values.includes(oldCode)) continue;
      const migrated = values.map(code => code === oldCode ? newCode : code);
      localStorage.setItem(key, JSON.stringify([...new Set(migrated)]));
    } catch { /* storage blocked or corrupt list: this preference keeps the old code */ }
  }
  try {
    const moveStorageKey = (oldKey, newKey) => {
      const value = localStorage.getItem(oldKey);
      if (value === null) return;
      localStorage.setItem(newKey, value);
      localStorage.removeItem(oldKey);
    };
    for (const prefix of [
      'haven_seen_pin_max_',
      'haven_tag_sorts_',
      'haven_cat_order_',
      'haven_cat_sort_',
      'haven_subs_collapsed_'
    ]) moveStorageKey(`${prefix}${oldCode}`, `${prefix}${newCode}`);

    const subtagPrefix = `haven_subtag_collapsed_${oldCode}_`;
    const subtagKeys = [];
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (key?.startsWith(subtagPrefix)) subtagKeys.push(key);
    }
    for (const key of subtagKeys) {
      moveStorageKey(key, `haven_subtag_collapsed_${newCode}_${key.slice(subtagPrefix.length)}`);
    }
  } catch { /* localStorage may be unavailable */ }
},

_collectChannelCodeRotations(channels) {
  const rotations = new Map();
  const persistedCodes = this._readChannelCodeMap();
  for (const channel of channels) {
    const oldCode = persistedCodes[channel.id];
    if (typeof oldCode === 'string' && oldCode !== channel.code) {
      rotations.set(oldCode, { channelId: channel.id, oldCode, newCode: channel.code });
    }
  }
  for (const previous of this.channels || []) {
    const updated = channels.find(channel => channel.id === previous.id);
    if (updated && updated.code !== previous.code) {
      rotations.set(previous.code, {
        channelId: previous.id,
        oldCode: previous.code,
        newCode: updated.code
      });
    }
  }
  return [...rotations.values()];
},

_readChannelCodeMap() {
  const ownerId = this.user?.id;
  if (ownerId == null) return {};
  try {
    const persisted = JSON.parse(localStorage.getItem('haven_channel_codes_by_id') || 'null');
    if (String(persisted?.ownerId) !== String(ownerId) || !persisted?.codes || typeof persisted.codes !== 'object' || Array.isArray(persisted.codes)) {
      return {};
    }
    return persisted.codes;
  } catch {
    return {};
  }
},

_persistChannelCodeMap(channels) {
  const ownerId = this.user?.id;
  if (ownerId == null) return;
  const codes = {};
  for (const channel of channels || []) {
    if (channel?.id != null && channel.code) codes[channel.id] = channel.code;
  }
  try {
    localStorage.setItem('haven_channel_codes_by_id', JSON.stringify({
      ownerId: String(ownerId),
      codes
    }));
  } catch { /* localStorage may be unavailable */ }
},

_updatePersistedChannelCode(channelId, code) {
  if (channelId == null || !code) return;
  const codes = this._readChannelCodeMap();
  codes[channelId] = code;
  this._persistChannelCodeMap(Object.entries(codes).map(([id, channelCode]) => ({
    id,
    code: channelCode
  })));
},

_clearChannelCodeMap() {
  try {
    localStorage.removeItem('haven_channel_codes_by_id');
  } catch { /* localStorage may be unavailable */ }
},

// ── Socket Event Listeners ────────────────────────────

// A message refused for being too long used to vanish: the box clears on
// send. Put the text back so it can be trimmed, unless something new has
// been typed since or the channel changed (#5691).
_restoreRefusedDraft(msg) {
  const d = this._lastSendDraft;
  if (!d || typeof msg !== 'string' || !/^Message too long/.test(msg)) return;
  this._lastSendDraft = null;
  const inputId = d.inputId || 'message-input';
  const open = inputId === 'dm-pip-input' ? this._activeDMPip
    : inputId === 'thread-input' ? this._activeThreadParent
    : this.currentChannel;
  if (Date.now() - d.at > 15000 || d.code !== open) return;
  const input = document.getElementById(inputId);
  if (!input || input.value.trim()) return;
  input.value = d.text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.focus();
},

_setupSocketListeners() {
  // Each area wires its own part, in this order.
  this._listenSession();
  this._listenChannelsAndMessages();
  this._listenPresenceAndVoice();
  this._listenFeatureEvents();
  this._listenMessageChanges();
  this._listenAdminAndPrefs();
},

_listenSession() {
  this._setupFerrySocket();
  this._setupCallListeners?.();
  // Authoritative user info pushed by server on every connect
  this.socket.on('session-info', (data) => {
    this.user = { ...this.user, ...data };
    this.user.roles = data.roles || [];
    this.user.effectiveLevel = data.effectiveLevel || 0;
    this.user.permissions = data.permissions || [];
    this.user.globalPermissions = data.globalPermissions || [];
    this._renderE2EPassphraseSection?.();
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
    // Sync border (pfp overlay) from server, authoritative like avatar shape
    if (data.border !== undefined) {
      this.user.border = data.border || null;
    }
    // Sync the border fit (op log) so the editor restores it and pfps render it
    if (data.borderTransform !== undefined) {
      this.user.borderTransform = Array.isArray(data.borderTransform) ? data.borderTransform : null;
    }
    // Sync the animation policy (trigger/disabled) so the editor seeds it and pfps honor it
    if (data.animateProfile !== undefined) {
      this.user.animateProfile = data.animateProfile === 'disabled' ? 'disabled' : 'trigger';
    }
    localStorage.setItem('haven_user', JSON.stringify(this.user));
    // (#5394) Server-stored nicknames are the record. localStorage is only a
    // cache for the first paint before this event lands. The old merge also
    // pushed any localStorage-only nickname back up on every connect, so a
    // nickname cleared from one device came back from any other device that
    // still had it cached, and could never be removed for good. (#5560)
    if (data.nicknames && typeof data.nicknames === 'object') {
      this._nicknames = { ...data.nicknames };
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
    this._updateBorderPreview();
    // Show admin/mod controls based on role level
    const canModerate = this.user.isAdmin || this.user.effectiveLevel >= 25;
    const canCreateChannel = this.user.isAdmin || this._hasGlobalPerm('create_channel');
    document.getElementById('admin-controls').style.display = canCreateChannel ? 'block' : 'none';
    document.getElementById('admin-mod-panel').style.display = (canModerate || this._hasAnyAdminSettingsAccess()) ? 'block' : 'none';
    document.getElementById('sidebar-members-btn').style.display = (this.user.isAdmin || canModerate || this._hasPerm('view_all_members') || this._hasPerm('view_channel_members')) ? '' : 'none';
  });

  // Roles updated (from admin assigning/revoking, or editing a role we hold)
  this.socket.on('roles-updated', (data) => {
    this._refreshMentionableRoles?.();
    // The server also fires this with NO payload as a plain "the server's role
    // list changed" nudge (role edited, roles reset, admin role display
    // changed) for anyone with the Role Management modal open. There's no
    // per-user permission set to apply then. Bail instead of throwing on
    // `data.roles` — that TypeError also aborted every roles-updated listener
    // registered after this one, including the modal's own _loadRoles refresh.
    if (!data) return;
    // Your own roles/permissions just changed — cached search results may now
    // include messages you can no longer access. Force-invalidate the panel
    // (the channel list may be unchanged, so the signature check won't catch
    // this). Payload-less server-wide nudges bail above and don't trigger it.
    this._searchMarkStale?.();
    this.user.roles = data.roles || [];
    this.user.effectiveLevel = data.effectiveLevel || 0;
    this.user.permissions = data.permissions || [];
    this.user.globalPermissions = data.globalPermissions || [];
    localStorage.setItem('haven_user', JSON.stringify(this.user));
    // Refresh UI to reflect new permissions
    const canModerate = this.user.isAdmin || this.user.effectiveLevel >= 25;
    const canCreateChannel = this.user.isAdmin || this._hasGlobalPerm('create_channel');
    const canCreateInvites = this.user.isAdmin || this._hasGlobalPerm('manage_server') || this._hasGlobalPerm('invite_users');
    document.getElementById('admin-controls').style.display = canCreateChannel ? 'block' : 'none';
    document.getElementById('admin-mod-panel').style.display = (canModerate || this._hasAnyAdminSettingsAccess()) ? 'block' : 'none';
    document.getElementById('sidebar-members-btn').style.display = (this.user.isAdmin || canModerate || this._hasPerm('view_all_members') || this._hasPerm('view_channel_members')) ? '' : 'none';
    document.getElementById('sidebar-invite-panel').style.display = canCreateInvites ? 'block' : 'none';
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
    document.getElementById('status-server-text').textContent = t('app.status.connected');
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
    if (this._savedVoiceRejoinTimer) {
      clearTimeout(this._savedVoiceRejoinTimer);
      this._savedVoiceRejoinTimer = null;
    }
    // A reconnect usually means the machine slept or the network dropped, which
    // is the most likely moment for the media token to have expired underneath
    // us. Cheap to redo and it keeps remote images from silently breaking.
    this._refreshMediaToken?.();

    // Re-join channel after reconnect (server lost our room membership)
    this.socket.emit('visibility-change', { visible: !document.hidden });
    this.voice?.deferChannelGone?.(6000);
    this.socket.emit('get-channels');
    this.socket.emit('get-server-settings');
    // Role names for @Role mentions: rendering and the @ picker. (#5579)
    this._refreshMentionableRoles?.();

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
          this._clearChannelCodeMap();
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
      // Request fresh voice list for the channel currently in view.
      this.socket.emit('request-voice-users', {
        code: this.currentChannel,
        iAmInVoice: !!(this.voice && this.voice.inVoice && this.voice.currentChannel === this.currentChannel)
      });
    }
    // Re-join voice if we were in voice before reconnect
    if (this.voice && this.voice.inVoice && this.voice.currentChannel) {
      this.socket.emit('voice-rejoin', { code: this.voice.currentChannel, ...this.voice.getRelayClientInfo() });
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
          this._savedVoiceRejoinTimer = setTimeout(async () => {
            this._savedVoiceRejoinTimer = null;
            if (this.voice && !this.voice.inVoice) {
              let currentSavedChannel = savedVoiceChannel;
              try { currentSavedChannel = localStorage.getItem('haven_voice_channel') || savedVoiceChannel; } catch { /* storage blocked (private mode): keep the default */ }
              console.log('[Voice] Auto-rejoining saved voice channel:', currentSavedChannel);
              const ok = await this.voice.join(currentSavedChannel);
              if (ok) {
                this._updateVoiceButtons(true);
                this._updateVoiceStatus(true);
                this._updateVoiceBar();
              }
            }
          }, 1500);
        }
      } catch (err) { console.warn('[Voice] auto-rejoin check failed', err); }
    }
    // Apply any queued status change from when we were disconnected
    if (this._pendingStatus) {
      this.socket.emit('set-status', this._pendingStatus);
      this._pendingStatus = null;
    }
    // Ask the server whether to surface the recovery-codes notice. It decides:
    // skipped when the account already has recovery codes, or the user ticked
    // "never show again" (both checked server-side). Reply is handled by the
    // 'recovery-notice-state' listener registered in _setupSocketListeners.
    this.socket.emit('get-recovery-notice-state');
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
      // (#5463) Mark the current wake-detector window as tainted — see the
      // background-throttling note on _wakeCheckInterval below.
      this._tabHiddenSinceWakeCheck = true;
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
      //
      // (#5444) Never do that while a live voice session is running,
      // though. Cycling the socket makes the server grace-evict the voice
      // slot and re-add it a moment later, which is heard by everyone in
      // the call as a leave sound followed by a join sound — for nothing
      // more than the user tabbing away for half a minute and coming
      // back. In that case fall through to the in-place refresh below.
      const voiceLive = !!(this.voice && this.voice.inVoice &&
        ((this.voice.liveVoicePeerCount?.() || 0) > 0 || this.voice.localStream));
      if (hiddenForMs > 30000 && this.socket && !voiceLive) {
        try { this.socket.disconnect(); } catch (err) { console.warn('[Socket] disconnect before reconnect failed', err); }
        try { this.socket.connect(); } catch (err) { console.warn('[Socket] reconnect failed', err); }
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
        this.socket.emit('request-voice-users', {
          code: this.currentChannel,
          iAmInVoice: !!(this.voice && this.voice.inVoice && this.voice.currentChannel === this.currentChannel)
        });
      }
      // (#5444) We deliberately kept the socket alive above if voice was
      // live, so rebind the voice slot here instead. This is a no-op on
      // the server when we're already bound on this socket.
      if (voiceLive && this.voice?.currentChannel && this.socket?.connected) {
        this.socket.emit('voice-rejoin', { code: this.voice.currentChannel, ...this.voice.getRelayClientInfo() });
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
      } catch (err) { console.warn('[Voice] auto-rejoin check failed', err); }
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
  //
  // (#5463 / #5444) BUT: timer drift is ALSO what a backgrounded tab looks
  // like. Once a tab has been hidden and silent for ~5 minutes, Chromium
  // applies "intensive throttling" and fires setInterval at most once per
  // MINUTE. That produced a 60 s drift on every tick, which tripped this
  // detector, which hard-cycled the socket, which grace-evicted the user
  // from voice on the server — a self-inflicted disconnect/reconnect loop
  // running exactly every 60 seconds, forever, for as long as the tab sat
  // in the background. It only ever hit web users because Haven Desktop
  // sets `backgroundThrottling: false` on its windows, and it only ever
  // hit idle tabs because a foreground tab is never throttled.
  //
  // So: only trust drift while the tab is actually visible. A hidden tab
  // has its own recovery path already — the visibilitychange handler above
  // forces a full resync when it comes back after >30 s hidden — and a
  // socket that genuinely died while hidden is handled by socket.io's own
  // reconnection. The PC-lock case this detector exists for is unaffected,
  // because Win+L does NOT mark the page hidden.
  this._lastWakeCheck = Date.now();
  this._tabHiddenSinceWakeCheck = document.hidden;
  if (this._wakeCheckInterval) clearInterval(this._wakeCheckInterval);
  this._wakeCheckInterval = setInterval(() => {
    const now = Date.now();
    const drift = now - this._lastWakeCheck;
    this._lastWakeCheck = now;
    // Discard any interval that the tab spent hidden for even part of its
    // length — the drift is throttling, not a suspend, and we can't tell
    // the two apart from the timestamp alone.
    const wasHidden = document.hidden || this._tabHiddenSinceWakeCheck;
    this._tabHiddenSinceWakeCheck = document.hidden;
    if (wasHidden) return;
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
  //
  // CRITICAL: title-bar drag / double-click maximize also fires `focus`,
  // often during a multi-second main-thread stall while the stream video
  // element relayouts. A single missed pong used to hard-cycle the socket
  // (`focus-zombie`), which is exactly the "first resize drops me from
  // voice roster but I can still talk" bug — server grace-evicts the old
  // socketId, UI flips to Join Voice, WebRTC peers keep carrying audio.
  window.addEventListener('resize', () => {
    this._recentWindowResizeAt = Date.now();
  });
  window.addEventListener('focus', () => {
    const sinceLastResync = Date.now() - (this._lastForcedResync || 0);
    if (sinceLastResync < 5000) return;
    // Ignore focus storms that accompany a window resize/maximize.
    if (this._recentWindowResizeAt && (Date.now() - this._recentWindowResizeAt) < 2500) {
      return;
    }
    // Cheap liveness probe: emit a ping-check and force-resync if no pong
    // arrives. Avoids needlessly cycling the socket on a quick window-switch
    // where the connection is actually fine.
    if (!this.socket?.connected) {
      this._forceFullResync('focus-disconnected');
      return;
    }
    // In an active voice session, never hard-disconnect on one missed pong.
    // Stream decode + layout on maximize routinely blocks the renderer long
    // enough for a 4s timer to fire even though the socket is healthy.
    const voiceLive = !!(this.voice && (this.voice.inVoice || this.voice.liveVoicePeerCount?.() > 0));
    const probeStart = Date.now();
    let acked = false;
    const ackHandler = () => { acked = true; };
    this.socket.once('pong-check', ackHandler);
    // Route through _pingSend so this probe's send time is queued too. It is a
    // real round trip and should show up as one; emitting 'ping-check' directly
    // here is what desynced the queue-less reading.
    try { this._pingSend(); } catch { /* a ping that never goes out shows up as a missed reading below */ }
    const probeMs = voiceLive ? 10000 : 6000;
    setTimeout(() => {
      this.socket?.off('pong-check', ackHandler);
      if (acked) return;
      if (voiceLive) {
        // Light recovery only — rebind voice + refresh rosters. Do NOT
        // disconnect; that is what knocks us out of the server voice map
        // while leaving WebRTC audio running.
        console.warn(`[wake-detect] no pong in ${probeMs}ms on focus while in voice (probe ${Date.now()-probeStart}ms) — light resync, not disconnect`);
        this._lightVoiceResync('focus-zombie-in-voice');
        return;
      }
      console.log(`[wake-detect] no pong in ${probeMs}ms on focus (probe ${Date.now()-probeStart}ms), zombie socket — forcing resync`);
      this._forceFullResync('focus-zombie');
    }, probeMs);
  });

  this.socket.on('disconnect', () => {
    this._setLed('connection-led', 'danger pulse');
    this._setLed('status-server-led', 'danger pulse');
    document.getElementById('status-server-text').textContent = t('app.status.disconnected');
    document.getElementById('status-ping').textContent = '--';
    // Drop outstanding probes — pairing one with a pong from after the
    // reconnect would report the length of the outage as latency.
    this._pingQueue = [];
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
    //
    // If WebRTC peers are still connected, NEVER soft-leave — that destroys
    // working audio/streams while the user can still talk, and the server
    // grace timer + missed voice-rejoin is what makes everyone else see
    // "they left" even though media is live. Keep the session and wait for
    // socket reconnect to rebind.
    if (this.voice && this.voice.inVoice) {
      if (this._voiceDisconnectTimer) clearTimeout(this._voiceDisconnectTimer);
      this._voiceDisconnectTimer = setTimeout(() => {
        this._voiceDisconnectTimer = null;
        if (this.socket?.connected) return; // reconnected in time
        if (!(this.voice && this.voice.inVoice)) return;
        const peersLive = (this.voice.liveVoicePeerCount?.() || 0) > 0;
        const micLive = !!(this.voice.localStream &&
          this.voice.localStream.getTracks().some(t => t.readyState === 'live'));
        if (peersLive || micLive) {
          console.warn('[Voice] socket still down after 2s but WebRTC media is live — keeping session (no soft-leave)');
          return;
        }
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
      this._clearChannelCodeMap();
      localStorage.removeItem('haven_token');
      localStorage.removeItem('haven_user');
      localStorage.removeItem('haven_sync_key');
      window.location.href = '/';
      return;
    }
    this._setLed('connection-led', 'danger');
    this._setLed('status-server-led', 'danger');
    document.getElementById('status-server-text').textContent = t('app.status.error');
  });

  // Password was changed on this or another session — force re-login
  this.socket.on('force-logout', (data) => {
    if (data && data.reason === 'password_changed') {
      // If WE just changed the password, skip the kick — we already have the fresh token
      if (this._justChangedPassword) {
        this._justChangedPassword = false;
        return;
      }
      this._clearChannelCodeMap();
      localStorage.removeItem('haven_token');
      localStorage.removeItem('haven_user');
      window.location.href = '/';
    } else if (data && data.reason === 'sessions_revoked') {
      // We are the session that asked for this, so we already hold the fresh
      // token and stay put. Every other device gets sent back to the login page.
      if (this._justRevokedSessions) {
        this._justRevokedSessions = false;
        return;
      }
      this._clearChannelCodeMap();
      localStorage.removeItem('haven_token');
      localStorage.removeItem('haven_user');
      window.location.href = '/';
    } else if (data && data.reason === 'totp_enabled') {
      // If WE just enabled TOTP, skip the kick — we already have the fresh token
      if (this._justEnabledTotp) {
        this._justEnabledTotp = false;
        return;
      }
      this._clearChannelCodeMap();
      localStorage.removeItem('haven_token');
      localStorage.removeItem('haven_user');
      window.location.href = '/';
    }
  });

  this.socket.on('sessions-list', (data) => {
    this._renderSessionsList?.(data && data.sessions ? data.sessions : []);
  });
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
  const inVoiceLive = !!(this.voice && this.voice.inVoice &&
    ((this.voice.liveVoicePeerCount?.() || 0) > 0 || this.voice.localStream));
  console.log(`[force-resync] reason=${reason}, socket.connected=${!!this.socket?.connected}, inVoiceLive=${inVoiceLive}`);
  if (!this.socket) return;

  // Hard-cycling the socket while WebRTC is healthy is what produces the
  // "left voice on the roster / lost the stream / can still talk" desync
  // on window maximize. Prefer a light resync whenever media is live.
  if (inVoiceLive && this.socket.connected) {
    this._lightVoiceResync(reason);
    return;
  }

  try { this.socket.disconnect(); } catch (err) { console.warn('[Resync] disconnect failed', err); }
  try { this.socket.connect(); } catch (err) { console.warn('[Resync] reconnect failed', err); }
  // Defensive: if for some reason 'connect' doesn't fire within 6 s,
  // emit the resync requests anyway against the current socket so the
  // user at least gets channel data refreshed. (The connect handler is
  // the authoritative path — this is purely a belt-and-braces.)
  setTimeout(() => {
    if (this.socket?.connected && this.currentChannel) {
      // Only do this if connect handler didn't already run very recently.
      const sinceConnect = Date.now() - (this._lastConnectTime || 0);
      if (sinceConnect > 5000) {
        try { this.socket.emit('enter-channel', { code: this.currentChannel }); } catch (err) { console.warn('[Resync] enter-channel failed', err); }
        try { this.socket.emit('get-messages', { code: this.currentChannel }); } catch (err) { console.warn('[Resync] get-messages failed', err); }
        try { this.socket.emit('get-channel-members', { code: this.currentChannel }); } catch (err) { console.warn('[Resync] get-channel-members failed', err); }
        try { this.socket.emit('request-online-users', { code: this.currentChannel }); } catch (err) { console.warn('[Resync] request-online-users failed', err); }
        try { this.socket.emit('request-voice-users', { code: this.currentChannel }); } catch (err) { console.warn('[Resync] request-voice-users failed', err); }
        if (this.voice?.inVoice && this.voice.currentChannel) {
          try { this.socket.emit('voice-rejoin', { code: this.voice.currentChannel, ...this.voice.getRelayClientInfo() }); } catch (err) { console.warn('[Resync] voice-rejoin failed', err); }
        }
      }
    }
  }, 6000);
},

// Refresh channel/voice state without tearing down the socket (and therefore
// without risking a server-side voice grace-eviction while WebRTC is fine).
_lightVoiceResync(reason) {
  console.log(`[light-resync] reason=${reason}`);
  if (!this.socket?.connected) {
    try { this.socket?.connect(); } catch (err) { console.warn('[Resync] reconnect failed', err); }
    return;
  }
  try {
    if (this.currentChannel) {
      this.socket.emit('enter-channel', { code: this.currentChannel });
      this.socket.emit('request-online-users', { code: this.currentChannel });
      this.socket.emit('request-voice-users', {
        code: this.currentChannel,
        iAmInVoice: !!(this.voice && this.voice.inVoice && this.voice.currentChannel === this.currentChannel)
      });
    }
    if (this.voice?.inVoice && this.voice.currentChannel) {
      // voice-rejoin is now a no-op on the server when already bound on this
      // socket (skipRenegotiate). Still safe — used only to refresh roster.
      this.socket.emit('voice-rejoin', { code: this.voice.currentChannel, ...this.voice.getRelayClientInfo() });
      // UI may have been flipped to "Join Voice" by a partial desync — restore.
      try { this._reconcileVoiceUi?.(); } catch (err) { console.warn('[Resync] _reconcileVoiceUi failed', err); }
      try { this.voice.reassertScreenStreams?.(); } catch (err) { console.warn('[Resync] reassertScreenStreams failed', err); }
    }
  } catch (e) {
    console.warn('[light-resync] failed:', e);
  }
},

};
