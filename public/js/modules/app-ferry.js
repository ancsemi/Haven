// ── Ferry: the Haven <-> Discord bridge (client) ────────────────────────────
//
// Two unrelated surfaces share this file because they share one vocabulary:
//
//   Admin:  Settings → Server Admin → Ferry. Bot token, global toggles, and
//            the channel pairings that decide which Discord channels this
//            server can reach at all.
//
//   Member: the "=>" composer autocomplete. "=>" and not ">>" because a
//            leading ">" is Haven's blockquote marker, so a mistyped target
//            would quietly render as a quote instead of failing visibly.
//
// The member surface deliberately only ever sees pairings for the channel the
// user is standing in. The full list of Discord servers the bot belongs to is
// admin-only information and never reaches a normal member's client.

const FERRY_DIRECTIONS = [
  ['both',       'Two-way'],
  ['to_discord', 'Haven → Discord only'],
  ['to_haven',   'Discord → Haven only'],
];

const FERRY_MODES = [
  ['command', 'On command, only messages addressed with the prefix'],
  ['all',     'Mirror everything, every message in the channel'],
];

// Option-list builders. Written with plain concatenation rather than nested
// template literals so the <option> and <optgroup> markup stays readable.
function opt(value, label) {
  return '<option value="' + value + '">' + label + '</option>';
}

function group(label, inner) {
  return '<optgroup label="' + label + '">' + inner + '</optgroup>';
}

/**
 * Haven channels, with sub-channels nested under the channel they belong to.
 *
 * A flat list gives no way to tell a channel from a sub-channel, and Haven
 * allows the same display name under two different parents, so a flat list can
 * show two identical entries with no way to pick the right one.
 */
function buildChannelOptions(parents, subsByParent, orphans, esc) {
  const sorted = [...parents].sort((a, b) => a.name.localeCompare(b.name));
  let html = '';

  for (const p of sorted) {
    const kids = (subsByParent.get(p.id) || []).sort((a, b) => a.name.localeCompare(b.name));
    const self = opt(esc(p.code), '#' + esc(p.name));
    if (!kids.length) { html += self; continue; }
    const kidHtml = kids.map(k => opt(esc(k.code), '  ↳ ' + esc(k.name))).join('');
    html += group('#' + esc(p.name), self + kidHtml);
  }

  // A sub-channel whose parent is not visible to this admin would otherwise
  // vanish from the list entirely.
  if (orphans.length) {
    html += group('Other', orphans.map(c => opt(esc(c.code), '#' + esc(c.name))).join(''));
  }
  return html;
}

/** Discord channels, grouped by their Discord category. */
function buildDiscordChannelOptions(guild, esc) {
  const byCategory = new Map();
  for (const c of (guild && guild.channels) || []) {
    const key = c.category || 'No category';
    if (!byCategory.has(key)) byCategory.set(key, []);
    byCategory.get(key).push(c);
  }
  let html = opt('', 'Pick one...');
  for (const [cat, chans] of byCategory) {
    html += group(esc(cat), chans.map(c => opt(esc(c.id), '#' + esc(c.name))).join(''));
  }
  return html;
}

