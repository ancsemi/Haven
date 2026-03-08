export default {

// ── Users ─────────────────────────────────────────────

_renderOnlineUsers(users) {
  this._lastOnlineUsers = users;
  const el = document.getElementById('online-users');
  if (users.length === 0) {
    el.innerHTML = '<p class="muted-text">No one here</p>';
    return;
  }

  // Build a score lookup from high scores data
  const scoreLookup = {};
  if (this.highScores.flappy) {
    this.highScores.flappy.forEach(s => { scoreLookup[s.user_id] = s.score; });
  }
  // Also use highScore from server-sent user data
  users.forEach(u => {
    if (u.highScore && u.highScore > (scoreLookup[u.id] || 0)) {
      scoreLookup[u.id] = u.highScore;
    }
  });

  // Sort: online first, then alphabetical
  const sorted = [...users].sort((a, b) => {
    const aOn = a.online !== false;
    const bOn = b.online !== false;
    if (aOn !== bOn) return aOn ? -1 : 1;
    return a.username.toLowerCase().localeCompare(b.username.toLowerCase());
  });

  // Separate into online/offline groups
  const onlineUsers = sorted.filter(u => u.online !== false);
  const offlineUsers = sorted.filter(u => u.online === false);

  let html = '';
  if (onlineUsers.length > 0) {
    html += `<div class="user-group-label">Online — ${onlineUsers.length}</div>`;
    html += onlineUsers.map(u => this._renderUserItem(u, scoreLookup)).join('');
  }
  if (offlineUsers.length > 0) {
    html += `<div class="user-group-label offline-label">Offline — ${offlineUsers.length}</div>`;
    html += offlineUsers.map(u => this._renderUserItem(u, scoreLookup)).join('');
  }
  if (!onlineUsers.length && !offlineUsers.length) {
    html = '<p class="muted-text">No one here</p>';
  }

  el.innerHTML = html;

  // Bind gear button → dropdown menu with mod actions
  if (this.user.isAdmin || this._canModerate() || this._hasPerm('promote_user')) {
    el.querySelectorAll('.user-gear-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const userId = parseInt(btn.dataset.uid);
        const username = btn.dataset.uname;
        this._showUserGearMenu(btn, userId, username);
      });
    });
  }

  // Bind DM buttons
  el.querySelectorAll('.user-dm-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const targetId = parseInt(btn.dataset.dmUid);
      if (isNaN(targetId)) return;
      const targetName = btn.closest('.user-item')?.querySelector('.user-item-name')?.textContent || 'user';
      this._showToast(`Opening DM with ${targetName}…`, 'info');
      btn.disabled = true;
      btn.style.opacity = '0.5';
      this.socket.emit('start-dm', { targetUserId: targetId });
      // Re-enable after a timeout in case no response
      setTimeout(() => { btn.disabled = false; btn.style.opacity = ''; }, 5000);
    });
  });
},

_showUserGearMenu(anchorEl, userId, username) {
  // Close any existing gear menu
  this._closeUserGearMenu();

  const canMod = this.user.isAdmin || this._canModerate();
  const canPromote = this._hasPerm('promote_user');
  const isAdmin = this.user.isAdmin;

  let items = '';
  if (canPromote) items += `<button class="gear-menu-item" data-action="assign-role">👑 Assign Role</button>`;
  if (canMod) items += `<button class="gear-menu-item" data-action="kick">👢 Kick</button>`;
  if (canMod) items += `<button class="gear-menu-item" data-action="mute">🔇 Mute</button>`;
  if (isAdmin) items += `<button class="gear-menu-item gear-menu-danger" data-action="ban">⛔ Ban</button>`;
  if (isAdmin) items += `<button class="gear-menu-item gear-menu-danger" data-action="delete-user">🗑️ Delete User</button>`;
  if (isAdmin) items += `<div class="gear-menu-divider"></div><button class="gear-menu-item gear-menu-danger" data-action="transfer-admin">🔑 Transfer Admin</button>`;

  const menu = document.createElement('div');
  menu.className = 'user-gear-menu';
  menu.innerHTML = items;
  document.body.appendChild(menu);

  // Position near the gear button
  const rect = anchorEl.getBoundingClientRect();
  menu.style.top = `${rect.bottom + 4}px`;
  menu.style.left = `${rect.left - 100}px`;

  // Keep in viewport
  requestAnimationFrame(() => {
    const mr = menu.getBoundingClientRect();
    if (mr.right > window.innerWidth - 8) menu.style.left = `${window.innerWidth - mr.width - 8}px`;
    if (mr.bottom > window.innerHeight - 8) menu.style.top = `${rect.top - mr.height - 4}px`;
    if (mr.left < 8) menu.style.left = '8px';
  });

  // Bind item clicks
  menu.querySelectorAll('.gear-menu-item').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const action = btn.dataset.action;
      this._closeUserGearMenu();
      if (action === 'assign-role') {
        this._openRoleAssignCenter(userId);
      } else if (action === 'transfer-admin') {
        this._confirmTransferAdmin(userId, username);
      } else {
        this._showAdminActionModal(action, userId, username);
      }
    });
  });

  // Close on outside click
  setTimeout(() => {
    this._gearMenuOutsideHandler = (e) => {
      if (!menu.contains(e.target)) this._closeUserGearMenu();
    };
    document.addEventListener('click', this._gearMenuOutsideHandler, true);
  }, 10);
},

