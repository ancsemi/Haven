// "Move here as thread": while picking messages to move, a button at the
// bottom right of the message under the pointer puts the selected messages
// in a thread under it. Right-click (or a long press on a touch screen) gives
// the same action in a short menu, for keyboards and phones.
//
// The message can be in another channel too: the Move dialog's "Into a
// thread..." on a channel switches there and keeps the selection, and the
// same button (or a tap on a message) picks the one to put them under. The
// server checks everything again (src/moveToThread.js).

export default {

_initMoveToThread() {
  const box = document.getElementById('messages');
  if (!box) return;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'move-thread-here-btn';
  btn.title = t('modals.move_messages.here_as_thread_title');
  btn.innerHTML = `<span aria-hidden="true">🧵</span><span>${this._escapeHtml(t('modals.move_messages.here_as_thread'))}</span>`;
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const row = this._moveThreadRowOf(btn.parentElement);
    if (row) this._moveSelectedIntoThread(row);
  });
  this._moveThreadBtn = btn;

  box.addEventListener('mouseover', (e) => {
    if (!this._moveSelectionActive) return;
    const row = this._moveThreadRowOf(e.target);
    if (row) this._placeMoveThreadBtn(row);
  });
  box.addEventListener('mouseleave', () => this._hideMoveThreadBtn());

  // Capture, so a forum card's own menu and the chat menu stay out of it.
  box.addEventListener('contextmenu', (e) => {
    if (!this._moveSelectionActive) return;
    const row = this._moveThreadRowOf(e.target);
    if (!row) return;
    e.preventDefault();
    e.stopPropagation();
    // A long press already opened it; Android sends a contextmenu as well.
    if (Date.now() - (this._moveThreadMenuAt || 0) < 800) return;
    this._showMoveThreadMenu(e.clientX, e.clientY, row);
  }, true);

  // A long press on a touch screen, which has no hover and, on iOS, no
  // contextmenu event.
  let timer = null;
  let start = null;
  let openedByTouch = false;
  const cancel = () => { clearTimeout(timer); timer = null; };
  box.addEventListener('touchstart', (e) => {
    if (!this._moveSelectionActive || e.touches.length !== 1) return;
    const row = this._moveThreadRowOf(e.target);
    if (!row) return;
    start = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    cancel();
    timer = setTimeout(() => {
      timer = null;
      openedByTouch = true;
      this._showMoveThreadMenu(start.x, start.y, row);
      if (navigator.vibrate) navigator.vibrate(15);
    }, 550);
  }, { passive: true });
  box.addEventListener('touchmove', (e) => {
    if (!timer || !start) return;
    const p = e.touches[0];
    if (Math.hypot(p.clientX - start.x, p.clientY - start.y) > 10) cancel();
  }, { passive: true });
  const end = () => {
    cancel();
    // The tap the finger leaves behind must not toggle the message or close
    // the menu it just opened.
    if (openedByTouch) this._moveThreadSwallowUntil = Date.now() + 450;
    openedByTouch = false;
  };
  box.addEventListener('touchend', end, { passive: true });
  box.addEventListener('touchcancel', end, { passive: true });

  this.socket.on('messages-threaded', (data) => this._onMessagesThreaded(data));
},

// A message row in the channel feed or a forum card, or null.
_moveThreadRowOf(el) {
  const row = el?.closest?.('.message, .message-compact, .forum-topic');
  if (!row || !row.dataset.msgId || !row.closest('#messages')) return null;
  return row;
},

// A tap or click that belongs to a long press just handled.
_moveThreadSwallowing() {
  return Date.now() < (this._moveThreadSwallowUntil || 0);
},

// Viewing another channel than the one the selection is in: the next message
// picked is the one to put them under.
_moveThreadPickingHere() {
  return !!(this._moveSelectionActive && this._moveSourceChannel && this.currentChannel !== this._moveSourceChannel);
},

_moveThreadUsable(row) {
  if (!this._moveSelectionActive || !this._moveSelectedIds.size || !row) return false;
  // Replies picked in a thread only go back to its channel (app-unthread.js).
  if (this._moveSourceThread) return false;
  const id = parseInt(row.dataset.msgId, 10);
  return !!id && !this._moveSelectedIds.has(id);
},

