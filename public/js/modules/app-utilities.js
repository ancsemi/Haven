export default {

// ── Utilities ─────────────────────────────────────────

/** Sanitize a CSS color value – only allow hex (#RGB / #RRGGBB), rgb(), hsl(), or CSS variables */
_safeColor(c, fallback = '') {
  if (typeof c !== 'string') return fallback;
  const s = c.trim();
  if (/^#[0-9a-fA-F]{3,6}$/.test(s)) return s;
  if (/^(rgb|hsl)a?\([0-9,\s.%]+\)$/.test(s)) return s;
  if (/^var\(--[a-zA-Z0-9-]+\)$/.test(s)) return s;
  return fallback;
},

_isImageUrl(str) {
  if (!str) return false;
  const trimmed = str.trim();
  if (trimmed.startsWith('e2e-img:')) return true;
  if (/^\/uploads\/[\w\-]+\.(jpg|jpeg|png|gif|webp)$/i.test(trimmed)) return true;
  if (/^https?:\/\/.+\.(jpg|jpeg|png|gif|webp)(\?[^"'<>]*)?$/i.test(trimmed)) return true;
  // GIPHY GIF URLs (may not have file extensions)
  if (/^https:\/\/media\d*\.giphy\.com\/.+/i.test(trimmed)) return true;
  return false;
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
  const customMatches = str.match(/:([a-zA-Z0-9_-]+):/g) || [];
  // Only expand custom tokens that actually exist as loaded emojis
  const resolvedCustom = customMatches.filter(m => {
    const name = m.slice(1, -1).toLowerCase();
    return this.customEmojis && this.customEmojis.some(e => e.name === name);
  });
  let s = str.replace(/:([a-zA-Z0-9_-]+):/g, ' ');
  try {
    // Strip unicode emoji, modifiers, ZWJ, variation selectors, flags
    s = s.replace(/[\p{Extended_Pictographic}\u{FE00}-\u{FEFF}\u{200D}\u{20E3}\u{1F1E0}-\u{1F1FF}]/gu, '');
  } catch {
    s = s.replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE00}-\u{FEFF}\u{200D}\u{20E3}]/gu, '');
  }
  if (s.trim().length > 0) return false;
  let unicodeCount = 0;
  try { unicodeCount = (str.match(/[\p{Extended_Pictographic}]/gu) || []).length; } catch {}
  const total = resolvedCustom.length + unicodeCount;
  return total >= 1 && total <= 27;
},

_formatContent(str) {
  // E2E encrypted image: e2e-img:<mime>:<url>
  const e2eImgMatch = str.match(/^e2e-img:(image\/(?:jpeg|png|gif|webp)):(\/uploads\/[\w\-.]+)$/i);
  if (e2eImgMatch) {
    const mime = this._escapeHtml(e2eImgMatch[1]);
    const url = this._escapeHtml(e2eImgMatch[2]);
    return `<img data-e2e-src="${url}" data-e2e-mime="${mime}" class="chat-image e2e-img-pending" alt="Encrypted image" title="🔒 End-to-end encrypted image">`;
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
      mp3: '🎵', ogg: '🎵', wav: '🎵', flac: '🎵', aac: '🎵', wma: '🎵',
      mp4: '🎬', webm: '🎬', mkv: '🎬', avi: '🎬', mov: '🎬', flv: '🎬',
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
    // Audio/video get inline players
    if (['mp3', 'ogg', 'wav'].includes(ext)) {
      return `<div class="file-attachment">
        <div class="file-info">${icon} <span class="file-name">${fileName}</span> <span class="file-size">(${fileSize})</span></div>
        <audio controls preload="none" src="${fileUrl}"></audio>
      </div>`;
    }
    if (['mp4', 'webm'].includes(ext)) {
      return `<div class="file-attachment">
        <div class="file-info">${icon} <span class="file-name">${fileName}</span> <span class="file-size">(${fileSize})</span></div>
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

  // Render server-hosted images inline (early return)
  // No loading="lazy" — content-visibility:auto on .message already skips off-screen
  // rendering; lazy loading on top creates 0→real-height jumps when scrolling history.
  if (/^\/uploads\/[\w\-]+\.(jpg|jpeg|png|gif|webp)$/i.test(str.trim())) {
    return `<img src="${this._escapeHtml(str.trim())}" class="chat-image" alt="image">`;
  }

  // ── Extract fenced code blocks before escaping ──
  const codeBlocks = [];
  const withPlaceholders = str.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push({ lang: lang || '', code });
    return `\x00CODEBLOCK_${idx}\x00`;
  });

  let html = this._escapeHtml(withPlaceholders);

  // ── Markdown images & links (extract before auto-linking) ──
  const mdLinks = [];
  // ![alt](url)
  html = html.replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g, (full, alt, url) => {
    try { new URL(url); } catch { return full; }
    const safeUrl = url.replace(/['"<>]/g, '');
    const idx = mdLinks.length;
    mdLinks.push(`<img src="${safeUrl}" class="chat-image" alt="${alt || 'image'}">`);
    return `\x00MDLINK_${idx}\x00`;
  });
  // [text](url)
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (full, text, url) => {
    try { new URL(url); } catch { return full; }
    const safeUrl = url.replace(/['"<>]/g, '');
    const idx = mdLinks.length;
    mdLinks.push(`<a href="${safeUrl}" target="_blank" rel="noopener noreferrer nofollow" title="${safeUrl}" data-masked-link="true">${text}</a>`);
    return `\x00MDLINK_${idx}\x00`;
  });

  // Auto-link URLs (and render image URLs as inline images)
  // Use placeholders to prevent @mention regex from matching inside URLs
  const autoLinks = [];
  html = html.replace(
    /\bhttps?:\/\/[a-zA-Z0-9\-._~:/?#\[\]@!$&()*+,;=%]+/g,
    (url) => {
      try { new URL(url); } catch { return url; }
      const safeUrl = url.replace(/['"<>]/g, '');
      const idx = autoLinks.length;
      if (/\.(jpg|jpeg|png|gif|webp)(\?[^"'<>]*)?$/i.test(safeUrl) ||
          /^https:\/\/media\d*\.giphy\.com\//i.test(safeUrl)) {
        autoLinks.push(`<img src="${safeUrl}" class="chat-image" alt="image" loading="lazy">`);
      } else {
        autoLinks.push(`<a href="${safeUrl}" target="_blank" rel="noopener noreferrer nofollow">${safeUrl}</a>`);
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
  if (Array.isArray(this.channelMembers)) {
    for (const m of this.channelMembers) {
      if (!m) continue;
      if (m.loginName) {
        validNames.add(m.loginName.toLowerCase());
        loginToDisplay.set(m.loginName.toLowerCase(), m.username || m.loginName);
      }
      if (m.username) {
        validNames.add(m.username.toLowerCase());
        displayToLogin.set(m.username.toLowerCase(), m.loginName || m.username);
      }
    }
  }
  const selfLogin = (this.user.username || '').toLowerCase();
  if (selfLogin) validNames.add(selfLogin);
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
    const display = loginToDisplay.get(lower) || name;
    return `<span class="mention${isSelf ? ' mention-self' : ''}">@${this._escapeHtml(display)}</span>`;
  });

  // Render spoilers (||text||) — CSP-safe, uses delegated click handler
  html = html.replace(/\|\|(.+?)\|\|/g, '<span class="spoiler">$1</span>');

  // Render custom emojis :name:
  if (this.customEmojis && this.customEmojis.length > 0) {
    html = html.replace(/:([a-zA-Z0-9_-]+):/g, (match, name) => {
      const emoji = this.customEmojis.find(e => e.name === name.toLowerCase());
      if (emoji) return `<img src="${this._escapeHtml(emoji.url)}" alt=":${this._escapeHtml(name)}:" title=":${this._escapeHtml(name)}:" class="custom-emoji">`;
      return match;
    });
  }

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
  const blockquotes = [];
  html = html.replace(/(^|\n)((?:&gt;[^\n]*(?:\n|$))+)/g, (full, pre, block) => {
    const lines = block.trim().split('\n').map(line => line.replace(/^&gt;\s?/, ''));
    let authorHtml = '';
    if (lines[0] && /^@[^\s].+ wrote:$/.test(lines[0])) {
      authorHtml = `<div class="chat-blockquote-author">${lines.shift()}</div>`;
    }
    const textHtml = lines.join('<br>');
    const idx = blockquotes.length;
    blockquotes.push(`${pre}<blockquote class="chat-blockquote">${authorHtml}<div class="chat-blockquote-body">${textHtml}</div></blockquote>`);
    return `\x00BLOCKQUOTE_${idx}\x00`;
  });

  // ── Headings: # H1, ## H2, ### H3 at start of line ──
  html = html.replace(/(^|\n)(#{1,3})\s+(.+)/g, (_, pre, hashes, text) => {
    const level = hashes.length;
    return `${pre}<div class="chat-heading chat-h${level}">${text}</div>`;
  });

  // ── Horizontal rules: --- or ___ on their own line (3+ chars) ──
  html = html.replace(/(^|\n)([-]{3,}|[_]{3,})\s*(?=\n|$)/g, '$1<hr class="chat-hr">');

  // ── Unordered lists: consecutive lines starting with "- " ──
  html = html.replace(/((?:(?:^|\n)- .+)+)/g, (match) => {
    const items = match.trim().split('\n').map(line =>
      `<li>${line.replace(/^- /, '')}</li>`
    ).join('');
    return `\n<ul class="chat-list">${items}</ul>`;
  });

  // ── Ordered lists: consecutive lines starting with "N. " ──
  html = html.replace(/((?:(?:^|\n)\d+\.\s+.+)+)/g, (match) => {
    const lines = match.trim().split('\n');
    const startNum = lines[0].match(/^(\d+)/)?.[1] || '1';
    const items = lines.map(line =>
      `<li>${line.replace(/^\d+\.\s+/, '')}</li>`
    ).join('');
    return `\n<ol class="chat-list" start="${startNum}">${items}</ol>`;
  });

  html = html.replace(/\n/g, '<br>');

  blockquotes.forEach((block, idx) => {
    html = html.replace(`\x00BLOCKQUOTE_${idx}\x00`, block);
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

  if (emojiOnly) html = `<span class="emoji-only-msg">${html}</span>`;

  return html;
},

_formatTime(dateStr) {
  const date = new Date(dateStr);
  const now = new Date();
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const isToday = date.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday = date.toDateString() === yesterday.toDateString();

  if (isToday) return t('utils.today_at', { time });
  if (isYesterday) return t('utils.yesterday_at', { time });
  return `${date.toLocaleDateString()} ${time}`;
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

/** Show a one-time notice about the Account Recovery feature */
_showRecoveryNotice() {
  // Guard: only show once
  if (localStorage.getItem('haven_recovery_notice_v1')) return;

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

  const dismiss = () => {
    if (document.getElementById('recovery-notice-dsa')?.checked) {
      localStorage.setItem('haven_recovery_notice_v1', '1');
    }
    overlay.remove();
  };

  document.getElementById('recovery-notice-close').addEventListener('click', dismiss);
  document.getElementById('recovery-notice-go').addEventListener('click', () => {
    if (document.getElementById('recovery-notice-dsa')?.checked) {
      localStorage.setItem('haven_recovery_notice_v1', '1');
    }
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
      <h3 style="color:var(--text-primary,#dbdee1)">External Link</h3>
      <p>You're about to visit:</p>
      <p style="background:var(--bg-tertiary,#232428);padding:8px 12px;border-radius:6px;font-size:13px;word-break:break-all;color:var(--accent,#5865f2)">${this._escapeHtml(url)}</p>
      <p class="risky-download-desc">Make sure you trust this link before continuing.</p>
      <div class="risky-download-actions">
        <button class="risky-download-cancel">Cancel</button>
        <button class="risky-download-confirm" style="background:var(--accent,#5865f2)">Open Link</button>
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
      <h3>Potentially Harmful File</h3>
      <p><strong>${this._escapeHtml(fileName)}</strong></p>
      <p class="risky-download-desc">
        <strong>.${this._escapeHtml(ext)}</strong> files can be dangerous and may harm your
        device if they come from an untrusted source. Only download this if
        you trust the sender.
      </p>
      <div class="risky-download-actions">
        <button class="risky-download-cancel">Cancel</button>
        <button class="risky-download-confirm">Download Anyway</button>
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
// EMOJI PICKER (categorized + searchable)
// ═══════════════════════════════════════════════════════

_toggleEmojiPicker() {
  const picker = document.getElementById('emoji-picker');
  if (picker.style.display === 'flex') {
    picker.style.display = 'none';
    return;
  }
  picker.innerHTML = '';
  this._emojiActiveCategory = this._emojiActiveCategory || Object.keys(this.emojiCategories)[0];

  // Search bar
  const searchRow = document.createElement('div');
  searchRow.className = 'emoji-search-row';
  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.className = 'emoji-search-input';
  searchInput.placeholder = t('emoji.search_placeholder');
  searchInput.maxLength = 30;
  searchRow.appendChild(searchInput);
  picker.appendChild(searchRow);

  // Build combined categories (standard + custom)
  const allCategories = { ...this.emojiCategories };
  const hasCustom = this.customEmojis && this.customEmojis.length > 0;
  if (hasCustom) {
    allCategories['Custom'] = this.customEmojis.map(e => `:${e.name}:`);
  }

  // Category tabs
  const tabRow = document.createElement('div');
  tabRow.className = 'emoji-tab-row';
  const catIcons = { 'Smileys':'😀', 'People':'👋', 'Animals':'🐶', 'Food':'🍕', 'Activities':'🎮', 'Travel':'🚀', 'Objects':'💡', 'Symbols':'❤️', 'Custom':'⭐' };
  for (const cat of Object.keys(allCategories)) {
    const tab = document.createElement('button');
    tab.className = 'emoji-tab' + (cat === this._emojiActiveCategory ? ' active' : '');
    tab.textContent = catIcons[cat] || cat.charAt(0);
    tab.title = t(`emoji.categories.${cat.toLowerCase()}`) || cat;
    tab.addEventListener('click', () => {
      this._emojiActiveCategory = cat;
      searchInput.value = '';
      renderGrid();
      tabRow.querySelectorAll('.emoji-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
    });
    tabRow.appendChild(tab);
  }
  picker.appendChild(tabRow);

  // Grid
  const grid = document.createElement('div');
  grid.className = 'emoji-grid';
  picker.appendChild(grid);

  const self = this;
  function renderGrid(filter) {
    grid.innerHTML = '';
    let emojis;
    if (filter) {
      const q = filter.toLowerCase();
      const matched = new Set();
      // Search by emoji name keywords
      for (const [emoji, keywords] of Object.entries(self.emojiNames)) {
        if (keywords.toLowerCase().includes(q)) matched.add(emoji);
      }
      // Also search by category name
      for (const [cat, list] of Object.entries(self.emojiCategories)) {
        if (cat.toLowerCase().includes(q)) list.forEach(e => matched.add(e));
      }
      // Search custom emojis by name
      if (self.customEmojis) {
        self.customEmojis.forEach(e => {
          if (e.name.toLowerCase().includes(q)) matched.add(`:${e.name}:`);
        });
      }
      emojis = matched.size > 0 ? [...matched] : [];
    } else {
      emojis = allCategories[self._emojiActiveCategory] || self.emojis;
    }
    if (filter && emojis.length === 0) {
      grid.innerHTML = `<p class="muted-text" style="padding:12px;font-size:12px;width:100%;text-align:center">${t('emoji.no_results')}</p>`;
      return;
    }
    emojis.forEach(emoji => {
      const btn = document.createElement('button');
      btn.className = 'emoji-item';
      // Check if it's a custom emoji (:name:)
      const customMatch = typeof emoji === 'string' && emoji.match(/^:([a-zA-Z0-9_-]+):$/);
      if (customMatch) {
        const ce = self.customEmojis.find(e => e.name === customMatch[1]);
        if (ce) {
          btn.innerHTML = `<img src="${self._escapeHtml(ce.url)}" alt=":${self._escapeHtml(ce.name)}:" title=":${self._escapeHtml(ce.name)}:" class="custom-emoji">`;
        } else {
          btn.textContent = emoji;
        }
      } else {
        btn.textContent = emoji;
      }
      btn.addEventListener('click', () => {
        // Insert into the active edit textarea if editing, otherwise the main input
        const input = self._activeEditTextarea || document.getElementById('message-input');
        const start = input.selectionStart;
        const end = input.selectionEnd;
        input.value = input.value.substring(0, start) + emoji + input.value.substring(end);
        input.selectionStart = input.selectionEnd = start + emoji.length;
        input.focus();
      });
      grid.appendChild(btn);
    });
  }

  searchInput.addEventListener('input', () => {
    const q = searchInput.value.trim();
    renderGrid(q || null);
  });

  renderGrid();

  // On mobile with the iOS keyboard open, dynamically position the picker
  // above the input area using the visual viewport so it doesn't push
  // content off-screen.
  if (window.innerWidth <= 480 && window.visualViewport) {
    const vvHeight = window.visualViewport.height;
    const inputArea = document.getElementById('message-input-area');
    if (inputArea) {
      const inputRect = inputArea.getBoundingClientRect();
      picker.style.bottom = (window.innerHeight - inputRect.top) + 'px';
    }
  }

  picker.style.display = 'flex';
  searchInput.focus();
},

// ═══════════════════════════════════════════════════════
// GIF PICKER (GIPHY)
// ═══════════════════════════════════════════════════════

_setupGifPicker() {
  const btn = document.getElementById('gif-btn');
  const picker = document.getElementById('gif-picker');
  const searchInput = document.getElementById('gif-search-input');
  const grid = document.getElementById('gif-grid');
  if (!btn || !picker) return;

  this._gifDebounce = null;

  btn.addEventListener('click', () => {
    if (picker.style.display === 'flex') {
      picker.style.display = 'none';
      return;
    }
    // Close emoji picker if open
    document.getElementById('emoji-picker').style.display = 'none';
    picker.style.display = 'flex';
    searchInput.value = '';
    searchInput.focus();
    this._loadTrendingGifs();
  });

  // Close when clicking outside
  document.addEventListener('click', (e) => {
    if (picker.style.display !== 'none' &&
        !picker.contains(e.target) && !btn.contains(e.target)) {
      picker.style.display = 'none';
    }
  });

  // Search on typing with debounce
  searchInput.addEventListener('input', () => {
    clearTimeout(this._gifDebounce);
    const q = searchInput.value.trim();
    if (!q) {
      this._loadTrendingGifs();
      return;
    }
    this._gifDebounce = setTimeout(() => this._searchGifs(q), 350);
  });

  // Click on a GIF to send it
  grid.addEventListener('click', (e) => {
    const img = e.target.closest('img');
    if (!img || !img.dataset.full) return;
    this._sendGifMessage(img.dataset.full);
    picker.style.display = 'none';
  });
},

_loadTrendingGifs() {
  const grid = document.getElementById('gif-grid');
  grid.innerHTML = '<div class="gif-picker-empty">Loading...</div>';
  fetch('/api/gif/trending?limit=20', {
    headers: { 'Authorization': `Bearer ${this.token}` }
  })
    .then(r => r.json())
    .then(data => {
      if (data.error === 'gif_not_configured') {
        this._showGifSetupGuide(grid);
        return;
      }
      if (data.error) {
        grid.innerHTML = `<div class="gif-picker-empty">${this._escapeHtml(data.error)}</div>`;
        return;
      }
      this._renderGifGrid(data.results || []);
    })
    .catch(() => {
      grid.innerHTML = '<div class="gif-picker-empty">Failed to load GIFs</div>';
    });
},

_searchGifs(query) {
  const grid = document.getElementById('gif-grid');
  grid.innerHTML = `<div class="gif-picker-empty">${t('gifs.searching')}</div>`;
  fetch(`/api/gif/search?q=${encodeURIComponent(query)}&limit=20`, {
    headers: { 'Authorization': `Bearer ${this.token}` }
  })
    .then(r => r.json())
    .then(data => {
      if (data.error === 'gif_not_configured') {
        this._showGifSetupGuide(grid);
        return;
      }
      if (data.error) {
        grid.innerHTML = `<div class="gif-picker-empty">${this._escapeHtml(data.error)}</div>`;
        return;
      }
      const results = data.results || [];
      if (results.length === 0) {
        grid.innerHTML = `<div class="gif-picker-empty">${t('gifs.no_results')}</div>`;
        return;
      }
      this._renderGifGrid(results);
    })
    .catch(() => {
      grid.innerHTML = `<div class="gif-picker-empty">${t('gifs.search_failed')}</div>`;
    });
},

_showGifSetupGuide(grid) {
  const isAdmin = this.user && this.user.isAdmin;
  if (isAdmin) {
    grid.innerHTML = `
      <div class="gif-setup-guide">
        <h3>🎞️ ${t('gifs.setup.title')}</h3>
        <p>${t('gifs.setup.powered_by')}</p>
        <ol>
          <li>${t('gifs.setup.step_1')}</li>
          <li>${t('gifs.setup.step_2')}</li>
          <li>${t('gifs.setup.step_3')}</li>
          <li>${t('gifs.setup.step_4')}</li>
          <li>${t('gifs.setup.step_5')}</li>
        </ol>
        <div class="gif-setup-input-row">
          <input type="text" id="gif-giphy-key-input" placeholder="${t('gifs.setup.key_placeholder')}" spellcheck="false" autocomplete="off" />
          <button id="gif-giphy-key-save">${t('gifs.setup.save_btn')}</button>
        </div>
        <p class="gif-setup-note">💡 ${t('gifs.setup.note')}</p>
      </div>`;
    const saveBtn = document.getElementById('gif-giphy-key-save');
    const input = document.getElementById('gif-giphy-key-input');
    saveBtn.addEventListener('click', () => {
      const key = input.value.trim();
      if (!key) return;
      this.socket.emit('update-server-setting', { key: 'giphy_api_key', value: key });
      grid.innerHTML = `<div class="gif-picker-empty">${t('gifs.setup.saved')}</div>`;
      setTimeout(() => this._loadTrendingGifs(), 500);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') saveBtn.click();
    });
  } else {
    grid.innerHTML = `
      <div class="gif-setup-guide">
        <h3>🎞️ ${t('gifs.setup.unavailable_title')}</h3>
        <p>${t('gifs.setup.unavailable_desc')}</p>
      </div>`;
  }
},

_renderGifGrid(results) {
  const grid = document.getElementById('gif-grid');
  grid.innerHTML = '';
  results.forEach(gif => {
    if (!gif.tiny) return;
    const img = document.createElement('img');
    img.src = gif.tiny;
    img.alt = gif.title || 'GIF';
    img.loading = 'lazy';
    img.dataset.full = gif.full || gif.tiny;
    grid.appendChild(img);
  });
},

_sendGifMessage(url) {
  if (!this.currentChannel || !url) return;
  const payload = {
    code: this.currentChannel,
    content: url,
  };
  if (this.replyingTo) {
    payload.replyTo = this.replyingTo.id;
    this._clearReply();
  }
  this.socket.emit('send-message', payload);
  this.notifications.play('sent');
},

// /gif slash command — inline GIF search results above the input
_showGifSlashResults(query) {
  // Remove any existing picker
  document.getElementById('gif-slash-picker')?.remove();

  const picker = document.createElement('div');
  picker.id = 'gif-slash-picker';
  picker.className = 'gif-slash-picker';
  picker.innerHTML = '<div class="gif-slash-loading">Searching GIFs...</div>';

  // Position above the message input
  const inputArea = document.querySelector('.message-input-area');
  inputArea.parentElement.insertBefore(picker, inputArea);

  // Close on click outside
  const closeOnClick = (e) => {
    if (!picker.contains(e.target)) { picker.remove(); document.removeEventListener('click', closeOnClick); }
  };
  setTimeout(() => document.addEventListener('click', closeOnClick), 100);

  // Close on Escape
  const closeOnEsc = (e) => {
    if (e.key === 'Escape') { picker.remove(); document.removeEventListener('keydown', closeOnEsc); }
  };
  document.addEventListener('keydown', closeOnEsc);

  fetch(`/api/gif/search?q=${encodeURIComponent(query)}&limit=12`, {
    headers: { 'Authorization': `Bearer ${this.token}` }
  })
    .then(r => r.json())
    .then(data => {
      if (data.error === 'gif_not_configured') {
        picker.innerHTML = '<div class="gif-slash-loading">GIF search not configured — an admin needs to set up the GIPHY API key (use the GIF button 🎞️)</div>';
        return;
      }
      if (data.error) { picker.innerHTML = `<div class="gif-slash-loading">${this._escapeHtml(data.error)}</div>`; return; }
      const results = data.results || [];
      if (results.length === 0) { picker.innerHTML = '<div class="gif-slash-loading">No GIFs found</div>'; return; }

      picker.innerHTML = `<div class="gif-slash-header"><span>/gif ${this._escapeHtml(query)}</span><button class="icon-btn small gif-slash-close">&times;</button></div><div class="gif-slash-grid"></div>`;
      const grid = picker.querySelector('.gif-slash-grid');
      picker.querySelector('.gif-slash-close').addEventListener('click', () => picker.remove());

      results.forEach(gif => {
        if (!gif.tiny) return;
        const img = document.createElement('img');
        img.src = gif.tiny;
        img.alt = gif.title || 'GIF';
        img.loading = 'lazy';
        img.dataset.full = gif.full || gif.tiny;
        img.addEventListener('click', () => {
          this._sendGifMessage(img.dataset.full);
          picker.remove();
          document.removeEventListener('click', closeOnClick);
          document.removeEventListener('keydown', closeOnEsc);
        });
        grid.appendChild(img);
      });
    })
    .catch(() => {
      picker.innerHTML = '<div class="gif-slash-loading">GIF search failed</div>';
    });
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
    return `<button class="poll-option${myVote ? ' poll-voted' : ''}" data-msg-id="${msgId}" data-option="${i}" title="${voterNames}">
      <div class="poll-option-bar" style="width:${pct}%"></div>
      <span class="poll-option-text">${this._escapeHtml(opt)}</span>
      <span class="poll-option-count">${count} (${pct}%)</span>
    </button>`;
  }).join('');

  const settings = [];
  if (poll.multiVote) settings.push('Multiple votes');
  if (poll.anonymous) settings.push('Anonymous');
  const settingsHtml = settings.length ? `<div class="poll-settings-info">${settings.join(' · ')}</div>` : '';

  return `<div class="poll-widget" data-msg-id="${msgId}">
    <div class="poll-question">${this._escapeHtml(poll.question)}</div>
    <div class="poll-options">${optionsHtml}</div>
    <div class="poll-footer">${totalVotes} vote${totalVotes !== 1 ? 's' : ''}${settingsHtml ? ' · ' : ''}${settingsHtml}</div>
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
    footer.innerHTML = `${totalVotes} vote${totalVotes !== 1 ? 's' : ''}${settingsHtml}`;
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
    let emojiDisplay = g.emoji;
    if (customMatch && this.customEmojis) {
      const ce = this.customEmojis.find(e => e.name === customMatch[1]);
      if (ce) emojiDisplay = `<img src="${this._escapeHtml(ce.url)}" alt=":${this._escapeHtml(ce.name)}:" class="custom-emoji reaction-custom-emoji">`;
    }
    return `<button class="reaction-badge${isOwn ? ' own' : ''}" data-emoji="${this._escapeHtml(g.emoji)}" data-users="${usersJson}" title="${names}">${emojiDisplay} ${g.users.length}</button>`;
  }).join('');

  return `<div class="reactions-row">${badges}</div>`;
},

_updateMessageReactions(messageId, reactions) {
  const msgEl = document.querySelector(`[data-msg-id="${messageId}"]`);
  if (!msgEl) return;

  const wasAtBottom = this._coupledToBottom;

  // Remove old reactions row
  const oldRow = msgEl.querySelector('.reactions-row');
  if (oldRow) oldRow.remove();

  // Add new reactions
  const html = this._renderReactions(messageId, reactions);
  if (!html) { if (wasAtBottom) this._scrollToBottom(true); return; }

  // Find where to insert — after main or thread message content
  const content = msgEl.querySelector('.message-content, .thread-msg-content');
  if (content) {
    content.insertAdjacentHTML('afterend', html);
  }

  if (wasAtBottom) this._scrollToBottom(true);
},

// ── Reaction popout (who reacted) ─────────────────────

_showReactionPopout(badge) {
  this._hideReactionPopout();
  let users;
  try { users = JSON.parse(badge.dataset.users || '[]'); } catch { return; }
  if (!users.length) return;

  const emoji = badge.dataset.emoji;
  const customMatch = emoji.match(/^:([a-zA-Z0-9_-]+):$/);
  let emojiDisplay = emoji;
  if (customMatch && this.customEmojis) {
    const ce = this.customEmojis.find(e => e.name === customMatch[1]);
    if (ce) emojiDisplay = `<img src="${this._escapeHtml(ce.url)}" alt=":${this._escapeHtml(ce.name)}:" class="custom-emoji reaction-custom-emoji">`;
  }

  const popout = document.createElement('div');
  popout.id = 'reaction-popout';
  popout.className = 'reaction-popout';
  popout.innerHTML = `
    <div class="reaction-popout-header">${emojiDisplay} <span class="reaction-popout-count">${users.length}</span></div>
    <div class="reaction-popout-list">
      ${users.map(u => `<div class="reaction-popout-user">${this._escapeHtml(u)}</div>`).join('')}
    </div>
  `;
  document.body.appendChild(popout);

  // Position above the badge
  const rect = badge.getBoundingClientRect();
  popout.style.left = rect.left + 'px';
  popout.style.top = (rect.top - popout.offsetHeight - 6) + 'px';
  // Clamp to viewport
  const pr = popout.getBoundingClientRect();
  if (pr.right > window.innerWidth) popout.style.left = (window.innerWidth - pr.width - 8) + 'px';
  if (pr.left < 0) popout.style.left = '8px';
  if (pr.top < 0) popout.style.top = (rect.bottom + 6) + 'px';
},

_hideReactionPopout() {
  const existing = document.getElementById('reaction-popout');
  if (existing) existing.remove();
},

_getQuickEmojis() {
  const saved = localStorage.getItem('haven_quick_emojis');
  if (saved) {
    try { const arr = JSON.parse(saved); if (Array.isArray(arr) && arr.length === 8) return arr; } catch {}
  }
  return ['👍','👎','😂','❤️','🔥','💯','😮','😢'];
},

_saveQuickEmojis(emojis) {
  localStorage.setItem('haven_quick_emojis', JSON.stringify(emojis));
},

_showQuickEmojiEditor(picker, msgEl, msgId) {
  // Remove any existing editor
  document.querySelectorAll('.quick-emoji-editor').forEach(el => el.remove());

  const editor = document.createElement('div');
  editor.className = 'quick-emoji-editor reaction-full-picker';

  const title = document.createElement('div');
  title.className = 'reaction-full-category';
  title.textContent = t('emoji.customize_quick_title');
  editor.appendChild(title);

  const hint = document.createElement('p');
  hint.className = 'muted-text';
  hint.style.cssText = 'font-size:11px;padding:0 8px 6px;margin:0';
  hint.textContent = t('emoji.customize_quick_hint');
  editor.appendChild(hint);

  // Current slots
  const current = this._getQuickEmojis();
  const slotsRow = document.createElement('div');
  slotsRow.className = 'quick-emoji-slots';
  let activeSlot = null;

  const renderSlots = () => {
    slotsRow.innerHTML = '';
    current.forEach((emoji, i) => {
      const slot = document.createElement('button');
      slot.className = 'reaction-pick-btn quick-emoji-slot' + (activeSlot === i ? ' active' : '');
      // Check for custom emoji
      const customMatch = emoji.match(/^:([a-zA-Z0-9_-]+):$/);
      if (customMatch && this.customEmojis) {
        const ce = this.customEmojis.find(e => e.name === customMatch[1]);
        if (ce) slot.innerHTML = `<img src="${this._escapeHtml(ce.url)}" alt="${this._escapeHtml(emoji)}" class="custom-emoji" style="width:20px;height:20px">`;
        else slot.textContent = emoji;
      } else {
        slot.textContent = emoji;
      }
      slot.addEventListener('click', (e) => {
        e.stopPropagation();
        activeSlot = i;
        renderSlots();
      });
      slotsRow.appendChild(slot);
    });
  };
  renderSlots();
  editor.appendChild(slotsRow);

  // Emoji grid for selection
  const grid = document.createElement('div');
  grid.className = 'reaction-full-grid';
  grid.style.maxHeight = '180px';

  const renderOptions = () => {
    grid.innerHTML = '';
    // Standard emojis
    for (const [category, emojis] of Object.entries(this.emojiCategories)) {
      const label = document.createElement('div');
      label.className = 'reaction-full-category';
      label.textContent = t(`emoji.categories.${category.toLowerCase()}`) || category;
      grid.appendChild(label);

      const row = document.createElement('div');
      row.className = 'reaction-full-row';
      emojis.forEach(emoji => {
        const btn = document.createElement('button');
        btn.className = 'reaction-full-btn';
        btn.textContent = emoji;
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (activeSlot !== null) {
            current[activeSlot] = emoji;
            this._saveQuickEmojis(current);
            renderSlots();
          }
        });
        row.appendChild(btn);
      });
      grid.appendChild(row);
    }
    // Custom emojis
    if (this.customEmojis && this.customEmojis.length > 0) {
      const label = document.createElement('div');
      label.className = 'reaction-full-category';
      label.textContent = t('emoji.categories.custom');
      grid.appendChild(label);

      const row = document.createElement('div');
      row.className = 'reaction-full-row';
      this.customEmojis.forEach(ce => {
        const btn = document.createElement('button');
        btn.className = 'reaction-full-btn';
        btn.innerHTML = `<img src="${this._escapeHtml(ce.url)}" alt=":${this._escapeHtml(ce.name)}:" class="custom-emoji" style="width:22px;height:22px">`;
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (activeSlot !== null) {
            current[activeSlot] = `:${ce.name}:`;
            this._saveQuickEmojis(current);
            renderSlots();
          }
        });
        row.appendChild(btn);
      });
      grid.appendChild(row);
    }
  };
  renderOptions();
  editor.appendChild(grid);

  // Done button
  const doneBtn = document.createElement('button');
  doneBtn.className = 'btn-sm btn-accent';
  doneBtn.style.cssText = 'margin:8px;width:calc(100% - 16px)';
  doneBtn.textContent = t('modals.common.done');
  doneBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    editor.remove();
  });
  editor.appendChild(doneBtn);

  msgEl.appendChild(editor);
},

