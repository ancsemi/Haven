// Docs channels: in a channel with is_docs set, written documents take the
// place of the message log. The list of documents sits beside the one being
// read; on a phone the two take turns. A document is Markdown, drawn by the
// same formatter as messages.
//
// Editing happens in place. What you type is kept in this browser as a draft
// until it is saved, so switching channels or reloading loses nothing. Every
// save names the version it started from: when someone else saved first, the
// server refuses it and you choose between saving yours over theirs and
// reading theirs. Who may do what is decided by the server
// (src/socketHandlers/docs.js); this module only hides what would be refused.

const DRAFT_PREFIX = 'haven_doc_draft:';
const MAX_TITLE = 120;
const MAX_BODY = 50000;
const MAX_BYTES = 63000;
const PHONE = '(max-width: 768px)';
const TOOLS = [['bold', 'B'], ['italic', 'I'], ['strike', 'S'], ['h1', 'H1'], ['h2', 'H2'], ['quote', '❝'], ['list', '•'], ['numbered', '1.'], ['code', '</>']];

export default {

_isDocsChannel(code) {
  const ch = this.channels?.find(c => c.code === code);
  return !!(ch && ch.is_docs && !ch.is_dm);
},

// Called by _renderMessages for a docs channel. Each channel keeps what was
// open (and any edit in progress) while the app runs.
_renderDocs() {
  const container = document.getElementById('messages');
  if (!container) return;
  const code = this.currentChannel;
  this._docStates = this._docStates || new Map();
  if (!this._docStates.has(code)) this._docStates.set(code, { code, list: [], openId: null, doc: null, editing: null, canPost: false, canModerate: false, loaded: false, error: null, loadToken: 0, filter: '' });
  const st = this._docStates.get(code);
  this._docs = st;
  this._channelView = 'docs';
  container.classList.add('docs-view');
  const esc = (s) => this._escapeHtml(s);
  container.innerHTML = `
    <div class="dc-root" id="dc-root">
      <aside class="dc-side" aria-label="${esc(t('docs.list_label'))}">
        <div class="dc-new-slot"></div>
        <input type="search" class="dc-search settings-text-input" placeholder="${esc(t('docs.search'))}" aria-label="${esc(t('docs.search'))}" hidden>
        <p class="dc-status muted-text" hidden></p>
        <ul class="dc-list"></ul>
      </aside>
      <section class="dc-main"></section>
    </div>`;
  const root = container.querySelector('#dc-root');
  root.querySelector('.dc-search').value = st.filter;
  // Formatting buttons keep the focus (and the selection) in the text box.
  root.addEventListener('mousedown', (e) => { if (e.target.closest('[data-dc-fmt]')) e.preventDefault(); });
  root.addEventListener('click', (e) => {
    const fmt = e.target.closest('[data-dc-fmt]');
    if (fmt) return this._docFormat(root.querySelector('.dc-ed-body'), fmt.dataset.dcFmt);
    const act = e.target.closest('[data-dc-act]');
    if (act) return this._docAct(act.dataset.dcAct);
    const item = e.target.closest('[data-dc-open]');
    if (item) this._docOpen(Number(item.dataset.dcOpen));
  });
  root.addEventListener('input', (e) => {
    const ed = st.editing;
    if (e.target.matches('.dc-search')) { st.filter = e.target.value; this._docDrawList(); return; }
    if (!ed) return;
    if (e.target.matches('.dc-ed-title')) ed.cur.title = e.target.value;
    else if (e.target.matches('.dc-ed-body')) { ed.cur.body = e.target.value; this._docCount(); }
    else return;
    this._docKeep();
  });
  root.addEventListener('change', (e) => {
    if (!e.target.matches('.dc-ed-shared') || !st.editing) return;
    st.editing.cur.shared = e.target.checked;
    this._docKeep();
  });
  root.addEventListener('keydown', (e) => {
    if (!st.editing || !e.target.matches('.dc-ed-title, .dc-ed-body')) return;
    const mod = (e.ctrlKey || e.metaKey) && !e.altKey;
    const key = e.key.toLowerCase();
    if (mod && key === 's') { e.preventDefault(); this._docSave(); return; }
    if (!e.target.matches('.dc-ed-body')) return;
    if (mod && (key === 'b' || key === 'i')) { e.preventDefault(); this._docFormat(e.target, key === 'b' ? 'bold' : 'italic'); return; }
    if (this._composerListKey?.(e, e.target)) return;
  });
  this._docDrawList();
  this._docDrawMain();
  this._docLoad();
  if (st.openId && !st.editing) this._docFetch(st.openId);
},

_docLoad() {
  const st = this._docs;
  if (!st || !this.socket) return;
  const token = st.loadToken + 1;
  st.loadToken = token;
  // A server without docs never answers; say so instead of waiting.
  setTimeout(() => {
    if (st.loadToken !== token || st.loaded) return;
    st.loaded = true;
    st.error = t('docs.load_failed');
    this._docDrawList();
  }, 10000);
  this.socket.emit('doc-list', { code: st.code }, (res) => {
    if (st.loadToken !== token) return;
    st.loaded = true;
    if (!res || res.error) {
      st.error = (res && res.error) || t('docs.load_failed');
    } else {
      st.error = null;
      st.list = res.docs || [];
      st.canPost = !!res.canPost;
      st.canModerate = !!res.canModerate;
    }
    if (st.openId && !st.editing && !st.list.some(d => d.id === st.openId)) { st.openId = null; st.doc = null; }
    // On a wide screen the newest document opens beside the list.
    if (!st.openId && !st.editing && st.list.length && !window.matchMedia(PHONE).matches && this._docs === st) {
      this._docOpen(st.list[0].id);
      return;
    }
    this._docDrawList();
    this._docDrawMain();
  });
},

_docOpen(id) {
  const st = this._docs;
  if (!st || !id) return;
  st.openId = id;
  st.editing = null;
  if (st.doc && st.doc.id !== id) st.doc = null;
  this._docDrawList();
  this._docDrawMain();
  this._docFetch(id);
},

_docFetch(id) {
  const st = this._docs;
  if (!st || !this.socket) return;
  this.socket.emit('doc-get', { id }, (res) => {
    if (st.openId !== id || st.editing) return;
    if (!res || res.error || !res.doc) {
      if (st.doc && st.doc.id === id) return;
      st.openId = null;
      if (this._docs === st) this._showToast(res?.error || t('docs.load_failed'), 'error');
    } else {
      st.doc = res.doc;
      this._docStore(res.doc, st);
    }
    if (this._docs !== st) return;
    this._docDrawList();
    this._docDrawMain();
  });
},

// Its author owns a document while they may still post here; a moderator any time.
_docOwns(d) {
  const st = this._docs;
  return !!(st && d && (st.canModerate || (d.createdBy === this.user?.id && st.canPost)));
},

_docMayEdit(d) {
  const st = this._docs;
  return this._docOwns(d) || !!(st && d && d.shared && st.canPost);
},

_docAct(what) {
  const st = this._docs;
  if (!st) return;
  const ed = st.editing;
  if (what === 'new') this._docEdit(null);
  else if (what === 'edit' && st.doc) this._docEdit(st.doc);
  else if (what === 'delete' && st.doc) this._docDelete(st.doc);
  else if (what === 'back') { st.openId = null; st.doc = null; this._docDrawList(); this._docDrawMain(); }
  else if (what === 'cancel') this._docCancel();
  else if (what === 'save') this._docSave();
  else if (what === 'preview' && ed) { ed.preview = !ed.preview; this._docDrawMain(); }
  else if (what === 'discard-draft' && ed) {
    ed.cur = { ...ed.orig };
    ed.restored = false;
    if (ed.doc) ed.base = ed.doc.version;
    this._docDraftSet(st.code, ed.id, null);
    this._docDrawMain();
  } else if (what === 'keep-mine' && ed && ed.conflict) {
    ed.base = ed.conflict.version;
    ed.conflict = null;
    ed.newer = null;
    this._docDrawNotice();
    this._docSave();
  } else if (what === 'theirs' && ed && ed.conflict) {
    clearTimeout(this._docKeepTimer);
    this._docDraftSet(st.code, ed.id, null);
    st.doc = ed.conflict;
    st.openId = ed.conflict.id;
    st.editing = null;
    this._docStore(st.doc, st);
    this._docDrawList();
    this._docDrawMain();
  }
},

// Start a document (doc null) or edit one. A draft left in this browser comes back.
_docEdit(doc) {
  const st = this._docs;
  if (!st) return;
  const draft = this._docDraftGet(st.code, doc ? doc.id : null);
  const orig = { title: doc ? doc.title : '', body: doc ? doc.body || '' : '', shared: !!(doc && doc.shared) };
  st.editing = {
    id: doc ? doc.id : null,
    doc,
    base: doc ? (draft && Number.isInteger(draft.base) ? draft.base : doc.version) : null,
    orig,
    cur: draft ? { title: draft.title, body: draft.body, shared: !!draft.shared } : { ...orig },
    restored: !!draft,
    conflict: null,
    newer: null,
    removed: false,
    preview: false,
    saving: false,
  };
  if (doc) st.openId = doc.id;
  this._docDrawList();
  this._docDrawMain();
},

_docDirty(ed) {
  return ed.cur.title !== ed.orig.title || ed.cur.body !== ed.orig.body || ed.cur.shared !== ed.orig.shared;
},

// Socket messages are capped by size (see src/docs.js), so emoji and some
// scripts fill a document sooner. Short text cannot reach the cap.
_docTooBig(body) {
  return body.length > 10000 && new TextEncoder().encode(JSON.stringify(body)).length > MAX_BYTES;
},

async _docCancel() {
  const st = this._docs;
  const ed = st && st.editing;
  if (!ed) return;
  if (this._docDirty(ed)) {
    const ok = await this._showConfirmModal(t('docs.discard_title'), t('docs.discard_body'), { danger: true, confirmLabel: t('docs.discard') });
    if (!ok || st.editing !== ed) return;
  }
  clearTimeout(this._docKeepTimer);
  this._docDraftSet(st.code, ed.id, null);
  st.editing = null;
  if (!ed.id) st.openId = st.doc ? st.doc.id : null;
  this._docDrawList();
  this._docDrawMain();
},

_docSave() {
  const st = this._docs;
  const ed = st && st.editing;
  if (!ed || ed.saving) return;
  const title = ed.cur.title.trim();
  if (!title) return this._docEditError(t('docs.need_title'));
  if (ed.cur.body.length > MAX_BODY) return this._docEditError(t('docs.too_long', { count: MAX_BODY.toLocaleString() }));
  if (this._docTooBig(ed.cur.body)) return this._docEditError(t('docs.too_big'));
  const payload = ed.id
    ? { id: ed.id, version: ed.base, title, body: ed.cur.body }
    : { code: st.code, title, body: ed.cur.body, shared: ed.cur.shared };
  if (ed.id && this._docOwns(ed.doc)) payload.shared = ed.cur.shared;
  this._docEditError('');
  this._docBusy(ed, true);
  // The draft is safe in this browser, so a lost connection only means trying again.
  const timer = setTimeout(() => { if (ed.saving) { this._docBusy(ed, false); this._docEditError(t('docs.save_failed')); } }, 10000);
  this.socket.emit(ed.id ? 'doc-update' : 'doc-create', payload, (res) => {
    clearTimeout(timer);
    if (st.editing !== ed) return;
    this._docBusy(ed, false);
    // automod already told the sender why; the text stays in the editor.
    if (res && res.blocked) return;
    if (res && res.conflict && res.doc) { ed.conflict = res.doc; ed.newer = null; this._docDrawNotice(); return; }
    if (!res || res.error || !res.doc) return this._docEditError(res?.error || t('docs.save_failed'));
    clearTimeout(this._docKeepTimer);
    this._docDraftSet(st.code, ed.id, null);
    st.editing = null;
    st.doc = res.doc;
    st.openId = res.doc.id;
    this._docStore(res.doc, st);
    this._docDrawList();
    this._docDrawMain();
  });
},

_docBusy(ed, on) {
  ed.saving = on;
  const btn = document.querySelector('#dc-root [data-dc-act="save"]');
  if (btn && this._docs?.editing === ed) { btn.disabled = on; btn.textContent = t(on ? 'docs.saving' : 'docs.save'); }
},

_docEditError(msg) {
  const el = document.querySelector('#dc-root .dc-error');
  if (!el) return;
  el.textContent = msg;
  el.hidden = !msg;
},

async _docDelete(doc) {
  const ok = await this._showConfirmModal(t('docs.delete_title', { title: doc.title }), t('docs.delete_body'), { danger: true, confirmLabel: t('docs.delete') });
  if (!ok) return;
  this.socket.emit('doc-delete', { id: doc.id }, (res) => {
    if (!res || res.error) this._showToast(res?.error || t('docs.save_failed'), 'error');
  });
},

_docDraftKey(code, id) {
  return `${DRAFT_PREFIX}${code}:${id || 'new'}`;
},

_docDraftGet(code, id) {
  try {
    const d = JSON.parse(localStorage.getItem(this._docDraftKey(code, id)) || 'null');
    return d && typeof d.title === 'string' && typeof d.body === 'string' ? d : null;
  } catch { return null; }
},

_docDraftSet(code, id, draft) {
  try {
    if (draft) localStorage.setItem(this._docDraftKey(code, id), JSON.stringify(draft));
    else localStorage.removeItem(this._docDraftKey(code, id));
  } catch { /* storage full or off: the edit still works, it just is not kept */ }
},

// Keeps the edit as a draft shortly after typing stops, or drops the draft
// once the text is back to what was saved.
_docKeep() {
  const st = this._docs;
  const ed = st && st.editing;
  if (!ed) return;
  clearTimeout(this._docKeepTimer);
  this._docKeepTimer = setTimeout(() => {
    if (st.editing !== ed) return;
    this._docDraftSet(st.code, ed.id, this._docDirty(ed) ? { ...ed.cur, base: ed.base } : null);
  }, 700);
},

// Bold, italic, strikethrough and code wrap the selection; headings, quotes
// and lists apply to (or come off) every line it touches.
_docFormat(ta, kind) {
  if (!ta) return;
  const { selectionStart: s, selectionEnd: e, value: v } = ta;
  const marks = { bold: '**', italic: '*', strike: '~~', code: '`' };
  if (marks[kind]) {
    const sel = v.slice(s, e);
    if (kind === 'code' && sel.includes('\n')) return this._docReplace(ta, s, e, '```\n' + sel + '\n```', s + 4, s + 4 + sel.length);
    const m = marks[kind];
    return this._docReplace(ta, s, e, m + sel + m, s + m.length, e + m.length);
  }
  const prefix = { h1: '# ', h2: '## ', quote: '> ', list: '- ', numbered: '1. ' }[kind];
  if (!prefix) return;
  const from = v.lastIndexOf('\n', s - 1) + 1;
  let to = v.indexOf('\n', e > s && v[e - 1] === '\n' ? e - 1 : e);
  if (to === -1) to = v.length;
  const lines = v.slice(from, to).split('\n');
  const bare = (l) => l.replace(/^(#{1,3} |> |[-*+] |\d+\. )/, '');
  const on = lines.every(l => (kind === 'numbered' ? /^\d+\. /.test(l) : l.startsWith(prefix)));
  const out = lines.map((l, i) => (on ? bare(l) : (kind === 'numbered' ? `${i + 1}. ` : prefix) + bare(l))).join('\n');
  this._docReplace(ta, from, to, out, from, from + out.length);
},

// Replaces text the way typing would, so Ctrl+Z undoes it.
_docReplace(ta, start, end, text, selStart, selEnd) {
  ta.focus();
  ta.setSelectionRange(start, end);
  let done = false;
  try { done = document.execCommand('insertText', false, text); } catch { done = false; }
  if (!done) {
    ta.setRangeText(text, start, end, 'end');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }
  ta.setSelectionRange(selStart, selEnd);
},

_docCount() {
  const ed = this._docs?.editing;
  const el = document.querySelector('#dc-root .dc-count');
  if (!ed || !el) return;
  const n = (ed.cur.body.match(/\S+/g) || []).filter(w => /[\p{L}\p{N}]/u.test(w)).length;
  const len = ed.cur.body.length;
  const big = len <= MAX_BODY && this._docTooBig(ed.cur.body);
  el.textContent = t(n === 1 ? 'docs.words_one' : 'docs.words_other', { count: n.toLocaleString() })
    + (len > MAX_BODY * 0.9 ? ` · ${t('docs.chars', { count: len.toLocaleString(), max: MAX_BODY.toLocaleString() })}` : '')
    + (big ? ` · ${t('docs.too_big_short')}` : '');
  el.classList.toggle('dc-over', len > MAX_BODY || big);
},

// Server times are UTC without a zone.
_docWhen(at) {
  if (!at) return '';
  const s = String(at);
  const when = new Date(/[zZ]$|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(' ', 'T') + 'Z');
  if (Number.isNaN(when.getTime())) return '';
  return Date.now() - when.getTime() < 7 * 86400000 ? this._relativeTime(when.toISOString()) : when.toLocaleDateString();
},

_docWords(n) {
  return t(n === 1 ? 'docs.words_one' : 'docs.words_other', { count: (n || 0).toLocaleString() });
},

// Puts a document from the server in the list, most recently changed first.
_docStore(doc, st = this._docs) {
  if (!st || !doc) return;
  const { body, ...summary } = doc;
  st.list = [summary, ...st.list.filter(d => d.id !== doc.id)]
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)) || b.id - a.id);
},

