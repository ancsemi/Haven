export default {

// ── Mark-Read Helper ──────────────────────────────────
// ═══════════════════════════════════════════════════════

_markRead(messageId) {
  if (!this.currentChannel || !messageId) return;
  // Debounce: don't spam the server
  clearTimeout(this._markReadTimer);
  this._markReadTimer = setTimeout(() => {
    this.socket.emit('mark-read', { code: this.currentChannel, messageId });
  }, 500);
},

// ── Update Checker ─────────────────────────────────────
async _checkForUpdates() {
  try {
    // Get local version from the server
    const localRes = await fetch('/api/version');
    if (!localRes.ok) return;
    const { version: localVersion } = await localRes.json();

    // Check GitHub for latest release
    const ghRes = await fetch('https://api.github.com/repos/ancsemi/Haven/releases/latest', {
      headers: { Accept: 'application/vnd.github.v3+json' }
    });
    if (!ghRes.ok) return;
    const release = await ghRes.json();

    const remoteVersion = (release.tag_name || '').replace(/^v/, '');
    if (!remoteVersion || !localVersion) return;

    if (this._isNewerVersion(remoteVersion, localVersion)) {
      // Cache the update info so visibility can be toggled without re-fetching
      const zipAsset = (release.assets || []).find(a => a.name && a.name.endsWith('.zip'));
      this._pendingUpdate = {
        text: `Update v${remoteVersion}`,
        title: `Haven v${remoteVersion} is available (you have v${localVersion}). Click to view.`,
        href: zipAsset ? zipAsset.browser_download_url : release.html_url
      };
      this._applyUpdateBanner();
    }
  } catch (e) {
    // Silently fail — update check is non-critical
  }

  // Re-check every 30 minutes
  setTimeout(() => this._checkForUpdates(), 30 * 60 * 1000);
},

/**
 * Show or hide the update banner based on cached update info and the
 * update_banner_admin_only server setting.
 */
_applyUpdateBanner() {
  const banner = document.getElementById('update-banner');
  if (!banner) return;
  if (!this._pendingUpdate) return; // no update detected yet

  const adminOnly = this.serverSettings?.update_banner_admin_only === 'true';
  const canSee = !adminOnly || this.user?.isAdmin;

  if (canSee) {
    banner.style.display = 'inline-flex';
    banner.querySelector('.update-text').textContent = this._pendingUpdate.text;
    banner.title = this._pendingUpdate.title;
    banner.href = this._pendingUpdate.href;
  } else {
    banner.style.display = 'none';
  }
},

/**
 * Compare semver strings. Returns true if remote > local.
 */
_isNewerVersion(remote, local) {
  const r = remote.split('.').map(Number);
  const l = local.split('.').map(Number);
  for (let i = 0; i < Math.max(r.length, l.length); i++) {
    const rv = r[i] || 0;
    const lv = l[i] || 0;
    if (rv > lv) return true;
    if (rv < lv) return false;
  }
  return false;
},

// ── Desktop App Banner + Promo Popup ────────────────────
/** Show the "Get the Desktop App" banner and promo popup unless the user
 *  dismissed them or is already running inside Haven Desktop (Electron). */
_initDesktopAppBanner() {
  // Don't show if already in the desktop app
  if (window.havenDesktop || navigator.userAgent.includes('Electron')) return;

  // ── Top-bar banner ──
  const bannerDismissed = localStorage.getItem('haven_desktop_banner_dismissed');
  if (!bannerDismissed) {
    const banner = document.getElementById('desktop-app-banner');
    if (banner) {
      banner.style.display = 'inline-flex';
      const dismissBtn = document.getElementById('desktop-app-dismiss');
      if (dismissBtn) {
        dismissBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          banner.style.display = 'none';
          localStorage.setItem('haven_desktop_banner_dismissed', '1');
        });
      }
    }
  }

  // ── Promo popup (centred modal) ──
  if (localStorage.getItem('haven_desktop_promo_dismissed')) return;

  const modal = document.getElementById('desktop-promo-modal');
  if (!modal) return;

  // Detect platform for meta line
  const meta = document.getElementById('desktop-promo-meta');
  if (meta) {
    const ua = navigator.userAgent.toLowerCase();
    let platform = 'Desktop';
    if (ua.includes('win')) platform = 'Windows Installer';
    else if (ua.includes('linux')) platform = 'Linux Installer';
    else if (ua.includes('mac')) platform = 'macOS Installer';
    meta.textContent = `${platform} \u2022 v1.0.0`;
  }

  // Show after a short delay so the app finishes loading first
  setTimeout(() => { modal.style.display = 'flex'; }, 1200);

  // "Maybe later" closes without remembering
  const laterBtn = document.getElementById('desktop-promo-later');
  if (laterBtn) {
    laterBtn.addEventListener('click', () => {
      const check = document.getElementById('desktop-promo-dismiss-check');
      if (check && check.checked) {
        localStorage.setItem('haven_desktop_promo_dismissed', '1');
        // Also dismiss the banner if they chose "don't show again"
        localStorage.setItem('haven_desktop_banner_dismissed', '1');
        const banner = document.getElementById('desktop-app-banner');
        if (banner) banner.style.display = 'none';
      }
      modal.style.display = 'none';
    });
  }

  // "Install Haven" link — if checkbox checked, remember dismissal
  const installBtn = document.getElementById('desktop-promo-install');
  if (installBtn) {
    installBtn.addEventListener('click', () => {
      const check = document.getElementById('desktop-promo-dismiss-check');
      if (check && check.checked) {
        localStorage.setItem('haven_desktop_promo_dismissed', '1');
        localStorage.setItem('haven_desktop_banner_dismissed', '1');
        const banner = document.getElementById('desktop-app-banner');
        if (banner) banner.style.display = 'none';
      }
      modal.style.display = 'none';
    });
  }

  // Close on overlay click
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      modal.style.display = 'none';
    }
  });
},

