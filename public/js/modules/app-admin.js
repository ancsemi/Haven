//Shared permission list instead of declaring the same multiple times
const ALL_PERMS = [
  'edit_own_messages', 'delete_own_messages', 'delete_message', 'delete_lower_messages',
  // ban_ip was accepted by the server but missing from this list, so the role
  // editor never rendered a checkbox for it. That made it ungrantable: the
  // "also ban IP" option on the ban dialog could only ever appear for admins,
  // no matter what a moderator's role said. (v3.43.0)
  'pin_message', 'archive_messages', 'kick_user', 'mute_user', 'ban_user', 'ban_ip',
  'rename_channel', 'rename_sub_channel', 'set_channel_topic', 'manage_sub_channels',
  // (#5467) Editing an existing channel's settings is its own grant, separate
  // from creating channels. Assign it channel-scoped to keep a moderator's
  // reach inside the channels they actually run.
  'manage_channel_settings',
  // (#5470) Hand out invite links without handing over the server. Holders
  // see and manage only the links they made.
  'create_channel', 'create_temp_channel', 'invite_users',
  'upload_files', 'use_voice', 'use_tts', 'manage_webhooks', 'use_ferry', 'mention_everyone', 'view_history',
  'view_all_members', 'view_all_channels', 'view_channel_members', 'manage_emojis', 'manage_stickers', 'manage_soundboard', 'manage_music_queue', 'promote_user',
  'manage_roles', 'manage_server', 'delete_channel', 'read_only_override', 'view_audit_log', 'manage_display_names'
];
// Permissions only the server owner (admin) may grant. Highlighted in the
// role editors and locked for non-admins; mirrors adminOnlyPerms in
// socketHandlers/roles.js.
const ADMIN_ONLY_PERMS = ['transfer_admin', 'manage_roles', 'manage_server', 'delete_channel', 'view_all_channels'];
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
  get ban_ip() { return t('permissions.ban_ip'); },
  get rename_channel() { return t('permissions.rename_channel'); },
  get rename_sub_channel() { return t('permissions.rename_sub_channel'); },
  get set_channel_topic() { return t('permissions.set_channel_topic'); },
  get manage_sub_channels() { return t('permissions.manage_sub_channels'); },
  get manage_channel_settings() { return t('permissions.manage_channel_settings'); },
  get create_channel() { return t('permissions.create_channel'); },
  get create_temp_channel() { return t('permissions.create_temp_channel'); },
  get invite_users() { return t('permissions.invite_users'); },
  get upload_files() { return t('permissions.upload_files'); },
  get use_voice() { return t('permissions.use_voice'); },
  get use_tts() { return t('permissions.use_tts'); },
  get manage_webhooks() { return t('permissions.manage_webhooks'); },
  get use_ferry() { return t('permissions.use_ferry'); },
  get mention_everyone() { return t('permissions.mention_everyone'); },
  get view_history() { return t('permissions.view_history'); },
  get view_all_members() { return t('permissions.view_all_members'); },
  get view_all_channels() { return t('permissions.view_all_channels'); },
  get view_channel_members() { return t('permissions.view_channel_members'); },
  get manage_emojis() { return t('permissions.manage_emojis'); },
  get manage_stickers() { return t('permissions.manage_stickers'); },
  get manage_soundboard() { return t('permissions.manage_soundboard'); },
  get manage_music_queue() { return t('permissions.manage_music_queue'); },
  get promote_user() { return t('permissions.promote_user'); },
  get manage_roles() { return t('permissions.manage_roles'); },
  get manage_server() { return t('permissions.manage_server'); },
  get delete_channel() { return t('permissions.delete_channel'); },
  get read_only_override() { return t('permissions.read_only_override'); },
  get view_audit_log() { return t('permissions.view_audit_log'); },
  get manage_display_names() { return t('permissions.manage_display_names'); }
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

/**
 * (#12) Fill the SSO fields from server settings, and warn when the toggle is
 * on but the server still reports SSO unusable — which in practice always
 * means OIDC_CLIENT_SECRET is missing from the environment, the one piece of
 * this configuration that is not stored in the database.
 */
_applyOidcSettings() {
  const s = this.serverSettings || {};
  const set = (id, value) => { const el = document.getElementById(id); if (el) el.value = value || ''; };
  const check = (id, on) => { const el = document.getElementById(id); if (el) el.checked = !!on; };

  set('oidc-issuer-url', s.oidc_issuer_url);
  set('oidc-client-id', s.oidc_client_id);
  set('oidc-scopes', s.oidc_scopes);
  set('oidc-button-label', s.oidc_button_label);
  check('oidc-enabled', s.oidc_enabled === '1');
  check('oidc-create-users', s.oidc_create_users !== '0');

  const warn = document.getElementById('oidc-secret-warning');
  if (!warn) return;
  const configured = s.oidc_enabled === '1' && !!s.oidc_issuer_url && !!s.oidc_client_id;
  if (!configured) { warn.style.display = 'none'; return; }
  fetch('/api/public-config')
    .then(r => r.json())
    .then(cfg => { warn.style.display = cfg && cfg.oidc_enabled ? 'none' : 'block'; })
    .catch(() => { /* leave the warning hidden rather than guess */ });
},

// Settings that can arrive either from the admin panel or from an environment
// variable. The stored setting always wins and the environment is the
// fallback, but nothing in the panel said so: a server started with
// SERVER_NAME=Foo showed an empty Server Name box, and typing in it silently
// took over from the env var for good. These notes spell out which value is
// live and what saving will do. (#5489)
_envHintFields: [
  { key: 'server_name',   input: 'server-name-input' },
  { key: 'stun_urls',     input: 'stun-urls-input' },
  { key: 'turn_url',      input: 'turn-url-input' },
  { key: 'turn_username', input: 'turn-username-input' },
  { key: 'turn_password', input: 'turn-password-input' },
  // TURN_SECRET has no field of its own — it belongs to the TURN block as a
  // whole, so its note hangs off the TURN server row.
  { key: 'turn_secret',   input: 'turn-url-input', standalone: true }
],

_applyEnvSettingHints() {
  const env = this.serverEnvSettings || {};
  for (const field of this._envHintFields) {
    const input = document.getElementById(field.input);
    if (!input) continue;
    const row = input.closest('.select-row') || input;
    const hintId = `env-hint-${field.key}`;
    let hint = document.getElementById(hintId);
    const info = env[field.key];

    if (!info) {
      if (hint) hint.remove();
      // Only the field's own entry may clear a placeholder it set.
      if (!field.standalone && input.dataset.envPlaceholder) {
        input.placeholder = input.dataset.envPlaceholder === '__none__' ? '' : input.dataset.envPlaceholder;
        delete input.dataset.envPlaceholder;
      }
      continue;
    }

    const stored = (this.serverSettings?.[field.key] || '').trim();
    let text;
    if (field.standalone) {
      text = t('settings.admin.env_turn_secret', { var: info.var });
    } else if (stored) {
      text = t('settings.admin.env_overridden', { var: info.var });
    } else if (info.secret) {
      text = t('settings.admin.env_in_use_secret', { var: info.var });
    } else {
      text = t('settings.admin.env_in_use', { var: info.var, value: info.value });
    }

    // Show the environment's value as the placeholder while nothing is stored,
    // so an empty box reads as "inherited" rather than "unset".
    if (!field.standalone && !stored && !info.secret && info.value) {
      if (input.dataset.envPlaceholder === undefined) {
        input.dataset.envPlaceholder = input.placeholder || '__none__';
      }
      input.placeholder = info.value;
    } else if (!field.standalone && input.dataset.envPlaceholder !== undefined) {
      input.placeholder = input.dataset.envPlaceholder === '__none__' ? '' : input.dataset.envPlaceholder;
      delete input.dataset.envPlaceholder;
    }

    if (!hint) {
      hint = document.createElement('small');
      hint.id = hintId;
      hint.className = 'settings-hint env-setting-hint';
      // Two settings can share a row (TURN_URL and TURN_SECRET), so queue
      // behind any note already sitting under it instead of jumping ahead.
      let anchor = row;
      while (anchor.nextElementSibling?.classList.contains('env-setting-hint')) {
        anchor = anchor.nextElementSibling;
      }
      anchor.insertAdjacentElement('afterend', hint);
    }
    hint.textContent = text;
  }
},

