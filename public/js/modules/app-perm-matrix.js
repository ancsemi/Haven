const PERM_GROUPS = [
  { key: 'talk', perms: ['edit_own_messages', 'delete_own_messages', 'upload_files', 'use_voice', 'use_tts', 'view_history', 'mention_everyone'] },
  { key: 'moderate', perms: ['delete_message', 'delete_lower_messages', 'pin_message', 'archive_messages', 'kick_user', 'mute_user', 'ban_user', 'ban_ip', 'read_only_override'] },
  { key: 'channels', perms: ['rename_channel', 'rename_sub_channel', 'set_channel_topic', 'manage_sub_channels', 'manage_channel_settings', 'create_channel', 'create_temp_channel', 'delete_channel'] },
  { key: 'people', perms: ['invite_users', 'view_all_members', 'view_channel_members', 'view_all_channels', 'promote_user', 'manage_display_names'] },
  { key: 'media', perms: ['manage_webhooks', 'use_ferry', 'manage_emojis', 'manage_stickers', 'manage_soundboard', 'manage_music_queue'] },
  { key: 'server', perms: ['manage_roles', 'manage_server', 'view_audit_log'] },
];

const MEMBER_STARTER = [
  'edit_own_messages', 'delete_own_messages', 'upload_files',
  'use_voice', 'use_tts', 'view_history', 'view_channel_members',
];

