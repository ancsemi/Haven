// The "..." menus on channels and DMs, hiding channels from your own
// sidebar, and the Channel Functions panel with its per-channel switches.

export default {

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
  // One menu at a time: a DM menu left open sat on top of this one (#5744).
  this._closeDmCtxMenu?.();
  this._ctxMenuChannel = code;
  const menu = this._ctxMenuEl;
  if (!menu) return;
  // Show/hide admin-only items (also allow users with create_channel perm)
  const isAdmin = this.user && this.user.isAdmin;
  const canManageChannels = isAdmin || this._hasPerm('create_channel');
  // (#5467) Channel Functions is gated on its own permission now, so a
  // moderator who runs one channel can configure it without also holding
  // create_channel. The answer is per channel and comes from the server
  // (canManageSettings on the channel row); the flat permission list can't
  // tell "manage this channel" apart from "manage some other channel", so it
  // used to show the entry everywhere once you held the permission anywhere.
  const ch = this.channels.find(c => c.code === code);
  const canManageSettings = isAdmin || !!(ch && ch.canManageSettings);
  const canManageSubs = isAdmin || !!(ch && ch.canManageSubs);
  const isMod = isAdmin || this._canModerate();
  menu.querySelectorAll('.admin-only').forEach(el => {
    el.style.display = canManageChannels ? '' : 'none';
  });
  const cfnCtxBtn = menu.querySelector('[data-action="channel-functions"]');
  if (cfnCtxBtn) cfnCtxBtn.style.display = canManageSettings ? '' : 'none';
  if (!canManageChannels && canManageSettings) {
    const adminSeps = menu.querySelectorAll('hr.channel-ctx-sep.admin-only');
    if (adminSeps[0]) adminSeps[0].style.display = '';
  }
  // Webhook button: also accessible to users with manage_webhooks permission
  const webhooksCtxBtn = menu.querySelector('[data-action="webhooks"]');
  const canManageWebhooks = canManageChannels || this._hasPerm('manage_webhooks');
  if (webhooksCtxBtn) {
    webhooksCtxBtn.style.display = canManageWebhooks ? '' : 'none';
    // If user only has manage_webhooks (not full admin), show a separator above
    if (!canManageChannels && canManageWebhooks) {
      const adminSeps = menu.querySelectorAll('hr.channel-ctx-sep.admin-only');
      if (adminSeps[0]) adminSeps[0].style.display = '';
    }
  }
  // Show delete button for users with delete_channel permission even if not admin
  const deleteBtn = menu.querySelector('[data-action="delete"]');
  if (deleteBtn && !canManageChannels && this._hasPerm('delete_channel')) {
    deleteBtn.style.display = '';
  }
  // Also show delete for users who created a temp channel
  if (deleteBtn && !canManageChannels && !this._hasPerm('delete_channel')) {
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
  const copyChannelLinkBtn = menu.querySelector('[data-action="copy-channel-link"]');
  if (copyChannelLinkBtn) {
    const canShare = !!(ch && !ch.is_dm && !ch.is_private && ch.code_visibility !== 'private');
    copyChannelLinkBtn.style.display = canShare ? '' : 'none';
  }
  // Show "Create Sub-channel" only to people who manage this channel's
  // sub-channels. The server answers that per channel (canManageSubs);
  // create_channel no longer counts, and neither does being a moderator
  // somewhere else, both of which put a button here that always got
  // refused. (#5467)
  const createSubBtn = menu.querySelector('[data-action="create-sub-channel"]');
  if (createSubBtn) {
    const canCreateSub = isAdmin || !!(ch && ch.canManageSubs);
    createSubBtn.style.display = (canCreateSub && ch && !ch.parent_channel_id) ? '' : 'none';
  }
  // (#5424) The Rename action was only shown to moderators (effective level
  // >= 25), so granting rename_channel / rename_sub_channel had no effect in
  // the UI even though the server enforces exactly those permissions. Show it
  // whenever the user actually holds the matching rename permission.
  const renameCtxBtn = menu.querySelector('[data-action="rename-channel"]');
  if (renameCtxBtn && ch) {
    const renamePerm = ch.parent_channel_id ? 'rename_sub_channel' : 'rename_channel';
    const canRename = isMod || this._hasPerm(renamePerm);
    renameCtxBtn.style.display = canRename ? '' : 'none';
  }
  // Only display the divider when the "rename-channel" and/or "create-sub-channel" buttons are visible.
  // this eliminates a double divider being displayed when both of these buttons are not displayed
  const renameOrCreateSubDivider = menu.querySelector('.channel-ctx-sep.rename-or-createSub');
  if (renameOrCreateSubDivider && ch) {
    const renameCtxBtn_visible = renameCtxBtn && renameCtxBtn.style.display !== 'none';
    const createSubBtn_visible = createSubBtn && createSubBtn.style.display !== 'none';
    renameOrCreateSubDivider.style.display = (renameCtxBtn_visible || createSubBtn_visible) ? '' : 'none';
  }
  // Hide "Leave Channel" for admins (always in all channels)
  const leaveBtn = menu.querySelector('[data-action="leave-channel"]');
  if (leaveBtn) leaveBtn.style.display = isAdmin ? 'none' : '';
  // (#5409) Admins can't leave channels (they need access to all of them), so
  // give them a local-only "Hide Channel" to declutter their sidebar instead.
  const hideBtn = menu.querySelector('[data-action="hide-channel"]');
  if (hideBtn) hideBtn.style.display = isAdmin ? '' : 'none';
  // Show "Organize" only for parent channels that have sub-channels
  const organizeBtn = menu.querySelector('[data-action="organize"]');
  if (organizeBtn) {
    const hasSubs = ch && !ch.parent_channel_id && this.channels.some(c => c.parent_channel_id === ch.id);
    // (#5424) Sub-channel managers can organize a parent's sub-channels, not
    // just users with the server-wide create_channel permission.
    const canOrganize = canManageChannels || this._hasPerm('manage_sub_channels');
    organizeBtn.style.display = (canOrganize && hasSubs) ? '' : 'none';
  }
  // Show "Move to…" for channels that can become sub-channels (no children of their own)
  const moveToBtn = menu.querySelector('[data-action="move-to-parent"]');
  if (moveToBtn && ch) {
    const hasChildren = this.channels.some(c => c.parent_channel_id === ch.id);
    // (#5492) Mirror the server's rule instead of approximating it: you need
    // the current parent if there is one, plus at least one destination you
    // actually manage. A top-level channel has no parent to answer to, so
    // managing a destination is enough to pull it in, otherwise the entry
    // hid an action the server would have allowed.
    const sourceOk = !ch.parent_channel_id || canManageSubs;
    const hasTarget = this._reparentTargets(ch).length > 0;
    moveToBtn.style.display = (sourceOk && hasTarget && !ch.is_dm && !hasChildren) ? '' : 'none';
  }
  // Show "Promote to Channel" only for sub-channels
  const promoteBtn = menu.querySelector('[data-action="promote-channel"]');
  if (promoteBtn && ch) {
    promoteBtn.style.display = (canManageSubs && ch.parent_channel_id) ? '' : 'none';
  }
  // Update Channel Functions panel with current channel values
  if (canManageSettings) this._updateChannelFunctionsPanel(ch);
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
  const _noVP = !this.user?.isAdmin && !this.user?.isGuest && !this._hasPerm('use_voice');
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

/* ── Hidden channels (admin declutter, local-only, #5409) ─────────────
   Admins can't leave channels because they need access to every one, so
   instead they can hide a channel from their own sidebar. This is purely a
   per-device view preference (localStorage), like mute. It never changes
   membership or affects anyone else, and the channel stays fully accessible
   via the "N hidden channels" restore bar. */
_getHiddenChannels() {
  try { return JSON.parse(localStorage.getItem('haven_hidden_channels') || '[]'); }
  catch { return []; }
},
_setHiddenChannels(list) {
  localStorage.setItem('haven_hidden_channels', JSON.stringify([...new Set(list)]));
},
_hideChannel(code) {
  const hidden = this._getHiddenChannels();
  if (!hidden.includes(code)) hidden.push(code);
  this._setHiddenChannels(hidden);
  const ch = this.channels.find(c => c.code === code);
  const name = ch ? ch.name : code;
  // If we're currently viewing the channel we're hiding, jump to the first
  // remaining visible channel so we're not left staring at a hidden one.
  if (this.currentChannel === code) {
    const remaining = this.channels.filter(c => !c.is_dm && c.code !== code && !hidden.includes(c.code));
    if (remaining.length) this.switchChannel(remaining[0].code);
  }
  this._renderChannels();
  this._showToast(t('toasts.channel_hidden', { name }), 'success');
},
_unhideChannel(code) {
  this._setHiddenChannels(this._getHiddenChannels().filter(c => c !== code));
  this._renderChannels();
},
_unhideAllChannels() {
  this._setHiddenChannels([]);
  this._renderChannels();
},
_openHiddenChannelsModal() {
  const modal = document.getElementById('hidden-channels-modal');
  if (!modal) return;
  this._renderHiddenChannelsModal();
  modal.style.display = 'flex';
  const closeBtn = document.getElementById('hidden-channels-close-btn');
  const closeHandler = () => {
    modal.style.display = 'none';
    closeBtn?.removeEventListener('click', closeHandler);
    modal.removeEventListener('click', overlayHandler);
  };
  const overlayHandler = (e) => { if (e.target === modal) closeHandler(); };
  closeBtn?.addEventListener('click', closeHandler);
  modal.addEventListener('click', overlayHandler);
},
_renderHiddenChannelsModal() {
  const container = document.getElementById('hidden-channels-content');
  if (!container) return;
  container.innerHTML = '';
  const items = this._getHiddenChannels()
    .map(code => this.channels.find(c => c.code === code))
    .filter(Boolean);
  if (!items.length) {
    const empty = document.createElement('p');
    empty.style.cssText = 'opacity:0.6;font-size:0.85rem;text-align:center;padding:16px';
    empty.textContent = t('channels.no_hidden_channels');
    container.appendChild(empty);
    return;
  }
  const showAll = document.createElement('button');
  showAll.className = 'btn-sm';
  showAll.style.cssText = 'margin-bottom:10px';
  showAll.textContent = t('channels.show_all_hidden');
  showAll.addEventListener('click', () => {
    this._unhideAllChannels();
    document.getElementById('hidden-channels-modal').style.display = 'none';
  });
  container.appendChild(showAll);
  items.forEach(ch => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 4px;border-bottom:1px solid var(--border-color,rgba(255,255,255,0.08))';
    const nameSpan = document.createElement('span');
    nameSpan.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    nameSpan.textContent = (ch.is_private ? '🔒 ' : '# ') + ch.name;
    const btn = document.createElement('button');
    btn.className = 'btn-sm';
    btn.textContent = t('channels.unhide_channel');
    btn.addEventListener('click', () => {
      this._unhideChannel(ch.code);
      this._renderHiddenChannelsModal();
    });
    row.appendChild(nameSpan);
    row.appendChild(btn);
    container.appendChild(row);
  });
},

_setCfnBadge(fn, isOn, text) {
  const row = document.querySelector(`.cfn-row[data-fn="${fn}"]`);
  if (!row) return;
  let badge = row.querySelector('.cfn-badge');
  if (!badge) {
    // The badge was swapped for an editor: put it back, the whole editor.
    // Self Destruct's is an hours box and a mode drop-down in a wrapper, and
    // replacing only the box left the drop-down behind in this shared panel,
    // where every other channel then showed it too (#5702).
    const editor = row.querySelector('.cfn-input-wrap') || row.querySelector('.cfn-input');
    badge = document.createElement('span');
    badge.className = 'cfn-badge';
    if (editor) editor.replaceWith(badge);
    else return;
  }
  badge.textContent = text;
  badge.className = 'cfn-badge ' + (isOn ? 'cfn-on' : 'cfn-off');
},

// Undo the last optimistic Channel Functions toggle. Rows apply their new
// value immediately so the switch feels instant, but the server is free to
// refuse: it replies with error-msg and never broadcasts a channel list, so
// nothing else would ever correct the row. Called from the error-msg handler;
// the saved values are cleared by channels-list, which is what a server that
// accepted the change sends back.
_revertPendingChannelToggle() {
  const pending = this._cfnPendingToggle;
  if (!pending) return;
  this._cfnPendingToggle = null;
  // Only errors that answer the click we just made are ours to act on.
  if (Date.now() - pending.at > 5000) return;
  const ch = (this.channels || []).find(c => c.code === pending.code);
  if (!ch) return;
  Object.assign(ch, pending.prev);
  const panel = document.getElementById('channel-functions-panel');
  if (panel && panel.style.display !== 'none' && this._ctxMenuChannel === pending.code) {
    this._updateChannelFunctionsPanel(ch);
  }
},


_channelAllowsReactions(code) {
  const ch = (this.channels || []).find(c => c.code === (code || this.currentChannel));
  if (!ch) return true;
  return ch.reactions_enabled !== 0;
},

_applyReactionLock() {
  const allowed = this._channelAllowsReactions(this.currentChannel);
  const lockRoots = [
    document.getElementById('messages'),
    document.getElementById('thread-messages')
  ];
  for (const root of lockRoots) {
    if (!root) continue;
    root.classList.toggle('reactions-locked', !allowed);
    root.querySelectorAll('[data-action="react"], [data-thread-action="react"]').forEach(el => {
      el.hidden = !allowed;
    });
  }
  if (!allowed) {
    document.querySelectorAll('#messages .reaction-picker, #thread-messages .reaction-picker, .reaction-full-picker').forEach(el => el.remove());
    document.querySelectorAll('#messages .showing-picker, #thread-messages .showing-picker').forEach(el => el.classList.remove('showing-picker'));
  }
},

_updateChannelFunctionsPanel(ch) {
  if (!ch) return;
  // Voice & text toggles
  const voiceOff = ch.voice_enabled === 0;
  const textOff = ch.text_enabled === 0;
  this._setCfnBadge('voice', !voiceOff, t(voiceOff ? 'channel_functions.off' : 'channel_functions.on'));
  this._setCfnBadge('text', !textOff, t(textOff ? 'channel_functions.off' : 'channel_functions.on'));
  // Basic toggles
  this._setCfnBadge('streams', ch.streams_enabled !== 0, t(ch.streams_enabled !== 0 ? 'channel_functions.on' : 'channel_functions.off'));
  this._setCfnBadge('music', ch.music_enabled !== 0, t(ch.music_enabled !== 0 ? 'channel_functions.on' : 'channel_functions.off'));
  this._setCfnBadge('media', ch.media_enabled !== 0, t(ch.media_enabled !== 0 ? 'channel_functions.on' : 'channel_functions.off'));
  this._setCfnBadge('soundboard', ch.soundboard_enabled !== 0, t(ch.soundboard_enabled !== 0 ? 'channel_functions.on' : 'channel_functions.off'));
  this._setCfnBadge('reactions', ch.reactions_enabled !== 0, t(ch.reactions_enabled !== 0 ? 'channel_functions.on' : 'channel_functions.off'));
  // Read-only toggle
  const isReadOnly = ch.read_only === 1;
  this._setCfnBadge('read-only', isReadOnly, t(isReadOnly ? 'channel_functions.on' : 'channel_functions.off'));
  const isForum = ch.is_forum === 1;
  this._setCfnBadge('forum', isForum, t(isForum ? 'channel_functions.on' : 'channel_functions.off'));
  const isPrivate = !!ch.is_private;
  {
    const _cfnPanel = document.getElementById('channel-functions-panel'); const nsfwRow = _cfnPanel?.querySelector('.cfn-row[data-fn="nsfw"] .cfn-badge');
    if (nsfwRow) { nsfwRow.textContent = ch.is_nsfw ? t('channel_functions.on') : t('channel_functions.off'); nsfwRow.className = 'cfn-badge ' + (ch.is_nsfw ? 'cfn-on' : 'cfn-off'); }
    const tagsRow = _cfnPanel?.querySelector('.cfn-row[data-fn="forum-tags"]');
    if (tagsRow) { tagsRow.style.display = ch.is_forum ? '' : 'none'; const b = tagsRow.querySelector('.cfn-badge'); if (b) b.textContent = String(this._forumTagsOf ? this._forumTagsOf(ch.code).length : 0); }
    // Votes on posts (#5742): forums only.
    const votesRow = _cfnPanel?.querySelector('.cfn-row[data-fn="forum-votes"]');
    if (votesRow) {
      votesRow.style.display = ch.is_forum ? '' : 'none';
      const on = !!Number(ch.forum_votes);
      const b = votesRow.querySelector('.cfn-badge');
      if (b) { b.textContent = this._forumVotesBadge ? this._forumVotesBadge(ch) : ''; b.className = 'cfn-badge ' + (on ? 'cfn-on' : 'cfn-off'); }
    }
    // Blog mode (#5742): forums only.
    const blogRow = _cfnPanel?.querySelector('.cfn-row[data-fn="forum-blog"]');
    if (blogRow) blogRow.style.display = ch.is_forum ? '' : 'none';
    const blogOn = Number(ch.forum_blog) === 1;
    this._setCfnBadge('forum-blog', blogOn, t(blogOn ? 'channel_functions.on' : 'channel_functions.off'));
  }
  this._setCfnBadge('private', isPrivate, t(isPrivate ? 'channel_functions.on' : 'channel_functions.off'));
  const gateBadge = this._roleGateBadge(ch);
  this._setCfnBadge('role-gate', gateBadge.on, gateBadge.text);
  // Saving a template writes a server setting, so only manage_server holders see the row.
  const tplRow = document.querySelector('.cfn-row[data-fn="save-template"]');
  if (tplRow) tplRow.style.display = (!ch.is_dm && this._canSaveChannelTemplates()) ? '' : 'none';
  const interval = ch.slow_mode_interval || 0;
  this._setCfnBadge('slow-mode', interval > 0, interval > 0 ? `${interval}s` : t('channel_functions.off'));
  // (#5467) Cleanup protection and welcome messages are still admin-only on
  // the server. Now that the panel opens for manage_channel_settings holders
  // too, hide the rows they can't act on instead of letting the click bounce
  // back as a permission error.
  const isAdmin = !!this.user?.isAdmin;
  const cleanupRow = document.querySelector('.cfn-row[data-fn="cleanup-exempt"]');
  if (cleanupRow) cleanupRow.style.display = isAdmin ? '' : 'none';
  this._setCfnBadge('cleanup-exempt', ch.cleanup_exempt === 1, t(ch.cleanup_exempt === 1 ? 'channel_functions.on' : 'channel_functions.off'));
  // Welcome messages: text channels only, hide the row for DMs.
  const welcomeRow = document.querySelector('.cfn-row[data-fn="welcome"]');
  if (welcomeRow) welcomeRow.style.display = (ch.is_dm || !isAdmin) ? 'none' : '';
  this._setCfnBadge('welcome', ch.show_welcome === 1, t(ch.show_welcome === 1 ? 'channel_functions.on' : 'channel_functions.off'));
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
  this._setCfnBadge('voice-bitrate', bitrate > 0, bitrate > 0 ? bitrate + ' kbps' : t('channel_functions.voice_bitrate_auto'));
  // Voice bitrate greyed when voice is disabled
  const bitrateRow = document.querySelector('.cfn-row[data-fn="voice-bitrate"]');
  if (bitrateRow) bitrateRow.classList.toggle('cfn-disabled', voiceOff);
  // Announcement channel
  const isAnnouncement = ch.notification_type === 'announcement';
  this._setCfnBadge('announcement', isAnnouncement, t(isAnnouncement ? 'channel_functions.on' : 'channel_functions.off'));
  // (#5389) Default role badge: show role name when set, else "None".
  // Hide for DMs since DMs have no role concept.
  // (#5467) Setting a channel's default role hands out a role, so the server
  // gates it on manage_roles, so hide the row for anyone who lacks that.
  const canSetDefaultRole = isAdmin || this._hasPerm('manage_roles');
  const defaultRoleRow = document.querySelector('.cfn-row[data-fn="default-role"]');
  if (defaultRoleRow) {
    defaultRoleRow.style.display = (ch.is_dm || !canSetDefaultRole) ? 'none' : '';
    if (!ch.is_dm) {
      const drId = ch.default_role_id || null;
      const role = drId && Array.isArray(this._allRoles)
        ? this._allRoles.find(r => r.id === drId) : null;
      this._setCfnBadge('default-role', !!drId, role ? role.name : (drId ? `#${drId}` : 'None'));
    }
  }
  // Self Destruct timer
  const hasExpiry = !!ch.expires_at;
  if (hasExpiry) {
    const hoursLeft = Math.max(1, Math.round((new Date(ch.expires_at) - Date.now()) / 3600000));
    // #5390: distinguish 'clear messages' mode from full channel deletion
    // so admins can tell at a glance what the timer will do. The ↻ glyph
    // hints that the clear timer rearms itself.
    const isClear = ch.auto_delete_mode === 'clear';
    this._setCfnBadge('self-destruct', true, isClear ? `${hoursLeft}h ↻` : `${hoursLeft}h`);
  } else {
    this._setCfnBadge('self-destruct', false, t('channel_functions.off'));
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
      this._setCfnBadge('afk-sub', false, t('channel_functions.off'));
    }
    this._setCfnBadge('afk-timeout', afkTimeout > 0, afkTimeout > 0 ? `${afkTimeout}m` : t('channel_functions.off'));
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

  // Mark everything as read, from either menu (#5683). The counts are zeroed
  // here for every channel the client knows about, shown or not, and the
  // server moves each read position so they do not come back on reconnect.
  document.querySelectorAll('[data-action="mark-all-read"]').forEach(btn => {
    btn.addEventListener('click', () => {
      this._closeChannelCtxMenu?.();
      this._closeDmCtxMenu?.();
      this.socket.emit('mark-all-read', {}, (res) => {
        if (!res || res.error) return this._showToast(res?.error || t('context_menu.channel.mark_all_read_failed'), 'error');
        const codes = new Set([...Object.keys(this.unreadCounts || {}), ...(this.channels || []).map(c => c.code)]);
        codes.forEach(code => { this.unreadCounts[code] = 0; });
        (this.channels || []).forEach(c => { c.unreadCount = 0; });
        this._renderChannels();
        this._updateTabTitle();
        this._updateDesktopBadge();
        this._showToast(t('context_menu.channel.mark_all_read_done'), 'success');
      });
    });
  });

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
    const willBeMuted = idx < 0;
    if (idx >= 0) { muted.splice(idx, 1); this._showToast(t('channels.dm_unmuted'), 'success'); }
    else { muted.push(code); this._showToast(t('channels.dm_muted'), 'success'); }
    localStorage.setItem('haven_muted_channels', JSON.stringify(muted));
    this._syncChannelMutePref(code, willBeMuted);
  });

  document.querySelector('[data-action="dm-group-add"]')?.addEventListener('click', () => { const code = this._dmCtxMenuCode; this._closeDmCtxMenu(); if (code) this._openGroupPicker({ code }); });
  document.querySelector('[data-action="dm-group-leave"]')?.addEventListener('click', () => { const code = this._dmCtxMenuCode; this._closeDmCtxMenu(); if (code) this._leaveGroup(code); });
  document.querySelector('[data-action="dm-group-delete"]')?.addEventListener('click', () => { const code = this._dmCtxMenuCode; this._closeDmCtxMenu(); if (code) this._deleteGroup(code); });
  document.querySelector('[data-action="dm-group-delete-all"]')?.addEventListener('click', () => { const code = this._dmCtxMenuCode; this._closeDmCtxMenu(); if (code) this._deleteGroupForEveryone(code); });
  // Delete DM
  document.querySelector('[data-action="dm-delete"]')?.addEventListener('click', async () => {
    const code = this._dmCtxMenuCode;
    if (!code) return;
    this._closeDmCtxMenu();
    const ok = await this._showConfirmModal('⚠️ ' + t('channels.dm_delete_confirm'), '', { danger: true, confirmLabel: t('msg_toolbar.delete') });
    if (!ok) return;
    const attachments = await this._collectDmAttachments(code);
    this.socket.emit('delete-dm', { code, attachments });
  });

  // Close on outside click
  document.addEventListener('click', (e) => {
    if (this._dmCtxMenuEl && !this._dmCtxMenuEl.contains(e.target) && !e.target.closest('.dm-more-btn')) {
      this._closeDmCtxMenu();
    }
  });
},

