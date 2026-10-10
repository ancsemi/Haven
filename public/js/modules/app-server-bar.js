// The server bar: the list of Haven servers you belong to, their unread dots,
// adding, editing, reordering and removing them, and keeping the list in sync
// with your account and the desktop app.

export default {

/** Push the current server list to the server-side encrypted backup. */
_pushServerListToServer() {
  const wrappingKey = this._e2eWrappingKey || sessionStorage.getItem('haven_e2e_wrap') || null;
  if (wrappingKey && this.serverManager && this.token) {
    this.serverManager._pushToServer(this.token, wrappingKey).catch((err) => { console.warn('[Sync] could not push the server list', err); });
  }
},

/** Reconcile with the Desktop app's server list, which every server shares:
 *  take its removals, servers, order and names, and hand it the servers
 *  discovered here (for example through the encrypted sync) so they reach
 *  the OTHER Haven servers too. */
_pushServersToDesktopHistory() {
  if (!window.havenDesktop || !this.serverManager) return;
  this.serverManager.reconcileWithDesktop().then((stats) => {
    if (stats.added || stats.removed || stats.renamed) this._renderServerBar();
  }).catch((err) => { console.warn('[Desktop] could not sync the server list', err); });
},

_setupServerBar() {
  this.serverManager.startPolling(30000);

  // Desktop: reconcile with the app's server list so the sidebar shows the
  // same servers on every server, even on first login to this one
  if (window.havenDesktop) {
    this.serverManager.reconcileWithDesktop().then((stats) => {
      if (stats.removed || stats.renamed) this._renderServerBar();
      // First-join scenario: if the synchronous preload bootstrap pulled in
      // servers we didn't have locally OR the reconcile just added more,
      // push the merged list to THIS server's encrypted backup immediately
      // so the user is never stranded with an empty sidebar.
      if (stats.added || this.serverManager.bootstrappedFromDesktop) {
        this._renderServerBar();
        this._pushServerListToServer();
      }
    }).catch((err) => { console.warn('[Desktop] could not sync the server list', err); });

    // Newer Desktop versions say when the shared list changed on another
    // server (a removal, rename or new order), so this sidebar follows.
    window.addEventListener('haven-server-list-changed', () => {
      clearTimeout(this._serverListChangedTimer);
      this._serverListChangedTimer = setTimeout(() => {
        this.serverManager.reconcileWithDesktop()
          .then(() => this._renderServerBar())
          .catch((err) => { console.warn('[Desktop] could not sync the server list', err); });
      }, 300);
    });
  }

  this._renderServerBar();
  if (this._serverBarInterval) clearInterval(this._serverBarInterval);
  this._serverBarInterval = setInterval(() => this._renderServerBar(), 30000);

  // Re-render once the self-fingerprint resolves (hides "self" in sidebar)
  this.serverManager.selfFingerprintReady?.then(() => this._renderServerBar());

  // Desktop notification dots: listen for badge updates from main process
  window.addEventListener('haven-server-badges', (e) => this._updateServerBadgeDots(e.detail));
  window.havenDesktop?.getServerBadges?.().then(b => this._updateServerBadgeDots(b));

  document.getElementById('home-server').addEventListener('click', () => {
    // Already home: pulse the icon for fun
    const el = document.getElementById('home-server');
    el.classList.add('bounce');
    setTimeout(() => el.classList.remove('bounce'), 400);
  });

  document.getElementById('add-server-btn').addEventListener('click', () => {
    this._editingServerUrl = null;
    document.getElementById('add-server-modal-title').textContent = t('modals.add_server.title');
    document.getElementById('add-server-modal').style.display = 'flex';
    document.getElementById('add-server-name-input').value = '';
    document.getElementById('server-url-input').value = '';
    document.getElementById('server-url-input').disabled = false;
    document.getElementById('add-server-icon-input').value = '';
    document.getElementById('save-server-btn').textContent = t('modals.add_server.add_btn');
    this._populateKnownServersDatalist();
    document.getElementById('add-server-name-input').focus();
  });

  document.getElementById('cancel-server-btn').addEventListener('click', () => {
    document.getElementById('add-server-modal').style.display = 'none';
    document.getElementById('server-url-input').disabled = false;
    this._editingServerUrl = null;
  });

  document.getElementById('save-server-btn').addEventListener('click', () => this._addServer());

  // Enter key in modal inputs
  document.getElementById('server-url-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') this._addServer();
  });

  // Close modal on overlay click
  document.getElementById('add-server-modal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) e.currentTarget.style.display = 'none';
  });

  // ── Manage Servers gear button & modal ──────────────
  document.getElementById('manage-servers-btn')?.addEventListener('click', () => {
    this._openManageServersModal();
  });
  document.getElementById('manage-servers-close-btn')?.addEventListener('click', () => {
    document.getElementById('manage-servers-modal').style.display = 'none';
  });
  document.getElementById('manage-servers-modal')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) e.currentTarget.style.display = 'none';
  });
  document.getElementById('manage-servers-add-btn')?.addEventListener('click', () => {
    document.getElementById('manage-servers-modal').style.display = 'none';
    document.getElementById('add-server-btn').click();
  });

  // ── Sync Servers button ─────────────────────────────
  document.getElementById('sync-servers-btn')?.addEventListener('click', async () => {
    const btn = document.getElementById('sync-servers-btn');
    btn.classList.add('spinning');
    const manager = this.serverManager;
    const before = new Map(manager.servers.map(s => [s.url, s.name]));
    try {
      // 1. The Desktop app's list, shared by every server: removals, servers,
      //    order and names
      await manager.reconcileWithDesktop();

      // 2. This account's encrypted list on this server
      const syncKey = this._e2eWrappingKey || sessionStorage.getItem('haven_e2e_wrap') || null;
      let synced = { ok: true };
      if (syncKey && this.token) synced = await manager.syncWithServer(this.token, syncKey);

      // 3. Hand what that brought in to the Desktop app, and the merged list
      //    back to the encrypted backup
      if (window.havenDesktop) await manager.reconcileWithDesktop();
      this._pushServerListToServer();

      // 4. Health-check all servers (names follow their server)
      await manager.checkAll();
      this._renderServerBar();
      if (this._renderManageServersList && document.getElementById('manage-servers-modal')?.style.display === 'flex') {
        this._renderManageServersList();
      }

      if (!synced.ok) {
        this._showToast(t('servers.sync_failed'), 'error');
        return;
      }
      const after = new Map(manager.servers.map(s => [s.url, s.name]));
      let added = 0, removed = 0, renamed = 0;
      for (const [url, name] of after) {
        if (!before.has(url)) added++;
        else if (before.get(url) !== name) renamed++;
      }
      for (const url of before.keys()) if (!after.has(url)) removed++;
      if (added || removed || renamed) {
        this._showToast(t('servers.sync_updated', { added, removed, renamed }), 'success');
      } else {
        this._showToast(t('servers.sync_up_to_date'), 'success');
      }
    } catch (err) {
      console.warn('[Sync] server list sync failed', err);
      this._showToast(t('servers.sync_failed'), 'error');
    } finally {
      btn.classList.remove('spinning');
    }
  });

  // ── Channel Code Settings Modal ─────────────────────
  document.getElementById('channel-code-settings-btn')?.addEventListener('click', () => {
    if (!this.currentChannel) return;
    const channel = this.channels.find(c => c.code === this.currentChannel);
    if (!channel || channel.is_dm) return;
    if (!this.user.isAdmin && !channel.canManageSettings) return; // (#5467) per channel, not "anywhere"

    document.getElementById('code-settings-channel-name').textContent = `# ${channel.name}`;
    document.getElementById('code-visibility-select').value = channel.code_visibility || 'public';
    document.getElementById('code-mode-select').value = channel.code_mode || 'static';
    document.getElementById('code-rotation-type-select').value = channel.code_rotation_type || 'time';
    document.getElementById('code-rotation-interval').value = channel.code_rotation_interval || 60;

    this._toggleCodeRotationFields();
    document.getElementById('code-settings-modal').style.display = 'flex';
  });

  document.getElementById('code-mode-select')?.addEventListener('change', () => this._toggleCodeRotationFields());
  document.getElementById('code-rotation-type-select')?.addEventListener('change', () => {
    const type = document.getElementById('code-rotation-type-select').value;
    const label = document.getElementById('rotation-interval-label');
    if (label) label.textContent = type === 'time' ? t('modals.code_settings.interval_label') : t('modals.code_settings.rotate_after_joins');
  });

  document.getElementById('code-settings-cancel-btn')?.addEventListener('click', () => {
    document.getElementById('code-settings-modal').style.display = 'none';
  });

  document.getElementById('code-settings-modal')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) e.currentTarget.style.display = 'none';
  });

  document.getElementById('code-settings-save-btn')?.addEventListener('click', () => {
    const channel = this.channels.find(c => c.code === this.currentChannel);
    if (!channel) return;

    this.socket.emit('update-channel-code-settings', {
      channelId: channel.id,
      code_visibility: document.getElementById('code-visibility-select').value,
      code_mode: document.getElementById('code-mode-select').value,
      code_rotation_type: document.getElementById('code-rotation-type-select').value,
      code_rotation_interval: parseInt(document.getElementById('code-rotation-interval').value) || 60
    });

    document.getElementById('code-settings-modal').style.display = 'none';
  });

  document.getElementById('code-rotate-now-btn')?.addEventListener('click', () => {
    const channel = this.channels.find(c => c.code === this.currentChannel);
    if (!channel) return;

    if (!confirm(t('confirm.rotate_channel_code'))) return;
    this.socket.emit('rotate-channel-code', { channelId: channel.id });
    document.getElementById('code-settings-modal').style.display = 'none';
  });
},

