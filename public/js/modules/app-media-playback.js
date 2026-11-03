// Playing media in chat: the volume of YouTube cards, and pausing media
// scrolled out of view.
//
// YouTube's embedded player shows only a mute button on narrow and Shorts
// layouts, so the card's top bar gets its own volume slider. It drives the
// player through YouTube's iframe API (the card loads with enablejsapi) and
// is remembered for every card on this device.
//
// "Pause videos and audio scrolled out of view" (Settings > Link Previews,
// on by default): a video, an audio file or a YouTube card in the channel,
// a thread or the DM pop-out stops when it leaves the screen. A video popped
// out into the browser's own picture-in-picture keeps playing, and so does one
// pinned with its Keep playing button (until the page reloads).
//
// Every player's controls are built here, so they match wherever they appear:
// the same drawn icons and sizes (style-media-controls.css). Theater makes one
// player as wide as the chat; Fullscreen fills the screen.

const VOLUME_KEY = 'haven_embed_volume';
const PAUSE_KEY = 'haven_pause_offscreen_media';
const FEEDS = ['messages', 'thread-messages', 'dm-pip-messages'];
const MEDIA = 'video, audio, .link-preview-yt iframe';

// Each drawing is on a 24 by 24 square.
const ICONS = {
  volume: 'M11 5 6 9H3v6h3l5 4zM15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13',
  muted: 'M11 5 6 9H3v6h3l5 4zM16 9.5l5 5M21 9.5l-5 5',
  loop: 'M17 1l4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 23l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3',
  keep: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM10 8.5l5.5 3.5-5.5 3.5z',
  theater: 'M4 7h16a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1z',
  fullscreen: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  chevron: 'M6 9l6 6 6-6',
  music: 'M9 18V5l12-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM21 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
};
const SIZES = ['small', 'medium', 'full'];

