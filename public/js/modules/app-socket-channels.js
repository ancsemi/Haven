// What the server says about channels and messages: the channel list,
// renames and role gates, message history and infinite scroll, new
// messages, members and who is online, voice rosters, typing, and channels
// being deleted or emptied.

export default {

_listenChannelsAndMessages() {
  this.socket.on('channels-list', (channels) => {
    // (#5391) Cancel the channels-not-arriving watchdog
    this._channelsListGotResponse = true;
    // A change in the user's channel/role set can make cached search results
    // show messages they no longer have access to. Invalidate the panel off
    // this already-broadcast event, so no new server plumbing. (search-overhaul)
    this._searchInvalidate?.(channels);
    // Fresh authoritative state: an optimistic Channel Functions toggle that
    // was still awaiting a verdict has just been accepted, so drop its undo.
    this._cfnPendingToggle = null;
    if (this._channelsWatchdog) {
      clearTimeout(this._channelsWatchdog);
      this._channelsWatchdog = null;
    }
    const rotations = this._collectChannelCodeRotations(channels);
    const activeRotation = rotations.find(rotation => rotation.oldCode === this.currentChannel) || null;
    let savedVoiceCode = null;
    try { savedVoiceCode = localStorage.getItem('haven_voice_channel'); } catch { /* storage blocked (private mode): keep the default */ }
    const voiceRotation = rotations.find(rotation =>
      rotation.oldCode === this.voice?.currentChannel ||
      rotation.oldCode === this.voice?._softLeftChannel ||
      rotation.oldCode === savedVoiceCode
    ) || null;
    for (const rotation of rotations) {
      this._migrateChannelCodeState(rotation.oldCode, rotation.newCode);
    }

    // Preserve any DM channels that were added client-side (via dm-opened
    // events). The server only sends server channels in channels-list, so
    // overwriting would wipe DM entries and break E2E decryption until the
    // user reopens the DM. A group DM only ever comes from this list, so one
    // missing from it is a group this user is no longer in (left, removed or
    // deleted) and goes. (#5740)
    const existingDMs = (this.channels || []).filter(c => c.is_dm && !c.is_group);
    this.channels = channels.map(c => c.is_group ? { ...c, dm_target: null } : c);
    for (const dm of existingDMs) {
      if (!this.channels.find(c => c.code === dm.code)) {
        this.channels.push(dm);
      }
    }
    this._persistChannelCodeMap(channels);
    const deferredCode = this.voice?._deferredChannelGone?.code;
    const deferredRotation = rotations.find(rotation => rotation.oldCode === deferredCode);
    const deferredChannel = channels.find(channel =>
      channel.code === deferredCode && channel.voice_enabled !== 0
    );
    this.voice?.resolveDeferredChannelGone?.(deferredRotation?.newCode || deferredChannel?.code || null);
    if (voiceRotation && this.voice?.inVoice && this.voice.currentChannel === voiceRotation.newCode) {
      this.socket.emit('voice-rejoin', { code: voiceRotation.newCode, ...this.voice.getRelayClientInfo() });
      if (this.voice.isMuted) this.socket.emit('voice-mute-state', { code: voiceRotation.newCode, muted: true });
      if (this.voice.isDeafened) this.socket.emit('voice-deafen-state', { code: voiceRotation.newCode, deafened: true });
      this.voice._healPeerConnectionsAfterChannelRotation?.(voiceRotation.oldCode);
    }
    // Seed client-side unreadCounts from server-reported values so the
    // desktop badge, tab title, and DM section badge stay in sync.
    // Only import counts for channels we haven't touched yet this session.
    // Skip muted channels entirely; server has no knowledge of client-side
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
        this._showToast?.(t('toasts.channel_link_unavailable'), 'error');
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
        // Per-channel, same reasoning as the composer gate in app-channels.js (#5468)
        const _isReadOnly = curCh.read_only === 1 && !this.user?.isAdmin && !curCh.canOverrideReadOnly;
        if (msgInputArea) msgInputArea.style.display = (_isReadOnly || (_textOff && _mediaOff)) ? 'none' : '';
        this._applyReactionLock?.();
      }
    }

    // If the channel code rotated while we were disconnected, re-enter with the
    // new code so messages, reactions, and presence start working again.
    if (activeRotation) {
      const updated = channels.find(c => c.id === activeRotation.channelId);
      if (updated) {
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

  // Channel renamed: update header if we're in that channel
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

  this.socket.on('channel-role-gate-updated', (data) => {
    const ch = this.channels.find(c => c.code === data.code);
    if (!ch) return;
    ch.role_gate = data.roleGate ? JSON.stringify(data.roleGate) : null;
    if (this._ctxMenuChannel === data.code) this._updateChannelFunctionsPanel?.(ch);
  });

  // Your own role-menu choice landed (from a click or a reaction); paint every
  // button for that role, in this channel and any other menu that lists it.
  this.socket.on('self-role-updated', (data) => {
    if (!data) return;
    this._markSelfRole(data.roleId, !!data.held);
  });

  // A role menu was edited: swap in the new buttons wherever that message is
  // on screen. The click handling is delegated, so fresh HTML just works (#5644).
  this.socket.on('role-menu-updated', (data) => {
    if (!data || !data.messageId) return;
    document.querySelectorAll(`.role-menu-widget[data-msg-id="${data.messageId}"]`).forEach(w => {
      const html = this._renderRoleMenu(data.messageId, data.roleMenu);
      if (html) w.outerHTML = html; else w.remove();
    });
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
    // then opened the PiP; issue: SerChiz v3.10.3).
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

    if (this._forumLoadingMore && this._forumActive) {
      this._forumLoadingMore = false;
      this._forumAppendOlder(data.messages);
      return;
    }
    if (this._historyBefore) {
      // Pagination request: prepend older messages
      this._historyBefore = null;
      if (data.messages.length === 0) {
        this._noMoreHistory = true;
        this._loadingHistory = false;
        return;
      }
      if (data.messages.length < 80) this._noMoreHistory = true;
      this._oldestMsgId = data.messages[0].id;
      if (this._isForumFeed?.()) this._appendOlderForum(data.messages);
      else this._prependMessages(data.messages);
      // Release lock AFTER DOM manipulation so scroll-triggered re-requests
      // don't fire while _prependMessages is adjusting scroll position.
      this._loadingHistory = false;
    } else if (this._historyAfter) {
      // Forward pagination: append newer messages
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
      // Jump-to-message: replace everything and scroll to target
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
      // _jumpTargetId is already set by _jumpToMessage; _renderMessages reads it
      this._renderMessages(data.messages);
    } else {
      // Initial load: replace everything
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
      if (this._isForumFeed?.()) {
        // Newest first: nothing to couple to at the bottom, and no jump button.
        this._coupledToBottom = false;
        if (jumpBtn) jumpBtn.classList.remove('visible');
        lastScrollTop = st;
        return;
      }
      if (dist < 200 && this._noMoreFuture !== false) {
        // Only couple if the DOM contains the actual latest messages.
        // When newer messages have been trimmed, the scroll "bottom" is
        // artificial and re-coupling would yank the user forward.
        this._coupledToBottom = true;
      } else if (st < lastScrollTop) {
        // User scrolled up: decouple immediately
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
      jumpBtn.addEventListener('click', () => this._jumpToLatest());
    }

    this._historyDebounce = 0; // timestamp of last history request
    msgContainer.addEventListener('scroll', () => {
      if (this._suppressCoupleCheck) return;
      const now = Date.now();
      // A forum feed runs newest first, so its older topics load from the bottom.
      const forumFeed = !!this._isForumFeed?.();
      const distEnd = msgContainer.scrollHeight - msgContainer.clientHeight - msgContainer.scrollTop;
      const atOlderEdge = forumFeed ? distEnd < 200 : msgContainer.scrollTop < 200;
      if (atOlderEdge && !this._forumActive && !this._noMoreHistory && !this._loadingHistory && this._oldestMsgId && this.currentChannel && now - this._historyDebounce > 300) {
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
      if (!forumFeed && distBottom < 200 && !this._noMoreFuture && !this._loadingFuture && this._newestMsgId && this.currentChannel && now - this._historyDebounce > 300) {
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
      // hidden. This happens for backgrounded server BrowserViews in
      // Desktop, and for any tab the user has alt-tabbed away from. We
      // still want to append the message so it's there when they come
      // back, but we skip mark-read and bump the unread badge instead.
      // Haven Desktop keeps pages "visible" even when minimised or behind
      // other windows (background throttling is off), so there the window
      // also has to have focus, or the open chat never notified (D#58).
      // Only Desktop versions that hand focus back to the page on alt-tab say
      // so; on older ones the page could lack focus while being looked at.
      const isActivelyViewing = !document.hidden &&
        (!window.havenDesktop?.pageFocusFollowsWindow || document.hasFocus());

      // If the user is scrolled into history and the DOM window has been
      // trimmed (doesn't include the latest messages), skip appending;
      // the message will be loaded via forward pagination when the user
      // scrolls back down.  Exception: own messages always snap to present.
      if (this._noMoreFuture !== false || isOwnMessage) {
        if (isOwnMessage && this._noMoreFuture === false) {
          // User sent a message while browsing history: snap back to
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
          // Clear any stale badge, but only when the user has actually seen
          // the new message (coupled to the bottom of the feed).
          if (this._coupledToBottom && this.unreadCounts[data.channelCode]) {
            this.unreadCounts[data.channelCode] = 0;
            this._updateBadge(data.channelCode);
          }
        } else if (!isOwnMessage) {
          // Page hidden (backgrounded server view, alt-tabbed, minimised):
          // count it as unread even though it's the "current" channel, so
          // the sidebar dot + taskbar badge actually fire.
          // Skip the unread bump for muted channels; muting should also silence badges.
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
          const _isMention = mentionRegex.test(data.message.content) || everyoneRegex.test(data.message.content) || this._mentionsMyRole?.(data.message.content);
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
          if (!isActivelyViewing) {
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
      // badge. The message is already visible in the floating PiP panel.
      const _inActivePiP = this._activeDMPip && data.channelCode === this._activeDMPip && !document.hidden;
      // Only count unread for messages from other users. Own message echoes arriving after a
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
          try { this.socket.emit('mark-read', { code: data.channelCode, messageId: data.message.id }); } catch (err) { console.warn('[DM] could not mark the conversation read', err); }
          try { this._updateDmSectionBadge?.(); } catch (err) { console.warn('[DM] _updateDmSectionBadge failed', err); }
          try { this._updateTabTitle?.(); } catch (err) { console.warn('[DM] _updateTabTitle failed', err); }
          try { this._updateDesktopBadge?.(); } catch (err) { console.warn('[DM] _updateDesktopBadge failed', err); }
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
        const _isMention2 = mentionRegex.test(data.message.content) || everyoneRegex2.test(data.message.content) || this._mentionsMyRole?.(data.message.content);
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
},

_listenPresenceAndVoice() {
  // Member entries arrive without the fields that hold their usual value;
  // put them back so everything reading a member sees the full shape.
  const fillMember = (u) => ({
    highScore: 0, statusText: '', avatar: null, avatarShape: 'circle', border: null,
    borderTransform: null, animateProfile: 'trigger', isGuest: false, role: null, activity: null,
    ...u,
  });

  // Only the members that changed, merged into the list kept for that
  // channel. The server sends the whole list first, so a channel with no
  // list here yet is skipped until it does.
  this.socket.on('online-users-delta', (data) => {
    const list = this._onlineByChannel?.get(data?.channelCode);
    if (!list) return;
    const upsert = Array.isArray(data.upsert) ? data.upsert.map(fillMember) : [];
    const drop = new Set([...(Array.isArray(data.remove) ? data.remove : []), ...upsert.map(u => u.id)]);
    const users = list.filter(u => !drop.has(u.id)).concat(upsert);
    users.sort((a, b) => {
      if (a.online !== b.online) return a.online ? -1 : 1;
      return (a.username || '').toLowerCase().localeCompare((b.username || '').toLowerCase());
    });
    applyOnlineUsers({ channelCode: data.channelCode, users, visibilityMode: data.visibilityMode });
  });

  this.socket.on('online-users', (data) => {
    if (data?.slim && Array.isArray(data.users)) data = { ...data, users: data.users.map(fillMember) };
    applyOnlineUsers(data);
  });

  const applyOnlineUsers = (data) => {
    // Every list is kept by channel (the socket sits in every room it
    // belongs to), so a DM PiP can read its own partner's presence instead
    // of the list for whatever channel is on screen (#5574).
    if (!this._onlineByChannel) this._onlineByChannel = new Map();
    this._onlineByChannel.set(data.channelCode, data.users || []);
    if (this._activeDMPip && data.channelCode === this._activeDMPip) this._refreshDMPipHeader?.();
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
  };

  this.socket.on('voice-users-update', (data) => {
    // Right-side VOICE panel shows who's in voice for the channel you are
    // currently *viewing* (not whichever VC you happen to be connected to).
    // Left-sidebar badges still track every channel via the maps below.
    const isViewing = data.channelCode === this.currentChannel;
    // Repair the local flags from the live peer connections before reading
    // them. Without this, a stale `inVoice === false` makes the filter below
    // delete us from our own voice panel (the "everyone sees me in voice
    // except me" report), and nothing ever undoes it.
    try { this.voice?.reassertSessionIfLive(); } catch (err) { console.warn('[Voice] reassertSessionIfLive failed', err); }
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
      console.warn('[VoiceSelfHeal] Server roster missing self, injecting + emitting voice-rejoin', {
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
        console.warn('[Voice] Self missing from roster, emitting voice-rejoin');
        this.socket.emit('voice-rejoin', { code: data.channelCode, ...this.voice.getRelayClientInfo() });
      }
    }
    if (isViewing && localStorage.getItem('haven_hide_voice_panel') !== 'true') {
      // Anti-flicker: while viewing a channel we're in voice on, ignore
      // transient empty snapshots from prune/rejoin races. Keep the last
      // good list and re-poll; otherwise the panel strobes
      // empty ↔ everyone. Legitimate "everyone left" still lands once the
      // follow-up poll returns a stable empty/self-only roster.
      const sameChannelList = this._lastVoiceUsersChannel === data.channelCode;
      const hadPeople = sameChannelList && Array.isArray(this._lastVoiceUsers) && this._lastVoiceUsers.length > 0;
      if (users.length === 0 && isInVoice && hadPeople) {
        console.warn('[Voice] Ignoring empty roster snapshot while inVoice (keeping last list)', {
          channel: data.channelCode,
          lastCount: this._lastVoiceUsers.length
        });
        const now = Date.now();
        if ((now - (this._lastEmptyRosterPollAt || 0)) > 2000 && this.socket?.connected) {
          this._lastEmptyRosterPollAt = now;
          this.socket.emit('request-voice-users', { code: data.channelCode, iAmInVoice: true });
        }
      } else {
        this._renderVoiceUsers(users, data.channelCode);
      }
    }
    // (#5347 v3.15.4) Keep the left sidebar in sync with the right panel.
    // Previously the right panel was driven by voice-users-update and the
    // left sidebar by voice-count-update, and the two could drift if one
    // event arrived stale or out of order (the user saw both users on the
    // right but only themselves on the left). Both stores are now updated
    // from this single authoritative event so they cannot disagree.
    //
    // Exception: when we're in voice on this channel and the snapshot is
    // transiently empty, don't wipe the sidebar either. Same race as the
    // panel guard above.
    const usersForSidebar = users.map(u => ({
      id: u.id, username: u.username,
      isMuted: !!u.isMuted, isDeafened: !!u.isDeafened,
      isBot: !!u.isBot, isListening: !!u.isListening
    }));
    const skipEmptyWipe = usersForSidebar.length === 0 && isInVoice &&
      Array.isArray(this.voiceChannelUsers?.[data.channelCode]) &&
      this.voiceChannelUsers[data.channelCode].length > 0;
    if (skipEmptyWipe) {
      // keep existing sidebar maps
    } else if (usersForSidebar.length > 0) {
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

  // Lightweight sidebar voice count: fires for every voice join/leave.
  // Kept for cross-channel notifications (the user gets count updates for
  // channels they're not currently viewing) and as a safety net if a
  // voice-users-update is dropped. The voice-users-update handler is the
  // primary source of truth.
  this.socket.on('voice-count-update', (data) => {
    // (#5347 v3.16.1) Same defensive self-filter as voice-users-update:
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
      // Welcome messages are no longer drawn here. They're now posted once, as a
      // persisted message, when a member first registers (see the 'welcome-message'
      // handler below + server auth.js), so they stay in history for everyone
      // instead of flashing live only for whoever was watching this channel.
    }
  });

  // Persisted new-member welcome message, appended live for anyone currently
  // viewing the channel. It's also saved server-side, so it renders in history
  // on reload (unlike the old ephemeral welcome, which was never saved).
  this.socket.on('welcome-message', (data) => {
    if (!data || !data.message || data.channelCode !== this.currentChannel) return;
    // Only append live when the newest messages are actually in view; if the
    // user is scrolled up in trimmed history it will load in order on scroll.
    // The message is persisted either way, so nothing is lost.
    if (this._noMoreFuture !== false) {
      this._appendMessage(data.message);
      if (Number.isInteger(data.message.id) && data.message.id > 0) this._newestMsgId = data.message.id;
    }
  });

  this.socket.on('channel-deleted', (data) => {
    this.channels = this.channels.filter(c => c.code !== data.code);
    this._renderChannels();
    // A DM gone while open in the pop-out DM window closes it too.
    if (this._activeDMPip === data.code) this._closeDMPiP?.();
    // Disconnect from voice if the user is in the deleted channel's voice
    if (this.voice && this.voice.inVoice && this.voice.currentChannel === data.code) {
      this._leaveVoice();
    }
    if (this.currentChannel === data.code) {
      this._renderVoiceUsers([]);
      this.currentChannel = null;
      this._showWelcome();
      if (this._leavingGroup !== data.code) this._showToast(t('toasts.channel_deleted'), 'error');
    }
  });

  // #5390, sister event of channel-deleted: messages were wiped via the
  // auto-clear self-destruct mode but the channel itself still exists.
  // If the user is viewing the affected channel, refetch its messages by
  // resetting the view. Otherwise nothing visual needs to change.
  this.socket.on('channel-messages-cleared', (data) => {
    if (!data || !data.code) return;
    if (this.currentChannel === data.code) {
      try { this.switchChannel(data.code); } catch (e) { console.warn('[auto-clear] re-switch failed:', e); }
      this._showToast(t('toasts.channel_auto_cleared'), 'info');
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
    // A refused channel-functions toggle arrives here and nowhere else, so
    // this is the only chance to put the row back where it was.
    this._revertPendingChannelToggle();
    this._restoreRefusedDraft(msg);
    this._showToast(msg, 'error');
  });

  // New accounts wait before posting (#5742). The server says how long is
  // left; the text, or the forum post being written, comes back for later.
  this.socket.on('new-account-wait', (data) => {
    const n = Number(data && data.minutes) || 0;
    const msg = !n ? t('automod.new_account_check_failed')
      : n === 1 ? t('automod.new_account_wait_one')
      : n >= 120 ? t('automod.new_account_wait_hours', { n: Math.round(n / 60) })
      : t('automod.new_account_wait_minutes', { n });
    this._restoreRefusedDraft(null, true);
    this._forumRestoreDraft?.();
    this._showToast(msg, 'error');
  });

  this.socket.on('toast', (data) => {
    if (data && data.message) this._showToast(data.message, data.type || 'info');
  });

  this.socket.on('pong-check', () => {
    // Pair with the oldest outstanding probe (see _pingSend). If the queue is
    // empty this pong belongs to a probe sent before a reconnect, so ignore it
    // rather than inventing a number.
    const sentAt = this._pingQueue && this._pingQueue.shift();
    if (sentAt == null) return;
    document.getElementById('status-ping').textContent = Date.now() - sentAt;
  });
},

};
