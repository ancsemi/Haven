// The message box: typing, autocomplete keys, the send button and its
// right-click Send Later, emoji picker, polls, the formatting guide, voice
// messages, scheduled messages, burn-after-read and the /time picker.

export default {

_bindComposer() {
  const msgInput = document.getElementById('message-input');

  // A Discord emote whose picture cannot be fetched (bridge off, emote deleted,
  // offline) shows its :name: instead of a broken image. Error events do not
  // bubble, so this listens in the capture phase.
  document.addEventListener('error', (e) => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement) || !img.classList.contains('discord-emote')) return;
    img.replaceWith(document.createTextNode(img.alt || ''));
  }, true);

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
      if (e.key === 'Enter' || e.key === 'Tab') {
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

    // If channel dropdown is visible, hijack arrow keys and enter
    const channelDd = document.getElementById('channel-dropdown');
    if (channelDd && channelDd.style.display !== 'none') {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        this._navigateChannelDropdown(e.key === 'ArrowDown' ? 1 : -1);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        const active = channelDd.querySelector('.mention-item.active');
        if (active) { e.preventDefault(); active.click(); return; }
      }
      if (e.key === 'Escape') { this._hideChannelDropdown(); return; }
    }

    // If persona dropdown is visible, hijack arrow keys and enter (#5349)
    const personaDd = document.getElementById('persona-dropdown');
    if (personaDd && personaDd.style.display !== 'none') {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        this._navigatePersonaDropdown(e.key === 'ArrowDown' ? 1 : -1);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        const active = personaDd.querySelector('.mention-item.active');
        if (active) { e.preventDefault(); active.click(); return; }
      }
      if (e.key === 'Escape') { this._hidePersonaDropdown(); return; }
    }

    // Ferry target dropdown takes the same keys as the persona one above.
    const ferryDd = document.getElementById('ferry-dropdown');
    if (ferryDd && ferryDd.style.display !== 'none') {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        this._navigateFerryDropdown(e.key === 'ArrowDown' ? 1 : -1);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        const active = ferryDd.querySelector('.mention-item.active');
        if (active) { e.preventDefault(); active.click(); return; }
      }
      if (e.key === 'Escape') { this._hideFerryDropdown(); return; }
    }

    // Ctrl + Enter opens scheduled send modal
    // Just Enter sends the message
    if (e.key === 'Enter' && !e.shiftKey) {
      if (e.ctrlKey) {
        this._openScheduleModal();
      } else {
        e.preventDefault();
        this._sendMessage();
      }
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

    // Markdown Formatting shortcuts
    if (this._handleMarkdownShortcuts(msgInput, e)) {
      e.preventDefault();
      return;
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
    // Check for #channel trigger
    this._checkChannelTrigger();
    // Check for :emoji autocomplete trigger
    this._checkEmojiTrigger();
    // Check for /command trigger
    this._checkSlashTrigger();
    // Check for >>persona trigger (#86, #5349)
    this._checkPersonaTrigger();
    // Check for =>Discord ferry target trigger
    this._checkFerryTrigger();
  });

  // insert a markdown link when a link is pasted over selected text
  msgInput.addEventListener('paste', (event) => {
    if (this._handleMarkdownLinkPaste(msgInput, event)) {
      event.preventDefault();
    }
  });

  document.getElementById('send-btn').addEventListener('click', () => this._sendMessage());
  // Right-click on Send: send later (#5638). /schedule does the same.
  document.getElementById('send-btn').addEventListener('contextmenu', (e) => {
    e.preventDefault();
    this._openScheduleModal();
  });
  document.getElementById('schedule-cancel')?.addEventListener('click', () => { document.getElementById('schedule-modal').style.display = 'none'; });
  document.getElementById('schedule-save')?.addEventListener('click', () => this._submitSchedule());
  document.getElementById('schedule-modal')?.addEventListener('click', (e) => { if (e.target.id === 'schedule-modal') e.target.style.display = 'none'; });

  const sendLaterText = document.getElementById('schedule-text');
  sendLaterText.addEventListener('keydown', (e) => {
    // Markdown Formatting shortcuts
    if (this._handleMarkdownShortcuts(sendLaterText, e)) {
      e.preventDefault();
    }
  });
  sendLaterText.addEventListener('paste', (e) => {
    // insert a markdown link when a link is pasted over selected text
    if (this._handleMarkdownLinkPaste(sendLaterText, e)) {
      e.preventDefault();
    }
  });
},

