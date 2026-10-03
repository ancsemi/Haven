// Everything else the server pushes: reactions, threads, forums, scheduled
// messages, polls, music, streams, DMs, channel code changes, webhooks,
// status and profiles, edits, deletes and pins, the gallery, moderation,
// server settings, preferences, rich presence, search and high scores.

export default {

_listenFeatureEvents() {
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
      try { await this._decryptMessages(wrapper, channelCode); } catch (err) { console.warn('[Thread] could not decrypt the parent message', err); }
      data.parentContent = wrapper[0].content;
    }
    if (data.messages && data.messages.length) {
      try { await this._decryptMessages(data.messages, channelCode); } catch (err) { console.warn('[Thread] could not decrypt thread messages', err); }
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
    // A forum topic shows its whole first post above the replies (#5659).
    this._forumThreadRenderTopic?.();
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
      const _isMention = (mentionRegex && mentionRegex.test(msg.content || '')) || everyoneRegex.test(msg.content || '') || this._mentionsMyRole?.(msg.content || '');
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
        try { await this._decryptMessages([data.message], data.channelCode); } catch (err) { console.warn('[Thread] could not decrypt the new thread message', err); }
      }
      this._appendThreadMessage(data.message);
    }
  });

  this.socket.on('thread-updated', (data) => {
    if (data.channelCode !== this.currentChannel) return;
    this._updateThreadPreview(data.parentId, data.thread);
    if (!this._forumActive) this._bumpForumTopic?.(data.parentId);
  });

  // Forum unread dots are per account, so another device opening a topic or
  // pressing Mark all read clears them here as well (#5641).
  this.socket.on('thread-read', (data) => {
    if (!data || data.channelCode !== this.currentChannel) return;
    this._forumMarkTopicRead?.(data.parentId);
  });
  this.socket.on('forum-read', (data) => {
    if (!data || data.channelCode !== this.currentChannel) return;
    this._forumMarkAllRead?.(data.channelCode);
  });

  // Forum topics: retitled or retagged, and the channel's tag list changed.
  this.socket.on('topic-updated', (data) => {
    if (data.channelCode !== this.currentChannel) return;
    this._forumApplyTopicUpdate?.(data);
  });
  this.socket.on('forum-tags-updated', (data) => {
    const ch = this.channels && this.channels.find(c => c.code === data.code);
    if (ch) ch.forum_tags = JSON.stringify(data.tags || []);
    if (data.code === this.currentChannel && this._forumActive) this._forumReload?.();
  });
  // A message you scheduled has just gone out (#5638).
  this.socket.on('scheduled-message-sent', (data) => {
    if (!data) return;
    this._showToast(t('modals.schedule.sent', { channel: data.channelName || '' }), 'info');
    if (document.getElementById('schedule-modal')?.style.display === 'flex') this._loadScheduledList?.();
  });
  // An admin set the layout everyone opens this forum in (#5656).
  this.socket.on('forum-layout-updated', (data) => {
    const ch = this.channels && this.channels.find(c => c.code === data.code);
    if (ch) ch.forum_layout = data.layout ? JSON.stringify(data.layout) : null;
    if (data.code === this.currentChannel && this._forumActive) this._forumReload?.();
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

  this.socket.on('bot-audio-play', (data) => {
    this.voice?.playBotAudio(data);
  });
  this.socket.on('bot-audio-stop', (data) => {
    if (!data || !this.voice || this.voice.currentChannel !== data.channelCode) return;
    this.voice.stopBotAudio(data.playbackId);
  });

  // ── Voice kicked ────────────────────────────────
  // NOTE: voice.js also listens for `voice-kicked` and calls leave() +
  // onVoiceKicked (which toasts). Wait a tick so that handler runs first;
  // only tear down + toast here if the session is somehow still live
  // (channel-mismatch edge case). Avoids double leave / double toast.
  this.socket.on('voice-kicked', (data) => {
    if (!data) return;
    setTimeout(() => {
      const stillIn = !!(this.voice && this.voice.inVoice);
      if (stillIn) {
        try { this.voice.leave(); } catch (err) { console.warn('[Voice] leave after removal failed', err); }
        this._showToast(
          t('toasts.kicked_from_voice', { by: data.kickedBy || data.reason || t('toasts.a_moderator') }),
          'error'
        );
      }
      this._updateVoiceButtons(false);
      this._updateVoiceStatus(false);
      this._updateVoiceBar();
    }, 0);
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
        try { this._renderMessages(this._lastRenderedMessages, this._lastRenderedReadId); } catch (err) { console.warn('[Messages] re-render after the member list arrived failed', err); }
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
    // Auto-show DM section when a DM opens
    this._setChannelTab('DMs');
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
    if (!ch) return;
    const wasViewing = this.currentChannel === data.oldCode;
    const wasInVoiceHere = !!(this.voice && this.voice.currentChannel === data.oldCode);
    this._migrateChannelCodeState(data.oldCode, data.newCode);
    this._updatePersistedChannelCode(data.channelId, data.newCode);
    ch.code = data.newCode;
    // Update display_code too (admins see real code, non-admins see masked)
    if (ch.display_code && ch.display_code !== '••••••••') ch.display_code = data.newCode;
    // CRITICAL (#5347): if we're in voice on the rotated channel, the
    // voice manager is still holding the OLD code as its currentChannel.
    // Without updating it, every voice-rejoin / request-voice-users /
    // voice-mute-state / etc. sent from this client uses the old code,
    // the server can't find it (the DB row's code column was just
    // updated), and we get the infinite "server says voice channel is
    // gone" loop. Migrate every voice-side code reference too.
    if (wasInVoiceHere) {
      console.log(`[Voice] channel code rotated mid-call: ${data.oldCode} -> ${data.newCode}`);
      this.voice._healPeerConnectionsAfterChannelRotation?.(data.oldCode);
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
},

_listenMessageChanges() {
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
    this._showToast(t('toasts.bio_updated'), 'success');
  });

  // ── Username rename ──────────────────────────────
  this.socket.on('renamed', (data) => {
    this.token = data.token;
    this.user = {...this.user, ...data.user};
    if (this.voice && data.user.id) this.voice.localUserId = data.user.id;
    localStorage.setItem('haven_token', data.token);
    localStorage.setItem('haven_user', JSON.stringify(this.user));
    document.getElementById('current-user').textContent = data.user.displayName || data.user.username;
    const loginEl = document.getElementById('login-name');
    if (loginEl) loginEl.textContent = `@${data.user.username}`;
    this._showToast(t('toasts.display_name_changed', { name: data.user.displayName || data.user.username }), 'success');
    // Refresh admin UI in case admin status changed
    this.user.permissions = data.user.permissions || this.user.permissions || [];
    this.user.globalPermissions = data.user.globalPermissions || this.user.globalPermissions || [];
    const canCreate = data.user.isAdmin || this._hasGlobalPerm('create_channel');
    document.getElementById('admin-controls').style.display = canCreate ? 'block' : 'none';
    // Same gate as login and roles-updated, so a moderator who changes their
    // display name keeps the Admin tab instead of losing it until reload.
    const canModerate = data.user.isAdmin || (this.user.effectiveLevel || 0) >= 25;
    document.getElementById('admin-mod-panel').style.display = (canModerate || this._hasAnyAdminSettingsAccess()) ? 'block' : 'none';
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
      // A forum card shows a title and a snippet rather than the message
      // body, so it is rebuilt from the new text instead of patched in place.
      if (this._forumActive && this._forumApplyContentEdit?.(data.messageId, displayContent)) return;
      msgEls.forEach((msgEl) => {
        const contentEl = msgEl.querySelector('.message-content, .thread-msg-content');
        if (!contentEl) return;
        contentEl.innerHTML = this._formatContent(displayContent);
        msgEl.dataset.rawContent = displayContent;
        let editedTag = msgEl.querySelector('.edited-tag');
        if (!editedTag) {
          editedTag = document.createElement('span');
          editedTag.className = 'edited-tag';
          editedTag.title = t('header.messages.edited_at', { date: this._fmtDateTime(data.editedAt) });
          editedTag.textContent = t('header.messages.edited');
          contentEl.appendChild(editedTag);
        }
      });
    }
  });

  // ── Bulk purge: admin replaced all of a user's messages with placeholder text ──
  this.socket.on('user-messages-purged', (data) => {
    if (!data || !data.channelCode) return;
    const placeholder = data.placeholder || t('modals.admin_action.purge_message_placeholder');
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
          try { this._promoteCompactToFull(next); } catch (e) { console.warn('[Messages] compact row promotion failed', e); }
        } else if (next && next.classList.contains('thread-compact')
                   && !msgEl.classList.contains('thread-compact')) {
          // Deleting the head of a thread group (a full row): promote the next
          // compact reply so it keeps an author header. Deleting a middle
          // compact row needs no promotion — the head above it still stands.
          try { this._promoteThreadCompactToFull(next); } catch (e) { console.warn('[Messages] thread row promotion failed', e); }
        }
        msgEl.remove();
      });
    }
    // Drop the row from the search panel too, regardless of which channel is
    // open — results are cross-channel and this only fires on a confirmed
    // delete, so removal stays truthful. (search-overhaul phase 3)
    this._searchRemoveResult?.(data.channelCode, data.messageId);
  });

  // Someone deleted every message they wrote (#5686): one event per channel.
  // Their rows go from whatever is on screen, and the open channel is loaded
  // again so the compact chains and the history cursor come out right.
  this.socket.on('messages-purged', (data) => {
    if (!data || !data.channelCode || !data.userId) return;
    const uid = String(data.userId);
    const views = [
      ['messages', this.currentChannel], ['thread-messages', this.currentChannel],
      ['dm-pip-messages', this._activeDMPip],
    ];
    for (const [id, code] of views) {
      if (code !== data.channelCode) continue;
      document.getElementById(id)?.querySelectorAll(`[data-msg-id][data-user-id="${uid}"]`).forEach(el => el.remove());
    }
    if (data.channelCode === this.currentChannel) {
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
  });

  // Attachment tags edited (#tagging phase 3). Repaint the Tags footer on every
  // rendered copy of the message. Fires cross-channel (users are joined to all
  // their channel rooms), so search results update too, wherever they're shown.
  this.socket.on('message-tags-updated', (data) => {
    if (!data || !data.messageId) return;
    this._updateMessageTagsFooter?.(data.messageId, data.tags || []);
  });

  // ── Low disk warning (admins only, #5505) ────────
  // The server only sends this to admins, and only when the state changes, so
  // there is nothing to filter here beyond reflecting whatever it last said.
  // Toast on the way in so it is noticed once; the banner is what persists.
  this.socket.on('disk-status', (data) => {
    const banner = document.getElementById('disk-low-banner');
    if (!banner || !data) return;
    if (!data.low) {
      banner.style.display = 'none';
      return;
    }
    const label = t('banners.disk_low');
    const detail = data.freeMb === null
      ? label
      : t('banners.disk_low_detail', { free: data.freeMb, reserve: data.reserveMb });
    banner.querySelector('.disk-low-text').textContent = label;
    banner.title = detail;
    banner.style.display = 'inline-flex';
    this._showToast(detail, 'error');
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
            try { this._promoteCompactToFull(next); } catch (err) { console.warn('[Messages] compact row promotion failed', err); }
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
          header.insertAdjacentHTML('beforeend', `<span class="pinned-tag" title="${t('app.messages.pinned')}">📌</span>`);
        }
        // Update toolbar: swap pin → unpin
        const pinBtn = msgEl.querySelector('[data-action="pin"]');
        if (pinBtn) { pinBtn.dataset.action = 'unpin'; pinBtn.title = t('msg_toolbar.unpin'); }
      }
      this._appendSystemMessage(`📌 ${t('header.messages.pinned_by', { name: data.pinnedBy })}`);
      this._markPinUnread?.(data.messageId);
      this._bumpPinIndicator?.(1);
      // A pinned topic heads the forum list and its menu should offer Unpin,
      // so the cached topic follows and the cards are rebuilt (#5650).
      const topic = this._forumTopics && this._forumTopics.get(data.messageId);
      if (topic) { topic.pinned = 1; if (this._forumActive) this._forumReload(); }

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
        if (unpinBtn) { unpinBtn.dataset.action = 'pin'; unpinBtn.title = t('msg_toolbar.pin'); }
      }
      const topic = this._forumTopics && this._forumTopics.get(data.messageId);
      if (topic) { topic.pinned = 0; if (this._forumActive) this._forumReload(); }
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

  // ── Channel thread list (#5506) ──
  this.socket.on('channel-threads', (data) => {
    if (!data || data.channelCode !== this.currentChannel) return;
    this._threadListData = Array.isArray(data.threads) ? data.threads : [];
    const search = document.getElementById('threads-list-search');
    this._renderThreadList?.(search ? search.value : '');
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
          header.insertAdjacentHTML('beforeend', `<span class="archived-tag" title="${t('app.messages.protected')}">🛡️</span>`);
        }
        // For compact messages, add tag to content
        const content = msgEl.querySelector('.message-content');
        if (msgEl.classList.contains('message-compact') && content && !content.querySelector('.archived-tag')) {
          content.insertAdjacentHTML('afterbegin', `<span class="archived-tag" title="${t('app.messages.protected')}">🛡️</span>`);
        }
        // A forum topic card shows the shield with its tags (#5622).
        const forumTags = msgEl.classList.contains('forum-topic') ? msgEl.querySelector('.forum-topic-tags') : null;
        if (forumTags && !forumTags.querySelector('.archived-tag')) {
          forumTags.insertAdjacentHTML('afterbegin', `<span class="forum-tag forum-tag-protected archived-tag" title="${t('app.messages.protected')}">🛡️</span>`);
        }
        // Update toolbar: swap archive → unarchive
        const archBtn = msgEl.querySelector('[data-action="archive"]');
        if (archBtn) { archBtn.dataset.action = 'unarchive'; archBtn.title = t('app.messages.unprotect_btn'); }
      }
      this._appendSystemMessage(`🛡️ ${t('header.messages.protected_by', { name: data.archivedBy })}`);
    }
    // Keep the cached topic in step so a re-rendered card keeps its shield.
    const topic = this._forumTopics && this._forumTopics.get(data.messageId);
    if (topic) topic.is_archived = 1;
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
        if (unarchBtn) { unarchBtn.dataset.action = 'archive'; unarchBtn.title = t('app.messages.protect_btn'); }
      }
      this._appendSystemMessage(`🛡️ ${t('header.messages.message_unprotected')}`);
    }
    const topic = this._forumTopics && this._forumTopics.get(data.messageId);
    if (topic) topic.is_archived = 0;
  });
},

