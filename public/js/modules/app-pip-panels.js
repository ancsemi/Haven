// The thread panel and the pop-out DM panel: their buttons, inputs, pasting
// and dropping files, message actions, resizing and dragging, and the pop-out
// DM itself (opening, history, replies, quoting and sending).

export default {

_bindThreadAndDmPanels() {
  // Thread panel — close, send
  const threadCloseBtn = document.getElementById('thread-panel-close');
  if (threadCloseBtn) threadCloseBtn.addEventListener('click', () => this._closeThread());

  const threadPipBtn = document.getElementById('thread-panel-pip');
  if (threadPipBtn) threadPipBtn.addEventListener('click', () => this._toggleThreadPiP());

  // Thread @mention pill in the channel header
  const tmPill = document.getElementById('thread-mentions-pill');
  if (tmPill) tmPill.addEventListener('click', () => this._openMostRecentThreadMention?.());

  // DM PiP panel buttons
  const dmPipClose = document.getElementById('dm-pip-close');
  if (dmPipClose) dmPipClose.addEventListener('click', () => this._closeDMPiP?.());
  const dmPipFs = document.getElementById('dm-pip-fullscreen');
  if (dmPipFs) dmPipFs.addEventListener('click', () => {
    const code = this._activeDMPip;
    if (!code) return;
    this._closeDMPiP?.();
    this.switchChannel(code);
  });
  const dmPipSend = document.getElementById('dm-pip-send');
  if (dmPipSend) dmPipSend.addEventListener('click', () => this._sendDMPiPMessage?.());
  const dmPipInput = document.getElementById('dm-pip-input');
  if (dmPipInput) dmPipInput.addEventListener('keydown', (e) => {
    // Autocomplete navigation/insert hijacks first. (#5296)
    if (this._handleAutocompleteKeydown(e)) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      this._sendDMPiPMessage?.();
      return;
    }
    // Markdown Formatting shortcuts
    if (this._handleMarkdownShortcuts(dmPipInput, e)) {
      e.preventDefault();
      return;
    }
  });
  if (dmPipInput) dmPipInput.addEventListener('input', () => {
    this._checkMentionTrigger(dmPipInput);
    this._checkChannelTrigger(dmPipInput);
    this._checkEmojiTrigger(dmPipInput);
    this._checkSlashTrigger(dmPipInput);
    // Personas are not supported in DMs — omit _checkPersonaTrigger here
  });

  // Paste images / files into the DM PiP input — queues images for preview
  // (same as main channel paste behavior). (#5324)
  if (dmPipInput) dmPipInput.addEventListener('paste', (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const targetCode = this._activeDMPip;
    if (!targetCode) return;
    let handled = false;
    for (const item of items) {
      if (item.kind !== 'file') continue;
      const file = item.getAsFile();
      if (!file) continue;
      e.preventDefault();
      handled = true;
      if (item.type.startsWith('image/')) {
        this._queueImageForPiP(file, targetCode);
      } else {
        this._uploadGeneralFile(file, targetCode);
      }
    }
    if (handled) return;

    // insert a markdown link when a link is pasted over selected text
    if (this._handleMarkdownLinkPaste(dmPipInput, e)) {
      e.preventDefault();
    }
  });

  // A paperclip and drag-and-drop in the pop-out DM, since paste was the
  // only way to send a picture from it, and middle-click opens a picture
  // there and in a thread like it does in chat (#5663).
  const dmPipUploadBtn = document.getElementById('dm-pip-upload-btn');
  const dmPipFileInput = document.getElementById('dm-pip-file-input');
  const dmPipTakeFiles = (files) => {
    const targetCode = this._activeDMPip;
    if (!files || !files.length || !targetCode) return false;
    for (const file of files) {
      if (file.type.startsWith('image/')) this._queueImageForPiP(file, targetCode);
      else this._uploadGeneralFile(file, targetCode);
    }
    return true;
  };
  if (dmPipUploadBtn && dmPipFileInput) {
    dmPipUploadBtn.addEventListener('click', (e) => { e.stopPropagation(); dmPipFileInput.click(); });
    dmPipFileInput.addEventListener('change', () => {
      dmPipTakeFiles(dmPipFileInput.files);
      dmPipFileInput.value = '';
    });
  }
  const dmPipPanel = document.getElementById('dm-pip-panel');
  if (dmPipPanel) {
    dmPipPanel.addEventListener('dragover', (e) => {
      if (e.dataTransfer?.types?.includes('Files')) e.preventDefault();
    });
    dmPipPanel.addEventListener('drop', (e) => {
      if (!e.dataTransfer?.files?.length) return;
      e.preventDefault();
      e.stopPropagation();
      dmPipTakeFiles(e.dataTransfer.files);
    });
  }

  // PiP emoji button — positions the picker above the button and targets the PiP input
  const dmPipEmojiBtn = document.getElementById('dm-pip-emoji-btn');
  if (dmPipEmojiBtn) {
    dmPipEmojiBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._activeEditTextarea = document.getElementById('dm-pip-input');
      this._emojiPickerContext = 'dmpip';
      this._toggleEmojiPicker(dmPipEmojiBtn);
    });
  }

  const dmPipReplyClose = document.getElementById('dm-pip-reply-close-btn');
  if (dmPipReplyClose) dmPipReplyClose.addEventListener('click', () => this._clearDMPiPReply?.());

  // Delegated message-action handler for the DM PiP.  Mirrors the main
  // #messages handler so reactions/reply/edit/etc. work inside the PiP.
  const dmPipMessages = document.getElementById('dm-pip-messages');
  if (dmPipMessages) {
    dmPipMessages.addEventListener('click', async (e) => {
      // Toolbar action buttons
      // Inline ⋯ dots button — reveals the full toolbar (touch/mobile)
      const dotsBtn = e.target.closest('.msg-dots-btn');
      if (dotsBtn) {
        e.stopPropagation();
        const msgEl = dotsBtn.closest('.message, .message-compact');
        if (!msgEl) return;
        const wasSelected = msgEl.classList.contains('msg-selected');
        dmPipMessages.querySelectorAll('.msg-selected').forEach(el => {
          el.classList.remove('msg-selected');
          const tb = el.querySelector('.msg-toolbar');
          if (tb) tb.style.removeProperty('display');
        });
        if (!wasSelected) {
          msgEl.classList.add('msg-selected');
          const tb = msgEl.querySelector('.msg-toolbar');
          if (tb) tb.style.setProperty('display', 'flex', 'important');
        }
        return;
      }

      const actionBtn = e.target.closest('[data-action]');
      if (actionBtn) {
        const msgEl = actionBtn.closest('.message, .message-compact');
        if (!msgEl) return;
        const msgId = parseInt(msgEl.dataset.msgId, 10);
        if (!msgId) return;
        const action = actionBtn.dataset.action;
        if (action === 'react') {
          this._showReactionPicker?.(msgEl, msgId);
        } else if (action === 'reply') {
          this._setDMPiPReply?.(msgEl, msgId);
        } else if (action === 'quote') {
          this._quoteDMPiPMessage?.(msgEl);
        } else if (action === 'edit') {
          this._startEditMessage?.(msgEl, msgId);
        } else if (action === 'delete') {
          if (await this._showConfirmModal(t('confirm.delete_message'), '', { danger: true, confirmLabel: t('msg_toolbar.delete') })) {
            this.socket.emit('delete-message', { messageId: msgId, channelCode: this._activeDMPip, attachments: this._getMessageAttachments?.(msgId) });
          }
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
        } else if (action === 'copy-link') {
          this._copyChannelLink?.(this._activeDMPip, msgId);
        } else if (action === 'thread') {
          // Threads are not available in DMs - swallow the click. The button
          // should already be filtered out at render time, this is defence
          // in depth in case an old cached element is still around.
          this._showToast?.(t('thread_list.unavailable_in_dm'), 'info');
        }
        return;
      }
      // Reaction badge toggle
      const badge = e.target.closest('.reaction-badge');
      if (badge) {
        this._hideReactionPopout?.();
        const msgEl = badge.closest('.message, .message-compact');
        if (!msgEl) return;
        const msgId = parseInt(msgEl.dataset.msgId, 10);
        const emoji = badge.dataset.emoji;
        if (!msgId || !emoji) return;
        if (badge.classList.contains('own')) {
          this.socket.emit('remove-reaction', { messageId: msgId, emoji });
        } else {
          this.socket.emit('add-reaction', { messageId: msgId, emoji });
        }
        return;
      }
      // Reply banner click → jump to original (within the PiP if present)
      const replyBanner = e.target.closest('.reply-banner');
      if (replyBanner) {
        const replyMsgId = parseInt(replyBanner.dataset.replyMsgId || '', 10);
        if (!replyMsgId) return;
        const target = dmPipMessages.querySelector(`[data-msg-id="${replyMsgId}"]`);
        if (target) {
          target.scrollIntoView({ block: 'center', behavior: 'smooth' });
          target.classList.add('highlight-flash');
          setTimeout(() => target.classList.remove('highlight-flash'), 1200);
        }
      }
    });
  }

  const threadSendBtn = document.getElementById('thread-send-btn');
  if (threadSendBtn) threadSendBtn.addEventListener('click', () => this._sendThreadMessage());

  // Thread emoji button — positions the picker above the button and targets the thread input
  const threadEmojiBtn = document.getElementById('thread-emoji-btn');
  if (threadEmojiBtn) {
    threadEmojiBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._activeEditTextarea = document.getElementById('thread-input');
      this._emojiPickerContext = 'thread';
      this._toggleEmojiPicker(threadEmojiBtn);
    });
  }

  const threadInput = document.getElementById('thread-input');
  if (threadInput) {
    threadInput.addEventListener('keydown', (e) => {
      // Autocomplete navigation/insert hijacks first. (#5296)
      if (this._handleAutocompleteKeydown(e)) return;
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this._sendThreadMessage();
        return;
      }
      // Markdown Formatting shortcuts
      if (this._handleMarkdownShortcuts(threadInput, e)) {
        e.preventDefault();
        return;
      }
    });
    threadInput.addEventListener('input', () => {
      this._checkMentionTrigger(threadInput);
      this._checkChannelTrigger(threadInput);
      this._checkEmojiTrigger(threadInput);
      this._checkSlashTrigger(threadInput);
      // Personas are not supported in threads — omit _checkPersonaTrigger here
    });
    // Paste images / files into the thread input — upload then send as thread message
    threadInput.addEventListener('paste', (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      if (!this._activeThreadParent) return;
      // Hold them, don't post them. Flushed on send. (#thread-paste-instant)
      const files = Array.from(items).filter(i => i.kind === 'file').map(i => i.getAsFile()).filter(Boolean);
      if (files.length) {
        e.preventDefault();
        this._queueThreadFiles(files);
        return;
      }

      // insert a markdown link when a link is pasted over selected text
      if (this._handleMarkdownLinkPaste(threadInput, e)) {
        e.preventDefault();
      }
    });

    // Drag & drop parity with the other composers — queue, never insta-post.
    // The whole panel takes the drop, not only the reply box: in a forum topic
    // people drop pictures onto the replies the way they would onto a chat
    // (#5684).
    const threadArea = threadInput.closest('.thread-panel') || threadInput.closest('.thread-input-area') || threadInput;
    const hasFiles = (e) => !!e.dataTransfer?.types?.includes('Files');
    threadArea.addEventListener('dragover', (e) => { if (!hasFiles(e)) return; e.preventDefault(); threadArea.classList.add('drag-over'); });
    threadArea.addEventListener('dragleave', (e) => { if (!threadArea.contains(e.relatedTarget)) threadArea.classList.remove('drag-over'); });
    threadArea.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      threadArea.classList.remove('drag-over');
      if (!this._activeThreadParent) return;
      this._queueThreadFiles(e.dataTransfer?.files);
    });
  }

  const threadReplyCloseBtn = document.getElementById('thread-reply-close-btn');
  if (threadReplyCloseBtn) threadReplyCloseBtn.addEventListener('click', () => this._clearThreadReply());

  // Thread panel width resize (drag left edge)
  const threadPanel = document.getElementById('thread-panel');
  const threadResizer = document.getElementById('thread-panel-resizer');
  if (threadPanel) {
    const savedWidth = parseInt(localStorage.getItem('haven_thread_panel_width') || '', 10);
    if (Number.isFinite(savedWidth) && savedWidth >= 300 && savedWidth <= 920) {
      threadPanel.style.width = `${savedWidth}px`;
    }
  }
  if (threadPanel && threadResizer) {
    let resizing = false;
    const clampWidth = (w) => {
      const min = 300;
      const max = Math.min(920, window.innerWidth - 220);
      return Math.max(min, Math.min(max, w));
    };
    const onMove = (e) => {
      if (!resizing || threadPanel.classList.contains('pip')) return;
      const width = clampWidth(window.innerWidth - e.clientX);
      threadPanel.style.width = `${width}px`;
    };
    const onUp = () => {
      if (!resizing) return;
      resizing = false;
      document.body.classList.remove('resizing-thread-panel');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      const current = parseInt(threadPanel.style.width || '', 10);
      if (Number.isFinite(current)) {
        localStorage.setItem('haven_thread_panel_width', String(clampWidth(current)));
      }
    };
    threadResizer.addEventListener('mousedown', (e) => {
      if (threadPanel.classList.contains('pip')) return;
      resizing = true;
      e.preventDefault();
      document.body.classList.add('resizing-thread-panel');
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
    window.addEventListener('resize', () => {
      if (threadPanel.classList.contains('pip')) return;
      const current = parseInt(threadPanel.style.width || '', 10);
      if (!Number.isFinite(current)) return;
      const width = clampWidth(current);
      if (width !== current) {
        threadPanel.style.width = `${width}px`;
        localStorage.setItem('haven_thread_panel_width', String(width));
      }
    });
  }

  // Thread panel PiP drag (drag by header)
  if (threadPanel) {
    const threadHeaderTop = threadPanel.querySelector('.thread-panel-header-top');
    let draggingPiP = false;
    let dragOffsetX = 0;
    let dragOffsetY = 0;

    const footerOffset = () => {
      const raw = getComputedStyle(document.body).getPropertyValue('--thread-footer-offset');
      const v = parseInt(raw, 10);
      return Number.isFinite(v) ? v : 0;
    };

    const clampPiPRect = (left, top, width, height) => {
      const maxLeft = Math.max(0, window.innerWidth - width);
      const maxTop = Math.max(0, window.innerHeight - footerOffset() - height);
      return {
        left: Math.max(0, Math.min(maxLeft, left)),
        top: Math.max(0, Math.min(maxTop, top))
      };
    };

    const savePiPRect = () => {
      if (!threadPanel.classList.contains('pip')) return;
      const r = threadPanel.getBoundingClientRect();
      const rect = {
        left: Math.round(r.left),
        top: Math.round(r.top),
        width: Math.round(r.width),
        height: Math.round(r.height)
      };
      localStorage.setItem('haven_thread_panel_pip_rect', JSON.stringify(rect));
    };

    const onPiPMove = (e) => {
      if (!draggingPiP || !threadPanel.classList.contains('pip')) return;
      const r = threadPanel.getBoundingClientRect();
      const rawLeft = e.clientX - dragOffsetX;
      const rawTop = e.clientY - dragOffsetY;
      const pos = clampPiPRect(rawLeft, rawTop, r.width, r.height);
      threadPanel.style.left = `${pos.left}px`;
      threadPanel.style.top = `${pos.top}px`;
      threadPanel.style.right = 'auto';
      threadPanel.style.bottom = 'auto';
    };

    const onPiPUp = () => {
      if (!draggingPiP) return;
      draggingPiP = false;
      document.removeEventListener('mousemove', onPiPMove);
      document.removeEventListener('mouseup', onPiPUp);
      savePiPRect();
    };

    if (threadHeaderTop) {
      threadHeaderTop.addEventListener('mousedown', (e) => {
        if (!threadPanel.classList.contains('pip')) return;
        if (e.target.closest('button, input, textarea, a')) return;
        const r = threadPanel.getBoundingClientRect();
        draggingPiP = true;
        dragOffsetX = e.clientX - r.left;
        dragOffsetY = e.clientY - r.top;
        threadPanel.style.right = 'auto';
        threadPanel.style.bottom = 'auto';
        e.preventDefault();
        document.addEventListener('mousemove', onPiPMove);
        document.addEventListener('mouseup', onPiPUp);
      });
    }

    if (window.ResizeObserver) {
      const observer = new ResizeObserver(() => {
        if (!threadPanel.classList.contains('pip')) return;
        clearTimeout(this._threadPiPSaveTimer);
        this._threadPiPSaveTimer = setTimeout(() => {
          const r = threadPanel.getBoundingClientRect();
          const pos = clampPiPRect(r.left, r.top, r.width, r.height);
          threadPanel.style.left = `${pos.left}px`;
          threadPanel.style.top = `${pos.top}px`;
          savePiPRect();
        }, 80);
      });
      observer.observe(threadPanel);
    }
  }

  // PiP input area height resize — drag the top handle upward to expand the textarea.
  // Used by DM PiP, thread input, AND the main channel composer (#5327).
  // We set both `height` and `min-height` inline so the auto-grow `input`
  // handler (which sets `height = 'auto'` then caps at a small default) can't
  // collapse the textarea back down after the user has manually expanded it.
  document.querySelectorAll('.pip-input-resizer').forEach(handle => this._bindInputResizer(handle));
},

// ── DM Picture-in-Picture (overlay panel, like thread PiP) ──
// Opens a floating, draggable, resizable panel that hosts a DM
// without leaving the user's current channel. The DM panel is its
// own message view — receives `new-message` events filtered by code,
// sends via `send-message` with the PiP channel code.
_openDMPiP(code) {
  // Don't open as PiP if this DM is already the active main channel — user is
  // already viewing it. This prevents sidebar clicks, dm-opened events, and
  // channel-link clicks from spawning a redundant PiP overlay.
  if (code === this.currentChannel) return;
  const ch = (this.channels || []).find(c => c.code === code);
  if (!ch || !ch.is_dm) return;
  this._activeDMPip = code;
  try { localStorage.setItem('haven_active_dm_pip', code); } catch { /* storage blocked (private mode): nothing is remembered, nothing else breaks */ }
  // Keep the DM PiP cleared from the unread badge AND tell the server
  // we've read up to its latest message.  Without the server emit the
  // local mirror gets clobbered the next time `channels-list` snapshots
  // (which can happen at any moment for unrelated reasons — a peer
  // joining a voice channel, an admin tweak, a role change, etc.) and
  // the unread dot keeps coming back forever.  This was the root cause
  // of "I've sat on this DM for an hour and it still keeps re-notifying".
  // We use the channel's last-known latestMessageId from the snapshot;
  // the in-pane render of the message history will fire its own _markRead
  // for the actual painted message id on top, and the server takes
  // MAX(last_read, incoming) so the two can't fight.
  this.unreadCounts[code] = 0;
  this._updateBadge?.(code);
  if (ch.latestMessageId) {
    try { this.socket.emit('mark-read', { code, messageId: ch.latestMessageId }); } catch (err) { console.warn('[DM PiP] could not mark the conversation read', err); }
  }
  try { this._updateDmSectionBadge?.(); } catch (err) { console.warn('[DM PiP] _updateDmSectionBadge failed', err); }
  try { this._updateTabTitle?.(); } catch (err) { console.warn('[DM PiP] _updateTabTitle failed', err); }
  try { this._updateDesktopBadge?.(); } catch (err) { console.warn('[DM PiP] _updateDesktopBadge failed', err); }

  const panel = document.getElementById('dm-pip-panel');
  if (!panel) {
    // Fallback: cached app shell may predate the PiP panel element. Open the
    // DM in the main pane so the click isn't a no-op (notably for self-DMs
    // where users were seeing the toast but no panel — issue: SerChiz v3.8).
    console.warn('[DM] PiP panel not found in DOM, falling back to switchChannel');
    this._activeDMPip = null;
    try { localStorage.removeItem('haven_active_dm_pip'); } catch { /* storage blocked (private mode): nothing is remembered, nothing else breaks */ }
    this.switchChannel?.(code);
    return;
  }
  panel.style.display = 'flex';
  panel.dataset.code = code;
  // Title: partner name
  const partnerName = ch.dm_target ? this._getNickname(ch.dm_target.id, ch.dm_target.username) : 'DM';
  const titleEl = document.getElementById('dm-pip-title');
  if (titleEl) titleEl.textContent = ch.is_self_dm ? `📝 ${t('dm_runtime.self_title', { name: partnerName })}` : `@ ${partnerName}`;

  this._refreshDMPipHeader(ch, partnerName);
  // Ask for the DM's own online list so the header is right straight away,
  // not only after the next presence change (#5574).
  this.socket.emit('request-online-users', { code });

  // Banner background: use server banner as a subtle backdrop
  const bannerEl = document.getElementById('dm-pip-banner');
  const bannerUrl = this.serverSettings && this.serverSettings.server_banner;
  if (bannerEl) {
    if (bannerUrl) {
      bannerEl.style.backgroundImage = `url("${bannerUrl.replace(/"/g, '\\"')}")`;
      panel.classList.remove('no-banner');
    } else {
      bannerEl.style.backgroundImage = '';
      panel.classList.add('no-banner');
    }
  }
  this._openDMPiPBody(ch, code, panel);
},

// Header avatar and status dot for the open DM PiP. Runs when the panel opens
// and again on every presence broadcast (#5574): it used to render once, from
// whatever the online list held at that moment, so a PiP opened before the
// list arrived, or whose partner came online later, kept the grey dot and the
// initial for as long as the panel stayed open.
_refreshDMPipHeader(ch, partnerName) {
  if (!ch) {
    const code = this._activeDMPip;
    ch = code ? (this.channels || []).find(c => c.code === code) : null;
    if (!ch) return;
  }
  if (!partnerName) partnerName = ch.dm_target ? this._getNickname(ch.dm_target.id, ch.dm_target.username) : 'DM';
  const avatarWrap = document.getElementById('dm-pip-avatar-wrap');
  if (avatarWrap) {
    const partnerId = ch.dm_target && ch.dm_target.id;
    // The DM's own list first: the list for the channel on screen only has
    // the partner in it when they happen to share that channel (#5574).
    const dmList = this._onlineByChannel && this._onlineByChannel.get(ch.code);
    const onlinePartner = partnerId
      ? ((dmList && dmList.find(u => u.id === partnerId))
        || (this._lastOnlineUsers ? this._lastOnlineUsers.find(u => u.id === partnerId) : null)
        || null)
      : null;
    const avatarUrl = (onlinePartner && onlinePartner.avatar) || (ch.dm_target && ch.dm_target.avatar);
    const shape = (onlinePartner && onlinePartner.avatarShape)
      || (ch.dm_target && ch.dm_target.avatarShape)
      || 'circle';
    avatarWrap.className = `dm-pip-avatar-wrap avatar-${shape}`;
    // Determine status: 'online' / 'away' / 'dnd' / 'invisible' / 'offline'
    // (matches the sidebar `.user-status-dot` modifier classes — empty
    // class = online green; 'away'/'dnd'/'invisible' for explicit states;
    // offline users are treated as 'away' visually like the sidebar does
    // so a self-DM (always us) doesn't render a meaningless gray dot.)
    let statusClass = '';
    if (ch.is_self_dm) {
      statusClass = '';
    } else if (onlinePartner) {
      const s = onlinePartner.status;
      statusClass = s === 'dnd' ? 'dnd'
        : s === 'away' ? 'away'
        : s === 'invisible' ? 'invisible'
        : (onlinePartner.online === false ? 'offline' : '');
    } else {
      statusClass = 'offline'; // partner not in online list
    }
    const statusLabel = statusClass === 'dnd' ? t('app.profile.dnd')
      : (statusClass === 'away' || statusClass === 'offline') ? t('dm_runtime.offline_away')
      : statusClass === 'invisible' ? t('app.profile.invisible')
      : t('app.profile.online');
    const statusDot = `<span class="dm-pip-status-dot${statusClass ? ' ' + statusClass : ''}" title="${this._escapeHtml(statusLabel)}"></span>`;
    if (avatarUrl) {
      avatarWrap.style.backgroundColor = '';
      avatarWrap.innerHTML = `<img src="${this._escapeHtml(avatarUrl)}" alt="">${statusDot}`;
    } else {
      const initial = (partnerName || '?').charAt(0).toUpperCase();
      const color = this._getUserColor(partnerName || '');
      avatarWrap.style.backgroundColor = color;
      avatarWrap.innerHTML = `<span class="dm-pip-avatar-initial">${this._escapeHtml(initial)}</span>${statusDot}`;
    }
  }
},

// The rest of opening a DM PiP: everything after the header and banner.
_openDMPiPBody(ch, code, panel) {

  // Restore geometry from localStorage
  this._applyDMPiPGeometry(panel);
  // Bind drag once
  this._bindDMPiPDrag();

  // Clear messages and request fresh
  const msgsEl = document.getElementById('dm-pip-messages');
  if (msgsEl) msgsEl.innerHTML = `<div class="dm-pip-loading">${t('thread_list.loading')}</div>`;
  // E2E: ensure partner key is loaded before history arrives so messages decrypt.
  // For self-DMs the "partner" is the user themselves, so seed our own public
  // key directly instead of round-tripping through the server. Avoids any
  // chance of the loading state lingering when the server's get-public-key
  // for our own id returns null/empty (issue: SerChiz v3.10.3).
  if (ch.dm_target && this._dmPublicKeys && !this._dmPublicKeys[ch.dm_target.id]) {
    if (ch.is_self_dm && this.e2e && this.e2e.publicKeyJwk) {
      this._dmPublicKeys[ch.dm_target.id] = this.e2e.publicKeyJwk;
    } else {
      try { this._fetchDMPartnerKey?.(ch); } catch (err) { console.warn('[DM PiP] _fetchDMPartnerKey failed', err); }
    }
  }
  this.socket.emit('get-messages', { code });
  // Safety: if message-history doesn't arrive within 6s (e.g. a transient
  // server issue or a stuck E2E key fetch), replace the localized "Loading…"
  // placeholder so the panel never looks frozen. Cleared on next open/close.
  clearTimeout(this._dmPipLoadingTimer);
  this._dmPipLoadingTimer = setTimeout(() => {
    const stillLoading = document.querySelector('#dm-pip-messages .dm-pip-loading');
    if (stillLoading && this._activeDMPip === code) {
      stillLoading.textContent = t('dm_runtime.no_messages');
    }
  }, 6000);

  // Clear any stale reply state
  this._clearDMPiPReply();

  // Focus input
  const input = document.getElementById('dm-pip-input');
  if (input) input.focus();
},

_closeDMPiP() {
  this._activeDMPip = null;
  this._dmPipReplyingTo = null;
  this._pipImageQueue = [];
  this._pipImageQueueTarget = null;
  this._renderPiPImageQueue?.();
  clearTimeout(this._dmPipLoadingTimer);
  try { localStorage.removeItem('haven_active_dm_pip'); } catch { /* storage blocked (private mode): nothing is remembered, nothing else breaks */ }
  const panel = document.getElementById('dm-pip-panel');
  if (panel) panel.style.display = 'none';
},

_applyDMPiPGeometry(panel) {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem('haven_dm_pip_rect') || 'null'); } catch { /* corrupt saved position: use the default placement */ }
  const minW = 320, minH = 280;
  const maxW = Math.min(720, window.innerWidth - 28);
  const maxH = Math.max(minH, window.innerHeight - 28);
  const width = Math.max(minW, Math.min(maxW, (saved && saved.width) || 420));
  const height = Math.max(minH, Math.min(maxH, (saved && saved.height) || 540));
  const defaultLeft = Math.max(0, window.innerWidth - width - 20);
  const defaultTop = Math.max(0, window.innerHeight - height - 80);
  const left = Math.max(0, Math.min(window.innerWidth - width, (saved && Number.isFinite(saved.left)) ? saved.left : defaultLeft));
  const top = Math.max(0, Math.min(window.innerHeight - height, (saved && Number.isFinite(saved.top)) ? saved.top : defaultTop));
  panel.style.width = `${Math.round(width)}px`;
  panel.style.height = `${Math.round(height)}px`;
  panel.style.left = `${Math.round(left)}px`;
  panel.style.top = `${Math.round(top)}px`;
},

