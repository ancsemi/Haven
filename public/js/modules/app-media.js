export default {

// ── Image Queue (paste/drop → preview → send on Enter) ──

_queueImage(file) {
  if (!file || !file.type.startsWith('image/')) return;
  const _maxMb = parseInt(this.serverSettings?.max_upload_mb) || 25;
  if (file.size > _maxMb * 1024 * 1024) {
    return this._showToast(`Image too large (max ${_maxMb} MB)`, 'error');
  }
  if (!this._imageQueue) this._imageQueue = [];
  if (this._imageQueue.length >= 5) {
    return this._showToast('Max 5 images at once', 'error');
  }
  this._imageQueue.push(file);
  this._renderImageQueue();
  document.getElementById('message-input').focus();
},

_renderImageQueue() {
  const bar = document.getElementById('image-queue-bar');
  if (!bar) return;
  if (!this._imageQueue || this._imageQueue.length === 0) {
    bar.style.display = 'none';
    bar.innerHTML = '';
    return;
  }
  bar.style.display = 'flex';
  bar.innerHTML = '';
  this._imageQueue.forEach((file, idx) => {
    const thumb = document.createElement('div');
    thumb.className = 'image-queue-thumb';
    const img = document.createElement('img');
    img.src = URL.createObjectURL(file);
    img.alt = file.name;
    img.onload = () => URL.revokeObjectURL(img.src);
    const removeBtn = document.createElement('button');
    removeBtn.className = 'image-queue-remove';
    removeBtn.title = 'Remove';
    removeBtn.textContent = '×';
    removeBtn.addEventListener('click', () => {
      this._imageQueue.splice(idx, 1);
      this._renderImageQueue();
    });
    thumb.appendChild(img);
    thumb.appendChild(removeBtn);
    bar.appendChild(thumb);
  });
  // Add a "clear all" button if multiple
  if (this._imageQueue.length > 1) {
    const clearAll = document.createElement('button');
    clearAll.className = 'image-queue-clear-all';
    clearAll.textContent = 'Clear All';
    clearAll.addEventListener('click', () => this._clearImageQueue());
    bar.appendChild(clearAll);
  }
},

_clearImageQueue() {
  this._imageQueue = [];
  this._renderImageQueue();
},

async _flushImageQueue() {
  if (!this._imageQueue || this._imageQueue.length === 0) return;
  const files = [...this._imageQueue];
  this._clearImageQueue();
  for (const file of files) {
    await this._uploadImage(file);
  }
},

// ═══════════════════════════════════════════════════════
// AVATAR / PFP CUSTOMIZER
// ═══════════════════════════════════════════════════════

_updateAvatarPreview() {
  const preview = document.getElementById('avatar-upload-preview');
  if (!preview) return;
  if (this.user.avatar) {
    preview.innerHTML = `<img src="${this._escapeHtml(this.user.avatar)}" alt="avatar">`;
  } else {
    const color = this._getUserColor(this.user.username);
    const initial = this.user.username.charAt(0).toUpperCase();
    preview.innerHTML = `<div style="background-color:${color};width:100%;height:100%;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:18px;color:white">${initial}</div>`;
  }
},

_setupAvatarUpload() {
  console.log('[Avatar Setup v6] Initializing with HTTP upload model...');
  if (this._avatarDelegationActive) return;
  this._avatarDelegationActive = true;

  // Pending state — nothing is saved until the user clicks Save
  this._pendingAvatarFile = null;       // raw File object from <input>
  this._pendingAvatarPreviewUrl = null; // local preview data URL (display only)
  this._pendingAvatarRemoved = false;   // user clicked Clear
  this._pendingAvatarShape = this.user.avatarShape || localStorage.getItem('haven_avatar_shape') || 'circle';
  this._avatarShape = this._pendingAvatarShape;

  // Initialize preview + shape buttons
  this._updateAvatarPreview();
  const picker = document.getElementById('avatar-shape-picker');
  if (picker) {
    picker.querySelectorAll('.avatar-shape-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.shape === this._pendingAvatarShape);
    });
  }

  // ── Delegated click handler ──
  document.addEventListener('click', (e) => {
    // Shape buttons
    const shapeBtn = e.target.closest('.avatar-shape-btn');
    if (shapeBtn) {
      e.preventDefault();
      const container = document.getElementById('avatar-shape-picker');
      if (container) container.querySelectorAll('.avatar-shape-btn').forEach(b => b.classList.remove('active'));
      shapeBtn.classList.add('active');
      this._pendingAvatarShape = shapeBtn.dataset.shape;
      this._markAvatarUnsaved();
      return;
    }

    // Upload button → trigger file picker
    if (e.target.closest('#avatar-upload-btn')) {
      e.preventDefault();
      e.stopPropagation();
      const fileInput = document.getElementById('avatar-file-input');
      if (fileInput) { fileInput.value = ''; fileInput.click(); }
      return;
    }

    // Clear/Remove button
    if (e.target.closest('#avatar-remove-btn')) {
      e.preventDefault();
      this._pendingAvatarFile = null;
      this._pendingAvatarPreviewUrl = null;
      this._pendingAvatarRemoved = true;
      const preview = document.getElementById('avatar-upload-preview');
      if (preview) {
        const color = this._getUserColor(this.user.username);
        const initial = this.user.username.charAt(0).toUpperCase();
        preview.innerHTML = `<div style="background-color:${color};width:100%;height:100%;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:18px;color:white">${initial}</div>`;
      }
      this._markAvatarUnsaved();
      return;
    }

    // Save button
    if (e.target.closest('#avatar-save-btn')) {
      e.preventDefault();
      this._commitAvatarSettings();
      return;
    }
  });

  // File input change → stage the file, show local preview
  document.addEventListener('change', (e) => {
    if (e.target && e.target.id === 'avatar-file-input') {
      const file = e.target.files[0];
      if (!file) return;
      if (file.size > 5 * 1024 * 1024) return this._showToast('Image too large (max 5 MB)', 'error');
      if (!file.type.startsWith('image/')) return this._showToast('Not an image file', 'error');

      this._pendingAvatarFile = file;
      this._pendingAvatarRemoved = false;

      // Show local preview immediately (not sent to server yet)
      const reader = new FileReader();
      reader.onload = (ev) => {
        this._pendingAvatarPreviewUrl = ev.target.result;
        const preview = document.getElementById('avatar-upload-preview');
        if (preview) {
          const img = document.createElement('img');
          img.src = ev.target.result;
          img.alt = 'avatar preview';
          preview.innerHTML = '';
          preview.appendChild(img);
        }
        this._markAvatarUnsaved();
      };
      reader.readAsDataURL(file);
    }
  });

  console.log('[Avatar Setup v6] Ready.');
},

_markAvatarUnsaved() {
  const status = document.getElementById('avatar-save-status');
  if (status) { status.textContent = 'Unsaved changes'; status.style.color = 'var(--warning, orange)'; }
},

