// Files on a scheduled message (Send later, #5638). Files picked in the
// modal, or waiting in the message box when it opened, wait as chips and
// are uploaded when Schedule is pressed. Their lines then go into the
// message the same way a live send writes them, so the server keeps the
// files until the message goes out.

export default {

// The modal's attach row: hidden where this channel takes no uploads.
_scheduleFilesReset(carryComposer) {
  const ch = this.channels?.find(c => c.code === this.currentChannel);
  const allowed = !!ch && (ch.media_enabled !== 0 || !!this.user?.isAdmin);
  this._scheduleFiles = allowed && carryComposer ? (this._composerAttachments?.() || []).slice() : [];
  this._scheduleCarried = this._scheduleFiles.slice();
  const row = document.getElementById('schedule-attach-row');
  if (row) row.style.display = allowed ? '' : 'none';
  this._wireScheduleFiles();
  this._renderScheduleFiles();
},

_wireScheduleFiles() {
  if (this._scheduleFilesWired) return;
  this._scheduleFilesWired = true;
  const input = document.getElementById('schedule-file-input');
  document.getElementById('schedule-attach-btn')?.addEventListener('click', () => input?.click());
  input?.addEventListener('change', () => {
    this._addScheduleFiles(input.files);
    input.value = '';
  });
  const text = document.getElementById('schedule-text');
  text?.addEventListener('paste', (e) => {
    const files = e.clipboardData?.files;
    if (files && files.length && document.getElementById('schedule-attach-row')?.style.display !== 'none') {
      e.preventDefault();
      this._addScheduleFiles(files);
    }
  });
},

_addScheduleFiles(files) {
  const max = this._maxAttachments();
  for (const file of Array.from(files || [])) {
    if (this._scheduleFiles.length >= max) {
      this._showToast(t('media.max_attachments_n', { n: max }), 'error');
      break;
    }
    this._scheduleFiles.push(file);
  }
  this._renderScheduleFiles();
},

_renderScheduleFiles() {
  const list = document.getElementById('schedule-file-list');
  if (!list) return;
  list.innerHTML = '';
  for (const file of this._scheduleFiles || []) {
    const chip = document.createElement('span');
    chip.className = 'schedule-file-chip';
    const isImage = file.type && file.type.startsWith('image/');
    chip.textContent = `${isImage ? '🖼️' : '📄'} ${file.name || 'file'} (${this._formatFileSize(file.size)})`;
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'schedule-file-remove';
    rm.textContent = '×';
    rm.title = t('modals.schedule.remove_file');
    rm.addEventListener('click', () => {
      this._scheduleFiles = this._scheduleFiles.filter(f => f !== file);
      this._renderScheduleFiles();
    });
    chip.appendChild(rm);
    list.appendChild(chip);
  }
},

// Upload the waiting files and return their message lines, or null when one
// failed (already reported), so nothing is scheduled without its files.
async _uploadScheduleFiles() {
  const lines = [];
  for (const file of this._scheduleFiles || []) {
    const up = await this._mediaUploadLine(file, { isDm: false });
    if (!up) return null;
    lines.push(up.line);
  }
  return lines;
},

// After a successful schedule: files that came from the message box leave
// it, the same as the text does.
_scheduleFilesSent() {
  const carried = new Set(this._scheduleCarried || []);
  const sent = (this._scheduleFiles || []).filter(f => carried.has(f));
  if (sent.length) {
    this._imageQueue = (this._imageQueue || []).filter(f => !sent.includes(f));
    this._fileQueue = (this._fileQueue || []).filter(f => !sent.includes(f));
    this._renderImageQueue();
  }
  this._scheduleFiles = [];
  this._scheduleCarried = [];
  this._renderScheduleFiles();
},

// The waiting list shows a file by its name, not its upload line.
_schedulePreviewText(content) {
  return String(content || '').split('\n').map(line => {
    const l = line.trim();
    const file = l.match(/^(?:spoiler-img:)?\[file:([^\]\n]+)\]\(\/uploads\/[^)]+\)$/);
    if (file) return `📄 ${file[1]}`;
    if (/^(?:spoiler-img:)?\/uploads\/\S+$/.test(l)) return `🖼️ ${l.split('/').pop()}`;
    return line;
  }).join('\n');
},

};
