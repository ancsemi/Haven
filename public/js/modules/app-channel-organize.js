// Arranging channels: the sub-channel panel, moving a channel under another
// or back to the top, the Organize windows for channels and DMs, and the
// channel webhooks list.

export default {

/* ── Sub-channel Subscriptions Panel ──────────────────── */

_openSubChannelPanel() {
  const modal = document.getElementById('sub-panel-modal');
  if (!modal) return;

  // Run one-time migration: muted sub-channels → unsubbed, others → subbed
  if (!localStorage.getItem('haven_sub_panel_migrated')) {
    localStorage.setItem('haven_sub_panel_migrated', 'true');
    // Existing muted list already represents unsubbed state — no changes needed.
    // All non-muted channels are implicitly subscribed.
  }

  this._renderSubChannelPanel();
  modal.style.display = 'flex';

  // Close handlers
  const closeHandler = () => {
    modal.style.display = 'none';
    modal.removeEventListener('click', overlayHandler);
  };
  const overlayHandler = (e) => { if (e.target === modal) closeHandler(); };
  modal.addEventListener('click', overlayHandler);
},

_renderSubChannelPanel() {
  const container = document.getElementById('sub-panel-content');
  if (!container) return;
  container.innerHTML = '';

  const muted = JSON.parse(localStorage.getItem('haven_muted_channels') || '[]');
  const regularChannels = (this.channels || []).filter(c => !c.is_dm);
  const subChannels = regularChannels.filter(c => c.parent_channel_id);

  if (!subChannels.length) {
    container.innerHTML = `<p style="text-align:center;opacity:0.5;padding:24px">${t('channels.no_sub_channels')}</p>`;
    return;
  }

  // Group sub-channels by parent
  const parentMap = {};
  subChannels.forEach(sub => {
    if (!parentMap[sub.parent_channel_id]) parentMap[sub.parent_channel_id] = [];
    parentMap[sub.parent_channel_id].push(sub);
  });

  // Sort parents by position/name
  const parentIds = Object.keys(parentMap).map(Number);
  const parentChannels = parentIds.map(id => regularChannels.find(c => c.id === id)).filter(Boolean);
  parentChannels.sort((a, b) => (a.position || 0) - (b.position || 0) || a.name.localeCompare(b.name));

  parentChannels.forEach(parent => {
    const subs = parentMap[parent.id] || [];
    // Split into subscribed (not muted) and unsubscribed (muted)
    const subbed = subs.filter(s => !muted.includes(s.code));
    const unsubbed = subs.filter(s => muted.includes(s.code));

    const section = document.createElement('div');
    section.className = 'sub-panel-parent-section';

    const header = document.createElement('h4');
    header.className = 'sub-panel-parent-header';
    header.textContent = `# ${parent.name}`;
    section.appendChild(header);

    // Render subbed tiles first, then a divider, then unsubbed
    if (subbed.length) {
      const subbedLabel = document.createElement('div');
      subbedLabel.className = 'sub-panel-group-label';
      subbedLabel.textContent = t('channels.subscribed');
      section.appendChild(subbedLabel);
      const subbedGrid = document.createElement('div');
      subbedGrid.className = 'sub-panel-grid';
      subbed.forEach(ch => subbedGrid.appendChild(this._createSubPanelTile(ch, true)));
      section.appendChild(subbedGrid);
    }

    if (unsubbed.length) {
      const unsubbedLabel = document.createElement('div');
      unsubbedLabel.className = 'sub-panel-group-label unsubbed';
      unsubbedLabel.textContent = t('channels.unsubscribed');
      section.appendChild(unsubbedLabel);
      const unsubbedGrid = document.createElement('div');
      unsubbedGrid.className = 'sub-panel-grid';
      unsubbed.forEach(ch => unsubbedGrid.appendChild(this._createSubPanelTile(ch, false)));
      section.appendChild(unsubbedGrid);
    }

    container.appendChild(section);
  });
},

_createSubPanelTile(ch, isSubbed) {
  const tile = document.createElement('div');
  tile.className = 'sub-panel-tile' + (isSubbed ? ' subbed' : ' unsubbed');
  tile.dataset.code = ch.code;

  const unread = this.unreadCounts[ch.code] || 0;
  const unreadBadge = unread > 0 ? `<span class="sub-panel-badge">${unread > 99 ? '99+' : unread}</span>` : '';

  tile.innerHTML = `
    <label class="sub-panel-toggle" title="${isSubbed ? t('channels.unsubscribe_hint') : t('channels.subscribe_hint')}">
      <input type="checkbox" ${isSubbed ? 'checked' : ''}>
      <span class="sub-panel-toggle-label">${isSubbed ? '🔔' : '🔕'}</span>
    </label>
    <span class="sub-panel-tile-name">${ch.is_private ? '🔒 ' : ''}${this._escapeHtml(ch.name)}</span>
    ${unreadBadge}
  `;

  // Toggle sub/unsub
  const checkbox = tile.querySelector('input[type="checkbox"]');
  checkbox.addEventListener('change', (e) => {
    e.stopPropagation();
    const muted = JSON.parse(localStorage.getItem('haven_muted_channels') || '[]');
    const idx = muted.indexOf(ch.code);
    if (checkbox.checked) {
      // Subscribe: remove from muted
      if (idx >= 0) muted.splice(idx, 1);
      this._showToast(t('channels.subscribed_to', { name: ch.name }), 'success');
    } else {
      // Unsubscribe: add to muted
      if (idx < 0) muted.push(ch.code);
      this._showToast(t('channels.unsubscribed_from', { name: ch.name }), 'success');
    }
    localStorage.setItem('haven_muted_channels', JSON.stringify(muted));
    this._syncChannelMutePref(ch.code, !checkbox.checked);
    // Re-render the panel and sidebar
    this._renderSubChannelPanel();
    this._renderChannels();
  });

  // Click tile (not checkbox) to jump to channel
  tile.addEventListener('click', (e) => {
    if (e.target.closest('.sub-panel-toggle')) return; // Don't navigate when toggling checkbox
    document.getElementById('sub-panel-modal').style.display = 'none';
    this.switchChannel(ch.code);
  });

  return tile;
},

/* ── Re-parent channel modal (move to / promote) ───── */

/**
 * Top-level channels `ch` may legitimately be moved under. (#5492) Filtered to
 * the ones this user can actually manage, so the picker stops offering
 * destinations the server is only going to refuse.
 */
_reparentTargets(ch) {
  const isAdmin = !!(this.user && this.user.isAdmin);
  return this.channels.filter(c =>
    !c.is_dm &&
    !c.parent_channel_id &&          // Must be a top-level channel
    c.id !== ch.id &&                 // Can't parent under self
    c.id !== ch.parent_channel_id &&  // Skip current parent (already there)
    (isAdmin || c.canManageSubs)      // Must be a parent we may add a child to
  ).sort((a, b) => (a.position || 0) - (b.position || 0));
},

_openReparentModal(code) {
  const ch = this.channels.find(c => c.code === code);
  if (!ch) return;

  const titleEl = document.getElementById('reparent-modal-title');
  const descEl = document.getElementById('reparent-modal-desc');
  const listEl = document.getElementById('reparent-channel-list');

  titleEl.textContent = `📦 ${t('channels.move_channel')}`;
  descEl.textContent = t('channels.move_channel_desc', { name: ch.name });

  // Build list of valid parent targets (top-level channels that aren't this one)
  const targets = this._reparentTargets(ch);

  let html = '';

  // If currently a sub-channel, show "Promote to top-level" option at the top
  if (ch.parent_channel_id) {
    html += `<div class="organize-item reparent-option" data-target="__top__" style="border-bottom:1px solid rgba(255,255,255,0.08);margin-bottom:4px;padding-bottom:8px">
      <span style="opacity:0.5">⬆️</span>
      <span style="flex:1"><strong>${t('channels.promote_to_top_level')}</strong></span>
    </div>`;
  }

  for (const tgt of targets) {
    const subCount = this.channels.filter(c => c.parent_channel_id === tgt.id).length;
    const badge = subCount > 0 ? ` <span style="opacity:0.4;font-size:0.8em">${t('channels.sub_ch_count', { count: subCount })}</span>` : '';
    html += `<div class="organize-item reparent-option" data-target="${tgt.code}">
      <span style="opacity:0.5">#</span>
      <span style="flex:1">${this._escapeHtml(tgt.name)}${badge}</span>
    </div>`;
  }

  if (!targets.length && !ch.parent_channel_id) {
    html += `<p style="text-align:center;opacity:0.5;padding:16px;font-size:0.85rem">${t('channels.no_valid_parents')}</p>`;
  }

  listEl.innerHTML = html;

  // Wire up click handlers on the targets
  listEl.querySelectorAll('.reparent-option').forEach(el => {
    el.addEventListener('click', () => {
      const target = el.dataset.target;
      const newParentCode = target === '__top__' ? null : target;
      const action = newParentCode === null
        ? t('channels.confirm_promote', { name: ch.name })
        : t('channels.confirm_move', { name: ch.name, parent: this.channels.find(c => c.code === newParentCode)?.name || target });
      if (confirm(action)) {
        this.socket.emit('reparent-channel', { code, newParentCode });
        document.getElementById('reparent-modal').style.display = 'none';
      }
    });
  });

  document.getElementById('reparent-modal').style.display = 'flex';
},

/* ── Organize sub-channels modal ─────────────────────── */

_openOrganizeModal(parentCode, serverLevel) {
  if (serverLevel) {
    // Server-level mode: organize top-level channels
    const parents = this.channels.filter(c => !c.parent_channel_id && !c.is_dm);
    this._organizeParentCode = '__server__';
    this._organizeParentId = null;
    this._organizeServerLevel = true;
    this._organizeList = [...parents].sort((a, b) => (a.position || 0) - (b.position || 0));
    this._organizeSelected = null;
    this._organizeSelectedTag = null;
    this._organizeTagSorts = JSON.parse(localStorage.getItem('haven_tag_sorts___server__') || this.serverSettings?.channel_tag_sorts || '{}');
    this._organizeCatOrder = JSON.parse(localStorage.getItem('haven_cat_order___server__') || this.serverSettings?.channel_cat_order || '[]');
    this._organizeCatSort = localStorage.getItem('haven_cat_sort___server__') || this.serverSettings?.channel_cat_sort || 'az';

    document.getElementById('organize-modal-title').textContent = `📋 ${t('channels.organize_channels')}`;
    document.getElementById('organize-modal-parent-name').textContent = t('channels.organize_desc');
    // Server-level sort: check for personal override, else use server default
    const sortSel = document.getElementById('organize-global-sort');
    const localOverride = localStorage.getItem('haven_server_sort_mode');
    sortSel.value = localOverride || 'server_default';
    const catSortSel = document.getElementById('organize-cat-sort');
    if (catSortSel) catSortSel.value = this._organizeCatSort;
    document.getElementById('organize-tag-input').value = '';
    const backBtn = document.getElementById('organize-back-btn');
    if (backBtn) backBtn.style.display = 'none';
    // Hide admin-only controls (move/tag) for non-admin users at server level
    const canManage = this.user?.isAdmin || this._hasPerm('manage_server') || this._hasPerm('create_channel');
    document.querySelector('.organize-controls')?.style.setProperty('display', canManage ? '' : 'none');
    this._renderOrganizeList();
    document.getElementById('organize-modal').style.display = 'flex';
    return;
  }

  const parent = this.channels.find(c => c.code === parentCode);
  if (!parent) return;

  const subs = this.channels.filter(c => c.parent_channel_id === parent.id);
  this._organizeParentCode = parentCode;
  this._organizeParentId = parent.id;
  this._organizeServerLevel = false;
  this._organizeList = [...subs].sort((a, b) => (a.position || 0) - (b.position || 0));
  this._organizeSelected = null;
  this._organizeSelectedTag = null;
  // Per-tag sort overrides: tag → 'manual'|'alpha'|'created'|'oldest' (persisted in localStorage)
  this._organizeTagSorts = JSON.parse(localStorage.getItem(`haven_tag_sorts_${parentCode}`) || '{}');
  this._organizeCatOrder = JSON.parse(localStorage.getItem(`haven_cat_order_${parentCode}`) || '[]');
  this._organizeCatSort = localStorage.getItem(`haven_cat_sort_${parentCode}`) || 'az';

  document.getElementById('organize-modal-title').textContent = `📋 ${t('channels.organize_sub_channels')}`;
  document.getElementById('organize-modal-parent-name').textContent = `# ${parent.name}`;
  // Map sort_alphabetical: 0=manual, 1=alpha, 2=created
  const sortSel = document.getElementById('organize-global-sort');
  sortSel.value = parent.sort_alphabetical === 1 ? 'alpha' : parent.sort_alphabetical === 2 ? 'created' : parent.sort_alphabetical === 3 ? 'oldest' : parent.sort_alphabetical === 4 ? 'dynamic' : 'manual';
  const catSortSel = document.getElementById('organize-cat-sort');
  if (catSortSel) catSortSel.value = this._organizeCatSort;
  document.getElementById('organize-tag-input').value = '';
  const backBtn = document.getElementById('organize-back-btn');
  if (backBtn) {
    backBtn.style.display = '';
    // Replace listener with a fresh one each time
    const newBtn = backBtn.cloneNode(true);
    backBtn.parentNode.replaceChild(newBtn, backBtn);
    newBtn.addEventListener('click', () => this._openOrganizeModal(null, true));
  }
  // Sub-channel organize: always show controls (already permission-gated by context menu)
  document.querySelector('.organize-controls')?.style.setProperty('display', '');
  this._renderOrganizeList();
  document.getElementById('organize-modal').style.display = 'flex';
},

_renderOrganizeList() {
  const listEl = document.getElementById('organize-channel-list');
  let globalSort = document.getElementById('organize-global-sort').value;
  // Resolve "server_default" to the actual server sort mode
  if (globalSort === 'server_default') globalSort = this.serverSettings?.channel_sort_mode || 'manual';

  let displayList = [...(this._organizeList || [])];

  // Collect unique tags (case-insensitive dedup, keep first-seen casing)
  const _orgTagMap = new Map();
  displayList.filter(c => c.category).forEach(c => {
    const key = c.category.toLowerCase();
    if (!_orgTagMap.has(key)) _orgTagMap.set(key, c.category);
  });
  const realTags = [..._orgTagMap.values()];
  const hasUntagged = displayList.some(c => !c.category);
  const hasTags = realTags.length > 0;
  // Build the full ordered keys list: real tags + __untagged__ (if applicable)
  const allKeys = [...realTags];
  if (hasUntagged && hasTags) allKeys.push('__untagged__');

  // Show/hide category toolbar
  const catToolbar = document.getElementById('organize-cat-toolbar');
  if (catToolbar) catToolbar.style.display = hasTags ? 'flex' : 'none';

  // Sort category headers by chosen mode
  const catSort = this._organizeCatSort || 'az';
  if (catSort === 'az') {
    allKeys.sort((a, b) => {
      if (a === '__untagged__') return 1; if (b === '__untagged__') return -1;
      return a.localeCompare(b);
    });
  } else if (catSort === 'za') {
    allKeys.sort((a, b) => {
      if (a === '__untagged__') return 1; if (b === '__untagged__') return -1;
      return b.localeCompare(a);
    });
  } else {
    // manual — use stored order
    const order = this._organizeCatOrder || [];
    allKeys.sort((a, b) => {
      const ia = order.indexOf(a);
      const ib = order.indexOf(b);
      if (ia === -1 && ib === -1) {
        if (a === '__untagged__') return 1; if (b === '__untagged__') return -1;
        return a.localeCompare(b);
      }
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    });
  }

  // Sort within each tag group
  const sortGroup = (arr, mode) => {
    if (mode === 'alpha') {
      arr.sort((a, b) => a.name.localeCompare(b.name));
    } else if (mode === 'created') {
      arr.sort((a, b) => (b.id || 0) - (a.id || 0)); // Higher ID = newer
    } else if (mode === 'oldest') {
      arr.sort((a, b) => (a.id || 0) - (b.id || 0)); // Lower ID = older
    } else if (mode === 'dynamic') {
      arr.sort((a, b) => (b.latestMessageId || 0) - (a.latestMessageId || 0)); // Most recent activity first
    } else {
      arr.sort((a, b) => (a.position || 0) - (b.position || 0));
    }
    return arr;
  };

  // Build grouped display
  let grouped = [];
  if (hasTags) {
    for (const key of allKeys) {
      if (key === '__untagged__') {
        const untagged = displayList.filter(c => !c.category);
        if (untagged.length) {
          const untaggedSort = this._organizeTagSorts['__untagged__'] || globalSort;
          grouped.push({ tag: '', items: sortGroup(untagged, untaggedSort), sort: untaggedSort });
        }
      } else {
        const tagSort = this._organizeTagSorts[key] || globalSort;
        const keyLower = key.toLowerCase();
        const tagItems = sortGroup(displayList.filter(c => c.category && c.category.toLowerCase() === keyLower), tagSort);
        grouped.push({ tag: key, items: tagItems, sort: tagSort });
      }
    }
  } else {
    grouped.push({ tag: '', items: sortGroup(displayList, globalSort), sort: globalSort });
  }

  let html = '';
  for (const group of grouped) {
    // Tag header
    if (hasTags) {
      const tagKey = group.tag || '__untagged__';
      const label = group.tag ? this._escapeHtml(group.tag) : t('channels.untagged');
      const isTagSelected = this._organizeSelectedTag === tagKey;
      html += `<div class="organize-tag-header${isTagSelected ? ' selected' : ''}" data-tag-key="${this._escapeHtml(tagKey)}" draggable="true">
        <span class="organize-tag-drag" title="${t('channels.drag_to_reorder')}">⋮⋮</span>
        <span>${label}</span>
        <select class="tag-sort-select" data-tag="${this._escapeHtml(tagKey)}" title="${t('channels.sort_group')}" draggable="false">
          <option value="manual"${group.sort === 'manual' ? ' selected' : ''}>${t('channels.sort.manual')}</option>
          <option value="alpha"${group.sort === 'alpha' ? ' selected' : ''}>${t('channels.sort.alpha')}</option>
          <option value="created"${group.sort === 'created' ? ' selected' : ''}>${t('channels.sort.newest')}</option>
          <option value="oldest"${group.sort === 'oldest' ? ' selected' : ''}>${t('channels.sort.oldest')}</option>
          <option value="dynamic"${group.sort === 'dynamic' ? ' selected' : ''}>${t('channels.sort.dynamic')}</option>
        </select>
      </div>`;
    }

    for (const ch of group.items) {
      const sel = this._organizeSelected === ch.code;
      const tagBadge = ch.category ? `<span class="organize-tag-badge">${this._escapeHtml(ch.category)}</span>` : '';
      const icon = this._organizeServerLevel ? '#' : (ch.is_private ? '🔒' : '↳');
      const hasSubs = this._organizeServerLevel && this.channels.some(c => c.parent_channel_id === ch.id);
      const drillHint = hasSubs ? `<span class="organize-drill-hint" title="${t('channels.drill_hint')}">▶</span>` : '';
      html += `<div class="organize-item${sel ? ' selected' : ''}${hasSubs ? ' organize-has-subs' : ''}" data-code="${ch.code}">
        <span style="opacity:0.5">${icon}</span>
        <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${this._escapeHtml(ch.name)}</span>
        ${tagBadge}${drillHint}
      </div>`;
    }
  }

  if (!displayList.length) {
    html = `<div style="padding:24px;text-align:center;opacity:0.4;font-size:0.9rem">${this._organizeServerLevel ? t('channels.no_channels_yet') : t('channels.no_sub_channels_yet')}</div>`;
  }

  listEl.innerHTML = html;

  // Click to select channel
  listEl.querySelectorAll('.organize-item').forEach(el => {
    el.addEventListener('click', () => {
      this._organizeSelected = el.dataset.code;
      this._organizeSelectedTag = null; // clear tag selection
      const ch = this._organizeList.find(c => c.code === el.dataset.code);
      document.getElementById('organize-tag-input').value = (ch && ch.category) || '';
      this._renderOrganizeList();
    });
    // Double-click on a parent channel (server-level mode) drills into its sub-channels
    if (this._organizeServerLevel) {
      el.addEventListener('dblclick', () => {
        const ch = this.channels.find(c => c.code === el.dataset.code);
        if (!ch) return;
        const hasSubs = this.channels.some(c => c.parent_channel_id === ch.id);
        if (hasSubs) this._openOrganizeModal(ch.code);
      });
    }
  });

  // Click tag header to select category
  listEl.querySelectorAll('.organize-tag-header').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.classList.contains('tag-sort-select')) return; // ignore dropdown clicks
      this._organizeSelectedTag = el.dataset.tagKey;
      this._organizeSelected = null; // clear channel selection
      document.getElementById('organize-tag-input').value = '';
      this._renderOrganizeList();
    });
  });

  // Per-tag sort dropdowns
  listEl.querySelectorAll('.tag-sort-select').forEach(sel => {
    sel.addEventListener('click', (e) => e.stopPropagation());
    sel.addEventListener('change', (e) => {
      e.stopPropagation();
      const tagKey = sel.dataset.tag;
      this._organizeTagSorts[tagKey] = sel.value;
      // Persist per-tag sorts so sidebar respects them
      localStorage.setItem(`haven_tag_sorts_${this._organizeParentCode}`, JSON.stringify(this._organizeTagSorts));
      // Server-level: sync to server so all users see category-specific sorts
      if (this._organizeServerLevel && (this.user?.isAdmin || this._hasPerm('manage_server'))) {
        this.socket.emit('update-server-setting', { key: 'channel_tag_sorts', value: JSON.stringify(this._organizeTagSorts) });
      }
      this._renderOrganizeList();
    });
  });

  // ── Drag-and-drop reordering of category headers ──────
  // Uses event delegation on listEl so drag events still fire when the
  // cursor is over a child element (e.g. the per-tag <select>) inside the
  // header, which can otherwise swallow dragover/drop in some browsers.
  // Re-attach is idempotent because handlers live on listEl, not children.
  if (!listEl._catDragSetup) {
    listEl._catDragSetup = true;
    listEl.addEventListener('dragstart', (e) => {
      const header = e.target.closest('.organize-tag-header[draggable="true"]');
      if (!header || !listEl.contains(header)) return;
      listEl._catDragKey = header.dataset.tagKey;
      header.classList.add('org-dragging');
      e.dataTransfer.setData('text/plain', listEl._catDragKey || '');
      e.dataTransfer.effectAllowed = 'move';
    });
    listEl.addEventListener('dragend', () => {
      listEl.querySelectorAll('.organize-tag-header').forEach(h => h.classList.remove('org-dragging', 'org-drop-above', 'org-drop-below'));
      listEl._catDragKey = null;
    });
    listEl.addEventListener('dragover', (e) => {
      if (!listEl._catDragKey) return;
      const header = e.target.closest('.organize-tag-header');
      if (!header || header.dataset.tagKey === listEl._catDragKey) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const rect = header.getBoundingClientRect();
      const before = (e.clientY - rect.top) < rect.height / 2;
      // Clear other indicators
      listEl.querySelectorAll('.organize-tag-header').forEach(h => {
        if (h !== header) h.classList.remove('org-drop-above', 'org-drop-below');
      });
      header.classList.toggle('org-drop-above', before);
      header.classList.toggle('org-drop-below', !before);
    });
    listEl.addEventListener('dragleave', (e) => {
      // Only clear when leaving the list entirely
      if (!listEl.contains(e.relatedTarget)) {
        listEl.querySelectorAll('.organize-tag-header').forEach(h => h.classList.remove('org-drop-above', 'org-drop-below'));
      }
    });
    listEl.addEventListener('drop', (e) => {
      const header = e.target.closest('.organize-tag-header');
      const dragKey = listEl._catDragKey;
      listEl._catDragKey = null;
      listEl.querySelectorAll('.organize-tag-header').forEach(h => h.classList.remove('org-drop-above', 'org-drop-below', 'org-dragging'));
      if (!header || !dragKey || header.dataset.tagKey === dragKey) return;
      e.preventDefault();
      const rect = header.getBoundingClientRect();
      const before = (e.clientY - rect.top) < rect.height / 2;
      const currentOrder = Array.from(listEl.querySelectorAll('.organize-tag-header'))
        .map(h => h.dataset.tagKey);
      const fromIdx = currentOrder.indexOf(dragKey);
      if (fromIdx === -1) return;
      currentOrder.splice(fromIdx, 1);
      const insertAt = currentOrder.indexOf(header.dataset.tagKey) + (before ? 0 : 1);
      currentOrder.splice(insertAt, 0, dragKey);

      this._organizeCatSort = 'manual';
      this._organizeCatOrder = currentOrder;
      const sortSel = document.getElementById('organize-cat-sort');
      if (sortSel) sortSel.value = 'manual';
      localStorage.setItem(`haven_cat_order_${this._organizeParentCode}`, JSON.stringify(currentOrder));
      localStorage.setItem(`haven_cat_sort_${this._organizeParentCode}`, 'manual');
      if (this._organizeServerLevel && (this.user?.isAdmin || this._hasPerm('manage_server'))) {
        this.socket.emit('update-server-setting', { key: 'channel_cat_order', value: JSON.stringify(currentOrder) });
        this.socket.emit('update-server-setting', { key: 'channel_cat_sort', value: 'manual' });
      }
      this._renderOrganizeList();
      this._renderChannels();
    });
  }

  // Disable up/down based on selection type
  let canMoveUp = false, canMoveDown = false;
  if (this._organizeSelectedTag) {
    // Category selected — always allow movement; handler auto-switches to manual mode
    const orderedTags = grouped.map(g => g.tag || '__untagged__');
    const tagIdx = orderedTags.indexOf(this._organizeSelectedTag);
    canMoveUp = tagIdx > 0;
    canMoveDown = tagIdx >= 0 && tagIdx < orderedTags.length - 1;
  } else if (this._organizeSelected) {
    // Channel selected — can move if its tag group sort is manual
    const ch = this._organizeList.find(c => c.code === this._organizeSelected);
    if (ch) {
      const { group, effectiveSort } = this._getOrganizeVisualGroup(ch);
      if (effectiveSort === 'manual') {
        const groupIdx = group.findIndex(c => c.code === this._organizeSelected);
        canMoveUp = groupIdx > 0;
        canMoveDown = groupIdx >= 0 && groupIdx < group.length - 1;
      }
    }
  }
  document.getElementById('organize-move-up').disabled = !canMoveUp;
  document.getElementById('organize-move-down').disabled = !canMoveDown;
  document.getElementById('organize-set-tag').disabled = !this._organizeSelected;
  document.getElementById('organize-remove-tag').disabled = !this._organizeSelected;
},

