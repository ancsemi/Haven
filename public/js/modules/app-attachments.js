// Files waiting to be sent: the picture and file queues for the message box,
// the pop-out DM and threads, spoiler toggles, and attachment tags.

export default {

// How many files one message may carry, images and other files together. An
// admin setting since #5561 (Uploads & Limits); the fixed five it replaces was
// too few for people dumping a folder of tools into a channel in one go.
_maxAttachments() {
  const n = parseInt(this.serverSettings?.max_attachments);
  return Number.isFinite(n) ? Math.max(1, Math.min(50, n)) : 10;
},

_composerAttachmentCount() {
  return (this._imageQueue?.length || 0) + (this._fileQueue?.length || 0);
},

// Route a batch of dropped, pasted or picked files into the main composer
// queues: images preview as thumbnails, anything else as a chip. Stops at the
// cap with one toast rather than one per leftover file. (#5561)
_queueComposerFiles(files) {
  const list = Array.from(files || []).filter(Boolean);
  if (!list.length) return;
  // One toast for the whole batch when there is nowhere to send it, rather
  // than one per file from the queue functions below.
  if (!this.currentChannel) return this._showToast(t('media.select_channel_first'), 'error');
  const ch = this.channels.find(c => c.code === this.currentChannel);
  if (ch && ch.media_enabled === 0) return this._showToast(t('media.uploads_disabled'), 'error');
  const max = this._maxAttachments();
  for (const file of list) {
    if (this._composerAttachmentCount() >= max) {
      this._showToast(t('media.max_attachments_n', { n: max }), 'error');
      break;
    }
    if (file.type && file.type.startsWith('image/')) this._queueImage(file);
    else this._queueGeneralFile(file);
  }
},

// Same for the thread composer, which keeps one mixed queue.
_queueThreadFiles(files) {
  const list = Array.from(files || []).filter(Boolean);
  if (!list.length) return;
  const max = this._maxAttachments();
  for (const file of list) {
    if ((this._threadPending?.length || 0) >= max) {
      this._showToast(t('media.max_attachments_n', { n: max }), 'error');
      break;
    }
    this._queueThreadFile(file);
  }
},

// ── Image Queue (paste/drop → preview → send on Enter) ──

_queueImage(file) {
  if (!file || !file.type.startsWith('image/')) return;
  const _maxMb = this._uploadCapMb();
  if (file.size > _maxMb * 1024 * 1024) {
    return this._showToast(t('media.image_too_large', { maxMb: _maxMb }), 'error');
  }
  if (!this._imageQueue) this._imageQueue = [];
  if (this._composerAttachmentCount() >= this._maxAttachments()) {
    return this._showToast(t('media.max_attachments_n', { n: this._maxAttachments() }), 'error');
  }
  this._imageQueue.push(file);
  this._activeAttachment = file;   // newest attachment is the one the tag bar edits
  this._renderImageQueue();
  document.getElementById('message-input').focus();
},

_renderImageQueue() {
  const bar = document.getElementById('image-queue-bar');
  if (!bar) return;
  const hasImages = this._imageQueue && this._imageQueue.length > 0;
  const hasFiles  = this._fileQueue  && this._fileQueue.length  > 0;
  if (!hasImages && !hasFiles) {
    bar.style.display = 'none';
    bar.innerHTML = '';
    this._renderTagBar();
    return;
  }
  bar.style.display = 'flex';
  bar.innerHTML = '';
  if (hasImages) {
    this._imageQueue.forEach((file, idx) => {
      const thumb = document.createElement('div');
      thumb.className = 'image-queue-thumb' + (file._spoiler ? ' is-spoiler' : '')
        + (file === this._activeAttachment ? ' is-active' : '');
      if (file._tags && file._tags.length) thumb.classList.add('has-tags');
      const img = document.createElement('img');
      img.src = URL.createObjectURL(file);
      img.alt = file.name;
      img.onload = () => URL.revokeObjectURL(img.src);
      // Clicking a queued attachment makes it the one the tag bar edits (#tagging).
      thumb.addEventListener('click', () => this._selectAttachment(file));
      const removeBtn = document.createElement('button');
      removeBtn.className = 'image-queue-remove';
      removeBtn.title = t('media.remove');
      removeBtn.textContent = '×';
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._imageQueue.splice(idx, 1);
        this._renderImageQueue();
      });
      thumb.appendChild(img);
      thumb.appendChild(this._makeSpoilerToggle(file));
      thumb.appendChild(removeBtn);
      bar.appendChild(thumb);
    });
  }
  if (hasFiles) {
    this._fileQueue.forEach((file, idx) => {
      const chip = document.createElement('div');
      chip.className = 'file-queue-chip' + (file === this._activeAttachment ? ' is-active' : '');
      if (file._tags && file._tags.length) chip.classList.add('has-tags');
      chip.title = file.name + ' — ' + this._formatFileSize(file.size);
      const icon = document.createElement('span');
      icon.className = 'file-queue-chip-icon';
      icon.textContent = '📎';
      const name = document.createElement('span');
      name.className = 'file-queue-chip-name';
      name.textContent = file.name;
      const size = document.createElement('span');
      size.className = 'file-queue-chip-size';
      size.textContent = this._formatFileSize(file.size);
      chip.addEventListener('click', () => this._selectAttachment(file));
      const removeBtn = document.createElement('button');
      removeBtn.className = 'image-queue-remove';
      removeBtn.title = t('media.remove');
      removeBtn.textContent = '×';
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._fileQueue.splice(idx, 1);
        this._renderImageQueue();
      });
      chip.appendChild(icon);
      chip.appendChild(name);
      chip.appendChild(size);
      chip.appendChild(removeBtn);
      bar.appendChild(chip);
    });
  }
  // Add a "clear all" button if there's more than one queued attachment in total
  const totalQueued = (hasImages ? this._imageQueue.length : 0) + (hasFiles ? this._fileQueue.length : 0);
  if (totalQueued > 1) {
    const clearAll = document.createElement('button');
    clearAll.className = 'image-queue-clear-all';
    clearAll.textContent = t('media.clear_all');
    clearAll.addEventListener('click', () => {
      this._clearImageQueue();
      this._clearFileQueue();
    });
    bar.appendChild(clearAll);
  }
  this._renderTagBar();
},

