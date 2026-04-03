//Shared permission list instead of declaring the same multiple times
const ALL_PERMS = [
  'edit_own_messages', 'delete_own_messages', 'delete_message', 'delete_lower_messages',
  'pin_message', 'archive_messages', 'kick_user', 'mute_user', 'ban_user',
  'rename_channel', 'rename_sub_channel', 'set_channel_topic', 'manage_sub_channels',
  'create_channel', 'create_temp_channel', 'upload_files', 'use_voice', 'use_tts', 'manage_webhooks', 'mention_everyone', 'view_history',
  'view_all_members', 'manage_emojis', 'manage_soundboard', 'manage_music_queue', 'promote_user', 'transfer_admin',
  'manage_roles', 'manage_server', 'delete_channel'
];
//Similarly flavored solution to perm labels
const PERM_LABELS = {
  get edit_own_messages() { return t('permissions.edit_own_messages'); },
  get delete_own_messages() { return t('permissions.delete_own_messages'); },
  get delete_message() { return t('permissions.delete_message'); },
  get delete_lower_messages() { return t('permissions.delete_lower_messages'); },
  get pin_message() { return t('permissions.pin_message'); },
  get archive_messages() { return t('permissions.archive_messages'); },
  get kick_user() { return t('permissions.kick_user'); },
  get mute_user() { return t('permissions.mute_user'); },
  get ban_user() { return t('permissions.ban_user'); },
  get rename_channel() { return t('permissions.rename_channel'); },
  get rename_sub_channel() { return t('permissions.rename_sub_channel'); },
  get set_channel_topic() { return t('permissions.set_channel_topic'); },
  get manage_sub_channels() { return t('permissions.manage_sub_channels'); },
  get create_channel() { return t('permissions.create_channel'); },
  get create_temp_channel() { return t('permissions.create_temp_channel'); },
  get upload_files() { return t('permissions.upload_files'); },
  get use_voice() { return t('permissions.use_voice'); },
  get use_tts() { return t('permissions.use_tts'); },
  get manage_webhooks() { return t('permissions.manage_webhooks'); },
  get mention_everyone() { return t('permissions.mention_everyone'); },
  get view_history() { return t('permissions.view_history'); },
  get view_all_members() { return t('permissions.view_all_members'); },
  get manage_emojis() { return t('permissions.manage_emojis'); },
  get manage_soundboard() { return t('permissions.manage_soundboard'); },
  get manage_music_queue() { return t('permissions.manage_music_queue'); },
  get promote_user() { return t('permissions.promote_user'); },
  get transfer_admin() { return t('permissions.transfer_admin'); },
  get manage_roles() { return t('permissions.manage_roles'); },
  get manage_server() { return t('permissions.manage_server'); },
  get delete_channel() { return t('permissions.delete_channel'); }
};

export default {

// ── First-Time Setup Wizard ─────────────────────────────

_maybeShowSetupWizard() {
  // Only show for admin, only if wizard hasn't been completed
  if (!this.user?.isAdmin) return;
  if (this.serverSettings?.setup_wizard_complete === 'true') return;
  if (this._wizardShown) return;
  this._wizardShown = true;

  const modal = document.getElementById('setup-wizard-modal');
  if (!modal) return;

  this._wizardStep = 1;
  this._wizardChannelCode = null;
  this._wizardPortResult = null;

  // Pre-fill server name from settings
  const nameInput = document.getElementById('wizard-server-name');
  if (nameInput && this.serverSettings?.server_name) {
    nameInput.value = this.serverSettings.server_name;
  }

  this._wizardUpdateUI();
  modal.style.display = 'flex';

  // Button handlers (clean up old listeners)
  const nextBtn = document.getElementById('wizard-next-btn');
  const backBtn = document.getElementById('wizard-back-btn');
  const skipBtn = document.getElementById('wizard-skip-btn');
  const portBtn = document.getElementById('wizard-check-port-btn');
  const copyBtn = document.getElementById('wizard-copy-code');

  const newNext = nextBtn.cloneNode(true);
  nextBtn.parentNode.replaceChild(newNext, nextBtn);
  const newBack = backBtn.cloneNode(true);
  backBtn.parentNode.replaceChild(newBack, backBtn);
  const newSkip = skipBtn.cloneNode(true);
  skipBtn.parentNode.replaceChild(newSkip, skipBtn);
  const newPort = portBtn.cloneNode(true);
  portBtn.parentNode.replaceChild(newPort, portBtn);
  const newCopy = copyBtn.cloneNode(true);
  copyBtn.parentNode.replaceChild(newCopy, copyBtn);

  newNext.addEventListener('click', () => this._wizardNext());
  newBack.addEventListener('click', () => this._wizardBack());
  newSkip.addEventListener('click', () => this._wizardComplete());
  newPort.addEventListener('click', () => this._wizardCheckPort());
  newCopy.addEventListener('click', () => {
    if (this._wizardChannelCode) {
      const markCopied = () => {
        newCopy.textContent = t('modals.wizard.copied_btn');
        setTimeout(() => newCopy.textContent = t('modals.wizard.copy_btn'), 2000);
      };
      navigator.clipboard.writeText(this._wizardChannelCode).then(markCopied).catch(() => {
        try {
          const ta = document.createElement('textarea');
          ta.value = this._wizardChannelCode;
          ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
          document.body.appendChild(ta);
          ta.focus(); ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
          markCopied();
        } catch { /* could not copy */ }
      });
    }
  });
},

_wizardUpdateUI() {
  const step = this._wizardStep;

  // Update step indicators
  document.querySelectorAll('.wizard-indicator').forEach(ind => {
    const s = parseInt(ind.dataset.step);
    ind.classList.remove('active', 'done');
    if (s === step) ind.classList.add('active');
    else if (s < step) ind.classList.add('done');
  });

  // Show/hide steps
  for (let i = 1; i <= 4; i++) {
    const el = document.getElementById(`wizard-step-${i}`);
    if (el) el.style.display = i === step ? 'block' : 'none';
  }

  // Back button
  const backBtn = document.getElementById('wizard-back-btn');
  if (backBtn) backBtn.style.display = step > 1 ? '' : 'none';

  // Next/Finish button text
  const nextBtn = document.getElementById('wizard-next-btn');
  if (nextBtn) {
    if (step === 4) {
      nextBtn.textContent = `🚀 ${t('modals.wizard.get_started_btn')}`;
    } else if (step === 2 && !this._wizardChannelCode) {
      nextBtn.textContent = t('modals.wizard.create_continue_btn');
    } else {
      nextBtn.textContent = t('modals.wizard.next_btn');
    }
  }

  // Step 4 summary
  if (step === 4) {
    const chanSummary = document.getElementById('wizard-summary-channel');
    if (chanSummary) {
      chanSummary.textContent = this._wizardChannelCode
        ? `✅ ${t('modals.wizard.channel_created_summary', { code: this._wizardChannelCode })}`
        : `⏭️ ${t('modals.wizard.no_channel_created')}`;
    }
    const portSummary = document.getElementById('wizard-summary-port');
    if (portSummary) {
      if (this._wizardPortResult === true) portSummary.textContent = `✅ ${t('modals.wizard.port_open_summary')}`;
      else if (this._wizardPortResult === false) portSummary.textContent = `⚠️ ${t('modals.wizard.port_blocked_summary')}`;
      else portSummary.textContent = `⏭️ ${t('modals.wizard.check_port_skipped')}`;
    }

    // Set final URL
    const urlEl = document.getElementById('wizard-final-url');
    if (urlEl && this._wizardPublicIp) {
      const port = location.port || (location.protocol === 'https:' ? '443' : '80');
      urlEl.textContent = `${location.protocol}//${this._wizardPublicIp}:${port}`;
    }
  }
},

_wizardNext() {
  const step = this._wizardStep;

  if (step === 1) {
    // Save server name if changed
    const nameInput = document.getElementById('wizard-server-name');
    const name = nameInput?.value?.trim();
    if (name && name !== (this.serverSettings?.server_name || 'Haven')) {
      this.socket.emit('update-server-setting', { key: 'server_name', value: name });
    }
    this._wizardStep = 2;
    this._wizardUpdateUI();

  } else if (step === 2) {
    // Create channel if not already created
    if (!this._wizardChannelCode) {
      const nameInput = document.getElementById('wizard-channel-name');
      const channelName = nameInput?.value?.trim() || 'General';

      // Listen for channel creation result
      const handler = (channel) => {
        if (channel && channel.code) {
          this._wizardChannelCode = channel.code;
          const resultDiv = document.getElementById('wizard-channel-result');
          const codeEl = document.getElementById('wizard-channel-code');
          if (resultDiv) resultDiv.style.display = 'block';
          if (codeEl) codeEl.textContent = channel.code;
          nameInput.disabled = true;
          // Auto-advance to step 3 after channel is created
          this._wizardStep = 3;
          this._wizardUpdateUI();
        }
        this.socket.off('channel-created', handler);
      };
      this.socket.on('channel-created', handler);
      this.socket.emit('create-channel', { name: channelName });
    } else {
      this._wizardStep = 3;
      this._wizardUpdateUI();
    }

  } else if (step === 3) {
    this._wizardStep = 4;
    this._wizardUpdateUI();

  } else if (step === 4) {
    this._wizardComplete();
  }
},

_wizardBack() {
  if (this._wizardStep > 1) {
    this._wizardStep--;
    this._wizardUpdateUI();
  }
},

async _wizardCheckPort() {
  const checkBtn = document.getElementById('wizard-check-port-btn');
  const checking = document.getElementById('wizard-port-checking');
  const result = document.getElementById('wizard-port-result');

  if (checkBtn) checkBtn.style.display = 'none';
  if (checking) checking.style.display = 'flex';
  if (result) result.style.display = 'none';

  try {
    const resp = await fetch('/api/port-check', {
      headers: { 'Authorization': `Bearer ${this.token}` }
    });
    const data = await resp.json();

    if (checking) checking.style.display = 'none';
    if (result) result.style.display = 'block';

    this._wizardPublicIp = data.publicIp;

    if (data.reachable) {
      this._wizardPortResult = true;
      result.innerHTML = `
        <div class="wizard-port-success">
          ✅ <strong>${t('modals.wizard.port_reachable_title')}</strong><br>
          ${t('modals.wizard.public_ip_label')} <code>${this._escapeHtml(data.publicIp)}</code><br>
          ${t('modals.wizard.friends_connect_at')} <code>${location.protocol}//${this._escapeHtml(data.publicIp)}:${location.port || 3000}</code>
        </div>`;
    } else {
      this._wizardPortResult = false;
      const port = location.port || 3000;
      result.innerHTML = `
        <div class="wizard-port-fail">
          ⚠️ <strong>${t('modals.wizard.port_fail_title', { port })}</strong><br>
          ${data.publicIp ? t('modals.wizard.port_fail_blocked_ip', { ip: `<code>${this._escapeHtml(data.publicIp)}</code>` }) : this._escapeHtml(data.error || t('modals.wizard.port_fail_error'))}<br><br>
          <strong>${t('modals.wizard.to_fix')}</strong>
          <ol>
            <li>${t('modals.wizard.fix_step_1')}</li>
            <li>${t('modals.wizard.fix_step_2')}</li>
            <li>${t('modals.wizard.fix_step_3', { port })}</li>
            <li>${t('modals.wizard.fix_step_4', { port })}</li>
            <li>${t('modals.wizard.fix_step_5')}</li>
          </ol>
          <strong>${t('modals.wizard.lan_only')}</strong> ${t('modals.wizard.lan_detail')}
        </div>`;
      if (checkBtn) {
        checkBtn.textContent = `🔄 ${t('modals.wizard.recheck_btn')}`;
        checkBtn.style.display = '';
      }
    }
  } catch (err) {
    if (checking) checking.style.display = 'none';
    if (result) {
      result.style.display = 'block';
      result.innerHTML = `<div class="wizard-port-fail">❌ ${t('modals.wizard.check_failed', { error: this._escapeHtml(err.message) })}</div>`;
    }
    if (checkBtn) {
      checkBtn.textContent = `🔄 ${t('modals.wizard.retry_btn')}`;
      checkBtn.style.display = '';
    }
  }
},

_wizardComplete() {
  // Mark wizard as complete in server settings
  this.socket.emit('update-server-setting', { key: 'setup_wizard_complete', value: 'true' });

  // Close the modal
  const modal = document.getElementById('setup-wizard-modal');
  if (modal) modal.style.display = 'none';

  this._showToast(t('modals.wizard.setup_complete'), 'success');
},

_applyServerSettings() {
  // Don't overwrite admin form inputs when settings modal is open (user may be editing)
  const modalOpen = document.getElementById('settings-modal')?.style.display === 'flex';

  if (!modalOpen) {
    const vis = document.getElementById('member-visibility-select');
    if (vis && this.serverSettings.member_visibility) {
      vis.value = this.serverSettings.member_visibility;
    }
    const nameInput = document.getElementById('server-name-input');
    if (nameInput && this.serverSettings.server_name !== undefined) {
      nameInput.value = this.serverSettings.server_name || '';
    }
    const titleInput = document.getElementById('server-title-input');
    if (titleInput && this.serverSettings.server_title !== undefined) {
      titleInput.value = this.serverSettings.server_title || '';
    }
    const cleanupEnabled = document.getElementById('cleanup-enabled');
    if (cleanupEnabled) {
      cleanupEnabled.checked = this.serverSettings.cleanup_enabled === 'true';
    }
    const cleanupAge = document.getElementById('cleanup-max-age');
    if (cleanupAge && this.serverSettings.cleanup_max_age_days) {
      cleanupAge.value = this.serverSettings.cleanup_max_age_days;
    }
    const cleanupSize = document.getElementById('cleanup-max-size');
    if (cleanupSize && this.serverSettings.cleanup_max_size_mb) {
      cleanupSize.value = this.serverSettings.cleanup_max_size_mb;
    }
    const maxUpload = document.getElementById('max-upload-mb');
    if (maxUpload) {
      maxUpload.value = this.serverSettings.max_upload_mb || '25';
    }
    const maxSoundKb = document.getElementById('max-sound-kb');
    if (maxSoundKb) {
      maxSoundKb.value = this.serverSettings.max_sound_kb || '1024';
    }
    const maxEmojiKb = document.getElementById('max-emoji-kb');
    if (maxEmojiKb) {
      maxEmojiKb.value = this.serverSettings.max_emoji_kb || '256';
    }
    const maxPollOpts = document.getElementById('max-poll-options');
    if (maxPollOpts) {
      maxPollOpts.value = this.serverSettings.max_poll_options || '10';
    }
    const whitelistToggle = document.getElementById('whitelist-enabled');
    if (whitelistToggle) {
      whitelistToggle.checked = this.serverSettings.whitelist_enabled === 'true';
    }

    const updateBannerAdminOnly = document.getElementById('update-banner-admin-only');
    if (updateBannerAdminOnly) {
      updateBannerAdminOnly.checked = this.serverSettings.update_banner_admin_only === 'true';
    }
    const defaultTheme = document.getElementById('default-theme-select');
    if (defaultTheme) {
      defaultTheme.value = this.serverSettings.default_theme || '';
    }

    // Tunnel settings (live state, not part of Save/Cancel flow)
    const tunnelProvider = document.getElementById('tunnel-provider-select');
    if (tunnelProvider && this.serverSettings.tunnel_provider) {
      tunnelProvider.value = this.serverSettings.tunnel_provider;
    }
    this._refreshTunnelStatus();

    if (typeof this._renderPermThresholds === 'function') this._renderPermThresholds();
  }

  // Server invite code — always update even while modal is open (live action, not Save flow)
  const serverCodeEl = document.getElementById('server-code-value');
  if (serverCodeEl) {
    const code = this.serverSettings.server_code;
    serverCodeEl.textContent = code || '—';
    serverCodeEl.style.opacity = code ? '1' : '0.4';
  }

  // Always update visual branding regardless of modal state
  this._applyServerBranding();

  // Re-evaluate update banner visibility whenever settings change
  this._applyUpdateBanner();

  // Re-render channels in case sort mode changed
  if (!localStorage.getItem('haven_server_sort_mode')) this._renderChannels();

  if (!modalOpen && this.user && (this.user.isAdmin || this._hasPerm('manage_server'))) {
    this.socket.emit('get-whitelist');
  }
},

/* ── Admin settings save / cancel ───────────────────── */

_renderWebhooksList(webhooks) {
  const container = document.getElementById('webhooks-list');
  if (!container) return;
  if (!webhooks.length) {
    container.innerHTML = `<p class="muted-text">${t('settings.admin.no_bots')}</p>`;
    return;
  }
  // Simple preview list for server settings — full management is in the bot modal
  container.innerHTML = webhooks.map(wh => {
    const statusDot = wh.is_active ? '🟢' : '🔴';
    const avatarHtml = wh.avatar_url
      ? `<img src="${this._escapeHtml(wh.avatar_url)}" style="width:20px;height:20px;border-radius:50%;object-fit:cover">`
      : '🤖';
    return `<div class="role-preview-item">${avatarHtml} <span style="font-weight:600">${this._escapeHtml(wh.name)}</span> <span style="opacity:0.5;font-size:11px">#${this._escapeHtml(wh.channel_name)}</span> ${statusDot}</div>`;
  }).join('');
},

_syncSettingsNav() {
  const isAdmin = document.getElementById('admin-mod-panel')?.style.display !== 'none';
  document.querySelectorAll('.settings-nav-admin').forEach(el => {
    el.style.display = isAdmin ? '' : 'none';
  });
  // Show the Emojis settings tab for users with manage_emojis permission even if not full admin/mod
  const emojiNavItem = document.querySelector('.settings-nav-item[data-target="section-emojis"]');
  if (emojiNavItem && !isAdmin && this._hasPerm('manage_emojis')) {
    emojiNavItem.style.display = '';
  }
  // Show the Sounds admin tab for users with manage_soundboard permission
  const soundsNavItem = document.querySelector('.settings-nav-item[data-target="section-sounds-admin"]');
  if (soundsNavItem && !isAdmin && this._hasPerm('manage_soundboard')) {
    soundsNavItem.style.display = '';
  }
  // Show Roles tab for users with manage_roles permission
  const rolesNavItem = document.querySelector('.settings-nav-item[data-target="section-roles"]');
  if (rolesNavItem && !isAdmin && this._hasPerm('manage_roles')) {
    rolesNavItem.style.display = '';
  }
  // Show Server settings tab for users with manage_server permission
  const serverNavItem = document.querySelector('.settings-nav-item[data-target="section-server"]');
  if (serverNavItem && !isAdmin && this._hasPerm('manage_server')) {
    serverNavItem.style.display = '';
  }
},

_snapshotAdminSettings() {
  this._adminSnapshot = {
    server_name: this.serverSettings.server_name || 'HAVEN',
    server_title: this.serverSettings.server_title || '',
    member_visibility: this.serverSettings.member_visibility || 'online',
    cleanup_enabled: this.serverSettings.cleanup_enabled || 'false',
    cleanup_max_age_days: this.serverSettings.cleanup_max_age_days || '0',
    cleanup_max_size_mb: this.serverSettings.cleanup_max_size_mb || '0',
    whitelist_enabled: this.serverSettings.whitelist_enabled || 'false',
    max_upload_mb: this.serverSettings.max_upload_mb || '25',
    max_sound_kb: this.serverSettings.max_sound_kb || '1024',
    max_emoji_kb: this.serverSettings.max_emoji_kb || '256',
    max_poll_options: this.serverSettings.max_poll_options || '10',
    update_banner_admin_only: this.serverSettings.update_banner_admin_only || 'false',
    default_theme: this.serverSettings.default_theme || ''
  };
  // Load webhooks list for admin preview
  if (this.user?.isAdmin) {
    this.socket.emit('get-webhooks');
  }
},

_saveAdminSettings() {
  if (!this.user?.isAdmin && !this._hasPerm('manage_server')) {
    document.getElementById('settings-modal').style.display = 'none';
    return;
  }
  const snap = this._adminSnapshot || {};
  let changed = false;

  const name = document.getElementById('server-name-input')?.value.trim() || 'HAVEN';
  if (name !== snap.server_name) {
    this.socket.emit('update-server-setting', { key: 'server_name', value: name });
    changed = true;
  }

  const title = document.getElementById('server-title-input')?.value.trim() || '';
  if (title !== (snap.server_title || '')) {
    this.socket.emit('update-server-setting', { key: 'server_title', value: title });
    changed = true;
  }

  const vis = document.getElementById('member-visibility-select')?.value;
  if (vis && vis !== snap.member_visibility) {
    this.socket.emit('update-server-setting', { key: 'member_visibility', value: vis });
    changed = true;
  }

  const cleanEnabled = document.getElementById('cleanup-enabled')?.checked ? 'true' : 'false';
  if (cleanEnabled !== snap.cleanup_enabled) {
    this.socket.emit('update-server-setting', { key: 'cleanup_enabled', value: cleanEnabled });
    changed = true;
  }

  const cleanAge = String(Math.max(0, Math.min(3650, parseInt(document.getElementById('cleanup-max-age')?.value) || 0)));
  if (cleanAge !== (snap.cleanup_max_age_days || '0')) {
    this.socket.emit('update-server-setting', { key: 'cleanup_max_age_days', value: cleanAge });
    changed = true;
  }

  const cleanSize = String(Math.max(0, Math.min(100000, parseInt(document.getElementById('cleanup-max-size')?.value) || 0)));
  if (cleanSize !== (snap.cleanup_max_size_mb || '0')) {
    this.socket.emit('update-server-setting', { key: 'cleanup_max_size_mb', value: cleanSize });
    changed = true;
  }

  const wlEnabled = document.getElementById('whitelist-enabled')?.checked ? 'true' : 'false';
  if (wlEnabled !== snap.whitelist_enabled) {
    this.socket.emit('whitelist-toggle', { enabled: wlEnabled === 'true' });
    this.socket.emit('update-server-setting', { key: 'whitelist_enabled', value: wlEnabled });
    changed = true;
  }

  const maxUpload = String(Math.max(1, Math.min(2048, parseInt(document.getElementById('max-upload-mb')?.value) || 25)));
  if (maxUpload !== (snap.max_upload_mb || '25')) {
    this.socket.emit('update-server-setting', { key: 'max_upload_mb', value: maxUpload });
    changed = true;
  }

  const maxSoundKb = String(Math.max(256, Math.min(10240, parseInt(document.getElementById('max-sound-kb')?.value) || 1024)));
  if (maxSoundKb !== (snap.max_sound_kb || '1024')) {
    this.socket.emit('update-server-setting', { key: 'max_sound_kb', value: maxSoundKb });
    changed = true;
  }

  const maxEmojiKb = String(Math.max(64, Math.min(1024, parseInt(document.getElementById('max-emoji-kb')?.value) || 256)));
  if (maxEmojiKb !== (snap.max_emoji_kb || '256')) {
    this.socket.emit('update-server-setting', { key: 'max_emoji_kb', value: maxEmojiKb });
    changed = true;
  }

  const maxPollOpts = String(Math.max(2, Math.min(25, parseInt(document.getElementById('max-poll-options')?.value) || 10)));
  if (maxPollOpts !== (snap.max_poll_options || '10')) {
    this.socket.emit('update-server-setting', { key: 'max_poll_options', value: maxPollOpts });
    changed = true;
  }

  const updateBannerAdminOnly = document.getElementById('update-banner-admin-only')?.checked ? 'true' : 'false';
  if (updateBannerAdminOnly !== (snap.update_banner_admin_only || 'false')) {
    this.socket.emit('update-server-setting', { key: 'update_banner_admin_only', value: updateBannerAdminOnly });
    changed = true;
  }

  const defaultTheme = document.getElementById('default-theme-select')?.value || '';
  if (defaultTheme !== (snap.default_theme || '')) {
    this.socket.emit('update-server-setting', { key: 'default_theme', value: defaultTheme });
    changed = true;
  }

  if (changed) {
    this._showToast(t('settings.admin.settings_saved'), 'success');
  } else {
    this._showToast(t('settings.admin.no_changes'), 'info');
  }
  document.getElementById('settings-modal').style.display = 'none';
},

_cancelAdminSettings() {
  const snap = this._adminSnapshot;
  if (snap) {
    const ni = document.getElementById('server-name-input');
    if (ni) ni.value = snap.server_name;
    const ti = document.getElementById('server-title-input');
    if (ti) ti.value = snap.server_title || '';
    const vis = document.getElementById('member-visibility-select');
    if (vis) vis.value = snap.member_visibility;
    const ce = document.getElementById('cleanup-enabled');
    if (ce) ce.checked = snap.cleanup_enabled === 'true';
    const ca = document.getElementById('cleanup-max-age');
    if (ca) ca.value = snap.cleanup_max_age_days;
    const cs = document.getElementById('cleanup-max-size');
    if (cs) cs.value = snap.cleanup_max_size_mb;
    const wl = document.getElementById('whitelist-enabled');
    if (wl) wl.checked = snap.whitelist_enabled === 'true';
    const mu = document.getElementById('max-upload-mb');
    if (mu) mu.value = snap.max_upload_mb || '25';
    const msk = document.getElementById('max-sound-kb');
    if (msk) msk.value = snap.max_sound_kb || '1024';
    const mek = document.getElementById('max-emoji-kb');
    if (mek) mek.value = snap.max_emoji_kb || '256';
    const mpo = document.getElementById('max-poll-options');
    if (mpo) mpo.value = snap.max_poll_options || '10';
    const uba = document.getElementById('update-banner-admin-only');
    if (uba) uba.checked = snap.update_banner_admin_only === 'true';
    const dt = document.getElementById('default-theme-select');
    if (dt) dt.value = snap.default_theme || '';
  }
  document.getElementById('settings-modal').style.display = 'none';
},

_renderWhitelist(list) {
  const el = document.getElementById('whitelist-list');
  if (!el) return;
  if (!list || list.length === 0) {
    el.innerHTML = `<p class="muted-text">${t('settings.admin.no_whitelisted_users')}</p>`;
    return;
  }
  el.innerHTML = list.map(w => `
    <div class="whitelist-item">
      <span class="whitelist-username">${this._escapeHtml(w.username)}</span>
      <button class="btn-sm btn-danger-sm whitelist-remove-btn" data-username="${this._escapeHtml(w.username)}">✕</button>
    </div>
  `).join('');
  el.querySelectorAll('.whitelist-remove-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      this.socket.emit('whitelist-remove', { username: btn.dataset.username });
    });
  });
},

