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

  // Mirror of the right-click context menu's invite filter: any non-DM,
  // non-private channel the user can see (admins also see private channels).
  // Showing the entry only when there's at least one channel available.
  const inviteChannels = (this.channels || []).filter(ch =>
    !ch.is_dm && ch.name && !ch.parent_channel_id &&
    ((!ch.is_private && ch.code_visibility !== 'private') || isAdmin)
  );
  const canInvite = inviteChannels.length > 0 && userId !== this.user?.id;

  let items = '';
  if (canPromote) items += `<button class="gear-menu-item" data-action="assign-role">👑 ${t('users.gear_menu.assign_role')}</button>`;
  if (canInvite) items += `<button class="gear-menu-item" data-action="add-to-channel">➕ ${t('users.gear_menu.add_to_channel')}</button>`;
  if (canMod) items += `<button class="gear-menu-item" data-action="kick">👢 ${t('users.gear_menu.kick')}</button>`;
  if (canMod) items += `<button class="gear-menu-item" data-action="mute">🔇 ${t('users.gear_menu.mute')}</button>`;
  if (isAdmin) items += `<button class="gear-menu-item gear-menu-danger" data-action="ban">⛔ ${t('users.gear_menu.ban')}</button>`;
  if (isAdmin) items += `<button class="gear-menu-item gear-menu-danger" data-action="delete-user">🗑️ ${t('users.gear_menu.delete_user')}</button>`;
  // Admin password reset (#5300): gated on server setting AND target is not self.
  if (isAdmin && this.serverSettings?.admin_password_reset_enabled === 'true' && userId !== this.user?.id) {
    items += `<button class="gear-menu-item gear-menu-danger" data-action="reset-password">🔑 ${t('users.gear_menu.reset_password') || 'Reset Password'}</button>`;
  }
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
      } else if (action === 'add-to-channel') {
        this._openGearMenuChannelPicker(userId, username, inviteChannels);
      } else if (action === 'transfer-admin') {
        this._confirmTransferAdmin(userId, username);
      } else if (action === 'reset-password') {
        this._confirmAdminResetPassword(userId, username);
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

// Lightweight channel picker for the user gear menu's "Add to Channel"
// action. Lists every non-DM, non-private top-level channel the caller can
// see (admins also see private). Server's `invite-to-channel` handler
// validates membership/permissions and rejects already-members with a
// toast, so no need to pre-filter by target's current memberships here.
_openGearMenuChannelPicker(userId, username, channels) {
  if (!channels || channels.length === 0) {
    this._showToast?.('No channels available to invite to', 'info');
    return;
  }
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay aml-channel-picker-overlay';
  overlay.style.display = 'flex';
  overlay.style.zIndex = '100002';
  overlay.innerHTML = `
    <div class="modal aml-ch-picker">
      <div class="aml-ch-picker-header">
        <h4 class="aml-ch-picker-title">Add ${this._escapeHtml(username)} to channel</h4>
      </div>
      <div class="aml-channel-list">
        ${channels.map(c => `
          <button class="aml-channel-row gm-add-ch-btn" data-cid="${c.id}" data-cname="${this._escapeHtml(c.name)}">
            <span class="aml-ch-hash">#</span>
            <span class="aml-ch-name">${this._escapeHtml(c.name)}</span>
          </button>
        `).join('')}
      </div>
      <div class="modal-actions aml-ch-picker-actions">
        <button class="btn-sm aml-ch-cancel">${t('modals.common.cancel')}</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector('.aml-ch-cancel').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelectorAll('.gm-add-ch-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const channelId = parseInt(btn.dataset.cid);
      if (!channelId) return;
      this.socket.emit('invite-to-channel', { targetUserId: userId, channelId });
      close();
    });
  });
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

  // Rich presence — sidebar shows at most ONE activity to keep the list
  // scannable; a game outranks music. The profile card is where both show.
  const activityHtml = this._sidebarActivityHtml(u.activity);

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
  // (#5381) Mark guest accounts with a small badge so people know not to
  // expect long-term presence.
  const guestBadge = u.isGuest
    ? `<span class="user-role-badge guest-badge" style="color:#888;border:1px solid #555" title="Temporary guest account">GUEST</span>`
    : '';

  // Build tooltip
  const tooltipRole = u.role ? `<div class="tooltip-role" style="color:${roleColor}">● ${this._escapeHtml(u.role.name)}</div>` : '';
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
      ${guestBadge}
      ${statusTextHtml}
      ${activityHtml}
      ${scoreBadge}
      ${modBtns}
    </div>
  `;
},

// ── Rich presence: Settings → Connections ─────────────

/**
 * Render the linked-account rows. Providers the server has no credentials for
 * are shown greyed out with the reason, rather than hidden — otherwise a user
 * whose admin hasn't set up Spotify just sees an unexplained gap and files a
 * bug about the missing button.
 */
_renderConnections() {
  const host = document.getElementById('connections-list');
  if (!host) return;

  const data = this._connections || { connections: [], available: {} };
  const linked = new Map((data.connections || []).map(c => [c.provider, c]));
  const available = data.available || {};

  // Steam and Spotify both require per-deployment credentials that cannot ship
  // with Haven — a Steam key is tied to one person's Steam account, and a
  // bundled Spotify client secret would be extractable by anyone who downloads
  // the source. So "not configured" is the correct default state, and the admin
  // needs to know exactly which env vars fix it rather than just seeing a dead row.
  const PROVIDERS = [
    // Last.fm first: it's the recommended music source. No OAuth, no user cap,
    // and it reports whatever the person actually listens with.
    { id: 'lastfm', icon: '🎵', name: 'Last.fm',
      // Most people have never heard of Last.fm, so the row has to explain
      // what it is before asking them to link it.
      blurb: 'A free service that tracks what you listen to. Connect it to Spotify, YouTube Music, Apple Music, Navidrome and more — then Haven can show your music.',
      linkType: 'username',
      usernameLabel: 'Your Last.fm username',
      // People reliably assume linking the username is the whole job. It isn't:
      // Last.fm only knows what something sends it ("scrobbling"), and that is
      // set up on Last.fm's side, not here. Spell out both paths.
      note: 'First time? Sign up free at <b>last.fm</b>, then turn on <b>scrobbling</b> so it knows what you play:'
          + '<br>• <b>Spotify</b> — last.fm → Settings → Applications → connect Spotify. No install.'
          + '<br>• <b>YouTube Music, Apple Music, Tidal</b> — install the free <b>Web Scrobbler</b> browser extension.'
          + '<br>• <b>Navidrome, Plex, Jellyfin</b> — enable Last.fm scrobbling in that server\'s own settings.'
          + '<br>Without scrobbling set up, Haven will show nothing.',
      help: 'https://www.last.fm/api/account/create',
      helpLabel: 'Get a Last.fm API key',
      steps: [
        'Sign in with a Last.fm account and fill in the short form (name it "Haven"; the other fields can be anything).',
        'Copy the <b>API key</b> it shows you and paste it below. Ignore the shared secret — Haven does not need it.',
      ],
      fields: [{ key: 'LASTFM_API_KEY', label: 'API Key' }] },
    { id: 'steam', icon: '🎮', name: 'Steam', blurb: 'Show the game you\'re playing',
      help: 'https://steamcommunity.com/dev/apikey',
      helpLabel: 'Open the Steam key page',
      steps: [
        'Sign in with your Steam account.',
        'Where it asks for a domain, any value works — Steam does not check it. Put <code>localhost</code>.',
        'Copy the key it gives you and paste it below.',
      ],
      fields: [{ key: 'STEAM_API_KEY', label: 'API Key' }] },
    // Spotify is collapsed behind a disclosure. It needs a registered developer
    // app and its development-mode user allowlist caps it at roughly 25 people,
    // so steering everyone here by default sends them down the hardest path for
    // a worse result than Last.fm.
    { id: 'spotify', icon: '🎧', name: 'Spotify', advanced: true,
      blurb: 'Direct connection. Harder to set up and limited to ~25 users — prefer Last.fm above.',
      help: 'https://developer.spotify.com/dashboard',
      helpLabel: 'Open the Spotify developer dashboard',
      // Two things trip people up here, both worth stating outright:
      //  1. developer.spotify.com is a SEPARATE site from Spotify account
      //     settings. "Manage apps" under your account lists apps you've
      //     authorised and has no Create button — it is the wrong page, and
      //     it's the one people find first when they go looking themselves.
      //  2. "Create an app" sounds like software development. It isn't; it's
      //     registering a name so Spotify knows who is asking.
      steps: [
        'Use the link above — it goes to <b>developer.spotify.com</b>.',
        'Sign in with your normal Spotify account (free works). Accept the developer terms if it asks.',
        'Click <b>Create app</b>. You are not building software — this just registers a name. Call it "Haven".',
        'Paste this into <b>Redirect URI</b>:<code class="setup-uri">' + location.origin + '/connect/spotify/callback</code>',
        'Tick <b>Web API</b>, save, then open <b>Settings</b> on the app you just made.',
        'Copy <b>Client ID</b>, then click <b>View client secret</b> and copy that too.',
      ],
      fields: [
        { key: 'SPOTIFY_CLIENT_ID',     label: 'Client ID' },
        { key: 'SPOTIFY_CLIENT_SECRET', label: 'Client Secret' },
      ] },
  ];

  const isAdmin = !!this.user?.isAdmin;

  // Placeholder is a hint, not a default — derive it from the viewer's own
  // Haven name. It was hardcoded to a real username, which meant every user on
  // every Haven server was shown one specific person's handle as the example.
  const placeholderName = this._escapeHtml(
    (this.user?.username || this.user?.displayName || 'your-username')
      .replace(/[^a-zA-Z0-9_-]/g, '')
      .slice(0, 15) || 'your-username'
  );

  // Advanced providers stay collapsed unless already linked/configured —
  // no point hiding something the user is actively using.
  const isAdvancedHidden = (p) => p.advanced && !linked.has(p.id) && !available[p.id];

  const renderProvider = (p) => {
    const conn = linked.get(p.id);
    const configured = !!available[p.id];

    let sub, btn = '';
    if (!configured) {
      // Admins get an inline setup form — most self-hosters have no idea where
      // .env lives, and telling them to "edit .env and restart" is a dead end.
      // Everyone else just learns the provider is off.
      sub = isAdmin ? 'Not set up yet' : 'Not enabled on this server — ask an admin';
      if (isAdmin) {
        btn += `<button class="btn-sm connection-setup" data-provider="${p.id}">Set up</button>`;
      }
    } else if (conn) {
      sub = conn.displayName ? `Linked as ${this._escapeHtml(conn.displayName)}` : 'Linked';
      btn += `<button class="btn-sm connection-unlink" data-provider="${p.id}">Unlink</button>`;
      // A working key can still need rotating (it leaked, or Steam revoked it).
      // Surface a way to paste a fresh one without hand-editing .env.
      if (isAdmin) {
        btn += `<button class="btn-sm connection-rekey" data-provider="${p.id}">Change key</button>`;
      }
    } else if (p.linkType === 'username') {
      // No OAuth for this provider — the whole link flow is one text field.
      sub = p.blurb;
      btn += `<button class="btn-sm btn-accent connection-username-toggle" data-provider="${p.id}">Connect</button>`;
      if (isAdmin) {
        btn += `<button class="btn-sm connection-rekey" data-provider="${p.id}">Change key</button>`;
      }
    } else {
      sub = p.blurb;
      btn += `<button class="btn-sm btn-accent connection-link" data-provider="${p.id}">Link</button>`;
      if (isAdmin) {
        btn += `<button class="btn-sm connection-rekey" data-provider="${p.id}">Change key</button>`;
      }
    }

    // Rendered whenever an admin is looking, whether or not the provider is
    // already configured — so an existing key can be rotated from here instead
    // of by editing .env by hand. Hidden until "Set up" (unconfigured) or
    // "Change key" (configured) reveals it. Non-admins never see it.
    const setupForm = isAdmin ? `
      <div class="connection-setup-form" data-provider="${p.id}" hidden>
        <a class="connection-help" href="${p.help}" target="_blank" rel="noopener noreferrer">${p.helpLabel} ↗</a>
        <ol class="connection-steps">${p.steps.map(s => `<li>${s}</li>`).join('')}</ol>
        ${p.fields.map(f => `
          <label class="connection-field">
            <span>${f.label}</span>
            <input type="password" autocomplete="off" spellcheck="false"
                   data-env-key="${f.key}" placeholder="32 hex characters">
          </label>`).join('')}
        <div class="connection-setup-actions">
          <button class="btn-sm btn-accent connection-save" data-provider="${p.id}">Save</button>
          <button class="btn-sm connection-cancel" data-provider="${p.id}">Cancel</button>
        </div>
        <small class="settings-hint">Saved to the server's .env automatically${configured ? ' — this replaces the current key' : ''}. No restart needed.</small>
      </div>` : '';

    // Username link form (Last.fm). Collapsed until "Connect" is pressed.
    const usernameForm = (configured && !conn && p.linkType === 'username') ? `
      <div class="connection-username-form" data-provider="${p.id}" hidden>
        <label class="connection-field">
          <span>${p.usernameLabel}</span>
          <input type="text" autocomplete="off" spellcheck="false"
                 data-username-for="${p.id}" placeholder="${placeholderName}">
        </label>
        <div class="connection-setup-actions">
          <button class="btn-sm btn-accent connection-username-save" data-provider="${p.id}">Connect</button>
          <button class="btn-sm connection-username-cancel" data-provider="${p.id}">Cancel</button>
        </div>
        ${p.note ? `<small class="settings-hint">${p.note}</small>` : ''}
      </div>` : '';

    return `
      <div class="connection-block">
        <div class="connection-row${configured ? '' : ' is-unavailable'}">
          <span class="connection-icon">${p.icon}</span>
          <span class="connection-info">
            <span class="connection-name">${p.name}</span>
            <span class="connection-sub">${sub}</span>
          </span>
          ${btn}
        </div>
        ${setupForm}
        ${usernameForm}
      </div>`;
  };

  const primary  = PROVIDERS.filter(p => !isAdvancedHidden(p));
  const advanced = PROVIDERS.filter(p => isAdvancedHidden(p));

  host.innerHTML = primary.map(renderProvider).join('')
    + (advanced.length ? `
      <details class="connection-advanced">
        <summary>Other options</summary>
        ${advanced.map(renderProvider).join('')}
      </details>` : '');

  const userFormFor = (provider) => host.querySelector(`.connection-username-form[data-provider="${provider}"]`);

  host.querySelectorAll('.connection-username-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const form = userFormFor(btn.dataset.provider);
      if (form) {
        form.hidden = !form.hidden;
        if (!form.hidden) form.querySelector('input')?.focus();
      }
    });
  });
  host.querySelectorAll('.connection-username-cancel').forEach(btn => {
    btn.addEventListener('click', () => {
      const form = userFormFor(btn.dataset.provider);
      if (form) { form.querySelector('input').value = ''; form.hidden = true; }
    });
  });
  host.querySelectorAll('.connection-username-save').forEach(btn => {
    const submit = () => {
      const form = userFormFor(btn.dataset.provider);
      const input = form?.querySelector('input');
      const value = input?.value.trim();
      if (!value) return this._showToast('Enter your Last.fm username', 'error');
      // Server verifies the name against the API and pushes a refreshed
      // connections payload, which re-renders this list.
      this.socket?.emit('link-lastfm', { username: value });
      input.value = '';
      form.hidden = true;
    };
    btn.addEventListener('click', submit);
    userFormFor(btn.dataset.provider)?.querySelector('input')
      ?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
  });

  const formFor = (provider) => host.querySelector(`.connection-setup-form[data-provider="${provider}"]`);

  host.querySelectorAll('.connection-setup').forEach(btn => {
    btn.addEventListener('click', () => {
      const form = formFor(btn.dataset.provider);
      if (form) {
        form.hidden = !form.hidden;
        if (!form.hidden) form.querySelector('input')?.focus();
      }
    });
  });
  // Identical reveal behaviour for the "Change key" button that appears on
  // already-configured providers, so an admin can rotate an existing key.
  host.querySelectorAll('.connection-rekey').forEach(btn => {
    btn.addEventListener('click', () => {
      const form = formFor(btn.dataset.provider);
      if (form) {
        form.hidden = !form.hidden;
        if (!form.hidden) form.querySelector('input')?.focus();
      }
    });
  });
  host.querySelectorAll('.connection-cancel').forEach(btn => {
    btn.addEventListener('click', () => {
      const form = formFor(btn.dataset.provider);
      if (form) {
        form.querySelectorAll('input').forEach(i => { i.value = ''; });
        form.hidden = true;
      }
    });
  });
  host.querySelectorAll('.connection-save').forEach(btn => {
    btn.addEventListener('click', () => {
      const form = formFor(btn.dataset.provider);
      if (!form) return;
      const inputs = [...form.querySelectorAll('input[data-env-key]')];
      if (inputs.some(i => !i.value.trim())) {
        this._showToast('Fill in every field first', 'error');
        return;
      }
      // Each key is saved independently; the server validates format and
      // replies with a refreshed 'connections' payload. Clear the fields
      // immediately — these are secrets and shouldn't linger in the DOM.
      inputs.forEach(i => {
        this.socket?.emit('set-integration-key', { key: i.dataset.envKey, value: i.value.trim() });
        i.value = '';
      });
      form.hidden = true;
    });
  });

  host.querySelectorAll('.connection-link').forEach(btn => {
    btn.addEventListener('click', () => {
      // The server replies with 'connect-token', which triggers the redirect.
      this.socket?.emit('get-connect-token', { provider: btn.dataset.provider });
    });
  });
  host.querySelectorAll('.connection-unlink').forEach(btn => {
    btn.addEventListener('click', () => {
      this.socket?.emit('unlink-connection', { provider: btn.dataset.provider });
    });
  });
},

