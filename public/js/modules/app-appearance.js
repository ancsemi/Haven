// Appearance settings: animated pictures, density, scrolling, toggle style,
// zoom, emoji size, picture and embed size, role display, toolbar icons, and
// the custom dropdowns that replace plain select boxes.

export default {

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
  try { localStorage.setItem('haven_animate_chat', value); } catch { /* storage blocked (private mode): nothing is remembered, nothing else breaks */ }
  document.querySelectorAll('#animate-chat-picker .density-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.animchat === value);
  });
  this._applyViewerChatAnimPref();
},

// The address to judge "can this animate" by, unwrapping the media proxy.
_chatImgRealUrl(img) {
  return img.getAttribute('data-mp-origin') || img.getAttribute('data-lazy-src') || img.getAttribute('src') || '';
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
  try { localStorage.setItem('haven_animate_pfp', value); } catch { /* storage blocked (private mode): nothing is remembered, nothing else breaks */ }
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

  // Closing on an outside click used to register a document listener per
  // dropdown, capturing that wrap and panel. Every rebuild of a settings
  // surface makes fresh <select> elements, so each open left another handler
  // behind pinning detached DOM. Ten opens, ten listeners, none removed.
  //
  // One delegated listener for every custom select instead, installed once and
  // finding open panels from the DOM rather than from a closure, so nothing is
  // captured and there is nothing to clean up. (#5426)
  if (!document._csOutsideClickBound) {
    document._csOutsideClickBound = true;
    document.addEventListener('click', (e) => {
      document.querySelectorAll('.custom-select-panel').forEach(openPanel => {
        if (openPanel.style.display === 'none') return;
        const owner = openPanel.closest('.custom-select-wrap');
        if (!owner || !owner.contains(e.target)) openPanel.style.display = 'none';
      });
    });
  }

  selectEl.addEventListener('change', syncLabel);
  wrap._csRebuild = buildPanel;
  syncLabel();
},

// Helper function to simplify picker setups
_setupPicker(pickerId, storageKey, allowedValues, defaultValue, dataKey, onChange, buttonDataKey) {
  if (!allowedValues.includes(defaultValue)) {
    throw new Error(`Invalid default value "${defaultValue}" for ${pickerId}`);
  }

  const picker = document.getElementById(pickerId);
  if (!picker) return null;

  const dataKeys = Array.isArray(dataKey) ? dataKey : [dataKey];
  buttonDataKey ??= dataKeys[0];
  const apply = (value, notify = false) => {
    dataKeys.forEach(key => {
      document.documentElement.dataset[key] = value;
    });

    picker.querySelectorAll('.density-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset[buttonDataKey] === value);
    });
    if (notify) onChange?.(value);
  };

  const stored = localStorage.getItem(storageKey);
  const saved = allowedValues.includes(stored) ? stored : defaultValue;
  apply(saved);

  picker.addEventListener('click', (e) => {
    const btn = e.target.closest('.density-btn');
    if (!btn || !picker.contains(btn)) return;
    const value = btn.dataset[buttonDataKey];
    if (!allowedValues.includes(value)) return;

    apply(value, true);
    localStorage.setItem(storageKey, value);
  });
  return saved;
},

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// LAYOUT DENSITY
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

_setupDensityPicker() {
  const pickerId = 'density-picker';
  const storageKey = 'haven-density';
  const allowedValues = ['compact', 'cozy', 'spacious'];
  const defaultValue = 'cozy';
  const dataKey = ['density', 'havenDensity'];
  const buttonDataKey = 'density';
  const onChange = (density) => {
    document.dispatchEvent(new CustomEvent('haven:density-change', {detail: { density }}))
  };

  this._setupPicker(pickerId, storageKey, allowedValues, defaultValue, dataKey, onChange, buttonDataKey);
},

// ── Channel Scrolling Picker ──
// Sets data-channel-scroll on <html>; CSS handles the layout. Persists the
// viewer's choice and applies it live without a reload.
_setupChannelScrollPicker() {
  const pickerId = 'channel-scroll-picker';
  const storageKey = 'haven-channel-scroll';
  const allowedValues = ['separate', 'combined'];
  const defaultValue = 'separate';
  const dataKey = 'channelScroll';

  this._setupPicker(pickerId, storageKey, allowedValues, defaultValue, dataKey);
},

