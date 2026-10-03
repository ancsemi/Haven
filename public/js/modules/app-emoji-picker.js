// Emoji pickers: skin tones, the emoji picker, reaction pickers and the
// quick reactions row, and the list of who reacted.

// Emoji skin tones. A tone is a Unicode Fitzpatrick modifier appended to a
// "modifier base" emoji (hands, people, body parts); non-base emoji are left
// untouched. EMOJI_MODIFIER_BASE is the authoritative set from the Unicode
// emoji-data, so the transform stays correct as Haven's emoji lists grow.
const SKIN_TONE_KEY = 'haven_emoji_skin_tone';
const SKIN_TONE_MODIFIERS = {
  light: '\u{1F3FB}', 'medium-light': '\u{1F3FC}', medium: '\u{1F3FD}',
  'medium-dark': '\u{1F3FE}', dark: '\u{1F3FF}'
};
const EMOJI_MODIFIER_BASE = new Set(
  ('261D 26F9 270A 270B 270C 270D 1F385 1F3C2 1F3C3 1F3C4 1F3C7 1F3CA 1F3CB 1F3CC ' +
   '1F442 1F443 1F446 1F447 1F448 1F449 1F44A 1F44B 1F44C 1F44D 1F44E 1F44F 1F450 ' +
   '1F466 1F467 1F468 1F469 1F46B 1F46C 1F46D 1F46E 1F470 1F471 1F472 1F473 1F474 ' +
   '1F475 1F476 1F477 1F478 1F47C 1F481 1F482 1F483 1F485 1F486 1F487 1F48F 1F491 ' +
   '1F4AA 1F574 1F575 1F57A 1F590 1F595 1F596 1F645 1F646 1F647 1F64B 1F64C 1F64D ' +
   '1F64E 1F64F 1F6A3 1F6B4 1F6B5 1F6B6 1F6C0 1F6CC 1F90C 1F90F 1F918 1F919 1F91A ' +
   '1F91B 1F91C 1F91D 1F91E 1F91F 1F926 1F930 1F931 1F932 1F933 1F934 1F935 1F936 ' +
   '1F937 1F938 1F939 1F93D 1F93E 1F977 1F9B5 1F9B6 1F9B8 1F9B9 1F9BB 1F9CD 1F9CE ' +
   '1F9CF 1F9D1 1F9D2 1F9D3 1F9D4 1F9D5 1F9D6 1F9D7 1F9D8 1F9D9 1F9DA 1F9DB 1F9DC ' +
   '1F9DD 1FAC3 1FAC4 1FAC5 1FAF0 1FAF1 1FAF2 1FAF3 1FAF4 1FAF5 1FAF6 1FAF7 1FAF8')
  .split(' ').map(h => String.fromCodePoint(parseInt(h, 16)))
);

