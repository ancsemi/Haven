// Bots and webhooks: creating them, their settings and avatars, and the
// channels they post to.

export default {

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// WEBHOOKS / BOT MANAGEMENT
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

_setupWebhookManagement() {
  // ── Ferry (Discord bridge) ──
  document.getElementById('open-ferry-btn')?.addEventListener('click', () => this._openFerryModal());
  document.getElementById('ferry-close-btn')?.addEventListener('click', () => this._closeFerryModal());
  document.getElementById('ferry-refresh-btn')?.addEventListener('click', () => {
    this.socket.emit('ferry:reconnect');
    this._showToast(t('media_runtime.ferry_reconnecting'), 'info');
  });
  document.getElementById('ferry-modal')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) this._closeFerryModal();
  });

  // Open bot management modal
  const openBtn = document.getElementById('open-bot-editor-btn');
  if (openBtn) {
    openBtn.addEventListener('click', () => this._openBotModal());
  }
  // Close bot modal
  document.getElementById('close-bot-modal-btn')?.addEventListener('click', () => {
    document.getElementById('bot-modal').style.display = 'none';
  });
  document.getElementById('bot-modal')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) e.currentTarget.style.display = 'none';
  });
  // Create new bot
  document.getElementById('create-bot-btn')?.addEventListener('click', () => {
    this._createNewBot();
  });
},

_openBotModal() {
  document.getElementById('bot-modal').style.display = 'flex';
  document.getElementById('bot-detail-panel').innerHTML = `<p class="muted-text" style="padding:20px;text-align:center">${t('modals.bot_mgmt.select_or_create')}</p>`;
  // Request all webhooks for the sidebar
  this.socket.emit('get-webhooks');
},

async _createNewBot() {
  const name = await this._showPromptModal(t('modals.bot_mgmt.create_title'), t('modals.bot_mgmt.create_name_prompt'));
  if (!name || !name.trim()) return;
  // Pick first non-DM channel as default
  const firstChannel = this.channels.find(c => !c.is_dm);
  if (!firstChannel) return this._showToast(t('modals.bot_mgmt.no_channels'), 'error');
  this.socket.emit('create-webhook', { name: name.trim(), channel_id: firstChannel.id, avatar_url: null });
},

_renderBotSidebar(webhooks) {
  const sidebar = document.getElementById('bot-list-sidebar');
  if (!sidebar) return;
  this._botWebhooks = webhooks; // cache for detail panel
  sidebar.innerHTML = webhooks.map(wh => {
    const avatarHtml = wh.avatar_url
      ? `<img src="${this._escapeHtml(wh.avatar_url)}" style="width:20px;height:20px;border-radius:50%;object-fit:cover;flex-shrink:0">`
      : `<span style="width:20px;height:20px;border-radius:50%;background:var(--accent);display:flex;align-items:center;justify-content:center;font-size:0.625rem;flex-shrink:0;color:#fff">🤖</span>`;
    const activeClass = this._selectedBotId === wh.id ? ' active' : '';
    return `<div class="role-sidebar-item${activeClass}" data-bot-id="${wh.id}">${avatarHtml}<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${this._escapeHtml(wh.name)}</span></div>`;
  }).join('');

  sidebar.querySelectorAll('.role-sidebar-item').forEach(item => {
    item.addEventListener('click', () => {
      const botId = parseInt(item.dataset.botId);
      this._selectedBotId = botId;
      // Highlight active
      sidebar.querySelectorAll('.role-sidebar-item').forEach(i => i.classList.remove('active'));
      item.classList.add('active');
      this._showBotDetail(botId);
    });
  });
},

