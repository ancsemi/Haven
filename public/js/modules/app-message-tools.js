// Tools that act on messages: the pinned messages panel and its pop-out,
// moving and bulk-deleting messages, the message right-click menu, and
// editing the tags on a message's attachments.

export default {

// ── Pinned Messages Panel ─────────────────────────────

_renderPinnedPanel(pins) {
  // Always cache the latest pin list — used by the pop-out button and by
  // the PiP to refresh after a pin/unpin event without a full re-open.
  this._lastPins = pins;

  const panel = document.getElementById('pinned-panel');
  const list = document.getElementById('pinned-list');
  const count = document.getElementById('pinned-count');

  count.textContent = `📌 ${t(pins.length !== 1 ? 'pinned_panel.count_other' : 'pinned_panel.count_one', { count: pins.length })}`;

  const canUnpin = this.user?.isAdmin || this._hasPerm('pin_message');

  if (pins.length === 0) {
    list.innerHTML = `<p class="muted-text" style="padding:12px">${t('pinned_panel.no_messages')}</p>`;
  } else {
    list.innerHTML = pins.map(p => `
      <div class="pinned-item" data-msg-id="${p.id}">
        <div class="pinned-item-header">
          <span class="pinned-item-author" style="color:${this._getUserColor(p.username)}">${this._escapeHtml(this._getNickname(p.user_id, p.username))}</span>
          <span class="pinned-item-time">${this._formatTime(p.created_at)}</span>
        </div>
        <div class="pinned-item-content">${this._formatContent(p.content)}</div>
        <div class="pinned-item-footer" style="display:flex;align-items:center;justify-content:space-between">
          <span>${t('pinned_panel.pinned_by', { user: this._escapeHtml(p.pinned_by) })}</span>
          ${canUnpin ? `<button class="pinned-unpin-btn btn-xs" data-msg-id="${p.id}" title="${this._escapeHtml(t('msg_toolbar.unpin'))}">${this._escapeHtml(t('msg_toolbar.unpin'))}</button>` : ''}
        </div>
      </div>
    `).join('');
  }

  // When this render was triggered by a PiP auto-refresh (message-pinned
  // event), skip showing/re-showing the sidebar panel — only update it if
  // the user already has it visible.
  const silentRefresh = this._pinsPipSilentRefresh;
  this._pinsPipSilentRefresh = false;
  if (silentRefresh) {
    if (panel.style.display === 'block') {
      // Sidebar is already open — re-wire its click handlers to the fresh DOM
      this._rewirePinnedSidebarHandlers(list, panel);
    }
  } else {
    panel.style.display = 'block';
    this._rewirePinnedSidebarHandlers(list, panel);
  }

  // If the PiP is currently open, refresh it with the latest pin data too.
  const pipPanel = document.getElementById('pins-pip-panel');
  if (pipPanel && pipPanel.style.display !== 'none') {
    this._renderPinsPiPList(pins);
  }
},

// Wire the sidebar pinned-panel click handlers.  Extracted so both the
// normal open path and the silent-refresh path can call it without
// repeating code.
_rewirePinnedSidebarHandlers(list, panel) {
  // Click to scroll to pinned message (uses _jumpToMessage to handle
  // messages that have been trimmed from the DOM)
  list.querySelectorAll('.pinned-item').forEach(item => {
    item.addEventListener('click', () => {
      const msgId = parseInt(item.dataset.msgId, 10);
      panel.style.display = 'none';
      if (msgId) this._jumpToMessage(msgId);
    });
  });

  // Unpin buttons — stop propagation so click doesn't also jump to message
  list.querySelectorAll('.pinned-unpin-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const msgId = parseInt(btn.dataset.msgId, 10);
      if (!msgId) return;
      const ok = await this._showConfirmModal(t('confirm.unpin_message'), '');
      if (ok) this.socket.emit('unpin-message', { messageId: msgId });
    });
  });
},

// ── Pinned Messages PiP ───────────────────────────────

