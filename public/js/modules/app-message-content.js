// What goes inside a message: formatting (markdown, mentions, emoji, links,
// timestamps), poll and reaction widgets, the reply banner and quoting,
// editing in place, and the link policy that guards DMs.

export default {

_formatContent(str) {
  // Spoiler image: spoiler-img:<payload> where payload is an /uploads URL or
  // an e2e-img: marker. The sender marked this image as a spoiler, so render
  // it blurred behind a "Spoiler" overlay; a click reveals it (handled by the
  // delegated reveal listener). Only treat as a spoiler when the payload is
  // actually media so a plain text message that happens to start with the
  // marker isn't blurred unexpectedly.
  if (typeof str === 'string' && str.startsWith('spoiler-img:')) {
    const rest = str.slice('spoiler-img:'.length);
    if (this._isImageUrl(rest) || /^\/uploads\//i.test(rest) || rest.startsWith('e2e-img:')) {
      const inner = this._formatContent(rest);
      const label = this._escapeHtml(t('app.messages.spoiler'));
      return `<div class="spoiler-media" role="button" tabindex="0" title="${label}"><span class="spoiler-media-tag">\u{1F441}️ ${label}</span>${inner}</div>`;
    }
  }

  // E2E encrypted image: e2e-img:<mime>:<url>
  const e2eImgMatch = str.match(/^e2e-img:(image\/(?:jpeg|png|gif|webp|svg\+xml)):(\/uploads\/[\w\-.]+)$/i);
  if (e2eImgMatch) {
    const mime = this._escapeHtml(e2eImgMatch[1]);
    const url = this._escapeHtml(e2eImgMatch[2]);
    return `<img data-e2e-src="${url}" data-e2e-mime="${mime}" class="chat-image e2e-img-pending" alt="${t('app.messages.e2e_image_alt')}" title="${t('app.messages.e2e_image_title')}">`;
  }

  // E2E encrypted file: e2e-file:{"mime":...,"size":N,"url":"/uploads/...","name":"..."}
  // (#5310, #5308) — non-image DM uploads, plus paste-into-PiP, are encrypted
  // before upload and the metadata is wrapped in this marker.
  if (str.startsWith('e2e-file:')) {
    try {
      const meta = JSON.parse(str.slice(9));
      if (meta && typeof meta.url === 'string' && meta.url.startsWith('/uploads/')) {
        const name = this._escapeHtml(typeof meta.name === 'string' ? meta.name : t('app.messages.file'));
        const url = this._escapeHtml(meta.url);
        const mime = this._escapeHtml(typeof meta.mime === 'string' ? meta.mime : 'application/octet-stream');
        const size = Number(meta.size) || 0;
        const sizeStr = this._escapeHtml(this._formatFileSize ? this._formatFileSize(size) : (size + ' B'));
        // A voice message in a DM shows as one, with its length, and a click
        // decrypts it into a player (#5665).
        const voiceDur = this._voiceMessageLength(name);
        const label = voiceDur !== null ? t('app.messages.voice_message') : name;
        return `<div class="file-attachment e2e-file-pending${voiceDur !== null ? ' voice-message' : ''}" data-e2e-url="${url}" data-e2e-mime="${mime}" data-e2e-name="${name}" title="${t('app.messages.e2e_file_title')}">
          <button type="button" class="file-download-link e2e-file-download">
            <span class="file-icon">${voiceDur !== null ? '🎤' : '🔒'}</span>
            <span class="file-name">${label}</span>
            <span class="file-size">(${voiceDur !== null ? voiceDur : sizeStr})</span>
            <span class="file-download-arrow">⬇</span>
          </button>
        </div>`;
      }
    } catch { /* unreadable attachment data: show the error line below */ }
    return `<span class="muted-text">${t('app.messages.e2e_file_parse_error')}</span>`;
  }

  // A post can carry pictures and files on lines of their own between its
  // text: a forum topic sent with a picture, or one written in New Post. Each
  // of those lines shows as the picture or file, and the text around them
  // formats as usual; the link used to print as plain text (#5690, #5689).
  // Only this server's uploads, and never inside a code block.
  if (typeof str === 'string' && str.includes('\n') && !str.includes('```')) {
    const mediaLine = (l) => /^(?:spoiler-img:)?\/uploads\/(?:[\w\-]+\/)?[\w\-.]+\.(jpg|jpeg|png|gif|webp|svg)$/i.test(l) ||
      /^\[file:[^\]\n]+\]\(\/uploads\/[^\s|)]+\|[^)\n]+\)$/.test(l);
    const lines = str.split('\n');
    if (lines.some(l => mediaLine(l.trim()))) {
      const parts = [];
      let text = [];
      const flush = () => {
        const chunk = text.join('\n');
        text = [];
        if (chunk.trim()) parts.push(`<div class="content-text-part">${this._formatContent(chunk)}</div>`);
      };
      for (const l of lines) {
        if (mediaLine(l.trim())) { flush(); parts.push(`<div class="content-media-part">${this._formatContent(l.trim())}</div>`); }
        else text.push(l);
      }
      flush();
      return parts.join('');
    }
  }

  // Decode legacy HTML entities from old server-side sanitization.
  // The server no longer entity-encodes, but older messages in the DB
  // may still contain entities like &#39; &amp; &lt; etc.
  const emojiOnly = this._isEmojiOnly(str);
  str = this._decodeHtmlEntities(str);

  // Render file attachments [file:name](url|size)
  const fileMatch = str.match(/^\[file:(.+?)\]\((.+?)\|(.+?)\)$/);
  if (fileMatch) {
    const fileName = this._escapeHtml(fileMatch[1]);
    const fileUrl = this._escapeHtml(fileMatch[2]);
    const fileSize = this._escapeHtml(fileMatch[3]);
    const ext = fileName.split('.').pop().toLowerCase();
    const icon = { pdf: '📄', zip: '📦', '7z': '📦', rar: '📦', tar: '📦', gz: '📦',
      mp3: '🎵', ogg: '🎵', oga: '🎵', wav: '🎵', flac: '🎵', aac: '🎵', wma: '🎵',
      m4a: '🎵', opus: '🎵', weba: '🎵',
      mp4: '🎬', webm: '🎬', mkv: '🎬', avi: '🎬', mov: '🎬', flv: '🎬',
      m4v: '🎬', ogv: '🎬',
      doc: '📝', docx: '📝', xls: '📊', xlsx: '📊', ppt: '📊', pptx: '📊',
      txt: '📄', csv: '📄', json: '📄', md: '📄', log: '📄',
      exe: '⚙️', msi: '⚙️', bat: '⚙️', cmd: '⚙️', ps1: '⚙️', sh: '⚙️',
      dll: '⚙️', iso: '💿', dmg: '💿', img: '💿',
      apk: '📱', deb: '📦', rpm: '📦',
      py: '🐍', js: '📜', ts: '📜', html: '🌐', css: '🎨', svg: '🖼️' }[ext] || '📎';
    const RISKY_EXTS = new Set([
      'exe','bat','cmd','com','scr','pif','msi','msp','mst',
      'ps1','vbs','vbe','js','jse','wsf','wsh','hta',
      'cpl','inf','reg','dll','ocx','sys','drv',
      'sh','app','dmg','pkg','deb','rpm','appimage',
    ]);
    // A voice message from the mic button: a small player with its length
    // rather than a file name and size (#5665).
    const voiceDur = this._voiceMessageLength(fileName);
    if (voiceDur !== null) {
      return `<div class="file-attachment voice-message">
        <div class="file-info"><span class="file-type-icon" aria-hidden="true">🎤</span> <span class="file-name">${t('app.messages.voice_message')}</span> <span class="file-size">(${voiceDur})</span></div>
        <audio controls preload="metadata" src="${fileUrl}" class="file-audio"></audio>
      </div>`;
    }
    // Audio/video get inline players. The extension lists are optimistic —
    // a container being playable depends on the codecs inside it, not just the
    // extension (a .mov holding ProRes or HEVC won't decode in most browsers).
    // _setupVideos swaps the player back out for a download link
    // if the element fires `error`, so listing a format here is safe.
    if (['mp3', 'ogg', 'oga', 'wav', 'm4a', 'aac', 'flac', 'opus', 'weba'].includes(ext)) {
      return `<div class="file-attachment">
        <div class="file-info"><span class="file-type-icon" aria-hidden="true">${icon}</span> <span class="file-name">${fileName}</span> <span class="file-size">(${fileSize})</span></div>
        <audio controls preload="none" src="${fileUrl}" class="file-audio"></audio>
      </div>`;
    }
    if (['mp4', 'webm', 'mov', 'm4v', 'ogv'].includes(ext)) {
      return `<div class="file-attachment">
        <div class="file-info"><span class="file-type-icon" aria-hidden="true">${icon}</span> <span class="file-name">${fileName}</span> <span class="file-size">(${fileSize})</span></div>
        <div class="file-video-wrap">
          <video controls preload="none" src="${fileUrl}" class="file-video"></video>
        </div>
      </div>`;
    }
    return `<div class="file-attachment">
      <a href="${fileUrl}" target="_blank" rel="noopener noreferrer" class="file-download-link${RISKY_EXTS.has(ext) ? ' risky-file' : ''}" download="${fileName}"${RISKY_EXTS.has(ext) ? ' data-risky="true"' : ''}>
        <span class="file-icon">${icon}</span>
        <span class="file-name">${fileName}</span>
        <span class="file-size">(${fileSize})</span>
        <span class="file-download-arrow">⬇</span>
      </a>
    </div>`;
  }

  // Render server-hosted stickers inline at sticker dimensions (CSS-controlled)
  if (/^\/uploads\/stickers\/[\w\-.]+\.(jpg|jpeg|png|gif|webp|svg)$/i.test(str.trim())) {
    return `<img ${this._lazySrcAttr(`src="${this._escapeHtml(str.trim())}"`)} class="sticker-img" alt="sticker">`;
  }

  // Render server-hosted images inline (early return)
  // Inline images go through the lazy media queue (app-media.js): the loader
  // fetches them near the viewport, closest first, and pins their box so
  // scrolling history never jumps.
  // SVG is included — browsers render SVGs in <img> tags safely (no script execution). (#5309)
  // Basename allows dots (`photo.edit.jpg`) and one extra path segment so this
  // matches `_isImageUrl` / Haven Mobile. The previous `[\w\-]+` pattern
  // classified those as images then emitted no <img>, so the bubble was blank.
  if (/^\/uploads\/(?:[\w\-]+\/)?[\w\-.]+\.(jpg|jpeg|png|gif|webp|svg)$/i.test(str.trim())) {
    const u = str.trim();
    if (this._isImageHidden && this._isImageHidden(u)) return this._hiddenImagePlaceholder(u);
    return `<img ${this._lazySrcAttr(`src="${this._escapeHtml(u)}"`)} class="chat-image" alt="image">`;
  }

  // Remote image-only messages (Ferry Discord attachments, pasted CDN URLs).
  // Must run on the unescaped string so signed query params keep their `&`.
  {
    const u = str.trim();
    if (this._isImageUrl(u) && /^https?:\/\//i.test(u)) {
      if (this._isImageHidden && this._isImageHidden(u)) return this._hiddenImagePlaceholder(u);
      return `<img ${this._lazySrcAttr(this._imgSrcAttr(u))} class="chat-image" alt="image">`;
    }
  }

  // ── Extract fenced code blocks before escaping ──
  // A word right after the opening fence is a language name only when the
  // line ends there, as in Discord: "```js" then a new line. On one line,
  // "```chmod +x start.sh```" is all code; reading "chmod" as the language
  // used to drop it from the block.
  const codeBlocks = [];
  const withPlaceholders = str.replace(/```(?:(\w+)[ \t]*\n|\n)?([\s\S]*?)```/g, (_, lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push({ lang: lang || '', code });
    return `\x00CODEBLOCK_${idx}\x00`;
  });

  // ── Timestamps: <t:1780853820> / <t:1780853820:R> ──
  // Extracted before escaping (the token has angle brackets) and after the
  // code fences above, so a token inside ``` stays literal.
  const timestamps = [];
  const withTimestamps = withPlaceholders.replace(/<t:(-?\d{1,15})(?::([tTdDfFR]))?>/g, (full, secs, style) => {
    const rendered = this._formatTimestampToken(Number(secs), style || 'f');
    if (!rendered) return full;
    const idx = timestamps.length;
    timestamps.push(rendered);
    return `\x00TIMESTAMP_${idx}\x00`;
  });

  // ── Discord custom emotes: <:name:id> / <a:name:id> ──
  // Relayed by Ferry, or typed by someone who wants the emote to show on the
  // Discord side of a bridge. Pulled out before escaping like the timestamps,
  // and before the :name: pass below so the shortcode inside the token is not
  // resolved on its own. A Haven emoji of the same name wins; otherwise the
  // picture comes from the server's emote cache (/api/ferry/emote/), which
  // answers 404 on a server without the bridge, and the :name: text stays.
  const emotes = [];
  const withEmotes = withTimestamps.replace(/<(a?):([A-Za-z0-9_]{2,32}):(\d{15,25})>/g, (full, anim, name, id) => {
    const idx = emotes.length;
    emotes.push(this._discordEmoteHtml(name, id, !!anim));
    return `\x00DEMOTE_${idx}\x00`;
  });

  let html = this._escapeHtml(withEmotes);

  // ── Colour spans: c#RRGGBB…#c and c#(R,G,B)…#c ──
  // Marked out before the link pass, so a closing #c is never swallowed into
  // the URL in front of it, and restored last, so the colour reaches text
  // inside a quote or a spoiler as well (#5661).
  const colorOpens = [];
  html = html.replace(/c#([0-9a-fA-F]{6})([\s\S]+?)#c/g, (full, hex, inner) => {
    const idx = colorOpens.length;
    colorOpens.push(`<span style="color:#${hex}">`);
    return `\x00COLOR_${idx}\x00${inner}\x00ENDCOLOR\x00`;
  });
  html = html.replace(/c#\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)([\s\S]+?)#c/g, (full, r, g, b, inner) => {
    const [rr, gg, bb] = [r, g, b].map(v => Math.min(255, parseInt(v, 10)));
    const idx = colorOpens.length;
    colorOpens.push(`<span style="color:rgb(${rr},${gg},${bb})">`);
    return `\x00COLOR_${idx}\x00${inner}\x00ENDCOLOR\x00`;
  });

  // ── Markdown images & links (extract before auto-linking) ──
  const mdLinks = [];
  // ![alt](url)
  html = html.replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g, (full, alt, url) => {
    const safeUrl = this._rawHttpUrl(url);
    if (!safeUrl) return full;
    const idx = mdLinks.length;
    mdLinks.push((this._isImageHidden && this._isImageHidden(safeUrl))
      ? this._hiddenImagePlaceholder(safeUrl)
      : `<img ${this._imgSrcAttr(safeUrl)} class="chat-image" alt="${alt || 'image'}">`);
    return `\x00MDLINK_${idx}\x00`;
  });
  // [text](url)
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (full, text, url) => {
    const safeUrl = this._rawHttpUrl(url);
    if (!safeUrl) return full;
    const idx = mdLinks.length;
    mdLinks.push(`<a href="${this._escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer nofollow" title="${this._escapeHtml(safeUrl)}" data-masked-link="true">${text}</a>`);
    return `\x00MDLINK_${idx}\x00`;
  });

  // Auto-link URLs (and render image URLs as inline images)
  // Use placeholders to prevent @mention regex from matching inside URLs
  const autoLinks = [];
  html = html.replace(
    /\bhttps?:\/\/[a-zA-Z0-9\-._~:/?#\[\]@!$&()*+,;=%]+/g,
    (url) => {
      const safeUrl = this._rawHttpUrl(url);
      if (!safeUrl) return url;
      const idx = autoLinks.length;
      if (this._isRemoteImageUrl(safeUrl)) {
        autoLinks.push((this._isImageHidden && this._isImageHidden(safeUrl))
          ? this._hiddenImagePlaceholder(safeUrl)
          : `<img ${this._imgSrcAttr(safeUrl)} class="chat-image" alt="image" loading="lazy">`);
      } else {
        autoLinks.push(`<a href="${this._escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer nofollow">${this._escapeHtml(safeUrl)}</a>`);
      }
      return `\x00AUTOLINK_${idx}\x00`;
    }
  );

  // Render @mentions with highlight (negative lookbehind prevents matching inside email addresses).
  // Only style as a mention when the matched name resolves to a real
  // channel member (login name OR display name), or to the current user.
  // Random `@text` that doesn't match anyone is left as plain text. (#5273)
  // Match by login name first (longest first, supports spaces), then fall
  // back to display names. Self-mention falls back to a simple \w match for
  // when channel members haven't loaded yet.
  const validNames = new Set();
  const loginToDisplay = new Map();
  const displayToLogin = new Map();
  // Map matched names back to user id so we can prefer the viewer's personal
  // nickname for the display text. (#5290)
  const nameToUserId = new Map();
  if (Array.isArray(this.channelMembers)) {
    for (const m of this.channelMembers) {
      if (!m) continue;
      if (m.loginName) {
        validNames.add(m.loginName.toLowerCase());
        loginToDisplay.set(m.loginName.toLowerCase(), m.username || m.loginName);
        if (m.id) nameToUserId.set(m.loginName.toLowerCase(), m.id);
      }
      if (m.username) {
        validNames.add(m.username.toLowerCase());
        displayToLogin.set(m.username.toLowerCase(), m.loginName || m.username);
        if (m.id) nameToUserId.set(m.username.toLowerCase(), m.id);
      }
      // Also let users autocomplete/style mentions by their assigned nickname.
      const nick = m.id && this._nicknames ? this._nicknames[m.id] : null;
      if (nick) {
        validNames.add(nick.toLowerCase());
        if (m.id) nameToUserId.set(nick.toLowerCase(), m.id);
      }
    }
  }
  const selfLogin = (this.user.username || '').toLowerCase();
  if (selfLogin) validNames.add(selfLogin);
  // Also include known persona names so @PersonaName lights up as a mention
  // and pings the persona's owner. (#5349) Personas are tracked in
  // _channelPersonas (lowercase name → { user_id, name, avatar }) and are
  // populated as messages from personas are rendered.
  if (this._channelPersonas instanceof Map) {
    for (const [low, p] of this._channelPersonas.entries()) {
      validNames.add(low);
      if (p && p.user_id) nameToUserId.set(low, p.user_id);
    }
  }
  // Also include the user's own personas so they can self-reference.
  if (Array.isArray(this._personas)) {
    for (const p of this._personas) {
      if (!p || !p.name) continue;
      const low = p.name.toLowerCase();
      validNames.add(low);
      if (this.user && this.user.id) nameToUserId.set(low, this.user.id);
    }
  }
  // Role mentions (#5579): every role name is a valid @target, styled as a
  // role and lit up for a viewer who holds it.
  const roleByName = new Map();
  const myRoleIds = new Set(((this.user && this.user.roles) || []).map(r => r && r.id));
  for (const r of (this._mentionableRoles || [])) {
    if (!r || !r.name) continue;
    const low = r.name.toLowerCase();
    roleByName.set(low, { name: r.name, color: r.color, color2: r.color2, color_shimmer: r.color_shimmer, mine: myRoleIds.has(r.id) });
    validNames.add(low);
  }
  const allNames = [...validNames].sort((a, b) => b.length - a.length);
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Build alt list of known names; also keep a generic fallback for any
  // \w token so we can detect a candidate before validating it below.
  const namesAlt = allNames.length ? allNames.map(escapeRe).join('|') + '|' : '';
  const mentionRegex = new RegExp(`(?<![\\w@])@(${namesAlt}\\w{1,30})`, 'gi');
  html = html.replace(mentionRegex, (match, name) => {
    const lower = name.toLowerCase();
    // Only render as a mention if this matches a known member or self.
    // (When channelMembers hasn't loaded yet, allow self-mention only.)
    const isKnown = validNames.has(lower);
    const isSelf  = lower === selfLogin;
    if (!isKnown && !isSelf) return match;
    // A role, unless a member shares the name, in which case the person wins.
    const role = roleByName.get(lower);
    if (role && !nameToUserId.has(lower) && !isSelf) {
      const style = role.color ? ` style="--role-color:${this._escapeHtml(role.color)}"` : '';
      return `<span class="mention mention-role${role.mine ? ' mention-self' : ''}"${style}>${this._roleNameHtml(role, '@' + role.name)}</span>`;
    }
    // Prefer the viewer's personal nickname for that user, then the
    // server-side display name, then the raw token. (#5290)
    const uid = nameToUserId.get(lower);
    const nick = uid && this._nicknames ? this._nicknames[uid] : null;
    const display = nick || loginToDisplay.get(lower) || name;
    return `<span class="mention${isSelf ? ' mention-self' : ''}">@${this._escapeHtml(display)}</span>`;
  });

  // ── @everyone / @here mentions ──
  // Render as a styled mention badge. Notification + audio cue is handled
  // separately in app-socket.js when a new message arrives.
  html = html.replace(/(?<![\w@])@(everyone|here)\b/gi, (_m, name) => {
    return `<span class="mention mention-everyone" data-everyone="${name.toLowerCase()}">@${this._escapeHtml(name.toLowerCase())}</span>`;
  });

  // ── #channel-name links ──
  // Recognize #foo / #foo-bar / #🎮general references and turn them into
  // clickable spans that switch the active channel on click. We resolve
  // against the user's currently-loaded channel list (case-insensitive).
  // Matched names must follow a non-word/non-hash boundary so things like
  // ## headings or message IDs (#1234) don't get linkified spuriously.
  if (Array.isArray(this.channels) && this.channels.length) {
    const chanByName = new Map();
    const nameByCode = new Map();
    // Names a channel used to have, so a #old-name typed before a rename
    // still points at it and reads as the name it has now (#5602). A current
    // name always wins over another channel's former one.
    const formerByName = new Map();
    for (const c of this.channels) {
      if (c && c.name && c.code && !c.is_dm) {
        chanByName.set(String(c.name).toLowerCase(), c.code);
        nameByCode.set(c.code, String(c.name));
        let former = [];
        try { former = typeof c.former_names === 'string' ? JSON.parse(c.former_names) : (c.former_names || []); } catch { former = []; }
        if (Array.isArray(former)) for (const old of former) {
          if (typeof old === 'string' && old) formerByName.set(old.toLowerCase(), c.code);
        }
      }
    }
    if (chanByName.size > 0) {
      // Names with spaces are typed as #foo_bar — try the literal form
      // first, then fall back to a space-substituted lookup so spaced
      // channel names resolve too.
      const lookup = (map, lower) => map.get(lower) || map.get(lower.replace(/_/g, ' '));
      html = html.replace(/(?<![\w#&])#([\p{L}\p{N}\p{Emoji_Presentation}_-][\p{L}\p{N}\p{Emoji_Presentation}_-]{0,49})/gu, (match, name) => {
        const lower = name.toLowerCase();
        let code = lookup(chanByName, lower);
        let label = name;
        if (!code) {
          code = lookup(formerByName, lower);
          if (!code) return match;
          label = (nameByCode.get(code) || name).replace(/\s+/g, '_');
        }
        return `<span class="channel-link" data-channel-code="${this._escapeHtml(code)}">#${this._escapeHtml(label)}</span>`;
      });
    }
  }

  // Render spoilers (||text||) — CSP-safe, uses delegated click handler
  html = html.replace(/\|\|(.+?)\|\|/g, '<span class="spoiler">$1</span>');

  // Render custom + bundled built-in image emojis :name:
  html = html.replace(/:([a-zA-Z0-9_-]+):/g, (match, name) => {
    const emoji = this._findNamedEmoji(name);
    if (emoji) return `<img src="${this._escapeHtml(emoji.url)}" alt=":${this._escapeHtml(name)}:" title=":${this._escapeHtml(name)}:" class="custom-emoji">`;
    return match;
  });

  // Render __underline__
  html = html.replace(/__(.+?)__/g, '<u>$1</u>');

  // Render /me action text (italic)
  if (html.startsWith('_') && html.endsWith('_') && html.length > 2) {
    html = `<em class="action-text">${html.slice(1, -1)}</em>`;
  }

  // Render **bold**
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  // Render *italic*
  html = html.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');

  // Render ~~strikethrough~~
  html = html.replace(/~~(.+?)~~/g, '<del>$1</del>');

  // Render ==highlight==
  html = html.replace(/==(.+?)==/g, '<mark class="chat-highlight">$1</mark>');

  // Render `inline code`
  html = html.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');

  // Render grouped > blockquotes and preserve attribution lines inside the quote.
  // A line quotes only when the > is followed by a space, another >, or
  // nothing at all: ">implying" and ">.<" stay as typed (#5654).
  const blockquotes = [];
  html = html.replace(/(^|\n)((?:&gt;(?:[ \t][^\n]*|&gt;[^\n]*)?(?:\n|$))+)/g, (full, pre, block) => {
    // A lone ">" with nothing on it is only a blank line inside a quote,
    // never a quote by itself.
    if (block.split('\n').every(line => /^&gt;\s*$/.test(line))) return full;
    const lines = block.trim().split('\n').map(line => line.replace(/^&gt;\s?/, ''));
    let authorHtml = '';
    if (lines[0] && /^@[^\s].+ wrote:$/.test(lines[0])) {
      authorHtml = `<div class="chat-blockquote-author">${lines.shift()}</div>`;
    }
    const textHtml = lines.join('<br>');
    const idx = blockquotes.length;
    blockquotes.push(`<blockquote class="chat-blockquote">${authorHtml}<div class="chat-blockquote-body">${textHtml}</div></blockquote>`);
    // The line break after the quote stays in the text, so a list that
    // follows still starts on its own line; the <br> it turns into is
    // dropped again when the quote is put back (#5661).
    return `${pre}\x00BLOCKQUOTE_${idx}\x00${block.endsWith('\n') ? '\n' : ''}`;
  });

  // (Colour spans were marked out before the link pass and are put back at
  // the very end.)

  // ── Headings: # H1, ## H2, ### H3 at start of line ──
  html = html.replace(/(^|\n)(#{1,3})\s+(.+)/g, (_, pre, hashes, text) => {
    const level = hashes.length;
    return `${pre}<div class="chat-heading chat-h${level}">${text}</div>`;
  });

  // ── Horizontal rules: --- or ___ on their own line (3+ chars) ──
  html = html.replace(/(^|\n)([-]{3,}|[_]{3,})\s*(?=\n|$)/g, '$1<hr class="chat-hr">');

  // ── Markdown tables ──
  // | h1 | h2 |
  // |----|----|
  // | a  | b  |
  // Run before lists/line-break conversion. Cell text passes through
  // already-resolved emoji / custom-emoji / mention HTML, so emoji
  // (unicode and :name:) render naturally inside cells. (#5286)
  const tablePlaceholders = [];
  const splitRow = (line) => line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim());
  const tableRe = /(^|\n)((?:\|[^\n]*\|\s*\n)+)\|\s*:?-{2,}:?(?:\s*\|\s*:?-{2,}:?)+\s*\|\s*(?:\n((?:\|[^\n]*\|\s*(?:\n|$))*))?/g;
  html = html.replace(tableRe, (full, pre, headBlock, bodyBlock) => {
    // headBlock holds 1+ leading rows; the last one is the header (the rest
    // would only happen with malformed input — drop them safely by taking
    // just the last row as header).
    const headRows = headBlock.trim().split('\n').filter(l => /^\s*\|.*\|\s*$/.test(l));
    if (headRows.length === 0) return full;
    const headerCells = splitRow(headRows[headRows.length - 1]);
    const bodyRows = (bodyBlock || '').trim().split('\n').filter(l => /^\s*\|.*\|\s*$/.test(l));
    const thead = `<thead><tr>${headerCells.map(c => `<th>${c}</th>`).join('')}</tr></thead>`;
    const tbody = bodyRows.length
      ? `<tbody>${bodyRows.map(row => {
          const cells = splitRow(row);
          // Pad / trim to header width
          while (cells.length < headerCells.length) cells.push('');
          return `<tr>${cells.slice(0, headerCells.length).map(c => `<td>${c}</td>`).join('')}</tr>`;
        }).join('')}</tbody>`
      : '';
    const idx = tablePlaceholders.length;
    tablePlaceholders.push(`<div class="chat-table-wrap"><table class="chat-table">${thead}${tbody}</table></div>`);
    return `${pre}\x00TABLE_${idx}\x00`;
  });

  // ── Lists (ordered + unordered) with multi-tier nesting (#5304) ──
  // A list line starts with optional leading whitespace (spaces or tabs;
  // tabs count as 2 spaces for indent purposes), then either "- " / "* "
  // / "+ " (unordered) or "N. " (ordered). Indentation determines depth:
  // each 2 spaces ⇒ one extra level. Mixed unordered/ordered at the same
  // depth open separate lists. Adjacent list-blocks are detected by the
  // outer regex (any consecutive run of qualifying lines).
  const listLineRe = /^([ \t]*)([-*+]|\d+\.)\s+(.*)$/;
  const listBlockRe = /((?:(?:^|\n)[ \t]*(?:[-*+]|\d+\.)[ \t]+.+)+)/g;
  html = html.replace(listBlockRe, (match) => {
    const lines = match.replace(/^\n/, '').split('\n');
    // Parse each line into { depth, ordered, num, text }
    const parsed = lines.map(line => {
      const m = line.match(listLineRe);
      if (!m) return null;
      const indent = m[1].replace(/\t/g, '  ');
      const depth = Math.floor(indent.length / 2);
      const marker = m[2];
      const ordered = /^\d+\.$/.test(marker);
      const num = ordered ? parseInt(marker, 10) : null;
      return { depth, ordered, num, text: m[3] };
    }).filter(Boolean);
    if (!parsed.length) return match;

    // Build nested HTML using a stack of open lists.
    let out = '';
    const stack = []; // each entry: { ordered, depth }
    const closeTo = (targetLen) => {
      while (stack.length > targetLen) {
        const top = stack.pop();
        out += '</li>';
        out += top.ordered ? '</ol>' : '</ul>';
      }
    };
    parsed.forEach((item, idx) => {
      // Close lists that are at deeper depth than this item
      while (stack.length && stack[stack.length - 1].depth > item.depth) {
        out += '</li>';
        const top = stack.pop();
        out += top.ordered ? '</ol>' : '</ul>';
      }
      const top = stack[stack.length - 1];
      if (!top || top.depth < item.depth) {
        // Open a new nested list. If we're nesting under an open <li>,
        // don't close it — the new list goes inside.
        if (top && top.depth < item.depth) {
          // already inside an open <li> from previous sibling
        }
        const startAttr = item.ordered ? ` start="${item.num || 1}"` : '';
        out += item.ordered ? `<ol class="chat-list"${startAttr}>` : '<ul class="chat-list">';
        stack.push({ ordered: item.ordered, depth: item.depth });
      } else if (top.depth === item.depth && top.ordered !== item.ordered) {
        // Same depth but list type changed — close current, open new.
        out += '</li>';
        const popped = stack.pop();
        out += popped.ordered ? '</ol>' : '</ul>';
        const startAttr = item.ordered ? ` start="${item.num || 1}"` : '';
        out += item.ordered ? `<ol class="chat-list"${startAttr}>` : '<ul class="chat-list">';
        stack.push({ ordered: item.ordered, depth: item.depth });
      } else {
        // Same depth, same type — close previous <li> sibling.
        out += '</li>';
      }
      out += `<li>${item.text}`;
    });
    closeTo(0);
    return '\n' + out;
  });

  html = html.replace(/\n/g, '<br>');

  // ── Restore tables (do this after <br> so they aren't broken up) ──
  tablePlaceholders.forEach((tbl, idx) => {
    html = html.replace(new RegExp(`(?:<br>)?\\x00TABLE_${idx}\\x00(?:<br>)?`), tbl);
  });

  blockquotes.forEach((block, idx) => {
    html = html.replace(new RegExp(`(?:<br>)?\\x00BLOCKQUOTE_${idx}\\x00(?:<br>)?`), () => block);
  });

  // ── Restore fenced code blocks ──
  codeBlocks.forEach((block, idx) => {
    const escaped = this._escapeHtml(block.code).replace(/\n$/, '');
    const langAttr = block.lang ? ` data-lang="${this._escapeHtml(block.lang)}"` : '';
    const langLabel = block.lang ? `<span class="code-block-lang">${this._escapeHtml(block.lang)}</span>` : '';
    const rendered = `<div class="code-block"${langAttr}>${langLabel}<pre><code>${escaped}</code></pre></div>`;
    html = html.replace(`\x00CODEBLOCK_${idx}\x00`, rendered);
  });

  // ── Restore markdown links/images ──
  mdLinks.forEach((link, idx) => {
    html = html.replace(`\x00MDLINK_${idx}\x00`, link);
  });

  // ── Restore auto-linked URLs ──
  autoLinks.forEach((link, idx) => {
    html = html.replace(`\x00AUTOLINK_${idx}\x00`, link);
  });

  // ── Restore timestamps ──
  // Function replacement, so a formatted date containing $& or $1 cannot
  // be read as a replacement pattern.
  timestamps.forEach((el, idx) => {
    html = html.replace(`\x00TIMESTAMP_${idx}\x00`, () => el);
  });

  // ── Restore Discord emotes ──
  emotes.forEach((el, idx) => {
    html = html.replace(`\x00DEMOTE_${idx}\x00`, () => el);
  });

  // ── Colour spans go back last, around whatever was rendered inside them ──
  colorOpens.forEach((open, idx) => {
    html = html.replace(`\x00COLOR_${idx}\x00`, () => open);
  });
  html = html.replace(/\x00ENDCOLOR\x00/g, '</span>');

  if (emojiOnly) html = `<span class="emoji-only-msg">${html}</span>`;

  return html;
},

