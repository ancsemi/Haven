// GIFs and stickers in the message box: the GIF picker with trending, search
// and favorites, /gif results, and sending a GIF or sticker.

// GIF favorites live entirely client-side: starring a GIF just keeps its
// GIPHY URLs in localStorage, so the Favorites tab keeps working even when
// the server has no GIPHY key configured.
const GIF_FAVORITES_KEY = 'haven_gif_favorites';
const GIF_FAVORITES_MAX = 200;

export default {

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
  this._gifTab = 'search';

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
    // Re-open on whichever tab was last used this session
    this._switchGifTab(this._gifTab);
  });

  picker.querySelectorAll('.gif-tab').forEach(tab => {
    tab.addEventListener('click', () => this._switchGifTab(tab.dataset.gifTab));
  });

  // Close when clicking outside
  document.addEventListener('click', (e) => {
    if (picker.style.display !== 'none' &&
        !picker.contains(e.target) && !btn.contains(e.target)) {
      picker.style.display = 'none';
    }
  });

  // Search on typing with debounce — on the Favorites tab the same box
  // filters the saved list locally instead of hitting GIPHY.
  searchInput.addEventListener('input', () => {
    clearTimeout(this._gifDebounce);
    const q = searchInput.value.trim();
    if (this._gifTab === 'favorites') {
      this._renderGifFavorites(q);
      return;
    }
    if (!q) {
      this._loadTrendingGifs();
      return;
    }
    this._gifDebounce = setTimeout(() => this._searchGifs(q), 350);
  });

  // Star toggles favorite; clicking the GIF itself sends it
  grid.addEventListener('click', (e) => {
    const star = e.target.closest('.gif-fav-btn');
    if (star) {
      const favorited = this._toggleGifFavorite({
        full: star.dataset.full,
        tiny: star.dataset.tiny,
        title: star.dataset.title,
      });
      // On the Favorites tab an un-starred GIF should leave the grid
      if (this._gifTab === 'favorites') this._renderGifFavorites(searchInput.value.trim());
      else this._paintGifStar(star, favorited);
      return;
    }
    const img = e.target.closest('img');
    if (!img || !img.dataset.full) return;
    this._sendGifMessage(img.dataset.full);
    picker.style.display = 'none';
  });
},

_switchGifTab(tab) {
  const picker = document.getElementById('gif-picker');
  const searchInput = document.getElementById('gif-search-input');
  if (!picker || !searchInput) return;

  this._gifTab = tab === 'favorites' ? 'favorites' : 'search';
  picker.querySelectorAll('.gif-tab').forEach(el => {
    el.classList.toggle('active', el.dataset.gifTab === this._gifTab);
  });
  clearTimeout(this._gifDebounce);

  const q = searchInput.value.trim();
  if (this._gifTab === 'favorites') {
    searchInput.placeholder = t('gifs.search_favorites');
    this._renderGifFavorites(q);
  } else {
    searchInput.placeholder = t('header.gif_search_placeholder');
    if (q) this._searchGifs(q);
    else this._loadTrendingGifs();
  }
},

// The proxy reports which provider served the batch — keep the picker
// footer honest ("Powered by Tenor" / "KLIPY" / "GIPHY").
_setGifFooter(provider) {
  if (!provider) return;
  const label = provider === 'tenor' ? 'Tenor' : provider === 'klipy' ? 'KLIPY' : 'GIPHY';
  const footer = document.querySelector('.gif-picker-footer');
  if (footer) footer.textContent = t('gifs.powered_by', { provider: label });
},