_docRoot() {
  const root = document.getElementById('dc-root');
  return root && this._channelView === 'docs' ? root : null;
},

_docDrawList() {
  const st = this._docs;
  const root = this._docRoot();
  if (!st || !root) return;
  const esc = (s) => this._escapeHtml(s);
  const q = st.filter.trim().toLowerCase();
  const shown = q ? st.list.filter(d => d.title.toLowerCase().includes(q)) : st.list;
  root.querySelector('.dc-new-slot').innerHTML = st.canPost ? `<button type="button" class="btn-sm btn-accent dc-new" data-dc-act="new">＋ ${esc(t('docs.new'))}</button>` : '';
  root.querySelector('.dc-search').hidden = st.list.length < 7 && !st.filter;
  const status = st.error || (!st.loaded ? t('docs.loading') : !st.list.length ? t(st.canPost ? 'docs.empty_can_add' : 'docs.empty') : !shown.length ? t('docs.no_match') : '');
  const statusEl = root.querySelector('.dc-status');
  statusEl.textContent = status;
  statusEl.hidden = !status;
  const fresh = st.canPost && !(st.editing && !st.editing.id) && this._docDraftGet(st.code, null);
  const item = (d) => {
    const draft = this._docDraftGet(st.code, d.id) ? `<span class="dc-tag dc-tag-draft">${esc(t('docs.draft'))}</span>` : '';
    const open = d.id === st.openId;
    return `<li><button type="button" class="dc-item${open ? ' active' : ''}" data-dc-open="${d.id}"${open ? ' aria-current="true"' : ''}>
      <span class="dc-item-title">${esc(d.title)}</span>
      <span class="dc-item-meta">${draft}${d.shared ? `<span title="${esc(t('docs.shared'))}">✏️</span> ` : ''}${esc(this._docWhen(d.updatedAt))} · ${esc(this._docWords(d.words))}</span>
    </button></li>`;
  };
  root.querySelector('.dc-list').innerHTML = (fresh
    ? `<li><button type="button" class="dc-item" data-dc-act="new"><span class="dc-item-title">${esc(fresh.title.trim() || t('docs.untitled'))}</span><span class="dc-item-meta"><span class="dc-tag dc-tag-draft">${esc(t('docs.draft'))}</span></span></button></li>`
    : '') + shown.map(item).join('');
  root.classList.toggle('dc-reading', !!(st.openId || st.editing));
},

