// The Settings window: opening it, the User and Admin tabs, the section nav,
// language, the composer layout options, time zone, password, two-factor
// login, recovery codes, the encryption passphrase, and deleting your
// account or your messages.

export default {

_bindSettings() {
  // ── Settings popout modal ────────────────────────────
  const openSettingsModal = () => {
    this._snapshotAdminSettings();
    document.getElementById('settings-modal').style.display = 'flex';
    this._syncSettingsNav();
    // Always open on User tab
    this._switchSettingsTab('user');
    // Sync language select with current locale
    const langSelect = document.getElementById('language-select');
    if (langSelect && window.i18n) {
      langSelect.value = i18n.preference;
      i18n.syncLocalePicker(langSelect);
    }
    // Show desktop-only sections when running inside Haven Desktop
    if (window.havenDesktop?.isDesktopApp) {
      document.getElementById('desktop-shortcuts-nav')?.style.removeProperty('display');
      document.getElementById('desktop-app-nav')?.style.removeProperty('display');
      document.getElementById('section-desktop-shortcuts')?.style.removeProperty('display');
      document.getElementById('section-desktop-app')?.style.removeProperty('display');
      document.getElementById('pref-force-sdr-row')?.style.removeProperty('display');
      document.getElementById('pref-disable-gpu-vsync-row')?.style.removeProperty('display');
      document.getElementById('pref-unlimit-frame-rate-row')?.style.removeProperty('display');
      // Linux only, and only from a Desktop build that has the setting (#57).
      if (window.havenDesktop.platform === 'linux' && typeof window.havenDesktop.prefs?.setLinuxVaapiBypass === 'function') {
        document.getElementById('pref-linux-vaapi-row')?.style.removeProperty('display');
      }
      // Same, for X11 mode (#5721).
      if (window.havenDesktop.platform === 'linux' && typeof window.havenDesktop.prefs?.setLinuxForceX11 === 'function') {
        document.getElementById('pref-linux-x11-row')?.style.removeProperty('display');
      }
    }
    // Eagerly fetch data that requires async calls so sections don't
    // sit on "Loading..." indefinitely if the user never clicks the nav item.
    loadTotpStatus();
    if (this.user?.isAdmin) this._loadRoles();
    // (#36) Eagerly wire up Desktop-only sections too. Without this the Shortcut
    // record buttons and Desktop App / Debug prefs only get their event handlers
    // attached when the user clicks the matching left-nav item, so a user who
    // opens Settings and scrolls straight to a checkbox or to the keybind
    // recorder finds them unresponsive until they happen to click the nav.
    if (window.havenDesktop?.isDesktopApp) {
      this._setupDesktopShortcuts?.();
      this._setupDesktopAppPrefs?.();
    }
  };
  document.getElementById('open-settings-btn').addEventListener('click', openSettingsModal);
  document.getElementById('mobile-settings-btn')?.addEventListener('click', () => {
    openSettingsModal();
    document.getElementById('app-body')?.classList.remove('mobile-sidebar-open');
    document.getElementById('mobile-overlay')?.classList.remove('active');
  });
  document.getElementById('close-settings-btn').addEventListener('click', () => {
    this._cancelAdminSettings();
  });
  document.getElementById('settings-modal').addEventListener('click', (e) => {
    if (e.target !== e.currentTarget) return;
    // Don't close while TOTP setup flow is active; user could lose progress
    const setupArea  = document.getElementById('totp-setup-area');
    const backupArea = document.getElementById('totp-backup-area');
    if ((setupArea  && setupArea.style.display  !== 'none') ||
        (backupArea && backupArea.style.display !== 'none')) return;
    this._cancelAdminSettings();
  });
  document.getElementById('admin-save-btn')?.addEventListener('click', () => {
    this._saveAdminSettings();
  });

  // ── Settings tab switching (User / Admin) ────────────
  this._switchSettingsTab = (tab) => {
    const userBody = document.getElementById('settings-body-user');
    const adminBody = document.getElementById('settings-body-admin');
    const userNav = document.querySelector('.settings-nav-user');
    const adminNav = document.querySelector('.settings-nav-admin-group');
    const saveBar = document.querySelector('.admin-save-bar');

    document.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
    document.querySelector(`.settings-tab[data-tab="${tab}"]`)?.classList.add('active');

    if (tab === 'admin') {
      // Defensive gate: refuse switching to the admin tab if the user has no
      // admin/manage permissions, regardless of where the call came from.
      const hasAdminAccess = !!this.user && this._hasAnyAdminSettingsAccess();
      if (!hasAdminAccess) return this._switchSettingsTab('user');
      if (userBody) userBody.style.display = 'none';
      if (adminBody) adminBody.style.display = '';
      if (userNav) userNav.style.display = 'none';
      if (adminNav) adminNav.style.display = '';
      if (saveBar) saveBar.style.display = '';
      // Activate first admin nav item
      document.querySelectorAll('.settings-nav-item').forEach(n => n.classList.remove('active'));
      const firstAdmin = adminNav?.querySelector('.settings-nav-item:not([style*="display: none"])');
      if (firstAdmin) firstAdmin.classList.add('active');
    } else {
      if (userBody) userBody.style.display = '';
      if (adminBody) adminBody.style.display = 'none';
      if (userNav) userNav.style.display = '';
      if (adminNav) adminNav.style.display = 'none';
      if (saveBar) saveBar.style.display = 'none';
      // Activate first user nav item
      document.querySelectorAll('.settings-nav-item').forEach(n => n.classList.remove('active'));
      const firstUser = userNav?.querySelector('.settings-nav-item');
      if (firstUser) firstUser.classList.add('active');
    }
  };

  document.querySelectorAll('.settings-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      this._switchSettingsTab(tab.dataset.tab);
    });
  });

  // ── Settings nav click-to-scroll ─────────────────────
  document.querySelectorAll('.settings-nav-item').forEach(item => {
    item.addEventListener('click', () => {
      const targetId = item.dataset.target;
      const target = document.getElementById(targetId);
      if (!target) return;
      // Scroll into view within the settings body
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      // Update active state
      document.querySelectorAll('.settings-nav-item').forEach(n => n.classList.remove('active'));
      item.classList.add('active');
      // Suppress scroll-spy briefly so the smooth-scroll animation passing over
      // intermediate sections doesn't steal the highlight from what was clicked.
      this._settingsSpyMuteUntil = Date.now() + 800;
    });
  });

  // ── Settings scroll-spy ──────────────────────────────
  // Settings bodies are long scrolling columns rather than tab switchers.
  // Keep the corresponding nav item highlighted as the user scrolls.
  //
  // User settings:
  //   #settings-body-user
  //   .settings-nav-user
  //
  // Admin settings:
  //   #settings-body-admin
  //   .settings-nav-admin-group
  //
  // Each body has its own independent scroll-spy so the user and admin nav
  // states cannot interfere with each other.
  const setupSettingsScrollSpy = (settingsBody, navSelector) => {
    if (!settingsBody) return;

    const syncNavHighlight = () => {
      if (Date.now() < (this._settingsSpyMuteUntil || 0)) return;

      // Only consider nav items whose corresponding section currently exists
      // and is visible. This is important for admin settings because many of
      // the admin nav entries start with display:none.
      const navItems = Array.from(document.querySelectorAll(`${navSelector} .settings-nav-item`));
      const visibleNavItems = navItems.filter(item => {
        if (item.offsetParent === null) return false;

        const section = document.getElementById(item.dataset.target);
        return section && section.offsetParent !== null;
      });

      if (!visibleNavItems.length) return;

      const bodyTop = settingsBody.getBoundingClientRect().top;
      let current = null;
      for (const item of visibleNavItems) {
        const section = document.getElementById(item.dataset.target);
        if (!section) continue;

        // The last section whose top has passed the top of the scrolling
        // body is the section currently being viewed.
        if (section.getBoundingClientRect().top - bodyTop <= 8) {
          current = item;
        } else {
          break;
        }
      }

      // Before the first section reaches the top, highlight the first
      // visible section.
      if (!current) current = visibleNavItems[0];

      // Nothing to do if the correct item is already highlighted.
      if (current.classList.contains('active')) return;

      // Only modify nav items belonging to this scroll-spy.
      visibleNavItems.forEach(item => item.classList.remove('active'));
      current.classList.add('active');
      // Keep the highlighted entry reachable in a long nav list.
      current.scrollIntoView({ block: 'nearest' });
    };

    let spyQueued = false;
    settingsBody.addEventListener('scroll', () => {
      if (spyQueued) return;
      spyQueued = true;
      requestAnimationFrame(() => { spyQueued = false; syncNavHighlight(); });
    }, { passive: true });

    // Set the correct highlight immediately in case the settings body is
    // already scrolled when the spy is initialized.
    syncNavHighlight();
  };
  // User settings scroll-spy
  setupSettingsScrollSpy(document.getElementById('settings-body-user'), '.settings-nav-user');
  // Admin settings scroll-spy
  setupSettingsScrollSpy(document.getElementById('settings-body-admin'), '.settings-nav-admin-group');

  // ── Language switcher ────────────────────────────────
  document.getElementById('language-select')?.addEventListener('change', (e) => {
    if (window.i18n) i18n.setLocale(e.target.value);
  });
  this._buildLanguagePicker();

  // ── Voice messages (#5665) ────────────────────────────
  document.getElementById('voice-btn')?.addEventListener('click', () => this._toggleVoiceMessage());
  document.getElementById('voice-rec-cancel')?.addEventListener('click', () => this._stopVoiceMessage(false));
  document.getElementById('voice-rec-send')?.addEventListener('click', () => this._stopVoiceMessage(true));

  // ── One + button in place of the toolbar (#5654) ──────
  // With the setting on, the toolbar is hidden and becomes the menu the +
  // opens; the buttons keep their own handlers, only their home moves.
  const plusBtn = document.getElementById('composer-plus-btn');
  const actionsBox = document.querySelector('#message-input-area .input-actions-box');
  this._closeComposerMenu = () => {
    actionsBox?.classList.remove('open');
    plusBtn?.setAttribute('aria-expanded', 'false');
  };
  if (plusBtn && actionsBox) {
    plusBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = !actionsBox.classList.contains('open');
      actionsBox.classList.toggle('open', open);
      plusBtn.setAttribute('aria-expanded', String(open));
    });
    // Picking a tool closes the menu; the tool's own picker takes over.
    actionsBox.addEventListener('click', (e) => {
      if (document.documentElement.hasAttribute('data-compact-composer') && e.target.closest('button')) setTimeout(() => this._closeComposerMenu(), 0);
    });
    document.addEventListener('click', (e) => {
      if (actionsBox.classList.contains('open') && !e.target.closest('.input-actions-box') && e.target !== plusBtn) this._closeComposerMenu();
    });
  }

  // ── Formatting guide and command list (#5654) ─────────
  const formatBtn = document.getElementById('format-btn');
  const formatPicker = document.getElementById('format-picker');
  if (formatBtn && formatPicker) {
    let formatTab = 'markdown';
    const renderFormatPicker = () => {
      formatPicker.querySelectorAll('.gif-tab').forEach(b => b.classList.toggle('active', b.dataset.formatTab === formatTab));
      const list = document.getElementById('format-picker-list');
      if (list) list.innerHTML = formatTab === 'markdown' ? this._formatGuideHtml() : this._commandGuideHtml();
    };
    formatBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = formatPicker.style.display === 'none';
      const emojiPicker = document.getElementById('emoji-picker');
      const gifPicker = document.getElementById('gif-picker');
      if (emojiPicker) emojiPicker.style.display = 'none';
      if (gifPicker) gifPicker.style.display = 'none';
      formatPicker.style.display = open ? 'flex' : 'none';
      if (open) renderFormatPicker();
    });
    formatPicker.addEventListener('click', (e) => {
      e.stopPropagation();
      const tab = e.target.closest('[data-format-tab]');
      if (tab) { formatTab = tab.dataset.formatTab; renderFormatPicker(); return; }
      const row = e.target.closest('.format-row');
      if (!row) return;
      if (row.dataset.cmd) this._insertGuideCommand(row.dataset.cmd);
      else this._wrapComposerSelection(row.dataset.before || '', row.dataset.after || '', row.dataset.sample || '', row.dataset.block === '1');
      formatPicker.style.display = 'none';
    });
    document.addEventListener('click', (e) => {
      if (formatPicker.style.display !== 'none' && !e.target.closest('#format-picker') && !e.target.closest('#format-btn')) formatPicker.style.display = 'none';
    });
  }

  // ── Timezone (Configure Time) ────────────────────────
  document.getElementById('configure-time-btn')?.addEventListener('click', () => {
    this._openTimezoneModal({ firstRun: false });
  });
  this._updateTimezoneSummary?.();

  // ── Password change ──────────────────────────────────
  document.getElementById('change-password-btn').addEventListener('click', async () => {
    const cur  = document.getElementById('current-password').value;
    const np   = document.getElementById('new-password').value;
    const conf = document.getElementById('confirm-password').value;
    const hint = document.getElementById('password-status');
    hint.textContent = '';
    hint.className = 'settings-hint';

    if (!cur || !np) return hint.textContent = t('settings.password_section.fill_fields');
    if (np.length < 8) return hint.textContent = t('settings.password_section.too_short');
    if (np !== conf)   return hint.textContent = t('settings.password_section.mismatch');

    // Flag to prevent force-logout from kicking us out
    this._justChangedPassword = true;

    try {
      const res = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`
        },
        body: JSON.stringify({ currentPassword: cur, newPassword: np })
      });
      const data = await res.json();
      if (!res.ok) {
        hint.textContent = data.error || t('settings.password_section.failed');
        hint.classList.add('error');
        return;
      }
      // Store the fresh token
      this.token = data.token;
      localStorage.setItem('haven_token', data.token);
      // Update socket auth so auto-reconnect uses the new token
      this.socket.auth.token = data.token;

      // Re-wrap E2E private key with a key derived from the NEW password
      // so the server backup can be unlocked with the new credentials. A
      // backup locked with a separate passphrase stays as it is.
      if (this.e2e && this.e2e.ready && typeof HavenE2E !== 'undefined' && !this.user?.e2ePassphrase) {
        try {
          const newWrap = await HavenE2E.deriveWrappingKey(np);
          await this.e2e.reWrapKey(this.socket, newWrap);
          // Re-encrypt server list blob with the new wrapping key
          this._e2eWrappingKey = newWrap;
          this._pushServerListToServer();
        } catch (err) {
          console.warn('[E2E] Failed to re-wrap key:', err);
        }
      }

      hint.textContent = '✅ ' + t('settings.password_section.changed');
      hint.classList.add('success');
      document.getElementById('current-password').value = '';
      document.getElementById('new-password').value = '';
      document.getElementById('confirm-password').value = '';
      // Clear the flag after a delay so socket reconnects go through
      setTimeout(() => { this._justChangedPassword = false; }, 5000);
    } catch {
      this._justChangedPassword = false;
      hint.textContent = t('settings.password_section.network_error');
      hint.classList.add('error');
    }
  });

  // ── Encryption passphrase ────────────────────────────
  // The E2E key backup is normally locked with the login password, which the
  // server receives at every sign-in. A passphrase of the user's own keeps the
  // server from ever being able to open it.
  this._setupE2EPassphraseSection();

  // ── Two-Factor Authentication settings ─────────────
  const totpStatusText     = document.getElementById('totp-status-text');
  const totpEnableArea     = document.getElementById('totp-enable-area');
  const totpSetupArea      = document.getElementById('totp-setup-area');
  const totpBackupArea     = document.getElementById('totp-backup-area');
  const totpManageArea     = document.getElementById('totp-manage-area');
  const totpSetupStatus    = document.getElementById('totp-setup-status');
  const totpManageStatus   = document.getElementById('totp-manage-status');

  const loadTotpStatus = async () => {
    if (!totpStatusText) return;
    try {
      const res = await fetch('/api/auth/totp/status', {
        headers: { 'Authorization': `Bearer ${this.token}` }
      });
      const data = await res.json();
      if (!res.ok) { totpStatusText.textContent = data.error || t('settings.two_factor_section.error'); return; }

      // Hide all sub-areas first
      totpEnableArea.style.display = 'none';
      totpSetupArea.style.display = 'none';
      totpBackupArea.style.display = 'none';
      totpManageArea.style.display = 'none';

      if (data.enabled) {
        totpStatusText.textContent = '';
        totpManageArea.style.display = 'block';
        const remaining = document.getElementById('totp-backup-remaining');
        if (remaining) remaining.textContent = data.backupCodesRemaining === 1
          ? t('settings.two_factor_section.backup_codes_remaining_one', { count: data.backupCodesRemaining })
          : t('settings.two_factor_section.backup_codes_remaining_other', { count: data.backupCodesRemaining });
        // Clear password input
        const pwInput = document.getElementById('totp-disable-password');
        if (pwInput) pwInput.value = '';
        if (totpManageStatus) { totpManageStatus.textContent = ''; totpManageStatus.className = 'settings-hint'; }
      } else {
        totpStatusText.textContent = '';
        totpEnableArea.style.display = 'block';
      }
    } catch {
      totpStatusText.textContent = t('settings.two_factor_section.connection_error');
    }
  };

  // Load status when the 2FA section becomes visible
  const settingsNav = document.getElementById('settings-nav');
  if (settingsNav) {
    settingsNav.addEventListener('click', (e) => {
      const item = e.target.closest('.settings-nav-item');
      if (item && item.dataset.target === 'section-2fa') loadTotpStatus();
      if (item && item.dataset.target === 'section-tags-admin') this._loadAdminTags();
      if (item && item.dataset.target === 'section-sessions') this._refreshSessions();
      if (item && item.dataset.target === 'section-desktop-shortcuts') this._setupDesktopShortcuts();
      if (item && item.dataset.target === 'section-desktop-app') this._setupDesktopAppPrefs();
    });
  }

  // Enable button → start setup
  document.getElementById('totp-enable-btn')?.addEventListener('click', async () => {
    totpEnableArea.style.display = 'none';
    totpSetupArea.style.display = 'block';
    if (totpSetupStatus) { totpSetupStatus.textContent = ''; totpSetupStatus.className = 'settings-hint'; }
    document.getElementById('totp-verify-code').value = '';

    try {
      const res = await fetch('/api/auth/totp/setup', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${this.token}`, 'Content-Type': 'application/json' }
      });
      const data = await res.json();
      if (!res.ok) { totpSetupStatus.textContent = data.error || t('settings.two_factor_section.setup_failed'); return; }

      document.getElementById('totp-qr-img').src = data.qrDataUrl;
      document.getElementById('totp-secret-text').textContent = data.base32Secret;
    } catch {
      totpSetupStatus.textContent = t('settings.two_factor_section.connection_error');
    }
  });

  // Copy secret button
  document.getElementById('totp-copy-secret')?.addEventListener('click', () => {
    const secret = document.getElementById('totp-secret-text')?.textContent;
    if (!secret) return;
    const copyBtn = document.getElementById('totp-copy-secret');
    const markCopied = () => {
      copyBtn.textContent = '✅ ' + t('common.copied');
      setTimeout(() => { copyBtn.textContent = '📋 ' + t('common.copy'); }, 1500);
    };
    navigator.clipboard.writeText(secret).then(markCopied).catch(() => {
      // Fallback for Electron / contexts where Clipboard API is restricted
      try {
        const ta = document.createElement('textarea');
        ta.value = secret;
        ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
        document.body.appendChild(ta);
        ta.focus(); ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        markCopied();
      } catch { /* could not copy */ }
    });
  });

  // Cancel setup
  document.getElementById('totp-cancel-setup-btn')?.addEventListener('click', () => {
    totpSetupArea.style.display = 'none';
    totpEnableArea.style.display = 'block';
  });

  // Verify & Activate
  document.getElementById('totp-verify-setup-btn')?.addEventListener('click', async () => {
    const code = document.getElementById('totp-verify-code')?.value.trim();
    if (!code || code.length !== 6) {
      if (totpSetupStatus) totpSetupStatus.textContent = t('settings.two_factor_section.verify_prompt');
      return;
    }
    try {
      const res = await fetch('/api/auth/totp/verify-setup', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ code })
      });
      const data = await res.json();
      if (!res.ok) {
        if (totpSetupStatus) { totpSetupStatus.textContent = data.error || t('settings.two_factor_section.verify_failed'); totpSetupStatus.classList.add('error'); }
        return;
      }
      // Store fresh token: server bumped password_version to invalidate other sessions
      if (data.token) {
        this._justEnabledTotp = true;
        this.token = data.token;
        localStorage.setItem('haven_token', data.token);
        if (this.socket) this.socket.auth.token = data.token;
      }
      // Show backup codes
      totpSetupArea.style.display = 'none';
      totpBackupArea.style.display = 'block';
      const codesEl = document.getElementById('totp-backup-codes');
      if (codesEl) codesEl.innerHTML = data.backupCodes.map(c => `<div>${c}</div>`).join('');
    } catch {
      if (totpSetupStatus) totpSetupStatus.textContent = t('settings.two_factor_section.connection_error');
    }
  });

  // Copy backup codes to clipboard
  document.getElementById('totp-copy-backup-btn')?.addEventListener('click', () => {
    const codesEl = document.getElementById('totp-backup-codes');
    if (!codesEl) return;
    const codes = Array.from(codesEl.querySelectorAll('div')).map(d => d.textContent).join('\n');
    const btn = document.getElementById('totp-copy-backup-btn');
    const markCopied = () => {
      btn.textContent = '✅ ' + t('common.copied') + '!';
      setTimeout(() => { btn.textContent = '📋 ' + t('settings.two_factor_section.copy_backup_btn'); }, 2000);
    };
    navigator.clipboard.writeText(codes).then(markCopied).catch(() => {
      // Fallback for Electron / contexts where Clipboard API is restricted
      try {
        const ta = document.createElement('textarea');
        ta.value = codes;
        ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
        document.body.appendChild(ta);
        ta.focus(); ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        markCopied();
      } catch { /* could not copy */ }
    });
  });

  // Done viewing backup codes
  document.getElementById('totp-backup-done-btn')?.addEventListener('click', () => {
    loadTotpStatus();
  });

  // Disable 2FA
  document.getElementById('totp-disable-btn')?.addEventListener('click', async () => {
    const pw = document.getElementById('totp-disable-password')?.value;
    if (!pw) { if (totpManageStatus) totpManageStatus.textContent = t('settings.two_factor_section.disable_prompt'); return; }
    try {
      const res = await fetch('/api/auth/totp/disable', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pw })
      });
      const data = await res.json();
      if (!res.ok) {
        if (totpManageStatus) { totpManageStatus.textContent = data.error || t('settings.two_factor_section.failed'); totpManageStatus.classList.add('error'); }
        return;
      }
      this._showToast(t('toasts.2fa_disabled'), 'info');
      loadTotpStatus();
    } catch {
      if (totpManageStatus) totpManageStatus.textContent = t('settings.two_factor_section.connection_error');
    }
  });

  // Regenerate backup codes
  document.getElementById('totp-regen-backup-btn')?.addEventListener('click', async () => {
    const pw = document.getElementById('totp-disable-password')?.value;
    if (!pw) { if (totpManageStatus) totpManageStatus.textContent = t('settings.two_factor_section.regen_prompt'); return; }
    try {
      const res = await fetch('/api/auth/totp/regenerate-backup', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pw })
      });
      const data = await res.json();
      if (!res.ok) {
        if (totpManageStatus) { totpManageStatus.textContent = data.error || t('settings.two_factor_section.failed'); totpManageStatus.classList.add('error'); }
        return;
      }
      // Show the new backup codes
      totpManageArea.style.display = 'none';
      totpBackupArea.style.display = 'block';
      const codesEl = document.getElementById('totp-backup-codes');
      if (codesEl) codesEl.innerHTML = data.backupCodes.map(c => `<div>${c}</div>`).join('');
    } catch {
      if (totpManageStatus) totpManageStatus.textContent = t('settings.two_factor_section.connection_error');
    }
  });

  // ── Recovery Codes section ───────────────────────────
  const loadRecoveryStatus = async () => {
    const statusEl = document.getElementById('recovery-code-status');
    if (!statusEl) return;
    try {
      const res = await fetch('/api/auth/recovery-codes/status', {
        headers: { 'Authorization': `Bearer ${this.token}` }
      });
      const data = await res.json();
      if (!res.ok) { statusEl.textContent = data.error || t('settings.two_factor_section.error'); return; }
      statusEl.textContent = data.count > 0
        ? (data.count === 1
            ? t('settings.recovery_section.status_one', { count: data.count })
            : t('settings.recovery_section.status_other', { count: data.count }))
        : t('settings.recovery_section.no_codes');
    } catch {
      statusEl.textContent = t('settings.recovery_section.connection_error');
    }
  };

  // Load status when Recovery section becomes visible
  if (settingsNav) {
    const _origSettingsNavHandler = settingsNav._recoveryNavAdded;
    if (!_origSettingsNavHandler) {
      settingsNav._recoveryNavAdded = true;
      settingsNav.addEventListener('click', (e) => {
        const item = e.target.closest('.settings-nav-item');
        if (item && item.dataset.target === 'section-recovery') {
          loadRecoveryStatus();
          document.getElementById('recovery-gen-status').textContent = '';
          document.getElementById('recovery-gen-password').value = '';
          document.getElementById('recovery-generate-area').style.display = '';
          document.getElementById('recovery-codes-area').style.display = 'none';
        }
      });
    }
  }

  document.getElementById('recovery-generate-btn')?.addEventListener('click', async () => {
    const password = document.getElementById('recovery-gen-password')?.value;
    const statusEl = document.getElementById('recovery-gen-status');
    if (!password) { statusEl.textContent = t('settings.recovery_section.confirm_prompt'); return; }
    statusEl.textContent = '';
    try {
      const res = await fetch('/api/auth/recovery-codes/generate', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
      });
      const data = await res.json();
      if (!res.ok) { statusEl.textContent = data.error || t('settings.recovery_section.failed'); return; }

      const codesEl = document.getElementById('recovery-codes-list');
      if (codesEl) codesEl.innerHTML = data.codes.map(c => `<div>${c}</div>`).join('');
      document.getElementById('recovery-generate-area').style.display = 'none';
      document.getElementById('recovery-codes-area').style.display = '';
      loadRecoveryStatus();
    } catch {
      statusEl.textContent = t('settings.recovery_section.connection_error');
    }
  });

  document.getElementById('recovery-copy-btn')?.addEventListener('click', () => {
    const codesEl = document.getElementById('recovery-codes-list');
    if (!codesEl) return;
    const text = Array.from(codesEl.querySelectorAll('div')).map(d => d.textContent).join('\n');
    const btn = document.getElementById('recovery-copy-btn');
    const markCopied = () => {
      btn.textContent = '✅ ' + t('common.copied') + '!';
      setTimeout(() => { btn.textContent = '📋 ' + t('settings.recovery_section.copy_codes_btn'); }, 2000);
    };
    navigator.clipboard.writeText(text).then(markCopied).catch(() => {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
        document.body.appendChild(ta);
        ta.focus(); ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        markCopied();
      } catch { /* could not copy */ }
    });
  });

  document.getElementById('recovery-codes-done-btn')?.addEventListener('click', () => {
    document.getElementById('recovery-codes-area').style.display = 'none';
    document.getElementById('recovery-generate-area').style.display = '';
    document.getElementById('recovery-gen-password').value = '';
  });

  // ── Plugin refresh button ─────────────────────────────
  document.getElementById('plugin-refresh-btn')?.addEventListener('click', () => {
    if (window.HavenPluginLoader) {
      window.HavenPluginLoader.refresh();
      this._showToast(t('toasts.plugins_refreshing'), 'info');
    }
  });

  // ── Self-delete account ─────────────────────────────
  document.getElementById('delete-account-btn').addEventListener('click', () => {
    // Build a confirmation overlay dynamically
    const existing = document.querySelector('.self-delete-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay self-delete-overlay';
    overlay.style.display = 'flex';
    overlay.innerHTML = `
      <div class="modal" style="max-width:380px">
        <h3>⚠️ ${t('settings.delete_account_section.title')}</h3>
        <p class="modal-desc">${t('settings.delete_account_section.desc')}</p>
        <div class="form-group compact">
          <input type="password" id="self-delete-pw" placeholder="${t('settings.delete_account_section.password_placeholder')}" maxlength="128" autocomplete="current-password">
        </div>
        <label class="toggle-row" style="margin:8px 0">
          <span>${t('settings.delete_account_section.delete_messages')}</span>
          <input type="checkbox" id="self-delete-scrub">
        </label>
        <small class="settings-hint" style="margin-bottom:8px;display:block">${t('settings.delete_account_section.delete_messages_hint')}</small>
        <small class="settings-hint self-delete-status" style="display:block;margin-bottom:8px"></small>
        <div class="modal-actions">
          <button class="btn-sm self-delete-cancel">${t('modals.common.cancel')}</button>
          <button class="btn-sm btn-danger-fill self-delete-confirm">${t('settings.delete_account_section.btn')}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    overlay.querySelector('.self-delete-cancel').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    overlay.querySelector('.self-delete-confirm').addEventListener('click', async () => {
      const pw = document.getElementById('self-delete-pw').value;
      const scrub = document.getElementById('self-delete-scrub').checked;
      const status = overlay.querySelector('.self-delete-status');

      if (!pw) { status.textContent = t('settings.delete_account_section.password_required'); return; }
      const ok = await this._showConfirmModal(t('confirm.delete_account'), '', { danger: true });
      if (!ok) return;

      status.textContent = t('settings.delete_account_section.deleting');
      overlay.querySelector('.self-delete-confirm').disabled = true;

      this.socket.emit('self-delete-account', { password: pw, scrubMessages: scrub }, (res) => {
        if (res && res.error) {
          status.textContent = res.error;
          overlay.querySelector('.self-delete-confirm').disabled = false;
          return;
        }
        // Account deleted: clear local storage and redirect to login
        this._clearChannelCodeMap?.();
        localStorage.removeItem('haven_token');
        localStorage.removeItem('haven_e2e_privkey');
        localStorage.removeItem('haven_sync_key');
        window.location.reload();
      });
    });
  });

  // Delete every message you wrote (#5686). Same shape as Delete Account:
  // password, a second confirm, then the server does it and says how many.
  document.getElementById('self-purge-btn')?.addEventListener('click', () => {
    document.querySelector('.self-purge-overlay')?.remove();
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay self-purge-overlay';
    overlay.style.display = 'flex';
    overlay.innerHTML = `
      <div class="modal" style="max-width:380px">
        <h3>🧹 ${t('settings.self_purge.title')}</h3>
        <p class="modal-desc">${t('settings.self_purge.confirm_desc')}</p>
        <div class="form-group compact">
          <input type="password" id="self-purge-pw" placeholder="${t('settings.delete_account_section.password_placeholder')}" maxlength="128" autocomplete="current-password">
        </div>
        <small class="settings-hint self-purge-status" style="display:block;margin-bottom:8px"></small>
        <div class="modal-actions">
          <button class="btn-sm self-purge-cancel">${t('modals.common.cancel')}</button>
          <button class="btn-sm btn-danger-fill self-purge-confirm">${t('settings.self_purge.btn')}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('.self-purge-cancel').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    overlay.querySelector('.self-purge-confirm').addEventListener('click', async () => {
      const pw = document.getElementById('self-purge-pw').value;
      const status = overlay.querySelector('.self-purge-status');
      if (!pw) { status.textContent = t('settings.delete_account_section.password_required'); return; }
      const ok = await this._showConfirmModal(t('settings.self_purge.confirm_title'), t('settings.self_purge.confirm_body'), { danger: true, confirmLabel: t('settings.self_purge.btn') });
      if (!ok) return;
      status.textContent = t('settings.delete_account_section.deleting');
      overlay.querySelector('.self-purge-confirm').disabled = true;
      this.socket.emit('self-purge-messages', { password: pw }, (res) => {
        if (!res || res.error) {
          status.textContent = res?.error || t('settings.self_purge.failed');
          overlay.querySelector('.self-purge-confirm').disabled = false;
          return;
        }
        overlay.remove();
        this._showToast(res.kept
          ? t('settings.self_purge.done_kept', { n: res.deleted, kept: res.kept })
          : t('settings.self_purge.done', { n: res.deleted }), 'success');
      });
    });
  });
},

