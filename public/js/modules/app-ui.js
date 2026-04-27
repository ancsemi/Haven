export default {

// ── UI Event Bindings ─────────────────────────────────

// Shared keydown handler for any input that supports @mention / :emoji /
// /slash autocomplete. Returns true if the event was consumed. (#5296)
_handleAutocompleteKeydown(e) {
  const emojiDd = document.getElementById('emoji-dropdown');
  if (emojiDd && emojiDd.style.display !== 'none') {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      this._navigateEmojiDropdown(e.key === 'ArrowDown' ? 1 : -1);
      return true;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      const active = emojiDd.querySelector('.emoji-ac-item.active');
      if (active) { e.preventDefault(); active.click(); return true; }
    }
    if (e.key === 'Escape') { this._hideEmojiDropdown(); return true; }
  }
  const slashDd = document.getElementById('slash-dropdown');
  if (slashDd && slashDd.style.display !== 'none') {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      this._navigateSlashDropdown(e.key === 'ArrowDown' ? 1 : -1);
      return true;
    }
    if (e.key === 'Tab') {
      const active = slashDd.querySelector('.slash-item.active');
      if (active) { e.preventDefault(); active.click(); return true; }
    }
    if (e.key === 'Escape') { this._hideSlashDropdown(); return true; }
  }
  const dropdown = document.getElementById('mention-dropdown');
  if (dropdown && dropdown.style.display !== 'none') {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      this._navigateMentionDropdown(e.key === 'ArrowDown' ? 1 : -1);
      return true;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      const active = dropdown.querySelector('.mention-item.active');
      if (active) { e.preventDefault(); active.click(); return true; }
    }
    if (e.key === 'Escape') { this._hideMentionDropdown(); return true; }
  }
  return false;
},

