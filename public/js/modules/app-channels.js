// Channels: switching to one, the topic bar and welcome screen, drawing the
// channel and DM sidebar, and moving between channels from the keyboard.

export default {

// ── Channel Management ────────────────────────────────

async switchChannel(code) {
  if (this.currentChannel === code) return;

  // Clear any pending image queue from previous channel
  this._clearImageQueue();

  // Voice persists across channel switches, no auto-disconnect

  this.currentChannel = code;
  // Search panel persists per-context: hide/show it for the channel we just
  // entered (public channels share one, each DM keeps its own). (search-overhaul)
  this._searchOnChannelSwitch?.();
  // Reset pin indicator until message-history reports the count for this channel
  this._updatePinIndicator?.(this._pinnedCountByChannel?.[code] || 0);
  this._coupledToBottom = true;
  const jumpBtn = document.getElementById('jump-to-bottom');
  if (jumpBtn) jumpBtn.classList.remove('visible');
  const channel = this.channels.find(c => c.code === code);
  const isDm = channel && channel.is_dm;
  const displayName = isDm && channel.is_group ? `👥 ${this._groupName(channel)}` : isDm && channel.dm_target
    ? `@ ${this._getNickname(channel.dm_target.id, channel.dm_target.username)}`
    : channel ? `# ${channel.name}` : code;

  document.getElementById('channel-header-name').textContent = displayName;
  // Clear scramble cache so the effect picks up the new channel name
  const headerEl = document.getElementById('channel-header-name');
  if (headerEl) { delete headerEl.dataset.originalText; headerEl._scrambling = false; }
  // (#5280) Burn-after-read 🔥 button is DM-only, so toggle visibility on
  // every channel switch and reset the per-message arming so a stale
  // toggle from another DM doesn't accidentally arm the next message
  // here in a non-DM channel.
  const _burnBtn = document.getElementById('burn-btn');
  const _burnDiv = document.getElementById('burn-divider');
  if (_burnBtn) {
    _burnBtn.style.display = isDm ? 'inline-flex' : 'none';
    _burnBtn.classList.remove('active');
  }
  if (_burnDiv) _burnDiv.style.display = isDm ? 'inline-block' : 'none';
  this._burnArmed = false;
  // Self-destructing messages are for channels; DMs have burn-after-read.
  // Only for people whose role lets them send one (send_self_destruct).
  const _sdBtn = document.getElementById('self-destruct-btn');
  const _sdDiv = document.getElementById('self-destruct-divider');
  const _sdHidden = isDm || !this._hasPerm('send_self_destruct');
  if (_sdBtn) _sdBtn.style.display = _sdHidden ? 'none' : '';
  if (_sdDiv) _sdDiv.style.display = _sdHidden ? 'none' : '';
  this._setSelfDestructArmed(false);
  const displayCode = channel ? (channel.display_code || code) : code;
  const isMaskedCode = (displayCode === '••••••••');
  document.getElementById('channel-code-display').textContent = isDm ? '' : displayCode;
  document.getElementById('copy-code-btn').style.display = (isDm || isMaskedCode) ? 'none' : 'inline-flex';

  // Show channel code settings gear for admins / users who can manage this
  // channel's settings, on non-DM channels (#5467)
  const codeSettingsBtn = document.getElementById('channel-code-settings-btn');
  if (codeSettingsBtn) {
    const canManageThis = this.user.isAdmin || !!(channel && channel.canManageSettings);
    codeSettingsBtn.style.display = (!isDm && canManageThis) ? 'inline-flex' : 'none';
  }

  // Show the header actions box
  const actionsBox = document.getElementById('header-actions-box');
  if (actionsBox) actionsBox.style.display = 'flex';
  this._labelCallButton?.();
  // Update voice button state: persist controls if in voice anywhere
  if (this.voice && this.voice.inVoice) {
    this._updateVoiceButtons(true);
    // If viewing a different channel from the one we're in voice in, show "Join Voice" instead of "Voice Active"
    if (this.voice.currentChannel !== code) {
      const indic = document.getElementById('voice-active-indicator');
      if (indic) indic.style.display = 'none';
      const _showJoin = this._voiceJoinAvailable();
      const _scJoinBtn = document.getElementById('voice-join-btn');
      if (_scJoinBtn) _scJoinBtn.style.display = _showJoin ? 'inline-flex' : 'none';
      const mobileJoin = document.getElementById('voice-join-mobile');
      if (mobileJoin) {
        if (_showJoin) mobileJoin.style.removeProperty('display');
        else mobileJoin.style.setProperty('display', 'none', 'important');
      }
    }
  } else {
    // Show just the join button (not the indicator), but hide it for text-only channels or users without voice permission
    const _showJoin = this._voiceJoinAvailable();
    const _scJoinBtn = document.getElementById('voice-join-btn');
    if (_scJoinBtn) _scJoinBtn.style.display = _showJoin ? 'inline-flex' : 'none';
    const indic = document.getElementById('voice-active-indicator');
    if (indic) indic.style.display = 'none';
    const vp = document.getElementById('voice-panel');
    if (vp) vp.style.display = 'none';
    const mobileJoin = document.getElementById('voice-join-mobile');
    if (mobileJoin) {
      if (_showJoin) mobileJoin.style.removeProperty('display');
      else mobileJoin.style.setProperty('display', 'none', 'important');
    }
  }
  document.getElementById('search-toggle-btn').style.display = '';
  document.getElementById('pinned-toggle-btn').style.display = '';
  const _galleryBtn = document.getElementById('gallery-toggle-btn');
  if (_galleryBtn) _galleryBtn.style.display = isDm ? 'none' : '';
  // (#5506) Same reasoning as the gallery: DM content is end-to-end encrypted,
  // so a server-built list of it would have nothing readable to show.
  const _threadsBtn = document.getElementById('threads-toggle-btn');
  if (_threadsBtn) _threadsBtn.style.display = isDm ? 'none' : '';
  // Auto-close pinned panel and Pins PiP on channel switch so stale pins don't linger
  document.getElementById('pinned-panel').style.display = 'none';
  this._closePinsPiP?.();

  // Show "Select messages" button for admins/mods on non-DM channels
  const moveSelectBtn = document.getElementById('move-select-btn');
  if (moveSelectBtn) {
    const canMove = !isDm && (this.user.isAdmin || this._canModerate());
    moveSelectBtn.style.display = canMove ? 'inline-flex' : 'none';
  }
  // Exit selection mode when switching channels
  if (this._moveSelectionActive) this._exitMoveSelectionMode();

  // Show/hide topic bar. DMs don't have topics; showing the placeholder
  // overlaps the E2E encryption dropdown that lives in the same header.
  if (isDm) {
    const bar = document.getElementById('channel-topic-bar');
    if (bar) bar.style.display = 'none';
  } else {
    this._updateTopicBar(channel?.topic || '');
  }

  // DM auto-cleanup notice (#5340): only visible in DMs when admin has enabled
  // age-based cleanup. Lets users know old messages are pruned, instead of being
  // surprised when history disappears.
  this._updateDmCleanupNotice(channel);

  // Show/hide message input; keep upload button visible for media-only channels
  const msgInputArea = document.getElementById('message-input-area');
  const _textOff = channel && channel.text_enabled === 0;
  const _mediaOff = channel && channel.media_enabled === 0;
  // Read-only: hide the composer unless this viewer may actually post here.
  // canOverrideReadOnly is decided per channel by the server. _hasPerm reads a
  // flat list that merges every channel-scoped grant together, so holding the
  // override in one channel used to reveal the composer in all of them, and the
  // send was then refused. (#5468)
  const _isReadOnly = channel && channel.read_only === 1 && !this.user?.isAdmin && !channel.canOverrideReadOnly;
  if (msgInputArea) msgInputArea.style.display = (_isReadOnly || (_textOff && _mediaOff)) ? 'none' : '';
  // Text-only elements
  const _msgInput = document.getElementById('message-input');
  const _sendBtn = document.getElementById('send-btn');
  const _emojiBtn = document.getElementById('emoji-btn');
  const _gifBtn = document.getElementById('gif-btn');
  const _pollBtn = document.getElementById('poll-btn');
  if (_msgInput) _msgInput.style.display = _textOff ? 'none' : '';
  if (_sendBtn) _sendBtn.style.display = _textOff ? 'none' : '';
  if (_emojiBtn) _emojiBtn.style.display = _textOff ? 'none' : '';
  if (_gifBtn) _gifBtn.style.display = _textOff ? 'none' : '';
  if (_pollBtn) _pollBtn.style.display = _textOff ? 'none' : '';
  // In a forum the composer starts topics, and says so. (#144)
  if (_msgInput) {
    const _forumCh = this.channels && this.channels.find(c => c.code === code);
    _msgInput.placeholder = (_forumCh && _forumCh.is_forum)
      ? t('app.messages.placeholder_forum')
      : t(window.innerWidth <= 480 ? 'app.messages.placeholder_short' : 'header.message_placeholder_commands');
  }
  const _timeBtn = document.getElementById('time-btn');
  const _timeDivider = document.getElementById('time-divider');
  if (_timeBtn) _timeBtn.style.display = _textOff ? 'none' : '';
  if (_timeDivider) _timeDivider.style.display = _textOff ? 'none' : '';
  // Upload button tied to media toggle
  const _uploadBtn = document.getElementById('upload-btn');
  if (_uploadBtn) _uploadBtn.style.display = _mediaOff ? 'none' : '';
  this._applyReactionLock?.();
  // Dividers: first one only if both upload and text buttons visible, rest if text is on
  const _dividers = document.querySelectorAll('.input-actions-box .input-actions-divider');
  if (_dividers[0]) _dividers[0].style.display = (!_textOff && !_mediaOff) ? '' : 'none';
  if (_dividers[1]) _dividers[1].style.display = _textOff ? 'none' : '';
  if (_dividers[2]) _dividers[2].style.display = _textOff ? 'none' : '';

  const messagesEl = document.getElementById('messages');
  messagesEl.innerHTML = '';
  document.getElementById('message-area').style.display = 'flex';
  document.getElementById('no-channel-msg').style.display = 'none';

  document.querySelectorAll('.channel-item').forEach(el => el.classList.remove('active'));
  const activeEl = document.querySelector(`.channel-item[data-code="${code}"]`);
  if (activeEl) activeEl.classList.add('active');

  this.unreadCounts[code] = 0;
  this._updateBadge(code);
  // Refresh thread-mention pill for the channel we just entered
  this._updateThreadMentionsPill?.();

  document.getElementById('status-channel').textContent = isDm && channel.is_group ? this._groupName(channel) : isDm && channel.dm_target
    ? t('channels.dm_status', { name: channel.dm_target.username }) : channel ? channel.name : code;

  // Reset pagination state for the new channel
  this._oldestMsgId = null;
  this._noMoreHistory = false;
  this._loadingHistory = false;
  this._historyBefore = null;
  this._newestMsgId = null;
  this._noMoreFuture = true;
  this._loadingFuture = false;
  this._historyAfter = null;

  this.socket.emit('enter-channel', { code });
  // E2E: fetch DM partner's public key BEFORE requesting messages.
  // Must not be allowed to reject: the channel UI is already fully swapped in
  // by this point, so a thrown key fetch would abandon every emit below it
  // (get-messages, mark-read, get-channel-members), leaving you sitting in a DM
  // with the *previous* channel's member list and @mentions quietly dead.
  // A missing partner key only costs E2E, which the encrypt path handles.
  if (isDm && channel) {
    try {
      await this._fetchDMPartnerKey(channel);
    } catch (err) {
      console.warn('[Haven] DM partner key fetch failed, continuing unencrypted:', err);
    }
  }
  this.socket.emit('get-messages', this._getMessagesParams ? this._getMessagesParams(code) : { code });
  // Belt-and-braces mark-read: if the server already told us the latest
  // message id for this channel (channels-list snapshot), fire a
  // mark-read IMMEDIATELY (not via the debounced _markRead path) so that
  // a quick re-open of a different channel within the 500 ms debounce
  // window can't clear the timer and silently drop the previous channel's
  // mark-read.  This was the root cause of "I've read this DM 6 times and
  // it still shows unread". The user would open the DM, glance at it,
  // switch away within 500 ms, the next switch's clearTimeout dropped the
  // first emit, and the server never recorded the read.  Server uses
  // MAX(last_read, incoming) so an older snapshot id can't clobber a
  // newer real id from the in-channel scroll handler.  Also mirror the
  // unread count locally so the badge clears immediately and doesn't
  // bounce back to "1" on the next channels-list snapshot.
  //
  // (#5432) This emit MUST come after the get-messages emit above.
  // Socket events are processed in order, so emitting mark-read first
  // updated read_positions before the history query ran, so the history
  // response then reported the user as fully caught up, and the
  // "NEW MESSAGES" divider + auto-scroll from #5259 never appeared.
  if (channel && channel.latestMessageId) {
    try { this.socket.emit('mark-read', { code, messageId: channel.latestMessageId }); } catch (err) { console.warn('[Channels] could not mark the channel read', err); }
    if (this.unreadCounts && this.unreadCounts[code]) {
      this.unreadCounts[code] = 0;
      try { this._updateBadge?.(code); } catch (err) { console.warn('[Channels] _updateBadge failed', err); }
      try { this._updateDmSectionBadge?.(); } catch (err) { console.warn('[Channels] _updateDmSectionBadge failed', err); }
      try { this._updateTabTitle?.(); } catch (err) { console.warn('[Channels] _updateTabTitle failed', err); }
      try { this._updateDesktopBadge?.(); } catch (err) { console.warn('[Channels] _updateDesktopBadge failed', err); }
    }
  }
  this.socket.emit('get-channel-members', { code });
  // VOICE panel shows who's in voice in the channel you just opened.
  this.socket.emit('request-voice-users', {
    code,
    iAmInVoice: !!(this.voice && this.voice.inVoice && this.voice.currentChannel === code)
  });
  // Safety net (#post-sleep-channel-desync round 2): if message-history
  // doesn't arrive within 5 s for the channel we just switched to, the
  // socket is likely a zombie (silent disconnect, write buffered but not
  // flushed). Force a full resync: the 'connect' handler will re-emit
  // enter-channel + get-messages and unstick the empty chat view. Cleared
  // by the message-history listener in app-socket.js when a response for
  // this code arrives.
  if (this._switchChannelSafetyTimer) clearTimeout(this._switchChannelSafetyTimer);
  this._pendingChannelHistoryCode = code;
  this._switchChannelSafetyTimer = setTimeout(() => {
    if (this._pendingChannelHistoryCode === code && this.currentChannel === code) {
      console.warn(`[switch-channel] no message-history for ${code} within 5s, forcing resync`);
      this._forceFullResync?.('switch-channel-timeout');
    }
  }, 5000);
  this._clearReply();
  this._closeThread();

  // Auto-focus the message input for quick typing.
  // Skip on touch devices: focusing an input opens the on-screen keyboard, which
  // shrinks the visual viewport and can leave the layout shifted up after the
  // keyboard closes (especially on Android web; see issue #5285).
  const msgInput = document.getElementById('message-input');
  const isTouchDevice = window.matchMedia('(hover: none) and (pointer: coarse)').matches
                     || window.matchMedia('(pointer: coarse)').matches
                     || 'ontouchstart' in window
                     || navigator.maxTouchPoints > 0;
  if (msgInput && !isTouchDevice) setTimeout(() => msgInput.focus(), 50);

  // Show E2E encryption menu only in DM channels
  const e2eWrapper = document.getElementById('e2e-menu-wrapper');
  if (e2eWrapper) e2eWrapper.style.display = isDm ? '' : 'none';
  if (isDm) this._updateE2EIndicator();
  // Close dropdown when switching channels
  const e2eDropdown = document.getElementById('e2e-dropdown');
  if (e2eDropdown) e2eDropdown.style.display = 'none';
},

_updateDmCleanupNotice(channel) {
  // Build / locate the notice element. Sits just below the topic bar (or the
  // header if no topic bar) so the layout is identical for everyone. The
  // banner is the only thing that toggles.
  let bar = document.getElementById('dm-cleanup-notice');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'dm-cleanup-notice';
    bar.className = 'dm-cleanup-notice';
    const topicBar = document.getElementById('channel-topic-bar');
    const header = document.querySelector('.channel-header');
    const anchor = topicBar || header;
    if (anchor && anchor.parentNode) {
      anchor.parentNode.insertBefore(bar, anchor.nextSibling);
    }
  }
  const isDm = !!(channel && channel.is_dm);
  const enabled = this.serverSettings && this.serverSettings.cleanup_enabled === 'true';
  const days = parseInt(this.serverSettings && this.serverSettings.cleanup_max_age_days) || 0;
  if (isDm && enabled && days > 0) {
    bar.textContent = t('channels.dm_cleanup_notice', { days });
    bar.style.display = 'block';
  } else {
    bar.style.display = 'none';
    bar.textContent = '';
  }
},

