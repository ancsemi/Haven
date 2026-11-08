// "Add members" in a channel's right-click menu: pick people to add, one by
// one, a whole role at a time, or everyone. The server side is
// src/socketHandlers/channelAddAll.js.

export default {
  // Who sees the menu item. The server checks again when it is used.
  _canAddChannelMembers(ch) {
    if (!ch || ch.is_dm) return false;
    if (this.user?.isAdmin) return true;
    if (ch.is_private || ch.code_visibility === 'private') return !!ch.canInvitePrivate;
    return !!(this._hasGlobalPerm?.('invite_users') || this._hasGlobalPerm?.('manage_server'));
  },

  _openAddChannelMembers(code) {
    this.socket.emit('get-channel-add-members', { code }, (res) => {
      if (!res || res.error) return this._showToast(res?.error || t('channels.add_members_failed'), 'error');
      this._showAddMembersPicker(code, res);
    });
  },

  _showAddMembersPicker(code, { channel, users, roles }) {
    const esc = (s) => this._escapeHtml(String(s ?? ''));
    const addable = users.filter(u => !u.inChannel);
    if (!addable.length) return this._showToast(t('channels.add_members_everyone_in'), 'info');

    const roleRows = roles.map(r => {
      const count = addable.filter(u => u.roles.includes(r.id)).length;
      if (!count) return '';
      return `<label class="am-role"><input type="checkbox" data-role="${r.id}">
        <span class="role-color-dot" style="background:${esc(this._safeColor(r.color, '#aaa'))}"></span>${esc(r.name)} <span class="muted-text">${count}</span></label>`;
    }).join('');
    const userRows = users.map(u => `
      <label class="am-user${u.inChannel ? ' am-in' : ''}" data-name="${esc(`${u.displayName} ${u.username}`.toLowerCase())}">
        <input type="checkbox" data-user="${u.id}"${u.inChannel ? ' checked disabled' : ''}>
        <span class="am-name">${esc(u.displayName)}</span>${u.displayName !== u.username ? ` <span class="muted-text">@${esc(u.username)}</span>` : ''}
        ${u.inChannel ? `<span class="am-here">${esc(t('channels.add_members_here'))}</span>` : ''}
      </label>`).join('');

    const body = `<div class="am-picker">
      <input type="search" class="settings-text-input am-search" placeholder="${esc(t('channels.add_members_search'))}">
      <label class="am-all"><input type="checkbox" class="am-all-box"> ${esc(t('channels.add_members_all'))} <span class="muted-text">${addable.length}</span></label>
      ${roleRows ? `<div class="am-label">${esc(t('channels.add_members_roles'))}</div><div class="am-roles">${roleRows}</div>` : ''}
      <div class="am-label">${esc(t('channels.add_members_people'))}</div>
      <div class="am-users">${userRows}</div>
    </div>`;

    const ov = this._openToolModal({
      title: esc(t('channels.add_members_title', { name: channel.name })),
      body,
      confirmText: esc(t('channels.add_members_confirm')),
      onConfirm: () => new Promise((resolve) => {
        const userIds = picked();
        if (!userIds.length) { this._showToast(t('channels.add_members_none'), 'error'); return resolve(false); }
        this.socket.emit('add-channel-members', { code, userIds }, (r) => {
          if (!r || r.error) { this._showToast(r?.error || t('channels.add_members_failed'), 'error'); return resolve(false); }
          this._showToast(t('channels.add_members_done', { count: r.added, name: channel.name }), 'success');
          resolve(true);
        });
      }),
    });

    const boxes = [...ov.querySelectorAll('input[data-user]:not(:disabled)')];
    const byId = new Map(boxes.map(b => [Number(b.dataset.user), b]));
    const holders = new Map(roles.map(r => [r.id, addable.filter(u => u.roles.includes(r.id)).map(u => byId.get(u.id)).filter(Boolean)]));
    const allBox = ov.querySelector('.am-all-box');
    const confirm = ov.querySelector('.tool-confirm');
    const picked = () => boxes.filter(b => b.checked).map(b => Number(b.dataset.user));

    // Each group box shows all, some or none of its people ticked.
    const reflect = (box, group) => {
      const on = group.filter(b => b.checked).length;
      box.checked = on > 0 && on === group.length;
      box.indeterminate = on > 0 && on < group.length;
    };
    const refresh = () => {
      reflect(allBox, boxes);
      ov.querySelectorAll('input[data-role]').forEach(rb => reflect(rb, holders.get(Number(rb.dataset.role)) || []));
      const n = picked().length;
      confirm.textContent = n ? t('channels.add_members_confirm_count', { count: n }) : t('channels.add_members_confirm');
    };

    allBox.addEventListener('change', () => { boxes.forEach(b => { b.checked = allBox.checked; }); refresh(); });
    ov.querySelectorAll('input[data-role]').forEach(rb => rb.addEventListener('change', () => {
      (holders.get(Number(rb.dataset.role)) || []).forEach(b => { b.checked = rb.checked; });
      refresh();
    }));
    boxes.forEach(b => b.addEventListener('change', refresh));
    ov.querySelector('.am-search').addEventListener('input', (e) => {
      const q = e.target.value.trim().toLowerCase();
      ov.querySelectorAll('.am-user').forEach(row => { row.style.display = !q || row.dataset.name.includes(q) ? '' : 'none'; });
    });
    refresh();
    ov.querySelector('.am-search').focus();
  },
};
