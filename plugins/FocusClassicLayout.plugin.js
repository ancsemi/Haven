/**
 * @name Focus Classic Layout
 * @description The original desktop Focus view, picked in Settings, Layout: a rail with Server, DMs, Activity and You shows one list at a time beside the chat. Click the open tab again to hide the list. Alt+1 to Alt+4 switch tabs.
 * @author Amni-Scient
 * @version 3.0.0
 */
class FocusClassicLayout {
  start() {
    if (this._started) return;
    Object.assign(this, { _started: true, _engaged: false, _placed: [], _built: [], _off: [], _media: window.matchMedia('(min-width: 901px)'), _chip: 'all', _seq: 0, _tab: HavenApi.Data.load(FocusClassicLayout.STORE, 'tab', 'server') });
    HavenApi.DOM.addStyle('FocusClassicLayout', FocusClassicLayout.CSS);
    this._on(this._media, 'change', () => this._sync());
    this._on(document, 'haven:layout-editing', () => this._sync());
    this._on(document, 'haven:layout-owner-change', (e) => e.detail?.owner !== 'FocusClassicLayout' && this._sync());
    this._on(document, 'keydown', (e) => this._key(e), true);
    this._wire = setInterval(() => { this._attach(); this._callSync(); }, 1000);
    this._attach();
    HavenApi.Data.load('FocusClassicLayout', 'layoutOn', '0') === '1' && this._engage(false);
  }
  stop() {
    if (!this._started) return;
    this._disengage(false);
    clearInterval(this._wire);
    clearTimeout(this._pending);
    this._sock && ['new-message', 'search-results', 'connect'].forEach(ev => this._sock.off(ev, this._handlers[ev]));
    HavenApi.Patcher.unpatchAll('FocusClassicLayout');
    this._off.forEach(([t, ty, fn, o]) => t.removeEventListener(ty, fn, o));
    Object.assign(this, { _off: [], _sock: null, _patched: false, _started: false });
    HavenApi.DOM.removeStyle('FocusClassicLayout');
  }
  _on(t, ty, fn, o) { t.addEventListener(ty, fn, o); this._off.push([t, ty, fn, o]); }
  _t(key, fallback) { const s = typeof window.t === 'function' ? window.t(key) : null; return typeof s === 'string' && s && s !== key ? s : fallback; }
  _engage(persist = true) {
    persist && HavenApi.Data.save('FocusClassicLayout', 'layoutOn', '1');
    if (this._engaged) return;
    this._engaged = true;
    document.documentElement.setAttribute('data-focus-layout', 'classic');
    this._sync();
  }
  _disengage(persist = true) {
    persist && HavenApi.Data.save('FocusClassicLayout', 'layoutOn', '0');
    if (!this._engaged) return;
    this._engaged = false;
    this._restore();
    document.documentElement.removeAttribute('data-focus-layout');
  }
  _sync() { this._engaged && this._media?.matches && !document.documentElement.hasAttribute('data-haven-layout-editing') ? this._apply() : this._restore(); }
  _attach() {
    const app = window.app, s = HavenApi.socket;
    if (app && !this._patched && typeof app._renderChannels === 'function') {
      this._patched = true;
      ['_renderChannels', '_updateBadge', '_updateTabTitle', '_appendMessage', '_renderMessages'].forEach(m => HavenApi.Patcher.after('FocusClassicLayout', app, m, () => { this._soon(); }));
      HavenApi.Patcher.after('FocusClassicLayout', app, 'switchChannel', (args) => { this._seen(args[0]); this._soon(); });
    }
    if (!s || s === this._sock) return;
    this._sock && ['new-message', 'search-results', 'connect'].forEach(ev => this._sock.off(ev, this._handlers[ev]));
    this._sock = s;
    this._handlers = { 'new-message': (d) => setTimeout(() => this._incoming(d), 400), 'search-results': (d) => this._backfilled(d), connect: () => this._backfill() };
    Object.entries(this._handlers).forEach(([ev, fn]) => s.on(ev, fn));
    s.connected && this._backfill();
  }
  _el(tag, cls, text) { return Object.assign(document.createElement(tag), cls ? { className: cls } : {}, text != null ? { textContent: text } : {}); }
  _move(node, parent, before) { this._placed.push([node, node.parentNode, node.nextSibling]); parent.insertBefore(node, before); }
  _restore() {
    ['data-focus-desktop', 'data-focus-tab', 'data-focus-pane-hidden', 'data-focus-add', 'data-focus-people'].forEach(a => document.documentElement.removeAttribute(a));
    this._placed.reverse().forEach(([node, parent, next]) => parent.insertBefore(node, next?.parentNode === parent ? next : null));
    this._built.forEach(n => n.remove());
    Object.assign(this, { _placed: [], _built: [], _rail: null, _head: null, _act: null, _you: null });
    HavenApi.Layout?.release('FocusClassicLayout');
  }
  _callSync() { document.documentElement.toggleAttribute('data-fc-voice', !!window.app?.voice?.inVoice); }
  _soon() { clearTimeout(this._pending); this._pending = setTimeout(() => this._rail && this._render(), 120); }
  _chan(code) { return (window.app?.channels || []).find(c => c.code === code); }
  _serverName() { return (document.querySelector('.sidebar-header .brand-text')?.textContent || '').trim().replace(/^HAVEN$/, 'Haven') || document.title || 'Haven'; }
  _store() { try { return JSON.parse(HavenApi.Data.load(FocusClassicLayout.STORE, 'inbox:' + location.host, '[]')) || []; } catch { return []; } }
  _keep(items) { HavenApi.Data.save(FocusClassicLayout.STORE, 'inbox:' + location.host, JSON.stringify(items.sort((a, b) => b.at - a.at).slice(0, 150))); this._soon(); }
  _muted(code) { try { return JSON.parse(localStorage.getItem('haven_muted_channels') || '[]').includes(code); } catch { return false; } }
  _classify(code, m) {
    const app = window.app, me = app?.user, ch = (app?.channels || []).find(c => c.code === code), txt = String(m?.content || '');
    if (!me || !m || !ch || ch.is_dm || m.user_id === me.id || this._muted(code)) return null;
    const esc = String(me.username || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return (esc && new RegExp(`@${esc}(?!\\w)`, 'i').test(txt)) || /(?<![\w@])@(everyone|here)\b/i.test(txt) || app._mentionsMyRole?.(txt) ? 'mention' : m.replyContext?.user_id === me.id ? 'reply' : null;
  }
  _item(code, m, kind, read) { return { k: `${kind}:${code}:${m.id}`, kind, code, id: m.id, who: m.display_name || m.username || '', text: String(m.content || '').replace(/[*_~`>#|]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 160), at: Date.parse(m.created_at || '') || Date.now(), read }; }
  _incoming(d) {
    const app = window.app, kind = this._classify(d?.channelCode, d?.message);
    if (!kind) return;
    const read = d.channelCode === app?.currentChannel && document.hasFocus() && !document.hidden, items = this._store();
    items.some(x => x.k === `${kind}:${d.channelCode}:${d.message.id}`) || this._keep([this._item(d.channelCode, d.message, kind, read), ...items]);
  }
  _backfill() {
    const me = window.app?.user?.username;
    if (!me || !this._sock || me.length < 3) return;
    this._token = `focus-${++this._seq}`;
    this._sock.emit('search-messages', { query: me, page: 1, sort: 'newest', token: this._token });
  }
  _backfilled(d) {
    if (!d || d.token !== this._token) return;
    const items = this._store(), have = new Set(items.map(x => x.k));
    const got = (d.results || []).map(r => { const m = { id: r.id, content: r.content, user_id: r.user_id, username: r.username, created_at: r.created_at }, kind = this._classify(r.channel_code, m); return kind === 'mention' ? this._item(r.channel_code, m, kind, true) : null; }).filter(x => x && !have.has(x.k));
    got.length && this._keep([...items, ...got]);
  }
  _seen(code) {
    const items = this._store();
    items.some(x => x.code === code && !x.read) && this._keep(items.map(x => x.code === code ? { ...x, read: true } : x));
  }
  _markAll() {
    this._keep(this._store().map(x => ({ ...x, read: true })));
    document.querySelector('[data-action="mark-all-read"]')?.click();
  }
  _unreadRows() {
    const app = window.app, counts = app?.unreadCounts || {};
    return (app?.channels || []).filter(c => counts[c.code] > 0 && (c.is_dm || !this._muted(c.code))).map(c => ({ k: 'u:' + c.code, kind: c.is_dm ? 'dm' : 'unread', code: c.code, count: counts[c.code], who: c.is_dm ? (c.dm_target?.displayName || c.dm_target?.username || c.name) : '#' + c.name, at: 0, read: false }));
  }
  _counts() {
    const app = window.app, counts = app?.unreadCounts || {}, chans = app?.channels || [];
    const dms = chans.filter(c => c.is_dm).reduce((n, c) => n + (counts[c.code] || 0), 0), server = chans.some(c => !c.is_dm && counts[c.code] > 0 && !this._muted(c.code));
    return { server: server ? -1 : 0, dms, activity: this._store().filter(x => !x.read).length };
  }
  _renderActivity() {
    const pane = this._act, chips = pane.querySelector('.fa-chips'), list = pane.querySelector('.fa-list');
    const all = [...this._store(), ...this._unreadRows()], match = (x) => this._chip === 'all' || x.kind === this._chip;
    chips.replaceChildren(...FocusClassicLayout.CHIPS.map(([id, key, label]) => {
      const n = all.filter(x => !x.read && (id === 'all' || x.kind === id)).length, b = Object.assign(this._el('button', 'fa-chip' + (id === this._chip ? ' active' : ''), this._t(key, label) + (n ? ` ${n > 99 ? '99+' : n}` : '')), { type: 'button' });
      b.setAttribute('aria-pressed', String(id === this._chip));
      b.addEventListener('click', () => { this._chip = id; this._renderActivity(); });
      return b;
    }));
    const shown = all.filter(match), fresh = shown.filter(x => !x.read), old = shown.filter(x => x.read).slice(0, 40), section = (label) => this._el('div', 'fa-section', label);
    list.replaceChildren(...(shown.length ? [...(fresh.length ? [section(this._t('focus.new', 'New')), ...fresh.map(x => this._row(x))] : []), ...(old.length ? [section(this._t('focus.earlier', 'Earlier')), ...old.map(x => this._row(x))] : [])] : [this._el('div', 'fa-empty', this._t('media_gallery.empty', 'Nothing here yet'))]));
  }
  _row(x) {
    const el = this._el, ch = this._chan(x.code), place = ch ? (ch.is_dm ? '' : '#' + ch.name) : '', when = x.at ? new Date(x.at) : null;
    const row = Object.assign(el('button', 'fa-row' + (x.read ? '' : ' unread')), { type: 'button' }), av = el('span', 'fa-avatar', x.kind === 'unread' ? '#' : (x.who || '?').replace(/^#/, '').charAt(0).toUpperCase()), main = el('span', 'fa-main'), top = el('span', 'fa-top');
    av.dataset.kind = x.kind;
    top.append(el('span', 'fa-who', x.who), el('span', 'fa-time', when ? (when.toDateString() === new Date().toDateString() ? when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : when.toLocaleDateString([], { month: 'short', day: 'numeric' })) : ''));
    const label = { mention: this._t('focus.mentioned', 'Mentioned you'), reply: this._t('focus.replied', 'Replied to you') }[x.kind];
    main.append(top, el('span', 'fa-sub', x.count ? (x.count === 1 ? this._t('focus.new_message', '1 new message') : `${x.count} ${this._t('focus.new_messages', 'new messages')}`) : [label, place].filter(Boolean).join(' · ')), ...(x.text ? [el('span', 'fa-text', x.text)] : []));
    row.append(av, main, ...(x.read ? [] : [el('span', 'fa-dot')]));
    row.addEventListener('click', () => this._jump(x));
    return row;
  }
  _apply() {
    if (this._rail) return this._render();
    const q = (sel) => document.querySelector(sel), side = q('[data-haven-region="navigation-sidebar"]'), bar = q('[data-haven-region="server-rail"]'), content = q('[data-haven-region="sidebar-content"]'), account = q('[data-haven-region="account"]');
    if (!side || !bar || !content || !account) return console.warn('[FocusClassicLayout] Required layout regions are unavailable');
    if (HavenApi.Layout && !HavenApi.Layout.acquire('FocusClassicLayout')) return;
    const el = this._el;
    const rail = this._rail = el('nav', 'focus-rail'), servers = el('div', 'fr-servers'), tabs = el('div', 'fr-tabs');
    rail.id = 'focus-rail';
    rail.setAttribute('aria-label', 'Focus');
    tabs.setAttribute('role', 'tablist');
    FocusClassicLayout.TABS.forEach(([id, key, label, path]) => {
      const b = el('button', 'fr-tab'), name = this._t(key, label);
      b.type = 'button';
      b.dataset.tab = id;
      b.setAttribute('role', 'tab');
      b.title = `${name} (Alt+${FocusClassicLayout.TABS.findIndex(x => x[0] === id) + 1}). ${this._t('focus.hide_hint', 'Click again to hide the list')}`;
      b.innerHTML = `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
      b.append(el('span', 'fr-label', name), el('b', 'fr-badge'));
      b.addEventListener('click', () => this._select(id, true));
      tabs.append(b);
    });
    rail.append(servers, tabs);
    side.parentNode.insertBefore(rail, side);
    this._move(bar, servers, null);
    const head = this._head = el('div', 'focus-head'), title = el('h2', 'fh-title'), actions = el('div', 'fh-actions');
    head.append(title, actions);
    const act = this._act = el('div', 'focus-pane focus-activity'), chips = el('div', 'fa-chips'), list = el('div', 'fa-list');
    chips.setAttribute('role', 'tablist');
    act.append(chips, list);
    const you = this._you = el('div', 'focus-pane focus-you'), card = el('div', 'fy-card'), rows = el('div', 'fy-rows');
    you.append(card, rows);
    side.insertBefore(head, content);
    side.insertBefore(act, content);
    side.insertBefore(you, content);
    const call = el('div', 'focus-call'), bottom = side.querySelector(':scope > .sidebar-bottom');
    side.insertBefore(call, bottom);
    ['voice-roster', 'voice-controls', 'voice-settings'].map(r => q(`[data-haven-region="${r}"]`)).filter(Boolean).forEach(n => this._move(n, call, null));
    this._built = [rail, head, act, you, call];
    this._move(account, card, null);
    FocusClassicLayout.YOU.forEach(([sel, key, label]) => {
      const target = q(sel);
      if (!target) return;
      const r = el('button', 'fy-row', this._t(key, label));
      r.type = 'button';
      r.addEventListener('click', () => q(sel)?.click());
      rows.append(r);
    });
    document.documentElement.setAttribute('data-focus-desktop', 'classic');
    this._render();
  }
  _select(id, fromClick) {
    const root = document.documentElement, same = id === this._tab && root.hasAttribute('data-focus-tab');
    fromClick && same ? root.toggleAttribute('data-focus-pane-hidden') : root.removeAttribute('data-focus-pane-hidden');
    this._tab = id;
    HavenApi.Data.save(FocusClassicLayout.STORE, 'tab', id);
    id !== 'server' && root.removeAttribute('data-focus-add');
    this._render();
  }
  _key(e) {
    const i = /^Digit([1-4])$/.exec(e.code || '');
    if (!i || !this._rail || !e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    e.preventDefault();
    this._select(FocusClassicLayout.TABS[i[1] - 1][0], false);
  }
  _render() {
    const root = document.documentElement, tab = FocusClassicLayout.TABS.some(x => x[0] === this._tab) ? this._tab : 'server';
    root.setAttribute('data-focus-tab', tab);
    const counts = this._counts();
    this._rail.querySelectorAll('.fr-tab').forEach(b => {
      const on = b.dataset.tab === tab, n = counts[b.dataset.tab], badge = b.querySelector('.fr-badge');
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', String(on));
      badge.textContent = n > 0 ? (n > 99 ? '99+' : String(n)) : '';
      badge.classList.toggle('dot', n === -1);
    });
    const title = this._head.querySelector('.fh-title'), actions = this._head.querySelector('.fh-actions');
    title.textContent = tab === 'server' ? this._serverName() : tab === 'dms' ? this._t('app.sidebar.direct_messages', 'Direct Messages') : this._t(FocusClassicLayout.TABS.find(x => x[0] === tab)[1], FocusClassicLayout.TABS.find(x => x[0] === tab)[2]);
    actions.replaceChildren(...this._actions(tab));
    tab === 'activity' && this._renderActivity();
  }
  _actions(tab) {
    const mk = (label, title, fn, pressed) => { const b = Object.assign(document.createElement('button'), { type: 'button', className: 'fh-btn', textContent: label, title }); pressed != null && b.setAttribute('aria-pressed', String(pressed)); b.addEventListener('click', fn); return b; };
    const root = document.documentElement;
    const people = mk(this._t('app.sidebar.people', 'People'), this._t('app.sidebar.people', 'People'), () => { root.toggleAttribute('data-focus-people'); this._render(); }, root.hasAttribute('data-focus-people'));
    return tab === 'server' ? [mk('+', `${this._t('app.sidebar.join_channel', 'Join a Channel')} / ${this._t('app.sidebar.create_channel', 'Create Channel')}`, () => { root.toggleAttribute('data-focus-add'); this._render(); }, root.hasAttribute('data-focus-add')), people]
      : tab === 'activity' ? [mk(this._t('forum.mark_all_read', 'Mark all read'), this._t('forum.mark_all_read', 'Mark all read'), () => this._markAll())] : [];
  }
  async _jump(x) {
    const app = window.app;
    if (!app) return;
    x.code !== app.currentChannel && await app.switchChannel(x.code);
    x.id && setTimeout(() => app._jumpToMessage?.(x.id), 600);
    this._keep(this._store().map(y => y.k === x.k || y.code === x.code ? { ...y, read: true } : y));
  }
}
FocusClassicLayout.STORE = 'FocusLayout';
FocusClassicLayout.CHIPS = Object.freeze([['all', 'modals.all_members.filter_all', 'All'], ['mention', 'focus.mentions', 'Mentions'], ['reply', 'settings.sounds_section.replies', 'Replies'], ['dm', 'focus.dms', 'DMs'], ['unread', 'focus.unread', 'Unread']]);
FocusClassicLayout.TABS = Object.freeze([
  ['server', 'status_bar.server', 'Server', '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9v11h14V9"/><path d="M10 20v-6h4v6"/>'],
  ['dms', 'focus.dms', 'DMs', '<path d="M21 12a8 8 0 0 1-11.7 7.1L4 20l1-4.7A8 8 0 1 1 21 12Z"/>'],
  ['activity', 'users.activity', 'Activity', '<path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/>'],
  ['you', 'voice_runtime.you', 'You', '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>']
]);
FocusClassicLayout.YOU = Object.freeze([['#open-settings-btn', 'settings.title', 'Settings'], ['#theme-popup-toggle', 'settings.plugins_section.themes_label', 'Themes'], ['#activities-btn', 'modals.activities.title', 'Activities'], ['#sidebar-members-btn', 'settings.nav.members', 'Members'], ['#donors-btn', 'focus.support', 'Support Haven']]);
FocusClassicLayout.CSS = `@font-face { font-family: 'Focus Archivo'; src: url('/fonts/archivo-var.woff2') format('woff2'); font-weight: 100 900; font-display: swap; }
html[data-focus-desktop="classic"] .focus-rail, html[data-focus-desktop="classic"] [data-haven-region="navigation-sidebar"], html[data-focus-desktop="classic"] [data-haven-region="channel-header"] { font-family: 'Focus Archivo', var(--font-main, system-ui), system-ui, sans-serif; }
html[data-focus-desktop="classic"] .focus-rail { display: flex; flex-direction: column; flex: 0 0 77px; width: 77px; height: 100%; box-sizing: border-box; background: var(--bg-tertiary); border-inline-end: 1px solid var(--border); padding: 7px 0; z-index: 3; }
html[data-focus-desktop="classic"] .fr-servers { flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden; padding: 4px 0; scrollbar-width: none; }
html[data-focus-desktop="classic"] .fr-servers [data-haven-region="server-rail"] { display: flex !important; flex-direction: column !important; align-items: center !important; gap: 7px !important; width: 100% !important; height: auto !important; min-height: 0 !important; padding: 0 !important; border: 0 !important; background: none !important; position: static !important; overflow: visible !important; }
html[data-focus-desktop="classic"] .fr-servers [data-haven-region="server-list"] { display: flex !important; flex-direction: column !important; align-items: center; gap: 7px; width: 100%; height: auto !important; position: static !important; }
html[data-focus-desktop="classic"] .fr-servers .server-separator { width: 32px !important; height: 2px !important; margin: 2px auto !important; }
html[data-focus-desktop="classic"] .fr-tabs { display: flex; flex-direction: column; align-items: center; gap: 4px; padding-top: 10px; margin: 7px 10px 0; border-top: 1px solid var(--border); }
html[data-focus-desktop="classic"] .fr-tab { position: relative; display: flex; flex-direction: column; align-items: center; gap: 3px; width: 61px; padding: 8px 0 7px; border: 0; border-radius: 14px; background: none; color: var(--text-muted); cursor: pointer; font: inherit; font-size: 11px; font-weight: 600; transition: background .15s, color .15s; }
html[data-focus-desktop="classic"] .fr-tab:hover { background: color-mix(in srgb, var(--accent) 12%, transparent); color: var(--text-primary); }
html[data-focus-desktop="classic"] .fr-tab.active { background: color-mix(in srgb, var(--accent) 20%, transparent); color: var(--accent); }
html[data-focus-desktop="classic"] .fr-tab:focus-visible, html[data-focus-desktop="classic"] .fa-row:focus-visible, html[data-focus-desktop="classic"] .fa-chip:focus-visible, html[data-focus-desktop="classic"] .fy-row:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
html[data-focus-desktop="classic"] .fr-badge { position: absolute; top: 3px; right: 9px; min-width: 17px; height: 17px; padding: 0 4px; box-sizing: border-box; border-radius: 9px; background: var(--accent); color: var(--accent-text, #fff); font-size: 10px; font-weight: 700; line-height: 17px; text-align: center; }
html[data-focus-desktop="classic"] .fr-badge:empty:not(.dot) { display: none; }
html[data-focus-desktop="classic"] .fr-badge.dot { min-width: 9px; width: 9px; height: 9px; padding: 0; top: 7px; right: 17px; }
html[data-focus-desktop="classic"] [data-haven-region="navigation-sidebar"] { display: flex; flex-direction: column; }
html[data-focus-desktop="classic"] .sidebar-header { display: none !important; }
html[data-focus-desktop="classic"]:not([data-focus-people]) [data-haven-region="context-sidebar"]:not(:has(> [data-haven-region="search-results"][style*="flex"])) { display: none !important; }
html[data-focus-desktop="classic"] .focus-call { flex: 0 0 auto; max-height: 55%; overflow-y: auto; margin: 0 10px; padding: 8px 0 4px; border-top: 1px solid var(--border); }
html[data-focus-desktop="classic"]:not([data-fc-voice]) .focus-call { display: none; }
html[data-focus-desktop="classic"] .focus-call [data-haven-region] { position: static !important; width: auto !important; max-width: none !important; margin: 0 !important; border: 0 !important; background: none !important; box-shadow: none !important; }
html[data-focus-desktop="classic"] .focus-call [data-haven-region="voice-controls"] { flex-wrap: wrap; gap: 6px; padding: 8px 0 4px !important; }
html[data-focus-desktop="classic"] .focus-call [data-haven-region="voice-settings"] { padding: 8px 0 !important; border-top: 1px solid var(--border) !important; }
html[data-focus-desktop="classic"] .focus-head { display: flex; align-items: center; gap: 8px; padding: 18px 16px 12px; flex: 0 0 auto; }
html[data-focus-desktop="classic"] .fh-title { flex: 1 1 auto; min-width: 0; margin: 0; font-size: 24px; font-weight: 800; letter-spacing: -0.02em; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
html[data-focus-desktop="classic"] .fh-btn { flex: 0 0 auto; min-width: 32px; height: 32px; padding: 0 12px; border: 1px solid var(--border); border-radius: 16px; background: var(--bg-secondary); color: var(--text-primary); font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; }
html[data-focus-desktop="classic"] .fh-btn:hover, html[data-focus-desktop="classic"] .fh-btn[aria-pressed="true"] { border-color: var(--accent); color: var(--accent); }
html[data-focus-desktop="classic"] .focus-pane { display: none; flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 0 10px 14px; }
html[data-focus-desktop="classic"][data-focus-tab="activity"] .focus-activity, html[data-focus-desktop="classic"][data-focus-tab="you"] .focus-you { display: block; }
html[data-focus-desktop="classic"][data-focus-tab="activity"] [data-haven-region="sidebar-content"], html[data-focus-desktop="classic"][data-focus-tab="you"] [data-haven-region="sidebar-content"] { display: none !important; }
html[data-focus-desktop="classic"]:not([data-focus-add]) [data-haven-region="join-channel"], html[data-focus-desktop="classic"]:not([data-focus-add]) [data-haven-region="create-channel"], html[data-focus-desktop="classic"][data-focus-tab="dms"] [data-haven-region="join-channel"], html[data-focus-desktop="classic"][data-focus-tab="dms"] [data-haven-region="create-channel"] { display: none !important; }
html[data-focus-desktop="classic"][data-focus-tab="server"] [data-haven-region="direct-messages"], html[data-focus-desktop="classic"][data-focus-tab="server"] #sidebar-split-handle, html[data-focus-desktop="classic"][data-focus-tab="dms"] [data-haven-region="channels"], html[data-focus-desktop="classic"][data-focus-tab="dms"] #sidebar-split-handle { display: none !important; }
html[data-focus-desktop="classic"][data-focus-tab="server"] [data-haven-region="channels"], html[data-focus-desktop="classic"][data-focus-tab="dms"] [data-haven-region="direct-messages"] { flex: 1 1 auto !important; height: auto !important; max-height: none !important; }
html[data-focus-desktop="classic"] #sidebar-split { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
html[data-focus-desktop="classic"] [data-haven-region="sidebar-actions"] { display: none !important; }
html[data-focus-desktop="classic"][data-focus-pane-hidden] [data-haven-region="navigation-sidebar"] { display: none !important; }
html[data-focus-desktop="classic"] .fa-chips { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 6px 10px; }
html[data-focus-desktop="classic"] .fa-chip { height: 30px; padding: 0 12px; border: 1px solid var(--border); border-radius: 15px; background: var(--bg-secondary); color: var(--text-secondary, var(--text-primary)); font: inherit; font-size: 12.5px; font-weight: 600; cursor: pointer; }
html[data-focus-desktop="classic"] .fa-chip:hover { border-color: var(--accent); }
html[data-focus-desktop="classic"] .fa-chip.active { background: var(--accent); border-color: var(--accent); color: var(--accent-text, #fff); }
html[data-focus-desktop="classic"] .fa-section { padding: 12px 8px 6px; font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--text-muted); }
html[data-focus-desktop="classic"] .fa-row { display: flex; align-items: flex-start; gap: 10px; width: 100%; padding: 9px 8px; border: 0; border-radius: 12px; background: none; color: var(--text-primary); font: inherit; text-align: start; cursor: pointer; }
html[data-focus-desktop="classic"] .fa-row:hover { background: var(--bg-hover, color-mix(in srgb, var(--accent) 8%, transparent)); }
html[data-focus-desktop="classic"] .fa-row.unread { background: color-mix(in srgb, var(--accent) 7%, transparent); }
html[data-focus-desktop="classic"] .fa-avatar { flex: 0 0 34px; height: 34px; border-radius: 10px; display: flex; align-items: center; justify-content: center; background: color-mix(in srgb, var(--accent) 22%, var(--bg-secondary)); color: var(--text-primary); font-weight: 700; font-size: 14px; }
html[data-focus-desktop="classic"] .fa-avatar[data-kind="unread"] { background: var(--bg-secondary); color: var(--text-muted); }
html[data-focus-desktop="classic"] .fa-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
html[data-focus-desktop="classic"] .fa-top { display: flex; align-items: baseline; gap: 8px; }
html[data-focus-desktop="classic"] .fa-who { flex: 1 1 auto; min-width: 0; font-weight: 700; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
html[data-focus-desktop="classic"] .fa-time { flex: 0 0 auto; font-size: 11.5px; color: var(--text-muted); }
html[data-focus-desktop="classic"] .fa-sub { font-size: 12px; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
html[data-focus-desktop="classic"] .fa-text { font-size: 13px; color: var(--text-secondary, var(--text-primary)); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
html[data-focus-desktop="classic"] .fa-dot { flex: 0 0 8px; height: 8px; margin-top: 7px; border-radius: 50%; background: var(--accent); }
html[data-focus-desktop="classic"] .fa-empty { padding: 40px 12px; text-align: center; color: var(--text-muted); font-size: 13px; }
html[data-focus-desktop="classic"] .fy-card { margin: 0 4px 14px; padding: 12px; border: 1px solid var(--border); border-radius: 16px; background: var(--bg-secondary); }
html[data-focus-desktop="classic"] .fy-card [data-haven-region="account"] { margin: 0 !important; border: 0 !important; background: none !important; }
html[data-focus-desktop="classic"] .fy-rows { display: flex; flex-direction: column; gap: 2px; }
html[data-focus-desktop="classic"] .fy-row { width: 100%; padding: 11px 14px; border: 0; border-radius: 12px; background: none; color: var(--text-primary); font: inherit; font-size: 14px; font-weight: 600; text-align: start; cursor: pointer; }
html[data-focus-desktop="classic"] .fy-row:hover { background: var(--bg-hover, color-mix(in srgb, var(--accent) 8%, transparent)); }
html[data-focus-desktop] :is(#desktop-app-banner, #android-beta-banner) { display: none !important; }
html[data-focus-desktop] #channel-topic-bar[style*="--text-muted"] { display: none !important; }
html[data-focus-desktop] #header-actions-box:not(:has(#thread-mentions-pill:not([style*="none"]))) { opacity: 0; transition: opacity .15s; }
html[data-focus-desktop] [data-haven-region="channel-header"]:hover #header-actions-box, html[data-focus-desktop] #header-actions-box:focus-within { opacity: 1; }
html[data-focus-desktop="classic"]:not([data-focus-people]) #sidebar-toggle-btn { display: none !important; }
`;
if (typeof module !== 'undefined') module.exports = FocusClassicLayout;
if (typeof _win !== 'undefined') _win.FocusClassicLayout = FocusClassicLayout;
