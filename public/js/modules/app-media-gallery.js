// The channel media gallery and thread list: tabs, sorting, tile size and
// shape, selecting and deleting, the tag filter and bulk tag management,
// and the video lightbox.

export default {

_bindMediaGallery() {
  // ── Channel media gallery (#5350) ──
  const galleryBtn = document.getElementById('gallery-toggle-btn');
  if (galleryBtn) {
    galleryBtn.addEventListener('click', () => {
      if (!this.currentChannel) return;
      const modal = document.getElementById('media-gallery-modal');
      const body = document.getElementById('media-gallery-body');
      body.innerHTML = `<div class="media-gallery-empty muted-text">${t('media_gallery.loading')}</div>`;
      // Reset tab counts
      ['photos','videos','audios','files','links'].forEach(k => {
        const el = document.getElementById(`media-count-${k}`);
        if (el) el.textContent = '0';
      });
      // Default to Photos tab
      document.querySelectorAll('#media-gallery-modal .media-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === 'photos'));
      this._mediaGalleryActiveTab = 'photos';
      modal.style.display = 'flex';
      this.socket.emit('get-channel-media', { code: this.currentChannel });
    });
  }
  // ── Channel thread list (#5506) ──
  const threadsBtn = document.getElementById('threads-toggle-btn');
  if (threadsBtn) {
    threadsBtn.addEventListener('click', () => {
      if (!this.currentChannel) return;
      const modal = document.getElementById('threads-list-modal');
      const body = document.getElementById('threads-list-body');
      const search = document.getElementById('threads-list-search');
      this._threadListData = null;
      if (search) search.value = '';
      body.innerHTML = `<div class="media-gallery-empty muted-text">${t('thread_list.loading')}</div>`;
      modal.style.display = 'flex';
      this.socket.emit('get-channel-threads', { code: this.currentChannel });
      // Opened by pointer, so focusing the filter is a convenience, not a trap.
      if (search) setTimeout(() => search.focus(), 50);
    });
  }
  const threadsClose = document.getElementById('threads-list-close');
  if (threadsClose) threadsClose.addEventListener('click', () => {
    document.getElementById('threads-list-modal').style.display = 'none';
  });
  const threadsModal = document.getElementById('threads-list-modal');
  if (threadsModal) threadsModal.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) e.currentTarget.style.display = 'none';
  });
  const threadsSearch = document.getElementById('threads-list-search');
  if (threadsSearch) threadsSearch.addEventListener('input', () => {
    // Filtering client-side: the list is already capped server-side, and a
    // round trip per keystroke would be worse than filtering 500 rows.
    this._renderThreadList(threadsSearch.value);
  });
  const threadsBody = document.getElementById('threads-list-body');
  if (threadsBody) threadsBody.addEventListener('click', (e) => {
    const row = e.target.closest('.thread-list-row');
    if (!row) return;
    const parentId = parseInt(row.dataset.parentId, 10);
    if (!parentId) return;
    document.getElementById('threads-list-modal').style.display = 'none';
    // Jump first: _openThread reads the parent's author and preview out of the
    // rendered message, so opening a thread whose root sits far up the channel
    // would otherwise show an empty header.
    this._jumpToMessage?.(parentId);
    setTimeout(() => this._openThread?.(parentId), 150);
  });

  const galleryClose = document.getElementById('media-gallery-close');
  if (galleryClose) galleryClose.addEventListener('click', () => {
    document.getElementById('media-gallery-modal').style.display = 'none';
  });
  const galleryModal = document.getElementById('media-gallery-modal');
  if (galleryModal) galleryModal.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) e.currentTarget.style.display = 'none';
  });
  // Tab switching
  document.querySelectorAll('#media-gallery-modal .media-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#media-gallery-modal .media-tab').forEach(b => b.classList.toggle('active', b === btn));
      this._mediaGalleryActiveTab = btn.dataset.tab;
      this._applyMediaTileSize();
      if (this._mediaGalleryData) this._renderMediaGalleryTab(this._mediaGalleryActiveTab);
      // Switching tabs clears selection: selecting items across tabs and
      // hitting Delete would be confusing since each tab has its own scope.
      if (this._mediaGallerySelected) this._mediaGallerySelected.clear();
      this._refreshMediaGalleryToolbar();
    });
  });

  // ── Sort dropdown (#5375) ──
  const sortSel = document.getElementById('media-gallery-sort');
  if (sortSel) {
    // Persist last-used sort so users don't have to re-pick it each session
    try {
      const saved = localStorage.getItem('mediaGallerySort');
      if (saved) { sortSel.value = saved; this._mediaGallerySort = saved; }
      else this._mediaGallerySort = 'date-desc';
    } catch { this._mediaGallerySort = 'date-desc'; }
    sortSel.addEventListener('change', () => {
      this._mediaGallerySort = sortSel.value || 'date-desc';
      try { localStorage.setItem('mediaGallerySort', this._mediaGallerySort); } catch { /* storage blocked (private mode): nothing is remembered, nothing else breaks */ }
      if (this._mediaGalleryData) this._renderMediaGalleryTab(this._mediaGalleryActiveTab || 'photos');
    });
  }

  const tileSlider = document.getElementById('media-gallery-tile');
  if (tileSlider) {
    tileSlider.value = String(this._mediaTilePx());
    this._applyMediaTileSize();
    tileSlider.addEventListener('input', () => {
      const px = this._mediaTilePx(tileSlider.value);
      try { localStorage.setItem('mediaGalleryTile', String(px)); } catch { /* storage blocked (private mode): nothing is remembered, nothing else breaks */ }
      this._applyMediaTileSize(px);
    });
  }
  // Tile shape, shared with the forum gallery (#5645).
  const shapeSel = document.getElementById('media-gallery-shape');
  if (shapeSel && this._tileShapeOptionsHtml) {
    let saved = 'square';
    try { saved = this._forumParseShape(localStorage.getItem('mediaGalleryShape')); } catch { /* storage blocked (private mode): keep the default */ }
    shapeSel.innerHTML = this._tileShapeOptionsHtml(saved);
    shapeSel.addEventListener('change', () => {
      try { localStorage.setItem('mediaGalleryShape', this._forumParseShape(shapeSel.value)); } catch { /* storage blocked (private mode): nothing is remembered, nothing else breaks */ }
      this._applyMediaTileSize();
    });
  }

  // ── Select / multi-delete bar (#5375) ──
  const selToggle = document.getElementById('media-gallery-select-toggle');
  const selAll    = document.getElementById('media-gallery-select-all');
  const delBtn    = document.getElementById('media-gallery-delete');
  if (selToggle) selToggle.addEventListener('click', () => {
    this._mediaGallerySelectMode = !this._mediaGallerySelectMode;
    if (!this._mediaGallerySelectMode && this._mediaGallerySelected) this._mediaGallerySelected.clear();
    this._refreshMediaGalleryToolbar();
    if (this._mediaGalleryData) this._renderMediaGalleryTab(this._mediaGalleryActiveTab || 'photos');
  });
  if (selAll) selAll.addEventListener('click', () => {
    if (!this._mediaGalleryData || !this._mediaGallerySelectMode) return;
    const tab = this._mediaGalleryActiveTab || 'photos';
    if (tab === 'links') return; // not deletable
    // Only the items currently visible under the active tag filter, so Select
    // all never reaches attachments hidden by the filter.
    const items = this._filterMediaItemsByTags(this._mediaGalleryData[tab] || [], tab);
    const selected = this._mediaGallerySelected || (this._mediaGallerySelected = new Map());
    // Toggle: if everything in this tab is already selected, clear; else add all
    const allSelected = items.length > 0 && items.every(it => selected.has(this._mediaItemKey(it)));
    if (allSelected) {
      items.forEach(it => selected.delete(this._mediaItemKey(it)));
    } else {
      items.forEach(it => selected.set(this._mediaItemKey(it), { message_id: it.message_id, url: it.url }));
    }
    this._refreshMediaGalleryToolbar();
    this._renderMediaGalleryTab(tab);
  });
  if (delBtn) delBtn.addEventListener('click', () => {
    if (!this._mediaGallerySelected || this._mediaGallerySelected.size === 0) return;
    if (!this.currentChannel) return;
    const count = this._mediaGallerySelected.size;
    const ok = confirm(t('media_gallery.confirm_delete', { count }));
    if (!ok) return;
    // Build messageIds (one delete per message; bulk endpoint dedupes
    // server-side too). Group attachment URLs per message id so E2E DM
    // attachments can be moved to deleted-attachments/ even though the
    // server can't read the ciphertext.
    const messageIds = [];
    const attachmentsByMessage = {};
    for (const { message_id, url } of this._mediaGallerySelected.values()) {
      if (!messageIds.includes(message_id)) messageIds.push(message_id);
      if (!attachmentsByMessage[message_id]) attachmentsByMessage[message_id] = [];
      if (url && url.startsWith('/uploads/')) attachmentsByMessage[message_id].push(url);
    }
    delBtn.disabled = true;
    this.socket.emit('delete-channel-media', {
      code: this.currentChannel,
      messageIds,
      attachmentsByMessage,
    }, (res) => {
      delBtn.disabled = false;
      if (!res || res.error) {
        if (this._showToast) this._showToast(res?.error || t('media_gallery.delete_failed'), 'error');
        else alert(res?.error || t('media_gallery.delete_failed'));
        return;
      }
      if (this._showToast) this._showToast(res.skipped
        ? t('media_gallery.deleted_with_skipped', { deleted: res.deleted || 0, skipped: res.skipped })
        : t('media_gallery.deleted', { count: res.deleted || 0 }), 'info');
      // Clear selection, exit select mode, and refresh data
      if (this._mediaGallerySelected) this._mediaGallerySelected.clear();
      this._mediaGallerySelectMode = false;
      this._refreshMediaGalleryToolbar();
      this.socket.emit('get-channel-media', { code: this.currentChannel });
    });
  });

  // ── Tag filter (#tagging phase 3b) ──
  // Opens a body-level picker; selecting one or more tags filters the current
  // tab to attachments carrying ALL of them (exact match), respecting the sort.
  const tagFilterBtn = document.getElementById('media-gallery-tagfilter-btn');
  if (tagFilterBtn) tagFilterBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (document.getElementById('media-tag-filter-popup')) this._closeMediaTagFilter();
    else this._openMediaTagFilter(tagFilterBtn);
  });

  // ── Bulk tag management (#tagging phase 3b) ──
  // In select mode, manage_tags holders get a dropdown to Append or Replace
  // tags across the selected attachments, confirmed in a tag picker.
  const tagManageBtn = document.getElementById('media-gallery-tagmanage-btn');
  const tagManageMenu = document.getElementById('media-tagmanage-menu');
  if (tagManageBtn && tagManageMenu) {
    tagManageBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      tagManageMenu.style.display = tagManageMenu.style.display !== 'none' ? 'none' : '';
    });
    tagManageMenu.querySelectorAll('.media-tagmanage-opt').forEach(opt => {
      opt.addEventListener('click', (e) => {
        e.stopPropagation();
        tagManageMenu.style.display = 'none';
        this._openMediaTagManage(opt.dataset.mode);
      });
    });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#media-gallery-tagmanage')) tagManageMenu.style.display = 'none';
    });
  }
},