// Commit pending avatar + shape to the server via HTTP (not socket!)
async _commitAvatarSettings() {
  const status = document.getElementById('avatar-save-status');
  if (status) { status.textContent = 'Saving...'; status.style.color = 'var(--text-secondary)'; }

  try {
    // 1. Upload avatar image via HTTP if a new file was chosen
    if (this._pendingAvatarFile) {
      const formData = new FormData();
      formData.append('avatar', this._pendingAvatarFile);
      const resp = await fetch('/api/upload-avatar', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${this.token}` },
        body: formData
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Upload failed');

      // Server stored the file and returned the URL path
      this.user.avatar = data.url;
      localStorage.setItem('haven_user', JSON.stringify(this.user));
      this._pendingAvatarFile = null;
      this._pendingAvatarPreviewUrl = null;
      
      // Update preview to use the server URL
      const preview = document.getElementById('avatar-upload-preview');
      if (preview) {
        const img = document.createElement('img');
        img.src = data.url;
        img.alt = 'avatar';
        preview.innerHTML = '';
        preview.appendChild(img);
      }
      
      // Notify connected sockets about the avatar change (small URL, not data URL)
      if (this.socket) this.socket.emit('set-avatar', { url: data.url });
    }

    // 2. Remove avatar if Clear was clicked
    if (this._pendingAvatarRemoved) {
      const resp = await fetch('/api/remove-avatar', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Content-Type': 'application/json'
        }
      });
      if (!resp.ok) throw new Error('Failed to remove avatar');

      this.user.avatar = null;
      localStorage.setItem('haven_user', JSON.stringify(this.user));
      this._pendingAvatarRemoved = false;
      
      if (this.socket) this.socket.emit('set-avatar', { url: '' });
    }

    // 3. Save shape via HTTP
    if (this._pendingAvatarShape !== this._avatarShape) {
      const resp = await fetch('/api/set-avatar-shape', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ shape: this._pendingAvatarShape })
      });
      if (!resp.ok) throw new Error('Failed to save shape');

      this._avatarShape = this._pendingAvatarShape;
      this.user.avatarShape = this._pendingAvatarShape;
      localStorage.setItem('haven_avatar_shape', this._pendingAvatarShape);
      localStorage.setItem('haven_user', JSON.stringify(this.user));
      
      if (this.socket) this.socket.emit('set-avatar-shape', { shape: this._pendingAvatarShape });
    }

    if (status) { status.textContent = '✅ Saved!'; status.style.color = 'var(--success, #6f6)'; }
    this._showToast('Avatar settings saved!', 'success');
    setTimeout(() => { if (status) status.textContent = ''; }, 3000);

  } catch (err) {
    console.error('[Avatar] Save failed:', err);
    if (status) { status.textContent = '❌ ' + err.message; status.style.color = 'var(--danger, red)'; }
    this._showToast('Failed to save: ' + err.message, 'error');
  }
},

_applyAvatarShape() {
  // No-op: shapes are now per-user and rendered from server data per message.
  // This function is kept as a safe stub in case it's called elsewhere.
},

// ═══════════════════════════════════════════════════════
// SOUND MANAGER (Full Popout — Admin + User)
// ═══════════════════════════════════════════════════════

_setupSoundManagement() {
  this.customSounds = [];
  this._soundHotkeys = JSON.parse(localStorage.getItem('haven_sound_hotkeys') || '{}'); // { hotkey: soundName }
  this._recordingHotkeyFor = null; // soundName currently recording hotkey
  this._soundCooldowns = {};       // hotkey → timestamp to prevent key-repeat spam

  // Open from admin "Manage Sounds" button
  const openBtn = document.getElementById('open-sound-manager-btn');
  if (openBtn) {
    openBtn.addEventListener('click', () => this._openSoundModal('manage'));
  }
  // Open from user "Sound Manager" button
  const openUserBtn = document.getElementById('open-sound-manager-user-btn');
  if (openUserBtn) {
    openUserBtn.addEventListener('click', () => this._openSoundModal('soundboard'));
  }

  // Close sound modal
  document.getElementById('close-sound-modal-btn')?.addEventListener('click', () => {
    document.getElementById('sound-modal').style.display = 'none';
  });
  document.getElementById('sound-modal')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) e.currentTarget.style.display = 'none';
  });

  // Tab switching
  document.querySelectorAll('.sound-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.sound-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.sound-tab-content').forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      const target = document.getElementById(`sound-tab-${tab.dataset.tab}`);
      if (target) target.classList.add('active');
    });
  });

  // Upload button (admin)
  const uploadBtn = document.getElementById('sound-upload-btn');
  const fileInput = document.getElementById('sound-file-input');
  const nameInput = document.getElementById('sound-name-input');
  if (uploadBtn && fileInput) {
    uploadBtn.addEventListener('click', async () => {
      const file = fileInput.files[0];
      const name = nameInput ? nameInput.value.trim() : '';
      if (!file) return this._showToast('Select an audio file', 'error');
      if (!name) return this._showToast('Enter a sound name', 'error');
      const maxSoundKb = parseInt(this.serverSettings?.max_sound_kb) || 1024;
      if (file.size > maxSoundKb * 1024) return this._showToast(`Sound file too large (max ${maxSoundKb >= 1024 ? (maxSoundKb / 1024) + ' MB' : maxSoundKb + ' KB'})`, 'error');

      const formData = new FormData();
      formData.append('sound', file);
      formData.append('name', name);

      try {
        this._showToast('Uploading sound...', 'info');
        const res = await fetch('/api/upload-sound', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${this.token}` },
          body: formData
        });
        if (!res.ok) {
          let errMsg = `Upload failed (${res.status})`;
          try { const d = await res.json(); errMsg = d.error || errMsg; } catch {}
          return this._showToast(errMsg, 'error');
        }
        this._showToast(`Sound "${name}" uploaded!`, 'success');
        fileInput.value = '';
        nameInput.value = '';
        this._loadCustomSounds();
      } catch {
        this._showToast('Upload failed', 'error');
      }
    });
  }

  // Soundboard search
  const searchInput = document.getElementById('soundboard-search');
  if (searchInput) {
    searchInput.addEventListener('input', () => this._renderSoundboard(searchInput.value.trim()));
  }

  // Soundboard popout button
  document.getElementById('soundboard-popout-btn')?.addEventListener('click', () => this._popOutSoundboard());

  // Global hotkey listener
  document.addEventListener('keydown', (e) => {
    // Ignore key-repeat events (holding a key down)
    if (e.repeat) return;

    // If recording a hotkey for a sound, wait for a non-modifier key
    if (this._recordingHotkeyFor) {
      // Let modifier-only presses pass so the user can build combos
      if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;
      e.preventDefault();
      const hk = this._buildHotkeyString(e);
      if (hk === 'Escape') {
        this._recordingHotkeyFor = null;
        this._renderSoundboard();
        return;
      }
      // Remove any old binding with same hotkey
      Object.keys(this._soundHotkeys).forEach(k => {
        if (this._soundHotkeys[k] === this._recordingHotkeyFor) delete this._soundHotkeys[k];
      });
      this._soundHotkeys[hk] = this._recordingHotkeyFor;
      localStorage.setItem('haven_sound_hotkeys', JSON.stringify(this._soundHotkeys));
      this._showToast(`Hotkey [${hk}] set for "${this._recordingHotkeyFor}"`, 'success');
      this._recordingHotkeyFor = null;
      this._renderSoundboard();
      return;
    }
    // Check if a bound hotkey was pressed (only when not typing in inputs)
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    const hk = this._buildHotkeyString(e);
    const soundName = this._soundHotkeys[hk];
    if (soundName && this.customSounds) {
      // Cooldown: prevent rapid re-trigger (300ms minimum between plays)
      const now = Date.now();
      if (this._soundCooldowns[hk] && now - this._soundCooldowns[hk] < 300) return;
      this._soundCooldowns[hk] = now;
      const s = this.customSounds.find(cs => cs.name === soundName);
      if (s) {
        e.preventDefault();
        this._playSoundFile(s.url);
      }
    }
  });

  // Load custom sounds on init
  this._loadCustomSounds();
},