_docDrawMain() {
  const st = this._docs;
  const root = this._docRoot();
  if (!st || !root) return;
  const main = root.querySelector('.dc-main');
  root.classList.toggle('dc-reading', !!(st.openId || st.editing));
  if (st.editing) { main.dataset.doc = ''; this._docDrawEditor(main); return; }
  const esc = (s) => this._escapeHtml(s);
  const back = `<button type="button" class="btn-sm dc-back" data-dc-act="back">← ${esc(t('docs.back'))}</button>`;
  const d = st.doc && st.doc.id === st.openId ? st.doc : null;
  if (!st.openId) {
    main.dataset.doc = '';
    main.innerHTML = st.list.length ? `<p class="dc-empty muted-text">${esc(t('docs.pick'))}</p>` : '';
    return;
  }
  if (!d) {
    main.innerHTML = `<div class="dc-bar">${back}</div><p class="dc-empty muted-text">${esc(t('docs.loading_one'))}</p>`;
    return;
  }
  // Redrawing the same document (someone saved it) keeps your place in it.
  const keep = main.dataset.doc === String(d.id) ? main.scrollTop : 0;
  const by = d.creatorName ? t('docs.by', { name: d.creatorName }) : '';
  const edited = d.version > 1 ? (d.editorName ? t('docs.edited_by', { when: this._docWhen(d.updatedAt), name: d.editorName }) : t('docs.edited', { when: this._docWhen(d.updatedAt) })) : this._docWhen(d.createdAt);
  const meta = [by, edited, this._docWords(d.words)].filter(Boolean).map(esc).join(' · ');
  main.innerHTML = `
    <div class="dc-bar">
      ${back}
      <span class="dc-spacer"></span>
      ${this._docMayEdit(d) ? `<button type="button" class="btn-sm btn-accent" data-dc-act="edit">✏️ ${esc(t('docs.edit'))}</button>` : ''}
      ${this._docOwns(d) ? `<button type="button" class="btn-sm dc-delete" data-dc-act="delete">${esc(t('docs.delete'))}</button>` : ''}
    </div>
    <article class="dc-doc">
      <h1 class="dc-title">${esc(d.title)}</h1>
      <p class="dc-meta muted-text">${meta}${d.shared ? ` <span class="dc-tag">${esc(t('docs.shared'))}</span>` : ''}</p>
      <div class="dc-body message-content">${d.body ? this._formatContent(d.body) : `<p class="muted-text">${esc(t('docs.blank'))}</p>`}</div>
    </article>`;
  main.dataset.doc = String(d.id);
  main.scrollTop = keep;
},