_setupUI() {
  const msgInput = document.getElementById('message-input');

  // Shorter placeholder on narrow screens to prevent wrapping
  if (window.innerWidth <= 480) {
    msgInput.placeholder = t('app.messages.placeholder_short');
  }

  msgInput.addEventListener('keydown', (e) => {
    // If emoji dropdown is visible, hijack arrow keys, enter, tab, escape
    const emojiDd = document.getElementById('emoji-dropdown');
    if (emojiDd && emojiDd.style.display !== 'none') {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        this._navigateEmojiDropdown(e.key === 'ArrowDown' ? 1 : -1);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        const active = emojiDd.querySelector('.emoji-ac-item.active');
        if (active) { e.preventDefault(); active.click(); return; }
      }
      if (e.key === 'Escape') { this._hideEmojiDropdown(); return; }
    }

    // If slash dropdown is visible, hijack arrow keys and enter
    const slashDd = document.getElementById('slash-dropdown');
    if (slashDd && slashDd.style.display !== 'none') {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        this._navigateSlashDropdown(e.key === 'ArrowDown' ? 1 : -1);
        return;
      }
      if (e.key === 'Tab') {
        const active = slashDd.querySelector('.slash-item.active');
        if (active) { e.preventDefault(); active.click(); return; }
      }
      if (e.key === 'Escape') { this._hideSlashDropdown(); return; }
    }

    // If mention dropdown is visible, hijack arrow keys and enter
    const dropdown = document.getElementById('mention-dropdown');
    if (dropdown && dropdown.style.display !== 'none') {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        this._navigateMentionDropdown(e.key === 'ArrowDown' ? 1 : -1);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        const active = dropdown.querySelector('.mention-item.active');
        if (active) {
          e.preventDefault();
          active.click();
          return;
        }
      }
      if (e.key === 'Escape') {
        this._hideMentionDropdown();
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      this._sendMessage();
    }

    // Up arrow on empty input → edit last own message (toggleable)
    if (e.key === 'ArrowUp' && !msgInput.value && localStorage.getItem('haven_up_arrow_edit') !== 'false') {
      const msgs = document.getElementById('messages');
      const allMsgs = [...msgs.querySelectorAll('.message, .message-compact')];
      for (let i = allMsgs.length - 1; i >= 0; i--) {
        const el = allMsgs[i];
        if (parseInt(el.dataset.userId) === this.user.id && !el.classList.contains('editing')) {
          e.preventDefault();
          this._startEditMessage(el, parseInt(el.dataset.msgId));
          break;
        }
      }
    }
  });

  msgInput.addEventListener('input', () => {
    const maxH = window.innerWidth <= 480 ? 90 : 120;
    msgInput.style.height = 'auto';
    msgInput.style.height = Math.min(msgInput.scrollHeight, maxH) + 'px';

    const now = Date.now();
    if (now - this.lastTypingEmit > 2000 && this.currentChannel) {
      this.socket.emit('typing', { code: this.currentChannel });
      this.lastTypingEmit = now;
    }

    // Check for @mention trigger
    this._checkMentionTrigger();
    // Check for :emoji autocomplete trigger
    this._checkEmojiTrigger();
    // Check for /command trigger
    this._checkSlashTrigger();
  });

  document.getElementById('send-btn').addEventListener('click', () => this._sendMessage());

  // Join channel
  const joinBtn = document.getElementById('join-channel-btn');
  const codeInput = document.getElementById('channel-code-input');
  joinBtn.addEventListener('click', () => {
    const code = codeInput.value.trim();
    if (code) { this.socket.emit('join-channel', { code }); codeInput.value = ''; }
  });
  codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinBtn.click(); });

  // Create channel (admin)
  const createBtn = document.getElementById('create-channel-btn');
  const nameInput = document.getElementById('new-channel-name');
  if (createBtn) {
    createBtn.addEventListener('click', () => {
      const name = nameInput.value.trim();
      const isPrivate = document.getElementById('new-channel-private')?.checked || false;
      const temporary = document.getElementById('new-channel-temporary')?.checked || false;
      const duration = parseInt(document.getElementById('new-channel-duration')?.value, 10) || 24;
      const addAllMembers = document.getElementById('new-channel-add-all')?.checked || false;
      if (name) {
        this.socket.emit('create-channel', { name, isPrivate, temporary, duration, addAllMembers });
        nameInput.value = '';
        const pvt = document.getElementById('new-channel-private');
        if (pvt) pvt.checked = false;
        const tmp = document.getElementById('new-channel-temporary');
        if (tmp) tmp.checked = false;
        const all = document.getElementById('new-channel-add-all');
        if (all) all.checked = false;
        const durRow = document.getElementById('temp-channel-duration-row');
        if (durRow) durRow.style.display = 'none';
      }
    });
    nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') createBtn.click(); });
  }

  // Toggle temporary channel duration row
  const tempCheckbox = document.getElementById('new-channel-temporary');
  if (tempCheckbox) {
    tempCheckbox.addEventListener('change', () => {
      const durRow = document.getElementById('temp-channel-duration-row');
      if (durRow) durRow.style.display = tempCheckbox.checked ? '' : 'none';
    });
  }

  // Copy code
  document.getElementById('copy-code-btn').addEventListener('click', () => {
    if (this.currentChannel) {
      const ch = this.channels.find(c => c.code === this.currentChannel);
      const codeToCopy = ch && ch.display_code !== '••••••••' ? this.currentChannel : null;
      if (codeToCopy) {
        const onCopied = () => this._showToast(t('toasts.channel_code_copied'), 'success');
        navigator.clipboard.writeText(codeToCopy).then(onCopied).catch(() => {
          try {
            const ta = document.createElement('textarea');
            ta.value = codeToCopy;
            ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
            document.body.appendChild(ta);
            ta.focus(); ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
            onCopied();
          } catch { /* could not copy */ }
        });
      }
    }
  });

  // Delete channel
  // ── Channel context menu ("..." on hover) ──────────
  this._initChannelContextMenu();
  this._initDmContextMenu();
  // Delete channel with TWO confirmations (from ctx menu)
  document.querySelector('[data-action="delete"]')?.addEventListener('click', () => {
    const code = this._ctxMenuChannel;
    if (!code) return;
    this._closeChannelCtxMenu();
    if (!confirm('⚠️ ' + t('confirm.delete_channel'))) return;
    if (!confirm('⚠️ ' + t('confirm.delete_channel_sure'))) return;
    this.socket.emit('delete-channel', { code });
  });
  // Mark channel as read
  document.querySelector('#channel-ctx-menu [data-action="mark-read"]')?.addEventListener('click', () => {
    const code = this._ctxMenuChannel;
    if (!code) return;
    this._closeChannelCtxMenu();
    this.unreadCounts[code] = 0;
    this._updateBadge(code);
    this.socket.emit('mark-read-channel', { code });
  });
  // Mute channel toggle
  document.querySelector('#channel-ctx-menu [data-action="mute"]')?.addEventListener('click', () => {
    const code = this._ctxMenuChannel;
    if (!code) return;
    this._closeChannelCtxMenu();
    const muted = JSON.parse(localStorage.getItem('haven_muted_channels') || '[]');
    const idx = muted.indexOf(code);
    if (idx >= 0) { muted.splice(idx, 1); this._showToast(t('toasts.channel_unmuted'), 'success'); }
    else { muted.push(code); this._showToast(t('toasts.channel_muted'), 'success'); }
    localStorage.setItem('haven_muted_channels', JSON.stringify(muted));
    this._renderChannels();
  });
  // Copy channel link from context menu
  document.querySelector('#channel-ctx-menu [data-action="copy-channel-link"]')?.addEventListener('click', () => {
    const code = this._ctxMenuChannel;
    if (!code) return;
    this._closeChannelCtxMenu();
    this._copyChannelLink(code);
  });
  // Join voice from context menu
  document.querySelector('[data-action="join-voice"]')?.addEventListener('click', () => {
    const code = this._ctxMenuChannel;
    if (!code) return;
    this._closeChannelCtxMenu();
    // Switch to the channel first, then join voice
    this.switchChannel(code);
    setTimeout(() => this._joinVoice(), 300);
  });
  // Leave channel
  document.querySelector('[data-action="leave-channel"]')?.addEventListener('click', () => {
    const code = this._ctxMenuChannel;
    if (!code) return;
    this._closeChannelCtxMenu();
    const ch = this.channels.find(c => c.code === code);
    const name = ch ? ch.name : code;
    if (!confirm(t('confirm.leave_channel', { name }))) return;
    this.socket.emit('leave-channel', { code }, (res) => {
      if (res && res.error) { this._showToast(res.error, 'error'); return; }
      this._showToast(t('toasts.left_channel', { name }), 'success');
      // Switch to another channel if we're currently in this one
      if (this.currentChannel === code) {
        const remaining = this.channels.filter(c => c.code !== code && !c.is_dm);
        if (remaining.length) this.switchChannel(remaining[0].code);
      }
    });
  });
  // Disconnect from voice via context menu
  document.querySelector('[data-action="leave-voice"]')?.addEventListener('click', () => {
    this._closeChannelCtxMenu();
    this._leaveVoice();
  });
  // Channel Functions panel toggle — sideways popout
  document.querySelector('[data-action="channel-functions"]')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const panel = document.getElementById('channel-functions-panel');
    if (!panel) return;
    const isHidden = panel.style.display === 'none' || panel.style.display === '';
    if (isHidden) {
      panel.style.display = 'block';
      // Position the panel to the right of the context menu
      const menu = this._ctxMenuEl;
      if (menu) {
        const menuRect = menu.getBoundingClientRect();
        const btnRect = e.currentTarget.getBoundingClientRect();
        let left = menuRect.right + 4;
        let top = btnRect.top;
        // Show on screen, measure, then adjust
        panel.style.left = left + 'px';
        panel.style.top = top + 'px';
        requestAnimationFrame(() => {
          const pr = panel.getBoundingClientRect();
          // If it overflows right, flip to the left side
          if (pr.right > window.innerWidth - 8) {
            left = menuRect.left - pr.width - 4;
          }
          // If it overflows bottom, nudge up
          if (pr.bottom > window.innerHeight - 8) {
            top = Math.max(4, window.innerHeight - pr.height - 8);
          }
          panel.style.left = left + 'px';
          panel.style.top = top + 'px';
        });
      }
    } else {
      panel.style.display = 'none';
    }
  });
  // Channel Functions panel — row clicks
  document.getElementById('channel-functions-panel')?.addEventListener('click', (e) => {
    const row = e.target.closest('.cfn-row');
    if (!row || row.classList.contains('cfn-disabled')) return;
    e.stopPropagation();
    const fn = row.dataset.fn;
    const code = this._ctxMenuChannel;
    if (!code) return;
    const ch = this.channels.find(c => c.code === code);

    // Helper: optimistically update ch, re-render panel
    const optimistic = (patch) => {
      if (ch) Object.assign(ch, patch);
      this._updateChannelFunctionsPanel(ch);
    };

    if (fn === 'streams') {
      const newVal = ch && ch.streams_enabled === 0 ? 1 : 0;
      optimistic({ streams_enabled: newVal });
      this.socket.emit('toggle-channel-permission', { code, permission: 'streams' });
    } else if (fn === 'music') {
      const newVal = ch && ch.music_enabled === 0 ? 1 : 0;
      optimistic({ music_enabled: newVal });
      this.socket.emit('toggle-channel-permission', { code, permission: 'music' });
    } else if (fn === 'media') {
      const newVal = ch && ch.media_enabled === 0 ? 1 : 0;
      optimistic({ media_enabled: newVal });
      this.socket.emit('toggle-channel-permission', { code, permission: 'media' });
    } else if (fn === 'read-only') {
      const newVal = ch && ch.read_only ? 0 : 1;
      optimistic({ read_only: newVal });
      this.socket.emit('toggle-channel-permission', { code, permission: 'read_only' });
    } else if (fn === 'slow-mode') {
      const badge = row.querySelector('.cfn-badge');
      if (!badge || badge.tagName === 'INPUT') return;
      const current = (ch && ch.slow_mode_interval) || 0;
      const input = document.createElement('input');
      input.type = 'number'; input.min = '0'; input.max = '3600';
      input.value = current; input.className = 'cfn-input';
      input.onclick = e2 => e2.stopPropagation();
      badge.replaceWith(input);
      input.focus(); input.select();
      const commit = () => {
        const interval = parseInt(input.value);
        if (!isNaN(interval) && interval >= 0 && interval <= 3600) {
          optimistic({ slow_mode_interval: interval });
          this.socket.emit('set-slow-mode', { code, interval });
        }
      };
      input.addEventListener('keydown', e2 => { if (e2.key === 'Enter') { commit(); input.blur(); } });
      input.addEventListener('blur', commit);
    } else if (fn === 'cleanup-exempt') {
      const newVal = ch && ch.cleanup_exempt === 1 ? 0 : 1;
      optimistic({ cleanup_exempt: newVal });
      this.socket.emit('toggle-cleanup-exempt', { code });
    } else if (fn === 'voice') {
      const newVal = ch && ch.voice_enabled === 0 ? 1 : 0;
      // Disabling voice also disables streams and music
      const patch = { voice_enabled: newVal };
      if (newVal === 0) { patch.streams_enabled = 0; patch.music_enabled = 0; }
      optimistic(patch);
      this.socket.emit('toggle-channel-permission', { code, permission: 'voice' });
    } else if (fn === 'text') {
      const newVal = ch && ch.text_enabled === 0 ? 1 : 0;
      optimistic({ text_enabled: newVal });
      this.socket.emit('toggle-channel-permission', { code, permission: 'text' });
    } else if (fn === 'announcement') {
      const isAnnouncement = ch && ch.notification_type === 'announcement';
      const newType = isAnnouncement ? 'default' : 'announcement';
      optimistic({ notification_type: newType });
      this.socket.emit('set-notification-type', { code, type: newType });
    } else if (fn === 'user-limit') {
      // If an input is already showing, don't open another
      if (row.querySelector('.cfn-input')) return;
      const badge = row.querySelector('.cfn-badge');
      if (!badge) return;
      const current = (ch && ch.voice_user_limit) || 0;
      const input = document.createElement('input');
      input.type = 'number'; input.min = '2'; input.max = '99';
      input.value = current >= 2 ? current : ''; input.placeholder = t('channel_functions.voice_limit_placeholder'); input.className = 'cfn-input';
      input.onclick = e2 => e2.stopPropagation();
      badge.replaceWith(input);
      input.focus(); input.select();
      const commitLimit = () => {
        const raw = parseInt(input.value);
        // Blank or less than 2 = unlimited (0). Valid range: 2–99.
        const limit = (!isNaN(raw) && raw >= 2 && raw <= 99) ? raw : 0;
        optimistic({ voice_user_limit: limit });
        this.socket.emit('set-voice-user-limit', { code, limit });
      };
      input.addEventListener('keydown', e2 => { if (e2.key === 'Enter') { commitLimit(); input.blur(); } });
      input.addEventListener('blur', commitLimit);
    } else if (fn === 'voice-bitrate') {
      if (row.querySelector('.cfn-input')) return;
      const badge = row.querySelector('.cfn-badge');
      if (!badge) return;
      const current = (ch && ch.voice_bitrate) || 0;
      const input = document.createElement('input');
      input.type = 'number'; input.min = '0'; input.max = '512';
      input.value = current > 0 ? current : ''; input.placeholder = t('channel_functions.bitrate_placeholder'); input.className = 'cfn-input';
      input.onclick = e2 => e2.stopPropagation();
      badge.replaceWith(input);
      input.focus(); input.select();
      const commitBitrate = () => {
        const raw = parseInt(input.value);
        const validBitrates = [0, 32, 64, 96, 128, 256, 512];
        // Snap to nearest valid bitrate, or 0 if blank/invalid
        let bitrate = 0;
        if (!isNaN(raw) && raw > 0) {
          bitrate = validBitrates.reduce((prev, curr) =>
            Math.abs(curr - raw) < Math.abs(prev - raw) ? curr : prev
          );
        }
        optimistic({ voice_bitrate: bitrate });
        this.socket.emit('set-voice-bitrate', { code, bitrate });
      };
      input.addEventListener('keydown', e2 => { if (e2.key === 'Enter') { commitBitrate(); input.blur(); } });
      input.addEventListener('blur', commitBitrate);
    } else if (fn === 'self-destruct') {
      if (row.querySelector('.cfn-input')) return;
      const badge = row.querySelector('.cfn-badge');
      if (!badge) return;
      const input = document.createElement('input');
      input.type = 'number'; input.min = '0'; input.max = '720';
      input.value = ''; input.placeholder = t('channel_functions.self_destruct_placeholder'); input.className = 'cfn-input';
      input.onclick = e2 => e2.stopPropagation();
      badge.replaceWith(input);
      input.focus(); input.select();
      const commitExpiry = () => {
        const hours = parseInt(input.value);
        if (isNaN(hours) || hours < 0) return;
        if (hours === 0) {
          optimistic({ expires_at: null });
          this.socket.emit('set-channel-expiry', { code, hours: 0 });
        } else {
          const clamped = Math.max(1, Math.min(720, hours));
          const expiresAt = new Date(Date.now() + clamped * 3600000).toISOString();
          optimistic({ expires_at: expiresAt });
          this.socket.emit('set-channel-expiry', { code, hours: clamped });
        }
      };
      input.addEventListener('keydown', e2 => { if (e2.key === 'Enter') { commitExpiry(); input.blur(); } });
      input.addEventListener('blur', commitExpiry);
    } else if (fn === 'afk-sub') {
      // Show a select dropdown of sub-channels for this parent
      if (row.querySelector('.cfn-select')) return;
      const badge = row.querySelector('.cfn-badge');
      if (!badge) return;
      const subs = (this.channels || []).filter(c => c.parent_channel_id === ch?.id);
      const select = document.createElement('select');
      select.className = 'cfn-select cfn-input';
      select.onclick = e2 => e2.stopPropagation();
      const noneOpt = document.createElement('option');
      noneOpt.value = ''; noneOpt.textContent = 'None (disabled)';
      select.appendChild(noneOpt);
      for (const sub of subs) {
        const opt = document.createElement('option');
        opt.value = sub.code;
        opt.textContent = sub.name;
        if (sub.code === ch?.afk_sub_code) opt.selected = true;
        select.appendChild(opt);
      }
      badge.replaceWith(select);
      select.focus();
      const commitAfkSub = () => {
        const subCode = select.value;
        const timeout = ch?.afk_timeout_minutes || 5;
        optimistic({ afk_sub_code: subCode || null });
        this.socket.emit('set-channel-afk', { code, subCode, timeout });
      };
      select.addEventListener('change', () => { commitAfkSub(); select.blur(); });
      select.addEventListener('blur', () => {
        // Replace select back with badge
        this._updateChannelFunctionsPanel(ch);
      });
    } else if (fn === 'afk-timeout') {
      if (row.querySelector('.cfn-input')) return;
      const badge = row.querySelector('.cfn-badge');
      if (!badge) return;
      const current = ch?.afk_timeout_minutes || 0;
      const input = document.createElement('input');
      input.type = 'number'; input.min = '0'; input.max = '1440';
      input.value = current > 0 ? current : ''; input.placeholder = '1–1440 (0=off)'; input.className = 'cfn-input';
      input.onclick = e2 => e2.stopPropagation();
      badge.replaceWith(input);
      input.focus(); input.select();
      const commitAfkTimeout = () => {
        const mins = parseInt(input.value);
        const timeout = (!isNaN(mins) && mins >= 0 && mins <= 1440) ? mins : 0;
        const subCode = ch?.afk_sub_code || '';
        optimistic({ afk_timeout_minutes: timeout });
        this.socket.emit('set-channel-afk', { code, subCode, timeout });
      };
      input.addEventListener('keydown', e2 => { if (e2.key === 'Enter') { commitAfkTimeout(); input.blur(); } });
      input.addEventListener('blur', commitAfkTimeout);
    }
  });
  // Move channel up/down
  document.querySelector('[data-action="organize"]')?.addEventListener('click', () => {
    const code = this._ctxMenuChannel;
    if (!code) return;
    this._closeChannelCtxMenu();
    this._openOrganizeModal(code);
  });
  // Move to parent (reparent)
  document.querySelector('[data-action="move-to-parent"]')?.addEventListener('click', () => {
    const code = this._ctxMenuChannel;
    if (!code) return;
    this._closeChannelCtxMenu();
    this._openReparentModal(code);
  });
  // Promote sub-channel to top-level
  document.querySelector('[data-action="promote-channel"]')?.addEventListener('click', () => {
    const code = this._ctxMenuChannel;
    if (!code) return;
    this._closeChannelCtxMenu();
    const ch = this.channels.find(c => c.code === code);
    if (!ch || !ch.parent_channel_id) return;
    if (confirm(t('confirm.promote_channel', { name: ch.name }))) {
      this.socket.emit('reparent-channel', { code, newParentCode: null });
    }
  });
  // Reparent modal cancel
  document.getElementById('reparent-cancel-btn')?.addEventListener('click', () => {
    document.getElementById('reparent-modal').style.display = 'none';
  });
  document.getElementById('reparent-modal')?.addEventListener('click', (e) => {
    if (e.target.classList.contains('modal-overlay')) {
      document.getElementById('reparent-modal').style.display = 'none';
    }
  });
  // Organize modal controls
  document.getElementById('organize-global-sort')?.addEventListener('change', (e) => {
    if (!this._organizeParentCode) return;
    const sortMode = e.target.value; // 'server_default', 'manual', 'alpha', 'created', 'oldest', 'dynamic'
    if (this._organizeServerLevel) {
      if (sortMode === 'server_default') {
        // Use server default — remove any personal override
        localStorage.removeItem('haven_server_sort_mode');
      } else if (this.user?.isAdmin || this._hasPerm('manage_server')) {
        // Admin: update the server-wide default sort mode
        this.socket.emit('update-server-setting', { key: 'channel_sort_mode', value: sortMode });
        localStorage.removeItem('haven_server_sort_mode');
      } else {
        // Non-admin: save as personal override only
        localStorage.setItem('haven_server_sort_mode', sortMode);
      }
    } else {
      // Sub-channel sort: store on the parent channel (server-side)
      this.socket.emit('set-sort-alphabetical', { code: this._organizeParentCode, enabled: sortMode === 'alpha', mode: sortMode });
      const parent = this.channels.find(c => c.code === this._organizeParentCode);
      if (parent) parent.sort_alphabetical = sortMode === 'alpha' ? 1 : sortMode === 'created' ? 2 : sortMode === 'oldest' ? 3 : sortMode === 'dynamic' ? 4 : 0;
    }
    this._renderOrganizeList();
    if (this._organizeServerLevel) this._renderChannels();
  });
  document.getElementById('organize-cat-sort')?.addEventListener('change', (e) => {
    if (!this._organizeParentCode) return;
    this._organizeCatSort = e.target.value;
    localStorage.setItem(`haven_cat_sort_${this._organizeParentCode}`, e.target.value);
    // Server-level: sync category sort to server so all users see it
    if (this._organizeServerLevel && (this.user?.isAdmin || this._hasPerm('manage_server'))) {
      this.socket.emit('update-server-setting', { key: 'channel_cat_sort', value: e.target.value });
    }
    this._renderOrganizeList();
    if (this._organizeServerLevel) this._renderChannels();
  });
  document.getElementById('organize-move-up')?.addEventListener('click', () => {
    // Category movement
    if (this._organizeSelectedTag) {
      this._moveCategoryInOrder(-1);
      return;
    }
    if (!this._organizeSelected) return;
    const ch = this._organizeList.find(c => c.code === this._organizeSelected);
    if (!ch) return;
    const { group, effectiveSort } = this._getOrganizeVisualGroup(ch);
    if (effectiveSort !== 'manual') return;
    const groupIdx = group.findIndex(c => c.code === this._organizeSelected);
    if (groupIdx <= 0) return;
    // Swap in the sorted group, then reassign group positions cleanly
    [group[groupIdx], group[groupIdx - 1]] = [group[groupIdx - 1], group[groupIdx]];
    const positions = group.map(c => c.position ?? 0).sort((a, b) => a - b);
    for (let i = 1; i < positions.length; i++) { if (positions[i] <= positions[i - 1]) positions[i] = positions[i - 1] + 1; }
    group.forEach((c, i) => { c.position = positions[i]; });
    this._renderOrganizeList();
    this.socket.emit('reorder-channels', { order: this._organizeList.map(c => ({ code: c.code, position: c.position })) });
  });
  document.getElementById('organize-move-down')?.addEventListener('click', () => {
    // Category movement
    if (this._organizeSelectedTag) {
      this._moveCategoryInOrder(1);
      return;
    }
    if (!this._organizeSelected) return;
    const ch = this._organizeList.find(c => c.code === this._organizeSelected);
    if (!ch) return;
    const { group, effectiveSort } = this._getOrganizeVisualGroup(ch);
    if (effectiveSort !== 'manual') return;
    const groupIdx = group.findIndex(c => c.code === this._organizeSelected);
    if (groupIdx < 0 || groupIdx >= group.length - 1) return;
    // Swap in the sorted group, then reassign group positions cleanly
    [group[groupIdx], group[groupIdx + 1]] = [group[groupIdx + 1], group[groupIdx]];
    const positions = group.map(c => c.position ?? 0).sort((a, b) => a - b);
    for (let i = 1; i < positions.length; i++) { if (positions[i] <= positions[i - 1]) positions[i] = positions[i - 1] + 1; }
    group.forEach((c, i) => { c.position = positions[i]; });
    this._renderOrganizeList();
    this.socket.emit('reorder-channels', { order: this._organizeList.map(c => ({ code: c.code, position: c.position })) });
  });
  document.getElementById('organize-set-tag')?.addEventListener('click', () => {
    if (!this._organizeSelected) return;
    const tag = document.getElementById('organize-tag-input').value.trim();
    if (!tag) return;
    this.socket.emit('set-channel-category', { code: this._organizeSelected, category: tag });
    const ch = this._organizeList.find(c => c.code === this._organizeSelected);
    if (ch) ch.category = tag;
    // Also update main channels array
    const mainCh = this.channels.find(c => c.code === this._organizeSelected);
    if (mainCh) mainCh.category = tag;
    this._renderOrganizeList();
  });
  document.getElementById('organize-remove-tag')?.addEventListener('click', () => {
    if (!this._organizeSelected) return;
    this.socket.emit('set-channel-category', { code: this._organizeSelected, category: '' });
    const ch = this._organizeList.find(c => c.code === this._organizeSelected);
    if (ch) ch.category = null;
    const mainCh = this.channels.find(c => c.code === this._organizeSelected);
    if (mainCh) mainCh.category = null;
    document.getElementById('organize-tag-input').value = '';
    this._renderOrganizeList();
  });
  document.getElementById('organize-done-btn')?.addEventListener('click', () => {
    document.getElementById('organize-modal').style.display = 'none';
    if (this._organizeServerLevel) this._renderChannels();
    this._organizeParentCode = null;
    this._organizeList = null;
    this._organizeSelected = null;
    this._organizeSelectedTag = null;
    this._organizeServerLevel = false;
  });
  document.getElementById('organize-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'organize-modal') {
      document.getElementById('organize-modal').style.display = 'none';
      if (this._organizeServerLevel) this._renderChannels();
      this._organizeParentCode = null;
      this._organizeList = null;
      this._organizeSelected = null;
      this._organizeSelectedTag = null;
      this._organizeServerLevel = false;
    }
  });
  // ── DM Organize Modal ──
  document.getElementById('organize-dms-btn')?.addEventListener('click', (e) => {
    e.stopPropagation(); // don't toggle DM collapse
    this._openDmOrganizeModal();
  });
  document.getElementById('dm-organize-sort')?.addEventListener('change', () => {
    const mode = document.getElementById('dm-organize-sort').value;
    localStorage.setItem('haven_dm_sort_mode', mode);
    this._renderDmOrganizeList();
  });
  document.getElementById('dm-organize-move-up')?.addEventListener('click', () => {
    if (!this._dmOrganizeSelected) return;
    const idx = this._dmOrganizeList.findIndex(c => c.code === this._dmOrganizeSelected);
    if (idx <= 0) return;
    [this._dmOrganizeList[idx], this._dmOrganizeList[idx - 1]] = [this._dmOrganizeList[idx - 1], this._dmOrganizeList[idx]];
    this._saveDmOrder();
    this._renderDmOrganizeList();
  });
  document.getElementById('dm-organize-move-down')?.addEventListener('click', () => {
    if (!this._dmOrganizeSelected) return;
    const idx = this._dmOrganizeList.findIndex(c => c.code === this._dmOrganizeSelected);
    if (idx < 0 || idx >= this._dmOrganizeList.length - 1) return;
    [this._dmOrganizeList[idx], this._dmOrganizeList[idx + 1]] = [this._dmOrganizeList[idx + 1], this._dmOrganizeList[idx]];
    this._saveDmOrder();
    this._renderDmOrganizeList();
  });
  document.getElementById('dm-organize-set-tag')?.addEventListener('click', () => {
    if (!this._dmOrganizeSelected) return;
    const tag = document.getElementById('dm-organize-tag-input').value.trim();
    if (!tag) return;
    const assignments = JSON.parse(localStorage.getItem('haven_dm_assignments') || '{}');
    assignments[this._dmOrganizeSelected] = tag;
    localStorage.setItem('haven_dm_assignments', JSON.stringify(assignments));
    // Ensure category entry exists
    const cats = JSON.parse(localStorage.getItem('haven_dm_categories') || '{}');
    if (!cats[tag]) cats[tag] = { collapsed: false };
    localStorage.setItem('haven_dm_categories', JSON.stringify(cats));
    this._renderDmOrganizeList();
  });
  document.getElementById('dm-organize-remove-tag')?.addEventListener('click', () => {
    if (!this._dmOrganizeSelected) return;
    const assignments = JSON.parse(localStorage.getItem('haven_dm_assignments') || '{}');
    delete assignments[this._dmOrganizeSelected];
    localStorage.setItem('haven_dm_assignments', JSON.stringify(assignments));
    document.getElementById('dm-organize-tag-input').value = '';
    this._renderDmOrganizeList();
  });
  document.getElementById('dm-organize-done-btn')?.addEventListener('click', () => {
    document.getElementById('dm-organize-modal').style.display = 'none';
    this._dmOrganizeList = null;
    this._dmOrganizeSelected = null;
    this._renderChannels();
  });
  document.getElementById('dm-organize-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'dm-organize-modal') {
      document.getElementById('dm-organize-modal').style.display = 'none';
      this._dmOrganizeList = null;
      this._dmOrganizeSelected = null;
      this._renderChannels();
    }
  });
  // Webhooks management
  document.querySelector('[data-action="webhooks"]')?.addEventListener('click', () => {
    const code = this._ctxMenuChannel;
    if (!code) return;
    this._closeChannelCtxMenu();
    this._openWebhookModal(code);
  });
  // Channel Roles management
  document.querySelector('[data-action="channel-roles"]')?.addEventListener('click', () => {
    const code = this._ctxMenuChannel;
    if (!code) return;
    this._closeChannelCtxMenu();
    this._openChannelRolesModal(code);
  });
  document.getElementById('channel-roles-done-btn')?.addEventListener('click', () => {
    document.getElementById('channel-roles-modal').style.display = 'none';
  });
  document.getElementById('channel-roles-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'channel-roles-modal') {
      document.getElementById('channel-roles-modal').style.display = 'none';
    }
  });
  document.getElementById('channel-roles-assign-btn')?.addEventListener('click', () => {
    this._assignChannelRole();
  });
  document.getElementById('channel-roles-create-btn')?.addEventListener('click', () => {
    this._createChannelRole();
  });
  document.getElementById('webhook-create-btn')?.addEventListener('click', () => {
    const name = document.getElementById('webhook-name-input').value.trim();
    if (!name) return;
    const code = document.getElementById('webhook-modal')._channelCode;
    if (!code) return;
    this.socket.emit('create-webhook', { channelCode: code, name });
    document.getElementById('webhook-name-input').value = '';
  });
  document.getElementById('webhook-copy-url-btn')?.addEventListener('click', () => {
    const urlEl = document.getElementById('webhook-url-display');
    const markCopied = () => {
      document.getElementById('webhook-copy-url-btn').textContent = '✅ ' + t('common.copied');
      setTimeout(() => { document.getElementById('webhook-copy-url-btn').textContent = '📋 ' + t('common.copy'); }, 2000);
    };
    navigator.clipboard.writeText(urlEl.value).then(markCopied).catch(() => {
      try {
        const ta = document.createElement('textarea');
        ta.value = urlEl.value;
        ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
        document.body.appendChild(ta);
        ta.focus(); ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        markCopied();
      } catch { /* could not copy */ }
    });
  });
  document.getElementById('webhook-close-btn')?.addEventListener('click', () => {
    document.getElementById('webhook-modal').style.display = 'none';
  });
  document.getElementById('webhook-modal')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) e.currentTarget.style.display = 'none';
  });
  // Create sub-channel
  document.querySelector('[data-action="create-sub-channel"]')?.addEventListener('click', () => {
    const code = this._ctxMenuChannel;
    if (!code) return;
    this._closeChannelCtxMenu();
    const parentCh = this.channels.find(c => c.code === code);
    if (!parentCh) return;
    // Show the create-sub-channel modal
    document.getElementById('create-sub-name').value = '';
    document.getElementById('create-sub-private').checked = false;
    document.getElementById('create-sub-temporary').checked = false;
    document.getElementById('sub-temp-duration-row').style.display = 'none';
    document.getElementById('create-sub-parent-name').textContent = `# ${parentCh.name}`;
    document.getElementById('create-sub-modal').style.display = 'flex';
    document.getElementById('create-sub-modal')._parentCode = code;
    document.getElementById('create-sub-name').focus();
  });
  // Create sub-channel modal confirm/cancel
  document.getElementById('create-sub-confirm-btn')?.addEventListener('click', () => {
    const modal = document.getElementById('create-sub-modal');
    const name = document.getElementById('create-sub-name').value.trim();
    const isPrivate = document.getElementById('create-sub-private').checked;
    const temporary = document.getElementById('create-sub-temporary').checked;
    const duration = parseInt(document.getElementById('create-sub-duration').value) || 24;
    if (!name) return;
    this.socket.emit('create-sub-channel', {
      parentCode: modal._parentCode,
      name,
      isPrivate,
      temporary,
      duration
    });
    modal.style.display = 'none';
  });
  document.getElementById('create-sub-cancel-btn')?.addEventListener('click', () => {
    document.getElementById('create-sub-modal').style.display = 'none';
  });
  document.getElementById('create-sub-modal')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) e.currentTarget.style.display = 'none';
  });
  // Toggle sub-channel temporary duration row
  const subTempCheckbox = document.getElementById('create-sub-temporary');
  if (subTempCheckbox) {
    subTempCheckbox.addEventListener('change', () => {
      const durRow = document.getElementById('sub-temp-duration-row');
      if (durRow) durRow.style.display = subTempCheckbox.checked ? '' : 'none';
    });
  }
  // Rename channel / sub-channel
  document.querySelector('[data-action="rename-channel"]')?.addEventListener('click', async () => {
    const code = this._ctxMenuChannel;
    if (!code) return;
    this._closeChannelCtxMenu();
    const ch = this.channels.find(c => c.code === code);
    if (!ch) return;
    const name = await this._showPromptModal(t('modals.rename_channel.title'), t('modals.rename_channel.prompt', { name: ch.name }), ch.name);
    if (name && name.trim() && name.trim() !== ch.name) {
      this.socket.emit('rename-channel', { code, name: name.trim() });
    }
  });
  // Close context menu on outside click
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.channel-ctx-menu') && !e.target.closest('.channel-more-btn') && !e.target.closest('.channel-functions-panel')) {
      this._closeChannelCtxMenu();
    }
  });

  // Voice buttons
  document.getElementById('voice-join-btn').addEventListener('click', () => this._joinVoice());
  document.getElementById('voice-join-mobile')?.addEventListener('click', () => {
    this._joinVoice();
    this._closeMobilePanels();
  });
  document.getElementById('voice-mute-btn').addEventListener('click', () => this._toggleMute());
  document.getElementById('voice-deafen-btn').addEventListener('click', () => this._toggleDeafen());
  document.getElementById('voice-mute-btn-header')?.addEventListener('click', () => this._toggleMute());
  document.getElementById('voice-deafen-btn-header')?.addEventListener('click', () => this._toggleDeafen());
  document.getElementById('voice-leave-sidebar-btn').addEventListener('click', () => this._leaveVoice());
  document.getElementById('voice-cam-btn').addEventListener('click', () => this._toggleWebcam());
  document.getElementById('screen-share-btn').addEventListener('click', () => this._toggleScreenShare());
  document.getElementById('voice-soundboard-btn')?.addEventListener('click', () => this._openSoundModal('soundboard'));
  document.getElementById('voice-listen-together-btn')?.addEventListener('click', () => this._openMusicModal());
  document.getElementById('screen-share-minimize').addEventListener('click', () => this._hideScreenShare());
  document.getElementById('screen-share-close').addEventListener('click', () => this._closeScreenShare());
  document.getElementById('webcam-collapse-btn').addEventListener('click', () => {
    const wc = document.getElementById('webcam-container');
    if (wc) {
      wc.style.display = 'none';
      // Show a restore indicator in the channel header
      const grid = document.getElementById('webcam-grid');
      const count = grid ? grid.children.length : 0;
      if (count > 0) this._showWebcamIndicator(count);
    }
  });
  document.getElementById('webcam-close-btn').addEventListener('click', () => {
    this._closeWebcam();
  });

  // Music controls
  document.getElementById('music-share-btn')?.addEventListener('click', () => this._openMusicModal());
  document.getElementById('share-music-btn').addEventListener('click', () => this._shareMusic());
  document.getElementById('share-music-playlist-btn')?.addEventListener('click', () => this._shareMusicPlaylist());
  document.getElementById('cancel-music-btn').addEventListener('click', () => this._closeMusicModal());
  document.getElementById('music-modal').addEventListener('click', (e) => {
    if (e.target.id === 'music-modal') this._closeMusicModal();
  });
  document.getElementById('music-stop-btn').addEventListener('click', () => this._stopMusic());
  document.getElementById('music-close-btn').addEventListener('click', () => {
    this._minimizeMusicPanel();
  });
  document.getElementById('music-queue-btn')?.addEventListener('click', () => this._openMusicQueueModal());
  document.getElementById('close-music-queue-btn')?.addEventListener('click', () => this._closeMusicQueueModal());
  document.getElementById('shuffle-music-queue-btn')?.addEventListener('click', () => this._shuffleMusicQueue());
  document.getElementById('music-queue-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'music-queue-modal') this._closeMusicQueueModal();
  });
  document.getElementById('music-popout-btn').addEventListener('click', () => this._popOutMusicPlayer());
  document.getElementById('music-play-pause-btn').addEventListener('click', () => this._toggleMusicPlayPause());
  document.getElementById('music-next-btn').addEventListener('click', () => this._musicTrackControl('next'));
  document.getElementById('music-mute-btn').addEventListener('click', () => this._toggleMusicMute());
  document.getElementById('music-volume-slider').addEventListener('input', (e) => {
    this._setMusicVolume(parseInt(e.target.value));
  });
  // Seek slider — user drags to scrub position
  const seekSlider = document.getElementById('music-seek-slider');
  seekSlider.addEventListener('input', () => { this._musicSeeking = true; });
  seekSlider.addEventListener('change', (e) => {
    this._musicSeeking = false;
    const pct = parseFloat(e.target.value);
    this._suppressMusicBroadcasts();
    this._seekMusic(pct);
    this._withMusicDuration((durationSeconds) => {
      const positionSeconds = durationSeconds > 0 ? (durationSeconds * pct) / 100 : 0;
      this._emitMusicSeek(positionSeconds, durationSeconds);
    });
    this._setMusicActivityHint('You seeked.');
  });
  document.getElementById('music-link-input').addEventListener('input', (e) => {
    this._previewMusicLink(e.target.value.trim());
  });
  document.getElementById('music-link-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); this._shareMusic(); }
  });

  // Voice controls — now pinned at bottom of right sidebar
  // The header voice-active-indicator opens the RIGHT sidebar on mobile
  document.getElementById('voice-active-indicator')?.addEventListener('click', (e) => {
    e.stopPropagation();
    // On mobile, open the RIGHT sidebar so the user can access voice controls
    const appBody = document.getElementById('app-body');
    if (window.innerWidth <= 900 && appBody) {
      appBody.classList.add('mobile-right-open');
    }
  });

  // Voice settings slide-up toggle
  document.getElementById('voice-settings-toggle')?.addEventListener('click', () => {
    const panel = document.getElementById('voice-settings-panel');
    if (!panel) return;
    const btn = document.getElementById('voice-settings-toggle');
    if (panel.style.display === 'none') {
      panel.style.display = '';
      if (btn) btn.classList.add('active');
      // Populate audio device dropdowns each time panel opens
      this._populateAudioDevices();
    } else {
      panel.style.display = 'none';
      if (btn) btn.classList.remove('active');
    }
  });

  // ── Audio device dropdowns (input & output & camera) ──
  const inputDeviceSelect  = document.getElementById('voice-input-device');
  const outputDeviceSelect = document.getElementById('voice-output-device');
  const camDeviceSelect    = document.getElementById('voice-cam-device');
  if (inputDeviceSelect) {
    inputDeviceSelect.addEventListener('change', (e) => {
      const deviceId = e.target.value;
      localStorage.setItem('haven_input_device', deviceId);
      // Hot-swap if in voice
      if (this.voice && this.voice.inVoice) {
        this.voice.switchInputDevice(deviceId);
      }
    });
  }
  if (outputDeviceSelect) {
    outputDeviceSelect.addEventListener('change', (e) => {
      const deviceId = e.target.value;
      localStorage.setItem('haven_output_device', deviceId);
      // Hot-swap output
      if (this.voice) {
        this.voice.switchOutputDevice(deviceId);
      }
    });
  }
  if (camDeviceSelect) {
    camDeviceSelect.addEventListener('change', (e) => {
      const deviceId = e.target.value;
      localStorage.setItem('haven_cam_device', deviceId);
      // Hot-swap camera if webcam is active
      if (this.voice && this.voice.isWebcamActive) {
        this.voice.switchCamera(deviceId);
      }
    });
  }
  // Stream size slider
  const streamSizeSlider = document.getElementById('stream-size-slider');
  if (streamSizeSlider) {
    const savedSize = localStorage.getItem('haven_stream_size');
    if (savedSize) streamSizeSlider.value = savedSize;
    let _resizeRAF = null;
    const applySize = () => {
      if (_resizeRAF) cancelAnimationFrame(_resizeRAF);
      _resizeRAF = requestAnimationFrame(() => {
        // Auto-exit fullscreen (focus mode) when user adjusts the size slider
        const container = document.getElementById('screen-share-container');
        const grid = document.getElementById('screen-share-grid');
        if (container.classList.contains('stream-focus-mode')) {
          grid.querySelectorAll('.screen-share-tile').forEach(t => t.classList.remove('stream-focused'));
          container.classList.remove('stream-focus-mode');
        }
        const vh = parseInt(streamSizeSlider.value, 10);
        container.style.maxHeight = vh + 'vh';
        grid.style.maxHeight = (vh - 2) + 'vh';
        document.querySelectorAll('.screen-share-tile video').forEach(v => { v.style.maxHeight = (vh - 4) + 'vh'; });
        localStorage.setItem('haven_stream_size', vh);
        _resizeRAF = null;
      });
    };
    applySize();
    streamSizeSlider.addEventListener('input', applySize);
  }

  // ── Stream layout picker ──
  const layoutBtn = document.getElementById('stream-layout-btn');
  const layoutMenu = document.getElementById('stream-layout-menu');
  if (layoutBtn && layoutMenu) {
    const savedLayout = localStorage.getItem('haven_stream_layout') || 'auto';
    this._applyStreamLayout(savedLayout);
    layoutMenu.querySelector(`[data-layout="${savedLayout}"]`)?.classList.add('active');

    layoutBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      layoutMenu.classList.toggle('open');
    });
    layoutMenu.querySelectorAll('.stream-layout-opt').forEach(opt => {
      opt.addEventListener('click', (e) => {
        e.stopPropagation();
        const mode = opt.dataset.layout;
        layoutMenu.querySelectorAll('.stream-layout-opt').forEach(o => o.classList.remove('active'));
        opt.classList.add('active');
        this._applyStreamLayout(mode);
        localStorage.setItem('haven_stream_layout', mode);
        layoutMenu.classList.remove('open');
      });
    });
    document.addEventListener('click', () => layoutMenu.classList.remove('open'));
  }

  // ── Webcam size slider ──
  const webcamSizeSlider = document.getElementById('webcam-size-slider');
  if (webcamSizeSlider) {
    const savedWcSize = localStorage.getItem('haven_webcam_size');
    if (savedWcSize) webcamSizeSlider.value = savedWcSize;
    let _wcResizeRAF = null;
    const applyWcSize = () => {
      if (_wcResizeRAF) cancelAnimationFrame(_wcResizeRAF);
      _wcResizeRAF = requestAnimationFrame(() => {
        const container = document.getElementById('webcam-container');
        const grid = document.getElementById('webcam-grid');
        // Auto-exit focus mode when resizing
        if (container.classList.contains('webcam-focus-mode')) {
          grid.querySelectorAll('.webcam-tile').forEach(t => t.classList.remove('webcam-focused'));
          container.classList.remove('webcam-focus-mode');
        }
        const vh = parseInt(webcamSizeSlider.value, 10);
        container.style.maxHeight = vh + 'vh';
        grid.style.maxHeight = (vh - 2) + 'vh';
        // Scale tile width proportionally with the slider
        const tileMaxW = Math.max(vh * 1.33, 15); // ~4:3 aspect ratio
        document.querySelectorAll('.webcam-tile').forEach(t => { t.style.maxWidth = tileMaxW + 'vw'; });
        document.querySelectorAll('.webcam-tile video').forEach(v => { v.style.maxHeight = (vh - 4) + 'vh'; });
        localStorage.setItem('haven_webcam_size', vh);
        _wcResizeRAF = null;
      });
    };
    applyWcSize();
    webcamSizeSlider.addEventListener('input', applyWcSize);
  }

  // ── Webcam layout picker ──
  const wcLayoutBtn = document.getElementById('webcam-layout-btn');
  const wcLayoutMenu = document.getElementById('webcam-layout-menu');
  if (wcLayoutBtn && wcLayoutMenu) {
    const savedWcLayout = localStorage.getItem('haven_webcam_layout') || 'auto';
    this._applyWebcamLayout(savedWcLayout);
    wcLayoutMenu.querySelector(`[data-layout="${savedWcLayout}"]`)?.classList.add('active');

    wcLayoutBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      wcLayoutMenu.classList.toggle('open');
    });
    wcLayoutMenu.querySelectorAll('.stream-layout-opt').forEach(opt => {
      opt.addEventListener('click', (e) => {
        e.stopPropagation();
        const mode = opt.dataset.layout;
        wcLayoutMenu.querySelectorAll('.stream-layout-opt').forEach(o => o.classList.remove('active'));
        opt.classList.add('active');
        this._applyWebcamLayout(mode);
        localStorage.setItem('haven_webcam_layout', mode);
        wcLayoutMenu.classList.remove('open');
      });
    });
    document.addEventListener('click', () => wcLayoutMenu.classList.remove('open'));
  }

  // ── Webcam collapse button ── (handler already bound above)

  // ── Noise mode selector ──
  const noiseModeSelect = document.getElementById('voice-noise-mode');
  const noiseGateRow = document.getElementById('noise-gate-row');
  const nsSlider = document.getElementById('voice-ns-slider');

  // Restore saved mode
  const savedNoiseMode = localStorage.getItem('haven_noise_mode') || 'gate';
  noiseModeSelect.value = savedNoiseMode;
  noiseGateRow.style.display = savedNoiseMode === 'gate' ? '' : 'none';

  noiseModeSelect.addEventListener('change', (e) => {
    const mode = e.target.value;
    noiseGateRow.style.display = mode === 'gate' ? '' : 'none';
    if (this.voice) this.voice.setNoiseMode(mode);
    // Update mic meter threshold visibility
    if (mode === 'gate') {
      this._updateMicMeterThreshold(parseInt(nsSlider.value, 10));
    } else {
      this._updateMicMeterThreshold(0);
    }
  });

  nsSlider.addEventListener('input', (e) => {
    const val = parseInt(e.target.value, 10);
    if (this.voice && this.voice.inVoice) {
      this.voice.setNoiseSensitivity(val);
    }
    localStorage.setItem('haven_ns_value', val);
    this._updateMicMeterThreshold(val);
  });

  // Restore saved gate sensitivity
  const savedNsVal = localStorage.getItem('haven_ns_value');
  if (savedNsVal !== null) nsSlider.value = savedNsVal;

  // ── Mic level meter ──
  this._micMeterFill = document.getElementById('mic-meter-fill');
  this._micMeterThreshold = document.getElementById('mic-meter-threshold');
  this._micMeterRAF = null;
  this._updateMicMeterThreshold(savedNoiseMode === 'gate' ? parseInt(nsSlider.value, 10) : 0);
  this._startMicMeter();

  // ── Screen share quality dropdowns ──
  const screenResSelect = document.getElementById('screen-res-select');
  const screenFpsSelect = document.getElementById('screen-fps-select');
  if (screenResSelect) {
    // Restore saved value (0 = "source")
    const savedRes = localStorage.getItem('haven_screen_res') || '1080';
    screenResSelect.value = savedRes === '0' ? 'source' : savedRes;
    screenResSelect.addEventListener('change', (e) => {
      const val = e.target.value === 'source' ? 0 : parseInt(e.target.value, 10);
      this.voice.setScreenResolution(val);
    });
  }
  if (screenFpsSelect) {
    const savedFps = localStorage.getItem('haven_screen_fps') || '30';
    screenFpsSelect.value = savedFps;
    screenFpsSelect.addEventListener('change', (e) => {
      this.voice.setScreenFrameRate(parseInt(e.target.value, 10));
    });
  }

  // Wire up the voice manager's video callback
  this.voice.onScreenStream = (userId, stream) => this._handleScreenStream(userId, stream);
  // Wire up webcam video callback
  this.voice.onWebcamStream = (userId, stream) => this._handleWebcamStream(userId, stream);
  // Wire up screen share audio callback
  this.voice.onScreenAudio = (userId) => this._handleScreenAudio(userId);
  // Wire up no-audio indicator for streams without audio
  this.voice.onScreenNoAudio = (userId) => this._handleScreenNoAudio(userId);

  // Wire up voice join/leave audio cues + Desktop OS notifications
  this.voice.onVoiceJoin = (userId, username) => {
    this.notifications.playDirect('voice_join');
    if (window.havenDesktop?.notify && userId !== this.user?.id) {
      const name = this._getNickname(userId, username) || username;
      window.havenDesktop.notify('Voice', `${name} joined voice`, { silent: true });
    }
  };
  this.voice.onVoiceLeave = (userId, username) => {
    this.notifications.playDirect('voice_leave');
    if (window.havenDesktop?.notify && userId !== this.user?.id) {
      const name = this._getNickname(userId, username) || username;
      window.havenDesktop.notify('Voice', `${name} left voice`, { silent: true });
    }
  };
  // Wire up screen share start audio cue
  this.voice.onScreenShareStarted = (userId, username) => {
    this.notifications.playDirect('stream_start');
  };

  // Wire up AFK auto-move
  this.voice.onAfkMove = (channelCode) => {
    this._showToast('Moved to AFK sub-channel due to inactivity', 'info');
    this._updateVoiceButtons(false);
    this._updateVoiceStatus(false);
    this._updateVoiceBar();
    // Switch to the AFK channel and rejoin voice there
    this.switchChannel(channelCode);
    setTimeout(() => this._joinVoice(), 500);
  };

  // Wire up voice-kicked (joined from another client/tab)
  this.voice.onVoiceKicked = (channelCode, reason) => {
    this._showToast(reason || 'Voice disconnected — joined from another client', 'info');
    this._updateVoiceButtons(false);
    this._updateVoiceStatus(false);
    this._updateVoiceBar();
  };
  // Re-render voice user list when webcam status changes
  this.voice.onWebcamStatusChange = () => {
    if (this._lastVoiceUsers) this._renderVoiceUsers(this._lastVoiceUsers);
  };

  // Wire up talking indicator
  this.voice.onTalkingChange = (userId, isTalking) => {
    const resolvedId = userId === 'self' ? this.user.id : userId;
    document.querySelectorAll(`.channel-voice-user[data-user-id="${resolvedId}"], .voice-user-item[data-user-id="${resolvedId}"]`).forEach(el => {
      el.classList.toggle('talking', isTalking);
    });
    // Speaking counts as activity — reset idle timer so presence stays online
    // and the server gets a voice-activity ping for AFK tracking
    if (userId === 'self' && isTalking) this._resetIdle?.();
  };

  // ── File video fullscreen: redirect to wrapper for proper controls ──
  // When a .file-video triggers fullscreen (via native controls), intercept and
  // fullscreen the .file-video-wrap parent instead so controls stay visible.
  if (!document.documentElement.hasAttribute('data-desktop-app')) {
    // Web-only: Desktop app has its own shim in app-preload.js
    const origRequestFS = Element.prototype.requestFullscreen;
    Element.prototype.requestFullscreen = function (opts) {
      if (this.classList?.contains('file-video')) {
        const wrap = this.closest('.file-video-wrap');
        if (wrap) return origRequestFS.call(wrap, opts);
      }
      return origRequestFS.call(this, opts);
    };
  }

  // Search
  let searchTimeout = null;
  document.getElementById('search-toggle-btn').addEventListener('click', () => {
    const sc = document.getElementById('search-container');
    sc.style.display = sc.style.display === 'none' ? 'flex' : 'none';
    if (sc.style.display === 'flex') document.getElementById('search-input').focus();
  });
  document.getElementById('search-close-btn').addEventListener('click', () => {
    document.getElementById('search-container').style.display = 'none';
    document.getElementById('search-results-panel').style.display = 'none';
    document.getElementById('search-input').value = '';
  });
  document.getElementById('search-results-close').addEventListener('click', () => {
    document.getElementById('search-results-panel').style.display = 'none';
  });
  document.getElementById('search-input').addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    const q = e.target.value.trim();
    if (q.length >= 2 && this.currentChannel) {
      searchTimeout = setTimeout(() => {
        this.socket.emit('search-messages', { code: this.currentChannel, query: q });
      }, 400);
    } else {
      document.getElementById('search-results-panel').style.display = 'none';
    }
  });
  document.getElementById('search-input').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document.getElementById('search-container').style.display = 'none';
      document.getElementById('search-results-panel').style.display = 'none';
    }
  });

  // Pinned messages panel
  document.getElementById('pinned-toggle-btn').addEventListener('click', () => {
    const panel = document.getElementById('pinned-panel');
    if (panel.style.display === 'block') {
      panel.style.display = 'none';
    } else if (this.currentChannel) {
      this.socket.emit('get-pinned-messages', { code: this.currentChannel });
    }
  });
  document.getElementById('pinned-close').addEventListener('click', () => {
    document.getElementById('pinned-panel').style.display = 'none';
  });

  // Right sidebar collapse toggle (persisted to localStorage)
  const sidebarToggle = document.getElementById('sidebar-toggle-btn');
  const rightSidebar = document.getElementById('right-sidebar');

  function applySidebarCollapsed(collapsed) {
    rightSidebar.classList.toggle('collapsed', collapsed);
    sidebarToggle.classList.toggle('is-collapsed', collapsed);
    sidebarToggle.textContent = collapsed ? '\u276E' : '\u276F'; // ❮ or ❯
  }

  // Default is expanded; only collapse if explicitly saved as '1'
  applySidebarCollapsed(localStorage.getItem('haven-sidebar-collapsed') === '1');

  sidebarToggle.addEventListener('click', () => {
    const collapsed = !rightSidebar.classList.contains('collapsed');
    applySidebarCollapsed(collapsed);
    localStorage.setItem('haven-sidebar-collapsed', collapsed ? '1' : '0');
  });

  // E2E lock menu dropdown toggle
  document.getElementById('e2e-menu-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const dd = document.getElementById('e2e-dropdown');
    dd.style.display = dd.style.display === 'none' ? 'block' : 'none';
  });
  // Close dropdown on outside click
  document.addEventListener('click', () => {
    const dd = document.getElementById('e2e-dropdown');
    if (dd) dd.style.display = 'none';
  });
  document.getElementById('e2e-dropdown')?.addEventListener('click', (e) => e.stopPropagation());

  // E2E verification code button (inside dropdown)
  document.getElementById('e2e-verify-btn')?.addEventListener('click', () => {
    document.getElementById('e2e-dropdown').style.display = 'none';
    this._requireE2E(() => this._showE2EVerification());
  });

  // E2E reset encryption keys button (inside dropdown)
  // Reset does NOT go through _requireE2E — it must work even when E2E
  // can't initialize (e.g. server backup can't be decrypted after password change).
  document.getElementById('e2e-reset-btn')?.addEventListener('click', () => {
    document.getElementById('e2e-dropdown').style.display = 'none';
    this._showE2EResetConfirmation();
  });

  // E2E password prompt modal handlers
  document.getElementById('e2e-pw-submit-btn')?.addEventListener('click', () => this._submitE2EPassword());
  document.getElementById('e2e-pw-cancel-btn')?.addEventListener('click', () => this._closeE2EPasswordModal());
  document.getElementById('e2e-pw-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') this._submitE2EPassword();
  });
  document.getElementById('e2e-password-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'e2e-password-modal') this._closeE2EPasswordModal();
  });

  // Rate limit tracking for E2E password prompt
  this._e2ePwAttempts = [];
  this._e2ePwLocked = false;
  this._e2ePwPendingAction = null;

  // Global keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    // Ctrl+F = search
    if ((e.ctrlKey || e.metaKey) && e.key === 'f' && this.currentChannel) {
      e.preventDefault();
      const sc = document.getElementById('search-container');
      sc.style.display = 'flex';
      document.getElementById('search-input').focus();
    }
    // Ctrl+K = quick channel switcher
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      this._openQuickSwitcher();
    }
    // Alt+ArrowUp/Down = navigate channels
    if (e.altKey && !e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      this._navigateChannel(e.key === 'ArrowUp' ? -1 : 1);
    }
    // Alt+Shift+ArrowUp/Down = navigate to next/prev unread channel
    if (e.altKey && e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      this._navigateUnreadChannel(e.key === 'ArrowUp' ? -1 : 1);
    }
    // Escape = close modals, search, theme popup, quick switcher
    if (e.key === 'Escape') {
      document.getElementById('search-container').style.display = 'none';
      document.getElementById('search-results-panel').style.display = 'none';
      document.getElementById('theme-popup').style.display = 'none';
      document.getElementById('quick-switcher-overlay')?.remove();
      document.querySelectorAll('.modal-overlay').forEach(m => m.style.display = 'none');
    }
  });

  // Theme popup toggle
  document.getElementById('theme-popup-toggle')?.addEventListener('click', () => {
    const popup = document.getElementById('theme-popup');
    popup.style.display = popup.style.display === 'none' ? 'block' : 'none';
  });
  document.getElementById('theme-popup-close')?.addEventListener('click', () => {
    document.getElementById('theme-popup').style.display = 'none';
  });

  // Logout
  document.getElementById('logout-btn').addEventListener('click', () => {
    if (this.voice && this.voice.inVoice) this.voice.leave();
    localStorage.removeItem('haven_token');
    localStorage.removeItem('haven_user');
    localStorage.removeItem('haven_sync_key');
    window.location.href = '/';
  });

  // ── Games / Activities system ─────────────────────────────
  // Registry of available games — add new games here
  this._gamesRegistry = [
    { id: 'flappy', name: 'Shippy Container', icon: '🚢', path: '/games/flappy.html', description: 'Dodge containers, chase high scores!' },
    { id: 'flight', name: 'Flight', icon: '✈️', path: '/games/flash.html?swf=/games/roms/flight-759879f9.swf&title=Flight', description: 'Throw a paper plane as far as you can!', type: 'flash' },
    { id: 'learn-to-fly-3', name: 'Learn to Fly 3', icon: '🐧', path: '/games/flash.html?swf=/games/roms/learn-to-fly-3.swf&title=Learn%20to%20Fly%203', description: 'Help a penguin learn to fly!', type: 'flash' },
    { id: 'bubble-tanks-3', name: 'Bubble Tanks 3', icon: '🫧', path: '/games/flash.html?swf=/games/roms/Bubble%20Tanks%203.swf&title=Bubble%20Tanks%203', description: 'Bubble-based arena shooter', type: 'flash' },
    { id: 'tanks', name: 'Tanks', icon: '🪖', path: '/games/flash.html?swf=/games/roms/tanks.swf&title=Tanks', description: 'Classic Armor Games tank combat', type: 'flash' },
    { id: 'super-smash-flash-2', name: 'Super Smash Flash 2', icon: '⚔️', path: '/games/flash.html?swf=/games/roms/SuperSmash.swf&title=Super%20Smash%20Flash%202', description: 'Fan-made Smash Bros platformer fighter', type: 'flash' },
    { id: 'io-games', name: '.io Games', icon: '🌐', path: '/games/io-games.html', description: 'Browse popular .io multiplayer games', type: 'browser' },
  ];

  // Generic postMessage bridge for any game (scores + leaderboard)
  if (!this._gameScoreListenerAdded) {
    window.addEventListener('message', (e) => {
      if (e.origin !== window.location.origin) return;
      // Handle score submissions: { type: '<gameId>-score', score: N } or { type: 'game-score', game: '<id>', score: N }
      if (e.data && typeof e.data.score === 'number') {
        let gameId = null;
        if (e.data.type === 'game-score' && e.data.game) {
          gameId = e.data.game;
        } else if (typeof e.data.type === 'string' && e.data.type.endsWith('-score')) {
          gameId = e.data.type.replace(/-score$/, '');
        }
        if (gameId && /^[a-z0-9_-]{1,32}$/.test(gameId)) {
          this.socket.emit('submit-high-score', { game: gameId, score: e.data.score });
        }
      }
      // Handle leaderboard requests from game iframes/windows
      if (e.data && e.data.type === 'get-leaderboard') {
        const gid = e.data.game || 'flappy';
        const scores = this.highScores?.[gid] || [];
        const target = e.source || (this._gameIframe?.contentWindow);
        try { target?.postMessage({ type: 'leaderboard-data', leaderboard: scores }, e.origin); } catch {}
      }
    });
    this._gameScoreListenerAdded = true;
  }

  // Activities button → open launcher modal
  document.getElementById('activities-btn')?.addEventListener('click', () => this._openActivitiesModal());

  // Close activities modal
  document.getElementById('close-activities-btn')?.addEventListener('click', () => this._closeActivitiesModal());
  document.getElementById('activities-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'activities-modal') this._closeActivitiesModal();
  });

  // Game iframe controls
  document.getElementById('game-iframe-close')?.addEventListener('click', () => this._closeGameIframe());
  document.getElementById('game-iframe-popout')?.addEventListener('click', () => this._popoutGame());

  // Game volume slider — forward volume changes into the game iframe
  const gameVolSlider = document.getElementById('game-volume-slider');
  const gameVolPct = document.getElementById('game-volume-pct');
  if (gameVolSlider) {
    gameVolSlider.addEventListener('input', () => {
      const val = parseInt(gameVolSlider.value);
      if (gameVolPct) gameVolPct.textContent = val + '%';
      // Post volume message into the game iframe
      try {
        const iframe = document.getElementById('game-iframe');
        if (iframe?.contentWindow) {
          iframe.contentWindow.postMessage({ type: 'set-volume', volume: val / 100 }, window.location.origin);
        }
      } catch {}
    });
  }

  // Image click — open lightbox overlay (CSP-safe — no inline handlers)
  document.getElementById('messages').addEventListener('click', (e) => {
    if (e.target.classList.contains('chat-image')) {
      this._openLightbox(e.target.src);
    }
    // Spoiler reveal toggle
    if (e.target.closest('.spoiler')) {
      e.target.closest('.spoiler').classList.toggle('revealed');
    }
  });

  // Image right-click — custom context menu for chat thumbnails
  document.getElementById('messages').addEventListener('contextmenu', (e) => {
    if (e.target.classList.contains('chat-image')) {
      e.preventDefault();
      this._showImageContextMenu(e, e.target.src);
    }
  });

  // Risky file download warning — intercept clicks on potentially harmful files
  document.getElementById('messages').addEventListener('click', (e) => {
    const link = e.target.closest('a.risky-file');
    if (!link) return;
    e.preventDefault();
    const fileName = link.getAttribute('download') || 'this file';
    const ext = fileName.split('.').pop().toLowerCase();
    this._showRiskyDownloadWarning(fileName, ext, link.href);
  });

  // Masked markdown link warning — show URL confirmation before navigating
  document.getElementById('messages').addEventListener('click', (e) => {
    const link = e.target.closest('a[data-masked-link]');
    if (!link) return;
    e.preventDefault();
    this._showExternalLinkWarning(link.textContent, link.href);
  });

  // Reply banner click — scroll to the original message
  document.getElementById('messages').addEventListener('click', (e) => {
    const banner = e.target.closest('.reply-banner');
    if (!banner) return;
    const replyMsgId = banner.dataset.replyMsgId;
    if (!replyMsgId) return;
    this._jumpToMessage(parseInt(replyMsgId, 10));
  });

  // #channel-name link click — switch to the referenced channel.
  // Delegated globally so it works inside the main pane, thread panel, and
  // DM PiP without per-container wiring.
  document.addEventListener('click', (e) => {
    const link = e.target.closest('.channel-link[data-channel-code]');
    if (!link) return;
    const code = link.dataset.channelCode;
    if (!code) return;
    e.preventDefault();
    e.stopPropagation();
    const ch = (this.channels || []).find(c => c.code === code);
    if (ch && ch.is_dm) {
      this._openDMPiP?.(code);
    } else {
      this.switchChannel?.(code);
    }
  });

  // Thread preview click — open thread panel
  document.getElementById('messages').addEventListener('click', (e) => {
    const preview = e.target.closest('.thread-preview');
    if (!preview) return;
    const parentId = parseInt(preview.dataset.threadParent);
    if (parentId) this._openThread(parentId);
  });

  // Thread panel — close, send
  const threadCloseBtn = document.getElementById('thread-panel-close');
  if (threadCloseBtn) threadCloseBtn.addEventListener('click', () => this._closeThread());

  const threadPipBtn = document.getElementById('thread-panel-pip');
  if (threadPipBtn) threadPipBtn.addEventListener('click', () => this._toggleThreadPiP());

  // Thread @mention pill in the channel header
  const tmPill = document.getElementById('thread-mentions-pill');
  if (tmPill) tmPill.addEventListener('click', () => this._openMostRecentThreadMention?.());

  // DM PiP panel buttons
  const dmPipClose = document.getElementById('dm-pip-close');
  if (dmPipClose) dmPipClose.addEventListener('click', () => this._closeDMPiP?.());
  const dmPipFs = document.getElementById('dm-pip-fullscreen');
  if (dmPipFs) dmPipFs.addEventListener('click', () => {
    const code = this._activeDMPip;
    if (!code) return;
    this._closeDMPiP?.();
    this.switchChannel(code);
  });
  const dmPipSend = document.getElementById('dm-pip-send');
  if (dmPipSend) dmPipSend.addEventListener('click', () => this._sendDMPiPMessage?.());
  const dmPipInput = document.getElementById('dm-pip-input');
  if (dmPipInput) dmPipInput.addEventListener('keydown', (e) => {
    // Autocomplete navigation/insert hijacks first. (#5296)
    if (this._handleAutocompleteKeydown(e)) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      this._sendDMPiPMessage?.();
    }
  });
  if (dmPipInput) dmPipInput.addEventListener('input', () => {
    this._checkMentionTrigger(dmPipInput);
    this._checkEmojiTrigger(dmPipInput);
    this._checkSlashTrigger(dmPipInput);
  });

  // Paste images / files into the DM PiP input — uploads to the active PiP DM
  // (not the channel currently in the main pane). (#5295)
  if (dmPipInput) dmPipInput.addEventListener('paste', (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const targetCode = this._activeDMPip;
    if (!targetCode) return;
    for (const item of items) {
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (!file) continue;
        e.preventDefault();
        this._uploadGeneralFile(file, targetCode);
        return;
      }
    }
  });

  // PiP emoji button — positions the picker above the button and targets the PiP input
  const dmPipEmojiBtn = document.getElementById('dm-pip-emoji-btn');
  if (dmPipEmojiBtn) {
    dmPipEmojiBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._activeEditTextarea = document.getElementById('dm-pip-input');
      this._toggleEmojiPicker(dmPipEmojiBtn);
    });
  }

  const dmPipReplyClose = document.getElementById('dm-pip-reply-close-btn');
  if (dmPipReplyClose) dmPipReplyClose.addEventListener('click', () => this._clearDMPiPReply?.());

  // Delegated message-action handler for the DM PiP.  Mirrors the main
  // #messages handler so reactions/reply/edit/etc. work inside the PiP.
  const dmPipMessages = document.getElementById('dm-pip-messages');
  if (dmPipMessages) {
    dmPipMessages.addEventListener('click', (e) => {
      // Toolbar action buttons
      // Inline ⋯ dots button — reveals the full toolbar (touch/mobile)
      const dotsBtn = e.target.closest('.msg-dots-btn');
      if (dotsBtn) {
        e.stopPropagation();
        const msgEl = dotsBtn.closest('.message, .message-compact');
        if (!msgEl) return;
        const wasSelected = msgEl.classList.contains('msg-selected');
        dmPipMessages.querySelectorAll('.msg-selected').forEach(el => {
          el.classList.remove('msg-selected');
          const tb = el.querySelector('.msg-toolbar');
          if (tb) tb.style.removeProperty('display');
        });
        if (!wasSelected) {
          msgEl.classList.add('msg-selected');
          const tb = msgEl.querySelector('.msg-toolbar');
          if (tb) tb.style.setProperty('display', 'flex', 'important');
        }
        return;
      }

      const actionBtn = e.target.closest('[data-action]');
      if (actionBtn) {
        const msgEl = actionBtn.closest('.message, .message-compact');
        if (!msgEl) return;
        const msgId = parseInt(msgEl.dataset.msgId, 10);
        if (!msgId) return;
        const action = actionBtn.dataset.action;
        if (action === 'react') {
          this._showReactionPicker?.(msgEl, msgId);
        } else if (action === 'reply') {
          this._setDMPiPReply?.(msgEl, msgId);
        } else if (action === 'quote') {
          this._quoteDMPiPMessage?.(msgEl);
        } else if (action === 'edit') {
          this._startEditMessage?.(msgEl, msgId);
        } else if (action === 'delete') {
          if (confirm(t('confirm.delete_message'))) {
            this.socket.emit('delete-message', { messageId: msgId });
          }
        } else if (action === 'pin') {
          if (confirm(t('confirm.pin_message'))) {
            this.socket.emit('pin-message', { messageId: msgId });
          }
        } else if (action === 'unpin') {
          this.socket.emit('unpin-message', { messageId: msgId });
        } else if (action === 'archive') {
          this.socket.emit('archive-message', { messageId: msgId });
        } else if (action === 'unarchive') {
          this.socket.emit('unarchive-message', { messageId: msgId });
        } else if (action === 'copy-link') {
          this._copyChannelLink?.(this._activeDMPip, msgId);
        } else if (action === 'thread') {
          // Threads aren't supported inside the PiP — escalate to full pane.
          const code = this._activeDMPip;
          this._closeDMPiP?.();
          if (code) this.switchChannel(code);
          this._openThread?.(msgId);
        }
        return;
      }
      // Reaction badge toggle
      const badge = e.target.closest('.reaction-badge');
      if (badge) {
        this._hideReactionPopout?.();
        const msgEl = badge.closest('.message, .message-compact');
        if (!msgEl) return;
        const msgId = parseInt(msgEl.dataset.msgId, 10);
        const emoji = badge.dataset.emoji;
        if (!msgId || !emoji) return;
        if (badge.classList.contains('own')) {
          this.socket.emit('remove-reaction', { messageId: msgId, emoji });
        } else {
          this.socket.emit('add-reaction', { messageId: msgId, emoji });
        }
        return;
      }
      // Reply banner click → jump to original (within the PiP if present)
      const replyBanner = e.target.closest('.reply-banner');
      if (replyBanner) {
        const replyMsgId = parseInt(replyBanner.dataset.replyMsgId || '', 10);
        if (!replyMsgId) return;
        const target = dmPipMessages.querySelector(`[data-msg-id="${replyMsgId}"]`);
        if (target) {
          target.scrollIntoView({ block: 'center', behavior: 'smooth' });
          target.classList.add('highlight-flash');
          setTimeout(() => target.classList.remove('highlight-flash'), 1200);
        }
      }
    });
  }

  const threadSendBtn = document.getElementById('thread-send-btn');
  if (threadSendBtn) threadSendBtn.addEventListener('click', () => this._sendThreadMessage());

  // Thread emoji button — positions the picker above the button and targets the thread input
  const threadEmojiBtn = document.getElementById('thread-emoji-btn');
  if (threadEmojiBtn) {
    threadEmojiBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._activeEditTextarea = document.getElementById('thread-input');
      this._toggleEmojiPicker(threadEmojiBtn);
    });
  }

  const threadInput = document.getElementById('thread-input');
  if (threadInput) {
    threadInput.addEventListener('keydown', (e) => {
      // Autocomplete navigation/insert hijacks first. (#5296)
      if (this._handleAutocompleteKeydown(e)) return;
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this._sendThreadMessage();
      }
    });
    threadInput.addEventListener('input', () => {
      this._checkMentionTrigger(threadInput);
      this._checkEmojiTrigger(threadInput);
      this._checkSlashTrigger(threadInput);
    });
  }

  const threadReplyCloseBtn = document.getElementById('thread-reply-close-btn');
  if (threadReplyCloseBtn) threadReplyCloseBtn.addEventListener('click', () => this._clearThreadReply());

  // Thread panel width resize (drag left edge)
  const threadPanel = document.getElementById('thread-panel');
  const threadResizer = document.getElementById('thread-panel-resizer');
  if (threadPanel) {
    const savedWidth = parseInt(localStorage.getItem('haven_thread_panel_width') || '', 10);
    if (Number.isFinite(savedWidth) && savedWidth >= 300 && savedWidth <= 920) {
      threadPanel.style.width = `${savedWidth}px`;
    }
  }
  if (threadPanel && threadResizer) {
    let resizing = false;
    const clampWidth = (w) => {
      const min = 300;
      const max = Math.min(920, window.innerWidth - 220);
      return Math.max(min, Math.min(max, w));
    };
    const onMove = (e) => {
      if (!resizing || threadPanel.classList.contains('pip')) return;
      const width = clampWidth(window.innerWidth - e.clientX);
      threadPanel.style.width = `${width}px`;
    };
    const onUp = () => {
      if (!resizing) return;
      resizing = false;
      document.body.classList.remove('resizing-thread-panel');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      const current = parseInt(threadPanel.style.width || '', 10);
      if (Number.isFinite(current)) {
        localStorage.setItem('haven_thread_panel_width', String(clampWidth(current)));
      }
    };
    threadResizer.addEventListener('mousedown', (e) => {
      if (threadPanel.classList.contains('pip')) return;
      resizing = true;
      e.preventDefault();
      document.body.classList.add('resizing-thread-panel');
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
    window.addEventListener('resize', () => {
      if (threadPanel.classList.contains('pip')) return;
      const current = parseInt(threadPanel.style.width || '', 10);
      if (!Number.isFinite(current)) return;
      const width = clampWidth(current);
      if (width !== current) {
        threadPanel.style.width = `${width}px`;
        localStorage.setItem('haven_thread_panel_width', String(width));
      }
    });
  }

  // Thread panel PiP drag (drag by header)
  if (threadPanel) {
    const threadHeaderTop = threadPanel.querySelector('.thread-panel-header-top');
    let draggingPiP = false;
    let dragOffsetX = 0;
    let dragOffsetY = 0;

    const footerOffset = () => {
      const raw = getComputedStyle(document.body).getPropertyValue('--thread-footer-offset');
      const v = parseInt(raw, 10);
      return Number.isFinite(v) ? v : 0;
    };

    const clampPiPRect = (left, top, width, height) => {
      const maxLeft = Math.max(0, window.innerWidth - width);
      const maxTop = Math.max(0, window.innerHeight - footerOffset() - height);
      return {
        left: Math.max(0, Math.min(maxLeft, left)),
        top: Math.max(0, Math.min(maxTop, top))
      };
    };

    const savePiPRect = () => {
      if (!threadPanel.classList.contains('pip')) return;
      const r = threadPanel.getBoundingClientRect();
      const rect = {
        left: Math.round(r.left),
        top: Math.round(r.top),
        width: Math.round(r.width),
        height: Math.round(r.height)
      };
      localStorage.setItem('haven_thread_panel_pip_rect', JSON.stringify(rect));
    };

    const onPiPMove = (e) => {
      if (!draggingPiP || !threadPanel.classList.contains('pip')) return;
      const r = threadPanel.getBoundingClientRect();
      const rawLeft = e.clientX - dragOffsetX;
      const rawTop = e.clientY - dragOffsetY;
      const pos = clampPiPRect(rawLeft, rawTop, r.width, r.height);
      threadPanel.style.left = `${pos.left}px`;
      threadPanel.style.top = `${pos.top}px`;
      threadPanel.style.right = 'auto';
      threadPanel.style.bottom = 'auto';
    };

    const onPiPUp = () => {
      if (!draggingPiP) return;
      draggingPiP = false;
      document.removeEventListener('mousemove', onPiPMove);
      document.removeEventListener('mouseup', onPiPUp);
      savePiPRect();
    };

    if (threadHeaderTop) {
      threadHeaderTop.addEventListener('mousedown', (e) => {
        if (!threadPanel.classList.contains('pip')) return;
        if (e.target.closest('button, input, textarea, a')) return;
        const r = threadPanel.getBoundingClientRect();
        draggingPiP = true;
        dragOffsetX = e.clientX - r.left;
        dragOffsetY = e.clientY - r.top;
        threadPanel.style.right = 'auto';
        threadPanel.style.bottom = 'auto';
        e.preventDefault();
        document.addEventListener('mousemove', onPiPMove);
        document.addEventListener('mouseup', onPiPUp);
      });
    }

    if (window.ResizeObserver) {
      const observer = new ResizeObserver(() => {
        if (!threadPanel.classList.contains('pip')) return;
        clearTimeout(this._threadPiPSaveTimer);
        this._threadPiPSaveTimer = setTimeout(() => {
          const r = threadPanel.getBoundingClientRect();
          const pos = clampPiPRect(r.left, r.top, r.width, r.height);
          threadPanel.style.left = `${pos.left}px`;
          threadPanel.style.top = `${pos.top}px`;
          savePiPRect();
        }, 80);
      });
      observer.observe(threadPanel);
    }
  }

  // Emoji picker toggle
  document.getElementById('emoji-btn').addEventListener('click', () => {
    this._toggleEmojiPicker();
  });

  // Close emoji picker when clicking outside
  document.addEventListener('click', (e) => {
    const picker = document.getElementById('emoji-picker');
    const btn = document.getElementById('emoji-btn');
    if (picker && picker.style.display !== 'none' &&
        !picker.contains(e.target) && !btn.contains(e.target) &&
        !e.target.closest('#dm-pip-emoji-btn') && !e.target.closest('#thread-emoji-btn')) {
      picker.style.display = 'none';
      if (picker._havenOrigParent) {
        picker._havenOrigParent.appendChild(picker);
        picker._havenOrigParent = null;
        ['position', 'top', 'left', 'bottom', 'right', 'z-index'].forEach(p => picker.style.removeProperty(p));
      }
    }
  });

  // Reply close button
  document.getElementById('reply-close-btn').addEventListener('click', () => {
    this._clearReply();
  });

  // Messages container — move-selection mode intercept (supports Shift+click range)
  document.getElementById('messages').addEventListener('click', (e) => {
    if (!this._moveSelectionActive) return;
    // Don't intercept toolbar button clicks
    if (e.target.closest('.msg-toolbar, .msg-dots-btn')) return;
    const msgEl = e.target.closest('.message, .message-compact');
    if (msgEl) {
      e.preventDefault();
      e.stopPropagation();

      if (e.shiftKey && this._lastMoveSelectedEl) {
        // Shift+click: select all messages between last selected and this one
        const container = document.getElementById('messages');
        const allMsgs = Array.from(container.querySelectorAll('.message, .message-compact'));
        const lastIdx = allMsgs.indexOf(this._lastMoveSelectedEl);
        const curIdx = allMsgs.indexOf(msgEl);
        if (lastIdx !== -1 && curIdx !== -1) {
          const start = Math.min(lastIdx, curIdx);
          const end = Math.max(lastIdx, curIdx);
          for (let i = start; i <= end; i++) {
            const id = parseInt(allMsgs[i].dataset.msgId);
            if (id && !this._moveSelectedIds.has(id)) {
              if (this._moveSelectedIds.size >= 200) break;
              this._moveSelectedIds.add(id);
              allMsgs[i].classList.add('move-selected');
            }
          }
          this._updateMoveCount();
        }
      } else {
        this._toggleMoveSelect(msgEl);
        this._lastMoveSelectedEl = msgEl;
      }
    }
  }, true); // capture phase so it fires before the toolbar action handler

  // Messages container — delegate reaction and reply button clicks
  document.getElementById('messages').addEventListener('click', (e) => {
    const target = e.target.closest('[data-action]');
    if (!target) return;

    const action = target.dataset.action;
    const msgEl = target.closest('.message, .message-compact');
    if (!msgEl) return;

    const msgId = parseInt(msgEl.dataset.msgId);
    if (!msgId) return;

    if (action === 'react') {
      this._showReactionPicker(msgEl, msgId);
    } else if (action === 'reply') {
      this._setReply(msgEl, msgId);
    } else if (action === 'thread') {
      this._openThread(msgId);
    } else if (action === 'quote') {
      this._quoteMessage(msgEl);
    } else if (action === 'edit') {
      this._startEditMessage(msgEl, msgId);
    } else if (action === 'delete') {
      if (confirm(t('confirm.delete_message'))) {
        this.socket.emit('delete-message', { messageId: msgId });
      }
    } else if (action === 'pin') {
      if (confirm(t('confirm.pin_message'))) {
        this.socket.emit('pin-message', { messageId: msgId });
      }
    } else if (action === 'unpin') {
      this.socket.emit('unpin-message', { messageId: msgId });
    } else if (action === 'archive') {
      this.socket.emit('archive-message', { messageId: msgId });
    } else if (action === 'unarchive') {
      this.socket.emit('unarchive-message', { messageId: msgId });
    } else if (action === 'copy-link') {
      this._copyChannelLink(this.currentChannel, msgId);
    }
  });

  // Reaction badge click (toggle own reaction)
  document.getElementById('messages').addEventListener('click', (e) => {
    const badge = e.target.closest('.reaction-badge');
    if (!badge) return;
    this._hideReactionPopout();
    const msgEl = badge.closest('.message, .message-compact');
    if (!msgEl) return;
    const msgId = parseInt(msgEl.dataset.msgId);
    const emoji = badge.dataset.emoji;
    const hasOwn = badge.classList.contains('own');
    if (hasOwn) {
      this.socket.emit('remove-reaction', { messageId: msgId, emoji });
    } else {
      this.socket.emit('add-reaction', { messageId: msgId, emoji });
    }
  });

  // Thread panel reactions: open picker + toggle reaction on badges
  const threadMessages = document.getElementById('thread-messages');
  if (threadMessages) {
    threadMessages.addEventListener('click', (e) => {
      const threadActionBtn = e.target.closest('[data-thread-action]');
      if (threadActionBtn) {
        const msgEl = threadActionBtn.closest('.thread-message');
        if (!msgEl) return;
        const msgId = parseInt(msgEl.dataset.msgId, 10);
        if (!msgId) return;
        e.preventDefault();
        e.stopPropagation();
        const action = threadActionBtn.dataset.threadAction;
        if (action === 'react') {
          this._showReactionPicker(msgEl, msgId);
        } else if (action === 'reply') {
          this._setThreadReply(msgEl, msgId);
        } else if (action === 'quote') {
          this._quoteThreadMessage(msgEl);
        } else if (action === 'edit') {
          this._startEditMessage(msgEl, msgId);
        } else if (action === 'delete') {
          if (confirm(t('confirm.delete_message'))) {
            this.socket.emit('delete-message', { messageId: msgId });
          }
        }
        return;
      }

      const banner = e.target.closest('.reply-banner');
      if (banner) {
        const replyMsgId = parseInt(banner.dataset.replyMsgId || '', 10);
        if (!replyMsgId) return;
        const target = threadMessages.querySelector(`[data-msg-id="${replyMsgId}"]`);
        if (target) {
          target.scrollIntoView({ block: 'center', behavior: 'smooth' });
          target.classList.add('thread-highlight');
          setTimeout(() => target.classList.remove('thread-highlight'), 1200);
        }
        return;
      }

      const badge = e.target.closest('.reaction-badge');
      if (!badge) return;
      this._hideReactionPopout();
      const msgEl = badge.closest('.thread-message');
      if (!msgEl) return;
      const msgId = parseInt(msgEl.dataset.msgId, 10);
      const emoji = badge.dataset.emoji;
      const hasOwn = badge.classList.contains('own');
      if (!msgId || !emoji) return;
      if (hasOwn) {
        this.socket.emit('remove-reaction', { messageId: msgId, emoji });
      } else {
        this.socket.emit('add-reaction', { messageId: msgId, emoji });
      }
    });
  }

  // Keep toolbar overflow menus visible: flip below when top space is too small.
  const updateToolbarOverflowDirection = (moreWrap) => {
    if (!moreWrap) return;
    const overflow = moreWrap.querySelector('.msg-toolbar-overflow, .thread-msg-overflow');
    if (!overflow) return;

    overflow.classList.remove('flip-below');

    const container = moreWrap.closest('#messages, #thread-messages, #dm-pip-messages');
    const containerRect = container
      ? container.getBoundingClientRect()
      : { top: 0, bottom: window.innerHeight };
    const moreRect = moreWrap.getBoundingClientRect();
    const menuHeight = Math.max(overflow.scrollHeight, 40) + 8;
    const spaceAbove = moreRect.top - containerRect.top;
    const spaceBelow = containerRect.bottom - moreRect.bottom;

    // Open downward when opening upward would clip in the current visible viewport.
    if (spaceAbove < menuHeight && spaceBelow > spaceAbove) {
      overflow.classList.add('flip-below');
    }
  };

  const bindOverflowDirection = (container) => {
    if (!container) return;

    container.addEventListener('mouseover', (e) => {
      const moreWrap = e.target.closest('.msg-toolbar-more, .thread-msg-more');
      if (!moreWrap) return;
      updateToolbarOverflowDirection(moreWrap);
    });

    container.addEventListener('focusin', (e) => {
      const moreWrap = e.target.closest('.msg-toolbar-more, .thread-msg-more');
      if (!moreWrap) return;
      updateToolbarOverflowDirection(moreWrap);
    });
  };

  bindOverflowDirection(document.getElementById('messages'));
  bindOverflowDirection(threadMessages);
  bindOverflowDirection(document.getElementById('dm-pip-messages'));

  // Reaction badge hover — show popout with user list
  {
    let _popoutTimer = null;
    const msgs = document.getElementById('messages');
    const threadMsgs = document.getElementById('thread-messages');
    msgs.addEventListener('mouseover', (e) => {
      const badge = e.target.closest('.reaction-badge');
      if (!badge) return;
      clearTimeout(_popoutTimer);
      _popoutTimer = setTimeout(() => this._showReactionPopout(badge), 350);
    });
    if (threadMsgs) {
      threadMsgs.addEventListener('mouseover', (e) => {
        const badge = e.target.closest('.reaction-badge');
        if (!badge) return;
        clearTimeout(_popoutTimer);
        _popoutTimer = setTimeout(() => this._showReactionPopout(badge), 350);
      });
      threadMsgs.addEventListener('mouseout', (e) => {
        const badge = e.target.closest('.reaction-badge');
        if (!badge && !e.target.closest('#reaction-popout')) {
          clearTimeout(_popoutTimer);
          setTimeout(() => {
            if (!document.querySelector('#reaction-popout:hover')) this._hideReactionPopout();
          }, 200);
        }
      });
    }
    msgs.addEventListener('mouseout', (e) => {
      const badge = e.target.closest('.reaction-badge');
      if (!badge && !e.target.closest('#reaction-popout')) {
        clearTimeout(_popoutTimer);
        setTimeout(() => {
          if (!document.querySelector('#reaction-popout:hover')) this._hideReactionPopout();
        }, 200);
      }
    });
    document.addEventListener('mouseover', (e) => {
      if (!e.target.closest('#reaction-popout') && !e.target.closest('.reaction-badge')) {
        clearTimeout(_popoutTimer);
        this._hideReactionPopout();
      }
    });
    // DM PiP reaction badge popout
    const dmPipMsgs = document.getElementById('dm-pip-messages');
    if (dmPipMsgs) {
      dmPipMsgs.addEventListener('mouseover', (e) => {
        const badge = e.target.closest('.reaction-badge');
        if (!badge) return;
        clearTimeout(_popoutTimer);
        _popoutTimer = setTimeout(() => this._showReactionPopout(badge), 350);
      });
      dmPipMsgs.addEventListener('mouseout', (e) => {
        const badge = e.target.closest('.reaction-badge');
        if (!badge && !e.target.closest('#reaction-popout')) {
          clearTimeout(_popoutTimer);
          setTimeout(() => {
            if (!document.querySelector('#reaction-popout:hover')) this._hideReactionPopout();
          }, 200);
        }
      });
    }
  }

  // ── Poll vote click (delegated from messages container) ──
  document.getElementById('messages').addEventListener('click', (e) => {
    const optBtn = e.target.closest('.poll-option');
    if (!optBtn) return;
    const msgId = parseInt(optBtn.dataset.msgId);
    const optionIndex = parseInt(optBtn.dataset.option);
    if (!msgId || isNaN(optionIndex)) return;
    const hasVote = optBtn.classList.contains('poll-voted');
    if (hasVote) {
      this.socket.emit('unvote-poll', { messageId: msgId, optionIndex });
    } else {
      this.socket.emit('vote-poll', { messageId: msgId, optionIndex });
    }
  });

  // ── Poll creation modal ──
  document.getElementById('poll-btn').addEventListener('click', () => {
    this._openPollModal();
  });
  document.getElementById('poll-cancel-btn').addEventListener('click', () => {
    document.getElementById('poll-modal').style.display = 'none';
  });
  document.getElementById('poll-create-btn').addEventListener('click', () => {
    this._submitPoll();
  });
  document.getElementById('poll-add-option-btn').addEventListener('click', () => {
    this._addPollOption();
  });
  document.getElementById('poll-modal').addEventListener('click', (e) => {
    if (e.target.id === 'poll-modal') e.target.style.display = 'none';
  });

  // Rename username
  document.getElementById('rename-btn').addEventListener('click', () => {
    document.getElementById('rename-modal').style.display = 'flex';
    const input = document.getElementById('rename-input');
    input.value = this.user.displayName || this.user.username;
    input.focus();
    input.select();
    // Populate bio
    const bioInput = document.getElementById('edit-profile-bio');
    if (bioInput) bioInput.value = this.user.bio || '';
    this._updateAvatarPreview();
    // Sync shape picker buttons
    const picker = document.getElementById('avatar-shape-picker');
    if (picker) {
      const currentShape = this.user.avatarShape || localStorage.getItem('haven_avatar_shape') || 'circle';
      picker.querySelectorAll('.avatar-shape-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.shape === currentShape);
      });
      this._pendingAvatarShape = currentShape;
    }
  });

  // ── Profile popup: click on message author name or avatar ──
  document.getElementById('messages').addEventListener('click', (e) => {
    const author = e.target.closest('.message-author');
    const avatar = e.target.closest('.message-avatar, .message-avatar-img');
    if (!author && !avatar) return;
    // Don't trigger if clicking toolbar buttons
    if (e.target.closest('.msg-toolbar')) return;
    const msgEl = e.target.closest('.message, .message-compact');
    if (!msgEl) return;
    const userId = parseInt(msgEl.dataset.userId);
    if (!isNaN(userId)) {
      clearTimeout(this._hoverProfileTimer);
      clearTimeout(this._hoverCloseTimer);
      clearTimeout(this._hoverAutoCloseTimer);
      clearTimeout(this._hoverFadeTimeout);
      // If a hover popup is already open, promote it to permanent (no re-fetch)
      const existingPopup = document.getElementById('profile-popup');
      if (existingPopup && this._isHoverPopup) {
        this._promoteHoverPopup(existingPopup);
        return;
      }
      this._isHoverPopup = false;
      this._hoverTarget = null;
      this._profilePopupAnchor = e.target;
      this.socket.emit('get-user-profile', { userId });
    }
  });

  // ── Profile popup: click on user item in sidebar ──
  document.getElementById('online-users').addEventListener('click', (e) => {
    // Don't trigger for action buttons (DM, kick, etc.)
    if (e.target.closest('.user-action-btn') || e.target.closest('.user-admin-actions')) return;
    const userItem = e.target.closest('.user-item');
    if (!userItem) return;
    const userId = parseInt(userItem.dataset.userId);
    if (!isNaN(userId)) {
      clearTimeout(this._hoverProfileTimer);
      clearTimeout(this._hoverCloseTimer);
      clearTimeout(this._hoverAutoCloseTimer);
      clearTimeout(this._hoverFadeTimeout);
      // If a hover popup is already open, promote it to permanent (no re-fetch)
      const existingPopup = document.getElementById('profile-popup');
      if (existingPopup && this._isHoverPopup) {
        this._promoteHoverPopup(existingPopup);
        return;
      }
      this._isHoverPopup = false;
      this._hoverTarget = null;
      this._profilePopupAnchor = userItem;
      this.socket.emit('get-user-profile', { userId });
    }
  });

  // ── Right-click user → Invite to channel ──
  document.getElementById('online-users').addEventListener('contextmenu', (e) => {
    const userItem = e.target.closest('.user-item');
    if (!userItem) return;
    const userId = parseInt(userItem.dataset.userId);
    if (isNaN(userId) || userId === this.user.id) return;
    e.preventDefault();
    this._showUserContextMenu(e, userId);
  });

  // ── Profile popup: hover-over on usernames/avatars (translucent preview) ──
  const setupHoverProfile = (container, getInfo) => {
    container.addEventListener('mouseover', (e) => {
      const trigger = getInfo(e);
      if (!trigger) {
        // Mouse moved to a non-trigger element — cancel any pending hover
        clearTimeout(this._hoverProfileTimer);
        this._hoverTarget = null;
        // Close hover popup INSTANTLY
        if (this._isHoverPopup) {
          clearTimeout(this._hoverCloseTimer);
          clearTimeout(this._hoverAutoCloseTimer);
          clearTimeout(this._hoverFadeTimeout);
          this._closeProfilePopup();
        }
        return;
      }
      if (trigger.el === this._hoverTarget) return;
      // Switching to a different trigger — close old hover popup instantly
      if (this._isHoverPopup) {
        clearTimeout(this._hoverFadeTimeout);
        this._closeProfilePopup();
      }
      clearTimeout(this._hoverProfileTimer);
      clearTimeout(this._hoverCloseTimer);
      clearTimeout(this._hoverAutoCloseTimer);
      this._hoverTarget = trigger.el;

      // Don't show hover popup if a click-based popup is already open
      if (document.getElementById('profile-popup') && !this._isHoverPopup) return;

      this._hoverProfileTimer = setTimeout(() => {
        // Verify the mouse is still over this trigger element
        if (this._hoverTarget !== trigger.el) return;
        if (!isNaN(trigger.userId)) {
          this._profilePopupAnchor = trigger.el;
          this._isHoverPopup = true;
          this.socket.emit('get-user-profile', { userId: trigger.userId });
        }
      }, 350);
    });

    container.addEventListener('mouseleave', () => {
      clearTimeout(this._hoverProfileTimer);
      clearTimeout(this._hoverAutoCloseTimer);
      clearTimeout(this._hoverFadeTimeout);
      this._hoverTarget = null;
      // Close hover popup INSTANTLY on leaving the container
      if (this._isHoverPopup) {
        this._closeProfilePopup();
      }
    });
  };

  setupHoverProfile(document.getElementById('messages'), (e) => {
    const author = e.target.closest('.message-author');
    const avatar = e.target.closest('.message-avatar, .message-avatar-img');
    if (!author && !avatar) return null;
    if (e.target.closest('.msg-toolbar')) return null;
    const msgEl = (author || avatar).closest('.message, .message-compact');
    if (!msgEl) return null;
    return { el: author || avatar, userId: parseInt(msgEl.dataset.userId) };
  });

  setupHoverProfile(document.getElementById('online-users'), (e) => {
    if (e.target.closest('.user-action-btn') || e.target.closest('.user-admin-actions')) return null;
    const userItem = e.target.closest('.user-item');
    if (!userItem) return null;
    return { el: userItem, userId: parseInt(userItem.dataset.userId) };
  });

  document.getElementById('cancel-rename-btn').addEventListener('click', () => {
    document.getElementById('rename-modal').style.display = 'none';
  });

  document.getElementById('save-rename-btn').addEventListener('click', () => this._saveRename());

  document.getElementById('rename-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') this._saveRename();
  });

  document.getElementById('rename-modal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) e.currentTarget.style.display = 'none';
  });

  // ── Admin moderation bindings ───────────────────────
  document.getElementById('cancel-admin-action-btn').addEventListener('click', () => {
    document.getElementById('admin-action-modal').style.display = 'none';
  });

  document.getElementById('admin-action-modal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) e.currentTarget.style.display = 'none';
  });

  document.getElementById('confirm-admin-action-btn').addEventListener('click', () => {
    if (!this.adminActionTarget) return;
    const { action, userId } = this.adminActionTarget;
    const reason = document.getElementById('admin-action-reason').value.trim();
    const duration = parseInt(document.getElementById('admin-action-duration').value) || 10;
    const scrubMessages = document.getElementById('admin-scrub-checkbox').checked;
    const scrubScope = document.getElementById('admin-scrub-scope').value;

    if (action === 'kick') {
      this.socket.emit('kick-user', { userId, reason, scrubMessages, scrubScope });
    } else if (action === 'ban') {
      const purgeCheckbox = document.getElementById('admin-purge-checkbox');
      const purgeInput = document.getElementById('admin-purge-message');
      const purgeMessages = !!(purgeCheckbox && purgeCheckbox.checked);
      const purgeMessage = purgeInput ? purgeInput.value.trim() : '';
      this.socket.emit('ban-user', { userId, reason, scrubMessages, purgeMessages, purgeMessage });
    } else if (action === 'mute') {
      this.socket.emit('mute-user', { userId, reason, duration });
    } else if (action === 'delete-user') {
      if (!confirm(t('confirm.delete_user', { username: this.adminActionTarget.username }))) return;
      this.socket.emit('delete-user', { userId, reason, scrubMessages });
    }

    document.getElementById('admin-action-modal').style.display = 'none';
    this.adminActionTarget = null;
  });

  // ── Settings popout modal ────────────────────────────
  const openSettingsModal = () => {
    this._snapshotAdminSettings();
    document.getElementById('settings-modal').style.display = 'flex';
    this._syncSettingsNav();
    // Always open on User tab
    this._switchSettingsTab('user');
    // Sync language select with current locale
    const langSelect = document.getElementById('language-select');
    if (langSelect && window.i18n) langSelect.value = i18n.locale;
    // Show desktop-only sections when running inside Haven Desktop
    if (window.havenDesktop?.isDesktopApp) {
      document.getElementById('desktop-shortcuts-nav')?.style.removeProperty('display');
      document.getElementById('desktop-app-nav')?.style.removeProperty('display');
      document.getElementById('section-desktop-shortcuts')?.style.removeProperty('display');
      document.getElementById('section-desktop-app')?.style.removeProperty('display');
    }
    // Eagerly fetch data that requires async calls so sections don't
    // sit on "Loading..." indefinitely if the user never clicks the nav item.
    loadTotpStatus();
    if (this.user?.isAdmin) this._loadRoles();
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
    // Don't close while TOTP setup flow is active — user could lose progress
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
      const isAdmin = !!(this.user && this.user.isAdmin);
      const hasAdminAccess = isAdmin
        || this._hasPerm?.('manage_emojis')
        || this._hasPerm?.('manage_soundboard')
        || this._hasPerm?.('manage_roles')
        || this._hasPerm?.('manage_server')
        || this._hasPerm?.('view_audit_log');
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
    });
  });

  // ── Language switcher ────────────────────────────────
  document.getElementById('language-select')?.addEventListener('change', (e) => {
    if (window.i18n) i18n.setLocale(e.target.value);
  });

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
      // so the server backup can be unlocked with the new credentials
      if (this.e2e && this.e2e.ready && typeof HavenE2E !== 'undefined') {
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
      // Store fresh token — server bumped password_version to invalidate other sessions
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
          <span>Delete all my messages</span>
          <input type="checkbox" id="self-delete-scrub">
        </label>
        <small class="settings-hint" style="margin-bottom:8px;display:block">If unchecked, your messages will show as "[Deleted User]" instead.</small>
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

    overlay.querySelector('.self-delete-confirm').addEventListener('click', () => {
      const pw = document.getElementById('self-delete-pw').value;
      const scrub = document.getElementById('self-delete-scrub').checked;
      const status = overlay.querySelector('.self-delete-status');

      if (!pw) { status.textContent = t('settings.delete_account_section.password_required'); return; }
      if (!confirm(t('confirm.delete_account'))) return;

      status.textContent = t('settings.delete_account_section.deleting');
      overlay.querySelector('.self-delete-confirm').disabled = true;

      this.socket.emit('self-delete-account', { password: pw, scrubMessages: scrub }, (res) => {
        if (res && res.error) {
          status.textContent = res.error;
          overlay.querySelector('.self-delete-confirm').disabled = false;
          return;
        }
        // Account deleted — clear local storage and redirect to login
        localStorage.removeItem('haven_token');
        localStorage.removeItem('haven_e2e_privkey');
        localStorage.removeItem('haven_sync_key');
        window.location.reload();
      });
    });
  });

  // Member visibility select (admin) — saved via admin Save button

  // View bans button
  document.getElementById('view-bans-btn').addEventListener('click', () => {
    this.socket.emit('get-bans');
    document.getElementById('bans-modal').style.display = 'flex';
  });

  document.getElementById('close-bans-btn').addEventListener('click', () => {
    document.getElementById('bans-modal').style.display = 'none';
  });

  document.getElementById('bans-modal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) e.currentTarget.style.display = 'none';
  });

  // View deleted users button
  document.getElementById('view-deleted-users-btn').addEventListener('click', () => {
    this.socket.emit('get-deleted-users');
    document.getElementById('deleted-users-modal').style.display = 'flex';
  });

  document.getElementById('close-deleted-users-btn').addEventListener('click', () => {
    document.getElementById('deleted-users-modal').style.display = 'none';
  });

  document.getElementById('deleted-users-modal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) e.currentTarget.style.display = 'none';
  });

  // View all members buttons (sidebar + admin settings)
  document.getElementById('sidebar-members-btn').addEventListener('click', () => {
    this._openAllMembersModal();
  });
  document.getElementById('view-all-members-btn').addEventListener('click', () => {
    this._openAllMembersModal();
  });
  document.getElementById('close-all-members-btn').addEventListener('click', () => {
    document.getElementById('all-members-modal').style.display = 'none';
  });
  document.getElementById('all-members-modal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) e.currentTarget.style.display = 'none';
  });
  document.getElementById('all-members-search').addEventListener('input', () => this._filterAllMembers());
  document.getElementById('all-members-filter').addEventListener('change', () => this._filterAllMembers());

  // ── Cleanup controls (admin) — saved via admin Save button ──
  const cleanupAge = document.getElementById('cleanup-max-age');
  if (cleanupAge) {
    cleanupAge.addEventListener('change', () => {
      const val = Math.max(0, Math.min(3650, parseInt(cleanupAge.value) || 0));
      cleanupAge.value = val;
    });
  }
  const cleanupSize = document.getElementById('cleanup-max-size');
  if (cleanupSize) {
    cleanupSize.addEventListener('change', () => {
      const val = Math.max(0, Math.min(100000, parseInt(cleanupSize.value) || 0));
      cleanupSize.value = val;
    });
  }

  const runCleanupBtn = document.getElementById('run-cleanup-now-btn');
  if (runCleanupBtn) {
    runCleanupBtn.addEventListener('click', () => {
      this.socket.emit('run-cleanup-now');
      this._showToast(t('toasts.cleanup_triggered'), 'success');
    });
  }

  // ── Server backup / restore (admin) ──────────────────
  const startBackupDownload = (include) => {
    const token = localStorage.getItem('haven_token');
    if (!token) return this._showToast(t('toasts.not_logged_in') || 'Not logged in', 'error');
    const url = `/api/admin/backup?include=${encodeURIComponent(include)}&token=${encodeURIComponent(token)}`;
    const a = document.createElement('a');
    a.href = url;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => a.remove(), 1000);
    this._showToast(t('toasts.backup_started') || 'Preparing backup…', 'info');
  };
  const getBackupIncludes = () => {
    return Array.from(document.querySelectorAll('.backup-include:checked')).map(el => el.value);
  };
  document.getElementById('backup-download-btn')?.addEventListener('click', () => {
    const includes = getBackupIncludes();
    if (!includes.length) {
      return this._showToast(t('toasts.backup_pick_one') || 'Pick at least one section to back up', 'error');
    }
    const heavy = includes.includes('messages') || includes.includes('files');
    if (heavy && !confirm(t('confirm.backup_heavy') || 'This backup includes messages and/or uploaded files. It may take a while and produce a large download. Continue?')) return;
    startBackupDownload(includes.join(','));
  });
  document.getElementById('backup-select-all-btn')?.addEventListener('click', () => {
    document.querySelectorAll('.backup-include').forEach(el => { el.checked = true; });
  });
  document.getElementById('backup-select-none-btn')?.addEventListener('click', () => {
    document.querySelectorAll('.backup-include').forEach(el => { el.checked = false; });
  });

  const restoreBtn = document.getElementById('backup-restore-btn');
  if (restoreBtn) {
    restoreBtn.addEventListener('click', async () => {
      const fileInput = document.getElementById('backup-restore-file');
      const file = fileInput?.files?.[0];
      if (!file) return this._showToast(t('toasts.backup_no_file') || 'Choose a backup .zip file first', 'error');
      if (!confirm(t('confirm.backup_restore') || 'Restore this backup? It will OVERWRITE the current server data and restart the server. This cannot be undone (except via the haven.db.pre-restore copy on the host machine).')) return;
      const token = localStorage.getItem('haven_token');
      if (!token) return this._showToast(t('toasts.not_logged_in') || 'Not logged in', 'error');
      const fd = new FormData();
      fd.append('backup', file);
      restoreBtn.disabled = true;
      const origText = restoreBtn.innerHTML;
      restoreBtn.innerHTML = '⏳ Uploading…';
      try {
        const res = await fetch('/api/admin/restore', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}` },
          body: fd,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        this._showToast(data.message || 'Restore staged. Server restarting…', 'success');
        restoreBtn.innerHTML = '✓ Restarting…';
      } catch (err) {
        this._showToast((t('toasts.backup_restore_failed') || 'Restore failed: ') + err.message, 'error');
        restoreBtn.disabled = false;
        restoreBtn.innerHTML = origText;
      }
    });
  }

  // ── Auto-backup admin controls ─────────────────────
  const fmtBytes = (n) => {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
    return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  };
  this._refreshAutoBackupList = async () => {
    const listEl = document.getElementById('auto-backup-list');
    if (!listEl) return;
    const token = localStorage.getItem('haven_token');
    if (!token) return;
    try {
      const res = await fetch('/api/admin/auto-backups', { headers: { 'Authorization': `Bearer ${token}` } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const files = data.files || [];
      if (!files.length) {
        listEl.innerHTML = '<small class="settings-hint">No auto-backups yet.</small>';
        return;
      }
      listEl.innerHTML = files.map(f => {
        const safeName = f.name.replace(/[<>"&]/g, c => ({ '<': '&lt;', '>': '&gt;', '"': '&quot;', '&': '&amp;' }[c]));
        const when = new Date(f.mtime).toLocaleString();
        return `<div style="display:flex;gap:6px;align-items:center;justify-content:space-between;border:1px solid var(--border);padding:6px 8px;border-radius:4px">
          <div style="min-width:0;flex:1">
            <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:monospace;font-size:0.85em">${safeName}</div>
            <small class="settings-hint">${when} · ${fmtBytes(f.size)}</small>
          </div>
          <div style="display:flex;gap:4px;flex-shrink:0">
            <button class="btn-sm auto-backup-dl-btn" data-name="${safeName}">⬇️</button>
            <button class="btn-sm auto-backup-del-btn" data-name="${safeName}" title="Delete">🗑️</button>
          </div>
        </div>`;
      }).join('');
      listEl.querySelectorAll('.auto-backup-dl-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const name = btn.dataset.name;
          const url = `/api/admin/auto-backups/${encodeURIComponent(name)}?token=${encodeURIComponent(token)}`;
          const a = document.createElement('a');
          a.href = url; a.download = name; a.style.display = 'none';
          document.body.appendChild(a); a.click(); setTimeout(() => a.remove(), 1000);
        });
      });
      listEl.querySelectorAll('.auto-backup-del-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const name = btn.dataset.name;
          if (!confirm(`Delete ${name}?`)) return;
          const r = await fetch(`/api/admin/auto-backups/${encodeURIComponent(name)}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` },
          });
          if (r.ok) this._refreshAutoBackupList();
          else this._showToast('Delete failed', 'error');
        });
      });
    } catch (err) {
      listEl.innerHTML = `<small class="settings-hint" style="color:var(--danger)">Failed to load: ${err.message}</small>`;
    }
  };
  document.getElementById('auto-backup-save-btn')?.addEventListener('click', () => {
    const enabled = document.getElementById('auto-backup-enabled')?.checked ? 'true' : 'false';
    const interval = document.getElementById('auto-backup-interval')?.value || '24';
    const retention = document.getElementById('auto-backup-retention')?.value || '7';
    const sections = Array.from(document.querySelectorAll('.auto-backup-include:checked')).map(el => el.value);
    if (enabled === 'true' && !sections.length) {
      return this._showToast('Pick at least one section to back up', 'error');
    }
    this.socket.emit('update-server-setting', { key: 'auto_backup_enabled', value: enabled });
    this.socket.emit('update-server-setting', { key: 'auto_backup_interval_hours', value: String(interval) });
    this.socket.emit('update-server-setting', { key: 'auto_backup_retention', value: String(retention) });
    this.socket.emit('update-server-setting', { key: 'auto_backup_sections', value: sections.join(',') });
    this._showToast('Auto-backup schedule saved', 'success');
  });
  document.getElementById('auto-backup-run-now-btn')?.addEventListener('click', async () => {
    const token = localStorage.getItem('haven_token');
    if (!token) return;
    try {
      const r = await fetch('/api/admin/auto-backups/run-now', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      this._showToast('Auto-backup triggered. Refreshing list shortly…', 'info');
      setTimeout(() => this._refreshAutoBackupList(), 3000);
    } catch (err) {
      this._showToast('Run failed: ' + err.message, 'error');
    }
  });
  document.getElementById('auto-backup-refresh-btn')?.addEventListener('click', () => this._refreshAutoBackupList());

  // ── In-app update controls ─────────────────────────
  let lastUpdateCheck = null;
  const updStatusEl = () => document.getElementById('update-status');
  const updRunBtn = () => document.getElementById('update-run-btn');
  document.getElementById('update-check-btn')?.addEventListener('click', async () => {
    const token = localStorage.getItem('haven_token');
    if (!token) return;
    const status = updStatusEl();
    if (status) { status.style.display = 'block'; status.textContent = 'Checking…'; }
    try {
      const r = await fetch('/api/admin/update/check', { headers: { 'Authorization': `Bearer ${token}` } });
      const data = await r.json();
      lastUpdateCheck = data;
      if (status) {
        const upToDate = !data.updateAvailable;
        const esc = s => String(s || '').replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
        status.innerHTML = `
          <div><strong>Installed:</strong> v${esc(data.currentVersion)}</div>
          <div><strong>Latest:</strong> ${data.latestVersion ? 'v' + esc(data.latestVersion) : 'unknown'}</div>
          <div><strong>Install method:</strong> ${esc(data.method)}</div>
          <div style="margin-top:6px">${upToDate ? '✅ You are up to date.' : '⚠️ Update available.'}</div>
          <div style="margin-top:6px"><small>${esc(data.message || '')}</small></div>
          ${data.releaseUrl ? `<div style="margin-top:6px"><a href="${esc(data.releaseUrl)}" target="_blank" rel="noopener">Release notes →</a></div>` : ''}
        `;
      }
      if (updRunBtn()) updRunBtn().disabled = !(data.updateAvailable && data.runnable);
    } catch (err) {
      if (status) status.textContent = 'Check failed: ' + err.message;
    }
  });
  document.getElementById('update-run-btn')?.addEventListener('click', async () => {
    const status = updStatusEl();
    // If the user clicks Run before clicking Check, do the check first so
    // we always have a fresh `lastUpdateCheck` to act on. (#5267)
    if (!lastUpdateCheck) {
      try { document.getElementById('update-check-btn')?.click(); } catch {}
      if (status) {
        if (status.style) status.style.display = 'block';
        status.textContent = 'Checking for updates first… click Update Now again once the check finishes.';
      }
      return;
    }
    if (!lastUpdateCheck.updateAvailable) {
      if (status) {
        if (status.style) status.style.display = 'block';
        status.textContent = 'Already up to date — nothing to install.';
      }
      return;
    }
    if (!lastUpdateCheck.runnable) {
      // Most common case: Docker install. Surface the reason instead of
      // silently doing nothing so admins know why the button is inert.
      if (status) {
        if (status.style) status.style.display = 'block';
        const reason = lastUpdateCheck.message || `In-app updates aren't supported for the "${lastUpdateCheck.method}" install method.`;
        status.textContent = reason;
      }
      return;
    }
    if (!confirm(`Apply update to v${lastUpdateCheck.latestVersion}? The server will run an auto-backup, then exit so the supervisor restarts it on the new code. You will be disconnected for ~30 seconds.`)) return;
    const token = localStorage.getItem('haven_token');
    if (!token) return;
    // Visible status before the fetch so admins always see *something*
    // happen on click — helps diagnose cases where the request fails
    // silently or the host blocks the request. (#5267)
    if (status) {
      if (status.style) status.style.display = 'block';
      status.textContent = 'Sending update request…';
    }
    try {
      const r = await fetch('/api/admin/update/run', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      if (status) status.innerHTML = `<div>🔄 Update started. The server will restart shortly.</div><div style="margin-top:6px"><small>${data.message || ''}</small></div>`;
      if (updRunBtn()) updRunBtn().disabled = true;
    } catch (err) {
      if (status) status.textContent = 'Update failed: ' + err.message;
    }
  });

  // ── Whitelist controls (admin) ───────────────────────
  // Whitelist toggle — saved via admin Save button

  document.getElementById('whitelist-add-btn').addEventListener('click', () => {
    const input = document.getElementById('whitelist-username-input');
    const username = input.value.trim();
    if (!username) return;
    this.socket.emit('whitelist-add', { username });
    input.value = '';
  });

  document.getElementById('whitelist-username-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('whitelist-add-btn').click();
  });

  // Listen for whitelist list updates
  this.socket.on('whitelist-list', (list) => {
    this._renderWhitelist(list);
  });

  // ── Tunnel settings (immediate — not part of Save flow) ──
  const tunnelToggleBtn = document.getElementById('tunnel-toggle-btn');
  if (tunnelToggleBtn) {
    tunnelToggleBtn.addEventListener('click', () => {
      // Determine desired state from button text
      const wantStart = tunnelToggleBtn.textContent.trim().startsWith('Start');
      this.socket.emit('update-server-setting', {
        key: 'tunnel_enabled',
        value: wantStart ? 'true' : 'false'
      });
      this._syncTunnelState(wantStart);
    });
  }

  const tunnelProvEl = document.getElementById('tunnel-provider-select');
  if (tunnelProvEl) {
    tunnelProvEl.addEventListener('change', () => {
      this.socket.emit('update-server-setting', {
        key: 'tunnel_provider',
        value: tunnelProvEl.value
      });
    });
  }

  // ── Server invite code (immediate — not part of Save flow) ──
  document.getElementById('generate-server-code-btn')?.addEventListener('click', () => {
    this.socket.emit('generate-server-code');
  });
  document.getElementById('clear-server-code-btn')?.addEventListener('click', () => {
    if (!confirm(t('confirm.clear_invite_code'))) return;
    this.socket.emit('clear-server-code');
  });
  document.getElementById('copy-server-code-btn')?.addEventListener('click', () => {
    const code = document.getElementById('server-code-value')?.textContent;
    if (code && code !== '—') {
      const onCopied = () => this._showToast(t('toasts.server_code_copied'), 'success');
      navigator.clipboard.writeText(code).then(onCopied).catch(() => {
        try {
          const ta = document.createElement('textarea');
          ta.value = code;
          ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
          document.body.appendChild(ta);
          ta.focus(); ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
          onCopied();
        } catch { /* could not copy */ }
      });
    }
  });
},

