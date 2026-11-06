// People: profile pop-ups (click, hover, right-click), renaming yourself,
// personas, and user groups with the channels they open.

export default {

// The profile picture size limit the admin set (1 to 10 MB, 2 by default).
_avatarMaxMb() {
  const n = parseInt(this.serverSettings?.max_avatar_mb, 10);
  return n >= 1 && n <= 10 ? n : 2;
},

// Your own picture in the account bar at the top of the sidebar, in your
// chosen shape, or your initial on your color when you have none.
_renderUserBarAvatar() {
  const face = document.getElementById('user-bar-face');
  if (!face || !this.user || !this.user.username) return;
  face.className = 'user-bar-face avatar-' + (this.user.avatarShape || 'circle');
  const initial = this.user.username.charAt(0).toUpperCase();
  const color = this._getUserColor(this.user.username);
  const showInitial = () => {
    face.textContent = initial;
    face.style.backgroundColor = color;
  };
  if (!this.user.avatar) { showInitial(); return; }
  face.style.backgroundColor = '';
  face.innerHTML = `<img ${this._imgSrcAttr(this.user.avatar)}${this._animAttr(this.user.animateProfile)} alt="">`;
  const img = face.querySelector('img');
  img.addEventListener('error', showInitial, { once: true });
  this._freezePfpImg(img);
},

_bindPeople() {
  // Rename username
  document.getElementById('rename-btn').addEventListener('click', () => {
    this._openRenameModal();
  });
  // Your picture in the account bar opens the same window, and plays an
  // animated picture while hovered, like avatars in chat.
  const barAvatar = document.getElementById('user-bar-avatar');
  if (barAvatar) {
    barAvatar.addEventListener('click', () => this._openRenameModal());
    barAvatar.addEventListener('mouseenter', () => this._setPfpAnimation(barAvatar, true));
    barAvatar.addEventListener('mouseleave', () => this._setPfpAnimation(barAvatar, false));
  }

  // A name or avatar in the thread panel: a reply's, or the starter's in the
  // header. Webhook and imported replies have no account, so no card.
  const threadCardTrigger = (e) => {
    if (e.target.closest('.thread-msg-toolbar')) return null;
    const head = e.target.closest('#thread-parent-avatar-wrap, #thread-parent-name');
    if (head) return head.dataset.userId ? { el: head, userId: parseInt(head.dataset.userId, 10) } : null;
    const el = e.target.closest('.thread-msg-author, .thread-msg-avatar:not(.thread-msg-compact-spacer)');
    const msgEl = el && el.closest('.thread-message');
    if (!msgEl || !msgEl.dataset.userId) return null;
    return { el, userId: parseInt(msgEl.dataset.userId, 10) };
  };

  // ── Profile popup: click on message author name or avatar ──
  document.getElementById('messages').addEventListener('click', (e) => {
    const author = e.target.closest('.message-author');
    const avatar = e.target.closest('.message-avatar, .message-avatar-img');
    if (!author && !avatar) return;
    // Don't trigger if clicking toolbar buttons
    if (e.target.closest('.msg-toolbar')) return;
    const msgEl = e.target.closest('.message, .message-compact');
    if (!msgEl) return;
    const userId = parseInt(msgEl.dataset.userId);
    if (!isNaN(userId)) {
      clearTimeout(this._hoverProfileTimer);
      clearTimeout(this._hoverCloseTimer);
      clearTimeout(this._hoverAutoCloseTimer);
      clearTimeout(this._hoverFadeTimeout);
      const existingPopup = document.getElementById('profile-popup');
      // A hover preview is already up: promote it to the full card in place
      // instead of re-fetching.
      if (existingPopup && this._isHoverPopup) {
        this._promoteHoverPopup(existingPopup);
        return;
      }
      // Toggle: clicking the same user whose card is open closes it.
      if (this._openProfileUserId === userId && existingPopup) {
        this._closeProfilePopup();
        return;
      }
      this._isHoverPopup = false;
      this._hoverTarget = null;
      this._profilePopupAnchor = e.target;
      this.socket.emit('get-user-profile', { userId });
    }
  });

  // ── Profile popup: click on a name or avatar in an open thread ──
  document.getElementById('thread-panel')?.addEventListener('click', (e) => {
    const trigger = threadCardTrigger(e);
    if (!trigger || isNaN(trigger.userId)) return;
    clearTimeout(this._hoverProfileTimer);
    clearTimeout(this._hoverCloseTimer);
    clearTimeout(this._hoverAutoCloseTimer);
    clearTimeout(this._hoverFadeTimeout);
    const existingPopup = document.getElementById('profile-popup');
    if (existingPopup && this._isHoverPopup) {
      this._promoteHoverPopup(existingPopup);
      return;
    }
    if (this._openProfileUserId === trigger.userId && existingPopup) {
      this._closeProfilePopup();
      return;
    }
    this._isHoverPopup = false;
    this._hoverTarget = null;
    this._profilePopupAnchor = trigger.el;
    this.socket.emit('get-user-profile', { userId: trigger.userId });
  });

  // ── Profile popup: click on user item in sidebar ──
  document.getElementById('online-users').addEventListener('click', (e) => {
    // Don't trigger for action buttons (DM, kick, etc.)
    if (e.target.closest('.user-action-btn') || e.target.closest('.user-admin-actions')) return;
    const userItem = e.target.closest('.user-item');
    if (!userItem) return;
    const userId = parseInt(userItem.dataset.userId);
    if (!isNaN(userId)) {
      clearTimeout(this._hoverProfileTimer);
      clearTimeout(this._hoverCloseTimer);
      clearTimeout(this._hoverAutoCloseTimer);
      clearTimeout(this._hoverFadeTimeout);
      const existingPopup = document.getElementById('profile-popup');
      // A hover preview is already up: promote it to the full card in place
      // instead of re-fetching.
      if (existingPopup && this._isHoverPopup) {
        this._promoteHoverPopup(existingPopup);
        return;
      }
      // Toggle: clicking the same user whose card is open closes it.
      if (this._openProfileUserId === userId && existingPopup) {
        this._closeProfilePopup();
        return;
      }
      this._isHoverPopup = false;
      this._hoverTarget = null;
      this._profilePopupAnchor = userItem;
      this.socket.emit('get-user-profile', { userId });
    }
  });

  // Double-click a user in the right sidebar to open a DM
  document.getElementById('online-users').addEventListener('dblclick', (e) => {
    if (e.target.closest('.user-action-btn') || e.target.closest('.user-admin-actions')) return;
    const userItem = e.target.closest('.user-item');
    if (!userItem) return;
    const userId = parseInt(userItem.dataset.userId);
    if (isNaN(userId) || userId === this.user.id) return;
    this.socket.emit('start-dm', { targetUserId: userId });
  });

  // ── Right-click user → Invite to channel ──
  document.getElementById('online-users').addEventListener('contextmenu', (e) => {
    const userItem = e.target.closest('.user-item');
    if (!userItem) return;
    const userId = parseInt(userItem.dataset.userId);
    if (isNaN(userId) || (userId === this.user.id && !this.user.isAdmin)) return;
    e.preventDefault();
    this._showUserContextMenu(e, userId);
  });

  // ── Profile popup: hover-over on usernames/avatars (translucent preview) ──
  // The off switch is Settings → Chat → "Show profile card on hover". It is
  // read live so flipping it takes effect without a reload.
  const hoverCardEnabled = () => localStorage.getItem('haven_hover_profile_card') !== 'false';
  const setupHoverProfile = (container, getInfo) => {
    container.addEventListener('mouseover', (e) => {
      if (!hoverCardEnabled()) return;
      const trigger = getInfo(e);
      if (!trigger) {
        // Mouse moved to a non-trigger element: cancel any pending hover
        clearTimeout(this._hoverProfileTimer);
        this._hoverTarget = null;
        // Close hover popup instantly
        if (this._isHoverPopup) {
          clearTimeout(this._hoverCloseTimer);
          clearTimeout(this._hoverAutoCloseTimer);
          clearTimeout(this._hoverFadeTimeout);
          this._closeProfilePopup();
        }
        return;
      }
      if (trigger.el === this._hoverTarget) return;
      // Switching to a different trigger: close the old hover popup instantly
      if (this._isHoverPopup) {
        clearTimeout(this._hoverFadeTimeout);
        this._closeProfilePopup();
      }
      clearTimeout(this._hoverProfileTimer);
      clearTimeout(this._hoverCloseTimer);
      clearTimeout(this._hoverAutoCloseTimer);
      this._hoverTarget = trigger.el;

      // Don't show a hover popup while a click-based card is open
      if (document.getElementById('profile-popup') && !this._isHoverPopup) return;

      this._hoverProfileTimer = setTimeout(() => {
        // Verify the mouse is still over this trigger element
        if (this._hoverTarget !== trigger.el) return;
        if (!isNaN(trigger.userId)) {
          this._profilePopupAnchor = trigger.el;
          this._isHoverPopup = true;
          this.socket.emit('get-user-profile', { userId: trigger.userId });
        }
      }, 350);
    });

    container.addEventListener('mouseleave', () => {
      clearTimeout(this._hoverProfileTimer);
      clearTimeout(this._hoverAutoCloseTimer);
      clearTimeout(this._hoverFadeTimeout);
      this._hoverTarget = null;
      // Close hover popup instantly on leaving the container
      if (this._isHoverPopup) {
        this._closeProfilePopup();
      }
    });
  };

  setupHoverProfile(document.getElementById('messages'), (e) => {
    const author = e.target.closest('.message-author');
    const avatar = e.target.closest('.message-avatar, .message-avatar-img');
    if (!author && !avatar) return null;
    if (e.target.closest('.msg-toolbar')) return null;
    const msgEl = (author || avatar).closest('.message, .message-compact');
    if (!msgEl) return null;
    return { el: author || avatar, userId: parseInt(msgEl.dataset.userId) };
  });

  const threadPanel = document.getElementById('thread-panel');
  if (threadPanel) setupHoverProfile(threadPanel, threadCardTrigger);

  setupHoverProfile(document.getElementById('online-users'), (e) => {
    if (e.target.closest('.user-action-btn') || e.target.closest('.user-admin-actions')) return null;
    const userItem = e.target.closest('.user-item');
    if (!userItem) return null;
    return { el: userItem, userId: parseInt(userItem.dataset.userId) };
  });

  // Leaving Edit Profile without saving (Cancel, clicking outside, ✕, Escape)
  // discards a picked or cleared avatar, so a later Save can't upload it.
  document.getElementById('cancel-rename-btn').addEventListener('click', () => {
    document.getElementById('rename-modal').style.display = 'none';
    this._discardPendingAvatar();
  });
  document.getElementById('rename-modal').addEventListener('modal-dismiss', () => this._discardPendingAvatar());

  document.getElementById('save-rename-btn').addEventListener('click', () => this._saveRename());

  // Add persona button (#86, #5349)
  const addPersonaBtn = document.getElementById('add-persona-btn');
  if (addPersonaBtn) addPersonaBtn.addEventListener('click', () => this._showPersonaEditor?.(null));

  document.getElementById('rename-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') this._saveRename();
  });

  document.getElementById('rename-modal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) {
      e.currentTarget.style.display = 'none';
      this._discardPendingAvatar();
    }
  });

  // manage groups buttons
  const manageGroupsBtn = document.getElementById('manage-groups-btn');
  if (manageGroupsBtn) manageGroupsBtn.addEventListener('click', () => this._showGroupManager());

  const saveGroupsBtn = document.getElementById('save-groups-btn');
  if (saveGroupsBtn) saveGroupsBtn.addEventListener('click', () => {
    this._GroupManagerSaveGroups();
  });
},

