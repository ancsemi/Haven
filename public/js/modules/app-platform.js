export default {

// ── Mark-Read Helper ──────────────────────────────────
// ═══════════════════════════════════════════════════════

_markRead(messageId) {
  if (!this.currentChannel || !messageId) return;
  // Capture the code at call-time, not when the timer fires.  Without this
  // a quick channel switch within the 500 ms debounce window would route
  // the mark-read to whichever channel happens to be current when the
  // timer fires, leaving the originally-viewed channel (commonly a DM the
  // user just glanced at) stuck unread forever even after multiple visits.
  const code = this.currentChannel;
  // Debounce: don't spam the server
  clearTimeout(this._markReadTimer);
  this._markReadTimer = setTimeout(() => {
    this.socket.emit('mark-read', { code, messageId });
    // Mirror locally so badges immediately reflect the read state and
    // don't bounce back to "1" on the next channels-list snapshot.
    if (this.unreadCounts && this.unreadCounts[code]) {
      this.unreadCounts[code] = 0;
      try { this._updateBadge?.(code); } catch {}
      try { this._updateDmSectionBadge?.(); } catch {}
      try { this._updateTabTitle?.(); } catch {}
      try { this._updateDesktopBadge?.(); } catch {}
    }
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
        text: t('header.update_text', { version: remoteVersion }),
        title: t('header.update_title', { remote: remoteVersion, local: localVersion }),
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

  // Don't show on mobile / tablet — desktop app isn't relevant there
  if (/Android|iPhone|iPad|iPod|Mobile|Tablet/i.test(navigator.userAgent)) return;

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

  // Close on overlay click — respect "don't show again" checkbox
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      const check = document.getElementById('desktop-promo-dismiss-check');
      if (check && check.checked) {
        localStorage.setItem('haven_desktop_promo_dismissed', '1');
        localStorage.setItem('haven_desktop_banner_dismissed', '1');
        const banner = document.getElementById('desktop-app-banner');
        if (banner) banner.style.display = 'none';
      }
      modal.style.display = 'none';
    }
  });
},

// ── Multi-Role Per-Channel Admin Notice ──────────────────
/** One-time notice for admins explaining that multiple roles can now be
 *  assigned per channel. Shows after login with a "Don't show again" option. */
_initMultiRoleNotice() {
  if (!this.user?.isAdmin) return;
  if (localStorage.getItem('haven_multi_role_notice_v1')) return;

  const modal = document.createElement('div');
  modal.id = 'multi-role-notice-modal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;z-index:9999;backdrop-filter:blur(4px);';
  modal.innerHTML = `
    <div style="background:var(--bg-card);border:1px solid var(--border-light);border-radius:var(--radius);padding:28px 28px 22px;max-width:420px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,0.5);text-align:center;">
      <div style="font-size:36px;margin-bottom:12px;">🎭</div>
      <h3 style="margin:0 0 8px;font-size:18px;font-weight:700;color:var(--text-primary);">Multi-Role Permissions</h3>
      <p style="margin:0 0 16px;font-size:13px;color:var(--text-secondary);line-height:1.6;">
        Channels can now have <strong style="color:var(--text-primary);">multiple roles assigned at once</strong>.
        Open any channel's settings and use the Roles tab to stack permissions —
        members inherit access from all roles assigned to that channel.
      </p>
      <p style="margin:0 0 20px;font-size:12px;color:var(--text-muted);">
        Manage roles per-channel via <strong>Admin → Roles</strong> or the channel context menu.
      </p>
      <button id="multi-role-notice-ok" style="padding:9px 28px;font-size:14px;font-weight:600;border-radius:var(--radius-sm);cursor:pointer;background:var(--accent);color:#fff;border:none;width:100%;margin-bottom:12px;">Got it</button>
      <label style="display:flex;align-items:center;justify-content:center;gap:8px;font-size:12px;color:var(--text-muted);cursor:pointer;">
        <input type="checkbox" id="multi-role-notice-check" style="accent-color:var(--accent);cursor:pointer;">
        Don't show this again
      </label>
    </div>
  `;
  document.body.appendChild(modal);

  const dismiss = (permanent) => {
    if (permanent) localStorage.setItem('haven_multi_role_notice_v1', '1');
    modal.remove();
  };

  document.getElementById('multi-role-notice-ok').addEventListener('click', () => {
    const check = document.getElementById('multi-role-notice-check');
    dismiss(check?.checked);
  });

  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      const check = document.getElementById('multi-role-notice-check');
      dismiss(check?.checked);
    }
  });
},