// ── Android Beta Banner + Sign-Up Popup ─────────────────
/** Show the "Android Beta" banner and sign-up popup. Users enter their email
 *  and a prefilled mailto: link sends the opt-in request to the developer. */
_initAndroidBetaBanner() {
  // ── v2 migration: clear stale v1 keys that permanently poisoned the UI ──
  if (!sessionStorage.getItem('_ab_v2_migrated')) {
    localStorage.removeItem('haven_android_beta_banner_dismissed');
    localStorage.removeItem('haven_android_beta_promo_dismissed');
    sessionStorage.setItem('_ab_v2_migrated', '1');
  }

  // ── Top-bar banner ──
  // Only permanently hidden if user checked "Don't show this again";
  // the X button is session-only so it returns on next visit.
  const permaDismissed = localStorage.getItem('haven_ab_banner_nodisplay');
  const sessionDismissed = sessionStorage.getItem('haven_ab_banner_session');
  if (!permaDismissed && !sessionDismissed) {
    const banner = document.getElementById('android-beta-banner');
    if (banner) {
      banner.style.display = 'inline-flex';
      banner.addEventListener('click', (e) => {
        // Don't open modal if dismiss button was clicked
        if (e.target.closest('.android-beta-dismiss')) return;
        const modal = document.getElementById('android-beta-modal');
        if (modal) modal.style.display = 'flex';
      });
      const dismissBtn = document.getElementById('android-beta-dismiss');
      if (dismissBtn) {
        dismissBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          banner.style.display = 'none';
          // Session-only: banner comes back on next page load
          sessionStorage.setItem('haven_ab_banner_session', '1');
        });
      }
    }
  }

  // ── Promo popup (centred modal) ──
  const modal = document.getElementById('android-beta-modal');
  if (!modal) return;

  // Show popup on first visit (unless dismissed)
  if (!localStorage.getItem('haven_ab_promo_nodisplay')) {
    setTimeout(() => {
      // Don't show if the desktop promo is already visible
      const desktopPromo = document.getElementById('desktop-promo-modal');
      if (desktopPromo && desktopPromo.style.display === 'flex') {
        // Show after the desktop promo closes
        const observer = new MutationObserver(() => {
          if (desktopPromo.style.display === 'none' || desktopPromo.style.display === '') {
            observer.disconnect();
            setTimeout(() => { modal.style.display = 'flex'; }, 800);
          }
        });
        observer.observe(desktopPromo, { attributes: true, attributeFilter: ['style'] });
      } else {
        modal.style.display = 'flex';
      }
    }, 2000);
  }

  // Close modal when user clicks the beta access link
  const submitBtn = document.getElementById('android-beta-submit');
  if (submitBtn) {
    submitBtn.addEventListener('click', () => {
      localStorage.setItem('haven_ab_promo_nodisplay', '1');
      modal.style.display = 'none';
    });
  }

  // "Maybe later" button
  const laterBtn = document.getElementById('android-beta-later');
  if (laterBtn) {
    laterBtn.addEventListener('click', () => {
      const check = document.getElementById('android-beta-dismiss-check');
      if (check && check.checked) {
        localStorage.setItem('haven_ab_promo_nodisplay', '1');
        localStorage.setItem('haven_ab_banner_nodisplay', '1');
        const banner = document.getElementById('android-beta-banner');
        if (banner) banner.style.display = 'none';
      }
      modal.style.display = 'none';
    });
  }

  // Close on overlay click
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.style.display = 'none';
  });
},