_toggleCodeRotationFields() {
  const isDynamic = document.getElementById('code-mode-select').value === 'dynamic';
  document.getElementById('rotation-type-group').style.display = isDynamic ? '' : 'none';
  document.getElementById('rotation-interval-group').style.display = isDynamic ? '' : 'none';
  // Update interval label based on rotation type
  const type = document.getElementById('code-rotation-type-select').value;
  const label = document.getElementById('rotation-interval-label');
  if (label) label.textContent = type === 'time' ? t('modals.code_settings.interval_label') : t('modals.code_settings.rotate_after_joins');
},

/** Populate the datalist in the Add Server modal with known servers from
 *  the web ServerManager and (if in Desktop) the Electron server history. */
async _populateKnownServersDatalist() {
  const datalist = document.getElementById('known-servers-datalist');
  if (!datalist) return;
  datalist.innerHTML = '';

  // Collect from web ServerManager
  const known = new Map(); // url → name
  for (const s of this.serverManager.getAll()) {
    known.set(s.url, s.name || s.url);
  }

  // Collect from Desktop server history (if running in Electron)
  if (window.havenDesktop?.getServerHistory) {
    try {
      const history = await window.havenDesktop.getServerHistory();
      for (const h of (history || [])) {
        if (h.url && !known.has(h.url)) known.set(h.url, h.name || h.url);
      }
    } catch { /* not available */ }
  }

  // Build datalist options
  for (const [url, name] of known) {
    const opt = document.createElement('option');
    opt.value = url;
    opt.label = name !== url ? name : '';
    datalist.appendChild(opt);
  }

  // When the user picks a server from the list, auto-fill the name field
  const urlInput = document.getElementById('server-url-input');
  const nameInput = document.getElementById('add-server-name-input');
  const onChange = () => {
    const match = known.get(urlInput.value);
    if (match && !nameInput.value) {
      nameInput.value = match;
    }
  };
  // Remove previous listener to avoid stacking
  urlInput.removeEventListener('change', urlInput._knownServerHandler);
  urlInput._knownServerHandler = onChange;
  urlInput.addEventListener('change', onChange);
},

