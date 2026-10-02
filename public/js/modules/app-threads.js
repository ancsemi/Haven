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
    if (p.avatar) {
      return `<img class="thread-participant-avatar" src="${this._escapeHtml(p.avatar)}" alt="${this._escapeHtml(p.username)}" title="${this._escapeHtml(p.username)}">`;
    }
    const color = this._getUserColor(p.username);
    const initial = p.username.charAt(0).toUpperCase();
    return `<div class="thread-participant-avatar thread-participant-initial" style="background:${color}" title="${this._escapeHtml(p.username)}">${initial}</div>`;
  }).join('');

  const timeAgo = this._relativeTime(thread.lastReplyAt);
  return `
    <button class="thread-preview" data-thread-parent="${parentId}">
      ${participantAvatars}
      <span class="thread-preview-count">${t(thread.count === 1 ? 'thread_runtime.reply_one' : 'thread_runtime.reply_other', { count: thread.count })}</span>
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
  const shape = (meta.avatarShape || 'circle') === 'square' ? 'square' : 'circle';
  const shapeClass = shape === 'square' ? ' thread-parent-avatar-square' : '';

  if (meta.avatar) {
    wrap.innerHTML = `<img class="thread-parent-avatar${shapeClass}" src="${this._escapeHtml(meta.avatar)}" alt="${this._escapeHtml(username)}">`;
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
  this._openThread(newest.parentId);
},

_openThread(parentId) {
  this._activeThreadParent = parentId;
  // Clear any pending thread mentions for this thread/channel
  this._clearThreadMentionsForParent(this.currentChannel, parentId);
  // The server records the read position when it serves the thread; drop the
  // forum card's dot right away rather than on the next reload (#5641).
  if (this._forumActive && this._forumMarkTopicRead) this._forumMarkTopicRead(parentId);
  const panel = document.getElementById('thread-panel');
  if (!panel) return;
  panel.style.display = 'flex';
  panel.dataset.parentId = parentId;
  this._setThreadPiPEnabled(localStorage.getItem('haven_thread_panel_pip') === '1');

  // Request thread messages from server
  this.socket.emit('get-thread-messages', { parentId });

  // Update header
  const msgEl = document.querySelector(`[data-msg-id="${parentId}"]`);
  const author = msgEl?.querySelector('.message-author')?.textContent || t('thread_runtime.starter');
  document.getElementById('thread-panel-title').textContent = t('msg_toolbar.thread');
  const parentPreview = msgEl?.querySelector('.message-content')?.textContent || '';
  document.getElementById('thread-parent-preview').textContent = parentPreview.length > 120 ? parentPreview.substring(0, 120) + '…' : parentPreview;

  const avatarImg = msgEl?.querySelector('.message-avatar-img');
  let avatar = null;
  if (avatarImg && avatarImg.getAttribute('src')) avatar = avatarImg.getAttribute('src');
  const avatarShape = (avatarImg && avatarImg.classList.contains('avatar-square')) ? 'square' : 'circle';
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
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem('haven_thread_panel_pip_rect') || 'null'); } catch { /* corrupt saved position: use the default placement */ }

    const minW = 320;
    const maxW = Math.min(760, window.innerWidth - 28);
    const minH = 240;
    const footerOffset = (() => {
      const raw = getComputedStyle(document.body).getPropertyValue('--thread-footer-offset');
      const v = parseInt(raw, 10);
      return Number.isFinite(v) ? v : 0;
    })();
    const maxH = Math.max(minH, window.innerHeight - footerOffset - 28);

    const width = Math.max(minW, Math.min(maxW, (saved && saved.width) || panel.offsetWidth || 420));
    const height = Math.max(minH, Math.min(maxH, (saved && saved.height) || panel.offsetHeight || 460));
    const defaultLeft = Math.max(0, window.innerWidth - width - 14);
    const defaultTop = Math.max(0, window.innerHeight - footerOffset - height - 14);
    const left = Math.max(0, Math.min(window.innerWidth - width, (saved && Number.isFinite(saved.left)) ? saved.left : defaultLeft));
    const top = Math.max(0, Math.min(window.innerHeight - footerOffset - height, (saved && Number.isFinite(saved.top)) ? saved.top : defaultTop));

    panel.style.width = `${Math.round(width)}px`;
    panel.style.height = `${Math.round(height)}px`;
    panel.style.left = `${Math.round(left)}px`;
    panel.style.top = `${Math.round(top)}px`;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
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

_closeThread() {
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
},

_sendThreadMessage() {
  const input = document.getElementById('thread-input');
  if (!input) return;
  const content = input.value.trim();
  const parentId = this._activeThreadParent;
  if (!parentId) return;
  const hasPending = !!(this._threadPending && this._threadPending.length);
  // Nothing to send — no text and no held attachments.
  if (!content && !hasPending) return;
  const replyTo = this._threadReplyingTo ? this._threadReplyingTo.id : null;

  if (content) {
    // Kept so a reply refused as too long comes back to the box (#5691).
    this._lastSendDraft = { text: input.value, code: parentId, at: Date.now(), inputId: 'thread-input' };
    this.socket.emit('send-thread-message', { parentId, content, replyTo }, (resp) => {
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

_appendThreadMessage(msg) {
  const container = document.getElementById('thread-messages');
  if (!container) return;

  // Apply the local user's nickname assignment so thread messages match
  // everywhere else nicknames are honored. (#5291)
  const displayName = this._getNickname?.(msg.user_id, msg.username) || msg.username;
  const color = this._getUserColor(msg.username);
  const initial = displayName.charAt(0).toUpperCase();
  // Author name in role colors, as in the channel itself.
  const authorRole = this._chatNameRole(msg.user_id);
  const authorColor = authorRole ? this._roleLook(authorRole).c1 : color;
  let avatarHtml;
  if (msg.avatar) {
    avatarHtml = `<img class="thread-msg-avatar" src="${this._escapeHtml(msg.avatar)}" alt="${initial}">`;
  } else {
    avatarHtml = `<div class="thread-msg-avatar thread-msg-avatar-initial" style="background:${color}">${initial}</div>`;
  }

  const reactionsHtml = this._renderReactions(msg.id, msg.reactions || []);
  const replyHtml = msg.replyContext ? this._renderReplyBanner(msg.replyContext) : '';
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
  if (canEdit) threadOverflowToolbarBtns += `<button data-thread-action="edit" title="${t('msg_toolbar.edit')}">${iEdit}</button>`;
  if (canDelete) threadOverflowToolbarBtns += `<button data-thread-action="delete" title="${t('msg_toolbar.delete')}">${iDelete}</button>`;
  const threadOverflowHtml = threadOverflowToolbarBtns
    ? `<div class="thread-msg-more"><button class="thread-msg-more-btn" type="button" aria-label="${t('app.actions.message_actions')}">${iMore}</button><div class="thread-msg-overflow">${threadOverflowToolbarBtns}</div></div>`
    : '';

  // Group consecutive replies from the same author (within 5 min, no reply
  // banner) into compact rows, the same way the main channel does — drop the
  // avatar and author header, keep the content and the hover toolbar. The
  // thread's parent message lives in a separate preview element, not in this
  // container, so we only ever group reply-against-reply.
  let threadCompact = false;
  const prevEl = container.lastElementChild;
  if (prevEl && prevEl.classList?.contains('thread-message') && !msg.reply_to) {
    const samePerson = parseInt(prevEl.dataset.userId, 10) === msg.user_id
      && (prevEl.dataset.personaId || '') === (msg.persona_id ? String(msg.persona_id) : '');
    const prevTime = prevEl.dataset.time ? new Date(prevEl.dataset.time).getTime() : 0;
    const within = prevTime && (new Date(msg.created_at).getTime() - prevTime) < 5 * 60 * 1000;
    threadCompact = samePerson && within;
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
  if (msg.persona_id) el.dataset.personaId = String(msg.persona_id);
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
          <div class="thread-msg-content">${this._formatContent(msg.content)}</div>
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
          <div class="thread-msg-content">${this._formatContent(msg.content)}</div>
          ${reactionsHtml}${threadTagsHtml}
        </div>
      </div>
    `;
  }
  container.appendChild(el);
  // Link cards in threads, the same as in the channel (#5620).
  this._fetchLinkPreviews(el);
  try { this._decryptE2EImages?.(el); } catch (err) { console.warn('[Thread] _decryptE2EImages failed', err); }
  try { this._decryptE2EFiles?.(el); } catch (err) { console.warn('[Thread] _decryptE2EFiles failed', err); }
  try { if (this._isDmContainer(el)) this._enforceDmLinkPolicy?.(el); } catch (err) { console.warn('[Thread] _enforceDmLinkPolicy failed', err); }
  try { this._setupVideos?.(el); } catch (err) { console.warn('[Thread] _setupVideos failed', err); }
  container.scrollTop = container.scrollHeight;
},