/* ── Server Branding (icon + name) ──────────────────── */

_applyServerBranding() {
  const name = this.serverSettings.server_name || 'HAVEN';
  const icon = this.serverSettings.server_icon || '';

  // Sidebar brand text
  const brandText = document.querySelector('.brand-text');
  if (brandText) brandText.textContent = name;

  // Sidebar brand icon
  const logoSm = document.querySelector('.logo-sm');
  if (logoSm) {
    if (icon) {
      logoSm.style.display = 'none';
      let brandIcon = document.querySelector('.brand-icon');
      if (!brandIcon) {
        brandIcon = document.createElement('img');
        brandIcon.className = 'brand-icon';
        logoSm.parentNode.insertBefore(brandIcon, logoSm);
      }
      brandIcon.src = icon;
      brandIcon.style.display = '';
    } else {
      logoSm.style.display = '';
      const brandIcon = document.querySelector('.brand-icon');
      if (brandIcon) brandIcon.style.display = 'none';
    }
  }

  // Server bar icon
  const homeServer = document.getElementById('home-server');
  if (homeServer) {
    const existingImg = homeServer.querySelector('img');
    const iconText = homeServer.querySelector('.server-icon-text');
    if (icon) {
      if (iconText) iconText.style.display = 'none';
      if (!existingImg) {
        const img = document.createElement('img');
        img.src = icon;
        img.alt = name;
        homeServer.insertBefore(img, homeServer.firstChild);
      } else {
        existingImg.src = icon;
        existingImg.style.display = '';
      }
    } else {
      if (existingImg) existingImg.style.display = 'none';
      if (iconText) iconText.style.display = '';
    }
    homeServer.title = name;
  }

  // Admin preview
  const preview = document.getElementById('server-icon-preview');
  if (preview) {
    if (icon) {
      preview.innerHTML = `<img src="${icon}" alt="Server Icon">`;
    } else {
      preview.innerHTML = '<span class="server-icon-text">⬡</span>';
    }
  }
},

