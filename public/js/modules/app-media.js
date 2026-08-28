export default {

// ── Image Queue (paste/drop → preview → send on Enter) ──

_queueImage(file) {
  if (!file || !file.type.startsWith('image/')) return;
  const _maxMb = parseInt(this.serverSettings?.max_upload_mb) || 25;
  if (file.size > _maxMb * 1024 * 1024) {
    return this._showToast(`Image too large (max ${_maxMb} MB)`, 'error');
  }
  if (!this._imageQueue) this._imageQueue = [];
  if (this._imageQueue.length >= 5) {
    return this._showToast('Max 5 images at once', 'error');
  }
  this._imageQueue.push(file);
  this._renderImageQueue();
  document.getElementById('message-input').focus();
},

_renderImageQueue() {
  const bar = document.getElementById('image-queue-bar');
  if (!bar) return;
  const hasImages = this._imageQueue && this._imageQueue.length > 0;
  const hasFiles  = this._fileQueue  && this._fileQueue.length  > 0;
  if (!hasImages && !hasFiles) {
    bar.style.display = 'none';
    bar.innerHTML = '';
    return;
  }
  bar.style.display = 'flex';
  bar.innerHTML = '';
  if (hasImages) {
    this._imageQueue.forEach((file, idx) => {
      const thumb = document.createElement('div');
      thumb.className = 'image-queue-thumb' + (file._spoiler ? ' is-spoiler' : '');
      const img = document.createElement('img');
      img.src = URL.createObjectURL(file);
      img.alt = file.name;
      img.onload = () => URL.revokeObjectURL(img.src);
      const removeBtn = document.createElement('button');
      removeBtn.className = 'image-queue-remove';
      removeBtn.title = 'Remove';
      removeBtn.textContent = '×';
      removeBtn.addEventListener('click', () => {
        this._imageQueue.splice(idx, 1);
        this._renderImageQueue();
      });
      thumb.appendChild(img);
      thumb.appendChild(this._makeSpoilerToggle(file));
      thumb.appendChild(removeBtn);
      bar.appendChild(thumb);
    });
  }
  if (hasFiles) {
    this._fileQueue.forEach((file, idx) => {
      const chip = document.createElement('div');
      chip.className = 'file-queue-chip';
      chip.title = file.name + ' — ' + this._formatFileSize(file.size);
      const icon = document.createElement('span');
      icon.className = 'file-queue-chip-icon';
      icon.textContent = '📎';
      const name = document.createElement('span');
      name.className = 'file-queue-chip-name';
      name.textContent = file.name;
      const size = document.createElement('span');
      size.className = 'file-queue-chip-size';
      size.textContent = this._formatFileSize(file.size);
      const removeBtn = document.createElement('button');
      removeBtn.className = 'image-queue-remove';
      removeBtn.title = 'Remove';
      removeBtn.textContent = '×';
      removeBtn.addEventListener('click', () => {
        this._fileQueue.splice(idx, 1);
        this._renderImageQueue();
      });
      chip.appendChild(icon);
      chip.appendChild(name);
      chip.appendChild(size);
      chip.appendChild(removeBtn);
      bar.appendChild(chip);
    });
  }
  // Add a "clear all" button if there's more than one queued attachment in total
  const totalQueued = (hasImages ? this._imageQueue.length : 0) + (hasFiles ? this._fileQueue.length : 0);
  if (totalQueued > 1) {
    const clearAll = document.createElement('button');
    clearAll.className = 'image-queue-clear-all';
    clearAll.textContent = 'Clear All';
    clearAll.addEventListener('click', () => {
      this._clearImageQueue();
      this._clearFileQueue();
    });
    bar.appendChild(clearAll);
  }
},

_clearImageQueue() {
  this._imageQueue = [];
  this._renderImageQueue();
},

// Build the little eye toggle that lets the sender mark a queued image as a
// spoiler. The choice rides along on the File object (`_spoiler`) so the flush
// loop can read it without threading extra state through the queue arrays.
_makeSpoilerToggle(file, isPip = false) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'image-queue-spoiler';
  const sync = () => {
    const on = !!file._spoiler;
    // Open eye when the image will send normally; closed (slashed) eye once
    // it's marked as a spoiler.
    btn.innerHTML = this._eyeIcon(on, 12);
    btn.title = on
      ? ((typeof t === 'function' && t('app.messages.spoiler_on')) || 'Spoiler on — click to send normally')
      : ((typeof t === 'function' && t('app.messages.mark_spoiler')) || 'Mark as spoiler');
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  };
  sync();
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    file._spoiler = !file._spoiler;
    const thumb = btn.closest('.image-queue-thumb');
    if (thumb) thumb.classList.toggle('is-spoiler', !!file._spoiler);
    sync();
  });
  return btn;
},

async _flushImageQueue(bundled = false, personaPrefix = '') {
  if (!this._imageQueue || this._imageQueue.length === 0) return;
  const files = [...this._imageQueue];
  this._clearImageQueue();
  this._uploadsCancelled = false;
  for (const file of files) {
    await this._uploadImage(file, undefined, bundled, personaPrefix);
    if (this._uploadsCancelled) break;   // × on the progress bar stops the batch
  }
},

// ── General file queue (non-image attachments) — (#5417) ──
// Mirrors _imageQueue so non-image attachments get a remove-able preview
// chip in the same bar instead of uploading instantly on selection.
_queueGeneralFile(file) {
  if (!file) return;
  const code = this.currentChannel;
  if (!code) return this._showToast(t('media.select_channel_first'), 'error');
  const _ch = this.channels.find(c => c.code === code);
  if (_ch && _ch.media_enabled === 0) {
    return this._showToast(t('media.uploads_disabled'), 'error');
  }
  const maxMb = parseInt(this.serverSettings?.max_upload_mb) || 25;
  if (file.size > maxMb * 1024 * 1024) {
    return this._showToast(t('media.file_too_large', { maxMb }), 'error');
  }
  if (!this._fileQueue) this._fileQueue = [];
  if (this._fileQueue.length >= 5) {
    return this._showToast('Max 5 files at once', 'error');
  }
  this._fileQueue.push(file);
  this._renderImageQueue();
  document.getElementById('message-input')?.focus();
},

_clearFileQueue() {
  this._fileQueue = [];
  this._renderImageQueue();
},

async _flushFileQueue() {
  if (!this._fileQueue || this._fileQueue.length === 0) return;
  const files = [...this._fileQueue];
  this._clearFileQueue();
  for (const file of files) {
    this._uploadGeneralFile(file);
  }
},

// ── PiP DM Image Queue (#5324) ──────────────────────────

_queueImageForPiP(file, targetCode) {
  if (!file || !file.type.startsWith('image/')) return;
  const _maxMb = parseInt(this.serverSettings?.max_upload_mb) || 25;
  if (file.size > _maxMb * 1024 * 1024) {
    return this._showToast(`Image too large (max ${_maxMb} MB)`, 'error');
  }
  if (!this._pipImageQueue) this._pipImageQueue = [];
  if (!this._pipImageQueueTarget) this._pipImageQueueTarget = targetCode;
  if (this._pipImageQueue.length >= 5) {
    return this._showToast('Max 5 images at once', 'error');
  }
  this._pipImageQueue.push(file);
  this._pipImageQueueTarget = targetCode;
  this._renderPiPImageQueue();
  document.getElementById('dm-pip-input')?.focus();
},

_renderPiPImageQueue() {
  const bar = document.getElementById('dm-pip-image-queue-bar');
  if (!bar) return;
  if (!this._pipImageQueue || this._pipImageQueue.length === 0) {
    bar.style.display = 'none';
    bar.innerHTML = '';
    return;
  }
  bar.style.display = 'flex';
  bar.innerHTML = '';
  this._pipImageQueue.forEach((file, idx) => {
    const thumb = document.createElement('div');
    thumb.className = 'image-queue-thumb' + (file._spoiler ? ' is-spoiler' : '');
    const img = document.createElement('img');
    img.src = URL.createObjectURL(file);
    img.alt = file.name;
    img.onload = () => URL.revokeObjectURL(img.src);
    const removeBtn = document.createElement('button');
    removeBtn.className = 'image-queue-remove';
    removeBtn.title = 'Remove';
    removeBtn.textContent = '×';
    removeBtn.addEventListener('click', () => {
      this._pipImageQueue.splice(idx, 1);
      this._renderPiPImageQueue();
    });
    thumb.appendChild(img);
    thumb.appendChild(this._makeSpoilerToggle(file, true));
    thumb.appendChild(removeBtn);
    bar.appendChild(thumb);
  });
  if (this._pipImageQueue.length > 1) {
    const clearAll = document.createElement('button');
    clearAll.className = 'image-queue-clear-all';
    clearAll.textContent = 'Clear All';
    clearAll.addEventListener('click', () => {
      this._pipImageQueue = [];
      this._renderPiPImageQueue();
    });
    bar.appendChild(clearAll);
  }
},

async _flushPiPImageQueue(bundled = false) {
  if (!this._pipImageQueue || this._pipImageQueue.length === 0) return;
  const files = [...this._pipImageQueue];
  const target = this._pipImageQueueTarget;
  this._pipImageQueue = [];
  this._pipImageQueueTarget = null;
  this._renderPiPImageQueue();
  this._uploadsCancelled = false;
  for (const file of files) {
    await this._uploadImage(file, target, bundled);
    if (this._uploadsCancelled) break;
  }
},

// ── Thread attachment queue (#thread-paste-instant) ──────────────────
// Pasting or dropping a file into a thread used to upload and post it
// immediately, so an accidental Ctrl+V dumped an image into the thread with
// no chance to cancel. Hold attachments here instead and flush them only when
// the reply is actually sent, matching the main and DM composers.
_queueThreadFile(file) {
  if (!file) return;
  const _maxMb = parseInt(this.serverSettings?.max_upload_mb) || 25;
  if (file.size > _maxMb * 1024 * 1024) {
    return this._showToast(`File too large (max ${_maxMb} MB)`, 'error');
  }
  if (!this._threadPending) this._threadPending = [];
  if (this._threadPending.length >= 5) {
    return this._showToast('Max 5 attachments at once', 'error');
  }
  this._threadPending.push(file);
  this._renderThreadPending();
  document.getElementById('thread-input')?.focus();
},

_renderThreadPending() {
  const bar = document.getElementById('thread-image-queue-bar');
  if (!bar) return;
  if (!this._threadPending || this._threadPending.length === 0) {
    bar.style.display = 'none';
    bar.innerHTML = '';
    return;
  }
  bar.style.display = 'flex';
  bar.innerHTML = '';
  this._threadPending.forEach((file, idx) => {
    const isImage = file.type && file.type.startsWith('image/');
    const thumb = document.createElement('div');
    thumb.className = 'image-queue-thumb' + (isImage ? '' : ' is-file');
    if (isImage) {
      const img = document.createElement('img');
      img.src = URL.createObjectURL(file);
      img.alt = file.name;
      img.onload = () => URL.revokeObjectURL(img.src);
      thumb.appendChild(img);
    } else {
      const label = document.createElement('span');
      label.className = 'image-queue-filename';
      label.textContent = file.name || 'file';
      thumb.appendChild(label);
    }
    const removeBtn = document.createElement('button');
    removeBtn.className = 'image-queue-remove';
    removeBtn.title = 'Remove';
    removeBtn.textContent = '×';
    removeBtn.addEventListener('click', () => {
      this._threadPending.splice(idx, 1);
      this._renderThreadPending();
    });
    thumb.appendChild(removeBtn);
    bar.appendChild(thumb);
  });
  if (this._threadPending.length > 1) {
    const clearAll = document.createElement('button');
    clearAll.className = 'image-queue-clear-all';
    clearAll.textContent = 'Clear All';
    clearAll.addEventListener('click', () => {
      this._threadPending = [];
      this._renderThreadPending();
    });
    bar.appendChild(clearAll);
  }
},

// Upload each held attachment and post it as a thread reply. Runs from
// _sendThreadMessage after the text so the ordering feels natural.
async _flushThreadPending(parentId) {
  if (!this._threadPending || this._threadPending.length === 0) return;
  if (!parentId) return;
  const files = [...this._threadPending];
  this._threadPending = [];
  this._renderThreadPending();
  this._uploadsCancelled = false;
  for (const file of files) {
    try {
      const formData = new FormData();
      const threadCh = this.channels.find(c => c.code === this.currentChannel);
      formData.append('scope', threadCh && threadCh.is_dm ? 'dm' : 'channel');
      formData.append('file', file);
      const data = await this._uploadWithProgress('/api/upload-file', formData);
      if (!data || data.error) { this._showToast(data?.error || 'Upload failed', 'error'); continue; }
      let content;
      if (data.isImage) {
        content = data.url;
      } else {
        const sizeStr = this._formatFileSize(data.fileSize);
        content = `[file:${data.originalName}](${data.url}|${sizeStr})`;
      }
      this.socket.emit('send-thread-message', { parentId, content });
    } catch (err) {
      if (err?.aborted) break;
      this._showToast(err.message || 'Upload failed', 'error');
    }
  }
},

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// AVATAR / PFP CUSTOMIZER
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

_updateAvatarPreview() {
  const preview = document.getElementById('avatar-upload-preview');
  if (!preview) return;
  if (this.user.avatar) {
    preview.innerHTML = `<img src="${this._escapeHtml(this.user.avatar)}" alt="avatar">`;
  } else {
    const color = this._getUserColor(this.user.username);
    const initial = this.user.username.charAt(0).toUpperCase();
    preview.innerHTML = `<div style="background-color:${color};width:100%;height:100%;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:1.125rem;color:white">${initial}</div>`;
  }
},

// Border preview mirrors the avatar preview; the empty state is a muted dot
// since a border is optional and has no letter fallback.
_updateBorderPreview() {
  const preview = document.getElementById('border-upload-preview');
  if (!preview) return;
  if (this.user.border) {
    preview.innerHTML = `<img src="${this._escapeHtml(this.user.border)}" alt="border">`;
  } else {
    preview.innerHTML = `<div style="width:100%;height:100%;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:0.7rem;color:var(--text-muted)">None</div>`;
  }
},

// There is nothing to edit without a border, counting a staged upload but not one
// that is cleared-pending-save. Disable the Edit button to match.
_updateBorderEditButton() {
  const btn = document.getElementById('border-crop-btn');
  if (!btn) return;
  const hasBorder = !this._pendingBorderRemoved && (this._pendingBorderPreviewUrl || this.user.border);
  btn.disabled = !hasBorder;
},

// Reset the border pending state and seed the editor op log from the saved fit.
// Shared by every Edit Profile opener so the border editor always restores the
// saved effects no matter how the modal was opened.
_resetBorderEditState() {
  this._pendingBorderFile = null;
  this._pendingBorderPreviewUrl = null;
  this._pendingBorderRemoved = false;
  this._updateBorderPreview();
  this._updateBorderEditButton();
  this._borderOps = Array.isArray(this.user.borderTransform)
    ? this.user.borderTransform.map(op => ({ ...op }))
    : [];
  this._borderDraft = null;
  // Seed the animated-profile control from the saved policy (same Save button).
  // Reseed the baseline too (not just the pending value): this.user.animateProfile
  // is authoritative here (session-info has populated it), whereas the setup-time
  // baseline predates it, so diffing against that stale value could drop a save.
  this._pendingAnimateProfile = this.user.animateProfile === 'disabled' ? 'disabled' : 'trigger';
  this._animateProfile = this._pendingAnimateProfile;
  const animSel = document.getElementById('animate-profile-select');
  if (animSel) animSel.value = this._pendingAnimateProfile;
},

// The border editor is event sourced: this._borderOps is an append-only log of
// fraction-based ops and this._borderDraft is the current tool's uncommitted op.
// Everything shown is a pure fold of (ops + draft); nothing is baked to pixels.

// Identity op for a tool, so every fresh engagement starts neutral.
// How far past the avatar edge any tool may push the content. Tune this one
// number (inches on the editor stage); it bounds Resize, Move and Distort alike.
_borderMaxOverflowIn: 0.3,

// That allowance as a fraction of the stage (0.3in ≈ 0.125 on the 14.4rem/230px
// stage). Derived from the live stage width, so it tracks the stage size.
_borderOverflowFrac() {
  const stage = document.getElementById('border-crop-preview');
  const px = (stage && stage.clientWidth) || 230;
  return (this._borderMaxOverflowIn * 96) / px;
},

// Fold one op into a content box (stage fractions): resize scales about centre,
// crop trims relative to the current box, move shifts. Rotate and distort leave the
// box unchanged (approximate; they are bounded at their own handles). This is the
// single per-op rule shared by _committedContentBox and the crop render/handles.
// Origin a resize scales about (stage fractions). 'center' (default) is the stage
// centre; 'corner' pins the content-box corner nearest the edge it sits toward, so
// enlarging grows away from that corner (inward) instead of drifting it out of frame.
// box is the content box beneath the op, so the choice is fixed for the engagement.
_resizeOrigin(op, box) {
  if (!op || op.anchor !== 'corner') return [0.5, 0.5];
  const cx = (box.left + box.right) / 2, cy = (box.top + box.bottom) / 2;
  return [cx < 0.5 ? box.left : box.right, cy < 0.5 ? box.top : box.bottom];
},

_advanceBox(cb, op) {
  let { left: l, top: t, right: r, bottom: b } = cb;
  if (op.type === 'resize') {
    const [ox, oy] = this._resizeOrigin(op, cb);
    l = ox + (l - ox) * op.scale; r = ox + (r - ox) * op.scale;
    t = oy + (t - oy) * op.scale; b = oy + (b - oy) * op.scale;
  } else if (op.type === 'crop') {
    const w = r - l, h = b - t;
    l += op.left * w; r -= op.right * w; t += op.top * h; b -= op.bottom * h;
  } else if (op.type === 'move') {
    l += op.x; r += op.x; t += op.y; b += op.y;
  }
  return { left: l, top: t, right: r, bottom: b };
},

// Axis-aligned box of the content after the committed ops, in stage fractions.
// Every tool re-initializes against this so it acts on the real current dimensions.
_committedContentBox() {
  let cb = { left: 0, top: 0, right: 1, bottom: 1 };
  for (const op of this._borderOps) cb = this._advanceBox(cb, op);
  return cb;
},

// Effective committed opacity (product of any committed opacity ops). The Opacity
// tool treats this as a single value: it seeds the draft, so the slider shows the
// current opacity, and commit dedupes to one op (see _commitBorderDraft).
_committedOpacity() {
  let p = 1;
  for (const op of this._borderOps) if (op.type === 'opacity') p *= op.value;
  return p;
},

// Content extent (width/height as stage fractions); resize scales about centre so
// only size matters. Cropping the border's padding shrinks this and lets resize
// grow the visible frame further. Pure composition math, no image measuring.
_committedContentExtent() {
  const bx = this._committedContentBox();
  return { ew: bx.right - bx.left, eh: bx.bottom - bx.top };
},

// Max scale for a fresh resize: the current content may grow until its larger
// side sticks out _borderMaxOverflowIn past the avatar, no more.
_resizeMaxScale() {
  const { ew, eh } = this._committedContentExtent();
  return Math.max(0.1, (1 + 2 * this._borderOverflowFrac()) / (Math.max(ew, eh) || 1));
},

_borderOpBase(tool) {
  if (tool === 'crop')    return { type: 'crop', top: 0, right: 0, bottom: 0, left: 0 };
  if (tool === 'move')    return { type: 'move', x: 0, y: 0 };
  if (tool === 'resize')  return { type: 'resize', scale: 1, anchor: this._resizeAnchor || 'center' };
  if (tool === 'rotate')  return { type: 'rotate', deg: 0 };
  if (tool === 'opacity') return { type: 'opacity', value: 1 };
  return { type: 'distort', tl: [0, 0], tr: [0, 0], bl: [0, 0], br: [0, 0] };
},

// True once an op actually moves something, so empty engagements never commit.
_borderOpChanged(op) {
  const e = 0.0005;
  if (!op) return false;
  if (op.type === 'crop')    return op.top > e || op.right > e || op.bottom > e || op.left > e;
  if (op.type === 'move')    return Math.abs(op.x) > e || Math.abs(op.y) > e;
  if (op.type === 'resize')  return Math.abs(op.scale - 1) > e;
  if (op.type === 'rotate')  return Math.abs(op.deg) > e;
  if (op.type === 'opacity') return Math.abs(op.value - 1) > e;
  if (op.type === 'distort') return ['tl', 'tr', 'bl', 'br'].some((k) => Math.abs(op[k][0]) > e || Math.abs(op[k][1]) > e);
  return false;
},

// Inline CSS for one op's nested wrapper. Distort resolves to a matrix3d
// homography; the rest are plain clip/transform. W,H are the stage in pixels.
// cb is the content box committed *beneath* this op (stage fractions), so a crop
// trims relative to the current content, composing with prior resize/crop/move.
_borderWrapperStyle(op, W, H, cb = { left: 0, top: 0, right: 1, bottom: 1 }) {
  if (!op) return '';
  if (op.type === 'crop') {
    // A crop fraction f trims f of the current content box from that edge; express
    // it as an inset from the stage edge. For a fresh box this is plain f*100%; a
    // resize widens the box past [0,1], giving the negative insets that reveal the
    // enlarged frame (a resize about centre makes the box [-.5,1.5] at scale 2, so
    // the left inset is cb.left + f*width = -.5 + f*2, matching the old m + f*S).
    const cw = cb.right - cb.left, ch = cb.bottom - cb.top;
    const pct = (v) => (v * 100).toFixed(4) + '%';
    const t = cb.top + op.top * ch, r = (1 - cb.right) + op.right * cw;
    const b = (1 - cb.bottom) + op.bottom * ch, l = cb.left + op.left * cw;
    return `clip-path: inset(${pct(t)} ${pct(r)} ${pct(b)} ${pct(l)});`;
  }
  if (op.type === 'move')    return `transform: translate(${op.x * 100}%, ${op.y * 100}%);`;
  if (op.type === 'resize') {
    const [ox, oy] = this._resizeOrigin(op, cb);
    return `transform: scale(${op.scale}); transform-origin: ${(ox * 100).toFixed(4)}% ${(oy * 100).toFixed(4)}%;`;
  }
  if (op.type === 'rotate')  return `transform: rotate(${op.deg}deg); transform-origin: center;`;
  if (op.type === 'opacity') return `opacity: ${op.value};`;
  if (op.type === 'distort') {
    const dst = [
      [op.tl[0] * W, op.tl[1] * H],
      [(1 + op.tr[0]) * W, op.tr[1] * H],
      [op.bl[0] * W, (1 + op.bl[1]) * H],
      [(1 + op.br[0]) * W, (1 + op.br[1]) * H]
    ];
    // No clip here: _computeMatrix3d refuses any quad whose perspective would fling
    // content past the frame, so a valid matrix never magnifies enough to escape,
    // and a rejected one returns null and renders flat. Clipping would only re-cut
    // legitimately rotated content that sits under the distort.
    const m = this._computeMatrix3d(W, H, dst);
    return m ? `transform: ${m}; transform-origin: 0 0;` : '';
  }
  return '';
},

// ── pfp border overlay (rendering the saved fit on real avatars) ──
// Sites emit an empty marker via _pfpBorderMarker; a MutationObserver folds it
// into nested op wrappers once it is in the DOM, so distort can be sized to the
// avatar. The fold reuses _borderWrapperStyle, exactly like the editor.
_pfpBorderMarker(border, transform, animate) {
  if (!border) return '';
  const ops = Array.isArray(transform) ? transform : [];
  const mode = animate === 'disabled' ? 'disabled' : 'trigger';
  return `<span class="pfp-border" data-border="${this._escapeHtml(border)}" data-bt="${this._escapeHtml(JSON.stringify(ops))}" data-animate="${mode}"></span>`;
},

