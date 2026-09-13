// Role templates, channel templates, role-gated channels, per-role upload caps
// and self-assign role menus. Everything here hangs off existing surfaces:
// the Role Management modal, the Create Channel section, Channel Functions,
// and the message list.
export default {

  // The cap this user's uploads are checked against. The server sends the
  // server-wide setting as max_upload_mb and the user's own (possibly role-raised)
  // cap as max_upload_mb_effective; older servers only send the first.
  _uploadCapMb() {
    return parseInt(this.serverSettings?.max_upload_mb_effective ?? this.serverSettings?.max_upload_mb, 10) || 25;
  },

  // ── One-off modal built on the fly ──────────────────────
  _openToolModal({ title, body, confirmText, onConfirm, wide }) {
    const ov = document.createElement('div');
    ov.className = 'modal-overlay';
    ov.style.display = 'flex';
    ov.innerHTML = `<div class="modal${wide ? ' modal-wide' : ''} tool-modal">
      <h3>${title}</h3>
      <div class="tool-modal-body">${body}</div>
      <div class="tool-modal-actions">
        <button class="btn-sm tool-cancel" type="button">${t('modals.common.cancel')}</button>
        ${confirmText ? `<button class="btn-sm btn-accent tool-confirm" type="button">${confirmText}</button>` : ''}
      </div>
    </div>`;
    const close = () => ov.remove();
    ov.querySelector('.tool-cancel').addEventListener('click', close);
    ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
    const ok = ov.querySelector('.tool-confirm');
    if (ok) ok.addEventListener('click', async () => { const r = await onConfirm?.(ov); if (r !== false) close(); });
    document.body.appendChild(ov);
    return ov;
  },

  // ═══════════════════════════════════════════════════════
  // ROLE TEMPLATES
  // ═══════════════════════════════════════════════════════
  _roleTemplates() {
    const own = ['edit_own_messages', 'delete_own_messages'];
    const member = [...own, 'upload_files', 'use_voice', 'use_tts', 'view_history', 'view_channel_members'];
    return [
      { key: 'member', emoji: '👤', level: 1, color: '#95a5a6', perms: member },
      { key: 'blank', emoji: '📄', level: 25, color: '#aaaaaa', perms: [] },
      { key: 'moderator', emoji: '🛡️', level: 50, color: '#3498db',
        perms: [...member, 'delete_message', 'delete_lower_messages', 'pin_message', 'archive_messages', 'kick_user', 'mute_user', 'ban_user',
          'rename_channel', 'rename_sub_channel', 'set_channel_topic', 'manage_sub_channels', 'manage_channel_settings', 'create_channel', 'create_temp_channel',
          'invite_users', 'mention_everyone', 'view_all_members', 'manage_music_queue', 'promote_user', 'read_only_override', 'view_audit_log'] },
      { key: 'helper', emoji: '🤝', level: 30, color: '#2ecc71',
        perms: [...member, 'delete_lower_messages', 'pin_message', 'mute_user', 'set_channel_topic', 'create_temp_channel', 'invite_users', 'manage_music_queue'] },
      { key: 'trusted', emoji: '⭐', level: 10, color: '#f1c40f',
        perms: [...member, 'create_temp_channel', 'invite_users', 'manage_music_queue'] },
      { key: 'event_host', emoji: '🎉', level: 20, color: '#9b59b6',
        perms: [...member, 'create_temp_channel', 'set_channel_topic', 'mention_everyone', 'manage_music_queue', 'manage_soundboard'] },
      { key: 'media_poster', emoji: '📸', level: 5, color: '#e67e22', perms: [...member], maxUploadMb: 100 },
      { key: 'group', emoji: '🏷️', level: 0, color: '#95a5a6', perms: [] },
    ];
  },

  _openRoleTemplatePicker() {
    const tpls = this._roleTemplates();
    const body = `<p class="settings-hint">${t('settings.admin.role_templates.hint')}</p>
      <div class="role-tpl-grid">${tpls.map(tp => `
        <button class="role-tpl-card" type="button" data-key="${tp.key}">
          <span class="role-tpl-emoji">${tp.emoji}</span>
          <b>${t(`settings.admin.role_templates.${tp.key}`)}</b>
          <small>${t(`settings.admin.role_templates.${tp.key}_desc`)}</small>
          <small class="muted-text">Lv.${tp.level} · ${tp.level === 0 ? t('settings.admin.role_templates.no_perms') : t('settings.admin.role_templates.perm_count', { count: tp.perms.length })}${tp.maxUploadMb ? ` · ${tp.maxUploadMb} MB` : ''}</small>
        </button>`).join('')}</div>`;
    const ov = this._openToolModal({ title: t('settings.admin.roles_create_title'), body, wide: true });
    ov.querySelectorAll('.role-tpl-card').forEach(btn => btn.addEventListener('click', async () => {
      const tp = tpls.find(x => x.key === btn.dataset.key);
      ov.remove();
      const name = await this._showPromptModal(t('settings.admin.roles_create_title'), t('settings.admin.roles_create_hint'), tp.key === 'blank' ? '' : t(`settings.admin.role_templates.${tp.key}`));
      if (!name || !name.trim()) return;
      const levelStr = await this._showPromptModal(t('settings.admin.roles_level_title'), t('settings.admin.roles_level_hint'), String(tp.level));
      if (levelStr === null) return;
      const level = parseInt(levelStr, 10);
      if (isNaN(level) || level < 0 || level > 99) { this._showToast(t('settings.admin.roles_level_invalid'), 'error'); return; }
      this._roleEmit('create-role', {
        name: name.trim().slice(0, 30), level, color: tp.color,
        permissions: level > 0 ? tp.perms : [],
        maxUploadMb: tp.maxUploadMb || null
      }, (res) => {
        if (res.error) { this._showToast(res.error, 'error'); return; }
        this._showToast(t('settings.admin.roles_created'), 'success');
        if (res.roleId) this._selectedRoleId = res.roleId;
        this._loadRoles();
      });
    }));
  },

  // ═══════════════════════════════════════════════════════
  // ROLE GATE (who may open a channel, on top of membership)
  // ═══════════════════════════════════════════════════════
  _roleGateOf(ch) {
    try {
      const g = typeof ch?.role_gate === 'string' ? JSON.parse(ch.role_gate) : ch?.role_gate;
      return g && Array.isArray(g.roles) && g.roles.length ? { mode: g.mode === 'all' ? 'all' : 'any', roles: g.roles.map(Number) } : null;
    } catch { return null; }
  },

  _openRoleGateModal(code) {
    const ch = this.channels.find(c => c.code === code);
    if (!ch) return;
    const gate = this._roleGateOf(ch);
    const chosen = new Set(gate ? gate.roles : []);
    const mode = gate ? gate.mode : 'any';
    this._roleEmit('get-roles', {}, (res) => {
      const roles = (res.roles || []).filter(r => r.scope !== 'channel');
      const body = `<p class="settings-hint">${t('channel_functions.role_gate_hint')}</p>
        <div class="rg-mode">
          <label class="toggle-row"><span>${t('channel_functions.role_gate_any')}</span><input type="radio" name="rg-mode" value="any" ${mode === 'any' ? 'checked' : ''}></label>
          <label class="toggle-row"><span>${t('channel_functions.role_gate_all')}</span><input type="radio" name="rg-mode" value="all" ${mode === 'all' ? 'checked' : ''}></label>
        </div>
        <div class="rg-roles">${roles.length ? roles.map(r => `
          <label class="toggle-row">
            <span><span class="role-color-dot" style="background:${this._safeColor(r.color, '#aaa')}"></span> ${this._escapeHtml(r.name)} <span class="muted-text">Lv.${r.level}</span></span>
            <input type="checkbox" class="rg-role" value="${r.id}" ${chosen.has(r.id) ? 'checked' : ''}>
          </label>`).join('') : `<p class="muted-text">${t('settings.admin.roles_no_custom')}</p>`}</div>
        <small class="settings-hint">${t('channel_functions.role_gate_clear_hint')}</small>`;
      this._openToolModal({
        title: `${t('channel_functions.role_gate')} · #${this._escapeHtml(ch.name)}`, body,
        confirmText: t('settings.admin.roles_save'),
        onConfirm: (ov) => {
          const picked = [...ov.querySelectorAll('.rg-role:checked')].map(i => parseInt(i.value, 10));
          const m = ov.querySelector('input[name="rg-mode"]:checked')?.value || 'any';
          this.socket.emit('set-channel-role-gate', { code, mode: m, roles: picked }, (r) => {
            if (r?.error) return this._showToast(r.error, 'error');
            ch.role_gate = r.roleGate ? JSON.stringify(r.roleGate) : null;
            this._updateChannelFunctionsPanel?.(ch);
            this._showToast(t('channel_functions.role_gate_saved'), 'success');
          });
        }
      });
    });
  },

  _roleGateBadge(ch) {
    const gate = this._roleGateOf(ch);
    if (!gate) return { on: false, text: t('channel_functions.off') };
    return { on: true, text: t(gate.mode === 'all' ? 'channel_functions.role_gate_badge_all' : 'channel_functions.role_gate_badge_any', { count: gate.roles.length }) };
  },

  // ═══════════════════════════════════════════════════════
  // CHANNEL TEMPLATES
  // ═══════════════════════════════════════════════════════
  _builtinChannelTemplates() {
    return [
      { key: 'chat', emoji: '💬', fields: {} },
      { key: 'announcements', emoji: '📢', fields: { readOnly: true, announcement: true, addAllMembers: true } },
      { key: 'forum', emoji: '🗂️', fields: { isForum: true } },
      { key: 'team', emoji: '🔒', fields: { isPrivate: true } },
      { key: 'event', emoji: '🎉', fields: { temporary: true, duration: 24, addAllMembers: true } },
      { key: 'slow', emoji: '🐢', fields: { slowMode: 30 } },
      { key: 'text_only', emoji: '📝', fields: { voiceEnabled: false } },
    ];
  },

  _savedChannelTemplates() {
    try {
      const list = JSON.parse(this.serverSettings?.channel_templates || '[]');
      return Array.isArray(list) ? list.filter(x => x && typeof x.name === 'string' && x.fields && typeof x.fields === 'object') : [];
    } catch { return []; }
  },

  _channelTemplateList() {
    return [
      ...this._builtinChannelTemplates().map(tp => ({ id: 'b:' + tp.key, label: `${tp.emoji} ${t(`app.sidebar.templates.${tp.key}`)}`, fields: tp.fields, saved: false })),
      ...this._savedChannelTemplates().map((tp, i) => ({ id: 's:' + i, label: `💾 ${tp.name}`, fields: tp.fields, saved: true })),
    ];
  },

  _renderChannelTemplates() {
    const sel = document.getElementById('new-channel-template');
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = this._channelTemplateList().map(tp => `<option value="${tp.id}">${this._escapeHtml(tp.label)}</option>`).join('');
    sel.value = [...sel.options].some(o => o.value === cur) ? cur : 'b:chat';
    const del = document.getElementById('new-channel-template-del');
    if (del) del.style.display = sel.value.startsWith('s:') ? '' : 'none';
    if (!sel._wired) {
      sel._wired = true;
      sel.addEventListener('change', () => this._applyChannelTemplate(sel.value));
      del?.addEventListener('click', () => this._deleteChannelTemplate(sel.value));
    }
  },

  _applyChannelTemplate(id) {
    const tp = this._channelTemplateList().find(x => x.id === id);
    if (!tp) return;
    const f = tp.fields;
    const set = (i, v) => { const el = document.getElementById(i); if (el) el.checked = !!v; };
    set('new-channel-private', f.isPrivate);
    set('new-channel-temporary', f.temporary);
    set('new-channel-forum', f.isForum);
    set('new-channel-add-all', f.addAllMembers && !f.isPrivate);
    const dur = document.getElementById('new-channel-duration');
    if (dur && f.duration) dur.value = f.duration;
    const durRow = document.getElementById('temp-channel-duration-row');
    if (durRow) durRow.style.display = f.temporary ? '' : 'none';
    const del = document.getElementById('new-channel-template-del');
    if (del) del.style.display = tp.saved ? '' : 'none';
    this._pendingChannelTemplate = f;
  },

  // Everything the checkboxes do not carry, sent along with create-channel.
  _channelTemplateExtras() {
    const f = this._pendingChannelTemplate || {};
    return {
      topic: typeof f.topic === 'string' ? f.topic.slice(0, 256) : '',
      readOnly: !!f.readOnly, announcement: !!f.announcement,
      slowMode: parseInt(f.slowMode, 10) || 0,
      mediaEnabled: f.mediaEnabled !== false, voiceEnabled: f.voiceEnabled !== false
    };
  },

  _resetChannelTemplate() {
    this._pendingChannelTemplate = null;
    const sel = document.getElementById('new-channel-template');
    if (sel) { sel.value = 'b:chat'; const del = document.getElementById('new-channel-template-del'); if (del) del.style.display = 'none'; }
  },

  _canSaveChannelTemplates() {
    const perms = this.user?.permissions || [];
    return !!this.user?.isAdmin || perms.includes('*') || perms.includes('manage_server');
  },

  async _saveChannelAsTemplate(code) {
    const ch = this.channels.find(c => c.code === code);
    if (!ch) return;
    const name = await this._showPromptModal(t('channel_functions.save_template'), t('channel_functions.save_template_prompt'), ch.name.slice(0, 30));
    if (!name || !name.trim()) return;
    const clean = name.trim().slice(0, 30);
    const fields = {
      isPrivate: !!ch.is_private, isForum: ch.is_forum === 1, readOnly: ch.read_only === 1,
      announcement: ch.notification_type === 'announcement', slowMode: ch.slow_mode_interval || 0,
      mediaEnabled: ch.media_enabled !== 0, voiceEnabled: ch.voice_enabled !== 0, topic: ch.topic || ''
    };
    const list = this._savedChannelTemplates().filter(x => x.name !== clean);
    list.push({ name: clean, fields });
    this._storeChannelTemplates(list.slice(-20));
    this._showToast(t('channel_functions.save_template_done', { name: clean }), 'success');
  },

  async _deleteChannelTemplate(id) {
    const tp = this._channelTemplateList().find(x => x.id === id);
    if (!tp || !tp.saved) return;
    const ok = await this._showConfirmModal(t('app.sidebar.templates.delete_title'), t('app.sidebar.templates.delete_prompt', { name: tp.label.replace(/^💾 /, '') }));
    if (!ok) return;
    const idx = parseInt(id.slice(2), 10);
    this._storeChannelTemplates(this._savedChannelTemplates().filter((_, i) => i !== idx));
    this._resetChannelTemplate();
  },

  _storeChannelTemplates(list) {
    const value = JSON.stringify(list);
    this.serverSettings = this.serverSettings || {};
    this.serverSettings.channel_templates = value;
    this.socket.emit('update-server-setting', { key: 'channel_templates', value });
    this._renderChannelTemplates();
  },

  // ═══════════════════════════════════════════════════════
  // SELF-ASSIGN ROLE MENUS
  // ═══════════════════════════════════════════════════════
  _openRoleMenuBuilder() {
    const defaults = ['🎮', '🎨', '🎵', '📚', '🎬', '⚽', '💻', '🍕', '🌙', '☀️', '🐱', '🐶', '🚀', '🧪', '🎲', '📷', '🌍', '🔥', '💜', '🍀'];
    this._roleEmit('get-roles', {}, (res) => {
      const roles = (res.roles || []).filter(r => r.scope !== 'channel');
      const chans = this.channels.filter(c => !c.is_dm);
      if (!roles.length) { this._showToast(t('settings.admin.roles_no_custom'), 'error'); return; }
      const body = `<p class="settings-hint">${t('settings.admin.role_menu.hint')}</p>
        <label class="settings-label">${t('settings.admin.role_menu.channel')}</label>
        <select id="rm-channel" class="settings-text-input">${chans.map(c => `<option value="${c.code}" ${c.code === this.currentChannel ? 'selected' : ''}># ${this._escapeHtml(c.name)}</option>`).join('')}</select>
        <label class="settings-label" style="margin-top:8px">${t('settings.admin.role_menu.title_label')}</label>
        <input id="rm-title" class="settings-text-input" maxlength="120" placeholder="${this._escapeHtml(t('settings.admin.role_menu.title_placeholder'))}">
        <div class="rm-roles">${roles.map((r, i) => `
          <div class="rm-row">
            <label class="toggle-row"><span><span class="role-color-dot" style="background:${this._safeColor(r.color, '#aaa')}"></span> ${this._escapeHtml(r.name)} <span class="muted-text">Lv.${r.level}</span></span><input type="checkbox" class="rm-role" value="${r.id}"></label>
            <input class="rm-emoji settings-text-input" maxlength="8" value="${defaults[i % defaults.length]}" title="${this._escapeHtml(t('settings.admin.role_menu.emoji'))}">
          </div>`).join('')}</div>`;
      this._openToolModal({
        title: t('settings.admin.role_menu.post'), body, confirmText: t('settings.admin.role_menu.post'),
        onConfirm: (ov) => {
          const entries = [...ov.querySelectorAll('.rm-row')]
            .filter(row => row.querySelector('.rm-role').checked)
            .map(row => ({ roleId: parseInt(row.querySelector('.rm-role').value, 10), emoji: row.querySelector('.rm-emoji').value.trim() }));
          if (!entries.length) { this._showToast(t('settings.admin.role_menu.pick_one'), 'error'); return false; }
          this.socket.emit('create-role-menu', { code: ov.querySelector('#rm-channel').value, title: ov.querySelector('#rm-title').value.trim(), roles: entries }, (r) => {
            if (r?.error) return this._showToast(r.error, 'error');
            this._showToast(t('settings.admin.role_menu.posted'), 'success');
          });
        }
      });
    });
  },

  _renderRoleMenu(msgId, menu) {
    if (!menu || !Array.isArray(menu.roles) || !menu.roles.length) return '';
    const held = new Set((menu.held || []).map(Number));
    return `<div class="role-menu-widget" data-msg-id="${msgId}">${menu.roles.map(r => `
      <button class="role-menu-btn${held.has(r.id) ? ' held' : ''}" type="button" data-msg-id="${msgId}" data-role-id="${r.id}" style="--role-c:${this._safeColor(r.color, '#aaa')}" title="${this._escapeHtml(t(held.has(r.id) ? 'role_menu.leave' : 'role_menu.join', { name: r.name }))}">
        <span class="rm-emoji">${this._escapeHtml(r.emoji)}</span><span class="rm-name">${this._escapeHtml(r.name)}</span><span class="rm-state">${held.has(r.id) ? '✓' : '+'}</span>
      </button>`).join('')}</div>`;
  },

  _markSelfRole(roleId, held) {
    document.querySelectorAll(`.role-menu-btn[data-role-id="${roleId}"]`).forEach(b => {
      b.classList.toggle('held', held);
      const s = b.querySelector('.rm-state');
      if (s) s.textContent = held ? '✓' : '+';
      const name = b.querySelector('.rm-name')?.textContent || '';
      b.title = t(held ? 'role_menu.leave' : 'role_menu.join', { name });
    });
  },
};
