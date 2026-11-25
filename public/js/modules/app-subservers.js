// Sub-servers: one server split into groups of channels (server side in
// src/subservers.js). A row of pills above the channel list picks which group
// the sidebar shows, and "Main" holds the channels outside any sub-server.
// Members with Manage Server add, edit, reorder and delete sub-servers, and
// move a channel into one from the channel's right-click menu. A sub-server
// can need roles; members without them never see it or its channels.

const QUICK_ICONS = ['🏠', '🎨', '🎮', '🔞', '📚', '🎵', '🛠️', '⭐', '🏆', '💬'];

export default {

_setupSubservers() {
  this._subservers = [];
  this._subserverManage = false;
  this._subserverId = parseInt(localStorage.getItem('haven_subserver') || '', 10) || null;
  const load = () => this._subserverLoad();
  this.socket.on('connect', load);
  if (this.socket.connected) load();
  this.socket.on('subservers-changed', load);
  this.socket.on('roles-updated', load);
  document.querySelector('[data-action="move-to-subserver"]')?.addEventListener('click', () => {
    const code = this._ctxMenuChannel;
    this._closeChannelCtxMenu();
    if (code) this._openSubserverPicker(code);
  });
},

// A server without sub-servers never answers, and nothing changes.
_subserverLoad() {
  this.socket.emit('subserver-list', {}, (res) => {
    if (!res || !res.ok) return;
    this._subservers = Array.isArray(res.subservers) ? res.subservers : [];
    this._subserverManage = !!res.canManage;
    if (this._subserverId && !this._subservers.some(s => s.id === this._subserverId)) this._subserverSet(null, false);
    if (this.channels) this._renderChannels();
  });
},

_subserverSet(id, render = true) {
  this._subserverId = id || null;
  if (this._subserverId) localStorage.setItem('haven_subserver', String(this._subserverId));
  else localStorage.removeItem('haven_subserver');
  if (render && this.channels) this._renderChannels();
},

// The sub-server a channel shows under. One this member has not heard of
// yet counts as the main server until the list catches up.
_subserverGroup(ch) {
  const id = ch?.subserver_id ?? null;
  return id !== null && (this._subservers || []).some(s => s.id === id) ? id : null;
},

_subserverShows(ch) {
  return !this._subservers?.length || this._subserverGroup(ch) === this._subserverId;
},

// The sub-server whose required roles a channel takes, if it has any.
_subserverGateOf(ch) {
  const id = this._subserverGroup(ch);
  return id === null ? null : this._subservers.find(s => s.id === id && s.gated) || null;
},

// Opening a channel from another sub-server (a link, a mention, search)
// brings its sub-server up in the sidebar.
_subserverFollow(ch) {
  if (!this._subservers?.length || !ch || ch.is_dm) return;
  const id = this._subserverGroup(ch);
  if (id !== this._subserverId) this._subserverSet(id);
},

_renderSubserverBar() {
  const bar = document.getElementById('subserver-bar');
  if (!bar) return;
  const subs = this._subservers || [];
  // A channel in a sub-server this member has not heard of (just made, or
  // just opened by a role): ask again, once for each new set of them.
  const unknown = [...new Set((this.channels || []).filter(c => c.subserver_id != null && !subs.some(s => s.id === c.subserver_id)).map(c => c.subserver_id))].sort().join(',');
  if (unknown && unknown !== this._subserverAskedFor) { this._subserverAskedFor = unknown; this._subserverLoad(); }
  bar.style.display = subs.length ? '' : 'none';
  if (!subs.length) { bar.innerHTML = ''; return; }
  const esc = (s) => this._escapeHtml(s || '');
  const pill = (id, icon, name, gated) => {
    const on = id === this._subserverId;
    return `<button type="button" class="subserver-pill${on ? ' active' : ''}" role="tab" aria-selected="${on}" data-id="${id ?? ''}" title="${esc(name)}${gated ? ` · ${esc(t('subservers.gated_title'))}` : ''}">
      ${icon ? `<span class="subserver-icon" aria-hidden="true">${esc(icon)}</span>` : ''}<span class="subserver-name">${esc(name)}</span>${gated ? '<span class="subserver-lock" aria-hidden="true">🔒</span>' : ''}<span class="subserver-dot" aria-hidden="true"></span>
    </button>`;
  };
  const tools = this._subserverManage
    ? `${this._subserverId ? `<button type="button" class="subserver-tool" data-act="edit" title="${esc(t('subservers.edit'))}" aria-label="${esc(t('subservers.edit'))}">⚙</button>` : ''}<button type="button" class="subserver-tool" data-act="new" title="${esc(t('subservers.new'))}" aria-label="${esc(t('subservers.new'))}">＋</button>`
    : '';
  bar.innerHTML = pill(null, '🏠', t('subservers.main')) + subs.map(s => pill(s.id, s.icon, s.name, s.gated)).join('') + tools;
  bar.onclick = (e) => {
    const tool = e.target.closest('.subserver-tool');
    if (tool) return tool.dataset.act === 'new' ? this._openSubserverEditor(null) : this._openSubserverEditor(subs.find(s => s.id === this._subserverId));
    const p = e.target.closest('.subserver-pill');
    if (p) this._subserverSet(p.dataset.id ? parseInt(p.dataset.id, 10) : null);
  };
  // Keep the picked pill in view by scrolling the row alone, never the sidebar.
  const on = bar.querySelector('.subserver-pill.active');
  if (on) {
    const b = bar.getBoundingClientRect(), p = on.getBoundingClientRect();
    if (p.left < b.left || p.right > b.right) bar.scrollLeft += p.left - b.left - 8;
  }
  this._subserverDots();
},

// A dot on every other sub-server with unread messages.
_subserverDots() {
  const bar = document.getElementById('subserver-bar');
  if (!bar || !this._subservers?.length) return;
  const unread = new Set();
  for (const c of this.channels || []) {
    if (!c.is_dm && (this.unreadCounts?.[c.code] || 0) > 0) unread.add(this._subserverGroup(c));
  }
  bar.querySelectorAll('.subserver-pill').forEach(p => {
    const id = p.dataset.id ? parseInt(p.dataset.id, 10) : null;
    p.classList.toggle('has-unread', id !== this._subserverId && unread.has(id));
  });
},

// Add (sub null) or edit a sub-server. `after` gets the saved sub-server.
_openSubserverEditor(sub, after) {
  if (sub === undefined) return;
  const esc = (s) => this._escapeHtml(s || '');
  this._roleGateFields(sub?.roleGate || null, (fields) => {
    const body = `<label class="subserver-field"><span>${t('subservers.name')}</span>
        <input type="text" class="subserver-name-input" maxlength="40" value="${esc(sub?.name)}" placeholder="${esc(t('subservers.name_placeholder'))}"></label>
      <label class="subserver-field"><span>${t('subservers.icon')}</span>
        <input type="text" class="subserver-icon-input" maxlength="16" value="${esc(sub?.icon)}" placeholder="🎨"></label>
      <div class="subserver-quick">${QUICK_ICONS.map(i => `<button type="button" class="subserver-quick-btn" data-icon="${i}">${i}</button>`).join('')}</div>
      <h4 class="subserver-roles-title">${t('subservers.roles')}</h4>
      <p class="settings-hint">${t('subservers.roles_hint')}</p>
      ${fields}
      ${sub ? `<div class="subserver-edit-actions">
        <button type="button" class="btn-sm subserver-move" data-dir="-1">${t('subservers.move_earlier')}</button>
        <button type="button" class="btn-sm subserver-move" data-dir="1">${t('subservers.move_later')}</button>
        <button type="button" class="btn-sm btn-danger subserver-delete">${t('subservers.delete')}</button>
      </div>` : ''}`;
    const ov = this._openToolModal({
      title: sub ? t('subservers.edit_title', { name: esc(sub.name) }) : t('subservers.new_title'), body,
      confirmText: t(sub ? 'subservers.save' : 'subservers.create'),
      onConfirm: async (o) => {
        const saved = await this._subserverSave(sub, o);
        if (saved && after) after(saved);
        return !!saved;
      },
    });
    const icon = ov.querySelector('.subserver-icon-input');
    ov.querySelector('.subserver-quick').addEventListener('click', (e) => {
      const b = e.target.closest('.subserver-quick-btn');
      if (b) icon.value = b.dataset.icon;
    });
    ov.querySelectorAll('.subserver-move').forEach(b => b.addEventListener('click', () => this._subserverShift(sub.id, parseInt(b.dataset.dir, 10))));
    ov.querySelector('.subserver-delete')?.addEventListener('click', async () => {
      const ok = await this._showConfirmModal(t('subservers.delete_title', { name: sub.name }), t('subservers.delete_body'), { danger: true });
      if (!ok) return;
      this._roleEmit('subserver-delete', { id: sub.id }, (r) => {
        if (!r?.ok) return this._showToast(r?.error || t('subservers.save_failed'), 'error');
        ov.remove();
        this._showToast(t('subservers.deleted'), 'success');
      });
    });
    setTimeout(() => ov.querySelector('.subserver-name-input')?.focus(), 0);
  });
},

// Resolves to the saved sub-server, or false (with a toast) so the dialog stays open.
async _subserverSave(sub, ov) {
  const ask = (event, data) => new Promise(res => this._roleEmit(event, data, res));
  const name = ov.querySelector('.subserver-name-input').value.trim();
  const icon = ov.querySelector('.subserver-icon-input').value.trim();
  const gate = this._roleGateRead(ov);
  let r = sub ? await ask('subserver-update', { id: sub.id, name, icon, ...gate }) : await ask('subserver-create', { name, icon });
  if (r?.ok && !sub && gate.roles.length) r = await ask('subserver-update', { id: r.subserver.id, ...gate });
  if (!r?.ok) { this._showToast(r?.error || t('subservers.save_failed'), 'error'); return false; }
  this._showToast(t('subservers.saved'), 'success');
  if (!sub) this._subserverSet(r.subserver.id, false);
  return r.subserver;
},

_subserverShift(id, dir) {
  const ids = this._subservers.map(s => s.id);
  const i = ids.indexOf(id), j = i + dir;
  if (i < 0 || j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  this._roleEmit('subserver-reorder', { ids }, (r) => {
    if (!r?.ok) this._showToast(r?.error || t('subservers.save_failed'), 'error');
  });
},

_openSubserverPicker(code) {
  const ch = this.channels.find(c => c.code === code);
  if (!ch) return;
  const esc = (s) => this._escapeHtml(s || '');
  const cur = this._subserverGroup(ch);
  const opts = [{ id: null, icon: '🏠', name: t('subservers.main') }, ...this._subservers];
  const body = `<p class="settings-hint">${t('subservers.move_hint')}</p>
    <div class="subserver-pick">${opts.map(s => `<button type="button" class="subserver-pick-btn${s.id === cur ? ' current' : ''}" data-id="${s.id ?? ''}"${s.id === cur ? ' aria-current="true"' : ''}>
      <span aria-hidden="true">${esc(s.icon)}</span> ${esc(s.name)}${s.gated ? ' <span aria-hidden="true">🔒</span>' : ''}</button>`).join('')}
      <button type="button" class="subserver-pick-btn subserver-pick-new" data-new="1">＋ ${t('subservers.new')}</button>
    </div>`;
  const ov = this._openToolModal({ title: t('subservers.move_title', { name: esc(ch.name) }), body });
  ov.querySelector('.subserver-pick').addEventListener('click', (e) => {
    const b = e.target.closest('.subserver-pick-btn');
    if (!b) return;
    ov.remove();
    if (b.dataset.new) return this._openSubserverEditor(null, (made) => this._subserverMove(code, made.id));
    const id = b.dataset.id ? parseInt(b.dataset.id, 10) : null;
    if (id !== cur) this._subserverMove(code, id);
  });
},

_subserverMove(code, id) {
  this._roleEmit('channel-set-subserver', { code, subserverId: id }, (r) => {
    if (!r?.ok) return this._showToast(r?.error || t('subservers.save_failed'), 'error');
    const s = (this._subservers || []).find(x => x.id === id);
    this._showToast(t('subservers.moved', { name: s ? s.name : t('subservers.main') }), 'success');
  });
},

};
