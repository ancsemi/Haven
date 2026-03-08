export default {

// ── User Context Menu (right-click → options) ──

_showUserContextMenu(e, targetUserId) {
  this._hideUserContextMenu();
  this._closeProfilePopup();

  const menu = document.createElement('div');
  menu.id = 'user-context-menu';
  menu.className = 'user-context-menu';

  // Find target username from online users
  const targetUser = (this._lastOnlineUsers || []).find(u => u.id === targetUserId);
  const targetName = targetUser ? targetUser.username : 'User';

  // Header with username
  const header = document.createElement('div');
  header.className = 'user-ctx-header';
  header.textContent = targetName;
  menu.appendChild(header);

  // 1) View Profile
  const profileBtn = document.createElement('button');
  profileBtn.innerHTML = '👤 View Profile';
  profileBtn.addEventListener('click', () => {
    this._hideUserContextMenu();
    this._isHoverPopup = false;
    this._profilePopupAnchor = e.target.closest('.user-item') || e.target;
    this.socket.emit('get-user-profile', { userId: targetUserId });
  });
  menu.appendChild(profileBtn);

  // 2) Direct Message
  const dmBtn = document.createElement('button');
  dmBtn.innerHTML = '💬 Direct Message';
  dmBtn.addEventListener('click', () => {
    this._hideUserContextMenu();
    this.socket.emit('start-dm', { targetUserId });
    this._showToast(`Opening DM with ${this._escapeHtml(targetName)}…`, 'info');
  });
  menu.appendChild(dmBtn);

  // 3) Invite to Channel (submenu)
  // Private channels are excluded for non-admins: regular members can't bypass
  // the code requirement by using the right-click invite menu.
  // Both is_private=1 and code_visibility='private' count as private here.
  const inviteChannels = (this.channels || []).filter(ch =>
    !ch.is_dm && ch.name && ((!ch.is_private && ch.code_visibility !== 'private') || this.user?.isAdmin)
  );
  if (inviteChannels.length > 0) {
    const inviteItem = document.createElement('div');
    inviteItem.className = 'user-ctx-submenu-wrapper';
    const inviteBtn = document.createElement('button');
    inviteBtn.className = 'user-ctx-submenu-trigger';
    inviteBtn.innerHTML = '📨 Invite to Channel <span class="user-ctx-arrow">▸</span>';
    inviteItem.appendChild(inviteBtn);

    const submenu = document.createElement('div');
    submenu.className = 'user-ctx-submenu';
    for (const ch of inviteChannels) {
      const chBtn = document.createElement('button');
      chBtn.textContent = `# ${ch.name}`;
      chBtn.title = ch.topic || ch.name;
      chBtn.addEventListener('click', () => {
        this.socket.emit('invite-to-channel', {
          targetUserId,
          channelId: ch.id
        });
        this._hideUserContextMenu();
      });
      submenu.appendChild(chBtn);
    }
    // Flip submenu left if it would overflow viewport right edge
    inviteItem.addEventListener('mouseenter', () => {
      const wrapRect = inviteItem.getBoundingClientRect();
      const submenuWidth = Math.max(submenu.scrollWidth || 0, 180);
      if (wrapRect.right + submenuWidth > window.innerWidth) {
        submenu.style.left = 'auto';
        submenu.style.right = '100%';
      } else {
        submenu.style.left = '100%';
        submenu.style.right = 'auto';
      }
    });
    inviteItem.appendChild(submenu);
    menu.appendChild(inviteItem);
  }

  // 4) Set Nickname
  const nickBtn = document.createElement('button');
  nickBtn.innerHTML = '🏷️ Set Nickname';
  nickBtn.addEventListener('click', () => {
    this._hideUserContextMenu();
    this._showNicknameDialog(targetUserId, targetName);
  });
  menu.appendChild(nickBtn);

  menu.style.left = e.clientX + 'px';
  menu.style.top = e.clientY + 'px';
  document.body.appendChild(menu);

  // Clamp to viewport
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = (window.innerWidth - rect.width - 8) + 'px';
  if (rect.bottom > window.innerHeight) menu.style.top = (window.innerHeight - rect.height - 8) + 'px';

  // Close on click elsewhere
  const closer = (ev) => {
    if (!menu.contains(ev.target)) {
      this._hideUserContextMenu();
      document.removeEventListener('click', closer, true);
      document.removeEventListener('contextmenu', closer, true);
    }
  };
  setTimeout(() => {
    document.addEventListener('click', closer, true);
    document.addEventListener('contextmenu', closer, true);
  }, 0);
},

_hideUserContextMenu() {
  const existing = document.getElementById('user-context-menu');
  if (existing) existing.remove();
},

// ═══════════════════════════════════════════════════════
// ONLINE OVERLAY (status bar popup)
// ═══════════════════════════════════════════════════════

_setupOnlineOverlay() {
  const trigger = document.getElementById('status-online-trigger');
  const overlay = document.getElementById('online-overlay');
  const closeBtn = document.getElementById('online-overlay-close');
  if (!trigger || !overlay) return;

  trigger.style.cursor = 'pointer';

  trigger.addEventListener('click', () => {
    const isOpen = overlay.style.display !== 'none';
    if (isOpen) {
      overlay.style.display = 'none';
      return;
    }
    this._renderOnlineOverlay();
    overlay.style.display = '';

    // Position above the trigger
    const rect = trigger.getBoundingClientRect();
    overlay.style.left = rect.left + 'px';
    overlay.style.bottom = (window.innerHeight - rect.top + 6) + 'px';
  });

  if (closeBtn) {
    closeBtn.addEventListener('click', () => { overlay.style.display = 'none'; });
  }

  // Close on outside click
  document.addEventListener('click', (e) => {
    if (overlay.style.display === 'none') return;
    if (!overlay.contains(e.target) && !trigger.contains(e.target)) {
      overlay.style.display = 'none';
    }
  });
},

_renderOnlineOverlay() {
  const list = document.getElementById('online-overlay-list');
  if (!list) return;

  const users = this._lastOnlineUsers || [];
  if (users.length === 0) {
    list.innerHTML = '<p class="muted-text" style="padding:8px">No users</p>';
    return;
  }

  const online = users.filter(u => u.online !== false);
  const offline = users.filter(u => u.online === false);

  let html = '';
  if (online.length > 0) {
    html += `<div class="online-overlay-group">Online — ${online.length}</div>`;
    html += online.map(u => this._renderOverlayUserItem(u)).join('');
  }
  if (offline.length > 0) {
    html += `<div class="online-overlay-group offline">Offline — ${offline.length}</div>`;
    html += offline.map(u => this._renderOverlayUserItem(u)).join('');
  }
  list.innerHTML = html;
},

_renderOverlayUserItem(u) {
  const initial = (u.username || '?')[0].toUpperCase();
  const color = this._safeColor(u.roleColor || u.avatarColor, '#7c5cfc');
  const statusClass = u.online !== false ? 'online' : 'offline';
  const avatar = u.avatarUrl
    ? `<img src="${this._escapeHtml(u.avatarUrl)}" class="online-overlay-avatar-img" alt="">`
    : `<div class="online-overlay-avatar" style="background:${color}">${initial}</div>`;
  const nameColor = u.roleColor ? ` style="color:${this._safeColor(u.roleColor)}"` : '';
  return `<div class="online-overlay-user ${statusClass}">
    ${avatar}
    <span class="online-overlay-username"${nameColor}>${this._escapeHtml(this._getNickname(u.id, u.username))}</span>
    <span class="online-overlay-status-dot ${statusClass}"></span>
  </div>`;
},

// ═══════════════════════════════════════════════════════
// NOTIFICATIONS
// ═══════════════════════════════════════════════════════

_setupNotifications() {
  const toggle = document.getElementById('notif-enabled');
  const volume = document.getElementById('notif-volume');
  const msgSound = document.getElementById('notif-msg-sound');
  const mentionVolume = document.getElementById('notif-mention-volume');
  const mentionSound = document.getElementById('notif-mention-sound');
  const sentSound = document.getElementById('notif-sent-sound');
  const joinSound = document.getElementById('notif-join-sound');
  const leaveSound = document.getElementById('notif-leave-sound');

  toggle.checked = this.notifications.enabled;
  volume.value = this.notifications.volume * 100;
  msgSound.value = this.notifications.sounds.message;
  if (sentSound) sentSound.value = this.notifications.sounds.sent;
  mentionVolume.value = this.notifications.mentionVolume * 100;
  mentionSound.value = this.notifications.sounds.mention;
  if (joinSound) joinSound.value = this.notifications.sounds.join;
  if (leaveSound) leaveSound.value = this.notifications.sounds.leave;

  toggle.addEventListener('change', () => {
    this.notifications.setEnabled(toggle.checked);
  });

  volume.addEventListener('input', () => {
    this.notifications.setVolume(volume.value / 100);
  });

  msgSound.addEventListener('change', () => {
    this.notifications.setSound('message', msgSound.value);
    this.notifications.play('message'); // Preview the selected sound
  });

  if (sentSound) {
    sentSound.addEventListener('change', () => {
      this.notifications.setSound('sent', sentSound.value);
      this.notifications.play('sent');
    });
  }

  mentionVolume.addEventListener('input', () => {
    this.notifications.setMentionVolume(mentionVolume.value / 100);
  });

  mentionSound.addEventListener('change', () => {
    this.notifications.setSound('mention', mentionSound.value);
    this.notifications.play('mention'); // Preview the selected sound
  });

  if (joinSound) {
    joinSound.addEventListener('change', () => {
      this.notifications.setSound('join', joinSound.value);
      this.notifications.play('join');
    });
  }

  if (leaveSound) {
    leaveSound.addEventListener('change', () => {
      this.notifications.setSound('leave', leaveSound.value);
      this.notifications.play('leave');
    });
  }

  const autoAcceptToggle = document.getElementById('auto-accept-streams');
  if (autoAcceptToggle) {
    autoAcceptToggle.checked = localStorage.getItem('haven_auto_accept_streams') !== 'false';
    autoAcceptToggle.addEventListener('change', () => {
      localStorage.setItem('haven_auto_accept_streams', String(autoAcceptToggle.checked));
    });
  }
},

// ── Push Notifications (Web Push API) ──────────────────

async _setupPushNotifications() {
  const toggle = document.getElementById('push-notif-enabled');
  const statusEl = document.getElementById('push-notif-status');

  // Wire dismiss button for push error modal
  document.getElementById('push-error-dismiss-btn')?.addEventListener('click', () => {
    document.getElementById('push-error-modal').style.display = 'none';
    localStorage.setItem('haven_push_error_dismissed', 'true');
  });

  // Detect browser and platform
  const isBrave = navigator.brave && (await navigator.brave.isBrave?.()) || false;
  const ua = navigator.userAgent;
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

  // Secure context required (covers HTTPS, localhost, etc.)
  if (!window.isSecureContext) {
    if (toggle) toggle.disabled = true;
    if (statusEl) statusEl.textContent = 'Requires HTTPS';
    this._pushErrorReason = 'Push notifications require a secure (HTTPS) connection. Check the Haven setup guide for SSL configuration.';
    if (!localStorage.getItem('haven_push_error_dismissed')) this._showPushError(this._pushErrorReason);
    return;
  }

  // Check browser support
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    if (toggle) toggle.disabled = true;
    let reason = 'Your browser does not support push notifications.';
    if (isIOS && !isStandalone) {
      reason = 'On iOS, push notifications only work when Haven is installed as an app. ' +
        'Tap the Share button → "Add to Home Screen", then open Haven from your home screen.';
    } else if (isIOS) {
      reason = 'Push notifications are not supported on this iOS browser version. Update to iOS 16.4 or later.';
    }
    if (statusEl) statusEl.textContent = 'Not supported';
    this._pushErrorReason = reason;
    if (!localStorage.getItem('haven_push_error_dismissed')) this._showPushError(reason);
    return;
  }

  // Register service worker
  try {
    this._swRegistration = await navigator.serviceWorker.register('/sw.js');
  } catch (err) {
    console.error('SW registration failed:', err);
    if (toggle) toggle.disabled = true;
    let reason = `Service worker registration failed: ${err.message}`;
    const host = location.hostname;
    const isSelfSigned = location.protocol === 'https:' && host !== 'localhost' && host !== '127.0.0.1' && !host.endsWith('.trycloudflare.com');
    if (err.name === 'SecurityError' || (err.message && err.message.includes('SSL')) || isSelfSigned) {
      reason = 'Push notifications require a trusted SSL certificate.\n\n' +
        'Self-signed certificates (used by default) do not support push. To fix this:\n' +
        '• Use a Cloudflare Tunnel (Settings → Admin → Tunnel) which provides a trusted cert automatically\n' +
        '• Or access Haven via localhost (push works on localhost even with self-signed certs)\n' +
        '• Or install a real SSL certificate (e.g. from Let\'s Encrypt)';
    }
    if (isBrave) {
      reason = 'Brave blocks push notifications by default.\n\n' +
        'To fix this:\n' +
        '1. Open brave://settings/privacy in your address bar\n' +
        '2. Enable "Use Google Services for Push Messaging"\n' +
        '3. Restart Brave and reload Haven\n\n' +
        'If that doesn\'t work, try Chrome or Edge instead.';
    }
    if (statusEl) statusEl.textContent = isBrave ? 'Blocked by Brave' : 'Registration failed';
    this._pushErrorReason = reason;
    if (!localStorage.getItem('haven_push_error_dismissed')) this._showPushError(reason);
    return;
  }

  // Listen for notification clicks from service worker (channel switch)
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data?.type === 'push-notification-click' && event.data.channelCode) {
      this.switchChannel(event.data.channelCode);
    }
  });

  // Check current subscription state
  let existingSub = null;
  try {
    existingSub = await this._swRegistration.pushManager.getSubscription();
  } catch (err) {
    console.warn('Push getSubscription failed (non-fatal, will retry on subscribe):', err.message || err);
    // Don't bail out — let the user attempt to subscribe via the toggle.
    // The actual subscribe() call in _subscribePush will surface the real error.
  }

  this._pushSubscription = existingSub;
  if (toggle) toggle.checked = !!existingSub;
  if (statusEl) statusEl.textContent = existingSub ? 'Enabled' : 'Disabled';

  // Re-register existing subscription with server on every load
  // (handles server DB resets, reconnects, and subscription refresh)
  if (existingSub) {
    const subJson = existingSub.toJSON();
    this.socket.emit('push-subscribe', {
      endpoint: subJson.endpoint,
      keys: { p256dh: subJson.keys.p256dh, auth: subJson.keys.auth }
    });
  }

  // If permission was previously denied, show early warning
  if (Notification.permission === 'denied') {
    if (toggle) toggle.disabled = true;
    if (statusEl) statusEl.textContent = 'Blocked';
    this._pushErrorReason = 'Notification permission was denied. Check your browser\'s site settings and allow notifications for this site, then reload.';
    return;
  }

  // Listen for server confirmation
  this.socket.on('push-subscribed', () => {
    if (statusEl) statusEl.textContent = 'Enabled';
  });
  this.socket.on('push-unsubscribed', () => {
    if (statusEl) statusEl.textContent = 'Disabled';
  });

  // Toggle handler
  if (toggle) {
    toggle.addEventListener('change', async () => {
      if (toggle.checked) {
        // If we have a stored error reason, show popup instead of trying
        if (toggle.disabled && this._pushErrorReason) {
          toggle.checked = false;
          this._showPushError(this._pushErrorReason);
          return;
        }
        await this._subscribePush();
      } else {
        await this._unsubscribePush();
      }
    });
  }
},