_buildHotkeyString(e) {
  const parts = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  const key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  if (!['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) parts.push(key);
  return parts.join('+');
},

_openSoundModal(tab = 'soundboard') {
  const modal = document.getElementById('sound-modal');
  if (!modal) return;
  // If soundboard is already popped out, bring it into focus rather than reopening the modal
  if (this._soundboardPip) {
    this._soundboardPip.style.zIndex = '10001';
    setTimeout(() => { if (this._soundboardPip) this._soundboardPip.style.zIndex = '10000'; }, 400);
    return;
  }
  // Show admin tab only if user is admin or has manage_soundboard permission
  const adminTab = modal.querySelector('.sound-tab-admin');
  if (adminTab) adminTab.style.display = (this.user?.is_admin || this._hasPerm('manage_soundboard')) ? '' : 'none';
  // Activate requested tab
  modal.querySelectorAll('.sound-tab').forEach(t => t.classList.remove('active'));
  modal.querySelectorAll('.sound-tab-content').forEach(c => c.classList.remove('active'));
  const tabBtn = modal.querySelector(`.sound-tab[data-tab="${tab}"]`);
  const tabContent = document.getElementById(`sound-tab-${tab}`);
  if (tabBtn) tabBtn.classList.add('active');
  if (tabContent) tabContent.classList.add('active');
  modal.style.display = 'flex';
  // Sync popout button state
  const popoutBtn = document.getElementById('soundboard-popout-btn');
  if (popoutBtn) { popoutBtn.textContent = '\u29c9'; popoutBtn.title = 'Pop out soundboard'; }
  this._renderSoundboard();
  this._renderAssignTab();
},

_popOutSoundboard() {
  if (this._soundboardPip) {
    this._popInSoundboard();
    return;
  }

  // Close the modal
  document.getElementById('sound-modal').style.display = 'none';

  const pip = document.createElement('div');
  pip.id = 'sb-pip-overlay';
  pip.className = 'sb-pip-overlay';
  pip.innerHTML = `
    <div class="music-pip-header" id="sb-pip-drag">
      <button class="music-pip-btn" id="sb-pip-popin" title="Pop back in">\u29c8</button>
      <span class="music-pip-label">\uD83C\uDFB5 Soundboard</span>
      <button class="music-pip-btn" id="sb-pip-close" title="Close">\u2715</button>
    </div>
    <div class="sb-pip-body">
      <div class="sound-search-row" style="padding:0;margin-bottom:0">
        <input type="text" id="sb-pip-search" placeholder="Search sounds..." class="settings-text-input" style="flex:1;font-size:12px">
      </div>
      <div id="sb-pip-grid" class="sb-pip-grid"></div>
    </div>
  `;
  document.body.appendChild(pip);
  this._soundboardPip = pip;

  this._renderSoundboard();

  document.getElementById('sb-pip-search').addEventListener('input', (e) => {
    this._renderSoundboard(e.target.value.trim());
  });
  document.getElementById('sb-pip-popin').addEventListener('click', () => this._popInSoundboard(true));
  document.getElementById('sb-pip-close').addEventListener('click', () => this._popInSoundboard(false));

  this._initPipDrag(pip, document.getElementById('sb-pip-drag'));
},

_popInSoundboard(reopen = false) {
  if (!this._soundboardPip) return;
  this._soundboardPip.remove();
  this._soundboardPip = null;
  if (reopen) this._openSoundModal('soundboard');
},

_playSoundFile(url) {
  try {
    const vol = Math.max(0, Math.min(1, this.notifications.volume * this.notifications.volume));
    // If in voice chat, route through VC so other users hear the sound too
    if (this.voice && this.voice.playSoundToVC(url, vol)) return;
    // Fallback: play locally only
    const audio = new Audio(url);
    audio.volume = vol;
    audio.play().catch(() => {});
  } catch { /* audio not available */ }
},

async _loadCustomSounds() {
  try {
    const res = await fetch('/api/sounds', {
      headers: { 'Authorization': `Bearer ${this.token}` }
    });
    if (!res.ok) return;
    const data = await res.json();
    const sounds = data.sounds || [];
    this.customSounds = sounds; // [{name, url}]

    // Update all notification sound select dropdowns
    this._updateSoundSelects(sounds);

    // Render admin sound list
    this._renderSoundList(sounds);

    // Render soundboard if modal is visible or PiP is open
    if (document.getElementById('sound-modal')?.style.display === 'flex' || this._soundboardPip) {
      this._renderSoundboard();
      this._renderAssignTab();
    }
  } catch { /* ignore */ }
},

_updateSoundSelects(sounds) {
  // Update ALL 5 notification selects with custom sounds
  const selects = ['notif-msg-sound', 'notif-sent-sound', 'notif-mention-sound', 'notif-join-sound', 'notif-leave-sound'];
  selects.forEach(id => {
    const sel = document.getElementById(id);
    if (!sel) return;

    // Remember current value
    const currentVal = sel.value;

    // Remove old custom options
    sel.querySelectorAll('option[data-custom]').forEach(o => o.remove());
    sel.querySelectorAll('optgroup[data-custom-group]').forEach(o => o.remove());

    const noneOpt = sel.querySelector('option[value="none"]');

    // Add custom sounds optgroup
    const builtins = sounds.filter(s => s.builtin);
    const customs  = sounds.filter(s => !s.builtin);

    if (builtins.length > 0) {
      const builtinGroup = document.createElement('optgroup');
      builtinGroup.label = `🎙️ ${t('modals.sound_manager.group_builtin')}`;
      builtinGroup.dataset.customGroup = '1';
      builtins.forEach(s => {
        const opt = document.createElement('option');
        opt.value = `custom:${s.name}`;
        opt.textContent = s.name;
        opt.dataset.custom = '1';
        opt.dataset.url = s.url;
        builtinGroup.appendChild(opt);
      });
      sel.insertBefore(builtinGroup, noneOpt);
    }

    if (customs.length > 0) {
      const customGroup = document.createElement('optgroup');
      customGroup.label = `🎵 ${t('modals.sound_manager.group_custom')}`;
      customGroup.dataset.customGroup = '1';
      customs.forEach(s => {
        const opt = document.createElement('option');
        opt.value = `custom:${s.name}`;
        opt.textContent = s.name;
        opt.dataset.custom = '1';
        opt.dataset.url = s.url;
        customGroup.appendChild(opt);
      });
      sel.insertBefore(customGroup, noneOpt);
    }

    // Restore value
    sel.value = currentVal;
  });
},

_renderSoundList(sounds) {
  const list = document.getElementById('custom-sounds-list');
  if (!list) return;

  const builtins = sounds.filter(s => s.builtin);
  const custom   = sounds.filter(s => !s.builtin);

  if (builtins.length === 0 && custom.length === 0) {
    list.innerHTML = `<p class="muted-text">${t('modals.sound_manager.no_custom_sounds')}</p>`;
    return;
  }

  const builtinHtml = builtins.length === 0 ? '' : `
    <p class="muted-text" style="margin:4px 0 2px;font-size:0.78em;text-transform:uppercase;letter-spacing:.06em">${t('modals.sound_manager.group_builtin')}</p>
    ${builtins.map(s => `
      <div class="custom-sound-item" data-name="${this._escapeHtml(s.name)}">
        <span class="custom-sound-name">${this._escapeHtml(s.name)}</span>
        <button class="btn-xs sound-preview-btn" data-url="${this._escapeHtml(s.url)}" title="${t('modals.sound_manager.preview_btn')}">▶</button>
        <span class="muted-text" style="font-size:0.75em;margin-left:4px" title="${t('modals.sound_manager.builtin_locked_title')}">🔒</span>
      </div>
    `).join('')}
  `;

  const customHtml = custom.length === 0 ? '' : `
    <p class="muted-text" style="margin:8px 0 2px;font-size:0.78em;text-transform:uppercase;letter-spacing:.06em">${t('modals.sound_manager.group_custom')}</p>
    ${custom.map(s => `
      <div class="custom-sound-item" data-name="${this._escapeHtml(s.name)}">
        <span class="custom-sound-name">${this._escapeHtml(s.name)}</span>
        <button class="btn-xs sound-preview-btn" data-url="${this._escapeHtml(s.url)}" title="${t('modals.sound_manager.preview_btn')}">▶</button>
        <button class="btn-xs sound-rename-btn" data-name="${this._escapeHtml(s.name)}" title="${t('modals.sound_manager.rename_btn')}">✏️</button>
        <button class="btn-xs sound-delete-btn" data-name="${this._escapeHtml(s.name)}" title="${t('modals.sound_manager.delete_btn')}">🗑️</button>
      </div>
    `).join('')}
  `;

  list.innerHTML = builtinHtml + customHtml;

  // Preview buttons
  list.querySelectorAll('.sound-preview-btn').forEach(btn => {
    btn.addEventListener('click', () => this._playSoundFile(btn.dataset.url));
  });

  // Rename buttons
  list.querySelectorAll('.sound-rename-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const item = btn.closest('.custom-sound-item');
      const nameSpan = item.querySelector('.custom-sound-name');
      const oldName = btn.dataset.name;
      // Replace span with input
      const input = document.createElement('input');
      input.type = 'text';
      input.value = oldName;
      input.maxLength = 30;
      input.className = 'custom-sound-name-input';
      nameSpan.replaceWith(input);
      input.focus();
      input.select();

      const doRename = async () => {
        const newName = input.value.trim();
        if (!newName || newName === oldName) {
          // Revert
          const span = document.createElement('span');
          span.className = 'custom-sound-name';
          span.textContent = oldName;
          input.replaceWith(span);
          return;
        }
        try {
          const res = await fetch(`/api/sounds/${encodeURIComponent(oldName)}`, {
            method: 'PATCH',
            headers: { 'Authorization': `Bearer ${this.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ newName })
          });
          if (res.ok) {
            // Update hotkey bindings
            Object.keys(this._soundHotkeys).forEach(k => {
              if (this._soundHotkeys[k] === oldName) this._soundHotkeys[k] = newName;
            });
            localStorage.setItem('haven_sound_hotkeys', JSON.stringify(this._soundHotkeys));
            this._showToast(`Renamed to "${newName}"`, 'success');
            this._loadCustomSounds();
          } else {
            let errMsg = 'Rename failed';
            try { const d = await res.json(); errMsg = d.error || errMsg; } catch {}
            this._showToast(errMsg, 'error');
            const span = document.createElement('span');
            span.className = 'custom-sound-name';
            span.textContent = oldName;
            input.replaceWith(span);
          }
        } catch {
          this._showToast('Rename failed', 'error');
        }
      };

      input.addEventListener('blur', doRename);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
        if (e.key === 'Escape') { input.value = oldName; input.blur(); }
      });
    });
  });

  // Delete buttons
  list.querySelectorAll('.sound-delete-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const name = btn.dataset.name;
      try {
        const res = await fetch(`/api/sounds/${encodeURIComponent(name)}`, {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${this.token}` }
        });
        if (res.ok) {
          this._showToast(`Sound "${name}" deleted`, 'success');
          // Clean up hotkey
          Object.keys(this._soundHotkeys).forEach(k => {
            if (this._soundHotkeys[k] === name) delete this._soundHotkeys[k];
          });
          localStorage.setItem('haven_sound_hotkeys', JSON.stringify(this._soundHotkeys));
          this._loadCustomSounds();
        } else {
          this._showToast('Delete failed', 'error');
        }
      } catch {
        this._showToast('Delete failed', 'error');
      }
    });
  });
},

// ── Soundboard Tab ─────────────────────────────────────

_renderSoundboard(filter = '') {
  // Render into both the modal grid and the PiP grid if it's open
  const grids = [];
  const modalGrid = document.getElementById('soundboard-grid');
  if (modalGrid) grids.push(modalGrid);
  const pipGrid = this._soundboardPip ? document.getElementById('sb-pip-grid') : null;
  if (pipGrid) grids.push(pipGrid);
  if (grids.length === 0) return;

  const sounds = (this.customSounds || []).filter(s =>
    !filter || s.name.toLowerCase().includes(filter.toLowerCase())
  );

  // Reverse lookup: soundName → hotkey
  const hotkeyMap = {};
  Object.entries(this._soundHotkeys).forEach(([hk, name]) => { hotkeyMap[name] = hk; });

  const html = sounds.length === 0
    ? `<p class="muted-text" style="grid-column:1/-1">${filter ? 'No matching sounds' : 'No sounds available'}</p>`
    : sounds.map(s => {
        const hk = hotkeyMap[s.name];
        const hotkeyHtml = hk
          ? `<span class="sb-hotkey-row">
               <span class="sb-hotkey">${this._escapeHtml(hk)}</span>
               <span class="sb-hotkey-clear" data-sound="${this._escapeHtml(s.name)}" title="Remove hotkey">&times;</span>
             </span>`
          : `<span class="sb-hotkey-set" data-sound="${this._escapeHtml(s.name)}">Set hotkey</span>`;
        return `<button class="soundboard-btn" data-name="${this._escapeHtml(s.name)}" data-url="${this._escapeHtml(s.url)}">
          <span class="sb-name">${this._escapeHtml(s.name)}</span>
          ${hotkeyHtml}
        </button>`;
      }).join('');

  grids.forEach(grid => {
    grid.innerHTML = html;
    if (sounds.length === 0) return;

    // Click the main button area to play
    grid.querySelectorAll('.soundboard-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        if (e.target.closest('.sb-hotkey-clear') || e.target.closest('.sb-hotkey-set')) return;
        this._playSoundFile(btn.dataset.url);
      });
    });

    // "Set hotkey" link
    grid.querySelectorAll('.sb-hotkey-set').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const name = el.dataset.sound;
        this._recordingHotkeyFor = name;
        const btn = el.closest('.soundboard-btn');
        if (btn) btn.classList.add('hotkey-recording');
        this._showToast(`Press a key combo for "${name}" (Esc to cancel)`, 'info');
      });
    });

    // "×" remove hotkey button
    grid.querySelectorAll('.sb-hotkey-clear').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const name = el.dataset.sound;
        const hk = hotkeyMap[name];
        if (hk) {
          delete this._soundHotkeys[hk];
          localStorage.setItem('haven_sound_hotkeys', JSON.stringify(this._soundHotkeys));
          this._showToast(`Hotkey removed for "${name}"`, 'info');
          this._renderSoundboard(
            this._soundboardPip
              ? (document.getElementById('sb-pip-search')?.value?.trim() || '')
              : (document.getElementById('soundboard-search')?.value?.trim() || '')
          );
        }
      });
    });

    // Right-click also starts hotkey recording
    grid.querySelectorAll('.soundboard-btn').forEach(btn => {
      btn.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (e.target.closest('.sb-hotkey-clear')) return;
        const name = btn.dataset.name;
        this._recordingHotkeyFor = name;
        btn.classList.add('hotkey-recording');
        this._showToast(`Press a key combo for "${name}" (Esc to cancel)`, 'info');
      });
    });
  });
},

