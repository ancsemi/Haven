// Unread and alert state: badges, the tab title and desktop badge, native
// notifications, voice indicators on channels, and drag-and-drop
// reordering of channels and DMs.

export default {

// ── Drag-and-drop channel reordering ────────────────────

// Chromium's native drag-and-drop only auto-scrolls the document, never a
// nested overflow container, so a channel dragged to the top or bottom edge
// of a long sidebar just stopped there. This drives the scroll ourselves from
// dragover. The element that actually scrolls depends on the channel-scroll
// mode (#channel-list in "separate", .sidebar-split in "combined" and on
// short screens), so it is resolved on each call.
_makeEdgeScroller(listEl, edge = 48, maxSpeed = 18) {
  let raf = null, vel = 0;
  const scroller = () => {
    let el = listEl;
    while (el && el !== document.body) {
      const oy = getComputedStyle(el).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight) return el;
      el = el.parentElement;
    }
    return listEl;
  };
  const stop = () => { if (raf) cancelAnimationFrame(raf); raf = null; vel = 0; };
  const step = (sc) => () => {
    if (!vel) { raf = null; return; }
    sc.scrollTop += vel;
    raf = requestAnimationFrame(step(sc));
  };
  const onDragOver = (clientY) => {
    const sc = scroller();
    const r = sc.getBoundingClientRect();
    if (clientY < r.top + edge) vel = -maxSpeed * Math.min(1, (r.top + edge - clientY) / edge);
    else if (clientY > r.bottom - edge) vel = maxSpeed * Math.min(1, (clientY - (r.bottom - edge)) / edge);
    else { stop(); return; }
    if (!raf) raf = requestAnimationFrame(step(sc));
  };
  return { onDragOver, stop };
},

_setupChannelDragDrop() {
  const canManage = this.user?.isAdmin || this._hasPerm('manage_server') || this._hasPerm('create_channel');
  const list = document.getElementById('channel-list');
  if (!list || !canManage) return;

  // Make eligible items draggable (idempotent — safe to re-run each render)
  list.querySelectorAll(
    '.channel-item:not(.sub-channel-item):not(.dm-item):not(.temp-channel-create-btn), .category-label, .sub-channel-item'
  ).forEach(el => el.setAttribute('draggable', 'true'));

  // Listeners must only be attached ONCE per container — re-renders would
  // otherwise stack duplicate handlers and cause channels to spasm/jump.
  if (list._dragSetupDone) return;
  list._dragSetupDone = true;

  let dragSrc = null;
  const indicator = document.createElement('div');
  indicator.className = 'ch-drag-indicator';

  const edge = this._makeEdgeScroller(list);
  const cleanUp = () => {
    edge.stop();
    if (dragSrc) { dragSrc.classList.remove('ch-dragging'); dragSrc = null; }
    indicator.remove();
  };

  // Check whether drag source and potential target are compatible
  const isCompatible = (src, tgt) => {
    if (!src || !tgt || src === tgt) return false;
    if (src.classList.contains('category-label'))
      return tgt.classList.contains('category-label');
    if (src.classList.contains('sub-tag-label'))
      return tgt.classList.contains('sub-tag-label') && tgt.dataset.parentCode === src.dataset.parentCode;
    if (src.classList.contains('sub-channel-item'))
      return tgt.classList.contains('sub-channel-item') && !tgt.classList.contains('sub-tag-label') && tgt.dataset.parentId === src.dataset.parentId;
    // Parent channel: compatible with other parent channel-items or category labels
    return (tgt.classList.contains('channel-item') && !tgt.classList.contains('sub-channel-item') && !tgt.classList.contains('dm-item') && !tgt.classList.contains('temp-channel-create-btn')) ||
      tgt.classList.contains('category-label');
  };

  list.addEventListener('dragstart', (e) => {
    const el = e.target.closest('[draggable="true"]');
    if (!el || el.classList.contains('temp-channel-create-btn')) { e.preventDefault(); return; }
    dragSrc = el;
    dragSrc.classList.add('ch-dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', el.dataset.code || el.dataset.category || el.dataset.tagName || '');
  });

  list.addEventListener('dragover', (e) => {
    if (!dragSrc) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    edge.onDragOver(e.clientY);
    const tgt = e.target.closest('.channel-item:not(.temp-channel-create-btn), .category-label');
    if (!tgt || !isCompatible(dragSrc, tgt)) { indicator.remove(); return; }
    const rect = tgt.getBoundingClientRect();
    if (e.clientY < rect.top + rect.height / 2) {
      list.insertBefore(indicator, tgt);
    } else {
      list.insertBefore(indicator, tgt.nextSibling);
    }
  });

  list.addEventListener('dragleave', (e) => {
    if (!list.contains(e.relatedTarget)) indicator.remove();
  });

  list.addEventListener('drop', (e) => {
    e.preventDefault();
    edge.stop();
    if (!dragSrc || !indicator.parentNode) { cleanUp(); return; }
    indicator.parentNode.insertBefore(dragSrc, indicator);
    indicator.remove();
    this._saveDragDropOrder(dragSrc);
    dragSrc.classList.remove('ch-dragging');
    dragSrc = null;
  });

  list.addEventListener('dragend', cleanUp);
},

