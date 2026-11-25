// The forum's dot in the sidebar (src/forumUnread.js), and muting a single
// topic so its replies stop lighting the forum up. Replies never count as new
// channel messages, which is why a forum needs this count of its own.

export default {

_setupForumUnread() {
  this.forumUnread = {};
  this._forumUnreadTimers = new Map();
  const isForum = (code) => !!this.channels?.find(c => c.code === code && c.is_forum);

  // Registered after the app's own handler, so the sidebar is drawn by now.
  this.socket.on('channels-list', (chs) => {
    if (!Array.isArray(chs)) return;
    for (const ch of chs) {
      if (!ch.is_forum) continue;
      this.forumUnread[ch.code] = ch.forumUnread || 0;
      this._updateForumDot(ch.code);
    }
  });
  this.socket.on('forum-unread', (data) => {
    if (!data || typeof data.channelCode !== 'string') return;
    this.forumUnread[data.channelCode] = Number(data.count) || 0;
    this._updateForumDot(data.channelCode);
  });
  // Someone else replied, or started a topic: ask for a fresh count.
  // With the dot already showing, more activity cannot change that, so no
  // recount: on a busy server this is most of the replies.
  this.socket.on('thread-updated', (data) => {
    if (!data || !isForum(data.channelCode)) return;
    if (data.thread && this.user && data.thread.senderId === this.user.id) return;
    if ((this.forumUnread[data.channelCode] || 0) > 0) return;
    this._requestForumUnread(data.channelCode, true);
  });
  this.socket.on('new-message', (data) => {
    if (!data || !isForum(data.channelCode) || !data.message) return;
    if (this.user && data.message.user_id === this.user.id) return;
    if ((this.forumUnread[data.channelCode] || 0) > 0) return;
    this._requestForumUnread(data.channelCode, true);
  });
  // Read somewhere: here, in another tab, or by opening a topic.
  this.socket.on('forum-read', (data) => data && this._requestForumUnread(data.channelCode));
  this.socket.on('thread-read', (data) => data && this._requestForumUnread(data.channelCode));
  // Opening a topic marks it read; the reply does not say which forum it is
  // in, so every forum recounts (people are in one or two).
  this.socket.on('thread-messages', () => {
    Object.keys(this.forumUnread || {}).forEach(code => this._requestForumUnread(code));
  });
  this.socket.on('topic-muted', (data) => {
    if (!data) return;
    const topic = this._forumTopics && this._forumTopics.get(Number(data.topicId));
    if (!topic) return;
    topic.thread = { ...(topic.thread || {}), muted: !!data.muted };
    const el = document.querySelector(`#forum-topics [data-msg-id="${Number(data.topicId)}"]`);
    if (el && this._createForumTopicEl) el.replaceWith(this._createForumTopicEl(topic));
  });
},

// Many people get the same reply at the same moment, so their recounts are
// spread over a couple of seconds instead of arriving together.
_requestForumUnread(code, spread = false) {
  if (!code || !this.socket) return;
  clearTimeout(this._forumUnreadTimers.get(code));
  const delay = spread ? 800 + Math.random() * 2000 : 300;
  this._forumUnreadTimers.set(code, setTimeout(() => {
    this._forumUnreadTimers.delete(code);
    this.socket.emit('get-forum-unread', { code });
  }, delay));
},

// The dot sits where a channel's unread count would; a muted forum has none,
// and a forum already showing a count for new topics needs no dot as well.
_updateForumDot(code, el = null) {
  el = el || document.querySelector(`.channel-item[data-code="${code}"]`);
  if (!el) return;
  let muted = false;
  try {
    muted = this._mutedChannelList().includes(code);
  } catch (err) {
    console.warn('[Forum] could not read muted channels', err);
  }
  const hasCount = !!el.querySelector('.channel-badge:not(.channel-badge-bubble):not(.thread-mention-badge)');
  const show = !muted && !hasCount && (this.forumUnread?.[code] || 0) > 0;
  let dot = el.querySelector('.channel-forum-dot');
  if (show && !dot) {
    dot = document.createElement('span');
    dot.className = 'channel-forum-dot';
    dot.title = t('forum.sidebar_unread');
    el.appendChild(dot);
  } else if (!show && dot) {
    dot.remove();
  }
},

};
