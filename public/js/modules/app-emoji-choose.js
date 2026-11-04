// Picking one emoji for a field that holds one, such as each role on a role
// menu: every emoji Haven has, with the server's custom ones and Haven's own
// pictures (platforms, flags) first, and a search box. _chooseEmoji(anchor)
// resolves the pick, ":name:" for a named one, or null.

const NAMED = /^:([a-zA-Z0-9_-]{1,30}):$/;

export default {

// The picture for one emoji: an image for :name:, the character otherwise.
_emojiGlyphHtml(emoji, size = 20) {
  const m = NAMED.exec(emoji || '');
  const named = m && this._findNamedEmoji(m[1]);
  if (named) return `<img src="${this._escapeHtml(named.url)}" alt="${this._escapeHtml(emoji)}" class="custom-emoji" style="width:${size}px;height:${size}px">`;
  return this._escapeHtml(emoji || '');
},

// The emoji the chooser offers, in groups: custom first, then Haven's own,
// then the rest of the picker's categories.
_emojiChooserGroups() {
  const groups = [];
  if (this.customEmojis?.length) groups.push({ key: 'custom', items: this.customEmojis.map(e => `:${e.name}:`) });
  const cats = this.emojiCategories || {};
  if (cats.Platforms) groups.push({ key: 'platforms', items: cats.Platforms });
  for (const [name, items] of Object.entries(cats)) {
    if (name !== 'Platforms') groups.push({ key: name.toLowerCase(), items });
  }
  return groups;
},

// The words an emoji is found by.
_emojiChooserWords(emoji) {
  const m = NAMED.exec(emoji);
  if (m) {
    const named = this._findNamedEmoji(m[1]);
    return `${m[1].replace(/_/g, ' ')} ${named?.keywords || ''}`.toLowerCase();
  }
  return (this.emojiNames?.[emoji] || '').toLowerCase();
},

_chooseEmoji(anchor) {
  this._emojiChooserClose?.(null);
  return new Promise((resolve) => {
    const pop = document.createElement('div');
    pop.className = 'emoji-chooser';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', t('emoji.choose'));
    pop.innerHTML = `<input type="search" class="emoji-chooser-search" placeholder="${this._escapeHtml(t('emoji.search_placeholder'))}" aria-label="${this._escapeHtml(t('emoji.search_placeholder'))}">
      <div class="emoji-chooser-grid"></div>`;
    const search = pop.querySelector('.emoji-chooser-search');
    const grid = pop.querySelector('.emoji-chooser-grid');
    const groups = this._emojiChooserGroups();

    const draw = () => {
      const q = search.value.trim().toLowerCase();
      let html = '';
      const seen = new Set();
      for (const g of groups) {
        const items = g.items.filter(e => !seen.has(e) && (!q || this._emojiChooserWords(e).includes(q)));
        if (!items.length) continue;
        items.forEach(e => seen.add(e));
        html += `<div class="emoji-chooser-label">${this._escapeHtml(t(`emoji.categories.${g.key}`))}</div>`
          + items.map(e => `<button type="button" class="emoji-chooser-btn" data-emoji="${this._escapeHtml(e)}" title="${this._escapeHtml(NAMED.test(e) ? e : (this.emojiNames?.[e] || e).split(' ')[0])}">${this._emojiGlyphHtml(e, 22)}</button>`).join('');
      }
      grid.innerHTML = html || `<div class="emoji-chooser-none">${this._escapeHtml(t('emoji.no_results'))}</div>`;
    };

    const place = () => {
      const r = anchor.getBoundingClientRect();
      const w = pop.offsetWidth;
      const h = pop.offsetHeight;
      const left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8));
      const below = r.bottom + 6;
      pop.style.left = `${left}px`;
      pop.style.top = `${below + h <= window.innerHeight - 8 ? below : Math.max(8, r.top - h - 6)}px`;
    };

    const onDown = (e) => { if (!pop.contains(e.target) && e.target !== anchor) close(null); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(null); } };
    const close = (value) => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      pop.remove();
      this._emojiChooserClose = null;
      resolve(value);
      anchor.focus?.();
    };
    this._emojiChooserClose = close;

    grid.addEventListener('click', (e) => {
      const btn = e.target.closest('.emoji-chooser-btn');
      if (btn) close(btn.dataset.emoji);
    });
    search.addEventListener('input', draw);
    search.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const first = grid.querySelector('.emoji-chooser-btn');
      if (first) close(first.dataset.emoji);
    });
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);

    draw();
    document.body.appendChild(pop);
    place();
    search.focus();
  });
},

};
