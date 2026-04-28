export default {

// ── Channel Management ────────────────────────────────

async switchChannel(code) {
  if (this.currentChannel === code) return;

  // Clear any pending image queue from previous channel
  this._clearImageQueue();

  // Voice persists across channel switches — no auto-disconnect

  this.currentChannel = code;
  // Reset pin indicator until message-history reports the count for this channel
  this._updatePinIndicator?.(this._pinnedCountByChannel?.[code] || 0);
  this._coupledToBottom = true;
  const jumpBtn = document.getElementById('jump-to-bottom');
  if (jumpBtn) jumpBtn.classList.remove('visible');
  const channel = this.channels.find(c => c.code === code);
  const isDm = channel && channel.is_dm;
  const displayName = isDm && channel.dm_target
    ? `@ ${this._getNickname(channel.dm_target.id, channel.dm_target.username)}`
    : channel ? `# ${channel.name}` : code;

  document.getElementById('channel-header-name').textContent = displayName;
  // Clear scramble cache so the effect picks up the new channel name
  const headerEl = document.getElementById('channel-header-name');
  if (headerEl) { delete headerEl.dataset.originalText; headerEl._scrambling = false; }
  const displayCode = channel ? (channel.display_code || code) : code;
  const isMaskedCode = (displayCode === '••••••••');
  document.getElementById('channel-code-display').textContent = isDm ? '' : displayCode;
  document.getElementById('copy-code-btn').style.display = (isDm || isMaskedCode) ? 'none' : 'inline-flex';

  // Show channel code settings gear for admins / users with create_channel on non-DM channels
  const codeSettingsBtn = document.getElementById('channel-code-settings-btn');
  if (codeSettingsBtn) {
    codeSettingsBtn.style.display = (!isDm && (this.user.isAdmin || this._hasPerm('create_channel'))) ? 'inline-flex' : 'none';
  }

  // Show the header actions box
  const actionsBox = document.getElementById('header-actions-box');
  if (actionsBox) actionsBox.style.display = 'flex';
  // Update voice button state — persist controls if in voice anywhere
  if (this.voice && this.voice.inVoice) {
    this._updateVoiceButtons(true);
    // If viewing a different channel from the one we're in voice in, show "Join Voice" instead of "Voice Active"
    if (this.voice.currentChannel !== code) {
      const _canVoice = this.user?.isAdmin || this._hasPerm('use_voice');
      const indic = document.getElementById('voice-active-indicator');
      if (indic) indic.style.display = 'none';
      const _scJoinBtn = document.getElementById('voice-join-btn');
      if (_scJoinBtn) _scJoinBtn.style.display = (channel && channel.voice_enabled === 0) || !_canVoice ? 'none' : 'inline-flex';
      const mobileJoin = document.getElementById('voice-join-mobile');
      if (mobileJoin) mobileJoin.style.display = (channel && channel.voice_enabled === 0) || !_canVoice ? 'none' : '';
    }
  } else {
    // Show just the join button (not the indicator), but hide it for text-only channels or users without voice permission
    const _scJoinBtn = document.getElementById('voice-join-btn');
    const _canVoice = this.user?.isAdmin || this._hasPerm('use_voice');
    if (_scJoinBtn) _scJoinBtn.style.display = (channel && channel.voice_enabled === 0) || !_canVoice ? 'none' : 'inline-flex';
    const indic = document.getElementById('voice-active-indicator');
    if (indic) indic.style.display = 'none';
    const vp = document.getElementById('voice-panel');
    if (vp) vp.style.display = 'none';
    const mobileJoin = document.getElementById('voice-join-mobile');
    if (mobileJoin) mobileJoin.style.display = (channel && channel.voice_enabled === 0) || !_canVoice ? 'none' : '';
  }
  document.getElementById('search-toggle-btn').style.display = '';
  document.getElementById('pinned-toggle-btn').style.display = '';
  // Auto-close pinned panel on channel switch so stale pins don't linger
  document.getElementById('pinned-panel').style.display = 'none';

  // Show "Select messages" button for admins/mods on non-DM channels
  const moveSelectBtn = document.getElementById('move-select-btn');
  if (moveSelectBtn) {
    const canMove = !isDm && (this.user.isAdmin || this._canModerate());
    moveSelectBtn.style.display = canMove ? 'inline-flex' : 'none';
  }
  // Exit selection mode when switching channels
  if (this._moveSelectionActive) this._exitMoveSelectionMode();

  // Show/hide topic bar
  this._updateTopicBar(channel?.topic || '');

  // Show/hide message input — keep upload button visible for media-only channels
  const msgInputArea = document.getElementById('message-input-area');
  const _textOff = channel && channel.text_enabled === 0;
  const _mediaOff = channel && channel.media_enabled === 0;
  // Read-only: hide input unless user is admin or has read_only_override permission
  const _isReadOnly = channel && channel.read_only === 1 && !this.user?.isAdmin && !this._hasPerm('read_only_override');
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
  // Upload button tied to media toggle
  const _uploadBtn = document.getElementById('upload-btn');
  if (_uploadBtn) _uploadBtn.style.display = _mediaOff ? 'none' : '';
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

  document.getElementById('status-channel').textContent = isDm && channel.dm_target
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
  // Belt-and-braces mark-read: if the server already told us the latest
  // message id for this channel (channels-list snapshot), fire a
  // mark-read immediately so opening a DM with an empty render or one
  // that fails to render before the user navigates away is still
  // recorded as read.  The render-time _markRead in _renderMessages
  // still fires for the message-id we actually painted; this just
  // covers the gap where rendering hasn't happened yet.  (Server uses
  // MAX(last_read, incoming) so an older id from the snapshot can't
  // ever clobber a newer real id.)
  if (channel && channel.latestMessageId) {
    this._markRead(channel.latestMessageId);
  }
  // E2E: fetch DM partner's public key BEFORE requesting messages
  if (isDm && channel) await this._fetchDMPartnerKey(channel);
  this.socket.emit('get-messages', { code });
  this.socket.emit('get-channel-members', { code });
  this.socket.emit('request-voice-users', { code });
  this._clearReply();
  this._closeThread();

  // Auto-focus the message input for quick typing.
  // Skip on touch devices: focusing an input opens the on-screen keyboard, which
  // shrinks the visual viewport and can leave the layout shifted up after the
  // keyboard closes (especially on Android web — see issue #5285).
  const msgInput = document.getElementById('message-input');
  const isTouchDevice = window.matchMedia('(hover: none) and (pointer: coarse)').matches
                     || window.matchMedia('(pointer: coarse)').matches
                     || 'ontouchstart' in window
                     || navigator.maxTouchPoints > 0;
  if (msgInput && !isTouchDevice) setTimeout(() => msgInput.focus(), 50);

  // Show E2E encryption menu only in DM channels
  const e2eWrapper = document.getElementById('e2e-menu-wrapper');
  if (e2eWrapper) e2eWrapper.style.display = isDm ? '' : 'none';
  // Close dropdown when switching channels
  const e2eDropdown = document.getElementById('e2e-dropdown');
  if (e2eDropdown) e2eDropdown.style.display = 'none';
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
  const canEdit = this.user.isAdmin || this._hasPerm('set_channel_topic');
  if (topic) {
    bar.textContent = topic;
    bar.style.display = 'block';
    bar.title = canEdit ? t('channels.topic_edit_hint') : topic;
    bar.onclick = canEdit ? () => this._editTopic() : null;
    bar.style.cursor = canEdit ? 'pointer' : 'default';
  } else {
    if (canEdit) {
      bar.textContent = t('channels.topic_placeholder');
      bar.style.display = 'block';
      bar.style.opacity = '';
      bar.style.color = 'var(--text-muted)';
      bar.style.cursor = 'pointer';
      bar.onclick = () => this._editTopic();
    } else {
      bar.style.display = 'none';
    }
  }
  if (topic) { bar.style.opacity = '1'; bar.style.color = ''; }
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
  if (mobileJoin) mobileJoin.style.display = 'none';
  const actionsBox = document.getElementById('header-actions-box');
  if (actionsBox) actionsBox.style.display = 'none';
  document.getElementById('status-channel').textContent = t('channels.status_none');
  document.getElementById('status-online-count').textContent = '0';
  const topicBar = document.getElementById('channel-topic-bar');
  if (topicBar) topicBar.style.display = 'none';
},

/* ── Channel context menu helpers ─────────────────────── */
_initChannelContextMenu() {
  this._ctxMenuChannel = null;
  this._ctxMenuEl = document.getElementById('channel-ctx-menu');
  // Delegate clicks on "..." buttons inside the channel list
  document.getElementById('channel-list')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.channel-more-btn');
    if (!btn) return;
    e.stopPropagation();
    const code = btn.closest('.channel-item')?.dataset.code;
    if (code) this._openChannelCtxMenu(code, btn);
  });
},