// ── Activities / Games system methods ────────────────────
async _openActivitiesModal() {
  const modal = document.getElementById('activities-modal');
  const grid = document.getElementById('activities-grid');
  if (!modal || !grid) return;

  grid.innerHTML = '';

  // Check flash ROM installation status
  let flashStatus = {};
  try {
    const res = await fetch('/api/flash-rom-status');
    if (res.ok) {
      const data = await res.json();
      for (const rom of data.roms) flashStatus[rom.file] = rom.installed;
      this._flashAllInstalled = data.allInstalled;
    }
  } catch {}

  // If any flash games are not installed, show a download banner at top
  const hasFlashGames = this._gamesRegistry.some(g => g.type === 'flash');
  if (hasFlashGames && !this._flashAllInstalled) {
    const banner = document.createElement('div');
    banner.className = 'flash-install-banner';
    banner.innerHTML = `
      <span>🎮 Flash games not installed (~37 MB download)</span>
      <button class="btn-sm btn-accent" id="install-flash-btn">Download Flash Games</button>
    `;
    grid.appendChild(banner);
    banner.querySelector('#install-flash-btn').addEventListener('click', async (e) => {
      const btn = e.target;
      btn.disabled = true;
      btn.textContent = 'Downloading…';
      try {
        const res = await fetch('/api/install-flash-roms', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + this.token }
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || 'Download failed');
        }
        const data = await res.json();
        const installed = data.results.filter(r => r.status === 'installed').length;
        const already = data.results.filter(r => r.status === 'already-installed').length;
        const errors = data.results.filter(r => r.status === 'error');
        this._showToast(`Flash games: ${installed} installed, ${already} already had, ${errors.length} failed`, installed > 0 ? 'success' : 'error');
        this._flashAllInstalled = errors.length === 0;
        // Refresh modal
        this._openActivitiesModal();
      } catch (err) {
        this._showToast(err.message, 'error');
        btn.disabled = false;
        btn.textContent = 'Download Flash Games';
      }
    });
  }

  for (const game of this._gamesRegistry) {
    // For flash games, check if ROM is installed
    const isFlash = game.type === 'flash';
    const romFile = isFlash ? game.path.match(/swf=\/games\/roms\/(.+?)&/)?.[1] : null;
    const romInstalled = !isFlash || (romFile && flashStatus[decodeURIComponent(romFile)] !== false);

    const card = document.createElement('div');
    card.className = 'activity-card' + (!romInstalled ? ' activity-card-disabled' : '');
    card.dataset.gameId = game.id;
    card.innerHTML = `
      <div class="activity-card-icon">${this._escapeHtml(game.icon)}</div>
      <div class="activity-card-name">${this._escapeHtml(game.name)}</div>
      <div class="activity-card-desc">${this._escapeHtml(game.description || '')}${!romInstalled ? '<br><em style=\"color:var(--text-muted)\">Not installed</em>' : ''}</div>
    `;
    if (romInstalled) {
      card.addEventListener('click', () => {
        this._closeActivitiesModal();
        this._launchGame(game);
      });
    }
    grid.appendChild(card);
  }
  modal.style.display = 'flex';
},