_bindDMPiPDrag() {
  if (this._dmPipDragBound) return;
  this._dmPipDragBound = true;
  const panel = document.getElementById('dm-pip-panel');
  if (!panel) return;
  const header = panel.querySelector('.dm-pip-header');
  if (!header) return;
  let startX = 0, startY = 0, startLeft = 0, startTop = 0, dragging = false;
  header.addEventListener('mousedown', (e) => {
    if (e.target.closest('button, a, input, select, textarea')) return;
    dragging = true;
    startX = e.clientX; startY = e.clientY;
    const r = panel.getBoundingClientRect();
    startLeft = r.left; startTop = r.top;
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const w = panel.offsetWidth, h = panel.offsetHeight;
    const left = Math.max(0, Math.min(window.innerWidth - w, startLeft + (e.clientX - startX)));
    const top = Math.max(0, Math.min(window.innerHeight - h, startTop + (e.clientY - startY)));
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  });
  const persist = () => {
    if (!panel || panel.style.display === 'none') return;
    try {
      localStorage.setItem('haven_dm_pip_rect', JSON.stringify({
        left: parseInt(panel.style.left, 10) || 0,
        top: parseInt(panel.style.top, 10) || 0,
        width: panel.offsetWidth,
        height: panel.offsetHeight
      }));
    } catch { /* storage blocked (private mode): nothing is remembered, nothing else breaks */ }
  };
  window.addEventListener('mouseup', () => {
    if (dragging) { dragging = false; persist(); }
  });
  // Persist on resize (CSS resize: both)
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => persist());
    ro.observe(panel);
  }
},

