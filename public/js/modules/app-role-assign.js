// The Role Assignment center: pick people and channels, then set the
// roles and permissions they get there.

import { ALL_PERMS, ADMIN_ONLY_PERMS, PERM_LABELS } from './perm-catalog.js?v=4.17.23';

export default {

// ═══════════════════════════════════════════════════════
// CENTRALIZED ROLE ASSIGNMENT — Three-Pane Modal
// ═══════════════════════════════════════════════════════

_openRoleAssignCenter(preSelectUserId = null) {
  const modal = document.getElementById('role-assign-center-modal');
  modal.style.display = 'flex';
  modal.style.zIndex = '100003';

  // Reset state
  this._racData = null;
  this._racSelectedUser = null;
  this._racSelectedChannel = null; // null = server-wide, number = channel id
  this._racPendingChanges = {}; // key: `${userId}:${channelId||'server'}` → { assignments: { [roleId]: {level, customPerms, applyToSubs} }, removals: [roleId, ...] }
  this._racCollapsed = new Set(); // `${key}:${roleId}` cards folded away while their edits stay pending (#5607)

  document.getElementById('rac-user-list').innerHTML = `<p class="rac-placeholder">${t('modals.common.loading')}</p>`;
  document.getElementById('rac-channel-list').innerHTML = `<p class="rac-placeholder">${t('settings.admin.roles_select_user')}</p>`;
  document.getElementById('rac-config-body').innerHTML = `<p class="rac-placeholder">${t('settings.admin.roles_select_channel')}</p>`;
  document.getElementById('rac-save-btn').disabled = true;

  // Show admin-only buttons
  const manageBtn = document.getElementById('rac-manage-roles-btn');
  if (manageBtn) manageBtn.style.display = (this.user.isAdmin || this._hasPerm('manage_roles')) ? '' : 'none';

  this._roleEmit('get-role-assignment-data', {}, (res) => {
    if (res.error) { this._showToast(res.error, 'error'); return; }
    this._racData = res;
    this._renderRacUsers();
    if (preSelectUserId) {
      this._racSelectedUser = preSelectUserId;
      this._renderRacUsers();
      this._renderRacChannels();
    }
  });
},

_renderRacUsers(filter = '') {
  const list = document.getElementById('rac-user-list');
  if (!this._racData) return;
  const q = filter.toLowerCase();
  const users = this._racData.users.filter(u =>
    !q || u.username.toLowerCase().includes(q) || u.displayName.toLowerCase().includes(q)
  );

  if (users.length === 0) {
    list.innerHTML = `<p class="rac-placeholder">${t('settings.admin.roles_no_users')}</p>`;
    return;
  }

  list.innerHTML = users.map(u => {
    const color = this._getUserColor(u.username);
    const initial = u.displayName.charAt(0).toUpperCase();
    const shapeStyle = u.avatarShape === 'square' ? 'border-radius:4px' : '';
    const avatarInner = u.avatar
      ? `<img src="${this._escapeHtml(u.avatar)}" alt="${initial}" style="${shapeStyle}">`
      : initial;
    const activeClass = this._racSelectedUser === u.id ? ' active' : '';
    const roleNames = u.currentRoles
      .filter(r => !r.channel_id) // server-wide only for summary
      .map(r => r.name).join(', ') || t('settings.admin.roles_no_role');
    return `<div class="rac-user-item${activeClass}" data-uid="${u.id}">
      <div class="rac-user-avatar" style="background-color:${color};${shapeStyle}">${avatarInner}</div>
      <div class="rac-user-info">
        <span class="rac-user-name">${this._escapeHtml(this._getNickname(u.id, u.displayName))}</span>
        <span class="rac-user-level">${this._escapeHtml(roleNames)} (Lv.${u.serverLevel})</span>
      </div>
    </div>`;
  }).join('');

  list.querySelectorAll('.rac-user-item').forEach(el => {
    el.addEventListener('click', () => {
      this._racSelectedUser = parseInt(el.dataset.uid);
      this._racSelectedChannel = null;
      this._renderRacUsers(document.getElementById('rac-user-search').value);
      this._renderRacChannels();
      document.getElementById('rac-config-body').innerHTML = `<p class="rac-placeholder">${t('settings.admin.roles_select_channel')}</p>`;
    });
  });
},

_renderRacChannels() {
  const list = document.getElementById('rac-channel-list');
  if (!this._racData || !this._racSelectedUser) {
    list.innerHTML = `<p class="rac-placeholder">${t('settings.admin.roles_select_user')}</p>`;
    return;
  }

  const userId = this._racSelectedUser;
  const user = this._racData.users.find(u => u.id === userId);
  if (!user) return;

  const sharedIds = new Set(this._racData.userChannelMap[userId] || []);
  const channels = this._racData.channels;

  // Get current role names per scope for this user, factoring in pending edits.
  const getRoleSummary = (channelId) => {
    const key = `${userId}:${channelId || 'server'}`;
    const heldHere = user.currentRoles.filter(r => channelId ? r.channel_id === channelId : !r.channel_id);
    const pending = this._racPendingChanges[key];
    if (!pending) return heldHere.map(r => r.name).join(', ');

    const removals = new Set(pending.removals || []);
    const assignments = pending.assignments || {};
    const finalIds = new Set();
    heldHere.forEach(r => { if (!removals.has(r.role_id)) finalIds.add(r.role_id); });
    Object.keys(assignments).forEach(rid => finalIds.add(parseInt(rid, 10)));

    const names = [];
    finalIds.forEach(rid => {
      const heldEntry = heldHere.find(r => r.role_id === rid);
      const roleObj = this._racData.roles.find(r => r.id === rid);
      const name = (heldEntry && heldEntry.name) || (roleObj && roleObj.name) || `#${rid}`;
      names.push(name);
    });
    const hasEdits = Object.keys(assignments).length > 0 || removals.size > 0;
    return names.join(', ') + (hasEdits ? ' ✎' : '');
  };

  let html = '';

  // Admin: server-wide option
  if (this._racData.callerIsAdmin) {
    const serverActive = this._racSelectedChannel === 'server' ? ' active' : '';
    const serverRole = getRoleSummary(null);
    html += `<div class="rac-channel-item rac-server-wide${serverActive}" data-channel="server">
      <span class="rac-channel-icon">🌐</span>
      <span>${t('settings.admin.roles_server_wide')}</span>
      ${serverRole ? `<span class="rac-channel-current-role">${this._escapeHtml(serverRole)}</span>` : ''}
    </div>`;
  }

  // Parent channels
  const parents = channels.filter(c => !c.parentId);
  const subMap = {};
  channels.filter(c => c.parentId).forEach(c => {
    if (!subMap[c.parentId]) subMap[c.parentId] = [];
    subMap[c.parentId].push(c);
  });

  parents.forEach(p => {
    // Only surface channels the target user is actually a member of.
    // Admins previously saw every channel here, which let them assign
    // channel-specific roles in scopes the user couldn't even access.
    if (!sharedIds.has(p.id)) return;
    const pActive = this._racSelectedChannel === p.id ? ' active' : '';
    const pRole = getRoleSummary(p.id);
    html += `<div class="rac-channel-item${pActive}" data-channel="${p.id}">
      <span class="rac-channel-icon">#</span>
      <span>${this._escapeHtml(p.name)}</span>
      ${pRole ? `<span class="rac-channel-current-role">${this._escapeHtml(pRole)}</span>` : ''}
    </div>`;

    const subs = subMap[p.id] || [];
    subs.forEach(s => {
      if (!sharedIds.has(s.id)) return;
      const sActive = this._racSelectedChannel === s.id ? ' active' : '';
      const sRole = getRoleSummary(s.id);
      html += `<div class="rac-channel-item rac-sub${sActive}" data-channel="${s.id}">
        <span class="rac-channel-icon">└</span>
        <span>${this._escapeHtml(s.name)}</span>
        ${sRole ? `<span class="rac-channel-current-role">${this._escapeHtml(sRole)}</span>` : ''}
      </div>`;
    });
  });

  if (!html) {
    html = `<p class="rac-placeholder">${t('settings.admin.roles_no_shared_channels')}</p>`;
  }

  // Admins (or anyone with manage_roles) get an inline picker to add this
  // user to a channel they aren't yet in, so role assignment can extend to
  // new scopes without leaving the modal.
  const canAddToChannel = this._racData.callerIsAdmin
    || (this._racData.callerPerms || []).includes('*')
    || (this._racData.callerPerms || []).includes('manage_roles');
  if (canAddToChannel) {
    const missingChannels = channels.filter(c => !sharedIds.has(c.id));
    const opts = missingChannels.map(c => {
      const parent = c.parentId ? channels.find(x => x.id === c.parentId) : null;
      const label = parent ? `${parent.name} / ${c.name}` : c.name;
      return `<option value="${c.id}">${this._escapeHtml(label)}</option>`;
    }).join('');
    html += `
      <div class="rac-add-channel-row" style="padding:8px;border-top:1px solid var(--border-color, rgba(255,255,255,0.08));margin-top:6px">
        <select id="rac-add-channel-dropdown" class="rac-role-select" style="width:100%" ${missingChannels.length ? '' : 'disabled'}>
          <option value="">${this._escapeHtml(t(missingChannels.length ? 'settings.admin.roles_add_user_channel' : 'settings.admin.roles_user_every_channel'))}</option>
          ${opts}
        </select>
      </div>`;
  }
  list.innerHTML = html;

  const addChanDropdown = document.getElementById('rac-add-channel-dropdown');
  if (addChanDropdown) {
    addChanDropdown.addEventListener('change', (e) => {
      const cid = parseInt(e.target.value, 10);
      if (!cid) return;
      this.socket.emit('invite-to-channel', { targetUserId: this._racSelectedUser, channelId: cid });
      // Optimistically extend the local map so the channel shows up
      // immediately after the round-trip.
      if (!this._racData.userChannelMap[this._racSelectedUser]) {
        this._racData.userChannelMap[this._racSelectedUser] = [];
      }
      if (!this._racData.userChannelMap[this._racSelectedUser].includes(cid)) {
        this._racData.userChannelMap[this._racSelectedUser].push(cid);
      }
      this._racSelectedChannel = cid;
      this._renderRacChannels();
      this._renderRacConfig();
    });
  }

  list.querySelectorAll('.rac-channel-item').forEach(el => {
    el.addEventListener('click', () => {
      const ch = el.dataset.channel;
      this._racSelectedChannel = ch === 'server' ? 'server' : parseInt(ch);
      this._renderRacChannels();
      this._renderRacConfig();
    });
  });
},

_renderRacConfig() {
  const body = document.getElementById('rac-config-body');
  if (!this._racData || !this._racSelectedUser || this._racSelectedChannel == null) {
    body.innerHTML = `<p class="rac-placeholder">${t('settings.admin.roles_select_channel')}</p>`;
    return;
  }

  const userId = this._racSelectedUser;
  const user = this._racData.users.find(u => u.id === userId);
  if (!user) return;

  const channelId = this._racSelectedChannel === 'server' ? null : this._racSelectedChannel;
  const key = `${userId}:${channelId || 'server'}`;
  const pending = this._racPendingChanges[key] || { assignments: {}, removals: [] };
  const removalsSet = new Set(pending.removals || []);

  // Roles the user currently holds at this scope.
  const currentRoles = user.currentRoles.filter(r =>
    channelId ? r.channel_id === channelId : !r.channel_id
  );
  const heldIds = new Set(currentRoles.map(r => r.role_id));

  // Roles the caller is permitted to grant. Held roles always stay visible
  // (so the caller can at least see them) even if they're above the cap.
  const grantableRoles = this._racData.roles.filter(r =>
    this._racData.callerIsAdmin || r.level < this._racData.callerLevel
  );
  const grantableIds = new Set(grantableRoles.map(r => r.id));

  const callerPerms = this._racData.callerPerms || [];
  const callerIsAdmin = this._racData.callerIsAdmin;
  const allPerms = ALL_PERMS;
  const adminOnlyPerms = ADMIN_ONLY_PERMS;
  const permLabels = PERM_LABELS;
  const maxLevel = callerIsAdmin ? 99 : (this._racData.callerLevel - 1);
  const isParentChannel = channelId && this._racData.channels.some(c => c.parentId === channelId);

  // Build the unified role list for this scope: every held role + every
  // pending assignment that isn't already held. Order: highest level first.
  const seenRoleIds = new Set();
  const cards = [];
  currentRoles.forEach(r => {
    seenRoleIds.add(r.role_id);
    const roleObj = this._racData.roles.find(x => x.id === r.role_id) || {};
    // Prefer server-computed effective perms (role defaults +/- per-user
    // overrides for this scope) so the editor reflects what the user
    // actually has, not just the role's defaults.
    const heldPerms = Array.isArray(r.effectivePerms)
      ? r.effectivePerms
      : (roleObj.permissions || []);
    cards.push({
      roleId: r.role_id,
      name: r.name || roleObj.name || `#${r.role_id}`,
      color: r.color || roleObj.color || '#888',
      defaultLevel: roleObj.level || r.level,
      defaultPerms: heldPerms,
      heldLevel: r.level,
      held: true
    });
  });
  Object.keys(pending.assignments || {}).forEach(rid => {
    const id = parseInt(rid, 10);
    if (seenRoleIds.has(id)) return;
    seenRoleIds.add(id);
    const roleObj = this._racData.roles.find(x => x.id === id);
    if (!roleObj) return;
    cards.push({
      roleId: id, name: roleObj.name, color: roleObj.color,
      defaultLevel: roleObj.level, defaultPerms: roleObj.permissions || [],
      heldLevel: null, held: false
    });
  });
  cards.sort((a, b) => (b.defaultLevel || 0) - (a.defaultLevel || 0));

  // Determine the "stays held" set so the channel-summary preview is correct.
  const finalHeld = new Set();
  cards.forEach(c => {
    const isAssigned = pending.assignments && pending.assignments[c.roleId];
    const isRemoved = removalsSet.has(c.roleId);
    if (isAssigned) finalHeld.add(c.roleId);
    else if (c.held && !isRemoved) finalHeld.add(c.roleId);
  });

  // Roles available to add: grantable, not already in cards.
  const addableRoles = grantableRoles.filter(r => !seenRoleIds.has(r.id));

  // Inherited roles: server-wide and parent-channel roles visible as
  // read-only context when the admin is viewing a channel scope.
  const inheritedRoles = [];
  if (channelId !== null) {
    const serverWide = user.currentRoles.filter(r => !r.channel_id);
    serverWide.forEach(r => inheritedRoles.push({ ...r, _inheritedFrom: t('settings.admin.roles_server_wide') }));

    const thisChannel = this._racData.channels.find(c => c.id === channelId);
    if (thisChannel && thisChannel.parentId) {
      const parentRoles = user.currentRoles.filter(r => r.channel_id === thisChannel.parentId);
      const parentName = this._racData.channels.find(c => c.id === thisChannel.parentId)?.name || `#${thisChannel.parentId}`;
      parentRoles.forEach(r => inheritedRoles.push({ ...r, _inheritedFrom: `#${this._escapeHtml(parentName)}` }));
    }
  }

  // Header
  const userColor = this._getUserColor(user.username);
  const scopeLabel = channelId
    ? (this._racData.channels.find(c => c.id === channelId)?.name || `#${channelId}`)
    : t('settings.admin.roles_server_wide');

  const renderCard = (card) => {
    const assignment = pending.assignments && pending.assignments[card.roleId];
    const removed = removalsSet.has(card.roleId);
    const dirty = !!assignment || removed;

    // Effective edit state shown in the form:
    const effectiveLevel = assignment && assignment.level !== undefined
      ? assignment.level
      : (card.held ? card.heldLevel : card.defaultLevel);
    const effectivePerms = assignment && assignment.customPerms
      ? assignment.customPerms
      : [...(card.defaultPerms || [])];
    // Collapsed is a view state on top of the pending assignment, so a card
    // with edits, or a pending add, can be folded away without losing them.
    // The Collapse button used to do nothing at all for those (#5607).
    if (!this._racCollapsed) this._racCollapsed = new Set();
    const expanded = !!assignment && !this._racCollapsed.has(`${key}:${card.roleId}`);
    const applyToSubs = !!(assignment && assignment.applyToSubs);

    let stateBadge = '';
    if (removed) stateBadge = `<span class="rac-state-badge rac-state-removed">${this._escapeHtml(t('settings.admin.roles_pending_remove'))}</span>`;
    else if (assignment && !card.held) stateBadge = `<span class="rac-state-badge rac-state-added">${this._escapeHtml(t('settings.admin.roles_pending_add'))}</span>`;
    else if (assignment && card.held) stateBadge = `<span class="rac-state-badge rac-state-edited">${this._escapeHtml(t('settings.admin.roles_pending_edit'))}</span>`;
    else if (card.held) stateBadge = `<span class="rac-state-badge rac-state-held">${this._escapeHtml(t('settings.admin.roles_held'))}</span>`;

    let actionBtn = '';
    if (removed) {
      actionBtn = `<button type="button" class="btn-sm rac-card-undo-remove" data-role="${card.roleId}">${this._escapeHtml(t('settings.admin.roles_undo'))}</button>`;
    } else if (card.held) {
      actionBtn = `<button type="button" class="btn-sm rac-card-remove" data-role="${card.roleId}">${this._escapeHtml(t('settings.admin.roles_remove'))}</button>`;
    } else {
      actionBtn = `<button type="button" class="btn-sm rac-card-discard" data-role="${card.roleId}">${this._escapeHtml(t('settings.admin.roles_discard'))}</button>`;
    }

    let editToggle = '';
    if (!removed) {
      editToggle = `<button type="button" class="btn-sm rac-card-edit" data-role="${card.roleId}">${this._escapeHtml(t(expanded ? 'settings.admin.roles_collapse' : 'settings.admin.roles_configure'))}</button>`;
    }

    const editorHtml = expanded ? `
      <div class="rac-card-editor" data-role="${card.roleId}">
        ${isParentChannel ? `
          <label class="rac-perm-item" style="padding:6px 0;">
            <input type="checkbox" class="rac-card-applysubs" data-role="${card.roleId}"${applyToSubs ? ' checked' : ''}>
            <strong>${this._escapeHtml(t('settings.admin.roles_apply_to_subs'))}</strong>
          </label>
        ` : ''}
        <div class="rac-config-label">${this._escapeHtml(t('settings.admin.roles_level_label'))} <span style="font-weight:400;text-transform:none;letter-spacing:0">${this._escapeHtml(t('settings.admin.roles_level_max_hint', { maxLevel }))}</span></div>
        <div class="rac-config-row">
          <input type="number" class="rac-card-level" data-role="${card.roleId}" min="1" max="${maxLevel}" value="${effectiveLevel}" style="width:80px">
          <span class="rac-level-hint" style="font-size:0.75rem;color:var(--text-muted)">${this._escapeHtml(t('settings.admin.roles_preset_default', { level: card.defaultLevel }))}</span>
        </div>
        <div class="rac-config-label">${this._escapeHtml(t('settings.admin.roles_perms_label'))}</div>
        <div class="rac-perms-grid rac-card-perms" data-role="${card.roleId}">
          ${allPerms.map(p => {
            const checked = effectivePerms.includes(p);
            const callerHasPerm = callerIsAdmin || callerPerms.includes('*') || callerPerms.includes(p);
            const isAdminOnly = adminOnlyPerms.includes(p) && !callerIsAdmin;
            const isReadOnly = isAdminOnly || !callerHasPerm;
            const tooltip = isReadOnly
              ? t(isAdminOnly ? 'settings.admin.roles_owner_only' : 'settings.admin.roles_permission_unavailable')
              : '';
            return `<label class="rac-perm-item${isReadOnly ? ' disabled' : ''}${checked ? ' checked' : ''}"${tooltip ? ` title="${tooltip}"` : ''}>
              <input type="checkbox" data-perm="${p}" ${checked ? 'checked' : ''} ${isReadOnly ? 'disabled' : ''}>
              ${permLabels[p] || p}
            </label>`;
          }).join('')}
        </div>
      </div>
    ` : '';

    const lockedNotice = !card.held && !grantableIds.has(card.roleId)
      ? `<span class="rac-card-locked" title="${this._escapeHtml(t('settings.admin.roles_cannot_grant_level'))}">🔒</span>`
      : '';

    return `
      <div class="rac-role-card${dirty ? ' rac-card-dirty' : ''}${removed ? ' rac-card-removed' : ''}" data-role="${card.roleId}">
        <div class="rac-card-head">
          <span class="rac-role-dot" style="background:${this._safeColor(card.color, '#888')}"></span>
          <span class="rac-card-name">${this._escapeHtml(card.name)}</span>
          <span class="rac-card-level">Lv.${effectiveLevel}</span>
          ${stateBadge}
          ${lockedNotice}
          <span style="flex:1"></span>
          ${editToggle}
          ${actionBtn}
        </div>
        ${editorHtml}
      </div>
    `;
  };

  body.innerHTML = `
    <div class="rac-config-section">
      <div class="rac-config-label">${this._escapeHtml(t('settings.admin.roles_assigning_to', { name: user.displayName }))} (${this._escapeHtml(scopeLabel)})</div>
      <p class="rac-card-hint">${this._escapeHtml(t('settings.admin.roles_multi_hint'))}</p>
    </div>

    <div class="rac-config-section rac-roles-list">
      ${cards.length ? cards.map(renderCard).join('') : `<p class="rac-placeholder">${this._escapeHtml(t('settings.admin.roles_no_assigned'))}</p>`}
    </div>

    ${inheritedRoles.length ? `
    <div class="rac-config-section rac-inherited-section">
      <div class="rac-config-label" style="opacity:0.7;margin-top:4px">${this._escapeHtml(t('settings.admin.roles_inherited_label'))}</div>
      ${inheritedRoles.map(r => {
        const color = this._safeColor(r.color, '#888');
        return `<div class="rac-role-card rac-role-inherited">
          <div class="rac-card-head">
            <span class="rac-role-dot" style="background:${color}"></span>
            <span class="rac-card-name" style="opacity:0.8">${this._escapeHtml(r.name)}</span>
            <span class="rac-card-level">Lv.${r.level}</span>
            <span class="rac-card-locked" title="${this._escapeHtml(t('settings.admin.roles_inherited_title', { role: r._inheritedFrom }))}">↑ ${this._escapeHtml(r._inheritedFrom)}</span>
          </div>
        </div>`;
      }).join('')}
    </div>
    ` : ''}

    <div class="rac-config-section rac-add-role-section">
      <div class="rac-config-label">${this._escapeHtml(t('settings.admin.roles_add_label'))}</div>
      <div class="rac-config-row">
        <select class="rac-role-select" id="rac-add-role-dropdown" ${addableRoles.length ? '' : 'disabled'}>
          <option value="">${this._escapeHtml(t(addableRoles.length ? 'settings.admin.roles_select_to_add' : 'settings.admin.roles_no_addable'))}</option>
          ${addableRoles.map(r => `<option value="${r.id}">● ${this._escapeHtml(r.name)} (Lv.${r.level})</option>`).join('')}
        </select>
      </div>
    </div>
  `;

  // ── Wire up events ────────────────────────────────────
  const refreshSaveBtn = () => {
    const hasChanges = Object.values(this._racPendingChanges).some(p =>
      (p.assignments && Object.keys(p.assignments).length) ||
      (p.removals && p.removals.length)
    );
    document.getElementById('rac-save-btn').disabled = !hasChanges;
  };

  const ensurePending = () => {
    if (!this._racPendingChanges[key]) this._racPendingChanges[key] = { assignments: {}, removals: [] };
    return this._racPendingChanges[key];
  };

  const cleanupPendingIfEmpty = () => {
    const p = this._racPendingChanges[key];
    if (!p) return;
    const empty = (!p.assignments || Object.keys(p.assignments).length === 0) &&
                  (!p.removals || p.removals.length === 0);
    if (empty) delete this._racPendingChanges[key];
  };

  // Add-role dropdown
  const addDropdown = document.getElementById('rac-add-role-dropdown');
  if (addDropdown) {
    addDropdown.addEventListener('change', (e) => {
      const rid = parseInt(e.target.value, 10);
      if (!rid) return;
      const roleObj = this._racData.roles.find(r => r.id === rid);
      if (!roleObj) return;
      const p = ensurePending();
      p.assignments[rid] = {
        level: roleObj.level,
        customPerms: [...(roleObj.permissions || [])],
        applyToSubs: false
      };
      refreshSaveBtn();
      this._renderRacChannels();
      this._renderRacConfig();
    });
  }

  // Per-card buttons
  body.querySelectorAll('.rac-card-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      const rid = parseInt(btn.dataset.role, 10);
      const p = ensurePending();
      // If there was a pending edit (assignment) for a held role, drop it.
      if (p.assignments && p.assignments[rid]) delete p.assignments[rid];
      if (!p.removals.includes(rid)) p.removals.push(rid);
      cleanupPendingIfEmpty();
      refreshSaveBtn();
      this._renderRacChannels();
      this._renderRacConfig();
    });
  });

  body.querySelectorAll('.rac-card-undo-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      const rid = parseInt(btn.dataset.role, 10);
      const p = this._racPendingChanges[key];
      if (!p) return;
      p.removals = (p.removals || []).filter(id => id !== rid);
      cleanupPendingIfEmpty();
      refreshSaveBtn();
      this._renderRacChannels();
      this._renderRacConfig();
    });
  });

  body.querySelectorAll('.rac-card-discard').forEach(btn => {
    btn.addEventListener('click', () => {
      const rid = parseInt(btn.dataset.role, 10);
      const p = this._racPendingChanges[key];
      if (!p || !p.assignments) return;
      delete p.assignments[rid];
      cleanupPendingIfEmpty();
      refreshSaveBtn();
      this._renderRacChannels();
      this._renderRacConfig();
    });
  });

  body.querySelectorAll('.rac-card-edit').forEach(btn => {
    btn.addEventListener('click', () => {
      const rid = parseInt(btn.dataset.role, 10);
      const p = ensurePending();
      const card = cards.find(c => c.roleId === rid);
      if (!card) return;
      const collapsedKey = `${key}:${rid}`;
      if (p.assignments && p.assignments[rid]) {
        if (this._racCollapsed.has(collapsedKey)) {
          // Folded away with edits still pending: open it back up.
          this._racCollapsed.delete(collapsedKey);
        } else {
          // Collapse by dropping the assignment when nothing was changed from
          // the held state. With edits, or a pending add, keep them and just
          // fold the editor (#5607).
          const a = p.assignments[rid];
          const unchanged = card.held
            && a.level === card.heldLevel
            && JSON.stringify((a.customPerms || []).slice().sort()) === JSON.stringify((card.defaultPerms || []).slice().sort())
            && !a.applyToSubs;
          if (unchanged) delete p.assignments[rid];
          else this._racCollapsed.add(collapsedKey);
        }
      } else {
        this._racCollapsed.delete(collapsedKey);
        // Expand: seed an assignment from the current held values (or preset).
        p.assignments[rid] = {
          level: card.held ? card.heldLevel : card.defaultLevel,
          customPerms: [...(card.defaultPerms || [])],
          applyToSubs: false
        };
      }
      cleanupPendingIfEmpty();
      refreshSaveBtn();
      this._renderRacChannels();
      this._renderRacConfig();
    });
  });

  // Per-card editor controls
  body.querySelectorAll('.rac-card-level').forEach(input => {
    input.addEventListener('change', () => {
      const rid = parseInt(input.dataset.role, 10);
      let val = parseInt(input.value, 10);
      if (isNaN(val) || val < 1) val = 1;
      if (val > maxLevel) val = maxLevel;
      input.value = val;
      const p = ensurePending();
      if (!p.assignments[rid]) p.assignments[rid] = { level: val, customPerms: [], applyToSubs: false };
      else p.assignments[rid].level = val;
      refreshSaveBtn();
      this._renderRacChannels();
    });
  });

  body.querySelectorAll('.rac-card-applysubs').forEach(cb => {
    cb.addEventListener('change', () => {
      const rid = parseInt(cb.dataset.role, 10);
      const p = ensurePending();
      if (!p.assignments[rid]) return;
      p.assignments[rid].applyToSubs = cb.checked;
      refreshSaveBtn();
    });
  });

  body.querySelectorAll('.rac-card-perms input[type="checkbox"]:not([disabled])').forEach(cb => {
    cb.addEventListener('change', () => {
      const grid = cb.closest('.rac-card-perms');
      const rid = parseInt(grid.dataset.role, 10);
      const perm = cb.dataset.perm;
      const p = ensurePending();
      if (!p.assignments[rid]) {
        const card = cards.find(c => c.roleId === rid);
        p.assignments[rid] = {
          level: card ? (card.held ? card.heldLevel : card.defaultLevel) : 1,
          customPerms: card ? [...(card.defaultPerms || [])] : [],
          applyToSubs: false
        };
      }
      const a = p.assignments[rid];
      if (cb.checked) {
        if (!a.customPerms.includes(perm)) a.customPerms.push(perm);
      } else {
        a.customPerms = a.customPerms.filter(x => x !== perm);
      }
      cb.closest('.rac-perm-item').classList.toggle('checked', cb.checked);
      refreshSaveBtn();
      this._renderRacChannels();
    });
  });
},

