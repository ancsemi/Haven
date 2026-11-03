const PERM_GROUPS = [
  { key: 'talk', perms: ['edit_own_messages', 'delete_own_messages', 'send_self_destruct', 'upload_files', 'use_voice', 'use_tts', 'view_history', 'mention_everyone', 'highlight_messages'] },
  { key: 'moderate', perms: ['delete_message', 'delete_lower_messages', 'pin_message', 'archive_messages', 'kick_user', 'mute_user', 'ban_user', 'ban_ip', 'read_only_override'] },
  { key: 'channels', perms: ['rename_channel', 'rename_sub_channel', 'set_channel_topic', 'manage_sub_channels', 'manage_channel_settings', 'create_channel', 'create_temp_channel', 'delete_channel'] },
  { key: 'people', perms: ['invite_users', 'view_all_members', 'view_channel_members', 'view_all_channels', 'promote_user', 'manage_display_names', 'manage_badges'] },
  { key: 'media', perms: ['manage_webhooks', 'use_ferry', 'manage_emojis', 'manage_stickers', 'manage_soundboard', 'manage_music_queue', 'manage_tags'] },
  { key: 'server', perms: ['manage_roles', 'manage_server', 'view_audit_log'] },
];

const GRID_PERMS = PERM_GROUPS.flatMap(g => g.perms);

const MEMBER_STARTER = [
  'edit_own_messages', 'delete_own_messages', 'send_self_destruct', 'upload_files',
  'use_voice', 'use_tts', 'view_history', 'view_channel_members',
];