// ── Channel Media Gallery (#5350) ─────────────────────
_renderThreadList(filter = '') {
  const body = document.getElementById('threads-list-body');
  const countEl = document.getElementById('threads-list-count');
  if (!body) return;

  const all = this._threadListData || [];
  const needle = String(filter || '').trim().toLowerCase();
  const rows = needle
    ? all.filter(th =>
        String(th.content || '').toLowerCase().includes(needle) ||
        String(th.username || '').toLowerCase().includes(needle))
    : all;

  if (countEl) {
    countEl.textContent = needle
      ? `${rows.length} / ${all.length}`
      : (all.length ? String(all.length) : '');
  }

  if (!rows.length) {
    const key = all.length ? 'thread_list.no_matches' : 'thread_list.empty';
    body.innerHTML = `<div class="media-gallery-empty muted-text">${t(key)}</div>`;
    return;
  }

  body.innerHTML = rows.map(th => {
    const replies = Number(th.reply_count) || 0;
    const label = replies === 1
      ? t('thread_list.reply_one')
      : t('thread_list.reply_other', { count: replies });
    // Strip attachment markdown so a thread started with a file reads as its
    // filename rather than a wall of markup.
    const preview = String(th.content || '')
      .replace(/\[file:([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/!\[[^\]]*\]\(([^)\s]+)\)/g, '$1')
      .trim();
    return `
      <button class="thread-list-row" data-parent-id="${th.id}">
        <span class="thread-list-row-top">
          <span class="thread-list-author">${this._escapeHtml(th.username || '')}</span>
          <span class="thread-list-replies">${this._escapeHtml(label)}</span>
          <span class="thread-list-when">${this._escapeHtml(this._formatTime?.(th.last_reply_at) || '')}</span>
        </span>
        <span class="thread-list-preview">${this._escapeHtml(preview)}</span>
      </button>`;
  }).join('');
},

_renderMediaGallery(data) {
  this._mediaGalleryData = data;
  ['photos','videos','audios','files','links'].forEach(k => {
    const el = document.getElementById(`media-count-${k}`);
    if (el) el.textContent = String((data[k] || []).length);
  });
  // Reset selection whenever fresh data comes in so stale picks don't linger
  this._mediaGallerySelected = new Map();
  this._mediaGallerySelectMode = false;
  // Reset the tag filter and tear down any open tag popups on fresh data.
  this._mediaTagFilter = [];
  this._closeMediaTagFilter?.();
  this._closeMediaTagManage?.();
  this._updateTagFilterBadge?.();
  this._refreshMediaGalleryToolbar();
  this._applyMediaTileSize();
  this._renderMediaGalleryTab(this._mediaGalleryActiveTab || 'photos');
},

_mediaTilePx(raw) {
  const n = parseInt(raw != null ? raw : (() => { try { return localStorage.getItem('mediaGalleryTile'); } catch { return ''; } })(), 10);
  if (!Number.isFinite(n)) return 150;
  return Math.min(360, Math.max(72, n));
},

_applyMediaTileSize(px) {
  const size = px != null ? this._mediaTilePx(px) : this._mediaTilePx();
  const modal = document.getElementById('media-gallery-modal');
  if (modal) modal.style.setProperty('--media-tile', `${size}px`);
  if (modal && this._tileShapes) {
    let shape = 'square';
    try { shape = this._forumParseShape(localStorage.getItem('mediaGalleryShape')); } catch { /* storage blocked (private mode): keep the default */ }
    modal.style.setProperty('--media-shape', this._tileShapes()[shape] || '1 / 1');
  }
  const slider = document.getElementById('media-gallery-tile');
  if (slider && slider.value !== String(size)) slider.value = String(size);
  const wrap = document.getElementById('media-gallery-tile-wrap');
  const tab = this._mediaGalleryActiveTab || 'photos';
  if (wrap) wrap.hidden = tab !== 'photos' && tab !== 'videos';
},

// Build a stable key for a gallery row so the same attachment shared
// across multiple messages is treated as distinct (since each row is its
// own delete target). message_id + url is unique enough.
_mediaItemKey(it) {
  return `${it.message_id}|${it.url}`;
},

// Format bytes for the file size column / sort options. Matches the
// human-readable formatting used elsewhere for upload size hints.
_formatMediaSize(bytes) {
  const n = Number(bytes) || 0;
  if (n <= 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
},

// Apply current sort to a tab's items without mutating the source array
// (so switching sort orders doesn't permanently scramble the data).
_sortMediaItems(items) {
  const sort = this._mediaGallerySort || 'date-desc';
  const arr = items.slice();
  const cmpDate = (a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0);
  const cmpSize = (a, b) => (a.size || 0) - (b.size || 0);
  const cmpName = (a, b) => String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base', numeric: true });
  switch (sort) {
    case 'date-asc':  arr.sort(cmpDate); break;
    case 'size-asc':  arr.sort(cmpSize); break;
    case 'size-desc': arr.sort((a, b) => -cmpSize(a, b)); break;
    case 'name-asc':  arr.sort(cmpName); break;
    case 'name-desc': arr.sort((a, b) => -cmpName(a, b)); break;
    case 'date-desc':
    default:          arr.sort((a, b) => -cmpDate(a, b)); break;
  }
  return arr;
},

// Returns true if the current user can bulk-delete content in this
// channel via the gallery (admins or anyone with delete_message; we
// don't expose Select Mode for self-only deleters because the bulk
// endpoint silently skips ones they can't touch, and that's confusing).
_canBulkDeleteMedia() {
  if (!this.user) return false;
  if (this.user.isAdmin) return true;
  if (this._hasPerm && this._hasPerm('delete_message')) return true;
  if (this._hasPerm && this._hasPerm('delete_lower_messages')) return true;
  return false;
},

// Show/hide the Select + Delete bar and update the info text whenever
// selection state changes.
_refreshMediaGalleryToolbar() {
  const actions = document.getElementById('media-gallery-actions');
  const toggle  = document.getElementById('media-gallery-select-toggle');
  const selAll  = document.getElementById('media-gallery-select-all');
  const delBtn  = document.getElementById('media-gallery-delete');
  const info    = document.getElementById('media-gallery-selection-info');
  const manage  = document.getElementById('media-gallery-tagmanage');
  if (!actions || !toggle || !selAll || !delBtn || !info) return;
  const canDelete = this._canBulkDeleteMedia();
  const canTag    = this._canManageTags();
  // Select mode is available to bulk-deleters and to tag managers; each
  // capability lights up its own action, so a manager without delete rights
  // can select-and-tag without ever seeing a Delete button.
  if (!canDelete && !canTag) {
    actions.style.display = 'none';
    if (manage) manage.style.display = 'none';
    return;
  }
  actions.style.display = '';
  const selectMode = !!this._mediaGallerySelectMode;
  const count = this._mediaGallerySelected ? this._mediaGallerySelected.size : 0;
  toggle.textContent = t(selectMode ? 'media_gallery.cancel_select' : 'media_gallery.select');
  selAll.style.display = selectMode ? '' : 'none';
  delBtn.style.display = (selectMode && canDelete) ? '' : 'none';
  delBtn.disabled = count === 0;
  info.style.display = selectMode ? '' : 'none';
  info.textContent = selectMode ? t('media_gallery.selected', { count }) : '';
  if (manage) {
    manage.style.display = (selectMode && canTag && count > 0) ? '' : 'none';
    if (manage.style.display === 'none') {
      const menu = document.getElementById('media-tagmanage-menu');
      if (menu) menu.style.display = 'none';
    }
  }
},

_renderMediaGalleryTab(tab) {
  const body = document.getElementById('media-gallery-body');
  if (!body || !this._mediaGalleryData) return;
  const allItems = this._mediaGalleryData[tab] || [];
  if (allItems.length === 0) {
    const labels = {
      photos: t('media_gallery.empty_photos'),
      videos: t('media_gallery.empty_videos'),
      audios: t('media_gallery.empty_audio'),
      files:  t('media_gallery.empty_files'),
      links:  t('media_gallery.empty_links'),
    };
    body.innerHTML = `<div class="media-gallery-empty muted-text">${labels[tab] || t('media_gallery.empty')}</div>`;
    return;
  }
  // Tag filter: keep only items carrying EVERY selected tag (exact match, no
  // partials). Links have no backing upload so they are never tag-filtered.
  const rawItems = this._filterMediaItemsByTags(allItems, tab);
  if (rawItems.length === 0) {
    body.innerHTML = `<div class="media-gallery-empty muted-text">${t('media_gallery.filter_no_match')}</div>`;
    return;
  }
  const items = this._sortMediaItems(rawItems);

  const fmt = (iso) => {
    try {
      const d = new Date(iso);
      if (isNaN(d)) return '';
      return this._fmtDate(d, { year: 'numeric', month: 'short', day: 'numeric' });
    } catch { return ''; }
  };
  const esc = (s) => this._escapeHtml ? this._escapeHtml(s) : String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  // Links don't have a backing /uploads/ file we can delete from disk and
  // sit inside whatever message they were posted in (often alongside
  // unrelated text), so bulk-delete is intentionally disabled for them.
  const selectMode = !!this._mediaGallerySelectMode && tab !== 'links';
  const selected = this._mediaGallerySelected || new Map();
  const selBox = (it) => {
    if (!selectMode) return '';
    const key = this._mediaItemKey(it);
    const checked = selected.has(key) ? 'checked' : '';
    return `<label class="media-select-box" data-msg-id="${it.message_id}" data-url="${esc(it.url)}"><input type="checkbox" ${checked}></label>`;
  };
  const sizeBadge = (it) => {
    const s = this._formatMediaSize(it.size);
    return s ? `<span class="media-size-badge">${esc(s)}</span>` : '';
  };
  // Read-only tag chips shown on each tile/row (#tagging phase 3b).
  const tileTags = (it) => {
    const tags = Array.isArray(it.tags) ? it.tags : [];
    if (!tags.length) return '';
    return `<div class="media-tile-tags">${tags.map(tg => `<span class="media-tile-tag">${esc(tg)}</span>`).join('')}</div>`;
  };

  if (tab === 'photos') {
    body.innerHTML = `<div class="media-gallery-grid${selectMode ? ' select-mode' : ''}">${items.map(it => `
      <div class="media-grid-item${selected.has(this._mediaItemKey(it)) ? ' selected' : ''}" data-url="${esc(it.url)}" data-msg-id="${it.message_id}" data-action="lightbox" title="${esc(it.username || '')} • ${esc(fmt(it.created_at))}">
        ${selBox(it)}
        <img src="${esc(it.url)}" loading="lazy" alt="">
        <button class="media-grid-jump" data-action="jump" data-msg-id="${it.message_id}" title="${t('app.actions.jump_to_message')}">↗</button>
        <div class="media-grid-meta">${tileTags(it)}<div class="media-grid-date">${esc(fmt(it.created_at))}${sizeBadge(it) ? ' • ' + sizeBadge(it) : ''}</div></div>
      </div>`).join('')}</div>`;
  } else if (tab === 'videos') {
    body.innerHTML = `<div class="media-gallery-grid${selectMode ? ' select-mode' : ''}">${items.map(it => `
      <div class="media-grid-item${selected.has(this._mediaItemKey(it)) ? ' selected' : ''}" data-url="${esc(it.url)}" data-msg-id="${it.message_id}" data-action="video-lightbox" title="${esc(it.username || '')} • ${esc(fmt(it.created_at))}">
        ${selBox(it)}
        <video src="${esc(it.url)}" preload="metadata" muted></video>
        <div class="media-grid-play">▶</div>
        <button class="media-grid-jump" data-action="jump" data-msg-id="${it.message_id}" title="${t('app.actions.jump_to_message')}">↗</button>
        <div class="media-grid-meta">${tileTags(it)}<div class="media-grid-date">${esc(fmt(it.created_at))}${sizeBadge(it) ? ' • ' + sizeBadge(it) : ''}</div></div>
      </div>`).join('')}</div>`;
  } else if (tab === 'audios') {
    body.innerHTML = `<div class="media-list${selectMode ? ' select-mode' : ''}">${items.map(it => `
      <div class="media-list-item${selected.has(this._mediaItemKey(it)) ? ' selected' : ''}" data-msg-id="${it.message_id}" data-url="${esc(it.url)}">
        ${selBox(it)}
        <div class="media-list-icon">🎵</div>
        <div class="media-list-info">
          <span class="media-list-name">${esc(it.name || it.url.split('/').pop())} ${sizeBadge(it)}</span>
          <span class="media-list-meta">${esc(it.username || '')} • ${esc(fmt(it.created_at))}</span>
          <audio class="media-list-audio" src="${esc(it.url)}" controls preload="none"></audio>
          ${tileTags(it)}
        </div>
        <button class="media-list-jump" data-action="jump" data-msg-id="${it.message_id}" title="${t('app.actions.jump_to_message')}">↗</button>
      </div>`).join('')}</div>`;
  } else if (tab === 'files') {
    // In select mode, render as <div> instead of <a> so clicking the row
    // toggles selection instead of triggering the download.
    body.innerHTML = `<div class="media-list${selectMode ? ' select-mode' : ''}">${items.map(it => {
      const isSel = selected.has(this._mediaItemKey(it));
      const tag = selectMode ? 'div' : 'a';
      const linkAttrs = selectMode ? '' : ` href="${esc(it.url)}" download target="_blank" rel="noopener"`;
      return `
      <${tag} class="media-list-item${isSel ? ' selected' : ''}" data-msg-id="${it.message_id}" data-url="${esc(it.url)}"${linkAttrs}>
        ${selBox(it)}
        <div class="media-list-icon">📄</div>
        <div class="media-list-info">
          <span class="media-list-name">${esc(it.name || it.url.split('/').pop())} ${sizeBadge(it)}</span>
          <span class="media-list-meta">${esc(it.username || '')} • ${esc(fmt(it.created_at))}</span>
          ${tileTags(it)}
        </div>
        <button class="media-list-jump" data-action="jump" data-msg-id="${it.message_id}" title="${t('app.actions.jump_to_message')}">↗</button>
      </${tag}>`;
    }).join('')}</div>`;
  } else if (tab === 'links') {
    body.innerHTML = `<div class="media-list">${items.map(it => {
      let host = '';
      try { host = new URL(it.url).hostname; } catch { /* not a full address: no host shown */ }
      return `
      <a class="media-list-item" href="${esc(it.url)}" target="_blank" rel="noopener noreferrer nofollow">
        <div class="media-list-icon">🔗</div>
        <div class="media-list-info">
          <span class="media-list-name">${esc(host || it.url)}</span>
          <span class="media-list-meta">${esc(it.url)}</span>
          <span class="media-list-meta">${esc(it.username || '')} • ${esc(fmt(it.created_at))}</span>
        </div>
        <button class="media-list-jump" data-action="jump" data-msg-id="${it.message_id}" title="${t('app.actions.jump_to_message')}">↗</button>
      </a>`;
    }).join('')}</div>`;
  }

  // Selection checkbox + row-click toggling (only active when in select
  // mode). We let users click anywhere on the tile/row to toggle, but
  // suppress the lightbox/download/jump actions during selection.
  if (selectMode) {
    body.querySelectorAll('.media-select-box').forEach(box => {
      box.addEventListener('click', (e) => {
        e.stopPropagation();
      });
      const cb = box.querySelector('input[type="checkbox"]');
      if (cb) cb.addEventListener('change', () => {
        const msgId = parseInt(box.dataset.msgId);
        const url = box.dataset.url;
        const key = `${msgId}|${url}`;
        if (cb.checked) this._mediaGallerySelected.set(key, { message_id: msgId, url });
        else this._mediaGallerySelected.delete(key);
        const item = box.closest('.media-grid-item, .media-list-item');
        if (item) item.classList.toggle('selected', cb.checked);
        this._refreshMediaGalleryToolbar();
      });
    });
    body.querySelectorAll('.media-grid-item, .media-list-item').forEach(el => {
      el.addEventListener('click', (e) => {
        // Only react to bare row clicks, not clicks on the checkbox label
        // itself (handled above) or on inner controls.
        if (e.target.closest('.media-select-box') || e.target.closest('[data-action="jump"]') ||
            e.target.tagName === 'AUDIO' || e.target.tagName === 'VIDEO' || e.target.tagName === 'INPUT') return;
        const cb = el.querySelector('.media-select-box input[type="checkbox"]');
        if (cb) { cb.checked = !cb.checked; cb.dispatchEvent(new Event('change')); }
        e.preventDefault();
        e.stopPropagation();
      }, true);
    });
  } else {
    // Normal click behavior (lightbox, video preview, jump-to-message)
    body.querySelectorAll('[data-action="lightbox"]').forEach(el => {
      el.addEventListener('click', () => {
        const url = el.dataset.url;
        if (url && this._openLightbox) this._openLightbox(url);
      });
    });
    body.querySelectorAll('[data-action="video-lightbox"]').forEach(el => {
      el.addEventListener('click', (e) => {
        // Avoid triggering when the user clicks the inner jump button
        if (e.target.closest('[data-action="jump"]')) return;
        const url = el.dataset.url;
        if (url) this._openVideoLightbox(url);
      });
    });
  }
  body.querySelectorAll('[data-action="jump"]').forEach(el => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const id = parseInt(el.dataset.msgId);
      if (!id) return;
      document.getElementById('media-gallery-modal').style.display = 'none';
      if (this._jumpToMessage) this._jumpToMessage(id);
    });
  });
},

