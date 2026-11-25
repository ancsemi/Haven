// Muting, for yourself.
//
// Server mute: Off, Mute all, or Mute except @mentions. DMs always come
// through. It is saved on your account (preference server_mute) so it holds
// on every device and the server leaves out your push notifications too.
// Muting only quiets notifications: sounds, pop-ups, push and the taskbar
// badge. The unread counts in your own sidebar still show what is new.
// Set from Settings > Sounds, or by right-clicking the server's icon. In
// the desktop app any server's icon can be muted, and muted servers carry a
// mark in the server bar (the desktop app keeps a copy for that and hands a
// change to that server's page, which saves it there).
//
// Mute for me: right-click someone and choose Mute for me. Their messages
// stop making sounds, pop-ups and push notifications for you, mentions and
// DMs included. Only you are affected (preference muted_users). The
// moderator action that stops someone posting is Timeout.

const MODES = ['all', 'mentions'];

export default {

_serverMuteMode() {
  const v = this._userPrefs?.server_mute;
  if (MODES.includes(v)) return v;
  // The older device-only switch, until it is moved onto the account.
  try { if (localStorage.getItem('haven_server_muted') === '1') return 'all'; } catch { /* storage blocked: not muted */ }
  return 'off';
},

_mutedUserIds() {
  const raw = this._userPrefs?.muted_users;
  if (this._mutedUsersRaw === raw && this._mutedUsersSet) return this._mutedUsersSet;
  let ids = [];
  try { ids = raw ? JSON.parse(raw) : []; } catch (err) { console.warn('[mute] unreadable muted members list', err.message); }
  this._mutedUsersRaw = raw;
  this._mutedUsersSet = new Set((Array.isArray(ids) ? ids : []).map(Number).filter(Number.isInteger));
  return this._mutedUsersSet;
},

// True when this message should stay quiet: its sender is muted for you, or
// the server is muted and it is not a DM (or, with "except @mentions", not a
// mention of you).
_notifyBlockedByMutes({ senderId, isDm, isMention, isReply, channelCode }) {
  if (senderId != null && this._mutedUserIds().has(Number(senderId))) return true;
  const mode = this._serverMuteMode();
  if (mode === 'all') return !isDm;
  if (mode === 'mentions' && !isDm && !isMention) return true;
  return !isDm && !isMention && !isReply && !!channelCode && this._channelNotifyLevel(channelCode) === 'mentions';
},

_readChannelList(key) {
  try { const v = JSON.parse(localStorage.getItem(key) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
},

_ownUnmutedChannels() {
  return new Set(this._readChannelList('haven_unmuted_channels'));
},

_mutedChannelList(channels = this.channels) {
  const own = this._readChannelList('haven_muted_channels');
  const unmuted = this._ownUnmutedChannels();
  const byDefault = (channels || []).filter(c => !c.is_dm && c.default_notify === 'muted' && !unmuted.has(c.code) && !own.includes(c.code)).map(c => c.code);
  return byDefault.length ? own.concat(byDefault) : own;
},

_channelNotifyLevel(code) {
  if (this._mutedChannelList().includes(code)) return 'muted';
  const ch = (this.channels || []).find(c => c.code === code);
  return ch && !ch.is_dm && ch.default_notify === 'mentions' && !this._ownUnmutedChannels().has(code) ? 'mentions' : 'all';
},

_setChannelMuted(code, muted) {
  const put = (key, on) => localStorage.setItem(key, JSON.stringify(on ? Array.from(new Set([...this._readChannelList(key), code])) : this._readChannelList(key).filter(c => c !== code)));
  put('haven_muted_channels', muted);
  put('haven_unmuted_channels', !muted);
  this._syncChannelMutePref(code, muted);
},

// Which messages this device is pushed: every one while its Notifications
// switch (Settings > Sounds) is on, otherwise only DMs, replies and pings,
// the same as its sounds and pop-ups (src/pushMutes.js).
_pushScope() {
  return this.notifications?.enabled ? 'all' : 'mentions';
},

_syncPushScope() {
  const endpoint = this._pushSubscription?.endpoint;
  const token = this._fcmToken;
  if (endpoint || token) this.socket.emit('set-push-scope', { scope: this._pushScope(), endpoint, token });
},

_setServerMute(mode, { fromDesktop = false } = {}) {
  const next = MODES.includes(mode) ? mode : 'off';
  if (!this._userPrefs) this._userPrefs = {};
  if (next === 'off') {
    delete this._userPrefs.server_mute;
    this.socket.emit('delete-preference', { key: 'server_mute' });
  } else {
    this._userPrefs.server_mute = next;
    this.socket.emit('set-preference', { key: 'server_mute', value: next });
  }
  // The older device switch goes; the account setting replaces it.
  try { localStorage.removeItem('haven_server_muted'); } catch { /* storage blocked: nothing to clear */ }
  if (!fromDesktop) {
    window.havenDesktop?.serverMute?.set?.(location.origin, next === 'off' ? null : next)
      ?.catch?.((err) => console.warn('[mute] could not tell the desktop app', err));
  }
  this._applyServerMuteMarks();
  this._updateDesktopBadge?.();
},

_toggleUserMute(userId, name) {
  const ids = this._mutedUserIds();
  const muted = ids.has(Number(userId));
  const next = new Set(ids);
  if (muted) next.delete(Number(userId)); else next.add(Number(userId));
  const value = JSON.stringify([...next].slice(0, 500));
  if (!this._userPrefs) this._userPrefs = {};
  if (next.size) {
    this._userPrefs.muted_users = value;
    this.socket.emit('set-preference', { key: 'muted_users', value });
  } else {
    delete this._userPrefs.muted_users;
    this.socket.emit('delete-preference', { key: 'muted_users' });
  }
  this._mutedUsersSet = null;
  this._showToast(t(muted ? 'mute.unmuted_member' : 'mute.muted_member', { name }), 'success');
},

_setupServerMute() {
  if (this._serverMuteReady) return;
  this._serverMuteReady = true;

  // Right-click this server's own icon.
  document.getElementById('home-server')?.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    this._showServerMuteMenu(e, { own: true });
  });

  // Settings > Sounds.
  const sel = document.getElementById('notif-server-mute-mode');
  sel?.addEventListener('change', () => this._setServerMute(sel.value));

  // Account preferences arrive after load. The older device switch moves
  // onto the account the first time.
  this.socket.on('preferences', () => {
    let legacy = false;
    try { legacy = localStorage.getItem('haven_server_muted') === '1'; } catch { /* storage blocked: nothing to move */ }
    if (legacy && !MODES.includes(this._userPrefs?.server_mute)) this._setServerMute('all');
    else {
      // Desktop: keep its copy in step with the account.
      const mode = this._serverMuteMode();
      window.havenDesktop?.serverMute?.set?.(location.origin, mode === 'off' ? null : mode)
        ?.catch?.((err) => console.warn('[mute] could not tell the desktop app', err));
    }
    this._applyServerMuteMarks();
  });

  // Desktop: muting this server from another server's bar lands here, and
  // the bar's marks follow every change.
  const dm = window.havenDesktop?.serverMute;
  if (dm?.onChanged) {
    dm.onChanged(({ url, mode } = {}) => {
      if (url === location.origin) {
        const want = MODES.includes(mode) ? mode : 'off';
        if (want !== this._serverMuteMode()) this._setServerMute(want, { fromDesktop: true });
      }
      this._refreshDesktopMutes();
    });
    this._refreshDesktopMutes();
  }
  this._applyServerMuteMarks();
},

_refreshDesktopMutes() {
  const dm = window.havenDesktop?.serverMute;
  if (!dm?.getAll) return;
  dm.getAll().then((all) => {
    this._desktopMutes = all && typeof all === 'object' ? all : {};
    this._applyServerMuteMarks();
  }).catch((err) => console.warn('[mute] could not read the muted servers', err));
},

// The 🔕 mark on this server's icon and on muted servers in the bar, and the
// Settings choice.
_applyServerMuteMarks() {
  const mode = this._serverMuteMode();
  const home = document.getElementById('home-server');
  if (home) {
    home.classList.toggle('server-muted', mode !== 'off');
    home.dataset.muteTitle = mode === 'off' ? '' : t(mode === 'all' ? 'mute.server_muted_all' : 'mute.server_muted_mentions');
  }
  const sel = document.getElementById('notif-server-mute-mode');
  if (sel && sel.value !== mode) sel.value = mode;
  const mutes = this._desktopMutes || {};
  document.querySelectorAll('#server-list .server-icon.remote').forEach(el => {
    let origin = '';
    try { origin = new URL(el.dataset.url).origin; } catch { origin = ''; } // not a URL: no mark
    el.classList.toggle('server-muted', !!mutes[origin]);
  });
},

// The menu on a server icon. Muting another server needs the desktop app;
// in a browser only the server you are on can be muted from here.
_showServerMuteMenu(e, { own = false, url = null } = {}) {
  document.getElementById('server-mute-menu')?.remove();
  const desktop = window.havenDesktop?.serverMute;
  let origin = location.origin;
  if (!own) { try { origin = new URL(url).origin; } catch { return; } } // not a URL: no menu
  const current = own ? this._serverMuteMode() : ((this._desktopMutes || {})[origin] || 'off');
  const canMute = own || !!desktop;
  const esc = (s) => this._escapeHtml(String(s));
  const item = (act, label, on) => `<button class="channel-ctx-item" data-act="${act}">${on ? '✓ ' : ''}${esc(label)}</button>`;
  const items = [];
  if (!own) items.push(item('edit', `✏️ ${t('mute.edit_server')}`, false), '<hr class="channel-ctx-sep">');
  if (canMute) {
    items.push(item('all', `🔕 ${t('mute.mute_server')}`, current === 'all'));
    items.push(item('mentions', `@ ${t('mute.mute_except_mentions')}`, current === 'mentions'));
    if (current !== 'off') items.push(item('off', `🔔 ${t('mute.unmute_server')}`, false));
  }
  const menu = document.createElement('div');
  menu.id = 'server-mute-menu';
  menu.className = 'channel-ctx-menu';
  menu.innerHTML = items.join('');
  menu.style.left = e.clientX + 'px';
  menu.style.top = e.clientY + 'px';
  document.body.appendChild(menu);
  const r = menu.getBoundingClientRect();
  if (r.right > window.innerWidth) menu.style.left = (window.innerWidth - r.width - 8) + 'px';
  if (r.bottom > window.innerHeight) menu.style.top = (window.innerHeight - r.height - 8) + 'px';
  const close = () => { menu.remove(); document.removeEventListener('click', onDoc, true); };
  const onDoc = (ev) => { if (!menu.contains(ev.target)) close(); };
  setTimeout(() => document.addEventListener('click', onDoc, true), 0);
  menu.addEventListener('click', (ev) => {
    const act = ev.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    close();
    if (act === 'edit') { this._editServer(url); return; }
    if (own) { this._setServerMute(act); return; }
    desktop.set(origin, act === 'off' ? null : act)
      .then(() => this._refreshDesktopMutes())
      .catch((err) => console.warn('[mute] could not mute that server', err));
  });
},

};