_bindComposerPickers() {
  // Emoji picker toggle
  document.getElementById('emoji-btn').addEventListener('click', () => {
    this._emojiPickerContext = 'main';
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

  // Cancel whatever is currently uploading
  document.getElementById('upload-cancel-btn')?.addEventListener('click', () => {
    this._cancelUploads();
  });
},

_bindComposerModals() {
  // ── Poll creation modal ──
  document.getElementById('poll-btn').addEventListener('click', () => {
    this._openPollModal();
  });
  document.getElementById('time-btn')?.addEventListener('click', () => {
    this._openTimeModal();
  });

  // (#5280) Burn-after-read toggle (DM-only, default 30 s).
  // Persistent toggle: once armed, every outgoing message in the
  // current DM is burn-after-read until the user clicks the button
  // again to disarm it (or switches channels). Default duration is
  // 30 s; a long-press could later pop a duration picker.
  const _burnBtn = document.getElementById('burn-btn');
  if (_burnBtn) {
    _burnBtn.addEventListener('click', () => {
      this._burnArmed = !this._burnArmed;
      _burnBtn.classList.toggle('active', !!this._burnArmed);
      _burnBtn.title = this._burnArmed
        ? t('app.input_bar.burn_btn_armed')
        : t('app.input_bar.burn_btn');
      // Surface a toast so users get visible confirmation. The button alone
      // wasn't obvious enough that anything had happened. (#5325)
      const toastKey = this._burnArmed ? 'toasts.burn_armed' : 'toasts.burn_disarmed';
      this._showToast?.(t(toastKey), 'info');
    });
  }

  // Self-destructing messages: a toggle that asks how long on the next send.
  document.getElementById('self-destruct-btn')?.addEventListener('click', () => {
    this._setSelfDestructArmed(!this._selfDestructArmed);
  });
  document.querySelectorAll('#self-destruct-modal [data-sd-unit]').forEach(b => {
    b.addEventListener('click', () => {
      this._setSelfDestructUnit(b.dataset.sdUnit);
      this._updateSelfDestructPreview();
      document.getElementById('sd-amount')?.focus();
    });
  });
  document.getElementById('sd-amount')?.addEventListener('input', () => {
    document.getElementById('sd-error').style.display = 'none';
    this._updateSelfDestructPreview();
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

  // ── /time timestamp picker modal ──
  const timeModal = document.getElementById('time-modal');
  if (timeModal) {
    const refresh = () => this._tsmUpdatePreview();
    ['tsm-year', 'tsm-month', 'tsm-day', 'tsm-hour', 'tsm-minute', 'tsm-second']
      .forEach(id => document.getElementById(id)?.addEventListener('input', refresh));
    timeModal.querySelectorAll('.tsm-mer-btn').forEach(b => {
      b.addEventListener('click', () => { this._tsmSetMeridiem(b.dataset.mer); refresh(); });
    });
    document.getElementById('tsm-cal-btn')?.addEventListener('click', () => {
      const di = document.getElementById('tsm-cal-input');
      if (!di) return;
      const cur = this._tsmBuildDate();
      // Seed the native picker with the fields' current date so it opens there,
      // decomposed in the same zone the wall-clock fields are read in.
      if (cur) {
        const p = n => String(n).padStart(2, '0');
        const parts = this._zonedParts(cur);
        di.value = `${parts.year}-${p(parts.monthIndex + 1)}-${p(parts.day)}`;
      }
      try { di.showPicker(); } catch { di.focus(); di.click(); }
    });
    document.getElementById('tsm-cal-input')?.addEventListener('change', () => this._tsmSyncFromCalendar());
    document.getElementById('tsm-styles')?.addEventListener('click', (e) => {
      const btn = e.target.closest('.tsm-style-insert');
      if (btn) this._tsmInsert(btn.dataset.style);
    });
    timeModal.addEventListener('click', (e) => {
      if (e.target.id === 'time-modal') e.target.style.display = 'none';
    });
  }
},

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
    if (e.key === 'Enter' || e.key === 'Tab') {
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
  const channelDd = document.getElementById('channel-dropdown');
  if (channelDd && channelDd.style.display !== 'none') {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      this._navigateChannelDropdown(e.key === 'ArrowDown' ? 1 : -1);
      return true;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      const active = channelDd.querySelector('.mention-item.active');
      if (active) { e.preventDefault(); active.click(); return true; }
    }
    if (e.key === 'Escape') { this._hideChannelDropdown(); return true; }
  }
  const personaDd = document.getElementById('persona-dropdown');
  if (personaDd && personaDd.style.display !== 'none') {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      this._navigatePersonaDropdown(e.key === 'ArrowDown' ? 1 : -1);
      return true;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      const active = personaDd.querySelector('.mention-item.active');
      if (active) { e.preventDefault(); active.click(); return true; }
    }
    if (e.key === 'Escape') { this._hidePersonaDropdown(); return true; }
  }
  const ferryDd = document.getElementById('ferry-dropdown');
  if (ferryDd && ferryDd.style.display !== 'none') {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      this._navigateFerryDropdown(e.key === 'ArrowDown' ? 1 : -1);
      return true;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      const active = ferryDd.querySelector('.mention-item.active');
      if (active) { e.preventDefault(); active.click(); return true; }
    }
    if (e.key === 'Escape') { this._hideFerryDropdown(); return true; }
  }
  return false;
},

/* ── Polls ───────────────────────────────────────────── */

_openPollModal() {
  const modal = document.getElementById('poll-modal');
  document.getElementById('poll-question-input').value = '';
  document.getElementById('poll-multi-vote').checked = false;
  document.getElementById('poll-anonymous').checked = false;
  const colSel = document.getElementById('poll-columns');
  if (colSel) colSel.value = '0';
  this._updatePollColumnsVis();
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
  input.placeholder = t('modals.poll.option_placeholder', { number: index + 1 });
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
  // A picture for the option: uploaded on pick, so the poll can be posted
  // with the URLs the moment Create is clicked (#5648).
  const imgBtn = document.createElement('button');
  imgBtn.type = 'button';
  imgBtn.className = 'poll-option-imgbtn';
  imgBtn.textContent = '\ud83d\uddbc\ufe0f';
  imgBtn.title = t('modals.poll.add_image');
  const file = document.createElement('input');
  file.type = 'file';
  file.accept = 'image/*';
  file.style.display = 'none';
  imgBtn.addEventListener('click', () => {
    if (row.dataset.image) {
      delete row.dataset.image;
      imgBtn.classList.remove('has-image');
      imgBtn.style.backgroundImage = '';
      imgBtn.title = t('modals.poll.add_image');
      this._updatePollColumnsVis();
      return;
    }
    file.click();
  });
  file.addEventListener('change', async () => {
    const f = file.files && file.files[0];
    file.value = '';
    if (!f || !f.type.startsWith('image/')) return;
    const cap = this._uploadCapMb ? this._uploadCapMb() : 25;
    if (f.size > cap * 1024 * 1024) return this._showToast(t('media.image_too_large', { maxMb: cap }), 'error');
    try {
      const fd = new FormData();
      fd.append('scope', 'channel');
      fd.append('image', f);
      const data = await this._uploadWithProgress('/api/upload', fd);
      if (!data || !data.url) throw new Error('upload');
      row.dataset.image = data.url;
      imgBtn.classList.add('has-image');
      imgBtn.style.backgroundImage = `url("${data.url}")`;
      imgBtn.title = t('modals.poll.remove_image');
      this._updatePollColumnsVis();
    } catch (err) {
      if (!err?.aborted) this._showToast(err?.message || t('toasts.upload_failed'), 'error');
    }
  });
  row.appendChild(input);
  row.appendChild(imgBtn);
  row.appendChild(file);
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
  this._updatePollColumnsVis();
},

// The Columns choice only matters for a picture poll (#5648).
_updatePollColumnsVis() {
  const wrap = document.getElementById('poll-columns-wrap');
  if (!wrap) return;
  const any = [...document.querySelectorAll('#poll-options-list .poll-option-row')].some(r => r.dataset.image);
  wrap.style.display = any ? '' : 'none';
},

_submitPoll() {
  const question = document.getElementById('poll-question-input').value.trim();
  if (!question) return;
  const rows = Array.from(document.querySelectorAll('#poll-options-list .poll-option-row'))
    .map(r => ({ text: r.querySelector('.poll-option-input')?.value.trim() || '', image: r.dataset.image || null }))
    .filter(r => r.text);
  const options = rows.map(r => r.text);
  if (options.length < 2) return;
  const images = rows.map(r => r.image);
  const multiVote = document.getElementById('poll-multi-vote').checked;
  const anonymous = document.getElementById('poll-anonymous').checked;
  const hasImages = images.some(Boolean);
  const columns = hasImages ? (parseInt(document.getElementById('poll-columns')?.value, 10) || 0) : 0;

  this.socket.emit('create-poll', { question, options, multiVote, anonymous, ...(hasImages && { images }), ...(columns > 1 && { columns }) });
  document.getElementById('poll-modal').style.display = 'none';
},

// The drag bar above a text box. Bound once per handle; the edit box makes
// its own handle on the fly (#5662).
// ── Formatting guide and command list (#5654) ─────────────
// Every markdown trick the message formatter understands, in one place. A
// click wraps the selection (or drops a sample) into the message box.
_formatGuideRows() {
  return [
    { key: 'bold',      before: '**', after: '**' },
    { key: 'italic',    before: '*',  after: '*' },
    { key: 'underline', before: '__', after: '__' },
    { key: 'strike',    before: '~~', after: '~~' },
    { key: 'highlight', before: '==', after: '==' },
    { key: 'spoiler',   before: '||', after: '||' },
    { key: 'code',      before: '`',  after: '`' },
    { key: 'codeblock', before: '```\n', after: '\n```', block: true },
    { key: 'quote',     before: '> ',  after: '', block: true },
    { key: 'heading',   before: '# ',  after: '', block: true },
    { key: 'list',      before: '- ',  after: '', block: true },
    { key: 'numbered',  before: '1. ', after: '', block: true },
    { key: 'link',      before: '[',   after: '](https://example.com)' },
    { key: 'colour',    before: 'c#FF00EF ', after: ' #c' },
    { key: 'rule',      before: '---', after: '', block: true, sample: '' },
    { key: 'table',     before: '| A | B |\n| --- | --- |\n| 1 | 2 |', after: '', block: true, sample: '' },
    { key: 'mention',   before: '@',  after: '', sample: '' },
    { key: 'channel',   before: '#',  after: '', sample: '' },
    { key: 'emoji',     before: ':',  after: ':', sample: 'smile' },
  ];
},

_formatGuideHtml() {
  return this._formatGuideRows().map(r => {
    const sample = r.sample !== undefined ? r.sample : t('format_picker.sample_text');
    const syntax = r.before + sample + r.after;
    const demo = (r.block || !sample) ? '' : `<span class="format-row-demo message-content">${this._formatContent(syntax)}</span>`;
    return `<button type="button" class="format-row" data-before="${this._escapeHtml(r.before)}" data-after="${this._escapeHtml(r.after)}" data-sample="${this._escapeHtml(sample)}"${r.block ? ' data-block="1"' : ''}>
      <span class="format-row-label">${this._escapeHtml(t(`format_picker.${r.key}`))}</span>
      <code class="format-row-syntax">${this._escapeHtml(syntax)}</code>${demo}</button>`;
  }).join('');
},

// The same list the / dropdown offers, for the current channel, including
// the bot commands registered here.
_commandGuideHtml() {
  const code = this.currentChannel;
  const cmds = (this.slashCommands || []).filter(c => c && c.cmd && (!Array.isArray(c.channelCodes) || c.channelCodes.includes(code)));
  if (!cmds.length) return `<div class="format-picker-hint">${this._escapeHtml(t('format_picker.no_commands'))}</div>`;
  const rows = cmds.map(c => {
    const desc = (c.descByChannel && code && c.descByChannel[code]) || c.desc || '';
    return `<button type="button" class="format-row format-row-command" data-cmd="${this._escapeHtml(c.cmd)}">
      <span class="format-row-cmd">/${this._escapeHtml(c.cmd)}${c.args ? ' ' + this._escapeHtml(c.args) : ''}</span>
      <span class="format-row-desc">${this._escapeHtml(desc)}</span></button>`;
  }).join('');
  return `<div class="format-picker-hint">${this._escapeHtml(t('format_picker.commands_hint'))}</div>${rows}`;
},

// Wrap the selection in the message box (or the box being edited) with a
// markdown pair, or drop a sample in when nothing is selected. Block-level
// syntax starts on its own line.
_wrapComposerSelection(before, after, sample = '', block = false) {
  const input = this._activeEditTextarea || document.getElementById('message-input');
  if (!input) return;
  const start = Number.isInteger(input.selectionStart) ? input.selectionStart : input.value.length;
  const end = Number.isInteger(input.selectionEnd) ? input.selectionEnd : start;
  const selected = input.value.slice(start, end);
  const inner = selected || sample;
  const lead = (block && start > 0 && input.value[start - 1] !== '\n') ? '\n' : '';
  input.focus();
  input.setRangeText(lead + before + inner + after, start, end, 'end');
  if (!selected && sample) {
    const s = start + lead.length + before.length;
    input.setSelectionRange(s, s + sample.length);
  }
  input.dispatchEvent(new Event('input', { bubbles: true }));
},

// Put a command at the front of the message box, replacing one already there
// and keeping the rest of the draft. (The slash dropdown's _insertSlashCommand
// in app-admin.js replaces the whole box, which is right for typing a command
// but wiped the draft when this shared its name and lost to it.)
_insertGuideCommand(cmd) {
  const input = document.getElementById('message-input');
  if (!input) return;
  input.value = '/' + cmd + ' ' + input.value.replace(/^\/\S*\s?/, '');
  input.focus();
  input.setSelectionRange(cmd.length + 2, cmd.length + 2);
  input.dispatchEvent(new Event('input', { bubbles: true }));
},

// ── Voice messages (#5665) ─────────────────────────────────
// Click the mic to record, click it again (or Send) to post the recording as
// an audio attachment; Cancel or Escape throws it away. It goes out through
// the same upload as any file, so in an encrypted DM it is encrypted like
// one. Five minutes is the ceiling.
_voiceMimeChoice() {
  if (typeof MediaRecorder === 'undefined') return null;
  const wants = [
    ['audio/webm;codecs=opus', 'weba'], ['audio/webm', 'weba'],
    ['audio/ogg;codecs=opus', 'ogg'], ['audio/mp4', 'm4a'],
  ];
  for (const [mime, ext] of wants) {
    try { if (MediaRecorder.isTypeSupported(mime)) return { mime, ext }; } catch { /* next */ }
  }
  return null;
},

async _toggleVoiceMessage() {
  if (this._voiceRec) { this._stopVoiceMessage(true); return; }
  const ch = this.channels.find(c => c.code === this.currentChannel);
  if (!ch) return;
  if (ch.media_enabled === 0) { this._showToast(t('media.uploads_disabled'), 'error'); return; }
  const choice = this._voiceMimeChoice();
  if (!choice || !navigator.mediaDevices?.getUserMedia) { this._showToast(t('voice_message.unsupported'), 'error'); return; }
  // Self-destruct on: ask how long first and record only once confirmed.
  // Backing out records nothing and leaves the toggle on.
  let destructMs = 0;
  if (this._selfDestructArmed) {
    destructMs = await this._askSelfDestruct();
    if (!destructMs || this.currentChannel !== ch.code) return;
  }
  let stream;
  try {
    // The same microphone voice chat uses, when one was picked.
    const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    const savedInputId = localStorage.getItem('haven_input_device') || '';
    if (savedInputId) audio.deviceId = { exact: savedInputId };
    try { stream = await navigator.mediaDevices.getUserMedia({ audio }); }
    catch { delete audio.deviceId; stream = await navigator.mediaDevices.getUserMedia({ audio }); }
  } catch {
    this._showToast(t('voice_message.mic_denied'), 'error');
    return;
  }
  const chunks = [];
  let recorder;
  try { recorder = new MediaRecorder(stream, { mimeType: choice.mime }); }
  catch { recorder = new MediaRecorder(stream); }
  const rec = { recorder, stream, chunks, ext: choice.ext, mime: recorder.mimeType || choice.mime, startedAt: Date.now(), code: this.currentChannel, send: false, timer: null, destructMs };
  recorder.addEventListener('dataavailable', (e) => { if (e.data && e.data.size) chunks.push(e.data); });
  recorder.addEventListener('stop', () => this._finishVoiceMessage(rec));
  try {
    recorder.start(250);
  } catch {
    // A browser that has the API but cannot encode from this input.
    try { stream.getTracks().forEach(tr => tr.stop()); } catch { /* nothing to stop */ }
    this._showToast(t('voice_message.unsupported'), 'error');
    return;
  }
  this._voiceRec = rec;
  const bar = document.getElementById('voice-record-bar');
  if (bar) bar.style.display = 'flex';
  document.getElementById('voice-btn')?.classList.add('recording');
  const tick = () => {
    const s = Math.floor((Date.now() - rec.startedAt) / 1000);
    const el = document.getElementById('voice-rec-time');
    if (el) el.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    if (s >= 300) this._stopVoiceMessage(true);
  };
  tick();
  rec.timer = setInterval(tick, 250);
  this._voiceRecKeyHandler = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this._stopVoiceMessage(false); } };
  document.addEventListener('keydown', this._voiceRecKeyHandler, true);
},