_showReactionPicker(msgEl, msgId) {
  // Toggle: if this message already has a picker open, close it and bail
  const existingPicker = msgEl.querySelector('.reaction-picker');
  if (existingPicker) {
    existingPicker.remove();
    msgEl.classList.remove('showing-picker');
    document.querySelectorAll('.reaction-full-picker').forEach(el => el.remove());
    document.querySelectorAll('.quick-emoji-editor').forEach(el => el.remove());
    if (this._reactionPickerClose) {
      document.removeEventListener('click', this._reactionPickerClose);
      this._reactionPickerClose = null;
    }
    return;
  }

  // Clean up previous close-on-click-outside handler so it can't
  // interfere with the new picker (e.g. removing showing-picker class).
  if (this._reactionPickerClose) {
    document.removeEventListener('click', this._reactionPickerClose);
    this._reactionPickerClose = null;
  }
  document.querySelectorAll('.showing-picker').forEach(el => el.classList.remove('showing-picker'));
  document.querySelectorAll('.reaction-picker').forEach(el => el.remove());
  document.querySelectorAll('.reaction-full-picker').forEach(el => el.remove());
  document.querySelectorAll('.quick-emoji-editor').forEach(el => el.remove());

  // Disable content-visibility containment so the picker isn't clipped
  msgEl.classList.add('showing-picker');

  const picker = document.createElement('div');
  picker.className = 'reaction-picker';
  const quickEmojis = this._getQuickEmojis();
  quickEmojis.forEach(emoji => {
    const btn = document.createElement('button');
    btn.className = 'reaction-pick-btn';
    // Check for custom emoji
    const customMatch = emoji.match(/^:([a-zA-Z0-9_-]+):$/);
    if (customMatch && this.customEmojis) {
      const ce = this.customEmojis.find(e => e.name === customMatch[1]);
      if (ce) btn.innerHTML = `<img src="${this._escapeHtml(ce.url)}" alt="${this._escapeHtml(emoji)}" class="custom-emoji" style="width:20px;height:20px">`;
      else btn.textContent = emoji;
    } else {
      btn.textContent = emoji;
    }
    btn.addEventListener('click', () => {
      this.socket.emit('add-reaction', { messageId: msgId, emoji });
      picker.remove();
      msgEl.classList.remove('showing-picker');
      if (this._reactionPickerClose) {
        document.removeEventListener('click', this._reactionPickerClose);
        this._reactionPickerClose = null;
      }
    });
    picker.appendChild(btn);
  });

  // "..." button opens the full emoji picker for reactions
  const moreBtn = document.createElement('button');
  moreBtn.className = 'reaction-pick-btn reaction-more-btn';
  moreBtn.textContent = '⋯';
  moreBtn.title = t('emoji.all_emojis_title');
  moreBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    this._showFullReactionPicker(msgEl, msgId, picker);
  });
  picker.appendChild(moreBtn);

  // Separator + gear icon for customization
  const sep = document.createElement('span');
  sep.className = 'reaction-pick-sep';
  sep.textContent = '|';
  picker.appendChild(sep);

  const gearBtn = document.createElement('button');
  gearBtn.className = 'reaction-pick-btn reaction-gear-btn';
  gearBtn.textContent = '⚙️';
  gearBtn.title = t('emoji.customize_quick_title');
  gearBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    this._showQuickEmojiEditor(picker, msgEl, msgId);
  });
  picker.appendChild(gearBtn);

  msgEl.appendChild(picker);

  // Flip picker below the message if it would be clipped above
  requestAnimationFrame(() => {
    const pickerRect = picker.getBoundingClientRect();
    const container = msgEl.closest('#thread-messages, #messages');
    const containerTop = container ? container.getBoundingClientRect().top : 0;
    if (pickerRect.top < containerTop + 4) {
      picker.classList.add('flip-below');
    }
  });

  // Close on click outside
  const close = (e) => {
    if (!picker.contains(e.target) && !e.target.closest('.reaction-full-picker') && !e.target.closest('.quick-emoji-editor')) {
      picker.remove();
      msgEl.classList.remove('showing-picker');
      document.querySelectorAll('.reaction-full-picker').forEach(el => el.remove());
      document.removeEventListener('click', close);
      this._reactionPickerClose = null;
    }
  };
  this._reactionPickerClose = close;
  setTimeout(() => document.addEventListener('click', close), 0);
},

