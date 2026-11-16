// Back and forward, on the mouse's two side buttons (often called Mouse 4
// and Mouse 5), the way a browser uses them.
//
// A "place" is what the main view shows: the channel, the thread or forum
// topic open in it, and the pop-out DM if one is open. Haven remembers the
// places you pass through. Back returns to the one before, forward undoes a
// back. So back closes a thread you opened, leaves a forum topic for the
// forum's list, closes a pop-out DM, or returns to the channel you came
// from, whichever was your last step.
//
// Back first closes a window that is open on top (settings, a picture, a
// picker), without moving through the places.
//
// In a browser the side buttons would otherwise leave Haven for the page
// before it, dropping any call you are in; inside the app they never do.
//
// Settings > Chat has the switch. Off, the side buttons do nothing in Haven
// at all, for people who use them as push to talk or a hotkey in another
// program that Haven cannot know about (#5886).

const NAV_OFF_KEY = 'haven_mouse_nav_off';

const NAV_MAX = 50;
// Changes that belong to one step (a channel switch closes the open thread)
// arrive close together; the place is read once they have settled.
const NAV_SETTLE_MS = 120;
// How long back or forward waits for a channel's messages before opening a
// thread in it anyway.
const NAV_THREAD_WAIT_MS = 3000;
// Windows that back closes before it moves anywhere. Each closes on Escape.
const NAV_ON_TOP = '.modal-overlay, #quick-switcher-overlay, #theme-popup, #search-container, ' +
  '#search-panel, #image-lightbox, .image-lightbox, #emoji-picker, #gif-picker';

const samePlace = (a, b) => !!a && !!b && a.channel === b.channel && a.thread === b.thread && a.dm === b.dm;