_stopVoiceMessage(send) {
  const rec = this._voiceRec;
  if (!rec) return;
  rec.send = !!send;
  rec.seconds = Math.round((Date.now() - rec.startedAt) / 1000);
  clearInterval(rec.timer);
  if (this._voiceRecKeyHandler) {
    document.removeEventListener('keydown', this._voiceRecKeyHandler, true);
    this._voiceRecKeyHandler = null;
  }
  const bar = document.getElementById('voice-record-bar');
  if (bar) bar.style.display = 'none';
  document.getElementById('voice-btn')?.classList.remove('recording');
  this._voiceRec = null;
  try {
    if (rec.recorder.state !== 'inactive') rec.recorder.stop();
    else this._finishVoiceMessage(rec);
  } catch { this._finishVoiceMessage(rec); }
},

_finishVoiceMessage(rec) {
  try { rec.stream.getTracks().forEach(tr => tr.stop()); } catch { /* already stopped */ }
  if (rec.done) return;
  rec.done = true;
  if (!rec.send || !rec.chunks.length) return;
  if (!rec.seconds || rec.seconds < 1) { this._showToast(t('voice_message.too_short'), 'error'); return; }
  const type = String(rec.mime || '').split(';')[0] || 'audio/webm';
  const blob = new Blob(rec.chunks, { type });
  const m = Math.floor(rec.seconds / 60), s = rec.seconds % 60;
  // The length rides in the name so the message can show it without loading
  // the audio: voice-message-1m05s.weba.
  const file = new File([blob], `voice-message-${m}m${String(s).padStart(2, '0')}s.${rec.ext}`, { type });
  // The timer counts from when it is sent, not from when recording began.
  // Turning the flame off while recording sends it as a normal message.
  if (rec.destructMs && this._selfDestructArmed) {
    file._destructAt = Date.now() + rec.destructMs;
    this._setSelfDestructArmed(false);
  }
  this._uploadGeneralFile(file, rec.code);
},