_showFullReactionPicker(msgEl, msgId, quickPicker) {
  // Remove any existing full picker
  document.querySelectorAll('.reaction-full-picker').forEach(el => el.remove());

  const panel = document.createElement('div');
  panel.className = 'reaction-full-picker';

  // Search bar
  const searchRow = document.createElement('div');
  searchRow.className = 'reaction-full-search';
  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.placeholder = t('reactions.search_placeholder');
  searchInput.className = 'reaction-full-search-input';
  searchRow.appendChild(searchInput);
  panel.appendChild(searchRow);

  // Scrollable emoji grid
  const grid = document.createElement('div');
  grid.className = 'reaction-full-grid';

  const renderAll = (filter) => {
    grid.innerHTML = '';
    const lowerFilter = filter ? filter.toLowerCase() : '';
    for (const [category, emojis] of Object.entries(this.emojiCategories)) {
      const matching = lowerFilter
        ? emojis.filter(e => {
            const names = this.emojiNames[e] || '';
            return e.includes(lowerFilter) || names.toLowerCase().includes(lowerFilter) || category.toLowerCase().includes(lowerFilter);
          })
        : emojis;
      if (matching.length === 0) continue;

      const label = document.createElement('div');
      label.className = 'reaction-full-category';
      label.textContent = t(`emoji.categories.${category.toLowerCase()}`) || category;
      grid.appendChild(label);

      const row = document.createElement('div');
      row.className = 'reaction-full-row';
      matching.forEach(emoji => {
        const btn = document.createElement('button');
        btn.className = 'reaction-full-btn';
        btn.textContent = emoji;
        btn.title = this.emojiNames[emoji] || '';
        btn.addEventListener('click', () => {
          this.socket.emit('add-reaction', { messageId: msgId, emoji });
          panel.remove();
          quickPicker.remove();
          msgEl.classList.remove('showing-picker');
          if (this._reactionPickerClose) {
            document.removeEventListener('click', this._reactionPickerClose);
            this._reactionPickerClose = null;
          }
        });
        row.appendChild(btn);
      });
      grid.appendChild(row);
    }

    // Custom emojis section
    if (this.customEmojis && this.customEmojis.length > 0) {
      const customMatching = lowerFilter
        ? this.customEmojis.filter(e => e.name.toLowerCase().includes(lowerFilter) || 'custom'.includes(lowerFilter))
        : this.customEmojis;
      if (customMatching.length > 0) {
        const label = document.createElement('div');
        label.className = 'reaction-full-category';
        label.textContent = t('emoji.categories.custom');
        grid.appendChild(label);

        const row = document.createElement('div');
        row.className = 'reaction-full-row';
        customMatching.forEach(ce => {
          const btn = document.createElement('button');
          btn.className = 'reaction-full-btn';
          btn.innerHTML = `<img src="${this._escapeHtml(ce.url)}" alt=":${this._escapeHtml(ce.name)}:" title=":${this._escapeHtml(ce.name)}:" class="custom-emoji">`;
          btn.addEventListener('click', () => {
            this.socket.emit('add-reaction', { messageId: msgId, emoji: `:${ce.name}:` });
            panel.remove();
            quickPicker.remove();
            msgEl.classList.remove('showing-picker');
            if (this._reactionPickerClose) {
              document.removeEventListener('click', this._reactionPickerClose);
              this._reactionPickerClose = null;
            }
          });
          row.appendChild(btn);
        });
        grid.appendChild(row);
      }
    }
  };

  renderAll('');
  panel.appendChild(grid);

  // Debounced search
  let searchTimer;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => renderAll(searchInput.value.trim()), 150);
  });

  // Position the panel relative to quick picker so it never overlaps it
  quickPicker.appendChild(panel);
  if (quickPicker.classList.contains('flip-below')) {
    panel.classList.add('flip-below');
  }

  requestAnimationFrame(() => {
    const panelRect = panel.getBoundingClientRect();
    const container = msgEl.closest('#thread-messages, #messages');
    const containerTop = container ? container.getBoundingClientRect().top : 0;
    if (panelRect.top < containerTop + 4) {
      panel.classList.add('flip-below');
    }
  });
  searchInput.focus();
},