_closeActivitiesModal() {
  const modal = document.getElementById('activities-modal');
  if (modal) modal.style.display = 'none';
},

_launchGame(game) {
  this._currentGame = game;
  // Default: pop out into a new window
  const tok = localStorage.getItem('haven_token') || '';
  const url = game.path + '#token=' + encodeURIComponent(tok);
  this._gameWindow = window.open(url, '_blank', 'width=800,height=900');

  // If popup was blocked, fall back to inline iframe
  if (!this._gameWindow || this._gameWindow.closed) {
    const overlay = document.getElementById('game-iframe-overlay');
    const iframe = document.getElementById('game-iframe');
    const titleEl = document.getElementById('game-iframe-title');
    if (!overlay || !iframe) return;

    this._gameIframe = iframe;
    if (titleEl) titleEl.textContent = `${game.icon} ${game.name}`;
    iframe.src = url;
    overlay.style.display = 'flex';
  }

  // Close activities modal
  this._closeActivitiesModal();

  // Request leaderboard for this game
  this.socket.emit('get-high-scores', { game: game.id });
},

_closeGameIframe() {
  const overlay = document.getElementById('game-iframe-overlay');
  const iframe = document.getElementById('game-iframe');
  if (overlay) overlay.style.display = 'none';
  if (iframe) iframe.src = 'about:blank';
  this._currentGame = null;
  this._gameIframe = null;
},

