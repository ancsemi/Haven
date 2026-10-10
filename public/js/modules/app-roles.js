// Roles: the role editor (permissions, level, colours, members, channel
// access) and per-channel roles.

import { ALL_PERMS, ADMIN_ONLY_PERMS, PERM_LABELS } from './perm-catalog.js?v=4.17.23';

export default {

// ── Role Management ───────────────────────────────────
// ═══════════════════════════════════════════════════════

// Every role-editor emit that expects an ack goes through this wrapper. A
// server that predates an event never sends the ack, so the plain callback
// form waits forever and the UI does nothing: no toast, no error, nothing.
// That is exactly what happens on partially-updated self-hosts (new public/
// files served by an old server.js asked for an event it doesn't know yet).
// Surface it as an actionable error instead.
_roleEmit(event, payload, cb) {
  this.socket.timeout(10000).emit(event, payload, (err, res) => {
    if (err) { this._showToast(t('toasts.role_server_no_response'), 'error'); return; }
    if (typeof cb === 'function') cb(res);
  });
},

_initRoleManagement() {
  this._allRoles = [];
  this._selectedRoleId = null;

  document.getElementById('close-role-modal-btn')?.addEventListener('click', () => {
    document.getElementById('role-modal').style.display = 'none';
  });
  // New roles start from a template (moderator, helper, group...) so the
  // permission set does not have to be ticked box by box every time.
  document.getElementById('create-role-btn')?.addEventListener('click', () => this._openRoleTemplatePicker());
  document.getElementById('post-role-menu-btn')?.addEventListener('click', () => this._openRoleMenuBuilder());

  // Assign role modal handlers
  document.getElementById('cancel-assign-role-btn')?.addEventListener('click', () => {
    document.getElementById('assign-role-modal').style.display = 'none';
  });
  document.getElementById('confirm-assign-role-btn')?.addEventListener('click', () => {
    const modal = document.getElementById('assign-role-modal');
    const userId = parseInt(modal.dataset.userId, 10);
    const scope = document.getElementById('assign-role-scope').value;
    if (!userId) return;
    const channelId = scope !== 'server' ? parseInt(scope, 10) : null;

    // Multi-role: gather every checked role and diff against currently held
    // roles for this scope. Assign the new ones, revoke the unchecked ones.
    const checked = new Set(
      Array.from(document.querySelectorAll('#assign-role-checkboxes .assign-role-checkbox:checked'))
        .map(el => parseInt(el.value, 10))
        .filter(id => Number.isInteger(id))
    );
    const held = new Set(
      (this._assignRoleHeldRoles || [])
        .filter(r => (channelId === null && (r.channel_id === null || r.channel_id === undefined))
                   || (channelId !== null && r.channel_id === channelId))
        .map(r => r.id)
    );
    const toAssign = [...checked].filter(id => !held.has(id));
    const toRevoke = [...held].filter(id => !checked.has(id));

    if (toAssign.length === 0 && toRevoke.length === 0) {
      modal.style.display = 'none';
      return;
    }

    let pending = toAssign.length + toRevoke.length;
    let firstError = null;
    const finish = () => {
      if (firstError) { this._showToast(firstError, 'error'); return; }
      this._showToast(t('settings.admin.roles_assigned'), 'success');
      modal.style.display = 'none';
    };

    toAssign.forEach(roleId => {
      this._roleEmit('assign-role', { userId, roleId, channelId }, (res) => {
        if (res && res.error && !firstError) firstError = res.error;
        if (--pending === 0) finish();
      });
    });
    toRevoke.forEach(roleId => {
      this._roleEmit('revoke-role', { userId, roleId, channelId }, (res) => {
        if (res && res.error && !firstError) firstError = res.error;
        if (--pending === 0) finish();
      });
    });
  });

  // Listen for role updates
  this.socket.on('roles-updated', () => this._loadRoles());

  // Reset roles to default
  document.getElementById('reset-roles-btn')?.addEventListener('click', () => {
    if (!confirm(t('settings.admin.roles_reset_confirm'))) return;
    this._roleEmit('reset-roles-to-default', {}, (res) => {
      if (res.error) { this._showToast(res.error, 'error'); return; }
      this._showToast(t('settings.admin.roles_reset_success'), 'success');
      this._selectedRoleId = null;
      this._loadRoles();
    });
  });

  // Initialize centralized role assignment 3-pane modal
  this._initRoleAssignCenter();

  // Donors "thank you" modal
  this._initDonorsModal();
},

_loadRoles(cb) {
  this._roleEmit('get-roles', {}, (res) => {
    if (res.error) return;
    this._allRoles = res.roles || [];
    this._renderRolesPreview();
    if (document.getElementById('role-modal').style.display !== 'none') {
      this._renderRoleSidebar();
      this._renderRoleDetail();   // refresh detail panel so checkboxes reflect server state
    }
    if (typeof cb === 'function') cb();
  });
},

_renderRolesPreview() {
  const container = document.getElementById('roles-list-preview');
  if (!container) return;
  if (this._allRoles.length === 0) {
    container.innerHTML = `<p class="muted-text">${t('settings.admin.roles_no_custom')}</p>`;
    return;
  }
  container.innerHTML = this._allRoles.map(r =>
    `<div class="role-preview-item">
      <span class="role-color-dot" style="background:${this._roleFill(r, '#aaa')}"></span>
      <span>${this._escapeHtml(r.name)}${r.auto_assign ? ` <span title="${t('settings.admin.role_form.auto_assign')}" style="font-size:0.625rem;opacity:0.6">⚡</span>` : ''}</span>
      <span class="muted-text" style="font-size:0.6875rem;margin-left:auto">Lv.${r.level}</span>
    </div>`
  ).join('');
  // Keep the "channel creator role" picker in sync with the role list (#5461)
  this._renderChannelCreatorRoleSelect();
},

// (#5461) Build the "Channel creator role" dropdown from the current roles and
// select the saved value. 'default' = highest channel-scoped role (pre-5461
// behavior), 'none' = no auto-grant, or a specific role id.
_renderChannelCreatorRoleSelect() {
  const sel = document.getElementById('channel-creator-role-select');
  if (!sel) return;
  const roles = this._allRoles || [];
  const saved = (this.serverSettings && typeof this.serverSettings.channel_creator_role === 'string')
    ? this.serverSettings.channel_creator_role.trim() : '';
  const value = (saved === '') ? 'default' : saved;

  sel.innerHTML =
    `<option value="default">${this._escapeHtml(t('settings.admin.channel_creator_role_default'))}</option>` +
    `<option value="none">${this._escapeHtml(t('settings.admin.channel_creator_role_none'))}</option>` +
    roles.map(r => {
      const scope = r.scope === 'channel' ? 'channel' : 'server';
      return `<option value="${r.id}">${this._escapeHtml(r.name)} (${scope}, Lv.${r.level})</option>`;
    }).join('');

  // Fall back to Default if the saved role was since deleted.
  const has = Array.from(sel.options).some(o => o.value === String(value));
  sel.value = has ? String(value) : 'default';

  if (!this._ccrWired) {
    this._ccrWired = true;
    sel.addEventListener('change', () => {
      const v = sel.value; // 'default' | 'none' | '<roleId>'
      this.serverSettings = this.serverSettings || {};
      this.serverSettings.channel_creator_role = (v === 'default') ? '' : v;
      this.socket.emit('update-server-setting', { key: 'channel_creator_role', value: v });
    });
  }
},

_openRoleModal() {
  document.getElementById('role-modal').style.display = 'flex';
  this._loadRoles();
},

_renderRoleSidebar() {
  const list = document.getElementById('role-list-sidebar');
  if (!list) return;
  let html = '';

  // leveled roles
  const leveledRoles = this._allRoles.filter(r => r.level > 0);
  html += leveledRoles.map(r =>
    `<div class="role-sidebar-item${this._selectedRoleId === r.id ? ' active' : ''}" data-role-id="${r.id}">
      <span class="role-color-dot" style="background:${this._roleFill(r, '#aaa')}"></span>
      ${this._escapeHtml(r.name)}
      <span class="role-sidebar-level">Lv.${r.level}</span>
    </div>`
  ).join('');

  // Groups (level 0) sit below real roles, separated by a divider.
  const groups = this._allRoles.filter(r => r.level === 0);
  if (leveledRoles.length && groups.length) {
    html += '<div class="role-sidebar-divider"></div>';
    html += '<div class="role-sidebar-section-label">' + t('modals.role_management.groups_label') + '</div>';
  }
  html += groups.map(r =>
    `<div class="role-sidebar-item${this._selectedRoleId === r.id ? ' active' : ''}" data-role-id="${r.id}">
      <span class="role-color-dot" style="background:${this._roleFill(r, '#aaa')}"></span>
      ${this._escapeHtml(r.name)}
    </div>`
  ).join('');

  list.innerHTML = html;
  list.querySelectorAll('.role-sidebar-item').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.dataset.roleId;
      this._selectedRoleId = parseInt(id, 10);
      this._renderRoleSidebar();
      this._renderRoleDetail();
    });
  });
},

