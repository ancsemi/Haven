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
    if (['mp3', 'ogg', 'wav', 'webm'].includes(ext) && /^audio\//.test('audio/')) {
      return `<div class="file-attachment">
        <div class="file-info">${icon} <span class="file-name">${fileName}</span> <span class="file-size">(${fileSize})</span></div>
        <audio controls preload="none" src="${fileUrl}"></audio>
      </div>`;
    }
    if (['mp4', 'webm'].includes(ext)) {
      return `<div class="file-attachment">
        <div class="file-info">${icon} <span class="file-name">${fileName}</span> <span class="file-size">(${fileSize})</span></div>
        <video controls preload="none" src="${fileUrl}" class="file-video"></video>
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
  if (/^\/uploads\/[\w\-]+\.(jpg|jpeg|png|gif|webp)$/i.test(str.trim())) {
    return `<img src="${this._escapeHtml(str.trim())}" class="chat-image" alt="image" loading="lazy">`;
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
    mdLinks.push(`<img src="${safeUrl}" class="chat-image" alt="${alt || 'image'}" loading="lazy">`);
    return `\x00MDLINK_${idx}\x00`;
  });
  // [text](url)
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (full, text, url) => {
    try { new URL(url); } catch { return full; }
    const safeUrl = url.replace(/['"<>]/g, '');
    const idx = mdLinks.length;
    mdLinks.push(`<a href="${safeUrl}" target="_blank" rel="noopener noreferrer nofollow">${text}</a>`);
    return `\x00MDLINK_${idx}\x00`;
  });

  // Auto-link URLs (and render image URLs as inline images)
  html = html.replace(
    /\bhttps?:\/\/[a-zA-Z0-9\-._~:/?#\[\]@!$&()*+,;=%]+/g,
    (url) => {
      try { new URL(url); } catch { return url; }
      const safeUrl = url.replace(/['"<>]/g, '');
      if (/\.(jpg|jpeg|png|gif|webp)(\?[^"'<>]*)?$/i.test(safeUrl) ||
          /^https:\/\/media\d*\.giphy\.com\//i.test(safeUrl)) {
        return `<img src="${safeUrl}" class="chat-image" alt="image" loading="lazy">`;
      }
      return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer nofollow">${safeUrl}</a>`;
    }
  );

  // Render @mentions with highlight (negative lookbehind prevents matching inside email addresses)
  html = html.replace(/(?<!\w)@(\w{1,30})/g, (match, username) => {
    const isSelf = username.toLowerCase() === this.user.username.toLowerCase();
    return `<span class="mention${isSelf ? ' mention-self' : ''}">${match}</span>`;
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

  // Render `inline code`
  html = html.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');

  // Render > blockquotes (lines starting with >)
  html = html.replace(/(?:^|\n)&gt;\s?(.+)/g, (_, text) => {
    return `\n<blockquote class="chat-blockquote">${text}</blockquote>`;
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
    const items = match.trim().split('\n').map(line =>
      `<li>${line.replace(/^\d+\.\s+/, '')}</li>`
    ).join('');
    return `\n<ol class="chat-list">${items}</ol>`;
  });

  html = html.replace(/\n/g, '<br>');

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

  if (isToday) return `Today at ${time}`;
  if (isYesterday) return `Yesterday at ${time}`;
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
  if (force || this._isScrolledToBottom()) {
    // Use Number.MAX_SAFE_INTEGER — the browser clamps to actual max scrollTop.
    // This is necessary: el.scrollHeight can be under-reported when many
    // messages exist and layout hasn't fully settled (e.g. after DOM trimming).
    requestAnimationFrame(() => { el.scrollTop = Number.MAX_SAFE_INTEGER; });
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

/** Warn users before downloading potentially harmful file types */
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
  searchInput.placeholder = 'Search emoji\u2026';
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
    tab.title = cat;
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
      grid.innerHTML = '<p class="muted-text" style="padding:12px;font-size:12px;width:100%;text-align:center">No emoji found</p>';
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
        const input = document.getElementById('message-input');
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
  grid.innerHTML = '<div class="gif-picker-empty">Searching...</div>';
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
        grid.innerHTML = '<div class="gif-picker-empty">No GIFs found</div>';
        return;
      }
      this._renderGifGrid(results);
    })
    .catch(() => {
      grid.innerHTML = '<div class="gif-picker-empty">Search failed</div>';
    });
},