_saveDragDropOrder(el) {
  const list = document.getElementById('channel-list');
  if (!list) return;

  // Category label was dragged — reorder categories
  if (el.classList.contains('category-label')) {
    const newOrder = [...list.querySelectorAll('.category-label')].map(e => e.dataset.category || '__untagged__');
    localStorage.setItem('haven_cat_order___server__', JSON.stringify(newOrder));
    localStorage.setItem('haven_cat_sort___server__', 'manual');
    if (this.serverSettings) {
      this.serverSettings.channel_cat_order = JSON.stringify(newOrder);
      this.serverSettings.channel_cat_sort = 'manual';
    }
    if (this.user?.isAdmin || this._hasPerm('manage_server')) {
      this.socket.emit('update-server-setting', { key: 'channel_cat_order', value: JSON.stringify(newOrder) });
      this.socket.emit('update-server-setting', { key: 'channel_cat_sort', value: 'manual' });
    }
    return;
  }

  // Sub-tag label was dragged — reorder sub-tags within parent
  if (el.classList.contains('sub-tag-label')) {
    const parentCode = el.dataset.parentCode;
    if (!parentCode) return;
    // Map the literal "Untagged" tag name back to the __untagged__ placeholder
    // that the organize modal uses, so the saved order matches what the modal
    // reads on next open.
    const newOrder = [...list.querySelectorAll(`.sub-tag-label[data-parent-code="${CSS.escape(parentCode)}"]`)]
      .map(e => {
        const t = e.dataset.tagName;
        if (!t || t === 'Untagged') return '__untagged__';
        return t;
      });
    localStorage.setItem(`haven_cat_order_${parentCode}`, JSON.stringify(newOrder));
    localStorage.setItem(`haven_cat_sort_${parentCode}`, 'manual');
    return;
  }

  // Sub-channel was dragged — reorder subs within parent
  if (el.classList.contains('sub-channel-item')) {
    const parentId = parseInt(el.dataset.parentId);
    const parentCh = this.channels.find(c => c.id === parentId);
    if (!parentCh) return;
    const subs = [...list.querySelectorAll(`.sub-channel-item:not(.sub-tag-label)[data-parent-id="${parentId}"]`)];
    const order = subs.map((e, i) => ({ code: e.dataset.code, position: i }));
    this.socket.emit('reorder-channels', { order });
    // Switch parent to manual sort
    if (parentCh.sort_alphabetical !== 0) {
      parentCh.sort_alphabetical = 0;
      this.socket.emit('set-sort-alphabetical', { code: parentCh.code });
    }
    // Switch per-sub-tag sort override to manual if the sub-channel had a tag
    const subTag = el.dataset.subTag;
    if (subTag) {
      const tagSorts = JSON.parse(localStorage.getItem(`haven_tag_sorts_${parentCh.code}`) || '{}');
      tagSorts[subTag] = 'manual';
      localStorage.setItem(`haven_tag_sorts_${parentCh.code}`, JSON.stringify(tagSorts));
    }
    return;
  }

  // Parent channel was dragged — determine its new category from preceding category label
  let newCategory = '';
  let prev = el.previousElementSibling;
  while (prev) {
    if (prev.classList.contains('category-label')) { newCategory = prev.dataset.category || ''; break; }
    prev = prev.previousElementSibling;
  }

  // If category changed, tell the server
  const ch = this.channels.find(c => c.code === el.dataset.code);
  if (ch && (ch.category || '') !== newCategory) {
    this.socket.emit('set-channel-category', { code: el.dataset.code, category: newCategory });
    ch.category = newCategory || null;
  }

  // Reorder all parent channels by new DOM positions
  const parentItems = [...list.querySelectorAll('.channel-item:not(.sub-channel-item):not(.dm-item):not(.temp-channel-create-btn)')];
  const order = parentItems.map((e, i) => ({ code: e.dataset.code, position: i }));
  this.socket.emit('reorder-channels', { order });

  // Switch server to manual sort mode
  localStorage.setItem('haven_server_sort_mode', 'manual');
  if (this.serverSettings) this.serverSettings.channel_sort_mode = 'manual';
  if (this.user?.isAdmin || this._hasPerm('manage_server')) {
    this.socket.emit('update-server-setting', { key: 'channel_sort_mode', value: 'manual' });
  }

  // Switch the dropped channel's category tag sort to manual
  const tagSorts = JSON.parse(localStorage.getItem('haven_tag_sorts___server__') || '{}');
  const catKey = newCategory || '__untagged__';
  if (tagSorts[catKey] !== 'manual') {
    tagSorts[catKey] = 'manual';
    localStorage.setItem('haven_tag_sorts___server__', JSON.stringify(tagSorts));
    if (this.user?.isAdmin || this._hasPerm('manage_server')) {
      this.socket.emit('update-server-setting', { key: 'channel_tag_sorts', value: JSON.stringify(tagSorts) });
    }
  }
},

