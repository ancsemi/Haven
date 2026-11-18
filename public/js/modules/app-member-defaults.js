// ═══════════════════════════════════════════════════════════
// Defaults for new members (#5739)
//
// An admin shares a snapshot of their own look-and-feel settings
// (Settings > Server Branding). Each member starts from it once:
//   - account settings (theme, effects) are written by the server, and only
//     where the member never saved that setting, or still has exactly what an
//     earlier set of defaults put there;
//   - device settings (everything else, kept in this browser) are written
//     here, and only where this browser still has Haven's built-in default,
//     or exactly what an earlier set of defaults put there.
// Once received, the member's own changes always win. "Apply once to
// everyone now" raises the version so every member gets the rule above once
// more at their next load.
// ═══════════════════════════════════════════════════════════

const RECORD_PREFIX = 'haven_member_defaults_';

function lsGet(key) {
  try { return localStorage.getItem(key); } catch { return null; } // storage blocked (private mode): read as unset
}

function oneOf(raw, allowed, fallback) {
  return allowed.includes(raw) ? raw : fallback;
}

// Presses a picker button, so the picker's own handler saves and applies the
// value exactly as a click by the member would.
function pressPicker(pickerId, attr, value) {
  const btn = [...document.querySelectorAll(`#${pickerId} [${attr}]`)].find(b => b.getAttribute(attr) === value);
  if (!btn) return false;
  btn.click();
  return true;
}

// Flips a settings checkbox through its own change handler.
function setToggle(id, on) {
  const box = document.getElementById(id);
  if (!box) return false;
  if (box.checked !== on) {
    box.checked = on;
    box.dispatchEvent(new Event('change'));
  }
  return true;
}

const yesNo = (v) => (v ? t('settings.admin.member_defaults.on') : t('settings.admin.member_defaults.off'));