_initServerBranding() {
  // Server name — saved via admin Save button (no auto-save)

  // Server icon upload
  document.getElementById('server-icon-upload-btn')?.addEventListener('click', async () => {
    const fileInput = document.getElementById('server-icon-file');
    if (!fileInput || !fileInput.files[0]) return this._showToast(t('settings.admin.select_image_first'), 'error');
    const form = new FormData();
    form.append('image', fileInput.files[0]);
    try {
      const res = await fetch('/api/upload-server-icon', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${this.token}` },
        body: form
      });
      const data = await res.json();
      if (data.error) return this._showToast(data.error, 'error');
      this.socket.emit('update-server-setting', { key: 'server_icon', value: data.url });
      this._showToast(t('settings.admin.server_icon_updated'), 'success');
      fileInput.value = '';
    } catch (err) {
      this._showToast(t('settings.admin.upload_failed'), 'error');
    }
  });

  // Server icon remove
  document.getElementById('server-icon-remove-btn')?.addEventListener('click', () => {
    this.socket.emit('update-server-setting', { key: 'server_icon', value: '' });
    this._showToast(t('settings.admin.server_icon_removed'), 'success');
  });
},

_renderBanList(bans) {
  const list = document.getElementById('bans-list');
  if (bans.length === 0) {
    list.innerHTML = `<p class="muted-text">${t('settings.admin.no_banned_users')}</p>`;
    return;
  }
  list.innerHTML = bans.map(b => `
    <div class="ban-item">
      <div class="ban-info">
        <strong>${this._escapeHtml(b.username)}</strong>
        <span class="ban-reason">${b.reason ? this._escapeHtml(b.reason) : t('settings.admin.no_reason')}</span>
        <span class="ban-date">${new Date(b.created_at).toLocaleDateString()}</span>
      </div>
      <div class="ban-actions">
        <button class="btn-sm btn-unban" data-uid="${b.user_id}">${t('settings.admin.unban_btn')}</button>
        <button class="btn-sm btn-delete-user" data-uid="${b.user_id}" data-uname="${this._escapeHtml(b.username)}" title="${t('settings.admin.delete_user_title')}">🗑️</button>
      </div>
    </div>
  `).join('');

  list.querySelectorAll('.btn-unban').forEach(btn => {
    btn.addEventListener('click', () => {
      this.socket.emit('unban-user', { userId: parseInt(btn.dataset.uid) });
    });
  });

  list.querySelectorAll('.btn-delete-user').forEach(btn => {
    btn.addEventListener('click', () => {
      const name = btn.dataset.uname;
      if (confirm(t('settings.admin.confirm_delete_user', { name }))) {
        this.socket.emit('delete-user', { userId: parseInt(btn.dataset.uid) });
      }
    });
  });
},

_renderDeletedUsersList(entries) {
  const list = document.getElementById('deleted-users-list');
  if (!entries || entries.length === 0) {
    list.innerHTML = `<p class="muted-text">${t('settings.admin.no_deleted_users')}</p>`;
    return;
  }
  list.innerHTML = entries.map(e => `
    <div class="ban-item">
      <div class="ban-info">
        <strong>${this._escapeHtml(e.display_name || e.username)}</strong>
        ${e.display_name ? `<span class="ban-reason">@${this._escapeHtml(e.username)}</span>` : ''}
        <span class="ban-reason">${e.reason ? this._escapeHtml(e.reason) : t('settings.admin.no_reason')}</span>
        <span class="ban-date">${new Date(e.deleted_at).toLocaleDateString()}${e.deleted_by_name ? ` ${t('settings.admin.deleted_by', { name: this._escapeHtml(e.deleted_by_name) })}` : ''}</span>
      </div>
    </div>
  `).join('');
},

// ═══════════════════════════════════════════════════════
// MEMBER LIST (universal access, role-dependent actions)
// ═══════════════════════════════════════════════════════

_openAllMembersModal() {
  const modal = document.getElementById('all-members-modal');
  const list = document.getElementById('all-members-list');
  list.innerHTML = `<p class="muted-text" style="text-align:center;padding:20px">${t('modals.common.loading')}</p>`;
  document.getElementById('all-members-search').value = '';
  document.getElementById('all-members-filter').value = 'all';
  document.getElementById('all-members-count').textContent = '';
  modal.style.display = 'flex';

  this.socket.emit('get-all-members', {}, (res) => {
    if (res.error) {
      list.innerHTML = `<p class="muted-text" style="text-align:center;padding:20px">${this._escapeHtml(res.error)}</p>`;
      return;
    }
    this._allMembersData = res.members || [];
    this._allMembersChannels = res.allChannels || [];
    this._allMembersPerms = res.callerPerms || {};
    document.getElementById('all-members-count').textContent = `(${res.total})`;
    this._renderAllMembers(this._allMembersData);
  });
},

_filterAllMembers() {
  if (!this._allMembersData) return;
  const query = (document.getElementById('all-members-search').value || '').toLowerCase().trim();
  const filter = document.getElementById('all-members-filter').value;
  const now = Date.now();
  const sevenDays = 7 * 24 * 60 * 60 * 1000;

  let filtered = this._allMembersData;
  if (filter === 'online') filtered = filtered.filter(m => m.online && !m.banned);
  else if (filter === 'offline') filtered = filtered.filter(m => !m.online && !m.banned);
  else if (filter === 'new') filtered = filtered.filter(m => m.createdAt && (now - new Date(m.createdAt).getTime()) < sevenDays);
  else if (filter === 'banned') filtered = filtered.filter(m => m.banned);

  if (query) {
    filtered = filtered.filter(m =>
      m.username.toLowerCase().includes(query) ||
      m.displayName.toLowerCase().includes(query) ||
      (this._nicknames[m.id] || '').toLowerCase().includes(query) ||
      m.roles.some(r => r.name.toLowerCase().includes(query))
    );
  }

  document.getElementById('all-members-count').textContent = `(${filtered.length}/${this._allMembersData.length})`;
  this._renderAllMembers(filtered);
},

_renderAllMembers(members) {
  const list = document.getElementById('all-members-list');
  if (!members || members.length === 0) {
    list.innerHTML = `<p class="muted-text" style="text-align:center;padding:20px">${t('settings.admin.no_members_found')}</p>`;
    return;
  }

  const perms = this._allMembersPerms || {};
  const isSelf = (id) => id === this.user.id;

  list.innerHTML = members.map(m => {
    // Admin supersedes all other roles — only show the Admin badge, not DB-assigned roles
    const rolesHtml = m.isAdmin ? '' : m.roles.map(r =>
      `<span class="aml-role-badge" style="border-color:${this._safeColor(r.color, '#888')};color:${this._safeColor(r.color, '#888')}">${this._escapeHtml(r.name)}</span>`
    ).join('');
    const adminBadge = m.isAdmin ? `<span class="aml-admin-badge">${t('settings.admin.badge_admin')}</span>` : '';
    const bannedBadge = m.banned ? `<span class="aml-banned-badge">${t('settings.admin.badge_banned')}</span>` : '';
    const onlineDot = m.online && !m.banned ? 'aml-online' : 'aml-offline';
    const created = m.createdAt ? new Date(m.createdAt.endsWith('Z') ? m.createdAt : m.createdAt + 'Z') : null;
    const joinedStr = created ? created.toLocaleDateString() : '';
    const isNew = created && (Date.now() - created.getTime()) < 7 * 24 * 60 * 60 * 1000;
    const newBadge = isNew ? `<span class="aml-new-badge">${t('settings.admin.badge_new')}</span>` : '';

    const avatarUrl = m.avatar ? m.avatar : '';
    const avatarShape = m.avatarShape === 'square' ? 'border-radius:4px' : 'border-radius:50%';
    const avatarHtml = avatarUrl
      ? `<img src="${this._escapeHtml(avatarUrl)}" class="aml-avatar" style="${avatarShape}" alt="">`
      : `<div class="aml-avatar aml-avatar-default" style="${avatarShape}">${this._escapeHtml(m.displayName.charAt(0).toUpperCase())}</div>`;

    // Build action buttons based on caller permissions (never show for self)
    let actionsHtml = '';
    if (!isSelf(m.id)) {
      let btns = '';
      // Always-available: DM and Nickname
      btns += `<button class="aml-action-btn aml-btn-dm" data-uid="${m.id}" data-uname="${this._escapeHtml(m.displayName)}" title="${t('users.direct_message')}">💬</button>`;
      btns += `<button class="aml-action-btn aml-btn-nick" data-uid="${m.id}" data-uname="${this._escapeHtml(m.username)}" title="${t('users.set_nickname')}">🏷️</button>`;
      if (perms.canPromote && !m.banned) {
        btns += `<button class="aml-action-btn aml-btn-role" data-uid="${m.id}" data-uname="${this._escapeHtml(m.username)}" title="${t('users.gear_menu.assign_role')}">👑</button>`;
      }
      if (perms.canKick && !m.banned) {
        btns += `<button class="aml-action-btn aml-btn-addch" data-uid="${m.id}" data-uname="${this._escapeHtml(m.username)}" title="${t('settings.admin.add_to_channel_title')}">➕</button>`;
        btns += `<button class="aml-action-btn aml-btn-remch" data-uid="${m.id}" data-uname="${this._escapeHtml(m.username)}" title="${t('settings.admin.remove_from_channel_title')}">➖</button>`;
      }
      if (perms.canBan && !m.banned) {
        btns += `<button class="aml-action-btn aml-btn-ban" data-uid="${m.id}" data-uname="${this._escapeHtml(m.username)}" title="${t('settings.admin.ban_from_server_title')}">⛔</button>`;
      }
      if (perms.isAdmin && m.banned) {
        btns += `<button class="aml-action-btn aml-btn-unban" data-uid="${m.id}" data-uname="${this._escapeHtml(m.username)}" title="${t('settings.admin.unban_btn')}">✅</button>`;
      }
      if (perms.isAdmin && !m.isAdmin) {
        btns += `<button class="aml-action-btn aml-btn-delete" data-uid="${m.id}" data-uname="${this._escapeHtml(m.username)}" title="${t('settings.admin.delete_from_server_title')}">🗑️</button>`;
      }
      actionsHtml = `<div class="aml-actions">${btns}</div>`;
    }

    return `<div class="aml-member-row">
      <div class="aml-member-left">
        <div class="aml-avatar-wrap">
          ${avatarHtml}
          <span class="aml-status-dot ${onlineDot}"></span>
        </div>
        <div class="aml-member-info">
          <div class="aml-member-name">
            ${this._escapeHtml(this._getNickname(m.id, m.displayName))}${m.username !== m.displayName ? ` <span class="aml-login-name">@${this._escapeHtml(m.username)}</span>` : ''}${this._nicknames[m.id] ? ` <span class="aml-login-name">(${this._escapeHtml(m.displayName)})</span>` : ''}
            ${adminBadge}${bannedBadge}${newBadge}
          </div>
          <div class="aml-member-meta">
            ${rolesHtml}
            <span class="aml-member-joined">${joinedStr ? t('settings.admin.joined_date', { date: joinedStr }) : ''}</span>
            ${m.channels > 0 ? `<span class="aml-member-channels">${t(m.channels === 1 ? 'settings.admin.channel_count_one' : 'settings.admin.channel_count_other', { count: m.channels })}</span>` : ''}
          </div>
        </div>
      </div>
      ${actionsHtml}
    </div>`;
  }).join('');

  // Bind action buttons
  this._bindMemberListActions(list);
},

_bindMemberListActions(container) {
  const self = this;

  // DM (Send Message)
  container.querySelectorAll('.aml-btn-dm').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const uid = parseInt(btn.dataset.uid);
      self.socket.emit('start-dm', { targetUserId: uid });
      document.getElementById('all-members-modal').style.display = 'none';
      self._showToast(t('users.opening_dm', { name: btn.dataset.uname }), 'info');
    });
  });

  // Set Nickname
  container.querySelectorAll('.aml-btn-nick').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const uid = parseInt(btn.dataset.uid);
      const uname = btn.dataset.uname;
      self._showNicknameDialog(uid, uname);
    });
  });

  // Assign Role
  container.querySelectorAll('.aml-btn-role').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const uid = parseInt(btn.dataset.uid);
      document.getElementById('all-members-modal').style.display = 'none';
      self._openRoleAssignCenter(uid);
    });
  });

  // Add to Channel
  container.querySelectorAll('.aml-btn-addch').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const uid = parseInt(btn.dataset.uid);
      const uname = btn.dataset.uname;
      self._openMemberChannelPicker(uid, uname, 'add');
    });
  });

  // Remove from Channel
  container.querySelectorAll('.aml-btn-remch').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const uid = parseInt(btn.dataset.uid);
      const uname = btn.dataset.uname;
      self._openMemberChannelPicker(uid, uname, 'remove');
    });
  });

  // Ban
  container.querySelectorAll('.aml-btn-ban').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const uid = parseInt(btn.dataset.uid);
      const uname = btn.dataset.uname;
      self._showAdminActionModal('ban', uid, uname);
    });
  });

  // Unban
  container.querySelectorAll('.aml-btn-unban').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const uid = parseInt(btn.dataset.uid);
      self.socket.emit('unban-user', { userId: uid });
      self._showToast(t('settings.admin.user_unbanned'), 'success');
      setTimeout(() => self._openAllMembersModal(), 500);
    });
  });

  // Delete
  container.querySelectorAll('.aml-btn-delete').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const uid = parseInt(btn.dataset.uid);
      const uname = btn.dataset.uname;
      self._showAdminActionModal('delete-user', uid, uname);
    });
  });
},

_openMemberChannelPicker(userId, username, mode) {
  // mode: 'add' or 'remove'
  const member = (this._allMembersData || []).find(m => m.id === userId);
  const allChannels = this._allMembersChannels || [];
  const memberChannelIds = new Set((member && member.channelList ? member.channelList : []).map(c => c.id));

  let channels;
  if (mode === 'add') {
    // Show channels user is NOT in (top-level only for clarity)
    channels = allChannels.filter(c => !memberChannelIds.has(c.id) && !c.parentId);
  } else {
    // Show channels user IS in
    channels = (member && member.channelList ? member.channelList : []);
  }

  if (channels.length === 0) {
    this._showToast(mode === 'add' ? t('settings.admin.already_in_all_channels', { name: username }) : t('settings.admin.not_in_any_channels', { name: username }), 'info');
    return;
  }

  // Build a picker overlay
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay aml-channel-picker-overlay';
  overlay.style.display = 'flex';
  overlay.style.zIndex = '100002';

  const title = mode === 'add'
    ? t('settings.admin.picker_add_title', { name: this._escapeHtml(username) })
    : t('settings.admin.picker_remove_title', { name: this._escapeHtml(username) });

  const allCheckboxId = `aml-ch-all-${userId}-${mode}`;

  overlay.innerHTML = `
    <div class="modal" style="max-width:380px;max-height:60vh;display:flex;flex-direction:column">
      <h4>${title}</h4>
      <div style="margin-bottom:8px">
        <label class="toggle-row" style="font-size:13px;gap:6px;cursor:pointer">
          <input type="checkbox" id="${allCheckboxId}">
          <span>${t('settings.admin.select_all')}</span>
        </label>
      </div>
      <div class="aml-channel-list" style="overflow-y:auto;flex:1;min-height:0;display:flex;flex-direction:column;gap:2px">
        ${channels.map(c => `
          <label class="aml-channel-row" style="display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:var(--radius-sm);cursor:pointer">
            <input type="checkbox" class="aml-ch-check" value="${c.id}" data-name="${this._escapeHtml(c.name)}">
            <span style="font-size:13px">#${this._escapeHtml(c.name)}</span>
          </label>
        `).join('')}
      </div>
      <div class="modal-actions" style="margin-top:8px">
        <button class="btn-sm aml-ch-cancel">${t('modals.common.cancel')}</button>
        <button class="btn-sm btn-accent aml-ch-confirm">${mode === 'add' ? t('settings.admin.picker_confirm_add') : t('settings.admin.picker_confirm_remove')}</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  // Select All checkbox
  const allCheck = overlay.querySelector(`#${allCheckboxId}`);
  const checks = overlay.querySelectorAll('.aml-ch-check');
  allCheck.addEventListener('change', () => {
    checks.forEach(cb => { cb.checked = allCheck.checked; });
  });

  // Close
  overlay.querySelector('.aml-ch-cancel').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  // Confirm
  overlay.querySelector('.aml-ch-confirm').addEventListener('click', () => {
    const selected = [...checks].filter(cb => cb.checked).map(cb => ({
      id: parseInt(cb.value),
      name: cb.dataset.name
    }));
    if (selected.length === 0) {
      this._showToast(t('settings.admin.select_channel_warning'), 'warning');
      return;
    }
    overlay.remove();

    let completed = 0;
    selected.forEach(ch => {
      if (mode === 'add') {
        this.socket.emit('invite-to-channel', { targetUserId: userId, channelId: ch.id });
      } else {
        this.socket.emit('remove-from-channel', { userId, channelId: ch.id }, (res) => {
          if (res && res.error) this._showToast(res.error, 'error');
        });
      }
      completed++;
    });

    const toastKey = mode === 'add'
      ? (selected.length === 1 ? 'settings.admin.channels_added_one' : 'settings.admin.channels_added_other')
      : (selected.length === 1 ? 'settings.admin.channels_removed_one' : 'settings.admin.channels_removed_other');
    this._showToast(t(toastKey, { count: selected.length }), 'success');
    // Refresh after a short delay
    setTimeout(() => this._openAllMembersModal(), 800);
  });
},

// ═══════════════════════════════════════════════════════
// @MENTION AUTOCOMPLETE
// ═══════════════════════════════════════════════════════

_checkMentionTrigger() {
  const input = document.getElementById('message-input');
  const cursor = input.selectionStart;
  const text = input.value.substring(0, cursor);

  // Look backwards from cursor for an '@' that starts a word
  const match = text.match(/@(\w{0,30})$/);
  if (match) {
    this.mentionStart = cursor - match[0].length;
    this.mentionQuery = match[1].toLowerCase();
    this._showMentionDropdown();
  } else {
    this._hideMentionDropdown();
  }
},

_showMentionDropdown() {
  const dropdown = document.getElementById('mention-dropdown');
  const query = this.mentionQuery;
  const filtered = this.channelMembers.filter(m =>
    m.username.toLowerCase().startsWith(query)
  ).slice(0, 8);

  if (filtered.length === 0) {
    dropdown.style.display = 'none';
    return;
  }

  dropdown.innerHTML = filtered.map((m, i) =>
    `<div class="mention-item${i === 0 ? ' active' : ''}" data-username="${this._escapeHtml(m.username)}">${this._escapeHtml(m.username)}</div>`
  ).join('');

  dropdown.style.display = 'block';

  dropdown.querySelectorAll('.mention-item').forEach(item => {
    item.addEventListener('click', () => {
      this._insertMention(item.dataset.username);
    });
  });
},

_hideMentionDropdown() {
  const dropdown = document.getElementById('mention-dropdown');
  if (dropdown) dropdown.style.display = 'none';
  this.mentionStart = -1;
  this.mentionQuery = '';
},

_navigateMentionDropdown(direction) {
  const dropdown = document.getElementById('mention-dropdown');
  const items = dropdown.querySelectorAll('.mention-item');
  if (items.length === 0) return;

  let activeIdx = -1;
  items.forEach((item, i) => { if (item.classList.contains('active')) activeIdx = i; });

  items.forEach(item => item.classList.remove('active'));
  let next = activeIdx + direction;
  if (next < 0) next = items.length - 1;
  if (next >= items.length) next = 0;
  items[next].classList.add('active');
},

_insertMention(username) {
  const input = document.getElementById('message-input');
  const before = input.value.substring(0, this.mentionStart);
  const after = input.value.substring(input.selectionStart);
  input.value = before + '@' + username + ' ' + after;
  input.selectionStart = input.selectionEnd = this.mentionStart + username.length + 2;
  input.focus();
  this._hideMentionDropdown();
},

// ═══════════════════════════════════════════════════════
// EMOJI AUTOCOMPLETE  (:name)
// ═══════════════════════════════════════════════════════

_checkEmojiTrigger() {
  const input = document.getElementById('message-input');
  const text = input.value;
  const cursor = input.selectionStart;

  // Walk backwards from cursor to find a ':' that starts a potential emoji token
  let colonIdx = -1;
  for (let i = cursor - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === ':') { colonIdx = i; break; }
    if (ch === ' ' || ch === '\n') break; // stop at whitespace
  }

  if (colonIdx === -1) { this._hideEmojiDropdown(); return; }

  const query = text.substring(colonIdx + 1, cursor).toLowerCase();
  if (query.length < 2) { this._hideEmojiDropdown(); return; }

  this._emojiColonStart = colonIdx;
  this._showEmojiDropdown(query);
},

_showEmojiDropdown(query) {
  const dd = document.getElementById('emoji-dropdown');
  dd.innerHTML = '';

  let results = [];

  // Custom emojis first
  if (this.customEmojis) {
    this.customEmojis.forEach(em => {
      if (em.name.toLowerCase().includes(query)) {
        results.push({ type: 'custom', name: em.name, url: em.url });
      }
    });
  }

  // Standard emojis by name/keyword
  if (this.emojiNames) {
    for (const [char, keywords] of Object.entries(this.emojiNames)) {
      if (keywords.toLowerCase().includes(query)) {
        results.push({ type: 'standard', name: keywords.split(' ')[0], char });
      }
      if (results.length >= 20) break;
    }
  }

  results = results.slice(0, 10);
  if (!results.length) { this._hideEmojiDropdown(); return; }

  results.forEach((r, i) => {
    const item = document.createElement('div');
    item.className = 'emoji-ac-item' + (i === 0 ? ' active' : '');
    const preview = document.createElement('span');
    preview.className = 'emoji-ac-preview';
    if (r.type === 'custom') {
      const img = document.createElement('img');
      img.src = r.url;
      img.alt = r.name;
      img.style.width = '20px'; img.style.height = '20px';
      preview.appendChild(img);
    } else {
      preview.classList.add('emoji-ac-preview-char');
      preview.textContent = r.char;
    }
    const nameSpan = document.createElement('span');
    nameSpan.className = 'emoji-ac-name';
    nameSpan.textContent = ':' + r.name + ':';
    item.appendChild(preview);
    item.appendChild(nameSpan);
    item.addEventListener('click', () => {
      if (r.type === 'custom') {
        this._insertEmojiAc(':' + r.name + ':');
      } else {
        this._insertEmojiAc(r.char);
      }
    });
    dd.appendChild(item);
  });

  dd.style.display = 'block';
},

_hideEmojiDropdown() {
  const dd = document.getElementById('emoji-dropdown');
  if (dd) dd.style.display = 'none';
},

_navigateEmojiDropdown(dir) {
  const dd = document.getElementById('emoji-dropdown');
  const items = dd.querySelectorAll('.emoji-ac-item');
  if (!items.length) return;
  let idx = -1;
  items.forEach((it, i) => { if (it.classList.contains('active')) idx = i; });
  items.forEach(it => it.classList.remove('active'));
  idx += dir;
  if (idx < 0) idx = items.length - 1;
  if (idx >= items.length) idx = 0;
  items[idx].classList.add('active');
  items[idx].scrollIntoView({ block: 'nearest' });
},

_insertEmojiAc(insert) {
  const input = document.getElementById('message-input');
  const before = input.value.substring(0, this._emojiColonStart);
  const after = input.value.substring(input.selectionStart);
  input.value = before + insert + ' ' + after;
  input.selectionStart = input.selectionEnd = this._emojiColonStart + insert.length + 1;
  input.focus();
  this._hideEmojiDropdown();
},

// ═══════════════════════════════════════════════════════
// SLASH COMMAND AUTOCOMPLETE
// ═══════════════════════════════════════════════════════

_checkSlashTrigger() {
  const input = document.getElementById('message-input');
  const text = input.value;

  // Only activate if text starts with / and cursor is in the first word
  if (text.startsWith('/') && !text.includes(' ') && text.length < 25) {
    const query = text.substring(1).toLowerCase();
    this._showSlashDropdown(query);
  } else {
    this._hideSlashDropdown();
  }
},

_showSlashDropdown(query) {
  const dropdown = document.getElementById('slash-dropdown');
  const filtered = this.slashCommands.filter(c =>
    c.cmd.startsWith(query)
  ).slice(0, 10);

  if (filtered.length === 0 || (query === '' && filtered.length === this.slashCommands.length)) {
    // Show all on empty query
    if (query === '') {
      // show all
    } else {
      dropdown.style.display = 'none';
      return;
    }
  }

  const shown = query === '' ? this.slashCommands.slice(0, 12) : filtered;

  dropdown.innerHTML = shown.map((c, i) =>
    `<div class="slash-item${i === 0 ? ' active' : ''}" data-cmd="${c.cmd}">
      <span class="slash-cmd">/${c.cmd}</span>
      ${c.args ? `<span class="slash-args">${this._escapeHtml(c.args)}</span>` : ''}
      <span class="slash-desc">${this._escapeHtml(c.desc)}</span>
    </div>`
  ).join('');

  dropdown.style.display = 'block';

  dropdown.querySelectorAll('.slash-item').forEach(item => {
    item.addEventListener('click', () => {
      this._insertSlashCommand(item.dataset.cmd);
    });
  });
},

_hideSlashDropdown() {
  const dropdown = document.getElementById('slash-dropdown');
  if (dropdown) dropdown.style.display = 'none';
},

_navigateSlashDropdown(direction) {
  const dropdown = document.getElementById('slash-dropdown');
  const items = dropdown.querySelectorAll('.slash-item');
  if (items.length === 0) return;

  let activeIdx = -1;
  items.forEach((item, i) => { if (item.classList.contains('active')) activeIdx = i; });

  items.forEach(item => item.classList.remove('active'));
  let next = activeIdx + direction;
  if (next < 0) next = items.length - 1;
  if (next >= items.length) next = 0;
  items[next].classList.add('active');
  items[next].scrollIntoView({ block: 'nearest' });
},

_insertSlashCommand(cmd) {
  const input = document.getElementById('message-input');
  const cmdDef = this.slashCommands.find(c => c.cmd === cmd);
  const needsArg = cmdDef && cmdDef.args && cmdDef.args.startsWith('<');
  input.value = '/' + cmd + (needsArg ? ' ' : '');
  input.selectionStart = input.selectionEnd = input.value.length;
  input.focus();
  this._hideSlashDropdown();
  // If no args needed and not a "needs space" command, could auto-send
  // but user might want to add optional args, so just fill it in
},

// ═══════════════════════════════════════════════════════
// ── User Status Picker ────────────────────────────────
// ═══════════════════════════════════════════════════════

_setupStatusPicker() {
  const userBar = document.querySelector('.user-bar');
  if (!userBar) return;

  // Insert status dot to the right of the username block
  const statusDot = document.createElement('span');
  statusDot.id = 'user-status-dot';
  statusDot.className = 'user-dot status-picker-dot';
  statusDot.title = t('app.profile.set_status');
  statusDot.addEventListener('click', (e) => { e.stopPropagation(); this._toggleStatusPicker(); });
  const userNames = userBar.querySelector('.user-names');
  if (userNames && userNames.nextSibling) {
    userBar.insertBefore(statusDot, userNames.nextSibling);
  } else {
    userBar.appendChild(statusDot);
  }

  // Build dropdown (opens downward to avoid clipping)
  const picker = document.createElement('div');
  picker.id = 'status-picker';
  picker.className = 'status-picker';
  picker.style.display = 'none';
  picker.innerHTML = `
    <div class="status-option" data-status="online"><span class="user-dot"></span> ${t('app.profile.online')}</div>
    <div class="status-option" data-status="away"><span class="user-dot away"></span> ${t('app.profile.away')}</div>
    <div class="status-option" data-status="dnd"><span class="user-dot dnd"></span> ${t('app.profile.dnd')}</div>
    <div class="status-option" data-status="invisible"><span class="user-dot invisible"></span> ${t('app.profile.invisible')}</div>
    <div class="status-text-row">
      <input type="text" id="status-text-input" placeholder="${t('app.profile.custom_status_placeholder')}" maxlength="128">
    </div>
  `;
  userBar.appendChild(picker);

  picker.querySelectorAll('.status-option').forEach(opt => {
    opt.addEventListener('click', () => {
      const status = opt.dataset.status;
      const statusText = document.getElementById('status-text-input').value.trim();
      // Track whether user manually chose a non-online status (away/dnd/invisible)
      this._manualStatusOverride = (status !== 'online');
      if (!this.socket?.connected) {
        // Queue status change for when socket reconnects
        this._pendingStatus = { status, statusText };
        this._showToast(t('toasts.status_pending_reconnect'), 'info');
      } else {
        this.socket.emit('set-status', { status, statusText });
      }
      picker.style.display = 'none';
    });
  });

  document.getElementById('status-text-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const statusText = e.target.value.trim();
      this.socket.emit('set-status', { status: this.userStatus, statusText });
      picker.style.display = 'none';
    }
  });

  // Close picker on outside click
  document.addEventListener('click', (e) => {
    if (!picker.contains(e.target) && e.target !== statusDot) {
      picker.style.display = 'none';
    }
  });
},

_toggleStatusPicker() {
  const picker = document.getElementById('status-picker');
  const dot = document.getElementById('user-status-dot');
  if (picker.style.display !== 'none' && picker.style.display !== '') {
    picker.style.display = 'none';
    return;
  }
  // Position the fixed picker relative to the status dot
  if (dot) {
    const rect = dot.getBoundingClientRect();
    picker.style.left = rect.left + 'px';
    // Open above or below depending on space
    const spaceBelow = window.innerHeight - rect.bottom;
    if (spaceBelow > 220) {
      picker.style.top = (rect.bottom + 4) + 'px';
      picker.style.bottom = 'auto';
    } else {
      picker.style.bottom = (window.innerHeight - rect.top + 4) + 'px';
      picker.style.top = 'auto';
    }
  }
  picker.style.display = 'block';
},

_updateStatusPickerUI() {
  const dot = document.getElementById('user-status-dot');
  if (dot) {
    dot.className = 'user-dot status-picker-dot';
    if (this.userStatus === 'away') dot.classList.add('away');
    else if (this.userStatus === 'dnd') dot.classList.add('dnd');
    else if (this.userStatus === 'invisible') dot.classList.add('invisible');
  }
},

// ═══════════════════════════════════════════════════════
// ── Idle Detection (auto-away after 10 min) ───────────
// ═══════════════════════════════════════════════════════

_setupIdleDetection() {
  const IDLE_TIMEOUT = 5 * 60 * 1000; // 5 minutes of no activity
  const HIDDEN_TIMEOUT = 2 * 60 * 1000; // 2 minutes when tab is hidden
  let lastActivity = Date.now();
  let idleEmitPending = false;

  const goIdle = () => {
    if (this.userStatus === 'online' && !this._manualStatusOverride) {
      this.userStatus = 'away';  // optimistic local update (server confirms via status-updated)
      this._updateStatusPickerUI();
      this.socket.emit('set-status', { status: 'away', statusText: this.userStatusText });
    }
  };

  const goOnline = () => {
    if (this.userStatus === 'away' && !this._manualStatusOverride) {
      this.userStatus = 'online';  // optimistic local update
      this._updateStatusPickerUI();
      this.socket.emit('set-status', { status: 'online', statusText: this.userStatusText });
    }
  };

  const resetIdle = () => {
    lastActivity = Date.now();
    // Restore from away if needed (debounced — only emit once)
    if (this.userStatus === 'away' && !this._manualStatusOverride && !idleEmitPending) {
      idleEmitPending = true;
      setTimeout(() => { idleEmitPending = false; goOnline(); }, 300);
    }
    // Notify server of activity for AFK voice tracking (throttled to once per 15s)
    if (this.voice?.inVoice && (!this._lastVoiceActivityPing || Date.now() - this._lastVoiceActivityPing > 15000)) {
      this._lastVoiceActivityPing = Date.now();
      this.socket.emit('voice-activity');
    }
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(goIdle, document.hidden ? HIDDEN_TIMEOUT : IDLE_TIMEOUT);
  };
  // Expose so voice speech detection can reset idle & presence
  this._resetIdle = resetIdle;

  // Only fire on intentional input — NOT mousemove (micro-jitters keep resetting)
  ['keydown', 'click', 'scroll', 'touchstart', 'mousedown'].forEach(evt => {
    document.addEventListener(evt, resetIdle, { passive: true });
  });

  // Tab visibility: go idle faster when tab is hidden, come back when visible
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(goIdle, HIDDEN_TIMEOUT);
    } else {
      resetIdle();
    }
  });

  resetIdle();
},