// ── Attachment tagging (composer) — (#tagging) ──────────────────────────────
// A row below the image-queue bar tags the *active* attachment. Tags ride on
// the File object (`_tags`), same trick as `_spoiler`, so the flush loop can
// read them without extra state. Applying an existing tag is open to any
// uploader; minting a new one needs manage_tags and is committed on send.

// Admin-configurable (server_settings), clamped to the same hard ceilings the
// server enforces in src/uploadTags.js; falls back to the defaults.
_maxTagsPerAttachment() {
  const n = parseInt(this.serverSettings?.max_tags_per_attachment, 10);
  return Number.isFinite(n) ? Math.max(1, Math.min(10, n)) : 3;
},
_maxTagLen() {
  const n = parseInt(this.serverSettings?.max_tag_len, 10);
  return Number.isFinite(n) ? Math.max(1, Math.min(50, n)) : 20;
},

// Every queued attachment, images first, in the order they appear in the bar.
_composerAttachments() {
  return [...(this._imageQueue || []), ...(this._fileQueue || [])];
},

// Tagging is for plaintext channel uploads: DMs are E2E (the server never sees
// their bytes, so it can't index a tag). Forums take it too: their topic tags
// live in the New Post window, not in this message box (#5682).
_tagBarEligible() {
  const ch = this.channels?.find(c => c.code === this.currentChannel);
  return !!(ch && !ch.is_dm);
},

// Point the tag bar at a different queued attachment.
_selectAttachment(file) {
  if (!file) return;
  this._activeAttachment = file;
  this._closeTagPopup();
  this._renderImageQueue();   // repaints active highlight + the tag bar
},