_loadTrendingGifs() {
  const grid = document.getElementById('gif-grid');
  grid.innerHTML = `<div class="gif-picker-empty">${t('thread_list.loading')}</div>`;
  fetch('/api/gif/trending?limit=20', {
    headers: { 'Authorization': `Bearer ${this.token}` }
  })
    .then(r => r.json())
    .then(data => {
      if (this._gifTab === 'favorites') return; // tab switched mid-flight
      if (data.error === 'gif_not_configured') {
        this._showGifSetupGuide(grid);
        return;
      }
      if (data.error) {
        grid.innerHTML = `<div class="gif-picker-empty">${this._escapeHtml(data.error)}</div>`;
        return;
      }
      this._setGifFooter(data.provider);
      this._renderGifGrid(data.results || []);
    })
    .catch(() => {
      if (this._gifTab === 'favorites') return;
      grid.innerHTML = `<div class="gif-picker-empty">${t('gifs.load_failed')}</div>`;
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
      if (this._gifTab === 'favorites') return; // tab switched mid-flight
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
      this._setGifFooter(data.provider);
      this._renderGifGrid(results);
    })
    .catch(() => {
      if (this._gifTab === 'favorites') return;
      grid.innerHTML = `<div class="gif-picker-empty">${t('gifs.search_failed')}</div>`;
    });
},

