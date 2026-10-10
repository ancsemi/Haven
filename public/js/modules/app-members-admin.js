// Members as admins see them: the ban, banned IP and deleted user lists, the
// all members window with its actions, bulk cleanup, storage use, and the
// per-member channel picker, and the kick, ban, password reset and transfer
// admin windows.

export default {

_renderBanList(bans) {
  const list = document.getElementById('bans-list');
  if (bans.length === 0) {
    list.innerHTML = `<p class="muted-text">${t('settings.admin.no_banned_users')}</p>`;
    return;
  }
  list.innerHTML = bans.map(b => `
    <div class="ban-item${b.appeal ? ' has-appeal' : ''}">
      <div class="ban-info">
        <strong>${this._escapeHtml(b.username)}</strong>
        <span class="ban-reason">${b.reason ? this._escapeHtml(b.reason) : t('settings.admin.no_reason')}</span>
        <span class="ban-date">${this._fmtDate(b.created_at)}</span>
        ${b.appeal ? `
        <div class="ban-appeal">
          <span class="ban-appeal-label">📝 ${t('settings.admin.ban_appeal_label')}${b.appeal_at ? ' · ' + this._fmtDate(b.appeal_at) : ''}</span>
          <span class="ban-appeal-text">${this._escapeHtml(b.appeal)}</span>
        </div>` : ''}
      </div>
      <div class="ban-actions">
        <button class="btn-sm btn-unban" data-uid="${b.user_id}">${t('settings.admin.unban_btn')}</button>
        ${b.appeal ? `<button class="btn-sm btn-dismiss-appeal" data-uid="${b.user_id}" title="${t('settings.admin.dismiss_appeal_title')}">${t('settings.admin.dismiss_appeal_btn')}</button>` : ''}
        <button class="btn-sm btn-delete-user" data-uid="${b.user_id}" data-uname="${this._escapeHtml(b.username)}" title="${t('settings.admin.delete_user_title')}">🗑️</button>
      </div>
    </div>
  `).join('');

  list.querySelectorAll('.btn-unban').forEach(btn => {
    btn.addEventListener('click', () => {
      this.socket.emit('unban-user', { userId: parseInt(btn.dataset.uid) });
    });
  });

  list.querySelectorAll('.btn-dismiss-appeal').forEach(btn => {
    btn.addEventListener('click', () => {
      this.socket.emit('dismiss-ban-appeal', { userId: parseInt(btn.dataset.uid) });
    });
  });

  list.querySelectorAll('.btn-delete-user').forEach(btn => {
    btn.addEventListener('click', () => {
      const name = btn.dataset.uname;
      if (confirm(t('settings.admin.confirm_delete_user', { name }))) {
        this.socket.emit('delete-user', { userId: parseInt(btn.dataset.uid) });
      }
    });
  });
},

_renderIpBanList(bans) {
  const list = document.getElementById('ip-bans-list');
  if (!list) return;
  if (!Array.isArray(bans) || bans.length === 0) {
    list.innerHTML = `<p class="muted-text">${t('settings.admin.no_banned_ips')}</p>`;
    return;
  }
  list.innerHTML = bans.map(b => `
    <div class="ban-item">
      <div class="ban-info">
        <strong>${this._escapeHtml(b.ip)}</strong>
        <span class="ban-reason">${b.reason ? this._escapeHtml(b.reason) : t('settings.admin.no_reason')}</span>
        <span class="ban-date">${this._fmtDate(b.created_at)}${b.banned_by_name ? ` by ${this._escapeHtml(b.banned_by_name)}` : ''}</span>
      </div>
      <div class="ban-actions">
        <button class="btn-sm btn-unban" data-ip="${this._escapeHtml(b.ip)}">${t('settings.admin.unban_btn')}</button>
      </div>
    </div>
  `).join('');

  list.querySelectorAll('.btn-unban').forEach(btn => {
    btn.addEventListener('click', () => {
      this.socket.emit('unban-ip', { ip: btn.dataset.ip });
    });
  });
},

_renderDeletedUsersList(entries) {
  const list = document.getElementById('deleted-users-list');
  if (!entries || entries.length === 0) {
    list.innerHTML = `<p class="muted-text">${t('settings.admin.no_deleted_users')}</p>`;
    return;
  }
  list.innerHTML = entries.map(e => `
    <div class="ban-item">
      <div class="ban-info">
        <strong>${this._escapeHtml(e.display_name || e.username)}</strong>
        ${e.display_name ? `<span class="ban-reason">@${this._escapeHtml(e.username)}</span>` : ''}
        <span class="ban-reason">${e.reason ? this._escapeHtml(e.reason) : t('settings.admin.no_reason')}</span>
        <span class="ban-date">${this._fmtDate(e.deleted_at)}${e.deleted_by_name ? ` ${t('settings.admin.deleted_by', { name: this._escapeHtml(e.deleted_by_name) })}` : ''}</span>
      </div>
    </div>
  `).join('');
},

// ═══════════════════════════════════════════════════════
// MEMBER LIST (universal access, role-dependent actions)
// ═══════════════════════════════════════════════════════

_openAllMembersModal() {
  const modal = document.getElementById('all-members-modal');
  const list = document.getElementById('all-members-list');
  list.innerHTML = `<p class="muted-text" style="text-align:center;padding:20px">${t('modals.common.loading')}</p>`;
  document.getElementById('all-members-search').value = '';
  document.getElementById('all-members-filter').value = 'all';
  document.getElementById('all-members-count').textContent = '';
  const storageEl = document.getElementById('all-members-storage-summary');
  if (storageEl) storageEl.style.display = 'none';
  modal.style.display = 'flex';

  // Pass current channel so the server can fall back to view_channel_members
  const payload = this.currentChannel ? { channelCode: this.currentChannel } : {};
  this.socket.emit('get-all-members', payload, (res) => {
    if (res.error) {
      list.innerHTML = `<p class="muted-text" style="text-align:center;padding:20px">${this._escapeHtml(res.error)}</p>`;
      return;
    }
    this._allMembersData = res.members || [];
    this._allMembersChannels = res.allChannels || [];
    this._allMembersPerms = res.callerPerms || {};
    this._allMembersStorage = res.storageSummary || null;
    this._renderStorageSummary();
    // Update title to reflect channel-only vs all members
    const titleEl = document.querySelector('#all-members-modal [data-i18n="modals.all_members.title"]');
    if (titleEl) {
      titleEl.textContent = res.channelOnly ? t('modals.all_members.channel_title') : t('modals.all_members.title');
    }
    document.getElementById('all-members-count').textContent = `(${res.total})`;
    // Toggle moderator-only nav buttons (View Bans / View Deleted) based on perms.
    // Server-side handlers re-validate, so DOM tampering can't reveal data.
    const inviteBtn = document.getElementById('aml-view-invite-btn');
    const banBtn = document.getElementById('aml-view-bans-btn');
    const delBtn = document.getElementById('aml-view-deleted-btn');
    const cleanupBtn = document.getElementById('aml-bulk-cleanup-btn');
    if (inviteBtn) inviteBtn.style.display = (this._allMembersPerms.canInvite || this._allMembersPerms.isAdmin) ? '' : 'none';
    if (banBtn) banBtn.style.display = (this._allMembersPerms.canBan || this._allMembersPerms.isAdmin) ? '' : 'none';
    if (delBtn) delBtn.style.display = this._allMembersPerms.isAdmin ? '' : 'none';
    if (cleanupBtn) cleanupBtn.style.display = this._allMembersPerms.isAdmin ? '' : 'none';
    this._renderAllMembers(this._allMembersData);
  });
},

_filterAllMembers() {
  if (!this._allMembersData) return;
  const query = (document.getElementById('all-members-search').value || '').toLowerCase().trim();
  const filter = document.getElementById('all-members-filter').value;
  const now = Date.now();
  const sevenDays = 7 * 24 * 60 * 60 * 1000;

  let filtered = this._allMembersData;
  if (filter === 'online') filtered = filtered.filter(m => m.online && !m.banned);
  else if (filter === 'offline') filtered = filtered.filter(m => !m.online && !m.banned);
  else if (filter === 'new') filtered = filtered.filter(m => m.createdAt && (now - new Date(m.createdAt).getTime()) < sevenDays);
  else if (filter === 'banned') filtered = filtered.filter(m => m.banned);
  // "Most storage used" answers a different question from the other filters:
  // it ranks rather than narrows. Members with nothing uploaded are dropped so
  // the list is the ranking itself instead of a long tail of zeroes. (#5521)
  else if (filter === 'storage') {
    filtered = filtered
      .filter(m => m.storage && m.storage.total > 0)
      .slice()
      .sort((a, b) => b.storage.total - a.storage.total);
  }

  if (query) {
    filtered = filtered.filter(m =>
      m.username.toLowerCase().includes(query) ||
      m.displayName.toLowerCase().includes(query) ||
      (this._nicknames[m.id] || '').toLowerCase().includes(query) ||
      m.roles.some(r => r.name.toLowerCase().includes(query))
    );
  }

  document.getElementById('all-members-count').textContent = `(${filtered.length}/${this._allMembersData.length})`;
  this._renderAllMembers(filtered);
},

// Admin bot-wave cleanup. The server does the filtering and the
// guarded ban+delete; this is the filter form, a dry-run preview, and an
// explicit confirmation before anything is destroyed.
_openBulkCleanup() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay bulk-cleanup-overlay';
  overlay.style.display = 'flex';
  overlay.style.zIndex = '100002';
  overlay.innerHTML = `
    <div class="modal" style="max-width:520px">
      <div class="modal-header">
        <h4>🧹 ${t('modals.bulk_cleanup.title')}</h4>
        <button class="modal-close-btn bc-close">&times;</button>
      </div>
      <div class="modal-body">
        <p style="font-size:0.85rem;color:var(--text-muted);margin:0 0 12px 0;">${t('modals.bulk_cleanup.intro')}</p>
        <label style="display:flex;align-items:center;gap:8px;margin:8px 0;">
          <input type="checkbox" id="bc-join-enabled">
          <span>${t('modals.bulk_cleanup.joined_within')}</span>
          <input type="number" id="bc-join-hours" value="24" min="1" max="87600" class="settings-number-input" style="width:70px" disabled>
          <span>${t('modals.bulk_cleanup.hours')}</span>
        </label>
        <label style="display:flex;align-items:center;gap:8px;margin:8px 0;">
          <input type="checkbox" id="bc-zero-msgs" checked>
          <span>${t('modals.bulk_cleanup.zero_messages')}</span>
        </label>
        <label style="display:flex;align-items:center;gap:8px;margin:8px 0;">
          <input type="checkbox" id="bc-new-only">
          <span>${t('modals.bulk_cleanup.new_only')}</span>
        </label>
        <hr style="border:none;border-top:1px solid var(--border);margin:12px 0;">
        <label style="display:flex;align-items:center;gap:8px;margin:8px 0;">
          <input type="checkbox" id="bc-scrub-msgs">
          <span>${t('modals.bulk_cleanup.scrub_messages')}</span>
        </label>
        <label style="display:flex;align-items:flex-start;gap:8px;margin:8px 0;">
          <input type="checkbox" id="bc-ban-ip" style="margin-top:3px">
          <span>${t('modals.bulk_cleanup.ban_ip')}<br><small style="color:var(--text-muted)">${t('modals.bulk_cleanup.ban_ip_hint')}</small></span>
        </label>
        <div id="bc-preview" style="display:none;margin-top:12px;padding:10px 12px;border-radius:8px;background:var(--bg-tertiary);font-size:0.85rem;"></div>
      </div>
      <div class="modal-actions" style="justify-content:space-between;">
        <button class="btn-sm bc-cancel">${t('modals.common.cancel')}</button>
        <div style="display:flex;gap:8px;">
          <button class="btn-sm btn-accent bc-preview-btn">${t('modals.bulk_cleanup.preview_btn')}</button>
          <button class="btn-sm btn-danger-fill bc-confirm-btn" disabled>${t('modals.bulk_cleanup.remove_btn')}</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const $ = (sel) => overlay.querySelector(sel);
  const close = () => overlay.remove();
  $('.bc-close').addEventListener('click', close);
  $('.bc-cancel').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  const joinEnabled = $('#bc-join-enabled');
  const joinHours = $('#bc-join-hours');
  joinEnabled.addEventListener('change', () => { joinHours.disabled = !joinEnabled.checked; });

  const previewBox = $('#bc-preview');
  const confirmBtn = $('.bc-confirm-btn');

  const buildFilter = () => {
    const filter = {};
    if (joinEnabled.checked) {
      const h = parseInt(joinHours.value, 10);
      if (Number.isFinite(h) && h > 0) filter.joinedWithinHours = h;
    }
    if ($('#bc-zero-msgs').checked) filter.zeroMessages = true;
    if ($('#bc-new-only').checked) filter.newOnly = true;
    return filter;
  };

  const selectedIds = () =>
    [...overlay.querySelectorAll('.bc-user-check:checked')].map(el => parseInt(el.dataset.id, 10)).filter(Number.isInteger);

  const refreshConfirm = () => {
    const n = selectedIds().length;
    confirmBtn.disabled = n === 0;
    confirmBtn.textContent = n === 0
      ? t('modals.bulk_cleanup.remove_btn')
      : t('modals.bulk_cleanup.remove_n_btn').replace('{n}', n);
  };

  // Any filter change invalidates a prior preview so the admin can't act on a
  // stale list.
  ['#bc-join-enabled', '#bc-join-hours', '#bc-zero-msgs', '#bc-new-only'].forEach(sel => {
    $(sel).addEventListener('change', () => {
      confirmBtn.disabled = true;
      confirmBtn.textContent = t('modals.bulk_cleanup.remove_btn');
      previewBox.style.display = 'none';
    });
  });

  $('.bc-preview-btn').addEventListener('click', () => {
    const filter = buildFilter();
    if (!filter.joinedWithinHours && !filter.zeroMessages && !filter.newOnly) {
      previewBox.style.display = 'block';
      previewBox.innerHTML = `<span style="color:var(--danger)">${t('modals.bulk_cleanup.need_filter')}</span>`;
      return;
    }
    this.socket.emit('bulk-remove-users', { filter, dryRun: true }, (res) => {
      previewBox.style.display = 'block';
      if (!res || res.error) {
        previewBox.innerHTML = `<span style="color:var(--danger)">${this._escapeHtml(res && res.error ? res.error : t('settings.admin.bulk_preview_failed'))}</span>`;
        return;
      }
      const users = res.users || [];
      if (res.total === 0) {
        previewBox.innerHTML = t('modals.bulk_cleanup.no_match');
        confirmBtn.disabled = true;
        confirmBtn.textContent = t('modals.bulk_cleanup.remove_btn');
        return;
      }
      const rows = users.map(u => {
        const date = this._escapeHtml((u.createdAt || '').slice(0, 10));
        const msgs = t('modals.bulk_cleanup.msgs').replace('{n}', u.msgCount || 0);
        const flag = (u.msgCount > 0)
          ? ` <span style="color:var(--warning,#e0a800)" title="${this._escapeHtml(t('modals.bulk_cleanup.has_activity'))}">&#9873;</span>` : '';
        return `<label style="display:flex;align-items:center;gap:8px;padding:2px 0;">
            <input type="checkbox" class="bc-user-check" data-id="${u.id}" checked>
            <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${this._escapeHtml(u.username)}${flag}</span>
            <span style="color:var(--text-muted);font-size:0.8em;white-space:nowrap;">${date} &middot; ${msgs}</span>
          </label>`;
      }).join('');
      previewBox.innerHTML =
        `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">` +
          `<strong>${t('modals.bulk_cleanup.match_count').replace('{n}', res.total)}${res.capped ? ` <span style="color:var(--text-muted);font-weight:normal">(${t('modals.bulk_cleanup.capped')})</span>` : ''}</strong>` +
          `<span><button type="button" class="btn-sm bc-check-all">${t('modals.bulk_cleanup.select_all')}</button> <button type="button" class="btn-sm bc-check-none">${t('modals.bulk_cleanup.select_none')}</button></span>` +
        `</div>` +
        `<div style="color:var(--text-muted);font-size:0.8em;margin-bottom:4px;">${t('modals.bulk_cleanup.vet_hint')}</div>` +
        `<div style="max-height:220px;overflow:auto;border:1px solid var(--border);border-radius:6px;padding:6px 8px;">${rows}</div>`;
      previewBox.querySelector('.bc-check-all').addEventListener('click', () => { previewBox.querySelectorAll('.bc-user-check').forEach(c => { c.checked = true; }); refreshConfirm(); });
      previewBox.querySelector('.bc-check-none').addEventListener('click', () => { previewBox.querySelectorAll('.bc-user-check').forEach(c => { c.checked = false; }); refreshConfirm(); });
      previewBox.querySelectorAll('.bc-user-check').forEach(c => c.addEventListener('change', refreshConfirm));
      refreshConfirm();
    });
  });

  confirmBtn.addEventListener('click', () => {
    const ids = selectedIds();
    if (ids.length === 0) return;
    if (!confirm(t('modals.bulk_cleanup.confirm').replace('{n}', ids.length))) return;
    confirmBtn.disabled = true;
    confirmBtn.textContent = t('modals.bulk_cleanup.working');
    this.socket.emit('bulk-remove-users', {
      userIds: ids,
      scrubMessages: $('#bc-scrub-msgs').checked,
      banIp: $('#bc-ban-ip').checked
    }, (res) => {
      if (!res || res.error) {
        if (this._showToast) this._showToast(res && res.error ? res.error : t('modals.bulk_cleanup.failed'), 'error', 6000);
        confirmBtn.disabled = false;
        refreshConfirm();
        return;
      }
      close();
      const extra = res.ipBanned ? ` (${res.ipBanned} IP${res.ipBanned === 1 ? '' : 's'})` : '';
      if (this._showToast) this._showToast(t('modals.bulk_cleanup.done').replace('{n}', res.removed) + extra, 'success', 5000);
      const membersModal = document.getElementById('all-members-modal');
      if (membersModal && membersModal.style.display === 'flex') this._openAllMembersModal();
    });
  });
},