async _addServer() {
  const name = document.getElementById('add-server-name-input').value.trim();
  const url = document.getElementById('server-url-input').value.trim();
  const iconInput = document.getElementById('add-server-icon-input').value.trim();
  const autoPull = document.getElementById('server-auto-icon').checked;
  if (!name || !url) return this._showToast(t('toasts.name_address_required'), 'error');

  const editUrl = this._editingServerUrl;
  if (editUrl) {
    // Editing existing server (a name of your own is kept and, in the
    // Desktop app, shown on every server). A Desktop app that asks first
    // makes the edit only once the user says yes there.
    let edited = false;
    try { edited = await this.serverManager.editByUser(editUrl, { name, icon: iconInput || null }); }
    catch (err) { console.warn('[Desktop] could not share the server name', err); }
    if (!edited) return;
    this._editingServerUrl = null;
    document.getElementById('add-server-modal').style.display = 'none';
    this._renderServerBar();
    this._showToast(t('toasts.server_updated', { name }), 'success');
    this._pushServerListToServer();
    // Auto-pull icon if checked
    if (autoPull) this._autoPullServerIcon(editUrl);
  } else if (this.serverManager.desktopGated()) {
    await this._addServerThroughDesktop(name, url, iconInput || null, autoPull);
  } else {
    // Adding new server
    const icon = iconInput || null;
    if (this.serverManager.add(name, url, icon, { userInitiated: true, customName: true })) {
      document.getElementById('add-server-modal').style.display = 'none';
      this._renderServerBar();
      this._showToast(t('toasts.server_added', { name }), 'success');
      this._pushServerListToServer();
      // Also add to Desktop server history so it persists across all servers
      // (added on purpose, so it comes back even if it was removed before)
      if (window.havenDesktop?.addServerHistory) {
        const cleanUrl = url.replace(/\/+$/, '');
        const finalUrl = /^https?:\/\//.test(cleanUrl) ? cleanUrl : 'https://' + cleanUrl;
        // Then the name typed here is shared as the user's own, so the
        // server's name does not replace it on the other servers either.
        window.havenDesktop.addServerHistory(finalUrl, name, { userInitiated: true })
          .then(() => this.serverManager.shareName(finalUrl))
          .catch((err) => { console.warn('[Desktop] could not add to server history', err); });
      }
      // Auto-pull icon after health check completes
      if (autoPull) {
        const cleanUrl = url.replace(/\/+$/, '');
        const finalUrl = /^https?:\/\//.test(cleanUrl) ? cleanUrl : 'https://' + cleanUrl;
        setTimeout(() => this._autoPullServerIcon(finalUrl), 2000);
      }
    } else {
      this._showToast(t('toasts.server_already_in_list'), 'error');
    }
  }
},