_racSaveChanges() {
  const scopeKeys = Object.keys(this._racPendingChanges);
  if (scopeKeys.length === 0) return;

  // Flatten all pending changes into a list of socket calls. Each entry is
  // either { kind:'assign', userId, channelId, roleId, level, customPerms }
  // or { kind:'revoke', userId, channelId, roleId }.
  const ops = [];
  for (const key of scopeKeys) {
    const p = this._racPendingChanges[key];
    const [userIdStr, scope] = key.split(':');
    const userId = parseInt(userIdStr, 10);
    const channelId = scope === 'server' ? null : parseInt(scope, 10);

    (p.removals || []).forEach(roleId => {
      ops.push({ kind: 'revoke', userId, channelId, roleId });
    });
    Object.entries(p.assignments || {}).forEach(([rid, a]) => {
      const roleId = parseInt(rid, 10);
      ops.push({ kind: 'assign', userId, channelId, roleId, level: a.level, customPerms: a.customPerms || null });
      // Expand applyToSubs into per-sub-channel assigns.
      if (a.applyToSubs && channelId && this._racData) {
        const subs = this._racData.channels.filter(c => c.parentId === channelId);
        for (const sub of subs) {
          ops.push({ kind: 'assign', userId, channelId: sub.id, roleId, level: a.level, customPerms: a.customPerms || null });
        }
      }
    });
  }

  if (ops.length === 0) return;

  let completed = 0;
  const errors = [];
  const total = ops.length;

  const onDone = () => {
    if (errors.length) {
      this._showToast(t('settings.admin.roles_save_errors', { count: errors.length, error: errors[0] }), 'error');
    } else {
      this._showToast(t(total === 1 ? 'settings.admin.roles_changes_saved_one' : 'settings.admin.roles_changes_saved_other', { count: total }), 'success');
      document.getElementById('role-assign-center-modal').style.display = 'none';
    }
    this._racPendingChanges = {};
    document.getElementById('rac-save-btn').disabled = true;
    this._roleEmit('get-role-assignment-data', {}, (res) => {
      if (!res.error) {
        this._racData = res;
        this._renderRacUsers(document.getElementById('rac-user-search')?.value || '');
        this._renderRacChannels();
        this._renderRacConfig();
      }
    });
  };

  ops.forEach(op => {
    if (op.kind === 'revoke') {
      this._roleEmit('revoke-role', { userId: op.userId, roleId: op.roleId, channelId: op.channelId }, (res) => {
        completed++;
        if (res && res.error) errors.push(res.error);
        if (completed === total) onDone();
      });
    } else {
      this._roleEmit('assign-role', {
        userId: op.userId, roleId: op.roleId, channelId: op.channelId,
        customLevel: op.level, customPerms: op.customPerms
      }, (res) => {
        completed++;
        if (res && res.error) errors.push(res.error);
        if (completed === total) onDone();
      });
    }
  });
},

_initRoleAssignCenter() {
  // Cancel button
  document.getElementById('rac-cancel-btn')?.addEventListener('click', () => {
    this._racPendingChanges = {};
    document.getElementById('role-assign-center-modal').style.display = 'none';
  });

  // Save button
  document.getElementById('rac-save-btn')?.addEventListener('click', () => {
    this._racSaveChanges();
  });

  // Close on overlay (outside) click
  document.getElementById('role-assign-center-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'role-assign-center-modal') {
      this._racPendingChanges = {};
      document.getElementById('role-assign-center-modal').style.display = 'none';
    }
  });

  // Manage Roles button (admin only - opens main role management modal)
  document.getElementById('rac-manage-roles-btn')?.addEventListener('click', () => {
    document.getElementById('role-assign-center-modal').style.display = 'none';
    // _openRoleModal shows the modal first, then loads — ensures the sidebar
    // re-renders once roles arrive (fixes #5xxx: blank role list when opened from RAC).
    this._openRoleModal();
  });

  // User search
  document.getElementById('rac-user-search')?.addEventListener('input', (e) => {
    this._renderRacUsers(e.target.value);
  });
},

};