_renderAllMembers(members) {
  const list = document.getElementById('all-members-list');
  if (!members || members.length === 0) {
    list.innerHTML = `<p class="muted-text" style="text-align:center;padding:20px">${t('settings.admin.no_members_found')}</p>`;
    return;
  }

  const perms = this._allMembersPerms || {};
  const isSelf = (id) => id === this.user.id;

  list.innerHTML = members.map(m => {
    const rolesHtml = m.roles.map(r =>
      `<span class="aml-role-badge" style="border-color:${this._safeColor(r.color, '#888')};color:${this._safeColor(r.color, '#888')}">${this._roleNameHtml(r, r.name)}</span>`
    ).join('');
    const adminBadge = m.isAdmin ? `<span class="aml-admin-badge">${t('settings.admin.badge_admin')}</span>` : '';
    const bannedBadge = m.banned ? `<span class="aml-banned-badge">${t('settings.admin.badge_banned')}</span>` : '';
    const onlineDot = m.online && !m.banned ? 'aml-online' : 'aml-offline';
    const created = m.createdAt ? new Date(m.createdAt.endsWith('Z') ? m.createdAt : m.createdAt + 'Z') : null;
    const joinedStr = created ? this._fmtDate(created) : '';
    const isNew = created && (Date.now() - created.getTime()) < 7 * 24 * 60 * 60 * 1000;
    const newBadge = isNew ? `<span class="aml-new-badge">${t('settings.admin.badge_new')}</span>` : '';

    // Storage consumed (#5521). Only moderators get a `storage` object at all,
    // so a member viewing this list simply sees no chip. The breakdown goes in
    // the tooltip: DM attachments are encrypted, so their size is all the
    // server knows about them and all this can ever report.
    let storageHtml = '';
    if (m.storage && m.storage.total > 0) {
      const parts = [];
      if (m.storage.channel) parts.push(t('settings.admin.storage_public', { size: this._formatFileSize(m.storage.channel) }));
      if (m.storage.dm) parts.push(t('settings.admin.storage_private', { size: this._formatFileSize(m.storage.dm) }));
      if (m.storage.profile) parts.push(t('settings.admin.storage_profile', { size: this._formatFileSize(m.storage.profile) }));
      const title = t('settings.admin.storage_tooltip', { files: m.storage.files, breakdown: parts.join(', ') });
      storageHtml = `<span class="aml-member-storage" title="${this._escapeHtml(title)}">💾 ${this._escapeHtml(this._formatFileSize(m.storage.total))}</span>`;
    }

    const avatarUrl = m.avatar ? m.avatar : '';
    const avatarShape = m.avatarShape === 'square' ? 'border-radius:4px' : 'border-radius:50%';
    const avatarHtml = avatarUrl
      ? `<img src="${this._escapeHtml(avatarUrl)}" class="aml-avatar" style="${avatarShape}" alt="">`
      : `<div class="aml-avatar aml-avatar-default" style="${avatarShape}">${this._escapeHtml(m.displayName.charAt(0).toUpperCase())}</div>`;

    // Build action buttons based on caller permissions (never show for self)
    let actionsHtml = '';
    if (!isSelf(m.id)) {
      let btns = '';
      // Always-available: DM and Nickname
      btns += `<button class="aml-action-btn aml-btn-dm" data-uid="${m.id}" data-uname="${this._escapeHtml(m.displayName)}" title="${t('users.direct_message')}">💬</button>`;
      btns += `<button class="aml-action-btn aml-btn-nick" data-uid="${m.id}" data-uname="${this._escapeHtml(m.username)}" data-dname="${this._escapeHtml(m.displayName)}" title="${t('users.set_nickname')}">🏷️</button>`;
      if (perms.canPromote && !m.banned) {
        btns += `<button class="aml-action-btn aml-btn-role" data-uid="${m.id}" data-uname="${this._escapeHtml(m.username)}" title="${t('users.gear_menu.assign_role')}">👑</button>`;
      }
      if (perms.canKick && !m.banned) {
        btns += `<button class="aml-action-btn aml-btn-addch" data-uid="${m.id}" data-uname="${this._escapeHtml(m.username)}" title="${t('settings.admin.add_to_channel_title')}">➕</button>`;
        btns += `<button class="aml-action-btn aml-btn-remch" data-uid="${m.id}" data-uname="${this._escapeHtml(m.username)}" title="${t('settings.admin.remove_from_channel_title')}">➖</button>`;
      }
      if (perms.canBan && !m.banned) {
        btns += `<button class="aml-action-btn aml-btn-ban" data-uid="${m.id}" data-uname="${this._escapeHtml(m.username)}" title="${t('settings.admin.ban_from_server_title')}">⛔</button>`;
      }
      if (perms.isAdmin && m.banned) {
        btns += `<button class="aml-action-btn aml-btn-unban" data-uid="${m.id}" data-uname="${this._escapeHtml(m.username)}" title="${t('settings.admin.unban_btn')}">✅</button>`;
      }
      if (perms.isAdmin && !m.isAdmin) {
        btns += `<button class="aml-action-btn aml-btn-delete" data-uid="${m.id}" data-uname="${this._escapeHtml(m.username)}" title="${t('settings.admin.delete_from_server_title')}">🗑️</button>`;
      }
      actionsHtml = `<div class="aml-actions">${btns}</div>`;
    } else if (perms.isAdmin) {
      // Only the admin may manage their own roles.
      actionsHtml = `<div class="aml-actions"><button class="aml-action-btn aml-btn-role" data-uid="${m.id}" data-uname="${this._escapeHtml(m.username)}" title="${t('users.gear_menu.assign_role')}">👑</button></div>`;
    }

    return `<div class="aml-member-row">
      <div class="aml-member-left">
        <div class="aml-avatar-wrap">
          ${avatarHtml}
          <span class="aml-status-dot ${onlineDot}"></span>
        </div>
        <div class="aml-member-info">
          <div class="aml-member-name">
            ${this._escapeHtml(this._getNickname(m.id, m.displayName))}${m.username !== m.displayName ? ` <span class="aml-login-name">@${this._escapeHtml(m.username)}</span>` : ''}${this._nicknames[m.id] ? ` <span class="aml-login-name">(${this._escapeHtml(m.displayName)})</span>` : ''}
            ${adminBadge}${bannedBadge}${newBadge}
          </div>
          <div class="aml-member-meta">
            ${rolesHtml}
            <span class="aml-member-joined">${joinedStr ? t('settings.admin.joined_date', { date: joinedStr }) : ''}</span>
            ${m.channels > 0 ? `<span class="aml-member-channels">${t(m.channels === 1 ? 'settings.admin.channel_count_one' : 'settings.admin.channel_count_other', { count: m.channels })}</span>` : ''}
            ${storageHtml}
          </div>
        </div>
      </div>
      ${actionsHtml}
    </div>`;
  }).join('');

  // Bind action buttons
  this._bindMemberListActions(list);
},