// ── Media gallery tag filter + bulk management (#tagging phase 3b) ──────

// True when the user may curate tags (admin or manage_tags). Gates the bulk
// "Manage tags" dropdown and lets such users enter select mode for tagging
// even without delete rights.
_canManageTags() {
  if (!this.user) return false;
  if (this.user.isAdmin) return true;
  return !!(this._hasPerm && this._hasPerm('manage_tags'));
},

// Keep only items carrying every selected filter tag (case-folded exact
// match). Links are never tag-filtered (no backing upload).
_filterMediaItemsByTags(items, tab) {
  const filter = this._mediaTagFilter || [];
  if (!filter.length || tab === 'links') return items;
  const want = filter.map(n => String(n).toLocaleLowerCase());
  return items.filter(it => {
    const have = new Set((it.tags || []).map(x => String(x).toLocaleLowerCase()));
    return want.every(w => have.has(w));
  });
},

_updateTagFilterBadge() {
  const badge = document.getElementById('media-gallery-tagfilter-count');
  const btn = document.getElementById('media-gallery-tagfilter-btn');
  const n = (this._mediaTagFilter || []).length;
  if (badge) { badge.style.display = n ? '' : 'none'; badge.textContent = String(n); }
  if (btn) btn.classList.toggle('is-active', n > 0);
},

