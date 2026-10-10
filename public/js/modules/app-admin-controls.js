// Server Admin controls in Settings: kick, mute, ban and delete-user
// confirmations, bans, banned IPs, deleted users, the member list, cleanup,
// backups and restore, server updates, sign-ups, auto-mod,
// tunnel, the server invite code, registration token, default and guest
// channels, invite links, and the voice connectivity test.

export default {

_bindAdminModeration() {
  // ── Admin moderation bindings ───────────────────────
  document.getElementById('cancel-admin-action-btn').addEventListener('click', () => {
    document.getElementById('admin-action-modal').style.display = 'none';
  });

  document.getElementById('admin-action-modal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) e.currentTarget.style.display = 'none';
  });

  document.getElementById('confirm-admin-action-btn').addEventListener('click', async () => {
    if (!this.adminActionTarget) return;
    const { action, userId, username } = this.adminActionTarget;
    const reason = document.getElementById('admin-action-reason').value.trim();
    const duration = parseInt(document.getElementById('admin-action-duration').value) || 10;
    const scrubMessages = document.getElementById('admin-scrub-checkbox').checked;
    const scrubScope = document.getElementById('admin-scrub-scope').value;

    if (action === 'kick') {
      this.socket.emit('kick-user', { userId, reason, scrubMessages, scrubScope });
    } else if (action === 'ban') {
      const purgeCheckbox = document.getElementById('admin-purge-checkbox');
      const purgeInput = document.getElementById('admin-purge-message');
      const purgeMessages = !!(purgeCheckbox && purgeCheckbox.checked);
      const purgeMessage = purgeInput ? purgeInput.value.trim() : '';
      const banIpCheckbox = document.getElementById('admin-ban-ip-checkbox');
      const banIp = !!(banIpCheckbox && banIpCheckbox.checked);
      this.socket.emit('ban-user', { userId, reason, scrubMessages, purgeMessages, purgeMessage, banIp });
    } else if (action === 'mute') {
      this.socket.emit('mute-user', { userId, reason, duration });
    } else if (action === 'delete-user') {
      const ok = await this._showConfirmModal(t('confirm.delete_user', { username }), '', { danger: true });
      if (!ok) return;
      this.socket.emit('delete-user', { userId, reason, scrubMessages });
    }

    document.getElementById('admin-action-modal').style.display = 'none';
    this.adminActionTarget = null;
  });
},