// Server-wide upload totals under the search box. The unattributed figure is
// the honest part of this: files uploaded before per-member accounting existed
// have no owner on record, and guessing an owner would be worse than saying so.
_renderStorageSummary() {
  const el = document.getElementById('all-members-storage-summary');
  if (!el) return;
  const summary = this._allMembersStorage;
  if (!summary || !summary.liveBytes) { el.style.display = 'none'; return; }

  let text = t('settings.admin.storage_summary', {
    total: this._formatFileSize(summary.liveBytes),
    files: summary.fileCount
  });
  if (summary.unattributedBytes > 0) {
    text += ' ' + t('settings.admin.storage_summary_unattributed', {
      size: this._formatFileSize(summary.unattributedBytes)
    });
  }
  el.textContent = text;
  el.style.display = '';
},

_bindMemberListActions(container) {
  const self = this;

  // DM (Send Message)
  container.querySelectorAll('.aml-btn-dm').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const uid = parseInt(btn.dataset.uid);
      self.socket.emit('start-dm', { targetUserId: uid });
      document.getElementById('all-members-modal').style.display = 'none';
      self._showToast(t('users.opening_dm', { name: btn.dataset.uname }), 'info');
    });
  });

  // Set Nickname
  container.querySelectorAll('.aml-btn-nick').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const uid = parseInt(btn.dataset.uid);
      const uname = btn.dataset.uname;
      const dname = btn.dataset.dname;
      self._showNicknameDialog(uid, uname, dname);
    });
  });

  // Assign Role
  container.querySelectorAll('.aml-btn-role').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const uid = parseInt(btn.dataset.uid);
      document.getElementById('all-members-modal').style.display = 'none';
      self._openRoleAssignCenter(uid);
    });
  });

  // Add to Channel
  container.querySelectorAll('.aml-btn-addch').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const uid = parseInt(btn.dataset.uid);
      const uname = btn.dataset.uname;
      self._openMemberChannelPicker(uid, uname, 'add');
    });
  });

  // Remove from Channel
  container.querySelectorAll('.aml-btn-remch').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const uid = parseInt(btn.dataset.uid);
      const uname = btn.dataset.uname;
      self._openMemberChannelPicker(uid, uname, 'remove');
    });
  });

  // Ban
  container.querySelectorAll('.aml-btn-ban').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const uid = parseInt(btn.dataset.uid);
      const uname = btn.dataset.uname;
      self._showAdminActionModal('ban', uid, uname);
    });
  });

  // Unban
  container.querySelectorAll('.aml-btn-unban').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const uid = parseInt(btn.dataset.uid);
      self.socket.emit('unban-user', { userId: uid });
      self._showToast(t('settings.admin.user_unbanned'), 'success');
      setTimeout(() => self._openAllMembersModal(), 500);
    });
  });

  // Delete
  container.querySelectorAll('.aml-btn-delete').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const uid = parseInt(btn.dataset.uid);
      const uname = btn.dataset.uname;
      self._showAdminActionModal('delete-user', uid, uname);
    });
  });
},