export default {

_setupNavHistory() {
  this._navPlaces = [];
  this._navIndex = -1;
  this._navBusy = 0;
  this._navTimer = null;
  this._navRun = 0;

  // Every way of moving between places goes through these five methods, so
  // watching them here keeps the history out of the rest of the code.
  for (const name of ['switchChannel', '_openThread', '_closeThread', '_openDMPiP', '_closeDMPiP']) {
    const original = this[name];
    if (typeof original !== 'function') continue;
    this[name] = function (...args) {
      const out = original.apply(this, args);
      if (out && typeof out.then === 'function') {
        // A channel switch is not finished until its promise settles; reading
        // the place halfway would record the old thread in the new channel.
        this._navBusy++;
        const done = () => { this._navBusy--; this._navChanged(); };
        out.then(done, done);
      } else {
        this._navChanged();
      }
      return out;
    };
  }

  try { this._navOff = localStorage.getItem(NAV_OFF_KEY) === '1'; }
  catch { this._navOff = false; } // private mode: storage is unavailable, keep the default (on)
  const toggle = document.getElementById('mouse-nav-toggle');
  if (toggle) {
    toggle.checked = !this._navOff;
    toggle.addEventListener('change', () => {
      this._navOff = !toggle.checked;
      try { localStorage.setItem(NAV_OFF_KEY, this._navOff ? '1' : '0'); }
      catch { /* private mode: the choice lasts until the page closes */ }
    });
  }

  // The side buttons are buttons 3 and 4 to the browser. Their default is
  // cancelled on the press and the release, since browsers differ on which
  // of the two leaves the page.
  const side = (e) => e.button === 3 || e.button === 4;
  window.addEventListener('mousedown', (e) => { if (side(e)) e.preventDefault(); }, true);
  window.addEventListener('mouseup', (e) => {
    if (!side(e)) return;
    e.preventDefault();
    this._navFromMouse(e.button);
  }, true);
},

// Where the main view is right now.
_navPlace() {
  const panel = document.getElementById('thread-panel');
  const threadOpen = !!panel && panel.style.display !== 'none' && this._activeThreadParent != null && this._activeThreadParent !== '';
  return {
    channel: this.currentChannel || null,
    thread: threadOpen ? Number(this._activeThreadParent) : null,
    dm: this._activeDMPip || null,
  };
},

_navChanged() {
  clearTimeout(this._navTimer);
  this._navTimer = setTimeout(() => this._navRecord(), NAV_SETTLE_MS);
},

// Note the place the view has settled on.
_navRecord() {
  clearTimeout(this._navTimer);
  this._navTimer = null;
  // Mid-switch, or back/forward is doing the moving: it reports when done.
  if (this._navBusy > 0) return;
  const now = this._navPlace();
  if (!now.channel) return;
  const places = this._navPlaces;
  const here = places[this._navIndex];
  if (samePlace(now, here)) return;
  // Going back or forward by hand (closing the thread you just opened with
  // its own ✕) is the same step as the button, and keeps the other
  // direction available.
  if (samePlace(now, places[this._navIndex - 1])) { this._navIndex--; return; }
  if (samePlace(now, places[this._navIndex + 1])) { this._navIndex++; return; }
  // A pop-out DM closed by hand is closed for good: back should not bring
  // it up again in every place it floated over.
  if (here && here.dm && !now.dm && here.channel === now.channel && here.thread === now.thread) {
    this._navForgetDm(here.dm);
    return;
  }
  places.length = this._navIndex + 1;
  places.push(now);
  if (places.length > NAV_MAX) places.shift();
  this._navIndex = places.length - 1;
},

// Take a pop-out DM out of every remembered place, then drop the places
// that became the same as their neighbor.
_navForgetDm(code) {
  const current = this._navPlaces[this._navIndex];
  const kept = [];
  let index = 0;
  for (const place of this._navPlaces) {
    if (place.dm === code) place.dm = null;
    if (kept.length && samePlace(kept[kept.length - 1], place)) {
      if (place === current) index = kept.length - 1;
      continue;
    }
    kept.push(place);
    if (place === current) index = kept.length - 1;
  }
  this._navPlaces = kept;
  this._navIndex = index;
},

async _navFromMouse(button) {
  if (this._navOff) return;
  // In the desktop app a side button can be the push-to-talk, push-to-mute
  // or another shortcut. Then it is that, and not back or forward.
  const shortcuts = window.havenDesktop && window.havenDesktop.shortcuts;
  if (shortcuts && typeof shortcuts.getConfig === 'function') {
    let config = null;
    try { config = await shortcuts.getConfig(); } catch (err) { console.warn('[Nav] could not read the desktop shortcuts:', err); }
    const name = `mouse${button + 1}`;
    if (config && Object.values(config).some(v => typeof v === 'string' && v.toLowerCase() === name)) return;
  }
  if (button === 3) this._navBack();
  else this._navForward();
},

_navOnTop() {
  return [...document.querySelectorAll(NAV_ON_TOP)].some(el => el.getClientRects().length > 0);
},

_navBack() {
  if (this._navOnTop()) {
    // Escape is what closes each of these, with whatever cleanup it does.
    (document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    return;
  }
  if (this._navTimer) this._navRecord();
  if (this._navIndex > 0) { this._navGo(-1); return; }
  // Nothing earlier is remembered (a thread or pop-out DM that was already
  // open when Haven loaded): close what is open, newest idea of "back".
  if (this._activeDMPip) this._closeDMPiP();
  else if (this._navPlace().thread != null) this._closeThread();
},

_navForward() {
  if (this._navOnTop()) return;
  if (this._navTimer) this._navRecord();
  if (this._navIndex < this._navPlaces.length - 1) this._navGo(1);
},

// Move one remembered place back (-1) or forward (1), skipping places whose
// channel is gone (deleted, left, or no longer visible to you).
async _navGo(step) {
  const places = this._navPlaces;
  let index = this._navIndex + step;
  const exists = (code) => (this.channels || []).some(c => c.code === code);
  while (places[index] && !exists(places[index].channel)) {
    places.splice(index, 1);
    if (step < 0) { index--; this._navIndex--; }
  }
  const target = places[index];
  if (!target) return;

  const run = ++this._navRun;
  this._navBusy++;
  this._navIndex = index;
  try {
    if (target.channel !== this.currentChannel) await this.switchChannel(target.channel);
    if (run !== this._navRun) return;
    const thread = this._navPlace().thread;
    if (target.thread == null && thread != null) this._closeThread();
    else if (target.thread != null && target.thread !== thread) await this._navOpenThread(target, run);
    if (run !== this._navRun) return;
    if (!target.dm && this._activeDMPip) this._closeDMPiP();
    else if (target.dm && target.dm !== this._activeDMPip && exists(target.dm)) this._openDMPiP(target.dm);
  } finally {
    this._navBusy--;
    // The place actually reached is what is remembered (a deleted thread
    // does not reopen), so the next step compares against what is on screen.
    if (run === this._navRun && places[this._navIndex] === target && this.currentChannel === target.channel) {
      Object.assign(target, this._navPlace());
      // If that left it the same as the place this step came from, the two
      // are one place: keep one, so the next press moves somewhere.
      const from = this._navIndex - step;
      if (samePlace(target, places[from])) {
        places.splice(this._navIndex, 1);
        if (step > 0) this._navIndex = from;
      }
    }
    clearTimeout(this._navTimer);
    this._navTimer = null;
  }
},

// Reopen a thread or forum topic. After a channel switch its opening
// message has to be on the page first: a forum topic's title bar is drawn
// from the forum's list, which arrives with the channel's messages.
async _navOpenThread(target, run) {
  const loaded = () => (this._forumActive && this._forumTopics
    ? this._forumTopics.has(target.thread)
    : !!document.querySelector(`#messages [data-msg-id="${target.thread}"]`));
  const until = Date.now() + NAV_THREAD_WAIT_MS;
  while (!loaded() && Date.now() < until) {
    await new Promise(resolve => setTimeout(resolve, 50));
    if (run !== this._navRun || this.currentChannel !== target.channel) return;
  }
  // A forum only opens topics it lists; a thread in a normal channel opens
  // from the server even when its first message is further up than loaded.
  if (this._forumActive && !loaded()) return;
  this._openThread(target.thread);
},

};
