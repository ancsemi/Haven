// Videos and link previews in messages: video players and their
// thumbnails, link preview cards and the queue that fetches them, embed
// size and spoiler controls, and YouTube links.

// Cache generated video thumbnails so each URL is only captured once
const _thumbCache = new Map();

export default {

// ── Link Previews ─────────────────────────────────────

/**
 * Wire up fullscreen button and PiP seek support for uploaded video elements,
 * plus the undecodable-media download fallback for both video and audio.
 */
_setupVideos(containerEl) {
  containerEl.querySelectorAll('.file-audio').forEach(audio => {
    if (audio.dataset.havenSetup) return;
    audio.dataset.havenSetup = '1';
    audio.addEventListener('error', () => this._fallbackToDownload(audio), { once: true });
  });

  containerEl.querySelectorAll('.file-video').forEach(video => {
    if (video.dataset.havenSetup) return;
    video.dataset.havenSetup = '1';

    // ── Generate thumbnail poster from first frame ──
    this._generateVideoThumbnail(video);

    // Container extension is only a hint at what's inside: a .mov carrying
    // ProRes/HEVC, or an .mp4 with an exotic codec, decodes nowhere. When the
    // element gives up, collapse the whole attachment back to a download link
    // rather than leaving a broken player sitting in the message.
    video.addEventListener('error', () => this._fallbackToDownload(video), { once: true });

    // PiP: wire up MediaSession so the PiP window shows a seek bar
    const updatePos = () => {
      try {
        if (!isNaN(video.duration) && video.duration > 0) {
          navigator.mediaSession.metadata = navigator.mediaSession.metadata
            || new MediaMetadata({ title: 'Haven Video' });
          navigator.mediaSession.setPositionState({
            duration: video.duration,
            position: Math.min(video.currentTime, video.duration),
            playbackRate: video.playbackRate || 1,
          });
        }
      } catch { /* no MediaSession support: the PiP window just has no seek bar */ }
    };
    video.addEventListener('enterpictureinpicture', () => {
      try {
        navigator.mediaSession.playbackState = 'playing';
        navigator.mediaSession.metadata = new MediaMetadata({ title: 'Haven Video' });
        navigator.mediaSession.setActionHandler('seekto', (d) => {
          if (d.seekTime !== undefined) { video.currentTime = d.seekTime; updatePos(); }
        });
        navigator.mediaSession.setActionHandler('seekbackward', (d) => {
          video.currentTime = Math.max(0, video.currentTime - (d.seekOffset || 10)); updatePos();
        });
        navigator.mediaSession.setActionHandler('seekforward', (d) => {
          video.currentTime = Math.min(video.duration, video.currentTime + (d.seekOffset || 10)); updatePos();
        });
        navigator.mediaSession.setActionHandler('play', () => { video.play(); });
        navigator.mediaSession.setActionHandler('pause', () => { video.pause(); });
        video.addEventListener('timeupdate', updatePos);
        video.addEventListener('playing', updatePos);
        updatePos();
      } catch { /* no MediaSession support: the PiP window just has no seek bar */ }
    });
    video.addEventListener('leavepictureinpicture', () => {
      try {
        navigator.mediaSession.setActionHandler('seekto', null);
        navigator.mediaSession.setActionHandler('seekbackward', null);
        navigator.mediaSession.setActionHandler('seekforward', null);
        navigator.mediaSession.setActionHandler('play', null);
        navigator.mediaSession.setActionHandler('pause', null);
        navigator.mediaSession.metadata = null;
      } catch { /* no MediaSession support: the PiP window just has no seek bar */ }
      video.removeEventListener('timeupdate', updatePos);
      video.removeEventListener('playing', updatePos);
    });
  });
},

/**
 * Replace a media element that failed to decode with a plain download link.
 * The extension told us the container looked playable but the codecs inside
 * weren't (ProRes/HEVC .mov being the common case), so the user still gets the
 * file, just not inline. Built with DOM nodes rather than innerHTML because
 * the filename is attacker-controlled.
 */
_fallbackToDownload(mediaEl) {
  const box = mediaEl.closest('.file-attachment');
  if (!box || box.dataset.havenFallback) return;
  box.dataset.havenFallback = '1';

  const url = mediaEl.currentSrc || mediaEl.src;
  if (!url) return;

  // Prefer the real filename off any existing download control; the .file-info
  // label is the fallback, and it's already the name we rendered.
  const name = box.querySelector('.file-download-link[download]')?.getAttribute('download')
    || box.querySelector('.file-name')?.textContent
    || 'file';
  const size = box.querySelector('.file-size')?.textContent || '';
  const isVideo = mediaEl.tagName === 'VIDEO';

  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.className = 'file-download-link';
  link.title = t('app.messages.cannot_play_file', { name });
  if (!url.startsWith('blob:')) { link.target = '_blank'; link.rel = 'noopener noreferrer'; }

  const parts = [
    ['file-icon', isVideo ? '🎬' : '🎵'],
    ['file-name', name],
    ['file-size', size],
    ['file-download-arrow', '⬇'],
  ];
  for (const [cls, text] of parts) {
    if (!text) continue;
    const span = document.createElement('span');
    span.className = cls;
    span.textContent = text;
    link.appendChild(span);
  }

  box.replaceChildren(link);
},

/** Generate a poster thumbnail for a video element by capturing its first visible frame */
_generateVideoThumbnail(video) {
  const src = video.src || video.querySelector('source')?.src;
  if (!src) return;

  // If we already generated a thumbnail for this URL, reuse it
  if (_thumbCache.has(src)) {
    video.poster = _thumbCache.get(src);
    return;
  }

  // Use a hidden helper video so the main element stays preload="none"
  const helper = document.createElement('video');
  helper.crossOrigin = 'anonymous';
  helper.muted = true;
  helper.preload = 'metadata';
  helper.src = src;

  const cleanup = () => {
    helper.removeAttribute('src');
    helper.load();
  };

  helper.addEventListener('loadedmetadata', () => {
    // Seek to 0.5s or 10% of duration (whichever is smaller) to skip black intro frames
    const seekTo = Math.min(0.5, helper.duration * 0.1 || 0.1);
    helper.currentTime = seekTo;
  }, { once: true });

  helper.addEventListener('seeked', () => {
    try {
      const w = helper.videoWidth;
      const h = helper.videoHeight;
      if (!w || !h) { cleanup(); return; }

      // Cap thumbnail at 480p to save memory
      const MAX = 480;
      let tw = w, th = h;
      if (h > MAX) { tw = Math.round(w * (MAX / h)); th = MAX; }

      const canvas = document.createElement('canvas');
      canvas.width = tw;
      canvas.height = th;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(helper, 0, 0, tw, th);

      canvas.toBlob(blob => {
        if (blob) {
          const url = URL.createObjectURL(blob);
          _thumbCache.set(src, url);
          video.poster = url;
        }
        cleanup();
      }, 'image/jpeg', 0.7);
    } catch {
      cleanup();
    }
  }, { once: true });

  helper.addEventListener('error', cleanup, { once: true });

  // Safety timeout: don't hang forever if the video can't be loaded
  setTimeout(() => { if (!_thumbCache.has(src)) cleanup(); }, 8000);
},

// ── Link Previews ─────────────────────────────────────

_fetchLinkPreviews(containerEl) {
  // Per-URL client cache so re-rendering a channel (or scrolling history,
  // or popping out a DM PiP) doesn't re-fetch previews we already have.
  // Without this, opening a chat with N links emits N requests every time
  // the message list is re-rendered, which trips the server's per-IP rate
  // limit and turns most cards into 429s. (#5337)
  //
  // - this._linkPreviewCache: url -> { data, ts }   (10-minute TTL)
  // - this._linkPreviewInflight: url -> Promise<data>  (dedupe concurrent fetches)
  if (!this._collapsedEmbeds) this._collapsedEmbeds = new Set();
  if (!/\bembed-size-/.test(document.body.className)) this._applyEmbedSize(this._embedSize());

  // Thread replies keep their body in .thread-msg-content, and until now no
  // preview card was ever drawn there (#5620).
  const links = containerEl.querySelectorAll('.message-content a[href], .thread-msg-content a[href]');
  const seen = new Set();
  links.forEach(link => {
    const url = link.href;
    if (seen.has(url)) return;
    seen.add(url);
    // Search results defer embeds behind a per-link Load button so a page of
    // 25 results never fires 25 preview fetches. The button clears this flag on
    // the one link it owns, then re-runs this pass. Channel/DM views never set
    // the attribute, so their behaviour is unchanged. (search-overhaul phase 3)
    if (link.dataset.embedDeferred) return;
    // Skip image URLs (already rendered inline) and internal URLs
    if (/\.(jpg|jpeg|png|gif|webp)(\?.*)?$/i.test(url)) return;
    if (/^https:\/\/media\d*\.giphy\.com\//i.test(url)) return;
    if (/^https:\/\/(media|c)\.tenor\.com\//i.test(url)) return;
    if (url.startsWith(window.location.origin)) return;

    // ── Inline YouTube embed (wrapped in the shared embed chrome) ──
    const ytVideoId = this._extractYouTubeVideoId(url);
    if (ytVideoId) {
      // A link to a moment in the video starts the player there (#5728).
      const ytStart = this._extractYouTubeStart(url);
      const msgContent = link.closest('.message-content, .thread-msg-content');
      if (!msgContent) return;
      if (msgContent.querySelector(`.link-preview[data-url="${CSS.escape(url)}"]`)) return;
      const ytCollapsed = this._collapsedEmbeds.has(url);
      const wrapper = document.createElement('div');
      wrapper.className = 'link-preview link-preview--yt' + (ytCollapsed ? ' lp-collapsed' : '');
      wrapper.dataset.url = url;
      wrapper.style.setProperty('--lp-accent', '#ff0000');
      wrapper.innerHTML =
        this._embedHeaderHtml('YouTube', ytCollapsed) +
        // referrerpolicy is set per-iframe on purpose. Haven's document-level
        // Referrer-Policy has defaulted to same-origin since 3.41.0, which
        // sends NOTHING cross-origin. YouTube's embed player treats a missing
        // referrer as a configuration failure and shows "Error 153" instead of
        // the video. strict-origin-when-cross-origin gives it just the origin
        // (scheme + host, no path and no query), which is enough for YouTube
        // and still keeps invite codes out of the referrer, since those live
        // in the query string. That was the whole reason for same-origin.
        `<div class="lp-content"><div class="link-preview-yt"><iframe src="https://www.youtube.com/embed/${this._escapeHtml(ytVideoId)}?rel=0${ytStart ? `&start=${ytStart}` : ''}" width="100%" height="270" frameborder="0" referrerpolicy="strict-origin-when-cross-origin" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen loading="lazy"></iframe></div></div>`;
      this._wireEmbedControls(wrapper, url);
      this._applyEmbedSpoiler(wrapper, link);
      msgContent.appendChild(wrapper);
      if (this._coupledToBottom) this._scrollToBottom(true);
      return; // skip generic link preview for YouTube
    }

    this._linkPreviewData(url)
      .then(data => {
        if (!data || (!data.title && !data.description && !data.text)) return;
        const msgContent = link.closest('.message-content, .thread-msg-content');
        if (!msgContent) return;

        // Don't add duplicate previews
        if (msgContent.querySelector(`.link-preview[data-url="${CSS.escape(url)}"]`)) return;

        // Unified rich embed card: social posts (Bluesky / X) gain an author
        // row, avatar and engagement stats; everything else renders the same
        // chrome (accent header, size toggle, collapse) with title/text/media.
        const collapsed = this._collapsedEmbeds.has(url);
        const accent = (typeof data.accentColor === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(data.accentColor)) ? data.accentColor : null;
        const isSocial = !!(data.author || data.handle);
        const hasGallery = Array.isArray(data.images) && data.images.length >= 2;
        const isInlineVideo = data.video && (data.videoType || /\.(mp4|webm|ogg)(\?[^#]*)?$/i.test(data.video));

        const card = document.createElement('div');
        card.className = 'link-preview link-preview--rich'
          + (isSocial ? ' link-preview--social' : '')
          + (hasGallery ? ' link-preview--gallery' : '')
          + (collapsed ? ' lp-collapsed' : '');
        card.dataset.url = url;
        if (accent) card.style.setProperty('--lp-accent', accent);

        // Author row (social) or title (generic) + post text
        let meta = '';
        if (isSocial) {
          meta += '<div class="lp-author">';
          if (data.avatar) meta += `<img class="lp-avatar" src="${this._escapeHtml(data.avatar)}" alt="" loading="lazy">`;
          if (data.author) meta += `<span class="lp-author-name">${this._escapeHtml(data.author)}</span>`;
          if (data.handle) meta += `<span class="lp-handle">${this._escapeHtml(data.handle)}</span>`;
          meta += '</div>';
        } else if (data.title) {
          meta += `<span class="link-preview-title">${this._escapeHtml(data.title)}</span>`;
        }
        const textContent = data.text || data.description;
        if (textContent) meta += `<span class="lp-text">${this._escapeHtml(textContent)}</span>`;

        // Media: gallery grid, inline player, or image (with play badge if a
        // non-inline video is linked, e.g. a Bluesky video post).
        let media = '';
        if (hasGallery) {
          const count = Math.min(data.images.length, 4);
          media += `<div class="link-preview-gallery" data-count="${count}">`;
          data.images.slice(0, 4).forEach(imgUrl => {
            media += `<img class="link-preview-gallery-img" ${this._imgSrcAttr(imgUrl)} alt="" loading="lazy">`;
          });
          media += '</div>';
        } else if (isInlineVideo) {
          // Video is NOT proxied: streaming it through Haven would need Range
          // support and a lot of bandwidth. Instead the poster comes from the
          // proxy and preload drops to "none" when proxying is on, so the
          // remote host is contacted only if the viewer actually presses play.
          // That turns a silent leak into a deliberate act.
          const vidPreload = (this._mediaProxyEnabled === false) ? 'metadata' : 'none';
          const posterAttr = data.image ? ` poster="${this._escapeHtml(this._proxyMediaUrl(data.image) || '')}"` : '';
          media += `<video class="lp-video" controls preload="${vidPreload}" playsinline${posterAttr}><source src="${this._escapeHtml(data.video)}" type="${this._escapeHtml(data.videoType || 'video/mp4')}"></video>`;
        } else if (data.image) {
          media += `<a class="lp-media" href="${this._escapeHtml(url)}" target="_blank" rel="noopener noreferrer nofollow"><img class="lp-image" ${this._imgSrcAttr(data.image)} alt="" loading="lazy">${data.video ? '<span class="lp-play"></span>' : ''}</a>`;
        }

        // Engagement stats (Bluesky / X); skip any the source didn't provide.
        let stats = '';
        if (data.stats) {
          const parts = [['💬', data.stats.replies], ['🔁', data.stats.reposts], ['❤️', data.stats.likes], ['👁', data.stats.views]]
            .map(([icon, v]) => { const c = this._cnt(v); return c == null ? null : `<span>${icon} ${c}</span>`; })
            .filter(Boolean);
          if (parts.length) stats = `<div class="lp-stats">${parts.join('')}</div>`;
        }

        card.innerHTML =
          this._embedHeaderHtml(data.siteName, collapsed) +
          '<div class="lp-content">' +
            (meta ? `<a class="lp-meta" href="${this._escapeHtml(url)}" target="_blank" rel="noopener noreferrer nofollow">${meta}</a>` : '') +
            media +
            stats +
          '</div>';
        this._wireEmbedControls(card, url);
        this._applyEmbedSpoiler(card, link);

        const wasAtBottom = this._coupledToBottom;
        msgContent.appendChild(card);

        // Scroll if coupled to bottom. Uses the tracked flag rather than
        // a point-in-time scrollHeight check that content-visibility can skew.
        if (wasAtBottom) this._scrollToBottom(true);
      })
      .catch((err) => { console.warn('[Links] could not render the preview card', err); });
  });
},

// The preview data for one link, from the cache, a fetch already on its way,
// or the network, in that order. Shared by the chat cards and the forum topic
// cards (#5745). Resolves to null when there is nothing to show.
_linkPreviewData(url) {
  if (!this._linkPreviewCache) this._linkPreviewCache = new Map();
  if (!this._linkPreviewInflight) this._linkPreviewInflight = new Map();
  const PREVIEW_CLIENT_TTL = 10 * 60 * 1000;
  const fromCache = this._linkPreviewCache.get(url);
  if (fromCache && Date.now() - fromCache.ts < PREVIEW_CLIENT_TTL) return Promise.resolve(fromCache.data);
  if (this._linkPreviewInflight.has(url)) return this._linkPreviewInflight.get(url);
  // Route through the scheduler instead of firing a raw fetch. A channel
  // full of links (e.g. freshly loaded imported history) used to emit one
  // request per link all at once, blow past the server's 60/min limit, and
  // 429 the rest, which returned null and rendered no card, so embeds
  // "sometimes showed, sometimes didn't". The scheduler caps concurrency
  // and retries 429s with backoff so every preview eventually resolves.
  const p = this._scheduleLinkPreview(url)
    .then(data => {
      if (data) this._linkPreviewCache.set(url, { data, ts: Date.now() });
      // Light cap so the cache can't grow unbounded over a long session.
      if (this._linkPreviewCache.size > 500) {
        const firstKey = this._linkPreviewCache.keys().next().value;
        this._linkPreviewCache.delete(firstKey);
      }
      return data;
    })
    .catch((err) => { console.warn('[Links] preview lookup failed', err); return null; })
    .finally(() => { this._linkPreviewInflight.delete(url); });
  this._linkPreviewInflight.set(url, p);
  return p;
},

// ── Link-preview fetch scheduler ──────────────────────────────────────
// Caps how many /api/link-preview requests are in flight at once and retries
// 429s with backoff, so a screen full of links resolves reliably instead of
// stampeding the server's per-IP limit and dropping the overflow. Returns a
// Promise that resolves to the preview data (or null on hard failure).
_scheduleLinkPreview(url) {
  if (!this._lpQueue) this._lpQueue = [];
  if (this._lpActive == null) this._lpActive = 0;
  return new Promise(resolve => {
    this._lpQueue.push({ url, resolve, attempt: 0 });
    this._pumpLinkPreviewQueue();
  });
},

_pumpLinkPreviewQueue() {
  const MAX_CONCURRENT = 3;
  while (this._lpActive < MAX_CONCURRENT && this._lpQueue.length) {
    this._runLinkPreviewTask(this._lpQueue.shift());
  }
},

_runLinkPreviewTask(task) {
  const MAX_ATTEMPTS = 4;
  this._lpActive++;
  const done = (data) => {
    this._lpActive--;
    task.resolve(data);
    this._pumpLinkPreviewQueue();
  };
  fetch(`/api/link-preview?url=${encodeURIComponent(task.url)}`, {
    headers: { 'Authorization': `Bearer ${this.token}` }
  })
    .then(r => {
      // Rate limited: free the slot and re-queue after a backoff so the rest
      // of the batch can proceed. Honour Retry-After when the server sends it,
      // otherwise exponential backoff, both with jitter to avoid a thundering
      // herd when several messages retry at once.
      if (r.status === 429 && task.attempt < MAX_ATTEMPTS) {
        const ra = parseFloat(r.headers.get('retry-after'));
        const waitMs = (Number.isFinite(ra) && ra > 0
          ? ra * 1000
          : Math.min(1200 * Math.pow(2, task.attempt), 8000)) + Math.random() * 400;
        task.attempt++;
        this._lpActive--;
        setTimeout(() => { this._lpQueue.push(task); this._pumpLinkPreviewQueue(); }, waitMs);
        this._pumpLinkPreviewQueue();
        return;
      }
      if (r.ok) r.json().then(done, () => done(null));
      else done(null);
    })
    .catch(() => done(null));
},

// ── Shared embed chrome (size toggle + per-message collapse) ──────────
// Mirrors the Haven mobile app's embed controls. The global Full/Medium/Small/Off
// size preference is the shared one driven by the Settings picker (_embedSize /
// _applyEmbedSize live in app-media.js); the per-card ⤢ button is a quick cycle
// through Full→Medium→Small (Off stays Settings-only so the button can't hide
// itself), and the ▾/▸ caret collapses a single embed for this session.

// A link wrapped in a || spoiler || carries that spoiler onto its embed
// card: the card is blurred behind the same tag used for spoiler images
// until it is clicked to reveal (handled by _maybeRevealConcealed). We read
// the rendered DOM (the <a> sits inside the .spoiler span), so detection
// stays in sync with however the message was marked up (auto-link, masked
// [text](url), YouTube, etc.).
_applyEmbedSpoiler(embedEl, link) {
  if (!link || !link.closest('.spoiler')) return;
  embedEl.classList.add('lp-spoiler');
  const tag = document.createElement('span');
  tag.className = 'spoiler-media-tag';
  tag.textContent = '\u{1F441}\u{FE0F} ' + t('app.messages.spoiler');
  embedEl.appendChild(tag);
},

/** Header row markup: site name (accent), size cycle button, collapse caret. */
_embedHeaderHtml(siteName, collapsed) {
  const size = this._embedSize();
  const label = t(`settings.embed_display.${size}`);
  return '<div class="lp-header">'
    + `<span class="lp-site">${this._escapeHtml(siteName || t('app.messages.link'))}</span>`
    + `<button type="button" class="lp-size" title="${t('app.messages.embed_size_hint')}">⤢ ${label}</button>`
    + `<button type="button" class="lp-collapse" title="${t('app.messages.collapse')}">${collapsed ? '▸' : '▾'}</button>`
    + '</div>';
},

/** Wire the size + collapse buttons on a freshly-built embed card. */
_wireEmbedControls(card, url) {
  const sizeBtn = card.querySelector('.lp-size');
  if (sizeBtn) sizeBtn.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    const order = ['full', 'medium', 'small'];
    this._applyEmbedSize(order[(order.indexOf(this._embedSize()) + 1) % order.length]);
  });
  const colBtn = card.querySelector('.lp-collapse');
  if (colBtn) colBtn.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    const isCol = card.classList.toggle('lp-collapsed');
    isCol ? this._collapsedEmbeds.add(url) : this._collapsedEmbeds.delete(url);
    colBtn.textContent = isCol ? '▸' : '▾';
  });
},

/** Compact engagement count (1.2K / 3.4M); null for missing/negative values. */
_cnt(n) {
  if (n == null || n < 0) return null;
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
},

/**
 * Extract YouTube video ID from various URL formats:
 *   youtube.com/watch?v=ID, youtu.be/ID, youtube.com/embed/ID,
 *   youtube.com/shorts/ID, youtube.com/live/ID, youtube.com/v/ID,
 *   music.youtube.com/watch?v=ID
 */
_extractYouTubeVideoId(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace('www.', '').replace('m.', '');
    // youtu.be/VIDEO_ID
    if (host === 'youtu.be') {
      const id = u.pathname.slice(1).split('/')[0];
      return id && /^[\w-]{11}$/.test(id) ? id : null;
    }
    // youtube.com / music.youtube.com / gaming.youtube.com
    if (host === 'youtube.com' || host === 'music.youtube.com' || host === 'gaming.youtube.com') {
      // /watch?v=ID
      const v = u.searchParams.get('v');
      if (v && /^[\w-]{11}$/.test(v)) return v;
      // /embed/ID, /shorts/ID, /live/ID, /v/ID
      const pathMatch = u.pathname.match(/^\/(?:embed|shorts|live|v)\/([\w-]{11})/);
      if (pathMatch) return pathMatch[1];
    }
  } catch { /* not a valid address, so not a YouTube link */ }
  return null;
},

/** The moment a YouTube link points at, in whole seconds, or 0. Reads t= or
 *  start= from the query or the #fragment, as 90, 90s, 1m30s or 1h2m3s. */
_extractYouTubeStart(url) {
  let u;
  try { u = new URL(url); } catch { return 0; } // not a valid address: no start time
  const hash = new URLSearchParams(u.hash.replace(/^#/, ''));
  const raw = u.searchParams.get('t') || u.searchParams.get('start') || hash.get('t') || hash.get('start') || '';
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/i.exec(raw.trim());
  if (!raw || !m) return 0;
  const secs = (+(m[1] || 0)) * 3600 + (+(m[2] || 0)) * 60 + (+(m[3] || 0));
  return Number.isFinite(secs) && secs > 0 && secs < 86400 * 7 ? secs : 0;
},

};