_openMemberChannelPicker(userId, username, mode, channelsOverride = null) {
  // mode: 'add' or 'remove'. channelsOverride is a ready-made [{ id, name }]
  // list for callers outside Settings, All Members (the user context menu),
  // where the member and channel tables are not loaded. The server rejects
  // channels the user is already in, so no pre-filter is needed there (#5637).
  const member = (this._allMembersData || []).find(m => m.id === userId);
  const allChannels = this._allMembersChannels || [];
  const memberChannelIds = new Set((member && member.channelList ? member.channelList : []).map(c => c.id));

  let channels;
  if (Array.isArray(channelsOverride)) {
    channels = channelsOverride;
  } else if (mode === 'add') {
    // Show channels user is NOT in (top-level only for clarity)
    channels = allChannels.filter(c => !memberChannelIds.has(c.id) && !c.parentId);
  } else {
    // Show channels user IS in
    channels = (member && member.channelList ? member.channelList : []);
  }

  if (channels.length === 0) {
    this._showToast(mode === 'add' ? t('settings.admin.already_in_all_channels', { name: username }) : t('settings.admin.not_in_any_channels', { name: username }), 'info');
    return;
  }

  // Build a picker overlay
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay aml-channel-picker-overlay';
  overlay.style.display = 'flex';
  overlay.style.zIndex = '100002';

  const title = mode === 'add'
    ? t('settings.admin.picker_add_title', { name: this._escapeHtml(username) })
    : t('settings.admin.picker_remove_title', { name: this._escapeHtml(username) });

  const allCheckboxId = `aml-ch-all-${userId}-${mode}`;
  const searchId = `aml-ch-search-${userId}-${mode}`;
  const isAdd = mode === 'add';

  overlay.innerHTML = `
    <div class="modal aml-ch-picker">
      <div class="aml-ch-picker-header">
        <h4 class="aml-ch-picker-title">${title}</h4>
        <label class="aml-ch-picker-selectall">
          <input type="checkbox" id="${allCheckboxId}">
          <span>${t('settings.admin.select_all')}</span>
        </label>
      </div>
      <div class="aml-ch-picker-subtitle">
        <span class="aml-ch-picker-count">0 / ${channels.length}</span>
        <input type="search" id="${searchId}" class="aml-ch-picker-search"
               placeholder="${t('settings.admin.filter_channels')}">
      </div>
      <div class="aml-channel-list">
        ${channels.map(c => `
          <label class="aml-channel-row" data-name-lower="${this._escapeHtml((c.name || '').toLowerCase())}">
            <input type="checkbox" class="aml-ch-check" value="${c.id}" data-name="${this._escapeHtml(c.name)}">
            <span class="aml-ch-hash">#</span>
            <span class="aml-ch-name">${this._escapeHtml(c.name)}</span>
          </label>
        `).join('')}
      </div>
      <div class="modal-actions aml-ch-picker-actions">
        <button class="btn-sm aml-ch-cancel">${t('modals.common.cancel')}</button>
        <button class="btn-sm ${isAdd ? 'btn-accent' : 'btn-danger'} aml-ch-confirm" disabled>
          ${isAdd ? t('settings.admin.picker_confirm_add') : t('settings.admin.picker_confirm_remove')}
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  // Select All checkbox + count + filter wiring
  const allCheck = overlay.querySelector(`#${allCheckboxId}`);
  const checks = overlay.querySelectorAll('.aml-ch-check');
  const confirmBtn = overlay.querySelector('.aml-ch-confirm');
  const countEl = overlay.querySelector('.aml-ch-picker-count');
  const search = overlay.querySelector(`#${searchId}`);

  const updateState = () => {
    const visible = [...checks].filter(cb => cb.closest('.aml-channel-row').style.display !== 'none');
    const checked = visible.filter(cb => cb.checked);
    countEl.textContent = `${checked.length} / ${visible.length}`;
    confirmBtn.disabled = checked.length === 0;
    allCheck.checked = visible.length > 0 && checked.length === visible.length;
    allCheck.indeterminate = checked.length > 0 && checked.length < visible.length;
  };

  allCheck.addEventListener('change', () => {
    checks.forEach(cb => {
      if (cb.closest('.aml-channel-row').style.display !== 'none') cb.checked = allCheck.checked;
    });
    updateState();
  });
  checks.forEach(cb => cb.addEventListener('change', updateState));

  if (search) {
    search.addEventListener('input', () => {
      const q = search.value.trim().toLowerCase();
      overlay.querySelectorAll('.aml-channel-row').forEach(row => {
        const name = row.dataset.nameLower || '';
        row.style.display = !q || name.includes(q) ? '' : 'none';
      });
      updateState();
    });
  }
  updateState();

  // Close
  overlay.querySelector('.aml-ch-cancel').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  // Confirm
  overlay.querySelector('.aml-ch-confirm').addEventListener('click', () => {
    const selected = [...checks].filter(cb => cb.checked).map(cb => ({
      id: parseInt(cb.value),
      name: cb.dataset.name
    }));
    if (selected.length === 0) {
      this._showToast(t('settings.admin.select_channel_warning'), 'warning');
      return;
    }
    overlay.remove();

    let completed = 0;
    selected.forEach(ch => {
      if (mode === 'add') {
        this.socket.emit('invite-to-channel', { targetUserId: userId, channelId: ch.id });
      } else {
        this.socket.emit('remove-from-channel', { userId, channelId: ch.id }, (res) => {
          if (res && res.error) this._showToast(res.error, 'error');
        });
      }
      completed++;
    });

    const toastKey = mode === 'add'
      ? (selected.length === 1 ? 'settings.admin.channels_added_one' : 'settings.admin.channels_added_other')
      : (selected.length === 1 ? 'settings.admin.channels_removed_one' : 'settings.admin.channels_removed_other');
    this._showToast(t(toastKey, { count: selected.length }), 'success');
    // Refresh after a short delay
    setTimeout(() => this._openAllMembersModal(), 800);
  });
},