_docDrawEditor(main) {
  const ed = this._docs.editing;
  const esc = (s) => this._escapeHtml(s);
  const owns = !ed.doc || this._docOwns(ed.doc);
  main.innerHTML = `
    <div class="dc-bar">
      <button type="button" class="btn-sm" data-dc-act="cancel">${esc(t('docs.cancel'))}</button>
      <span class="dc-spacer"></span>
      <button type="button" class="btn-sm" data-dc-act="preview" aria-pressed="${ed.preview}">${esc(t(ed.preview ? 'docs.write' : 'docs.preview'))}</button>
      <button type="button" class="btn-sm btn-accent" data-dc-act="save">${esc(t('docs.save'))}</button>
    </div>
    <div class="dc-notice" role="status" hidden></div>
    <p class="dc-error" role="alert" hidden></p>
    <div class="dc-editor">
      <input type="text" class="dc-ed-title" maxlength="${MAX_TITLE}" placeholder="${esc(t('docs.title_placeholder'))}" aria-label="${esc(t('docs.title_label'))}">
      <div class="dc-tools" role="toolbar" aria-label="${esc(t('docs.formatting'))}"${ed.preview ? ' hidden' : ''}>
        ${TOOLS.map(([k, label]) => `<button type="button" class="dc-tool dc-tool-${k}" data-dc-fmt="${k}" title="${esc(t(`docs.fmt_${k}`))}" aria-label="${esc(t(`docs.fmt_${k}`))}">${esc(label)}</button>`).join('')}
      </div>
      <textarea class="dc-ed-body" placeholder="${esc(t('docs.body_placeholder'))}" aria-label="${esc(t('docs.body_label'))}"${ed.preview ? ' hidden' : ''}></textarea>
      ${ed.preview ? `<div class="dc-body dc-preview message-content">${ed.cur.body ? this._formatContent(ed.cur.body) : `<p class="muted-text">${esc(t('docs.blank'))}</p>`}</div>` : ''}
    </div>
    <div class="dc-ed-foot">
      ${owns ? `<label class="dc-shared"><input type="checkbox" class="dc-ed-shared"${ed.cur.shared ? ' checked' : ''}> ${esc(t('docs.shared_label'))}</label>` : ''}
      <span class="dc-spacer"></span>
      <span class="dc-count muted-text" aria-live="polite"></span>
    </div>`;
  const title = main.querySelector('.dc-ed-title');
  const body = main.querySelector('.dc-ed-body');
  title.value = ed.cur.title;
  body.value = ed.cur.body;
  title.readOnly = ed.preview;
  main.scrollTop = 0;
  this._docDrawNotice();
  this._docCount();
  this._docBusy(ed, ed.saving);
  if (!ed.preview) (ed.cur.title ? body : title).focus({ preventScroll: true });
},