_bindAdminControls() {
  // Member visibility select (admin), saved via admin Save button

  // View bans button
  document.getElementById('view-bans-btn').addEventListener('click', () => {
    this.socket.emit('get-bans');
    document.getElementById('bans-modal').style.display = 'flex';
  });

  document.getElementById('close-bans-btn').addEventListener('click', () => {
    document.getElementById('bans-modal').style.display = 'none';
  });

  document.getElementById('bans-modal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) e.currentTarget.style.display = 'none';
  });

  // ── Banned IPs modal (v3.20.0) ─────────────────────
  const viewIpBansBtn = document.getElementById('view-ip-bans-btn');
  if (viewIpBansBtn) {
    viewIpBansBtn.addEventListener('click', () => {
      this.socket.emit('get-ip-bans');
      document.getElementById('ip-bans-modal').style.display = 'flex';
    });
  }
  const closeIpBansBtn = document.getElementById('close-ip-bans-btn');
  if (closeIpBansBtn) {
    closeIpBansBtn.addEventListener('click', () => {
      document.getElementById('ip-bans-modal').style.display = 'none';
    });
  }
  const ipBansModal = document.getElementById('ip-bans-modal');
  if (ipBansModal) {
    ipBansModal.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) e.currentTarget.style.display = 'none';
    });
  }
  const ipBanAddBtn = document.getElementById('ip-ban-add-btn');
  if (ipBanAddBtn) {
    ipBanAddBtn.addEventListener('click', () => {
      const ipEl = document.getElementById('ip-ban-input');
      const reasonEl = document.getElementById('ip-ban-reason-input');
      const ip = (ipEl && ipEl.value || '').trim();
      const reason = (reasonEl && reasonEl.value || '').trim();
      if (!ip) return;
      this.socket.emit('ban-ip', { ip, reason });
      if (ipEl) ipEl.value = '';
      if (reasonEl) reasonEl.value = '';
      // Server refreshes the list after unban; for direct ban, refresh manually.
      setTimeout(() => this.socket.emit('get-ip-bans'), 150);
    });
  }

  // View deleted users button
  document.getElementById('view-deleted-users-btn').addEventListener('click', () => {
    this.socket.emit('get-deleted-users');
    document.getElementById('deleted-users-modal').style.display = 'flex';
  });

  document.getElementById('close-deleted-users-btn').addEventListener('click', () => {
    document.getElementById('deleted-users-modal').style.display = 'none';
  });

  document.getElementById('deleted-users-modal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) e.currentTarget.style.display = 'none';
  });

  // View all members buttons (sidebar + admin settings)
  document.getElementById('sidebar-members-btn').addEventListener('click', () => {
    this._openAllMembersModal();
  });
  document.getElementById('view-all-members-btn').addEventListener('click', () => {
    this._openAllMembersModal();
  });
  document.getElementById('close-all-members-btn').addEventListener('click', () => {
    document.getElementById('all-members-modal').style.display = 'none';
  });
  document.getElementById('all-members-modal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) e.currentTarget.style.display = 'none';
  });
  document.getElementById('all-members-search').addEventListener('input', () => this._filterAllMembers());
  document.getElementById('all-members-filter').addEventListener('change', () => this._filterAllMembers());

  // Members-list shortcuts to bans / deleted users (visibility gated by perms in
  // _openAllMembersModal; server handlers re-check permissions on emit).
  document.getElementById('aml-view-bans-btn')?.addEventListener('click', () => {
    document.getElementById('all-members-modal').style.display = 'none';
    this.socket.emit('get-bans');
    document.getElementById('bans-modal').style.display = 'flex';
  });
  document.getElementById('aml-view-deleted-btn')?.addEventListener('click', () => {
    document.getElementById('all-members-modal').style.display = 'none';
    this.socket.emit('get-deleted-users');
    document.getElementById('deleted-users-modal').style.display = 'flex';
  });
  document.getElementById('aml-bulk-cleanup-btn')?.addEventListener('click', () => {
    if (this._openBulkCleanup) this._openBulkCleanup();
  });

  // ── Cleanup controls (admin), saved via admin Save button ──
  const cleanupAge = document.getElementById('cleanup-max-age');
  if (cleanupAge) {
    cleanupAge.addEventListener('change', () => {
      const val = Math.max(0, Math.min(3650, parseInt(cleanupAge.value) || 0));
      cleanupAge.value = val;
    });
  }
  const cleanupSize = document.getElementById('cleanup-max-size');
  if (cleanupSize) {
    cleanupSize.addEventListener('change', () => {
      const val = Math.max(0, Math.min(100000, parseInt(cleanupSize.value) || 0));
      cleanupSize.value = val;
    });
  }
  const cleanupUploads = document.getElementById('cleanup-max-uploads');
  if (cleanupUploads) {
    cleanupUploads.addEventListener('change', () => {
      cleanupUploads.value = Math.max(0, Math.min(10000000, parseInt(cleanupUploads.value) || 0));
    });
  }

  const runCleanupBtn = document.getElementById('run-cleanup-now-btn');
  if (runCleanupBtn) {
    runCleanupBtn.addEventListener('click', () => {
      this.socket.emit('run-cleanup-now');
      this._showToast(t('toasts.cleanup_triggered'), 'success');
    });
  }

  // ── Server backup / restore (admin) ──────────────────
  const startBackupDownload = (include) => {
    const token = localStorage.getItem('haven_token');
    if (!token) return this._showToast(t('toasts.not_logged_in'), 'error');
    const url = `/api/admin/backup?include=${encodeURIComponent(include)}&token=${encodeURIComponent(token)}`;
    const a = document.createElement('a');
    a.href = url;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => a.remove(), 1000);
    this._showToast(t('toasts.backup_started'), 'info');
  };
  const getBackupIncludes = () => {
    return Array.from(document.querySelectorAll('.backup-include:checked')).map(el => el.value);
  };
  document.getElementById('backup-download-btn')?.addEventListener('click', () => {
    const includes = getBackupIncludes();
    if (!includes.length) {
      return this._showToast(t('toasts.backup_pick_one'), 'error');
    }
    const heavy = includes.includes('messages') || includes.includes('files');
    if (heavy && !confirm(t('confirm.backup_heavy'))) return;
    startBackupDownload(includes.join(','));
  });
  document.getElementById('backup-select-all-btn')?.addEventListener('click', () => {
    document.querySelectorAll('.backup-include').forEach(el => { el.checked = true; });
  });
  document.getElementById('backup-select-none-btn')?.addEventListener('click', () => {
    document.querySelectorAll('.backup-include').forEach(el => { el.checked = false; });
  });

  const restoreBtn = document.getElementById('backup-restore-btn');
  if (restoreBtn) {
    const progWrap  = document.getElementById('restore-progress');
    const progFill  = document.getElementById('restore-progress-fill');
    const progLabel = document.getElementById('restore-progress-label');
    const fmtBytesR = (n) => {
      if (n < 1024) return n + ' B';
      if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
      if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
      return (n / 1073741824).toFixed(2) + ' GB';
    };
    const setBar = (pct, indeterminate) => {
      if (progWrap) progWrap.classList.toggle('indeterminate', !!indeterminate);
      if (progFill) progFill.style.width = indeterminate ? '40%' : Math.max(0, Math.min(100, pct)) + '%';
    };

    restoreBtn.addEventListener('click', async () => {
      const fileInput = document.getElementById('backup-restore-file');
      const file = fileInput?.files?.[0];
      if (!file) return this._showToast(t('toasts.backup_no_file'), 'error');
      if (!confirm(t('confirm.backup_restore'))) return;
      const token = localStorage.getItem('haven_token');
      if (!token) return this._showToast(t('toasts.not_logged_in'), 'error');

      restoreBtn.disabled = true;
      const origText = restoreBtn.innerHTML;

      // The server streams the uploaded zip to disk after the upload lands and
      // emits `restore-progress` over the socket so we can show a real
      // extraction bar instead of an opaque wait on large backups (#5438).
      const onExtractProgress = (p) => {
        if (!p || p.phase !== 'extract') return;
        if (p.bytesTotal) {
          const pct = Math.round((p.bytesDone / p.bytesTotal) * 100);
          setBar(pct, false);
          if (progLabel) progLabel.textContent = t('settings.admin.restore_extract_progress', { pct, done: fmtBytesR(p.bytesDone), total: fmtBytesR(p.bytesTotal) });
        } else {
          setBar(0, true);
          if (progLabel) progLabel.textContent = t('settings.admin.restore_extracting');
        }
      };
      this.socket?.on('restore-progress', onExtractProgress);
      const cleanup = () => { this.socket?.off('restore-progress', onExtractProgress); };

      if (progWrap) progWrap.style.display = 'block';
      setBar(0, false);
      if (progLabel) progLabel.textContent = t('settings.admin.restore_upload_progress', { pct: 0 });
      restoreBtn.innerHTML = `⏳ ${t('settings.admin.restore_uploading')}`;

      try {
        const data = await new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('POST', '/api/admin/restore');
          xhr.setRequestHeader('Authorization', `Bearer ${token}`);
          xhr.timeout = 0; // multi-GB uploads can run for many minutes
          xhr.upload.onprogress = (e) => {
            if (!e.lengthComputable) return;
            const pct = Math.round((e.loaded / e.total) * 100);
            setBar(pct, false);
            if (progLabel) progLabel.textContent = t('settings.admin.restore_upload_progress_bytes', { pct, done: fmtBytesR(e.loaded), total: fmtBytesR(e.total) });
          };
          xhr.upload.onload = () => {
            // Upload finished: server now stages the zip to disk. Flip to the
            // extraction phase; socket events refine this if/when they arrive.
            setBar(0, true);
            if (progLabel) progLabel.textContent = t('settings.admin.restore_upload_complete');
            restoreBtn.innerHTML = `⏳ ${t('settings.admin.restore_extracting_short')}`;
          };
          xhr.onload = () => {
            let d = {};
            try { d = JSON.parse(xhr.responseText); } catch { /* no JSON body: the status code below decides */ }
            if (xhr.status >= 200 && xhr.status < 300) resolve(d);
            else reject(new Error(d.error || `HTTP ${xhr.status}`));
          };
          xhr.onerror = () => reject(new Error(t('settings.admin.restore_network_error')));
          xhr.ontimeout = () => reject(new Error(t('settings.admin.restore_upload_timeout')));
          const fd = new FormData();
          fd.append('backup', file);
          xhr.send(fd);
        });
        cleanup();
        setBar(100, false);
        if (progLabel) progLabel.textContent = t('settings.admin.restore_done');
        this._showToast(data.message || t('settings.admin.restore_staged'), 'success');
        restoreBtn.innerHTML = `✓ ${t('settings.admin.restore_restarting')}`;
      } catch (err) {
        cleanup();
        if (progWrap) progWrap.style.display = 'none';
        this._showToast(t('toasts.backup_restore_failed') + err.message, 'error');
        restoreBtn.disabled = false;
        restoreBtn.innerHTML = origText;
      }
    });
  }

  // ── Auto-backup admin controls ─────────────────────
  const fmtBytes = (n) => {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
    return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  };
  this._refreshAutoBackupList = async () => {
    const listEl = document.getElementById('auto-backup-list');
    if (!listEl) return;
    const token = localStorage.getItem('haven_token');
    if (!token) return;
    try {
      const res = await fetch('/api/admin/auto-backups', { headers: { 'Authorization': `Bearer ${token}` } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const files = data.files || [];
      if (!files.length) {
        listEl.innerHTML = `<small class="settings-hint">${t('settings.admin.auto_backup_none')}</small>`;
        return;
      }
      listEl.innerHTML = files.map(f => {
        const safeName = f.name.replace(/[<>"&]/g, c => ({ '<': '&lt;', '>': '&gt;', '"': '&quot;', '&': '&amp;' }[c]));
        const when = this._fmtDateTime(f.mtime);
        return `<div style="display:flex;gap:6px;align-items:center;justify-content:space-between;border:1px solid var(--border);padding:6px 8px;border-radius:4px">
          <div style="min-width:0;flex:1">
            <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:monospace;font-size:0.85em">${safeName}</div>
            <small class="settings-hint">${when} · ${fmtBytes(f.size)}</small>
          </div>
          <div style="display:flex;gap:4px;flex-shrink:0">
            <button class="btn-sm auto-backup-dl-btn" data-name="${safeName}">⬇️</button>
            <button class="btn-sm auto-backup-del-btn" data-name="${safeName}" title="${t('msg_toolbar.delete')}">🗑️</button>
          </div>
        </div>`;
      }).join('');
      listEl.querySelectorAll('.auto-backup-dl-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const name = btn.dataset.name;
          const url = `/api/admin/auto-backups/${encodeURIComponent(name)}?token=${encodeURIComponent(token)}`;
          const a = document.createElement('a');
          a.href = url; a.download = name; a.style.display = 'none';
          document.body.appendChild(a); a.click(); setTimeout(() => a.remove(), 1000);
        });
      });
      listEl.querySelectorAll('.auto-backup-del-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const name = btn.dataset.name;
          if (!confirm(t('settings.admin.auto_backup_delete_confirm', { name }))) return;
          const r = await fetch(`/api/admin/auto-backups/${encodeURIComponent(name)}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` },
          });
          if (r.ok) this._refreshAutoBackupList();
          else this._showToast(t('settings.admin.auto_backup_delete_failed'), 'error');
        });
      });
    } catch (err) {
      listEl.innerHTML = `<small class="settings-hint" style="color:var(--danger)">${t('settings.admin.auto_backup_load_failed', { error: err.message })}</small>`;
    }
  };
  document.getElementById('auto-backup-save-btn')?.addEventListener('click', () => {
    const enabled = document.getElementById('auto-backup-enabled')?.checked ? 'true' : 'false';
    const interval = document.getElementById('auto-backup-interval')?.value || '24';
    const retention = document.getElementById('auto-backup-retention')?.value || '7';
    const sections = Array.from(document.querySelectorAll('.auto-backup-include:checked')).map(el => el.value);
    if (enabled === 'true' && !sections.length) {
      return this._showToast(t('toasts.backup_pick_one'), 'error');
    }
    this.socket.emit('update-server-setting', { key: 'auto_backup_enabled', value: enabled });
    this.socket.emit('update-server-setting', { key: 'auto_backup_interval_hours', value: String(interval) });
    this.socket.emit('update-server-setting', { key: 'auto_backup_retention', value: String(retention) });
    this.socket.emit('update-server-setting', { key: 'auto_backup_sections', value: sections.join(',') });
    this._showToast(t('settings.admin.auto_backup_saved'), 'success');
  });
  document.getElementById('auto-backup-run-now-btn')?.addEventListener('click', async () => {
    const token = localStorage.getItem('haven_token');
    if (!token) return;
    try {
      const r = await fetch('/api/admin/auto-backups/run-now', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      this._showToast(t('settings.admin.auto_backup_triggered'), 'info');
      setTimeout(() => this._refreshAutoBackupList(), 3000);
    } catch (err) {
      this._showToast(t('settings.admin.auto_backup_run_failed', { error: err.message }), 'error');
    }
  });
  document.getElementById('auto-backup-refresh-btn')?.addEventListener('click', () => this._refreshAutoBackupList());

  // ── In-app update controls ─────────────────────────
  let lastUpdateCheck = null;
  const updStatusEl = () => document.getElementById('update-status');
  const updRunBtn = () => document.getElementById('update-run-btn');
  document.getElementById('update-check-btn')?.addEventListener('click', async () => {
    const token = localStorage.getItem('haven_token');
    if (!token) return;
    const status = updStatusEl();
    if (status) { status.style.display = 'block'; status.textContent = t('settings.admin.update_checking'); }
    try {
      const r = await fetch('/api/admin/update/check', { headers: { 'Authorization': `Bearer ${token}` } });
      const data = await r.json();
      lastUpdateCheck = data;
      if (status) {
        const upToDate = !data.updateAvailable;
        const esc = s => String(s || '').replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
        const cmdBlock = (!data.runnable && data.command) ? `
          <div style="margin-top:8px">
            <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px"><strong>${t('settings.admin.update_run_on_host')}</strong>
              <button type="button" class="btn-sm" id="update-copy-cmd-btn" title="${t('settings.admin.update_copy_command')}">📋 ${t('common.copy')}</button>
            </div>
            <pre style="background:var(--bg-input);border:1px solid var(--border);border-radius:4px;padding:6px 8px;margin:0;white-space:pre-wrap;word-break:break-all"><code>${esc(data.command)}</code></pre>
          </div>` : '';
        status.innerHTML = `
          <div><strong>${t('settings.admin.update_installed')}</strong> v${esc(data.currentVersion)}</div>
          <div><strong>${t('settings.admin.update_latest')}</strong> ${data.latestVersion ? 'v' + esc(data.latestVersion) : t('settings.admin.update_unknown')}</div>
          <div><strong>${t('settings.admin.update_install_method')}</strong> ${esc(data.method)}</div>
          <div style="margin-top:6px">${upToDate ? t('settings.admin.update_current') : t('settings.admin.update_available')}</div>
          <div style="margin-top:6px"><small>${esc(data.message || '')}</small></div>
          ${cmdBlock}
          ${data.releaseUrl ? `<div style="margin-top:6px"><a href="${esc(data.releaseUrl)}" target="_blank" rel="noopener">${t('settings.admin.update_release_notes')} →</a></div>` : ''}
        `;
        const copyBtn = document.getElementById('update-copy-cmd-btn');
        if (copyBtn) copyBtn.addEventListener('click', () => {
          try {
            navigator.clipboard.writeText(data.command).then(() => {
              copyBtn.textContent = `✅ ${t('common.copied')}`;
              setTimeout(() => { copyBtn.textContent = `📋 ${t('common.copy')}`; }, 1500);
            }).catch(() => { /* clipboard refused: the button keeps saying Copy and the command stays selectable */ });
          } catch { /* no clipboard API (plain http): the command stays selectable */ }
        });
      }
      // Keep the Update Now button enabled even when the install method
      // isn't auto-runnable (Docker, manual). Click handler will surface
      // the right manual command instead of failing silently. (#5267)
      if (updRunBtn()) updRunBtn().disabled = !data.updateAvailable;
    } catch (err) {
      if (status) status.textContent = t('settings.admin.update_check_failed', { error: err.message });
    }
  });
  document.getElementById('update-run-btn')?.addEventListener('click', async () => {
    const status = updStatusEl();
    // If the user clicks Run before clicking Check, do the check first so
    // we always have a fresh `lastUpdateCheck` to act on. (#5267)
    if (!lastUpdateCheck) {
      document.getElementById('update-check-btn')?.click();
      if (status) {
        if (status.style) status.style.display = 'block';
        status.textContent = t('settings.admin.update_check_first');
      }
      return;
    }
    if (!lastUpdateCheck.updateAvailable) {
      if (status) {
        if (status.style) status.style.display = 'block';
        status.textContent = t('settings.admin.update_nothing_to_install');
      }
      return;
    }
    if (!lastUpdateCheck.runnable) {
      // Most common case: Docker install. Re-run check to surface the
      // copyable command block instead of silently doing nothing.
      document.getElementById('update-check-btn')?.click();
      this._showToast?.(lastUpdateCheck.message || t('settings.admin.update_not_supported', { method: lastUpdateCheck.method }), 'info');
      return;
    }
    if (!confirm(t('settings.admin.update_confirm', { version: lastUpdateCheck.latestVersion }))) return;
    const token = localStorage.getItem('haven_token');
    if (!token) return;
    // Visible status before the fetch so admins always see *something*
    // happen on click. This helps diagnose cases where the request fails
    // silently or the host blocks the request. (#5267)
    if (status) {
      if (status.style) status.style.display = 'block';
      status.textContent = t('settings.admin.update_sending');
    }
    try {
      const r = await fetch('/api/admin/update/run', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      if (status) status.innerHTML = `<div>${t('settings.admin.update_started')}</div><div style="margin-top:6px"><small>${data.message || ''}</small></div>`;
      if (updRunBtn()) updRunBtn().disabled = true;
    } catch (err) {
      if (status) status.textContent = t('settings.admin.update_failed', { error: err.message });
    }
  });

  // ── Whitelist controls (admin) ───────────────────────
  // Whitelist toggle, saved via admin Save button

  document.getElementById('whitelist-add-btn').addEventListener('click', () => {
    const input = document.getElementById('whitelist-username-input');
    const username = input.value.trim();
    if (!username) return;
    this.socket.emit('whitelist-add', { username });
    input.value = '';
  });

  document.getElementById('whitelist-username-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('whitelist-add-btn').click();
  });

  // Listen for whitelist list updates
  this.socket.on('whitelist-list', (list) => {
    this._renderWhitelist(list);
  });

  // ── Auto-Mod panel (v3.42.0) ─────────────────────────────
  // Wired here alongside the other admin-settings controls. Its settings
  // apply immediately rather than through the Save flow, matching how the
  // whitelist and tunnel controls already behave.
  if (typeof this._initAutomodPanel === 'function') {
    this._initAutomodPanel();
    this.socket.emit('get-automod-domains');
    this.socket.emit('get-automod-log', { limit: 100 });
  }

  // ── Tunnel settings (immediate, not part of Save flow) ──
  const tunnelToggleBtn = document.getElementById('tunnel-toggle-btn');
  if (tunnelToggleBtn) {
    tunnelToggleBtn.addEventListener('click', () => {
      // Determine desired state from button text
      const wantStart = tunnelToggleBtn.textContent.trim().startsWith('Start');
      this.socket.emit('update-server-setting', {
        key: 'tunnel_enabled',
        value: wantStart ? 'true' : 'false'
      });
      this._syncTunnelState(wantStart);
    });
  }

  const tunnelProvEl = document.getElementById('tunnel-provider-select');
  if (tunnelProvEl) {
    tunnelProvEl.addEventListener('change', () => {
      this.socket.emit('update-server-setting', {
        key: 'tunnel_provider',
        value: tunnelProvEl.value
      });
    });
  }

  // ── Server invite code (immediate, not part of Save flow) ──
  document.getElementById('generate-server-code-btn')?.addEventListener('click', () => {
    this.socket.emit('generate-server-code');
  });
  document.getElementById('clear-server-code-btn')?.addEventListener('click', () => {
    if (!confirm(t('confirm.clear_invite_code'))) return;
    this.socket.emit('clear-server-code');
  });
  document.getElementById('copy-server-code-btn')?.addEventListener('click', () => {
    const code = document.getElementById('server-code-value')?.textContent;
    if (code && code !== '-') {
      const onCopied = () => this._showToast(t('toasts.server_code_copied'), 'success');
      navigator.clipboard.writeText(code).then(onCopied).catch(() => {
        try {
          const ta = document.createElement('textarea');
          ta.value = code;
          ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
          document.body.appendChild(ta);
          ta.focus(); ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
          onCopied();
        } catch { /* could not copy */ }
      });
    }
  });

  // ── Registration token (#5344), independent of whitelist ──
  document.getElementById('registration-token-enabled')?.addEventListener('change', (e) => {
    this.socket.emit('update-server-setting', {
      key: 'registration_token_enabled',
      value: e.target.checked ? 'true' : 'false'
    });
  });
  document.getElementById('invites-bypass-registration-token')?.addEventListener('change', (e) => {
    this.socket.emit('update-server-setting', {
      key: 'invites_bypass_registration_token',
      value: e.target.checked ? 'true' : 'false'
    });
  });
  document.getElementById('test-connectivity-btn')?.addEventListener('click', () => {
    this._runConnectivityTest();
  });
  document.getElementById('generate-registration-token-btn')?.addEventListener('click', () => {
    this.socket.emit('generate-registration-token');
  });
  document.getElementById('clear-registration-token-btn')?.addEventListener('click', () => {
    if (!confirm(t('settings.admin.registration.clear_confirm'))) return;
    this.socket.emit('clear-registration-token');
  });
  document.getElementById('copy-registration-token-btn')?.addEventListener('click', async () => {
    const tok = document.getElementById('registration-token-value')?.textContent?.trim();
    if (!tok || tok === '-') return;
    const onCopied = () => this._showToast?.(t('settings.admin.registration.copied'), 'success');
    // The old handler toasted "copied" from the rejection path too, so in the
    // desktop app (clipboard write refused without a fresh user activation)
    // the toast lied while the clipboard kept its previous contents.
    try {
      const res = await window.havenDesktop?.clipboardWriteText?.(tok);
      if (res?.ok) return onCopied();
    } catch { /* desktop bridge refused: try the browser clipboard next */ }
    try {
      if (!navigator.clipboard?.writeText) throw new Error('no clipboard api');
      await navigator.clipboard.writeText(tok);
      return onCopied();
    } catch {
      let ok = false;
      this._copyTextFallback(tok, () => { ok = true; onCopied(); });
      if (!ok) this._showToast?.(t('settings.admin.registration.copy_failed'), 'error');
    }
  });

  // ── Default join channels (#5345) ──────────────────
  const _renderDefaultJoinChannels = () => {
    const host = document.getElementById('default-join-channels-list');
    if (!host) return;
    const all = (this.channels || []).filter(c =>
      !c.is_dm && !c.parent_channel_id &&
      !c.is_private && c.code_visibility !== 'private'
    );
    if (all.length === 0) {
      host.innerHTML = `<p class="muted-text" style="margin:4px 0;font-size:0.85rem">${t('settings.admin.invite_links.no_public_channels')}</p>`;
      return;
    }
    let selected = null; // null = "all"
    try {
      const raw = this.serverSettings?.default_join_channels;
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) selected = new Set(parsed.map(n => parseInt(n)));
      }
    } catch { /* fall back to all */ }
    host.innerHTML = all.map(ch => {
      const checked = (selected === null) || selected.has(ch.id);
      return `<label style="display:flex;align-items:center;gap:6px;padding:3px 4px;font-size:0.85rem">
        <input type="checkbox" class="default-join-channel-cb" data-cid="${ch.id}" ${checked ? 'checked' : ''}>
        <span>#${this._escapeHtml(ch.name || '')}</span>
      </label>`;
    }).join('');
  };
  this._renderDefaultJoinChannels = _renderDefaultJoinChannels;
  document.getElementById('default-join-channels-all-btn')?.addEventListener('click', () => {
    document.querySelectorAll('.default-join-channel-cb').forEach(cb => { cb.checked = true; });
  });
  document.getElementById('default-join-channels-none-btn')?.addEventListener('click', () => {
    document.querySelectorAll('.default-join-channel-cb').forEach(cb => { cb.checked = false; });
  });
  document.getElementById('default-join-channels-save-btn')?.addEventListener('click', () => {
    const cbs = Array.from(document.querySelectorAll('.default-join-channel-cb'));
    const total = cbs.length;
    const picked = cbs.filter(cb => cb.checked).map(cb => parseInt(cb.dataset.cid)).filter(Number.isFinite);
    // "All checked" → store empty string so the default ("all public") logic kicks in
    const value = (picked.length === total) ? '' : JSON.stringify(picked);
    this.socket.emit('update-server-setting', { key: 'default_join_channels', value });
    this._showToast?.(picked.length === total
      ? t('settings.admin.default_join.all')
      : t(picked.length === 1 ? 'settings.admin.default_join.one' : 'settings.admin.default_join.other', { count: picked.length }),
      'success');
  });

  // ── Guest channel whitelist (#5381) ────────────────
  const _renderGuestChannels = () => {
    const host = document.getElementById('guest-channels-list');
    if (!host) return;
    const chans = (this.channels || []).filter(c => !c.is_dm);
    if (chans.length === 0) {
      host.innerHTML = `<p class="muted-text" style="margin:4px 0;font-size:0.85rem">${t('settings.admin.invite_links.no_channels')}</p>`;
      return;
    }
    // CSV of channel ids. Empty string = no channels (guests can log in but have nowhere to go).
    // (#5401) Sub-channels and voice rooms are listed individually so admins
    // grant guests exactly the channels they intend, no implicit cascade.
    const raw = this.serverSettings?.guest_channels || '';
    const selected = new Set(
      raw.split(',').map(s => s.trim()).filter(Boolean).map(s => parseInt(s)).filter(Number.isFinite)
    );

    const parents = chans.filter(c => !c.parent_channel_id)
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || String(a.name || '').localeCompare(String(b.name || '')));
    const subsByParent = new Map();
    chans.filter(c => c.parent_channel_id).forEach(c => {
      if (!subsByParent.has(c.parent_channel_id)) subsByParent.set(c.parent_channel_id, []);
      subsByParent.get(c.parent_channel_id).push(c);
    });
    for (const list of subsByParent.values()) {
      list.sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || String(a.name || '').localeCompare(String(b.name || '')));
    }

    const tagsFor = (ch) => {
      const tags = [];
      if (ch.is_private || ch.code_visibility === 'private') tags.push(t('settings.admin.guest_access.private'));
      if (ch.text_enabled === 0 && ch.voice_enabled) tags.push(t('settings.admin.guest_access.voice'));
      return tags.length
        ? ` <small style="color:var(--text-muted)">(${tags.join(', ')})</small>` : '';
    };
    const row = (ch, isSub) => {
      const checked = selected.has(ch.id);
      const prefix = isSub ? '↳ ' : '#';
      const parentAttr = isSub ? ` data-parent="${ch.parent_channel_id}"` : '';
      return `<label style="display:flex;align-items:center;gap:6px;padding:3px 4px;font-size:0.85rem${isSub ? ';margin-left:18px' : ''}">
        <input type="checkbox" class="guest-channel-cb" data-cid="${ch.id}"${parentAttr} ${checked ? 'checked' : ''}>
        <span>${prefix}${this._escapeHtml(ch.name || '')}${tagsFor(ch)}</span>
      </label>`;
    };

    let html = '';
    for (const p of parents) {
      html += row(p, false);
      for (const sub of (subsByParent.get(p.id) || [])) html += row(sub, true);
    }
    host.innerHTML = html;
    const toggle = document.getElementById('guests-enabled');
    if (toggle) toggle.checked = (this.serverSettings?.guests_enabled === 'true');
    const voiceToggle = document.getElementById('guests-allow-voice');
    if (voiceToggle) voiceToggle.checked = (this.serverSettings?.guests_allow_voice !== 'false');
  };
  this._renderGuestChannels = _renderGuestChannels;
  document.getElementById('guests-enabled')?.addEventListener('change', (e) => {
    this.socket.emit('update-server-setting', { key: 'guests_enabled', value: e.target.checked ? 'true' : 'false' });
    this._showToast?.(t(e.target.checked ? 'settings.admin.guest_access.enabled' : 'settings.admin.guest_access.disabled'), 'success');
  });
  document.getElementById('guests-allow-voice')?.addEventListener('change', (e) => {
    this.socket.emit('update-server-setting', { key: 'guests_allow_voice', value: e.target.checked ? 'true' : 'false' });
    this._showToast?.(t(e.target.checked ? 'settings.admin.guest_access.voice_on' : 'settings.admin.guest_access.voice_off'), 'success');
  });
  document.getElementById('guest-channels-all-btn')?.addEventListener('click', () => {
    document.querySelectorAll('.guest-channel-cb').forEach(cb => { cb.checked = true; });
  });
  document.getElementById('guest-channels-none-btn')?.addEventListener('click', () => {
    document.querySelectorAll('.guest-channel-cb').forEach(cb => { cb.checked = false; });
  });
  // A sub-channel only appears in the sidebar nested under its parent, so a
  // guest needs the parent too. Keep the checkboxes consistent: ticking a sub
  // ticks its parent; unticking a parent unticks its sub-channels. (#5401)
  document.getElementById('guest-channels-list')?.addEventListener('change', (e) => {
    const cb = e.target.closest?.('.guest-channel-cb');
    if (!cb) return;
    if (cb.checked && cb.dataset.parent) {
      const parent = document.querySelector(`.guest-channel-cb[data-cid="${cb.dataset.parent}"]`);
      if (parent) parent.checked = true;
    }
    if (!cb.checked && !cb.dataset.parent) {
      document.querySelectorAll(`.guest-channel-cb[data-parent="${cb.dataset.cid}"]`)
        .forEach(sub => { sub.checked = false; });
    }
  });
  document.getElementById('guest-channels-save-btn')?.addEventListener('click', () => {
    const cbs = Array.from(document.querySelectorAll('.guest-channel-cb'));
    const picked = cbs.filter(cb => cb.checked).map(cb => parseInt(cb.dataset.cid)).filter(Number.isFinite);
    const value = picked.join(',');
    this.socket.emit('update-server-setting', { key: 'guest_channels', value });
    this._showToast?.(picked.length === 0
      ? t('settings.admin.guest_access.zero')
      : t(picked.length === 1 ? 'settings.admin.guest_access.one' : 'settings.admin.guest_access.other', { count: picked.length }),
      'success');
  });

  // ── Managed invite links (multi-code menu) ─────────
  const _invitePublicChannels = () => (this.channels || []).filter(c =>
    !c.is_dm && !c.parent_channel_id && !c.is_private && c.code_visibility !== 'private');

  // Build a list of public-channel checkboxes. selectedSet === null → all checked
  // ("grant all public"); otherwise only the ids in the set are checked.
  const _inviteChannelChecks = (cls, selectedSet) => {
    const all = _invitePublicChannels();
    if (!all.length) return `<p class="muted-text" style="margin:4px 0;font-size:0.85rem">${t('settings.admin.invite_links.no_public_channels')}</p>`;
    return all.map(ch => {
      const checked = (selectedSet === null) || selectedSet.has(ch.id);
      return `<label style="display:flex;align-items:center;gap:6px;padding:3px 4px;font-size:0.85rem">
        <input type="checkbox" class="${cls}" data-cid="${ch.id}" ${checked ? 'checked' : ''}>
        <span>#${this._escapeHtml(ch.name || '')}</span></label>`;
    }).join('');
  };

  const _renderInviteCreateChannels = (force) => {
    const host = document.getElementById('invite-new-channels');
    if (!host) return;
    // Don't clobber an in-progress selection on routine settings refreshes.
    if (!force && host.querySelector('.invite-new-channel-cb')) return;
    host.innerHTML = _inviteChannelChecks('invite-new-channel-cb', null);
  };
  this._renderInviteCreateChannels = _renderInviteCreateChannels;

  const _renderInviteCodes = (list) => {
    this._inviteCodes = Array.isArray(list) ? list : [];
    const countEl = document.getElementById('invite-links-count');
    if (countEl) {
      const active = this._inviteCodes.filter(c => c.enabled && !c.is_expired).length;
      countEl.textContent = this._inviteCodes.length ? t('settings.admin.invite_links.count', { active, total: this._inviteCodes.length }) : '';
    }
    const host = document.getElementById('invite-codes-list');
    if (!host) return;
    if (!this._inviteCodes.length) {
      host.innerHTML = `<p class="muted-text" style="margin:4px 0;font-size:0.85rem">${t('settings.admin.invite_links.none')}</p>`;
      return;
    }
    // determine invite usage input limits
    const parsedMaxInvtUses = parseInt(this.serverSettings?.max_invite_uses, 10);
    const maxInvtUses = Number.isNaN(parsedMaxInvtUses) ? 0 : parsedMaxInvtUses;
    const restrictUses = !this.user?.isAdmin && !this._hasPerm('manage_server') && maxInvtUses > 0;
    const maxUsesInput = restrictUses ? maxInvtUses : 100000;
    const minUsesInput = restrictUses ? 1 : 0;

    // Invite links are for other people, so they carry the server's public
    // address. Opened on the server machine itself, the page's own address
    // is localhost, which only works there.
    const origin = this._shareOrigin();
    if (this._shareOriginAt === undefined) {
      this._fetchShareOrigin().then(() => _renderInviteCodes(this._inviteCodes));
    }
    const localOnly = this._shareOriginValue === null &&
      /^https?:\/\/(localhost|127\.0\.0\.1|\[?::1\]?)(:|$)/i.test(origin);
    host.innerHTML = (localOnly
      ? `<p class="settings-hint invite-local-hint" style="margin:0 0 8px">${t('settings.admin.invite_links.local_address_hint')}</p>`
      : '') + this._inviteCodes.map(ic => {
      const status = !ic.enabled
        ? `<span style="color:var(--text-muted)">● ${t('settings.admin.invite_links.disabled')}</span>`
        : ic.max_uses > 0 && ic.use_count >= ic.max_uses
          ? `<span style="color:var(--text-secondary,#9498b3)">● ${t('settings.admin.invite_links.used')}</span>`
          : ic.is_expired
            ? `<span style="color:var(--danger,#e84a4a)">● ${t('settings.admin.invite_links.expired')}</span>`
            : `<span style="color:var(--green,#43b581)">● ${t('settings.admin.invite_links.active')}</span>`;
      const link = `${origin}/?invite=${encodeURIComponent(ic.code)}`;
      const chCount = t(ic.channels.length === 1
          ? 'settings.admin.invite_links.channel_one'
          : 'settings.admin.invite_links.channel_other', { count: ic.channels.length }
      );
      const uses = ic.max_uses > 0 ? `${ic.use_count} / ${ic.max_uses}` : `${ic.use_count}`;
      const expiry = ic.expires_at ? this._fmtDateTime(ic.expires_at) : t('settings.admin.invite_links.never');
      const label = ic.label ? this._escapeHtml(ic.label) : `<em style="opacity:.6">${t('settings.admin.invite_links.no_label')}</em>`;
      const editorChannels = _inviteChannelChecks('invite-edit-channel-cb', new Set(ic.channels || []));
      return `<div class="invite-code-card" data-id="${ic.id}" style="border:1px solid var(--border);border-radius:8px;padding:10px">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
          <div style="font-weight:600">${label} &nbsp;<code style="font-size:.85rem">${this._escapeHtml(ic.code)}</code></div>
          <div style="font-size:.8rem">${status}</div>
        </div>
        <div style="display:flex;align-items:center;gap:6px;margin-top:6px">
          <input type="text" readonly value="${this._escapeHtml(link)}" class="settings-text-input" style="flex:1;min-width:0;font-size:.8rem" data-role="invite-link">
          <button class="btn-sm" data-act="copy" title="${t('settings.admin.invite_links.copy_link')}">📋</button>
        </div>
        <div style="font-size:.8rem;opacity:.8;margin-top:6px;display:flex;gap:12px;flex-wrap:wrap">
          <span>${t('settings.admin.invite_links.grants')} ${chCount}</span><span>${t('settings.admin.invite_links.uses')} ${uses}</span><span>${t('settings.admin.invite_links.expires')} ${this._escapeHtml(expiry)}</span>
        </div>
        <div style="display:flex;gap:4px;margin-top:8px;flex-wrap:wrap">
          <button class="btn-sm" data-act="toggle">${t(ic.enabled ? 'settings.admin.invite_links.disable' : 'settings.admin.invite_links.enable')}</button>
          <button class="btn-sm" data-act="edit">${t('msg_toolbar.edit')}</button>
          <button class="btn-sm" data-act="delete">${t('msg_toolbar.delete')}</button>
          <button class="btn-sm" data-act="copy_card" title="${t('settings.admin.invite_links.copy_email_card')}" style="margin-left:auto">✉️</button>
        </div>
        <div class="invite-code-editor" style="display:none;margin-top:10px;padding-top:8px;border-top:1px dashed var(--border)">
          <h6 style="margin:0 0 4px;font-size:.8rem;font-weight:600">${t('settings.admin.invite_links.channels_granted')}</h6>
          <div class="invite-edit-channels" style="max-height:160px;overflow-y:auto;border:1px solid var(--border);border-radius:6px;padding:6px">${editorChannels}</div>
          <div style="display:flex;gap:4px;margin-top:4px">
            <button class="btn-sm" data-act="edit-all">${t('settings.admin.invite_links.select_all')}</button>
            <button class="btn-sm" data-act="edit-none">${t('settings.admin.invite_links.select_none')}</button>
          </div>
          <label class="select-row" style="margin-top:8px"><span>${t('settings.admin.invite_links.max_uses')}</span><input type="number" min="${minUsesInput}" max="${maxUsesInput}" value="${ic.max_uses || 0}" class="settings-number-input" data-role="edit-maxuses"></label>
          <label class="select-row" style="margin-top:4px"><span>${t('settings.admin.invite_links.reset_expiry')}</span>
            <select class="settings-number-input" data-role="edit-expiry" style="width: 6.5rem;">
              <option value="-1" selected>${t('settings.admin.invite_links.keep_current')}</option>
              <option value="0">${t('settings.admin.invite_links.never')}</option>
              <option value="1">${t('settings.admin.invite_links.after_hour')}</option>
              <option value="24">${t('settings.admin.invite_links.after_day')}</option>
              <option value="168">${t('settings.admin.invite_links.after_7_days')}</option>
              <option value="720">${t('settings.admin.invite_links.after_30_days')}</option>
            </select>
          </label>
          <div style="display:flex;gap:4px;margin-top:8px">
            <button class="btn-sm btn-accent" data-act="save">${t('settings.admin.invite_links.save_changes')}</button>
            <button class="btn-sm" data-act="cancel">${t('modals.common.cancel')}</button>
          </div>
        </div>
      </div>`;
    }).join('');
  };
  this._renderInviteCodes = _renderInviteCodes;

  this.socket.on('invite-codes-list', (list) => { _renderInviteCodes(list); });

  // Create form: select all / none + create
  document.getElementById('invite-new-channels-all')?.addEventListener('click', () => {
    document.querySelectorAll('.invite-new-channel-cb').forEach(cb => { cb.checked = true; });
  });
  document.getElementById('invite-new-channels-none')?.addEventListener('click', () => {
    document.querySelectorAll('.invite-new-channel-cb').forEach(cb => { cb.checked = false; });
  });
  document.getElementById('invite-create-btn')?.addEventListener('click', () => {
    const label = document.getElementById('invite-new-label')?.value.trim() || '';
    const cbs = Array.from(document.querySelectorAll('.invite-new-channel-cb'));
    const total = cbs.length;
    const picked = cbs.filter(cb => cb.checked).map(cb => parseInt(cb.dataset.cid)).filter(Number.isFinite);
    // All checked → [] = "grant all public" (future-proof as new channels appear).
    const channels = picked;

    const maxUsesValue = document.getElementById('invite-new-maxuses')?.value;
    const maxUses = maxUsesValue === '' ? 1 : parseInt(maxUsesValue);

    const expiryValue = document.getElementById('invite-new-expiry')?.value;
    const expiresInHours = expiryValue === '' ? 720 : parseInt(expiryValue);

    const slug = document.getElementById('invite-new-slug')?.value.trim() || '';
    const payload = { label, channels, maxUses, expiresInHours };
    if (slug) payload.code = slug;
    this.socket.emit('create-invite-code', payload);
    // Reset the form fields (channel checks reset on the next list render).
    const lblEl = document.getElementById('invite-new-label'); if (lblEl) lblEl.value = '';
    const slugEl = document.getElementById('invite-new-slug'); if (slugEl) slugEl.value = '';
    const muEl = document.getElementById('invite-new-maxuses'); if (muEl) muEl.value = '1';
    const expEl = document.getElementById('invite-new-expiry'); if (expEl) expEl.value = '720';
  });

  // One delegated handler for all per-card actions (the list re-renders often).
  document.getElementById('invite-codes-list')?.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const card = e.target.closest('.invite-code-card');
    if (!card) return;
    const id = parseInt(card.dataset.id);
    const act = btn.dataset.act;
    const ic = (this._inviteCodes || []).find(x => x.id === id);
    if (act === 'copy') {
      const input = card.querySelector('[data-role="invite-link"]');
      const val = input?.value || '';
      if (!val) return;
      const done = () => this._showToast?.(t('settings.admin.invite_links.copied'), 'success');
      // navigator.clipboard.writeText() rejects (or fails silently in Electron's
      // BrowserView) when the document isn't focused, so fall back to selecting
      // the field and execCommand('copy'). Only toast success if a copy worked.
      const fallback = () => {
        try {
          if (input) { input.focus(); input.select(); }
          const ok = document.execCommand('copy');
          if (input) input.setSelectionRange(0, 0);
          if (ok) { done(); return; }
        } catch { /* fall through */ }
        this._showToast?.(t('settings.admin.invite_links.copy_manually'), 'info');
      };
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(val).then(done).catch(fallback);
      } else {
        fallback();
      }
    } else if (act === 'copy_card'){
      this._copyInviteCard(card);
    } else if (act === 'toggle') {
      this.socket.emit('update-invite-code', { id, enabled: ic ? !ic.enabled : true });
    } else if (act === 'delete') {
      if (confirm(t('settings.admin.invite_links.delete_confirm', { code: ic?.code || id }))) {
        this.socket.emit('delete-invite-code', { id });
      }
    } else if (act === 'edit') {
      const ed = card.querySelector('.invite-code-editor');
      if (ed) ed.style.display = ed.style.display === 'none' ? '' : 'none';
    } else if (act === 'cancel') {
      const ed = card.querySelector('.invite-code-editor');
      if (ed) ed.style.display = 'none';
    } else if (act === 'edit-all') {
      card.querySelectorAll('.invite-edit-channel-cb').forEach(cb => { cb.checked = true; });
    } else if (act === 'edit-none') {
      card.querySelectorAll('.invite-edit-channel-cb').forEach(cb => { cb.checked = false; });
    } else if (act === 'save') {
      const cbs = Array.from(card.querySelectorAll('.invite-edit-channel-cb'));
      const total = cbs.length;
      const picked = cbs.filter(cb => cb.checked).map(cb => parseInt(cb.dataset.cid)).filter(Number.isFinite);
      const channels = picked;
      const maxUses = parseInt(card.querySelector('[data-role="edit-maxuses"]')?.value) || 0;
      const payload = { id, channels, maxUses };
      const exp = parseInt(card.querySelector('[data-role="edit-expiry"]')?.value);
      if (Number.isFinite(exp) && exp >= 0) payload.expiresInHours = exp;
      this.socket.emit('update-invite-code', payload);
    }
  });

  // Invite Links popout: open/close. Refresh the list and create-form channels
  // on open so the modal always reflects current state.
  // Active sessions. Refreshed whenever the Account settings pane is opened
  // rather than polled, since the list is only interesting while you look at it.
  document.getElementById('revoke-sessions-btn')?.addEventListener('click', async () => {
    const status = document.getElementById('sessions-status');
    const pw = prompt(t('settings.sessions_section.confirm_prompt'));
    if (pw === null) return;                       // cancelled
    if (!pw) { status.textContent = t('settings.sessions_section.need_password'); return; }
    status.classList.remove('error', 'success');
    status.textContent = t('settings.sessions_section.working');
    // Set before the request: the server disconnects every socket including
    // ours, and this is what tells our own force-logout handler to sit still.
    this._justRevokedSessions = true;
    try {
      const res = await fetch('/api/auth/revoke-sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.token}` },
        body: JSON.stringify({ password: pw })
      });
      const data = await res.json();
      if (!res.ok) {
        this._justRevokedSessions = false;
        status.textContent = data.error || t('settings.sessions_section.failed');
        status.classList.add('error');
        return;
      }
      this.token = data.token;
      localStorage.setItem('haven_token', data.token);
      this.socket.auth.token = data.token;         // so the auto-reconnect authenticates
      status.textContent = t('settings.sessions_section.done');
      status.classList.add('success');
    } catch {
      this._justRevokedSessions = false;
      status.textContent = t('settings.sessions_section.failed');
      status.classList.add('error');
    }
  });
},