_setupDmDragDrop() {
  const dmList = document.getElementById('dm-list');
  if (!dmList) return;

  dmList.querySelectorAll('.dm-item').forEach(el => el.setAttribute('draggable', 'true'));

  if (dmList._dragSetupDone) return;
  dmList._dragSetupDone = true;

  let dragSrc = null;
  const indicator = document.createElement('div');
  indicator.className = 'ch-drag-indicator';

  const cleanUp = () => {
    edge.stop();
    if (dragSrc) { dragSrc.classList.remove('ch-dragging'); dragSrc = null; }
    indicator.remove();
  };

  dmList.addEventListener('dragstart', (e) => {
    const el = e.target.closest('.dm-item[draggable="true"]');
    if (!el) return;
    dragSrc = el;
    dragSrc.classList.add('ch-dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', el.dataset.code || '');
  });

  const edge = this._makeEdgeScroller(dmList);
  dmList.addEventListener('dragover', (e) => {
    if (!dragSrc) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    edge.onDragOver(e.clientY);
    const tgt = e.target.closest('.dm-item');
    if (!tgt || tgt === dragSrc) { indicator.remove(); return; }
    const rect = tgt.getBoundingClientRect();
    if (e.clientY < rect.top + rect.height / 2) {
      dmList.insertBefore(indicator, tgt);
    } else {
      dmList.insertBefore(indicator, tgt.nextSibling);
    }
  });

  dmList.addEventListener('dragleave', (e) => {
    if (!dmList.contains(e.relatedTarget)) indicator.remove();
  });

  dmList.addEventListener('drop', (e) => {
    e.preventDefault();
    edge.stop();
    if (!dragSrc || !indicator.parentNode) { cleanUp(); return; }
    indicator.parentNode.insertBefore(dragSrc, indicator);
    indicator.remove();
    const newOrder = [...dmList.querySelectorAll('.dm-item')].map(el => el.dataset.code);
    localStorage.setItem('haven_dm_order', JSON.stringify(newOrder));
    localStorage.setItem('haven_dm_sort_mode', 'manual');
    dragSrc.classList.remove('ch-dragging');
    dragSrc = null;
  });

  dmList.addEventListener('dragend', cleanUp);
},