_bindInputResizer(handle) {
  if (!handle || handle._resizerBound) return;
  handle._resizerBound = true;
  // The composer's bar sits above its box, so up means taller; the edit
  // box's bar sits below it, so there down means taller (#5662).
  const below = handle.classList.contains('edit-resizer');
  let startY = 0;
  let startHeight = 0;
  let ta = null;
  let cap = 600;

  const onMove = (e) => {
    if (!ta) return;
    const delta = below ? (e.clientY - startY) : (startY - e.clientY); // positive when growing
    const newHeight = Math.max(34, Math.min(cap, startHeight + delta));
    ta.style.height = `${newHeight}px`;
    ta.style.minHeight = `${newHeight}px`;
    ta.style.maxHeight = `${cap}px`;
  };

  const onUp = () => {
    ta = null;
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  };

  handle.addEventListener('mousedown', (e) => {
    ta = handle.parentElement?.querySelector('textarea');
    if (!ta) return;
    startY = e.clientY;
    startHeight = ta.getBoundingClientRect().height;
    // Cap manual expansion at ~60% of viewport so the textarea can never
    // swallow the entire chat pane. Min 200px on tiny windows.
    cap = Math.max(200, Math.floor(window.innerHeight * 0.6));
    e.preventDefault();
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
},

/* ── Self-destructing messages ──────────────────────── */
_setSelfDestructArmed(on) {
  this._selfDestructArmed = !!on;
  const btn = document.getElementById('self-destruct-btn');
  if (!btn) return;
  btn.classList.toggle('active', this._selfDestructArmed);
  btn.setAttribute('aria-pressed', String(this._selfDestructArmed));
  btn.title = t(this._selfDestructArmed ? 'app.input_bar.self_destruct_btn_armed' : 'app.input_bar.self_destruct_btn');
},

_setSelfDestructUnit(unit) {
  this._selfDestructUnit = unit === 'hours' ? 'hours' : 'minutes';
  document.querySelectorAll('#self-destruct-modal [data-sd-unit]').forEach(b => {
    b.classList.toggle('active', b.dataset.sdUnit === this._selfDestructUnit);
    b.setAttribute('aria-pressed', String(b.dataset.sdUnit === this._selfDestructUnit));
  });
},

/** Milliseconds for what was typed, or null. Up to two decimals, a comma
 *  works as the decimal point, and the result must be 30 seconds to 24 hours. */
_parseSelfDestruct(raw, unit) {
  const s = String(raw || '').trim().replace(',', '.');
  if (!/^(\d{1,4}(\.\d{0,2})?|\.\d{1,2})$/.test(s)) return null;
  const ms = Math.round(parseFloat(s) * (unit === 'hours' ? 3600000 : 60000));
  return ms >= 30000 && ms <= 86400000 ? ms : null;
},

/** "Deletes in 1 hour, 30 minutes" under the input, exact rather than
 *  rounded, in the reader's language. Hidden until the input makes sense. */
_updateSelfDestructPreview() {
  const el = document.getElementById('sd-preview');
  if (!el) return;
  const ms = this._parseSelfDestruct(document.getElementById('sd-amount')?.value, this._selfDestructUnit);
  el.style.display = ms ? '' : 'none';
  if (!ms) return;
  const locale = this._timeLocale();
  let secs = Math.round(ms / 1000);
  const parts = [];
  for (const [unit, size] of [['hour', 3600], ['minute', 60], ['second', 1]]) {
    const n = Math.floor(secs / size);
    secs -= n * size;
    if (n) parts.push(new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'long' }).format(n));
  }
  el.textContent = t('modals.self_destruct.preview', { time: new Intl.ListFormat(locale, { style: 'long', type: 'unit' }).format(parts) });
},