// Whether the current user may toggle permission `p` on a role. A non-admin
// can only add or remove permissions they personally hold; admin-only perms
// and perms they lack are locked. Mirrors the server rule in update-role
// (socketHandlers/roles.js), which preserves any locked perm the role already
// has rather than deleting it, so the UI disables those toggles instead of
// letting the user check/uncheck them and be silently overridden.
_canControlRolePerm(p) {
  return !!(this.user && this.user.isAdmin) || (!ADMIN_ONLY_PERMS.includes(p) && this._hasPerm(p));
},

_updateRoleLevelPermsVis(levelInputId, permissionsSectionId, permissionsNoteId) {
  const levelInput = document.getElementById(levelInputId);
  const permissionsSection = document.getElementById(permissionsSectionId);
  const permissionsNote = document.getElementById(permissionsNoteId);

  if (!levelInput || (!permissionsSection && !permissionsNote)) return;
  const update = () => {
    const level = parseInt(levelInput.value, 10);
    const isLevelZero = level === 0;

    if(permissionsSection) permissionsSection.style.display = isLevelZero ? 'none' : '';
    if (permissionsNote) permissionsNote.textContent = isLevelZero ? t('settings.admin.role_form.level_0_role_note') : t('settings.admin.role_form.admin_only_note');
  };

  levelInput.addEventListener('input', update);
  update();
},

