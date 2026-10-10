// Server Admin settings: the first-time setup wizard, sign-in (OIDC) options,
// and filling in, saving and cancelling the admin settings.

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
    const cleanupUploads = document.getElementById('cleanup-max-uploads');
    if (cleanupUploads) cleanupUploads.value = this.serverSettings.cleanup_max_uploads_mb || '0';
    const deletedRet = document.getElementById('deleted-retention-days');
    if (deletedRet) deletedRet.value = this.serverSettings.deleted_retention_days || '7';
    const keepSd = document.getElementById('keep-self-destructed');
    if (keepSd) keepSd.checked = this.serverSettings.keep_self_destructed_attachments !== 'false';
    const maxUpload = document.getElementById('max-upload-mb');
    if (maxUpload) {
      maxUpload.value = this.serverSettings.max_upload_mb || '25';
    }
    const maxAttach = document.getElementById('max-attachments');
    if (maxAttach) {
      maxAttach.value = this.serverSettings.max_attachments || '10';
    }
    const maxTagsPer = document.getElementById('max-tags-per-attachment');
    if (maxTagsPer) {
      maxTagsPer.value = this.serverSettings.max_tags_per_attachment || '3';
    }
    const maxTagLen = document.getElementById('max-tag-len');
    if (maxTagLen) {
      maxTagLen.value = this.serverSettings.max_tag_len || '20';
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
    const autoAwayVisible = document.getElementById('auto-away-visible-minutes');
    if (autoAwayVisible) autoAwayVisible.value = this.serverSettings.auto_away_visible_minutes || '5';
    const autoAwayHidden = document.getElementById('auto-away-hidden-minutes');
    if (autoAwayHidden) autoAwayHidden.value = this.serverSettings.auto_away_hidden_minutes || '2';
    const autoAwayEnabled = document.getElementById('auto-away-enabled');
    if (autoAwayEnabled) autoAwayEnabled.checked = this.serverSettings.auto_away_enabled !== 'false';
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
    const iceDisabled = document.getElementById('voice-ice-disabled');
    if (iceDisabled) iceDisabled.checked = this.serverSettings.voice_ice_disabled === 'true';
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
    // The backup list is admin only; asking for it as anyone else only logs a 403.
    if (this.user?.isAdmin && typeof this._refreshAutoBackupList === 'function') this._refreshAutoBackupList();

    const updateBannerAdminOnly = document.getElementById('update-banner-admin-only');
    if (updateBannerAdminOnly) {
      updateBannerAdminOnly.checked = this.serverSettings.update_banner_admin_only === 'true';
    }
    const allowSelfPurge = document.getElementById('allow-self-purge');
    if (allowSelfPurge) allowSelfPurge.checked = this.serverSettings.allow_self_purge === 'true';
    // The member-facing button follows the switch (#5686).
    const selfPurgeBlock = document.getElementById('self-purge-block');
    if (selfPurgeBlock) selfPurgeBlock.style.display = (this.serverSettings.allow_self_purge === 'true' && !this.user?.isGuest) ? '' : 'none';
    const hideDisabledBadges = document.getElementById('hide-disabled-badges');
    if (hideDisabledBadges) hideDisabledBadges.checked = this.serverSettings.hide_disabled_channel_badges === 'true';
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
    serverCodeEl.textContent = code || '-';
    serverCodeEl.style.opacity = code ? '1' : '0.4';
  }

  // (#5344) Registration token — same live-update pattern as server code
  const tokenEl = document.getElementById('registration-token-value');
  if (tokenEl) {
    const tok = this.serverSettings.registration_token;
    tokenEl.textContent = tok || '-';
    tokenEl.style.opacity = tok ? '1' : '0.4';
  }
  const tokenToggle = document.getElementById('registration-token-enabled');
  if (tokenToggle) tokenToggle.checked = this.serverSettings.registration_token_enabled === 'true';
  const invBpsTokenToggle = document.getElementById('invites-bypass-registration-token');
  if (invBpsTokenToggle) invBpsTokenToggle.checked = this.serverSettings.invites_bypass_registration_token === 'true';

  // These save with the Save button, so leave them alone while the panel is
  // open: the token switches above save at once, and the refresh that follows
  // used to put back the stored values over whatever was being typed here.
  if (!modalOpen) {
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
  }
  

  // (#5345) Default join channels — re-render when settings or channel list refresh
  if (typeof this._renderDefaultJoinChannels === 'function') {
    try { this._renderDefaultJoinChannels(); } catch (err) { console.warn('[Admin] _renderDefaultJoinChannels failed', err); }
  }

  // (#5381) Guest channel whitelist — re-render when settings change
  if (typeof this._renderGuestChannels === 'function') {
    try { this._renderGuestChannels(); } catch (err) { console.warn('[Admin] _renderGuestChannels failed', err); }
  }

  // Managed invite links — paint the create-form channel list and pull the
  // current set of codes from the server (list arrives via 'invite-codes-list').
  if (typeof this._renderInviteCreateChannels === 'function') {
    try { this._renderInviteCreateChannels(); } catch (err) { console.warn('[Admin] _renderInviteCreateChannels failed', err); }
  }
  if (this.socket?.connected) {
    try { this.socket.emit('get-invite-codes'); } catch (err) { console.warn('[Admin] could not request invite codes', err); }
  }

  // Apply configurable message length limit to message input and edit textareas
  const _maxMsgChars = parseInt(this.serverSettings?.max_message_chars) || 2000;
  const msgInput = document.getElementById('message-input');
  if (msgInput) msgInput.maxLength = _maxMsgChars;
  // The thread and pop-out DM boxes had no cap, so a long reply was only
  // refused after sending (#5691).
  for (const id of ['thread-input', 'dm-pip-input']) {
    const el = document.getElementById(id);
    if (el) el.maxLength = _maxMsgChars;
  }
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
  const bannerNavItem = document.querySelector('.settings-nav-item[data-target="section-banner-display"]');
  if (bannerNavItem) bannerNavItem.style.display = hasBanner ? '' : 'none';
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
    const statusDot = `<span class="webhook-status-icon" aria-hidden="true">${wh.is_active ? '🟢' : '🔴'}</span>`;
    const avatarHtml = wh.avatar_url
      ? `<img src="${this._escapeHtml(wh.avatar_url)}" style="width:20px;height:20px;border-radius:50%;object-fit:cover">`
      : '<span class="webhook-avatar-icon" aria-hidden="true">🤖</span>';
    return `<div class="role-preview-item">${avatarHtml} <span style="font-weight:600">${this._escapeHtml(wh.name)}</span> <span style="opacity:0.5;font-size:0.6875rem">#${this._escapeHtml(wh.channel_name)}</span> ${statusDot}</div>`;
  }).join('');
},