/**
 * Get the sorted visual group of channels for the organize modal.
 * Returns the channels in the same tag group as `ch`, sorted by
 * the effective sort mode, plus the sort mode string.
 */
_getOrganizeVisualGroup(ch) {
  let globalSort = document.getElementById('organize-global-sort').value;
  if (globalSort === 'server_default') globalSort = this.serverSettings?.channel_sort_mode || 'manual';
  const tagKey = ch.category || '__untagged__';
  const effectiveSort = this._organizeTagSorts[tagKey] || globalSort;

  // Collect channels in the same tag group (case-insensitive)
  const group = ch.category
    ? this._organizeList.filter(c => c.category && c.category.toLowerCase() === ch.category.toLowerCase())
    : this._organizeList.filter(c => !c.category);

  // Sort by effective mode (mirrors _renderOrganizeList's sortGroup)
  if (effectiveSort === 'alpha') {
    group.sort((a, b) => a.name.localeCompare(b.name));
  } else if (effectiveSort === 'created') {
    group.sort((a, b) => (b.id || 0) - (a.id || 0));
  } else if (effectiveSort === 'oldest') {
    group.sort((a, b) => (a.id || 0) - (b.id || 0));
  } else if (effectiveSort === 'dynamic') {
    group.sort((a, b) => (b.latestMessageId || 0) - (a.latestMessageId || 0));
  } else {
    group.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  }

  return { group, effectiveSort };
},

