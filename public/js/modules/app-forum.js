// ═══════════════════════════════════════════════════════════
// Forum channels: topic cards, list or gallery, sort, tags, New Post.
//
// A forum channel used to render as an ordinary chat log with a reply
// button on every message. This mixin renders it the way people use
// forums: newest activity on top, a card per topic with its title, tags,
// author, reply count and first image, a toolbar to sort by recent
// activity or date posted, filter by tags (match some or all), switch
// between a list, a tile gallery, or a Twitter-style feed, and a New Post composer
// with title, body and tags. Replies still live in the topic's thread.
// ═══════════════════════════════════════════════════════════

export default {

_isForumChannel(code) {
  const ch = this.channels && this.channels.find(c => c.code === (code || this.currentChannel));
  return !!(ch && ch.is_forum && !ch.is_dm);
},

_forumTagsOf(code) {
  const ch = this.channels && this.channels.find(c => c.code === (code || this.currentChannel));
  const raw = ch && ch.forum_tags;
  if (!raw) return [];
  try { const a = typeof raw === 'string' ? JSON.parse(raw) : raw; return Array.isArray(a) ? a.filter(t => t && t.name) : []; } catch { return []; }
},

// The layout an admin set for everyone in this forum, if any (#5656).
_forumLayoutOf(code) {
  const ch = this.channels && this.channels.find(c => c.code === (code || this.currentChannel));
  const raw = ch && ch.forum_layout;
  if (!raw) return null;
  try { const l = typeof raw === 'string' ? JSON.parse(raw) : raw; return l && typeof l === 'object' ? l : null; } catch { return null; }
},

_forumPrefs(code) {
  const key = `haven_forum_prefs:${code || this.currentChannel}`;
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(key) || '{}') || {}; } catch {}
  // The channel's default layout applies unless this reader picked their
  // own after it was set; an admin setting a new default starts everyone
  // from it again (#5656).
  const def = this._forumLayoutOf(code) || {};
  const own = (Number(saved.at) || 0) >= (Number(def.at) || 0);
  return {
    sort: saved.sort === 'created' ? 'created' : 'active',
    view: this._forumParseView(own && saved.view ? saved.view : def.view),
    tile: this._forumParseTile(own && saved.tile != null ? saved.tile : def.tile),
    shape: this._forumParseShape(own && saved.shape ? saved.shape : def.shape),
    tags: Array.isArray(saved.tags) ? saved.tags : [],
    tagMode: saved.tagMode === 'all' ? 'all' : 'some',
  };
},

_forumParseView(v) { return v === 'gallery' || v === 'feed' ? v : 'list'; },
// Tile shapes for the galleries: square, or a landscape/portrait pair at
// 4:3, 3:2 and 16:9 (#5645). Shared with Files & Media.
_tileShapes() {
  return { square: '1 / 1', '4:3': '4 / 3', '3:4': '3 / 4', '3:2': '3 / 2', '2:3': '2 / 3', '16:9': '16 / 9', '9:16': '9 / 16' };
},
_forumParseShape(v) { return Object.prototype.hasOwnProperty.call(this._tileShapes(), v) ? v : 'square'; },
_tileShapeOptionsHtml(current) {
  const labels = { square: t('forum.shape_square'), '4:3': t('forum.shape_wide', { ratio: '4:3' }), '3:4': t('forum.shape_tall', { ratio: '3:4' }), '3:2': t('forum.shape_wide', { ratio: '3:2' }), '2:3': t('forum.shape_tall', { ratio: '2:3' }), '16:9': t('forum.shape_wide', { ratio: '16:9' }), '9:16': t('forum.shape_tall', { ratio: '9:16' }) };
  return Object.keys(this._tileShapes()).map(k => `<option value="${k}"${k === current ? ' selected' : ''}>${labels[k]}</option>`).join('');
},
_forumParseTile(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 11;
  return Math.min(28, Math.max(7, Math.round(n * 2) / 2));
},
_applyForumChrome(container, prefs) {
  const p = prefs || this._forumPrefs();
  const el = container || document.getElementById('messages');
  if (!el) return p;
  el.classList.toggle('forum-gallery', p.view === 'gallery');
  el.classList.toggle('forum-feed', p.view === 'feed');
  el.style.setProperty('--forum-tile', `${p.tile}rem`);
  el.style.setProperty('--forum-shape', this._tileShapes()[p.shape] || '1 / 1');
  el.dataset.forumTile = p.tile <= 9 ? 'small' : p.tile >= 20 ? 'large' : 'medium';
  document.querySelectorAll('#forum-toolbar .forum-tile-size').forEach(w => { w.hidden = p.view !== 'gallery'; });
  return p;
},
_forumAvatarHtml(msg) {
  const name = String(msg && msg.username || '?');
  const initial = this._escapeHtml(name.charAt(0).toUpperCase() || '?');
  const color = this._getUserColor ? this._getUserColor(name) : 'var(--accent)';
  const shape = msg && msg.avatar_shape ? ` avatar-${this._escapeHtml(String(msg.avatar_shape))}` : '';
  if (msg && msg.avatar) {
    return `<div class="forum-topic-avatar${shape}"><img src="${this._escapeHtml(msg.avatar)}" alt=""></div>`;
  }
  return `<div class="forum-topic-avatar${shape}" style="background:${color}">${initial}</div>`;
},
_setForumPrefs(code, patch) {
  const next = { ...this._forumPrefs(code), ...patch, at: Date.now() };
  try { localStorage.setItem(`haven_forum_prefs:${code || this.currentChannel}`, JSON.stringify(next)); } catch {}
  return next;
},