_updateBadge(code) {
  const el = document.querySelector(`.channel-item[data-code="${code}"]`);
  if (el) {
    let badge = el.querySelector('.channel-badge:not(.channel-badge-bubble)');
    const count = this.unreadCounts[code] || 0;

    if (count > 0) {
      const ch = this.channels.find(c => c.code === code);
      const isAnn = ch && ch.notification_type === 'announcement';
      if (!badge) { badge = document.createElement('span'); badge.className = 'channel-badge' + (isAnn ? ' announcement-badge' : ''); el.appendChild(badge); }
      badge.textContent = count > 99 ? '99+' : count;
    } else if (badge) {
      badge.remove();
    }

    // If this is a sub-channel whose parent is currently collapsed, bubble an unread
    // indicator up to the parent so the user knows to expand it.
    if (el.dataset.parentId) {
      const parentChannel = this.channels.find(c => c.id === parseInt(el.dataset.parentId));
      if (parentChannel) {
        const parentEl = document.querySelector(`.channel-item[data-code="${parentChannel.code}"]`);
        if (parentEl) {
          // Check if sub-channels are collapsed (arrow has 'collapsed' class)
          const arrow = parentEl.querySelector('.channel-collapse-arrow');
          if (arrow && arrow.classList.contains('collapsed')) {
            // Count total unreads across all sub-channels of this parent
            const siblingCodes = this.channels
              .filter(c => c.parent_channel_id === parentChannel.id)
              .map(c => c.code);
            const siblingTotal = siblingCodes.reduce((sum, sc) => sum + (this.unreadCounts[sc] || 0), 0);
            let parentBubble = parentEl.querySelector('.channel-badge-bubble');
            if (siblingTotal > 0) {
              if (!parentBubble) {
                parentBubble = document.createElement('span');
                parentBubble.className = 'channel-badge channel-badge-bubble';
                parentEl.appendChild(parentBubble);
              }
              parentBubble.textContent = siblingTotal > 99 ? '99+' : siblingTotal;
            } else if (parentBubble) {
              parentBubble.remove();
            }
          } else {
            // Sub-channels are expanded — remove any bubble from parent
            const parentBubble = parentEl.querySelector('.channel-badge-bubble');
            if (parentBubble) parentBubble.remove();
          }
        }
      }
    }
  }

  // Always update DM section badge, tab title, and desktop badge
  // even if the individual channel item isn't in the DOM
  this._updateDmSectionBadge();
  this._updateTabTitle();
  this._updateDesktopBadge();
  this._updateNestedIndicators();
},