/** Ask how long the message lives. Resolves milliseconds, or null when the
 *  sender backs out (Cancel, the X, Escape or a click outside). */
_askSelfDestruct() {
  const modal = document.getElementById('self-destruct-modal');
  const input = document.getElementById('sd-amount');
  const error = document.getElementById('sd-error');
  if (!modal || !input) return Promise.resolve(null);
  input.value = '';
  error.style.display = 'none';
  this._setSelfDestructUnit('minutes');
  this._updateSelfDestructPreview();
  modal.style.display = 'flex';
  // Focus now, not on a timer, so keys typed right after Enter land here.
  input.focus();
  return new Promise((resolve) => {
    const close = (val) => {
      modal.style.display = 'none';
      modal.removeEventListener('click', onClick);
      document.removeEventListener('keydown', onKey, true);
      // Backing out returns to the message, which is still in the box.
      if (!val) document.getElementById('message-input')?.focus();
      resolve(val);
    };
    const submit = () => {
      const ms = this._parseSelfDestruct(input.value, this._selfDestructUnit);
      if (ms) return close(ms);
      error.style.display = '';
      input.focus();
    };
    const onClick = (e) => {
      if (e.target === modal || e.target.closest('#sd-cancel, #sd-close')) close(null);
      else if (e.target.closest('#sd-send')) submit();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(null); }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); submit(); }
    };
    modal.addEventListener('click', onClick);
    document.addEventListener('keydown', onKey, true);
  });
},