/** Open the floating PiP overlay for pinned messages. */
_openPinsPiP(pins) {
  const panel = document.getElementById('pins-pip-panel');
  if (!panel) return;
  this._pinsPipChannelCode = this.currentChannel;
  panel.style.display = 'flex';

  // Title: channel name
  const titleEl = document.getElementById('pins-pip-title');
  if (titleEl) {
    const ch = (this.channels || []).find(c => c.code === this.currentChannel);
    titleEl.textContent = ch ? `# ${ch.name}` : (this.currentChannel || t('status_bar.channel'));
  }

  this._renderPinsPiPList(pins || []);
  this._applyPinsPiPGeometry(panel);
  this._bindPinsPiPDrag();
},

/** Close the pinned messages PiP. */
_closePinsPiP() {
  this._pinsPipChannelCode = null;
  const panel = document.getElementById('pins-pip-panel');
  if (panel) panel.style.display = 'none';
},

/** Render the pin list inside the PiP overlay.
 *  Uses delegated click handlers (wired once in app-ui.js) — no inline
 *  event listeners attached here to avoid double-binding on refresh. */
_renderPinsPiPList(pins) {
  const list = document.getElementById('pins-pip-list');
  if (!list) return;
  const canUnpin = this.user?.isAdmin || this._hasPerm('pin_message');
  if (!pins || pins.length === 0) {
    list.innerHTML = `<p class="muted-text" style="padding:12px">${t('pinned_panel.no_messages')}</p>`;
    return;
  }
  list.innerHTML = pins.map(p => `
    <div class="pinned-item" data-msg-id="${p.id}">
      <div class="pinned-item-header">
        <span class="pinned-item-author" style="color:${this._getUserColor(p.username)}">${this._escapeHtml(this._getNickname(p.user_id, p.username))}</span>
        <span class="pinned-item-time">${this._formatTime(p.created_at)}</span>
      </div>
      <div class="pinned-item-content">${this._formatContent(p.content)}</div>
      <div class="pinned-item-footer" style="display:flex;align-items:center;justify-content:space-between">
        <span>${t('pinned_panel.pinned_by', { user: this._escapeHtml(p.pinned_by) })}</span>
        ${canUnpin ? `<button class="pinned-unpin-btn btn-xs" data-msg-id="${p.id}" title="${this._escapeHtml(t('msg_toolbar.unpin'))}">${this._escapeHtml(t('msg_toolbar.unpin'))}</button>` : ''}
      </div>
    </div>
  `).join('');
},

/** Restore saved PiP position + size from localStorage. */
_applyPinsPiPGeometry(panel) {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem('haven_pins_pip_rect') || 'null'); } catch { /* corrupt saved position: use the default placement */ }
  const minW = 280, minH = 220;
  const maxW = Math.min(600, window.innerWidth - 28);
  const maxH = Math.max(minH, window.innerHeight - 28);
  const width  = Math.max(minW, Math.min(maxW, (saved && saved.width)  || 360));
  const height = Math.max(minH, Math.min(maxH, (saved && saved.height) || 440));
  const defaultLeft = Math.max(0, window.innerWidth  - width  - 20);
  const defaultTop  = Math.max(0, window.innerHeight - height - 80);
  const left = Math.max(0, Math.min(window.innerWidth  - width,  (saved && Number.isFinite(saved.left)) ? saved.left : defaultLeft));
  const top  = Math.max(0, Math.min(window.innerHeight - height, (saved && Number.isFinite(saved.top))  ? saved.top  : defaultTop));
  panel.style.width  = `${Math.round(width)}px`;
  panel.style.height = `${Math.round(height)}px`;
  panel.style.left   = `${Math.round(left)}px`;
  panel.style.top    = `${Math.round(top)}px`;
},