_openChannelCtxMenu(code, btnEl) {
  this._ctxMenuChannel = code;
  const menu = this._ctxMenuEl;
  if (!menu) return;
  // Show/hide admin-only items (also allow users with create_channel perm)
  const isAdmin = this.user && this.user.isAdmin;
  const canManageChannels = isAdmin || this._hasPerm('create_channel');
  const isMod = isAdmin || this._canModerate();
  menu.querySelectorAll('.admin-only').forEach(el => {
    el.style.display = canManageChannels ? '' : 'none';
  });
  // Show delete button for users with delete_channel permission even if not admin
  const deleteBtn = menu.querySelector('[data-action="delete"]');
  if (deleteBtn && !canManageChannels && this._hasPerm('delete_channel')) {
    deleteBtn.style.display = '';
  }
  // Also show delete for users who created a temp channel
  if (deleteBtn && !canManageChannels && !this._hasPerm('delete_channel')) {
    const ch = this.channels.find(c => c.code === code);
    if (ch && ch.is_temp_voice && ch.created_by === this.user?.id) {
      deleteBtn.style.display = '';
    }
  }
  menu.querySelectorAll('.mod-only').forEach(el => {
    el.style.display = isMod ? '' : 'none';
  });
  // Always reset the Channel Functions panel to closed when the menu opens
  const cfnPanel = document.getElementById('channel-functions-panel');
  if (cfnPanel) cfnPanel.style.display = 'none';
  const cfnArrow = menu.querySelector('[data-action="channel-functions"] .cfn-arrow');
  if (cfnArrow) cfnArrow.textContent = '▶';
  // Show/hide "Mark as Read" based on unread count
  const markReadBtn = menu.querySelector('[data-action="mark-read"]');
  if (markReadBtn) markReadBtn.style.display = (this.unreadCounts[code] > 0) ? '' : 'none';
  // Show "Create Sub-channel" for mods OR users with create_channel / manage_sub_channels perm
  const ch = this.channels.find(c => c.code === code);
  const createSubBtn = menu.querySelector('[data-action="create-sub-channel"]');
  if (createSubBtn) {
    const canCreateSub = isMod || this._hasPerm('manage_sub_channels') || this._hasPerm('create_channel');
    createSubBtn.style.display = (canCreateSub && ch && !ch.parent_channel_id) ? '' : 'none';
  }
  // Hide "Leave Channel" for admins (always in all channels)
  const leaveBtn = menu.querySelector('[data-action="leave-channel"]');
  if (leaveBtn) leaveBtn.style.display = isAdmin ? 'none' : '';
  // Show "Organize" only for parent channels that have sub-channels
  const organizeBtn = menu.querySelector('[data-action="organize"]');
  if (organizeBtn) {
    const hasSubs = ch && !ch.parent_channel_id && this.channels.some(c => c.parent_channel_id === ch.id);
    organizeBtn.style.display = (canManageChannels && hasSubs) ? '' : 'none';
  }
  // Show "Move to…" for channels that can become sub-channels (no children of their own)
  const moveToBtn = menu.querySelector('[data-action="move-to-parent"]');
  if (moveToBtn && ch) {
    const hasChildren = this.channels.some(c => c.parent_channel_id === ch.id);
    // Can move if: admin, not a DM, and has no children (can't nest 2 levels)
    moveToBtn.style.display = (canManageChannels && !ch.is_dm && !hasChildren) ? '' : 'none';
  }
  // Show "Promote to Channel" only for sub-channels
  const promoteBtn = menu.querySelector('[data-action="promote-channel"]');
  if (promoteBtn && ch) {
    promoteBtn.style.display = (canManageChannels && ch.parent_channel_id) ? '' : 'none';
  }
  // Update Channel Functions panel with current channel values
  if (canManageChannels) this._updateChannelFunctionsPanel(ch);
  // Update mute label
  const muted = JSON.parse(localStorage.getItem('haven_muted_channels') || '[]');
  const muteBtn = menu.querySelector('[data-action="mute"]');
  if (muteBtn) muteBtn.textContent = muted.includes(code) ? `🔕 ${t('channels.unmute_channel')}` : `🔔 ${t('channels.mute_channel')}`;
  // Show/hide voice options based on current voice state
  const joinVoiceBtn = menu.querySelector('[data-action="join-voice"]');
  const leaveVoiceBtn = menu.querySelector('[data-action="leave-voice"]');
  const inVoice = this.voice && this.voice.inVoice;
  const inThisChannel = inVoice && this.voice.currentChannel === code;
  const isVoiceOff = ch && ch.voice_enabled === 0;
  const _noVP = !this.user?.isAdmin && !this._hasPerm('use_voice');
  if (joinVoiceBtn) joinVoiceBtn.style.display = (inThisChannel || isVoiceOff || _noVP) ? 'none' : '';
  if (leaveVoiceBtn) leaveVoiceBtn.style.display = inVoice ? '' : 'none';
  // Position near the button
  const rect = btnEl.getBoundingClientRect();
  menu._anchorEl = btnEl;
  menu.style.display = 'block';
  menu.style.top  = rect.bottom + 4 + 'px';
  menu.style.left = rect.left + 'px';
  // Keep menu inside viewport
  requestAnimationFrame(() => {
    const mr = menu.getBoundingClientRect();
    if (mr.right > window.innerWidth) menu.style.left = (window.innerWidth - mr.width - 8) + 'px';
    if (mr.bottom > window.innerHeight) menu.style.top = (rect.top - mr.height - 4) + 'px';
  });
},

_setCfnBadge(fn, isOn, text) {
  const row = document.querySelector(`.cfn-row[data-fn="${fn}"]`);
  if (!row) return;
  let badge = row.querySelector('.cfn-badge');
  if (!badge) {
    // Badge was replaced by an input — restore it
    const input = row.querySelector('.cfn-input');
    badge = document.createElement('span');
    badge.className = 'cfn-badge';
    if (input) input.replaceWith(badge);
    else return;
  }
  badge.textContent = text;
  badge.className = 'cfn-badge ' + (isOn ? 'cfn-on' : 'cfn-off');
},

_updateChannelFunctionsPanel(ch) {
  if (!ch) return;
  // Voice & text toggles
  const voiceOff = ch.voice_enabled === 0;
  const textOff = ch.text_enabled === 0;
  this._setCfnBadge('voice', !voiceOff, voiceOff ? 'OFF' : 'ON');
  this._setCfnBadge('text', !textOff, textOff ? 'OFF' : 'ON');
  // Basic toggles
  this._setCfnBadge('streams', ch.streams_enabled !== 0, ch.streams_enabled !== 0 ? 'ON' : 'OFF');
  this._setCfnBadge('music', ch.music_enabled !== 0, ch.music_enabled !== 0 ? 'ON' : 'OFF');
  this._setCfnBadge('media', ch.media_enabled !== 0, ch.media_enabled !== 0 ? 'ON' : 'OFF');
  // Read-only toggle
  const isReadOnly = ch.read_only === 1;
  this._setCfnBadge('read-only', isReadOnly, isReadOnly ? 'ON' : 'OFF');
  const interval = ch.slow_mode_interval || 0;
  this._setCfnBadge('slow-mode', interval > 0, interval > 0 ? `${interval}s` : 'OFF');
  this._setCfnBadge('cleanup-exempt', ch.cleanup_exempt === 1, ch.cleanup_exempt === 1 ? 'ON' : 'OFF');
  // Streams and music greyed when voice is disabled (they depend on voice)
  const streamsRow = document.querySelector('.cfn-row[data-fn="streams"]');
  if (streamsRow) streamsRow.classList.toggle('cfn-disabled', voiceOff);
  const musicRow = document.querySelector('.cfn-row[data-fn="music"]');
  if (musicRow) musicRow.classList.toggle('cfn-disabled', voiceOff);
  // Voice Limit (0 = unlimited = ∞; minimum meaningful limit is 2)
  const limit = ch.voice_user_limit || 0;
  this._setCfnBadge('user-limit', limit >= 2, limit >= 2 ? String(limit) : '∞');
  // User limit greyed when voice is disabled
  const userLimitRow = document.querySelector('.cfn-row[data-fn="user-limit"]');
  if (userLimitRow) userLimitRow.classList.toggle('cfn-disabled', voiceOff);
  // Voice Bitrate (0 = auto / no cap)
  const bitrate = ch.voice_bitrate || 0;
  this._setCfnBadge('voice-bitrate', bitrate > 0, bitrate > 0 ? bitrate + ' kbps' : 'Auto');
  // Voice bitrate greyed when voice is disabled
  const bitrateRow = document.querySelector('.cfn-row[data-fn="voice-bitrate"]');
  if (bitrateRow) bitrateRow.classList.toggle('cfn-disabled', voiceOff);
  // Announcement channel
  const isAnnouncement = ch.notification_type === 'announcement';
  this._setCfnBadge('announcement', isAnnouncement, isAnnouncement ? 'ON' : 'OFF');
  // Self Destruct timer
  const hasExpiry = !!ch.expires_at;
  if (hasExpiry) {
    const hoursLeft = Math.max(1, Math.round((new Date(ch.expires_at) - Date.now()) / 3600000));
    this._setCfnBadge('self-destruct', true, `${hoursLeft}h`);
  } else {
    this._setCfnBadge('self-destruct', false, 'OFF');
  }
  // AFK sub-channel (only for parent channels)
  const isParent = !ch.parent_channel_id && !ch.is_dm;
  const hasSubs = isParent && (this.channels || []).some(c => c.parent_channel_id === ch.id);
  document.querySelectorAll('.cfn-afk-row, .cfn-afk-divider').forEach(el => {
    el.style.display = (isParent && hasSubs) ? '' : 'none';
  });
  if (isParent && hasSubs) {
    const afkSubCode = ch.afk_sub_code || '';
    const afkTimeout = ch.afk_timeout_minutes || 0;
    if (afkSubCode) {
      const sub = (this.channels || []).find(c => c.code === afkSubCode);
      this._setCfnBadge('afk-sub', true, sub ? sub.name : afkSubCode.slice(0, 6));
    } else {
      this._setCfnBadge('afk-sub', false, 'OFF');
    }
    this._setCfnBadge('afk-timeout', afkTimeout > 0, afkTimeout > 0 ? `${afkTimeout}m` : 'OFF');
  }
},

_closeChannelCtxMenu() {
  if (this._ctxMenuEl) this._ctxMenuEl.style.display = 'none';
  const cfnPanel = document.getElementById('channel-functions-panel');
  if (cfnPanel) cfnPanel.style.display = 'none';
  this._ctxMenuChannel = null;
},

/* ── DM context menu helpers ──────────────────────────── */
_initDmContextMenu() {
  this._dmCtxMenuEl = document.getElementById('dm-ctx-menu');
  this._dmCtxMenuCode = null;

  // Mark DM as read
  document.querySelector('[data-action="dm-mark-read"]')?.addEventListener('click', () => {
    const code = this._dmCtxMenuCode;
    if (!code) return;
    this._closeDmCtxMenu();
    this.unreadCounts[code] = 0;
    this._updateBadge(code);
    this.socket.emit('mark-read-channel', { code });
  });

  // Mute DM
  document.querySelector('[data-action="dm-mute"]')?.addEventListener('click', () => {
    const code = this._dmCtxMenuCode;
    if (!code) return;
    this._closeDmCtxMenu();
    const muted = JSON.parse(localStorage.getItem('haven_muted_channels') || '[]');
    const idx = muted.indexOf(code);
    if (idx >= 0) { muted.splice(idx, 1); this._showToast(t('channels.dm_unmuted'), 'success'); }
    else { muted.push(code); this._showToast(t('channels.dm_muted'), 'success'); }
    localStorage.setItem('haven_muted_channels', JSON.stringify(muted));
  });

  // Copy DM link
  document.querySelector('[data-action="dm-copy-link"]')?.addEventListener('click', () => {
    const code = this._dmCtxMenuCode;
    if (!code) return;
    this._closeDmCtxMenu();
    this._copyChannelLink(code);
  });

  // Delete DM
  document.querySelector('[data-action="dm-delete"]')?.addEventListener('click', async () => {
    const code = this._dmCtxMenuCode;
    if (!code) return;
    this._closeDmCtxMenu();
    const ok = await this._showConfirmModal('⚠️ ' + t('channels.dm_delete_confirm'), '', { danger: true, confirmLabel: t('settings.admin.delete') || 'Delete' });
    if (!ok) return;
    // Gather all attachment URLs from the (decrypted) cached messages
    // for this DM so the server can move E2E ciphertext-hidden uploads
    // to deleted-attachments. (#5299)
    const attachments = [];
    if (code === this.currentChannel && Array.isArray(this._lastRenderedMessages)) {
      const re = /\/uploads\/((?!deleted-attachments)[\w\-.]+)/g;
      for (const msg of this._lastRenderedMessages) {
        if (!msg || typeof msg.content !== 'string') continue;
        let m;
        while ((m = re.exec(msg.content)) !== null) attachments.push('/uploads/' + m[1]);
      }
    }
    this.socket.emit('delete-dm', { code, attachments });
  });

  // Close on outside click
  document.addEventListener('click', (e) => {
    if (this._dmCtxMenuEl && !this._dmCtxMenuEl.contains(e.target) && !e.target.closest('.dm-more-btn')) {
      this._closeDmCtxMenu();
    }
  });
},