_renderRoleDetail() {
  const panel = document.getElementById('role-detail-panel');
  const role = this._allRoles.find(r => r.id === this._selectedRoleId);
  if (!role) {
    panel.innerHTML = `<p class="muted-text" style="padding:20px;text-align:center">${t('settings.admin.roles_select_role')}</p>`;
    const sb = document.getElementById('save-role-btn'); if (sb) sb.style.display = 'none';
    return;
  }

  const allPerms = ALL_PERMS;
  const permLabels = PERM_LABELS;
  const rolePerms = role.permissions || [];

  // The role's own settings scroll; the buttons that act on the role as a
  // whole sit below them and stay in view.
  panel.innerHTML = `
    <div class="role-detail-scroll">
    <div class="role-detail-form">
      <label class="settings-label">${t('settings.admin.role_form.name')}</label>
      <input type="text" class="settings-text-input" id="role-edit-name" value="${this._escapeHtml(role.name)}" maxlength="30">
      <label class="settings-label" style="margin-top:8px;">${t('settings.admin.role_form.level')}</label>
      <input type="number" class="settings-number-input" id="role-edit-level" value="${role.level}" min="0" max="99">
      <label class="settings-label" style="margin-top:8px;">${t('settings.admin.role_form.color')}</label>
      <input type="color" id="role-edit-color" value="${role.color || '#aaaaaa'}" style="width:50px;height:30px;border:none;cursor:pointer">
      ${this._roleGradientFieldsHtml('role-edit', role)}
      <label class="toggle-row" style="margin-top:8px;">
        <span>${t('settings.admin.role_form.transparent')}</span>
        <input type="checkbox" id="role-edit-transparent" ${role.transparent ? 'checked' : ''}>
      </label>
      <small class="muted-text" style="font-size:0.6875rem;">${t('settings.admin.role_form.transparent_hint')}</small>
      <label class="settings-label" style="margin-top:8px;">${t('settings.admin.role_form.upload_cap')}</label>
      <input type="number" class="settings-number-input" id="role-edit-upload-mb" value="${role.max_upload_mb || ''}" min="1" max="102400" placeholder="${this._escapeHtml(t('settings.admin.role_form.upload_cap_placeholder', { mb: parseInt(this.serverSettings?.max_upload_mb, 10) || 25 }))}">
      <small class="muted-text" style="font-size:0.6875rem;">${t('settings.admin.role_form.upload_cap_hint')}</small>
      <label class="settings-label" style="margin-top:8px;">${t('settings.admin.role_form.icon')}</label>
      <div class="role-icon-upload-row">
        ${role.icon ? `<img class="role-icon-preview" src="${this._escapeHtml(role.icon)}" alt="${t('settings.admin.role_form.icon')}">` : `<div class="role-icon-preview" style="display:flex;align-items:center;justify-content:center;font-size:0.6875rem;color:var(--text-muted)">${t('settings.admin.role_form.icon_none')}</div>`}
        <input type="file" id="role-icon-file" accept="image/png,image/jpeg,image/gif,image/webp" style="display:none">
        <button class="btn-sm" id="role-icon-upload-btn" type="button">${t('settings.admin.upload_btn')}</button>
        ${role.icon ? `<button class="btn-sm danger" id="role-icon-remove-btn" type="button">${t('settings.admin.remove_btn')}</button>` : ''}
      </div>
      <small class="muted-text" style="font-size:0.6875rem;">${t('settings.admin.role_form.icon_hint')}</small>
      <label class="toggle-row" style="margin-top:12px;">
        <span>${t('settings.admin.role_form.auto_assign')}</span>
        <input type="checkbox" id="role-edit-auto-assign" ${role.auto_assign ? 'checked' : ''}>
      </label>
      <small class="muted-text" style="font-size:0.6875rem;">${t('settings.admin.role_form.auto_assign_hint')}</small>
      <div class="role-channel-access-section">
        <h5 class="settings-section-subtitle" style="margin-top:12px;">${t('settings.admin.role_form.channel_access')}</h5>
        <small class="muted-text" style="font-size:0.6875rem;">${t('settings.admin.role_form.channel_access_hint')}</small>
      </div>
      <h5 class="settings-section-subtitle" style="margin-top:12px;">${t('settings.admin.role_form.permissions')}</h5>
      <p class="perm-admin-note" id="perm-admin-note">${role.level === 0 ? t('settings.admin.role_form.level_0_role_note') : t('settings.admin.role_form.admin_only_note')}</p>
      <div id="role-permissions-list" style="${role.level === 0 ? 'display:none;' : ''}">
        ${allPerms.map(p => {
          const locked = !this._canControlRolePerm(p);
          const adminOnly = ADMIN_ONLY_PERMS.includes(p);
          return `
          <label class="toggle-row${adminOnly ? ' perm-admin-only' : ''}"${locked ? ` style="opacity:.55" title="${t('settings.admin.role_form.permissions_held_only')}"` : ''}>
            <span>${permLabels[p] || p.replace(/_/g, ' ')}</span>
            <input type="checkbox" class="role-perm-checkbox" data-perm="${p}" ${rolePerms.includes(p) ? 'checked' : ''}${locked ? ' disabled' : ''}>
          </label>`;
        }).join('')}
      </div>
    </div>
    </div>
    <div class="role-detail-actions">
      <button class="btn-sm btn-accent" id="role-members-btn">👥 ${t('settings.admin.role_form.members')}</button>
      <button class="btn-sm" id="duplicate-role-btn">📋 ${t('settings.admin.role_form.duplicate')}</button>
      <button class="btn-sm danger" id="delete-role-btn">${t('settings.admin.role_form.delete')}</button>
    </div>
  `;

  // Toggle permissions visibility based on the current role level.
  this._updateRoleLevelPermsVis('role-edit-level', 'role-permissions-list', 'perm-admin-note');
  const readRoleLook = this._wireRoleGradientFields('role-edit', 'role-edit-color', 'role-edit-name');

  // Role icon upload/remove
  this._pendingRoleIcon = undefined;
  const iconFileInput = document.getElementById('role-icon-file');
  document.getElementById('role-icon-upload-btn')?.addEventListener('click', () => iconFileInput.click());
  iconFileInput?.addEventListener('change', async () => {
    const file = iconFileInput.files[0];
    if (!file) return;
    if (file.size > 512 * 1024) { this._showToast(t('settings.admin.role_form.icon_too_large'), 'error'); return; }
    // Auto-resize to 16x16 on a canvas so any image size works
    let uploadFile = file;
    try {
      const bmp = await createImageBitmap(file);
      if (bmp.width !== 16 || bmp.height !== 16) {
        const canvas = document.createElement('canvas');
        canvas.width = 16; canvas.height = 16;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bmp, 0, 0, 16, 16);
        bmp.close();
        uploadFile = await new Promise(r => canvas.toBlob(r, 'image/png'));
      } else { bmp.close(); }
    } catch { /* fall through with original file */ }
    const fd = new FormData();
    fd.append('icon', uploadFile, 'role-icon.png');
    try {
      const res = await fetch('/api/upload-role-icon', { method: 'POST', headers: { 'Authorization': 'Bearer ' + this.token }, body: fd });
      const data = await res.json();
      if (data.error) { this._showToast(data.error, 'error'); return; }
      this._pendingRoleIcon = data.path;
      const preview = panel.querySelector('.role-icon-preview');
      if (preview) { preview.outerHTML = `<img class="role-icon-preview" src="${this._escapeHtml(data.path)}" alt="${t('settings.admin.role_form.icon')}">`; }
      this._showToast(t('settings.admin.role_form.icon_uploaded_role'), 'success');
    } catch { this._showToast(t('settings.admin.upload_failed'), 'error'); }
  });
  document.getElementById('role-icon-remove-btn')?.addEventListener('click', () => {
    this._pendingRoleIcon = null;
    const preview = panel.querySelector('.role-icon-preview');
    if (preview) { preview.outerHTML = `<div class="role-icon-preview" style="display:flex;align-items:center;justify-content:center;font-size:0.6875rem;color:var(--text-muted)">${t('settings.admin.role_form.icon_none')}</div>`; }
    const removeBtn = document.getElementById('role-icon-remove-btn');
    if (removeBtn) removeBtn.remove();
    this._showToast(t('settings.admin.role_form.icon_removed_role'), 'success');
  });
  // The Save button lives in the modal-actions bar (always visible). Show it
  // when a role is selected, and wire up the click handler.
  const saveBtn = document.getElementById('save-role-btn');
  saveBtn.style.display = '';
  // Remove old listener by cloning
  const freshSaveBtn = saveBtn.cloneNode(true);
  saveBtn.parentNode.replaceChild(freshSaveBtn, saveBtn);
  freshSaveBtn.addEventListener('click', () => {
    const perms = [...panel.querySelectorAll('.role-perm-checkbox:checked')].map(cb => cb.dataset.perm);
    freshSaveBtn.disabled = true;
    freshSaveBtn.textContent = t('settings.admin.roles_saving');

    this._roleEmit('update-role', {
      roleId: role.id,
      name: document.getElementById('role-edit-name').value.trim(),
      level: parseInt(document.getElementById('role-edit-level').value, 10),
      color: document.getElementById('role-edit-color').value,
      color2: readRoleLook().color2,
      shimmer: readRoleLook().shimmer,
      transparent: document.getElementById('role-edit-transparent').checked,
      icon: this._pendingRoleIcon !== undefined ? this._pendingRoleIcon : role.icon,
      autoAssign: document.getElementById('role-edit-auto-assign').checked,
      // Channel access lives on the channel now, as Required roles (#5649).
      linkChannelAccess: false,
      maxUploadMb: parseInt(document.getElementById('role-edit-upload-mb')?.value, 10) || null,
      permissions: perms
    }, (res) => {
      if (res.error) { this._showToast(res.error, 'error'); freshSaveBtn.disabled = false; freshSaveBtn.textContent = t('settings.admin.roles_save'); return; }

      // Reset button BEFORE re-render (re-render clones the button,
      // so the clone must inherit the clean state, not "Saving...").
      freshSaveBtn.disabled = false;
      freshSaveBtn.textContent = t('settings.admin.roles_save');

      // Use server-returned roles directly (no re-fetch needed)
      if (res.roles) {
        this._allRoles = res.roles;
        this._renderRolesPreview();
        if (document.getElementById('role-modal').style.display !== 'none') {
          this._renderRoleSidebar();
          this._renderRoleDetail();
        }
      } else {
        this._loadRoles();
      }
      this._showToast(t('settings.admin.roles_saved'), 'success');
    });
  });

  document.getElementById('delete-role-btn').addEventListener('click', async () => {
    const ok = await this._showConfirmModal(
      t('settings.admin.roles_delete_confirm', { name: role.name }),
      '',
      { danger: true }
    );
    if (!ok) return;
    this._roleEmit('delete-role', { roleId: role.id }, (res) => {
      if (res.error) { this._showToast(res.error, 'error'); return; }
      this._showToast(t('settings.admin.roles_deleted'), 'success');
      this._selectedRoleId = null;
      this._loadRoles();
      this._renderRoleDetail();
    });
  });

  // Duplicate: prompt for new name (default = "<original> (copy)") then
  // create a fresh role with the same level, color (gradient included), icon,
  // and permissions.
  // Channel-access linkage and auto-assign are intentionally NOT copied;
  // both are rarely what an admin wants on a freshly cloned role.
  document.getElementById('duplicate-role-btn')?.addEventListener('click', async () => {
    const defaultName = t('settings.admin.roles_copy_name', { name: role.name }).slice(0, 30);
    const newName = await this._showPromptModal(t('settings.admin.roles_duplicate_title'), t('settings.admin.roles_duplicate_prompt'), defaultName);
    if (!newName || !newName.trim()) return;
    const trimmed = newName.trim().slice(0, 30);
    this._roleEmit('create-role', {
      name: trimmed,
      level: role.level,
      color: role.color || '#aaaaaa',
      color2: role.color2 || null,
      shimmer: !!role.color_shimmer,
      transparent: !!role.transparent,
      icon: role.icon || null,
      autoAssign: false,
      maxUploadMb: role.max_upload_mb || null,
      permissions: role.permissions || []
    }, (res) => {
      if (res && res.error) { this._showToast(res.error, 'error'); return; }
      this._showToast(t('settings.admin.roles_duplicated_as', { name: trimmed }), 'success');
      if (res && res.roleId) this._selectedRoleId = res.roleId;
      this._loadRoles?.();
    });
  });

  document.getElementById('role-members-btn')?.addEventListener('click', () => {
    this._openRoleMembersModal(role);
  });

  // Role hierarchy gate: a non-admin may only edit roles strictly below their
  // own level. Roles at or above them are shown read-only (every field and
  // mutating action disabled), mirroring the server guard in update-role and
  // the RAC's grantable-roles lock. Runs last so it overrides the Save button
  // being re-shown above. Viewing members stays available (read-only).
  this._applyRoleEditGate(panel, role, {
    actionButtonIds: ['save-role-btn', 'delete-role-btn', 'duplicate-role-btn'],
    keepEnabledIds: ['role-members-btn'],
    formSelector: '.role-detail-form'
  });
},

