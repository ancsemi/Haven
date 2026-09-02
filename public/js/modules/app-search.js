// ── Search panel (overhaul phase 1: look-and-feel) ──────────────────────────
// Discord-style search results overlay that sits over the right sidebar
// (voice + member list). The panel persists across channel switches: it only
// truly closes when the user clicks the X. Every navigation just hides/shows
// it, keeping per-context state (open flag, query, results, page, scroll).
//
// Contexts are keyed so public channels share one panel while each DM keeps
// its own independent one:
//   '__public__'   → shared across all non-DM channels (search is/will be global)
//   'dm:<code>'    → one per DM channel
//
// This phase does NOT change how search queries run. Server search still emits
// `search-messages` and DM search is still the client-side cache walk. Results
// just land in this panel via _searchReceiveResults(). Pagination is real UI
// but slices client-side over whatever the query already returned; phase 2
// swaps the slice for a server LIMIT/OFFSET page fetch. See search-overhaul.md.

const SEARCH_PAGE_SIZE = 25;
// has: options the server understands. Seeded here so adding one is a one-liner.
const SEARCH_HAS_OPTIONS = ['image', 'file', 'link', 'video', 'audio'];

export default {

_searchInit() {
  // Per-context view state. null = never opened / fully closed.
  //   { open, query, results, page, scrollTop, stale }
  this._searchState = Object.create(null);
  // Signature of the channel set we last saw, so a plain reconnect that
  // re-pushes an identical `channels-list` doesn't spuriously mark results
  // stale. Only a real membership/role change invalidates.
  this._searchChannelSig = null;

  const panel = document.getElementById('search-panel');
  if (!panel) return;

  document.getElementById('search-panel-close')?.addEventListener('click', () => this._searchClose());
  document.getElementById('search-page-prev')?.addEventListener('click', () => this._searchGoToPage(-1));
  document.getElementById('search-page-next')?.addEventListener('click', () => this._searchGoToPage(1));
  // Direct page entry — commit on Enter or blur (never per keystroke), so
  // jumping to page 20 is one fetch instead of 19 arrow clicks. Out-of-range
  // and non-numeric input is clamped/reverted in _searchGoToPageAbsolute.
  const pageInput = document.getElementById('search-page-input');
  if (pageInput) {
    pageInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this._searchGoToPageAbsolute(pageInput.value); pageInput.blur(); }
    });
    pageInput.addEventListener('blur', () => this._searchGoToPageAbsolute(pageInput.value));
  }
  document.getElementById('search-rerun-btn')?.addEventListener('click', () => this._searchRerun());

  // Remember scroll position within the current context as the user scrolls,
  // so returning to this context restores the exact spot.
  document.getElementById('search-panel-list')?.addEventListener('scroll', (e) => {
    const st = this._searchState[this._searchContextKey()];
    if (st) st.scrollTop = e.target.scrollTop;
  });

  // Right-click a result → Copy link / Delete menu. Images, video and audio
  // keep their own menus (image menu is wired via the shared container loop in
  // app-ui; video/audio fall through to the browser's native save menu), and a
  // live text selection defers to native copy. (search-overhaul phase 3)
  document.getElementById('search-panel-list')?.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.chat-image, video, audio, .file-video, .file-audio')) return;
    const item = e.target.closest('.search-result-item');
    if (!item) return;
    const sel = window.getSelection?.();
    if (sel && !sel.isCollapsed && item.contains(sel.anchorNode)) return;
    this._searchShowContextMenu(e, item);
  });

  this._searchFilterInit();
},

// Which context the open channel belongs to.
_searchContextKey() {
  const ch = (this.channels || []).find(c => c.code === this.currentChannel);
  return ch && ch.is_dm ? `dm:${this.currentChannel}` : '__public__';
},

// ── State accessors (single entry point so invalidation stays clean) ──
_searchGetState(key) { return this._searchState[key] || null; },
_searchSetState(key, patch) {
  this._searchState[key] = { ...(this._searchState[key] || { open: false, query: '', results: [], page: 1, scrollTop: 0, stale: false, sort: 'newest' }), ...patch };
  return this._searchState[key];
},
_searchClearContext(key) { delete this._searchState[key]; },
// The invalidation entry point wired to `channels-list` (see _searchInvalidate).
// clearAll() will also back live ban/kick handling in phase 2.
_searchClearAll() { this._searchState = Object.create(null); },