_openDmCtxMenu(code, anchorEl, mouseEvent) {
  this._dmCtxMenuCode = code;
  const menu = this._dmCtxMenuEl;
  if (!menu) return;

  // Update mute label
  const muted = JSON.parse(localStorage.getItem('haven_muted_channels') || '[]');
  const muteBtn = menu.querySelector('[data-action="dm-mute"]');
  if (muteBtn) muteBtn.textContent = muted.includes(code) ? `🔕 ${t('channels.unmute_dm')}` : `🔔 ${t('channels.mute_dm')}`;

  // Show/hide "Mark as Read" based on unread count
  const markReadBtn = menu.querySelector('[data-action="dm-mark-read"]');
  if (markReadBtn) markReadBtn.style.display = (this.unreadCounts[code] > 0) ? '' : 'none';

  // Position
  if (mouseEvent) {
    menu.style.top = mouseEvent.clientY + 'px';
    menu.style.left = mouseEvent.clientX + 'px';
  } else {
    const rect = anchorEl.getBoundingClientRect();
    menu.style.top = rect.bottom + 4 + 'px';
    menu.style.left = rect.left + 'px';
  }
  menu.style.display = 'block';

  // Keep inside viewport
  requestAnimationFrame(() => {
    const mr = menu.getBoundingClientRect();
    if (mr.right > window.innerWidth) menu.style.left = (window.innerWidth - mr.width - 8) + 'px';
    if (mr.bottom > window.innerHeight) menu.style.top = (mr.top - mr.height - 4) + 'px';
  });
},

_closeDmCtxMenu() {
  if (this._dmCtxMenuEl) this._dmCtxMenuEl.style.display = 'none';
  this._dmCtxMenuCode = null;
},

/* ── Sub-channel Subscriptions Panel ──────────────────── */

_openSubChannelPanel() {
  const modal = document.getElementById('sub-panel-modal');
  if (!modal) return;

  // Run one-time migration: muted sub-channels → unsubbed, others → subbed
  if (!localStorage.getItem('haven_sub_panel_migrated')) {
    localStorage.setItem('haven_sub_panel_migrated', 'true');
    // Existing muted list already represents unsubbed state — no changes needed.
    // All non-muted channels are implicitly subscribed.
  }

  this._renderSubChannelPanel();
  modal.style.display = 'flex';

  // Close handlers
  const closeBtn = document.getElementById('sub-panel-close-btn');
  const closeHandler = () => {
    modal.style.display = 'none';
    closeBtn.removeEventListener('click', closeHandler);
    modal.removeEventListener('click', overlayHandler);
  };
  const overlayHandler = (e) => { if (e.target === modal) closeHandler(); };
  closeBtn.addEventListener('click', closeHandler);
  modal.addEventListener('click', overlayHandler);
},

_renderSubChannelPanel() {
  const container = document.getElementById('sub-panel-content');
  if (!container) return;
  container.innerHTML = '';

  const muted = JSON.parse(localStorage.getItem('haven_muted_channels') || '[]');
  const regularChannels = (this.channels || []).filter(c => !c.is_dm);
  const subChannels = regularChannels.filter(c => c.parent_channel_id);

  if (!subChannels.length) {
    container.innerHTML = `<p style="text-align:center;opacity:0.5;padding:24px">${t('channels.no_sub_channels')}</p>`;
    return;
  }

  // Group sub-channels by parent
  const parentMap = {};
  subChannels.forEach(sub => {
    if (!parentMap[sub.parent_channel_id]) parentMap[sub.parent_channel_id] = [];
    parentMap[sub.parent_channel_id].push(sub);
  });

  // Sort parents by position/name
  const parentIds = Object.keys(parentMap).map(Number);
  const parentChannels = parentIds.map(id => regularChannels.find(c => c.id === id)).filter(Boolean);
  parentChannels.sort((a, b) => (a.position || 0) - (b.position || 0) || a.name.localeCompare(b.name));

  parentChannels.forEach(parent => {
    const subs = parentMap[parent.id] || [];
    // Split into subscribed (not muted) and unsubscribed (muted)
    const subbed = subs.filter(s => !muted.includes(s.code));
    const unsubbed = subs.filter(s => muted.includes(s.code));

    const section = document.createElement('div');
    section.className = 'sub-panel-parent-section';

    const header = document.createElement('h4');
    header.className = 'sub-panel-parent-header';
    header.textContent = `# ${parent.name}`;
    section.appendChild(header);

    // Render subbed tiles first, then a divider, then unsubbed
    if (subbed.length) {
      const subbedLabel = document.createElement('div');
      subbedLabel.className = 'sub-panel-group-label';
      subbedLabel.textContent = t('channels.subscribed');
      section.appendChild(subbedLabel);
      const subbedGrid = document.createElement('div');
      subbedGrid.className = 'sub-panel-grid';
      subbed.forEach(ch => subbedGrid.appendChild(this._createSubPanelTile(ch, true)));
      section.appendChild(subbedGrid);
    }

    if (unsubbed.length) {
      const unsubbedLabel = document.createElement('div');
      unsubbedLabel.className = 'sub-panel-group-label unsubbed';
      unsubbedLabel.textContent = t('channels.unsubscribed');
      section.appendChild(unsubbedLabel);
      const unsubbedGrid = document.createElement('div');
      unsubbedGrid.className = 'sub-panel-grid';
      unsubbed.forEach(ch => unsubbedGrid.appendChild(this._createSubPanelTile(ch, false)));
      section.appendChild(unsubbedGrid);
    }

    container.appendChild(section);
  });
},

_createSubPanelTile(ch, isSubbed) {
  const tile = document.createElement('div');
  tile.className = 'sub-panel-tile' + (isSubbed ? ' subbed' : ' unsubbed');
  tile.dataset.code = ch.code;

  const unread = this.unreadCounts[ch.code] || 0;
  const unreadBadge = unread > 0 ? `<span class="sub-panel-badge">${unread > 99 ? '99+' : unread}</span>` : '';

  tile.innerHTML = `
    <label class="sub-panel-toggle" title="${isSubbed ? t('channels.unsubscribe_hint') : t('channels.subscribe_hint')}">
      <input type="checkbox" ${isSubbed ? 'checked' : ''}>
      <span class="sub-panel-toggle-label">${isSubbed ? '🔔' : '🔕'}</span>
    </label>
    <span class="sub-panel-tile-name">${ch.is_private ? '🔒 ' : ''}${this._escapeHtml(ch.name)}</span>
    ${unreadBadge}
  `;

  // Toggle sub/unsub
  const checkbox = tile.querySelector('input[type="checkbox"]');
  checkbox.addEventListener('change', (e) => {
    e.stopPropagation();
    const muted = JSON.parse(localStorage.getItem('haven_muted_channels') || '[]');
    const idx = muted.indexOf(ch.code);
    if (checkbox.checked) {
      // Subscribe: remove from muted
      if (idx >= 0) muted.splice(idx, 1);
      this._showToast(t('channels.subscribed_to', { name: ch.name }), 'success');
    } else {
      // Unsubscribe: add to muted
      if (idx < 0) muted.push(ch.code);
      this._showToast(t('channels.unsubscribed_from', { name: ch.name }), 'success');
    }
    localStorage.setItem('haven_muted_channels', JSON.stringify(muted));
    // Re-render the panel and sidebar
    this._renderSubChannelPanel();
    this._renderChannels();
  });

  // Click tile (not checkbox) to jump to channel
  tile.addEventListener('click', (e) => {
    if (e.target.closest('.sub-panel-toggle')) return; // Don't navigate when toggling checkbox
    document.getElementById('sub-panel-modal').style.display = 'none';
    this.switchChannel(ch.code);
  });

  return tile;
},

/* ── Re-parent channel modal (move to / promote) ───── */

_openReparentModal(code) {
  const ch = this.channels.find(c => c.code === code);
  if (!ch) return;

  const titleEl = document.getElementById('reparent-modal-title');
  const descEl = document.getElementById('reparent-modal-desc');
  const listEl = document.getElementById('reparent-channel-list');

  titleEl.textContent = `📦 ${t('channels.move_channel')}`;
  descEl.textContent = t('channels.move_channel_desc', { name: ch.name });

  // Build list of valid parent targets (top-level channels that aren't this one)
  const targets = this.channels.filter(c =>
    !c.is_dm &&
    !c.parent_channel_id &&  // Must be a top-level channel
    c.id !== ch.id &&         // Can't parent under self
    c.id !== ch.parent_channel_id  // Skip current parent (already there)
  ).sort((a, b) => (a.position || 0) - (b.position || 0));

  let html = '';

  // If currently a sub-channel, show "Promote to top-level" option at the top
  if (ch.parent_channel_id) {
    html += `<div class="organize-item reparent-option" data-target="__top__" style="border-bottom:1px solid rgba(255,255,255,0.08);margin-bottom:4px;padding-bottom:8px">
      <span style="opacity:0.5">⬆️</span>
      <span style="flex:1"><strong>${t('channels.promote_to_top_level')}</strong></span>
    </div>`;
  }

  for (const tgt of targets) {
    const subCount = this.channels.filter(c => c.parent_channel_id === tgt.id).length;
    const badge = subCount > 0 ? ` <span style="opacity:0.4;font-size:0.8em">${t('channels.sub_ch_count', { count: subCount })}</span>` : '';
    html += `<div class="organize-item reparent-option" data-target="${tgt.code}">
      <span style="opacity:0.5">#</span>
      <span style="flex:1">${this._escapeHtml(tgt.name)}${badge}</span>
    </div>`;
  }

  if (!targets.length && !ch.parent_channel_id) {
    html += `<p style="text-align:center;opacity:0.5;padding:16px;font-size:0.85rem">${t('channels.no_valid_parents')}</p>`;
  }

  listEl.innerHTML = html;

  // Wire up click handlers on the targets
  listEl.querySelectorAll('.reparent-option').forEach(el => {
    el.addEventListener('click', () => {
      const target = el.dataset.target;
      const newParentCode = target === '__top__' ? null : target;
      const action = newParentCode === null
        ? t('channels.confirm_promote', { name: ch.name })
        : t('channels.confirm_move', { name: ch.name, parent: this.channels.find(c => c.code === newParentCode)?.name || target });
      if (confirm(action)) {
        this.socket.emit('reparent-channel', { code, newParentCode });
        document.getElementById('reparent-modal').style.display = 'none';
      }
    });
  });

  document.getElementById('reparent-modal').style.display = 'flex';
},

/* ── Organize sub-channels modal ─────────────────────── */

