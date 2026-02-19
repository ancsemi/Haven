// ── Auth Page Logic (with theme support) ─────────────────

(function () {
  // If already logged in, redirect to app
  if (localStorage.getItem('haven_token')) {
    window.location.href = '/app';
    return;
  }

  // ── Theme switching ───────────────────────────────────
  initThemeSwitcher('auth-theme-bar');

  // ── Fetch and display server version ──────────────────
  fetch('/api/version').then(r => r.json()).then(d => {
    const el = document.getElementById('auth-version');
    if (el && d.version) el.textContent = 'v' + d.version;
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
      showError('You must confirm that you are 18 years of age or older');
      return false;
    }
    if (!eulaCheckbox.checked) {
      showError('You must accept the Terms of Service & Release of Liability Agreement');
      return false;
    }
    return true;
  }

  // ── Tab switching ─────────────────────────────────────
  const tabs = document.querySelectorAll('.auth-tab');
  const loginForm = document.getElementById('login-form');
  const registerForm = document.getElementById('register-form');
  const errorEl = document.getElementById('auth-error');

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      const target = tab.dataset.tab;
      loginForm.style.display = target === 'login' ? 'flex' : 'none';
      registerForm.style.display = target === 'register' ? 'flex' : 'none';
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

  // ── Login ─────────────────────────────────────────────
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideError();
    if (!checkEula()) return;

    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value;

    if (!username || !password) return showError('Fill in all fields');

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, eulaVersion: '2.0', ageVerified: true })
      });

      const data = await res.json();
      if (!res.ok) return showError(data.error || 'Login failed');

      localStorage.setItem('haven_token', data.token);
      localStorage.setItem('haven_user', JSON.stringify(data.user));
      localStorage.setItem('haven_eula_accepted', '2.0');
      // e2eSecret is included in data.user and stored in haven_user automatically
      sessionStorage.setItem('haven_e2e_pw', password); // password fallback for one-time migration of old keys
      window.location.href = '/app';
    } catch (err) {
      showError('Connection error — is the server running?');
    }
  });

  // ── Register ──────────────────────────────────────────
  registerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideError();
    if (!checkEula()) return;

    const username = document.getElementById('reg-username').value.trim();
    const password = document.getElementById('reg-password').value;
    const confirm = document.getElementById('reg-confirm').value;

    if (!username || !password || !confirm) return showError('Fill in all fields');
    if (password !== confirm) return showError('Passwords do not match');
    if (password.length < 6) return showError('Password must be at least 6 characters');

    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, eulaVersion: '2.0', ageVerified: true })
      });

      const data = await res.json();
      if (!res.ok) return showError(data.error || 'Registration failed');

      localStorage.setItem('haven_token', data.token);
      localStorage.setItem('haven_user', JSON.stringify(data.user));
      localStorage.setItem('haven_eula_accepted', '2.0');
      // e2eSecret is included in data.user and stored in haven_user automatically
      window.location.href = '/app';
    } catch (err) {
      showError('Connection error — is the server running?');
    }
  });
})();