// Gradient controls under a role's Color picker, shared by both role
// editors: a Gradient switch that reveals the end color and a Shimmer switch,
// plus a sample name in the role's style. `prefix` keeps the ids apart;
// `compact` matches the channel roles panel, whose checkboxes sit before
// their labels.
_roleGradientFieldsHtml(prefix, role, compact = false) {
  const on = !!role.color2;
  const sw = (id, label, checked) => compact
    ? `<label class="cr-perm-toggle" style="margin-top:6px"><input type="checkbox" id="${id}"${checked ? ' checked' : ''}><span>${label}</span></label>`
    : `<label class="toggle-row" style="margin-top:8px;"><span>${label}</span><input type="checkbox" id="${id}"${checked ? ' checked' : ''}></label>`;
  return `
    ${sw(`${prefix}-gradient`, t('settings.admin.role_form.gradient'), on)}
    <div id="${prefix}-gradient-opts"${on ? '' : ' style="display:none"'}>
      <div class="role-gradient-opts">
        <label class="${compact ? 'cr-role-label' : 'settings-label'}" for="${prefix}-color2" style="margin:0">${t('settings.admin.role_form.gradient_end')}</label>
        <input type="color" id="${prefix}-color2" value="${this._safeColor(role.color2, '#ffd166')}" style="width:50px;height:30px;border:none;cursor:pointer;background:none">
      </div>
      ${sw(`${prefix}-shimmer`, t('settings.admin.role_form.shimmer'), !!role.color_shimmer)}
    </div>
    <small class="muted-text" style="font-size:0.6875rem;">${t('settings.admin.role_form.gradient_hint')}</small>
    <div class="role-style-preview">
      <span class="muted-text">${t('settings.admin.role_form.style_preview')}</span>
      <span class="role-style-preview-name" id="${prefix}-style-preview"></span>
    </div>`;
},

// Keeps the end color's visibility and the sample name in step with the
// controls, and returns a reader for the values to save.
_wireRoleGradientFields(prefix, colorInputId, nameInputId) {
  const $ = (id) => document.getElementById(id);
  const read = () => {
    const gradient = !!$(`${prefix}-gradient`)?.checked;
    return {
      color: $(colorInputId)?.value || null,
      color2: gradient ? ($(`${prefix}-color2`)?.value || null) : null,
      shimmer: gradient && !!$(`${prefix}-shimmer`)?.checked,
    };
  };
  const update = () => {
    const v = read();
    const opts = $(`${prefix}-gradient-opts`);
    if (opts) opts.style.display = $(`${prefix}-gradient`)?.checked ? '' : 'none';
    const name = ($(nameInputId)?.value || '').trim() || t('settings.admin.role_form.style_preview_name');
    this._applyRoleName($(`${prefix}-style-preview`), { color: v.color, color2: v.color2, color_shimmer: v.shimmer ? 1 : 0 }, name);
  };
  [colorInputId, nameInputId, `${prefix}-gradient`, `${prefix}-color2`, `${prefix}-shimmer`].forEach(id => {
    const el = $(id);
    if (!el) return;
    el.addEventListener('input', update);
    el.addEventListener('change', update);
  });
  update();
  return read;
},

// Disables the whole role editor for a non-admin when `role.level` is at or
// above the caller's level, and prepends a read-only note. Shared by both role
// editors so the rule stays in one place.
_applyRoleEditGate(panel, role, { actionButtonIds = [], keepEnabledIds = [], formSelector }) {
  const isAdmin = !!(this.user && this.user.isAdmin);
  const myLevel = (this.user && this.user.effectiveLevel) || 0;
  if (isAdmin || role.level < myLevel) return;

  panel.querySelectorAll('input, select, textarea, button').forEach(el => { el.disabled = true; });
  keepEnabledIds.forEach(id => { const el = document.getElementById(id); if (el) el.disabled = false; });
  actionButtonIds.forEach(id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; });

  const form = formSelector ? panel.querySelector(formSelector) : panel;
  if (form && !form.querySelector('.role-readonly-note')) {
    const note = document.createElement('p');
    note.className = 'role-readonly-note';
    note.textContent = t('settings.admin.role_form.readonly_note', { level: myLevel });
    form.insertBefore(note, form.firstChild);
  }
},

