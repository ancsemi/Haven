// Banner picture in Edit Profile: pick, crop to the banner's 5:2 shape, clear,
// and the save that sends it up. The crop is its own small editor (drag to
// move, slider to zoom) rather than the avatar's square one. A still picture
// is cut and scaled down to banner size before it goes up, so a large photo
// is not what everyone downloads when they open the card. Animated pictures
// can't be cut without losing their frames, so they go up as they are and
// the card centers them.

// Width of a baked banner. The card shows it at 20rem; this leaves room for
// sharp screens and zoomed pages without sending a full size photo.
const BANNER_OUT_WIDTH = 1500;
// Largest picture the picker takes before cropping. A still picture is
// scaled down after, so it can start over the banner limit.
const BANNER_PICK_MAX_MB = 20;

export default {

// The banner size limit the admin set (1 to 20 MB, 5 by default).
_bannerMaxMb() {
  const n = parseInt(this.serverSettings?.max_banner_mb, 10);
  return n >= 1 && n <= 20 ? n : 5;
},

_setupBannerEditor() {
  const fileInput = document.getElementById('banner-file-input');
  document.getElementById('banner-upload-btn')?.addEventListener('click', () => {
    if (fileInput) { fileInput.value = ''; fileInput.click(); }
  });
  fileInput?.addEventListener('change', () => {
    const file = fileInput.files[0];
    if (file) this._pickBannerFile(file);
  });
  document.getElementById('banner-edit-btn')?.addEventListener('click', () => {
    if (this._bannerEditSource && this._bannerIsAnimated === false) this._openBannerCropper();
  });
  document.getElementById('banner-remove-btn')?.addEventListener('click', () => {
    this._setPendingBanner(null, null);
    this._pendingBannerRemoved = !!this.user.banner;
    this._setBannerEditSource(null);
    this._renderBannerEditor();
    this._markAvatarUnsaved();
  });

  // The crop editor
  const frame = document.getElementById('banner-crop-frame');
  const zoom = document.getElementById('banner-crop-zoom');
  if (frame) {
    frame.addEventListener('pointerdown', (e) => {
      if (!this._bannerCropView) return;
      frame.setPointerCapture(e.pointerId);
      this._bannerDrag = { id: e.pointerId, x: e.clientX, y: e.clientY };
      frame.classList.add('dragging');
    });
    frame.addEventListener('pointermove', (e) => {
      const d = this._bannerDrag;
      if (!d || d.id !== e.pointerId) return;
      this._panBannerCrop(e.clientX - d.x, e.clientY - d.y);
      d.x = e.clientX; d.y = e.clientY;
    });
    const endDrag = (e) => {
      if (this._bannerDrag?.id !== e.pointerId) return;
      this._bannerDrag = null;
      frame.classList.remove('dragging');
    };
    frame.addEventListener('pointerup', endDrag);
    frame.addEventListener('pointercancel', endDrag);
    frame.addEventListener('wheel', (e) => {
      if (!this._bannerCropView) return;
      e.preventDefault();
      this._zoomBannerCrop(this._bannerCropView.z * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
    }, { passive: false });
    // Arrow keys move the picture a little at a time; + and - zoom.
    frame.addEventListener('keydown', (e) => {
      const view = this._bannerCropView;
      if (!view) return;
      const step = frame.clientWidth / 20;
      const moves = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
      if (moves[e.key]) { e.preventDefault(); this._panBannerCrop(...moves[e.key]); }
      else if (e.key === '+' || e.key === '=') { e.preventDefault(); this._zoomBannerCrop(view.z * 1.1); }
      else if (e.key === '-') { e.preventDefault(); this._zoomBannerCrop(view.z / 1.1); }
    });
  }
  zoom?.addEventListener('input', () => this._zoomBannerCrop(parseInt(zoom.value, 10) / 100));
  document.getElementById('banner-crop-cancel')?.addEventListener('click', () => this._closeBannerCropper(false));
  document.getElementById('banner-crop-done')?.addEventListener('click', () => this._closeBannerCropper(true));
  document.getElementById('banner-crop-modal')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) this._closeBannerCropper(false);
  });
},

// Edit Profile opened: start from the saved banner with nothing pending.
_resetBannerEditState() {
  this._setPendingBanner(null, null);
  this._pendingBannerRemoved = false;
  this._setBannerEditSource(this.user.banner || null);
  this._renderBannerEditor();
},

// The picture the cropper works from: a picked file's object URL (with the
// file's type) or the saved banner. Finding out whether it is animated
// decides whether Edit is offered. A new source starts uncropped.
_setBannerEditSource(src, pickedType = null) {
  if (this._bannerEditSourceIsObjectUrl && this._bannerEditSource && this._bannerEditSource !== src) {
    URL.revokeObjectURL(this._bannerEditSource);
  }
  this._bannerEditSource = src || null;
  this._bannerEditSourceIsObjectUrl = !!src && !!pickedType;
  this._bannerEditSourceType = pickedType || (/\.jpe?g$/i.test(src || '') ? 'image/jpeg' : null);
  this._bannerCrop = null;
  this._bannerIsAnimated = null;
  if (!src) return;
  const token = (this._bannerSourceToken = (this._bannerSourceToken || 0) + 1);
  fetch(src).then((r) => r.arrayBuffer()).then(
    (buf) => this._isAnimatedImageBytes(buf),
    () => null // the picture could not be read: not known to be animated
  ).then((animated) => {
    if (token !== this._bannerSourceToken) return; // a newer source replaced this one
    this._bannerIsAnimated = animated;
    this._renderBannerEditor();
  });
},