_afterTagFilterChange() {
  this._updateTagFilterBadge();
  if (this._mediaGalleryData) this._renderMediaGalleryTab(this._mediaGalleryActiveTab || 'photos');
},

_toggleMediaTagFilter(name) {
  const filter = this._mediaTagFilter || (this._mediaTagFilter = []);
  const norm = String(name).toLocaleLowerCase();
  const idx = filter.findIndex(x => String(x).toLocaleLowerCase() === norm);
  if (idx >= 0) filter.splice(idx, 1); else filter.push(name);
  this._afterTagFilterChange();
},

_closeMediaTagFilter() {
  clearTimeout(this._mtfTimer);
  document.getElementById('media-tag-filter-popup')?.remove();
  if (this._mtfCloser) { document.removeEventListener('click', this._mtfCloser, true); this._mtfCloser = null; }
},

_openMediaTagFilter(anchor) {
  this._closeMediaTagFilter();
  if (!this._mediaTagFilter) this._mediaTagFilter = [];
  const pop = document.createElement('div');
  pop.id = 'media-tag-filter-popup';
  pop.className = 'tag-editor-popup';
  pop.innerHTML = `
    <div class="tag-editor-head">
      <span class="tag-editor-title">${t('media_gallery.filter_by_tag')}</span>
      <button type="button" class="tag-editor-close" aria-label="${this._escapeHtml(t('modals.common.close'))}">×</button>
    </div>
    <input id="mtf-input" class="tag-popup-input" type="text" autocomplete="off" spellcheck="false"
           maxlength="${this._maxTagLen()}" placeholder="${this._escapeHtml(t('tags.search_placeholder'))}">
    <div id="mtf-list" class="tag-popup-list"></div>`;
  document.body.appendChild(pop);
  const rect = (anchor || document.body).getBoundingClientRect();
  pop.style.left = Math.min(rect.left, window.innerWidth - pop.offsetWidth - 12) + 'px';
  pop.style.top = Math.min(rect.bottom + 4, window.innerHeight - pop.offsetHeight - 12) + 'px';
  pop.querySelector('.tag-editor-close').addEventListener('click', () => this._closeMediaTagFilter());
  const input = pop.querySelector('#mtf-input');
  input.addEventListener('input', () => {
    clearTimeout(this._mtfTimer);
    const q = input.value;
    this._mtfTimer = setTimeout(() => this._mediaTagFilterSearch(q), 250);
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); this._closeMediaTagFilter(); } });
  this._mtfCloser = (ev) => {
    if (!pop.contains(ev.target) && ev.target !== anchor && !anchor.contains(ev.target)) this._closeMediaTagFilter();
  };
  setTimeout(() => document.addEventListener('click', this._mtfCloser, true), 0);
  this._mediaTagFilterSearch('');
  input.focus();
},