_openOrganizeModal(parentCode, serverLevel) {
  if (serverLevel) {
    // Server-level mode: organize top-level channels
    const parents = this.channels.filter(c => !c.parent_channel_id && !c.is_dm);
    this._organizeParentCode = '__server__';
    this._organizeParentId = null;
    this._organizeServerLevel = true;
    this._organizeList = [...parents].sort((a, b) => (a.position || 0) - (b.position || 0));
    this._organizeSelected = null;
    this._organizeSelectedTag = null;
    this._organizeTagSorts = JSON.parse(localStorage.getItem('haven_tag_sorts___server__') || this.serverSettings?.channel_tag_sorts || '{}');
    this._organizeCatOrder = JSON.parse(localStorage.getItem('haven_cat_order___server__') || this.serverSettings?.channel_cat_order || '[]');
    this._organizeCatSort = localStorage.getItem('haven_cat_sort___server__') || this.serverSettings?.channel_cat_sort || 'az';

    document.getElementById('organize-modal-title').textContent = `📋 ${t('channels.organize_channels')}`;
    document.getElementById('organize-modal-parent-name').textContent = t('channels.organize_desc');
    // Server-level sort: check for personal override, else use server default
    const sortSel = document.getElementById('organize-global-sort');
    const localOverride = localStorage.getItem('haven_server_sort_mode');
    sortSel.value = localOverride || 'server_default';
    const catSortSel = document.getElementById('organize-cat-sort');
    if (catSortSel) catSortSel.value = this._organizeCatSort;
    document.getElementById('organize-tag-input').value = '';
    const backBtn = document.getElementById('organize-back-btn');
    if (backBtn) backBtn.style.display = 'none';
    // Hide admin-only controls (move/tag) for non-admin users at server level
    const canManage = this.user?.isAdmin || this._hasPerm('manage_server') || this._hasPerm('create_channel');
    document.querySelector('.organize-controls')?.style.setProperty('display', canManage ? '' : 'none');
    this._renderOrganizeList();
    document.getElementById('organize-modal').style.display = 'flex';
    return;
  }

  const parent = this.channels.find(c => c.code === parentCode);
  if (!parent) return;

  const subs = this.channels.filter(c => c.parent_channel_id === parent.id);
  this._organizeParentCode = parentCode;
  this._organizeParentId = parent.id;
  this._organizeServerLevel = false;
  this._organizeList = [...subs].sort((a, b) => (a.position || 0) - (b.position || 0));
  this._organizeSelected = null;
  this._organizeSelectedTag = null;
  // Per-tag sort overrides: tag → 'manual'|'alpha'|'created'|'oldest' (persisted in localStorage)
  this._organizeTagSorts = JSON.parse(localStorage.getItem(`haven_tag_sorts_${parentCode}`) || '{}');
  this._organizeCatOrder = JSON.parse(localStorage.getItem(`haven_cat_order_${parentCode}`) || '[]');
  this._organizeCatSort = localStorage.getItem(`haven_cat_sort_${parentCode}`) || 'az';

  document.getElementById('organize-modal-title').textContent = `📋 ${t('channels.organize_sub_channels')}`;
  document.getElementById('organize-modal-parent-name').textContent = `# ${parent.name}`;
  // Map sort_alphabetical: 0=manual, 1=alpha, 2=created
  const sortSel = document.getElementById('organize-global-sort');
  sortSel.value = parent.sort_alphabetical === 1 ? 'alpha' : parent.sort_alphabetical === 2 ? 'created' : parent.sort_alphabetical === 3 ? 'oldest' : parent.sort_alphabetical === 4 ? 'dynamic' : 'manual';
  const catSortSel = document.getElementById('organize-cat-sort');
  if (catSortSel) catSortSel.value = this._organizeCatSort;
  document.getElementById('organize-tag-input').value = '';
  const backBtn = document.getElementById('organize-back-btn');
  if (backBtn) {
    backBtn.style.display = '';
    // Replace listener with a fresh one each time
    const newBtn = backBtn.cloneNode(true);
    backBtn.parentNode.replaceChild(newBtn, backBtn);
    newBtn.addEventListener('click', () => this._openOrganizeModal(null, true));
  }
  // Sub-channel organize: always show controls (already permission-gated by context menu)
  document.querySelector('.organize-controls')?.style.setProperty('display', '');
  this._renderOrganizeList();
  document.getElementById('organize-modal').style.display = 'flex';
},

_renderOrganizeList() {
  const listEl = document.getElementById('organize-channel-list');
  let globalSort = document.getElementById('organize-global-sort').value;
  // Resolve "server_default" to the actual server sort mode
  if (globalSort === 'server_default') globalSort = this.serverSettings?.channel_sort_mode || 'manual';

  let displayList = [...(this._organizeList || [])];

  // Collect unique tags (case-insensitive dedup, keep first-seen casing)
  const _orgTagMap = new Map();
  displayList.filter(c => c.category).forEach(c => {
    const key = c.category.toLowerCase();
    if (!_orgTagMap.has(key)) _orgTagMap.set(key, c.category);
  });
  const realTags = [..._orgTagMap.values()];
  const hasUntagged = displayList.some(c => !c.category);
  const hasTags = realTags.length > 0;
  // Build the full ordered keys list: real tags + __untagged__ (if applicable)
  const allKeys = [...realTags];
  if (hasUntagged && hasTags) allKeys.push('__untagged__');

  // Show/hide category toolbar
  const catToolbar = document.getElementById('organize-cat-toolbar');
  if (catToolbar) catToolbar.style.display = hasTags ? 'flex' : 'none';

  // Sort category headers by chosen mode
  const catSort = this._organizeCatSort || 'az';
  if (catSort === 'az') {
    allKeys.sort((a, b) => {
      if (a === '__untagged__') return 1; if (b === '__untagged__') return -1;
      return a.localeCompare(b);
    });
  } else if (catSort === 'za') {
    allKeys.sort((a, b) => {
      if (a === '__untagged__') return 1; if (b === '__untagged__') return -1;
      return b.localeCompare(a);
    });
  } else {
    // manual — use stored order
    const order = this._organizeCatOrder || [];
    allKeys.sort((a, b) => {
      const ia = order.indexOf(a);
      const ib = order.indexOf(b);
      if (ia === -1 && ib === -1) {
        if (a === '__untagged__') return 1; if (b === '__untagged__') return -1;
        return a.localeCompare(b);
      }
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    });
  }

  // Sort within each tag group
  const sortGroup = (arr, mode) => {
    if (mode === 'alpha') {
      arr.sort((a, b) => a.name.localeCompare(b.name));
    } else if (mode === 'created') {
      arr.sort((a, b) => (b.id || 0) - (a.id || 0)); // Higher ID = newer
    } else if (mode === 'oldest') {
      arr.sort((a, b) => (a.id || 0) - (b.id || 0)); // Lower ID = older
    } else if (mode === 'dynamic') {
      arr.sort((a, b) => (b.latestMessageId || 0) - (a.latestMessageId || 0)); // Most recent activity first
    } else {
      arr.sort((a, b) => (a.position || 0) - (b.position || 0));
    }
    return arr;
  };

  // Build grouped display
  let grouped = [];
  if (hasTags) {
    for (const key of allKeys) {
      if (key === '__untagged__') {
        const untagged = displayList.filter(c => !c.category);
        if (untagged.length) {
          const untaggedSort = this._organizeTagSorts['__untagged__'] || globalSort;
          grouped.push({ tag: '', items: sortGroup(untagged, untaggedSort), sort: untaggedSort });
        }
      } else {
        const tagSort = this._organizeTagSorts[key] || globalSort;
        const keyLower = key.toLowerCase();
        const tagItems = sortGroup(displayList.filter(c => c.category && c.category.toLowerCase() === keyLower), tagSort);
        grouped.push({ tag: key, items: tagItems, sort: tagSort });
      }
    }
  } else {
    grouped.push({ tag: '', items: sortGroup(displayList, globalSort), sort: globalSort });
  }

  let html = '';
  for (const group of grouped) {
    // Tag header
    if (hasTags) {
      const tagKey = group.tag || '__untagged__';
      const label = group.tag ? this._escapeHtml(group.tag) : t('channels.untagged');
      const isTagSelected = this._organizeSelectedTag === tagKey;
      html += `<div class="organize-tag-header${isTagSelected ? ' selected' : ''}" data-tag-key="${this._escapeHtml(tagKey)}" draggable="true">
        <span class="organize-tag-drag" title="${t('channels.drag_to_reorder') || 'Drag to reorder'}">⋮⋮</span>
        <span>${label}</span>
        <select class="tag-sort-select" data-tag="${this._escapeHtml(tagKey)}" title="Sort this group" draggable="false">
          <option value="manual"${group.sort === 'manual' ? ' selected' : ''}>${t('channels.sort.manual')}</option>
          <option value="alpha"${group.sort === 'alpha' ? ' selected' : ''}>${t('channels.sort.alpha')}</option>
          <option value="created"${group.sort === 'created' ? ' selected' : ''}>${t('channels.sort.newest')}</option>
          <option value="oldest"${group.sort === 'oldest' ? ' selected' : ''}>${t('channels.sort.oldest')}</option>
          <option value="dynamic"${group.sort === 'dynamic' ? ' selected' : ''}>${t('channels.sort.dynamic')}</option>
        </select>
      </div>`;
    }

    for (const ch of group.items) {
      const sel = this._organizeSelected === ch.code;
      const tagBadge = ch.category ? `<span class="organize-tag-badge">${this._escapeHtml(ch.category)}</span>` : '';
      const icon = this._organizeServerLevel ? '#' : (ch.is_private ? '🔒' : '↳');
      const hasSubs = this._organizeServerLevel && this.channels.some(c => c.parent_channel_id === ch.id);
      const drillHint = hasSubs ? `<span class="organize-drill-hint" title="${t('channels.drill_hint')}">▶</span>` : '';
      html += `<div class="organize-item${sel ? ' selected' : ''}${hasSubs ? ' organize-has-subs' : ''}" data-code="${ch.code}">
        <span style="opacity:0.5">${icon}</span>
        <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${this._escapeHtml(ch.name)}</span>
        ${tagBadge}${drillHint}
      </div>`;
    }
  }

  if (!displayList.length) {
    html = `<div style="padding:24px;text-align:center;opacity:0.4;font-size:0.9rem">${this._organizeServerLevel ? t('channels.no_channels_yet') : t('channels.no_sub_channels_yet')}</div>`;
  }

  listEl.innerHTML = html;

  // Click to select channel
  listEl.querySelectorAll('.organize-item').forEach(el => {
    el.addEventListener('click', () => {
      this._organizeSelected = el.dataset.code;
      this._organizeSelectedTag = null; // clear tag selection
      const ch = this._organizeList.find(c => c.code === el.dataset.code);
      document.getElementById('organize-tag-input').value = (ch && ch.category) || '';
      this._renderOrganizeList();
    });
    // Double-click on a parent channel (server-level mode) drills into its sub-channels
    if (this._organizeServerLevel) {
      el.addEventListener('dblclick', () => {
        const ch = this.channels.find(c => c.code === el.dataset.code);
        if (!ch) return;
        const hasSubs = this.channels.some(c => c.parent_channel_id === ch.id);
        if (hasSubs) this._openOrganizeModal(ch.code);
      });
    }
  });

  // Click tag header to select category
  listEl.querySelectorAll('.organize-tag-header').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.classList.contains('tag-sort-select')) return; // ignore dropdown clicks
      this._organizeSelectedTag = el.dataset.tagKey;
      this._organizeSelected = null; // clear channel selection
      document.getElementById('organize-tag-input').value = '';
      this._renderOrganizeList();
    });
  });

  // Per-tag sort dropdowns
  listEl.querySelectorAll('.tag-sort-select').forEach(sel => {
    sel.addEventListener('click', (e) => e.stopPropagation());
    sel.addEventListener('change', (e) => {
      e.stopPropagation();
      const tagKey = sel.dataset.tag;
      this._organizeTagSorts[tagKey] = sel.value;
      // Persist per-tag sorts so sidebar respects them
      localStorage.setItem(`haven_tag_sorts_${this._organizeParentCode}`, JSON.stringify(this._organizeTagSorts));
      // Server-level: sync to server so all users see category-specific sorts
      if (this._organizeServerLevel && (this.user?.isAdmin || this._hasPerm('manage_server'))) {
        this.socket.emit('update-server-setting', { key: 'channel_tag_sorts', value: JSON.stringify(this._organizeTagSorts) });
      }
      this._renderOrganizeList();
    });
  });

  // ── Drag-and-drop reordering of category headers ──────
  // Uses event delegation on listEl so drag events still fire when the
  // cursor is over a child element (e.g. the per-tag <select>) inside the
  // header, which can otherwise swallow dragover/drop in some browsers.
  // Re-attach is idempotent because handlers live on listEl, not children.
  if (!listEl._catDragSetup) {
    listEl._catDragSetup = true;
    listEl.addEventListener('dragstart', (e) => {
      const header = e.target.closest('.organize-tag-header[draggable="true"]');
      if (!header || !listEl.contains(header)) return;
      listEl._catDragKey = header.dataset.tagKey;
      header.classList.add('org-dragging');
      try { e.dataTransfer.setData('text/plain', listEl._catDragKey || ''); } catch {}
      try { e.dataTransfer.effectAllowed = 'move'; } catch {}
    });
    listEl.addEventListener('dragend', () => {
      listEl.querySelectorAll('.organize-tag-header').forEach(h => h.classList.remove('org-dragging', 'org-drop-above', 'org-drop-below'));
      listEl._catDragKey = null;
    });
    listEl.addEventListener('dragover', (e) => {
      if (!listEl._catDragKey) return;
      const header = e.target.closest('.organize-tag-header');
      if (!header || header.dataset.tagKey === listEl._catDragKey) return;
      e.preventDefault();
      try { e.dataTransfer.dropEffect = 'move'; } catch {}
      const rect = header.getBoundingClientRect();
      const before = (e.clientY - rect.top) < rect.height / 2;
      // Clear other indicators
      listEl.querySelectorAll('.organize-tag-header').forEach(h => {
        if (h !== header) h.classList.remove('org-drop-above', 'org-drop-below');
      });
      header.classList.toggle('org-drop-above', before);
      header.classList.toggle('org-drop-below', !before);
    });
    listEl.addEventListener('dragleave', (e) => {
      // Only clear when leaving the list entirely
      if (!listEl.contains(e.relatedTarget)) {
        listEl.querySelectorAll('.organize-tag-header').forEach(h => h.classList.remove('org-drop-above', 'org-drop-below'));
      }
    });
    listEl.addEventListener('drop', (e) => {
      const header = e.target.closest('.organize-tag-header');
      const dragKey = listEl._catDragKey;
      listEl._catDragKey = null;
      listEl.querySelectorAll('.organize-tag-header').forEach(h => h.classList.remove('org-drop-above', 'org-drop-below', 'org-dragging'));
      if (!header || !dragKey || header.dataset.tagKey === dragKey) return;
      e.preventDefault();
      const rect = header.getBoundingClientRect();
      const before = (e.clientY - rect.top) < rect.height / 2;
      const currentOrder = Array.from(listEl.querySelectorAll('.organize-tag-header'))
        .map(h => h.dataset.tagKey);
      const fromIdx = currentOrder.indexOf(dragKey);
      if (fromIdx === -1) return;
      currentOrder.splice(fromIdx, 1);
      const insertAt = currentOrder.indexOf(header.dataset.tagKey) + (before ? 0 : 1);
      currentOrder.splice(insertAt, 0, dragKey);

      this._organizeCatSort = 'manual';
      this._organizeCatOrder = currentOrder;
      const sortSel = document.getElementById('organize-cat-sort');
      if (sortSel) sortSel.value = 'manual';
      localStorage.setItem(`haven_cat_order_${this._organizeParentCode}`, JSON.stringify(currentOrder));
      localStorage.setItem(`haven_cat_sort_${this._organizeParentCode}`, 'manual');
      if (this._organizeServerLevel && (this.user?.isAdmin || this._hasPerm('manage_server'))) {
        this.socket.emit('update-server-setting', { key: 'channel_cat_order', value: JSON.stringify(currentOrder) });
        this.socket.emit('update-server-setting', { key: 'channel_cat_sort', value: 'manual' });
      }
      this._renderOrganizeList();
      this._renderChannels();
    });
  }

  // Disable up/down based on selection type
  let canMoveUp = false, canMoveDown = false;
  if (this._organizeSelectedTag) {
    // Category selected — always allow movement; handler auto-switches to manual mode
    const orderedTags = grouped.map(g => g.tag || '__untagged__');
    const tagIdx = orderedTags.indexOf(this._organizeSelectedTag);
    canMoveUp = tagIdx > 0;
    canMoveDown = tagIdx >= 0 && tagIdx < orderedTags.length - 1;
  } else if (this._organizeSelected) {
    // Channel selected — can move if its tag group sort is manual
    const ch = this._organizeList.find(c => c.code === this._organizeSelected);
    if (ch) {
      const { group, effectiveSort } = this._getOrganizeVisualGroup(ch);
      if (effectiveSort === 'manual') {
        const groupIdx = group.findIndex(c => c.code === this._organizeSelected);
        canMoveUp = groupIdx > 0;
        canMoveDown = groupIdx >= 0 && groupIdx < group.length - 1;
      }
    }
  }
  document.getElementById('organize-move-up').disabled = !canMoveUp;
  document.getElementById('organize-move-down').disabled = !canMoveDown;
  document.getElementById('organize-set-tag').disabled = !this._organizeSelected;
  document.getElementById('organize-remove-tag').disabled = !this._organizeSelected;
},