// Promote a compact thread reply back to a full row (avatar + author header
// restored), keeping its existing content/toolbar/reactions. Called when the
// group head above it is deleted, so the new head still shows who sent it —
// the thread mirror of `_promoteCompactToFull`.
_promoteThreadCompactToFull(compactEl) {
  if (!compactEl) return;
  const userId = parseInt(compactEl.dataset.userId, 10);
  const rawUsername = compactEl.dataset.username || t('app.messages.unknown_user');
  const displayName = this._getNickname?.(userId, rawUsername) || rawUsername;
  const time = compactEl.dataset.time;
  const color = this._getUserColor(rawUsername);
  const initial = (displayName || '?').charAt(0).toUpperCase();
  const authorRole = this._chatNameRole(userId);
  const authorColor = authorRole ? this._roleLook(authorRole).c1 : color;

  // Preserve the already-rendered content, toolbar, and reactions.
  const contentHtml = compactEl.querySelector('.thread-msg-content')?.innerHTML || '';
  const toolbarHtml = compactEl.querySelector('.thread-msg-toolbar')?.outerHTML || '';
  const reactionsHtml = compactEl.querySelector('.reactions-row')?.outerHTML || '';

  // Avatar: stored at render time, else the online/member list, else initial.
  const onlineUser = this._memberById(userId);
  const avatar = compactEl.dataset.avatar || (onlineUser && onlineUser.avatar) || null;
  const avatarHtml = avatar
    ? `<img class="thread-msg-avatar" src="${this._escapeHtml(avatar)}" alt="${initial}">`
    : `<div class="thread-msg-avatar thread-msg-avatar-initial" style="background:${color}">${initial}</div>`;

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
