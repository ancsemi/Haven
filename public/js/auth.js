// ── Auth Page Logic (with theme support + i18n) ───────────────────────────

(async function () {
  // Preserve invite param across login/register so vanity invite links work for new users
  const _urlParams = new URLSearchParams(window.location.search);
  const _pendingInvite = _urlParams.get('invite') || sessionStorage.getItem('haven_pending_invite') || '';
  if (_pendingInvite) sessionStorage.setItem('haven_pending_invite', _pendingInvite);
  // Preserve channel/message deep-link params (?channel=CODE&message=ID) too
  const _pendingChannel = _urlParams.get('channel') || sessionStorage.getItem('haven_pending_channel') || '';
  const _pendingMessage = _urlParams.get('message') || sessionStorage.getItem('haven_pending_message') || '';
  if (_pendingChannel) sessionStorage.setItem('haven_pending_channel', _pendingChannel);
  if (_pendingMessage) sessionStorage.setItem('haven_pending_message', _pendingMessage);

  const _appQuery = (() => {
    const parts = [];
    if (_pendingInvite) parts.push('invite=' + encodeURIComponent(_pendingInvite));
    if (_pendingChannel) parts.push('channel=' + encodeURIComponent(_pendingChannel));
    if (_pendingMessage) parts.push('message=' + encodeURIComponent(_pendingMessage));
    return parts.length ? '?' + parts.join('&') : '';
  })();
  const _appUrl = '/app' + _appQuery;

  // If already logged in, redirect to app
  if (localStorage.getItem('haven_token')) {
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
  const errorEl = document.getElementById('auth-error');

  // Pending TOTP challenge state (set after successful password auth)
  let _pendingChallenge = null; // { challengeToken, password }

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

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      const target = tab.dataset.tab;
      loginForm.style.display = target === 'login' ? 'flex' : 'none';
      registerForm.style.display = target === 'register' ? 'flex' : 'none';
      if (ssoForm) ssoForm.style.display = target === 'sso' ? 'flex' : 'none';
      totpForm.style.display = 'none';
      document.getElementById('recover-form').style.display = 'none';
      hideError();
    });
  });

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
      if (!res.ok) return showError(data.error || t('auth.errors.login_failed'));

      // ── TOTP challenge ──
      if (data.requiresTOTP) {
        _pendingChallenge = { challengeToken: data.challengeToken, password };
        showTotpForm();
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

      try {
        const res = await fetch('/api/auth/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: registerUsername,
            password,
            eulaVersion: '2.0',
            ageVerified: true,
            ssoProfilePicture: profilePicUrl
          })
        });

        const data = await res.json();
        if (!res.ok) return showError(data.error || t('auth.errors.registration_failed'));

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

  // ── Register ──────────────────────────────────────────
  registerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideError();
    if (!checkEula()) return;

    const username = document.getElementById('reg-username').value.trim();
    const password = document.getElementById('reg-password').value;
    const confirm = document.getElementById('reg-confirm').value;

    if (!username || !password || !confirm) return showError(t('auth.errors.fill_all_fields'));
    if (password !== confirm) return showError(t('auth.errors.passwords_no_match'));
    if (password.length < 8) return showError(t('auth.errors.password_too_short'));

    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, eulaVersion: '2.0', ageVerified: true })
      });

      const data = await res.json();
      if (!res.ok) return showError(data.error || t('auth.errors.registration_failed'));

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
})();