/**
 * Every attachment URL in a DM, decrypted, for the server to move aside when
 * the DM is deleted, or when the last member leaves a group DM.
 */
async _collectDmAttachments(code) {
  // Gather all attachment URLs from the (decrypted) cached messages
  // for this DM so the server can move E2E ciphertext-hidden uploads
  // to deleted-attachments. (#5299)
  const attachments = [];
  const _scanMsgsForAttachments = (msgs) => {
    const re = /\/uploads\/((?!deleted-attachments)[\w\-.]+)/g;
    for (const msg of msgs) {
      if (!msg || typeof msg.content !== 'string') continue;
      let m;
      while ((m = re.exec(msg.content)) !== null) attachments.push('/uploads/' + m[1]);
    }
  };
  // Paginate through ALL messages in the DM so we don't miss E2E
  // attachment URLs in older messages that haven't been rendered yet. (#5299)
  try {
    const channel = this.channels?.find(c => c.code === code);
    if (channel?.is_dm && channel.dm_target) {
      await this._fetchDMPartnerKey(channel);
    }
    const PAGE_LIMIT = 100;
    let before = null;
    for (;;) {
      const page = await new Promise((resolve) => {
        const timer = setTimeout(() => {
          this.socket.off('message-history', onHistory);
          resolve([]);
        }, 5000);
        const onHistory = (data) => {
          if (!data || data.channelCode !== code) return;
          this.socket.off('message-history', onHistory);
          clearTimeout(timer);
          resolve(Array.isArray(data.messages) ? data.messages : []);
        };
        this.socket.on('message-history', onHistory);
        this.socket.emit('get-messages', { code, before, limit: PAGE_LIMIT });
      });
      if (page.length === 0) break;
      try { await this._decryptMessages(page, code); } catch (err) { console.warn('[DM] could not decrypt a page while collecting attachments to delete', err); }
      _scanMsgsForAttachments(page);
      if (page.length < PAGE_LIMIT) break;
      // Messages arrive in DESC order; the last item is the oldest, so it is the cursor.
      before = page[page.length - 1].id;
    }
  } catch { /* best-effort: the server still cleans up plaintext messages */ }
  return attachments;
},

