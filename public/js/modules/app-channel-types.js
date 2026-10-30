// Channel types: a named set of Channel Functions with its own sidebar icon
// (server side in src/channelTypes.js). Admins make them in Settings > Server >
// Channel Types; a channel gets one from its right-click menu, and the sidebar
// then shows the type's icon instead of separate function icons.

// The editor's rows, in two groups. Keys match src/channelTypes.js FUNCTIONS.
const TYPE_GROUPS = [
  ['chat', 'Chat', [
    ['text', '💬', 'Text chat', 'Send messages'],
    ['media', '🖼️', 'Pictures and files', 'Upload images, videos and files'],
    ['reactions', '😀', 'Reactions', 'React to messages with emoji'],
    ['read_only', '🔒', 'Read only', 'Only admins and people allowed can post'],
  ]],
  ['voice', 'Voice', [
    ['voice', '🎙️', 'Voice chat', 'Talk in the channel'],
    ['streams', '🖥️', 'Screen share and camera', 'Share a screen or turn on a camera'],
    ['music', '🎵', 'Music', 'Listen Together'],
    ['soundboard', '🔊', 'Soundboard', 'Play sounds in voice'],
  ]],
];
const NEEDS_VOICE = ['streams', 'music', 'soundboard'];
const QUICK_ICONS = ['🔊', '💬', '📢', '🎧', '🎮', '🎵', '🎨', '🛠️', '⭐', '🔒'];