_updateTopicBar(topic) {
  let bar = document.getElementById('channel-topic-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'channel-topic-bar';
    bar.className = 'channel-topic-bar';
    const header = document.querySelector('.channel-header');
    header.parentNode.insertBefore(bar, header.nextSibling);
  }
  // The text and the fold arrow are separate targets. The arrow folds the bar
  // to a thin strip for this browser only, and the fold survives channel
  // switches and reloads (#5625). Clicking the folded strip opens it again.
  let text = bar.querySelector('.channel-topic-text');
  if (!text) {
    bar.textContent = '';
    text = document.createElement('span');
    text.className = 'channel-topic-text';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'channel-topic-toggle';
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      this._setTopicBarFolded(!bar.classList.contains('collapsed'));
    });
    bar.appendChild(text);
    bar.appendChild(toggle);
  }
  const canEdit = this.user.isAdmin || this._hasPerm('set_channel_topic');
  const editable = !!topic ? canEdit : canEdit;
  if (topic || canEdit) {
    text.textContent = topic || t('channels.topic_placeholder');
    bar.style.display = '';
    bar.title = topic ? (canEdit ? t('channels.topic_edit_hint') : topic) : '';
    bar.style.cursor = editable ? 'pointer' : 'default';
    bar.style.color = topic ? '' : 'var(--text-muted)';
    bar.style.opacity = topic ? '1' : '';
    bar.onclick = () => {
      if (bar.classList.contains('collapsed')) { this._setTopicBarFolded(false); return; }
      if (editable) this._editTopic();
    };
  } else {
    bar.style.display = 'none';
  }
  this._setTopicBarFolded(null);
},