async _copyInviteCard(card) {
  const input = card.querySelector('[data-role="invite-link"]');
  const inviteUrl = input?.value || '';
  if (!inviteUrl) return;

  // Find the invite code data for this card.
  const id = parseInt(card.dataset.id, 10);
  const invite = (this._inviteCodes || []).find(x => x.id === id);

  // Server branding
  const brandText = document.querySelector('.brand-text')?.textContent?.trim() || 'HAVEN';
  const brandIcon = document.querySelector('.brand-icon');
  const defaultLogo = document.querySelector('.logo-sm')?.textContent?.trim() || '⬡';

  // Active theme
  const themeElement = document.querySelector('[data-theme]') || document.documentElement;
  const styles = getComputedStyle(themeElement);
  const theme = name => styles.getPropertyValue(name).trim();

  const bgCard = theme('--bg-card');
  const accent = theme('--accent');
  const accentText = theme('--accent-text') || '#fff';
  const textPrimary = theme('--text-primary');
  const textSecondary = theme('--text-secondary');
  const textLink = theme('--text-link');
  const border = theme('--border');
  const radius = theme('--radius') || '8px';
  const fontMain = theme('--font-main');

  // Convert custom server icon to a self-contained data URL.
  let iconSrc = '';

  if (brandIcon?.src) {
    try {
      if (brandIcon.src.startsWith('data:')) {
        iconSrc = brandIcon.src;
      } else {
        const response = await fetch(brandIcon.src);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const blob = await response.blob();
        iconSrc = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
      }
    } catch (err) {
      console.warn('Failed to embed server icon:', err);
    }
  }

  const iconHtml = iconSrc
    ? `<img src="${iconSrc}" alt="${brandText}" style="display:block;width:96px;height:96px;margin:0 auto 16px; border-radius:${radius};object-fit:contain">`
    : `<div style="margin:0 auto 16px;font-size:84px;line-height:96px;color:${accent}">${defaultLogo}</div>`;

  // Format invite expiration.
  let expiryText = '';

  if (invite?.expires_at) {
    const expiryDate = new Date(invite.expires_at);
    if (!Number.isNaN(expiryDate.getTime())) expiryText = this._fmtDateTime(expiryDate);
  }

  const invitedText = t('settings.admin.invite_links.card_invited', { server: brandText });
  const registerText = t('settings.admin.invite_links.card_register');
  const joinText = t('settings.admin.invite_links.card_join', { server: brandText });
  const copyLinkText = t('settings.admin.invite_links.card_copy_link');

  const expiryHtml = expiryText
    ? `<p style="margin:24px 0 0;padding-top:16px;border-top:1px solid ${border};color:${textSecondary}; font-size:13px">${t('settings.admin.invite_links.card_expires', { date: expiryText })}</p>`
    : '';

  const html = `
    <div style="margin:0;padding:40px 20px;font-family:${fontMain};text-align:center">
      <div style="max-width:600px;margin:0 auto;padding:32px 24px;box-sizing:border-box;background:${bgCard};
          border:1px solid ${border};border-radius:${radius}">
        ${iconHtml}
        <h2 style="margin:0 0 16px;font-family:${fontMain};font-size:24px;color:${textPrimary}">
          ${invitedText}
        </h2>
        <p style="margin:0 0 24px;color:${textSecondary};font-size:16px">
          ${registerText}
        </p>
        <a href="${inviteUrl}" style="display:inline-block;padding:12px 24px;background:${accent};color:${accentText};
            text-decoration:none;border-radius:${radius};font-size:16px;font-weight:bold">
          ${joinText}
        </a>
        <p style="margin:24px 0 8px;color:${textSecondary};font-size:14px">${copyLinkText}</p>
        <p style="margin:0;word-break:break-all;font-size:14px">
          <a href="${inviteUrl}" style="color:${textLink};text-decoration:none">${inviteUrl}</a>
        </p>
        ${expiryHtml}
      </div>
    </div>`;

  const text = `${invitedText}

${registerText}

${joinText}:
${inviteUrl}${expiryText ? `

${t('settings.admin.invite_links.card_expires', { date: expiryText })}` : ''}`;

  try {
    if (!navigator.clipboard?.write) throw new Error('HTML clipboard API unavailable');

    await navigator.clipboard.write([
      new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([text], { type: 'text/plain' })
      })
    ]);

    this._showToast?.(t('settings.admin.invite_links.email_card_copied'), 'success');
  } catch (err) {
    console.warn('Failed to copy HTML email:', err);
    this._showToast?.(t('settings.admin.invite_links.email_card_copy_failed'), 'info');
  }
},