// Add a small "look inside" dot to expanded category labels and to
// expanded parent channels when one of their children has unread
// messages. The dot is visually distinct from the count bubble — the
// bubble (with a number) only appears when the parent is collapsed
// and is the actual count; this dot is just a hint that there's
// something below worth scrolling to. (parent-notif feature request)
_updateNestedIndicators() {
  if (!this.channels) return;
  const subChannelMap = {};
  for (const c of this.channels) {
    if (c.parent_channel_id) {
      (subChannelMap[c.parent_channel_id] ||= []).push(c);
    }
  }
  const setDot = (el, on) => {
    if (!el) return;
    let dot = el.querySelector(':scope > .channel-badge-nested-dot');
    if (on) {
      if (!dot) {
        dot = document.createElement('span');
        dot.className = 'channel-badge-nested-dot';
        dot.title = t('channels.nested_unread');
        el.appendChild(dot);
      }
    } else if (dot) {
      dot.remove();
    }
  };

  // Category labels: when EXPANDED show a small dot (the per-channel
  // badges already show the actual counts); when COLLAPSED show a count
  // bubble like collapsed parent channels do, otherwise the unreads
  // would be invisible (channel rows are hidden with the category) and
  // the user would see a taskbar badge with no on-screen indicator
  // anywhere — exactly the phantom-badge bug. (#desktop-phantom-badge)
  document.querySelectorAll('.section-label.category-label[data-category]').forEach(catEl => {
    const cat = catEl.dataset.category;
    if (!cat) return;
    const collapsed = localStorage.getItem(`haven_cat_collapsed_${cat}`) === 'true';
    let total = 0;
    for (const c of this.channels) {
      if (c.is_dm || c.parent_channel_id) continue;
      if ((c.category || '') !== cat) continue;
      total += this.unreadCounts[c.code] || 0;
      for (const s of (subChannelMap[c.id] || [])) {
        total += this.unreadCounts[s.code] || 0;
      }
    }
    let bubble = catEl.querySelector(':scope > .channel-badge-bubble');
    if (collapsed && total > 0) {
      if (!bubble) {
        bubble = document.createElement('span');
        bubble.className = 'channel-badge channel-badge-bubble';
        bubble.style.marginLeft = 'auto';
        catEl.appendChild(bubble);
      }
      bubble.textContent = total > 99 ? '99+' : total;
      setDot(catEl, false);
    } else {
      if (bubble) bubble.remove();
      setDot(catEl, !collapsed && total > 0);
    }
  });

  // Parent channels with sub-channels: dot if subs are expanded AND
  // any sub has unreads.
  for (const c of this.channels) {
    if (c.is_dm || c.parent_channel_id) continue;
    const subs = subChannelMap[c.id];
    if (!subs || !subs.length) continue;
    const parentEl = document.querySelector(`.channel-item[data-code="${c.code}"]`);
    if (!parentEl) continue;
    const isCollapsed = localStorage.getItem(`haven_subs_collapsed_${c.code}`) === 'true';
    if (isCollapsed) { setDot(parentEl, false); continue; }
    const subTotal = subs.reduce((sum, s) => sum + (this.unreadCounts[s.code] || 0), 0);
    setDot(parentEl, subTotal > 0);
  }

  // Tag labels (sub-channel category groups inside a parent channel) — issue #5311.
  // When the tag row is collapsed, append a count bubble like the one used for
  // collapsed parent channels. When expanded, fall back to the same dot pattern
  // as parents/categories so the indication stays consistent.
  document.querySelectorAll('.sub-tag-label').forEach(tagEl => {
    const parentCode = tagEl.dataset.parentCode;
    const tagName = tagEl.dataset.tagName;
    if (!parentCode || !tagName) return;
    const parentChannel = this.channels.find(c => c.code === parentCode);
    if (!parentChannel) return;
    const subs = subChannelMap[parentChannel.id] || [];
    const total = subs.reduce((sum, s) => {
      const subTag = s.category || t('channels.untagged');
      if (subTag !== tagName) return sum;
      return sum + (this.unreadCounts[s.code] || 0);
    }, 0);
    const tagKey = `haven_subtag_collapsed_${parentCode}_${tagName}`;
    const isCollapsed = localStorage.getItem(tagKey) === 'true';
    let bubble = tagEl.querySelector(':scope > .channel-badge-bubble');
    if (isCollapsed && total > 0) {
      if (!bubble) {
        bubble = document.createElement('span');
        bubble.className = 'channel-badge channel-badge-bubble';
        bubble.style.marginLeft = 'auto';
        tagEl.appendChild(bubble);
      }
      bubble.textContent = total > 99 ? '99+' : total;
      setDot(tagEl, false);
    } else {
      if (bubble) bubble.remove();
      setDot(tagEl, !isCollapsed && total > 0);
    }
  });
},