// null keeps the saved state and just applies it; true or false saves first.
_setTopicBarFolded(folded) {
  const bar = document.getElementById('channel-topic-bar');
  if (!bar) return;
  if (folded !== null) {
    try { localStorage.setItem('haven_topic_bar_folded', folded ? '1' : '0'); } catch { /* private mode */ }
  }
  let saved = false;
  try { saved = localStorage.getItem('haven_topic_bar_folded') === '1'; } catch { /* private mode */ }
  bar.classList.toggle('collapsed', saved);
  const toggle = bar.querySelector('.channel-topic-toggle');
  if (toggle) {
    toggle.textContent = saved ? '\u25BE' : '\u25B4';
    toggle.title = t(saved ? 'channels.topic_bar_show' : 'channels.topic_bar_hide');
    toggle.setAttribute('aria-label', toggle.title);
  }
},

async _editTopic() {
  const channel = this.channels.find(c => c.code === this.currentChannel);
  const current = channel?.topic || '';
  const newTopic = await this._showPromptModal(t('channels.topic_modal_title'), t('channels.topic_modal_hint'), current);
  if (newTopic === null) return; // cancelled
  this.socket.emit('set-channel-topic', { code: this.currentChannel, topic: newTopic.slice(0, 256) });
},

_showWelcome() {
  document.getElementById('message-area').style.display = 'none';
  document.getElementById('no-channel-msg').style.display = 'flex';
  document.getElementById('channel-header-name').textContent = t('header.select_channel');
  // Clear scramble cache when going back to welcome
  const welcomeHeader = document.getElementById('channel-header-name');
  if (welcomeHeader) { delete welcomeHeader.dataset.originalText; welcomeHeader._scrambling = false; }
  document.getElementById('channel-code-display').textContent = '';
  document.getElementById('copy-code-btn').style.display = 'none';
  document.getElementById('voice-join-btn').style.display = 'none';
  const indic2 = document.getElementById('voice-active-indicator');
  if (indic2) indic2.style.display = 'none';
  const vp2 = document.getElementById('voice-panel');
  if (vp2) vp2.style.display = 'none';
  const mobileJoin = document.getElementById('voice-join-mobile');
  if (mobileJoin) mobileJoin.style.setProperty('display', 'none', 'important');
  const actionsBox = document.getElementById('header-actions-box');
  if (actionsBox) actionsBox.style.display = 'none';
  document.getElementById('status-channel').textContent = t('channels.status_none');
  document.getElementById('status-online-count').textContent = '0';
  const topicBar = document.getElementById('channel-topic-bar');
  if (topicBar) topicBar.style.display = 'none';
  const dmNotice = document.getElementById('dm-cleanup-notice');
  if (dmNotice) { dmNotice.style.display = 'none'; dmNotice.textContent = ''; }
},