// Fold one marker: measure its box (= the avatar), then wrap the border image
// once per saved op. Idempotent via data-pfp-done.
_foldPfpBorder(el) {
  if (!el || el.dataset.pfpDone) return;
  el.dataset.pfpDone = '1';
  const border = el.dataset.border;
  if (!border) return;
  let ops = [];
  try { ops = JSON.parse(el.dataset.bt || '[]'); } catch { ops = []; }
  const W = el.clientWidth || el.offsetWidth || 100;
  const H = el.clientHeight || el.offsetHeight || W;
  // Carry the owner's animation policy onto the border image so the freeze
  // observer treats it exactly like an avatar image.
  const animAttr = el.dataset.animate === 'disabled' ? ' data-animate="disabled"' : ' data-animate="trigger"';
  let stack = `<img class="pfp-border-img"${animAttr} src="${this._escapeHtml(border)}" alt="">`;
  let cb = { left: 0, top: 0, right: 1, bottom: 1 };
  for (const op of ops) {
    stack = `<div class="bce-op" style="${this._borderWrapperStyle(op, W, H, cb)}">${stack}</div>`;
    cb = this._advanceBox(cb, op);
  }
  el.innerHTML = stack;
},

// One observer folds every marker as it enters the DOM, decoupling rendering
// from the many avatar render sites. Set up once.
_setupPfpBorderObserver() {
  if (this._pfpBorderObserver) return;
  const foldIn = (node) => {
    if (!node || node.nodeType !== 1) return;
    if (node.matches && node.matches('.pfp-border')) this._foldPfpBorder(node);
    if (node.querySelectorAll) node.querySelectorAll('.pfp-border:not([data-pfp-done])').forEach((el) => this._foldPfpBorder(el));
    // Freeze animated avatar / border images to their first frame per the owner's policy.
    if (node.matches && node.matches('img[data-animate]:not([data-anim-done])')) this._freezePfpImg(node);
    if (node.querySelectorAll) node.querySelectorAll('img[data-animate]:not([data-anim-done])').forEach((img) => this._freezePfpImg(img));
    // (#5526) chat images ride the same observer
    if (node.matches && node.matches('img.chat-image:not([data-chat-anim-done])')) this._freezeChatImg(node);
    if (node.querySelectorAll) node.querySelectorAll('img.chat-image:not([data-chat-anim-done])').forEach((img) => this._freezeChatImg(img));
  };
  const obs = new MutationObserver((muts) => {
    for (const m of muts) m.addedNodes.forEach(foldIn);
  });
  obs.observe(document.body, { childList: true, subtree: true });
  this._pfpBorderObserver = obs;
  document.querySelectorAll('.pfp-border:not([data-pfp-done])').forEach((el) => this._foldPfpBorder(el));
  document.querySelectorAll('img[data-animate]:not([data-anim-done])').forEach((img) => this._freezePfpImg(img));
  this._setupChatAnimHover();
  document.querySelectorAll('img.chat-image:not([data-chat-anim-done])').forEach((img) => this._freezeChatImg(img));
},

// Wrap an avatar's HTML with its owner's border overlay (or return it unchanged).
_avatarWithBorder(avatarHtml, user) {
  const marker = user ? this._pfpBorderMarker(user.border, user.borderTransform, user.animateProfile) : '';
  return marker ? `<span class="pfp-host">${avatarHtml}${marker}</span>` : avatarHtml;
},

// ── Animated chat images (#5526) ─────────────────────────────────────────
// Same idea as the animated-pfp policy below, pointed at images in messages.
// Reuses _frozenFrame, so a GIF posted twice is only ever captured once.
//
// Defaults to 'always', i.e. exactly how Haven behaved before. An avatar is
// ambient and someone else chose it for you; a GIF in chat is content a person
// deliberately posted, so this stays off until you ask for it.
//
// The URL to test is not always the src: a remote image is served through
// /api/media-proxy, whose URL ends in a token rather than .gif. data-mp-origin
// carries the real address alongside it, so that is what gets checked. Proxied
// images are same-origin, which is also what keeps the canvas readable.

_viewerChatAnimPref() {
  try {
    const v = localStorage.getItem('haven_animate_chat');
    if (v === 'hover' || v === 'never') return v;
  } catch { /* localStorage unavailable */ }
  return 'always';
},

_setViewerChatAnimPref(pref) {
  const value = (pref === 'hover' || pref === 'never') ? pref : 'always';
  try { localStorage.setItem('haven_animate_chat', value); } catch { /* ignore */ }
  document.querySelectorAll('#animate-chat-picker .density-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.animchat === value);
  });
  this._applyViewerChatAnimPref();
},

// The address to judge "can this animate" by, unwrapping the media proxy.
_chatImgRealUrl(img) {
  return img.getAttribute('data-mp-origin') || img.getAttribute('src') || '';
},

_applyViewerChatAnimPref() {
  const pref = this._viewerChatAnimPref();
  document.querySelectorAll('img.chat-image[data-chat-animated-src]').forEach((img) => {
    if (pref === 'always') {
      img.dataset.chatAnimPlaying = '1';
      if (img.getAttribute('src') !== img.dataset.chatAnimatedSrc) img.src = img.dataset.chatAnimatedSrc;
      return;
    }
    const live = pref === 'hover' && img.matches(':hover');
    if (live) { img.dataset.chatAnimPlaying = '1'; return; }
    img.dataset.chatAnimPlaying = '';
    this._frozenFrame(img.dataset.chatAnimatedSrc).then((f) => {
      if (f && img.dataset.chatAnimPlaying !== '1') img.src = f;
    });
  });
  // Nothing is frozen yet on a fresh switch away from 'always', so sweep too.
  if (pref !== 'always') {
    document.querySelectorAll('img.chat-image:not([data-chat-anim-done])').forEach((img) => this._freezeChatImg(img));
  }
},

_freezeChatImg(img) {
  if (!img || img.dataset.chatAnimDone) return;
  const pref = this._viewerChatAnimPref();
  if (pref === 'always') return;                 // leave it alone, and leave it re-checkable
  const src = img.getAttribute('src') || '';
  if (!src || src.startsWith('data:')) return;   // not loaded yet, or already a frozen frame
  if (!this._animCanAnimate(this._chatImgRealUrl(img))) { img.dataset.chatAnimDone = '1'; return; }
  img.dataset.chatAnimDone = '1';
  img.dataset.chatAnimatedSrc = src;
  if (img.matches(':hover')) { img.dataset.chatAnimPlaying = '1'; return; }
  this._frozenFrame(src).then((frozen) => {
    if (frozen && img.dataset.chatAnimPlaying !== '1' && img.getAttribute('src') === src) img.src = frozen;
  });
},

// Hover to play, leave to re-freeze. Bound once, delegated, so it keeps working
// across every re-render without rebinding per image.
_setupChatAnimHover() {
  if (this._chatAnimHoverBound) return;
  this._chatAnimHoverBound = true;
  const over = (e) => {
    const img = e.target;
    if (!img || !img.matches || !img.matches('img.chat-image[data-chat-animated-src]')) return;
    if (this._viewerChatAnimPref() !== 'hover') return;
    img.dataset.chatAnimPlaying = '1';
    img.src = img.dataset.chatAnimatedSrc;   // reassigning restarts from frame 1
  };
  const out = (e) => {
    const img = e.target;
    if (!img || !img.matches || !img.matches('img.chat-image[data-chat-animated-src]')) return;
    if (this._viewerChatAnimPref() !== 'hover') return;
    img.dataset.chatAnimPlaying = '';
    this._frozenFrame(img.dataset.chatAnimatedSrc).then((f) => {
      if (f && img.dataset.chatAnimPlaying !== '1') img.src = f;
    });
  };
  document.addEventListener('mouseover', over, true);
  document.addEventListener('mouseout', out, true);
  // A GIF that has not finished loading has no frame to capture yet, so catch
  // it on load as well as when it is inserted.
  document.addEventListener('load', (e) => {
    const img = e.target;
    if (img && img.matches && img.matches('img.chat-image:not([data-chat-anim-done])')) this._freezeChatImg(img);
  }, true);
},

// ── Animated-profile policy (freeze animated pfps to their first frame) ──
// Two sides decide this, and the more restrictive one wins.
//
// The pfp OWNER's policy rides on each <img> as data-animate, so someone with a
// busy GIF can choose not to inflict it on everyone: 'disabled' stays frozen for
// every viewer, no exceptions.
//
// The VIEWER's own preference lives in localStorage (haven_animate_pfp) and only
// affects what they see:
//   always: let 'trigger' pfps loop all the time (how Haven behaved before)
//   hover:  play only while hovering the message or with the profile card open
//   never:  freeze everything, even pfps whose owner allows animation
//
// Freezing is pure client side: the first frame is captured to a data URL via
// <canvas>, so no static file or server work is needed. Same-origin uploads keep
// the canvas untainted; if a privacy mode blocks the read the image is left
// animated.

// The viewer's own preference. Defaults to 'hover'.
_viewerAnimPref() {
  try {
    const v = localStorage.getItem('haven_animate_pfp');
    if (v === 'always' || v === 'never') return v;
  } catch { /* localStorage unavailable */ }
  return 'hover';
},

// Persist the viewer's preference and re-apply it to everything on screen, so
// flipping it takes effect without a reload.
_setViewerAnimPref(pref) {
  const value = (pref === 'always' || pref === 'never') ? pref : 'hover';
  try { localStorage.setItem('haven_animate_pfp', value); } catch { /* ignore */ }
  document.querySelectorAll('#animate-pfp-picker .density-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.animpfp === value);
  });
  this._applyViewerAnimPref();
},

// Re-evaluate every already-frozen pfp against the current preference. 'always'
// restores the live source on anything the owner still permits; 'never' and
// 'hover' put it back to the first frame unless it is inside a live trigger.
_applyViewerAnimPref() {
  const pref = this._viewerAnimPref();
  document.querySelectorAll('img[data-animate="trigger"][data-animated-src]').forEach((img) => {
    if (pref === 'always') {
      img.dataset.animPlaying = '1';
      if (img.getAttribute('src') !== img.dataset.animatedSrc) img.src = img.dataset.animatedSrc;
      return;
    }
    // Keep playing only if the viewer is genuinely hovering it or has the card open.
    const live = pref === 'hover' &&
      (img.closest('[data-anim-play]') || img.closest('.message:hover, .message-compact:hover'));
    if (live) { img.dataset.animPlaying = '1'; return; }
    img.dataset.animPlaying = '';
    this._frozenFrame(img.dataset.animatedSrc).then((f) => {
      if (f && img.dataset.animPlaying !== '1') img.src = f;
    });
  });
},

// data-animate attribute (with leading space) for an avatar <img>.
_animAttr(mode) {
  return mode === 'disabled' ? ' data-animate="disabled"' : ' data-animate="trigger"';
},

// Only these formats can carry animation; skip the rest (e.g. jpeg) entirely.
_animCanAnimate(url) {
  return /\.(gif|apng|png|webp)(\?|#|$)/i.test(url || '');
},

// One frozen-frame data URL per unique image URL, deduped across every render.
// Returns a Promise resolving to the data URL, or null if capture is blocked.
_frozenFrame(url) {
  if (!this._frozenFrames) this._frozenFrames = new Map();
  const cached = this._frozenFrames.get(url);
  if (cached) return cached;
  const p = new Promise((resolve) => {
    const im = new Image();
    im.decoding = 'async';
    im.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = im.naturalWidth || 1;
        c.height = im.naturalHeight || 1;
        c.getContext('2d').drawImage(im, 0, 0);
        resolve(c.toDataURL('image/png'));
      } catch { resolve(null); }
    };
    im.onerror = () => resolve(null);
    im.src = url;
  });
  this._frozenFrames.set(url, p);
  return p;
},

// Freeze one pfp <img> to its first frame (idempotent via data-anim-done). The
// live URL is stashed on data-animated-src so 'trigger' can play it on demand.
_freezePfpImg(img) {
  if (!img || img.dataset.animDone) return;
  const mode = img.dataset.animate;
  if (mode !== 'trigger' && mode !== 'disabled') { img.dataset.animDone = '1'; return; }
  const url = img.getAttribute('src') || '';
  if (url.startsWith('data:') || !this._animCanAnimate(url)) { img.dataset.animDone = '1'; return; }
  img.dataset.animDone = '1';
  img.dataset.animatedSrc = url;
  // The owner's 'disabled' is absolute. Otherwise the viewer's preference decides:
  // 'always' never freezes, 'never' always does, 'hover' waits for a trigger.
  const pref = this._viewerAnimPref();
  if (mode === 'trigger' && pref === 'always') { img.dataset.animPlaying = '1'; return; }
  // Inside a live trigger context (an open profile card) leave it animating.
  if (mode === 'trigger' && pref === 'hover' && img.closest && img.closest('[data-anim-play]')) img.dataset.animPlaying = '1';
  this._frozenFrame(url).then((frozen) => {
    // Do not clobber an in-flight hover/profile play, and only swap if still the live src.
    if (frozen && img.dataset.animPlaying !== '1' && img.getAttribute('src') === url) img.src = frozen;
  });
},

// Play (loop) or re-freeze every 'trigger' pfp image inside a container.
_setPfpAnimation(container, play) {
  if (!container || !container.querySelectorAll) return;
  const pref = this._viewerAnimPref();
  if (pref === 'never') return;   // viewer opted out; hover does nothing
  if (pref === 'always' && !play) return; // never re-freeze what the viewer wants looping
  container.querySelectorAll('img[data-animate="trigger"][data-animated-src]').forEach((img) => {
    if (play) {
      img.dataset.animPlaying = '1';
      img.src = img.dataset.animatedSrc; // reassigning restarts the loop from frame 1
    } else {
      img.dataset.animPlaying = '';
      this._frozenFrame(img.dataset.animatedSrc).then((f) => {
        if (f && img.dataset.animPlaying !== '1') img.src = f;
      });
    }
  });
},

// Wire the two trigger contexts: hovering a message row, and (handled at build
// time) opening a profile card. Set up once.
_setupPfpAnimationTriggers() {
  if (this._pfpAnimTriggersSet) return;
  const messages = document.getElementById('messages');
  if (!messages) return; // messages container not mounted yet; retried on next setup
  this._pfpAnimTriggersSet = true;
  messages.addEventListener('mouseover', (e) => {
    const row = e.target.closest('.message, .message-compact');
    if (!row) return;
    const from = e.relatedTarget;
    if (from && row.contains(from)) return; // moved within the same row
    this._setPfpAnimation(row, true);
  });
  messages.addEventListener('mouseout', (e) => {
    const row = e.target.closest('.message, .message-compact');
    if (!row) return;
    const to = e.relatedTarget;
    if (to && row.contains(to)) return; // still within the row
    this._setPfpAnimation(row, false);
  });
},

// Rebuild the whole preview from the log: the shaped avatar as the fixed base,
// then the border wrapped once per committed op (innermost = image) and finally
// one outermost draft wrapper we mutate live while dragging. Pending avatar /
// border / shape values win over saved ones so the modal previews unsaved edits.
_renderBorderEditor() {
  const layers = document.getElementById('border-crop-layers');
  const stage = document.getElementById('border-crop-preview');
  if (!layers || !stage) return;

  const avatarUrl = this._pendingAvatarRemoved ? null : (this._pendingAvatarPreviewUrl || this.user.avatar);
  const borderUrl = this._pendingBorderRemoved ? null : (this._pendingBorderPreviewUrl || this.user.border);
  const shapeClass = 'avatar-' + (this._pendingAvatarShape || this.user.avatarShape || 'circle');

  let avatarLayer;
  if (avatarUrl) {
    avatarLayer = `<img class="border-crop-avatar ${shapeClass}" src="${this._escapeHtml(avatarUrl)}" alt="avatar">`;
  } else {
    const color = this._getUserColor(this.user.username);
    const initial = this.user.username.charAt(0).toUpperCase();
    avatarLayer = `<div class="border-crop-avatar ${shapeClass}" style="background-color:${color}">${initial}</div>`;
  }

  if (borderUrl) {
    const W = stage.clientWidth || 192, H = stage.clientHeight || 192;
    let stack = `<img class="border-crop-border" src="${this._escapeHtml(borderUrl)}" alt="border">`;
    let cb = { left: 0, top: 0, right: 1, bottom: 1 };
    // An opacity draft is the single source of truth for opacity, so hide the
    // committed opacity op(s) while editing instead of multiplying with them.
    const draftIsOpacity = this._borderDraft && this._borderDraft.type === 'opacity';
    for (const op of this._borderOps) {
      if (draftIsOpacity && op.type === 'opacity') continue;
      stack = `<div class="bce-op" style="${this._borderWrapperStyle(op, W, H, cb)}">${stack}</div>`;
      cb = this._advanceBox(cb, op);
    }
    stack = `<div class="bce-op bce-draft" style="${this._borderWrapperStyle(this._borderDraft, W, H, cb)}">${stack}</div>`;
    layers.innerHTML = avatarLayer + stack;
  } else {
    layers.innerHTML = avatarLayer;
  }
  this._positionBorderHandles();
  this._renderBorderHistory();
  // Tool-specific action rows: auto-crop under Crop, quarter-turn nudges under
  // Rotate. Both need a border to act on.
  const autocropBtn = document.getElementById('border-crop-autocrop-btn');
  if (autocropBtn) {
    autocropBtn.style.display = (this._borderTool === 'crop' && borderUrl) ? 'block' : 'none';
    autocropBtn.disabled = this._hasCrop();
  }
  const rotateActions = document.getElementById('border-crop-rotate-actions');
  if (rotateActions) rotateActions.style.display = (this._borderTool === 'rotate' && borderUrl) ? 'flex' : 'none';
  const resizeActions = document.getElementById('border-crop-resize-actions');
  if (resizeActions) {
    resizeActions.style.display = (this._borderTool === 'resize' && borderUrl) ? 'flex' : 'none';
    const anchorSel = document.getElementById('border-resize-anchor');
    if (anchorSel) anchorSel.value = this._resizeAnchor || 'center';
  }
  const opacityActions = document.getElementById('border-crop-opacity-actions');
  if (opacityActions) {
    opacityActions.style.display = (this._borderTool === 'opacity' && borderUrl) ? 'flex' : 'none';
    // Reflect the opacity draft (seeded from the committed value on entry) so the
    // slider shows the current opacity, not a reset 100%.
    const pct = (this._borderDraft && this._borderDraft.type === 'opacity') ? Math.round(this._borderDraft.value * 100) : 100;
    const slider = document.getElementById('border-opacity-slider');
    const val = document.getElementById('border-opacity-value');
    if (slider) slider.value = pct;
    if (val) val.textContent = pct + '%';
  }
},

// Convexity guard: a homography only renders sanely for a convex, non
// self-intersecting quad. quad is given in perimeter order.
_isConvex(quad) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = quad[i], b = quad[(i + 1) % 4], d = quad[(i + 2) % 4];
    const cross = (b[0] - a[0]) * (d[1] - b[1]) - (b[1] - a[1]) * (d[0] - b[0]);
    if (cross !== 0) {
      const s = cross > 0 ? 1 : -1;
      if (sign === 0) sign = s;
      else if (s !== sign) return false;
    }
  }
  return true;
},

// Solve the projective transform that maps the source rectangle onto the four
// destination points and express it as a CSS matrix3d string. Standard
// unit-square basis method; dst is [tl,tr,bl,br] in pixels.
_computeMatrix3d(w, h, dst) {
  const adj = (m) => [
    m[4] * m[8] - m[5] * m[7], m[2] * m[7] - m[1] * m[8], m[1] * m[5] - m[2] * m[4],
    m[5] * m[6] - m[3] * m[8], m[0] * m[8] - m[2] * m[6], m[2] * m[3] - m[0] * m[5],
    m[3] * m[7] - m[4] * m[6], m[1] * m[6] - m[0] * m[7], m[0] * m[4] - m[1] * m[3]
  ];
  const mulmm = (a, b) => {
    const r = [];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      let s = 0;
      for (let k = 0; k < 3; k++) s += a[3 * i + k] * b[3 * k + j];
      r[3 * i + j] = s;
    }
    return r;
  };
  const mulmv = (m, v) => [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2]
  ];
  const basis = (x1, y1, x2, y2, x3, y3, x4, y4) => {
    const m = [x1, x2, x3, y1, y2, y3, 1, 1, 1];
    const v = mulmv(adj(m), [x4, y4, 1]);
    return mulmm(m, [v[0], 0, 0, 0, v[1], 0, 0, 0, v[2]]);
  };
  const src = basis(0, 0, w, 0, 0, h, w, h);
  const db = basis(dst[0][0], dst[0][1], dst[1][0], dst[1][1], dst[2][0], dst[2][1], dst[3][0], dst[3][1]);
  const t = mulmm(db, adj(src));
  if (!t[8]) return null;
  for (let i = 0; i < 9; i++) t[i] = t[i] / t[8];
  // Reject a homography that would fling the border across the page. The mapping
  // magnifies a source point by ~1/w, where w = t6*x + t7*y + 1 is the perspective
  // divisor; as w nears 0 the content shoots toward infinity and covers chat. The
  // catch is *where* w matters: content committed beneath the distort (a rotate's
  // tips, resize overflow) paints well outside the unit box, so checking w only at
  // [0,1] corners (as this once did) misses the blowup — a plain trapezoid can have
  // healthy corner w yet tiny w a little past the edge. w is linear, so its minimum
  // over any rectangle is at a corner: evaluate it at the corners of the region the
  // border can actually reach (MARGIN past the box) and refuse anything that lets
  // the magnification top ~1/FLOOR. This runs at drag time (the dragged corner
  // reverts, so a handle simply stops at the safe line) and at render time (a bad
  // saved op flattens to no transform instead of exploding). No downstream clip is
  // needed because the blowup never forms.
  const MARGIN = 0.5, FLOOR = 0.4;
  const wAt = (x, y) => t[6] * x + t[7] * y + 1;
  const region = [wAt(-MARGIN * w, -MARGIN * h), wAt((1 + MARGIN) * w, -MARGIN * h), wAt(-MARGIN * w, (1 + MARGIN) * h), wAt((1 + MARGIN) * w, (1 + MARGIN) * h)];
  if (!region.every((v) => Number.isFinite(v) && v > FLOOR)) return null;
  const m = [t[0], t[3], 0, t[6], t[1], t[4], 0, t[7], 0, 0, 1, 0, t[2], t[5], 0, t[8]];
  if (!m.every((v) => Number.isFinite(v))) return null;
  return `matrix3d(${m.join(',')})`;
},

// Live-update only the outermost draft wrapper + handles while dragging, so the
// image and committed layers are never rebuilt (no reload flicker).
_applyBorderDraft() {
  const stage = document.getElementById('border-crop-preview');
  if (!stage) return;
  const draft = stage.querySelector('.bce-draft');
  if (draft) {
    const W = stage.clientWidth || 192, H = stage.clientHeight || 192;
    draft.style.cssText = this._borderWrapperStyle(this._borderDraft, W, H, this._committedContentBox());
  }
  this._positionBorderHandles();
  // A manual crop drag makes the draft a crop; keep the auto-crop button in sync.
  const autocropBtn = document.getElementById('border-crop-autocrop-btn');
  if (autocropBtn) autocropBtn.disabled = this._hasCrop();
},