/**
 * The OAuth callback bounces back to /app.html#connect=<provider>:<ok|error>.
 * Read it once on load, tell the user how it went, then strip the fragment so
 * a refresh doesn't replay the toast.
 */
_handleConnectRedirect() {
  const m = (window.location.hash || '').match(/^#connect=([a-z]+):(ok|error)$/);
  if (!m) return;
  const [, provider, status] = m;
  const label = provider.charAt(0).toUpperCase() + provider.slice(1);
  if (status === 'ok') {
    this._showToast(`${label} linked`, 'success');
    this.socket?.emit('get-connections');
  } else {
    this._showToast(`Couldn't link ${label} — please try again`, 'error');
  }
  try {
    history.replaceState(null, '', window.location.pathname + window.location.search);
  } catch { /* fragment stays; harmless */ }
},

// ── Rich presence rendering ───────────────────────────
// The server has already applied the user's privacy preferences before this
// object leaves it, so anything present here is meant to be visible. These
// helpers only decide *how much* to show, never *whether*.

/** Icon + verb for an activity slot. */
_activityMeta(act) {
  if (!act) return null;
  const isGame = act.type === 'playing';
  return {
    icon: isGame ? '🎮' : '🎵',
    verb: isGame ? 'Playing' : 'Listening to',
    // "Track — Artist" reads better than two separate fields in one line.
    label: act.details ? `${act.name} — ${act.details}` : act.name,
  };
},

/**
 * Single-line form for the member list. Games win over music when a user is
 * doing both, so the sidebar never grows a second line per person.
 */
_sidebarActivityHtml(activity) {
  if (!activity) return '';
  const act = activity.playing || activity.listening;
  const meta = this._activityMeta(act);
  if (!meta) return '';
  const full = `${meta.verb} ${meta.label}`;
  return `<span class="user-activity" title="${this._escapeHtml(full)}">${meta.icon} ${this._escapeHtml(meta.label)}</span>`;
},

/**
 * Profile-card form: one row per activity that's actually present, game first.
 * A user doing both gets both; a user doing neither (or sharing nothing) gets
 * no section at all rather than an empty heading.
 */
_profileActivityHtml(activity) {
  if (!activity) return '';
  const rows = [activity.playing, activity.listening]
    .map(act => {
      const meta = this._activityMeta(act);
      if (!meta) return '';
      const art = act.image
        ? `<img class="profile-activity-art" src="${this._escapeHtml(act.image)}" alt="" loading="lazy">`
        : `<span class="profile-activity-icon">${meta.icon}</span>`;
      const details = act.details
        ? `<span class="profile-activity-details">${this._escapeHtml(act.details)}</span>`
        : '';
      return `
        <div class="profile-activity-row">
          ${art}
          <span class="profile-activity-text">
            <span class="profile-activity-verb">${meta.verb}</span>
            <span class="profile-activity-name">${this._escapeHtml(act.name)}</span>
            ${details}
          </span>
        </div>`;
    })
    .filter(Boolean);

  if (rows.length === 0) return '';
  return `<div class="profile-popup-section-label">Activity</div>
          <div class="profile-popup-activity">${rows.join('')}</div>`;
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
      ${this._profileActivityHtml(profile.activity)}
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

_renderVoiceUsers(users, channelCode) {
  // Track which channel this list belongs to so cached re-renders
  // (stream info, nickname refresh, webcam status) preserve channel
  // context for the self-injection guard below.
  if (channelCode !== undefined) {
    this._lastVoiceUsersChannel = channelCode;
  }
  // Belt-and-suspenders self-injection. The voice-users-update socket
  // handler already injects the local user when we're in voice on the
  // channel being rendered, but some call paths (re-render on stream
  // info update, nickname refresh, channel switch) replay a cached
  // _lastVoiceUsers that might pre-date our join, and other call paths
  // pass through a stale list received before we appeared in the
  // server roster. If we are in voice on THIS channel right now and the
  // list doesn't include us, prepend ourselves so the right panel never
  // shows the "Voice Connected" bar with the user absent from the
  // participant list. Guarded by channelCode to avoid injecting self
  // into a different channel's voice roster when we're viewing one
  // channel but voice-connected to another. (#missing-self-voice-panel)
  const renderChannel = (channelCode !== undefined)
    ? channelCode
    : this._lastVoiceUsersChannel;
  if (Array.isArray(users) && this.voice && this.voice.inVoice && this.user &&
      renderChannel && renderChannel === this.voice.currentChannel) {
    const myId = this.user.id;
    if (myId != null && !users.some(u => u.id === myId)) {
      users = [{
        id: myId,
        username: this.user.displayName || this.user.username,
        roleColor: this.user.roleColor || null,
        isMuted: !!this.voice.isMuted,
        isDeafened: !!this.voice.isDeafened
      }, ...users];
    }
  }
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
      const hiddenTile = document.querySelector(`#screen-tile-${userId}[data-hidden="true"]`);
      if (hiddenTile) {
        this._showStreamTile(`screen-tile-${userId}`, userId);
      } else if (!document.getElementById(`screen-tile-${userId}`)) {
        // No tile at all (e.g. we joined after they went live and their stream
        // never reached us, or we closed our view and the sharer's tile was
        // since torn down) — actively ask the sharer to (re)send. Arm the
        // retry watchdog too: a single renegotiate request often loses the
        // race (the sharer may be mid-signaling-change), which left the viewer
        // stuck on "Requesting stream…" forever with no second attempt. The
        // watchdog re-requests a few times until a live video track arrives.
        // (#5426)
        if (this.voice) {
          this.voice.requestScreenStream(userId);
          this.voice._watchForScreenStream(userId);
        }
        this._showToast?.(t('voice.requesting_stream'), 'info');
      }
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
  const isStreaming = streams.some(s => s.sharerId === userId)
    || !!(this.voice && this.voice.screenSharers && this.voice.screenSharers.has(userId));
  const hiddenTile = isStreaming ? document.querySelector(`#screen-tile-${userId}[data-hidden="true"]`) : null;
  // Offer "Watch stream" whenever they're live and we don't already have a
  // visible tile — this both restores a hidden tile and requests a stream we
  // never received (late joiner).
  const visibleTile = document.querySelector(`#screen-tile-${userId}:not([data-hidden="true"])`);
  const canWatchStream = isStreaming && !visibleTile;
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
      ${canWatchStream ? `<button class="voice-user-menu-action" data-action="watch-stream">🖥 ${t('users.voice_menu.watch_stream')}</button>` : ''}
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
        const hidden = document.querySelector(`#screen-tile-${userId}[data-hidden="true"]`);
        if (hidden) {
          this._showStreamTile(`screen-tile-${userId}`, userId);
        } else if (this.voice) {
          // No tile yet — ask the sharer to (re)send their stream, and arm the
          // retry watchdog so a single dropped renegotiate doesn't strand the
          // viewer on "Requesting stream…" with no follow-up attempt. (#5426)
          this.voice.requestScreenStream(userId);
          this.voice._watchForScreenStream(userId);
          this._showToast?.(t('voice.requesting_stream'), 'info');
        }
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

// ── Nicknames ─────────────────────────────────────────────
// Stored server-side in user_nicknames (synced on session-info).
// localStorage acts as a fast local cache only.

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
  // Mirror to server so the nickname survives across devices (#5394).
  if (this.socket) {
    this.socket.emit('set-nickname', { targetId: userId, nickname: nickname || null });
  }
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