_updateTabTitle() {
  let mutedSet = null;
  try {
    mutedSet = new Set(JSON.parse(localStorage.getItem('haven_muted_channels') || '[]'));
  } catch { mutedSet = new Set(); }
  const validCodes = new Set((this.channels || []).map(c => c.code));
  const total = Object.entries(this.unreadCounts).reduce((s, [k, v]) => {
    if (!validCodes.has(k)) return s;
    if (mutedSet.has(k)) return s;
    return s + v;
  }, 0);
  // Include the server's display name so multiple Haven tabs are easy to tell
  // apart at a glance (issue #5284).
  const serverName = (this.serverSettings && this.serverSettings.server_name) || '';
  const base = serverName && serverName.toLowerCase() !== 'haven'
    ? `Haven: ${serverName}`
    : 'Haven';
  document.title = total > 0 ? `(${total}) ${base}` : base;
},

_updateDesktopBadge() {
  // If the user has muted this server entirely, always report no-badge so this
  // instance never adds to the taskbar overlay icon.
  if (localStorage.getItem('haven_server_muted') === '1') {
    this._lastDesktopBadge = false;
    window.havenDesktop?.setUnreadBadge?.(false);
    return;
  }
  // Exclude muted channels from the desktop total. The channels-list
  // snapshot from the server doesn't know about local mutes (they live in
  // localStorage), so a muted channel with new messages was lighting up
  // the taskbar even though every sidebar indicator was suppressed —
  // looked like a phantom badge to the user. (#desktop-phantom-badge)
  let mutedSet = null;
  try {
    mutedSet = new Set(JSON.parse(localStorage.getItem('haven_muted_channels') || '[]'));
  } catch { mutedSet = new Set(); }
  const validCodes = new Set((this.channels || []).map(c => c.code));
  const total = Object.entries(this.unreadCounts).reduce((s, [k, v]) => {
    if (!validCodes.has(k)) return s;
    if (mutedSet.has(k)) return s;
    return s + v;
  }, 0);
  // Track last-pushed value so visibility-driven re-syncs (below) can detect
  // when the desktop main process has fallen out of step with the renderer
  // and quietly reassert the correct state without spamming IPC.
  this._lastDesktopBadge = total > 0;
  window.havenDesktop?.setUnreadBadge?.(total > 0);
},

// Re-assert the desktop badge state when the window/tab regains focus.
// Catches the case where a stale "true" badge in the main process never
// got cleared because the renderer that originally raised it was destroyed
// or hot-reloaded without the corresponding clear IPC.  Also covers
// renderers that started before the main process finished wiring badge
// IPC handlers.  Idempotent — sends the current truth, no diff needed.
_resyncDesktopBadgeOnFocus() {
  if (this._desktopBadgeFocusBound) return;
  this._desktopBadgeFocusBound = true;
  const resync = () => {
    if (document.hidden) return;
    // Clear stale unread badge on the channel the user is actively viewing.
    // When the page is hidden (backgrounded BrowserView, alt-tab, minimise)
    // incoming messages bump unreadCounts even though the user was already
    // at the bottom — because isActivelyViewing = false in the new-message
    // handler.  The badge-clearing path inside that handler only fires when
    // a *new* message arrives while visible, so if no message arrives after
    // the user returns the "N unread" badge is stuck until someone else
    // types.  Fix: as soon as the window becomes visible again, if the user
    // is still coupled to the bottom of the current channel, treat those
    // messages as read immediately. (#phantom-badge-on-focus-return)
    if (this.currentChannel && this._coupledToBottom && this.unreadCounts?.[this.currentChannel]) {
      const code = this.currentChannel;
      const ch = this.channels?.find(c => c.code === code);
      const latestId = ch?.latestMessageId || this._newestMsgId;
      this.unreadCounts[code] = 0;
      try { this._updateBadge?.(code); } catch (err) { console.warn('[Channels] _updateBadge failed', err); }
      try { this._updateDmSectionBadge?.(); } catch (err) { console.warn('[Channels] _updateDmSectionBadge failed', err); }
      try { this._updateTabTitle?.(); } catch (err) { console.warn('[Channels] _updateTabTitle failed', err); }
      if (latestId) {
        try { this.socket.emit('mark-read', { code, messageId: latestId }); } catch (err) { console.warn('[Channels] could not mark the channel read', err); }
      }
    }
    try { this._updateDesktopBadge(); } catch (err) { console.warn('[Channels] _updateDesktopBadge failed', err); }
  };
  window.addEventListener('focus', resync);
  document.addEventListener('visibilitychange', resync);
},