export default {

// ═══════════════════════════════════════════════════════
// EMOJI PICKER (categorized + searchable)
// ═══════════════════════════════════════════════════════

// Skin-tone preference, cached in memory and mirrored to localStorage
// (same pattern as _getQuickEmojis). Stored as base emoji everywhere; the
// tone is applied only at display and insert time via _toneEmoji.
_getEmojiSkinTone() {
  if (this._skinTone === undefined) this._skinTone = localStorage.getItem(SKIN_TONE_KEY) || 'default';
  return this._skinTone;
},

_saveEmojiSkinTone(tone) {
  this._skinTone = tone;
  localStorage.setItem(SKIN_TONE_KEY, tone);
},

// Apply a specific tone to one emoji. Only single-person "modifier base"
// emoji are toned; multi-person sequences (couples, people holding hands)
// carry more than one base and are left as-is.
_applySkinTone(emoji, tone) {
  const mod = SKIN_TONE_MODIFIERS[tone];
  if (!mod || typeof emoji !== 'string') return emoji;
  // Prefer the set derived from the server's emoji list; fall back to the
  // built-in one when the standard list hasn't loaded.
  const base = this._emojiModifierBase || EMOJI_MODIFIER_BASE;
  const cps = [...emoji];
  if (cps.filter(c => base.has(c)).length !== 1) return emoji;
  const out = [];
  for (let i = 0; i < cps.length; i++) {
    out.push(cps[i]);
    if (base.has(cps[i])) {
      out.push(mod);
      if (cps[i + 1] === '\uFE0F') i++; // skip VS16: the modifier already implies emoji style
    }
  }
  return out.join('');
},

// Apply the user's current tone — used at every render/insert surface.
_toneEmoji(emoji) {
  return this._applySkinTone(emoji, this._getEmojiSkinTone());
},

_toggleEmojiPicker(anchorEl) {
  const picker = document.getElementById('emoji-picker');
  if (picker.style.display === 'flex') {
    picker.style.display = 'none';
    if (picker._havenOrigParent) {
      picker._havenOrigParent.appendChild(picker);
      picker._havenOrigParent = null;
      ['position', 'top', 'left', 'bottom', 'right', 'z-index'].forEach(p => picker.style.removeProperty(p));
    }
    return;
  }
  picker.innerHTML = '';
  this._emojiActiveCategory = this._emojiActiveCategory || Object.keys(this.emojiCategories)[0];
  this._emojiPickerSection = this._emojiPickerSection || 'emoji';

  // Section toggle (Emoji | Sticker)
  const sectionRow = document.createElement('div');
  sectionRow.className = 'emoji-section-row';
  const mkSectionBtn = (key, label) => {
    const b = document.createElement('button');
    b.className = 'emoji-section-tab' + (this._emojiPickerSection === key ? ' active' : '');
    b.textContent = label;
    b.addEventListener('click', (ev) => {
      // (#5335) Prevent the click from bubbling to the global outside-click
      // handler in app-ui.js. Without this, the rebuild below detaches the
      // tab DOM node mid-event, so by the time the document listener checks
      // `picker.contains(e.target)` the original target is gone, the check
      // returns false, and the picker is auto-closed every time the user
      // switches between Emoji and Stickers.
      ev.stopPropagation();
      if (this._emojiPickerSection === key) return;
      this._emojiPickerSection = key;
      // Re-open to rebuild contents in the new section.
      picker.style.display = 'none';
      this._toggleEmojiPicker(anchorEl);
    });
    return b;
  };
  sectionRow.appendChild(mkSectionBtn('emoji', t('emoji.section_emoji')));
  sectionRow.appendChild(mkSectionBtn('sticker', t('emoji.section_sticker')));
  picker.appendChild(sectionRow);

  // ── Sticker section ──
  if (this._emojiPickerSection === 'sticker') {
    const stickerSearchRow = document.createElement('div');
    stickerSearchRow.className = 'emoji-search-row';
    const stickerSearch = document.createElement('input');
    stickerSearch.type = 'text';
    stickerSearch.className = 'emoji-search-input';
    stickerSearch.placeholder = t('emoji.sticker_search_placeholder');
    stickerSearch.maxLength = 30;
    stickerSearchRow.appendChild(stickerSearch);
    picker.appendChild(stickerSearchRow);

    const stickers = Array.isArray(this.stickers) ? this.stickers : [];
    const packs = [...new Set(stickers.map(s => s.pack_name || 'General'))].sort((a, b) => a.localeCompare(b));
    this._activeStickerPack = this._activeStickerPack && packs.includes(this._activeStickerPack)
      ? this._activeStickerPack
      : (packs[0] || null);

    if (packs.length > 1) {
      const packRow = document.createElement('div');
      packRow.className = 'sticker-pack-row';
      packs.forEach(pack => {
        const tab = document.createElement('button');
        tab.className = 'sticker-pack-btn' + (pack === this._activeStickerPack ? ' active' : '');
        tab.textContent = pack;
        tab.title = pack;
        tab.addEventListener('click', () => {
          this._activeStickerPack = pack;
          stickerSearch.value = '';
          renderStickers();
          packRow.querySelectorAll('.sticker-pack-btn').forEach(t => t.classList.remove('active'));
          tab.classList.add('active');
        });
        packRow.appendChild(tab);
      });
      picker.appendChild(packRow);
    }

    const grid = document.createElement('div');
    grid.className = 'sticker-grid';
    picker.appendChild(grid);

    const self = this;
    function renderStickers(filter) {
      grid.innerHTML = '';
      let list = stickers;
      if (filter) {
        const q = filter.toLowerCase();
        list = stickers.filter(s =>
          (s.name || '').toLowerCase().includes(q) ||
          (s.pack_name || '').toLowerCase().includes(q)
        );
      } else if (self._activeStickerPack) {
        list = stickers.filter(s => (s.pack_name || 'General') === self._activeStickerPack);
      }
      if (list.length === 0) {
        grid.innerHTML = `<p class="muted-text" style="padding:12px;font-size:0.75rem;width:100%;text-align:center">${
          stickers.length === 0
            ? t('emoji.no_stickers')
            : t('emoji.no_results')
        }</p>`;
        return;
      }
      list.forEach(sticker => {
        const btn = document.createElement('button');
        btn.className = 'sticker-picker-item';
        btn.title = `:${sticker.name}:`;
        btn.innerHTML = `<img src="${self._escapeHtml(sticker.url)}" alt=":${self._escapeHtml(sticker.name)}:" class="sticker-picker-thumb">`;
        btn.addEventListener('click', () => {
          self._sendStickerMessage(sticker.url);
          picker.style.display = 'none';
          if (picker._havenOrigParent) {
            picker._havenOrigParent.appendChild(picker);
            picker._havenOrigParent = null;
            ['position', 'top', 'left', 'bottom', 'right', 'z-index'].forEach(p => picker.style.removeProperty(p));
          }
        });
        grid.appendChild(btn);
      });
    }

    stickerSearch.addEventListener('input', () => {
      const q = stickerSearch.value.trim();
      renderStickers(q || null);
    });

    renderStickers();

    // Anchor positioning + display reused below — fall through to common code.
    if (anchorEl) {
      if (picker.parentElement !== document.body) {
        picker._havenOrigParent = picker.parentElement;
        document.body.appendChild(picker);
      }
      const r = anchorEl.getBoundingClientRect();
      const pickerW = 340;
      const pickerH = 368;
      const top = Math.max(4, r.top - pickerH - 4);
      const left = Math.max(4, Math.min(r.left, window.innerWidth - pickerW - 4));
      picker.style.cssText += '; position:fixed; top:' + top + 'px; left:' + left + 'px; bottom:auto; right:auto; z-index:100030;';
    }
    picker.style.display = 'flex';
    return;
  }

  // ── Emoji section (default) ──

  // Search bar
  const searchRow = document.createElement('div');
  searchRow.className = 'emoji-search-row';
  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.className = 'emoji-search-input';
  searchInput.placeholder = t('emoji.search_placeholder');
  searchInput.maxLength = 30;
  searchRow.appendChild(searchInput);

  // Skin-tone selector: a hand button whose glyph reflects the current tone,
  // opening a dropdown of Default + the five tones. Picking one saves the
  // preference and re-renders so every emoji adopts it.
  const skinBtn = document.createElement('button');
  skinBtn.className = 'emoji-skin-btn';
  skinBtn.title = t('emoji.skin_tone');
  const skinMenu = document.createElement('div');
  skinMenu.className = 'emoji-skin-menu';
  skinMenu.style.display = 'none';
  const paintSkinBtn = () => { skinBtn.textContent = this._toneEmoji('✋'); };
  paintSkinBtn();
  ['default', 'light', 'medium-light', 'medium', 'medium-dark', 'dark'].forEach(tone => {
    const opt = document.createElement('button');
    opt.className = 'emoji-skin-opt';
    opt.textContent = this._applySkinTone('✋', tone);
    opt.title = t(`emoji.skin_tones.${tone.replace('-', '_')}`);
    opt.addEventListener('click', (ev) => {
      ev.stopPropagation();
      this._saveEmojiSkinTone(tone);
      paintSkinBtn();
      skinMenu.style.display = 'none';
      renderGrid(searchInput.value.trim() || null);
    });
    skinMenu.appendChild(opt);
  });
  skinBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    skinMenu.style.display = skinMenu.style.display === 'none' ? 'flex' : 'none';
  });
  searchRow.appendChild(skinBtn);
  searchRow.appendChild(skinMenu);
  picker.appendChild(searchRow);

  // Build combined categories — custom first so they sit front and centre,
  // then the standard sets.
  const allCategories = {};
  const hasCustom = this.customEmojis && this.customEmojis.length > 0;
  if (hasCustom) {
    allCategories['Custom'] = this.customEmojis.map(e => `:${e.name}:`);
  }
  Object.assign(allCategories, this.emojiCategories);
  this._emojiActiveCategory = Object.keys(allCategories)[0];

  // Category tabs — clicking scrolls the grid to that section rather than
  // swapping it out, so every category is reachable by scrolling too.
  const tabRow = document.createElement('div');
  tabRow.className = 'emoji-tab-row';
  const catIcons = { 'Smileys':'😀', 'People':'👋', 'Animals':'🐶', 'Food':'🍕', 'Activities':'🎮', 'Travel':'🚀', 'Objects':'💡', 'Symbols':'❤️', 'Flags':'🚩', 'Custom':'⭐' };
  const catTabs = {};
  const catSections = {}; // cat -> non-sticky section wrapper, our stable scroll anchor
  const setActiveTab = (cat) => {
    for (const [c, tab] of Object.entries(catTabs)) tab.classList.toggle('active', c === cat);
  };
  for (const cat of Object.keys(allCategories)) {
    const tab = document.createElement('button');
    tab.className = 'emoji-tab' + (cat === this._emojiActiveCategory ? ' active' : '');
    tab.textContent = catIcons[cat] || cat.charAt(0);
    tab.title = t(`emoji.categories.${cat.toLowerCase()}`) || cat;
    tab.addEventListener('click', () => {
      if (searchInput.value.trim()) { searchInput.value = ''; renderGrid(); }
      const section = catSections[cat];
      // Scroll to the section wrapper, not its header: the wrapper isn't
      // sticky, so its offsetTop is always the true layout position.
      if (section) {
        grid.scrollTop = section.offsetTop;
        // Move the keyboard highlight to this category's first emoji, so
        // arrowing/Enter continues from where the user just jumped to.
        highlightFirstEmoji(section);
      }
      setActiveTab(cat);
    });
    catTabs[cat] = tab;
    tabRow.appendChild(tab);
  }
  picker.appendChild(tabRow);

  // Grid
  const grid = document.createElement('div');
  grid.className = 'emoji-grid';
  picker.appendChild(grid);

  const self = this;
  function appendEmojiButton(parent, emoji) {
    const btn = document.createElement('button');
    btn.className = 'emoji-item';
    // Check if it's a custom emoji (:name:)
    const customMatch = typeof emoji === 'string' && emoji.match(/^:([a-zA-Z0-9_-]+):$/);
    // Standard emoji get the current skin tone; custom emoji pass through.
    const value = customMatch ? emoji : self._toneEmoji(emoji);
    if (customMatch) {
      const ce = self._findNamedEmoji(customMatch[1]);
      if (ce) {
        btn.innerHTML = `<img src="${self._escapeHtml(ce.url)}" alt=":${self._escapeHtml(ce.name)}:" class="custom-emoji">`;
        btn.title = `:${ce.name}:`;
      } else {
        btn.textContent = emoji;
        btn.title = emoji;
      }
    } else {
      btn.textContent = value;
      // Use the first keyword (canonical name) as the tooltip,
      // matching the reaction picker behavior.
      const names = self.emojiNames && self.emojiNames[emoji];
      btn.title = names ? names.split(/\s+/)[0] : emoji;
    }
    btn.addEventListener('click', () => {
      // Insert into the active edit textarea if editing, otherwise the main input
      const input = self._activeEditTextarea || document.getElementById('message-input');
      const start = input.selectionStart;
      const end = input.selectionEnd;
      input.value = input.value.substring(0, start) + value + input.value.substring(end);
      input.selectionStart = input.selectionEnd = start + value.length;
      input.focus();
    });
    parent.appendChild(btn);
  }

  // Keyboard nav: highlight the first emoji so arrow keys + Enter work the
  // moment the picker opens (Discord-style). Re-run after every grid render.
  // Pass a section to highlight the first emoji within it (e.g. after a
  // category jump); defaults to the first emoji in the whole grid.
  const highlightFirstEmoji = (scope) => {
    grid.querySelectorAll('.emoji-item.kb-active').forEach(el => el.classList.remove('kb-active'));
    const first = (scope || grid).querySelector('.emoji-item');
    if (first) first.classList.add('kb-active');
  };

  function renderGrid(filter) {
    grid.innerHTML = '';
    for (const k in catSections) delete catSections[k];
    if (filter) {
      const q = filter.toLowerCase().trim();
      const matched = new Set();
      // Search by keyword, literal character, and punctuation alias
      for (const [emoji, keywords] of Object.entries(self.emojiNames)) {
        if (self._emojiSearchMatch(emoji, keywords, filter)) matched.add(emoji);
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
      // Search bundled built-in image emoji by name + keywords
      if (self.builtinEmojis) {
        self.builtinEmojis.forEach(e => {
          if (e.name.includes(q) || (e.keywords && e.keywords.toLowerCase().includes(q))) matched.add(`:${e.name}:`);
        });
      }
      if (matched.size === 0) {
        grid.innerHTML = `<p class="muted-text" style="padding:12px;font-size:0.75rem;width:100%;text-align:center">${t('emoji.no_results')}</p>`;
        return;
      }
      const results = document.createElement('div');
      results.className = 'emoji-cat-grid';
      matched.forEach(e => appendEmojiButton(results, e));
      grid.appendChild(results);
      highlightFirstEmoji();
      return;
    }
    // No filter: render every category as its own section (sticky header +
    // its emoji grid) so scrolling flows through all of them and adjacent
    // headers push each other out cleanly.
    for (const [cat, list] of Object.entries(allCategories)) {
      const section = document.createElement('div');
      section.className = 'emoji-cat';
      const header = document.createElement('div');
      header.className = 'emoji-cat-header';
      header.textContent = t(`emoji.categories.${cat.toLowerCase()}`) || cat;
      section.appendChild(header);
      const catGrid = document.createElement('div');
      catGrid.className = 'emoji-cat-grid';
      list.forEach(e => appendEmojiButton(catGrid, e));
      section.appendChild(catGrid);
      grid.appendChild(section);
      catSections[cat] = section;
    }
    highlightFirstEmoji();
  }

  // Scroll-spy: highlight the tab of whichever section is at the top. Compares
  // stable offsetTop values against scrollTop — no sticky-poisoned measurements.
  grid.addEventListener('scroll', () => {
    if (searchInput.value.trim()) return;
    const y = grid.scrollTop;
    let current = null;
    for (const cat of Object.keys(catSections)) {
      if (catSections[cat].offsetTop - y <= 8) current = cat;
      else break;
    }
    if (current && current !== self._emojiActiveCategory) {
      self._emojiActiveCategory = current;
      setActiveTab(current);
    }
  });

  searchInput.addEventListener('input', () => {
    const q = searchInput.value.trim();
    renderGrid(q || null);
    if (!q) setActiveTab(self._emojiActiveCategory = Object.keys(allCategories)[0]);
  });

  renderGrid();

  // Arrow-key navigation + Enter to pick, bound once to the picker. Reads its
  // state from the DOM on each keypress so it survives the grid being rebuilt
  // on search/category changes. Enter reuses the emoji's own click handler, so
  // there's a single source of truth for what "picking" an emoji does.
  if (!picker._havenNavBound) {
    picker._havenNavBound = true;
    picker.addEventListener('keydown', (e) => {
      if (picker.style.display === 'none') return;
      const items = [...picker.querySelectorAll('.emoji-grid .emoji-item')];
      if (!items.length) return;
      const active = picker.querySelector('.emoji-item.kb-active');
      const setActive = (el) => {
        if (!el) return;
        items.forEach(i => i.classList.remove('kb-active'));
        el.classList.add('kb-active');
        el.scrollIntoView({ block: 'nearest' });
      };
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const idx = active ? items.indexOf(active) : -1;
        if (idx === -1) { setActive(items[0]); return; }
        if (e.key === 'ArrowRight') setActive(items[Math.min(idx + 1, items.length - 1)]);
        else if (e.key === 'ArrowLeft') setActive(items[Math.max(idx - 1, 0)]);
        else setActive(this._emojiGridVerticalNav(items, idx, e.key === 'ArrowDown' ? 1 : -1));
      } else if (e.key === 'Enter' && active) {
        e.preventDefault();
        active.click(); // insert the selected emoji (same as clicking it)
        if (e.shiftKey) {
          // Shift+Enter: keep the menu open to pick more; clicking moved focus
          // to the message box, so hand it back to the search field.
          picker.querySelector('.emoji-search-input')?.focus();
        } else {
          this._toggleEmojiPicker(); // plain Enter closes after one pick
        }
      }
    });
  }

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

  // Anchor-based positioning: used when opening from PiP or thread input buttons.
  // Move the picker to document.body so it escapes any overflow clipping context,
  // then position it with fixed coords above the anchor button. Boost z-index so
  // it renders above the dm-pip-panel (z-index 99999) and pip-mode thread-panel
  // (z-index 99999).
  if (anchorEl) {
    if (picker.parentElement !== document.body) {
      picker._havenOrigParent = picker.parentElement;
      document.body.appendChild(picker);
    }
    const r = anchorEl.getBoundingClientRect();
    const pickerW = 340;
    const pickerH = 368;
    const top = Math.max(4, r.top - pickerH - 4);
    const left = Math.max(4, Math.min(r.left, window.innerWidth - pickerW - 4));
    picker.style.cssText += '; position:fixed; top:' + top + 'px; left:' + left + 'px; bottom:auto; right:auto; z-index:100030;';
  }

  picker.style.display = 'flex';
  searchInput.focus();

  // Always open scrolled to the top, so the view and the keyboard highlight
  // both start on the first category in every browser. Chromium discards the
  // old scroll when the grid is rebuilt; Firefox/Safari can preserve it, which
  // would leave the view on the last-used category while the highlight resets.
  grid.scrollTop = 0;
},