// ═══════════════════════════════════════════════════════
// ── General File Upload ───────────────────────────────
// ═══════════════════════════════════════════════════════

_setupFileUpload() {
  // Merged into upload-btn — no separate file button needed.
  // The unified upload button opens a file picker that accepts all types;
  // images are queued (with preview), other files upload immediately.
},

_handleFileUpload(input) {
  if (!input.files.length || !this.currentChannel) return;
  const file = input.files[0];
  this._uploadGeneralFile(file);
  input.value = '';
},

/** Upload any file via /api/upload-file — used by drag & drop, paste, and 📎 button */
_uploadGeneralFile(file) {
  if (!this.currentChannel) return this._showToast(t('media.select_channel_first'), 'error');
  // Block media uploads if disabled in this channel
  const _ugCh = this.channels.find(c => c.code === this.currentChannel);
  if (_ugCh && _ugCh.media_enabled === 0) {
    return this._showToast(t('media.uploads_disabled'), 'error');
  }
  const maxMb = parseInt(this.serverSettings?.max_upload_mb) || 25;
  if (file.size > maxMb * 1024 * 1024) {
    this._showToast(t('media.file_too_large', { maxMb }), 'error');
    return;
  }

  const formData = new FormData();
  formData.append('file', file);

  this._uploadWithProgress('/api/upload-file', formData)
  .then(data => {
    if (data.error) {
      this._showToast(data.error, 'error');
      return;
    }
    // Send as a message with file attachment format
    const sizeStr = this._formatFileSize(data.fileSize);
    let content;
    if (data.isImage) {
      content = data.url; // images render inline already
    } else {
      // Use a special file attachment format: [file:name](url|size)
      content = `[file:${data.originalName}](${data.url}|${sizeStr})`;
    }
    this.socket.emit('send-message', {
      code: this.currentChannel,
      content,
      replyTo: this.replyingTo ? this.replyingTo.id : null
    });
    this.notifications.play('sent');
    this._clearReply();
  })
  .catch(err => this._showToast(err.message || t('settings.admin.upload_failed'), 'error'));
},

_formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
},

// ═══════════════════════════════════════════════════════
// ── Resizable Sidebars ─────────────────────────────────

_setupResizableSidebars() {
  // Left sidebar resize (delta-based so it works with mod-mode panel repositioning)
  const sidebar = document.querySelector('.sidebar');
  const leftHandle = document.getElementById('sidebar-resize-handle');
  if (sidebar && leftHandle) {
    const savedLeft = localStorage.getItem('haven_sidebar_width');
    if (savedLeft) sidebar.style.width = savedLeft + 'px';

    let dragging = false, startX = 0, startW = 0;
    leftHandle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      dragging = true;
      startX = e.clientX;
      startW = sidebar.getBoundingClientRect().width;
      leftHandle.classList.add('dragging');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      // Flip direction when mod mode has moved this sidebar to the right
      const factor = sidebar.dataset.panelPos === 'right' ? -1 : 1;
      let w = startW + (e.clientX - startX) * factor;
      w = Math.max(200, Math.min(400, w));
      sidebar.style.width = w + 'px';
    });
    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      leftHandle.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      localStorage.setItem('haven_sidebar_width', parseInt(sidebar.style.width));
    });
  }

  // Right sidebar resize (delta-based)
  const rightSidebar = document.getElementById('right-sidebar');
  const rightHandle = document.getElementById('right-sidebar-resize-handle');
  if (rightSidebar && rightHandle) {
    const savedRight = localStorage.getItem('haven_right_sidebar_width');
    if (savedRight) rightSidebar.style.width = savedRight + 'px';

    let dragging = false, startX = 0, startW = 0;
    rightHandle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      dragging = true;
      startX = e.clientX;
      startW = rightSidebar.getBoundingClientRect().width;
      rightHandle.classList.add('dragging');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      // Default right-side: shrinks when moving right; flip if mod moved it left
      const factor = rightSidebar.dataset.panelPos === 'left' ? 1 : -1;
      let w = startW + (e.clientX - startX) * factor;
      w = Math.max(200, Math.min(400, w));
      rightSidebar.style.width = w + 'px';
    });
    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      rightHandle.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      localStorage.setItem('haven_right_sidebar_width', parseInt(rightSidebar.style.width));
    });
  }

  // Sidebar split handle (channels/DM divider)
  const splitHandle = document.getElementById('sidebar-split-handle');
  const splitContainer = document.getElementById('sidebar-split');
  const channelsPane = document.getElementById('channels-pane');
  const dmPane = document.getElementById('dm-pane');
  if (splitHandle && splitContainer && channelsPane && dmPane) {
    const savedRatio = localStorage.getItem('haven_sidebar_split_ratio');
    if (savedRatio) {
      channelsPane.style.flex = `${savedRatio} 1 0`;
      dmPane.style.flex = `${1 - parseFloat(savedRatio)} 1 0`;
    }

    let dragging = false;
    splitHandle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      dragging = true;
      splitHandle.classList.add('dragging');
      document.body.style.cursor = 'row-resize';
      document.body.style.userSelect = 'none';
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const rect = splitContainer.getBoundingClientRect();
      const y = e.clientY - rect.top;
      const total = rect.height;
      let ratio = y / total;
      ratio = Math.max(0.05, Math.min(0.95, ratio));
      channelsPane.style.flex = `${ratio} 1 0`;
      dmPane.style.flex = `${1 - ratio} 1 0`;
    });
    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      splitHandle.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      const chFlex = parseFloat(channelsPane.style.flex) || 0.6;
      localStorage.setItem('haven_sidebar_split_ratio', chFlex);
    });
  }
},

// ═══════════════════════════════════════════════════════
// DISCORD IMPORT
// ═══════════════════════════════════════════════════════