/**
 * Move a category group up or down in the order.
 * @param {number} direction -1 for up, +1 for down
 */
_moveCategoryInOrder(direction) {
  if (!this._organizeSelectedTag) return;

  // Build full ordered keys (real tags + __untagged__) from channel data
  const displayList = [...(this._organizeList || [])];
  const realTags = [...new Map(displayList.filter(c => c.category).map(c => [c.category.toLowerCase(), c.category])).values()];
  const hasUntagged = displayList.some(c => !c.category);
  const allKeys = [...realTags];
  if (hasUntagged) allKeys.push('__untagged__');

  // Sort by current mode to match the visual order (same logic as _renderOrganizeList)
  const catSort = this._organizeCatSort || 'az';
  if (catSort === 'az') {
    allKeys.sort((a, b) => {
      if (a === '__untagged__') return 1; if (b === '__untagged__') return -1;
      return a.localeCompare(b);
    });
  } else if (catSort === 'za') {
    allKeys.sort((a, b) => {
      if (a === '__untagged__') return 1; if (b === '__untagged__') return -1;
      return b.localeCompare(a);
    });
  } else {
    const order = this._organizeCatOrder || [];
    allKeys.sort((a, b) => {
      const ia = order.indexOf(a);
      const ib = order.indexOf(b);
      if (ia === -1 && ib === -1) {
        if (a === '__untagged__') return 1; if (b === '__untagged__') return -1;
        return a.localeCompare(b);
      }
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    });
  }

  const idx = allKeys.indexOf(this._organizeSelectedTag);
  const targetIdx = idx + direction;
  if (idx < 0 || targetIdx < 0 || targetIdx >= allKeys.length) return;

  // Swap
  [allKeys[idx], allKeys[targetIdx]] = [allKeys[targetIdx], allKeys[idx]];

  // Switch to manual mode
  this._organizeCatSort = 'manual';
  this._organizeCatOrder = allKeys;
  document.getElementById('organize-cat-sort').value = 'manual';

  // Persist
  localStorage.setItem(`haven_cat_order_${this._organizeParentCode}`, JSON.stringify(allKeys));
  localStorage.setItem(`haven_cat_sort_${this._organizeParentCode}`, 'manual');
  // Server-level: sync category order to server so all users see it
  if (this._organizeServerLevel && (this.user?.isAdmin || this._hasPerm('manage_server'))) {
    this.socket.emit('update-server-setting', { key: 'channel_cat_order', value: JSON.stringify(allKeys) });
    this.socket.emit('update-server-setting', { key: 'channel_cat_sort', value: 'manual' });
  }

  this._renderOrganizeList();
  // Always re-render the sidebar so sub-channel category moves take effect
  // immediately (previously this was server-level-only and the sidebar lagged
  // behind the modal for sub-channel reordering). #4 in the bug list.
  this._renderChannels();
},

