// Shared helpers: channel preferences, role colours, pins, burn-after-read,
// picture and link checks, emoji lookups, role mentions, timestamps in the
// reader's time zone, scrolling, toasts and warnings, media tokens and
// sessions, and the prompt and confirm windows.

export default {

// ── Utilities ─────────────────────────────────────────

/** (3.20.2, #5399 follow-up) Mirror a per-channel mute toggle to the
 *  server so sendPushNotifications can skip muted recipients. Fire-and-
 *  forget: localStorage stays the local source of truth and any sync
 *  failure (offline, server old) just leaves the row uncreated. The
 *  initial localStorage→server sync happens in _bootstrapChannelPrefs. */
_syncChannelMutePref(code, muted) {
  if (!code) return;
  const tok = localStorage.getItem('haven_token');
  if (!tok) return;
  fetch('/api/user/channel-prefs/mute', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tok}` },
    body: JSON.stringify({ code, muted: !!muted }),
  }).catch((err) => { console.warn('[Mute] could not save the channel mute to the server', err); });
},

/** One-shot reconciliation between localStorage and the server-side
 *  mute list. Server wins for known codes; any local-only entries get
 *  pushed up via PUT (covers users who had muted channels before this
 *  feature shipped). Idempotent, guarded by `_channelPrefsSynced`. */
async _bootstrapChannelPrefs() {
  if (this._channelPrefsSynced) return;
  const tok = localStorage.getItem('haven_token');
  if (!tok) return;
  this._channelPrefsSynced = true;
  try {
    const resp = await fetch('/api/user/channel-prefs', {
      headers: { 'Authorization': `Bearer ${tok}` },
    });
    if (!resp.ok) { this._channelPrefsSynced = false; return; }
    const { muted: serverMuted = [] } = await resp.json();
    const local = JSON.parse(localStorage.getItem('haven_muted_channels') || '[]');
    const union = Array.from(new Set([...serverMuted, ...local]));
    localStorage.setItem('haven_muted_channels', JSON.stringify(union));
    // If local had entries the server didn't know about, push the union
    // back so the next message blast filters correctly.
    const localOnly = local.filter(c => !serverMuted.includes(c));
    if (localOnly.length) {
      fetch('/api/user/channel-prefs/muted', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tok}` },
        body: JSON.stringify({ codes: union }),
      }).catch((err) => { console.warn('[Mute] could not sync local mutes to the server', err); });
    }
  } catch {
    this._channelPrefsSynced = false;
  }
},

