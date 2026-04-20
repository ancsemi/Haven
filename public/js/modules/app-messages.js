// Cache generated video thumbnails so each URL is only captured once
const _thumbCache = new Map();

export default {

// ── Messages ──────────────────────────────────────────

async _sendMessage() {
  const input = document.getElementById('message-input');
  const content = input.value.trim();
  const hasImages = this._imageQueue && this._imageQueue.length > 0;
  if (!content && !hasImages) return;
  if (!this.currentChannel) return;
  if (!this.socket.connected) {
    this._showToast("Not connected — message not sent", 'error');
    return;
  }

  // Client-side slash commands (not sent to server)
  if (content.startsWith('/')) {
    // /tts:stop — cancel all speech synthesis immediately
    if (content.trim().toLowerCase() === '/tts:stop') {
      this.notifications?.stopTTS();
      this._showToast('TTS stopped', 'info');
      input.value = '';
      input.style.height = 'auto';
      this._hideMentionDropdown();
      this._hideSlashDropdown();
      return;
    }
    const parts = content.match(/^\/(\w+)(?:\s+(.*))?$/);
    if (parts) {
      const cmd = parts[1].toLowerCase();
      const arg = (parts[2] || '').trim();
      if (cmd === 'clear') {
        document.getElementById('messages').innerHTML = '';
        input.value = '';
        input.style.height = 'auto';
        this._hideMentionDropdown();
        this._hideSlashDropdown();
        return;
      }
      if (cmd === 'nick' && arg) {
        this.socket.emit('rename-user', { username: arg });
        input.value = '';
        input.style.height = 'auto';
        this._hideMentionDropdown();
        this._hideSlashDropdown();
        return;
      }
      if (cmd === 'play') {
        if (!arg) { this._showToast(t('commands.play_usage'), 'error'); }
        else if (!this.voice || !this.voice.inVoice) { this._showToast(t('toasts.join_voice_first'), 'error'); }
        else if (this._getMusicEmbed(arg)) {
          // Direct URL — share immediately
          this.socket.emit('music-share', { code: this.voice.currentChannel, url: arg });
        } else {
          // Not a URL — treat as a search query
          this._musicSearchQuery = arg;
          this._musicSearchOffset = 0;
          this.socket.emit('music-search', { query: arg, offset: 0 });
          this._showToast(t('toasts.searching'), 'info');
        }
        input.value = '';
        input.style.height = 'auto';
        this._hideMentionDropdown();
        this._hideSlashDropdown();
        return;
      }
      if (cmd === 'gif') {
        if (!arg) { this._showToast(t('commands.gif_usage'), 'error'); }
        else { this._showGifSlashResults(arg); }
        input.value = '';
        input.style.height = 'auto';
        this._hideMentionDropdown();
        this._hideSlashDropdown();
        return;
      }
      if (cmd === 'poll') {
        input.value = '';
        input.style.height = 'auto';
        this._hideMentionDropdown();
        this._hideSlashDropdown();
        this._openPollModal();
        return;
      }
    }
  }

  const payload = { code: this.currentChannel, content };
  if (this.replyingTo) {
    payload.replyTo = this.replyingTo.id;
  }

  // Clear UI immediately (before any async E2E work)
  input.value = '';
  input.style.height = 'auto';
  input.focus();
  this._clearReply();
  this._hideMentionDropdown();
  this._hideSlashDropdown();
  // Close the emoji picker when a message is sent
  const picker = document.getElementById('emoji-picker');
  if (picker) picker.style.display = 'none';

  // Send text message if there is one
  if (content) {
    // E2E: encrypt DM messages
    const ch = this.channels.find(c => c.code === this.currentChannel);
    const isDm = ch && ch.is_dm && ch.dm_target;
    let partner = this._getE2EPartner();

    // Pre-process content-transforming slash commands client-side so they
    // survive E2E encryption (server can't parse encrypted slash commands)
    if (isDm) {
      const slashMatch = content.trim().match(/^\/([a-zA-Z]+)(?:\s+(.*))?$/);
      if (slashMatch) {
        const cmd = slashMatch[1].toLowerCase();
        const arg = (slashMatch[2] || '').trim();
        const displayName = this.user.displayName || this.user.username;
        const clientSlash = {
          spoiler:   () => arg ? `||${arg}||` : null,
          shrug:     () => `${arg ? arg + ' ' : ''}¯\\_(ツ)_/¯`,
          tableflip: () => `${arg ? arg + ' ' : ''}(╯°□°)╯︵ ┻━┻`,
          unflip:    () => `${arg ? arg + ' ' : ''}┬─┬ ノ( ゜-゜ノ)`,
          lenny:     () => `${arg ? arg + ' ' : ''}( ͡° ͜ʖ ͡°)`,
          me:        () => arg ? `_${displayName} ${arg}_` : null,
        };
        if (clientSlash[cmd]) {
          const transformed = clientSlash[cmd]();
          if (transformed !== null) {
            payload.content = transformed;
            content = transformed;
          }
        }
      }
    }

    // If DM but partner key not yet cached, request it via promise
    if (isDm && !partner && this.e2e && this.e2e.ready) {
      const jwk = await this.e2e.requestPartnerKey(this.socket, ch.dm_target.id);
      if (jwk) {
        this._dmPublicKeys[ch.dm_target.id] = jwk;
        partner = this._getE2EPartner();
      }
      if (!partner) {
        this._showToast(t('toasts.encryption_key_unavailable'), 'warning');
      }
    }

    if (partner) {
      try {
        const encrypted = await this.e2e.encrypt(content, partner.userId, partner.publicKeyJwk);
        payload.content = encrypted;
        payload.encrypted = true;
      } catch (err) {
        console.warn('[E2E] Encryption failed:', err);
        this._showToast(t('toasts.encryption_failed'), 'warning');
      }
    }
    this.socket.emit('send-message', payload);
    this.notifications.play('sent');
  }

  // Upload queued images
  if (hasImages) {
    this._flushImageQueue();
  }
},

_jumpToMessage(msgId) {
  const existing = document.querySelector(`#messages [data-msg-id="${msgId}"]`);
  if (existing) {
    existing.scrollIntoView({ behavior: 'smooth', block: 'center' });
    existing.classList.add('highlight-flash');
    setTimeout(() => existing.classList.remove('highlight-flash'), 2000);
    return;
  }
  // Message not in DOM — fetch messages around it
  this._jumpTargetId = msgId;
  this.socket.emit('get-messages', { code: this.currentChannel, around: msgId });
},

_renderMessages(messages, lastReadMessageId) {
  const container = document.getElementById('messages');
  container.innerHTML = '';
  // Only render the last MAX_DOM_MESSAGES to prevent OOM on large histories
  const MAX_DOM_MESSAGES = 100;
  const start = messages.length > MAX_DOM_MESSAGES ? messages.length - MAX_DOM_MESSAGES : 0;
  // Use DocumentFragment to batch all DOM inserts into a single reflow
  const frag = document.createDocumentFragment();

  // Determine where to insert the "NEW MESSAGES" divider.
  // Only show it when there are actually unread messages and the last message
  // isn't already "read" (i.e. the user isn't fully caught up).
  let newMsgDividerInserted = false;
  const showDivider = lastReadMessageId && messages.length > 0
    && messages[messages.length - 1].id > lastReadMessageId
    // Don't show divider if ALL messages are unread (nothing before the line)
    && messages[start]?.id <= lastReadMessageId;

  for (let i = start; i < messages.length; i++) {
    const prevMsg = i > start ? messages[i - 1] : null;

    // Insert "NEW MESSAGES" divider before the first unread message
    if (showDivider && !newMsgDividerInserted && messages[i].id > lastReadMessageId
        && messages[i].user_id !== this.user?.id) {
      const divider = document.createElement('div');
      divider.className = 'new-messages-divider';
      divider.id = 'new-messages-divider';
      divider.innerHTML = '<span>NEW MESSAGES</span>';
      frag.appendChild(divider);
      newMsgDividerInserted = true;
    }

    frag.appendChild(this._createMessageEl(messages[i], prevMsg));
  }
  container.appendChild(frag);
  const jumpId = this._jumpTargetId;
  if (jumpId) {
    // Jump-to-message mode: scroll to target instead of bottom
    this._jumpTargetId = null;
    this._coupledToBottom = false;
    const scrollToTarget = () => {
      const target = container.querySelector(`[data-msg-id="${jumpId}"]`);
      if (target) {
        target.scrollIntoView({ block: 'center' });
        target.classList.add('highlight-flash');
        setTimeout(() => target.classList.remove('highlight-flash'), 2000);
      }
    };
    scrollToTarget();
    requestAnimationFrame(scrollToTarget);
    setTimeout(scrollToTarget, 300);
  } else if (newMsgDividerInserted) {
    // Scroll to the "NEW MESSAGES" divider so the user sees where they left off
    this._coupledToBottom = false;
    const scrollToDivider = () => {
      const divider = document.getElementById('new-messages-divider');
      if (divider) divider.scrollIntoView({ block: 'start' });
    };
    scrollToDivider();
    requestAnimationFrame(scrollToDivider);
    setTimeout(scrollToDivider, 300);
    // Show jump-to-bottom button since we're not at the bottom
    const jumpBtn = document.getElementById('jump-to-bottom');
    if (jumpBtn) jumpBtn.classList.add('visible');
  } else {
    this._scrollToBottom(true);
    // Re-scroll after images load, but only if user hasn't scrolled away
    container.querySelectorAll('img').forEach(img => {
      if (!img.complete) img.addEventListener('load', () => {
        if (this._coupledToBottom) this._scrollToBottom(true);
      }, { once: true });
    });
    // Deferred re-scroll: images, link previews, and E2E decryption can add
    // height after the synchronous scrollToBottom above.  Force a re-scroll
    // after layout settles to prevent DMs from landing mid-history.
    requestAnimationFrame(() => this._scrollToBottom(true));
    setTimeout(() => { if (this._coupledToBottom) this._scrollToBottom(true); }, 300);
  }
  // Fetch link previews for all messages
  this._fetchLinkPreviews(container);
  this._setupVideos(container);
  // Decrypt E2E images (async — renders as images load)
  this._decryptE2EImages(container);
  // Mark as read (last message ID)
  if (messages.length > 0) {
    this._markRead(messages[messages.length - 1].id);
  }
},

/** Prepend older messages to the top, anchored to a visible on-screen message.
 *
 *  The viewport pins to a message the user is currently looking at.  After
 *  inserting older history above and trimming newer history below, the anchor
 *  message is restored to the exact same pixel offset.  Async content loads
 *  (images, link previews, YouTube embeds) in the prepended area are also
 *  corrected so the anchor never drifts.
 */
_prependMessages(messages) {
  const container = document.getElementById('messages');

  // 1. Freeze scroll listeners
  this._suppressCoupleCheck = true;

  // 2. Find anchor: first message element whose bounds intersect the viewport
  let anchorEl = null;
  let anchorOffset = 0;
  const containerRect = container.getBoundingClientRect();
  for (const child of container.querySelectorAll('.message, .message-compact')) {
    const r = child.getBoundingClientRect();
    if (r.bottom > containerRect.top && r.top < containerRect.bottom) {
      anchorEl = child;
      anchorOffset = r.top - containerRect.top;
      break;
    }
  }

  // 3. Build fragment
  const fragment = document.createDocumentFragment();
  const addedEls = [];
  messages.forEach((msg, i) => {
    const prevMsg = i > 0 ? messages[i - 1] : null;
    const el = this._createMessageEl(msg, prevMsg);
    fragment.appendChild(el);
    addedEls.push(el);
  });

  // 4. Insert at top
  container.insertBefore(fragment, container.firstChild);

  // 5. Realign anchor immediately after insert
  const realign = () => {
    if (!anchorEl) return;
    const cr = container.getBoundingClientRect();
    const ar = anchorEl.getBoundingClientRect();
    const drift = (ar.top - cr.top) - anchorOffset;
    if (Math.abs(drift) > 0.5) container.scrollTop += drift;
  };
  realign();

  // 6. Trim from both ends to CENTER the anchor within the DOM window.
  //    This puts the scrollbar near the middle of the track, giving the user
  //    freedom to scroll in either direction after a load/trim cycle.
  const MAX_DOM_MESSAGES = 100;
  const total = container.children.length;
  if (total > MAX_DOM_MESSAGES && anchorEl) {
    const anchorIdx = Array.from(container.children).indexOf(anchorEl);
    const half = Math.floor(MAX_DOM_MESSAGES / 2);
    let keepStart = Math.max(0, anchorIdx - half);
    let keepEnd = keepStart + MAX_DOM_MESSAGES;
    if (keepEnd > total) {
      keepEnd = total;
      keepStart = Math.max(0, total - MAX_DOM_MESSAGES);
    }

    // Trim from bottom first (below viewport — no visual shift)
    const trimBottom = total - keepEnd;
    if (trimBottom > 0) {
      for (let i = 0; i < trimBottom; i++) container.removeChild(container.lastElementChild);
      this._noMoreFuture = false;
      const last = container.lastElementChild;
      if (last && last.dataset && last.dataset.msgId) {
        this._newestMsgId = parseInt(last.dataset.msgId);
      }
    }

    // Trim from top (above viewport — adjust scrollTop to compensate)
    if (keepStart > 0) {
      const hBefore = container.scrollHeight;
      for (let i = 0; i < keepStart; i++) container.removeChild(container.firstElementChild);
      container.scrollTop -= (hBefore - container.scrollHeight);
      this._noMoreHistory = false;
      const first = container.firstElementChild;
      if (first && first.dataset && first.dataset.msgId) {
        this._oldestMsgId = parseInt(first.dataset.msgId);
      }
    }

    realign();
  } else if (total > MAX_DOM_MESSAGES) {
    // No anchor — just trim from bottom
    const excess = total - MAX_DOM_MESSAGES;
    for (let i = 0; i < excess; i++) container.removeChild(container.lastElementChild);
    this._noMoreFuture = false;
    const last = container.lastElementChild;
    if (last && last.dataset && last.dataset.msgId) {
      this._newestMsgId = parseInt(last.dataset.msgId);
    }
  }

  // 7. Keep anchor stable while async content (images, embeds, link previews)
  //    loads in the prepended area above the viewport.
  for (const el of addedEls) {
    if (!container.contains(el)) continue;
    el.querySelectorAll('img').forEach(img => {
      if (!img.complete) {
        img.addEventListener('load', () => { if (!this._coupledToBottom) realign(); }, { once: true });
        img.addEventListener('error', () => { if (!this._coupledToBottom) realign(); }, { once: true });
      }
    });
  }

  // Watch for DOM changes in prepended messages (link previews, YouTube
  // embeds, E2E image decryption) that add height above the anchor.
  const mo = new MutationObserver(() => { if (!this._coupledToBottom) realign(); });
  for (const el of addedEls) {
    if (!container.contains(el)) continue;
    mo.observe(el, { childList: true, subtree: true });
  }
  setTimeout(() => mo.disconnect(), 15000);

  // 8. Unfreeze on next frame
  requestAnimationFrame(() => { this._suppressCoupleCheck = false; });

  // Process only newly-prepended messages still in DOM
  for (const el of addedEls) {
    if (!container.contains(el)) continue;
    this._fetchLinkPreviews(el);
    this._setupVideos(el);
    this._decryptE2EImages(el);
  }
},

/** Append newer messages to the bottom (forward pagination), trimming old ones from top */
_appendMessages(messages) {
  const container = document.getElementById('messages');
  const wasAtBottom = this._coupledToBottom;

  // Freeze scroll listeners during DOM manipulation
  this._suppressCoupleCheck = true;

  const fragment = document.createDocumentFragment();
  messages.forEach((msg, i) => {
    let prevMsg = null;
    if (i > 0) {
      prevMsg = messages[i - 1];
    } else {
      // Link to existing last message for grouping
      const lastEl = container.lastElementChild;
      if (lastEl && lastEl.dataset && lastEl.dataset.userId && lastEl.dataset.msgId) {
        prevMsg = { user_id: parseInt(lastEl.dataset.userId), created_at: lastEl.dataset.time };
      }
    }
    fragment.appendChild(this._createMessageEl(msg, prevMsg));
  });
  container.appendChild(fragment);

  // Trim oldest messages from the top with scroll compensation.
  // Without this, removing elements above the viewport shifts the
  // scroll position and causes a visible jump.
  const MAX_DOM_MESSAGES = 100;
  let trimmed = false;
  if (container.children.length > MAX_DOM_MESSAGES) {
    trimmed = true;
    const hBefore = container.scrollHeight;
    while (container.children.length > MAX_DOM_MESSAGES) {
      container.removeChild(container.firstElementChild);
    }
    container.scrollTop -= (hBefore - container.scrollHeight);
  }

  // Update _oldestMsgId to match what's still in the DOM
  const firstChild = container.firstElementChild;
  if (firstChild && firstChild.dataset && firstChild.dataset.msgId) {
    this._oldestMsgId = parseInt(firstChild.dataset.msgId);
  }
  // Older messages were trimmed — re-enable backward pagination so the
  // user can scroll up again to reload them.
  if (trimmed) this._noMoreHistory = false;

  this._fetchLinkPreviews(container);
  this._setupVideos(container);
  this._decryptE2EImages(container);

  // Mark as read so the server-side read position advances
  if (messages.length > 0) {
    this._markRead(messages[messages.length - 1].id);
  }

  if (wasAtBottom) this._scrollToBottom(true);

  // Unfreeze on next frame
  requestAnimationFrame(() => { this._suppressCoupleCheck = false; });
},

_appendMessage(message, forceScroll = false) {
  const container = document.getElementById('messages');
  const lastMsg = container.lastElementChild;

  let prevMsg = null;
  // Only use last element for grouping if it's an actual message (not a system message)
  if (lastMsg && lastMsg.dataset && lastMsg.dataset.userId && lastMsg.dataset.msgId) {
    prevMsg = {
      user_id: parseInt(lastMsg.dataset.userId),
      created_at: lastMsg.dataset.time
    };
  }

  const wasAtBottom = forceScroll || this._coupledToBottom;
  const msgEl = this._createMessageEl(message, prevMsg);
  container.appendChild(msgEl);

  // ── DOM trimming: remove oldest messages when the list grows too large ──
  // This prevents unbounded memory growth that causes OOM crashes.
  const MAX_DOM_MESSAGES = 100;
  const trimmed = container.children.length > MAX_DOM_MESSAGES;
  while (container.children.length > MAX_DOM_MESSAGES) {
    container.removeChild(container.firstElementChild);
  }
  // Keep _oldestMsgId in sync with the DOM after trimming
  const firstEl = container.firstElementChild;
  if (firstEl && firstEl.dataset && firstEl.dataset.msgId) {
    this._oldestMsgId = parseInt(firstEl.dataset.msgId);
  }
  // Re-enable backward pagination since we trimmed old messages
  if (trimmed) this._noMoreHistory = false;

  // Fetch link previews for this message
  this._fetchLinkPreviews(msgEl);
  this._setupVideos(msgEl);
  this._decryptE2EImages(msgEl);
  if (wasAtBottom) {
    this._scrollToBottom(true);
  }
  // Scroll after images/gifs load, but only if still coupled to bottom
  const imgs = msgEl.querySelectorAll('img');
  if (imgs.length) {
    imgs.forEach(img => {
      if (!img.complete) {
        img.addEventListener('load', () => {
          if (this._coupledToBottom) this._scrollToBottom(true);
        }, { once: true });
        img.addEventListener('error', () => {
          if (this._coupledToBottom) this._scrollToBottom(true);
        }, { once: true });
      }
    });
  }
},

_createMessageEl(msg, prevMsg) {
  const isImage = this._isImageUrl(msg.content);
  const curCh = this.channels && this.channels.find(c => c.code === this.currentChannel);
  const isAnnouncement = curCh && curCh.notification_type === 'announcement';
  const isCompact = prevMsg &&
    prevMsg.user_id === msg.user_id &&
    !msg.reply_to &&
    (new Date(msg.created_at) - new Date(prevMsg.created_at)) < 5 * 60 * 1000;

  const reactionsHtml = this._renderReactions(msg.id, msg.reactions || []);
  const pollHtml = msg.poll ? this._renderPollWidget(msg.id, msg.poll) : '';
  const threadHtml = msg.thread ? this._renderThreadPreview(msg.id, msg.thread) : '';
  const editedHtml = msg.edited_at ? `<span class="edited-tag" title="${t('app.messages.edited_at', { date: new Date(msg.edited_at).toLocaleString() })}">${t('app.messages.edited')}</span>` : '';
  const pinnedTag = msg.pinned ? `<span class="pinned-tag" title="${t('app.messages.pinned')}">📌</span>` : '';
  const archivedTag = msg.is_archived ? `<span class="archived-tag" title="${t('app.messages.protected')}">🛡️</span>` : '';
  const e2eTag = msg._e2e ? `<span class="e2e-tag" title="${t('app.messages.e2e_encrypted')}">🔒</span>` : '';

  const iconPair = (emoji, monoSvg) => `<span class="tb-icon tb-icon-emoji" aria-hidden="true">${emoji}</span><span class="tb-icon tb-icon-mono" aria-hidden="true">${monoSvg}</span>`;
  const iReact = iconPair('😀', '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke-width="1.8"></circle><path d="M8.5 14.5c1 1.2 2.2 1.8 3.5 1.8s2.5-.6 3.5-1.8" stroke-width="1.8" stroke-linecap="round"></path><circle cx="9.2" cy="10.2" r="1" fill="currentColor" stroke="none"></circle><circle cx="14.8" cy="10.2" r="1" fill="currentColor" stroke="none"></circle></svg>');
  const iReply = iconPair('↩️', '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 8L4 12L10 16" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path><path d="M20 12H5" stroke-width="1.8" stroke-linecap="round"></path></svg>');
  const iQuote = iconPair('💬', '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 7H5v6h4l-2 4" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path><path d="M19 7h-4v6h4l-2 4" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path></svg>');
  const iThread = iconPair('🧵', '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 9h8" stroke-width="1.8" stroke-linecap="round"></path><path d="M8 13h6" stroke-width="1.8" stroke-linecap="round"></path><path d="M6 6h12a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-8l-4 3v-3H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z" stroke-width="1.8" stroke-linejoin="round"></path></svg>');
  const iPin = iconPair('📌', '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 4h8l-2 5v4l2 2H8l2-2V9L8 4z" stroke-width="1.8" stroke-linejoin="round"></path><path d="M12 15v5" stroke-width="1.8" stroke-linecap="round"></path></svg>');
  const iArchive = iconPair('🛡️', '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16v11H4z" stroke-width="1.8" stroke-linejoin="round"></path><path d="M9 11h6" stroke-width="1.8" stroke-linecap="round"></path><path d="M3 7l2-3h14l2 3" stroke-width="1.8" stroke-linejoin="round"></path></svg>');
  const iEdit = iconPair('✏️', '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20l4.5-1 9-9-3.5-3.5-9 9L4 20z" stroke-width="1.8" stroke-linejoin="round"></path><path d="M13.5 6.5l3.5 3.5" stroke-width="1.8" stroke-linecap="round"></path></svg>');
  const iDelete = iconPair('🗑️', '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14" stroke-width="1.8" stroke-linecap="round"></path><path d="M9 7V5h6v2" stroke-width="1.8" stroke-linecap="round"></path><path d="M7 7l1 12h8l1-12" stroke-width="1.8" stroke-linejoin="round"></path></svg>');
  const iMore = iconPair('⋯', '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="12" r="1.6" fill="currentColor" stroke="none"></circle><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"></circle><circle cx="18" cy="12" r="1.6" fill="currentColor" stroke="none"></circle></svg>');

  const toolbarActions = [
    { key: 'react', html: `<button data-action="react" title="${t('msg_toolbar.react')}">${iReact}</button>` },
    { key: 'reply', html: `<button data-action="reply" title="${t('msg_toolbar.reply')}">${iReply}</button>` },
    { key: 'quote', html: `<button data-action="quote" title="${t('msg_toolbar.quote')}">${iQuote}</button>` },
    { key: 'thread', html: `<button data-action="thread" title="Thread">${iThread}</button>` }
  ];
  const canPin = this.user.isAdmin || this._canModerate();
  const canArchive = this.user.isAdmin || this._hasPerm('archive_messages');
  const canDelete = msg.user_id === this.user.id || this.user.isAdmin || this._canModerate();
  if (canPin) {
    toolbarActions.push({
      key: 'pin',
      html: msg.pinned
        ? `<button data-action="unpin" title="${t('msg_toolbar.unpin')}">${iPin}</button>`
        : `<button data-action="pin" title="${t('msg_toolbar.pin')}">${iPin}</button>`
    });
  }
  if (canArchive) {
    toolbarActions.push({
      key: 'archive',
      html: msg.is_archived
        ? `<button data-action="unarchive" title="${t('app.messages.unprotect_btn')}">${iArchive}</button>`
        : `<button data-action="archive" title="${t('app.messages.protect_btn')}">${iArchive}</button>`
    });
  }
  if (msg.user_id === this.user.id) {
    toolbarActions.push({ key: 'edit', html: `<button data-action="edit" title="${t('msg_toolbar.edit')}">${iEdit}</button>` });
  }
  if (canDelete) {
    toolbarActions.push({ key: 'delete', html: `<button data-action="delete" title="${t('msg_toolbar.delete')}">${iDelete}</button>` });
  }

  const defaultToolbarOrder = ['react', 'reply', 'quote', 'thread', 'pin', 'archive', 'edit', 'delete'];
  let savedToolbarOrder = [];
  try {
    savedToolbarOrder = JSON.parse(localStorage.getItem('haven-toolbar-order') || '[]');
  } catch {
    savedToolbarOrder = [];
  }
  const normalizedOrder = [];
  savedToolbarOrder.forEach((key) => {
    if (defaultToolbarOrder.includes(key) && !normalizedOrder.includes(key)) normalizedOrder.push(key);
  });
  defaultToolbarOrder.forEach((key) => {
    if (!normalizedOrder.includes(key)) normalizedOrder.push(key);
  });

  const orderRank = new Map(normalizedOrder.map((key, index) => [key, index]));
  toolbarActions.sort((a, b) => (orderRank.get(a.key) ?? 999) - (orderRank.get(b.key) ?? 999));

  let visibleSlots = parseInt(localStorage.getItem('haven-toolbar-visible-slots') || '3', 10);
  if (!Number.isFinite(visibleSlots)) visibleSlots = 3;
  visibleSlots = Math.max(1, Math.min(7, visibleSlots));

  const visibleActions = toolbarActions.slice(0, visibleSlots);
  const overflowActions = toolbarActions.slice(visibleSlots);
  const coreToolbarBtns = visibleActions.map(a => a.html).join('');
  const overflowToolbarBtns = overflowActions.map(a => a.html).join('');
  const moreMenuHtml = overflowActions.length
    ? `<div class="msg-toolbar-more"><button class="msg-toolbar-more-btn" type="button" aria-label="More actions">${iMore}</button><div class="msg-toolbar-overflow">${overflowToolbarBtns}</div></div>`
    : '';
  const toolbarHtml = `<div class="msg-toolbar"><div class="msg-toolbar-group">${coreToolbarBtns}</div>${moreMenuHtml}</div>`;
  const replyHtml = msg.replyContext ? this._renderReplyBanner(msg.replyContext) : '';

  if (isCompact) {
    const el = document.createElement('div');
    el.className = 'message-compact' + (msg.pinned ? ' pinned' : '') + (msg.is_archived ? ' archived' : '') + (isAnnouncement ? ' announcement' : '');
    el.dataset.userId = msg.user_id;
    el.dataset.username = msg.username;
    el.dataset.time = msg.created_at;
    el.dataset.timeShort = new Date(msg.created_at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
    el.dataset.msgId = msg.id;
    el.dataset.rawContent = msg.content;
    if (msg.pinned) el.dataset.pinned = '1';
    if (msg.is_archived) el.dataset.archived = '1';
    if (msg._e2e) el.dataset.e2e = '1';
    if (msg.poll && msg.poll.anonymous) el.dataset.pollAnonymous = '1';
    el.innerHTML = `
      <span class="compact-time">${new Date(msg.created_at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</span>
      <div class="message-body">
        <div class="message-content">${pinnedTag}${archivedTag}${this._formatContent(msg.content)}${editedHtml}</div>
        ${pollHtml}
        ${reactionsHtml}
        ${threadHtml}
      </div>
      ${e2eTag}
      ${toolbarHtml}
      <button class="msg-dots-btn" aria-label="${t('app.actions.message_actions')}">⋯</button>
    `;
    return el;
  }

  const color = this._getUserColor(msg.username);
  const initial = msg.username.charAt(0).toUpperCase();
  // Look up user's role from online users list
  const onlineUser = this.users ? this.users.find(u => u.id === msg.user_id) : null;
  // Use the message sender's avatar_shape (from server), not the local user's preference
  const msgShape = msg.avatar_shape || (onlineUser && onlineUser.avatarShape) || 'circle';
  const shapeClass = 'avatar-' + msgShape;

  // For imported Discord messages, use the stored Discord avatar or a generic Discord icon
  let avatarHtml;
  if (msg.imported_from === 'discord') {
    const discordAvatar = msg.webhook_avatar;
    if (discordAvatar) {
      avatarHtml = `<img class="message-avatar message-avatar-img ${shapeClass}" src="${this._escapeHtml(discordAvatar)}" loading="lazy" alt="${initial}"><div class="message-avatar ${shapeClass}" style="background-color:${color};display:none">${initial}</div>`;
    } else {
      // Generic Discord-style avatar (colored circle with initial)
      avatarHtml = `<div class="message-avatar ${shapeClass} discord-import-avatar" style="background-color:#5865f2">${initial}</div>`;
    }
  } else if (msg.avatar) {
    avatarHtml = `<img class="message-avatar message-avatar-img ${shapeClass}" src="${this._escapeHtml(msg.avatar)}" loading="lazy" alt="${initial}"><div class="message-avatar ${shapeClass}" style="background-color:${color};display:none">${initial}</div>`;
  } else {
    avatarHtml = `<div class="message-avatar ${shapeClass}" style="background-color:${color}">${initial}</div>`;
  }

  const msgRoleBadge = onlineUser && onlineUser.role
    ? `<span class="user-role-badge msg-role-badge" style="color:${this._safeColor(onlineUser.role.color, 'var(--text-muted)')}">${this._escapeHtml(onlineUser.role.name)}</span>`
    : '';

  // Role icon in chat
  const showIconChat = this.serverSettings.role_icon_chat === 'true';
  const iconAfterName = this.serverSettings.role_icon_after_name === 'true';
  const msgRoleIcon = showIconChat && onlineUser && onlineUser.role && onlineUser.role.icon
    ? `<img class="role-icon" src="${this._escapeHtml(onlineUser.role.icon)}" alt="" title="${this._escapeHtml(onlineUser.role.name)}">`
    : '';
  const msgRoleIconBefore = msgRoleIcon && !iconAfterName ? msgRoleIcon : '';
  const msgRoleIconAfter = msgRoleIcon && iconAfterName ? msgRoleIcon : '';

  // Role color display mode: colored-name uses role color for the author name
  const roleDisplayMode = localStorage.getItem('haven-role-display') || 'colored-name';
  const authorColor = (roleDisplayMode === 'colored-name' && onlineUser && onlineUser.role && onlineUser.role.color)
    ? this._safeColor(onlineUser.role.color, color)
    : color;

  const botBadge = msg.imported_from === 'discord'
    ? '<span class="discord-badge">DISCORD</span>'
    : msg.is_webhook ? '<span class="bot-badge">BOT</span>' : '';

  const el = document.createElement('div');
  el.className = 'message' + (isImage ? ' message-has-image' : '') + (msg.pinned ? ' pinned' : '') + (msg.is_archived ? ' archived' : '') + (msg.is_webhook ? ' webhook-message' : '') + (msg.imported_from ? ' imported-message' : '') + (isAnnouncement ? ' announcement' : '');
  el.dataset.userId = msg.user_id;
  el.dataset.time = msg.created_at;
  el.dataset.timeShort = new Date(msg.created_at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
  el.dataset.msgId = msg.id;
  el.dataset.rawContent = msg.content;
  if (msg.pinned) el.dataset.pinned = '1';
  if (msg.is_archived) el.dataset.archived = '1';
  if (msg._e2e) el.dataset.e2e = '1';
  if (msg.poll && msg.poll.anonymous) el.dataset.pollAnonymous = '1';
  el.innerHTML = `
    <div class="message-row">
      ${avatarHtml}
      <div class="message-body">
        ${replyHtml}
        <div class="message-header">
          ${msgRoleIconBefore}
          <span class="message-author" style="color:${authorColor}"${this._nicknames[msg.user_id] ? ` title="${this._escapeHtml(msg.username)}"` : ''}>${this._escapeHtml(this._getNickname(msg.user_id, msg.username))}</span>
          ${msgRoleIconAfter}
          ${botBadge}
          ${msgRoleBadge}
          <span class="message-time">${this._formatTime(msg.created_at)}</span>
          ${pinnedTag}
          ${archivedTag}
          <span class="message-header-spacer"></span>
          ${e2eTag}
        </div>
        <div class="message-content">${this._formatContent(msg.content)}${editedHtml}</div>
        ${pollHtml}
        ${reactionsHtml}
        ${threadHtml}
      </div>
      ${toolbarHtml}
      <button class="msg-dots-btn" aria-label="${t('app.actions.message_actions')}">⋯</button>
    </div>
  `;
  return el;
},

/**
 * Promote a compact (grouped) message to a full message with avatar + header.
 * Called when the root message of a group is deleted.
 */
_promoteCompactToFull(compactEl) {
  const userId = parseInt(compactEl.dataset.userId);
  const username = compactEl.dataset.username || t('app.messages.unknown_user');
  const time = compactEl.dataset.time;
  const msgId = compactEl.dataset.msgId;
  const isPinned = compactEl.dataset.pinned === '1';

  // Grab existing inner content & toolbar before replacing
  const contentEl = compactEl.querySelector('.message-content');
  const contentHtml = contentEl ? contentEl.innerHTML : '';
  const toolbarEl = compactEl.querySelector('.msg-toolbar');
  const toolbarHtml = toolbarEl ? toolbarEl.outerHTML : '';
  const reactionsEl = compactEl.querySelector('.reactions-row');
  const reactionsHtml = reactionsEl ? reactionsEl.outerHTML : '';
  const pinnedTag = isPinned ? `<span class="pinned-tag" title="${t('app.messages.pinned')}">📌</span>` : '';
  const e2eTag = compactEl.dataset.e2e === '1' ? `<span class="e2e-tag" title="${t('app.messages.e2e_encrypted')}">🔒</span>` : '';

  const color = this._getUserColor(username);
  const initial = username.charAt(0).toUpperCase();
  const onlineUser = this.users ? this.users.find(u => u.id === userId) : null;
  const msgShape = (onlineUser && onlineUser.avatarShape) || 'circle';
  const shapeClass = 'avatar-' + msgShape;
  const avatar = onlineUser && onlineUser.avatar;
  const avatarHtml = avatar
    ? `<img class="message-avatar message-avatar-img ${shapeClass}" src="${this._escapeHtml(avatar)}" loading="lazy" alt="${initial}"><div class="message-avatar ${shapeClass}" style="background-color:${color};display:none">${initial}</div>`
    : `<div class="message-avatar ${shapeClass}" style="background-color:${color}">${initial}</div>`;

  const msgRoleBadge = onlineUser && onlineUser.role
    ? `<span class="user-role-badge msg-role-badge" style="color:${this._safeColor(onlineUser.role.color, 'var(--text-muted)')}">${this._escapeHtml(onlineUser.role.name)}</span>`
    : '';

  // Role icon in chat (compact-to-full)
  const showIconChat2 = this.serverSettings.role_icon_chat === 'true';
  const iconAfterName2 = this.serverSettings.role_icon_after_name === 'true';
  const msgRoleIcon2 = showIconChat2 && onlineUser && onlineUser.role && onlineUser.role.icon
    ? `<img class="role-icon" src="${this._escapeHtml(onlineUser.role.icon)}" alt="" title="${this._escapeHtml(onlineUser.role.name)}">`
    : '';
  const msgRoleIconBefore2 = msgRoleIcon2 && !iconAfterName2 ? msgRoleIcon2 : '';
  const msgRoleIconAfter2 = msgRoleIcon2 && iconAfterName2 ? msgRoleIcon2 : '';

  // Replace the compact element in-place
  const wasAnnouncement = compactEl.classList.contains('announcement');
  compactEl.className = 'message' + (isPinned ? ' pinned' : '') + (wasAnnouncement ? ' announcement' : '');
  compactEl.dataset.userId = userId;
  compactEl.dataset.time = time;
  compactEl.dataset.msgId = msgId;
  if (isPinned) compactEl.dataset.pinned = '1';
  compactEl.innerHTML = `
    <div class="message-row">
      ${avatarHtml}
      <div class="message-body">
        <div class="message-header">
          ${msgRoleIconBefore2}
          <span class="message-author" style="color:${color}"${this._nicknames[userId] ? ` title="${this._escapeHtml(username)}"` : ''}>${this._escapeHtml(this._getNickname(userId, username))}</span>
          ${msgRoleIconAfter2}
          ${msgRoleBadge}
          <span class="message-time">${this._formatTime(time)}</span>
          ${pinnedTag}
          <span class="message-header-spacer"></span>
          ${e2eTag}
        </div>
        <div class="message-content">${contentHtml}</div>
        ${reactionsHtml}
      </div>
      ${toolbarHtml}
      <button class="msg-dots-btn" aria-label="${t('app.actions.message_actions')}">⋯</button>
    </div>
  `;
},

_appendSystemMessage(text) {
  const container = document.getElementById('messages');
  const wasAtBottom = this._coupledToBottom;
  const el = document.createElement('div');
  el.className = 'system-message';
  el.textContent = text;
  container.appendChild(el);
  if (wasAtBottom) this._scrollToBottom(true);
},

_appendWelcomeMessage(text) {
  const container = document.getElementById('messages');
  const wasAtBottom = this._coupledToBottom;
  const el = document.createElement('div');
  el.className = 'welcome-message';
  el.textContent = text;
  container.appendChild(el);
  if (wasAtBottom) this._scrollToBottom(true);
},

// ── Pinned Messages Panel ─────────────────────────────

_renderPinnedPanel(pins) {
  const panel = document.getElementById('pinned-panel');
  const list = document.getElementById('pinned-list');
  const count = document.getElementById('pinned-count');

  count.textContent = `📌 ${t(pins.length !== 1 ? 'pinned_panel.count_other' : 'pinned_panel.count_one', { count: pins.length })}`;

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
        <div class="pinned-item-footer">${t('pinned_panel.pinned_by', { user: this._escapeHtml(p.pinned_by) })}</div>
      </div>
    `).join('');
  }
  panel.style.display = 'block';

  // Click to scroll to pinned message (uses _jumpToMessage to handle
  // messages that have been trimmed from the DOM)
  list.querySelectorAll('.pinned-item').forEach(item => {
    item.addEventListener('click', () => {
      const msgId = parseInt(item.dataset.msgId, 10);
      panel.style.display = 'none';
      if (msgId) this._jumpToMessage(msgId);
    });
  });
},

// ── Link Previews ─────────────────────────────────────

/** Wire up fullscreen button and PiP seek support for uploaded video elements */
_setupVideos(containerEl) {
  containerEl.querySelectorAll('.file-video').forEach(video => {
    if (video.dataset.havenSetup) return;
    video.dataset.havenSetup = '1';

    // ── Generate thumbnail poster from first frame ──
    this._generateVideoThumbnail(video);

    // PiP: wire up MediaSession so the PiP window shows a seek bar
    const updatePos = () => {
      try {
        if (!isNaN(video.duration) && video.duration > 0) {
          navigator.mediaSession.metadata = navigator.mediaSession.metadata
            || new MediaMetadata({ title: 'Haven Video' });
          navigator.mediaSession.setPositionState({
            duration: video.duration,
            position: Math.min(video.currentTime, video.duration),
            playbackRate: video.playbackRate || 1,
          });
        }
      } catch {}
    };
    video.addEventListener('enterpictureinpicture', () => {
      try {
        navigator.mediaSession.playbackState = 'playing';
        navigator.mediaSession.metadata = new MediaMetadata({ title: 'Haven Video' });
        navigator.mediaSession.setActionHandler('seekto', (d) => {
          if (d.seekTime !== undefined) { video.currentTime = d.seekTime; updatePos(); }
        });
        navigator.mediaSession.setActionHandler('seekbackward', (d) => {
          video.currentTime = Math.max(0, video.currentTime - (d.seekOffset || 10)); updatePos();
        });
        navigator.mediaSession.setActionHandler('seekforward', (d) => {
          video.currentTime = Math.min(video.duration, video.currentTime + (d.seekOffset || 10)); updatePos();
        });
        navigator.mediaSession.setActionHandler('play', () => { video.play(); });
        navigator.mediaSession.setActionHandler('pause', () => { video.pause(); });
        video.addEventListener('timeupdate', updatePos);
        video.addEventListener('playing', updatePos);
        updatePos();
      } catch {}
    });
    video.addEventListener('leavepictureinpicture', () => {
      try {
        navigator.mediaSession.setActionHandler('seekto', null);
        navigator.mediaSession.setActionHandler('seekbackward', null);
        navigator.mediaSession.setActionHandler('seekforward', null);
        navigator.mediaSession.setActionHandler('play', null);
        navigator.mediaSession.setActionHandler('pause', null);
        navigator.mediaSession.metadata = null;
      } catch {}
      video.removeEventListener('timeupdate', updatePos);
      video.removeEventListener('playing', updatePos);
    });
  });
},

/** Generate a poster thumbnail for a video element by capturing its first visible frame */
_generateVideoThumbnail(video) {
  const src = video.src || video.querySelector('source')?.src;
  if (!src) return;

  // If we already generated a thumbnail for this URL, reuse it
  if (_thumbCache.has(src)) {
    video.poster = _thumbCache.get(src);
    return;
  }

  // Use a hidden helper video so the main element stays preload="none"
  const helper = document.createElement('video');
  helper.crossOrigin = 'anonymous';
  helper.muted = true;
  helper.preload = 'metadata';
  helper.src = src;

  const cleanup = () => {
    helper.removeAttribute('src');
    helper.load();
  };

  helper.addEventListener('loadedmetadata', () => {
    // Seek to 0.5s or 10% of duration (whichever is smaller) to skip black intro frames
    const seekTo = Math.min(0.5, helper.duration * 0.1 || 0.1);
    helper.currentTime = seekTo;
  }, { once: true });

  helper.addEventListener('seeked', () => {
    try {
      const w = helper.videoWidth;
      const h = helper.videoHeight;
      if (!w || !h) { cleanup(); return; }

      // Cap thumbnail at 480p to save memory
      const MAX = 480;
      let tw = w, th = h;
      if (h > MAX) { tw = Math.round(w * (MAX / h)); th = MAX; }

      const canvas = document.createElement('canvas');
      canvas.width = tw;
      canvas.height = th;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(helper, 0, 0, tw, th);

      canvas.toBlob(blob => {
        if (blob) {
          const url = URL.createObjectURL(blob);
          _thumbCache.set(src, url);
          video.poster = url;
        }
        cleanup();
      }, 'image/jpeg', 0.7);
    } catch {
      cleanup();
    }
  }, { once: true });

  helper.addEventListener('error', cleanup, { once: true });

  // Safety timeout — don't hang forever if the video can't be loaded
  setTimeout(() => { if (!_thumbCache.has(src)) cleanup(); }, 8000);
},

// ── Link Previews ─────────────────────────────────────

_fetchLinkPreviews(containerEl) {
  const links = containerEl.querySelectorAll('.message-content a[href]');
  const seen = new Set();
  links.forEach(link => {
    const url = link.href;
    if (seen.has(url)) return;
    seen.add(url);
    // Skip image URLs (already rendered inline) and internal URLs
    if (/\.(jpg|jpeg|png|gif|webp)(\?.*)?$/i.test(url)) return;
    if (/^https:\/\/media\d*\.giphy\.com\//i.test(url)) return;
    if (url.startsWith(window.location.origin)) return;

    // ── Inline YouTube embed ────────────────────────────
    const ytVideoId = this._extractYouTubeVideoId(url);
    if (ytVideoId) {
      const msgContent = link.closest('.message-content');
      if (!msgContent) return;
      if (msgContent.querySelector(`.link-preview-yt[data-url="${CSS.escape(url)}"]`)) return;
      const wrapper = document.createElement('div');
      wrapper.className = 'link-preview-yt';
      wrapper.dataset.url = url;
      wrapper.innerHTML = `<iframe src="https://www.youtube.com/embed/${this._escapeHtml(ytVideoId)}?rel=0" width="100%" height="270" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen loading="lazy"></iframe>`;
      msgContent.appendChild(wrapper);
      if (this._coupledToBottom) this._scrollToBottom(true);
      return; // skip generic link preview for YouTube
    }

    fetch(`/api/link-preview?url=${encodeURIComponent(url)}`, {
      headers: { 'Authorization': `Bearer ${this.token}` }
    })
      .then(r => r.json())
      .then(data => {
        if (!data.title && !data.description) return;
        const msgContent = link.closest('.message-content');
        if (!msgContent) return;

        // Don't add duplicate previews
        if (msgContent.querySelector(`.link-preview[data-url="${CSS.escape(url)}"]`)) return;

        // ── Inline video embed (og:video MP4/WebM) ──
        if (data.video && (data.videoType || /\.(mp4|webm|ogg)(\?[^#]*)?$/i.test(data.video))) {
          const videoCard = document.createElement('div');
          videoCard.className = 'link-preview link-preview--video';
          videoCard.dataset.url = url;
          let vInner = '<video controls preload="metadata" playsinline style="max-width:100%;max-height:400px;border-radius:8px;display:block"';
          if (data.image) vInner += ` poster="${this._escapeHtml(data.image)}"`;
          vInner += `><source src="${this._escapeHtml(data.video)}" type="${this._escapeHtml(data.videoType || 'video/mp4')}"></video>`;
          vInner += '<div class="link-preview-text">';
          if (data.siteName) vInner += `<span class="link-preview-site">${this._escapeHtml(data.siteName)}</span>`;
          if (data.title) vInner += `<a class="link-preview-title" href="${this._escapeHtml(url)}" target="_blank" rel="noopener noreferrer nofollow">${this._escapeHtml(data.title)}</a>`;
          vInner += '</div>';
          videoCard.innerHTML = vInner;
          const wasAtBottom = this._coupledToBottom;
          msgContent.appendChild(videoCard);
          if (wasAtBottom) this._scrollToBottom(true);
          return;
        }

        const card = document.createElement('a');
        const hasGallery = Array.isArray(data.images) && data.images.length >= 2;
        card.className = hasGallery ? 'link-preview link-preview--gallery' : 'link-preview';
        card.href = url;
        card.target = '_blank';
        card.rel = 'noopener noreferrer nofollow';
        card.dataset.url = url;

        let inner = '';
        if (hasGallery) {
          const count = Math.min(data.images.length, 4);
          inner += `<div class="link-preview-gallery" data-count="${count}">`;
          data.images.slice(0, 4).forEach(imgUrl => {
            inner += `<img class="link-preview-gallery-img" src="${this._escapeHtml(imgUrl)}" alt="">`;
          });
          inner += '</div>';
        } else if (data.image) {
          inner += `<img class="link-preview-image" src="${this._escapeHtml(data.image)}" alt="">`;
        }
        inner += '<div class="link-preview-text">';
        if (data.siteName) inner += `<span class="link-preview-site">${this._escapeHtml(data.siteName)}</span>`;
        if (data.title) inner += `<span class="link-preview-title">${this._escapeHtml(data.title)}</span>`;
        if (data.description) inner += `<span class="link-preview-desc">${this._escapeHtml(data.description).slice(0, 200)}</span>`;
        inner += '</div>';
        card.innerHTML = inner;

        const wasAtBottom = this._coupledToBottom;
        msgContent.appendChild(card);

        // Scroll if coupled to bottom — uses the tracked flag rather than
        // a point-in-time scrollHeight check that content-visibility can skew.
        if (wasAtBottom) this._scrollToBottom(true);
      })
      .catch(() => {});
  });
},

/**
 * Extract YouTube video ID from various URL formats:
 *   youtube.com/watch?v=ID, youtu.be/ID, youtube.com/embed/ID,
 *   youtube.com/shorts/ID, music.youtube.com/watch?v=ID
 */
_extractYouTubeVideoId(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace('www.', '').replace('m.', '');
    // youtu.be/VIDEO_ID
    if (host === 'youtu.be') {
      const id = u.pathname.slice(1).split('/')[0];
      return id && /^[\w-]{11}$/.test(id) ? id : null;
    }
    // youtube.com or music.youtube.com
    if (host === 'youtube.com' || host === 'music.youtube.com') {
      // /watch?v=ID
      const v = u.searchParams.get('v');
      if (v && /^[\w-]{11}$/.test(v)) return v;
      // /embed/ID or /shorts/ID
      const pathMatch = u.pathname.match(/^\/(?:embed|shorts)\/([\w-]{11})/);
      if (pathMatch) return pathMatch[1];
    }
  } catch {}
  return null;
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
      this._showToast('Maximum 200 messages can be moved at once', 'error');
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
  const n = this._moveSelectedIds.size;
  if (countEl) countEl.textContent = t('modals.move_messages.selected', { n });
  if (moveBtn) moveBtn.disabled = n === 0;
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
    list.innerHTML = '<div class="move-msg-empty">No other channels available</div>';
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
      this._showToast(`Moved ${resp.moved} message${resp.moved === 1 ? '' : 's'} to #${toName}`, 'success');
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

};