// ═══════════════════════════════════════════════════════
// ADMIN MODERATION UI
// ═══════════════════════════════════════════════════════

_showAdminActionModal(action, userId, username) {
  this.adminActionTarget = { action, userId, username };
  const modal = document.getElementById('admin-action-modal');
  const title = document.getElementById('admin-action-title');
  const desc = document.getElementById('admin-action-desc');
  const durationGroup = document.getElementById('admin-duration-group');
  const scrubGroup = document.getElementById('admin-scrub-group');
  const scrubCheckbox = document.getElementById('admin-scrub-checkbox');
  const scrubScopeRow = document.getElementById('admin-scrub-scope-row');
  const confirmBtn = document.getElementById('confirm-admin-action-btn');

  const labels = {
    kick: t('modals.admin_action.label_kick'),
    ban: t('modals.admin_action.label_ban'),
    mute: t('modals.admin_action.label_mute'),
    'delete-user': t('modals.admin_action.label_delete_user')
  };
  title.textContent = `${labels[action] || action}: ${username}`;
  desc.textContent = action === 'ban'
    ? t('modals.admin_action.desc_ban')
    : action === 'mute'
      ? t('modals.admin_action.desc_mute')
      : action === 'delete-user'
        ? t('modals.admin_action.desc_delete_user')
        : t('modals.admin_action.desc_kick');

  durationGroup.style.display = action === 'mute' ? 'block' : 'none';

  // Show scrub option for kick, ban, and delete-user
  const hasScrub = ['kick', 'ban', 'delete-user'].includes(action);
  scrubGroup.style.display = hasScrub ? 'block' : 'none';
  scrubCheckbox.checked = false;
  // Kick gets scope dropdown (channel vs server), ban/delete are server-wide only
  scrubScopeRow.style.display = 'none';
  if (action === 'kick') {
    scrubCheckbox.onchange = () => { scrubScopeRow.style.display = scrubCheckbox.checked ? 'block' : 'none'; };
  } else {
    scrubCheckbox.onchange = null;
  }

  // Purge option: replace messages with placeholder. Ban-only for now —
  // it's a softer, less destructive alternative to scrub. Mutually exclusive
  // with scrub (you can't both delete and replace the same messages).
  const purgeGroup = document.getElementById('admin-purge-group');
  const purgeCheckbox = document.getElementById('admin-purge-checkbox');
  const purgeMessageRow = document.getElementById('admin-purge-message-row');
  const purgeMessageInput = document.getElementById('admin-purge-message');
  if (purgeGroup) {
    purgeGroup.style.display = action === 'ban' ? 'block' : 'none';
    if (purgeCheckbox) purgeCheckbox.checked = false;
    if (purgeMessageRow) purgeMessageRow.style.display = 'none';
    if (purgeMessageInput) purgeMessageInput.value = '';
    if (purgeCheckbox && action === 'ban') {
      purgeCheckbox.onchange = () => {
        if (purgeMessageRow) purgeMessageRow.style.display = purgeCheckbox.checked ? 'block' : 'none';
        // Mutually exclusive with scrub
        if (purgeCheckbox.checked && scrubCheckbox.checked) {
          scrubCheckbox.checked = false;
          if (scrubScopeRow) scrubScopeRow.style.display = 'none';
        }
      };
      const origScrubChange = scrubCheckbox.onchange;
      scrubCheckbox.onchange = () => {
        if (typeof origScrubChange === 'function') origScrubChange();
        if (scrubCheckbox.checked && purgeCheckbox.checked) {
          purgeCheckbox.checked = false;
          if (purgeMessageRow) purgeMessageRow.style.display = 'none';
        }
      };
    }
  }

  confirmBtn.textContent = labels[action] || t('modals.common.confirm');

  // IP-ban option: visible only for the ban action, and only when the current
  // user has either admin or the ban_ip permission. Default to unchecked.
  const banIpGroup = document.getElementById('admin-ban-ip-group');
  const banIpCheckbox = document.getElementById('admin-ban-ip-checkbox');
  if (banIpGroup) {
    // ban_ip is a server-wide permission, so it arrives in globalPermissions;
    // checking only `permissions` (the channel-scoped set) meant the option
    // stayed hidden for moderators who genuinely held it. (v3.43.0)
    const _has = (p) => {
      if (!this.user) return false;
      if (this.user.isAdmin) return true;
      const scoped = Array.isArray(this.user.permissions) ? this.user.permissions : [];
      const global = Array.isArray(this.user.globalPermissions) ? this.user.globalPermissions : [];
      return scoped.includes('*') || global.includes('*') || scoped.includes(p) || global.includes(p);
    };
    const canBanIp = _has('ban_ip');
    banIpGroup.style.display = (action === 'ban' && canBanIp) ? 'block' : 'none';
    if (banIpCheckbox) banIpCheckbox.checked = false;
  }

  document.getElementById('admin-action-reason').value = '';
  document.getElementById('admin-action-duration').value = '10';
  document.getElementById('admin-scrub-scope').value = 'channel';
  modal.style.display = 'flex';
  modal.style.zIndex = '100002';
},