/** Sanitize a CSS color value: only allow hex (#RGB / #RRGGBB), rgb(), hsl(), or CSS variables */
_safeColor(c, fallback = '') {
  if (typeof c !== 'string') return fallback;
  const s = c.trim();
  if (/^#[0-9a-fA-F]{3,6}$/.test(s)) return s;
  if (/^(rgb|hsl)a?\([0-9,\s.%]+\)$/.test(s)) return s;
  if (/^var\(--[a-zA-Z0-9-]+\)$/.test(s)) return s;
  return fallback;
},

// ── Gradient role colors ──
// A role draws names in its color, or as a gradient from `color` to `color2`
// that can slowly shimmer. Role rows carry color / color2 / color_shimmer;
// voice entries carry the same as roleColor / roleColor2 / roleShimmer.

/** The colors a role draws a name with: { c1, c2, shimmer }, c2 null for a
 *  plain color. Null when the role has no usable color. */
_roleLook(role) {
  if (!role) return null;
  const c1 = this._safeColor(role.color !== undefined ? role.color : role.roleColor);
  if (!c1) return null;
  const c2 = this._safeColor(role.color2 !== undefined ? role.color2 : role.roleColor2) || null;
  const shimmer = !!(c2 && (role.color_shimmer || role.roleShimmer));
  return { c1, c2, shimmer };
},

/** A name as HTML in the role's style. A plain color is left to the caller's
 *  own `color:` style, as before; a gradient wraps the text in a span sized to
 *  the text, so the whole gradient shows however wide the row is. */
_roleNameHtml(role, text) {
  const safe = this._escapeHtml(text == null ? '' : String(text));
  const look = this._roleLook(role);
  if (!look || !look.c2) return safe;
  return `<span class="role-gradient${look.shimmer ? ' role-shimmer' : ''}" style="--role-c1:${look.c1};--role-c2:${look.c2}">${this._roleEmojiSafe(safe)}</span>`;
},

/** Emoji inside a gradient name, each run wrapped in its own span so CSS can
 *  draw them in their own colors instead of as gradient silhouettes (#5720).
 *  Takes already escaped HTML: entities are plain ASCII and never match. */
_roleEmojiSafe(safeHtml) {
  return safeHtml.replace(
    /(?:[\u{1F1E6}-\u{1F1FF}]{2}|[0-9#*]\u{FE0F}?\u{20E3}|\p{Extended_Pictographic}[\u{FE0F}\u{1F3FB}-\u{1F3FF}]*(?:\u{200D}\p{Extended_Pictographic}[\u{FE0F}\u{1F3FB}-\u{1F3FF}]*)*)+/gu,
    m => `<span class="role-emoji">${m}</span>`
  );
},

/** The address other people can open this server on, as the server reports
 *  it (an active tunnel, PUBLIC_URL, or the host a proxy forwards), or null
 *  when all it knows is a local address like localhost. Asked at most once a
 *  minute, since a tunnel's address changes when it restarts; the last answer
 *  stays in _shareOriginValue for code that cannot wait. */
_fetchShareOrigin() {
  const now = Date.now();
  if (this._shareOriginPromise && now - this._shareOriginAt < 60000) return this._shareOriginPromise;
  this._shareOriginAt = now;
  this._shareOriginPromise = fetch('/api/connection-address', {
    headers: { Authorization: `Bearer ${this.token || ''}` }
  })
    .then(r => (r.ok ? r.json() : null))
    .then(data => {
      this._shareOriginValue = data && data.url ? String(data.url).replace(/\/+$/, '') : null;
      return this._shareOriginValue;
    })
    .catch(err => {
      console.warn('[Share] could not ask the server for its public address:', err.message);
      return this._shareOriginValue || null;
    });
  return this._shareOriginPromise;
},

/** The origin for links meant for other people (invites, channel links): the
 *  public address once known, otherwise this page's own. */
_shareOrigin() {
  return this._shareOriginValue || window.location.origin;
},

/** The same for an element already on the page: sets its color and puts the
 *  name in it, gradient span included. Null role means no role color. */
_applyRoleName(el, role, text, fallback = '') {
  if (!el) return;
  const look = this._roleLook(role);
  el.style.color = look ? look.c1 : fallback;
  el.innerHTML = this._roleNameHtml(role, text);
},

/** The role that colors a person's name in chat, read from the member lists,
 *  or null when they have none or names are not shown in role colors. */
_chatNameRole(userId) {
  if ((localStorage.getItem('haven-role-display') || 'colored-name') !== 'colored-name') return null;
  const u = this._memberById(userId);
  return u && u.role && this._roleLook(u.role) ? u.role : null;
},

/** A person's entry from the online list, else the channel's member list.
 *  Messages look this up for every author they draw, so the two lists are
 *  indexed once and the index is rebuilt only when either list is replaced,
 *  instead of copying and searching every member for every message. */
_memberById(userId) {
  const online = this._lastOnlineUsers || [];
  const members = this.channelMembers || [];
  const idx = this._memberIndex;
  if (!idx || idx.online !== online || idx.members !== members) {
    const map = new Map();
    for (const u of online) if (u && !map.has(String(u.id))) map.set(String(u.id), u);
    for (const u of members) if (u && !map.has(String(u.id))) map.set(String(u.id), u);
    this._memberIndex = { online, members, map };
  }
  return this._memberIndex.map.get(String(userId)) || null;
},

/** A background (dot, swatch) in the role's colors: the gradient when it has
 *  one, else its color, else `fallback`. */
_roleFill(role, fallback = '') {
  const look = this._roleLook(role);
  if (!look) return fallback;
  return look.c2 ? `linear-gradient(90deg, ${look.c1}, ${look.c2})` : look.c1;
},

/**
 * Toggle a small dot on the 📌 pinned-toggle button when the active channel
 * has UNREAD pinned messages. Read-receipt model:
 *   - localStorage `haven_seen_pin_max_<code>` stores the highest pin id
 *     the user has acknowledged (i.e. opened the pinned panel and seen).
 *   - If no record exists yet and the channel has pins, treat them as
 *     unread (one-time prompt to open the panel after a fresh install).
 *   - If the record is set, the dot only appears when a newer pin arrives.
 * Count-aware so we can also bump live on pin/unpin events without
 * re-fetching from the server.
 */
_pinSeenKey(code) { return `haven_seen_pin_max_${code}`; },
_getMaxSeenPinId(code) {
  try {
    const raw = localStorage.getItem(this._pinSeenKey(code));
    if (raw == null) return null;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
},
_setMaxSeenPinId(code, id) {
  try {
    const cur = this._getMaxSeenPinId(code) || 0;
    if ((id | 0) > cur) localStorage.setItem(this._pinSeenKey(code), String(id | 0));
  } catch { /* storage blocked (private mode): nothing is remembered, nothing else breaks */ }
},

_updatePinIndicator(count) {
  const btn = document.getElementById('pinned-toggle-btn');
  if (!btn) return;
  const n = Math.max(0, count | 0);
  this._pinnedCountByChannel = this._pinnedCountByChannel || {};
  this._unreadPinIdByChannel = this._unreadPinIdByChannel || {};
  if (this.currentChannel) this._pinnedCountByChannel[this.currentChannel] = n;
  btn.dataset.pinCount = String(n);

  let unread = false;
  if (n > 0 && this.currentChannel) {
    const seen = this._getMaxSeenPinId(this.currentChannel);
    const liveUnread = this._unreadPinIdByChannel[this.currentChannel] || 0;
    if (seen == null) {
      // First encounter: user has never opened the pinned panel for this
      // channel; surface the dot once so they know there's something there.
      unread = true;
    } else if (liveUnread > seen) {
      unread = true;
    }
  }
  btn.classList.toggle('has-pins', unread);
},

_markPinUnread(messageId) {
  if (!this.currentChannel || !messageId) return;
  this._unreadPinIdByChannel = this._unreadPinIdByChannel || {};
  const cur = this._unreadPinIdByChannel[this.currentChannel] || 0;
  if ((messageId | 0) > cur) this._unreadPinIdByChannel[this.currentChannel] = messageId | 0;
},

_markPinsSeen(pins) {
  if (!this.currentChannel || !Array.isArray(pins)) return;
  let max = 0;
  for (const p of pins) {
    const id = (p && p.id) | 0;
    if (id > max) max = id;
  }
  if (max > 0) this._setMaxSeenPinId(this.currentChannel, max);
  // Clear the live-unread tracker for this channel; they've seen everything.
  this._unreadPinIdByChannel = this._unreadPinIdByChannel || {};
  this._unreadPinIdByChannel[this.currentChannel] = 0;
  this._updatePinIndicator(this._pinnedCountByChannel?.[this.currentChannel] || pins.length);
},

_bumpPinIndicator(delta) {
  if (!this.currentChannel) return;
  this._pinnedCountByChannel = this._pinnedCountByChannel || {};
  const cur = this._pinnedCountByChannel[this.currentChannel] || 0;
  this._updatePinIndicator(Math.max(0, cur + (delta | 0)));
},

// (#5280) Burn-after-read DMs. Walks any message rows in `root` whose
// `data-burn-seconds` is set and either replaces the content with a
// click-to-reveal placeholder (not yet started) or wires the countdown
// (already started, `data-burn-started-at` is set). When the user
// clicks reveal, emits `mark-burning` so the server stamps the start
// time and broadcasts `message-burning` to keep the timer in sync
// across both participants. The actual destructive delete fires from
// the server's periodic sweep. This is just the UI layer.
_wireBurnMessages(root) {
  if (!root) root = document.getElementById('messages');
  if (!root) return;
  // querySelectorAll only matches descendants - if `root` is itself a
  // single newly-appended message (the common case from `_appendMessage`),
  // its own `.message-burn-pending` class is never picked up. That meant
  // for every burn DM the sender saw no flame indicator and the recipient
  // never got the click-to-reveal button, so `mark-burning` never fired
  // and the server sweep never had a `burning_started_at` to count from.
  // Result: burn messages just sat there forever. Process the root too.
  const rows = Array.from(root.querySelectorAll('.message-burn-pending:not([data-burn-wired])'));
  if (root.classList && root.classList.contains('message-burn-pending') && !root.dataset.burnWired) {
    rows.unshift(root);
  }
  rows.forEach(el => {
    el.dataset.burnWired = '1';
    const burnSeconds = parseInt(el.dataset.burnSeconds) || 0;
    const startedAt = el.dataset.burnStartedAt || '';
    const messageId = parseInt(el.dataset.msgId) || 0;
    if (!burnSeconds || !messageId) return;
    // Always attach a row-level flame label so the burn status is visible at a glance
    if (!el.querySelector('.burn-pending-label')) {
      const label = document.createElement('span');
      label.className = 'burn-pending-label';
      label.title = t('messages.burn_pending_tooltip', { seconds: burnSeconds });
      label.textContent = '🔥';
      // Attach burn status to the message's own inline status slot so the
      // flame stays visually attached to that row instead of forming a
      // shared gutter down the right side of the chat pane.
      const statusSlot = el.querySelector('.message-inline-status');
      if (statusSlot) {
        statusSlot.append(label);
      } else {
        const msgHeader = el.querySelector('.message-header');
        if (msgHeader) {
          msgHeader.append(label);
        } else {
          const content = el.querySelector('.message-content');
          if (content) content.append(label);
        }
      }
    }
    if (startedAt) {
      this._startBurnCountdown(el, burnSeconds, startedAt);
      return;
    }
    // Sender's own burn message: show content normally, since they already know
    // what they wrote. Starting the burn timer is the recipient's action.
    const isSender = parseInt(el.dataset.userId) === (this.user?.id || 0);
    if (isSender) return;
    const content = el.querySelector('.message-content');
    if (!content) return;
    const real = content.innerHTML;
    el.dataset.burnRealContent = real;
    const revealText = t('messages.burn_reveal');
    content.innerHTML = `<button type="button" class="burn-reveal-btn">🔥 ${this._escapeHtml(revealText)} <span class="muted-text">${t('messages.burn_reveal_hint', { seconds: burnSeconds })}</span></button>`;
    const btn = content.querySelector('.burn-reveal-btn');
    btn.addEventListener('click', () => {
      content.innerHTML = el.dataset.burnRealContent || '';
      // In a PiP DM the main pane is on a different channel, so currentChannel
      // is wrong. Resolve the channel code from the element's container.
      const pipList = document.getElementById('dm-pip-messages');
      const burnCode = (pipList && pipList.contains(el))
        ? (this._activeDMPip || this.currentChannel)
        : this.currentChannel;
      this.socket.emit('mark-burning', { code: burnCode, messageId });
      this._startBurnCountdown(el, burnSeconds, new Date().toISOString());
    }, { once: true });
  });
},

_startBurnCountdown(el, burnSeconds, startedAtIso) {
  const started = Date.parse(startedAtIso);
  if (!Number.isFinite(started)) return;
  if (el._burnTimer) clearInterval(el._burnTimer);
  const tick = () => {
    const left = Math.max(0, Math.ceil((started + burnSeconds * 1000 - Date.now()) / 1000));
    let pill = el.querySelector('.burn-countdown-pill');
    if (!pill) {
      pill = document.createElement('span');
      pill.className = 'burn-countdown-pill';
      pill.style.cssText = 'margin-left:6px;font-size:0.75em;opacity:0.7';
      const head = el.querySelector('.message-content');
      if (head) head.prepend(pill);
    }
    pill.textContent = `🔥 ${left}s`;
    if (left <= 0) { clearInterval(el._burnTimer); el._burnTimer = null; }
  };
  tick();
  el._burnTimer = setInterval(tick, 1000);
},

_replaceBurnedMessage(el) {
  if (!el) return;
  if (el._burnTimer) { clearInterval(el._burnTimer); el._burnTimer = null; }
  const content = el.querySelector('.message-content');
  if (!content) return;
  const doneText = t('messages.burn_done');
  content.innerHTML = `<span class="muted-text burn-complete-label" style="font-style:italic">🔥 ${this._escapeHtml(doneText)}</span>`;
  el.classList.remove('message-burn-pending');
  el.classList.add('message-burned');
},

_isImageUrl(str) {
  if (!str) return false;
  const trimmed = str.trim();
  // Spoiler-wrapped image (sender marked it as a spoiler): unwrap and test
  // the payload so the message still gets image layout treatment.
  if (trimmed.startsWith('spoiler-img:')) return this._isImageUrl(trimmed.slice(12));
  if (trimmed.startsWith('e2e-img:')) return true;
  // Optional extra path segment (stickers/, images/, …) and dots in the
  // basename. Must stay in lockstep with the early-return regex in
  // `_formatContent` or classified-as-image messages render as empty.
  if (/^\/uploads\/(?:[\w\-]+\/)?[\w\-.]+\.(jpg|jpeg|png|gif|webp|svg)$/i.test(trimmed)) return true;
  // The query part stops at whitespace: two Discord CDN links on separate
  // lines used to match as one URL, which drew one broken image for the pair.
  if (/^https?:\/\/.+\.(jpg|jpeg|png|gif|webp|svg)(\?[^"'<>\s]*)?$/i.test(trimmed)) return true;
  // GIPHY / Tenor GIF URLs (may not have file extensions)
  if (/^https:\/\/media\d*\.giphy\.com\/.+/i.test(trimmed)) return true;
  if (/^https:\/\/(media|c)\.tenor\.com\/.+/i.test(trimmed)) return true;
  return false;
},

// Auto-link and markdown image handlers run after `_escapeHtml`, so query
// strings arrive as `?ex=…&amp;is=…`. Feed those straight to the media proxy
// and Discord (Ferry attachments) 404s. The phone client never HTML-escapes
// the URL, which is why the same photo shows on mobile and vanishes on desktop.
_rawHttpUrl(escapedOrRaw) {
  if (typeof escapedOrRaw !== 'string' || !escapedOrRaw) return null;
  const decoded = this._decodeHtmlEntities(escapedOrRaw).replace(/['"<>]/g, '');
  try { new URL(decoded); } catch { return null; }
  return decoded;
},

_isRemoteImageUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  return /\.(jpg|jpeg|png|gif|webp)(\?[^"'<>]*)?$/i.test(url) ||
    /^https:\/\/media\d*\.giphy\.com\//i.test(url) ||
    /^https:\/\/(media|c)\.tenor\.com\//i.test(url);
},

// Extract /uploads/<file> attachment paths from a (decrypted) message's
// content. Used when emitting delete-message so the server can clean up
// E2E DM attachments whose URL is hidden inside the ciphertext.
_getMessageAttachments(messageId) {
  if (!messageId) return [];
  // Messages that arrived live are appended straight to the DOM and never
  // land in _lastRenderedMessages, which only holds the last full render.
  // So an image you just posted in a DM had no URLs to hand the server, and
  // deleting it left the file on disk forever. The hint map below is filled
  // at decrypt time and covers exactly that gap. (#5487)
  const hinted = this._dmAttachmentHints && this._dmAttachmentHints.get(messageId);
  if (hinted && hinted.length) return hinted.slice();
  const msgs = this._lastRenderedMessages || [];
  const msg = msgs.find(m => m && m.id === messageId);
  if (msg && typeof msg.content === 'string') {
    const urls = this._extractUploadUrls(msg.content);
    if (urls.length) return urls;
  }
  // A message just sent or received is appended live to the DOM and never lands
  // in _lastRenderedMessages, so its attachments were invisible here until a
  // full re-render (which is why the retroactive "Edit tags" entry only showed
  // after a refresh or channel switch). Fall back to the rendered content in the
  // DOM, scoped to .message-content so an author avatar is not counted.
  const el = document.querySelector(`#messages [data-msg-id="${messageId}"]`);
  if (el) {
    const body = el.querySelector('.message-content') || el;
    return this._extractUploadUrls(body.innerHTML);
  }
  return [];
},

_extractUploadUrls(content) {
  if (typeof content !== 'string' || !content) return [];
  const out = [];
  const re = /\/uploads\/((?!deleted-attachments)[\w\-.]+)/g;
  let m;
  while ((m = re.exec(content)) !== null) out.push('/uploads/' + m[1]);
  return out;
},

// Remember which uploads a decrypted DM message points at, so a later delete
// can tell the server which files to clean up. Only DM messages need this;
// everywhere else the server reads the URLs straight out of the stored
// content. Capped so a long session can't grow it without bound. (#5487)
_rememberDmAttachments(message) {
  if (!message || !message.id || typeof message.content !== 'string') return;
  const urls = this._extractUploadUrls(message.content);
  if (!urls.length) return;
  if (!(this._dmAttachmentHints instanceof Map)) this._dmAttachmentHints = new Map();
  this._dmAttachmentHints.set(message.id, urls);
  const MAX_HINTS = 500;
  while (this._dmAttachmentHints.size > MAX_HINTS) {
    this._dmAttachmentHints.delete(this._dmAttachmentHints.keys().next().value);
  }
},

// Client-side DM message search: walks _lastRenderedMessages (already
// decrypted) and hands matches to the search panel. DMs are E2E-encrypted so
// the server never sees plaintext; each DM keeps its own panel context. (#5248)
_searchDmCacheLocally(query) {
  const q = query.toLowerCase();
  // Newest-first so the most recent matches appear at the top
  const msgs = (this._lastRenderedMessages || []).slice().reverse();
  const matches = msgs
    .filter(m => m && typeof m.content === 'string' && m.content.toLowerCase().includes(q))
    .slice(0, 50);

  this._searchReceiveResults(`dm:${this.currentChannel}`, { results: matches, query, isDM: true });
},

_highlightSearch(escapedHtml, query) {
  if (!query) return escapedHtml;
  const safeQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return escapedHtml.replace(new RegExp(`(${safeQuery})`, 'gi'), '<mark>$1</mark>');
},

// Returns true when the raw message consists only of emoji
// (Unicode emoji and/or :custom: tokens) plus optional whitespace.
// Capped at 27 to avoid jumbo-sizing a wall of emoji.
_isEmojiOnly(str) {
  if (!str || !str.trim()) return false;
  // A Discord emote token counts as one emoji, like a resolved :name: does.
  const discordEmotes = (str.match(/<a?:[A-Za-z0-9_]{2,32}:\d{15,25}>/g) || []).length;
  str = str.replace(/<a?:[A-Za-z0-9_]{2,32}:\d{15,25}>/g, ' ');
  const customMatches = str.match(/:([a-zA-Z0-9_-]+):/g) || [];
  // Only expand custom tokens that actually exist as loaded emojis
  const resolvedCustom = customMatches.filter(m => {
    const name = m.slice(1, -1).toLowerCase();
    return !!this._findNamedEmoji(name);
  });
  let s = str.replace(/:([a-zA-Z0-9_-]+):/g, ' ');
  try {
    // Strip unicode emoji, skin-tone modifiers, ZWJ, variation selectors, flags.
    // Skin tones (1F3FB-1F3FF) are Emoji_Modifier, not Extended_Pictographic, so
    // they need their own range or a toned emoji leaves a leftover and misses jumbo.
    s = s.replace(/[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\u{FE00}-\u{FEFF}\u{200D}\u{20E3}\u{1F1E0}-\u{1F1FF}]/gu, '');
  } catch {
    s = s.replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE00}-\u{FEFF}\u{200D}\u{20E3}]/gu, '');
  }
  if (s.trim().length > 0) return false;
  let unicodeCount = 0;
  try { unicodeCount = (str.match(/[\p{Extended_Pictographic}]/gu) || []).length; } catch { /* no Unicode property escapes in this browser: count only custom emoji */ }
  const total = resolvedCustom.length + unicodeCount + discordEmotes;
  return total >= 1 && total <= 27;
},

// Markup for one Discord emote token. Haven's own emoji of that name is
// preferred so a server carrying the same set shows its copy; the fallback is
// the server-side emote cache, and a failed load turns back into the :name:
// text (the capture-phase error listener in app-ui.js does that).
_discordEmoteHtml(name, id, animated) {
  const label = this._escapeHtml(`:${name}:`);
  const own = this._findNamedEmoji(name);
  if (own) return `<img src="${this._escapeHtml(own.url)}" alt="${label}" title="${label}" class="custom-emoji">`;
  return `<img src="/api/ferry/emote/${id}.${animated ? 'gif' : 'png'}" alt="${label}" title="${label}" class="custom-emoji discord-emote">`;
},

// Resolve a `:name:` shortcode to an image emoji. Checks the bundled
// built-in image emoji (US flags, etc.) first, then server custom emoji.
// Returns { name, url } or null.
_findNamedEmoji(name) {
  if (!name) return null;
  const lower = String(name).toLowerCase();
  return (this.builtinEmojis && this.builtinEmojis.find(e => e.name === lower))
      || (this.customEmojis && this.customEmojis.find(e => e.name === lower))
      || null;
},

// Punctuation search aliases: typing an actual punctuation mark (e.g. "?"
// or "!") should surface the matching punctuation emojis, whose keywords
// are stored as words ("question", "exclamation"). Cached after first use.
_getEmojiPunctAliases() {
  if (this._emojiPunctAliases) return this._emojiPunctAliases;
  this._emojiPunctAliases = {
    '?': 'question', '!': 'exclamation bang', ',': 'comma', '.': 'period dot',
    ';': 'semicolon', ':': 'colon', '#': 'hash number pound', '*': 'asterisk star',
    '+': 'plus add', '-': 'minus dash subtract', '=': 'equal', '/': 'slash divide',
    '%': 'percent', '$': 'dollar money', '&': 'ampersand and', '@': 'at mention',
    '^': 'caret up', '~': 'tilde', '<': 'less than left', '>': 'greater than right',
    '(': 'parenthesis bracket', ')': 'parenthesis bracket',
    '"': 'quote quotation', "'": 'apostrophe quote',
    '©': 'copyright', '®': 'registered', '™': 'trademark', '∞': 'infinity',
  };
  return this._emojiPunctAliases;
},

// Shared emoji search matcher used by the emoji picker and reaction picker.
// Matches on keyword substrings, the literal emoji character (so typing an
// actual "?", "#", or a digit surfaces the matching emoji), and punctuation
// aliases (typing "?" surfaces ❓ ⁉️ etc.).
_emojiSearchMatch(emoji, keywords, rawQuery) {
  const raw = (rawQuery || '').trim();
  const q = raw.toLowerCase();
  if (!q) return true;
  const kw = (keywords || '').toLowerCase();
  if (kw.includes(q)) return true;
  if (typeof emoji === 'string' && raw && emoji.includes(raw)) return true;
  const alias = this._getEmojiPunctAliases()[q];
  if (alias && alias.split(/\s+/).some(w => kw.includes(w))) return true;
  return false;
},

// ── Role mentions (#5579) ──
// "@Moderators" lights up for everyone holding the role and pings them,
// unless they have turned role pings off. Sending one needs the same
// permission as @everyone, which the server enforces.

/** Fetch the server's roles for rendering and the @ picker. Re-run whenever
 *  the server says its roles changed. */
_refreshMentionableRoles() {
  if (!this.socket) return;
  try {
    this.socket.emit('get-roles', null, (res) => {
      const roles = res && Array.isArray(res.roles) ? res.roles : [];
      this._mentionableRoles = roles
        .filter(r => r && r.name)
        .map(r => ({ id: r.id, name: String(r.name), color: r.color || null, color2: r.color2 || null, color_shimmer: r.color_shimmer || 0, level: r.level }));
    });
  } catch { /* offline: keep whatever we had */ }
},

/** True when `content` pings a role the viewer holds and role pings are on. */
_mentionsMyRole(content) {
  if (!content || (this.notifications && this.notifications.roleMentionsEnabled === false)) return false;
  const mine = (this.user && Array.isArray(this.user.roles)) ? this.user.roles : [];
  if (!mine.length) return false;
  const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return mine.some(r => r && r.name && new RegExp(`(?<![\\w@])@${esc(r.name)}(?!\\w)`, 'i').test(content));
},

// ── Timestamps that follow the reader (<t:1780853820:R>) ──
// One instant in the message, rendered in whatever timezone and locale the
// person reading it is in, which is the whole point for scheduling across a
// group. The syntax is deliberately Discord's: tokens survive a round trip
// through Ferry in both directions, and the generators people already use
// keep working.

/** Locale for date formatting: the reader's own regional locale when it speaks
 *  the language Haven is set to (so en-GB keeps day/month order), else the
 *  Haven language, else whatever the browser prefers. */
_timeLocale() {
  const ui = String((typeof document !== 'undefined' && document.documentElement && document.documentElement.lang) || '').toLowerCase();
  const browser = (typeof navigator !== 'undefined' && Array.isArray(navigator.languages)) ? navigator.languages : [];
  if (!ui) return browser[0] || undefined;
  const base = ui.split('-')[0];
  return browser.find(l => String(l).toLowerCase().split('-')[0] === base) || ui;
},

/** The reader's confirmed IANA timezone, or undefined to let the browser use
 *  the device zone. Only a value the user actively confirmed counts; Skip and
 *  "Remind later" leave this unset so nothing changes from Haven's old
 *  browser-default behaviour. Passing an IANA id to Intl means DST and any
 *  historical offset change are resolved per-instant, never a frozen offset. */
_userTimeZone() {
  const tz = this._userPrefs && this._userPrefs.timezone;
  if (typeof tz !== 'string' || !tz) return undefined;
  // A zone this browser does not know (a newer zone name on an older engine,
  // or a stray value) would make every Intl call throw and take the message
  // list with it. Check it once per value and fall back to the browser's own
  // zone when it is unknown.
  if (this._tzCheckedValue !== tz) {
    this._tzCheckedValue = tz;
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); this._tzCheckedOk = true; }
    catch { this._tzCheckedOk = false; }
  }
  return this._tzCheckedOk ? tz : undefined;
},

/** The reader's confirmed hour cycle as an Intl `hour12` value: true for 12h,
 *  false for 24h, undefined to keep the locale's own default. */
_userHour12() {
  const f = this._userPrefs && this._userPrefs.time_format;
  if (f === '12') return true;
  if (f === '24') return false;
  return undefined;
},

/** Merge the reader's persisted timezone + hour cycle into a set of
 *  Intl.DateTimeFormat options. Both `timeZone` and `hour12` are legal
 *  alongside dateStyle/timeStyle as well as explicit component options, so
 *  every existing call site can route through here unchanged. */
_dtOpts(opts) {
  const out = Object.assign({}, opts);
  const tz = this._userTimeZone();
  if (tz && out.timeZone === undefined) out.timeZone = tz;
  const h12 = this._userHour12();
  if (h12 !== undefined && out.hour12 === undefined && out.hourCycle === undefined) out.hour12 = h12;
  return out;
},

/** Central time/date formatters. All timestamp rendering across the app goes
 *  through these so a confirmed timezone/format applies everywhere at once and
 *  an unset preference falls back to exactly what the browser did before.
 *  `locale` defaults to the browser default (what every call site used before);
 *  the <t:> token formatter passes _timeLocale() to keep its own behaviour. */
_fmtTime(value, opts = { hour: '2-digit', minute: '2-digit' }, locale) {
  const d = (value instanceof Date) ? value : new Date(value);
  return d.toLocaleTimeString(locale, this._dtOpts(opts));
},
_fmtDate(value, opts = {}, locale) {
  const d = (value instanceof Date) ? value : new Date(value);
  return d.toLocaleDateString(locale, this._dtOpts(opts));
},
_fmtDateTime(value, opts = {}, locale) {
  const d = (value instanceof Date) ? value : new Date(value);
  return d.toLocaleString(locale, this._dtOpts(opts));
},

// ── Wall-clock <-> instant in the reader's confirmed zone ───────────────
// The formatters above render an instant; these go the other way, for the
// features that let someone type a wall-clock time (the /time command and its
// modal). With no timezone confirmed they fall back to the device zone, so the
// behaviour is unchanged; with one set the entered time is anchored to that
// zone instead of whatever the browser reports, which is the whole point on a
// privacy browser that lies about the system clock.

/** The wall-clock parts of an instant in the confirmed zone (or the device
 *  zone when none is set). monthIndex is 0-based to match the Date API. */
_zonedParts(date, tz = this._userTimeZone()) {
  const d = (date instanceof Date) ? date : new Date(date);
  if (!tz) {
    return { year: d.getFullYear(), monthIndex: d.getMonth(), day: d.getDate(),
             hour: d.getHours(), minute: d.getMinutes(), second: d.getSeconds() };
  }
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(d);
  const m = {};
  for (const p of parts) if (p.type !== 'literal') m[p.type] = p.value;
  let hour = Number(m.hour);
  if (hour === 24) hour = 0; // some engines report midnight as 24
  return { year: Number(m.year), monthIndex: Number(m.month) - 1, day: Number(m.day),
           hour, minute: Number(m.minute), second: Number(m.second) };
},

/** Milliseconds that `tz` is ahead of UTC at instant `ts` (negative if behind). */
_zoneOffsetMs(tz, ts) {
  const p = this._zonedParts(new Date(ts), tz);
  const asUTC = Date.UTC(p.year, p.monthIndex, p.day, p.hour, p.minute, p.second);
  return asUTC - ts;
},

/** Turn a wall-clock (year, 0-based month, day, hour, minute, second) read in
 *  the confirmed zone into the matching instant. With no zone set this is
 *  exactly new Date(y, mo, d, ...) in the device zone, so the fallback path is
 *  byte-for-byte the old behaviour. */
_wallToInstant(y, moIndex, d, h, mi, s, tz = this._userTimeZone()) {
  if (!tz) return new Date(y, moIndex, d, h, mi, s, 0);
  const naive = Date.UTC(y, moIndex, d, h, mi, s);
  // One correction, then a second pass so a DST boundary resolves correctly.
  let inst = naive - this._zoneOffsetMs(tz, naive);
  inst = naive - this._zoneOffsetMs(tz, inst);
  return new Date(inst);
},

/** "Now" decomposed into the confirmed zone's wall-clock, for seeding pickers. */
_nowZonedParts() {
  return this._zonedParts(new Date());
},

/** "in 5 minutes" / "3 hours ago", in the largest unit that still reads well. */
_relativeTimestamp(ms, locale) {
  const diff = ms - Date.now();
  const abs = Math.abs(diff);
  const MIN = 60000, HOUR = 3600000, DAY = 86400000;
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (abs < MIN)       return rtf.format(Math.round(diff / 1000), 'second');
  if (abs < HOUR)      return rtf.format(Math.round(diff / MIN), 'minute');
  if (abs < DAY)       return rtf.format(Math.round(diff / HOUR), 'hour');
  if (abs < 30 * DAY)  return rtf.format(Math.round(diff / DAY), 'day');
  if (abs < 365 * DAY) return rtf.format(Math.round(diff / (30 * DAY)), 'month');
  return rtf.format(Math.round(diff / (365 * DAY)), 'year');
},

/** Render one <t:...> token to HTML, or null when it is not a usable instant
 *  (in which case the caller leaves the raw text alone). */
_formatTimestampToken(seconds, style = 'f') {
  if (!Number.isFinite(seconds)) return null;
  const date = new Date(seconds * 1000);
  if (Number.isNaN(date.getTime())) return null;
  const locale = this._timeLocale();
  let text;
  try {
    switch (style) {
      case 't': text = this._fmtTime(date, { timeStyle: 'short' }, locale); break;
      case 'T': text = this._fmtTime(date, { timeStyle: 'medium' }, locale); break;
      case 'd': text = this._fmtDate(date, { dateStyle: 'short' }, locale); break;
      case 'D': text = this._fmtDate(date, { dateStyle: 'long' }, locale); break;
      case 'F': text = this._fmtDateTime(date, { dateStyle: 'full', timeStyle: 'short' }, locale); break;
      case 'R': text = this._relativeTimestamp(date.getTime(), locale); break;
      default:  text = this._fmtDateTime(date, { dateStyle: 'long', timeStyle: 'short' }, locale); break;
    }
  } catch { return null; }
  // The hover title always spells the instant out in full, so a relative or
  // time-only token can still be pinned down without asking the sender.
  let title = text;
  try { title = this._fmtDateTime(date, { dateStyle: 'full', timeStyle: 'long' }, locale); } catch { /* keep the visible text */ }
  if (style === 'R') this._startTimestampTicker();
  return `<time class="chat-timestamp" datetime="${this._escapeHtml(date.toISOString())}" data-ts="${Math.trunc(seconds)}" data-tstyle="${this._escapeHtml(style)}" title="${this._escapeHtml(title)}">${this._escapeHtml(text)}</time>`;
},

/** Keep rendered relative timestamps honest without re-rendering messages.
 *  Started on first use, so a server whose chat has none never runs a timer. */
_startTimestampTicker() {
  if (this._timestampTicker || typeof document === 'undefined') return;
  this._timestampTicker = setInterval(() => {
    const nodes = document.querySelectorAll('time.chat-timestamp[data-tstyle="R"]');
    if (!nodes.length) return;
    const locale = this._timeLocale();
    nodes.forEach(el => {
      const secs = Number(el.dataset.ts);
      if (!Number.isFinite(secs)) return;
      const next = this._relativeTimestamp(secs * 1000, locale);
      if (next && el.textContent !== next) el.textContent = next;
    });
  }, 30000);
},

/** Turn what someone typed after /time into a token, or null if it makes no
 *  sense. Everything is read in the sender's own timezone, which is the
 *  natural thing: you type your time, everyone else sees theirs. */
_parseTimeExpression(input, now = new Date()) {
  let text = String(input == null ? '' : input).trim();
  if (!text) return null;

  // Optional trailing style letter: "8pm R".
  let style = null;
  const styled = text.match(/\s+([tTdDfFR])$/);
  if (styled) { style = styled[1]; text = text.slice(0, styled.index).trim(); }
  if (!text) return null;

  // Raw unix seconds pass straight through.
  if (/^\d{9,12}$/.test(text)) return { seconds: Number(text), style: style || 'f' };

  // An offset from now: +90m, 2h, +3d, 1w.
  const offset = text.match(/^\+?(\d{1,5})\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks)$/i);
  if (offset) {
    const unit = offset[2].toLowerCase();
    const ms = unit.startsWith('w') ? 604800000 : unit.startsWith('d') ? 86400000 : unit.startsWith('h') ? 3600000 : 60000;
    return { seconds: Math.round((now.getTime() + Number(offset[1]) * ms) / 1000), style: style || 'f' };
  }

  // Optional leading day word, then an optional explicit date.
  let dayShift = null;
  const dayWord = text.match(/^(today|tomorrow)\b\s*/i);
  if (dayWord) { dayShift = dayWord[1].toLowerCase() === 'tomorrow' ? 1 : 0; text = text.slice(dayWord[0].length).trim(); }
  let ymd = null;
  const dateMatch = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})\b\s*/);
  if (dateMatch) { ymd = dateMatch; text = text.slice(dateMatch[0].length).trim(); }

  // The remainder, if any, is a clock time: 8, 8:30, 8pm, 8:30 pm, 20:30.
  let hh = null, mi = 0;
  if (text) {
    const tm = text.match(/^(\d{1,2})(?::([0-5]\d))?\s*(?:([ap])\.?m\.?)?$/i);
    if (!tm) return null;
    hh = Number(tm[1]);
    mi = tm[2] ? Number(tm[2]) : 0;
    const meridiem = tm[3] ? tm[3].toLowerCase() : null;
    if (meridiem) {
      if (hh < 1 || hh > 12) return null;
      hh = (hh % 12) + (meridiem === 'p' ? 12 : 0);
    } else if (hh > 23) return null;
  } else if (ymd === null && dayShift === null) {
    return null;
  }

  // A date with no clock time is a date, so show it as one unless told otherwise.
  const resolved = style || (hh === null ? 'D' : 'f');
  const hour = hh === null ? 0 : hh;

  let when;
  if (ymd) {
    const y = Number(ymd[1]), mo = Number(ymd[2]) - 1, d = Number(ymd[3]);
    when = this._wallToInstant(y, mo, d, hour, mi, 0);
    // Reject dates that do not exist (JS rolls 2026-02-31 into March), checked
    // in the same zone the wall-clock was read in.
    const back = this._zonedParts(when);
    if (back.year !== y || back.monthIndex !== mo || back.day !== d) return null;
  } else {
    const nowP = this._zonedParts(now);
    when = this._wallToInstant(nowP.year, nowP.monthIndex, nowP.day + (dayShift || 0), hour, mi, 0);
    // A bare time that already went by today means the next one. Someone
    // saying "8pm" at nine in the evening is scheduling, not reminiscing.
    if (dayShift === null && when.getTime() <= now.getTime()) when = new Date(when.getTime() + 86400000);
  }
  if (Number.isNaN(when.getTime())) return null;
  return { seconds: Math.round(when.getTime() / 1000), style: resolved };
},

/** `/time 8pm` → `<t:1780853820:f>` */
_buildTimeToken(arg, now = new Date()) {
  const parsed = this._parseTimeExpression(arg, now);
  return parsed ? `<t:${parsed.seconds}:${parsed.style}>` : null;
},

// "1:05" for a voice-message-1m05s.weba name, "" for a voice message with
// no length in its name, null for any other file (#5665).
_voiceMessageLength(name) {
  if (!/^voice-message/i.test(String(name || ''))) return null;
  const m = String(name).match(/(\d+)m(\d+)s/);
  return m ? `${Number(m[1])}:${String(m[2]).padStart(2, '0')}` : '';
},

// "Today at 9 PM" is only true until midnight, and a label is written once.
// An app left open overnight kept calling last night's messages Today, so
// every label carries its timestamp (data-ftime) and is rewritten when the
// calendar day changes.
_timeAttr(dateStr) {
  return ` data-ftime="${this._escapeHtml(String(dateStr ?? ''))}"`;
},

_refreshTimeLabels() {
  document.querySelectorAll('[data-ftime]').forEach(el => {
    const raw = el.dataset.ftime;
    if (!raw) return;
    const next = this._formatTime(raw);
    if (next && el.textContent !== next) el.textContent = next;
  });
},

_startDayRolloverWatch() {
  if (this._dayRolloverTimer || typeof document === 'undefined') return;
  const dayKey = () => this._fmtDate(new Date(), { year: 'numeric', month: '2-digit', day: '2-digit' });
  this._dayRolloverKey = dayKey();
  const check = () => {
    const key = dayKey();
    if (key === this._dayRolloverKey) return;
    this._dayRolloverKey = key;
    this._refreshTimeLabels();
  };
  this._dayRolloverTimer = setInterval(check, 60000);
  // A sleeping laptop or a hidden tab can skip the timer; look again on return.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
},

_formatTime(dateStr) {
  this._startDayRolloverWatch();
  const date = new Date(dateStr);
  const now = new Date();
  const time = this._fmtTime(date);
  // Compare the calendar day in the reader's chosen zone (falls back to the
  // device zone when unset), so "today"/"yesterday" don't drift across a date
  // boundary when a timezone is picked.
  const dayKey = (d) => this._fmtDate(d, { year: 'numeric', month: '2-digit', day: '2-digit' });
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isToday = dayKey(date) === dayKey(now);
  const isYesterday = dayKey(date) === dayKey(yesterday);

  if (isToday) return t('utils.today_at', { time });
  if (isYesterday) return t('utils.yesterday_at', { time });
  return `${this._fmtDate(date)} ${time}`;
},

_getUserColor(username) {
  const colors = [
    '#e94560', '#7c5cfc', '#43b581', '#faa61a',
    '#f47fff', '#00b8d4', '#ff6b6b', '#a8e6cf',
    '#82aaff', '#c792ea', '#ffcb6b', '#89ddff'
  ];
  let hash = 0;
  for (const ch of username) {
    hash = ((hash << 5) - hash) + ch.charCodeAt(0);
  }
  return colors[Math.abs(hash) % colors.length];
},

_isScrolledToBottom() {
  const el = document.getElementById('messages');
  return el.scrollHeight - el.clientHeight - el.scrollTop < 150;
},

_scrollToBottom(force) {
  const el = document.getElementById('messages');
  if (force || this._coupledToBottom) {
    el.scrollTop = el.scrollHeight;
  }
},

// Jump to the newest message. Shared by the jump-to-bottom button and the
// Escape hotkey. When the DOM window has been trimmed (_noMoreFuture === false)
// the newest messages aren't loaded, so re-fetch from the present; otherwise a
// plain scroll reaches the true bottom instantly.
_jumpToLatest() {
  document.getElementById('jump-to-bottom')?.classList.remove('visible');
  if (this._noMoreFuture === false) {
    this._reloadChannelFromPresent();
  } else {
    this._scrollToBottom(true);
    this._coupledToBottom = true;
  }
},

// Snap the feed back to the live present by re-running the fresh channel load.
// Needed when the DOM window has been trimmed (newest messages aren't in the
// DOM, i.e. _noMoreFuture === false). A plain _scrollToBottom only reaches the
// artificial bottom of the loaded window. This mirrors the reset the own-message
// and tab-resync paths already use, so message-history renders the initial-load
// branch and _renderMessages lands at the true bottom.
_reloadChannelFromPresent() {
  if (!this.currentChannel || !this.socket?.connected) return;
  this._coupledToBottom = true;
  this._oldestMsgId = null;
  this._noMoreHistory = false;
  this._loadingHistory = false;
  this._historyBefore = null;
  this._newestMsgId = null;
  this._noMoreFuture = true;
  this._loadingFuture = false;
  this._historyAfter = null;
  this.socket.emit('get-messages', { code: this.currentChannel });
},

// Debounced version used by image/media load handlers. Multiple images in the
// same batch (e.g. 5 photos loaded from history) all collapse into a single
// scroll call instead of firing an individual hard-snap per image, which is
// what causes the "chat jumping around like crazy" symptom.
_debouncedScrollToBottom() {
  clearTimeout(this._scrollBottomDebounce);
  this._scrollBottomDebounce = setTimeout(() => {
    if (this._coupledToBottom) this._scrollToBottom(true);
  }, 50);
},

_showToast(message, type = 'info', action = null, duration = 4000) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  if (duration !== 4000) {
    const fadeStart = (duration - 300) / 1000;
    toast.style.animation = `toastIn 0.25s ease, toastOut 0.3s ease ${fadeStart}s forwards`;
  }
  if (action) {
    toast.style.display = 'flex';
    toast.style.alignItems = 'center';
    toast.style.gap = '10px';
    const span = document.createElement('span');
    span.style.flex = '1';
    span.textContent = message;
    toast.appendChild(span);
    const btn = document.createElement('button');
    btn.className = 'toast-action-btn';
    btn.textContent = action.label;
    btn.addEventListener('click', () => { action.onClick(); toast.remove(); });
    toast.appendChild(btn);
  } else {
    toast.textContent = message;
  }
  container.appendChild(toast);
  setTimeout(() => toast.remove(), duration);
},