_openDmCtxMenu(code, anchorEl, mouseEvent) {
  // One menu at a time, as for channels (#5744).
  this._closeChannelCtxMenu?.();
  this._dmCtxMenuCode = code;
  const menu = this._dmCtxMenuEl;
  if (!menu) return;

  // Update mute label
  const muted = JSON.parse(localStorage.getItem('haven_muted_channels') || '[]');
  const muteBtn = menu.querySelector('[data-action="dm-mute"]');
  if (muteBtn) muteBtn.textContent = muted.includes(code) ? `🔕 ${t('channels.unmute_dm')}` : `🔔 ${t('channels.mute_dm')}`;

  const isGroup = !!this.channels.find(c => c.code === code)?.is_group;
  menu.querySelectorAll('[data-action="dm-group-add"], [data-action="dm-group-leave"]').forEach(b => { b.style.display = isGroup ? '' : 'none'; });
  const delBtn = menu.querySelector('[data-action="dm-delete"]');
  if (delBtn) delBtn.style.display = isGroup ? 'none' : '';
  // Delete group shows only to the last member left, checked against the
  // server's current member list rather than the one this app last saw.
  const groupDelBtn = menu.querySelector('[data-action="dm-group-delete"]');
  if (groupDelBtn) {
    groupDelBtn.style.display = 'none';
    if (isGroup) {
      this._groupIsMineAlone(code).then(alone => {
        if (alone && this._dmCtxMenuCode === code) groupDelBtn.style.display = '';
      });
    }
  }
  // Only the server admin can delete a group for everyone in it (#5740).
  const groupDelAllBtn = menu.querySelector('[data-action="dm-group-delete-all"]');
  if (groupDelAllBtn) groupDelAllBtn.style.display = isGroup && this.user?.isAdmin ? '' : 'none';
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

};