/** Bind drag-to-move on the PiP header (called once). */
_bindPinsPiPDrag() {
  if (this._pinsPipDragBound) return;
  this._pinsPipDragBound = true;
  const panel = document.getElementById('pins-pip-panel');
  if (!panel) return;
  const header = panel.querySelector('.pins-pip-header');
  if (!header) return;
  let startX = 0, startY = 0, startLeft = 0, startTop = 0, dragging = false;
  header.addEventListener('mousedown', (e) => {
    if (e.target.closest('button, a')) return;
    if (panel.classList.contains('pins-pip-maximized')) return;
    dragging = true;
    startX = e.clientX; startY = e.clientY;
    const r = panel.getBoundingClientRect();
    startLeft = r.left; startTop = r.top;
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const w = panel.offsetWidth, h = panel.offsetHeight;
    const left = Math.max(0, Math.min(window.innerWidth  - w, startLeft + (e.clientX - startX)));
    const top  = Math.max(0, Math.min(window.innerHeight - h, startTop  + (e.clientY - startY)));
    panel.style.left = `${left}px`;
    panel.style.top  = `${top}px`;
  });
  const persist = () => {
    if (!panel || panel.style.display === 'none') return;
    try {
      localStorage.setItem('haven_pins_pip_rect', JSON.stringify({
        left:   parseInt(panel.style.left,  10) || 0,
        top:    parseInt(panel.style.top,   10) || 0,
        width:  panel.offsetWidth,
        height: panel.offsetHeight
      }));
    } catch { /* storage blocked (private mode): nothing is remembered, nothing else breaks */ }
  };
  window.addEventListener('mouseup', () => {
    if (dragging) { dragging = false; persist(); }
  });
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => persist());
    ro.observe(panel);
  }
},

// ── Move Messages (multi-select) ──────────────────────

_moveSelectionActive: false,
_moveSelectedIds: new Set(),

_enterMoveSelectionMode() {
  if (this._moveSelectionActive) return;
  this._moveSelectionActive = true;
  this._moveSelectedIds.clear();
  document.body.classList.add('move-selection-mode');
  const toolbar = document.getElementById('move-msg-toolbar');
  if (toolbar) toolbar.style.display = 'flex';
  this._updateMoveCount();
},

_exitMoveSelectionMode() {
  this._moveSelectionActive = false;
  this._moveSelectedIds.clear();
  this._lastMoveSelectedEl = null;
  document.body.classList.remove('move-selection-mode');
  const toolbar = document.getElementById('move-msg-toolbar');
  if (toolbar) toolbar.style.display = 'none';
  document.querySelectorAll('.move-selected').forEach(el => el.classList.remove('move-selected'));
},

_toggleMoveSelect(msgEl) {
  if (!this._moveSelectionActive) return;
  const id = parseInt(msgEl.dataset.msgId);
  if (!id) return;
  if (this._moveSelectedIds.has(id)) {
    this._moveSelectedIds.delete(id);
    msgEl.classList.remove('move-selected');
  } else {
    if (this._moveSelectedIds.size >= 200) {
      this._showToast(t('modals.move_messages.max_messages', { max: 200 }), 'error');
      return;
    }
    this._moveSelectedIds.add(id);
    msgEl.classList.add('move-selected');
  }
  this._updateMoveCount();
},

_updateMoveCount() {
  const countEl = document.getElementById('move-msg-count');
  const moveBtn = document.getElementById('move-msg-move-btn');
  const deleteBtn = document.getElementById('move-msg-delete-btn');
  const n = this._moveSelectedIds.size;
  if (countEl) countEl.textContent = t('modals.move_messages.selected', { n });
  if (moveBtn) moveBtn.disabled = n === 0;
  if (deleteBtn) deleteBtn.disabled = n === 0;
},

_showMoveChannelPicker() {
  if (this._moveSelectedIds.size === 0) return;
  const list = document.getElementById('move-msg-channel-list');
  const modal = document.getElementById('move-msg-modal');
  const desc = document.getElementById('move-msg-desc');
  if (!list || !modal) return;

  const _n = this._moveSelectedIds.size;
  desc.textContent = t(_n === 1 ? 'modals.move_messages.move_one' : 'modals.move_messages.move_many', { n: _n });
  list.innerHTML = '';

  const channels = (this.channels || []).filter(ch =>
    !ch.is_dm && ch.code !== this.currentChannel
  );

  if (channels.length === 0) {
    list.innerHTML = `<div class="move-msg-empty">${t('modals.move_messages.no_channels')}</div>`;
  } else {
    for (const ch of channels) {
      const item = document.createElement('button');
      item.className = 'move-msg-channel-item';
      item.textContent = `# ${ch.name}`;
      item.addEventListener('click', () => {
        this._executeMoveMessages(ch.code, ch.name);
        modal.style.display = 'none';
      });
      list.appendChild(item);
    }
  }

  modal.style.display = 'flex';
},