_showGifSetupGuide(grid) {
  const isAdmin = this.user && this.user.isAdmin;
  if (isAdmin) {
    grid.innerHTML = `
      <div class="gif-setup-guide">
        <h3>🎞️ Set Up GIF Search</h3>
        <p>GIF search is powered by <strong>GIPHY</strong> and needs a free API key.</p>
        <ol>
          <li>Go to <a href="https://developers.giphy.com/" target="_blank" rel="noopener">developers.giphy.com</a></li>
          <li>Create an account (or sign in)</li>
          <li>Click <b>Create an App</b> → choose <b>API</b></li>
          <li>Name it anything (e.g. "Haven Chat")</li>
          <li>Copy the API key and paste it below</li>
        </ol>
        <div class="gif-setup-input-row">
          <input type="text" id="gif-giphy-key-input" placeholder="Paste your GIPHY API key…" spellcheck="false" autocomplete="off" />
          <button id="gif-giphy-key-save">Save</button>
        </div>
        <p class="gif-setup-note">💡 No payment required — GIPHY's free tier is generous enough for a private server.</p>
      </div>`;
    const saveBtn = document.getElementById('gif-giphy-key-save');
    const input = document.getElementById('gif-giphy-key-input');
    saveBtn.addEventListener('click', () => {
      const key = input.value.trim();
      if (!key) return;
      this.socket.emit('update-server-setting', { key: 'giphy_api_key', value: key });
      grid.innerHTML = '<div class="gif-picker-empty">Saved! Loading GIFs…</div>';
      setTimeout(() => this._loadTrendingGifs(), 500);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') saveBtn.click();
    });
  } else {
    grid.innerHTML = `
      <div class="gif-setup-guide">
        <h3>🎞️ GIF Search Not Available</h3>
        <p>An admin needs to set up the GIPHY API key before GIF search can work.</p>
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
    // Check if it's a custom emoji
    const customMatch = g.emoji.match(/^:([a-zA-Z0-9_-]+):$/);
    let emojiDisplay = g.emoji;
    if (customMatch && this.customEmojis) {
      const ce = this.customEmojis.find(e => e.name === customMatch[1]);
      if (ce) emojiDisplay = `<img src="${this._escapeHtml(ce.url)}" alt=":${this._escapeHtml(ce.name)}:" class="custom-emoji reaction-custom-emoji">`;
    }
    return `<button class="reaction-badge${isOwn ? ' own' : ''}" data-emoji="${this._escapeHtml(g.emoji)}" title="${names}">${emojiDisplay} ${g.users.length}</button>`;
  }).join('');

  return `<div class="reactions-row">${badges}</div>`;
},

_updateMessageReactions(messageId, reactions) {
  const msgEl = document.querySelector(`[data-msg-id="${messageId}"]`);
  if (!msgEl) return;

  const wasAtBottom = this._isScrolledToBottom();

  // Remove old reactions row
  const oldRow = msgEl.querySelector('.reactions-row');
  if (oldRow) oldRow.remove();

  // Add new reactions
  const html = this._renderReactions(messageId, reactions);
  if (!html) { if (wasAtBottom) this._scrollToBottom(); return; }

  // Find where to insert — after .message-content
  const content = msgEl.querySelector('.message-content');
  if (content) {
    content.insertAdjacentHTML('afterend', html);
  }

  if (wasAtBottom) this._scrollToBottom();
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
  title.textContent = 'Customize Quick Reactions';
  editor.appendChild(title);

  const hint = document.createElement('p');
  hint.className = 'muted-text';
  hint.style.cssText = 'font-size:11px;padding:0 8px 6px;margin:0';
  hint.textContent = 'Click a slot, then pick an emoji to replace it.';
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
      label.textContent = category;
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
      label.textContent = 'Custom';
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
  doneBtn.textContent = 'Done';
  doneBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    editor.remove();
  });
  editor.appendChild(doneBtn);

  msgEl.appendChild(editor);
},

_showReactionPicker(msgEl, msgId) {
  // Remove any existing reaction picker
  document.querySelectorAll('.reaction-picker').forEach(el => el.remove());
  document.querySelectorAll('.reaction-full-picker').forEach(el => el.remove());
  document.querySelectorAll('.quick-emoji-editor').forEach(el => el.remove());

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
    });
    picker.appendChild(btn);
  });

  // "..." button opens the full emoji picker for reactions
  const moreBtn = document.createElement('button');
  moreBtn.className = 'reaction-pick-btn reaction-more-btn';
  moreBtn.textContent = '⋯';
  moreBtn.title = 'All emojis';
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
  gearBtn.title = 'Customize quick reactions';
  gearBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    this._showQuickEmojiEditor(picker, msgEl, msgId);
  });
  picker.appendChild(gearBtn);

  msgEl.appendChild(picker);

  // Flip picker below the message if it would be clipped above
  requestAnimationFrame(() => {
    const pickerRect = picker.getBoundingClientRect();
    if (pickerRect.top < 0) {
      picker.classList.add('flip-below');
    } else {
      // Also check against the messages container top (channel header/topic)
      const container = document.getElementById('messages');
      if (container) {
        const containerRect = container.getBoundingClientRect();
        if (pickerRect.top < containerRect.top) {
          picker.classList.add('flip-below');
        }
      }
    }
  });

  // Close on click outside
  const close = (e) => {
    if (!picker.contains(e.target) && !e.target.closest('.reaction-full-picker') && !e.target.closest('.quick-emoji-editor')) {
      picker.remove();
      document.querySelectorAll('.reaction-full-picker').forEach(el => el.remove());
      document.removeEventListener('click', close);
    }
  };
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
  searchInput.placeholder = 'Search emojis...';
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
      label.textContent = category;
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
        label.textContent = 'Custom';
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

  // Position the panel near the quick picker
  msgEl.appendChild(panel);
  searchInput.focus();
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

// ═══════════════════════════════════════════════════════
// EDIT MESSAGE
// ═══════════════════════════════════════════════════════

_startEditMessage(msgEl, msgId) {
  // Guard against re-entering edit mode
  if (msgEl.classList.contains('editing')) return;

  const contentEl = msgEl.querySelector('.message-content');
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

  const btnRow = document.createElement('div');
  btnRow.className = 'edit-actions';
  btnRow.innerHTML = '<button class="edit-save-btn">Save</button><button class="edit-cancel-btn">Cancel</button>';
  contentEl.appendChild(btnRow);

  textarea.focus();
  textarea.style.height = 'auto';
  textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';

  const cancel = () => {
    msgEl.classList.remove('editing');
    contentEl.innerHTML = originalHtml;
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
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      btnRow.querySelector('.edit-save-btn').click();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
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

  const labels = { kick: 'Kick', ban: 'Ban', mute: 'Mute', 'delete-user': 'Delete User' };
  title.textContent = `${labels[action] || action} — ${username}`;
  desc.textContent = action === 'ban'
    ? 'This user will be permanently banned until unbanned.'
    : action === 'mute'
      ? 'This user won\'t be able to send messages for the specified duration.'
      : action === 'delete-user'
        ? 'This will permanently delete this user\'s account and free their username.'
        : 'This user will be removed from the current channel.';

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

  confirmBtn.textContent = labels[action] || 'Confirm';

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
        <h4>🔑 Transfer Admin</h4>
        <button class="modal-close-btn transfer-admin-close">&times;</button>
      </div>
      <div class="modal-body">
        <div class="transfer-admin-warning">
          <div class="transfer-admin-warning-icon">⚠️</div>
          <div class="transfer-admin-warning-text">
            This will make <strong>${this._escapeHtml(username)}</strong> the new server Admin and demote you to <strong>Former Admin</strong> (Lv.99).
          </div>
        </div>
        <p class="transfer-admin-note">This action cannot be undone by you.</p>
        <div class="form-group">
          <label class="form-label">Enter your password to confirm</label>
          <input type="password" id="transfer-admin-pw" class="form-input" placeholder="Your password" autocomplete="current-password">
        </div>
        <p id="transfer-admin-error" class="transfer-admin-error"></p>
      </div>
      <div class="modal-footer">
        <button class="btn-secondary transfer-admin-cancel">Cancel</button>
        <button class="btn-danger-fill transfer-admin-confirm">Transfer Admin</button>
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
      errorEl.textContent = 'Password is required.';
      errorEl.style.display = '';
      pwInput.focus();
      return;
    }
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Transferring…';
    this.socket.emit('transfer-admin', { userId, password }, (res) => {
      if (res && res.error) {
        errorEl.textContent = res.error;
        errorEl.style.display = '';
        confirmBtn.disabled = false;
        confirmBtn.textContent = 'Transfer Admin';
        pwInput.value = '';
        pwInput.focus();
      } else if (res && res.success) {
        close();
        this._showToast(res.message || 'Admin transferred', 'info');
      }
    });
  });
},

};
