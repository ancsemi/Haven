// Thread replies you have not seen, and which of them make a sound.
//
// Every reply in a channel reaches everyone in it, so a busy thread could
// ping people who never looked at it, with nothing on screen to say where
// the noise came from. Now:
//  - a reply makes a sound only for those taking part in the thread (they
//    started it, replied in it, or have it open), or when it mentions you or
//    answers one of your messages; muting a forum topic takes you out
//  - the thread's chip under its message shows a dot and "N new", the
//    channel's Threads button shows how many threads have news, and a channel
//    in the sidebar gets a dot for news in a thread you take part in
//  - opening the thread clears it, here and on your other devices
// Forum topics keep their own dots (app-forum-unread.js); only the sound
// rule applies to them. The server names who takes part (src/threadNotify.js).

export default {

// Which sound a thread reply makes, or null. `quiet` is the server and member
// mutes (app-server-mute.js), which already let mentions through when set to.
_threadReplySound({ mine = false, channelMuted = false, quiet = false, isMention = false, isReplyToMe = false, followed = false, open = false } = {}) {
  if (mine || channelMuted || quiet) return null;
  if (isMention) return 'mention';
  if (isReplyToMe) return 'reply';
  if (followed || open) return 'message';
  return null;
},

_setupThreadUnread() {
  if (!this._threadUnread) this._threadUnread = new Map();
  // Opened on another device: the news is read here too, and the mention
  // bell for that thread goes quiet.
  this.socket.on('thread-read', (data) => {
    if (data && data.parentId != null) {
      this._clearThreadUnread(data.parentId);
      if (data.channelCode) this._clearThreadMentionsForParent?.(data.channelCode, Number(data.parentId));
    }
  });
  // This device was closed when a thread was read elsewhere: drop the
  // mentions it remembers that are already read, on every (re)connect.
  this.socket.on('connect', () => this._pruneReadThreadMentions?.());
  this._pruneReadThreadMentions?.();
},

_threadIsOpen(parentId) {
  const panel = document.getElementById('thread-panel');
  return !!panel && panel.style.display !== 'none' && String(this._activeThreadParent) === String(parentId);
},

_isForumCode(code) {
  return !!this.channels?.find(c => c.code === code && c.is_forum);
},

// A reply landed (new-thread-message): sound, notification and markers.
_onThreadReply(data) {
  const msg = data && data.message;
  if (!msg || !this.user) return;
  const parentId = Number(data.parentId);
  const code = data.channelCode;
  const mine = msg.user_id != null && msg.user_id === this.user.id;
  if (mine) return;
  let mutedChs = [];
  try { mutedChs = JSON.parse(localStorage.getItem('haven_muted_channels') || '[]'); } catch (err) { console.warn('[Thread] could not read muted channels', err); }
  const channelMuted = mutedChs.includes(code);
  const content = msg.content || '';
  const meEsc = (this.user.username || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const isMention = (!!meEsc && new RegExp(`@${meEsc}(?!\\w)`, 'i').test(content))
    || /(?<![\w@])@(everyone|here)\b/i.test(content)
    || !!this._mentionsMyRole?.(content);
  // Someone starting a thread on your message counts as a reply to you.
  const isReplyToMe = !!(msg.replyContext && msg.replyContext.user_id === this.user.id)
    || data.threadStartedFor === this.user.id;
  const followed = Array.isArray(data.followerIds) && data.followerIds.includes(this.user.id);
  const open = this._threadIsOpen(parentId);
  // A silent reply (app-silent.js) still marks the thread, but makes no sound.
  const quiet = !!msg.silent || !!this._notifyBlockedByMutes?.({ senderId: msg.user_id, isDm: false, isMention });
  const sound = this._threadReplySound({ channelMuted, quiet, isMention, isReplyToMe, followed, open });

  // The bell in the header and the sidebar, unless the thread is on screen.
  if ((isMention || isReplyToMe) && !channelMuted && !open) this._recordThreadMention(code, parentId, msg);
  if (sound) {
    const opts = sound === 'mention' ? { isMention: true } : sound === 'reply' ? { isReply: true } : undefined;
    this.notifications.play(sound, opts);
    if (document.hidden) this._fireNativeNotification({ ...msg, content: `[thread] ${content}` }, code, opts);
  }

  if (this._isForumCode(code)) return;
  if (open) {
    // Seen as it arrived: keep it read after a reload and on other devices.
    this.socket.emit('mark-thread-read', { parentId });
    return;
  }
  const entry = this._threadUnread.get(parentId) || { code, count: 0, followed: false };
  entry.count += 1;
  entry.followed = entry.followed || followed || isMention || isReplyToMe;
  this._threadUnread.set(parentId, entry);
  this._paintThreadUnread(parentId);
},

// How many replies in this thread are new to you. A count from the server
// (the threads you follow) is the truth and replaces the one kept here.
_threadNewCount(parentId, thread) {
  const id = Number(parentId);
  if (!this._threadUnread) this._threadUnread = new Map();
  if (thread && typeof thread.newCount === 'number') {
    if (thread.newCount > 0) {
      const prev = this._threadUnread.get(id);
      this._threadUnread.set(id, { code: this.currentChannel, count: thread.newCount, followed: true, ...(prev ? { code: prev.code } : {}) });
    } else {
      this._threadUnread.delete(id);
    }
    return thread.newCount;
  }
  return this._threadUnread.get(id)?.count || 0;
},

// The "N new" marker inside a thread chip.
_threadChipNewHtml(count) {
  if (!count) return '';
  const label = t(count === 1 ? 'thread_runtime.new_one' : 'thread_runtime.new_other', { count: count > 99 ? '99+' : count });
  return `<span class="thread-preview-new"><span class="thread-new-dot" aria-hidden="true"></span>${this._escapeHtml(label)}</span>`;
},

_clearThreadUnread(parentId) {
  const id = Number(parentId);
  if (!this._threadUnread || !this._threadUnread.has(id)) return;
  const code = this._threadUnread.get(id).code;
  this._threadUnread.delete(id);
  this._paintThreadUnread(id, code);
},

// Brings every marker for one thread up to date.
_paintThreadUnread(parentId, code) {
  const id = Number(parentId);
  const entry = this._threadUnread?.get(id);
  const chCode = entry ? entry.code : code;
  const chip = document.querySelector(`#messages .thread-preview[data-thread-parent="${id}"]`);
  if (chip) {
    chip.querySelector('.thread-preview-new')?.remove();
    const html = this._threadChipNewHtml(entry ? entry.count : 0);
    chip.classList.toggle('thread-preview-has-new', !!html);
    if (html) (chip.querySelector('.thread-preview-count') || chip.lastElementChild)?.insertAdjacentHTML('afterend', html);
  }
  this._updateThreadsButtonBadge();
  if (chCode) this._updateThreadDot(chCode);
},

// Chips are drawn many at a time with a channel; the button is counted once
// they are all in.
_queueThreadsBadge() {
  if (this._threadsBadgeQueued) return;
  this._threadsBadgeQueued = true;
  setTimeout(() => { this._threadsBadgeQueued = false; this._paintThreadDots(); }, 0);
},

// The channel header's Threads button: how many threads here have news.
_updateThreadsButtonBadge() {
  const btn = document.getElementById('threads-toggle-btn');
  if (!btn) return;
  let n = 0;
  for (const e of (this._threadUnread || new Map()).values()) if (e.code === this.currentChannel && e.count > 0) n++;
  let badge = btn.querySelector('.threads-btn-badge');
  if (!n) { badge?.remove(); btn.classList.remove('threads-btn-has-new'); return; }
  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'threads-btn-badge';
    btn.appendChild(badge);
  }
  btn.classList.add('threads-btn-has-new');
  badge.textContent = n > 9 ? '9+' : String(n);
  badge.title = t(n === 1 ? 'thread_runtime.threads_new_one' : 'thread_runtime.threads_new_other', { count: n });
},

// A dot on the channel in the sidebar while a thread you take part in has
// replies you have not seen. Forums have their own; a muted channel none.
_updateThreadDot(code, el = null) {
  el = el || document.querySelector(`.channel-item[data-code="${code}"]`);
  if (!el) return;
  let muted = false;
  try { muted = JSON.parse(localStorage.getItem('haven_muted_channels') || '[]').includes(code); } catch (err) { console.warn('[Thread] could not read muted channels', err); }
  let any = false;
  for (const e of (this._threadUnread || new Map()).values()) if (e.code === code && e.followed && e.count > 0) { any = true; break; }
  const show = any && !muted && !this._isForumCode(code);
  let dot = el.querySelector('.channel-thread-dot');
  if (show && !dot) {
    dot = document.createElement('span');
    dot.className = 'channel-thread-dot';
    dot.title = t('thread_runtime.sidebar_unread');
    el.appendChild(dot);
  } else if (!show && dot) {
    dot.remove();
  }
},

// After the sidebar or the channel is drawn again.
_paintThreadDots() {
  const codes = new Set();
  for (const e of (this._threadUnread || new Map()).values()) codes.add(e.code);
  document.querySelectorAll('.channel-thread-dot').forEach(d => codes.add(d.closest('.channel-item')?.dataset.code));
  codes.forEach(c => c && this._updateThreadDot(c));
  this._updateThreadsButtonBadge();
},

// The marker on a row of the Threads list. Pointed at, it turns into a
// "Mark read" button (both labels share one spot so the row does not shift).
_threadListNewHtml(th) {
  const n = this._threadNewCount(th.id, typeof th.new_count === 'number' ? { newCount: th.new_count } : null);
  this._queueThreadsBadge();
  if (!n) return '';
  const mark = this._escapeHtml(t('thread_list.mark_read'));
  return `<button type="button" class="thread-list-new" data-mark-read="${Number(th.id)}" title="${mark}" aria-label="${mark}">`
    + `<span class="thread-list-new-count">${this._threadChipNewHtml(n)}</span>`
    + `<span class="thread-list-new-mark thread-preview-new" aria-hidden="true">${mark}</span></button>`;
},

// "Mark read" on a row of the Threads list: the thread's news is cleared
// here, on the server, and on your other devices, without opening it.
_markThreadListRead(parentId) {
  const id = Number(parentId);
  if (!id) return;
  const th = (this._threadListData || []).find(x => Number(x.id) === id);
  const code = this._threadUnread?.get(id)?.code || this.currentChannel;
  if (th && typeof th.new_count === 'number') th.new_count = 0;
  this.socket.emit('mark-thread-read', { parentId: id });
  this._clearThreadUnread(id);
  if (this._isForumCode(code)) this._requestForumUnread?.(code);
  const search = document.getElementById('threads-list-search');
  this._renderThreadList?.(search ? search.value : '');
},

};