_renderTagBar() {
  const bar = document.getElementById('tag-queue-bar');
  if (!bar) return;
  const items = this._composerAttachments();
  // Keep the active pointer valid as the queue changes underneath it.
  if (!items.includes(this._activeAttachment)) this._activeAttachment = items[0] || null;

  if (!items.length || !this._tagBarEligible()) {
    bar.style.display = 'none';
    this._closeTagPopup();
    this._renderFrequentTags();
    return;
  }
  // Someone who cannot make tags has nothing to pick until one exists, so on
  // a server with no tags the bar stays out of their way. Asked again every
  // so often, since a tag can turn up while they are connected.
  if (!this._canManageTags?.() && this._uploadTagsExist !== true) {
    bar.style.display = 'none';
    this._closeTagPopup();
    this._renderFrequentTags();
    const now = Date.now();
    if (this.socket && now - (this._uploadTagsProbedAt || 0) > 15000) {
      this._uploadTagsProbedAt = now;
      this.socket.emit('search-upload-tags', { query: '' }, (res) => {
        if (!res || res.error || !(res.tags || []).length) return;
        this._uploadTagsExist = true;
        this._renderTagBar();
      });
    }
    return;
  }
  bar.style.display = 'flex';
  this._ensureTagComposerBound();

  const chips = document.getElementById('tag-queue-chips');
  const file = this._activeAttachment;
  const tags = (file && file._tags) || [];
  if (chips) {
    chips.innerHTML = '';
    tags.forEach(name => {
      const chip = document.createElement('span');
      chip.className = 'tag-chip';
      const label = document.createElement('span');
      label.className = 'tag-chip-label';
      label.textContent = name;
      const rm = document.createElement('button');
      rm.className = 'tag-chip-remove';
      rm.type = 'button';
      rm.title = t('media.remove');
      rm.textContent = '×';
      rm.addEventListener('click', (e) => { e.stopPropagation(); this._removeTagFromActive(name); });
      chip.appendChild(label);
      chip.appendChild(rm);
      chips.appendChild(chip);
    });
  }
  // Disable "Add tag" once this attachment hit the cap.
  const addBtn = document.getElementById('tag-add-btn');
  if (addBtn) {
    const full = tags.length >= this._maxTagsPerAttachment();
    addBtn.disabled = full;
    addBtn.title = full ? t('tags.limit_reached', { n: this._maxTagsPerAttachment() }) : t('tags.add_tag');
  }
  this._renderFrequentTags();
},

// Wire the Add-tag button, the popup input and the outside-click closer exactly
// once — the tag bar is re-rendered constantly, so per-render binding would
// stack listeners.
_ensureTagComposerBound() {
  if (this._tagComposerBound) return;
  this._tagComposerBound = true;
  const addBtn = document.getElementById('tag-add-btn');
  const input = document.getElementById('tag-popup-input');
  addBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    const popup = document.getElementById('tag-popup');
    if (popup && popup.style.display !== 'none') this._closeTagPopup();
    else this._openTagPopup();
  });
  input?.addEventListener('input', () => {
    clearTimeout(this._tagSearchTimer);
    const q = input.value;
    this._tagSearchTimer = setTimeout(() => this._tagPopupSearch(q), 250);
  });
  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); this._closeTagPopup(); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      // Enter applies the first offered row (an existing match, or the new-tag
      // row when the user may create one).
      const first = document.querySelector('#tag-popup-list .tag-popup-item');
      if (first) first.click();
    }
  });
  // Clicking anywhere outside the bar dismisses the popup without closing the
  // composer.
  this._tagOutsideClick = (e) => {
    const bar = document.getElementById('tag-queue-bar');
    if (bar && !bar.contains(e.target)) this._closeTagPopup();
  };
  document.addEventListener('click', this._tagOutsideClick, true);
},

_openTagPopup() {
  if (!this._activeAttachment) return;
  const tags = this._activeAttachment._tags || [];
  if (tags.length >= this._maxTagsPerAttachment()) {
    return this._showToast(t('tags.limit_reached', { n: this._maxTagsPerAttachment() }), 'error');
  }
  const popup = document.getElementById('tag-popup');
  const input = document.getElementById('tag-popup-input');
  if (!popup || !input) return;
  popup.style.display = 'block';
  input.value = '';
  input.maxLength = this._maxTagLen();
  this._tagPopupSearch('');   // show a first page of existing tags
  input.focus();
},

_closeTagPopup() {
  const popup = document.getElementById('tag-popup');
  if (popup) popup.style.display = 'none';
  clearTimeout(this._tagSearchTimer);
},

// Client mirror of src/uploadTags.normalizeTagName — same rules so the picker
// rejects what the server would. Returns { name, norm } or null.
_normalizeTag(raw) {
  if (typeof raw !== 'string') return null;
  const name = raw.trim().replace(/\s+/g, ' ');
  if (!name || name.length > this._maxTagLen()) return null;
  if (!/^[\p{L}\p{N} _-]+$/u.test(name)) return null;
  return { name, norm: name.toLocaleLowerCase() };
},