// ═══════════════════════════════════════════════════════
// POLLS
// ═══════════════════════════════════════════════════════

_renderPollWidget(msgId, poll) {
  if (!poll || !poll.question || !Array.isArray(poll.options)) return '';
  const votes = poll.votes || {};
  const totalVotes = poll.totalVotes || 0;
  const myId = this.user.id;

  const optionsHtml = poll.options.map((opt, i) => {
    const voters = votes[i] || [];
    const count = voters.length;
    const pct = totalVotes > 0 ? Math.round((count / totalVotes) * 100) : 0;
    const myVote = voters.some(v => v.user_id === myId);
    const voterNames = poll.anonymous ? '' : voters.map(v => this._escapeHtml(v.username)).join(', ');
    // An option can carry a picture (#5648). It is part of the button, so a
    // click on it is a vote, not the lightbox.
    const img = Array.isArray(poll.images) && typeof poll.images[i] === 'string' && /^\/uploads\//.test(poll.images[i])
      ? `<img class="poll-option-img" src="${this._escapeHtml(poll.images[i])}" alt="" loading="lazy">` : '';
    return `<button class="poll-option${myVote ? ' poll-voted' : ''}${img ? ' has-image' : ''}" data-msg-id="${msgId}" data-option="${i}" title="${voterNames}">
      <div class="poll-option-bar" style="width:${pct}%"></div>${img}
      <span class="poll-option-text">${this._escapeHtml(opt)}</span>
      <span class="poll-option-count">${count} (${pct}%)</span>
    </button>`;
  }).join('');

  const settings = [];
  if (poll.multiVote) settings.push(t('poll.multiple_votes'));
  if (poll.anonymous) settings.push(t('poll.anonymous'));
  const settingsHtml = settings.length ? `<div class="poll-settings-info">${settings.join(' · ')}</div>` : '';

  // A picture poll can sit in columns (#5648).
  const cols = Number(poll.columns) > 1 ? Math.min(5, Math.floor(Number(poll.columns))) : 0;
  return `<div class="poll-widget" data-msg-id="${msgId}">
    <div class="poll-question">${this._escapeHtml(poll.question)}</div>
    <div class="poll-options${cols ? ' poll-grid' : ''}"${cols ? ` style="--poll-cols:${cols}"` : ''}>${optionsHtml}</div>
    <div class="poll-footer">${t(totalVotes === 1 ? 'poll.votes_one' : 'poll.votes_other', { count: totalVotes })}${settingsHtml ? ' · ' : ''}${settingsHtml}</div>
  </div>`;
},

