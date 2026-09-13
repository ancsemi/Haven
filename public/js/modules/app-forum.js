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

_forumPrefs(code) {
  const key = `haven_forum_prefs:${code || this.currentChannel}`;
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(key) || '{}') || {}; } catch {}
  return {
    sort: saved.sort === 'created' ? 'created' : 'active',
    view: this._forumParseView(saved.view),
    tile: this._forumParseTile(saved.tile),
    tags: Array.isArray(saved.tags) ? saved.tags : [],
    tagMode: saved.tagMode === 'all' ? 'all' : 'some',
    requestStatus: this._forumParseStatus(saved.requestStatus) || '',
    topicKind: this._forumParseKind(saved.topicKind) || '',
  };
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
  return { code: c, sort: p.sort, tags: p.tags, tagMode: p.tagMode, requestStatus: p.requestStatus || undefined, topicKind: p.topicKind || undefined, ...extra };
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
  let text = String(msg.content || '');
  for (const u of (this._pullImageUrls ? this._pullImageUrls(text) : [])) text = text.split(u).join(' ');
  const lines = text.split('\n').map(l => l.trim()).filter(l => l && !this._isImageUrl?.(l) && !/^\[file:/.test(l));
  const body = msg.title ? lines.join(' ') : lines.slice(1).join(' ');
  return body.replace(/[*_`>#]/g, '').replace(/\s+/g, ' ').slice(0, 220);
},

_forumThumbOf(msg) {
  const found = this._pullImageUrls ? this._pullImageUrls(msg.content) : [];
  if (found.length) return found[0];
  const content = String(msg.content || '');
  for (const line of content.split(/\s+/)) {
    const l = line.trim();
    if (!l || l.startsWith('e2e-img:') || l.startsWith('spoiler-img:')) continue;
    if (this._isImageUrl(l)) return l;
  }
  return null;
},

// Thread replies arrive after the list card is gone, and get-thread-messages
// used to write parentContent as textContent — so a photo topic became a URL.
_paintForumParentPreview(content) {
  const previewEl = document.getElementById('thread-parent-preview');
  if (!previewEl) return;
  previewEl.innerHTML = this._formatContent ? this._formatContent(String(content || '')) : this._escapeHtml(String(content || ''));
  this._flushPendingMedia && this._flushPendingMedia();
  this._lazyMedia && this._lazyPump && this._lazyPump();
},

_forumTypeCatalog() {
  return [
    { id: 'request', group: 'board', status: true, subtasks: true, tags: ['priority', 'mobile', 'desktop', 'api', 'ui'] },
    { id: 'report', group: 'board', status: true, subtasks: true, tags: ['urgent', 'security', 'repro', 'regression'] },
    { id: 'bug', group: 'board', status: true, subtasks: true, tags: ['repro', 'regression', 'crash', 'ui', 'mobile'] },
    { id: 'feature', group: 'board', status: true, subtasks: true, tags: ['ux', 'api', 'mobile', 'desktop'] },
    { id: 'chore', group: 'board', status: true, subtasks: true, tags: ['cleanup', 'deps', 'perf', 'refactor'] },
    { id: 'idea', group: 'board', status: true, subtasks: false, tags: ['brainstorm', 'later', 'research'] },
    { id: 'docs', group: 'board', status: true, subtasks: true, tags: ['howto', 'api', 'changelog'] },
    { id: 'showcase', group: 'social', status: false, subtasks: false, tags: ['wip', 'finished', 'feedback'] },
    { id: 'hobby', group: 'social', status: false, subtasks: false, tags: ['photo', 'music', 'game', 'craft'] },
    { id: 'chat', group: 'social', status: false, subtasks: false, tags: ['off-topic', 'help', 'intro'] },
    { id: 'discussion', group: 'social', status: false, subtasks: false, tags: ['question', 'opinion', 'news'] },
    { id: 'announcement', group: 'meta', status: false, subtasks: false, tags: ['update', 'event', 'rules'] },
  ];
},
_forumKinds() { return this._forumTypeCatalog().map((x) => x.id); },
_forumTypeOf(id) { return this._forumTypeCatalog().find((x) => x.id === id) || this._forumTypeCatalog()[0]; },
_forumTypeGroups() {
  return [
    { id: 'board', kinds: ['request', 'report', 'bug', 'feature', 'chore', 'idea', 'docs'] },
    { id: 'social', kinds: ['showcase', 'hobby', 'chat', 'discussion'] },
    { id: 'meta', kinds: ['announcement'] },
  ];
},
_forumParseView(v) { return v === 'gallery' || v === 'feed' ? v : 'list'; },
_forumParseTile(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 13;
  return Math.min(28, Math.max(7, Math.round(n * 2) / 2));
},
_applyForumChrome(container, prefs) {
  const p = prefs || this._forumPrefs();
  const el = container || document.getElementById('messages');
  if (!el) return p;
  el.classList.toggle('forum-gallery', p.view === 'gallery');
  el.classList.toggle('forum-feed', p.view === 'feed');
  el.style.setProperty('--forum-tile', `${p.tile}rem`);
  el.dataset.forumTile = p.tile <= 9 ? 'small' : p.tile >= 20 ? 'large' : 'medium';
  const sliderWrap = document.querySelector('#forum-toolbar .forum-tile-size');
  if (sliderWrap) sliderWrap.hidden = p.view !== 'gallery';
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
_forumStatuses() { return ['planned', 'in_progress', 'blocked', 'review', 'complete']; },
_forumParseKind(v) { return this._forumKinds().includes(v) ? v : ''; },
_forumParseStatus(v) { return this._forumStatuses().includes(v) ? v : ''; },
_forumKindLabel(kind) { return kind ? t(`forum.kind_${kind}`) : t('forum.kind_all'); },
_forumStatusLabel(status) { return status ? t(`forum.status_${status}`) : t('forum.status_all'); },
_forumKindGlyph(kind) {
  return { request: '📋', report: '🚩', feature: '✨', bug: '🐛', chore: '🔧', docs: '📄', idea: '💡', showcase: '🖼️', hobby: '🎯', chat: '💬', discussion: '💭', announcement: '📣' }[kind] || '';
},
_forumKindOptions(selected, includeAll) {
  const groups = this._forumTypeGroups().map((g) => {
    const opts = g.kinds.map((k) => `<option value="${k}"${selected === k ? ' selected' : ''}>${this._forumKindGlyph(k)} ${this._forumKindLabel(k)}</option>`).join('');
    return `<optgroup label="${t(`forum.group_${g.id}`)}">${opts}</optgroup>`;
  }).join('');
  return (includeAll ? `<option value="">${t('forum.kind_all')}</option>` : '') + groups;
},
_forumParseSubtasks(raw) {
  let arr = raw;
  if (typeof raw === 'string') { try { arr = JSON.parse(raw); } catch { return []; } }
  if (!Array.isArray(arr)) return [];
  return arr.map((item, i) => {
    if (typeof item === 'string') return { id: `s${i}`, title: item.trim().slice(0, 140), done: false };
    if (!item || typeof item !== 'object') return null;
    const title = String(item.title || '').trim().slice(0, 140);
    if (!title) return null;
    return { id: String(item.id || `s${i}`).slice(0, 16), title, done: !!item.done };
  }).filter(Boolean).slice(0, 40);
},

_paintForumSubtasks(topic) {
  const preview = document.getElementById('thread-parent-preview');
  let box = document.getElementById('forum-subtasks');
  if (!box && preview) {
    box = document.createElement('div');
    box.id = 'forum-subtasks';
    box.className = 'forum-subtasks';
    preview.after(box);
  }
  if (!box) return;
  if (!this._isForumFeed?.() || !topic) { box.hidden = true; box.innerHTML = ''; return; }
  const items = this._forumParseSubtasks(topic.subtasks);
  const canEdit = this.user && (topic.user_id === this.user.id || this.user.isAdmin || (this._hasPerm && this._hasPerm('manage_messages')));
  const done = items.filter((x) => x.done).length;
  box.hidden = false;
  box.innerHTML = `
    <div class="forum-subtasks-hdr">${t('forum.subtasks')}${items.length ? ` · ${t('forum.subtasks_progress', { done, total: items.length })}` : ''}</div>
    <ul class="forum-subtask-list">${items.map((item) => `
      <li class="forum-subtask${item.done ? ' done' : ''}">
        <label><input type="checkbox" data-subtask-id="${this._escapeHtml(item.id)}"${item.done ? ' checked' : ''}${canEdit ? '' : ' disabled'}> <span>${this._escapeHtml(item.title)}</span></label>
        ${canEdit ? `<button type="button" class="forum-subtask-del" data-subtask-id="${this._escapeHtml(item.id)}" title="${t('forum.subtask_remove')}">✕</button>` : ''}
      </li>`).join('')}</ul>
    ${canEdit ? `<form class="forum-subtask-add"><input type="text" maxlength="140" placeholder="${t('forum.subtask_placeholder')}"><button type="submit">${t('forum.subtask_add')}</button></form>` : ''}`;
  box.querySelectorAll('input[type="checkbox"][data-subtask-id]').forEach((cb) => {
    cb.addEventListener('click', (e) => e.stopPropagation());
    cb.addEventListener('change', () => {
      const next = this._forumParseSubtasks(topic.subtasks).map((item) => item.id === cb.dataset.subtaskId ? { ...item, done: cb.checked } : item);
      this._forumSaveSubtasks(topic, next);
    });
  });
  box.querySelectorAll('.forum-subtask-del').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._forumSaveSubtasks(topic, this._forumParseSubtasks(topic.subtasks).filter((item) => item.id !== btn.dataset.subtaskId));
    });
  });
  box.querySelector('.forum-subtask-add')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const input = box.querySelector('.forum-subtask-add input');
    const title = input && input.value.trim();
    if (!title) return;
    const next = [...this._forumParseSubtasks(topic.subtasks), { id: `n${Date.now().toString(36)}`, title, done: false }];
    input.value = '';
    this._forumSaveSubtasks(topic, next);
  });
},

_forumSaveSubtasks(topic, subtasks) {
  topic.subtasks = subtasks;
  this.socket.emit('set-topic-meta', {
    messageId: topic.id,
    title: topic.title || this._forumTitleOf(topic),
    tags: Array.isArray(topic.tags) ? topic.tags : [],
    closed: !!topic.closed,
    requestStatus: topic.request_status || null,
    topicKind: topic.topic_kind || null,
    subtasks,
  });
  if (this._activeThreadParent === topic.id) this._paintForumSubtasks(topic);
},

_forumStatusRank(msg) {
  if (msg.closed || msg.request_status === 'complete') return 5;
  if (msg.request_status === 'in_progress') return 0;
  if (msg.request_status === 'blocked') return 1;
  if (msg.request_status === 'review') return 2;
  if (msg.request_status === 'planned') return 3;
  return 4;
},

_forumSortTopics(list) {
  const p = this._forumPrefs();
  const key = p.sort === 'created' ? (m) => new Date(m.created_at).getTime() || 0 : (m) => this._forumActivityOf(m);
  // Pinned first, then in progress / planned / open, then complete or closed.
  return [...list].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || this._forumStatusRank(a) - this._forumStatusRank(b) || key(b) - key(a) || b.id - a.id);
},

_forumHash(title) {
  let h = 17;
  for (const c of String(title || '')) h = h * 31 + c.charCodeAt(0);
  return h >>> 0;
},

_forumGlyph(msg) {
  const tags = Array.isArray(msg.tags) ? msg.tags : [];
  const emojiRe = /[\p{Extended_Pictographic}\p{So}]/u;
  for (const tag of tags) {
    const m = String(tag).match(emojiRe);
    if (m) return m[0];
  }
  const title = this._forumTitleOf(msg);
  const em = title.match(emojiRe);
  if (em) return em[0];
  const letter = title.trim().split('').find((c) => /\p{L}|\p{N}/u.test(c));
  return letter ? letter.toUpperCase() : '⬡';
},

_forumThumbArt(msg) {
  const h = this._forumHash(this._forumTitleOf(msg));
  const hue = h % 360;
  const light = document.documentElement.classList.contains('light') || (document.documentElement.getAttribute('data-theme') || '').includes('light');
  const s1 = light ? 35 : 55;
  const v1 = light ? 92 : 42;
  const s2 = light ? 25 : 60;
  const v2 = light ? 98 : 20;
  const angle = (h % 8) * 45;
  return `linear-gradient(${angle}deg, hsl(${hue} ${s1}% ${v1}%), hsl(${(hue + 48) % 360} ${s2}% ${v2}%))`;
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
  const topics = this._forumSortTopics((messages || []).filter(m => m && !m.thread_id && (m.type || 'user') === 'user'));
  for (const m of topics) this._forumTopics.set(m.id, m);
  container.appendChild(this._forumToolbarEl(code));
  this._applyForumChrome(container, p);
  const grid = document.createElement('div');
  grid.className = 'forum-topics';
  grid.id = 'forum-topics';
  for (const m of topics) grid.appendChild(this._createForumTopicEl(m));
  container.appendChild(grid);
  if (!topics.length) {
    const hint = document.createElement('div');
    hint.className = 'forum-empty-hint';
    hint.textContent = (p.tags.length || p.requestStatus || p.topicKind) ? t('forum.no_topics_for_tags') : t('app.messages.forum_empty_hint');
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
  this._flushPendingMedia && this._flushPendingMedia();
  this._lazyMedia && this._lazyPump && this._lazyPump();
},

_forumToolbarEl(code) {
  const p = this._forumPrefs(code);
  const bar = document.createElement('div');
  bar.className = 'forum-toolbar';
  bar.id = 'forum-toolbar';
  const kindOpts = this._forumKindOptions(p.topicKind, true);
  const statusOpts = [`<option value="">${t('forum.status_all')}</option>`, ...this._forumStatuses().map((s) => `<option value="${s}"${p.requestStatus === s ? ' selected' : ''}>${this._forumStatusLabel(s)}</option>`)].join('');
  bar.innerHTML = `
    <div class="forum-toolbar-row forum-toolbar-hdr">
      <div class="forum-view-toggle" role="group">
        <button type="button" class="forum-view-btn${p.view === 'list' ? ' active' : ''}" data-view="list">${t('forum.view_list')}</button>
        <button type="button" class="forum-view-btn${p.view === 'gallery' ? ' active' : ''}" data-view="gallery">${t('forum.view_gallery')}</button>
        <button type="button" class="forum-view-btn${p.view === 'feed' ? ' active' : ''}" data-view="feed">${t('forum.view_feed')}</button>
      </div>
      <label class="forum-tile-size"${p.view === 'gallery' ? '' : ' hidden'}>
        <span>${t('forum.tile_size')}</span>
        <input type="range" id="forum-tile-size" min="7" max="28" step="0.5" value="${p.tile}" aria-label="${t('forum.tile_size')}">
      </label>
    </div>
    <div class="forum-toolbar-row forum-toolbar-controls">
      <button type="button" class="btn-sm btn-accent forum-new-post" id="forum-new-post">✏️ ${t('forum.new_post')}</button>
      <select id="forum-kind" class="forum-select" title="${t('forum.kind')}">${kindOpts}</select>
      <select id="forum-status" class="forum-select" title="${t('forum.status')}">${statusOpts}</select>
      <select id="forum-sort" class="forum-select" title="${t('forum.sort')}">
        <option value="active"${p.sort === 'active' ? ' selected' : ''}>${t('forum.sort_active')}</option>
        <option value="created"${p.sort === 'created' ? ' selected' : ''}>${t('forum.sort_created')}</option>
      </select>
    </div>`;
  bar.querySelector('#forum-new-post').addEventListener('click', () => this._openForumComposer());
  bar.querySelector('#forum-sort').addEventListener('change', (e) => { this._setForumPrefs(code, { sort: e.target.value }); this._forumReload(); });
  bar.querySelector('#forum-kind').addEventListener('change', (e) => { this._setForumPrefs(code, { topicKind: e.target.value || '' }); this._forumReload(); });
  bar.querySelector('#forum-status').addEventListener('change', (e) => { this._setForumPrefs(code, { requestStatus: e.target.value || '' }); this._forumReload(); });
  bar.querySelectorAll('.forum-view-btn').forEach(b => b.addEventListener('click', () => {
    const next = this._setForumPrefs(code, { view: this._forumParseView(b.dataset.view) });
    bar.querySelectorAll('.forum-view-btn').forEach(x => x.classList.toggle('active', x === b));
    this._applyForumChrome(document.getElementById('messages'), next);
    this._lazyMedia && this._lazyPump && this._lazyPump();
  }));
  bar.querySelector('#forum-tile-size')?.addEventListener('input', (e) => {
    this._applyForumChrome(document.getElementById('messages'), this._setForumPrefs(code, { tile: this._forumParseTile(e.target.value) }));
  });
  return bar;
},

_createForumTopicEl(msg) {
  const el = document.createElement('div');
  const status = this._forumParseStatus(msg.request_status);
  const kind = this._forumParseKind(msg.topic_kind) || 'feature';
  el.className = 'forum-topic' + (msg.pinned ? ' forum-topic-pinned' : '') + (msg.closed ? ' forum-topic-closed' : '') + (status ? ` forum-topic-${status.replace('_', '-')}` : '') + ` forum-topic-kind-${kind}`;
  el.dataset.msgId = msg.id;
  el.dataset.userId = msg.user_id;
  el.dataset.time = msg.created_at;
  el.dataset.username = msg.username || '';
  if (status) el.dataset.requestStatus = status;
  // Protected topics carry the same flag and shield as a message in chat, so
  // the card shows it and the context menu offers Unprotect (#5622).
  if (msg.is_archived) { el.classList.add('archived'); el.dataset.archived = '1'; }
  const tagsOf = this._forumTagsOf();
  const tags = Array.isArray(msg.tags) ? msg.tags : [];
  const thumb = this._forumThumbOf(msg);
  const count = msg.thread && msg.thread.count ? msg.thread.count : 0;
  const when = this._forumPrefs().sort === 'created' ? new Date(msg.created_at) : new Date(this._forumActivityOf(msg));
  const canEdit = this.user && (msg.user_id === this.user.id || this.user.isAdmin || (this._hasPerm && this._hasPerm('manage_messages')));
  const glyph = this._forumKindGlyph(kind) || this._forumGlyph(msg);
  const art = this._forumThumbArt(msg);
  const statusLabel = status ? this._forumStatusLabel(status) : '';
  const kindLabel = this._forumKindLabel(kind);
  const subs = this._forumParseSubtasks(msg.subtasks);
  const subDone = subs.filter((x) => x.done).length;
  const tagLine = tags.map((name) => {
    const tg = tagsOf.find((x) => x.name === name);
    return `<span class="forum-tag-hash">${tg && tg.emoji ? this._escapeHtml(tg.emoji) + ' ' : ''}#${this._escapeHtml(name)}</span>`;
  }).join('');
  el.innerHTML = `
    ${this._forumAvatarHtml(msg)}
    <div class="forum-topic-body">
      <div class="forum-topic-meta-top">${this._escapeHtml(msg.username || '')}  ·  ${this._forumAgo(when)}</div>
      <div class="forum-topic-tags"><span class="forum-tag forum-tag-kind forum-tag-kind-${kind}">${this._forumKindGlyph(kind)} ${this._escapeHtml(kindLabel)}</span>${statusLabel ? `<span class="forum-tag forum-tag-status forum-tag-status-${status}">${this._escapeHtml(statusLabel)}</span>` : ''}${msg.is_archived ? `<span class="forum-tag forum-tag-protected archived-tag" title="${this._escapeHtml(t('app.messages.protected'))}">🛡️</span>` : ''}${msg.closed ? `<span class="forum-tag forum-tag-closed">✔ ${t('forum.closed')}</span>` : ''}${msg.pinned ? `<span class="forum-tag forum-tag-pinned">📌 ${t('forum.pinned')}</span>` : ''}${tagLine}</div>
      <div class="forum-topic-title">${this._escapeHtml(this._forumTitleOf(msg))}</div>
      <div class="forum-topic-snippet message-content">${this._escapeHtml(this._forumSnippetOf(msg))}</div>
      <div class="forum-topic-meta">
        <span class="forum-topic-replies${count ? '' : ' forum-topic-replies-empty'}" data-thread-parent="${msg.id}">${count ? `💬 ${t('forum.replies', { count })}` : t('thread_runtime.reply_to_topic')}</span>
        ${subs.length ? `<span class="forum-topic-subtasks">${t('forum.subtasks_progress', { done: subDone, total: subs.length })}</span>` : ''}
        ${canEdit ? `<button type="button" class="forum-topic-edit" title="${t('forum.edit_topic')}">✎</button>` : ''}
      </div>
    </div>
    ${thumb ? `<div class="forum-topic-thumb"><img ${this._lazySrcAttr ? this._lazySrcAttr(this._imgSrcAttr ? this._imgSrcAttr(thumb) : `src="${this._escapeHtml(thumb)}"`) : `src="${this._escapeHtml(thumb)}"`} class="chat-image forum-thumb-img" alt=""></div>` : `<div class="forum-topic-thumb forum-topic-thumb-empty" style="background:${art}"><span>${this._escapeHtml(glyph)}</span></div>`}`;
  el.addEventListener('click', (e) => {
    if (e.target.closest('.forum-topic-edit')) { e.stopPropagation(); this._forumEditTopicMeta(msg.id); return; }
    if (e.target.closest('.forum-tag-status') && canEdit) { e.stopPropagation(); this._forumCycleStatus(msg.id); return; }
    if (e.target.closest('a')) return;
    this._openThread(msg.id);
  });
  el.addEventListener('contextmenu', (e) => { if (this._showMessageContextMenu) { e.preventDefault(); this._showMessageContextMenu(e, el); } });
  return el;
},

