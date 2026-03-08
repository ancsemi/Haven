export default {

// ── Channel Management ────────────────────────────────

async switchChannel(code) {
  if (this.currentChannel === code) return;

  // Clear any pending image queue from previous channel
  this._clearImageQueue();

  // Voice persists across channel switches — no auto-disconnect

  this.currentChannel = code;
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
  } else {
    // Show just the join button (not the indicator)
    document.getElementById('voice-join-btn').style.display = 'inline-flex';
    const indic = document.getElementById('voice-active-indicator');
    if (indic) indic.style.display = 'none';
    const vp = document.getElementById('voice-panel');
    if (vp) vp.style.display = 'none';
    const mobileJoin = document.getElementById('voice-join-mobile');
    if (mobileJoin) mobileJoin.style.display = '';
  }
  document.getElementById('search-toggle-btn').style.display = '';
  document.getElementById('pinned-toggle-btn').style.display = '';

  // Show/hide topic bar
  this._updateTopicBar(channel?.topic || '');

  const messagesEl = document.getElementById('messages');
  messagesEl.innerHTML = '';
  document.getElementById('message-area').style.display = 'flex';
  document.getElementById('no-channel-msg').style.display = 'none';

  document.querySelectorAll('.channel-item').forEach(el => el.classList.remove('active'));
  const activeEl = document.querySelector(`.channel-item[data-code="${code}"]`);
  if (activeEl) activeEl.classList.add('active');

  this.unreadCounts[code] = 0;
  this._updateBadge(code);

  document.getElementById('status-channel').textContent = isDm && channel.dm_target
    ? `DM: ${channel.dm_target.username}` : channel ? channel.name : code;

  // Reset pagination state for the new channel
  this._oldestMsgId = null;
  this._noMoreHistory = false;
  this._loadingHistory = false;
  this._historyBefore = null;

  this.socket.emit('enter-channel', { code });
  // E2E: fetch DM partner's public key BEFORE requesting messages
  if (isDm && channel) await this._fetchDMPartnerKey(channel);
  this.socket.emit('get-messages', { code });
  this.socket.emit('get-channel-members', { code });
  this.socket.emit('request-voice-users', { code });
  this._clearReply();

  // Auto-focus the message input for quick typing
  const msgInput = document.getElementById('message-input');
  if (msgInput) setTimeout(() => msgInput.focus(), 50);

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
  if (topic) {
    bar.textContent = topic;
    bar.style.display = 'block';
    bar.title = this.user.isAdmin ? 'Click to edit topic' : topic;
    bar.onclick = this.user.isAdmin ? () => this._editTopic() : null;
    bar.style.cursor = this.user.isAdmin ? 'pointer' : 'default';
  } else {
    if (this.user.isAdmin) {
      bar.textContent = 'Click to set a topic...';
      bar.style.display = 'block';
      bar.style.opacity = '0.4';
      bar.style.cursor = 'pointer';
      bar.onclick = () => this._editTopic();
    } else {
      bar.style.display = 'none';
    }
  }
  if (topic) bar.style.opacity = '1';
},

_editTopic() {
  const channel = this.channels.find(c => c.code === this.currentChannel);
  const current = channel?.topic || '';
  const newTopic = prompt('Set channel topic (max 256 chars):', current);
  if (newTopic === null) return; // cancelled
  this.socket.emit('set-channel-topic', { code: this.currentChannel, topic: newTopic.slice(0, 256) });
},