_popoutGame() {
  if (!this._currentGame) return;
  const tok = localStorage.getItem('haven_token') || '';
  const url = this._currentGame.path + '#token=' + encodeURIComponent(tok);
  this._gameWindow = window.open(url, '_blank', 'width=740,height=860');
  this._closeGameIframe();
},

_showPushError(reason) {
  const modal = document.getElementById('push-error-modal');
  const reasonEl = document.getElementById('push-error-reason');
  if (!modal || !reasonEl) return;

  // Build structured content with browser-specific action buttons
  let html = this._escapeHtml(reason);

  // Detect Brave-specific advice and add a copy button for the settings URL
  if (reason.includes('brave://settings')) {
    const settingsUrl = 'brave://settings/privacy';
    html += `<div style="margin-top:12px;padding:10px;background:var(--bg-secondary);border-radius:6px;font-family:monospace;font-size:13px;display:flex;align-items:center;gap:8px;justify-content:center;">
      <span style="user-select:all;">${settingsUrl}</span>
      <button class="btn-accent" onclick="navigator.clipboard.writeText('${settingsUrl}');this.textContent='Copied!';setTimeout(()=>this.textContent='Copy',1500)"
        style="padding:4px 10px;font-size:12px;min-width:52px;">Copy</button>
    </div>
    <p style="color:var(--text-muted);font-size:11px;margin:8px 0 0;">Paste this into your Brave address bar, then enable "Use Google Services for Push Messaging" and restart Brave.</p>`;
  }

  // Detect permission denied and provide Chrome/Edge settings hints
  if (reason.includes('Permission denied') || reason.includes('permission was denied')) {
    html += `<div style="margin-top:12px;font-size:12px;color:var(--text-secondary);line-height:1.6;">
      <strong>How to fix:</strong><br>
      \u2022 Click the lock/info icon in your address bar → Site settings → Notifications → Allow<br>
      \u2022 Or go to browser settings → Privacy → Site Settings → Notifications
    </div>`;
  }

  // iOS standalone hint
  if (reason.includes('Add to Home Screen')) {
    html += `<div style="margin-top:12px;font-size:12px;color:var(--text-secondary);line-height:1.6;">
      <strong>Steps:</strong><br>
      1. Tap the <strong>Share</strong> button (box with arrow) in Safari<br>
      2. Scroll down and tap <strong>"Add to Home Screen"</strong><br>
      3. Open Haven from your home screen icon
    </div>`;
  }

  reasonEl.innerHTML = html;
  modal.style.display = 'flex';
},