// ═══════════════════════════════════════════════════════
// CHANNEL & MESSAGE LINKS — copy/share deep-links
// ═══════════════════════════════════════════════════════

/** Copy a Haven-style deep link to a channel (and optionally a message) to the clipboard. */
_copyChannelLink(code, messageId = null) {
  if (!code) return;
  const base = `${window.location.origin}/app.html?channel=${encodeURIComponent(code)}`;
  const url = messageId ? `${base}&message=${encodeURIComponent(messageId)}` : base;
  const onCopied = () => {
    const key = messageId ? 'toasts.message_link_copied' : 'toasts.channel_link_copied';
    const fallback = messageId ? 'Message link copied' : 'Channel link copied';
    this._showToast(t(key) || fallback, 'success');
  };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(url).then(onCopied).catch(() => this._copyTextFallback(url, onCopied));
  } else {
    this._copyTextFallback(url, onCopied);
  }
},

_copyTextFallback(text, onCopied) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    onCopied?.();
  } catch { /* could not copy */ }
},

// ═══════════════════════════════════════════════════════
// SERVER BAR — multi-server with live status
// ═══════════════════════════════════════════════════════

/** Push the current server list to the server-side encrypted backup. */
_pushServerListToServer() {
  const wrappingKey = this._e2eWrappingKey || sessionStorage.getItem('haven_e2e_wrap') || null;
  if (wrappingKey && this.serverManager && this.token) {
    this.serverManager._pushToServer(this.token, wrappingKey).catch(() => {});
  }
},