async _setupDesktopShortcuts() {
  if (!window.havenDesktop?.shortcuts) return;

  const keyMap = {
    ' ': 'Space', 'ArrowUp': 'Up', 'ArrowDown': 'Down',
    'ArrowLeft': 'Left', 'ArrowRight': 'Right',
    'Escape': 'Escape', 'Tab': 'Tab', 'Enter': 'Return',
    'Backspace': 'Backspace', 'Delete': 'Delete',
    'Home': 'Home', 'End': 'End', 'PageUp': 'PageUp', 'PageDown': 'PageDown',
  };

  const formatAccel = (accel) => {
    if (!accel) return '—';
    return accel.replace('CommandOrControl', 'Ctrl/Cmd').replace('Control', 'Ctrl');
  };

  let config = {};
  try { config = await window.havenDesktop.shortcuts.getConfig(); } catch (e) {}

  const actions = ['mute', 'deafen', 'ptt'];

  actions.forEach(action => {
    const keyEl     = document.getElementById(`shortcut-key-${action}`);
    const recordBtn = document.querySelector(`.shortcut-record-btn[data-action="${action}"]`);
    const clearBtn  = document.querySelector(`.shortcut-clear-btn[data-action="${action}"]`);
    if (!keyEl || !recordBtn || !clearBtn) return;

    keyEl.textContent = formatAccel(config[action] || '');

    recordBtn.addEventListener('click', () => {
      // Already recording — cancel
      if (recordBtn.classList.contains('recording')) {
        recordBtn.classList.remove('recording');
        recordBtn.textContent = 'Record';
        keyEl.classList.remove('recording-label');
        return;
      }
      recordBtn.classList.add('recording');
      recordBtn.textContent = 'Press key…';
      keyEl.classList.add('recording-label');
      keyEl.textContent = '…';

      const onKeyDown = async (e) => {
        e.preventDefault();
        e.stopPropagation();
        // Ignore lone modifiers
        if (['Control', 'Meta', 'Alt', 'Shift'].includes(e.key)) return;

        const parts = [];
        if (e.ctrlKey || e.metaKey) parts.push('CommandOrControl');
        if (e.altKey)  parts.push('Alt');
        if (e.shiftKey) parts.push('Shift');
        const mapped = keyMap[e.key] || (e.key.length === 1 ? e.key.toUpperCase() : e.key);
        parts.push(mapped);
        const accel = parts.join('+');

        document.removeEventListener('keydown', onKeyDown, true);
        recordBtn.classList.remove('recording');
        recordBtn.textContent = 'Record';
        keyEl.classList.remove('recording-label');

        try {
          await window.havenDesktop.shortcuts.setConfig({ [action]: accel });
          keyEl.textContent = formatAccel(accel);
        } catch (err) {
          keyEl.textContent = formatAccel(config[action] || '');
          this._showToast?.('Failed to register shortcut — it may already be in use.', 'error');
        }
      };

      document.addEventListener('keydown', onKeyDown, true);
    });

    clearBtn.addEventListener('click', async () => {
      try {
        await window.havenDesktop.shortcuts.setConfig({ [action]: '' });
        keyEl.textContent = '—';
      } catch (err) {}
    });
  });
},

/* ── Desktop App Preferences (start on login, tray, SDR) ── */

