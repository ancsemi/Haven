// ═══════════════════════════════════════════════════════════
// Blog mode for forums (#5742).
//
// A Channel Functions switch on a forum. With it on, a topic belongs to its
// author: the author's own follow-ups in the topic (more pictures in a
// gallery post, an update) are shown as part of the post, and everyone
// else's replies go under a separate Comments heading below it. The topic
// cards count only the comments.
//
// The server decides which replies are part of the post and marks them
// post_part; this side only places them. See src/forumBlog.js for the rule.
// ═══════════════════════════════════════════════════════════

export default {

_forumBlogOn(code) {
  const ch = this.channels && this.channels.find(c => c.code === (code || this.currentChannel));
  return !!(ch && ch.is_forum && !ch.is_dm && Number(ch.forum_blog) === 1);
},

// The count under a topic card in blog mode: comments only. Returns null
// when the forum is not in blog mode, so the card keeps its reply count.
_forumBlogRepliesLabel(msg) {
  if (!this._forumBlogOn()) return null;
  const n = Number(msg && msg.thread && msg.thread.comments) || 0;
  return n ? `💬 ${t(n === 1 ? 'forum.blog_comment_one' : 'forum.blog_comment_other', { count: n })}` : t('forum.blog_comment_cta');
},

// The 'thread-messages' handler calls this after drawing the topic body and
// before adding the replies. In blog mode it lays out the post's own section
// and the Comments section under it.
_forumBlogPrepareThread(data) {
  // A topic drawn again (opened, or redrawn after blog mode changed) starts
  // with no reply armed: the piece it pointed at may be closed or gone.
  this._clearThreadReply?.();
  const container = document.getElementById('thread-messages');
  const panel = document.getElementById('thread-panel');
  const blog = !!(data && data.blog);
  const picsOnly = blog && !!data.blogPicsOnly;
  this._forumBlogThread = blog ? { parentId: data.parentId, authorId: data.parentUserId || null, authorName: data.parentUsername || '', picsOnly, openPiece: null } : null;
  // Likes and dislikes on each piece (#5784).
  this._forumPieceVotesLoad?.(blog ? data.pieceVotes : null);
  panel?.classList.toggle('thread-blog', blog);
  panel?.classList.toggle('thread-blog-pics-only', picsOnly);
  this._forumBlogComposerHint();
  this._forumBlogComposerState();
  if (!blog || !container) return;
  const parts = document.createElement('div');
  parts.className = 'blog-post-parts';
  parts.id = 'blog-post-parts';
  const head = document.createElement('div');
  head.className = 'blog-comments-head';
  head.id = 'blog-comments-head';
  const list = document.createElement('div');
  list.className = 'blog-comments';
  list.id = 'blog-comments';
  list.dataset.empty = t('forum.blog_no_comments');
  container.append(parts, head, list);
  this._forumBlogRecount();
},

// After the first load the post is what you see first, not the newest comment.
_forumBlogAfterLoad() {
  if (!this._forumBlogThread) return;
  this._forumBlogRecount();
  const container = document.getElementById('thread-messages');
  if (container) container.scrollTop = 0;
},

// Where a thread reply goes: the post's section or the comments. Null when
// the open thread is not a blog topic, so it goes where it always did.
_forumBlogTargetFor(msg) {
  if (!this._forumBlogThread) return null;
  const container = document.getElementById('thread-messages');
  if (!container) return null;
  if (msg && msg.post_part === true) return container.querySelector('#blog-post-parts');
  // A comment on one picture of the post goes under that picture (#5753).
  if (msg && msg.reply_to) {
    const box = this._forumBlogPieceComments(msg.reply_to, true);
    if (box) return box;
    // An answer to a comment on a picture stays with that picture.
    const answered = container.querySelector(`.blog-piece-comments .thread-message[data-msg-id="${Number(msg.reply_to)}"]`);
    if (answered) return answered.closest('.blog-piece-comments');
  }
  return container.querySelector('#blog-comments');
},

// ── Comments on one piece of the post (#5753) ──────────────
// A piece is the opening post or one of the author's additions. A comment
// that replies to a piece sits under it, behind a button with its count;
// any other comment stays in the Comments section. Nothing new is stored:
// it is the reply link every thread reply already has.

_forumBlogPieceEl(id) {
  const container = document.getElementById('thread-messages');
  const b = this._forumBlogThread;
  if (!container || !b) return null;
  if (Number(id) === Number(b.parentId)) return container.querySelector('.thread-topic-body');
  return container.querySelector(`#blog-post-parts > .thread-message[data-msg-id="${Number(id)}"]`);
},

_forumBlogPieceBar(id, piece) {
  const holder = piece.parentElement;
  let bar = holder.querySelector(`:scope > .blog-piece-bar[data-piece="${Number(id)}"]`);
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'blog-piece-bar';
    bar.dataset.piece = String(Number(id));
    bar.innerHTML = '<button type="button" class="blog-piece-btn" aria-expanded="false"></button>';
    bar.querySelector('button').addEventListener('click', () => this._forumBlogTogglePiece(id));
    this._forumPieceVotesPaint?.(id, bar);
    piece.after(bar);
  }
  return bar;
},