/** Push all ServerManager entries to Desktop's global server history.
 *  This ensures servers discovered via encrypted sync propagate to
 *  OTHER Haven servers the next time the user switches. */
_pushServersToDesktopHistory() {
  if (!window.havenDesktop?.addServerHistory || !window.havenDesktop?.getServerHistory) return;
  window.havenDesktop.getServerHistory().then(history => {
    const historyUrls = new Set((history || []).map(h => h.url));
    for (const s of this.serverManager.getAll()) {
      if (!historyUrls.has(s.url)) {
        window.havenDesktop.addServerHistory(s.url, s.name).catch(() => {});
      }
    }
  }).catch(() => {});
},

_setupServerBar() {
  this.serverManager.startPolling(30000);

  // Desktop: merge Electron's server history into the web ServerManager
  // so the sidebar shows ALL known servers even on first login to this server
  if (window.havenDesktop?.getServerHistory) {
    window.havenDesktop.getServerHistory().then(history => {
      const historyUrls = new Set((history || []).map(h => h.url));
      const removed = this.serverManager._loadRemoved();
      let added = false;

      // Add Desktop servers to web ServerManager (skip removed ones)
      for (const h of (history || [])) {
        if (!h.url) continue;
        let normalizedUrl;
        try { normalizedUrl = new URL(h.url).origin; } catch { normalizedUrl = h.url; }
        if (removed.has(h.url) || removed.has(normalizedUrl)) continue;
        if (this.serverManager.add(h.name || h.url, h.url)) {
          added = true;
        }
      }

      // Add web ServerManager servers to Desktop history
      if (window.havenDesktop.addServerHistory) {
        for (const s of this.serverManager.getAll()) {
          if (!historyUrls.has(s.url)) {
            window.havenDesktop.addServerHistory(s.url, s.name).catch(() => {});
          }
        }
      }

      // First-join scenario: if the synchronous preload bootstrap pulled in
      // servers we didn't have locally OR if the async getServerHistory just
      // added more, push the merged list to THIS server's encrypted backup
      // immediately so the user is never stranded with an empty sidebar.
      if (added || this.serverManager.bootstrappedFromDesktop) {
        this._renderServerBar();
        this._pushServerListToServer();
      }
    }).catch(() => {});
  }

  this._renderServerBar();
  if (this._serverBarInterval) clearInterval(this._serverBarInterval);
  this._serverBarInterval = setInterval(() => this._renderServerBar(), 30000);

  // Re-render once the self-fingerprint resolves (hides "self" in sidebar)
  this.serverManager.selfFingerprintReady?.then(() => this._renderServerBar());

  // Desktop notification dots — listen for badge updates from main process
  window.addEventListener('haven-server-badges', (e) => this._updateServerBadgeDots(e.detail));
  window.havenDesktop?.getServerBadges?.().then(b => this._updateServerBadgeDots(b));

  document.getElementById('home-server').addEventListener('click', () => {
    // Already home — pulse the icon for fun
    const el = document.getElementById('home-server');
    el.classList.add('bounce');
    setTimeout(() => el.classList.remove('bounce'), 400);
  });

  document.getElementById('add-server-btn').addEventListener('click', () => {
    this._editingServerUrl = null;
    document.getElementById('add-server-modal-title').textContent = t('modals.add_server.title');
    document.getElementById('add-server-modal').style.display = 'flex';
    document.getElementById('add-server-name-input').value = '';
    document.getElementById('server-url-input').value = '';
    document.getElementById('server-url-input').disabled = false;
    document.getElementById('add-server-icon-input').value = '';
    document.getElementById('save-server-btn').textContent = t('modals.add_server.add_btn');
    this._populateKnownServersDatalist();
    document.getElementById('add-server-name-input').focus();
  });

  document.getElementById('cancel-server-btn').addEventListener('click', () => {
    document.getElementById('add-server-modal').style.display = 'none';
    document.getElementById('server-url-input').disabled = false;
    this._editingServerUrl = null;
  });

  document.getElementById('save-server-btn').addEventListener('click', () => this._addServer());

  // Enter key in modal inputs
  document.getElementById('server-url-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') this._addServer();
  });

  // Close modal on overlay click
  document.getElementById('add-server-modal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) e.currentTarget.style.display = 'none';
  });

  // ── Manage Servers gear button & modal ──────────────
  document.getElementById('manage-servers-btn')?.addEventListener('click', () => {
    this._openManageServersModal();
  });
  document.getElementById('manage-servers-close-btn')?.addEventListener('click', () => {
    document.getElementById('manage-servers-modal').style.display = 'none';
  });
  document.getElementById('manage-servers-modal')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) e.currentTarget.style.display = 'none';
  });
  document.getElementById('manage-servers-add-btn')?.addEventListener('click', () => {
    document.getElementById('manage-servers-modal').style.display = 'none';
    document.getElementById('add-server-btn').click();
  });

  // ── Sync Servers button ─────────────────────────────
  document.getElementById('sync-servers-btn')?.addEventListener('click', async () => {
    const btn = document.getElementById('sync-servers-btn');
    btn.classList.add('spinning');
    try {
      // 1. Pull from Desktop history (cross-server bridge)
      if (window.havenDesktop?.getServerHistory) {
        const history = await window.havenDesktop.getServerHistory();
        const removed = this.serverManager._loadRemoved();
        let added = false;
        for (const h of (history || [])) {
          if (!h.url) continue;
          let normalizedUrl;
          try { normalizedUrl = new URL(h.url).origin; } catch { normalizedUrl = h.url; }
          if (removed.has(h.url) || removed.has(normalizedUrl)) continue;
          if (this.serverManager.add(h.name || h.url, h.url)) added = true;
        }
        if (added) this._renderServerBar();
      }

      // 2. Pull from server-side encrypted backup
      const syncKey = this._e2eWrappingKey || sessionStorage.getItem('haven_e2e_wrap') || null;
      if (syncKey && this.serverManager && this.token) {
        await this.serverManager.syncWithServer(this.token, syncKey);
      }

      // 3. Push merged list back to Desktop history + encrypted backup
      this._pushServersToDesktopHistory();
      this._pushServerListToServer();

      // 4. Health-check all servers
      await this.serverManager.checkAll();
      this._renderServerBar();
      this._showToast('Server list synced', 'success');
    } catch {
      this._showToast('Sync failed', 'error');
    } finally {
      btn.classList.remove('spinning');
    }
  });

  // ── Channel Code Settings Modal ─────────────────────
  document.getElementById('channel-code-settings-btn')?.addEventListener('click', () => {
    if (!this.currentChannel || (!this.user.isAdmin && !this._hasPerm('create_channel'))) return;
    const channel = this.channels.find(c => c.code === this.currentChannel);
    if (!channel || channel.is_dm) return;

    document.getElementById('code-settings-channel-name').textContent = `# ${channel.name}`;
    document.getElementById('code-visibility-select').value = channel.code_visibility || 'public';
    document.getElementById('code-mode-select').value = channel.code_mode || 'static';
    document.getElementById('code-rotation-type-select').value = channel.code_rotation_type || 'time';
    document.getElementById('code-rotation-interval').value = channel.code_rotation_interval || 60;

    this._toggleCodeRotationFields();
    document.getElementById('code-settings-modal').style.display = 'flex';
  });

  document.getElementById('code-mode-select')?.addEventListener('change', () => this._toggleCodeRotationFields());
  document.getElementById('code-rotation-type-select')?.addEventListener('change', () => {
    const type = document.getElementById('code-rotation-type-select').value;
    const label = document.getElementById('rotation-interval-label');
    if (label) label.textContent = type === 'time' ? t('modals.code_settings.interval_label') : t('modals.code_settings.rotate_after_joins');
  });

  document.getElementById('code-settings-cancel-btn')?.addEventListener('click', () => {
    document.getElementById('code-settings-modal').style.display = 'none';
  });

  document.getElementById('code-settings-modal')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) e.currentTarget.style.display = 'none';
  });

  document.getElementById('code-settings-save-btn')?.addEventListener('click', () => {
    const channel = this.channels.find(c => c.code === this.currentChannel);
    if (!channel) return;

    this.socket.emit('update-channel-code-settings', {
      channelId: channel.id,
      code_visibility: document.getElementById('code-visibility-select').value,
      code_mode: document.getElementById('code-mode-select').value,
      code_rotation_type: document.getElementById('code-rotation-type-select').value,
      code_rotation_interval: parseInt(document.getElementById('code-rotation-interval').value) || 60
    });

    document.getElementById('code-settings-modal').style.display = 'none';
  });

  document.getElementById('code-rotate-now-btn')?.addEventListener('click', () => {
    const channel = this.channels.find(c => c.code === this.currentChannel);
    if (!channel) return;

    if (!confirm(t('confirm.rotate_channel_code'))) return;
    this.socket.emit('rotate-channel-code', { channelId: channel.id });
    document.getElementById('code-settings-modal').style.display = 'none';
  });
},