_executeMoveMessages(toCode, toName) {
  const ids = [...this._moveSelectedIds];
  const fromCode = this.currentChannel;

  this.socket.emit('move-messages', {
    messageIds: ids,
    fromChannel: fromCode,
    toChannel: toCode
  }, (resp) => {
    if (resp && resp.error) {
      this._showToast(resp.error, 'error');
    } else if (resp && resp.success) {
      this._showToast(t(resp.moved === 1 ? 'modals.move_messages.moved_one' : 'modals.move_messages.moved_many', { n: resp.moved, name: toName }), 'success');
    }
    this._exitMoveSelectionMode();
  });
},

async _executeDeleteMessages() {
  const n = this._moveSelectedIds.size;
  if (n === 0) return;
  const ok = await this._showConfirmModal(
    t(n === 1 ? 'modals.move_messages.delete_confirm_one' : 'modals.move_messages.delete_confirm_many', { n }),
    t('modals.move_messages.delete_confirm_warn'),
    { danger: true, confirmLabel: t('msg_toolbar.delete') }
  );
  if (!ok) return;

  const ids = [...this._moveSelectedIds];
  const code = this.currentChannel;
  // For E2E DMs the server can't read attachment URLs out of ciphertext, so
  // hand it the URLs per message the same way single-delete does. The move
  // selector is mod/non-DM gated today, but keep this future-proof.
  const attachmentsByMessage = {};
  for (const id of ids) {
    const urls = this._getMessageAttachments?.(id);
    if (Array.isArray(urls) && urls.length) attachmentsByMessage[id] = urls;
  }

  this.socket.emit('delete-messages', {
    code,
    messageIds: ids,
    attachmentsByMessage
  }, (resp) => {
    if (resp && resp.error && !resp.deleted) {
      this._showToast(resp.error, 'error');
    } else if (resp && resp.success) {
      const deleted = resp.deleted || 0;
      const skipped = resp.skipped || 0;
      if (skipped > 0) {
        this._showToast(t('modals.move_messages.deleted_partial', { n: deleted, skipped }), 'warning');
      } else {
        this._showToast(t(deleted === 1 ? 'modals.move_messages.deleted_one' : 'modals.move_messages.deleted_many', { n: deleted }), 'success');
      }
    }
    this._exitMoveSelectionMode();
  });
},

_initMoveMessages() {
  // Header "Select messages" toggle button
  const selectBtn = document.getElementById('move-select-btn');
  if (selectBtn) selectBtn.addEventListener('click', () => {
    if (this._moveSelectionActive) this._exitMoveSelectionMode();
    else this._enterMoveSelectionMode();
  });

  // "Move to..." button in toolbar
  const moveBtn = document.getElementById('move-msg-move-btn');
  if (moveBtn) moveBtn.addEventListener('click', () => this._showMoveChannelPicker());

  // "Delete" button in toolbar (#5460)
  const deleteBtn = document.getElementById('move-msg-delete-btn');
  if (deleteBtn) deleteBtn.addEventListener('click', () => this._executeDeleteMessages());

  // Cancel button in toolbar
  const cancelBtn = document.getElementById('move-msg-cancel-btn');
  if (cancelBtn) cancelBtn.addEventListener('click', () => this._exitMoveSelectionMode());

  // Cancel button in modal
  const modalCancel = document.getElementById('move-msg-modal-cancel');
  if (modalCancel) modalCancel.addEventListener('click', () => {
    document.getElementById('move-msg-modal').style.display = 'none';
  });

  // Close modal on overlay click
  const modal = document.getElementById('move-msg-modal');
  if (modal) modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.style.display = 'none';
  });
},

/* ── Message right-click context menu (main #messages pane) ───────────
   A right-click twin of the hover toolbar carrying the same set of actions
   (edit, reply, quote, pin, react, thread, copy-link, archive, delete). It
   calls the exact same underlying methods the toolbar dispatch does (no new
   API surface), gates each item on the same permissions the toolbar uses, and
   borrows the channel context menu's CSS classes (.channel-ctx-menu /
   .channel-ctx-item / .channel-ctx-sep / .danger) so it inherits every
   theme — including win95 — for free. Cursor-positioned and self-closing,
   modelled on _showImageContextMenu. */