// Debounced server lookup for the popup. Guards against a stale response
// overwriting the list after the user has typed on.
_tagPopupSearch(query) {
  const input = document.getElementById('tag-popup-input');
  if (!input || !this.socket) return;
  const q = query;
  this.socket.emit('search-upload-tags', { query: q }, (res) => {
    if (input.value !== q) return;                 // user moved on
    if (res && res.error === 'rate_limited') return;
    this._renderTagPopupList(q, (res && res.tags) || []);
  });
},

_renderTagPopupList(query, results) {
  const list = document.getElementById('tag-popup-list');
  if (!list) return;
  list.innerHTML = '';
  const active = this._activeAttachment;
  const applied = new Set(((active && active._tags) || []).map(x => x.toLocaleLowerCase()));
  const norm = this._normalizeTag(query);

  // Existing tags that aren't already on this attachment.
  const rows = (results || []).filter(tag => !applied.has(String(tag.name).toLocaleLowerCase()));
  rows.forEach(tag => {
    const item = document.createElement('button');
    item.className = 'tag-popup-item';
    item.type = 'button';
    item.textContent = tag.name;
    item.addEventListener('click', () => this._applyTagToActive(tag.name));
    list.appendChild(item);
  });

  // Offer to mint a new tag only to manage_tags holders, only when the typed
  // name is valid and isn't an exact existing match already shown/applied.
  const exact = norm && (
    applied.has(norm.norm) ||
    (results || []).some(tag => String(tag.name).toLocaleLowerCase() === norm.norm)
  );
  if (norm && !exact && this._hasPerm && this._hasPerm('manage_tags')) {
    const create = document.createElement('button');
    create.className = 'tag-popup-item tag-popup-create';
    create.type = 'button';
    create.textContent = t('tags.add_new', { name: norm.name });
    create.addEventListener('click', () => this._applyTagToActive(norm.name));
    list.appendChild(create);
  }

  if (!list.children.length) {
    const empty = document.createElement('div');
    empty.className = 'tag-popup-empty';
    empty.textContent = norm ? t('tags.none_found') : t('tags.none_yet');
    list.appendChild(empty);
  }
},

_applyTagToActive(rawName) {
  const file = this._activeAttachment;
  if (!file) return;
  const norm = this._normalizeTag(rawName);
  if (!norm) return this._showToast(t('tags.invalid'), 'error');
  if (!file._tags) file._tags = [];
  if (file._tags.some(x => x.toLocaleLowerCase() === norm.norm)) { this._closeTagPopup(); return; }
  if (file._tags.length >= this._maxTagsPerAttachment()) {
    return this._showToast(t('tags.limit_reached', { n: this._maxTagsPerAttachment() }), 'error');
  }
  file._tags.push(norm.name);
  this._closeTagPopup();
  this._renderImageQueue();
},

_removeTagFromActive(name) {
  const file = this._activeAttachment;
  if (!file || !file._tags) return;
  file._tags = file._tags.filter(x => x !== name);
  this._renderImageQueue();
},

// ── Frequent tags ──────────────────────────────────────────────────────────
// A quick-access row of the tags used most on this browser's uploads, saved to
// localStorage (never the DB, since it is a per-person convenience). Most used
// first; recorded on send. Clicking one applies it to the active attachment.
_FREQ_TAGS_KEY: 'havenFrequentTags',

_getFrequentTags() {
  try {
    const raw = JSON.parse(localStorage.getItem(this._FREQ_TAGS_KEY) || '[]');
    if (!Array.isArray(raw)) return [];
    return raw
      .filter(e => e && typeof e.name === 'string')
      .sort((a, b) => (b.count || 0) - (a.count || 0) || (b.ts || 0) - (a.ts || 0));
  } catch { return []; }
},

_saveFrequentTags(list) {
  try { localStorage.setItem(this._FREQ_TAGS_KEY, JSON.stringify(list.slice(0, 50))); } catch { /* storage full/blocked */ }
},