// What Save sends: a File, with an object URL to preview it by.
_setPendingBanner(file, previewUrl) {
  if (this._pendingBannerPreviewUrl && this._pendingBannerPreviewUrl !== previewUrl
      && this._pendingBannerPreviewUrl !== this._bannerEditSource) {
    URL.revokeObjectURL(this._pendingBannerPreviewUrl);
  }
  this._pendingBannerFile = file || null;
  this._pendingBannerPreviewUrl = previewUrl || null;
  if (file) this._pendingBannerRemoved = false;
},

// A file from the picker. A still picture opens the cropper and only counts
// once it is cropped; an animated one is taken as it is, if it fits.
async _pickBannerFile(file) {
  if (!/^image\/(jpeg|png|gif|webp)$/.test(file.type)) return this._showToast(t('toasts.not_an_image'), 'error');
  if (file.size > BANNER_PICK_MAX_MB * 1024 * 1024) {
    return this._showToast(t('toasts.image_too_large', { max: BANNER_PICK_MAX_MB }), 'error');
  }
  let animated = null;
  try { animated = this._isAnimatedImageBytes(await file.arrayBuffer()); } catch { /* unreadable: treat as still */ }
  if (animated) {
    const maxMb = this._bannerMaxMb();
    if (file.size > maxMb * 1024 * 1024) return this._showToast(t('toasts.image_too_large', { max: maxMb }), 'error');
    const url = URL.createObjectURL(file);
    this._setBannerEditSource(url, file.type);
    this._bannerIsAnimated = true;
    this._setPendingBanner(file, url);
    this._renderBannerEditor();
    this._markAvatarUnsaved();
    return;
  }
  this._openBannerCropper(URL.createObjectURL(file), file.type);
},

// Open the cropper on a newly picked picture (pickedUrl, of pickedType), or
// on the current source to adjust its crop.
_openBannerCropper(pickedUrl = null, pickedType = null) {
  const modal = document.getElementById('banner-crop-modal');
  const img = document.getElementById('banner-crop-img');
  if (!modal || !img) return;
  const src = pickedUrl || this._bannerEditSource;
  if (!src) return;
  this._bannerCropPicked = pickedUrl;
  this._bannerCropPickedType = pickedType;
  this._bannerCropView = null;
  modal.style.display = 'flex';
  img.onload = () => {
    if (img.getAttribute('src') !== src) return;
    const start = !pickedUrl && this._bannerCrop ? this._bannerCrop : { cx: 0.5, cy: 0.5, z: 1 };
    this._bannerCropView = { ...start };
    this._layoutBannerCrop();
    document.getElementById('banner-crop-frame')?.focus();
  };
  img.onerror = () => {
    this._showToast(t('media_runtime.avatar.edit_failed'), 'error');
    this._closeBannerCropper(false);
  };
  img.src = src;
},

// Draw the crop view: the picture covers the frame at zoom 1, scaled up from
// there, with (cx, cy) the point of the picture at the frame's center. The
// center is held so the picture always covers the whole frame.
_layoutBannerCrop() {
  const frame = document.getElementById('banner-crop-frame');
  const img = document.getElementById('banner-crop-img');
  const view = this._bannerCropView;
  if (!frame || !img || !view || !img.naturalWidth) return;
  const FW = frame.clientWidth, FH = frame.clientHeight;
  const s = Math.max(FW / img.naturalWidth, FH / img.naturalHeight) * view.z;
  const dw = img.naturalWidth * s, dh = img.naturalHeight * s;
  const hx = FW / (2 * dw), hy = FH / (2 * dh);
  view.cx = Math.min(1 - hx, Math.max(hx, view.cx));
  view.cy = Math.min(1 - hy, Math.max(hy, view.cy));
  img.style.width = dw + 'px';
  img.style.height = dh + 'px';
  img.style.left = (FW / 2 - view.cx * dw) + 'px';
  img.style.top = (FH / 2 - view.cy * dh) + 'px';
  const zoom = document.getElementById('banner-crop-zoom');
  if (zoom) zoom.value = String(Math.round(view.z * 100));
},

_panBannerCrop(dx, dy) {
  const img = document.getElementById('banner-crop-img');
  const view = this._bannerCropView;
  if (!img || !view) return;
  view.cx -= dx / img.clientWidth;
  view.cy -= dy / img.clientHeight;
  this._layoutBannerCrop();
},

_zoomBannerCrop(z) {
  if (!this._bannerCropView) return;
  this._bannerCropView.z = Math.min(4, Math.max(1, z));
  this._layoutBannerCrop();
},