// Place the active tool's handles in stage-fraction space. The draft is applied
// as the outermost, screen-aligned layer, so handles never chase warped edges.
_positionBorderHandles() {
  const stage = document.getElementById('border-crop-preview');
  if (!stage) return;
  const W = stage.clientWidth || 192, H = stage.clientHeight || 192;
  const tool = this._borderTool;
  const d = this._borderDraft || this._borderOpBase(tool);
  const place = (sel, fx, fy) => {
    const el = stage.querySelector(sel);
    if (el) { el.style.left = (fx * W) + 'px'; el.style.top = (fy * H) + 'px'; }
  };
  if (tool === 'crop') {
    // Handles sit on the current content box edges (so they reflect prior crops,
    // resizes and moves), and the draft trims further in from there.
    const cb = this._committedContentBox();
    const cw = cb.right - cb.left, ch = cb.bottom - cb.top;
    place('.crop-top', 0.5, cb.top + d.top * ch);
    place('.crop-bottom', 0.5, cb.bottom - d.bottom * ch);
    place('.crop-left', cb.left + d.left * cw, 0.5);
    place('.crop-right', cb.right - d.right * cw, 0.5);
  } else if (tool === 'distort') {
    place('.corner-tl', d.tl[0], d.tl[1]);
    place('.corner-tr', 1 + d.tr[0], d.tr[1]);
    place('.corner-bl', d.bl[0], 1 + d.bl[1]);
    place('.corner-br', 1 + d.br[0], 1 + d.br[1]);
  } else if (tool === 'resize') {
    // Pin to the frame corner once scaled past it so the grip stays grabbable.
    const s = Math.min(1, 0.5 + 0.5 * d.scale);
    place('.scale-handle', s, s);
  } else if (tool === 'rotate') {
    const a = (d.deg || 0) * Math.PI / 180;
    place('.rotate-handle', 0.5 + 0.6 * Math.sin(a), 0.5 - 0.6 * Math.cos(a));
  }
},

// Render the op log as the side list; each row undoes itself and everything after.
_renderBorderHistory() {
  const list = document.getElementById('border-crop-history');
  if (!list) return;
  const tr = (k, f) => (window.t ? window.t(k) : f);
  if (!this._borderOps.length) {
    list.innerHTML = `<div class="bce-hist-empty">${tr('modals.border_crop.no_edits', 'No edits yet')}</div>`;
    return;
  }
  const glyph = { crop: '▣', move: '✥', resize: '⤢', rotate: '⟳', opacity: '◐', distort: '◇' };
  const undoTitle = tr('modals.border_crop.undo', 'Undo this and later edits');
  list.innerHTML = this._borderOps.map((op, i) =>
    `<div class="bce-hist-row"><span class="bce-hist-label">${glyph[op.type] || ''} ${tr('modals.border_crop.mode_' + op.type, op.type)}</span>` +
    `<button type="button" class="bce-hist-undo" data-index="${i}" title="${undoTitle}">↶</button></div>`
  ).join('');
},

// Would committing this op push the content clearly out of frame? Only resize/crop/
// move move the box, and crop/move are already clamped at their handles, so in practice
// this only catches a resize that drifts a moved (off-centre) frame out.
// The guards let a frame overhang the avatar by _borderOverflowFrac() (of); an off-centre
// frame (moved, or auto-cropped from an off-centre image) legitimately resizes a bit past
// [-of, 1+of], so we only refuse once it overhangs by another full allowance (2*of) — i.e.
// genuinely out of frame, not merely at the guard's edge. Widen the 2x multiplier to be
// more permissive.
_borderBoxExceeds(op) {
  const box = this._advanceBox(this._committedContentBox(), op);
  const lim = 2 * this._borderOverflowFrac();
  return box.left < -lim || box.top < -lim || box.right > 1 + lim || box.bottom > 1 + lim;
},

// Commit-on-leave: keep the draft only if it actually changed something.
_commitBorderDraft() {
  const d = this._borderDraft;
  this._borderDraft = null;
  if (d && d.type === 'opacity') {
    // Opacity is a single absolute value, not a stack: drop any prior opacity op,
    // then keep the new one only if it actually fades (value 1 = fully opaque).
    this._borderOps = this._borderOps.filter((op) => op.type !== 'opacity');
    if (this._borderOpChanged(d)) this._borderOps.push(d);
    return;
  }
  if (!this._borderOpChanged(d)) return;
  // The per-tool guards keep legitimate edits inside the avatar, but resize scales
  // about the stage centre, so enlarging a frame that was first moved into a corner
  // can drift it out of frame. Rather than persist an out-of-frame fit, discard the
  // change and tell the user (this runs at the commit a tool switch / Done triggers).
  if (this._borderBoxExceeds(d)) {
    const msg = (window.t && window.t('modals.border_crop.exceeds_frame')) || 'The border exceeds the avatar frame, discarded changes';
    this._showToast(msg, 'error');
    return;
  }
  this._borderOps.push(d);
},

// Switch tools (or re-enter the same one): commit the current draft, then start a
// fresh neutral engagement. Re-entering the active tool is how repeats are made.
_selectBorderTool(tool) {
  this._commitBorderDraft();
  this._borderTool = tool;
  // Opacity seeds its draft from the current committed value so the slider shows
  // it, and the draft supersedes the committed op in the preview (see the fold in
  // _renderBorderEditor), giving the full 1..100 range instead of only fading more.
  if (tool === 'opacity') this._borderDraft = { type: 'opacity', value: this._committedOpacity() };
  const modes = document.getElementById('border-crop-modes');
  if (modes) modes.querySelectorAll('.border-crop-mode-btn').forEach((b) => b.classList.toggle('active', b.dataset.mode === tool));
  const stage = document.getElementById('border-crop-preview');
  if (stage) stage.className = 'border-crop-preview mode-' + tool;
  this._renderBorderEditor();
},

// "Crop out invisible pixels": drop a crop draft whose four insets surround the
// border's opaque region, so the handles jump to the real image and the user can
// tweak, keep, or discard from there. Each side is measured independently, so an
// uneven frame crops correctly. Pure convenience: it only positions the draft, the
// same as dragging the handles by hand, and saves nothing.
//
// Reads the border <img> already in the editor, synchronously inside the click, so
// the canvas read stays in the user-gesture window; deferring it to an async image
// load trips Firefox's canvas-extraction privacy block ("no user input detected").
// A crop exists if one is committed, or the current draft is a crop that changed.
// Auto-crop reads the raw image, so it is only valid before any crop; once one
// exists it would stack a second crop, so the button (and this) refuse.
_hasCrop() {
  return this._borderOps.some((op) => op.type === 'crop') ||
    (this._borderDraft && this._borderDraft.type === 'crop' && this._borderOpChanged(this._borderDraft));
},

_autoCropInvisible() {
  if (this._hasCrop()) return;
  const img = document.querySelector('.border-crop-border');
  if (!img || !img.complete || !img.naturalWidth) return;
  const nw = img.naturalWidth, nh = img.naturalHeight;
  // Draw into a square canvas with the stage's object-fit:contain layout, so a
  // canvas pixel maps 1:1 to a stage fraction (letterbox padding included as-is).
  const D = 400;
  const canvas = document.createElement('canvas');
  canvas.width = D; canvas.height = D;
  const ctx = canvas.getContext('2d');
  const scale = Math.min(D / nw, D / nh);
  const dw = nw * scale, dh = nh * scale;
  ctx.drawImage(img, (D - dw) / 2, (D - dh) / 2, dw, dh);
  let data;
  try { data = ctx.getImageData(0, 0, D, D).data; } catch (e) { return; } // blocked/tainted: no-op
  // Opaque bounding box; alpha threshold ignores near-transparent AA fringe.
  const A = 10;
  let top = -1, bottom = -1, left = -1, right = -1;
  for (let y = 0; y < D; y++) {
    for (let x = 0; x < D; x++) {
      if (data[(y * D + x) * 4 + 3] > A) {
        if (top < 0) top = y;
        bottom = y;
        if (left < 0 || x < left) left = x;
        if (x > right) right = x;
      }
    }
  }
  if (top < 0) return; // fully transparent, nothing to surround
  // Opaque edges as stage fractions, then expressed as a trim of the current
  // content box (same mapping as a manual crop drag), so it composes with prior ops.
  const cb = this._committedContentBox();
  const cw = cb.right - cb.left, ch = cb.bottom - cb.top;
  const clamp = (f) => Math.min(0.49, Math.max(0, f));
  this._borderDraft = {
    type: 'crop',
    top: clamp((top / D - cb.top) / ch),
    right: clamp((cb.right - (right + 1) / D) / cw),
    bottom: clamp((cb.bottom - (bottom + 1) / D) / ch),
    left: clamp((left / D - cb.left) / cw)
  };
  this._renderBorderEditor();
},

// +/-90 rotate nudge from the Rotate tool buttons. Acts on the current draft and
// wraps through 0..360 exactly like the drag handle, so 300 + 90 lands at 30.
_nudgeRotate(delta) {
  if (this._borderTool !== 'rotate') return;
  if (!this._borderDraft || this._borderDraft.type !== 'rotate') this._borderDraft = this._borderOpBase('rotate');
  this._borderDraft.deg = (((this._borderDraft.deg + delta) % 360) + 360) % 360;
  this._applyBorderDraft();
},

// Opacity tool: the slider (1..100) drives the current draft's fraction (0.01..1).
_setOpacity(percent) {
  if (this._borderTool !== 'opacity') return;
  if (!this._borderDraft || this._borderDraft.type !== 'opacity') this._borderDraft = this._borderOpBase('opacity');
  this._borderDraft.value = Math.min(1, Math.max(0.01, (Number(percent) || 100) / 100));
  this._applyBorderDraft();
},

// Bind the editor once. Pointer drags mutate the current draft op; the tool
// selector, Discard, and per-row Undo are wired here too.
_setupBorderEditor() {
  if (this._borderEditorBound) return;
  const box = document.getElementById('border-crop-box');
  const stage = document.getElementById('border-crop-preview');
  if (!box || !stage) return;
  this._borderEditorBound = true;

  let active = null;

  const onMove = (e) => {
    if (!active) return;
    const rect = stage.getBoundingClientRect();
    const d = this._borderDraft;
    const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
    if (active.type === 'move') {
      const dx = (e.clientX - active.startX) / rect.width;
      const dy = (e.clientY - active.startY) / rect.height;
      // Keep every edge within [-overflow, 1+overflow] of the stage. The range
      // always includes 0, so grabbing never snaps a pre-existing overflow: you
      // can pull an out-of-bounds edge back in, but not push any edge further out.
      const box = active.box, of = active.overflow;
      const clampAxis = (v, e0, e1) => Math.min(Math.max(0, (1 + of) - e1), Math.max(Math.min(0, -of - e0), v));
      d.x = clampAxis(active.baseX + dx, box.left, box.right);
      d.y = clampAxis(active.baseY + dy, box.top, box.bottom);
    } else if (active.type === 'distort') {
      const dx = (e.clientX - active.startX) / rect.width;
      const dy = (e.clientY - active.startY) / rect.height;
      const prev = d[active.corner];
      // Keep the dragged corner within the allowed overflow of the stage.
      const of = active.overflow, base = active.base;
      let nx = active.baseOff[0] + dx, ny = active.baseOff[1] + dy;
      nx = Math.min((1 + of) - base[0], Math.max(-of - base[0], nx));
      ny = Math.min((1 + of) - base[1], Math.max(-of - base[1], ny));
      d[active.corner] = [nx, ny];
      // Reject the move if it folds the quad (perimeter order) or produces a
      // degenerate/exploding homography — that is what breaks chat when saved.
      const q = [[d.tl[0], d.tl[1]], [1 + d.tr[0], d.tr[1]], [1 + d.br[0], 1 + d.br[1]], [d.bl[0], 1 + d.bl[1]]];
      const W = rect.width, H = rect.height;
      const dst = [[d.tl[0] * W, d.tl[1] * H], [(1 + d.tr[0]) * W, d.tr[1] * H], [d.bl[0] * W, (1 + d.bl[1]) * H], [(1 + d.br[0]) * W, (1 + d.br[1]) * H]];
      if (!this._isConvex(q) || !this._computeMatrix3d(W, H, dst)) d[active.corner] = prev;
    } else if (active.type === 'resize') {
      const dist = Math.hypot(e.clientX - cx, e.clientY - cy);
      d.scale = Math.min(active.maxScale, Math.max(0.1, active.baseScale * (dist / active.startDist)));
    } else if (active.type === 'rotate') {
      const ang = Math.atan2(e.clientY - cy, e.clientX - cx) * 180 / Math.PI;
      d.deg = (((active.baseDeg + (ang - active.startAng)) % 360) + 360) % 360;
    } else if (active.type === 'crop') {
      // Map the pointer to a trim fraction of the current content box, so the drag
      // starts from the existing crop edges and composes with prior ops.
      const cb = active.box, cw = cb.right - cb.left, ch = cb.bottom - cb.top;
      const px = (e.clientX - rect.left) / rect.width, py = (e.clientY - rect.top) / rect.height;
      let f = 0;
      if (active.edge === 'left')   f = (px - cb.left) / cw;
      if (active.edge === 'right')  f = (cb.right - px) / cw;
      if (active.edge === 'top')    f = (py - cb.top) / ch;
      if (active.edge === 'bottom') f = (cb.bottom - py) / ch;
      d[active.edge] = Math.min(0.49, Math.max(0, f));
    }
    this._applyBorderDraft();
  };

  const onUp = () => {
    active = null;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
  };

  box.addEventListener('pointerdown', (e) => {
    const tool = this._borderTool;
    const handle = e.target.closest('.border-crop-handle');
    const rect = stage.getBoundingClientRect();
    const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;

    // Decide what this drag controls; bail if it is not valid for the active tool.
    let start = null;
    if (tool === 'move' && !handle) {
      start = { type: 'move', startX: e.clientX, startY: e.clientY };
    } else if (handle && tool === 'distort' && handle.classList.contains('corner-handle')) {
      start = { type: 'distort', corner: handle.dataset.corner, startX: e.clientX, startY: e.clientY };
    } else if (handle && tool === 'resize' && handle.classList.contains('scale-handle')) {
      start = { type: 'resize', startDist: Math.max(1, Math.hypot(e.clientX - cx, e.clientY - cy)) };
    } else if (handle && tool === 'rotate' && handle.classList.contains('rotate-handle')) {
      start = { type: 'rotate', startAng: Math.atan2(e.clientY - cy, e.clientX - cx) * 180 / Math.PI };
    } else if (handle && tool === 'crop' && handle.classList.contains('crop-edge')) {
      start = { type: 'crop', edge: handle.dataset.edge };
    }
    if (!start) return;
    e.preventDefault();

    // First change of the engagement creates the draft; capture its base values.
    if (!this._borderDraft) this._borderDraft = this._borderOpBase(tool);
    const d = this._borderDraft;
    if (start.type === 'move')    { start.baseX = d.x; start.baseY = d.y; start.box = this._committedContentBox(); start.overflow = this._borderOverflowFrac(); }
    if (start.type === 'crop')    { start.box = this._committedContentBox(); }
    if (start.type === 'distort') { start.baseOff = d[start.corner].slice(); start.base = { tl: [0, 0], tr: [1, 0], bl: [0, 1], br: [1, 1] }[start.corner]; start.overflow = this._borderOverflowFrac(); }
    if (start.type === 'resize')  { start.baseScale = d.scale; start.maxScale = this._resizeMaxScale(); }
    if (start.type === 'rotate')  { start.baseDeg = d.deg; }
    active = start;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  });

  // Tool selector: switching (or re-clicking the active one) commits the draft.
  const modes = document.getElementById('border-crop-modes');
  if (modes) {
    modes.addEventListener('click', (e) => {
      const btn = e.target.closest('.border-crop-mode-btn');
      if (btn) this._selectBorderTool(btn.dataset.mode);
    });
  }

  // Auto-crop the border's invisible padding into the crop draft.
  const autocropBtn = document.getElementById('border-crop-autocrop-btn');
  if (autocropBtn) autocropBtn.addEventListener('click', () => this._autoCropInvisible());

  // Quarter-turn rotate nudges.
  const rotCw = document.getElementById('border-rotate-cw');
  const rotCcw = document.getElementById('border-rotate-ccw');
  if (rotCw) rotCw.addEventListener('click', () => this._nudgeRotate(90));
  if (rotCcw) rotCcw.addEventListener('click', () => this._nudgeRotate(-90));

  // Opacity slider.
  const opacitySlider = document.getElementById('border-opacity-slider');
  if (opacitySlider) opacitySlider.addEventListener('input', (e) => {
    const val = document.getElementById('border-opacity-value');
    if (val) val.textContent = e.target.value + '%';
    this._setOpacity(e.target.value);
  });

  // Resize anchor: a sticky Center/Corner choice applied to resize ops.
  const anchorSel = document.getElementById('border-resize-anchor');
  if (anchorSel) anchorSel.addEventListener('change', (e) => {
    this._resizeAnchor = e.target.value === 'corner' ? 'corner' : 'center';
    if (this._borderDraft && this._borderDraft.type === 'resize') {
      this._borderDraft.anchor = this._resizeAnchor;
      this._renderBorderEditor();
    }
  });

  // Discard drops the current uncommitted draft only; committed ops are untouched.
  const discardBtn = document.getElementById('border-crop-reset-btn');
  if (discardBtn) {
    discardBtn.addEventListener('click', () => {
      this._borderDraft = null;
      this._renderBorderEditor();
    });
  }

  // Per-row Undo truncates the log from that op onward (dropping any draft first).
  const history = document.getElementById('border-crop-history');
  if (history) {
    history.addEventListener('click', (e) => {
      const btn = e.target.closest('.bce-hist-undo');
      if (!btn) return;
      this._borderDraft = null;
      this._borderOps.length = parseInt(btn.dataset.index, 10);
      this._renderBorderEditor();
    });
  }
},

_setupAvatarUpload() {
  console.log('[Avatar Setup v6] Initializing with HTTP upload model...');
  if (this._avatarDelegationActive) return;
  this._avatarDelegationActive = true;

  // Pending state — nothing is saved until the user clicks Save
  this._pendingAvatarFile = null;       // raw File object from <input>
  this._pendingAvatarPreviewUrl = null; // local preview data URL (display only)
  this._pendingAvatarRemoved = false;   // user clicked Clear
  this._pendingAvatarShape = this.user.avatarShape || localStorage.getItem('haven_avatar_shape') || 'circle';
  this._avatarShape = this._pendingAvatarShape;

  // Border pending state, saved through the same Save button
  this._pendingBorderFile = null;
  this._pendingBorderPreviewUrl = null;
  this._pendingBorderRemoved = false;

  // Animated-profile policy, saved through the same Save button
  this._animateProfile = this.user.animateProfile === 'disabled' ? 'disabled' : 'trigger';
  this._pendingAnimateProfile = this._animateProfile;

  // Initialize preview + shape buttons
  this._updateAvatarPreview();
  this._updateBorderPreview();
  const picker = document.getElementById('avatar-shape-picker');
  if (picker) {
    picker.querySelectorAll('.avatar-shape-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.shape === this._pendingAvatarShape);
    });
  }

  // ── Delegated click handler ──
  document.addEventListener('click', (e) => {
    // Shape buttons
    const shapeBtn = e.target.closest('.avatar-shape-btn');
    if (shapeBtn) {
      e.preventDefault();
      const container = document.getElementById('avatar-shape-picker');
      if (container) container.querySelectorAll('.avatar-shape-btn').forEach(b => b.classList.remove('active'));
      shapeBtn.classList.add('active');
      this._pendingAvatarShape = shapeBtn.dataset.shape;
      this._markAvatarUnsaved();
      return;
    }

    // Upload button → trigger file picker
    if (e.target.closest('#avatar-upload-btn')) {
      e.preventDefault();
      e.stopPropagation();
      const fileInput = document.getElementById('avatar-file-input');
      if (fileInput) { fileInput.value = ''; fileInput.click(); }
      return;
    }

    // Clear/Remove button
    if (e.target.closest('#avatar-remove-btn')) {
      e.preventDefault();
      this._pendingAvatarFile = null;
      this._pendingAvatarPreviewUrl = null;
      this._pendingAvatarRemoved = true;
      const preview = document.getElementById('avatar-upload-preview');
      if (preview) {
        const color = this._getUserColor(this.user.username);
        const initial = this.user.username.charAt(0).toUpperCase();
        preview.innerHTML = `<div style="background-color:${color};width:100%;height:100%;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:1.125rem;color:white">${initial}</div>`;
      }
      this._markAvatarUnsaved();
      return;
    }

    // Border upload button → trigger file picker
    if (e.target.closest('#border-upload-btn')) {
      e.preventDefault();
      e.stopPropagation();
      const fileInput = document.getElementById('border-file-input');
      if (fileInput) { fileInput.value = ''; fileInput.click(); }
      return;
    }

    // Border Edit button → open the op-log editor. _borderOps is seeded from the
    // saved fit when the Edit Profile modal opens and reset to [] on image change,
    // so it already holds the right starting log here.
    if (e.target.closest('#border-crop-btn')) {
      e.preventDefault();
      if (!Array.isArray(this._borderOps)) this._borderOps = [];
      this._borderDraft = null;
      this._borderTool = 'crop';
      this._resizeAnchor = 'center';
      this._setupBorderEditor();
      const modal = document.getElementById('border-crop-modal');
      // Show the modal first so the stage has real dimensions before rendering.
      if (modal) modal.style.display = 'flex';
      this._selectBorderTool('crop');
      return;
    }

    // Done → commit the in-progress draft (commit-on-leave) and close.
    if (e.target.closest('#border-crop-done-btn')) {
      e.preventDefault();
      this._commitBorderDraft();
      const modal = document.getElementById('border-crop-modal');
      if (modal) modal.style.display = 'none';
      return;
    }

    // Border clear/remove button
    if (e.target.closest('#border-remove-btn')) {
      e.preventDefault();
      this._pendingBorderFile = null;
      this._pendingBorderPreviewUrl = null;
      this._pendingBorderRemoved = true;
      // Removing the image invalidates its fit.
      this._borderOps = [];
      this._borderDraft = null;
      const preview = document.getElementById('border-upload-preview');
      if (preview) preview.innerHTML = `<div style="width:100%;height:100%;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:0.7rem;color:var(--text-muted)">None</div>`;
      this._updateBorderEditButton();
      this._markAvatarUnsaved();
      return;
    }

    // Save button
    if (e.target.closest('#avatar-save-btn')) {
      e.preventDefault();
      this._commitAvatarSettings();
      return;
    }
  });

  // File input change → stage the file, show local preview
  document.addEventListener('change', (e) => {
    if (e.target && e.target.id === 'animate-profile-select') {
      this._pendingAnimateProfile = e.target.value === 'disabled' ? 'disabled' : 'trigger';
      this._markAvatarUnsaved();
      return;
    }

    if (e.target && e.target.id === 'avatar-file-input') {
      const file = e.target.files[0];
      if (!file) return;
      if (file.size > 5 * 1024 * 1024) return this._showToast('Image too large (max 5 MB)', 'error');
      if (!file.type.startsWith('image/')) return this._showToast('Not an image file', 'error');

      this._pendingAvatarFile = file;
      this._pendingAvatarRemoved = false;

      // Show local preview immediately (not sent to server yet)
      const reader = new FileReader();
      reader.onload = (ev) => {
        this._pendingAvatarPreviewUrl = ev.target.result;
        const preview = document.getElementById('avatar-upload-preview');
        if (preview) {
          const img = document.createElement('img');
          img.src = ev.target.result;
          img.alt = 'avatar preview';
          preview.innerHTML = '';
          preview.appendChild(img);
        }
        this._markAvatarUnsaved();
      };
      reader.readAsDataURL(file);
    }

    if (e.target && e.target.id === 'border-file-input') {
      const file = e.target.files[0];
      if (!file) return;
      if (file.size > 5 * 1024 * 1024) return this._showToast((window.t && window.t('toasts.image_too_large', { max: 5 })) || 'Image too large (max 5 MB)', 'error');
      if (!file.type.startsWith('image/')) return this._showToast((window.t && window.t('toasts.not_an_image')) || 'Not an image file', 'error');

      this._pendingBorderFile = file;
      this._pendingBorderRemoved = false;
      // A new image starts with a clean fit.
      this._borderOps = [];
      this._borderDraft = null;

      const reader = new FileReader();
      reader.onload = (ev) => {
        this._pendingBorderPreviewUrl = ev.target.result;
        const preview = document.getElementById('border-upload-preview');
        if (preview) {
          const img = document.createElement('img');
          img.src = ev.target.result;
          img.alt = 'border preview';
          preview.innerHTML = '';
          preview.appendChild(img);
        }
        this._updateBorderEditButton();
        this._markAvatarUnsaved();
      };
      reader.readAsDataURL(file);
    }
  });

  this._setupPfpBorderObserver();
  this._setupPfpAnimationTriggers();
  console.log('[Avatar Setup v6] Ready.');
},