_openRoleMembersModal(role) {
  const modal = document.getElementById('role-members-modal');
  if (!modal) return;
  document.getElementById('role-members-modal-title').textContent = role.name;
  document.getElementById('role-members-search').value = '';

  const listEl = document.getElementById('role-members-list');
  listEl.innerHTML = `<p class="rac-placeholder" style="padding:16px;text-align:center">${t('modals.common.loading')}</p>`;

  modal.style.display = 'flex';
  modal.style.zIndex = '100004';

  let cachedData = null;

  const renderList = (users, filter) => {
    const q = (filter || '').toLowerCase();
    const filtered = users.filter(u =>
      !q || u.username.toLowerCase().includes(q) ||
      (u.displayName || '').toLowerCase().includes(q)
    );
    if (!filtered.length) {
      listEl.innerHTML = `<p class="rac-placeholder" style="padding:16px;text-align:center">${t('settings.admin.roles_no_members_found')}</p>`;
      return;
    }
    listEl.innerHTML = filtered.map(u => {
      // The assignment data lists a held role as role_id, not id, so this
      // never matched: every row said Assign, the badge never appeared and
      // there was no Remove to undo it with (#5643).
      const hasRole = u.currentRoles.some(r => (r.role_id ?? r.id) === role.id && !r.channel_id);
      const color = this._getUserColor(u.username);
      const initial = (u.displayName || u.username).charAt(0).toUpperCase();
      const shapeStyle = u.avatarShape === 'square' ? 'border-radius:4px' : '';
      const avatarHtml = u.avatar
        ? `<img class="rac-user-avatar" src="${this._escapeHtml(u.avatar)}" alt="${initial}" style="${shapeStyle}">`
        : `<span class="rac-user-avatar" style="background-color:${color};${shapeStyle}">${initial}</span>`;
      const badgeHtml = hasRole
        ? `<span class="role-member-badge" style="background:${this._safeColor(role.color,'#aaa')}22;color:${this._safeColor(role.color,'#aaa')};border:1px solid ${this._safeColor(role.color,'#aaa')}44;border-radius:4px;padding:1px 6px;font-size:0.6875rem;white-space:nowrap">${this._roleNameHtml(role, role.name)}</span>`
        : '';
      return `<div class="rac-user-item" style="cursor:default;gap:10px" data-uid="${u.id}">
        ${avatarHtml}
        <span style="flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:0.8125rem">${this._escapeHtml(this._getNickname(u.id, u.displayName))}</span>
        ${badgeHtml}
        <button class="btn-sm${hasRole ? ' danger' : ' btn-accent'} role-member-toggle-btn" data-uid="${u.id}" data-has="${hasRole}" style="flex-shrink:0;min-width:64px">
          ${t(hasRole ? 'settings.admin.roles_remove' : 'settings.admin.roles_assign')}
        </button>
      </div>`;
    }).join('');

    listEl.querySelectorAll('.role-member-toggle-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const uid = parseInt(btn.dataset.uid, 10);
        const has = btn.dataset.has === 'true';
        btn.disabled = true;
        const event = has ? 'revoke-role' : 'assign-role';
        this.socket.emit(event, { userId: uid, roleId: role.id, channelId: null }, (res) => {
          if (res && res.error) {
            this._showToast(res.error, 'error');
            btn.disabled = false;
            return;
          }
          this._roleEmit('get-role-assignment-data', {}, (r) => {
            if (!r.error) { cachedData = r; renderList(r.users, document.getElementById('role-members-search').value); }
          });
        });
      });
    });
  };

  this._roleEmit('get-role-assignment-data', {}, (res) => {
    if (res.error) { this._showToast(res.error, 'error'); return; }
    cachedData = res;
    renderList(res.users, '');
  });

  const searchEl = document.getElementById('role-members-search');
  // Replace old listener by cloning
  const freshSearch = searchEl.cloneNode(true);
  searchEl.parentNode.replaceChild(freshSearch, searchEl);
  freshSearch.addEventListener('input', (e) => {
    if (cachedData) renderList(cachedData.users, e.target.value);
  });

  const closeBtn = document.getElementById('role-members-close-btn');
  const freshClose = closeBtn.cloneNode(true);
  closeBtn.parentNode.replaceChild(freshClose, closeBtn);
  freshClose.addEventListener('click', () => { modal.style.display = 'none'; });
  modal.onclick = (e) => { if (e.target === modal) modal.style.display = 'none'; };
},

_loadRoleChannelAccess(roleId) {
  const listEl = document.getElementById('role-channel-access-list');
  if (!listEl) return;
  listEl.innerHTML = `<p class="muted-text" style="padding:12px;text-align:center;font-size:0.75rem">${t('modals.common.loading')}</p>`;

  this._roleEmit('get-role-channel-access', { roleId }, (res) => {
    if (res && res.error) {
      listEl.innerHTML = `<p class="muted-text" style="padding:12px;text-align:center;font-size:0.75rem">${this._escapeHtml(res.error)}</p>`;
      return;
    }
    const channels = res.channels || [];
    const accessMap = {};
    (res.access || []).forEach(a => { accessMap[a.channel_id] = a; });

    if (!channels.length) {
      listEl.innerHTML = `<p class="muted-text" style="padding:12px;text-align:center;font-size:0.75rem">${t('settings.admin.roles_no_channels')}</p>`;
      return;
    }

    // Build parent → sub hierarchy
    const parents = channels.filter(c => !c.parent_channel_id);
    const subMap = {};
    channels.filter(c => c.parent_channel_id).forEach(c => {
      if (!subMap[c.parent_channel_id]) subMap[c.parent_channel_id] = [];
      subMap[c.parent_channel_id].push(c);
    });

    let html = '';
    parents.forEach(p => {
      const pa = accessMap[p.id] || {};
      html += this._renderRcaRow(p, pa, false);
      (subMap[p.id] || []).forEach(s => {
        const sa = accessMap[s.id] || {};
        html += this._renderRcaRow(s, sa, true);
      });
    });
    listEl.innerHTML = html;
  });
},

_renderRcaRow(ch, access, isSub) {
  const grantChecked = access.grant_on_promote ? ' checked' : '';
  const revokeChecked = access.revoke_on_demote ? ' checked' : '';
  const lockIcon = ch.is_private ? ' 🔒' : '';
  return `<div class="rca-channel-row" data-channel-id="${ch.id}">
    <span class="rca-channel-name${isSub ? ' rca-sub' : ''}">${isSub ? '↳ ' : '# '}${this._escapeHtml(ch.name)}${lockIcon}</span>
    <label><input type="checkbox" class="rca-grant"${grantChecked}> ${t('settings.admin.roles_grant')}</label>
    <label><input type="checkbox" class="rca-revoke"${revokeChecked}> ${t('settings.admin.roles_revoke')}</label>
  </div>`;
},