_forumCycleStatus(messageId) {
  const topic = this._forumTopics && this._forumTopics.get(messageId);
  if (!topic) return;
  const order = this._forumStatuses();
  const cur = order.indexOf(topic.request_status);
  const next = order[(cur + 1) % order.length];
  this.socket.emit('set-topic-meta', { messageId, title: topic.title || this._forumTitleOf(topic), tags: Array.isArray(topic.tags) ? topic.tags : [], closed: !!topic.closed, requestStatus: next, topicKind: topic.topic_kind || null, subtasks: this._forumParseSubtasks(topic.subtasks) });
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
  if (this._forumDraftMeta && this.user && msg.user_id === this.user.id) {
    const draft = this._forumDraftMeta;
    this._forumDraftMeta = null;
    if (!this._forumParseSubtasks(msg.subtasks).length && draft.subtasks && draft.subtasks.length) {
      msg.subtasks = draft.subtasks;
      this.socket.emit('set-topic-meta', {
        messageId: msg.id,
        title: msg.title || this._forumTitleOf(msg),
        tags: Array.isArray(msg.tags) && msg.tags.length ? msg.tags : (draft.tags || []),
        closed: !!msg.closed,
        requestStatus: msg.request_status || draft.requestStatus || null,
        topicKind: msg.topic_kind || draft.topicKind || null,
        subtasks: draft.subtasks,
      });
    }
    if ((!Array.isArray(msg.tags) || !msg.tags.length) && draft.tags && draft.tags.length) msg.tags = draft.tags;
    if (!msg.topic_kind && draft.topicKind) msg.topic_kind = draft.topicKind;
  }
  const p = this._forumPrefs();
  if (p.tags.length) {
    const has = Array.isArray(msg.tags) ? msg.tags : [];
    const ok = p.tagMode === 'all' ? p.tags.every(x => has.includes(x)) : p.tags.some(x => has.includes(x));
    if (!ok) return;
  }
  if (p.requestStatus && msg.request_status !== p.requestStatus) return;
  if (p.topicKind && (msg.topic_kind || (p.topicKind === 'feature' ? 'feature' : '')) !== p.topicKind) return;
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
  if (this._forumPrefs().sort === 'active' && !topic.pinned && !topic.closed) {
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
  const wasClosed = !!topic.closed;
  const wasStatus = topic.request_status || '';
  const wasKind = topic.topic_kind || '';
  if (typeof data.closed === 'boolean') topic.closed = data.closed;
  if ('request_status' in data) topic.request_status = data.request_status || null;
  if ('topic_kind' in data) topic.topic_kind = data.topic_kind || null;
  if ('subtasks' in data) topic.subtasks = Array.isArray(data.subtasks) ? data.subtasks : [];
  if (this._activeThreadParent === topic.id) this._paintForumSubtasks(topic);
  // Closing or reopening moves the card between the open and closed groups,
  // so the list is rebuilt rather than the card swapped in place (#5624).
  if (!!topic.closed !== wasClosed || (topic.request_status || '') !== wasStatus || (topic.topic_kind || '') !== wasKind) { this._forumReload(); return; }
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
  const channelTags = this._forumTagsOf(code);
  const picked = new Set(existing && Array.isArray(existing.tags) ? existing.tags : []);
  let status = this._forumParseStatus(existing && existing.request_status) || 'planned';
  let kind = this._forumParseKind(existing && existing.topic_kind) || 'request';
  const files = [];
  const remote = [];
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'forum-post-modal';
  const existingSubs = existing ? this._forumParseSubtasks(existing.subtasks).map((x) => x.title).join('\n') : '';
  overlay.innerHTML = `
    <div class="modal forum-post-modal">
      <div class="modal-controls"><button type="button" class="modal-expand-btn" id="forum-post-close" title="${t('modals.common.close')}">✕</button></div>
      <h3>${existing ? t('forum.edit_topic') : t('forum.new_post')}</h3>
      <div class="modal-body">
        <label class="forum-field"><span>${t('forum.kind')}</span><select id="forum-post-kind" class="forum-select forum-select-type">${this._forumKindOptions(kind, false)}</select></label>
        <label class="forum-field"><span>${t('forum.title')}</span><input type="text" id="forum-post-title" maxlength="120" placeholder="${t('forum.title_placeholder')}" value="${existing ? this._escapeHtml(existing.title || '') : ''}"></label>
        ${existing ? '' : `<label class="forum-field"><span>${t('forum.body')}</span><textarea id="forum-post-body" rows="6" placeholder="${t('forum.body_placeholder')}"></textarea></label>`}
        <label class="forum-field forum-status-field"><span>${t('forum.status')}</span><select id="forum-post-status" class="forum-select">${this._forumStatuses().map((s) => `<option value="${s}"${status === s ? ' selected' : ''}>${this._forumStatusLabel(s)}</option>`).join('')}</select></label>
        <div class="forum-field"><span>${t('forum.tags')} <small>${t('forum.tags_hint')}</small></span><div class="forum-tag-picker" id="forum-post-tags"></div>
          <div class="forum-tag-custom"><input type="text" id="forum-post-tag-custom" maxlength="30" placeholder="${t('forum.tag_custom_placeholder')}"><button type="button" id="forum-post-tag-add">${t('forum.tag_custom_add')}</button></div>
        </div>
        <label class="forum-field forum-subtasks-field"><span>${t('forum.subtasks')}</span><textarea id="forum-post-subtasks" rows="4" placeholder="${t('forum.subtasks_placeholder')}">${this._escapeHtml(existingSubs)}</textarea></label>
        ${existing ? '' : `<div class="forum-field forum-attach-field">
          <span>${t('forum.attach')}</span>
          <div class="forum-attach-drop" id="forum-attach-drop">
            <input type="file" id="forum-attach-input" accept="image/jpeg,image/png,image/gif,image/webp,image/*" multiple hidden>
            <button type="button" class="btn-sm" id="forum-attach-btn">${t('forum.attach_images')}</button>
            <button type="button" class="btn-sm" id="forum-attach-gif">${t('forum.attach_gif')}</button>
            <span class="forum-attach-hint">${t('forum.attach_drop')}</span>
          </div>
          <div class="forum-attach-thumbs" id="forum-attach-thumbs"></div>
        </div>`}
        ${existing ? `<label class="forum-field forum-field-closed"><span><input type="checkbox" id="forum-post-closed"${existing.closed ? ' checked' : ''}> ${t('forum.mark_closed')}</span></label>` : ''}
      </div>
      <div class="modal-footer"><button type="button" class="btn-sm" id="forum-post-cancel">${t('modals.common.cancel')}</button><button type="button" class="btn-sm btn-accent" id="forum-post-go">${existing ? t('modals.common.save') : t('forum.post')}</button></div>
    </div>`;
  const modal = overlay.querySelector('.modal');
  modal.dataset.modalControlsInjected = '1';
  document.body.appendChild(overlay);
  const close = () => {
    this._forumAttachGif = null;
    overlay.remove();
  };
  overlay.querySelector('#forum-post-close').addEventListener('click', close);
  overlay.querySelector('#forum-post-cancel').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  const paintTags = () => {
    const spec = this._forumTypeOf(kind);
    const names = [];
    const seen = new Set();
    const add = (name, emoji) => {
      if (!name || seen.has(name.toLowerCase())) return;
      seen.add(name.toLowerCase());
      names.push({ name, emoji: emoji || '' });
    };
    for (const n of spec.tags) add(n);
    for (const tg of channelTags) add(tg.name, tg.emoji);
    for (const n of picked) add(n);
    overlay.querySelector('#forum-post-tags').innerHTML = names.map((tg) => `<button type="button" class="forum-tag-chip${picked.has(tg.name) ? ' active' : ''}" data-tag="${this._escapeHtml(tg.name)}">${tg.emoji ? this._escapeHtml(tg.emoji) + ' ' : ''}#${this._escapeHtml(tg.name)}</button>`).join('');
    overlay.querySelectorAll('#forum-post-tags .forum-tag-chip').forEach((c) => c.addEventListener('click', () => {
      const name = c.dataset.tag;
      if (picked.has(name)) picked.delete(name);
      else if (picked.size < 8) picked.add(name);
      paintTags();
    }));
  };
  const applyType = () => {
    const spec = this._forumTypeOf(kind);
    modal.dataset.forumKind = spec.id;
    modal.dataset.forumGroup = spec.group;
    overlay.querySelector('.forum-status-field').hidden = !spec.status;
    overlay.querySelector('.forum-subtasks-field').hidden = !spec.subtasks;
    paintTags();
  };
  const addCustomTag = () => {
    const input = overlay.querySelector('#forum-post-tag-custom');
    const name = input.value.trim().replace(/\s+/g, ' ').slice(0, 30);
    if (!name) return;
    if (picked.size < 8) picked.add(name);
    input.value = '';
    paintTags();
  };
  overlay.querySelector('#forum-post-kind').addEventListener('change', (e) => { kind = e.target.value; applyType(); });
  overlay.querySelector('#forum-post-status').addEventListener('change', (e) => { status = e.target.value; });
  overlay.querySelector('#forum-post-tag-add').addEventListener('click', addCustomTag);
  overlay.querySelector('#forum-post-tag-custom').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addCustomTag(); } });
  applyType();

  const thumbs = overlay.querySelector('#forum-attach-thumbs');
  const paintAttach = () => {
    if (!thumbs) return;
    thumbs.innerHTML = '';
    files.forEach((file, i) => {
      const el = document.createElement('div');
      el.className = 'forum-attach-thumb';
      const img = document.createElement('img');
      img.src = URL.createObjectURL(file);
      img.alt = file.name;
      img.onload = () => URL.revokeObjectURL(img.src);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = '×';
      btn.addEventListener('click', () => { files.splice(i, 1); paintAttach(); });
      el.append(img, btn);
      thumbs.appendChild(el);
    });
    remote.forEach((url, i) => {
      const el = document.createElement('div');
      el.className = 'forum-attach-thumb';
      const img = document.createElement('img');
      img.src = url;
      img.alt = 'gif';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = '×';
      btn.addEventListener('click', () => { remote.splice(i, 1); paintAttach(); });
      el.append(img, btn);
      thumbs.appendChild(el);
    });
  };
  const takeFiles = (list) => {
    for (const file of list || []) {
      if (!file || !/^image\//.test(file.type || '')) continue;
      if (files.length + remote.length >= 8) break;
      files.push(file);
    }
    paintAttach();
  };
  overlay.querySelector('#forum-attach-btn')?.addEventListener('click', () => overlay.querySelector('#forum-attach-input').click());
  overlay.querySelector('#forum-attach-input')?.addEventListener('change', (e) => { takeFiles(e.target.files); e.target.value = ''; });
  const drop = overlay.querySelector('#forum-attach-drop');
  if (drop) {
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); takeFiles(e.dataTransfer && e.dataTransfer.files); });
  }
  overlay.addEventListener('paste', (e) => {
    const items = e.clipboardData && e.clipboardData.files;
    if (items && items.length) takeFiles(items);
  });
  this._forumAttachGif = (url) => {
    if (!url || remote.length + files.length >= 8) return;
    remote.push(url);
    paintAttach();
  };
  overlay.querySelector('#forum-attach-gif')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const gifBtn = document.getElementById('gif-btn');
    if (gifBtn) gifBtn.click();
    else this._showToast?.(t('forum.gif_unavailable'), 'error');
  });

  const titleEl = overlay.querySelector('#forum-post-title');
  titleEl.focus();
  overlay.querySelector('#forum-post-go').addEventListener('click', async () => {
    const title = titleEl.value.trim();
    const spec = this._forumTypeOf(kind);
    const subtasks = spec.subtasks
      ? (overlay.querySelector('#forum-post-subtasks')?.value || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean).map((titleLine) => ({ title: titleLine, done: false }))
      : [];
    const go = overlay.querySelector('#forum-post-go');
    if (existing) {
      const closedBox = overlay.querySelector('#forum-post-closed');
      const kept = this._forumParseSubtasks(existing.subtasks);
      const byTitle = new Map(kept.map((x) => [x.title, x]));
      const merged = spec.subtasks ? subtasks.map((item) => byTitle.get(item.title) || item) : kept;
      this.socket.emit('set-topic-meta', { messageId: existing.id, title, tags: [...picked], closed: closedBox ? closedBox.checked : undefined, requestStatus: spec.status ? status : null, topicKind: kind, subtasks: merged });
      close();
      return;
    }
    let body = overlay.querySelector('#forum-post-body')?.value.trim() || '';
    if (!title && !body && !files.length && !remote.length) { titleEl.focus(); return; }
    go.disabled = true;
    const uploaded = [];
    for (const file of files) {
      try {
        const formData = new FormData();
        formData.append('scope', 'channel');
        formData.append('file', file);
        const data = await this._uploadWithProgress('/api/upload-file', formData);
        if (data && data.url) uploaded.push(data.url);
        else this._showToast?.(data?.error || t('media.upload_failed'), 'error');
      } catch (err) {
        this._showToast?.(err.message || t('media.upload_failed'), 'error');
      }
    }
    const extras = [...uploaded, ...remote];
    if (extras.length) body = [body, ...extras].filter(Boolean).join('\n');
    const subtaskPayload = subtasks;
    this._forumDraftMeta = { subtasks: subtaskPayload, tags: [...picked], topicKind: kind, requestStatus: spec.status ? status : null };
    this.socket.emit('send-message', {
      code, content: body || title, title: title || undefined, tags: [...picked],
      requestStatus: spec.status ? status : null, topicKind: kind, subtasks: subtaskPayload,
    });
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