// Render a DM message in the PiP panel using the same DOM structure as
// the main pane.  Avatars are hidden via CSS — partner pfp lives in the
// header instead, since DMs are 1-on-1 and the per-row pfp is redundant.
_appendDMPiPMessage(msg) {
  const list = document.getElementById('dm-pip-messages');
  if (!list) return;
  if (msg && msg.id && list.querySelector(`[data-msg-id="${msg.id}"]`)) return;
  const ph = list.querySelector('.dm-pip-loading');
  if (ph) ph.remove();
  // Tag this render so `_createMessageEl` knows to suppress thread UI -
  // threads are not available in DMs.
  if (msg) msg._isDmRender = true;
  // Use the previous message in the PiP list as the "prev" reference so
  // grouping into compact messages still works.
  let prevMsg = null;
  const lastEl = list.lastElementChild;
  if (lastEl && lastEl.dataset && lastEl.dataset.userId && lastEl.dataset.msgId) {
    // Rebuild enough of the previous message for `_createMessageEl`'s grouping
    // check. It compares username and persona too, so a prev that only carried
    // user_id + time never matched and every message rendered ungrouped. (the
    // dataset already stores these from when the element was created.)
    prevMsg = {
      user_id: parseInt(lastEl.dataset.userId, 10),
      username: lastEl.dataset.username || null,
      persona_id: lastEl.dataset.personaId ? parseInt(lastEl.dataset.personaId, 10) : null,
      persona_username: lastEl.dataset.personaUsername || null,
      break_chain: lastEl.dataset.breakChain === '1' ? 1 : 0,
      created_at: lastEl.dataset.time
    };
  }
  const wasAtBottom = (list.scrollHeight - list.clientHeight - list.scrollTop) < 80;
  const el = this._createMessageEl(msg, prevMsg);
  list.appendChild(el);
  // Async content (link previews, E2E images/files, videos) — hook into existing pipelines
  try { this._fetchLinkPreviews?.(el); } catch (err) { console.warn('[DM PiP] _fetchLinkPreviews failed', err); }
  try { this._setupVideos?.(el); } catch (err) { console.warn('[DM PiP] _setupVideos failed', err); }
  try { this._decryptE2EImages?.(el); } catch (err) { console.warn('[DM PiP] _decryptE2EImages failed', err); }
  try { this._decryptE2EFiles?.(el); } catch (err) { console.warn('[DM PiP] _decryptE2EFiles failed', err); }
  // DM PiP is unambiguously a DM view, so enforce directly rather than
  // routing through _isDmContainer. (#5483)
  try { this._enforceDmLinkPolicy?.(el); } catch (err) { console.warn('[DM PiP] _enforceDmLinkPolicy failed', err); }
  try { this._wireBurnMessages?.(el); } catch (err) { console.warn('[DM PiP] _wireBurnMessages failed', err); }
  if (wasAtBottom) list.scrollTop = list.scrollHeight;
},