_showMessageContextMenu(e, msgEl) {
  this._hideMessageContextMenu();
  const msgId = parseInt(msgEl.dataset.msgId, 10);
  if (!msgId) return;

  const curCh      = this.channels?.find(c => c.code === this.currentChannel);
  const isDm       = !!curCh?.is_dm;
  const isOwn      = String(msgEl.dataset.userId) === String(this.user?.id);
  const isPinned   = msgEl.dataset.pinned === '1'  || msgEl.classList.contains('pinned');
  const isArchived = msgEl.dataset.archived === '1' || msgEl.classList.contains('archived');
  const canPin       = !!(this.user?.isAdmin || this._hasPerm('pin_message'));
  const canArchive   = !!(this.user?.isAdmin || this._hasPerm('archive_messages'));
  const canShareLink = !isDm && !!this._canShareChannelLink?.(this.currentChannel);
  // Same level-vs-permission gap as the toolbar above (#5461).
  const canDelete    = isOwn || this.user?.isAdmin || this._canModerate() ||
                       this._hasPerm('delete_message');
  // Retroactive tag editing (#tagging phase 3): only on non-DM messages that
  // carry an upload. Your own always; anyone else's needs manage_tags.
  const hasAttachment = (this._getMessageAttachments?.(msgId) || []).length > 0;
  const canEditTags  = !isDm && hasAttachment &&
                       (isOwn || this.user?.isAdmin || this._hasPerm('manage_tags'));

  // Layout: the actions defined first (Edit, Reply, Quote, Pin) — separator —
  // the remaining hover-toolbar actions (React, Thread, Copy Link, Protect) —
  // separator — Delete. Every item carries the same data-action the toolbar
  // uses, and each action is gated on the same permission, so the two menus
  // stay behaviourally identical.
  const items = [];
  // First group (as originally defined)
  if (isOwn) items.push(`<button class="channel-ctx-item" data-action="edit">✏️ <span>${t('msg_toolbar.edit')}</span></button>`);
  items.push(`<button class="channel-ctx-item" data-action="reply">↩️ <span>${t('msg_toolbar.reply')}</span></button>`);
  items.push(`<button class="channel-ctx-item" data-action="quote">💬 <span>${t('msg_toolbar.quote')}</span></button>`);
  if (canPin) {
    items.push(isPinned
      ? `<button class="channel-ctx-item" data-action="unpin">📌 <span>${t('msg_toolbar.unpin')}</span></button>`
      : `<button class="channel-ctx-item" data-action="pin">📌 <span>${t('msg_toolbar.pin')}</span></button>`);
  }
  // Separator, then the rest of the hover-toolbar actions
  items.push('<hr class="channel-ctx-sep">');
  items.push(`<button class="channel-ctx-item" data-action="react">😀 <span>${t('msg_toolbar.react')}</span></button>`);
  if (!isDm) items.push(`<button class="channel-ctx-item" data-action="thread">🧵 <span>${t('msg_toolbar.thread')}</span></button>`);
  if (canShareLink) items.push(`<button class="channel-ctx-item" data-action="copy-link">🔗 <span>${t('msg_toolbar.copy_link')}</span></button>`);
  if (canArchive) {
    items.push(isArchived
      ? `<button class="channel-ctx-item" data-action="unarchive">🛡️ <span>${t('app.messages.unprotect_btn')}</span></button>`
      : `<button class="channel-ctx-item" data-action="archive">🛡️ <span>${t('app.messages.protect_btn')}</span></button>`);
  }
  // A posted role menu's roles, emojis and text can be changed later (#5644).
  const canEditRoleMenu = !!msgEl.querySelector('.role-menu-widget') &&
                          !!(this.user?.isAdmin || this._hasPerm('manage_roles') || this._hasPerm('promote_user'));
  if (canEditRoleMenu) items.push(`<button class="channel-ctx-item" data-action="edit-role-menu">🎭 <span>${t('settings.admin.role_menu.edit')}</span></button>`);
  if (canEditTags) items.push(`<button class="channel-ctx-item" data-action="edit-tags">🏷️ <span>${t('tags.edit')}</span></button>`);
  // Separator right above Delete
  if (canDelete) {
    items.push('<hr class="channel-ctx-sep">');
    items.push(`<button class="channel-ctx-item danger" data-action="delete">🗑️ <span>${t('msg_toolbar.delete')}</span></button>`);
  }

  const menu = document.createElement('div');
  menu.id = 'message-context-menu';
  menu.className = 'channel-ctx-menu';
  menu.innerHTML = items.join('');
  menu.style.left = e.clientX + 'px';
  menu.style.top  = e.clientY + 'px';
  document.body.appendChild(menu);

  // Clamp inside the viewport (same as the image/channel menus).
  const rect = menu.getBoundingClientRect();
  if (rect.right  > window.innerWidth)  menu.style.left = (window.innerWidth  - rect.width  - 8) + 'px';
  if (rect.bottom > window.innerHeight) menu.style.top  = (window.innerHeight - rect.height - 8) + 'px';

  menu.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    this._hideMessageContextMenu();
    if (action === 'edit') {
      this._startEditMessage(msgEl, msgId);
    } else if (action === 'reply') {
      this._setReply(msgEl, msgId);
    } else if (action === 'quote') {
      this._quoteMessage(msgEl);
    } else if (action === 'react') {
      this._showReactionPicker(msgEl, msgId);
    } else if (action === 'thread') {
      // Defence in depth — threads never exist in DMs.
      if (this.channels?.find(c => c.code === this.currentChannel)?.is_dm) {
        this._showToast?.(t('thread_list.unavailable_in_dm'), 'info');
      } else {
        this._openThread(msgId);
      }
    } else if (action === 'copy-link') {
      this._copyChannelLink(this.currentChannel, msgId);
    } else if (action === 'pin') {
      if (await this._showConfirmModal(t('confirm.pin_message'), '')) {
        this.socket.emit('pin-message', { messageId: msgId });
      }
    } else if (action === 'unpin') {
      this.socket.emit('unpin-message', { messageId: msgId });
    } else if (action === 'archive') {
      this.socket.emit('archive-message', { messageId: msgId });
    } else if (action === 'unarchive') {
      this.socket.emit('unarchive-message', { messageId: msgId });
    } else if (action === 'edit-role-menu') {
      this._openRoleMenuBuilder?.({ messageId: msgId });
    } else if (action === 'edit-tags') {
      this._openMessageTagEditor(msgId, msgEl);
    } else if (action === 'delete') {
      if (await this._showConfirmModal(t('confirm.delete_message'), '', { danger: true, confirmLabel: t('msg_toolbar.delete') })) {
        this.socket.emit('delete-message', { messageId: msgId, attachments: this._getMessageAttachments?.(msgId) });
      }
    }
  });

  // Dismiss on outside click, another right-click, or scroll of the pane —
  // mirrors the image context menu's self-closing lifecycle.
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

