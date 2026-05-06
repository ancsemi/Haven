export default {

// ── Users ─────────────────────────────────────────────

_renderOnlineUsers(users) {
  this._lastOnlineUsers = users;
  const el = document.getElementById('online-users');
  if (users.length === 0) {
    el.innerHTML = `<p class="muted-text">${t('users.no_one_here')}</p>`;
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
    html += `<div class="user-group-label">${t('users.online_count', { count: onlineUsers.length })}</div>`;
    html += onlineUsers.map(u => this._renderUserItem(u, scoreLookup)).join('');
  }
  if (offlineUsers.length > 0) {
    html += `<div class="user-group-label offline-label">${t('users.offline_count', { count: offlineUsers.length })}</div>`;
    html += offlineUsers.map(u => this._renderUserItem(u, scoreLookup)).join('');
  }
  if (!onlineUsers.length && !offlineUsers.length) {
    html = `<p class="muted-text">${t('users.no_one_here')}</p>`;
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
      this._showToast(t('users.opening_dm', { name: targetName }), 'info');
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
  if (canPromote) items += `<button class="gear-menu-item" data-action="assign-role">👑 ${t('users.gear_menu.assign_role')}</button>`;
  if (canMod) items += `<button class="gear-menu-item" data-action="kick">👢 ${t('users.gear_menu.kick')}</button>`;
  if (canMod) items += `<button class="gear-menu-item" data-action="mute">🔇 ${t('users.gear_menu.mute')}</button>`;
  if (isAdmin) items += `<button class="gear-menu-item gear-menu-danger" data-action="ban">⛔ ${t('users.gear_menu.ban')}</button>`;
  if (isAdmin) items += `<button class="gear-menu-item gear-menu-danger" data-action="delete-user">🗑️ ${t('users.gear_menu.delete_user')}</button>`;
  if (isAdmin) items += `<div class="gear-menu-divider"></div><button class="gear-menu-item gear-menu-danger" data-action="transfer-admin">🔑 ${t('users.gear_menu.transfer_admin')}</button>`;

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
      this._closeProfilePopup();
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
  // Per-device "hide other players' badges" preference. Only suppress badges
  // for users other than self — own badge stays visible to me unless the
  // server-side "hide own from server" preference also stripped it.
  const hideOthers = localStorage.getItem('haven_hide_other_scores') === 'true';
  const hideOwn    = localStorage.getItem('haven_hide_own_score')    === 'true';
  const isOwnUser  = u.id === this.user?.id;
  // Show badge unless: hideOthers is on and this is someone else,
  //                 OR hideOwn is on and this is the current user.
  const showBadge = score > 0 && (!hideOthers || isOwnUser) && !(hideOwn && isOwnUser);
  const scoreBadge = showBadge
    ? `<span class="user-score-badge" title="${t('users.flappy_score_title', { score })}">🚢${score}</span>`
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
  // Role display mode
  const roleDisplayMode = localStorage.getItem('haven-role-display') || 'colored-name';
  const roleColor = u.role ? this._safeColor(u.role.color, 'var(--text-muted)') : '';
  const showIconSidebar = (this.serverSettings.role_icon_sidebar || 'true') === 'true';
  const iconAfterName = this.serverSettings.role_icon_after_name === 'true';
  const roleIconHtml = showIconSidebar && u.role && u.role.icon
    ? `<img class="role-icon" src="${this._escapeHtml(u.role.icon)}" alt="" title="${this._escapeHtml(u.role.name)}">`
    : '';
  const roleIconBefore = roleIconHtml && !iconAfterName ? roleIconHtml : '';
  const roleIconAfter = roleIconHtml && iconAfterName ? roleIconHtml : '';
  const roleDot = (roleDisplayMode === 'dot' && u.role)
    ? `<span class="user-role-dot" style="background:${roleColor}" title="${this._escapeHtml(u.role.name)}"></span>`
    : '';

  // In colored-name mode, apply role color to the username
  const nameStyle = (roleDisplayMode === 'colored-name' && u.role && roleColor)
    ? ` style="color:${roleColor}"`
    : '';

  // Keep the old badge for message area (msg-role-badge) but hide in sidebar
  const roleBadge = u.role
    ? `<span class="user-role-badge" style="color:${this._safeColor(u.role.color, 'var(--text-muted)')}" title="${this._escapeHtml(u.role.name)}">${this._escapeHtml(u.role.name)}</span>`
    : '';

  // Build tooltip
  // Show all roles the user holds in this channel (multi-role) when more than
  // one is present; otherwise fall back to the single highest role line.
  let tooltipRole = '';
  if (Array.isArray(u.roles) && u.roles.length > 1) {
    tooltipRole = '<div class="tooltip-role-list">' + u.roles.map(r => {
      const c = this._safeColor(r.color, 'var(--text-muted)');
      return `<div class="tooltip-role" style="color:${c}">\u25CF ${this._escapeHtml(r.name)}</div>`;
    }).join('') + '</div>';
  } else if (u.role) {
    tooltipRole = `<div class="tooltip-role" style="color:${roleColor}">\u25CF ${this._escapeHtml(u.role.name)}</div>`;
  }
  const tooltipStatus = u.statusText ? `<div class="tooltip-status">${this._escapeHtml(u.statusText)}</div>` : '';
  const tooltipOnline = u.online === false ? `<div class="tooltip-status">${t('app.profile.offline')}</div>` : '';
  // Tooltip removed — the full profile popup (hover/click) provides this info.

  const dmBtn = u.id === this.user.id
    ? `<button class="user-action-btn user-dm-btn" data-dm-uid="${u.id}" title="Notes to self (DM yourself)">📝</button>`
    : `<button class="user-action-btn user-dm-btn" data-dm-uid="${u.id}" title="${t('users.direct_message')}">💬</button>`;

  // Show DM + Gear icon. Gear opens a dropdown with mod actions.
  const canModThis = (this.user.isAdmin || this._canModerate()) && u.id !== this.user.id;
  const canPromote = this._hasPerm('promote_user') && u.id !== this.user.id;
  const hasGear = canModThis || canPromote;
  const gearBtn = hasGear
    ? `<button class="user-action-btn user-gear-btn" data-uid="${u.id}" data-uname="${this._escapeHtml(u.username)}" title="${t('users.more_actions')}">⚙️</button>`
    : '';
  const modBtns = (dmBtn || gearBtn)
    ? `<div class="user-admin-actions">${dmBtn}${gearBtn}</div>`
    : '';
  return `
    <div class="user-item${onlineClass}" data-user-id="${u.id}">
      ${avatarHtml}
      ${roleDot}${roleIconBefore}
      <span class="user-item-name"${nameStyle}${this._nicknames[u.id] ? ` title="${this._escapeHtml(u.username)}"` : ''}>${this._escapeHtml(this._getNickname(u.id, u.username))}</span>
      ${roleIconAfter}
      ${roleBadge}
      ${statusTextHtml}
      ${scoreBadge}
      ${modBtns}
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
  const statusLabel = profile.status === 'dnd' ? t('app.profile.dnd') : profile.status === 'away' ? t('app.profile.away')
    : profile.status === 'invisible' ? t('app.profile.invisible') : (profile.online ? t('app.profile.online') : t('app.profile.offline'));

  // Roles
  const rolesHtml = (profile.roles && profile.roles.length > 0)
    ? profile.roles.map(r => {
        const rIcon = r.icon ? `<img class="role-icon" src="${this._escapeHtml(r.icon)}" alt="">` : `<span class="profile-role-dot" style="background:${this._safeColor(r.color, 'var(--text-muted)')}"></span>`;
        return `<span class="profile-popup-role" style="border-color:${this._safeColor(r.color, 'var(--border-light)')}; color:${this._safeColor(r.color, 'var(--text-secondary)')}">${rIcon}${this._escapeHtml(r.name)}</span>`;
      }).join('')
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
         ${bioText.length > 80 ? `<span class="profile-bio-full" style="display:none">${this._escapeHtml(bioText)}</span><button class="profile-bio-toggle">${t('users.view_full_bio')}</button>` : ''}
       </div>`
    : (isSelf ? `<div class="profile-popup-bio profile-bio-empty">${t('users.no_bio')}</div>` : '');

  // Join date
  const joinDate = profile.createdAt ? new Date(profile.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '';

  // Action buttons
  const nickBtnLabel = currentNick ? `✏️ ${t('users.edit_nickname')}` : `🏷️ ${t('users.set_nickname')}`;
  const canMod = this.user.isAdmin || this._canModerate();
  const canPromote = this._hasPerm('promote_user');
  const gearVisible = !isSelf && (canMod || canPromote || this.user.isAdmin);
  const gearBtnHtml = gearVisible
    ? `<button class="profile-popup-action-btn profile-gear-btn" title="${this._escapeHtml(t('users.more_actions') || 'Moderation')}">⚙️ ${t('users.more_actions') || 'Moderation'}</button>`
    : '';
  const actionsHtml = isSelf
    ? `<button class="profile-popup-action-btn profile-edit-btn" id="profile-popup-edit-btn">✏️ ${t('users.edit_profile')}</button><button class="profile-popup-action-btn profile-dm-btn" data-dm-uid="${profile.id}" title="Notes to self">📝 Notes to self</button>`
    : `<button class="profile-popup-action-btn profile-dm-btn" data-dm-uid="${profile.id}">💬 ${t('users.message_btn')}</button><button class="profile-popup-action-btn profile-nick-btn" data-nick-uid="${profile.id}" data-nick-uname="${this._escapeHtml(profile.username)}">${nickBtnLabel}</button>${gearBtnHtml}`;

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
      ${rolesHtml ? `<div class="profile-popup-section-label">${t('users.profile_roles_label')}</div><div class="profile-popup-roles">${rolesHtml}</div>` : ''}
      ${joinDate ? `<div class="profile-popup-section-label">${t('users.member_since_label')}</div><div class="profile-popup-join-date">${joinDate}</div>` : ''}
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
        bioToggle.textContent = t('users.show_less');
      } else {
        full.style.display = 'none';
        short.style.display = '';
        bioToggle.textContent = t('users.view_full_bio');
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
      this._showToast(t('users.opening_dm', { name: profile.displayName }), 'info');
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

  // Gear / moderation button — opens the same dropdown as the sidebar gear.
  // Do NOT close the popup first; the anchor element must be in the DOM
  // so _showUserGearMenu can read its position.
  const gearBtnEl = popup.querySelector('.profile-gear-btn');
  if (gearBtnEl) {
    gearBtnEl.addEventListener('click', (e) => {
      e.stopPropagation();
      this._showUserGearMenu(gearBtnEl, profile.id, profile.username);
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
      <h3>${t('users.edit_profile_modal_title')}</h3>
      <label class="edit-profile-label">${t('users.bio_label')} <span class="muted-text">${t('users.bio_max_hint')}</span></label>
      <textarea id="edit-profile-bio" class="edit-profile-textarea" maxlength="190" placeholder="${t('users.bio_placeholder')}">${this._escapeHtml(profile.bio || '')}</textarea>
      <div class="edit-profile-char-count"><span id="edit-profile-chars">${(profile.bio || '').length}</span>/190</div>
      <div class="modal-actions">
        <button class="btn-sm" id="edit-profile-cancel">${t('modals.common.cancel')}</button>
        <button class="btn-sm btn-accent" id="edit-profile-save">${t('modals.common.save')}</button>
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
    el.innerHTML = `<p class="muted-text">${t('right_sidebar.no_one_in_voice')}</p>`;
    return;
  }
  const streams = this._streamInfo || [];
  el.innerHTML = users.map(u => {
    const isSelf = u.id === this.user.id;
    const talking = this.voice && ((isSelf && this.voice.talkingState.get('self')) || this.voice.talkingState.get(u.id));
    const dotColor = this._safeColor(u.roleColor);
    const dotStyle = dotColor ? ` style="background:${dotColor};--voice-dot-color:${dotColor}"` : '';

    // Stream indicators: is this user streaming? watching?
    // We treat the user as streaming if EITHER the server-side `streams`
    // payload lists them OR we've received a `screen-share-started` event
    // for them.  The server payload is only refreshed at certain hooks and
    // could lag, so falling back on the live signaling avoids the bug
    // where the icon didn't appear until the local user also shared.
    const isStreamingByPayload = streams.some(s => s.sharerId === u.id);
    const isStreamingBySignal = !!(this.voice && this.voice.screenSharers && this.voice.screenSharers.has(u.id));
    const isStreaming = isStreamingByPayload || isStreamingBySignal;
    const watchingStreams = streams.filter(s => s.viewers.some(v => v.id === u.id));
    const isWatching = watchingStreams.length > 0;
    // Webcam indicator
    const hasWebcam = this.voice && this.voice.webcamUsers && this.voice.webcamUsers.has(u.id);

    let streamBadge = '';
    if (isStreaming) {
      const myStream = streams.find(s => s.sharerId === u.id);
      const viewerCount = myStream ? myStream.viewers.length : 0;
      streamBadge = `<span class="voice-stream-badge live" title="${viewerCount ? t(viewerCount === 1 ? 'users.streaming_viewers_one' : 'users.streaming_viewers_other', { count: viewerCount }) : t('users.streaming_no_viewers')}">🔴 ${t('users.streaming_live')}${viewerCount ? ' · ' + viewerCount : ''}</span>`;
    }
    if (hasWebcam) {
      streamBadge += `<span class="voice-stream-badge webcam" title="Camera on">📹</span>`;
    }
    if (isWatching) {
      const watchNames = watchingStreams.map(s => s.sharerName).join(', ');
      streamBadge += `<span class="voice-stream-badge watching" title="${t('users.watching_stream_title', { names: watchNames })}">👁</span>`;
    }

    const muteIcon = `<span class="voice-status-icon${u.isMuted ? ' is-muted' : ''}" title="${u.isMuted ? 'Muted' : 'Unmuted'}">🎙️</span>`;
    const deafenIcon = `<span class="voice-status-icon${u.isDeafened ? ' is-deafened' : ''}" title="${u.isDeafened ? 'Deafened' : 'Listening'}">🔊</span>`;
    return `
      <div class="user-item voice-user-item${talking ? ' talking' : ''}" data-user-id="${u.id}"${dotColor ? ` style="--voice-dot-color:${dotColor}"` : ''}>
        <span class="user-dot voice"${dotStyle}></span>
        <span class="user-item-name"${this._nicknames[u.id] ? ` title="${this._escapeHtml(u.username)}"` : ''}>${this._escapeHtml(this._getNickname(u.id, u.username))}</span>
        ${streamBadge}
        <span class="voice-status-icons">${muteIcon}${deafenIcon}</span> 
        ${isSelf ? `<span class="you-tag">${t('users.you_tag')}</span>` : `<button class="voice-user-menu-btn" data-user-id="${u.id}" data-username="${this._escapeHtml(u.username)}" title="${t('users.more_actions')}">⋯</button>`}
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

  // Bind LIVE badges — clicking restores a hidden stream tile
  el.querySelectorAll('.voice-stream-badge.live').forEach(badge => {
    badge.style.cursor = 'pointer';
    badge.addEventListener('click', (e) => {
      e.stopPropagation();
      const userId = parseInt(badge.closest('.voice-user-item')?.dataset.userId);
      if (isNaN(userId)) return;
      const tile = document.querySelector(`#screen-tile-${userId}[data-hidden="true"]`);
      if (tile) this._showStreamTile(`screen-tile-${userId}`, userId);
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
  // Check if user is streaming and has a hidden tile we can restore
  const streams = this._streamInfo || [];
  const isStreaming = streams.some(s => s.sharerId === userId);
  const hiddenTile = isStreaming ? document.querySelector(`#screen-tile-${userId}[data-hidden="true"]`) : null;
  const menu = document.createElement('div');
  menu.className = 'voice-user-menu';
  menu.innerHTML = `
    <div class="voice-user-menu-header">${this._escapeHtml(this._getNickname(userId, username))}</div>
    <div class="voice-user-menu-row">
      <span class="voice-user-menu-label">🔊 ${t('users.voice_menu.volume')}</span>
      <input type="range" class="volume-slider voice-user-vol-slider" min="0" max="200" value="${savedVol}" title="${t('users.voice_menu.volume_title', { vol: savedVol })}">
      <span class="voice-user-vol-value">${savedVol}%</span>
    </div>
    <div class="voice-user-menu-actions">
      ${hiddenTile ? `<button class="voice-user-menu-action" data-action="watch-stream">🖥 ${t('users.voice_menu.watch_stream')}</button>` : ''}
      <button class="voice-user-menu-action" data-action="mute-user">${isMuted ? `🔊 ${t('users.voice_menu.unmute')}` : `🔇 ${t('users.voice_menu.mute')}`}</button>
      <button class="voice-user-menu-action ${isDeafened ? 'active' : ''}" data-action="deafen-user">${isDeafened ? `🔊 ${t('users.voice_menu.undeafen')}` : `🔇 ${t('users.voice_menu.deafen')}`}</button>
      ${canKick ? `<button class="voice-user-menu-action danger" data-action="voice-kick" title="${t('users.voice_menu.voice_kick_title')}">🚪 ${t('users.voice_menu.voice_kick')}</button>` : ''}
    </div>
    <div class="voice-user-menu-hint">
      <small>${t('users.voice_menu.mute_hint')}</small><br>
      <small>${t('users.voice_menu.deafen_hint')}</small>
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
    slider.title = t('users.voice_menu.volume_title', { vol });
    volLabel.textContent = `${vol}%`;
    this._setVoiceVolume(userId, vol);
    if (this.voice) this.voice.setVolume(userId, vol / 100);
  });

  // Bind mute/deafen actions
  menu.querySelectorAll('.voice-user-menu-action').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (btn.dataset.action === 'watch-stream') {
        // Restore the hidden stream tile
        this._showStreamTile(`screen-tile-${userId}`, userId);
        this._closeVoiceUserMenu();
      } else if (btn.dataset.action === 'mute-user') {
        // Mute: toggle their volume to 0 so YOU can't hear THEM
        const newVol = parseInt(slider.value) === 0 ? 100 : 0;
        slider.value = newVol;
        volLabel.textContent = `${newVol}%`;
        this._setVoiceVolume(userId, newVol);
        if (this.voice) this.voice.setVolume(userId, newVol / 100);
        btn.textContent = newVol === 0 ? `🔊 ${t('users.voice_menu.unmute')}` : `🔇 ${t('users.voice_menu.mute')}`;
      } else if (btn.dataset.action === 'deafen-user') {
        // Deafen: stop sending YOUR audio to THEM (they can't hear you)
        if (this.voice) {
          if (this.voice.isUserDeafened(userId)) {
            this.voice.undeafenUser(userId);
            btn.textContent = `🔇 ${t('users.voice_menu.deafen')}`;
            btn.classList.remove('active');
            this._showToast(t('users.can_hear_again', { name: this._escapeHtml(username) }), 'info');
          } else {
            this.voice.deafenUser(userId);
            btn.textContent = `🔊 ${t('users.voice_menu.undeafen')}`;
            btn.classList.add('active');
            this._showToast(t('users.cannot_hear', { name: this._escapeHtml(username) }), 'info');
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
      <h3 style="margin-top:0">${t('users.set_nickname_title')}</h3>
      <p class="muted-text" style="margin:0 0 12px">${t('users.nickname_hint', { name: `<strong>${this._escapeHtml(currentUsername)}</strong>` })}</p>
      <input type="text" id="nickname-input" class="modal-input" value="${this._escapeHtml(existing)}" placeholder="${this._escapeHtml(currentUsername)}" maxlength="32" style="width:100%;box-sizing:border-box">
      <div class="modal-actions" style="margin-top:12px">
        ${existing ? `<button class="btn-sm" id="nickname-clear">${t('users.nickname_clear_btn')}</button>` : ''}
        <button class="btn-sm" id="nickname-cancel">${t('modals.common.cancel')}</button>
        <button class="btn-sm btn-accent" id="nickname-save">${t('modals.common.save')}</button>
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
      this._showToast(t('users.nickname_cleared'), 'info');
      close();
    });
  }

  dialog.querySelector('#nickname-save').addEventListener('click', () => {
    const val = input.value.trim();
    this._setNickname(userId, val || null);
    this._refreshNicknameDisplays();
    if (val) {
      this._showToast(t('users.nickname_set', { name: val }), 'success');
    } else {
      this._showToast(t('users.nickname_cleared'), 'info');
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
  el.textContent = t('users.typing', { name: display });
  clearTimeout(this.typingTimeout);
  this.typingTimeout = setTimeout(() => { el.textContent = ''; }, 3000);
},

};
