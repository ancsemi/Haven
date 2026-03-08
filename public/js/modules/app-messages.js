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
  const MAX_DOM_MESSAGES = 200;
  const start = messages.length > MAX_DOM_MESSAGES ? messages.length - MAX_DOM_MESSAGES : 0;
  for (let i = start; i < messages.length; i++) {
    const prevMsg = i > start ? messages[i - 1] : null;
    container.appendChild(this._createMessageEl(messages[i], prevMsg));
  }
  this._scrollToBottom(true);
  // Re-scroll after images load — force-scroll since user should be at
  // bottom on initial channel load
  container.querySelectorAll('img').forEach(img => {
    if (!img.complete) img.addEventListener('load', () => this._scrollToBottom(true), { once: true });
  });
  // Fetch link previews for all messages
  this._fetchLinkPreviews(container);
  // Mark as read (last message ID)
  if (messages.length > 0) {
    this._markRead(messages[messages.length - 1].id);
  }
},

/** Prepend older messages to the top of the messages container, preserving scroll position */
_prependMessages(messages) {
  const container = document.getElementById('messages');
  const prevScrollHeight = container.scrollHeight;
  const prevScrollTop = container.scrollTop;
  const firstChild = container.firstChild;

  // We need prevMsg chain: older messages are oldest-first, then link to existing first message
  const fragment = document.createDocumentFragment();
  messages.forEach((msg, i) => {
    const prevMsg = i > 0 ? messages[i - 1] : null;
    fragment.appendChild(this._createMessageEl(msg, prevMsg));
  });

  // Re-evaluate grouping of the previously-first message against the new last prepended message
  if (firstChild && firstChild.dataset && messages.length > 0) {
    const lastPrepended = messages[messages.length - 1];
    const firstExisting = firstChild;
    // Check if they should be grouped (same user, close timestamps)
    if (firstExisting.dataset.userId && parseInt(firstExisting.dataset.userId) === lastPrepended.user_id) {
      const timeDiff = new Date(firstExisting.dataset.time) - new Date(lastPrepended.created_at);
      if (timeDiff < 5 * 60 * 1000) {
        // Already compact — that's fine, keep it
      }
    }
  }

  container.insertBefore(fragment, firstChild);

  // Restore scroll position so the view doesn't jump
  const newScrollHeight = container.scrollHeight;
  container.scrollTop = prevScrollTop + (newScrollHeight - prevScrollHeight);

  // ── DOM trimming: cap total messages to prevent unbounded growth ──
  // When scrolling up loads more history, trim excess messages from the
  // bottom to keep total DOM nodes manageable.
  const MAX_DOM_MESSAGES = 200;
  const children = container.children;
  if (children.length > MAX_DOM_MESSAGES) {
    const excess = children.length - MAX_DOM_MESSAGES;
    for (let i = 0; i < excess; i++) {
      container.removeChild(container.lastElementChild);
    }
  }

  // Fetch link previews for prepended messages
  this._fetchLinkPreviews(container);
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

  const wasAtBottom = forceScroll || this._isScrolledToBottom();
  const msgEl = this._createMessageEl(message, prevMsg);
  container.appendChild(msgEl);

  // ── DOM trimming: remove oldest messages when the list grows too large ──
  // This prevents unbounded memory growth that causes OOM crashes.
  const MAX_DOM_MESSAGES = 200;
  while (container.children.length > MAX_DOM_MESSAGES) {
    container.removeChild(container.firstElementChild);
  }

  // Fetch link previews for this message
  this._fetchLinkPreviews(msgEl);
  if (wasAtBottom) {
    this._scrollToBottom(true);
  }
  // Scroll after images/gifs load — force-scroll if user was at bottom
  // when the message was appended (prevents media from pushing user up)
  const imgs = msgEl.querySelectorAll('img');
  if (imgs.length) {
    const forceOnLoad = wasAtBottom;
    imgs.forEach(img => {
      if (!img.complete) {
        img.addEventListener('load', () => {
          if (forceOnLoad) {
            this._scrollToBottom(true);
          } else {
            this._scrollToBottom();
          }
        }, { once: true });
        // Also handle error case (broken images shouldn't block scroll)
        img.addEventListener('error', () => {
          if (forceOnLoad) this._scrollToBottom(true);
        }, { once: true });
      }
    });
  }
},

_createMessageEl(msg, prevMsg) {
  const isImage = this._isImageUrl(msg.content);
  const isCompact = prevMsg &&
    prevMsg.user_id === msg.user_id &&
    !msg.reply_to &&
    (new Date(msg.created_at) - new Date(prevMsg.created_at)) < 5 * 60 * 1000;

  const reactionsHtml = this._renderReactions(msg.id, msg.reactions || []);
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
    el.className = 'message-compact' + (msg.pinned ? ' pinned' : '') + (msg.is_archived ? ' archived' : '');
    el.dataset.userId = msg.user_id;
    el.dataset.username = msg.username;
    el.dataset.time = msg.created_at;
    el.dataset.timeShort = new Date(msg.created_at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
    el.dataset.msgId = msg.id;
    el.dataset.rawContent = msg.content;
    if (msg.pinned) el.dataset.pinned = '1';
    if (msg.is_archived) el.dataset.archived = '1';
    if (msg._e2e) el.dataset.e2e = '1';
    el.innerHTML = `
      <span class="compact-time">${new Date(msg.created_at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</span>
      <div class="message-body">
        <div class="message-content">${pinnedTag}${archivedTag}${this._formatContent(msg.content)}${editedHtml}</div>
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
  el.className = 'message' + (isImage ? ' message-has-image' : '') + (msg.pinned ? ' pinned' : '') + (msg.is_archived ? ' archived' : '') + (msg.is_webhook ? ' webhook-message' : '') + (msg.imported_from ? ' imported-message' : '');
  el.dataset.userId = msg.user_id;
  el.dataset.time = msg.created_at;
  el.dataset.timeShort = new Date(msg.created_at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
  el.dataset.msgId = msg.id;
  el.dataset.rawContent = msg.content;
  if (msg.pinned) el.dataset.pinned = '1';
  if (msg.is_archived) el.dataset.archived = '1';
  if (msg._e2e) el.dataset.e2e = '1';
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
  compactEl.className = 'message' + (isPinned ? ' pinned' : '');
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
  const wasAtBottom = this._isScrolledToBottom();
  const el = document.createElement('div');
  el.className = 'system-message';
  el.textContent = text;
  container.appendChild(el);
  if (wasAtBottom) this._scrollToBottom();
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
      if (this._isScrolledToBottom()) this._scrollToBottom();
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
            inner += `<img class="link-preview-gallery-img" src="${this._escapeHtml(imgUrl)}" alt="" loading="lazy">`;
          });
          inner += '</div>';
        } else if (data.image) {
          inner += `<img class="link-preview-image" src="${this._escapeHtml(data.image)}" alt="" loading="lazy">`;
        }
        inner += '<div class="link-preview-text">';
        if (data.siteName) inner += `<span class="link-preview-site">${this._escapeHtml(data.siteName)}</span>`;
        if (data.title) inner += `<span class="link-preview-title">${this._escapeHtml(data.title)}</span>`;
        if (data.description) inner += `<span class="link-preview-desc">${this._escapeHtml(data.description).slice(0, 200)}</span>`;
        inner += '</div>';
        card.innerHTML = inner;

        msgContent.appendChild(card);

        // Scroll if at bottom
        if (this._isScrolledToBottom()) this._scrollToBottom();
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