/** The send-message field for a self-destruct deadline. Sent as the time
 *  left rather than a clock time, so the sender's clock does not matter, and
 *  attachments that finish uploading later still go at the same moment. */
_destructField(at) {
  if (!at) return {};
  return { destructSeconds: Math.max(1, Math.min(86400, Math.round((at - Date.now()) / 1000))) };
},

/* ── Send later (#5638) ─────────────────────────────── */
_openScheduleModal(prefill = '') {
  const modal = document.getElementById('schedule-modal');
  if (!modal) return;
  const ch = this.channels?.find(c => c.code === this.currentChannel);
  if (!ch || ch.is_dm) { this._showToast(t('modals.schedule.not_here'), 'error'); return; }
  const text = document.getElementById('schedule-text');
  text.value = prefill || document.getElementById('message-input')?.value || '';
  text.maxLength = parseInt(this.serverSettings?.max_message_chars) || 2000;
  // Default to one hour out, on the whole minute, seeded in the user's zone.
  const d = new Date(Date.now() + 60 * 60 * 1000);
  d.setSeconds(0, 0);
  this._wireScheduleFields();
  this._seedScheduleFields(d);
  this._scheduleEditingId = null;
  document.getElementById('schedule-save').textContent = t('modals.schedule.schedule_btn');
  modal.style.display = 'flex';
  text.focus();
  this._loadScheduledList();
},

/** Load an instant into the Send-at fields, decomposed into the user's
 *  confirmed timezone (device zone when none is set). */
_seedScheduleFields(d) {
  const parts = this._zonedParts(d);
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
  set('sch-year', parts.year);
  set('sch-month', parts.monthIndex + 1);
  set('sch-day', parts.day);
  set('sch-minute', parts.minute);
  set('sch-second', parts.second);
  this._tsmSetMeridiem(this._tsm24hDefault() ? '24' : (parts.hour < 12 ? 'AM' : 'PM'), parts.hour, this._schScope());
},

/** Wire the Send-at picker once: meridiem toggle and the calendar helper,
 *  reusing the /time picker's field logic under the schedule scope. */
_wireScheduleFields() {
  if (this._scheduleFieldsWired) return;
  this._scheduleFieldsWired = true;
  const scope = this._schScope();
  document.querySelectorAll('#schedule-modal .tsm-mer-btn').forEach(b => {
    b.addEventListener('click', () => this._tsmSetMeridiem(b.dataset.mer, undefined, scope));
  });
  document.getElementById('sch-cal-btn')?.addEventListener('click', () => {
    const di = document.getElementById('sch-cal-input');
    if (!di) return;
    const cur = this._tsmBuildDate(scope);
    if (cur) {
      const p = n => String(n).padStart(2, '0');
      const parts = this._zonedParts(cur);
      di.value = `${parts.year}-${p(parts.monthIndex + 1)}-${p(parts.day)}`;
    }
    try { di.showPicker(); } catch { di.focus(); di.click(); }
  });
  document.getElementById('sch-cal-input')?.addEventListener('change', () => {
    const v = document.getElementById('sch-cal-input')?.value; // YYYY-MM-DD
    const m = v && v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return;
    document.getElementById('sch-year').value = Number(m[1]);
    document.getElementById('sch-month').value = Number(m[2]);
    document.getElementById('sch-day').value = Number(m[3]);
  });
},

_loadScheduledList() {
  this.socket.timeout(8000).emit('get-scheduled-messages', {}, (err, r) => {
    if (err || !r) return;
    this._renderScheduledList(r.items || []);
  });
},