_setupDiscordImport() {
  const modal      = document.getElementById('import-modal');
  const stepUpload = document.getElementById('import-step-upload');
  const stepPreview= document.getElementById('import-step-preview');
  const stepDone   = document.getElementById('import-step-done');
  const dropzone   = document.getElementById('import-dropzone');
  const fileInput  = document.getElementById('import-file-input');
  const browseLink = document.getElementById('import-browse-link');
  const progressWrap = document.getElementById('import-upload-progress');
  const progressFill = document.getElementById('import-progress-fill');
  const statusText   = document.getElementById('import-upload-status');
  const channelList  = document.getElementById('import-channel-list');
  const executeBtn   = document.getElementById('import-execute-btn');
  const backBtn      = document.getElementById('import-back-btn');
  if (!modal) return;

  let currentImportId = null;
  let currentPreview  = null;

  const resetModal = () => {
    stepUpload.style.display  = '';
    stepPreview.style.display = 'none';
    stepDone.style.display    = 'none';
    progressWrap.style.display = 'none';
    progressFill.style.width  = '0%';
    statusText.textContent    = t('settings.admin.import_uploading');
    dropzone.style.display    = '';
    fileInput.value           = '';
    channelList.innerHTML     = '';
    currentImportId           = null;
    currentPreview            = null;
    // Reset connect tab state
    const cs1 = document.getElementById('import-connect-step-token');
    const cs2 = document.getElementById('import-connect-step-servers');
    const cs3 = document.getElementById('import-connect-step-channels');
    if (cs1) cs1.style.display = '';
    if (cs2) cs2.style.display = 'none';
    if (cs3) cs3.style.display = 'none';
    const cStatus = document.getElementById('import-connect-status');
    if (cStatus) { cStatus.style.display = 'none'; cStatus.textContent = ''; }
    const fStatus = document.getElementById('import-fetch-status');
    if (fStatus) { fStatus.style.display = 'none'; fStatus.textContent = ''; }
    // Reset to file tab
    document.querySelectorAll('.import-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === 'file'));
    const fileTab = document.getElementById('import-tab-file');
    const connectTab = document.getElementById('import-tab-connect');
    if (fileTab) fileTab.style.display = '';
    if (connectTab) connectTab.style.display = 'none';
  };

  // Open import modal
  document.getElementById('open-import-btn')?.addEventListener('click', () => {
    resetModal();
    modal.style.display = 'flex';
  });

  // Close
  document.getElementById('close-import-btn')?.addEventListener('click', () => {
    modal.style.display = 'none';
  });
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.style.display = 'none';
  });

  // Browse link
  browseLink?.addEventListener('click', (e) => {
    e.preventDefault();
    fileInput.click();
  });

  // File input change
  fileInput?.addEventListener('change', () => {
    if (fileInput.files.length) this._importUploadFile(fileInput.files[0]);
  });

  // Drag & drop
  dropzone?.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('drag-over');
  });
  dropzone?.addEventListener('dragleave', () => {
    dropzone.classList.remove('drag-over');
  });
  dropzone?.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('drag-over');
    const file = e.dataTransfer?.files?.[0];
    if (file) this._importUploadFile(file);
  });

  // Back button
  backBtn?.addEventListener('click', () => {
    resetModal();
  });

  // Select all / Deselect all toggle
  const toggleAllLink = document.getElementById('import-toggle-all');
  toggleAllLink?.addEventListener('click', (e) => {
    e.preventDefault();
    const boxes = channelList.querySelectorAll('input[type="checkbox"]');
    const allChecked = [...boxes].every(cb => cb.checked);
    boxes.forEach(cb => cb.checked = !allChecked);
    toggleAllLink.textContent = allChecked ? t('settings.admin.select_all') : t('settings.admin.deselect_all');
  });

  // Execute button
  executeBtn?.addEventListener('click', () => {
    if (!currentImportId || !currentPreview) return;
    const selected = [];
    channelList.querySelectorAll('.import-channel-row').forEach(row => {
      const cb = row.querySelector('input[type="checkbox"]');
      if (!cb?.checked) return;
      const nameInput = row.querySelector('input[type="text"]');
      selected.push({
        discordId: row.dataset.discordId,
        originalName: row.dataset.originalName,
        name: nameInput?.value?.trim() || row.dataset.originalName
      });
    });
    if (selected.length === 0) {
      alert(t('settings.admin.import_select_channel'));
      return;
    }
    const totalMsgs = currentPreview.channels
      .filter(c => selected.some(s => (s.discordId && s.discordId === c.discordId) || s.originalName === c.name))
      .reduce((sum, c) => sum + c.messageCount, 0);
    if (!confirm(t(selected.length === 1 ? 'settings.admin.import_confirm_one' : 'settings.admin.import_confirm_other', { count: selected.length, messages: totalMsgs.toLocaleString() }))) return;
    this._importExecute(currentImportId, selected);
  });

  // ── Tab switching ────────────────────────────────────
  document.querySelectorAll('.import-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.import-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const target = tab.dataset.tab;
      const fileTab = document.getElementById('import-tab-file');
      const connectTab = document.getElementById('import-tab-connect');
      if (fileTab) fileTab.style.display = target === 'file' ? '' : 'none';
      if (connectTab) connectTab.style.display = target === 'connect' ? '' : 'none';
    });
  });

  // ── Connect to Discord flow ──────────────────────────
  const connectBtn = document.getElementById('import-connect-btn');
  const connectStatus = document.getElementById('import-connect-status');

  connectBtn?.addEventListener('click', async () => {
    const tokenInput = document.getElementById('import-discord-token');
    const discordToken = tokenInput?.value?.trim();
    if (!discordToken) { this._showToast(t('settings.admin.import_paste_token'), 'error'); return; }

    connectBtn.disabled = true;
    connectBtn.textContent = '⏳';
    connectStatus.style.display = '';
    connectStatus.textContent = t('settings.admin.import_connecting');
    connectStatus.style.color = '';

    try {
      const res = await fetch('/api/import/discord/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + this.token },
        body: JSON.stringify({ discordToken })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Connection failed');

      // Show server list
      document.getElementById('import-connect-step-token').style.display = 'none';
      const serversStep = document.getElementById('import-connect-step-servers');
      serversStep.style.display = '';
      document.getElementById('import-discord-username').textContent = data.user.username;

      const serverList = document.getElementById('import-server-list');
      serverList.innerHTML = '';
      data.guilds.forEach(g => {
        const card = document.createElement('button');
        card.className = 'import-server-card';
        const iconUrl = g.icon
          ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png?size=64`
          : '';
        card.innerHTML = `
          ${iconUrl ? `<img src="${iconUrl}" alt="" class="import-server-icon">` : '<span class="import-server-icon-placeholder">🏠</span>'}
          <span class="import-server-name">${this._escapeHtml(g.name)}</span>
        `;
        card.addEventListener('click', () => this._importPickGuild(g));
        serverList.appendChild(card);
      });
    } catch (err) {
      connectStatus.textContent = '❌ ' + err.message;
      connectStatus.style.color = '#ed4245';
    } finally {
      connectBtn.disabled = false;
      connectBtn.textContent = t('settings.admin.import_connect_btn');
    }
  });

  // Disconnect
  document.getElementById('import-connect-disconnect')?.addEventListener('click', (e) => {
    e.preventDefault();
    document.getElementById('import-connect-step-servers').style.display = 'none';
    document.getElementById('import-connect-step-token').style.display = '';
    document.getElementById('import-discord-token').value = '';
  });

  // Back to servers from channels
  document.getElementById('import-connect-back-servers')?.addEventListener('click', (e) => {
    e.preventDefault();
    document.getElementById('import-connect-step-channels').style.display = 'none';
    document.getElementById('import-connect-step-servers').style.display = '';
  });

  // Toggle all channels in connect flow
  const connectToggleAll = document.getElementById('import-connect-toggle-all');
  connectToggleAll?.addEventListener('click', (e) => {
    e.preventDefault();
    const cList = document.getElementById('import-connect-channel-list');
    const boxes = cList.querySelectorAll('input[type="checkbox"]');
    const allChecked = [...boxes].every(cb => cb.checked);
    boxes.forEach(cb => cb.checked = !allChecked);
    connectToggleAll.textContent = allChecked ? t('settings.admin.select_all') : t('settings.admin.deselect_all');
  });

  // Fetch messages button
  document.getElementById('import-fetch-btn')?.addEventListener('click', () => {
    this._importConnectFetch();
  });

  // Expose state setters for the upload/execute helpers
  this._importSetState = (importId, preview) => {
    currentImportId = importId;
    currentPreview  = preview;
  };
},

async _importUploadFile(file) {
  const modal        = document.getElementById('import-modal');
  const dropzone     = document.getElementById('import-dropzone');
  const progressWrap = document.getElementById('import-upload-progress');
  const progressFill = document.getElementById('import-progress-fill');
  const statusText   = document.getElementById('import-upload-status');
  const stepUpload   = document.getElementById('import-step-upload');
  const stepPreview  = document.getElementById('import-step-preview');
  const channelList  = document.getElementById('import-channel-list');

  // Validate extension
  const ext = file.name.split('.').pop().toLowerCase();
  if (!['json', 'zip'].includes(ext)) {
    alert(t('settings.admin.import_file_type_error'));
    return;
  }

  // Show progress
  dropzone.style.display     = 'none';
  progressWrap.style.display = '';
  progressFill.style.width   = '0%';
  statusText.textContent     = t('settings.admin.import_uploading_file', { name: file.name });

  try {
    const formData = new FormData();
    formData.append('file', file);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/import/discord/upload');
    xhr.setRequestHeader('Authorization', 'Bearer ' + this.token);

    // Progress tracking
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) {
        const pct = Math.round((e.loaded / e.total) * 100);
        progressFill.style.width = pct + '%';
        statusText.textContent = t('settings.admin.import_uploading_pct', { pct });
      }
    });

    const result = await new Promise((resolve, reject) => {
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(JSON.parse(xhr.responseText));
        } else {
          try {
            const err = JSON.parse(xhr.responseText);
            reject(new Error(err.error || 'Upload failed'));
          } catch {
            reject(new Error('Upload failed (status ' + xhr.status + ')'));
          }
        }
      };
      xhr.onerror = () => reject(new Error('Network error'));
      xhr.send(formData);
    });

    // Switch to parsing
    progressFill.style.width = '100%';
    statusText.textContent = t('settings.admin.import_parsing');
    await new Promise(r => setTimeout(r, 300));

    // Show preview
    this._importSetState(result.importId, result);
    stepUpload.style.display  = 'none';
    stepPreview.style.display = '';

    // Format badge
    const badge = document.getElementById('import-format-badge');
    badge.textContent = result.format;
    badge.classList.toggle('official', result.format === 'Discord Data Package');

    document.getElementById('import-server-name').textContent = result.serverName;
    document.getElementById('import-total-msgs').textContent = t('settings.admin.import_total_messages', { count: result.totalMessages.toLocaleString() });

    // Build channel list
    channelList.innerHTML = '';
    result.channels.forEach(ch => {
      const row = document.createElement('div');
      row.className = 'import-channel-row';
      row.dataset.discordId = ch.discordId || '';
      row.dataset.originalName = ch.name;
      row.innerHTML = `
        <label>
          <input type="checkbox" checked>
          <span class="import-ch-name">
            <input type="text" value="${this._escapeHtml(ch.name)}" title="Rename channel">
          </span>
        </label>
        <span class="import-ch-count">${ch.messageCount.toLocaleString()} msgs</span>
      `;
      channelList.appendChild(row);
    });

  } catch (err) {
    statusText.textContent = '❌ ' + err.message;
    progressFill.style.width = '100%';
    progressFill.style.background = '#ed4245';
    setTimeout(() => {
      dropzone.style.display     = '';
      progressWrap.style.display = 'none';
      progressFill.style.background = '';
    }, 3000);
  }
},

// ── Discord Direct Connect helpers ────────────────────

async _importPickGuild(guild) {
  const serversStep = document.getElementById('import-connect-step-servers');
  const channelsStep = document.getElementById('import-connect-step-channels');
  const fetchStatus = document.getElementById('import-fetch-status');

  document.getElementById('import-connect-guild-name').textContent = guild.name;
  serversStep.style.display = 'none';
  channelsStep.style.display = '';
  fetchStatus.style.display = '';
  fetchStatus.textContent = t('settings.admin.import_loading_channels');
  fetchStatus.style.color = '';

  try {
    const discordToken = document.getElementById('import-discord-token')?.value?.trim();
    const res = await fetch('/api/import/discord/guild-channels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + this.token },
      body: JSON.stringify({ discordToken, guildId: guild.id })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load channels');

    const cList = document.getElementById('import-connect-channel-list');
    cList.innerHTML = '';
    let lastCategory = null;

    // Type icons for visual distinction
    const typeIcons = { text: '#', announcement: '📢', forum: '💬', media: '🖼️', thread: '🧵' };

    // Render channels grouped by category
    data.channels.forEach(ch => {
      if (ch.category && ch.category !== lastCategory) {
        const catDiv = document.createElement('div');
        catDiv.className = 'import-channel-category';
        catDiv.textContent = ch.category;
        cList.appendChild(catDiv);
        lastCategory = ch.category;
      }
      const icon = typeIcons[ch.type] || '#';
      const tagHint = ch.tags && ch.tags.length
        ? ` <span class="muted-text" style="font-size:10px">(${ch.tags.map(t => t.name).join(', ')})</span>`
        : '';
      const row = document.createElement('div');
      row.className = 'import-channel-row';
      row.dataset.channelId = ch.id;
      row.dataset.channelName = ch.name;
      row.dataset.channelTopic = ch.topic || '';
      row.dataset.channelCategory = ch.category || '';
      row.innerHTML = `
        <label>
          <input type="checkbox" checked>
          <span class="import-ch-name">${icon} ${this._escapeHtml(ch.name)}${tagHint}</span>
        </label>
        <span class="import-ch-count import-type-badge">${ch.type}</span>
      `;
      cList.appendChild(row);

      // Render threads nested under this channel
      if (data.threads) {
        const childThreads = data.threads.filter(t => t.parentId === ch.id);
        childThreads.forEach(t => {
          const tagStr = t.tags && t.tags.length
            ? ` <span class="muted-text" style="font-size:10px">[${t.tags.join(', ')}]</span>`
            : '';
          const tRow = document.createElement('div');
          tRow.className = 'import-channel-row import-thread-row';
          tRow.dataset.channelId = t.id;
          tRow.dataset.channelName = t.name;
          tRow.dataset.channelTopic = '';
          tRow.dataset.channelCategory = ch.category || '';
          tRow.innerHTML = `
            <label>
              <input type="checkbox" checked>
              <span class="import-ch-name">🧵 ${this._escapeHtml(t.name)}${tagStr}</span>
            </label>
            <span class="import-ch-count import-type-badge">thread</span>
          `;
          cList.appendChild(tRow);
        });
      }
    });

    // Render orphan threads (parent not in the list)
    if (data.threads) {
      const renderedParents = new Set(data.channels.map(c => c.id));
      const orphans = data.threads.filter(t => !renderedParents.has(t.parentId));
      if (orphans.length > 0) {
        const catDiv = document.createElement('div');
        catDiv.className = 'import-channel-category';
        catDiv.textContent = t('settings.admin.import_other_threads');
        cList.appendChild(catDiv);
        orphans.forEach(t => {
          const tRow = document.createElement('div');
          tRow.className = 'import-channel-row import-thread-row';
          tRow.dataset.channelId = t.id;
          tRow.dataset.channelName = t.name;
          tRow.dataset.channelTopic = '';
          tRow.dataset.channelCategory = t.category || '';
          tRow.innerHTML = `
            <label>
              <input type="checkbox" checked>
              <span class="import-ch-name">🧵 ${this._escapeHtml(t.name)}${t.parentName ? ` <span class="muted-text" style="font-size:10px">in #${this._escapeHtml(t.parentName)}</span>` : ''}</span>
            </label>
            <span class="import-ch-count import-type-badge">thread</span>
          `;
          cList.appendChild(tRow);
        });
      }
    }

    this._connectGuild = guild;
    fetchStatus.style.display = 'none';
  } catch (err) {
    fetchStatus.textContent = '❌ ' + err.message;
    fetchStatus.style.color = '#ed4245';
  }
},

async _importConnectFetch() {
  const cList = document.getElementById('import-connect-channel-list');
  const fetchBtn = document.getElementById('import-fetch-btn');
  const fetchStatus = document.getElementById('import-fetch-status');
  const stepUpload = document.getElementById('import-step-upload');
  const stepPreview = document.getElementById('import-step-preview');
  const channelList = document.getElementById('import-channel-list');

  // Build selected channel list
  const selected = [];
  cList.querySelectorAll('.import-channel-row').forEach(row => {
    const cb = row.querySelector('input[type="checkbox"]');
    if (!cb?.checked) return;
    selected.push({
      id: row.dataset.channelId,
      name: row.dataset.channelName,
      topic: row.dataset.channelTopic,
      category: row.dataset.channelCategory
    });
  });
  if (!selected.length) { this._showToast(t('settings.admin.select_channel_warning'), 'error'); return; }

  fetchBtn.disabled = true;
  fetchBtn.textContent = '⏳ Fetching...';
  fetchStatus.style.display = '';
  fetchStatus.textContent = t(selected.length === 1 ? 'settings.admin.import_fetching_one' : 'settings.admin.import_fetching_other', { count: selected.length });
  fetchStatus.style.color = '';

  try {
    const discordToken = document.getElementById('import-discord-token')?.value?.trim();
    const res = await fetch('/api/import/discord/fetch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + this.token },
      body: JSON.stringify({
        discordToken,
        guildName: this._connectGuild?.name || 'Discord Import',
        channels: selected
      })
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Fetch failed');

    // Transition to the standard preview step (reuses existing execute flow)
    this._importSetState(result.importId, result);
    stepUpload.style.display = 'none';
    stepPreview.style.display = '';

    const badge = document.getElementById('import-format-badge');
    badge.textContent = result.format;
    badge.classList.remove('official');

    document.getElementById('import-server-name').textContent = result.serverName;
    document.getElementById('import-total-msgs').textContent = t('settings.admin.import_total_messages', { count: result.totalMessages.toLocaleString() });

    channelList.innerHTML = '';
    result.channels.forEach(ch => {
      const row = document.createElement('div');
      row.className = 'import-channel-row';
      row.dataset.discordId = ch.discordId || '';
      row.dataset.originalName = ch.name;
      row.innerHTML = `
        <label>
          <input type="checkbox" checked>
          <span class="import-ch-name">
            <input type="text" value="${this._escapeHtml(ch.name)}" title="Rename channel">
          </span>
        </label>
        <span class="import-ch-count">${ch.messageCount.toLocaleString()} msgs</span>
      `;
      channelList.appendChild(row);
    });
  } catch (err) {
    fetchStatus.textContent = '❌ ' + err.message;
    fetchStatus.style.color = '#ed4245';
  } finally {
    fetchBtn.disabled = false;
    fetchBtn.textContent = `📥 ${t('settings.admin.import_fetch_btn')}`;
  }
},

async _importExecute(importId, selectedChannels) {
  const executeBtn = document.getElementById('import-execute-btn');
  const stepPreview = document.getElementById('import-step-preview');
  const stepDone    = document.getElementById('import-step-done');
  const doneMsg     = document.getElementById('import-done-msg');

  executeBtn.disabled = true;
  executeBtn.textContent = `⏳ ${t('settings.admin.import_importing')}`;

  try {
    const res = await fetch('/api/import/discord/execute', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + this.token
      },
      body: JSON.stringify({ importId, selectedChannels })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || t('settings.admin.import_failed'));

    // Show done step
    stepPreview.style.display = 'none';
    stepDone.style.display    = '';
    doneMsg.textContent = t(data.channelsCreated === 1 ? 'settings.admin.import_success_one' : 'settings.admin.import_success_other', { count: data.channelsCreated, messages: data.messagesImported.toLocaleString() });

    // Refresh channel list
    if (this.socket) this.socket.emit('get-channels');
  } catch (err) {
    alert(t('settings.admin.import_failed_alert', { error: err.message }));
  } finally {
    executeBtn.disabled = false;
    executeBtn.textContent = `📦 ${t('settings.admin.import_btn')}`;
  }
},

// ── Role Management ───────────────────────────────────
// ═══════════════════════════════════════════════════════

_initRoleManagement() {
  this._allRoles = [];
  this._selectedRoleId = null;

  // Open role editor modal
  document.getElementById('open-role-editor-btn')?.addEventListener('click', () => {
    this._openRoleModal();
  });
  document.getElementById('close-role-modal-btn')?.addEventListener('click', () => {
    document.getElementById('role-modal').style.display = 'none';
  });
  document.getElementById('create-role-btn')?.addEventListener('click', async () => {
    const name = await this._showPromptModal(t('settings.admin.roles_create_title'), t('settings.admin.roles_create_hint'));
    if (!name || !name.trim()) return;
    const levelStr = await this._showPromptModal(t('settings.admin.roles_level_title'), t('settings.admin.roles_level_hint'), '25');
    if (levelStr === null) return;
    const level = parseInt(levelStr, 10);
    if (isNaN(level) || level < 1 || level > 99) { this._showToast(t('settings.admin.roles_level_invalid'), 'error'); return; }
    this.socket.emit('create-role', { name: name.trim(), level, color: '#aaaaaa' }, (res) => {
      if (res.error) { this._showToast(res.error, 'error'); return; }
      this._showToast(t('settings.admin.roles_created'), 'success');
      this._loadRoles();
    });
  });

  // Assign role modal handlers
  document.getElementById('cancel-assign-role-btn')?.addEventListener('click', () => {
    document.getElementById('assign-role-modal').style.display = 'none';
  });
  document.getElementById('confirm-assign-role-btn')?.addEventListener('click', () => {
    const roleId = document.getElementById('assign-role-select').value;
    const userId = document.getElementById('assign-role-modal').dataset.userId;
    const scope = document.getElementById('assign-role-scope').value;
    if (!roleId || !userId) return;
    const channelId = scope !== 'server' ? parseInt(scope, 10) : null;
    this.socket.emit('assign-role', { userId: parseInt(userId, 10), roleId: parseInt(roleId, 10), channelId }, (res) => {
      if (res.error) { this._showToast(res.error, 'error'); return; }
      this._showToast(t('settings.admin.roles_assigned'), 'success');
      document.getElementById('assign-role-modal').style.display = 'none';
    });
  });

  // Listen for role updates
  this.socket.on('roles-updated', () => this._loadRoles());

  // Reset roles to default
  document.getElementById('reset-roles-btn')?.addEventListener('click', () => {
    if (!confirm(t('settings.admin.roles_reset_confirm'))) return;
    this.socket.emit('reset-roles-to-default', {}, (res) => {
      if (res.error) { this._showToast(res.error, 'error'); return; }
      this._showToast(t('settings.admin.roles_reset_success'), 'success');
      this._selectedRoleId = null;
      this._loadRoles();
    });
  });

  // Initialize centralized role assignment 3-pane modal
  this._initRoleAssignCenter();

  // Donors "thank you" modal
  this._initDonorsModal();
},

_loadRoles(cb) {
  this.socket.emit('get-roles', {}, (res) => {
    if (res.error) return;
    this._allRoles = res.roles || [];
    this._renderRolesPreview();
    if (document.getElementById('role-modal').style.display !== 'none') {
      this._renderRoleSidebar();
      this._renderRoleDetail();   // refresh detail panel so checkboxes reflect server state
    }
    if (typeof cb === 'function') cb();
  });
},

_renderRolesPreview() {
  const container = document.getElementById('roles-list-preview');
  if (!container) return;
  if (this._allRoles.length === 0) {
    container.innerHTML = `<p class="muted-text">${t('settings.admin.roles_no_custom')}</p>`;
    return;
  }
  container.innerHTML = this._allRoles.map(r =>
    `<div class="role-preview-item">
      <span class="role-color-dot" style="background:${this._safeColor(r.color, '#aaa')}"></span>
      <span>${this._escapeHtml(r.name)}${r.auto_assign ? ` <span title="${t('settings.admin.role_form.auto_assign')}" style="font-size:10px;opacity:0.6">⚡</span>` : ''}</span>
      <span class="muted-text" style="font-size:11px;margin-left:auto">Lv.${r.level}</span>
    </div>`
  ).join('');
},

_openRoleModal() {
  document.getElementById('role-modal').style.display = 'flex';
  this._loadRoles();
},

_renderRoleSidebar() {
  const list = document.getElementById('role-list-sidebar');
  if (!list) return;
  list.innerHTML = this._allRoles.map(r =>
    `<div class="role-sidebar-item${this._selectedRoleId === r.id ? ' active' : ''}" data-role-id="${r.id}">
      <span class="role-color-dot" style="background:${this._safeColor(r.color, '#aaa')}"></span>
      ${this._escapeHtml(r.name)}
    </div>`
  ).join('');
  list.querySelectorAll('.role-sidebar-item').forEach(el => {
    el.addEventListener('click', () => {
      this._selectedRoleId = parseInt(el.dataset.roleId, 10);
      this._renderRoleSidebar();
      this._renderRoleDetail();
    });
  });
},

_renderRoleDetail() {
  const panel = document.getElementById('role-detail-panel');
  const role = this._allRoles.find(r => r.id === this._selectedRoleId);
  if (!role) {
    panel.innerHTML = `<p class="muted-text" style="padding:20px;text-align:center">${t('settings.admin.roles_select_role')}</p>`;
    const sb = document.getElementById('save-role-btn'); if (sb) sb.style.display = 'none';
    return;
  }

  const allPerms = ALL_PERMS;
  const permLabels = PERM_LABELS;
  const rolePerms = role.permissions || [];

  panel.innerHTML = `
    <div class="role-detail-form">
      <label class="settings-label">${t('settings.admin.role_form.name')}</label>
      <input type="text" class="settings-text-input" id="role-edit-name" value="${this._escapeHtml(role.name)}" maxlength="30">
      <label class="settings-label" style="margin-top:8px;">${t('settings.admin.role_form.level')}</label>
      <input type="number" class="settings-number-input" id="role-edit-level" value="${role.level}" min="1" max="99">
      <label class="settings-label" style="margin-top:8px;">${t('settings.admin.role_form.color')}</label>
      <input type="color" id="role-edit-color" value="${role.color || '#aaaaaa'}" style="width:50px;height:30px;border:none;cursor:pointer">
      <label class="toggle-row" style="margin-top:12px;">
        <span>${t('settings.admin.role_form.auto_assign')}</span>
        <input type="checkbox" id="role-edit-auto-assign" ${role.auto_assign ? 'checked' : ''}>
      </label>
      <small class="muted-text" style="font-size:11px;">${t('settings.admin.role_form.auto_assign_hint')}</small>
      <div class="role-channel-access-section">
        <h5 class="settings-section-subtitle" style="margin-top:12px;">${t('settings.admin.role_form.channel_access')}</h5>
        <label class="toggle-row">
          <span>${t('settings.admin.role_form.link_channel_access')}</span>
          <input type="checkbox" id="role-edit-link-channel-access" ${role.link_channel_access ? 'checked' : ''}>
        </label>
        <small class="muted-text" style="font-size:11px;">${t('settings.admin.role_form.link_channel_access_hint')}</small>
        <div id="role-channel-access-panel" style="display:${role.link_channel_access ? 'block' : 'none'};margin-top:8px;">
          <div class="role-channel-access-list" id="role-channel-access-list">
            <p class="muted-text" style="padding:12px;text-align:center;font-size:12px">${t('modals.common.loading')}</p>
          </div>
          <button class="btn-sm btn-accent rca-reapply-btn" id="rca-reapply-btn">🔄 ${t('settings.admin.role_form.reapply_access')}</button>
        </div>
      </div>
      <h5 class="settings-section-subtitle" style="margin-top:12px;">${t('settings.admin.role_form.permissions')}</h5>
      ${allPerms.map(p => `
        <label class="toggle-row">
          <span>${permLabels[p] || p.replace(/_/g, ' ')}</span>
          <input type="checkbox" class="role-perm-checkbox" data-perm="${p}" ${rolePerms.includes(p) ? 'checked' : ''}>
        </label>
      `).join('')}
      <div style="margin-top:12px;display:flex;gap:8px">
        <button class="btn-sm danger" id="delete-role-btn">${t('settings.admin.role_form.delete')}</button>
      </div>
    </div>
  `;

  // Toggle channel access panel visibility
  const linkCheckbox = document.getElementById('role-edit-link-channel-access');
  const accessPanel = document.getElementById('role-channel-access-panel');
  linkCheckbox.addEventListener('change', () => {
    accessPanel.style.display = linkCheckbox.checked ? 'block' : 'none';
    if (linkCheckbox.checked) this._loadRoleChannelAccess(role.id);
  });
  // Load channel access if already enabled
  if (role.link_channel_access) this._loadRoleChannelAccess(role.id);

  // Reapply button
  document.getElementById('rca-reapply-btn').addEventListener('click', () => {
    if (!confirm(t('settings.admin.roles_reapply_confirm'))) return;
    this.socket.emit('reapply-role-access', { roleId: role.id }, (res) => {
      if (res && res.error) return this._showToast(res.error, 'error');
      this._showToast(t(res.affected === 1 ? 'settings.admin.roles_reapplied_one' : 'settings.admin.roles_reapplied_other', { count: res.affected }), 'success');
    });
  });

  // The Save button lives in the modal-actions bar (always visible). Show it
  // when a role is selected, and wire up the click handler.
  const saveBtn = document.getElementById('save-role-btn');
  saveBtn.style.display = '';
  // Remove old listener by cloning
  const freshSaveBtn = saveBtn.cloneNode(true);
  saveBtn.parentNode.replaceChild(freshSaveBtn, saveBtn);
  freshSaveBtn.addEventListener('click', () => {
    const perms = [...panel.querySelectorAll('.role-perm-checkbox:checked')].map(cb => cb.dataset.perm);
    const linkEnabled = document.getElementById('role-edit-link-channel-access').checked;
    freshSaveBtn.disabled = true;
    freshSaveBtn.textContent = t('settings.admin.roles_saving');

    // Collect channel access config
    const accessRows = [...panel.querySelectorAll('.rca-channel-row')];
    const accessData = accessRows.map(row => ({
      channelId: parseInt(row.dataset.channelId, 10),
      grant: row.querySelector('.rca-grant')?.checked || false,
      revoke: row.querySelector('.rca-revoke')?.checked || false
    })).filter(a => a.channelId);

    this.socket.emit('update-role', {
      roleId: role.id,
      name: document.getElementById('role-edit-name').value.trim(),
      level: parseInt(document.getElementById('role-edit-level').value, 10),
      color: document.getElementById('role-edit-color').value,
      autoAssign: document.getElementById('role-edit-auto-assign').checked,
      linkChannelAccess: linkEnabled,
      permissions: perms
    }, (res) => {
      if (res.error) { this._showToast(res.error, 'error'); freshSaveBtn.disabled = false; freshSaveBtn.textContent = t('settings.admin.roles_save'); return; }

      // Save channel access config separately
      if (linkEnabled && accessData.length) {
        this.socket.emit('update-role-channel-access', {
          roleId: role.id,
          linkEnabled: true,
          access: accessData
        }, (accRes) => {
          if (accRes && accRes.error) this._showToast(accRes.error, 'error');
        });
      } else if (!linkEnabled) {
        // Disable channel access linking
        this.socket.emit('update-role-channel-access', {
          roleId: role.id,
          linkEnabled: false,
          access: []
        });
      }

      // Reset button BEFORE re-render (re-render clones the button,
      // so the clone must inherit the clean state, not "Saving...").
      freshSaveBtn.disabled = false;
      freshSaveBtn.textContent = t('settings.admin.roles_save');

      // Use server-returned roles directly (no re-fetch needed)
      if (res.roles) {
        this._allRoles = res.roles;
        this._renderRolesPreview();
        if (document.getElementById('role-modal').style.display !== 'none') {
          this._renderRoleSidebar();
          this._renderRoleDetail();
        }
      } else {
        this._loadRoles();
      }
      this._showToast(t('settings.admin.roles_saved'), 'success');
    });
  });

  document.getElementById('delete-role-btn').addEventListener('click', () => {
    if (!confirm(t('settings.admin.roles_delete_confirm', { name: role.name }))) return;
    this.socket.emit('delete-role', { roleId: role.id }, (res) => {
      if (res.error) { this._showToast(res.error, 'error'); return; }
      this._showToast(t('settings.admin.roles_deleted'), 'success');
      this._selectedRoleId = null;
      this._loadRoles();
      this._renderRoleDetail();
    });
  });
},

_loadRoleChannelAccess(roleId) {
  const listEl = document.getElementById('role-channel-access-list');
  if (!listEl) return;
  listEl.innerHTML = `<p class="muted-text" style="padding:12px;text-align:center;font-size:12px">${t('modals.common.loading')}</p>`;

  this.socket.emit('get-role-channel-access', { roleId }, (res) => {
    if (res && res.error) {
      listEl.innerHTML = `<p class="muted-text" style="padding:12px;text-align:center;font-size:12px">${this._escapeHtml(res.error)}</p>`;
      return;
    }
    const channels = res.channels || [];
    const accessMap = {};
    (res.access || []).forEach(a => { accessMap[a.channel_id] = a; });

    if (!channels.length) {
      listEl.innerHTML = `<p class="muted-text" style="padding:12px;text-align:center;font-size:12px">${t('settings.admin.roles_no_channels')}</p>`;
      return;
    }

    // Build parent → sub hierarchy
    const parents = channels.filter(c => !c.parent_channel_id);
    const subMap = {};
    channels.filter(c => c.parent_channel_id).forEach(c => {
      if (!subMap[c.parent_channel_id]) subMap[c.parent_channel_id] = [];
      subMap[c.parent_channel_id].push(c);
    });

    let html = '';
    parents.forEach(p => {
      const pa = accessMap[p.id] || {};
      html += this._renderRcaRow(p, pa, false);
      (subMap[p.id] || []).forEach(s => {
        const sa = accessMap[s.id] || {};
        html += this._renderRcaRow(s, sa, true);
      });
    });
    listEl.innerHTML = html;
  });
},

_renderRcaRow(ch, access, isSub) {
  const grantChecked = access.grant_on_promote ? ' checked' : '';
  const revokeChecked = access.revoke_on_demote ? ' checked' : '';
  const lockIcon = ch.is_private ? ' 🔒' : '';
  return `<div class="rca-channel-row" data-channel-id="${ch.id}">
    <span class="rca-channel-name${isSub ? ' rca-sub' : ''}">${isSub ? '↳ ' : '# '}${this._escapeHtml(ch.name)}${lockIcon}</span>
    <label><input type="checkbox" class="rca-grant"${grantChecked}> ${t('settings.admin.roles_grant')}</label>
    <label><input type="checkbox" class="rca-revoke"${revokeChecked}> ${t('settings.admin.roles_revoke')}</label>
  </div>`;
},

// ═══════════════════════════════════════════════════════
// ── Channel Roles Modal ───────────────────────────────
// ═══════════════════════════════════════════════════════

_openChannelRolesModal(channelCode) {
  this._channelRolesCode = channelCode;
  this._channelRolesSelectedUser = null;
  this._channelRolesMembers = [];
  this._channelRolesChannelId = null;
  this._channelRolesSelectedRole = null;

  const modal = document.getElementById('channel-roles-modal');
  const ch = this.channels.find(c => c.code === channelCode);
  document.getElementById('channel-roles-channel-name').textContent = ch ? `# ${ch.name}` : '';
  document.getElementById('channel-roles-member-list').innerHTML = `<p class="channel-roles-no-members">${t('modals.common.loading')}</p>`;
  document.getElementById('channel-roles-actions').style.display = 'none';
  document.getElementById('channel-roles-role-detail').innerHTML =
    `<p class="muted-text" style="padding:12px;text-align:center;font-size:0.82rem">${t('settings.admin.roles_select_to_configure')}</p>`;
  modal.style.display = 'flex';

  // Fetch members + roles and all available roles in parallel
  this._loadRoles(() => {
    this._renderChannelRolesRoleList();
    this.socket.emit('get-channel-member-roles', { code: channelCode }, (res) => {
      if (res.error) {
        document.getElementById('channel-roles-member-list').innerHTML =
          `<p class="channel-roles-no-members">${this._escapeHtml(res.error)}</p>`;
        return;
      }
      this._channelRolesMembers = res.members || [];
      this._channelRolesChannelId = res.channelId;
      this._renderChannelRolesMembers();
      // Populate role dropdown
      const roleSel = document.getElementById('channel-roles-role-select');
      roleSel.innerHTML = `<option value="">${t('settings.admin.roles_select_dropdown')}</option>` +
        this._allRoles.map(r =>
          `<option value="${r.id}">● ${this._escapeHtml(r.name)} — Lv.${r.level}</option>`
        ).join('');
    });
  });
},

_renderChannelRolesMembers() {
  const list = document.getElementById('channel-roles-member-list');
  if (!this._channelRolesMembers.length) {
    list.innerHTML = `<p class="channel-roles-no-members">${t('settings.admin.roles_no_members')}</p>`;
    return;
  }

  // Sort alphabetically by display name
  const sorted = [...this._channelRolesMembers].sort((a, b) =>
    a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' })
  );

  list.innerHTML = sorted.map(m => {
    const sel = this._channelRolesSelectedUser === m.id ? ' selected' : '';
    const avatarSrc = m.avatar || `https://api.dicebear.com/7.x/identicon/svg?seed=${encodeURIComponent(m.loginName)}`;
    const shapeClass = m.avatarShape === 'square' ? ' square' : '';
    const badges = m.isAdmin
      ? `<span class="channel-roles-badge badge-admin"><span class="badge-dot" style="background:#e74c3c"></span>${t('settings.admin.badge_admin')}</span>`
      : (m.roles || []).map(r =>
          `<span class="channel-roles-badge"><span class="badge-dot" style="background:${this._safeColor(r.color, '#aaa')}"></span>${this._escapeHtml(r.name)}<span class="badge-scope">${r.scope === 'channel' ? '📌 Channel' : '🌐 Server'}</span><span class="revoke-btn" data-uid="${m.id}" data-rid="${r.roleId}" data-scope="${r.scope}" title="Revoke">✕</span></span>`
        ).join('') || `<span class="channel-roles-no-role">${t('settings.admin.roles_no_roles')}</span>`;

    return `<div class="channel-roles-member${sel}" data-uid="${m.id}">
      <img class="channel-roles-member-avatar${shapeClass}" src="${avatarSrc}" alt="">
      <div class="channel-roles-member-info">
        <span class="channel-roles-member-name">${this._escapeHtml(m.displayName)}</span>
        <span class="channel-roles-member-login">@${this._escapeHtml(m.loginName)}</span>
        <div class="channel-roles-member-badges">${badges}</div>
      </div>
    </div>`;
  }).join('');

  // Member click → select
  list.querySelectorAll('.channel-roles-member').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.revoke-btn')) return; // handled below
      const uid = parseInt(el.dataset.uid);
      this._channelRolesSelectedUser = uid;
      this._renderChannelRolesMembers();
      this._showChannelRolesActions(uid);
    });
  });

  // Revoke button clicks
  list.querySelectorAll('.revoke-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const uid = parseInt(btn.dataset.uid);
      const rid = parseInt(btn.dataset.rid);
      const scope = btn.dataset.scope;
      const channelId = scope === 'channel' ? this._channelRolesChannelId : null;
      this.socket.emit('revoke-role', { userId: uid, roleId: rid, channelId });
      this._showToast(t('settings.admin.roles_revoked'), 'success');
      // Refresh after a short delay
      setTimeout(() => this._refreshChannelRoles(), 400);
    });
  });
},