_markAvatarUnsaved() {
  const status = document.getElementById('avatar-save-status');
  if (status) { status.textContent = 'Unsaved changes'; status.style.color = 'var(--warning, orange)'; }
},

// Commit pending avatar + shape to the server via HTTP (not socket!)
async _commitAvatarSettings() {
  const status = document.getElementById('avatar-save-status');
  if (status) { status.textContent = 'Saving...'; status.style.color = 'var(--text-secondary)'; }

  try {
    // 1. Upload avatar image via HTTP if a new file was chosen
    if (this._pendingAvatarFile) {
      const formData = new FormData();
      formData.append('avatar', this._pendingAvatarFile);
      const resp = await fetch('/api/upload-avatar', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${this.token}` },
        body: formData
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Upload failed');

      // Server stored the file and returned the URL path
      this.user.avatar = data.url;
      localStorage.setItem('haven_user', JSON.stringify(this.user));
      this._pendingAvatarFile = null;
      this._pendingAvatarPreviewUrl = null;
      
      // Update preview to use the server URL
      const preview = document.getElementById('avatar-upload-preview');
      if (preview) {
        const img = document.createElement('img');
        img.src = data.url;
        img.alt = 'avatar';
        preview.innerHTML = '';
        preview.appendChild(img);
      }
      
      // Notify connected sockets about the avatar change (small URL, not data URL)
      if (this.socket) this.socket.emit('set-avatar', { url: data.url });
    }

    // 2. Remove avatar if Clear was clicked
    if (this._pendingAvatarRemoved) {
      const resp = await fetch('/api/remove-avatar', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Content-Type': 'application/json'
        }
      });
      if (!resp.ok) throw new Error('Failed to remove avatar');

      this.user.avatar = null;
      localStorage.setItem('haven_user', JSON.stringify(this.user));
      this._pendingAvatarRemoved = false;
      
      if (this.socket) this.socket.emit('set-avatar', { url: '' });
    }

    // 2b. Upload border image via HTTP if a new file was chosen
    if (this._pendingBorderFile) {
      const formData = new FormData();
      formData.append('border', this._pendingBorderFile);
      const resp = await fetch('/api/upload-border', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${this.token}` },
        body: formData
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Upload failed');

      this.user.border = data.url;
      localStorage.setItem('haven_user', JSON.stringify(this.user));
      this._pendingBorderFile = null;
      this._pendingBorderPreviewUrl = null;
      this._updateBorderPreview();

      if (this.socket) this.socket.emit('set-border', { url: data.url });
    }

    // 2c. Remove border if Clear was clicked
    if (this._pendingBorderRemoved) {
      const resp = await fetch('/api/remove-border', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Content-Type': 'application/json'
        }
      });
      if (!resp.ok) throw new Error('Failed to remove border');

      this.user.border = null;
      localStorage.setItem('haven_user', JSON.stringify(this.user));
      this._pendingBorderRemoved = false;

      if (this.socket) this.socket.emit('set-border', { url: '' });
    }

    // 2d. Persist the border fit (op log), bound to the current border image.
    // No image means no fit to store; the remove/upload endpoints already
    // cleared any stale transform server-side.
    this._commitBorderDraft();
    if (this.user.border) {
      const transform = Array.isArray(this._borderOps) ? this._borderOps : [];
      const current = Array.isArray(this.user.borderTransform) ? this.user.borderTransform : [];
      if (JSON.stringify(transform) !== JSON.stringify(current)) {
        const resp = await fetch('/api/set-border-transform', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${this.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ transform })
        });
        if (!resp.ok) throw new Error('Failed to save border fit');
        const data = await resp.json();
        this.user.borderTransform = data.transform || null;
        localStorage.setItem('haven_user', JSON.stringify(this.user));
        if (this.socket) this.socket.emit('set-border-transform', { transform: this.user.borderTransform || [] });
      }
    } else if (this.user.borderTransform) {
      // Border was removed; drop the now-orphaned fit locally.
      this.user.borderTransform = null;
      localStorage.setItem('haven_user', JSON.stringify(this.user));
    }

    // 3. Save shape via HTTP
    if (this._pendingAvatarShape !== this._avatarShape) {
      const resp = await fetch('/api/set-avatar-shape', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ shape: this._pendingAvatarShape })
      });
      if (!resp.ok) throw new Error('Failed to save shape');

      this._avatarShape = this._pendingAvatarShape;
      this.user.avatarShape = this._pendingAvatarShape;
      localStorage.setItem('haven_avatar_shape', this._pendingAvatarShape);
      localStorage.setItem('haven_user', JSON.stringify(this.user));
      
      if (this.socket) this.socket.emit('set-avatar-shape', { shape: this._pendingAvatarShape });
    }

    // 4. Save animated-profile policy via HTTP
    if (this._pendingAnimateProfile !== this._animateProfile) {
      const resp = await fetch('/api/set-animate-profile', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ mode: this._pendingAnimateProfile })
      });
      if (!resp.ok) throw new Error('Failed to save animation policy');

      this._animateProfile = this._pendingAnimateProfile;
      this.user.animateProfile = this._pendingAnimateProfile;
      localStorage.setItem('haven_user', JSON.stringify(this.user));

      if (this.socket) this.socket.emit('set-animate-profile', { mode: this._pendingAnimateProfile });
    }

    if (status) { status.textContent = '✅ Saved!'; status.style.color = 'var(--success, #6f6)'; }
    this._showToast('Avatar settings saved!', 'success');
    setTimeout(() => { if (status) status.textContent = ''; }, 3000);

  } catch (err) {
    console.error('[Avatar] Save failed:', err);
    if (status) { status.textContent = '❌ ' + err.message; status.style.color = 'var(--danger, red)'; }
    this._showToast('Failed to save: ' + err.message, 'error');
  }
},

_applyAvatarShape() {
  // No-op: shapes are now per-user and rendered from server data per message.
  // This function is kept as a safe stub in case it's called elsewhere.
},

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// SOUND MANAGER (Full Popout — Admin + User)
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