/**
 * Get the sorted visual group of channels for the organize modal.
 * Returns the channels in the same tag group as `ch`, sorted by
 * the effective sort mode, plus the sort mode string.
 */
_getOrganizeVisualGroup(ch) {
  let globalSort = document.getElementById('organize-global-sort').value;
  if (globalSort === 'server_default') globalSort = this.serverSettings?.channel_sort_mode || 'manual';
  const tagKey = ch.category || '__untagged__';
  const effectiveSort = this._organizeTagSorts[tagKey] || globalSort;

  // Collect channels in the same tag group (case-insensitive)
  const group = ch.category
    ? this._organizeList.filter(c => c.category && c.category.toLowerCase() === ch.category.toLowerCase())
    : this._organizeList.filter(c => !c.category);

  // Sort by effective mode (mirrors _renderOrganizeList's sortGroup)
  if (effectiveSort === 'alpha') {
    group.sort((a, b) => a.name.localeCompare(b.name));
  } else if (effectiveSort === 'created') {
    group.sort((a, b) => (b.id || 0) - (a.id || 0));
  } else if (effectiveSort === 'oldest') {
    group.sort((a, b) => (a.id || 0) - (b.id || 0));
  } else if (effectiveSort === 'dynamic') {
    group.sort((a, b) => (b.latestMessageId || 0) - (a.latestMessageId || 0));
  } else {
    group.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  }

  return { group, effectiveSort };
},

/**
 * Move a category group up or down in the order.
 * @param {number} direction -1 for up, +1 for down
 */
_moveCategoryInOrder(direction) {
  if (!this._organizeSelectedTag) return;

  // Build full ordered keys (real tags + __untagged__) from channel data
  const displayList = [...(this._organizeList || [])];
  const realTags = [...new Map(displayList.filter(c => c.category).map(c => [c.category.toLowerCase(), c.category])).values()];
  const hasUntagged = displayList.some(c => !c.category);
  const allKeys = [...realTags];
  if (hasUntagged) allKeys.push('__untagged__');

  // Sort by current mode to match the visual order (same logic as _renderOrganizeList)
  const catSort = this._organizeCatSort || 'az';
  if (catSort === 'az') {
    allKeys.sort((a, b) => {
      if (a === '__untagged__') return 1; if (b === '__untagged__') return -1;
      return a.localeCompare(b);
    });
  } else if (catSort === 'za') {
    allKeys.sort((a, b) => {
      if (a === '__untagged__') return 1; if (b === '__untagged__') return -1;
      return b.localeCompare(a);
    });
  } else {
    const order = this._organizeCatOrder || [];
    allKeys.sort((a, b) => {
      const ia = order.indexOf(a);
      const ib = order.indexOf(b);
      if (ia === -1 && ib === -1) {
        if (a === '__untagged__') return 1; if (b === '__untagged__') return -1;
        return a.localeCompare(b);
      }
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    });
  }

  const idx = allKeys.indexOf(this._organizeSelectedTag);
  const targetIdx = idx + direction;
  if (idx < 0 || targetIdx < 0 || targetIdx >= allKeys.length) return;

  // Swap
  [allKeys[idx], allKeys[targetIdx]] = [allKeys[targetIdx], allKeys[idx]];

  // Switch to manual mode
  this._organizeCatSort = 'manual';
  this._organizeCatOrder = allKeys;
  document.getElementById('organize-cat-sort').value = 'manual';

  // Persist
  localStorage.setItem(`haven_cat_order_${this._organizeParentCode}`, JSON.stringify(allKeys));
  localStorage.setItem(`haven_cat_sort_${this._organizeParentCode}`, 'manual');
  // Server-level: sync category order to server so all users see it
  if (this._organizeServerLevel && (this.user?.isAdmin || this._hasPerm('manage_server'))) {
    this.socket.emit('update-server-setting', { key: 'channel_cat_order', value: JSON.stringify(allKeys) });
    this.socket.emit('update-server-setting', { key: 'channel_cat_sort', value: 'manual' });
  }

  this._renderOrganizeList();
  // Always re-render the sidebar so sub-channel category moves take effect
  // immediately (previously this was server-level-only and the sidebar lagged
  // behind the modal for sub-channel reordering). #4 in the bug list.
  this._renderChannels();
},

/* ── DM Organize (client-side, localStorage) ─────────── */

_openDmOrganizeModal() {
  const dmChannels = this.channels.filter(c => c.is_dm);
  const order = JSON.parse(localStorage.getItem('haven_dm_order') || '[]');
  const assignments = JSON.parse(localStorage.getItem('haven_dm_assignments') || '{}');

  // Build list sorted by saved order, then alphabetical for unknowns
  const ordered = [];
  for (const code of order) {
    const ch = dmChannels.find(c => c.code === code);
    if (ch) ordered.push(ch);
  }
  for (const ch of dmChannels) {
    if (!ordered.includes(ch)) ordered.push(ch);
  }
  this._dmOrganizeList = ordered;
  this._dmOrganizeSelected = null;

  const sortSel = document.getElementById('dm-organize-sort');
  sortSel.value = localStorage.getItem('haven_dm_sort_mode') || 'manual';
  document.getElementById('dm-organize-tag-input').value = '';
  this._renderDmOrganizeList();
  document.getElementById('dm-organize-modal').style.display = 'flex';
},