_renderDMPiPHistory(messages) {
  const list = document.getElementById('dm-pip-messages');
  if (!list) return;
  list.innerHTML = '';
  (messages || []).forEach((m, i) => {
    if (m) m._isDmRender = true;
    const prev = i > 0 ? messages[i - 1] : null;
    const el = this._createMessageEl(m, prev);
    list.appendChild(el);
  });
  try { this._fetchLinkPreviews?.(list); } catch (err) { console.warn('[DM PiP] _fetchLinkPreviews failed', err); }
  try { this._setupVideos?.(list); } catch (err) { console.warn('[DM PiP] _setupVideos failed', err); }
  try { this._decryptE2EImages?.(list); } catch (err) { console.warn('[DM PiP] _decryptE2EImages failed', err); }
  try { this._decryptE2EFiles?.(list); } catch (err) { console.warn('[DM PiP] _decryptE2EFiles failed', err); }
  // DM PiP is unambiguously a DM view, so enforce directly rather than
  // routing through _isDmContainer. (#5483)
  try { this._enforceDmLinkPolicy?.(list); } catch (err) { console.warn('[DM PiP] _enforceDmLinkPolicy failed', err); }
  try { this._maybeShowDmSafetyNotice?.(list); } catch (err) { console.warn('[DM PiP] _maybeShowDmSafetyNotice failed', err); }
  try { this._wireBurnMessages?.(list); } catch (err) { console.warn('[DM PiP] _wireBurnMessages failed', err); }
  list.scrollTop = list.scrollHeight;
},