_openRenameModal() {
  document.getElementById('rename-modal').style.display = 'flex';
  const input = document.getElementById('rename-input');
  input.value = this.user.displayName || this.user.username;
  input.focus();
  input.select();
  // Populate bio
  const bioInput = document.getElementById('edit-profile-bio');
  if (bioInput) bioInput.value = this.user.bio || '';
  this._bioOpened = bioInput ? bioInput.value : null;
  this._syncBirthdayEditor();
  // Load personas list (#86, #5349)
  this._loadPersonas?.();
  this._loadRoles(() => this._renderUserProfileGroupsList());
  this._updateAvatarPreview();
  this._resetAvatarEditState();
  this._resetBorderEditState();
  // Sync shape picker buttons
  const picker = document.getElementById('avatar-shape-picker');
  if (picker) {
    const currentShape = this.user.avatarShape || localStorage.getItem('haven_avatar_shape') || 'circle';
    picker.querySelectorAll('.avatar-shape-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.shape === currentShape);
    });
    this._pendingAvatarShape = currentShape;
  }
  this._applyAvatarPreviewShape?.();
},

_saveRename() {
  const input = document.getElementById('rename-input');
  // Mirrors normalizeDisplayName on the server (#5509) so a name in any
  // script gets an instant answer here rather than a bare error-msg back.
  const newName = input.value.normalize('NFC').trim().replace(/\s+/g, ' ');
  if (!newName || [...newName].length < 2) {
    return this._showToast(t('toasts.display_name_too_short'), 'error');
  }
  if (!/^[\p{L}\p{N}\p{M}_ ]+$/u.test(newName)) {
    return this._showToast(t('toasts.display_name_invalid_chars'), 'error');
  }
  if (/\p{M}{4,}/u.test(newName)) {
    return this._showToast(t('toasts.display_name_too_many_marks'), 'error');
  }
  // Only an actual change goes to the server; a bio or avatar save with the
  // name left alone used to announce a rename to the whole channel.
  if (newName !== (this.user.displayName || this.user.username)) {
    this.socket.emit('rename-user', { username: newName });
  }
  // Save bio, only when it was changed here: a save that is about the name
  // or the avatar leaves the bio as the server has it.
  const bioInput = document.getElementById('edit-profile-bio');
  if (bioInput && bioInput.value !== this._bioOpened) {
    this.socket.emit('set-bio', { bio: bioInput.value });
  }
  // Only an actual birthday change goes out. The date goes once, the first
  // time; after that only the two toggles can change (the server holds it).
  const birthday = this.user.birthday ? null : (document.getElementById('edit-profile-birthday').value || null);
  const hidden = document.getElementById('edit-profile-birthday-hidden').checked;
  const hideYear = document.getElementById('edit-profile-birthday-hide-year').checked;
  if (birthday || hidden !== (this.user.birthdayHidden === true) || hideYear !== (this.user.birthdayHideYear !== false)) {
    this.socket.emit('set-birthday', birthday ? { birthday, hidden, hideYear } : { hidden, hideYear });
  }
  // Also commit any pending avatar and groups changes
  this._commitAvatarSettings();
  this._GroupManagerSaveGroups();
  document.getElementById('rename-modal').style.display = 'none';
},