_docDrawNotice() {
  const ed = this._docs?.editing;
  const el = this._docRoot()?.querySelector('.dc-notice');
  if (!ed || !el) return;
  const esc = (s) => this._escapeHtml(s);
  const btn = (act, label, accent) => `<button type="button" class="btn-sm${accent ? ' btn-accent' : ''}" data-dc-act="${act}">${esc(label)}</button>`;
  let html = '';
  if (ed.conflict) {
    html = `<span>${esc(ed.conflict.editorName ? t('docs.conflict', { name: ed.conflict.editorName }) : t('docs.conflict_anon'))}</span>${btn('keep-mine', t('docs.keep_mine'), true)}${btn('theirs', t('docs.load_theirs'))}`;
  } else if (ed.removed) {
    html = `<span>${esc(t('docs.removed_editing'))}</span>`;
  } else if (ed.newer) {
    html = `<span>${esc(ed.newer.editorName ? t('docs.newer', { name: ed.newer.editorName }) : t('docs.newer_anon'))}</span>`;
  } else if (ed.restored) {
    html = `<span>${esc(t('docs.draft_restored'))}</span>${btn('discard-draft', t('docs.discard_draft'))}`;
  }
  el.innerHTML = html;
  el.hidden = !html;
  el.classList.toggle('dc-notice-warn', !!(ed.conflict || ed.newer || ed.removed));
},