_hideMessageContextMenu() {
  const existing = document.getElementById('message-context-menu');
  if (existing) existing.remove();
  if (this._msgCtxCloser) {
    document.removeEventListener('click', this._msgCtxCloser, true);
    document.removeEventListener('contextmenu', this._msgCtxCloser, true);
    document.getElementById('messages')?.removeEventListener('scroll', this._msgCtxCloser, true);
    this._msgCtxCloser = null;
  }
},

// ── Retroactive tag editor (#tagging phase 3) ───────────────────────────────
// A small popup, opened from the message context menu, that edits the tag set
// on a message's attachment. Reuses the composer's tag primitives (server
// lookup, normalize, limits) and the shared .tag-* styles. Each change emits
// set-message-tags with the full set; the server replaces + broadcasts, and the
// message-tags-updated handler repaints every footer, including this one.
_openMessageTagEditor(msgId, msgEl, knownTags = null) {
  this._closeMessageTagEditor();
  if (!msgId) return;
  // Seed the working set from the message's current footer chips, or from the
  // list the caller already has (a forum card has no footer, #5682).
  const current = Array.isArray(knownTags) ? [...knownTags] : Array.from(msgEl?.querySelectorAll('.message-tags .message-tag') || [])
    .map(el => el.dataset.tag).filter(Boolean);
  this._msgTagEditor = { msgId, tags: current };

  const pop = document.createElement('div');
  pop.id = 'message-tag-editor';
  pop.className = 'tag-editor-popup';
  pop.innerHTML = `
    <div class="tag-editor-head">
      <span class="tag-editor-title">${t('tags.edit')}</span>
      <button type="button" class="tag-editor-close" aria-label="${t('media.remove')}">×</button>
    </div>
    <div class="tag-editor-chips" id="mte-chips"></div>
    <input id="mte-input" class="tag-popup-input" type="text" autocomplete="off" spellcheck="false"
           maxlength="${this._maxTagLen()}" placeholder="${this._escapeHtml(t('tags.search_placeholder'))}">
    <div id="mte-list" class="tag-popup-list"></div>`;
  document.body.appendChild(pop);

  // Anchor near the message; positioned (and flipped above when there is no
  // room below) once laid out, then re-clamped as async content changes height.
  this._msgTagEditorAnchor = msgEl || null;
  this._positionMessageTagEditor();

  pop.querySelector('.tag-editor-close').addEventListener('click', () => this._closeMessageTagEditor());
  const input = pop.querySelector('#mte-input');
  input.addEventListener('input', () => {
    clearTimeout(this._mteTimer);
    const q = input.value;
    this._mteTimer = setTimeout(() => this._msgTagEditorSearch(q), 250);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); this._closeMessageTagEditor(); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const first = pop.querySelector('#mte-list .tag-popup-item');
      if (first) first.click();
    }
  });
  // Outside-click closer (deferred so the opening click doesn't instantly close).
  this._mteCloser = (ev) => { if (!pop.contains(ev.target)) this._closeMessageTagEditor(); };
  setTimeout(() => document.addEventListener('click', this._mteCloser, true), 0);

  this._msgTagEditorRenderChips();
  this._msgTagEditorSearch('');
  input.focus();
},