async _setupDesktopAppPrefs() {
  if (!window.havenDesktop?.prefs) return;
  if (this._desktopPrefsReady) return;
  this._desktopPrefsReady = true;

  let prefs = {};
  try { prefs = await window.havenDesktop.prefs.get(); } catch {}

  const startEl   = document.getElementById('pref-start-on-login');
  const trayEl    = document.getElementById('pref-minimize-to-tray');
  const sdrEl     = document.getElementById('pref-force-sdr');
  const versionEl = document.getElementById('desktop-version-info');

  if (startEl) { startEl.checked = !!prefs.startOnLogin; }
  if (trayEl)  { trayEl.checked  = !!prefs.minimizeToTray; }
  if (sdrEl)   { sdrEl.checked   = !!prefs.forceSDR; }

  // Show desktop version
  if (versionEl && window.havenDesktop.getVersion) {
    try {
      const v = await window.havenDesktop.getVersion();
      versionEl.textContent = `Haven Desktop v${v}`;
    } catch {}
  }

  startEl?.addEventListener('change', async () => {
    try { await window.havenDesktop.prefs.setStartOnLogin(startEl.checked); }
    catch { startEl.checked = !startEl.checked; }
  });

  trayEl?.addEventListener('change', async () => {
    try { await window.havenDesktop.prefs.setMinimizeToTray(trayEl.checked); }
    catch { trayEl.checked = !trayEl.checked; }
  });

  sdrEl?.addEventListener('change', async () => {
    try {
      const res = await window.havenDesktop.prefs.setForceSDR(sdrEl.checked);
      if (res?.requiresRestart) {
        this._showToast('Color profile updated. Restart Haven Desktop to apply.', 'info');
      }
    } catch { sdrEl.checked = !sdrEl.checked; }
  });
},

/* ── E2E Encryption Helpers ──────────────────────────── */

async _initE2E() {
  if (typeof HavenE2E === 'undefined') return;
  try {
    this.e2e = new HavenE2E();
    // Read the password-derived wrapping key from sessionStorage (set during login).
    // On auto-login (JWT, no password) this will be null — IndexedDB-only mode.
    const wrappingKey = sessionStorage.getItem('haven_e2e_wrap') || null;
    const ok = await this.e2e.init(this.socket, wrappingKey);
    // Keep wrapping key in memory for cross-device sync (conflict resolution).
    // Clear from sessionStorage but retain privately for backup restoration.
    if (wrappingKey) {
      this._e2eWrappingKey = wrappingKey;
      sessionStorage.removeItem('haven_e2e_wrap');
    }
    if (ok) {
      await this._e2eSetupListeners();
      // If keys were auto-reset during init (backup unwrap failed), notify
      if (this.e2e.keysWereReset) {
        setTimeout(() => {
          this._appendE2ENotice(`🔄 Encryption keys were regenerated — ${new Date().toLocaleString()}. Previous encrypted messages may no longer be decryptable.`);
        }, 500);
      }
    } else {
      console.warn('[E2E] Init returned false — encryption unavailable');
      // Don't null out e2e if server backup exists — we may sync later
      if (!this.e2e._serverBackupExists) this.e2e = null;
    }
  } catch (err) {
    console.warn('[E2E] Init failed:', err);
    this.e2e = null;
  }
},

