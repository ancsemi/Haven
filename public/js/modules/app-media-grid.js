// Pictures sent together (#5799). They used to go out as one message per
// picture, which pushed everything else out of view. Now a batch from the
// message box, a thread or the DM pop-out goes out as one message: the text on
// top, then one line per upload, the form forum topics already use. In the
// feed, two or more pictures (and videos) in a row show as one grid, laid out
// by count; clicking a tile opens the lightbox on that message's pictures.
//
// The grid crops each picture to fill its tile, which is bad for artwork, so
// it is a choice: the admin sets the server's default and each member may
// pick their own (media_group_layout, 'grid' or 'stacked'). Stacked shows the
// same tiles full size, one under another, uncropped, at the Image Display
// size. Changing either redraws the pictures already on screen in place.
//
// The layout and line helpers are pure, so the tests can drive them.

// A message carries at most this many files; more go out as further messages.
export const MEDIA_GROUP_MAX = 10;

// Tiles per row for each count, on a six-column grid. Three is the one
// layout that is not rows: a large picture on the left, two stacked beside it.
const GRID_ROWS = { 2: [2], 4: [2, 2], 5: [2, 3], 6: [3, 3], 7: [1, 3, 3], 8: [2, 3, 3], 9: [3, 3, 3] };
// The grid's width to height, fixed before anything loads so the feed keeps
// its place while the tiles fill in.
const GRID_RATIO = { 2: '2 / 1', 3: '4 / 3', 4: '4 / 3', 5: '6 / 5', 6: '3 / 2', 7: '1 / 1', 8: '1 / 1', 9: '1 / 1' };
const GRID_SHOWN = 9;
export const MEDIA_GROUP_LAYOUTS = ['grid', 'stacked'];

const PICTURE_LINE = /^(?:spoiler-img:)?\/uploads\/(?:[\w\-]+\/)?[\w\-.]+\.(?:jpg|jpeg|png|gif|webp|svg)$/i;
const E2E_PICTURE_LINE = /^(?:spoiler-img:)?e2e-img:image\/(?:jpeg|png|gif|webp|svg\+xml):\/uploads\/[\w\-.]+$/i;
const VIDEO_LINE = /^\[file:[^\]\n]+\]\((\/uploads\/[^\s|)]+\.(?:mp4|webm|mov|m4v))\|[^)\n]+\)$/i;
const VIDEO_NAME = /\.(?:mp4|webm|mov|m4v)$/i;
// The picture types an encrypted DM picture can be shown as; others go as files.
const E2E_PICTURE_MIME = /^image\/(?:jpeg|png|gif|webp|svg\+xml)$/i;

export default {

// ── Pure helpers ──────────────────────────────────────────

// How a grid of `count` tiles is laid out: the tiles shown (at most nine),
// how many more sit behind the "+N" on the last one, the row count, each
// shown tile's [columns, rows] span on the six-column grid, and the grid's
// aspect ratio. Null below two, which shows as a single picture as before.
_mediaGridLayout(count) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  if (n < 2) return null;
  const shown = Math.min(n, GRID_SHOWN);
  const more = n > GRID_SHOWN ? n - (GRID_SHOWN - 1) : 0;
  if (shown === 3) return { shown, more, rows: 2, spans: [[3, 2], [3, 1], [3, 1]], ratio: GRID_RATIO[3] };
  const perRow = GRID_ROWS[shown];
  const spans = perRow.flatMap(k => Array.from({ length: k }, () => [6 / k, 1]));
  return { shown, more, rows: perRow.length, spans, ratio: GRID_RATIO[shown] };
},

// The layout in effect: the member's own pick, or else the server's default,
// or else the grid.
_mediaGroupLayoutFor(personal, serverDefault) {
  if (MEDIA_GROUP_LAYOUTS.includes(personal)) return personal;
  return MEDIA_GROUP_LAYOUTS.includes(serverDefault) ? serverDefault : 'grid';
},

_mediaGroupLayoutPref() {
  return this._mediaGroupLayoutFor(this._userPrefs?.media_group_layout, this.serverSettings?.media_group_layout);
},

