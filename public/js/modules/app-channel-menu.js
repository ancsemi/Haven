// Channel controls in the sidebar: join and create, the "..." context menu,
// the Channel Functions panel, moving and reparenting, the Organize modals,
// sub-channels, renaming, and copying a channel link.

export default {

_bindChannelMenu() {
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
      const isForum = document.getElementById('new-channel-forum')?.checked || false;
      if (name) {
        this.socket.emit('create-channel', { name, isPrivate, temporary, duration, addAllMembers, isForum, ...this._channelTemplateExtras() });
        this._resetChannelTemplate();
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
  // Delete channel: themed confirm (issue #5307: was using two chained native confirm() calls)
  document.querySelector('[data-action="delete"]')?.addEventListener('click', async () => {
    const code = this._ctxMenuChannel;
    if (!code) return;
    this._closeChannelCtxMenu();
    const ok = await this._showConfirmModal(
      '⚠️ ' + t('confirm.delete_channel'),
      t('confirm.delete_channel_sure'),
      { danger: true }
    );
    if (!ok) return;
    // A parent takes its sub-channels with it. Say so, name them, and point
    // at the way out for anyone who wants to keep some of them.
    const ch = this.channels.find(c => c.code === code);
    const subs = ch ? this.channels.filter(c => c.parent_channel_id === ch.id) : [];
    if (subs.length) {
      const names = subs.map(s => '#' + s.name).join(', ');
      const okSubs = await this._showConfirmModal(
        '⚠️ ' + t('confirm.delete_channel_subs_title'),
        t('confirm.delete_channel_subs', { names }),
        { danger: true, confirmLabel: t('confirm.delete_channel_subs_btn') }
      );
      if (!okSubs) return;
    }
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
    const willBeMuted = idx < 0;
    if (idx >= 0) { muted.splice(idx, 1); this._showToast(t('toasts.channel_unmuted'), 'success'); }
    else { muted.push(code); this._showToast(t('toasts.channel_muted'), 'success'); }
    localStorage.setItem('haven_muted_channels', JSON.stringify(muted));
    this._syncChannelMutePref(code, willBeMuted);
    this._renderChannels();
  });
  // Copy channel link from context menu
  document.querySelector('#channel-ctx-menu [data-action="copy-channel-link"]')?.addEventListener('click', () => {
    const code = this._ctxMenuChannel;
    if (!code) return;
    if (!this._canShareChannelLink?.(code)) {
      this._closeChannelCtxMenu();
      this._showToast?.(t('toasts.channel_link_unavailable'), 'error');
      return;
    }
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
  // Hide channel (admin declutter, local only, channel stays accessible) (#5409)
  document.querySelector('[data-action="hide-channel"]')?.addEventListener('click', () => {
    const code = this._ctxMenuChannel;
    if (!code) return;
    this._closeChannelCtxMenu();
    this._hideChannel(code);
  });
  // Disconnect from voice via context menu
  document.querySelector('[data-action="leave-voice"]')?.addEventListener('click', () => {
    this._closeChannelCtxMenu();
    this._leaveVoice();
  });
  // Channel Functions panel toggle: sideways popout
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
  // Channel Functions panel: row clicks
  document.getElementById('channel-functions-panel')?.addEventListener('click', (e) => {
    const row = e.target.closest('.cfn-row');
    if (!row || row.classList.contains('cfn-disabled')) return;
    e.stopPropagation();
    const fn = row.dataset.fn;
    const code = this._ctxMenuChannel;
    if (!code) return;
    const ch = this.channels.find(c => c.code === code);

    // Helper: optimistically update ch, re-render panel.
    // The server can still refuse the change (a permission it doesn't grant,
    // or a rule like "enable voice first"), and it answers a refusal with
    // error-msg and no new channel state. Remember what the row held before
    // the click so _revertPendingChannelToggle can put it back; without that
    // the switch sat on its new value while the toast said it hadn't moved.
    const optimistic = (patch) => {
      if (ch) {
        const prev = {};
        for (const key of Object.keys(patch)) prev[key] = ch[key];
        this._cfnPendingToggle = { code, prev, at: Date.now() };
        Object.assign(ch, patch);
      }
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
    } else if (fn === 'soundboard') {
      const newVal = ch && ch.soundboard_enabled === 0 ? 1 : 0;
      optimistic({ soundboard_enabled: newVal });
      this.socket.emit('toggle-channel-permission', { code, permission: 'soundboard' });
    } else if (fn === 'reactions') {
      const newVal = ch && ch.reactions_enabled === 0 ? 1 : 0;
      optimistic({ reactions_enabled: newVal });
      if (code === this.currentChannel) this._applyReactionLock?.();
      this.socket.emit('toggle-channel-permission', { code, permission: 'reactions' });
    } else if (fn === 'read-only') {
      const newVal = ch && ch.read_only ? 0 : 1;
      optimistic({ read_only: newVal });
      this.socket.emit('toggle-channel-permission', { code, permission: 'read_only' });
    } else if (fn === 'forum') {
      const newVal = ch && ch.is_forum ? 0 : 1;
      optimistic({ is_forum: newVal });
      this.socket.emit('toggle-channel-permission', { code, permission: 'forum' });
      // The ordering rule just changed under the open channel; reload it so
      // the topics re-sort now instead of on the next visit.
      if (code === this.currentChannel) {
        setTimeout(() => this.socket.emit('get-messages', this._getMessagesParams ? this._getMessagesParams(code) : { code }), 400);
      }
    } else if (fn === 'private') {
      const newVal = ch && ch.is_private ? 0 : 1;
      optimistic({ is_private: newVal });
      this.socket.emit('toggle-channel-permission', { code, permission: 'private' });
    } else if (fn === 'nsfw') {
      const newVal = ch && ch.is_nsfw ? 0 : 1;
      optimistic({ is_nsfw: newVal });
      this.socket.emit('toggle-channel-permission', { code, permission: 'nsfw' });
    } else if (fn === 'forum-tags') {
      document.getElementById('channel-functions-panel').style.display = 'none';
      this._forumEditTags?.(code);
    } else if (fn === 'forum-blog') {
      // Blog mode (#5742). Everyone viewing the forum redraws when the
      // server confirms (app-forum-blog.js).
      const newVal = ch && Number(ch.forum_blog) === 1 ? 0 : 1;
      optimistic({ forum_blog: newVal });
      this.socket.emit('toggle-channel-permission', { code, permission: 'forum_blog' });
    } else if (fn === 'forum-votes') {
      document.getElementById('channel-functions-panel').style.display = 'none';
      this._forumVotesEdit?.(code);
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
    } else if (fn === 'welcome') {
      const newVal = ch && ch.show_welcome === 1 ? 0 : 1;
      optimistic({ show_welcome: newVal });
      this.socket.emit('toggle-welcome-channel', { code });
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
    } else if (fn === 'role-gate') {
      this._openRoleGateModal(code);
    } else if (fn === 'save-template') {
      this._saveChannelAsTemplate(code);
    } else if (fn === 'default-role') {
      // (#5389) Dropdown of available server roles. Selecting one fires
      // set-channel-default-role; selecting "None" clears the default.
      if (row.querySelector('.cfn-select')) return;
      const badge = row.querySelector('.cfn-badge');
      if (!badge) return;
      // Lazy-fetch roles if we haven't yet (e.g. admin opened the panel
      // before visiting the Roles page).
      const _open = () => {
        const roles = Array.isArray(this._allRoles) ? this._allRoles : [];
        const select = document.createElement('select');
        select.className = 'cfn-select cfn-input';
        select.onclick = e2 => e2.stopPropagation();
        const noneOpt = document.createElement('option');
        noneOpt.value = ''; noneOpt.textContent = t('channel_functions.none');
        select.appendChild(noneOpt);
        for (const r of roles) {
          const opt = document.createElement('option');
          opt.value = String(r.id);
          opt.textContent = r.name;
          if (ch && r.id === ch.default_role_id) opt.selected = true;
          select.appendChild(opt);
        }
        badge.replaceWith(select);
        select.focus();
        let committed = false;
        const commit = () => {
          if (committed) return;
          committed = true;
          const raw = select.value;
          const roleId = raw ? parseInt(raw, 10) : null;
          optimistic({ default_role_id: roleId });
          this.socket.emit('set-channel-default-role', { code, roleId });
        };
        select.addEventListener('change', () => { commit(); select.blur(); });
        select.addEventListener('blur', () => {
          if (!committed) this._updateChannelFunctionsPanel(ch);
        });
      };
      if (Array.isArray(this._allRoles) && this._allRoles.length) {
        _open();
      } else {
        this.socket.emit('get-roles', {}, (res) => {
          if (res && Array.isArray(res.roles)) this._allRoles = res.roles;
          _open();
        });
      }
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
        // Blank or less than 2 = unlimited (0). Valid range: 2 to 99.
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
      // #5390: self-destruct now has two modes: 'delete' (legacy: remove
      // the whole channel when the timer fires) and 'clear' (wipe messages
      // only, then rearm the timer at the same interval). We render the
      // hours input next to a mode select so admins can pick both at once.
      const wrap = document.createElement('span');
      wrap.className = 'cfn-input-wrap';
      const input = document.createElement('input');
      input.type = 'number'; input.min = '0'; input.max = '720';
      input.value = ''; input.placeholder = t('channel_functions.self_destruct_placeholder'); input.className = 'cfn-input cfn-input-hours';
      input.onclick = e2 => e2.stopPropagation();
      const modeSelect = document.createElement('select');
      modeSelect.className = 'cfn-input cfn-mode-select';
      const optDelete = document.createElement('option');
      optDelete.value = 'delete';
      optDelete.textContent = t('channel_functions.self_destruct_mode_delete');
      const optClear = document.createElement('option');
      optClear.value = 'clear';
      optClear.textContent = t('channel_functions.self_destruct_mode_clear');
      modeSelect.appendChild(optDelete);
      modeSelect.appendChild(optClear);
      modeSelect.value = ch?.auto_delete_mode === 'clear' ? 'clear' : 'delete';
      modeSelect.onclick = e2 => e2.stopPropagation();
      wrap.appendChild(input);
      wrap.appendChild(modeSelect);
      badge.replaceWith(wrap);
      input.focus(); input.select();
      let committed = false;
      // Leaving it empty (a misclick) or pressing Escape puts the setting back
      // as it was instead of leaving the editor open (#5702).
      const cancel = () => {
        if (committed) return;
        committed = true;
        this._updateChannelFunctionsPanel(ch);
      };
      const commitExpiry = () => {
        if (committed) return;
        const hours = parseInt(input.value);
        if (isNaN(hours) || hours < 0) return cancel();
        committed = true;
        const mode = modeSelect.value === 'clear' ? 'clear' : 'delete';
        if (hours === 0) {
          optimistic({ expires_at: null, auto_delete_mode: 'delete', auto_delete_interval_hours: null });
          this.socket.emit('set-channel-expiry', { code, hours: 0, mode });
        } else {
          const clamped = Math.max(1, Math.min(720, hours));
          const expiresAt = new Date(Date.now() + clamped * 3600000).toISOString();
          optimistic({ expires_at: expiresAt, auto_delete_mode: mode, auto_delete_interval_hours: clamped });
          this.socket.emit('set-channel-expiry', { code, hours: clamped, mode });
        }
      };
      // Delay blur-commit briefly so focus moving between input and select
      // inside the wrap doesn't fire a premature commit with stale values.
      const onBlur = () => {
        setTimeout(() => {
          if (!wrap.contains(document.activeElement)) commitExpiry();
        }, 50);
      };
      input.addEventListener('keydown', e2 => {
        if (e2.key === 'Enter') { commitExpiry(); input.blur(); }
        else if (e2.key === 'Escape') { e2.preventDefault(); cancel(); }
      });
      modeSelect.addEventListener('keydown', e2 => { if (e2.key === 'Escape') { e2.preventDefault(); cancel(); } });
      input.addEventListener('blur', onBlur);
      modeSelect.addEventListener('blur', onBlur);
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
      noneOpt.value = ''; noneOpt.textContent = t('channel_functions.none_disabled');
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
      input.value = current > 0 ? current : ''; input.placeholder = t('channel_functions.afk_timeout_placeholder'); input.className = 'cfn-input';
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
        // Use server default: remove any personal override
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
},

_canShareChannelLink(code) {
  if (!code) return false;
  const ch = (this.channels || []).find(c => c.code === code);
  if (!ch) return false;
  if (ch.is_dm) return false;
  return !(ch.is_private || ch.code_visibility === 'private');
},

/** Copy a Haven-style deep link to a channel (and optionally a message) to the clipboard. */
_copyChannelLink(code, messageId = null) {
  if (!code) return;
  if (!this._canShareChannelLink(code)) {
    this._showToast?.(t('toasts.channel_link_unavailable'), 'error');
    return;
  }
  const base = `${this._shareOrigin()}/app.html?channel=${encodeURIComponent(code)}`;
  const url = messageId ? `${base}&message=${encodeURIComponent(messageId)}` : base;
  const onCopied = () => {
    const key = messageId ? 'toasts.message_link_copied' : 'toasts.channel_link_copied';
    this._showToast(t(key), 'success');
  };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(url).then(onCopied).catch(() => this._copyTextFallback(url, onCopied));
  } else {
    this._copyTextFallback(url, onCopied);
  }
},

};
