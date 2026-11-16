// "Manage members" in a channel's right-click menu: everyone on the server is
// listed, the people in the channel are ticked, and ticking or unticking
// adds or removes them, one by one, a whole role at a time, or everyone
// (All users ticked is Add all, unticked is Remove all). Nothing changes
// until the button is pressed. The server side is
// src/socketHandlers/channelAddAll.js.

export default {
  // Who sees the menu item. The server checks again when it is used.
  _canAddChannelMembers(ch) {
    if (!ch || ch.is_dm) return false;
    if (this.user?.isAdmin) return true;
    if (ch.is_private || ch.code_visibility === 'private') return !!ch.canInvitePrivate;
    return !!(this._hasGlobalPerm?.('invite_users') || this._hasGlobalPerm?.('manage_server') || this._hasGlobalPerm?.('kick_user'));
  },

  _openAddChannelMembers(code) {
    this.socket.emit('get-channel-add-members', { code }, (res) => {
      if (!res || res.error) return this._showToast(res?.error || t('channels.manage_members_failed'), 'error');
      this._showAddMembersPicker(code, res);
    });
  },

  _showAddMembersPicker(code, { channel, users, roles, canAdd }) {
    const esc = (s) => this._escapeHtml(String(s ?? ''));
    // A box that cannot be changed: a member you may not remove (yourself
    // included), or someone outside when you may only remove.
    const locked = (u) => (u.inChannel ? !u.removable : !canAdd);
    const open = users.filter(u => !locked(u));

    const roleRows = roles.map(r => {
      const count = open.filter(u => u.roles.includes(r.id)).length;
      if (!count) return '';
      return `<label class="am-role"><input type="checkbox" data-role="${r.id}">
        <span class="role-color-dot" style="background:${esc(this._safeColor(r.color, '#aaa'))}"></span>${esc(r.name)} <span class="muted-text">${count}</span></label>`;
    }).join('');
    const userRows = users.map(u => `
      <label class="am-user${locked(u) ? ' am-in' : ''}" data-name="${esc(`${u.displayName} ${u.username}`.toLowerCase())}">
        <input type="checkbox" data-user="${u.id}"${u.inChannel ? ' checked' : ''}${locked(u) ? ' disabled' : ''}>
        <span class="am-name">${esc(u.displayName)}</span>${u.displayName !== u.username ? ` <span class="muted-text">@${esc(u.username)}</span>` : ''}
        ${u.inChannel ? `<span class="am-here">${esc(u.id === this.user?.id ? t('channels.manage_members_you') : t('channels.manage_members_here'))}</span>` : ''}
      </label>`).join('');

    const body = `<div class="am-picker">
      <input type="search" class="settings-text-input am-search" placeholder="${esc(t('channels.manage_members_search'))}">
      <small class="settings-hint">${esc(t('channels.manage_members_hint'))}</small>
      ${open.length ? `<label class="am-all"><input type="checkbox" class="am-all-box"> ${esc(t('channels.manage_members_all'))} <span class="muted-text">${open.length}</span></label>` : ''}
      ${roleRows ? `<div class="am-label">${esc(t('channels.manage_members_roles'))}</div><div class="am-roles">${roleRows}</div>` : ''}
      <div class="am-label">${esc(t('channels.manage_members_people'))}</div>
      <div class="am-users">${userRows}</div>
    </div>`;

    const ov = this._openToolModal({
      title: esc(t('channels.manage_members_title', { name: channel.name })),
      body,
      confirmText: esc(t('channels.manage_members_save')),
      onConfirm: async () => {
        const { add, remove } = changes();
        if (!add.length && !remove.length) { this._showToast(t('channels.manage_members_none'), 'info'); return false; }
        if (remove.length) {
          const ok = await this._showConfirmModal(
            t('channels.manage_members_remove_confirm', { count: remove.length, name: channel.name }), '',
            { danger: true, confirmLabel: t('channels.manage_members_remove_count', { count: remove.length }) });
          if (!ok) return false;
        }
        return new Promise((resolve) => {
          this.socket.emit('update-channel-members', { code, add, remove }, (r) => {
            if (!r || r.error) { this._showToast(r?.error || t('channels.manage_members_failed'), 'error'); return resolve(false); }
            const said = { added: r.added, removed: r.removed, name: channel.name };
            this._showToast(r.added && r.removed ? t('channels.manage_members_done_both', said)
              : r.removed ? t('channels.manage_members_done_removed', said) : t('channels.manage_members_done_added', said), 'success');
            resolve(true);
          });
        });
      },
    });

    const boxes = [...ov.querySelectorAll('input[data-user]:not(:disabled)')];
    const byId = new Map(boxes.map(b => [Number(b.dataset.user), b]));
    const was = new Map(open.map(u => [u.id, u.inChannel]));
    const holders = new Map(roles.map(r => [r.id, open.filter(u => u.roles.includes(r.id)).map(u => byId.get(u.id)).filter(Boolean)]));
    const allBox = ov.querySelector('.am-all-box');
    const confirm = ov.querySelector('.tool-confirm');
    // Who is ticked now and was not in the channel, and the other way round.
    const changes = () => {
      const add = [], remove = [];
      for (const b of boxes) {
        const id = Number(b.dataset.user);
        if (b.checked && !was.get(id)) add.push(id);
        if (!b.checked && was.get(id)) remove.push(id);
      }
      return { add, remove };
    };

    // Each group box shows all, some or none of its people ticked.
    const reflect = (box, group) => {
      const on = group.filter(b => b.checked).length;
      box.checked = on > 0 && on === group.length;
      box.indeterminate = on > 0 && on < group.length;
    };
    const refresh = () => {
      if (allBox) reflect(allBox, boxes);
      ov.querySelectorAll('input[data-role]').forEach(rb => reflect(rb, holders.get(Number(rb.dataset.role)) || []));
      const { add, remove } = changes();
      confirm.textContent = add.length && remove.length ? t('channels.manage_members_both_count', { added: add.length, removed: remove.length })
        : add.length ? t('channels.manage_members_add_count', { count: add.length })
        : remove.length ? t('channels.manage_members_remove_count', { count: remove.length })
        : t('channels.manage_members_save');
      confirm.classList.toggle('btn-danger', remove.length > 0 && !add.length);
    };

    allBox?.addEventListener('change', () => { boxes.forEach(b => { b.checked = allBox.checked; }); refresh(); });
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