_showWelcome() {
  document.getElementById('message-area').style.display = 'none';
  document.getElementById('no-channel-msg').style.display = 'flex';
  document.getElementById('channel-header-name').textContent = 'Select a channel';
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
  document.getElementById('status-channel').textContent = 'None';
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
  menu.querySelectorAll('.mod-only').forEach(el => {
    el.style.display = isMod ? '' : 'none';
  });
  // Hide "Create Sub-channel" if this is already a sub-channel
  const ch = this.channels.find(c => c.code === code);
  const createSubBtn = menu.querySelector('[data-action="create-sub-channel"]');
  if (createSubBtn && ch && ch.parent_channel_id) {
    createSubBtn.style.display = 'none';
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
  // Update toggle indicators for streams/music
  const streamsBtn = menu.querySelector('[data-action="toggle-streams"]');
  const musicBtn = menu.querySelector('[data-action="toggle-music"]');
  if (streamsBtn && ch) {
    const on = ch.streams_enabled !== 0;
    streamsBtn.innerHTML = on
      ? '🖥️ Streams <span class="ctx-indicator ctx-on">✅ ON</span>'
      : '🖥️ Streams <span class="ctx-indicator ctx-off">❌ OFF</span>';
  }
  if (musicBtn && ch) {
    const on = ch.music_enabled !== 0;
    musicBtn.innerHTML = on
      ? '🎵 Music <span class="ctx-indicator ctx-on">✅ ON</span>'
      : '🎵 Music <span class="ctx-indicator ctx-off">❌ OFF</span>';
  }
  // Update slow mode indicator
  const slowBtn = menu.querySelector('[data-action="slow-mode"]');
  if (slowBtn && ch) {
    const interval = ch.slow_mode_interval || 0;
    slowBtn.innerHTML = interval > 0
      ? `🐢 Slow Mode <span class="ctx-indicator ctx-on">${interval}s</span>`
      : '🐢 Slow Mode <span class="ctx-indicator ctx-off">OFF</span>';
  }
  // Update mute label
  const muted = JSON.parse(localStorage.getItem('haven_muted_channels') || '[]');
  const muteBtn = menu.querySelector('[data-action="mute"]');
  if (muteBtn) muteBtn.textContent = muted.includes(code) ? '🔕 Unmute Channel' : '🔔 Mute Channel';
  // Show/hide voice options based on current voice state
  const joinVoiceBtn = menu.querySelector('[data-action="join-voice"]');
  const leaveVoiceBtn = menu.querySelector('[data-action="leave-voice"]');
  const inVoice = this.voice && this.voice.inVoice;
  const inThisChannel = inVoice && this.voice.currentChannel === code;
  if (joinVoiceBtn) joinVoiceBtn.style.display = inThisChannel ? 'none' : '';
  if (leaveVoiceBtn) leaveVoiceBtn.style.display = inVoice ? '' : 'none';
  // Position near the button
  const rect = btnEl.getBoundingClientRect();
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

_closeChannelCtxMenu() {
  if (this._ctxMenuEl) this._ctxMenuEl.style.display = 'none';
  this._ctxMenuChannel = null;
},

/* ── DM context menu helpers ──────────────────────────── */
_initDmContextMenu() {
  this._dmCtxMenuEl = document.getElementById('dm-ctx-menu');
  this._dmCtxMenuCode = null;

  // Mute DM
  document.querySelector('[data-action="dm-mute"]')?.addEventListener('click', () => {
    const code = this._dmCtxMenuCode;
    if (!code) return;
    this._closeDmCtxMenu();
    const muted = JSON.parse(localStorage.getItem('haven_muted_channels') || '[]');
    const idx = muted.indexOf(code);
    if (idx >= 0) { muted.splice(idx, 1); this._showToast('DM unmuted', 'success'); }
    else { muted.push(code); this._showToast('DM muted', 'success'); }
    localStorage.setItem('haven_muted_channels', JSON.stringify(muted));
  });

  // Delete DM
  document.querySelector('[data-action="dm-delete"]')?.addEventListener('click', () => {
    const code = this._dmCtxMenuCode;
    if (!code) return;
    this._closeDmCtxMenu();
    if (!confirm('⚠️ Delete this DM?\nAll messages will be permanently deleted for both users.')) return;
    this.socket.emit('delete-dm', { code });
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
  if (muteBtn) muteBtn.textContent = muted.includes(code) ? '🔕 Unmute DM' : '🔔 Mute DM';

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

/* ── Re-parent channel modal (move to / promote) ───── */

_openReparentModal(code) {
  const ch = this.channels.find(c => c.code === code);
  if (!ch) return;

  const titleEl = document.getElementById('reparent-modal-title');
  const descEl = document.getElementById('reparent-modal-desc');
  const listEl = document.getElementById('reparent-channel-list');

  titleEl.textContent = '📦 Move Channel';
  descEl.textContent = `Select a new parent for "${ch.name}"`;

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
      <span style="flex:1"><strong>Promote to top-level channel</strong></span>
    </div>`;
  }

  for (const t of targets) {
    const subCount = this.channels.filter(c => c.parent_channel_id === t.id).length;
    const badge = subCount > 0 ? ` <span style="opacity:0.4;font-size:0.8em">(${subCount} sub-ch)</span>` : '';
    html += `<div class="organize-item reparent-option" data-target="${t.code}">
      <span style="opacity:0.5">#</span>
      <span style="flex:1">${this._escapeHtml(t.name)}${badge}</span>
    </div>`;
  }

  if (!targets.length && !ch.parent_channel_id) {
    html += '<p style="text-align:center;opacity:0.5;padding:16px;font-size:0.85rem">No valid parent channels available</p>';
  }

  listEl.innerHTML = html;

  // Wire up click handlers on the targets
  listEl.querySelectorAll('.reparent-option').forEach(el => {
    el.addEventListener('click', () => {
      const target = el.dataset.target;
      const newParentCode = target === '__top__' ? null : target;
      const action = newParentCode === null
        ? `Promote "${ch.name}" to a top-level channel?`
        : `Move "${ch.name}" under "${this.channels.find(c => c.code === newParentCode)?.name || target}"?`;
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
    this._organizeTagSorts = JSON.parse(localStorage.getItem('haven_tag_sorts___server__') || '{}');
    this._organizeCatOrder = JSON.parse(localStorage.getItem('haven_cat_order___server__') || '[]');
    this._organizeCatSort = localStorage.getItem('haven_cat_sort___server__') || 'az';

    document.getElementById('organize-modal-title').textContent = '📋 Organize Channels';
    document.getElementById('organize-modal-parent-name').textContent = 'Reorder channels and assign category tags';
    // Server-level sort is stored in localStorage (no single parent channel to hold it)
    const sortSel = document.getElementById('organize-global-sort');
    const savedSort = localStorage.getItem('haven_server_sort_mode') || 'manual';
    sortSel.value = savedSort;
    const catSortSel = document.getElementById('organize-cat-sort');
    if (catSortSel) catSortSel.value = this._organizeCatSort;
    document.getElementById('organize-tag-input').value = '';
    const backBtn = document.getElementById('organize-back-btn');
    if (backBtn) backBtn.style.display = 'none';
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

  document.getElementById('organize-modal-title').textContent = '📋 Organize Sub-channels';
  document.getElementById('organize-modal-parent-name').textContent = `# ${parent.name}`;
  // Map sort_alphabetical: 0=manual, 1=alpha, 2=created
  const sortSel = document.getElementById('organize-global-sort');
  sortSel.value = parent.sort_alphabetical === 1 ? 'alpha' : parent.sort_alphabetical === 2 ? 'created' : parent.sort_alphabetical === 3 ? 'oldest' : 'manual';
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
  this._renderOrganizeList();
  document.getElementById('organize-modal').style.display = 'flex';
},

_renderOrganizeList() {
  const listEl = document.getElementById('organize-channel-list');
  const globalSort = document.getElementById('organize-global-sort').value;

  let displayList = [...(this._organizeList || [])];

  // Collect unique tags (including __untagged__ as a sortable entry)
  const realTags = [...new Set(displayList.filter(c => c.category).map(c => c.category))];
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
        const tagItems = sortGroup(displayList.filter(c => c.category === key), tagSort);
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
      const label = group.tag ? this._escapeHtml(group.tag) : 'Untagged';
      const isTagSelected = this._organizeSelectedTag === tagKey;
      html += `<div class="organize-tag-header${isTagSelected ? ' selected' : ''}" data-tag-key="${this._escapeHtml(tagKey)}">
        <span>${label}</span>
        <select class="tag-sort-select" data-tag="${this._escapeHtml(tagKey)}" title="Sort this group">
          <option value="manual"${group.sort === 'manual' ? ' selected' : ''}>Manual</option>
          <option value="alpha"${group.sort === 'alpha' ? ' selected' : ''}>A→Z</option>
          <option value="created"${group.sort === 'created' ? ' selected' : ''}>Newest</option>
          <option value="oldest"${group.sort === 'oldest' ? ' selected' : ''}>Oldest</option>
        </select>
      </div>`;
    }

    for (const ch of group.items) {
      const sel = this._organizeSelected === ch.code;
      const tagBadge = ch.category ? `<span class="organize-tag-badge">${this._escapeHtml(ch.category)}</span>` : '';
      const icon = this._organizeServerLevel ? '#' : (ch.is_private ? '🔒' : '↳');
      const hasSubs = this._organizeServerLevel && this.channels.some(c => c.parent_channel_id === ch.id);
      const drillHint = hasSubs ? `<span class="organize-drill-hint" title="Double-click to organize sub-channels">▶</span>` : '';
      html += `<div class="organize-item${sel ? ' selected' : ''}${hasSubs ? ' organize-has-subs' : ''}" data-code="${ch.code}">
        <span style="opacity:0.5">${icon}</span>
        <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${this._escapeHtml(ch.name)}</span>
        ${tagBadge}${drillHint}
      </div>`;
    }
  }

  if (!displayList.length) {
    html = '<div style="padding:24px;text-align:center;opacity:0.4;font-size:0.9rem">' + (this._organizeServerLevel ? 'No channels yet' : 'No sub-channels yet') + '</div>';
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
      this._renderOrganizeList();
    });
  });

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
  const globalSort = document.getElementById('organize-global-sort').value;
  const tagKey = ch.category || '__untagged__';
  const effectiveSort = this._organizeTagSorts[tagKey] || globalSort;

  // Collect channels in the same tag group
  const group = ch.category
    ? this._organizeList.filter(c => c.category === ch.category)
    : this._organizeList.filter(c => !c.category);

  // Sort by effective mode (mirrors _renderOrganizeList's sortGroup)
  if (effectiveSort === 'alpha') {
    group.sort((a, b) => a.name.localeCompare(b.name));
  } else if (effectiveSort === 'created') {
    group.sort((a, b) => (b.id || 0) - (a.id || 0));
  } else if (effectiveSort === 'oldest') {
    group.sort((a, b) => (a.id || 0) - (b.id || 0));
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
  const realTags = [...new Set(displayList.filter(c => c.category).map(c => c.category))];
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

  this._renderOrganizeList();
  if (this._organizeServerLevel) this._renderChannels();
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

  const getDmName = (ch) => ch.dm_target ? this._getNickname(ch.dm_target.id, ch.dm_target.username) : 'Unknown';

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
      html += `<div class="organize-tag-header" style="opacity:0.5">Uncategorized</div>`;
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
  listEl.innerHTML = html || '<p class="muted-text">No DMs to organize</p>';

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
  document.getElementById('webhook-list').innerHTML = '<p style="opacity:0.5;font-size:0.85rem">Loading…</p>';
  modal.style.display = 'flex';
  this.socket.emit('get-webhooks', { channelCode });
},

_renderWebhookList(webhooks, channelCode) {
  const container = document.getElementById('webhook-list');
  if (!webhooks.length) {
    container.innerHTML = '<p style="opacity:0.5;font-size:0.85rem">No webhooks yet. Create one above.</p>';
    return;
  }
  container.innerHTML = webhooks.map(wh => {
    const maskedToken = wh.token.slice(0, 8) + '••••••••';
    const statusLabel = wh.is_active ? '🟢 Active' : '🔴 Disabled';
    const toggleLabel = wh.is_active ? 'Disable' : 'Enable';
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
      if (confirm('Delete this webhook? This cannot be undone.')) {
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
      if (tagA !== tagB) {
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
      return (a.position || 0) - (b.position || 0); // manual
    };

    // Map string modes to numbers for consistency
    const modeToNum = (m) => m === 'alpha' ? 1 : m === 'created' ? 2 : m === 'oldest' ? 3 : m === 'manual' ? 0 : m;

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
  });

  // Sort parent channels — respect server-level sort mode & per-tag overrides
  const serverSortMode = localStorage.getItem('haven_server_sort_mode') || 'manual';
  const serverTagOverrides = JSON.parse(localStorage.getItem('haven_tag_sorts___server__') || '{}');
  const parentHasTags = parentChannels.some(c => c.category);

  const serverSortByMode = (a, b, mode) => {
    if (mode === 'alpha') return a.name.localeCompare(b.name);
    if (mode === 'created') return (b.id || 0) - (a.id || 0);
    if (mode === 'oldest') return (a.id || 0) - (b.id || 0);
    return (a.position || 0) - (b.position || 0) || a.name.localeCompare(b.name); // manual
  };

  // Load stored category order for server-level categories
  const serverCatOrder = JSON.parse(localStorage.getItem('haven_cat_order___server__') || '[]');
  const serverCatSort = localStorage.getItem('haven_cat_sort___server__') || 'az';

  if (parentHasTags) {
    const tagGroup = (a, b) => {
      const tagA = a.category || '';
      const tagB = b.category || '';
      if (tagA !== tagB) {
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

    const hashIcon = isSub ? (ch.is_private ? '🔒' : '↳') : '#';

    // Build small status indicators for channel features
    let indicators = '';
    if (!isSub) {
      const badges = [];
      if (ch.streams_enabled === 0) badges.push('<span title="Streams disabled" style="opacity:0.4;font-size:0.65rem">🖥️</span>');
      if (ch.music_enabled === 0) badges.push('<span title="Music disabled" style="opacity:0.4;font-size:0.65rem">🎵</span>');
      if (ch.slow_mode_interval > 0) badges.push('<span title="Slow mode: ' + ch.slow_mode_interval + 's" style="opacity:0.5;font-size:0.65rem">🐢</span>');
      if (badges.length) indicators = `<span class="channel-indicators" style="margin-left:auto;display:flex;gap:2px;flex-shrink:0">${badges.join('')}</span>`;
    }

    el.innerHTML = `
      ${hasSubs ? `<span class="channel-collapse-arrow${isCollapsed ? ' collapsed' : ''}" title="Expand/collapse sub-channels">▾</span>` : ''}
      <span class="channel-hash">${hashIcon}</span>
      <span class="channel-name">${this._escapeHtml(ch.name)}</span>
      ${indicators}
      <button class="channel-more-btn" title="Channel options">⋯</button>
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
      });
    }

    const count = (ch.code in this.unreadCounts) ? this.unreadCounts[ch.code] : (ch.unreadCount || 0);
    if (count > 0) {
      const badge = document.createElement('span');
      badge.className = 'channel-badge';
      badge.textContent = count > 99 ? '99+' : count;
      el.appendChild(badge);
    }

    el.addEventListener('click', () => this.switchChannel(ch.code));
    // Double-click to join voice in the channel
    el.addEventListener('dblclick', () => {
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
      // Ignore clicks on the organize button inside the header
      if (e.target.closest('#organize-channels-btn')) return;
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
  }
  if (channelsCollapsed) {
    list.style.display = 'none';
    const cp = document.getElementById('channels-pane');
    const dp = document.getElementById('dm-pane');
    if (cp) cp.style.flex = '0 0 auto';
    if (dp) dp.style.flex = '1 1 0';
  }

  // ── Render channels grouped by category ──
  const categories = new Map();
  parentChannels.forEach(ch => {
    const cat = ch.category || '';
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
    if (cat) {
      const catLabel = document.createElement('h5');
      catLabel.className = 'section-label category-label';
      catLabel.style.cssText = 'padding:10px 12px 4px;font-size:0.7rem;text-transform:uppercase;letter-spacing:0.05em;opacity:0.5;user-select:none';
      catLabel.textContent = cat;
      list.appendChild(catLabel);
    }

    categories.get(cat).forEach(ch => {
      list.appendChild(renderChannelItem(ch, false));
      const subs = subChannelMap[ch.id] || [];
      const isCollapsed = localStorage.getItem(`haven_subs_collapsed_${ch.code}`) === 'true';
      const subHasTags = subs.some(s => s.category);
      let lastSubTag = undefined;
      subs.forEach(sub => {
        if (subHasTags && sub.category !== lastSubTag) {
          const tagLabel = document.createElement('div');
          tagLabel.className = 'sub-channel-item sub-tag-label';
          tagLabel.dataset.parentId = ch.id;
          tagLabel.style.cssText = 'padding:4px 12px 2px 28px;font-size:0.65rem;text-transform:uppercase;letter-spacing:0.05em;opacity:0.35;user-select:none;font-weight:600';
          tagLabel.textContent = sub.category || 'Untagged';
          if (isCollapsed) tagLabel.style.display = 'none';
          list.appendChild(tagLabel);
          lastSubTag = sub.category;
        }
        const subEl = renderChannelItem(sub, true);
        if (isCollapsed) subEl.style.display = 'none';
        list.appendChild(subEl);
      });
    });
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
      });
    }

    if (dmArrow) dmArrow.classList.toggle('collapsed', dmCollapsed);
    if (dmCollapsed) dmList.style.display = 'none';

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

    const getDmName = (ch) => ch.dm_target ? this._getNickname(ch.dm_target.id, ch.dm_target.username) : 'Unknown';

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
      moreBtn.title = 'More options';
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
      el.addEventListener('click', () => this.switchChannel(ch.code));
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
        header.innerHTML = `<span class="dm-category-arrow${uncatCollapsed ? ' collapsed' : ''}">▾</span> <span class="dm-category-name">Uncategorized</span>`;
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
},

_updateBadge(code) {
  const el = document.querySelector(`.channel-item[data-code="${code}"]`);
  if (!el) return;

  let badge = el.querySelector('.channel-badge');
  const count = this.unreadCounts[code] || 0;

  if (count > 0) {
    if (!badge) { badge = document.createElement('span'); badge.className = 'channel-badge'; el.appendChild(badge); }
    badge.textContent = count > 99 ? '99+' : count;
  } else if (badge) {
    badge.remove();
  }

  // Update the DM section header total badge
  this._updateDmSectionBadge();
  // Update browser tab title with total unread count
  this._updateTabTitle();
  // Notify desktop shell to set/clear taskbar badge
  this._updateDesktopBadge();
},

_updateTabTitle() {
  const total = Object.values(this.unreadCounts).reduce((s, v) => s + v, 0);
  document.title = total > 0 ? `(${total}) Haven` : 'Haven';
},

_updateDesktopBadge() {
  const total = Object.values(this.unreadCounts).reduce((s, v) => s + v, 0);
  window.havenDesktop?.setUnreadBadge?.(total > 0);
},

/**
 * Fire a native OS notification (toast) for an incoming message.
 * Desktop app: always uses havenDesktop.notify() (Electron native).
 * Browser: uses Notification API only when push subscription is NOT active
 *          to avoid duplicate notifications (server-side push handles the rest).
 */
_fireNativeNotification(message, channelCode) {
  if (!this.notifications.enabled) return;
  // Don't notify for own messages
  if (message.user_id === this.user?.id) return;

  const sender = this._getNickname(message.user_id, message.username);
  const channel = this.channels?.find(c => c.code === channelCode);
  const channelLabel = channel?.is_dm ? 'DM' : `#${channel?.name || channelCode}`;
  const title = `${sender} in ${channelLabel}`;
  const body = (message.content || '').length > 120
    ? message.content.slice(0, 117) + '...'
    : (message.content || 'Sent an attachment');

  // Desktop app: always use native Electron notifications
  if (window.havenDesktop?.notify) {
    window.havenDesktop.notify(title, body, { silent: true });
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
      userList.innerHTML = users.map(u =>
        `<div class="channel-voice-user" data-user-id="${u.id}"><span class="cvu-icon">🎤</span>${this._escapeHtml(u.username)}</div>`
      ).join('');
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

};
