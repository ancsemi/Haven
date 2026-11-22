// The Bots page in Settings (src/socketHandlers/botAccounts.js): bot
// accounts, made here and signed in to with a token. Roles and channels are
// changed the usual way, so those buttons only show for people who could do
// it for any member.

export default {

_setupBotAccounts() {
  document.getElementById('open-bot-accounts-btn')?.addEventListener('click', () => this._openBotAccounts());
  document.getElementById('close-bot-account-modal-btn')?.addEventListener('click', () => {
    document.getElementById('bot-account-modal').style.display = 'none';
  });
  document.getElementById('bot-account-modal')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) e.currentTarget.style.display = 'none';
  });
  document.getElementById('create-bot-account-btn')?.addEventListener('click', () => this._createBotAccount());
  this.socket.on('bots-changed', () => {
    if (document.getElementById('bot-account-modal')?.style.display === 'flex') return this._loadBotAccounts();
    // Being made one of a bot's Bot Creators opens the Bots page to you.
    if (!this.user?.isAdmin && !this._hasPerm('manage_bots')) {
      this.socket.emit('get-bots', {}, (res) => { if (res?.bots) this.user.botCreator = res.bots.length > 0; });
    }
  });
},

_openBotAccounts() {
  this._selectedBotAccount = null;
  this._botTokenShown = null;
  document.getElementById('bot-account-modal').style.display = 'flex';
  document.getElementById('bot-account-detail').innerHTML = `<p class="muted-text" style="padding:20px;text-align:center">${t('bot_accounts.select_or_create')}</p>`;
  this._loadBotAccounts();
},

_loadBotAccounts() {
  this.socket.emit('get-bots', {}, (res) => {
    if (res?.error) return this._showToast(res.error, 'error');
    this._botAccounts = res.bots || [];
    if (!res.canCreate) this.user.botCreator = this._botAccounts.length > 0;
    document.getElementById('create-bot-account-btn').style.display = res.canCreate ? '' : 'none';
    this._renderBotAccountList();
    if (this._botAccounts.some(b => b.id === this._selectedBotAccount)) this._showBotAccount(this._selectedBotAccount);
  });
},

async _createBotAccount() {
  const name = await this._showPromptModal(t('bot_accounts.create_title'), t('bot_accounts.create_prompt'));
  if (!name || !name.trim()) return;
  this.socket.emit('create-bot', { name: name.trim() }, (res) => {
    if (res?.error) return this._showToast(res.error, 'error');
    this._selectedBotAccount = res.bot.id;
    this._botTokenShown = { id: res.bot.id, token: res.token };
    this._loadBotAccounts();
  });
},

_renderBotAccountList() {
  const list = document.getElementById('bot-account-list');
  if (!list) return;
  if (!this._botAccounts.length) {
    list.innerHTML = `<p class="muted-text" style="padding:8px">${t('bot_accounts.none')}</p>`;
    return;
  }
  list.innerHTML = this._botAccounts.map(b => `
    <div class="role-sidebar-item${b.id === this._selectedBotAccount ? ' active' : ''}" data-bot-account="${b.id}">
      ${this._botAccountAvatar(b, 20)}
      <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${this._escapeHtml(b.name)}</span>
      ${b.disabled ? `<span class="muted-text" style="margin-left:auto">${t('bot_accounts.disabled')}</span>` : ''}
    </div>`).join('');
  list.querySelectorAll('[data-bot-account]').forEach(item => item.addEventListener('click', () => {
    this._selectedBotAccount = Number(item.dataset.botAccount);
    this._botTokenShown = null;
    this._renderBotAccountList();
    this._showBotAccount(this._selectedBotAccount);
  }));
},

_botAccountAvatar(bot, size) {
  const src = this._botAvatarSrcAttr(bot.avatar);
  const box = `width:${size}px;height:${size}px;border-radius:50%;flex-shrink:0`;
  return src
    ? `<img ${src} style="${box};object-fit:cover">`
    : `<span style="${box};background:var(--accent);display:flex;align-items:center;justify-content:center;font-size:${size / 2}px;color:#fff">🤖</span>`;
},