// A birthday is set once and never changed, so the date field locks for good
// once there is one. Hiding it keeps the date and takes it off the profile.
_syncBirthdayEditor() {
  const input = document.getElementById('edit-profile-birthday');
  const note = document.getElementById('edit-profile-birthday-note');
  const isSet = !!this.user.birthday;
  const now = this._nowZonedParts();
  input.max = `${now.year}-${String(now.monthIndex + 1).padStart(2, '0')}-${String(now.day).padStart(2, '0')}`;
  input.value = this.user.birthday || '';
  input.disabled = isSet;
  document.getElementById('edit-profile-birthday-hidden').checked = this.user.birthdayHidden === true;
  document.getElementById('edit-profile-birthday-hide-year').checked = this.user.birthdayHideYear !== false;
  note.textContent = t(isSet ? 'modals.edit_profile.birthday_set_note' : 'modals.edit_profile.birthday_hint');
},

_loadGroupChannelAccess(roleIds, callback) {
  this._roleEmit('get-role-channel-access', { roleIds }, (res) => {
    if (!res || res.error) return callback?.({});

    const channelMap = new Map((res.channels || []).map(ch => [ch.id, ch]));
    const accessMap = {};
    (res.access || []).forEach(a => {
      if (!a.grant_on_promote) return;

      const channel = channelMap.get(a.channel_id);
      if (!channel) return;
      if (!accessMap[a.role_id]) accessMap[a.role_id] = [];

      accessMap[a.role_id].push(channel);
    });
    callback?.(accessMap);
  });
},