export default {

_initPermMatrix() {
  this._permPanel = { roles: [], users: [], view: 'roles', userId: null, filter: '' };
  document.getElementById('open-role-editor-btn')?.addEventListener('click', () => this._openPermMatrix());
  document.getElementById('close-perm-matrix-btn')?.addEventListener('click', () => this._closePermMatrix());
  document.getElementById('perm-matrix-overlay')?.addEventListener('click', (e) => {
    if (e.target.id === 'perm-matrix-overlay') this._closePermMatrix();
  });
  document.getElementById('perm-view-roles')?.addEventListener('click', () => this._setPermView('roles'));
  document.getElementById('perm-view-users')?.addEventListener('click', () => this._setPermView('users'));
  document.getElementById('perm-add-role-btn')?.addEventListener('click', () => this._addPermRole());
  document.getElementById('perm-open-classic-btn')?.addEventListener('click', () => {
    this._closePermMatrix();
    this._openRoleModal();
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
  this._setPermView(this._permPanel.view || 'roles');
  this._loadPermPanel();
  this._roleEmit('get-admin-role-display', {}, (res) => {
    if (res && res.display) this._adminRoleDisplay = res.display;
    if (this._matrixRoles().length && this._permPanel.view === 'roles') this._renderPermMatrix();
  });
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
},

_applyPermPanel({ roles, users } = {}) {
  if (Array.isArray(roles)) {
    this._permPanel.roles = roles.filter(r => (r.scope || 'server') === 'server' && Number(r.level) > 0);
  }
  if (Array.isArray(users)) {
    this._permPanel.users = users;
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

_matrixRoles() {
  return (this._permPanel.roles || []).filter(r => (r.scope || 'server') === 'server' && Number(r.level) > 0);
},

_sortedGroupPerms(group) {
  return [...(group.perms || [])].sort((a, b) =>
    t('permissions.' + a).localeCompare(t('permissions.' + b), undefined, { sensitivity: 'base' })
  );
},

_renderPermMatrix() {
  const table = document.getElementById('perm-matrix-table');
  if (!table) return;
  const roles = this._matrixRoles();
  const adminName = this._adminRoleDisplay?.name || t('settings.admin.perm_matrix.admin');
  const esc = (s) => this._escapeHtml(String(s ?? ''));

  let head = `<th class="perm-matrix-perm">${esc(t('settings.admin.perm_matrix.permission'))}</th>`;
  for (const role of roles) {
    head += `<th class="perm-matrix-role">
      <div class="perm-matrix-role-top">
        <span class="perm-matrix-swatch" style="background:${esc(role.color || '#888')}"></span>
        <span class="perm-matrix-role-name">${esc(role.name)}</span>
        <button type="button" class="perm-matrix-remove" data-remove-role="${role.id}" title="${esc(t('settings.admin.perm_matrix.remove_role'))}">−</button>
      </div>
      <label class="perm-matrix-auto">
        <input type="radio" name="perm-auto-role" value="${role.id}" ${role.auto_assign ? 'checked' : ''}>
        ${esc(t('settings.admin.perm_matrix.auto_assign'))}
      </label>
    </th>`;
  }
  head += `<th class="perm-matrix-role perm-matrix-admin">
    <div class="perm-matrix-role-top">
      <span class="perm-matrix-swatch" style="background:${esc(this._adminRoleDisplay?.color || '#e74c3c')}"></span>
      <span class="perm-matrix-role-name">${esc(adminName)}</span>
    </div>
    <span class="perm-matrix-auto muted-text">${esc(t('settings.admin.perm_matrix.host'))}</span>
  </th>`;

  let body = '';
  for (const group of PERM_GROUPS) {
    body += `<tr class="perm-matrix-group"><td colspan="${roles.length + 2}">${esc(t('settings.admin.perm_matrix.group_' + group.key))}</td></tr>`;
    for (const perm of this._sortedGroupPerms(group)) {
      body += `<tr><th scope="row">${esc(t('permissions.' + perm))}</th>`;
      for (const role of roles) {
        const on = (role.permissions || []).includes(perm);
        body += `<td><input type="checkbox" data-role="${role.id}" data-perm="${perm}" ${on ? 'checked' : ''}></td>`;
      }
      body += `<td><input type="checkbox" checked disabled></td></tr>`;
    }
  }

  table.innerHTML = `<thead><tr>${head}</tr></thead><tbody>${body}</tbody>`;

  table.querySelectorAll('input[data-role][data-perm]').forEach(box => {
    box.addEventListener('change', () => this._toggleRolePerm(parseInt(box.dataset.role, 10), box.dataset.perm, box.checked, box));
  });
  table.querySelectorAll('input[name="perm-auto-role"]').forEach(radio => {
    radio.addEventListener('change', () => {
      if (radio.checked) this._setAutoAssign(parseInt(radio.value, 10));
    });
  });
  table.querySelectorAll('[data-remove-role]').forEach(btn => {
    btn.addEventListener('click', () => this._removePermRole(parseInt(btn.dataset.removeRole, 10)));
  });
},

_toggleRolePerm(roleId, perm, allowed, box) {
  const role = this._matrixRoles().find(r => r.id === roleId);
  if (!role) return;
  const next = new Set(role.permissions || []);
  if (allowed) next.add(perm);
  else next.delete(perm);
  this._roleEmit('update-role', { roleId, permissions: [...next] }, (res) => {
    if (res?.error) {
      if (box) box.checked = !allowed;
      this._showToast(res.error, 'error');
      return;
    }
    role.permissions = [...next];
    if (res?.roles) {
      const fresh = res.roles.find(r => r.id === roleId);
      if (fresh) role.permissions = fresh.permissions || [...next];
    }
  });
},

_setAutoAssign(roleId) {
  this._roleEmit('update-role', { roleId, autoAssign: true }, (res) => {
    if (res?.error) {
      this._showToast(res.error, 'error');
      this._loadPermPanel();
      return;
    }
    for (const role of this._permPanel.roles) role.auto_assign = role.id === roleId ? 1 : 0;
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
      : (this._matrixRoles().find(r => (u.roleIds || []).includes(r.id))?.name || t('settings.admin.perm_matrix.no_role'));
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
  const roles = this._matrixRoles();
  const perms = user.permissions || [];
  const allOn = perms.includes('*') || user.isAdmin;

  const chips = roles.map(r => {
    const on = (user.roleIds || []).includes(r.id);
    return `<button type="button" class="perm-user-chip${on ? ' is-on' : ''}" data-set-role="${r.id}" ${locked ? 'disabled' : ''}>${esc(r.name)}</button>`;
  }).join('');

  let rows = '';
  for (const group of PERM_GROUPS) {
    rows += `<div class="perm-user-group">${esc(t('settings.admin.perm_matrix.group_' + group.key))}</div>`;
    for (const perm of this._sortedGroupPerms(group)) {
      const on = allOn || perms.includes(perm);
      rows += `<label class="perm-user-perm">
        <input type="checkbox" data-user-perm="${perm}" ${on ? 'checked' : ''} ${locked ? 'disabled' : ''}>
        <span>${esc(t('permissions.' + perm))}</span>
      </label>`;
    }
  }

  const note = user.isAdmin
    ? t('settings.admin.perm_matrix.user_is_host')
    : (self ? t('settings.admin.perm_matrix.user_is_you') : t('settings.admin.perm_matrix.user_hint'));

  box.innerHTML = `
    <div class="perm-user-head">
      <h4>${esc(user.displayName)}</h4>
      <p class="muted-text">${esc(note)}</p>
      <div class="perm-user-chips">${chips}</div>
    </div>
    <div class="perm-user-perms">${rows}</div>`;

  box.querySelectorAll('[data-set-role]').forEach(btn => {
    btn.addEventListener('click', () => this._setUserRole(user.id, parseInt(btn.dataset.setRole, 10)));
  });
  box.querySelectorAll('[data-user-perm]').forEach(boxEl => {
    boxEl.addEventListener('change', () => this._saveUserPerms(user, box));
  });
},

_setUserRole(userId, roleId) {
  this._roleEmit('set-user-server-role', { userId, roleId }, (res) => {
    if (res?.error) { this._showToast(res.error, 'error'); return; }
    const user = this._permPanel.users.find(u => u.id === userId);
    if (user) {
      user.roleIds = res.roleIds || [roleId];
      user.permissions = res.permissions || [];
    }
    this._renderPermUsersList();
    this._renderPermUserDetail();
  });
},

_saveUserPerms(user, detailRoot) {
  const boxes = detailRoot.querySelectorAll('[data-user-perm]');
  const permissions = [];
  boxes.forEach(b => { if (b.checked) permissions.push(b.dataset.userPerm); });
  this._roleEmit('set-user-server-perms', { userId: user.id, permissions }, (res) => {
    if (res?.error) {
      this._showToast(res.error, 'error');
      this._loadPermPanel();
      return;
    }
    user.permissions = res.permissions || permissions;
    if (res.roleIds) user.roleIds = res.roleIds;
  });
},

};
