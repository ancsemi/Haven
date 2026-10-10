// Pictures and media in chat: the lightbox, hiding a picture, the picture
// right-click menu (save, copy, open, tag), lazy loading, the maximize button
// on windows, and the Debug section of Settings.

export default {

// ── Debug Section ──

_setupDebugSection() {
  const cb = document.getElementById('pref-debug-local-talk-indicator');
  if (!cb) return;
  try { cb.checked = localStorage.getItem('debug_local_talk_indicator') === '1'; } catch { /* storage blocked (private mode): keep the default */ }
  cb.addEventListener('change', () => {
    try {
      if (cb.checked) localStorage.setItem('debug_local_talk_indicator', '1');
      else localStorage.removeItem('debug_local_talk_indicator');
    } catch { /* storage blocked (private mode): nothing is remembered, nothing else breaks */ }
  });

  // #5379: opt-in toggle to re-apply voice processing (echoCancellation /
  // noiseSuppression / autoGainControl) to getDisplayMedia audio. Default
  // off as of 3.17.3 because those filters hollow out music and game audio
  // for listeners. Users sharing tutorial narration or meeting audio can
  // flip this back on. Mic capture is a separate stream and always gets
  // voice processing regardless of this setting.
  const sspCb = document.getElementById('pref-debug-screen-share-voice-proc');
  if (sspCb) {
    try { sspCb.checked = localStorage.getItem('screen_share_voice_processing') === '1'; } catch { /* storage blocked (private mode): keep the default */ }
    sspCb.addEventListener('change', () => {
      try {
        if (sspCb.checked) localStorage.setItem('screen_share_voice_processing', '1');
        else localStorage.removeItem('screen_share_voice_processing');
      } catch { /* storage blocked (private mode): nothing is remembered, nothing else breaks */ }
    });
  }

  // #5426: screen-share audio now plays straight through the <audio> element
  // by default (NetEq stays in charge, so it stays in sync over a TURN relay).
  // This opt-in toggle instead routes it through the Web Audio mixer, which
  // unlocks the >100% per-stream volume boost but can stutter / desync over a
  // relay, the same createMediaStreamSource-vs-jitter-buffer fight as before,
  // just no longer the default.
  const sadCb = document.getElementById('pref-debug-screen-audio-direct');
  if (sadCb) {
    try { sadCb.checked = localStorage.getItem('screen_audio_webaudio') === '1'; } catch { /* storage blocked (private mode): keep the default */ }
    sadCb.addEventListener('change', () => {
      try {
        if (sadCb.checked) localStorage.setItem('screen_audio_webaudio', '1');
        else localStorage.removeItem('screen_audio_webaudio');
      } catch { /* storage blocked (private mode): nothing is remembered, nothing else breaks */ }
      // Apply immediately to any screen audio that's already playing.
      if (this.voice && typeof this.voice.reapplyScreenAudioRouting === 'function') {
        this.voice.reapplyScreenAudioRouting();
      }
    });
  }

  // #5426: opt-in gentler screen-share encoding for relayed calls. 3.18.1
  // raised the bitrate ceilings, pinned maxFramerate and set
  // degradationPreference to 'maintain-framerate', which is right on a direct
  // connection and wrong once a TURN relay falls back to TCP: loss is hidden,
  // so the encoder never backs off, and pinning the framerate takes away its
  // last lever. This restores the pre-3.18.1 ceilings and unpins both. Off by
  // default while it is unverified; read live by voice.js on every apply, and
  // re-applied here so flipping it mid-share works without restarting it.
  const relayCb = document.getElementById('pref-debug-screen-relay-profile');
  if (relayCb) {
    try { relayCb.checked = localStorage.getItem('haven_screen_relay_profile') === '1'; } catch { /* storage blocked (private mode): keep the default */ }
    relayCb.addEventListener('change', () => {
      try {
        if (relayCb.checked) localStorage.setItem('haven_screen_relay_profile', '1');
        else localStorage.removeItem('haven_screen_relay_profile');
      } catch { /* storage blocked (private mode): nothing is remembered, nothing else breaks */ }
      if (this.voice && typeof this.voice.reapplyScreenBitrate === 'function') {
        this.voice.reapplyScreenBitrate();
      }
    });
  }

  // #5426: automatic relay detection for the profile above. On unless the
  // person switched it off; voice.js reads the flag live on every apply.
  const relayAutoCb = document.getElementById('pref-debug-screen-relay-auto');
  if (relayAutoCb) {
    try { relayAutoCb.checked = localStorage.getItem('haven_screen_relay_auto') !== '0'; } catch { /* storage blocked (private mode): keep the default */ }
    relayAutoCb.addEventListener('change', () => {
      try {
        if (relayAutoCb.checked) localStorage.removeItem('haven_screen_relay_auto');
        else localStorage.setItem('haven_screen_relay_auto', '0');
      } catch { /* storage blocked (private mode): nothing is remembered, nothing else breaks */ }
      if (this.voice && typeof this.voice.reapplyScreenBitrate === 'function') {
        this.voice.reapplyScreenBitrate();
      }
    });
  }

  // #5444: opt-in glare/ICE-restart recovery for voice. When two peers
  // reconnect simultaneously their ICE restarts can collide and leave one
  // audio direction dead until a manual rejoin. This re-queues the restart so
  // the connection repairs itself. Off by default while it's unverified; read
  // live by voice.js on each renegotiation, so no reload is needed.
  const glareCb = document.getElementById('pref-debug-voice-glare-ice-fix');
  if (glareCb) {
    try { glareCb.checked = localStorage.getItem('haven_voice_glare_ice_fix') === '1'; } catch { /* storage blocked (private mode): keep the default */ }
    glareCb.addEventListener('change', () => {
      try {
        if (glareCb.checked) localStorage.setItem('haven_voice_glare_ice_fix', '1');
        else localStorage.removeItem('haven_voice_glare_ice_fix');
      } catch { /* storage blocked (private mode): nothing is remembered, nothing else breaks */ }
    });
  }

  // #5380: always join voice muted
  const moCb = document.getElementById('pref-voice-mute-on-join');
  if (moCb) {
    try { moCb.checked = localStorage.getItem('haven_mute_on_join') === '1'; } catch { /* storage blocked (private mode): keep the default */ }
    moCb.addEventListener('change', () => {
      try {
        if (moCb.checked) localStorage.setItem('haven_mute_on_join', '1');
        else localStorage.removeItem('haven_mute_on_join');
      } catch { /* storage blocked (private mode): nothing is remembered, nothing else breaks */ }
    });
  }

  // #5380: listener-only (skip mic) voice mode
  const loCb = document.getElementById('pref-voice-listener-only');
  if (loCb) {
    try { loCb.checked = localStorage.getItem('haven_listener_only') === '1'; } catch { /* storage blocked (private mode): keep the default */ }
    loCb.addEventListener('change', () => {
      try {
        if (loCb.checked) localStorage.setItem('haven_listener_only', '1');
        else localStorage.removeItem('haven_listener_only');
      } catch { /* storage blocked (private mode): nothing is remembered, nothing else breaks */ }
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
  return Array.from(container.querySelectorAll('.chat-image'));
},

/** Point the lightbox at one chat image. A decrypted DM image has no usable
 *  src any more (the feed revokes its object URL once painted, #5426), so it
 *  is decrypted again on demand; until then the lightbox shows nothing but
 *  the backdrop, which is what it used to show forever. (#5568) */
_lightboxShow(imgEl, fallbackSrc = '') {
  const lbImg = document.getElementById('lightbox-img');
  if (!lbImg) return;
  const seq = (this._lightboxSeq = (this._lightboxSeq || 0) + 1);
  if (this._lightboxBlobUrl) {
    try { URL.revokeObjectURL(this._lightboxBlobUrl); } catch { /* already gone */ }
    this._lightboxBlobUrl = null;
  }
  if (imgEl && imgEl.dataset && imgEl.dataset.e2eSrc && this._e2eImageBlob) {
    lbImg.src = '';
    this._e2eImageBlob(imgEl).then(blob => {
      if (seq !== this._lightboxSeq) return; // moved on or closed meanwhile
      this._lightboxBlobUrl = URL.createObjectURL(blob);
      lbImg.src = this._lightboxBlobUrl;
    }).catch(() => { if (seq === this._lightboxSeq) lbImg.src = ''; });
    return;
  }
  lbImg.src = imgEl ? imgEl.src : fallbackSrc;
},

_lightboxNavigate(dir) {
  const imgs = this._getLightboxImages();
  if (imgs.length < 2 || !(this._lightboxIndex >= 0)) return;
  const newIdx = this._lightboxIndex + dir;
  if (newIdx < 0 || newIdx >= imgs.length) return;
  this._lightboxIndex = newIdx;
  this._lightboxShow(imgs[newIdx]);
  this._updateLightboxNav();
},

_updateLightboxNav() {
  const imgs = this._getLightboxImages();
  const prevBtn = document.getElementById('lightbox-prev');
  const nextBtn = document.getElementById('lightbox-next');
  if (!prevBtn || !nextBtn) return;
  const curIdx = this._lightboxIndex >= 0 ? this._lightboxIndex : -1;
  prevBtn.disabled = curIdx <= 0;
  nextBtn.disabled = curIdx < 0 || curIdx >= imgs.length - 1;
  // Hide nav when there is nothing to step through
  const showNav = imgs.length > 1 && curIdx >= 0;
  prevBtn.style.display = showNav ? '' : 'none';
  nextBtn.style.display = showNav ? '' : 'none';
},

_openLightbox(src, imgEl = null) {
  const lb = document.getElementById('image-lightbox');
  const img = document.getElementById('lightbox-img');
  if (!lb || !img) return;
  const imgs = this._getLightboxImages();
  this._lightboxIndex = imgEl ? imgs.indexOf(imgEl) : imgs.findIndex(i => i.src === src);
  this._lightboxShow(imgEl || imgs[this._lightboxIndex] || null, src);
  lb.style.display = 'flex';
  this._updateLightboxNav();
},

_closeLightbox() {
  const lb = document.getElementById('image-lightbox');
  if (lb) { lb.style.display = 'none'; }
  const img = document.getElementById('lightbox-img');
  if (img) { img.src = ''; }
  this._lightboxSeq = (this._lightboxSeq || 0) + 1;
  if (this._lightboxBlobUrl) {
    try { URL.revokeObjectURL(this._lightboxBlobUrl); } catch { /* already gone */ }
    this._lightboxBlobUrl = null;
  }
  this._lightboxIndex = -1;
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
  }, true); // capturing phase, fires before individual handlers

  // Auto-inject expand/maximize + close buttons into every modal.
  // Buttons live in an absolutely positioned .modal-controls group at the
  // top-right so they work for ALL modal layouts (back buttons, wrapper
  // divs, settings headers, etc) without depending on h3 internal flex.
  const _injectModalControls = () => {
    document.querySelectorAll('.modal').forEach(modal => {
      // Skip promo/centered popups and the media gallery (which has its own
      // header close button); they're not regular modals (#5352)
      if (modal.classList.contains('android-beta-promo') ||
          modal.classList.contains('desktop-promo') ||
          modal.classList.contains('donors-modal-box') ||
          modal.classList.contains('media-gallery-modal')) return;
      // Idempotent: skip already-injected
      if (modal.dataset.modalControlsInjected === '1') return;
      modal.dataset.modalControlsInjected = '1';

      // Settings/activities headers have their own close button, so keep it
      // but inject the expand toggle next to it.
      const settingsClose = modal.querySelector('.settings-close-btn');

      const expandBtn = document.createElement('button');
      expandBtn.type = 'button';
      expandBtn.className = 'modal-expand-btn';
      expandBtn.title = t('media_runtime.modal.expand_restore');
      expandBtn.textContent = '⛶';
      expandBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const isMax = modal.classList.toggle('modal-maximized');
        expandBtn.textContent = isMax ? '⊖' : '⛶';
        expandBtn.title = t(isMax ? 'media_runtime.modal.restore_size' : 'media_runtime.modal.expand');
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
        closeBtn.title = t('modals.common.close');
        closeBtn.textContent = '✕';
        closeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const overlay = modal.closest('.modal-overlay');
          if (overlay) {
            overlay.style.display = 'none';
            // Lets a modal drop unsaved state when closed this way (see Escape too).
            overlay.dispatchEvent(new CustomEvent('modal-dismiss'));
          }
          if (modal.classList.contains('modal-maximized')) {
            modal.classList.remove('modal-maximized');
            expandBtn.textContent = '⛶';
            expandBtn.title = t('media_runtime.modal.expand_restore');
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
  try { arr = JSON.parse(localStorage.getItem('haven_hidden_images') || '[]'); } catch { /* corrupt or blocked storage: start with nothing hidden */ }
  this._hiddenImageSet = new Set(Array.isArray(arr) ? arr : []);
  return this._hiddenImageSet;
},

_saveHiddenImages() {
  try {
    localStorage.setItem('haven_hidden_images', JSON.stringify([...this._loadHiddenImages()]));
  } catch { /* storage blocked (private mode): nothing is remembered, nothing else breaks */ }
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

// Slashed-eye ("closed eye") icon. There is no standalone closed-eye emoji,
// so we reuse the same eye-off glyph the password fields use for "hidden".
// `off` true → closed/slashed eye; false → open eye.
_eyeIcon(off, size = 14) {
  return off
    ? `<svg class="eye-icon" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>`
    : `<svg class="eye-icon" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>`;
},

_hiddenImagePlaceholder(u) {
  const abs = this._escapeHtml(this._normalizeImgSrc(u));
  const label = t('app.messages.image_hidden');
  const hint = t('app.messages.click_to_show');
  return `<span class="hidden-image" role="button" tabindex="0" data-hidden-src="${abs}" title="${this._escapeHtml(hint)}">${this._eyeIcon(true)} ${this._escapeHtml(label)}: ${this._escapeHtml(hint)}</span>`;
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
  img.alt = t('media_runtime.image.alt');
  ph.replaceWith(img);
},

// A picture in an encrypted DM is decrypted in the browser, and the feed lets
// go of the decrypted bytes once it has painted them, so the <img> src is a
// dead object URL: opening or saving it gave a blank page. A fresh copy is
// decrypted for the new tab or the download and released a minute later
// (#5663).
_freshImageUrl(img) {
  if (img && img.dataset && img.dataset.e2eSrc && this._e2eImageBlob) {
    return this._e2eImageBlob(img).then(blob => {
      const url = URL.createObjectURL(blob);
      setTimeout(() => { try { URL.revokeObjectURL(url); } catch { /* already revoked */ } }, 60000);
      return { url, blob, ephemeral: true };
    });
  }
  return Promise.resolve({ url: this._lazyRealSrc ? this._lazyRealSrc(img) : (img && img.src) || '', blob: null, ephemeral: false });
},

_openImageInNewTab(img) {
  this._freshImageUrl(img).then(async ({ url, blob, ephemeral }) => {
    if (!url) return;
    // An object URL only resolves for a tab that shares this page's session,
    // so the decrypted copy opens without noopener; a plain link keeps it.
    if (!ephemeral) { window.open(url, '_blank', 'noopener,noreferrer'); return; }
    // The decrypted copy opens as a page on Haven's own origin, and the
    // sender picked its type. An SVG there is a document that can run script
    // as Haven, so anything but a plain raster picture is redrawn to a PNG
    // first and only the PNG is opened.
    const inert = await this._inertImageBlob(blob);
    if (inert === blob) { window.open(url, '_blank'); return; }
    try { URL.revokeObjectURL(url); } catch { /* already revoked */ }
    const safeUrl = URL.createObjectURL(inert);
    setTimeout(() => { try { URL.revokeObjectURL(safeUrl); } catch { /* already revoked */ } }, 60000);
    window.open(safeUrl, '_blank');
  }).catch(() => this._showToast?.(t('media_runtime.image.open_failed'), 'error'));
},

// A picture that is safe to open as a page: raster types as they are,
// anything else (SVG above all) drawn onto a canvas and taken back as a PNG,
// which keeps how it looks and drops anything it could run.
async _inertImageBlob(blob) {
  if (blob && /^image\/(png|jpeg|gif|webp|avif|bmp)$/.test(blob.type || '')) return blob;
  const src = URL.createObjectURL(blob);
  try {
    const pic = new Image();
    pic.src = src;
    await pic.decode();
    const canvas = document.createElement('canvas');
    canvas.width = Math.min(pic.naturalWidth || 1024, 8192);
    canvas.height = Math.min(pic.naturalHeight || 1024, 8192);
    canvas.getContext('2d').drawImage(pic, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error('not drawable'))), 'image/png'));
  } finally {
    try { URL.revokeObjectURL(src); } catch { /* already revoked */ }
  }
},

_suggestedImageFilename(src, blob) {
  let name = '';
  try {
    const path = new URL(src, window.location.origin).pathname;
    name = decodeURIComponent(path.split('/').pop() || '');
  } catch { /* odd address: the generic name below is used */ }
  name = String(name || '').replace(/[<>:"|?*\\]/g, '');
  if (!name || name === 'media-proxy' || name === 'proxy' || name.length > 80 || !/\.[a-z0-9]{2,5}$/i.test(name)) {
    const ext = ((blob?.type || 'image/png').split('/')[1] || 'png').replace('jpeg', 'jpg');
    name = `haven-image.${ext}`;
  } else if (/^image\/(png|jpeg|gif|webp|avif|bmp)$/.test(blob?.type || '')) {
    // The name follows the bytes: a fallback copy is a PNG whatever the
    // picture was called, and a .gif name on PNG bytes opens as a broken file.
    const ext = blob.type.split('/')[1].replace('jpeg', 'jpg');
    const cur = name.split('.').pop().toLowerCase().replace('jpeg', 'jpg');
    if (cur !== ext) name = name.replace(/\.[a-z0-9]{2,5}$/i, '.' + ext);
  }
  return name;
},

// The bytes to save. An encrypted DM picture is decrypted again, since the
// feed has let go of its copy (#5663). Anything else is fetched as the server
// has it. The copy warmed for Copy Image is a PNG re-encode, so it is only a
// fallback: saving it turned an animated GIF into one still frame.
async _blobForContextImage(src, sourceImg) {
  if (sourceImg?.dataset?.e2eSrc && this._e2eImageBlob) {
    try { return await this._e2eImageBlob(sourceImg); } catch { /* fall back to what is on screen */ }
  }
  const realSrc = (sourceImg && this._lazyRealSrc ? this._lazyRealSrc(sourceImg) : '') || src;
  try {
    const resp = await fetch(realSrc, { credentials: 'same-origin' });
    if (!resp.ok) throw new Error('fetch ' + resp.status);
    return await resp.blob();
  } catch (fetchErr) {
    if (this._ctxImageBlob && this._ctxImageBlobSrc === src) {
      try {
        const warmed = await this._ctxImageBlob;
        if (warmed) return warmed;
      } catch { /* fall through */ }
    }
    const candidates = [];
    if (sourceImg) candidates.push(sourceImg);
    const lb = document.getElementById('lightbox-img');
    if (lb?.src && lb.src === src) candidates.push(lb);
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
      } catch { /* tainted or detached */ }
    }
    throw fetchErr;
  }
},

async _saveContextImage(src, sourceImg) {
  try {
    const blob = await this._blobForContextImage(src, sourceImg);
    const filename = this._suggestedImageFilename(src, blob);
    if (typeof window.havenDesktop?.saveImage === 'function') {
      const buf = await blob.arrayBuffer();
      const bytes = new Uint8Array(buf);
      const chunk = 0x8000;
      let binary = '';
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      }
      const res = await window.havenDesktop.saveImage({ bytes: btoa(binary), filename });
      if (res?.cancelled) {
        this._showToast(t('media_runtime.image.save_cancelled'), 'info');
        return;
      }
      if (res?.ok) {
        this._showToast(
          res.path
            ? t('media_runtime.image.saved_to', { path: res.path })
            : t('media_runtime.image.saved'),
          'success'
        );
        return;
      }
      throw new Error(res?.reason || 'save failed');
    }
    if (typeof window.showSaveFilePicker === 'function') {
      try {
        const ext = (filename.split('.').pop() || 'png').toLowerCase();
        const mime = blob.type || 'image/png';
        const handle = await window.showSaveFilePicker({
          suggestedName: filename,
          types: [{ description: 'Image', accept: { [mime]: ['.' + ext] } }],
        });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        this._showToast(t('media_runtime.image.saved'), 'success');
        return;
      } catch (pickerErr) {
        if (pickerErr && pickerErr.name === 'AbortError') {
          this._showToast(t('media_runtime.image.save_cancelled'), 'info');
          return;
        }
      }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    this._showToast(t('media_runtime.image.saved'), 'success');
  } catch (err) {
    this._showToast(t('media_runtime.image.save_failed', { error: err.message || String(err) }), 'error');
  }
},

// The message a picture belongs to, for Edit tags on the image menu: a chat
// message, a forum topic card, a topic open in full (its first post has no
// message row of its own), or a reply in a thread. Returns the message id,
// its author, the element to anchor the editor on and the tags it has.
_imageTagTarget(img) {
  if (!img || !img.closest) return null;
  const topicBody = img.closest('#thread-messages .thread-topic-body');
  if (topicBody) {
    const id = this._activeThreadParent;
    const topic = id && this._forumTopics ? this._forumTopics.get(id) : null;
    return topic ? { msgId: topic.id, userId: topic.user_id, el: topicBody, tags: topic.attachmentTags || [] } : null;
  }
  const el = img.closest('#messages [data-msg-id], #thread-messages [data-msg-id]');
  if (!el) return null;
  const msgId = parseInt(el.dataset.msgId, 10);
  if (!msgId) return null;
  if (el.classList.contains('forum-topic')) {
    const topic = this._forumTopics ? this._forumTopics.get(msgId) : null;
    return { msgId, userId: el.dataset.userId, el, tags: (topic && topic.attachmentTags) || [] };
  }
  return { msgId, userId: el.dataset.userId, el, tags: null };
},

_showImageContextMenu(e, src, opts = {}) {
  this._hideImageContextMenu();
  const menu = document.createElement('div');
  menu.id = 'image-context-menu';
  menu.className = 'image-context-menu';
  // opts.viewImage: the <img> to open in the lightbox from a View entry, for
  // places where a left click does something else, like a forum card (#5646).
  // opts.sourceImg: the <img> the menu was opened on, so an encrypted DM
  // picture can be decrypted again for Open and Save (#5663).
  const sourceImg = opts.sourceImg || opts.viewImage || null;
  // A picture post is mostly picture, so right-clicking it lands here and not
  // on the message menu where Edit tags lives. Offer it here too, under the
  // same rule: your own upload, or anyone's with Manage Tags (#5682).
  // In a forum that includes a topic's card, the topic open in full, and
  // the replies under it (#5682).
  const tagTarget = this._imageTagTarget(sourceImg);
  const tagMsgEl = tagTarget && tagTarget.el;
  const tagCh = this.channels?.find(c => c.code === this.currentChannel);
  const canEditTags = !!tagTarget && !!tagCh && !tagCh.is_dm &&
    (String(tagTarget.userId) === String(this.user?.id) || !!this.user?.isAdmin || !!this._hasPerm?.('manage_tags'));
  menu.innerHTML = `
    ${opts.viewImage ? `<button data-action="view">🔍 ${t('media_runtime.image.view')}</button>` : ''}
    <button data-action="save">💾 ${t('media_runtime.image.save')}</button>
    <button data-action="copy">📋 ${t('media_runtime.image.copy')}</button>
    <button data-action="open">🔗 ${t('media_runtime.image.open_new_tab')}</button>
    ${canEditTags ? `<button data-action="edit-tags">🏷️ ${this._escapeHtml(t('tags.edit'))}</button>` : ''}
    <button data-action="hide">🙈 ${this._escapeHtml(t('app.messages.hide_image'))}</button>
  `;
  menu.style.left = e.clientX + 'px';
  menu.style.top = e.clientY + 'px';
  document.body.appendChild(menu);

  // Warm the image bytes while the menu is on screen. By the time "Copy Image"
  // is clicked this is usually already resolved, so the clipboard write is the
  // first thing that awaits rather than the last. Errors are swallowed here;
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
      this._hideImageContextMenu();
      this._saveContextImage(src, sourceImg);
      return;
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
            } catch { /* tainted canvas or detached node, try next */ }
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

        // Strategy 1: Electron desktop IPC (most reliable: main process
        // clipboard has no user-gesture requirement). Prefer raw base64 over
        // a data: URL so IPC doesn't pay the "data:image/png;base64," tax on
        // multi‑MB screenshots.
        if (window.havenDesktop?.clipboardWriteImage) {
          try {
            window.focus();
            const png = await resolvePngBlob();
            const b64 = await blobToBase64(png);
            const res = await window.havenDesktop.clipboardWriteImage(b64);
            if (res?.ok) { this._showToast(t('media_runtime.image.copied'), 'success'); return; }
            console.warn('[Haven] IPC clipboard write failed:', res?.reason);
            // Fall through; still try web/desktop text fallbacks.
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
          // whenever the document isn't focused, which is the normal state
          // right after dismissing a context menu, and the reported failure
          // here. Pull focus back before asking, and give the focus change a
          // frame to land.
          if (!document.hasFocus()) {
            window.focus();
            await new Promise(r => requestAnimationFrame(r));
          }
          // Reuse the blob the menu started fetching on open where possible, so
          // a slow image can't stretch this past the transient user activation.
          const blobPromise = (async () => resolvePngBlob())();
          await navigator.clipboard.write([
            new ClipboardItem({ 'image/png': blobPromise })
          ]);
          this._showToast(t('media_runtime.image.copied'), 'success');
          return;
        } catch (err) {
          console.error('[Haven] Web clipboard.write failed:', err);
          // Strategy 3: at least put the URL on the clipboard so the
          // user has something to paste. On desktop, route text through
          // main-process IPC too: navigator.clipboard is often gesture-
          // locked in Electron BrowserViews after a context menu closes.
          try {
            if (window.havenDesktop?.clipboardWriteText) {
              const res = await window.havenDesktop.clipboardWriteText(src);
              if (res?.ok) {
                this._showToast(t('media_runtime.image.url_copied_bytes_unavailable'), 'warning');
                return;
              }
            }
            await navigator.clipboard.writeText(src);
            this._showToast(
              t(isDesktop ? 'media_runtime.image.url_copied_desktop' : 'media_runtime.image.url_copied_browser'),
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
                ? t(isDesktop ? 'media_runtime.image.clipboard_denied_desktop' : 'media_runtime.image.clipboard_denied_browser')
                : t('media_runtime.image.copy_failed', { error: err2?.message || err2 }),
              'error'
            );
          }
        }
      })();
      return;
    } else if (action === 'view') {
      this._hideImageContextMenu();
      this._openLightbox(src, opts.viewImage);
      return;
    } else if (action === 'open') {
      if (sourceImg) this._openImageInNewTab(sourceImg);
      else window.open(src, '_blank', 'noopener,noreferrer');
    } else if (action === 'edit-tags') {
      this._hideImageContextMenu();
      if (tagTarget) this._openMessageTagEditor?.(tagTarget.msgId, tagMsgEl, tagTarget.tags);
      return;
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


// ── Lazy media queue ──
//
// Chat images, stickers, GIFs and link-preview pictures used to load the
// moment a message rendered, and every one of the 100 messages kept in the
// DOM held its decoded bitmap. On a busy channel that was most of the
// renderer's memory (about 430 MB on the desktop app). Now an image only
// fetches when it comes within LAZY_NEAR px of the box it scrolls in, a few
// at a time with the closest first, and it is let go again once it scrolls
// LAZY_FAR px away or the window has been hidden for a while. After the first
// load the picture's own size is remembered, and the blank that stands in for
// it while unloaded has exactly that size, so max-width, the image size
// setting and the window size all treat the blank like the picture and
// nothing in the history moves.
//
// The whole document is watched, so the main chat, the thread panel, DM
// pop-outs and search results all take part, and each image is observed
// relative to the scroll box it lives in (a viewport-rooted observer never
// sees anything scrolled out of a nested box, margin or not).
//
// The first load is the one time a picture changes size. When that picture
// sits above what the reader is looking at, the content would slide down by
// its height, and the browser's own scroll anchoring did not catch it in the
// chat box, so the loader keeps its own anchor: on every scroll it notes the
// element at the top of the box and where it sits, and right after a picture
// above it grows, it moves the scroll by exactly the drift.

_lazyBlank() {
  return 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
},

// A blank with the real picture's own size, for the unloaded state.
_lazySizedBlank(w, h) {
  return `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}'/%3E`;
},

// Wrap an emitted `src="…"` attribute so the loader owns the fetch. Attributes
// without a src (media-proxy placeholders) pass through untouched, and so does
// everything when the loader is not running (no IntersectionObserver).
_lazySrcAttr(attrs) {
  const s = String(attrs || '');
  if (!this._lazyMedia) return s;
  return s.replace(/(^|\s)src="/, `$1src="${this._lazyBlank()}" data-lazy-src="`);
},

// The URL a lazy image shows or will show, for the lightbox and copy actions.
_lazyRealSrc(img) {
  return (img && (img.dataset?.lazySrc || img.getAttribute?.('src'))) || '';
},

// Distance from the viewport, in px. Zero for anything on screen.
_lazyDistance(rect, viewportHeight) {
  const top = rect.top, bottom = rect.bottom;
  if (bottom >= 0 && top <= viewportHeight) return 0;
  return top > viewportHeight ? top - viewportHeight : -bottom;
},

// Which pending images to start now: closest first, never more than
// maxParallel in flight. Pure, so the test can drive it.
_lazyPickNext(pending, inFlight, maxParallel) {
  const room = Math.max(0, maxParallel - inFlight);
  return [...pending].sort((a, b) => a.distance - b.distance).slice(0, room).map(p => p.img);
},

_lazySelector() {
  return 'img.chat-image, img.sticker-img, img.lp-image, img.link-preview-gallery-img';
},

// The box an element scrolls in, or null when only the page scrolls.
_lazyScrollerOf(el) {
  let node = el && el.parentElement;
  while (node && node !== document.body) {
    const oy = getComputedStyle(node).overflowY;
    if (oy === 'auto' || oy === 'scroll') return node;
    node = node.parentElement;
  }
  return null;
},

_setupLazyMedia() {
  if (this._lazyMedia || typeof IntersectionObserver !== 'function' || typeof MutationObserver !== 'function') return;
  const L = this._lazyMedia = {
    NEAR: 800, FAR: 2400, MAX_PARALLEL: 3, HIDDEN_UNLOAD_MS: 20000,
    near: new Set(), inFlight: 0, hiddenTimer: null,
    obs: new Map(), byImg: new WeakMap(), anchors: new Map(), growing: new Set(),
  };
  const sel = this._lazySelector();
  const each = (root, fn) => {
    if (!root || root.nodeType !== 1) return;
    if (root.matches(sel)) fn(root);
    root.querySelectorAll(sel).forEach(fn);
  };
  // Fires right after the layout in which a picture took its real size, so
  // the scroll is corrected before anyone sees the slide.
  if (typeof ResizeObserver === 'function') {
    L.ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        if (!L.growing.has(e.target)) continue;
        L.growing.delete(e.target);
        this._lazyHoldAnchor(this._lazyScrollerOf(e.target));
      }
    });
  }
  each(document.body, (img) => this._lazyAdopt(img));
  L.mo = new MutationObserver((muts) => {
    for (const m of muts) {
      m.removedNodes.forEach((n) => each(n, (img) => this._lazyForget(img)));
      m.addedNodes.forEach((n) => each(n, (img) => this._lazyAdopt(img)));
    }
  });
  L.mo.observe(document.body, { childList: true, subtree: true });
  document.addEventListener('visibilitychange', () => {
    clearTimeout(L.hiddenTimer);
    if (document.hidden) L.hiddenTimer = setTimeout(() => this._lazyUnloadAll(), L.HIDDEN_UNLOAD_MS);
    else this._lazyPump();
  });
  window.addEventListener('resize', () => { for (const sc of L.obs.keys()) if (sc) this._lazyRecordAnchor(sc); });
},

// One near/far observer pair per scroll box, made on first use, plus the
// scroll listener that keeps that box's anchor fresh.
_lazyObserversFor(scroller) {
  const L = this._lazyMedia;
  let o = L.obs.get(scroller);
  if (o) return o;
  o = {
    near: new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) L.near.add(e.target); else L.near.delete(e.target);
      }
      this._lazyPump();
    }, { root: scroller, rootMargin: `${L.NEAR}px 0px` }),
    far: new IntersectionObserver((entries) => {
      for (const e of entries) if (!e.isIntersecting) this._lazyUnload(e.target);
    }, { root: scroller, rootMargin: `${L.FAR}px 0px` }),
  };
  L.obs.set(scroller, o);
  if (scroller) {
    scroller.addEventListener('scroll', () => this._lazyRecordAnchor(scroller), { passive: true });
    this._lazyRecordAnchor(scroller);
  }
  return o;
},

// Note the first message at the top edge of a scroll box and where it sits.
// Sticky bits (a toolbar, a date divider) do not move with the content, so
// they are passed over for the first thing underneath them.
_lazyRecordAnchor(sc) {
  const L = this._lazyMedia;
  if (!L || !sc) return;
  const r = sc.getBoundingClientRect();
  if (r.height <= 0 || r.width <= 0) return;
  const edge = r.top + 1;
  let cands = sc.querySelectorAll('[data-msg-id]');
  if (!cands.length) cands = sc.children;
  for (const el of cands) {
    const b = el.getBoundingClientRect();
    if (b.height <= 0 || b.bottom <= edge) continue;
    const pos = getComputedStyle(el).position;
    if (pos === 'sticky' || pos === 'fixed') continue;
    L.anchors.set(sc, { el, top: b.top });
    return;
  }
  L.anchors.delete(sc);
},

// Put the anchor back where it was noted, after something above it grew.
_lazyHoldAnchor(sc) {
  const L = this._lazyMedia;
  if (!L || !sc) return;
  const a = L.anchors.get(sc);
  if (!a || !a.el.isConnected || !sc.contains(a.el)) return;
  const now = a.el.getBoundingClientRect().top;
  const drift = now - a.top;
  if (Math.abs(drift) < 1) return;
  // A drift of more than a screen is a stale note, not a picture; start over.
  if (Math.abs(drift) > sc.clientHeight) { this._lazyRecordAnchor(sc); return; }
  sc.scrollTop += drift;
  a.top = a.el.getBoundingClientRect().top;
},

_lazyAdopt(img) {
  const L = this._lazyMedia;
  if (!L) return;
  if (img.closest('.lightbox, .image-lightbox, [data-no-lazy]')) return;
  // E2E pictures arrive without a src and get a blob: from the decryptor.
  if (img.classList.contains('e2e-img-pending') || img.classList.contains('e2e-img-loading') || img.classList.contains('e2e-img-failed')) return;
  if (!img.dataset.lazy) {
    const src = img.dataset.lazySrc || img.getAttribute('src') || '';
    if (!src || src.startsWith('data:') || src.startsWith('blob:')) return;
    img.dataset.lazySrc = src;
    img.dataset.lazy = 'pending';
    img.decoding = 'async';
    if (img.getAttribute('src') !== this._lazyBlank()) img.src = this._lazyBlank();
    if (L.ro) L.ro.observe(img);
  }
  // Observing an already observed target is a no-op, so a node that moved
  // between boxes (a message promoted into a pop-out) is simply re-homed.
  const prev = L.byImg.get(img);
  const o = this._lazyObserversFor(this._lazyScrollerOf(img));
  if (prev && prev !== o) { prev.near.unobserve(img); prev.far.unobserve(img); }
  L.byImg.set(img, o);
  o.near.observe(img);
  o.far.observe(img);
},

// Stop watching an image that left the document, so the observers do not
// keep detached nodes alive.
_lazyForget(img) {
  const L = this._lazyMedia;
  if (!L) return;
  const o = L.byImg.get(img);
  if (o) { o.near.unobserve(img); o.far.unobserve(img); }
  if (L.ro) L.ro.unobserve(img);
  L.near.delete(img);
  L.growing.delete(img);
},

_lazyPump() {
  const L = this._lazyMedia;
  if (!L || document.hidden) return;
  const vh = window.innerHeight || 800;
  const pending = [];
  for (const img of L.near) {
    if (!img.isConnected) { L.near.delete(img); continue; }
    if (img.dataset.lazy !== 'pending') continue;
    pending.push({ img, distance: this._lazyDistance(img.getBoundingClientRect(), vh) });
  }
  for (const img of this._lazyPickNext(pending, L.inFlight, L.MAX_PARALLEL)) {
    const onScreen = this._lazyDistance(img.getBoundingClientRect(), vh) === 0;
    img.dataset.lazy = 'loading';
    L.inFlight++;
    const start = () => this._lazyLoad(img);
    // Visible images start now; the ones just outside wait for an idle
    // slice so a fast scroll never fights the fetches for the main thread.
    onScreen || typeof requestIdleCallback !== 'function' ? start() : requestIdleCallback(start, { timeout: 250 });
  }
},

_lazyLoad(img) {
  const L = this._lazyMedia;
  const sc = this._lazyScrollerOf(img);
  const firstLoad = !img.dataset.lazyW;
  const wasAtBottom = !!sc && (sc.scrollHeight - sc.scrollTop - sc.clientHeight) <= 4;
  if (sc && firstLoad) {
    // A fresh anchor for this load; scrolling in the meantime refreshes it.
    if (!L.anchors.has(sc)) this._lazyRecordAnchor(sc);
    if (L.ro) L.growing.add(img);
  }
  const done = (ok) => {
    img.onload = img.onerror = null;
    L.inFlight = Math.max(0, L.inFlight - 1);
    if (!img.isConnected) { L.growing.delete(img); return this._lazyPump(); }
    img.dataset.lazy = ok ? 'loaded' : 'error';
    if (ok && img.naturalWidth && img.naturalHeight) {
      img.dataset.lazyW = img.naturalWidth;
      img.dataset.lazyH = img.naturalHeight;
    }
    // The resize callback normally beat us here; if it did not (no size
    // change, or no ResizeObserver), settle now.
    if (L.growing.delete(img)) this._lazyHoldAnchor(sc);
    this._lazySettleBottom(sc, wasAtBottom);
    this._lazyPump();
  };
  img.onload = () => done(true);
  img.onerror = () => done(false);
  img.src = img.dataset.lazySrc;
},

// Someone reading the newest messages stays glued to the bottom while a
// picture there takes its size, the way they did when pictures loaded at
// once.
_lazySettleBottom(sc, wasAtBottom) {
  if (!sc) return;
  const mainChat = sc.id === 'messages' && typeof this._coupledToBottom === 'boolean';
  const glued = mainChat ? this._coupledToBottom : wasAtBottom;
  if (!glued) return;
  if (mainChat && this._debouncedScrollToBottom) this._debouncedScrollToBottom();
  else sc.scrollTop = sc.scrollHeight;
},

_lazyUnload(img) {
  const L = this._lazyMedia;
  if (!L || img.dataset.lazy !== 'loaded') return;
  img.dataset.lazy = 'pending';
  // A GIF frozen to its first frame for the viewer's animation preference
  // comes back animated, so let the freeze run again on the next load.
  if (img.dataset.chatAnimDone) {
    delete img.dataset.chatAnimDone;
    delete img.dataset.chatAnimatedSrc;
    delete img.dataset.chatAnimPlaying;
  }
  const w = +img.dataset.lazyW, h = +img.dataset.lazyH;
  img.src = (w && h) ? this._lazySizedBlank(w, h) : this._lazyBlank();
},

_lazyUnloadAll() {
  const L = this._lazyMedia;
  if (!L) return;
  document.querySelectorAll('img[data-lazy="loaded"]').forEach((img) => this._lazyUnload(img));
},

};