/** Add Server in a Desktop app that asks first: the app asks the user (and
 *  keeps the typed name as theirs), and the server is added here once it is
 *  in the app's list. */
async _addServerThroughDesktop(name, url, icon, autoPull) {
  const cleanUrl = url.replace(/\/+$/, '');
  const finalUrl = /^https?:\/\//.test(cleanUrl) ? cleanUrl : 'https://' + cleanUrl;
  if (this.serverManager.servers.some(s => this.serverManager._normalizeUrl(s.url) === this.serverManager._normalizeUrl(finalUrl))) {
    return this._showToast(t('toasts.server_already_in_list'), 'error');
  }
  let result = null;
  try { result = await window.havenDesktop.addServerHistory(finalUrl, name, { userInitiated: true }); }
  catch (err) { console.warn('[Desktop] could not add to server history', err); }
  // The user said no in the app's own question: leave the form as it is.
  if (result === 'declined') return;
  if (result !== 'added' && result !== 'exists') {
    return this._showToast(t('servers.desktop_not_changed'), 'error');
  }
  this.serverManager.add(name, finalUrl, icon, { userInitiated: true, customName: true });
  document.getElementById('add-server-modal').style.display = 'none';
  this._renderServerBar();
  this._showToast(t('toasts.server_added', { name }), 'success');
  this._pushServerListToServer();
  if (autoPull) setTimeout(() => this._autoPullServerIcon(this.serverManager._normalizeUrl(finalUrl)), 2000);
},

/** Remove a server the user picked. A Desktop app that asks first asks
 *  instead of this page, and the server goes once the user said yes there.
 *  done() runs after it is gone. */
_removeServerByUser(url, name, done) {
  const manager = this.serverManager;
  if (!manager.desktopAsksFor(url)) {
    if (!confirm(t('confirm.remove_server', { name }))) return;
    // Also removed from the Desktop app's list, so no other server's
    // sidebar brings it back.
    manager.remove(url);
    done();
    return;
  }
  manager.removeThroughDesktop(url).then((removed) => {
    if (removed) done();
  }).catch((err) => { console.warn('[Desktop] could not remove from server history', err); });
},

_autoPullServerIcon(url) {
  const status = this.serverManager.statusCache.get(url);
  if (status && status.icon) {
    this.serverManager.update(url, { icon: status.icon });
    this._renderServerBar();
  }
},

_editServer(url) {
  const server = this.serverManager.servers.find(s => s.url === url);
  if (!server) return;
  this._editingServerUrl = url;
  document.getElementById('add-server-modal-title').textContent = t('modals.manage_servers.edit_title');
  document.getElementById('add-server-name-input').value = server.name;
  document.getElementById('server-url-input').value = server.url;
  document.getElementById('server-url-input').disabled = true;
  document.getElementById('add-server-icon-input').value = server.icon || '';
  document.getElementById('save-server-btn').textContent = t('modals.common.save');
  document.getElementById('add-server-modal').style.display = 'flex';
  document.getElementById('add-server-name-input').focus();
},

