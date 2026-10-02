// Custom emoji and stickers: uploading, cropping, the lists, and loading
// the standard emoji set.

export default {

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

  // When a file is chosen, open the cropper. Anything animated skips it:
  // the cropper redraws one frame, so an animated WebP or PNG came out
  // still (#5694). GIFs always skipped it.
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) return;
    this._croppedEmojiBlob = null;
    this._cropSourceFile = file;
    const previewRow = document.getElementById('emoji-crop-preview-row');
    if (previewRow) previewRow.style.display = 'none';
    if (file.type === 'image/gif' || await this._isAnimatedImage(file)) return;
    this._openEmojiCropper(file);
  });

  uploadBtn.addEventListener('click', async () => {
    const file = fileInput.files[0];
    const name = nameInput ? nameInput.value.trim().replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase() : '';
    if (!file) return this._showToast(t('media_runtime.emoji.select_file'), 'error');
    if (!name) return this._showToast(t('media_runtime.emoji.enter_name'), 'error');

    // Use cropped blob for non-GIF uploads, otherwise raw file
    const uploadBlob = (this._croppedEmojiBlob && file.type !== 'image/gif')
      ? this._croppedEmojiBlob
      : file;
    const maxEmojiKb = parseInt(this.serverSettings?.max_emoji_kb) || 256;
    if (uploadBlob.size > maxEmojiKb * 1024) return this._showToast(t('media_runtime.emoji.too_large', { max: maxEmojiKb }), 'error');

    const formData = new FormData();
    formData.append('emoji', uploadBlob, file.name);
    formData.append('name', name);

    try {
      this._showToast(t('media_runtime.emoji.uploading'), 'info');
      const res = await fetch('/api/upload-emoji', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${this.token}` },
        body: formData
      });
      if (!res.ok) {
        let errMsg = t('toasts.upload_failed_status', { status: res.status });
        try { const d = await res.json(); errMsg = d.error || errMsg; } catch { /* no JSON error body: keep the status message */ }
        return this._showToast(errMsg, 'error');
      }
      this._showToast(t('media_runtime.emoji.uploaded', { name }), 'success');
      fileInput.value = '';
      if (nameInput) nameInput.value = '';
      this._croppedEmojiBlob = null;
      this._cropSourceFile = null;
      this._cropState = null;
      const previewRow = document.getElementById('emoji-crop-preview-row');
      if (previewRow) previewRow.style.display = 'none';
      this._loadCustomEmojis();
    } catch {
      this._showToast(t('toasts.upload_failed'), 'error');
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
        return this._showToast(t('media_runtime.all_files_too_large', { max: maxEmojiKb }), 'error');
      }
      try {
        const uploadCount = files.length - skipped;
        this._showToast(t(uploadCount === 1 ? 'media_runtime.emoji.uploading_one' : 'media_runtime.emoji.uploading_other', { count: uploadCount }), 'info');
        const res = await fetch('/api/upload-emojis', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${this.token}` },
          body: formData
        });
        if (!res.ok) {
          let errMsg = t('toasts.upload_failed_status', { status: res.status });
          try { const d = await res.json(); errMsg = d.error || errMsg; } catch { /* no JSON error body: keep the status message */ }
          return this._showToast(errMsg, 'error');
        }
        const data = await res.json();
        const count = data.uploaded?.length || 0;
        const errCount = (data.errors?.length || 0) + skipped;
        let msg = t(count === 1 ? 'media_runtime.emoji.uploaded_one' : 'media_runtime.emoji.uploaded_other', { count });
        if (errCount) msg += ' ' + t('media_runtime.skipped', { count: errCount });
        this._showToast(msg, count ? 'success' : 'error');
        this._loadCustomEmojis();
      } catch {
        this._showToast(t('media_runtime.bulk_upload_failed'), 'error');
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
    const newVal = Math.min(parseInt(zoomSlider.max) || 500, Math.max(100, parseInt(zoomSlider.value) + delta));
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
    // The 256px frame at half size, clear wherever the picture does not reach.
    outCtx.drawImage(s.img, s.ox / 2, s.oy / 2, s.img.width * s.scale / 2, s.img.height * s.scale / 2);
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

/** True for an animated WebP or PNG, read from the file's own header. */
async _isAnimatedImage(file) {
  try {
    const b = new Uint8Array(await file.slice(0, 65536).arrayBuffer());
    const at = (i, str) => [...str].every((c, k) => b[i + k] === c.charCodeAt(0));
    // WebP: an extended header (VP8X) with its animation flag set.
    if (at(0, 'RIFF') && at(8, 'WEBP')) return at(12, 'VP8X') && (b[20] & 0x02) !== 0;
    // PNG: an animation control chunk (acTL) before the image data.
    if (b[0] === 0x89 && at(1, 'PNG')) {
      for (let i = 8; i + 8 <= b.length;) {
        const len = ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
        if (at(i + 4, 'acTL')) return true;
        if (at(i + 4, 'IDAT')) return false;
        i += 12 + len;
      }
    }
  } catch { /* unreadable: treat as still */ }
  return false;
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
    // It opens filling the square, as before, but zooms out until the whole
    // picture fits, with clear space around it, so a wide emote can keep
    // everything instead of losing its sides (#5694).
    const fillScale = Math.max(256 / img.width, 256 / img.height);
    const minScale = Math.min(256 / img.width, 256 / img.height);
    this._cropState = {
      img,
      minScale,
      scale: fillScale,
      ox: (256 - img.width * fillScale) / 2,
      oy: (256 - img.height * fillScale) / 2,
      dragging: false,
      lastX: 0,
      lastY: 0
    };
    const fillValue = Math.round(100 * fillScale / minScale);
    zoomSlider.max = String(fillValue * 5);
    zoomSlider.value = String(fillValue);
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
  // Narrower than the square: centred. Wider: the square stays covered.
  s.ox = w <= 256 ? (256 - w) / 2 : Math.min(0, Math.max(256 - w, s.ox));
  s.oy = h <= 256 ? (256 - h) / 2 : Math.min(0, Math.max(256 - h, s.oy));
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
  } catch (err) { console.warn('[Emoji] could not load custom emojis', err); }
},