// Find the emoji one visual row above/below the current one (dir: -1 up, 1 down).
// Emoji wrap into rows of varying counts across category sections, so this walks
// by geometry rather than a fixed column count: nearest row wins first, then the
// closest horizontal neighbour in that row.
_emojiGridVerticalNav(items, idx, dir) {
  const cur = items[idx].getBoundingClientRect();
  const curX = cur.left + cur.width / 2;
  const curY = cur.top + cur.height / 2;
  let best = null, bestScore = Infinity;
  for (let i = 0; i < items.length; i++) {
    if (i === idx) continue;
    const r = items[i].getBoundingClientRect();
    const dy = (r.top + r.height / 2) - curY;
    if (dir === 1 ? dy <= 2 : dy >= -2) continue; // must be strictly below/above
    const score = Math.abs(dy) * 1000 + Math.abs((r.left + r.width / 2) - curX);
    if (score < bestScore) { bestScore = score; best = items[i]; }
  }
  return best || items[idx];
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
    try { const arr = JSON.parse(saved); if (Array.isArray(arr) && arr.length === 8) return arr; } catch { /* corrupt saved list: use the defaults below */ }
  }
  return ['👍','👎','😂','❤️','🔥','💯','😮','😢'];
},

_saveQuickEmojis(emojis) {
  localStorage.setItem('haven_quick_emojis', JSON.stringify(emojis));
},