/** Show a one-time notice about the Account Recovery feature.
 *  Whether to show it at all is decided server-side (no recovery codes yet AND
 *  not previously dismissed); see get-recovery-notice-state. This only guards
 *  against showing twice within a single session (e.g. socket reconnects). */
_showRecoveryNotice() {
  if (this._recoveryNoticeShown) return;
  this._recoveryNoticeShown = true;

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay recovery-notice-overlay';
  overlay.style.cssText = 'display:flex;z-index:9999';
  overlay.innerHTML = `
    <div class="modal" style="max-width:400px">
      <h3>🔑 ${t('modals.recovery_notice.title')}</h3>
      <p class="modal-desc" style="margin-bottom:12px">${t('modals.recovery_notice.body')}</p>
      <div style="background:rgba(231,76,60,0.12);border:1px solid rgba(231,76,60,0.4);border-radius:8px;padding:10px 12px;margin-bottom:14px;font-size:0.83rem;color:var(--text-secondary)">
        ⚠️ ${t('modals.recovery_notice.warning')}
      </div>
      <label style="display:flex;align-items:center;gap:8px;font-size:0.85rem;color:var(--text-muted);margin-bottom:14px;cursor:pointer">
        <input type="checkbox" id="recovery-notice-dsa">
        <span>${t('modals.recovery_notice.dsa')}</span>
      </label>
      <div class="modal-actions">
        <button class="btn-primary" id="recovery-notice-go">${t('modals.recovery_notice.go_btn')}</button>
        <button class="btn-sm" id="recovery-notice-close" style="padding:8px 18px">${t('modals.common.dismiss')}</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  // Persist "never show again" per-account (not localStorage), same as the
  // promo modals. A plain close is session-only; the notice returns next login
  // unless the user generates recovery codes (which the server check suppresses
  // it on) or ticks the box here.
  const persistIfChecked = () => {
    if (document.getElementById('recovery-notice-dsa')?.checked) {
      this.socket.emit('set-preference', { key: 'recovery_notice_seen', value: 'true' });
    }
  };

  const dismiss = () => {
    persistIfChecked();
    overlay.remove();
  };

  document.getElementById('recovery-notice-close').addEventListener('click', dismiss);
  document.getElementById('recovery-notice-go').addEventListener('click', () => {
    persistIfChecked();
    overlay.remove();
    // Open settings modal and navigate to recovery section
    document.getElementById('open-settings-btn')?.click();
    setTimeout(() => {
      const navItem = document.querySelector('.settings-nav-item[data-target="section-recovery"]');
      if (navItem) navItem.click();
    }, 150);
  });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) dismiss(); });
},

/** Warn users before downloading potentially harmful file types */
_showExternalLinkWarning(displayText, url) {
  document.querySelector('.risky-download-overlay')?.remove();

  const overlay = document.createElement('div');
  overlay.className = 'risky-download-overlay';
  overlay.innerHTML = `
    <div class="risky-download-modal">
      <div class="risky-download-icon">🔗</div>
      <h3 style="color:var(--text-primary,#dbdee1)">${t('modals.external_link.title')}</h3>
      <p>${t('modals.external_link.about_to_visit')}</p>
      <p style="background:var(--bg-tertiary,#232428);padding:8px 12px;border-radius:6px;font-size:0.8125rem;word-break:break-all;color:var(--accent,#5865f2)">${this._escapeHtml(url)}</p>
      <p class="risky-download-desc">${t('modals.external_link.trust_warning')}</p>
      <div class="risky-download-actions">
        <button class="risky-download-cancel">${t('modals.common.cancel')}</button>
        <button class="risky-download-confirm" style="background:var(--accent,#5865f2)">${t('modals.external_link.open')}</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  overlay.querySelector('.risky-download-cancel').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  overlay.querySelector('.risky-download-confirm').addEventListener('click', () => {
    overlay.remove();
    window.open(url, '_blank', 'noopener,noreferrer');
  });
},