_mediaTagFilterSearch(query) {
  const input = document.getElementById('mtf-input');
  if (!input || !this.socket) return;
  const q = query;
  this.socket.emit('search-upload-tags', { query: q }, (res) => {
    if (input.value !== q) return;
    if (res && res.error === 'rate_limited') return;
    this._mediaTagFilterRenderList((res && res.tags) || []);
  });
},

_mediaTagFilterRenderList(results) {
  const list = document.getElementById('mtf-list');
  if (!list) return;
  list.innerHTML = '';
  const filter = this._mediaTagFilter || (this._mediaTagFilter = []);
  const active = new Set(filter.map(x => String(x).toLocaleLowerCase()));
  if (filter.length) {
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'tag-popup-item tag-popup-create';
    clear.textContent = t('media_gallery.filter_clear');
    clear.addEventListener('click', () => {
      this._mediaTagFilter = [];
      this._afterTagFilterChange();
      this._mediaTagFilterRenderList(results);
    });
    list.appendChild(clear);
  }
  (results || []).forEach(tg => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'tag-popup-item';
    const on = active.has(String(tg.name).toLocaleLowerCase());
    if (on) item.classList.add('is-active');
    item.textContent = (on ? '✓ ' : '') + tg.name;
    item.addEventListener('click', () => {
      this._toggleMediaTagFilter(tg.name);
      this._mediaTagFilterRenderList(results);
    });
    list.appendChild(item);
  });
  if (!list.children.length) {
    const empty = document.createElement('div');
    empty.className = 'tag-popup-empty';
    empty.textContent = t('tags.none_yet');
    list.appendChild(empty);
  }
},