// What the group's box and each of its `count` tiles carry in a layout: the
// box's inline style, each tile's style and whether it waits behind the
// "+N", and where that "+N" goes. Stacked has no inline sizes, hides
// nothing and has no "+N". Null below two, as for _mediaGridLayout.
_mediaGridFrame(count, layout) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  if (n < 2) return null;
  if (layout === 'stacked') {
    return { stacked: true, style: '', tiles: Array.from({ length: n }, () => ({ style: '', hidden: false })), more: null };
  }
  const grid = this._mediaGridLayout(n);
  const tiles = Array.from({ length: n }, (_, i) => {
    const hidden = i >= grid.shown;
    const [cs, rs] = hidden ? [1, 1] : grid.spans[i];
    return { style: `grid-column:span ${cs};grid-row:span ${rs}`, hidden };
  });
  return {
    stacked: false,
    style: `aspect-ratio:${grid.ratio};grid-template-rows:repeat(${grid.rows},minmax(0,1fr))`,
    tiles,
    more: grid.more ? { index: grid.shown - 1, count: grid.more } : null,
  };
},

// What a content line shows as in a grid: 'image', 'video', or null for
// anything else (text, other files, a link).
_mediaGridKind(line) {
  const l = String(line || '').trim();
  if (PICTURE_LINE.test(l) || E2E_PICTURE_LINE.test(l)) return 'image';
  if (VIDEO_LINE.test(l)) return 'video';
  return null;
},

// The run of grid lines starting at lines[from]: consecutive pictures and
// videos, trimmed.
_mediaGridRun(lines, from) {
  const run = [];
  for (let i = from; i < lines.length; i++) {
    const l = String(lines[i] || '').trim();
    if (!this._mediaGridKind(l)) break;
    run.push(l);
  }
  return run;
},

// A queued file's kind: pictures and videos go in the grid, anything else
// is listed under it.
_mediaFileKind(file) {
  const type = (file && file.type) || '';
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/') || VIDEO_NAME.test((file && file.name) || '')) return 'video';
  return 'file';
},

// Pictures and videos first, in the order they were picked, then the rest,
// so the grid lines sit together.
_mediaGroupOrder(files) {
  const list = Array.from(files || []).filter(Boolean);
  const grid = list.filter(f => this._mediaFileKind(f) !== 'file');
  return [...grid, ...list.filter(f => this._mediaFileKind(f) === 'file')];
},

// Split a list into runs of at most `size`.
_mediaChunks(list, size) {
  const n = Math.max(1, Math.floor(size) || 1);
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
},

// Files per message: ten, or fewer when the admin allows fewer.
_mediaGroupMax() {
  const setting = this._maxAttachments ? this._maxAttachments() : MEDIA_GROUP_MAX;
  return Math.max(1, Math.min(MEDIA_GROUP_MAX, setting));
},

// A message's text and its upload lines, for editing the text alone. Null
// unless it is the shape a batch is sent in, text first and then two or more
// uploads, so a single picture, or a post with text between its pictures,
// edits as it always has.
_mediaGroupSplit(content) {
  const lines = String(content || '').split('\n');
  const isUpload = (l) => !!this._mediaGridKind(l) || /^(?:spoiler-img:)?\[file:[^\]\n]+\]\(\/uploads\/[^\s|)]+\|[^)\n]+\)$/.test(l.trim()) || /^e2e-file:\{.*\}$/.test(l.trim());
  const start = lines.findIndex(isUpload);
  if (start < 0) return null;
  const media = lines.slice(start).filter(l => l.trim());
  if (media.length < 2 || !media.every(isUpload)) return null;
  return { text: lines.slice(0, start).join('\n').trim(), media: media.map(l => l.trim()) };
},

// ── Feed ──────────────────────────────────────────────────

// Video tiles open the video viewer; picture tiles are chat images and go
// through the usual lightbox click. A new server default or a member's own
// pick redraws the pictures already on screen; the app's own handlers have
// stored the new value by the time these run.
_setupMediaGrid() {
  document.addEventListener('click', (e) => {
    const tile = e.target.closest && e.target.closest('.media-grid-tile.is-video');
    if (!tile) return;
    e.preventDefault();
    e.stopPropagation();
    const src = tile.dataset.videoSrc;
    if (src) this._openVideoLightbox?.(src);
  });
  this.socket?.on('server-settings', () => {
    this._relayoutMediaGrids();
    this._syncMediaLayoutPicker();
  });
  this.socket?.on('preferences', () => {
    this._relayoutMediaGrids();
    this._syncMediaLayoutPicker();
  });
  this.socket?.on('server-setting-changed', (data) => {
    if (data?.key !== 'media_group_layout') return;
    this._relayoutMediaGrids();
    this._syncMediaLayoutPicker();
  });
  document.getElementById('media-layout-picker')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-media-layout]');
    if (btn) this._setMediaLayoutPref(btn.dataset.mediaLayout);
  });
  this._syncMediaLayoutPicker();
},