_showRiskyDownloadWarning(fileName, ext, url) {
  // Remove any existing warning overlay
  document.querySelector('.risky-download-overlay')?.remove();

  const overlay = document.createElement('div');
  overlay.className = 'risky-download-overlay';
  overlay.innerHTML = `
    <div class="risky-download-modal">
      <div class="risky-download-icon">⚠️</div>
      <h3>${t('modals.risky_download.title')}</h3>
      <p><strong>${this._escapeHtml(fileName)}</strong></p>
      <p class="risky-download-desc">${t('modals.risky_download.warning_html', { ext: this._escapeHtml(ext) })}</p>
      <div class="risky-download-actions">
        <button class="risky-download-cancel">${t('modals.common.cancel')}</button>
        <button class="risky-download-confirm">${t('modals.risky_download.download_anyway')}</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  // Cancel
  overlay.querySelector('.risky-download-cancel').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  // Confirm download
  overlay.querySelector('.risky-download-confirm').addEventListener('click', () => {
    overlay.remove();
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.rel = 'noopener noreferrer';
    document.body.appendChild(a);
    a.click();
    a.remove();
  });
},

// ═══════════════════════════════════════════════════════
// MEDIA PROXY (v3.43.0)
// ═══════════════════════════════════════════════════════
//
// Remote images are fetched by the Haven server and served from its cache, so
// the browser never contacts a third-party host. Before this, simply scrolling
// past a message containing an image URL sent your IP address and browser
// details to whoever owned that URL.
//
// The rule this code enforces: NEVER emit a raw external src. If the media
// token has not arrived yet, the URL is parked in data-mp-src and filled in
// once the token lands. Failing closed means a slow token fetch costs a moment
// of blank image, not a silent leak.

async _loadMediaToken() {
  try {
    const r = await fetch('/api/media-token', {
      headers: { 'Authorization': `Bearer ${this.token}` }
    });
    if (!r.ok) throw new Error('media token request failed');
    const d = await r.json();
    this._mediaProxyEnabled = d.enabled !== false;
    this._mediaToken = d.token || null;
  } catch {
    // Older server, or the endpoint is unavailable. Fall back to direct
    // loading so images do not silently break on a mismatched version.
    this._mediaProxyEnabled = false;
    this._mediaToken = null;
  }
  this._flushPendingMedia();
},

// The media token carries a day stamp and the server honours only today's and
// yesterday's, so it goes stale after about two days. It used to be fetched
// once at startup and never again, which was fine for a tab that gets closed
// and fatal for one that does not: leave Haven open over a weekend and every
// remote image posted after the token expired came back 401 and rendered as a
// blank gap, with no error and no retry. Reloading fixed it, which is why this
// looked random and unreproducible. Refreshed on a timer, on reconnect, and on
// a failed image below.
_renderSessionsList(sessions) {
  const el = document.getElementById('sessions-list');
  if (!el) return;
  if (!sessions.length) {
    el.innerHTML = `<p class="muted-text">${this._escapeHtml(t('settings.sessions_section.none'))}</p>`;
    return;
  }
  const rel = (ms) => {
    if (!ms) return '';
    const mins = Math.floor((Date.now() - ms) / 60000);
    if (mins < 1) return t('settings.sessions_section.just_now');
    if (mins < 60) return t('settings.sessions_section.mins', { n: mins });
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return t('settings.sessions_section.hours', { n: hrs });
    return t('settings.sessions_section.days', { n: Math.floor(hrs / 24) });
  };
  el.innerHTML = sessions.map(s => {
    const tag = s.current
      ? `<span class="session-current-tag">${this._escapeHtml(t('settings.sessions_section.this_device'))}</span>`
      : '';
    const ip = s.ip ? this._escapeHtml(s.ip) : '';
    return `<div class="session-item${s.current ? ' is-current' : ''}">
      <span class="session-device">${this._escapeHtml(s.device || '')}</span>${tag}
      <span class="session-meta">${ip}${ip && s.since ? '<br>' : ''}${this._escapeHtml(rel(s.since))}</span>
    </div>`;
  }).join('');
},

// Ask for the list when the pane is actually on screen. There is no session
// table behind this, so it is a snapshot of live sockets, not history.
_refreshSessions() {
  this.socket?.emit('get-sessions');
},

_refreshMediaToken() {
  // One request even when a screen full of images fails at the same moment.
  if (!this._mediaTokenRefresh) {
    this._mediaTokenRefresh = Promise.resolve(this._loadMediaToken())
      .finally(() => { this._mediaTokenRefresh = null; });
  }
  return this._mediaTokenRefresh;
},

// Re-fetch well inside the window rather than near the edge, so a machine that
// sleeps through the boundary still wakes up with time to spare.
_startMediaTokenRefresh() {
  if (this._mediaTokenTimer) return;
  this._mediaTokenTimer = setInterval(() => {
    if (this._mediaProxyEnabled !== false) this._refreshMediaToken();
  }, 6 * 60 * 60 * 1000);
},

// Last line of defence: an image the proxy refused gets one more go with a
// fresh token. Covers the cases a timer cannot, like a laptop asleep past the
// rollover or a clock that disagrees with the server's.
_setupMediaTokenRetry() {
  if (this._mediaRetryBound) return;
  this._mediaRetryBound = true;
  // Capture phase: `error` from an <img> does not bubble.
  document.addEventListener('error', (e) => {
    const el = e.target;
    if (!el || el.tagName !== 'IMG') return;
    const src = el.getAttribute('src') || '';
    if (!src.startsWith('/api/media-proxy?')) return;
    if (el.dataset.mpRetried) return;       // one retry per image, never a loop
    el.dataset.mpRetried = '1';
    const stale = this._mediaToken;
    this._refreshMediaToken().then(() => {
      if (!this._mediaToken || this._mediaToken === stale) return;
      try {
        const u = new URL(src, location.href);
        u.searchParams.set('mt', this._mediaToken);
        el.setAttribute('src', u.pathname + u.search);
      } catch { /* malformed src, leave it alone */ }
    });
  }, true);
},

// Returns a URL safe to put in a src attribute, or null when proxying is on
// but the token has not arrived yet (caller must defer).
_proxyMediaUrl(url) {
  if (typeof url !== 'string' || !url) return url;
  // Local paths, data: URIs and blobs never leave the origin.
  if (!/^https?:\/\//i.test(url)) return url;
  if (this._mediaProxyEnabled === false) return url;
  try {
    if (new URL(url, location.href).origin === location.origin) return url;
  } catch { return url; }
  if (!this._mediaToken) return null;   // enabled but not ready, so defer
  return `/api/media-proxy?url=${encodeURIComponent(url)}&mt=${encodeURIComponent(this._mediaToken)}`;
},

// Builds the src attribute for an <img>, deferring when necessary. Returns an
// already-escaped attribute string.
// data-mp-origin keeps the original remote URL alongside the proxied src, so
// the DM link policy can judge the real host rather than the proxy URL that
// always points back at us. (#5483)
_imgSrcAttr(url) {
  const p = this._proxyMediaUrl(url);
  const origin = /^https?:\/\//i.test(url || '') ? ` data-mp-origin="${this._escapeHtml(url)}"` : '';
  return (p !== null
    ? `src="${this._escapeHtml(p)}"`
    : `data-mp-src="${this._escapeHtml(url)}"`) + origin;
},

// Fill in any images that rendered before the token was available.
_flushPendingMedia() {
  document.querySelectorAll('[data-mp-src]').forEach(el => {
    const raw = el.getAttribute('data-mp-src');
    const p = this._proxyMediaUrl(raw);
    if (p === null) return;            // still not ready
    el.removeAttribute('data-mp-src');
    el.setAttribute('src', p);
  });
},

// ── Generic prompt modal (replaces window.prompt for Electron compat) ──
_showPromptModal(title, message, defaultValue = '') {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.style.display = 'flex';
    overlay.style.zIndex = '100002';
    overlay.innerHTML = `
      <div class="modal" style="max-width:380px">
        <h3 style="margin-top:0">${this._escapeHtml(title)}</h3>
        ${message ? `<p class="muted-text" style="margin:0 0 12px;white-space:pre-line">${this._escapeHtml(message)}</p>` : ''}
        <input type="text" class="modal-input" id="prompt-modal-input" value="${this._escapeHtml(defaultValue)}" style="width:100%;box-sizing:border-box">
        <div class="modal-actions" style="margin-top:12px">
          <button class="btn-sm" id="prompt-modal-cancel">${t('modals.common.cancel')}</button>
          <button class="btn-sm btn-accent" id="prompt-modal-ok">${t('modals.common.ok')}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const input = overlay.querySelector('#prompt-modal-input');
    input.focus();
    input.select();

    const close = (val) => { overlay.remove(); resolve(val); };
    overlay.querySelector('#prompt-modal-cancel').addEventListener('click', () => close(null));
    overlay.querySelector('#prompt-modal-ok').addEventListener('click', () => close(input.value));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') close(input.value);
      if (e.key === 'Escape') close(null);
    });
  });
},