/* ── DM Organize (client-side, localStorage) ─────────── */

_openDmOrganizeModal() {
  const dmChannels = this.channels.filter(c => c.is_dm);
  const order = JSON.parse(localStorage.getItem('haven_dm_order') || '[]');
  const assignments = JSON.parse(localStorage.getItem('haven_dm_assignments') || '{}');

  // Build list sorted by saved order, then alphabetical for unknowns
  const ordered = [];
  for (const code of order) {
    const ch = dmChannels.find(c => c.code === code);
    if (ch) ordered.push(ch);
  }
  for (const ch of dmChannels) {
    if (!ordered.includes(ch)) ordered.push(ch);
  }
  this._dmOrganizeList = ordered;
  this._dmOrganizeSelected = null;

  const sortSel = document.getElementById('dm-organize-sort');
  sortSel.value = localStorage.getItem('haven_dm_sort_mode') || 'manual';
  document.getElementById('dm-organize-tag-input').value = '';
  this._renderDmOrganizeList();
  document.getElementById('dm-organize-modal').style.display = 'flex';
},

_saveDmOrder() {
  localStorage.setItem('haven_dm_order', JSON.stringify(this._dmOrganizeList.map(c => c.code)));
},

_renderDmOrganizeList() {
  const listEl = document.getElementById('dm-organize-list');
  const sortMode = document.getElementById('dm-organize-sort').value;
  const assignments = JSON.parse(localStorage.getItem('haven_dm_assignments') || '{}');

  let displayList = [...(this._dmOrganizeList || [])];

  // Collect unique tags
  const allTags = [...new Set(displayList.map(c => assignments[c.code]).filter(Boolean))].sort();
  const hasTags = allTags.length > 0;

  const getDmName = (ch) => ch.dm_target ? this._getNickname(ch.dm_target.id, ch.dm_target.username) : t('channels.unknown_user');

  const sortGroup = (arr, mode) => {
    if (mode === 'alpha') {
      arr.sort((a, b) => getDmName(a).localeCompare(getDmName(b)));
    } else if (mode === 'recent') {
      arr.sort((a, b) => (b.last_activity || 0) - (a.last_activity || 0));
    }
    // manual = keep current order
    return arr;
  };

  let grouped = [];
  if (hasTags) {
    for (const tag of allTags) {
      const tagItems = sortGroup(displayList.filter(c => assignments[c.code] === tag), sortMode);
      grouped.push({ tag, items: tagItems });
    }
    const untagged = displayList.filter(c => !assignments[c.code]);
    if (untagged.length) {
      grouped.push({ tag: '', items: sortGroup(untagged, sortMode) });
    }
  } else {
    grouped.push({ tag: '', items: sortGroup(displayList, sortMode) });
  }

  let html = '';
  for (const group of grouped) {
    if (group.tag) {
      html += `<div class="organize-tag-header"><span class="organize-tag-icon" aria-hidden="true">🏷️</span> ${this._escapeHtml(group.tag)}</div>`;
    } else if (hasTags) {
      html += `<div class="organize-tag-header" style="opacity:0.5">${t('channels.uncategorized')}</div>`;
    }
    for (const ch of group.items) {
      const name = getDmName(ch);
      const sel = ch.code === this._dmOrganizeSelected ? ' selected' : '';
      const tagBadge = assignments[ch.code] ? `<span class="organize-tag-badge">${this._escapeHtml(assignments[ch.code])}</span>` : '';
      html += `<div class="organize-item${sel}" data-code="${ch.code}">
        <span class="organize-item-name">@ ${this._escapeHtml(name)}</span>
        ${tagBadge}
      </div>`;
    }
  }
  listEl.innerHTML = html || `<p class="muted-text">${t('channels.no_dms_to_organize')}</p>`;

  // Click to select
  listEl.querySelectorAll('.organize-item').forEach(el => {
    el.addEventListener('click', () => {
      this._dmOrganizeSelected = el.dataset.code;
      listEl.querySelectorAll('.organize-item').forEach(e => e.classList.remove('selected'));
      el.classList.add('selected');
      // Pre-fill tag input with current tag
      const currentTag = assignments[el.dataset.code] || '';
      document.getElementById('dm-organize-tag-input').value = currentTag;
      this._updateDmOrganizeButtons();
    });
  });
  this._updateDmOrganizeButtons();
},