// The curated list. Nothing here touches security, privacy, notifications,
// audio devices, keys or the account. `late` settings need the plugins
// (layouts, Haven Glyphs) to be loaded before they can be applied.
const SETTINGS = [
  {
    key: 'theme', scope: 'account',
    label: () => t('app.theme.title'),
    read: (app) => lsGet('haven_theme') || app._userPrefs?.theme || '',
    // Custom colours live in this browser only, so they cannot be shared.
    shareable: (v) => !!v && v !== 'custom',
    show: (v) => {
      if (v.startsWith('file:')) return v.slice(5).replace(/\.theme\.css$/, '');
      const opt = [...document.querySelectorAll('#default-theme-select option')].find(o => o.value === v);
      return opt ? opt.textContent : v;
    },
  },
  {
    key: 'effects', scope: 'account',
    label: () => t('app.theme.effect_overlay'),
    read: () => lsGet('haven_effects') || 'auto',
    show: (v) => {
      if (v === 'auto') return t('app.theme.match_theme');
      if (v === 'none') return t('app.theme.no_effects');
      let list = [];
      try { list = JSON.parse(v); } catch { return v; } // a legacy single effect name: show it as is
      if (!Array.isArray(list) || !list.length) return t('app.theme.no_effects');
      return list.map(fx => [...document.querySelectorAll('#effect-selector [data-effect]')].find(b => b.dataset.effect === fx)?.title || fx).join(', ');
    },
  },
  {
    key: 'layout', scope: 'device', late: true, dflt: '',
    label: () => t('app.theme.layout'),
    read: () => (typeof window._activeLayoutKey === 'function' ? window._activeLayoutKey() : ''),
    apply: (v) => {
      if (typeof window._setLayout !== 'function') return false;
      const known = typeof window._layoutPluginFiles === 'function' ? window._layoutPluginFiles() : [];
      if (v && !known.some(l => l.key === v)) return false; // that layout is not on this server
      window._setLayout(v);
      return true;
    },
    show: (v) => (v ? v.replace(/Layout$/, '') : t('app.theme.layout_original')),
  },
  {
    key: 'density', scope: 'device', dflt: 'cozy',
    label: () => t('settings.layout.density.title'),
    read: () => oneOf(lsGet('haven-density'), ['compact', 'cozy', 'spacious'], 'cozy'),
    apply: (v) => pressPicker('density-picker', 'data-density', v),
    show: (v) => t(`settings.layout.density.${v}`),
  },
  {
    key: 'zoom', scope: 'device', dflt: 100,
    label: () => t('settings.zoom.title'),
    read: () => {
      let pct = parseInt(lsGet('haven-zoom'), 10);
      if (!pct) pct = ({ small: 85, normal: 100, large: 118, 'x-large': 138 })[lsGet('haven-fontsize')] || 100;
      return Math.min(150, Math.max(70, pct));
    },
    apply: (v) => {
      const slider = document.getElementById('ui-zoom-slider');
      if (!slider) return false;
      slider.value = String(v);
      slider.dispatchEvent(new Event('input'));
      return true;
    },
    show: (v) => `${v}%`,
  },
  {
    key: 'text_size', scope: 'device', dflt: 100,
    label: () => t('settings.accessibility.text_size.title'),
    read: () => Math.min(200, Math.max(80, parseInt(lsGet('haven-text-size'), 10) || 100)),
    apply: (v) => {
      const slider = document.getElementById('text-size-slider');
      if (!slider) return false;
      slider.value = String(v);
      slider.dispatchEvent(new Event('input'));
      return true;
    },
    show: (v) => `${v}%`,
  },
  {
    key: 'reaction_size', scope: 'device', dflt: 'normal',
    label: () => t('settings.reaction_size.title'),
    read: () => oneOf(lsGet('haven-emojisize'), ['small', 'normal', 'large', 'x-large'], 'normal'),
    apply: (v) => pressPicker('emoji-size-picker', 'data-emojisize', v),
    show: (v) => t(`settings.reaction_size.${v === 'x-large' ? 'xl' : v}`),
  },
  {
    key: 'interface_icons', scope: 'device', dflt: 'mono',
    label: () => t('settings.toolbar_icons.title'),
    read: () => {
      const raw = lsGet('haven-toolbar-icons');
      return oneOf(raw === 'color' ? 'emoji' : raw, ['mono', 'emoji', 'glyphs'], 'mono');
    },
    // Glyphs is a plugin, so it waits for the plugins; the other two do not.
    lateFor: (v) => v === 'glyphs',
    apply: (v) => {
      if (v === 'glyphs' && !window.HavenPluginLoader?.loadedPlugins?.get?.('HavenGlyphs.plugin.js')?.instance) return false;
      return pressPicker('toolbar-icon-picker', 'data-toolbaricons', v);
    },
    show: (v) => ({ mono: t('settings.toolbar_icons.monochrome'), emoji: t('settings.toolbar_icons.colorful'), glyphs: t('settings.toolbar_icons.glyphs') })[v] || v,
  },
  {
    key: 'role_display', scope: 'device', dflt: 'colored-name',
    label: () => t('settings.role_display.title'),
    read: () => oneOf(lsGet('haven-role-display'), ['colored-name', 'dot'], 'colored-name'),
    apply: (v) => pressPicker('role-display-picker', 'data-roledisplay', v),
    show: (v) => (v === 'dot' ? t('settings.role_display.dot') : t('settings.role_display.colored_name')),
  },
  {
    key: 'image_mode', scope: 'device', dflt: 'thumbnail',
    label: () => t('settings.image_display.image_mode.title'),
    read: () => (lsGet('haven-image-mode') === 'full' ? 'full' : 'thumbnail'),
    apply: (v) => pressPicker('image-mode-picker', 'data-image-mode', v),
    show: (v) => t(`settings.image_display.image_mode.${v}`),
  },
  {
    key: 'embed_size', scope: 'device', dflt: 'medium',
    label: () => t('settings.embed_display.title'),
    read: (app) => app._embedSize(),
    apply: (v) => pressPicker('embed-size-picker', 'data-embed-size', v),
    show: (v) => t(`settings.embed_display.${v}`),
  },
  {
    key: 'animate_pfp', scope: 'device', dflt: 'hover',
    label: () => t('settings.image_display.animate_pfp.title'),
    read: (app) => app._viewerAnimPref(),
    apply: (v) => pressPicker('animate-pfp-picker', 'data-animpfp', v),
    show: (v) => t(`settings.image_display.animate_pfp.${v}`),
  },
  {
    key: 'animate_chat', scope: 'device', dflt: 'always',
    label: () => t('settings.image_display.animate_chat.title'),
    read: (app) => app._viewerChatAnimPref(),
    apply: (v) => pressPicker('animate-chat-picker', 'data-animchat', v),
    show: (v) => t(`settings.image_display.animate_chat.${v}`),
  },
  {
    key: 'toggle_style', scope: 'device', dflt: 'switch',
    label: () => t('settings.toggle_style.title'),
    read: () => (lsGet('haven-toggle-style') === 'box' ? 'box' : 'switch'),
    apply: (v) => pressPicker('toggle-style-picker', 'data-togglestyle', v),
    show: (v) => t(`settings.toggle_style.${v}`),
  },
  {
    key: 'channel_scroll', scope: 'device', dflt: 'separate',
    label: () => t('settings.layout.channel_scrolling.title'),
    read: () => oneOf(lsGet('haven-channel-scroll'), ['separate', 'combined'], 'separate'),
    apply: (v) => pressPicker('channel-scroll-picker', 'data-channel-scroll', v),
    show: (v) => t(`settings.layout.channel_scrolling.${v}`),
  },
  {
    key: 'compact_composer', scope: 'device', dflt: false,
    label: () => t('settings.layout.composer.compact'),
    read: () => lsGet('haven_compact_composer') === 'true',
    apply: (v) => setToggle('compact-composer', v),
    show: yesNo,
  },
  {
    key: 'hide_send', scope: 'device', dflt: false,
    label: () => t('settings.layout.composer.hide_send'),
    read: () => lsGet('haven_hide_send_btn') === 'true',
    apply: (v) => setToggle('hide-send-btn', v),
    show: yesNo,
  },
  {
    key: 'blur_nsfw', scope: 'device', dflt: true,
    label: () => t('settings.nsfw.blur'),
    read: () => lsGet('haven_blur_nsfw') !== 'false',
    apply: (v) => setToggle('blur-nsfw-topics', v),
    show: yesNo,
  },
  {
    key: 'hover_profile_card', scope: 'device', dflt: true,
    label: () => t('settings.chat_behavior.hover_profile_card'),
    read: () => lsGet('haven_hover_profile_card') !== 'false',
    apply: (v) => setToggle('hover-profile-card', v),
    show: yesNo,
  },
  {
    key: 'emote_words', scope: 'device', dflt: false,
    label: () => t('settings.chat_behavior.emote_words'),
    read: () => lsGet('haven-emote-words') === 'true',
    apply: (v) => setToggle('emote-words-toggle', v),
    show: yesNo,
  },
];
const BY_KEY = new Map(SETTINGS.map(s => [s.key, s]));