// Bump the use count for tags that just went out on an upload. Keyed
// case-insensitively; display casing follows the latest use.
_recordFrequentTags(names) {
  if (!Array.isArray(names) || !names.length) return;
  const list = this._getFrequentTags();
  const now = Date.now();
  for (const raw of names) {
    const norm = this._normalizeTag(raw);
    if (!norm) continue;
    const existing = list.find(e => e.name.toLocaleLowerCase() === norm.norm);
    if (existing) { existing.count = (existing.count || 0) + 1; existing.ts = now; existing.name = norm.name; }
    else list.push({ name: norm.name, count: 1, ts: now });
  }
  this._saveFrequentTags(list);
},

_removeFrequentTag(name) {
  const norm = this._normalizeTag(name);
  if (!norm) return;
  this._saveFrequentTags(this._getFrequentTags().filter(e => e.name.toLocaleLowerCase() !== norm.norm));
},

_renderFrequentTags() {
  const bar = document.getElementById('tag-frequent-bar');
  if (!bar) return;
  const file = this._activeAttachment;
  const barVisible = document.getElementById('tag-queue-bar')?.style.display !== 'none';
  const applied = new Set(((file && file._tags) || []).map(x => x.toLocaleLowerCase()));
  const full = ((file && file._tags) || []).length >= this._maxTagsPerAttachment();
  const freq = (file && barVisible && !full)
    ? this._getFrequentTags().filter(e => !applied.has(e.name.toLocaleLowerCase())).slice(0, 10)
    : [];
  if (!freq.length) { bar.style.display = 'none'; bar.innerHTML = ''; return; }
  bar.innerHTML = '';
  const label = document.createElement('span');
  label.className = 'tag-frequent-label';
  label.textContent = t('tags.frequent');
  bar.appendChild(label);
  freq.forEach(e => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'tag-frequent-chip';
    chip.textContent = e.name;
    chip.addEventListener('click', (ev) => { ev.stopPropagation(); this._applyFrequentTag(e.name); });
    bar.appendChild(chip);
  });
  bar.style.display = 'flex';
},

// Because the frequent list lives in storage it can outlive the tag itself. So
// verify the tag still exists in the vocabulary before applying it: if it was
// deleted, tell the user, drop it from storage, and refresh the row instead of
// applying a phantom tag the server would silently ignore.
_applyFrequentTag(name) {
  if (!this._activeAttachment || !this.socket) return;
  const norm = this._normalizeTag(name);
  if (!norm) { this._removeFrequentTag(name); this._renderFrequentTags(); return; }
  this.socket.emit('search-upload-tags', { query: norm.name }, (res) => {
    const exists = ((res && res.tags) || []).some(tg => String(tg.name).toLocaleLowerCase() === norm.norm);
    if (!exists) {
      this._showToast(t('tags.deleted_removed', { name: norm.name }), 'error');
      this._removeFrequentTag(norm.name);
      this._renderFrequentTags();
      return;
    }
    this._applyTagToActive(norm.name);
  });
},

_clearImageQueue() {
  this._imageQueue = [];
  this._renderImageQueue();
},

// Build the little eye toggle that lets the sender mark a queued image as a
// spoiler. The choice rides along on the File object (`_spoiler`) so the flush
// loop can read it without threading extra state through the queue arrays.
_makeSpoilerToggle(file, isPip = false) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'image-queue-spoiler';
  const sync = () => {
    const on = !!file._spoiler;
    // Open eye when the image will send normally; closed (slashed) eye once
    // it's marked as a spoiler.
    btn.innerHTML = this._eyeIcon(on, 12);
    btn.title = t(on ? 'app.messages.spoiler_on' : 'app.messages.mark_spoiler');
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  };
  sync();
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    file._spoiler = !file._spoiler;
    const thumb = btn.closest('.image-queue-thumb');
    if (thumb) thumb.classList.toggle('is-spoiler', !!file._spoiler);
    sync();
  });
  return btn;
},

async _flushImageQueue(bundled = false, personaPrefix = '') {
  if (!this._imageQueue || this._imageQueue.length === 0) return;
  // A DM that can't be encrypted asks first; backing out keeps the queue.
  if (!(await this._dmSendGate(this.currentChannel))) return;
  const files = [...this._imageQueue];
  this._clearImageQueue();
  this._uploadsCancelled = false;
  for (const file of files) {
    await this._uploadImage(file, undefined, bundled, personaPrefix);
    if (this._uploadsCancelled) break;   // × on the progress bar stops the batch
  }
},

