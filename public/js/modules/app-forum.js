// ═══════════════════════════════════════════════════════════
// Forum channels: topic cards, list or gallery, sort, tags, New Post.
//
// A forum channel used to render as an ordinary chat log with a reply
// button on every message. This mixin renders it the way people use
// forums: newest activity on top, a card per topic with its title, tags,
// author, reply count and first image, a toolbar to sort by recent
// activity or date posted, filter by tags (match some or all), switch
// between a list and a gallery of square tiles, and a New Post composer
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

_forumPrefs(code) {
  const key = `haven_forum_prefs:${code || this.currentChannel}`;
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(key) || '{}') || {}; } catch {}
  return { sort: saved.sort === 'created' ? 'created' : 'active', view: saved.view === 'gallery' ? 'gallery' : 'list', tags: Array.isArray(saved.tags) ? saved.tags : [], tagMode: saved.tagMode === 'all' ? 'all' : 'some' };
},

_setForumPrefs(code, patch) {
  const next = { ...this._forumPrefs(code), ...patch };
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
  return [...list].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || key(b) - key(a) || b.id - a.id);
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
  container.classList.toggle('forum-gallery', p.view === 'gallery');
  container.innerHTML = '';
  container.appendChild(this._forumToolbarEl(code));
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
        </div>
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
    this._setForumPrefs(code, { view: b.dataset.view });
    bar.querySelectorAll('.forum-view-btn').forEach(x => x.classList.toggle('active', x === b));
    document.getElementById('messages')?.classList.toggle('forum-gallery', b.dataset.view === 'gallery');
    this._lazyMedia && this._lazyPump && this._lazyPump();
  }));
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
  el.className = 'forum-topic' + (msg.pinned ? ' forum-topic-pinned' : '');
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
    ${thumb ? `<div class="forum-topic-thumb"><img ${this._lazySrcAttr ? this._lazySrcAttr(`src="${this._escapeHtml(thumb)}"`) : `src="${this._escapeHtml(thumb)}"`} class="chat-image forum-thumb-img" alt=""></div>` : `<div class="forum-topic-thumb forum-topic-thumb-empty"><span>⬡</span></div>`}
    <div class="forum-topic-body">
      <div class="forum-topic-tags">${msg.is_archived ? `<span class="forum-tag forum-tag-protected archived-tag" title="${this._escapeHtml(t('app.messages.protected'))}">🛡️</span>` : ''}${msg.pinned ? `<span class="forum-tag forum-tag-pinned">📌 ${t('forum.pinned')}</span>` : ''}${tags.map(name => { const tg = tagsOf.find(x => x.name === name); return `<span class="forum-tag">${tg && tg.emoji ? this._escapeHtml(tg.emoji) + ' ' : ''}${this._escapeHtml(name)}</span>`; }).join('')}</div>
      <div class="forum-topic-title">${this._escapeHtml(this._forumTitleOf(msg))}</div>
      <div class="forum-topic-snippet message-content">${this._escapeHtml(this._forumSnippetOf(msg))}</div>
      <div class="forum-topic-meta">
        <span class="message-author forum-topic-author">${this._escapeHtml(msg.username || '')}</span>
        <span class="forum-topic-replies" data-thread-parent="${msg.id}">${count ? `💬 ${t('forum.replies', { count })}` : t('thread_runtime.reply_to_topic')}</span>
        <span class="forum-topic-when" title="${when.toLocaleString()}">${this._forumAgo(when)}</span>
        ${canEdit ? `<button type="button" class="forum-topic-edit" title="${t('forum.edit_topic')}">✎</button>` : ''}
      </div>
    </div>`;
  el.addEventListener('click', (e) => {
    if (e.target.closest('.forum-topic-edit')) { e.stopPropagation(); this._forumEditTopicMeta(msg.id); return; }
    if (e.target.closest('a')) return;
    this._openThread(msg.id);
  });
  el.addEventListener('contextmenu', (e) => { if (this._showMessageContextMenu) { e.preventDefault(); this._showMessageContextMenu(e, el); } });
  return el;
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
  if (thread) topic.thread = thread;
  else topic.thread = { ...(topic.thread || {}), count: ((topic.thread && topic.thread.count) || 0) + 1, lastReplyAt: new Date().toISOString() };
  const fresh = this._createForumTopicEl(topic);
  el.replaceWith(fresh);
  if (this._forumPrefs().sort === 'active' && !topic.pinned) {
    const firstUnpinned = [...grid.children].find(c => !c.classList.contains('forum-topic-pinned'));
    if (firstUnpinned && firstUnpinned !== fresh) grid.insertBefore(fresh, firstUnpinned);
  }
  this._lazyMedia && this._lazyPump && this._lazyPump();
},

_forumApplyTopicUpdate(data) {
  const topic = this._forumTopics && this._forumTopics.get(data.messageId);
  if (!topic) return;
  topic.title = data.title || null;
  topic.tags = Array.isArray(data.tags) ? data.tags : [];
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
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'forum-post-modal';
  overlay.innerHTML = `
    <div class="modal forum-post-modal">
      <div class="modal-header"><h3>${existing ? t('forum.edit_topic') : t('forum.new_post')}</h3><button class="modal-close" type="button">&times;</button></div>
      <div class="modal-body">
        <label class="forum-field"><span>${t('forum.title')}</span><input type="text" id="forum-post-title" maxlength="120" placeholder="${t('forum.title_placeholder')}" value="${existing ? this._escapeHtml(existing.title || '') : ''}"></label>
        ${existing ? '' : `<label class="forum-field"><span>${t('forum.body')}</span><textarea id="forum-post-body" rows="6" placeholder="${t('forum.body_placeholder')}"></textarea></label>`}
        ${tags.length ? `<div class="forum-field"><span>${t('forum.tags')} <small>${t('forum.tags_hint')}</small></span><div class="forum-tag-picker">${tags.map(tg => `<button type="button" class="forum-tag-chip${picked.has(tg.name) ? ' active' : ''}" data-tag="${this._escapeHtml(tg.name)}">${tg.emoji ? this._escapeHtml(tg.emoji) + ' ' : ''}${this._escapeHtml(tg.name)}</button>`).join('')}</div></div>` : ''}
        ${existing ? '' : `<small class="settings-hint">${t('forum.attach_hint')}</small>`}
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
      this.socket.emit('set-topic-meta', { messageId: existing.id, title, tags: [...picked] });
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