// Settings > Image Display: your own layout, saved on your account, or
// Server default (no saved value) to follow the admin's choice.
_setMediaLayoutPref(value) {
  if (!this._userPrefs) this._userPrefs = {};
  if (MEDIA_GROUP_LAYOUTS.includes(value)) {
    this._userPrefs.media_group_layout = value;
    this.socket?.emit('set-preference', { key: 'media_group_layout', value });
  } else {
    delete this._userPrefs.media_group_layout;
    this.socket?.emit('delete-preference', { key: 'media_group_layout' });
  }
  this._syncMediaLayoutPicker();
  this._relayoutMediaGrids();
},

_syncMediaLayoutPicker() {
  const picker = document.getElementById('media-layout-picker');
  if (!picker) return;
  const mine = this._userPrefs?.media_group_layout;
  const current = MEDIA_GROUP_LAYOUTS.includes(mine) ? mine : '';
  picker.querySelectorAll('[data-media-layout]').forEach((b) => {
    b.classList.toggle('active', b.dataset.mediaLayout === current);
  });
  // The Server default button says what the server is set to.
  const dflt = picker.querySelector('[data-media-layout=""]');
  const server = this._mediaGroupLayoutFor(undefined, this.serverSettings?.media_group_layout);
  if (dflt) dflt.title = t('settings.image_display.media_layout.default_hint', { layout: t(`settings.image_display.media_layout.${server}`) });
},

// Settings > Uploads & Limits: the server's default. Filled and saved with
// the rest of the admin panel (app-admin.js).
_fillMediaLayoutAdmin(value) {
  const sel = document.getElementById('media-group-layout');
  if (sel) sel.value = MEDIA_GROUP_LAYOUTS.includes(value) ? value : 'grid';
},

_saveMediaLayoutAdmin(snap) {
  const value = document.getElementById('media-group-layout')?.value;
  if (!MEDIA_GROUP_LAYOUTS.includes(value) || value === (snap.media_group_layout || 'grid')) return false;
  this.socket.emit('update-server-setting', { key: 'media_group_layout', value });
  return true;
},

_mediaGridMoreHtml(count) {
  return `<span class="media-grid-more" title="${this._escapeHtml(t('media_grid.more', { count }))}">+${count}</span>`;
},

// The group for a run of picture and video lines, as a grid or stacked.
// Both keep the same tiles in one box, so the lightbox steps through that
// message's pictures either way.
_mediaGridHtml(lines, layout = this._mediaGroupLayoutPref()) {
  const frame = this._mediaGridFrame(lines.length, layout);
  if (!frame) return lines.map(l => `<div class="content-media-part">${this._formatContent(l)}</div>`).join('');
  const tiles = lines.map((line, i) => {
    const tile = frame.tiles[i];
    const video = this._mediaGridKind(line) === 'video' ? VIDEO_LINE.exec(line) : null;
    const inner = video
      ? `<video class="media-grid-video" src="${this._escapeHtml(video[1])}" preload="metadata" muted playsinline></video><span class="media-grid-play" aria-hidden="true">▶</span>`
      : this._formatContent(line);
    const more = frame.more && i === frame.more.index ? this._mediaGridMoreHtml(frame.more.count) : '';
    const cls = 'media-grid-tile' + (video ? ' is-video' : '') + (tile.hidden ? ' mg-hidden' : '');
    const style = tile.style ? ` style="${tile.style}"` : '';
    const attrs = video ? ` data-video-src="${this._escapeHtml(video[1])}" role="button" tabindex="0" title="${this._escapeHtml(t('media_grid.play_video'))}"` : '';
    return `<div class="${cls}"${style}${attrs}>${inner}${more}</div>`;
  }).join('');
  const label = this._escapeHtml(t('media_grid.label', { count: lines.length }));
  const cls = frame.stacked ? 'media-grid is-stacked' : 'media-grid';
  const style = frame.style ? ` style="${frame.style}"` : '';
  return `<div class="${cls}" data-count="${lines.length}" data-layout="${frame.stacked ? 'stacked' : 'grid'}" role="group" aria-label="${label}"${style}>${tiles}</div>`;
},

// Puts every group on the page (chat, threads, DM pop-outs, search) into the
// layout in effect. The tiles stay where they are, so loaded, decrypted and
// revealed pictures are kept as they were.
_relayoutMediaGrids(root = document) {
  const layout = this._mediaGroupLayoutPref();
  root.querySelectorAll('.media-grid[data-count]').forEach((el) => {
    if (el.dataset.layout !== layout) this._reflowMediaGrid(el, layout);
  });
},