/** Decode HTML entities back to raw characters (for legacy DB content) */
_decodeHtmlEntities(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
},

/** Escape HTML entities for safe innerHTML insertion */
_escapeHtml(str) {
  if (typeof str !== 'string') return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
},

async _subscribePush() {
  const statusEl = document.getElementById('push-notif-status');
  const toggle = document.getElementById('push-notif-enabled');
  try {
    // Request notification permission
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      if (toggle) toggle.checked = false;
      if (statusEl) statusEl.textContent = 'Permission denied';
      this._showPushError(
        'Notification permission was denied. Check your browser\'s site settings and allow notifications for this site, then try again.'
      );
      return;
    }

    // Fetch VAPID public key from server
    const res = await fetch('/api/push/vapid-key');
    if (!res.ok) throw new Error('Server error fetching push key');
    const { publicKey } = await res.json();

    // Convert VAPID key to Uint8Array
    const urlBase64ToUint8Array = (base64String) => {
      const padding = '='.repeat((4 - base64String.length % 4) % 4);
      const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
      const raw = atob(base64);
      const arr = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
      return arr;
    };

    // Subscribe to push
    const sub = await this._swRegistration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey)
    });

    this._pushSubscription = sub;
    const subJson = sub.toJSON();

    // Send subscription to server
    this.socket.emit('push-subscribe', {
      endpoint: subJson.endpoint,
      keys: {
        p256dh: subJson.keys.p256dh,
        auth: subJson.keys.auth
      }
    });

    if (statusEl) statusEl.textContent = 'Subscribing...';
  } catch (err) {
    console.error('Push subscribe error:', err);
    if (toggle) toggle.checked = false;

    const isBrave = navigator.brave && (await navigator.brave.isBrave?.()) || false;
    let reason = `Push subscription failed: ${err.message}`;
    if (isBrave) {
      reason = 'Brave blocked the push subscription.\n\n' +
        'Troubleshooting steps:\n' +
        '1. Open brave://settings/privacy and make sure "Use Google Services for Push Messaging" is ON\n' +
        '2. Click the Brave shields icon (lion) in the address bar for this site and disable shields, then reload\n' +
        '3. Restart Brave completely (close all windows) and reload Haven\n' +
        '4. If none of the above work, try clearing site data or using Chrome/Edge instead.\n\n' +
        'Technical detail: ' + (err.message || 'unknown error');
    } else if (err.message?.includes('push service')) {
      reason = 'The browser\'s push service returned an error. This is usually a browser-level restriction. ' +
        'Try Google Chrome or Microsoft Edge if this persists.';
    }

    if (statusEl) statusEl.textContent = 'Failed';
    this._showPushError(reason);
  }
},

