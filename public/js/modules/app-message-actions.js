// Clicks on messages: pictures and the lightbox, context menus, risky file
// and masked link warnings, replies, tags, channel links, the message toolbar,
// reactions and their hover list, poll votes and role menu buttons.

export default {

_bindMessageClicks() {
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

  // Risky file download warning: intercept clicks on potentially harmful files
  document.getElementById('messages').addEventListener('click', (e) => {
    const link = e.target.closest('a.risky-file');
    if (!link) return;
    e.preventDefault();
    const fileName = link.getAttribute('download') || 'this file';
    const ext = fileName.split('.').pop().toLowerCase();
    this._showRiskyDownloadWarning(fileName, ext, link.href);
  });

  // Masked markdown link warning: show URL confirmation before navigating
  document.getElementById('messages').addEventListener('click', (e) => {
    const link = e.target.closest('a[data-masked-link]');
    if (!link) return;
    e.preventDefault();
    this._showExternalLinkWarning(link.textContent, link.href);
  });

  // Reply banner click: scroll to the original message
  document.getElementById('messages').addEventListener('click', (e) => {
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
    if (parentId) this._openThread(parentId);
  });
},

_bindMessageActions() {
  // Messages container: move-selection mode intercept (supports Shift+click range)
  document.getElementById('messages').addEventListener('click', (e) => {
    if (!this._moveSelectionActive) return;
    // Don't intercept toolbar button clicks
    if (e.target.closest('.msg-toolbar, .msg-dots-btn')) return;
    const msgEl = e.target.closest('.message, .message-compact');
    if (msgEl) {
      e.preventDefault();
      e.stopPropagation();

      if (e.shiftKey && this._lastMoveSelectedEl) {
        // Shift+click: select all messages between last selected and this one
        const container = document.getElementById('messages');
        const allMsgs = Array.from(container.querySelectorAll('.message, .message-compact'));
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
      this._openThread(msgId);
    } else if (action === 'quote') {
      this._quoteMessage(msgEl);
    } else if (action === 'edit') {
      this._startEditMessage(msgEl, msgId);
    } else if (action === 'delete') {
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
          target.scrollIntoView({ block: 'center', behavior: 'smooth' });
          target.classList.add('thread-highlight');
          setTimeout(() => target.classList.remove('thread-highlight'), 1200);
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

  // Reaction badge hover: show popout with user list
  {
    let _popoutTimer = null;
    const msgs = document.getElementById('messages');
    const threadMsgs = document.getElementById('thread-messages');
    msgs.addEventListener('mouseover', (e) => {
      const badge = e.target.closest('.reaction-badge');
      if (!badge) return;
      clearTimeout(_popoutTimer);
      _popoutTimer = setTimeout(() => this._showReactionPopout(badge), 350);
    });
    if (threadMsgs) {
      threadMsgs.addEventListener('mouseover', (e) => {
        const badge = e.target.closest('.reaction-badge');
        if (!badge) return;
        clearTimeout(_popoutTimer);
        _popoutTimer = setTimeout(() => this._showReactionPopout(badge), 350);
      });
      threadMsgs.addEventListener('mouseout', (e) => {
        const badge = e.target.closest('.reaction-badge');
        if (!badge && !e.target.closest('#reaction-popout')) {
          clearTimeout(_popoutTimer);
          setTimeout(() => {
            if (!document.querySelector('#reaction-popout:hover')) this._hideReactionPopout();
          }, 200);
        }
      });
    }
    msgs.addEventListener('mouseout', (e) => {
      const badge = e.target.closest('.reaction-badge');
      if (!badge && !e.target.closest('#reaction-popout')) {
        clearTimeout(_popoutTimer);
        setTimeout(() => {
          if (!document.querySelector('#reaction-popout:hover')) this._hideReactionPopout();
        }, 200);
      }
    });
    document.addEventListener('mouseover', (e) => {
      if (!e.target.closest('#reaction-popout') && !e.target.closest('.reaction-badge')) {
        clearTimeout(_popoutTimer);
        this._hideReactionPopout();
      }
    });
    // DM PiP reaction badge popout
    const dmPipMsgs = document.getElementById('dm-pip-messages');
    if (dmPipMsgs) {
      dmPipMsgs.addEventListener('mouseover', (e) => {
        const badge = e.target.closest('.reaction-badge');
        if (!badge) return;
        clearTimeout(_popoutTimer);
        _popoutTimer = setTimeout(() => this._showReactionPopout(badge), 350);
      });
      dmPipMsgs.addEventListener('mouseout', (e) => {
        const badge = e.target.closest('.reaction-badge');
        if (!badge && !e.target.closest('#reaction-popout')) {
          clearTimeout(_popoutTimer);
          setTimeout(() => {
            if (!document.querySelector('#reaction-popout:hover')) this._hideReactionPopout();
          }, 200);
        }
      });
    }
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