export default {

_mediaIcon(name) {
  return `<svg class="media-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${ICONS[name]}"/></svg>`;
},

_embedVolume() {
  let v = NaN;
  try { v = parseInt(localStorage.getItem(VOLUME_KEY) || '', 10); } catch { /* private mode: no saved volume, use the default */ }
  return Number.isFinite(v) && v >= 0 && v <= 100 ? v : 100;
},

_ytCommand(iframe, func, args = []) {
  try {
    iframe?.contentWindow?.postMessage(JSON.stringify({ event: 'command', func, args }), 'https://www.youtube.com');
  } catch (err) {
    console.warn('[media] could not reach the YouTube player', err.message);
  }
},

// The speaker and slider for a YouTube card's top bar, its Loop button and its
// Keep playing button.
_ytVolumeHtml() {
  const v = this._embedVolume();
  const mute = t(v === 0 ? 'app.messages.embed_unmute' : 'app.messages.embed_mute');
  return `<span class="lp-volume"><button type="button" class="media-btn lp-mute" title="${mute}" aria-label="${mute}">${this._mediaIcon(v === 0 ? 'muted' : 'volume')}</button><input type="range" min="0" max="100" step="5" value="${v}" title="${t('app.messages.embed_volume')}" aria-label="${t('app.messages.embed_volume')}"></span>${this._loopHtml()}${this._keepPlayingHtml()}`;
},

// Theater and Fullscreen. An iPhone cannot fullscreen part of a page; its own
// video controls do that for uploaded videos.
_mediaViewHtml() {
  const canFill = document.fullscreenEnabled || document.webkitFullscreenEnabled;
  const fill = t('app.messages.embed_fullscreen');
  return `<button type="button" class="media-btn media-theater-btn" aria-pressed="false" title="${t('app.messages.embed_theater')}" aria-label="${t('app.messages.embed_theater')}">${this._mediaIcon('theater')}</button>`
    + (canFill ? `<button type="button" class="media-btn media-fullscreen-btn" title="${fill}" aria-label="${fill}">${this._mediaIcon('fullscreen')}</button>` : '');
},

// The controls on an uploaded file's row.
_mediaControlsHtml(kind, extraHtml = '') {
  return `<span class="media-controls">${this._loopHtml()}${this._keepPlayingHtml()}${kind === 'video' ? this._mediaViewHtml() : ''}${extraHtml}</span>`;
},

// The preview size menu. The size is one setting for every preview, shared
// with Settings > Link Previews, where previews can also be turned off.
_openEmbedSizeMenu(btn) {
  const open = this._embedSizeMenu;
  if (open) open.close();
  if (open && open.btn === btn) return;
  const current = this._embedSize();
  const menu = document.createElement('div');
  menu.className = 'lp-size-menu';
  menu.setAttribute('role', 'menu');
  menu.innerHTML = `<div class="lp-size-menu-title">${t('app.messages.embed_size')}</div>`
    + SIZES.map(s => `<button type="button" role="menuitemradio" aria-checked="${s === current}" data-size="${s}">${t(`settings.embed_display.${s}`)}</button>`).join('')
    + `<div class="lp-size-menu-note">${t('app.messages.embed_size_note')}</div>`;
  document.body.appendChild(menu);
  const r = btn.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(r.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${r.bottom + 4 + menu.offsetHeight > window.innerHeight ? Math.max(8, r.top - 4 - menu.offsetHeight) : r.bottom + 4}px`;

  const outside = (e) => { if (!menu.contains(e.target) && !btn.contains(e.target)) close(); };
  const onKey = (e) => { if (e.key === 'Escape') { close(); btn.focus(); } };
  const close = () => {
    menu.remove();
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('scroll', close, true);
    window.removeEventListener('resize', close);
    this._embedSizeMenu = null;
  };
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('scroll', close, true);
  window.addEventListener('resize', close);
  this._embedSizeMenu = { btn, close };
  menu.addEventListener('click', (e) => {
    const size = e.target.closest('[data-size]')?.dataset.size;
    if (!size) return;
    const atBottom = this._coupledToBottom;
    this._applyEmbedSize(size);
    close();
    if (atBottom) this._scrollToBottom(true);
  });
  menu.querySelector('[aria-checked="true"]')?.focus();
},

_toggleMediaTheater(btn) {
  const box = btn.closest('.link-preview, .file-attachment');
  if (!box) return;
  const atBottom = this._coupledToBottom;
  const on = box.classList.toggle('media-theater');
  btn.setAttribute('aria-pressed', String(on));
  const label = t(on ? 'app.messages.embed_theater_on' : 'app.messages.embed_theater');
  btn.title = label;
  btn.setAttribute('aria-label', label);
  if (atBottom) this._scrollToBottom(true);
  else box.scrollIntoView({ block: 'nearest' });
},

_mediaFullscreen(btn) {
  const target = btn.closest('.link-preview, .file-attachment')?.querySelector('.link-preview-yt iframe, video');
  if (!target) return;
  const ask = target.requestFullscreen || target.webkitRequestFullscreen;
  if (!ask) return;
  Promise.resolve(ask.call(target)).catch(err => console.warn('[media] could not go fullscreen', err.name));
},

// YouTube's player cannot be set to loop from outside once it is loaded, so
// a looping card asks the player to report its state and starts the video
// over when it says it ended. A player only reports to a page that said it
// is listening; that is asked again on every toggle, which is harmless.
_ytListen(iframe) {
  try {
    iframe?.contentWindow?.postMessage(JSON.stringify({ event: 'listening', id: 1, channel: 'widget' }), 'https://www.youtube.com');
  } catch (err) {
    console.warn('[media] could not reach the YouTube player', err.message);
  }
  this._ytCommand(iframe, 'addEventListener', ['onStateChange']);
},

_ytLoopOnEnd(e) {
  if (e.origin !== 'https://www.youtube.com' || typeof e.data !== 'string') return;
  let msg;
  try { msg = JSON.parse(e.data); } catch { return; /* not one of the player's messages */ }
  const ended = (msg.event === 'onStateChange' && msg.info === 0)
    || (msg.event === 'infoDelivery' && msg.info && msg.info.playerState === 0);
  if (!ended) return;
  const iframe = [...document.querySelectorAll('.link-preview-yt iframe[data-loop="1"]')].find(f => f.contentWindow === e.source);
  if (!iframe) return;
  this._ytCommand(iframe, 'seekTo', [0, true]);
  this._ytCommand(iframe, 'playVideo');
},

// A pin that lets one video, sound or YouTube card keep playing when it is
// scrolled out of view. It shows only while that pausing is switched on.
_keepPlayingHtml() {
  return `<button type="button" class="media-btn media-keep" aria-pressed="false" title="${t('app.messages.keep_playing')}" aria-label="${t('app.messages.keep_playing')}">${this._mediaIcon('keep')}</button>`;
},

// Loop for an uploaded video or sound (#5817). The browser's own controls
// keep Loop in the right-click menu only, which a phone never shows.
_loopHtml() {
  return `<button type="button" class="media-btn media-loop" aria-pressed="false" title="${t('app.messages.loop')}" aria-label="${t('app.messages.loop')}">${this._mediaIcon('loop')}</button>`;
},

// The player a pin belongs to: the one in its own file card or YouTube card.
_keepPlayingTarget(btn) {
  const box = btn.closest('.link-preview, .file-attachment');
  return box ? box.querySelector('video, audio, .link-preview-yt iframe') : null;
},

_wireYtVolume(card) {
  const slider = card.querySelector('.lp-volume input');
  const mute = card.querySelector('.lp-mute');
  const iframe = card.querySelector('.link-preview-yt iframe');
  if (!slider || !iframe) return;
  const apply = (v) => {
    this._ytCommand(iframe, 'setVolume', [v]);
    this._ytCommand(iframe, v === 0 ? 'mute' : 'unMute');
  };
  const show = (v) => {
    slider.style.setProperty('--fill', `${v}%`);
    mute.innerHTML = this._mediaIcon(v === 0 ? 'muted' : 'volume');
    const label = t(v === 0 ? 'app.messages.embed_unmute' : 'app.messages.embed_mute');
    mute.title = label;
    mute.setAttribute('aria-label', label);
  };
  const set = (v) => {
    show(v);
    try { localStorage.setItem(VOLUME_KEY, String(v)); } catch { /* private mode: the volume lasts this visit only */ }
    apply(v);
  };
  show(Number(slider.value));
  // The speaker mutes, and brings back the level from before.
  let before = Number(slider.value) || 100;
  mute.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const v = Number(slider.value);
    if (v > 0) before = v;
    slider.value = v > 0 ? 0 : before;
    set(Number(slider.value));
  });
  // The header is a click target of its own (size, collapse): keep the
  // slider's clicks to itself.
  slider.addEventListener('click', (e) => e.stopPropagation());
  slider.addEventListener('input', () => set(Number(slider.value)));
  // The player takes commands once it has started up; until then they are
  // dropped, so the saved volume is sent a few times after it loads.
  iframe.addEventListener('load', () => {
    const v = this._embedVolume();
    if (v === 100) return;
    for (const ms of [400, 1500, 4000]) setTimeout(() => apply(this._embedVolume()), ms);
  });
},

_pauseOffscreenOn() {
  // On unless turned off.
  try { return localStorage.getItem(PAUSE_KEY) !== 'false'; } catch { return true; }
},

_setupMediaPlayback() {
  // The pins show only while pausing is on (style-streams-markdown.css).
  const showPins = () => document.body.classList.toggle('pause-offscreen-off', !this._pauseOffscreenOn());
  showPins();
  const toggle = document.getElementById('pause-offscreen-media');
  if (toggle) {
    toggle.checked = this._pauseOffscreenOn();
    toggle.addEventListener('change', () => {
      try { localStorage.setItem(PAUSE_KEY, toggle.checked ? 'true' : 'false'); } catch { /* private mode: the choice lasts this visit only */ }
      showPins();
    });
  }
  this._keepPlaying = new WeakSet();
  // Card headers are click targets of their own (size, collapse), so the
  // pin keeps its clicks to itself.
  document.addEventListener('click', (e) => {
    const btn = e.target.closest?.('.media-keep');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const media = this._keepPlayingTarget(btn);
    if (!media) return;
    const on = btn.getAttribute('aria-pressed') !== 'true';
    btn.setAttribute('aria-pressed', String(on));
    btn.title = t(on ? 'app.messages.keep_playing_on' : 'app.messages.keep_playing');
    if (on) this._keepPlaying.add(media); else this._keepPlaying.delete(media);
  }, true);
  document.addEventListener('click', (e) => {
    const btn = e.target.closest?.('.media-loop');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const box = btn.closest('.file-attachment, .link-preview');
    const media = box?.querySelector('video, audio');
    const iframe = media ? null : box?.querySelector('.link-preview-yt iframe');
    if (!media && !iframe) return;
    let on;
    if (media) {
      media.loop = !media.loop;
      on = media.loop;
    } else {
      on = iframe.dataset.loop !== '1';
      if (on) { iframe.dataset.loop = '1'; this._ytListen(iframe); } else delete iframe.dataset.loop;
    }
    btn.setAttribute('aria-pressed', String(on));
    btn.title = t(on ? 'app.messages.loop_on' : 'app.messages.loop');
  }, true);
  document.addEventListener('click', (e) => {
    const theater = e.target.closest?.('.media-theater-btn');
    const fullscreen = e.target.closest?.('.media-fullscreen-btn');
    if (!theater && !fullscreen) return;
    e.preventDefault();
    e.stopPropagation();
    if (theater) this._toggleMediaTheater(theater);
    else this._mediaFullscreen(fullscreen);
  }, true);
  window.addEventListener('message', (e) => this._ytLoopOnEnd(e));
  if (typeof IntersectionObserver !== 'function') return;
  const seen = new WeakSet();
  const io = new IntersectionObserver((entries) => {
    if (!this._pauseOffscreenOn()) return;
    for (const entry of entries) {
      if (entry.isIntersecting) continue;
      const el = entry.target;
      if (this._keepPlaying.has(el)) continue;
      if (el.tagName === 'IFRAME') this._ytCommand(el, 'pauseVideo');
      else if (!el.paused && document.pictureInPictureElement !== el) el.pause();
    }
  });
  const watch = (root) => {
    if (!root || !root.querySelectorAll) return;
    const found = root.matches?.(MEDIA) ? [root] : [];
    found.push(...root.querySelectorAll(MEDIA));
    for (const el of found) {
      if (seen.has(el)) continue;
      seen.add(el);
      io.observe(el);
    }
  };
  for (const id of FEEDS) {
    const feed = document.getElementById(id);
    if (!feed) continue;
    watch(feed);
    new MutationObserver((records) => {
      for (const r of records) r.addedNodes.forEach(n => { if (n.nodeType === 1) watch(n); });
    }).observe(feed, { childList: true, subtree: true });
  }
},

};