function parseSnapshot(text) {
  try {
    const o = JSON.parse(text || 'null');
    if (o && typeof o === 'object' && o.s && typeof o.s === 'object') {
      const s = {};
      for (const [k, v] of Object.entries(o.s)) if (BY_KEY.has(k)) s[k] = v;
      return { v: Number.isSafeInteger(o.v) ? o.v : 0, s };
    }
  } catch (err) {
    console.warn('[member-defaults] unreadable defaults setting', err.message);
  }
  return { v: 0, s: {} };
}

function parseRecord(text) {
  try {
    const o = JSON.parse(text || 'null');
    if (o && typeof o === 'object') return { v: Number.isSafeInteger(o.v) ? o.v : 0, a: (o.a && typeof o.a === 'object') ? o.a : {} };
  } catch (err) {
    console.warn('[member-defaults] unreadable record, treating it as never received', err.message);
  }
  return null;
}

export default {

_setupMemberDefaults() {
  if (this._memberDefaultsReady) return;
  this._memberDefaultsReady = true;
  this._memberDefaultsPicks = null;

  // Plugins load on their own schedule; layouts and Glyphs wait for them.
  this._memberDefaultsPluginsIn = false;
  this._memberDefaultsPluginWaiters = [];
  const pluginsIn = () => {
    if (this._memberDefaultsPluginsIn) return;
    this._memberDefaultsPluginsIn = true;
    this._memberDefaultsPluginWaiters.splice(0).forEach(fn => fn());
  };
  document.addEventListener('haven:plugins-loaded', pluginsIn, { once: true });
  // The loader always fires the event; this only covers it firing before
  // this listener existed.
  setTimeout(pluginsIn, 10000);

  // Registered after the app's own handlers, so the settings and the
  // member's preferences are already stored when these run.
  this.socket.on('server-settings', () => {
    this._memberDefaultsSettingsIn = true;
    this._maybeApplyMemberDefaults();
    this._renderMemberDefaultsAdmin();
  });
  this.socket.on('preferences', () => this._maybeApplyMemberDefaults());
  this.socket.on('server-setting-changed', (data) => {
    if (data?.key !== 'member_defaults') return;
    this._memberDefaultsPicks = null;
    this._renderMemberDefaultsAdmin();
    // "Apply once to everyone now" reaches people who are online straight
    // away instead of at their next load (#5754). The records make a repeat
    // run a no-op, so a plain save changes nothing for those who have it.
    this._memberDefaultsChecked = false;
    this._maybeApplyMemberDefaults();
  });
  this.socket.on('member-defaults-applied', (applied) => this._applyAccountDefaultsLocally(applied || {}));

  document.getElementById('member-defaults-list')?.addEventListener('change', (e) => {
    const box = e.target.closest('input[type="checkbox"][data-key]');
    if (!box) return;
    if (!this._memberDefaultsPicks) this._memberDefaultsPicks = new Set(this._memberDefaultsInitialPicks());
    if (box.checked) this._memberDefaultsPicks.add(box.dataset.key);
    else this._memberDefaultsPicks.delete(box.dataset.key);
  });
  document.getElementById('member-defaults-capture')?.addEventListener('click', () => this._captureMemberDefaults());
  document.getElementById('member-defaults-clear')?.addEventListener('click', async () => {
    const ok = await this._showConfirmModal(t('settings.admin.member_defaults.clear_confirm'), '', { danger: true });
    if (ok) this.socket.emit('clear-member-defaults');
  });
  document.getElementById('member-defaults-push')?.addEventListener('click', async () => {
    const ok = await this._showConfirmModal(
      t('settings.admin.member_defaults.push_confirm_title'),
      t('settings.admin.member_defaults.push_confirm'),
      { confirmLabel: t('settings.admin.member_defaults.push') }
    );
    if (ok) this.socket.emit('push-member-defaults');
  });
  // The "your value" column reads this browser, so refresh it each time
  // Settings opens.
  ['open-settings-btn', 'mobile-settings-btn'].forEach(id => {
    document.getElementById(id)?.addEventListener('click', () => this._renderMemberDefaultsAdmin());
  });
  document.addEventListener('haven:plugins-loaded', () => this._renderMemberDefaultsAdmin());
},

_memberDefaultsSnapshot() {
  return parseSnapshot(this.serverSettings?.member_defaults);
},

_memberDefaultsWhenPlugins(fn) {
  if (this._memberDefaultsPluginsIn) fn();
  else this._memberDefaultsPluginWaiters.push(fn);
},

// Runs once per page load, once both the server settings and the member's
// own preferences have arrived.
_maybeApplyMemberDefaults() {
  if (this._memberDefaultsChecked || !this._memberDefaultsSettingsIn || !this._prefsReceived) return;
  if (!this.user?.id) return;
  this._memberDefaultsChecked = true;
  const snap = this._memberDefaultsSnapshot();
  const keys = Object.keys(snap.s);
  if (!keys.length) return;

  // Account settings: the server decides and writes, then reports back.
  const accountRec = parseRecord(this._userPrefs?.member_defaults_applied);
  if (keys.some(k => BY_KEY.get(k).scope === 'account') && (!accountRec || accountRec.v < snap.v)) {
    this.socket.emit('apply-member-defaults');
  }

  // Device settings: this browser keeps its own record per account.
  const recKey = RECORD_PREFIX + this.user.id;
  const rec = parseRecord(lsGet(recKey));
  if (rec && rec.v >= snap.v) return;
  const applied = {};
  const keep = {};
  const unchanged = (def, cur) => cur === def.dflt || (rec && rec.a[def.key] === cur);
  const tryApply = (def) => {
    const cur = def.read(this);
    if (!unchanged(def, cur)) return;
    if (cur === snap.s[def.key] || def.apply(snap.s[def.key])) applied[def.key] = snap.s[def.key];
  };
  // Settings the earlier defaults wrote and this set leaves out stay on
  // record while untouched, so a later set can still update them.
  if (rec) {
    for (const [k, v] of Object.entries(rec.a)) {
      const def = BY_KEY.get(k);
      if (def?.scope === 'device' && !(k in snap.s) && def.read(this) === v) keep[k] = v;
    }
  }
  const local = SETTINGS.filter(d => d.scope === 'device' && d.key in snap.s);
  const isLate = (d) => d.late || d.lateFor?.(snap.s[d.key]);
  local.filter(d => !isLate(d)).forEach(tryApply);
  const finish = () => {
    try {
      localStorage.setItem(recKey, JSON.stringify({ v: snap.v, a: { ...keep, ...applied } }));
    } catch { /* storage blocked (private mode): the defaults are offered again next load, still only over untouched settings */ }
  };
  const late = local.filter(isLate);
  if (!late.length) return finish();
  this._memberDefaultsWhenPlugins(() => {
    late.forEach(tryApply);
    finish();
  });
},

// The server wrote these account settings for the member: show them now,
// the same way the preferences handler does at load.
_applyAccountDefaultsLocally(applied) {
  if (!this._userPrefs) this._userPrefs = {};
  if (typeof applied.effects === 'string') {
    this._userPrefs.effects = applied.effects;
    if (typeof syncEffectsFromServer === 'function') syncEffectsFromServer(applied.effects);
  }
  if (typeof applied.theme === 'string') {
    this._userPrefs.theme = applied.theme;
    if (typeof applyThemeFromServer === 'function') applyThemeFromServer(applied.theme, true, true);
  } else if (applied.effects && typeof applyEffects === 'function') {
    applyEffects(_getStoredEffectMode());
  }
},

// ── Admin side ──────────────────────────────────────────

_canManageMemberDefaults() {
  return !!(this.user?.isAdmin || this._hasPerm?.('manage_server'));
},

// Ticked by default: what is saved now, or everything when nothing is.
_memberDefaultsInitialPicks() {
  const saved = Object.keys(this._memberDefaultsSnapshot().s);
  return saved.length ? saved : SETTINGS.map(d => d.key);
},

_renderMemberDefaultsAdmin() {
  const list = document.getElementById('member-defaults-list');
  const summary = document.getElementById('member-defaults-summary');
  if (!list || !summary || !this._canManageMemberDefaults()) return;
  const esc = (s) => this._escapeHtml(String(s));
  const picks = this._memberDefaultsPicks || new Set(this._memberDefaultsInitialPicks());

  list.innerHTML = SETTINGS.map(def => {
    const value = def.read(this);
    const ok = def.shareable ? def.shareable(value) : true;
    const shown = ok ? def.show(value) : t('settings.admin.member_defaults.not_shareable');
    return `<label class="member-defaults-row${ok ? '' : ' is-disabled'}">
      <input type="checkbox" data-key="${esc(def.key)}"${ok && picks.has(def.key) ? ' checked' : ''}${ok ? '' : ' disabled'}>
      <span class="member-defaults-name">${esc(def.label())}</span>
      <span class="member-defaults-value">${esc(shown)}</span>
    </label>`;
  }).join('');

  const snap = this._memberDefaultsSnapshot();
  const saved = SETTINGS.filter(d => d.key in snap.s);
  const push = document.getElementById('member-defaults-push');
  const clear = document.getElementById('member-defaults-clear');
  if (push) push.disabled = !saved.length;
  if (clear) clear.disabled = !saved.length;
  summary.innerHTML = saved.length
    ? `<span class="member-defaults-summary-label">${esc(t('settings.admin.member_defaults.saved_label', { count: saved.length }))}</span>
       <span>${saved.map(d => `${esc(d.label())}: <strong>${esc(d.show(snap.s[d.key]))}</strong>`).join(' · ')}</span>`
    : esc(t('settings.admin.member_defaults.none_saved'));
},

_captureMemberDefaults() {
  if (!this._canManageMemberDefaults()) return;
  const picks = this._memberDefaultsPicks || new Set(this._memberDefaultsInitialPicks());
  const settings = {};
  for (const def of SETTINGS) {
    if (!picks.has(def.key)) continue;
    const value = def.read(this);
    if (def.shareable && !def.shareable(value)) continue;
    settings[def.key] = value;
  }
  if (!Object.keys(settings).length) {
    this._showToast(t('settings.admin.member_defaults.pick_one'), 'error');
    return;
  }
  this.socket.emit('set-member-defaults', { settings });
},

};