_applyServerSettings() {
  // Don't overwrite admin form inputs when settings modal is open (user may be editing)
  const modalOpen = document.getElementById('settings-modal')?.style.display === 'flex';

  if (!modalOpen) {
    const vis = document.getElementById('member-visibility-select');
    if (vis && this.serverSettings.member_visibility) {
      vis.value = this.serverSettings.member_visibility;
    }
    const refPol = document.getElementById('referrer-policy-select');
    if (refPol && this.serverSettings.referrer_policy) {
      refPol.value = this.serverSettings.referrer_policy;
    }
    // (#12) SSO. The client secret lives in the environment, so the only way
    // to tell an admin it is missing is to compare what they configured here
    // against whether the server reports SSO as actually usable.
    this._applyOidcSettings?.();
    // Auto-mod controls apply immediately rather than through the Save flow,
    // so they only need populating here. (v3.42.0)
    if (typeof this._applyAutomodSettings === 'function') this._applyAutomodSettings();
    const nameInput = document.getElementById('server-name-input');
    if (nameInput && this.serverSettings.server_name !== undefined) {
      nameInput.value = this.serverSettings.server_name || '';
    }
    const titleInput = document.getElementById('server-title-input');
    if (titleInput && this.serverSettings.server_title !== undefined) {
      titleInput.value = this.serverSettings.server_title || '';
    }
    const welcomeInput = document.getElementById('welcome-message-input');
    if (welcomeInput) {
      welcomeInput.value = this.serverSettings.welcome_message || '';
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
    const maxStickerKb = document.getElementById('max-sticker-kb');
    if (maxStickerKb) {
      maxStickerKb.value = this.serverSettings.max_sticker_kb || '1024';
    }
    const maxPollOpts = document.getElementById('max-poll-options');
    if (maxPollOpts) {
      maxPollOpts.value = this.serverSettings.max_poll_options || '10';
    }
    const sessionDur = document.getElementById('session-duration-days');
    if (sessionDur) {
      // Default to '0' (never) for new installs. Existing servers seeded with
      // '7' on older versions report '7' here and keep that value until the
      // admin picks something else. (#5391)
      sessionDur.value = this.serverSettings.session_duration_days ?? '0';
    }
    const maxMsgChars = document.getElementById('max-message-chars');
    if (maxMsgChars) {
      maxMsgChars.value = this.serverSettings.max_message_chars || '2000';
    }
    const whitelistToggle = document.getElementById('whitelist-enabled');
    if (whitelistToggle) {
      whitelistToggle.checked = this.serverSettings.whitelist_enabled === 'true';
    }
    const adminPwReset = document.getElementById('admin-password-reset-enabled');
    if (adminPwReset) {
      adminPwReset.checked = this.serverSettings.admin_password_reset_enabled === 'true';
    }
    const emojiAutoUpdate = document.getElementById('unicode-emoji-auto-update');
    if (emojiAutoUpdate) {
      emojiAutoUpdate.checked = this.serverSettings.unicode_emoji_auto_update === 'true';
    }

    // ── Voice & Connectivity (STUN/TURN) — #5399 ───
    const stunUrls = document.getElementById('stun-urls-input');
    if (stunUrls) stunUrls.value = this.serverSettings.stun_urls || '';
    const turnUrl = document.getElementById('turn-url-input');
    if (turnUrl) turnUrl.value = this.serverSettings.turn_url || '';
    const turnUser = document.getElementById('turn-username-input');
    if (turnUser) turnUser.value = this.serverSettings.turn_username || '';
    const turnPass = document.getElementById('turn-password-input');
    if (turnPass) turnPass.value = this.serverSettings.turn_password || '';

    this._applyEnvSettingHints?.(); // (#5489)

    // ── Auto-backup form ───
    const abEnabled = document.getElementById('auto-backup-enabled');
    if (abEnabled) abEnabled.checked = this.serverSettings.auto_backup_enabled === 'true';
    const abInterval = document.getElementById('auto-backup-interval');
    if (abInterval) abInterval.value = this.serverSettings.auto_backup_interval_hours || '24';
    const abRetention = document.getElementById('auto-backup-retention');
    if (abRetention) abRetention.value = this.serverSettings.auto_backup_retention || '7';
    const abSections = (this.serverSettings.auto_backup_sections || 'channels,users,settings,messages')
      .split(',').map(s => s.trim()).filter(Boolean);
    document.querySelectorAll('.auto-backup-include').forEach(el => {
      el.checked = abSections.includes(el.value);
    });
    if (typeof this._refreshAutoBackupList === 'function') this._refreshAutoBackupList();

    const updateBannerAdminOnly = document.getElementById('update-banner-admin-only');
    if (updateBannerAdminOnly) {
      updateBannerAdminOnly.checked = this.serverSettings.update_banner_admin_only === 'true';
    }
    const defaultTheme = document.getElementById('default-theme-select');
    if (defaultTheme) {
      defaultTheme.value = this.serverSettings.default_theme || '';
    }
    const defaultLocale = document.getElementById('default-locale-select');
    if (defaultLocale) {
      defaultLocale.value = this.serverSettings.default_locale || '';
    }
    this._renderAdminThemeList();

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

  // (#5344) Registration token — same live-update pattern as server code
  const tokenEl = document.getElementById('registration-token-value');
  if (tokenEl) {
    const tok = this.serverSettings.registration_token;
    tokenEl.textContent = tok || '—';
    tokenEl.style.opacity = tok ? '1' : '0.4';
  }
  const tokenToggle = document.getElementById('registration-token-enabled');
  if (tokenToggle) tokenToggle.checked = this.serverSettings.registration_token_enabled === 'true';
  const invBpsTokenToggle = document.getElementById('invites-bypass-registration-token');
  if (invBpsTokenToggle) invBpsTokenToggle.checked = this.serverSettings.invites_bypass_registration_token === 'true';

  const capToggle = document.getElementById('registration-captcha-enabled');
  if (capToggle) capToggle.checked = this.serverSettings.registration_captcha_enabled === 'true';
  const capSite = document.getElementById('turnstile-site-key');
  if (capSite) capSite.value = this.serverSettings.turnstile_site_key || '';
  const capSecret = document.getElementById('turnstile-secret-key');
  if (capSecret) capSecret.value = this.serverSettings.turnstile_secret_key || '';
  const rlToggle = document.getElementById('registration-rate-limit-enabled');
  if (rlToggle) rlToggle.checked = this.serverSettings.registration_rate_limit_enabled === 'true';
  const rlNum = document.getElementById('registration-rate-limit-per-hour');
  if (rlNum) rlNum.value = this.serverSettings.registration_rate_limit_per_hour || '20';
  const maxInvUses = document.getElementById('max-invite-uses');
  if (maxInvUses) maxInvUses.value = this.serverSettings.max_invite_uses || '0';
  

  // (#5345) Default join channels — re-render when settings or channel list refresh
  if (typeof this._renderDefaultJoinChannels === 'function') {
    try { this._renderDefaultJoinChannels(); } catch { /* non-critical */ }
  }

  // (#5381) Guest channel whitelist — re-render when settings change
  if (typeof this._renderGuestChannels === 'function') {
    try { this._renderGuestChannels(); } catch { /* non-critical */ }
  }

  // Managed invite links — paint the create-form channel list and pull the
  // current set of codes from the server (list arrives via 'invite-codes-list').
  if (typeof this._renderInviteCreateChannels === 'function') {
    try { this._renderInviteCreateChannels(); } catch { /* non-critical */ }
  }
  if (this.socket?.connected) {
    try { this.socket.emit('get-invite-codes'); } catch { /* non-critical */ }
  }

  // Apply configurable message length limit to message input and edit textareas
  const _maxMsgChars = parseInt(this.serverSettings?.max_message_chars) || 2000;
  const msgInput = document.getElementById('message-input');
  if (msgInput) msgInput.maxLength = _maxMsgChars;
  document.querySelectorAll('.edit-textarea').forEach(el => { el.maxLength = _maxMsgChars; });

  // Refresh DM cleanup notice (#5340) when cleanup_enabled / cleanup_max_age_days
  // change live, so the banner appears or disappears without needing a channel switch.
  if (typeof this._updateDmCleanupNotice === 'function' && this.currentChannel) {
    const ch = this.channels.find(c => c.code === this.currentChannel);
    this._updateDmCleanupNotice(ch);
  }

  // Vanity code — update input if modal is open
  if (!modalOpen) {
    const vanityInput = document.getElementById('vanity-code-input');
    if (vanityInput) vanityInput.value = this.serverSettings.vanity_code || '';
  }

  // Server banner — always update display (display prefs from localStorage)
  const bannerDisplay = document.getElementById('server-banner-display');
  const bannerImg = document.getElementById('server-banner-img');
  const bannerPreview = document.getElementById('server-banner-preview');
  const mainEl = document.querySelector('.main');
  const headerMode = localStorage.getItem('haven_banner_header_mode') || 'full';
  const bannerHeight = parseInt(localStorage.getItem('haven_banner_height')) || 180;
  const bannerOffset = parseInt(localStorage.getItem('haven_banner_offset')) || 0;
  const hasBanner = !!this.serverSettings.server_banner;
  // Show/hide the banner display section in user settings
  const bannerSection = document.getElementById('section-banner-display');
  if (bannerSection) bannerSection.style.display = hasBanner ? '' : 'none';
  if (bannerDisplay && bannerImg) {
    if (hasBanner) {
      bannerImg.src = this.serverSettings.server_banner;
      bannerDisplay.style.display = '';
      bannerDisplay.style.height = bannerHeight + 'px';
      bannerImg.style.objectPosition = 'center ' + bannerOffset + '%';
      mainEl?.classList.add('has-banner');
      mainEl?.classList.remove('banner-mode-shaded', 'banner-mode-minimal', 'banner-mode-transparent');
      if (headerMode !== 'full') {
        mainEl?.classList.add('banner-mode-' + headerMode);
      }
    } else {
      bannerDisplay.style.display = 'none';
      bannerImg.src = '';
      mainEl?.classList.remove('has-banner', 'banner-mode-shaded', 'banner-mode-minimal', 'banner-mode-transparent');
    }
  }
  // Banner header mode dropdown (user settings)
  const headerModeSelect = document.getElementById('banner-header-mode');
  if (headerModeSelect) headerModeSelect.value = headerMode;
  // Banner height slider (user settings)
  const heightSlider = document.getElementById('banner-height-slider');
  const heightValue = document.getElementById('banner-height-value');
  if (heightSlider) {
    heightSlider.value = bannerHeight;
    if (heightValue) heightValue.textContent = bannerHeight + 'px';
  }
  // Banner offset slider (user settings)
  const offsetSlider = document.getElementById('banner-offset-slider');
  const offsetValue = document.getElementById('banner-offset-value');
  if (offsetSlider) {
    offsetSlider.value = bannerOffset;
    if (offsetValue) offsetValue.textContent = bannerOffset + '%';
  }

  // Role icon display checkboxes
  const riSidebar = document.getElementById('role-icon-sidebar');
  if (riSidebar) riSidebar.checked = (this.serverSettings.role_icon_sidebar || 'true') === 'true';
  const riChat = document.getElementById('role-icon-chat');
  if (riChat) riChat.checked = this.serverSettings.role_icon_chat === 'true';
  const riAfter = document.getElementById('role-icon-after-name');
  if (riAfter) riAfter.checked = this.serverSettings.role_icon_after_name === 'true';

  // (#5461) Reflect the saved channel-creator-role choice.
  this._renderChannelCreatorRoleSelect();

  if (bannerPreview) {
    if (this.serverSettings.server_banner) {
      bannerPreview.innerHTML = `<img src="${this._escapeHtml(this.serverSettings.server_banner)}" style="max-width:100%;max-height:80px;border-radius:6px;object-fit:cover">`;
    } else {
      bannerPreview.innerHTML = `<span class="muted-text" style="font-size:0.6875rem">${t('settings.admin.no_banner')}</span>`;
    }
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
    return `<div class="role-preview-item">${avatarHtml} <span style="font-weight:600">${this._escapeHtml(wh.name)}</span> <span style="opacity:0.5;font-size:0.6875rem">#${this._escapeHtml(wh.channel_name)}</span> ${statusDot}</div>`;
  }).join('');
},

_syncSettingsNav() {
  // Use the canonical authoritative flag from the server, not DOM visibility.
  const isAdmin = !!(this.user && this.user.isAdmin);
  const canManageEmojis = isAdmin || this._hasPerm('manage_emojis');
  const canManageStickers = isAdmin || this._hasPerm('manage_stickers') || this._hasPerm('manage_emojis');
  const canManageSounds = isAdmin || this._hasPerm('manage_soundboard');
  const canManageRoles = isAdmin || this._hasPerm('manage_roles');
  const canManageServer = isAdmin || this._hasPerm('manage_server');
  const canManageWebhooks = isAdmin || this._hasPerm('manage_webhooks');
  const canInviteUsers = isAdmin || this._hasPerm('invite_users'); // (#5470)
  const hasAnyAdminAccess = this._hasAnyAdminSettingsAccess();

  // Show/hide individual admin nav items (default: hidden for non-admins)
  document.querySelectorAll('.settings-nav-admin').forEach(el => {
    el.style.display = isAdmin ? '' : 'none';
  });
  // Show/hide the admin tab button + group + body — gate on ANY admin access
  const adminTab = document.querySelector('.settings-tab-admin');
  if (adminTab) adminTab.style.display = hasAnyAdminAccess ? '' : 'none';
  const adminNavGroup = document.querySelector('.settings-nav-admin-group');
  if (adminNavGroup) adminNavGroup.style.display = hasAnyAdminAccess ? '' : 'none';
  const adminBody = document.getElementById('settings-body-admin');
  // settings-body-admin display is governed by tab switching too — only force-hide
  // when the user has zero admin access so a stale 'block' doesn't leak through.
  if (adminBody && !hasAnyAdminAccess) adminBody.style.display = 'none';
  // Show/hide the admin save bar (only visible when admin tab is active AND has access)
  const saveBar = document.querySelector('.admin-save-bar');
  if (saveBar) {
    const adminTabActive = adminTab?.classList.contains('active');
    saveBar.style.display = (hasAnyAdminAccess && adminTabActive) ? '' : 'none';
  }
  // Show the Emojis settings tab for users with manage_emojis permission even if not full admin/mod
  // (#5335) manage_stickers also unhides this tab — the Stickers admin block
  // currently lives inside the Emojis section so users with sticker access
  // need to see that nav item even if they can't touch emojis themselves.
  const emojiNavItem = document.querySelector('.settings-nav-item[data-target="section-emojis"]');
  if (emojiNavItem && !isAdmin && (canManageEmojis || canManageStickers)) {
    emojiNavItem.style.display = '';
  }
  // Hide the emoji-only and sticker-only sub-blocks based on which perms the
  // user actually has, so a manage_stickers-only user doesn't see an Emoji
  // upload panel they can't use (and vice versa).
  const emojiBlock = document.getElementById('section-emojis');
  const stickerBlock = document.getElementById('section-stickers');
  if (emojiBlock && !isAdmin) emojiBlock.style.display = canManageEmojis ? '' : 'none';
  if (stickerBlock && !isAdmin) stickerBlock.style.display = canManageStickers ? '' : 'none';
  // Show the Sounds admin tab for users with manage_soundboard permission
  const soundsNavItem = document.querySelector('.settings-nav-item[data-target="section-sounds-admin"]');
  if (soundsNavItem && !isAdmin && canManageSounds) {
    soundsNavItem.style.display = '';
  }
  // Show Roles tab for users with manage_roles permission
  const rolesNavItem = document.querySelector('.settings-nav-item[data-target="section-roles"]');
  if (rolesNavItem && !isAdmin && canManageRoles) {
    rolesNavItem.style.display = '';
  }
  // Show Server settings tab for users with manage_server permission.
  // manage_server gates many categories on the server-side, so unhide the
  // full set of server-management nav items (categories with their own
  // dedicated perm — emojis/sounds/roles/audit log — are handled separately).
  if (!isAdmin && canManageServer) {
    const serverManagedTargets = [
      'section-branding',
      'section-members',
      'section-whitelist',
      'section-invite',
      'section-cleanup',
      'section-backup',
      'section-uploads',
      'section-tunnel',
      'section-bots',
      'section-import',
      'section-modmode'
    ];
    serverManagedTargets.forEach(target => {
      const navItem = document.querySelector(`.settings-nav-item[data-target="${target}"]`);
      if (navItem) navItem.style.display = '';
    });
  }
  // (#5470) invite_users reaches the Invite Links block and nothing else in
  // that section. The server code, the vanity link and the default-join list
  // are server configuration and stay behind manage_server, so hide those
  // rather than showing controls whose saves would be refused.
  const inviteNavItem = document.querySelector('.settings-nav-item[data-target="section-invite"]');
  const inviteLinksOnly = !isAdmin && !canManageServer && canInviteUsers;
  if (!isAdmin && !canManageServer) {
    if (inviteNavItem) inviteNavItem.style.display = canInviteUsers ? '' : 'none';
    const inviteSection = document.getElementById('section-invite');
    if (inviteSection) inviteSection.style.display = canInviteUsers ? '' : 'none';
  }
  document.querySelectorAll('#section-invite .invite-server-config').forEach(el => {
    el.style.display = inviteLinksOnly ? 'none' : '';
  });
  // With everything above it hidden, the block's divider has nothing to divide.
  document.getElementById('invite-links-block')
    ?.classList.toggle('invite-links-flush', inviteLinksOnly);
  // Show Bots tab for users with manage_webhooks permission
  const botsNavItem = document.querySelector('.settings-nav-item[data-target="section-bots"]');
  if (botsNavItem && !isAdmin && canManageWebhooks) {
    botsNavItem.style.display = '';
  }
  // Show Audit Log nav item for users with view_audit_log permission
  const canViewAuditLog = isAdmin || this._hasPerm('view_audit_log');
  const auditNavItem = document.querySelector('.settings-nav-item[data-target="section-audit-log"]');
  if (auditNavItem) auditNavItem.style.display = canViewAuditLog ? '' : 'none';
  // Make sure the admin tab/group/body are visible if the user only has audit-log access
  if (canViewAuditLog && !hasAnyAdminAccess) {
    if (adminTab) adminTab.style.display = '';
    if (adminNavGroup) adminNavGroup.style.display = '';
  }

  // Moderation section (idle-online oversight, v3.46.0). Visible to admins and
  // to moderators who can act on it — the same bar the server enforces. A
  // non-admin mod sees ONLY this section, not the admin-only ones, because
  // every other admin nav item stays display:none unless isAdmin.
  const canSeeOversight = isAdmin || this._hasPerm('view_audit_log') ||
    this._hasPerm('ban_user') || this._hasPerm('kick_user') || this._hasPerm('view_all_members');
  const modNavItem = document.querySelector('.settings-nav-item[data-target="section-moderation"]');
  if (modNavItem) modNavItem.style.display = canSeeOversight ? '' : 'none';
  if (canSeeOversight && !hasAnyAdminAccess) {
    if (adminTab) adminTab.style.display = '';
    if (adminNavGroup) adminNavGroup.style.display = '';
  }
  // Also show save bar for users with manage_server perm (when admin tab active)
  if (saveBar && !isAdmin && this._hasPerm('manage_server')) {
    const adminTabActive = adminTab?.classList.contains('active');
    if (adminTabActive) saveBar.style.display = '';
  }
},

_snapshotAdminSettings() {
  this._adminSnapshot = {
    // Empty means "nothing stored", which is what lets SERVER_NAME (or the
    // built-in default) take over. Snapshotting it as 'HAVEN' made clearing
    // the box save the literal word instead of falling back. (#5489)
    server_name: this.serverSettings.server_name || '',
    server_title: this.serverSettings.server_title || '',
    welcome_message: this.serverSettings.welcome_message || '',
    member_visibility: this.serverSettings.member_visibility || 'online',
    referrer_policy: this.serverSettings.referrer_policy || 'same-origin', // must match DEFAULT_REFERRER_POLICY in server.js
    cleanup_enabled: this.serverSettings.cleanup_enabled || 'false',
    cleanup_max_age_days: this.serverSettings.cleanup_max_age_days || '0',
    cleanup_max_size_mb: this.serverSettings.cleanup_max_size_mb || '0',
    whitelist_enabled: this.serverSettings.whitelist_enabled || 'false',
    max_upload_mb: this.serverSettings.max_upload_mb || '25',
    max_sound_kb: this.serverSettings.max_sound_kb || '1024',
    max_emoji_kb: this.serverSettings.max_emoji_kb || '256',
    max_sticker_kb: this.serverSettings.max_sticker_kb || '1024',
    max_poll_options: this.serverSettings.max_poll_options || '10',
    session_duration_days: this.serverSettings.session_duration_days || '7',
    max_message_chars: this.serverSettings.max_message_chars || '2000',
    update_banner_admin_only: this.serverSettings.update_banner_admin_only || 'false',
    admin_password_reset_enabled: this.serverSettings.admin_password_reset_enabled || 'false',
    unicode_emoji_auto_update: this.serverSettings.unicode_emoji_auto_update || 'false',
    registration_captcha_enabled: this.serverSettings.registration_captcha_enabled || 'false',
    turnstile_site_key: this.serverSettings.turnstile_site_key || '',
    turnstile_secret_key: this.serverSettings.turnstile_secret_key || '',
    registration_rate_limit_enabled: this.serverSettings.registration_rate_limit_enabled || 'false',
    registration_rate_limit_per_hour: this.serverSettings.registration_rate_limit_per_hour || '20',
    max_invite_uses: this.serverSettings.max_invite_uses || '0',
    default_theme: this.serverSettings.default_theme || '',
    default_locale: this.serverSettings.default_locale || '',
    published_themes: this.serverSettings.published_themes || '[]',
    custom_tos: this.serverSettings.custom_tos || '',
    role_icon_sidebar: this.serverSettings.role_icon_sidebar || 'true',
    role_icon_chat: this.serverSettings.role_icon_chat || 'false',
    role_icon_after_name: this.serverSettings.role_icon_after_name || 'false',
    stun_urls: this.serverSettings.stun_urls || '',
    turn_url: this.serverSettings.turn_url || '',
    turn_username: this.serverSettings.turn_username || '',
    turn_password: this.serverSettings.turn_password || '',
    channel_creator_role: this.serverSettings.channel_creator_role || ''
  };
  const tosEl = document.getElementById('custom-tos-input');
  if (tosEl) tosEl.value = this._adminSnapshot.custom_tos;
  // _applyServerSettings skips its input pass while the modal is open, so
  // refresh the environment notes here too — otherwise they stay stale from
  // whenever the panel was last closed. (#5489)
  this._applyEnvSettingHints?.();
  // Load webhooks list for admin preview
  if (this.user?.isAdmin || this._hasPerm('manage_webhooks')) {
    this.socket.emit('get-webhooks');
  }
  // Ferry holds a bot token for an account on another platform, so it is
  // admin-only rather than following manage_webhooks like the section above.
  const ferrySection = document.getElementById('section-ferry');
  if (ferrySection) {
    ferrySection.style.display = this.user?.isAdmin ? '' : 'none';
    if (this.user?.isAdmin) this.socket.emit('ferry:get-config');
  }
},

_saveAdminSettings() {
  if (!this.user?.isAdmin && !this._hasPerm('manage_server')) {
    document.getElementById('settings-modal').style.display = 'none';
    return;
  }
  const snap = this._adminSnapshot || {};
  let changed = false;

  const name = document.getElementById('server-name-input')?.value.trim() || '';
  if (name !== snap.server_name) {
    this.socket.emit('update-server-setting', { key: 'server_name', value: name });
    changed = true;
  }

  const title = document.getElementById('server-title-input')?.value.trim() || '';
  if (title !== (snap.server_title || '')) {
    this.socket.emit('update-server-setting', { key: 'server_title', value: title });
    changed = true;
  }

  const welcomeMsg = document.getElementById('welcome-message-input')?.value.trim() || '';
  if (welcomeMsg !== (snap.welcome_message || '')) {
    this.socket.emit('update-server-setting', { key: 'welcome_message', value: welcomeMsg });
    changed = true;
  }

  const vis = document.getElementById('member-visibility-select')?.value;
  if (vis && vis !== snap.member_visibility) {
    this.socket.emit('update-server-setting', { key: 'member_visibility', value: vis });
    changed = true;
  }

  const refPol = document.getElementById('referrer-policy-select')?.value;
  if (refPol && refPol !== snap.referrer_policy) {
    this.socket.emit('update-server-setting', { key: 'referrer_policy', value: refPol });
    changed = true;
  }

  // (#12) SSO / OIDC
  for (const [id, key, kind] of [
    ['oidc-enabled', 'oidc_enabled', 'bool'],
    ['oidc-create-users', 'oidc_create_users', 'bool'],
    ['oidc-issuer-url', 'oidc_issuer_url', 'text'],
    ['oidc-client-id', 'oidc_client_id', 'text'],
    ['oidc-scopes', 'oidc_scopes', 'text'],
    ['oidc-button-label', 'oidc_button_label', 'text'],
  ]) {
    const el = document.getElementById(id);
    if (!el) continue;
    const value = kind === 'bool' ? (el.checked ? '1' : '0') : el.value.trim();
    // A never-set toggle reads as undefined in the snapshot; oidc_create_users
    // defaults on, so treat undefined as its default rather than as a change.
    const previous = snap[key] !== undefined ? snap[key]
      : (key === 'oidc_create_users' ? '1' : (kind === 'bool' ? '0' : ''));
    if (value !== previous) {
      this.socket.emit('update-server-setting', { key, value });
      changed = true;
    }
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

  const maxUpload = String(Math.max(1, Math.min(102400, parseInt(document.getElementById('max-upload-mb')?.value) || 25)));
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

  const maxStickerKb = String(Math.max(256, Math.min(10240, parseInt(document.getElementById('max-sticker-kb')?.value) || 1024)));
  if (maxStickerKb !== (snap.max_sticker_kb || '1024')) {
    this.socket.emit('update-server-setting', { key: 'max_sticker_kb', value: maxStickerKb });
    changed = true;
  }

  const maxPollOpts = String(Math.max(2, Math.min(25, parseInt(document.getElementById('max-poll-options')?.value) || 10)));
  if (maxPollOpts !== (snap.max_poll_options || '10')) {
    this.socket.emit('update-server-setting', { key: 'max_poll_options', value: maxPollOpts });
    changed = true;
  }

  // session_duration_days: 0 means "never expire"; 1–365 days otherwise (#5391)
  const sessionDurDays = String(Math.max(0, Math.min(365, parseInt(document.getElementById('session-duration-days')?.value) || 0)));
  if (sessionDurDays !== (snap.session_duration_days ?? '0')) {
    this.socket.emit('update-server-setting', { key: 'session_duration_days', value: sessionDurDays });
    changed = true;
  }

  const maxMsgChars = String(Math.max(200, Math.min(100000, parseInt(document.getElementById('max-message-chars')?.value) || 2000)));
  if (maxMsgChars !== (snap.max_message_chars || '2000')) {
    this.socket.emit('update-server-setting', { key: 'max_message_chars', value: maxMsgChars });
    changed = true;
  }

  const updateBannerAdminOnly = document.getElementById('update-banner-admin-only')?.checked ? 'true' : 'false';
  if (updateBannerAdminOnly !== (snap.update_banner_admin_only || 'false')) {
    this.socket.emit('update-server-setting', { key: 'update_banner_admin_only', value: updateBannerAdminOnly });
    changed = true;
  }

  const adminPwReset = document.getElementById('admin-password-reset-enabled')?.checked ? 'true' : 'false';
  if (adminPwReset !== (snap.admin_password_reset_enabled || 'false')) {
    this.socket.emit('update-server-setting', { key: 'admin_password_reset_enabled', value: adminPwReset });
    changed = true;
  }

  const emojiAutoUpdate = document.getElementById('unicode-emoji-auto-update')?.checked ? 'true' : 'false';
  if (emojiAutoUpdate !== (snap.unicode_emoji_auto_update || 'false')) {
    this.socket.emit('update-server-setting', { key: 'unicode_emoji_auto_update', value: emojiAutoUpdate });
    changed = true;
  }

  const regCaptcha = document.getElementById('registration-captcha-enabled')?.checked ? 'true' : 'false';
  if (regCaptcha !== (snap.registration_captcha_enabled || 'false')) {
    this.socket.emit('update-server-setting', { key: 'registration_captcha_enabled', value: regCaptcha });
    changed = true;
  }
  const tsSite = (document.getElementById('turnstile-site-key')?.value || '').trim();
  if (tsSite !== (snap.turnstile_site_key || '')) {
    this.socket.emit('update-server-setting', { key: 'turnstile_site_key', value: tsSite });
    changed = true;
  }
  const tsSecret = (document.getElementById('turnstile-secret-key')?.value || '').trim();
  if (tsSecret !== (snap.turnstile_secret_key || '')) {
    this.socket.emit('update-server-setting', { key: 'turnstile_secret_key', value: tsSecret });
    changed = true;
  }
  const rlEnabled = document.getElementById('registration-rate-limit-enabled')?.checked ? 'true' : 'false';
  if (rlEnabled !== (snap.registration_rate_limit_enabled || 'false')) {
    this.socket.emit('update-server-setting', { key: 'registration_rate_limit_enabled', value: rlEnabled });
    changed = true;
  }
  const rlPerHour = (document.getElementById('registration-rate-limit-per-hour')?.value || '20').trim();
  if (rlPerHour !== (snap.registration_rate_limit_per_hour || '20')) {
    this.socket.emit('update-server-setting', { key: 'registration_rate_limit_per_hour', value: rlPerHour });
    changed = true;
  }
  const maxInvUses = (document.getElementById('max-invite-uses')?.value || '0').trim();
  if (maxInvUses !== (snap.max_invite_uses || '0')) {
    this.socket.emit('update-server-setting', { key: 'max_invite_uses', value: maxInvUses });
    changed = true;
  }

  const themeList = document.getElementById('admin-theme-list');
  if (themeList?.dataset.loaded === '1') {
    const publishedThemes = JSON.stringify(
      [...themeList.querySelectorAll('input[type="checkbox"]')]
        .filter(cb => cb.checked)
        .map(cb => cb.dataset.file)
    );
    if (publishedThemes !== (snap.published_themes || '[]')) {
      this.socket.emit('update-server-setting', { key: 'published_themes', value: publishedThemes });
      changed = true;
    }
  }

  // Publish first so a newly-published file can pass server validation when it
  // is selected as the default in the same save operation.
  const defaultTheme = document.getElementById('default-theme-select')?.value || '';
  if (defaultTheme !== (snap.default_theme || '')) {
    this.socket.emit('update-server-setting', { key: 'default_theme', value: defaultTheme });
    changed = true;
  }

  const defaultLocale = document.getElementById('default-locale-select')?.value || '';
  if (defaultLocale !== (snap.default_locale || '')) {
    this.socket.emit('update-server-setting', { key: 'default_locale', value: defaultLocale });
    changed = true;
  }

  const customTos = document.getElementById('custom-tos-input')?.value.trim() || '';
  if (customTos !== (snap.custom_tos || '')) {
    this.socket.emit('update-server-setting', { key: 'custom_tos', value: customTos });
    changed = true;
  }

  const roleIconSidebar = document.getElementById('role-icon-sidebar')?.checked ? 'true' : 'false';
  if (roleIconSidebar !== (snap.role_icon_sidebar || 'true')) {
    this.socket.emit('update-server-setting', { key: 'role_icon_sidebar', value: roleIconSidebar });
    changed = true;
  }

  const roleIconChat = document.getElementById('role-icon-chat')?.checked ? 'true' : 'false';
  if (roleIconChat !== (snap.role_icon_chat || 'false')) {
    this.socket.emit('update-server-setting', { key: 'role_icon_chat', value: roleIconChat });
    changed = true;
  }

  const roleIconAfterName = document.getElementById('role-icon-after-name')?.checked ? 'true' : 'false';
  if (roleIconAfterName !== (snap.role_icon_after_name || 'false')) {
    this.socket.emit('update-server-setting', { key: 'role_icon_after_name', value: roleIconAfterName });
    changed = true;
  }

  // ── Voice & Connectivity (STUN/TURN) — #5399 ───
  const stunUrlsVal = document.getElementById('stun-urls-input')?.value.trim() || '';
  if (stunUrlsVal !== (snap.stun_urls || '')) {
    this.socket.emit('update-server-setting', { key: 'stun_urls', value: stunUrlsVal });
    changed = true;
  }
  const turnUrlVal = document.getElementById('turn-url-input')?.value.trim() || '';
  if (turnUrlVal !== (snap.turn_url || '')) {
    this.socket.emit('update-server-setting', { key: 'turn_url', value: turnUrlVal });
    changed = true;
  }
  const turnUserVal = document.getElementById('turn-username-input')?.value.trim() || '';
  if (turnUserVal !== (snap.turn_username || '')) {
    this.socket.emit('update-server-setting', { key: 'turn_username', value: turnUserVal });
    changed = true;
  }
  const turnPassVal = document.getElementById('turn-password-input')?.value || '';
  if (turnPassVal !== (snap.turn_password || '')) {
    this.socket.emit('update-server-setting', { key: 'turn_password', value: turnPassVal });
    changed = true;
  }

  // The Channel Creator Role select writes straight through on `change`, so by
  // the time Save runs the value is already stored. It still has to be counted
  // here or the panel reports "No changes to save" for an edit that plainly
  // happened. Comparing against the snapshot means re-picking the original
  // value still correctly counts as no change. (#5461)
  const ccrNow = (this.serverSettings?.channel_creator_role || '');
  if (ccrNow !== (snap.channel_creator_role || '')) changed = true;

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
    const refPol = document.getElementById('referrer-policy-select');
    if (refPol) refPol.value = snap.referrer_policy;
    this._applyOidcSettings?.();
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
    const mstk = document.getElementById('max-sticker-kb');
    if (mstk) mstk.value = snap.max_sticker_kb || '1024';
    const mpo = document.getElementById('max-poll-options');
    if (mpo) mpo.value = snap.max_poll_options || '10';
    const sdd = document.getElementById('session-duration-days');
    if (sdd) sdd.value = snap.session_duration_days ?? '0';
    const mmc = document.getElementById('max-message-chars');
    if (mmc) mmc.value = snap.max_message_chars || '2000';
    const uba = document.getElementById('update-banner-admin-only');
    if (uba) uba.checked = snap.update_banner_admin_only === 'true';
    const dt = document.getElementById('default-theme-select');
    if (dt) dt.value = snap.default_theme || '';
    const dl = document.getElementById('default-locale-select');
    if (dl) dl.value = snap.default_locale || '';
    const ct = document.getElementById('custom-tos-input');
    if (ct) ct.value = snap.custom_tos || '';
  }
  document.getElementById('settings-modal').style.display = 'none';
},

async _renderAdminThemeList() {
  const container = document.getElementById('admin-theme-list');
  if (!container) return;
  container.dataset.loaded = '0';
  let themes = [];
  try {
    const response = await fetch('/api/themes');
    if (!response.ok) throw new Error('Theme metadata request failed');
    const result = await response.json();
    if (!Array.isArray(result)) throw new Error('Invalid theme metadata response');
    themes = result;
    container.dataset.loaded = '1';
  } catch { /* server not ready */ }

  if (themes.length === 0) {
    container.innerHTML = `<span style="font-size:0.75rem;color:var(--text-muted)">${t('settings.admin.no_themes')}</span>`;
    return;
  }

  container.innerHTML = '';
  for (const theme of themes) {
    const label = document.createElement('label');
    label.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:0.8125rem;cursor:pointer';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.dataset.file = theme.file;
    cb.checked = !!theme.published && theme.compatible !== false;
    cb.disabled = theme.compatible === false;
    const nameSpan = document.createElement('span');
    nameSpan.textContent = theme.name || theme.file;
    const descSpan = document.createElement('span');
    descSpan.style.cssText = 'font-size:0.6875rem;color:var(--text-muted)';
    const compatibility = theme.compatible === false
      ? ` [${t('settings.plugins_section.incompatible_theme')}]`
      : '';
    descSpan.textContent = `${theme.description || ''}${compatibility}`;
    if (theme.compatible === false) {
      label.style.opacity = '0.65';
      label.title = t('settings.plugins_section.incompatible_theme_hint');
    }
    label.append(cb, nameSpan);
    if (theme.description || theme.compatible === false) label.append(descSpan);
    container.appendChild(label);
  }

  // Sync published file themes into the default-theme-select
  const dtSelect = document.getElementById('default-theme-select');
  if (dtSelect) {
    // Remove any previously injected file: options
    dtSelect.querySelectorAll('option[data-custom-theme]').forEach(o => o.remove());
    const published = themes.filter(theme => theme.published && theme.compatible !== false);
    if (published.length > 0) {
      const sep = document.createElement('option');
      sep.disabled = true;
      sep.textContent = `── ${t('settings.admin.custom_themes')} ──`;
      sep.setAttribute('data-custom-theme', '1');
      dtSelect.appendChild(sep);
      for (const theme of published) {
        const opt = document.createElement('option');
        opt.value = `file:${theme.file}`;
        opt.textContent = theme.name || theme.file;
        opt.setAttribute('data-custom-theme', '1');
        dtSelect.appendChild(opt);
      }
    }
    const currentDefault = this.serverSettings.default_theme || '';
    if (currentDefault.startsWith('file:') && !published.some(theme => `file:${theme.file}` === currentDefault)) {
      const file = currentDefault.slice(5);
      const theme = themes.find(item => item.file === file);
      if (theme) {
        const opt = document.createElement('option');
        opt.value = currentDefault;
        opt.textContent = `${theme.name || file} (${t('settings.plugins_section.incompatible_theme')})`;
        opt.disabled = true;
        opt.setAttribute('data-custom-theme', '1');
        dtSelect.appendChild(opt);
      }
    }
    // Re-apply saved value (may be a file: value)
    dtSelect.value = this.serverSettings.default_theme || '';
  }
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
  // server_name_effective folds in SERVER_NAME from the environment, so a
  // server named only through docker doesn't read as "HAVEN" in here. (#5489)
  const name = this.serverSettings.server_name || this.serverSettings.server_name_effective || 'HAVEN';
  const icon = this.serverSettings.server_icon || '';

  // Sidebar brand text
  const brandText = document.querySelector('.brand-text');
  if (brandText) {
    brandText.textContent = name;
    // Keep glitch scramble system in sync. The scrambler captures each element's
    // original text in a data-original-text attribute and restores it at the end of
    // every animation. If the cache is stale (e.g. "HAVEN" from the HTML default) it
    // will overwrite the real server name on every tick.
    // We also abort any in-progress animation: the animation closure captures
    // trueOriginal as a const at start time, so updating the attribute alone won't
    // prevent that specific closure from writing the stale name when it finishes.
    brandText.dataset.originalText = name;
    if (brandText._scrambleInterval) {
      clearInterval(brandText._scrambleInterval);
      brandText._scrambleInterval = null;
    }
    brandText._scrambling = false;
    brandText.classList.remove('scrambling');
  }

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
      preview.innerHTML = `<img src="${icon}" alt="${t('media.server_icon_alt')}">`;
    } else {
      preview.innerHTML = '<span class="server-icon-text">⬡</span>';
    }
  }

  // Browser tab branding (issue #5284)
  // Refresh the document title with the new server name, and swap the favicon
  // to the server icon when one is set so multi-server tab juggling is easier.
  this._updateTabTitle?.();
  this._applyFaviconBranding?.(icon);
},