// ── Assign to Events Tab ───────────────────────────────

_renderAssignTab() {
  const builtinSounds = [
    { value: 'ping', label: 'Ping' }, { value: 'chime', label: 'Chime' },
    { value: 'blip', label: 'Blip' }, { value: 'bell', label: 'Bell' },
    { value: 'drop', label: 'Drop' }, { value: 'alert', label: 'Alert' },
    { value: 'chord', label: 'Chord' }, { value: 'swoosh', label: 'Swoosh' },
    { value: 'none', label: 'None' },
  ];
  const customs = (this.customSounds || []).map(s => ({
    value: `custom:${s.name}`, label: s.name, url: s.url, builtin: !!s.builtin
  }));
  const fileBuiltins = customs.filter(s => s.builtin);
  const userCustoms  = customs.filter(s => !s.builtin);

  const events = [
    { selectId: 'assign-msg-sound', event: 'message', notifSelect: 'notif-msg-sound' },
    { selectId: 'assign-sent-sound', event: 'sent', notifSelect: 'notif-sent-sound' },
    { selectId: 'assign-mention-sound', event: 'mention', notifSelect: 'notif-mention-sound' },
    { selectId: 'assign-join-sound', event: 'join', notifSelect: 'notif-join-sound' },
    { selectId: 'assign-leave-sound', event: 'leave', notifSelect: 'notif-leave-sound' },
  ];

  events.forEach(({ selectId, event, notifSelect }) => {
    const sel = document.getElementById(selectId);
    if (!sel) return;

    // Build options
    sel.innerHTML = '';
    const builtinGroup = document.createElement('optgroup');
    builtinGroup.label = '🔊 Built-in';
    builtinSounds.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.value;
      opt.textContent = s.label;
      builtinGroup.appendChild(opt);
    });
    sel.appendChild(builtinGroup);

    if (fileBuiltins.length > 0) {
      const fbGroup = document.createElement('optgroup');
      fbGroup.label = '🎙️ Sounds';
      fileBuiltins.forEach(s => {
        const opt = document.createElement('option');
        opt.value = s.value;
        opt.textContent = s.label;
        opt.dataset.url = s.url;
        fbGroup.appendChild(opt);
      });
      sel.appendChild(fbGroup);
    }

    if (userCustoms.length > 0) {
      const customGroup = document.createElement('optgroup');
      customGroup.label = '🎵 Custom';
      userCustoms.forEach(s => {
        const opt = document.createElement('option');
        opt.value = s.value;
        opt.textContent = s.label;
        opt.dataset.url = s.url;
        customGroup.appendChild(opt);
      });
      sel.appendChild(customGroup);
    }

    // Sync with current notification setting
    sel.value = this.notifications.sounds[event] || 'none';

    // On change, update the main notification select + play preview
    sel.addEventListener('change', () => {
      const val = sel.value;
      this.notifications.setSound(event, val);
      // Sync the main settings select
      const mainSel = document.getElementById(notifSelect);
      if (mainSel) mainSel.value = val;
      // Play preview
      this.notifications.play(event);
    });
  });
},

// ═══════════════════════════════════════════════════════
// CUSTOM EMOJI MANAGEMENT
// ═══════════════════════════════════════════════════════

_setupEmojiManagement() {
  this._croppedEmojiBlob = null;
  this._cropState = null;
  this._cropSourceFile = null;

  // Open emoji management modal
  const openEmojiBtn = document.getElementById('open-emoji-manager-btn');
  if (openEmojiBtn) {
    openEmojiBtn.addEventListener('click', () => {
      document.getElementById('emoji-modal').style.display = 'flex';
    });
  }
  // Close emoji modal
  document.getElementById('close-emoji-modal-btn')?.addEventListener('click', () => {
    document.getElementById('emoji-modal').style.display = 'none';
  });
  document.getElementById('emoji-modal')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) e.currentTarget.style.display = 'none';
  });

  const uploadBtn = document.getElementById('emoji-upload-btn');
  const fileInput = document.getElementById('emoji-file-input');
  const nameInput = document.getElementById('emoji-name-input');
  if (!uploadBtn || !fileInput) return;

  // When a file is chosen, open the cropper (skip for GIFs)
  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    if (!file) return;
    this._croppedEmojiBlob = null;
    this._cropSourceFile = file;
    const previewRow = document.getElementById('emoji-crop-preview-row');
    if (previewRow) previewRow.style.display = 'none';
    if (file.type === 'image/gif') return; // GIFs skip cropper
    this._openEmojiCropper(file);
  });

  uploadBtn.addEventListener('click', async () => {
    const file = fileInput.files[0];
    const name = nameInput ? nameInput.value.trim().replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase() : '';
    if (!file) return this._showToast('Select an image file', 'error');
    if (!name) return this._showToast('Enter an emoji name (lowercase, no spaces)', 'error');

    // Use cropped blob for non-GIF uploads, otherwise raw file
    const uploadBlob = (this._croppedEmojiBlob && file.type !== 'image/gif')
      ? this._croppedEmojiBlob
      : file;
    const maxEmojiKb = parseInt(this.serverSettings?.max_emoji_kb) || 256;
    if (uploadBlob.size > maxEmojiKb * 1024) return this._showToast(`Emoji file too large (max ${maxEmojiKb} KB)`, 'error');

    const formData = new FormData();
    formData.append('emoji', uploadBlob, file.name);
    formData.append('name', name);

    try {
      this._showToast('Uploading emoji...', 'info');
      const res = await fetch('/api/upload-emoji', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${this.token}` },
        body: formData
      });
      if (!res.ok) {
        let errMsg = `Upload failed (${res.status})`;
        try { const d = await res.json(); errMsg = d.error || errMsg; } catch {}
        return this._showToast(errMsg, 'error');
      }
      this._showToast(`Emoji :${name}: uploaded!`, 'success');
      fileInput.value = '';
      if (nameInput) nameInput.value = '';
      this._croppedEmojiBlob = null;
      this._cropSourceFile = null;
      this._cropState = null;
      const previewRow = document.getElementById('emoji-crop-preview-row');
      if (previewRow) previewRow.style.display = 'none';
      this._loadCustomEmojis();
    } catch {
      this._showToast('Upload failed', 'error');
    }
  });

  // Bulk emoji upload — select multiple files, auto-named from filenames
  const bulkInput = document.getElementById('emoji-bulk-input');
  if (bulkInput) {
    bulkInput.addEventListener('change', async () => {
      const files = Array.from(bulkInput.files);
      if (!files.length) return;
      const maxEmojiKb = parseInt(this.serverSettings?.max_emoji_kb) || 256;
      const formData = new FormData();
      let skipped = 0;
      for (const file of files) {
        if (file.size > maxEmojiKb * 1024) { skipped++; continue; }
        formData.append('emojis', file, file.name);
      }
      if ([...formData.entries()].length === 0) {
        bulkInput.value = '';
        return this._showToast(`All files exceeded the ${maxEmojiKb} KB limit`, 'error');
      }
      try {
        this._showToast(`Uploading ${files.length - skipped} emoji${files.length - skipped > 1 ? 's' : ''}...`, 'info');
        const res = await fetch('/api/upload-emojis', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${this.token}` },
          body: formData
        });
        if (!res.ok) {
          let errMsg = `Upload failed (${res.status})`;
          try { const d = await res.json(); errMsg = d.error || errMsg; } catch {}
          return this._showToast(errMsg, 'error');
        }
        const data = await res.json();
        const count = data.uploaded?.length || 0;
        const errCount = (data.errors?.length || 0) + skipped;
        let msg = `${count} emoji${count !== 1 ? 's' : ''} uploaded`;
        if (errCount) msg += ` (${errCount} skipped)`;
        this._showToast(msg, count ? 'success' : 'error');
        this._loadCustomEmojis();
      } catch {
        this._showToast('Bulk upload failed', 'error');
      }
      bulkInput.value = '';
    });
  }

  this._setupEmojiCropperEvents();
  this._loadCustomEmojis();
},