// ── General file queue (non-image attachments) — (#5417) ──
// Mirrors _imageQueue so non-image attachments get a remove-able preview
// chip in the same bar instead of uploading instantly on selection.
_queueGeneralFile(file) {
  if (!file) return;
  const code = this.currentChannel;
  if (!code) return this._showToast(t('media.select_channel_first'), 'error');
  const _ch = this.channels.find(c => c.code === code);
  if (_ch && _ch.media_enabled === 0) {
    return this._showToast(t('media.uploads_disabled'), 'error');
  }
  const maxMb = this._uploadCapMb();
  if (file.size > maxMb * 1024 * 1024) {
    return this._showToast(t('media.file_too_large', { maxMb }), 'error');
  }
  if (!this._fileQueue) this._fileQueue = [];
  if (this._composerAttachmentCount() >= this._maxAttachments()) {
    return this._showToast(t('media.max_attachments_n', { n: this._maxAttachments() }), 'error');
  }
  this._fileQueue.push(file);
  this._activeAttachment = file;   // newest attachment is the one the tag bar edits
  this._renderImageQueue();
  document.getElementById('message-input')?.focus();
},

_clearFileQueue() {
  this._fileQueue = [];
  this._renderImageQueue();
},

async _flushFileQueue() {
  if (!this._fileQueue || this._fileQueue.length === 0) return;
  if (!(await this._dmSendGate(this.currentChannel))) return;
  const files = [...this._fileQueue];
  this._clearFileQueue();
  for (const file of files) {
    this._uploadGeneralFile(file);
  }
},

// ── PiP DM Image Queue (#5324) ──────────────────────────

_queueImageForPiP(file, targetCode) {
  if (!file || !file.type.startsWith('image/')) return;
  const _maxMb = this._uploadCapMb();
  if (file.size > _maxMb * 1024 * 1024) {
    return this._showToast(t('media.image_too_large', { maxMb: _maxMb }), 'error');
  }
  if (!this._pipImageQueue) this._pipImageQueue = [];
  if (!this._pipImageQueueTarget) this._pipImageQueueTarget = targetCode;
  if (this._pipImageQueue.length >= this._maxAttachments()) {
    return this._showToast(t('media.max_attachments_n', { n: this._maxAttachments() }), 'error');
  }
  this._pipImageQueue.push(file);
  this._pipImageQueueTarget = targetCode;
  this._renderPiPImageQueue();
  document.getElementById('dm-pip-input')?.focus();
},

_renderPiPImageQueue() {
  const bar = document.getElementById('dm-pip-image-queue-bar');
  if (!bar) return;
  if (!this._pipImageQueue || this._pipImageQueue.length === 0) {
    bar.style.display = 'none';
    bar.innerHTML = '';
    return;
  }
  bar.style.display = 'flex';
  bar.innerHTML = '';
  this._pipImageQueue.forEach((file, idx) => {
    const thumb = document.createElement('div');
    thumb.className = 'image-queue-thumb' + (file._spoiler ? ' is-spoiler' : '');
    const img = document.createElement('img');
    img.src = URL.createObjectURL(file);
    img.alt = file.name;
    img.onload = () => URL.revokeObjectURL(img.src);
    const removeBtn = document.createElement('button');
    removeBtn.className = 'image-queue-remove';
    removeBtn.title = t('media.remove');
    removeBtn.textContent = '×';
    removeBtn.addEventListener('click', () => {
      this._pipImageQueue.splice(idx, 1);
      this._renderPiPImageQueue();
    });
    thumb.appendChild(img);
    thumb.appendChild(this._makeSpoilerToggle(file, true));
    thumb.appendChild(removeBtn);
    bar.appendChild(thumb);
  });
  if (this._pipImageQueue.length > 1) {
    const clearAll = document.createElement('button');
    clearAll.className = 'image-queue-clear-all';
    clearAll.textContent = t('media.clear_all');
    clearAll.addEventListener('click', () => {
      this._pipImageQueue = [];
      this._renderPiPImageQueue();
    });
    bar.appendChild(clearAll);
  }
},