_renderChannels() {
  const list = document.getElementById('channel-list');
  list.innerHTML = '';

  // (#5409) Admin-hidden channels are dropped from the sidebar, except the one
  // we're actively viewing (so a freshly-hidden current channel doesn't vanish
  // out from under us until we navigate away). Hiding a parent hides its
  // sub-channels too, since they're orphaned once the parent isn't rendered.
  const _hiddenChannels = this._getHiddenChannels();
  const regularChannels = this.channels.filter(c =>
    !c.is_dm && (!_hiddenChannels.includes(c.code) || c.code === this.currentChannel));
  const dmChannels = this.channels.filter(c => c.is_dm);

  // Build parent → sub-channel tree
  const parentChannels = regularChannels.filter(c => !c.parent_channel_id);
  const subChannelMap = {};
  regularChannels.filter(c => c.parent_channel_id).forEach(c => {
    if (!subChannelMap[c.parent_channel_id]) subChannelMap[c.parent_channel_id] = [];
    subChannelMap[c.parent_channel_id].push(c);
  });

  // Show/hide sub-channel panel button based on whether sub-channels exist
  const subPanelBtn = document.getElementById('sub-channel-panel-btn');
  if (subPanelBtn) subPanelBtn.style.display = Object.keys(subChannelMap).length > 0 ? '' : 'none';

  // Sort sub-channels: respect parent's sort_alphabetical setting & per-tag overrides
  // sort_alphabetical: 0=manual, 1=alpha, 2=created, 3=oldest
  // Per-tag overrides (from organize modal) are stored in localStorage
  Object.entries(subChannelMap).forEach(([parentId, arr]) => {
    const parent = parentChannels.find(p => p.id === parseInt(parentId));
    const globalSortMode = parent ? parent.sort_alphabetical : 0;
    const hasTags = arr.some(c => c.category);

    // Load per-tag sort overrides
    const tagOverrides = parent ? JSON.parse(localStorage.getItem(`haven_tag_sorts_${parent.code}`) || '{}') : {};

    // Tag grouping helper (groups by tag name, respects stored category order)
    const catOrder = parent ? JSON.parse(localStorage.getItem(`haven_cat_order_${parent.code}`) || '[]') : [];
    const catSort = parent ? (localStorage.getItem(`haven_cat_sort_${parent.code}`) || 'az') : 'az';
    const tagGroup = (a, b) => {
      const tagA = a.category || '';
      const tagB = b.category || '';
      if (tagA.toLowerCase() !== tagB.toLowerCase()) {
        const keyA = tagA || '__untagged__';
        const keyB = tagB || '__untagged__';
        if (catSort === 'manual') {
          const iA = catOrder.indexOf(keyA); const iB = catOrder.indexOf(keyB);
          if (iA !== -1 || iB !== -1) {
            if (iA === -1) return 1; if (iB === -1) return -1;
            return iA - iB;
          }
        }
        // Default: untagged at bottom, then alphabetical
        if (!tagA) return 1;
        if (!tagB) return -1;
        if (catSort === 'za') return tagB.localeCompare(tagA);
        return tagA.localeCompare(tagB);
      }
      return 0;
    };

    // Sort function for a given mode
    const sortByMode = (a, b, mode) => {
      if (mode === 1 || mode === 'alpha') return a.name.localeCompare(b.name);
      if (mode === 2 || mode === 'created') return (b.id || 0) - (a.id || 0);
      if (mode === 3 || mode === 'oldest') return (a.id || 0) - (b.id || 0);
      if (mode === 4 || mode === 'dynamic') return (b.latestMessageId || 0) - (a.latestMessageId || 0);
      return (a.position || 0) - (b.position || 0); // manual
    };

    // Map string modes to numbers for consistency
    const modeToNum = (m) => m === 'alpha' ? 1 : m === 'created' ? 2 : m === 'oldest' ? 3 : m === 'dynamic' ? 4 : m === 'manual' ? 0 : m;

    if (hasTags) {
      // Sort by tag group first, then within each group use per-tag override or global
      arr.sort((a, b) => {
        const g = tagGroup(a, b);
        if (g !== 0) return g;
        // Same tag group: check per-tag override
        const tag = a.category || '__untagged__';
        const override = tagOverrides[tag];
        const effectiveMode = override !== undefined ? modeToNum(override) : globalSortMode;
        return sortByMode(a, b, effectiveMode);
      });
    } else {
      arr.sort((a, b) => sortByMode(a, b, globalSortMode));
    }

    // Secondary sort: subscribed (not muted) sub-channels appear before unsubscribed (muted)
    const _subMuted = JSON.parse(localStorage.getItem('haven_muted_channels') || '[]');
    arr.sort((a, b) => {
      const aMuted = _subMuted.includes(a.code) ? 1 : 0;
      const bMuted = _subMuted.includes(b.code) ? 1 : 0;
      return aMuted - bMuted; // stable sort preserves original order within same group
    });
  });

  // Sort parent channels: respect server-level sort mode & per-tag overrides
  const localSortOverride = localStorage.getItem('haven_server_sort_mode');
  const serverSortMode = localSortOverride || this.serverSettings?.channel_sort_mode || 'manual';
  // Per-tag overrides: prefer localStorage (admin's local state) then fall back to server settings
  const localTagOverrides = localStorage.getItem('haven_tag_sorts___server__');
  const serverTagOverrides = JSON.parse(localTagOverrides || this.serverSettings?.channel_tag_sorts || '{}');
  const parentHasTags = parentChannels.some(c => c.category);

  const serverSortByMode = (a, b, mode) => {
    if (mode === 'alpha') return a.name.localeCompare(b.name);
    if (mode === 'created') return (b.id || 0) - (a.id || 0);
    if (mode === 'oldest') return (a.id || 0) - (b.id || 0);
    if (mode === 'dynamic') return (b.latestMessageId || 0) - (a.latestMessageId || 0);
    return (a.position || 0) - (b.position || 0) || a.name.localeCompare(b.name); // manual
  };

  // Load stored category order for server-level categories
  // Prefer localStorage (admin's local state) then fall back to server settings
  const localCatOrder = localStorage.getItem('haven_cat_order___server__');
  const serverCatOrder = JSON.parse(localCatOrder || this.serverSettings?.channel_cat_order || '[]');
  const localCatSort = localStorage.getItem('haven_cat_sort___server__');
  const serverCatSort = localCatSort || this.serverSettings?.channel_cat_sort || 'az';

  if (parentHasTags) {
    const tagGroup = (a, b) => {
      const tagA = a.category || '';
      const tagB = b.category || '';
      if (tagA.toLowerCase() !== tagB.toLowerCase()) {
        const keyA = tagA || '__untagged__';
        const keyB = tagB || '__untagged__';
        if (serverCatSort === 'manual') {
          const iA = serverCatOrder.indexOf(keyA); const iB = serverCatOrder.indexOf(keyB);
          if (iA !== -1 || iB !== -1) {
            if (iA === -1) return 1; if (iB === -1) return -1;
            return iA - iB;
          }
        }
        // Default: untagged at bottom, then alphabetical
        if (!tagA) return 1;
        if (!tagB) return -1;
        if (serverCatSort === 'za') return tagB.localeCompare(tagA);
        return tagA.localeCompare(tagB);
      }
      return 0;
    };
    parentChannels.sort((a, b) => {
      const g = tagGroup(a, b);
      if (g !== 0) return g;
      const tag = a.category || '__untagged__';
      const override = serverTagOverrides[tag];
      const effectiveMode = override !== undefined ? override : serverSortMode;
      return serverSortByMode(a, b, effectiveMode);
    });
  } else {
    parentChannels.sort((a, b) => serverSortByMode(a, b, serverSortMode));
  }

  const renderChannelItem = (ch, isSub) => {
    const el = document.createElement('div');
    el.className = 'channel-item' + (isSub ? ' sub-channel-item' : '') + (ch.is_private ? ' private-channel' : '') + (ch.code === this.currentChannel ? ' active' : '');
    el.dataset.code = ch.code;
    if (isSub) el.dataset.parentId = ch.parent_channel_id;

    const hasSubs = !isSub && (subChannelMap[ch.id] || []).length > 0;
    const isCollapsed = hasSubs && localStorage.getItem(`haven_subs_collapsed_${ch.code}`) === 'true';

    const isAnnouncement = ch.notification_type === 'announcement';
    const isTemporary = !!ch.expires_at;
    const isTempVoice = !!ch.is_temp_voice;
    const hashIcon = isSub ? (ch.is_private ? '🔒' : '↳') : (isTempVoice ? '🔊' : (isTemporary ? '⏱️' : (isAnnouncement ? '📢' : (ch.is_forum ? '🗂️' : (ch.is_nsfw ? '🔞' : '#')))));
    // NSFW channels stay out of sight when the user asked for that (phone in
    // public), except the one they are actually in.
    if (ch.is_nsfw && this._hideNsfw && this._hideNsfw() && ch.code !== this.currentChannel) el.style.display = 'none';

    // Build small status indicators for channel features
    const _badges = [];
    if (!isSub) {
      // An admin can hide the crossed-out icons for everyone (#5615): on a
      // server where most channels have these off they were only clutter.
      const showOff = !this.serverSettings || this.serverSettings.hide_disabled_channel_badges !== 'true';
      if (showOff && ch.streams_enabled === 0) _badges.push(`<span class="ch-disabled-badge" title="${t('channels.screen_share_not_allowed')}">🖥️</span>`);
      if (showOff && ch.music_enabled === 0) _badges.push(`<span class="ch-disabled-badge" title="${t('channels.music_not_allowed')}">🎵</span>`);
      if (ch.slow_mode_interval > 0) _badges.push(`<span title="${t('channels.slow_mode_title', { seconds: ch.slow_mode_interval })}" style="opacity:0.5;font-size:0.65rem">🐢</span>`);
      if (ch.cleanup_exempt === 1) _badges.push(`<span title="${t('channels.cleanup_exempt_title')}" style="opacity:0.5;font-size:0.65rem">🛡️</span>`);
    }
    const _mutedList = JSON.parse(localStorage.getItem('haven_muted_channels') || '[]');
    if (_mutedList.includes(ch.code)) _badges.push(`<span class="ch-disabled-badge" title="${t('channels.muted_unsubscribed')}">🔕</span>`);
    const indicators = _badges.length ? `<span class="channel-indicators" style="margin-left:auto;display:flex;gap:2px;align-items:center;flex-shrink:0">${_badges.join('')}</span>` : '';

    const expiryTitle = isTemporary ? ` title="${t('channels.temporary_expires', { date: this._fmtDateTime(ch.expires_at) })}"` : '';
    el.innerHTML = `
      ${hasSubs ? `<span class="channel-collapse-arrow${isCollapsed ? ' collapsed' : ''}" title="${t('channels.expand_collapse')}">▾</span>` : ''}
      <span class="channel-hash"${expiryTitle}>${hashIcon}</span>
      <span class="channel-name">${this._escapeHtml(ch.name)}</span>
      ${indicators}
      <button class="channel-more-btn" title="${t('channels.channel_options')}">⋯</button>
    `;

    // If parent has sub-channels, clicking the arrow toggles them
    if (hasSubs) {
      const arrow = el.querySelector('.channel-collapse-arrow');
      arrow.addEventListener('click', (e) => {
        e.stopPropagation();
        const collapsed = arrow.classList.toggle('collapsed');
        localStorage.setItem(`haven_subs_collapsed_${ch.code}`, collapsed);
        document.querySelectorAll(`.sub-channel-item[data-parent-id="${ch.id}"], .sub-tag-label[data-parent-id="${ch.id}"]`).forEach(sub => {
          sub.style.display = collapsed ? 'none' : '';
        });
        if (collapsed) {
          // Bubble up sub-channel unreads to the parent
          const subTotal = this.channels
            .filter(c => c.parent_channel_id === ch.id)
            .reduce((sum, c) => sum + (this.unreadCounts[c.code] || 0), 0);
          if (subTotal > 0) {
            let bubble = el.querySelector('.channel-badge-bubble');
            if (!bubble) {
              bubble = document.createElement('span');
              bubble.className = 'channel-badge channel-badge-bubble';
              el.appendChild(bubble);
            }
            bubble.textContent = subTotal > 99 ? '99+' : subTotal;
          }
        } else {
          // Remove the parent bubble when expanding; individual sub-channel badges are now visible
          const bubble = el.querySelector('.channel-badge-bubble');
          if (bubble) bubble.remove();
        }
        this._updateNestedIndicators();
      });
    }

    const count = (ch.code in this.unreadCounts) ? this.unreadCounts[ch.code] : (ch.unreadCount || 0);
    if (count > 0) {
      const badge = document.createElement('span');
      badge.className = 'channel-badge' + (isAnnouncement ? ' announcement-badge' : '');
      badge.textContent = count > 99 ? '99+' : count;
      el.appendChild(badge);
    }
    // Thread @mention indicator (bell, distinct from unread bubble)
    const tmCount = ((this._threadMentions || {})[ch.code] || []).length;
    if (tmCount > 0) {
      const bell = document.createElement('span');
      bell.className = 'channel-badge thread-mention-badge';
      bell.title = `${tmCount} mention${tmCount === 1 ? '' : 's'} in thread${tmCount === 1 ? '' : 's'}`;
      bell.textContent = `🔔${tmCount > 9 ? '9+' : tmCount}`;
      el.appendChild(bell);
    }

    el.addEventListener('click', () => {
      // Clicking the forum you are already in, with one of its topics open,
      // goes back to the topic list (#5688).
      if (ch.code === this.currentChannel && this._activeThreadParent && this._isForumChannel?.(ch.code)) this._closeThread();
      this.switchChannel(ch.code);
    });
    // Double-click to join voice in the channel (blocked for text-only)
    el.addEventListener('dblclick', () => {
      const _dblCh = this.channels.find(c => c.code === ch.code);
      if (_dblCh && _dblCh.voice_enabled === 0) return;
      if (!this.user?.isAdmin && !this.user?.isGuest && !this._hasPerm('use_voice')) return;
      this.switchChannel(ch.code);
      setTimeout(() => this._joinVoice(), 300);
    });
    // Right-click to open context menu
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const btn = el.querySelector('.channel-more-btn');
      if (btn) this._openChannelCtxMenu(ch.code, btn);
    });
    return el;
  };

  // ── Channels toggle (collapsible) ──
  const channelsCollapsed = localStorage.getItem('haven_channels_collapsed') === 'true';
  const channelsArrow = document.getElementById('channels-toggle-arrow');
  if (channelsArrow) {
    channelsArrow.classList.toggle('collapsed', channelsCollapsed);
  }

  // Set up channels toggle click (only once)
  if (!this._channelsToggleBound) {
    this._channelsToggleBound = true;
    document.getElementById('channels-toggle')?.addEventListener('click', (e) => {
      // Ignore clicks on the organize button or sub-panel button inside the header
      if (e.target.closest('#organize-channels-btn')) return;
      if (e.target.closest('#sub-channel-panel-btn')) return;
      const nowCollapsed = list.style.display !== 'none';
      list.style.display = nowCollapsed ? 'none' : '';
      const arrow = document.getElementById('channels-toggle-arrow');
      if (arrow) arrow.classList.toggle('collapsed', nowCollapsed);
      localStorage.setItem('haven_channels_collapsed', nowCollapsed);
      // Adjust pane flex so DMs fill when channels collapsed
      const channelsPane = document.getElementById('channels-pane');
      const dmPane = document.getElementById('dm-pane');
      if (nowCollapsed) {
        channelsPane.style.flex = '0 0 auto';
        dmPane.style.flex = '1 1 0';
      } else {
        const savedRatio = localStorage.getItem('haven_sidebar_split_ratio');
        const ratio = savedRatio ? parseFloat(savedRatio) : 0.6;
        channelsPane.style.flex = `${ratio} 1 0`;
        dmPane.style.flex = `${1 - ratio} 1 0`;
      }
    });
    // Organize Channels button (admin only)
    document.getElementById('organize-channels-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this._openOrganizeModal(null, true); // server-level mode
    });
    // Sub-channel subscriptions panel button
    document.getElementById('sub-channel-panel-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this._openSubChannelPanel();
    });
  }
  if (channelsCollapsed) {
    list.style.display = 'none';
    const cp = document.getElementById('channels-pane');
    const dp = document.getElementById('dm-pane');
    if (cp) cp.style.flex = '0 0 auto';
    if (dp) dp.style.flex = '1 1 0';
  }

  // ── Render channels grouped by category (case-insensitive) ──
  const categories = new Map();
  const _catCanonical = new Map(); // lowercase -> first-seen casing
  parentChannels.forEach(ch => {
    const raw = ch.category || '';
    const key = raw.toLowerCase();
    if (!_catCanonical.has(key)) _catCanonical.set(key, raw);
    const cat = _catCanonical.get(key);
    if (!categories.has(cat)) categories.set(cat, []);
    categories.get(cat).push(ch);
  });

  const sortedCats = [...categories.keys()].sort((a, b) => {
    const keyA = a || '__untagged__';
    const keyB = b || '__untagged__';
    if (serverCatSort === 'manual') {
      const iA = serverCatOrder.indexOf(keyA); const iB = serverCatOrder.indexOf(keyB);
      if (iA !== -1 || iB !== -1) {
        if (iA === -1) return 1; if (iB === -1) return -1;
        return iA - iB;
      }
    }
    // Default: untagged first (empty string), then alphabetical
    if (!a) return -1; if (!b) return 1;
    if (serverCatSort === 'za') return b.localeCompare(a);
    return a.localeCompare(b);
  });

  for (const cat of sortedCats) {
    const catKey = cat || '';
    const catCollapsed = cat ? localStorage.getItem(`haven_cat_collapsed_${cat.toLowerCase()}`) === 'true' : false;

    if (cat) {
      const catLabel = document.createElement('h5');
      catLabel.className = 'section-label category-label';
      catLabel.style.cssText = 'padding:10px 12px 4px;font-size:0.7rem;text-transform:uppercase;letter-spacing:0.05em;opacity:0.5;user-select:none;cursor:pointer;display:flex;align-items:center;gap:4px';
      catLabel.dataset.category = cat;
      const arrow = document.createElement('span');
      arrow.className = 'cat-collapse-arrow' + (catCollapsed ? ' collapsed' : '');
      arrow.textContent = '▾';
      catLabel.appendChild(arrow);
      const catText = document.createElement('span');
      catText.textContent = cat;
      catLabel.appendChild(catText);
      list.appendChild(catLabel);

      catLabel.addEventListener('click', () => {
        const nowCollapsed = arrow.classList.toggle('collapsed');
        localStorage.setItem(`haven_cat_collapsed_${cat.toLowerCase()}`, nowCollapsed);
        list.querySelectorAll(`[data-cat-group="${CSS.escape(cat)}"]`).forEach(el => {
          el.style.display = nowCollapsed ? 'none' : '';
        });
        // Toggle sub-channel items within this category too
        list.querySelectorAll(`[data-cat-sub-group="${CSS.escape(cat)}"]`).forEach(el => {
          el.style.display = nowCollapsed ? 'none' : '';
        });
        // Update unread badge on category label
        const badge = catLabel.querySelector('.cat-unread-badge');
        if (nowCollapsed) {
          const allChans = categories.get(cat) || [];
          let total = 0;
          allChans.forEach(c => {
            total += this.unreadCounts[c.code] || 0;
            (subChannelMap[c.id] || []).forEach(s => { total += this.unreadCounts[s.code] || 0; });
          });
          if (total > 0) {
            if (badge) { badge.textContent = total > 99 ? '99+' : total; badge.style.display = ''; }
            else {
              const b = document.createElement('span');
              b.className = 'channel-badge channel-badge-bubble cat-unread-badge';
              b.style.marginLeft = 'auto';
              b.textContent = total > 99 ? '99+' : total;
              catLabel.appendChild(b);
            }
          } else if (badge) badge.style.display = 'none';
        } else {
          if (badge) badge.style.display = 'none';
        }
        this._updateNestedIndicators();
      });
    }

    categories.get(cat).forEach(ch => {
      const chEl = renderChannelItem(ch, false);
      if (cat) {
        chEl.dataset.catGroup = cat;
        if (catCollapsed) chEl.style.display = 'none';
      }
      list.appendChild(chEl);
      const subs = subChannelMap[ch.id] || [];
      const isSubCollapsed = localStorage.getItem(`haven_subs_collapsed_${ch.code}`) === 'true';
      const subHasTags = subs.some(s => s.category);
      let lastSubTag = undefined;
      subs.forEach(sub => {
        if (subHasTags && (lastSubTag === undefined || (sub.category || '').toLowerCase() !== (lastSubTag || '').toLowerCase())) {
          const tagName = sub.category || t('channels.untagged');
          const tagKey = `haven_subtag_collapsed_${ch.code}_${tagName}`;
          const isTagCollapsed = localStorage.getItem(tagKey) === 'true';
          const tagLabel = document.createElement('div');
          tagLabel.className = 'sub-channel-item sub-tag-label';
          tagLabel.dataset.parentId = ch.id;
          tagLabel.dataset.parentCode = ch.code;
          tagLabel.dataset.tagName = tagName;
          if (cat) tagLabel.dataset.catSubGroup = cat;
          tagLabel.style.cssText = 'padding:4px 12px 2px 28px;font-size:0.65rem;text-transform:uppercase;letter-spacing:0.05em;opacity:0.35;user-select:none;font-weight:600;cursor:pointer;display:flex;align-items:center;gap:4px';
          const tagArrow = document.createElement('span');
          tagArrow.className = 'cat-collapse-arrow' + (isTagCollapsed ? ' collapsed' : '');
          tagArrow.textContent = '▾';
          tagLabel.appendChild(tagArrow);
          const tagText = document.createElement('span');
          tagText.textContent = sub.category || t('channels.untagged');
          tagLabel.appendChild(tagText);
          tagLabel.addEventListener('click', (e) => {
            e.stopPropagation();
            const nowCollapsed = tagArrow.classList.toggle('collapsed');
            localStorage.setItem(tagKey, nowCollapsed);
            list.querySelectorAll(`.sub-channel-item[data-parent-code="${ch.code}"][data-sub-tag="${CSS.escape(tagName)}"]`).forEach(el => {
              el.style.display = nowCollapsed ? 'none' : '';
            });
            this._updateNestedIndicators();
          });
          if (isSubCollapsed || catCollapsed) tagLabel.style.display = 'none';
          list.appendChild(tagLabel);
          lastSubTag = sub.category;
        }
        const subEl = renderChannelItem(sub, true);
        if (cat) subEl.dataset.catSubGroup = cat;
        if (subHasTags) {
          subEl.dataset.parentCode = ch.code;
          subEl.dataset.subTag = sub.category || t('channels.untagged');
          const subTagKey = `haven_subtag_collapsed_${ch.code}_${subEl.dataset.subTag}`;
          if (localStorage.getItem(subTagKey) === 'true') subEl.style.display = 'none';
        }
        if (isSubCollapsed || catCollapsed) subEl.style.display = 'none';
        list.appendChild(subEl);
      });

      // If collapsed and sub-channels have unreads, bubble a badge onto the parent
      if (isSubCollapsed && subs.length) {
        const subTotal = subs.reduce((sum, s) => {
          const cnt = (s.code in this.unreadCounts) ? this.unreadCounts[s.code] : (s.unreadCount || 0);
          return sum + cnt;
        }, 0);
        if (subTotal > 0) {
          const parentEl = list.querySelector(`.channel-item[data-code="${ch.code}"]`);
          if (parentEl) {
            const bubble = document.createElement('span');
            bubble.className = 'channel-badge channel-badge-bubble';
            bubble.textContent = subTotal > 99 ? '99+' : subTotal;
            parentEl.appendChild(bubble);
          }
        }
      }
    });

    // Show unread badge on collapsed category at render time
    if (cat && catCollapsed) {
      const allChans = categories.get(cat) || [];
      let total = 0;
      allChans.forEach(c => {
        total += this.unreadCounts[c.code] || 0;
        (subChannelMap[c.id] || []).forEach(s => { total += this.unreadCounts[s.code] || 0; });
      });
      if (total > 0) {
        const catEl = list.querySelector(`[data-category="${CSS.escape(cat)}"]`);
        if (catEl) {
          const b = document.createElement('span');
          b.className = 'channel-badge channel-badge-bubble cat-unread-badge';
          b.style.marginLeft = 'auto';
          b.textContent = total > 99 ? '99+' : total;
          catEl.appendChild(b);
        }
      }
    }
  }

  // ── "Create Temp Channel" button (visible if user has create_temp_channel perm) ──
  if (this.user?.isAdmin || this._hasPerm('create_temp_channel')) {
    const tempBtn = document.createElement('div');
    tempBtn.className = 'channel-item temp-channel-create-btn';
    tempBtn.style.cssText = 'opacity:0.5;cursor:pointer;padding:4px 12px;font-size:0.8rem;display:flex;align-items:center;gap:6px';
    tempBtn.innerHTML = `<span style="font-size:0.9rem">➕</span><span>${t('channels.create_temp_channel')}</span>`;
    tempBtn.title = t('channels.create_temp_channel_title');
    tempBtn.addEventListener('click', async () => {
      // One create form for every kind of channel: open it with Temporary
      // ticked instead of a second prompt that only made a temp channel.
      const form = document.getElementById('create-section-body');
      const nameInput = document.getElementById('new-channel-name');
      const tmp = document.getElementById('new-channel-temporary');
      if (form && nameInput && tmp) {
        form.style.display = '';
        const arrow = document.getElementById('create-section-arrow');
        if (arrow) arrow.textContent = '▾';
        tmp.checked = true;
        tmp.dispatchEvent(new Event('change'));
        nameInput.focus();
        nameInput.scrollIntoView({ block: 'center' });
        return;
      }
      const name = await this._showPromptModal(
        t('channels.create_temp_channel_title'),
        t('channels.create_temp_channel_hint')
      );
      if (name && name.trim()) {
        this.socket.emit('create-temp-channel', { name: name.trim() });
      }
    });
    list.appendChild(tempBtn);
  }

  // ── Hidden channels restore bar (#5409) ──
  // Only counts hidden channels that still exist and aren't the one currently
  // being viewed (a hidden current channel is still shown in the list).
  const _hiddenExisting = this._getHiddenChannels()
    .filter(code => code !== this.currentChannel && this.channels.some(c => c.code === code));
  if (_hiddenExisting.length) {
    const hiddenBar = document.createElement('div');
    hiddenBar.className = 'channel-item hidden-channels-bar';
    hiddenBar.style.cssText = 'opacity:0.5;cursor:pointer;padding:4px 12px;font-size:0.8rem;display:flex;align-items:center;gap:6px';
    hiddenBar.innerHTML = `<span style="font-size:0.9rem">🙈</span><span>${t('channels.hidden_channels_count', { count: _hiddenExisting.length })}</span>`;
    hiddenBar.title = t('channels.hidden_channels_restore_title');
    hiddenBar.addEventListener('click', () => this._openHiddenChannelsModal());
    list.appendChild(hiddenBar);
  }

  // ── DM section (separate pane) ──
  const dmList = document.getElementById('dm-list');
  if (dmList) {
    dmList.innerHTML = '';
    const dmCollapsed = localStorage.getItem('haven_dm_collapsed') === 'true';
    const dmArrow = document.getElementById('dm-toggle-arrow');

    // Set up DM toggle click (only once)
    if (!this._dmToggleBound) {
      this._dmToggleBound = true;
      document.getElementById('dm-toggle-header')?.addEventListener('click', (e) => {
        if (e.target.closest('#organize-dms-btn')) return;
        const nowCollapsed = dmList.style.display !== 'none';
        dmList.style.display = nowCollapsed ? 'none' : '';
        const arrow = document.getElementById('dm-toggle-arrow');
        if (arrow) arrow.classList.toggle('collapsed', nowCollapsed);
        localStorage.setItem('haven_dm_collapsed', nowCollapsed);
        // Shrink/restore the DM pane so channels get the freed space
        const dp = document.getElementById('dm-pane');
        const cp = document.getElementById('channels-pane');
        if (nowCollapsed) {
          if (dp) dp.style.flex = '0 0 auto';
          if (cp) cp.style.flex = '1 1 0';
        } else {
          const r = parseFloat(localStorage.getItem('haven_sidebar_split_ratio')) || 0.6;
          if (dp) dp.style.flex = `${1 - r} 1 0`;
          if (cp) cp.style.flex = `${r} 1 0`;
        }
      });
    }

    if (dmArrow) dmArrow.classList.toggle('collapsed', dmCollapsed);
    if (dmCollapsed) {
      dmList.style.display = 'none';
      const dp = document.getElementById('dm-pane');
      const cp = document.getElementById('channels-pane');
      if (dp) dp.style.flex = '0 0 auto';
      if (cp) cp.style.flex = '1 1 0';
    }

    // Update unread badge
    const totalUnread = dmChannels.reduce((sum, ch) => sum + ((ch.code in this.unreadCounts) ? this.unreadCounts[ch.code] : (ch.unreadCount || 0)), 0);
    const badge = document.getElementById('dm-unread-badge');
    if (badge) {
      if (totalUnread > 0) {
        badge.textContent = totalUnread > 99 ? '99+' : totalUnread;
        badge.style.display = '';
      } else {
        badge.style.display = 'none';
      }
    }

    // Show/hide DM pane
    const dmPane = document.getElementById('dm-pane');
    if (dmPane) dmPane.style.display = dmChannels.length ? '' : 'none';

    // ── DM categorization (client-side localStorage) ──
    const dmAssignments = JSON.parse(localStorage.getItem('haven_dm_assignments') || '{}');
    const dmCategories = JSON.parse(localStorage.getItem('haven_dm_categories') || '{}');
    const dmSortMode = localStorage.getItem('haven_dm_sort_mode') || 'manual';
    const dmOrder = JSON.parse(localStorage.getItem('haven_dm_order') || '[]');

    const getDmName = (ch) => ch.is_group ? this._groupName(ch) : ch.dm_target ? this._getNickname(ch.dm_target.id, ch.dm_target.username) : t('channels.unknown_user');

    // Sort DMs by saved order first, then append any new ones
    let sortedDms = [];
    if (dmSortMode === 'manual' && dmOrder.length) {
      for (const code of dmOrder) {
        const ch = dmChannels.find(c => c.code === code);
        if (ch) sortedDms.push(ch);
      }
      for (const ch of dmChannels) {
        if (!sortedDms.includes(ch)) sortedDms.push(ch);
      }
    } else if (dmSortMode === 'alpha') {
      sortedDms = [...dmChannels].sort((a, b) => getDmName(a).localeCompare(getDmName(b)));
    } else if (dmSortMode === 'recent') {
      sortedDms = [...dmChannels].sort((a, b) => (b.last_activity || 0) - (a.last_activity || 0));
    } else {
      sortedDms = [...dmChannels];
    }

    // Collect active tag names from assigned DMs
    const activeTags = [...new Set(sortedDms.map(c => dmAssignments[c.code]).filter(Boolean))].sort();
    const hasDmTags = activeTags.length > 0;

    const renderDmItem = (ch) => {
      const el = document.createElement('div');
      el.className = 'channel-item dm-item' + (ch.code === this.currentChannel ? ' active' : '');
      el.dataset.code = ch.code;
      const dmName = getDmName(ch);
      el.innerHTML = `
        <span class="channel-hash">${ch.is_group ? '👥' : '@'}</span>
        <span class="channel-name">${this._escapeHtml(dmName)}</span>
      `;
      const count = (ch.code in this.unreadCounts) ? this.unreadCounts[ch.code] : (ch.unreadCount || 0);
      if (count > 0) {
        const bdg = document.createElement('span');
        bdg.className = 'channel-badge';
        bdg.textContent = count > 99 ? '99+' : count;
        el.appendChild(bdg);
      }
      // "..." more button for DM context menu
      const moreBtn = document.createElement('button');
      moreBtn.className = 'channel-more-btn dm-more-btn';
      moreBtn.textContent = '⋯';
      moreBtn.title = t('channels.more_options');
      moreBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._openDmCtxMenu(ch.code, moreBtn);
      });
      el.appendChild(moreBtn);
      // Right-click context menu
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this._openDmCtxMenu(ch.code, el, e);
      });
      el.addEventListener('click', () => {
        // Single-click on a DM opens it in a floating PiP panel overlaid
        // on the user's current channel. Does NOT switch channels.
        // Users can flip this in Settings → Chat: when "Open DMs in
        // fullscreen on single click" is on, single-click switches to the
        // full DM and double-click opens the PiP. (#5295)
        if (localStorage.getItem('haven_dm_fullscreen_default') === 'true') {
          this._closeDMPiP?.();
          this.switchChannel(ch.code);
        } else {
          this._openDMPiP?.(ch.code);
        }
        // On mobile, the sidebar covers the chat. Close it so the user
        // can actually see the DM they just picked.
        this._closeMobilePanels?.();
      });
      el.addEventListener('dblclick', () => {
        if (localStorage.getItem('haven_dm_fullscreen_default') === 'true') {
          this._openDMPiP?.(ch.code);
        } else {
          // Double-click switches to the full DM pane (legacy behavior).
          this._closeDMPiP?.();
          this.switchChannel(ch.code);
        }
        this._closeMobilePanels?.();
      });
      return el;
    };

    if (hasDmTags) {
      // Render by category groups
      for (const tag of activeTags) {
        const tagDms = sortedDms.filter(c => dmAssignments[c.code] === tag);
        if (!tagDms.length) continue;

        const catState = dmCategories[tag] || {};
        const isCollapsed = catState.collapsed || false;

        // Category header
        const header = document.createElement('div');
        header.className = 'dm-category-header';
        header.innerHTML = `<span class="dm-category-arrow${isCollapsed ? ' collapsed' : ''}">▾</span> <span class="dm-category-name">${this._escapeHtml(tag)}</span>`;
        header.style.cursor = 'pointer';
        header.addEventListener('click', () => {
          const cats = JSON.parse(localStorage.getItem('haven_dm_categories') || '{}');
          if (!cats[tag]) cats[tag] = {};
          cats[tag].collapsed = !cats[tag].collapsed;
          localStorage.setItem('haven_dm_categories', JSON.stringify(cats));
          this._renderChannels();
        });
        dmList.appendChild(header);

        for (const ch of tagDms) {
          const el = renderDmItem(ch);
          if (isCollapsed) el.style.display = 'none';
          el.dataset.dmTag = tag;
          dmList.appendChild(el);
        }
      }
      // Untagged DMs
      const untagged = sortedDms.filter(c => !dmAssignments[c.code]);
      if (untagged.length) {
        const uncatCats = JSON.parse(localStorage.getItem('haven_dm_categories') || '{}');
        const uncatCollapsed = uncatCats['__uncategorized__']?.collapsed || false;
        const header = document.createElement('div');
        header.className = 'dm-category-header';
        header.style.opacity = '0.5';
        header.style.cursor = 'pointer';
        header.innerHTML = `<span class="dm-category-arrow${uncatCollapsed ? ' collapsed' : ''}">▾</span> <span class="dm-category-name">${t('channels.uncategorized')}</span>`;
        header.addEventListener('click', () => {
          const cats = JSON.parse(localStorage.getItem('haven_dm_categories') || '{}');
          if (!cats['__uncategorized__']) cats['__uncategorized__'] = {};
          cats['__uncategorized__'].collapsed = !cats['__uncategorized__'].collapsed;
          localStorage.setItem('haven_dm_categories', JSON.stringify(cats));
          this._renderChannels();
        });
        dmList.appendChild(header);
        for (const ch of untagged) {
          const el = renderDmItem(ch);
          if (uncatCollapsed) el.style.display = 'none';
          dmList.appendChild(el);
        }
      }
    } else {
      // No tags: flat list (original behavior)
      sortedDms.forEach(ch => dmList.appendChild(renderDmItem(ch)));
    }
  }

  // Render voice indicators for channels with active voice users
  this._updateChannelVoiceIndicators();
  // Debounced refresh of voice counts to catch any missed updates during re-render
  clearTimeout(this._voiceCountRefreshTimer);
  this._voiceCountRefreshTimer = setTimeout(() => {
    if (this.socket?.connected) this.socket.emit('get-voice-counts');
  }, 600);

  // Set up drag-and-drop reordering
  this._setupChannelDragDrop();
  this._setupDmDragDrop();
  this._updateNestedIndicators();
},