/** Publish our key and wire up partner-key listeners (idempotent). */
async _e2eSetupListeners() {
  // Publish our public key (force if keys were explicitly reset)
  const result = await this.e2e.publishKey(this.socket, this.e2e.keysWereReset);

  // Handle publish conflict: server has a different key (another device changed it).
  // Sync from the server backup instead of overwriting.
  if (result.conflict) {
    console.warn('[E2E] Server has a different key — syncing from server backup...');
    const wrappingKey = this._e2eWrappingKey || sessionStorage.getItem('haven_e2e_wrap') || null;
    if (wrappingKey) {
      const synced = await this.e2e.syncFromServer(this.socket, wrappingKey);
      if (synced) {
        // After sync, re-publish: the key now matches the server backup,
        // so the server should accept it. Use force=true to handle the edge case
        // where the public_key column differs from the encrypted backup.
        await this.e2e.publishKey(this.socket, true);
        this._dmPublicKeys = {};
        this._showToast('Encryption keys synced from another device', 'success');
      } else {
        this._showToast('Could not sync encryption keys — try re-entering your password', 'error');
      }
    } else {
      // No wrapping key — need password
      this._showToast('Encryption keys changed on another device — re-enter your password to sync', 'error');
      this._e2ePwPendingAction = () => this._syncE2EFromServer();
      this._showE2EPasswordModal();
    }
  }

  // Only attach socket listeners once
  if (this._e2eListenersAttached) return;
  this._e2eListenersAttached = true;

  this.socket.on('public-key-result', (data) => {
    if (!data.jwk) return;
    const oldKey = this._dmPublicKeys[data.userId];
    const changed = oldKey && (oldKey.x !== data.jwk.x || oldKey.y !== data.jwk.y);
    this._dmPublicKeys[data.userId] = data.jwk;

    if (changed && this.e2e) {
      this.e2e.clearSharedKey(data.userId);
      console.warn(`[E2E] Partner ${data.userId} key changed — cache invalidated`);

      // Post a visible notice if we're currently viewing a DM with this partner.
      // Store it so it survives the message re-render triggered by _retryDecryptForUser.
      const ch = this.channels.find(c => c.code === this.currentChannel);
      if (ch && ch.is_dm && ch.dm_target && ch.dm_target.id === data.userId) {
        this._pendingE2ENotice = `🔄 ${ch.dm_target.username}'s encryption keys changed — ${new Date().toLocaleString()}. Previously encrypted messages may no longer be decryptable.`;
      }
    }

    // Resolve any pending requestPartnerKey promises for this user
    // (not used when e2e.requestPartnerKey handles it, but covers
    //  the case where _fetchDMPartnerKey fires a fire-and-forget)
    this._retryDecryptForUser(data.userId);
  });

  console.log('[E2E] Listeners attached, key published');

  // Listen for key sync from another session of the same user
  this.socket.on('e2e-key-sync', async () => {
    console.log('[E2E] Key changed on another session — syncing...');
    const wrappingKey = this._e2eWrappingKey || sessionStorage.getItem('haven_e2e_wrap') || null;
    if (wrappingKey && this.e2e) {
      const synced = await this.e2e.syncFromServer(this.socket, wrappingKey);
      if (synced) {
        await this.e2e.publishKey(this.socket);
        this._dmPublicKeys = {};
        this._showToast('Encryption keys synced', 'success');
        // Re-fetch messages if in a DM to re-decrypt
        const ch = this.channels.find(c => c.code === this.currentChannel);
        if (ch && ch.is_dm) {
          this._oldestMsgId = null;
          this._noMoreHistory = false;
          this._loadingHistory = false;
          this._historyBefore = null;
          this.socket.emit('get-messages', { code: this.currentChannel });
        }
        return;
      }
    }
    // No wrapping key or sync failed — prompt for password
    this._showToast('Encryption keys changed on another device — re-enter your password to sync', 'error');
    this._e2ePwPendingAction = () => this._syncE2EFromServer();
    this._showE2EPasswordModal();
  });
},

/**
 * Sync E2E keys from the server backup (called after password prompt or conflict detection).
 */
async _syncE2EFromServer() {
  const wrappingKey = this._e2eWrappingKey || sessionStorage.getItem('haven_e2e_wrap') || null;
  if (!wrappingKey || !this.e2e) return;

  const synced = await this.e2e.syncFromServer(this.socket, wrappingKey);
  if (synced) {
    await this.e2e.publishKey(this.socket);
    this._dmPublicKeys = {};
    this._showToast('Encryption keys synced from another device', 'success');
    // Re-fetch messages if in a DM
    const ch = this.channels.find(c => c.code === this.currentChannel);
    if (ch && ch.is_dm) {
      this._oldestMsgId = null;
      this._noMoreHistory = false;
      this._loadingHistory = false;
      this._historyBefore = null;
      this.socket.emit('get-messages', { code: this.currentChannel });
    }
  } else {
    this._showToast('Key sync failed — encryption may not work correctly', 'error');
  }
},

/**
 * Require E2E to be ready before executing an action.
 * If E2E isn't ready (no password was provided at login), shows the password prompt.
 * @param {Function} action - Callback to run once E2E is available
 */
_requireE2E(action) {
  if (this.e2e && this.e2e.ready) {
    action();
    return;
  }
  // E2E not available — prompt for password
  this._e2ePwPendingAction = action;
  this._showE2EPasswordModal();
},

/**
 * Show the E2E password prompt modal.
 */
_showE2EPasswordModal() {
  const modal = document.getElementById('e2e-password-modal');
  const input = document.getElementById('e2e-pw-input');
  const errorEl = document.getElementById('e2e-pw-error');
  const submitBtn = document.getElementById('e2e-pw-submit-btn');

  input.value = '';
  errorEl.style.display = 'none';
  errorEl.textContent = '';
  submitBtn.disabled = false;
  submitBtn.textContent = 'Unlock';

  // Check rate limit
  const now = Date.now();
  this._e2ePwAttempts = (this._e2ePwAttempts || []).filter(t => now - t < 60_000);
  if (this._e2ePwAttempts.length >= 5) {
    const oldest = this._e2ePwAttempts[0];
    const waitSec = Math.ceil((60_000 - (now - oldest)) / 1000);
    errorEl.textContent = `Too many attempts. Try again in ${waitSec}s.`;
    errorEl.style.display = 'block';
    submitBtn.disabled = true;
  }

  modal.style.display = 'flex';
  setTimeout(() => input.focus(), 50);
},