_openManageServersModal() {
  this._renderManageServersList();
  document.getElementById('manage-servers-modal').style.display = 'flex';
},

_renderManageServersList() {
  const container = document.getElementById('manage-servers-list');
  // Second addresses of a server stay listed here, with a note, so one can
  // be deleted; the rail shows only the first.
  const servers = this.serverManager.otherServers(window.location.origin);
  container.innerHTML = '';
  if (servers.length === 0) return;  // CSS :empty handles empty state

  let dragSrcRow = null;

  servers.forEach(s => {
    const row = document.createElement('div');
    row.className = 'manage-server-row';
    row.draggable = true;
    row.dataset.url = s.url;

    const online = s.status.online;
    const statusClass = online === true ? 'online' : online === false ? 'offline' : 'unknown';
    const statusText = online === true ? t('servers.online') : online === false ? t('servers.offline') : t('servers.checking');
    const initial = s.name.charAt(0).toUpperCase();
    const iconUrl = s.icon || (s.status.icon || null);
    const iconContent = iconUrl
      ? `<img src="${this._escapeHtml(iconUrl)}" alt="" class="manage-srv-icon-img">`
      : initial;

    row.innerHTML = `
      <div class="manage-server-drag-handle" title="${t('channels.drag_to_reorder')}">⠿</div>
      <div class="manage-server-icon">${iconContent}</div>
      <div class="manage-server-info">
        <div class="manage-server-name">${this._escapeHtml(s.name)}</div>
        <div class="manage-server-url">${this._escapeHtml(s.url)}</div>
        ${s.duplicateOf ? `<div class="manage-server-duplicate">${this._escapeHtml(t('servers.same_server_as', { name: s.duplicateOf.name || s.duplicateOf.url }))}</div>` : ''}
      </div>
      <span class="manage-server-status ${statusClass}">${statusText}</span>
      <div class="manage-server-actions">
        <button class="manage-server-visit" title="${t('servers.open_tab')}">🔗</button>
        <button class="manage-server-edit" title="${t('servers.edit')}">✏️</button>
        <button class="manage-server-delete danger-action" title="${t('servers.remove')}">🗑️</button>
      </div>
    `;

    // ── Drag-and-drop handlers ──
    row.addEventListener('dragstart', (e) => {
      dragSrcRow = row;
      row.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', s.url);
    });
    row.addEventListener('dragend', () => {
      row.classList.remove('dragging');
      container.querySelectorAll('.manage-server-row').forEach(r => r.classList.remove('drag-over-above', 'drag-over-below'));
      dragSrcRow = null;
    });
    row.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (dragSrcRow === row) return;
      const rect = row.getBoundingClientRect();
      const mid = rect.top + rect.height / 2;
      row.classList.toggle('drag-over-above', e.clientY < mid);
      row.classList.toggle('drag-over-below', e.clientY >= mid);
    });
    row.addEventListener('dragleave', () => {
      row.classList.remove('drag-over-above', 'drag-over-below');
    });
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      row.classList.remove('drag-over-above', 'drag-over-below');
      if (!dragSrcRow || dragSrcRow === row) return;
      const rect = row.getBoundingClientRect();
      const mid = rect.top + rect.height / 2;
      if (e.clientY < mid) {
        container.insertBefore(dragSrcRow, row);
      } else {
        container.insertBefore(dragSrcRow, row.nextSibling);
      }
      // Persist the new order
      const orderedUrls = [...container.querySelectorAll('.manage-server-row')].map(r => r.dataset.url);
      this.serverManager.reorder(orderedUrls);
      this._renderServerBar();
      this._pushServerListToServer();
    });

    row.querySelector('.manage-server-visit').addEventListener('click', () => {
      if (window.havenDesktop?.switchServer) {
        window.havenDesktop.switchServer(s.url);
      } else {
        window.open(s.url, '_blank', 'noopener');
      }
    });
    row.querySelector('.manage-server-edit').addEventListener('click', () => {
      document.getElementById('manage-servers-modal').style.display = 'none';
      this._editServer(s.url);
    });
    row.querySelector('.manage-server-delete').addEventListener('click', () => {
      this._removeServerByUser(s.url, s.name, () => {
        this._renderServerBar();
        this._renderManageServersList();
        this._showToast(t('toasts.server_removed_named', { name: s.name }), 'success');
        this._pushServerListToServer();
      });
    });

    // CSP-safe icon error handling: hide broken img, show initial letter
    const iconImg = row.querySelector('.manage-srv-icon-img');
    if (iconImg) {
      iconImg.addEventListener('error', () => {
        iconImg.style.display = 'none';
        iconImg.parentElement.textContent = initial;
      });
    }

    container.appendChild(row);
  });
},