// ── Keyboard Navigation ──────────────────────────────────

/**
 * Get all visible channels in visual (DOM) order.
 * Returns array of channel codes matching the sidebar ordering.
 */
_getVisualChannelOrder() {
  const codes = [];
  // Channels section
  document.querySelectorAll('#channel-list .channel-item:not([style*="display: none"])').forEach(el => {
    if (el.dataset.code) codes.push(el.dataset.code);
  });
  // DM section
  document.querySelectorAll('#dm-list .channel-item:not([style*="display: none"])').forEach(el => {
    if (el.dataset.code) codes.push(el.dataset.code);
  });
  return codes;
},

/**
 * Navigate to the next or previous channel in visual order.
 * @param {number} direction - 1 for next, -1 for previous
 */
_navigateChannel(direction) {
  const order = this._getVisualChannelOrder();
  if (!order.length) return;
  const idx = order.indexOf(this.currentChannel);
  const next = idx === -1 ? 0 : (idx + direction + order.length) % order.length;
  this.switchChannel(order[next]);
},

/**
 * Navigate to the next or previous unread channel in visual order.
 * @param {number} direction - 1 for next, -1 for previous
 */
_navigateUnreadChannel(direction) {
  const order = this._getVisualChannelOrder();
  if (!order.length) return;
  const idx = order.indexOf(this.currentChannel);
  const start = idx === -1 ? 0 : idx;
  for (let i = 1; i <= order.length; i++) {
    const check = (start + i * direction + order.length) % order.length;
    if ((this.unreadCounts[order[check]] || 0) > 0) {
      this.switchChannel(order[check]);
      return;
    }
  }
},