// Distinct message ids among the current selection (one edit per message).
_mediaSelectedMessageIds() {
  const ids = [];
  if (!this._mediaGallerySelected) return ids;
  for (const { message_id } of this._mediaGallerySelected.values()) {
    if (!ids.includes(message_id)) ids.push(message_id);
  }
  return ids;
},

// Confirm-gated bulk tag picker: nothing is applied until Confirm (clicking
// away discards). `mode` is 'append' or 'replace'.
_openMediaTagManage(mode) {
  this._closeMediaTagManage();
  const ids = this._mediaSelectedMessageIds();
  if (!ids.length) return;
  this._mediaTagManage = { mode, tags: [] };
  const titleKey = mode === 'replace' ? 'media_gallery.tag_apply_replace' : 'media_gallery.tag_apply_append';
  const pop = document.createElement('div');
  pop.id = 'media-tag-manage-popup';
  pop.className = 'tag-editor-popup';
  pop.innerHTML = `
    <div class="tag-editor-head">
      <span class="tag-editor-title">${this._escapeHtml(t(titleKey, { count: ids.length }))}</span>
      <button type="button" class="tag-editor-close" aria-label="${this._escapeHtml(t('modals.common.close'))}">×</button>
    </div>
    <div class="tag-editor-chips" id="mtm-chips"></div>
    <input id="mtm-input" class="tag-popup-input" type="text" autocomplete="off" spellcheck="false"
           maxlength="${this._maxTagLen()}" placeholder="${this._escapeHtml(t('tags.search_placeholder'))}">
    <div id="mtm-list" class="tag-popup-list"></div>
    <div class="tag-manage-actions">
      <button type="button" class="btn-sm btn-accent" id="mtm-confirm">${this._escapeHtml(t('media_gallery.tag_apply_confirm'))}</button>
    </div>`;
  document.body.appendChild(pop);
  const anchor = document.getElementById('media-gallery-tagmanage-btn') || document.body;
  const rect = anchor.getBoundingClientRect();
  pop.style.left = Math.min(rect.left, window.innerWidth - pop.offsetWidth - 12) + 'px';
  pop.style.top = Math.min(rect.bottom + 4, window.innerHeight - pop.offsetHeight - 12) + 'px';
  pop.querySelector('.tag-editor-close').addEventListener('click', () => this._closeMediaTagManage());
  const input = pop.querySelector('#mtm-input');
  input.addEventListener('input', () => {
    clearTimeout(this._mtmTimer);
    const q = input.value;
    this._mtmTimer = setTimeout(() => this._mediaTagManageSearch(q), 250);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); this._closeMediaTagManage(); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const first = pop.querySelector('#mtm-list .tag-popup-item');
      if (first) first.click();
    }
  });
  pop.querySelector('#mtm-confirm').addEventListener('click', () => this._mediaTagManageApply());
  // Clicking away discards (except the confirm modal overlay it may spawn).
  this._mtmCloser = (ev) => {
    if (ev.target.closest('.modal-overlay')) return;
    if (!pop.contains(ev.target) && !ev.target.closest('#media-gallery-tagmanage')) this._closeMediaTagManage();
  };
  setTimeout(() => document.addEventListener('click', this._mtmCloser, true), 0);
  this._mediaTagManageRenderChips();
  this._mediaTagManageSearch('');
  input.focus();
},