_updatePollVotes(messageId, votes, totalVotes) {
  const widget = document.querySelector(`.poll-widget[data-msg-id="${messageId}"]`);
  if (!widget) return;

  const wasAtBottom = this._coupledToBottom;
  const myId = this.user.id;

  // Get current poll data from the message to know anonymous/multiVote settings
  const msgEl = document.querySelector(`[data-msg-id="${messageId}"]`);
  const pollAnonymous = msgEl && msgEl.dataset.pollAnonymous === '1';

  widget.querySelectorAll('.poll-option').forEach(btn => {
    const idx = parseInt(btn.dataset.option);
    const voters = votes[idx] || [];
    const count = voters.length;
    const pct = totalVotes > 0 ? Math.round((count / totalVotes) * 100) : 0;
    const myVote = voters.some(v => v.user_id === myId);

    btn.classList.toggle('poll-voted', myVote);
    btn.title = pollAnonymous ? '' : voters.map(v => this._escapeHtml(v.username)).join(', ');
    const bar = btn.querySelector('.poll-option-bar');
    if (bar) bar.style.width = pct + '%';
    const countEl = btn.querySelector('.poll-option-count');
    if (countEl) countEl.textContent = `${count} (${pct}%)`;
  });

  const footer = widget.querySelector('.poll-footer');
  if (footer) {
    const settingsInfo = footer.querySelector('.poll-settings-info');
    const settingsHtml = settingsInfo ? ' · ' + settingsInfo.outerHTML : '';
    footer.innerHTML = `${t(totalVotes === 1 ? 'poll.votes_one' : 'poll.votes_other', { count: totalVotes })}${settingsHtml}`;
  }

  if (wasAtBottom) this._scrollToBottom(true);
},