async _unsubscribePush() {
  const statusEl = document.getElementById('push-notif-status');
  try {
    if (this._pushSubscription) {
      const endpoint = this._pushSubscription.endpoint;
      await this._pushSubscription.unsubscribe();
      this._pushSubscription = null;

      // Tell server to remove subscription
      this.socket.emit('push-unsubscribe', { endpoint });
    }
    if (statusEl) statusEl.textContent = 'Disabled';
  } catch (err) {
    console.error('Push unsubscribe error:', err);
    if (statusEl) statusEl.textContent = 'Error';
  }
},

// ── Tunnel Management ─────────────────────────────────

/** Sync tunnel enabled/provider state to server */
async _syncTunnelState(enabled) {
  const provider = document.getElementById('tunnel-provider-select')?.value || 'localtunnel';
  const statusEl = document.getElementById('tunnel-status-display');
  const btn = document.getElementById('tunnel-toggle-btn');
  if (statusEl) statusEl.textContent = enabled ? 'Starting…' : 'Stopping…';
  if (btn) btn.disabled = true;
  try {
    const res = await fetch('/api/tunnel/sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.token}`
      },
      body: JSON.stringify({ enabled, provider })
    });
    if (!res.ok) {
      console.error('Tunnel sync failed:', res.status);
      if (statusEl) statusEl.textContent = 'Sync failed';
      return;
    }
    // Update status from the response directly (no delay needed)
    const data = await res.json();
    this._updateTunnelStatusUI(data);
  } catch (err) {
    console.error('Tunnel sync error:', err);
    if (statusEl) statusEl.textContent = 'Error';
  } finally {
    if (btn) btn.disabled = false;
  }
},