_setDMPiPReply(msgEl, msgId) {
  let author = msgEl.querySelector('.message-author')?.textContent;
  if (!author) {
    let prev = msgEl.previousElementSibling;
    while (prev) {
      const a = prev.querySelector('.message-author');
      if (a) { author = a.textContent; break; }
      prev = prev.previousElementSibling;
    }
  }
  author = author || t('voice.someone');
  const content = msgEl.querySelector('.message-content')?.textContent || '';
  const preview = content.length > 60 ? content.substring(0, 60) + '…' : content;
  this._dmPipReplyingTo = { id: msgId, username: author, content };
  const bar = document.getElementById('dm-pip-reply-bar');
  if (bar) {
    bar.style.display = 'flex';
    const txt = document.getElementById('dm-pip-reply-preview-text');
    if (txt) txt.innerHTML = t('thread_runtime.replying_to', { author: this._escapeHtml(author), preview: this._escapeHtml(preview) });
  }
  document.getElementById('dm-pip-input')?.focus();
},

_clearDMPiPReply() {
  this._dmPipReplyingTo = null;
  const bar = document.getElementById('dm-pip-reply-bar');
  if (bar) bar.style.display = 'none';
},

_quoteDMPiPMessage(msgEl) {
  const rawContent = msgEl.dataset.rawContent || msgEl.querySelector('.message-content')?.textContent || '';
  let author = msgEl.querySelector('.message-author')?.textContent;
  if (!author) {
    let prev = msgEl.previousElementSibling;
    while (prev) {
      const a = prev.querySelector('.message-author');
      if (a) { author = a.textContent; break; }
      prev = prev.previousElementSibling;
    }
  }
  author = author || t('voice.someone');
  const quotedLines = rawContent.split('\n').map(l => `> ${l}`).join('\n');
  const quoteText = `${t('thread_runtime.wrote', { author })}\n${quotedLines}\n`;
  const input = document.getElementById('dm-pip-input');
  if (!input) return;
  input.value = input.value ? `${input.value}\n${quoteText}` : quoteText;
  input.focus();
},

