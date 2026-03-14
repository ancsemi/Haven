export default {

// ── Messages ──────────────────────────────────────────

async _sendMessage() {
  const input = document.getElementById('message-input');
  const content = input.value.trim();
  const hasImages = this._imageQueue && this._imageQueue.length > 0;
  if (!content && !hasImages) return;
  if (!this.currentChannel) return;

  // Client-side slash commands (not sent to server)
  if (content.startsWith('/')) {
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
        if (!arg) { this._showToast('Usage: /play <song name> or /play <url>', 'error'); }
        else if (!this.voice || !this.voice.inVoice) { this._showToast('Join voice first to share music', 'error'); }
        else if (this._getMusicEmbed(arg)) {
          // Direct URL — share immediately
          this.socket.emit('music-share', { code: this.voice.currentChannel, url: arg });
        } else {
          // Not a URL — treat as a search query
          this._musicSearchQuery = arg;
          this._musicSearchOffset = 0;
          this.socket.emit('music-search', { query: arg, offset: 0 });
          this._showToast('Searching…', 'info');
        }
        input.value = '';
        input.style.height = 'auto';
        this._hideMentionDropdown();
        this._hideSlashDropdown();
        return;
      }
      if (cmd === 'gif') {
        if (!arg) { this._showToast('Usage: /gif <search query>', 'error'); }
        else { this._showGifSlashResults(arg); }
        input.value = '';
        input.style.height = 'auto';
        this._hideMentionDropdown();
        this._hideSlashDropdown();
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

    // If DM but partner key not yet cached, request it via promise
    if (isDm && !partner && this.e2e && this.e2e.ready) {
      const jwk = await this.e2e.requestPartnerKey(this.socket, ch.dm_target.id);
      if (jwk) {
        this._dmPublicKeys[ch.dm_target.id] = jwk;
        partner = this._getE2EPartner();
      }
      if (!partner) {
        this._showToast('Encryption key unavailable — message sent without E2E', 'warning');
      }
    }

    if (partner) {
      try {
        const encrypted = await this.e2e.encrypt(content, partner.userId, partner.publicKeyJwk);
        payload.content = encrypted;
        payload.encrypted = true;
      } catch (err) {
        console.warn('[E2E] Encryption failed:', err);
        this._showToast('Encryption failed — message sent without E2E', 'warning');
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

_renderMessages(messages) {
  const container = document.getElementById('messages');
  container.innerHTML = '';
  // Only render the last MAX_DOM_MESSAGES to prevent OOM on large histories
  const MAX_DOM_MESSAGES = 100;
  const start = messages.length > MAX_DOM_MESSAGES ? messages.length - MAX_DOM_MESSAGES : 0;
  // Use DocumentFragment to batch all DOM inserts into a single reflow
  const frag = document.createDocumentFragment();
  for (let i = start; i < messages.length; i++) {
    const prevMsg = i > start ? messages[i - 1] : null;
    frag.appendChild(this._createMessageEl(messages[i], prevMsg));
  }
  container.appendChild(frag);
  this._scrollToBottom(true);
  // Re-scroll after images load, but only if user hasn't scrolled away
  container.querySelectorAll('img').forEach(img => {
    if (!img.complete) img.addEventListener('load', () => {
      if (this._coupledToBottom) this._scrollToBottom(true);
    }, { once: true });
  });
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
  const editedHtml = msg.edited_at ? `<span class="edited-tag" title="Edited at ${new Date(msg.edited_at).toLocaleString()}">(edited)</span>` : '';
  const pinnedTag = msg.pinned ? '<span class="pinned-tag" title="Pinned message">📌</span>' : '';
  const archivedTag = msg.is_archived ? '<span class="archived-tag" title="Protected from cleanup">🛡️</span>' : '';
  const e2eTag = msg._e2e ? '<span class="e2e-tag" title="End-to-end encrypted">🔒</span>' : '';

  // Build toolbar with context-aware buttons
  let toolbarBtns = `<button data-action="react" title="React">😀</button><button data-action="reply" title="Reply">↩️</button>`;
  const canPin = this.user.isAdmin || this._canModerate();
  const canArchive = this.user.isAdmin || this._hasPerm('archive_messages');
  const canDelete = msg.user_id === this.user.id || this.user.isAdmin || this._canModerate();
  if (canPin) {
    toolbarBtns += msg.pinned
      ? `<button data-action="unpin" title="Unpin">📌</button>`
      : `<button data-action="pin" title="Pin">📌</button>`;
  }
  if (canArchive) {
    toolbarBtns += msg.is_archived
      ? `<button data-action="unarchive" title="Unprotect">🛡️</button>`
      : `<button data-action="archive" title="Protect from cleanup">🛡️</button>`;
  }
  if (msg.user_id === this.user.id) {
    toolbarBtns += `<button data-action="edit" title="Edit">✏️</button>`;
  }
  if (canDelete) {
    toolbarBtns += `<button data-action="delete" title="Delete">🗑️</button>`;
  }
  const toolbarHtml = `<div class="msg-toolbar">${toolbarBtns}</div>`;
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
      </div>
      ${e2eTag}
      ${toolbarHtml}
      <button class="msg-dots-btn" aria-label="Message actions">⋯</button>
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
    ${replyHtml}
    <div class="message-row">
      ${avatarHtml}
      <div class="message-body">
        <div class="message-header">
          <span class="message-author" style="color:${color}"${this._nicknames[msg.user_id] ? ` title="${this._escapeHtml(msg.username)}"` : ''}>${this._escapeHtml(this._getNickname(msg.user_id, msg.username))}</span>
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
      </div>
      ${toolbarHtml}
      <button class="msg-dots-btn" aria-label="Message actions">⋯</button>
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
  const username = compactEl.dataset.username || 'Unknown';
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
  const pinnedTag = isPinned ? '<span class="pinned-tag" title="Pinned message">📌</span>' : '';
  const e2eTag = compactEl.dataset.e2e === '1' ? '<span class="e2e-tag" title="End-to-end encrypted">🔒</span>' : '';

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
          <span class="message-author" style="color:${color}"${this._nicknames[userId] ? ` title="${this._escapeHtml(username)}"` : ''}>${this._escapeHtml(this._getNickname(userId, username))}</span>
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
      <button class="msg-dots-btn" aria-label="Message actions">⋯</button>
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

// ── Pinned Messages Panel ─────────────────────────────

_renderPinnedPanel(pins) {
  const panel = document.getElementById('pinned-panel');
  const list = document.getElementById('pinned-list');
  const count = document.getElementById('pinned-count');

  count.textContent = `📌 ${pins.length} pinned message${pins.length !== 1 ? 's' : ''}`;

  if (pins.length === 0) {
    list.innerHTML = '<p class="muted-text" style="padding:12px">No pinned messages</p>';
  } else {
    list.innerHTML = pins.map(p => `
      <div class="pinned-item" data-msg-id="${p.id}">
        <div class="pinned-item-header">
          <span class="pinned-item-author" style="color:${this._getUserColor(p.username)}">${this._escapeHtml(this._getNickname(p.user_id, p.username))}</span>
          <span class="pinned-item-time">${this._formatTime(p.created_at)}</span>
        </div>
        <div class="pinned-item-content">${this._formatContent(p.content)}</div>
        <div class="pinned-item-footer">Pinned by ${this._escapeHtml(p.pinned_by)}</div>
      </div>
    `).join('');
  }
  panel.style.display = 'block';

  // Click to scroll to pinned message
  list.querySelectorAll('.pinned-item').forEach(item => {
    item.addEventListener('click', () => {
      const msgId = item.dataset.msgId;
      const msgEl = document.querySelector(`[data-msg-id="${msgId}"]`);
      if (msgEl) {
        msgEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        msgEl.classList.add('highlight-flash');
        setTimeout(() => msgEl.classList.remove('highlight-flash'), 2000);
      }
      panel.style.display = 'none';
    });
  });
},

// ── Link Previews ─────────────────────────────────────

/** Wire up fullscreen button and PiP seek support for uploaded video elements */
_setupVideos(containerEl) {
  containerEl.querySelectorAll('.file-video').forEach(video => {
    if (video.dataset.havenSetup) return;
    video.dataset.havenSetup = '1';

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

};