/** Fetch current tunnel status from server and update UI.
 *  If the tunnel is still starting, poll every 2 s until it resolves. */
async _refreshTunnelStatus() {
  try {
    const res = await fetch('/api/tunnel/status', {
      headers: { 'Authorization': `Bearer ${this.token}` }
    });
    if (!res.ok && res.status !== 304) throw new Error(`HTTP ${res.status}`);
    if (res.status === 304) return;  // Not Modified — nothing to update
    const data = await res.json();
    this._updateTunnelStatusUI(data);
    // If still starting, poll again in 2 s
    if (data.starting) {
      clearTimeout(this._tunnelPollTimer);
      this._tunnelPollTimer = setTimeout(() => this._refreshTunnelStatus(), 2000);
    }
  } catch (err) {
    const statusEl = document.getElementById('tunnel-status-display');
    if (statusEl) statusEl.textContent = 'Error checking status';
    console.error('Tunnel status error:', err);
  }
},

/** Update the tunnel status display from a status object */
_updateTunnelStatusUI(data) {
  const statusEl = document.getElementById('tunnel-status-display');
  const btn = document.getElementById('tunnel-toggle-btn');
  if (btn) {
    if (data.active) {
      btn.textContent = 'Stop Tunnel';
      btn.classList.add('btn-danger');
      btn.classList.remove('btn-accent');
    } else {
      btn.textContent = 'Start Tunnel';
      btn.classList.remove('btn-danger');
      btn.classList.add('btn-accent');
    }
  }
  if (!statusEl) return;
  if (data.active && data.url) {
    statusEl.textContent = data.url;
    statusEl.title = 'Tunnel is active — click to copy';
    statusEl.style.cursor = 'pointer';
    statusEl.onclick = () => {
      navigator.clipboard.writeText(data.url);
      statusEl.textContent = 'Copied!';
      setTimeout(() => { statusEl.textContent = data.url; }, 1500);
    };
  } else if (data.starting) {
    statusEl.textContent = 'Starting…';
    statusEl.style.cursor = '';
    statusEl.onclick = null;
  } else {
    statusEl.textContent = data.error || 'Inactive';
    statusEl.style.cursor = '';
    statusEl.onclick = null;
  }
},