// ── Toggle from the header 🔍 button ──
_searchToggle() {
  const key = this._searchContextKey();
  const st = this._searchGetState(key);
  if (st && st.open) {
    this._searchClose();
  } else {
    this._searchSetState(key, { open: true });
    const sc = document.getElementById('search-container');
    if (sc) sc.style.display = 'flex';
    const input = document.getElementById('search-input');
    if (input) { input.value = st?.query || ''; input.focus(); }
    this._searchRenderPanel();
    this._sfpSync();
  }
},

// User-initiated close (the only real close).
_searchClose() {
  const key = this._searchContextKey();
  this._searchClearContext(key);
  document.getElementById('search-panel').style.display = 'none';
  this._searchRestoreSidebar();
  const sc = document.getElementById('search-container');
  if (sc) sc.style.display = 'none';
  const input = document.getElementById('search-input');
  if (input) input.value = '';
  const pop = document.getElementById('search-filter-popover');
  if (pop) pop.style.display = 'none';
},

// Kick off a query for the current context. Public channels hit the server
// (global FTS, one page at a time); DMs walk the local decrypted cache.
_searchRun(query, page = 1) {
  const key = this._searchContextKey();
  const st = this._searchSetState(key, { open: true, query, stale: false });
  const ch = (this.channels || []).find(c => c.code === this.currentChannel);
  if (ch && ch.is_dm) {
    this._searchDmCacheLocally(query);
  } else {
    this._searchSetLoading(true);
    this.socket.emit('search-messages', { code: this.currentChannel, query, page, sort: st.sort || 'newest', token: this._searchNextToken() });
  }
},

// Monotonic token stamped on every server request. The socket handler drops any
// search-results whose token isn't the latest, so a slow earlier query can't
// clobber the panel with stale results.
_searchNextToken() { this._searchSeq = (this._searchSeq || 0) + 1; return this._searchSeq; },

// Toggle the "Searching…" indicator. Shown when a server request is in flight,
// hidden once its (matching) response lands. Also makes sure the panel is on
// screen so the indicator is visible for a first search.
_searchSetLoading(on) {
  const panel = document.getElementById('search-panel');
  if (on && panel) { panel.style.display = 'flex'; this._searchEnsureVisible(); }
  const el = document.getElementById('search-panel-loading');
  if (el) el.style.display = on ? 'flex' : 'none';
},

// The server rejected a search for hitting the per-account rate limit. Stop the
// spinner and let the user know, but keep whatever results are already shown.
_searchOnThrottled() {
  this._searchSetLoading(false);
  this._showToast(t('header.search_rate_limited'), 'error');
},

// Results arrive here from the socket handler (public: server-paged, so
// `results` is one page and `total` is the full count) and from DM local
// search (`results` is the full match set, sliced client-side).
_searchReceiveResults(key, { results, total, page, query, filters, isDM } = {}) {
  this._searchSetLoading(false);
  const serverPaged = key === '__public__';
  this._searchSetState(key, {
    open: true,
    query: query != null ? query : (this._searchGetState(key)?.query || ''),
    results: results || [],
    filters: filters || null,
    isDM: !!isDM,
    serverPaged,
    total: serverPaged ? (total || 0) : (results ? results.length : 0),
    page: page || 1,
    scrollTop: 0,
    stale: false,
  });
  // Only paint if this context is the one on screen.
  if (key === this._searchContextKey()) this._searchRenderPanel();
},

// Prev/next pager. Server-paged contexts re-fetch the page; local (DM) ones
// just slice the cached matches and re-render.
_searchGoToPage(delta) {
  const key = this._searchContextKey();
  const st = this._searchGetState(key);
  if (!st) return;
  const total = st.serverPaged ? (st.total || 0) : (st.results?.length || 0);
  const pages = Math.max(1, Math.ceil(total / SEARCH_PAGE_SIZE));
  const next = Math.min(pages, Math.max(1, (st.page || 1) + delta));
  if (next === st.page) return;
  if (st.serverPaged) {
    this._searchSetLoading(true);
    this.socket.emit('search-messages', { code: this.currentChannel, query: st.query, page: next, sort: st.sort || 'newest', token: this._searchNextToken() });
  } else {
    st.page = next;
    st.scrollTop = 0;
    this._searchRenderPanel();
  }
},