_toggleCodeRotationFields() {
  const isDynamic = document.getElementById('code-mode-select').value === 'dynamic';
  document.getElementById('rotation-type-group').style.display = isDynamic ? '' : 'none';
  document.getElementById('rotation-interval-group').style.display = isDynamic ? '' : 'none';
  // Update interval label based on rotation type
  const type = document.getElementById('code-rotation-type-select').value;
  const label = document.getElementById('rotation-interval-label');
  if (label) label.textContent = type === 'time' ? t('modals.code_settings.interval_label') : t('modals.code_settings.rotate_after_joins');
},

/** Populate the datalist in the Add Server modal with known servers from
 *  the web ServerManager and (if in Desktop) the Electron server history. */
async _populateKnownServersDatalist() {
  const datalist = document.getElementById('known-servers-datalist');
  if (!datalist) return;
  datalist.innerHTML = '';

  // Collect from web ServerManager
  const known = new Map(); // url → name
  for (const s of this.serverManager.getAll()) {
    known.set(s.url, s.name || s.url);
  }

  // Collect from Desktop server history (if running in Electron)
  if (window.havenDesktop?.getServerHistory) {
    try {
      const history = await window.havenDesktop.getServerHistory();
      for (const h of (history || [])) {
        if (h.url && !known.has(h.url)) known.set(h.url, h.name || h.url);
      }
    } catch { /* not available */ }
  }

  // Build datalist options
  for (const [url, name] of known) {
    const opt = document.createElement('option');
    opt.value = url;
    opt.label = name !== url ? name : '';
    datalist.appendChild(opt);
  }

  // When the user picks a server from the list, auto-fill the name field
  const urlInput = document.getElementById('server-url-input');
  const nameInput = document.getElementById('add-server-name-input');
  const onChange = () => {
    const match = known.get(urlInput.value);
    if (match && !nameInput.value) {
      nameInput.value = match;
    }
  };
  // Remove previous listener to avoid stacking
  urlInput.removeEventListener('change', urlInput._knownServerHandler);
  urlInput._knownServerHandler = onChange;
  urlInput.addEventListener('change', onChange);
},