_closeMediaTagManage() {
  clearTimeout(this._mtmTimer);
  document.getElementById('media-tag-manage-popup')?.remove();
  if (this._mtmCloser) { document.removeEventListener('click', this._mtmCloser, true); this._mtmCloser = null; }
  this._mediaTagManage = null;
},

_mediaTagManageRenderChips() {
  const wrap = document.getElementById('mtm-chips');
  if (!wrap || !this._mediaTagManage) return;
  wrap.innerHTML = '';
  this._mediaTagManage.tags.forEach(name => {
    const chip = document.createElement('span');
    chip.className = 'tag-chip';
    const label = document.createElement('span');
    label.className = 'tag-chip-label';
    label.textContent = name;
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'tag-chip-remove';
    rm.textContent = '×';
    rm.addEventListener('click', () => this._mediaTagManageRemove(name));
    chip.appendChild(label);
    chip.appendChild(rm);
    wrap.appendChild(chip);
  });
},

_mediaTagManageSearch(query) {
  const input = document.getElementById('mtm-input');
  if (!input || !this.socket || !this._mediaTagManage) return;
  const q = query;
  this.socket.emit('search-upload-tags', { query: q }, (res) => {
    if (!this._mediaTagManage || input.value !== q) return;
    if (res && res.error === 'rate_limited') return;
    this._mediaTagManageRenderList(q, (res && res.tags) || []);
  });
},