/**
 * Submit the E2E password prompt — verify against server, derive wrapping key, init E2E.
 */
async _submitE2EPassword() {
  const modal = document.getElementById('e2e-password-modal');
  const input = document.getElementById('e2e-pw-input');
  const errorEl = document.getElementById('e2e-pw-error');
  const submitBtn = document.getElementById('e2e-pw-submit-btn');

  const password = input.value;
  if (!password) {
    errorEl.textContent = 'Please enter your password.';
    errorEl.style.display = 'block';
    return;
  }

  // Rate limit check
  const now = Date.now();
  this._e2ePwAttempts = (this._e2ePwAttempts || []).filter(t => now - t < 60_000);
  if (this._e2ePwAttempts.length >= 5) {
    const oldest = this._e2ePwAttempts[0];
    const waitSec = Math.ceil((60_000 - (now - oldest)) / 1000);
    errorEl.textContent = `Too many attempts. Try again in ${waitSec}s.`;
    errorEl.style.display = 'block';
    submitBtn.disabled = true;
    return;
  }

  // Record attempt
  this._e2ePwAttempts.push(now);

  submitBtn.disabled = true;
  submitBtn.textContent = 'Verifying…';
  errorEl.style.display = 'none';

  try {
    // Verify password on server
    const resp = await fetch('/api/auth/verify-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: this.user.username, password })
    });
    const data = await resp.json();

    if (!data.valid) {
      const remaining = 5 - this._e2ePwAttempts.length;
      errorEl.textContent = `Incorrect password. ${remaining > 0 ? remaining + ' attempt' + (remaining !== 1 ? 's' : '') + ' remaining.' : 'Locked out for 60s.'}`;
      errorEl.style.display = 'block';
      submitBtn.disabled = remaining <= 0;
      submitBtn.textContent = 'Unlock';
      input.value = '';
      input.focus();
      return;
    }

    // Password correct — derive wrapping key and init E2E
    submitBtn.textContent = 'Unlocking…';
    const wrappingKey = await HavenE2E.deriveWrappingKey(password);
    sessionStorage.setItem('haven_e2e_wrap', wrappingKey);
    this._e2eWrappingKey = wrappingKey;

    // Re-initialize E2E with the wrapping key
    if (!this.e2e) this.e2e = new HavenE2E();
    const ok = await this.e2e.init(this.socket, wrappingKey);

    if (ok) {
      // Set up E2E listeners (handles publish + conflict resolution)
      await this._e2eSetupListeners();
      this._closeE2EPasswordModal();
      this._showToast('Encryption unlocked', 'success');

      // Execute the pending action
      if (this._e2ePwPendingAction) {
        const action = this._e2ePwPendingAction;
        this._e2ePwPendingAction = null;
        action();
      }
    } else {
      errorEl.textContent = 'Failed to initialize encryption. Please try again.';
      errorEl.style.display = 'block';
      submitBtn.disabled = false;
      submitBtn.textContent = 'Unlock';
    }
  } catch (err) {
    console.error('[E2E] Password prompt error:', err);
    errorEl.textContent = 'An error occurred. Please try again.';
    errorEl.style.display = 'block';
    submitBtn.disabled = false;
    submitBtn.textContent = 'Unlock';
  }
},

/**
 * Close the E2E password prompt modal.
 */
_closeE2EPasswordModal() {
  const modal = document.getElementById('e2e-password-modal');
  modal.style.display = 'none';
  document.getElementById('e2e-pw-input').value = '';
  this._e2ePwPendingAction = null;
},

/**
 * Get the E2E partner for the current DM channel.
 * Returns { userId, publicKeyJwk } or null.
 */
_getE2EPartner() {
  if (!this.e2e || !this.e2e.ready) return null;
  const ch = this.channels.find(c => c.code === this.currentChannel);
  if (!ch || !ch.is_dm || !ch.dm_target) return null;
  const jwk = this._dmPublicKeys[ch.dm_target.id];
  return jwk ? { userId: ch.dm_target.id, publicKeyJwk: jwk } : null;
},

/**
 * Re-fetch messages when a partner's key arrives (fixes key/message race).
 */
