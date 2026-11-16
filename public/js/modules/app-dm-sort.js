// DM sort: how your DM list is ordered under your pinned DMs. "Latest
// message" puts the DM with the newest message first and moves a DM up as
// soon as someone writes in it, "Alphabetical" sorts by name, and "Manual
// order" keeps the order you dragged them into. The pick and the arranged
// order are saved on your account (preferences dm_sort and dm_order) so every
// device shows the same list. Both used to live only in this browser
// (haven_dm_sort_mode, haven_dm_order); what a browser had is saved to the
// account the first time, and after that the browser copies only let the
// list be drawn before the account's preferences arrive. With nothing saved
// at all, a list you arranged by hand stays manual and any other list shows
// the latest first.

export const DM_SORT_MODES = ['recent', 'alpha', 'manual'];

// The sort in force: the account's pick, else this browser's old pick, else
// manual for a hand-arranged list and latest for everyone else.
export function pickDmSortMode(accountPick, browserPick, hasManualOrder) {
  if (DM_SORT_MODES.includes(accountPick)) return accountPick;
  if (DM_SORT_MODES.includes(browserPick)) return browserPick;
  return hasManualOrder ? 'manual' : 'recent';
}

// A saved manual order (JSON list of DM codes) as a list; [] when it is
// missing or unreadable.
export function parseDmOrder(raw) {
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list.filter(code => typeof code === 'string' && code) : [];
  } catch { return []; } // not JSON: no saved order
}

// A sorted copy of dms. nameOf gives the name a DM shows under. order is the
// saved manual order (a list of DM codes); DMs it does not name follow in the
// order they came in.
export function orderDms(dms, mode, order, nameOf) {
  const list = [...dms];
  const byName = (a, b) => nameOf(a).localeCompare(nameOf(b)) || String(a.code).localeCompare(String(b.code));
  if (mode === 'alpha') return list.sort(byName);
  if (mode === 'recent') return list.sort((a, b) => (b.latestMessageId || 0) - (a.latestMessageId || 0) || byName(a, b));
  if (!Array.isArray(order) || !order.length) return list;
  const rank = new Map(order.map((code, i) => [code, i]));
  const at = (ch) => rank.has(ch.code) ? rank.get(ch.code) : order.length;
  return list.sort((a, b) => at(a) - at(b));
}

export default {

_dmManualOrder() {
  return parseDmOrder(localStorage.getItem('haven_dm_order'));
},

_dmSortMode() {
  return pickDmSortMode(this._userPrefs?.dm_sort, localStorage.getItem('haven_dm_sort_mode'), this._dmManualOrder().length > 0);
},

// The order you arranged your DMs in, by dragging or in Organize DMs.
_saveDmManualOrder(codes) {
  const value = JSON.stringify(codes);
  localStorage.setItem('haven_dm_order', value);
  if (!this._userPrefs) this._userPrefs = {};
  if (codes.length) {
    this._userPrefs.dm_order = value;
    this.socket.emit('set-preference', { key: 'dm_order', value });
  } else {
    delete this._userPrefs.dm_order;
    this.socket.emit('delete-preference', { key: 'dm_order' });
  }
},

// Saved in this browser too, so the list is drawn right before the account's
// preferences arrive.
_setDmSortMode(mode) {
  if (!DM_SORT_MODES.includes(mode)) return;
  localStorage.setItem('haven_dm_sort_mode', mode);
  if (!this._userPrefs) this._userPrefs = {};
  this._userPrefs.dm_sort = mode;
  this.socket.emit('set-preference', { key: 'dm_sort', value: mode });
},

// A pick made by hand, in the sort menu or in Organize DMs. Manual order with
// nothing arranged yet starts from the list as it is shown, so the DMs do not
// jump back to the order they were created in.
_pickDmSortMode(mode) {
  if (mode === 'manual' && !this._dmManualOrder().length) {
    const shown = [...document.querySelectorAll('#dm-list .dm-item')].map(el => el.dataset.code).filter(Boolean);
    if (shown.length) this._saveDmManualOrder(shown);
  }
  this._setDmSortMode(mode);
},

// When preferences arrive: the account's order and pick replace this
// browser's. An account with neither takes what this browser had, so a list
// arranged here before the sort followed the account looks the same on the
// next device.
_adoptAccountDmSort() {
  const prefs = this._userPrefs || {};
  const accountOrder = parseDmOrder(prefs.dm_order);
  const browserOrder = this._dmManualOrder();
  if (accountOrder.length) localStorage.setItem('haven_dm_order', JSON.stringify(accountOrder));
  else if (browserOrder.length) this._saveDmManualOrder(browserOrder);
  if (DM_SORT_MODES.includes(prefs.dm_sort)) { localStorage.setItem('haven_dm_sort_mode', prefs.dm_sort); return; }
  const browserPick = localStorage.getItem('haven_dm_sort_mode');
  if (DM_SORT_MODES.includes(browserPick) || browserOrder.length) this._setDmSortMode(pickDmSortMode(null, browserPick, browserOrder.length > 0));
},

_orderDms(dms, nameOf, mode = this._dmSortMode(), order = this._dmManualOrder()) {
  return orderDms(dms, mode, order, nameOf);
},

// The sort button in the Direct Messages header and its menu.
_initDmSortMenu() {
  const btn = document.getElementById('dm-sort-btn');
  const menu = document.getElementById('dm-sort-menu');
  if (!btn || !menu) return;
  const close = () => {
    menu.style.display = 'none';
    btn.setAttribute('aria-expanded', 'false');
  };
  btn.addEventListener('click', (e) => {
    e.stopPropagation(); // don't toggle DM collapse
    if (menu.style.display !== 'none') { close(); return; }
    this._closeChannelCtxMenu?.();
    this._closeDmCtxMenu?.();
    const mode = this._dmSortMode();
    menu.querySelectorAll('[data-dm-sort]').forEach(item => item.setAttribute('aria-checked', String(item.dataset.dmSort === mode)));
    const rect = btn.getBoundingClientRect();
    menu.style.top = rect.bottom + 4 + 'px';
    menu.style.left = rect.left + 'px';
    menu.style.display = 'block';
    btn.setAttribute('aria-expanded', 'true');
    // Keep inside viewport
    requestAnimationFrame(() => {
      const mr = menu.getBoundingClientRect();
      if (mr.right > window.innerWidth) menu.style.left = (window.innerWidth - mr.width - 8) + 'px';
      if (mr.bottom > window.innerHeight) menu.style.top = (rect.top - mr.height - 4) + 'px';
    });
  });
  menu.querySelectorAll('[data-dm-sort]').forEach(item => {
    item.addEventListener('click', () => {
      close();
      this._pickDmSortMode(item.dataset.dmSort);
      this._renderChannels();
    });
  });
  document.addEventListener('click', (e) => {
    if (menu.style.display !== 'none' && !menu.contains(e.target) && !btn.contains(e.target)) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && menu.style.display !== 'none') close();
  });
},

};