// user Groups
_renderUserProfileGroupsList() {
  const section = document.getElementById('rename-modal-groups-section');
  const list = document.getElementById('user-profile-groups-list');
  const manager = document.getElementById('user-profile-groups-manager');
  const managerSaveBtn = document.getElementById('save-groups-btn');
  const manageGroupsBtn = document.getElementById('manage-groups-btn');
  if (!section || !list || !manager || !managerSaveBtn || !manageGroupsBtn) return;

  // Hide Groups section if there are no groups available to join.
  const availableGroups = (this._allRoles || []).filter(r => r.level === 0).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  section.style.display = availableGroups.length > 0 ? '' : 'none';

  // Always start from the read-only view. Clearing the manager's checkboxes
  // matters: Save Profile calls _GroupManagerSaveGroups too, and stale
  // checkboxes from an earlier visit would otherwise be replayed as the
  // user's current choice.
  manager.style.display = 'none';
  manager.innerHTML = '';
  managerSaveBtn.style.display = 'none';

  if (availableGroups.length > 0) {
    // Make Sure non manager parts are visible:
    manageGroupsBtn.style.display = '';
    list.style.display = '';

    const groups = (this.user?.roles || []).filter(r => r.level === 0).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    const esc = (s) => this._escapeHtml ? this._escapeHtml(s) : String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    if (groups.length === 0) {
      // display tip when user is not a part of any groups
      list.innerHTML = `<p class="muted-text" style="font-size:.78rem;margin:6px 0">${t('modals.edit_profile.no_groups')}</p>`;
    }
    else {
      // render list of user's current groups
      list.innerHTML = groups.map(r => {
        const rIcon = r.icon ? `<img class="role-icon" src="${esc(r.icon)}" alt="">` : `<span class="profile-role-dot" style="background:${this._roleFill(r, 'var(--text-muted)')}"></span>`;
          return `<span class="profile-popup-role" style="border-color:${this._safeColor(r.color, 'var(--border-light)')}; color:${this._safeColor(r.color, 'var(--text-secondary)')}">${rIcon}${this._roleNameHtml(r, r.name)}</span>`;
      }).join('');
    }
  }
},