// Every get-messages for a forum carries the sort and tag filter, so the
// server pages in the order the user is looking at.
_getMessagesParams(code, extra = {}) {
  const c = code || this.currentChannel;
  if (!this._isForumChannel(c)) return { code: c, ...extra };
  const p = this._forumPrefs(c);
  return { code: c, sort: p.sort, tags: p.tags, tagMode: p.tagMode, ...extra };
},

_forumReload() {
  this.socket.emit('get-messages', this._getMessagesParams(this.currentChannel));
},

// ── Topic helpers ──────────────────────────────────────────

_forumActivityOf(msg) {
  const reply = msg.thread && msg.thread.lastReplyAt ? new Date(msg.thread.lastReplyAt).getTime() : 0;
  return Math.max(reply || 0, new Date(msg.created_at).getTime() || 0);
},

_forumTitleOf(msg) {
  if (msg.title) return msg.title;
  const lines = String(msg.content || '').split('\n').map(l => l.trim()).filter(l => l && !this._isImageUrl(l) && !/^\[file:/.test(l));
  const first = lines[0] || (this._isImageUrl(String(msg.content || '').trim()) ? t('forum.image_topic') : String(msg.content || ''));
  return first.replace(/^#+\s*/, '').replace(/^\*\*(.+)\*\*$/, '$1').slice(0, 120);
},

_forumSnippetOf(msg) {
  const lines = String(msg.content || '').split('\n').map(l => l.trim()).filter(l => l && !this._isImageUrl(l) && !/^\[file:/.test(l));
  const body = msg.title ? lines.join(' ') : lines.slice(1).join(' ');
  return body.replace(/[*_`>#]/g, '').slice(0, 220);
},

_forumThumbOf(msg) {
  const content = String(msg.content || '');
  for (const line of content.split(/\s+/)) {
    const l = line.trim();
    if (!l || l.startsWith('e2e-img:') || l.startsWith('spoiler-img:')) continue;
    if (this._isImageUrl(l)) return l;
  }
  return null;
},

_forumSortTopics(list) {
  const p = this._forumPrefs();
  const key = p.sort === 'created' ? (m) => new Date(m.created_at).getTime() || 0 : (m) => this._forumActivityOf(m);
  // Pinned first, then open topics, then closed ones (#5624), each by the chosen order.
  return [...list].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (a.closed ? 1 : 0) - (b.closed ? 1 : 0) || key(b) - key(a) || b.id - a.id);
},

// ── Rendering ──────────────────────────────────────────────

_renderForum(messages) {
  const container = document.getElementById('messages');
  if (!container) return;
  const code = this.currentChannel;
  const p = this._forumPrefs(code);
  this._forumActive = true;
  this._forumTopics = new Map();
  container.classList.add('forum-view');
  this._applyForumChrome(container, p);
  container.innerHTML = '';
  container.appendChild(this._forumToolbarEl(code));
  this._applyForumChrome(container, p);
  const grid = document.createElement('div');
  grid.className = 'forum-topics';
  grid.id = 'forum-topics';
  const topics = this._forumSortTopics((messages || []).filter(m => m && !m.thread_id && (m.type || 'user') === 'user'));
  for (const m of topics) { this._forumTopics.set(m.id, m); grid.appendChild(this._createForumTopicEl(m)); }
  container.appendChild(grid);
  if (!topics.length) {
    const hint = document.createElement('div');
    hint.className = 'forum-empty-hint';
    hint.textContent = p.tags.length ? t('forum.no_topics_for_tags') : t('app.messages.forum_empty_hint');
    container.appendChild(hint);
  }
  const more = document.createElement('button');
  more.className = 'btn-sm forum-load-more';
  more.id = 'forum-load-more';
  more.textContent = t('forum.load_more');
  more.style.display = topics.length >= 80 ? '' : 'none';
  more.addEventListener('click', () => this._forumLoadMore());
  container.appendChild(more);
  // Newest sits on top, so the list starts at the top and never auto-follows
  // the bottom the way a chat does.
  this._coupledToBottom = false;
  container.scrollTop = 0;
  const jumpBtn = document.getElementById('jump-to-bottom');
  if (jumpBtn) jumpBtn.style.display = 'none';
  this._lazyMedia && this._lazyPump && this._lazyPump();
},

_forumToolbarEl(code) {
  const p = this._forumPrefs(code);
  const bar = document.createElement('div');
  bar.className = 'forum-toolbar';
  bar.id = 'forum-toolbar';
  const tags = this._forumTagsOf(code);
  // Whoever can change the channel's settings can make the current view and
  // tile size the layout everyone opens the forum in (#5656).
  const canSetDefault = !!(this.user?.isAdmin || (this._hasPerm && this._hasPerm('manage_channel_settings')));
  const chip = (tag) => `<button type="button" class="forum-tag-chip${p.tags.includes(tag.name) ? ' active' : ''}" data-tag="${this._escapeHtml(tag.name)}">${tag.emoji ? this._escapeHtml(tag.emoji) + ' ' : ''}${this._escapeHtml(tag.name)}</button>`;
  bar.innerHTML = `
    <div class="forum-toolbar-row">
      <button type="button" class="btn-sm btn-accent forum-new-post" id="forum-new-post">✏️ ${t('forum.new_post')}</button>
      <div class="forum-sort-view">
        <select id="forum-sort" class="forum-select" title="${t('forum.sort')}">
          <option value="active"${p.sort === 'active' ? ' selected' : ''}>${t('forum.sort_active')}</option>
          <option value="created"${p.sort === 'created' ? ' selected' : ''}>${t('forum.sort_created')}</option>
        </select>
        <div class="forum-view-toggle" role="group">
          <button type="button" class="forum-view-btn${p.view === 'list' ? ' active' : ''}" data-view="list" title="${t('forum.view_list')}">☰</button>
          <button type="button" class="forum-view-btn${p.view === 'gallery' ? ' active' : ''}" data-view="gallery" title="${t('forum.view_gallery')}">▦</button>
          <button type="button" class="forum-view-btn${p.view === 'feed' ? ' active' : ''}" data-view="feed" title="${t('forum.view_feed')}">▤</button>
        </div>
        <label class="forum-tile-size"${p.view === 'gallery' ? '' : ' hidden'}>
          <span>${t('forum.tile_size')}</span>
          <input type="range" id="forum-tile-size" min="7" max="28" step="0.5" value="${p.tile}" aria-label="${t('forum.tile_size')}">
        </label>
        <label class="forum-tile-size forum-tile-shape"${p.view === 'gallery' ? '' : ' hidden'}>
          <span>${t('forum.shape')}</span>
          <select id="forum-shape" class="forum-select forum-select-small" aria-label="${t('forum.shape')}">${this._tileShapeOptionsHtml(p.shape)}</select>
        </label>
        <button type="button" class="btn-sm forum-mark-read" id="forum-mark-read" title="${t('forum.mark_all_read_title')}">${t('forum.mark_all_read')}</button>
        ${canSetDefault ? `<button type="button" class="btn-sm forum-set-default" id="forum-set-default" title="${t('forum.set_default_title')}">${t('forum.set_default')}</button>` : ''}
      </div>
    </div>
    ${tags.length ? `<div class="forum-toolbar-row forum-tags-row">
      ${tags.map(chip).join('')}
      <select id="forum-tag-mode" class="forum-select forum-select-small" title="${t('forum.tag_matching')}">
        <option value="some"${p.tagMode === 'some' ? ' selected' : ''}>${t('forum.match_some')}</option>
        <option value="all"${p.tagMode === 'all' ? ' selected' : ''}>${t('forum.match_all')}</option>
      </select>
      ${p.tags.length ? `<button type="button" class="forum-tag-clear" id="forum-tag-clear">${t('forum.clear_tags')}</button>` : ''}
    </div>` : ''}`;
  bar.querySelector('#forum-new-post').addEventListener('click', () => this._openForumComposer());
  bar.querySelector('#forum-sort').addEventListener('change', (e) => { this._setForumPrefs(code, { sort: e.target.value }); this._forumReload(); });
  bar.querySelectorAll('.forum-view-btn').forEach(b => b.addEventListener('click', () => {
    const next = this._setForumPrefs(code, { view: this._forumParseView(b.dataset.view) });
    bar.querySelectorAll('.forum-view-btn').forEach(x => x.classList.toggle('active', x === b));
    this._applyForumChrome(document.getElementById('messages'), next);
    this._lazyMedia && this._lazyPump && this._lazyPump();
  }));
  bar.querySelector('#forum-mark-read')?.addEventListener('click', () => {
    this.socket.emit('mark-forum-read', { code });
    this._forumMarkAllRead(code);
  });
  bar.querySelector('#forum-set-default')?.addEventListener('click', () => {
    const cur = this._forumPrefs(code);
    this.socket.emit('set-forum-layout', { code, view: cur.view, tile: cur.tile, shape: cur.shape }, (r) => {
      if (r?.error) return this._showToast(r.error, 'error');
      this._showToast(t('forum.default_saved'), 'success');
    });
  });
  bar.querySelector('#forum-shape')?.addEventListener('change', (e) => {
    this._applyForumChrome(document.getElementById('messages'), this._setForumPrefs(code, { shape: this._forumParseShape(e.target.value) }));
  });
  bar.querySelector('#forum-tile-size')?.addEventListener('input', (e) => {
    this._applyForumChrome(document.getElementById('messages'), this._setForumPrefs(code, { tile: this._forumParseTile(e.target.value) }));
  });
  bar.querySelectorAll('.forum-tag-chip').forEach(c => c.addEventListener('click', () => {
    const cur = this._forumPrefs(code).tags;
    const name = c.dataset.tag;
    this._setForumPrefs(code, { tags: cur.includes(name) ? cur.filter(x => x !== name) : [...cur, name] });
    this._forumReload();
  }));
  bar.querySelector('#forum-tag-mode')?.addEventListener('change', (e) => { this._setForumPrefs(code, { tagMode: e.target.value }); this._forumReload(); });
  bar.querySelector('#forum-tag-clear')?.addEventListener('click', () => { this._setForumPrefs(code, { tags: [] }); this._forumReload(); });
  return bar;
},

_createForumTopicEl(msg) {
  const el = document.createElement('div');
  const unread = !!(msg.thread && msg.thread.unread);
  el.className = 'forum-topic' + (msg.pinned ? ' forum-topic-pinned' : '') + (msg.closed ? ' forum-topic-closed' : '') + (unread ? ' forum-topic-unread' : '');
  el.dataset.msgId = msg.id;
  el.dataset.userId = msg.user_id;
  el.dataset.time = msg.created_at;
  el.dataset.username = msg.username || '';
  // Protected topics carry the same flag and shield as a message in chat, so
  // the card shows it and the context menu offers Unprotect (#5622).
  if (msg.is_archived) { el.classList.add('archived'); el.dataset.archived = '1'; }
  const tagsOf = this._forumTagsOf();
  const tags = Array.isArray(msg.tags) ? msg.tags : [];
  const thumb = this._forumThumbOf(msg);
  const count = msg.thread && msg.thread.count ? msg.thread.count : 0;
  const when = this._forumPrefs().sort === 'created' ? new Date(msg.created_at) : new Date(this._forumActivityOf(msg));
  const canEdit = this.user && (msg.user_id === this.user.id || this.user.isAdmin || (this._hasPerm && this._hasPerm('manage_messages')));
  el.innerHTML = `
    ${this._forumAvatarHtml(msg)}
    ${thumb ? `<div class="forum-topic-thumb"><img ${this._lazySrcAttr ? this._lazySrcAttr(`src="${this._escapeHtml(thumb)}"`) : `src="${this._escapeHtml(thumb)}"`} class="chat-image forum-thumb-img" alt=""></div>` : `<div class="forum-topic-thumb forum-topic-thumb-empty"><span>⬡</span></div>`}
    <div class="forum-topic-body">
      <div class="forum-topic-tags">${msg.is_archived ? `<span class="forum-tag forum-tag-protected archived-tag" title="${this._escapeHtml(t('app.messages.protected'))}">🛡️</span>` : ''}${msg.closed ? `<span class="forum-tag forum-tag-closed">✔ ${t('forum.closed')}</span>` : ''}${msg.pinned ? `<span class="forum-tag forum-tag-pinned">📌 ${t('forum.pinned')}</span>` : ''}${tags.map(name => { const tg = tagsOf.find(x => x.name === name); return `<span class="forum-tag">${tg && tg.emoji ? this._escapeHtml(tg.emoji) + ' ' : ''}${this._escapeHtml(name)}</span>`; }).join('')}</div>
      <div class="forum-topic-title">${unread ? `<span class="forum-unread-dot" title="${t('forum.unread')}"></span>` : ''}${this._escapeHtml(this._forumTitleOf(msg))}</div>
      <div class="forum-topic-snippet message-content">${this._escapeHtml(this._forumSnippetOf(msg))}</div>
      <div class="forum-topic-meta">
        <span class="message-author forum-topic-author">${this._escapeHtml(msg.username || '')}</span>
        <span class="forum-topic-replies" data-thread-parent="${msg.id}">${count ? `💬 ${t('forum.replies', { count })}` : t('thread_runtime.reply_to_topic')}</span>
        <span class="forum-topic-when" title="${when.toLocaleString()}">${this._forumAgo(when)}</span>
        ${canEdit ? `<button type="button" class="forum-topic-edit" title="${t('forum.edit_post')}">✎</button>` : ''}
      </div>
    </div>`;
  el.addEventListener('click', (e) => {
    if (e.target.closest('.forum-topic-edit')) { e.stopPropagation(); this._forumEditTopicMeta(msg.id); return; }
    if (e.target.closest('a')) return;
    this._openThread(msg.id);
  });
  // The thumbnail is part of the card: a click opens the topic, and a
  // right-click on it gets the image menu with a View entry, so the picture
  // is a step away without the lightbox and the topic opening at once
  // (#5646). Anywhere else on the card gets the forum's own menu (#5650).
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const img = e.target.closest('img.forum-thumb-img');
    if (img && this._showImageContextMenu) {
      this._lightboxContainer = document.getElementById('messages');
      this._showImageContextMenu(e, this._lazyRealSrc ? this._lazyRealSrc(img) : img.src, { viewImage: img });
      return;
    }
    this._showForumTopicContextMenu(e, msg);
  });
  return el;
},

// Right-click on a topic card. The chat menu's Edit, React and Thread do
// not fit a card: Edit stacked a second copy of the text on it, React opened
// the picker under the composer, and Thread is what a click already does. A
// forum gets its own list (#5650).
_showForumTopicContextMenu(e, msg) {
  this._hideMessageContextMenu?.();
  const msgId = msg.id;
  const isOwn = !!(this.user && msg.user_id === this.user.id);
  const canEdit = !!(this.user && (isOwn || this.user.isAdmin || (this._hasPerm && this._hasPerm('manage_messages'))));
  const canPin = !!(this.user?.isAdmin || this._hasPerm('pin_message'));
  const canArchive = !!(this.user?.isAdmin || this._hasPerm('archive_messages'));
  const canShareLink = !!this._canShareChannelLink?.(this.currentChannel);
  const canDelete = !!(isOwn || this.user?.isAdmin || this._canModerate?.() || this._hasPerm('delete_message'));
  const item = (action, icon, label, cls = '') => `<button class="channel-ctx-item${cls}" data-action="${action}">${icon} <span>${label}</span></button>`;
  const items = [item('open', '🗂️', t('forum.open_topic'))];
  if (canEdit) items.push(item('edit', '✏️', t('forum.edit_post')));
  if (canPin) items.push(msg.pinned ? item('unpin', '📌', t('msg_toolbar.unpin')) : item('pin', '📌', t('msg_toolbar.pin')));
  if (canEdit) items.push(msg.closed ? item('reopen', '🔓', t('forum.reopen_topic')) : item('close', '✔', t('forum.close_topic')));
  const more = [];
  if (canShareLink) more.push(item('copy-link', '🔗', t('msg_toolbar.copy_link')));
  if (canArchive) more.push(msg.is_archived ? item('unarchive', '🛡️', t('app.messages.unprotect_btn')) : item('archive', '🛡️', t('app.messages.protect_btn')));
  if (more.length) items.push('<hr class="channel-ctx-sep">', ...more);
  if (canDelete) items.push('<hr class="channel-ctx-sep">', item('delete', '🗑️', t('msg_toolbar.delete'), ' danger'));

  const menu = document.createElement('div');
  menu.id = 'message-context-menu';
  menu.className = 'channel-ctx-menu';
  menu.innerHTML = items.join('');
  menu.style.left = e.clientX + 'px';
  menu.style.top = e.clientY + 'px';
  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = (window.innerWidth - rect.width - 8) + 'px';
  if (rect.bottom > window.innerHeight) menu.style.top = (window.innerHeight - rect.height - 8) + 'px';

  menu.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    this._hideMessageContextMenu();
    if (action === 'open') {
      this._openThread(msgId);
    } else if (action === 'edit') {
      this._forumEditTopicMeta(msgId);
    } else if (action === 'pin') {
      if (await this._showConfirmModal(t('confirm.pin_message'), '')) this.socket.emit('pin-message', { messageId: msgId });
    } else if (action === 'unpin') {
      this.socket.emit('unpin-message', { messageId: msgId });
    } else if (action === 'close' || action === 'reopen') {
      this.socket.emit('set-topic-meta', { messageId: msgId, title: msg.title || '', tags: Array.isArray(msg.tags) ? msg.tags : [], closed: action === 'close' });
    } else if (action === 'copy-link') {
      this._copyChannelLink(this.currentChannel, msgId);
    } else if (action === 'archive') {
      this.socket.emit('archive-message', { messageId: msgId });
    } else if (action === 'unarchive') {
      this.socket.emit('unarchive-message', { messageId: msgId });
    } else if (action === 'delete') {
      if (await this._showConfirmModal(t('confirm.delete_message'), '', { danger: true, confirmLabel: t('msg_toolbar.delete') })) {
        this.socket.emit('delete-message', { messageId: msgId, attachments: this._getMessageAttachments?.(msgId) });
      }
    }
  });

  // Same self-closing lifecycle as the chat menu, through the same hook.
  const closer = (ev) => {
    if (ev && ev.type !== 'scroll' && menu.contains(ev.target)) return;
    this._hideMessageContextMenu();
  };
  this._msgCtxCloser = closer;
  setTimeout(() => {
    document.addEventListener('click', closer, true);
    document.addEventListener('contextmenu', closer, true);
    document.getElementById('messages')?.addEventListener('scroll', closer, true);
  }, 0);
},

// The body of a topic changed, from the composer or the ordinary edit path:
// rebuild its card so the title, snippet and thumbnail follow. Returns true
// when the topic is on screen.
_forumApplyContentEdit(messageId, content) {
  const topic = this._forumTopics && this._forumTopics.get(messageId);
  if (!topic) return false;
  topic.content = content;
  topic.edited_at = new Date().toISOString();
  const el = document.querySelector(`#forum-topics [data-msg-id="${messageId}"]`);
  if (el) el.replaceWith(this._createForumTopicEl(topic));
  this._lazyMedia && this._lazyPump && this._lazyPump();
  return true;
},

_forumAgo(date) {
  const s = Math.max(0, (Date.now() - date.getTime()) / 1000);
  if (s < 60) return t('forum.just_now');
  if (s < 3600) return t('forum.minutes_ago', { n: Math.floor(s / 60) });
  if (s < 86400) return t('forum.hours_ago', { n: Math.floor(s / 3600) });
  if (s < 86400 * 30) return t('forum.days_ago', { n: Math.floor(s / 86400) });
  return date.toLocaleDateString();
},

// A new top-level message in a forum is a new topic: it goes on top.
_forumInsertTopic(msg) {
  const grid = document.getElementById('forum-topics');
  if (!grid || !msg || msg.thread_id) return;
  const p = this._forumPrefs();
  if (p.tags.length) {
    const has = Array.isArray(msg.tags) ? msg.tags : [];
    const ok = p.tagMode === 'all' ? p.tags.every(x => has.includes(x)) : p.tags.some(x => has.includes(x));
    if (!ok) return;
  }
  this._forumTopics && this._forumTopics.set(msg.id, msg);
  grid.querySelector(`[data-msg-id="${msg.id}"]`)?.remove();
  const el = this._createForumTopicEl(msg);
  const firstUnpinned = [...grid.children].find(c => !c.classList.contains('forum-topic-pinned'));
  grid.insertBefore(el, firstUnpinned || null);
  document.querySelector('#messages .forum-empty-hint')?.remove();
  this._lazyMedia && this._lazyPump && this._lazyPump();
},

// A reply landed: refresh the count and, in activity order, move the topic up.
_forumBump(parentId, thread) {
  const grid = document.getElementById('forum-topics');
  if (!grid) return;
  const el = grid.querySelector(`[data-msg-id="${parentId}"]`);
  const topic = this._forumTopics && this._forumTopics.get(parentId);
  if (!el || !topic) { this._forumReload(); return; }
  // A reply from someone else lights the card up unless that thread is the
  // one open on screen; your own reply never does (#5641).
  const mine = thread && this.user && thread.senderId === this.user.id;
  const watching = this._activeThreadParent === parentId && document.getElementById('thread-panel')?.style.display !== 'none';
  const unread = thread ? (!mine && !watching) : !!(topic.thread && topic.thread.unread);
  // Seen live in the open panel: tell the server so it stays read after a reload.
  if (thread && watching && !mine) this.socket.emit('mark-thread-read', { parentId });
  if (thread) topic.thread = { ...thread, unread };
  else topic.thread = { ...(topic.thread || {}), count: ((topic.thread && topic.thread.count) || 0) + 1, lastReplyAt: new Date().toISOString(), unread };
  const fresh = this._createForumTopicEl(topic);
  el.replaceWith(fresh);
  if (this._forumPrefs().sort === 'active' && !topic.pinned && !topic.closed) {
    const firstUnpinned = [...grid.children].find(c => !c.classList.contains('forum-topic-pinned'));
    if (firstUnpinned && firstUnpinned !== fresh) grid.insertBefore(fresh, firstUnpinned);
  }
  this._lazyMedia && this._lazyPump && this._lazyPump();
},

// Unread dots follow the account: opening a topic here, or on another
// device, and Mark all read both clear them (#5641).
_forumMarkTopicRead(parentId) {
  const topic = this._forumTopics && this._forumTopics.get(parentId);
  if (!topic || !topic.thread || !topic.thread.unread) return;
  topic.thread.unread = false;
  const el = document.querySelector(`#forum-topics [data-msg-id="${parentId}"]`);
  if (el) el.replaceWith(this._createForumTopicEl(topic));
  this._lazyMedia && this._lazyPump && this._lazyPump();
},

_forumMarkAllRead(code) {
  if (code && code !== this.currentChannel) return;
  if (!this._forumActive || !this._forumTopics) return;
  for (const [id, topic] of this._forumTopics) {
    if (topic.thread && topic.thread.unread) this._forumMarkTopicRead(id);
  }
},

_forumApplyTopicUpdate(data) {
  const topic = this._forumTopics && this._forumTopics.get(data.messageId);
  if (!topic) return;
  topic.title = data.title || null;
  topic.tags = Array.isArray(data.tags) ? data.tags : [];
  const wasClosed = !!topic.closed;
  if (typeof data.closed === 'boolean') topic.closed = data.closed;
  // Closing or reopening moves the card between the open and closed groups,
  // so the list is rebuilt rather than the card swapped in place (#5624).
  if (!!topic.closed !== wasClosed) { this._forumReload(); return; }
  const el = document.querySelector(`#forum-topics [data-msg-id="${data.messageId}"]`);
  if (el) el.replaceWith(this._createForumTopicEl(topic));
},

_forumLoadMore() {
  const grid = document.getElementById('forum-topics');
  const last = grid && grid.lastElementChild;
  if (!last || this._forumLoadingMore) return;
  this._forumLoadingMore = true;
  const btn = document.getElementById('forum-load-more');
  if (btn) btn.disabled = true;
  this.socket.emit('get-messages', this._getMessagesParams(this.currentChannel, { before: parseInt(last.dataset.msgId, 10) }));
},

_forumAppendOlder(messages) {
  const grid = document.getElementById('forum-topics');
  const btn = document.getElementById('forum-load-more');
  if (btn) btn.disabled = false;
  if (!grid) return;
  const list = (messages || []).filter(m => m && !m.thread_id);
  // The server hands older pages newest-first for chronological chat and the
  // client reverses them; a forum page arrives already in display order.
  for (const m of list) {
    if (grid.querySelector(`[data-msg-id="${m.id}"]`)) continue;
    this._forumTopics && this._forumTopics.set(m.id, m);
    grid.appendChild(this._createForumTopicEl(m));
  }
  if (btn && list.length < 80) btn.style.display = 'none';
  this._lazyMedia && this._lazyPump && this._lazyPump();
},

// ── New Post composer ──────────────────────────────────────

_openForumComposer(existing = null) {
  const code = this.currentChannel;
  const tags = this._forumTagsOf(code);
  const picked = new Set(existing && Array.isArray(existing.tags) ? existing.tags : []);
  // The author can rewrite the body from here too; it goes through the
  // ordinary edit path, so it gets the same checks as any message (#5650).
  const canEditBody = !!(existing && this.user && existing.user_id === this.user.id);
  const maxChars = parseInt(this.serverSettings?.max_message_chars) || 2000;
  const bodyField = !existing
    ? `<label class="forum-field"><span>${t('forum.body')}</span><textarea id="forum-post-body" rows="6" placeholder="${t('forum.body_placeholder')}"></textarea></label>`
    : (canEditBody ? `<label class="forum-field"><span>${t('forum.body')}</span><textarea id="forum-post-body" rows="6" maxlength="${maxChars}">${this._escapeHtml(existing.content || '')}</textarea></label>` : '');
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'forum-post-modal';
  overlay.innerHTML = `
    <div class="modal forum-post-modal">
      <div class="modal-header forum-modal-header"><h3>${existing ? t('forum.edit_post') : t('forum.new_post')}</h3><button class="modal-close" type="button">&times;</button></div>
      <div class="modal-body">
        <label class="forum-field"><span>${t('forum.title')}</span><input type="text" id="forum-post-title" maxlength="120" placeholder="${t('forum.title_placeholder')}" value="${existing ? this._escapeHtml(existing.title || '') : ''}"></label>
        ${bodyField}
        ${tags.length ? `<div class="forum-field"><span>${t('forum.tags')} <small>${t('forum.tags_hint')}</small></span><div class="forum-tag-picker">${tags.map(tg => `<button type="button" class="forum-tag-chip${picked.has(tg.name) ? ' active' : ''}" data-tag="${this._escapeHtml(tg.name)}">${tg.emoji ? this._escapeHtml(tg.emoji) + ' ' : ''}${this._escapeHtml(tg.name)}</button>`).join('')}</div></div>` : ''}
        ${existing ? `<label class="forum-field forum-field-closed"><span><input type="checkbox" id="forum-post-closed"${existing.closed ? ' checked' : ''}> ${t('forum.mark_closed')}</span></label>` : `<small class="settings-hint">${t('forum.attach_hint')}</small>`}
      </div>
      <div class="modal-footer"><button type="button" class="btn-sm" id="forum-post-cancel">${t('modals.common.cancel')}</button><button type="button" class="btn-sm btn-accent" id="forum-post-go">${existing ? t('modals.common.save') : t('forum.post')}</button></div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector('.modal-close').addEventListener('click', close);
  overlay.querySelector('#forum-post-cancel').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelectorAll('.forum-tag-chip').forEach(c => c.addEventListener('click', () => {
    const name = c.dataset.tag;
    if (picked.has(name)) picked.delete(name); else if (picked.size < 5) picked.add(name);
    c.classList.toggle('active', picked.has(name));
  }));
  const titleEl = overlay.querySelector('#forum-post-title');
  titleEl.focus();
  overlay.querySelector('#forum-post-go').addEventListener('click', () => {
    const title = titleEl.value.trim();
    if (existing) {
      const closedBox = overlay.querySelector('#forum-post-closed');
      this.socket.emit('set-topic-meta', { messageId: existing.id, title, tags: [...picked], closed: closedBox ? closedBox.checked : undefined });
      const bodyEl = overlay.querySelector('#forum-post-body');
      if (bodyEl) {
        const body = bodyEl.value.trim();
        if (body && body !== String(existing.content || '').trim()) {
          this.socket.emit('edit-message', { messageId: existing.id, content: body, channelCode: code });
        }
      }
      close();
      return;
    }
    const body = overlay.querySelector('#forum-post-body').value.trim();
    if (!title && !body) { titleEl.focus(); return; }
    this.socket.emit('send-message', { code, content: body || title, title: title || undefined, tags: [...picked] });
    this.notifications && this.notifications.play && this.notifications.play('sent');
    close();
  });
},

_forumEditTopicMeta(messageId) {
  const topic = this._forumTopics && this._forumTopics.get(messageId);
  if (topic) this._openForumComposer(topic);
},

// Admins keep the tag list in Channel Functions: one tag per line, an
// emoji first if you want one ("🎨 Art").
async _forumEditTags(code) {
  const current = this._forumTagsOf(code).map(tg => (tg.emoji ? `${tg.emoji} ${tg.name}` : tg.name)).join('\n');
  const raw = await this._showPromptModal(t('forum.tags_editor_title'), t('forum.tags_editor_hint'), current);
  if (raw == null) return;
  const tags = String(raw).split(/\r?\n|,/).map(s => s.trim()).filter(Boolean).map(s => {
    const m = /^(\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*)\s+(.+)$/u.exec(s);
    return m ? { emoji: m[1], name: m[2].trim() } : { name: s };
  });
  this.socket.emit('set-forum-tags', { code, tags });
},

// ── Settings search (Ctrl+F inside Settings) ───────────────

_setupSettingsSearch() {
  const nav = document.getElementById('settings-nav');
  const modal = document.getElementById('settings-modal');
  if (!nav || !modal || document.getElementById('settings-search')) return;
  const wrap = document.createElement('div');
  wrap.className = 'settings-search-wrap';
  wrap.innerHTML = `<input type="search" id="settings-search" class="settings-search" placeholder="${t('settings.search_placeholder')}" autocomplete="off">`;
  nav.insertBefore(wrap, nav.firstChild);
  const input = wrap.querySelector('input');
  const apply = () => {
    const q = input.value.trim().toLowerCase();
    const sections = modal.querySelectorAll('.settings-section');
    sections.forEach(sec => {
      const hit = !q || sec.textContent.toLowerCase().includes(q);
      sec.classList.toggle('settings-search-hidden', !hit);
      const navItem = sec.id ? nav.querySelector(`.settings-nav-item[data-target="${sec.id}"]`) : null;
      if (navItem) navItem.classList.toggle('settings-search-hidden', !hit);
    });
    nav.querySelectorAll('.settings-nav-group-label').forEach(label => {
      let sib = label.nextElementSibling, any = false;
      while (sib && !sib.classList.contains('settings-nav-group-label')) { if (sib.classList.contains('settings-nav-item') && !sib.classList.contains('settings-search-hidden')) any = true; sib = sib.nextElementSibling; }
      label.classList.toggle('settings-search-hidden', !any && !!q);
    });
  };
  input.addEventListener('input', apply);
  modal.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); input.focus(); input.select(); }
    if (e.key === 'Escape' && document.activeElement === input && input.value) { e.stopPropagation(); input.value = ''; apply(); }
  });
},

// ── NSFW channels ──────────────────────────────────────────

_hideNsfw() {
  return localStorage.getItem('haven_hide_nsfw') === 'true';
},

_setHideNsfw(v) {
  const val = v ? 'true' : 'false';
  try { localStorage.setItem('haven_hide_nsfw', val); } catch {}
  if (this._userPrefs) this._userPrefs.hide_nsfw = val;
  this.socket?.emit('set-preference', { key: 'hide_nsfw', value: val });
  const toggle = document.getElementById('hide-nsfw-channels');
  if (toggle) toggle.checked = !!v;
  if (this._renderChannels) this._renderChannels();
},

};