_sendDMPiPMessage() {
  const input = document.getElementById('dm-pip-input');
  if (!input || !this._activeDMPip) return;
  const typed = input.value;
  let content = (input.value || '').trim();
  const hasPiPImages = this._pipImageQueue && this._pipImageQueue.length > 0;
  if (!content && !hasPiPImages) return;
  const code = this._activeDMPip;
  const replyTo = this._dmPipReplyingTo ? this._dmPipReplyingTo.id : null;

  // Kept for a moment so a refusal for length can put the text back (#5691).
  if (content) this._lastSendDraft = { text: input.value, code, at: Date.now(), inputId: 'dm-pip-input' };
  // Clear the UI immediately so the input feels responsive.
  input.value = '';
  this._clearDMPiPReply();
  input.focus();

  // E2E-encrypt for the PiP's DM channel (not the active currentChannel).
  (async () => {
    const ch = this.channels.find(c => c.code === code);
    const isDm = ch && ch.is_dm && ch.dm_target;
    // Not sent after all: the text and the reply go back in the box.
    const putBack = () => {
      if (this._activeDMPip !== code || input.value.trim()) return;
      input.value = typed;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const replyEl = replyTo && document.querySelector(`#dm-pip-messages .message[data-msg-id="${replyTo}"], #dm-pip-messages .message-compact[data-msg-id="${replyTo}"]`);
      if (replyEl) this._setDMPiPReply(replyEl, replyTo);
      input.focus();
    };
    // Nothing goes out unencrypted, or to a changed key, without asking.
    let partner = null;
    if (isDm) {
      const gate = await this._dmSendGate(code);
      if (!gate) { putBack(); return; }
      partner = gate.partner;
    }

    // Pre-process content-transforming slash commands client-side so they
    // survive E2E encryption (server can't parse encrypted slash commands).
    // Mirror of the same block in _sendMessage. (#5297)
    if (isDm) {
      const slashMatch = content.match(/^\/([a-zA-Z]+)(?:\s+(.*))?$/);
      if (slashMatch) {
        const cmd = slashMatch[1].toLowerCase();
        const arg = (slashMatch[2] || '').trim();
        const displayName = this.user?.displayName || this.user?.username || '';
        const clientSlash = {
          spoiler:    () => arg ? `||${arg}||` : null,
          shrug:      () => `${arg ? arg + ' ' : ''}¯\\_(ツ)_/¯`,
          tableflip:  () => `${arg ? arg + ' ' : ''}(╯°□°)╯︵ ┻━┻`,
          unflip:     () => `${arg ? arg + ' ' : ''}┬─┬ ノ( ゜-゜ノ)`,
          lenny:      () => `${arg ? arg + ' ' : ''}( ͡° ͜ʖ ͡°)`,
          disapprove: () => `${arg ? arg + ' ' : ''}ಠ_ಠ`,
          bbs:        () => t('commands.output.bbs', { name: displayName }),
          boobs:      () => `( . Y . )`,
          butt:       () => `( . )( . )`,
          brb:        () => t('commands.output.brb', { name: displayName }),
          afk:        () => t('commands.output.afk', { name: displayName }),
          me:         () => arg ? `_${displayName} ${arg}_` : null,
          flip:       () => t('commands.output.flip', {
            name: displayName,
            side: t(Math.random() < 0.5 ? 'commands.output.heads' : 'commands.output.tails'),
          }),
          roll:       () => {
            const m = (arg || '1d6').match(/^(\d{1,2})?d(\d{1,4})$/i);
            if (!m) return t('commands.output.roll_simple', {
              name: displayName,
              result: Math.floor(Math.random() * 6) + 1,
            });
            const count = Math.min(parseInt(m[1] || '1'), 20);
            const sides = Math.min(parseInt(m[2]), 1000);
            const rolls = Array.from({ length: count }, () => Math.floor(Math.random() * sides) + 1);
            const total = rolls.reduce((a, b) => a + b, 0);
            return t('commands.output.roll', {
              name: displayName,
              count,
              sides,
              rolls: rolls.join(', '),
              total,
            });
          },
          hug:        () => arg ? t('commands.output.hug', { name: displayName, target: arg }) : null,
          wave:       () => t('commands.output.wave', { name: displayName, text: arg ? ` ${arg}` : '' }),
        };
        if (clientSlash[cmd]) {
          const transformed = clientSlash[cmd]();
          if (transformed !== null) content = transformed;
        }
      }
    }

    const payload = { code, content };
    if (replyTo) payload.replyTo = replyTo;
    if (content) {
      if (partner) {
        try {
          const encrypted = await this.e2e.encrypt(content, partner.userId, partner.publicKeyJwk);
          payload.content = encrypted;
          payload.encrypted = true;
        } catch (err) {
          // This used to go out unencrypted without a word. It stays here now.
          console.warn('[E2E][PiP] Encryption failed:', err);
          this._showToast(t('toasts.encryption_failed_not_sent'), 'error');
          putBack();
          return;
        }
      }
      this.socket.emit('send-message', payload);
      try { this.notifications?.play?.('sent'); } catch { /* the send sound is cosmetic */ }
    }

    // Flush any queued images (same as main channel behavior, #5324)
    // Pass bundled=true when text was also sent so slow mode doesn't double-tick
    if (hasPiPImages) {
      await this._flushPiPImageQueue?.(!!content);
    }
  })();
},

};