export default {

_initPermMatrix() {
  this._permPanel = { roles: [], users: [], view: 'roles', userId: null, filter: '' };
  document.getElementById('open-role-editor-btn')?.addEventListener('click', () => this._openPermMatrix());
  // Changes wait for Save (app-perm-draft.js), so leaving asks first.
  document.getElementById('close-perm-matrix-btn')?.addEventListener('click', () => this._requestClosePermMatrix());
  document.getElementById('perm-matrix-overlay')?.addEventListener('click', (e) => {
    if (e.target.id === 'perm-matrix-overlay') this._requestClosePermMatrix();
  });
  // The corner close button and Escape hide the panel first, then say so:
  // with changes waiting, it comes back and asks.
  document.getElementById('perm-matrix-overlay')?.addEventListener('modal-dismiss', (e) => {
    if (!this._permDraftCount()) return;
    e.currentTarget.style.display = 'flex';
    if (!this._permCloseAsking) this._requestClosePermMatrix();
  });
  document.getElementById('perm-save-btn')?.addEventListener('click', () => this._savePermDraft());
  document.getElementById('perm-discard-btn')?.addEventListener('click', () => this._discardPermDraft());
  document.getElementById('perm-view-roles')?.addEventListener('click', () => this._setPermView('roles'));
  document.getElementById('perm-view-users')?.addEventListener('click', () => this._setPermView('users'));
  document.getElementById('perm-add-role-btn')?.addEventListener('click', () => this._addPermRole());
  document.getElementById('perm-open-classic-btn')?.addEventListener('click', async () => {
    if (await this._requestClosePermMatrix()) this._openRoleModal();
  });
  // A click anywhere in a box's cell ticks the box, not only on the box itself.
  document.getElementById('perm-matrix-table')?.addEventListener('click', (e) => {
    if (e.target.closest('input, label, button')) return;
    const box = e.target.closest('td')?.querySelector('input[type="checkbox"]:not(:disabled)');
    if (box) box.click();
  });
  document.getElementById('perm-user-search')?.addEventListener('input', (e) => {
    this._permPanel.filter = e.target.value || '';
    this._renderPermUsersList();
  });
  this.socket.on('roles-updated', () => {
    const ov = document.getElementById('perm-matrix-overlay');
    if (ov && ov.style.display !== 'none') this._loadPermPanel();
  });
},

_closePermMatrix() {
  const ov = document.getElementById('perm-matrix-overlay');
  if (ov) ov.style.display = 'none';
},

_openPermMatrix() {
  const ov = document.getElementById('perm-matrix-overlay');
  if (!ov) return;
  ov.style.display = 'flex';
  this._permDraftReset();
  this._setPermView(this._permPanel.view || 'roles');
  this._permDraftChanged();
  this._loadPermPanel();
},

_setPermView(view) {
  this._permPanel.view = view;
  const rolesBtn = document.getElementById('perm-view-roles');
  const usersBtn = document.getElementById('perm-view-users');
  rolesBtn?.classList.toggle('is-active', view === 'roles');
  usersBtn?.classList.toggle('is-active', view === 'users');
  const rolesPane = document.getElementById('perm-roles-pane');
  const usersPane = document.getElementById('perm-users-pane');
  if (rolesPane) rolesPane.hidden = view !== 'roles';
  if (usersPane) usersPane.hidden = view !== 'users';
  const lead = document.getElementById('perm-matrix-lead');
  if (lead) lead.textContent = t(view === 'users' ? 'settings.admin.perm_matrix.lead_users' : 'settings.admin.perm_matrix.lead_roles');
  // Draw the pane being shown: the members are listed straight away, not
  // only once something is typed in the search box.
  if (view === 'users') {
    this._renderPermUsersList();
    this._renderPermUserDetail();
  } else {
    this._renderPermMatrix();
  }
},

_applyPermPanel({ roles, users } = {}) {
  if (Array.isArray(roles)) {
    this._permPanel.roles = roles.filter(r => Number(r.level) > 0);
  }
  if (Array.isArray(users)) {
    // Alphabetical by the name people see, ignoring case.
    const nameOf = (u) => u.displayName || u.username || '';
    this._permPanel.users = [...users].sort((a, b) => nameOf(a).localeCompare(nameOf(b), undefined, { sensitivity: 'base' }));
    const stillThere = this._permPanel.users.some(u => u.id === this._permPanel.userId);
    if (!this._permPanel.userId || !stillThere) {
      const pick = this._permPanel.users.find(u => !u.isAdmin && u.id !== this.user?.id)
        || this._permPanel.users[0];
      this._permPanel.userId = pick ? pick.id : null;
    }
  }
  if (this._permPanel.view === 'users') {
    this._renderPermUsersList();
    this._renderPermUserDetail();
  } else {
    this._renderPermMatrix();
  }
},

_loadPermPanel() {
  this._roleEmit('get-roles', {}, (res) => {
    if (res && !res.error) this._applyPermPanel({ roles: res.roles || [] });
  });
  const sock = this.socket;
  if (!sock) return;
  const onPanel = (res) => {
    if (!res || res.error) {
      if (res?.error) this._showToast(res.error, 'error');
      this._loadPermUsersFallback();
      return;
    }
    this._applyPermPanel({ roles: res.roles || [], users: res.users || [] });
  };
  if (typeof sock.timeout === 'function') {
    sock.timeout(8000).emit('get-perm-panel', {}, (err, res) => {
      if (err) { this._loadPermUsersFallback(); return; }
      onPanel(res);
    });
  } else {
    sock.emit('get-perm-panel', {}, onPanel);
  }
},

_loadPermUsersFallback() {
  this.socket?.emit('get-all-members', {}, (res) => {
    const rows = res?.members || res?.users;
    if (!res || res.error || !Array.isArray(rows)) return;
    this._applyPermPanel({
      users: rows.map(u => ({
        id: u.id,
        username: u.username,
        displayName: u.displayName || u.username,
        avatar: u.avatar,
        avatarShape: u.avatarShape || u.avatar_shape || 'circle',
        isAdmin: !!(u.isAdmin ?? u.is_admin),
        roleIds: (u.roles || []).map(r => r.id),
        permissions: u.permissions || [],
      })),
    });
  });
},

// Every role in the grid: server roles, then channel roles (given in a
// channel, so what is ticked applies only where someone holds them).
_matrixRoles() {
  const roles = (this._permPanel.roles || []).filter(r => Number(r.level) > 0);
  const server = roles.filter(r => (r.scope || 'server') === 'server');
  return [...server, ...roles.filter(r => r.scope === 'channel')];
},

// The roles a person can be given server-wide from the Users tab.
_serverMatrixRoles() {
  return this._matrixRoles().filter(r => (r.scope || 'server') === 'server');
},

_sortedGroupPerms(group) {
  return [...(group.perms || [])].sort((a, b) =>
    t(`permissions.${a}`).localeCompare(t(`permissions.${b}`), undefined, { sensitivity: 'base' })
  );
},

_renderPermMatrix() {
  const table = document.getElementById('perm-matrix-table');
  if (!table) return;
  const roles = this._matrixRoles();
  const adminName = t('settings.admin.perm_matrix.admin');
  const esc = (s) => this._escapeHtml(String(s ?? ''));

  let head = `<th class="perm-matrix-perm">${esc(t('settings.admin.perm_matrix.permission'))}</th>`;
  for (const role of roles) {
    head += `<th class="perm-matrix-role">
      <div class="perm-matrix-role-top">
        <button type="button" class="perm-matrix-edit" data-edit-role="${role.id}" title="${esc(t('settings.admin.perm_matrix.edit_role'))}">
          <span class="perm-matrix-swatch" style="background:${esc(role.color || '#888')}"></span>
          <span class="perm-matrix-role-name">${esc(role.name)}</span>
          <span class="perm-matrix-level">${esc(t('settings.admin.perm_matrix.level', { level: role.level }))}</span>
          <span class="perm-matrix-edit-icon" aria-hidden="true">✎</span>
        </button>
        <button type="button" class="perm-matrix-remove" data-remove-role="${role.id}" title="${esc(t('settings.admin.perm_matrix.remove_role'))}">−</button>
      </div>
      ${role.scope === 'channel'
        ? `<span class="perm-matrix-auto muted-text" title="${esc(t('settings.admin.perm_matrix.channel_role_hint'))}">${esc(t('settings.admin.perm_matrix.channel_role'))}</span>`
        : `<label class="perm-matrix-auto${(this._draftAutoRoleId() === role.id) !== !!role.auto_assign ? ' perm-pending' : ''}">
        <input type="radio" name="perm-auto-role" value="${role.id}" ${this._draftAutoRoleId() === role.id ? 'checked' : ''}>
        ${esc(t('settings.admin.perm_matrix.auto_assign'))}
      </label>`}
    </th>`;
  }
  head += `<th class="perm-matrix-role perm-matrix-admin">
    <div class="perm-matrix-role-top">
      <span class="perm-matrix-swatch" style="background:#e74c3c"></span>
      <span class="perm-matrix-role-name">${esc(adminName)}</span>
    </div>
    <span class="perm-matrix-auto muted-text">${esc(t('settings.admin.perm_matrix.host'))}</span>
  </th>`;

  let body = '';
  for (const group of PERM_GROUPS) {
    body += `<tr class="perm-matrix-group"><td colspan="${roles.length + 2}">${esc(t(`settings.admin.perm_matrix.group_${group.key}`))}</td></tr>`;
    for (const perm of this._sortedGroupPerms(group)) {
      body += `<tr><th scope="row">${esc(t(`permissions.${perm}`))}</th>`;
      for (const role of roles) {
        const on = this._draftRolePerms(role).has(perm);
        const pending = on !== (role.permissions || []).includes(perm);
        body += `<td${pending ? ' class="perm-pending"' : ''}><input type="checkbox" data-role="${role.id}" data-perm="${perm}" ${on ? 'checked' : ''}></td>`;
      }
      body += `<td><input type="checkbox" checked disabled></td></tr>`;
    }
  }

  table.innerHTML = `<thead><tr>${head}</tr></thead><tbody>${body}</tbody>`;

  table.querySelectorAll('input[data-role][data-perm]').forEach(box => {
    box.addEventListener('change', () => this._draftToggleRolePerm(parseInt(box.dataset.role, 10), box.dataset.perm, box.checked));
  });
  table.querySelectorAll('input[name="perm-auto-role"]').forEach(radio => {
    radio.addEventListener('change', () => {
      if (radio.checked) this._draftSetAutoRole(parseInt(radio.value, 10));
    });
  });
  // The full role editor opens on top, so ticks waiting for Save stay put;
  // when it saves, roles-updated redraws this table with the new name,
  // level and color.
  table.querySelectorAll('[data-edit-role]').forEach(btn => {
    btn.addEventListener('click', () => {
      this._selectedRoleId = parseInt(btn.dataset.editRole, 10);
      this._openRoleModal();
    });
  });
  table.querySelectorAll('[data-remove-role]').forEach(btn => {
    btn.addEventListener('click', () => this._removePermRole(parseInt(btn.dataset.removeRole, 10)));
  });
},

async _addPermRole() {
  const name = await this._showPromptModal(
    t('settings.admin.perm_matrix.add_role'),
    t('settings.admin.perm_matrix.add_role_hint'),
    ''
  );
  if (!name || !name.trim()) return;
  this._roleEmit('create-role', {
    name: name.trim().slice(0, 30),
    level: 10,
    scope: 'server',
    color: '#8b6ff0',
    permissions: MEMBER_STARTER,
  }, (res) => {
    if (res?.error) { this._showToast(res.error, 'error'); return; }
    this._showToast(t('settings.admin.roles_created'), 'success');
    this._loadPermPanel();
  });
},

async _removePermRole(roleId) {
  const role = this._matrixRoles().find(r => r.id === roleId);
  if (!role) return;
  if (this._matrixRoles().length <= 1) {
    this._showToast(t('settings.admin.perm_matrix.keep_one'), 'error');
    return;
  }
  const ok = await this._showConfirmModal(
    t('settings.admin.perm_matrix.remove_role'),
    t('settings.admin.perm_matrix.remove_role_confirm', { name: role.name })
  );
  if (!ok) return;
  // Pending changes for a role that is gone would fail the next Save.
  const d = this._permDraft();
  d.rolePerms.delete(roleId);
  if (d.autoRole === roleId) d.autoRole = null;
  for (const held of d.userRoles.values()) held.delete(roleId);
  this._permDraftChanged();
  this._roleEmit('delete-role', { roleId }, (res) => {
    if (res?.error) { this._showToast(res.error, 'error'); return; }
    this._loadPermPanel();
  });
},

_renderPermUsersList() {
  const list = document.getElementById('perm-user-list');
  if (!list) return;
  const q = (this._permPanel.filter || '').trim().toLowerCase();
  const users = (this._permPanel.users || []).filter(u => {
    if (!q) return true;
    return (u.displayName || '').toLowerCase().includes(q) || (u.username || '').toLowerCase().includes(q);
  });
  const esc = (s) => this._escapeHtml(String(s ?? ''));
  if (!users.length) {
    list.innerHTML = `<p class="muted-text" style="padding:12px">${esc(t('settings.admin.perm_matrix.no_users'))}</p>`;
    return;
  }
  if (this._permPanel.userId && !users.some(u => u.id === this._permPanel.userId)) {
    this._permPanel.userId = users[0].id;
  }
  if (!this._permPanel.userId && users[0]) this._permPanel.userId = users[0].id;
  list.innerHTML = users.map(u => {
    const active = u.id === this._permPanel.userId ? ' is-active' : '';
    const badge = u.isAdmin
      ? t('settings.admin.perm_matrix.admin')
      : (this._serverMatrixRoles().filter(r => (u.roleIds || []).includes(r.id)).map(r => r.name).join(', ') || t('settings.admin.perm_matrix.no_role'));
    return `<button type="button" class="perm-user-row${active}" data-user="${u.id}">
      <span class="perm-user-name">${esc(u.displayName)}</span>
      <span class="perm-user-badge">${esc(badge)}</span>
    </button>`;
  }).join('');
  list.querySelectorAll('[data-user]').forEach(btn => {
    btn.addEventListener('click', () => {
      this._permPanel.userId = parseInt(btn.dataset.user, 10);
      this._renderPermUsersList();
      this._renderPermUserDetail();
    });
  });
},

_renderPermUserDetail() {
  const box = document.getElementById('perm-user-detail');
  if (!box) return;
  const user = (this._permPanel.users || []).find(u => u.id === this._permPanel.userId);
  const esc = (s) => this._escapeHtml(String(s ?? ''));
  if (!user) {
    box.innerHTML = `<p class="muted-text">${esc(t('settings.admin.perm_matrix.pick_user'))}</p>`;
    return;
  }
  const self = user.id === this.user?.id;
  const locked = user.isAdmin || self;
  const roles = this._serverMatrixRoles();
  const perms = user.permissions || [];
  const allOn = perms.includes('*') || user.isAdmin;

  const heldRoles = this._draftUserRoleIds(user);
  const chips = roles.map(r => {
    const on = heldRoles.has(r.id);
    const pending = on !== (user.roleIds || []).includes(r.id);
    return `<button type="button" class="perm-user-chip${on ? ' is-on' : ''}${pending ? ' perm-pending' : ''}" data-set-role="${r.id}" ${locked ? 'disabled' : ''}>${esc(r.name)} <span class="perm-user-chip-level">${esc(t('settings.admin.perm_matrix.level', { level: r.level }))}</span></button>`;
  }).join('');
  // Exceptions made for this one person (the server works them out), so a
  // box that disagrees with their roles says why.
  const exceptions = user.exceptions || {};

  let rows = '';
  for (const group of PERM_GROUPS) {
    rows += `<div class="perm-user-group">${esc(t(`settings.admin.perm_matrix.group_${group.key}`))}</div>`;
    for (const perm of this._sortedGroupPerms(group)) {
      const draft = this._draftUserPerm(user, perm, allOn || perms.includes(perm));
      const on = draft.on;
      const exception = !locked && Object.prototype.hasOwnProperty.call(exceptions, perm);
      const tag = exception
        ? `<span class="perm-user-exception" title="${esc(t('settings.admin.perm_matrix.exception_hint'))}">${esc(t(exceptions[perm] ? 'settings.admin.perm_matrix.exception_added' : 'settings.admin.perm_matrix.exception_removed'))}</span>`
        : '';
      rows += `<label class="perm-user-perm${exception ? ' is-exception' : ''}${draft.pending ? ' perm-pending' : ''}">
        <input type="checkbox" data-user-perm="${perm}" ${on ? 'checked' : ''} ${locked ? 'disabled' : ''}>
        <span>${esc(t(`permissions.${perm}`))}</span>${tag}
      </label>`;
    }
  }

  const note = user.isAdmin
    ? t('settings.admin.perm_matrix.user_is_host')
    : (self ? t('settings.admin.perm_matrix.user_is_you') : t('settings.admin.perm_matrix.user_hint'));

  const hasExceptions = !locked && Object.keys(exceptions).length > 0;
  box.innerHTML = `
    <div class="perm-user-head">
      <h4>${esc(user.displayName)}</h4>
      <p class="muted-text">${esc(note)}</p>
      <div class="perm-user-chips">${chips}</div>
      ${hasExceptions ? `<button type="button" class="btn-sm perm-user-reset" data-reset-user>${esc(t('settings.admin.perm_matrix.reset_to_roles'))}</button>` : ''}
    </div>
    <div class="perm-user-perms">${rows}</div>`;
  box.querySelector('[data-reset-user]')?.addEventListener('click', () => this._resetUserPerms(user));

  box.querySelectorAll('[data-set-role]').forEach(btn => {
    btn.addEventListener('click', () => this._draftToggleUserRole(user, parseInt(btn.dataset.setRole, 10)));
  });
  box.querySelectorAll('[data-user-perm]').forEach(boxEl => {
    const perm = boxEl.dataset.userPerm;
    boxEl.addEventListener('change', () => this._draftSetUserPerm(user, perm, boxEl.checked, allOn || perms.includes(perm)));
  });
},

async _resetUserPerms(user) {
  const ok = await this._showConfirmModal(
    t('settings.admin.perm_matrix.reset_confirm', { name: user.displayName }), '',
    { confirmLabel: t('settings.admin.perm_matrix.reset_to_roles') }
  );
  if (!ok) return;
  // Their pending boxes go too, or Save would put the exceptions straight back.
  if (this._permDraft().userPerms.delete(user.id)) this._permDraftChanged();
  this._roleEmit('reset-user-server-perms', { userId: user.id }, (res) => {
    if (res?.error) { this._showToast(res.error, 'error'); return; }
    this._showToast(t('settings.admin.perm_matrix.reset_done', { name: user.displayName }), 'success');
    this._loadPermPanel();
  });
},

_saveUserPerms(user, detailRoot) {
  const boxes = detailRoot.querySelectorAll('[data-user-perm]');
  const permissions = [];
  boxes.forEach(b => { if (b.checked) permissions.push(b.dataset.userPerm); });
  // `known` is what the grid shows; the server keeps every other permission
  // (transfer_admin, anything added later) exactly as it is.
  this._roleEmit('set-user-server-perms', { userId: user.id, permissions, known: GRID_PERMS }, (res) => {
    if (res?.error) {
      this._showToast(res.error, 'error');
      this._loadPermPanel();
      return;
    }
    user.permissions = res.permissions || permissions;
    if (res.roleIds) user.roleIds = res.roleIds;
    // Fetched again so the exception marks follow the change.
    this._loadPermPanel();
  });
},

};