// ── Toggle Style Picker (sliders vs checkboxes) ──
// Sets data-toggle-style on <html>; the CSS does the rest. theme-init.js
// applies the same value pre-paint, so this only has to keep the buttons in
// step and persist the choice.
_setupToggleStylePicker() {
  const pickerId = 'toggle-style-picker';
  const storageKey = 'haven-toggle-style';
  const allowedValues = ['switch', 'box'];
  const defaultValue = 'switch';
  const dataKey = 'toggleStyle';
  const buttonDataKey = 'togglestyle';

  this._setupPicker(pickerId, storageKey, allowedValues, defaultValue, dataKey, null, buttonDataKey);
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
  const pickerId = 'emoji-size-picker';
  const storageKey = 'haven-emojisize';
  const allowedValues = ['small', 'normal', 'large', 'x-large'];
  const defaultValue = 'normal';
  const dataKey = 'emojisize';

  this._setupPicker(pickerId, storageKey, allowedValues, defaultValue, dataKey);
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
  const label = `⤢ ${t(`settings.embed_display.${mode}`)}`;
  document.querySelectorAll('.lp-size').forEach(b => { b.textContent = label; });
  const picker = document.getElementById('embed-size-picker');
  if (picker) picker.querySelectorAll('[data-embed-size]').forEach(b => b.classList.toggle('active', b.dataset.embedSize === mode));
},

// ── Role Display Picker ──

_setupRoleDisplayPicker() {
  const pickerId = 'role-display-picker';
  const storageKey = 'haven-role-display';
  const allowedValues = ['colored-name', 'dot'];
  const defaultValue = 'colored-name';
  const dataKey = 'roledisplay';
  const onChange = () => {
    // Re-render member list to reflect the change
    if (this._updateUsers) this._updateUsers();
  };

  this._setupPicker(pickerId, storageKey, allowedValues, defaultValue, dataKey, onChange);
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
    react: t('msg_toolbar.react'),
    reply: t('msg_toolbar.reply'),
    quote: t('msg_toolbar.quote'),
    thread: t('msg_toolbar.thread'),
    pin: t('media_runtime.toolbar.pin'),
    archive: t('media_runtime.toolbar.protect'),
    edit: t('msg_toolbar.edit'),
    delete: t('msg_toolbar.delete')
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

  // Glyphs is the Haven Glyphs plugin, switched on and off from here so it
  // sits with the other two icon looks instead of on the plugin page. The
  // plugin replaces emoji text, so the toolbars show their emoji twins under
  // it and the plugin turns those into glyphs (#5673).
  const GLYPHS_PLUGIN = 'HavenGlyphs.plugin.js';
  const applyIconMode = (mode) => {
    document.documentElement.dataset.toolbaricons = mode === 'glyphs' ? 'emoji' : mode;
    picker.querySelectorAll('[data-toolbaricons]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.toolbaricons === mode);
    });
  };
  const savedMode = localStorage.getItem('haven-toolbar-icons') || 'mono';
  const normalizedMode = savedMode === 'color' ? 'emoji' : savedMode;
  applyIconMode(normalizedMode);

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
          <button type="button" class="toolbar-order-move" data-dir="up" data-key="${key}" ${index === 0 ? 'disabled' : ''} title="${t('media_runtime.move_up')}">▲</button>
          <button type="button" class="toolbar-order-move" data-dir="down" data-key="${key}" ${index === currentOrder.length - 1 ? 'disabled' : ''} title="${t('media_runtime.move_down')}">▼</button>
        </div>
      `;
      orderList.appendChild(row);
    });
  };

  renderOrderList();

  picker.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-toolbaricons]');
    if (!btn) return;
    let mode = btn.dataset.toolbaricons;
    const loader = window.HavenPluginLoader;
    if (mode === 'glyphs') {
      const plugin = loader?.loadedPlugins?.get?.(GLYPHS_PLUGIN);
      if (!plugin || !plugin.instance) {
        this._showToast(t('settings.toolbar_icons.glyphs_missing'), 'error');
        mode = 'emoji';
      } else {
        loader.enablePlugin(GLYPHS_PLUGIN);
      }
    } else if (loader?.loadedPlugins?.get?.(GLYPHS_PLUGIN)?.enabled) {
      loader.disablePlugin(GLYPHS_PLUGIN);
    }
    localStorage.setItem('haven-toolbar-icons', mode);
    applyIconMode(mode);
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

};