// ═══════════════════════════════════════════════════════
// ── Channel Roles Modal ───────────────────────────────
// ═══════════════════════════════════════════════════════

_openChannelRolesModal(channelCode) {
  this._channelRolesCode = channelCode;
  this._channelRolesSelectedUser = null;
  this._channelRolesMembers = [];
  this._channelRolesChannelId = null;
  this._channelRolesSelectedRole = null;

  const modal = document.getElementById('channel-roles-modal');
  const ch = this.channels.find(c => c.code === channelCode);
  document.getElementById('channel-roles-channel-name').textContent = ch ? `# ${ch.name}` : '';
  document.getElementById('channel-roles-member-list').innerHTML = `<p class="channel-roles-no-members">${t('modals.common.loading')}</p>`;
  document.getElementById('channel-roles-actions').style.display = 'none';
  document.getElementById('channel-roles-role-detail').innerHTML =
    `<p class="muted-text" style="padding:12px;text-align:center;font-size:0.82rem">${t('settings.admin.roles_select_to_configure')}</p>`;
  modal.style.display = 'flex';

  // Fetch members + roles and all available roles in parallel
  this._loadRoles(() => {
    this._renderChannelRolesRoleList();
    this._roleEmit('get-channel-member-roles', { code: channelCode }, (res) => {
      if (res.error) {
        document.getElementById('channel-roles-member-list').innerHTML =
          `<p class="channel-roles-no-members">${this._escapeHtml(res.error)}</p>`;
        return;
      }
      this._channelRolesMembers = res.members || [];
      this._channelRolesChannelId = res.channelId;
      this._renderChannelRolesMembers();
      // Populate role dropdown
      const roleSel = document.getElementById('channel-roles-role-select');
      roleSel.innerHTML = `<option value="">${t('settings.admin.roles_select_dropdown')}</option>` +
        this._allRoles.map(r =>
          `<option value="${r.id}">● ${this._escapeHtml(r.name)} (Lv.${r.level})</option>`
        ).join('');
    });
  });
},

_renderChannelRolesMembers() {
  const list = document.getElementById('channel-roles-member-list');
  if (!this._channelRolesMembers.length) {
    list.innerHTML = `<p class="channel-roles-no-members">${t('settings.admin.roles_no_members')}</p>`;
    return;
  }

  // Sort alphabetically by display name
  const sorted = [...this._channelRolesMembers].sort((a, b) =>
    a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' })
  );

  list.innerHTML = sorted.map(m => {
    const sel = this._channelRolesSelectedUser === m.id ? ' selected' : '';
    const avatarSrc = m.avatar || `https://api.dicebear.com/7.x/identicon/svg?seed=${encodeURIComponent(m.loginName)}`;
    const shapeClass = m.avatarShape === 'square' ? ' square' : '';
    const badges = m.isAdmin
      ? `<span class="channel-roles-badge badge-admin"><span class="badge-dot" style="background:#e74c3c"></span>${t('settings.admin.badge_admin')}</span>`
      : (m.roles || []).map(r =>
          `<span class="channel-roles-badge"><span class="badge-dot" style="background:${this._roleFill(r, '#aaa')}"></span>${this._escapeHtml(r.name)}<span class="badge-scope">${r.scope === 'channel' ? `📌 ${t('settings.admin.roles_scope_channel')}` : `🌐 ${t('settings.admin.roles_scope_server')}`}</span><span class="revoke-btn" data-uid="${m.id}" data-rid="${r.roleId}" data-scope="${r.scope}" title="${t('settings.admin.roles_revoke')}">✕</span></span>`
        ).join('') || `<span class="channel-roles-no-role">${t('settings.admin.roles_no_roles')}</span>`;

    return `<div class="channel-roles-member${sel}" data-uid="${m.id}">
      <img class="channel-roles-member-avatar${shapeClass}" src="${avatarSrc}" alt="">
      <div class="channel-roles-member-info">
        <span class="channel-roles-member-name">${this._escapeHtml(m.displayName)}</span>
        <span class="channel-roles-member-login">@${this._escapeHtml(m.loginName)}</span>
        <div class="channel-roles-member-badges">${badges}</div>
      </div>
    </div>`;
  }).join('');

  // Member click → select
  list.querySelectorAll('.channel-roles-member').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.revoke-btn')) return; // handled below
      const uid = parseInt(el.dataset.uid);
      this._channelRolesSelectedUser = uid;
      this._renderChannelRolesMembers();
      this._showChannelRolesActions(uid);
    });
  });

  // Revoke button clicks
  list.querySelectorAll('.revoke-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const uid = parseInt(btn.dataset.uid);
      const rid = parseInt(btn.dataset.rid);
      const scope = btn.dataset.scope;
      const channelId = scope === 'channel' ? this._channelRolesChannelId : null;
      this._roleEmit('revoke-role', { userId: uid, roleId: rid, channelId });
      this._showToast(t('settings.admin.roles_revoked'), 'success');
      // Refresh after a short delay
      setTimeout(() => this._refreshChannelRoles(), 400);
    });
  });
},

_showChannelRolesActions(userId) {
  const panel = document.getElementById('channel-roles-actions');
  const member = this._channelRolesMembers.find(m => m.id === userId);
  if (!member) { panel.style.display = 'none'; return; }
  panel.style.display = '';
  document.getElementById('channel-roles-selected-name').textContent = member.displayName;

  const currentDiv = document.getElementById('channel-roles-current-roles');

  // Admins cannot modify their own roles
  if (member.isAdmin && member.id === this.user.id) {
    currentDiv.innerHTML = `<span class="channel-roles-badge" style="background:rgba(231,76,60,0.2);color:#e74c3c"><span class="badge-dot" style="background:#e74c3c"></span>${t('settings.admin.badge_admin')}</span>`;
    const assignArea = panel.querySelector('.channel-roles-assign-area');
    if (assignArea) assignArea.style.display = 'none';
    return;
  }
  // Show assign area for non-self-admin targets
  const assignArea = panel.querySelector('.channel-roles-assign-area');
  if (assignArea) assignArea.style.display = '';

  if (member.isAdmin) {
    currentDiv.innerHTML = `<span class="channel-roles-badge badge-admin"><span class="badge-dot" style="background:#e74c3c"></span>${t('settings.admin.badge_admin')}</span>`;
  } else if (member.roles.length) {
    currentDiv.innerHTML = member.roles.map(r =>
      `<span class="channel-roles-badge"><span class="badge-dot" style="background:${this._roleFill(r, '#aaa')}"></span>${this._escapeHtml(r.name)} <span class="badge-scope">${r.scope === 'channel' ? `📌 ${t('settings.admin.roles_scope_channel')}` : `🌐 ${t('settings.admin.roles_scope_server')}`}</span></span>`
    ).join('');
  } else {
    currentDiv.innerHTML = `<span style="font-size:0.78rem;color:var(--text-muted)">${t('settings.admin.roles_no_assigned')}</span>`;
  }
},