_updateServerBadgeDots(payload) {
  if (!payload) return;
  // Payload shape evolved: old code sent `{ url: bool }` directly, new code
  // sends `{ badges: { url: bool }, names: { url: 'Name' } }`. Accept both
  // so a stale renderer talking to a fresh main (or vice-versa) doesn't
  // wipe its dots. (#5337)
  let badges, names;
  if (payload && typeof payload === 'object' && payload.badges && typeof payload.badges === 'object') {
    badges = payload.badges; names = payload.names || {};
  } else {
    badges = payload; names = {};
  }
  // Cache so _renderServerBar can reapply dots immediately after a re-render
  // instead of waiting for the next haven-server-badges event. (#5300)
  this._lastServerBadges = { badges, names };
  // Main process keys serverBadgeState by normalized URL (no trailing slash,
  // no /app or /app.html, no query/hash). The DOM stores the raw user-entered
  // URL, so a direct lookup misses for any server that doesn't already happen
  // to match exactly. Normalize both sides before comparing.
  const norm = (raw) => {
    let v = String(raw || '').trim();
    if (!v) return '';
    if (!/^https?:\/\//i.test(v)) v = 'https://' + v;
    try {
      const u = new URL(v);
      u.hash = ''; u.search = '';
      let p = (u.pathname || '/').replace(/\/+$/, '') || '/';
      p = p.replace(/\/app(?:\.html)?$/i, '') || '/';
      p = p.replace(/\/+$/, '') || '/';
      return p === '/' ? u.origin : u.origin + p;
    } catch {
      return v.replace(/\/+$/, '');
    }
  };
  const normalized = {};
  for (const [k, v] of Object.entries(badges)) normalized[norm(k)] = v;
  // Track which normalized URLs are attached to a real sidebar icon. The
  // current view's own origin never has an icon in its own sidebar (filtered
  // out as "self"), so treat it as covered.
  const covered = new Set();
  try { covered.add(norm(window.location.origin)); } catch { /* unparsable origin: nothing to mark as covered */ }
  document.querySelectorAll('#server-list .server-icon.remote').forEach(el => {
    const url = el.dataset.url;
    const dot = el.querySelector('.server-unread-dot');
    if (!dot) return;
    const nUrl = norm(url);
    covered.add(nUrl);
    const count = normalized[nUrl] || normalized[url] || badges[url] || 0;
    dot.classList.toggle('active', count > 0);
  });
  // Auto-recover for the long-standing taskbar-lit / sidebar-blank desync:
  // when a background server fires a badge but no icon exists for it in
  // this view's curated sidebar (per-view localStorage, alias URLs, etc),
  // add it as a real sidebar icon using serverManager.add(). The next
  // _renderServerBar pass will paint a proper icon (real name from the
  // broadcast name map, real avatar fetched from /api/health, real click-
  // to-switch behavior) and re-apply the unread dot via _lastServerBadges.
  // (#5337)
  let autoAdded = false;
  this._autoAddedUnreadUrls = this._autoAddedUnreadUrls || new Set();
  if (this.serverManager && typeof this.serverManager.add === 'function') {
    for (const [nUrl, hasUnread] of Object.entries(normalized)) {
      if (!hasUnread) continue;
      if (covered.has(nUrl)) continue;
      // Per-session guard so a server the user actively removes mid-session
      // doesn't ping-pong back in on every badge tick.
      if (this._autoAddedUnreadUrls.has(nUrl)) continue;
      // Removed in the Desktop app (on any server): a background unread
      // does not bring it back.
      if (this.serverManager.desktopRemoved?.has(nUrl)) continue;
      const name = (names && (names[nUrl] || names[nUrl + '/'])) || (() => {
        try { return new URL(nUrl).hostname; } catch { return nUrl; }
      })();
      // userInitiated:true clears any stale "removed" flag, surfacing an
      // unread badge counts as the user implicitly wanting that server back.
      if (this.serverManager.add(name, nUrl, null, { userInitiated: true })) {
        this._autoAddedUnreadUrls.add(nUrl);
        autoAdded = true;
      }
    }
  }
  if (autoAdded) {
    // _renderServerBar re-calls _updateServerBadgeDots(this._lastServerBadges)
    // at the end of its work, so the new icon gets its dot in the next pass.
    this._renderServerBar();
    return;
  }
  // Report the URLs we can actually surface back to main so taskbar
  // recomputation can drop phantom unreads from background-preloaded
  // servers no view can display. (#5269)
  this._reportKnownServerUrls();
},

// Drag-and-drop reordering of remote server icons in the sidebar.
// Mirrors the channel sidebar drag pattern: event delegation on the list
// container, drop reorders the underlying ServerManager list, then
// re-renders. Idempotent: only attaches handlers once per list element.
_setupServerBarDrag(list) {
  if (!list || list._serverDragSetup) return;
  list._serverDragSetup = true;

  const indicator = document.createElement('div');
  indicator.className = 'server-drop-indicator';

  const cleanup = () => {
    if (list._serverDragSrc) list._serverDragSrc.classList.remove('server-dragging');
    list._serverDragSrc = null;
    indicator.remove();
  };

  list.addEventListener('dragstart', (e) => {
    const el = e.target.closest('.server-icon.remote[draggable="true"]');
    if (!el) return;
    list._serverDragSrc = el;
    el.classList.add('server-dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', el.dataset.url || '');
  });

  list.addEventListener('dragover', (e) => {
    if (!list._serverDragSrc) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const tgt = e.target.closest('.server-icon.remote');
    if (!tgt || tgt === list._serverDragSrc) { indicator.remove(); return; }
    const rect = tgt.getBoundingClientRect();
    const before = (e.clientY - rect.top) < rect.height / 2;
    if (before) list.insertBefore(indicator, tgt);
    else list.insertBefore(indicator, tgt.nextSibling);
  });

  list.addEventListener('dragleave', (e) => {
    if (!list.contains(e.relatedTarget)) indicator.remove();
  });

  list.addEventListener('drop', (e) => {
    e.preventDefault();
    const src = list._serverDragSrc;
    if (!src || !indicator.parentNode) { cleanup(); return; }
    indicator.parentNode.insertBefore(src, indicator);
    indicator.remove();
    src.classList.remove('server-dragging');
    list._serverDragSrc = null;
    const orderedUrls = Array.from(list.querySelectorAll('.server-icon.remote')).map(el => el.dataset.url);
    if (this.serverManager?.reorder) {
      this.serverManager.reorder(orderedUrls);
      this._pushServerListToServer?.();
      this._renderServerBar();
    }
  });

  list.addEventListener('dragend', cleanup);
},

// Tell the desktop main process which server URLs this view recognises
// (its own origin + every remote icon currently in its sidebar). Main
// uses this to filter the taskbar overlay so it never shows a badge for
// a server the user can't see/visit from any open view.
_reportKnownServerUrls() {
  if (!window.havenDesktop?.reportKnownServerUrls) return;
  const norm = (raw) => {
    let v = String(raw || '').trim();
    if (!v) return '';
    if (!/^https?:\/\//i.test(v)) v = 'https://' + v;
    try {
      const u = new URL(v);
      u.hash = ''; u.search = '';
      let p = (u.pathname || '/').replace(/\/+$/, '') || '/';
      p = p.replace(/\/app(?:\.html)?$/i, '') || '/';
      p = p.replace(/\/+$/, '') || '/';
      return p === '/' ? u.origin : u.origin + p;
    } catch { return v.replace(/\/+$/, ''); }
  };
  const known = new Set();
  known.add(norm(window.location.origin));
  document.querySelectorAll('#server-list .server-icon.remote').forEach(el => {
    const u = norm(el.dataset.url);
    if (u) known.add(u);
  });
  try { window.havenDesktop.reportKnownServerUrls(Array.from(known)); } catch (err) { console.warn('[Desktop] could not report known servers', err); }
},

// Append a stable cache-buster query param to icon URLs. This forces the
// browser to bypass any pre-CORS cached response for the same image (which
// causes "No Access-Control-Allow-Origin" errors when a non-crossorigin
// load was cached without the proper Vary: Origin header). See #5240.
_withCacheBust(url) {
  if (!url || typeof url !== 'string') return url;
  if (url.startsWith('data:') || url.startsWith('blob:')) return url;
  // 'cors2' marks the post-Vary/CORP header fix; bump if the cache invariant changes again.
  const tag = 'cors2';
  return url + (url.includes('?') ? '&' : '?') + '_cb=' + tag;
},

_renderServerBar() {
  const list = document.getElementById('server-list');
  // Not this server, and a server reachable at two addresses only once.
  const servers = this.serverManager.railServers(window.location.origin);

  list.innerHTML = servers.map(s => {
    const initial = s.name.charAt(0).toUpperCase();
    const online = s.status.online;
    const statusClass = online === true ? 'online' : online === false ? 'offline' : 'unknown';
    const statusText = online === true ? '● ' + t('servers.online') : online === false ? '○ ' + t('servers.offline') : '◌ ' + t('servers.checking');
    // Use custom icon, auto-pulled icon from health check, or letter initial
    const iconUrl = s.icon || (s.status.icon || null);
    // Append a stable cache-buster so browsers don't reuse a bad pre-CORS
    // cached response (which causes "No Access-Control-Allow-Origin" errors
    // on icons that were loaded once without the crossorigin attribute). See #5240.
    const bustedIcon = iconUrl ? this._withCacheBust(iconUrl) : null;
    const iconContent = bustedIcon
      ? `<img src="${this._escapeHtml(bustedIcon)}" class="server-icon-img" crossorigin="anonymous"${s.iconData ? ` data-fallback-src="${this._escapeHtml(s.iconData)}"` : ''} alt=""><span class="server-icon-text" style="display:none">${this._escapeHtml(initial)}</span>`
      : (s.iconData
        ? `<img src="${this._escapeHtml(s.iconData)}" class="server-icon-img" alt=""><span class="server-icon-text" style="display:none">${this._escapeHtml(initial)}</span>`
        : `<span class="server-icon-text">${this._escapeHtml(initial)}</span>`);
    return `
      <div class="server-icon remote" data-url="${this._escapeHtml(s.url)}" draggable="true"
           title="${this._escapeHtml(s.name)}&#10;${statusText}">
        ${iconContent}
        <span class="server-status-dot ${statusClass}"></span>
        ${window.havenDesktop ? '<span class="server-unread-dot"></span>' : ''}
        <button class="server-remove" title="${t('servers.remove')}">&times;</button>
      </div>
    `;
  }).join('');

  // CSP-safe: handle broken server icons, fall back to thumbnail or letter initial
  list.querySelectorAll('.server-icon-img').forEach(img => {
    img.addEventListener('error', () => {
      const fallbackSrc = img.dataset.fallbackSrc;
      if (fallbackSrc && img.src !== fallbackSrc) {
        img.removeAttribute('data-fallback-src');
        img.src = fallbackSrc;
        return;
      }
      img.style.display = 'none';
      const fallback = img.nextElementSibling;
      if (fallback) fallback.style.display = '';
    });
  });

  list.querySelectorAll('.server-icon.remote').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.classList.contains('server-remove')) {
        e.stopPropagation();
        const serverName = el.getAttribute('title')?.split('\n')[0] || el.dataset.url;
        this._removeServerByUser(el.dataset.url, serverName, () => {
          this._renderServerBar();
          this._showToast(t('toasts.server_removed'), 'success');
          this._pushServerListToServer();
        });
        return;
      }
      if (window.havenDesktop?.switchServer) {
        window.havenDesktop.switchServer(el.dataset.url);
      } else {
        window.open(el.dataset.url, '_blank', 'noopener');
      }
    });
    // Right-click to edit
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this._editServer(el.dataset.url);
    });
  });

  // Drag-and-drop reordering of remote server icons. Idempotent: handlers
  // live on the list container so re-rendering doesn't double-bind.
  this._setupServerBarDrag(list);

  // Also update mobile sidebar server bubbles
  this._renderMobileSidebarServers();

  // After re-rendering the bar, the set of known server URLs may have
  // changed, so tell main so it can drop phantom taskbar badges from
  // background views the user no longer has an icon for. (#5269)
  this._reportKnownServerUrls();

  // Re-apply cached badge dots. _renderServerBar wipes innerHTML so any
  // previously lit dots are destroyed. Reapply immediately from the last
  // known badge state so dots don't vanish until the next IPC event. (#5300)
  if (this._lastServerBadges) this._updateServerBadgeDots(this._lastServerBadges);
},

};