_updateDmOrganizeButtons() {
  const sortMode = document.getElementById('dm-organize-sort').value;
  const isManual = sortMode === 'manual';
  document.getElementById('dm-organize-move-up').disabled = !isManual || !this._dmOrganizeSelected;
  document.getElementById('dm-organize-move-down').disabled = !isManual || !this._dmOrganizeSelected;
  document.getElementById('dm-organize-set-tag').disabled = !this._dmOrganizeSelected;
  document.getElementById('dm-organize-remove-tag').disabled = !this._dmOrganizeSelected;
},

_openWebhookModal(channelCode) {
  const ch = this.channels.find(c => c.code === channelCode);
  const modal = document.getElementById('webhook-modal');
  modal._channelCode = channelCode;
  document.getElementById('webhook-modal-channel-name').textContent = ch ? `# ${ch.name}` : '';
  document.getElementById('webhook-name-input').value = '';
  document.getElementById('webhook-token-reveal').style.display = 'none';
  document.getElementById('webhook-list').innerHTML = `<p style="opacity:0.5;font-size:0.85rem">${t('channels.webhook_loading')}</p>`;
  modal.style.display = 'flex';
  this.socket.emit('get-webhooks', { channelCode });
},

_renderWebhookList(webhooks, channelCode) {
  const container = document.getElementById('webhook-list');
  if (!webhooks.length) {
    container.innerHTML = `<p style="opacity:0.5;font-size:0.85rem">${t('channels.no_webhooks')}</p>`;
    return;
  }
  container.innerHTML = webhooks.map(wh => {
    const maskedToken = typeof wh.token === 'string' && wh.token
      ? wh.token.slice(0, 8) + '••••••••'
      : 'Hidden - owner/admin only';
    const statusLabel = wh.is_active ? `🟢 ${t('channels.webhook_active')}` : `🔴 ${t('channels.webhook_disabled')}`;
    const toggleLabel = wh.is_active ? t('channels.webhook_disable') : t('channels.webhook_enable');
    return `
      <div class="webhook-item" style="display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:6px;background:rgba(255,255,255,0.04);margin-bottom:6px">
        <div style="flex:1;min-width:0">
          <div style="font-weight:600;font-size:0.9rem">${this._escapeHtml(wh.name)}</div>
          <div style="font-size:0.75rem;opacity:0.5;font-family:monospace">${maskedToken}</div>
        </div>
        <span style="font-size:0.75rem;white-space:nowrap">${statusLabel}</span>
        <button class="btn-xs webhook-toggle-btn" data-id="${wh.id}" style="font-size:0.75rem">${toggleLabel}</button>
        <button class="btn-xs webhook-delete-btn" data-id="${wh.id}" style="font-size:0.75rem;color:#ff4444">🗑️</button>
      </div>`;
  }).join('');

  container.querySelectorAll('.webhook-delete-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (confirm(t('channels.webhook_delete_confirm'))) {
        this.socket.emit('delete-webhook', { webhookId: parseInt(btn.dataset.id) });
      }
    });
  });
  container.querySelectorAll('.webhook-toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      this.socket.emit('toggle-webhook', { webhookId: parseInt(btn.dataset.id) });
    });
  });
},

};