_saveDmOrder() {
  localStorage.setItem('haven_dm_order', JSON.stringify(this._dmOrganizeList.map(c => c.code)));
},

_renderDmOrganizeList() {
  const listEl = document.getElementById('dm-organize-list');
  const sortMode = document.getElementById('dm-organize-sort').value;
  const assignments = JSON.parse(localStorage.getItem('haven_dm_assignments') || '{}');

  let displayList = [...(this._dmOrganizeList || [])];

  // Collect unique tags
  const allTags = [...new Set(displayList.map(c => assignments[c.code]).filter(Boolean))].sort();
  const hasTags = allTags.length > 0;

  const getDmName = (ch) => ch.dm_target ? this._getNickname(ch.dm_target.id, ch.dm_target.username) : t('channels.unknown_user');

  const sortGroup = (arr, mode) => {
    if (mode === 'alpha') {
      arr.sort((a, b) => getDmName(a).localeCompare(getDmName(b)));
    } else if (mode === 'recent') {
      arr.sort((a, b) => (b.last_activity || 0) - (a.last_activity || 0));
    }
    // manual = keep current order
    return arr;
  };

  let grouped = [];
  if (hasTags) {
    for (const tag of allTags) {
      const tagItems = sortGroup(displayList.filter(c => assignments[c.code] === tag), sortMode);
      grouped.push({ tag, items: tagItems });
    }
    const untagged = displayList.filter(c => !assignments[c.code]);
    if (untagged.length) {
      grouped.push({ tag: '', items: sortGroup(untagged, sortMode) });
    }
  } else {
    grouped.push({ tag: '', items: sortGroup(displayList, sortMode) });
  }

  let html = '';
  for (const group of grouped) {
    if (group.tag) {
      html += `<div class="organize-tag-header">🏷️ ${this._escapeHtml(group.tag)}</div>`;
    } else if (hasTags) {
      html += `<div class="organize-tag-header" style="opacity:0.5">${t('channels.uncategorized')}</div>`;
    }
    for (const ch of group.items) {
      const name = getDmName(ch);
      const sel = ch.code === this._dmOrganizeSelected ? ' selected' : '';
      const tagBadge = assignments[ch.code] ? `<span class="organize-tag-badge">${this._escapeHtml(assignments[ch.code])}</span>` : '';
      html += `<div class="organize-item${sel}" data-code="${ch.code}">
        <span class="organize-item-name">@ ${this._escapeHtml(name)}</span>
        ${tagBadge}
      </div>`;
    }
  }
  listEl.innerHTML = html || `<p class="muted-text">${t('channels.no_dms_to_organize')}</p>`;

  // Click to select
  listEl.querySelectorAll('.organize-item').forEach(el => {
    el.addEventListener('click', () => {
      this._dmOrganizeSelected = el.dataset.code;
      listEl.querySelectorAll('.organize-item').forEach(e => e.classList.remove('selected'));
      el.classList.add('selected');
      // Pre-fill tag input with current tag
      const currentTag = assignments[el.dataset.code] || '';
      document.getElementById('dm-organize-tag-input').value = currentTag;
      this._updateDmOrganizeButtons();
    });
  });
  this._updateDmOrganizeButtons();
},

_updateDmOrganizeButtons() {
  const sortMode = document.getElementById('dm-organize-sort').value;
  const isManual = sortMode === 'manual';
  document.getElementById('dm-organize-move-up').disabled = !isManual || !this._dmOrganizeSelected;
  document.getElementById('dm-organize-move-down').disabled = !isManual || !this._dmOrganizeSelected;
  document.getElementById('dm-organize-set-tag').disabled = !this._dmOrganizeSelected;
  document.getElementById('dm-organize-remove-tag').disabled = !this._dmOrganizeSelected;
},

_openWebhookModal(channelCode) {
  const ch = this.channels.find(c => c.code === channelCode);
  const modal = document.getElementById('webhook-modal');
  modal._channelCode = channelCode;
  document.getElementById('webhook-modal-channel-name').textContent = ch ? `# ${ch.name}` : '';
  document.getElementById('webhook-name-input').value = '';
  document.getElementById('webhook-token-reveal').style.display = 'none';
  document.getElementById('webhook-list').innerHTML = `<p style="opacity:0.5;font-size:0.85rem">${t('channels.webhook_loading')}</p>`;
  modal.style.display = 'flex';
  this.socket.emit('get-webhooks', { channelCode });
},

_renderWebhookList(webhooks, channelCode) {
  const container = document.getElementById('webhook-list');
  if (!webhooks.length) {
    container.innerHTML = `<p style="opacity:0.5;font-size:0.85rem">${t('channels.no_webhooks')}</p>`;
    return;
  }
  container.innerHTML = webhooks.map(wh => {
    const maskedToken = wh.token.slice(0, 8) + '••••••••';
    const statusLabel = wh.is_active ? `🟢 ${t('channels.webhook_active')}` : `🔴 ${t('channels.webhook_disabled')}`;
    const toggleLabel = wh.is_active ? t('channels.webhook_disable') : t('channels.webhook_enable');
    return `
      <div class="webhook-item" style="display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:6px;background:rgba(255,255,255,0.04);margin-bottom:6px">
        <div style="flex:1;min-width:0">
          <div style="font-weight:600;font-size:0.9rem">${this._escapeHtml(wh.name)}</div>
          <div style="font-size:0.75rem;opacity:0.5;font-family:monospace">${maskedToken}</div>
        </div>
        <span style="font-size:0.75rem;white-space:nowrap">${statusLabel}</span>
        <button class="btn-xs webhook-toggle-btn" data-id="${wh.id}" style="font-size:0.75rem">${toggleLabel}</button>
        <button class="btn-xs webhook-delete-btn" data-id="${wh.id}" style="font-size:0.75rem;color:#ff4444">🗑️</button>
      </div>`;
  }).join('');

  container.querySelectorAll('.webhook-delete-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (confirm(t('channels.webhook_delete_confirm'))) {
        this.socket.emit('delete-webhook', { webhookId: parseInt(btn.dataset.id) });
      }
    });
  });
  container.querySelectorAll('.webhook-toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      this.socket.emit('toggle-webhook', { webhookId: parseInt(btn.dataset.id) });
    });
  });
},

