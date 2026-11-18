// Activity from apps on this computer, through Haven Desktop (#5894).
//
// Games and music players that support "rich presence" announce what they
// are doing to a Discord app on the same computer. Haven Desktop can listen
// there instead and hand it to this page, which reports it as the member's
// activity (server side: src/socketHandlers/appActivity.js). Nothing is
// looked up anywhere, so there is no artwork, and the app's name is the one
// the app gives or the name of its program.
//
// Off by default. The switch lives in Settings > Activity and only shows in
// Haven Desktop; the yes is asked and kept by the Desktop app itself, per
// server, so a server page cannot switch it on for itself.

const SEND_GAP_MS = 2500;   // the server takes one update every two seconds
const REPEAT_MS = 60000;    // repeated, so a slot another source held is taken back up

export default {

_setupDesktopAppActivity() {
  const api = window.havenDesktop?.appActivity;
  const row = document.getElementById('desktop-app-activity-row');
  const box = document.getElementById('desktop-app-activity');
  // A browser, the mobile app or an older Haven Desktop: the row stays hidden.
  if (!api || !row || !box || this._desktopAppActivityReady) return;
  this._desktopAppActivityReady = true;

  let current = null;
  let lastSent = 0;
  let timer = null;

  const send = () => {
    timer = null;
    if (!this.socket?.connected) return;
    lastSent = Date.now();
    this.socket.emit('set-app-activity', current || {});
  };
  const report = () => {
    if (timer) return;
    // A clear goes at once; updates are spaced out, the last one always sent.
    const wait = current ? Math.max(0, SEND_GAP_MS - (Date.now() - lastSent)) : 0;
    timer = setTimeout(send, wait);
  };

  document.addEventListener('haven:app-activity', (e) => {
    const d = e.detail || {};
    current = d.playing || d.listening ? { playing: d.playing || null, listening: d.listening || null } : null;
    report();
  });
  this.socket.on('connect', () => { if (current) report(); });
  setInterval(() => { if (current) report(); }, REPEAT_MS);

  api.status().then((s) => {
    if (!s?.supported) return;
    row.style.display = '';
    box.checked = !!s.enabled;
  }).catch(err => console.warn('[app-activity] could not read the Haven Desktop setting:', err?.message || err));

  box.addEventListener('change', async () => {
    const want = box.checked;
    box.disabled = true;
    let enabled = false;
    try {
      enabled = !!(await (want ? api.enable() : api.disable()))?.enabled;
    } catch (err) {
      console.warn('[app-activity] Haven Desktop did not answer:', err?.message || err);
    }
    box.checked = enabled;
    box.disabled = false;
    if (!enabled) {
      current = null;
      report();
    }
  });
},

};