// Lay one group out again for the tiles it has now, e.g. after a tile was
// taken out because its file is held back (_showHeldUploadNote).
_reflowMediaGrid(el, layout = this._mediaGroupLayoutPref()) {
  const tiles = Array.from(el.children).filter(c => c.classList.contains('media-grid-tile'));
  if (!tiles.length) { el.remove(); return; }
  el.dataset.count = String(tiles.length);
  const frame = this._mediaGridFrame(tiles.length, layout);
  el.querySelectorAll('.media-grid-more').forEach(m => m.remove());
  if (!frame && tiles[0].dataset.videoSrc) {
    // A lone video keeps its tile, which is what plays it when clicked.
    el.style.cssText = 'grid-template-columns:1fr';
    tiles[0].style.cssText = '';
    return;
  }
  if (!frame) {
    // One picture left is no longer a group: it shows like a single
    // picture, the way _mediaGridHtml renders a lone line.
    const part = document.createElement('div');
    part.className = 'content-media-part';
    part.append(...tiles[0].childNodes);
    el.replaceWith(part);
    return;
  }
  el.classList.toggle('is-stacked', frame.stacked);
  el.dataset.layout = layout;
  el.style.cssText = frame.style;
  tiles.forEach((tile, i) => {
    tile.style.cssText = frame.tiles[i].style;
    tile.classList.toggle('mg-hidden', frame.tiles[i].hidden);
    if (frame.more && i === frame.more.index) tile.insertAdjacentHTML('beforeend', this._mediaGridMoreHtml(frame.more.count));
  });
},

// ── Sending ───────────────────────────────────────────────

// A file type the admin blocked (#5833). The server refuses those, but an
// encrypted DM file reaches it under a made-up name, so the app checks the
// real one before encrypting. Says so and returns true when it is blocked.
_refuseBlockedUploadType(file) {
  const list = String(this.serverSettings?.blocked_upload_extensions || '').split(',').filter(Boolean);
  const m = /\.([^.\\/]+)$/.exec(String(file?.name || '').replace(/[.\s]+$/, ''));
  const ext = m ? m[1].toLowerCase() : '';
  if (!ext || !list.includes(ext)) return false;
  this._showToast(t('media.file_type_blocked', { ext }), 'error');
  return true;
},

// Upload one file and return the line it takes in a message, or null when
// it failed (already reported). In an encrypted DM the bytes are encrypted
// first, as before, and the line is the encrypted picture or file marker.
async _mediaUploadLine(file, { partner = null, isDm = false } = {}) {
  const type = file.type || '';
  const isImage = type.startsWith('image/');
  const spoiler = file._spoiler ? 'spoiler-img:' : '';
  try {
    if (partner) {
      if (this._refuseBlockedUploadType(file)) return null;
      const encrypted = await this._e2eEncryptBytes(partner, await file.arrayBuffer());
      const fd = new FormData();
      fd.append('scope', 'dm');
      const asPicture = isImage && E2E_PICTURE_MIME.test(type);
      fd.append('file', new Blob([encrypted], { type: 'application/octet-stream' }), asPicture ? 'e2e-image.enc' : 'e2e-file.enc');
      const data = await this._uploadWithProgress('/api/upload-file', fd);
      if (!data || !data.url) throw new Error(t('toasts.encrypted_image_failed'));
      const line = asPicture
        ? `${spoiler}e2e-img:${type}:${data.url}`
        : `e2e-file:${JSON.stringify({ mime: type || 'application/octet-stream', size: file.size, url: data.url, name: file.name || 'file' })}`;
      return { line, url: data.url };
    }
    const fd = new FormData();
    fd.append('scope', isDm ? 'dm' : 'channel');
    // SVG goes through /api/upload-file; the picture route takes rasters only.
    const raster = isImage && type !== 'image/svg+xml';
    fd.append(raster ? 'image' : 'file', file);
    const data = await this._uploadWithProgress(raster ? '/api/upload' : '/api/upload-file', fd);
    if (!data || data.error || !data.url) throw new Error((data && data.error) || t('toasts.upload_failed'));
    const line = (raster || data.isImage)
      ? `${spoiler}${data.url}`
      : `${this._spoilerMarkFor(file)}[file:${data.originalName}](${data.url}|${this._formatFileSize(data.fileSize)})`;
    return { line, url: data.url };
  } catch (err) {
    if (err?.aborted) return null;
    if (partner) console.error('[E2E] Attachment encryption failed:', err);
    this._showToast(err?.message || t('toasts.upload_failed'), 'error');
    return null;
  }
},

// Attachments from the message box go out together, except in a blog, where
// each file is a piece of its own (#5763).
_mediaGroupOn(code) {
  return !this._forumBlogOn?.(code);
},