_showQuickEmojiEditor(picker, msgEl, msgId) {
  // Remove any existing editor AND any open full picker. Both panels carry the
  // .reaction-full-picker class and both are absolutely positioned at
  // bottom:100%/right:0 on the same message, so leaving one behind stacks two
  // 320px panels on the exact same spot — which reads as "the emoji pane
  // covered everything and I can't reach the slot row". _showFullReactionPicker
  // already clears both directions; this is the missing mirror of that.
  document.querySelectorAll('.quick-emoji-editor, .reaction-full-picker').forEach(el => el.remove());

  const editor = document.createElement('div');
  editor.className = 'quick-emoji-editor reaction-full-picker';

  const title = document.createElement('div');
  title.className = 'reaction-full-category';
  title.textContent = t('emoji.customize_quick_title');
  editor.appendChild(title);

  const hint = document.createElement('p');
  hint.className = 'muted-text';
  hint.style.cssText = 'font-size:0.6875rem;padding:0 8px 6px;margin:0';
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
        const ce = this._findNamedEmoji(customMatch[1]);
        if (ce) {
          slot.innerHTML = `<img src="${this._escapeHtml(ce.url)}" alt="${this._escapeHtml(emoji)}" class="custom-emoji" style="width:20px;height:20px">`;
          slot.title = `:${ce.name}:`;
        } else {
          slot.textContent = emoji;
          slot.title = emoji;
        }
      } else {
        slot.textContent = this._toneEmoji(emoji);
        slot.title = (this.emojiNames && this.emojiNames[emoji]) ? this.emojiNames[emoji] : emoji;
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
        const named = this._findNamedEmoji((typeof emoji === 'string' && (emoji.match(/^:([a-zA-Z0-9_-]+):$/) || [])[1]) || '');
        if (named) btn.innerHTML = `<img src="${this._escapeHtml(named.url)}" alt="${this._escapeHtml(emoji)}" class="custom-emoji" style="width:22px;height:22px">`;
        else btn.textContent = this._toneEmoji(emoji);
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

  // Placement parity with _showReactionPicker. Without this the editor is
  // positioned by CSS alone (always above the message), so opening it on a
  // message near the top of the viewport — or inside a PiP panel, which clips
  // overflow — pushes the slot row off-screen.
  const pipParent = msgEl.closest('.dm-pip-panel, .thread-panel.pip');
  if (pipParent) {
    const msgRect = msgEl.getBoundingClientRect();
    document.body.appendChild(editor);
    editor.style.position = 'fixed';
    editor.style.zIndex = '100021';
    requestAnimationFrame(() => {
      const r = editor.getBoundingClientRect();
      let top = msgRect.top - r.height - 6;
      if (top < 4) top = Math.min(msgRect.bottom + 6, window.innerHeight - r.height - 8);
      editor.style.top = Math.max(4, top) + 'px';
      editor.style.right = Math.max(8, window.innerWidth - msgRect.right) + 'px';
      editor.style.left = 'auto';
      editor.style.bottom = 'auto';
    });
  } else {
    requestAnimationFrame(() => {
      const r = editor.getBoundingClientRect();
      const container = msgEl.closest('#thread-messages, #messages, #dm-pip-messages');
      const containerTop = container ? container.getBoundingClientRect().top : 0;
      if (r.top < containerTop + 4) editor.classList.add('flip-below');
    });
  }
},