_showGroupManager() {
  const list = document.getElementById('user-profile-groups-list');
  const manager = document.getElementById('user-profile-groups-manager');
  const managerSaveBtn = document.getElementById('save-groups-btn');
  const manageGroupsBtn = document.getElementById('manage-groups-btn');
  if (!list || !manager || !managerSaveBtn || !manageGroupsBtn) return;

  const availableGroups = (this._allRoles || []).filter(r => r.level === 0).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  const groups = (this.user?.roles || []).filter(r => r.level === 0).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  const esc = (s) => this._escapeHtml ? this._escapeHtml(s) : String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  list.style.display = 'none';
  manageGroupsBtn.style.display = 'none';

  manager.style.display = '';
  managerSaveBtn.style.display = '';

  // render html list of selectable groups for the user groups-manager
  const userGroupIds = new Set(groups.map(g => g.id));
  manager.innerHTML = availableGroups.map(r => {
    const isMember = userGroupIds.has(r.id);
    const rIcon = r.icon ? `<img class="role-icon" src="${esc(r.icon)}" alt="">` : `<span class="profile-role-dot" style="background:${this._roleFill(r, 'var(--text-muted)')}"></span>`;

    return `
      <label class="toggle-row user-group-toggle-row">
        <span class="user-group-name">
          <button class="user-group-channel-info" data-role="${r.id}" style="visibility:hidden" title="">#i</button>
          <span class="profile-popup-role" style="border-color:${this._safeColor(r.color, 'var(--border-light)')}; color:${this._safeColor(r.color, 'var(--text-secondary)')}">${rIcon}${this._roleNameHtml(r, r.name)}</span>
        </span>
        <input type="checkbox" class="user-group-checkbox" data-role="${r.id}"${isMember ? ' checked' : ''}>
      </label>
    `;
  }).join('');

  // Load channel access for all groups and show info icons
  this._loadGroupChannelAccess(
    availableGroups.map(r => r.id),
    (accessMap) => {
      availableGroups.forEach(r => {
        const channels = accessMap[r.id] || [];
        if (!channels.length) return;

        const info = manager.querySelector(`.user-group-channel-info[data-role="${r.id}"]`);
        if (!info) return;

        info.dataset.channels = JSON.stringify(channels);
        info.style.visibility = 'visible';

        info.addEventListener('mouseenter', () => {
          // Don't show a hover tooltip while the persistent popup is open.
          if (this._groupChannelInfoPopup) return;

          this._showGroupChannelInfo(info, false);
        });

        info.addEventListener('mouseleave', () => {
          // Persistent popup is intentionally unaffected.
          if (!this._groupChannelInfoPopup) {
            this._closeGroupChannelInfo();
          }
        });

        info.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();

          this._showGroupChannelInfo(info, true);
        });
      });
    }
  );
},

_GroupManagerSaveGroups() {
  // Only send a selection while the group manager is open. Save Profile calls
  // this unconditionally, and with the manager closed there are no checkboxes
  // in the DOM, so an empty list would go out and the server would read it as
  // "leave every group".
  const manager = document.getElementById('user-profile-groups-manager');
  if (!manager || manager.style.display === 'none') return;
  const selectedGroupIds = Array.from(manager.querySelectorAll('.user-group-checkbox:checked')).map(el => parseInt(el.dataset.role, 10)).filter(Number.isInteger);
  this._roleEmit('update-groups', {groupIds: selectedGroupIds}, (res) => {
    if (res.error) {
      return this._showToast(res.error, 'error');
    }

    // Update local user roles with the groups returned by the server.
    if (Array.isArray(res.groups)) {
      this.user.roles = [
        ...(this.user.roles || []).filter(r => r.level !== 0),
        ...res.groups
      ];
    }

    this._showToast(t('modals.edit_profile.groups_saved'), 'success');
    this._renderUserProfileGroupsList();
  });
},