// ═══════════════════════════════════════════════════════
// THREADS
// ═══════════════════════════════════════════════════════

_renderThreadPreview(parentId, thread) {
  if (!thread || !thread.count) return '';
  const participantAvatars = (thread.participants || []).map(p => {
    if (p.avatar) {
      return `<img class="thread-participant-avatar" src="${this._escapeHtml(p.avatar)}" alt="${this._escapeHtml(p.username)}" title="${this._escapeHtml(p.username)}">`;
    }
    const color = this._getUserColor(p.username);
    const initial = p.username.charAt(0).toUpperCase();
    return `<div class="thread-participant-avatar thread-participant-initial" style="background:${color}" title="${this._escapeHtml(p.username)}">${initial}</div>`;
  }).join('');

  const timeAgo = this._relativeTime(thread.lastReplyAt);
  return `
    <button class="thread-preview" data-thread-parent="${parentId}">
      ${participantAvatars}
      <span class="thread-preview-count">${thread.count} ${thread.count === 1 ? 'Reply' : 'Replies'}</span>
      <span class="thread-preview-time">${timeAgo}</span>
      <span class="thread-preview-arrow">›</span>
    </button>
  `;
},

_relativeTime(isoStr) {
  if (!isoStr) return '';
  const diff = Date.now() - new Date(isoStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
},

_setThreadParentHeader(meta = {}) {
  const wrap = document.getElementById('thread-parent-avatar-wrap');
  const nameEl = document.getElementById('thread-parent-name');
  if (!wrap || !nameEl) return;

  const username = (meta.username || '').trim() || 'Thread starter';
  const shape = (meta.avatarShape || 'circle') === 'square' ? 'square' : 'circle';
  const shapeClass = shape === 'square' ? ' thread-parent-avatar-square' : '';

  if (meta.avatar) {
    wrap.innerHTML = `<img class="thread-parent-avatar${shapeClass}" src="${this._escapeHtml(meta.avatar)}" alt="${this._escapeHtml(username)}">`;
  } else {
    const initial = username.charAt(0).toUpperCase() || '?';
    const color = this._getUserColor(username);
    wrap.innerHTML = `<div class="thread-parent-avatar-initial${shapeClass}" style="background:${color}">${this._escapeHtml(initial)}</div>`;
  }

  nameEl.textContent = username;
  nameEl.title = username;
},

_setThreadReply(msgEl, msgId) {
  const author = msgEl.querySelector('.thread-msg-author')?.textContent || 'someone';
  const rawContent = msgEl.dataset.rawContent || msgEl.querySelector('.thread-msg-content')?.textContent || '';
  const preview = rawContent.length > 70 ? rawContent.substring(0, 70) + '…' : rawContent;
  this._threadReplyingTo = { id: msgId, username: author, content: rawContent };

  const bar = document.getElementById('thread-reply-bar');
  const text = document.getElementById('thread-reply-preview-text');
  if (!bar || !text) return;
  bar.style.display = 'flex';
  text.innerHTML = `Replying to <strong>${this._escapeHtml(author)}</strong>: ${this._escapeHtml(preview)}`;

  const input = document.getElementById('thread-input');
  if (input) input.focus();
},

_clearThreadReply() {
  this._threadReplyingTo = null;
  const bar = document.getElementById('thread-reply-bar');
  if (bar) bar.style.display = 'none';
},

_quoteThreadMessage(msgEl) {
  const rawContent = msgEl.dataset.rawContent || msgEl.querySelector('.thread-msg-content')?.textContent || '';
  const author = msgEl.querySelector('.thread-msg-author')?.textContent || 'someone';
  const quotedLines = rawContent.split('\n').map(l => `> ${l}`).join('\n');
  const quoteText = `> @${author} wrote:\n${quotedLines}\n`;

  const input = document.getElementById('thread-input');
  if (!input) return;
  if (input.value) {
    input.value += '\n' + quoteText;
  } else {
    input.value = quoteText;
  }
  input.focus();
  input.dispatchEvent(new Event('input'));
},

// ── Thread @mention tracking ──────────────────────
_recordThreadMention(channelCode, parentId, msg) {
  if (!this._threadMentions) {
    try { this._threadMentions = JSON.parse(localStorage.getItem('haven_thread_mentions') || '{}'); }
    catch { this._threadMentions = {}; }
  }
  const list = this._threadMentions[channelCode] || (this._threadMentions[channelCode] = []);
  // Dedupe by messageId
  if (list.some(m => m.messageId === msg.id)) return;
  list.push({
    parentId,
    messageId: msg.id,
    username: msg.username || '',
    snippet: (msg.content || '').slice(0, 140),
    when: Date.now()
  });
  this._persistThreadMentions();
  this._renderChannels?.();
  this._updateThreadMentionsPill();
},
_clearThreadMentionsForParent(channelCode, parentId) {
  if (!this._threadMentions || !this._threadMentions[channelCode]) return;
  this._threadMentions[channelCode] = this._threadMentions[channelCode].filter(m => m.parentId !== parentId);
  if (this._threadMentions[channelCode].length === 0) delete this._threadMentions[channelCode];
  this._persistThreadMentions();
  this._renderChannels?.();
  this._updateThreadMentionsPill();
},
_clearThreadMentionsForChannel(channelCode) {
  if (!this._threadMentions || !this._threadMentions[channelCode]) return;
  delete this._threadMentions[channelCode];
  this._persistThreadMentions();
  this._renderChannels?.();
  this._updateThreadMentionsPill();
},
_persistThreadMentions() {
  try { localStorage.setItem('haven_thread_mentions', JSON.stringify(this._threadMentions || {})); } catch {}
},
_updateThreadMentionsPill() {
  const pill = document.getElementById('thread-mentions-pill');
  const cnt = document.getElementById('thread-mentions-pill-count');
  if (!pill || !cnt) return;
  if (!this._threadMentions) {
    try { this._threadMentions = JSON.parse(localStorage.getItem('haven_thread_mentions') || '{}'); }
    catch { this._threadMentions = {}; }
  }
  const list = (this._threadMentions[this.currentChannel] || []);
  if (list.length === 0) {
    pill.style.display = 'none';
    return;
  }
  pill.style.display = '';
  cnt.textContent = String(list.length);
  pill.title = list.length === 1
    ? `1 mention in a thread — click to open`
    : `${list.length} mentions in threads — click to open the most recent`;
},
_openMostRecentThreadMention() {
  if (!this._threadMentions) return;
  const list = this._threadMentions[this.currentChannel];
  if (!list || list.length === 0) return;
  const newest = list[list.length - 1];
  this._openThread(newest.parentId);
},

// ── DM Picture-in-Picture (overlay panel, like thread PiP) ──
// Opens a floating, draggable, resizable panel that hosts a DM
// without leaving the user's current channel. The DM panel is its
// own message view — receives `new-message` events filtered by code,
// sends via `send-message` with the PiP channel code.
_openDMPiP(code) {
  const ch = (this.channels || []).find(c => c.code === code);
  if (!ch || !ch.is_dm) return;
  this._activeDMPip = code;
  try { localStorage.setItem('haven_active_dm_pip', code); } catch {}
  // Keep the DM PiP cleared from the unread badge
  this.unreadCounts[code] = 0;
  this._updateBadge?.(code);

  const panel = document.getElementById('dm-pip-panel');
  if (!panel) return;
  panel.style.display = 'flex';
  panel.dataset.code = code;
  // Title: partner name
  const partnerName = ch.dm_target ? this._getNickname(ch.dm_target.id, ch.dm_target.username) : 'DM';
  const titleEl = document.getElementById('dm-pip-title');
  if (titleEl) titleEl.textContent = ch.is_self_dm ? `📝 ${partnerName} (you)` : `@ ${partnerName}`;

  // Restore geometry from localStorage
  this._applyDMPiPGeometry(panel);
  // Bind drag once
  this._bindDMPiPDrag();

  // Clear messages and request fresh
  const msgsEl = document.getElementById('dm-pip-messages');
  if (msgsEl) msgsEl.innerHTML = '<div class="dm-pip-loading">Loading…</div>';
  // E2E: ensure partner key is loaded before history arrives so messages decrypt
  if (ch.dm_target && this._dmPublicKeys && !this._dmPublicKeys[ch.dm_target.id]) {
    try { this._fetchDMPartnerKey?.(ch); } catch {}
  }
  this.socket.emit('get-messages', { code });

  // Focus input
  const input = document.getElementById('dm-pip-input');
  if (input) input.focus();
},

_closeDMPiP() {
  this._activeDMPip = null;
  try { localStorage.removeItem('haven_active_dm_pip'); } catch {}
  const panel = document.getElementById('dm-pip-panel');
  if (panel) panel.style.display = 'none';
},

_applyDMPiPGeometry(panel) {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem('haven_dm_pip_rect') || 'null'); } catch {}
  const minW = 320, minH = 280;
  const maxW = Math.min(720, window.innerWidth - 28);
  const maxH = Math.max(minH, window.innerHeight - 28);
  const width = Math.max(minW, Math.min(maxW, (saved && saved.width) || 420));
  const height = Math.max(minH, Math.min(maxH, (saved && saved.height) || 540));
  const defaultLeft = Math.max(0, window.innerWidth - width - 20);
  const defaultTop = Math.max(0, window.innerHeight - height - 80);
  const left = Math.max(0, Math.min(window.innerWidth - width, (saved && Number.isFinite(saved.left)) ? saved.left : defaultLeft));
  const top = Math.max(0, Math.min(window.innerHeight - height, (saved && Number.isFinite(saved.top)) ? saved.top : defaultTop));
  panel.style.width = `${Math.round(width)}px`;
  panel.style.height = `${Math.round(height)}px`;
  panel.style.left = `${Math.round(left)}px`;
  panel.style.top = `${Math.round(top)}px`;
},