_setupEmojiCropperEvents() {
  const canvas = document.getElementById('emoji-crop-canvas');
  const zoomSlider = document.getElementById('emoji-crop-zoom');
  if (!canvas || !zoomSlider) return;

  // Zoom slider
  zoomSlider.addEventListener('input', () => {
    if (!this._cropState) return;
    const s = this._cropState;
    const prevScale = s.scale;
    const newScale = s.minScale * (parseInt(zoomSlider.value) / 100);
    // Zoom toward canvas center
    s.ox = 128 - (128 - s.ox) * (newScale / prevScale);
    s.oy = 128 - (128 - s.oy) * (newScale / prevScale);
    s.scale = newScale;
    this._clampEmojiCrop();
    this._renderEmojiCropFrame();
  });

  // Mouse wheel → zoom
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (!this._cropState) return;
    const delta = e.deltaY < 0 ? 15 : -15;
    const newVal = Math.min(500, Math.max(100, parseInt(zoomSlider.value) + delta));
    zoomSlider.value = newVal;
    zoomSlider.dispatchEvent(new Event('input'));
  }, { passive: false });

  // Mouse drag
  canvas.addEventListener('mousedown', (e) => {
    if (!this._cropState) return;
    this._cropState.dragging = true;
    this._cropState.lastX = e.clientX;
    this._cropState.lastY = e.clientY;
    canvas.style.cursor = 'grabbing';
  });
  document.addEventListener('mousemove', (e) => {
    if (!this._cropState?.dragging) return;
    const s = this._cropState;
    s.ox += e.clientX - s.lastX;
    s.oy += e.clientY - s.lastY;
    s.lastX = e.clientX;
    s.lastY = e.clientY;
    this._clampEmojiCrop();
    this._renderEmojiCropFrame();
  });
  document.addEventListener('mouseup', () => {
    if (this._cropState) this._cropState.dragging = false;
    canvas.style.cursor = 'grab';
  });

  // Touch drag
  canvas.addEventListener('touchstart', (e) => {
    if (!this._cropState) return;
    e.preventDefault();
    const t = e.touches[0];
    this._cropState.dragging = true;
    this._cropState.lastX = t.clientX;
    this._cropState.lastY = t.clientY;
  }, { passive: false });
  canvas.addEventListener('touchmove', (e) => {
    if (!this._cropState?.dragging) return;
    e.preventDefault();
    const s = this._cropState;
    const t = e.touches[0];
    s.ox += t.clientX - s.lastX;
    s.oy += t.clientY - s.lastY;
    s.lastX = t.clientX;
    s.lastY = t.clientY;
    this._clampEmojiCrop();
    this._renderEmojiCropFrame();
  }, { passive: false });
  canvas.addEventListener('touchend', () => {
    if (this._cropState) this._cropState.dragging = false;
  });

  // Confirm crop
  document.getElementById('emoji-crop-confirm-btn')?.addEventListener('click', () => {
    if (!this._cropState) return;
    const s = this._cropState;
    const outCanvas = document.createElement('canvas');
    outCanvas.width = 128;
    outCanvas.height = 128;
    const outCtx = outCanvas.getContext('2d');
    const srcX = -s.ox / s.scale;
    const srcY = -s.oy / s.scale;
    const srcW = 256 / s.scale;
    const srcH = 256 / s.scale;
    outCtx.drawImage(s.img, srcX, srcY, srcW, srcH, 0, 0, 128, 128);
    outCanvas.toBlob((blob) => {
      this._croppedEmojiBlob = blob;
      document.getElementById('emoji-crop-modal').style.display = 'none';
      // Show preview row in the emoji modal
      const thumb = document.getElementById('emoji-crop-thumb');
      if (thumb) { thumb.src = outCanvas.toDataURL('image/png'); }
      const previewRow = document.getElementById('emoji-crop-preview-row');
      if (previewRow) previewRow.style.display = 'flex';
    }, 'image/png');
  });

  // Cancel crop
  document.getElementById('emoji-crop-cancel-btn')?.addEventListener('click', () => {
    document.getElementById('emoji-crop-modal').style.display = 'none';
    document.getElementById('emoji-file-input').value = '';
    this._croppedEmojiBlob = null;
    this._cropState = null;
    this._cropSourceFile = null;
  });

  // Re-crop button in preview row
  document.getElementById('emoji-recrop-btn')?.addEventListener('click', () => {
    if (this._cropSourceFile) this._openEmojiCropper(this._cropSourceFile);
  });
},

_openEmojiCropper(file) {
  const modal = document.getElementById('emoji-crop-modal');
  const canvas = document.getElementById('emoji-crop-canvas');
  const zoomSlider = document.getElementById('emoji-crop-zoom');
  if (!modal || !canvas || !zoomSlider) return;

  const img = new Image();
  const url = URL.createObjectURL(file);
  img.onload = () => {
    URL.revokeObjectURL(url);
    const minScale = Math.max(256 / img.width, 256 / img.height);
    const initScale = minScale;
    this._cropState = {
      img,
      minScale,
      scale: initScale,
      ox: (256 - img.width * initScale) / 2,
      oy: (256 - img.height * initScale) / 2,
      dragging: false,
      lastX: 0,
      lastY: 0
    };
    zoomSlider.value = 100;
    this._clampEmojiCrop();
    this._renderEmojiCropFrame();
    modal.style.display = 'flex';
  };
  img.src = url;
},

_clampEmojiCrop() {
  const s = this._cropState;
  if (!s) return;
  const w = s.img.width * s.scale;
  const h = s.img.height * s.scale;
  s.ox = Math.min(0, Math.max(256 - w, s.ox));
  s.oy = Math.min(0, Math.max(256 - h, s.oy));
},