_closeUserGearMenu() {
  const existing = document.querySelector('.user-gear-menu');
  if (existing) existing.remove();
  if (this._gearMenuOutsideHandler) {
    document.removeEventListener('click', this._gearMenuOutsideHandler, true);
    this._gearMenuOutsideHandler = null;
  }
},

_renderUserItem(u, scoreLookup) {
  const onlineClass = u.online === false ? ' offline' : '';
  const score = scoreLookup[u.id] || 0;
  const scoreBadge = score > 0
    ? `<span class="user-score-badge" title="Flappy Container: ${score}">🚢${score}</span>`
    : '';

  // Status dot color
  const statusClass = u.status === 'dnd' ? 'dnd' : u.status === 'away' ? 'away'
    : u.status === 'invisible' ? 'invisible' : (u.online === false ? 'away' : '');

  const statusTextHtml = u.statusText
    ? `<span class="user-status-text" title="${this._escapeHtml(u.statusText)}">${this._escapeHtml(u.statusText)}</span>`
    : '';

  // Avatar: image or letter fallback
  const color = this._getUserColor(u.username);
  const initial = u.username.charAt(0).toUpperCase();
  const shapeClass = 'avatar-' + (u.avatarShape || 'circle');
  const avatarImg = u.avatar
    ? `<img class="user-item-avatar user-item-avatar-img ${shapeClass}" src="${this._escapeHtml(u.avatar)}" alt="${initial}"><div class="user-item-avatar ${shapeClass}" style="background-color:${color};display:none">${initial}</div>`
    : `<div class="user-item-avatar ${shapeClass}" style="background-color:${color}">${initial}</div>`;

  // Wrap avatar + status dot together (Discord-style overlay)
  const avatarHtml = `<div class="user-avatar-wrapper">${avatarImg}<span class="user-status-dot${statusClass ? ' ' + statusClass : ''}"></span></div>`;

  // Role: color dot to the left of name + tooltip on hover
  const roleColor = u.role ? this._safeColor(u.role.color, 'var(--text-muted)') : '';
  const roleDot = u.role
    ? `<span class="user-role-dot" style="background:${roleColor}" title="${this._escapeHtml(u.role.name)}"></span>`
    : '';

  // Keep the old badge for message area (msg-role-badge) but hide in sidebar
  const roleBadge = u.role
    ? `<span class="user-role-badge" style="color:${this._safeColor(u.role.color, 'var(--text-muted)')}" title="${this._escapeHtml(u.role.name)}">${this._escapeHtml(u.role.name)}</span>`
    : '';

  // Build tooltip
  const tooltipRole = u.role ? `<div class="tooltip-role" style="color:${roleColor}">● ${this._escapeHtml(u.role.name)}</div>` : '';
  const tooltipStatus = u.statusText ? `<div class="tooltip-status">${this._escapeHtml(u.statusText)}</div>` : '';
  const tooltipOnline = u.online === false ? '<div class="tooltip-status">Offline</div>' : '';
  const tooltip = `<div class="user-item-tooltip"><div class="tooltip-username">${this._escapeHtml(u.username)}</div>${tooltipRole}${tooltipStatus}${tooltipOnline}</div>`;

  const dmBtn = u.id !== this.user.id
    ? `<button class="user-action-btn user-dm-btn" data-dm-uid="${u.id}" title="Direct Message">💬</button>`
    : '';

  // Show DM + Gear icon. Gear opens a dropdown with mod actions.
  const canModThis = (this.user.isAdmin || this._canModerate()) && u.id !== this.user.id;
  const canPromote = this._hasPerm('promote_user') && u.id !== this.user.id;
  const hasGear = canModThis || canPromote;
  const gearBtn = hasGear
    ? `<button class="user-action-btn user-gear-btn" data-uid="${u.id}" data-uname="${this._escapeHtml(u.username)}" title="More Actions">⚙️</button>`
    : '';
  const modBtns = (dmBtn || gearBtn)
    ? `<div class="user-admin-actions">${dmBtn}${gearBtn}</div>`
    : '';
  return `
    <div class="user-item${onlineClass}" data-user-id="${u.id}">
      ${avatarHtml}
      ${roleDot}
      <span class="user-item-name"${this._nicknames[u.id] ? ` title="${this._escapeHtml(u.username)}"` : ''}>${this._escapeHtml(this._getNickname(u.id, u.username))}</span>
      ${roleBadge}
      ${statusTextHtml}
      ${scoreBadge}
      ${modBtns}
      ${tooltip}
    </div>
  `;
},