_showGifSetupGuide(grid) {
  const isAdmin = this.user && this.user.isAdmin;
  if (isAdmin) {
    // GIPHY is the supported provider. Tenor is no longer offered here;
    // an existing tenor_api_key still works on the server if no GIPHY key is set.
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
          <input type="text" id="gif-provider-key-input" placeholder="${t('gifs.setup.key_placeholder')}" spellcheck="false" autocomplete="off" />
          <button id="gif-provider-key-save">${t('gifs.setup.save_btn')}</button>
        </div>
        <p class="gif-setup-note">💡 ${t('gifs.setup.note')}</p>
      </div>`;
    const saveBtn = document.getElementById('gif-provider-key-save');
    const input = document.getElementById('gif-provider-key-input');
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
    const full = gif.full || gif.tiny;
    const item = document.createElement('div');
    item.className = 'gif-item';

    const img = document.createElement('img');
    img.src = gif.tiny;
    img.alt = gif.title || 'GIF';
    img.loading = 'lazy';
    img.dataset.full = full;

    const star = document.createElement('button');
    star.type = 'button';
    star.className = 'gif-fav-btn';
    star.dataset.full = full;
    star.dataset.tiny = gif.tiny;
    star.dataset.title = gif.title || '';
    this._paintGifStar(star, this._isGifFavorited(full));

    item.append(img, star);
    grid.appendChild(item);
  });
},

/** Sync a star button's glyph, state class and tooltip to `favorited`. */
_paintGifStar(star, favorited) {
  star.classList.toggle('favorited', favorited);
  star.textContent = favorited ? '★' : '☆';
  star.title = favorited ? t('gifs.unfavorite') : t('gifs.favorite');
  star.setAttribute('aria-label', star.title);
  star.setAttribute('aria-pressed', String(favorited));
},

_renderGifFavorites(query = '') {
  const grid = document.getElementById('gif-grid');
  const q = query.trim().toLowerCase();
  let favs = this._getGifFavorites();
  if (q) favs = favs.filter(g => (g.title || '').toLowerCase().includes(q));
  if (!favs.length) {
    grid.innerHTML = `<div class="gif-picker-empty">${q ? t('gifs.no_favorite_matches') : t('gifs.no_favorites')}</div>`;
    return;
  }
  this._renderGifGrid(favs);
},

_getGifFavorites() {
  if (this._gifFavorites) return this._gifFavorites;
  try {
    const raw = JSON.parse(localStorage.getItem(GIF_FAVORITES_KEY) || '[]');
    this._gifFavorites = Array.isArray(raw)
      ? raw.filter(g => g && typeof g.full === 'string' && typeof g.tiny === 'string')
      : [];
  } catch {
    this._gifFavorites = [];
  }
  return this._gifFavorites;
},

_isGifFavorited(full) {
  return this._getGifFavorites().some(g => g.full === full);
},

/** Toggle a GIF in the favorites list. Returns its new favorited state. */
_toggleGifFavorite(gif) {
  if (!gif || !gif.full || !gif.tiny) return false;
  const favs = this._getGifFavorites();
  const idx = favs.findIndex(g => g.full === gif.full);
  if (idx !== -1) {
    favs.splice(idx, 1);
    this._saveGifFavorites();
    return false;
  }
  // Newest first, oldest trimmed once the cap is hit
  favs.unshift({ full: gif.full, tiny: gif.tiny, title: gif.title || '' });
  if (favs.length > GIF_FAVORITES_MAX) favs.length = GIF_FAVORITES_MAX;
  this._saveGifFavorites();
  return true;
},

_saveGifFavorites() {
  try {
    localStorage.setItem(GIF_FAVORITES_KEY, JSON.stringify(this._gifFavorites || []));
  } catch { /* quota exceeded — favorites are best-effort */ }
},

_sendGifMessage(url) {
  if (!this.currentChannel || !url) return;
  // In a DM the GIF goes out through the composer's own send, the way a
  // sticker does, so it is encrypted like any other DM message; sent
  // straight to the server it stayed plain text. Whatever was typed in the
  // box is put back afterwards.
  const dmCh = this.channels && this.channels.find(c => c.code === this.currentChannel);
  const input = document.getElementById('message-input');
  if (dmCh && dmCh.is_dm && input && typeof this._sendMessage === 'function') {
    const draft = input.value;
    input.value = url;
    Promise.resolve(this._sendMessage()).catch((err) => { console.warn('[GIF] send failed', err); }).then((sent) => {
      // Backing out of an unencrypted send leaves the GIF's link in the box,
      // and the draft is what belongs there.
      if (sent === false || (draft && !input.value)) {
        input.value = draft;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    return;
  }
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

// Send a sticker URL as a message. Routes to the active picker context
// (main composer, thread composer, or DM PiP) so stickers respect the
// surrounding scope, replies, and E2E encryption that each composer applies.
_sendStickerMessage(url) {
  if (!url) return;
  const ctx = this._emojiPickerContext || 'main';
  if (ctx === 'thread') {
    if (!this._activeThreadParent) return;
    const input = document.getElementById('thread-input');
    if (!input) return;
    input.value = url;
    this._sendThreadMessage();
    return;
  }
  if (ctx === 'dmpip') {
    if (!this._activeDMPip) return;
    const input = document.getElementById('dm-pip-input');
    if (!input) return;
    input.value = url;
    this._sendDMPiPMessage();
    return;
  }
  // Main composer — go through _sendMessage so E2E DMs and slash-command
  // pre-processing apply uniformly.
  const input = document.getElementById('message-input');
  if (!input || !this.currentChannel) return;
  const draft = input.value;
  input.value = url;
  if (typeof this._sendMessage === 'function') {
    // Backing out of an unencrypted send brings back the draft, not the link.
    Promise.resolve(this._sendMessage()).then((sent) => {
      if (sent !== false) return;
      input.value = draft;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }).catch((err) => { console.warn('[GIF] send failed', err); });
  } else this.socket.emit('send-message', { code: this.currentChannel, content: url });
},

// /gif slash command — inline GIF search results above the input
_showGifSlashResults(query) {
  // Remove any existing picker
  document.getElementById('gif-slash-picker')?.remove();

  const picker = document.createElement('div');
  picker.id = 'gif-slash-picker';
  picker.className = 'gif-slash-picker';
  picker.innerHTML = `<div class="gif-slash-loading">${t('gifs.searching')}</div>`;

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
        picker.innerHTML = `<div class="gif-slash-loading">${t('gifs.setup.unavailable_desc')}</div>`;
        return;
      }
      if (data.error) { picker.innerHTML = `<div class="gif-slash-loading">${this._escapeHtml(data.error)}</div>`; return; }
      const results = data.results || [];
      if (results.length === 0) { picker.innerHTML = `<div class="gif-slash-loading">${t('gifs.no_results')}</div>`; return; }

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
      picker.innerHTML = `<div class="gif-slash-loading">${t('gifs.search_failed')}</div>`;
    });
},

};