// Jump straight to a typed page. Strips non-digits, clamps to [1, pages], and
// reverts the box to the current page on empty/invalid input. Fires at most one
// fetch, and none when the target is already the current page.
_searchGoToPageAbsolute(raw) {
  const key = this._searchContextKey();
  const st = this._searchGetState(key);
  if (!st) return;
  const input = document.getElementById('search-page-input');
  const total = st.serverPaged ? (st.total || 0) : (st.results?.length || 0);
  const pages = Math.max(1, Math.ceil(total / SEARCH_PAGE_SIZE));
  const digits = String(raw).replace(/[^0-9]/g, '');
  let target = parseInt(digits, 10);
  if (!Number.isInteger(target)) {                 // empty / non-numeric → revert
    if (input) input.value = String(st.page || 1);
    return;
  }
  target = Math.min(pages, Math.max(1, target));    // bounds check
  if (target === (st.page || 1)) {                  // no-op (incl. clamped-to-current)
    if (input) input.value = String(st.page || 1);
    return;
  }
  this._searchGoToPage(target - (st.page || 1));    // reuse the arrow path (delta)
},

// Re-run the stored query after invalidation (the refresh banner button).
_searchRerun() {
  const key = this._searchContextKey();
  const st = this._searchGetState(key);
  if (st && st.query) this._searchRun(st.query);
},

// Jump to a result's message. Global search spans channels, so switch to the
// message's channel first when it isn't the current one, then jump once its
// history loads (same pattern as the ?channel=&message= deep link).
_searchJumpTo(code, msgId) {
  if (!msgId) return;
  if (code && code !== this.currentChannel) {
    this.switchChannel(code);
    setTimeout(() => this._jumpToMessage(msgId), 600);
  } else {
    this._jumpToMessage(msgId);
  }
},

// Called from switchChannel — hide/show the panel for the new context.
_searchOnChannelSwitch() {
  const key = this._searchContextKey();
  const st = this._searchGetState(key);
  const sc = document.getElementById('search-container');
  const input = document.getElementById('search-input');
  if (st && st.open) {
    if (sc) sc.style.display = 'flex';
    if (input) input.value = st.query || '';
    this._searchRenderPanel();
  } else {
    document.getElementById('search-panel').style.display = 'none';
    this._searchRestoreSidebar();
    if (sc) sc.style.display = 'none';
    if (input) input.value = '';
  }
  // Popover follows the box and only shows for public channels (hidden in DMs).
  this._sfpSync();
},

// channels-list arrived — the user's channel set changing (add/remove) can make
// cached rows outlive their access. Signature-gate it so a plain reconnect that
// re-pushes an identical list doesn't false-trigger, then mark stale.
_searchInvalidate(channels) {
  const sig = (channels || []).map(c => c.code).sort().join(',');
  if (this._searchChannelSig === null) { this._searchChannelSig = sig; return; }
  if (sig === this._searchChannelSig) return;
  this._searchChannelSig = sig;
  this._searchMarkStale();
},

// Force the PUBLIC search context stale regardless of the channel signature.
// Used when the user's channel set or their own roles/permissions change — that
// can revoke access without altering which channels appear in the list, so the
// signature wouldn't catch it. Only the public context is touched: DM search is
// local, E2E, and per-DM, so server roles/channel membership never affect it.
// Re-run rebuilds correctly since the server re-authorizes every query.
// (See search-overhaul.md.)
_searchMarkStale() {
  const st = this._searchState['__public__'];
  if (!st || !st.open || !(st.results?.length || st.query)) return;
  st.stale = true;
  st.results = [];
  // Only repaint if the public panel is the one on screen; if a DM is open the
  // stale banner shows when the user switches back (via _searchOnChannelSwitch).
  if (this._searchContextKey() === '__public__') this._searchRenderPanel();
},

// The panel overlays the right sidebar, so a collapsed sidebar would hide it.
// Temporarily un-collapse it when the panel shows; _searchRestoreSidebar puts
// the user's preference back when it hides. Mobile portrait has no search bar,
// so only the desktop collapse state is handled. (search-overhaul)
_searchEnsureVisible() {
  const rs = document.getElementById('right-sidebar');
  if (rs && rs.classList.contains('collapsed') && !this._searchForcedExpand) {
    this._applySidebarCollapsed?.(false);
    this._searchForcedExpand = true;
  }
},
_searchRestoreSidebar() {
  if (this._searchForcedExpand) {
    this._applySidebarCollapsed?.(localStorage.getItem('haven-sidebar-collapsed') === '1');
    this._searchForcedExpand = false;
  }
},

