// Importing Discord history: from a DiscordChatExporter file, or straight
// from a server through the Ferry bot.

export default {

// ═══════════════════════════════════════════════════════
// DISCORD IMPORT
// ═══════════════════════════════════════════════════════

_setupDiscordImport() {
  const modal      = document.getElementById('import-modal');
  const stepUpload = document.getElementById('import-step-upload');
  const stepPreview= document.getElementById('import-step-preview');
  const stepDone   = document.getElementById('import-step-done');
  const dropzone   = document.getElementById('import-dropzone');
  const fileInput  = document.getElementById('import-file-input');
  const browseLink = document.getElementById('import-browse-link');
  const progressWrap = document.getElementById('import-upload-progress');
  const progressFill = document.getElementById('import-progress-fill');
  const statusText   = document.getElementById('import-upload-status');
  const channelList  = document.getElementById('import-channel-list');
  const executeBtn   = document.getElementById('import-execute-btn');
  const backBtn      = document.getElementById('import-back-btn');
  if (!modal) return;

  let currentImportId = null;
  let currentPreview  = null;

  const resetModal = () => {
    stepUpload.style.display  = '';
    stepPreview.style.display = 'none';
    stepDone.style.display    = 'none';
    progressWrap.style.display = 'none';
    progressFill.style.width  = '0%';
    statusText.textContent    = t('settings.admin.import_uploading');
    dropzone.style.display    = '';
    fileInput.value           = '';
    channelList.innerHTML     = '';
    currentImportId           = null;
    currentPreview            = null;
    // Reset connect tab state
    const cs1 = document.getElementById('import-connect-step-token');
    const cs2 = document.getElementById('import-connect-step-servers');
    const cs3 = document.getElementById('import-connect-step-channels');
    if (cs1) cs1.style.display = '';
    if (cs2) cs2.style.display = 'none';
    if (cs3) cs3.style.display = 'none';
    const riskAck = document.getElementById('import-token-risk-ack');
    if (riskAck) riskAck.checked = false;
    const gated = document.getElementById('import-connect-gated');
    if (gated) gated.style.display = 'none';
    const tokenField = document.getElementById('import-discord-token');
    if (tokenField) tokenField.value = '';
    const personal = document.querySelector('.import-personal-login');
    if (personal) personal.open = false;
    this._importAuth = null;
    this._renderImportFerry();
    // Fresh Ferry state, so the Connect tab knows whether the bot is set up.
    this.socket?.emit('ferry:get-config');
    const cStatus = document.getElementById('import-connect-status');
    if (cStatus) { cStatus.style.display = 'none'; cStatus.textContent = ''; }
    const fStatus = document.getElementById('import-fetch-status');
    if (fStatus) { fStatus.style.display = 'none'; fStatus.textContent = ''; }
    // Reset to file tab
    document.querySelectorAll('.import-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === 'file'));
    const fileTab = document.getElementById('import-tab-file');
    const connectTab = document.getElementById('import-tab-connect');
    if (fileTab) fileTab.style.display = '';
    if (connectTab) connectTab.style.display = 'none';
  };

  // Open import modal
  document.getElementById('open-import-btn')?.addEventListener('click', () => {
    resetModal();
    modal.style.display = 'flex';
  });

  // Close
  document.getElementById('close-import-btn')?.addEventListener('click', () => {
    modal.style.display = 'none';
  });
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.style.display = 'none';
  });

  // Browse link
  browseLink?.addEventListener('click', (e) => {
    e.preventDefault();
    fileInput.click();
  });

  // File input change
  fileInput?.addEventListener('change', () => {
    if (fileInput.files.length) this._importUploadFile(fileInput.files[0]);
  });

  // Drag & drop
  dropzone?.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('drag-over');
  });
  dropzone?.addEventListener('dragleave', () => {
    dropzone.classList.remove('drag-over');
  });
  dropzone?.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('drag-over');
    const file = e.dataTransfer?.files?.[0];
    if (file) this._importUploadFile(file);
  });

  // Back button
  backBtn?.addEventListener('click', () => {
    resetModal();
  });

  // Select all / Deselect all toggle
  const toggleAllLink = document.getElementById('import-toggle-all');
  toggleAllLink?.addEventListener('click', (e) => {
    e.preventDefault();
    const boxes = channelList.querySelectorAll('input[type="checkbox"]');
    const allChecked = [...boxes].every(cb => cb.checked);
    boxes.forEach(cb => cb.checked = !allChecked);
    toggleAllLink.textContent = allChecked ? t('settings.admin.select_all') : t('settings.admin.deselect_all');
  });

  // Execute button
  executeBtn?.addEventListener('click', async () => {
    if (!currentImportId || !currentPreview) return;
    const selected = [];
    channelList.querySelectorAll('.import-channel-row').forEach(row => {
      const cb = row.querySelector('input[type="checkbox"]');
      if (!cb?.checked) return;
      const nameInput = row.querySelector('input[type="text"]');
      selected.push({
        discordId: row.dataset.discordId,
        originalName: row.dataset.originalName,
        name: nameInput?.value?.trim() || row.dataset.originalName
      });
    });
    if (selected.length === 0) {
      this._alert(t('settings.admin.import_select_channel'));
      return;
    }
    const totalMsgs = currentPreview.channels
      .filter(c => selected.some(s => (s.discordId && s.discordId === c.discordId) || s.originalName === c.name))
      .reduce((sum, c) => sum + c.messageCount, 0);
    if (!await this._confirm(t(selected.length === 1 ? 'settings.admin.import_confirm_one' : 'settings.admin.import_confirm_other', { count: selected.length, messages: totalMsgs.toLocaleString() }))) return;
    this._importExecute(currentImportId, selected);
  });

  // ── Tab switching ────────────────────────────────────
  document.querySelectorAll('.import-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.import-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const target = tab.dataset.tab;
      const fileTab = document.getElementById('import-tab-file');
      const connectTab = document.getElementById('import-tab-connect');
      if (fileTab) fileTab.style.display = target === 'file' ? '' : 'none';
      if (connectTab) connectTab.style.display = target === 'connect' ? '' : 'none';
    });
  });

  // ── Connect to Discord flow ──────────────────────────
  const connectBtn = document.getElementById('import-connect-btn');
  const connectStatus = document.getElementById('import-connect-status');

  // The personal-token path stays hidden until the admin ticks the box under
  // the warning: it breaks Discord's rules and a leaked token is a stolen account.
  document.getElementById('import-token-risk-ack')?.addEventListener('change', (e) => {
    document.getElementById('import-connect-gated').style.display = e.target.checked ? '' : 'none';
    if (!e.target.checked) document.getElementById('import-discord-token').value = '';
  });

  // auth is { useFerry: true } (the Ferry bot, whose token stays on the
  // server) or { discordToken } (the personal login behind the warning).
  // Every later step sends the same auth.
  const connectWith = async (auth, btn, btnLabel) => {
    btn.disabled = true;
    btn.textContent = '⏳';
    connectStatus.style.display = '';
    connectStatus.textContent = t('settings.admin.import_connecting');
    connectStatus.style.color = '';

    try {
      const res = await fetch('/api/import/discord/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + this.token },
        body: JSON.stringify(auth)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t('settings.admin.import_connection_failed'));
      this._importAuth = auth;
      connectStatus.style.display = 'none';

      // Show server list
      document.getElementById('import-connect-step-token').style.display = 'none';
      const serversStep = document.getElementById('import-connect-step-servers');
      serversStep.style.display = '';
      document.getElementById('import-discord-username').textContent = data.user.username;

      const serverList = document.getElementById('import-server-list');
      serverList.innerHTML = '';
      data.guilds.forEach(g => {
        const card = document.createElement('button');
        card.className = 'import-server-card';
        const iconUrl = g.icon
          ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png?size=64`
          : '';
        card.innerHTML = `
          ${iconUrl ? `<img ${this._imgSrcAttr(iconUrl)} alt="" class="import-server-icon">` : '<span class="import-server-icon-placeholder">🏠</span>'}
          <span class="import-server-name">${this._escapeHtml(g.name)}</span>
        `;
        card.addEventListener('click', () => this._importPickGuild(g));
        serverList.appendChild(card);
      });
    } catch (err) {
      connectStatus.textContent = '❌ ' + err.message;
      connectStatus.style.color = '#ed4245';
    } finally {
      btn.disabled = false;
      btn.textContent = btnLabel;
    }
  };

  const ferryConnectBtn = document.getElementById('import-ferry-connect-btn');
  ferryConnectBtn?.addEventListener('click', () => {
    connectWith({ useFerry: true }, ferryConnectBtn, t('modals.discord_import.ferry_btn'));
  });

  document.getElementById('import-open-ferry')?.addEventListener('click', (e) => {
    e.preventDefault();
    modal.style.display = 'none';
    this._openFerryModal();
  });

  connectBtn?.addEventListener('click', () => {
    if (!document.getElementById('import-token-risk-ack')?.checked) return;
    const discordToken = document.getElementById('import-discord-token')?.value?.trim();
    if (!discordToken) { this._showToast(t('settings.admin.import_paste_token'), 'error'); return; }
    connectWith({ discordToken }, connectBtn, t('settings.admin.import_connect_btn'));
  });

  // Disconnect
  document.getElementById('import-connect-disconnect')?.addEventListener('click', (e) => {
    e.preventDefault();
    document.getElementById('import-connect-step-servers').style.display = 'none';
    document.getElementById('import-connect-step-token').style.display = '';
    document.getElementById('import-discord-token').value = '';
    this._importAuth = null;
  });

  // Back to servers from channels
  document.getElementById('import-connect-back-servers')?.addEventListener('click', (e) => {
    e.preventDefault();
    document.getElementById('import-connect-step-channels').style.display = 'none';
    document.getElementById('import-connect-step-servers').style.display = '';
  });

  // Toggle all channels in connect flow
  const connectToggleAll = document.getElementById('import-connect-toggle-all');
  connectToggleAll?.addEventListener('click', (e) => {
    e.preventDefault();
    const cList = document.getElementById('import-connect-channel-list');
    const boxes = cList.querySelectorAll('input[type="checkbox"]:not(:disabled)');
    const allChecked = [...boxes].every(cb => cb.checked);
    boxes.forEach(cb => cb.checked = !allChecked);
    connectToggleAll.textContent = allChecked ? t('settings.admin.select_all') : t('settings.admin.deselect_all');
  });

  // Fetch messages button
  document.getElementById('import-fetch-btn')?.addEventListener('click', () => {
    this._importConnectFetch();
  });

  // Expose state setters for the upload/execute helpers
  this._importSetState = (importId, preview) => {
    currentImportId = importId;
    currentPreview  = preview;
  };
},

async _importUploadFile(file) {
  const modal        = document.getElementById('import-modal');
  const dropzone     = document.getElementById('import-dropzone');
  const progressWrap = document.getElementById('import-upload-progress');
  const progressFill = document.getElementById('import-progress-fill');
  const statusText   = document.getElementById('import-upload-status');
  const stepUpload   = document.getElementById('import-step-upload');
  const stepPreview  = document.getElementById('import-step-preview');
  const channelList  = document.getElementById('import-channel-list');

  // Validate extension
  const ext = file.name.split('.').pop().toLowerCase();
  if (!['json', 'zip'].includes(ext)) {
    this._alert(t('settings.admin.import_file_type_error'));
    return;
  }

  // Show progress
  dropzone.style.display     = 'none';
  progressWrap.style.display = '';
  progressFill.style.width   = '0%';
  statusText.textContent     = t('settings.admin.import_uploading_file', { name: file.name });

  try {
    const formData = new FormData();
    formData.append('file', file);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/import/discord/upload');
    xhr.setRequestHeader('Authorization', 'Bearer ' + this.token);

    // Progress tracking
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) {
        const pct = Math.round((e.loaded / e.total) * 100);
        progressFill.style.width = pct + '%';
        statusText.textContent = t('settings.admin.import_uploading_pct', { pct });
      }
    });

    const result = await new Promise((resolve, reject) => {
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(JSON.parse(xhr.responseText));
        } else {
          try {
            const err = JSON.parse(xhr.responseText);
            reject(new Error(err.error || t('settings.admin.import_upload_failed')));
          } catch {
            reject(new Error(t('settings.admin.import_upload_failed_status', { status: xhr.status })));
          }
        }
      };
      xhr.onerror = () => reject(new Error(t('settings.admin.import_network_error')));
      xhr.send(formData);
    });

    // Switch to parsing
    progressFill.style.width = '100%';
    statusText.textContent = t('settings.admin.import_parsing');
    await new Promise(r => setTimeout(r, 300));

    // Show preview
    this._importSetState(result.importId, result);
    stepUpload.style.display  = 'none';
    stepPreview.style.display = '';

    // Format badge
    const badge = document.getElementById('import-format-badge');
    badge.textContent = result.format;
    badge.classList.toggle('official', result.format === 'Discord Data Package');

    document.getElementById('import-server-name').textContent = result.serverName;
    document.getElementById('import-total-msgs').textContent = t('settings.admin.import_total_messages', { count: result.totalMessages.toLocaleString() });

    // Build channel list
    channelList.innerHTML = '';
    result.channels.forEach(ch => {
      const row = document.createElement('div');
      row.className = 'import-channel-row';
      row.dataset.discordId = ch.discordId || '';
      row.dataset.originalName = ch.name;
      row.innerHTML = `
        <label>
          <input type="checkbox" checked>
          <span class="import-ch-name">
            <input type="text" value="${this._escapeHtml(ch.name)}" title="${t('settings.admin.import_rename_channel')}">
          </span>
        </label>
        <span class="import-ch-count">${t('settings.admin.import_messages_short', { count: ch.messageCount.toLocaleString() })}</span>
      `;
      channelList.appendChild(row);
    });

  } catch (err) {
    statusText.textContent = '❌ ' + err.message;
    progressFill.style.width = '100%';
    progressFill.style.background = '#ed4245';
    setTimeout(() => {
      dropzone.style.display     = '';
      progressWrap.style.display = 'none';
      progressFill.style.background = '';
    }, 3000);
  }
},

// ── Discord Direct Connect helpers ────────────────────

/** The Ferry option on the Connect tab: the button, or how to set Ferry up. */
_renderImportFerry() {
  const btn = document.getElementById('import-ferry-connect-btn');
  const missing = document.getElementById('import-ferry-missing');
  if (!btn || !missing) return;
  // Until the state arrives, offer the button; the server says if Ferry is missing.
  const state = this._ferryConfig?.state;
  const noBot = !!state && !state.hasToken;
  btn.style.display = noBot ? 'none' : '';
  missing.style.display = noBot ? '' : 'none';
},

async _importPickGuild(guild) {
  const serversStep = document.getElementById('import-connect-step-servers');
  const channelsStep = document.getElementById('import-connect-step-channels');
  const fetchStatus = document.getElementById('import-fetch-status');

  document.getElementById('import-connect-guild-name').textContent = guild.name;
  serversStep.style.display = 'none';
  channelsStep.style.display = '';
  fetchStatus.style.display = '';
  fetchStatus.textContent = t('settings.admin.import_loading_channels');
  fetchStatus.style.color = '';

  try {
    const res = await fetch('/api/import/discord/guild-channels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + this.token },
      body: JSON.stringify({ ...this._importAuth, guildId: guild.id })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || t('settings.admin.import_load_channels_failed'));

    const cList = document.getElementById('import-connect-channel-list');
    cList.innerHTML = '';
    let lastCategory = null;

    // Type icons for visual distinction
    const typeIcons = { text: '#', announcement: '📢', forum: '💬', media: '🖼️', thread: '🧵' };
    // A channel the Ferry bot can't read (a private channel its role was never
    // added to) is greyed out and can't be ticked, with what to do about it.
    let hiddenCount = 0;
    const blockedParts = (entry) => {
      if (entry.readable !== false) return { cls: '', box: 'checked', lock: '', hint: '' };
      hiddenCount++;
      return {
        cls: ' import-channel-blocked',
        box: 'disabled',
        lock: ' <span class="import-ch-lock" aria-hidden="true">🔒</span>',
        hint: `<div class="import-ch-blocked-hint">${this._escapeHtml(t('modals.discord_import.channel_hidden'))}</div>`,
      };
    };

    // Render channels grouped by category
    data.channels.forEach(ch => {
      if (ch.category && ch.category !== lastCategory) {
        const catDiv = document.createElement('div');
        catDiv.className = 'import-channel-category';
        catDiv.textContent = ch.category;
        cList.appendChild(catDiv);
        lastCategory = ch.category;
      }
      const icon = typeIcons[ch.type] || '#';
      const tagHint = ch.tags && ch.tags.length
        ? ` <span class="muted-text" style="font-size:0.625rem">(${this._escapeHtml(ch.tags.map(tg => tg.name).join(', '))})</span>`
        : '';
      const blocked = blockedParts(ch);
      const row = document.createElement('div');
      row.className = 'import-channel-row' + blocked.cls;
      row.dataset.channelId = ch.id;
      row.dataset.channelName = ch.name;
      row.dataset.channelTopic = ch.topic || '';
      row.dataset.channelCategory = ch.category || '';
      row.dataset.kind = ch.type || 'text';
      row.dataset.tags = JSON.stringify((ch.tags || []).map(tg => tg.name));
      row.innerHTML = `
        <label>
          <input type="checkbox" ${blocked.box}>
          <span class="import-ch-name"><span class="import-channel-type-icon" aria-hidden="true">${icon}</span> ${this._escapeHtml(ch.name)}${tagHint}${blocked.lock}</span>
        </label>
        <span class="import-ch-count import-type-badge">${ch.type}</span>
        ${blocked.hint}
      `;
      cList.appendChild(row);

      // Render threads nested under this channel
      if (data.threads) {
        const childThreads = data.threads.filter(t => t.parentId === ch.id);
        childThreads.forEach(t => {
          const tagStr = t.tags && t.tags.length
            ? ` <span class="muted-text" style="font-size:0.625rem">[${this._escapeHtml(t.tags.join(', '))}]</span>`
            : '';
          const tBlocked = blockedParts(t);
          const tRow = document.createElement('div');
          tRow.className = 'import-channel-row import-thread-row' + tBlocked.cls;
          tRow.dataset.channelId = t.id;
          tRow.dataset.channelName = t.name;
          tRow.dataset.channelTopic = '';
          tRow.dataset.channelCategory = ch.category || '';
          tRow.dataset.kind = 'thread';
          tRow.dataset.parentId = t.parentId || '';
          tRow.dataset.tags = JSON.stringify(t.tags || []);
          tRow.innerHTML = `
            <label>
              <input type="checkbox" ${tBlocked.box}>
              <span class="import-ch-name"><span class="import-channel-type-icon" aria-hidden="true">🧵</span> ${this._escapeHtml(t.name)}${tagStr}${tBlocked.lock}</span>
            </label>
            <span class="import-ch-count import-type-badge">${window.t('settings.admin.import_thread')}</span>
            ${tBlocked.hint}
          `;
          cList.appendChild(tRow);
        });
      }
    });

    // Render orphan threads (parent not in the list)
    if (data.threads) {
      const renderedParents = new Set(data.channels.map(c => c.id));
      const orphans = data.threads.filter(t => !renderedParents.has(t.parentId));
      if (orphans.length > 0) {
        const catDiv = document.createElement('div');
        catDiv.className = 'import-channel-category';
        catDiv.textContent = t('settings.admin.import_other_threads');
        cList.appendChild(catDiv);
        orphans.forEach(t => {
          const tBlocked = blockedParts(t);
          const tRow = document.createElement('div');
          tRow.className = 'import-channel-row import-thread-row' + tBlocked.cls;
          tRow.dataset.channelId = t.id;
          tRow.dataset.channelName = t.name;
          tRow.dataset.channelTopic = '';
          tRow.dataset.channelCategory = t.category || '';
          tRow.dataset.kind = 'thread';
          tRow.dataset.parentId = t.parentId || '';
          tRow.dataset.tags = JSON.stringify(t.tags || []);
          tRow.innerHTML = `
            <label>
              <input type="checkbox" ${tBlocked.box}>
              <span class="import-ch-name"><span class="import-channel-type-icon" aria-hidden="true">🧵</span> ${this._escapeHtml(t.name)}${t.parentName ? ` <span class="muted-text" style="font-size:0.625rem">${window.t('settings.admin.import_in_channel', { name: this._escapeHtml(t.parentName) })}</span>` : ''}${tBlocked.lock}</span>
            </label>
            <span class="import-ch-count import-type-badge">${window.t('settings.admin.import_thread')}</span>
            ${tBlocked.hint}
          `;
          cList.appendChild(tRow);
        });
      }
    }

    this._connectGuild = guild;
    if (hiddenCount) {
      fetchStatus.textContent = '🔒 ' + t(hiddenCount === 1 ? 'modals.discord_import.channels_hidden_one' : 'modals.discord_import.channels_hidden_other', { count: hiddenCount });
    } else {
      fetchStatus.style.display = 'none';
    }
  } catch (err) {
    fetchStatus.textContent = '❌ ' + err.message;
    fetchStatus.style.color = '#ed4245';
  }
},

async _importConnectFetch() {
  const cList = document.getElementById('import-connect-channel-list');
  const fetchBtn = document.getElementById('import-fetch-btn');
  const fetchStatus = document.getElementById('import-fetch-status');
  const stepUpload = document.getElementById('import-step-upload');
  const stepPreview = document.getElementById('import-step-preview');
  const channelList = document.getElementById('import-channel-list');

  // Build selected channel list
  const selected = [];
  cList.querySelectorAll('.import-channel-row').forEach(row => {
    const cb = row.querySelector('input[type="checkbox"]');
    if (!cb?.checked) return;
    let tags = [];
    try { tags = JSON.parse(row.dataset.tags || '[]'); } catch { tags = []; } // a row without tags
    selected.push({
      id: row.dataset.channelId,
      name: row.dataset.channelName,
      topic: row.dataset.channelTopic,
      category: row.dataset.channelCategory,
      // A thread lands in its parent channel, and a forum's posts become
      // topics, when the parent comes along too (#5772).
      kind: row.dataset.kind || 'text',
      parentId: row.dataset.parentId || undefined,
      tags,
    });
  });
  if (!selected.length) { this._showToast(t('settings.admin.select_channel_warning'), 'error'); return; }

  fetchBtn.disabled = true;
  fetchBtn.textContent = `⏳ ${t('settings.admin.import_fetching')}`;
  fetchStatus.style.display = '';
  fetchStatus.textContent = t(selected.length === 1 ? 'settings.admin.import_fetching_one' : 'settings.admin.import_fetching_other', { count: selected.length });
  fetchStatus.style.color = '';

  try {
    const res = await fetch('/api/import/discord/fetch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + this.token },
      body: JSON.stringify({
        ...this._importAuth,
        guildName: this._connectGuild?.name || 'Discord Import',
        // Lets the server skip, by name, anything the Ferry bot can't read.
        guildId: this._connectGuild?.id,
        channels: selected
      })
    });
    const started = await this._importReadJson(res);
    if (!res.ok) throw new Error(started.error || t('settings.admin.import_fetch_failed'));
    // The server reads in the background; ask how it is going until it is done.
    let result = started;
    while (started.jobId) {
      await new Promise(r => setTimeout(r, 2000));
      const poll = await fetch('/api/import/discord/fetch/' + encodeURIComponent(started.jobId), { headers: { 'Authorization': 'Bearer ' + this.token } });
      const data = await this._importReadJson(poll);
      if (!poll.ok) throw new Error(data.error || t('settings.admin.import_fetch_failed'));
      if (data.state === 'running') {
        fetchStatus.textContent = t('settings.admin.import_fetch_progress', { messages: data.messages.toLocaleString(), done: data.channelsDone, total: data.channelsTotal });
        continue;
      }
      result = data;
      break;
    }
    if (result.skipped?.length) {
      const skippedKey = this._importAuth?.useFerry ? 'modals.discord_import.skipped_channels_ferry' : 'modals.discord_import.skipped_channels';
      this._showToast(t(skippedKey, { names: result.skipped.join(', ') }), 'error');
    }

    // Transition to the standard preview step (reuses existing execute flow)
    this._importSetState(result.importId, result);
    stepUpload.style.display = 'none';
    stepPreview.style.display = '';

    const badge = document.getElementById('import-format-badge');
    badge.textContent = result.format;
    badge.classList.remove('official');

    document.getElementById('import-server-name').textContent = result.serverName;
    document.getElementById('import-total-msgs').textContent = t('settings.admin.import_total_messages', { count: result.totalMessages.toLocaleString() });

    channelList.innerHTML = '';
    result.channels.forEach(ch => {
      const row = document.createElement('div');
      row.className = 'import-channel-row';
      row.dataset.discordId = ch.discordId || '';
      row.dataset.originalName = ch.name;
      row.innerHTML = `
        <label>
          <input type="checkbox" checked>
          <span class="import-ch-name">
            <input type="text" value="${this._escapeHtml(ch.name)}" title="${t('settings.admin.import_rename_channel')}">
          </span>
        </label>
        <span class="import-ch-count">${t('settings.admin.import_messages_short', { count: ch.messageCount.toLocaleString() })}</span>
      `;
      channelList.appendChild(row);
    });
  } catch (err) {
    fetchStatus.textContent = '❌ ' + err.message;
    fetchStatus.style.color = '#ed4245';
  } finally {
    fetchBtn.disabled = false;
    fetchBtn.textContent = `📥 ${t('settings.admin.import_fetch_btn')}`;
  }
},

// A proxy or tunnel in front of Haven can answer with its own HTML error page
// (a timeout, say) instead of Haven's JSON. Say so instead of showing a
// JSON parse error.
async _importReadJson(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(t('settings.admin.import_bad_response', { status: res.status }));
  }
},

async _importExecute(importId, selectedChannels) {
  const executeBtn = document.getElementById('import-execute-btn');
  const stepPreview = document.getElementById('import-step-preview');
  const stepDone    = document.getElementById('import-step-done');
  const doneMsg     = document.getElementById('import-done-msg');

  executeBtn.disabled = true;
  executeBtn.textContent = `⏳ ${t('settings.admin.import_importing')}`;

  try {
    const res = await fetch('/api/import/discord/execute', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + this.token
      },
      body: JSON.stringify({ importId, selectedChannels, copyFiles: document.getElementById('import-copy-files')?.checked !== false })
    });
    const started = await this._importReadJson(res);
    if (!res.ok) throw new Error(started.error || t('settings.admin.import_failed'));
    // The server writes in the background; ask how it is going until it is done.
    let data = started;
    while (started.jobId) {
      await new Promise(r => setTimeout(r, 1500));
      const poll = await fetch('/api/import/discord/execute/' + encodeURIComponent(started.jobId), { headers: { 'Authorization': 'Bearer ' + this.token } });
      const status = await this._importReadJson(poll);
      if (!poll.ok) {
        let msg = status.error || t('settings.admin.import_failed');
        if (status.messagesImported > 0) msg += ' ' + t('settings.admin.import_write_partial', { count: status.messagesImported.toLocaleString() });
        throw new Error(msg);
      }
      if (status.state === 'running') {
        executeBtn.textContent = '⏳ ' + (status.messagesTotal > 0
          ? t('settings.admin.import_write_progress', { done: status.messagesDone.toLocaleString(), total: status.messagesTotal.toLocaleString() })
          : t('settings.admin.import_importing'))
          + (status.filesCopied > 0 ? ' · ' + t('settings.admin.import_files_progress', { count: status.filesCopied.toLocaleString() }) : '');
        continue;
      }
      data = status;
      break;
    }

    // Show done step
    stepPreview.style.display = 'none';
    stepDone.style.display    = '';
    doneMsg.textContent = t(data.channelsCreated === 1 ? 'settings.admin.import_success_one' : 'settings.admin.import_success_other', { count: data.channelsCreated, messages: data.messagesImported.toLocaleString() });
    if (data.channelsReused > 0) {
      doneMsg.textContent += ' ' + t('settings.admin.import_reused', { count: data.channelsReused });
    }
    if (data.messagesSkipped > 0) {
      doneMsg.textContent += ' ' + t('settings.admin.import_skipped', { count: data.messagesSkipped.toLocaleString() });
    }
    // Pictures and files copied into Haven (#5811), and the ones that stayed links.
    if (data.filesCopied > 0) doneMsg.textContent += ' ' + t('settings.admin.import_files_copied', { count: data.filesCopied.toLocaleString() });
    if (data.filesLeftAsLinks > 0) doneMsg.textContent += ' ' + t('settings.admin.import_files_links', { count: data.filesLeftAsLinks.toLocaleString() });
    if (data.diskFull) doneMsg.textContent += ' ' + t('settings.admin.import_files_disk');

    // Refresh channel list
    if (this.socket) this.socket.emit('get-channels');
  } catch (err) {
    this._alert(t('settings.admin.import_failed_alert', { error: err.message }));
  } finally {
    executeBtn.disabled = false;
    executeBtn.textContent = `📦 ${t('settings.admin.import_btn')}`;
  }
},

};