// ── Admin password reset (#5300) ───────────────────────
// Three-stage flow: (1) confirm with explicit DM-loss warning and
// escape-hatch explanation, (2) emit socket event to server which
// gates on the target user having 2FA enabled, (3) reveal modal that
// shows the temp password once for the admin to transmit out-of-band.
_confirmAdminResetPassword(userId, username) {
  this._hideUserContextMenu();
  this._closeProfilePopup();
  const safeName = this._escapeHtml(username);
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay admin-reset-pw-overlay';
  overlay.style.display = 'flex';
  overlay.style.zIndex = '100002';
  overlay.innerHTML = `
    <div class="modal admin-reset-pw-modal">
      <div class="modal-header">
        <h4>🔑 ${t('modals.admin_reset_pw.title')}</h4>
        <button class="modal-close-btn admin-reset-pw-close">&times;</button>
      </div>
      <div class="modal-body">
        <p>${t('modals.admin_reset_pw.confirm_prompt').replace('{username}', safeName)}</p>
        <div style="background:rgba(231,76,60,0.12);border:1px solid rgba(231,76,60,0.4);border-radius:8px;padding:8px 12px;margin:10px 0;font-size:0.85rem;">
          <strong>⚠️ ${t('modals.admin_reset_pw.dm_warning_title')}</strong>
          <p style="margin:6px 0 0 0;">${t('modals.admin_reset_pw.dm_warning_body')}</p>
        </div>
        <div style="background:rgba(241,196,15,0.12);border:1px solid rgba(241,196,15,0.4);border-radius:8px;padding:8px 12px;margin:10px 0;font-size:0.85rem;">
          <strong>🔐 ${t('modals.admin_reset_pw.mfa_required_title')}</strong>
          <p style="margin:6px 0 0 0;">${t('modals.admin_reset_pw.mfa_required_body')}</p>
        </div>
        <p style="font-size:0.8rem;color:var(--text-muted);margin-top:8px;">${t('modals.admin_reset_pw.transmit_hint')}</p>
      </div>
      <div class="modal-actions">
        <button class="btn-sm admin-reset-pw-cancel">${t('modals.common.cancel')}</button>
        <button class="btn-sm btn-accent btn-danger-fill admin-reset-pw-confirm">${t('modals.admin_reset_pw.confirm_btn')}</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector('.admin-reset-pw-close').addEventListener('click', close);
  overlay.querySelector('.admin-reset-pw-cancel').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('.admin-reset-pw-confirm').addEventListener('click', () => {
    const confirmBtn = overlay.querySelector('.admin-reset-pw-confirm');
    confirmBtn.disabled = true;
    confirmBtn.textContent = t('modals.admin_reset_pw.working');
    this.socket.emit('admin-reset-user-password', { userId }, (resp) => {
      close();
      if (!resp || resp.error) {
        // The 2FA gate (#5300) is intended behavior, not a failure. Showing it
        // as a red error toast made people think the feature was broken (#5451),
        // so explain it calmly in its own info modal instead.
        if (resp?.code === 'mfa_required') {
          this._showAdminResetMfaRequired(username);
          return;
        }
        const msg = resp?.error || t('modals.admin_reset_pw.errors.generic');
        if (this._showToast) this._showToast(msg, 'error', 8000);
        else alert(msg);
        return;
      }
      this._showAdminResetPwReveal(resp.username, resp.tempPassword);
    });
  });
},

// Shown when an admin tries to reset the password of a user who has not yet
// enabled 2FA. This is a deliberate security requirement (#5300), not a bug,
// so it gets a plain informational modal that says exactly why and what to do
// next, rather than a red error toast that reads like something broke (#5451).
_showAdminResetMfaRequired(username) {
  const safeName = this._escapeHtml(username);
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay admin-reset-mfa-overlay';
  overlay.style.display = 'flex';
  overlay.style.zIndex = '100003';
  overlay.innerHTML = `
    <div class="modal admin-reset-mfa-modal">
      <div class="modal-header">
        <h4>🔐 ${t('modals.admin_reset_pw.mfa_required_title')}</h4>
        <button class="modal-close-btn admin-reset-mfa-close">&times;</button>
      </div>
      <div class="modal-body">
        <p>${t('modals.admin_reset_pw.mfa_blocked_prompt').replace('{username}', safeName)}</p>
        <div style="background:rgba(52,152,219,0.12);border:1px solid rgba(52,152,219,0.4);border-radius:8px;padding:8px 12px;margin:10px 0;font-size:0.85rem;">
          <strong>💡 ${t('modals.admin_reset_pw.mfa_blocked_why_title')}</strong>
          <p style="margin:6px 0 0 0;">${t('modals.admin_reset_pw.mfa_blocked_why_body')}</p>
        </div>
        <p style="font-size:0.85rem;color:var(--text-muted);margin-top:8px;">${t('modals.admin_reset_pw.mfa_blocked_action').replace('{username}', safeName)}</p>
      </div>
      <div class="modal-actions">
        <button class="btn-sm btn-accent admin-reset-mfa-ok" type="button">${t('modals.common.got_it')}</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector('.admin-reset-mfa-close').addEventListener('click', close);
  overlay.querySelector('.admin-reset-mfa-ok').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
},