_addServer() {
  const name = document.getElementById('add-server-name-input').value.trim();
  const url = document.getElementById('server-url-input').value.trim();
  const iconInput = document.getElementById('add-server-icon-input').value.trim();
  const autoPull = document.getElementById('server-auto-icon').checked;
  if (!name || !url) return this._showToast(t('toasts.name_address_required'), 'error');

  const editUrl = this._editingServerUrl;
  if (editUrl) {
    // Editing existing server
    this.serverManager.update(editUrl, { name, icon: iconInput || null });
    this._editingServerUrl = null;
    document.getElementById('add-server-modal').style.display = 'none';
    this._renderServerBar();
    this._showToast(t('toasts.server_updated', { name }), 'success');
    // Auto-pull icon if checked
    if (autoPull) this._autoPullServerIcon(editUrl);
  } else {
    // Adding new server
    const icon = iconInput || null;
    if (this.serverManager.add(name, url, icon)) {
      document.getElementById('add-server-modal').style.display = 'none';
      this._renderServerBar();
      this._showToast(t('toasts.server_added', { name }), 'success');
      this._pushServerListToServer();
      // Also add to Desktop server history so it persists across all servers
      if (window.havenDesktop?.addServerHistory) {
        const cleanUrl = url.replace(/\/+$/, '');
        const finalUrl = /^https?:\/\//.test(cleanUrl) ? cleanUrl : 'https://' + cleanUrl;
        window.havenDesktop.addServerHistory(finalUrl, name).catch(() => {});
      }
      // Auto-pull icon after health check completes
      if (autoPull) {
        const cleanUrl = url.replace(/\/+$/, '');
        const finalUrl = /^https?:\/\//.test(cleanUrl) ? cleanUrl : 'https://' + cleanUrl;
        setTimeout(() => this._autoPullServerIcon(finalUrl), 2000);
      }
    } else {
      this._showToast(t('toasts.server_already_in_list'), 'error');
    }
  }
},

_autoPullServerIcon(url) {
  const status = this.serverManager.statusCache.get(url);
  if (status && status.icon) {
    this.serverManager.update(url, { icon: status.icon });
    this._renderServerBar();
  }
},

_editServer(url) {
  const server = this.serverManager.servers.find(s => s.url === url);
  if (!server) return;
  this._editingServerUrl = url;
  document.getElementById('add-server-modal-title').textContent = t('modals.manage_servers.edit_title');
  document.getElementById('add-server-name-input').value = server.name;
  document.getElementById('server-url-input').value = server.url;
  document.getElementById('server-url-input').disabled = true;
  document.getElementById('add-server-icon-input').value = server.icon || '';
  document.getElementById('save-server-btn').textContent = t('modals.common.save');
  document.getElementById('add-server-modal').style.display = 'flex';
  document.getElementById('add-server-name-input').focus();
},

_openManageServersModal() {
  this._renderManageServersList();
  document.getElementById('manage-servers-modal').style.display = 'flex';
},