// ═══════════════════════════════════════════════════════
// REACTIONS
// ═══════════════════════════════════════════════════════

_renderReactions(msgId, reactions) {
  if (!reactions || reactions.length === 0) return '';
  // Group by emoji
  const grouped = {};
  reactions.forEach(r => {
    if (!grouped[r.emoji]) grouped[r.emoji] = { emoji: r.emoji, users: [] };
    grouped[r.emoji].users.push({ id: r.user_id, username: r.username });
  });

  const badges = Object.values(grouped).map(g => {
    const isOwn = g.users.some(u => u.id === this.user.id);
    const names = g.users.map(u => u.username).join(', ');
    const usersJson = this._escapeHtml(JSON.stringify(g.users.map(u => u.username)));
    // Check if it's a custom emoji
    const customMatch = g.emoji.match(/^:([a-zA-Z0-9_-]+):$/);
    let emojiDisplay = this._escapeHtml(g.emoji);
    if (customMatch && this.customEmojis) {
      const ce = this._findNamedEmoji(customMatch[1]);
      if (ce) emojiDisplay = `<img src="${this._escapeHtml(ce.url)}" alt=":${this._escapeHtml(ce.name)}:" class="custom-emoji reaction-custom-emoji">`;
    }
    return `<button class="reaction-badge${isOwn ? ' own' : ''}" data-emoji="${this._escapeHtml(g.emoji)}" data-users="${usersJson}" title="${this._escapeHtml(names)}">${emojiDisplay} ${g.users.length}</button>`;
  }).join('');

  return `<div class="reactions-row">${badges}</div>`;
},