_bindDMPiPDrag() {
  if (this._dmPipDragBound) return;
  this._dmPipDragBound = true;
  const panel = document.getElementById('dm-pip-panel');
  if (!panel) return;
  const header = panel.querySelector('.dm-pip-header');
  if (!header) return;
  let startX = 0, startY = 0, startLeft = 0, startTop = 0, dragging = false;
  header.addEventListener('mousedown', (e) => {
    if (e.target.closest('button, a, input, select, textarea')) return;
    dragging = true;
    startX = e.clientX; startY = e.clientY;
    const r = panel.getBoundingClientRect();
    startLeft = r.left; startTop = r.top;
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const w = panel.offsetWidth, h = panel.offsetHeight;
    const left = Math.max(0, Math.min(window.innerWidth - w, startLeft + (e.clientX - startX)));
    const top = Math.max(0, Math.min(window.innerHeight - h, startTop + (e.clientY - startY)));
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  });
  const persist = () => {
    if (!panel || panel.style.display === 'none') return;
    try {
      localStorage.setItem('haven_dm_pip_rect', JSON.stringify({
        left: parseInt(panel.style.left, 10) || 0,
        top: parseInt(panel.style.top, 10) || 0,
        width: panel.offsetWidth,
        height: panel.offsetHeight
      }));
    } catch {}
  };
  window.addEventListener('mouseup', () => {
    if (dragging) { dragging = false; persist(); }
  });
  // Persist on resize (CSS resize: both)
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => persist());
    ro.observe(panel);
  }
},