export default {

_setupChannelTypes() {
  this.channelTypes = [];
  const load = () => this.socket.emit('get-channel-types', {}, (res) => this._setChannelTypes(res?.types));
  this.socket.on('connect', load);
  if (this.socket.connected) load();
  this.socket.on('channel-types', (data) => this._setChannelTypes(data?.types));
  document.getElementById('channel-type-new-btn')?.addEventListener('click', () => this._openChannelTypeEditor(null));
  document.querySelector('[data-action="channel-type"]')?.addEventListener('click', () => {
    const code = this._ctxMenuChannel;
    this._closeChannelCtxMenu();
    if (code) this._openChannelTypePicker(code);
  });
},

_setChannelTypes(types) {
  this.channelTypes = Array.isArray(types) ? types : [];
  this._renderChannelTypesSettings();
  if (this.channels) this._renderChannels();
},

_ctLabel(key, fallback, params) {
  const full = `channel_types.${key}`;
  const s = t(full, params);
  return s && s !== full ? s : fallback;
},

_channelTypeOf(ch) {
  if (!ch || !ch.type_id) return null;
  return (this.channelTypes || []).find(ty => ty.id === ch.type_id) || null;
},

_canManageChannelTypes() {
  return !!(this.user?.isAdmin || this._hasPerm('manage_server'));
},

// The sidebar icon for a typed channel, or '' when it has none.
_channelTypeBadge(ch) {
  const type = this._channelTypeOf(ch);
  if (!type) return '';
  return `<span class="ch-type-badge" title="${this._escapeHtml(type.name)}">${this._escapeHtml(type.icon)}</span>`;
},

// "Voice chat, Music, Soundboard": what a type switches on, in words.
_channelTypeSummary(fns) {
  const on = [];
  for (const [, , rows] of TYPE_GROUPS) {
    for (const [key, icon, label] of rows) {
      if (!fns[key]) continue;
      if (key === 'reactions' && !fns.text) continue; // nothing to react to
      on.push(`${icon} ${this._ctLabel(`fn.${key}`, label)}`);
    }
  }
  return on.length ? on.join(' · ') : this._ctLabel('summary_none', 'Nothing switched on');
},

// ── Settings > Server > Channel Types ───────────────────

_renderChannelTypesSettings() {
  const list = document.getElementById('channel-type-list');
  if (!list) return;
  const types = this.channelTypes || [];
  if (!types.length) {
    list.innerHTML = `<p class="muted-text">${this._escapeHtml(this._ctLabel('empty', 'No channel types yet.'))}</p>`;
    return;
  }
  list.innerHTML = types.map(type => {
    const used = type.channelCount === 0 ? this._ctLabel('used_by_none', 'Not used yet')
      : type.channelCount === 1 ? this._ctLabel('used_by_one', 'Used by 1 channel')
      : this._ctLabel('used_by', `Used by ${type.channelCount} channels`, { count: type.channelCount });
    return `
      <div class="ct-card" data-id="${type.id}">
        <div class="ct-card-icon">${this._escapeHtml(type.icon)}</div>
        <div class="ct-card-body">
          <div class="ct-card-name">${this._escapeHtml(type.name)} <span class="ct-card-used">${this._escapeHtml(used)}</span></div>
          <div class="ct-card-summary">${this._escapeHtml(this._channelTypeSummary(type.functions))}</div>
        </div>
        <div class="ct-card-actions">
          <button type="button" class="btn-sm" data-ct="edit">${this._escapeHtml(this._ctLabel('edit', 'Edit'))}</button>
          <button type="button" class="btn-sm ct-delete" data-ct="delete">${this._escapeHtml(this._ctLabel('delete', 'Delete'))}</button>
        </div>
      </div>`;
  }).join('');
  list.querySelectorAll('.ct-card').forEach(card => {
    const type = types.find(ty => ty.id === Number(card.dataset.id));
    card.querySelector('[data-ct="edit"]').addEventListener('click', () => this._openChannelTypeEditor(type));
    card.querySelector('[data-ct="delete"]').addEventListener('click', () => this._deleteChannelType(type));
  });
},

async _deleteChannelType(type) {
  const ok = await this._showConfirmModal(
    this._ctLabel('delete_confirm_title', `Delete "${type.name}"?`, { name: type.name }),
    this._ctLabel('delete_confirm_body', 'Its channels keep their functions and show them as separate icons again.'),
    { danger: true });
  if (!ok) return;
  this.socket.emit('delete-channel-type', { id: type.id }, (res) => {
    if (res?.error) this._showToast(res.error, 'error');
  });
},

// ── Editor ──────────────────────────────────────────────

_openChannelTypeEditor(type) {
  const fns = { ...(type ? type.functions : { text: 1, media: 1, reactions: 1, read_only: 0, voice: 1, streams: 1, music: 1, soundboard: 1 }) };
  const esc = (s) => this._escapeHtml(s);
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.style.display = 'flex';
  overlay.style.zIndex = '100002';
  const groups = TYPE_GROUPS.map(([gKey, gLabel, rows]) => `
    <div class="ct-group">
      <div class="ct-group-label">${esc(this._ctLabel(`group_${gKey}`, gLabel))}</div>
      ${rows.map(([key, icon, label, hint]) => `
        <label class="ct-fn" data-fn="${key}">
          <span class="ct-fn-icon">${icon}</span>
          <span class="ct-fn-text">
            <span class="ct-fn-label">${esc(this._ctLabel(`fn.${key}`, label))}</span>
            <span class="ct-fn-hint" data-hint="${esc(this._ctLabel(`fn.${key}_hint`, hint))}"></span>
          </span>
          <input type="checkbox" ${fns[key] ? 'checked' : ''}>
        </label>`).join('')}
    </div>`).join('');
  overlay.innerHTML = `
    <div class="modal ct-editor">
      <h3 style="margin-top:0">${esc(type ? this._ctLabel('editor_edit_title', 'Edit channel type') : this._ctLabel('editor_new_title', 'New channel type'))}</h3>
      <div class="ct-preview" aria-hidden="true">
        <span class="ct-preview-label">${esc(this._ctLabel('preview_label', 'In the sidebar'))}</span>
        <div class="ct-preview-row"><span class="ct-preview-hash">#</span><span class="ct-preview-name"></span><span class="ct-preview-icon"></span></div>
      </div>
      <label class="ct-field-label" for="ct-name">${esc(this._ctLabel('name_label', 'Name'))}</label>
      <input type="text" id="ct-name" class="settings-text-input ct-input" maxlength="32" placeholder="${esc(this._ctLabel('name_placeholder', 'e.g. Hangout'))}" value="${esc(type ? type.name : '')}">
      <label class="ct-field-label" for="ct-icon">${esc(this._ctLabel('icon_label', 'Sidebar icon'))}</label>
      <div class="ct-icon-row">
        <input type="text" id="ct-icon" class="settings-text-input ct-icon-input" maxlength="24" value="${esc(type ? type.icon : '')}" aria-describedby="ct-icon-hint">
        <div class="ct-quick-icons">${QUICK_ICONS.map(i => `<button type="button" class="ct-quick-icon" data-icon="${i}">${i}</button>`).join('')}</div>
      </div>
      <small class="ct-hint" id="ct-icon-hint">${esc(this._ctLabel('icon_hint', 'Pick one, or type any emoji or a short word.'))}</small>
      <div class="ct-field-label">${esc(this._ctLabel('functions_label', 'What can people do in these channels?'))}</div>
      ${groups}
      ${type && type.channelCount ? `<p class="ct-save-note">${esc(type.channelCount === 1
        ? this._ctLabel('save_note_one', 'Saving also updates the 1 channel of this type.')
        : this._ctLabel('save_note', `Saving also updates the ${type.channelCount} channels of this type.`, { count: type.channelCount }))}</p>` : ''}
      <p class="ct-error" style="display:none"></p>
      <div class="modal-actions" style="margin-top:12px">
        <button type="button" class="btn-sm" data-ct="cancel">${esc(t('modals.common.cancel'))}</button>
        <button type="button" class="btn-sm btn-accent" data-ct="save">${esc(this._ctLabel('save', 'Save'))}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const nameInput = overlay.querySelector('#ct-name');
  const iconInput = overlay.querySelector('#ct-icon');
  const error = overlay.querySelector('.ct-error');
  const sync = () => {
    // Voice off: the voice-only rows are off and say why.
    overlay.querySelectorAll('.ct-fn').forEach(row => {
      const key = row.dataset.fn;
      const box = row.querySelector('input');
      const blocked = NEEDS_VOICE.includes(key) && !fns.voice;
      box.disabled = blocked;
      box.checked = blocked ? false : !!fns[key];
      row.classList.toggle('ct-fn-blocked', blocked);
      const hintEl = row.querySelector('.ct-fn-hint');
      hintEl.textContent = blocked ? this._ctLabel('needs_voice', 'Needs voice chat') : hintEl.dataset.hint;
    });
    overlay.querySelector('.ct-preview-name').textContent = nameInput.value.trim() || this._ctLabel('preview_channel', 'channel-name');
    overlay.querySelector('.ct-preview-icon').textContent = iconInput.value.trim() || '?';
    overlay.querySelectorAll('.ct-quick-icon').forEach(b => b.classList.toggle('active', b.dataset.icon === iconInput.value.trim()));
  };
  overlay.querySelectorAll('.ct-fn input').forEach(box => box.addEventListener('change', () => {
    fns[box.closest('.ct-fn').dataset.fn] = box.checked ? 1 : 0;
    sync();
  }));
  overlay.querySelectorAll('.ct-quick-icon').forEach(b => b.addEventListener('click', () => { iconInput.value = b.dataset.icon; sync(); }));
  nameInput.addEventListener('input', sync);
  iconInput.addEventListener('input', sync);
  sync();

  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
  const save = () => {
    const payload = { name: nameInput.value, icon: iconInput.value, functions: fns };
    if (type) payload.id = type.id;
    this.socket.emit('save-channel-type', payload, (res) => {
      if (res?.error) { error.textContent = res.error; error.style.display = ''; return; }
      close();
      this._showToast(this._ctLabel('saved', 'Channel type saved'), 'success');
    });
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  overlay.querySelector('[data-ct="cancel"]').addEventListener('click', close);
  overlay.querySelector('[data-ct="save"]').addEventListener('click', save);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', onKey);
  setTimeout(() => (type ? iconInput : nameInput).focus(), 0);
},

// ── Picker, from a channel's right-click menu ───────────

_openChannelTypePicker(code) {
  const ch = this.channels.find(c => c.code === code);
  if (!ch) return;
  const esc = (s) => this._escapeHtml(s);
  const types = this.channelTypes || [];
  let selected = ch.type_id || null;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.style.display = 'flex';
  overlay.style.zIndex = '100002';
  const option = (id, icon, name, summary) => `
    <button type="button" class="ct-option" data-id="${id ?? ''}" role="radio">
      <span class="ct-option-icon">${esc(icon)}</span>
      <span class="ct-option-text"><span class="ct-option-name">${esc(name)}</span><span class="ct-option-summary">${esc(summary)}</span></span>
    </button>`;
  overlay.innerHTML = `
    <div class="modal ct-picker">
      <h3 style="margin-top:0">${esc(this._ctLabel('picker_title', `Channel type for #${ch.name}`, { name: ch.name }))}</h3>
      <div class="ct-options" role="radiogroup">
        ${types.map(ty => option(ty.id, ty.icon, ty.name, this._channelTypeSummary(ty.functions))).join('')}
        ${types.length ? '' : `<p class="muted-text">${esc(this._ctLabel('picker_empty', 'There are no channel types yet.'))}</p>`}
        ${option(null, '⚙️', this._ctLabel('picker_none', 'None'), this._ctLabel('picker_none_hint', 'Set its functions one by one in Channel Functions'))}
      </div>
      <div class="modal-actions ct-picker-actions" style="margin-top:12px">
        ${this._canManageChannelTypes() ? `<button type="button" class="btn-sm ct-manage" data-ct="manage">${esc(this._ctLabel('picker_manage', 'Manage types…'))}</button>` : ''}
        <button type="button" class="btn-sm" data-ct="cancel">${esc(t('modals.common.cancel'))}</button>
        <button type="button" class="btn-sm btn-accent" data-ct="apply">${esc(this._ctLabel('picker_apply', 'Apply'))}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const sync = () => overlay.querySelectorAll('.ct-option').forEach(b => {
    const on = (b.dataset.id ? Number(b.dataset.id) : null) === selected;
    b.classList.toggle('selected', on);
    b.setAttribute('aria-checked', String(on));
  });
  overlay.querySelectorAll('.ct-option').forEach(b => {
    b.addEventListener('click', () => { selected = b.dataset.id ? Number(b.dataset.id) : null; sync(); });
    b.addEventListener('dblclick', () => apply());
  });
  sync();

  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
  const apply = () => {
    if (selected === (ch.type_id || null)) return close();
    this.socket.emit('set-channel-type', { code, typeId: selected }, (res) => {
      if (res?.error) return this._showToast(res.error, 'error');
      close();
      const type = types.find(ty => ty.id === selected);
      this._showToast(type
        ? this._ctLabel('applied', `#${ch.name} is now ${type.name}`, { name: ch.name, type: type.name })
        : this._ctLabel('cleared', `#${ch.name} no longer has a type`, { name: ch.name }), 'success');
    });
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); if (e.key === 'Enter') apply(); };
  overlay.querySelector('[data-ct="cancel"]').addEventListener('click', close);
  overlay.querySelector('[data-ct="apply"]').addEventListener('click', apply);
  overlay.querySelector('[data-ct="manage"]')?.addEventListener('click', () => {
    close();
    this._openChannelTypesSettings();
  });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', onKey);
  setTimeout(() => overlay.querySelector('.ct-option.selected')?.focus(), 0);
},

_openChannelTypesSettings() {
  document.getElementById('open-settings-btn')?.click();
  // The settings window settles on its first pages right after opening.
  setTimeout(() => {
    this._switchSettingsTab('admin');
    document.querySelector('#settings-nav .settings-nav-item[data-target="section-channel-types"]')?.click();
  }, 50);
},

// A line at the top of Channel Functions naming the channel's type.
_updateChannelTypeNote(ch) {
  const panel = document.getElementById('channel-functions-panel');
  if (!panel) return;
  let note = panel.querySelector('.cfn-type-note');
  const type = this._channelTypeOf(ch);
  if (!type) { note?.remove(); return; }
  if (!note) {
    note = document.createElement('div');
    note.className = 'cfn-type-note';
    panel.prepend(note);
  }
  note.textContent = this._ctLabel('cfn_note', `This channel is ${type.icon} ${type.name}. Changing a function below takes it out of that type.`, { icon: type.icon, name: type.name });
},

};