_renderChannels() {
  const list = document.getElementById('channel-list');
  list.innerHTML = '';

  const regularChannels = this.channels.filter(c => !c.is_dm);
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

  // Sort sub-channels — respect parent's sort_alphabetical setting & per-tag overrides
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
        // Same tag group — check per-tag override
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

  // Sort parent channels — respect server-level sort mode & per-tag overrides
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
    const hashIcon = isSub ? (ch.is_private ? '🔒' : '↳') : (isTempVoice ? '🔊' : (isTemporary ? '⏱️' : (isAnnouncement ? '📢' : '#')));

    // Build small status indicators for channel features
    const _badges = [];
    if (!isSub) {
      if (ch.streams_enabled === 0) _badges.push(`<span class="ch-disabled-badge" title="${t('channels.screen_share_not_allowed')}">🖥️</span>`);
      if (ch.music_enabled === 0) _badges.push(`<span class="ch-disabled-badge" title="${t('channels.music_not_allowed')}">🎵</span>`);
      if (ch.slow_mode_interval > 0) _badges.push(`<span title="${t('channels.slow_mode_title', { seconds: ch.slow_mode_interval })}" style="opacity:0.5;font-size:0.65rem">🐢</span>`);
      if (ch.cleanup_exempt === 1) _badges.push(`<span title="${t('channels.cleanup_exempt_title')}" style="opacity:0.5;font-size:0.65rem">🛡️</span>`);
    }
    const _mutedList = JSON.parse(localStorage.getItem('haven_muted_channels') || '[]');
    if (_mutedList.includes(ch.code)) _badges.push(`<span class="ch-disabled-badge" title="${t('channels.muted_unsubscribed')}">🔕</span>`);
    const indicators = _badges.length ? `<span class="channel-indicators" style="margin-left:auto;display:flex;gap:2px;align-items:center;flex-shrink:0">${_badges.join('')}</span>` : '';

    const expiryTitle = isTemporary ? ` title="${t('channels.temporary_expires', { date: new Date(ch.expires_at).toLocaleString() })}"` : '';
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
          // Remove the parent bubble when expanding — individual sub-channel badges are now visible
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

    el.addEventListener('click', () => this.switchChannel(ch.code));
    // Double-click to join voice in the channel (blocked for text-only)
    el.addEventListener('dblclick', () => {
      const _dblCh = this.channels.find(c => c.code === ch.code);
      if (_dblCh && _dblCh.voice_enabled === 0) return;
      if (!this.user?.isAdmin && !this._hasPerm('use_voice')) return;
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
    const catCollapsed = cat ? localStorage.getItem(`haven_cat_collapsed_${cat}`) === 'true' : false;

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
        localStorage.setItem(`haven_cat_collapsed_${cat}`, nowCollapsed);
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
          const tagName = sub.category || 'Untagged';
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
          tagText.textContent = tagName;
          tagLabel.appendChild(tagText);
          tagLabel.addEventListener('click', (e) => {
            e.stopPropagation();
            const nowCollapsed = tagArrow.classList.toggle('collapsed');
            localStorage.setItem(tagKey, nowCollapsed);
            list.querySelectorAll(`.sub-channel-item[data-parent-code="${ch.code}"][data-sub-tag="${CSS.escape(tagName)}"]`).forEach(el => {
              el.style.display = nowCollapsed ? 'none' : '';
            });
          });
          if (isSubCollapsed || catCollapsed) tagLabel.style.display = 'none';
          list.appendChild(tagLabel);
          lastSubTag = sub.category;
        }
        const subEl = renderChannelItem(sub, true);
        if (cat) subEl.dataset.catSubGroup = cat;
        if (subHasTags) {
          subEl.dataset.parentCode = ch.code;
          subEl.dataset.subTag = sub.category || 'Untagged';
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

    const getDmName = (ch) => ch.dm_target ? this._getNickname(ch.dm_target.id, ch.dm_target.username) : t('channels.unknown_user');

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
        <span class="channel-hash">@</span>
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
        // On mobile, the sidebar covers the chat — close it so the user
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
      // No tags — flat list (original behavior)
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

// ── Drag-and-drop channel reordering ────────────────────

_setupChannelDragDrop() {
  const canManage = this.user?.isAdmin || this._hasPerm('manage_server') || this._hasPerm('create_channel');
  const list = document.getElementById('channel-list');
  if (!list || !canManage) return;

  // Make eligible items draggable (idempotent — safe to re-run each render)
  list.querySelectorAll(
    '.channel-item:not(.sub-channel-item):not(.dm-item):not(.temp-channel-create-btn), .category-label, .sub-channel-item'
  ).forEach(el => el.setAttribute('draggable', 'true'));

  // Listeners must only be attached ONCE per container — re-renders would
  // otherwise stack duplicate handlers and cause channels to spasm/jump.
  if (list._dragSetupDone) return;
  list._dragSetupDone = true;

  let dragSrc = null;
  const indicator = document.createElement('div');
  indicator.className = 'ch-drag-indicator';

  const cleanUp = () => {
    if (dragSrc) { dragSrc.classList.remove('ch-dragging'); dragSrc = null; }
    indicator.remove();
  };

  // Check whether drag source and potential target are compatible
  const isCompatible = (src, tgt) => {
    if (!src || !tgt || src === tgt) return false;
    if (src.classList.contains('category-label'))
      return tgt.classList.contains('category-label');
    if (src.classList.contains('sub-tag-label'))
      return tgt.classList.contains('sub-tag-label') && tgt.dataset.parentCode === src.dataset.parentCode;
    if (src.classList.contains('sub-channel-item'))
      return tgt.classList.contains('sub-channel-item') && !tgt.classList.contains('sub-tag-label') && tgt.dataset.parentId === src.dataset.parentId;
    // Parent channel: compatible with other parent channel-items or category labels
    return (tgt.classList.contains('channel-item') && !tgt.classList.contains('sub-channel-item') && !tgt.classList.contains('dm-item') && !tgt.classList.contains('temp-channel-create-btn')) ||
      tgt.classList.contains('category-label');
  };

  list.addEventListener('dragstart', (e) => {
    const el = e.target.closest('[draggable="true"]');
    if (!el || el.classList.contains('temp-channel-create-btn')) { e.preventDefault(); return; }
    dragSrc = el;
    dragSrc.classList.add('ch-dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', el.dataset.code || el.dataset.category || el.dataset.tagName || '');
  });

  list.addEventListener('dragover', (e) => {
    if (!dragSrc) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const tgt = e.target.closest('.channel-item:not(.temp-channel-create-btn), .category-label');
    if (!tgt || !isCompatible(dragSrc, tgt)) { indicator.remove(); return; }
    const rect = tgt.getBoundingClientRect();
    if (e.clientY < rect.top + rect.height / 2) {
      list.insertBefore(indicator, tgt);
    } else {
      list.insertBefore(indicator, tgt.nextSibling);
    }
  });

  list.addEventListener('dragleave', (e) => {
    if (!list.contains(e.relatedTarget)) indicator.remove();
  });

  list.addEventListener('drop', (e) => {
    e.preventDefault();
    if (!dragSrc || !indicator.parentNode) { cleanUp(); return; }
    indicator.parentNode.insertBefore(dragSrc, indicator);
    indicator.remove();
    this._saveDragDropOrder(dragSrc);
    dragSrc.classList.remove('ch-dragging');
    dragSrc = null;
  });

  list.addEventListener('dragend', cleanUp);
},

_saveDragDropOrder(el) {
  const list = document.getElementById('channel-list');
  if (!list) return;

  // Category label was dragged — reorder categories
  if (el.classList.contains('category-label')) {
    const newOrder = [...list.querySelectorAll('.category-label')].map(e => e.dataset.category || '__untagged__');
    localStorage.setItem('haven_cat_order___server__', JSON.stringify(newOrder));
    localStorage.setItem('haven_cat_sort___server__', 'manual');
    if (this.serverSettings) {
      this.serverSettings.channel_cat_order = JSON.stringify(newOrder);
      this.serverSettings.channel_cat_sort = 'manual';
    }
    if (this.user?.isAdmin || this._hasPerm('manage_server')) {
      this.socket.emit('update-server-setting', { key: 'channel_cat_order', value: JSON.stringify(newOrder) });
      this.socket.emit('update-server-setting', { key: 'channel_cat_sort', value: 'manual' });
    }
    return;
  }

  // Sub-tag label was dragged — reorder sub-tags within parent
  if (el.classList.contains('sub-tag-label')) {
    const parentCode = el.dataset.parentCode;
    if (!parentCode) return;
    // Map the literal "Untagged" tag name back to the __untagged__ placeholder
    // that the organize modal uses, so the saved order matches what the modal
    // reads on next open.
    const newOrder = [...list.querySelectorAll(`.sub-tag-label[data-parent-code="${CSS.escape(parentCode)}"]`)]
      .map(e => {
        const t = e.dataset.tagName;
        if (!t || t === 'Untagged') return '__untagged__';
        return t;
      });
    localStorage.setItem(`haven_cat_order_${parentCode}`, JSON.stringify(newOrder));
    localStorage.setItem(`haven_cat_sort_${parentCode}`, 'manual');
    return;
  }

  // Sub-channel was dragged — reorder subs within parent
  if (el.classList.contains('sub-channel-item')) {
    const parentId = parseInt(el.dataset.parentId);
    const parentCh = this.channels.find(c => c.id === parentId);
    if (!parentCh) return;
    const subs = [...list.querySelectorAll(`.sub-channel-item:not(.sub-tag-label)[data-parent-id="${parentId}"]`)];
    const order = subs.map((e, i) => ({ code: e.dataset.code, position: i }));
    this.socket.emit('reorder-channels', { order });
    // Switch parent to manual sort
    if (parentCh.sort_alphabetical !== 0) {
      parentCh.sort_alphabetical = 0;
      this.socket.emit('set-sort-alphabetical', { code: parentCh.code });
    }
    // Switch per-sub-tag sort override to manual if the sub-channel had a tag
    const subTag = el.dataset.subTag;
    if (subTag) {
      const tagSorts = JSON.parse(localStorage.getItem(`haven_tag_sorts_${parentCh.code}`) || '{}');
      tagSorts[subTag] = 'manual';
      localStorage.setItem(`haven_tag_sorts_${parentCh.code}`, JSON.stringify(tagSorts));
    }
    return;
  }

  // Parent channel was dragged — determine its new category from preceding category label
  let newCategory = '';
  let prev = el.previousElementSibling;
  while (prev) {
    if (prev.classList.contains('category-label')) { newCategory = prev.dataset.category || ''; break; }
    prev = prev.previousElementSibling;
  }

  // If category changed, tell the server
  const ch = this.channels.find(c => c.code === el.dataset.code);
  if (ch && (ch.category || '') !== newCategory) {
    this.socket.emit('set-channel-category', { code: el.dataset.code, category: newCategory });
    ch.category = newCategory || null;
  }

  // Reorder all parent channels by new DOM positions
  const parentItems = [...list.querySelectorAll('.channel-item:not(.sub-channel-item):not(.dm-item):not(.temp-channel-create-btn)')];
  const order = parentItems.map((e, i) => ({ code: e.dataset.code, position: i }));
  this.socket.emit('reorder-channels', { order });

  // Switch server to manual sort mode
  localStorage.setItem('haven_server_sort_mode', 'manual');
  if (this.serverSettings) this.serverSettings.channel_sort_mode = 'manual';
  if (this.user?.isAdmin || this._hasPerm('manage_server')) {
    this.socket.emit('update-server-setting', { key: 'channel_sort_mode', value: 'manual' });
  }

  // Switch the dropped channel's category tag sort to manual
  const tagSorts = JSON.parse(localStorage.getItem('haven_tag_sorts___server__') || '{}');
  const catKey = newCategory || '__untagged__';
  if (tagSorts[catKey] !== 'manual') {
    tagSorts[catKey] = 'manual';
    localStorage.setItem('haven_tag_sorts___server__', JSON.stringify(tagSorts));
    if (this.user?.isAdmin || this._hasPerm('manage_server')) {
      this.socket.emit('update-server-setting', { key: 'channel_tag_sorts', value: JSON.stringify(tagSorts) });
    }
  }
},

_setupDmDragDrop() {
  const dmList = document.getElementById('dm-list');
  if (!dmList) return;

  dmList.querySelectorAll('.dm-item').forEach(el => el.setAttribute('draggable', 'true'));

  if (dmList._dragSetupDone) return;
  dmList._dragSetupDone = true;

  let dragSrc = null;
  const indicator = document.createElement('div');
  indicator.className = 'ch-drag-indicator';

  const cleanUp = () => {
    if (dragSrc) { dragSrc.classList.remove('ch-dragging'); dragSrc = null; }
    indicator.remove();
  };

  dmList.addEventListener('dragstart', (e) => {
    const el = e.target.closest('.dm-item[draggable="true"]');
    if (!el) return;
    dragSrc = el;
    dragSrc.classList.add('ch-dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', el.dataset.code || '');
  });

  dmList.addEventListener('dragover', (e) => {
    if (!dragSrc) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const tgt = e.target.closest('.dm-item');
    if (!tgt || tgt === dragSrc) { indicator.remove(); return; }
    const rect = tgt.getBoundingClientRect();
    if (e.clientY < rect.top + rect.height / 2) {
      dmList.insertBefore(indicator, tgt);
    } else {
      dmList.insertBefore(indicator, tgt.nextSibling);
    }
  });

  dmList.addEventListener('dragleave', (e) => {
    if (!dmList.contains(e.relatedTarget)) indicator.remove();
  });

  dmList.addEventListener('drop', (e) => {
    e.preventDefault();
    if (!dragSrc || !indicator.parentNode) { cleanUp(); return; }
    indicator.parentNode.insertBefore(dragSrc, indicator);
    indicator.remove();
    const newOrder = [...dmList.querySelectorAll('.dm-item')].map(el => el.dataset.code);
    localStorage.setItem('haven_dm_order', JSON.stringify(newOrder));
    localStorage.setItem('haven_dm_sort_mode', 'manual');
    dragSrc.classList.remove('ch-dragging');
    dragSrc = null;
  });

  dmList.addEventListener('dragend', cleanUp);
},

_updateBadge(code) {
  const el = document.querySelector(`.channel-item[data-code="${code}"]`);
  if (el) {
    let badge = el.querySelector('.channel-badge:not(.channel-badge-bubble)');
    const count = this.unreadCounts[code] || 0;

    if (count > 0) {
      const ch = this.channels.find(c => c.code === code);
      const isAnn = ch && ch.notification_type === 'announcement';
      if (!badge) { badge = document.createElement('span'); badge.className = 'channel-badge' + (isAnn ? ' announcement-badge' : ''); el.appendChild(badge); }
      badge.textContent = count > 99 ? '99+' : count;
    } else if (badge) {
      badge.remove();
    }

    // If this is a sub-channel whose parent is currently collapsed, bubble an unread
    // indicator up to the parent so the user knows to expand it.
    if (el.dataset.parentId) {
      const parentChannel = this.channels.find(c => c.id === parseInt(el.dataset.parentId));
      if (parentChannel) {
        const parentEl = document.querySelector(`.channel-item[data-code="${parentChannel.code}"]`);
        if (parentEl) {
          // Check if sub-channels are collapsed (arrow has 'collapsed' class)
          const arrow = parentEl.querySelector('.channel-collapse-arrow');
          if (arrow && arrow.classList.contains('collapsed')) {
            // Count total unreads across all sub-channels of this parent
            const siblingCodes = this.channels
              .filter(c => c.parent_channel_id === parentChannel.id)
              .map(c => c.code);
            const siblingTotal = siblingCodes.reduce((sum, sc) => sum + (this.unreadCounts[sc] || 0), 0);
            let parentBubble = parentEl.querySelector('.channel-badge-bubble');
            if (siblingTotal > 0) {
              if (!parentBubble) {
                parentBubble = document.createElement('span');
                parentBubble.className = 'channel-badge channel-badge-bubble';
                parentEl.appendChild(parentBubble);
              }
              parentBubble.textContent = siblingTotal > 99 ? '99+' : siblingTotal;
            } else if (parentBubble) {
              parentBubble.remove();
            }
          } else {
            // Sub-channels are expanded — remove any bubble from parent
            const parentBubble = parentEl.querySelector('.channel-badge-bubble');
            if (parentBubble) parentBubble.remove();
          }
        }
      }
    }
  }

  // Always update DM section badge, tab title, and desktop badge
  // even if the individual channel item isn't in the DOM
  this._updateDmSectionBadge();
  this._updateTabTitle();
  this._updateDesktopBadge();
  this._updateNestedIndicators();
},

// Add a small "look inside" dot to expanded category labels and to
// expanded parent channels when one of their children has unread
// messages. The dot is visually distinct from the count bubble — the
// bubble (with a number) only appears when the parent is collapsed
// and is the actual count; this dot is just a hint that there's
// something below worth scrolling to. (parent-notif feature request)
_updateNestedIndicators() {
  if (!this.channels) return;
  const subChannelMap = {};
  for (const c of this.channels) {
    if (c.parent_channel_id) {
      (subChannelMap[c.parent_channel_id] ||= []).push(c);
    }
  }
  const setDot = (el, on) => {
    if (!el) return;
    let dot = el.querySelector(':scope > .channel-badge-nested-dot');
    if (on) {
      if (!dot) {
        dot = document.createElement('span');
        dot.className = 'channel-badge-nested-dot';
        dot.title = t('channels.nested_unread') || 'Unread messages inside';
        el.appendChild(dot);
      }
    } else if (dot) {
      dot.remove();
    }
  };

  // Category labels: dot if expanded AND any contained channel/sub
  // has unreads. (When collapsed the existing count bubble shows the
  // total instead, so we suppress the dot to avoid duplication.)
  document.querySelectorAll('.section-label.category-label[data-category]').forEach(catEl => {
    const cat = catEl.dataset.category;
    if (!cat) return;
    const collapsed = localStorage.getItem(`haven_cat_collapsed_${cat}`) === 'true';
    if (collapsed) { setDot(catEl, false); return; }
    let total = 0;
    for (const c of this.channels) {
      if (c.is_dm || c.parent_channel_id) continue;
      if ((c.category || '') !== cat) continue;
      total += this.unreadCounts[c.code] || 0;
      for (const s of (subChannelMap[c.id] || [])) {
        total += this.unreadCounts[s.code] || 0;
      }
    }
    setDot(catEl, total > 0);
  });

  // Parent channels with sub-channels: dot if subs are expanded AND
  // any sub has unreads.
  for (const c of this.channels) {
    if (c.is_dm || c.parent_channel_id) continue;
    const subs = subChannelMap[c.id];
    if (!subs || !subs.length) continue;
    const parentEl = document.querySelector(`.channel-item[data-code="${c.code}"]`);
    if (!parentEl) continue;
    const isCollapsed = localStorage.getItem(`haven_subs_collapsed_${c.code}`) === 'true';
    if (isCollapsed) { setDot(parentEl, false); continue; }
    const subTotal = subs.reduce((sum, s) => sum + (this.unreadCounts[s.code] || 0), 0);
    setDot(parentEl, subTotal > 0);
  }
},

_updateTabTitle() {
  const validCodes = new Set((this.channels || []).map(c => c.code));
  const total = Object.entries(this.unreadCounts).reduce((s, [k, v]) => validCodes.has(k) ? s + v : s, 0);
  // Include the server's display name so multiple Haven tabs are easy to tell
  // apart at a glance (issue #5284).
  const serverName = (this.serverSettings && this.serverSettings.server_name) || '';
  const base = serverName && serverName.toLowerCase() !== 'haven'
    ? `Haven: ${serverName}`
    : 'Haven';
  document.title = total > 0 ? `(${total}) ${base}` : base;
},

_updateDesktopBadge() {
  const validCodes = new Set((this.channels || []).map(c => c.code));
  const total = Object.entries(this.unreadCounts).reduce((s, [k, v]) => validCodes.has(k) ? s + v : s, 0);
  // Track last-pushed value so visibility-driven re-syncs (below) can detect
  // when the desktop main process has fallen out of step with the renderer
  // and quietly reassert the correct state without spamming IPC.
  this._lastDesktopBadge = total > 0;
  window.havenDesktop?.setUnreadBadge?.(total > 0);
},

// Re-assert the desktop badge state when the window/tab regains focus.
// Catches the case where a stale "true" badge in the main process never
// got cleared because the renderer that originally raised it was destroyed
// or hot-reloaded without the corresponding clear IPC.  Also covers
// renderers that started before the main process finished wiring badge
// IPC handlers.  Idempotent — sends the current truth, no diff needed.
_resyncDesktopBadgeOnFocus() {
  if (this._desktopBadgeFocusBound) return;
  this._desktopBadgeFocusBound = true;
  const resync = () => {
    if (document.hidden) return;
    try { this._updateDesktopBadge(); } catch {}
  };
  window.addEventListener('focus', resync);
  document.addEventListener('visibilitychange', resync);
},

/**
 * Fire a native OS notification (toast) for an incoming message.
 * Desktop app: always uses havenDesktop.notify() (Electron native).
 * Browser: uses Notification API only when push subscription is NOT active
 *          to avoid duplicate notifications (server-side push handles the rest).
 */
_fireNativeNotification(message, channelCode, opts) {
  // Check per-type notification toggles
  const n = this.notifications;
  if (opts && opts.isMention && n.mentionsEnabled) { /* allowed */ }
  else if (opts && opts.isReply && n.repliesEnabled) { /* allowed */ }
  else if (opts && opts.isDm && n.dmEnabled) { /* allowed */ }
  else if (!n.enabled) return;
  // Don't notify for own messages
  if (message.user_id === this.user?.id) return;

  const sender = this._getNickname(message.user_id, message.username);
  const channel = this.channels?.find(c => c.code === channelCode);
  const channelLabel = channel?.is_dm ? 'DM' : `#${channel?.name || channelCode}`;
  const title = `${sender} in ${channelLabel}`;
  let rawContent = message.content || '';
  // Detect E2E encrypted envelope — show generic text instead of ciphertext
  try { const p = JSON.parse(rawContent); if (p && p.v && p.ct) rawContent = ''; } catch { /* not JSON */ }
  const body = rawContent.length > 120
    ? rawContent.slice(0, 117) + '...'
    : (rawContent || 'Sent a message');

  // Desktop app: always use native Electron notifications
  if (window.havenDesktop?.notify) {
    window.havenDesktop.notify(title, body, { silent: true, channelCode });
    return;
  }

  // Browser: skip if push subscription is active (server sends push instead)
  if (this._pushSubscription) return;

  // Browser Notification API fallback
  if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    try {
      const n = new Notification(title, {
        body,
        tag: `haven-${channelCode}`,
        renotify: true,
        silent: true,
        icon: '/uploads/server-icon.png',
      });
      n.onclick = () => {
        window.focus();
        this.switchChannel(channelCode);
        n.close();
      };
      // Auto-close after 5 seconds
      setTimeout(() => n.close(), 5000);
    } catch { /* Notification constructor can throw in some contexts */ }
  }
},

_updateDmSectionBadge() {
  const badge = document.getElementById('dm-unread-badge');
  if (!badge) return;
  const dmChannels = (this.channels || []).filter(c => c.is_dm);
  const total = dmChannels.reduce((sum, ch) => sum + (this.unreadCounts[ch.code] || 0), 0);
  if (total > 0) {
    badge.textContent = total > 99 ? '99+' : total;
    badge.style.display = '';
  } else {
    badge.textContent = '';
    badge.style.display = 'none';
  }
},

_updateChannelVoiceIndicators() {
  document.querySelectorAll('.channel-item').forEach(el => {
    const code = el.dataset.code;
    let indicator = el.querySelector('.channel-voice-indicator');
    const count = this.voiceCounts[code] || 0;
    const users = this.voiceChannelUsers[code] || [];

    if (count > 0) {
      if (!indicator) {
        indicator = document.createElement('span');
        indicator.className = 'channel-voice-indicator';
        // Insert before the ⋯ button so they don't overlap
        const moreBtn = el.querySelector('.channel-more-btn');
        if (moreBtn) el.insertBefore(indicator, moreBtn);
        else el.appendChild(indicator);
      }
      indicator.innerHTML = `<span class="voice-icon">🔊</span>${count}`;

      // Render voice user list below the channel item
      let userList = el.nextElementSibling;
      if (!userList || !userList.classList.contains('channel-voice-users')) {
        userList = document.createElement('div');
        userList.className = 'channel-voice-users';
        el.after(userList);
      }
      userList.innerHTML = users.map(u => {
        const isSelf = u.id === this.user.id;
        // Self-talking is gated behind the debug toggle: when off, the
        // highlight comes from the server echoing voice-speaking back, so
        // there's no 'self' entry in talkingState.
        const isTalking = this.voice && ((isSelf && this.voice.talkingState.get('self')) || this.voice.talkingState.get(u.id));
        return `<div class="channel-voice-user${isTalking ? ' talking' : ''}" data-user-id="${u.id}" data-username="${this._escapeHtml(u.username)}"><span class="cvu-mic${u.isMuted ? ' is-muted' : ''}" title="${u.isMuted ? 'Muted' : ''}">🎙️</span><span class="cvu-deafen${u.isDeafened ? ' is-deafened' : ''}" title="${u.isDeafened ? 'Deafened' : ''}">🔊</span>${this._escapeHtml(u.username)}</div>`;
      }).join('');
      // Right-click on a left-sidebar voice user → same voice options menu
      userList.querySelectorAll('.channel-voice-user').forEach(item => {
        item.addEventListener('contextmenu', (e) => {
          const userId = parseInt(item.dataset.userId);
          if (isNaN(userId) || userId === this.user.id) return;
          e.preventDefault();
          e.stopPropagation();
          this._showVoiceUserMenu(item, userId, item.dataset.username || '');
        });
      });
    } else {
      if (indicator) indicator.remove();
      // Remove voice user list
      const userList = el.nextElementSibling;
      if (userList && userList.classList.contains('channel-voice-users')) {
        userList.remove();
      }
    }
  });
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
      <input type="text" id="quick-switcher-input" placeholder="Jump to channel or DM..." autocomplete="off" spellcheck="false">
      <div id="quick-switcher-results"></div>
    </div>
  `;
  document.body.appendChild(overlay);

  const input = overlay.querySelector('#quick-switcher-input');
  const results = overlay.querySelector('#quick-switcher-results');
  let selectedIdx = 0;

  const allChannels = (this.channels || []).map(ch => ({
    code: ch.code,
    name: ch.is_dm && ch.dm_target
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