// Render a DM message in the PiP panel (very minimal — text only)
_appendDMPiPMessage(msg) {
  const list = document.getElementById('dm-pip-messages');
  if (!list) return;
  // Skip if we're already showing this id
  if (msg && msg.id && list.querySelector(`[data-pip-msg-id="${msg.id}"]`)) return;
  // Clear any "loading" placeholder
  const ph = list.querySelector('.dm-pip-loading');
  if (ph) ph.remove();
  const row = document.createElement('div');
  row.className = 'dm-pip-message';
  row.dataset.pipMsgId = msg.id || '';
  const author = this._escapeHtml(msg.username || '');
  const body = this._escapeHtml(msg.content || '');
  row.innerHTML = `<span class="dm-pip-author">${author}</span><span class="dm-pip-body">${body}</span>`;
  list.appendChild(row);
  list.scrollTop = list.scrollHeight;
},

_renderDMPiPHistory(messages) {
  const list = document.getElementById('dm-pip-messages');
  if (!list) return;
  list.innerHTML = '';
  (messages || []).forEach(m => this._appendDMPiPMessage(m));
},

_sendDMPiPMessage() {
  const input = document.getElementById('dm-pip-input');
  if (!input || !this._activeDMPip) return;
  const content = (input.value || '').trim();
  if (!content) return;
  this.socket.emit('send-message', { code: this._activeDMPip, content });
  input.value = '';
  input.focus();
},