_renderManageServersList() {
  const container = document.getElementById('manage-servers-list');
  const currentOrigin = window.location.origin;
  const selfFp = this.serverManager.selfFingerprint;
  const servers = this.serverManager.getAll().filter(s => {
    if (selfFp && s.status.fingerprint === selfFp) return false;
    try { return new URL(s.url).origin !== currentOrigin; } catch { return true; }
  });
  container.innerHTML = '';
  if (servers.length === 0) return;  // CSS :empty handles empty state

  let dragSrcRow = null;

  servers.forEach(s => {
    const row = document.createElement('div');
    row.className = 'manage-server-row';
    row.draggable = true;
    row.dataset.url = s.url;

    const online = s.status.online;
    const statusClass = online === true ? 'online' : online === false ? 'offline' : 'unknown';
    const statusText = online === true ? t('servers.online') : online === false ? t('servers.offline') : t('servers.checking');
    const initial = s.name.charAt(0).toUpperCase();
    const iconUrl = s.icon || (s.status.icon || null);
    const iconContent = iconUrl
      ? `<img src="${this._escapeHtml(iconUrl)}" alt="" class="manage-srv-icon-img">`
      : initial;

    row.innerHTML = `
      <div class="manage-server-drag-handle" title="Drag to reorder">⠿</div>
      <div class="manage-server-icon">${iconContent}</div>
      <div class="manage-server-info">
        <div class="manage-server-name">${this._escapeHtml(s.name)}</div>
        <div class="manage-server-url">${this._escapeHtml(s.url)}</div>
      </div>
      <span class="manage-server-status ${statusClass}">${statusText}</span>
      <div class="manage-server-actions">
        <button class="manage-server-visit" title="${t('servers.open_tab')}">🔗</button>
        <button class="manage-server-edit" title="${t('servers.edit')}">✏️</button>
        <button class="manage-server-delete danger-action" title="${t('servers.remove')}">🗑️</button>
      </div>
    `;

    // ── Drag-and-drop handlers ──
    row.addEventListener('dragstart', (e) => {
      dragSrcRow = row;
      row.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', s.url);
    });
    row.addEventListener('dragend', () => {
      row.classList.remove('dragging');
      container.querySelectorAll('.manage-server-row').forEach(r => r.classList.remove('drag-over-above', 'drag-over-below'));
      dragSrcRow = null;
    });
    row.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (dragSrcRow === row) return;
      const rect = row.getBoundingClientRect();
      const mid = rect.top + rect.height / 2;
      row.classList.toggle('drag-over-above', e.clientY < mid);
      row.classList.toggle('drag-over-below', e.clientY >= mid);
    });
    row.addEventListener('dragleave', () => {
      row.classList.remove('drag-over-above', 'drag-over-below');
    });
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      row.classList.remove('drag-over-above', 'drag-over-below');
      if (!dragSrcRow || dragSrcRow === row) return;
      const rect = row.getBoundingClientRect();
      const mid = rect.top + rect.height / 2;
      if (e.clientY < mid) {
        container.insertBefore(dragSrcRow, row);
      } else {
        container.insertBefore(dragSrcRow, row.nextSibling);
      }
      // Persist the new order
      const orderedUrls = [...container.querySelectorAll('.manage-server-row')].map(r => r.dataset.url);
      this.serverManager.reorder(orderedUrls);
      this._renderServerBar();
      this._pushServerListToServer();
    });

    row.querySelector('.manage-server-visit').addEventListener('click', () => {
      if (window.havenDesktop?.switchServer) {
        window.havenDesktop.switchServer(s.url);
      } else {
        window.open(s.url, '_blank', 'noopener');
      }
    });
    row.querySelector('.manage-server-edit').addEventListener('click', () => {
      document.getElementById('manage-servers-modal').style.display = 'none';
      this._editServer(s.url);
    });
    row.querySelector('.manage-server-delete').addEventListener('click', () => {
      if (!confirm(t('confirm.remove_server', { name: s.name }))) return;
      this.serverManager.markRemoved(s.url);
      this.serverManager.remove(s.url);
      // Also drop from Desktop's cross-server history so it stops getting
      // re-merged into other servers' sidebars on the next sync.
      window.havenDesktop?.removeServerHistory?.(s.url)?.catch?.(() => {});
      this._renderServerBar();
      this._renderManageServersList();
      this._showToast(t('toasts.server_removed_named', { name: s.name }), 'success');
      this._pushServerListToServer();
    });

    // CSP-safe icon error handling: hide broken img, show initial letter
    const iconImg = row.querySelector('.manage-srv-icon-img');
    if (iconImg) {
      iconImg.addEventListener('error', () => {
        iconImg.style.display = 'none';
        iconImg.parentElement.textContent = initial;
      });
    }

    container.appendChild(row);
  });
},

_updateServerBadgeDots(badges) {
  if (!badges) return;
  // Main process keys serverBadgeState by normalized URL (no trailing slash,
  // no /app or /app.html, no query/hash). The DOM stores the raw user-entered
  // URL, so a direct lookup misses for any server that doesn't already happen
  // to match exactly. Normalize both sides before comparing.
  const norm = (raw) => {
    let v = String(raw || '').trim();
    if (!v) return '';
    if (!/^https?:\/\//i.test(v)) v = 'https://' + v;
    try {
      const u = new URL(v);
      u.hash = ''; u.search = '';
      let p = (u.pathname || '/').replace(/\/+$/, '') || '/';
      p = p.replace(/\/app(?:\.html)?$/i, '') || '/';
      p = p.replace(/\/+$/, '') || '/';
      return p === '/' ? u.origin : u.origin + p;
    } catch {
      return v.replace(/\/+$/, '');
    }
  };
  const normalized = {};
  for (const [k, v] of Object.entries(badges)) normalized[norm(k)] = v;
  document.querySelectorAll('#server-list .server-icon.remote').forEach(el => {
    const url = el.dataset.url;
    const dot = el.querySelector('.server-unread-dot');
    if (!dot) return;
    const count = normalized[norm(url)] || normalized[url] || badges[url] || 0;
    dot.classList.toggle('active', count > 0);
  });
  // Report the URLs we can actually surface to the user back to main.
  // Without this, a background BrowserView for a server the user never
  // added on this origin would light the taskbar with no visible dot
  // anywhere — a "phantom" badge. Main filters the taskbar to URLs that
  // at least one renderer can display. (#5269)
  this._reportKnownServerUrls();
},

// Drag-and-drop reordering of remote server icons in the sidebar.
// Mirrors the channel sidebar drag pattern: event delegation on the list
// container, drop reorders the underlying ServerManager list, then
// re-renders. Idempotent — only attaches handlers once per list element.
_setupServerBarDrag(list) {
  if (!list || list._serverDragSetup) return;
  list._serverDragSetup = true;

  const indicator = document.createElement('div');
  indicator.className = 'server-drop-indicator';

  const cleanup = () => {
    if (list._serverDragSrc) list._serverDragSrc.classList.remove('server-dragging');
    list._serverDragSrc = null;
    indicator.remove();
  };

  list.addEventListener('dragstart', (e) => {
    const el = e.target.closest('.server-icon.remote[draggable="true"]');
    if (!el) return;
    list._serverDragSrc = el;
    el.classList.add('server-dragging');
    try { e.dataTransfer.effectAllowed = 'move'; } catch {}
    try { e.dataTransfer.setData('text/plain', el.dataset.url || ''); } catch {}
  });

  list.addEventListener('dragover', (e) => {
    if (!list._serverDragSrc) return;
    e.preventDefault();
    try { e.dataTransfer.dropEffect = 'move'; } catch {}
    const tgt = e.target.closest('.server-icon.remote');
    if (!tgt || tgt === list._serverDragSrc) { indicator.remove(); return; }
    const rect = tgt.getBoundingClientRect();
    const before = (e.clientY - rect.top) < rect.height / 2;
    if (before) list.insertBefore(indicator, tgt);
    else list.insertBefore(indicator, tgt.nextSibling);
  });

  list.addEventListener('dragleave', (e) => {
    if (!list.contains(e.relatedTarget)) indicator.remove();
  });

  list.addEventListener('drop', (e) => {
    e.preventDefault();
    const src = list._serverDragSrc;
    if (!src || !indicator.parentNode) { cleanup(); return; }
    indicator.parentNode.insertBefore(src, indicator);
    indicator.remove();
    src.classList.remove('server-dragging');
    list._serverDragSrc = null;
    const orderedUrls = Array.from(list.querySelectorAll('.server-icon.remote')).map(el => el.dataset.url);
    if (this.serverManager?.reorder) {
      this.serverManager.reorder(orderedUrls);
      this._pushServerListToServer?.();
      this._renderServerBar();
    }
  });

  list.addEventListener('dragend', cleanup);
},

// Tell the desktop main process which server URLs this view recognises
// (its own origin + every remote icon currently in its sidebar). Main
// uses this to filter the taskbar overlay so it never shows a badge for
// a server the user can't see/visit from any open view.
_reportKnownServerUrls() {
  if (!window.havenDesktop?.reportKnownServerUrls) return;
  const norm = (raw) => {
    let v = String(raw || '').trim();
    if (!v) return '';
    if (!/^https?:\/\//i.test(v)) v = 'https://' + v;
    try {
      const u = new URL(v);
      u.hash = ''; u.search = '';
      let p = (u.pathname || '/').replace(/\/+$/, '') || '/';
      p = p.replace(/\/app(?:\.html)?$/i, '') || '/';
      p = p.replace(/\/+$/, '') || '/';
      return p === '/' ? u.origin : u.origin + p;
    } catch { return v.replace(/\/+$/, ''); }
  };
  const known = new Set();
  known.add(norm(window.location.origin));
  document.querySelectorAll('#server-list .server-icon.remote').forEach(el => {
    const u = norm(el.dataset.url);
    if (u) known.add(u);
  });
  try { window.havenDesktop.reportKnownServerUrls(Array.from(known)); } catch { /* ignore */ }
},

// Append a stable cache-buster query param to icon URLs. This forces the
// browser to bypass any pre-CORS cached response for the same image (which
// causes "No Access-Control-Allow-Origin" errors when a non-crossorigin
// load was cached without the proper Vary: Origin header). See #5240.
_withCacheBust(url) {
  if (!url || typeof url !== 'string') return url;
  if (url.startsWith('data:') || url.startsWith('blob:')) return url;
  // 'cors2' marks the post-Vary/CORP header fix; bump if the cache invariant changes again.
  const tag = 'cors2';
  return url + (url.includes('?') ? '&' : '?') + '_cb=' + tag;
},

_renderServerBar() {
  const list = document.getElementById('server-list');
  const currentOrigin = window.location.origin;
  const selfFp = this.serverManager.selfFingerprint;
  const servers = this.serverManager.getAll().filter(s => {
    if (selfFp && s.status.fingerprint === selfFp) return false;
    try { return new URL(s.url).origin !== currentOrigin; } catch { return true; }
  });

  list.innerHTML = servers.map(s => {
    const initial = s.name.charAt(0).toUpperCase();
    const online = s.status.online;
    const statusClass = online === true ? 'online' : online === false ? 'offline' : 'unknown';
    const statusText = online === true ? '● ' + t('servers.online') : online === false ? '○ ' + t('servers.offline') : '◌ ' + t('servers.checking');
    // Use custom icon, auto-pulled icon from health check, or letter initial
    const iconUrl = s.icon || (s.status.icon || null);
    // Append a stable cache-buster so browsers don't reuse a bad pre-CORS
    // cached response (which causes "No Access-Control-Allow-Origin" errors
    // on icons that were loaded once without the crossorigin attribute). See #5240.
    const bustedIcon = iconUrl ? this._withCacheBust(iconUrl) : null;
    const iconContent = bustedIcon
      ? `<img src="${this._escapeHtml(bustedIcon)}" class="server-icon-img" crossorigin="anonymous"${s.iconData ? ` data-fallback-src="${this._escapeHtml(s.iconData)}"` : ''} alt=""><span class="server-icon-text" style="display:none">${this._escapeHtml(initial)}</span>`
      : (s.iconData
        ? `<img src="${this._escapeHtml(s.iconData)}" class="server-icon-img" alt=""><span class="server-icon-text" style="display:none">${this._escapeHtml(initial)}</span>`
        : `<span class="server-icon-text">${this._escapeHtml(initial)}</span>`);
    return `
      <div class="server-icon remote" data-url="${this._escapeHtml(s.url)}" draggable="true"
           title="${this._escapeHtml(s.name)} — ${statusText}">
        ${iconContent}
        <span class="server-status-dot ${statusClass}"></span>
        ${window.havenDesktop ? '<span class="server-unread-dot"></span>' : ''}
        <button class="server-remove" title="${t('servers.remove')}">&times;</button>
      </div>
    `;
  }).join('');

  // CSP-safe: handle broken server icons, fall back to thumbnail or letter initial
  list.querySelectorAll('.server-icon-img').forEach(img => {
    img.addEventListener('error', () => {
      const fallbackSrc = img.dataset.fallbackSrc;
      if (fallbackSrc && img.src !== fallbackSrc) {
        img.removeAttribute('data-fallback-src');
        img.src = fallbackSrc;
        return;
      }
      img.style.display = 'none';
      const fallback = img.nextElementSibling;
      if (fallback) fallback.style.display = '';
    });
  });

  list.querySelectorAll('.server-icon.remote').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.classList.contains('server-remove')) {
        e.stopPropagation();
        const serverName = el.getAttribute('title')?.split(' — ')[0] || el.dataset.url;
        if (!confirm(t('confirm.remove_server', { name: serverName }))) return;
        this.serverManager.markRemoved(el.dataset.url);
        this.serverManager.remove(el.dataset.url);
        // Also drop from Desktop's cross-server history so it stops getting
        // re-merged into other servers' sidebars on the next sync.
        window.havenDesktop?.removeServerHistory?.(el.dataset.url)?.catch?.(() => {});
        this._renderServerBar();
        this._showToast(t('toasts.server_removed'), 'success');
        this._pushServerListToServer();
        return;
      }
      if (window.havenDesktop?.switchServer) {
        window.havenDesktop.switchServer(el.dataset.url);
      } else {
        window.open(el.dataset.url, '_blank', 'noopener');
      }
    });
    // Right-click to edit
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this._editServer(el.dataset.url);
    });
  });

  // Drag-and-drop reordering of remote server icons. Idempotent: handlers
  // live on the list container so re-rendering doesn't double-bind.
  this._setupServerBarDrag(list);

  // Also update mobile sidebar server bubbles
  this._renderMobileSidebarServers();

  // After re-rendering the bar, the set of known server URLs may have
  // changed — tell main so it can drop phantom taskbar badges from
  // background views the user no longer has an icon for. (#5269)
  this._reportKnownServerUrls();
},

// ═══════════════════════════════════════════════════════
// IMAGE UPLOAD — button, paste, drag & drop
// ═══════════════════════════════════════════════════════

_setupImageUpload() {
  const fileInput = document.getElementById('file-input');
  const uploadBtn = document.getElementById('upload-btn');
  const messageArea = document.getElementById('message-area');

  uploadBtn.addEventListener('click', () => {
    if (!this.currentChannel) return this._showToast(t('toasts.select_channel_first'), 'error');
    fileInput.click();
  });

  fileInput.addEventListener('change', () => {
    if (!fileInput.files[0]) return;
    const file = fileInput.files[0];
    if (file.type.startsWith('image/')) {
      this._queueImage(file);
    } else {
      this._uploadGeneralFile(file);
    }
    fileInput.value = '';
  });

  // Paste from clipboard — images get queued, other files go to general upload
  document.getElementById('message-input').addEventListener('paste', (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        this._queueImage(item.getAsFile());
        return;
      }
      if (item.kind === 'file') {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) this._uploadGeneralFile(file);
        return;
      }
    }
  });

  // Drag & drop — QUEUE instead of uploading immediately
  messageArea.addEventListener('dragover', (e) => {
    e.preventDefault();
    messageArea.classList.add('drag-over');
  });

  messageArea.addEventListener('dragleave', () => {
    messageArea.classList.remove('drag-over');
  });

  messageArea.addEventListener('drop', (e) => {
    e.preventDefault();
    messageArea.classList.remove('drag-over');
    const file = e.dataTransfer?.files[0];
    if (!file) return;
    if (file.type.startsWith('image/')) {
      this._queueImage(file);
    } else {
      this._uploadGeneralFile(file);
    }
  });
},

// ═══════════════════════════════════════════════════════
// MOBILE — hamburger, overlay, swipe gestures
// ═══════════════════════════════════════════════════════

_setupMobile() {
  const menuBtn = document.getElementById('mobile-menu-btn');
  const usersBtn = document.getElementById('mobile-users-btn');
  const overlay = document.getElementById('mobile-overlay');
  const appBody = document.getElementById('app-body');

  // Hamburger — toggle left sidebar
  menuBtn.addEventListener('click', () => {
    const isOpen = appBody.classList.toggle('mobile-sidebar-open');
    appBody.classList.remove('mobile-right-open');
    if (isOpen) overlay.classList.add('active');
    else overlay.classList.remove('active');
  });

  // Users button — toggle right sidebar
  usersBtn.addEventListener('click', () => {
    const isOpen = appBody.classList.toggle('mobile-right-open');
    appBody.classList.remove('mobile-sidebar-open');
    if (isOpen) overlay.classList.add('active');
    else overlay.classList.remove('active');
  });

  // Overlay click — close everything
  overlay.addEventListener('click', () => this._closeMobilePanels());

  // Close buttons inside panels
  document.getElementById('mobile-sidebar-close')?.addEventListener('click', () => this._closeMobilePanels());
  document.getElementById('mobile-right-close')?.addEventListener('click', () => this._closeMobilePanels());

  // Close sidebar when switching channels on mobile
  const origSwitch = this.switchChannel.bind(this);
  this.switchChannel = (code) => {
    origSwitch(code);
    this._closeMobilePanels();
  };

  // Swipe gesture support (touch)
  let touchStartX = 0;
  let touchStartY = 0;
  const SWIPE_THRESHOLD = 60;

  document.addEventListener('touchstart', (e) => {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
  }, { passive: true });

  document.addEventListener('touchend', (e) => {
    const dx = e.changedTouches[0].clientX - touchStartX;
    const dy = e.changedTouches[0].clientY - touchStartY;
    // Only process horizontal swipes (not scrolling)
    if (Math.abs(dx) < SWIPE_THRESHOLD || Math.abs(dy) > Math.abs(dx)) return;

    if (dx > 0 && touchStartX < 40) {
      // Swipe right from left edge → open left sidebar
      appBody.classList.add('mobile-sidebar-open');
      appBody.classList.remove('mobile-right-open');
      overlay.classList.add('active');
    } else if (dx < 0 && touchStartX > window.innerWidth - 40) {
      // Swipe left from right edge → open right sidebar
      appBody.classList.add('mobile-right-open');
      appBody.classList.remove('mobile-sidebar-open');
      overlay.classList.add('active');
    } else if (dx < 0 && appBody.classList.contains('mobile-sidebar-open')) {
      this._closeMobilePanels();
    } else if (dx > 0 && appBody.classList.contains('mobile-right-open')) {
      this._closeMobilePanels();
    }
  }, { passive: true });

  // ── Mobile server dropdown ──
  const mobileServerBtn = document.getElementById('mobile-server-btn');
  const mobileServerMenu = document.getElementById('mobile-server-menu');
  if (mobileServerBtn && mobileServerMenu) {
    mobileServerBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._renderMobileServerList();
      mobileServerMenu.classList.toggle('open');
    });
    document.addEventListener('click', () => mobileServerMenu.classList.remove('open'));
    mobileServerMenu.addEventListener('click', (e) => e.stopPropagation());
    document.getElementById('mobile-server-add-btn')?.addEventListener('click', () => {
      mobileServerMenu.classList.remove('open');
      this._editingServerUrl = null;
      document.getElementById('add-server-modal-title').textContent = t('modals.add_server.title');
      document.getElementById('add-server-modal').style.display = 'flex';
      document.getElementById('add-server-name-input').value = '';
      document.getElementById('server-url-input').value = '';
      document.getElementById('server-url-input').disabled = false;
      document.getElementById('add-server-icon-input').value = '';
      document.getElementById('save-server-btn').textContent = t('modals.add_server.add_btn');
      document.getElementById('add-server-name-input').focus();
    });
  }

  // ── Mobile message actions: ⋯ button ──
  // Detect touch capability broadly: matchMedia OR ontouchstart presence.
  const isTouchDevice = window.matchMedia('(hover: none) and (pointer: coarse)').matches
                     || window.matchMedia('(pointer: coarse)').matches
                     || 'ontouchstart' in window
                     || navigator.maxTouchPoints > 0;
  if (isTouchDevice) {
    const messagesEl = document.getElementById('messages');
    let _suppressDismissUntil = 0;
    // Hide the old floating singleton "⋯" button — each message now has its own
    const oldMoreBtn = document.getElementById('msg-more-btn');
    if (oldMoreBtn) oldMoreBtn.style.display = 'none';

    const _deselectAll = () => {
      messagesEl.querySelectorAll('.msg-selected').forEach(el => {
        el.classList.remove('msg-selected');
        const toolbar = el.querySelector('.msg-toolbar');
        if (toolbar) toolbar.style.removeProperty('display');
      });
    };

    const _selectMsg = (msgEl) => {
      if (!msgEl) return;
      _deselectAll();
      msgEl.classList.add('msg-selected');
      // Touch interactions often emit a synthetic click right after selection.
      // Ignore dismiss logic briefly so the toolbar stays open.
      _suppressDismissUntil = Date.now() + 450;
      // Force immediate visual update on touch browsers where class-based
      // CSS can paint one interaction late.
      const toolbar = msgEl.querySelector('.msg-toolbar');
      if (toolbar) toolbar.style.setProperty('display', 'flex', 'important');
      if (navigator.vibrate) navigator.vibrate(15);
      requestAnimationFrame(() => {
        if (!msgEl.classList.contains('msg-selected')) return;
        const tb = msgEl.querySelector('.msg-toolbar');
        if (tb) tb.style.setProperty('display', 'flex', 'important');
      });
    };

    // Suppress the browser's native context menu so it doesn't
    // compete with our custom toolbar.
    messagesEl.addEventListener('contextmenu', (e) => {
      if (e.target.classList.contains('chat-image')) return;
      const msgEl = e.target.closest('.message, .message-compact');
      if (msgEl) e.preventDefault();
    });

    // ── Inline ⋯ button: always visible on each message ──
    // Tapping it toggles msg-selected which reveals the full toolbar.
    messagesEl.addEventListener('click', (e) => {
      const dotsBtn = e.target.closest('.msg-dots-btn');
      if (dotsBtn) {
        e.stopPropagation();
        e.preventDefault();
        const msgEl = dotsBtn.closest('.message, .message-compact');
        if (!msgEl) return;
        const wasSelected = msgEl.classList.contains('msg-selected');
        _deselectAll();
        if (!wasSelected) _selectMsg(msgEl);
        return;
      }
      // Any non-toolbar/non-dots tap should dismiss the current toolbar.
      // This keeps mobile behavior consistent: tap elsewhere = close actions.
      if (!e.target.closest('.msg-toolbar')) {
        if (Date.now() < _suppressDismissUntil) return;
        _deselectAll();
      }
      // Let toolbar button taps through
      if (e.target.closest('.msg-toolbar')) return;
      // Let interactive elements through
      if (e.target.closest('a') || e.target.closest('.reaction-badge') ||
          e.target.closest('.spoiler') || e.target.closest('.reply-banner')) return;
      // Don't interfere with author/avatar clicks (profile popup)
      if (e.target.closest('.message-author') || e.target.closest('.message-avatar') ||
          e.target.closest('.message-avatar-img')) return;
      // Let images through (lightbox etc)
      if (e.target.closest('img')) return;
    });

    // Dismiss on touch outside messages
    document.addEventListener('touchstart', (e) => {
      if (e.target.closest('.msg-toolbar') || e.target.closest('.msg-dots-btn')) return;
      if (!e.target.closest('#messages')) {
        _deselectAll();
      }
    }, { passive: true });

    // Deselect when focusing input area
    document.getElementById('message-input').addEventListener('focus', () => {
      _deselectAll();
    });

    // Deselect on significant scroll (debounced, threshold-based)
    let _scrollStart = null;
    messagesEl.addEventListener('scroll', () => {
      if (_scrollStart === null) _scrollStart = messagesEl.scrollTop;
      if (Math.abs(messagesEl.scrollTop - _scrollStart) > 30) {
        _deselectAll();
        _scrollStart = null;
      }
    }, { passive: true });
    messagesEl.addEventListener('touchstart', () => {
      _scrollStart = messagesEl.scrollTop;
    }, { passive: true });
  }
},