// ═══════════════════════════════════════════════════════
// CHANNEL & MESSAGE LINKS: copy/share deep-links
// ═══════════════════════════════════════════════════════

/**
 * Replace the native language <select> with a custom dropdown that can show
 * real flag artwork.
 *
 * Windows browsers refuse to render Unicode regional-indicator flags and fall
 * back to the bare two-letter code, so "🇬🇧 English" displayed as "GB English".
 * The emoji picker already solved this by shipping SVGs (see builtinEmojis in
 * app.js), but that fix can't apply here: an <option> element renders text
 * only (no images, no markup), so no amount of CSS or emoji font work will
 * put a flag inside a native select.
 *
 * The original <select> is kept in the DOM as the source of truth and still
 * receives its 'change' event, so the existing i18n wiring is untouched; this
 * only swaps the visible control.
 */
_buildLanguagePicker() {
  const select = document.getElementById('language-select');
  if (!select || !window.i18n) return;
  select.value = i18n.preference;
  i18n.buildLocalePicker(select);
},

// Settings > Encryption: lock the E2E key backup with a passphrase of the
// user's own instead of the login password, or go back. SSO accounts already
// use a passphrase and guests have no password, so neither sees it.
_setupE2EPassphraseSection() {
  const section = document.getElementById('section-e2e-passphrase');
  if (!section) return;
  const navItem = document.querySelector('.settings-nav-item[data-target="section-e2e-passphrase"]');
  const stateEl = document.getElementById('e2e-pp-state');
  const statusEl = document.getElementById('e2e-pp-status');
  const newEl = document.getElementById('e2e-pp-new');
  const confirmEl = document.getElementById('e2e-pp-confirm');
  const saveBtn = document.getElementById('e2e-pp-save-btn');
  const revertArea = document.getElementById('e2e-pp-revert-area');
  const pwEl = document.getElementById('e2e-pp-password');
  const revertBtn = document.getElementById('e2e-pp-revert-btn');

  const say = (msg, kind) => {
    statusEl.textContent = msg || '';
    statusEl.className = 'settings-hint' + (kind ? ` ${kind}` : '');
  };
  const render = () => {
    const hidden = !!(this.user?.isSso || this.user?.isGuest);
    section.style.display = hidden ? 'none' : '';
    if (navItem) navItem.style.display = hidden ? 'none' : '';
    const own = !!this.user?.e2ePassphrase;
    stateEl.textContent = t(own ? 'settings.e2e_passphrase.state_own' : 'settings.e2e_passphrase.state_password');
    saveBtn.textContent = t(own ? 'settings.e2e_passphrase.change_btn' : 'settings.e2e_passphrase.save_btn');
    revertArea.style.display = own ? '' : 'none';
  };
  // session-info fills in the flags after this runs, so it re-renders too.
  this._renderE2EPassphraseSection = render;
  render();

  // Either change re-locks the backup, so the key has to be unlocked first.
  const whenUnlocked = (fn) => {
    if (this.e2e?.ready) return fn();
    say(t('settings.e2e_passphrase.unlock_first'), 'error');
    this._requireE2E(fn);
  };

  // The backup is locked with wrapKey from now on, and the server list sync
  // (which shares the key) follows it.
  const adopt = async (wrapKey, own) => {
    await this.e2e.reWrapKey(this.socket, wrapKey, { separatePassphrase: own });
    this.user.e2ePassphrase = own;
    try { localStorage.setItem('haven_user', JSON.stringify(this.user)); } catch { /* private mode */ }
    this._e2eWrappingKey = wrapKey;
    try { localStorage.setItem('haven_sync_key', wrapKey); } catch { /* private mode */ }
    this._pushServerListToServer?.();
    render();
  };

  saveBtn.addEventListener('click', () => {
    const pass = newEl.value;
    if (!pass || pass.length < 8) return say(t('settings.e2e_passphrase.too_short'), 'error');
    if (pass !== confirmEl.value) return say(t('settings.e2e_passphrase.mismatch'), 'error');
    whenUnlocked(async () => {
      saveBtn.disabled = true;
      say(t('settings.e2e_passphrase.saving'));
      try {
        await adopt(await HavenE2E.deriveWrappingKey(pass), true);
        newEl.value = '';
        confirmEl.value = '';
        say('✅ ' + t('settings.e2e_passphrase.saved'), 'success');
      } catch (err) {
        console.warn('[E2E] Could not lock the backup with the passphrase:', err);
        say(t('settings.e2e_passphrase.failed'), 'error');
      } finally {
        saveBtn.disabled = false;
      }
    });
  });

  revertBtn.addEventListener('click', () => {
    const password = pwEl.value;
    if (!password) return say(t('settings.e2e_passphrase.enter_password'), 'error');
    whenUnlocked(async () => {
      revertBtn.disabled = true;
      try {
        // Checked first: a mistyped password would lock the backup with a
        // key nobody can reproduce.
        const res = await fetch('/api/auth/verify-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: this.user.username, password })
        });
        const data = await res.json().catch(() => ({}));
        if (!data.valid) return say(t('settings.e2e_passphrase.wrong_password'), 'error');
        await adopt(await HavenE2E.deriveWrappingKey(password), false);
        pwEl.value = '';
        say('✅ ' + t('settings.e2e_passphrase.reverted'), 'success');
      } catch (err) {
        console.warn('[E2E] Could not lock the backup with the password:', err);
        say(t('settings.e2e_passphrase.failed'), 'error');
      } finally {
        revertBtn.disabled = false;
      }
    });
  });
},

};