_openThread(parentId) {
  this._activeThreadParent = parentId;
  // Clear any pending thread mentions for this thread/channel
  this._clearThreadMentionsForParent(this.currentChannel, parentId);
  const panel = document.getElementById('thread-panel');
  if (!panel) return;
  panel.style.display = 'flex';
  panel.dataset.parentId = parentId;
  this._setThreadPiPEnabled(localStorage.getItem('haven_thread_panel_pip') === '1');

  // Request thread messages from server
  this.socket.emit('get-thread-messages', { parentId });

  // Update header
  const msgEl = document.querySelector(`[data-msg-id="${parentId}"]`);
  const author = msgEl?.querySelector('.message-author')?.textContent || 'Thread starter';
  document.getElementById('thread-panel-title').textContent = 'Thread';
  const parentPreview = msgEl?.querySelector('.message-content')?.textContent || '';
  document.getElementById('thread-parent-preview').textContent = parentPreview.length > 120 ? parentPreview.substring(0, 120) + '…' : parentPreview;

  const avatarImg = msgEl?.querySelector('.message-avatar-img');
  let avatar = null;
  if (avatarImg && avatarImg.getAttribute('src')) avatar = avatarImg.getAttribute('src');
  const avatarShape = (avatarImg && avatarImg.classList.contains('avatar-square')) ? 'square' : 'circle';
  this._setThreadParentHeader({ username: author, avatar, avatarShape });

  // Focus input
  const input = document.getElementById('thread-input');
  if (input) input.focus();
},

_setThreadPiPEnabled(enabled) {
  const panel = document.getElementById('thread-panel');
  const pipBtn = document.getElementById('thread-panel-pip');
  if (!panel || !pipBtn) return;

  const isOn = !!enabled;
  panel.classList.toggle('pip', isOn);
  pipBtn.textContent = isOn ? '▣' : '⧉';
  pipBtn.title = isOn ? 'Dock thread panel' : 'Pop out thread (PiP)';
  pipBtn.setAttribute('aria-pressed', isOn ? 'true' : 'false');
  localStorage.setItem('haven_thread_panel_pip', isOn ? '1' : '0');

  if (isOn) {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem('haven_thread_panel_pip_rect') || 'null'); } catch {}

    const minW = 320;
    const maxW = Math.min(760, window.innerWidth - 28);
    const minH = 240;
    const footerOffset = (() => {
      const raw = getComputedStyle(document.body).getPropertyValue('--thread-footer-offset');
      const v = parseInt(raw, 10);
      return Number.isFinite(v) ? v : 0;
    })();
    const maxH = Math.max(minH, window.innerHeight - footerOffset - 28);

    const width = Math.max(minW, Math.min(maxW, (saved && saved.width) || panel.offsetWidth || 420));
    const height = Math.max(minH, Math.min(maxH, (saved && saved.height) || panel.offsetHeight || 460));
    const defaultLeft = Math.max(0, window.innerWidth - width - 14);
    const defaultTop = Math.max(0, window.innerHeight - footerOffset - height - 14);
    const left = Math.max(0, Math.min(window.innerWidth - width, (saved && Number.isFinite(saved.left)) ? saved.left : defaultLeft));
    const top = Math.max(0, Math.min(window.innerHeight - footerOffset - height, (saved && Number.isFinite(saved.top)) ? saved.top : defaultTop));

    panel.style.width = `${Math.round(width)}px`;
    panel.style.height = `${Math.round(height)}px`;
    panel.style.left = `${Math.round(left)}px`;
    panel.style.top = `${Math.round(top)}px`;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
  } else {
    panel.style.height = '';
    panel.style.left = '';
    panel.style.top = '';
    panel.style.right = '';
    panel.style.bottom = '';
  }
},

_toggleThreadPiP() {
  const panel = document.getElementById('thread-panel');
  if (!panel) return;
  this._setThreadPiPEnabled(!panel.classList.contains('pip'));
},

_closeThread() {
  this._activeThreadParent = null;
  this._clearThreadReply();
  const panel = document.getElementById('thread-panel');
  if (panel) {
    panel.style.display = 'none';
    panel.dataset.parentId = '';
  }
},

_sendThreadMessage() {
  const input = document.getElementById('thread-input');
  if (!input) return;
  const content = input.value.trim();
  if (!content) return;
  const parentId = this._activeThreadParent;
  if (!parentId) return;
  const replyTo = this._threadReplyingTo ? this._threadReplyingTo.id : null;

  this.socket.emit('send-thread-message', { parentId, content, replyTo }, (resp) => {
    if (resp && resp.error) {
      this._showToast(resp.error, 'error');
      return;
    }
    this._clearThreadReply();
  });
  input.value = '';
},

_appendThreadMessage(msg) {
  const container = document.getElementById('thread-messages');
  if (!container) return;

  const color = this._getUserColor(msg.username);
  const initial = msg.username.charAt(0).toUpperCase();
  let avatarHtml;
  if (msg.avatar) {
    avatarHtml = `<img class="thread-msg-avatar" src="${this._escapeHtml(msg.avatar)}" alt="${initial}">`;
  } else {
    avatarHtml = `<div class="thread-msg-avatar thread-msg-avatar-initial" style="background:${color}">${initial}</div>`;
  }

  const reactionsHtml = this._renderReactions(msg.id, msg.reactions || []);
  const replyHtml = msg.replyContext ? this._renderReplyBanner(msg.replyContext) : '';
  const canDelete = msg.user_id === this.user.id || this.user.isAdmin || this._canModerate();
  const canEdit = msg.user_id === this.user.id;
  const iconPair = (emoji, monoSvg) => `<span class="tb-icon tb-icon-emoji" aria-hidden="true">${emoji}</span><span class="tb-icon tb-icon-mono" aria-hidden="true">${monoSvg}</span>`;
  const iReact = iconPair('😀', '<svg class="thread-action-react-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke-width="1.8"></circle><path d="M8.5 14.5c1 1.2 2.2 1.8 3.5 1.8s2.5-.6 3.5-1.8" stroke-width="1.8" stroke-linecap="round"></path><circle cx="9.2" cy="10.2" r="1" fill="currentColor" stroke="none"></circle><circle cx="14.8" cy="10.2" r="1" fill="currentColor" stroke="none"></circle></svg>');
  const iReply = iconPair('↩️', '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 8L4 12L10 16" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path><path d="M20 12H5" stroke-width="1.8" stroke-linecap="round"></path></svg>');
  const iQuote = iconPair('💬', '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 7H5v6h4l-2 4" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path><path d="M19 7h-4v6h4l-2 4" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path></svg>');
  const iEdit = iconPair('✏️', '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20l4.5-1 9-9-3.5-3.5-9 9L4 20z" stroke-width="1.8" stroke-linejoin="round"></path><path d="M13.5 6.5l3.5 3.5" stroke-width="1.8" stroke-linecap="round"></path></svg>');
  const iDelete = iconPair('🗑️', '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14" stroke-width="1.8" stroke-linecap="round"></path><path d="M9 7V5h6v2" stroke-width="1.8" stroke-linecap="round"></path><path d="M7 7l1 12h8l1-12" stroke-width="1.8" stroke-linejoin="round"></path></svg>');
  const iMore = iconPair('⋯', '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="12" r="1.6" fill="currentColor" stroke="none"></circle><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"></circle><circle cx="18" cy="12" r="1.6" fill="currentColor" stroke="none"></circle></svg>');
  const threadCoreToolbarBtns = `<button data-thread-action="react" title="React" aria-label="React">${iReact}</button><button data-thread-action="reply" title="Reply">${iReply}</button><button data-thread-action="quote" title="Quote">${iQuote}</button>`;
  let threadOverflowToolbarBtns = '';
  if (canEdit) threadOverflowToolbarBtns += `<button data-thread-action="edit" title="Edit">${iEdit}</button>`;
  if (canDelete) threadOverflowToolbarBtns += `<button data-thread-action="delete" title="Delete">${iDelete}</button>`;
  const threadOverflowHtml = threadOverflowToolbarBtns
    ? `<div class="thread-msg-more"><button class="thread-msg-more-btn" type="button" aria-label="More actions">${iMore}</button><div class="thread-msg-overflow">${threadOverflowToolbarBtns}</div></div>`
    : '';

  const el = document.createElement('div');
  el.className = 'thread-message';
  el.dataset.msgId = msg.id;
  el.dataset.rawContent = msg.content;
  el.innerHTML = `
    <div class="thread-msg-row">
      ${avatarHtml}
      <div class="thread-msg-body">
        <div class="thread-msg-header">
          <span class="thread-msg-author" style="color:${color}">${this._escapeHtml(msg.username)}</span>
          <span class="thread-msg-time">${this._formatTime(msg.created_at)}</span>
          <span class="thread-msg-header-spacer"></span>
          <div class="thread-msg-toolbar">
            <div class="msg-toolbar-group">${threadCoreToolbarBtns}</div>
            ${threadOverflowHtml}
          </div>
        </div>
        ${replyHtml}
        <div class="thread-msg-content">${this._formatContent(msg.content)}</div>
        ${reactionsHtml}
      </div>
    </div>
  `;
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
},