_closeMobilePanels() {
  const appBody = document.getElementById('app-body');
  const overlay = document.getElementById('mobile-overlay');
  appBody.classList.remove('mobile-sidebar-open', 'mobile-right-open');
  overlay.classList.remove('active');
},

_renderMobileServerList() {
  const list = document.getElementById('mobile-server-list');
  if (!list || !this.serverManager) return;
  const servers = this.serverManager.getAll();
  if (servers.length === 0) {
    list.innerHTML = `<div style="padding:8px 10px;color:var(--text-muted);font-size:12px;">${t('servers.no_servers')}</div>`;
    return;
  }
  list.innerHTML = servers.map(s => {
    const initial = s.name.charAt(0).toUpperCase();
    const online = s.status.online;
    const dotClass = online === true ? 'online' : online === false ? 'offline' : 'unknown';
    const iconUrl = s.icon || (s.status.icon || null);
    const bustedIcon = iconUrl ? this._withCacheBust(iconUrl) : null;
    const iconHtml = bustedIcon
      ? `<img src="${this._escapeHtml(bustedIcon)}" class="msrv-icon" alt="" crossorigin="anonymous">`
      + `<span class="msrv-initial" style="display:none">${initial}</span>`
      : `<span class="msrv-initial">${initial}</span>`;
    return `<a class="mobile-server-item" href="${this._escapeHtml(s.url)}" target="_blank" rel="noopener">
      <span class="msrv-dot ${dotClass}"></span>
      ${iconHtml}
      <span>${this._escapeHtml(s.name)}</span>
    </a>`;
  }).join('');
  list.querySelectorAll('.msrv-icon').forEach(img => {
    img.addEventListener('error', () => {
      img.style.display = 'none';
      if (img.nextElementSibling) img.nextElementSibling.style.display = '';
    });
  });
},

// ═══════════════════════════════════════════════════════
// MOBILE SIDEBAR SERVER BUBBLES
// ═══════════════════════════════════════════════════════

_renderMobileSidebarServers() {
  const scroll = document.getElementById('mobile-servers-scroll');
  if (!scroll || !this.serverManager) return;
  const currentOrigin = window.location.origin;
  const selfFp = this.serverManager.selfFingerprint;
  const servers = this.serverManager.getAll().filter(s => {
    if (selfFp && s.status.fingerprint === selfFp) return false;
    try { return new URL(s.url).origin !== currentOrigin; } catch { return true; }
  });
  if (servers.length === 0) {
    scroll.innerHTML = `<span class="mobile-servers-empty">${t('servers.no_servers')}</span>`;
    return;
  }
  scroll.innerHTML = servers.map(s => {
    const initial = s.name.charAt(0).toUpperCase();
    const online = s.status.online;
    const dotClass = online === true ? 'online' : online === false ? 'offline' : 'unknown';
    const iconUrl = s.icon || (s.status.icon || null);
    const bustedIcon = iconUrl ? this._withCacheBust(iconUrl) : null;
    const iconHtml = bustedIcon
      ? `<img src="${this._escapeHtml(bustedIcon)}" alt="${this._escapeHtml(initial)}" class="mobile-srv-icon-img" crossorigin="anonymous">`
      : `<span>${this._escapeHtml(initial)}</span>`;
    return `<a class="mobile-srv-bubble" href="${this._escapeHtml(s.url)}" target="_blank" rel="noopener" title="${this._escapeHtml(s.name)}">
      ${iconHtml}
      <span class="msrv-status ${dotClass}"></span>
    </a>`;
  }).join('');

  // CSP-safe: handle broken server icons, fall back to letter initial
  scroll.querySelectorAll('.mobile-srv-icon-img').forEach(img => {
    img.addEventListener('error', () => {
      const initial = img.alt || '?';
      const span = document.createElement('span');
      span.textContent = initial;
      img.replaceWith(span);
    });
  });
},

_setupMobileSidebarServers() {
  // Toggle collapse
  const toggle = document.getElementById('mobile-servers-toggle');
  const arrow = document.getElementById('mobile-servers-arrow');
  const row = document.getElementById('mobile-servers-row');
  if (toggle && row) {
    const collapsed = localStorage.getItem('haven_mobile_servers_collapsed') === '1';
    if (collapsed) {
      arrow?.classList.add('collapsed');
      row.classList.add('collapsed');
    }
    toggle.addEventListener('click', () => {
      const isCollapsed = row.classList.toggle('collapsed');
      arrow?.classList.toggle('collapsed', isCollapsed);
      localStorage.setItem('haven_mobile_servers_collapsed', isCollapsed ? '1' : '0');
    });
  }
  // Add-server button
  document.getElementById('mobile-srv-add-btn')?.addEventListener('click', () => {
    this._editingServerUrl = null;
    document.getElementById('add-server-modal-title').textContent = t('modals.add_server.title');
    document.getElementById('add-server-modal').style.display = 'flex';
    document.getElementById('add-server-name-input').value = '';
    document.getElementById('server-url-input').value = '';
    document.getElementById('server-url-input').disabled = false;
    document.getElementById('add-server-icon-input').value = '';
    document.getElementById('save-server-btn').textContent = t('modals.add_server.add_btn');
    document.getElementById('add-server-name-input').focus();
  });
  // Initial render
  this._renderMobileSidebarServers();
},

// ═══════════════════════════════════════════════════════
// COLLAPSIBLE SIDEBAR SECTIONS (Join / Create)
// ═══════════════════════════════════════════════════════

_setupCollapsibleSections() {
  const sections = [
    { toggle: 'join-section-toggle', arrow: 'join-section-arrow', body: 'join-section-body', key: 'haven_join_collapsed' },
    { toggle: 'create-section-toggle', arrow: 'create-section-arrow', body: 'create-section-body', key: 'haven_create_collapsed' },
  ];
  sections.forEach(({ toggle, arrow, body, key }) => {
    const toggleEl = document.getElementById(toggle);
    const arrowEl = document.getElementById(arrow);
    const bodyEl = document.getElementById(body);
    if (!toggleEl || !bodyEl) return;

    // Restore saved state (default = expanded)
    const saved = localStorage.getItem(key);
    if (saved === '1') {
      arrowEl?.classList.add('collapsed');
      bodyEl.classList.add('collapsed');
    }

    toggleEl.addEventListener('click', () => {
      const isCollapsed = bodyEl.classList.toggle('collapsed');
      arrowEl?.classList.toggle('collapsed', isCollapsed);
      localStorage.setItem(key, isCollapsed ? '1' : '0');
    });
  });
},

/* ── Polls ───────────────────────────────────────────── */

_openPollModal() {
  const modal = document.getElementById('poll-modal');
  document.getElementById('poll-question-input').value = '';
  document.getElementById('poll-multi-vote').checked = false;
  document.getElementById('poll-anonymous').checked = false;
  const list = document.getElementById('poll-options-list');
  list.innerHTML = '';
  for (let i = 0; i < 2; i++) {
    this._addPollOptionRow(list, i);
  }
  modal.style.display = 'flex';
  document.getElementById('poll-question-input').focus();
},

_addPollOptionRow(list, index) {
  if (!list) list = document.getElementById('poll-options-list');
  const row = document.createElement('div');
  row.className = 'poll-option-row';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'poll-option-input';
  input.placeholder = `Option ${index + 1}`;
  input.maxLength = 100;
  const removeBtn = document.createElement('button');
  removeBtn.className = 'poll-option-remove';
  removeBtn.textContent = '\u00d7';
  removeBtn.title = t('modals.poll.remove_option');
  removeBtn.style.display = list.children.length >= 2 ? '' : 'none';
  removeBtn.addEventListener('click', () => {
    row.remove();
    this._updatePollRemoveButtons();
  });
  row.appendChild(input);
  row.appendChild(removeBtn);
  list.appendChild(row);
  this._updatePollRemoveButtons();
},

_addPollOption() {
  const list = document.getElementById('poll-options-list');
  const maxOpts = parseInt(this.serverSettings?.max_poll_options) || 10;
  if (list.children.length >= maxOpts) return;
  this._addPollOptionRow(list, list.children.length);
  const inputs = list.querySelectorAll('.poll-option-input');
  inputs[inputs.length - 1].focus();
},

_updatePollRemoveButtons() {
  const list = document.getElementById('poll-options-list');
  const btns = list.querySelectorAll('.poll-option-remove');
  btns.forEach(b => { b.style.display = list.children.length > 2 ? '' : 'none'; });
},

_submitPoll() {
  const question = document.getElementById('poll-question-input').value.trim();
  if (!question) return;
  const inputs = document.querySelectorAll('#poll-options-list .poll-option-input');
  const options = Array.from(inputs).map(i => i.value.trim()).filter(Boolean);
  if (options.length < 2) return;
  const multiVote = document.getElementById('poll-multi-vote').checked;
  const anonymous = document.getElementById('poll-anonymous').checked;

  this.socket.emit('create-poll', { question, options, multiVote, anonymous });
  document.getElementById('poll-modal').style.display = 'none';
},

/* ── iOS Keyboard Layout Fix ────────────────────────── */
// iOS Safari (both standalone PWA and browser) doesn't always shrink the
// viewport reliably when the virtual keyboard opens.  We use the
// visualViewport API to detect the keyboard height and resize #app so
// the message input stays visible above the keyboard.

_setupIOSKeyboard() {
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  // ── Safe-area probing (all mobile, but especially iOS) ──
  // env(safe-area-inset-*) sometimes returns 0 even on notched devices
  // (e.g. certain iOS versions in browser vs PWA mode, or when CSS env()
  //  isn't evaluated). We probe the actual value via a hidden element and
  // set CSS custom properties with a minimum floor as fallback.
  if (isIOS || /Android/.test(navigator.userAgent)) {
    const isMobile = window.innerWidth <= 768;
    if (isMobile) {
      document.body.classList.add(isIOS ? 'is-ios' : 'is-android');

      // Detect standalone PWA mode
      if (isIOS && (window.navigator.standalone || window.matchMedia('(display-mode: standalone)').matches)) {
        document.body.classList.add('is-ios-pwa');
      }

      // Probe env(safe-area-inset-top) by measuring a hidden div
      const probe = document.createElement('div');
      probe.style.cssText = 'position:fixed;top:0;left:0;width:1px;pointer-events:none;visibility:hidden;'
        + 'height:env(safe-area-inset-top,0px);height:constant(safe-area-inset-top)';
      document.body.appendChild(probe);

      requestAnimationFrame(() => {
        const measuredTop = probe.offsetHeight;
        probe.style.cssText = 'position:fixed;bottom:0;left:0;width:1px;pointer-events:none;visibility:hidden;'
          + 'height:env(safe-area-inset-bottom,0px);height:constant(safe-area-inset-bottom)';

        requestAnimationFrame(() => {
          const measuredBottom = probe.offsetHeight;
          document.body.removeChild(probe);

          // Determine minimum safe-area for this device
          let minTop = 0, minBottom = 0;
          if (isIOS) {
            const h = window.screen.height;
            // iPhone X+ / Dynamic Island (screen height >= 812pt)
            if (h >= 812) { minTop = 47; minBottom = 34; }
            // Older iPhones
            else { minTop = 20; minBottom = 0; }
          }

          const safeTop = Math.max(measuredTop, minTop);
          const safeBottom = Math.max(measuredBottom, minBottom);
          const root = document.documentElement;
          root.style.setProperty('--safe-top', safeTop + 'px');
          root.style.setProperty('--safe-bottom', safeBottom + 'px');
        });
      });
    }
  }

  if (!window.visualViewport || !isIOS) return;

  const app = document.getElementById('app');
  const messages = document.getElementById('messages');

  const onViewportResize = () => {
    const kbHeight = window.innerHeight - window.visualViewport.height;
    // Only apply when keyboard is actually open (threshold avoids toolbar jitter)
    if (kbHeight > 50) {
      app.style.height = window.visualViewport.height + 'px';
      document.body.classList.add('ios-keyboard-open');
      // Scroll messages to bottom so user sees latest while typing
      if (messages) requestAnimationFrame(() => messages.scrollTop = messages.scrollHeight);
    } else {
      app.style.height = '';
      document.body.classList.remove('ios-keyboard-open');
    }
  };

  window.visualViewport.addEventListener('resize', onViewportResize);
  window.visualViewport.addEventListener('scroll', onViewportResize);
},

/* ── Mobile App Bridge (Capacitor shell ↔ Haven) ───── */

_setupMobileBridge() {
  // Only activate when running inside the mobile app's iframe
  this._isMobileApp = (window !== window.top);
  if (!this._isMobileApp) return;

  // Add a body class so CSS can adapt for mobile-app context
  document.body.classList.add('haven-mobile-app');

  // Listen for messages from the Capacitor shell
  window.addEventListener('message', (e) => {
    const data = e.data;
    if (!data || typeof data.type !== 'string') return;

    switch (data.type) {
      case 'haven:back':
        this._handleMobileBack();
        break;

      case 'haven:fcm-token':
        // Receive FCM token from native layer → send to server
        if (data.token && this.socket?.connected) {
          this.socket.emit('register-fcm-token', { token: data.token });
        }
        this._fcmToken = data.token;
        break;

      case 'haven:mobile-init':
        // Shell confirms we're in mobile app
        this._mobilePlatform = data.platform || 'unknown';
        break;

      case 'haven:push-received':
        // In-app push notification received while app is open
        if (data.notification) {
          const n = data.notification;
          const title = n.title || 'Haven';
          const body = n.body || '';
          this._showToast(`${title}: ${body}`, 'info');
        }
        break;

      case 'haven:push-action':
        // User tapped a push notification → switch to that channel
        if (data.data?.channelCode) {
          this.switchChannel(data.data.channelCode);
        }
        break;

      case 'haven:resume':
        // App returned to foreground — reconnect socket if needed
        if (this.socket && !this.socket.connected) {
          this.socket.connect();
        }
        break;

      case 'haven:keyboard':
        // Keyboard visibility changed
        if (data.visible) {
          document.body.classList.add('native-keyboard-open');
        } else {
          document.body.classList.remove('native-keyboard-open');
        }
        break;
    }
  });

  // Notify the shell that Haven is loaded and ready
  this._postToShell({ type: 'haven:ready' });

  // If user logs out, tell the shell
  const origLogout = this._logout?.bind(this);
  const logoutBtn = document.getElementById('logout-btn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', () => {
      this._postToShell({ type: 'haven:disconnect' });
    }, { capture: true });
  }

  // Send theme color to shell so status bar can match
  this._reportThemeColor();

  // Watch for theme changes and re-report
  const themeObs = new MutationObserver(() => {
    setTimeout(() => this._reportThemeColor(), 100);
  });
  themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
},

_postToShell(msg) {
  if (!this._isMobileApp) return;
  try { window.parent.postMessage(msg, '*'); } catch (_) {}
},

_handleMobileBack() {
  // Priority order: close the most "on-top" UI element first

  // 1. Any open modal overlays
  const openModals = document.querySelectorAll('.modal-overlay');
  for (const m of openModals) {
    if (m.style.display && m.style.display !== 'none') {
      m.style.display = 'none';
      return;
    }
  }

  // 2. Search container / results
  const search = document.getElementById('search-container');
  if (search && search.style.display !== 'none' && search.style.display !== '') {
    search.style.display = 'none';
    document.getElementById('search-results-panel').style.display = 'none';
    return;
  }

  // 3. Theme popup
  const themePopup = document.getElementById('theme-popup');
  if (themePopup && themePopup.style.display !== 'none' && themePopup.style.display !== '') {
    themePopup.style.display = 'none';
    return;
  }

  // 4. Voice settings panel
  const voicePanel = document.getElementById('voice-settings-panel');
  if (voicePanel && voicePanel.classList.contains('open')) {
    voicePanel.classList.remove('open');
    return;
  }

  // 5. Mobile sidebars (left or right)
  const appBody = document.getElementById('app-body');
  if (appBody.classList.contains('mobile-sidebar-open') || appBody.classList.contains('mobile-right-open')) {
    this._closeMobilePanels();
    return;
  }

  // 6. GIF picker
  const gifPanel = document.getElementById('gif-panel');
  if (gifPanel && gifPanel.style.display !== 'none' && gifPanel.style.display !== '') {
    gifPanel.style.display = 'none';
    return;
  }

  // 7. Emoji picker
  const emojiPicker = document.querySelector('emoji-picker');
  if (emojiPicker && emojiPicker.style.display !== 'none' && emojiPicker.style.display !== '') {
    emojiPicker.style.display = 'none';
    return;
  }

  // Nothing to close — tell shell
  this._postToShell({ type: 'haven:back-exhausted' });
},

_reportThemeColor() {
  if (!this._isMobileApp) return;
  // Read the computed background of the top bar or body
  const topBar = document.querySelector('.top-bar') || document.querySelector('.sidebar');
  if (topBar) {
    const bg = getComputedStyle(topBar).backgroundColor;
    // Convert rgb(r,g,b) → hex
    const match = bg.match(/(\d+)/g);
    if (match && match.length >= 3) {
      const hex = '#' + match.slice(0, 3).map(n => parseInt(n).toString(16).padStart(2, '0')).join('');
      this._postToShell({ type: 'haven:theme-color', color: hex });
    }
  }
},

_saveRename() {
  const input = document.getElementById('rename-input');
  const newName = input.value.trim().replace(/\s+/g, ' ');
  if (!newName || newName.length < 2) {
    return this._showToast(t('toasts.display_name_too_short'), 'error');
  }
  if (!/^[a-zA-Z0-9_ ]+$/.test(newName)) {
    return this._showToast(t('toasts.display_name_invalid_chars'), 'error');
  }
  this.socket.emit('rename-user', { username: newName });
  // Save bio
  const bioInput = document.getElementById('edit-profile-bio');
  if (bioInput) {
    this.socket.emit('set-bio', { bio: bioInput.value });
  }
  // Also commit any pending avatar changes
  this._commitAvatarSettings();
  document.getElementById('rename-modal').style.display = 'none';
},

// ── Upload with progress bar ───────────────────────────
_uploadWithProgress(url, formData) {
  return new Promise((resolve, reject) => {
    const bar = document.getElementById('upload-progress-bar');
    const fill = document.getElementById('upload-progress-fill');
    const text = document.getElementById('upload-progress-text');
    if (bar) { bar.style.display = 'flex'; }
    if (fill) { fill.style.width = '0%'; }
    if (text) { text.textContent = t('common.uploading'); }

    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('Authorization', `Bearer ${this.token}`);

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) {
        const pct = Math.round((e.loaded / e.total) * 100);
        if (fill) fill.style.width = pct + '%';
        if (text) text.textContent = `${pct}%`;
      }
    });

    xhr.addEventListener('load', () => {
      if (bar) bar.style.display = 'none';
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(JSON.parse(xhr.responseText)); }
        catch { reject(new Error('Invalid JSON response')); }
      } else {
        let errMsg = `Upload failed (${xhr.status})`;
        try { const d = JSON.parse(xhr.responseText); errMsg = d.error || errMsg; } catch {}
        reject(new Error(errMsg));
      }
    });

    xhr.addEventListener('error', () => {
      if (bar) bar.style.display = 'none';
      reject(new Error('Upload failed — check your connection'));
    });

    xhr.addEventListener('abort', () => {
      if (bar) bar.style.display = 'none';
      reject(new Error('Upload cancelled'));
    });

    xhr.send(formData);
  });
},

async _uploadImage(file) {
  if (!this.currentChannel) return;
  // Capture the target channel NOW (before any await) so a mid-upload channel
  // switch doesn't send the image to the wrong channel.
  const targetChannel = this.currentChannel;
  const _maxMb = parseInt(this.serverSettings?.max_upload_mb) || 25;
  if (file.size > _maxMb * 1024 * 1024) {
    return this._showToast(t('toasts.image_too_large', { max: _maxMb }), 'error');
  }

  // Detect E2E DM — encrypt file bytes before uploading
  const ch = this.channels.find(c => c.code === targetChannel);
  const isDm = ch && ch.is_dm && ch.dm_target;
  let partner = isDm ? this._getE2EPartner() : null;
  if (isDm && !partner && this.e2e && this.e2e.ready) {
    const jwk = await this.e2e.requestPartnerKey(this.socket, ch.dm_target.id);
    if (jwk) { this._dmPublicKeys[ch.dm_target.id] = jwk; partner = this._getE2EPartner(); }
  }

  if (partner) {
    // E2E path: encrypt file → upload as opaque blob → send encrypted text marker
    try {
      const arrayBuffer = await file.arrayBuffer();
      const encrypted = await this.e2e.encryptBytes(arrayBuffer, partner.userId, partner.publicKeyJwk);
      const blob = new Blob([encrypted], { type: 'application/octet-stream' });
      const formData = new FormData();
      formData.append('file', blob, 'e2e-image.enc');
      const data = await this._uploadWithProgress('/api/upload-file', formData);
      const mime = file.type || 'image/png';
      const marker = `e2e-img:${mime}:${data.url}`;
      const encryptedText = await this.e2e.encrypt(marker, partner.userId, partner.publicKeyJwk);
      this.socket.emit('send-message', {
        code: targetChannel,
        content: encryptedText,
        encrypted: true
      });
      this.notifications.play('sent');
    } catch (err) {
      console.warn('[E2E] Image encryption failed:', err);
      this._showToast(t('toasts.encrypted_image_failed'), 'error');
    }
    return;
  }

  const formData = new FormData();
  formData.append('image', file);

  try {
    const data = await this._uploadWithProgress('/api/upload', formData);

    // Send the image URL as a message to the channel that was active at upload time
    this.socket.emit('send-message', {
      code: targetChannel,
      content: data.url,
      isImage: true
    });
    this.notifications.play('sent');
  } catch (err) {
    this._showToast(err.message || t('toasts.upload_failed'), 'error');
  }
},

};
