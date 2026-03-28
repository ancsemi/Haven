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
      document.getElementById('admin-mod-panel').style.display = (canModerate || this._hasPerm('manage_emojis') || this._hasPerm('manage_soundboard')) ? 'block' : 'none';
    }
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
    document.getElementById('admin-mod-panel').style.display = (canModerate || this._hasPerm('manage_emojis') || this._hasPerm('manage_soundboard')) ? 'block' : 'none';
    this._showToast('Your roles have been updated', 'info');
  });

  // Avatar updated confirmation (from socket broadcast by other tabs/reconnect)
  this.socket.on('avatar-updated', (data) => {
    if (data && data.url !== undefined) {
      this.user.avatar = data.url;
      localStorage.setItem('haven_user', JSON.stringify(this.user));
      this._updateAvatarPreview();
    }
  });

  this.socket.on('connect', () => {
    this._setLed('connection-led', 'on');
    this._setLed('status-server-led', 'on');
    document.getElementById('status-server-text').textContent = 'Connected';
    this._lastConnectTime = Date.now();
    this._startPingMonitor();
    // Re-join channel after reconnect (server lost our room membership)
    this.socket.emit('visibility-change', { visible: !document.hidden });
    this.socket.emit('get-channels');
    this.socket.emit('get-server-settings');
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
    } else {
      // Check localStorage for saved voice channel (persists across page refreshes / server restarts)
      try {
        const savedVoiceChannel = localStorage.getItem('haven_voice_channel');
        if (savedVoiceChannel && /^[a-f0-9]{8}$/i.test(savedVoiceChannel)) {
          // Auto-rejoin saved voice channel after delay (wait for channels to load)
          setTimeout(() => {
            if (this.voice && !this.voice.inVoice) {
              console.log('[Voice] Auto-rejoining saved voice channel:', savedVoiceChannel);
              this.voice.join(savedVoiceChannel);
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
    // Mobile fix: when returning to foreground, ensure socket is connected and refresh data
    if (!document.hidden) {
      if (this.socket && !this.socket.connected) {
        this.socket.connect();
      }
      // Delayed fallback: on some mobile browsers the WebSocket dies moments
      // after the tab resumes rather than before, so the immediate check above
      // might see it as "still connected."  Retry a couple of seconds later.
      setTimeout(() => {
        if (this.socket && !this.socket.connected) this.socket.connect();
      }, 2500);
      // Skip heavy refresh if we just handled a 'connect' event (avoids doubled emits)
      const sinceLast = Date.now() - (this._lastConnectTime || 0);
      if (sinceLast < 3000) return;
      // Re-fetch current channel messages + member list to catch anything missed
      if (this.currentChannel && this.socket?.connected) {
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
      // Re-fetch channels in case list changed while backgrounded
      this.socket?.emit('get-channels');
      
      // Mobile voice fix: check if we should be in voice but got disconnected
      try {
        const savedVoiceChannel = localStorage.getItem('haven_voice_channel');
        if (savedVoiceChannel && this.voice && !this.voice.inVoice && this.socket?.connected) {
          console.log('[Voice] Mobile foreground — rejoining voice channel:', savedVoiceChannel);
          setTimeout(() => {
            if (this.voice && !this.voice.inVoice) {
              this.voice.join(savedVoiceChannel);
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

  this.socket.on('disconnect', () => {
    this._setLed('connection-led', 'danger pulse');
    this._setLed('status-server-led', 'danger pulse');
    document.getElementById('status-server-text').textContent = 'Disconnected';
    document.getElementById('status-ping').textContent = '--';
    // Mobile fix: if we were in voice when the socket dropped, clean up local
    // voice state so the UI resets and auto-rejoin can work on reconnect.
    if (this.voice && this.voice.inVoice) {
      this.voice._softLeave();
      this._updateVoiceButtons(false);
      this._updateVoiceStatus(false);
      this._updateVoiceBar();
    }
  });

  this.socket.on('connect_error', (err) => {
    // Don't kick during password change — socket will reconnect with fresh token
    if (this._justChangedPassword) return;
    if (err.message === 'Invalid token' || err.message === 'Authentication required' || err.message === 'Session expired') {
      localStorage.removeItem('haven_token');
      localStorage.removeItem('haven_user');
      window.location.href = '/';
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
    // Detect if currentChannel's code was rotated while disconnected (stale code).
    // Capture the channel's ID from the old list before overwriting it.
    let rotatedChannelId = null;
    if (this.currentChannel && !channels.find(c => c.code === this.currentChannel)) {
      const oldEntry = this.channels.find(c => c.code === this.currentChannel);
      if (oldEntry) rotatedChannelId = oldEntry.id;
    }

    this.channels = channels;
    // Seed client-side unreadCounts from server-reported values so the
    // desktop badge, tab title, and DM section badge stay in sync.
    // Only import counts for channels we haven't touched yet this session.
    for (const ch of channels) {
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
    this._showToast(`Channel "#${channel.name}" created!\nCode: ${channel.code}`, 'success');
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
    if (data.channelCode !== this.currentChannel) return;
    // E2E: decrypt DM messages before rendering
    await this._decryptMessages(data.messages);

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
      this._renderMessages(data.messages);
    }

    // Re-append any pending E2E notice (survives message re-render after key change)
    if (this._pendingE2ENotice) {
      this._appendE2ENotice(this._pendingE2ENotice);
      this._pendingE2ENotice = null;
    }
  });

  // ── Infinite scroll: load older messages on scroll-to-top ──
  const msgContainer = document.getElementById('messages');
  if (msgContainer) {
    // Track whether the user is "coupled" to the bottom of the feed.
    // Simple rule: near bottom → true, scrolled up at all → false.
    this._coupledToBottom = true;
    let lastScrollTop = msgContainer.scrollTop;
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
    }, { passive: true });

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

    if (data.channelCode === this.currentChannel) {
      const isOwnMessage = data.message.user_id === this.user.id;

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
        this._markRead(data.message.id);
        // Clear any stale badge — but only when the user has actually seen
        // the new message (coupled to the bottom of the feed).
        if (this._coupledToBottom && this.unreadCounts[data.channelCode]) {
          this.unreadCounts[data.channelCode] = 0;
          this._updateBadge(data.channelCode);
        }
      }
      if (data.message.user_id !== this.user.id) {
        const _mutedChs = JSON.parse(localStorage.getItem('haven_muted_channels') || '[]');
        const _isMuted = _mutedChs.includes(data.channelCode);
        if (!_isMuted) {
          // Check if message contains @mention of current user
          const mentionRegex = new RegExp(`@${this.user.username}\\b`, 'i');
          const _notifCh = this.channels.find(c => c.code === data.channelCode);
          const _isAnnouncement = _notifCh && _notifCh.notification_type === 'announcement';
          if (mentionRegex.test(data.message.content)) {
            this.notifications.play('mention');
          } else {
            this.notifications.play(_isAnnouncement ? 'announcement' : 'message');
          }
          // Fire native OS notification if tab is hidden (alt-tabbed, minimised, etc.)
          if (document.hidden) {
            this._fireNativeNotification(data.message, data.channelCode);
          }
        }
      }
      // TTS: speak the message aloud for all listeners
      if (data.message.tts) {
        this.notifications.speak(`${this._getNickname(data.message.user_id, data.message.username)} says: ${data.message.content}`);
      }
    } else {
      const _mutedChs2 = JSON.parse(localStorage.getItem('haven_muted_channels') || '[]');
      const _isMuted2 = _mutedChs2.includes(data.channelCode);
      // Only count unread for messages from other users — own message echoes arriving after a
      // channel switch (race condition) would otherwise trigger a ghost badge.
      if (data.message.user_id !== this.user.id) {
        this.unreadCounts[data.channelCode] = (this.unreadCounts[data.channelCode] || 0) + 1;
        this._updateBadge(data.channelCode);
      }
      // Don't play notification sounds for your own messages in other channels
      if (data.message.user_id !== this.user.id && !_isMuted2) {
        // Check @mention even in other channels
        const mentionRegex = new RegExp(`@${this.user.username}\\b`, 'i');
        const _notifCh2 = this.channels.find(c => c.code === data.channelCode);
        const _isAnnouncement2 = _notifCh2 && _notifCh2.notification_type === 'announcement';
        if (mentionRegex.test(data.message.content)) {
          this.notifications.play('mention');
        } else {
          this.notifications.play(_isAnnouncement2 ? 'announcement' : 'message');
        }
        // Fire native OS notification when tab/window is not visible
        this._fireNativeNotification(data.message, data.channelCode);
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
    // Render voice panel unless the user opted to hide it
    if (data.channelCode === this.currentChannel && localStorage.getItem('haven_hide_voice_panel') !== 'true') {
      this._renderVoiceUsers(data.users);
    }
    // Keep voice bar up to date
    if (this.voice && this.voice.inVoice && this.voice.currentChannel === data.channelCode) {
      this._updateVoiceBar();
    }
  });

  // Lightweight sidebar voice count — fires for every voice join/leave
  this.socket.on('voice-count-update', (data) => {
    if (data.count > 0) {
      this.voiceCounts[data.code] = data.count;
      this.voiceChannelUsers[data.code] = data.users || [];
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
      this._appendSystemMessage(`${this._getNickname(data.user.id, data.user.username)} joined the channel`);
      this.notifications.play('join');
    }
  });

  this.socket.on('channel-deleted', (data) => {
    this.channels = this.channels.filter(c => c.code !== data.code);
    this._renderChannels();
    if (this.currentChannel === data.code) {
      this.currentChannel = null;
      this._showWelcome();
      this._showToast('Channel was deleted', 'error');
    }
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
    if (data.channelCode === this.currentChannel) {
      this._updateMessageReactions(data.messageId, data.reactions);
    }
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
      this._showToast(`Kicked from voice by ${data.kickedBy || 'a moderator'}`, 'error');
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
      this.channelMembers = data.members;
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
    this.switchChannel(data.code);
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
      ch.code = data.newCode;
      // Update display_code too (admins see real code, non-admins see masked)
      if (ch.display_code && ch.display_code !== '••••••••') ch.display_code = data.newCode;
      // Update currentChannel BEFORE re-rendering so the active highlight is correct
      if (this.currentChannel === data.oldCode) {
        this.currentChannel = data.newCode;
      }
      this._renderChannels();
      // If currently viewing this channel, update the header code display
      if (this.currentChannel === data.newCode) {
        const codeDisplay = document.getElementById('channel-code-display');
        if (codeDisplay) codeDisplay.textContent = ch.display_code || data.newCode;
      }
      if (this.user.isAdmin) {
        this._showToast(`Channel code rotated for #${ch.name}`, 'info');
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
      this._appendSystemMessage(`${data.oldName} is now known as ${data.newName}`);
    }
  });

  // ── Message edit / delete ──────────────────────────
  this.socket.on('message-edited', async (data) => {
    if (data.channelCode === this.currentChannel) {
      const msgEl = document.querySelector(`[data-msg-id="${data.messageId}"]`);
      if (!msgEl) return;
      const contentEl = msgEl.querySelector('.message-content');
      if (contentEl) {
        // E2E: decrypt if needed
        let displayContent = data.content;
        if (HavenE2E.isEncrypted(data.content)) {
          const partner = this._getE2EPartner();
          if (partner) {
            try {
              const plain = await this.e2e.decrypt(data.content, partner.userId, partner.publicKeyJwk);
              if (plain !== null) displayContent = plain;
              else displayContent = '[Encrypted message — unable to decrypt]';
            } catch { displayContent = '[Encrypted message — unable to decrypt]'; }
          } else {
            displayContent = '[Encrypted message — unable to decrypt]';
          }
        }
        contentEl.innerHTML = this._formatContent(displayContent);
        // Keep raw content in sync so the edit box is always seeded with
        // the clean markdown source (not textContent which strips formatting
        // and includes the '(edited)' tag text).
        msgEl.dataset.rawContent = data.content;
        // Add or update edited indicator
        let editedTag = msgEl.querySelector('.edited-tag');
        if (!editedTag) {
          editedTag = document.createElement('span');
          editedTag.className = 'edited-tag';
          editedTag.title = `Edited at ${new Date(data.editedAt).toLocaleString()}`;
          editedTag.textContent = '(edited)';
          contentEl.appendChild(editedTag);
        }
      }
    }
  });

  this.socket.on('message-deleted', (data) => {
    if (data.channelCode === this.currentChannel) {
      const msgEl = document.querySelector(`[data-msg-id="${data.messageId}"]`);
      if (msgEl) {
        // If the next sibling is a compact message (grouped), promote it to a full message
        const next = msgEl.nextElementSibling;
        if (next && next.classList.contains('message-compact')) {
          try { this._promoteCompactToFull(next); } catch (e) { /* don't let promotion failure block removal */ }
        }
        msgEl.remove();
      }
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
      const msgEl = document.querySelector(`[data-msg-id="${data.messageId}"]`);
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
      this._appendSystemMessage(`📌 ${data.pinnedBy} pinned a message`);
    }
  });

  this.socket.on('message-unpinned', (data) => {
    if (data.channelCode === this.currentChannel) {
      const msgEl = document.querySelector(`[data-msg-id="${data.messageId}"]`);
      if (msgEl) {
        msgEl.classList.remove('pinned');
        delete msgEl.dataset.pinned;
        const tag = msgEl.querySelector('.pinned-tag');
        if (tag) tag.remove();
        // Update toolbar: swap unpin → pin
        const unpinBtn = msgEl.querySelector('[data-action="unpin"]');
        if (unpinBtn) { unpinBtn.dataset.action = 'pin'; unpinBtn.title = 'Pin'; }
      }
      this._appendSystemMessage('📌 A message was unpinned');
    }
  });

  this.socket.on('pinned-messages', (data) => {
    if (data.channelCode === this.currentChannel) {
      this._renderPinnedPanel(data.pins);
    }
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
      this._appendSystemMessage(`🛡️ ${data.archivedBy} protected a message from cleanup`);
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
      this._appendSystemMessage('🛡️ A message was unprotected');
    }
  });

  // ── Admin moderation events ────────────────────────
  this.socket.on('kicked', (data) => {
    this._showToast(`You were kicked${data.reason ? ': ' + data.reason : ''}`, 'error');
    if (this.currentChannel === data.channelCode) {
      this.currentChannel = null;
      this._showWelcome();
    }
  });

  this.socket.on('banned', (data) => {
    this._showToast(`You have been banned${data.reason ? ': ' + data.reason : ''}`, 'error');
    setTimeout(() => {
      localStorage.removeItem('haven_token');
      localStorage.removeItem('haven_user');
      window.location.href = '/';
    }, 3000);
  });

  this.socket.on('muted', (data) => {
    this._showToast(`You have been muted for ${data.duration} min${data.reason ? ': ' + data.reason : ''}`, 'error');
  });

  this.socket.on('ban-list', (data) => {
    this._renderBanList(data);
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
          document.getElementById('bot-detail-panel').innerHTML = '<p class="muted-text" style="padding:20px;text-align:center">Select a bot to edit, or create a new one</p>';
        }
      }
    }
  });

  // ── User preferences (persistent theme etc.) ───────
  this.socket.on('preferences', (prefs) => {
    if (prefs.theme) {
      // User has a saved personal theme preference — apply it
      applyThemeFromServer(prefs.theme);
    } else if (this.serverSettings.default_theme) {
      // No personal preference — apply the server's default theme
      applyThemeFromServer(this.serverSettings.default_theme);
    }
  });

  // ── Search results ─────────────────────────────────
  this.socket.on('search-results', (data) => {
    const panel = document.getElementById('search-results-panel');
    const list = document.getElementById('search-results-list');
    const count = document.getElementById('search-results-count');
    count.textContent = `${data.results.length} result${data.results.length !== 1 ? 's' : ''} for "${this._escapeHtml(data.query)}"`;
    list.innerHTML = data.results.length === 0
      ? '<p class="muted-text" style="padding:12px">No results found</p>'
      : data.results.map(r => `
        <div class="search-result-item" data-msg-id="${r.id}">
          <span class="search-result-author" style="color:${this._getUserColor(r.username)}">${this._escapeHtml(this._getNickname(r.user_id, r.username))}</span>
          <span class="search-result-time">${this._formatTime(r.created_at)}</span>
          <div class="search-result-content">${this._highlightSearch(this._escapeHtml(r.content), data.query)}</div>
        </div>
      `).join('');
    panel.style.display = 'block';

    // Click to scroll to message
    list.querySelectorAll('.search-result-item').forEach(item => {
      item.addEventListener('click', () => {
        const msgId = item.dataset.msgId;
        const msgEl = document.querySelector(`[data-msg-id="${msgId}"]`);
        if (msgEl) {
          msgEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
          msgEl.classList.add('highlight-flash');
          setTimeout(() => msgEl.classList.remove('highlight-flash'), 2000);
        }
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
    this._showToast(`🏆 ${this._getNickname(data.user_id, data.username)} set a new ${gameName} record: ${data.score}!`, 'success');
  });
},

};