_showBotDetail(botId) {
  const wh = (this._botWebhooks || []).find(w => w.id === botId);
  if (!wh) return;
  const panel = document.getElementById('bot-detail-panel');
  const baseUrl = window.location.origin;
  const tokenVisible = typeof wh.token === 'string' && wh.token.length > 0;
  const webhookUrl = tokenVisible ? `${baseUrl}/api/webhooks/${wh.token}` : '';
  const maskedToken = tokenVisible ? wh.token.slice(0, 12) + '••••••••••••' : t('media_runtime.bot.hidden');
  const channelOptions = this._getBotChannelOptions(wh.channel_id);

  panel.innerHTML = `
    <div class="role-detail-form">
      <label class="settings-label">${t('modals.bot_mgmt.avatar_label')}</label>
      <div class="bot-avatar-row" style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
        <div class="bot-avatar-preview" style="width:48px;height:48px;border-radius:50%;overflow:hidden;border:2px solid var(--border);background:var(--bg-tertiary);flex-shrink:0;display:flex;align-items:center;justify-content:center">
          ${wh.avatar_url ? `<img src="${this._escapeHtml(wh.avatar_url)}" style="width:100%;height:100%;object-fit:cover">` : '<span style="font-size:1.5rem">🤖</span>'}
        </div>
        <div style="display:flex;flex-direction:column;gap:4px">
          <button class="btn-xs btn-accent" id="bot-upload-avatar-btn">📷 ${t('modals.bot_mgmt.upload_avatar_btn')}</button>
          <button class="btn-xs" id="bot-remove-avatar-btn" ${wh.avatar_url ? '' : 'disabled'}>${t('modals.bot_mgmt.remove_avatar_btn')}</button>
        </div>
        <input type="file" id="bot-avatar-file-input" accept="image/png,image/jpeg,image/gif,image/webp" style="display:none">
      </div>

      <label class="settings-label">${t('modals.bot_mgmt.name_label')}</label>
      <input type="text" id="bot-detail-name" value="${this._escapeHtml(wh.name)}" maxlength="32" class="settings-text-input" style="width:100%;margin-bottom:8px">

      <label class="settings-label">${t('modals.bot_mgmt.channel_label')}</label>
      <select id="bot-detail-channel" class="settings-select" style="width:100%;margin-bottom:8px">${channelOptions}</select>

      <label class="settings-label">${t('modals.bot_mgmt.status_label')}</label>
      <label class="toggle-row" style="margin-bottom:8px">
        <span>${wh.is_active ? `🟢 ${t('modals.bot_mgmt.status_active')}` : `🔴 ${t('modals.bot_mgmt.status_disabled')}`}</span>
        <button class="btn-xs" id="bot-detail-toggle">${wh.is_active ? t('modals.bot_mgmt.disable_btn') : t('modals.bot_mgmt.enable_btn')}</button>
      </label>

      <label class="settings-label">${t('modals.bot_mgmt.webhook_url_label')}</label>
      <div style="display:flex;gap:4px;align-items:center;margin-bottom:8px">
        <code style="flex:1;font-size:0.6875rem;padding:6px 8px;background:var(--bg-input);border-radius:4px;color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${this._escapeHtml(webhookUrl || t('media_runtime.bot.hidden'))}</code>
        <button class="btn-xs" id="bot-detail-copy-url" title="${t('modals.bot_mgmt.copy_url_title')}" ${tokenVisible ? '' : 'disabled'}>📋</button>
      </div>

      <label class="settings-label">${t('modals.bot_mgmt.token_label')}</label>
      <div style="font-size:0.6875rem;font-family:monospace;padding:4px 8px;background:var(--bg-input);border-radius:4px;color:var(--text-muted);margin-bottom:12px">${maskedToken}</div>

      <label class="settings-label">📡 ${t('media_runtime.bot.callback_url')} <span style="font-size:0.625rem;color:var(--text-muted)">${t('media_runtime.bot.callback_url_hint')}</span></label>
      <input type="url" id="bot-detail-callback-url" value="${this._escapeHtml(wh.callback_url || '')}" placeholder="https://mybot.example.com/haven-events" class="settings-text-input" style="width:100%;margin-bottom:8px">

      <label class="settings-label">🔑 ${t('media_runtime.bot.callback_secret')} <span style="font-size:0.625rem;color:var(--text-muted)">${t('media_runtime.bot.callback_secret_hint')}</span></label>
      <input type="text" id="bot-detail-callback-secret" value="${this._escapeHtml(wh.callback_secret || '')}" placeholder="my-secret-key" class="settings-text-input" style="width:100%;margin-bottom:12px">

      <label class="settings-label">🛡️ ${t('media_runtime.bot.moderation')} <span style="font-size:0.625rem;color:var(--text-muted)">${t('media_runtime.bot.moderation_hint')}</span></label>
      <label class="toggle-row" style="margin-bottom:12px">
        <input type="checkbox" id="bot-detail-can-moderate" ${wh.can_moderate ? 'checked' : ''} ${this.user && this.user.isAdmin ? '' : 'disabled'}>
        <span>${t('media_runtime.bot.allow_moderation')}</span>
      </label>

      <label class="settings-label">${t('media_runtime.bot.voice_access')} <span style="font-size:0.625rem;color:var(--text-muted)">${t('media_runtime.bot.voice_access_hint')}</span></label>
      <label class="toggle-row" style="margin-bottom:12px">
        <input type="checkbox" id="bot-detail-can-use-voice" ${wh.can_use_voice ? 'checked' : ''} ${this.user && this.user.isAdmin ? '' : 'disabled'}>
        <span>${t('media_runtime.bot.allow_voice')}</span>
      </label>

      <div style="display:flex;gap:8px;margin-top:8px">
        <button class="btn-sm btn-accent" id="bot-detail-save" style="flex:1">💾 ${t('modals.bot_mgmt.save_btn')}</button>
        <button class="btn-sm btn-danger" id="bot-detail-delete">&#x1F5D1; ${t('modals.bot_mgmt.delete_btn')}</button>
      </div>
    </div>
  `;

  // Wire up handlers
  panel.querySelector('#bot-upload-avatar-btn').addEventListener('click', () => {
    panel.querySelector('#bot-avatar-file-input').click();
  });
  panel.querySelector('#bot-avatar-file-input').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    this._uploadBotAvatar(botId, file);
  });
  panel.querySelector('#bot-remove-avatar-btn').addEventListener('click', () => {
    this.socket.emit('update-webhook', { id: botId, avatar_url: '' });
  });
  panel.querySelector('#bot-detail-save').addEventListener('click', () => {
    const name = panel.querySelector('#bot-detail-name').value.trim();
    const channelId = parseInt(panel.querySelector('#bot-detail-channel').value);
    const callbackUrl = panel.querySelector('#bot-detail-callback-url').value.trim();
    const callbackSecret = panel.querySelector('#bot-detail-callback-secret').value.trim();
    if (!name) return this._showToast(t('media_runtime.bot.name_required'), 'error');
    const payload = { id: botId, name, channel_id: channelId, callback_url: callbackUrl, callback_secret: callbackSecret };
    const modBox = panel.querySelector('#bot-detail-can-moderate');
    if (modBox && !modBox.disabled) payload.can_moderate = modBox.checked ? 1 : 0;
    const voiceBox = panel.querySelector('#bot-detail-can-use-voice');
    if (voiceBox && !voiceBox.disabled) payload.can_use_voice = voiceBox.checked ? 1 : 0;
    this.socket.emit('update-webhook', payload);
  });
  panel.querySelector('#bot-detail-toggle').addEventListener('click', () => {
    this.socket.emit('toggle-webhook', { id: botId });
  });
  panel.querySelector('#bot-detail-copy-url').addEventListener('click', () => {
    if (!webhookUrl) return;
    const markCopied = () => {
      panel.querySelector('#bot-detail-copy-url').textContent = '✅';
      setTimeout(() => {
        const btn = panel.querySelector('#bot-detail-copy-url');
        if (btn) btn.textContent = '📋';
      }, 1500);
    };
    navigator.clipboard.writeText(webhookUrl).then(markCopied).catch(() => {
      try {
        const ta = document.createElement('textarea');
        ta.value = webhookUrl;
        ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
        document.body.appendChild(ta);
        ta.focus(); ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        markCopied();
      } catch { /* could not copy */ }
    });
  });
  panel.querySelector('#bot-detail-delete').addEventListener('click', () => {
    if (confirm(t('media_runtime.bot.delete_confirm', { name: wh.name }))) {
      this._selectedBotId = null;
      this.socket.emit('delete-webhook', { id: botId });
    }
  });
},