/**
 * Fire a native OS notification (toast) for an incoming message.
 * Desktop app: always uses havenDesktop.notify() (Electron native).
 * Browser: uses Notification API only when push subscription is NOT active
 *          to avoid duplicate notifications (server-side push handles the rest).
 */
_fireNativeNotification(message, channelCode, opts) {
  // Server-level mute: suppress all notifications from this server instance.
  if (localStorage.getItem('haven_server_muted') === '1') return;
  // Per-channel mute: client-side muted channels list (defense-in-depth — callers
  // should also check, but bots / webhooks have user_id=null which can slip through
  // edge cases such as channels-list re-seeding or future notification paths).
  const _mutedChsNotif = JSON.parse(localStorage.getItem('haven_muted_channels') || '[]');
  if (_mutedChsNotif.includes(channelCode)) return;
  // Check per-type notification toggles
  const n = this.notifications;
  if (opts && opts.isMention && n.mentionsEnabled) { /* allowed */ }
  else if (opts && opts.isReply && n.repliesEnabled) { /* allowed */ }
  else if (opts && opts.isDm && n.dmEnabled) { /* allowed */ }
  else if (!n.enabled) return;
  // Don't notify for own messages
  if (message.user_id === this.user?.id) return;
  // Opt-in pop-up rate limit — throttle the visible banner (the sound already
  // played via notifications.play() at the call site; unread badges are
  // untouched). Off by default. (limit how often notifications pop the app)
  if (!this.notifications.popupAllowed()) return;

  const sender = this._getNickname(message.user_id, message.username);
  const channel = this.channels?.find(c => c.code === channelCode);
  const channelLabel = channel?.is_dm ? 'DM' : `#${channel?.name || channelCode}`;
  const title = t('notifications_runtime.title', { sender, channel: channelLabel });
  let rawContent = message.content || '';
  // A Discord emote token reads as its :name: in a notification.
  rawContent = rawContent.replace(/<a?:([A-Za-z0-9_]{2,32}):\d{15,25}>/g, ':$1:');
  // Detect E2E encrypted envelope — show generic text instead of ciphertext
  try { const p = JSON.parse(rawContent); if (p && p.v && p.ct) rawContent = ''; } catch { /* not JSON */ }
  // Burn-after-read: never reveal the message content in a notification
  if (message.burn_seconds && message.burn_seconds > 0) rawContent = t('notifications_runtime.burn_message');
  const body = rawContent.length > 120
    ? rawContent.slice(0, 117) + '...'
    : (rawContent || t('notifications_runtime.sent_message'));

  // Desktop app: always use native Electron notifications
  if (window.havenDesktop?.notify) {
    window.havenDesktop.notify(title, body, { silent: true, channelCode });
    return;
  }

  // Browser: skip if push subscription is active (server sends push instead)
  if (this._pushSubscription) return;

  // Browser Notification API fallback
  if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    try {
      const n = new Notification(title, {
        body,
        tag: `haven-${channelCode}`,
        renotify: true,
        silent: true,
        icon: '/uploads/server-icon.png',
      });
      n.onclick = () => {
        window.focus();
        this.switchChannel(channelCode);
        n.close();
      };
      // Auto-close after 5 seconds
      setTimeout(() => n.close(), 5000);
    } catch { /* Notification constructor can throw in some contexts */ }
  }
},