_assignChannelRole() {
  const userId = this._channelRolesSelectedUser;
  if (!userId) return this._showToast(t('settings.admin.roles_select_member'), 'error');

  const roleId = parseInt(document.getElementById('channel-roles-role-select').value);
  if (!roleId) return this._showToast(t('settings.admin.roles_select_role'), 'error');

  const scopeVal = document.getElementById('channel-roles-scope-select').value;
  const channelId = scopeVal === 'channel' ? this._channelRolesChannelId : null;

  this._roleEmit('assign-role', { userId, roleId, channelId }, (res) => {
    if (res.error) return this._showToast(res.error, 'error');
    this._showToast(t('settings.admin.roles_assigned'), 'success');
    // Reset selection
    document.getElementById('channel-roles-role-select').value = '';
    // Refresh member list
    setTimeout(() => this._refreshChannelRoles(), 400);
  });
},

_refreshChannelRoles() {
  if (!this._channelRolesCode) return;
  this._roleEmit('get-channel-member-roles', { code: this._channelRolesCode }, (res) => {
    if (res.error) return;
    this._channelRolesMembers = res.members || [];
    this._renderChannelRolesMembers();
    // Re-select user if still valid
    if (this._channelRolesSelectedUser) {
      this._showChannelRolesActions(this._channelRolesSelectedUser);
    }
  });
},

/* ── Channel Roles: Role configuration panel ────────── */

_renderChannelRolesRoleList() {
  const list = document.getElementById('channel-roles-role-list');
  if (!list) return;
  if (!this._allRoles.length) {
    list.innerHTML = `<p style="font-size:0.82rem;color:var(--text-muted);text-align:center;padding:8px">${t('settings.admin.roles_none_yet')}</p>`;
    return;
  }

  const renderRole = r =>
    `<div class="channel-roles-role-item${this._channelRolesSelectedRole === r.id ? ' active' : ''}" data-role-id="${r.id}">
      <span class="role-color-dot" style="background:${this._roleFill(r, '#aaa')}"></span>
      <span class="channel-roles-role-name">${this._escapeHtml(r.name)}</span>
      <span class="channel-roles-role-level">Lv.${r.level}</span>
    </div>`;

  const leveledRoles = this._allRoles.filter(r => r.level > 0);
  let html = leveledRoles.map(renderRole).join('');

  const groups = this._allRoles.filter(r => r.level === 0);
  if (leveledRoles.length && groups.length) {
    html += '<div class="role-sidebar-divider"></div>';
    html += '<div class="role-sidebar-section-label">' + t('modals.role_management.groups_label') + '</div>';
  }
  html += groups.map(renderRole).join('');

  list.innerHTML = html;
  list.querySelectorAll('.channel-roles-role-item').forEach(el => {
    el.addEventListener('click', () => {
      this._channelRolesSelectedRole = parseInt(el.dataset.roleId, 10);
      this._renderChannelRolesRoleList();
      this._renderChannelRolesRoleDetail();
    });
  });
},

_renderChannelRolesRoleDetail() {
  const panel = document.getElementById('channel-roles-role-detail');
  const role = this._allRoles.find(r => r.id === this._channelRolesSelectedRole);
  if (!role) {
    panel.innerHTML = `<p class="muted-text" style="padding:12px;text-align:center;font-size:0.82rem">${t('settings.admin.roles_select_to_configure')}</p>`;
    return;
  }

  const allPerms = ALL_PERMS;
  const permLabels = PERM_LABELS;
  const rolePerms = role.permissions || [];

  panel.innerHTML = `
    <div class="cr-role-form">
      <div class="cr-role-form-row">
        <label class="cr-role-label">${t('settings.admin.role_form.name')}</label>
        <input type="text" class="settings-text-input" id="cr-role-name" value="${this._escapeHtml(role.name)}" maxlength="30">
      </div>
      <div class="cr-role-form-row cr-role-inline">
        <div>
          <label class="cr-role-label">${t('settings.admin.role_form.level')}</label>
          <input type="number" class="settings-number-input" id="cr-role-level" value="${role.level}" min="0" max="99" style="width:60px">
        </div>
        <div>
          <label class="cr-role-label">${t('settings.admin.role_form.color')}</label>
          <input type="color" id="cr-role-color" value="${role.color || '#aaaaaa'}" style="width:36px;height:28px;border:none;cursor:pointer;background:none">
        </div>
      </div>
      ${this._roleGradientFieldsHtml('cr-role', role, true)}
      <label class="cr-perm-toggle" style="margin-top:6px">
        <input type="checkbox" id="cr-role-auto-assign" ${role.auto_assign ? 'checked' : ''}>
        <span>${t('settings.admin.role_form.auto_assign')}</span>
      </label>
      <label class="cr-role-label" style="margin-top:4px">${t('settings.admin.role_form.permissions')}</label>
      <p class="perm-admin-note" id="cr-perm-admin-note">${role.level === 0 ? t('settings.admin.role_form.level_0_role_note') : t('settings.admin.role_form.admin_only_note')}</p>
      <div class="cr-role-perms" id="cr-role-permissions-list" style="${role.level === 0 ? 'display:none;' : ''}">
        ${allPerms.map(p => {
          const locked = !this._canControlRolePerm(p);
          const adminOnly = ADMIN_ONLY_PERMS.includes(p);
          return `
          <label class="cr-perm-toggle${adminOnly ? ' perm-admin-only' : ''}"${locked ? ` style="opacity:.55" title="${t('settings.admin.role_form.permissions_held_only')}"` : ''}>
            <input type="checkbox" class="cr-perm-cb" data-perm="${p}" ${rolePerms.includes(p) ? 'checked' : ''}${locked ? ' disabled' : ''}>
            <span>${permLabels[p] || p.replace(/_/g, ' ')}</span>
          </label>`;
        }).join('')}
      </div>
      <div class="cr-role-btns">
        <button class="btn-sm btn-accent" id="cr-save-role-btn">${t('settings.admin.roles_save')}</button>
        <button class="btn-sm danger" id="cr-delete-role-btn">${t('settings.admin.role_form.delete')}</button>
      </div>
    </div>
  `;

  // Toggle permissions visibility based on the current role level.
  this._updateRoleLevelPermsVis('cr-role-level', 'cr-role-permissions-list', 'cr-perm-admin-note');
  const readCrRoleLook = this._wireRoleGradientFields('cr-role', 'cr-role-color', 'cr-role-name');

  document.getElementById('cr-save-role-btn').addEventListener('click', () => {
    const perms = [...panel.querySelectorAll('.cr-perm-cb:checked')].map(cb => cb.dataset.perm);
    const newLevel = parseInt(document.getElementById('cr-role-level').value, 10);
    if (isNaN(newLevel) || newLevel < 0 || newLevel > 99) { this._showToast(t('settings.admin.roles_level_invalid'), 'error'); return; }
    this._roleEmit('update-role', {
      roleId: role.id,
      name: document.getElementById('cr-role-name').value.trim(),
      level: newLevel,
      color: document.getElementById('cr-role-color').value,
      color2: readCrRoleLook().color2,
      shimmer: readCrRoleLook().shimmer,
      autoAssign: document.getElementById('cr-role-auto-assign').checked,
      permissions: perms
    }, (res) => {
      if (res.error) { this._showToast(res.error, 'error'); return; }
      this._showToast(t('settings.admin.roles_updated'), 'success');
      this._loadRoles(() => {
        this._renderChannelRolesRoleList();
        this._renderChannelRolesRoleDetail();
        this._refreshChannelRolesDropdown();
        this._refreshChannelRoles();
      });
    });
  });

  document.getElementById('cr-delete-role-btn').addEventListener('click', async () => {
    const ok = await this._showConfirmModal(
      t('settings.admin.roles_delete_confirm', { name: role.name }),
      '',
      { danger: true }
    );
    if (!ok) return;
    this._roleEmit('delete-role', { roleId: role.id }, (res) => {
      if (res.error) { this._showToast(res.error, 'error'); return; }
      this._showToast(t('settings.admin.roles_deleted'), 'success');
      this._channelRolesSelectedRole = null;
      this._loadRoles(() => {
        this._renderChannelRolesRoleList();
        this._renderChannelRolesRoleDetail();
        this._refreshChannelRolesDropdown();
        this._refreshChannelRoles();
      });
    });
  });

  // Same hierarchy gate as the main role editor: read-only for a non-admin
  // when the role is at or above their level.
  this._applyRoleEditGate(panel, role, {
    actionButtonIds: ['cr-save-role-btn', 'cr-delete-role-btn'],
    formSelector: '.cr-role-form'
  });
},