/** Build channel <option> list ordered like the sidebar (parents first, sub-channels indented) */
_getBotChannelOptions(selectedId) {
  const regular = this.channels.filter(c => !c.is_dm);
  const parents = regular.filter(c => !c.parent_channel_id);
  const subMap = {};
  regular.filter(c => c.parent_channel_id).forEach(c => {
    if (!subMap[c.parent_channel_id]) subMap[c.parent_channel_id] = [];
    subMap[c.parent_channel_id].push(c);
  });
  let html = '';
  for (const p of parents) {
    const sel = p.id === selectedId ? ' selected' : '';
    html += `<option value="${p.id}"${sel}># ${this._escapeHtml(p.name)}</option>`;
    const subs = subMap[p.id] || [];
    for (const s of subs) {
      const sSel = s.id === selectedId ? ' selected' : '';
      html += `<option value="${s.id}"${sSel}>&nbsp;&nbsp;&nbsp;&nbsp;↳ ${this._escapeHtml(s.name)}</option>`;
    }
  }
  return html;
},

async _uploadBotAvatar(botId, file) {
  const form = new FormData();
  form.append('avatar', file);
  form.append('webhookId', botId);
  try {
    const resp = await fetch('/api/upload-webhook-avatar', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${this.token}` },
      body: form
    });
    const json = await resp.json();
    if (json.url) {
      this.socket.emit('update-webhook', { id: botId, avatar_url: json.url });
      this._showToast(t('media_runtime.bot.avatar_updated'), 'success');
    } else {
      this._showToast(json.error || t('toasts.upload_failed'), 'error');
    }
  } catch (err) {
    this._showToast(t('toasts.upload_failed'), 'error');
  }
},

};