_showGroupChannelInfo(info, persistent = false) {
  const channels = JSON.parse(info.dataset.channels || '[]');
  if (!channels.length) return;

  // Remove any existing group-channel popup.
  this._closeGroupChannelInfo();

  const popup = document.createElement('div');
  popup.className = `group-channel-info-popup${persistent ? ' persistent' : ''}`;

  const channelMap = new Map(channels.map(ch => [ch.id, ch]));
  const children = new Map();

  // Only display subchannels when their parent is also granted
  // by this group.
  const visibleChannels = channels.filter(ch => {
    if (!ch.parent_channel_id) return true;
    return channelMap.has(ch.parent_channel_id);
  });

  // Build hierarchy from the channels we're actually displaying.
  visibleChannels.forEach(ch => {
    if (ch.parent_channel_id && channelMap.has(ch.parent_channel_id)) {
      if (!children.has(ch.parent_channel_id)) {
        children.set(ch.parent_channel_id, []);
      }
      children.get(ch.parent_channel_id).push(ch);
    }
  });

  const visibleIds = new Set(visibleChannels.map(ch => ch.id));

  const roots = visibleChannels.filter(ch =>
    !ch.parent_channel_id ||
    !visibleIds.has(ch.parent_channel_id)
  );

  const renderChannel = (ch, isChild = false) => {
    const prefix = isChild ? '↳ ' : '# ';
    const lock = ch.is_private ? ' 🔒' : '';

    return `
      <div class="group-channel-info-row${isChild ? ' sub' : ''}">
        ${prefix}${this._escapeHtml(ch.name)}${lock}
      </div>
      ${(children.get(ch.id) || [])
        .sort((a, b) =>
          a.position - b.position ||
          a.name.localeCompare(b.name)
        )
        .map(child => renderChannel(child, true))
        .join('')}
    `;
  };

  popup.innerHTML = `
    <div class="group-channel-info-title">
      <span>${this._escapeHtml(t('modals.edit_profile.group_channels_granted'))}</span>
      ${persistent
        ? `<button type="button" class="group-channel-info-close" title="Close">&times;</button>`
        : ''}
    </div>
    <div class="group-channel-info-list">
      ${roots
        .sort((a, b) =>
          a.position - b.position ||
          a.name.localeCompare(b.name)
        )
        .map(ch => renderChannel(ch))
        .join('')}
    </div>
  `;

  document.body.appendChild(popup);

  const rect = info.getBoundingClientRect();
  const popupRect = popup.getBoundingClientRect();
  const margin = 8;
  const gap = 6;

  let left = rect.left;
  let top = rect.bottom + gap;

  // Keep popup within the horizontal viewport.
  if (left + popupRect.width > window.innerWidth - margin) {
    left = window.innerWidth - popupRect.width - margin;
  }
  left = Math.max(margin, left);

  // Prefer below; move above if necessary.
  if (top + popupRect.height > window.innerHeight - margin) {
    const aboveTop = rect.top - popupRect.height - gap;
    top = (aboveTop >= margin) ? aboveTop : margin;
  }

  top = Math.max(margin, top);
  const availableHeight = window.innerHeight - top - margin;
  const channelList = popup.querySelector('.group-channel-info-list');
  if (channelList) {
    channelList.style.maxHeight =
      `${Math.max(4 * 16, availableHeight - 55)}px`;
  }

  popup.style.left = `${left}px`;
  popup.style.top = `${top}px`;

  if (persistent) {
    this._groupChannelInfoPopup = popup;

    const closeBtn = popup.querySelector('.group-channel-info-close');
    closeBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      this._closeGroupChannelInfo();
    });

    this._groupChannelInfoOutsideHandler = (e) => {
      if (!popup.contains(e.target) && e.target !== info) {
        this._closeGroupChannelInfo();
      }
    };

    setTimeout(() => {
      document.addEventListener('click', this._groupChannelInfoOutsideHandler);
    }, 0);
  } else {
    this._groupChannelInfoTooltip = popup;
  }
},

_closeGroupChannelInfo() {
  if (this._groupChannelInfoTooltip) {
    this._groupChannelInfoTooltip.remove();
    this._groupChannelInfoTooltip = null;
  }

  if (this._groupChannelInfoPopup) {
    this._groupChannelInfoPopup.remove();
    this._groupChannelInfoPopup = null;
  }

  if (this._groupChannelInfoOutsideHandler) {
    document.removeEventListener('click', this._groupChannelInfoOutsideHandler);
    this._groupChannelInfoOutsideHandler = null;
  }
},

// ── Personas (#86, #5349) ──────────────────────────────

// Persona prefix autocomplete: when the input STARTS with "::" we suggest
// the user's own personas. Using "::" as a deliberate, unambiguous trigger
// that doesn't conflict with any markdown syntax (">>" would render as a
// nested blockquote if the persona lookup fails). The persona owner can
// type their persona's name normally in chat without accidentally routing
// the message through the persona.
_checkPersonaTrigger(inputEl) {
  // Personas are not supported in DMs, so suppress the dropdown if the current
  // channel is a DM (covers fullscreen DM view which reuses #message-input).
  const _curCh = this.currentChannel && this.channels && this.channels.find(c => c.code === this.currentChannel);
  if (_curCh && _curCh.is_dm) { this._hidePersonaDropdown(); return; }
  const input = inputEl || document.getElementById('message-input');
  if (!input) return;
  this._personaInput = input;
  const text = input.value;
  const m = text.match(/^::\s*([^\s:]{0,32})$/);
  if (m) {
    this._personaTriggerQuery = m[1].toLowerCase();
    // Lazy load personas the first time the user reaches for them
    if (!this._personas && !this._personasLoading) {
      this._personasLoading = true;
      this._loadPersonas?.().finally(() => {
        this._personasLoading = false;
        this._showPersonaDropdown();
      });
    }
    this._showPersonaDropdown();
  } else {
    this._hidePersonaDropdown();
  }
},