_placeMoveThreadBtn(row) {
  const btn = this._moveThreadBtn;
  if (!btn) return;
  if (!this._moveThreadUsable(row)) { this._hideMoveThreadBtn(); return; }
  if (btn.parentElement !== row) row.appendChild(btn);
},

_hideMoveThreadBtn() {
  this._moveThreadBtn?.remove();
},

// After the selection or the channel changed: the button, the bar's text,
// and which of its buttons apply.
_syncMoveThreadUi() {
  const host = this._moveThreadRowOf(this._moveThreadBtn?.parentElement);
  if (host && !this._moveThreadUsable(host)) this._hideMoveThreadBtn();
  const picking = this._moveThreadPickingHere();
  document.body.classList.toggle('move-thread-picking', picking);
  const moveBtn = document.getElementById('move-msg-move-btn');
  const deleteBtn = document.getElementById('move-msg-delete-btn');
  if (moveBtn) moveBtn.style.display = picking ? 'none' : '';
  if (deleteBtn) deleteBtn.style.display = picking ? 'none' : '';
  const countEl = document.getElementById('move-msg-count');
  const n = this._moveSelectedIds.size;
  const ch = this.channels?.find(c => c.code === this.currentChannel);
  if (countEl) countEl.textContent = picking ? t('modals.move_messages.pick_base', { n, name: ch ? ch.name : '' }) : t('modals.move_messages.selected', { n });
},

// The Move dialog's "Into a thread..." on another channel: go there and keep
// the selection.
_startMoveThreadPick(code) {
  if (!this._moveSelectionActive || !this._moveSelectedIds.size) return;
  const modal = document.getElementById('move-msg-modal');
  if (modal) modal.style.display = 'none';
  this._moveThreadPickTarget = code;
  this.switchChannel(code);
  this._syncMoveThreadUi();
},

// Called on every channel switch: keep the selection only while picking a
// message in another channel, never into a DM.
_moveThreadKeepsSelection(code) {
  if (!this._moveSelectionActive || !this._moveThreadPickTarget) return false;
  const ch = this.channels?.find(c => c.code === code);
  return !!ch && !ch.is_dm;
},

_endMoveThreadPick() {
  this._moveThreadPickTarget = null;
  this._hideMoveThreadBtn();
  document.body.classList.remove('move-thread-picking');
  const moveBtn = document.getElementById('move-msg-move-btn');
  const deleteBtn = document.getElementById('move-msg-delete-btn');
  if (moveBtn) moveBtn.style.display = '';
  if (deleteBtn) deleteBtn.style.display = '';
},

// Rows drawn while selecting (going back to the channel, loading older
// messages) get their highlight back.
_watchMoveSelection(on) {
  if (!on) {
    this._moveSelObserver?.disconnect();
    this._moveSelObserver = null;
    return;
  }
  const box = document.getElementById('messages');
  const thread = document.getElementById('thread-messages');
  if (this._moveSelObserver || !box || typeof MutationObserver === 'undefined') return;
  this._moveSelObserver = new MutationObserver((records) => {
    if (!this._moveSelectionActive || !this._moveSelectedIds.size) return;
    for (const rec of records) {
      for (const node of rec.addedNodes) {
        if (node.nodeType !== 1 || node === this._moveThreadBtn) continue;
        const rows = node.matches('.message, .message-compact, .forum-topic, .thread-message') ? [node]
          : [...node.querySelectorAll('.message, .message-compact, .forum-topic, .thread-message')];
        for (const row of rows) {
          if (this._moveSelectedIds.has(parseInt(row.dataset.msgId, 10))) row.classList.add('move-selected');
        }
      }
    }
  });
  this._moveSelObserver.observe(box, { childList: true, subtree: true });
  // The thread panel too, for replies picked there (app-unthread.js).
  if (thread) this._moveSelObserver.observe(thread, { childList: true, subtree: true });
},

