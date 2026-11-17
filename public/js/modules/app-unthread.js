// Taking replies out of a thread: while picking messages to move, replies in
// the open thread panel (docked or popped out) can be picked too, and Move
// to... then offers to put them back in the thread's channel as ordinary
// messages. The message the thread hangs from is never in the panel's list,
// so it cannot be picked. A selection is either channel messages or replies
// in one thread, never both. The server checks everything again
// (src/moveOutOfThread.js).

export default {

_initUnthread() {
  const box = document.getElementById('thread-messages');
  if (box) {
    // Capture, so a reply's own buttons and links stay out of it.
    box.addEventListener('click', (e) => {
      if (!this._moveSelectionActive) return;
      const row = e.target.closest('.thread-message');
      if (!row || !row.dataset.msgId) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey && this._lastMoveSelectedEl && box.contains(this._lastMoveSelectedEl) && this._moveSourceThread) {
        this._selectThreadRange(box, this._lastMoveSelectedEl, row);
      } else {
        this._toggleMoveSelect(row);
        this._lastMoveSelectedEl = row;
      }
    }, true);
  }

  const btn = document.getElementById('thread-panel-select');
  if (btn) btn.addEventListener('click', () => {
    if (this._moveSelectionActive) this._exitMoveSelectionMode();
    else this._enterMoveSelectionMode();
  });

  this.socket.on('messages-unthreaded', (data) => this._onMessagesUnthreaded(data));
},

// The thread header's select button: for the same people as the channel's.
_syncUnthreadSelectBtn() {
  const btn = document.getElementById('thread-panel-select');
  if (!btn) return;
  const ch = this.channels?.find(c => c.code === this.currentChannel);
  const blog = !!this._forumBlogOn?.(this.currentChannel);
  const can = !!ch && !ch.is_dm && !blog && !!(this.user?.isAdmin || this._canModerate?.());
  btn.style.display = can ? '' : 'none';
},

// Shift+click in the thread: every reply between the last one picked and this.
_selectThreadRange(box, fromEl, toEl) {
  const rows = [...box.querySelectorAll('.thread-message')];
  const a = rows.indexOf(fromEl);
  const b = rows.indexOf(toEl);
  if (a === -1 || b === -1) return;
  for (let i = Math.min(a, b); i <= Math.max(a, b); i++) {
    const id = parseInt(rows[i].dataset.msgId, 10);
    if (!id || this._moveSelectedIds.has(id)) continue;
    if (this._moveSelectedIds.size >= 200) break;
    this._moveSelectedIds.add(id);
    rows[i].classList.add('move-selected');
  }
  this._updateMoveCount();
},

// Called before a message is picked: the first pick decides whether this
// selection is channel messages or replies in the open thread.
_moveScopeAllows(msgEl) {
  const inThread = !!msgEl.closest('#thread-messages');
  const id = parseInt(msgEl.dataset.msgId, 10);
  if (!this._moveSelectedIds.size) {
    this._moveSourceThread = inThread ? Number(this._activeThreadParent) || null : null;
    return !inThread || !!this._moveSourceThread;
  }
  if (this._moveSelectedIds.has(id)) return true;
  if (!!this._moveSourceThread !== inThread) {
    this._showToast(t('modals.move_messages.unthread_mixed'), 'info');
    return false;
  }
  return true;
},

// Move to... with replies picked: the thread's channel is where they go.
_showUnthreadPicker() {
  const list = document.getElementById('move-msg-channel-list');
  const modal = document.getElementById('move-msg-modal');
  const desc = document.getElementById('move-msg-desc');
  if (!list || !modal) return;
  const n = this._moveSelectedIds.size;
  const heading = modal.querySelector('h3');
  if (heading) heading.textContent = t('modals.move_messages.title');
  if (desc) desc.textContent = t(n === 1 ? 'modals.move_messages.unthread_desc_one' : 'modals.move_messages.unthread_desc_many', { n });
  list.innerHTML = '';

  const ch = this.channels?.find(c => c.code === this.currentChannel);
  const name = ch ? ch.name : '';
  const back = document.createElement('button');
  back.className = 'move-msg-channel-item';
  back.textContent = `↩ ${t('modals.move_messages.unthread_back', { name })}`;
  back.addEventListener('click', () => {
    modal.style.display = 'none';
    this._executeUnthread(name);
  });
  const hint = document.createElement('p');
  hint.className = 'move-msg-unthread-hint';
  hint.textContent = t('modals.move_messages.unthread_hint');
  list.append(back, hint);
  modal.style.display = 'flex';
},

_executeUnthread(name) {
  const parentId = Number(this._moveSourceThread);
  const ids = [...this._moveSelectedIds];
  if (!parentId || !ids.length || this._unthreadBusy) return;
  this._unthreadBusy = true;
  this.socket.emit('move-messages-out-of-thread', { parentId, messageIds: ids }, (resp) => {
    this._unthreadBusy = false;
    if (!resp || resp.error) {
      this._showToast((resp && resp.error) || t('modals.move_messages.unthread_failed'), 'error');
      return;
    }
    this._showToast(t(resp.moved === 1 ? 'modals.move_messages.unthreaded_one' : 'modals.move_messages.unthreaded_many', { n: resp.moved, name }), 'success');
    this._exitMoveSelectionMode();
  });
},

// Replies came out of a thread (here or on another screen): they leave an
// open panel for it, and the channel shows them where they were written.
_onMessagesUnthreaded(data) {
  if (!data || !Array.isArray(data.messageIds)) return;
  const ids = data.messageIds.map(Number);
  const panel = document.getElementById('thread-panel');
  const open = !!panel && panel.style.display !== 'none';
  if (open && Number(this._activeThreadParent) === Number(data.parentId)) {
    const box = document.getElementById('thread-messages');
    for (const id of ids) {
      const el = box?.querySelector(`.thread-message[data-msg-id="${id}"]`);
      if (!el) continue;
      // A group's first row going: the next one gets its name back.
      const next = el.nextElementSibling;
      if (next && next.classList.contains('thread-compact') && !el.classList.contains('thread-compact')) {
        try { this._promoteThreadCompactToFull(next); } catch (err) { console.warn('[Unthread] thread row promotion failed', err); }
      }
      el.remove();
    }
  }
  // Someone else took replies this screen had picked.
  if (this._moveSelectionActive && ids.some(id => this._moveSelectedIds.has(id))) {
    for (const id of ids) this._moveSelectedIds.delete(id);
    this._updateMoveCount();
  }
  if (data.channelCode !== this.currentChannel) return;
  if (this._forumActive) {
    this._forumReload?.();
    this._requestForumUnread?.(data.channelCode);
    return;
  }
  // Loaded again from the newest, so they sit in time order and the
  // compact rows and history cursors come out right.
  this._oldestMsgId = null;
  this._noMoreHistory = false;
  this._loadingHistory = false;
  this._historyBefore = null;
  this._newestMsgId = null;
  this._noMoreFuture = true;
  this._loadingFuture = false;
  this._historyAfter = null;
  this.socket.emit('get-messages', { code: this.currentChannel });
},

};