// ── Filter picker popover (phase 3) ──────────────────────────────────────
// Appears with the search box on public channels. Clicking a filter chip opens
// a client-rendered list (members / channels / has options) with a prefix
// filter; picking one appends its token to the search input and re-runs. Lists
// come from client state only (this._lastOnlineUsers, this.channels) so they
// naturally reflect what the user can see; the server still re-authorizes.
_searchFilterInit() {
  const pop = document.getElementById('search-filter-popover');
  if (!pop) return;
  pop.querySelectorAll('.sfp-chip[data-sfp-filter]').forEach(chip => {
    chip.addEventListener('click', () => {
      const f = chip.dataset.sfpFilter;
      // pinned is a plain boolean — no sub-picker, append straight away.
      if (f === 'pinned') this._sfpAppend('pinned:true');
      else this._sfpOpenPicker(f);
    });
  });
  pop.querySelectorAll('.sfp-sort-btn').forEach(b => {
    b.addEventListener('click', () => this._searchSetSort(b.dataset.sort));
  });
  document.getElementById('sfp-back')?.addEventListener('click', () => this._sfpShowRoot());
  const fbox = document.getElementById('sfp-filter-input');
  fbox?.addEventListener('input', () => this._sfpRenderList(this._sfpActive, fbox.value.trim()));
  document.getElementById('sfp-date-apply')?.addEventListener('click', () => this._sfpApplyDate());
  document.getElementById('sfp-date-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') this._sfpApplyDate();
  });
  // Filter button toggles the popover open/closed (separate from the 🔍 button).
  document.getElementById('search-filter-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const hidden = pop.style.display === 'none' || !pop.style.display;
    if (hidden) { this._sfpShowRoot(); pop.style.display = 'block'; }
    else pop.style.display = 'none';
  });
  // Clicking into the text box reopens the popover too (parity with the filter
  // button), so dismissing it by clicking away isn't a dead end. Public only —
  // DM search has no filters. If it's already open we leave it alone.
  document.getElementById('search-input')?.addEventListener('click', () => {
    const ch = (this.channels || []).find(c => c.code === this.currentChannel);
    if (ch && ch.is_dm) return;
    if (pop.style.display === 'none' || !pop.style.display) {
      this._sfpShowRoot();
      pop.style.display = 'block';
    }
  });
  // Click outside the search box hides the popover (without closing search).
  document.addEventListener('click', (e) => {
    if (pop.style.display === 'none') return;
    const sc = document.getElementById('search-container');
    const toggle = document.getElementById('search-toggle-btn');
    if (sc && !sc.contains(e.target) && !toggle?.contains(e.target)) pop.style.display = 'none';
  });
},

// Show the popover with the search box, but only for public channels — filters
// don't apply to local DM search.
_sfpSync() {
  const pop = document.getElementById('search-filter-popover');
  if (!pop) return;
  const ch = (this.channels || []).find(c => c.code === this.currentChannel);
  const open = document.getElementById('search-container')?.style.display === 'flex';
  const show = open && !(ch && ch.is_dm);
  const btn = document.getElementById('search-filter-btn');
  if (btn) btn.style.display = show ? '' : 'none';
  if (show) { this._sfpShowRoot(); pop.style.display = 'block'; }
  else pop.style.display = 'none';
},

_sfpShowRoot() {
  document.getElementById('sfp-root').style.display = 'flex';
  document.getElementById('sfp-picker').style.display = 'none';
  this._sfpActive = null;
  this._sfpRenderSort();
  this._sfpRenderRecent();
},

_sfpOpenPicker(type) {
  this._sfpActive = type;
  document.getElementById('sfp-root').style.display = 'none';
  document.getElementById('sfp-picker').style.display = 'flex';
  const isDate = ['before', 'after', 'during'].includes(type);
  const fbox = document.getElementById('sfp-filter-input');
  const dwrap = document.getElementById('sfp-date-wrap');
  const list = document.getElementById('sfp-list');
  if (isDate) {
    // Date filters take a YYYY-MM-DD value from a native date input, not a list.
    if (fbox) fbox.style.display = 'none';
    if (dwrap) dwrap.style.display = 'flex';
    if (list) list.innerHTML = '';
    const di = document.getElementById('sfp-date-input');
    if (di) { di.value = ''; di.focus(); }
  } else {
    if (fbox) { fbox.style.display = ''; fbox.value = ''; }
    if (dwrap) dwrap.style.display = 'none';
    this._sfpRenderList(type, '');
    fbox?.focus();
  }
},