async _moveSelectedIntoThread(row) {
  const rootId = parseInt(row.dataset.msgId, 10);
  const n = this._moveSelectedIds.size;
  if (!rootId || !n || this._moveThreadBusy) return;
  if (this._moveSelectedIds.has(rootId)) {
    this._showToast(t('modals.move_messages.thread_base_selected'), 'error');
    return;
  }
  const userId = parseInt(row.dataset.userId, 10);
  const name = (row.dataset.username && this._getNickname ? this._getNickname(userId, row.dataset.username) : row.dataset.username)
    || t('thread_runtime.starter');
  const ok = await this._showConfirmModal(
    t(n === 1 ? 'modals.move_messages.thread_confirm_one' : 'modals.move_messages.thread_confirm_many', { n, name }),
    t('modals.move_messages.thread_confirm_hint'),
    { confirmLabel: t('modals.move_messages.thread_confirm_btn') }
  );
  if (!ok || !this._moveSelectionActive) return;
  this._moveThreadBusy = true;
  this.socket.emit('move-messages-to-thread', {
    code: this._moveSourceChannel || this.currentChannel,
    rootId,
    messageIds: [...this._moveSelectedIds],
  }, (resp) => {
    this._moveThreadBusy = false;
    if (!resp || resp.error) {
      this._showToast((resp && resp.error) || t('modals.move_messages.thread_failed'), 'error');
      return;
    }
    this._showToast(t(resp.moved === 1 ? 'modals.move_messages.threaded_one' : 'modals.move_messages.threaded_many', { n: resp.moved }), 'success');
    this._exitMoveSelectionMode();
  });
},

// The short menu for right-click and long press while selecting: select or
// deselect (in the selection's own channel), and Move here as thread.
_showMoveThreadMenu(x, y, row) {
  this._hideMessageContextMenu?.();
  const id = parseInt(row.dataset.msgId, 10);
  if (!id) return;
  const items = [];
  if (!this._moveThreadPickingHere()) {
    const selected = this._moveSelectedIds.has(id);
    items.push(`<button class="channel-ctx-item" data-action="toggle">☑️ <span>${this._escapeHtml(t(selected ? 'modals.move_messages.deselect' : 'modals.move_messages.select'))}</span></button>`);
  }
  if (this._moveThreadUsable(row)) {
    items.push(`<button class="channel-ctx-item" data-action="thread">🧵 <span>${this._escapeHtml(t('modals.move_messages.here_as_thread'))}</span></button>`);
  }
  if (!items.length) return;

  const menu = document.createElement('div');
  menu.id = 'message-context-menu';
  menu.className = 'channel-ctx-menu';
  menu.innerHTML = items.join('');
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = Math.max(8, window.innerWidth - rect.width - 8) + 'px';
  if (rect.bottom > window.innerHeight) menu.style.top = Math.max(8, window.innerHeight - rect.height - 8) + 'px';
  this._moveThreadMenuAt = Date.now();

  menu.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-action]');
    if (!btn || this._moveThreadSwallowing()) return;
    this._hideMessageContextMenu();
    if (btn.dataset.action === 'toggle') {
      this._toggleMoveSelect(row);
      this._lastMoveSelectedEl = row;
    } else if (btn.dataset.action === 'thread') {
      this._moveSelectedIntoThread(row);
    }
  });
  const closer = (ev) => {
    if (this._moveThreadSwallowing()) return;
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

// Messages went into a thread (here or from another channel): an open
// thread panel for it, or for a thread that was folded into it, reloads,
// and a forum showing either channel redraws its cards.
_onMessagesThreaded(data) {
  if (!data) return;
  const parentId = Number(data.parentId);
  const absorbed = (data.absorbedRoots || []).map(Number);
  const panel = document.getElementById('thread-panel');
  const open = !!panel && panel.style.display !== 'none';
  const active = Number(this._activeThreadParent);
  if (open && active) {
    if (active === parentId) this.socket.emit('get-thread-messages', { parentId });
    else if (absorbed.includes(active)) this._openThread(parentId);
  }
  // Those are no longer threads, so no markers of their own.
  for (const id of absorbed) this._clearThreadUnread?.(id);
  if (this._forumActive && (data.channelCode === this.currentChannel || data.fromChannel === this.currentChannel)) {
    this._forumReload?.();
  }
},

};