// ═══════════════════════════════════════════════════════
// INVITE LINKS
// ═══════════════════════════════════════════════════════

// Run the configured STUN/TURN through a real ICE gathering and say, in words
// an admin can act on, what works and what does not.
//
// Every voice thread has run the same course: it fails for users, the admin has
// no way to see why, and it only gets solved when someone walks them through a
// third-party ICE test page and reads the candidate list back to them. The
// browser knows all of this the moment it gathers candidates. #5542 cost three
// people several days between them, and the answer in the end was a mistyped
// port that this would have named in ten seconds.
async _runConnectivityTest() {
  const btn = document.getElementById('test-connectivity-btn');
  const box = document.getElementById('connectivity-test-result');
  if (!btn || !box || !this.voice) return;

  const line = (icon, text, muted) =>
    `<div style="display:flex;gap:6px;align-items:flex-start;margin:3px 0${muted ? ';opacity:0.75' : ''}">` +
    `<span class="connectivity-test-icon" style="flex:none">${icon}</span><span>${text}</span></div>`;

  btn.disabled = true;
  box.style.display = '';
  box.innerHTML = `<small class="settings-hint">${t('settings.admin.test_connectivity_running')}</small>`;

  try {
    // Deliberately the live endpoint rather than the values in the boxes, so
    // this tests what users are actually handed, including unsaved edits being
    // absent. Saying "save first" in the hint is cheaper than guessing here.
    const res = await fetch('/api/ice-servers', {
      headers: { Authorization: `Bearer ${localStorage.getItem('haven_token')}` }
    });
    if (!res.ok) throw new Error(t('settings.admin.test_server_list_failed'));
    const cfg = await res.json();
    const report = await this.voice.diagnoseConnectivity(cfg.iceServers || []);

    const out = [];

    if (!report.stunTotal && !report.turnTotal) {
      out.push(line('⚠️', t('settings.admin.test_none_configured')));
    }

    // Headline first: can two people on different networks reach each other.
    if (report.hasRelay) {
      out.push(line('✅', t('settings.admin.test_ok_relay')));
    } else if (report.canCrossNetworks) {
      out.push(line('✅', t('settings.admin.test_ok_stun')));
    } else if (report.stunTotal || report.turnTotal) {
      out.push(line('❌', t('settings.admin.test_fail_nothing')));
    }

    // Then the specifics, naming each server, because "one of them is wrong"
    // is the part that takes days to find by hand.
    for (const r of report.results) {
      const name = this._escapeHtml(r.urls);
      const why = r.error ? ` <span style="opacity:0.8">(${this._escapeHtml(r.error)})</span>` : '';
      if (r.isTurn) {
        out.push(r.relay
          ? line('✅', t('settings.admin.test_turn_ok', { server: name }), true)
          : line('❌', t('settings.admin.test_turn_dead', { server: name }) + why));
      } else {
        out.push(r.srflx
          ? line('✅', t('settings.admin.test_stun_ok', { server: name }), true)
          : line('❌', t('settings.admin.test_stun_dead', { server: name }) + why));
      }
    }

    // Advice, only where it applies.
    if (report.deadTurn.length) {
      out.push(line('💡', t('settings.admin.test_tip_turn')));
    } else if (report.canCrossNetworks && !report.turnTotal) {
      out.push(line('💡', t('settings.admin.test_tip_no_turn')));
    }
    if (report.deadStun.length && report.stunLive) {
      out.push(line('💡', t('settings.admin.test_tip_partial')));
    }

    // The caveat that actually bit people: this ran from wherever the admin is
    // sitting. A server reachable only on the LAN passes here and fails for
    // everyone else, which is precisely how #5542 stayed hidden for days.
    out.push(line('ℹ️', t('settings.admin.test_caveat'), true));

    box.innerHTML = `<div style="font-size:0.8125rem;line-height:1.45">${out.join('')}</div>`;
  } catch (err) {
    box.innerHTML = `<small class="settings-hint">${this._escapeHtml(t('settings.admin.test_connectivity_failed', { error: err.message || t('settings.admin.unknown_error') }))}</small>`;
  } finally {
    btn.disabled = false;
  }
},