_closeMessageTagEditor() {
  clearTimeout(this._mteTimer);
  document.getElementById('message-tag-editor')?.remove();
  if (this._mteCloser) { document.removeEventListener('click', this._mteCloser, true); this._mteCloser = null; }
  this._msgTagEditor = null;
  this._msgTagEditorAnchor = null;
},

// Place the editor below its anchor message, flipping above when the popup
// would overflow the viewport bottom (messages near the bottom of the list),
// and clamping horizontally. Re-run whenever the popup's height changes.
_positionMessageTagEditor() {
  const pop = document.getElementById('message-tag-editor');
  if (!pop) return;
  const anchor = this._msgTagEditorAnchor;
  const rect = (anchor || document.body).getBoundingClientRect();
  const margin = 8;
  const h = pop.offsetHeight;
  const w = pop.offsetWidth;
  let top = rect.bottom + 4;
  if (top + h > window.innerHeight - margin) {
    const above = rect.top - h - 4;
    top = above >= margin ? above : Math.max(margin, window.innerHeight - h - margin);
  }
  let left = Math.min(rect.left + 8, window.innerWidth - w - 12);
  left = Math.max(margin, left);
  pop.style.top = top + 'px';
  pop.style.left = left + 'px';
},

_msgTagEditorRenderChips() {
  const wrap = document.getElementById('mte-chips');
  if (!wrap || !this._msgTagEditor) return;
  wrap.innerHTML = '';
  this._msgTagEditor.tags.forEach(name => {
    const chip = document.createElement('span');
    chip.className = 'tag-chip';
    const label = document.createElement('span');
    label.className = 'tag-chip-label';
    label.textContent = name;
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'tag-chip-remove';
    rm.textContent = '×';
    rm.addEventListener('click', () => this._msgTagEditorRemove(name));
    chip.appendChild(label);
    chip.appendChild(rm);
    wrap.appendChild(chip);
  });
},

_msgTagEditorSearch(query) {
  const input = document.getElementById('mte-input');
  if (!input || !this.socket || !this._msgTagEditor) return;
  const q = query;
  this.socket.emit('search-upload-tags', { query: q }, (res) => {
    if (!this._msgTagEditor || input.value !== q) return;
    if (res && res.error === 'rate_limited') return;
    this._msgTagEditorRenderList(q, (res && res.tags) || []);
  });
},