_updateMessageReactions(messageId, reactions) {
  // Update both the main pane and the DM PiP if either contains this message.
  const els = document.querySelectorAll(`[data-msg-id="${messageId}"]`);
  if (!els.length) return;

  const wasAtBottom = this._coupledToBottom;
  const html = this._renderReactions(messageId, reactions);

  els.forEach((msgEl) => {
    const oldRow = msgEl.querySelector('.reactions-row');
    if (oldRow) oldRow.remove();
    if (!html) return;
    const content = msgEl.querySelector('.message-content, .thread-msg-content');
    if (content) content.insertAdjacentHTML('afterend', html);
  });

  if (wasAtBottom) this._scrollToBottom(true);
},

// ═══════════════════════════════════════════════════════
// REPLY
// ═══════════════════════════════════════════════════════

_renderReplyBanner(replyCtx) {
  const previewText = replyCtx.content.length > 80
    ? replyCtx.content.substring(0, 80) + '…'
    : replyCtx.content;
  const color = this._getUserColor(replyCtx.username);
  return `
    <div class="reply-banner" data-reply-msg-id="${replyCtx.id}">
      <span class="reply-line" style="background:${color}"></span>
      <span class="reply-author" style="color:${color}">${this._escapeHtml(this._getNickname(replyCtx.user_id, replyCtx.username))}</span>
      <span class="reply-preview">${this._escapeHtml(previewText)}</span>
    </div>
  `;
},