_showChannelRolesActions(userId) {
  const panel = document.getElementById('channel-roles-actions');
  const member = this._channelRolesMembers.find(m => m.id === userId);
  if (!member) { panel.style.display = 'none'; return; }
  panel.style.display = '';
  document.getElementById('channel-roles-selected-name').textContent = member.displayName;

  const currentDiv = document.getElementById('channel-roles-current-roles');

  // Admins cannot modify their own roles
  if (member.isAdmin && member.id === this.user.id) {
    currentDiv.innerHTML = '<span class="channel-roles-badge" style="background:rgba(231,76,60,0.2);color:#e74c3c"><span class="badge-dot" style="background:#e74c3c"></span>Admin</span>';
    const assignArea = panel.querySelector('.channel-roles-assign-area');
    if (assignArea) assignArea.style.display = 'none';
    return;
  }
  // Show assign area for non-self-admin targets
  const assignArea = panel.querySelector('.channel-roles-assign-area');
  if (assignArea) assignArea.style.display = '';

  if (member.isAdmin) {
    currentDiv.innerHTML = `<span class="channel-roles-badge badge-admin"><span class="badge-dot" style="background:#e74c3c"></span>${t('settings.admin.badge_admin')}</span>`;
  } else if (member.roles.length) {
    currentDiv.innerHTML = member.roles.map(r =>
      `<span class="channel-roles-badge"><span class="badge-dot" style="background:${this._safeColor(r.color, '#aaa')}"></span>${this._escapeHtml(r.name)} <span class="badge-scope">${r.scope === 'channel' ? '📌 Channel' : '🌐 Server'}</span></span>`
    ).join('');
  } else {
    currentDiv.innerHTML = `<span style="font-size:0.78rem;color:var(--text-muted)">${t('settings.admin.roles_no_assigned')}</span>`;
  }
},

