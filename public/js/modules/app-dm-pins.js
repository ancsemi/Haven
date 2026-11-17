// Pinned DMs: "Pin to top" in a DM's menu keeps that conversation at the top
// of your own DM list, in the order you pinned them, whatever sort the rest
// of the list uses. Only you see it. The pins are saved on your account
// (preference pinned_dms, a JSON list of DM codes) so every device shows the
// same ones; the server keeps only DMs you are in (src/pinnedDms.js).
// Pins only change the sidebar's DM list; the pop-out DM window is untouched.

const MAX_PINS = 50;

export default {

_pinnedDmCodes() {
  const raw = this._userPrefs?.pinned_dms;
  if (this._pinnedDmsRaw === raw && this._pinnedDmsList) return this._pinnedDmsList;
  let codes = [];
  try { codes = raw ? JSON.parse(raw) : []; } catch (err) { console.warn('[dm-pins] unreadable pinned DM list', err.message); }
  this._pinnedDmsRaw = raw;
  this._pinnedDmsList = Array.isArray(codes) ? codes.filter(c => typeof c === 'string') : [];
  return this._pinnedDmsList;
},

_isDmPinned(code) {
  return this._pinnedDmCodes().includes(code);
},

// Pinned DMs first, in pin order, then the rest in the order given.
_splitPinnedDms(sortedDms) {
  const pins = this._pinnedDmCodes();
  if (!pins.length) return { pinned: [], rest: sortedDms };
  const byCode = new Map(sortedDms.map(ch => [ch.code, ch]));
  const pinned = pins.map(code => byCode.get(code)).filter(Boolean);
  const pinnedSet = new Set(pinned);
  return { pinned, rest: sortedDms.filter(ch => !pinnedSet.has(ch)) };
},

_toggleDmPin(code) {
  if (!code) return;
  const pinned = this._isDmPinned(code);
  // Pins for DMs that are gone are dropped along the way.
  const known = new Set((this.channels || []).filter(c => c.is_dm).map(c => c.code));
  let next = this._pinnedDmCodes().filter(c => c !== code && known.has(c));
  if (!pinned) {
    if (next.length >= MAX_PINS) {
      this._showToast(t('channels.dm_pin_limit', { count: MAX_PINS }), 'error');
      return;
    }
    next = [...next, code];
  }
  this._savePinnedDms(next);
  this._renderChannels();
  this._showToast(t(pinned ? 'channels.dm_unpinned' : 'channels.dm_pinned'), 'success');
},

_savePinnedDms(codes) {
  if (!this._userPrefs) this._userPrefs = {};
  if (codes.length) {
    const value = JSON.stringify(codes);
    this._userPrefs.pinned_dms = value;
    this.socket.emit('set-preference', { key: 'pinned_dms', value });
  } else {
    delete this._userPrefs.pinned_dms;
    this.socket.emit('delete-preference', { key: 'pinned_dms' });
  }
},

// After a drag in the DM list: pinned DMs dragged among themselves take
// their new order, and the list is drawn again so pinned ones stay on top.
_syncDmPinOrder(domOrder) {
  const pins = this._pinnedDmCodes();
  if (!pins.length) return;
  const pinSet = new Set(pins);
  const next = domOrder.filter(c => pinSet.has(c));
  pins.forEach(c => { if (!next.includes(c)) next.push(c); });
  if (next.join(',') !== pins.join(',')) this._savePinnedDms(next);
  this._renderChannels();
},

};
