// Clicks on messages: pictures and the lightbox, context menus, risky file
// and masked link warnings, replies, tags, channel links, the message toolbar,
// reactions and their hover list, poll votes and role menu buttons.

export default {

_bindCodeBlockCopy() {
  // Code blocks can appear in messages, threads, search results, and forum
  // content, so handle the copy control once at the document level.
  document.addEventListener('click', (e) => {
    const button = e.target?.closest?.('.code-block-copy');
    if (!button) return;
    e.preventDefault();
    e.stopPropagation();
    void this._copyCodeBlock(button);
  }, true); // capture: a card or message under the button must not get the click too

  // The message toolbar shares the code block's top-right corner. Reposition
  // only the copy buttons that it actually covers while the message is hovered.
  document.addEventListener('pointerover', (e) => {
    const msgEl = e.target?.closest?.('.message, .message-compact, .thread-message');
    if (!msgEl || msgEl.contains(e.relatedTarget)) return;
    requestAnimationFrame(() => {
      if (msgEl.isConnected === false || !msgEl.matches(':hover')) return;
      this._placeMessageToolbar(msgEl);
      this._updateCodeBlockCopyPlacement(msgEl);
    });
  });
  document.addEventListener('pointerout', (e) => {
    const msgEl = e.target?.closest?.('.message, .message-compact, .thread-message');
    if (!msgEl || (e.relatedTarget && msgEl.contains(e.relatedTarget))) return;
    msgEl.querySelectorAll('.code-block').forEach(block => block.classList.remove('copy-button-shifted'));
  });
  // Scrolling inside a tall message moves its bottom edge while the pointer
  // stays put, so the toolbar has to follow. Once a frame at most.
  let scrollFrame = 0;
  document.addEventListener('scroll', (e) => {
    if (scrollFrame || !e.target?.matches?.('#messages, #thread-messages, #dm-pip-messages')) return;
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = 0;
      e.target.querySelectorAll('.message:hover, .message-compact:hover, .thread-message:hover')
        .forEach(msgEl => this._placeMessageToolbar(msgEl));
    });
  }, true);
  window.addEventListener('resize', () => {
    document.querySelectorAll('.message:hover, .message-compact:hover, .thread-message:hover')
      .forEach(msgEl => {
        this._placeMessageToolbar(msgEl);
        this._updateCodeBlockCopyPlacement(msgEl);
      });
  });
},