// Append a date filter (before:/after:/during:) from the date input.
_sfpApplyDate() {
  const di = document.getElementById('sfp-date-input');
  const v = di && di.value;   // native date input already gives YYYY-MM-DD
  if (!v || !this._sfpActive) return;
  this._sfpAppend(`${this._sfpActive}:${v}`);
},

// Sort is a query parameter (not a token). Set it on the public context and
// re-run the current query so results reorder immediately.
_searchSetSort(sort) {
  if (!['newest', 'oldest', 'relevant'].includes(sort)) return;
  const key = this._searchContextKey();
  const st = this._searchGetState(key) || this._searchSetState(key, {});
  st.sort = sort;
  this._sfpRenderSort();
  if (st.query) this._searchRun(st.query, 1);
},

_sfpRenderSort() {
  const st = this._searchGetState(this._searchContextKey());
  const cur = (st && st.sort) || 'newest';
  document.querySelectorAll('#sfp-sort .sfp-sort-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.sort === cur);
  });
},

// ── Recent searches (client-only, localStorage) ──
_searchLoadRecent() {
  try { return JSON.parse(localStorage.getItem('haven_recent_searches') || '[]'); } catch { return []; }
},
// Saved on Enter (an explicit commit) rather than every debounced keystroke, so
// the list holds real searches, not the partials typed on the way there.
_searchSaveRecent(query) {
  query = (query || '').trim();
  if (!query || this._searchContextKey() !== '__public__') return;
  const list = [query, ...this._searchLoadRecent().filter(q => q !== query)].slice(0, 6);
  try { localStorage.setItem('haven_recent_searches', JSON.stringify(list)); } catch { /* quota */ }
},
// Recent list lives at the top of the popover, only when the box is empty.
_sfpRenderRecent() {
  const box = document.getElementById('sfp-recent');
  if (!box) return;
  const input = document.getElementById('search-input');
  const recent = (input && input.value.trim()) ? [] : this._searchLoadRecent();
  if (!recent.length) { box.style.display = 'none'; box.innerHTML = ''; return; }
  box.style.display = 'flex';
  box.innerHTML = `<span class="sfp-label">${t('header.recent')}</span>` +
    recent.map(q => `<button type="button" class="sfp-recent-item" data-q="${this._escapeHtml(q)}">${this._escapeHtml(q)}</button>`).join('');
  box.querySelectorAll('.sfp-recent-item').forEach(b => b.addEventListener('click', () => {
    if (input) { input.value = b.dataset.q; input.focus(); }
    document.getElementById('search-filter-popover').style.display = 'none';
    this._searchSaveRecent(b.dataset.q);
    this._searchRun(b.dataset.q);
  }));
},

// Build the entry list for a filter type, prefix-filtered by term. Each entry:
// { label, sub, token }. Dumb startsWith prefix match, no fuzzy search.
_sfpRenderList(type, term) {
  const list = document.getElementById('sfp-list');
  if (!list) return;
  const p = (term || '').toLowerCase();
  let entries = [];

  if (type === 'from') {
    const seen = new Set();
    entries = (this._lastOnlineUsers || [])
      .filter(u => u && u.username && !seen.has(u.username) && seen.add(u.username))
      .map(u => ({ label: this._getNickname(u.id, u.username), sub: '@' + u.username, token: `from:${u.username}`, key: u.username }))
      .filter(e => !p || e.key.toLowerCase().startsWith(p) || e.label.toLowerCase().startsWith(p));
  } else if (type === 'in') {
    entries = (this.channels || [])
      .filter(c => c && !c.is_dm)
      .map(c => ({ label: `#${c.name}`, sub: `(${c.display_code || c.code})`, token: `in:#${c.code}`, key: c.name || '' }))
      .filter(e => !p || e.key.toLowerCase().startsWith(p));
  } else if (type === 'has') {
    entries = SEARCH_HAS_OPTIONS
      .map(h => ({ label: h.charAt(0).toUpperCase() + h.slice(1), sub: `has:${h}`, token: `has:${h}`, key: h }))
      .filter(e => !p || e.key.startsWith(p));
  }

  if (!entries.length) {
    list.innerHTML = `<div class="sfp-empty">${t('header.filter_no_matches')}</div>`;
    return;
  }
  list.innerHTML = entries.slice(0, 100).map(e =>
    `<div class="sfp-item" data-token="${this._escapeHtml(e.token)}">
       <span>${this._escapeHtml(e.label)}</span><span class="sfp-item-sub">${this._escapeHtml(e.sub)}</span>
     </div>`).join('');
  list.querySelectorAll('.sfp-item').forEach(item => {
    item.addEventListener('click', () => this._sfpAppend(item.dataset.token));
  });
},