_retryDecryptForUser(userId) {
  const ch = this.channels.find(c => c.code === this.currentChannel);
  if (!ch || !ch.is_dm || !ch.dm_target || ch.dm_target.id !== userId) return;
  this._oldestMsgId = null;
  this._noMoreHistory = false;
  this._loadingHistory = false;
  this._historyBefore = null;
  this.socket.emit('get-messages', { code: this.currentChannel });
},

/**
 * Fetch the DM partner's public key (fire-and-forget, or awaitable via promise).
 * Always re-fetches to detect key changes across devices.
 */
async _fetchDMPartnerKey(channel) {
  if (!this.e2e || !this.e2e.ready) return;
  if (!channel || !channel.is_dm || !channel.dm_target) return;
  const partnerId = channel.dm_target.id;
  const jwk = await this.e2e.requestPartnerKey(this.socket, partnerId);
  if (jwk) this._dmPublicKeys[partnerId] = jwk;
},

/**
 * Show E2E verification code modal for the current DM.
 */
async _showE2EVerification() {
  const partner = this._getE2EPartner();
  if (!partner || !this.e2e?.ready) {
    this._showToast('No partner key available — the other user may not have E2E set up yet', 'error');
    return;
  }
  try {
    const code = await this.e2e.getVerificationCode(this.e2e.publicKeyJwk, partner.publicKeyJwk);
    const ch = this.channels.find(c => c.code === this.currentChannel);
    const partnerName = ch?.dm_target?.username || 'Partner';

    let overlay = document.getElementById('e2e-verify-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'e2e-verify-overlay';
      overlay.className = 'modal-overlay';
      document.body.appendChild(overlay);
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) overlay.style.display = 'none';
      });
    }
    overlay.innerHTML = `
      <div class="modal" style="max-width:420px;text-align:center">
        <h3 style="margin-bottom:8px">🔐 Verify Encryption</h3>
        <p style="font-size:13px;color:var(--text-muted);margin-bottom:16px">
          Compare this safety number with <strong>${this._escapeHtml(partnerName)}</strong> using another channel (in person, phone call, text, etc.). If they match, your conversation is end-to-end encrypted and no one is intercepting.
        </p>
        <div class="e2e-safety-number" style="font-family:monospace;font-size:18px;letter-spacing:2px;line-height:2;padding:16px;background:var(--bg-secondary);border-radius:var(--radius-md);border:1px solid var(--border);user-select:all;word-break:break-all">${code}</div>
        <div style="margin-top:16px;display:flex;gap:8px;justify-content:center">
          <button class="btn-sm btn-accent" id="e2e-copy-code-btn">Copy Code</button>
          <button class="btn-sm" id="e2e-close-verify-btn">Close</button>
        </div>
      </div>
    `;
    overlay.querySelector('#e2e-copy-code-btn').addEventListener('click', () => {
      navigator.clipboard.writeText(code);
      overlay.querySelector('#e2e-copy-code-btn').textContent = 'Copied!';
    });
    overlay.querySelector('#e2e-close-verify-btn').addEventListener('click', () => {
      overlay.style.display = 'none';
    });
    overlay.style.display = 'flex';
  } catch (err) {
    this._showToast('Could not generate verification code', 'error');
    console.error('[E2E] Verification error:', err);
  }
},

/**
 * Show a scary confirmation popup before resetting E2E encryption keys.
 */
_showE2EResetConfirmation() {
  // _requireE2E ensures E2E is ready before calling this

  let overlay = document.getElementById('e2e-reset-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'e2e-reset-overlay';
    overlay.className = 'modal-overlay';
    document.body.appendChild(overlay);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.style.display = 'none';
    });
  }
  overlay.innerHTML = `
    <div class="modal e2e-reset-modal">
      <h3>⚠️ Reset Encryption Keys</h3>
      <div class="e2e-reset-warning">
        <strong>This action is irreversible.</strong> Resetting your encryption keys will:
        <ul>
          <li>Generate a completely new key pair</li>
          <li>Make <strong>ALL</strong> previous encrypted DM messages <strong>permanently unreadable</strong> — for both you and the person you were talking to</li>
          <li>Require your DM partners to re-verify encryption with you</li>
        </ul>
        <br>
        <strong>This cannot be undone. There is no recovery. The messages are gone forever.</strong>
      </div>
      <div class="e2e-confirm-type">
        <p style="font-size:13px;color:var(--text-muted);margin-bottom:8px">Type <strong>RESET</strong> to confirm:</p>
        <input type="text" id="e2e-reset-confirm-input" placeholder="RESET" autocomplete="off" spellcheck="false">
      </div>
      <div class="e2e-reset-actions">
        <button class="btn-danger" id="e2e-reset-confirm-btn">Reset My Keys</button>
        <button class="btn-sm" id="e2e-reset-cancel-btn">Cancel</button>
      </div>
    </div>
  `;

  const confirmInput = overlay.querySelector('#e2e-reset-confirm-input');
  const confirmBtn = overlay.querySelector('#e2e-reset-confirm-btn');

  confirmInput.addEventListener('input', () => {
    if (confirmInput.value.trim().toUpperCase() === 'RESET') {
      confirmBtn.classList.add('enabled');
    } else {
      confirmBtn.classList.remove('enabled');
    }
  });

  confirmBtn.addEventListener('click', async () => {
    if (confirmInput.value.trim().toUpperCase() !== 'RESET') return;
    overlay.style.display = 'none';
    await this._performE2EKeyReset();
  });

  overlay.querySelector('#e2e-reset-cancel-btn').addEventListener('click', () => {
    overlay.style.display = 'none';
  });

  overlay.style.display = 'flex';
  setTimeout(() => confirmInput.focus(), 50);
},