// ── Theme System ──────────────────────────────────────

_setupThemes() {
  initThemeSwitcher('theme-selector', this.socket);
},

// ── Status Bar ────────────────────────────────────────

_startStatusBar() {
  // In the Electron desktop shell, always show the status bar regardless of
  // CSS responsive breakpoints or DPI-scaled viewport width.
  if (window.havenDesktop?.isDesktopApp) {
    const sb = document.getElementById('status-bar');
    if (sb) sb.style.display = 'flex';
  }
  this._updateClock();
  if (this._clockInterval) clearInterval(this._clockInterval);
  this._clockInterval = setInterval(() => this._updateClock(), 1000);
},

_updateClock() {
  const now = new Date();
  const h = now.getHours().toString().padStart(2, '0');
  const m = now.getMinutes().toString().padStart(2, '0');
  const s = now.getSeconds().toString().padStart(2, '0');
  document.getElementById('status-clock').textContent = `${h}:${m}:${s}`;
},

_startPingMonitor() {
  if (this.pingInterval) clearInterval(this.pingInterval);

  this.pingInterval = setInterval(() => {
    if (this.socket && this.socket.connected) {
      this._pingStart = Date.now();
      this.socket.emit('ping-check');
    }
  }, 15000);

  // Periodic member list + voice refresh every 30s to keep sidebar in sync
  if (this._memberRefreshInterval) clearInterval(this._memberRefreshInterval);
  this._memberRefreshInterval = setInterval(() => {
    if (this.socket && this.socket.connected && this.currentChannel) {
      this.socket.emit('request-online-users', { code: this.currentChannel });
      this.socket.emit('request-voice-users', { code: this.currentChannel });
    }
  }, 30000);

  this._pingStart = Date.now();
  this.socket.emit('ping-check');
},

_setLed(id, state) {
  const el = document.getElementById(id);
  if (!el) return;
  el.className = 'led ' + state;
},

};