_renderEmojiList(emojis) {
  const list = document.getElementById('custom-emojis-list');
  if (!list) return;

  if (emojis.length === 0) {
    list.innerHTML = `<p class="muted-text">${t('modals.emoji_mgmt.no_emojis')}</p>`;
    return;
  }

  list.innerHTML = emojis.map(e => `
    <div class="custom-sound-item">
      <img src="${this._escapeHtml(e.url)}" alt=":${this._escapeHtml(e.name)}:" class="custom-emoji-preview" style="width:24px;height:24px;vertical-align:middle;margin-right:6px;">
      <span class="custom-sound-name">:${this._escapeHtml(e.name)}:</span>
      <button class="btn-xs emoji-delete-btn" data-name="${this._escapeHtml(e.name)}" title="${t('media_runtime.delete')}">&#x1F5D1;</button>
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
          this._showToast(t('media_runtime.emoji.deleted', { name }), 'success');
          this._loadCustomEmojis();
        } else {
          this._showToast(t('media_runtime.delete_failed'), 'error');
        }
      } catch {
        this._showToast(t('media_runtime.delete_failed'), 'error');
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
  } catch (err) { console.warn('[Stickers] could not load stickers', err); }
},

_renderStickerList(stickers) {
  const list = document.getElementById('stickers-list');
  if (!list) return;
  if (!stickers || stickers.length === 0) {
    list.innerHTML = `<p class="muted-text">${t('modals.sticker_mgmt.no_stickers')}</p>`;
    return;
  }
  // Group by pack for display
  const packs = {};
  stickers.forEach(s => {
    const p = s.pack_name || t('media_runtime.sticker.general_pack');
    (packs[p] = packs[p] || []).push(s);
  });
  list.innerHTML = Object.keys(packs).sort().map(pack => `
    <div class="sticker-pack-group" style="margin-top:8px">
      <div style="font-size:0.75rem;font-weight:600;margin-bottom:4px;color:var(--text-secondary)">${this._escapeHtml(pack)}</div>
      ${packs[pack].map(s => `
        <div class="custom-sound-item">
          <img src="${this._escapeHtml(s.url)}" alt=":${this._escapeHtml(s.name)}:" style="width:48px;height:48px;vertical-align:middle;margin-right:8px;object-fit:contain;border-radius:4px;background:var(--bg-secondary)">
          <span class="custom-sound-name">:${this._escapeHtml(s.name)}:</span>
          <button class="btn-xs sticker-delete-btn" data-name="${this._escapeHtml(s.name)}" title="${t('media_runtime.delete')}">&#x1F5D1;</button>
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
          this._showToast(t('media_runtime.sticker.deleted', { name }), 'success');
          this._loadStickers();
        } else {
          this._showToast(t('media_runtime.delete_failed'), 'error');
        }
      } catch {
        this._showToast(t('media_runtime.delete_failed'), 'error');
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
      if (!file) return this._showToast(t('media_runtime.sticker.choose_file'), 'error');
      const maxKb = parseInt(this.serverSettings?.max_sticker_kb) || 1024;
      if (file.size > maxKb * 1024) return this._showToast(t('media_runtime.sticker.too_large', { max: maxKb }), 'error');

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
          let errMsg = t('toasts.upload_failed_status', { status: res.status });
          try { const d = await res.json(); errMsg = d.error || errMsg; } catch { /* no JSON error body: keep the status message */ }
          return this._showToast(errMsg, 'error');
        }
        const data = await res.json();
        this._showToast(t('media_runtime.sticker.uploaded', { name: data.name }), 'success');
        if (nameInput) nameInput.value = '';
        fileInput.value = '';
        this._loadStickers();
      } catch {
        this._showToast(t('toasts.upload_failed'), 'error');
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
        return this._showToast(t('media_runtime.all_files_too_large', { max: maxKb }), 'error');
      }

      const pack = (packInput?.value || '').trim();
      if (pack) formData.append('pack_name', pack);

      try {
        const uploadCount = files.length - skipped;
        this._showToast(t(uploadCount === 1 ? 'media_runtime.sticker.uploading_one' : 'media_runtime.sticker.uploading_other', { count: uploadCount }), 'info');
        const res = await fetch('/api/upload-stickers', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${this.token}` },
          body: formData
        });
        if (!res.ok) {
          let errMsg = t('toasts.upload_failed_status', { status: res.status });
          try { const d = await res.json(); errMsg = d.error || errMsg; } catch { /* no JSON error body: keep the status message */ }
          return this._showToast(errMsg, 'error');
        }

        const data = await res.json();
        const count = data.uploaded?.length || 0;
        const errCount = (data.errors?.length || 0) + skipped;
        let msg = t(count === 1 ? 'media_runtime.sticker.uploaded_one' : 'media_runtime.sticker.uploaded_other', { count });
        if (errCount) msg += ' ' + t('media_runtime.skipped', { count: errCount });
        this._showToast(msg, count ? 'success' : 'error');
        this._loadStickers();
      } catch {
        this._showToast(t('media_runtime.bulk_upload_failed'), 'error');
      }

      bulkInput.value = '';
    });
  }

  this._loadStickers();
},

};
