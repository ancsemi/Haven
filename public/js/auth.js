// ── Auth Page Logic (with theme support + i18n) ───────────────────────────

(async function () {
  // Preserve invite param across login/register so vanity invite links work for new users
  const _urlParams = new URLSearchParams(window.location.search);
  let _pendingInvite = _urlParams.get('invite') || sessionStorage.getItem('haven_pending_invite') || '';
  if (_pendingInvite) sessionStorage.setItem('haven_pending_invite', _pendingInvite);
  // Preserve channel/message deep-link params (?channel=CODE&message=ID) too
  const _pendingChannel = _urlParams.get('channel') || sessionStorage.getItem('haven_pending_channel') || '';
  const _pendingMessage = _urlParams.get('message') || sessionStorage.getItem('haven_pending_message') || '';
  if (_pendingChannel) sessionStorage.setItem('haven_pending_channel', _pendingChannel);
  if (_pendingMessage) sessionStorage.setItem('haven_pending_message', _pendingMessage);

  function _buildAppUrl() {
    const _appQuery = (() => {
      const parts = [];
      if (_pendingInvite) parts.push('invite=' + encodeURIComponent(_pendingInvite));
      if (_pendingChannel) parts.push('channel=' + encodeURIComponent(_pendingChannel));
      if (_pendingMessage) parts.push('message=' + encodeURIComponent(_pendingMessage));
      return parts.length ? '?' + parts.join('&') : '';
    })();
    return '/app' + _appQuery;
  }
  let _appUrl = _buildAppUrl();

  // (#12) A returning SSO callback stashes its session here and bounces to
  // this page. Claim it before the already-logged-in check below, so an old
  // token in localStorage can't send us to the app and strand a fresh login
  // that still has to set up its encryption passphrase.
  let _oidcHandoff = null;
  if (_urlParams.get('oidc') === '1') {
    try {
      const raw = sessionStorage.getItem('haven_oidc_handoff');
      sessionStorage.removeItem('haven_oidc_handoff');
      if (raw) _oidcHandoff = JSON.parse(raw);
    } catch { /* malformed handoff — fall through to the normal login page */ }
    history.replaceState({}, '', window.location.pathname);
  }
  const _oidcError = _urlParams.get('oidc_error') || '';
  if (_oidcError) history.replaceState({}, '', window.location.pathname);

  // If already logged in, redirect to app
  if (!_oidcHandoff && localStorage.getItem('haven_token')) {
    window.location.href = _appUrl;
    return;
  }

  // Initialise translations before rendering any UI text
  await window.i18n.init();

  // ── E2E wrapping key derivation (mirrors HavenE2E.deriveWrappingKey) ───
  async function deriveE2EWrappingKey(password) {
    const enc = new TextEncoder();
    const raw = await crypto.subtle.importKey(
      'raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']
    );
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode('haven-e2e-wrapping-v3'), iterations: 210_000 },
      raw, 256
    );
    return Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // ── Theme switching ───────────────────────────────────
  initThemeSwitcher('auth-theme-bar');

  // ── Language switcher ─────────────────────────────────
  const langSelect = document.getElementById('auth-lang-select');
  if (langSelect) {
    langSelect.value = window.i18n.locale;
    langSelect.addEventListener('change', e => window.i18n.setLocale(e.target.value));
  }

  // ── Fetch and display server version ──────────────────
  fetch('/api/version').then(r => r.json()).then(d => {
    const el = document.getElementById('auth-version');
    if (el && d.version) el.textContent = 'v' + d.version;
  }).catch(() => {});

  // ── Apply server default theme for first-time visitors ──
  // Only applies when the user has no personal theme preference stored locally.
  // Also fetch server title for login page branding.
  fetch('/api/public-config').then(r => r.json()).then(d => {
    if (d.default_theme && !localStorage.getItem('haven_theme')) {
      document.documentElement.setAttribute('data-theme', d.default_theme);
    }
    if (d.server_title) {
      const titleEl = document.getElementById('server-title');
      if (titleEl) titleEl.textContent = d.server_title;
    }
    // Tab branding for the login page (issue #5284). Mirrors what the
    // authenticated app does so multi-server tabs stay distinguishable
    // even before signing in.
    if (d.server_name && d.server_name.toLowerCase() !== 'haven') {
      document.title = `Haven: ${d.server_name}`;
    }
    if (d.server_icon) {
      let link = document.querySelector('link[rel="icon"]');
      if (!link) {
        link = document.createElement('link');
        link.rel = 'icon';
        document.head.appendChild(link);
      }
      link.removeAttribute('type');
      link.href = d.server_icon;
    }
    if (d.custom_tos) {
      const section = document.getElementById('custom-tos-section');
      const content = document.getElementById('custom-tos-content');
      if (section && content) {
        // Render as plain text with paragraph breaks
        content.innerHTML = d.custom_tos.split(/\n\n+/).map(p =>
          '<p>' + p.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>') + '</p>'
        ).join('');
        section.style.display = 'block';
      }
    }
  }).catch(() => {});

  // ── EULA ─────────────────────────────────────────────
  const ageCheckbox  = document.getElementById('age-checkbox');
  const eulaCheckbox = document.getElementById('eula-checkbox');
  const eulaModal = document.getElementById('eula-modal');
  const eulaLink = document.getElementById('eula-link');
  const eulaAcceptBtn = document.getElementById('eula-accept-btn');
  const eulaDeclineBtn = document.getElementById('eula-decline-btn');

  // Restore EULA acceptance from localStorage (v2.0 requires re-acceptance)
  if (localStorage.getItem('haven_eula_accepted') === '2.0') {
    eulaCheckbox.checked = true;
    ageCheckbox.checked  = true;
  }

  eulaLink.addEventListener('click', (e) => {
    e.preventDefault();
    eulaModal.style.display = 'flex';
  });

  eulaAcceptBtn.addEventListener('click', () => {
    eulaCheckbox.checked = true;
    ageCheckbox.checked  = true;
    localStorage.setItem('haven_eula_accepted', '2.0');
    eulaModal.style.display = 'none';
  });

  eulaDeclineBtn.addEventListener('click', () => {
    eulaCheckbox.checked = false;
    ageCheckbox.checked  = false;
    localStorage.removeItem('haven_eula_accepted');
    eulaModal.style.display = 'none';
  });

  eulaModal.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) eulaModal.style.display = 'none';
  });

  function checkEula() {
    if (!ageCheckbox.checked) {
      showError(t('auth.errors.must_be_18'));
      return false;
    }
    if (!eulaCheckbox.checked) {
      showError(t('auth.errors.must_accept_tos'));
      return false;
    }
    return true;
  }

  // ── Tab switching ─────────────────────────────────────
  const tabs = document.querySelectorAll('.auth-tab');
  const loginForm = document.getElementById('login-form');
  const registerForm = document.getElementById('register-form');
  const ssoForm = document.getElementById('sso-form');
  const totpForm = document.getElementById('totp-form');
  const forcedChangeForm = document.getElementById('forced-change-form');
  const banAppealForm = document.getElementById('ban-appeal-form');
  const errorEl = document.getElementById('auth-error');

  // Pending TOTP challenge state (set after successful password auth)
  let _pendingChallenge = null; // { challengeToken, password }
  // Pending forced password change after admin reset (#5300).
  // Holds the temp-pw session token + the password the user typed (which
  // was the temp password). Cleared once the change-password flow completes.
  let _pendingForcedChange = null; // { token, user, originalPassword }
  // Pending ban appeal (#5457): the credentials the user just proved with a
  // successful password check, reused to authenticate the appeal submission.
  let _pendingBanAppeal = null; // { username, password }

  function showTotpForm() {
    loginForm.style.display = 'none';
    registerForm.style.display = 'none';
    if (ssoForm) ssoForm.style.display = 'none';
    totpForm.style.display = 'flex';
    document.querySelector('.auth-tabs').style.display = 'none';
    document.getElementById('totp-code').value = '';
    document.getElementById('totp-code').focus();
    hideError();
  }

  function hideTotpForm() {
    totpForm.style.display = 'none';
    loginForm.style.display = 'flex';
    document.querySelector('.auth-tabs').style.display = 'flex';
    _pendingChallenge = null;
    hideError();
  }

  function showForcedChangeForm() {
    loginForm.style.display = 'none';
    registerForm.style.display = 'none';
    if (ssoForm) ssoForm.style.display = 'none';
    totpForm.style.display = 'none';
    forcedChangeForm.style.display = 'flex';
    document.querySelector('.auth-tabs').style.display = 'none';
    document.getElementById('forced-new-password').value = '';
    document.getElementById('forced-confirm-password').value = '';
    document.getElementById('forced-old-password').value = '';
    document.getElementById('forced-change-recall').open = false;
    document.getElementById('forced-new-password').focus();
    hideError();
  }

  // (#5457) Shown when login is rejected because the account is banned. The
  // reason came back from the server only after the password was verified.
  function showBanAppeal(username, password, reason) {
    _pendingBanAppeal = { username, password };
    loginForm.style.display = 'none';
    registerForm.style.display = 'none';
    if (ssoForm) ssoForm.style.display = 'none';
    totpForm.style.display = 'none';
    forcedChangeForm.style.display = 'none';
    document.getElementById('recover-form').style.display = 'none';
    banAppealForm.style.display = 'flex';
    document.querySelector('.auth-tabs').style.display = 'none';
    const reasonEl = document.getElementById('ban-appeal-reason');
    if (reasonEl) {
      reasonEl.textContent = reason
        ? `${t('auth.ban_appeal.reason_prefix')} ${reason}`
        : t('auth.ban_appeal.no_reason');
    }
    document.getElementById('ban-appeal-text').value = '';
    errorEl.style.color = '';
    document.getElementById('ban-appeal-text').focus();
    hideError();
  }

  // function to swap the active tab and form
  function showTab(target) {
    tabs.forEach(t => {
      t.classList.toggle('active', t.dataset.tab === target);
    });

    loginForm.style.display = target === 'login' ? 'flex' : 'none';
    registerForm.style.display = target === 'register' ? 'flex' : 'none';
    if (ssoForm) ssoForm.style.display = target === 'sso' ? 'flex' : 'none';
    totpForm.style.display = 'none';
    document.getElementById('recover-form').style.display = 'none';
    hideError();
  }

  // listen for clicks on the login tabs to swap the tab and form
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      showTab(tab.dataset.tab);
    });
  });

  // Switch to registration page if an invite link is detected.
  if (_pendingInvite) {
    showTab('register');
  }

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.style.display = 'block';
  }

  function hideError() {
    errorEl.style.display = 'none';
  }

  // ── Admin Recovery ────────────────────────────────────
  document.getElementById('admin-recover-show').addEventListener('click', (e) => {
    e.preventDefault();
    document.querySelector('.auth-recovery-links').style.display = 'none';
    document.getElementById('admin-recover-section').style.display = '';
  });

  document.addEventListener('click', async (e) => {
    if (e.target.id !== 'admin-recover-btn') return;
    hideError();
    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value;
    if (!username || !password) return showError(t('auth.errors.enter_admin_credentials'));
    try {
      const res = await fetch('/api/auth/admin-recover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const data = await res.json();
      if (!res.ok) return showError(data.error || t('auth.errors.recovery_failed'));
      const e2eWrap = await deriveE2EWrappingKey(password);
      sessionStorage.setItem('haven_e2e_wrap', e2eWrap);
      localStorage.setItem('haven_token', data.token);
      localStorage.setItem('haven_user', JSON.stringify(data.user));
      window.location.href = _appUrl;
    } catch {
      showError(t('auth.errors.connection_error'));
    }
  });

  // ── Forgot Password / Account Recovery ───────────────
  const recoverForm = document.getElementById('recover-form');

  function showRecoverForm() {
    loginForm.style.display = 'none';
    registerForm.style.display = 'none';
    if (ssoForm) ssoForm.style.display = 'none';
    totpForm.style.display = 'none';
    recoverForm.style.display = 'flex';
    document.querySelector('.auth-tabs').style.display = 'none';
    hideError();
  }

  function hideRecoverForm() {
    recoverForm.style.display = 'none';
    loginForm.style.display = 'flex';
    document.querySelector('.auth-tabs').style.display = 'flex';
    const recoveryLinks = document.querySelector('.auth-recovery-links');
    if (recoveryLinks) recoveryLinks.style.display = '';
    hideError();
  }

  document.getElementById('forgot-password-show').addEventListener('click', (e) => {
    e.preventDefault();
    showRecoverForm();
  });

  document.getElementById('recover-back-btn').addEventListener('click', (e) => {
    e.preventDefault();
    hideRecoverForm();
  });

  recoverForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideError();
    const username = document.getElementById('recover-username').value.trim();
    const code = document.getElementById('recover-code').value.trim().toUpperCase();
    const newPassword = document.getElementById('recover-new-password').value;
    const confirmPassword = document.getElementById('recover-confirm-password').value;
    if (!username || !code || !newPassword || !confirmPassword) return showError(t('auth.errors.all_fields_required'));
    if (newPassword.length < 8) return showError(t('auth.errors.password_too_short'));
    if (newPassword !== confirmPassword) return showError(t('auth.errors.passwords_no_match'));
    try {
      const res = await fetch('/api/auth/recover-account', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, code, newPassword })
      });
      const data = await res.json();
      if (!res.ok) return showError(data.error || t('auth.errors.recovery_failed'));
      // Success — go back to login with a success message
      hideRecoverForm();
      showError(t('auth.errors.password_reset_success'));
      document.getElementById('auth-error').style.color = 'var(--success, #2ecc71)';
      document.getElementById('login-username').value = username;
    } catch {
      showError(t('auth.errors.connection_error'));
    }
  });

  // ── Login ─────────────────────────────────────────────
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideError();
    if (!checkEula()) return;

    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value;

    if (!username || !password) return showError(t('auth.errors.fill_all_fields'));

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, eulaVersion: '2.0', ageVerified: true })
      });

      const data = await res.json();
      if (!res.ok) {
        // ── Banned: offer an appeal instead of a dead-end error (#5457) ──
        if (data.banned) {
          showBanAppeal(username, password, data.reason);
          return;
        }
        return showError(data.error || t('auth.errors.login_failed'));
      }

      // ── TOTP challenge ──
      if (data.requiresTOTP) {
        _pendingChallenge = { challengeToken: data.challengeToken, password };
        showTotpForm();
        return;
      }

      // ── Forced change-password after admin reset (#5300) ──
      if (data.mustChangePassword) {
        _pendingForcedChange = { token: data.token, user: data.user, originalPassword: password };
        showForcedChangeForm();
        return;
      }

      // Derive E2E wrapping key from password (client-side only, never sent to server)
      const e2eWrap = await deriveE2EWrappingKey(password);
      sessionStorage.setItem('haven_e2e_wrap', e2eWrap);

      localStorage.setItem('haven_token', data.token);
      localStorage.setItem('haven_user', JSON.stringify(data.user));
      localStorage.setItem('haven_eula_accepted', '2.0');
      window.location.href = _appUrl;
    } catch (err) {
      showError(t('auth.errors.connection_error'));
    }
  });

  // ── Ban appeal submit (#5457) ─────────────────────────
  banAppealForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideError();
    if (!_pendingBanAppeal) return showError(t('auth.errors.session_expired'));
    const appeal = document.getElementById('ban-appeal-text').value.trim();
    if (!appeal) return showError(t('auth.ban_appeal.errors.empty'));
    try {
      const res = await fetch('/api/auth/ban-appeal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: _pendingBanAppeal.username,
          password: _pendingBanAppeal.password,
          appeal
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return showError(data.error || t('auth.ban_appeal.errors.failed'));
      _pendingBanAppeal = null;
      document.getElementById('ban-appeal-text').value = '';
      document.getElementById('ban-appeal-text').disabled = true;
      showError(t('auth.ban_appeal.submitted'));
      errorEl.style.color = 'var(--success, #2ecc71)';
    } catch (err) {
      showError(t('auth.errors.connection_error'));
    }
  });

  document.getElementById('ban-appeal-back-btn').addEventListener('click', (e) => {
    e.preventDefault();
    _pendingBanAppeal = null;
    banAppealForm.style.display = 'none';
    document.getElementById('ban-appeal-text').disabled = false;
    loginForm.style.display = 'flex';
    document.querySelector('.auth-tabs').style.display = 'flex';
    errorEl.style.color = '';
    hideError();
  });

  // ── TOTP verification ────────────────────────────────
  totpForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideError();
    if (!_pendingChallenge) return showError(t('auth.errors.session_expired'));

    const code = document.getElementById('totp-code').value.trim();
    if (!code) return showError(t('auth.errors.enter_auth_code'));

    try {
      const res = await fetch('/api/auth/totp/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challengeToken: _pendingChallenge.challengeToken, code })
      });

      const data = await res.json();
      if (!res.ok) return showError(data.error || t('auth.errors.verification_failed'));

      // ── Forced change-password after admin reset (#5300) ──
      if (data.mustChangePassword) {
        _pendingForcedChange = { token: data.token, user: data.user, originalPassword: _pendingChallenge.password };
        _pendingChallenge = null;
        showForcedChangeForm();
        return;
      }

      // Derive E2E wrapping key from the original password
      const e2eWrap = await deriveE2EWrappingKey(_pendingChallenge.password);
      sessionStorage.setItem('haven_e2e_wrap', e2eWrap);

      localStorage.setItem('haven_token', data.token);
      localStorage.setItem('haven_user', JSON.stringify(data.user));
      localStorage.setItem('haven_eula_accepted', '2.0');
      _pendingChallenge = null;
      window.location.href = _appUrl;
    } catch (err) {
      showError(t('auth.errors.connection_error'));
    }
  });

  // Toggle between TOTP code and backup code mode
  const totpCodeInput = document.getElementById('totp-code');
  const backupToggle = document.getElementById('totp-use-backup');
  let _backupMode = false;
  if (backupToggle) {
    backupToggle.addEventListener('click', (e) => {
      e.preventDefault();
      _backupMode = !_backupMode;
      if (_backupMode) {
        totpCodeInput.placeholder = 'XXXX-XXXX';
        totpCodeInput.maxLength = 9;
        totpCodeInput.inputMode = 'text';
        totpCodeInput.removeAttribute('pattern');
        backupToggle.textContent = t('auth.totp.use_authenticator');
      } else {
        totpCodeInput.placeholder = '000000';
        totpCodeInput.maxLength = 6;
        totpCodeInput.inputMode = 'numeric';
        totpCodeInput.setAttribute('pattern', '[0-9]*');
        backupToggle.textContent = t('auth.totp.use_backup');
      }
      totpCodeInput.value = '';
      totpCodeInput.focus();
    });
  }

  // Back to login from TOTP form
  const totpBackBtn = document.getElementById('totp-back-btn');
  if (totpBackBtn) {
    totpBackBtn.addEventListener('click', (e) => {
      e.preventDefault();
      hideTotpForm();
    });
  }

  // ── Forced change-password after admin reset (#5300) ──
  // Two paths:
  //   • User remembers their original password, enters it in the recall
  //     section. Server clears the admin reset and the user signs in with
  //     their original password. We derive the E2E wrap key from THAT
  //     original password so existing DM history stays decryptable.
  //   • User just picks a new password. Server rotates password_hash.
  //     We derive a fresh E2E wrap key from the new password. Existing
  //     DM history is permanently unreadable on the client (warned about
  //     in the form copy).
  forcedChangeForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideError();
    if (!_pendingForcedChange) return showError(t('auth.errors.session_expired'));

    const newPw = document.getElementById('forced-new-password').value;
    const confirmPw = document.getElementById('forced-confirm-password').value;
    const oldPw = document.getElementById('forced-old-password').value;
    const useRecall = !!oldPw;

    if (!useRecall) {
      if (!newPw || newPw.length < 8) return showError(t('auth.forced_change.errors.too_short') || 'New password must be at least 8 characters');
      if (newPw !== confirmPw) return showError(t('auth.forced_change.errors.mismatch') || 'New passwords do not match');
    }

    try {
      const body = useRecall ? { oldPassword: oldPw }
                             : { newPassword: newPw };
      const res = await fetch('/api/auth/change-password-required', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${_pendingForcedChange.token}` },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      if (!res.ok) {
        if (data.code === 'old_password_invalid') {
          return showError(t('auth.forced_change.errors.old_invalid') || 'Original password did not match');
        }
        return showError(data.error || t('auth.errors.connection_error'));
      }

      // Derive wrap key from whichever password the account is now using.
      // preserved=true means password_hash was untouched, so the original
      // password remains the wrap key source. preserved=false means the
      // new password is now the wrap key source (DMs unrecoverable).
      const wrapSource = data.preserved ? oldPw : newPw;
      const e2eWrap = await deriveE2EWrappingKey(wrapSource);
      sessionStorage.setItem('haven_e2e_wrap', e2eWrap);

      localStorage.setItem('haven_token', data.token);
      localStorage.setItem('haven_user', JSON.stringify(data.user));
      localStorage.setItem('haven_eula_accepted', '2.0');
      _pendingForcedChange = null;
      window.location.href = _appUrl;
    } catch (err) {
      showError(t('auth.errors.connection_error'));
    }
  });

  // ── SSO (Link Server) ──────────────────────────────────
  if (ssoForm) {
    // Populate the recent-servers datalist from localStorage
    try {
      const servers = JSON.parse(localStorage.getItem('haven_servers') || '[]');
      const datalist = document.getElementById('sso-recent-servers');
      if (datalist && Array.isArray(servers)) {
        for (const s of servers) {
          if (s.url) {
            const opt = document.createElement('option');
            opt.value = s.url;
            if (s.name) opt.label = s.name;
            datalist.appendChild(opt);
          }
        }
      }
    } catch { /* ignore */ }

    let ssoAuthCode = null;
    let ssoServerUrl = null;
    let ssoProfileData = null;
    let ssoWaiting = false;
    let ssoPollTimer = null;
    let ssoTimeoutTimer = null;

    const ssoConnectBtn   = document.getElementById('sso-connect-btn');
    const ssoStepServer   = document.getElementById('sso-step-server');
    const ssoStepRegister = document.getElementById('sso-step-register');
    const ssoPreviewAvatar   = document.getElementById('sso-preview-avatar');
    const ssoPreviewUsername = document.getElementById('sso-preview-username');
    const ssoRegisterBtn  = document.getElementById('sso-register-btn');
    const ssoBackBtn      = document.getElementById('sso-back-btn');
    const ssoServerInput  = document.getElementById('sso-server-url');

    const stopSsoPolling = () => {
      if (ssoPollTimer) {
        clearInterval(ssoPollTimer);
        ssoPollTimer = null;
      }
      if (ssoTimeoutTimer) {
        clearTimeout(ssoTimeoutTimer);
        ssoTimeoutTimer = null;
      }
    };

    const getSsoOrigin = () => {
      try { return new URL(ssoServerUrl).origin; } catch { return ssoServerUrl; }
    };

    const applySsoProfile = (profile, sourceOrigin = null) => {
      if (!profile) return;
      ssoProfileData = profile;
      ssoWaiting = false;
      stopSsoPolling();
      ssoConnectBtn.textContent = 'Connect';
      ssoConnectBtn.disabled = false;

      const profileUsername = (typeof ssoProfileData.username === 'string' ? ssoProfileData.username.trim() : '');
      const previewName = (typeof ssoProfileData.displayName === 'string' ? ssoProfileData.displayName.trim() : '') || profileUsername;

      if (ssoProfileData.profilePicture) {
        let src = ssoProfileData.profilePicture;
        if (src.startsWith('/')) {
          const base = sourceOrigin || getSsoOrigin();
          src = base + src;
        }
        ssoPreviewAvatar.innerHTML = `<img src="${src}" style="width:100%;height:100%;object-fit:cover" alt="">`;
      } else {
        ssoPreviewAvatar.textContent = (previewName || '?')[0].toUpperCase();
      }
      ssoPreviewUsername.textContent = previewName || '—';

      ssoStepServer.style.display = 'none';
      ssoStepRegister.style.display = '';
      hideError();
    };

    const tryFetchSsoProfile = async (surfaceError = false) => {
      if (!ssoWaiting || !ssoAuthCode || !ssoServerUrl) return false;
      try {
        const res = await fetch(`${ssoServerUrl}/api/auth/SSO/authenticate?authCode=${encodeURIComponent(ssoAuthCode)}`);
        if (!res.ok) {
          if (surfaceError && res.status !== 404) {
            const data = await res.json().catch(() => ({}));
            showError(data.error || 'SSO failed — please try again');
          }
          return false;
        }
        const data = await res.json();
        applySsoProfile(data, getSsoOrigin());
        return true;
      } catch {
        if (surfaceError) showError('Could not reach home server — please try again');
        return false;
      }
    };

    function ssoReset() {
      stopSsoPolling();
      ssoAuthCode = null;
      ssoServerUrl = null;
      ssoProfileData = null;
      ssoWaiting = false;
      ssoStepServer.style.display = '';
      ssoStepRegister.style.display = 'none';
      ssoPreviewAvatar.innerHTML = '?';
      ssoPreviewUsername.textContent = '—';
      document.getElementById('sso-password').value = '';
      document.getElementById('sso-confirm').value = '';
      hideError();
    }

    // Step 1 — Connect to home server
    ssoConnectBtn.addEventListener('click', () => {
      hideError();
      let raw = ssoServerInput.value.trim();
      if (!raw) return showError('Enter the address of your Haven server');

      // Normalise the URL
      raw = raw.replace(/\/+$/, '');
      if (!/^https?:\/\//i.test(raw)) {
        raw = (raw.startsWith('localhost') || raw.startsWith('127.0.0.1'))
          ? 'http://' + raw
          : 'https://' + raw;
      }
      ssoServerUrl = raw;

      // Generate a cryptographically secure auth code
      const bytes = new Uint8Array(32);
      crypto.getRandomValues(bytes);
      ssoAuthCode = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');

      // Open the consent page on the home server in a new tab
      const consentUrl = `${ssoServerUrl}/api/auth/SSO?authCode=${encodeURIComponent(ssoAuthCode)}&origin=${encodeURIComponent(window.location.origin)}`;
      window.open(consentUrl, '_blank');

      ssoWaiting = true;
      ssoConnectBtn.textContent = 'Waiting for approval…';
      ssoConnectBtn.disabled = true;

      stopSsoPolling();
      ssoPollTimer = setInterval(() => {
        tryFetchSsoProfile(false);
      }, 2000);
      ssoTimeoutTimer = setTimeout(() => {
        if (!ssoWaiting) return;
        ssoWaiting = false;
        stopSsoPolling();
        ssoConnectBtn.textContent = 'Connect';
        ssoConnectBtn.disabled = false;
        showError('SSO approval timed out — try connecting again');
      }, 90000);
    });

    // When user returns to this tab after approving on home server
    window.addEventListener('focus', async () => {
      if (!ssoWaiting || !ssoAuthCode || !ssoServerUrl) return;
      await tryFetchSsoProfile(true);
    });

    // Preferred path: SSO popup posts profile data back to this window.
    window.addEventListener('message', (event) => {
      if (!ssoWaiting || !ssoAuthCode || !ssoServerUrl) return;
      const data = event.data || {};
      if (data.type !== 'haven-sso-approved') return;
      if (data.authCode !== ssoAuthCode) return;

      const expectedOrigin = getSsoOrigin();
      if (event.origin !== expectedOrigin) return;

      if (!data.profile || !data.profile.username) return;
      applySsoProfile(data.profile, data.serverOrigin || expectedOrigin);
    });

    // Back button — return to step 1
    ssoBackBtn.addEventListener('click', (e) => {
      e.preventDefault();
      ssoReset();
    });

    // Step 2 — Register with imported profile
    ssoRegisterBtn.addEventListener('click', async () => {
      hideError();
      if (!checkEula()) return;
      if (!ssoProfileData) return showError('Please connect to your home server first');

      const password = document.getElementById('sso-password').value;
      const confirm  = document.getElementById('sso-confirm').value;

      if (!password || !confirm) return showError(t('auth.errors.fill_all_fields'));
      if (password.length < 8) return showError(t('auth.errors.password_too_short'));
      if (password !== confirm) return showError(t('auth.errors.passwords_no_match'));

      // Prefer canonical username from SSO payload. If a legacy server sends
      // display-name-like values, normalize into a valid Haven username.
      const normalizeUsername = (value) => {
        if (typeof value !== 'string') return '';
        return value
          .trim()
          .replace(/[^a-zA-Z0-9_]/g, '_')
          .replace(/_+/g, '_')
          .replace(/^_+|_+$/g, '')
          .slice(0, 20);
      };
      let registerUsername = normalizeUsername(ssoProfileData.username);
      if (registerUsername.length < 3) {
        registerUsername = normalizeUsername(ssoProfileData.displayName);
      }
      if (registerUsername.length < 3) {
        return showError('SSO username is invalid. Please use standard registration.');
      }

      // Build the full profile picture URL for the server to download
      let profilePicUrl = ssoProfileData.profilePicture || null;
      if (profilePicUrl && profilePicUrl.startsWith('/')) {
        profilePicUrl = ssoServerUrl + profilePicUrl;
      }

      const ssoCaptchaToken = _captchaTokenFor('sso');
      if (ssoCaptchaToken === '') return showError(t('auth.errors.captcha_incomplete'));

      try {
        const res = await fetch('/api/auth/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: registerUsername,
            password,
            eulaVersion: '2.0',
            ageVerified: true,
            ssoProfilePicture: profilePicUrl,
            // (#5344) Reuse the same token field the standard form uses;
            // when the server requires a token the user will have already
            // typed it in the visible field.
            registrationToken: (document.getElementById('reg-token')?.value || '').trim(),
            captchaToken: ssoCaptchaToken || ''
          })
        });

        const data = await res.json();
        if (!res.ok) { _resetCaptcha('sso'); return showError(data.error || t('auth.errors.registration_failed')); }

        // Derive E2E wrapping key from password
        const e2eWrap = await deriveE2EWrappingKey(password);
        sessionStorage.setItem('haven_e2e_wrap', e2eWrap);

        localStorage.setItem('haven_token', data.token);
        localStorage.setItem('haven_user', JSON.stringify(data.user));
        localStorage.setItem('haven_eula_accepted', '2.0');
        window.location.href = _appUrl;
      } catch (err) {
        showError(t('auth.errors.connection_error'));
      }
    });
  }

  // ── Opt-in Turnstile CAPTCHA on registration ──────────
  // Rendered only when the server reports it enabled. Two widgets: one for the
  // standard register form, one for the SSO register step (both hit the same
  // /register endpoint, which enforces the challenge server-side).
  let _captchaSiteKey = '';
  let _turnstileMain = null;
  let _turnstileSso = null;

  function _loadTurnstileScript() {
    return new Promise((resolve, reject) => {
      if (window.turnstile) return resolve();
      let s = document.getElementById('cf-turnstile-script');
      if (s) { s.addEventListener('load', () => resolve()); s.addEventListener('error', () => reject(new Error('load failed'))); return; }
      s = document.createElement('script');
      s.id = 'cf-turnstile-script';
      s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      s.async = true; s.defer = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('load failed'));
      document.head.appendChild(s);
    });
  }

  async function _initRegistrationCaptcha(siteKey) {
    _captchaSiteKey = siteKey;
    try { await _loadTurnstileScript(); } catch { return; }
    if (!window.turnstile) return;
    const mainBox = document.getElementById('reg-captcha');
    if (mainBox && _turnstileMain === null) {
      const g = document.getElementById('reg-captcha-group'); if (g) g.style.display = '';
      _turnstileMain = window.turnstile.render(mainBox, { sitekey: siteKey, theme: 'auto' });
    }
    const ssoBox = document.getElementById('sso-captcha');
    if (ssoBox && _turnstileSso === null) {
      const g = document.getElementById('sso-captcha-group'); if (g) g.style.display = '';
      _turnstileSso = window.turnstile.render(ssoBox, { sitekey: siteKey, theme: 'auto' });
    }
  }

  // null  = captcha not active (skip it);
  // ''    = active but the user hasn't solved it yet (block submit);
  // token = solved (send it).
  function _captchaTokenFor(which) {
    if (!_captchaSiteKey || !window.turnstile) return null;
    const id = which === 'sso' ? _turnstileSso : _turnstileMain;
    if (id === null || id === undefined) return null;
    return window.turnstile.getResponse(id) || '';
  }
  function _resetCaptcha(which) {
    if (!window.turnstile) return;
    const id = which === 'sso' ? _turnstileSso : _turnstileMain;
    if (id !== null && id !== undefined) { try { window.turnstile.reset(id); } catch { /* noop */ } }
  }

  // ── Register ──────────────────────────────────────────
  // (#5344) If the server requires a registration token, reveal the
  // token field. Best-effort fetch — if it fails we just leave the
  // field hidden and the server will reject without the token.
  // field is also hidden if an invite link is used and is allowed to override the token requirement.
  async function  _initRegistrationForm() {
    try {
      const r = await fetch('/api/auth/registration-info');
      if (!r.ok) return;
      const info = await r.json();
      if (info && info.requiresToken && (!_pendingInvite || info.invitesBypassToken)) {
        const grp = document.getElementById('reg-token-group');
        const inp = document.getElementById('reg-token');
        if (grp) grp.style.display = '';
        if (inp) inp.required = true;
      }
      if (info && info.captchaEnabled && info.turnstileSiteKey) {
        _initRegistrationCaptcha(info.turnstileSiteKey);
      }
    } catch { /* ignore */ }
  }
  _initRegistrationForm();

  registerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideError();
    if (!checkEula()) return;

    const username = document.getElementById('reg-username').value.trim();
    const password = document.getElementById('reg-password').value;
    const confirm = document.getElementById('reg-confirm').value;
    const tokenInput = document.getElementById('reg-token');
    const registrationToken = tokenInput ? tokenInput.value.trim() : '';

    if (!username || !password || !confirm) return showError(t('auth.errors.fill_all_fields'));
    if (password !== confirm) return showError(t('auth.errors.passwords_no_match'));
    if (password.length < 8) return showError(t('auth.errors.password_too_short'));

    const captchaToken = _captchaTokenFor('main');
    if (captchaToken === '') return showError(t('auth.errors.captcha_incomplete'));

    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, eulaVersion: '2.0', ageVerified: true, registrationToken, inviteCode: _pendingInvite, captchaToken: captchaToken || ''})
      });

      const data = await res.json();
      if (!res.ok) {
        _resetCaptcha('main');

        const error = data.error || t('auth.errors.registration_failed');

        // if registration error is due to an invalid invite link, display the invite error and show the registration key field if required.
        // This allows the user to attempt registration again, with the registration code, or a new invitation link.
        if (error.toLowerCase().includes('invite link')) {
          sessionStorage.removeItem('haven_pending_invite');
          _pendingInvite = '';
          
          const url = new URL(window.location.href);
          url.searchParams.delete('invite');
          window.history.replaceState({}, '', url.pathname + url.search + url.hash);
          _appUrl = _buildAppUrl();

          await _initRegistrationForm();
        }
        
        showError(error);
        return;
      }

      // Derive E2E wrapping key from password (client-side only, never sent to server)
      const e2eWrap = await deriveE2EWrappingKey(password);
      sessionStorage.setItem('haven_e2e_wrap', e2eWrap);

      localStorage.setItem('haven_token', data.token);
      localStorage.setItem('haven_user', JSON.stringify(data.user));
      localStorage.setItem('haven_eula_accepted', '2.0');
      window.location.href = _appUrl;
    } catch (err) {
      showError(t('auth.errors.connection_error'));
    }
  });

  // ── (#5381) Join as Guest ────────────────────────────────
  // Reveal the guest button only if the server has guests enabled.
  (async () => {
    try {
      const r = await fetch('/api/auth/guest-info');
      if (!r.ok) return;
      const info = await r.json();
      if (info && info.guestsEnabled) {
        const sec = document.getElementById('guest-login-section');
        if (sec) sec.style.display = '';
      }
    } catch { /* ignore */ }
  })();

  // ── (#12) SSO button — only when the server reports OIDC usable ──
  (async () => {
    try {
      const r = await fetch('/api/public-config');
      if (!r.ok) return;
      const cfg = await r.json();
      if (!cfg || !cfg.oidc_enabled) return;
      const sec = document.getElementById('oidc-login-section');
      const btn = document.getElementById('oidc-login-btn');
      if (btn && cfg.oidc_button_label) btn.textContent = cfg.oidc_button_label;
      if (sec) sec.style.display = '';
    } catch { /* ignore */ }
  })();

  const guestShowBtn = document.getElementById('guest-login-show-btn');
  const guestForm = document.getElementById('guest-form');
  const guestBackBtn = document.getElementById('guest-back-btn');
  // loginForm is already declared at the top of this IIFE (see line ~152).
  // Re-declaring with `const` here was a fatal SyntaxError that blanked the
  // entire login page (#5399 follow-up); reuse the outer binding.
  if (guestShowBtn && guestForm) {
    guestShowBtn.addEventListener('click', () => {
      hideError();
      if (loginForm) loginForm.style.display = 'none';
      if (registerForm) registerForm.style.display = 'none';
      const ssoForm = document.getElementById('sso-form');
      if (ssoForm) ssoForm.style.display = 'none';
      guestForm.style.display = '';
      const u = document.getElementById('guest-username');
      if (u) u.focus();
    });
  }
  if (guestBackBtn) {
    guestBackBtn.addEventListener('click', (e) => {
      e.preventDefault();
      hideError();
      if (guestForm) guestForm.style.display = 'none';
      if (loginForm) loginForm.style.display = '';
    });
  }
  if (guestForm) {
    guestForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      hideError();
      if (!checkEula()) return;
      const username = document.getElementById('guest-username').value.trim();
      if (!username) return showError('Please enter a username');
      try {
        const res = await fetch('/api/auth/guest-login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, eulaVersion: '2.0', ageVerified: true })
        });
        const data = await res.json();
        if (!res.ok) return showError(data.error || 'Guest login failed');
        // Guests have no password, so no E2E wrap key. DM tab is hidden
        // for them on the app side.
        localStorage.setItem('haven_token', data.token);
        localStorage.setItem('haven_user', JSON.stringify(data.user));
        localStorage.setItem('haven_eula_accepted', '2.0');
        sessionStorage.removeItem('haven_e2e_wrap');
        window.location.href = _appUrl;
      } catch {
        showError(t('auth.errors.connection_error'));
      }
    });
  }

  /* ── SSO / OIDC (#12) ─────────────────────────────────
     Two halves. The button just leaves for the provider. Coming back, the
     server has already handed us a session, and the only thing left is the
     encryption passphrase: an SSO user types no password into Haven, so
     there is nothing to derive the private-key wrapping key from. We ask for
     a passphrase, stretch it exactly like a password (same PBKDF2 salt and
     iteration count), and drop the result into the same sessionStorage slot
     the password path uses — so everything downstream is unchanged. */

  const OIDC_ERRORS = {
    cancelled: 'Sign-in was cancelled.',
    disabled: 'SSO is not enabled on this server.',
    no_account: 'No Haven account is linked to that sign-in, and this server does not create them automatically.',
    banned: 'That account is banned from this server.',
    expired: 'That sign-in took too long. Please try again.',
    provider_unreachable: 'Could not reach the SSO provider. Ask your admin to check the server settings.',
  };
  if (_oidcError) showError(OIDC_ERRORS[_oidcError] || 'SSO sign-in failed. Please try again.');

  const oidcBtn = document.getElementById('oidc-login-btn');
  if (oidcBtn) {
    oidcBtn.addEventListener('click', () => {
      oidcBtn.disabled = true;
      window.location.href = '/api/auth/oidc/start';
    });
  }

  if (_oidcHandoff && _oidcHandoff.token) {
    const passForm = document.getElementById('e2e-pass-form');
    const passInput = document.getElementById('e2e-pass-input');
    const confirmGroup = document.getElementById('e2e-pass-confirm-group');
    const confirmInput = document.getElementById('e2e-pass-confirm');
    const titleEl = document.getElementById('e2e-pass-title');
    const blurbEl = document.getElementById('e2e-pass-blurb');
    const hintEl = document.getElementById('e2e-pass-hint');

    const finish = (wrapKey) => {
      if (wrapKey) sessionStorage.setItem('haven_e2e_wrap', wrapKey);
      else sessionStorage.removeItem('haven_e2e_wrap');
      localStorage.setItem('haven_token', _oidcHandoff.token);
      localStorage.setItem('haven_user', JSON.stringify(_oidcHandoff.user));
      window.location.href = _appUrl;
    };

    // Hide every other form and show the passphrase step.
    document.querySelectorAll('.auth-form').forEach(f => { f.style.display = 'none'; });
    document.querySelector('.auth-tabs')?.style.setProperty('display', 'none');
    passForm.style.display = 'block';

    // Returning on a second device: the key already exists on the server, so
    // this is an unlock, not a setup. No confirm field, different wording.
    if (_oidcHandoff.e2eReady) {
      titleEl.textContent = 'Enter your encryption passphrase';
      blurbEl.textContent = 'This device needs the passphrase you set when you first signed in, to unlock your private messages.';
      hintEl.textContent = 'Wrong passphrase? Your other devices keep working — nothing is overwritten.';
      confirmGroup.style.display = 'none';
      confirmInput.removeAttribute('required');
      passInput.setAttribute('autocomplete', 'current-password');
    }

    passForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      hideError();
      const pass = passInput.value;
      if (!pass || pass.length < 8) return showError('Passphrase must be at least 8 characters.');
      if (!_oidcHandoff.e2eReady && pass !== confirmInput.value) {
        return showError('The two passphrases do not match.');
      }
      // Only the derived key is kept. The passphrase itself never leaves this
      // function, and never goes to the server in any form.
      finish(await deriveE2EWrappingKey(pass));
    });

    document.getElementById('e2e-pass-skip').addEventListener('click', (ev) => {
      ev.preventDefault();
      // Same state as any auto-login without a password: the app runs, and DMs
      // stay locked on this device until the passphrase is supplied. Nothing
      // is generated or overwritten, so no history is lost by skipping.
      finish(null);
    });
  }
})();