/**
 * Open a Ctrl+K style quick channel/DM switcher overlay.
 */
_openQuickSwitcher() {
  // Remove any existing overlay
  document.getElementById('quick-switcher-overlay')?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'quick-switcher-overlay';
  overlay.innerHTML = `
    <div class="quick-switcher-box">
      <input type="text" id="quick-switcher-input" placeholder="${t('channels.quick_switcher_placeholder')}" autocomplete="off" spellcheck="false">
      <div id="quick-switcher-results"></div>
    </div>
  `;
  document.body.appendChild(overlay);

  const input = overlay.querySelector('#quick-switcher-input');
  const results = overlay.querySelector('#quick-switcher-results');
  let selectedIdx = 0;

  const allChannels = (this.channels || []).map(ch => ({
    code: ch.code,
    name: ch.is_dm && ch.is_group ? `👥 ${this._groupName(ch)}` : ch.is_dm && ch.dm_target
      ? `@ ${this._getNickname(ch.dm_target.id, ch.dm_target.username)}`
      : `# ${ch.name}`,
    isDm: ch.is_dm,
    unread: this.unreadCounts[ch.code] || 0,
  }));

  const render = (query) => {
    const q = query.toLowerCase();
    const filtered = q
      ? allChannels.filter(c => c.name.toLowerCase().includes(q))
      : allChannels.filter(c => c.unread > 0).concat(
          allChannels.filter(c => c.unread === 0)
        );
    const shown = filtered.slice(0, 12);
    selectedIdx = Math.min(selectedIdx, Math.max(0, shown.length - 1));
    results.innerHTML = shown.map((c, i) => `
      <div class="quick-switcher-item${i === selectedIdx ? ' selected' : ''}" data-code="${this._escapeHtml(c.code)}">
        <span class="qs-name">${this._escapeHtml(c.name)}</span>
        ${c.unread > 0 ? `<span class="qs-badge">${c.unread > 99 ? '99+' : c.unread}</span>` : ''}
      </div>
    `).join('');
    results.querySelectorAll('.quick-switcher-item').forEach(el => {
      el.addEventListener('click', () => { this.switchChannel(el.dataset.code); overlay.remove(); });
    });
  };

  input.addEventListener('input', () => { selectedIdx = 0; render(input.value); });
  input.addEventListener('keydown', (e) => {
    const items = results.querySelectorAll('.quick-switcher-item');
    if (e.key === 'ArrowDown') { e.preventDefault(); selectedIdx = Math.min(selectedIdx + 1, items.length - 1); render(input.value); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); selectedIdx = Math.max(selectedIdx - 1, 0); render(input.value); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const sel = items[selectedIdx];
      if (sel) { this.switchChannel(sel.dataset.code); overlay.remove(); }
    }
  });

  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  render('');
  setTimeout(() => input.focus(), 10);
},

};