// ── Android Beta Banner + Sign-Up Popup ─────────────────
/** Show the "Android Beta" banner and sign-up popup. Users enter their email
 *  and a prefilled mailto: link sends the opt-in request to the developer. */
_initAndroidBetaBanner() {
  // ── v3 migration: Android app is now a full release; reset dismissals so
  //    users who dismissed the old closed-beta popup see the new announcement ──
  if (!localStorage.getItem('_ab_v3_migrated')) {
    localStorage.removeItem('haven_android_beta_banner_dismissed');
    localStorage.removeItem('haven_android_beta_promo_dismissed');
    localStorage.removeItem('haven_ab_banner_nodisplay');
    localStorage.removeItem('haven_ab_promo_nodisplay');
    localStorage.setItem('_ab_v3_migrated', '1');
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

  // Close on overlay click — respect "don't show again" checkbox
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      const check = document.getElementById('android-beta-dismiss-check');
      if (check && check.checked) {
        localStorage.setItem('haven_ab_promo_nodisplay', '1');
        localStorage.setItem('haven_ab_banner_nodisplay', '1');
        const banner = document.getElementById('android-beta-banner');
        if (banner) banner.style.display = 'none';
      }
      modal.style.display = 'none';
    }
  });
},

async _setupDesktopShortcuts() {
  if (!window.havenDesktop?.shortcuts) return;
  // Guard against duplicate listener attachment (called each time the nav item is clicked)
  if (this._desktopShortcutsReady) return;
  this._desktopShortcutsReady = true;

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
        // Re-register shortcuts after cancelling recording
        window.havenDesktop.shortcuts.setConfig({}).catch(() => {});
        return;
      }
      recordBtn.classList.add('recording');
      recordBtn.textContent = 'Press key…';
      keyEl.classList.add('recording-label');
      keyEl.textContent = '…';

      // Temporarily clear the shortcut being recorded so its global hotkey
      // doesn't swallow the keystroke before the BrowserView sees it
      window.havenDesktop.shortcuts.setConfig({ [action]: '' }).catch(() => {});

      // (#5255) Three things the previous recorder couldn't do:
      // 1. Lone modifiers (just Alt / Ctrl / Shift) — useful while gaming so
      //    you can transmit without lifting a hand off WASD.
      // 2. Extra mouse buttons (Mouse4 / Mouse5) for thumb-button push-to-talk.
      // 3. The PTT mode (toggle vs hold) lives on a sibling control wired up
      //    elsewhere; the recorder itself just captures the keystroke / button.
      //
      // Bare-modifier capture works by deferring commit to keyup: keydown for
      // a modifier alone arms a "pending lone modifier" that will commit if
      // the user releases without ever pressing a non-modifier. Pressing a
      // non-modifier in the meantime falls through to the original combo path
      // and clears the pending state.
      const MOD_KEYS = new Set(['Control', 'Meta', 'Alt', 'Shift']);
      let pendingLoneMod = null;

      const finish = async (accel) => {
        document.removeEventListener('keydown', onKeyDown, true);
        document.removeEventListener('keyup', onKeyUp, true);
        document.removeEventListener('mousedown', onMouseDown, true);
        recordBtn.classList.remove('recording');
        recordBtn.textContent = 'Record';
        keyEl.classList.remove('recording-label');
        try {
          await window.havenDesktop.shortcuts.setConfig({ [action]: accel });
          config[action] = accel;
          keyEl.textContent = formatAccel(accel);
        } catch (err) {
          await window.havenDesktop.shortcuts.setConfig({ [action]: config[action] || '' }).catch(() => {});
          keyEl.textContent = formatAccel(config[action] || '');
          this._showToast?.('Failed to register shortcut — it may already be in use, or the desktop app version doesn\'t support this binding type yet.', 'error');
        }
      };

      const onKeyDown = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (MOD_KEYS.has(e.key)) {
          // Don't commit yet — wait for keyup to decide if this is a lone-mod
          // press or the modifier half of a combo.
          pendingLoneMod = e.key;
          keyEl.textContent = `${e.key}…`;
          return;
        }
        // Non-modifier pressed — kill the pending lone-mod and commit a combo.
        pendingLoneMod = null;
        const parts = [];
        if (e.ctrlKey || e.metaKey) parts.push('CommandOrControl');
        if (e.altKey)  parts.push('Alt');
        if (e.shiftKey) parts.push('Shift');
        const mapped = keyMap[e.key] || (e.key.length === 1 ? e.key.toUpperCase() : e.key);
        parts.push(mapped);
        finish(parts.join('+'));
      };

      const onKeyUp = (e) => {
        // Only commit a lone modifier if the user released the SAME modifier
        // they pressed and never pressed anything else in between.
        if (!MOD_KEYS.has(e.key)) return;
        if (pendingLoneMod !== e.key) return;
        pendingLoneMod = null;
        // Map "Control"/"Meta" → "CommandOrControl" to match Electron's
        // accelerator format. "Alt" / "Shift" pass through.
        const mapped = (e.key === 'Control' || e.key === 'Meta') ? 'CommandOrControl' : e.key;
        finish(mapped);
      };

      const onMouseDown = (e) => {
        // 0/1/2 are left/middle/right — leave those alone so the user can still
        // click around. 3+ are the extra mouse buttons (mouse4 / mouse5).
        if (e.button < 3) return;
        e.preventDefault();
        e.stopPropagation();
        pendingLoneMod = null;
        finish(`Mouse${e.button + 1}`);
      };

      document.addEventListener('keydown', onKeyDown, true);
      document.addEventListener('keyup', onKeyUp, true);
      document.addEventListener('mousedown', onMouseDown, true);
    });

    clearBtn.addEventListener('click', async () => {
      try {
        await window.havenDesktop.shortcuts.setConfig({ [action]: '' });
        config[action] = '';
        keyEl.textContent = '—';
      } catch (err) {}
    });
  });

  // (#5255) PTT mode select — toggle vs hold-to-transmit. Stored on the same
  // shortcuts config object alongside the keybinds. Default to "hold" since
  // that's what most voice apps use and what the issue reporter wanted.
  const pttModeSel = document.getElementById('ptt-mode-select');
  if (pttModeSel) {
    pttModeSel.value = (config.pttMode === 'toggle') ? 'toggle' : 'hold';
    pttModeSel.addEventListener('change', async () => {
      try {
        await window.havenDesktop.shortcuts.setConfig({ pttMode: pttModeSel.value });
        config.pttMode = pttModeSel.value;
      } catch (err) {
        this._showToast?.('Failed to save PTT mode — desktop app may need an update.', 'error');
      }
    });
  }
},