_setupSoundManagement() {
  this.customSounds = [];
  this._soundHotkeys = JSON.parse(localStorage.getItem('haven_sound_hotkeys') || '{}'); // { hotkey: soundName }
  this._recordingHotkeyFor = null; // soundName currently recording hotkey
  this._soundCooldowns = {};       // hotkey

  this._soundPrefs = {}; // { soundName: { hidden, customOrder } }
  this._showHiddenSounds = false;
  this._soundboardSidebarMode = localStorage.getItem('haven_soundboard_sidebar_mode') === 'true';
  this._soundboardListMode = localStorage.getItem('haven_soundboard_list_mode') === 'true';
  this._loadUserSoundPrefs();

  // Open from admin "Manage Sounds" button
  const openBtn = document.getElementById('open-sound-manager-btn');
  if (openBtn) {
    openBtn.addEventListener('click', () => this._openSoundModal('manage'));
  }
  // Open from user "Sound Manager" button
  const openUserBtn = document.getElementById('open-sound-manager-user-btn');
  if (openUserBtn) {
    openUserBtn.addEventListener('click', () => this._openSoundModal('soundboard'));
  }

  // Close sound modal
  document.getElementById('close-sound-modal-btn')?.addEventListener('click', () => {
    document.getElementById('sound-modal').style.display = 'none';
  });
  document.getElementById('sound-modal')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) e.currentTarget.style.display = 'none';
  });

  // Close soundboard sidebar panel (no longer needed — toggle btn handles this)

  // Soundboard sidebar toggle button
  document.getElementById('sb-sidebar-toggle-btn')?.addEventListener('click', () => {
    this._toggleSoundboardSidebar();
  });

  // Soundboard sidebar resize handle
  {
    const sbPanel = document.getElementById('sb-sidebar-panel');
    const sbResizeHandle = document.getElementById('sb-sidebar-resize-handle');
    if (sbPanel && sbResizeHandle) {
      const savedWidth = localStorage.getItem('haven_sb_sidebar_width');
      if (savedWidth) sbPanel.style.width = savedWidth + 'px';

      let sbDragging = false, sbStartX = 0, sbStartW = 0;
      sbResizeHandle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        sbDragging = true;
        sbStartX = e.clientX;
        sbStartW = sbPanel.getBoundingClientRect().width;
        sbResizeHandle.classList.add('dragging');
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
      });
      document.addEventListener('mousemove', (e) => {
        if (!sbDragging) return;
        let w = sbStartW + (sbStartX - e.clientX);
        w = Math.max(160, Math.min(420, w));
        sbPanel.style.width = w + 'px';
        window._updateSbToggleRight?.(); // keep voice/users btn aligned during drag
      });
      document.addEventListener('mouseup', () => {
        if (!sbDragging) return;
        sbDragging = false;
        sbResizeHandle.classList.remove('dragging');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        localStorage.setItem('haven_sb_sidebar_width', parseInt(sbPanel.style.width));
        window._updateSbToggleRight?.();
      });
    }
  }

  // Tab switching
  document.querySelectorAll('.sound-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.sound-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.sound-tab-content').forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      const target = document.getElementById(`sound-tab-${tab.dataset.tab}`);
      if (target) target.classList.add('active');
    });
  });

  // Upload button (admin)
  const uploadBtn = document.getElementById('sound-upload-btn');
  const fileInput = document.getElementById('sound-file-input');
  const nameInput = document.getElementById('sound-name-input');
  if (uploadBtn && fileInput) {
    uploadBtn.addEventListener('click', async () => {
      const file = fileInput.files[0];
      const name = nameInput ? nameInput.value.trim() : '';
      if (!file) return this._showToast('Select an audio file', 'error');
      if (!name) return this._showToast('Enter a sound name', 'error');
      const maxSoundKb = parseInt(this.serverSettings?.max_sound_kb) || 1024;
      if (file.size > maxSoundKb * 1024) return this._showToast(`Sound file too large (max ${maxSoundKb >= 1024 ? (maxSoundKb / 1024) + ' MB' : maxSoundKb + ' KB'})`, 'error');

      const formData = new FormData();
      formData.append('sound', file);
      formData.append('name', name);

      try {
        this._showToast('Uploading sound...', 'info');
        const res = await fetch('/api/upload-sound', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${this.token}` },
          body: formData
        });
        if (!res.ok) {
          let errMsg = `Upload failed (${res.status})`;
          try { const d = await res.json(); errMsg = d.error || errMsg; } catch {}
          return this._showToast(errMsg, 'error');
        }
        this._showToast(`Sound "${name}" uploaded!`, 'success');
        fileInput.value = '';
        nameInput.value = '';
        this._loadCustomSounds();
      } catch {
        this._showToast('Upload failed', 'error');
      }
    });
  }

  
  // Show/hide hidden sounds toggle
  const showHiddenCheckbox = document.getElementById('soundboard-show-hidden');
  if (showHiddenCheckbox) {
    showHiddenCheckbox.addEventListener('change', (e) => {
      this._showHiddenSounds = e.target.checked;
      this._renderSoundboard(
        this._soundboardPip
          ? (document.getElementById('sb-pip-search')?.value?.trim() || '')
          : (document.getElementById('soundboard-search')?.value?.trim() || '')
      );
    });
  }

  // List view mode toggle (popup/pip grid layout — separate from sidebar mode)
  const listModeCheckbox = document.getElementById('soundboard-list-mode');
  if (listModeCheckbox) {
    listModeCheckbox.checked = this._soundboardListMode;
    listModeCheckbox.addEventListener('change', (e) => {
      this._soundboardListMode = e.target.checked;
      localStorage.setItem('haven_soundboard_list_mode', this._soundboardListMode ? 'true' : 'false');
      this._renderSoundboard(
        this._soundboardPip
          ? (document.getElementById('sb-pip-search')?.value?.trim() || '')
          : (document.getElementById('soundboard-search')?.value?.trim() || '')
      );
    });
  }

  // Sidebar layout toggle — closes the popup and opens the sidebar panel
  const _applySoundboardSidebarMode = (val) => {
    this._soundboardSidebarMode = val;
    localStorage.setItem('haven_soundboard_sidebar_mode', val ? 'true' : 'false');
    // Sync all sidebar mode checkboxes (popup + settings page)
    ['soundboard-sidebar-mode', 'soundboard-sidebar-mode-settings'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.checked = val;
    });
    const panel = document.getElementById('sb-sidebar-panel');
    const toggleBtn = document.getElementById('sb-sidebar-toggle-btn');
    if (val) {
      // Close modal/pip, open sidebar panel
      document.getElementById('sound-modal').style.display = 'none';
      if (panel) {
        panel.classList.remove('sb-hidden');
        this._renderSoundboardSidebar();
        const search = document.getElementById('sb-sidebar-search');
        if (search && !search._sbListenerAttached) {
          search._sbListenerAttached = true;
          search.addEventListener('input', () => this._renderSoundboardSidebar(search.value.trim()));
        }
      }
      if (toggleBtn) { toggleBtn.style.display = ''; this._setSbToggleArrow(toggleBtn, true); }
      window._updateSbToggleRight?.();
    } else {
      // Hide sidebar panel and toggle button
      if (panel) panel.classList.add('sb-hidden');
      if (toggleBtn) toggleBtn.style.display = 'none';
      window._updateSbToggleRight?.();
    }
  };
  // Bind sidebar mode checkboxes
  ['soundboard-sidebar-mode', 'soundboard-sidebar-mode-settings'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.checked = this._soundboardSidebarMode;
      el.addEventListener('change', (e) => _applySoundboardSidebarMode(e.target.checked));
    }
  });

  // Init: show toggle button when sidebar mode is enabled, but keep panel CLOSED until user clicks
  {
    const panel = document.getElementById('sb-sidebar-panel');
    const toggleBtn = document.getElementById('sb-sidebar-toggle-btn');
    // Always start with panel hidden — user must click to open it
    if (panel) panel.classList.add('sb-hidden');
    if (toggleBtn) {
      // Show the toggle arrow button if sidebar mode is on
      if (this._soundboardSidebarMode) {
        toggleBtn.style.display = '';
        this._setSbToggleArrow(toggleBtn, false);
      } else {
        toggleBtn.style.display = 'none';
      }
    }
    // Clear any stale hidden state
    localStorage.removeItem('haven_sb_sidebar_hidden');
    // Define the helper now (app-ui and app-admin will also call it).
    // Layout is: ... | main | sb-panel | right-sidebar (voice/users)
    // - Voice/users toggle btn sits at the LEFT edge of right-sidebar (right:width-of-voice when open, right:0 when collapsed).
    // - Soundboard toggle btn sits at the LEFT edge of sb-panel, which is also offset by voice width.
    // Both buttons are staggered vertically in CSS so they never visually collide when both end up at right:0.
    window._updateSbToggleRight = () => {
      const sbPanel    = document.getElementById('sb-sidebar-panel');
      const rightSb    = document.getElementById('right-sidebar');
      const voiceBtn   = document.getElementById('sidebar-toggle-btn');
      const sbBtn      = document.getElementById('sb-sidebar-toggle-btn');
      const sbOpen     = sbPanel && !sbPanel.classList.contains('sb-hidden');
      // Below 900px the voice/users panel stops being a column in the row and
      // becomes a fixed overlay driven by the Members button. It still reports
      // its full width, so counting it pushed this button a panel's width in
      // from the edge and left it sitting alone in the message area, open or
      // closed. Out of flow means it takes no horizontal space. (#5534)
      const voiceInFlow = rightSb && !['fixed', 'absolute'].includes(getComputedStyle(rightSb).position);
      const voiceOpen  = voiceInFlow && !rightSb.classList.contains('collapsed');

      // `useRendered=false` places the button off the panel's *requested*
      // width (style.width / default) so it slides smoothly while the panel's
      // width transition is still animating. `useRendered=true` re-reads the
      // *actual* laid-out width once the animation settles — this closes the
      // gap that appeared when a narrow window let flex-shrink squeeze the
      // panel below its requested width (min-width:200px floor), leaving the
      // toggle stranded to the left of the panel's real edge.
      const place = (useRendered) => {
        const sbWidth = sbOpen
          ? (useRendered ? (sbPanel.offsetWidth || parseInt(sbPanel.style.width) || 220)
                         : (parseInt(sbPanel.style.width) || sbPanel.offsetWidth || 220))
          : 0;
        const voiceWidth = voiceOpen
          ? (useRendered ? (rightSb.offsetWidth || parseInt(rightSb.style.width) || 240)
                         : (parseInt(rightSb.style.width) || rightSb.offsetWidth || 240))
          : 0;
        if (voiceBtn) voiceBtn.style.right = voiceWidth + 'px';
        if (sbBtn) {
          sbBtn.style.right = (voiceWidth + sbWidth) + 'px';
          // When the sb panel is OPEN, the toggle button sits at the panel's
          // left edge — a horizontal position the voice/users toggle never
          // occupies. Align it with the voice header (top: 72px) so it stops
          // visually crowding the first content row, which under the prior
          // 114px stagger looked like an overlap with the top of the sound
          // list. When the panel is CLOSED, both toggles can end up at
          // right:0, so restore the 114px stagger to keep them from stacking.
          sbBtn.style.top = sbOpen ? '72px' : '114px';
        }
      };

      place(false);                       // immediate: target width (smooth during anim)
      clearTimeout(window._sbToggleRealignTimer);
      window._sbToggleRealignTimer = setTimeout(() => place(true), 300); // settle: real width
    };
    window._updateSbToggleRight();

    // The button's position is an inline `right` written by the code above, so
    // it only stays correct while something calls it. It was called on the
    // toggles and on a resize-handle drag, but nothing else -- so any other
    // change to the panel's real width left the button behind, sitting away
    // from the panel edge with a gap. Resizing the window is the obvious one:
    // the panel is a flex item that shrinks before its requested width, and no
    // resize listener ever re-placed the button.
    //
    // Watching the panels themselves catches every cause rather than the two
    // that were wired up: window resize, flex-shrink, the interface zoom
    // changing rem sizes, and a stream or soundboard opening and reflowing the
    // row. The observer only reads the panels and writes to the buttons, so it
    // cannot retrigger itself.
    if (!window._sbToggleResizeObserver && typeof ResizeObserver === 'function') {
      window._sbToggleResizeObserver = new ResizeObserver(() => {
        window._updateSbToggleRight?.();
      });
      for (const id of ['right-sidebar', 'sb-sidebar-panel']) {
        const el = document.getElementById(id);
        if (el) window._sbToggleResizeObserver.observe(el);
      }
    }
  }


  // Soundboard search
  const searchInput = document.getElementById('soundboard-search');
  if (searchInput) {
    searchInput.addEventListener('input', () => this._renderSoundboard(searchInput.value.trim()));
  }

  // Soundboard popout button
  document.getElementById('soundboard-popout-btn')?.addEventListener('click', () => this._popOutSoundboard());

  // Global hotkey listener
  document.addEventListener('keydown', (e) => {
    // Ignore key-repeat events (holding a key down)
    if (e.repeat) return;

    // If recording a hotkey for a sound, wait for a non-modifier key
    if (this._recordingHotkeyFor) {
      // Let modifier-only presses pass so the user can build combos
      if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;
      e.preventDefault();
      const hk = this._buildHotkeyString(e);
      if (hk === 'Escape') {
        this._recordingHotkeyFor = null;
        this._renderSoundboard();
        return;
      }
      // Remove any old binding with same hotkey
      Object.keys(this._soundHotkeys).forEach(k => {
        if (this._soundHotkeys[k] === this._recordingHotkeyFor) delete this._soundHotkeys[k];
      });
      this._soundHotkeys[hk] = this._recordingHotkeyFor;
      localStorage.setItem('haven_sound_hotkeys', JSON.stringify(this._soundHotkeys));
      this._showToast(`Hotkey [${hk}] set for "${this._recordingHotkeyFor}"`, 'success');
      this._recordingHotkeyFor = null;
      this._renderSoundboard();
      return;
    }
    // Check if a bound hotkey was pressed (only when not typing in inputs)
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    const hk = this._buildHotkeyString(e);
    const soundName = this._soundHotkeys[hk];
    if (soundName && this.customSounds) {
      // Cooldown: prevent rapid re-trigger (300ms minimum between plays)
      const now = Date.now();
      if (this._soundCooldowns[hk] && now - this._soundCooldowns[hk] < 300) return;
      this._soundCooldowns[hk] = now;
      const s = this.customSounds.find(cs => cs.name === soundName);
      if (s) {
        e.preventDefault();
        this._playSoundFile(s.url);
      }
    }
  });

  // Load custom sounds on init
  this._loadCustomSounds();
},

_buildHotkeyString(e) {
  const parts = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  const key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  if (!['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) parts.push(key);
  return parts.join('+');
},

_openSoundModal(tab = 'soundboard') {
  const modal = document.getElementById('sound-modal');
  if (!modal) return;
  // If the soundboard is already popped out AND the caller wants the soundboard
  // tab, bring the PiP into focus instead of reopening the modal. For 'assign'
  // and 'manage' tabs we still open the modal — the popout only holds the
  // soundboard view, so other tabs would otherwise be unreachable while
  // popped out (#5419, including the admin Custom Sounds button which goes
  // through this path with tab='manage').
  if (this._soundboardPip && tab === 'soundboard') {
    this._soundboardPip.style.zIndex = '10001';
    setTimeout(() => { if (this._soundboardPip) this._soundboardPip.style.zIndex = '10000'; }, 400);
    return;
  }
  // In sidebar mode, open the sidebar panel instead of the modal (for the soundboard tab)
  if (this._soundboardSidebarMode && tab === 'soundboard') {
    this._toggleSoundboardSidebar();
    return;
  }
  // Show admin tab only if user is admin or has manage_soundboard permission
  const adminTab = modal.querySelector('.sound-tab-admin');
  if (adminTab) adminTab.style.display = (this.user?.is_admin || this._hasPerm('manage_soundboard')) ? '' : 'none';
  // Activate requested tab
  modal.querySelectorAll('.sound-tab').forEach(t => t.classList.remove('active'));
  modal.querySelectorAll('.sound-tab-content').forEach(c => c.classList.remove('active'));
  const tabBtn = modal.querySelector(`.sound-tab[data-tab="${tab}"]`);
  const tabContent = document.getElementById(`sound-tab-${tab}`);
  if (tabBtn) tabBtn.classList.add('active');
  if (tabContent) tabContent.classList.add('active');
  modal.style.display = 'flex';
  // Sync popout button state
  const popoutBtn = document.getElementById('soundboard-popout-btn');
  if (popoutBtn) { popoutBtn.textContent = '\u29c9'; popoutBtn.title = 'Pop out soundboard'; }
  this._renderSoundboard();
  this._renderAssignTab();
},

// ── Custom dropdown wrapper for native <select> elements (#5418) ──
// Native <select> popups render outside the Haven window and can't be
// constrained or styled. This wraps a select with a custom display + panel
// that lives inside the modal, scrolls when long, and stays inside bounds.
_enhanceSelectAsCustom(selectEl) {
  if (!selectEl) return;
  // Re-entry path: rebuild options from the underlying <select>.
  if (selectEl.dataset.customEnhanced === '1') {
    const wrap = selectEl.parentElement;
    if (wrap && wrap._csRebuild) wrap._csRebuild();
    return;
  }
  selectEl.dataset.customEnhanced = '1';

  const wrap = document.createElement('div');
  wrap.className = 'custom-select-wrap ' + (selectEl.className || '');
  wrap.style.position = 'relative';
  selectEl.parentNode.insertBefore(wrap, selectEl);
  wrap.appendChild(selectEl);
  selectEl.style.display = 'none';

  const display = document.createElement('button');
  display.type = 'button';
  display.className = 'custom-select-display';
  display.innerHTML = '<span class="custom-select-label"></span><span class="custom-select-caret">▾</span>';
  wrap.appendChild(display);

  const panel = document.createElement('div');
  panel.className = 'custom-select-panel';
  panel.style.display = 'none';
  wrap.appendChild(panel);

  const labelEl = display.querySelector('.custom-select-label');

  const buildPanel = () => {
    panel.innerHTML = '';
    const addOption = (opt) => {
      const item = document.createElement('div');
      item.className = 'custom-select-option';
      item.textContent = opt.textContent;
      item.dataset.value = opt.value;
      if (opt.value === selectEl.value) item.classList.add('selected');
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        selectEl.value = opt.value;
        selectEl.dispatchEvent(new Event('change', { bubbles: true }));
        syncLabel();
        panel.style.display = 'none';
      });
      panel.appendChild(item);
    };
    Array.from(selectEl.children).forEach(child => {
      if (child.tagName === 'OPTGROUP') {
        const grp = document.createElement('div');
        grp.className = 'custom-select-group-label';
        grp.textContent = child.label;
        panel.appendChild(grp);
        Array.from(child.children).forEach(addOption);
      } else if (child.tagName === 'OPTION') {
        addOption(child);
      }
    });
  };

  const syncLabel = () => {
    const opt = Array.from(selectEl.querySelectorAll('option')).find(o => o.value === selectEl.value);
    labelEl.textContent = opt ? opt.textContent : '';
  };

  const openPanel = () => {
    buildPanel();
    panel.style.display = 'block';
    // Position: prefer below; flip to above if not enough room.
    const rect = display.getBoundingClientRect();
    const modalContent = display.closest('.modal-content') || display.closest('.modal') || document.body;
    const mc = modalContent.getBoundingClientRect();
    const below = mc.bottom - rect.bottom;
    const above = rect.top - mc.top;
    const room = Math.max(120, Math.min(280, Math.max(below, above) - 16));
    panel.style.maxHeight = room + 'px';
    if (below < 160 && above > below) {
      panel.classList.add('flip-up');
    } else {
      panel.classList.remove('flip-up');
    }
  };

  display.addEventListener('click', (e) => {
    e.stopPropagation();
    if (panel.style.display === 'none') openPanel();
    else panel.style.display = 'none';
  });

  const docClick = (e) => {
    if (!wrap.contains(e.target)) panel.style.display = 'none';
  };
  document.addEventListener('click', docClick);

  selectEl.addEventListener('change', syncLabel);
  wrap._csRebuild = buildPanel;
  syncLabel();
},

_closeSoundboardForVoiceLeave() {
  // Called from _leaveVoice. The soundboard is gated to voice-only use,
  // so when the user leaves voice we close any open soundboard surface:
  // sidebar panel, modal, or popped-out PiP.
  const panel = document.getElementById('sb-sidebar-panel');
  if (panel && !panel.classList.contains('sb-hidden')) {
    this._toggleSoundboardSidebar();
  }
  const modal = document.getElementById('sound-modal');
  if (modal && modal.style.display && modal.style.display !== 'none') {
    modal.style.display = 'none';
  }
  if (this._soundboardPip) {
    this._popInSoundboard(false);
  }
},

// Both dock handles sit on the right edge with their panel to the right, so
// the arrow shows which way that panel moves when clicked: an open panel will
// slide right and shut, a closed one will slide left and open. The members
// handle already read that way and the soundboard one was doing the opposite,
// which looked backwards sitting directly under it. (#5534)
_setSbToggleArrow(btn, open) {
  if (!btn) return;
  (btn.querySelector('.sb-toggle-arrow') || btn).textContent = open ? '\u276F' : '\u276E';
},

_toggleSoundboardSidebar() {
  const panel = document.getElementById('sb-sidebar-panel');
  const btn = document.getElementById('sb-sidebar-toggle-btn');
  if (!panel) return;
  const isNowHidden = !panel.classList.contains('sb-hidden');
  panel.classList.toggle('sb-hidden', isNowHidden);
  localStorage.setItem('haven_sb_sidebar_hidden', isNowHidden ? '1' : '0');
  this._setSbToggleArrow(btn, !isNowHidden);
  if (!isNowHidden) {
    this._renderSoundboardSidebar();
    const search = document.getElementById('sb-sidebar-search');
    if (search && !search._sbListenerAttached) {
      search._sbListenerAttached = true;
      search.addEventListener('input', () => this._renderSoundboardSidebar(search.value.trim()));
    }
  }
  window._updateSbToggleRight?.();
},

_renderSoundboardSidebar(filter = '') {
  const grid = document.getElementById('sb-sidebar-grid');
  if (!grid) return;
  const all = (this.customSounds || []).filter(s =>
    (!filter || s.name.toLowerCase().includes(filter.toLowerCase())) &&
    (!this._soundPrefs[s.name]?.hidden || this._showHiddenSounds)
  );
  const hotkeyMap = {};
  Object.entries(this._soundHotkeys).forEach(([hk, name]) => { hotkeyMap[name] = hk; });

  if (all.length === 0) {
    grid.innerHTML = `<p class="muted-text">${filter ? 'No matching sounds' : 'No sounds available'}</p>`;
    return;
  }

  // Split into custom (user-uploaded) and built-in groups. Custom always shows first.
  const customSounds  = all.filter(s => !s.builtin);
  const builtinSounds = all.filter(s =>  s.builtin);

  const renderBtn = (s) => {
    const hk = hotkeyMap[s.name];
    const hotkeyHtml = hk ? `<span class="sb-hotkey">${this._escapeHtml(hk)}</span>` : '';
    return `<button class="soundboard-btn${this._soundPrefs[s.name]?.hidden ? ' hidden-sound' : ''}" data-name="${this._escapeHtml(s.name)}" data-url="${this._escapeHtml(s.url)}"><span class="sb-name">${this._escapeHtml(s.name)}</span>${hotkeyHtml}</button>`;
  };

  // Persisted open/closed state for each group (default: both open).
  const customOpen  = localStorage.getItem('haven_sb_sidebar_custom_open')  !== '0';
  const builtinOpen = localStorage.getItem('haven_sb_sidebar_builtin_open') !== '0';

  const renderGroup = (label, sounds, openKey, isOpen) => {
    if (sounds.length === 0) return '';
    return `
      <details class="sb-sidebar-group" data-open-key="${openKey}"${isOpen ? ' open' : ''}>
        <summary class="sb-sidebar-group-label">${label} <span class="sb-sidebar-group-count">${sounds.length}</span></summary>
        <div class="sb-sidebar-group-body">${sounds.map(renderBtn).join('')}</div>
      </details>
    `;
  };

  grid.innerHTML =
    renderGroup('Custom',  customSounds,  'haven_sb_sidebar_custom_open',  customOpen) +
    renderGroup('Built-in', builtinSounds, 'haven_sb_sidebar_builtin_open', builtinOpen);

  grid.querySelectorAll('.soundboard-btn').forEach(btn => {
    btn.addEventListener('click', () => this._playSoundFile(btn.dataset.url));
  });
  // Persist open/closed state of each category.
  grid.querySelectorAll('details.sb-sidebar-group').forEach(d => {
    d.addEventListener('toggle', () => {
      localStorage.setItem(d.dataset.openKey, d.open ? '1' : '0');
    });
  });
},

_popOutSoundboard() {
  if (this._soundboardPip) {
    this._popInSoundboard();
    return;
  }

  // Close the modal
  document.getElementById('sound-modal').style.display = 'none';

  const pip = document.createElement('div');
  pip.id = 'sb-pip-overlay';
  pip.className = 'sb-pip-overlay';
  pip.innerHTML = `
    <div class="music-pip-header" id="sb-pip-drag">
      <button class="music-pip-btn" id="sb-pip-popin" title="Pop back in">\u29c8</button>
      <span class="music-pip-label">\uD83C\uDFB5 Soundboard</span>
      <button class="music-pip-btn" id="sb-pip-close" title="Close">\u2715</button>
    </div>
    <div class="sb-pip-body">
      <div class="sound-search-row" style="padding:0;margin-bottom:0">
        <input type="text" id="sb-pip-search" placeholder="Search sounds..." class="settings-text-input" style="flex:1;font-size:0.75rem">
      </div>
      <div id="sb-pip-grid" class="sb-pip-grid"></div>
    </div>
  `;
  document.body.appendChild(pip);
  this._soundboardPip = pip;

  this._renderSoundboard();

  document.getElementById('sb-pip-search').addEventListener('input', (e) => {
    this._renderSoundboard(e.target.value.trim());
  });
  document.getElementById('sb-pip-popin').addEventListener('click', () => this._popInSoundboard(true));
  document.getElementById('sb-pip-close').addEventListener('click', () => this._popInSoundboard(false));

  this._initPipDrag(pip, document.getElementById('sb-pip-drag'));
},

_popInSoundboard(reopen = false) {
  if (!this._soundboardPip) return;
  this._soundboardPip.remove();
  this._soundboardPip = null;
  if (reopen) this._openSoundModal('soundboard');
},

_playSoundFile(url) {
  try {
    const vol = Math.max(0, Math.min(1, this.notifications.volume * this.notifications.volume));
    // If in voice chat, route through VC so other users hear the sound too
    if (this.voice && this.voice.inVoice) {
      // Respect the per-channel soundboard toggle for the voice channel the
      // user is currently in. When an admin turns the soundboard off there,
      // sounds can't be played into that VC by anyone.
      const vcCode = this.voice.currentChannel;
      const vcCh = vcCode && Array.isArray(this.channels) ? this.channels.find(c => c.code === vcCode) : null;
      if (vcCh && vcCh.soundboard_enabled === 0) {
        return this._showToast(t('media.soundboard_disabled'), 'error');
      }
      if (this.voice.playSoundToVC(url, vol)) return;
    }
    // Fallback: play locally only
    const audio = new Audio(url);
    audio.volume = vol;
    audio.play().catch(() => {});
  } catch { /* audio not available */ }
},

async _loadCustomSounds() {
  try {
    const res = await fetch('/api/sounds', {
      headers: { 'Authorization': `Bearer ${this.token}` }
    });
    if (!res.ok) return;
    const data = await res.json();
    const sounds = data.sounds || [];
    this.customSounds = sounds; // [{name, url}]

    // Update all notification sound select dropdowns
    this._updateSoundSelects(sounds);

    // Render admin sound list
    this._renderSoundList(sounds);

    // Render soundboard if modal is visible or PiP is open
    if (document.getElementById('sound-modal')?.style.display === 'flex' || this._soundboardPip) {
      this._renderSoundboard();
      this._renderAssignTab();
    }
    // Re-render sidebar panel if it's visible
    const sbPanel = document.getElementById('sb-sidebar-panel');
    if (sbPanel && !sbPanel.classList.contains('sb-hidden')) {
      this._renderSoundboardSidebar(document.getElementById('sb-sidebar-search')?.value?.trim() || '');
    }
  } catch { /* ignore */ }
},

async _loadUserSoundPrefs() {
  try {
    const res = await fetch('/api/user-sound-prefs', {
      headers: { 'Authorization': `Bearer ${this.token}` }
    });
    if (!res.ok) return;
    const data = await res.json();
    this._soundPrefs = data.prefs || {};
  } catch { /* non-critical – run with empty prefs if endpoint unavailable */ }
},

async _saveUserSoundPrefs() {
  try {
    await fetch('/api/user-sound-prefs', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ prefs: this._soundPrefs })
    });
  } catch { /* non-critical */ }
},

_updateSoundSelects(sounds) {
  // Update ALL 5 notification selects with custom sounds
  const selects = ['notif-msg-sound', 'notif-sent-sound', 'notif-mention-sound', 'notif-join-sound', 'notif-leave-sound'];
  selects.forEach(id => {
    const sel = document.getElementById(id);
    if (!sel) return;

    // Remember current value
    const currentVal = sel.value;

    // Remove old custom options
    sel.querySelectorAll('option[data-custom]').forEach(o => o.remove());
    sel.querySelectorAll('optgroup[data-custom-group]').forEach(o => o.remove());

    const noneOpt = sel.querySelector('option[value="none"]');

    // Add custom sounds optgroup
    const builtins = sounds.filter(s => s.builtin);
    const customs  = sounds.filter(s => !s.builtin);

    if (builtins.length > 0) {
      const builtinGroup = document.createElement('optgroup');
      builtinGroup.label = `🎙️ ${t('modals.sound_manager.group_builtin')}`;
      builtinGroup.dataset.customGroup = '1';
      builtins.forEach(s => {
        const opt = document.createElement('option');
        opt.value = `custom:${s.name}`;
        opt.textContent = s.name;
        opt.dataset.custom = '1';
        opt.dataset.url = s.url;
        builtinGroup.appendChild(opt);
      });
      sel.insertBefore(builtinGroup, noneOpt);
    }

    if (customs.length > 0) {
      const customGroup = document.createElement('optgroup');
      customGroup.label = `🎵 ${t('modals.sound_manager.group_custom')}`;
      customGroup.dataset.customGroup = '1';
      customs.forEach(s => {
        const opt = document.createElement('option');
        opt.value = `custom:${s.name}`;
        opt.textContent = s.name;
        opt.dataset.custom = '1';
        opt.dataset.url = s.url;
        customGroup.appendChild(opt);
      });
      sel.insertBefore(customGroup, noneOpt);
    }

    // Restore value
    sel.value = currentVal;
  });
},

_renderSoundList(sounds) {
  const list = document.getElementById('custom-sounds-list');
  if (!list) return;

  const builtins = sounds.filter(s => s.builtin);
  const custom   = sounds.filter(s => !s.builtin);

  if (builtins.length === 0 && custom.length === 0) {
    list.innerHTML = `<p class="muted-text">${t('modals.sound_manager.no_custom_sounds')}</p>`;
    return;
  }

  const builtinHtml = builtins.length === 0 ? '' : `
    <details class="sound-section">
      <summary class="sound-section-label">${t('modals.sound_manager.group_builtin')}</summary>
      ${builtins.map(s => `
        <div class="custom-sound-item" data-name="${this._escapeHtml(s.name)}">
          <span class="custom-sound-name">${this._escapeHtml(s.name)}</span>
          <button class="btn-xs sound-preview-btn" data-url="${this._escapeHtml(s.url)}" title="${t('modals.sound_manager.preview_btn')}">&#x25B6;</button>
          <button class="btn-xs sound-delete-btn" data-name="${this._escapeHtml(s.name)}" title="${t('modals.sound_manager.delete_btn')}">&#x1F5D1;</button>
        </div>
      `).join('')}
    </details>
  `;

  const customHtml = custom.length === 0 ? '' : `
    <details class="sound-section" open>
      <summary class="sound-section-label">${t('modals.sound_manager.group_custom')}</summary>
      ${custom.map(s => `
        <div class="custom-sound-item" data-name="${this._escapeHtml(s.name)}">
          <span class="custom-sound-name">${this._escapeHtml(s.name)}</span>
          <button class="btn-xs sound-preview-btn" data-url="${this._escapeHtml(s.url)}" title="${t('modals.sound_manager.preview_btn')}">&#x25B6;</button>
          <button class="btn-xs sound-rename-btn" data-name="${this._escapeHtml(s.name)}" title="${t('modals.sound_manager.rename_btn')}">&#x270F;</button>
          <button class="btn-xs sound-delete-btn" data-name="${this._escapeHtml(s.name)}" title="${t('modals.sound_manager.delete_btn')}">&#x1F5D1;</button>
        </div>
      `).join('')}
    </details>
  `;

  // Custom first, then built-in
  list.innerHTML = customHtml + builtinHtml;


  // Preview buttons
  list.querySelectorAll('.sound-preview-btn').forEach(btn => {
    btn.addEventListener('click', () => this._playSoundFile(btn.dataset.url));
  });

  // Rename buttons
  list.querySelectorAll('.sound-rename-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const item = btn.closest('.custom-sound-item');
      const nameSpan = item.querySelector('.custom-sound-name');
      const oldName = btn.dataset.name;
      // Replace span with input
      const input = document.createElement('input');
      input.type = 'text';
      input.value = oldName;
      input.maxLength = 30;
      input.className = 'custom-sound-name-input';
      nameSpan.replaceWith(input);
      input.focus();
      input.select();

      const doRename = async () => {
        const newName = input.value.trim();
        if (!newName || newName === oldName) {
          // Revert
          const span = document.createElement('span');
          span.className = 'custom-sound-name';
          span.textContent = oldName;
          input.replaceWith(span);
          return;
        }
        try {
          const res = await fetch(`/api/sounds/${encodeURIComponent(oldName)}`, {
            method: 'PATCH',
            headers: { 'Authorization': `Bearer ${this.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ newName })
          });
          if (res.ok) {
            // Update hotkey bindings
            Object.keys(this._soundHotkeys).forEach(k => {
              if (this._soundHotkeys[k] === oldName) this._soundHotkeys[k] = newName;
            });
            localStorage.setItem('haven_sound_hotkeys', JSON.stringify(this._soundHotkeys));
            this._showToast(`Renamed to "${newName}"`, 'success');
            this._loadCustomSounds();
          } else {
            let errMsg = 'Rename failed';
            try { const d = await res.json(); errMsg = d.error || errMsg; } catch {}
            this._showToast(errMsg, 'error');
            const span = document.createElement('span');
            span.className = 'custom-sound-name';
            span.textContent = oldName;
            input.replaceWith(span);
          }
        } catch {
          this._showToast('Rename failed', 'error');
        }
      };

      input.addEventListener('blur', doRename);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
        if (e.key === 'Escape') { input.value = oldName; input.blur(); }
      });
    });
  });

  // Delete buttons
  list.querySelectorAll('.sound-delete-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const name = btn.dataset.name;
      try {
        const res = await fetch(`/api/sounds/${encodeURIComponent(name)}`, {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${this.token}` }
        });
        if (res.ok) {
          this._showToast(`Sound "${name}" deleted`, 'success');
          // Clean up hotkey
          Object.keys(this._soundHotkeys).forEach(k => {
            if (this._soundHotkeys[k] === name) delete this._soundHotkeys[k];
          });
          localStorage.setItem('haven_sound_hotkeys', JSON.stringify(this._soundHotkeys));
          this._loadCustomSounds();
        } else {
          this._showToast('Delete failed', 'error');
        }
      } catch {
        this._showToast('Delete failed', 'error');
      }
    });
  });
},

// ── Soundboard Tab ─────────────────────────────────────

_renderSoundboard(filter = '') {
  // Render into both the modal grid and the PiP grid if it's open
  const grids = [];
  const modalGrid = document.getElementById('soundboard-grid');
  if (modalGrid) grids.push(modalGrid);
  const pipGrid = this._soundboardPip ? document.getElementById('sb-pip-grid') : null;
  if (pipGrid) grids.push(pipGrid);
  if (grids.length === 0) return;

  let sounds = (this.customSounds || []).filter(s =>
    (!filter || s.name.toLowerCase().includes(filter.toLowerCase())) &&
    (!this._soundPrefs[s.name]?.hidden || this._showHiddenSounds)
  );

  // Reverse lookup: soundName → hotkey
  const hotkeyMap = {};
  Object.entries(this._soundHotkeys).forEach(([hk, name]) => { hotkeyMap[name] = hk; });

  const html = sounds.length === 0
    ? `<p class="muted-text" style="grid-column:1/-1">${filter ? 'No matching sounds' : 'No sounds available'}</p>`
    : sounds.map(s => {
        const hk = hotkeyMap[s.name];
        const hotkeyHtml = hk
          ? `<span class="sb-hotkey-row">
               <span class="sb-hotkey">${this._escapeHtml(hk)}</span>
               <span class="sb-hotkey-clear" data-sound="${this._escapeHtml(s.name)}" title="Remove hotkey">&times;</span>
             </span>`
          : `<span class="sb-hotkey-set" data-sound="${this._escapeHtml(s.name)}">Set hotkey</span>`;
        return `<button class="soundboard-btn${this._soundPrefs[s.name]?.hidden ? ' hidden-sound' : ''}" data-name="${this._escapeHtml(s.name)}" data-url="${this._escapeHtml(s.url)}"><span class="sb-hide-btn" data-sound="${this._escapeHtml(s.name)}" title="${this._soundPrefs[s.name]?.hidden ? 'Show' : 'Hide'} this sound">👁️</span><span class="sb-name">${this._escapeHtml(s.name)}</span>
          ${hotkeyHtml}
        </button>`;
      }).join('');

  grids.forEach(grid => {
    grid.innerHTML = html;
    if (sounds.length === 0) return;

    // Apply list mode class to popup/pip grids
    if (this._soundboardListMode) grid.classList.add('list-mode');
    else grid.classList.remove('list-mode');

    // Click the main button area to play
    grid.querySelectorAll('.soundboard-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        if (e.target.closest('.sb-hotkey-clear') || e.target.closest('.sb-hotkey-set')) return;
        this._playSoundFile(btn.dataset.url);
      });
    });

    // "Set hotkey" link
    grid.querySelectorAll('.sb-hotkey-set').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const name = el.dataset.sound;
        this._recordingHotkeyFor = name;
        const btn = el.closest('.soundboard-btn');
        if (btn) btn.classList.add('hotkey-recording');
        this._showToast(`Press a key combo for "${name}" (Esc to cancel)`, 'info');
      });
    });

    // "×" remove hotkey button
    grid.querySelectorAll('.sb-hotkey-clear').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const name = el.dataset.sound;
        const hk = hotkeyMap[name];
        if (hk) {
          delete this._soundHotkeys[hk];
          localStorage.setItem('haven_sound_hotkeys', JSON.stringify(this._soundHotkeys));
          this._showToast(`Hotkey removed for "${name}"`, 'info');
          this._renderSoundboard(
            this._soundboardPip
              ? (document.getElementById('sb-pip-search')?.value?.trim() || '')
              : (document.getElementById('soundboard-search')?.value?.trim() || '')
          );
        }
      });
    });

    // Hide / show button (👁️)
    grid.querySelectorAll('.sb-hide-btn').forEach(el => {
      el.addEventListener('click', async (e) => {
        e.stopPropagation();
        const name = el.dataset.sound;
        if (!this._soundPrefs[name]) this._soundPrefs[name] = {};
        this._soundPrefs[name].hidden = !this._soundPrefs[name].hidden;
        await this._saveUserSoundPrefs();
        const searchVal = this._soundboardPip
          ? (document.getElementById('sb-pip-search')?.value?.trim() || '')
          : (document.getElementById('soundboard-search')?.value?.trim() || '');
        this._renderSoundboard(searchVal);
      });
    });

    // Right-click also starts hotkey recording
    grid.querySelectorAll('.soundboard-btn').forEach(btn => {
      btn.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (e.target.closest('.sb-hotkey-clear')) return;
        const name = btn.dataset.name;
        this._recordingHotkeyFor = name;
        btn.classList.add('hotkey-recording');
        this._showToast(`Press a key combo for "${name}" (Esc to cancel)`, 'info');
      });
    });
  });
},

// ── Assign to Events Tab ───────────────────────────────

_renderAssignTab() {
  const builtinSounds = [
    { value: 'ping', label: 'Ping' }, { value: 'chime', label: 'Chime' },
    { value: 'blip', label: 'Blip' }, { value: 'bell', label: 'Bell' },
    { value: 'drop', label: 'Drop' }, { value: 'alert', label: 'Alert' },
    { value: 'chord', label: 'Chord' }, { value: 'swoosh', label: 'Swoosh' },
    { value: 'none', label: 'None' },
  ];
  const customs = (this.customSounds || []).map(s => ({
    value: `custom:${s.name}`, label: s.name, url: s.url, builtin: !!s.builtin
  }));
  const fileBuiltins = customs.filter(s => s.builtin);
  const userCustoms  = customs.filter(s => !s.builtin);

  const events = [
    { selectId: 'assign-msg-sound', event: 'message', notifSelect: 'notif-msg-sound' },
    { selectId: 'assign-sent-sound', event: 'sent', notifSelect: 'notif-sent-sound' },
    { selectId: 'assign-mention-sound', event: 'mention', notifSelect: 'notif-mention-sound' },
    { selectId: 'assign-join-sound', event: 'join', notifSelect: 'notif-join-sound' },
    { selectId: 'assign-leave-sound', event: 'leave', notifSelect: 'notif-leave-sound' },
  ];

  events.forEach(({ selectId, event, notifSelect }) => {
    const sel = document.getElementById(selectId);
    if (!sel) return;

    // Build options
    sel.innerHTML = '';
    const builtinGroup = document.createElement('optgroup');
    builtinGroup.label = '🔊 Built-in';
    builtinSounds.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.value;
      opt.textContent = s.label;
      builtinGroup.appendChild(opt);
    });
    sel.appendChild(builtinGroup);

    if (fileBuiltins.length > 0) {
      const fbGroup = document.createElement('optgroup');
      fbGroup.label = '🎙️ Sounds';
      fileBuiltins.forEach(s => {
        const opt = document.createElement('option');
        opt.value = s.value;
        opt.textContent = s.label;
        opt.dataset.url = s.url;
        fbGroup.appendChild(opt);
      });
      sel.appendChild(fbGroup);
    }

    if (userCustoms.length > 0) {
      const customGroup = document.createElement('optgroup');
      customGroup.label = '🎵 Custom';
      userCustoms.forEach(s => {
        const opt = document.createElement('option');
        opt.value = s.value;
        opt.textContent = s.label;
        opt.dataset.url = s.url;
        customGroup.appendChild(opt);
      });
      sel.appendChild(customGroup);
    }

    // Sync with current notification setting
    sel.value = this.notifications.sounds[event] || 'none';
    // Replace the native dropdown with a custom one constrained to the modal,
    // so long sound lists don't render a native popup that overflows the
    // Haven window (#5418 follow-up). Idempotent — re-renders sync the label.
    this._enhanceSelectAsCustom?.(sel);

    // On change, update the main notification select + play preview
    sel.addEventListener('change', () => {
      const val = sel.value;
      this.notifications.setSound(event, val);
      // Sync the main settings select
      const mainSel = document.getElementById(notifSelect);
      if (mainSel) mainSel.value = val;
      // Play preview
      this.notifications.play(event);
    });
  });
},

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// CUSTOM EMOJI MANAGEMENT
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

_setupEmojiManagement() {
  this._croppedEmojiBlob = null;
  this._cropState = null;
  this._cropSourceFile = null;

  // Open emoji management modal
  const openEmojiBtn = document.getElementById('open-emoji-manager-btn');
  if (openEmojiBtn) {
    openEmojiBtn.addEventListener('click', () => {
      document.getElementById('emoji-modal').style.display = 'flex';
    });
  }
  // Close emoji modal
  document.getElementById('close-emoji-modal-btn')?.addEventListener('click', () => {
    document.getElementById('emoji-modal').style.display = 'none';
  });
  document.getElementById('emoji-modal')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) e.currentTarget.style.display = 'none';
  });

  const uploadBtn = document.getElementById('emoji-upload-btn');
  const fileInput = document.getElementById('emoji-file-input');
  const nameInput = document.getElementById('emoji-name-input');
  if (!uploadBtn || !fileInput) return;

  // When a file is chosen, open the cropper (skip for GIFs)
  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    if (!file) return;
    this._croppedEmojiBlob = null;
    this._cropSourceFile = file;
    const previewRow = document.getElementById('emoji-crop-preview-row');
    if (previewRow) previewRow.style.display = 'none';
    if (file.type === 'image/gif') return; // GIFs skip cropper
    this._openEmojiCropper(file);
  });

  uploadBtn.addEventListener('click', async () => {
    const file = fileInput.files[0];
    const name = nameInput ? nameInput.value.trim().replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase() : '';
    if (!file) return this._showToast('Select an image file', 'error');
    if (!name) return this._showToast('Enter an emoji name (lowercase, no spaces)', 'error');

    // Use cropped blob for non-GIF uploads, otherwise raw file
    const uploadBlob = (this._croppedEmojiBlob && file.type !== 'image/gif')
      ? this._croppedEmojiBlob
      : file;
    const maxEmojiKb = parseInt(this.serverSettings?.max_emoji_kb) || 256;
    if (uploadBlob.size > maxEmojiKb * 1024) return this._showToast(`Emoji file too large (max ${maxEmojiKb} KB)`, 'error');

    const formData = new FormData();
    formData.append('emoji', uploadBlob, file.name);
    formData.append('name', name);

    try {
      this._showToast('Uploading emoji...', 'info');
      const res = await fetch('/api/upload-emoji', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${this.token}` },
        body: formData
      });
      if (!res.ok) {
        let errMsg = `Upload failed (${res.status})`;
        try { const d = await res.json(); errMsg = d.error || errMsg; } catch {}
        return this._showToast(errMsg, 'error');
      }
      this._showToast(`Emoji :${name}: uploaded!`, 'success');
      fileInput.value = '';
      if (nameInput) nameInput.value = '';
      this._croppedEmojiBlob = null;
      this._cropSourceFile = null;
      this._cropState = null;
      const previewRow = document.getElementById('emoji-crop-preview-row');
      if (previewRow) previewRow.style.display = 'none';
      this._loadCustomEmojis();
    } catch {
      this._showToast('Upload failed', 'error');
    }
  });

  // Bulk emoji upload — select multiple files, auto-named from filenames
  const bulkInput = document.getElementById('emoji-bulk-input');
  if (bulkInput) {
    bulkInput.addEventListener('change', async () => {
      const files = Array.from(bulkInput.files);
      if (!files.length) return;
      const maxEmojiKb = parseInt(this.serverSettings?.max_emoji_kb) || 256;
      const formData = new FormData();
      let skipped = 0;
      for (const file of files) {
        if (file.size > maxEmojiKb * 1024) { skipped++; continue; }
        formData.append('emojis', file, file.name);
      }
      if ([...formData.entries()].length === 0) {
        bulkInput.value = '';
        return this._showToast(`All files exceeded the ${maxEmojiKb} KB limit`, 'error');
      }
      try {
        this._showToast(`Uploading ${files.length - skipped} emoji${files.length - skipped > 1 ? 's' : ''}...`, 'info');
        const res = await fetch('/api/upload-emojis', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${this.token}` },
          body: formData
        });
        if (!res.ok) {
          let errMsg = `Upload failed (${res.status})`;
          try { const d = await res.json(); errMsg = d.error || errMsg; } catch {}
          return this._showToast(errMsg, 'error');
        }
        const data = await res.json();
        const count = data.uploaded?.length || 0;
        const errCount = (data.errors?.length || 0) + skipped;
        let msg = `${count} emoji${count !== 1 ? 's' : ''} uploaded`;
        if (errCount) msg += ` (${errCount} skipped)`;
        this._showToast(msg, count ? 'success' : 'error');
        this._loadCustomEmojis();
      } catch {
        this._showToast('Bulk upload failed', 'error');
      }
      bulkInput.value = '';
    });
  }

  this._setupEmojiCropperEvents();
  this._loadStandardEmojis();
  this._loadCustomEmojis();
},

_setupEmojiCropperEvents() {
  const canvas = document.getElementById('emoji-crop-canvas');
  const zoomSlider = document.getElementById('emoji-crop-zoom');
  if (!canvas || !zoomSlider) return;

  // Zoom slider
  zoomSlider.addEventListener('input', () => {
    if (!this._cropState) return;
    const s = this._cropState;
    const prevScale = s.scale;
    const newScale = s.minScale * (parseInt(zoomSlider.value) / 100);
    // Zoom toward canvas center
    s.ox = 128 - (128 - s.ox) * (newScale / prevScale);
    s.oy = 128 - (128 - s.oy) * (newScale / prevScale);
    s.scale = newScale;
    this._clampEmojiCrop();
    this._renderEmojiCropFrame();
  });

  // Mouse wheel → zoom
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (!this._cropState) return;
    const delta = e.deltaY < 0 ? 15 : -15;
    const newVal = Math.min(500, Math.max(100, parseInt(zoomSlider.value) + delta));
    zoomSlider.value = newVal;
    zoomSlider.dispatchEvent(new Event('input'));
  }, { passive: false });

  // Mouse drag
  canvas.addEventListener('mousedown', (e) => {
    if (!this._cropState) return;
    this._cropState.dragging = true;
    this._cropState.lastX = e.clientX;
    this._cropState.lastY = e.clientY;
    canvas.style.cursor = 'grabbing';
  });
  document.addEventListener('mousemove', (e) => {
    if (!this._cropState?.dragging) return;
    const s = this._cropState;
    s.ox += e.clientX - s.lastX;
    s.oy += e.clientY - s.lastY;
    s.lastX = e.clientX;
    s.lastY = e.clientY;
    this._clampEmojiCrop();
    this._renderEmojiCropFrame();
  });
  document.addEventListener('mouseup', () => {
    if (this._cropState) this._cropState.dragging = false;
    canvas.style.cursor = 'grab';
  });

  // Touch drag
  canvas.addEventListener('touchstart', (e) => {
    if (!this._cropState) return;
    e.preventDefault();
    const t = e.touches[0];
    this._cropState.dragging = true;
    this._cropState.lastX = t.clientX;
    this._cropState.lastY = t.clientY;
  }, { passive: false });
  canvas.addEventListener('touchmove', (e) => {
    if (!this._cropState?.dragging) return;
    e.preventDefault();
    const s = this._cropState;
    const t = e.touches[0];
    s.ox += t.clientX - s.lastX;
    s.oy += t.clientY - s.lastY;
    s.lastX = t.clientX;
    s.lastY = t.clientY;
    this._clampEmojiCrop();
    this._renderEmojiCropFrame();
  }, { passive: false });
  canvas.addEventListener('touchend', () => {
    if (this._cropState) this._cropState.dragging = false;
  });

  // Confirm crop
  document.getElementById('emoji-crop-confirm-btn')?.addEventListener('click', () => {
    if (!this._cropState) return;
    const s = this._cropState;
    const outCanvas = document.createElement('canvas');
    outCanvas.width = 128;
    outCanvas.height = 128;
    const outCtx = outCanvas.getContext('2d');
    const srcX = -s.ox / s.scale;
    const srcY = -s.oy / s.scale;
    const srcW = 256 / s.scale;
    const srcH = 256 / s.scale;
    outCtx.drawImage(s.img, srcX, srcY, srcW, srcH, 0, 0, 128, 128);
    outCanvas.toBlob((blob) => {
      this._croppedEmojiBlob = blob;
      document.getElementById('emoji-crop-modal').style.display = 'none';
      // Show preview row in the emoji modal
      const thumb = document.getElementById('emoji-crop-thumb');
      if (thumb) { thumb.src = outCanvas.toDataURL('image/png'); }
      const previewRow = document.getElementById('emoji-crop-preview-row');
      if (previewRow) previewRow.style.display = 'flex';
    }, 'image/png');
  });

  // Cancel crop
  document.getElementById('emoji-crop-cancel-btn')?.addEventListener('click', () => {
    document.getElementById('emoji-crop-modal').style.display = 'none';
    document.getElementById('emoji-file-input').value = '';
    this._croppedEmojiBlob = null;
    this._cropState = null;
    this._cropSourceFile = null;
  });

  // Re-crop button in preview row
  document.getElementById('emoji-recrop-btn')?.addEventListener('click', () => {
    if (this._cropSourceFile) this._openEmojiCropper(this._cropSourceFile);
  });
},

_openEmojiCropper(file) {
  const modal = document.getElementById('emoji-crop-modal');
  const canvas = document.getElementById('emoji-crop-canvas');
  const zoomSlider = document.getElementById('emoji-crop-zoom');
  if (!modal || !canvas || !zoomSlider) return;

  const img = new Image();
  const url = URL.createObjectURL(file);
  img.onload = () => {
    URL.revokeObjectURL(url);
    const minScale = Math.max(256 / img.width, 256 / img.height);
    const initScale = minScale;
    this._cropState = {
      img,
      minScale,
      scale: initScale,
      ox: (256 - img.width * initScale) / 2,
      oy: (256 - img.height * initScale) / 2,
      dragging: false,
      lastX: 0,
      lastY: 0
    };
    zoomSlider.value = 100;
    this._clampEmojiCrop();
    this._renderEmojiCropFrame();
    modal.style.display = 'flex';
  };
  img.src = url;
},

_clampEmojiCrop() {
  const s = this._cropState;
  if (!s) return;
  const w = s.img.width * s.scale;
  const h = s.img.height * s.scale;
  s.ox = Math.min(0, Math.max(256 - w, s.ox));
  s.oy = Math.min(0, Math.max(256 - h, s.oy));
},

_renderEmojiCropFrame() {
  const s = this._cropState;
  if (!s) return;
  const canvas = document.getElementById('emoji-crop-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, 256, 256);
  ctx.drawImage(s.img, s.ox, s.oy, s.img.width * s.scale, s.img.height * s.scale);
  // Corner guides to indicate crop boundary
  ctx.strokeStyle = 'rgba(255,255,255,0.75)';
  ctx.lineWidth = 2;
  const g = 14;
  [[0,0,1,1],[256,0,-1,1],[0,256,1,-1],[256,256,-1,-1]].forEach(([x,y,sx,sy]) => {
    ctx.beginPath();
    ctx.moveTo(x + sx, y); ctx.lineTo(x + sx * g, y);
    ctx.moveTo(x, y + sy); ctx.lineTo(x, y + sy * g);
    ctx.stroke();
  });
},

// Replace the built-in picker list with the full Unicode set served by the
// server. On any failure the hand-curated built-in list stays in place.
async _loadStandardEmojis() {
  try {
    const res = await fetch('/api/standard-emojis', {
      headers: { 'Authorization': `Bearer ${this.token}` }
    });
    if (!res.ok) return;
    const data = await res.json();
    if (!data.categories || !Object.keys(data.categories).length) return;
    // Keep Haven's bundled flag category — its :flag_xx: images render on every
    // OS, unlike Unicode's regional-indicator flags — and layer the rest under it.
    const flags = this.emojiCategories.Flags;
    this.emojiCategories = { ...data.categories, ...(flags ? { Flags: flags } : {}) };
    this.emojis = Object.values(this.emojiCategories).flat();
    // Built-in keywords are richer than Unicode's bare names, so let them win
    // where they exist and use the Unicode name to fill every other gap.
    this.emojiNames = { ...data.names, ...this.emojiNames };
    if (Array.isArray(data.modifierBase) && data.modifierBase.length) {
      this._emojiModifierBase = new Set(data.modifierBase.map(h => String.fromCodePoint(parseInt(h, 16))));
    }
  } catch { /* keep the built-in list */ }
},

async _loadCustomEmojis() {
  try {
    const res = await fetch('/api/emojis', {
      headers: { 'Authorization': `Bearer ${this.token}` }
    });
    if (!res.ok) return;
    const data = await res.json();
    this.customEmojis = data.emojis || []; // [{name, url}]
    this._renderEmojiList(this.customEmojis);
  } catch { /* ignore */ }
},

_renderEmojiList(emojis) {
  const list = document.getElementById('custom-emojis-list');
  if (!list) return;

  if (emojis.length === 0) {
    list.innerHTML = '<p class="muted-text">No custom emojis uploaded</p>';
    return;
  }

  list.innerHTML = emojis.map(e => `
    <div class="custom-sound-item">
      <img src="${this._escapeHtml(e.url)}" alt=":${this._escapeHtml(e.name)}:" class="custom-emoji-preview" style="width:24px;height:24px;vertical-align:middle;margin-right:6px;">
      <span class="custom-sound-name">:${this._escapeHtml(e.name)}:</span>
      <button class="btn-xs emoji-delete-btn" data-name="${this._escapeHtml(e.name)}" title="Delete">&#x1F5D1;</button>
    </div>
  `).join('');

  list.querySelectorAll('.emoji-delete-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const name = btn.dataset.name;
      try {
        const res = await fetch(`/api/emojis/${encodeURIComponent(name)}`, {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${this.token}` }
        });
        if (res.ok) {
          this._showToast(`Emoji :${name}: deleted`, 'success');
          this._loadCustomEmojis();
        } else {
          this._showToast('Delete failed', 'error');
        }
      } catch {
        this._showToast('Delete failed', 'error');
      }
    });
  });
},

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// STICKERS (admin upload, anyone can send)
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