_mediaTagManageRenderList(query, results) {
  const list = document.getElementById('mtm-list');
  if (!list || !this._mediaTagManage) return;
  list.innerHTML = '';
  const applied = new Set(this._mediaTagManage.tags.map(x => x.toLocaleLowerCase()));
  const norm = this._normalizeTag(query);
  (results || []).filter(tg => !applied.has(String(tg.name).toLocaleLowerCase())).forEach(tg => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'tag-popup-item';
    item.textContent = tg.name;
    item.addEventListener('click', () => this._mediaTagManageAdd(tg.name));
    list.appendChild(item);
  });
  const exact = norm && (applied.has(norm.norm) || (results || []).some(tg => String(tg.name).toLocaleLowerCase() === norm.norm));
  if (norm && !exact && this._canManageTags()) {
    const create = document.createElement('button');
    create.type = 'button';
    create.className = 'tag-popup-item tag-popup-create';
    create.textContent = t('tags.add_new', { name: norm.name });
    create.addEventListener('click', () => this._mediaTagManageAdd(norm.name));
    list.appendChild(create);
  }
  if (!list.children.length) {
    const empty = document.createElement('div');
    empty.className = 'tag-popup-empty';
    empty.textContent = norm ? t('tags.none_found') : t('tags.none_yet');
    list.appendChild(empty);
  }
},

_mediaTagManageAdd(rawName) {
  if (!this._mediaTagManage) return;
  const norm = this._normalizeTag(rawName);
  if (!norm) return this._showToast?.(t('tags.invalid'), 'error');
  const tags = this._mediaTagManage.tags;
  if (tags.some(x => x.toLocaleLowerCase() === norm.norm)) return;
  if (tags.length >= this._maxTagsPerAttachment()) {
    return this._showToast?.(t('tags.limit_reached', { n: this._maxTagsPerAttachment() }), 'error');
  }
  tags.push(norm.name);
  const input = document.getElementById('mtm-input');
  if (input) input.value = '';
  this._mediaTagManageRenderChips();
  this._mediaTagManageSearch('');
},

_mediaTagManageRemove(name) {
  if (!this._mediaTagManage) return;
  this._mediaTagManage.tags = this._mediaTagManage.tags.filter(x => x !== name);
  this._mediaTagManageRenderChips();
  this._mediaTagManageSearch(document.getElementById('mtm-input')?.value || '');
},

// Apply the working set to every selected message. Replace with an empty set
// wipes all tags, so it gets a second explicit confirmation.
_mediaTagManageApply() {
  const st = this._mediaTagManage;
  if (!st || !this.currentChannel || !this.socket) return;
  const ids = this._mediaSelectedMessageIds();
  if (!ids.length) { this._closeMediaTagManage(); return; }
  const mode = st.mode;
  const tags = st.tags.slice();

  const doEmit = () => {
    this.socket.emit('bulk-tag-messages', { code: this.currentChannel, messageIds: ids, mode, tags }, (res) => {
      if (!res || res.error) {
        this._showToast?.(res && res.error ? res.error : t('media_gallery.tags_update_failed'), 'error');
        return;
      }
      // Optimistically reflect each message's new set in the gallery data so
      // chips update without a full refetch (keeps the current selection).
      const byId = new Map((res.results || []).map(r => [r.messageId, r.tags || []]));
      if (this._mediaGalleryData) {
        ['photos', 'videos', 'audios', 'files'].forEach(k => {
          (this._mediaGalleryData[k] || []).forEach(it => {
            if (byId.has(it.message_id)) {
              const tg = byId.get(it.message_id);
              if (tg.length) it.tags = tg; else delete it.tags;
            }
          });
        });
      }
      this._showToast?.(t('media_gallery.tags_updated', { count: res.updated || 0 }), 'info');
      this._closeMediaTagManage();
      this._renderMediaGalleryTab(this._mediaGalleryActiveTab || 'photos');
    });
  };

  if (mode === 'replace' && tags.length === 0) {
    this._showConfirmModal(
      t('media_gallery.confirm_clear_title'),
      t('media_gallery.confirm_clear_body', { count: ids.length }),
      { danger: true, confirmLabel: t('media_gallery.confirm_clear_ok') }
    ).then(ok => { if (ok) doEmit(); });
    return;
  }
  doEmit();
},

// Lightbox-style overlay that plays a video (used by the media gallery
// videos tab). Mirrors the image lightbox structure so it sits above any
// modal overlays via the same z-index strategy.
_openVideoLightbox(src) {
  // Tear down any existing
  const old = document.getElementById('video-lightbox');
  if (old) old.remove();

  const overlay = document.createElement('div');
  overlay.id = 'video-lightbox';
  overlay.className = 'image-lightbox';
  overlay.innerHTML = `
    <video class="lightbox-video" src="${this._escapeHtml(src)}" controls autoplay playsinline></video>
  `;
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      const v = overlay.querySelector('video');
      if (v) { v.pause(); }
      overlay.remove();
    }
  });
  const closeOnEsc = (e) => {
    if (e.key === 'Escape') {
      const v = overlay.querySelector('video');
      if (v) { v.pause(); }
      overlay.remove();
      document.removeEventListener('keydown', closeOnEsc);
    }
  };
  document.addEventListener('keydown', closeOnEsc);
  document.body.appendChild(overlay);
},

};
