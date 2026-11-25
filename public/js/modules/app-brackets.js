// Bracket channels: in a channel with is_bracket set, single-elimination
// tournaments take the place of the message log. Anyone who may post starts
// a bracket; its creator or a moderator reports the results. The server works
// out every match (src/brackets.js), so this module only draws them.
//
// The tree is one column per round. Each match sits in a slot that takes an
// equal share of its column's height, so a slot in the next round is exactly
// as tall as the two it joins and the connector lines meet in the middle.

const BYE = -1;
const MAX_ENTRANTS = 64;

export default {

_isBracketChannel(code) {
  const ch = this.channels?.find(c => c.code === code);
  return !!(ch && ch.is_bracket && !ch.is_dm);
},

// Called by _renderMessages for a bracket channel. The bracket on show is
// kept while you stay in the channel.
_renderBrackets() {
  const container = document.getElementById('messages');
  if (!container) return;
  const code = this.currentChannel;
  if (!this._bracket || this._bracket.code !== code) this._bracket = { code, list: [], selected: null, canPost: false, canModerate: false, loaded: false, error: null, loadToken: 0 };
  this._channelView = 'bracket';
  container.classList.add('bracket-view');
  container.innerHTML = '<div class="br-root" id="br-root"></div>';
  const root = container.querySelector('#br-root');
  root.addEventListener('click', (e) => {
    const act = e.target.closest('[data-br-act]');
    const b = this._bracketCurrent();
    if (act) {
      const what = act.dataset.brAct;
      if (what === 'new') this._bracketOpenEditor(null);
      else if (what === 'edit' && b) this._bracketOpenEditor(b);
      else if (what === 'delete' && b) this._bracketDelete(b);
      return;
    }
    const match = e.target.closest('[data-br-match]');
    if (match && b) {
      const [r, s] = match.dataset.brMatch.split(':').map(Number);
      this._bracketOpenMatch(b, r, s);
    }
  });
  root.addEventListener('change', (e) => {
    if (!e.target.matches('.br-pick')) return;
    this._bracket.selected = Number(e.target.value);
    this._bracketDraw();
  });
  this._bracketDraw();
  this._bracketLoad();
},

_bracketLoad() {
  const st = this._bracket;
  if (!st || !this.socket) return;
  const token = st.loadToken + 1;
  st.loadToken = token;
  // A server without brackets never answers; say so instead of waiting.
  setTimeout(() => {
    if (this._bracket !== st || st.loadToken !== token || st.loaded) return;
    st.loaded = true;
    st.error = t('bracket.load_failed');
    this._bracketDraw();
  }, 10000);
  this.socket.emit('bracket-list', { code: st.code }, (res) => {
    if (this._bracket !== st || st.loadToken !== token) return;
    st.loaded = true;
    if (!res || res.error) {
      st.error = (res && res.error) || t('bracket.load_failed');
    } else {
      st.error = null;
      st.list = res.brackets || [];
      st.canPost = !!res.canPost;
      st.canModerate = !!res.canModerate;
    }
    this._bracketDraw();
  });
},

_bracketCurrent() {
  const st = this._bracket;
  if (!st) return null;
  return st.list.find(b => b.id === st.selected) || st.list[0] || null;
},

_bracketMayRun(b) {
  const st = this._bracket;
  return !!(st && (st.canModerate || (b.createdBy === this.user?.id && st.canPost)));
},

_bracketMayDelete(b) {
  const st = this._bracket;
  return !!(st && (st.canModerate || b.createdBy === this.user?.id));
},

// "Final", "Semifinals", "Quarterfinals", then "Round 1" and so on.
_bracketRoundName(b, r) {
  const fromEnd = b.rounds.length - 1 - r;
  return fromEnd === 0 ? t('bracket.final') : fromEnd === 1 ? t('bracket.semifinals') : fromEnd === 2 ? t('bracket.quarterfinals') : t('bracket.round', { n: r + 1 });
},

_bracketSideName(b, side) {
  return side === BYE ? t('bracket.bye') : side === null || side === undefined ? t('bracket.tbd') : b.entrants[side];
},

_bracketDraw() {
  const st = this._bracket;
  const root = document.getElementById('br-root');
  if (!st || !root || this._channelView !== 'bracket') return;
  const esc = (s) => this._escapeHtml(s);
  const b = this._bracketCurrent();
  const picker = st.list.length > 1 ? `
    <select class="br-pick settings-select" aria-label="${esc(t('bracket.pick'))}">${st.list.map(x => `<option value="${x.id}"${b && x.id === b.id ? ' selected' : ''}>${esc(x.title)}</option>`).join('')}</select>` : '';
  const status = st.error || (st.loaded ? '' : t('bracket.loading'));
  let body = '';
  if (!b) {
    body = st.loaded && !st.error ? `<p class="br-empty muted-text">${esc(t(st.canPost ? 'bracket.empty_can_add' : 'bracket.empty'))}</p>` : '';
  } else {
    const matches = b.rounds.flat().filter(m => !m.bye);
    const done = matches.filter(m => m.winner !== null).length;
    const run = this._bracketMayRun(b);
    const champ = b.champion !== null ? `<p class="br-champion">🏆 ${esc(t('bracket.champion', { name: b.entrants[b.champion] }))}</p>` : '';
    body = `
      <header class="br-head">
        <h2 class="br-title">${esc(b.title)}</h2>
        ${b.description ? `<p class="br-desc">${esc(b.description)}</p>` : ''}
        ${champ}
        <p class="br-meta muted-text">${esc(t('bracket.progress', { done, total: matches.length }))}${b.creatorName ? ` · ${esc(t('bracket.started_by', { name: b.creatorName }))}` : ''}</p>
        <div class="br-head-actions">
          ${run ? `<button type="button" class="btn-sm" data-br-act="edit">${esc(t('bracket.edit'))}</button>` : ''}
          ${this._bracketMayDelete(b) ? `<button type="button" class="btn-sm br-delete" data-br-act="delete">${esc(t('bracket.delete'))}</button>` : ''}
        </div>
      </header>
      <div class="br-tree" role="list">${b.rounds.map((round, r) => this._bracketDrawRound(b, round, r, run)).join('')}</div>`;
  }
  root.innerHTML = `
    <div class="br-toolbar">
      ${picker}
      <span class="br-spacer"></span>
      ${st.canPost ? `<button type="button" class="btn-sm btn-accent" data-br-act="new">＋ ${esc(t('bracket.new'))}</button>` : ''}
    </div>
    ${status ? `<p class="br-status muted-text">${esc(status)}</p>` : ''}
    ${body}`;
},

_bracketDrawRound(b, round, r, run) {
  const esc = (s) => this._escapeHtml(s);
  const side = (m, i) => {
    const who = m.sides[i];
    const cls = who === BYE || who === null ? 'br-tbd' : m.winner === null || m.bye ? '' : m.winner === i ? 'br-win' : 'br-lose';
    return `<span class="br-side ${cls}"><span class="br-seed">${who === null || who === BYE ? '' : who + 1}</span><span class="br-name">${esc(this._bracketSideName(b, who))}</span></span>`;
  };
  const slots = round.map(m => {
    const ready = !m.bye && m.sides[0] !== null && m.sides[1] !== null;
    const inner = `${side(m, 0)}${side(m, 1)}`;
    const cls = `br-match${m.bye ? ' br-bye' : ''}${m.winner !== null ? ' br-decided' : ''}`;
    const box = ready && run
      ? `<button type="button" class="${cls} br-playable" data-br-match="${m.round}:${m.slot}" aria-label="${esc(t('bracket.report_label', { a: b.entrants[m.sides[0]], b: b.entrants[m.sides[1]] }))}">${inner}</button>`
      : `<div class="${cls}">${inner}</div>`;
    return `<div class="br-slot${m.winner !== null ? ' br-slot-decided' : ''}">${box}${m.note ? `<span class="br-note">${esc(m.note)}</span>` : ''}</div>`;
  }).join('');
  return `<section class="br-round" role="listitem"><h3 class="br-round-name">${esc(this._bracketRoundName(b, r))}</h3><div class="br-matches">${slots}</div></section>`;
},

// Start a bracket (b null) or change one.
_bracketOpenEditor(b) {
  const st = this._bracket;
  if (!st) return;
  const esc = (s) => this._escapeHtml(s);
  const locked = !!(b && b.rounds.flat().some(m => !m.bye && m.winner !== null));
  const { overlay, close } = this._viewDialog('br-editor', `
    <h3>${esc(t(b ? 'bracket.edit_title' : 'bracket.new'))}</h3>
    <label class="br-field"><span>${esc(t('bracket.name'))}</span>
      <input type="text" class="settings-text-input" id="br-ed-title" maxlength="100" value="${esc(b ? b.title : '')}"></label>
    <label class="br-field"><span>${esc(t('bracket.description'))}</span>
      <textarea class="settings-text-input" id="br-ed-desc" maxlength="1000" rows="2">${esc(b ? b.description : '')}</textarea></label>
    <label class="br-field"><span>${esc(t('bracket.entrants'))}</span>
      <textarea class="settings-text-input br-entrants" id="br-ed-entrants" rows="8" spellcheck="false">${esc(b ? b.entrants.join('\n') : '')}</textarea></label>
    <div class="br-entrant-bar">
      <span class="br-count muted-text" aria-live="polite"></span>
      ${locked ? '' : `<button type="button" class="btn-sm" data-br-ed="shuffle">🔀 ${esc(t('bracket.shuffle'))}</button>`}
    </div>
    ${locked ? `<p class="br-hint muted-text">${esc(t('bracket.keep_results'))}</p>` : ''}
    <p class="br-error" role="alert" style="display:none"></p>
    <div class="modal-actions" style="margin-top:12px">
      <button type="button" class="btn-sm" data-br-ed="cancel">${esc(t('modals.common.cancel'))}</button>
      <button type="button" class="btn-sm btn-accent" data-br-ed="save">${esc(t('bracket.save'))}</button>
    </div>`);
  const $ = (sel) => overlay.querySelector(sel);
  const lines = () => $('#br-ed-entrants').value.split('\n').map(s => s.trim()).filter(Boolean);
  const count = () => { const n = lines().length; $('.br-count').textContent = t(n === 1 ? 'bracket.entrant_count_one' : 'bracket.entrant_count_other', { count: n }); };
  const error = $('.br-error');
  const fail = (msg) => { error.textContent = msg; error.style.display = ''; };
  $('#br-ed-entrants').addEventListener('input', count);
  count();
  $('#br-ed-title').focus();
  $('[data-br-ed="shuffle"]')?.addEventListener('click', () => {
    const names = lines();
    for (let i = names.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [names[i], names[j]] = [names[j], names[i]]; }
    $('#br-ed-entrants').value = names.join('\n');
  });
  $('[data-br-ed="cancel"]').addEventListener('click', close);
  $('[data-br-ed="save"]').addEventListener('click', () => {
    const entrants = lines();
    if (!$('#br-ed-title').value.trim()) return fail(t('bracket.need_name'));
    if (entrants.length < 2) return fail(t('bracket.need_entrants'));
    if (entrants.length > MAX_ENTRANTS) return fail(t('bracket.too_many', { count: MAX_ENTRANTS }));
    const payload = { title: $('#br-ed-title').value, description: $('#br-ed-desc').value, entrants };
    if (b) payload.id = b.id; else payload.code = st.code;
    this.socket.emit(b ? 'bracket-update' : 'bracket-create', payload, (res) => {
      // automod already told the sender why; the dialog stays open.
      if (res && res.blocked) return;
      if (!res || res.error) return fail(res?.error || t('bracket.save_failed'));
      this._bracketStore(res.bracket);
      st.selected = res.bracket.id;
      close();
      this._bracketDraw();
    });
  });
},

async _bracketDelete(b) {
  const ok = await this._showConfirmModal(t('bracket.delete_title', { title: b.title }), t('bracket.delete_body'), { danger: true });
  if (!ok) return;
  this.socket.emit('bracket-delete', { id: b.id }, (res) => {
    if (!res || res.error) this._showToast(res?.error || t('bracket.save_failed'), 'error');
  });
},

// Pick the winner of a match, with an optional note, or clear its result.
_bracketOpenMatch(b, round, slot) {
  const m = b.rounds[round] && b.rounds[round][slot];
  if (!m || m.bye || m.sides.includes(null)) return;
  const esc = (s) => this._escapeHtml(s);
  let winner = m.winner;
  const { overlay, close } = this._viewDialog('br-result', `
    <h3>${esc(this._bracketRoundName(b, round))}</h3>
    <p class="muted-text br-result-hint">${esc(t('bracket.pick_winner'))}</p>
    <div class="br-result-sides" role="group" aria-label="${esc(t('bracket.pick_winner'))}">
      ${[0, 1].map(i => `<button type="button" class="br-result-side" data-br-win="${i}"><span class="br-seed">${m.sides[i] + 1}</span> ${esc(b.entrants[m.sides[i]])}</button>`).join('')}
    </div>
    <label class="br-field"><span>${esc(t('bracket.note'))}</span>
      <input type="text" class="settings-text-input" id="br-res-note" maxlength="60" placeholder="${esc(t('bracket.note_placeholder'))}" value="${esc(m.note || '')}"></label>
    <p class="br-error" role="alert" style="display:none"></p>
    <div class="modal-actions" style="margin-top:12px">
      ${m.winner !== null ? `<button type="button" class="btn-sm br-delete" data-br-res="clear">${esc(t('bracket.clear_result'))}</button>` : ''}
      <button type="button" class="btn-sm" data-br-res="cancel">${esc(t('modals.common.cancel'))}</button>
      <button type="button" class="btn-sm btn-accent" data-br-res="save">${esc(t('bracket.save'))}</button>
    </div>`);
  overlay.dataset.brOpen = String(b.id);
  const $ = (sel) => overlay.querySelector(sel);
  const error = $('.br-error');
  const sync = () => overlay.querySelectorAll('[data-br-win]').forEach(btn => {
    const on = Number(btn.dataset.brWin) === winner;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', String(on));
  });
  overlay.querySelectorAll('[data-br-win]').forEach(btn => btn.addEventListener('click', () => { winner = Number(btn.dataset.brWin); sync(); }));
  sync();
  const send = (w) => {
    if (w === null && m.winner === null) { close(); return; }
    if (w !== 0 && w !== 1 && w !== null) { error.textContent = t('bracket.pick_winner'); error.style.display = ''; return; }
    this.socket.emit('bracket-result', { id: b.id, round, slot, winner: w, note: w === null ? '' : $('#br-res-note').value }, (res) => {
      if (res && res.blocked) return;
      if (!res || res.error) { error.textContent = res?.error || t('bracket.save_failed'); error.style.display = ''; return; }
      this._bracketStore(res.bracket);
      close();
      this._bracketDraw();
    });
  };
  $('[data-br-res="cancel"]').addEventListener('click', close);
  $('[data-br-res="save"]').addEventListener('click', () => send(winner));
  $('[data-br-res="clear"]')?.addEventListener('click', () => send(null));
},

// Puts a bracket from the server in the list, newest first.
_bracketStore(bracket) {
  const st = this._bracket;
  if (!st || !bracket) return;
  const at = st.list.findIndex(x => x.id === bracket.id);
  if (at >= 0) st.list[at] = bracket;
  else st.list = [bracket, ...st.list].sort((a, c) => c.id - a.id);
},

_listenBrackets() {
  this.socket.on('bracket-changed', (data) => {
    const st = this._bracket;
    if (!data || !data.bracket || !st || st.code !== data.channelCode) return;
    this._bracketStore(data.bracket);
    if (this.currentChannel === st.code) this._bracketDraw();
  });
  this.socket.on('bracket-removed', (data) => {
    const st = this._bracket;
    if (!data || !st || st.code !== data.channelCode) return;
    st.list = st.list.filter(x => x.id !== data.id);
    if (st.selected === data.id) st.selected = null;
    const open = document.querySelector('.view-modal-overlay');
    if (open && open.dataset.brOpen === String(data.id)) open.remove();
    if (this.currentChannel === st.code) this._bracketDraw();
  });
},

};