_syncSettingsNav() {
  // Dict of admin settings sections and the roles that can access them.
  // (Admin has access to all)
  //
  // Dict key: The section id to grant access to
  // Key value: A list of roles that can access the section, or a dictionary
  // of roles listing the sub-sections they can access. ('*' for all subsection access)
  const settingsSectionsAccess = {
    'section-update':       [],
    'section-extension-updates': [],
    'section-branding':     ['manage_server'],
    'section-presence':     [],
    'section-members':      ['manage_server'],
    // Idle-online oversight (v3.46.0): moderators who can act on it see it too,
    // the same bar the server enforces. Keep this list in step with
    // _hasAnyAdminSettingsAccess in app.js, which gates the Admin tab switch.
    'section-moderation':   ['view_audit_log', 'ban_user', 'kick_user', 'view_all_members'],
    'section-security':     [],
    'section-automod':      [],
    'section-whitelist':    ['manage_server'],
    'section-invite':       {'manage_server': '*', 'invite_users': ['invite-links-block']}, // invite_users only have access to the id="invite-links-block" section within id="section-invite"
    'section-guests':       [],
    'section-cleanup':      ['manage_server'],
    'section-backup':       ['manage_server'],
    'section-template':     [],
    'section-uploads':      ['manage_server'],
    'section-tags-admin':   ['manage_tags'],
    'section-connectivity': [],
    'section-large-server': [],   // admin only: the relay opens ports on the host
    'section-tunnel':       ['manage_server'],
    'section-bots':         ['manage_server', 'manage_webhooks'],
    'section-ferry':        [],
    'section-custom-tos':   [],
    'section-import':       ['manage_server'],
    'section-modmode':      ['manage_server'],
    'section-emojis':       ['manage_emojis'],
    'section-stickers':     ['manage_stickers'],
    'section-sounds-admin': ['manage_soundboard'],
    'section-roles':        ['manage_roles'],
    'section-audit-log':    ['view_audit_log']
  };
  
  // Use the canonical authoritative flag from the server, not DOM visibility.
  const isAdmin = !!(this.user && this.user.isAdmin);

  //Returns the actual access level for a settings section:
  //   '*'              = full access
  //   ['some-block']   = limited access to specific subsections
  //   null             = no access
  const getSectionAccess = (target) => {
    const access = settingsSectionsAccess[target];

    if (isAdmin) return '*';
    if (!access) return null;

    // Simple permission list: any matching permission grants full access.
    if (Array.isArray(access)) {
      return access.some(permission => this._hasPerm(permission)) ? '*' : null;
    }
    // Permission -> subsection access map.
    const allowedSubSections = new Set();
    for (const [permission, subSections] of Object.entries(access)) {
      if (!this._hasPerm(permission)) continue;

      // Any full-access permission wins, regardless of object order.
      if (subSections === '*') return '*';

      for (const subSection of subSections) {
        allowedSubSections.add(subSection);
      }
    }
    return allowedSubSections.size > 0 ? [...allowedSubSections] : null;
  };

  const canAccessSection = (target) => {
    return getSectionAccess(target) !== null;
  };

  // Determine whether the user has access to any admin settings.
  const hasAnyAdminAccess = isAdmin || Object.keys(settingsSectionsAccess).some(target => canAccessSection(target));

  // Admin settings navigation.
  // Unknown nav targets are hidden for non-admins.
  document.querySelectorAll('.settings-nav-item.settings-nav-admin').forEach(navItem => {
    if (isAdmin) {
      navItem.style.display = '';
      return;
    }
    navItem.style.display = canAccessSection(navItem.dataset.target) ? '' : 'none';
  });

  // Admin settings navigation group labels.
  document.querySelectorAll('.settings-nav-group-label.settings-nav-admin').forEach(label => {
    if (isAdmin) {
      label.style.display = '';
      return;
    }

    let hasVisibleItem = false;
    let sibling = label.nextElementSibling;
    while (sibling && !sibling.classList.contains('settings-nav-group-label')) {
      if (sibling.classList.contains('settings-nav-item') && sibling.classList.contains('settings-nav-admin') && sibling.style.display !== 'none') {
        hasVisibleItem = true;
        break;
      }
      sibling = sibling.nextElementSibling;
    }
    label.style.display = hasVisibleItem ? '' : 'none';
  });

  document.querySelectorAll('.settings-nav-admin-group').forEach(group => {
    group.style.display = hasAnyAdminAccess ? '' : 'none';
  });

  // Admin settings sections.
  // Every section must be explicitly represented in settingsSectionsAccess.
  // This prevents an unlisted admin section from becoming visible to
  // non-admin users simply because its nav item was hidden.
  document.querySelectorAll('#admin-mod-panel .admin-settings').forEach(section => {
    const access = getSectionAccess(section.id);
    section.style.display = (access === null) ? 'none' : '';
  });

  // Apply subsection restrictions.
  // Sections using object-form access can restrict access to specific
  // direct-child subsections.
  Object.entries(settingsSectionsAccess).forEach(([sectionId, access]) => {
    if (isAdmin || !access || Array.isArray(access)) return;

    const section = document.getElementById(sectionId);
    if (!section) return;

    const sectionAccess = getSectionAccess(sectionId);
    if (sectionAccess === null || sectionAccess === '*') return;

    section.querySelectorAll(':scope > *').forEach(subSection => {
      subSection.style.display = sectionAccess.includes(subSection.id) ? '' : 'none';
    });
  });
  // With the server-config blocks above it hidden, the invite-links divider has
  // nothing to divide. (#5470)
  document.getElementById('invite-links-block')
    ?.classList.toggle('invite-links-flush', Array.isArray(getSectionAccess('section-invite')));

  const adminTab = document.querySelector('.settings-tab-admin');
  if (adminTab) {
    adminTab.style.display = hasAnyAdminAccess ? '' : 'none';
  }
  const adminPanel = document.getElementById('settings-body-admin');
  if (adminPanel) {
    adminPanel.style.display = hasAnyAdminAccess ? '' : 'none';
  }
  const saveBar = document.querySelector('.admin-save-bar');
  if (saveBar) {
    const adminTabActive = adminTab?.classList.contains('active');
    saveBar.style.display = (hasAnyAdminAccess && adminTabActive) ? '' : 'none';
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
    cleanup_max_uploads_mb: this.serverSettings.cleanup_max_uploads_mb || '0',
    deleted_retention_days: this.serverSettings.deleted_retention_days || '7',
    keep_self_destructed_attachments: this.serverSettings.keep_self_destructed_attachments || 'true',
    whitelist_enabled: this.serverSettings.whitelist_enabled || 'false',
    max_upload_mb: this.serverSettings.max_upload_mb || '25',
    max_attachments: this.serverSettings.max_attachments || '10',
    max_tags_per_attachment: this.serverSettings.max_tags_per_attachment || '3',
    max_tag_len: this.serverSettings.max_tag_len || '20',
    max_sound_kb: this.serverSettings.max_sound_kb || '1024',
    max_emoji_kb: this.serverSettings.max_emoji_kb || '256',
    max_sticker_kb: this.serverSettings.max_sticker_kb || '1024',
    max_poll_options: this.serverSettings.max_poll_options || '10',
    session_duration_days: this.serverSettings.session_duration_days || '7',
    max_message_chars: this.serverSettings.max_message_chars || '2000',
    auto_away_visible_minutes: this.serverSettings.auto_away_visible_minutes || '5',
    auto_away_hidden_minutes: this.serverSettings.auto_away_hidden_minutes || '2',
    auto_away_enabled: this.serverSettings.auto_away_enabled || 'true',
    update_banner_admin_only: this.serverSettings.update_banner_admin_only || 'false',
    allow_self_purge: this.serverSettings.allow_self_purge || 'false',
    hide_disabled_channel_badges: this.serverSettings.hide_disabled_channel_badges || 'false',
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
    voice_ice_disabled: this.serverSettings.voice_ice_disabled || 'false',
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
  this._renderLargeServerSection?.();
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
  const cleanUploads = String(Math.max(0, Math.min(10000000, parseInt(document.getElementById('cleanup-max-uploads')?.value) || 0)));
  if (cleanUploads !== (snap.cleanup_max_uploads_mb || '0')) {
    this.socket.emit('update-server-setting', { key: 'cleanup_max_uploads_mb', value: cleanUploads });
  }
  if (cleanSize !== (snap.cleanup_max_size_mb || '0')) {
    this.socket.emit('update-server-setting', { key: 'cleanup_max_size_mb', value: cleanSize });
    changed = true;
  }

  const deletedRet = String(Math.max(1, Math.min(3650, parseInt(document.getElementById('deleted-retention-days')?.value) || 7)));
  if (deletedRet !== (snap.deleted_retention_days || '7')) {
    this.socket.emit('update-server-setting', { key: 'deleted_retention_days', value: deletedRet });
    changed = true;
  }

  const keepSd = document.getElementById('keep-self-destructed')?.checked ? 'true' : 'false';
  if (keepSd !== snap.keep_self_destructed_attachments) {
    this.socket.emit('update-server-setting', { key: 'keep_self_destructed_attachments', value: keepSd });
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

  const maxAttach = String(Math.max(1, Math.min(50, parseInt(document.getElementById('max-attachments')?.value) || 10)));
  if (maxAttach !== (snap.max_attachments || '10')) {
    this.socket.emit('update-server-setting', { key: 'max_attachments', value: maxAttach });
    changed = true;
  }

  const maxTagsPer = String(Math.max(1, Math.min(10, parseInt(document.getElementById('max-tags-per-attachment')?.value) || 3)));
  if (maxTagsPer !== (snap.max_tags_per_attachment || '3')) {
    this.socket.emit('update-server-setting', { key: 'max_tags_per_attachment', value: maxTagsPer });
    changed = true;
  }

  const maxTagLen = String(Math.max(1, Math.min(50, parseInt(document.getElementById('max-tag-len')?.value) || 20)));
  if (maxTagLen !== (snap.max_tag_len || '20')) {
    this.socket.emit('update-server-setting', { key: 'max_tag_len', value: maxTagLen });
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

  for (const [key, id, fallback] of [
    ['auto_away_visible_minutes', 'auto-away-visible-minutes', '5'],
    ['auto_away_hidden_minutes', 'auto-away-hidden-minutes', '2']
  ]) {
    const value = String(Math.max(1, Math.min(60, parseInt(document.getElementById(id)?.value, 10) || Number(fallback))));
    if (value !== (snap[key] || fallback)) {
      this.socket.emit('update-server-setting', { key, value });
      changed = true;
    }
  }
  const autoAwayEnabled = document.getElementById('auto-away-enabled')?.checked ? 'true' : 'false';
  if (autoAwayEnabled !== (snap.auto_away_enabled || 'true')) {
    this.socket.emit('update-server-setting', { key: 'auto_away_enabled', value: autoAwayEnabled });
    changed = true;
  }

  const updateBannerAdminOnly = document.getElementById('update-banner-admin-only')?.checked ? 'true' : 'false';
  if (updateBannerAdminOnly !== (snap.update_banner_admin_only || 'false')) {
    this.socket.emit('update-server-setting', { key: 'update_banner_admin_only', value: updateBannerAdminOnly });
    changed = true;
  }
  const allowSelfPurge = document.getElementById('allow-self-purge')?.checked ? 'true' : 'false';
  if (allowSelfPurge !== (snap.allow_self_purge || 'false')) {
    this.socket.emit('update-server-setting', { key: 'allow_self_purge', value: allowSelfPurge });
    changed = true;
  }
  const hideDisabledBadges = document.getElementById('hide-disabled-badges')?.checked ? 'true' : 'false';
  if (hideDisabledBadges !== (snap.hide_disabled_channel_badges || 'false')) {
    this.socket.emit('update-server-setting', { key: 'hide_disabled_channel_badges', value: hideDisabledBadges });
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
  const iceDisabledVal = document.getElementById('voice-ice-disabled')?.checked ? 'true' : 'false';
  if (iceDisabledVal !== (snap.voice_ice_disabled || 'false')) {
    this.socket.emit('update-server-setting', { key: 'voice_ice_disabled', value: iceDisabledVal });
    changed = true;
  }
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
    const cu = document.getElementById('cleanup-max-uploads');
    if (cu) cu.value = snap.cleanup_max_uploads_mb;
    const dr = document.getElementById('deleted-retention-days');
    if (dr) dr.value = snap.deleted_retention_days;
    const ks = document.getElementById('keep-self-destructed');
    if (ks) ks.checked = snap.keep_self_destructed_attachments !== 'false';
    const wl = document.getElementById('whitelist-enabled');
    if (wl) wl.checked = snap.whitelist_enabled === 'true';
    const mu = document.getElementById('max-upload-mb');
    if (mu) mu.value = snap.max_upload_mb || '25';
    const ma = document.getElementById('max-attachments');
    if (ma) ma.value = snap.max_attachments || '10';
    const mtpa = document.getElementById('max-tags-per-attachment');
    if (mtpa) mtpa.value = snap.max_tags_per_attachment || '3';
    const mtl = document.getElementById('max-tag-len');
    if (mtl) mtl.value = snap.max_tag_len || '20';
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
    const asp = document.getElementById('allow-self-purge');
    if (asp) asp.checked = snap.allow_self_purge === 'true';
    const hdb = document.getElementById('hide-disabled-badges');
    if (hdb) hdb.checked = snap.hide_disabled_channel_badges === 'true';
    const dt = document.getElementById('default-theme-select');
    if (dt) dt.value = snap.default_theme || '';
    const dl = document.getElementById('default-locale-select');
    if (dl) dl.value = snap.default_locale || '';
    const ct = document.getElementById('custom-tos-input');
    if (ct) ct.value = snap.custom_tos || '';
    const rcap = document.getElementById('registration-captcha-enabled');
    if (rcap) rcap.checked = snap.registration_captcha_enabled === 'true';
    const tss = document.getElementById('turnstile-site-key');
    if (tss) tss.value = snap.turnstile_site_key || '';
    const tsk = document.getElementById('turnstile-secret-key');
    if (tsk) tsk.value = snap.turnstile_secret_key || '';
    const rrl = document.getElementById('registration-rate-limit-enabled');
    if (rrl) rrl.checked = snap.registration_rate_limit_enabled === 'true';
    const rrn = document.getElementById('registration-rate-limit-per-hour');
    if (rrn) rrn.value = snap.registration_rate_limit_per_hour || '20';
    const miu = document.getElementById('max-invite-uses');
    if (miu) miu.value = snap.max_invite_uses || '0';
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
      const seasonal = published.filter(t => window.HavenThemeCompat?.isSeasonalTheme?.(t)), standard = published.filter(t => !seasonal.includes(t));

      if (standard.length > 0) {
        const sep = document.createElement('option');
        sep.disabled = true;
        sep.textContent = `── ${t('settings.admin.custom_themes')} ──`;
        sep.setAttribute('data-custom-theme', '1');
        dtSelect.appendChild(sep);
        for (const theme of standard) {
          const opt = document.createElement('option');
          opt.value = `file:${theme.file}`;
          opt.textContent = theme.name || theme.file;
          opt.setAttribute('data-custom-theme', '1');
          dtSelect.appendChild(opt);
        }
      }

      if (seasonal.length > 0) {
        const sep = document.createElement('option');
        sep.disabled = true;
        sep.textContent = `── ${t('app.theme.seasonal')} ──`;
        sep.setAttribute('data-custom-theme', '1');
        dtSelect.appendChild(sep);
        for (const theme of seasonal) {
          const opt = document.createElement('option');
          opt.value = `file:${theme.file}`;
          opt.textContent = `${theme.icon ? theme.icon + ' ' : ''}${theme.name || theme.file}`;
          opt.setAttribute('data-custom-theme', '1');
          dtSelect.appendChild(opt);
        }
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

// ═══════════════════════════════════════════════════════
};