_renderScheduledList(items) {
  const list = document.getElementById('schedule-list');
  if (!list) return;
  if (!items.length) {
    list.innerHTML = `<p class="muted-text" style="font-size:0.8rem">${t('modals.schedule.none')}</p>`;
    return;
  }
  list.innerHTML = items.map(it => `<div class="schedule-item" data-id="${it.id}">
    <div class="schedule-item-main">
      <span class="schedule-item-when">${this._escapeHtml(this._fmtDateTime(it.sendAt))}</span>
      <span class="schedule-item-chan">#${this._escapeHtml(it.channelName || '')}</span>
      <div class="schedule-item-text">${this._escapeHtml(it.content)}</div>
    </div>
    <div class="schedule-item-actions">
      <button type="button" class="btn-sm" data-act="edit">${t('msg_toolbar.edit')}</button>
      <button type="button" class="btn-sm danger" data-act="cancel">${t('modals.schedule.cancel_send')}</button>
    </div>
  </div>`).join('');
  list.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => {
    const id = parseInt(b.closest('.schedule-item').dataset.id, 10);
    const it = items.find(x => x.id === id);
    if (!it) return;
    if (b.dataset.act === 'cancel') {
      this.socket.emit('cancel-scheduled-message', { id }, (r) => this._renderScheduledList((r && r.items) || []));
      return;
    }
    this._scheduleEditingId = id;
    document.getElementById('schedule-text').value = it.content;
    this._wireScheduleFields();
    this._seedScheduleFields(new Date(it.sendAt));
    document.getElementById('schedule-save').textContent = t('modals.common.save');
  }));
},

_submitSchedule() {
  const textEl = document.getElementById('schedule-text');
  const content = textEl.value.trim();
  // Read the wall-clock in the user's confirmed zone (device fallback), so the
  // absolute instant sent to the server is the moment the user actually meant,
  // not whatever the browser's clock/zone claims. toISOString() below is still
  // a plain UTC handoff; only the zone the fields are read in has changed.
  const at = this._tsmBuildDate(this._schScope());
  if (!content) { textEl.focus(); return; }
  if (!at || isNaN(at.getTime()) || at.getTime() < Date.now() + 30000) { this._showToast(t('modals.schedule.in_past'), 'error'); return; }
  const editing = this._scheduleEditingId;
  const done = (r) => {
    if (!r || r.error) { this._showToast((r && r.error) || t('toasts.role_server_no_response'), 'error'); return; }
    this._showToast(t(editing ? 'modals.schedule.updated' : 'modals.schedule.scheduled', { when: this._fmtDateTime(at) }), 'success');
    if (!editing) {
      const input = document.getElementById('message-input');
      if (input && input.value.trim() === content) { input.value = ''; input.style.height = 'auto'; }
    }
    this._scheduleEditingId = null;
    textEl.value = '';
    document.getElementById('schedule-save').textContent = t('modals.schedule.schedule_btn');
    this._renderScheduledList(r.items || []);
  };
  if (editing) this.socket.emit('update-scheduled-message', { id: editing, content, sendAt: at.toISOString() }, done);
  else this.socket.emit('schedule-message', { code: this.currentChannel, content, sendAt: at.toISOString() }, done);
},

/* ── /time timestamp picker modal ───────────────────── */
// Opened by `/time` with no argument. It builds the very same <t:...> token
// the text command does, so the render side (_formatTimestampToken) is reused
// untouched; the modal is only a friendlier way to choose the instant.

/** True when the reader's locale keeps a 24-hour clock. Falls back to 24-hour
 *  when the browser cannot report an hour cycle, per the feature's default. */
_tsm24hDefault() {
  // A confirmed clock preference wins over the locale probe.
  const h12 = this._userHour12?.();
  if (h12 === true) return false;
  if (h12 === false) return true;
  try {
    const hc = new Intl.DateTimeFormat(this._timeLocale?.(), { hour: 'numeric' })
      .resolvedOptions().hourCycle;
    if (hc) return hc === 'h23' || hc === 'h24';
    // Older engines omit hourCycle: probe whether an afternoon hour prints a
    // meridiem marker instead.
    const s = new Date(2020, 0, 1, 13).toLocaleTimeString(this._timeLocale?.(), { hour: 'numeric' });
    return !/[ap]\.?\s?m/i.test(s);
  } catch { return true; }
},

_openTimeModal() {
  const modal = document.getElementById('time-modal');
  if (!modal) return;
  // Seed "now" in the reader's confirmed zone (device zone when none is set),
  // so a privacy browser reporting a false clock does not preset the wrong time.
  const now = this._nowZonedParts();
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
  set('tsm-year', now.year);
  set('tsm-month', now.monthIndex + 1);
  set('tsm-day', now.day);
  set('tsm-minute', now.minute);
  set('tsm-second', now.second);
  // Default the clock mode to the reader's own convention, then seed the hour
  // field in whatever units that mode expects.
  this._tsmSetMeridiem(this._tsm24hDefault() ? '24' : (now.hour < 12 ? 'AM' : 'PM'), now.hour);
  this._tsmRenderStyles();
  this._tsmUpdatePreview();
  modal.style.display = 'flex';
  document.getElementById('tsm-hour')?.focus();
},

/** The two wall-clock pickers that share this field logic. Each names its modal
 *  (for the meridiem buttons), its field id prefix, and where its 24/AM/PM
 *  state lives. Defaulting every function to the /time scope keeps that
 *  picker's existing call sites untouched. */
_tsmScope() { return { modalId: 'time-modal', prefix: 'tsm', meridiemKey: '_tsmMeridiem' }; },
_schScope() { return { modalId: 'schedule-modal', prefix: 'sch', meridiemKey: '_schMeridiem' }; },

/** Switch the 24HR / AM / PM segmented control. `seedHour24`, when given, is a
 *  0-23 hour to load into the field in the new mode's units. */