_setReply(msgEl, msgId) {
  // In a forum a reply to a topic belongs in the topic's thread: that is what
  // bumps it, and it keeps the answer under the question instead of posting
  // a second topic that quotes the first. (#144)
  const forumCh = this.channels && this.channels.find(c => c.code === this.currentChannel);
  if (forumCh && forumCh.is_forum && msgEl && msgEl.closest && msgEl.closest('#messages')) {
    this._clearReply();
    this._openThread(msgId);
    return;
  }
  // Get message info — works for both full messages and compact messages
  let author = msgEl.querySelector('.message-author')?.textContent;
  if (!author) {
    // Compact message — look up the previous full message's author
    let prev = msgEl.previousElementSibling;
    while (prev) {
      const authorEl = prev.querySelector('.message-author');
      if (authorEl) { author = authorEl.textContent; break; }
      prev = prev.previousElementSibling;
    }
  }
  author = author || t('voice.someone');
  const content = msgEl.querySelector('.message-content')?.textContent || '';
  const preview = content.length > 60 ? content.substring(0, 60) + '…' : content;

  this.replyingTo = { id: msgId, username: author, content };

  const bar = document.getElementById('reply-bar');
  bar.style.display = 'flex';
  document.getElementById('reply-preview-text').innerHTML =
    t('thread_runtime.replying_to', { author: this._escapeHtml(author), preview: this._escapeHtml(preview) });
  document.getElementById('message-input').focus();
},

_clearReply() {
  this.replyingTo = null;
  const bar = document.getElementById('reply-bar');
  if (bar) bar.style.display = 'none';
},