_forumBlogPieceComments(id, create) {
  const piece = this._forumBlogPieceEl(id);
  if (!piece) return null;
  const holder = piece.parentElement;
  let box = holder.querySelector(`:scope > .blog-piece-comments[data-piece="${Number(id)}"]`);
  if (!box && create) {
    const bar = this._forumBlogPieceBar(id, piece);
    box = document.createElement('div');
    box.className = 'blog-piece-comments';
    box.dataset.piece = String(Number(id));
    box.hidden = true;
    bar.after(box);
  }
  return box;
},

// A deleted piece takes its button with it. Its comments lose their link
// on the server (the reply goes to nothing), so here they move to the rest.
_forumBlogPieceRemoved(id) {
  const container = document.getElementById('thread-messages');
  if (!container) return;
  const pid = Number(id);
  container.querySelector(`.blog-piece-bar[data-piece="${pid}"]`)?.remove();
  const box = container.querySelector(`.blog-piece-comments[data-piece="${pid}"]`);
  if (!box) return;
  const list = container.querySelector('#blog-comments');
  if (list) [...box.children].forEach(c => list.appendChild(c));
  box.remove();
},

// Opens or closes a piece's comments. Opening one also points the reply box
// at that piece, so what you write lands under it, the author's too: with a
// piece's comments open they answer there instead of adding to the post.
_forumBlogTogglePiece(id) {
  const box = this._forumBlogPieceComments(id, true);
  const b = this._forumBlogThread;
  if (!box || !b) return;
  box.hidden = !box.hidden;
  if (!box.hidden) {
    const piece = this._forumBlogPieceEl(id);
    if (piece && !piece.dataset.username) piece.dataset.username = b.authorName || '';
    if (piece) this._setThreadReply?.(piece, Number(id));
    b.openPiece = Number(id);
  } else if (box.hidden) {
    if (this._threadReplyingTo && this._threadReplyingTo.id === Number(id)) this._clearThreadReply?.();
    if (b.openPiece === Number(id)) b.openPiece = null;
  }
  this._forumBlogRecount();
  this._forumBlogComposerState();
  this._forumBlogComposerHint();
},

// Comments on pictures only (#5765): someone other than the author gets the
// reply box once a picture's comments are open, and what they send goes to
// that picture even if they dropped the reply marker.
_forumBlogComposerState() {
  const panel = document.getElementById('thread-panel');
  if (!panel) return;
  const b = this._forumBlogThread;
  const isAuthor = !!(b && this.user && b.authorId && b.authorId === this.user.id);
  panel.classList.toggle('blog-reply-locked', !!(b && b.picsOnly && !isAuthor && !b.openPiece));
},

_forumBlogDefaultReply() {
  const b = this._forumBlogThread;
  if (!b || !b.openPiece) return null;
  const isAuthor = !!(this.user && b.authorId && b.authorId === this.user.id);
  return isAuthor || b.picsOnly ? b.openPiece : null;
},

// Extra fields for a thread reply. The author answering the opening post is
// a comment; the server cannot tell that from an addition on its own, since
// some clients point every reply at the topic (src/forumBlog.js).
_forumBlogSendExtras(parentId, replyTo) {
  const b = this._forumBlogThread;
  if (!b || !replyTo || Number(b.parentId) !== Number(parentId) || Number(replyTo) !== Number(parentId)) return {};
  const isAuthor = !!(this.user && b.authorId && b.authorId === this.user.id);
  return isAuthor ? { asComment: true } : {};
},

_forumBlogIsPart(msg) {
  return !!(this._forumBlogThread && msg && msg.post_part === true);
},