_tsmSetMeridiem(mode, seedHour24, scope = this._tsmScope()) {
  this[scope.meridiemKey] = mode;
  document.querySelectorAll(`#${scope.modalId} .tsm-mer-btn`).forEach(b => {
    b.classList.toggle('active', b.dataset.mer === mode);
  });
  const hourEl = document.getElementById(`${scope.prefix}-hour`);
  if (!hourEl) return;
  const cur = Number(hourEl.value);
  // Reuse whatever hour is already showing when the user flips the toggle, so
  // "8 PM" stays 8 PM going to 24-hour (→ 20) and back.
  let h24 = Number.isFinite(seedHour24) ? seedHour24 : this._tsmReadHour24(cur, scope);
  if (!Number.isFinite(h24)) h24 = 0;
  if (mode === '24') {
    hourEl.min = 0; hourEl.max = 23;
    hourEl.value = h24;
  } else {
    hourEl.min = 1; hourEl.max = 12;
    hourEl.value = ((h24 % 12) || 12);
  }
},

/** Convert the hour field's current number into 0-23, honouring the mode. */
_tsmReadHour24(raw, scope = this._tsmScope()) {
  const h = Number(raw);
  if (!Number.isFinite(h)) return NaN;
  if (this[scope.meridiemKey] === '24') return h;
  const base = h % 12;
  return this[scope.meridiemKey] === 'PM' ? base + 12 : base;
},

/** Read all fields into a Date, interpreting the entered wall-clock in the
 *  reader's confirmed timezone (device zone when none is set), or null if the
 *  combination is not a real calendar instant. */
_tsmBuildDate(scope = this._tsmScope()) {
  const num = id => Number(document.getElementById(id)?.value);
  const y = num(`${scope.prefix}-year`), mo = num(`${scope.prefix}-month`), d = num(`${scope.prefix}-day`);
  const mi = num(`${scope.prefix}-minute`), se = num(`${scope.prefix}-second`);
  const h24 = this._tsmReadHour24(document.getElementById(`${scope.prefix}-hour`)?.value, scope);
  if (![y, mo, d, mi, se, h24].every(Number.isFinite)) return null;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  if (h24 < 0 || h24 > 23 || mi < 0 || mi > 59 || se < 0 || se > 59) return null;
  // Interpret the entered wall-clock in the reader's confirmed zone (device
  // zone when none is set), so the instant matches what the person meant.
  const when = this._wallToInstant(y, mo - 1, d, h24, mi, se);
  // Reject dates JS silently rolls forward (e.g. 2026-02-31 → March), checked
  // in the same zone the wall-clock was read in.
  const back = this._zonedParts(when);
  if (back.year !== y || back.monthIndex !== mo - 1 || back.day !== d) return null;
  return when;
},

/** Build the seven style rows once, each a live preview plus its own Insert
 *  button. Order follows the format list the feature documents. */
_tsmRenderStyles() {
  const box = document.getElementById('tsm-styles');
  if (!box || box.childElementCount) return;
  const label = this._escapeHtml(t('modals.time.insert_btn'));
  box.innerHTML = ['F', 'f', 'D', 'd', 't', 'T', 'R'].map(s =>
    `<div class="tsm-style-row" data-style="${s}">` +
      `<span class="tsm-style-preview"></span>` +
      `<button type="button" class="btn-sm btn-accent tsm-style-insert" data-style="${s}">${label}</button>` +
    `</div>`).join('');
},

/** Refresh every style's preview from the current field values. */
_tsmUpdatePreview() {
  const box = document.getElementById('tsm-styles');
  if (!box) return;
  const when = this._tsmBuildDate();
  const secs = when ? Math.floor(when.getTime() / 1000) : null;
  box.querySelectorAll('.tsm-style-row').forEach(row => {
    const prev = row.querySelector('.tsm-style-preview');
    const btn = row.querySelector('.tsm-style-insert');
    const html = secs !== null ? this._formatTimestampToken(secs, row.dataset.style) : null;
    if (html) {
      prev.classList.remove('tsm-invalid');
      prev.innerHTML = html;
      if (btn) { btn.disabled = false; btn.setAttribute('aria-label', `${t('modals.time.insert_btn')}: ${prev.textContent}`); }
    } else {
      prev.classList.add('tsm-invalid');
      prev.textContent = '-';
      if (btn) btn.disabled = true;
    }
  });
},

/** Pull the native date input's YYYY-MM-DD back into the Year/Month/Day
 *  fields. The picker itself is the search feature's <input type="date">. */
_tsmSyncFromCalendar() {
  const v = document.getElementById('tsm-cal-input')?.value; // YYYY-MM-DD
  if (!v) return;
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return;
  document.getElementById('tsm-year').value = Number(m[1]);
  document.getElementById('tsm-month').value = Number(m[2]);
  document.getElementById('tsm-day').value = Number(m[3]);
  this._tsmUpdatePreview();
},

_tsmInsert(style) {
  const when = this._tsmBuildDate();
  if (!when) return;
  const s = ['F', 'f', 'D', 'd', 't', 'T', 'R'].includes(style) ? style : 'f';
  const token = `<t:${Math.floor(when.getTime() / 1000)}:${s}>`;
  const input = document.getElementById('message-input');
  document.getElementById('time-modal').style.display = 'none';
  if (!input) return;
  // Insert at the caret so the token can sit inside a sentence the user is
  // already writing; fall back to the end when there is no selection.
  const start = Number.isInteger(input.selectionStart) ? input.selectionStart : input.value.length;
  const end = Number.isInteger(input.selectionEnd) ? input.selectionEnd : input.value.length;
  input.value = input.value.slice(0, start) + token + input.value.slice(end);
  input.style.height = 'auto';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.focus();
  try { input.setSelectionRange(start + token.length, start + token.length); } catch { /* not a text input */ }
},

};