_updateThreadPreview(parentId, thread) {
  const msgEl = document.querySelector(`[data-msg-id="${parentId}"]`);
  if (!msgEl) return;
  const oldPreview = msgEl.querySelector('.thread-preview');
  const newHtml = this._renderThreadPreview(parentId, thread);
  if (oldPreview) {
    oldPreview.outerHTML = newHtml;
  } else if (newHtml) {
    // Insert after reactions row, or after message-content
    const reactions = msgEl.querySelector('.reactions-row');
    const content = msgEl.querySelector('.message-content');
    const insertAfter = reactions || content;
    if (insertAfter) insertAfter.insertAdjacentHTML('afterend', newHtml);
  }
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
  author = author || 'someone';
  const content = msgEl.querySelector('.message-content')?.textContent || '';
  const preview = content.length > 60 ? content.substring(0, 60) + '…' : content;

  this.replyingTo = { id: msgId, username: author, content };

  const bar = document.getElementById('reply-bar');
  bar.style.display = 'flex';
  document.getElementById('reply-preview-text').innerHTML =
    `Replying to <strong>${this._escapeHtml(author)}</strong>: ${this._escapeHtml(preview)}`;
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
  author = author || 'someone';

  // Build the blockquote text — each line prefixed with >
  const quotedLines = rawContent.split('\n').map(l => `> ${l}`).join('\n');
  const quoteText = `> @${author} wrote:\n${quotedLines}\n`;

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
  textarea.maxLength = 2000;
  contentEl.appendChild(textarea);

  // Track active edit textarea for emoji picker redirection
  this._activeEditTextarea = textarea;

  const btnRow = document.createElement('div');
  btnRow.className = 'edit-actions';
  btnRow.innerHTML = `<button class="edit-emoji-btn" title="${t('app.input_bar.emoji_btn') || 'Emoji'}">😀</button><button class="edit-save-btn">${t('modals.common.save')}</button><button class="edit-cancel-btn">${t('modals.common.cancel')}</button>`;
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
    if (!newContent) return cancel();
    if (newContent === rawText) return cancel();

    // E2E: encrypt edited DM content
    const partner = this._getE2EPartner();
    if (partner) {
      try {
        newContent = await this.e2e.encrypt(newContent, partner.userId, partner.publicKeyJwk);
      } catch (err) {
        console.warn('[E2E] Failed to encrypt edited message:', err);
      }
    }

    this.socket.emit('edit-message', { messageId: msgId, content: newContent });
    cancel(); // will be updated by the server event
  });

  textarea.addEventListener('keydown', (e) => {
    e.stopPropagation();

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

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      btnRow.querySelector('.edit-save-btn').click();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  });

  // Enable @mention and :emoji autocomplete in edit textarea
  textarea.addEventListener('input', () => {
    this._checkMentionTrigger(textarea);
    this._checkEmojiTrigger(textarea);
  });

  // Click inside edit area should not bubble to delegation handler
  contentEl.addEventListener('click', (e) => {
    e.stopPropagation();
  }, { once: false });
},

// ═══════════════════════════════════════════════════════
// ADMIN MODERATION UI
// ═══════════════════════════════════════════════════════

_showAdminActionModal(action, userId, username) {
  this.adminActionTarget = { action, userId, username };
  const modal = document.getElementById('admin-action-modal');
  const title = document.getElementById('admin-action-title');
  const desc = document.getElementById('admin-action-desc');
  const durationGroup = document.getElementById('admin-duration-group');
  const scrubGroup = document.getElementById('admin-scrub-group');
  const scrubCheckbox = document.getElementById('admin-scrub-checkbox');
  const scrubScopeRow = document.getElementById('admin-scrub-scope-row');
  const confirmBtn = document.getElementById('confirm-admin-action-btn');

  const labels = {
    kick: t('modals.admin_action.label_kick'),
    ban: t('modals.admin_action.label_ban'),
    mute: t('modals.admin_action.label_mute'),
    'delete-user': t('modals.admin_action.label_delete_user')
  };
  title.textContent = `${labels[action] || action} — ${username}`;
  desc.textContent = action === 'ban'
    ? t('modals.admin_action.desc_ban')
    : action === 'mute'
      ? t('modals.admin_action.desc_mute')
      : action === 'delete-user'
        ? t('modals.admin_action.desc_delete_user')
        : t('modals.admin_action.desc_kick');

  durationGroup.style.display = action === 'mute' ? 'block' : 'none';

  // Show scrub option for kick, ban, and delete-user
  const hasScrub = ['kick', 'ban', 'delete-user'].includes(action);
  scrubGroup.style.display = hasScrub ? 'block' : 'none';
  scrubCheckbox.checked = false;
  // Kick gets scope dropdown (channel vs server), ban/delete are server-wide only
  scrubScopeRow.style.display = 'none';
  if (action === 'kick') {
    scrubCheckbox.onchange = () => { scrubScopeRow.style.display = scrubCheckbox.checked ? 'block' : 'none'; };
  } else {
    scrubCheckbox.onchange = null;
  }

  // Purge option: replace messages with placeholder. Ban-only for now —
  // it's a softer, less destructive alternative to scrub. Mutually exclusive
  // with scrub (you can't both delete and replace the same messages).
  const purgeGroup = document.getElementById('admin-purge-group');
  const purgeCheckbox = document.getElementById('admin-purge-checkbox');
  const purgeMessageRow = document.getElementById('admin-purge-message-row');
  const purgeMessageInput = document.getElementById('admin-purge-message');
  if (purgeGroup) {
    purgeGroup.style.display = action === 'ban' ? 'block' : 'none';
    if (purgeCheckbox) purgeCheckbox.checked = false;
    if (purgeMessageRow) purgeMessageRow.style.display = 'none';
    if (purgeMessageInput) purgeMessageInput.value = '';
    if (purgeCheckbox && action === 'ban') {
      purgeCheckbox.onchange = () => {
        if (purgeMessageRow) purgeMessageRow.style.display = purgeCheckbox.checked ? 'block' : 'none';
        // Mutually exclusive with scrub
        if (purgeCheckbox.checked && scrubCheckbox.checked) {
          scrubCheckbox.checked = false;
          if (scrubScopeRow) scrubScopeRow.style.display = 'none';
        }
      };
      const origScrubChange = scrubCheckbox.onchange;
      scrubCheckbox.onchange = () => {
        if (typeof origScrubChange === 'function') origScrubChange();
        if (scrubCheckbox.checked && purgeCheckbox.checked) {
          purgeCheckbox.checked = false;
          if (purgeMessageRow) purgeMessageRow.style.display = 'none';
        }
      };
    }
  }

  confirmBtn.textContent = labels[action] || t('modals.common.confirm');

  document.getElementById('admin-action-reason').value = '';
  document.getElementById('admin-action-duration').value = '10';
  document.getElementById('admin-scrub-scope').value = 'channel';
  modal.style.display = 'flex';
  modal.style.zIndex = '100002';
},

_confirmTransferAdmin(userId, username) {
  // Build a custom modal for transfer admin with password verification
  this._closeUserGearMenu();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay transfer-admin-overlay';
  overlay.style.display = 'flex';
  overlay.innerHTML = `
    <div class="modal transfer-admin-modal">
      <div class="modal-header">
        <h4>🔑 ${t('modals.transfer_admin.title')}</h4>
        <button class="modal-close-btn transfer-admin-close">&times;</button>
      </div>
      <div class="modal-body">
        <div class="transfer-admin-warning">
          <div class="transfer-admin-warning-icon">⚠️</div>
          <div class="transfer-admin-warning-text">
            ${t('modals.transfer_admin.warning', { username: this._escapeHtml(username) })}
          </div>
        </div>
        <p class="transfer-admin-note">${t('modals.transfer_admin.note')}</p>
        <div class="form-group">
          <label class="form-label">${t('modals.transfer_admin.password_label')}</label>
          <input type="password" id="transfer-admin-pw" class="form-input" placeholder="${t('modals.transfer_admin.password_placeholder')}" autocomplete="current-password">
        </div>
        <p id="transfer-admin-error" class="transfer-admin-error"></p>
      </div>
      <div class="modal-footer">
        <button class="btn-secondary transfer-admin-cancel">${t('modals.common.cancel')}</button>
        <button class="btn-danger-fill transfer-admin-confirm">${t('modals.transfer_admin.confirm_btn')}</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const pwInput = overlay.querySelector('#transfer-admin-pw');
  const errorEl = overlay.querySelector('#transfer-admin-error');
  const confirmBtn = overlay.querySelector('.transfer-admin-confirm');
  const close = () => overlay.remove();

  overlay.querySelector('.transfer-admin-close').addEventListener('click', close);
  overlay.querySelector('.transfer-admin-cancel').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  pwInput.focus();
  pwInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') confirmBtn.click(); });

  confirmBtn.addEventListener('click', () => {
    const password = pwInput.value.trim();
    if (!password) {
      errorEl.textContent = t('modals.transfer_admin.error_required');
      errorEl.style.display = '';
      pwInput.focus();
      return;
    }
    confirmBtn.disabled = true;
    confirmBtn.textContent = t('modals.transfer_admin.transferring');
    this.socket.emit('transfer-admin', { userId, password }, (res) => {
      if (res && res.error) {
        errorEl.textContent = res.error;
        errorEl.style.display = '';
        confirmBtn.disabled = false;
        confirmBtn.textContent = t('modals.transfer_admin.confirm_btn');
        pwInput.value = '';
        pwInput.focus();
      } else if (res && res.success) {
        close();
        this._showToast(res.message || 'Admin transferred', 'info');
      }
    });
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

};