_forumBlogRecount() {
  const head = document.getElementById('blog-comments-head');
  const list = document.getElementById('blog-comments');
  if (!head || !list) return;
  // Every comment counts, under a picture or here, as the topic card does.
  const container = document.getElementById('thread-messages');
  const n = container ? container.querySelectorAll('#blog-comments .thread-message, .blog-piece-comments .thread-message').length
    : list.querySelectorAll('.thread-message').length;
  head.textContent = n ? t('forum.blog_comments_count', { count: n }) : t('forum.blog_comments');
  list.dataset.empty = n ? '' : t('forum.blog_no_comments');
  const b = this._forumBlogThread;
  if (!container || !b) return;
  const pieces = [b.parentId, ...[...container.querySelectorAll('#blog-post-parts > .thread-message')].map(el => el.dataset.msgId)];
  for (const id of pieces) {
    const piece = this._forumBlogPieceEl(id);
    if (!piece) continue;
    const btn = this._forumBlogPieceBar(id, piece).querySelector('.blog-piece-btn');
    const box = this._forumBlogPieceComments(id, false);
    const count = box ? box.querySelectorAll('.thread-message').length : 0;
    const open = !!(box && !box.hidden);
    btn.textContent = `💬 ${count ? t('forum.blog_piece_comments', { count }) : t('forum.blog_piece_comment')}`;
    btn.setAttribute('aria-expanded', String(open));
    btn.classList.toggle('open', open);
  }
},

// The thread box says what sending will do: the author adds to the post,
// everyone else comments.
_forumBlogComposerHint() {
  const input = document.getElementById('thread-input');
  if (!input) return;
  const b = this._forumBlogThread;
  if (!b) { input.placeholder = t('thread_runtime.reply_placeholder'); return; }
  const isAuthor = !!(this.user && b.authorId && b.authorId === this.user.id);
  input.placeholder = t(isAuthor && !b.openPiece && !this._threadReplyingTo ? 'forum.blog_add_to_post' : 'forum.blog_write_comment');
},

_forumBlogClose() {
  this._forumBlogThread = null;
  this._forumPieceVotesLoad?.(null);
  document.getElementById('thread-panel')?.classList.remove('thread-blog', 'thread-blog-pics-only', 'blog-reply-locked');
  this._forumBlogComposerHint();
},

// ── Pictures from the message box ──
// In a blog forum every message in the channel is a post, and pictures are
// not grouped (each is a piece of a post). So pictures sent together from the
// message box used to start a post each: eight pictures, eight posts. Now
// they make one post, the way New Post does: the text sent with them starts
// it (or else the first picture does) and every other picture becomes one of
// its pieces.

// Your next post in a blog forum: its id, or null after 15 seconds.
_forumNextOwnPost(code) {
  return new Promise((resolve) => {
    const mine = this.user && this.user.id;
    const onNew = (data) => {
      const m = data && data.message;
      if (!m || data.channelCode !== code || m.user_id !== mine || m.thread_id) return;
      clearTimeout(timer);
      this.socket.off('new-message', onNew);
      resolve(m.id);
    };
    const timer = setTimeout(() => { this.socket.off('new-message', onNew); resolve(null); }, 15000);
    this.socket.on('new-message', onNew);
  });
},

// A post's pieces, as replies. Replies are capped at 10 every 10 seconds, so
// past 8 they are spaced out.
_forumSendBlogParts(parentId, parts) {
  parts.forEach((content, i) => setTimeout(() => this.socket.emit('send-thread-message', { parentId, content }), i < 8 ? 0 : (i - 7) * 1100));
},

// `bundled`: the text typed with the pictures was just sent and starts the post.
async _forumFlushBlogImages(code, files, { bundled, personaPrefix, replyTo, ferryDiscordUserId }) {
  // Listening starts before anything is sent, so the post is never missed.
  const postId = this._forumNextOwnPost(code);
  let rest = files;
  if (!bundled) {
    await this._uploadImage(files[0], code, false, personaPrefix, false, { replyTo, ferryDiscordUserId });
    rest = files.slice(1);
  }
  const lines = [];
  for (const file of rest) {
    if (this._uploadsCancelled) break;
    const line = await this._uploadImage(file, code, false, '', false, { returnContent: true });
    if (line) lines.push(line);
  }
  if (!lines.length) return;
  const parentId = await postId;
  if (parentId) { this._forumSendBlogParts(parentId, lines); return; }
  // The post never showed up (sending it failed): rather than lose the
  // pictures, each goes out on its own as before.
  for (const content of lines) this.socket.emit('send-message', { code, content, isImage: true });
},

_listenForumBlog() {
  // Turned on or off in Channel Functions: redraw the forum and any topic
  // open in it, so everyone viewing sees the change at once.
  this.socket.on('channel-permission-updated', (data) => {
    if (!data || (data.permission !== 'forum_blog' && data.permission !== 'forum_blog_pics_only')) return;
    const ch = this.channels && this.channels.find(c => c.code === data.code);
    if (ch) ch[data.permission] = data.enabled ? 1 : 0;
    if (data.code !== this.currentChannel) return;
    if (this._forumActive) this._forumReload?.();
    if (this._activeThreadParent) this.socket.emit('get-thread-messages', { parentId: this._activeThreadParent });
    if (ch) this._updateChannelFunctionsPanel?.(ch);
  });
},

};
