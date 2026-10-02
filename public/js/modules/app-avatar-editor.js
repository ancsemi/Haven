// Profile pictures: uploading, cropping and the border editor, saving the
// avatar settings, and drawing a saved border on avatars everywhere.

export default {

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// AVATAR / PFP CUSTOMIZER
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

_updateAvatarPreview() {
  const preview = document.getElementById('avatar-upload-preview');
  if (!preview) return;
  if (this.user.avatar) {
    preview.innerHTML = `<img src="${this._escapeHtml(this.user.avatar)}" alt="${t('media_runtime.avatar.alt')}">`;
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
    preview.innerHTML = `<img src="${this._escapeHtml(this.user.border)}" alt="${t('media_runtime.avatar.border_alt')}">`;
  } else {
    preview.innerHTML = `<div style="width:100%;height:100%;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:0.7rem;color:var(--text-muted)">${t('media_runtime.none')}</div>`;
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

// ── Avatar editing ──
// The avatar reuses the border editor in 'avatar' mode with only the Crop tool.
// Unlike the border, the result is baked: Done draws the crop to a canvas and
// stages it as the pending avatar file, so every surface (push icons, native
// apps) shows it. The avatar keeps a single crop, _avatarCrop, over the unedited
// _avatarEditSource; reopening the editor loads it back as the live draft, so it
// can be adjusted or discarded until the next Save. Stills only: a canvas holds
// one frame, so animated images keep their Edit button disabled.

// Committed op log of whichever image the editor is open on. The avatar has none:
// its one crop is the draft while editing and is stored by Done.
_ops() {
  return this._editTarget === 'avatar' ? [] : this._borderOps;
},

// Point the avatar editor at a new unedited image (a picked File, the saved URL,
// or null), clear its crop, and work out whether it is animated. openEditor opens
// the editor once the image is known to be still (used right after a pick).
_setAvatarEditSource(src, file, openEditor = false) {
  this._avatarEditSource = src || null;
  this._avatarEditFile = file || null;
  this._avatarCrop = null;
  this._avatarEditBaked = false;
  this._avatarIsAnimated = null;
  const token = (this._avatarEditToken = (this._avatarEditToken || 0) + 1);
  const settle = (animated) => {
    if (token !== this._avatarEditToken) return; // a newer source replaced this one
    this._avatarIsAnimated = animated;
    this._updateAvatarEditButton();
    const profileOpen = document.getElementById('rename-modal')?.style.display === 'flex';
    if (openEditor && animated === false && profileOpen) this._openImageEditor('avatar');
  };
  if (file) {
    file.arrayBuffer().then((buf) => settle(this._isAnimatedImageBytes(buf)), () => settle(null));
  } else if (src && !this._animCanAnimate(src)) {
    settle(false);
  } else if (src) {
    fetch(src).then((r) => r.arrayBuffer()).then((buf) => settle(this._isAnimatedImageBytes(buf)), () => settle(null));
  }
  this._updateAvatarEditButton();
},

// Called when Edit Profile opens: edit the saved avatar, as the preview shows.
_resetAvatarEditState() {
  this._setAvatarEditSource(this.user.avatar || null, null);
},

// Edit Profile closed without saving: drop the picked (or cleared) avatar and the
// "Unsaved changes" label. The border, shape and animation choices are already
// reset from the saved values each time the modal opens.
_discardPendingAvatar() {
  this._pendingAvatarFile = null;
  this._pendingAvatarPreviewUrl = null;
  this._pendingAvatarRemoved = false;
  this._updateAvatarPreview();
  this._resetAvatarEditState();
  const status = document.getElementById('avatar-save-status');
  if (status) { status.textContent = ''; status.style.color = ''; }
},

// Edit needs a still image to work on; animated ones get a short note instead.
_updateAvatarEditButton() {
  const has = !!this._avatarEditSource && !this._pendingAvatarRemoved;
  const btn = document.getElementById('avatar-crop-btn');
  if (btn) btn.disabled = !has || this._avatarIsAnimated !== false;
  const note = document.getElementById('avatar-edit-note');
  if (note) note.style.display = (has && this._avatarIsAnimated === true) ? 'block' : 'none';
},

// True for a GIF with more than one frame, an APNG, or an animated WebP.
_isAnimatedImageBytes(buf) {
  const b = new Uint8Array(buf);
  const str = (p, n) => String.fromCharCode(...b.subarray(p, p + n));
  if (str(0, 3) === 'GIF') {
    // Walk the block stream and count image descriptors.
    let p = 13;
    if (b[10] & 0x80) p += 3 * (1 << ((b[10] & 7) + 1));
    let frames = 0;
    const skipSubBlocks = () => { while (p < b.length && b[p]) p += b[p] + 1; p++; };
    while (p < b.length) {
      if (b[p] === 0x2C) {
        if (++frames > 1) return true;
        const packed = b[p + 9];
        p += 10;
        if (packed & 0x80) p += 3 * (1 << ((packed & 7) + 1));
        p++; // LZW minimum code size
        skipSubBlocks();
      } else if (b[p] === 0x21) {
        p += 2;
        skipSubBlocks();
      } else {
        break; // trailer
      }
    }
    return false;
  }
  if (b[0] === 0x89 && str(1, 3) === 'PNG') {
    // An acTL chunk ahead of the image data marks an APNG.
    let p = 8;
    while (p + 8 <= b.length) {
      const len = ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
      const type = str(p + 4, 4);
      if (type === 'acTL') return true;
      if (type === 'IDAT') return false;
      p += 12 + len;
    }
    return false;
  }
  if (str(0, 4) === 'RIFF' && str(8, 4) === 'WEBP') {
    return str(12, 4) === 'VP8X' && !!(b[20] & 0x02);
  }
  return false;
},

// Open the editor on the border or the avatar. The avatar shows only Crop; its
// saved crop comes back as the live draft so it can be adjusted or discarded.
_openImageEditor(target) {
  if (!Array.isArray(this._borderOps)) this._borderOps = [];
  this._editTarget = target;
  this._borderDraft = null;
  this._borderTool = 'crop';
  this._resizeAnchor = 'center';
  this._cropLocked = false;
  this._setupBorderEditor();
  const modal = document.getElementById('border-crop-modal');
  // Show the modal first so the stage has real dimensions before rendering.
  if (modal) modal.style.display = 'flex';
  this._selectBorderTool('crop');
  if (target === 'avatar' && this._avatarCrop) {
    this._borderDraft = { ...this._avatarCrop };
    this._renderBorderEditor();
  }
},

// Done in avatar mode: bake _avatarCrop into a new pending avatar file. With no
// crop left, fall back to the unedited image.
_applyAvatarEdits() {
  const preview = document.getElementById('avatar-upload-preview');
  const showPreview = (url) => {
    if (!preview) return;
    const img = document.createElement('img');
    img.src = url;
    img.alt = t('media_runtime.avatar.preview_alt');
    preview.innerHTML = '';
    preview.appendChild(img);
  };
  if (!this._avatarCrop) {
    if (!this._avatarEditBaked) return;
    this._avatarEditBaked = false;
    this._pendingAvatarFile = this._avatarEditFile;
    this._pendingAvatarPreviewUrl = this._avatarEditFile ? this._avatarEditSource : null;
    if (this._avatarEditFile) { showPreview(this._avatarEditSource); this._markAvatarUnsaved(); }
    else this._updateAvatarPreview();
    return;
  }
  const img = document.querySelector('#border-crop-layers .border-crop-border');
  if (!img || !img.complete || !img.naturalWidth) return;
  const nw = img.naturalWidth, nh = img.naturalHeight, M = Math.max(nw, nh);
  // The stage shows the image contained in a square, so a stage fraction is M px.
  const box = this._advanceBox({ left: 0, top: 0, right: 1, bottom: 1 }, this._avatarCrop);
  const sx = (box.left - (1 - nw / M) / 2) * M;
  const sy = (box.top - (1 - nh / M) / 2) * M;
  const sw = (box.right - box.left) * M, sh = (box.bottom - box.top) * M;
  // Keep the cropped pixels as they are, only scaling down past 1024px.
  const k = Math.min(1, 1024 / Math.max(sw, sh));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(sw * k));
  canvas.height = Math.max(1, Math.round(sh * k));
  canvas.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  // Keep JPEG and WebP as they came; everything else, and any crop that reaches
  // past the image into transparent space, becomes PNG.
  const srcType = this._avatarEditFile ? this._avatarEditFile.type
    : (/\.jpe?g(\?|#|$)/i.test(this._avatarEditSource) ? 'image/jpeg' : /\.webp(\?|#|$)/i.test(this._avatarEditSource) ? 'image/webp' : 'image/png');
  const outside = sx < -0.5 || sy < -0.5 || sx + sw > nw + 0.5 || sy + sh > nh + 0.5;
  const type = (srcType === 'image/jpeg' && !outside) ? 'image/jpeg' : srcType === 'image/webp' ? 'image/webp' : 'image/png';
  const fail = () => this._showToast(t('media_runtime.avatar.edit_failed'), 'error');
  try {
    canvas.toBlob((blob) => {
      if (!blob) return fail();
      if (blob.size > 2 * 1024 * 1024) return this._showToast(t('toasts.image_too_large', { max: 2 }), 'error');
      const ext = { 'image/jpeg': 'jpg', 'image/webp': 'webp' }[blob.type] || 'png';
      this._pendingAvatarFile = new File([blob], `avatar.${ext}`, { type: blob.type });
      this._pendingAvatarRemoved = false;
      this._avatarEditBaked = true;
      const reader = new FileReader();
      reader.onload = (ev) => {
        this._pendingAvatarPreviewUrl = ev.target.result;
        showPreview(ev.target.result);
        this._markAvatarUnsaved();
      };
      reader.readAsDataURL(blob);
    }, type, 0.92);
  } catch {
    fail(); // cross-origin image: the canvas is tainted
  }
},

// The border editor is event sourced: this._ops() (the border's log, or the
// avatar's while _editTarget is 'avatar') is an append-only log of
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
  for (const op of this._ops()) cb = this._advanceBox(cb, op);
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
  const editingAvatar = this._editTarget === 'avatar';
  // The image the tools act on; the action rows below only show when there is one.
  const subjectUrl = editingAvatar ? this._avatarEditSource : borderUrl;
  // The avatar has only Crop, so the tool picker and edit history have no job there.
  const modes = document.getElementById('border-crop-modes');
  if (modes) modes.style.display = editingAvatar ? 'none' : '';
  const side = document.querySelector('#border-crop-modal .border-crop-side');
  if (side) side.style.display = editingAvatar ? 'none' : '';

  let avatarLayer;
  if (editingAvatar) {
    // The unedited avatar, faded, so the area being cropped away stays visible.
    avatarLayer = subjectUrl ? `<img class="border-crop-border bce-ghost" src="${this._escapeHtml(subjectUrl)}" alt="">` : '';
  } else if (avatarUrl) {
    avatarLayer = `<img class="border-crop-avatar ${shapeClass}" src="${this._escapeHtml(avatarUrl)}" alt="${t('media_runtime.avatar.alt')}">`;
  } else {
    const color = this._getUserColor(this.user.username);
    const initial = this.user.username.charAt(0).toUpperCase();
    avatarLayer = `<div class="border-crop-avatar ${shapeClass}" style="background-color:${color}">${initial}</div>`;
  }

  if (subjectUrl) {
    const W = stage.clientWidth || 192, H = stage.clientHeight || 192;
    const subjectAlt = editingAvatar ? t('media_runtime.avatar.alt') : t('media_runtime.avatar.border_alt');
    let stack = `<img class="border-crop-border" src="${this._escapeHtml(subjectUrl)}" alt="${subjectAlt}">`;
    let cb = { left: 0, top: 0, right: 1, bottom: 1 };
    // An opacity draft is the single source of truth for opacity, so hide the
    // committed opacity op(s) while editing instead of multiplying with them.
    const draftIsOpacity = this._borderDraft && this._borderDraft.type === 'opacity';
    for (const op of this._ops()) {
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
    autocropBtn.style.display = (this._borderTool === 'crop' && subjectUrl) ? 'block' : 'none';
    autocropBtn.disabled = this._hasCrop();
  }
  const lockBtn = document.getElementById('border-crop-lock-btn');
  if (lockBtn) {
    lockBtn.style.display = (editingAvatar && subjectUrl) ? 'block' : 'none';
    lockBtn.classList.toggle('active', !!this._cropLocked);
    lockBtn.setAttribute('aria-pressed', String(!!this._cropLocked));
  }
  const rotateActions = document.getElementById('border-crop-rotate-actions');
  if (rotateActions) rotateActions.style.display = (this._borderTool === 'rotate' && subjectUrl) ? 'flex' : 'none';
  const resizeActions = document.getElementById('border-crop-resize-actions');
  if (resizeActions) {
    resizeActions.style.display = (this._borderTool === 'resize' && subjectUrl) ? 'flex' : 'none';
    const anchorSel = document.getElementById('border-resize-anchor');
    if (anchorSel) anchorSel.value = this._resizeAnchor || 'center';
  }
  const opacityActions = document.getElementById('border-crop-opacity-actions');
  if (opacityActions) {
    opacityActions.style.display = (this._borderTool === 'opacity' && subjectUrl) ? 'flex' : 'none';
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
  const tr = (key) => t(key);
  if (!this._ops().length) {
    list.innerHTML = `<div class="bce-hist-empty">${tr('modals.border_crop.no_edits')}</div>`;
    return;
  }
  const glyph = { crop: '▣', move: '✥', resize: '⤢', rotate: '⟳', opacity: '◐', distort: '◇' };
  const undoTitle = tr('modals.border_crop.undo');
  list.innerHTML = this._ops().map((op, i) =>
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

// Commit-on-leave: keep the draft only if it actually changed something. The
// avatar has no log to commit into; Done stores its crop instead.
_commitBorderDraft() {
  if (this._editTarget === 'avatar') return;
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
    this._showToast(t('modals.border_crop.exceeds_frame'), 'error');
    return;
  }
  this._ops().push(d);
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
  return this._ops().some((op) => op.type === 'crop') ||
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
      const v = Math.min(0.49, Math.max(0, f));
      // Lock sides (avatar only): one drag trims all four edges by the same amount.
      if (this._editTarget === 'avatar' && this._cropLocked) d.top = d.right = d.bottom = d.left = v;
      else d[active.edge] = v;
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

  // Lock sides (avatar only): while on, a crop drag trims every edge evenly.
  const lockBtn = document.getElementById('border-crop-lock-btn');
  if (lockBtn) lockBtn.addEventListener('click', () => {
    this._cropLocked = !this._cropLocked;
    lockBtn.classList.toggle('active', this._cropLocked);
    lockBtn.setAttribute('aria-pressed', String(this._cropLocked));
  });

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
      this._ops().length = parseInt(btn.dataset.index, 10);
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
    // Animated profile "Learn more" toggle
    const learnMoreBtn = e.target.closest('#animate-learn-more-toggle');
    if (learnMoreBtn) {
      e.preventDefault();
      const collapsed = document.getElementById('animate-learn-more-body').classList.toggle('collapsed');
      document.getElementById('animate-learn-more-arrow')?.classList.toggle('collapsed', collapsed);
      learnMoreBtn.setAttribute('aria-expanded', String(!collapsed));
      return;
    }

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
      this._setAvatarEditSource(null, null);
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
    // The avatar's Edit button opens the same editor in avatar mode (Crop only).
    const editBtn = e.target.closest('#border-crop-btn, #avatar-crop-btn');
    if (editBtn) {
      e.preventDefault();
      this._openImageEditor(editBtn.id === 'avatar-crop-btn' ? 'avatar' : 'border');
      return;
    }

    // Done → commit the in-progress draft (commit-on-leave) and close. Avatar
    // edits are baked into the pending avatar file here.
    if (e.target.closest('#border-crop-done-btn')) {
      e.preventDefault();
      if (this._editTarget === 'avatar') {
        // The avatar's single crop is the draft; store it and bake it.
        const d = this._borderDraft;
        this._borderDraft = null;
        this._avatarCrop = this._borderOpChanged(d) ? d : null;
        this._applyAvatarEdits();
      } else {
        this._commitBorderDraft();
      }
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
      if (preview) preview.innerHTML = `<div style="width:100%;height:100%;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:0.7rem;color:var(--text-muted)">${t('media_runtime.none')}</div>`;
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
      if (file.size > 5 * 1024 * 1024) return this._showToast(t('toasts.image_too_large', { max: 5 }), 'error');
      if (!file.type.startsWith('image/')) return this._showToast(t('toasts.not_an_image'), 'error');

      this._pendingAvatarFile = file;
      this._pendingAvatarRemoved = false;

      // Show local preview immediately (not sent to server yet)
      const reader = new FileReader();
      reader.onload = (ev) => {
        this._pendingAvatarPreviewUrl = ev.target.result;
        this._setAvatarEditSource(ev.target.result, file, true);
        const preview = document.getElementById('avatar-upload-preview');
        if (preview) {
          const img = document.createElement('img');
          img.src = ev.target.result;
          img.alt = t('media_runtime.avatar.preview_alt');
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
      if (file.size > 5 * 1024 * 1024) return this._showToast(t('toasts.image_too_large', { max: 5 }), 'error');
      if (!file.type.startsWith('image/')) return this._showToast(t('toasts.not_an_image'), 'error');

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
          img.alt = t('media_runtime.avatar.border_preview_alt');
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
  if (status) { status.textContent = t('media_runtime.avatar.unsaved'); status.style.color = 'var(--warning, orange)'; }
},

// Commit pending avatar + shape to the server via HTTP (not socket!)
async _commitAvatarSettings() {
  const status = document.getElementById('avatar-save-status');
  if (status) { status.textContent = t('media_runtime.avatar.saving'); status.style.color = 'var(--text-secondary)'; }

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
      if (!resp.ok) throw new Error(data.error || t('toasts.upload_failed'));

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
        img.alt = t('media_runtime.avatar.alt');
        preview.innerHTML = '';
        preview.appendChild(img);
      }
      
      // Notify connected sockets about the avatar change (small URL, not data URL)
      if (this.socket) this.socket.emit('set-avatar', { url: data.url });
      // The saved image is now the unedited one the editor starts from.
      this._resetAvatarEditState();
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
      if (!resp.ok) throw new Error(t('media_runtime.avatar.remove_failed'));

      this.user.avatar = null;
      localStorage.setItem('haven_user', JSON.stringify(this.user));
      this._pendingAvatarRemoved = false;

      if (this.socket) this.socket.emit('set-avatar', { url: '' });
      this._resetAvatarEditState();
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
      if (!resp.ok) throw new Error(data.error || t('toasts.upload_failed'));

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
      if (!resp.ok) throw new Error(t('media_runtime.avatar.border_remove_failed'));

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
        if (!resp.ok) throw new Error(t('media_runtime.avatar.border_fit_failed'));
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
      if (!resp.ok) throw new Error(t('media_runtime.avatar.shape_failed'));

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
      if (!resp.ok) throw new Error(t('media_runtime.avatar.animation_failed'));

      this._animateProfile = this._pendingAnimateProfile;
      this.user.animateProfile = this._pendingAnimateProfile;
      localStorage.setItem('haven_user', JSON.stringify(this.user));

      if (this.socket) this.socket.emit('set-animate-profile', { mode: this._pendingAnimateProfile });
    }

    if (status) { status.textContent = t('media_runtime.avatar.saved'); status.style.color = 'var(--success, #6f6)'; }
    this._showToast(t('media_runtime.avatar.saved_toast'), 'success');
    setTimeout(() => { if (status) status.textContent = ''; }, 3000);

  } catch (err) {
    console.error('[Avatar] Save failed:', err);
    if (status) { status.textContent = '❌ ' + err.message; status.style.color = 'var(--danger, red)'; }
    this._showToast(t('media_runtime.avatar.save_failed', { error: err.message }), 'error');
  }
},

_applyAvatarShape() {
  // No-op: shapes are now per-user and rendered from server data per message.
  // This function is kept as a safe stub in case it's called elsewhere.
},

};