_assignChannelRole() {
  const userId = this._channelRolesSelectedUser;
  if (!userId) return this._showToast(t('settings.admin.roles_select_member'), 'error');

  const roleId = parseInt(document.getElementById('channel-roles-role-select').value);
  if (!roleId) return this._showToast(t('settings.admin.roles_select_role'), 'error');

  const scopeVal = document.getElementById('channel-roles-scope-select').value;
  const channelId = scopeVal === 'channel' ? this._channelRolesChannelId : null;

  this.socket.emit('assign-role', { userId, roleId, channelId }, (res) => {
    if (res.error) return this._showToast(res.error, 'error');
    this._showToast(t('settings.admin.roles_assigned'), 'success');
    // Reset selection
    document.getElementById('channel-roles-role-select').value = '';
    // Refresh member list
    setTimeout(() => this._refreshChannelRoles(), 400);
  });
},

_refreshChannelRoles() {
  if (!this._channelRolesCode) return;
  this.socket.emit('get-channel-member-roles', { code: this._channelRolesCode }, (res) => {
    if (res.error) return;
    this._channelRolesMembers = res.members || [];
    this._renderChannelRolesMembers();
    // Re-select user if still valid
    if (this._channelRolesSelectedUser) {
      this._showChannelRolesActions(this._channelRolesSelectedUser);
    }
  });
},

/* ── Channel Roles: Role configuration panel ────────── */

_renderChannelRolesRoleList() {
  const list = document.getElementById('channel-roles-role-list');
  if (!list) return;
  if (!this._allRoles.length) {
    list.innerHTML = `<p style="font-size:0.82rem;color:var(--text-muted);text-align:center;padding:8px">${t('settings.admin.roles_none_yet')}</p>`;
    return;
  }
  list.innerHTML = this._allRoles.map(r =>
    `<div class="channel-roles-role-item${this._channelRolesSelectedRole === r.id ? ' active' : ''}" data-role-id="${r.id}">
      <span class="role-color-dot" style="background:${this._safeColor(r.color, '#aaa')}"></span>
      <span class="channel-roles-role-name">${this._escapeHtml(r.name)}</span>
      <span class="channel-roles-role-level">Lv.${r.level}</span>
    </div>`
  ).join('');
  list.querySelectorAll('.channel-roles-role-item').forEach(el => {
    el.addEventListener('click', () => {
      this._channelRolesSelectedRole = parseInt(el.dataset.roleId, 10);
      this._renderChannelRolesRoleList();
      this._renderChannelRolesRoleDetail();
    });
  });
},

_renderChannelRolesRoleDetail() {
  const panel = document.getElementById('channel-roles-role-detail');
  const role = this._allRoles.find(r => r.id === this._channelRolesSelectedRole);
  if (!role) {
    panel.innerHTML = `<p class="muted-text" style="padding:12px;text-align:center;font-size:0.82rem">${t('settings.admin.roles_select_to_configure')}</p>`;
    return;
  }

  const allPerms = ALL_PERMS;
  const permLabels = PERM_LABELS;
  const rolePerms = role.permissions || [];

  panel.innerHTML = `
    <div class="cr-role-form">
      <div class="cr-role-form-row">
        <label class="cr-role-label">${t('settings.admin.role_form.name')}</label>
        <input type="text" class="settings-text-input" id="cr-role-name" value="${this._escapeHtml(role.name)}" maxlength="30">
      </div>
      <div class="cr-role-form-row cr-role-inline">
        <div>
          <label class="cr-role-label">${t('settings.admin.role_form.level')}</label>
          <input type="number" class="settings-number-input" id="cr-role-level" value="${role.level}" min="1" max="99" style="width:60px">
        </div>
        <div>
          <label class="cr-role-label">${t('settings.admin.role_form.color')}</label>
          <input type="color" id="cr-role-color" value="${role.color || '#aaaaaa'}" style="width:36px;height:28px;border:none;cursor:pointer;background:none">
        </div>
      </div>
      <label class="cr-perm-toggle" style="margin-top:6px">
        <input type="checkbox" id="cr-role-auto-assign" ${role.auto_assign ? 'checked' : ''}>
        <span>${t('settings.admin.role_form.auto_assign')}</span>
      </label>
      <label class="cr-role-label" style="margin-top:4px">${t('settings.admin.role_form.permissions')}</label>
      <div class="cr-role-perms">
        ${allPerms.map(p => `
          <label class="cr-perm-toggle">
            <input type="checkbox" class="cr-perm-cb" data-perm="${p}" ${rolePerms.includes(p) ? 'checked' : ''}>
            <span>${permLabels[p] || p.replace(/_/g, ' ')}</span>
          </label>
        `).join('')}
      </div>
      <div class="cr-role-btns">
        <button class="btn-sm btn-accent" id="cr-save-role-btn">${t('settings.admin.roles_save')}</button>
        <button class="btn-sm danger" id="cr-delete-role-btn">${t('settings.admin.role_form.delete')}</button>
      </div>
    </div>
  `;

  document.getElementById('cr-save-role-btn').addEventListener('click', () => {
    const perms = [...panel.querySelectorAll('.cr-perm-cb:checked')].map(cb => cb.dataset.perm);
    const newLevel = parseInt(document.getElementById('cr-role-level').value, 10);
    if (isNaN(newLevel) || newLevel < 1 || newLevel > 99) { this._showToast(t('settings.admin.roles_level_invalid'), 'error'); return; }
    this.socket.emit('update-role', {
      roleId: role.id,
      name: document.getElementById('cr-role-name').value.trim(),
      level: newLevel,
      color: document.getElementById('cr-role-color').value,
      autoAssign: document.getElementById('cr-role-auto-assign').checked,
      permissions: perms
    }, (res) => {
      if (res.error) { this._showToast(res.error, 'error'); return; }
      this._showToast(t('settings.admin.roles_updated'), 'success');
      this._loadRoles(() => {
        this._renderChannelRolesRoleList();
        this._renderChannelRolesRoleDetail();
        this._refreshChannelRolesDropdown();
        this._refreshChannelRoles();
      });
    });
  });

  document.getElementById('cr-delete-role-btn').addEventListener('click', () => {
    if (!confirm(t('settings.admin.roles_delete_confirm', { name: role.name }))) return;
    this.socket.emit('delete-role', { roleId: role.id }, (res) => {
      if (res.error) { this._showToast(res.error, 'error'); return; }
      this._showToast(t('settings.admin.roles_deleted'), 'success');
      this._channelRolesSelectedRole = null;
      this._loadRoles(() => {
        this._renderChannelRolesRoleList();
        this._renderChannelRolesRoleDetail();
        this._refreshChannelRolesDropdown();
        this._refreshChannelRoles();
      });
    });
  });
},

async _createChannelRole() {
  const name = await this._showPromptModal(t('settings.admin.roles_create_title'), t('settings.admin.roles_create_hint'));
  if (!name || !name.trim()) return;
  const levelStr = await this._showPromptModal(t('settings.admin.roles_level_title'), t('settings.admin.roles_level_hint'), '25');
  if (levelStr === null) return;
  const level = parseInt(levelStr, 10);
  if (isNaN(level) || level < 1 || level > 99) { this._showToast(t('settings.admin.roles_level_invalid'), 'error'); return; }
  this.socket.emit('create-role', { name: name.trim(), level, color: '#aaaaaa' }, (res) => {
    if (res.error) { this._showToast(res.error, 'error'); return; }
    this._showToast(t('settings.admin.roles_created'), 'success');
    this._loadRoles(() => {
      this._renderChannelRolesRoleList();
      this._refreshChannelRolesDropdown();
    });
  });
},

_refreshChannelRolesDropdown() {
  const roleSel = document.getElementById('channel-roles-role-select');
  if (!roleSel) return;
  roleSel.innerHTML = `<option value="">${t('settings.admin.roles_select_dropdown')}</option>` +
    this._allRoles.map(r =>
      `<option value="${r.id}">● ${this._escapeHtml(r.name)} — Lv.${r.level}</option>`
    ).join('');
},

_openAssignRoleModal(userId, username) {
  const modal = document.getElementById('assign-role-modal');
  modal.dataset.userId = userId;
  document.getElementById('assign-role-user-label').textContent = t('settings.admin.roles_assigning_to', { name: username });

  // Populate role select with color-coded level info
  const sel = document.getElementById('assign-role-select');
  sel.innerHTML = `<option value="">${t('settings.admin.roles_select_dropdown')}</option>` + this._allRoles.map(r =>
    `<option value="${r.id}">● ${this._escapeHtml(r.name)} — Lv.${r.level}</option>`
  ).join('');

  // Populate scope with structured parent → sub-channel grouping
  const scopeSel = document.getElementById('assign-role-scope');
  const nonDm = this.channels.filter(c => !c.is_dm);
  const parents = nonDm.filter(c => !c.parent_channel_id);
  const subMap = {};
  nonDm.filter(c => c.parent_channel_id).forEach(c => {
    if (!subMap[c.parent_channel_id]) subMap[c.parent_channel_id] = [];
    subMap[c.parent_channel_id].push(c);
  });

  let scopeHtml = '<option value="server">🌐 Server-wide</option>';
  parents.forEach(p => {
    scopeHtml += `<option value="${p.id}"># ${this._escapeHtml(p.name)}</option>`;
    const subs = subMap[p.id] || [];
    subs.forEach(s => {
      scopeHtml += `<option value="${s.id}">&nbsp;&nbsp;└ ${this._escapeHtml(s.name)}</option>`;
    });
  });
  scopeSel.innerHTML = scopeHtml;
  modal.style.display = 'flex';
  modal.style.zIndex = '100002';
},

// ═══════════════════════════════════════════════════════
// CENTRALIZED ROLE ASSIGNMENT — Three-Pane Modal
// ═══════════════════════════════════════════════════════

_openRoleAssignCenter(preSelectUserId = null) {
  const modal = document.getElementById('role-assign-center-modal');
  modal.style.display = 'flex';
  modal.style.zIndex = '100003';

  // Reset state
  this._racData = null;
  this._racSelectedUser = null;
  this._racSelectedChannel = null; // null = server-wide, number = channel id
  this._racPendingChanges = {}; // key: `${userId}:${channelId||'server'}` → { roleId, level, permissions[] }

  document.getElementById('rac-user-list').innerHTML = `<p class="rac-placeholder">${t('modals.common.loading')}</p>`;
  document.getElementById('rac-channel-list').innerHTML = `<p class="rac-placeholder">${t('settings.admin.roles_select_user')}</p>`;
  document.getElementById('rac-config-body').innerHTML = `<p class="rac-placeholder">${t('settings.admin.roles_select_channel')}</p>`;
  document.getElementById('rac-save-btn').disabled = true;

  // Show admin-only buttons
  const manageBtn = document.getElementById('rac-manage-roles-btn');
  if (manageBtn) manageBtn.style.display = (this.user.isAdmin || this._hasPerm('manage_roles')) ? '' : 'none';

  this.socket.emit('get-role-assignment-data', {}, (res) => {
    if (res.error) { this._showToast(res.error, 'error'); return; }
    this._racData = res;
    this._renderRacUsers();
    if (preSelectUserId) {
      this._racSelectedUser = preSelectUserId;
      this._renderRacUsers();
      this._renderRacChannels();
    }
  });
},

_renderRacUsers(filter = '') {
  const list = document.getElementById('rac-user-list');
  if (!this._racData) return;
  const q = filter.toLowerCase();
  const users = this._racData.users.filter(u =>
    !q || u.username.toLowerCase().includes(q) || u.displayName.toLowerCase().includes(q)
  );

  if (users.length === 0) {
    list.innerHTML = `<p class="rac-placeholder">${t('settings.admin.roles_no_users')}</p>`;
    return;
  }

  list.innerHTML = users.map(u => {
    const color = this._getUserColor(u.username);
    const initial = u.displayName.charAt(0).toUpperCase();
    const shapeStyle = u.avatarShape === 'square' ? 'border-radius:4px' : '';
    const avatarInner = u.avatar
      ? `<img src="${this._escapeHtml(u.avatar)}" alt="${initial}" style="${shapeStyle}">`
      : initial;
    const activeClass = this._racSelectedUser === u.id ? ' active' : '';
    const roleNames = u.currentRoles
      .filter(r => !r.channel_id) // server-wide only for summary
      .map(r => r.name).join(', ') || t('settings.admin.roles_no_role');
    return `<div class="rac-user-item${activeClass}" data-uid="${u.id}">
      <div class="rac-user-avatar" style="background-color:${color};${shapeStyle}">${avatarInner}</div>
      <div class="rac-user-info">
        <span class="rac-user-name">${this._escapeHtml(this._getNickname(u.id, u.displayName))}</span>
        <span class="rac-user-level">${this._escapeHtml(roleNames)} – Lv.${u.serverLevel}</span>
      </div>
    </div>`;
  }).join('');

  list.querySelectorAll('.rac-user-item').forEach(el => {
    el.addEventListener('click', () => {
      this._racSelectedUser = parseInt(el.dataset.uid);
      this._racSelectedChannel = null;
      this._renderRacUsers(document.getElementById('rac-user-search').value);
      this._renderRacChannels();
      document.getElementById('rac-config-body').innerHTML = `<p class="rac-placeholder">${t('settings.admin.roles_select_channel')}</p>`;
    });
  });
},

_renderRacChannels() {
  const list = document.getElementById('rac-channel-list');
  if (!this._racData || !this._racSelectedUser) {
    list.innerHTML = `<p class="rac-placeholder">${t('settings.admin.roles_select_user')}</p>`;
    return;
  }

  const userId = this._racSelectedUser;
  const user = this._racData.users.find(u => u.id === userId);
  if (!user) return;

  const sharedIds = new Set(this._racData.userChannelMap[userId] || []);
  const channels = this._racData.channels;

  // Get current role per scope for this user
  const getRoleName = (channelId) => {
    const key = `${userId}:${channelId || 'server'}`;
    if (this._racPendingChanges[key]) {
      const pc = this._racPendingChanges[key];
      if (pc.action === 'revoke') return t('settings.admin.roles_revoked_badge');
      const pendingRole = this._racData.roles.find(r => r.id === pc.roleId);
      return pendingRole ? `${pendingRole.name} ✎` : '';
    }
    const match = user.currentRoles.filter(r => channelId ? r.channel_id === channelId : !r.channel_id);
    return match.map(r => r.name).join(', ') || '';
  };

  let html = '';

  // Admin: server-wide option
  if (this._racData.callerIsAdmin) {
    const serverActive = this._racSelectedChannel === 'server' ? ' active' : '';
    const serverRole = getRoleName(null);
    html += `<div class="rac-channel-item rac-server-wide${serverActive}" data-channel="server">
      <span class="rac-channel-icon">🌐</span>
      <span>${t('settings.admin.roles_server_wide')}</span>
      ${serverRole ? `<span class="rac-channel-current-role">${this._escapeHtml(serverRole)}</span>` : ''}
    </div>`;
  }

  // Parent channels
  const parents = channels.filter(c => !c.parentId);
  const subMap = {};
  channels.filter(c => c.parentId).forEach(c => {
    if (!subMap[c.parentId]) subMap[c.parentId] = [];
    subMap[c.parentId].push(c);
  });

  parents.forEach(p => {
    if (!sharedIds.has(p.id) && !this._racData.callerIsAdmin) return;
    const pActive = this._racSelectedChannel === p.id ? ' active' : '';
    const pRole = getRoleName(p.id);
    html += `<div class="rac-channel-item${pActive}" data-channel="${p.id}">
      <span class="rac-channel-icon">#</span>
      <span>${this._escapeHtml(p.name)}</span>
      ${pRole ? `<span class="rac-channel-current-role">${this._escapeHtml(pRole)}</span>` : ''}
    </div>`;

    const subs = subMap[p.id] || [];
    subs.forEach(s => {
      if (!sharedIds.has(s.id) && !this._racData.callerIsAdmin) return;
      const sActive = this._racSelectedChannel === s.id ? ' active' : '';
      const sRole = getRoleName(s.id);
      html += `<div class="rac-channel-item rac-sub${sActive}" data-channel="${s.id}">
        <span class="rac-channel-icon">└</span>
        <span>${this._escapeHtml(s.name)}</span>
        ${sRole ? `<span class="rac-channel-current-role">${this._escapeHtml(sRole)}</span>` : ''}
      </div>`;
    });
  });

  if (!html) {
    html = `<p class="rac-placeholder">${t('settings.admin.roles_no_shared_channels')}</p>`;
  }
  list.innerHTML = html;

  list.querySelectorAll('.rac-channel-item').forEach(el => {
    el.addEventListener('click', () => {
      const ch = el.dataset.channel;
      const prevChannel = this._racSelectedChannel;
      this._racSelectedChannel = ch === 'server' ? 'server' : parseInt(ch);

      // Carry forward pending modifications to the new channel so the user
      // doesn't have to re-configure the same role/permissions from scratch
      if (this._racSelectedUser && prevChannel != null && prevChannel !== this._racSelectedChannel) {
        const prevChId = prevChannel === 'server' ? null : prevChannel;
        const newChId  = this._racSelectedChannel === 'server' ? null : this._racSelectedChannel;
        const prevKey  = `${this._racSelectedUser}:${prevChId || 'server'}`;
        const newKey   = `${this._racSelectedUser}:${newChId || 'server'}`;
        const prevPending = this._racPendingChanges[prevKey];
        if (prevPending && !this._racPendingChanges[newKey]) {
          // Clone the previous config as a starting point for the new channel
          this._racPendingChanges[newKey] = {
            ...prevPending,
            customPerms: prevPending.customPerms ? [...prevPending.customPerms] : [],
            applyToSubs: false  // reset sub-channel toggle for new scope
          };
        }
      }

      this._renderRacChannels();
      this._renderRacConfig();
    });
  });
},