_listenDocs() {
  this.socket.on('doc-changed', (data) => {
    const st = data && data.doc && this._docStates?.get(data.channelCode);
    if (!st) return;
    this._docStore(data.doc, st);
    const ed = st.editing;
    if (ed && ed.id === data.doc.id && data.doc.version !== ed.base && data.doc.updatedBy !== this.user?.id) ed.newer = data.doc;
    if (this._docs !== st || !this._docRoot()) return;
    this._docDrawList();
    if (ed) this._docDrawNotice();
    else if (st.openId === data.doc.id && (!st.doc || st.doc.version < data.doc.version)) this._docFetch(data.doc.id);
  });
  this.socket.on('doc-removed', (data) => {
    const st = data && this._docStates?.get(data.channelCode);
    if (!st) return;
    st.list = st.list.filter(d => d.id !== data.id);
    this._docDraftSet(st.code, data.id, null);
    const ed = st.editing;
    // An edit in progress becomes a new document, so the text is not lost.
    if (ed && ed.id === data.id) {
      Object.assign(ed, { id: null, doc: null, base: null, orig: { title: '', body: '', shared: false }, removed: true, conflict: null, newer: null, restored: false });
      ed.cur.shared = false;
      st.openId = null;
      st.doc = null;
      this._docKeep();
    }
    const wasOpen = !ed && st.openId === data.id;
    if (wasOpen) { st.openId = null; st.doc = null; }
    if (this._docs !== st || !this._docRoot()) return;
    if (wasOpen) this._showToast(t('docs.removed'), 'info');
    this._docDrawList();
    if (!ed || ed.removed) this._docDrawMain();
  });
},

};