// Append a filter token to the search input and re-run the search.
_sfpAppend(token) {
  const input = document.getElementById('search-input');
  if (!input) return;
  const base = input.value.replace(/\s+$/, '');
  input.value = (base ? base + ' ' : '') + token + ' ';
  input.focus();
  this._sfpShowRoot();
  this._searchRun(input.value.trim());
},

_searchRenderPanel() {
  const panel = document.getElementById('search-panel');
  const list  = document.getElementById('search-panel-list');
  const count = document.getElementById('search-panel-count');
  const pager = document.getElementById('search-panel-pager');
  const banner = document.getElementById('search-panel-banner');
  if (!panel || !list || !count) return;

  const key = this._searchContextKey();
  const st = this._searchGetState(key);
  if (!st || !st.open) { panel.style.display = 'none'; this._searchRestoreSidebar(); return; }
  panel.style.display = 'flex';
  this._searchEnsureVisible();

  // Stale banner (invalidated by a channels-list change).
  if (st.stale) {
    if (banner) banner.style.display = 'flex';
    list.innerHTML = '';
    count.textContent = '';
    if (pager) pager.style.display = 'none';
    return;
  }
  if (banner) banner.style.display = 'none';

  // Server-paged (public) contexts already hold just the current page and a
  // separate total; local (DM) contexts hold every match and slice here.
  const results = st.results || [];
  const total = st.serverPaged ? (st.total || 0) : results.length;
  const pages = Math.max(1, Math.ceil(total / SEARCH_PAGE_SIZE));
  st.page = Math.min(st.page || 1, pages);
  const start = (st.page - 1) * SEARCH_PAGE_SIZE;
  const pageRows = st.serverPaged ? results : results.slice(start, start + SEARCH_PAGE_SIZE);

  // Header count (+ filter tags for channel searches).
  const qHtml = this._escapeHtml(st.query || '');
  let filterInfo = '';
  if (st.filters) {
    const tags = [];
    if (st.filters.from)   tags.push(`<span class="search-filter-tag">from:${this._escapeHtml(st.filters.from)}</span>`);
    if (st.filters.in)     tags.push(`<span class="search-filter-tag">in:#${this._escapeHtml(st.filters.in)}</span>`);
    if (st.filters.has)    tags.push(`<span class="search-filter-tag">has:${this._escapeHtml(st.filters.has)}</span>`);
    if (st.filters.pinned === 'true') tags.push(`<span class="search-filter-tag">pinned</span>`);
    if (st.filters.after)  tags.push(`<span class="search-filter-tag">after:${this._escapeHtml(st.filters.after)}</span>`);
    if (st.filters.before) tags.push(`<span class="search-filter-tag">before:${this._escapeHtml(st.filters.before)}</span>`);
    if (st.filters.during) tags.push(`<span class="search-filter-tag">during:${this._escapeHtml(st.filters.during)}</span>`);
    if (tags.length) filterInfo = `<div class="search-filter-tags">${tags.join(' ')}</div>`;
  }
  const localTag = st.isDM ? ' <span class="search-filter-tag">DM (local)</span>' : '';
  count.innerHTML = `${total} result${total === 1 ? '' : 's'} for "${qHtml}"${localTag}${filterInfo}`;

  // Highlight the plain text (all filter tokens stripped).
  const highlightQuery = (st.query || '').replace(/\b(?:from|in|has|pinned|before|after|during):\S+/gi, '').trim();

  list.innerHTML = total === 0
    ? `<p class="muted-text" style="padding:12px">${t('header.search_no_results')}</p>`
    : pageRows.map(r => {
        // Channel header per result (public/global search). DM local results
        // have no channel, so it's omitted there.
        const chan = r.channel_code
          ? `<div class="search-result-channel">#${this._escapeHtml(r.channel_name || r.channel_code)} <span class="search-result-channel-code">(${this._escapeHtml(r.channel_code)})</span></div>`
          : '';
        // Display-only thread badge on results that are thread parents. The
        // server attaches thread_count (a grouped COUNT); users open it by
        // jumping to the message. (search-overhaul phase 3)
        const thread = (r.thread_count > 0)
          ? `<span class="search-result-thread" title="${t('header.search_thread_replies', { count: r.thread_count }) || (r.thread_count + ' replies')}">🧵 ${r.thread_count}</span>`
          : '';
        // Render the body through the real message formatter so images, video,
        // audio, spoilers, mentions and links look exactly like chat. The
        // .message-content class opts the row into the shared media/embed CSS
        // and lets _fetchLinkPreviews find its links. Content is deferred-embed
        // marked below so page links don't auto-fetch. (search-overhaul phase 3)
        return `
        <div class="search-result-item" data-msg-id="${r.id}" data-user-id="${this._escapeHtml(String(r.user_id ?? ''))}" data-channel-code="${this._escapeHtml(r.channel_code || '')}">
          ${chan}
          <span class="search-result-author" style="color:${this._getUserColor(r.username)}">${this._escapeHtml(this._getNickname(r.user_id, r.username))}</span>
          <span class="search-result-time">${this._formatTime(r.created_at)}</span>
          ${thread}
          <div class="message-content search-result-content">${this._formatContent(r.content)}</div>
        </div>`;
      }).join('');

  // Post-render passes: highlight matched text, defer link embeds behind Load
  // buttons, then wire uploaded video/audio the same way the channel view does.
  list.querySelectorAll('.search-result-item').forEach(item => {
    const content = item.querySelector('.search-result-content');
    if (highlightQuery) this._searchHighlightTextNodes(content, highlightQuery);
    this._searchDeferEmbeds(item);
    // Row click jumps to the message, but never when the click lands on
    // interactive content (media, links, the Load button, or the thread badge)
    // — those have their own behaviour and must not trigger a jump.
    item.addEventListener('click', (e) => {
      if (e.target.closest('a, img, video, audio, .chat-image, .file-video, .file-audio, .link-preview, .search-load-embed, .search-result-thread, .spoiler')) return;
      this._searchJumpTo(item.dataset.channelCode, parseInt(item.dataset.msgId, 10));
    });
  });
  this._setupVideos(list);

  // Pager — only when more than one page.
  if (pager) {
    if (pages > 1) {
      pager.style.display = 'flex';
      const input = document.getElementById('search-page-input');
      if (input && document.activeElement !== input) input.value = String(st.page);
      const totalEl = document.getElementById('search-page-total');
      if (totalEl) totalEl.textContent = t('header.search_page_of', { pages }) || `/ ${pages}`;
      document.getElementById('search-page-prev').disabled = st.page <= 1;
      document.getElementById('search-page-next').disabled = st.page >= pages;
    } else {
      pager.style.display = 'none';
    }
  }

  // Restore scroll spot.
  list.scrollTop = st.scrollTop || 0;
},