_showBotAccount(botId) {
  const bot = this._botAccounts.find(b => b.id === botId);
  const panel = document.getElementById('bot-account-detail');
  if (!bot || !panel) return;
  const esc = (s) => this._escapeHtml(s || '');
  const shown = this._botTokenShown?.id === bot.id ? this._botTokenShown.token : null;
  const canRoles = this.user?.isAdmin || this._hasPerm('promote_user');
  const creators = bot.creators.length
    ? bot.creators.map(c => `<div class="bot-account-row"><span>${esc(c.name)}</span>${bot.editCreators ? `<button class="btn-xs" data-remove-creator="${c.id}">${t('bot_accounts.remove')}</button>` : ''}</div>`).join('')
    : `<p class="muted-text">${t('bot_accounts.no_creators')}</p>`;

  panel.innerHTML = `
    <div class="role-detail-form">
      <label class="settings-label">${t('bot_accounts.picture')}</label>
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
        ${this._botAccountAvatar(bot, 48)}
        <div style="display:flex;flex-direction:column;gap:4px">
          <button class="btn-xs btn-accent" id="ba-upload">📷 ${t('bot_accounts.upload')}</button>
          <button class="btn-xs" id="ba-remove-pic" ${bot.avatar ? '' : 'disabled'}>${t('bot_accounts.remove')}</button>
        </div>
        <input type="file" id="ba-file" accept="image/png,image/jpeg,image/gif,image/webp" style="display:none">
      </div>

      <label class="settings-label">${t('bot_accounts.name')}</label>
      <div style="display:flex;gap:6px;margin-bottom:4px">
        <input type="text" id="ba-name" value="${esc(bot.name)}" maxlength="20" class="settings-text-input" style="flex:1">
        <button class="btn-xs" id="ba-rename">${t('bot_accounts.rename')}</button>
      </div>
      ${bot.madeBy ? `<small class="settings-hint">${esc(t('bot_accounts.made_by', { name: bot.madeBy.name }))}</small>` : ''}

      <label class="settings-label" style="margin-top:8px">${t('bot_accounts.status')}</label>
      <label class="toggle-row" style="margin-bottom:8px">
        <span>${bot.disabled ? `🔴 ${t('bot_accounts.disabled')}` : `🟢 ${t('bot_accounts.enabled')}`}</span>
        <button class="btn-xs" id="ba-toggle">${bot.disabled ? t('bot_accounts.enable') : t('bot_accounts.disable')}</button>
      </label>

      <label class="settings-label">${t('bot_accounts.token')}</label>
      ${shown
        ? `<small class="settings-hint" style="color:var(--warning)">${t('bot_accounts.token_once')}</small>
           <div style="display:flex;gap:4px;align-items:center;margin:4px 0 8px">
             <code id="ba-token" style="flex:1;font-size:0.6875rem;padding:6px 8px;background:var(--bg-input);border-radius:4px;overflow-wrap:anywhere">${esc(shown)}</code>
             <button class="btn-xs" id="ba-copy">📋</button>
           </div>`
        : `<small class="settings-hint">${t('bot_accounts.token_hidden')}</small>`}
      <button class="btn-xs" id="ba-regenerate" style="margin:4px 0 12px">${t('bot_accounts.regenerate')}</button>

      <label class="settings-label">${t('bot_accounts.creators')}</label>
      <small class="settings-hint">${t('bot_accounts.creators_hint')}</small>
      <small class="settings-hint" style="display:block">${t('bot_accounts.creators_roles_hint')}</small>
      <div style="margin:6px 0">${creators}</div>
      ${bot.editCreators ? `<div style="display:flex;gap:6px;margin-bottom:12px">
        <input type="text" id="ba-creator-name" placeholder="${esc(t('bot_accounts.username'))}" class="settings-text-input" style="flex:1">
        <button class="btn-xs" id="ba-add-creator">${t('bot_accounts.add')}</button>
      </div>` : ''}

      <label class="settings-label">${t('bot_accounts.channels')}</label>
      <div id="ba-channels" style="margin:6px 0 12px"><p class="muted-text">${t('modals.common.loading')}</p></div>

      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
        ${canRoles ? `<button class="btn-sm" id="ba-roles">👑 ${t('bot_accounts.roles_btn')}</button>` : ''}
        ${bot.canDelete ? `<button class="btn-sm btn-danger" id="ba-delete">&#x1F5D1; ${t('bot_accounts.delete')}</button>` : ''}
      </div>
    </div>`;

  const emit = (event, data, ok) => this.socket.emit(event, { botId: bot.id, ...data }, (res) => {
    if (res?.error) return this._showToast(res.error, 'error');
    ok?.(res);
  });
  const $ = (id) => panel.querySelector(`#${id}`);

  $('ba-upload').addEventListener('click', () => $('ba-file').click());
  $('ba-file').addEventListener('change', (e) => { if (e.target.files[0]) this._uploadBotAccountPicture(bot.id, e.target.files[0]); });
  $('ba-remove-pic').addEventListener('click', () => this._uploadBotAccountPicture(bot.id, null));
  $('ba-rename').addEventListener('click', () => emit('rename-bot', { name: $('ba-name').value.trim() }));
  $('ba-toggle').addEventListener('click', () => emit('set-bot-disabled', { disabled: !bot.disabled }));
  $('ba-regenerate').addEventListener('click', async () => {
    if (!await this._confirm(t('bot_accounts.regenerate_confirm', { name: bot.name }), { danger: true })) return;
    emit('regenerate-bot-token', {}, (res) => {
      this._botTokenShown = { id: bot.id, token: res.token };
      this._showBotAccount(bot.id);
    });
  });
  $('ba-copy')?.addEventListener('click', () => {
    navigator.clipboard.writeText(shown).then(() => { $('ba-copy').textContent = '✅'; }).catch(err => console.warn('[bots] could not copy the token', err));
  });
  panel.querySelectorAll('[data-remove-creator]').forEach(btn => btn.addEventListener('click', () => emit('remove-bot-creator', { userId: Number(btn.dataset.removeCreator) })));
  $('ba-add-creator')?.addEventListener('click', () => {
    const username = $('ba-creator-name').value.trim();
    if (username) emit('add-bot-creator', { username });
  });
  $('ba-roles')?.addEventListener('click', () => this._openRoleAssignCenter(bot.id));
  $('ba-delete')?.addEventListener('click', async () => {
    const msg = bot.hasMessages ? 'bot_accounts.delete_confirm_posts' : 'bot_accounts.delete_confirm';
    if (!await this._confirm(t(msg, { name: bot.name }), { danger: true })) return;
    emit('delete-bot', {}, () => { this._selectedBotAccount = null; });
  });
  this._loadBotAccountChannels(bot.id);
},