// Whether the typed text goes in the same message as the attachments: not a
// command, not burn-after-read (pictures never burned), and not where text is
// switched off. `payload` is the text message the message box built.
_mediaGroupTakesText(content, payload) {
  if (!content || content.startsWith('/') || payload.burnSeconds) return false;
  const ch = this.channels?.find(c => c.code === payload.code);
  return !(ch && ch.text_enabled === 0);
},

// The message box's queued pictures and files, sent as messages of up to
// ten. With `combine` the text message `payload` goes with them, already
// cleared by the DM check (`partner`); otherwise a DM that cannot be
// encrypted asks first, and backing out keeps the queue. `textSent` says the
// text went on its own, carrying the reply.
async _flushComposerMedia({ payload, combine = false, partner = null, textSent = false, replyTo = null, prefix = '', ferryDiscordUserId = null, destructAt = null, silent = false }) {
  const { content: text, code, ...base } = payload;
  let to = partner;
  if (!combine) {
    const gate = await this._dmSendGate(code);
    if (!gate) return;
    to = gate.partner;
  }
  const files = [...(this._imageQueue || []), ...(this._fileQueue || [])];
  this._imageQueue = [];
  this._fileQueue = [];
  this._renderImageQueue?.();
  await this._sendMediaGroups({
    code, files, partner: to, prefix, ferryDiscordUserId, destructAt, silent,
    text: combine ? text : '',
    base: combine ? base : { replyTo: textSent ? null : replyTo },
    bundled: !combine && textSent,
  });
},

// Upload `files` and send them as messages of up to ten. The first carries
// `text` and `base` (reply, quote, official mark and the like); the rest
// follow as media sent with it. `prefix` (a persona or Discord target) goes
// in front of a message that has no text of its own. In a thread the
// messages are thread replies instead. The × on the progress bar stops the
// batch: what is already uploaded still goes, with the text. `silent` keeps
// every message of the batch silent (app-silent.js).
async _sendMediaGroups({ code, files, text = '', base = {}, partner = null, prefix = '', bundled = false, ferryDiscordUserId = null, destructAt = null, thread = null, silent = false }) {
  const ordered = this._mediaGroupOrder(files);
  if (!ordered.length && !text) return;
  const ch = code ? this.channels?.find(c => c.code === code) : null;
  const isDm = !!(ch && ch.is_dm);
  const chunks = ordered.length ? this._mediaChunks(ordered, this._mediaGroupMax()) : [[]];
  this._uploadsCancelled = false;
  for (let i = 0; i < chunks.length; i++) {
    const first = i === 0;
    const lines = [];
    const urls = [];
    const mediaTags = [];
    for (const file of chunks[i]) {
      if (this._uploadsCancelled) break;
      const up = await this._mediaUploadLine(file, { partner, isDm });
      if (!up) continue;
      lines.push(up.line);
      urls.push(up.url);
      if (!partner && Array.isArray(file._tags) && file._tags.length) mediaTags.push({ url: up.url, tags: file._tags });
    }
    const ownText = first ? text : '';
    let body = [ownText, ...lines].filter(Boolean).join('\n');
    if (!body) { if (this._uploadsCancelled) break; continue; }
    if (prefix && !ownText) body = prefix + body;
    if (thread) {
      const replyTo = first ? thread.replyTo : null;
      const reply = { parentId: thread.parentId, content: body, ...(replyTo ? { replyTo, ...this._forumBlogSendExtras?.(thread.parentId, replyTo) } : {}), ...(silent ? { silent: true } : {}) };
      this.socket.emit('send-thread-message', reply, (resp) => {
        if (resp && resp.error) this._showToast(resp.error, 'error');
      });
    } else {
      const payload = {
        code,
        content: body,
        ...(first ? base : {}),
        ...(ownText ? {} : { isImage: true }),
        ...((!first || bundled) ? { bundled: true } : {}),
        ...(ferryDiscordUserId ? { ferryDiscordUserId } : {}),
        ...this._destructField(destructAt),
        ...(mediaTags.length ? { mediaTags } : {}),
        ...(silent ? { silent: true } : {}),
      };
      if (partner) {
        try {
          payload.content = await this._e2eEncryptText(partner, body);
        } catch (err) {
          console.warn('[E2E] Encryption failed:', err);
          this._showToast(t('toasts.encryption_failed_not_sent'), 'error');
          return;
        }
        payload.encrypted = true;
        // So deleting the message removes its files too (#5699).
        if (urls.length) payload.files = urls;
      }
      this.socket.emit('send-message', payload);
    }
    this.notifications?.play?.('sent');
    if (mediaTags.length) this._recordFrequentTags?.(mediaTags.flatMap(m => m.tags));
    if (this._uploadsCancelled) break;
  }
},

};