_renderEmojiCropFrame() {
  const s = this._cropState;
  if (!s) return;
  const canvas = document.getElementById('emoji-crop-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, 256, 256);
  ctx.drawImage(s.img, s.ox, s.oy, s.img.width * s.scale, s.img.height * s.scale);
  // Corner guides to indicate crop boundary
  ctx.strokeStyle = 'rgba(255,255,255,0.75)';
  ctx.lineWidth = 2;
  const g = 14;
  [[0,0,1,1],[256,0,-1,1],[0,256,1,-1],[256,256,-1,-1]].forEach(([x,y,sx,sy]) => {
    ctx.beginPath();
    ctx.moveTo(x + sx, y); ctx.lineTo(x + sx * g, y);
    ctx.moveTo(x, y + sy); ctx.lineTo(x, y + sy * g);
    ctx.stroke();
  });
},

async _loadCustomEmojis() {
  try {
    const res = await fetch('/api/emojis', {
      headers: { 'Authorization': `Bearer ${this.token}` }
    });
    if (!res.ok) return;
    const data = await res.json();
    this.customEmojis = data.emojis || []; // [{name, url}]
    this._renderEmojiList(this.customEmojis);
  } catch { /* ignore */ }
},

_renderEmojiList(emojis) {
  const list = document.getElementById('custom-emojis-list');
  if (!list) return;

  if (emojis.length === 0) {
    list.innerHTML = '<p class="muted-text">No custom emojis uploaded</p>';
    return;
  }

  list.innerHTML = emojis.map(e => `
    <div class="custom-sound-item">
      <img src="${this._escapeHtml(e.url)}" alt=":${this._escapeHtml(e.name)}:" class="custom-emoji-preview" style="width:24px;height:24px;vertical-align:middle;margin-right:6px;">
      <span class="custom-sound-name">:${this._escapeHtml(e.name)}:</span>
      <button class="btn-xs emoji-delete-btn" data-name="${this._escapeHtml(e.name)}" title="Delete">🗑️</button>
    </div>
  `).join('');

  list.querySelectorAll('.emoji-delete-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const name = btn.dataset.name;
      try {
        const res = await fetch(`/api/emojis/${encodeURIComponent(name)}`, {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${this.token}` }
        });
        if (res.ok) {
          this._showToast(`Emoji :${name}: deleted`, 'success');
          this._loadCustomEmojis();
        } else {
          this._showToast('Delete failed', 'error');
        }
      } catch {
        this._showToast('Delete failed', 'error');
      }
    });
  });
},

// ═══════════════════════════════════════════════════════
// WEBHOOKS / BOT MANAGEMENT
// ═══════════════════════════════════════════════════════

_setupWebhookManagement() {
  // Open bot management modal
  const openBtn = document.getElementById('open-bot-editor-btn');
  if (openBtn) {
    openBtn.addEventListener('click', () => this._openBotModal());
  }
  // Close bot modal
  document.getElementById('close-bot-modal-btn')?.addEventListener('click', () => {
    document.getElementById('bot-modal').style.display = 'none';
  });
  document.getElementById('bot-modal')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) e.currentTarget.style.display = 'none';
  });
  // Create new bot
  document.getElementById('create-bot-btn')?.addEventListener('click', () => {
    this._createNewBot();
  });
},

_openBotModal() {
  document.getElementById('bot-modal').style.display = 'flex';
  document.getElementById('bot-detail-panel').innerHTML = `<p class="muted-text" style="padding:20px;text-align:center">${t('modals.bot_mgmt.select_or_create')}</p>`;
  // Request all webhooks for the sidebar
  this.socket.emit('get-webhooks');
},

async _createNewBot() {
  const name = await this._showPromptModal(t('modals.bot_mgmt.create_title'), t('modals.bot_mgmt.create_name_prompt'));
  if (!name || !name.trim()) return;
  // Pick first non-DM channel as default
  const firstChannel = this.channels.find(c => !c.is_dm);
  if (!firstChannel) return this._showToast(t('modals.bot_mgmt.no_channels'), 'error');
  this.socket.emit('create-webhook', { name: name.trim(), channel_id: firstChannel.id, avatar_url: null });
},

_renderBotSidebar(webhooks) {
  const sidebar = document.getElementById('bot-list-sidebar');
  if (!sidebar) return;
  this._botWebhooks = webhooks; // cache for detail panel
  sidebar.innerHTML = webhooks.map(wh => {
    const avatarHtml = wh.avatar_url
      ? `<img src="${this._escapeHtml(wh.avatar_url)}" style="width:20px;height:20px;border-radius:50%;object-fit:cover;flex-shrink:0">`
      : `<span style="width:20px;height:20px;border-radius:50%;background:var(--accent);display:flex;align-items:center;justify-content:center;font-size:10px;flex-shrink:0;color:#fff">🤖</span>`;
    const activeClass = this._selectedBotId === wh.id ? ' active' : '';
    return `<div class="role-sidebar-item${activeClass}" data-bot-id="${wh.id}">${avatarHtml}<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${this._escapeHtml(wh.name)}</span></div>`;
  }).join('');

  sidebar.querySelectorAll('.role-sidebar-item').forEach(item => {
    item.addEventListener('click', () => {
      const botId = parseInt(item.dataset.botId);
      this._selectedBotId = botId;
      // Highlight active
      sidebar.querySelectorAll('.role-sidebar-item').forEach(i => i.classList.remove('active'));
      item.classList.add('active');
      this._showBotDetail(botId);
    });
  });
},

_showBotDetail(botId) {
  const wh = (this._botWebhooks || []).find(w => w.id === botId);
  if (!wh) return;
  const panel = document.getElementById('bot-detail-panel');
  const baseUrl = window.location.origin;
  const webhookUrl = `${baseUrl}/api/webhooks/${wh.token}`;
  const maskedToken = wh.token.slice(0, 12) + '••••••••••••';
  const channelOptions = this._getBotChannelOptions(wh.channel_id);

  panel.innerHTML = `
    <div class="role-detail-form">
      <label class="settings-label">${t('modals.bot_mgmt.avatar_label')}</label>
      <div class="bot-avatar-row" style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
        <div class="bot-avatar-preview" style="width:48px;height:48px;border-radius:50%;overflow:hidden;border:2px solid var(--border);background:var(--bg-tertiary);flex-shrink:0;display:flex;align-items:center;justify-content:center">
          ${wh.avatar_url ? `<img src="${this._escapeHtml(wh.avatar_url)}" style="width:100%;height:100%;object-fit:cover">` : '<span style="font-size:24px">🤖</span>'}
        </div>
        <div style="display:flex;flex-direction:column;gap:4px">
          <button class="btn-xs btn-accent" id="bot-upload-avatar-btn">📷 ${t('modals.bot_mgmt.upload_avatar_btn')}</button>
          <button class="btn-xs" id="bot-remove-avatar-btn" ${wh.avatar_url ? '' : 'disabled'}>${t('modals.bot_mgmt.remove_avatar_btn')}</button>
        </div>
        <input type="file" id="bot-avatar-file-input" accept="image/png,image/jpeg,image/gif,image/webp" style="display:none">
      </div>

      <label class="settings-label">${t('modals.bot_mgmt.name_label')}</label>
      <input type="text" id="bot-detail-name" value="${this._escapeHtml(wh.name)}" maxlength="32" class="settings-text-input" style="width:100%;margin-bottom:8px">

      <label class="settings-label">${t('modals.bot_mgmt.channel_label')}</label>
      <select id="bot-detail-channel" class="settings-select" style="width:100%;margin-bottom:8px">${channelOptions}</select>

      <label class="settings-label">${t('modals.bot_mgmt.status_label')}</label>
      <label class="toggle-row" style="margin-bottom:8px">
        <span>${wh.is_active ? `🟢 ${t('modals.bot_mgmt.status_active')}` : `🔴 ${t('modals.bot_mgmt.status_disabled')}`}</span>
        <button class="btn-xs" id="bot-detail-toggle">${wh.is_active ? t('modals.bot_mgmt.disable_btn') : t('modals.bot_mgmt.enable_btn')}</button>
      </label>

      <label class="settings-label">${t('modals.bot_mgmt.webhook_url_label')}</label>
      <div style="display:flex;gap:4px;align-items:center;margin-bottom:8px">
        <code style="flex:1;font-size:11px;padding:6px 8px;background:var(--bg-input);border-radius:4px;color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${this._escapeHtml(webhookUrl)}</code>
        <button class="btn-xs" id="bot-detail-copy-url" title="${t('modals.bot_mgmt.copy_url_title')}">📋</button>
      </div>

      <label class="settings-label">${t('modals.bot_mgmt.token_label')}</label>
      <div style="font-size:11px;font-family:monospace;padding:4px 8px;background:var(--bg-input);border-radius:4px;color:var(--text-muted);margin-bottom:12px">${maskedToken}</div>

      <label class="settings-label">📡 Callback URL <span style="font-size:10px;color:var(--text-muted)">(optional — Haven will POST messages to this URL)</span></label>
      <input type="url" id="bot-detail-callback-url" value="${this._escapeHtml(wh.callback_url || '')}" placeholder="https://mybot.example.com/haven-events" class="settings-text-input" style="width:100%;margin-bottom:8px">

      <label class="settings-label">🔑 Callback Secret <span style="font-size:10px;color:var(--text-muted)">(optional — used to sign payloads via X-Haven-Signature)</span></label>
      <input type="text" id="bot-detail-callback-secret" value="${this._escapeHtml(wh.callback_secret || '')}" placeholder="my-secret-key" class="settings-text-input" style="width:100%;margin-bottom:12px">

      <div style="display:flex;gap:8px;margin-top:8px">
        <button class="btn-sm btn-accent" id="bot-detail-save" style="flex:1">💾 ${t('modals.bot_mgmt.save_btn')}</button>
        <button class="btn-sm btn-danger" id="bot-detail-delete">🗑️ ${t('modals.bot_mgmt.delete_btn')}</button>
      </div>
    </div>
  `;

  // Wire up handlers
  panel.querySelector('#bot-upload-avatar-btn').addEventListener('click', () => {
    panel.querySelector('#bot-avatar-file-input').click();
  });
  panel.querySelector('#bot-avatar-file-input').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    this._uploadBotAvatar(botId, file);
  });
  panel.querySelector('#bot-remove-avatar-btn').addEventListener('click', () => {
    this.socket.emit('update-webhook', { id: botId, avatar_url: '' });
  });
  panel.querySelector('#bot-detail-save').addEventListener('click', () => {
    const name = panel.querySelector('#bot-detail-name').value.trim();
    const channelId = parseInt(panel.querySelector('#bot-detail-channel').value);
    const callbackUrl = panel.querySelector('#bot-detail-callback-url').value.trim();
    const callbackSecret = panel.querySelector('#bot-detail-callback-secret').value.trim();
    if (!name) return this._showToast('Name is required', 'error');
    this.socket.emit('update-webhook', { id: botId, name, channel_id: channelId, callback_url: callbackUrl, callback_secret: callbackSecret });
  });
  panel.querySelector('#bot-detail-toggle').addEventListener('click', () => {
    this.socket.emit('toggle-webhook', { id: botId });
  });
  panel.querySelector('#bot-detail-copy-url').addEventListener('click', () => {
    const markCopied = () => {
      panel.querySelector('#bot-detail-copy-url').textContent = '✅';
      setTimeout(() => {
        const btn = panel.querySelector('#bot-detail-copy-url');
        if (btn) btn.textContent = '📋';
      }, 1500);
    };
    navigator.clipboard.writeText(webhookUrl).then(markCopied).catch(() => {
      try {
        const ta = document.createElement('textarea');
        ta.value = webhookUrl;
        ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
        document.body.appendChild(ta);
        ta.focus(); ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        markCopied();
      } catch { /* could not copy */ }
    });
  });
  panel.querySelector('#bot-detail-delete').addEventListener('click', () => {
    if (confirm(`Delete bot "${wh.name}"? This cannot be undone.`)) {
      this._selectedBotId = null;
      this.socket.emit('delete-webhook', { id: botId });
    }
  });
},

/** Build channel <option> list ordered like the sidebar (parents first, sub-channels indented) */
_getBotChannelOptions(selectedId) {
  const regular = this.channels.filter(c => !c.is_dm);
  const parents = regular.filter(c => !c.parent_channel_id);
  const subMap = {};
  regular.filter(c => c.parent_channel_id).forEach(c => {
    if (!subMap[c.parent_channel_id]) subMap[c.parent_channel_id] = [];
    subMap[c.parent_channel_id].push(c);
  });
  let html = '';
  for (const p of parents) {
    const sel = p.id === selectedId ? ' selected' : '';
    html += `<option value="${p.id}"${sel}># ${this._escapeHtml(p.name)}</option>`;
    const subs = subMap[p.id] || [];
    for (const s of subs) {
      const sSel = s.id === selectedId ? ' selected' : '';
      html += `<option value="${s.id}"${sSel}>&nbsp;&nbsp;&nbsp;&nbsp;↳ ${this._escapeHtml(s.name)}</option>`;
    }
  }
  return html;
},

async _uploadBotAvatar(botId, file) {
  const form = new FormData();
  form.append('avatar', file);
  form.append('webhookId', botId);
  try {
    const resp = await fetch('/api/upload-webhook-avatar', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${this.token}` },
      body: form
    });
    const json = await resp.json();
    if (json.url) {
      this.socket.emit('update-webhook', { id: botId, avatar_url: json.url });
      this._showToast('Bot avatar updated', 'success');
    } else {
      this._showToast(json.error || 'Upload failed', 'error');
    }
  } catch (err) {
    this._showToast('Upload failed', 'error');
  }
},

// ═══════════════════════════════════════════════════════
// LAYOUT DENSITY
// ═══════════════════════════════════════════════════════

_setupDensityPicker() {
  const picker = document.getElementById('density-picker');
  if (!picker) return;

  // Restore saved density
  const saved = localStorage.getItem('haven-density') || 'cozy';
  document.documentElement.dataset.density = saved;
  picker.querySelectorAll('.density-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.density === saved);
  });

  picker.addEventListener('click', (e) => {
    const btn = e.target.closest('.density-btn');
    if (!btn) return;
    const density = btn.dataset.density;
    document.documentElement.dataset.density = density;
    localStorage.setItem('haven-density', density);
    picker.querySelectorAll('.density-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });
},

// ── Font Size Picker ──

_setupFontSizePicker() {
  const picker = document.getElementById('font-size-picker');
  if (!picker) return;

  const saved = localStorage.getItem('haven-fontsize') || 'normal';
  document.documentElement.dataset.fontsize = saved;
  picker.querySelectorAll('[data-fontsize]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.fontsize === saved);
  });

  picker.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-fontsize]');
    if (!btn) return;
    const size = btn.dataset.fontsize;
    document.documentElement.dataset.fontsize = size;
    localStorage.setItem('haven-fontsize', size);
    picker.querySelectorAll('[data-fontsize]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });
},

// ── Emoji Reaction Size Picker ──

_setupEmojiSizePicker() {
  const picker = document.getElementById('emoji-size-picker');
  if (!picker) return;

  const saved = localStorage.getItem('haven-emojisize') || 'normal';
  document.documentElement.dataset.emojisize = saved;
  picker.querySelectorAll('[data-emojisize]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.emojisize === saved);
  });

  picker.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-emojisize]');
    if (!btn) return;
    const size = btn.dataset.emojisize;
    document.documentElement.dataset.emojisize = size;
    localStorage.setItem('haven-emojisize', size);
    picker.querySelectorAll('[data-emojisize]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });
},

// ── Debug Section ──

_setupDebugSection() {
  const cb = document.getElementById('pref-debug-local-talk-indicator');
  if (!cb) return;
  try { cb.checked = localStorage.getItem('debug_local_talk_indicator') === '1'; } catch {}
  cb.addEventListener('change', () => {
    try {
      if (cb.checked) localStorage.setItem('debug_local_talk_indicator', '1');
      else localStorage.removeItem('debug_local_talk_indicator');
    } catch {}
  });
},

// ── Image Display Mode Picker ──

_setupImageModePicker() {
  const picker = document.getElementById('image-mode-picker');
  if (!picker) return;

  // Restore saved image mode (default: thumbnail)
  const saved = localStorage.getItem('haven-image-mode') || 'thumbnail';
  this._applyImageMode(saved);
  picker.querySelectorAll('[data-image-mode]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.imageMode === saved);
  });

  picker.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-image-mode]');
    if (!btn) return;
    const mode = btn.dataset.imageMode;
    this._applyImageMode(mode);
    localStorage.setItem('haven-image-mode', mode);
    picker.querySelectorAll('[data-image-mode]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });
},

_applyImageMode(mode) {
  document.body.classList.toggle('image-mode-full', mode === 'full');
},

// ── Role Display Picker ──

_setupRoleDisplayPicker() {
  const picker = document.getElementById('role-display-picker');
  if (!picker) return;

  const saved = localStorage.getItem('haven-role-display') || 'colored-name';
  document.documentElement.dataset.roleDisplay = saved;
  picker.querySelectorAll('[data-roledisplay]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.roledisplay === saved);
  });

  picker.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-roledisplay]');
    if (!btn) return;
    const mode = btn.dataset.roledisplay;
    document.documentElement.dataset.roleDisplay = mode;
    localStorage.setItem('haven-role-display', mode);
    picker.querySelectorAll('[data-roledisplay]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    // Re-render member list to reflect the change
    if (this._updateUsers) this._updateUsers();
  });
},

// ── Toolbar Icon Style Picker ──

_setupToolbarIconPicker() {
  const picker = document.getElementById('toolbar-icon-picker');
  const slotsInput = document.getElementById('toolbar-visible-slots');
  const slotsValue = document.getElementById('toolbar-visible-slots-value');
  const orderList = document.getElementById('toolbar-order-list');
  const resetBtn = document.getElementById('toolbar-order-reset-btn');
  if (!picker) return;

  const defaultOrder = ['react', 'reply', 'quote', 'thread', 'pin', 'archive', 'edit', 'delete'];
  const actionLabels = {
    react: 'React',
    reply: 'Reply',
    quote: 'Quote',
    thread: 'Thread',
    pin: 'Pin / Unpin',
    archive: 'Protect / Unprotect',
    edit: 'Edit',
    delete: 'Delete'
  };

  const normalizeOrder = (value) => {
    const arr = Array.isArray(value) ? value : [];
    const clean = [];
    arr.forEach((k) => {
      if (defaultOrder.includes(k) && !clean.includes(k)) clean.push(k);
    });
    defaultOrder.forEach((k) => {
      if (!clean.includes(k)) clean.push(k);
    });
    return clean;
  };

  const refreshCurrentMessages = () => {
    if (this.currentChannel && this.socket?.connected) {
      this.socket.emit('get-messages', { code: this.currentChannel });
    }
  };

  const savedMode = localStorage.getItem('haven-toolbar-icons') || 'mono';
  const normalizedMode = savedMode === 'color' ? 'emoji' : savedMode;
  document.documentElement.dataset.toolbaricons = normalizedMode;
  picker.querySelectorAll('[data-toolbaricons]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.toolbaricons === normalizedMode);
  });

  let savedSlots = parseInt(localStorage.getItem('haven-toolbar-visible-slots') || '3', 10);
  if (!Number.isFinite(savedSlots)) savedSlots = 3;
  savedSlots = Math.max(1, Math.min(7, savedSlots));
  localStorage.setItem('haven-toolbar-visible-slots', String(savedSlots));
  if (slotsInput) slotsInput.value = String(savedSlots);
  if (slotsValue) slotsValue.textContent = String(savedSlots);

  let savedOrder;
  try {
    savedOrder = JSON.parse(localStorage.getItem('haven-toolbar-order') || '[]');
  } catch {
    savedOrder = [];
  }
  let currentOrder = normalizeOrder(savedOrder);
  localStorage.setItem('haven-toolbar-order', JSON.stringify(currentOrder));

  const renderOrderList = () => {
    if (!orderList) return;
    orderList.innerHTML = '';
    currentOrder.forEach((key, index) => {
      const row = document.createElement('div');
      row.className = 'toolbar-order-item';
      row.innerHTML = `
        <span class="toolbar-order-item-label">${actionLabels[key] || key}</span>
        <div class="toolbar-order-item-controls">
          <button type="button" class="toolbar-order-move" data-dir="up" data-key="${key}" ${index === 0 ? 'disabled' : ''} title="Move up">▲</button>
          <button type="button" class="toolbar-order-move" data-dir="down" data-key="${key}" ${index === currentOrder.length - 1 ? 'disabled' : ''} title="Move down">▼</button>
        </div>
      `;
      orderList.appendChild(row);
    });
  };

  renderOrderList();

  picker.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-toolbaricons]');
    if (!btn) return;
    const mode = btn.dataset.toolbaricons;
    document.documentElement.dataset.toolbaricons = mode;
    localStorage.setItem('haven-toolbar-icons', mode);
    picker.querySelectorAll('[data-toolbaricons]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    refreshCurrentMessages();
  });

  if (slotsInput) {
    slotsInput.addEventListener('input', () => {
      if (slotsValue) slotsValue.textContent = slotsInput.value;
    });
    slotsInput.addEventListener('change', () => {
      const value = Math.max(1, Math.min(7, parseInt(slotsInput.value || '3', 10) || 3));
      localStorage.setItem('haven-toolbar-visible-slots', String(value));
      if (slotsValue) slotsValue.textContent = String(value);
      refreshCurrentMessages();
    });
  }

  if (orderList) {
    orderList.addEventListener('click', (e) => {
      const btn = e.target.closest('.toolbar-order-move');
      if (!btn) return;
      const key = btn.dataset.key;
      const dir = btn.dataset.dir;
      const idx = currentOrder.indexOf(key);
      if (idx < 0) return;
      const swapWith = dir === 'up' ? idx - 1 : idx + 1;
      if (swapWith < 0 || swapWith >= currentOrder.length) return;
      const next = currentOrder.slice();
      [next[idx], next[swapWith]] = [next[swapWith], next[idx]];
      currentOrder = next;
      localStorage.setItem('haven-toolbar-order', JSON.stringify(currentOrder));
      renderOrderList();
      refreshCurrentMessages();
    });
  }

  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      currentOrder = defaultOrder.slice();
      localStorage.setItem('haven-toolbar-order', JSON.stringify(currentOrder));
      renderOrderList();
      refreshCurrentMessages();
    });
  }
},

// ── Image Lightbox ──

_setupLightbox() {
  const lb = document.getElementById('image-lightbox');
  if (!lb) return;
  // Only close when clicking the backdrop (not the image itself)
  lb.addEventListener('click', (e) => {
    if (e.target === lb) this._closeLightbox();
  });
  document.addEventListener('keydown', (e) => {
    if (lb.style.display === 'none') return;
    if (e.key === 'Escape') this._closeLightbox();
    if (e.key === 'ArrowLeft') this._lightboxNavigate(-1);
    if (e.key === 'ArrowRight') this._lightboxNavigate(1);
  });

  // Nav button clicks
  const prevBtn = document.getElementById('lightbox-prev');
  const nextBtn = document.getElementById('lightbox-next');
  if (prevBtn) prevBtn.addEventListener('click', (e) => { e.stopPropagation(); this._lightboxNavigate(-1); });
  if (nextBtn) nextBtn.addEventListener('click', (e) => { e.stopPropagation(); this._lightboxNavigate(1); });

  // Custom context menu for lightbox image (Save, Copy, Open)
  const lbImg = document.getElementById('lightbox-img');
  if (lbImg) {
    lbImg.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this._showImageContextMenu(e, lbImg.src);
    });
  }
},

_getLightboxImages() {
  // Use whichever container opened the lightbox (main feed, thread panel, DM PiP)
  const container = this._lightboxContainer || document.getElementById('messages');
  if (!container) return [];
  return Array.from(container.querySelectorAll('.chat-image')).map(img => img.src);
},

_lightboxNavigate(dir) {
  const imgs = this._getLightboxImages();
  const lbImg = document.getElementById('lightbox-img');
  if (!lbImg || imgs.length < 2) return;
  const curIdx = imgs.indexOf(lbImg.src);
  if (curIdx < 0) return;
  const newIdx = curIdx + dir;
  if (newIdx < 0 || newIdx >= imgs.length) return;
  lbImg.src = imgs[newIdx];
  this._updateLightboxNav();
},

_updateLightboxNav() {
  const imgs = this._getLightboxImages();
  const lbImg = document.getElementById('lightbox-img');
  const prevBtn = document.getElementById('lightbox-prev');
  const nextBtn = document.getElementById('lightbox-next');
  if (!lbImg || !prevBtn || !nextBtn) return;
  const curIdx = imgs.indexOf(lbImg.src);
  prevBtn.disabled = curIdx <= 0;
  nextBtn.disabled = curIdx < 0 || curIdx >= imgs.length - 1;
  // Hide nav if only one image
  const showNav = imgs.length > 1;
  prevBtn.style.display = showNav ? '' : 'none';
  nextBtn.style.display = showNav ? '' : 'none';
},

_openLightbox(src) {
  const lb = document.getElementById('image-lightbox');
  const img = document.getElementById('lightbox-img');
  if (!lb || !img) return;
  img.src = src;
  lb.style.display = 'flex';
  this._updateLightboxNav();
},

_closeLightbox() {
  const lb = document.getElementById('image-lightbox');
  if (lb) { lb.style.display = 'none'; }
  const img = document.getElementById('lightbox-img');
  if (img) { img.src = ''; }
  this._hideImageContextMenu();
},

/* ── Modal Expand / Maximize ────────────────────────── */

_setupModalExpand() {
  // Global guard: track mousedown origin so overlay click-to-close doesn't fire
  // when a resize drag ends outside the modal (cursor lands on overlay)
  let _overlayMouseDownTarget = null;
  document.addEventListener('mousedown', (e) => { _overlayMouseDownTarget = e.target; }, true);
  document.addEventListener('click', (e) => {
    // If click landed on a modal-overlay but mousedown started inside the modal, suppress close
    if (e.target.classList && e.target.classList.contains('modal-overlay') &&
        _overlayMouseDownTarget && _overlayMouseDownTarget !== e.target) {
      e.stopImmediatePropagation();
    }
  }, true); // capturing phase — fires before individual handlers

  // Auto-inject expand/maximize + close buttons into every modal.
  // Buttons live in an absolutely positioned .modal-controls group at the
  // top-right so they work for ALL modal layouts (back buttons, wrapper
  // divs, settings headers, etc) without depending on h3 internal flex.
  const _injectModalControls = () => {
    document.querySelectorAll('.modal').forEach(modal => {
      // Skip promo/centered popups — they're not regular modals
      if (modal.classList.contains('android-beta-promo') ||
          modal.classList.contains('desktop-promo') ||
          modal.classList.contains('donors-modal-box')) return;
      // Idempotent — skip already-injected
      if (modal.dataset.modalControlsInjected === '1') return;
      modal.dataset.modalControlsInjected = '1';

      // Settings/activities headers have their own close button — keep it
      // but inject the expand toggle next to it.
      const settingsClose = modal.querySelector('.settings-close-btn');

      const expandBtn = document.createElement('button');
      expandBtn.type = 'button';
      expandBtn.className = 'modal-expand-btn';
      expandBtn.title = 'Expand / Restore';
      expandBtn.textContent = '⛶';
      expandBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const isMax = modal.classList.toggle('modal-maximized');
        expandBtn.textContent = isMax ? '⊖' : '⛶';
        expandBtn.title = isMax ? 'Restore size' : 'Expand';
      });

      // When a settings-style header is present, slot the expand button
      // directly next to its close button so the two stay aligned on
      // every viewport size. Otherwise drop both controls into a floating
      // group at the top-right of the modal.
      if (settingsClose) {
        expandBtn.classList.add('modal-expand-btn-inline');
        settingsClose.parentElement.insertBefore(expandBtn, settingsClose);
      } else {
        const group = document.createElement('div');
        group.className = 'modal-controls';
        group.appendChild(expandBtn);

        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'modal-expand-btn';
        closeBtn.title = 'Close';
        closeBtn.textContent = '✕';
        closeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const overlay = modal.closest('.modal-overlay');
          if (overlay) overlay.style.display = 'none';
          if (modal.classList.contains('modal-maximized')) {
            modal.classList.remove('modal-maximized');
            expandBtn.textContent = '⛶';
            expandBtn.title = 'Expand / Restore';
          }
        });
        group.appendChild(closeBtn);
        modal.appendChild(group);
      }
    });
  };
  _injectModalControls();
  // Re-run if new modals get inserted later (some plugins/lazy templates)
  this._injectModalControls = _injectModalControls;
},

/** Show a custom image context menu (Save / Copy / Open in tab) */
_showImageContextMenu(e, src) {
  this._hideImageContextMenu();
  const menu = document.createElement('div');
  menu.id = 'image-context-menu';
  menu.className = 'image-context-menu';
  menu.innerHTML = `
    <button data-action="save">💾 Save Image</button>
    <button data-action="copy">📋 Copy Image</button>
    <button data-action="open">🔗 Open in New Tab</button>
  `;
  menu.style.left = e.clientX + 'px';
  menu.style.top = e.clientY + 'px';
  document.body.appendChild(menu);
  // Clamp to viewport
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = (window.innerWidth - rect.width - 8) + 'px';
  if (rect.bottom > window.innerHeight) menu.style.top = (window.innerHeight - rect.height - 8) + 'px';

  menu.addEventListener('click', async (ev) => {
    const action = ev.target.dataset.action;
    if (action === 'save') {
      const a = document.createElement('a');
      a.href = src;
      a.download = src.split('/').pop().split('?')[0] || 'image';
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      a.remove();
    } else if (action === 'copy') {
      try {
        // Always convert via canvas to guarantee a valid image/png blob
        const img = new Image();
        img.crossOrigin = 'anonymous';
        const loaded = new Promise((res, rej) => { img.onload = res; img.onerror = rej; });
        img.src = src;
        await loaded;
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        canvas.getContext('2d').drawImage(img, 0, 0);
        const pngBlob = await new Promise((res, rej) => {
          canvas.toBlob(b => b ? res(b) : rej(new Error('canvas.toBlob returned null')), 'image/png');
        });

        if (typeof ClipboardItem !== 'undefined' && navigator.clipboard && navigator.clipboard.write) {
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
        } else {
          // Fallback: copy data URL as text
          const reader = new FileReader();
          const dataUrl = await new Promise(r => { reader.onload = () => r(reader.result); reader.readAsDataURL(pngBlob); });
          await navigator.clipboard.writeText(dataUrl);
        }
        this._showToast('Image copied to clipboard', 'success');
      } catch (err) {
        console.error('[Haven] Copy image failed:', err);
        this._showToast('Failed to copy image', 'error');
      }
    } else if (action === 'open') {
      window.open(src, '_blank', 'noopener,noreferrer');
    }
    this._hideImageContextMenu();
  });

  // Close on click elsewhere
  const closer = (ev) => {
    if (!menu.contains(ev.target)) {
      this._hideImageContextMenu();
      document.removeEventListener('click', closer, true);
      document.removeEventListener('contextmenu', closer, true);
    }
  };
  setTimeout(() => {
    document.addEventListener('click', closer, true);
    document.addEventListener('contextmenu', closer, true);
  }, 0);
},

_hideImageContextMenu() {
  const existing = document.getElementById('image-context-menu');
  if (existing) existing.remove();
},

};