_applyFaviconBranding(iconUrl) {
  let link = document.querySelector('link[rel="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  if (iconUrl) {
    // Remember the original (default) favicon so we can restore it if the
    // server icon is later removed.
    if (!this._defaultFaviconHref) this._defaultFaviconHref = link.getAttribute('href') || '';
    if (!this._defaultFaviconType) this._defaultFaviconType = link.getAttribute('type') || '';
    link.removeAttribute('type');
    link.href = iconUrl;
  } else if (this._defaultFaviconHref) {
    if (this._defaultFaviconType) link.type = this._defaultFaviconType;
    link.href = this._defaultFaviconHref;
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

  // Server banner upload
  document.getElementById('server-banner-upload-btn')?.addEventListener('click', async () => {
    const fileInput = document.getElementById('server-banner-file');
    if (!fileInput || !fileInput.files[0]) return this._showToast(t('settings.admin.select_image_first'), 'error');
    const form = new FormData();
    form.append('image', fileInput.files[0]);
    try {
      const res = await fetch('/api/upload-server-banner', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${this.token}` },
        body: form
      });
      const data = await res.json();
      if (data.error) return this._showToast(data.error, 'error');
      this.socket.emit('update-server-setting', { key: 'server_banner', value: data.url });
      this._showToast(t('settings.admin.server_banner_updated'), 'success');
      fileInput.value = '';
    } catch (err) {
      this._showToast(t('settings.admin.upload_failed'), 'error');
    }
  });

  // Server banner remove
  document.getElementById('server-banner-remove-btn')?.addEventListener('click', () => {
    this.socket.emit('update-server-setting', { key: 'server_banner', value: '' });
    this._showToast(t('settings.admin.server_banner_removed'), 'success');
  });

  // Banner header mode dropdown (client-side / localStorage)
  document.getElementById('banner-header-mode')?.addEventListener('change', (e) => {
    localStorage.setItem('haven_banner_header_mode', e.target.value);
    this._applyServerSettings();
    const labels = {
      full: t('settings.admin.banner_mode_full'),
      shaded: t('settings.admin.banner_mode_shaded'),
      minimal: t('settings.admin.banner_mode_minimal'),
      transparent: t('settings.admin.banner_mode_transparent')
    };
    this._showToast(labels[e.target.value] || t('settings.admin.header_mode_updated'), 'success');
  });

  // Banner height slider (client-side / localStorage)
  const bannerSlider = document.getElementById('banner-height-slider');
  const bannerSliderLabel = document.getElementById('banner-height-value');
  if (bannerSlider) {
    bannerSlider.addEventListener('input', (e) => {
      if (bannerSliderLabel) bannerSliderLabel.textContent = e.target.value + 'px';
      const bd = document.getElementById('server-banner-display');
      if (bd) bd.style.height = e.target.value + 'px';
    });
    bannerSlider.addEventListener('change', (e) => {
      localStorage.setItem('haven_banner_height', e.target.value);
    });
  }

  // Banner vertical offset slider (client-side / localStorage)
  const bannerOffsetSlider = document.getElementById('banner-offset-slider');
  const bannerOffsetLabel = document.getElementById('banner-offset-value');
  if (bannerOffsetSlider) {
    bannerOffsetSlider.addEventListener('input', (e) => {
      if (bannerOffsetLabel) bannerOffsetLabel.textContent = e.target.value + '%';
      const img = document.getElementById('server-banner-img');
      if (img) img.style.objectPosition = 'center ' + e.target.value + '%';
    });
    bannerOffsetSlider.addEventListener('change', (e) => {
      localStorage.setItem('haven_banner_offset', e.target.value);
    });
  }

  // Vanity code
  document.getElementById('vanity-code-save-btn')?.addEventListener('click', () => {
    const val = document.getElementById('vanity-code-input')?.value.trim() || '';
    if (val && (val.length < 3 || val.length > 32 || !/^[a-zA-Z0-9_-]+$/.test(val))) {
      return this._showToast(t('settings.admin.vanity_invalid'), 'error');
    }
    this.socket.emit('update-server-setting', { key: 'vanity_code', value: val });
    this._showToast(t(val ? 'settings.admin.vanity_saved' : 'settings.admin.vanity_cleared'), 'success');
  });

  document.getElementById('vanity-code-clear-btn')?.addEventListener('click', () => {
    document.getElementById('vanity-code-input').value = '';
    this.socket.emit('update-server-setting', { key: 'vanity_code', value: '' });
    this._showToast(t('settings.admin.vanity_cleared'), 'success');
  });
},

_renderBanList(bans) {
  const list = document.getElementById('bans-list');
  if (bans.length === 0) {
    list.innerHTML = `<p class="muted-text">${t('settings.admin.no_banned_users')}</p>`;
    return;
  }
  list.innerHTML = bans.map(b => `
    <div class="ban-item${b.appeal ? ' has-appeal' : ''}">
      <div class="ban-info">
        <strong>${this._escapeHtml(b.username)}</strong>
        <span class="ban-reason">${b.reason ? this._escapeHtml(b.reason) : t('settings.admin.no_reason')}</span>
        <span class="ban-date">${new Date(b.created_at).toLocaleDateString()}</span>
        ${b.appeal ? `
        <div class="ban-appeal">
          <span class="ban-appeal-label">📝 ${t('settings.admin.ban_appeal_label')}${b.appeal_at ? ' · ' + new Date(b.appeal_at).toLocaleDateString() : ''}</span>
          <span class="ban-appeal-text">${this._escapeHtml(b.appeal)}</span>
        </div>` : ''}
      </div>
      <div class="ban-actions">
        <button class="btn-sm btn-unban" data-uid="${b.user_id}">${t('settings.admin.unban_btn')}</button>
        ${b.appeal ? `<button class="btn-sm btn-dismiss-appeal" data-uid="${b.user_id}" title="${t('settings.admin.dismiss_appeal_title')}">${t('settings.admin.dismiss_appeal_btn')}</button>` : ''}
        <button class="btn-sm btn-delete-user" data-uid="${b.user_id}" data-uname="${this._escapeHtml(b.username)}" title="${t('settings.admin.delete_user_title')}">🗑️</button>
      </div>
    </div>
  `).join('');

  list.querySelectorAll('.btn-unban').forEach(btn => {
    btn.addEventListener('click', () => {
      this.socket.emit('unban-user', { userId: parseInt(btn.dataset.uid) });
    });
  });

  list.querySelectorAll('.btn-dismiss-appeal').forEach(btn => {
    btn.addEventListener('click', () => {
      this.socket.emit('dismiss-ban-appeal', { userId: parseInt(btn.dataset.uid) });
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

_renderIpBanList(bans) {
  const list = document.getElementById('ip-bans-list');
  if (!list) return;
  if (!Array.isArray(bans) || bans.length === 0) {
    list.innerHTML = `<p class="muted-text">${t('settings.admin.no_banned_ips')}</p>`;
    return;
  }
  list.innerHTML = bans.map(b => `
    <div class="ban-item">
      <div class="ban-info">
        <strong>${this._escapeHtml(b.ip)}</strong>
        <span class="ban-reason">${b.reason ? this._escapeHtml(b.reason) : t('settings.admin.no_reason')}</span>
        <span class="ban-date">${new Date(b.created_at).toLocaleDateString()}${b.banned_by_name ? ` — ${this._escapeHtml(b.banned_by_name)}` : ''}</span>
      </div>
      <div class="ban-actions">
        <button class="btn-sm btn-unban" data-ip="${this._escapeHtml(b.ip)}">${t('settings.admin.unban_btn')}</button>
      </div>
    </div>
  `).join('');

  list.querySelectorAll('.btn-unban').forEach(btn => {
    btn.addEventListener('click', () => {
      this.socket.emit('unban-ip', { ip: btn.dataset.ip });
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
  const storageEl = document.getElementById('all-members-storage-summary');
  if (storageEl) storageEl.style.display = 'none';
  modal.style.display = 'flex';

  // Pass current channel so the server can fall back to view_channel_members
  const payload = this.currentChannel ? { channelCode: this.currentChannel } : {};
  this.socket.emit('get-all-members', payload, (res) => {
    if (res.error) {
      list.innerHTML = `<p class="muted-text" style="text-align:center;padding:20px">${this._escapeHtml(res.error)}</p>`;
      return;
    }
    this._allMembersData = res.members || [];
    this._allMembersChannels = res.allChannels || [];
    this._allMembersPerms = res.callerPerms || {};
    this._allMembersStorage = res.storageSummary || null;
    this._renderStorageSummary();
    // Update title to reflect channel-only vs all members
    const titleEl = document.querySelector('#all-members-modal [data-i18n="modals.all_members.title"]');
    if (titleEl) {
      titleEl.textContent = res.channelOnly ? t('modals.all_members.channel_title') : t('modals.all_members.title');
    }
    document.getElementById('all-members-count').textContent = `(${res.total})`;
    // Toggle moderator-only nav buttons (View Bans / View Deleted) based on perms.
    // Server-side handlers re-validate, so DOM tampering can't reveal data.
    const inviteBtn = document.getElementById('aml-view-invite-btn');
    const banBtn = document.getElementById('aml-view-bans-btn');
    const delBtn = document.getElementById('aml-view-deleted-btn');
    const cleanupBtn = document.getElementById('aml-bulk-cleanup-btn');
    if (inviteBtn) inviteBtn.style.display = (this._allMembersPerms.canInvite || this._allMembersPerms.isAdmin) ? '' : 'none';
    if (banBtn) banBtn.style.display = (this._allMembersPerms.canBan || this._allMembersPerms.isAdmin) ? '' : 'none';
    if (delBtn) delBtn.style.display = this._allMembersPerms.isAdmin ? '' : 'none';
    if (cleanupBtn) cleanupBtn.style.display = this._allMembersPerms.isAdmin ? '' : 'none';
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
  // "Most storage used" answers a different question from the other filters:
  // it ranks rather than narrows. Members with nothing uploaded are dropped so
  // the list is the ranking itself instead of a long tail of zeroes. (#5521)
  else if (filter === 'storage') {
    filtered = filtered
      .filter(m => m.storage && m.storage.total > 0)
      .slice()
      .sort((a, b) => b.storage.total - a.storage.total);
  }

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

// Admin bot-wave cleanup. The server does the filtering and the
// guarded ban+delete; this is the filter form, a dry-run preview, and an
// explicit confirmation before anything is destroyed.
_openBulkCleanup() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay bulk-cleanup-overlay';
  overlay.style.display = 'flex';
  overlay.style.zIndex = '100002';
  overlay.innerHTML = `
    <div class="modal" style="max-width:520px">
      <div class="modal-header">
        <h4>🧹 ${t('modals.bulk_cleanup.title')}</h4>
        <button class="modal-close-btn bc-close">&times;</button>
      </div>
      <div class="modal-body">
        <p style="font-size:0.85rem;color:var(--text-muted);margin:0 0 12px 0;">${t('modals.bulk_cleanup.intro')}</p>
        <label style="display:flex;align-items:center;gap:8px;margin:8px 0;">
          <input type="checkbox" id="bc-join-enabled">
          <span>${t('modals.bulk_cleanup.joined_within')}</span>
          <input type="number" id="bc-join-hours" value="24" min="1" max="87600" class="settings-number-input" style="width:70px" disabled>
          <span>${t('modals.bulk_cleanup.hours')}</span>
        </label>
        <label style="display:flex;align-items:center;gap:8px;margin:8px 0;">
          <input type="checkbox" id="bc-zero-msgs" checked>
          <span>${t('modals.bulk_cleanup.zero_messages')}</span>
        </label>
        <label style="display:flex;align-items:center;gap:8px;margin:8px 0;">
          <input type="checkbox" id="bc-new-only">
          <span>${t('modals.bulk_cleanup.new_only')}</span>
        </label>
        <hr style="border:none;border-top:1px solid var(--border);margin:12px 0;">
        <label style="display:flex;align-items:center;gap:8px;margin:8px 0;">
          <input type="checkbox" id="bc-scrub-msgs">
          <span>${t('modals.bulk_cleanup.scrub_messages')}</span>
        </label>
        <label style="display:flex;align-items:flex-start;gap:8px;margin:8px 0;">
          <input type="checkbox" id="bc-ban-ip" style="margin-top:3px">
          <span>${t('modals.bulk_cleanup.ban_ip')}<br><small style="color:var(--text-muted)">${t('modals.bulk_cleanup.ban_ip_hint')}</small></span>
        </label>
        <div id="bc-preview" style="display:none;margin-top:12px;padding:10px 12px;border-radius:8px;background:var(--bg-tertiary);font-size:0.85rem;"></div>
      </div>
      <div class="modal-actions" style="justify-content:space-between;">
        <button class="btn-sm bc-cancel">${t('modals.common.cancel')}</button>
        <div style="display:flex;gap:8px;">
          <button class="btn-sm btn-accent bc-preview-btn">${t('modals.bulk_cleanup.preview_btn')}</button>
          <button class="btn-sm btn-danger-fill bc-confirm-btn" disabled>${t('modals.bulk_cleanup.remove_btn')}</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const $ = (sel) => overlay.querySelector(sel);
  const close = () => overlay.remove();
  $('.bc-close').addEventListener('click', close);
  $('.bc-cancel').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  const joinEnabled = $('#bc-join-enabled');
  const joinHours = $('#bc-join-hours');
  joinEnabled.addEventListener('change', () => { joinHours.disabled = !joinEnabled.checked; });

  const previewBox = $('#bc-preview');
  const confirmBtn = $('.bc-confirm-btn');

  const buildFilter = () => {
    const filter = {};
    if (joinEnabled.checked) {
      const h = parseInt(joinHours.value, 10);
      if (Number.isFinite(h) && h > 0) filter.joinedWithinHours = h;
    }
    if ($('#bc-zero-msgs').checked) filter.zeroMessages = true;
    if ($('#bc-new-only').checked) filter.newOnly = true;
    return filter;
  };

  const selectedIds = () =>
    [...overlay.querySelectorAll('.bc-user-check:checked')].map(el => parseInt(el.dataset.id, 10)).filter(Number.isInteger);

  const refreshConfirm = () => {
    const n = selectedIds().length;
    confirmBtn.disabled = n === 0;
    confirmBtn.textContent = n === 0
      ? t('modals.bulk_cleanup.remove_btn')
      : t('modals.bulk_cleanup.remove_n_btn').replace('{n}', n);
  };

  // Any filter change invalidates a prior preview so the admin can't act on a
  // stale list.
  ['#bc-join-enabled', '#bc-join-hours', '#bc-zero-msgs', '#bc-new-only'].forEach(sel => {
    $(sel).addEventListener('change', () => {
      confirmBtn.disabled = true;
      confirmBtn.textContent = t('modals.bulk_cleanup.remove_btn');
      previewBox.style.display = 'none';
    });
  });

  $('.bc-preview-btn').addEventListener('click', () => {
    const filter = buildFilter();
    if (!filter.joinedWithinHours && !filter.zeroMessages && !filter.newOnly) {
      previewBox.style.display = 'block';
      previewBox.innerHTML = `<span style="color:var(--danger)">${t('modals.bulk_cleanup.need_filter')}</span>`;
      return;
    }
    this.socket.emit('bulk-remove-users', { filter, dryRun: true }, (res) => {
      previewBox.style.display = 'block';
      if (!res || res.error) {
        previewBox.innerHTML = `<span style="color:var(--danger)">${this._escapeHtml(res && res.error ? res.error : t('settings.admin.bulk_preview_failed'))}</span>`;
        return;
      }
      const users = res.users || [];
      if (res.total === 0) {
        previewBox.innerHTML = t('modals.bulk_cleanup.no_match');
        confirmBtn.disabled = true;
        confirmBtn.textContent = t('modals.bulk_cleanup.remove_btn');
        return;
      }
      const rows = users.map(u => {
        const date = this._escapeHtml((u.createdAt || '').slice(0, 10));
        const msgs = t('modals.bulk_cleanup.msgs').replace('{n}', u.msgCount || 0);
        const flag = (u.msgCount > 0)
          ? ` <span style="color:var(--warning,#e0a800)" title="${this._escapeHtml(t('modals.bulk_cleanup.has_activity'))}">&#9873;</span>` : '';
        return `<label style="display:flex;align-items:center;gap:8px;padding:2px 0;">
            <input type="checkbox" class="bc-user-check" data-id="${u.id}" checked>
            <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${this._escapeHtml(u.username)}${flag}</span>
            <span style="color:var(--text-muted);font-size:0.8em;white-space:nowrap;">${date} &middot; ${msgs}</span>
          </label>`;
      }).join('');
      previewBox.innerHTML =
        `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">` +
          `<strong>${t('modals.bulk_cleanup.match_count').replace('{n}', res.total)}${res.capped ? ` <span style="color:var(--text-muted);font-weight:normal">(${t('modals.bulk_cleanup.capped')})</span>` : ''}</strong>` +
          `<span><button type="button" class="btn-sm bc-check-all">${t('modals.bulk_cleanup.select_all')}</button> <button type="button" class="btn-sm bc-check-none">${t('modals.bulk_cleanup.select_none')}</button></span>` +
        `</div>` +
        `<div style="color:var(--text-muted);font-size:0.8em;margin-bottom:4px;">${t('modals.bulk_cleanup.vet_hint')}</div>` +
        `<div style="max-height:220px;overflow:auto;border:1px solid var(--border);border-radius:6px;padding:6px 8px;">${rows}</div>`;
      previewBox.querySelector('.bc-check-all').addEventListener('click', () => { previewBox.querySelectorAll('.bc-user-check').forEach(c => { c.checked = true; }); refreshConfirm(); });
      previewBox.querySelector('.bc-check-none').addEventListener('click', () => { previewBox.querySelectorAll('.bc-user-check').forEach(c => { c.checked = false; }); refreshConfirm(); });
      previewBox.querySelectorAll('.bc-user-check').forEach(c => c.addEventListener('change', refreshConfirm));
      refreshConfirm();
    });
  });

  confirmBtn.addEventListener('click', () => {
    const ids = selectedIds();
    if (ids.length === 0) return;
    if (!confirm(t('modals.bulk_cleanup.confirm').replace('{n}', ids.length))) return;
    confirmBtn.disabled = true;
    confirmBtn.textContent = t('modals.bulk_cleanup.working');
    this.socket.emit('bulk-remove-users', {
      userIds: ids,
      scrubMessages: $('#bc-scrub-msgs').checked,
      banIp: $('#bc-ban-ip').checked
    }, (res) => {
      if (!res || res.error) {
        if (this._showToast) this._showToast(res && res.error ? res.error : t('modals.bulk_cleanup.failed'), 'error', 6000);
        confirmBtn.disabled = false;
        refreshConfirm();
        return;
      }
      close();
      const extra = res.ipBanned ? ` (${res.ipBanned} IP${res.ipBanned === 1 ? '' : 's'})` : '';
      if (this._showToast) this._showToast(t('modals.bulk_cleanup.done').replace('{n}', res.removed) + extra, 'success', 5000);
      const membersModal = document.getElementById('all-members-modal');
      if (membersModal && membersModal.style.display === 'flex') this._openAllMembersModal();
    });
  });
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

    // Storage consumed (#5521). Only moderators get a `storage` object at all,
    // so a member viewing this list simply sees no chip. The breakdown goes in
    // the tooltip: DM attachments are encrypted, so their size is all the
    // server knows about them and all this can ever report.
    let storageHtml = '';
    if (m.storage && m.storage.total > 0) {
      const parts = [];
      if (m.storage.channel) parts.push(t('settings.admin.storage_public', { size: this._formatFileSize(m.storage.channel) }));
      if (m.storage.dm) parts.push(t('settings.admin.storage_private', { size: this._formatFileSize(m.storage.dm) }));
      if (m.storage.profile) parts.push(t('settings.admin.storage_profile', { size: this._formatFileSize(m.storage.profile) }));
      const title = t('settings.admin.storage_tooltip', { files: m.storage.files, breakdown: parts.join(', ') });
      storageHtml = `<span class="aml-member-storage" title="${this._escapeHtml(title)}">💾 ${this._escapeHtml(this._formatFileSize(m.storage.total))}</span>`;
    }

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
      btns += `<button class="aml-action-btn aml-btn-nick" data-uid="${m.id}" data-uname="${this._escapeHtml(m.username)}" data-dname="${this._escapeHtml(m.displayName)}" title="${t('users.set_nickname')}">🏷️</button>`;
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
            ${storageHtml}
          </div>
        </div>
      </div>
      ${actionsHtml}
    </div>`;
  }).join('');

  // Bind action buttons
  this._bindMemberListActions(list);
},

// Server-wide upload totals under the search box. The unattributed figure is
// the honest part of this: files uploaded before per-member accounting existed
// have no owner on record, and guessing an owner would be worse than saying so.
_renderStorageSummary() {
  const el = document.getElementById('all-members-storage-summary');
  if (!el) return;
  const summary = this._allMembersStorage;
  if (!summary || !summary.liveBytes) { el.style.display = 'none'; return; }

  let text = t('settings.admin.storage_summary', {
    total: this._formatFileSize(summary.liveBytes),
    files: summary.fileCount
  });
  if (summary.unattributedBytes > 0) {
    text += ' ' + t('settings.admin.storage_summary_unattributed', {
      size: this._formatFileSize(summary.unattributedBytes)
    });
  }
  el.textContent = text;
  el.style.display = '';
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
      const dname = btn.dataset.dname;
      self._showNicknameDialog(uid, uname, dname);
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
  const searchId = `aml-ch-search-${userId}-${mode}`;
  const isAdd = mode === 'add';

  overlay.innerHTML = `
    <div class="modal aml-ch-picker">
      <div class="aml-ch-picker-header">
        <h4 class="aml-ch-picker-title">${title}</h4>
        <label class="aml-ch-picker-selectall">
          <input type="checkbox" id="${allCheckboxId}">
          <span>${t('settings.admin.select_all')}</span>
        </label>
      </div>
      <div class="aml-ch-picker-subtitle">
        <span class="aml-ch-picker-count">0 / ${channels.length}</span>
        <input type="search" id="${searchId}" class="aml-ch-picker-search"
               placeholder="${t('settings.admin.filter_channels')}">
      </div>
      <div class="aml-channel-list">
        ${channels.map(c => `
          <label class="aml-channel-row" data-name-lower="${this._escapeHtml((c.name || '').toLowerCase())}">
            <input type="checkbox" class="aml-ch-check" value="${c.id}" data-name="${this._escapeHtml(c.name)}">
            <span class="aml-ch-hash">#</span>
            <span class="aml-ch-name">${this._escapeHtml(c.name)}</span>
          </label>
        `).join('')}
      </div>
      <div class="modal-actions aml-ch-picker-actions">
        <button class="btn-sm aml-ch-cancel">${t('modals.common.cancel')}</button>
        <button class="btn-sm ${isAdd ? 'btn-accent' : 'btn-danger'} aml-ch-confirm" disabled>
          ${isAdd ? t('settings.admin.picker_confirm_add') : t('settings.admin.picker_confirm_remove')}
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  // Select All checkbox + count + filter wiring
  const allCheck = overlay.querySelector(`#${allCheckboxId}`);
  const checks = overlay.querySelectorAll('.aml-ch-check');
  const confirmBtn = overlay.querySelector('.aml-ch-confirm');
  const countEl = overlay.querySelector('.aml-ch-picker-count');
  const search = overlay.querySelector(`#${searchId}`);

  const updateState = () => {
    const visible = [...checks].filter(cb => cb.closest('.aml-channel-row').style.display !== 'none');
    const checked = visible.filter(cb => cb.checked);
    countEl.textContent = `${checked.length} / ${visible.length}`;
    confirmBtn.disabled = checked.length === 0;
    allCheck.checked = visible.length > 0 && checked.length === visible.length;
    allCheck.indeterminate = checked.length > 0 && checked.length < visible.length;
  };

  allCheck.addEventListener('change', () => {
    checks.forEach(cb => {
      if (cb.closest('.aml-channel-row').style.display !== 'none') cb.checked = allCheck.checked;
    });
    updateState();
  });
  checks.forEach(cb => cb.addEventListener('change', updateState));

  if (search) {
    search.addEventListener('input', () => {
      const q = search.value.trim().toLowerCase();
      overlay.querySelectorAll('.aml-channel-row').forEach(row => {
        const name = row.dataset.nameLower || '';
        row.style.display = !q || name.includes(q) ? '' : 'none';
      });
      updateState();
    });
  }
  updateState();

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
    `<span style="flex:none">${icon}</span><span>${text}</span></div>`;

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
    try { this._renderInviteCreateChannels(true); } catch { /* non-critical */ }
  }
  if (this.socket?.connected) { try { this.socket.emit('get-invite-codes'); } catch { /* non-critical */ } }
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

// ═══════════════════════════════════════════════════════
// @MENTION AUTOCOMPLETE
// ═══════════════════════════════════════════════════════

_checkMentionTrigger(inputEl) {
  const input = inputEl || document.getElementById('message-input');
  this._mentionInput = input;
  const cursor = input.selectionStart;
  const text = input.value.substring(0, cursor);

  // Look backwards from cursor for an '@' that starts a word.
  // Allow spaces in the query so we can match names like "John Doe". (#5273)
  const match = text.match(/@([^@\n]{0,30})$/);
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
  // Re-parent so the absolute-positioned dropdown anchors above the active
  // input (works for thread input + DM PiP input + main input). (#5296)
  const host = (this._mentionInput && this._mentionInput.parentElement) || null;
  if (host && dropdown.parentElement !== host) host.appendChild(dropdown);
  const query = this.mentionQuery;

  // channelMembers is written in exactly one place — the 'channel-members'
  // socket handler — and that handler drops the payload if it arrives while
  // currentChannel has moved on. Any path that leaves it empty (a dropped
  // payload, a switchChannel that threw before its emit, a server-side
  // membership miss) used to surface as "@ silently does nothing", which is
  // impossible to diagnose from the user's side. Re-request instead, throttled
  // so a channel that genuinely has no other members doesn't spam the socket.
  if (!Array.isArray(this.channelMembers) || this.channelMembers.length === 0) {
    const now = Date.now();
    if (this.currentChannel && this.socket?.connected && now - (this._lastMemberRefetch || 0) > 3000) {
      this._lastMemberRefetch = now;
      console.warn('[Haven] @mention: channelMembers empty, re-requesting for', this.currentChannel);
      try { this.socket.emit('get-channel-members', { code: this.currentChannel }); } catch {}
    }
  }

  const filtered = (this.channelMembers || []).filter(m => {
    const dn = (m.username || '').toLowerCase();
    const ln = (m.loginName || '').toLowerCase();
    const nk = (m.id && this._nicknames && this._nicknames[m.id] || '').toLowerCase();
    return dn.startsWith(query) || ln.startsWith(query) || (nk && nk.startsWith(query));
  }).slice(0, 8);

  // Offer @everyone / @here as mention options when the query matches and
  // the user has the mention_everyone permission (admins implicitly have it).
  const canMentionEveryone = this.user && (this.user.isAdmin || this._hasPerm?.('mention_everyone'));
  const everyoneOptions = [];
  if (canMentionEveryone) {
    if ('everyone'.startsWith(query)) everyoneOptions.push({ name: 'everyone', label: '@everyone', desc: t('settings.admin.mention_everyone_desc') });
    if ('here'.startsWith(query)) everyoneOptions.push({ name: 'here', label: '@here', desc: t('settings.admin.mention_here_desc') });
  }

  if (filtered.length === 0 && everyoneOptions.length === 0) {
    dropdown.style.display = 'none';
    return;
  }

  // Insert by loginName (stable, immune to display-name renames). Show the
  // viewer's personal nickname (if set) or the display name in the dropdown
  // for recognizability, with the @loginName suffix when it differs so
  // people know what'll actually be inserted. (#5290)
  const everyoneItems = everyoneOptions.map((opt, i) => {
    const active = (i === 0 && filtered.length === 0) ? ' active' : '';
    return `<div class="mention-item${active}" data-username="${opt.name}" data-everyone="1"><strong>${opt.label}</strong> <span class="mention-item-handle">${this._escapeHtml(opt.desc)}</span></div>`;
  }).join('');

  const memberItems = filtered.map((m, i) => {
    const isFirstMember = (i === 0 && everyoneOptions.length === 0);
    const nick = m.id && this._nicknames ? this._nicknames[m.id] : '';
    const display = nick || m.username || m.loginName || '';
    const login = m.loginName || m.username || '';
    const suffix = (login && display.toLowerCase() !== login.toLowerCase())
      ? ` <span class="mention-item-handle">@${this._escapeHtml(login)}</span>`
      : '';
    return `<div class="mention-item${isFirstMember ? ' active' : ''}" data-username="${this._escapeHtml(login)}">${this._escapeHtml(display)}${suffix}</div>`;
  }).join('');

  dropdown.innerHTML = everyoneItems + memberItems;

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
  const input = this._mentionInput || document.getElementById('message-input');
  const before = input.value.substring(0, this.mentionStart);
  const after = input.value.substring(input.selectionStart);
  input.value = before + '@' + username + ' ' + after;
  input.selectionStart = input.selectionEnd = this.mentionStart + username.length + 2;
  input.focus();
  this._hideMentionDropdown();
},

// ═══════════════════════════════════════════════════════
// #CHANNEL AUTOCOMPLETE
// ═══════════════════════════════════════════════════════

_checkChannelTrigger(inputEl) {
  const input = inputEl || document.getElementById('message-input');
  this._channelAcInput = input;
  const cursor = input.selectionStart;
  const text = input.value.substring(0, cursor);
  // Match a # that follows a non-word, non-# boundary, plus up to 50 trailing
  // chars allowed in channel-link names (letters, numbers, emoji, _ and -).
  // Spaces aren't allowed in the trigger query — channels with spaces are
  // resolved with underscores at insert time so the autolink regex picks
  // them up.
  const match = text.match(/(?:^|[^\w#&])#([\p{L}\p{N}\p{Emoji_Presentation}_-]{0,50})$/u);
  if (match && Array.isArray(this.channels) && this.channels.length) {
    // Anchor start at the '#' itself
    this.channelAcStart = cursor - match[1].length - 1;
    this.channelAcQuery = match[1].toLowerCase();
    this._showChannelDropdown();
  } else {
    this._hideChannelDropdown();
  }
},

_showChannelDropdown() {
  const dropdown = document.getElementById('channel-dropdown');
  if (!dropdown) return;
  const host = (this._channelAcInput && this._channelAcInput.parentElement) || null;
  if (host && dropdown.parentElement !== host) host.appendChild(dropdown);

  const query = this.channelAcQuery || '';
  const queryNormalized = query.replace(/_/g, ' ');

  // Filter to non-DM channels the user can see, matching by name (case
  // insensitive, accepting either spaces or underscores in the query).
  const filtered = (this.channels || [])
    .filter(c => c && c.name && c.code && !c.is_dm)
    .filter(c => {
      const n = String(c.name).toLowerCase();
      if (!query) return true;
      return n.includes(query) || n.includes(queryNormalized);
    })
    // Prefer prefix matches first
    .sort((a, b) => {
      const an = a.name.toLowerCase(), bn = b.name.toLowerCase();
      const aStarts = an.startsWith(query) || an.startsWith(queryNormalized) ? 0 : 1;
      const bStarts = bn.startsWith(query) || bn.startsWith(queryNormalized) ? 0 : 1;
      if (aStarts !== bStarts) return aStarts - bStarts;
      return an.localeCompare(bn);
    })
    .slice(0, 8);

  if (filtered.length === 0) {
    dropdown.style.display = 'none';
    return;
  }

  dropdown.innerHTML = filtered.map((c, i) => {
    const insertName = String(c.name).replace(/\s+/g, '_');
    return `<div class="mention-item${i === 0 ? ' active' : ''}" data-channel-insert="${this._escapeHtml(insertName)}"><strong>#${this._escapeHtml(c.name)}</strong></div>`;
  }).join('');
  dropdown.style.display = 'block';
  dropdown.querySelectorAll('.mention-item').forEach(item => {
    item.addEventListener('click', () => this._insertChannelMention(item.dataset.channelInsert));
  });
},

_hideChannelDropdown() {
  const dropdown = document.getElementById('channel-dropdown');
  if (dropdown) dropdown.style.display = 'none';
  this.channelAcStart = -1;
  this.channelAcQuery = '';
},

_navigateChannelDropdown(direction) {
  const dropdown = document.getElementById('channel-dropdown');
  if (!dropdown) return;
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

_insertChannelMention(insertName) {
  const input = this._channelAcInput || document.getElementById('message-input');
  if (!input || this.channelAcStart < 0) return;
  const before = input.value.substring(0, this.channelAcStart);
  const after = input.value.substring(input.selectionStart);
  input.value = before + '#' + insertName + ' ' + after;
  input.selectionStart = input.selectionEnd = this.channelAcStart + insertName.length + 2;
  input.focus();
  this._hideChannelDropdown();
},

// ═══════════════════════════════════════════════════════
// EMOJI AUTOCOMPLETE  (:name)
// ═══════════════════════════════════════════════════════

_checkEmojiTrigger(inputEl) {
  const input = inputEl || document.getElementById('message-input');
  this._emojiAcInput = input;
  const text = input.value;
  const cursor = input.selectionStart;

  // Walk backwards from cursor to find a ':' that starts a potential emoji token
  let colonIdx = -1;
  for (let i = cursor - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === ':') { colonIdx = i; break; }
    if (ch === ' ' || ch === '\n') break; // stop at whitespace
  }

  // No emoji token under the cursor — bail and close any open dropdown. A
  // leading "::" counts as "no token": it's the persona trigger, and since no
  // emoji shortcode starts with ':', that colon can only belong to a persona.
  if (colonIdx === -1 || (colonIdx === 1 && text.startsWith('::'))) {
    this._hideEmojiDropdown();
    return;
  }

  const query = text.substring(colonIdx + 1, cursor).toLowerCase();
  if (query.length < 2) { this._hideEmojiDropdown(); return; }

  this._emojiColonStart = colonIdx;
  this._showEmojiDropdown(query);
},

_showEmojiDropdown(query) {
  // #emoji-dropdown is a single shared node re-parented next to the active
  // input (#5296). Opening the suggestions inside an inline message-edit box
  // parks it in that message; saving/cancelling the edit wipes the message's
  // HTML and deletes the node, so every later `:emoji` throws on the null
  // element and autocomplete dies until a refresh. The node holds no state
  // (its contents are rebuilt below), so recreate it if it's missing.
  let dd = document.getElementById('emoji-dropdown');
  if (!dd) {
    dd = document.createElement('div');
    dd.id = 'emoji-dropdown';
    dd.className = 'emoji-dropdown';
    dd.style.display = 'none';
  }
  // Re-parent so the absolute-positioned dropdown anchors above the active
  // input (works for thread input + DM PiP input + main input). (#5296)
  const host = (this._emojiAcInput && this._emojiAcInput.parentElement) || null;
  if (host && dd.parentElement !== host) host.appendChild(dd);
  dd.innerHTML = '';

  let results = [];

  // Bundled built-in image emoji first
  if (this.builtinEmojis) {
    this.builtinEmojis.forEach(em => {
      if (em.name.includes(query) || (em.keywords && em.keywords.toLowerCase().includes(query))) {
        results.push({ type: 'custom', name: em.name, url: em.url });
      }
    });
  }

  // Custom emojis
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
  const input = this._emojiAcInput || document.getElementById('message-input');
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

_checkSlashTrigger(inputEl) {
  const input = inputEl || document.getElementById('message-input');
  this._slashInput = input;
  const text = input.value;

  // Show slash suggestions while typing the command token, or a single
  // subcommand token (e.g. "/rss ad"). Hide once argument typing starts.
  if (text.startsWith('/') && text.length < 80) {
    const raw = text.substring(1);
    const trimmed = raw.trim();
    let query = '';
    if (!trimmed) {
      query = '';
    } else {
      const parts = trimmed.split(/\s+/);
      if (parts.length === 1) {
        query = parts[0].toLowerCase();
      } else if (parts.length === 2 && !raw.endsWith(' ')) {
        query = `${parts[0].toLowerCase()} ${parts[1].toLowerCase()}`;
      } else {
        this._hideSlashDropdown();
        return;
      }
    }
    this._showSlashDropdown(query);
  } else {
    this._hideSlashDropdown();
  }
},

_showSlashDropdown(query) {
  const dropdown = document.getElementById('slash-dropdown');
  // Re-parent so the absolute-positioned dropdown anchors above the active
  // input (works for thread input + DM PiP input + main input). (#5296)
  const host = (this._slashInput && this._slashInput.parentElement) || null;
  if (host && dropdown.parentElement !== host) host.appendChild(dropdown);
  const q = String(query || '').toLowerCase();
  const filtered = this.slashCommands
    .filter(c => String(c.cmd || '').toLowerCase().startsWith(q))
    // For base queries like "rss", show "/rss add" before plain "/rss" so
    // discoverable subcommands appear first and users don't keep selecting the
    // generic base command by accident.
    .sort((a, b) => {
      if (!q || q.includes(' ')) return 0;
      const aCmd = String(a.cmd || '').toLowerCase();
      const bCmd = String(b.cmd || '').toLowerCase();
      const aSub = aCmd.startsWith(`${q} `) ? 1 : 0;
      const bSub = bCmd.startsWith(`${q} `) ? 1 : 0;
      if (aSub !== bSub) return bSub - aSub;
      return aCmd.localeCompare(bCmd);
    })
    .slice(0, 10);

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
  const input = this._slashInput || document.getElementById('message-input');
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

  // Insert status dot to the right of the username block. The dot sits inside
  // a real <button> so it looks and behaves like the control it has always
  // been — on its own an 8px dot reads as a status indicator, not something
  // clickable. _updateStatusPickerUI still owns the inner dot's classes.
  const statusBtn = document.createElement('button');
  statusBtn.id = 'user-status-btn';
  statusBtn.className = 'status-picker-btn';
  statusBtn.type = 'button';
  statusBtn.title = t('app.profile.set_status');
  statusBtn.setAttribute('aria-label', t('app.profile.set_status'));

  const statusDot = document.createElement('span');
  statusDot.id = 'user-status-dot';
  statusDot.className = 'user-dot status-picker-dot';
  statusBtn.appendChild(statusDot);
  statusBtn.addEventListener('click', (e) => { e.stopPropagation(); this._toggleStatusPicker(); });

  const userNames = userBar.querySelector('.user-names');
  if (userNames && userNames.nextSibling) {
    userBar.insertBefore(statusBtn, userNames.nextSibling);
  } else {
    userBar.appendChild(statusBtn);
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
    <div class="status-activity-row">
      <div class="status-activity-label">${t('app.profile.share_activity_title')}</div>
      <label class="status-activity-toggle" title="${t('app.profile.share_activity_hint')}">
        <span>${t('app.profile.music_activity')}</span>
        <input type="checkbox" id="status-music-activity">
      </label>
      <label class="status-activity-toggle" title="${t('app.profile.share_activity_hint')}">
        <span>${t('app.profile.game_activity')}</span>
        <input type="checkbox" id="status-game-activity">
      </label>
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

  // Quick activity toggles. Same two server-side preferences the Activity
  // section in Settings writes, so the two stay in lockstep either way.
  const bindQuickActivity = (el, kind, prefKey) => {
    if (!el) return;
    el.addEventListener('change', () => {
      if (el.checked && !this._activityProviderReady(kind)) {
        // Nothing is linked that could produce this activity yet, so flipping
        // the preference here would be a no-op the user can't diagnose. Send
        // them to the full Activity section, which explains the setup and is
        // where the account connections live.
        el.checked = false;
        picker.style.display = 'none';
        this._openActivitySettings();
        return;
      }
      const v = String(el.checked);
      if (this._userPrefs) this._userPrefs[prefKey] = v;
      this.socket?.emit('set-preference', { key: prefKey, value: v });
      // The sub-preferences do nothing while the master switch is off. Turning
      // one on from here turns the master on too, rather than showing a ticked
      // box that shares nothing.
      if (el.checked && this._userPrefs?.share_activity === 'false') {
        this._userPrefs.share_activity = 'true';
        this.socket?.emit('set-preference', { key: 'share_activity', value: 'true' });
      }
      this._syncActivityUI?.();
      this._syncStatusPickerActivity();
    });
  };
  bindQuickActivity(document.getElementById('status-music-activity'), 'music', 'share_music_activity');
  bindQuickActivity(document.getElementById('status-game-activity'),  'game',  'share_game_activity');

  // Close picker on outside click
  document.addEventListener('click', (e) => {
    if (!picker.contains(e.target) && !statusBtn.contains(e.target)) {
      picker.style.display = 'none';
    }
  });
},

_toggleStatusPicker() {
  const picker = document.getElementById('status-picker');
  // Anchor on the button, which is the visible surface now, falling back to the
  // dot so nothing breaks if the markup is ever built the old way.
  const dot = document.getElementById('user-status-btn') || document.getElementById('user-status-dot');
  // Preferences can change from the Settings panel (or another device) while
  // the picker sits in the DOM, so re-read them every time it opens.
  this._syncStatusPickerActivity();
  if (picker.style.display !== 'none' && picker.style.display !== '') {
    picker.style.display = 'none';
    return;
  }
  // Position the fixed picker relative to the status dot
  if (dot) {
    const rect = dot.getBoundingClientRect();
    const isMobile = window.innerWidth <= 480;
    // On mobile, center horizontally and open above the user bar
    if (isMobile) {
      picker.style.left = '10px';
      picker.style.right = '10px';
      picker.style.width = 'auto';
      picker.style.bottom = (window.innerHeight - rect.top + 4) + 'px';
      picker.style.top = 'auto';
      // Clamp so it doesn't go above the safe area
      const maxBottom = window.innerHeight - 10;
      const computedBottom = window.innerHeight - rect.top + 4;
      if (computedBottom > maxBottom) {
        picker.style.bottom = maxBottom + 'px';
      }
    } else {
      picker.style.left = rect.left + 'px';
      picker.style.right = 'auto';
      picker.style.width = '220px';
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
  }
  picker.style.display = 'block';
},

// Is there anything linked that could actually produce this kind of activity?
// Haven's own music player shares without a connection, but it only runs while
// you're listening in a voice channel, so a linked provider is still the right
// signal for whether the toggle has anything to do day to day.
_activityProviderReady(kind) {
  const linked = new Set((this._connections?.connections || []).map(c => c.provider));
  return kind === 'music'
    ? (linked.has('lastfm') || linked.has('spotify'))
    : linked.has('steam');
},

// Open Settings on the Activity section (master switch + connections).
// Mirrors the pattern used by the recovery-codes and push notices.
_openActivitySettings() {
  document.getElementById('open-settings-btn')?.click();
  setTimeout(() => {
    document.querySelector('.settings-nav-item[data-target="section-activity"]')?.click();
  }, 150);
},

// Reflect the current preferences on the quick toggles. A box is only ticked
// when something would actually be shared: the master switch is on, the
// sub-preference is on, AND an account is linked that can produce it. Both
// sub-preferences default to on when absent, so without the readiness check a
// brand new user would open this menu and see both already ticked while
// nothing was being shared at all. Showing them off means ticking one routes
// to the Activity settings, which is where the setup actually happens.
_syncStatusPickerActivity() {
  const prefs = this._userPrefs || {};
  const master = prefs.share_activity !== 'false';
  const music = document.getElementById('status-music-activity');
  const game  = document.getElementById('status-game-activity');
  // Absent sub-preference means "on" — matches the server's read in activity.js.
  if (music) music.checked = master && prefs.share_music_activity !== 'false'
                             && this._activityProviderReady('music');
  if (game)  game.checked  = master && prefs.share_game_activity  !== 'false'
                             && this._activityProviderReady('game');
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
_uploadGeneralFile(file, targetCode) {
  const code = targetCode || this.currentChannel;
  if (!code) return this._showToast(t('media.select_channel_first'), 'error');
  // Block media uploads if disabled in this channel
  const _ugCh = this.channels.find(c => c.code === code);
  if (_ugCh && _ugCh.media_enabled === 0) {
    return this._showToast(t('media.uploads_disabled'), 'error');
  }
  const maxMb = parseInt(this.serverSettings?.max_upload_mb) || 25;
  if (file.size > maxMb * 1024 * 1024) {
    this._showToast(t('media.file_too_large', { maxMb }), 'error');
    return;
  }

  // E2E DM path (#5310, #5308): if this channel is an E2E DM, encrypt the
  // file bytes before upload and send the metadata as an encrypted text
  // message. Without this, drag-drop / 📎 / paste / PiP-paste of any non-image
  // file (and any image pasted into the PiP) lands plaintext on the server
  // filesystem, defeating the DM's E2E guarantee.
  this._maybeUploadEncryptedDmFile(file, code, _ugCh).then(handled => {
    if (handled) return;

    const formData = new FormData();
    // Tells the server which column this lands in on the admin storage
    // report. It only ever splits this uploader's own total. (#5521)
    formData.append('scope', _ugCh && _ugCh.is_dm ? 'dm' : 'channel');
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
        code,
        content,
        replyTo: (code === this.currentChannel && this.replyingTo) ? this.replyingTo.id : null
      });
      this.notifications.play('sent');
      if (code === this.currentChannel) this._clearReply();
    })
    .catch(err => {
      if (err?.aborted) return;
      this._showToast(err.message || t('settings.admin.upload_failed'), 'error');
    });
  });
},

/**
 * If `code` is an E2E DM and the partner key is available, encrypt `file`,
 * upload as an opaque blob, then send the metadata as an encrypted
 * `e2e-file:{json}` text message. Returns true if handled, false otherwise
 * (so the caller can fall back to the plaintext upload path). (#5310, #5308)
 */
async _maybeUploadEncryptedDmFile(file, code, ch) {
  if (!ch || !ch.is_dm || !ch.dm_target) return false;
  let partner = this._getE2EPartnerFor ? this._getE2EPartnerFor(code) : this._getE2EPartner();
  if (!partner && this.e2e && this.e2e.ready) {
    const jwk = await this.e2e.requestPartnerKey(this.socket, ch.dm_target.id);
    if (jwk) {
      this._dmPublicKeys[ch.dm_target.id] = jwk;
      partner = this._getE2EPartnerFor ? this._getE2EPartnerFor(code) : this._getE2EPartner();
    }
  }
  if (!partner) return false;
  try {
    const arrayBuffer = await file.arrayBuffer();
    const encrypted = await this.e2e.encryptBytes(arrayBuffer, partner.userId, partner.publicKeyJwk);
    const blob = new Blob([encrypted], { type: 'application/octet-stream' });
    const formData = new FormData();
    formData.append('scope', 'dm');
    formData.append('file', blob, 'e2e-file.enc');
    const data = await this._uploadWithProgress('/api/upload-file', formData);
    if (!data || !data.url) {
      this._showToast(t('toasts.encrypted_image_failed'), 'error');
      return true;
    }
    const meta = JSON.stringify({
      mime: file.type || 'application/octet-stream',
      size: file.size,
      url: data.url,
      name: file.name || 'file'
    });
    // Images (including SVG) use e2e-img: so they render inline (#5309)
    const isImage = (file.type || '').startsWith('image/');
    const marker = isImage
      ? `e2e-img:${file.type || 'image/png'}:${data.url}`
      : `e2e-file:${meta}`;
    const encryptedText = await this.e2e.encrypt(marker, partner.userId, partner.publicKeyJwk);
    this.socket.emit('send-message', {
      code,
      content: encryptedText,
      encrypted: true,
      replyTo: (code === this.currentChannel && this.replyingTo) ? this.replyingTo.id : null
    });
    this.notifications.play('sent');
    if (code === this.currentChannel) this._clearReply();
    return true;
  } catch (err) {
    if (err?.aborted) return true;
    console.error('[E2E] File encryption failed:', err);
    const _detail = err?.message ? ` — ${err.message}` : '';
    this._showToast(`${t('toasts.encrypted_image_failed')}${_detail}`, 'error');
    return true;
  }
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
      window._updateSbToggleRight?.(); // keep both collapse btns aligned during drag
    });
    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      rightHandle.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      localStorage.setItem('haven_right_sidebar_width', parseInt(rightSidebar.style.width));
      window._updateSbToggleRight?.();
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
      if (!res.ok) throw new Error(data.error || t('settings.admin.import_connection_failed'));

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
            reject(new Error(err.error || t('settings.admin.import_upload_failed')));
          } catch {
            reject(new Error(t('settings.admin.import_upload_failed_status', { status: xhr.status })));
          }
        }
      };
      xhr.onerror = () => reject(new Error(t('settings.admin.import_network_error')));
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
            <input type="text" value="${this._escapeHtml(ch.name)}" title="${t('settings.admin.import_rename_channel')}">
          </span>
        </label>
        <span class="import-ch-count">${t('settings.admin.import_messages_short', { count: ch.messageCount.toLocaleString() })}</span>
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
    if (!res.ok) throw new Error(data.error || t('settings.admin.import_load_channels_failed'));

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
        ? ` <span class="muted-text" style="font-size:0.625rem">(${ch.tags.map(t => t.name).join(', ')})</span>`
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
            ? ` <span class="muted-text" style="font-size:0.625rem">[${t.tags.join(', ')}]</span>`
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
            <span class="import-ch-count import-type-badge">${t('settings.admin.import_thread')}</span>
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
              <span class="import-ch-name">🧵 ${this._escapeHtml(t.name)}${t.parentName ? ` <span class="muted-text" style="font-size:0.625rem">${window.t('settings.admin.import_in_channel', { name: this._escapeHtml(t.parentName) })}</span>` : ''}</span>
            </label>
            <span class="import-ch-count import-type-badge">${window.t('settings.admin.import_thread')}</span>
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
  fetchBtn.textContent = `⏳ ${t('settings.admin.import_fetching')}`;
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
    if (!res.ok) throw new Error(result.error || t('settings.admin.import_fetch_failed'));

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
            <input type="text" value="${this._escapeHtml(ch.name)}" title="${t('settings.admin.import_rename_channel')}">
          </span>
        </label>
        <span class="import-ch-count">${t('settings.admin.import_messages_short', { count: ch.messageCount.toLocaleString() })}</span>
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
    if (data.channelsReused > 0) {
      doneMsg.textContent += ' ' + t('settings.admin.import_reused', { count: data.channelsReused });
    }
    if (data.messagesSkipped > 0) {
      doneMsg.textContent += ' ' + t('settings.admin.import_skipped', { count: data.messagesSkipped.toLocaleString() });
    }

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

// Every role-editor emit that expects an ack goes through this wrapper. A
// server that predates an event never sends the ack, so the plain callback
// form waits forever and the UI does nothing — no toast, no error, nothing.
// That is exactly what happens on partially-updated self-hosts (new public/
// files served by an old server.js, e.g. a server older than 3.44.0 asked for
// 'update-admin-role-display'). Surface it as an actionable error instead.
_roleEmit(event, payload, cb) {
  this.socket.timeout(10000).emit(event, payload, (err, res) => {
    if (err) { this._showToast(t('toasts.role_server_no_response'), 'error'); return; }
    if (typeof cb === 'function') cb(res);
  });
},

_initRoleManagement() {
  this._allRoles = [];
  this._selectedRoleId = null;
  this._adminRoleDisplay = null;

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
    if (isNaN(level) || level < 0 || level > 99) { this._showToast(t('settings.admin.roles_level_invalid'), 'error'); return; }
    this._roleEmit('create-role', { name: name.trim(), level, color: '#aaaaaa' }, (res) => {
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
    const modal = document.getElementById('assign-role-modal');
    const userId = parseInt(modal.dataset.userId, 10);
    const scope = document.getElementById('assign-role-scope').value;
    if (!userId) return;
    const channelId = scope !== 'server' ? parseInt(scope, 10) : null;

    // Multi-role: gather every checked role and diff against currently held
    // roles for this scope. Assign the new ones, revoke the unchecked ones.
    const checked = new Set(
      Array.from(document.querySelectorAll('#assign-role-checkboxes .assign-role-checkbox:checked'))
        .map(el => parseInt(el.value, 10))
        .filter(id => Number.isInteger(id))
    );
    const held = new Set(
      (this._assignRoleHeldRoles || [])
        .filter(r => (channelId === null && (r.channel_id === null || r.channel_id === undefined))
                   || (channelId !== null && r.channel_id === channelId))
        .map(r => r.id)
    );
    const toAssign = [...checked].filter(id => !held.has(id));
    const toRevoke = [...held].filter(id => !checked.has(id));

    if (toAssign.length === 0 && toRevoke.length === 0) {
      modal.style.display = 'none';
      return;
    }

    let pending = toAssign.length + toRevoke.length;
    let firstError = null;
    const finish = () => {
      if (firstError) { this._showToast(firstError, 'error'); return; }
      this._showToast(t('settings.admin.roles_assigned'), 'success');
      modal.style.display = 'none';
    };

    toAssign.forEach(roleId => {
      this._roleEmit('assign-role', { userId, roleId, channelId }, (res) => {
        if (res && res.error && !firstError) firstError = res.error;
        if (--pending === 0) finish();
      });
    });
    toRevoke.forEach(roleId => {
      this._roleEmit('revoke-role', { userId, roleId, channelId }, (res) => {
        if (res && res.error && !firstError) firstError = res.error;
        if (--pending === 0) finish();
      });
    });
  });

  // Listen for role updates
  this.socket.on('roles-updated', () => this._loadRoles());

  // Reset roles to default
  document.getElementById('reset-roles-btn')?.addEventListener('click', () => {
    if (!confirm(t('settings.admin.roles_reset_confirm'))) return;
    this._roleEmit('reset-roles-to-default', {}, (res) => {
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
  this._roleEmit('get-roles', {}, (res) => {
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
      <span>${this._escapeHtml(r.name)}${r.auto_assign ? ` <span title="${t('settings.admin.role_form.auto_assign')}" style="font-size:0.625rem;opacity:0.6">⚡</span>` : ''}</span>
      <span class="muted-text" style="font-size:0.6875rem;margin-left:auto">Lv.${r.level}</span>
    </div>`
  ).join('');
  // Keep the "channel creator role" picker in sync with the role list (#5461)
  this._renderChannelCreatorRoleSelect();
},

// (#5461) Build the "Channel creator role" dropdown from the current roles and
// select the saved value. 'default' = highest channel-scoped role (pre-5461
// behavior), 'none' = no auto-grant, or a specific role id.
_renderChannelCreatorRoleSelect() {
  const sel = document.getElementById('channel-creator-role-select');
  if (!sel) return;
  const roles = this._allRoles || [];
  const saved = (this.serverSettings && typeof this.serverSettings.channel_creator_role === 'string')
    ? this.serverSettings.channel_creator_role.trim() : '';
  const value = (saved === '') ? 'default' : saved;

  sel.innerHTML =
    `<option value="default">${this._escapeHtml(t('settings.admin.channel_creator_role_default'))}</option>` +
    `<option value="none">${this._escapeHtml(t('settings.admin.channel_creator_role_none'))}</option>` +
    roles.map(r => {
      const scope = r.scope === 'channel' ? 'channel' : 'server';
      return `<option value="${r.id}">${this._escapeHtml(r.name)} (${scope}, Lv.${r.level})</option>`;
    }).join('');

  // Fall back to Default if the saved role was since deleted.
  const has = Array.from(sel.options).some(o => o.value === String(value));
  sel.value = has ? String(value) : 'default';

  if (!this._ccrWired) {
    this._ccrWired = true;
    sel.addEventListener('change', () => {
      const v = sel.value; // 'default' | 'none' | '<roleId>'
      this.serverSettings = this.serverSettings || {};
      this.serverSettings.channel_creator_role = (v === 'default') ? '' : v;
      this.socket.emit('update-server-setting', { key: 'channel_creator_role', value: v });
    });
  }
},

_openRoleModal() {
  document.getElementById('role-modal').style.display = 'flex';
  // Admin-only: fetch the current cosmetic display for the synthetic Admin
  // role so the sidebar entry shows its saved name/colour.
  if (this.user && this.user.isAdmin) {
    this._roleEmit('get-admin-role-display', {}, (res) => {
      if (res && res.display) { this._adminRoleDisplay = res.display; this._renderRoleSidebar(); }
    });
  }
  this._loadRoles();
},

_renderRoleSidebar() {
  const list = document.getElementById('role-list-sidebar');
  if (!list) return;
  let html = '';
  // Admin-only: the synthetic Admin role sits on top, separated from the real
  // roles by a divider. Its id is the string 'admin' so it never collides with
  // real (integer) role ids.
  if (this.user && this.user.isAdmin) {
    const d = this._adminRoleDisplay || { name: 'Admin', color: '#e74c3c' };
    html += `<div class="role-sidebar-item${this._selectedRoleId === 'admin' ? ' active' : ''}" data-role-id="admin">
      <span class="role-color-dot" style="background:${this._safeColor(d.color, '#e74c3c')}"></span>
      ${this._escapeHtml(d.name)}
    </div>
    <div class="role-sidebar-divider"></div>`;
  }

  // leveled roles
  const leveledRoles = this._allRoles.filter(r => r.level > 0);
  html += leveledRoles.map(r =>
    `<div class="role-sidebar-item${this._selectedRoleId === r.id ? ' active' : ''}" data-role-id="${r.id}">
      <span class="role-color-dot" style="background:${this._safeColor(r.color, '#aaa')}"></span>
      ${this._escapeHtml(r.name)}
      <span class="role-sidebar-level">Lv.${r.level}</span>
    </div>`
  ).join('');

  // Groups (level 0) sit below real roles, separated by a divider.
  const groups = this._allRoles.filter(r => r.level === 0);
  if (leveledRoles.length && groups.length) {
    html += '<div class="role-sidebar-divider"></div>';
    html += '<div class="role-sidebar-section-label">' + t('modals.role_management.groups_label') + '</div>';
  }
  html += groups.map(r =>
    `<div class="role-sidebar-item${this._selectedRoleId === r.id ? ' active' : ''}" data-role-id="${r.id}">
      <span class="role-color-dot" style="background:${this._safeColor(r.color, '#aaa')}"></span>
      ${this._escapeHtml(r.name)}
    </div>`
  ).join('');

  list.innerHTML = html;
  list.querySelectorAll('.role-sidebar-item').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.dataset.roleId;
      this._selectedRoleId = (id === 'admin') ? 'admin' : parseInt(id, 10);
      this._renderRoleSidebar();
      this._renderRoleDetail();
    });
  });
},

// Whether the current user may toggle permission `p` on a role. A non-admin
// can only add or remove permissions they personally hold; admin-only perms
// and perms they lack are locked. Mirrors the server rule in update-role
// (socketHandlers/roles.js), which preserves any locked perm the role already
// has rather than deleting it — so the UI disables those toggles instead of
// letting the user check/uncheck them and be silently overridden.
_canControlRolePerm(p) {
  return !!(this.user && this.user.isAdmin) || (!ADMIN_ONLY_PERMS.includes(p) && this._hasPerm(p));
},

// Cosmetic-only editor for the synthetic Admin role. Everything here maps to
// the 'admin_role_display' server setting and changes appearance only — the
// admin keeps level 100 and every permission regardless. No level, permissions,
// auto-assign or delete, because there is nothing functional to edit.
_renderAdminRoleDetail() {
  const panel = document.getElementById('role-detail-panel');
  const d = this._adminRoleDisplay || { name: 'Admin', color: '#e74c3c', icon: null, visible: true };
  // The shared modal-actions Save button is for real roles; this editor is
  // self-contained with its own Save, so hide the shared one.
  const sharedSave = document.getElementById('save-role-btn');
  if (sharedSave) sharedSave.style.display = 'none';
  const iconPreview = d.icon
    ? `<img class="role-icon-preview" src="${this._escapeHtml(d.icon)}" alt="${t('settings.admin.role_form.icon')}">`
    : `<div class="role-icon-preview" style="display:flex;align-items:center;justify-content:center;font-size:0.6875rem;color:var(--text-muted)">${t('settings.admin.role_form.icon_none')}</div>`;

  panel.innerHTML = `
    <div class="role-detail-form">
      <p class="perm-admin-note">${t('settings.admin.role_form.admin_cosmetic_note')}</p>
      <label class="settings-label">${t('settings.admin.role_form.name')}</label>
      <input type="text" class="settings-text-input" id="admin-role-name" value="${this._escapeHtml(d.name)}" maxlength="30">
      <label class="settings-label" style="margin-top:8px;">${t('settings.admin.role_form.color')}</label>
      <input type="color" id="admin-role-color" value="${this._safeColor(d.color, '#e74c3c')}" style="width:50px;height:30px;border:none;cursor:pointer">
      <label class="settings-label" style="margin-top:8px;">${t('settings.admin.role_form.icon')}</label>
      <div class="role-icon-upload-row">
        ${iconPreview}
        <input type="file" id="admin-role-icon-file" accept="image/png,image/jpeg,image/gif,image/webp" style="display:none">
        <button class="btn-sm" id="admin-role-icon-upload-btn" type="button">${t('settings.admin.upload_btn')}</button>
        ${d.icon ? `<button class="btn-sm danger" id="admin-role-icon-remove-btn" type="button">${t('settings.admin.remove_btn')}</button>` : ''}
      </div>
      <small class="muted-text" style="font-size:0.6875rem;">${t('settings.admin.role_form.icon_hint')}</small>
      <label class="toggle-row" style="margin-top:12px;">
        <span>${t('settings.admin.role_form.visibility')}</span>
        <input type="checkbox" id="admin-role-visible" ${d.visible ? 'checked' : ''}>
      </label>
      <small class="muted-text" style="font-size:0.6875rem;">${t('settings.admin.role_form.visibility_hint')}</small>
      <div style="margin-top:12px;">
        <button class="btn-sm btn-accent" id="admin-role-save-btn">${t('settings.admin.roles_save')}</button>
      </div>
    </div>
  `;

  // Pending icon change: undefined = unchanged, null = removed, string = new path.
  this._pendingAdminIcon = undefined;
  const fileInput = document.getElementById('admin-role-icon-file');
  document.getElementById('admin-role-icon-upload-btn')?.addEventListener('click', () => fileInput.click());
  fileInput?.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) return;
    if (file.size > 512 * 1024) { this._showToast(t('settings.admin.role_form.icon_too_large'), 'error'); return; }
    let uploadFile = file;
    try {
      const bmp = await createImageBitmap(file);
      if (bmp.width !== 16 || bmp.height !== 16) {
        const canvas = document.createElement('canvas');
        canvas.width = 16; canvas.height = 16;
        canvas.getContext('2d').drawImage(bmp, 0, 0, 16, 16);
        bmp.close();
        uploadFile = await new Promise(r => canvas.toBlob(r, 'image/png'));
      } else { bmp.close(); }
    } catch { /* fall through with original file */ }
    const fd = new FormData();
    fd.append('icon', uploadFile, 'role-icon.png');
    try {
      const res = await fetch('/api/upload-role-icon', { method: 'POST', headers: { 'Authorization': 'Bearer ' + this.token }, body: fd });
      const j = await res.json();
      if (j.error) { this._showToast(j.error, 'error'); return; }
      this._pendingAdminIcon = j.path;
      const preview = panel.querySelector('.role-icon-preview');
      if (preview) preview.outerHTML = `<img class="role-icon-preview" src="${this._escapeHtml(j.path)}" alt="${t('settings.admin.role_form.icon')}">`;
      this._showToast(t('settings.admin.role_form.icon_uploaded_admin'), 'success');
    } catch { this._showToast(t('settings.admin.upload_failed'), 'error'); }
  });
  document.getElementById('admin-role-icon-remove-btn')?.addEventListener('click', () => {
    this._pendingAdminIcon = null;
    const preview = panel.querySelector('.role-icon-preview');
    if (preview) preview.outerHTML = `<div class="role-icon-preview" style="display:flex;align-items:center;justify-content:center;font-size:0.6875rem;color:var(--text-muted)">${t('settings.admin.role_form.icon_none')}</div>`;
    document.getElementById('admin-role-icon-remove-btn')?.remove();
    this._showToast(t('settings.admin.role_form.icon_removed_admin'), 'success');
  });

  document.getElementById('admin-role-save-btn')?.addEventListener('click', () => {
    const icon = this._pendingAdminIcon !== undefined ? this._pendingAdminIcon : (d.icon || null);
    const payload = {
      name: document.getElementById('admin-role-name').value.trim() || 'Admin',
      color: document.getElementById('admin-role-color').value,
      icon,
      visible: document.getElementById('admin-role-visible').checked
    };
    this._roleEmit('update-admin-role-display', payload, (res) => {
      if (res && res.error) { this._showToast(res.error, 'error'); return; }
      this._adminRoleDisplay = res.display || payload;
      this._showToast(t('settings.admin.roles_saved'), 'success');
      this._renderRoleSidebar();
      this._renderAdminRoleDetail();
    });
  });
},

_updateRoleLevelPermsVis(levelInputId, permissionsSectionId, permissionsNoteId) {
  const levelInput = document.getElementById(levelInputId);
  const permissionsSection = document.getElementById(permissionsSectionId);
  const permissionsNote = document.getElementById(permissionsNoteId);

  if (!levelInput || (!permissionsSection && !permissionsNote)) return;
  const update = () => {
    const level = parseInt(levelInput.value, 10);
    const isLevelZero = level === 0;

    if(permissionsSection) permissionsSection.style.display = isLevelZero ? 'none' : '';
    if (permissionsNote) permissionsNote.textContent = isLevelZero ? t('settings.admin.role_form.level_0_role_note') : t('settings.admin.role_form.admin_only_note');
  };

  levelInput.addEventListener('input', update);
  update();
},

_renderRoleDetail() {
  const panel = document.getElementById('role-detail-panel');
  if (this._selectedRoleId === 'admin') { this._renderAdminRoleDetail(); return; }
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
      <input type="number" class="settings-number-input" id="role-edit-level" value="${role.level}" min="0" max="99">
      <label class="settings-label" style="margin-top:8px;">${t('settings.admin.role_form.color')}</label>
      <input type="color" id="role-edit-color" value="${role.color || '#aaaaaa'}" style="width:50px;height:30px;border:none;cursor:pointer">
      <label class="settings-label" style="margin-top:8px;">${t('settings.admin.role_form.icon')}</label>
      <div class="role-icon-upload-row">
        ${role.icon ? `<img class="role-icon-preview" src="${this._escapeHtml(role.icon)}" alt="${t('settings.admin.role_form.icon')}">` : `<div class="role-icon-preview" style="display:flex;align-items:center;justify-content:center;font-size:0.6875rem;color:var(--text-muted)">${t('settings.admin.role_form.icon_none')}</div>`}
        <input type="file" id="role-icon-file" accept="image/png,image/jpeg,image/gif,image/webp" style="display:none">
        <button class="btn-sm" id="role-icon-upload-btn" type="button">${t('settings.admin.upload_btn')}</button>
        ${role.icon ? `<button class="btn-sm danger" id="role-icon-remove-btn" type="button">${t('settings.admin.remove_btn')}</button>` : ''}
      </div>
      <small class="muted-text" style="font-size:0.6875rem;">${t('settings.admin.role_form.icon_hint')}</small>
      <label class="toggle-row" style="margin-top:12px;">
        <span>${t('settings.admin.role_form.auto_assign')}</span>
        <input type="checkbox" id="role-edit-auto-assign" ${role.auto_assign ? 'checked' : ''}>
      </label>
      <small class="muted-text" style="font-size:0.6875rem;">${t('settings.admin.role_form.auto_assign_hint')}</small>
      <div class="role-channel-access-section">
        <h5 class="settings-section-subtitle" style="margin-top:12px;">${t('settings.admin.role_form.channel_access')}</h5>
        <label class="toggle-row">
          <span>${t('settings.admin.role_form.link_channel_access')}</span>
          <input type="checkbox" id="role-edit-link-channel-access" ${role.link_channel_access ? 'checked' : ''}>
        </label>
        <small class="muted-text" style="font-size:0.6875rem;">${t('settings.admin.role_form.link_channel_access_hint')}</small>
        <div id="role-channel-access-panel" style="display:${role.link_channel_access ? 'block' : 'none'};margin-top:8px;">
          <div class="role-channel-access-list" id="role-channel-access-list">
            <p class="muted-text" style="padding:12px;text-align:center;font-size:0.75rem">${t('modals.common.loading')}</p>
          </div>
          <button class="btn-sm btn-accent rca-reapply-btn" id="rca-reapply-btn" title="${this._escapeHtml(t('settings.admin.role_form.reapply_access_tooltip'))}">🔄 ${t('settings.admin.role_form.reapply_access')}</button>
        </div>
      </div>
      <h5 class="settings-section-subtitle" style="margin-top:12px;">${t('settings.admin.role_form.permissions')}</h5>
      <p class="perm-admin-note" id="perm-admin-note">${role.level === 0 ? t('settings.admin.role_form.level_0_role_note') : t('settings.admin.role_form.admin_only_note')}</p>
      <div id="role-permissions-list" style="${role.level === 0 ? 'display:none;' : ''}">
        ${allPerms.map(p => {
          const locked = !this._canControlRolePerm(p);
          const adminOnly = ADMIN_ONLY_PERMS.includes(p);
          return `
          <label class="toggle-row${adminOnly ? ' perm-admin-only' : ''}"${locked ? ` style="opacity:.55" title="${t('settings.admin.role_form.permissions_held_only')}"` : ''}>
            <span>${permLabels[p] || p.replace(/_/g, ' ')}</span>
            <input type="checkbox" class="role-perm-checkbox" data-perm="${p}" ${rolePerms.includes(p) ? 'checked' : ''}${locked ? ' disabled' : ''}>
          </label>`;
        }).join('')}
      </div>
      <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn-sm btn-accent" id="role-members-btn">👥 ${t('settings.admin.role_form.members')}</button>
        <button class="btn-sm" id="duplicate-role-btn">📋 ${t('settings.admin.role_form.duplicate')}</button>
        <button class="btn-sm danger" id="delete-role-btn">${t('settings.admin.role_form.delete')}</button>
      </div>
    </div>
  `;

  // Toggle permissions visibility based on the current role level.
  this._updateRoleLevelPermsVis('role-edit-level', 'role-permissions-list', 'perm-admin-note');

  // Toggle channel access panel visibility
  const linkCheckbox = document.getElementById('role-edit-link-channel-access');
  const accessPanel = document.getElementById('role-channel-access-panel');

  // Role icon upload/remove
  this._pendingRoleIcon = undefined;
  const iconFileInput = document.getElementById('role-icon-file');
  document.getElementById('role-icon-upload-btn')?.addEventListener('click', () => iconFileInput.click());
  iconFileInput?.addEventListener('change', async () => {
    const file = iconFileInput.files[0];
    if (!file) return;
    if (file.size > 512 * 1024) { this._showToast(t('settings.admin.role_form.icon_too_large'), 'error'); return; }
    // Auto-resize to 16x16 on a canvas so any image size works
    let uploadFile = file;
    try {
      const bmp = await createImageBitmap(file);
      if (bmp.width !== 16 || bmp.height !== 16) {
        const canvas = document.createElement('canvas');
        canvas.width = 16; canvas.height = 16;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bmp, 0, 0, 16, 16);
        bmp.close();
        uploadFile = await new Promise(r => canvas.toBlob(r, 'image/png'));
      } else { bmp.close(); }
    } catch { /* fall through with original file */ }
    const fd = new FormData();
    fd.append('icon', uploadFile, 'role-icon.png');
    try {
      const res = await fetch('/api/upload-role-icon', { method: 'POST', headers: { 'Authorization': 'Bearer ' + this.token }, body: fd });
      const data = await res.json();
      if (data.error) { this._showToast(data.error, 'error'); return; }
      this._pendingRoleIcon = data.path;
      const preview = panel.querySelector('.role-icon-preview');
      if (preview) { preview.outerHTML = `<img class="role-icon-preview" src="${this._escapeHtml(data.path)}" alt="${t('settings.admin.role_form.icon')}">`; }
      this._showToast(t('settings.admin.role_form.icon_uploaded_role'), 'success');
    } catch { this._showToast(t('settings.admin.upload_failed'), 'error'); }
  });
  document.getElementById('role-icon-remove-btn')?.addEventListener('click', () => {
    this._pendingRoleIcon = null;
    const preview = panel.querySelector('.role-icon-preview');
    if (preview) { preview.outerHTML = `<div class="role-icon-preview" style="display:flex;align-items:center;justify-content:center;font-size:0.6875rem;color:var(--text-muted)">${t('settings.admin.role_form.icon_none')}</div>`; }
    const removeBtn = document.getElementById('role-icon-remove-btn');
    if (removeBtn) removeBtn.remove();
    this._showToast(t('settings.admin.role_form.icon_removed_role'), 'success');
  });
  linkCheckbox.addEventListener('change', () => {
    accessPanel.style.display = linkCheckbox.checked ? 'block' : 'none';
    if (linkCheckbox.checked) this._loadRoleChannelAccess(role.id);
  });
  // Load channel access if already enabled
  if (role.link_channel_access) this._loadRoleChannelAccess(role.id);

  // Reapply button
  document.getElementById('rca-reapply-btn').addEventListener('click', () => {
    if (!confirm(t('settings.admin.roles_reapply_confirm'))) return;
    this._roleEmit('reapply-role-access', { roleId: role.id }, (res) => {
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

    this._roleEmit('update-role', {
      roleId: role.id,
      name: document.getElementById('role-edit-name').value.trim(),
      level: parseInt(document.getElementById('role-edit-level').value, 10),
      color: document.getElementById('role-edit-color').value,
      icon: this._pendingRoleIcon !== undefined ? this._pendingRoleIcon : role.icon,
      autoAssign: document.getElementById('role-edit-auto-assign').checked,
      linkChannelAccess: linkEnabled,
      permissions: perms
    }, (res) => {
      if (res.error) { this._showToast(res.error, 'error'); freshSaveBtn.disabled = false; freshSaveBtn.textContent = t('settings.admin.roles_save'); return; }

      // Save channel access config separately
      if (linkEnabled && accessData.length) {
        this._roleEmit('update-role-channel-access', {
          roleId: role.id,
          linkEnabled: true,
          access: accessData
        }, (accRes) => {
          if (accRes && accRes.error) this._showToast(accRes.error, 'error');
        });
      } else if (!linkEnabled) {
        // Disable channel access linking
        this._roleEmit('update-role-channel-access', {
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

  document.getElementById('delete-role-btn').addEventListener('click', async () => {
    const ok = await this._showConfirmModal(
      t('settings.admin.roles_delete_confirm', { name: role.name }),
      '',
      { danger: true }
    );
    if (!ok) return;
    this._roleEmit('delete-role', { roleId: role.id }, (res) => {
      if (res.error) { this._showToast(res.error, 'error'); return; }
      this._showToast(t('settings.admin.roles_deleted'), 'success');
      this._selectedRoleId = null;
      this._loadRoles();
      this._renderRoleDetail();
    });
  });

  // Duplicate: prompt for new name (default = "<original> (copy)") then
  // create a fresh role with the same level, color, icon, and permissions.
  // Channel-access linkage and auto-assign are intentionally NOT copied —
  // both are rarely what an admin wants on a freshly cloned role.
  document.getElementById('duplicate-role-btn')?.addEventListener('click', async () => {
    const defaultName = t('settings.admin.roles_copy_name', { name: role.name }).slice(0, 30);
    const newName = await this._showPromptModal(t('settings.admin.roles_duplicate_title'), t('settings.admin.roles_duplicate_prompt'), defaultName);
    if (!newName || !newName.trim()) return;
    const trimmed = newName.trim().slice(0, 30);
    this._roleEmit('create-role', {
      name: trimmed,
      level: role.level,
      color: role.color || '#aaaaaa',
      icon: role.icon || null,
      autoAssign: false,
      permissions: role.permissions || []
    }, (res) => {
      if (res && res.error) { this._showToast(res.error, 'error'); return; }
      this._showToast(t('settings.admin.roles_duplicated_as', { name: trimmed }), 'success');
      if (res && res.roleId) this._selectedRoleId = res.roleId;
      this._loadRoles?.();
    });
  });

  document.getElementById('role-members-btn')?.addEventListener('click', () => {
    this._openRoleMembersModal(role);
  });

  // Role hierarchy gate: a non-admin may only edit roles strictly below their
  // own level. Roles at or above them are shown read-only (every field and
  // mutating action disabled) — mirrors the server guard in update-role and
  // the RAC's grantable-roles lock. Runs last so it overrides the Save button
  // being re-shown above. Viewing members stays available (read-only).
  this._applyRoleEditGate(panel, role, {
    actionButtonIds: ['save-role-btn', 'delete-role-btn', 'duplicate-role-btn'],
    keepEnabledIds: ['role-members-btn'],
    formSelector: '.role-detail-form'
  });
},

// Disables the whole role editor for a non-admin when `role.level` is at or
// above the caller's level, and prepends a read-only note. Shared by both role
// editors so the rule stays in one place.
_applyRoleEditGate(panel, role, { actionButtonIds = [], keepEnabledIds = [], formSelector }) {
  const isAdmin = !!(this.user && this.user.isAdmin);
  const myLevel = (this.user && this.user.effectiveLevel) || 0;
  if (isAdmin || role.level < myLevel) return;

  panel.querySelectorAll('input, select, textarea, button').forEach(el => { el.disabled = true; });
  keepEnabledIds.forEach(id => { const el = document.getElementById(id); if (el) el.disabled = false; });
  actionButtonIds.forEach(id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; });

  const form = formSelector ? panel.querySelector(formSelector) : panel;
  if (form && !form.querySelector('.role-readonly-note')) {
    const note = document.createElement('p');
    note.className = 'role-readonly-note';
    note.textContent = t('settings.admin.role_form.readonly_note', { level: myLevel });
    form.insertBefore(note, form.firstChild);
  }
},

_openRoleMembersModal(role) {
  const modal = document.getElementById('role-members-modal');
  if (!modal) return;
  document.getElementById('role-members-modal-title').textContent = role.name;
  document.getElementById('role-members-search').value = '';

  const listEl = document.getElementById('role-members-list');
  listEl.innerHTML = `<p class="rac-placeholder" style="padding:16px;text-align:center">${t('modals.common.loading')}</p>`;

  modal.style.display = 'flex';
  modal.style.zIndex = '100004';

  let cachedData = null;

  const renderList = (users, filter) => {
    const q = (filter || '').toLowerCase();
    const filtered = users.filter(u =>
      !q || u.username.toLowerCase().includes(q) ||
      (u.displayName || '').toLowerCase().includes(q)
    );
    if (!filtered.length) {
      listEl.innerHTML = `<p class="rac-placeholder" style="padding:16px;text-align:center">${t('settings.admin.roles_no_members_found')}</p>`;
      return;
    }
    listEl.innerHTML = filtered.map(u => {
      const hasRole = u.currentRoles.some(r => r.id === role.id && !r.channel_id);
      const color = this._getUserColor(u.username);
      const initial = (u.displayName || u.username).charAt(0).toUpperCase();
      const shapeStyle = u.avatarShape === 'square' ? 'border-radius:4px' : '';
      const avatarHtml = u.avatar
        ? `<img class="rac-user-avatar" src="${this._escapeHtml(u.avatar)}" alt="${initial}" style="${shapeStyle}">`
        : `<span class="rac-user-avatar" style="background-color:${color};${shapeStyle}">${initial}</span>`;
      const badgeHtml = hasRole
        ? `<span class="role-member-badge" style="background:${this._safeColor(role.color,'#aaa')}22;color:${this._safeColor(role.color,'#aaa')};border:1px solid ${this._safeColor(role.color,'#aaa')}44;border-radius:4px;padding:1px 6px;font-size:0.6875rem;white-space:nowrap">${this._escapeHtml(role.name)}</span>`
        : '';
      return `<div class="rac-user-item" style="cursor:default;gap:10px" data-uid="${u.id}">
        ${avatarHtml}
        <span style="flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:0.8125rem">${this._escapeHtml(this._getNickname(u.id, u.displayName))}</span>
        ${badgeHtml}
        <button class="btn-sm${hasRole ? ' danger' : ' btn-accent'} role-member-toggle-btn" data-uid="${u.id}" data-has="${hasRole}" style="flex-shrink:0;min-width:64px">
          ${t(hasRole ? 'settings.admin.roles_remove' : 'settings.admin.roles_assign')}
        </button>
      </div>`;
    }).join('');

    listEl.querySelectorAll('.role-member-toggle-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const uid = parseInt(btn.dataset.uid, 10);
        const has = btn.dataset.has === 'true';
        btn.disabled = true;
        const event = has ? 'revoke-role' : 'assign-role';
        this.socket.emit(event, { userId: uid, roleId: role.id, channelId: null }, (res) => {
          if (res && res.error) {
            this._showToast(res.error, 'error');
            btn.disabled = false;
            return;
          }
          this._roleEmit('get-role-assignment-data', {}, (r) => {
            if (!r.error) { cachedData = r; renderList(r.users, document.getElementById('role-members-search').value); }
          });
        });
      });
    });
  };

  this._roleEmit('get-role-assignment-data', {}, (res) => {
    if (res.error) { this._showToast(res.error, 'error'); return; }
    cachedData = res;
    renderList(res.users, '');
  });

  const searchEl = document.getElementById('role-members-search');
  // Replace old listener by cloning
  const freshSearch = searchEl.cloneNode(true);
  searchEl.parentNode.replaceChild(freshSearch, searchEl);
  freshSearch.addEventListener('input', (e) => {
    if (cachedData) renderList(cachedData.users, e.target.value);
  });

  const closeBtn = document.getElementById('role-members-close-btn');
  const freshClose = closeBtn.cloneNode(true);
  closeBtn.parentNode.replaceChild(freshClose, closeBtn);
  freshClose.addEventListener('click', () => { modal.style.display = 'none'; });
  modal.onclick = (e) => { if (e.target === modal) modal.style.display = 'none'; };
},

_loadRoleChannelAccess(roleId) {
  const listEl = document.getElementById('role-channel-access-list');
  if (!listEl) return;
  listEl.innerHTML = `<p class="muted-text" style="padding:12px;text-align:center;font-size:0.75rem">${t('modals.common.loading')}</p>`;

  this._roleEmit('get-role-channel-access', { roleId }, (res) => {
    if (res && res.error) {
      listEl.innerHTML = `<p class="muted-text" style="padding:12px;text-align:center;font-size:0.75rem">${this._escapeHtml(res.error)}</p>`;
      return;
    }
    const channels = res.channels || [];
    const accessMap = {};
    (res.access || []).forEach(a => { accessMap[a.channel_id] = a; });

    if (!channels.length) {
      listEl.innerHTML = `<p class="muted-text" style="padding:12px;text-align:center;font-size:0.75rem">${t('settings.admin.roles_no_channels')}</p>`;
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
    this._roleEmit('get-channel-member-roles', { code: channelCode }, (res) => {
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
          `<span class="channel-roles-badge"><span class="badge-dot" style="background:${this._safeColor(r.color, '#aaa')}"></span>${this._escapeHtml(r.name)}<span class="badge-scope">${r.scope === 'channel' ? `📌 ${t('settings.admin.roles_scope_channel')}` : `🌐 ${t('settings.admin.roles_scope_server')}`}</span><span class="revoke-btn" data-uid="${m.id}" data-rid="${r.roleId}" data-scope="${r.scope}" title="${t('settings.admin.roles_revoke')}">✕</span></span>`
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
      this._roleEmit('revoke-role', { userId: uid, roleId: rid, channelId });
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
    currentDiv.innerHTML = `<span class="channel-roles-badge" style="background:rgba(231,76,60,0.2);color:#e74c3c"><span class="badge-dot" style="background:#e74c3c"></span>${t('settings.admin.badge_admin')}</span>`;
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
      `<span class="channel-roles-badge"><span class="badge-dot" style="background:${this._safeColor(r.color, '#aaa')}"></span>${this._escapeHtml(r.name)} <span class="badge-scope">${r.scope === 'channel' ? `📌 ${t('settings.admin.roles_scope_channel')}` : `🌐 ${t('settings.admin.roles_scope_server')}`}</span></span>`
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

  this._roleEmit('assign-role', { userId, roleId, channelId }, (res) => {
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
  this._roleEmit('get-channel-member-roles', { code: this._channelRolesCode }, (res) => {
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

  const renderRole = r =>
    `<div class="channel-roles-role-item${this._channelRolesSelectedRole === r.id ? ' active' : ''}" data-role-id="${r.id}">
      <span class="role-color-dot" style="background:${this._safeColor(r.color, '#aaa')}"></span>
      <span class="channel-roles-role-name">${this._escapeHtml(r.name)}</span>
      <span class="channel-roles-role-level">Lv.${r.level}</span>
    </div>`;

  const leveledRoles = this._allRoles.filter(r => r.level > 0);
  let html = leveledRoles.map(renderRole).join('');

  const groups = this._allRoles.filter(r => r.level === 0);
  if (leveledRoles.length && groups.length) {
    html += '<div class="role-sidebar-divider"></div>';
    html += '<div class="role-sidebar-section-label">' + t('modals.role_management.groups_label') + '</div>';
  }
  html += groups.map(renderRole).join('');

  list.innerHTML = html;
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
          <input type="number" class="settings-number-input" id="cr-role-level" value="${role.level}" min="0" max="99" style="width:60px">
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
      <p class="perm-admin-note" id="cr-perm-admin-note">${role.level === 0 ? t('settings.admin.role_form.level_0_role_note') : t('settings.admin.role_form.admin_only_note')}</p>
      <div class="cr-role-perms" id="cr-role-permissions-list" style="${role.level === 0 ? 'display:none;' : ''}">
        ${allPerms.map(p => {
          const locked = !this._canControlRolePerm(p);
          const adminOnly = ADMIN_ONLY_PERMS.includes(p);
          return `
          <label class="cr-perm-toggle${adminOnly ? ' perm-admin-only' : ''}"${locked ? ` style="opacity:.55" title="${t('settings.admin.role_form.permissions_held_only')}"` : ''}>
            <input type="checkbox" class="cr-perm-cb" data-perm="${p}" ${rolePerms.includes(p) ? 'checked' : ''}${locked ? ' disabled' : ''}>
            <span>${permLabels[p] || p.replace(/_/g, ' ')}</span>
          </label>`;
        }).join('')}
      </div>
      <div class="cr-role-btns">
        <button class="btn-sm btn-accent" id="cr-save-role-btn">${t('settings.admin.roles_save')}</button>
        <button class="btn-sm danger" id="cr-delete-role-btn">${t('settings.admin.role_form.delete')}</button>
      </div>
    </div>
  `;

  // Toggle permissions visibility based on the current role level.
  this._updateRoleLevelPermsVis('cr-role-level', 'cr-role-permissions-list', 'cr-perm-admin-note');

  document.getElementById('cr-save-role-btn').addEventListener('click', () => {
    const perms = [...panel.querySelectorAll('.cr-perm-cb:checked')].map(cb => cb.dataset.perm);
    const newLevel = parseInt(document.getElementById('cr-role-level').value, 10);
    if (isNaN(newLevel) || newLevel < 0 || newLevel > 99) { this._showToast(t('settings.admin.roles_level_invalid'), 'error'); return; }
    this._roleEmit('update-role', {
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

  document.getElementById('cr-delete-role-btn').addEventListener('click', async () => {
    const ok = await this._showConfirmModal(
      t('settings.admin.roles_delete_confirm', { name: role.name }),
      '',
      { danger: true }
    );
    if (!ok) return;
    this._roleEmit('delete-role', { roleId: role.id }, (res) => {
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

  // Same hierarchy gate as the main role editor: read-only for a non-admin
  // when the role is at or above their level.
  this._applyRoleEditGate(panel, role, {
    actionButtonIds: ['cr-save-role-btn', 'cr-delete-role-btn'],
    formSelector: '.cr-role-form'
  });
},

async _createChannelRole() {
  const name = await this._showPromptModal(t('settings.admin.roles_create_title'), t('settings.admin.roles_create_hint'));
  if (!name || !name.trim()) return;
  const levelStr = await this._showPromptModal(t('settings.admin.roles_level_title'), t('settings.admin.roles_level_hint'), '25');
  if (levelStr === null) return;
  const level = parseInt(levelStr, 10);
  if (isNaN(level) || level < 0 || level > 99) { this._showToast(t('settings.admin.roles_level_invalid'), 'error'); return; }
  this._roleEmit('create-role', { name: name.trim(), level, color: '#aaaaaa' }, (res) => {
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

  // Multi-role: render every role as a checkbox. Held roles are pre-checked
  // when the chosen scope matches the role assignment's channel_id.
  const container = document.getElementById('assign-role-checkboxes');
  const renderCheckboxes = (heldRoleIds) => {
    if (!container) return;
    if (!this._allRoles.length) {
      container.innerHTML = `<p class="muted-text">${this._escapeHtml(t('settings.admin.roles_none'))}</p>`;
      return;
    }
    container.innerHTML = this._allRoles.map(r => {
      const checked = heldRoleIds.has(r.id) ? ' checked' : '';
      const dot = `<span class="role-color-dot" style="background:${this._safeColor ? this._safeColor(r.color, '#888') : (r.color || '#888')}"></span>`;
      return `
        <label class="assign-role-checkbox-row">
          <input type="checkbox" class="assign-role-checkbox" value="${r.id}"${checked}>
          ${dot}
          <span class="assign-role-checkbox-name">${this._escapeHtml(r.name)}</span>
          <span class="assign-role-checkbox-level">Lv.${r.level}</span>
        </label>
      `;
    }).join('');
  };

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

  // Fetch this user's currently-held roles so the checkbox state reflects
  // reality. We listen once (the handler removes itself) for the response.
  const buildHeldSet = (allRoles, scopeValue) => {
    const channelId = scopeValue !== 'server' ? parseInt(scopeValue, 10) : null;
    const set = new Set();
    (allRoles || []).forEach(r => {
      const sameScope = (channelId === null && (r.channel_id === null || r.channel_id === undefined))
        || (channelId !== null && r.channel_id === channelId);
      if (sameScope) set.add(r.id);
    });
    return set;
  };

  this._assignRoleHeldRoles = [];
  const onUserRoles = (payload) => {
    if (!payload || payload.userId !== userId) return;
    this.socket.off('user-roles', onUserRoles);
    this._assignRoleHeldRoles = payload.roles || [];
    renderCheckboxes(buildHeldSet(this._assignRoleHeldRoles, scopeSel.value));
  };
  this.socket.on('user-roles', onUserRoles);
  this.socket.emit('get-user-roles', { userId });

  // Re-render checkboxes whenever scope changes so the pre-checked state
  // matches the new scope. Replace the listener on each open to avoid leaks.
  const newScopeSel = scopeSel.cloneNode(true);
  scopeSel.parentNode.replaceChild(newScopeSel, scopeSel);
  newScopeSel.addEventListener('change', () => {
    renderCheckboxes(buildHeldSet(this._assignRoleHeldRoles, newScopeSel.value));
  });

  // Initial render before server reply: show no pre-checks.
  renderCheckboxes(new Set());

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
  this._racPendingChanges = {}; // key: `${userId}:${channelId||'server'}` → { assignments: { [roleId]: {level, customPerms, applyToSubs} }, removals: [roleId, ...] }

  document.getElementById('rac-user-list').innerHTML = `<p class="rac-placeholder">${t('modals.common.loading')}</p>`;
  document.getElementById('rac-channel-list').innerHTML = `<p class="rac-placeholder">${t('settings.admin.roles_select_user')}</p>`;
  document.getElementById('rac-config-body').innerHTML = `<p class="rac-placeholder">${t('settings.admin.roles_select_channel')}</p>`;
  document.getElementById('rac-save-btn').disabled = true;

  // Show admin-only buttons
  const manageBtn = document.getElementById('rac-manage-roles-btn');
  if (manageBtn) manageBtn.style.display = (this.user.isAdmin || this._hasPerm('manage_roles')) ? '' : 'none';

  this._roleEmit('get-role-assignment-data', {}, (res) => {
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

  // Get current role names per scope for this user, factoring in pending edits.
  const getRoleSummary = (channelId) => {
    const key = `${userId}:${channelId || 'server'}`;
    const heldHere = user.currentRoles.filter(r => channelId ? r.channel_id === channelId : !r.channel_id);
    const pending = this._racPendingChanges[key];
    if (!pending) return heldHere.map(r => r.name).join(', ');

    const removals = new Set(pending.removals || []);
    const assignments = pending.assignments || {};
    const finalIds = new Set();
    heldHere.forEach(r => { if (!removals.has(r.role_id)) finalIds.add(r.role_id); });
    Object.keys(assignments).forEach(rid => finalIds.add(parseInt(rid, 10)));

    const names = [];
    finalIds.forEach(rid => {
      const heldEntry = heldHere.find(r => r.role_id === rid);
      const roleObj = this._racData.roles.find(r => r.id === rid);
      const name = (heldEntry && heldEntry.name) || (roleObj && roleObj.name) || `#${rid}`;
      names.push(name);
    });
    const hasEdits = Object.keys(assignments).length > 0 || removals.size > 0;
    return names.join(', ') + (hasEdits ? ' ✎' : '');
  };

  let html = '';

  // Admin: server-wide option
  if (this._racData.callerIsAdmin) {
    const serverActive = this._racSelectedChannel === 'server' ? ' active' : '';
    const serverRole = getRoleSummary(null);
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
    // Only surface channels the target user is actually a member of.
    // Admins previously saw every channel here, which let them assign
    // channel-specific roles in scopes the user couldn't even access.
    if (!sharedIds.has(p.id)) return;
    const pActive = this._racSelectedChannel === p.id ? ' active' : '';
    const pRole = getRoleSummary(p.id);
    html += `<div class="rac-channel-item${pActive}" data-channel="${p.id}">
      <span class="rac-channel-icon">#</span>
      <span>${this._escapeHtml(p.name)}</span>
      ${pRole ? `<span class="rac-channel-current-role">${this._escapeHtml(pRole)}</span>` : ''}
    </div>`;

    const subs = subMap[p.id] || [];
    subs.forEach(s => {
      if (!sharedIds.has(s.id)) return;
      const sActive = this._racSelectedChannel === s.id ? ' active' : '';
      const sRole = getRoleSummary(s.id);
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

  // Admins (or anyone with manage_roles) get an inline picker to add this
  // user to a channel they aren't yet in, so role assignment can extend to
  // new scopes without leaving the modal.
  const canAddToChannel = this._racData.callerIsAdmin
    || (this._racData.callerPerms || []).includes('*')
    || (this._racData.callerPerms || []).includes('manage_roles');
  if (canAddToChannel) {
    const missingChannels = channels.filter(c => !sharedIds.has(c.id));
    const opts = missingChannels.map(c => {
      const parent = c.parentId ? channels.find(x => x.id === c.parentId) : null;
      const label = parent ? `${parent.name} / ${c.name}` : c.name;
      return `<option value="${c.id}">${this._escapeHtml(label)}</option>`;
    }).join('');
    html += `
      <div class="rac-add-channel-row" style="padding:8px;border-top:1px solid var(--border-color, rgba(255,255,255,0.08));margin-top:6px">
        <select id="rac-add-channel-dropdown" class="rac-role-select" style="width:100%" ${missingChannels.length ? '' : 'disabled'}>
          <option value="">${this._escapeHtml(t(missingChannels.length ? 'settings.admin.roles_add_user_channel' : 'settings.admin.roles_user_every_channel'))}</option>
          ${opts}
        </select>
      </div>`;
  }
  list.innerHTML = html;

  const addChanDropdown = document.getElementById('rac-add-channel-dropdown');
  if (addChanDropdown) {
    addChanDropdown.addEventListener('change', (e) => {
      const cid = parseInt(e.target.value, 10);
      if (!cid) return;
      this.socket.emit('invite-to-channel', { targetUserId: this._racSelectedUser, channelId: cid });
      // Optimistically extend the local map so the channel shows up
      // immediately after the round-trip.
      if (!this._racData.userChannelMap[this._racSelectedUser]) {
        this._racData.userChannelMap[this._racSelectedUser] = [];
      }
      if (!this._racData.userChannelMap[this._racSelectedUser].includes(cid)) {
        this._racData.userChannelMap[this._racSelectedUser].push(cid);
      }
      this._racSelectedChannel = cid;
      this._renderRacChannels();
      this._renderRacConfig();
    });
  }

  list.querySelectorAll('.rac-channel-item').forEach(el => {
    el.addEventListener('click', () => {
      const ch = el.dataset.channel;
      this._racSelectedChannel = ch === 'server' ? 'server' : parseInt(ch);
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
  const pending = this._racPendingChanges[key] || { assignments: {}, removals: [] };
  const removalsSet = new Set(pending.removals || []);

  // Roles the user currently holds at this scope.
  const currentRoles = user.currentRoles.filter(r =>
    channelId ? r.channel_id === channelId : !r.channel_id
  );
  const heldIds = new Set(currentRoles.map(r => r.role_id));

  // Roles the caller is permitted to grant. Held roles always stay visible
  // (so the caller can at least see them) even if they're above the cap.
  const grantableRoles = this._racData.roles.filter(r =>
    this._racData.callerIsAdmin || r.level < this._racData.callerLevel
  );
  const grantableIds = new Set(grantableRoles.map(r => r.id));

  const callerPerms = this._racData.callerPerms || [];
  const callerIsAdmin = this._racData.callerIsAdmin;
  const allPerms = ALL_PERMS;
  const adminOnlyPerms = ADMIN_ONLY_PERMS;
  const permLabels = PERM_LABELS;
  const maxLevel = callerIsAdmin ? 99 : (this._racData.callerLevel - 1);
  const isParentChannel = channelId && this._racData.channels.some(c => c.parentId === channelId);

  // Build the unified role list for this scope: every held role + every
  // pending assignment that isn't already held. Order: highest level first.
  const seenRoleIds = new Set();
  const cards = [];
  currentRoles.forEach(r => {
    seenRoleIds.add(r.role_id);
    const roleObj = this._racData.roles.find(x => x.id === r.role_id) || {};
    // Prefer server-computed effective perms (role defaults +/- per-user
    // overrides for this scope) so the editor reflects what the user
    // actually has, not just the role's defaults.
    const heldPerms = Array.isArray(r.effectivePerms)
      ? r.effectivePerms
      : (roleObj.permissions || []);
    cards.push({
      roleId: r.role_id,
      name: r.name || roleObj.name || `#${r.role_id}`,
      color: r.color || roleObj.color || '#888',
      defaultLevel: roleObj.level || r.level,
      defaultPerms: heldPerms,
      heldLevel: r.level,
      held: true
    });
  });
  Object.keys(pending.assignments || {}).forEach(rid => {
    const id = parseInt(rid, 10);
    if (seenRoleIds.has(id)) return;
    seenRoleIds.add(id);
    const roleObj = this._racData.roles.find(x => x.id === id);
    if (!roleObj) return;
    cards.push({
      roleId: id, name: roleObj.name, color: roleObj.color,
      defaultLevel: roleObj.level, defaultPerms: roleObj.permissions || [],
      heldLevel: null, held: false
    });
  });
  cards.sort((a, b) => (b.defaultLevel || 0) - (a.defaultLevel || 0));

  // Determine the "stays held" set so the channel-summary preview is correct.
  const finalHeld = new Set();
  cards.forEach(c => {
    const isAssigned = pending.assignments && pending.assignments[c.roleId];
    const isRemoved = removalsSet.has(c.roleId);
    if (isAssigned) finalHeld.add(c.roleId);
    else if (c.held && !isRemoved) finalHeld.add(c.roleId);
  });

  // Roles available to add: grantable, not already in cards.
  const addableRoles = grantableRoles.filter(r => !seenRoleIds.has(r.id));

  // Inherited roles: server-wide and parent-channel roles visible as
  // read-only context when the admin is viewing a channel scope.
  const inheritedRoles = [];
  if (channelId !== null) {
    const serverWide = user.currentRoles.filter(r => !r.channel_id);
    serverWide.forEach(r => inheritedRoles.push({ ...r, _inheritedFrom: t('settings.admin.roles_server_wide') }));

    const thisChannel = this._racData.channels.find(c => c.id === channelId);
    if (thisChannel && thisChannel.parentId) {
      const parentRoles = user.currentRoles.filter(r => r.channel_id === thisChannel.parentId);
      const parentName = this._racData.channels.find(c => c.id === thisChannel.parentId)?.name || `#${thisChannel.parentId}`;
      parentRoles.forEach(r => inheritedRoles.push({ ...r, _inheritedFrom: `#${this._escapeHtml(parentName)}` }));
    }
  }

  // Header
  const userColor = this._getUserColor(user.username);
  const scopeLabel = channelId
    ? (this._racData.channels.find(c => c.id === channelId)?.name || `#${channelId}`)
    : t('settings.admin.roles_server_wide');

  const renderCard = (card) => {
    const assignment = pending.assignments && pending.assignments[card.roleId];
    const removed = removalsSet.has(card.roleId);
    const dirty = !!assignment || removed;

    // Effective edit state shown in the form:
    const effectiveLevel = assignment && assignment.level !== undefined
      ? assignment.level
      : (card.held ? card.heldLevel : card.defaultLevel);
    const effectivePerms = assignment && assignment.customPerms
      ? assignment.customPerms
      : [...(card.defaultPerms || [])];
    const expanded = !!assignment;
    const applyToSubs = !!(assignment && assignment.applyToSubs);

    let stateBadge = '';
    if (removed) stateBadge = `<span class="rac-state-badge rac-state-removed">${this._escapeHtml(t('settings.admin.roles_pending_remove'))}</span>`;
    else if (assignment && !card.held) stateBadge = `<span class="rac-state-badge rac-state-added">${this._escapeHtml(t('settings.admin.roles_pending_add'))}</span>`;
    else if (assignment && card.held) stateBadge = `<span class="rac-state-badge rac-state-edited">${this._escapeHtml(t('settings.admin.roles_pending_edit'))}</span>`;
    else if (card.held) stateBadge = `<span class="rac-state-badge rac-state-held">${this._escapeHtml(t('settings.admin.roles_held'))}</span>`;

    let actionBtn = '';
    if (removed) {
      actionBtn = `<button type="button" class="btn-sm rac-card-undo-remove" data-role="${card.roleId}">${this._escapeHtml(t('settings.admin.roles_undo'))}</button>`;
    } else if (card.held) {
      actionBtn = `<button type="button" class="btn-sm rac-card-remove" data-role="${card.roleId}">${this._escapeHtml(t('settings.admin.roles_remove'))}</button>`;
    } else {
      actionBtn = `<button type="button" class="btn-sm rac-card-discard" data-role="${card.roleId}">${this._escapeHtml(t('settings.admin.roles_discard'))}</button>`;
    }

    let editToggle = '';
    if (!removed) {
      editToggle = `<button type="button" class="btn-sm rac-card-edit" data-role="${card.roleId}">${this._escapeHtml(t(expanded ? 'settings.admin.roles_collapse' : 'settings.admin.roles_configure'))}</button>`;
    }

    const editorHtml = expanded ? `
      <div class="rac-card-editor" data-role="${card.roleId}">
        ${isParentChannel ? `
          <label class="rac-perm-item" style="padding:6px 0;">
            <input type="checkbox" class="rac-card-applysubs" data-role="${card.roleId}"${applyToSubs ? ' checked' : ''}>
            <strong>${this._escapeHtml(t('settings.admin.roles_apply_to_subs'))}</strong>
          </label>
        ` : ''}
        <div class="rac-config-label">${this._escapeHtml(t('settings.admin.roles_level_label'))} <span style="font-weight:400;text-transform:none;letter-spacing:0">${this._escapeHtml(t('settings.admin.roles_level_max_hint', { maxLevel }))}</span></div>
        <div class="rac-config-row">
          <input type="number" class="rac-card-level" data-role="${card.roleId}" min="1" max="${maxLevel}" value="${effectiveLevel}" style="width:80px">
          <span class="rac-level-hint" style="font-size:0.75rem;color:var(--text-muted)">${this._escapeHtml(t('settings.admin.roles_preset_default', { level: card.defaultLevel }))}</span>
        </div>
        <div class="rac-config-label">${this._escapeHtml(t('settings.admin.roles_perms_label'))}</div>
        <div class="rac-perms-grid rac-card-perms" data-role="${card.roleId}">
          ${allPerms.map(p => {
            const checked = effectivePerms.includes(p);
            const callerHasPerm = callerIsAdmin || callerPerms.includes('*') || callerPerms.includes(p);
            const isAdminOnly = adminOnlyPerms.includes(p) && !callerIsAdmin;
            const isReadOnly = isAdminOnly || !callerHasPerm;
            const tooltip = isReadOnly
              ? t(isAdminOnly ? 'settings.admin.roles_owner_only' : 'settings.admin.roles_permission_unavailable')
              : '';
            return `<label class="rac-perm-item${isReadOnly ? ' disabled' : ''}${checked ? ' checked' : ''}"${tooltip ? ` title="${tooltip}"` : ''}>
              <input type="checkbox" data-perm="${p}" ${checked ? 'checked' : ''} ${isReadOnly ? 'disabled' : ''}>
              ${permLabels[p] || p}
            </label>`;
          }).join('')}
        </div>
      </div>
    ` : '';

    const lockedNotice = !card.held && !grantableIds.has(card.roleId)
      ? `<span class="rac-card-locked" title="${this._escapeHtml(t('settings.admin.roles_cannot_grant_level'))}">🔒</span>`
      : '';

    return `
      <div class="rac-role-card${dirty ? ' rac-card-dirty' : ''}${removed ? ' rac-card-removed' : ''}" data-role="${card.roleId}">
        <div class="rac-card-head">
          <span class="rac-role-dot" style="background:${this._safeColor(card.color, '#888')}"></span>
          <span class="rac-card-name">${this._escapeHtml(card.name)}</span>
          <span class="rac-card-level">Lv.${effectiveLevel}</span>
          ${stateBadge}
          ${lockedNotice}
          <span style="flex:1"></span>
          ${editToggle}
          ${actionBtn}
        </div>
        ${editorHtml}
      </div>
    `;
  };

  body.innerHTML = `
    <div class="rac-config-section">
      <div class="rac-config-label">${this._escapeHtml(t('settings.admin.roles_assigning_to', { name: user.displayName }))} — ${this._escapeHtml(scopeLabel)}</div>
      <p class="rac-card-hint">${this._escapeHtml(t('settings.admin.roles_multi_hint'))}</p>
    </div>

    <div class="rac-config-section rac-roles-list">
      ${cards.length ? cards.map(renderCard).join('') : `<p class="rac-placeholder">${this._escapeHtml(t('settings.admin.roles_no_assigned'))}</p>`}
    </div>

    ${inheritedRoles.length ? `
    <div class="rac-config-section rac-inherited-section">
      <div class="rac-config-label" style="opacity:0.7;margin-top:4px">${this._escapeHtml(t('settings.admin.roles_inherited_label'))}</div>
      ${inheritedRoles.map(r => {
        const color = this._safeColor(r.color, '#888');
        return `<div class="rac-role-card rac-role-inherited">
          <div class="rac-card-head">
            <span class="rac-role-dot" style="background:${color}"></span>
            <span class="rac-card-name" style="opacity:0.8">${this._escapeHtml(r.name)}</span>
            <span class="rac-card-level">Lv.${r.level}</span>
            <span class="rac-card-locked" title="${this._escapeHtml(t('settings.admin.roles_inherited_title', { role: r._inheritedFrom }))}">↑ ${this._escapeHtml(r._inheritedFrom)}</span>
          </div>
        </div>`;
      }).join('')}
    </div>
    ` : ''}

    <div class="rac-config-section rac-add-role-section">
      <div class="rac-config-label">${this._escapeHtml(t('settings.admin.roles_add_label'))}</div>
      <div class="rac-config-row">
        <select class="rac-role-select" id="rac-add-role-dropdown" ${addableRoles.length ? '' : 'disabled'}>
          <option value="">${this._escapeHtml(t(addableRoles.length ? 'settings.admin.roles_select_to_add' : 'settings.admin.roles_no_addable'))}</option>
          ${addableRoles.map(r => `<option value="${r.id}">● ${this._escapeHtml(r.name)} — Lv.${r.level}</option>`).join('')}
        </select>
      </div>
    </div>
  `;

  // ── Wire up events ────────────────────────────────────
  const refreshSaveBtn = () => {
    const hasChanges = Object.values(this._racPendingChanges).some(p =>
      (p.assignments && Object.keys(p.assignments).length) ||
      (p.removals && p.removals.length)
    );
    document.getElementById('rac-save-btn').disabled = !hasChanges;
  };

  const ensurePending = () => {
    if (!this._racPendingChanges[key]) this._racPendingChanges[key] = { assignments: {}, removals: [] };
    return this._racPendingChanges[key];
  };

  const cleanupPendingIfEmpty = () => {
    const p = this._racPendingChanges[key];
    if (!p) return;
    const empty = (!p.assignments || Object.keys(p.assignments).length === 0) &&
                  (!p.removals || p.removals.length === 0);
    if (empty) delete this._racPendingChanges[key];
  };

  // Add-role dropdown
  const addDropdown = document.getElementById('rac-add-role-dropdown');
  if (addDropdown) {
    addDropdown.addEventListener('change', (e) => {
      const rid = parseInt(e.target.value, 10);
      if (!rid) return;
      const roleObj = this._racData.roles.find(r => r.id === rid);
      if (!roleObj) return;
      const p = ensurePending();
      p.assignments[rid] = {
        level: roleObj.level,
        customPerms: [...(roleObj.permissions || [])],
        applyToSubs: false
      };
      refreshSaveBtn();
      this._renderRacChannels();
      this._renderRacConfig();
    });
  }

  // Per-card buttons
  body.querySelectorAll('.rac-card-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      const rid = parseInt(btn.dataset.role, 10);
      const p = ensurePending();
      // If there was a pending edit (assignment) for a held role, drop it.
      if (p.assignments && p.assignments[rid]) delete p.assignments[rid];
      if (!p.removals.includes(rid)) p.removals.push(rid);
      cleanupPendingIfEmpty();
      refreshSaveBtn();
      this._renderRacChannels();
      this._renderRacConfig();
    });
  });

  body.querySelectorAll('.rac-card-undo-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      const rid = parseInt(btn.dataset.role, 10);
      const p = this._racPendingChanges[key];
      if (!p) return;
      p.removals = (p.removals || []).filter(id => id !== rid);
      cleanupPendingIfEmpty();
      refreshSaveBtn();
      this._renderRacChannels();
      this._renderRacConfig();
    });
  });

  body.querySelectorAll('.rac-card-discard').forEach(btn => {
    btn.addEventListener('click', () => {
      const rid = parseInt(btn.dataset.role, 10);
      const p = this._racPendingChanges[key];
      if (!p || !p.assignments) return;
      delete p.assignments[rid];
      cleanupPendingIfEmpty();
      refreshSaveBtn();
      this._renderRacChannels();
      this._renderRacConfig();
    });
  });

  body.querySelectorAll('.rac-card-edit').forEach(btn => {
    btn.addEventListener('click', () => {
      const rid = parseInt(btn.dataset.role, 10);
      const p = ensurePending();
      const card = cards.find(c => c.roleId === rid);
      if (!card) return;
      if (p.assignments && p.assignments[rid]) {
        // Already expanded — collapse by removing the assignment IF nothing
        // was changed from the held state. Otherwise keep it.
        const a = p.assignments[rid];
        const unchanged = card.held
          && a.level === card.heldLevel
          && JSON.stringify((a.customPerms || []).slice().sort()) === JSON.stringify((card.defaultPerms || []).slice().sort())
          && !a.applyToSubs;
        if (unchanged) delete p.assignments[rid];
      } else {
        // Expand: seed an assignment from the current held values (or preset).
        p.assignments[rid] = {
          level: card.held ? card.heldLevel : card.defaultLevel,
          customPerms: [...(card.defaultPerms || [])],
          applyToSubs: false
        };
      }
      cleanupPendingIfEmpty();
      refreshSaveBtn();
      this._renderRacChannels();
      this._renderRacConfig();
    });
  });

  // Per-card editor controls
  body.querySelectorAll('.rac-card-level').forEach(input => {
    input.addEventListener('change', () => {
      const rid = parseInt(input.dataset.role, 10);
      let val = parseInt(input.value, 10);
      if (isNaN(val) || val < 1) val = 1;
      if (val > maxLevel) val = maxLevel;
      input.value = val;
      const p = ensurePending();
      if (!p.assignments[rid]) p.assignments[rid] = { level: val, customPerms: [], applyToSubs: false };
      else p.assignments[rid].level = val;
      refreshSaveBtn();
      this._renderRacChannels();
    });
  });

  body.querySelectorAll('.rac-card-applysubs').forEach(cb => {
    cb.addEventListener('change', () => {
      const rid = parseInt(cb.dataset.role, 10);
      const p = ensurePending();
      if (!p.assignments[rid]) return;
      p.assignments[rid].applyToSubs = cb.checked;
      refreshSaveBtn();
    });
  });

  body.querySelectorAll('.rac-card-perms input[type="checkbox"]:not([disabled])').forEach(cb => {
    cb.addEventListener('change', () => {
      const grid = cb.closest('.rac-card-perms');
      const rid = parseInt(grid.dataset.role, 10);
      const perm = cb.dataset.perm;
      const p = ensurePending();
      if (!p.assignments[rid]) {
        const card = cards.find(c => c.roleId === rid);
        p.assignments[rid] = {
          level: card ? (card.held ? card.heldLevel : card.defaultLevel) : 1,
          customPerms: card ? [...(card.defaultPerms || [])] : [],
          applyToSubs: false
        };
      }
      const a = p.assignments[rid];
      if (cb.checked) {
        if (!a.customPerms.includes(perm)) a.customPerms.push(perm);
      } else {
        a.customPerms = a.customPerms.filter(x => x !== perm);
      }
      cb.closest('.rac-perm-item').classList.toggle('checked', cb.checked);
      refreshSaveBtn();
      this._renderRacChannels();
    });
  });
},

_racSaveChanges() {
  const scopeKeys = Object.keys(this._racPendingChanges);
  if (scopeKeys.length === 0) return;

  // Flatten all pending changes into a list of socket calls. Each entry is
  // either { kind:'assign', userId, channelId, roleId, level, customPerms }
  // or { kind:'revoke', userId, channelId, roleId }.
  const ops = [];
  for (const key of scopeKeys) {
    const p = this._racPendingChanges[key];
    const [userIdStr, scope] = key.split(':');
    const userId = parseInt(userIdStr, 10);
    const channelId = scope === 'server' ? null : parseInt(scope, 10);

    (p.removals || []).forEach(roleId => {
      ops.push({ kind: 'revoke', userId, channelId, roleId });
    });
    Object.entries(p.assignments || {}).forEach(([rid, a]) => {
      const roleId = parseInt(rid, 10);
      ops.push({ kind: 'assign', userId, channelId, roleId, level: a.level, customPerms: a.customPerms || null });
      // Expand applyToSubs into per-sub-channel assigns.
      if (a.applyToSubs && channelId && this._racData) {
        const subs = this._racData.channels.filter(c => c.parentId === channelId);
        for (const sub of subs) {
          ops.push({ kind: 'assign', userId, channelId: sub.id, roleId, level: a.level, customPerms: a.customPerms || null });
        }
      }
    });
  }

  if (ops.length === 0) return;

  let completed = 0;
  const errors = [];
  const total = ops.length;

  const onDone = () => {
    if (errors.length) {
      this._showToast(t('settings.admin.roles_save_errors', { count: errors.length, error: errors[0] }), 'error');
    } else {
      this._showToast(t(total === 1 ? 'settings.admin.roles_changes_saved_one' : 'settings.admin.roles_changes_saved_other', { count: total }), 'success');
      document.getElementById('role-assign-center-modal').style.display = 'none';
    }
    this._racPendingChanges = {};
    document.getElementById('rac-save-btn').disabled = true;
    this._roleEmit('get-role-assignment-data', {}, (res) => {
      if (!res.error) {
        this._racData = res;
        this._renderRacUsers(document.getElementById('rac-user-search')?.value || '');
        this._renderRacChannels();
        this._renderRacConfig();
      }
    });
  };

  ops.forEach(op => {
    if (op.kind === 'revoke') {
      this._roleEmit('revoke-role', { userId: op.userId, roleId: op.roleId, channelId: op.channelId }, (res) => {
        completed++;
        if (res && res.error) errors.push(res.error);
        if (completed === total) onDone();
      });
    } else {
      this._roleEmit('assign-role', {
        userId: op.userId, roleId: op.roleId, channelId: op.channelId,
        customLevel: op.level, customPerms: op.customPerms
      }, (res) => {
        completed++;
        if (res && res.error) errors.push(res.error);
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
    // _openRoleModal shows the modal first, then loads — ensures the sidebar
    // re-renders once roles arrive (fixes #5xxx: blank role list when opened from RAC).
    this._openRoleModal();
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
      return d.toLocaleString();
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
      banAt: num('automod-ban-at', 5)
    }));
  };
  ['automod-window-hours', 'automod-warn-at', 'automod-mute-at', 'automod-mute-minutes', 'automod-ban-at']
    .forEach(id => on(id, 'change', pushEscalation));

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
  num('automod-exempt-level', 'automod_link_exempt_level', '50');
  const logCh = document.getElementById('automod-log-channel');
  if (logCh) logCh.value = s.automod_log_channel || '';

  try {
    const c = JSON.parse(s.automod_escalation || '{}');
    const put = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
    put('automod-window-hours', c.windowHours ?? 24);
    put('automod-warn-at', c.warnAt ?? 1);
    put('automod-mute-at', c.muteAt ?? 3);
    put('automod-mute-minutes', c.muteMinutes ?? 60);
    put('automod-ban-at', c.banAt ?? 5);
  } catch { /* malformed JSON — leave the fields alone */ }

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
        ${r.note ? `<span class="muted-text"> — ${this._escapeHtml(r.note)}</span>` : ''}
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

// ═══════════════════════════════════════════════════════
};