// ── Profile Popup (Discord-style mini profile) ────────

_showProfilePopup(profile) {
  // If this was a hover-triggered popup but the mouse already left, abort
  if (this._isHoverPopup && !this._hoverTarget) return;

  this._closeProfilePopup();

  const isSelf = profile.id === this.user.id;
  const currentNick = !isSelf ? (this._nicknames[profile.id] || '') : '';
  const color = this._getUserColor(profile.username);
  const initial = profile.username.charAt(0).toUpperCase();
  const shapeClass = 'avatar-' + (profile.avatarShape || 'circle');

  const avatarHtml = profile.avatar
    ? `<img class="profile-popup-avatar ${shapeClass}" src="${this._escapeHtml(profile.avatar)}" alt="${initial}">`
    : `<div class="profile-popup-avatar profile-popup-avatar-fallback ${shapeClass}" style="background-color:${color}">${initial}</div>`;

  // Status dot
  const statusClass = profile.status === 'dnd' ? 'dnd' : profile.status === 'away' ? 'away'
    : profile.status === 'invisible' ? 'invisible' : (!profile.online ? 'away' : '');
  const statusLabel = profile.status === 'dnd' ? 'Do Not Disturb' : profile.status === 'away' ? 'Away'
    : profile.status === 'invisible' ? 'Invisible' : (profile.online ? 'Online' : 'Offline');

  // Roles
  const rolesHtml = (profile.roles && profile.roles.length > 0)
    ? profile.roles.map(r =>
        `<span class="profile-popup-role" style="border-color:${this._safeColor(r.color, 'var(--border-light)')}; color:${this._safeColor(r.color, 'var(--text-secondary)')}"><span class="profile-role-dot" style="background:${this._safeColor(r.color, 'var(--text-muted)')}"></span>${this._escapeHtml(r.name)}</span>`
      ).join('')
    : '';

  // Status text badge
  const statusTextHtml = profile.statusText
    ? `<div class="profile-popup-status-text">${this._escapeHtml(profile.statusText)}</div>`
    : '';

  // Bio (with "View Full Bio" toggle for long bios)
  const bioText = profile.bio || '';
  const bioShort = bioText.length > 80 ? bioText.slice(0, 80) + '…' : bioText;
  const bioHtml = bioText
    ? `<div class="profile-popup-bio">
         <span class="profile-bio-short">${this._escapeHtml(bioShort)}</span>
         ${bioText.length > 80 ? `<span class="profile-bio-full" style="display:none">${this._escapeHtml(bioText)}</span><button class="profile-bio-toggle">View Full Bio</button>` : ''}
       </div>`
    : (isSelf ? `<div class="profile-popup-bio profile-bio-empty">No bio yet — click Edit Profile to add one</div>` : '');

  // Join date
  const joinDate = profile.createdAt ? new Date(profile.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '';

  // Action buttons
  const nickBtnLabel = currentNick ? '✏️ Edit Nickname' : '🏷️ Set Nickname';
  const actionsHtml = isSelf
    ? `<button class="profile-popup-action-btn profile-edit-btn" id="profile-popup-edit-btn">✏️ Edit Profile</button>`
    : `<button class="profile-popup-action-btn profile-dm-btn" data-dm-uid="${profile.id}">💬 Message</button><button class="profile-popup-action-btn profile-nick-btn" data-nick-uid="${profile.id}" data-nick-uname="${this._escapeHtml(profile.username)}">${nickBtnLabel}</button>`;

  const popup = document.createElement('div');
  popup.id = 'profile-popup';
  popup.className = 'profile-popup';
  popup.innerHTML = `
    <div class="profile-popup-banner" style="background:linear-gradient(135deg, ${color}44, ${color}22)">
      <button class="profile-popup-close" title="Close">&times;</button>
    </div>
    <div class="profile-popup-avatar-wrapper">
      ${avatarHtml}
      <span class="profile-popup-status-dot ${statusClass}" title="${statusLabel}"></span>
    </div>
    <div class="profile-popup-body">
      <div class="profile-popup-names">
        ${currentNick ? `<span class="profile-popup-nickname">🏷️ ${this._escapeHtml(currentNick)}</span>` : ''}
        <span class="profile-popup-displayname">${this._escapeHtml(profile.displayName)}</span>
        <span class="profile-popup-username">@${this._escapeHtml(profile.username)}</span>
      </div>
      ${statusTextHtml}
      ${bioHtml}
      <div class="profile-popup-divider"></div>
      ${rolesHtml ? `<div class="profile-popup-section-label">Roles</div><div class="profile-popup-roles">${rolesHtml}</div>` : ''}
      ${joinDate ? `<div class="profile-popup-section-label">Member Since</div><div class="profile-popup-join-date">${joinDate}</div>` : ''}
      <div class="profile-popup-actions">${actionsHtml}</div>
    </div>
  `;

  // Hover mode: add translucent class — popup is non-interactive (tooltip)
  if (this._isHoverPopup) {
    popup.classList.add('profile-popup-hover');
    // pointer-events:none is set via CSS on .profile-popup-hover so
    // the user can't accidentally interact with it; close is driven
    // entirely by setupHoverProfile's mouseover/mouseleave.
  }

  document.body.appendChild(popup);

  // Position near the anchor element
  this._positionProfilePopup(popup);

  // Hover-mode: no interactive handlers needed — the popup is pointer-events:none.
  // Safety-net auto-close in case the mouseover handler misses.
  if (this._isHoverPopup) {
    this._hoverAutoCloseTimer = setTimeout(() => {
      if (this._isHoverPopup) this._closeProfilePopup();
    }, 3000);
  }

  // Close button
  popup.querySelector('.profile-popup-close').addEventListener('click', () => this._closeProfilePopup());

  // Bio toggle
  const bioToggle = popup.querySelector('.profile-bio-toggle');
  if (bioToggle) {
    bioToggle.addEventListener('click', () => {
      const short = popup.querySelector('.profile-bio-short');
      const full = popup.querySelector('.profile-bio-full');
      if (full.style.display === 'none') {
        full.style.display = '';
        short.style.display = 'none';
        bioToggle.textContent = 'Show Less';
      } else {
        full.style.display = 'none';
        short.style.display = '';
        bioToggle.textContent = 'View Full Bio';
      }
    });
  }

  // DM button
  const dmBtnEl = popup.querySelector('.profile-dm-btn');
  if (dmBtnEl) {
    dmBtnEl.addEventListener('click', () => {
      const targetId = parseInt(dmBtnEl.dataset.dmUid);
      this.socket.emit('start-dm', { targetUserId: targetId });
      this._closeProfilePopup();
      this._showToast(`Opening DM with ${profile.displayName}…`, 'info');
    });
  }

  // Nickname button
  const nickBtnEl = popup.querySelector('.profile-nick-btn');
  if (nickBtnEl) {
    nickBtnEl.addEventListener('click', () => {
      const uid = parseInt(nickBtnEl.dataset.nickUid);
      const uname = nickBtnEl.dataset.nickUname;
      this._closeProfilePopup();
      this._showNicknameDialog(uid, uname);
    });
  }

  // Edit profile button (for self)
  const editBtnEl = popup.querySelector('#profile-popup-edit-btn');
  if (editBtnEl) {
    editBtnEl.addEventListener('click', () => {
      this._closeProfilePopup();
      // Open the Edit Profile (rename) modal which now includes avatar + display name + bio
      document.getElementById('rename-modal').style.display = 'flex';
      const input = document.getElementById('rename-input');
      input.value = this.user.displayName || this.user.username;
      input.focus();
      input.select();
      const bioInput = document.getElementById('edit-profile-bio');
      if (bioInput) bioInput.value = this.user.bio || '';
      this._updateAvatarPreview();
      const picker = document.getElementById('avatar-shape-picker');
      if (picker) {
        const currentShape = this.user.avatarShape || localStorage.getItem('haven_avatar_shape') || 'circle';
        picker.querySelectorAll('.avatar-shape-btn').forEach(b => {
          b.classList.toggle('active', b.dataset.shape === currentShape);
        });
        this._pendingAvatarShape = currentShape;
      }
    });
  }

  // Close on outside click (delay to avoid instant close) — skip for hover popups
  if (!this._isHoverPopup) {
    setTimeout(() => {
      this._profilePopupOutsideHandler = (e) => {
        if (!popup.contains(e.target)) this._closeProfilePopup();
      };
      document.addEventListener('click', this._profilePopupOutsideHandler);
    }, 50);
  }
},

// Convert a hover popup to a permanent (click-based) popup in-place
_promoteHoverPopup(popup) {
  this._isHoverPopup = false;
  this._hoverTarget = null;
  clearTimeout(this._hoverAutoCloseTimer);
  clearTimeout(this._hoverFadeTimeout);
  // Remove hover styling
  popup.classList.remove('profile-popup-hover', 'profile-popup-fading');
  popup.style.pointerEvents = '';
  // Show close button
  const closeBtn = popup.querySelector('.profile-popup-close');
  if (closeBtn) closeBtn.style.display = '';
  // Show action buttons
  const actions = popup.querySelector('.profile-popup-actions');
  if (actions) actions.style.display = '';
  // Re-run entrance animation for the full card
  popup.style.animation = 'none';
  popup.offsetHeight; // force reflow
  popup.style.animation = '';
  // Add close-on-outside-click handler
  setTimeout(() => {
    this._profilePopupOutsideHandler = (e) => {
      if (!popup.contains(e.target)) this._closeProfilePopup();
    };
    document.addEventListener('click', this._profilePopupOutsideHandler);
  }, 50);
},

_positionProfilePopup(popup) {
  const anchor = this._profilePopupAnchor;
  if (!anchor) {
    // Center fallback
    popup.style.left = '50%';
    popup.style.top = '50%';
    popup.style.transform = 'translate(-50%, -50%)';
    return;
  }
  const rect = anchor.getBoundingClientRect();
  const pw = 320; // popup width
  const ph = 400; // estimated max height

  let left = rect.left + rect.width / 2 - pw / 2;
  let top = rect.bottom + 8;

  // Keep within viewport
  if (left < 8) left = 8;
  if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
  if (top + ph > window.innerHeight - 8) {
    top = rect.top - ph - 8;
    if (top < 8) top = 8;
  }

  popup.style.left = left + 'px';
  popup.style.top = top + 'px';
},

_closeProfilePopup() {
  const existing = document.getElementById('profile-popup');
  if (existing) existing.remove();
  if (this._profilePopupOutsideHandler) {
    document.removeEventListener('click', this._profilePopupOutsideHandler);
    this._profilePopupOutsideHandler = null;
  }
  if (this._hoverMousemoveHandler) {
    document.removeEventListener('mousemove', this._hoverMousemoveHandler);
    this._hoverMousemoveHandler = null;
  }
  // NOTE: do NOT reset _isHoverPopup here.  It is only cleared by
  // explicit user actions (click, promote, context-menu).  Resetting it
  // on close caused a race: hover request in-flight → mouseout closes
  // popup/resets flag → stale server response arrives with
  // _isHoverPopup=false → guard fails → permanent popup appears.
  this._hoverTarget = null;
  clearTimeout(this._hoverCloseTimer);
  clearTimeout(this._hoverAutoCloseTimer);
  clearTimeout(this._hoverFadeTimeout);
},

_openEditProfileModal(profile) {
  // Create a simple modal for editing bio and status
  this._closeProfilePopup();
  const existing = document.getElementById('edit-profile-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'edit-profile-modal';
  modal.className = 'modal-overlay';
  modal.style.display = 'flex';
  modal.innerHTML = `
    <div class="modal edit-profile-modal-box">
      <h3>Edit Profile</h3>
      <label class="edit-profile-label">Bio <span class="muted-text">(max 190 chars)</span></label>
      <textarea id="edit-profile-bio" class="edit-profile-textarea" maxlength="190" placeholder="Tell people about yourself…">${this._escapeHtml(profile.bio || '')}</textarea>
      <div class="edit-profile-char-count"><span id="edit-profile-chars">${(profile.bio || '').length}</span>/190</div>
      <div class="modal-actions">
        <button class="btn-sm" id="edit-profile-cancel">Cancel</button>
        <button class="btn-sm btn-accent" id="edit-profile-save">Save</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  const bioInput = document.getElementById('edit-profile-bio');
  const charCount = document.getElementById('edit-profile-chars');

  bioInput.addEventListener('input', () => {
    charCount.textContent = bioInput.value.length;
  });
  bioInput.focus();

  document.getElementById('edit-profile-cancel').addEventListener('click', () => modal.remove());
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

  document.getElementById('edit-profile-save').addEventListener('click', () => {
    this.socket.emit('set-bio', { bio: bioInput.value });
    modal.remove();
  });
},

// ── Voice Users ───────────────────────────────────────

_renderVoiceUsers(users) {
  this._lastVoiceUsers = users; // Cache for re-render on stream info updates
  const el = document.getElementById('voice-users');
  if (users.length === 0) {
    el.innerHTML = '<p class="muted-text">No one in voice</p>';
    return;
  }
  const streams = this._streamInfo || [];
  el.innerHTML = users.map(u => {
    const isSelf = u.id === this.user.id;
    const talking = this.voice && ((isSelf && this.voice.talkingState.get('self')) || this.voice.talkingState.get(u.id));
    const dotColor = this._safeColor(u.roleColor);
    const dotStyle = dotColor ? ` style="background:${dotColor};--voice-dot-color:${dotColor}"` : '';

    // Stream indicators: is this user streaming? watching?
    const isStreaming = streams.some(s => s.sharerId === u.id);
    const watchingStreams = streams.filter(s => s.viewers.some(v => v.id === u.id));
    const isWatching = watchingStreams.length > 0;
    let streamBadge = '';
    if (isStreaming) {
      const myStream = streams.find(s => s.sharerId === u.id);
      const viewerCount = myStream ? myStream.viewers.length : 0;
      streamBadge = `<span class="voice-stream-badge live" title="Streaming${viewerCount ? ' · ' + viewerCount + ' viewer' + (viewerCount > 1 ? 's' : '') : ''}">🔴 LIVE${viewerCount ? ' · ' + viewerCount : ''}</span>`;
    }
    if (isWatching) {
      const watchNames = watchingStreams.map(s => s.sharerName).join(', ');
      streamBadge += `<span class="voice-stream-badge watching" title="Watching ${watchNames}">👁</span>`;
    }

    return `
      <div class="user-item voice-user-item${talking ? ' talking' : ''}" data-user-id="${u.id}"${dotColor ? ` style="--voice-dot-color:${dotColor}"` : ''}>
        <span class="user-dot voice"${dotStyle}></span>
        <span class="user-item-name"${this._nicknames[u.id] ? ` title="${this._escapeHtml(u.username)}"` : ''}>${this._escapeHtml(this._getNickname(u.id, u.username))}</span>
        ${streamBadge}
        ${isSelf ? '<span class="you-tag">you</span>' : `<button class="voice-user-menu-btn" data-user-id="${u.id}" data-username="${this._escapeHtml(u.username)}" title="User options">⋯</button>`}
      </div>
    `;
  }).join('');

  // Bind "..." buttons to open per-user voice submenu
  el.querySelectorAll('.voice-user-menu-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const userId = parseInt(btn.dataset.userId);
      const username = btn.dataset.username;
      this._showVoiceUserMenu(btn, userId, username);
    });
  });

  // Bind voice user names/items to open profile popup (same as sidebar)
  el.querySelectorAll('.voice-user-item').forEach(item => {
    const nameEl = item.querySelector('.user-item-name');
    if (nameEl) {
      nameEl.style.cursor = 'pointer';
      nameEl.addEventListener('click', (e) => {
        e.stopPropagation();
        const userId = parseInt(item.dataset.userId);
        if (!isNaN(userId)) {
          this._profilePopupAnchor = nameEl;
          this.socket.emit('get-user-profile', { userId });
        }
      });
    }

    // Right-click on voice user → same options as "..." button
    item.addEventListener('contextmenu', (e) => {
      const userId = parseInt(item.dataset.userId);
      if (isNaN(userId) || userId === this.user.id) return;
      e.preventDefault();
      e.stopPropagation();
      const btn = item.querySelector('.voice-user-menu-btn');
      const username = btn ? btn.dataset.username : '';
      this._showVoiceUserMenu(btn || item, userId, username);
    });
  });
},

_showVoiceUserMenu(anchorEl, userId, username) {
  this._closeVoiceUserMenu();

  const savedVol = this._getVoiceVolume(userId);
  const isMuted = savedVol === 0;
  const isDeafened = this.voice ? this.voice.isUserDeafened(userId) : false;
  // Show voice kick for admins and mods with kick_user permission
  const canKick = this._hasPerm('kick_user');
  const menu = document.createElement('div');
  menu.className = 'voice-user-menu';
  menu.innerHTML = `
    <div class="voice-user-menu-header">${this._escapeHtml(this._getNickname(userId, username))}</div>
    <div class="voice-user-menu-row">
      <span class="voice-user-menu-label">🔊 Volume</span>
      <input type="range" class="volume-slider voice-user-vol-slider" min="0" max="200" value="${savedVol}" title="Volume: ${savedVol}%">
      <span class="voice-user-vol-value">${savedVol}%</span>
    </div>
    <div class="voice-user-menu-actions">
      <button class="voice-user-menu-action" data-action="mute-user">${isMuted ? '🔊 Unmute' : '🔇 Mute'}</button>
      <button class="voice-user-menu-action ${isDeafened ? 'active' : ''}" data-action="deafen-user">${isDeafened ? '🔊 Undeafen' : '🔇 Deafen'}</button>
      ${canKick ? `<button class="voice-user-menu-action danger" data-action="voice-kick" title="Remove from voice channel">🚪 Voice Kick</button>` : ''}
    </div>
    <div class="voice-user-menu-hint">
      <small>Mute = you can't hear them</small><br>
      <small>Deafen = they can't hear you</small>
    </div>
  `;
  document.body.appendChild(menu);

  // Position
  const rect = anchorEl.getBoundingClientRect();
  menu.style.top = `${rect.bottom + 4}px`;
  menu.style.left = `${rect.left - 140}px`;
  requestAnimationFrame(() => {
    const mr = menu.getBoundingClientRect();
    if (mr.right > window.innerWidth - 8) menu.style.left = `${window.innerWidth - mr.width - 8}px`;
    if (mr.bottom > window.innerHeight - 8) menu.style.top = `${rect.top - mr.height - 4}px`;
    if (mr.left < 8) menu.style.left = '8px';
  });

  // Bind volume slider
  const slider = menu.querySelector('.voice-user-vol-slider');
  const volLabel = menu.querySelector('.voice-user-vol-value');
  slider.addEventListener('input', () => {
    const vol = parseInt(slider.value);
    slider.title = `Volume: ${vol}%`;
    volLabel.textContent = `${vol}%`;
    this._setVoiceVolume(userId, vol);
    if (this.voice) this.voice.setVolume(userId, vol / 100);
  });

  // Bind mute/deafen actions
  menu.querySelectorAll('.voice-user-menu-action').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (btn.dataset.action === 'mute-user') {
        // Mute: toggle their volume to 0 so YOU can't hear THEM
        const newVol = parseInt(slider.value) === 0 ? 100 : 0;
        slider.value = newVol;
        volLabel.textContent = `${newVol}%`;
        this._setVoiceVolume(userId, newVol);
        if (this.voice) this.voice.setVolume(userId, newVol / 100);
        btn.textContent = newVol === 0 ? '🔊 Unmute' : '🔇 Mute';
      } else if (btn.dataset.action === 'deafen-user') {
        // Deafen: stop sending YOUR audio to THEM (they can't hear you)
        if (this.voice) {
          if (this.voice.isUserDeafened(userId)) {
            this.voice.undeafenUser(userId);
            btn.textContent = '🔇 Deafen';
            btn.classList.remove('active');
            this._showToast(`${this._escapeHtml(username)} can hear you again`, 'info');
          } else {
            this.voice.deafenUser(userId);
            btn.textContent = '🔊 Undeafen';
            btn.classList.add('active');
            this._showToast(`${this._escapeHtml(username)} can no longer hear you`, 'info');
          }
        }
      } else if (btn.dataset.action === 'voice-kick') {
        // Voice Kick: remove this user from voice (server enforces level check)
        if (this.voice && this.voice.inVoice) {
          this.socket.emit('voice-kick', { code: this.voice.currentChannel, userId });
          this._closeVoiceUserMenu();
        }
      }
    });
  });

  // Close on outside click
  setTimeout(() => {
    this._voiceUserMenuHandler = (e) => {
      if (!menu.contains(e.target)) this._closeVoiceUserMenu();
    };
    document.addEventListener('click', this._voiceUserMenuHandler, true);
  }, 10);
},

_closeVoiceUserMenu() {
  const existing = document.querySelector('.voice-user-menu');
  if (existing) existing.remove();
  if (this._voiceUserMenuHandler) {
    document.removeEventListener('click', this._voiceUserMenuHandler, true);
    this._voiceUserMenuHandler = null;
  }
},

_getVoiceVolume(userId) {
  try {
    const vols = JSON.parse(localStorage.getItem('haven_voice_volumes') || '{}');
    return vols[userId] ?? 100;
  } catch { return 100; }
},

_setVoiceVolume(userId, vol) {
  try {
    const vols = JSON.parse(localStorage.getItem('haven_voice_volumes') || '{}');
    vols[userId] = vol;
    localStorage.setItem('haven_voice_volumes', JSON.stringify(vols));
  } catch { /* ignore */ }
},

// ── Nicknames (client-side only) ──────────────────────

_getNickname(userId, fallbackUsername) {
  if (userId && this._nicknames[userId]) return this._nicknames[userId];
  return fallbackUsername;
},

_setNickname(userId, nickname) {
  if (nickname && nickname.trim()) {
    this._nicknames[userId] = nickname.trim();
  } else {
    delete this._nicknames[userId];
  }
  localStorage.setItem('haven_nicknames', JSON.stringify(this._nicknames));
},

_showNicknameDialog(userId, currentUsername) {
  const existing = this._nicknames[userId] || '';
  const dialog = document.createElement('div');
  dialog.className = 'modal-overlay';
  dialog.style.display = 'flex';
  dialog.style.zIndex = '100002';
  dialog.innerHTML = `
    <div class="modal" style="max-width:360px">
      <h3 style="margin-top:0">Set Nickname</h3>
      <p class="muted-text" style="margin:0 0 12px">Only you will see this nickname for <strong>${this._escapeHtml(currentUsername)}</strong>.</p>
      <input type="text" id="nickname-input" class="modal-input" value="${this._escapeHtml(existing)}" placeholder="${this._escapeHtml(currentUsername)}" maxlength="32" style="width:100%;box-sizing:border-box">
      <div class="modal-actions" style="margin-top:12px">
        ${existing ? '<button class="btn-sm" id="nickname-clear">Clear</button>' : ''}
        <button class="btn-sm" id="nickname-cancel">Cancel</button>
        <button class="btn-sm btn-accent" id="nickname-save">Save</button>
      </div>
    </div>
  `;
  document.body.appendChild(dialog);
  const input = dialog.querySelector('#nickname-input');
  input.focus();
  input.select();

  const close = () => dialog.remove();
  dialog.querySelector('#nickname-cancel').addEventListener('click', close);
  dialog.addEventListener('click', (e) => { if (e.target === dialog) close(); });

  const clearBtn = dialog.querySelector('#nickname-clear');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      this._setNickname(userId, null);
      this._refreshNicknameDisplays();
      this._showToast('Nickname cleared', 'info');
      close();
    });
  }

  dialog.querySelector('#nickname-save').addEventListener('click', () => {
    const val = input.value.trim();
    this._setNickname(userId, val || null);
    this._refreshNicknameDisplays();
    if (val) {
      this._showToast(`Nickname set to "${val}"`, 'success');
    } else {
      this._showToast('Nickname cleared', 'info');
    }
    close();
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') dialog.querySelector('#nickname-save').click();
    if (e.key === 'Escape') close();
  });
},

_refreshNicknameDisplays() {
  // Re-render sidebar + voice to pick up nickname changes
  if (this._lastOnlineUsers) this._renderOnlineUsers(this._lastOnlineUsers);
  if (this._lastVoiceUsers) this._renderVoiceUsers(this._lastVoiceUsers);
  // Update visible message author names in place
  document.querySelectorAll('.message, .message-compact').forEach(el => {
    const uid = parseInt(el.dataset.userId);
    const realName = el.dataset.username;
    if (uid && realName) {
      const nick = this._getNickname(uid, realName);
      const authorEl = el.querySelector('.message-author');
      if (authorEl) {
        authorEl.textContent = nick;
        authorEl.title = nick !== realName ? realName : '';
      }
    }
  });
  // Close profile popup since data changed
  this._closeProfilePopup();
},

_showTyping(username) {
  const el = document.getElementById('typing-indicator');
  // Look up nickname by username from online users
  const onlineUser = this._lastOnlineUsers && this._lastOnlineUsers.find(u => u.username === username);
  const display = onlineUser ? this._getNickname(onlineUser.id, username) : username;
  el.textContent = `${display} is typing...`;
  clearTimeout(this.typingTimeout);
  this.typingTimeout = setTimeout(() => { el.textContent = ''; }, 3000);
},

};