_listenAdminAndPrefs() {
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
      this._clearChannelCodeMap();
      localStorage.removeItem('haven_token');
      localStorage.removeItem('haven_user');
      window.location.href = '/';
    }, 3000);
  });

  this.socket.on('muted', (data) => {
    this._showToast(data.reason ? t('toasts.muted_reason', { duration: data.duration, reason: data.reason }) : t('toasts.muted', { duration: data.duration }), 'error');
  });

  this.socket.on('unmuted', () => {
    this._showToast(t('toasts.unmuted'), 'success');
  });

  this.socket.on('ban-list', (data) => {
    this._renderBanList(data);
  });

  // (#5457) A banned user submitted an appeal. Nudge online admins and, if the
  // Banned Users modal is open, refresh it so the appeal shows immediately.
  this.socket.on('ban-appeal-received', (data) => {
    if (!this.user?.isAdmin) return;
    this._showToast(t('toasts.ban_appeal_received', {
      username: data?.username || t('toasts.banned_user'),
    }), 'info');
    const bansModal = document.getElementById('bans-modal');
    if (bansModal && bansModal.style.display !== 'none') {
      this.socket.emit('get-bans');
    }
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
  this.socket.on('server-settings', (settings, envInfo) => {
    this.serverSettings = settings;
    // Idle detection starts during app initialization, before this async
    // settings payload arrives. Re-plan its initial timer with server values.
    this._refreshIdleTimeout?.();
    // Which of these settings also have a value waiting in the environment,
    // so the panel can say which one is actually in effect. (#5489)
    this.serverEnvSettings = envInfo || {};
    // No GIF provider on this server: the button would only open an empty
    // picker, so it goes (#5654).
    document.documentElement.toggleAttribute('data-no-gif', settings && settings.gif_search_available === 'false');
    // TEMPORARY (#5649): a one-time notice to admins that channel access moved
    // from roles to the channel's Required roles. Remove after the 4.8.x cycle.
    if (settings && settings.role_gate_notice === '1' && !this._roleGateNoticeShown &&
        (this.user?.isAdmin || this._hasPerm?.('manage_roles') || this._hasPerm?.('manage_server'))) {
      this._roleGateNoticeShown = true;
      const modal = document.getElementById('role-gate-notice-modal');
      if (modal) {
        modal.style.display = 'flex';
        document.getElementById('role-gate-notice-ok')?.addEventListener('click', () => {
          modal.style.display = 'none';
          this.socket.emit('update-server-setting', { key: 'role_gate_notice', value: '0' });
        }, { once: true });
      }
    }
    this._applyServerSettings();
    this._renderChannelTemplates();
    this._maybeShowSetupWizard();
  });

  this.socket.on('server-setting-changed', (data) => {
    this.serverSettings[data.key] = data.value;
    if (data.key.startsWith('auto_away_')) this._refreshIdleTimeout?.();
    this._applyServerSettings();
    if (data.key === 'channel_templates') this._renderChannelTemplates();
    if (data.key === 'hide_disabled_channel_badges') this._renderChannels?.();
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
    // The top-bar Android banner waits for this record before it shows (#5594).
    this._syncAndroidBanner?.();
    // Effects come back from the server like the theme does; restore them
    // first so applyThemeFromServer() applies the saved pick, not the default.
    if (prefs.effects && typeof syncEffectsFromServer === 'function') syncEffectsFromServer(prefs.effects);
    if (prefs.theme) {
      // User has a saved personal theme preference — apply it
      applyThemeFromServer(prefs.theme, true, true);
    } else if (this.serverSettings.default_theme) {
      // No personal preference — apply the server's default theme
      applyThemeFromServer(this.serverSettings.default_theme);
    } else if (prefs.effects && typeof applyEffects === 'function') {
      // No theme pass to carry them, so the restored effects apply here.
      applyEffects(_getStoredEffectMode());
    }
    // Sync hide-own-score toggle to the server's stored value so reopening
    // settings on a fresh device shows the correct state.
    if (prefs.hide_nsfw != null) {
      try { localStorage.setItem('haven_hide_nsfw', prefs.hide_nsfw); } catch { /* storage blocked (private mode): nothing is remembered, nothing else breaks */ }
      const nsfwToggle = document.getElementById('hide-nsfw-channels');
      if (nsfwToggle) nsfwToggle.checked = prefs.hide_nsfw === 'true';
    }
    if (prefs.hide_score_badge != null) {
      try { localStorage.setItem('haven_hide_own_score', prefs.hide_score_badge); } catch { /* storage blocked (private mode): nothing is remembered, nothing else breaks */ }
      const ownToggle = document.getElementById('hide-own-score');
      if (ownToggle) ownToggle.checked = prefs.hide_score_badge === 'true';
    }
    // Activity toggles live entirely server-side (other clients must honour
    // them), so the UI can only be correct once prefs land.
    this._syncActivityUI?.();
    // Reflect any saved timezone/format in the settings row now that prefs are
    // known. The first-run modal itself is gated separately via the welcome
    // popup sequencer (_shouldShowTzPrompt).
    this._updateTimezoneSummary?.();
  });

  // Server's verdict on the recovery-codes notice (see the connect handler's
  // get-recovery-notice-state emit). Only shows when the account has no
  // recovery codes and the user hasn't ticked "never show again".
  this.socket.on('recovery-notice-state', ({ show } = {}) => {
    if (show) setTimeout(() => this._showRecoveryNotice(), 2500);
  });

  // ── Rich presence: linked accounts ─────────────────
  this.socket.on('connections', (data) => {
    const prev = new Set((this._connections?.connections || []).map(c => c.provider));
    this._connections = data || { connections: [], available: {} };
    this._renderConnections?.();
    // The quick toggles in the status picker read as on only when a provider
    // is linked, so linking or unlinking one has to refresh them.
    this._syncStatusPickerActivity?.();
    // The link may have completed in a different browser window entirely, so
    // this push is often the first the app hears of it — announce anything
    // newly linked rather than letting the row change silently.
    for (const c of (this._connections.connections || [])) {
      if (!prev.has(c.provider)) {
        const label = c.provider.charAt(0).toUpperCase() + c.provider.slice(1);
        this._showToast(t('users.connections.link_success', { provider: label }), 'success');
      }
    }
  });

  // ── Listening presence: webhook token state ───
  // token is a string when the feature is on, null when off. The full URL is
  // built client-side from this origin so the server never handles it.
  this.socket.on('listening-state', (data) => {
    this._applyListeningState?.(data?.token || null);
  });

  // Server issued a short-lived link token — hand off to the provider in a
  // SEPARATE window.
  //
  // This used to navigate the current page. In the desktop app that meant the
  // Haven window itself became Steam's sign-in page, and once the flow
  // finished somewhere else (Steam's QR sign-in hands off to the default
  // browser) the app was stranded on a provider page with no way back.
  //
  // The popup owns the whole round-trip and closes itself at the end; the app
  // window never moves. If the link succeeds, the server pushes a 'connections'
  // update to every socket this user has open, so the UI refreshes regardless
  // of which browser actually completed the flow.
  this.socket.on('connect-token', (data) => {
    if (!data || !data.provider || !data.token) return;
    const url = `/connect/${encodeURIComponent(data.provider)}?token=${encodeURIComponent(data.token)}`;
    const win = window.open(url, 'haven-connect', 'width=820,height=760,menubar=no,toolbar=no');
    if (!win) {
      // Popup blocked — tell the user rather than silently doing nothing.
      this._showToast(t('users.connections.allow_popups'), 'error');
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
  // Global FTS search is server-paged; results belong to the shared public
  // context (DMs are searched locally). total/page drive the pager. The
  // panel/pager/cache live in app-search.js. (search-overhaul phase 2)
  this.socket.on('search-results', (data) => {
    // Drop stale responses: only the latest issued query's token counts, so a
    // slow earlier query can't overwrite newer results. (search-overhaul)
    if (data.token != null && data.token !== this._searchSeq) return;
    this._searchReceiveResults('__public__', {
      results: data.results || [],
      total: data.total || 0,
      page: data.page || 1,
      query: data.query,
      filters: data.filters || null,
      isDM: !!data.isDM,
    });
  });

  // The server refused a search because this account hit the per-account rate
  // limit. Clear the spinner and toast, but leave the existing results in
  // place. Token-gated so a stale refusal can't kill a fresher spinner.
  this.socket.on('search-throttled', (data) => {
    if (data && data.token != null && data.token !== this._searchSeq) return;
    this._searchOnThrottled();
  });

  // Active tokenizer's minimum query length (trigram 3, word tokenizers 2), so
  // the input gate matches what the server can actually match. (phase 2)
  this.socket.on('search-config', (d) => {
    this._searchMinChars = (d && d.minChars) || 2;
  });

  // ── High Scores ──────────────────────────────────
  this.socket.on('high-scores', (data) => {
    this.highScores[data.game] = data.leaderboard;
    // Re-render online users to update score badges
    if (this._lastOnlineUsers) {
      this._renderOnlineUsers(this._lastOnlineUsers);
    }
    // Relay to game window or iframe if open
    try { if (this._gameWindow && !this._gameWindow.closed) this._gameWindow.postMessage({ type: 'leaderboard-data', leaderboard: data.leaderboard }, window.location.origin); } catch { /* game window closed or navigated away mid-send */ }
    try { if (this._gameIframe) this._gameIframe.contentWindow?.postMessage({ type: 'leaderboard-data', leaderboard: data.leaderboard }, window.location.origin); } catch { /* game frame closed or navigated away mid-send */ }
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

};
