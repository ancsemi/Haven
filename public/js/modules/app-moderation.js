// Moderation tools in Server Admin: the audit log, auto-mod, the idle
// members list, and message tags.

export default {

// ═══════════════════════════════════════════════════════
// ── Audit Log ──────────────────────────────────────────
// ═══════════════════════════════════════════════════════

_setupAuditLog() {
  if (this._auditLogSetup) return;
  this._auditLogSetup = true;

  const modal = document.getElementById('audit-log-modal');
  const listEl = document.getElementById('audit-log-list');
  const loadMoreBtn = document.getElementById('audit-log-load-more');
  const filterAction = document.getElementById('audit-log-filter-action');
  const filterActor = document.getElementById('audit-log-filter-actor');
  const refreshBtn = document.getElementById('audit-log-refresh-btn');
  const exportBtn = document.getElementById('audit-log-export-btn');
  const closeBtn = document.getElementById('close-audit-log-btn');
  const openBtn = document.getElementById('open-audit-log-btn');
  if (!modal || !listEl) return;

  this._auditRows = [];
  this._auditOldestId = 0;
  this._auditHasMore = false;

  const ACTION_META = {
    server_setting_update: { icon: '⚙️', label: t('modals.audit_log.actions.server_setting_update') },
    channel_create:        { icon: '➕', label: t('modals.audit_log.actions.channel_create') },
    channel_delete:        { icon: '🗑️', label: t('modals.audit_log.actions.channel_delete') },
    channel_rename:        { icon: '✏️', label: t('modals.audit_log.actions.channel_rename') },
    role_create:           { icon: '🎭', label: t('modals.audit_log.actions.role_create') },
    role_update:           { icon: '🎭', label: t('modals.audit_log.actions.role_update') },
    role_delete:           { icon: '🎭', label: t('modals.audit_log.actions.role_delete') },
    role_assign:           { icon: '👤', label: t('modals.audit_log.actions.role_assign') },
    role_revoke:           { icon: '👤', label: t('modals.audit_log.actions.role_revoke') },
    user_kick:             { icon: '👢', label: t('modals.audit_log.actions.user_kick') },
    user_ban:              { icon: '🚫', label: t('modals.audit_log.actions.user_ban') },
    user_unban:            { icon: '✅', label: t('modals.audit_log.actions.user_unban') },
    user_mute:             { icon: '🔇', label: t('modals.audit_log.actions.user_mute') },
    user_unmute:           { icon: '🔊', label: t('modals.audit_log.actions.user_unmute') },
    user_rename:           { icon: '✏️', label: t('modals.audit_log.actions.user_rename') },
  };

  const _esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const _formatTime = (iso) => {
    if (!iso) return '';
    try {
      const d = new Date(iso.endsWith('Z') ? iso : iso + 'Z');
      return this._fmtDateTime(d);
    } catch { return iso; }
  };

  const renderRows = (append = false) => {
    if (!append) listEl.innerHTML = '';
    if (!this._auditRows.length) {
      listEl.innerHTML = `<div class="audit-log-empty">${t('modals.audit_log.empty')}</div>`;
      loadMoreBtn.style.display = 'none';
      return;
    }
    const frag = document.createDocumentFragment();
    const start = append ? listEl.querySelectorAll('.audit-log-row').length : 0;
    for (let i = start; i < this._auditRows.length; i++) {
      const r = this._auditRows[i];
      const meta = ACTION_META[r.action] || { icon: '•', label: r.action };
      const row = document.createElement('div');
      row.className = 'audit-log-row';
      let detailsHtml = '';
      if (r.details) {
        try {
          const obj = JSON.parse(r.details);
          const parts = [];
          for (const [k, v] of Object.entries(obj)) {
            if (v === null || v === undefined || v === false || v === '') continue;
            const vs = typeof v === 'object' ? JSON.stringify(v) : String(v);
            parts.push(`<span class="audit-detail-pair"><b>${_esc(k)}:</b> ${_esc(vs.slice(0, 120))}</span>`);
          }
          if (parts.length) detailsHtml = `<div class="audit-details">${parts.join('')}</div>`;
        } catch {
          detailsHtml = `<div class="audit-details">${_esc(String(r.details).slice(0, 240))}</div>`;
        }
      }
      row.innerHTML = `
        <span class="audit-icon">${meta.icon}</span>
        <div class="audit-body">
          <div class="audit-line">
            <span class="audit-actor">${_esc(r.actor_username || t('modals.audit_log.system'))}</span>
            <span class="audit-action">${_esc(meta.label)}</span>
            ${r.target_name ? `<span class="audit-target">${_esc(r.target_name)}</span>` : ''}
          </div>
          ${detailsHtml}
          <div class="audit-meta">${_formatTime(r.created_at)} · #${r.id}</div>
        </div>`;
      frag.appendChild(row);
    }
    listEl.appendChild(frag);
    loadMoreBtn.style.display = this._auditHasMore ? '' : 'none';
  };

  const load = (append = false) => {
    const opts = {
      limit: 50,
      action: filterAction.value || null,
      actorUsername: filterActor.value.trim() || null,
      beforeId: append ? this._auditOldestId : 0
    };
    if (!append) {
      this._auditRows = [];
      this._auditOldestId = 0;
      listEl.innerHTML = `<div class="audit-log-empty">${t('modals.audit_log.loading')}</div>`;
    }
    this.socket.emit('get-audit-log', opts, (resp) => {
      if (!resp || resp.error) {
        listEl.innerHTML = `<div class="audit-log-empty">${_esc(resp && resp.error ? resp.error : t('modals.audit_log.load_failed'))}</div>`;
        loadMoreBtn.style.display = 'none';
        return;
      }
      // Populate filter dropdown once
      if (resp.actions && filterAction.options.length <= 1) {
        for (const a of resp.actions) {
          const opt = document.createElement('option');
          opt.value = a;
          opt.textContent = (ACTION_META[a] && ACTION_META[a].label) || a;
          filterAction.appendChild(opt);
        }
      }
      const rows = resp.rows || [];
      this._auditRows = append ? this._auditRows.concat(rows) : rows;
      if (rows.length) this._auditOldestId = rows[rows.length - 1].id;
      this._auditHasMore = !!resp.hasMore;
      renderRows(append);
    });
  };

  openBtn?.addEventListener('click', () => {
    modal.style.display = 'flex';
    load(false);
  });
  closeBtn?.addEventListener('click', () => { modal.style.display = 'none'; });
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.style.display = 'none'; });
  refreshBtn?.addEventListener('click', () => load(false));
  filterAction?.addEventListener('change', () => load(false));
  filterActor?.addEventListener('input', (() => {
    let timer = null;
    return () => { clearTimeout(timer); timer = setTimeout(() => load(false), 300); };
  })());
  loadMoreBtn?.addEventListener('click', () => load(true));
  exportBtn?.addEventListener('click', () => {
    try {
      const blob = new Blob([JSON.stringify(this._auditRows, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `haven-audit-log-${new Date().toISOString().slice(0,10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      console.error('Audit log export failed:', err);
    }
  });
},

/* ── Auto-Mod (v3.42.0) ──────────────────────────────── */

// Wire the whole panel. Called once from the settings-modal setup.
_initAutomodPanel() {
  const on = (id, evt, fn) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener(evt, fn);
  };
  const setKey = (key, value) => this.socket.emit('update-server-setting', { key, value });

  on('automod-enabled', 'change', (e) => {
    setKey('automod_enabled', e.target.checked ? 'true' : 'false');
    this._syncAutomodVisibility();
  });
  on('automod-link-mode', 'change', (e) => setKey('automod_link_mode', e.target.value));

  // Simple boolean toggles, all handled identically.
  [
    ['automod-scan-edits', 'automod_scan_edits'],
    ['automod-scan-dms', 'automod_scan_dms'],
    ['automod-scan-profile', 'automod_scan_profile'],
    ['automod-block-ip-urls', 'automod_block_ip_urls'],
    ['automod-block-punycode', 'automod_block_punycode'],
    ['automod-block-obfuscated', 'automod_block_obfuscated'],
    ['automod-preview-allowlist-only', 'automod_preview_allowlist_only'],
    ['automod-ban-ip', 'automod_ban_ip']
  ].forEach(([id, key]) => on(id, 'change', (e) => setKey(key, e.target.checked ? 'true' : 'false')));

  on('automod-min-account-hours', 'change', (e) => setKey('automod_link_min_account_hours', String(parseInt(e.target.value, 10) || 0)));
  on('automod-new-account-post-minutes', 'change', (e) => setKey('automod_new_account_post_minutes', String(Math.min(10080, Math.max(0, parseInt(e.target.value, 10) || 0)))));
  on('automod-exempt-level', 'change', (e) => setKey('automod_link_exempt_level', String(parseInt(e.target.value, 10) || 0)));
  on('automod-log-channel', 'change', (e) => setKey('automod_log_channel', e.target.value.trim()));

  // The five escalation fields are one JSON setting, so any change resends
  // the whole object. Server-side validation rejects incoherent ladders
  // (ban before mute, etc.), which surfaces as an error toast.
  const pushEscalation = () => {
    const num = (id, fallback) => {
      const v = parseInt(document.getElementById(id)?.value, 10);
      return Number.isFinite(v) ? v : fallback;
    };
    setKey('automod_escalation', JSON.stringify({
      windowHours: num('automod-window-hours', 24),
      warnAt: num('automod-warn-at', 1),
      muteAt: num('automod-mute-at', 3),
      muteMinutes: num('automod-mute-minutes', 60),
      banAt: num('automod-ban-at', 0)
    }));
  };
  ['automod-window-hours', 'automod-warn-at', 'automod-mute-at', 'automod-mute-minutes', 'automod-ban-at']
    .forEach(id => on(id, 'change', pushEscalation));

  // Word groups are one JSON setting, saved on the button (#5614).
  on('automod-word-add-group', 'click', () => this._addAutomodWordGroupRow({ name: '', words: [], strikes: 1 }));
  on('automod-word-save', 'click', () => {
    const groups = [...document.querySelectorAll('#automod-word-groups .automod-word-group')].map(row => ({
      name: row.querySelector('.awg-name').value.trim().slice(0, 40),
      strikes: Math.min(100, Math.max(1, parseInt(row.querySelector('.awg-strikes').value, 10) || 1)),
      words: row.querySelector('.awg-words').value.split(/\r?\n|,/).map(w => w.trim()).filter(Boolean).slice(0, 300)
    })).filter(g => g.words.length);
    setKey('automod_words', JSON.stringify(groups));
    this._showToast(t('settings.admin.automod_words_saved'), 'success');
  });

  on('voice-force-relay', 'change', (e) => setKey('voice_force_relay', e.target.checked ? 'true' : 'false'));
  on('fcm-enabled', 'change', (e) => setKey('fcm_enabled', e.target.checked ? 'true' : 'false'));
  on('media-proxy-enabled', 'change', (e) => {
    setKey('media_proxy_enabled', e.target.checked ? 'true' : 'false');
    // Re-read the token so images start (or stop) routing through the proxy
    // without needing a reload.
    setTimeout(() => this._loadMediaToken?.(), 300);
  });

  const addDomain = () => {
    const input = document.getElementById('automod-domain-input');
    const domain = (input?.value || '').trim();
    if (!domain) return;
    this.socket.emit('add-automod-domain', {
      domain,
      mode: document.getElementById('automod-domain-mode')?.value === 'deny' ? 'deny' : 'allow',
      includeSubdomains: document.getElementById('automod-include-subdomains')?.checked !== false
    });
    if (input) input.value = '';
  };
  on('automod-domain-add', 'click', addDomain);
  on('automod-domain-input', 'keydown', (e) => { if (e.key === 'Enter') addDomain(); });
  on('automod-refresh-log', 'click', () => this.socket.emit('get-automod-log', { limit: 100 }));

  this.socket.on('automod-domain-list', (rows) => this._renderAutomodDomains(rows));
  this.socket.on('automod-log', (data) => this._renderAutomodLog(data));
  this.socket.on('media-cache-stats', (s) => {
    const el = document.getElementById('media-cache-stats');
    if (!el) return;
    const mb = ((s?.bytes || 0) / 1048576).toFixed(1);
    const count = s?.items || 0;
    el.innerHTML = t(count === 1 ? 'settings.admin.media_cache_one' : 'settings.admin.media_cache_other', { count, size: mb }) +
      (this.user?.isAdmin ? ` <button class="btn-sm" id="media-cache-clear" style="margin-left:6px">${t('settings.admin.media_cache_clear')}</button>` : '');
    const clearBtn = document.getElementById('media-cache-clear');
    if (clearBtn) clearBtn.addEventListener('click', () => this.socket.emit('clear-media-cache'));
  });
  this.socket.emit('get-media-cache-stats');

  // Idle-online oversight (v3.46.0)
  const idleRefresh = document.getElementById('idle-online-refresh');
  if (idleRefresh) {
    idleRefresh.addEventListener('click', () => {
      const h = parseInt(document.getElementById('idle-online-hours')?.value, 10) || 4;
      this.socket.emit('get-idle-online', { hours: h });
    });
  }
  this.socket.on('idle-online-list', (data) => this._renderIdleOnline(data));
},

_renderIdleOnline(data) {
  const el = document.getElementById('idle-online-list');
  if (!el) return;
  const users = (data && data.users) || [];
  const hrs = (data && data.thresholdHours) || 4;
  if (users.length === 0) {
    el.innerHTML = `<p class="muted-text">${t('settings.admin.idle_online_empty', { hours: hrs })}</p>`;
    return;
  }
  const fmt = (ms) => {
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  };
  el.innerHTML = users.map(u => `
    <div class="whitelist-item" style="align-items:flex-start">
      <span class="whitelist-username" style="display:flex;flex-direction:column;gap:2px">
        <span><strong>${this._escapeHtml(u.username || t('settings.admin.idle_online_unknown'))}</strong>${u.isAdmin ? ` <span class="muted-text">${t('settings.admin.idle_online_admin')}</span>` : ''}</span>
        <span class="muted-text">${t('settings.admin.idle_online_status', { online: fmt(u.onlineForMs), silent: fmt(u.idleForMs) })}</span>
      </span>
    </div>
  `).join('');
},

// Grey out the rest of the panel when automod is off, so it is obvious that
// none of the settings below are doing anything.
_addAutomodWordGroupRow(g) {
  const host = document.getElementById('automod-word-groups');
  if (!host) return;
  const row = document.createElement('div');
  row.className = 'automod-word-group';
  row.innerHTML = `
    <div class="automod-word-group-head">
      <input type="text" class="settings-text-input awg-name" maxlength="40" placeholder="${this._escapeHtml(t('settings.admin.automod_words_name'))}" value="${this._escapeHtml(g.name || '')}">
      <label class="awg-strikes-label"><span>${t('settings.admin.automod_words_strikes')}</span><input type="number" class="awg-strikes" min="1" max="100" step="1" value="${Math.min(100, Math.max(1, parseInt(g.strikes, 10) || 1))}"></label>
      <button type="button" class="btn-sm danger awg-remove" title="${this._escapeHtml(t('settings.admin.automod_words_remove'))}">&times;</button>
    </div>
    <textarea class="settings-text-input awg-words" rows="3" placeholder="${this._escapeHtml(t('settings.admin.automod_words_placeholder'))}">${this._escapeHtml((g.words || []).join('\n'))}</textarea>`;
  row.querySelector('.awg-remove').addEventListener('click', () => row.remove());
  host.appendChild(row);
},

_renderAutomodWordGroups(raw) {
  const host = document.getElementById('automod-word-groups');
  if (!host) return;
  host.innerHTML = '';
  let groups = [];
  try { groups = JSON.parse(raw || '[]'); } catch (err) { console.warn('[Automod] word groups setting is not valid JSON', err); }
  (Array.isArray(groups) ? groups : []).forEach(g => this._addAutomodWordGroupRow(g || {}));
},

_syncAutomodVisibility() {
  const body = document.getElementById('automod-body');
  if (!body) return;
  const enabled = document.getElementById('automod-enabled')?.checked;
  body.style.opacity = enabled ? '1' : '0.45';
  body.style.pointerEvents = enabled ? '' : 'none';
},

_applyAutomodSettings() {
  const s = this.serverSettings || {};
  const bool = (id, key, dflt) => {
    const el = document.getElementById(id);
    if (el) el.checked = (s[key] !== undefined ? s[key] : dflt) === 'true';
  };
  const num = (id, key, dflt) => {
    const el = document.getElementById(id);
    if (el) el.value = s[key] !== undefined ? s[key] : dflt;
  };

  bool('automod-enabled', 'automod_enabled', 'false');
  const mode = document.getElementById('automod-link-mode');
  if (mode) mode.value = s.automod_link_mode || 'off';

  bool('automod-scan-edits', 'automod_scan_edits', 'true');
  bool('automod-scan-dms', 'automod_scan_dms', 'true');
  bool('automod-scan-profile', 'automod_scan_profile', 'true');
  bool('automod-block-ip-urls', 'automod_block_ip_urls', 'true');
  bool('automod-block-punycode', 'automod_block_punycode', 'true');
  bool('automod-block-obfuscated', 'automod_block_obfuscated', 'true');
  bool('automod-preview-allowlist-only', 'automod_preview_allowlist_only', 'true');
  bool('automod-ban-ip', 'automod_ban_ip', 'false');
  bool('voice-force-relay', 'voice_force_relay', 'false');
  bool('media-proxy-enabled', 'media_proxy_enabled', 'true');
  bool('fcm-enabled', 'fcm_enabled', 'true');

  num('automod-min-account-hours', 'automod_link_min_account_hours', '0');
  num('automod-new-account-post-minutes', 'automod_new_account_post_minutes', '0');
  num('automod-exempt-level', 'automod_link_exempt_level', '50');
  const logCh = document.getElementById('automod-log-channel');
  if (logCh) logCh.value = s.automod_log_channel || '';
  // Only redraw the word groups when the stored value changed, so an admin
  // mid-edit is not wiped by an unrelated setting arriving.
  if (this._automodWordsSeen !== (s.automod_words || '[]')) {
    this._automodWordsSeen = s.automod_words || '[]';
    this._renderAutomodWordGroups(this._automodWordsSeen);
  }

  try {
    const c = JSON.parse(s.automod_escalation || '{}');
    const put = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
    put('automod-window-hours', c.windowHours ?? 24);
    put('automod-warn-at', c.warnAt ?? 1);
    put('automod-mute-at', c.muteAt ?? 3);
    put('automod-mute-minutes', c.muteMinutes ?? 60);
    put('automod-ban-at', c.banAt ?? 0);
  } catch { /* malformed JSON: leave the fields alone */ }

  this._syncAutomodVisibility();
},

_renderAutomodDomains(rows) {
  const el = document.getElementById('automod-domain-list');
  if (!el) return;
  if (!rows || rows.length === 0) {
    el.innerHTML = `<p class="muted-text">${t('settings.admin.automod_no_domains')}</p>`;
    return;
  }
  el.innerHTML = rows.map(r => `
    <div class="whitelist-item">
      <span class="whitelist-username">
        <strong style="color:${r.mode === 'deny' ? 'var(--danger, #e5534b)' : 'var(--accent, #5865f2)'}">
          ${t(r.mode === 'deny' ? 'settings.admin.automod_block_badge' : 'settings.admin.automod_allow_badge')}
        </strong>
        ${this._escapeHtml(r.domain)}${r.include_subdomains ? ` <span class="muted-text">${t('settings.admin.automod_subdomains')}</span>` : ''}
        ${r.note ? `<span class="muted-text"> (${this._escapeHtml(r.note)})</span>` : ''}
      </span>
      <button class="btn-sm btn-danger-sm automod-domain-remove-btn" data-domain="${this._escapeHtml(r.domain)}">✕</button>
    </div>
  `).join('');
  el.querySelectorAll('.automod-domain-remove-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      this.socket.emit('remove-automod-domain', { domain: btn.dataset.domain });
    });
  });
},

_renderAutomodLog(data) {
  const hostsEl = document.getElementById('automod-top-hosts');
  const listEl = document.getElementById('automod-log-list');
  const entries = (data && data.entries) || [];
  const hostCounts = (data && data.hostCounts) || [];

  // Most-blocked hosts get a one-click "allow" so a legitimate domain that
  // everyone keeps trying to share is trivial to fix. This is the feedback
  // loop that stops an over-tight allowlist from quietly frustrating people.
  if (hostsEl) {
    hostsEl.innerHTML = hostCounts.length
      ? `<small class="settings-hint">${t('settings.admin.automod_top_domains')}</small>
         <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px">
           ${hostCounts.map(h => `
             <button class="btn-sm automod-allow-host" data-host="${this._escapeHtml(h.host)}"
                      title="${t('settings.admin.automod_allow_host', { host: this._escapeHtml(h.host) })}">
               ${this._escapeHtml(h.host)} <span class="muted-text">${h.hits}</span>
             </button>`).join('')}
         </div>`
      : '';
    hostsEl.querySelectorAll('.automod-allow-host').forEach(btn => {
      btn.addEventListener('click', () => {
        this.socket.emit('add-automod-domain', { domain: btn.dataset.host, mode: 'allow', includeSubdomains: true });
        this.socket.emit('get-automod-log', { limit: 100 });
      });
    });
  }

  if (!listEl) return;
  if (entries.length === 0) {
    listEl.innerHTML = `<p class="muted-text">${t('settings.admin.automod_nothing_blocked')}</p>`;
    return;
  }
  listEl.innerHTML = entries.map(e => `
    <div class="whitelist-item" style="align-items:flex-start">
      <span class="whitelist-username" style="display:flex;flex-direction:column;gap:2px">
        <span><strong>${this._escapeHtml(e.username)}</strong>
          <span class="muted-text">${this._escapeHtml(e.rule)}</span>
          ${e.channel_name ? `<span class="muted-text">${t('settings.admin.automod_in_channel', { name: this._escapeHtml(e.channel_name) })}</span>` : ''}
        </span>
        ${e.host ? `<span class="muted-text">${this._escapeHtml(e.host)}</span>` : ''}
        <span class="muted-text">${this._formatTimestamp ? this._formatTimestamp(e.created_at) : this._escapeHtml(e.created_at)}</span>
      </span>
    </div>
  `).join('');
},

// ── Admin Tags panel (#tagging phase 4) ────────────────
// Manage the upload-tag vocabulary: add, rename, delete. Rename and delete are
// destructive and non-reversible (they propagate to every attachment), so both
// go through a danger confirm. Bound once; the list re-fetches after each change.
_ensureAdminTagsBound() {
  if (this._adminTagsBound) return;
  this._adminTagsBound = true;
  const addBtn = document.getElementById('tag-admin-add-btn');
  const input = document.getElementById('tag-admin-new');
  addBtn?.addEventListener('click', () => this._adminTagAdd());
  input?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); this._adminTagAdd(); } });
  const list = document.getElementById('tag-admin-list');
  list?.addEventListener('click', (e) => {
    const row = e.target.closest('.tag-admin-row');
    if (!row) return;
    if (e.target.closest('.tag-admin-rename')) this._adminTagStartRename(row);
    else if (e.target.closest('.tag-admin-delete')) this._adminTagDelete(row);
    else if (e.target.closest('.tag-admin-save')) this._adminTagSaveRename(row);
    else if (e.target.closest('.tag-admin-cancel')) this._renderAdminTagList(this._adminTags || []);
  });
  list?.addEventListener('keydown', (e) => {
    if (!e.target.classList?.contains('tag-admin-edit-input')) return;
    if (e.key === 'Enter') { e.preventDefault(); this._adminTagSaveRename(e.target.closest('.tag-admin-row')); }
    else if (e.key === 'Escape') this._renderAdminTagList(this._adminTags || []);
  });
},

_loadAdminTags() {
  this._ensureAdminTagsBound();
  const input = document.getElementById('tag-admin-new');
  if (input) input.maxLength = this._maxTagLen();
  this.socket.emit('admin-list-tags', {}, (res) => {
    const list = document.getElementById('tag-admin-list');
    if (!res || res.error) {
      if (list) list.innerHTML = `<p class="muted-text">${t('settings.admin.tags_error')}</p>`;
      return;
    }
    this._adminTags = res.tags || [];
    this._renderAdminTagList(this._adminTags);
  });
},

_renderAdminTagList(tags) {
  const list = document.getElementById('tag-admin-list');
  if (!list) return;
  if (!tags.length) {
    list.innerHTML = `<p class="muted-text">${t('settings.admin.tags_none')}</p>`;
    return;
  }
  const esc = (s) => this._escapeHtml(s);
  list.innerHTML = tags.map(tg => `
    <div class="tag-admin-row" data-tag-id="${tg.id}">
      <span class="tag-admin-name">${esc(tg.name)}</span>
      <span class="tag-admin-uses">${t('settings.admin.tags_uses', { n: tg.uses || 0 })}</span>
      <span class="tag-admin-row-actions">
        <button class="btn-sm tag-admin-rename">${t('settings.admin.tags_rename_btn')}</button>
        <button class="btn-sm btn-danger-fill tag-admin-delete">${t('settings.admin.tags_delete_btn')}</button>
      </span>
    </div>`).join('');
},

_adminTagAdd() {
  const input = document.getElementById('tag-admin-new');
  const name = (input?.value || '').trim();
  if (!name) return;
  this.socket.emit('admin-create-tag', { name }, (res) => {
    if (res && res.ok) {
      if (input) input.value = '';
      this._showToast?.(t('settings.admin.tags_added', { name: res.tag.name }), 'info');
      this._loadAdminTags();
    } else if (res && res.error === 'exists') {
      this._showToast?.(t('settings.admin.tags_exists'), 'error');
    } else if (res && res.error === 'invalid') {
      this._showToast?.(t('settings.admin.tags_invalid'), 'error');
    } else {
      this._showToast?.(t('settings.admin.tags_error'), 'error');
    }
  });
},

_adminTagStartRename(row) {
  const name = row.querySelector('.tag-admin-name')?.textContent || '';
  row.innerHTML = `
    <input type="text" class="tag-admin-edit-input settings-text-input" maxlength="${this._maxTagLen()}" value="${this._escapeHtml(name)}" autocomplete="off">
    <span class="tag-admin-row-actions">
      <button class="btn-sm btn-accent tag-admin-save">${t('settings.admin.tags_save_btn')}</button>
      <button class="btn-sm tag-admin-cancel">${t('modals.common.cancel')}</button>
    </span>`;
  const input = row.querySelector('.tag-admin-edit-input');
  input.dataset.orig = name;
  input.focus();
  input.select();
},

async _adminTagSaveRename(row) {
  if (!row) return;
  const id = parseInt(row.dataset.tagId, 10);
  const input = row.querySelector('.tag-admin-edit-input');
  const newName = (input?.value || '').trim();
  const orig = input?.dataset.orig || '';
  if (!newName || newName === orig) { this._renderAdminTagList(this._adminTags || []); return; }
  const ok = await this._showConfirmModal(
    t('settings.admin.tags_rename_title'),
    t('settings.admin.tags_rename_body', { from: orig, to: newName }),
    { danger: true, confirmLabel: t('settings.admin.tags_rename_confirm') }
  );
  if (!ok) { this._renderAdminTagList(this._adminTags || []); return; }
  this.socket.emit('admin-rename-tag', { tagId: id, newName }, (res) => {
    if (res && res.ok) {
      this._showToast?.(t('settings.admin.tags_renamed'), 'info');
    } else if (res && res.error === 'invalid') {
      this._showToast?.(t('settings.admin.tags_invalid'), 'error');
    } else {
      this._showToast?.(t('settings.admin.tags_error'), 'error');
    }
    this._loadAdminTags();
  });
},

async _adminTagDelete(row) {
  const id = parseInt(row.dataset.tagId, 10);
  const name = row.querySelector('.tag-admin-name')?.textContent || '';
  const tag = (this._adminTags || []).find(x => x.id === id);
  const uses = tag ? (tag.uses || 0) : 0;
  const ok = await this._showConfirmModal(
    t('settings.admin.tags_delete_title'),
    t('settings.admin.tags_delete_body', { name, n: uses }),
    { danger: true, confirmLabel: t('settings.admin.tags_delete_confirm') }
  );
  if (!ok) return;
  this.socket.emit('admin-delete-tag', { tagId: id }, (res) => {
    if (res && res.ok) this._showToast?.(t('settings.admin.tags_deleted'), 'info');
    else this._showToast?.(t('settings.admin.tags_error'), 'error');
    this._loadAdminTags();
  });
},

};