/**
 * Actually reset E2E keys, re-publish, and post a notice in chat.
 */
async _performE2EKeyReset() {
  if (!this.e2e) return;

  // We need the wrapping key from memory, sessionStorage, or password prompt.
  let wrappingKey = this._e2eWrappingKey || sessionStorage.getItem('haven_e2e_wrap') || null;
  if (!wrappingKey) {
    // Wrapping key was cleared after init — prompt for password directly,
    // then retry the reset (no need to show RESET confirmation again).
    this._e2ePwPendingAction = () => this._performE2EKeyReset();
    this._showE2EPasswordModal();
    return;
  }

  try {
    const ok = await this.e2e.resetKeys(this.socket, wrappingKey);
    if (!ok) {
      this._showToast('Key reset failed', 'error');
      return;
    }
    // Re-publish the new public key (force overwrite)
    await this.e2e.publishKey(this.socket, true);
    // Clear all cached partner shared keys
    this._dmPublicKeys = {};

    // Post a timestamped notice in the current chat
    this._appendE2ENotice(`🔄 Encryption keys were reset — ${new Date().toLocaleString()}. Previous encrypted messages in this conversation can no longer be decrypted.`);

    this._showToast('Encryption keys reset successfully', 'success');
    console.log('[E2E] Keys reset by user');
  } catch (err) {
    console.error('[E2E] Key reset error:', err);
    this._showToast('Key reset failed: ' + err.message, 'error');
  }
},

/**
 * Append a styled E2E system notice to the chat.
 */
_appendE2ENotice(text) {
  const container = document.getElementById('messages');
  const wasAtBottom = this._isScrolledToBottom();
  const el = document.createElement('div');
  el.className = 'system-message e2e-notice';
  el.textContent = text;
  container.appendChild(el);
  if (wasAtBottom) this._scrollToBottom();
},

/**
 * Decrypt E2E-encrypted messages in place.
 * Both sides derive the same ECDH shared secret.
 */
async _decryptMessages(messages) {
  if (!this.e2e || !this.e2e.ready || !messages || !messages.length) return;
  const ch = this.channels.find(c => c.code === this.currentChannel);
  if (!ch || !ch.is_dm || !ch.dm_target) return;

  const partnerId = ch.dm_target.id;
  const partnerJwk = this._dmPublicKeys[partnerId];

  for (const msg of messages) {
    if (HavenE2E.isEncrypted(msg.content)) {
      if (!partnerJwk) {
        msg.content = '[Encrypted — waiting for key...]';
        msg._e2e = true;
        continue;
      }
      const plain = await this.e2e.decrypt(msg.content, partnerId, partnerJwk);
      if (plain !== null) {
        msg.content = plain;
        msg._e2e = true;
      } else {
        msg.content = '[Encrypted — unable to decrypt]';
        msg._e2e = true;
      }
    }
    // Also decrypt the reply preview text if the replied-to message was encrypted
    if (msg.replyContext && msg.replyContext.content && HavenE2E.isEncrypted(msg.replyContext.content)) {
      if (!partnerJwk) {
        msg.replyContext.content = '[Encrypted — waiting for key...]';
      } else {
        const rplain = await this.e2e.decrypt(msg.replyContext.content, partnerId, partnerJwk);
        msg.replyContext.content = rplain !== null ? rplain : '[Encrypted — unable to decrypt]';
      }
    }
  }
},

};