async _flushPiPImageQueue(bundled = false) {
  if (!this._pipImageQueue || this._pipImageQueue.length === 0) return;
  if (!(await this._dmSendGate(this._pipImageQueueTarget))) return;
  const files = [...this._pipImageQueue];
  const target = this._pipImageQueueTarget;
  this._pipImageQueue = [];
  this._pipImageQueueTarget = null;
  this._renderPiPImageQueue();
  this._uploadsCancelled = false;
  for (const file of files) {
    await this._uploadImage(file, target, bundled);
    if (this._uploadsCancelled) break;
  }
},

// ── Thread attachment queue (#thread-paste-instant) ──────────────────
// Pasting or dropping a file into a thread used to upload and post it
// immediately, so an accidental Ctrl+V dumped an image into the thread with
// no chance to cancel. Hold attachments here instead and flush them only when
// the reply is actually sent, matching the main and DM composers.
_queueThreadFile(file) {
  if (!file) return;
  const _maxMb = this._uploadCapMb();
  if (file.size > _maxMb * 1024 * 1024) {
    return this._showToast(t('media.file_too_large', { maxMb: _maxMb }), 'error');
  }
  if (!this._threadPending) this._threadPending = [];
  if (this._threadPending.length >= this._maxAttachments()) {
    return this._showToast(t('media.max_attachments_n', { n: this._maxAttachments() }), 'error');
  }
  this._threadPending.push(file);
  this._renderThreadPending();
  document.getElementById('thread-input')?.focus();
},

_renderThreadPending() {
  const bar = document.getElementById('thread-image-queue-bar');
  if (!bar) return;
  if (!this._threadPending || this._threadPending.length === 0) {
    bar.style.display = 'none';
    bar.innerHTML = '';
    return;
  }
  bar.style.display = 'flex';
  bar.innerHTML = '';
  this._threadPending.forEach((file, idx) => {
    const isImage = file.type && file.type.startsWith('image/');
    const thumb = document.createElement('div');
    thumb.className = 'image-queue-thumb' + (isImage ? '' : ' is-file');
    if (isImage) {
      const img = document.createElement('img');
      img.src = URL.createObjectURL(file);
      img.alt = file.name;
      img.onload = () => URL.revokeObjectURL(img.src);
      thumb.appendChild(img);
    } else {
      const label = document.createElement('span');
      label.className = 'image-queue-filename';
      label.textContent = file.name || 'file';
      thumb.appendChild(label);
    }
    const removeBtn = document.createElement('button');
    removeBtn.className = 'image-queue-remove';
    removeBtn.title = t('media.remove');
    removeBtn.textContent = '×';
    removeBtn.addEventListener('click', () => {
      this._threadPending.splice(idx, 1);
      this._renderThreadPending();
    });
    thumb.appendChild(removeBtn);
    bar.appendChild(thumb);
  });
  if (this._threadPending.length > 1) {
    const clearAll = document.createElement('button');
    clearAll.className = 'image-queue-clear-all';
    clearAll.textContent = t('media.clear_all');
    clearAll.addEventListener('click', () => {
      this._threadPending = [];
      this._renderThreadPending();
    });
    bar.appendChild(clearAll);
  }
},

// Upload each held attachment and post it as a thread reply. Runs from
// _sendThreadMessage after the text so the ordering feels natural.
async _flushThreadPending(parentId) {
  if (!this._threadPending || this._threadPending.length === 0) return;
  if (!parentId) return;
  const files = [...this._threadPending];
  this._threadPending = [];
  this._renderThreadPending();
  this._uploadsCancelled = false;
  for (const file of files) {
    try {
      const formData = new FormData();
      const threadCh = this.channels.find(c => c.code === this.currentChannel);
      formData.append('scope', threadCh && threadCh.is_dm ? 'dm' : 'channel');
      formData.append('file', file);
      const data = await this._uploadWithProgress('/api/upload-file', formData);
      if (!data || data.error) { this._showToast(data?.error || t('media.upload_failed'), 'error'); continue; }
      let content;
      if (data.isImage) {
        content = data.url;
      } else {
        const sizeStr = this._formatFileSize(data.fileSize);
        content = `[file:${data.originalName}](${data.url}|${sizeStr})`;
      }
      this.socket.emit('send-thread-message', { parentId, content });
    } catch (err) {
      if (err?.aborted) break;
      this._showToast(err.message || t('media.upload_failed'), 'error');
    }
  }
},

};
