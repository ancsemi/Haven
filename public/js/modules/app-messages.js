// Messages: sending, drawing history and new messages (and forum feeds),
// building each message's element, and system notices.

export default {

// ── Messages ──────────────────────────────────────────

async _sendMessage() {
  const input = document.getElementById('message-input');
  // `let` (not `const`) — DM slash commands like /me, /shrug rewrite this
  // before E2E encryption further down. (#5297)
  let content = input.value.trim();
  const typed = input.value;
  // Kept for a moment so a refusal for length can put the text back (#5691).
  if (content) this._lastSendDraft = { text: input.value, code: this.currentChannel, at: Date.now() };
  const hasImages = this._imageQueue && this._imageQueue.length > 0;
  const hasFiles  = this._fileQueue  && this._fileQueue.length  > 0; // (#5425)
  if (!content && !hasImages && !hasFiles) return;
  if (!this.currentChannel) return;
  if (!this.socket.connected) {
    this._showToast(t('toasts.message_not_connected'), 'error');
    return;
  }

  // In a forum, a picture and its text sent together are one topic, the way
  // the New Post hint says, not an image topic next to a text topic. The
  // pictures upload first so the topic lands whole (#5653).
  if (hasImages && content && !content.startsWith('/') && this._isForumChannel?.(this.currentChannel)) {
    const code = this.currentChannel;
    const files = [...this._imageQueue];
    this._clearImageQueue();
    input.value = '';
    input.style.height = 'auto';
    input.focus();
    this._clearReply();
    this._hideMentionDropdown();
    this._hideSlashDropdown();
    const picker = document.getElementById('emoji-picker');
    if (picker) picker.style.display = 'none';
    this._uploadsCancelled = false;
    const lines = [];
    for (const file of files) {
      const line = await this._uploadImage(file, code, true, '', false, { returnContent: true });
      if (line) lines.push(line);
      if (this._uploadsCancelled) break;
    }
    const topicTags = [...new Set(files.flatMap(f => (f && Array.isArray(f._tags)) ? f._tags : []))];
    this.socket.emit('send-message', { code, content: [content, ...lines].join('\n'), ...(topicTags.length ? { attachmentTags: topicTags } : {}) });
    if (topicTags.length) this._recordFrequentTags?.(topicTags);
    this.notifications.play('sent');
    if (hasFiles) this._flushFileQueue?.();
    return;
  }

  // (#5335) Sticker shortcode — if the message is exactly `:stickername:`
  // (whitespace-trimmed) and that name matches an uploaded sticker, route
  // it through _sendStickerMessage so it goes out as a standalone sticker
  // image instead of a literal `:name:` text message.
  if (!hasImages && !hasFiles && /^:[a-zA-Z0-9_-]+:$/.test(content)) {
    const stickerName = content.slice(1, -1).toLowerCase();
    const stickers = Array.isArray(this.stickers) ? this.stickers : [];
    const sticker = stickers.find(s => (s.name || '').toLowerCase() === stickerName);
    if (sticker && sticker.url) {
      input.value = '';
      input.style.height = 'auto';
      this._clearReply();
      this._hideMentionDropdown();
      this._hideSlashDropdown();
      this._emojiPickerContext = 'main';
      this._sendStickerMessage(sticker.url);
      return;
    }
  }

  // Client-side slash commands (not sent to server)
  if (content.startsWith('/')) {
    // /tts:stop — cancel all speech synthesis immediately
    if (content.trim().toLowerCase() === '/tts:stop') {
      this.notifications?.stopTTS();
      this._showToast(t('toasts.tts_stopped'), 'info');
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
      if (cmd === 'time') {
        // No argument opens the picker modal; the toast is kept for input
        // that was typed but could not be parsed.
        if (!arg) {
          input.value = '';
          input.style.height = 'auto';
          this._hideMentionDropdown();
          this._hideSlashDropdown();
          this._openTimeModal();
          return;
        }
        const token = this._buildTimeToken(arg);
        if (!token) {
          this._showToast(t('commands.time_usage'), 'error');
        } else {
          // Put the token in the box instead of posting it. The usual
          // message is "let's meet at <time>", so people need to type
          // around it, and they get to see what it resolved to first.
          input.value = token;
          input.style.height = 'auto';
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.focus();
          try { input.setSelectionRange(token.length, token.length); } catch { /* not a text input */ }
        }
        this._hideMentionDropdown();
        this._hideSlashDropdown();
        return;
      }
      if (cmd === 'schedule') {
        // Send later (#5638): the text after the command is the message.
        input.value = '';
        input.style.height = 'auto';
        this._hideMentionDropdown();
        this._hideSlashDropdown();
        this._openScheduleModal?.(arg);
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
  // Discord display names are not unique, so a "=>@Name" DM has to carry the
  // resolved Discord user id rather than leaving the server to guess.
  const ferryDm = this._ferryPendingDm?.(content);
  if (ferryDm) payload.ferryDiscordUserId = ferryDm;
  if (this.replyingTo) {
    payload.replyTo = this.replyingTo.id;
  }
  // (#5280) Burn-after-read arming — DM-only; cleared in switchChannel
  // when the user moves to a non-DM channel so a stale flag can't leak.
  // The button is a *persistent* toggle: once armed, every message in
  // this DM is burn-after-read until the user clicks the button to
  // disarm it (or switches channels).
  if (this._burnArmed) {
    payload.burnSeconds = 30;
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
    let partner = null;
    // A DM that is not sent after all goes back in the box, with its reply.
    const replyId = payload.replyTo;
    const putBack = () => {
      if (this.currentChannel !== payload.code || input.value.trim()) return;
      input.value = typed;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const replyEl = replyId && document.querySelector(`#messages .message[data-msg-id="${replyId}"], #messages .message-compact[data-msg-id="${replyId}"]`);
      if (replyEl) this._setReply(replyEl, replyId);
      input.focus();
    };

    // Pre-process content-transforming slash commands client-side so they
    // survive E2E encryption (server can't parse encrypted slash commands)
    if (isDm) {
      const slashMatch = content.trim().match(/^\/([a-zA-Z]+)(?:\s+(.*))?$/);
      if (slashMatch) {
        const cmd = slashMatch[1].toLowerCase();
        const arg = (slashMatch[2] || '').trim();
        const displayName = this.user.displayName || this.user.username;
        // Mirror of server `processSlashCommand` (src/socketHandlers/index.js)
        // so DM slash commands work the same as in normal channels. (#5297)
        const clientSlash = {
          spoiler:   () => arg ? `||${arg}||` : null,
          shrug:     () => `${arg ? arg + ' ' : ''}¯\\_(ツ)_/¯`,
          tableflip: () => `${arg ? arg + ' ' : ''}(╯°□°)╯︵ ┻━┻`,
          unflip:    () => `${arg ? arg + ' ' : ''}┬─┬ ノ( ゜-゜ノ)`,
          lenny:     () => `${arg ? arg + ' ' : ''}( ͡° ͜ʖ ͡°)`,
          disapprove:() => `${arg ? arg + ' ' : ''}ಠ_ಠ`,
          bbs:       () => t('commands.output.bbs', { name: displayName }),
          boobs:     () => `( . Y . )`,
          butt:      () => `( . )( . )`,
          brb:       () => t('commands.output.brb', { name: displayName }),
          afk:       () => t('commands.output.afk', { name: displayName }),
          me:        () => arg ? `_${displayName} ${arg}_` : null,
          flip:      () => t('commands.output.flip', {
            name: displayName,
            side: t(Math.random() < 0.5 ? 'commands.output.heads' : 'commands.output.tails')
          }),
          roll:      () => {
            const m = (arg || '1d6').match(/^(\d{1,2})?d(\d{1,4})$/i);
            if (!m) return t('commands.output.roll_simple', { name: displayName, result: Math.floor(Math.random() * 6) + 1 });
            const count = Math.min(parseInt(m[1] || '1'), 20);
            const sides = Math.min(parseInt(m[2]), 1000);
            const rolls = Array.from({ length: count }, () => Math.floor(Math.random() * sides) + 1);
            const total = rolls.reduce((a, b) => a + b, 0);
            return t('commands.output.roll', { name: displayName, count, sides, rolls: rolls.join(', '), total });
          },
          hug:       () => arg ? t('commands.output.hug', { name: displayName, target: arg }) : null,
          wave:      () => t('commands.output.wave', { name: displayName, text: arg ? ' ' + arg : '' }),
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

    // Nothing goes out unencrypted, or to a changed key, without asking.
    if (isDm) {
      const gate = await this._dmSendGate(payload.code);
      if (!gate) { putBack(); return false; }
      partner = gate.partner;
    }

    // Warn before encrypting: once this is ciphertext the server cannot judge
    // it, and the recipient's client will render the link inert. Telling the
    // sender here saves them wondering why it arrived greyed out. This is a
    // courtesy, not a control. Anyone running a patched client skips it, which
    // is exactly why the enforcement that matters lives on the receiving side.
    // (#5483)
    if (partner) {
      const verdict = this._dmLinkBlocked?.(content);
      if (verdict) {
        let message;
        if (verdict.rule === 'link_obfuscated') {
          message = t('automod.block.obfuscated');
        } else if (verdict.rule === 'link_masked') {
          message = t('automod.block.masked', { host: verdict.host });
        } else {
          const reason = t(`automod.reason.${verdict.reasonKey || 'blocked'}`);
          message = t('automod.block.link', { host: verdict.host, reason });
        }
        this._showToast(t('toasts.dm_link_blocked', { message }), 'warning');
      }
    }

    if (partner) {
      try {
        const encrypted = await this.e2e.encrypt(content, partner.userId, partner.publicKeyJwk);
        payload.content = encrypted;
        payload.encrypted = true;
      } catch (err) {
        // It used to go out unencrypted after a warning. It stays here now.
        console.warn('[E2E] Encryption failed:', err);
        this._showToast(t('toasts.encryption_failed_not_sent'), 'error');
        putBack();
        return false;
      }
    }
    this.socket.emit('send-message', payload);
    this.notifications.play('sent');
  }

  // Upload queued images — mark as bundled when text was also sent so
  // the server knows not to apply a second slow-mode tick for them (#5342).
  // If the text message used a persona prefix (::Name ...), pass it along so
  // the bundled images are attributed to the same persona.
  if (hasImages || hasFiles) {
    let personaPrefix = '';
    if (content && content.startsWith('::') && Array.isArray(this._personas)) {
      const lower = content.toLowerCase();
      const sorted = [...this._personas].sort((a, b) => b.name.length - a.name.length);
      for (const p of sorted) {
        const base = '::' + p.name.toLowerCase();
        if (lower.startsWith(base + ' ') || lower.startsWith(base + ': ') ||
            (lower.startsWith(base + ':') && content.length > base.length + 1)) {
          personaPrefix = '::' + p.name + ' ';
          break;
        }
      }
    }
    // (#5425) These were both inside `if (hasImages)`, so a non-image file
    // queued on its own (no image) never flushed and the attachment was stuck
    // in the queue forever. Flush each queue based on its own contents.
    if (hasImages) this._flushImageQueue(!!content, personaPrefix);
    if (hasFiles) this._flushFileQueue?.();
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

// Opening a channel draws its history before the member list with everyone's
// roles has arrived, so those names came out in plain colors with no role
// badge. Once the list is in, give the names still on screen their role style.
// Only names that never got one are touched, so presence updates cost little.
_restyleMessageAuthors() {
  const container = document.getElementById('messages');
  if (!container) return;
  if (!(this._lastOnlineUsers || []).length && !(this.channelMembers || []).length) return;
  const coloredNames = (localStorage.getItem('haven-role-display') || 'colored-name') === 'colored-name';
  container.querySelectorAll('.message[data-user-id]').forEach(el => {
    if (el.dataset.personaId || el.classList.contains('webhook-message') || el.classList.contains('imported-message')) return;
    const header = el.querySelector('.message-header');
    const author = header && header.querySelector('.message-author');
    if (!author || header.querySelector('.msg-role-badge')) return;
    const u = this._memberById(el.dataset.userId);
    if (!u || !u.role) return;
    if (coloredNames && u.role.color) {
      this._applyRoleName(author, u.role, author.textContent, author.style.color);
    }
    const all = Array.isArray(u.roles) ? u.roles : [];
    const title = all.length > 1 ? all.map(r => r.name).join('\n') : u.role.name;
    const badge = document.createElement('span');
    badge.className = 'user-role-badge msg-role-badge';
    badge.style.color = this._safeColor(u.role.color, 'var(--text-muted)');
    badge.title = title;
    badge.innerHTML = this._roleNameHtml(u.role, u.role.name)
      + (all.length > 1 ? ` <span class="msg-role-extra-count">+${all.length - 1}</span>` : '');
    const time = header.querySelector('.message-time');
    header.insertBefore(badge, time || null);
  });
},

_renderMessages(messages, lastReadMessageId) {
  // Cache the last batch so other handlers can re-render (e.g. mention
  // formatting after channel-members arrives on first load). (#5273)
  this._lastRenderedMessages = messages;
  this._lastRenderedReadId = lastReadMessageId;
  // Track persona names seen in this channel so @PersonaName mentions
  // resolve and ping the persona's owner. (#5349)
  if (!(this._channelPersonas instanceof Map)) this._channelPersonas = new Map();
  for (const m of messages) {
    if (m && m.persona_id && m.persona_username) {
      this._channelPersonas.set(String(m.persona_username).toLowerCase(), {
        user_id: m.user_id,
        name: m.persona_username,
        avatar: m.persona_avatar || null,
      });
    }
  }
  const container = document.getElementById('messages');
  container.innerHTML = '';
  container.classList.remove('forum-view', 'forum-gallery', 'forum-feed');
  container.style.removeProperty('--forum-tile');
  delete container.dataset.forumTile;
  this._forumActive = false;
  if (this._isForumChannel && this._isForumChannel(this.currentChannel)) {
    this._renderForum(messages);
    return;
  }
  // A forum feed runs newest first: the most recently active topic sits at
  // the top, where a forum reader expects it. (#144)
  const forumFeed = this._isForumFeed();
  // An empty forum explains itself; an empty channel needs no help. (#144)
  {
    if (forumFeed && messages.length === 0) {
      const hint = document.createElement('div');
      hint.className = 'forum-empty-hint';
      hint.textContent = t('app.messages.forum_empty_hint');
      container.appendChild(hint);
    }
  }
  // Only render the last MAX_DOM_MESSAGES to prevent OOM on large histories
  const MAX_DOM_MESSAGES = 100;
  const start = messages.length > MAX_DOM_MESSAGES ? messages.length - MAX_DOM_MESSAGES : 0;
  // Use DocumentFragment to batch all DOM inserts into a single reflow
  const frag = document.createDocumentFragment();

  // Determine where to insert the "NEW MESSAGES" divider.
  // Only show it when there are actually unread messages and the last message
  // isn't already "read" (i.e. the user isn't fully caught up).
  let newMsgDividerInserted = false;
  const showDivider = !forumFeed && lastReadMessageId && messages.length > 0
    && messages[messages.length - 1].id > lastReadMessageId
    // Don't show divider if ALL messages are unread (nothing before the line)
    && messages[start]?.id <= lastReadMessageId;

  // Chat feeds render oldest first; a forum feed renders its most recently
  // active topic first.
  const order = [];
  for (let i = start; i < messages.length; i++) order.push(i);
  if (forumFeed) order.reverse();
  // Pinned topics head a forum feed whatever their activity. (#144)
  if (forumFeed) order.sort((a, b) => (messages[b].pinned ? 1 : 0) - (messages[a].pinned ? 1 : 0));
  for (const i of order) {
    const prevMsg = (!forumFeed && i > start) ? messages[i - 1] : null;

    // Insert "NEW MESSAGES" divider before the first unread message
    if (showDivider && !newMsgDividerInserted && messages[i].id > lastReadMessageId
        && messages[i].user_id !== this.user?.id) {
      const divider = document.createElement('div');
      divider.className = 'new-messages-divider';
      divider.id = 'new-messages-divider';
      divider.innerHTML = `<span>${t('messages.new_messages')}</span>`;
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
  } else if (forumFeed) {
    // The newest topic is at the top, and that is where a forum opens.
    this._coupledToBottom = false;
    container.scrollTop = 0;
    requestAnimationFrame(() => { container.scrollTop = 0; });
  } else {
    this._scrollToBottom(true);
    // Re-scroll after images load, but only if user hasn't scrolled away.
    // Use the debounced variant so multiple images loading in the same batch
    // don't each fire an individual instant scroll-snap.
    container.querySelectorAll('img').forEach(img => {
      if (!img.complete) img.addEventListener('load', () => {
        if (this._coupledToBottom) this._debouncedScrollToBottom();
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
  // Wire up decryption-on-click for E2E file attachments (#5310, #5308)
  this._decryptE2EFiles(container);
  // DMs are ciphertext server-side, so their links can only be judged
  // here, after decryption and before anyone can click. (#5483)
  if (this._isDmContainer((container))) {
    this._enforceDmLinkPolicy((container));
    this._maybeShowDmSafetyNotice?.(container);
    // A partner's changed key stays noted in their DM for the session. It is
    // added here because anything appended after a render is lost to the
    // next one, and a DM can render several times while it opens.
    const keyCh = this.channels?.find(c => c.code === this.currentChannel);
    const keyNote = keyCh?.dm_target && this._e2eKeyNotices.get(keyCh.dm_target.id);
    if (keyNote) this._appendE2ENotice(keyNote);
  }
  // Wire burn-after-read placeholders + countdowns (#5280)
  this._wireBurnMessages?.(container);
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
    this._decryptE2EFiles(el);
    // DMs are ciphertext server-side, so their links can only be judged
    // here, after decryption and before anyone can click. (#5483)
    if (this._isDmContainer((el))) this._enforceDmLinkPolicy((el));
    this._wireBurnMessages?.(el);
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
        prevMsg = {
          user_id: parseInt(lastEl.dataset.userId),
          created_at: lastEl.dataset.time,
          persona_id: lastEl.dataset.personaId ? parseInt(lastEl.dataset.personaId) : null,
          persona_username: lastEl.dataset.personaUsername || null,
          username: lastEl.dataset.username || null,
          break_chain: lastEl.dataset.breakChain ? 1 : 0,
        };
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
  this._decryptE2EFiles(container);
  // DMs are ciphertext server-side, so their links can only be judged
  // here, after decryption and before anyone can click. (#5483)
  if (this._isDmContainer((container))) this._enforceDmLinkPolicy((container));
  this._wireBurnMessages?.(container);

  // Mark as read so the server-side read position advances
  if (messages.length > 0) {
    this._markRead(messages[messages.length - 1].id);
  }

  if (wasAtBottom) this._scrollToBottom(true);

  // Unfreeze on next frame
  requestAnimationFrame(() => { this._suppressCoupleCheck = false; });
},

// Forum channels (#144): a reply is its topic's newest activity, so the topic
// moves to the newest end of the list, next to the composer, the way a fresh
// message would. Topics never compact into each other, so moving the node is
// safe. A topic that is not loaded (older than the current window) is fetched
// by reloading the channel, which lands it at the end too.
/** True while the open channel is a forum, whose feed runs newest first. */
_isForumFeed() {
  const ch = this.channels && this.channels.find(c => c.code === this.currentChannel);
  return !!(ch && ch.is_forum);
},

/** Older (less recently active) topics arrive oldest first and belong at the
 *  bottom of a forum feed, the most recent of the batch nearest the top. (#144) */
_appendOlderForum(messages) {
  const container = document.getElementById('messages');
  if (!container) return;
  this._suppressCoupleCheck = true;
  const fragment = document.createDocumentFragment();
  const added = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const el = this._createMessageEl(messages[i], null);
    fragment.appendChild(el);
    added.push(el);
  }
  container.appendChild(fragment);
  for (const el of added) {
    this._fetchLinkPreviews(el);
    this._setupVideos(el);
    this._decryptE2EImages(el);
    this._decryptE2EFiles(el);
  }
  requestAnimationFrame(() => { this._suppressCoupleCheck = false; });
},

_bumpForumTopic(parentId) {
  const ch = this.channels && this.channels.find(c => c.code === this.currentChannel);
  if (!ch || !ch.is_forum) return;
  if (this._forumActive && this._forumBump) { this._forumBump(parentId); return; }
  const container = document.getElementById('messages');
  if (!container) return;
  const el = container.querySelector(`[data-msg-id="${parentId}"]`);
  if (!el) {
    if (!this._loadingHistory && !this._historyBefore && !this._historyAfter) {
      this.socket.emit('get-messages', this._getMessagesParams ? this._getMessagesParams(this.currentChannel) : { code: this.currentChannel });
    }
    return;
  }
  const slot = this._forumFeedTopSlot(container, el);
  if (slot === el) return;
  const nearTop = container.scrollTop < 40;
  // Newest activity goes on top, under the pinned block: a reply must never
  // push a pinned topic down. (#144)
  container.insertBefore(el, slot);
  // The window's least active topic may have just moved; keep the pagination
  // cursor on whatever is last now.
  const all = container.querySelectorAll('[data-msg-id]');
  const lastEl = all[all.length - 1];
  if (lastEl) this._oldestMsgId = parseInt(lastEl.dataset.msgId);
  if (nearTop) container.scrollTop = 0;
},

// Where a topic that just became the newest activity goes in a forum feed:
// the very top when it is pinned itself, otherwise right under the pinned
// block. Returns the node to insert before (null means the end).
_forumFeedTopSlot(container, el) {
  const isPinned = (n) => !!n && (n.classList.contains('pinned') || n.dataset.pinned === '1');
  if (isPinned(el)) return container.firstElementChild;
  let node = container.firstElementChild;
  while (node && isPinned(node)) node = node.nextElementSibling;
  return node;
},

_appendMessage(message, forceScroll = false) {
  const container = document.getElementById('messages');
  if (this._forumActive && this._forumInsertTopic) { this._forumInsertTopic(message); return; }
  const lastMsg = container.lastElementChild;

  // Track persona name for @PersonaName mention resolution. (#5349)
  if (message && message.persona_id && message.persona_username) {
    if (!(this._channelPersonas instanceof Map)) this._channelPersonas = new Map();
    this._channelPersonas.set(String(message.persona_username).toLowerCase(), {
      user_id: message.user_id,
      name: message.persona_username,
      avatar: message.persona_avatar || null,
    });
  }

  let prevMsg = null;
  // Only use last element for grouping if it's an actual message (not a system message)
  if (lastMsg && lastMsg.dataset && lastMsg.dataset.userId && lastMsg.dataset.msgId) {
    prevMsg = {
      user_id: parseInt(lastMsg.dataset.userId),
      created_at: lastMsg.dataset.time,
      persona_id: lastMsg.dataset.personaId ? parseInt(lastMsg.dataset.personaId) : null,
      persona_username: lastMsg.dataset.personaUsername || null,
      username: lastMsg.dataset.username || null,
      break_chain: lastMsg.dataset.breakChain ? 1 : 0,
    };
  }

  const forumFeed = this._isForumFeed();
  const wasAtBottom = forceScroll || this._coupledToBottom;
  const nearTop = container.scrollTop < 40;
  const msgEl = this._createMessageEl(message, forumFeed ? null : prevMsg);
  if (forumFeed) {
    // A new topic is the newest activity, so it goes on top, under the pinned
    // block. (#144)
    container.querySelector('.forum-empty-hint')?.remove();
    container.insertBefore(msgEl, this._forumFeedTopSlot(container, msgEl));
  } else {
    container.appendChild(msgEl);
  }

  // ── DOM trimming: drop the least recent messages when the list grows too large ──
  // This prevents unbounded memory growth that causes OOM crashes. The least
  // recent end is the top of a chat feed and the bottom of a forum feed.
  const MAX_DOM_MESSAGES = 100;
  const trimmed = container.children.length > MAX_DOM_MESSAGES;
  while (container.children.length > MAX_DOM_MESSAGES) {
    container.removeChild(forumFeed ? container.lastElementChild : container.firstElementChild);
  }
  // Keep _oldestMsgId in sync with the DOM after trimming
  const edgeEl = forumFeed ? container.lastElementChild : container.firstElementChild;
  if (edgeEl && edgeEl.dataset && edgeEl.dataset.msgId) {
    this._oldestMsgId = parseInt(edgeEl.dataset.msgId);
  }
  // Re-enable backward pagination since we trimmed old messages
  if (trimmed) this._noMoreHistory = false;

  // Fetch link previews for this message
  this._fetchLinkPreviews(msgEl);
  this._setupVideos(msgEl);
  this._decryptE2EImages(msgEl);
  this._decryptE2EFiles(msgEl);
  // DMs are ciphertext server-side, so their links can only be judged
  // here, after decryption and before anyone can click. (#5483)
  if (this._isDmContainer((msgEl))) this._enforceDmLinkPolicy((msgEl));
  this._wireBurnMessages?.(msgEl);
  if (forumFeed) {
    if (forceScroll || nearTop) container.scrollTop = 0;
  } else if (wasAtBottom) {
    this._scrollToBottom(true);
  }
  // Scroll after images/gifs load, but only if still coupled to bottom.
  // Use the debounced variant so multiple images loading at different speeds
  // collapse into one scroll call rather than each firing an instant snap.
  const imgs = msgEl.querySelectorAll('img');
  if (imgs.length) {
    imgs.forEach(img => {
      if (!img.complete) {
        img.addEventListener('load', () => {
          if (this._coupledToBottom) this._debouncedScrollToBottom();
        }, { once: true });
        img.addEventListener('error', () => {
          if (this._coupledToBottom) this._debouncedScrollToBottom();
        }, { once: true });
      }
    });
  }
},

// Footer listing every tag across a message's tagged attachments, folded into
// one row with the tag icon and a "Tags" label (#tagging). The server already
// dedupes the list; empty/absent = no footer.
_renderAttachmentTags(tags) {
  if (!Array.isArray(tags) || !tags.length) return '';
  const icon = '<svg class="message-tags-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>';
  // Each chip is a button: clicking it runs a search for exactly that tag
  // (wired via delegation in app-ui.js). data-tag carries the raw name.
  const chips = tags.map(name => {
    const esc = this._escapeHtml(name);
    return `<button type="button" class="message-tag" data-tag="${esc}" title="${this._escapeHtml(t('tags.search_for', { name }))}">${esc}</button>`;
  }).join('');
  return `<div class="message-tags">${icon}<span class="message-tags-label">${t('tags.attachment_tags')}</span>${chips}</div>`;
},

_createMessageEl(msg, prevMsg) {
  // Persisted welcome message (new-member greeting). Rendered as a simple,
  // non-interactive system line reusing the .welcome-message styling — no
  // avatar, toolbar, reactions, or grouping. Covers history load and live
  // append alike. Uses textContent so the name/template can't inject HTML.
  if (msg && msg.type === 'welcome') {
    const el = document.createElement('div');
    el.className = 'welcome-message';
    el.dataset.type = 'welcome';
    if (Number.isInteger(msg.id) && msg.id > 0) el.dataset.msgId = msg.id;
    el.textContent = msg.content;
    return el;
  }
  const isImage = this._isImageUrl(msg.content);
  const curCh = this.channels && this.channels.find(c => c.code === this.currentChannel);
  const isAnnouncement = curCh && curCh.notification_type === 'announcement';
  // Forum topics never fold into each other: every topic keeps its own header,
  // which also keeps _bumpForumTopic's node move safe. (#144)
  const isForum = !!(curCh && curCh.is_forum);
  // Threads were intentionally removed from DMs entirely. The PiP appenders
  // mark their messages with `_isDmRender`; main-pane DM views are caught by
  // `curCh.is_dm`. Either signal suppresses the thread button + preview so
  // there is no entry point left in any DM surface.
  const isDmContext = !!(msg && msg._isDmRender) || !!(curCh && curCh.is_dm);
  const isCompact = prevMsg && !isForum &&
    // A preceding welcome/system line never folds the next message into it.
    (prevMsg.type || 'user') === 'user' &&
    prevMsg.user_id === msg.user_id &&
    // Persona / webhook / Discord-imported messages must each break the
    // grouping chain so a different persona under the same account doesn't
    // get folded under the previous persona's avatar. (#5349 follow-up,
    // #5393 defence-in-depth: also compare persona_username and the
    // displayed username so a missing persona_id field can't sneak two
    // different personas into a single compact group.)
    (prevMsg.persona_id || null) === (msg.persona_id || null) &&
    (prevMsg.persona_username || null) === (msg.persona_username || null) &&
    (prevMsg.username || null) === (msg.username || null) &&
    // /break and the persisted break_chain flag (#5393) hard-stop grouping.
    !msg.break_chain && !prevMsg.break_chain &&
    (prevMsg.is_webhook ? 1 : 0) === (msg.is_webhook ? 1 : 0) &&
    (prevMsg.webhook_username || null) === (msg.webhook_username || null) &&
    (prevMsg.imported_from || null) === (msg.imported_from || null) &&
    !msg.reply_to &&
    (new Date(msg.created_at) - new Date(prevMsg.created_at)) < 5 * 60 * 1000;

  const reactionsHtml = this._renderReactions(msg.id, msg.reactions || []);
  const tagsHtml = this._renderAttachmentTags(msg.attachmentTags);
  const pollHtml = msg.poll ? this._renderPollWidget(msg.id, msg.poll) : '';
  const roleMenuHtml = msg.roleMenu ? this._renderRoleMenu(msg.id, msg.roleMenu) : '';
  const threadHtml = isDmContext ? ''
    : (msg.thread ? this._renderThreadPreview(msg.id, msg.thread, { forum: isForum })
      : (isForum ? this._renderThreadPreview(msg.id, { count: 0 }, { forum: true }) : ''));
  const editedHtml = msg.edited_at ? `<span class="edited-tag" title="${t('app.messages.edited_at', { date: this._fmtDateTime(msg.edited_at) })}">${t('app.messages.edited')}</span>` : '';
  const pinnedTag = msg.pinned ? `<span class="pinned-tag" title="${t('app.messages.pinned')}">📌</span>` : '';
  const archivedTag = msg.is_archived ? `<span class="archived-tag" title="${t('app.messages.protected')}">🛡️</span>` : '';
  const ephemeralTag = msg.ephemeral ? `<span class="ephemeral-tag" title="${t('app.messages.only_visible_to_you')}">${t('app.messages.only_visible_to_you')}</span>` : '';
  const e2eTag = msg._e2e ? `<span class="e2e-tag" title="${t('app.messages.e2e_encrypted')}">🔒</span>` : '';
  const needsStatusSlot = !!e2eTag || !!(msg.burn_seconds && msg.burn_seconds > 0);
  const statusSlotHtml = needsStatusSlot ? `<span class="message-inline-status">${e2eTag}</span>` : '';

  const iconPair = (emoji, monoSvg) => `<span class="tb-icon tb-icon-emoji" aria-hidden="true">${emoji}</span><span class="tb-icon tb-icon-mono" aria-hidden="true">${monoSvg}</span>`;
  const iReact = iconPair('😀', '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke-width="1.8"></circle><path d="M8.5 14.5c1 1.2 2.2 1.8 3.5 1.8s2.5-.6 3.5-1.8" stroke-width="1.8" stroke-linecap="round"></path><circle cx="9.2" cy="10.2" r="1" fill="currentColor" stroke="none"></circle><circle cx="14.8" cy="10.2" r="1" fill="currentColor" stroke="none"></circle></svg>');
  const iReply = iconPair('↩️', '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 8L4 12L10 16" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path><path d="M20 12H5" stroke-width="1.8" stroke-linecap="round"></path></svg>');
  const iQuote = iconPair('💬', '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 7H5v6h4l-2 4" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path><path d="M19 7h-4v6h4l-2 4" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path></svg>');
  const iThread = iconPair('🧵', '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 9h8" stroke-width="1.8" stroke-linecap="round"></path><path d="M8 13h6" stroke-width="1.8" stroke-linecap="round"></path><path d="M6 6h12a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-8l-4 3v-3H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z" stroke-width="1.8" stroke-linejoin="round"></path></svg>');
  const iPin = iconPair('📌', '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 4h8l-2 5v4l2 2H8l2-2V9L8 4z" stroke-width="1.8" stroke-linejoin="round"></path><path d="M12 15v5" stroke-width="1.8" stroke-linecap="round"></path></svg>');
  const iArchive = iconPair('🛡️', '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16v11H4z" stroke-width="1.8" stroke-linejoin="round"></path><path d="M9 11h6" stroke-width="1.8" stroke-linecap="round"></path><path d="M3 7l2-3h14l2 3" stroke-width="1.8" stroke-linejoin="round"></path></svg>');
  const iEdit = iconPair('✏️', '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20l4.5-1 9-9-3.5-3.5-9 9L4 20z" stroke-width="1.8" stroke-linejoin="round"></path><path d="M13.5 6.5l3.5 3.5" stroke-width="1.8" stroke-linecap="round"></path></svg>');
  const iDelete = iconPair('🗑️', '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14" stroke-width="1.8" stroke-linecap="round"></path><path d="M9 7V5h6v2" stroke-width="1.8" stroke-linecap="round"></path><path d="M7 7l1 12h8l1-12" stroke-width="1.8" stroke-linejoin="round"></path></svg>');
  const iLink = iconPair('🔗', '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path><path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path></svg>');
  const iMore = iconPair('⋯', '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="12" r="1.6" fill="currentColor" stroke="none"></circle><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"></circle><circle cx="18" cy="12" r="1.6" fill="currentColor" stroke="none"></circle></svg>');
  const canShareLink = !isDmContext && this._canShareChannelLink?.(this.currentChannel);

  const reactionsAllowed = isDmContext || this._channelAllowsReactions?.(this.currentChannel) !== false;
  const toolbarActions = [
    ...(reactionsAllowed ? [{ key: 'react', html: `<button data-action="react" title="${t('msg_toolbar.react')}">${iReact}</button>` }] : []),
    { key: 'reply', html: `<button data-action="reply" title="${t('msg_toolbar.reply')}">${iReply}</button>` },
    { key: 'quote', html: `<button data-action="quote" title="${t('msg_toolbar.quote')}">${iQuote}</button>` },
    // Threads are not available in DMs - omit the button entirely so there is
    // no entry point. Server-side `send-thread-message` and `get-thread-messages`
    // also reject DM channels as a defence in depth.
    ...(isDmContext ? [] : [{ key: 'thread', html: `<button data-action="thread" title="${t('msg_toolbar.thread')}">${iThread}</button>` }]),
    // Message links contain the DM channel code - never expose them in DM context.
    ...(canShareLink ? [{ key: 'copy-link', html: `<button data-action="copy-link" title="${t('msg_toolbar.copy_link')}">${iLink}</button>` }] : [])
  ];
  // Gate pin/unpin on the explicit `pin_message` permission so granting it via
  // a role (without making the user a moderator) actually shows the button.
  // Previously gated on _canModerate() (level >= 25), which made the role
  // toggle look broken because users with only `pin_message` saw nothing.
  const canPin = this.user.isAdmin || this._hasPerm('pin_message');
  const canArchive = this.user.isAdmin || this._hasPerm('archive_messages');
  // _canModerate() is a level check (effectiveLevel >= 25), so on its own it
  // ignored the delete_message permission entirely: someone granted "delete any
  // message" through a channel role but sitting below level 25 got no delete
  // button, even though the server would have allowed it. (#5461)
  const canDelete = msg.user_id === this.user.id || this.user.isAdmin ||
                    this._canModerate() || this._hasPerm('delete_message');
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

  const defaultToolbarOrder = ['react', 'reply', 'quote', 'thread', 'copy-link', 'pin', 'archive', 'edit', 'delete'];
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
    ? `<div class="msg-toolbar-more"><button class="msg-toolbar-more-btn" type="button" aria-label="${t('users.more_actions')}">${iMore}</button><div class="msg-toolbar-overflow">${overflowToolbarBtns}</div></div>`
    : '';
  const toolbarHtml = `<div class="msg-toolbar"><div class="msg-toolbar-group">${coreToolbarBtns}</div>${moreMenuHtml}</div>`;
  const replyHtml = msg.replyContext ? this._renderReplyBanner(msg.replyContext) : '';

  if (isCompact) {
    const el = document.createElement('div');
    el.className = 'message-compact'
      + (needsStatusSlot ? ' message-has-status' : '')
      + (msg.pinned ? ' pinned' : '')
      + (msg.is_archived ? ' archived' : '')
      + (isAnnouncement ? ' announcement' : '');
    el.dataset.userId = msg.user_id;
    el.dataset.username = msg.username;
    el.dataset.time = msg.created_at;
    el.dataset.timeShort = this._fmtTime(msg.created_at);
    if (Number.isInteger(msg.id) && msg.id > 0) el.dataset.msgId = msg.id;
    el.dataset.rawContent = msg.content;
    if (msg.persona_id) el.dataset.personaId = String(msg.persona_id);
    if (msg.persona_username) el.dataset.personaUsername = msg.persona_username;
    if (msg.break_chain) el.dataset.breakChain = '1';
    if (msg.pinned) el.dataset.pinned = '1';
    if (msg.is_archived) el.dataset.archived = '1';
    if (msg._e2e) el.dataset.e2e = '1';
    if (msg.poll && msg.poll.anonymous) el.dataset.pollAnonymous = '1';
    // (#5280) burn-after-read — compact messages need the same class/data
    // as full messages so _wireBurnMessages can process them.
    if (msg.burn_seconds && msg.burn_seconds > 0) {
      el.classList.add('message-burn-pending');
      el.dataset.burnSeconds = String(msg.burn_seconds);
      if (msg.burning_started_at) el.dataset.burnStartedAt = msg.burning_started_at;
    }
    // Store avatar so _promoteCompactToFull can restore the correct image
    // even when the author is not in the online users list (e.g. offline).
    if (msg.avatar) el.dataset.avatar = msg.avatar;
    if (msg.avatar_shape) el.dataset.avatarShape = msg.avatar_shape;
    if (msg.border) el.dataset.border = msg.border;
    if (msg.borderTransform) el.dataset.borderTransform = JSON.stringify(msg.borderTransform);
    if (msg.animateProfile) el.dataset.animateProfile = msg.animateProfile;
    el.innerHTML = `
      <span class="compact-time">${this._fmtTime(msg.created_at)}</span>
      <div class="message-body">
        <div class="message-content">${pinnedTag}${archivedTag}${ephemeralTag}${this._formatContent(msg.content)}${editedHtml}${statusSlotHtml}</div>
        ${pollHtml}${roleMenuHtml}
        ${reactionsHtml}
        ${tagsHtml}
        ${threadHtml}
      </div>
      ${toolbarHtml}
      <button class="msg-dots-btn" aria-label="${t('app.actions.message_actions')}">⋯</button>
    `;
    return el;
  }

  const color = this._getUserColor(msg.username);
  const initial = msg.username.charAt(0).toUpperCase();
  // Look up user's role from online users list (falls back to channelMembers for offline users)
  const onlineUser = this._memberById(msg.user_id);
  // Use the message sender's avatar_shape (from server), not the local user's preference
  const msgShape = msg.avatar_shape || (onlineUser && onlineUser.avatarShape) || 'circle';
  const shapeClass = 'avatar-' + msgShape;

  // For imported Discord messages, use the stored Discord avatar or a generic Discord icon
  let avatarHtml;
  if (msg.imported_from === 'discord') {
    const discordAvatar = msg.webhook_avatar;
    if (discordAvatar) {
      avatarHtml = `<img class="message-avatar message-avatar-img ${shapeClass}"${this._animAttr(msg.animateProfile)} src="${this._escapeHtml(discordAvatar)}" loading="lazy" alt="${initial}"><div class="message-avatar ${shapeClass}" style="background-color:${color};display:none">${initial}</div>`;
    } else {
      // Generic Discord-style avatar (colored circle with initial)
      avatarHtml = `<div class="message-avatar ${shapeClass} discord-import-avatar" style="background-color:#5865f2">${initial}</div>`;
    }
  } else if (msg.avatar) {
    avatarHtml = `<img class="message-avatar message-avatar-img ${shapeClass}"${this._animAttr(msg.animateProfile)} src="${this._escapeHtml(msg.avatar)}" loading="lazy" alt="${initial}"><div class="message-avatar ${shapeClass}" style="background-color:${color};display:none">${initial}</div>`;
  } else {
    avatarHtml = `<div class="message-avatar ${shapeClass}" style="background-color:${color}">${initial}</div>`;
  }

  // Multi-role aware: highest role drives the badge color/text, but the
  // tooltip lists every role the user holds in this channel context.
  const _allRoles = (onlineUser && Array.isArray(onlineUser.roles)) ? onlineUser.roles : [];
  const _roleTitle = _allRoles.length > 1
    ? _allRoles.map(r => r.name).join('\n')
    : (onlineUser && onlineUser.role ? onlineUser.role.name : '');
  const msgRoleBadge = onlineUser && onlineUser.role
    ? `<span class="user-role-badge msg-role-badge" style="color:${this._safeColor(onlineUser.role.color, 'var(--text-muted)')}" title="${this._escapeHtml(_roleTitle)}">${this._roleNameHtml(onlineUser.role, onlineUser.role.name)}${_allRoles.length > 1 ? ` <span class="msg-role-extra-count">+${_allRoles.length - 1}</span>` : ''}</span>`
    : '';

  // Role icon in chat
  const showIconChat = this.serverSettings.role_icon_chat === 'true';
  const iconAfterName = this.serverSettings.role_icon_after_name === 'true';
  const msgRoleIcon = showIconChat && onlineUser && onlineUser.role && onlineUser.role.icon
    ? `<img class="role-icon" src="${this._escapeHtml(onlineUser.role.icon)}" alt="" title="${this._escapeHtml(_roleTitle)}">`
    : '';
  const msgRoleIconBefore = msgRoleIcon && !iconAfterName ? msgRoleIcon : '';
  const msgRoleIconAfter = msgRoleIcon && iconAfterName ? msgRoleIcon : '';

  // Role color display mode: colored-name uses role color for the author name
  const roleDisplayMode = localStorage.getItem('haven-role-display') || 'colored-name';
  const authorRoleStyled = roleDisplayMode === 'colored-name' && onlineUser && onlineUser.role && onlineUser.role.color;
  const authorColor = authorRoleStyled
    ? this._safeColor(onlineUser.role.color, color)
    : color;
  // The author name, painted by a gradient role when the author has one.
  const authorText = msg.persona_id ? msg.username : this._getNickname(msg.user_id, msg.username);
  const authorHtml = authorRoleStyled ? this._roleNameHtml(onlineUser.role, authorText) : this._escapeHtml(authorText);

  const botBadge = msg.imported_from === 'discord'
    ? '<span class="discord-badge">DISCORD</span>'
    : msg.is_webhook ? '<span class="bot-badge">BOT</span>' : '';

  // Persona badge (#86, #5349) — shown when message was sent via a user persona
  const personaBadge = msg.persona_id
    ? `<span class="persona-msg-badge" title="${this._escapeHtml(t('app.messages.via_persona', { name: msg.real_username || t('app.messages.real_account') }))}">${this._escapeHtml(t('app.messages.persona_badge'))}</span>`
    : '';

  // Ferry badge: where this message was sent on Discord. The routing prefix
  // is stripped before storage, so without this the channel would show people
  // apparently talking to nobody.
  const ferryBadge = msg.ferry_target
    ? `<span class="ferry-badge" title="${this._escapeHtml(t('app.messages.relayed_to_discord'))}">🛶 ${this._escapeHtml(msg.ferry_target === 'dm' ? t('app.messages.discord_dm') : msg.ferry_target)}</span>`
    : '';

  // (#5381) Guest badge — shown next to the username when the author is
  // an ephemeral guest account.
  const guestBadge = (onlineUser && onlineUser.isGuest)
    ? `<span class="guest-msg-badge" style="background:rgba(136,136,136,0.18);color:#aaa;font-size:0.62rem;padding:1px 5px;border-radius:3px;margin-left:4px;letter-spacing:0.04em" title="${t('app.messages.temporary_guest')}">${t('app.messages.guest_badge')}</span>`
    : '';

  const el = document.createElement('div');
  el.className = 'message'
    + (needsStatusSlot ? ' message-has-status' : '')
    + (isImage ? ' message-has-image' : '')
    + (msg.pinned ? ' pinned' : '')
    + (msg.is_archived ? ' archived' : '')
    + (msg.is_webhook ? ' webhook-message' : '')
    + (msg.imported_from ? ' imported-message' : '')
    + (isAnnouncement ? ' announcement' : '');
  // Add separator line between different users' message groups (or between
  // different personas under the same user).
  if (prevMsg && (prevMsg.user_id !== msg.user_id || (prevMsg.persona_id || null) !== (msg.persona_id || null))) el.classList.add('message-user-sep');
  el.dataset.userId = msg.user_id;
  el.dataset.username = msg.username;
  el.dataset.time = msg.created_at;
  el.dataset.timeShort = this._fmtTime(msg.created_at);
  if (Number.isInteger(msg.id) && msg.id > 0) el.dataset.msgId = msg.id;
  el.dataset.rawContent = msg.content;
  if (msg.persona_id) el.dataset.personaId = String(msg.persona_id);
  if (msg.persona_username) el.dataset.personaUsername = msg.persona_username;
  if (msg.break_chain) el.dataset.breakChain = '1';
  if (msg.pinned) el.dataset.pinned = '1';
  if (msg.is_archived) el.dataset.archived = '1';
  if (msg._e2e) el.dataset.e2e = '1';
  // (#5280) burn-after-read marker — `_wireBurnMessages` (called from
  // every render path) reads these attrs to set up the click-to-reveal
  // placeholder + countdown timer.
  if (msg.burn_seconds && msg.burn_seconds > 0) {
    el.classList.add('message-burn-pending');
    el.dataset.burnSeconds = String(msg.burn_seconds);
    if (msg.burning_started_at) el.dataset.burnStartedAt = msg.burning_started_at;
  }
  if (msg.poll && msg.poll.anonymous) el.dataset.pollAnonymous = '1';
  el.innerHTML = `
    <div class="message-row">
      ${this._avatarWithBorder(avatarHtml, msg)}
      <div class="message-body">
        ${replyHtml}
        <div class="message-header">
          ${msgRoleIconBefore}
          <span class="message-author" style="color:${authorColor}"${!msg.persona_id && this._nicknames[msg.user_id] ? ` title="${this._escapeHtml(msg.username)}"` : ''}>${authorHtml}</span>
          ${msgRoleIconAfter}
          ${botBadge}
          ${personaBadge}
          ${ferryBadge}
          ${guestBadge}
          ${msgRoleBadge}
          <span class="message-time"${this._timeAttr(msg.created_at)}>${this._formatTime(msg.created_at)}</span>
          ${pinnedTag}
          ${archivedTag}
          ${ephemeralTag}
          ${statusSlotHtml}
          <span class="message-header-spacer"></span>
        </div>
        <div class="message-content">${this._formatContent(msg.content)}${editedHtml}</div>
        ${pollHtml}${roleMenuHtml}
        ${reactionsHtml}
        ${tagsHtml}
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
  const tagsEl = compactEl.querySelector('.message-tags');
  const tagsHtml = tagsEl ? tagsEl.outerHTML : '';
  const pinnedTag = isPinned ? `<span class="pinned-tag" title="${t('app.messages.pinned')}">📌</span>` : '';
  const e2eTag = compactEl.dataset.e2e === '1' ? `<span class="e2e-tag" title="${t('app.messages.e2e_encrypted')}">🔒</span>` : '';
  const needsStatusSlot = !!e2eTag || compactEl.classList.contains('message-burn-pending');
  const statusSlotHtml = needsStatusSlot ? `<span class="message-inline-status">${e2eTag}</span>` : '';

  const color = this._getUserColor(username);
  const initial = username.charAt(0).toUpperCase();
  const onlineUser = this._memberById(userId);
  // Prefer the avatar stored on the compact element (set at render time from server data).
  // Fall back to the online-users list so newly-uploaded avatars still appear.
  const msgShape = compactEl.dataset.avatarShape || (onlineUser && onlineUser.avatarShape) || 'circle';
  const shapeClass = 'avatar-' + msgShape;
  const avatar = compactEl.dataset.avatar || (onlineUser && onlineUser.avatar) || null;
  // Border fit stored on the compact element (offline-safe), same as avatar above.
  const border = compactEl.dataset.border || (onlineUser && onlineUser.border) || null;
  let borderTransform = (onlineUser && onlineUser.borderTransform) || null;
  try { if (compactEl.dataset.borderTransform) borderTransform = JSON.parse(compactEl.dataset.borderTransform); } catch { /* malformed border data: keep the member list value */ }
  const animateProfile = compactEl.dataset.animateProfile || (onlineUser && onlineUser.animateProfile) || 'trigger';
  const avatarHtml = avatar
    ? `<img class="message-avatar message-avatar-img ${shapeClass}"${this._animAttr(animateProfile)} src="${this._escapeHtml(avatar)}" loading="lazy" alt="${initial}"><div class="message-avatar ${shapeClass}" style="background-color:${color};display:none">${initial}</div>`
    : `<div class="message-avatar ${shapeClass}" style="background-color:${color}">${initial}</div>`;

  // Multi-role aware (compact-to-full path) — mirror of _createMessageEl above.
  const _allRoles2 = (onlineUser && Array.isArray(onlineUser.roles)) ? onlineUser.roles : [];
  const _roleTitle2 = _allRoles2.length > 1
    ? _allRoles2.map(r => r.name).join('\n')
    : (onlineUser && onlineUser.role ? onlineUser.role.name : '');
  const msgRoleBadge = onlineUser && onlineUser.role
    ? `<span class="user-role-badge msg-role-badge" style="color:${this._safeColor(onlineUser.role.color, 'var(--text-muted)')}" title="${this._escapeHtml(_roleTitle2)}">${this._roleNameHtml(onlineUser.role, onlineUser.role.name)}${_allRoles2.length > 1 ? ` <span class="msg-role-extra-count">+${_allRoles2.length - 1}</span>` : ''}</span>`
    : '';

  // Role icon in chat (compact-to-full)
  const showIconChat2 = this.serverSettings.role_icon_chat === 'true';
  const iconAfterName2 = this.serverSettings.role_icon_after_name === 'true';
  const msgRoleIcon2 = showIconChat2 && onlineUser && onlineUser.role && onlineUser.role.icon
    ? `<img class="role-icon" src="${this._escapeHtml(onlineUser.role.icon)}" alt="" title="${this._escapeHtml(_roleTitle2)}">`
    : '';
  const msgRoleIconBefore2 = msgRoleIcon2 && !iconAfterName2 ? msgRoleIcon2 : '';
  const msgRoleIconAfter2 = msgRoleIcon2 && iconAfterName2 ? msgRoleIcon2 : '';

  // Author name in the role's style, the same rule as a freshly rendered
  // message (this path used to drop the role color).
  const roleStyled2 = (localStorage.getItem('haven-role-display') || 'colored-name') === 'colored-name'
    && onlineUser && onlineUser.role && onlineUser.role.color;
  const authorColor2 = roleStyled2 ? this._safeColor(onlineUser.role.color, color) : color;
  const authorText2 = this._getNickname(userId, username);
  const authorHtml2 = roleStyled2 ? this._roleNameHtml(onlineUser.role, authorText2) : this._escapeHtml(authorText2);

  // Replace the compact element in-place
  const wasAnnouncement = compactEl.classList.contains('announcement');
  compactEl.className = 'message'
    + (needsStatusSlot ? ' message-has-status' : '')
    + (isPinned ? ' pinned' : '')
    + (wasAnnouncement ? ' announcement' : '');
  compactEl.dataset.userId = userId;
  compactEl.dataset.time = time;
  compactEl.dataset.msgId = msgId;
  if (isPinned) compactEl.dataset.pinned = '1';
  compactEl.innerHTML = `
    <div class="message-row">
      ${this._avatarWithBorder(avatarHtml, { border, borderTransform, animateProfile })}
      <div class="message-body">
        <div class="message-header">
          ${msgRoleIconBefore2}
          <span class="message-author" style="color:${authorColor2}"${this._nicknames[userId] ? ` title="${this._escapeHtml(username)}"` : ''}>${authorHtml2}</span>
          ${msgRoleIconAfter2}
          ${msgRoleBadge}
          <span class="message-time"${this._timeAttr(time)}>${this._formatTime(time)}</span>
          ${pinnedTag}
          ${statusSlotHtml}
          <span class="message-header-spacer"></span>
        </div>
        <div class="message-content">${contentHtml}</div>
        ${reactionsHtml}
        ${tagsHtml}
      </div>
      ${toolbarHtml}
      <button class="msg-dots-btn" aria-label="${t('app.actions.message_actions')}">⋯</button>
    </div>
  `;
  // A compact row is usually promoted while hovered; mark its pfp as playing so
  // the freeze observer leaves it animating until the pointer actually leaves.
  if (compactEl.matches(':hover')) {
    compactEl.querySelectorAll('img[data-animate="trigger"]').forEach((i) => { i.dataset.animPlaying = '1'; });
  }
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

};