_updateDmSectionBadge() {
  const badge = document.getElementById('dm-unread-badge');
  if (!badge) return;
  const dmChannels = (this.channels || []).filter(c => c.is_dm);
  const total = dmChannels.reduce((sum, ch) => sum + (this.unreadCounts[ch.code] || 0), 0);
  if (total > 0) {
    badge.textContent = total > 99 ? '99+' : total;
    badge.style.display = '';
  } else {
    badge.textContent = '';
    badge.style.display = 'none';
  }
},

_updateChannelVoiceIndicators() {
  this._labelCallButton?.();
  document.querySelectorAll('.channel-item').forEach(el => {
    const code = el.dataset.code;
    let indicator = el.querySelector('.channel-voice-indicator');
    const count = this.voiceCounts[code] || 0;
    const users = this.voiceChannelUsers[code] || [];

    if (count > 0) {
      if (!indicator) {
        indicator = document.createElement('span');
        indicator.className = 'channel-voice-indicator';
        // Insert before the ⋯ button so they don't overlap
        const moreBtn = el.querySelector('.channel-more-btn');
        if (moreBtn) el.insertBefore(indicator, moreBtn);
        else el.appendChild(indicator);
      }
      indicator.innerHTML = `<span class="voice-icon">${el.classList.contains('dm-item') ? '📞' : '🔊'}</span>${count}`;

      // Render voice user list below the channel item
      let userList = el.nextElementSibling;
      if (!userList || !userList.classList.contains('channel-voice-users')) {
        userList = document.createElement('div');
        userList.className = 'channel-voice-users';
        el.after(userList);
      }
      userList.innerHTML = users.map(u => {
        const isSelf = u.id === this.user.id;
        // Self-talking state is driven by the local analyser directly (not
        // server echo), so talkingState.get('self') reflects real-time mic level.
        const isTalking = this.voice && ((isSelf && this.voice.talkingState.get('self')) || this.voice.talkingState.get(u.id));
        const botBadge = u.isBot ? '<span class="bot-badge">BOT</span>' : '';
        return `<div class="channel-voice-user${isTalking ? ' talking' : ''}" data-user-id="${u.id}" data-is-bot="${u.isBot ? 'true' : 'false'}" data-username="${this._escapeHtml(u.username)}"><span class="cvu-mic${u.isMuted ? ' is-muted' : ''}" title="${u.isMuted ? 'Muted' : ''}">🎙️</span><span class="cvu-deafen${u.isDeafened ? ' is-deafened' : ''}" title="${u.isDeafened ? 'Deafened' : ''}">🔊</span>${this._escapeHtml(u.username)}${botBadge}</div>`;
      }).join('');
      // Right-click on a left-sidebar voice user → same voice options menu
      userList.querySelectorAll('.channel-voice-user').forEach(item => {
        item.addEventListener('contextmenu', (e) => {
          const userId = parseInt(item.dataset.userId);
          if (isNaN(userId) || userId === this.user.id || item.dataset.isBot === 'true') return;
          e.preventDefault();
          e.stopPropagation();
          this._showVoiceUserMenu(item, userId, item.dataset.username || '');
        });
      });
    } else {
      if (indicator) indicator.remove();
      // Remove voice user list
      const userList = el.nextElementSibling;
      if (userList && userList.classList.contains('channel-voice-users')) {
        userList.remove();
      }
    }
  });
},

};