_showAdminResetPwReveal(username, tempPassword) {
  const safeName = this._escapeHtml(username);
  const safePw = this._escapeHtml(tempPassword);
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay admin-reset-pw-reveal-overlay';
  overlay.style.display = 'flex';
  overlay.style.zIndex = '100003';
  overlay.innerHTML = `
    <div class="modal admin-reset-pw-reveal-modal">
      <div class="modal-header">
        <h4>🔑 ${t('modals.admin_reset_pw.reveal_title')}</h4>
      </div>
      <div class="modal-body">
        <p>${t('modals.admin_reset_pw.reveal_prompt').replace('{username}', safeName)}</p>
        <div style="display:flex;gap:8px;align-items:center;margin:12px 0;">
          <code id="admin-reset-pw-value" style="flex:1;font-family:monospace;font-size:1.2rem;letter-spacing:0.05em;padding:10px 12px;background:var(--bg-secondary,#222);border:1px solid var(--border-color,#444);border-radius:6px;user-select:all;">${safePw}</code>
          <button class="btn-sm admin-reset-pw-copy" type="button">📋 ${t('modals.common.copy')}</button>
        </div>
        <div style="background:rgba(231,76,60,0.12);border:1px solid rgba(231,76,60,0.4);border-radius:8px;padding:8px 12px;font-size:0.85rem;">
          <strong>⚠️ ${t('modals.admin_reset_pw.reveal_warning_title')}</strong>
          <p style="margin:6px 0 0 0;">${t('modals.admin_reset_pw.reveal_warning_body')}</p>
        </div>
      </div>
      <div class="modal-actions">
        <button class="btn-sm btn-accent admin-reset-pw-reveal-close" type="button">${t('modals.common.done')}</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector('.admin-reset-pw-reveal-close').addEventListener('click', close);
  overlay.querySelector('.admin-reset-pw-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(tempPassword);
      const btn = overlay.querySelector('.admin-reset-pw-copy');
      const orig = btn.textContent;
      btn.textContent = '✓ ' + t('modals.common.copied');
      setTimeout(() => { btn.textContent = orig; }, 1500);
    } catch {
      if (this._showToast) this._showToast(t('modals.common.copy_failed'), 'error');
    }
  });
},

_confirmTransferAdmin(userId, username) {
  // Build a custom modal for transfer admin with a confirmation step.
  // An SSO admin has no Haven password, so they confirm with an authenticator
  // code instead. The server decides which it will accept and rejects the
  // wrong one, this only picks which field to put in front of you. (#5539)
  this._hideUserContextMenu();
  const ssoConfirm = !!this.user?.isSso;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay transfer-admin-overlay';
  overlay.style.display = 'flex';
  overlay.innerHTML = `
    <div class="modal transfer-admin-modal">
      <div class="modal-header">
        <h4>🔑 ${t('modals.transfer_admin.title')}</h4>
        <button class="modal-close-btn transfer-admin-close">&times;</button>
      </div>
      <div class="modal-body">
        <div class="transfer-admin-warning">
          <div class="transfer-admin-warning-icon">⚠️</div>
          <div class="transfer-admin-warning-text">
            ${t('modals.transfer_admin.warning', { username: this._escapeHtml(username) })}
          </div>
        </div>
        <p class="transfer-admin-note">${t('modals.transfer_admin.note')}</p>
        <div class="form-group">
          <label class="form-label">${ssoConfirm ? t('modals.transfer_admin.totp_label') : t('modals.transfer_admin.password_label')}</label>
          <input type="${ssoConfirm ? 'text' : 'password'}" id="transfer-admin-pw" class="form-input" placeholder="${ssoConfirm ? t('modals.transfer_admin.totp_placeholder') : t('modals.transfer_admin.password_placeholder')}" ${ssoConfirm ? 'inputmode="numeric" maxlength="6" autocomplete="one-time-code"' : 'autocomplete="current-password"'}>
        </div>
        <p id="transfer-admin-error" class="transfer-admin-error"></p>
      </div>
      <div class="modal-footer">
        <button class="btn-secondary transfer-admin-cancel">${t('modals.common.cancel')}</button>
        <button class="btn-danger-fill transfer-admin-confirm">${t('modals.transfer_admin.confirm_btn')}</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const pwInput = overlay.querySelector('#transfer-admin-pw');
  const errorEl = overlay.querySelector('#transfer-admin-error');
  const confirmBtn = overlay.querySelector('.transfer-admin-confirm');
  const close = () => overlay.remove();

  overlay.querySelector('.transfer-admin-close').addEventListener('click', close);
  overlay.querySelector('.transfer-admin-cancel').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  pwInput.focus();
  pwInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') confirmBtn.click(); });

  confirmBtn.addEventListener('click', () => {
    const secret = pwInput.value.trim();
    if (!secret) {
      errorEl.textContent = ssoConfirm
        ? t('modals.transfer_admin.error_totp_required')
        : t('modals.transfer_admin.error_required');
      errorEl.style.display = '';
      pwInput.focus();
      return;
    }
    confirmBtn.disabled = true;
    confirmBtn.textContent = t('modals.transfer_admin.transferring');
    const payload = ssoConfirm ? { userId, totpCode: secret } : { userId, password: secret };
    this.socket.emit('transfer-admin', payload, (res) => {
      if (res && res.error) {
        errorEl.textContent = res.error;
        errorEl.style.display = '';
        confirmBtn.disabled = false;
        confirmBtn.textContent = t('modals.transfer_admin.confirm_btn');
        pwInput.value = '';
        pwInput.focus();
      } else if (res && res.success) {
        close();
        this._showToast(t('modals.transfer_admin.success'), 'info');
      }
    });
  });
},

};