_openInviteLinksModal() {
  const modal = document.getElementById('invite-links-modal');
  if (!modal) return;
  if (!this.user.isAdmin && !this._hasGlobalPerm('manage_server') && !this._hasGlobalPerm('invite_users')) return this._showToast(t('settings.admin.invite_links_no_permission'), 'error');
  if (typeof this._renderInviteCreateChannels === 'function') {
    try { this._renderInviteCreateChannels(true); } catch (err) { console.warn('[Admin] _renderInviteCreateChannels failed', err); }
  }
  if (this.socket?.connected) { try { this.socket.emit('get-invite-codes'); } catch (err) { console.warn('[Admin] could not request invite codes', err); } }
  modal.style.display = 'flex';

  // Setup max invite uses input limits.
  // admin and manage_server roles exempt from limitation.
  const parsedMaxInvtUses = parseInt(this.serverSettings?.max_invite_uses, 10);
  const maxInvtUses = Number.isNaN(parsedMaxInvtUses) ? 0 : parsedMaxInvtUses;
  const restrictUses = !this.user?.isAdmin && !this._hasPerm('manage_server') && maxInvtUses > 0;
  const maxUsesInput = document.getElementById('invite-new-maxuses');
  if (maxUsesInput) {
    maxUsesInput.value = 1;
    maxUsesInput.min = restrictUses ? 1 : 0;
    maxUsesInput.max = restrictUses ? maxInvtUses : 100000;
  }
},

};