_msgTagEditorRenderList(query, results) {
  const list = document.getElementById('mte-list');
  if (!list || !this._msgTagEditor) return;
  list.innerHTML = '';
  const applied = new Set(this._msgTagEditor.tags.map(x => x.toLocaleLowerCase()));
  const norm = this._normalizeTag(query);
  (results || []).filter(tg => !applied.has(String(tg.name).toLocaleLowerCase())).forEach(tg => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'tag-popup-item';
    item.textContent = tg.name;
    item.addEventListener('click', () => this._msgTagEditorAdd(tg.name));
    list.appendChild(item);
  });
  const exact = norm && (applied.has(norm.norm) || (results || []).some(tg => String(tg.name).toLocaleLowerCase() === norm.norm));
  if (norm && !exact && this._hasPerm && this._hasPerm('manage_tags')) {
    const create = document.createElement('button');
    create.type = 'button';
    create.className = 'tag-popup-item tag-popup-create';
    create.textContent = t('tags.add_new', { name: norm.name });
    create.addEventListener('click', () => this._msgTagEditorAdd(norm.name));
    list.appendChild(create);
  }
  if (!list.children.length) {
    const empty = document.createElement('div');
    empty.className = 'tag-popup-empty';
    empty.textContent = norm ? t('tags.none_found') : t('tags.none_yet');
    list.appendChild(empty);
  }
  // The list height just changed; re-anchor so a bottom message stays flipped.
  this._positionMessageTagEditor();
},

_msgTagEditorAdd(rawName) {
  if (!this._msgTagEditor) return;
  const norm = this._normalizeTag(rawName);
  if (!norm) return this._showToast(t('tags.invalid'), 'error');
  const tags = this._msgTagEditor.tags;
  if (tags.some(x => x.toLocaleLowerCase() === norm.norm)) return;
  if (tags.length >= this._maxTagsPerAttachment()) {
    return this._showToast(t('tags.limit_reached', { n: this._maxTagsPerAttachment() }), 'error');
  }
  tags.push(norm.name);
  const input = document.getElementById('mte-input');
  if (input) input.value = '';
  this._msgTagEditorRenderChips();
  this._msgTagEditorSearch('');
  this._msgTagEditorSave();
},

_msgTagEditorRemove(name) {
  if (!this._msgTagEditor) return;
  this._msgTagEditor.tags = this._msgTagEditor.tags.filter(x => x !== name);
  this._msgTagEditorRenderChips();
  this._msgTagEditorSearch(document.getElementById('mte-input')?.value || '');
  this._msgTagEditorSave();
},

// Push the full working set to the server. It replaces the message's tags and
// broadcasts message-tags-updated, which repaints every footer for this id.
_msgTagEditorSave() {
  if (!this._msgTagEditor || !this.socket) return;
  this.socket.emit('set-message-tags', { messageId: this._msgTagEditor.msgId, tags: this._msgTagEditor.tags });
},

// Repaint the Tags footer for every rendered copy of a message (main list,
// search results, thread, PiP) after a live tag change. (#tagging phase 3)
_updateMessageTagsFooter(msgId, tags) {
  const list = Array.isArray(tags) ? tags : [];
  const topic = this._forumTopics && this._forumTopics.get(msgId);
  if (topic) {
    topic.attachmentTags = list.length ? list : undefined;
    if (this._activeThreadParent === msgId) this._forumThreadRenderTopic?.();
  }
  document.querySelectorAll(`[data-msg-id="${msgId}"]`).forEach(el => {
    if (el.classList.contains('forum-topic')) return;
    const existing = el.querySelector('.message-tags');
    if (existing) existing.remove();
    if (!list.length) return;
    const html = this._renderAttachmentTags(list);
    if (!html) return;
    const tmp = document.createElement('template');
    tmp.innerHTML = html.trim();
    const node = tmp.content.firstChild;
    const anchor = el.querySelector('.reactions-row')
      || el.querySelector('.message-content, .search-result-content, .thread-msg-content');
    if (anchor && anchor.parentNode) anchor.insertAdjacentElement('afterend', node);
    else (el.querySelector('.message-body') || el).appendChild(node);
  });
  // Keep the render cache in sync so a scroll/re-render doesn't drop the change.
  const cached = (this._lastRenderedMessages || []).find(m => m && m.id === msgId);
  if (cached) cached.attachmentTags = list.length ? list : undefined;
},

};