export default {

  // ══════════════════════════════════════════════════════════
  // Socket wiring
  // ══════════════════════════════════════════════════════════

  _setupFerrySocket() {
    if (!this.socket || this._ferrySocketReady) return;
    this._ferrySocketReady = true;

    this.socket.on('ferry:config', (payload) => {
      this._ferryConfig = payload;
      this._renderFerryModal();
      this._renderFerrySummary();
    });

    this.socket.on('ferry:token-ok', (data) => {
      this._ferryInvite = data.inviteUrl;
      this._showToast(`Connected as ${data.bot?.username || 'the bot'}. Invite it to your Discord server next.`, 'success');
    });

    this.socket.on('ferry:targets', (data) => {
      if (!this._ferryTargets) this._ferryTargets = {};
      this._ferryTargets[data.code] = data;
      // The list usually arrives while the dropdown is already open on a bare
      // "=>", so repaint rather than waiting for the next keystroke.
      if (this._ferryOpen) this._showFerryDropdown();
    });

    this.socket.on('ferry:search-users', (data) => {
      if (data.query !== this._ferryUserQuery) return;  // a stale, slower response
      this._ferryUserResults = data.results || [];
      if (this._ferryOpen) this._showFerryDropdown();
    });
  },

  // ══════════════════════════════════════════════════════════
  // Composer autocomplete
  // ══════════════════════════════════════════════════════════

  _ferryTrigger() {
    const code = this.currentChannel;
    return (this._ferryTargets?.[code]?.trigger) || '=>';
  },

  _checkFerryTrigger(inputEl) {
    const input = inputEl || document.getElementById('message-input');
    if (!input) return;

    // Pairings are per non-DM channel, so a DM composer has nothing to offer.
    const ch = this.channels?.find(c => c.code === this.currentChannel);
    if (!ch || ch.is_dm) { this._hideFerryDropdown(); return; }

    this._ferryInput = input;
    const trigger = this._ferryTrigger();

    // The ferry prefix may follow a persona prefix ("::Alter =>Server#chan hi"),
    // matching how the server resolves the two in that order.
    let text = input.value;
    let offset = 0;
    const personaMatch = text.match(/^::[^\s:]+[: ]\s*/);
    if (personaMatch) { offset = personaMatch[0].length; text = text.slice(offset); }
    this._ferryOffset = offset;

    if (!text.startsWith(trigger)) { this._hideFerryDropdown(); return; }
    const rest = text.slice(trigger.length);

    // Once the target is chosen and a space typed, the user is writing the
    // message body and the dropdown must get out of the way.
    if (this._ferryTargetChosen && rest.startsWith(this._ferryTargetChosen)) {
      this._hideFerryDropdown();
      return;
    }
    this._ferryTargetChosen = null;

    if (!this._ferryTargets?.[this.currentChannel]) {
      this.socket.emit('ferry:targets', { code: this.currentChannel });
    }

    if (rest.startsWith('@')) {
      const q = rest.slice(1);
      this._ferryMode = 'dm';
      this._ferryQuery = q;
      // Discord charges a real API call per lookup, so debounce and require
      // enough characters to be worth asking about.
      if (q.trim().length >= 2 && q !== this._ferryUserQuery) {
        clearTimeout(this._ferryUserTimer);
        this._ferryUserTimer = setTimeout(() => {
          this._ferryUserQuery = q;
          this._ferryUserResults = null;
          this.socket.emit('ferry:search-users', { code: this.currentChannel, query: q });
        }, 250);
      }
    } else {
      if (rest.includes(' ')) { this._hideFerryDropdown(); return; }
      this._ferryMode = 'channel';
      this._ferryQuery = rest;
    }

    this._showFerryDropdown();
  },

  _showFerryDropdown() {
    const dropdown = document.getElementById('ferry-dropdown');
    if (!dropdown) return;

    const host = (this._ferryInput && this._ferryInput.parentElement) || null;
    if (host && dropdown.parentElement !== host) host.appendChild(dropdown);

    const data = this._ferryTargets?.[this.currentChannel];
    const esc = (s) => this._escapeHtml(String(s ?? ''));

    if (!data) {
      dropdown.innerHTML = `<div class="mention-item"><span class="mention-item-handle">Loading Discord destinations...</span></div>`;
      dropdown.style.display = 'block';
      this._ferryOpen = true;
      return;
    }

    if (!data.enabled || !data.targets?.length) {
      dropdown.innerHTML = `<div class="mention-item"><strong>No Discord destinations</strong> <span class="mention-item-handle">an admin pairs channels in Settings → Ferry</span></div>`;
      dropdown.style.display = 'block';
      this._ferryOpen = true;
      return;
    }

    let rows = [];

    if (this._ferryMode === 'dm') {
      if (!data.allowDms) {
        dropdown.innerHTML = `<div class="mention-item"><span class="mention-item-handle">Discord DMs are turned off on this server</span></div>`;
        dropdown.style.display = 'block';
        this._ferryOpen = true;
        return;
      }
      const q = (this._ferryQuery || '').trim();
      if (q.length < 2) {
        rows = [`<div class="mention-item"><span class="mention-item-handle">Keep typing a Discord name to search</span></div>`];
      } else if (this._ferryUserResults === null || this._ferryUserResults === undefined) {
        rows = [`<div class="mention-item"><span class="mention-item-handle">Searching Discord...</span></div>`];
      } else if (!this._ferryUserResults.length) {
        rows = [`<div class="mention-item"><span class="mention-item-handle">No Discord members matched "${esc(q)}"</span></div>`];
      } else {
        rows = this._ferryUserResults.slice(0, 8).map((u, i) => `
          <div class="mention-item${i === 0 ? ' active' : ''}" data-ferry-dm-id="${esc(u.id)}" data-ferry-dm-name="${esc(u.name)}">
            <img src="${esc(u.avatar)}" class="persona-dd-avatar" alt="">
            <strong>${esc(u.name)}</strong>
            <span class="mention-item-handle">DM on Discord</span>
          </div>`);
      }
    } else {
      const q = (this._ferryQuery || '').toLowerCase();
      const matches = data.targets.filter(t => {
        const full = `${t.guild_name}#${t.discord_channel_name}`.toLowerCase();
        return !q || full.startsWith(q) || `#${t.discord_channel_name}`.toLowerCase().startsWith(q);
      });

      rows = matches.slice(0, 8).map((t, i) => `
        <div class="mention-item${i === 0 ? ' active' : ''}" data-ferry-label="${esc(t.guild_name)}#${esc(t.discord_channel_name)}">
          <strong>#${esc(t.discord_channel_name)}</strong>
          <span class="mention-item-handle">${esc(t.guild_name)}${t.out_mode === 'all' ? ' · mirrored' : ''}</span>
        </div>`);

      // Offer the DM path only when it can actually work, so nobody discovers
      // "=>@" and then finds out the admin never enabled it.
      if (data.allowDms && (!q || '@'.startsWith(q))) {
        rows.push(`
          <div class="mention-item${rows.length === 0 ? ' active' : ''}" data-ferry-dm-start="1">
            <strong>@ Direct message</strong>
            <span class="mention-item-handle">send to one Discord user</span>
          </div>`);
      }

      if (!rows.length) {
        rows = [`<div class="mention-item"><span class="mention-item-handle">No destination matches "${esc(this._ferryQuery)}"</span></div>`];
      }
    }

    dropdown.innerHTML = rows.join('');
    dropdown.style.display = 'block';
    this._ferryOpen = true;

    dropdown.querySelectorAll('[data-ferry-label]').forEach(el => {
      el.addEventListener('click', () => this._insertFerryTarget(el.dataset.ferryLabel));
    });
    dropdown.querySelectorAll('[data-ferry-dm-start]').forEach(el => {
      el.addEventListener('click', () => this._insertFerryTarget('@', true));
    });
    dropdown.querySelectorAll('[data-ferry-dm-id]').forEach(el => {
      el.addEventListener('click', () => {
        const label = '@' + el.dataset.ferryDmName;
        // The id is bound to the exact text inserted, not just remembered. A
        // bare remembered id survives the user editing the name afterwards and
        // sends a private message to whoever was picked before, which is the
        // worst possible way for this to be wrong.
        this._ferryDm = { id: el.dataset.ferryDmId, label };
        this._insertFerryTarget(label);
      });
    });
  },

  _hideFerryDropdown() {
    const dropdown = document.getElementById('ferry-dropdown');
    if (dropdown) dropdown.style.display = 'none';
    this._ferryOpen = false;
  },

  _navigateFerryDropdown(direction) {
    const dropdown = document.getElementById('ferry-dropdown');
    if (!dropdown) return;
    const items = dropdown.querySelectorAll('.mention-item');
    if (!items.length) return;
    let active = -1;
    items.forEach((item, i) => { if (item.classList.contains('active')) active = i; });
    items.forEach(item => item.classList.remove('active'));
    let next = active + direction;
    if (next < 0) next = items.length - 1;
    if (next >= items.length) next = 0;
    items[next].classList.add('active');
    items[next].scrollIntoView({ block: 'nearest' });
  },

  /**
   * Replaces the partially typed target with the full one. `keepOpen` is for
   * the "@ Direct message" row, which is a step in the flow rather than a
   * finished choice, so the dropdown stays up for the name search.
   */
  _insertFerryTarget(label, keepOpen = false) {
    const input = this._ferryInput || document.getElementById('message-input');
    if (!input) return;

    const trigger = this._ferryTrigger();
    const offset = this._ferryOffset || 0;
    const prefix = input.value.slice(0, offset);
    const rest = input.value.slice(offset);

    // Anything the user typed after the target (rare, but possible when they
    // go back and edit) is preserved rather than discarded.
    const afterTarget = rest.includes(' ') ? rest.slice(rest.indexOf(' ') + 1) : '';
    const suffix = keepOpen ? '' : ' ';

    input.value = `${prefix}${trigger}${label}${suffix}${afterTarget}`;
    input.focus();
    const caret = prefix.length + trigger.length + label.length + suffix.length;
    input.setSelectionRange(caret, caret);

    if (keepOpen) {
      this._ferryMode = 'dm';
      this._ferryQuery = '';
      this._ferryUserResults = null;
      this._showFerryDropdown();
    } else {
      this._ferryTargetChosen = label;
      this._hideFerryDropdown();
    }

    input.dispatchEvent(new Event('input', { bubbles: true }));
  },

  /**
   * The Discord user id for a pending DM, handed to the server alongside the
   * message. Discord display names are not unique, so the id has to travel
   * with the send rather than being re-derived from the typed name.
   */
  _ferryPendingDm(content) {
    const trigger = this._ferryTrigger();
    const body = content.replace(/^::[^\s:]+[: ]\s*/, '');
    if (!body.startsWith(trigger + '@')) return undefined;

    const chosen = this._ferryDm;
    if (!chosen) return undefined;

    // Only hand over the id when the recipient text is still exactly the one
    // that was picked. Anything else drops it, and the server then leaves the
    // prefix visible in the message rather than sending to the wrong person.
    const rest = body.slice(trigger.length);
    return (rest === chosen.label || rest.startsWith(chosen.label + ' ')) ? chosen.id : undefined;
  },

  // ══════════════════════════════════════════════════════════
  // Admin panel
  // ══════════════════════════════════════════════════════════

  _openFerryModal() {
    const modal = document.getElementById('ferry-modal');
    if (!modal) return;
    modal.style.display = 'flex';
    this.socket.emit('ferry:get-config');
    this._renderFerryModal();
  },

  _closeFerryModal() {
    const modal = document.getElementById('ferry-modal');
    if (modal) modal.style.display = 'none';
  },

  /** The one-line status under the Ferry button in the admin settings list. */
  _renderFerrySummary() {
    const el = document.getElementById('ferry-summary');
    if (!el) return;
    const s = this._ferryConfig?.state;
    if (!s || !s.hasToken) { el.textContent = 'Not configured'; return; }
    if (!s.enabled) { el.textContent = 'Configured, currently off'; return; }
    const links = this._ferryConfig.links?.length || 0;
    el.textContent = s.connected
      ? `Connected · ${s.guildCount} Discord server${s.guildCount === 1 ? '' : 's'} · ${links} pairing${links === 1 ? '' : 's'}`
      : (s.lastError || 'Connecting to Discord...');
  },

  /**
   * Laid out as the order an admin actually does things: connect the bot,
   * invite it, switch it on, pair channels. A step that cannot be done yet is
   * shown as locked rather than hidden, so the whole path is visible up front
   * instead of appearing one piece at a time.
   */
  _renderFerryModal() {
    const body = document.getElementById('ferry-modal-body');
    if (!body) return;

    const cfg = this._ferryConfig;
    if (!cfg) { body.innerHTML = `<p class="muted-text">Loading...</p>`; return; }

    const esc = (v) => this._escapeHtml(String(v ?? ''));
    const st = cfg.state;

    const done = (ok) => ok ? ' ferry-step-done' : '';
    const lock = (ok) => ok ? '' : ' ferry-step-locked';

    // Toggles have to be `.toggle-row > input[type=checkbox]` to pick up the
    // slider styling the rest of Haven uses. Any other wrapper renders as a
    // bare checkbox and looks out of place next to every other setting.
    const toggle = (key, label, hint, on, disabled) => `
      <label class="toggle-row" style="margin-top:10px">
        <span>${label}</span>
        <input type="checkbox" data-ferry-toggle="${key}"${on ? ' checked' : ''}${disabled ? ' disabled' : ''}>
      </label>
      <small class="settings-hint">${hint}</small>`;

    let step1Status;
    if (!st.hasToken) {
      step1Status = `<p class="muted-text">No token saved yet.</p>`;
    } else if (st.connected) {
      step1Status = `<p class="ferry-status-ok">Connected as <strong>${esc(st.bot && st.bot.username)}</strong>, in ${st.guildCount} Discord server${st.guildCount === 1 ? '' : 's'}.</p>`;
    } else {
      step1Status = `<p class="ferry-status-bad">${esc(st.lastError || 'Connecting to Discord...')}</p>`;
    }

    const linkRows = (cfg.links || []).map(l => `
      <tr data-ferry-link="${l.id}"${l.is_active ? '' : ' class="ferry-row-off"'}>
        <td><strong>#${esc(l.channel_name)}</strong></td>
        <td>${esc(l.guild_name)}<br><span class="muted-text">#${esc(l.discord_channel_name)}</span></td>
        <td>
          <select class="form-select ferry-mini" data-ferry-field="direction">
            ${FERRY_DIRECTIONS.map(([v, t]) => `<option value="${v}"${l.direction === v ? ' selected' : ''}>${t}</option>`).join('')}
          </select>
        </td>
        <td>
          <select class="form-select ferry-mini" data-ferry-field="outMode"${l.direction === 'to_haven' ? ' disabled' : ''}>
            ${FERRY_MODES.map(([v, t]) => `<option value="${v}"${l.out_mode === v ? ' selected' : ''}>${t}</option>`).join('')}
          </select>
        </td>
        <td class="ferry-actions-cell"><div class="ferry-actions-inner">
          <label class="toggle-row"><span>On</span><input type="checkbox" data-ferry-field="isActive"${l.is_active ? ' checked' : ''}></label>
          <button class="btn-sm btn-danger" data-ferry-delete="${l.id}">Remove</button>
          ${l.last_error ? `<div class="ferry-link-error">${esc(l.last_error)}</div>` : ''}
        </div></td>
      </tr>`).join('');

    // A flat list mixes top-level channels with sub-channels and gives no way
    // to tell them apart, and Haven allows the same display name under two
    // different parents. Grouping by parent restores the structure.
    const allChannels = (this.channels || []).filter(c => !c.is_dm);
    const parents = allChannels.filter(c => !c.parent_channel_id);
    const subsByParent = new Map();
    for (const c of allChannels) {
      if (!c.parent_channel_id) continue;
      if (!subsByParent.has(c.parent_channel_id)) subsByParent.set(c.parent_channel_id, []);
      subsByParent.get(c.parent_channel_id).push(c);
    }
    const orphans = allChannels.filter(c => c.parent_channel_id && !parents.some(x => x.id === c.parent_channel_id));
    const channelOptions = buildChannelOptions(parents, subsByParent, orphans, esc);
    const guildOptions = (cfg.guilds || []).map(g => `<option value="${esc(g.id)}">${esc(g.name)}</option>`).join('');

    const inviteBlock = this._ferryInvite
      ? `<small class="settings-hint">Open this link, pick your server, and leave the permissions as they are.</small>
         <div class="ferry-invite"><a href="${esc(this._ferryInvite)}" target="_blank" rel="noopener noreferrer">${esc(this._ferryInvite)}</a></div>`
      : st.connected
        ? `<small class="settings-hint">The bot is already in ${st.guildCount} server${st.guildCount === 1 ? '' : 's'}. To add it to another, press Reconnect below to regenerate the invite link.</small>`
        : `<small class="settings-hint">The invite link appears here once a token is saved.</small>`;

    const pairForm = st.connected
      ? `<div class="ferry-add-grid">
           <label><span>Haven channel</span>
             <select id="ferry-add-channel" class="form-select">
               <option value="">Pick one...</option>
                ${channelOptions}
             </select>
           </label>
           <label><span>Discord server</span>
             <select id="ferry-add-guild" class="form-select">
               <option value="">Pick one...</option>
               ${guildOptions}
             </select>
           </label>
           <label><span>Discord channel</span>
             <select id="ferry-add-dchannel" class="form-select"><option value="">Pick a server first...</option></select>
           </label>
           <label><span>Direction</span>
             <select id="ferry-add-direction" class="form-select">
               ${FERRY_DIRECTIONS.map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}
             </select>
           </label>
           <label class="ferry-add-wide"><span>Outgoing messages</span>
             <select id="ferry-add-mode" class="form-select">
               ${FERRY_MODES.map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}
             </select>
           </label>
           <button class="btn-sm btn-accent ferry-add-btn" id="ferry-add-btn">Add pairing</button>
         </div>`
      : `<p class="muted-text">Connect the bot first.</p>`;

    const pairTable = (cfg.links || []).length
      ? `<table class="ferry-table">
           <thead><tr><th>Haven</th><th>Discord</th><th>Direction</th><th>Outgoing</th><th></th></tr></thead>
           <tbody>${linkRows}</tbody>
         </table>`
      : `<p class="muted-text" style="margin-top:10px">No pairings yet.</p>`;

    // No role holds use_ferry by default, so without this an admin sets Ferry
    // up, tests it successfully as an admin, and it silently does nothing for
    // everyone else with no indication why.
    const roles = cfg.roles || [];
    const roleRows = roles.length
      ? roles.map(r => '<label class="toggle-row" style="margin-top:8px">'
          + '<span><span class="ferry-role-dot" style="background:' + esc(r.color || '#888') + '"></span>'
          + esc(r.name) + '</span>'
          + '<input type="checkbox" data-ferry-role="' + r.id + '"' + (r.can_ferry ? ' checked' : '') + '>'
          + '</label>').join('')
      : '<p class="muted-text">No roles exist yet.</p>';

    const publicUrlWarning = st.publicUrlSet
      ? ''
      : `<small class="settings-hint ferry-warn">PUBLIC_URL is not set in your .env, so Haven avatars and uploaded images will not show on the Discord side. Names still come through.</small>`;

    body.innerHTML = `
      <div class="ferry-step${done(st.hasToken)}">
        <h5 class="ferry-step-title"><span class="ferry-step-num">1</span> Connect your Discord bot</h5>
        <small class="settings-hint">
          At <strong>discord.com/developers/applications</strong>: New Application, then the
          <strong>Bot</strong> tab. Turn on <strong>Message Content Intent</strong>, press Reset Token, and paste it here.
        </small>
        <div class="ferry-token-row">
          <input type="password" id="ferry-token-input" class="settings-input"
                 placeholder="${st.hasToken ? esc(cfg.tokenHint) : 'Paste your bot token'}" autocomplete="off">
          <button class="btn-sm btn-accent" id="ferry-token-save">${st.hasToken ? 'Replace' : 'Save'}</button>
          ${st.hasToken ? `<button class="btn-sm btn-danger" id="ferry-token-clear">Remove</button>` : ''}
        </div>
        ${step1Status}
      </div>

      <div class="ferry-step${lock(st.hasToken)}">
        <h5 class="ferry-step-title"><span class="ferry-step-num">2</span> Invite the bot to your Discord server</h5>
        ${inviteBlock}
      </div>

      <div class="ferry-step${lock(st.hasToken)}">
        <h5 class="ferry-step-title"><span class="ferry-step-num">3</span> Turn Ferry on</h5>
        ${toggle('ferry_enabled', 'Ferry is on', 'Master switch. Nothing crosses in either direction while this is off.', st.enabled, !st.hasToken)}
      </div>

      <div class="ferry-step${lock(st.connected)}">
        <h5 class="ferry-step-title"><span class="ferry-step-num">4</span> Pair your channels</h5>
        <small class="settings-hint">
          Members can only reach Discord channels paired with the Haven channel they are standing in, and
          only if their role has the <strong>Send to Discord</strong> permission.
        </small>
        ${pairForm}
        ${pairTable}
      </div>

      <div class="ferry-step${lock(st.connected)}">
        <h5 class="ferry-step-title"><span class="ferry-step-num">5</span> Choose who can send</h5>
        <small class="settings-hint">
          Ferry does nothing for a member until one of their roles is switched on here. Admins can always
          send. This is the same <strong>Send to Discord</strong> permission that appears under Roles.
        </small>
        ${roleRows}
      </div>

      <details class="ferry-step ferry-options">
        <summary class="ferry-step-title">Options</summary>
        ${toggle('ferry_allow_personas', 'Allow persona names', 'Off means a relayed message always carries the sender&#39;s real Haven name.', st.allowPersonas, false)}
        ${toggle('ferry_allow_dms', 'Allow Discord DMs', 'Lets members send a one-way DM to a Discord user. Replies stay in Discord. Needs the Server Members Intent.', st.allowDms, false)}
        ${toggle('ferry_allow_mentions', 'Allow pings', 'Off means relayed messages never ping anyone on Discord.', st.allowMentions, false)}
        ${toggle('ferry_relay_bots', 'Relay other bots', 'Off means messages from Discord bots are ignored. On can flood a Haven channel.', st.relayBots, false)}
        ${publicUrlWarning}
      </details>
    `;

    this._bindFerryModal();
  },

  _bindFerryModal() {
    const cfg = this._ferryConfig;
    const body = document.getElementById('ferry-modal-body');
    if (!body || !cfg) return;

    body.querySelector('#ferry-token-save')?.addEventListener('click', () => {
      const input = document.getElementById('ferry-token-input');
      const token = (input?.value || '').trim();
      if (!token) return this._showToast('Paste a bot token first', 'warning');
      this.socket.emit('ferry:set-token', { token });
      input.value = '';
    });

    body.querySelector('#ferry-token-clear')?.addEventListener('click', () => {
      if (!confirm('Remove the Discord bot token? Ferry stops immediately. Your pairings are kept.')) return;
      this.socket.emit('ferry:clear-token');
    });

    body.querySelectorAll('[data-ferry-role]').forEach(el => {
      el.addEventListener('change', () => {
        this.socket.emit('ferry:set-role-permission', {
          roleId: parseInt(el.dataset.ferryRole), allowed: el.checked });
      });
    });

    body.querySelectorAll('[data-ferry-toggle]').forEach(el => {
      el.addEventListener('change', () => {
        this.socket.emit('ferry:set-option', { key: el.dataset.ferryToggle, value: el.checked });
      });
    });

    // Existing pairings: any control change saves that row.
    body.querySelectorAll('tr[data-ferry-link]').forEach(row => {
      const id = parseInt(row.dataset.ferryLink);
      row.querySelectorAll('[data-ferry-field]').forEach(field => {
        field.addEventListener('change', () => {
          this.socket.emit('ferry:update-link', {
            id,
            direction: row.querySelector('[data-ferry-field="direction"]')?.value,
            outMode: row.querySelector('[data-ferry-field="outMode"]')?.value,
            isActive: row.querySelector('[data-ferry-field="isActive"]')?.checked,
          });
        });
      });
    });

    body.querySelectorAll('[data-ferry-delete]').forEach(btn => {
      btn.addEventListener('click', () => {
        if (!confirm('Remove this pairing? Messages stop crossing between those two channels.')) return;
        this.socket.emit('ferry:delete-link', { id: parseInt(btn.dataset.ferryDelete) });
      });
    });

    // The Discord channel list depends on which server is picked.
    const guildSel = body.querySelector('#ferry-add-guild');
    const dChanSel = body.querySelector('#ferry-add-dchannel');
    guildSel?.addEventListener('change', () => {
      const guild = (cfg.guilds || []).find(g => g.id === guildSel.value);
      const esc = (s) => this._escapeHtml(String(s ?? ''));
      dChanSel.innerHTML = buildDiscordChannelOptions(guild, (v) => this._escapeHtml(String(v ?? "")));
    });

    body.querySelector('#ferry-add-btn')?.addEventListener('click', () => {
      const channelCode = body.querySelector('#ferry-add-channel')?.value;
      const guildId = guildSel?.value;
      const discordChannelId = dChanSel?.value;
      if (!channelCode || !guildId || !discordChannelId) {
        return this._showToast('Pick a Haven channel, a Discord server, and a Discord channel', 'warning');
      }
      this.socket.emit('ferry:create-link', {
        channelCode, guildId, discordChannelId,
        direction: body.querySelector('#ferry-add-direction')?.value,
        outMode: body.querySelector('#ferry-add-mode')?.value,
      });
    });
  },
};