async _createChannelRole() {
  const name = await this._showPromptModal(t('settings.admin.roles_create_title'), t('settings.admin.roles_create_hint'));
  if (!name || !name.trim()) return;
  const levelStr = await this._showPromptModal(t('settings.admin.roles_level_title'), t('settings.admin.roles_level_hint'), '25');
  if (levelStr === null) return;
  const level = parseInt(levelStr, 10);
  if (isNaN(level) || level < 0 || level > 99) { this._showToast(t('settings.admin.roles_level_invalid'), 'error'); return; }
  this._roleEmit('create-role', { name: name.trim(), level, color: '#aaaaaa' }, (res) => {
    if (res.error) { this._showToast(res.error, 'error'); return; }
    this._showToast(t('settings.admin.roles_created'), 'success');
    this._loadRoles(() => {
      this._renderChannelRolesRoleList();
      this._refreshChannelRolesDropdown();
    });
  });
},

_refreshChannelRolesDropdown() {
  const roleSel = document.getElementById('channel-roles-role-select');
  if (!roleSel) return;
  roleSel.innerHTML = `<option value="">${t('settings.admin.roles_select_dropdown')}</option>` +
    this._allRoles.map(r =>
      `<option value="${r.id}">● ${this._escapeHtml(r.name)} (Lv.${r.level})</option>`
    ).join('');
},

_openAssignRoleModal(userId, username) {
  const modal = document.getElementById('assign-role-modal');
  modal.dataset.userId = userId;
  document.getElementById('assign-role-user-label').textContent = t('settings.admin.roles_assigning_to', { name: username });

  // Multi-role: render every role as a checkbox. Held roles are pre-checked
  // when the chosen scope matches the role assignment's channel_id.
  const container = document.getElementById('assign-role-checkboxes');
  const renderCheckboxes = (heldRoleIds) => {
    if (!container) return;
    if (!this._allRoles.length) {
      container.innerHTML = `<p class="muted-text">${this._escapeHtml(t('settings.admin.roles_none'))}</p>`;
      return;
    }
    container.innerHTML = this._allRoles.map(r => {
      const checked = heldRoleIds.has(r.id) ? ' checked' : '';
      const dot = `<span class="role-color-dot" style="background:${this._roleFill(r, '#888')}"></span>`;
      return `
        <label class="assign-role-checkbox-row">
          <input type="checkbox" class="assign-role-checkbox" value="${r.id}"${checked}>
          ${dot}
          <span class="assign-role-checkbox-name">${this._escapeHtml(r.name)}</span>
          <span class="assign-role-checkbox-level">Lv.${r.level}</span>
        </label>
      `;
    }).join('');
  };

  // Populate scope with structured parent → sub-channel grouping
  const scopeSel = document.getElementById('assign-role-scope');
  const nonDm = this.channels.filter(c => !c.is_dm);
  const parents = nonDm.filter(c => !c.parent_channel_id);
  const subMap = {};
  nonDm.filter(c => c.parent_channel_id).forEach(c => {
    if (!subMap[c.parent_channel_id]) subMap[c.parent_channel_id] = [];
    subMap[c.parent_channel_id].push(c);
  });

  let scopeHtml = '<option value="server">🌐 Server-wide</option>';
  parents.forEach(p => {
    scopeHtml += `<option value="${p.id}"># ${this._escapeHtml(p.name)}</option>`;
    const subs = subMap[p.id] || [];
    subs.forEach(s => {
      scopeHtml += `<option value="${s.id}">&nbsp;&nbsp;└ ${this._escapeHtml(s.name)}</option>`;
    });
  });
  scopeSel.innerHTML = scopeHtml;

  // Fetch this user's currently-held roles so the checkbox state reflects
  // reality. We listen once (the handler removes itself) for the response.
  const buildHeldSet = (allRoles, scopeValue) => {
    const channelId = scopeValue !== 'server' ? parseInt(scopeValue, 10) : null;
    const set = new Set();
    (allRoles || []).forEach(r => {
      const sameScope = (channelId === null && (r.channel_id === null || r.channel_id === undefined))
        || (channelId !== null && r.channel_id === channelId);
      if (sameScope) set.add(r.id);
    });
    return set;
  };

  this._assignRoleHeldRoles = [];
  const onUserRoles = (payload) => {
    if (!payload || payload.userId !== userId) return;
    this.socket.off('user-roles', onUserRoles);
    this._assignRoleHeldRoles = payload.roles || [];
    renderCheckboxes(buildHeldSet(this._assignRoleHeldRoles, scopeSel.value));
  };
  this.socket.on('user-roles', onUserRoles);
  this.socket.emit('get-user-roles', { userId });

  // Re-render checkboxes whenever scope changes so the pre-checked state
  // matches the new scope. Replace the listener on each open to avoid leaks.
  const newScopeSel = scopeSel.cloneNode(true);
  scopeSel.parentNode.replaceChild(newScopeSel, scopeSel);
  newScopeSel.addEventListener('change', () => {
    renderCheckboxes(buildHeldSet(this._assignRoleHeldRoles, newScopeSel.value));
  });

  // Initial render before server reply: show no pre-checks.
  renderCheckboxes(new Set());

  modal.style.display = 'flex';
  modal.style.zIndex = '100002';
},

};