_showPersonaDropdown() {
  const dropdown = document.getElementById('persona-dropdown');
  if (!dropdown) return;
  const host = (this._personaInput && this._personaInput.parentElement) || null;
  if (host && dropdown.parentElement !== host) host.appendChild(dropdown);
  const personas = (this._personas || []).slice();
  const q = this._personaTriggerQuery || '';
  const filtered = personas.filter(p => (p.name || '').toLowerCase().startsWith(q)).slice(0, 8);
  if (filtered.length === 0) {
    if (q.length === 0 && personas.length === 0) {
      // No personas yet: point the user at the profile UI
      dropdown.innerHTML = `<div class="mention-item" data-persona-empty="1"><strong>${t('personas.dropdown_none')}</strong> <span class="mention-item-handle">${t('personas.dropdown_create')}</span></div>`;
      dropdown.style.display = 'block';
      dropdown.querySelectorAll('[data-persona-empty]').forEach(el => {
        el.addEventListener('click', () => {
          this._hidePersonaDropdown();
          document.getElementById('rename-btn')?.click();
        });
      });
      return;
    }
    dropdown.style.display = 'none';
    return;
  }
  const esc = (s) => this._escapeHtml(s);
  dropdown.innerHTML = filtered.map((p, i) => {
    const avatar = p.avatar
      ? `<img src="${esc(p.avatar)}" class="persona-dd-avatar" alt="">`
      : `<span class="persona-dd-avatar persona-dd-avatar-fallback">${esc((p.name || '?').charAt(0).toUpperCase())}</span>`;
    return `<div class="mention-item${i === 0 ? ' active' : ''}" data-persona-name="${esc(p.name)}">${avatar}<strong>${esc(p.name)}</strong> <span class="mention-item-handle">${t('personas.dropdown_preview', { name: esc(p.name) })}</span></div>`;
  }).join('');
  dropdown.style.display = 'block';
  dropdown.querySelectorAll('[data-persona-name]').forEach(item => {
    item.addEventListener('click', () => this._insertPersona(item.dataset.personaName));
  });
},

_hidePersonaDropdown() {
  const dropdown = document.getElementById('persona-dropdown');
  if (dropdown) dropdown.style.display = 'none';
  this._personaTriggerQuery = '';
},

_navigatePersonaDropdown(direction) {
  const dropdown = document.getElementById('persona-dropdown');
  if (!dropdown) return;
  const items = dropdown.querySelectorAll('.mention-item');
  if (items.length === 0) return;
  let activeIdx = -1;
  items.forEach((item, i) => { if (item.classList.contains('active')) activeIdx = i; });
  items.forEach(item => item.classList.remove('active'));
  let next = activeIdx + direction;
  if (next < 0) next = items.length - 1;
  if (next >= items.length) next = 0;
  items[next].classList.add('active');
  items[next].scrollIntoView({ block: 'nearest' });
},

_insertPersona(name) {
  const input = this._personaInput || document.getElementById('message-input');
  if (!input) return;
  // Replace any leading ::partial with ::FullName + space, then position
  // cursor after, so the user can immediately type their message body.
  const text = input.value;
  const rest = text.replace(/^::\s*[^\s:]{0,32}/, '');
  input.value = `::${name} ` + rest.replace(/^\s+/, '');
  const caret = ('::' + name + ' ').length;
  input.selectionStart = input.selectionEnd = caret;
  input.focus();
  this._hidePersonaDropdown();
},

async _loadPersonas() {
  try {
    const res = await fetch('/api/personas', {
      headers: { 'Authorization': `Bearer ${this.token}` }
    });
    if (!res.ok) throw new Error(t('personas.load_failed'));
    const data = await res.json();
    this._personas = data.personas || [];
    this._renderPersonasList();
  } catch (err) {
    console.error('Load personas error:', err);
  }
},