/* ── Desktop App Preferences (start on login, tray, SDR) ── */

async _setupDesktopAppPrefs() {
  if (!window.havenDesktop?.prefs) return;
  if (this._desktopPrefsReady) return;
  this._desktopPrefsReady = true;

  let prefs = {};
  try { prefs = await window.havenDesktop.prefs.get(); } catch {}

  const startEl   = document.getElementById('pref-start-on-login');
  const hiddenEl  = document.getElementById('pref-start-hidden');
  const hiddenRow = document.getElementById('pref-start-hidden-row');
  const trayEl    = document.getElementById('pref-minimize-to-tray');
  const sdrEl     = document.getElementById('pref-force-sdr');
  const menuBarEl = document.getElementById('pref-hide-menu-bar');
  const versionEl = document.getElementById('desktop-version-info');

  if (startEl) { startEl.checked = !!prefs.startOnLogin; }
  if (hiddenEl) { hiddenEl.checked = !!prefs.startHidden; }
  if (hiddenRow) { hiddenRow.style.display = prefs.startOnLogin ? '' : 'none'; }
  if (trayEl)  { trayEl.checked  = !!prefs.minimizeToTray; }
  if (sdrEl)   { sdrEl.checked   = !!prefs.forceSDR; }
  if (menuBarEl) { menuBarEl.checked = !!prefs.hideMenuBar; }

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
    // Show/hide the start-hidden option
    if (hiddenRow) hiddenRow.style.display = startEl.checked ? '' : 'none';
  });

  hiddenEl?.addEventListener('change', async () => {
    try { await window.havenDesktop.prefs.setStartHidden(hiddenEl.checked); }
    catch { hiddenEl.checked = !hiddenEl.checked; }
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

  menuBarEl?.addEventListener('change', async () => {
    try { await window.havenDesktop.prefs.setHideMenuBar(menuBarEl.checked); }
    catch { menuBarEl.checked = !menuBarEl.checked; }
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
    // Also persist to localStorage so server list sync works across page reloads.
    if (wrappingKey) {
      this._e2eWrappingKey = wrappingKey;
      sessionStorage.removeItem('haven_e2e_wrap');
      try { localStorage.setItem('haven_sync_key', wrappingKey); } catch { /* private mode */ }
    } else {
      // On auto-login (no password), recover the sync key from localStorage
      try {
        const savedKey = localStorage.getItem('haven_sync_key');
        if (savedKey) this._e2eWrappingKey = savedKey;
      } catch { /* ignore */ }
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

  // Sync server list with server-side encrypted backup (piggybacks on wrapping key)
  try {
    const syncKey = this._e2eWrappingKey || sessionStorage.getItem('haven_e2e_wrap') || null;
    if (syncKey && this.serverManager) {
      await this.serverManager.syncWithServer(this.token, syncKey);
      this._renderServerBar();
      this._pushServersToDesktopHistory();

      // Re-sync periodically (every 5 min) so cross-device changes propagate
      // without requiring a full page reload or re-login
      if (!this._serverSyncInterval) {
        this._serverSyncInterval = setInterval(async () => {
          const key = this._e2eWrappingKey || sessionStorage.getItem('haven_e2e_wrap') || null;
          if (key && this.serverManager && this.token) {
            try {
              await this.serverManager.syncWithServer(this.token, key);
              this._renderServerBar();
              this._pushServersToDesktopHistory();
            } catch { /* silent — best-effort background sync */ }
          }
        }, 5 * 60 * 1000);
      }

      // Also sync when the tab becomes visible (user switching back from another server)
      if (!this._serverSyncVisibility) {
        this._serverSyncVisibility = true;
        document.addEventListener('visibilitychange', async () => {
          if (document.visibilityState !== 'visible') return;
          const key = this._e2eWrappingKey || sessionStorage.getItem('haven_e2e_wrap') || null;
          if (key && this.serverManager && this.token) {
            try {
              await this.serverManager.syncWithServer(this.token, key);
              this._renderServerBar();
              this._pushServersToDesktopHistory();
            } catch { /* silent */ }
          }
        });
      }
    }
  } catch (err) {
    console.warn('[ServerSync] Post-login sync failed:', err.message);
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
          this._newestMsgId = null;
          this._noMoreFuture = true;
          this._loadingFuture = false;
          this._historyAfter = null;
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
      this._newestMsgId = null;
      this._noMoreFuture = true;
      this._loadingFuture = false;
      this._historyAfter = null;
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

    // If a key reset is pending, skip normal init (it may fail if backup
    // is encrypted with a different password). Reset generates fresh keys.
    if (this._e2eResetPending) {
      this._e2eResetPending = false;
      this._closeE2EPasswordModal();
      await this._performE2EKeyReset();
      return;
    }

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
  this._e2eResetPending = false;
},

/**
 * Get the E2E partner for the current DM channel.
 * Returns { userId, publicKeyJwk } or null.
 */
_getE2EPartner() {
  return this._getE2EPartnerFor(this.currentChannel);
},

/** Like _getE2EPartner but for an arbitrary DM channel code (used by the
 *  DM PiP, which sends to its own code while another channel is active). */
_getE2EPartnerFor(code) {
  if (!this.e2e || !this.e2e.ready) return null;
  const ch = this.channels.find(c => c.code === code);
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
  this._newestMsgId = null;
  this._noMoreFuture = true;
  this._loadingFuture = false;
  this._historyAfter = null;
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
        <h3 style="margin-bottom:8px">🔐 ${t('header.verify_encryption')}</h3>
        <p style="font-size:13px;color:var(--text-muted);margin-bottom:16px">
          ${t('modals.e2e_verify.desc', { name: this._escapeHtml(partnerName) })}
        </p>
        <div class="e2e-safety-number" style="font-family:monospace;font-size:18px;letter-spacing:2px;line-height:2;padding:16px;background:var(--bg-secondary);border-radius:var(--radius-md);border:1px solid var(--border);user-select:all;word-break:break-all">${code}</div>
        <div style="margin-top:16px;display:flex;gap:8px;justify-content:center">
          <button class="btn-sm btn-accent" id="e2e-copy-code-btn">${t('modals.e2e_verify.copy_btn')}</button>
          <button class="btn-sm" id="e2e-close-verify-btn">${t('modals.common.close')}</button>
        </div>
      </div>
    `;
    overlay.querySelector('#e2e-copy-code-btn').addEventListener('click', () => {
      const markCopied = () => { overlay.querySelector('#e2e-copy-code-btn').textContent = 'Copied!'; };
      navigator.clipboard.writeText(code).then(markCopied).catch(() => {
        try {
          const ta = document.createElement('textarea');
          ta.value = code;
          ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
          document.body.appendChild(ta);
          ta.focus(); ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
          markCopied();
        } catch { /* could not copy */ }
      });
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
      <h3>⚠️ ${t('header.reset_encryption')}</h3>
      <div class="e2e-reset-warning">
        ${t('modals.e2e_reset.warning_irreversible')}
        <ul>
          <li>${t('modals.e2e_reset.li_new_keys')}</li>
          <li>${t('modals.e2e_reset.li_unreadable')}</li>
          <li>${t('modals.e2e_reset.li_reverify')}</li>
        </ul>
        <br>
        ${t('modals.e2e_reset.warning_permanent')}
      </div>
      <div class="e2e-confirm-type">
        <p style="font-size:13px;color:var(--text-muted);margin-bottom:8px">${t('modals.e2e_reset.type_confirm')}</p>
        <input type="text" id="e2e-reset-confirm-input" placeholder="${t('modals.e2e_reset.confirm_placeholder')}" autocomplete="off" spellcheck="false">
      </div>
      <div class="e2e-reset-actions">
        <button class="btn-danger" id="e2e-reset-confirm-btn">${t('modals.e2e_reset.confirm_btn')}</button>
        <button class="btn-sm" id="e2e-reset-cancel-btn">${t('modals.common.cancel')}</button>
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
 * This must work even when E2E can't initialize (e.g. server backup
 * encrypted with old password). Reset generates fresh keys from scratch.
 */
async _performE2EKeyReset() {
  // We need the wrapping key from memory, sessionStorage, or password prompt.
  let wrappingKey = this._e2eWrappingKey || sessionStorage.getItem('haven_e2e_wrap') || null;
  if (!wrappingKey) {
    // Wrapping key was cleared after init — prompt for password directly,
    // then retry the reset (no need to show RESET confirmation again).
    // Use a custom pending action that bypasses _requireE2E.
    this._e2ePwPendingAction = null; // clear normal pending action
    this._e2eResetPending = true;
    this._showE2EPasswordModal();
    return;
  }

  // Ensure we have an E2E instance (may be null if init failed earlier)
  if (!this.e2e) {
    if (typeof HavenE2E !== 'undefined') {
      this.e2e = new HavenE2E();
      await this.e2e._openDB();
    } else {
      this._showToast('E2E module not available', 'error');
      return;
    }
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
  const wasAtBottom = this._coupledToBottom;
  const el = document.createElement('div');
  el.className = 'system-message e2e-notice';
  el.textContent = text;
  container.appendChild(el);
  if (wasAtBottom) this._scrollToBottom(true);
},

/**
 * Decrypt E2E-encrypted messages in place.
 * Both sides derive the same ECDH shared secret.
 */
async _decryptMessages(messages, channelCode = null) {
  if (!this.e2e || !this.e2e.ready || !messages || !messages.length) return;
  const ch = this.channels.find(c => c.code === (channelCode || this.currentChannel));
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

/**
 * Wire up download buttons on e2e-file-pending attachments inside `root`.
 * Click → fetch encrypted blob → decrypt with the DM partner key →
 * trigger a save-as via an object URL. Marks the row `e2e-file-failed` if the
 * partner key isn't available so the user understands why download is blocked
 * instead of getting a silent no-op. (#5310, #5308)
 */
_decryptE2EFiles(root) {
  if (!root) root = document.getElementById('messages');
  if (!root) return;
  const rows = root.querySelectorAll('.e2e-file-pending');
  if (!rows.length) return;
  const inPip = !!(root.id === 'dm-pip-messages' || (root.closest && root.closest('#dm-pip-messages')));
  const partner = inPip && this._activeDMPip
    ? this._getE2EPartnerFor(this._activeDMPip)
    : this._getE2EPartner();
  rows.forEach(row => {
    row.classList.remove('e2e-file-pending');
    const url = row.dataset.e2eUrl;
    const mime = row.dataset.e2eMime || 'application/octet-stream';
    const name = row.dataset.e2eName || 'file';
    const btn = row.querySelector('.e2e-file-download');
    if (!url || !url.startsWith('/uploads/') || !partner) {
      row.classList.add('e2e-file-failed');
      if (btn) btn.disabled = true;
      return;
    }
    if (!btn) return;
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      if (btn.disabled) return;
      btn.disabled = true;
      row.classList.add('e2e-file-loading');
      try {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(resp.status);
        const buf = await resp.arrayBuffer();
        const plain = await this.e2e.decryptBytes(new Uint8Array(buf), partner.userId, partner.publicKeyJwk);
        const blob = new Blob([plain], { type: mime });
        const objectUrl = URL.createObjectURL(blob);

        // Video/audio types get an inline player instead of a silent download
        const isVideo = mime.startsWith('video/');
        const isAudio = mime.startsWith('audio/');
        if (isVideo || isAudio) {
          const mediaEl = document.createElement(isVideo ? 'video' : 'audio');
          mediaEl.controls = true;
          mediaEl.preload = 'metadata';
          mediaEl.src = objectUrl;
          if (isVideo) mediaEl.className = 'file-video';

          row.classList.remove('e2e-file-loading');
          row.innerHTML = '';

          // Info bar matching the non-E2E file-attachment header style
          const infoBar = document.createElement('div');
          infoBar.className = 'file-info';
          const icon = isVideo ? '🎬' : '🎵';
          const nameSafe = name.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
          infoBar.innerHTML = `${icon} <span class="file-name">${nameSafe}</span>`;

          const dlBtn = document.createElement('a');
          dlBtn.href = objectUrl;
          dlBtn.download = name;
          dlBtn.className = 'file-download-link';
          dlBtn.title = `Download ${name}`;
          dlBtn.innerHTML = '⬇';
          infoBar.appendChild(dlBtn);
          row.appendChild(infoBar);

          if (isVideo) {
            const wrap = document.createElement('div');
            wrap.className = 'file-video-wrap';
            wrap.appendChild(mediaEl);
            row.appendChild(wrap);
          } else {
            row.appendChild(mediaEl);
          }

          // Revoke blob URL when the media element is removed from DOM
          const obs = new MutationObserver(() => {
            if (!document.contains(mediaEl)) { URL.revokeObjectURL(objectUrl); obs.disconnect(); }
          });
          obs.observe(document.body, { childList: true, subtree: true });
          btn.disabled = false;
          return;
        }

        // Non-media: trigger download and notify user
        const a = document.createElement('a');
        a.href = objectUrl;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
        this._showToast(`Downloaded: ${name}`, 'success');
      } catch (err) {
        row.classList.add('e2e-file-failed');
      } finally {
        row.classList.remove('e2e-file-loading');
        btn.disabled = false;
      }
    });
  });
},

/**
 * Find all e2e-img-pending images in a DOM element (or the messages container),
 * fetch their encrypted data, decrypt, and display as blob URLs.
 */
_decryptE2EImages(root) {
  if (!root) root = document.getElementById('messages');
  if (!root) return;
  const imgs = root.querySelectorAll('img.e2e-img-pending');
  if (!imgs.length) return;

  // If the root is inside the DM PiP overlay, derive the partner from the
  // active PiP channel rather than the currently-focused main channel.
  const inPip = !!(root.id === 'dm-pip-messages' || (root.closest && root.closest('#dm-pip-messages')));
  const partner = inPip && this._activeDMPip
    ? this._getE2EPartnerFor(this._activeDMPip)
    : this._getE2EPartner();
  if (!partner) return;

  imgs.forEach(img => {
    img.classList.remove('e2e-img-pending');
    img.classList.add('e2e-img-loading');
    const url = img.dataset.e2eSrc;
    const mime = img.dataset.e2eMime || 'image/png';

    // Only fetch local upload paths to prevent SSRF
    if (!url || !url.startsWith('/uploads/')) {
      img.alt = '[Invalid encrypted image URL]';
      img.classList.remove('e2e-img-loading');
      img.classList.add('e2e-img-failed');
      return;
    }

    fetch(url)
      .then(r => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); })
      .then(buf => this.e2e.decryptBytes(new Uint8Array(buf), partner.userId, partner.publicKeyJwk))
      .then(plain => {
        const blob = new Blob([plain], { type: mime });
        img.src = URL.createObjectURL(blob);
        img.classList.remove('e2e-img-loading');
      })
      .catch(() => {
        img.alt = '[Encrypted image — unable to decrypt]';
        img.classList.remove('e2e-img-loading');
        img.classList.add('e2e-img-failed');
      });
  });
},

};