// Beside the last reaction chip when there is room, level with the chips. With
// no chips the stylesheet's bottom corner stands. Either way it stays on screen
// on a message taller than the list.
_placeMessageToolbar(msgEl) {
  const bar = msgEl.querySelector('.msg-toolbar, .thread-msg-toolbar');
  if (!bar) return;
  bar.style.left = '';
  bar.style.right = '';
  bar.style.bottom = '';
  const box = bar.offsetParent;
  if (!box || !window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;
  const boxRect = box.getBoundingClientRect();
  let bottom = null;

  const chips = [...(msgEl.querySelector('.reactions-row')?.children || [])].map(c => c.getBoundingClientRect());
  if (chips.length) {
    const lastRowTop = Math.max(...chips.map(c => c.top));
    const lastRow = chips.filter(c => c.top === lastRowTop);
    const left = Math.max(...lastRow.map(c => c.right)) - boxRect.left + 8;
    if (left + bar.offsetWidth <= boxRect.width - 8) {
      bar.style.left = `${left}px`;
      bar.style.right = 'auto';
      bottom = boxRect.bottom - lastRow[0].bottom - (bar.offsetHeight - lastRow[0].height) / 2;
      bar.style.bottom = `${bottom}px`;
    }
  }

  const list = msgEl.closest('#messages, #thread-messages, #dm-pip-messages');
  const below = list ? bar.getBoundingClientRect().bottom - list.getBoundingClientRect().bottom : 0;
  if (below > 0) {
    const now = bottom ?? (boxRect.bottom - bar.getBoundingClientRect().bottom);
    bar.style.bottom = `${now + below + 4}px`;
  }
},

_updateCodeBlockCopyPlacement(msgEl) {
  const toolbar = msgEl.querySelector('.msg-toolbar, .thread-msg-toolbar');
  const toolbarRect = toolbar?.getBoundingClientRect();
  const toolbarVisible = toolbarRect
    && toolbarRect.right > toolbarRect.left
    && toolbarRect.bottom > toolbarRect.top;

  msgEl.querySelectorAll('.code-block').forEach(block => {
    block.classList.remove('copy-button-shifted');
    const button = block.querySelector('.code-block-copy');
    if (!button || !toolbarVisible) return;

    // Read after removing the shifted class so this always tests the button's
    // normal top-right position, including after a resize.
    const buttonRect = button.getBoundingClientRect();
    const overlaps = buttonRect.left < toolbarRect.right
      && buttonRect.right > toolbarRect.left
      && buttonRect.top < toolbarRect.bottom
      && buttonRect.bottom > toolbarRect.top;
    if (overlaps) block.classList.add('copy-button-shifted');
  });
},

_bindMessageClicks() {
  this._bindCodeBlockCopy();

  // Image click: open lightbox overlay (CSP-safe, no inline handlers)
  document.getElementById('messages').addEventListener('click', (e) => {
    // A forum card handles its own clicks: the thumbnail opens the topic,
    // not the lightbox (#5646).
    if (e.target.closest('.forum-topic')) return;
    // Concealed media (hidden image / unrevealed spoiler) intercepts the click
    // before the lightbox opens.
    if (this._maybeRevealConcealed(e)) return;
    if (e.target.classList.contains('chat-image')) {
      this._lightboxContainer = document.getElementById('messages');
      this._openLightbox(this._lazyRealSrc ? this._lazyRealSrc(e.target) : e.target.src, e.target);
    }
    // Spoiler reveal toggle (text spoilers)
    if (e.target.closest('.spoiler')) {
      e.target.closest('.spoiler').classList.toggle('revealed');
    }
  });

  // Image click in thread panel, DM PiP, and the search results panel: same
  // lightbox with container-aware navigation, spoiler reveal, and image
  // right-click menu. Search reuses this wholesale. (search-overhaul phase 3)
  for (const containerId of ['thread-messages', 'dm-pip-messages', 'search-panel-list']) {
    const el = document.getElementById(containerId);
    if (el) {
      el.addEventListener('click', (e) => {
        if (this._maybeRevealConcealed(e)) return;
        if (e.target.closest('.spoiler')) {
          e.target.closest('.spoiler').classList.toggle('revealed');
          return;
        }
        if (e.target.classList.contains('chat-image')) {
          this._lightboxContainer = el;
          this._openLightbox(this._lazyRealSrc ? this._lazyRealSrc(e.target) : e.target.src, e.target);
        }
      });
      el.addEventListener('contextmenu', (e) => {
        if (e.target.classList.contains('chat-image')) {
          e.preventDefault();
          this._showImageContextMenu(e, this._lazyRealSrc ? this._lazyRealSrc(e.target) : e.target.src, { sourceImg: e.target });
        }
      });
    }
  }
  // Middle click on a picture opens it in a new tab, like a link (#5663).
  // One handler for every message list: the pop-out DM and the thread panel
  // had ended up with two each, so one click asked for two tabs. The
  // mousedown half stops Windows from starting its middle-button autoscroll
  // on the picture, which swallows the click before it gets here.
  const MIDCLICK_LISTS = '#messages, #thread-messages, #dm-pip-messages, #search-panel-list';
  const midClickImage = (e) => {
    if (e.button !== 1 || !e.target || !e.target.closest) return null;
    const img = e.target.closest('img.chat-image');
    return img && img.closest(MIDCLICK_LISTS) ? img : null;
  };
  document.addEventListener('mousedown', (e) => { if (midClickImage(e)) e.preventDefault(); });
  document.addEventListener('auxclick', (e) => {
    const img = midClickImage(e);
    if (!img) return;
    e.preventDefault();
    this._openImageInNewTab(img);
  });

  // Image right-click: custom context menu for chat thumbnails. Forum cards
  // open their own menus, so both menus no longer stack up there (#5650).
  document.getElementById('messages').addEventListener('contextmenu', (e) => {
    if (e.target.closest('.forum-topic')) return;
    if (e.target.classList.contains('chat-image')) {
      e.preventDefault();
      this._showImageContextMenu(e, this._lazyRealSrc ? this._lazyRealSrc(e.target) : e.target.src, { sourceImg: e.target });
    }
  });

  // Message right-click: custom context menu (edit / reply / quote / pin / delete).
  // Reuses the hover-toolbar actions; only opens over a real message row.
  document.getElementById('messages').addEventListener('contextmenu', (e) => {
    // Images have their own Save/Copy/Open menu (handled above), so leave them.
    if (e.target.closest('.chat-image')) return;
    // Videos and audio keep the browser's own menu (play, loop, controls).
    if (e.target.closest('video, audio')) return;
    // Inside the inline message-edit box, defer to the browser's native menu
    // so spell-check suggestions work; none of our items apply while editing.
    if (e.target.closest('.edit-textarea')) return;
    // Don't hijack right-click while picking messages to move.
    if (this._moveSelectionActive) return;
    const msgEl = e.target.closest('.message, .message-compact');
    if (!msgEl || !msgEl.dataset.msgId) return; // empty gutter / unsent rows → native menu
    // Right-click directly on the author name or avatar → unified user menu,
    // same as right-clicking the member list. Everything else on the row keeps
    // the message context menu.
    const authorTrigger = e.target.closest('.message-author, .message-avatar, .message-avatar-img');
    if (authorTrigger && !e.target.closest('.msg-toolbar')) {
      const userId = parseInt(msgEl.dataset.userId);
      if (!isNaN(userId) && (userId !== this.user.id || this.user.isAdmin)) {
        e.preventDefault();
        this._showUserContextMenu(e, userId, msgEl.dataset.username);
        return;
      }
    }
    // Preserve native copy: if text is selected inside this message, defer.
    const sel = window.getSelection?.();
    if (sel && !sel.isCollapsed && msgEl.contains(sel.anchorNode)) return;
    e.preventDefault();
    this._showMessageContextMenu(e, msgEl);
  });

  // Risky file download and masked link warnings. Delegated on document so
  // threads, the DM PiP, pins, search and forum views get them too; one
  // listener each, so a click never prompts twice.
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || !e.target.closest) return;
    const risky = e.target.closest('a.risky-file');
    if (risky) {
      e.preventDefault();
      const fileName = risky.getAttribute('download') || 'this file';
      const ext = fileName.split('.').pop().toLowerCase();
      this._showRiskyDownloadWarning(fileName, ext, risky.href);
      return;
    }
    const masked = e.target.closest('a[data-masked-link]');
    if (masked) {
      e.preventDefault();
      this._showExternalLinkWarning(masked.textContent, masked.href);
    }
  });

  // Reply banner click: scroll to the original message. A quote that leads
  // back to its message does the same.
  document.getElementById('messages').addEventListener('click', (e) => {
    const quoteId = this._quoteJumpId(e.target);
    if (quoteId) {
      this._jumpToMessage(quoteId);
      return;
    }
    const banner = e.target.closest('.reply-banner');
    if (!banner) return;
    const replyMsgId = banner.dataset.replyMsgId;
    if (!replyMsgId) return;
    this._jumpToMessage(parseInt(replyMsgId, 10));
  });

  // Tag chip click (message footer / search result): run a search for exactly
  // that tag. Delegated on document so it works in every surface that renders a
  // Tags footer without per-container wiring. (#tagging phase 2)
  document.addEventListener('click', (e) => {
    const chip = e.target.closest('.message-tag[data-tag]');
    if (!chip) return;
    e.preventDefault();
    e.stopPropagation();
    this._searchByTag?.(chip.dataset.tag);
  });

  // #channel-name link click: switch to the referenced channel.
  // Delegated globally so it works inside the main pane, thread panel, and
  // DM PiP without per-container wiring.
  document.addEventListener('click', (e) => {
    const link = e.target.closest('.channel-link[data-channel-code]');
    if (!link) return;
    const code = link.dataset.channelCode;
    if (!code) return;
    e.preventDefault();
    e.stopPropagation();
    const ch = (this.channels || []).find(c => c.code === code);
    if (ch && ch.is_dm) {
      this._openDMPiP?.(code);
    } else {
      this.switchChannel?.(code);
    }
  });

  // Thread preview click: open thread panel
  document.getElementById('messages').addEventListener('click', (e) => {
    const preview = e.target.closest('.thread-preview');
    if (!preview) return;
    const parentId = parseInt(preview.dataset.threadParent);
    if (parentId) this._toggleThread(parentId);
  });
},