_quoteMessage(msgEl) {
  // Get the raw text content of the message
  const rawContent = msgEl.dataset.rawContent || msgEl.querySelector('.message-content')?.textContent || '';
  // Get the author name
  let author = msgEl.querySelector('.message-author')?.textContent;
  if (!author) {
    let prev = msgEl.previousElementSibling;
    while (prev) {
      const authorEl = prev.querySelector('.message-author');
      if (authorEl) { author = authorEl.textContent; break; }
      prev = prev.previousElementSibling;
    }
  }
  author = author || t('voice.someone');

  // Build the blockquote text — each line prefixed with >
  const quotedLines = rawContent.split('\n').map(l => `> ${l}`).join('\n');
  const quoteText = `${t('thread_runtime.wrote', { author })}\n${quotedLines}\n`;

  const input = document.getElementById('message-input');
  // If there's already text, add a newline before the quote
  if (input.value) {
    input.value += '\n' + quoteText;
  } else {
    input.value = quoteText;
  }

  input.focus();
  // Trigger input event so textarea auto-resizes
  input.dispatchEvent(new Event('input'));
},

// ═══════════════════════════════════════════════════════
// EDIT MESSAGE
// ═══════════════════════════════════════════════════════

_startEditMessage(msgEl, msgId) {
  // Guard against re-entering edit mode
  if (msgEl.classList.contains('editing')) return;

  const contentEl = msgEl.querySelector('.message-content, .thread-msg-content');
  if (!contentEl) return;

  // Use the stored raw markdown content (set on render and kept in sync on
  // edit events). Falls back to textContent only for very old DOM nodes that
  // pre-date this attribute, but avoids the two bugs that textContent causes:
  // 1) markdown formatting stripped (bold/italic/etc. lost)
  // 2) '(edited)' tag text leaked into the textarea on repeated edits.
  const rawText = msgEl.dataset.rawContent ?? contentEl.textContent;

  // Replace content with an editable textarea
  const originalHtml = contentEl.innerHTML;
  contentEl.innerHTML = '';
  msgEl.classList.add('editing'); // hide toolbar while editing

  const textarea = document.createElement('textarea');
  textarea.className = 'edit-textarea';
  textarea.value = rawText;
  textarea.rows = 1;
  textarea.maxLength = parseInt(this.serverSettings?.max_message_chars) || 2000;
  // The same drag bar the composer has, so a long message can be pulled
  // open while editing it. It sits under the box, and dragging it down makes
  // the box taller, since the message above it may be at the very top of
  // the chat with nowhere to drag up to (#5662).
  const grip = document.createElement('div');
  grip.className = 'pip-input-resizer edit-resizer';
  grip.setAttribute('aria-hidden', 'true');
  contentEl.appendChild(textarea);
  contentEl.appendChild(grip);
  this._bindInputResizer?.(grip);

  // Track active edit textarea for emoji picker redirection
  this._activeEditTextarea = textarea;

  const btnRow = document.createElement('div');
  btnRow.className = 'edit-actions';
  btnRow.innerHTML = `<button class="edit-emoji-btn" title="${t('app.input_bar.emoji_btn')}">😀</button><button class="edit-save-btn">${t('modals.common.save')}</button><button class="edit-cancel-btn">${t('modals.common.cancel')}</button>`;
  contentEl.appendChild(btnRow);

  // Emoji button in edit bar opens the picker
  btnRow.querySelector('.edit-emoji-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    this._activeEditTextarea = textarea;
    this._toggleEmojiPicker();
  });

  textarea.focus();
  textarea.style.height = 'auto';
  textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';

  const cancel = () => {
    msgEl.classList.remove('editing');
    contentEl.innerHTML = originalHtml;
    if (this._activeEditTextarea === textarea) this._activeEditTextarea = null;
    // Close emoji picker if it was open for this edit
    const picker = document.getElementById('emoji-picker');
    if (picker) picker.style.display = 'none';
    // Close autocomplete dropdowns
    this._hideMentionDropdown();
    this._hideEmojiDropdown();
  };

  btnRow.querySelector('.edit-cancel-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    cancel();
  });
  btnRow.querySelector('.edit-save-btn').addEventListener('click', async (e) => {
    e.stopPropagation();
    e.preventDefault();
    let newContent = textarea.value.trim();
    if (!newContent) {
      // Discord-style: clearing the whole message and confirming the edit
      // offers to delete the message rather than silently cancelling it.
      // Enter confirms the prompt via the shared confirm modal.
      cancel();
      if (await this._showConfirmModal(t('confirm.delete_message'), '', { danger: true, confirmLabel: t('msg_toolbar.delete') })) {
        const pip = msgEl.closest('#dm-pip-messages') ? this._activeDMPip : null;
        const attachments = this._getMessageAttachments?.(msgId);
        this.socket.emit('delete-message', pip
          ? { messageId: msgId, channelCode: pip, attachments }
          : { messageId: msgId, attachments });
      }
      return;
    }
    if (newContent === rawText) return cancel();

    // E2E: encrypt edited DM content. The PiP can edit a DM that isn't
    // the active channel, so resolve the partner against the container's
    // channel code when available.
    const pipContext = msgEl.closest('#dm-pip-messages') ? this._activeDMPip : null;
    const partner = pipContext ? this._getE2EPartnerFor(pipContext) : this._getE2EPartner();
    if (partner) {
      try {
        newContent = await this.e2e.encrypt(newContent, partner.userId, partner.publicKeyJwk);
      } catch (err) {
        console.warn('[E2E] Failed to encrypt edited message:', err);
      }
    }

    const channelCode = pipContext || this.currentChannel;
    this.socket.emit('edit-message', { messageId: msgId, content: newContent, channelCode });
    cancel(); // will be updated by the server event
  });

  textarea.addEventListener('keydown', (e) => {
    e.stopPropagation();

    // Ctrl/Cmd+E toggles the emoji picker for this edit. The global shortcut
    // in app-ui.js can't fire here because we stopPropagation above, so it's
    // re-handled locally; _activeEditTextarea (set above) routes the pick into
    // this textarea rather than the main composer.
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key === 'e') {
      e.preventDefault();
      this._activeEditTextarea = textarea;
      this._toggleEmojiPicker();
      return;
    }

    // Handle @mention and :emoji dropdown navigation in edit mode
    const mentionDd = document.getElementById('mention-dropdown');
    if (mentionDd && mentionDd.style.display !== 'none') {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        this._navigateMentionDropdown(e.key === 'ArrowDown' ? 1 : -1);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        const active = mentionDd.querySelector('.mention-item.active');
        if (active) { e.preventDefault(); active.click(); return; }
      }
      if (e.key === 'Escape') { this._hideMentionDropdown(); return; }
    }
    const emojiDd = document.getElementById('emoji-dropdown');
    if (emojiDd && emojiDd.style.display !== 'none') {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        this._navigateEmojiDropdown(e.key === 'ArrowDown' ? 1 : -1);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        const active = emojiDd.querySelector('.emoji-ac-item.active');
        if (active) { e.preventDefault(); active.click(); return; }
      }
      if (e.key === 'Escape') { this._hideEmojiDropdown(); return; }
    }

    // Markdown formatting shortcuts
    if (this._handleMarkdownShortcuts(textarea, e)) {
      e.preventDefault();
      return;
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      btnRow.querySelector('.edit-save-btn').click();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  });

  textarea.addEventListener('paste', (e) => {
    if (this._handleMarkdownLinkPaste(textarea, e)) {
      e.preventDefault();
      return;
    }
  });

  // Enable @mention and :emoji autocomplete in edit textarea
  textarea.addEventListener('input', () => {
    this._checkMentionTrigger(textarea);
    this._checkChannelTrigger(textarea);
    this._checkEmojiTrigger(textarea);
  });

  // Click inside edit area should not bubble to delegation handler
  contentEl.addEventListener('click', (e) => {
    e.stopPropagation();
  }, { once: false });
},