_showReactionPicker(msgEl, msgId) {
  const pickerRoot = msgEl?.closest('#dm-pip-messages, #messages, #thread-messages');
  const pickerCode = pickerRoot?.id === 'dm-pip-messages' ? this._activeDMPip : this.currentChannel;
  if (this._channelAllowsReactions && !this._channelAllowsReactions(pickerCode)) {
    this._showToast?.(t('channel_functions.reactions_disabled'), 'info');
    return;
  }

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
    const value = this._toneEmoji(emoji); // custom emoji pass through unchanged
    if (customMatch && this.customEmojis) {
      const ce = this._findNamedEmoji(customMatch[1]);
      if (ce) {
        btn.innerHTML = `<img src="${this._escapeHtml(ce.url)}" alt="${this._escapeHtml(emoji)}" class="custom-emoji" style="width:20px;height:20px">`;
        btn.title = `:${ce.name}:`;
      } else {
        btn.textContent = emoji;
        btn.title = emoji;
      }
    } else {
      btn.textContent = value;
      btn.title = (this.emojiNames && this.emojiNames[emoji]) ? this.emojiNames[emoji] : emoji;
    }
    btn.addEventListener('click', () => {
      this.socket.emit('add-reaction', { messageId: msgId, emoji: value });
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

  // PiP context: the dm-pip-panel and pip-mode thread-panel both have
  // `overflow: hidden`, which clips this absolute-positioned picker. Pop the
  // picker out to <body> with fixed positioning so it can render above the
  // floating panel.
  const pipParent = msgEl.closest('.dm-pip-panel, .thread-panel.pip');
  if (pipParent) {
    const msgRect = msgEl.getBoundingClientRect();
    document.body.appendChild(picker);
    picker.style.position = 'fixed';
    picker.style.zIndex = '100020';
    // Provisional placement above the message; flip-below check below
    // adjusts to under the message if there's no room above.
    const place = () => {
      const pickerRect = picker.getBoundingClientRect();
      let top = msgRect.top - pickerRect.height - 6;
      const below = msgRect.bottom + 6;
      const tooHigh = top < 4;
      if (tooHigh) top = below;
      const right = Math.max(8, window.innerWidth - msgRect.right);
      picker.style.top = top + 'px';
      picker.style.right = right + 'px';
      picker.style.left = 'auto';
      picker.style.bottom = 'auto';
    };
    requestAnimationFrame(place);
  }

  // Flip picker below the message if it would be clipped above
  requestAnimationFrame(() => {
    if (pipParent) return; // fixed-position branch handles placement
    const pickerRect = picker.getBoundingClientRect();
    const container = msgEl.closest('#thread-messages, #messages, #dm-pip-messages');
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
        ? emojis.filter(e => this._emojiSearchMatch(e, this.emojiNames[e] || '', filter) || category.toLowerCase().includes(lowerFilter))
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
        const named = this._findNamedEmoji((typeof emoji === 'string' && (emoji.match(/^:([a-zA-Z0-9_-]+):$/) || [])[1]) || '');
        const value = this._toneEmoji(emoji); // custom emoji pass through unchanged
        if (named) { btn.innerHTML = `<img src="${this._escapeHtml(named.url)}" alt="${this._escapeHtml(emoji)}" title="${this._escapeHtml(emoji)}" class="custom-emoji">`; }
        else { btn.textContent = value; btn.title = this.emojiNames[emoji] || ''; }
        btn.addEventListener('click', () => {
          this.socket.emit('add-reaction', { messageId: msgId, emoji: value });
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

  // Pop to body with fixed positioning so the panel never causes the messages
  // container to scroll-jump when the message is near the top of the viewport.
  document.body.appendChild(panel);
  panel.style.position = 'fixed';
  panel.style.zIndex = '100020';
  panel.style.bottom = 'auto';
  panel.style.right = 'auto';

  requestAnimationFrame(() => {
    const qRect = quickPicker.getBoundingClientRect();
    const panelH = panel.offsetHeight;
    const panelW = panel.offsetWidth;

    // Right-align with the quick picker, clamped to viewport edges
    let left = qRect.right - panelW;
    if (left < 8) left = 8;
    if (left + panelW > window.innerWidth - 8) left = window.innerWidth - panelW - 8;
    panel.style.left = left + 'px';

    // Open above the quick picker if there's room, otherwise open below
    if (qRect.top - 6 >= panelH + 8) {
      panel.style.top = (qRect.top - panelH - 6) + 'px';
    } else {
      panel.style.top = (qRect.bottom + 6) + 'px';
    }
  });
  searchInput.focus();
},

};