// ── Generic confirm modal (themed replacement for window.confirm) ──
_showConfirmModal(title, message, opts = {}) {
  const {
    confirmLabel,
    cancelLabel,
    danger = false,
  } = opts;
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.style.display = 'flex';
    overlay.style.zIndex = '100002';
    const okClass = danger ? 'btn-sm btn-danger-fill' : 'btn-sm btn-accent';
    overlay.innerHTML = `
      <div class="modal modal-confirm">
        <h3 style="margin-top:0">${this._escapeHtml(title || '')}</h3>
        ${message ? `<p class="muted-text" style="margin:0 0 12px;white-space:pre-line">${this._escapeHtml(message)}</p>` : ''}
        <div class="modal-actions" style="margin-top:12px">
          <button class="btn-sm" id="confirm-modal-cancel">${this._escapeHtml(cancelLabel || t('modals.common.cancel'))}</button>
          <button class="${okClass}" id="confirm-modal-ok">${this._escapeHtml(confirmLabel || (danger ? t('msg_toolbar.delete') : t('modals.common.confirm')))}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const okBtn = overlay.querySelector('#confirm-modal-ok');
    const cancelBtn = overlay.querySelector('#confirm-modal-cancel');
    const close = (val) => { overlay.remove(); document.removeEventListener('keydown', onKey); resolve(val); };
    const onKey = (e) => {
      if (e.key === 'Escape') close(false);
      if (e.key === 'Enter') close(true);
    };
    okBtn.addEventListener('click', () => close(true));
    cancelBtn.addEventListener('click', () => close(false));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });
    document.addEventListener('keydown', onKey);
    setTimeout(() => okBtn.focus(), 0);
  });
},

// A question with several answers. Resolves the id of the button pressed, or
// null for Escape or a click outside. Focus starts on the first button and
// Enter only presses the focused one, so a stray Enter (someone still sending)
// cannot pick a risky answer.
_askChoice(title, message, buttons) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.style.display = 'flex';
    overlay.style.zIndex = '100002';
    overlay.innerHTML = `
      <div class="modal modal-confirm">
        <h3 style="margin-top:0">${this._escapeHtml(title || '')}</h3>
        ${message ? `<p class="muted-text" style="margin:0 0 12px;white-space:pre-line">${this._escapeHtml(message)}</p>` : ''}
        <div class="modal-actions" style="margin-top:12px;flex-wrap:wrap"></div>
      </div>
    `;
    const onKey = (e) => { if (e.key === 'Escape') close(null); };
    const close = (val) => { overlay.remove(); document.removeEventListener('keydown', onKey); resolve(val); };
    const row = overlay.querySelector('.modal-actions');
    for (const b of buttons) {
      const el = document.createElement('button');
      el.className = b.danger ? 'btn-sm btn-danger-fill' : (b.accent ? 'btn-sm btn-accent' : 'btn-sm');
      el.textContent = b.label;
      el.addEventListener('click', () => close(b.id));
      row.appendChild(el);
    }
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
    setTimeout(() => row.querySelector('button')?.focus(), 0);
  });
},

};