// ═══════════════════════════════════════════════════════
// CLIENT-SIDE LINK POLICY (#5483, v3.44.0)
// ═══════════════════════════════════════════════════════
//
// End-to-end encrypted DMs are ciphertext by the time they reach the server,
// so the send-message automod path cannot see their links at all. The setting
// existed and did nothing for them, which is worse than not having it.
//
// The recipient's client CAN see them, after decryption and before rendering,
// and that is the check worth having. A hostile sender can run a patched
// client and skip any check on their own side, but they cannot reach into the
// recipient's browser and switch this off. So the enforcement that protects
// the person at risk is the one that runs where the risk lands.
//
// The rules themselves come from /js/automod-rules.js, the same file the
// server requires, so the two cannot drift into disagreeing.

// Is this container showing DM content?
//
// The first version of this looked for a [data-dm-render] attribute that does
// not exist: the DM PiP renderer marks a JS property on the message object,
// not the DOM. So the only branch that ever fired was the current-channel
// check, and a DM popped out over a normal channel was never recognised.
// @birdcrazy caught it (#5483). Detect the PiP container by its actual id.
_isDmContainer(containerEl) {
  try {
    if (containerEl) {
      if (containerEl.id === 'dm-pip-messages') return true;
      if (containerEl.closest && containerEl.closest('#dm-pip-messages, #dm-pip')) return true;
      if (containerEl.querySelector && containerEl.querySelector('#dm-pip-messages')) return true;
    }
    const ch = (this.channels || []).find(c => c.code === this.currentChannel);
    return !!(ch && ch.is_dm);
  } catch { return false; }
},

_initLinkPolicy() {
  this._linkPolicy = null;
  const apply = (p) => { this._linkPolicy = p && p.enabled ? p : null; };
  this.socket.on('link-policy', apply);
  this.socket.emit('get-link-policy', null, apply);
},

// Returns null when the text is fine, or { rule, host, url, message }.
// Safe to call before the policy has loaded: no policy means no verdict.
_checkLinkPolicy(text) {
  if (!this._linkPolicy || !window.HavenAutomodRules) return null;
  try {
    return window.HavenAutomodRules.checkText(text, this._linkPolicy);
  } catch { return null; }
},

// True when links in this text should be rendered inert rather than clickable.
// Applied to DM content specifically, since that is the path the server cannot
// inspect. Channel messages were already blocked at send time.
_dmLinkBlocked(text) {
  if (!this._linkPolicy || !this._linkPolicy.scanDms) return null;
  return this._checkLinkPolicy(text);
},

// One-time identity disclosure on DMs. Haven does not verify who anyone is,
// and on an open server someone can register a display name that matches a
// person you trust (the owner, a mod) and DM you as them. This is a nudge to
// check, not a control. Dismissed globally, remembered in localStorage.
_maybeShowDmSafetyNotice(container) {
  if (!container) return;
  try { if (localStorage.getItem('haven_dm_safety_dismissed') === '1') return; } catch { /* storage blocked (private mode): show the notice */ }
  // Already present in this container — don't stack copies on re-render.
  if (container.querySelector(':scope > .dm-safety-notice')) return;

  const notice = document.createElement('div');
  notice.className = 'dm-safety-notice';
  notice.innerHTML =
    '<span class="dm-safety-icon" aria-hidden="true">🛡️</span>' +
    `<span class="dm-safety-text">${t('dm_runtime.safety_notice')}</span>` +
    `<button type="button" class="dm-safety-dismiss">${t('dm_runtime.safety_dismiss')}</button>`;

  notice.querySelector('.dm-safety-dismiss').addEventListener('click', () => {
    try { localStorage.setItem('haven_dm_safety_dismissed', '1'); } catch { /* storage blocked (private mode): nothing is remembered, nothing else breaks */ }
    // Clear it everywhere it might be showing (main pane + any open PiP).
    document.querySelectorAll('.dm-safety-notice').forEach(n => n.remove());
  });

  container.insertBefore(notice, container.firstChild);
},

// Neutralise disallowed links in an already-rendered DM message container.
//
// Scoped to DMs on purpose. Channel messages were checked at send time, so
// running this there would only ever affect history that predates the current
// policy, and silently breaking old links nobody complained about is not a
// trade worth making.
//
// Anchors become plain text with a warning; images from disallowed hosts
// become a click-to-reveal placeholder rather than loading. The media proxy
// already stops the IP leak, so this is about the click, not the fetch.
_enforceDmLinkPolicy(containerEl) {
  if (!containerEl) return;
  const policy = this._linkPolicy;
  const R = window.HavenAutomodRules;
  if (!policy || !policy.scanDms || !R) return;

  const hostBlocked = (rawUrl) => {
    if (!rawUrl) return false;
    try {
      const u = new URL(rawUrl, location.href);
      if (u.origin === location.origin) return false;   // our own uploads / proxy
      // A data: or blob: address has no host to judge. A picture that has not
      // loaded yet carries a data: placeholder, and reading that as a host
      // turned the server's own uploads into "blocked domain" notices.
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
      return !R.checkHost(u.hostname, policy).allowed;
    } catch { return false; }
  };

  containerEl.querySelectorAll('.message-content a[href]').forEach(a => {
    if (a.dataset.policyChecked) return;
    a.dataset.policyChecked = '1';
    if (!hostBlocked(a.href)) return;

    let host = a.href;
    try { host = new URL(a.href).hostname; } catch { /* unparsable address: the tooltip shows it whole */ }
    const span = document.createElement('span');
    span.className = 'blocked-link';
    span.title = t('dm_runtime.blocked_link_tooltip', { host });
    span.textContent = a.textContent;
    const badge = document.createElement('span');
    badge.className = 'blocked-link-badge';
    badge.textContent = ` ⚠ ${t('dm_runtime.blocked_link_badge')}`;
    span.appendChild(badge);
    a.replaceWith(span);
  });

  containerEl.querySelectorAll('.message-content img[data-mp-origin], .message-content img.chat-image').forEach(img => {
    if (img.dataset.policyChecked) return;
    img.dataset.policyChecked = '1';
    const origin = img.dataset.mpOrigin || img.getAttribute('data-mp-src') || img.dataset.lazySrc || img.src;
    if (!hostBlocked(origin)) return;
    const ph = document.createElement('span');
    ph.className = 'hidden-image';
    ph.setAttribute('role', 'button');
    ph.tabIndex = 0;
    ph.dataset.hiddenSrc = origin;
    ph.textContent = t('dm_runtime.blocked_image');
    img.replaceWith(ph);
  });
},

};
