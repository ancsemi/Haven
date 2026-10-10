// Typing helpers in the message box: markdown shortcuts and link pasting,
// and the @mention, #channel, :emoji: and /command dropdowns.

export default {

// ═══════════════════════════════════════════════════════
// markdown keyboard shortcut helper functions
// ═══════════════════════════════════════════════════════

_wrapSelectedText(inputEl, before, after, forEachLine = false) {
  const input = inputEl || document.getElementById('message-input');

  const start = input.selectionStart;
  const end = input.selectionEnd;
  if (start === end) return false;

  const selectedText = input.value.substring(start, end);
  const replacement = forEachLine ? selectedText.split('\n').map(line => line ? `${before}${line}${after}` : line).join('\n') : `${before}${selectedText}${after}`;

  input.setRangeText(replacement, start, end);
  input.setSelectionRange(start, start + replacement.length);
  // setRangeText does not fire 'input', and the composers rely on it for
  // auto-resize, the draft, and the typing indicator.
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
},

_handleMarkdownLinkPaste(inputEl, event) {
  const input = inputEl || document.getElementById('message-input');
  const url = event.clipboardData.getData('text/plain').trim();

  // Only handle pasted URLs.
  if (!/^https?:\/\/\S+$/i.test(url)) return false;
  return this._wrapSelectedText(input, '[', `](${url})`);
},

_handleMarkdownShortcuts(inputEl, event) {
  const input = inputEl || document.getElementById('message-input');

  const modifier = event.ctrlKey || event.metaKey;
  // AltGr reports as Ctrl+Alt on Windows, and those combos type characters.
  if (!modifier || event.altKey) return false;
  const key = (event.key || '').toLowerCase();

  // Italic (Ctrl/Cmd + I). Shift+I is left to the browser (DevTools).
  if (key === 'i' && !event.shiftKey) {
    return this._wrapSelectedText(input, '*', `*`, true);
  }

  // Underline (Ctrl/Cmd + U).
  if (key === 'u' && !event.shiftKey) {
    return this._wrapSelectedText(input, '__', `__`, true);
  }

  // Bold (Ctrl/Cmd + B). Shift+B is the bookmarks bar in Chrome.
  if (key === 'b' && !event.shiftKey) {
    return this._wrapSelectedText(input, '**', `**`, true);
  }

  // Code (Ctrl/Cmd + Shift + C)
  if (event.shiftKey && key === 'c') {
    const start = input.selectionStart;
    const end = input.selectionEnd;
    if (start === end) return false;

    const selectedText = input.value.substring(start, end);
    if (selectedText.includes('\n')) {
      return this._wrapSelectedText(input, '```\n', '\n```');
    }
    return this._wrapSelectedText(input, '`', '`');
  }

  // Strikethrough (Ctrl/Cmd + Shift + X)
  if (event.shiftKey && key === 'x') {
    return this._wrapSelectedText(input, '~~', `~~`, true);
  }

  // Spoiler (Ctrl/Cmd + Shift + P)
  if (event.shiftKey && key === 'p') {
    return this._wrapSelectedText(input, '||', `||`);
  }

  // Text color (Ctrl/Cmd + Shift + F) (F for font, since c for code is already taken)
  if (event.shiftKey && key === 'f') {
    const colorPrefix = 'c#(51,153,255)'
    if (!this._wrapSelectedText(input, colorPrefix, '#c')) return false;

    // Move cursor to just before ")" so the user can edit the color
    const cursorPos = input.selectionStart + (colorPrefix.length - 1);
    input.setSelectionRange(cursorPos, cursorPos);
    return true;
  }
  return false;
},

// ═══════════════════════════════════════════════════════
// @MENTION AUTOCOMPLETE
// ═══════════════════════════════════════════════════════

_checkMentionTrigger(inputEl) {
  const input = inputEl || document.getElementById('message-input');
  this._mentionInput = input;
  const cursor = input.selectionStart;
  const text = input.value.substring(0, cursor);

  // Look backwards from cursor for an '@' that starts a word.
  // Allow spaces in the query so we can match names like "John Doe". (#5273)
  const match = text.match(/@([^@\n]{0,30})$/);
  if (match) {
    this.mentionStart = cursor - match[0].length;
    this.mentionQuery = match[1].toLowerCase();
    this._showMentionDropdown();
  } else {
    this._hideMentionDropdown();
  }
},

_showMentionDropdown() {
  const dropdown = document.getElementById('mention-dropdown');
  // Re-parent so the absolute-positioned dropdown anchors above the active
  // input (works for thread input + DM PiP input + main input). (#5296)
  const host = (this._mentionInput && this._mentionInput.parentElement) || null;
  if (host && dropdown.parentElement !== host) host.appendChild(dropdown);
  const query = this.mentionQuery;

  // channelMembers is written in exactly one place (the 'channel-members'
  // socket handler), and that handler drops the payload if it arrives while
  // currentChannel has moved on. Any path that leaves it empty (a dropped
  // payload, a switchChannel that threw before its emit, a server-side
  // membership miss) used to surface as "@ silently does nothing", which is
  // impossible to diagnose from the user's side. Re-request instead, throttled
  // so a channel that genuinely has no other members doesn't spam the socket.
  if (!Array.isArray(this.channelMembers) || this.channelMembers.length === 0) {
    const now = Date.now();
    if (this.currentChannel && this.socket?.connected && now - (this._lastMemberRefetch || 0) > 3000) {
      this._lastMemberRefetch = now;
      console.warn('[Haven] @mention: channelMembers empty, re-requesting for', this.currentChannel);
      try { this.socket.emit('get-channel-members', { code: this.currentChannel }); } catch (err) { console.warn('[Mentions] could not re-request channel members', err); }
    }
  }

  // Any part of a name matches, so "dan" finds TheDannister and "tanee"
  // finds LADY TANEE. Names that start with the letters come first, then
  // names where a word starts with them, then the rest. (#5674)
  const mentionRank = (m) => {
    const names = [
      (m.username || '').toLowerCase(),
      (m.loginName || '').toLowerCase(),
      (m.id && this._nicknames && this._nicknames[m.id] || '').toLowerCase(),
    ].filter(Boolean);
    let best = -1;
    for (const n of names) {
      const at = n.indexOf(query);
      if (at < 0) continue;
      const rank = at === 0 ? 0 : (/[\s._-]/.test(n[at - 1]) ? 1 : 2);
      if (best < 0 || rank < best) best = rank;
    }
    return best;
  };
  const filtered = (this.channelMembers || [])
    .map((m, i) => ({ m, i, rank: mentionRank(m) }))
    .filter(x => x.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .slice(0, 8)
    .map(x => x.m);

  // Offer @everyone / @here as mention options when the query matches and
  // the user has the mention_everyone permission (admins implicitly have it).
  const canMentionEveryone = this.user && (this.user.isAdmin || this._hasPerm?.('mention_everyone'));
  const everyoneOptions = [];
  if (canMentionEveryone) {
    if ('everyone'.startsWith(query)) everyoneOptions.push({ name: 'everyone', label: '@everyone', desc: t('settings.admin.mention_everyone_desc') });
    if ('here'.startsWith(query)) everyoneOptions.push({ name: 'here', label: '@here', desc: t('settings.admin.mention_here_desc') });
  }
  // Roles sit behind the same permission, since a role ping fans out the same way. (#5579)
  const roleOptions = canMentionEveryone
    ? (this._mentionableRoles || []).filter(r => r && r.name && r.name.toLowerCase().includes(query)).slice(0, 5)
    : [];

  if (filtered.length === 0 && everyoneOptions.length === 0 && roleOptions.length === 0) {
    dropdown.style.display = 'none';
    return;
  }

  // Insert by loginName (stable, immune to display-name renames). Show the
  // viewer's personal nickname (if set) or the display name in the dropdown
  // for recognizability, with the @loginName suffix when it differs so
  // people know what'll actually be inserted. (#5290)
  const everyoneItems = everyoneOptions.map((opt, i) => {
    const active = (i === 0 && filtered.length === 0) ? ' active' : '';
    return `<div class="mention-item${active}" data-username="${opt.name}" data-everyone="1"><strong>${opt.label}</strong> <span class="mention-item-handle">${this._escapeHtml(opt.desc)}</span></div>`;
  }).join('');

  const roleItems = roleOptions.map((r, i) => {
    const active = (i === 0 && filtered.length === 0 && everyoneOptions.length === 0) ? ' active' : '';
    const dot = r.color ? `<span class="mention-role-dot" style="background:${this._escapeHtml(r.color)}"></span>` : '';
    return `<div class="mention-item${active}" data-username="${this._escapeHtml(r.name)}" data-role="1">${dot}<strong>@${this._escapeHtml(r.name)}</strong> <span class="mention-item-handle">${this._escapeHtml(t('settings.admin.mention_role_desc'))}</span></div>`;
  }).join('');

  const memberItems = filtered.map((m, i) => {
    const isFirstMember = (i === 0 && everyoneOptions.length === 0 && roleOptions.length === 0);
    const nick = m.id && this._nicknames ? this._nicknames[m.id] : '';
    const display = nick || m.username || m.loginName || '';
    const login = m.loginName || m.username || '';
    const suffix = (login && display.toLowerCase() !== login.toLowerCase())
      ? ` <span class="mention-item-handle">@${this._escapeHtml(login)}</span>`
      : '';
    return `<div class="mention-item${isFirstMember ? ' active' : ''}" data-username="${this._escapeHtml(login)}">${this._escapeHtml(display)}${suffix}</div>`;
  }).join('');

  dropdown.innerHTML = everyoneItems + roleItems + memberItems;

  dropdown.style.display = 'block';

  dropdown.querySelectorAll('.mention-item').forEach(item => {
    item.addEventListener('click', () => {
      this._insertMention(item.dataset.username);
    });
  });
},

_hideMentionDropdown() {
  const dropdown = document.getElementById('mention-dropdown');
  if (dropdown) dropdown.style.display = 'none';
  this.mentionStart = -1;
  this.mentionQuery = '';
},

_navigateMentionDropdown(direction) {
  const dropdown = document.getElementById('mention-dropdown');
  const items = dropdown.querySelectorAll('.mention-item');
  if (items.length === 0) return;

  let activeIdx = -1;
  items.forEach((item, i) => { if (item.classList.contains('active')) activeIdx = i; });

  items.forEach(item => item.classList.remove('active'));
  let next = activeIdx + direction;
  if (next < 0) next = items.length - 1;
  if (next >= items.length) next = 0;
  items[next].classList.add('active');
},

_insertMention(username) {
  const input = this._mentionInput || document.getElementById('message-input');
  const before = input.value.substring(0, this.mentionStart);
  const after = input.value.substring(input.selectionStart);
  input.value = before + '@' + username + ' ' + after;
  input.selectionStart = input.selectionEnd = this.mentionStart + username.length + 2;
  input.focus();
  this._hideMentionDropdown();
},

// ═══════════════════════════════════════════════════════
// #CHANNEL AUTOCOMPLETE
// ═══════════════════════════════════════════════════════

_checkChannelTrigger(inputEl) {
  const input = inputEl || document.getElementById('message-input');
  this._channelAcInput = input;
  const cursor = input.selectionStart;
  const text = input.value.substring(0, cursor);
  // Match a # that follows a non-word, non-# boundary, plus up to 50 trailing
  // chars allowed in channel-link names (letters, numbers, emoji, _ and -).
  // Spaces aren't allowed in the trigger query; channels with spaces are
  // resolved with underscores at insert time so the autolink regex picks
  // them up.
  const match = text.match(/(?:^|[^\w#&])#([\p{L}\p{N}\p{Emoji_Presentation}_-]{0,50})$/u);
  if (match && Array.isArray(this.channels) && this.channels.length) {
    // Anchor start at the '#' itself
    this.channelAcStart = cursor - match[1].length - 1;
    this.channelAcQuery = match[1].toLowerCase();
    this._showChannelDropdown();
  } else {
    this._hideChannelDropdown();
  }
},

_showChannelDropdown() {
  const dropdown = document.getElementById('channel-dropdown');
  if (!dropdown) return;
  const host = (this._channelAcInput && this._channelAcInput.parentElement) || null;
  if (host && dropdown.parentElement !== host) host.appendChild(dropdown);

  const query = this.channelAcQuery || '';
  const queryNormalized = query.replace(/_/g, ' ');

  // Filter to non-DM channels the user can see, matching by name (case
  // insensitive, accepting either spaces or underscores in the query).
  const filtered = (this.channels || [])
    .filter(c => c && c.name && c.code && !c.is_dm)
    .filter(c => {
      const n = String(c.name).toLowerCase();
      if (!query) return true;
      return n.includes(query) || n.includes(queryNormalized);
    })
    // Prefer prefix matches first
    .sort((a, b) => {
      const an = a.name.toLowerCase(), bn = b.name.toLowerCase();
      const aStarts = an.startsWith(query) || an.startsWith(queryNormalized) ? 0 : 1;
      const bStarts = bn.startsWith(query) || bn.startsWith(queryNormalized) ? 0 : 1;
      if (aStarts !== bStarts) return aStarts - bStarts;
      return an.localeCompare(bn);
    })
    .slice(0, 8);

  if (filtered.length === 0) {
    dropdown.style.display = 'none';
    return;
  }

  dropdown.innerHTML = filtered.map((c, i) => {
    const insertName = String(c.name).replace(/\s+/g, '_');
    return `<div class="mention-item${i === 0 ? ' active' : ''}" data-channel-insert="${this._escapeHtml(insertName)}"><strong>#${this._escapeHtml(c.name)}</strong></div>`;
  }).join('');
  dropdown.style.display = 'block';
  dropdown.querySelectorAll('.mention-item').forEach(item => {
    item.addEventListener('click', () => this._insertChannelMention(item.dataset.channelInsert));
  });
},

_hideChannelDropdown() {
  const dropdown = document.getElementById('channel-dropdown');
  if (dropdown) dropdown.style.display = 'none';
  this.channelAcStart = -1;
  this.channelAcQuery = '';
},

_navigateChannelDropdown(direction) {
  const dropdown = document.getElementById('channel-dropdown');
  if (!dropdown) return;
  const items = dropdown.querySelectorAll('.mention-item');
  if (items.length === 0) return;
  let activeIdx = -1;
  items.forEach((item, i) => { if (item.classList.contains('active')) activeIdx = i; });
  items.forEach(item => item.classList.remove('active'));
  let next = activeIdx + direction;
  if (next < 0) next = items.length - 1;
  if (next >= items.length) next = 0;
  items[next].classList.add('active');
},

_insertChannelMention(insertName) {
  const input = this._channelAcInput || document.getElementById('message-input');
  if (!input || this.channelAcStart < 0) return;
  const before = input.value.substring(0, this.channelAcStart);
  const after = input.value.substring(input.selectionStart);
  input.value = before + '#' + insertName + ' ' + after;
  input.selectionStart = input.selectionEnd = this.channelAcStart + insertName.length + 2;
  input.focus();
  this._hideChannelDropdown();
},

// ═══════════════════════════════════════════════════════
// EMOJI AUTOCOMPLETE  (:name)
// ═══════════════════════════════════════════════════════

_checkEmojiTrigger(inputEl) {
  const input = inputEl || document.getElementById('message-input');
  this._emojiAcInput = input;
  const text = input.value;
  const cursor = input.selectionStart;

  // Walk backwards from cursor to find a ':' that starts a potential emoji token
  let colonIdx = -1;
  for (let i = cursor - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === ':') { colonIdx = i; break; }
    if (ch === ' ' || ch === '\n') break; // stop at whitespace
  }

  // No emoji token under the cursor: bail and close any open dropdown. A
  // leading "::" counts as "no token": it's the persona trigger, and since no
  // emoji shortcode starts with ':', that colon can only belong to a persona.
  if (colonIdx === -1 || (colonIdx === 1 && text.startsWith('::'))) {
    this._hideEmojiDropdown();
    return;
  }

  const query = text.substring(colonIdx + 1, cursor).toLowerCase();
  if (query.length < 2) { this._hideEmojiDropdown(); return; }

  this._emojiColonStart = colonIdx;
  this._showEmojiDropdown(query);
},

_showEmojiDropdown(query) {
  // #emoji-dropdown is a single shared node re-parented next to the active
  // input (#5296). Opening the suggestions inside an inline message-edit box
  // parks it in that message; saving/cancelling the edit wipes the message's
  // HTML and deletes the node, so every later `:emoji` throws on the null
  // element and autocomplete dies until a refresh. The node holds no state
  // (its contents are rebuilt below), so recreate it if it's missing.
  let dd = document.getElementById('emoji-dropdown');
  if (!dd) {
    dd = document.createElement('div');
    dd.id = 'emoji-dropdown';
    dd.className = 'emoji-dropdown';
    dd.style.display = 'none';
  }
  // Re-parent so the absolute-positioned dropdown anchors above the active
  // input (works for thread input + DM PiP input + main input). (#5296)
  const host = (this._emojiAcInput && this._emojiAcInput.parentElement) || null;
  if (host && dd.parentElement !== host) host.appendChild(dd);
  dd.innerHTML = '';

  let results = [];

  // Bundled built-in image emoji first
  if (this.builtinEmojis) {
    this.builtinEmojis.forEach(em => {
      if (em.name.includes(query) || (em.keywords && em.keywords.toLowerCase().includes(query))) {
        results.push({ type: 'custom', name: em.name, url: em.url });
      }
    });
  }

  // Custom emojis
  if (this.customEmojis) {
    this.customEmojis.forEach(em => {
      if (em.name.toLowerCase().includes(query)) {
        results.push({ type: 'custom', name: em.name, url: em.url });
      }
    });
  }

  // Standard emojis by name/keyword
  if (this.emojiNames) {
    for (const [char, keywords] of Object.entries(this.emojiNames)) {
      if (keywords.toLowerCase().includes(query)) {
        results.push({ type: 'standard', name: keywords.split(' ')[0], char });
      }
      if (results.length >= 20) break;
    }
  }

  results = results.slice(0, 10);
  if (!results.length) { this._hideEmojiDropdown(); return; }

  results.forEach((r, i) => {
    const item = document.createElement('div');
    item.className = 'emoji-ac-item' + (i === 0 ? ' active' : '');
    const preview = document.createElement('span');
    preview.className = 'emoji-ac-preview';
    if (r.type === 'custom') {
      const img = document.createElement('img');
      img.src = r.url;
      img.alt = r.name;
      img.style.width = '20px'; img.style.height = '20px';
      preview.appendChild(img);
    } else {
      preview.classList.add('emoji-ac-preview-char');
      preview.textContent = r.char;
    }
    const nameSpan = document.createElement('span');
    nameSpan.className = 'emoji-ac-name';
    nameSpan.textContent = ':' + r.name + ':';
    item.appendChild(preview);
    item.appendChild(nameSpan);
    item.addEventListener('click', () => {
      if (r.type === 'custom') {
        this._insertEmojiAc(':' + r.name + ':');
      } else {
        this._insertEmojiAc(r.char);
      }
    });
    dd.appendChild(item);
  });

  dd.style.display = 'block';
},

_hideEmojiDropdown() {
  const dd = document.getElementById('emoji-dropdown');
  if (dd) dd.style.display = 'none';
},

_navigateEmojiDropdown(dir) {
  const dd = document.getElementById('emoji-dropdown');
  const items = dd.querySelectorAll('.emoji-ac-item');
  if (!items.length) return;
  let idx = -1;
  items.forEach((it, i) => { if (it.classList.contains('active')) idx = i; });
  items.forEach(it => it.classList.remove('active'));
  idx += dir;
  if (idx < 0) idx = items.length - 1;
  if (idx >= items.length) idx = 0;
  items[idx].classList.add('active');
  items[idx].scrollIntoView({ block: 'nearest' });
},

_insertEmojiAc(insert) {
  const input = this._emojiAcInput || document.getElementById('message-input');
  const before = input.value.substring(0, this._emojiColonStart);
  const after = input.value.substring(input.selectionStart);
  input.value = before + insert + ' ' + after;
  input.selectionStart = input.selectionEnd = this._emojiColonStart + insert.length + 1;
  input.focus();
  this._hideEmojiDropdown();
},

// ═══════════════════════════════════════════════════════
// SLASH COMMAND AUTOCOMPLETE
// ═══════════════════════════════════════════════════════

_checkSlashTrigger(inputEl) {
  const input = inputEl || document.getElementById('message-input');
  this._slashInput = input;
  const text = input.value;

  // Show slash suggestions while typing the command token, or a single
  // subcommand token (e.g. "/rss ad"). Hide once argument typing starts.
  if (text.startsWith('/') && text.length < 80) {
    const raw = text.substring(1);
    const trimmed = raw.trim();
    let query = '';
    if (!trimmed) {
      query = '';
    } else {
      const parts = trimmed.split(/\s+/);
      if (parts.length === 1) {
        query = parts[0].toLowerCase();
      } else if (parts.length === 2 && !raw.endsWith(' ')) {
        query = `${parts[0].toLowerCase()} ${parts[1].toLowerCase()}`;
      } else {
        this._hideSlashDropdown();
        return;
      }
    }
    this._showSlashDropdown(query);
  } else {
    this._hideSlashDropdown();
  }
},

_showSlashDropdown(query) {
  const dropdown = document.getElementById('slash-dropdown');
  // Re-parent so the absolute-positioned dropdown anchors above the active
  // input (works for thread input + DM PiP input + main input). (#5296)
  const host = (this._slashInput && this._slashInput.parentElement) || null;
  if (host && dropdown.parentElement !== host) host.appendChild(dropdown);
  const q = String(query || '').toLowerCase();
  // Bot commands carry the channel their bot is set up in and are only
  // offered there. Built-in commands have no channel and show everywhere (#5635).
  const offered = this.slashCommands.filter(c => !c.channelCodes || c.channelCodes.includes(this.currentChannel));
  const filtered = offered
    .filter(c => String(c.cmd || '').toLowerCase().startsWith(q))
    // For base queries like "rss", show "/rss add" before plain "/rss" so
    // discoverable subcommands appear first and users don't keep selecting the
    // generic base command by accident.
    .sort((a, b) => {
      if (!q || q.includes(' ')) return 0;
      const aCmd = String(a.cmd || '').toLowerCase();
      const bCmd = String(b.cmd || '').toLowerCase();
      const aSub = aCmd.startsWith(`${q} `) ? 1 : 0;
      const bSub = bCmd.startsWith(`${q} `) ? 1 : 0;
      if (aSub !== bSub) return bSub - aSub;
      return aCmd.localeCompare(bCmd);
    })
    .slice(0, 10);

  if (filtered.length === 0 || (query === '' && filtered.length === offered.length)) {
    // Show all on empty query
    if (query === '') {
      // show all
    } else {
      dropdown.style.display = 'none';
      return;
    }
  }

  const shown = query === '' ? offered.slice(0, 12) : filtered;

  dropdown.innerHTML = shown.map((c, i) =>
    `<div class="slash-item${i === 0 ? ' active' : ''}" data-cmd="${c.cmd}">
      <span class="slash-cmd">/${c.cmd}</span>
      ${c.args ? `<span class="slash-args">${this._escapeHtml(c.args)}</span>` : ''}
      <span class="slash-desc">${this._escapeHtml((c.descByChannel && c.descByChannel[this.currentChannel]) || c.desc)}</span>
    </div>`
  ).join('');

  dropdown.style.display = 'block';

  dropdown.querySelectorAll('.slash-item').forEach(item => {
    item.addEventListener('click', () => {
      this._insertSlashCommand(item.dataset.cmd);
    });
  });
},

_hideSlashDropdown() {
  const dropdown = document.getElementById('slash-dropdown');
  if (dropdown) dropdown.style.display = 'none';
},

_navigateSlashDropdown(direction) {
  const dropdown = document.getElementById('slash-dropdown');
  const items = dropdown.querySelectorAll('.slash-item');
  if (items.length === 0) return;

  let activeIdx = -1;
  items.forEach((item, i) => { if (item.classList.contains('active')) activeIdx = i; });

  items.forEach(item => item.classList.remove('active'));
  let next = activeIdx + direction;
  if (next < 0) next = items.length - 1;
  if (next >= items.length) next = 0;
  items[next].classList.add('active');
  items[next].scrollIntoView({ block: 'nearest' });
},

_insertSlashCommand(cmd) {
  const input = this._slashInput || document.getElementById('message-input');
  const cmdDef = this.slashCommands.find(c => c.cmd === cmd);
  const needsArg = cmdDef && cmdDef.args && cmdDef.args.startsWith('<');
  input.value = '/' + cmd + (needsArg ? ' ' : '');
  input.selectionStart = input.selectionEnd = input.value.length;
  input.focus();
  this._hideSlashDropdown();
  // If no args needed and not a "needs space" command, could auto-send
  // but user might want to add optional args, so just fill it in
},

};