// Wrap query matches in <mark> across the text nodes of a rendered result,
// skipping links, code and already-marked spans. DOM-based (not string
// replace) so it can't corrupt the HTML _formatContent produced.
_searchHighlightTextNodes(root, query) {
  if (!root || !query) return;
  const safe = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(safe, 'gi');
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => {
      if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      if (n.parentElement && n.parentElement.closest('a, code, pre, mark, .link-preview, .search-load-embed')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  const targets = [];
  let node;
  while ((node = walker.nextNode())) targets.push(node);
  targets.forEach(textNode => {
    const text = textNode.nodeValue;
    re.lastIndex = 0;
    if (!re.test(text)) return;
    re.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      const mark = document.createElement('mark');
      mark.textContent = m[0];
      frag.appendChild(mark);
      last = m.index + m[0].length;
      if (m.index === re.lastIndex) re.lastIndex++;   // guard against zero-width match loop
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    textNode.parentNode.replaceChild(frag, textNode);
  });
},

// Mark every page link in a result as deferred and drop a Load button after it,
// so nothing unfurls until the user opts in. Same skip-list as
// _fetchLinkPreviews: inline images and internal URLs never get a button.
_searchDeferEmbeds(item) {
  const content = item.querySelector('.search-result-content');
  if (!content) return;
  const seen = new Set();
  content.querySelectorAll('a[href]').forEach(link => {
    const url = link.href;
    if (seen.has(url)) return;
    seen.add(url);
    if (/\.(jpg|jpeg|png|gif|webp)(\?.*)?$/i.test(url)) return;
    if (/^https:\/\/media\d*\.giphy\.com\//i.test(url)) return;
    if (/^https:\/\/(media|c)\.tenor\.com\//i.test(url)) return;
    if (url.startsWith(window.location.origin)) return;
    if (link.nextElementSibling && link.nextElementSibling.classList.contains('search-load-embed')) return;
    link.dataset.embedDeferred = '1';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'search-load-embed';
    btn.textContent = t('header.search_load_embed') || 'Load embed';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._searchLoadEmbed(btn, link, item);
    });
    link.insertAdjacentElement('afterend', btn);
  });
},

// Load button handler: clear the deferred flag on just this link, then re-run
// the real preview pass (which now renders this one card via the shared cache
// + scheduler). The button is removed once its card is on the way.
_searchLoadEmbed(btn, link, item) {
  delete link.dataset.embedDeferred;
  btn.remove();
  this._fetchLinkPreviews(item);
},

// Result right-click menu: Copy link (when the channel is linkable) and Delete
// (same global check the channel toolbar uses; the server re-authorises per the
// result's own channel). Delete targets the result's channel_code, not the open
// channel, since results are cross-channel. (search-overhaul phase 3)
_searchShowContextMenu(e, item) {
  this._searchHideContextMenu();
  const msgId = parseInt(item.dataset.msgId, 10);
  const code = item.dataset.channelCode;
  if (!msgId || !code) return;
  const isOwn = String(item.dataset.userId) === String(this.user?.id);
  const canShareLink = !!this._canShareChannelLink?.(code);
  const canDelete = isOwn || this.user?.isAdmin || this._canModerate() || this._hasPerm('delete_message');

  const items = [];
  if (canShareLink) items.push(`<button class="channel-ctx-item" data-action="copy-link">🔗 <span>${t('msg_toolbar.copy_link')}</span></button>`);
  if (canDelete) {
    if (items.length) items.push('<hr class="channel-ctx-sep">');
    items.push(`<button class="channel-ctx-item danger" data-action="delete">🗑️ <span>${t('msg_toolbar.delete')}</span></button>`);
  }
  if (!items.length) return;   // nothing actionable → leave the native menu

  e.preventDefault();
  const menu = document.createElement('div');
  menu.id = 'search-context-menu';
  menu.className = 'channel-ctx-menu';
  menu.innerHTML = items.join('');
  menu.style.left = e.clientX + 'px';
  menu.style.top  = e.clientY + 'px';
  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  if (rect.right  > window.innerWidth)  menu.style.left = (window.innerWidth  - rect.width  - 8) + 'px';
  if (rect.bottom > window.innerHeight) menu.style.top  = (window.innerHeight - rect.height - 8) + 'px';

  menu.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    this._searchHideContextMenu();
    if (action === 'copy-link') {
      this._copyChannelLink(code, msgId);
    } else if (action === 'delete') {
      if (await this._showConfirmModal(t('confirm.delete_message'), '', { danger: true, confirmLabel: t('msg_toolbar.delete') })) {
        // Row removal is driven by the server's message-deleted broadcast, so
        // it only disappears on a confirmed delete. (search-overhaul phase 3)
        this.socket.emit('delete-message', { messageId: msgId, channelCode: code });
      }
    }
  });

  const closer = (ev) => {
    if (ev && ev.type !== 'scroll' && menu.contains(ev.target)) return;
    this._searchHideContextMenu();
  };
  this._searchCtxCloser = closer;
  setTimeout(() => {
    document.addEventListener('click', closer, true);
    document.addEventListener('contextmenu', closer, true);
    document.getElementById('search-panel-list')?.addEventListener('scroll', closer, true);
  }, 0);
},