_bindMessageActions() {
  // Double-clicking a message row is a shortcut for the reply toolbar action.
  // Keep the delegated handler on the list so it also covers compact rows and
  // messages rendered after history updates.
  document.getElementById('messages').addEventListener('dblclick', (e) => {
    const msgEl = e.target.closest('.message, .message-compact');
    if (!msgEl || !msgEl.dataset.msgId) return;
    // These targets have their own click/keyboard behavior and should not
    // unexpectedly start a reply when activated twice.
    if (e.target.closest('button, a, input, textarea, select, [contenteditable="true"], .msg-toolbar, .msg-dots-btn, .reply-banner, .thread-preview, .reaction-badge, .chat-image, .media-grid-tile, .spoiler')) return;
    // A double-click on a word selects it to copy; that is not a reply.
    if (window.getSelection?.()?.toString().trim()) return;
    const msgId = parseInt(msgEl.dataset.msgId, 10);
    if (!msgId || this._channelBlocksPosting?.()) return;
    e.preventDefault();
    this._setReply(msgEl, msgId);
  });

  // Messages container: move-selection mode intercept (supports Shift+click range)
  document.getElementById('messages').addEventListener('click', (e) => {
    if (!this._moveSelectionActive) return;
    // Don't intercept toolbar button clicks, or Move here as thread
    if (e.target.closest('.msg-toolbar, .msg-dots-btn, .move-thread-here-btn')) return;
    // Forum topic cards can be picked too.
    const msgEl = e.target.closest('.message, .message-compact, .forum-topic');
    if (msgEl) {
      e.preventDefault();
      e.stopPropagation();
      // The tap a long press leaves behind (app-move-to-thread.js).
      if (this._moveThreadSwallowing?.()) return;
      // In another channel than the selection, a message is picked to put
      // the selection under.
      if (this._moveThreadPickingHere?.()) {
        this._moveSelectedIntoThread(msgEl);
        return;
      }

      if (e.shiftKey && this._lastMoveSelectedEl) {
        // Shift+click: select all messages between last selected and this one
        const container = document.getElementById('messages');
        const allMsgs = Array.from(container.querySelectorAll('.message, .message-compact, .forum-topic'));
        const lastIdx = allMsgs.indexOf(this._lastMoveSelectedEl);
        const curIdx = allMsgs.indexOf(msgEl);
        if (lastIdx !== -1 && curIdx !== -1) {
          const start = Math.min(lastIdx, curIdx);
          const end = Math.max(lastIdx, curIdx);
          for (let i = start; i <= end; i++) {
            const id = parseInt(allMsgs[i].dataset.msgId);
            if (id && !this._moveSelectedIds.has(id)) {
              if (this._moveSelectedIds.size >= 200) break;
              this._moveSelectedIds.add(id);
              allMsgs[i].classList.add('move-selected');
            }
          }
          this._updateMoveCount();
        }
      } else {
        this._toggleMoveSelect(msgEl);
        this._lastMoveSelectedEl = msgEl;
      }
    }
  }, true); // capture phase so it fires before the toolbar action handler

  // Messages container: delegate reaction and reply button clicks
  document.getElementById('messages').addEventListener('click', async (e) => {
    const target = e.target.closest('[data-action]');
    if (!target) return;

    const action = target.dataset.action;
    const msgEl = target.closest('.message, .message-compact');
    if (!msgEl) return;

    const msgId = parseInt(msgEl.dataset.msgId);
    if (!msgId) return;
    if (['reply', 'quote', 'thread'].includes(action) && this._channelBlocksPosting?.()) return this._showToast?.(t('thread_runtime.read_only_no_replies'), 'info');

    if (action === 'react') {
      this._showReactionPicker(msgEl, msgId);
    } else if (action === 'reply') {
      this._setReply(msgEl, msgId);
    } else if (action === 'thread') {
      // Threads are not available in DMs.
      const curCh = this.channels && this.channels.find(c => c.code === this.currentChannel);
      if (curCh && curCh.is_dm) {
        this._showToast?.(t('thread_list.unavailable_in_dm'), 'info');
        return;
      }
      this._toggleThread(msgId);
    } else if (action === 'quote') {
      this._quoteMessage(msgEl);
    } else if (action === 'edit') {
      this._startEditMessage(msgEl, msgId);
    } else if (action === 'delete') {
      // A protected message cannot be deleted by anyone; the server says the same.
      if (msgEl.dataset.archived === '1') return this._showToast?.(t('app.messages.protected_no_delete'), 'error');
      if (await this._showConfirmModal(t('confirm.delete_message'), '', { danger: true, confirmLabel: t('msg_toolbar.delete') })) {
        this.socket.emit('delete-message', { messageId: msgId, attachments: this._getMessageAttachments?.(msgId) });
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
      this._copyChannelLink(this.currentChannel, msgId);
    } else if (action === 'nsfw' || action === 'unnsfw') {
      this._setMessageNsfw(msgId, action === 'nsfw');
    }
  });

  // Reaction badge click (toggle own reaction)
  document.getElementById('messages').addEventListener('click', (e) => {
    const badge = e.target.closest('.reaction-badge');
    if (!badge) return;
    this._hideReactionPopout();
    const msgEl = badge.closest('.message, .message-compact');
    if (!msgEl) return;
    const msgId = parseInt(msgEl.dataset.msgId);
    const emoji = badge.dataset.emoji;
    const hasOwn = badge.classList.contains('own');
    if (hasOwn) {
      this.socket.emit('remove-reaction', { messageId: msgId, emoji });
    } else {
      this.socket.emit('add-reaction', { messageId: msgId, emoji });
    }
  });

  // Thread panel reactions: open picker + toggle reaction on badges
  const threadMessages = document.getElementById('thread-messages');
  if (threadMessages) {
    threadMessages.addEventListener('click', async (e) => {
      const threadActionBtn = e.target.closest('[data-thread-action]');
      if (threadActionBtn) {
        const msgEl = threadActionBtn.closest('.thread-message');
        if (!msgEl) return;
        const msgId = parseInt(msgEl.dataset.msgId, 10);
        if (!msgId) return;
        e.preventDefault();
        e.stopPropagation();
        const action = threadActionBtn.dataset.threadAction;
        if (action === 'react') {
          this._showReactionPicker(msgEl, msgId);
        } else if (action === 'reply') {
          this._setThreadReply(msgEl, msgId);
        } else if (action === 'quote') {
          this._quoteThreadMessage(msgEl);
        } else if (action === 'edit') {
          this._startEditMessage(msgEl, msgId);
        } else if (action === 'nsfw' || action === 'unnsfw') {
          this._setMessageNsfw(msgId, action === 'nsfw');
        } else if (action === 'delete') {
          if (await this._showConfirmModal(t('confirm.delete_message'), '', { danger: true, confirmLabel: t('msg_toolbar.delete') })) {
            this.socket.emit('delete-message', { messageId: msgId, attachments: this._getMessageAttachments?.(msgId) });
          }
        }
        return;
      }

      const banner = e.target.closest('.reply-banner');
      if (banner) {
        const replyMsgId = parseInt(banner.dataset.replyMsgId || '', 10);
        if (!replyMsgId) return;
        const target = threadMessages.querySelector(`[data-msg-id="${replyMsgId}"]`);
        if (target) {
          // The same jump and flash as a reply in the channel.
          this._scrollToMessage(target);
          target.classList.remove('highlight-flash');
          void target.offsetWidth;
          target.classList.add('highlight-flash');
          setTimeout(() => target.classList.remove('highlight-flash'), 2000);
        }
        return;
      }

      const badge = e.target.closest('.reaction-badge');
      if (!badge) return;
      this._hideReactionPopout();
      const msgEl = badge.closest('.thread-message');
      if (!msgEl) return;
      const msgId = parseInt(msgEl.dataset.msgId, 10);
      const emoji = badge.dataset.emoji;
      const hasOwn = badge.classList.contains('own');
      if (!msgId || !emoji) return;
      if (hasOwn) {
        this.socket.emit('remove-reaction', { messageId: msgId, emoji });
      } else {
        this.socket.emit('add-reaction', { messageId: msgId, emoji });
      }
    });
  }

  // Keep toolbar overflow menus visible: flip below when top space is too small.
  const updateToolbarOverflowDirection = (moreWrap) => {
    if (!moreWrap) return;
    const overflow = moreWrap.querySelector('.msg-toolbar-overflow, .thread-msg-overflow');
    if (!overflow) return;

    overflow.classList.remove('flip-below');

    const container = moreWrap.closest('#messages, #thread-messages, #dm-pip-messages');
    const containerRect = container
      ? container.getBoundingClientRect()
      : { top: 0, bottom: window.innerHeight };
    const moreRect = moreWrap.getBoundingClientRect();
    const menuHeight = Math.max(overflow.scrollHeight, 40) + 8;
    const spaceAbove = moreRect.top - containerRect.top;
    const spaceBelow = containerRect.bottom - moreRect.bottom;

    // Open downward when opening upward would clip in the current visible viewport.
    if (spaceAbove < menuHeight && spaceBelow > spaceAbove) {
      overflow.classList.add('flip-below');
    }
  };

  const bindOverflowDirection = (container) => {
    if (!container) return;

    container.addEventListener('mouseover', (e) => {
      const moreWrap = e.target.closest('.msg-toolbar-more, .thread-msg-more');
      if (!moreWrap) return;
      updateToolbarOverflowDirection(moreWrap);
    });

    container.addEventListener('focusin', (e) => {
      const moreWrap = e.target.closest('.msg-toolbar-more, .thread-msg-more');
      if (!moreWrap) return;
      updateToolbarOverflowDirection(moreWrap);
    });
  };

  bindOverflowDirection(document.getElementById('messages'));
  bindOverflowDirection(threadMessages);
  bindOverflowDirection(document.getElementById('dm-pip-messages'));

  // Reaction badge hover: show popout with user list. The popout sits a few
  // pixels away from its badge, so hiding waits a moment: the pointer can
  // cross that gap (or cut a corner) and reach the popout's scroll bar.
  {
    let _popoutTimer = null;
    let _hideTimer = null;
    const isOpenFor = (badge) => {
      const pop = document.getElementById('reaction-popout');
      return !!pop && pop._badge === badge;
    };
    const onBadgeOver = (e) => {
      const badge = e.target.closest('.reaction-badge');
      if (!badge) return;
      clearTimeout(_hideTimer);
      _hideTimer = null;
      clearTimeout(_popoutTimer);
      if (isOpenFor(badge)) return;
      _popoutTimer = setTimeout(() => this._showReactionPopout(badge), 350);
    };
    const scheduleHide = () => {
      clearTimeout(_popoutTimer);
      if (_hideTimer || !document.getElementById('reaction-popout')) return;
      _hideTimer = setTimeout(() => {
        _hideTimer = null;
        this._hideReactionPopout();
      }, 300);
    };
    for (const id of ['messages', 'thread-messages', 'dm-pip-messages']) {
      document.getElementById(id)?.addEventListener('mouseover', onBadgeOver);
    }
    document.addEventListener('mouseover', (e) => {
      if (e.target.closest('#reaction-popout')) {
        clearTimeout(_hideTimer);
        _hideTimer = null;
      } else if (!e.target.closest('.reaction-badge')) {
        scheduleHide();
      }
    });
    // Pointer left the window entirely: no mouseover follows, so hide here.
    document.addEventListener('mouseout', (e) => {
      if (!e.relatedTarget) scheduleHide();
    });
  }

  // ── Poll vote click (delegated from messages container) ──
  // Role menu buttons: one click gives you the role, another takes it back.
  document.getElementById('messages').addEventListener('click', (e) => {
    const btn = e.target.closest('.role-menu-btn');
    if (!btn) return;
    e.stopPropagation();
    const messageId = parseInt(btn.dataset.msgId, 10);
    const roleId = parseInt(btn.dataset.roleId, 10);
    if (!messageId || !roleId) return;
    btn.disabled = true;
    this.socket.emit('toggle-self-role', { messageId, roleId, held: !btn.classList.contains('held') }, (res) => {
      btn.disabled = false;
      if (res?.error) return this._showToast(res.error, 'error');
      this._markSelfRole(roleId, !!res?.held);
    });
  });

  document.getElementById('messages').addEventListener('click', (e) => {
    const optBtn = e.target.closest('.poll-option');
    if (!optBtn) return;
    const msgId = parseInt(optBtn.dataset.msgId);
    const optionIndex = parseInt(optBtn.dataset.option);
    if (!msgId || isNaN(optionIndex)) return;
    const hasVote = optBtn.classList.contains('poll-voted');
    if (hasVote) {
      this.socket.emit('unvote-poll', { messageId: msgId, optionIndex });
    } else {
      this.socket.emit('vote-poll', { messageId: msgId, optionIndex });
    }
  });
},

};
