// "What's new" after the server updates: the release notes since the
// version this device last saw, in a popup. Settings > Chat > What's New
// picks which updates bring it up, with the parts of the version number
// that count underlined (big updates change the first, new features the
// second, fixes the third). The notes come from the server's own changelog.

const LEVELS = { major: 0, minor: 1, patch: 2 };
// How many parts of the version count for each choice: "every update" all
// three, "new features" the first two, "big updates" the first.
const PARTS = { all: 3, minor: 2, major: 1, off: 0 };

export default {

_whatsNewPref() {
  try {
    const v = localStorage.getItem('haven_whats_new');
    return v in PARTS ? v : 'minor';
  } catch { return 'minor'; /* private mode: the default */ }
},

_whatsNewSeenKey() {
  return `haven_seen_version_${this.user?.id || 'anon'}`;
},

// Same steps as src/changelog.js updateLevel.
_whatsNewLevel(from, to) {
  const parse = (v) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$/.exec(String(v || ''));
    return m ? { base: [+m[1], +m[2], +m[3]], pre: !!m[4] } : null;
  };
  const a = parse(from), b = parse(to);
  if (!a || !b || from === to) return null;
  for (let i = 0; i < 3; i++) {
    if (a.base[i] !== b.base[i]) return a.base[i] < b.base[i] ? ['major', 'minor', 'patch'][i] : null;
  }
  return a.pre ? 'patch' : null;
},

// Called with the server's version on every connect.
async _whatsNewCheck(version) {
  if (!version) return;
  this._serverVersion = version;
  this._renderWhatsNewVersion();
  let seen = null;
  try { seen = localStorage.getItem(this._whatsNewSeenKey()); } catch { return; /* private mode: no way to remember, so never pop up */ }
  if (seen === version) return;
  try { localStorage.setItem(this._whatsNewSeenKey(), version); } catch { return; /* storage full: same as above */ }
  // A first visit has nothing to catch up on.
  if (!seen) return;
  const level = this._whatsNewLevel(seen, version);
  if (!level || LEVELS[level] >= PARTS[this._whatsNewPref()]) return;
  this._openWhatsNew(seen);
},

async _openWhatsNew(since = '') {
  let data;
  try {
    const res = await fetch('/api/changelog?since=' + encodeURIComponent(since), {
      headers: { Authorization: `Bearer ${localStorage.getItem('haven_token')}` }
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    data = await res.json();
  } catch (err) {
    console.warn('[WhatsNew] release notes unavailable:', err.message);
    if (!since) this._showToast(t('whats_new.unavailable'), 'error');
    return;
  }
  const sections = Array.isArray(data.sections) ? data.sections : [];
  if (!sections.length) {
    if (!since) this._showToast(t('whats_new.unavailable'), 'error');
    return;
  }
  this._showWhatsNewModal(data.current, sections);
},

_showWhatsNewModal(version, sections) {
  document.getElementById('whats-new-modal')?.remove();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'whats-new-modal';
  overlay.style.display = 'flex';
  const body = sections.map(s => `
    <div class="whats-new-release">
      <h4>v${this._escapeHtml(s.version)}${s.date && !/unreleased/i.test(s.date) ? ` <span class="whats-new-date">${this._escapeHtml(s.date)}</span>` : ''}</h4>
      ${this._whatsNewHtml(s.body)}
    </div>`).join('');
  overlay.innerHTML = `
    <div class="modal whats-new-modal" role="dialog" aria-modal="true">
      <h3>🆕 ${this._escapeHtml(t('whats_new.title', { version: 'v' + version }))}</h3>
      <div class="whats-new-body">${body}</div>
      <small class="settings-hint whats-new-hint">${this._escapeHtml(t('whats_new.settings_hint'))}</small>
      <div class="modal-actions">
        <button type="button" class="btn-sm btn-accent" data-act="close">${this._escapeHtml(t('modals.common.close'))}</button>
      </div>
    </div>`;
  const close = () => overlay.remove();
  overlay.addEventListener('click', (e) => { if (e.target === overlay || e.target.dataset.act === 'close') close(); });
  overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  document.body.appendChild(overlay);
  overlay.querySelector('[data-act="close"]').focus();
},

// The changelog's markdown, as far as it uses it: ### headings, - bullets,
// **bold** and `code`. Escaped first, so nothing in it becomes markup.
_whatsNewHtml(md) {
  const inline = (s) => this._escapeHtml(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
  const out = [];
  let list = false;
  for (const raw of String(md || '').split('\n')) {
    const line = raw.trim();
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      if (!list) { out.push('<ul>'); list = true; }
      out.push(`<li>${inline(bullet[1])}</li>`);
      continue;
    }
    if (list) { out.push('</ul>'); list = false; }
    const head = /^#{3,6}\s+(.*)$/.exec(line);
    if (head) out.push(`<h5>${inline(head[1])}</h5>`);
    else if (line) out.push(`<p>${inline(line)}</p>`);
  }
  if (list) out.push('</ul>');
  return out.join('');
},

// The server's version in settings, with the parts that bring up the popup
// underlined.
_renderWhatsNewVersion() {
  const el = document.getElementById('whats-new-version');
  if (!el || !this._serverVersion) return;
  const m = /^(\d+)\.(\d+)\.(\d+)(.*)$/.exec(this._serverVersion);
  if (!m) { el.textContent = 'v' + this._serverVersion; return; }
  const n = PARTS[this._whatsNewPref()];
  const parts = [m[1], m[2], m[3]].map((p, i) => `<span class="${i < n ? 'whats-new-part-on' : ''}">${p}</span>`);
  el.innerHTML = `v${parts.join('.')}${m[4] ? `<span class="whats-new-suffix">${this._escapeHtml(m[4])}</span>` : ''}`;
},

_initWhatsNewSettings() {
  const select = document.getElementById('whats-new-select');
  if (select) {
    select.value = this._whatsNewPref();
    select.addEventListener('change', () => {
      try { localStorage.setItem('haven_whats_new', select.value); } catch { /* private mode: applies for this visit only */ }
      this._renderWhatsNewVersion();
    });
  }
  document.getElementById('whats-new-show-btn')?.addEventListener('click', () => this._openWhatsNew(''));
  this._renderWhatsNewVersion();
},

};
