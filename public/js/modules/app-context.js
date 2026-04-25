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
  profileBtn.innerHTML = `👤 ${t('context.view_profile')}`;
  profileBtn.addEventListener('click', () => {
    this._hideUserContextMenu();
    this._isHoverPopup = false;
    this._profilePopupAnchor = e.target.closest('.user-item') || e.target;
    this.socket.emit('get-user-profile', { userId: targetUserId });
  });
  menu.appendChild(profileBtn);

  // 2) Direct Message
  const dmBtn = document.createElement('button');
  dmBtn.innerHTML = `💬 ${t('users.direct_message')}`;
  dmBtn.addEventListener('click', () => {
    this._hideUserContextMenu();
    this.socket.emit('start-dm', { targetUserId });
    this._showToast(t('users.opening_dm', { name: this._escapeHtml(targetName) }), 'info');
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
    inviteBtn.innerHTML = `📨 ${t('context.invite_to_channel')} <span class="user-ctx-arrow">▸</span>`;
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
  nickBtn.innerHTML = `🏷️ ${t('users.set_nickname')}`;
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
    list.innerHTML = `<p class="muted-text" style="padding:8px">${t('context.no_users')}</p>`;
    return;
  }

  const online = users.filter(u => u.online !== false);
  const offline = users.filter(u => u.online === false);

  let html = '';
  if (online.length > 0) {
    html += `<div class="online-overlay-group">${t('users.online_count', { count: online.length })}</div>`;
    html += online.map(u => this._renderOverlayUserItem(u)).join('');
  }
  if (offline.length > 0) {
    html += `<div class="online-overlay-group offline">${t('users.offline_count', { count: offline.length })}</div>`;
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
  const replyVolume = document.getElementById('notif-reply-volume');
  const replySound = document.getElementById('notif-reply-sound');
  const sentSound = document.getElementById('notif-sent-sound');
  const joinVolume = document.getElementById('notif-join-volume');
  const joinSound = document.getElementById('notif-join-sound');
  const leaveVolume = document.getElementById('notif-leave-volume');
  const leaveSound = document.getElementById('notif-leave-sound');

  toggle.checked = this.notifications.enabled;
  volume.value = this.notifications.volume * 100;
  msgSound.value = this.notifications.sounds.message;
  if (sentSound) sentSound.value = this.notifications.sounds.sent;
  mentionVolume.value = this.notifications.mentionVolume * 100;
  mentionSound.value = this.notifications.sounds.mention;
  if (replyVolume) replyVolume.value = this.notifications.replyVolume * 100;
  if (replySound) replySound.value = this.notifications.sounds.reply;
  if (joinVolume) joinVolume.value = this.notifications.joinVolume * 100;
  if (joinSound) joinSound.value = this.notifications.sounds.join;
  if (leaveVolume) leaveVolume.value = this.notifications.leaveVolume * 100;
  if (leaveSound) leaveSound.value = this.notifications.sounds.leave;

  // Per-type toggles
  const mentionsToggle = document.getElementById('notif-mentions-enabled');
  const repliesToggle = document.getElementById('notif-replies-enabled');
  const dmToggle = document.getElementById('notif-dm-enabled');
  if (mentionsToggle) { mentionsToggle.checked = this.notifications.mentionsEnabled; mentionsToggle.addEventListener('change', () => { this.notifications.mentionsEnabled = mentionsToggle.checked; this.notifications._savePref('haven_notif_mentions_enabled', mentionsToggle.checked); }); }
  if (repliesToggle) { repliesToggle.checked = this.notifications.repliesEnabled; repliesToggle.addEventListener('change', () => { this.notifications.repliesEnabled = repliesToggle.checked; this.notifications._savePref('haven_notif_replies_enabled', repliesToggle.checked); }); }
  if (dmToggle) { dmToggle.checked = this.notifications.dmEnabled; dmToggle.addEventListener('change', () => { this.notifications.dmEnabled = dmToggle.checked; this.notifications._savePref('haven_notif_dm_enabled', dmToggle.checked); }); }

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

  if (replyVolume) {
    replyVolume.addEventListener('input', () => {
      this.notifications.setReplyVolume(replyVolume.value / 100);
    });
  }

  if (replySound) {
    replySound.addEventListener('change', () => {
      this.notifications.setSound('reply', replySound.value);
      this.notifications.play('reply');
    });
  }

  if (joinVolume) {
    joinVolume.addEventListener('input', () => {
      this.notifications.setJoinVolume(joinVolume.value / 100);
    });
  }

  if (joinSound) {
    joinSound.addEventListener('change', () => {
      this.notifications.setSound('join', joinSound.value);
      this.notifications.play('join');
    });
  }

  if (leaveVolume) {
    leaveVolume.addEventListener('input', () => {
      this.notifications.setLeaveVolume(leaveVolume.value / 100);
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

  // Hide voice panel (opt-in)
  const hideVoicePanelToggle = document.getElementById('hide-voice-panel');
  if (hideVoicePanelToggle) {
    hideVoicePanelToggle.checked = localStorage.getItem('haven_hide_voice_panel') === 'true';
    hideVoicePanelToggle.addEventListener('change', () => {
      localStorage.setItem('haven_hide_voice_panel', String(hideVoicePanelToggle.checked));
      const voicePanel = document.getElementById('right-sidebar-voice');
      if (voicePanel) voicePanel.style.display = hideVoicePanelToggle.checked ? 'none' : '';
    });
    // Apply on load
    if (hideVoicePanelToggle.checked) {
      const voicePanel = document.getElementById('right-sidebar-voice');
      if (voicePanel) voicePanel.style.display = 'none';
    }
  }

  // Sidebar voice controls (opt-in)
  const sidebarVoiceToggle = document.getElementById('sidebar-voice-controls');
  if (sidebarVoiceToggle) {
    sidebarVoiceToggle.checked = localStorage.getItem('haven_sidebar_voice_controls') === 'true';
    sidebarVoiceToggle.addEventListener('change', () => {
      localStorage.setItem('haven_sidebar_voice_controls', String(sidebarVoiceToggle.checked));
      // Re-apply button visibility for current voice state
      if (this.voice && this.voice.inVoice) {
        this._updateVoiceButtons(true);
      }
    });
  }

  // Up arrow edits last message (on by default)
  const upArrowEditToggle = document.getElementById('up-arrow-edit');
  if (upArrowEditToggle) {
    upArrowEditToggle.checked = localStorage.getItem('haven_up_arrow_edit') !== 'false';
    upArrowEditToggle.addEventListener('change', () => {
      localStorage.setItem('haven_up_arrow_edit', String(upArrowEditToggle.checked));
    });
  }

  // Show status bar (opt-in — hidden by default, but Desktop always shows its own footer)
  const showStatusBarToggle = document.getElementById('show-status-bar');
  const statusBarToggleTab = document.getElementById('status-bar-toggle');
  const _hasDesktopFooter = !!document.getElementById('haven-desktop-footer');
  if (showStatusBarToggle) {
    showStatusBarToggle.checked = localStorage.getItem('haven_show_statusbar') === 'true';
    const applyStatusBar = () => {
      // On Desktop the preload's own footer is always visible; don't touch it
      if (_hasDesktopFooter) return;
      const show = showStatusBarToggle.checked;
      if (show) {
        document.documentElement.removeAttribute('data-hide-statusbar');
        const sb = document.getElementById('status-bar');
        if (sb) sb.style.setProperty('display', 'flex', 'important');
      } else {
        document.documentElement.setAttribute('data-hide-statusbar', '1');
      }
    };
    showStatusBarToggle.addEventListener('change', () => {
      localStorage.setItem('haven_show_statusbar', String(showStatusBarToggle.checked));
      applyStatusBar();
    });
    applyStatusBar();
  }
  // Toggle tab (visible when bar is hidden) — click to show bar
  if (statusBarToggleTab) {
    statusBarToggleTab.addEventListener('click', () => {
      if (showStatusBarToggle) {
        showStatusBarToggle.checked = true;
        showStatusBarToggle.dispatchEvent(new Event('change'));
      } else {
        // Fallback: toggle directly
        document.documentElement.removeAttribute('data-hide-statusbar');
        const sb = document.getElementById('status-bar');
        if (sb) sb.style.setProperty('display', 'flex', 'important');
        localStorage.setItem('haven_show_statusbar', 'true');
      }
    });
  }

  // ── Score badge visibility ──
  // "Hide other players' badges" is a per-device client-side filter.
  // "Hide my own badge" is a server-side preference so other clients also
  // hide it (and it gets stripped from the leaderboard).
  const hideOtherScoresToggle = document.getElementById('hide-other-scores');
  if (hideOtherScoresToggle) {
    hideOtherScoresToggle.checked = localStorage.getItem('haven_hide_other_scores') === 'true';
    hideOtherScoresToggle.addEventListener('change', () => {
      localStorage.setItem('haven_hide_other_scores', String(hideOtherScoresToggle.checked));
      if (this._lastOnlineUsers) this._renderOnlineUsers(this._lastOnlineUsers);
    });
  }
  const hideOwnScoreToggle = document.getElementById('hide-own-score');
  if (hideOwnScoreToggle) {
    // Initial value comes from the server-synced preferences cache, falling
    // back to localStorage so the toggle reflects intent before prefs land.
    const cached = (this._userPrefs && this._userPrefs.hide_score_badge) || localStorage.getItem('haven_hide_own_score');
    hideOwnScoreToggle.checked = cached === 'true';
    hideOwnScoreToggle.addEventListener('change', () => {
      const v = String(hideOwnScoreToggle.checked);
      localStorage.setItem('haven_hide_own_score', v);
      if (this._userPrefs) this._userPrefs.hide_score_badge = v;
      this.socket?.emit('set-preference', { key: 'hide_score_badge', value: v });
    });
  }

  // ── Server URL in status bar (copyable, privacy toggle) ──
  const statusUrlEl = document.getElementById('status-url-text');
  const statusUrlToggle = document.getElementById('status-url-toggle');
  if (statusUrlEl && statusUrlToggle) {
    const origin = window.location.origin;
    let urlVisible = localStorage.getItem('haven_statusbar_show_url') !== 'false';

    const applyUrlVis = () => {
      if (urlVisible) {
        statusUrlEl.textContent = origin;
        statusUrlEl.classList.remove('url-hidden');
        statusUrlToggle.textContent = '👁';
        statusUrlToggle.title = 'Hide server address';
      } else {
        statusUrlEl.textContent = '••••••••';
        statusUrlEl.classList.add('url-hidden');
        statusUrlToggle.textContent = '👁\u200d🗨';
        statusUrlToggle.title = 'Show server address';
      }
    };
    applyUrlVis();

    statusUrlToggle.addEventListener('click', () => {
      urlVisible = !urlVisible;
      localStorage.setItem('haven_statusbar_show_url', String(urlVisible));
      applyUrlVis();
    });

    // Click to copy — works even when URL is hidden
    statusUrlEl.addEventListener('click', () => {
      navigator.clipboard.writeText(origin).then(() => {
        const orig = statusUrlEl.textContent;
        statusUrlEl.textContent = 'Copied!';
        setTimeout(() => { statusUrlEl.textContent = urlVisible ? origin : '••••••••'; }, 1500);
      }).catch(() => {});
    });
  }
},

// ── Push Notifications (Web Push API) ──────────────────

async _setupPushNotifications() {
  const toggle = document.getElementById('push-notif-enabled');
  const statusEl = document.getElementById('push-notif-status');

  // Haven Desktop provides native OS notifications via app-preload.js — hide the web-push section entirely
  if (window.havenDesktop?.isDesktopApp) {
    const section = document.getElementById('section-push');
    if (section) section.style.display = 'none';
    const navItem = document.querySelector('.settings-nav-item[data-target="section-push"]');
    if (navItem) navItem.style.display = 'none';
    if (toggle) toggle.disabled = true;
    if (statusEl) statusEl.textContent = t('context.push_native_desktop');
    return;
  }

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
    if (statusEl) statusEl.textContent = t('context.push_requires_https');
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
    if (statusEl) statusEl.textContent = t('context.push_not_supported');
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
    if (statusEl) statusEl.textContent = isBrave ? t('context.push_blocked_brave') : t('context.push_registration_failed');
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
  if (statusEl) statusEl.textContent = existingSub ? t('context.push_enabled') : t('context.push_disabled');

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
    if (statusEl) statusEl.textContent = t('context.push_blocked');
    this._pushErrorReason = 'Notification permission was denied. Check your browser\'s site settings and allow notifications for this site, then reload.';
    return;
  }

  // Listen for server confirmation
  this.socket.on('push-subscribed', () => {
    if (statusEl) statusEl.textContent = t('context.push_enabled');
  });
  this.socket.on('push-unsubscribed', () => {
    if (statusEl) statusEl.textContent = t('context.push_disabled');
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
      <span>🎮 ${t('context.flash_not_installed')}</span>
      <button class="btn-sm btn-accent" id="install-flash-btn">${t('context.flash_download_btn')}</button>
    `;
    grid.appendChild(banner);
    banner.querySelector('#install-flash-btn').addEventListener('click', async (e) => {
      const btn = e.target;
      btn.disabled = true;
      btn.textContent = t('context.flash_downloading');
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
        this._showToast(t('context.flash_install_result', { installed, already, errors: errors.length }), installed > 0 ? 'success' : 'error');
        this._flashAllInstalled = errors.length === 0;
        // Refresh modal
        this._openActivitiesModal();
      } catch (err) {
        this._showToast(err.message, 'error');
        btn.disabled = false;
        btn.textContent = t('context.flash_download_btn');
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
      <div class="activity-card-desc">${this._escapeHtml(game.description || '')}${!romInstalled ? `<br><em style="color:var(--text-muted)">${t('context.flash_not_installed_label')}</em>` : ''}</div>
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
  const win = window.open(url, '_blank', 'width=740,height=860');
  // Only close the inline iframe if the popup actually opened
  if (win && !win.closed) {
    this._gameWindow = win;
    this._closeGameIframe();
  } else {
    this._showToast?.('Popup blocked — check your browser settings', 'error');
  }
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
      if (statusEl) statusEl.textContent = t('context.push_permission_denied');
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
  if (!this.user?.isAdmin) return;
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
      const markCopied = () => { statusEl.textContent = 'Copied!'; };
      navigator.clipboard.writeText(data.url).then(markCopied).catch(() => {
        try {
          const ta = document.createElement('textarea');
          ta.value = data.url;
          ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
          document.body.appendChild(ta);
          ta.focus(); ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
          markCopied();
        } catch { /* could not copy */ }
      });
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
  const isDesktop = !!(window.havenDesktop?.isDesktopApp ||
                       navigator.userAgent.includes('Electron'));

  const _forceWebStatusBar = () => {
    const sb = document.getElementById('status-bar');
    if (!sb) return;
    sb.style.setProperty('display', 'flex', 'important');
    // Verify the bar is inside the visible viewport.  If clipped by
    // Electron BrowserView (100dvh mismatch), fall back to fixed positioning.
    requestAnimationFrame(() => {
      const rect = sb.getBoundingClientRect();
      if (rect.height === 0 || rect.bottom > window.innerHeight + 2) {
        sb.style.setProperty('position', 'fixed', 'important');
        sb.style.setProperty('bottom', '0', 'important');
        sb.style.setProperty('left', '0', 'important');
        sb.style.setProperty('right', '0', 'important');
        sb.style.setProperty('z-index', '50', 'important');
        const appBody = document.getElementById('app-body');
        if (appBody) appBody.style.paddingBottom = sb.offsetHeight + 'px';
      }
    });
  };

  if (isDesktop) {
    // Belt-and-suspenders: ensure the CSS attribute is present (preload
    // sets this on DOMContentLoaded, but reinforce here in case of timing)
    document.documentElement.setAttribute('data-desktop-app', '1');
    // If the Desktop preload already injected its own fixed footer bar,
    // don't force the original status bar visible (that causes duplicates)
    const hasDesktopFooter = !!document.getElementById('haven-desktop-footer');
    if (!hasDesktopFooter) {
      _forceWebStatusBar();
    }
    // Delayed fallback: if after 600 ms neither footer is visible (e.g. old
    // Desktop build whose preload hides the web bar but doesn't create its
    // own), force-show the web status bar regardless.
    setTimeout(() => {
      const hdf = document.getElementById('haven-desktop-footer');
      const sb  = document.getElementById('status-bar');
      if (!hdf && sb && getComputedStyle(sb).display === 'none') {
        _forceWebStatusBar();
      }
    }, 600);
  } else {
    // Browser / mobile: respect the user's opt-in preference (default hidden).
    // The settings toggle in _initSettings applies the attribute + display;
    // here we just honour it in case _startStatusBar runs first.
    const sb = document.getElementById('status-bar');
    if (sb && localStorage.getItem('haven_show_statusbar') === 'true') {
      sb.style.setProperty('display', 'flex', 'important');
    }
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

// ═══════════════════════════════════════════════════════════
// Automatic Performance Diagnostics
//
// Starts automatically 30 s after init.  Samples FPS once per second,
// and every 15 s evaluates the trend.  If average FPS is dropping or
// already low, logs a diagnostic snapshot to the console (which the
// Desktop app forwards to its server-log panel).
//
// Manual HUD toggle:  app._perfHUD(true)  / app._perfHUD(false)
// ═══════════════════════════════════════════════════════════

_startPerfDiagnostics() {
  if (this._perfDiag) return; // already running

  const SAMPLE_INTERVAL = 1000;   // measure one FPS reading every 1 s
  const REPORT_INTERVAL = 15000;  // evaluate + log every 15 s
  const FPS_WARN        = 30;     // warn below this average
  const FPS_CRITICAL    = 12;     // critical — user is seeing freeze

  const samples = [];             // rolling window of {fps, ts}
  const MAX_SAMPLES = 60;         // keep last 60 s of FPS readings
  let frameCount = 0;
  let lastSampleTime = performance.now();
  let rafId = null;
  let reportTimer = null;

  // Count frames via rAF
  const countFrame = (now) => {
    rafId = requestAnimationFrame(countFrame);
    frameCount++;
    const elapsed = now - lastSampleTime;
    if (elapsed >= SAMPLE_INTERVAL) {
      const fps = Math.round(frameCount * 1000 / elapsed);
      samples.push({ fps, ts: Date.now() });
      if (samples.length > MAX_SAMPLES) samples.shift();
      frameCount = 0;
      lastSampleTime = now;
    }
  };
  rafId = requestAnimationFrame(countFrame);

  // Periodic evaluation
  reportTimer = setInterval(() => {
    if (samples.length < 5) return; // not enough data yet

    const recent = samples.slice(-15); // last ~15 seconds
    const avgFps = Math.round(recent.reduce((s, r) => s + r.fps, 0) / recent.length);
    const minFps = Math.min(...recent.map(r => r.fps));

    // Trend: compare first half vs second half
    const half = Math.floor(recent.length / 2);
    const firstHalfAvg = recent.slice(0, half).reduce((s, r) => s + r.fps, 0) / half;
    const secondHalfAvg = recent.slice(half).reduce((s, r) => s + r.fps, 0) / (recent.length - half);
    const trend = secondHalfAvg - firstHalfAvg; // negative = degrading

    // Collect system context
    const mem = performance.memory
      ? { heapUsed: Math.round(performance.memory.usedJSHeapSize / 1048576), heapTotal: Math.round(performance.memory.totalJSHeapSize / 1048576) }
      : null;
    const domCount = document.querySelectorAll('*').length;
    const msgCount = document.getElementById('messages')?.children.length || 0;
    const visibleModals = document.querySelectorAll('.modal-overlay[style*="display:flex"], .modal-overlay[style*="display: flex"]').length;
    const isRgbCycling = document.documentElement.classList.contains('rgb-cycling');
    const theme = document.documentElement.getAttribute('data-theme') || 'none';

    // Determine severity
    let severity = null;
    if (avgFps < FPS_CRITICAL) severity = 'CRITICAL';
    else if (avgFps < FPS_WARN) severity = 'WARNING';
    else if (trend < -10 && avgFps < 50) severity = 'DEGRADING';

    if (severity) {
      const report = [
        `[Haven Perf ${severity}]`,
        `FPS avg:${avgFps} min:${minFps} trend:${trend > 0 ? '+' : ''}${Math.round(trend)}`,
        mem ? `Heap:${mem.heapUsed}/${mem.heapTotal}MB` : '',
        `DOM:${domCount} msgs:${msgCount} modals-open:${visibleModals}`,
        `theme:${theme} rgb:${isRgbCycling}`,
        `samples:[${recent.map(r => r.fps).join(',')}]`,
      ].filter(Boolean).join(' | ');
      console.warn(report);
    }

    // Always log a quiet heartbeat every 60 s (every 4th report) for baseline tracking
    if (samples.length % 4 === 0) {
      console.log(`[Haven Perf] FPS:${avgFps} trend:${trend > 0 ? '+' : ''}${Math.round(trend)} DOM:${domCount}${mem ? ' heap:' + mem.heapUsed + 'MB' : ''} rgb:${isRgbCycling}`);
    }
  }, REPORT_INTERVAL);

  this._perfDiag = { rafId, reportTimer, samples };
},

// Toggle visual HUD overlay: app._perfHUD(true)
_perfHUD(enable) {
  if (!enable) {
    if (this._perfHudRAF) cancelAnimationFrame(this._perfHudRAF);
    this._perfHudRAF = null;
    const hud = document.getElementById('_perf_hud');
    if (hud) hud.remove();
    return;
  }
  if (this._perfHudRAF) return;
  const hud = document.createElement('div');
  hud.id = '_perf_hud';
  hud.style.cssText = 'position:fixed;top:4px;right:4px;z-index:999999;background:rgba(0,0,0,.85);color:#0f0;font:12px monospace;padding:6px 10px;border-radius:4px;pointer-events:none;white-space:pre';
  document.body.appendChild(hud);
  let frames = 0, lastSec = performance.now();
  const tick = (now) => {
    this._perfHudRAF = requestAnimationFrame(tick);
    frames++;
    if (now - lastSec >= 1000) {
      const fps = Math.round(frames * 1000 / (now - lastSec));
      const mem = performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : '?';
      const dom = document.querySelectorAll('*').length;
      const rgb = document.documentElement.classList.contains('rgb-cycling') ? ' RGB' : '';
      hud.textContent = `FPS: ${fps}  Heap: ${mem} MB  DOM: ${dom}${rgb}`;
      frames = 0;
      lastSec = now;
    }
  };
  this._perfHudRAF = requestAnimationFrame(tick);
},

};