_searchHideContextMenu() {
  document.getElementById('search-context-menu')?.remove();
  if (this._searchCtxCloser) {
    document.removeEventListener('click', this._searchCtxCloser, true);
    document.removeEventListener('contextmenu', this._searchCtxCloser, true);
    document.getElementById('search-panel-list')?.removeEventListener('scroll', this._searchCtxCloser, true);
    this._searchCtxCloser = null;
  }
},

// Drop a message from cached search results after the server confirms its
// delete (message-deleted broadcast). Ids are globally unique, so match on id;
// re-render only when the currently visible context actually changed.
_searchRemoveResult(channelCode, messageId) {
  if (!this._searchState || !Number.isInteger(messageId)) return;
  const activeKey = this._searchContextKey();
  let activeChanged = false;
  for (const key of Object.keys(this._searchState)) {
    const st = this._searchState[key];
    if (!st || !Array.isArray(st.results)) continue;
    const before = st.results.length;
    st.results = st.results.filter(r => r.id !== messageId);
    const removed = before - st.results.length;
    if (removed > 0) {
      if (st.serverPaged && typeof st.total === 'number') st.total = Math.max(0, st.total - removed);
      if (key === activeKey) activeChanged = true;
    }
  }
  if (activeChanged) this._searchRenderPanel();
},

};