async _loadStickers() {
  try {
    const res = await fetch('/api/stickers', {
      headers: { 'Authorization': `Bearer ${this.token}` }
    });
    if (!res.ok) return;
    const data = await res.json();
    this.stickers = data.stickers || [];
    this._renderStickerList(this.stickers);
  } catch { /* ignore */ }
},

_renderStickerList(stickers) {
  const list = document.getElementById('stickers-list');
  if (!list) return;
  if (!stickers || stickers.length === 0) {
    list.innerHTML = '<p class="muted-text" data-i18n="modals.sticker_mgmt.no_stickers">No stickers uploaded</p>';
    return;
  }
  // Group by pack for display
  const packs = {};
  stickers.forEach(s => {
    const p = s.pack_name || 'General';
    (packs[p] = packs[p] || []).push(s);
  });
  list.innerHTML = Object.keys(packs).sort().map(pack => `
    <div class="sticker-pack-group" style="margin-top:8px">
      <div style="font-size:0.75rem;font-weight:600;margin-bottom:4px;color:var(--text-secondary)">${this._escapeHtml(pack)}</div>
      ${packs[pack].map(s => `
        <div class="custom-sound-item">
          <img src="${this._escapeHtml(s.url)}" alt=":${this._escapeHtml(s.name)}:" style="width:48px;height:48px;vertical-align:middle;margin-right:8px;object-fit:contain;border-radius:4px;background:var(--bg-secondary)">
          <span class="custom-sound-name">:${this._escapeHtml(s.name)}:</span>
          <button class="btn-xs sticker-delete-btn" data-name="${this._escapeHtml(s.name)}" title="Delete">&#x1F5D1;</button>
        </div>
      `).join('')}
    </div>
  `).join('');

  list.querySelectorAll('.sticker-delete-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const name = btn.dataset.name;
      try {
        const res = await fetch(`/api/stickers/${encodeURIComponent(name)}`, {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${this.token}` }
        });
        if (res.ok) {
          this._showToast(`Sticker :${name}: deleted`, 'success');
          this._loadStickers();
        } else {
          this._showToast('Delete failed', 'error');
        }
      } catch {
        this._showToast('Delete failed', 'error');
      }
    });
  });
},

_setupStickerManagement() {
  const openBtn = document.getElementById('open-sticker-manager-btn');
  const modal = document.getElementById('sticker-modal');
  const closeBtn = document.getElementById('close-sticker-modal-btn');
  const uploadBtn = document.getElementById('sticker-upload-btn');
  const bulkInput = document.getElementById('sticker-bulk-input');
  const fileInput = document.getElementById('sticker-file-input');
  const nameInput = document.getElementById('sticker-name-input');
  const packInput = document.getElementById('sticker-pack-input');

  if (openBtn && modal) {
    openBtn.addEventListener('click', () => {
      modal.style.display = 'flex';
      this._loadStickers();
    });
  }
  if (closeBtn && modal) {
    closeBtn.addEventListener('click', () => { modal.style.display = 'none'; });
  }

  if (uploadBtn && fileInput) {
    uploadBtn.addEventListener('click', async () => {
      const file = fileInput.files[0];
      if (!file) return this._showToast('Choose a file first', 'error');
      const maxKb = parseInt(this.serverSettings?.max_sticker_kb) || 1024;
      if (file.size > maxKb * 1024) return this._showToast(`File exceeds ${maxKb} KB limit`, 'error');

      const formData = new FormData();
      formData.append('sticker', file, file.name);
      const name = (nameInput?.value || '').trim();
      const pack = (packInput?.value || '').trim();
      if (name) formData.append('name', name);
      if (pack) formData.append('pack_name', pack);

      try {
        const res = await fetch('/api/upload-sticker', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${this.token}` },
          body: formData
        });
        if (!res.ok) {
          let errMsg = `Upload failed (${res.status})`;
          try { const d = await res.json(); errMsg = d.error || errMsg; } catch {}
          return this._showToast(errMsg, 'error');
        }
        const data = await res.json();
        this._showToast(`Sticker :${data.name}: uploaded`, 'success');
        if (nameInput) nameInput.value = '';
        fileInput.value = '';
        this._loadStickers();
      } catch {
        this._showToast('Upload failed', 'error');
      }
    });
  }

  if (bulkInput) {
    bulkInput.addEventListener('change', async () => {
      const files = Array.from(bulkInput.files || []);
      if (!files.length) return;

      const maxKb = parseInt(this.serverSettings?.max_sticker_kb) || 1024;
      const formData = new FormData();
      let skipped = 0;
      for (const file of files) {
        if (file.size > maxKb * 1024) {
          skipped++;
          continue;
        }
        formData.append('stickers', file, file.name);
      }
      if ([...formData.entries()].length === 0) {
        bulkInput.value = '';
        return this._showToast(`All files exceeded the ${maxKb} KB limit`, 'error');
      }

      const pack = (packInput?.value || '').trim();
      if (pack) formData.append('pack_name', pack);

      try {
        this._showToast(`Uploading ${files.length - skipped} sticker${files.length - skipped !== 1 ? 's' : ''}...`, 'info');
        const res = await fetch('/api/upload-stickers', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${this.token}` },
          body: formData
        });
        if (!res.ok) {
          let errMsg = `Upload failed (${res.status})`;
          try { const d = await res.json(); errMsg = d.error || errMsg; } catch {}
          return this._showToast(errMsg, 'error');
        }

        const data = await res.json();
        const count = data.uploaded?.length || 0;
        const errCount = (data.errors?.length || 0) + skipped;
        let msg = `${count} sticker${count !== 1 ? 's' : ''} uploaded`;
        if (errCount) msg += ` (${errCount} skipped)`;
        this._showToast(msg, count ? 'success' : 'error');
        this._loadStickers();
      } catch {
        this._showToast('Bulk upload failed', 'error');
      }

      bulkInput.value = '';
    });
  }

  this._loadStickers();
},

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// WEBHOOKS / BOT MANAGEMENT
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

_setupWebhookManagement() {
  // ── Ferry (Discord bridge) ──
  document.getElementById('open-ferry-btn')?.addEventListener('click', () => this._openFerryModal());
  document.getElementById('ferry-close-btn')?.addEventListener('click', () => this._closeFerryModal());
  document.getElementById('ferry-refresh-btn')?.addEventListener('click', () => {
    this.socket.emit('ferry:reconnect');
    this._showToast('Reconnecting to Discord...', 'info');
  });
  document.getElementById('ferry-modal')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) this._closeFerryModal();
  });

  // Open bot management modal
  const openBtn = document.getElementById('open-bot-editor-btn');
  if (openBtn) {
    openBtn.addEventListener('click', () => this._openBotModal());
  }
  // Close bot modal
  document.getElementById('close-bot-modal-btn')?.addEventListener('click', () => {
    document.getElementById('bot-modal').style.display = 'none';
  });
  document.getElementById('bot-modal')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) e.currentTarget.style.display = 'none';
  });
  // Create new bot
  document.getElementById('create-bot-btn')?.addEventListener('click', () => {
    this._createNewBot();
  });
},

_openBotModal() {
  document.getElementById('bot-modal').style.display = 'flex';
  document.getElementById('bot-detail-panel').innerHTML = `<p class="muted-text" style="padding:20px;text-align:center">${t('modals.bot_mgmt.select_or_create')}</p>`;
  // Request all webhooks for the sidebar
  this.socket.emit('get-webhooks');
},

async _createNewBot() {
  const name = await this._showPromptModal(t('modals.bot_mgmt.create_title'), t('modals.bot_mgmt.create_name_prompt'));
  if (!name || !name.trim()) return;
  // Pick first non-DM channel as default
  const firstChannel = this.channels.find(c => !c.is_dm);
  if (!firstChannel) return this._showToast(t('modals.bot_mgmt.no_channels'), 'error');
  this.socket.emit('create-webhook', { name: name.trim(), channel_id: firstChannel.id, avatar_url: null });
},

_renderBotSidebar(webhooks) {
  const sidebar = document.getElementById('bot-list-sidebar');
  if (!sidebar) return;
  this._botWebhooks = webhooks; // cache for detail panel
  sidebar.innerHTML = webhooks.map(wh => {
    const avatarHtml = wh.avatar_url
      ? `<img src="${this._escapeHtml(wh.avatar_url)}" style="width:20px;height:20px;border-radius:50%;object-fit:cover;flex-shrink:0">`
      : `<span style="width:20px;height:20px;border-radius:50%;background:var(--accent);display:flex;align-items:center;justify-content:center;font-size:0.625rem;flex-shrink:0;color:#fff">🤖</span>`;
    const activeClass = this._selectedBotId === wh.id ? ' active' : '';
    return `<div class="role-sidebar-item${activeClass}" data-bot-id="${wh.id}">${avatarHtml}<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${this._escapeHtml(wh.name)}</span></div>`;
  }).join('');

  sidebar.querySelectorAll('.role-sidebar-item').forEach(item => {
    item.addEventListener('click', () => {
      const botId = parseInt(item.dataset.botId);
      this._selectedBotId = botId;
      // Highlight active
      sidebar.querySelectorAll('.role-sidebar-item').forEach(i => i.classList.remove('active'));
      item.classList.add('active');
      this._showBotDetail(botId);
    });
  });
},

_showBotDetail(botId) {
  const wh = (this._botWebhooks || []).find(w => w.id === botId);
  if (!wh) return;
  const panel = document.getElementById('bot-detail-panel');
  const baseUrl = window.location.origin;
  const tokenVisible = typeof wh.token === 'string' && wh.token.length > 0;
  const webhookUrl = tokenVisible ? `${baseUrl}/api/webhooks/${wh.token}` : '';
  const maskedToken = tokenVisible ? wh.token.slice(0, 12) + '••••••••••••' : 'Hidden - bot owner or admin only';
  const channelOptions = this._getBotChannelOptions(wh.channel_id);

  panel.innerHTML = `
    <div class="role-detail-form">
      <label class="settings-label">${t('modals.bot_mgmt.avatar_label')}</label>
      <div class="bot-avatar-row" style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
        <div class="bot-avatar-preview" style="width:48px;height:48px;border-radius:50%;overflow:hidden;border:2px solid var(--border);background:var(--bg-tertiary);flex-shrink:0;display:flex;align-items:center;justify-content:center">
          ${wh.avatar_url ? `<img src="${this._escapeHtml(wh.avatar_url)}" style="width:100%;height:100%;object-fit:cover">` : '<span style="font-size:1.5rem">🤖</span>'}
        </div>
        <div style="display:flex;flex-direction:column;gap:4px">
          <button class="btn-xs btn-accent" id="bot-upload-avatar-btn">📷 ${t('modals.bot_mgmt.upload_avatar_btn')}</button>
          <button class="btn-xs" id="bot-remove-avatar-btn" ${wh.avatar_url ? '' : 'disabled'}>${t('modals.bot_mgmt.remove_avatar_btn')}</button>
        </div>
        <input type="file" id="bot-avatar-file-input" accept="image/png,image/jpeg,image/gif,image/webp" style="display:none">
      </div>

      <label class="settings-label">${t('modals.bot_mgmt.name_label')}</label>
      <input type="text" id="bot-detail-name" value="${this._escapeHtml(wh.name)}" maxlength="32" class="settings-text-input" style="width:100%;margin-bottom:8px">

      <label class="settings-label">${t('modals.bot_mgmt.channel_label')}</label>
      <select id="bot-detail-channel" class="settings-select" style="width:100%;margin-bottom:8px">${channelOptions}</select>

      <label class="settings-label">${t('modals.bot_mgmt.status_label')}</label>
      <label class="toggle-row" style="margin-bottom:8px">
        <span>${wh.is_active ? `🟢 ${t('modals.bot_mgmt.status_active')}` : `🔴 ${t('modals.bot_mgmt.status_disabled')}`}</span>
        <button class="btn-xs" id="bot-detail-toggle">${wh.is_active ? t('modals.bot_mgmt.disable_btn') : t('modals.bot_mgmt.enable_btn')}</button>
      </label>

      <label class="settings-label">${t('modals.bot_mgmt.webhook_url_label')}</label>
      <div style="display:flex;gap:4px;align-items:center;margin-bottom:8px">
        <code style="flex:1;font-size:0.6875rem;padding:6px 8px;background:var(--bg-input);border-radius:4px;color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${this._escapeHtml(webhookUrl || 'Hidden - bot owner or admin only')}</code>
        <button class="btn-xs" id="bot-detail-copy-url" title="${t('modals.bot_mgmt.copy_url_title')}" ${tokenVisible ? '' : 'disabled'}>📋</button>
      </div>

      <label class="settings-label">${t('modals.bot_mgmt.token_label')}</label>
      <div style="font-size:0.6875rem;font-family:monospace;padding:4px 8px;background:var(--bg-input);border-radius:4px;color:var(--text-muted);margin-bottom:12px">${maskedToken}</div>

      <label class="settings-label">📡 Callback URL <span style="font-size:0.625rem;color:var(--text-muted)">(optional — Haven will POST messages to this URL)</span></label>
      <input type="url" id="bot-detail-callback-url" value="${this._escapeHtml(wh.callback_url || '')}" placeholder="https://mybot.example.com/haven-events" class="settings-text-input" style="width:100%;margin-bottom:8px">

      <label class="settings-label">🔑 Callback Secret <span style="font-size:0.625rem;color:var(--text-muted)">(optional — used to sign payloads via X-Haven-Signature)</span></label>
      <input type="text" id="bot-detail-callback-secret" value="${this._escapeHtml(wh.callback_secret || '')}" placeholder="my-secret-key" class="settings-text-input" style="width:100%;margin-bottom:12px">

      <label class="settings-label">🛡️ Moderation <span style="font-size:0.625rem;color:var(--text-muted)">(admin only — let this bot kick / ban / mute users via REST API)</span></label>
      <label class="toggle-row" style="margin-bottom:12px">
        <input type="checkbox" id="bot-detail-can-moderate" ${wh.can_moderate ? 'checked' : ''} ${this.user && this.user.isAdmin ? '' : 'disabled'}>
        <span>Allow this bot to perform moderation actions</span>
      </label>

      <label class="settings-label">Voice access <span style="font-size:0.625rem;color:var(--text-muted)">(admin only - lets this bot join voice as a WebRTC peer)</span></label>
      <label class="toggle-row" style="margin-bottom:12px">
        <input type="checkbox" id="bot-detail-can-use-voice" ${wh.can_use_voice ? 'checked' : ''} ${this.user && this.user.isAdmin ? '' : 'disabled'}>
        <span>Allow this bot to use voice channels</span>
      </label>

      <div style="display:flex;gap:8px;margin-top:8px">
        <button class="btn-sm btn-accent" id="bot-detail-save" style="flex:1">💾 ${t('modals.bot_mgmt.save_btn')}</button>
        <button class="btn-sm btn-danger" id="bot-detail-delete">&#x1F5D1; ${t('modals.bot_mgmt.delete_btn')}</button>
      </div>
    </div>
  `;

  // Wire up handlers
  panel.querySelector('#bot-upload-avatar-btn').addEventListener('click', () => {
    panel.querySelector('#bot-avatar-file-input').click();
  });
  panel.querySelector('#bot-avatar-file-input').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    this._uploadBotAvatar(botId, file);
  });
  panel.querySelector('#bot-remove-avatar-btn').addEventListener('click', () => {
    this.socket.emit('update-webhook', { id: botId, avatar_url: '' });
  });
  panel.querySelector('#bot-detail-save').addEventListener('click', () => {
    const name = panel.querySelector('#bot-detail-name').value.trim();
    const channelId = parseInt(panel.querySelector('#bot-detail-channel').value);
    const callbackUrl = panel.querySelector('#bot-detail-callback-url').value.trim();
    const callbackSecret = panel.querySelector('#bot-detail-callback-secret').value.trim();
    if (!name) return this._showToast('Name is required', 'error');
    const payload = { id: botId, name, channel_id: channelId, callback_url: callbackUrl, callback_secret: callbackSecret };
    const modBox = panel.querySelector('#bot-detail-can-moderate');
    if (modBox && !modBox.disabled) payload.can_moderate = modBox.checked ? 1 : 0;
    const voiceBox = panel.querySelector('#bot-detail-can-use-voice');
    if (voiceBox && !voiceBox.disabled) payload.can_use_voice = voiceBox.checked ? 1 : 0;
    this.socket.emit('update-webhook', payload);
  });
  panel.querySelector('#bot-detail-toggle').addEventListener('click', () => {
    this.socket.emit('toggle-webhook', { id: botId });
  });
  panel.querySelector('#bot-detail-copy-url').addEventListener('click', () => {
    if (!webhookUrl) return;
    const markCopied = () => {
      panel.querySelector('#bot-detail-copy-url').textContent = '✅';
      setTimeout(() => {
        const btn = panel.querySelector('#bot-detail-copy-url');
        if (btn) btn.textContent = '📋';
      }, 1500);
    };
    navigator.clipboard.writeText(webhookUrl).then(markCopied).catch(() => {
      try {
        const ta = document.createElement('textarea');
        ta.value = webhookUrl;
        ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
        document.body.appendChild(ta);
        ta.focus(); ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        markCopied();
      } catch { /* could not copy */ }
    });
  });
  panel.querySelector('#bot-detail-delete').addEventListener('click', () => {
    if (confirm(`Delete bot "${wh.name}"? This cannot be undone.`)) {
      this._selectedBotId = null;
      this.socket.emit('delete-webhook', { id: botId });
    }
  });
},

/** Build channel <option> list ordered like the sidebar (parents first, sub-channels indented) */
_getBotChannelOptions(selectedId) {
  const regular = this.channels.filter(c => !c.is_dm);
  const parents = regular.filter(c => !c.parent_channel_id);
  const subMap = {};
  regular.filter(c => c.parent_channel_id).forEach(c => {
    if (!subMap[c.parent_channel_id]) subMap[c.parent_channel_id] = [];
    subMap[c.parent_channel_id].push(c);
  });
  let html = '';
  for (const p of parents) {
    const sel = p.id === selectedId ? ' selected' : '';
    html += `<option value="${p.id}"${sel}># ${this._escapeHtml(p.name)}</option>`;
    const subs = subMap[p.id] || [];
    for (const s of subs) {
      const sSel = s.id === selectedId ? ' selected' : '';
      html += `<option value="${s.id}"${sSel}>&nbsp;&nbsp;&nbsp;&nbsp;↳ ${this._escapeHtml(s.name)}</option>`;
    }
  }
  return html;
},

async _uploadBotAvatar(botId, file) {
  const form = new FormData();
  form.append('avatar', file);
  form.append('webhookId', botId);
  try {
    const resp = await fetch('/api/upload-webhook-avatar', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${this.token}` },
      body: form
    });
    const json = await resp.json();
    if (json.url) {
      this.socket.emit('update-webhook', { id: botId, avatar_url: json.url });
      this._showToast('Bot avatar updated', 'success');
    } else {
      this._showToast(json.error || 'Upload failed', 'error');
    }
  } catch (err) {
    this._showToast('Upload failed', 'error');
  }
},

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// LAYOUT DENSITY
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

_setupDensityPicker() {
  const picker = document.getElementById('density-picker');
  if (!picker) return;

  // Restore saved density
  const saved = localStorage.getItem('haven-density') || 'cozy';
  document.documentElement.dataset.density = saved;
  picker.querySelectorAll('.density-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.density === saved);
  });

  picker.addEventListener('click', (e) => {
    const btn = e.target.closest('.density-btn');
    if (!btn) return;
    const density = btn.dataset.density;
    document.documentElement.dataset.density = density;
    localStorage.setItem('haven-density', density);
    picker.querySelectorAll('.density-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });
},

// ── Toggle Style Picker (sliders vs checkboxes) ──
// Sets data-toggle-style on <html>; the CSS does the rest. theme-init.js
// applies the same value pre-paint, so this only has to keep the buttons in
// step and persist the choice.
_setupToggleStylePicker() {
  const picker = document.getElementById('toggle-style-picker');
  if (!picker) return;

  // Sliders are the default; only an explicit 'box' choice differs.
  const saved = localStorage.getItem('haven-toggle-style') === 'box' ? 'box' : 'switch';
  document.documentElement.dataset.toggleStyle = saved;
  picker.querySelectorAll('.density-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.togglestyle === saved);
  });

  picker.addEventListener('click', (e) => {
    const btn = e.target.closest('.density-btn');
    if (!btn) return;
    const style = btn.dataset.togglestyle === 'box' ? 'box' : 'switch';
    document.documentElement.dataset.toggleStyle = style;
    localStorage.setItem('haven-toggle-style', style);
    picker.querySelectorAll('.density-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });
},

// ── Animated Profile Pictures Picker (viewer side) ──
// The other half of the pfp animation policy. The owner's 'disabled' choice
// still wins for everyone; this only decides what THIS viewer sees for pfps
// whose owner allows animation. Applies live, no reload needed.
_setupAnimatePfpPicker() {
  const picker = document.getElementById('animate-pfp-picker');
  if (!picker) return;

  const saved = this._viewerAnimPref();
  picker.querySelectorAll('.density-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.animpfp === saved);
  });

  picker.addEventListener('click', (e) => {
    const btn = e.target.closest('.density-btn');
    if (!btn) return;
    this._setViewerAnimPref(btn.dataset.animpfp);
  });
},

// (#5526) Same shape as the avatar picker above, for GIFs in messages.
_setupAnimateChatPicker() {
  const picker = document.getElementById('animate-chat-picker');
  if (!picker) return;

  const saved = this._viewerChatAnimPref();
  picker.querySelectorAll('.density-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.animchat === saved);
  });

  picker.addEventListener('click', (e) => {
    const btn = e.target.closest('.density-btn');
    if (!btn) return;
    this._setViewerChatAnimPref(btn.dataset.animchat);
  });
},

// ── Font Size Picker ──

// ── Interface Zoom slider ──
// Scales the whole UI by setting the root font-size through --ui-scale (a
// percentage). Everything is sized in rem, so one change rescales the entire
// interface crisply and the layout reflows — no CSS zoom/transform.
_setupZoomSlider() {
  const slider = document.getElementById('ui-zoom-slider');
  if (!slider) return;
  const label = document.getElementById('ui-zoom-value');
  const outBtn = document.getElementById('zoom-out-btn');
  const inBtn = document.getElementById('zoom-in-btn');

  const MIN = parseInt(slider.min, 10) || 70;
  const MAX = parseInt(slider.max, 10) || 150;
  const STEP = parseInt(slider.step, 10) || 5;
  const clamp = (n) => Math.min(MAX, Math.max(MIN, n));

  // Starting value: saved scale, else migrate the old 4-tier setting, else 100.
  const LEGACY = { small: 85, normal: 100, large: 118, 'x-large': 138 };
  let pct = parseInt(localStorage.getItem('haven-zoom'), 10);
  if (!pct) pct = LEGACY[localStorage.getItem('haven-fontsize')] || 100;
  pct = clamp(pct);

  const apply = (value, persist) => {
    pct = clamp(value);
    document.documentElement.style.setProperty('--ui-scale', pct + '%');
    slider.value = pct;
    if (label) label.textContent = pct + '%';
    if (persist) localStorage.setItem('haven-zoom', pct);
  };

  apply(pct, false);
  slider.addEventListener('input', () => apply(parseInt(slider.value, 10) || 100, true));
  outBtn?.addEventListener('click', () => apply(pct - STEP, true));
  inBtn?.addEventListener('click', () => apply(pct + STEP, true));
},

// ── Emoji Reaction Size Picker ──

_setupEmojiSizePicker() {
  const picker = document.getElementById('emoji-size-picker');
  if (!picker) return;

  const saved = localStorage.getItem('haven-emojisize') || 'normal';
  document.documentElement.dataset.emojisize = saved;
  picker.querySelectorAll('[data-emojisize]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.emojisize === saved);
  });

  picker.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-emojisize]');
    if (!btn) return;
    const size = btn.dataset.emojisize;
    document.documentElement.dataset.emojisize = size;
    localStorage.setItem('haven-emojisize', size);
    picker.querySelectorAll('[data-emojisize]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });
},

// ── Debug Section ──

_setupDebugSection() {
  const cb = document.getElementById('pref-debug-local-talk-indicator');
  if (!cb) return;
  try { cb.checked = localStorage.getItem('debug_local_talk_indicator') === '1'; } catch {}
  cb.addEventListener('change', () => {
    try {
      if (cb.checked) localStorage.setItem('debug_local_talk_indicator', '1');
      else localStorage.removeItem('debug_local_talk_indicator');
    } catch {}
  });

  // #5379 — opt-in toggle to re-apply voice processing (echoCancellation /
  // noiseSuppression / autoGainControl) to getDisplayMedia audio. Default
  // off as of 3.17.3 because those filters hollow out music and game audio
  // for listeners. Users sharing tutorial narration or meeting audio can
  // flip this back on. Mic capture is a separate stream and always gets
  // voice processing regardless of this setting.
  const sspCb = document.getElementById('pref-debug-screen-share-voice-proc');
  if (sspCb) {
    try { sspCb.checked = localStorage.getItem('screen_share_voice_processing') === '1'; } catch {}
    sspCb.addEventListener('change', () => {
      try {
        if (sspCb.checked) localStorage.setItem('screen_share_voice_processing', '1');
        else localStorage.removeItem('screen_share_voice_processing');
      } catch {}
    });
  }

  // #5426 — screen-share audio now plays straight through the <audio> element
  // by default (NetEq stays in charge, so it stays in sync over a TURN relay).
  // This opt-in toggle instead routes it through the Web Audio mixer, which
  // unlocks the >100% per-stream volume boost but can stutter / desync over a
  // relay — the same createMediaStreamSource-vs-jitter-buffer fight as before,
  // just no longer the default.
  const sadCb = document.getElementById('pref-debug-screen-audio-direct');
  if (sadCb) {
    try { sadCb.checked = localStorage.getItem('screen_audio_webaudio') === '1'; } catch {}
    sadCb.addEventListener('change', () => {
      try {
        if (sadCb.checked) localStorage.setItem('screen_audio_webaudio', '1');
        else localStorage.removeItem('screen_audio_webaudio');
      } catch {}
      // Apply immediately to any screen audio that's already playing.
      if (this.voice && typeof this.voice.reapplyScreenAudioRouting === 'function') {
        this.voice.reapplyScreenAudioRouting();
      }
    });
  }

  // #5444 — opt-in glare/ICE-restart recovery for voice. When two peers
  // reconnect simultaneously their ICE restarts can collide and leave one
  // audio direction dead until a manual rejoin. This re-queues the restart so
  // the connection repairs itself. Off by default while it's unverified; read
  // live by voice.js on each renegotiation, so no reload is needed.
  const glareCb = document.getElementById('pref-debug-voice-glare-ice-fix');
  if (glareCb) {
    try { glareCb.checked = localStorage.getItem('haven_voice_glare_ice_fix') === '1'; } catch {}
    glareCb.addEventListener('change', () => {
      try {
        if (glareCb.checked) localStorage.setItem('haven_voice_glare_ice_fix', '1');
        else localStorage.removeItem('haven_voice_glare_ice_fix');
      } catch {}
    });
  }

  // #5380 — always join voice muted
  const moCb = document.getElementById('pref-voice-mute-on-join');
  if (moCb) {
    try { moCb.checked = localStorage.getItem('haven_mute_on_join') === '1'; } catch {}
    moCb.addEventListener('change', () => {
      try {
        if (moCb.checked) localStorage.setItem('haven_mute_on_join', '1');
        else localStorage.removeItem('haven_mute_on_join');
      } catch {}
    });
  }

  // #5380 — listener-only (skip mic) voice mode
  const loCb = document.getElementById('pref-voice-listener-only');
  if (loCb) {
    try { loCb.checked = localStorage.getItem('haven_listener_only') === '1'; } catch {}
    loCb.addEventListener('change', () => {
      try {
        if (loCb.checked) localStorage.setItem('haven_listener_only', '1');
        else localStorage.removeItem('haven_listener_only');
      } catch {}
    });
  }
},

// ── Image Display Mode Picker ──

_setupImageModePicker() {
  const picker = document.getElementById('image-mode-picker');
  if (!picker) return;

  // Restore saved image mode (default: thumbnail)
  const saved = localStorage.getItem('haven-image-mode') || 'thumbnail';
  this._applyImageMode(saved);
  picker.querySelectorAll('[data-image-mode]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.imageMode === saved);
  });

  picker.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-image-mode]');
    if (!btn) return;
    const mode = btn.dataset.imageMode;
    this._applyImageMode(mode);
    localStorage.setItem('haven-image-mode', mode);
    picker.querySelectorAll('[data-image-mode]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });
},

_applyImageMode(mode) {
  document.body.classList.toggle('image-mode-full', mode === 'full');
},

// ── Embed / Link Preview Size Picker ──

_setupEmbedSizePicker() {
  const picker = document.getElementById('embed-size-picker');
  if (!picker) return;
  this._applyEmbedSize(this._embedSize());
  picker.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-embed-size]');
    if (btn) this._applyEmbedSize(btn.dataset.embedSize);
  });
},

// Embed size is the single source of truth shared by the Settings picker and
// the per-embed ⤢ toggle (see app-messages.js). Legacy values are migrated.
_normalizeEmbedSize(mode) {
  mode = ({ normal: 'medium', large: 'full' })[mode] || mode;
  return ['full', 'medium', 'small', 'off'].includes(mode) ? mode : 'medium';
},

_embedSize() {
  return this._normalizeEmbedSize(localStorage.getItem('haven-embed-size'));
},

_applyEmbedSize(mode) {
  mode = this._normalizeEmbedSize(mode);
  localStorage.setItem('haven-embed-size', mode);
  document.body.classList.remove('embed-size-off', 'embed-size-small', 'embed-size-medium', 'embed-size-full');
  document.body.classList.add(`embed-size-${mode}`);
  const label = `⤢ ${mode.charAt(0).toUpperCase() + mode.slice(1)}`;
  document.querySelectorAll('.lp-size').forEach(b => { b.textContent = label; });
  const picker = document.getElementById('embed-size-picker');
  if (picker) picker.querySelectorAll('[data-embed-size]').forEach(b => b.classList.toggle('active', b.dataset.embedSize === mode));
},

// ── Role Display Picker ──

_setupRoleDisplayPicker() {
  const picker = document.getElementById('role-display-picker');
  if (!picker) return;

  const saved = localStorage.getItem('haven-role-display') || 'colored-name';
  document.documentElement.dataset.roleDisplay = saved;
  picker.querySelectorAll('[data-roledisplay]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.roledisplay === saved);
  });

  picker.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-roledisplay]');
    if (!btn) return;
    const mode = btn.dataset.roledisplay;
    document.documentElement.dataset.roleDisplay = mode;
    localStorage.setItem('haven-role-display', mode);
    picker.querySelectorAll('[data-roledisplay]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    // Re-render member list to reflect the change
    if (this._updateUsers) this._updateUsers();
  });
},

// ── Toolbar Icon Style Picker ──

_setupToolbarIconPicker() {
  const picker = document.getElementById('toolbar-icon-picker');
  const slotsInput = document.getElementById('toolbar-visible-slots');
  const slotsValue = document.getElementById('toolbar-visible-slots-value');
  const orderList = document.getElementById('toolbar-order-list');
  const resetBtn = document.getElementById('toolbar-order-reset-btn');
  if (!picker) return;

  const defaultOrder = ['react', 'reply', 'quote', 'thread', 'pin', 'archive', 'edit', 'delete'];
  const actionLabels = {
    react: 'React',
    reply: 'Reply',
    quote: 'Quote',
    thread: 'Thread',
    pin: 'Pin / Unpin',
    archive: 'Protect / Unprotect',
    edit: 'Edit',
    delete: 'Delete'
  };

  const normalizeOrder = (value) => {
    const arr = Array.isArray(value) ? value : [];
    const clean = [];
    arr.forEach((k) => {
      if (defaultOrder.includes(k) && !clean.includes(k)) clean.push(k);
    });
    defaultOrder.forEach((k) => {
      if (!clean.includes(k)) clean.push(k);
    });
    return clean;
  };

  const refreshCurrentMessages = () => {
    if (this.currentChannel && this.socket?.connected) {
      this.socket.emit('get-messages', { code: this.currentChannel });
    }
  };

  const savedMode = localStorage.getItem('haven-toolbar-icons') || 'mono';
  const normalizedMode = savedMode === 'color' ? 'emoji' : savedMode;
  document.documentElement.dataset.toolbaricons = normalizedMode;
  picker.querySelectorAll('[data-toolbaricons]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.toolbaricons === normalizedMode);
  });

  let savedSlots = parseInt(localStorage.getItem('haven-toolbar-visible-slots') || '3', 10);
  if (!Number.isFinite(savedSlots)) savedSlots = 3;
  savedSlots = Math.max(1, Math.min(7, savedSlots));
  localStorage.setItem('haven-toolbar-visible-slots', String(savedSlots));
  if (slotsInput) slotsInput.value = String(savedSlots);
  if (slotsValue) slotsValue.textContent = String(savedSlots);

  let savedOrder;
  try {
    savedOrder = JSON.parse(localStorage.getItem('haven-toolbar-order') || '[]');
  } catch {
    savedOrder = [];
  }
  let currentOrder = normalizeOrder(savedOrder);
  localStorage.setItem('haven-toolbar-order', JSON.stringify(currentOrder));

  const renderOrderList = () => {
    if (!orderList) return;
    orderList.innerHTML = '';
    currentOrder.forEach((key, index) => {
      const row = document.createElement('div');
      row.className = 'toolbar-order-item';
      row.innerHTML = `
        <span class="toolbar-order-item-label">${actionLabels[key] || key}</span>
        <div class="toolbar-order-item-controls">
          <button type="button" class="toolbar-order-move" data-dir="up" data-key="${key}" ${index === 0 ? 'disabled' : ''} title="Move up">▲</button>
          <button type="button" class="toolbar-order-move" data-dir="down" data-key="${key}" ${index === currentOrder.length - 1 ? 'disabled' : ''} title="Move down">▼</button>
        </div>
      `;
      orderList.appendChild(row);
    });
  };

  renderOrderList();

  picker.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-toolbaricons]');
    if (!btn) return;
    const mode = btn.dataset.toolbaricons;
    document.documentElement.dataset.toolbaricons = mode;
    localStorage.setItem('haven-toolbar-icons', mode);
    picker.querySelectorAll('[data-toolbaricons]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    refreshCurrentMessages();
  });

  if (slotsInput) {
    slotsInput.addEventListener('input', () => {
      if (slotsValue) slotsValue.textContent = slotsInput.value;
    });
    slotsInput.addEventListener('change', () => {
      const value = Math.max(1, Math.min(7, parseInt(slotsInput.value || '3', 10) || 3));
      localStorage.setItem('haven-toolbar-visible-slots', String(value));
      if (slotsValue) slotsValue.textContent = String(value);
      refreshCurrentMessages();
    });
  }

  if (orderList) {
    orderList.addEventListener('click', (e) => {
      const btn = e.target.closest('.toolbar-order-move');
      if (!btn) return;
      const key = btn.dataset.key;
      const dir = btn.dataset.dir;
      const idx = currentOrder.indexOf(key);
      if (idx < 0) return;
      const swapWith = dir === 'up' ? idx - 1 : idx + 1;
      if (swapWith < 0 || swapWith >= currentOrder.length) return;
      const next = currentOrder.slice();
      [next[idx], next[swapWith]] = [next[swapWith], next[idx]];
      currentOrder = next;
      localStorage.setItem('haven-toolbar-order', JSON.stringify(currentOrder));
      renderOrderList();
      refreshCurrentMessages();
    });
  }

  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      currentOrder = defaultOrder.slice();
      localStorage.setItem('haven-toolbar-order', JSON.stringify(currentOrder));
      renderOrderList();
      refreshCurrentMessages();
    });
  }
},

// ── Image Lightbox ──

_setupLightbox() {
  const lb = document.getElementById('image-lightbox');
  if (!lb) return;
  // Only close when clicking the backdrop (not the image itself)
  lb.addEventListener('click', (e) => {
    if (e.target === lb) this._closeLightbox();
  });
  document.addEventListener('keydown', (e) => {
    if (lb.style.display === 'none') return;
    if (e.key === 'Escape') this._closeLightbox();
    if (e.key === 'ArrowLeft') this._lightboxNavigate(-1);
    if (e.key === 'ArrowRight') this._lightboxNavigate(1);
  });

  // Nav button clicks
  const prevBtn = document.getElementById('lightbox-prev');
  const nextBtn = document.getElementById('lightbox-next');
  if (prevBtn) prevBtn.addEventListener('click', (e) => { e.stopPropagation(); this._lightboxNavigate(-1); });
  if (nextBtn) nextBtn.addEventListener('click', (e) => { e.stopPropagation(); this._lightboxNavigate(1); });

  // Custom context menu for lightbox image (Save, Copy, Open)
  const lbImg = document.getElementById('lightbox-img');
  if (lbImg) {
    lbImg.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this._showImageContextMenu(e, lbImg.src);
    });
  }
},

_getLightboxImages() {
  // Use whichever container opened the lightbox (main feed, thread panel, DM PiP)
  const container = this._lightboxContainer || document.getElementById('messages');
  if (!container) return [];
  return Array.from(container.querySelectorAll('.chat-image')).map(img => img.src);
},

_lightboxNavigate(dir) {
  const imgs = this._getLightboxImages();
  const lbImg = document.getElementById('lightbox-img');
  if (!lbImg || imgs.length < 2) return;
  const curIdx = imgs.indexOf(lbImg.src);
  if (curIdx < 0) return;
  const newIdx = curIdx + dir;
  if (newIdx < 0 || newIdx >= imgs.length) return;
  lbImg.src = imgs[newIdx];
  this._updateLightboxNav();
},

_updateLightboxNav() {
  const imgs = this._getLightboxImages();
  const lbImg = document.getElementById('lightbox-img');
  const prevBtn = document.getElementById('lightbox-prev');
  const nextBtn = document.getElementById('lightbox-next');
  if (!lbImg || !prevBtn || !nextBtn) return;
  const curIdx = imgs.indexOf(lbImg.src);
  prevBtn.disabled = curIdx <= 0;
  nextBtn.disabled = curIdx < 0 || curIdx >= imgs.length - 1;
  // Hide nav if only one image
  const showNav = imgs.length > 1;
  prevBtn.style.display = showNav ? '' : 'none';
  nextBtn.style.display = showNav ? '' : 'none';
},

_openLightbox(src) {
  const lb = document.getElementById('image-lightbox');
  const img = document.getElementById('lightbox-img');
  if (!lb || !img) return;
  img.src = src;
  lb.style.display = 'flex';
  this._updateLightboxNav();
},

_closeLightbox() {
  const lb = document.getElementById('image-lightbox');
  if (lb) { lb.style.display = 'none'; }
  const img = document.getElementById('lightbox-img');
  if (img) { img.src = ''; }
  this._hideImageContextMenu();
},

/* ── Modal Expand / Maximize ────────────────────────── */

_setupModalExpand() {
  // Global guard: track mousedown origin so overlay click-to-close doesn't fire
  // when a resize drag ends outside the modal (cursor lands on overlay)
  let _overlayMouseDownTarget = null;
  document.addEventListener('mousedown', (e) => { _overlayMouseDownTarget = e.target; }, true);
  document.addEventListener('click', (e) => {
    // If click landed on a modal-overlay but mousedown started inside the modal, suppress close
    if (e.target.classList && e.target.classList.contains('modal-overlay') &&
        _overlayMouseDownTarget && _overlayMouseDownTarget !== e.target) {
      e.stopImmediatePropagation();
    }
  }, true); // capturing phase — fires before individual handlers

  // Auto-inject expand/maximize + close buttons into every modal.
  // Buttons live in an absolutely positioned .modal-controls group at the
  // top-right so they work for ALL modal layouts (back buttons, wrapper
  // divs, settings headers, etc) without depending on h3 internal flex.
  const _injectModalControls = () => {
    document.querySelectorAll('.modal').forEach(modal => {
      // Skip promo/centered popups and the media gallery (which has its own
      // header close button) — they're not regular modals (#5352)
      if (modal.classList.contains('android-beta-promo') ||
          modal.classList.contains('desktop-promo') ||
          modal.classList.contains('donors-modal-box') ||
          modal.classList.contains('media-gallery-modal')) return;
      // Idempotent — skip already-injected
      if (modal.dataset.modalControlsInjected === '1') return;
      modal.dataset.modalControlsInjected = '1';

      // Settings/activities headers have their own close button — keep it
      // but inject the expand toggle next to it.
      const settingsClose = modal.querySelector('.settings-close-btn');

      const expandBtn = document.createElement('button');
      expandBtn.type = 'button';
      expandBtn.className = 'modal-expand-btn';
      expandBtn.title = 'Expand / Restore';
      expandBtn.textContent = '⛶';
      expandBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const isMax = modal.classList.toggle('modal-maximized');
        expandBtn.textContent = isMax ? '⊖' : '⛶';
        expandBtn.title = isMax ? 'Restore size' : 'Expand';
      });

      // When a settings-style header is present, slot the expand button
      // directly next to its close button so the two stay aligned on
      // every viewport size. Otherwise drop both controls into a floating
      // group at the top-right of the modal.
      if (settingsClose) {
        expandBtn.classList.add('modal-expand-btn-inline');
        settingsClose.parentElement.insertBefore(expandBtn, settingsClose);
      } else {
        const group = document.createElement('div');
        group.className = 'modal-controls';
        group.appendChild(expandBtn);

        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'modal-expand-btn';
        closeBtn.title = 'Close';
        closeBtn.textContent = '✕';
        closeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const overlay = modal.closest('.modal-overlay');
          if (overlay) overlay.style.display = 'none';
          if (modal.classList.contains('modal-maximized')) {
            modal.classList.remove('modal-maximized');
            expandBtn.textContent = '⛶';
            expandBtn.title = 'Expand / Restore';
          }
        });
        group.appendChild(closeBtn);
        modal.appendChild(group);
      }
    });
  };
  _injectModalControls();
  // Re-run if new modals get inserted later (some plugins/lazy templates)
  this._injectModalControls = _injectModalControls;
},

/** Show a custom image context menu (Save / Copy / Open in tab) */
// ── Hide Image (viewer-side) ──────────────────────────────
// A per-device way to collapse any chat image you don't want to see. Stored
// by normalized absolute URL in localStorage so it persists across reloads
// and re-renders. Distinct from the sender-side "Mark as spoiler" feature:
// spoilers blur for everyone, hiding is a private comfort toggle.

_normalizeImgSrc(u) {
  try { return new URL(u, window.location.origin).href; } catch { return String(u || ''); }
},

_loadHiddenImages() {
  if (this._hiddenImageSet) return this._hiddenImageSet;
  let arr = [];
  try { arr = JSON.parse(localStorage.getItem('haven_hidden_images') || '[]'); } catch {}
  this._hiddenImageSet = new Set(Array.isArray(arr) ? arr : []);
  return this._hiddenImageSet;
},

_saveHiddenImages() {
  try {
    localStorage.setItem('haven_hidden_images', JSON.stringify([...this._loadHiddenImages()]));
  } catch {}
},

_isImageHidden(u) {
  return this._loadHiddenImages().has(this._normalizeImgSrc(u));
},

_hideImage(u) {
  this._loadHiddenImages().add(this._normalizeImgSrc(u));
  this._saveHiddenImages();
},

_unhideImage(u) {
  this._loadHiddenImages().delete(this._normalizeImgSrc(u));
  this._saveHiddenImages();
},

// Slashed-eye ("closed eye") icon — there is no standalone closed-eye emoji,
// so we reuse the same eye-off glyph the password fields use for "hidden".
// `off` true → closed/slashed eye; false → open eye.
_eyeIcon(off, size = 14) {
  return off
    ? `<svg class="eye-icon" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>`
    : `<svg class="eye-icon" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>`;
},

_hiddenImagePlaceholder(u) {
  const abs = this._escapeHtml(this._normalizeImgSrc(u));
  const label = (typeof t === 'function' && t('app.messages.image_hidden')) || 'Image hidden';
  const hint = (typeof t === 'function' && t('app.messages.click_to_show')) || 'click to show';
  return `<span class="hidden-image" role="button" tabindex="0" data-hidden-src="${abs}" title="${this._escapeHtml(hint)}">${this._eyeIcon(true)} ${this._escapeHtml(label)} — ${this._escapeHtml(hint)}</span>`;
},

// Swap a clicked "hidden image" placeholder back to a live image element.
_revealHiddenImage(ph) {
  if (!ph) return;
  const src = ph.dataset.hiddenSrc;
  if (!src) return;
  this._unhideImage(src);
  const img = document.createElement('img');
  // Route through the media proxy like every other remote image, so revealing
  // a hidden image does not turn into the one request that leaks your IP.
  const proxied = this._proxyMediaUrl ? this._proxyMediaUrl(src) : src;
  if (proxied === null) img.setAttribute('data-mp-src', src);
  else img.src = proxied;
  img.className = 'chat-image';
  img.alt = 'image';
  ph.replaceWith(img);
},

_showImageContextMenu(e, src) {
  this._hideImageContextMenu();
  const menu = document.createElement('div');
  menu.id = 'image-context-menu';
  menu.className = 'image-context-menu';
  menu.innerHTML = `
    <button data-action="save">💾 Save Image</button>
    <button data-action="copy">📋 Copy Image</button>
    <button data-action="open">🔗 Open in New Tab</button>
    <button data-action="hide">🙈 ${this._escapeHtml((typeof t === 'function' && t('app.messages.hide_image')) || 'Hide Image')}</button>
  `;
  menu.style.left = e.clientX + 'px';
  menu.style.top = e.clientY + 'px';
  document.body.appendChild(menu);

  // Warm the image bytes while the menu is on screen. By the time "Copy Image"
  // is clicked this is usually already resolved, so the clipboard write is the
  // first thing that awaits rather than the last. Errors are swallowed here —
  // the copy handler re-fetches and reports properly if this didn't land.
  this._ctxImageBlobSrc = src;
  this._ctxImageBlob = (async () => {
    const resp = await fetch(src, { credentials: 'same-origin' });
    if (!resp.ok) throw new Error('fetch ' + resp.status);
    const blob = await resp.blob();
    if (blob.type === 'image/png') return blob;
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    return await new Promise((res, rej) =>
      canvas.toBlob(b => b ? res(b) : rej(new Error('toBlob null')), 'image/png'));
  })();
  this._ctxImageBlob.catch(() => { this._ctxImageBlob = null; });
  // Clamp to viewport
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = (window.innerWidth - rect.width - 8) + 'px';
  if (rect.bottom > window.innerHeight) menu.style.top = (window.innerHeight - rect.height - 8) + 'px';

  menu.addEventListener('click', async (ev) => {
    const action = ev.target.dataset.action;
    if (action === 'save') {
      const a = document.createElement('a');
      a.href = src;
      a.download = src.split('/').pop().split('?')[0] || 'image';
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      a.remove();
    } else if (action === 'copy') {
      // Hide the menu immediately so it doesn't sit on screen during
      // the async fetch + clipboard write. We still control the toast.
      this._hideImageContextMenu();
      (async () => {
        const isDesktop = !!(window.havenDesktop?.isDesktopApp || window.havenDesktop?.clipboardWriteImage);
        const fetchAsBlob = async () => {
          // Prefer the blob the menu started warming on open.
          if (this._ctxImageBlob && this._ctxImageBlobSrc === src) {
            try {
              const warmed = await this._ctxImageBlob;
              if (warmed) return warmed;
            } catch { /* fall through to fresh fetch */ }
          }
          const resp = await fetch(src, { credentials: 'same-origin' });
          if (!resp.ok) throw new Error('fetch ' + resp.status);
          return await resp.blob();
        };
        // Last-resort decode from an already-painted <img> (lightbox or chat).
        // Survives when fetch is blocked (CORS / opaque redirect) but the
        // browser already decoded the pixels for display.
        const blobFromDomImage = async () => {
          const candidates = [];
          const lb = document.getElementById('lightbox-img');
          if (lb?.src) candidates.push(lb);
          document.querySelectorAll('img.chat-image').forEach(img => {
            if (img.src === src || this._normalizeImgSrc?.(img.getAttribute('src')) === this._normalizeImgSrc?.(src)) {
              candidates.push(img);
            }
          });
          for (const img of candidates) {
            try {
              if (!img.naturalWidth) continue;
              const canvas = document.createElement('canvas');
              canvas.width = img.naturalWidth;
              canvas.height = img.naturalHeight;
              canvas.getContext('2d').drawImage(img, 0, 0);
              const blob = await new Promise((res, rej) =>
                canvas.toBlob(b => b ? res(b) : rej(new Error('toBlob null')), 'image/png'));
              if (blob) return blob;
            } catch { /* tainted canvas or detached node — try next */ }
          }
          return null;
        };
        const toPngBlob = async (blob) => {
          if (blob.type === 'image/png') return blob;
          const bitmap = await createImageBitmap(blob);
          const canvas = document.createElement('canvas');
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
          canvas.getContext('2d').drawImage(bitmap, 0, 0);
          return await new Promise((res, rej) =>
            canvas.toBlob(b => b ? res(b) : rej(new Error('toBlob null')), 'image/png'));
        };
        const blobToBase64 = async (blob) => {
          const buf = await blob.arrayBuffer();
          const bytes = new Uint8Array(buf);
          // Chunked binary→base64 so large screenshots don't blow the call stack.
          const chunk = 0x8000;
          let binary = '';
          for (let i = 0; i < bytes.length; i += chunk) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
          }
          return btoa(binary);
        };
        const resolvePngBlob = async () => {
          try {
            return await toPngBlob(await fetchAsBlob());
          } catch (fetchErr) {
            console.warn('[Haven] Image fetch for copy failed, trying DOM decode:', fetchErr);
            const domBlob = await blobFromDomImage();
            if (!domBlob) throw fetchErr;
            return domBlob.type === 'image/png' ? domBlob : await toPngBlob(domBlob);
          }
        };

        // Strategy 1: Electron desktop IPC (most reliable — main process
        // clipboard has no user-gesture requirement). Prefer raw base64 over
        // a data: URL so IPC doesn't pay the "data:image/png;base64," tax on
        // multi‑MB screenshots.
        if (window.havenDesktop?.clipboardWriteImage) {
          try {
            try { window.focus(); } catch {}
            const png = await resolvePngBlob();
            const b64 = await blobToBase64(png);
            const res = await window.havenDesktop.clipboardWriteImage(b64);
            if (res?.ok) { this._showToast('Image copied to clipboard', 'success'); return; }
            console.warn('[Haven] IPC clipboard write failed:', res?.reason);
            // Fall through — still try web/desktop text fallbacks.
          } catch (err) {
            console.warn('[Haven] IPC clipboard path errored:', err);
          }
        }

        // Strategy 2: web navigator.clipboard.write with promise-based
        // ClipboardItem (preserves gesture chain across async fetch).
        try {
          if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) {
            throw new Error('Clipboard API unavailable');
          }
          // Chromium rejects clipboard writes with "Write permission denied"
          // whenever the document isn't focused — which is the normal state
          // right after dismissing a context menu, and the reported failure
          // here. Pull focus back before asking, and give the focus change a
          // frame to land.
          if (!document.hasFocus()) {
            try { window.focus(); } catch {}
            await new Promise(r => requestAnimationFrame(r));
          }
          // Reuse the blob the menu started fetching on open where possible, so
          // a slow image can't stretch this past the transient user activation.
          const blobPromise = (async () => resolvePngBlob())();
          await navigator.clipboard.write([
            new ClipboardItem({ 'image/png': blobPromise })
          ]);
          this._showToast('Image copied to clipboard', 'success');
          return;
        } catch (err) {
          console.error('[Haven] Web clipboard.write failed:', err);
          // Strategy 3: at least put the URL on the clipboard so the
          // user has something to paste. On desktop, route text through
          // main-process IPC too — navigator.clipboard is often gesture-
          // locked in Electron BrowserViews after a context menu closes.
          try {
            if (window.havenDesktop?.clipboardWriteText) {
              const res = await window.havenDesktop.clipboardWriteText(src);
              if (res?.ok) {
                this._showToast('Copied image URL (image bytes unavailable)', 'warning');
                return;
              }
            }
            await navigator.clipboard.writeText(src);
            this._showToast(
              isDesktop
                ? 'Copied image URL (could not copy image pixels)'
                : 'Copied image URL (browser blocked image copy)',
              'warning'
            );
            return;
          } catch (err2) {
            console.error('[Haven] writeText fallback failed:', err2);
            // Report the failure that actually ended the chain. Previously this
            // surfaced err (the image write) even though err2 (the text write)
            // is what just failed, which sent debugging down the wrong path.
            const denied = /denied|NotAllowed/i.test(String(err2?.name) + String(err2?.message));
            this._showToast(
              denied
                ? (isDesktop
                    ? 'Could not access clipboard — click inside Haven and try Copy Image again'
                    : 'Clipboard blocked by the browser — click the page first, then retry')
                : 'Failed to copy image: ' + (err2?.message || err2),
              'error'
            );
          }
        }
      })();
      return;
    } else if (action === 'open') {
      window.open(src, '_blank', 'noopener,noreferrer');
    } else if (action === 'hide') {
      this._hideImage(src);
      // Collapse every live copy of this image to a placeholder right away.
      const abs = this._normalizeImgSrc(src);
      document.querySelectorAll('img.chat-image').forEach(img => {
        if (this._normalizeImgSrc(img.getAttribute('src')) === abs) {
          const tmp = document.createElement('div');
          tmp.innerHTML = this._hiddenImagePlaceholder(abs);
          img.replaceWith(tmp.firstElementChild);
        }
      });
      // If hidden from the lightbox, close it too.
      this._closeLightbox?.();
    }
    this._hideImageContextMenu();
  });

  // Close on click elsewhere
  const closer = (ev) => {
    if (!menu.contains(ev.target)) {
      this._hideImageContextMenu();
      document.removeEventListener('click', closer, true);
      document.removeEventListener('contextmenu', closer, true);
    }
  };
  setTimeout(() => {
    document.addEventListener('click', closer, true);
    document.addEventListener('contextmenu', closer, true);
  }, 0);
},

_hideImageContextMenu() {
  const existing = document.getElementById('image-context-menu');
  if (existing) existing.remove();
},

};