// The channels the bot is in, and the ones you may add it to or take it
// out of, by the same rules as Manage members.
_loadBotAccountChannels(botId) {
  this.socket.emit('get-member-channels', { userId: botId }, (res) => {
    const box = document.getElementById('ba-channels');
    if (!box || this._selectedBotAccount !== botId) return;
    if (res?.error) { box.innerHTML = `<p class="muted-text">${this._escapeHtml(res.error)}</p>`; return; }
    const esc = (s) => this._escapeHtml(s || '');
    const inside = res.channels.filter(c => c.inChannel);
    const addable = res.channels.filter(c => c.canAdd);
    box.innerHTML = (inside.length
      ? inside.map(c => `<div class="bot-account-row"><span>${c.sub ? '↳ ' : '# '}${esc(c.name)}</span>${c.canRemove ? `<button class="btn-xs" data-remove-channel="${esc(c.code)}">${t('bot_accounts.remove')}</button>` : ''}</div>`).join('')
      : `<p class="muted-text">${t('bot_accounts.no_channels')}</p>`)
      + (addable.length ? `<select class="settings-select" id="ba-add-channel" style="width:100%;margin-top:6px">
          <option value="">${t('bot_accounts.add_channel')}</option>
          ${addable.map(c => `<option value="${esc(c.code)}">${c.sub ? '↳ ' : '# '}${esc(c.name)}</option>`).join('')}
        </select>` : '');
    const update = (code, add, remove) => this.socket.emit('update-channel-members', { code, add, remove }, (r) => {
      if (r?.error) this._showToast(r.error, 'error');
      this._loadBotAccountChannels(botId);
    });
    box.querySelectorAll('[data-remove-channel]').forEach(btn => btn.addEventListener('click', () => update(btn.dataset.removeChannel, [], [botId])));
    box.querySelector('#ba-add-channel')?.addEventListener('change', (e) => { if (e.target.value) update(e.target.value, [botId], []); });
  });
},

// A new picture, or none when file is null, through the same routes as
// your own with the bot named.
async _uploadBotAccountPicture(botId, file) {
  try {
    let resp;
    if (file) {
      const form = new FormData();
      form.append('botId', String(botId));
      form.append('avatar', file);
      resp = await fetch('/api/upload-avatar', { method: 'POST', headers: { Authorization: `Bearer ${this.token}` }, body: form });
    } else {
      resp = await fetch('/api/remove-avatar', { method: 'POST', headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ botId }) });
    }
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok) return this._showToast(json.error || t('toasts.upload_failed'), 'error');
    this.socket.emit('bot-avatar-changed', { botId });
  } catch {
    this._showToast(t('toasts.upload_failed'), 'error');
  }
},

};