_renderRacConfig() {
  const body = document.getElementById('rac-config-body');
  if (!this._racData || !this._racSelectedUser || this._racSelectedChannel == null) {
    body.innerHTML = `<p class="rac-placeholder">${t('settings.admin.roles_select_channel')}</p>`;
    return;
  }

  const userId = this._racSelectedUser;
  const user = this._racData.users.find(u => u.id === userId);
  if (!user) return;

  const channelId = this._racSelectedChannel === 'server' ? null : this._racSelectedChannel;
  const key = `${userId}:${channelId || 'server'}`;

  // Current assignment (from server data)
  const currentRoles = user.currentRoles.filter(r =>
    channelId ? r.channel_id === channelId : !r.channel_id
  );
  const currentRole = currentRoles.length > 0 ? currentRoles[0] : null;

  // Pending changes (if any)
  const pending = this._racPendingChanges[key];

  const selectedRoleId = pending
    ? (pending.action === 'revoke' ? '' : pending.roleId)
    : (currentRole ? currentRole.role_id : '');
  const selectedLevel = pending && pending.level !== undefined
    ? pending.level
    : (currentRole ? currentRole.level : 0);

  // Available roles (filter to roles below caller's level for non-admins)
  const availableRoles = this._racData.roles.filter(r =>
    this._racData.callerIsAdmin || r.level < this._racData.callerLevel
  );

  // Current role display
  let currentHtml = '';
  if (currentRole) {
    currentHtml = `<div class="rac-current-role">
      <span class="rac-role-dot" style="background:${this._safeColor(currentRole.color, '#888')}"></span>
      ${this._escapeHtml(currentRole.name)} — Lv.${currentRole.level}
    </div>`;
  } else {
    currentHtml = `<div class="rac-current-role" style="opacity:0.5">${t('settings.admin.roles_no_assigned')}</div>`;
  }
  if (pending) {
    currentHtml += `<span class="rac-changed-badge">${t('settings.admin.roles_modified_badge')}</span>`;
  }

  // Determine which permissions the caller can grant
  const callerPerms = this._racData.callerPerms || [];
  const callerIsAdmin = this._racData.callerIsAdmin;
  const allPerms = ALL_PERMS;
  // Perms that only admin can grant
  const adminOnlyPerms = ['transfer_admin', 'manage_roles', 'manage_server', 'delete_channel'];
  // Perms that require the caller to have them to be able to grant
  const permLabels = PERM_LABELS;

  // If a role preset is selected, get its permissions
  const selectedRoleObj = availableRoles.find(r => r.id === Number(selectedRoleId));
  const presetPerms = selectedRoleObj ? (selectedRoleObj.permissions || []) : [];
  const presetLevel = selectedRoleObj ? selectedRoleObj.level : 0;

  // Custom permissions: if pending has custom perms, use those; otherwise start from preset
  const customPerms = pending && pending.customPerms
    ? pending.customPerms
    : [...presetPerms];

  // Custom level: if pending has custom level, use it; otherwise use preset
  const customLevel = pending && pending.level !== undefined
    ? pending.level
    : presetLevel;

  // Max level the caller can assign (own level - 1, or 99 for admin)
  const maxLevel = callerIsAdmin ? 99 : (this._racData.callerLevel - 1);

  // Check if the selected channel is a parent with sub-channels
  const isParentChannel = channelId && this._racData.channels.some(c => c.parentId === channelId);
  const applyToSubsChecked = pending && pending.applyToSubs ? ' checked' : '';

  body.innerHTML = `
    <div class="rac-config-section">
      <div class="rac-config-label">${t('settings.admin.roles_current_label')}</div>
      ${currentHtml}
    </div>

    <div class="rac-config-section">
      <div class="rac-config-label">${t('settings.admin.roles_assign_label')}</div>
      <div class="rac-config-row">
        <select class="rac-role-select" id="rac-role-dropdown">
          <option value="">-- No Role --</option>
          ${availableRoles.map(r =>
            `<option value="${r.id}" ${r.id === Number(selectedRoleId) ? 'selected' : ''}>● ${this._escapeHtml(r.name)} — Lv.${r.level}</option>`
          ).join('')}
        </select>
      </div>
    </div>

    ${selectedRoleId ? `
    <div class="rac-config-section">
      <div class="rac-config-label">${t('settings.admin.roles_level_label')} <span style="font-weight:400;text-transform:none;letter-spacing:0">${t('settings.admin.roles_level_max_hint', { maxLevel })}</span></div>
      <div class="rac-config-row">
        <input type="number" class="rac-level-input" id="rac-level-input" min="1" max="${maxLevel}" value="${customLevel}" style="width:80px">
        <span class="rac-level-hint" style="font-size:0.75rem;color:var(--text-muted)">${t('settings.admin.roles_preset_default', { level: presetLevel })}</span>
      </div>
    </div>
    ` : ''}

    ${isParentChannel && selectedRoleId ? `
    <div class="rac-config-section">
      <label class="rac-perm-item" style="padding:6px 0;">
        <input type="checkbox" id="rac-apply-subs"${applyToSubsChecked}>
        <strong>${t('settings.admin.roles_apply_to_subs')}</strong>
      </label>
    </div>
    ` : ''}

    <div class="rac-config-section">
      <div class="rac-config-label">${t('settings.admin.roles_perms_label')} <span style="font-weight:400;text-transform:none;letter-spacing:0">${t('settings.admin.roles_perms_customize_hint')}</span></div>
      <div class="rac-perms-grid" id="rac-perms-grid">
        ${allPerms.map(p => {
          const checked = customPerms.includes(p);
          // A perm is read-only if:
          // 1) Admin-only perm and caller is not admin, OR
          // 2) Caller doesn't have the perm themselves (can't grant what you don't have), OR
          // 3) No role is selected
          const callerHasPerm = callerIsAdmin || callerPerms.includes('*') || callerPerms.includes(p);
          const isAdminOnly = adminOnlyPerms.includes(p) && !callerIsAdmin;
          const isReadOnly = !selectedRoleId || isAdminOnly || !callerHasPerm;
          return `<label class="rac-perm-item${isReadOnly ? ' disabled' : ''}${checked ? ' checked' : ''}">
            <input type="checkbox" data-perm="${p}" ${checked ? 'checked' : ''} ${isReadOnly ? 'disabled' : ''}>
            ${permLabels[p] || p}
          </label>`;
        }).join('')}
      </div>
    </div>
  `;

  // Bind role dropdown change
  document.getElementById('rac-role-dropdown').addEventListener('change', (e) => {
    const roleId = e.target.value ? parseInt(e.target.value) : null;
    // When changing the preset, reset custom perms and level to the new preset's defaults
    if (roleId) {
      const roleObj = this._racData.roles.find(r => r.id === roleId);
      const pendingEntry = this._racPendingChanges[key] || {};
      this._racPendingChanges[key] = {
        action: 'assign',
        roleId: roleId,
        level: roleObj ? roleObj.level : 0,
        customPerms: roleObj ? [...(roleObj.permissions || [])] : [],
        applyToSubs: pendingEntry.applyToSubs || false
      };
    } else {
      this._racUpdatePending(null);
      return;
    }
    const hasChanges = Object.keys(this._racPendingChanges).length > 0;
    document.getElementById('rac-save-btn').disabled = !hasChanges;
    this._renderRacChannels();
    this._renderRacConfig();
  });

  // Bind level input change
  const levelInput = document.getElementById('rac-level-input');
  if (levelInput) {
    levelInput.addEventListener('change', () => {
      let val = parseInt(levelInput.value);
      if (isNaN(val) || val < 1) val = 1;
      if (val > maxLevel) val = maxLevel;
      levelInput.value = val;
      if (this._racPendingChanges[key]) {
        this._racPendingChanges[key].level = val;
      } else {
        const roleObj = availableRoles.find(r => r.id === Number(selectedRoleId));
        this._racPendingChanges[key] = {
          action: 'assign',
          roleId: Number(selectedRoleId),
          level: val,
          customPerms: [...customPerms]
        };
      }
      const hasChanges = Object.keys(this._racPendingChanges).length > 0;
      document.getElementById('rac-save-btn').disabled = !hasChanges;
      this._renderRacChannels();
    });
  }

  // Bind apply-to-subs checkbox
  const subsCheck = document.getElementById('rac-apply-subs');
  if (subsCheck) {
    subsCheck.addEventListener('change', () => {
      if (this._racPendingChanges[key]) {
        this._racPendingChanges[key].applyToSubs = subsCheck.checked;
      }
    });
  }

  // Bind permission checkboxes (toggleable ones)
  document.querySelectorAll('#rac-perms-grid input[type="checkbox"]:not([disabled])').forEach(cb => {
    cb.addEventListener('change', () => {
      const perm = cb.dataset.perm;
      const pendingEntry = this._racPendingChanges[key] || {
        action: 'assign',
        roleId: Number(selectedRoleId),
        level: customLevel,
        customPerms: [...customPerms]
      };
      if (!pendingEntry.customPerms) pendingEntry.customPerms = [...customPerms];

      if (cb.checked) {
        if (!pendingEntry.customPerms.includes(perm)) pendingEntry.customPerms.push(perm);
      } else {
        pendingEntry.customPerms = pendingEntry.customPerms.filter(p => p !== perm);
      }
      this._racPendingChanges[key] = pendingEntry;
      const hasChanges = Object.keys(this._racPendingChanges).length > 0;
      document.getElementById('rac-save-btn').disabled = !hasChanges;
      // Update label styling
      cb.closest('.rac-perm-item').classList.toggle('checked', cb.checked);
      this._renderRacChannels();
    });
  });
},

_racUpdatePending(forceRoleId) {
  const userId = this._racSelectedUser;
  const channelId = this._racSelectedChannel === 'server' ? null : this._racSelectedChannel;
  const key = `${userId}:${channelId || 'server'}`;

  const roleId = forceRoleId !== undefined
    ? forceRoleId
    : (this._racPendingChanges[key] ? this._racPendingChanges[key].roleId : null);

  if (roleId === null || roleId === '') {
    // Check if user currently HAS a role at this scope — if so, queue a revocation
    const user = this._racData.users.find(u => u.id === userId);
    const currentRoles = user ? user.currentRoles.filter(r =>
      channelId ? r.channel_id === channelId : !r.channel_id
    ) : [];
    if (currentRoles.length > 0) {
      this._racPendingChanges[key] = {
        action: 'revoke',
        revokeRoleIds: currentRoles.map(r => r.role_id)
      };
    } else {
      delete this._racPendingChanges[key];
    }
  } else {
    const roleObj = this._racData.roles.find(r => r.id === Number(roleId));
    this._racPendingChanges[key] = {
      action: 'assign',
      roleId: Number(roleId),
      level: roleObj ? roleObj.level : 0
    };
  }

  const hasChanges = Object.keys(this._racPendingChanges).length > 0;
  document.getElementById('rac-save-btn').disabled = !hasChanges;

  // Re-render channel list to show updated badges
  this._renderRacChannels();
  // Re-render config to update "Modified" badge
  this._renderRacConfig();
},

_racSaveChanges() {
  const changes = Object.entries(this._racPendingChanges);
  if (changes.length === 0) return;

  // Expand applyToSubs: for any parent channel with applyToSubs, add entries for sub-channels
  const expandedChanges = [];
  for (const [key, val] of changes) {
    expandedChanges.push([key, val]);
    if (val.applyToSubs && val.action === 'assign') {
      const [userIdStr, scope] = key.split(':');
      const channelId = scope === 'server' ? null : parseInt(scope);
      if (channelId && this._racData) {
        const subs = this._racData.channels.filter(c => c.parentId === channelId);
        for (const sub of subs) {
          const subKey = `${userIdStr}:${sub.id}`;
          if (!this._racPendingChanges[subKey]) {
            expandedChanges.push([subKey, { ...val, applyToSubs: false }]);
          }
        }
      }
    }
  }

  let completed = 0;
  let errors = [];
  const total = expandedChanges.length;

  const onDone = () => {
    if (errors.length) {
      this._showToast(t('settings.admin.roles_save_errors', { count: errors.length, error: errors[0] }), 'error');
    } else {
      this._showToast(t(total === 1 ? 'settings.admin.roles_changes_saved_one' : 'settings.admin.roles_changes_saved_other', { count: total }), 'success');
      // Close modal after successful save
      document.getElementById('role-assign-center-modal').style.display = 'none';
    }
    this._racPendingChanges = {};
    document.getElementById('rac-save-btn').disabled = true;
    this.socket.emit('get-role-assignment-data', {}, (res) => {
      if (!res.error) {
        this._racData = res;
        this._renderRacUsers(document.getElementById('rac-user-search')?.value || '');
        this._renderRacChannels();
        this._renderRacConfig();
      }
    });
  };

  expandedChanges.forEach(([key, val]) => {
    const [userIdStr, scope] = key.split(':');
    const userId = parseInt(userIdStr);
    const channelId = scope === 'server' ? null : parseInt(scope);

    if (val.action === 'revoke') {
      // Revoke each role the user currently has at this scope
      const toRevoke = val.revokeRoleIds || [];
      if (toRevoke.length === 0) { completed++; if (completed === total) onDone(); return; }
      let revokeCount = 0;
      toRevoke.forEach(roleId => {
        this.socket.emit('revoke-role', { userId, roleId, channelId }, (res) => {
          revokeCount++;
          if (res && res.error) errors.push(res.error);
          if (revokeCount === toRevoke.length) {
            completed++;
            if (completed === total) onDone();
          }
        });
      });
    } else {
      this.socket.emit('assign-role', {
        userId,
        roleId: val.roleId,
        channelId,
        customLevel: val.level,
        customPerms: val.customPerms || null
      }, (res) => {
        completed++;
        if (res.error) errors.push(res.error);
        if (completed === total) onDone();
      });
    }
  });
},

_initRoleAssignCenter() {
  // Cancel button
  document.getElementById('rac-cancel-btn')?.addEventListener('click', () => {
    this._racPendingChanges = {};
    document.getElementById('role-assign-center-modal').style.display = 'none';
  });

  // Save button
  document.getElementById('rac-save-btn')?.addEventListener('click', () => {
    this._racSaveChanges();
  });

  // Close on overlay (outside) click
  document.getElementById('role-assign-center-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'role-assign-center-modal') {
      this._racPendingChanges = {};
      document.getElementById('role-assign-center-modal').style.display = 'none';
    }
  });

  // Manage Roles button (admin only - opens main role management modal)
  document.getElementById('rac-manage-roles-btn')?.addEventListener('click', () => {
    document.getElementById('role-assign-center-modal').style.display = 'none';
    this._loadRoles(() => {
      document.getElementById('role-modal').style.display = 'flex';
    });
  });

  // User search
  document.getElementById('rac-user-search')?.addEventListener('input', (e) => {
    this._renderRacUsers(e.target.value);
  });
},

_initDonorsModal() {
  const modal = document.getElementById('donors-modal');
  if (!modal) return;

  let donorData = null;

  const renderDonorList = (sort) => {
    const sg = document.getElementById('sponsors-grid');
    const dg = document.getElementById('donors-grid');
    sg.innerHTML = '';
    dg.innerHTML = '';
    if (!donorData) return;
    const sponsors = sort === 'featured' && donorData.featuredSponsors ? donorData.featuredSponsors : (donorData.sponsors || []);
    const allDonors = sort === 'featured' && donorData.featuredDonors ? donorData.featuredDonors : (donorData.donors || []);
    const sponsorSet = new Set(sponsors.map(n => n.toLowerCase()));
    const donors = allDonors.filter(n => !sponsorSet.has(n.toLowerCase()));
    sponsors.forEach(n => { const s = document.createElement('span'); s.className = 'donor-chip donor-sponsor'; s.textContent = n; sg.appendChild(s); });
    donors.forEach(n => { const s = document.createElement('span'); s.className = 'donor-chip'; s.textContent = n; dg.appendChild(s); });
  };

  // Fetch donor/sponsor list from server
  fetch('/api/donors').then(r => r.json()).then(d => {
    donorData = d;
    // Show toggle if featured order is available
    if (d.featuredSponsors || d.featuredDonors) {
      const toggle = document.getElementById('donors-sort-toggle');
      if (toggle) toggle.style.display = '';
    }
    renderDonorList('chronological');
  }).catch(() => {});

  // Sort toggle buttons
  document.getElementById('donors-sort-toggle')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.donors-sort-btn');
    if (!btn) return;
    document.querySelectorAll('.donors-sort-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    renderDonorList(btn.dataset.sort);
  });

  // Open on heart button click
  document.getElementById('donors-btn')?.addEventListener('click', () => {
    modal.style.display = 'flex';
  });

  // Close on X button
  document.getElementById('donors-close-btn')?.addEventListener('click', () => {
    modal.style.display = 'none';
  });

  // Close on overlay click
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.style.display = 'none';
  });
},

// ═══════════════════════════════════════════════════════
};