// Done cuts the framed part out at banner size and makes it the pending
// banner; Cancel leaves everything as it was (a fresh pick is dropped).
_closeBannerCropper(apply) {
  const modal = document.getElementById('banner-crop-modal');
  const img = document.getElementById('banner-crop-img');
  const frame = document.getElementById('banner-crop-frame');
  const view = this._bannerCropView;
  const picked = this._bannerCropPicked;
  const finish = () => {
    if (modal) modal.style.display = 'none';
    this._bannerCropView = null;
    this._bannerCropPicked = null;
    this._bannerDrag = null;
  };
  if (!apply || !view || !img?.naturalWidth || !frame) {
    if (picked) URL.revokeObjectURL(picked);
    return finish();
  }
  const nw = img.naturalWidth, nh = img.naturalHeight;
  const s = Math.max(frame.clientWidth / nw, frame.clientHeight / nh) * view.z;
  const sw = frame.clientWidth / s, sh = sw * 2 / 5;
  const sx = view.cx * nw - sw / 2, sy = view.cy * nh - sh / 2;
  // Never scaled up past the picture's own pixels.
  const outW = Math.max(1, Math.round(Math.min(BANNER_OUT_WIDTH, sw)));
  const outH = Math.max(1, Math.round(outW * 2 / 5));
  const canvas = document.createElement('canvas');
  canvas.width = outW; canvas.height = outH;
  const fail = () => { this._showToast(t('media_runtime.avatar.edit_failed'), 'error'); if (picked) URL.revokeObjectURL(picked); finish(); };
  try {
    canvas.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, outW, outH);
    // JPEG stays JPEG; anything that may be see-through goes as WebP, or PNG
    // where the browser can't write WebP.
    const sourceType = picked ? this._bannerCropPickedType : this._bannerEditSourceType;
    const type = sourceType === 'image/jpeg' ? 'image/jpeg' : 'image/webp';
    canvas.toBlob((blob) => {
      if (!blob) return fail();
      const maxMb = this._bannerMaxMb();
      if (blob.size > maxMb * 1024 * 1024) {
        this._showToast(t('toasts.image_too_large', { max: maxMb }), 'error');
        if (picked) URL.revokeObjectURL(picked);
        return finish();
      }
      const ext = { 'image/jpeg': 'jpg', 'image/webp': 'webp' }[blob.type] || 'png';
      if (picked) {
        this._setBannerEditSource(picked, this._bannerCropPickedType);
        this._bannerIsAnimated = false;
      }
      this._bannerCrop = { cx: view.cx, cy: view.cy, z: view.z };
      this._setPendingBanner(new File([blob], `banner.${ext}`, { type: blob.type }), URL.createObjectURL(blob));
      this._renderBannerEditor();
      this._markAvatarUnsaved();
      finish();
    }, type, 0.9);
  } catch {
    fail();
  }
},

// The Banner section of Edit Profile: the preview strip (the card's color,
// with the picture as it will be after Save) and which buttons apply.
_renderBannerEditor() {
  const preview = document.getElementById('banner-color-preview');
  if (preview) {
    const url = this._pendingBannerRemoved ? null
      : (this._pendingBannerPreviewUrl || this.user.banner || null);
    preview.querySelector('.profile-banner-img')?.remove();
    preview.classList.toggle('has-banner-image', !!url);
    if (url) {
      const img = document.createElement('img');
      img.className = 'profile-banner-img';
      img.alt = '';
      img.src = url;
      preview.prepend(img);
    }
  }
  const has = !!this._bannerEditSource;
  const edit = document.getElementById('banner-edit-btn');
  if (edit) edit.disabled = !has || this._bannerIsAnimated !== false;
  const clear = document.getElementById('banner-remove-btn');
  if (clear) clear.disabled = !has;
  const note = document.getElementById('banner-edit-note');
  if (note) note.style.display = (has && this._bannerIsAnimated === true) ? 'block' : 'none';
  const hint = document.getElementById('banner-hint');
  if (hint) hint.textContent = t('modals.edit_profile.banner_hint', { max: this._bannerMaxMb() });
},

// Part of Save: upload the pending banner, or remove the saved one. Throws
// with the server's reason so the save reports it.
async _commitBannerPicture() {
  if (this._pendingBannerFile) {
    const formData = new FormData();
    formData.append('banner', this._pendingBannerFile);
    const resp = await fetch('/api/upload-banner', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${this.token}` },
      body: formData
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.error || t('toasts.upload_failed'));
    this.user.banner = data.url;
    localStorage.setItem('haven_user', JSON.stringify(this.user));
    this._setPendingBanner(null, null);
    this._setBannerEditSource(data.url);
    this._renderBannerEditor();
  } else if (this._pendingBannerRemoved) {
    const resp = await fetch('/api/remove-banner', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${this.token}`, 'Content-Type': 'application/json' }
    });
    if (!resp.ok) throw new Error(t('media_runtime.banner.remove_failed'));
    this.user.banner = null;
    localStorage.setItem('haven_user', JSON.stringify(this.user));
    this._pendingBannerRemoved = false;
    this._renderBannerEditor();
  }
},

};