_renderPersonasList() {
  const list = document.getElementById('personas-list');
  if (!list) return;
  const personas = this._personas || [];
  const esc = (s) => this._escapeHtml ? this._escapeHtml(s) : String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  if (personas.length === 0) {
    list.innerHTML = `<p class="muted-text" style="font-size:.78rem;margin:6px 0">${t('personas.none')}</p>`;
    return;
  }
  list.innerHTML = personas.map(p => `
    <div class="persona-item" data-persona-id="${p.id}">
      <div class="persona-item-avatar">${p.avatar
          ? `<img src="${esc(p.avatar)}" alt="">`
          : esc((p.name || '?').charAt(0).toUpperCase())}</div>
      <div class="persona-item-info">
        <div class="persona-item-name">${esc(p.name)}</div>
        <div class="persona-item-trigger">${t('personas.trigger_preview', { name: esc(p.name) })}</div>
      </div>
      <div class="persona-item-actions">
        <button class="persona-edit-btn" data-id="${p.id}" title="${t('msg_toolbar.edit')}">✎</button>
        <button class="persona-delete-btn" data-id="${p.id}" title="${t('msg_toolbar.delete')}">🗑</button>
      </div>
    </div>
  `).join('');

  list.querySelectorAll('.persona-edit-btn').forEach(btn => {
    btn.addEventListener('click', () => this._showPersonaEditor(parseInt(btn.dataset.id)));
  });
  list.querySelectorAll('.persona-delete-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = parseInt(btn.dataset.id);
      const persona = (this._personas || []).find(p => p.id === id);
      if (!persona) return;
      if (!await this._confirm(t('personas.delete_confirm', { name: persona.name }), { danger: true })) return;
      try {
        const res = await fetch(`/api/personas/${id}`, {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${this.token}` }
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || t('personas.delete_failed'));
        this._personas = (this._personas || []).filter(p => p.id !== id);
        this._renderPersonasList();
      } catch (err) {
        this._showToast?.(err.message || t('personas.delete_failed'), 'error');
      }
    });
  });
},

_showPersonaEditor(id) {
  const list = document.getElementById('personas-list');
  if (!list) return;
  const existing = id ? (this._personas || []).find(p => p.id === id) : null;
  // If editor already open, close it first
  const existingEditor = list.querySelector('.persona-edit-row');
  if (existingEditor) existingEditor.remove();

  const editor = document.createElement('div');
  editor.className = 'persona-edit-row';
  const esc = (s) => this._escapeHtml ? this._escapeHtml(s) : String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  editor.innerHTML = `
    <div class="persona-edit-controls">
      <div class="persona-item-avatar" id="persona-edit-avatar-preview">${existing && existing.avatar
          ? `<img src="${esc(existing.avatar)}" alt="">`
          : '?'}</div>
      <input type="text" id="persona-edit-name" maxlength="32" placeholder="${t('personas.name_placeholder')}" value="${existing ? esc(existing.name) : ''}">
      <button type="button" class="btn-sm" id="persona-edit-upload">${t('personas.upload_avatar')}</button>
      <input type="file" id="persona-edit-file" accept="image/jpeg,image/png,image/gif,image/webp" style="display:none">
    </div>
    <div class="persona-edit-controls" style="justify-content:flex-end">
      <button type="button" class="btn-sm" id="persona-edit-cancel">${t('modals.common.cancel')}</button>
      <button type="button" class="btn-sm btn-accent" id="persona-edit-save">${t(existing ? 'modals.common.save' : 'personas.create')}</button>
    </div>
  `;
  if (existing) {
    const itemEl = list.querySelector(`.persona-item[data-persona-id="${id}"]`);
    if (itemEl) itemEl.after(editor); else list.prepend(editor);
  } else {
    list.prepend(editor);
  }

  let pendingAvatarUrl = existing ? existing.avatar : null;
  const fileInput = editor.querySelector('#persona-edit-file');
  editor.querySelector('#persona-edit-upload').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const maxMb = this._avatarMaxMb();
    if (file.size > maxMb * 1024 * 1024) {
      this._showToast?.(t('toasts.image_too_large', { max: maxMb }), 'error');
      return;
    }
    const fd = new FormData();
    fd.append('avatar', file);
    try {
      const res = await fetch('/api/upload-persona-avatar', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${this.token}` },
        body: fd,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t('toasts.upload_failed'));
      pendingAvatarUrl = data.url;
      const preview = editor.querySelector('#persona-edit-avatar-preview');
      preview.innerHTML = `<img src="${esc(data.url)}" alt="">`;
    } catch (err) {
      this._showToast?.(err.message || t('toasts.upload_failed'), 'error');
    }
  });

  editor.querySelector('#persona-edit-cancel').addEventListener('click', () => editor.remove());
  editor.querySelector('#persona-edit-name').focus();
  editor.querySelector('#persona-edit-save').addEventListener('click', async () => {
    const name = editor.querySelector('#persona-edit-name').value.trim();
    if (!name) {
      this._showToast?.(t('personas.name_required'), 'error');
      return;
    }
    try {
      const url = existing ? `/api/personas/${existing.id}` : '/api/personas';
      const method = existing ? 'PATCH' : 'POST';
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.token}` },
        body: JSON.stringify({ name, avatar: pendingAvatarUrl })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t('personas.save_failed'));
      // Update local list
      if (existing) {
        const idx = this._personas.findIndex(p => p.id === existing.id);
        if (idx >= 0) this._personas[idx] = data.persona;
      } else {
        this._personas = [...(this._personas || []), data.persona].sort((a, b) =>
          a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
      }
      editor.remove();
      this._renderPersonasList();
    } catch (err) {
      this._showToast?.(err.message || t('personas.save_failed'), 'error');
    }
  });
},

};
