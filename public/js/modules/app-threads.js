// Threads: the preview under a message, opening and closing the thread panel,
// replies and quotes in it, sending, @mention tracking, and pop-out mode.

export default {

// ═══════════════════════════════════════════════════════
// THREADS
// ═══════════════════════════════════════════════════════

_renderThreadPreview(parentId, thread, opts = {}) {
  if (!thread) return '';
  if (!thread.count) {
    // A forum topic with no replies yet gets the same button as an
    // invitation, so a fresh topic reads as a topic rather than a message.
    if (!opts.forum) return '';
    return `
    <button class="thread-preview thread-preview-empty" data-thread-parent="${parentId}">
      <span class="thread-preview-count">${t('thread_runtime.reply_to_topic')}</span>
      <span class="thread-preview-arrow">›</span>
    </button>
  `;
  }
  const participantAvatars = (thread.participants || []).map(p => {
    const shape = this._threadAvatarShape(p.avatarShape);
    if (p.avatar) {
      return `<img class="thread-participant-avatar${shape}" ${this._imgSrcAttr(p.avatar)} alt="${this._escapeHtml(p.username)}" title="${this._escapeHtml(p.username)}">`;
    }
    const color = this._getUserColor(p.username);
    const initial = this._escapeHtml(p.username.charAt(0).toUpperCase());
    return `<div class="thread-participant-avatar thread-participant-initial${shape}" style="background:${color}" title="${this._escapeHtml(p.username)}">${initial}</div>`;
  }).join('');

  const timeAgo = this._relativeTime(thread.lastReplyAt);
  // Replies you have not seen yet (app-thread-unread.js); forum cards have
  // their own dot.
  const fresh = opts.forum ? 0 : (this._threadNewCount?.(parentId, thread) || 0);
  if (!opts.forum) this._queueThreadsBadge?.();
  return `
    <button class="thread-preview${fresh ? ' thread-preview-has-new' : ''}" data-thread-parent="${parentId}">
      ${participantAvatars}
      <span class="thread-preview-count">${t(thread.count === 1 ? 'thread_runtime.reply_one' : 'thread_runtime.reply_other', { count: thread.count })}</span>
      ${fresh ? this._threadChipNewHtml(fresh) : ''}
      <span class="thread-preview-time">${timeAgo}</span>
      <span class="thread-preview-arrow">›</span>
    </button>
  `;
},

_relativeTime(isoStr) {
  if (!isoStr) return '';
  const diff = Date.now() - new Date(isoStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return t('thread_runtime.just_now');
  if (mins < 60) return t('thread_runtime.minutes_ago', { count: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t('thread_runtime.hours_ago', { count: hours });
  const days = Math.floor(hours / 24);
  return t('thread_runtime.days_ago', { count: days });
},

_setThreadParentHeader(meta = {}) {
  const wrap = document.getElementById('thread-parent-avatar-wrap');
  const nameEl = document.getElementById('thread-parent-name');
  if (!wrap || !nameEl) return;

  const baseUsername = (meta.username || '').trim() || t('thread_runtime.starter');
  // Apply the local user's nickname assignment so threads match the rest of
  // the UI (members list, message author, mentions). Falls back to the
  // server-provided display name when no nickname is set. (#5291)
  const username = meta.userId != null
    ? (this._getNickname?.(meta.userId, baseUsername) || baseUsername)
    : baseUsername;
  const shapeClass = meta.avatarShape === 'square' ? ' thread-parent-avatar-square' : this._threadAvatarShape(meta.avatarShape);
  // The starter's id lets their name and avatar open the profile card.
  const uid = meta.userId != null ? String(meta.userId) : '';
  wrap.dataset.userId = uid;
  nameEl.dataset.userId = uid;

  if (meta.avatar) {
    wrap.innerHTML = `<img class="thread-parent-avatar${shapeClass}" ${this._imgSrcAttr(meta.avatar)} alt="${this._escapeHtml(username)}">`;
  } else {
    const initial = username.charAt(0).toUpperCase() || '?';
    const color = this._getUserColor(username);
    wrap.innerHTML = `<div class="thread-parent-avatar-initial${shapeClass}" style="background:${color}">${this._escapeHtml(initial)}</div>`;
  }

  nameEl.textContent = username;
  nameEl.title = username;
},

_setThreadReply(msgEl, msgId) {
  const author = msgEl.querySelector('.thread-msg-author')?.textContent
    || this._getNickname?.(parseInt(msgEl.dataset.userId, 10), msgEl.dataset.username)
    || msgEl.dataset.username || t('voice.someone');
  const rawContent = msgEl.dataset.rawContent || msgEl.querySelector('.thread-msg-content')?.textContent || '';
  const preview = rawContent.length > 70 ? rawContent.substring(0, 70) + '…' : rawContent;
  this._threadReplyingTo = { id: msgId, username: author, content: rawContent };
  this._forumBlogThread && this._forumBlogComposerHint?.();

  const bar = document.getElementById('thread-reply-bar');
  const text = document.getElementById('thread-reply-preview-text');
  if (!bar || !text) return;
  bar.style.display = 'flex';
  text.innerHTML = t('thread_runtime.replying_to', { author: this._escapeHtml(author), preview: this._escapeHtml(preview) });

  const input = document.getElementById('thread-input');
  if (input) input.focus();
},

_clearThreadReply() {
  this._threadReplyingTo = null;
  this._forumBlogThread && this._forumBlogComposerHint?.();
  const bar = document.getElementById('thread-reply-bar');
  if (bar) bar.style.display = 'none';
},

_quoteThreadMessage(msgEl) {
  const rawContent = msgEl.dataset.rawContent || msgEl.querySelector('.thread-msg-content')?.textContent || '';
  const author = msgEl.querySelector('.thread-msg-author')?.textContent
    || this._getNickname?.(parseInt(msgEl.dataset.userId, 10), msgEl.dataset.username)
    || msgEl.dataset.username || t('voice.someone');
  const quotedLines = rawContent.split('\n').map(l => `> ${l}`).join('\n');
  const quoteText = `${t('thread_runtime.wrote', { author })}\n${quotedLines}\n`;

  const input = document.getElementById('thread-input');
  if (!input) return;
  if (input.value) {
    input.value += '\n' + quoteText;
  } else {
    input.value = quoteText;
  }
  input.focus();
  input.dispatchEvent(new Event('input'));
},

// ── Thread @mention tracking ──────────────────────
_recordThreadMention(channelCode, parentId, msg) {
  if (!this._threadMentions) {
    try { this._threadMentions = JSON.parse(localStorage.getItem('haven_thread_mentions') || '{}'); }
    catch { this._threadMentions = {}; }
  }
  const list = this._threadMentions[channelCode] || (this._threadMentions[channelCode] = []);
  // Dedupe by messageId
  if (list.some(m => m.messageId === msg.id)) return;
  list.push({
    parentId,
    messageId: msg.id,
    username: msg.username || '',
    snippet: (msg.content || '').slice(0, 140),
    when: Date.now()
  });
  this._persistThreadMentions();
  this._renderChannels?.();
  this._updateThreadMentionsPill();
},
_clearThreadMentionsForParent(channelCode, parentId) {
  if (!this._threadMentions || !this._threadMentions[channelCode]) return;
  this._threadMentions[channelCode] = this._threadMentions[channelCode].filter(m => m.parentId !== parentId);
  if (this._threadMentions[channelCode].length === 0) delete this._threadMentions[channelCode];
  this._persistThreadMentions();
  this._renderChannels?.();
  this._updateThreadMentionsPill();
},
_clearThreadMentionsForChannel(channelCode) {
  if (!this._threadMentions || !this._threadMentions[channelCode]) return;
  delete this._threadMentions[channelCode];
  this._persistThreadMentions();
  this._renderChannels?.();
  this._updateThreadMentionsPill();
},
// The bell is kept per device. Mentions in threads this account has since
// read past, on any device, are dropped (server: threadReadState.js).
_pruneReadThreadMentions() {
  if (!this.socket || !this.socket.connected) return;
  if (!this._threadMentions) {
    try { this._threadMentions = JSON.parse(localStorage.getItem('haven_thread_mentions') || '{}'); }
    catch { this._threadMentions = {}; }
  }
  const parentIds = [...new Set(Object.values(this._threadMentions).flat().map(m => Number(m.parentId)).filter(Number.isInteger))];
  if (!parentIds.length) return;
  this.socket.emit('get-thread-read-state', { parentIds }, (res) => {
    const reads = (res && res.reads) || {};
    let changed = false;
    for (const code of Object.keys(this._threadMentions)) {
      const kept = this._threadMentions[code].filter(m => !(Number(reads[m.parentId]) >= Number(m.messageId)));
      if (kept.length !== this._threadMentions[code].length) changed = true;
      if (kept.length) this._threadMentions[code] = kept;
      else delete this._threadMentions[code];
    }
    if (!changed) return;
    this._persistThreadMentions();
    this._renderChannels?.();
    this._updateThreadMentionsPill();
  });
},
_persistThreadMentions() {
  try { localStorage.setItem('haven_thread_mentions', JSON.stringify(this._threadMentions || {})); } catch { /* storage blocked (private mode): nothing is remembered, nothing else breaks */ }
},
_updateThreadMentionsPill() {
  const pill = document.getElementById('thread-mentions-pill');
  const cnt = document.getElementById('thread-mentions-pill-count');
  if (!pill || !cnt) return;
  if (!this._threadMentions) {
    try { this._threadMentions = JSON.parse(localStorage.getItem('haven_thread_mentions') || '{}'); }
    catch { this._threadMentions = {}; }
  }
  const list = (this._threadMentions[this.currentChannel] || []);
  if (list.length === 0) {
    pill.style.display = 'none';
    return;
  }
  pill.style.display = '';
  cnt.textContent = String(list.length);
  pill.title = t(list.length === 1 ? 'thread_runtime.mention_one' : 'thread_runtime.mention_other', { count: list.length });
},
_openMostRecentThreadMention() {
  if (!this._threadMentions) return;
  const list = this._threadMentions[this.currentChannel];
  if (!list || list.length === 0) return;
  const newest = list[list.length - 1];
  this._threadJumpTarget = newest.messageId;
  this._openThread(newest.parentId);
},

// The bell on a channel in the sidebar (#5766): open that channel's newest
// thread with a mention, at the reply itself. Opening a thread clears its
// mentions, so the next click opens the next one.
async _openThreadMentionFrom(code) {
  if (code !== this.currentChannel) await this.switchChannel(code);
  this._openMostRecentThreadMention();
},

// After a thread loads: bring the reply that mentioned you into view.
_threadJumpToMention() {
  const id = this._threadJumpTarget;
  this._threadJumpTarget = null;
  if (!id) return;
  const el = document.querySelector(`#thread-messages [data-msg-id="${Number(id)}"]`);
  if (!el) return;
  el.scrollIntoView({ block: 'center' });
  el.classList.add('highlight-flash');
  setTimeout(() => el.classList.remove('highlight-flash'), 2000);
},

// The avatar shape class for a sender's own shape, as the channel uses it.
_threadAvatarShape(shape) {
  return ['circle', 'rounded', 'squircle', 'hex', 'diamond', 'square'].includes(shape) ? ` avatar-${shape}` : ' avatar-circle';
},

// Clicking the thread that is already open closes it.
_toggleThread(parentId) {
  const panel = document.getElementById('thread-panel');
  const open = panel && panel.style.display !== 'none' && String(this._activeThreadParent) === String(parentId);
  if (open) this._closeThread();
  else this._openThread(parentId);
},

_openThread(parentId) {
  // Replies picked in another thread do not carry over (app-unthread.js).
  if (this._moveSourceThread && Number(this._moveSourceThread) !== Number(parentId)) this._exitMoveSelectionMode?.();
  this._activeThreadParent = parentId;
  // Clear any pending thread mentions for this thread/channel
  this._clearThreadMentionsForParent(this.currentChannel, parentId);
  // Opening it is reading it: the "N new" marker goes (app-thread-unread.js).
  this._clearThreadUnread?.(parentId);
  // The server records the read position when it serves the thread; drop the
  // forum card's dot right away rather than on the next reload (#5641).
  if (this._forumActive && this._forumMarkTopicRead) this._forumMarkTopicRead(parentId);
  const panel = document.getElementById('thread-panel');
  if (!panel) return;
  panel.style.display = 'flex';
  panel.dataset.parentId = parentId;
  this._setThreadPiPEnabled(localStorage.getItem('haven_thread_panel_pip') === '1');
  this._syncUnthreadSelectBtn?.();
  if (this._channelBlocksPosting?.()) this._applyThreadClosed(false);

  // Request thread messages from server
  this.socket.emit('get-thread-messages', { parentId });

  // Update header
  const msgEl = document.querySelector(`[data-msg-id="${parentId}"]`);
  const author = msgEl?.querySelector('.message-author')?.textContent || t('thread_runtime.starter');
  document.getElementById('thread-panel-title').textContent = t('msg_toolbar.thread');
  document.getElementById('thread-parent-preview').textContent = this._threadRootPreview(msgEl?.dataset?.rawContent ?? msgEl?.querySelector('.message-content')?.textContent ?? '');

  const avatarImg = msgEl?.querySelector('.message-avatar-img');
  let avatar = null;
  // A remote avatar renders through the media proxy; take its original URL
  // so the thread header proxies it afresh instead of reusing a stale token.
  if (avatarImg) avatar = avatarImg.getAttribute('data-mp-origin') || avatarImg.getAttribute('data-mp-src') || avatarImg.getAttribute('src') || null;
  const avatarShape = msgEl?.dataset?.avatarShape || 'circle';
  const parentUserIdRaw = msgEl?.dataset?.userId;
  const parentUserId = parentUserIdRaw ? parseInt(parentUserIdRaw, 10) : null;
  this._setThreadParentHeader({ userId: parentUserId, username: author, avatar, avatarShape });
  // A forum topic opens across the chat column with a title bar; this runs
  // after the header above so the bar's title is what shows (#5659).
  this._forumApplyThreadChrome?.(parentId);

  // Focus input
  const input = document.getElementById('thread-input');
  if (input) input.focus();
},

_setThreadPiPEnabled(enabled) {
  const panel = document.getElementById('thread-panel');
  const pipBtn = document.getElementById('thread-panel-pip');
  if (!panel || !pipBtn) return;

  const isOn = !!enabled;
  panel.classList.toggle('pip', isOn);
  pipBtn.textContent = isOn ? '▣' : '⧉';
  pipBtn.title = t(isOn ? 'thread_runtime.dock_panel' : 'thread_runtime.pop_out');
  pipBtn.setAttribute('aria-pressed', isOn ? 'true' : 'false');
  localStorage.setItem('haven_thread_panel_pip', isOn ? '1' : '0');

  if (isOn) {
    // With no saved size, the pop-out starts at the docked panel's size.
    this._threadPiPDefaults = { width: panel.offsetWidth || 420, height: panel.offsetHeight || 460 };
    this._applyThreadPiPGeometry(panel);
  } else {
    panel.style.height = '';
    panel.style.left = '';
    panel.style.top = '';
    panel.style.right = '';
    panel.style.bottom = '';
  }
},

_toggleThreadPiP() {
  const panel = document.getElementById('thread-panel');
  if (!panel) return;
  this._setThreadPiPEnabled(!panel.classList.contains('pip'));
},

// A closed forum topic takes no replies, except from moderators and admins
// (the server checks the same). Everyone sees why; those who may still reply
// keep the box.
_applyThreadClosed(closed) {
  const panel = document.getElementById('thread-panel');
  const note = document.getElementById('thread-closed-note');
  const text = document.getElementById('thread-closed-text');
  const canReply = !!(this.user?.isAdmin || this._hasPerm?.('delete_message'));
  const readOnly = !!this._channelBlocksPosting?.();
  panel?.classList.toggle('thread-locked', readOnly || (!!closed && !canReply));
  if (note) note.style.display = closed || readOnly ? '' : 'none';
  if (text) text.textContent = readOnly ? t('thread_runtime.read_only_no_replies') : closed ? t(canReply ? 'forum.closed_you_can_reply' : 'forum.closed_no_replies') : '';
},

_closeThread() {
  // Replies picked in it went with the panel (app-unthread.js).
  if (this._moveSourceThread) this._exitMoveSelectionMode?.();
  this._activeThreadParent = null;
  this._clearThreadReply();
  const panel = document.getElementById('thread-panel');
  if (panel) {
    panel.style.display = 'none';
    panel.dataset.parentId = '';
  }
  // Closed means stopped: a video or embed left in the hidden panel kept
  // playing (#5690). Opening a thread fetches and redraws it anyway.
  const threadMsgs = document.getElementById('thread-messages');
  if (threadMsgs) threadMsgs.innerHTML = '';
  this._forumApplyThreadChrome?.(null);
  this._forumBlogClose?.();
},

_sendThreadMessage() {
  const input = document.getElementById('thread-input');
  if (!input) return;
  const content = input.value.trim();
  const parentId = this._activeThreadParent;
  if (!parentId) return;
  if (this._channelBlocksPosting?.()) return this._showToast?.(t('thread_runtime.read_only_no_replies'), 'error');
  const hasPending = !!(this._threadPending && this._threadPending.length);
  // Nothing to send: no text and no held attachments.
  if (!content && !hasPending) return;
  const replyTo = this._threadReplyingTo ? this._threadReplyingTo.id : (this._forumBlogDefaultReply?.() || null);

  // Text and attachments sent together are one reply (#5799), except in a
  // blog, where each file is a piece of its own.
  if (content && hasPending && !this._forumBlogOn?.(this.currentChannel)) {
    this._lastSendDraft = { text: input.value, code: parentId, at: Date.now(), inputId: 'thread-input' };
    input.value = '';
    this._flushThreadPending?.(parentId, { text: content, replyTo });
    this._clearThreadReply();
    return;
  }

  if (content) {
    // Kept so a reply refused as too long comes back to the box (#5691).
    this._lastSendDraft = { text: input.value, code: parentId, at: Date.now(), inputId: 'thread-input' };
    this.socket.emit('send-thread-message', { parentId, content, replyTo, ...this._forumBlogSendExtras?.(parentId, replyTo) }, (resp) => {
      if (resp && resp.error) {
        this._showToast(resp.error, 'error');
        return;
      }
      this._clearThreadReply();
    });
    input.value = '';
  }

  // Flush any pasted/dropped attachments that were held until now.
  if (hasPending) {
    this._flushThreadPending?.(parentId);
    if (!content) this._clearThreadReply();
  }
},

_appendThreadMessage(msg, opts = {}) {
  const container = document.getElementById('thread-messages');
  if (!container) return;
  // Where the reader was before this reply went in (app-thread-scroll.js).
  const gapBefore = container.scrollHeight - container.scrollTop - container.clientHeight;
  // In a blog-mode forum a reply goes to the post's own section or to the
  // comments under it (#5742); otherwise straight into the thread.
  const target = this._forumBlogTargetFor?.(msg) || container;

  // Apply the local user's nickname assignment so thread messages match
  // everywhere else nicknames are honored. (#5291)
  const displayName = this._getNickname?.(msg.user_id, msg.username) || msg.username;
  const color = this._getUserColor(msg.username);
  const initial = this._escapeHtml(displayName.charAt(0).toUpperCase());
  // Author name in role colors, as in the channel itself.
  const authorRole = this._chatNameRole(msg.user_id);
  const authorColor = authorRole ? this._roleLook(authorRole).c1 : color;
  const shape = this._threadAvatarShape(msg.avatar_shape);
  let avatarHtml;
  if (msg.avatar) {
    avatarHtml = `<img class="thread-msg-avatar${shape}" ${this._imgSrcAttr(msg.avatar)} alt="${initial}">`;
  } else {
    avatarHtml = `<div class="thread-msg-avatar thread-msg-avatar-initial${shape}" style="background:${color}">${initial}</div>`;
  }

  const reactionsHtml = this._renderReactions(msg.id, msg.reactions || []);
  // Some clients send every thread reply as a reply to the thread's own
  // first message; in the thread that says nothing, so no banner. A blog
  // keeps it: there it is a comment on the post's first picture (#5753).
  const toRoot = this._isThreadRootReply(msg);
  const replyHtml = msg.replyContext && !toRoot ? this._renderReplyBanner(msg.replyContext) : '';
  const canDelete = msg.user_id === this.user.id || this.user.isAdmin || this._canModerate();
  const canEdit = msg.user_id === this.user.id;
  const iconPair = (emoji, monoSvg) => `<span class="tb-icon tb-icon-emoji" aria-hidden="true">${emoji}</span><span class="tb-icon tb-icon-mono" aria-hidden="true">${monoSvg}</span>`;
  const iReact = iconPair('😀', '<svg class="thread-action-react-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke-width="1.8"></circle><path d="M8.5 14.5c1 1.2 2.2 1.8 3.5 1.8s2.5-.6 3.5-1.8" stroke-width="1.8" stroke-linecap="round"></path><circle cx="9.2" cy="10.2" r="1" fill="currentColor" stroke="none"></circle><circle cx="14.8" cy="10.2" r="1" fill="currentColor" stroke="none"></circle></svg>');
  const iReply = iconPair('↩️', '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 8L4 12L10 16" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path><path d="M20 12H5" stroke-width="1.8" stroke-linecap="round"></path></svg>');
  const iQuote = iconPair('💬', '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 7H5v6h4l-2 4" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path><path d="M19 7h-4v6h4l-2 4" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path></svg>');
  const iEdit = iconPair('✏️', '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20l4.5-1 9-9-3.5-3.5-9 9L4 20z" stroke-width="1.8" stroke-linejoin="round"></path><path d="M13.5 6.5l3.5 3.5" stroke-width="1.8" stroke-linecap="round"></path></svg>');
  const iDelete = iconPair('🗑️', '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14" stroke-width="1.8" stroke-linecap="round"></path><path d="M9 7V5h6v2" stroke-width="1.8" stroke-linecap="round"></path><path d="M7 7l1 12h8l1-12" stroke-width="1.8" stroke-linejoin="round"></path></svg>');
  const iMore = iconPair('⋯', '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="12" r="1.6" fill="currentColor" stroke="none"></circle><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"></circle><circle cx="18" cy="12" r="1.6" fill="currentColor" stroke="none"></circle></svg>');
  const threadCoreToolbarBtns = `<button data-thread-action="react" title="${t('msg_toolbar.react')}" aria-label="${t('msg_toolbar.react')}">${iReact}</button><button data-thread-action="reply" title="${t('msg_toolbar.reply')}">${iReply}</button><button data-thread-action="quote" title="${t('msg_toolbar.quote')}">${iQuote}</button>`;
  let threadOverflowToolbarBtns = '';
  // NSFW mark (app-message-nsfw.js): your own reply, or anyone's you could delete.
  if (canEdit || this.user.isAdmin || this._canModerate() || this._hasPerm?.('delete_message')) {
    const iNsfw = iconPair('🔞', '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6z" stroke-width="1.8" stroke-linejoin="round"></path><circle cx="12" cy="12" r="2.5" stroke-width="1.8"></circle><path d="M4 4l16 16" stroke-width="1.8" stroke-linecap="round"></path></svg>');
    threadOverflowToolbarBtns += msg.nsfw
      ? `<button data-thread-action="unnsfw" title="${t('msg_toolbar.unmark_nsfw')}">${iNsfw}</button>`
      : `<button data-thread-action="nsfw" title="${t('msg_toolbar.mark_nsfw')}">${iNsfw}</button>`;
  }
  if (canEdit) threadOverflowToolbarBtns += `<button data-thread-action="edit" title="${t('msg_toolbar.edit')}">${iEdit}</button>`;
  if (canDelete) threadOverflowToolbarBtns += `<button data-thread-action="delete" title="${t('msg_toolbar.delete')}">${iDelete}</button>`;
  const threadOverflowHtml = threadOverflowToolbarBtns
    ? `<div class="thread-msg-more"><button class="thread-msg-more-btn" type="button" aria-label="${t('app.actions.message_actions')}">${iMore}</button><div class="thread-msg-overflow">${threadOverflowToolbarBtns}</div></div>`
    : '';

  // Group consecutive replies from the same author (within 5 min, no reply
  // banner) into compact rows, the same way the main channel does, and drop the
  // avatar and author header, keep the content and the hover toolbar. The
  // thread's parent message lives in a separate preview element, not in this
  // container, so we only ever group reply-against-reply.
  let threadCompact = false;
  const prevEl = target.lastElementChild;
  // The author's additions to a blog post read as more of the post, with no
  // name header of their own (#5742).
  if (this._forumBlogIsPart?.(msg)) {
    threadCompact = true;
  } else if (prevEl && prevEl.classList?.contains('thread-message') && (!msg.reply_to || toRoot)) {
    // The same rule as the channel (message-grouping.js). A reply to the
    // thread's own first message counts as a plain message here.
    threadCompact = this._groupsWithPrevious(this._groupInfoFromElement(prevEl), toRoot ? { ...msg, reply_to: null } : msg);
  }

  // A reply's picture shows its tags like a chat message does (#5682).
  const threadTagsHtml = this._renderAttachmentTags ? this._renderAttachmentTags(msg.attachmentTags) : '';
  const el = document.createElement('div');
  el.className = 'thread-message' + (threadCompact ? ' thread-compact' : '');
  el.dataset.msgId = msg.id;
  el.dataset.rawContent = msg.content;
  el.dataset.userId = msg.user_id;
  el.dataset.time = msg.created_at;
  // Stash the raw username + avatar so a compact row can be promoted back to a
  // full row (with the header restored) if the group head above it is deleted,
  // and so reply/quote can resolve the author on compact rows that have no
  // `.thread-msg-author` element.
  el.dataset.username = msg.username || '';
  if (msg.avatar) el.dataset.avatar = msg.avatar;
  if (msg.avatar_shape) el.dataset.avatarShape = msg.avatar_shape;
  if (msg.persona_id) el.dataset.personaId = String(msg.persona_id);
  this._stampGroupSource(el, msg);
  if (msg.silent) el.dataset.silent = '1';
  const silentHtml = this._silentTagHtml?.(msg) || '';
  if (threadCompact) {
    const shortTime = this._fmtTime(msg.created_at);
    el.innerHTML = `
      <div class="thread-msg-row">
        <div class="thread-msg-avatar thread-msg-compact-spacer"><span class="thread-compact-time">${this._escapeHtml(shortTime)}</span></div>
        <div class="thread-msg-body">
          <div class="thread-msg-toolbar">
            <div class="msg-toolbar-group">${threadCoreToolbarBtns}</div>
            ${threadOverflowHtml}
          </div>
          <div class="thread-msg-content">${this._formatContent(msg.content)}${silentHtml}</div>
          ${reactionsHtml}${threadTagsHtml}
        </div>
      </div>
    `;
  } else {
    el.innerHTML = `
      <div class="thread-msg-row">
        ${avatarHtml}
        <div class="thread-msg-body">
          <div class="thread-msg-header">
            <span class="thread-msg-author" style="color:${authorColor}">${this._roleNameHtml(authorRole, displayName)}</span>
            <span class="thread-msg-time"${this._timeAttr(msg.created_at)}>${this._formatTime(msg.created_at)}</span>
            <span class="thread-msg-header-spacer"></span>
            <div class="thread-msg-toolbar">
              <div class="msg-toolbar-group">${threadCoreToolbarBtns}</div>
              ${threadOverflowHtml}
            </div>
          </div>
          ${replyHtml}
          <div class="thread-msg-content">${this._formatContent(msg.content)}${silentHtml}</div>
          ${reactionsHtml}${threadTagsHtml}
        </div>
      </div>
    `;
  }
  if (msg.nsfw) this._applyMessageNsfw?.(el, true);
  target.appendChild(el);
  if (target !== container) this._forumBlogRecount?.();
  // Link cards in threads, the same as in the channel (#5620).
  this._fetchLinkPreviews(el);
  try { this._decryptE2EImages?.(el); } catch (err) { console.warn('[Thread] _decryptE2EImages failed', err); }
  try { this._decryptE2EFiles?.(el); } catch (err) { console.warn('[Thread] _decryptE2EFiles failed', err); }
  try { if (this._isDmContainer(el)) this._enforceDmLinkPolicy?.(el); } catch (err) { console.warn('[Thread] _enforceDmLinkPolicy failed', err); }
  try { this._setupVideos?.(el); } catch (err) { console.warn('[Thread] _setupVideos failed', err); }
  // Loading the thread lands at its end; a reply arriving later moves the
  // view only for a reader who is already there.
  if (opts.live && this._threadAfterLiveReply) this._threadAfterLiveReply(container, gapBefore, msg);
  else container.scrollTop = container.scrollHeight;
},

// Up in the empty reply box: edit your newest reply in the open thread,
// docked or popped out. Returns whether there was one to edit.
_editLastThreadMessage() {
  const box = document.getElementById('thread-messages');
  if (!box || !this.user) return false;
  const mine = [...box.querySelectorAll('.thread-message')]
    .filter(el => parseInt(el.dataset.userId, 10) === this.user.id && !el.classList.contains('editing'));
  const el = mine[mine.length - 1];
  if (!el) return false;
  this._startEditMessage(el, parseInt(el.dataset.msgId, 10));
  el.scrollIntoView({ block: 'nearest' });
  return true;
},

// The line under a thread's header, and its row in the Threads list:
// pictures and files by name, as reply lines show them, never the address
// they are stored under.
_threadRootPreview(content, max = 120) {
  const text = this._replyPreviewText ? this._replyPreviewText(content) : String(content || '');
  return text.length > max ? text.substring(0, max) + '…' : text;
},

// Whether a thread reply answers the thread's own first message.
_isThreadRootReply(msg) {
  if (!msg || msg.reply_to == null || this._forumBlogThread) return false;
  const root = msg.thread_id != null ? msg.thread_id : this._activeThreadParent;
  return root != null && Number(msg.reply_to) === Number(root);
},

// Promote a compact thread reply back to a full row (avatar + author header
// restored), keeping its existing content/toolbar/reactions. Called when the
// group head above it is deleted, so the new head still shows who sent it.
// This is the thread mirror of `_promoteCompactToFull`.
_promoteThreadCompactToFull(compactEl) {
  if (!compactEl) return;
  const userId = parseInt(compactEl.dataset.userId, 10);
  const rawUsername = compactEl.dataset.username || t('app.messages.unknown_user');
  const displayName = this._getNickname?.(userId, rawUsername) || rawUsername;
  const time = compactEl.dataset.time;
  const color = this._getUserColor(rawUsername);
  const initial = this._escapeHtml((displayName || '?').charAt(0).toUpperCase());
  const authorRole = this._chatNameRole(userId);
  const authorColor = authorRole ? this._roleLook(authorRole).c1 : color;

  // Preserve the already-rendered content, toolbar, and reactions.
  const contentHtml = compactEl.querySelector('.thread-msg-content')?.innerHTML || '';
  const toolbarHtml = compactEl.querySelector('.thread-msg-toolbar')?.outerHTML || '';
  const reactionsHtml = compactEl.querySelector('.reactions-row')?.outerHTML || '';

  // Avatar: stored at render time, else the online/member list, else initial.
  const onlineUser = this._memberById(userId);
  const avatar = compactEl.dataset.avatar || (onlineUser && onlineUser.avatar) || null;
  const shape = this._threadAvatarShape(compactEl.dataset.avatarShape || (onlineUser && onlineUser.avatarShape));
  const avatarHtml = avatar
    ? `<img class="thread-msg-avatar${shape}" ${this._imgSrcAttr(avatar)} alt="${initial}">`
    : `<div class="thread-msg-avatar thread-msg-avatar-initial${shape}" style="background:${color}">${initial}</div>`;

  compactEl.classList.remove('thread-compact');
  compactEl.innerHTML = `
    <div class="thread-msg-row">
      ${avatarHtml}
      <div class="thread-msg-body">
        <div class="thread-msg-header">
          <span class="thread-msg-author" style="color:${authorColor}">${this._roleNameHtml(authorRole, displayName)}</span>
          <span class="thread-msg-time"${this._timeAttr(time)}>${this._formatTime(time)}</span>
          <span class="thread-msg-header-spacer"></span>
          ${toolbarHtml}
        </div>
        <div class="thread-msg-content">${contentHtml}</div>
        ${reactionsHtml}
      </div>
    </div>
  `;
},

_updateThreadPreview(parentId, thread) {
  const msgEl = document.querySelector(`[data-msg-id="${parentId}"]`);
  if (!msgEl) return;
  if (msgEl.classList.contains('forum-topic')) { this._forumBump && this._forumBump(parentId, thread); return; }
  const oldPreview = msgEl.querySelector('.thread-preview');
  const ch = this.channels && this.channels.find(c => c.code === this.currentChannel);
  const newHtml = this._renderThreadPreview(parentId, thread, { forum: !!(ch && ch.is_forum) });
  if (oldPreview) {
    oldPreview.outerHTML = newHtml;
  } else if (newHtml) {
    // Insert after reactions row, or after message-content
    const reactions = msgEl.querySelector('.reactions-row');
    const content = msgEl.querySelector('.message-content');
    const insertAfter = reactions || content;
    if (insertAfter) insertAfter.insertAdjacentHTML('afterend', newHtml);
  }
},

};
