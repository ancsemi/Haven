// ═══════════════════════════════════════════════════════════
// Haven — Mod Mode v5  (snap-grid layout customisation)
//
// - Every headed section is independently remappable.
// - Custom mousedown drag with glowing snap-line indicators.
// - Sections can live in left sidebar, right sidebar, or
//   float as pinnable windows.
// - Floating pill: Save & Exit, Reset, Status-bar toggle.
// - Status bar physically moved in the DOM (top / bottom).
// ═══════════════════════════════════════════════════════════

class ModMode {
  constructor() {
    this.active = false;
    this.sidebar = null;
    this.rightSidebar = null;
    this.floatLayer = null;
    this.dropIndicator = null;
    this.dragging = null;          // { el, ghost }
    this._pendingDrop = null;      // { panel, before } | { float:true }
    this.selection = new Set();

    this.defaultState = () => ({ sections: {}, statusBarPos: 'bottom' });
    this.state = { desktop: this.defaultState(), mobile: this.defaultState() };
    this.mq = window.matchMedia('(max-width: 900px)');
    this._onMq = () => { if (this.active) this._persistFromDom(); this._saveState(); this.applyLayout(); };
  }

  // ── Init ──────────────────────────────────────────────
  init() {
    this.sidebar = document.getElementById('sidebar-mod-container');
    this.rightSidebar = document.querySelector('.right-sidebar');
    if (!this.sidebar) return;
    this._loadState();
    this._cacheHomePanels();
    this._ensureFloatLayer();
    this._createDropIndicator();
    // If there is a saved layout, free sections from sidebar-split
    // so they can be placed individually.
    const hasSaved = Object.keys(this.layout.sections).length > 0;
    if (hasSaved) this._liberateSplit();
    this.applyLayout();
    if (hasSaved) this._restoreSplit();
    this._armAllFloatingPanes();
    this.mq.addEventListener?.('change', this._onMq);
  }

  // ── State ─────────────────────────────────────────────
  get layoutKey() { return this.mq.matches ? 'mobile' : 'desktop'; }
  get layout()    { return this.state[this.layoutKey]; }

  _loadState() {
    try {
      const raw = JSON.parse(localStorage.getItem('haven-layout-v2') || 'null');
      if (raw && typeof raw === 'object') {
        this.state = {
          desktop: Object.assign(this.defaultState(), raw.desktop || {}),
          mobile:  Object.assign(this.defaultState(), raw.mobile  || {})
        };
      }
    } catch { /* keep defaults */ }
  }
  _saveState() {
    try { localStorage.setItem('haven-layout-v2', JSON.stringify(this.state)); } catch {}
  }

  _cacheHomePanels() {
    document.querySelectorAll('[data-mod-id]').forEach(el => {
      if (!el.dataset.modHomePanel) {
        el.dataset.modHomePanel = this._detectHome(el);
      }
    });
  }
  _detectHome(el) {
    if (el.closest('#sidebar-mod-container')) return 'sidebar';
    if (el.closest('.right-sidebar'))         return 'right-sidebar';
    return 'sidebar';
  }

  // ── Infrastructure ────────────────────────────────────
  _ensureFloatLayer() {
    let l = document.getElementById('mod-float-layer');
    if (!l) { l = document.createElement('div'); l.id = 'mod-float-layer'; l.className = 'mod-float-layer'; document.body.appendChild(l); }
    this.floatLayer = l;
  }
  _createDropIndicator() {
    if (this.dropIndicator) return;
    const el = document.createElement('div');
    el.className = 'mod-drop-indicator';
    el.style.display = 'none';
    document.body.appendChild(el);
    this.dropIndicator = el;
  }

  _getDropPanels() { return [this.sidebar, this.rightSidebar].filter(Boolean); }

  _panelKeyOf(el) {
    if (el.closest('#mod-float-layer'))       return 'float-layer';
    if (el.closest('#sidebar-mod-container')) return 'sidebar';
    if (el.closest('.right-sidebar'))         return 'right-sidebar';
    return el.dataset.modHomePanel || 'sidebar';
  }
  _panelEl(key) {
    if (key === 'sidebar' || key === 'sidebar-mod-container') return this.sidebar;
    if (key === 'right-sidebar') return this.rightSidebar;
    if (key === 'float-layer')   return this.floatLayer;
    return this.sidebar;
  }

  /* When appending into the right sidebar we must not place
     sections after the fixed panels (voice-settings, voice-panel,
     settings button). This returns the first "fixed" child
     that sections should stay above. */
  _panelAnchor(panel) {
    if (panel !== this.rightSidebar) return null;
    return document.getElementById('voice-settings-panel')
        || document.getElementById('voice-panel')
        || panel.querySelector('.sidebar-settings-panel')
        || null;
  }
  _appendToPanel(el, panel) {
    const anchor = this._panelAnchor(panel);
    if (anchor) panel.insertBefore(el, anchor);
    else        panel.appendChild(el);
  }

  // ── Toggle ────────────────────────────────────────────
  toggle() { this.active ? this._disable() : this._enable(); this.active = !this.active; }

  _enable() {
    const s = document.getElementById('settings-modal');
    if (s) s.style.display = 'none';
    document.body.classList.add('mod-mode-on');

    this._liberateSplit();
    this._getAllSections().forEach(sec => this._armSection(sec));
    this._armStatusBar();
    this._showPill();
    this._showToast('Mod Mode ON — drag ⋮⋮ handles to rearrange');

    this._keyH = (e) => { if (e.key === 'Escape') this.toggle(); };
    document.addEventListener('keydown', this._keyH);
  }

  _disable() {
    document.body.classList.remove('mod-mode-on');
    this._persistFromDom();
    this._saveState();
    this._getAllSections().forEach(sec => this._disarmSection(sec));
    this._disarmStatusBar();
    this._restoreSplit();
    this._hidePill();
    this._hideDropInd();
    if (this._keyH) { document.removeEventListener('keydown', this._keyH); this._keyH = null; }
    this._showToast('Mod Mode OFF — layout saved');
  }

  // ── Sidebar-split liberation ──────────────────────────
  _liberateSplit() {
    const split = document.getElementById('sidebar-split');
    if (!split) return;
    const ch = document.getElementById('channels-pane');
    const dm = document.getElementById('dm-pane');
    const parent = split.parentElement;
    if (ch && parent) parent.insertBefore(ch, split);
    if (dm && parent) parent.insertBefore(dm, split);
    split.style.display = 'none';
  }
  _restoreSplit() {
    const split = document.getElementById('sidebar-split');
    if (!split) return;
    const ch = document.getElementById('channels-pane');
    const dm = document.getElementById('dm-pane');
    const handle = document.getElementById('sidebar-split-handle');
    // Only rejoin if both live in the sidebar
    if (ch?.closest('#sidebar-mod-container') && dm?.closest('#sidebar-mod-container')) {
      split.style.display = '';
      if (ch) split.insertBefore(ch, handle || split.firstChild);
      if (dm) split.appendChild(dm);
      // Put the split at the position of the first child or end
      this.sidebar.appendChild(split);
    } else {
      split.style.display = 'none';
    }
  }

  // ── Section helpers ───────────────────────────────────
  _getAllSections() { return [...document.querySelectorAll('[data-mod-id]')]; }

  _getSectionTitle(s) {
    const txts = [...s.querySelectorAll('.section-label-text')].map(e => e.textContent.trim()).filter(Boolean);
    if (txts.length) return txts.join(' & ');
    const pt = s.querySelector('.panel-title');
    return pt ? pt.textContent.trim() : (s.dataset.modId || 'Section');
  }

  // ── Arm / Disarm ──────────────────────────────────────
  _armSection(s) {
    s.classList.add('mod-draggable');
    this._injectControls(s);
  }
  _disarmSection(s) {
    s.classList.remove('mod-draggable', 'mod-dragging', 'mod-selected', 'mod-collapsed');
    s.querySelector(':scope > .mod-section-controls')?.remove();
    s.querySelector(':scope > .mod-collapsed-label')?.remove();
    if (s.classList.contains('mod-floating')) {
      this._disarmFloat(s);
      s.classList.remove('mod-floating');
      s.style.left = s.style.top = s.style.width = s.style.height = '';
    }
    s.querySelector(':scope > .mod-float-titlebar')?.remove();
  }

  // ── Controls bar ──────────────────────────────────────
  _injectControls(s) {
    if (s.querySelector(':scope > .mod-section-controls')) return;
    const isFloat  = s.classList.contains('mod-floating');
    const isPinned = !!this.layout.sections[s.dataset.modId]?.pinned;
    const bar = document.createElement('div');
    bar.className = 'mod-section-controls';
    bar.innerHTML =
      `<button type="button" class="mod-sec-btn" data-act="collapse" title="Collapse / Expand">▾</button>` +
      `<button type="button" class="mod-sec-btn" data-act="float" title="${isFloat ? 'Dock' : 'Float'}">${isFloat ? '⮽' : '⧉'}</button>` +
      (isFloat ? `<button type="button" class="mod-sec-btn mod-pin-btn${isPinned ? ' pinned' : ''}" data-act="pin" title="${isPinned ? 'Unpin' : 'Pin'}">📌</button>` : '') +
      `<span class="mod-sec-handle" title="Drag to reorder">⋮⋮</span>`;

    bar.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (!act) return;
      e.stopPropagation();
      if (act === 'collapse') this._toggleCollapse(s);
      else if (act === 'float') this._toggleFloat(s);
      else if (act === 'pin')   this._togglePin(s);
    });

    // ⋮⋮ handle → snap-grid drag
    bar.querySelector('.mod-sec-handle').addEventListener('mousedown', (e) => {
      e.preventDefault();
      this._startDrag(e, s);
    });

    s.appendChild(bar);

    // Restore collapse state
    const meta = this.layout.sections[s.dataset.modId];
    if (meta?.collapsed) s.classList.add('mod-collapsed');
    this._syncCollapseLabel(s);
  }
  _refreshControls(s) {
    s.querySelector(':scope > .mod-section-controls')?.remove();
    this._injectControls(s);
  }

  // ── Collapse ──────────────────────────────────────────
  _toggleCollapse(s) {
    s.classList.toggle('mod-collapsed');
    const id = s.dataset.modId;
    this.layout.sections[id] = Object.assign(this.layout.sections[id] || {}, {
      collapsed: s.classList.contains('mod-collapsed')
    });
    this._syncCollapseLabel(s);
    this._saveState();
  }
  _syncCollapseLabel(s) {
    const col = s.classList.contains('mod-collapsed');
    const hasDirect = !!s.querySelector(':scope > .section-label:not(.mod-collapsed-label)');
    const existing  = s.querySelector(':scope > .mod-collapsed-label');
    if (col && !hasDirect) {
      if (!existing) {
        const lbl = document.createElement('h5');
        lbl.className = 'section-label mod-collapsed-label';
        lbl.textContent = this._getSectionTitle(s);
        lbl.style.cursor = 'pointer';
        lbl.addEventListener('click', () => this._toggleCollapse(s));
        s.insertBefore(lbl, s.firstChild);
      }
    } else if (existing) { existing.remove(); }
  }

  // ── Float / Dock ──────────────────────────────────────
  _toggleFloat(s) {
    if (s.classList.contains('mod-floating')) {
      this._dockSection(s);
    } else {
      const fl = { x: 120, y: 80, w: 320, h: 280 };
      this._floatSection(s, fl);
      this.layout.sections[s.dataset.modId] = Object.assign(
        this.layout.sections[s.dataset.modId] || {}, { panel: 'float-layer', float: fl, pinned: false }
      );
      this._saveState();
    }
  }
  _floatSection(s, fl) {
    if (s.parentElement !== this.floatLayer) this.floatLayer.appendChild(s);
    s.classList.add('mod-floating');
    Object.assign(s.style, { left: fl.x+'px', top: fl.y+'px', width: fl.w+'px', height: fl.h+'px' });
    this._armFloat(s);
    this._refreshControls(s);
  }
  _dockSection(s) {
    const id = s.dataset.modId;
    this._disarmFloat(s);
    s.classList.remove('mod-floating');
    s.style.left = s.style.top = s.style.width = s.style.height = '';
    const home = s.dataset.modHomePanel || 'sidebar';
    const panel = this._panelEl(home);
    if (panel) this._appendToPanel(s, panel);
    this.layout.sections[id] = Object.assign(this.layout.sections[id] || {}, {
      panel: home, float: null, pinned: false
    });
    this._refreshControls(s);
    this._saveState();
  }

  // ── Pin ───────────────────────────────────────────────
  _togglePin(s) {
    const id = s.dataset.modId;
    const meta = this.layout.sections[id] = this.layout.sections[id] || {};
    meta.pinned = !meta.pinned;
    const btn = s.querySelector('.mod-pin-btn');
    if (btn) { btn.classList.toggle('pinned', meta.pinned); btn.title = meta.pinned ? 'Unpin' : 'Pin'; }
    this._saveState();
    this._showToast(meta.pinned ? 'Pinned — window locked' : 'Unpinned — window draggable');
  }

  // ── Floating-pane drag (titlebar mousedown) ───────────
  _armFloat(el) {
    if (el._floatArmed) return;
    el._floatArmed = true;
    const onDown = (e) => {
      if (this.layout.sections[el.dataset.modId]?.pinned) return;
      const trigger = e.target.closest('.mod-float-titlebar');
      if (!trigger) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const lr = this.floatLayer.getBoundingClientRect();
      const ox = e.clientX - rect.left, oy = e.clientY - rect.top;
      const move = (ev) => {
        let nx = Math.max(0, Math.min(lr.width - 40, ev.clientX - lr.left - ox));
        let ny = Math.max(0, Math.min(lr.height - 40, ev.clientY - lr.top - oy));
        el.style.left = nx + 'px'; el.style.top = ny + 'px';
      };
      const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        const meta = this.layout.sections[el.dataset.modId];
        if (meta?.float) { meta.float.x = parseInt(el.style.left)||0; meta.float.y = parseInt(el.style.top)||0; }
        this._saveState();
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    };
    el.addEventListener('mousedown', onDown);
    el._floatClean = () => { el.removeEventListener('mousedown', onDown); el._floatArmed = false; delete el._floatClean; };

    if (!el.querySelector(':scope > .mod-float-titlebar')) {
      const tb = document.createElement('div');
      tb.className = 'mod-float-titlebar';
      tb.textContent = this._getSectionTitle(el);
      el.insertBefore(tb, el.firstChild);
    }
  }
  _disarmFloat(el) {
    if (el._floatClean) el._floatClean();
    el.querySelector(':scope > .mod-float-titlebar')?.remove();
  }
  _armAllFloatingPanes() {
    this.floatLayer?.querySelectorAll('.mod-floating').forEach(el => this._armFloat(el));
  }

  // ═══════════════════════════════════════════════════════
  //  Snap-Grid Drag System (mousedown-based)
  // ═══════════════════════════════════════════════════════

  _startDrag(e, section) {
    const rect = section.getBoundingClientRect();
    const ghost = document.createElement('div');
    ghost.className = 'mod-drag-ghost';
    ghost.textContent = this._getSectionTitle(section);
    ghost.style.left = e.clientX + 'px';
    ghost.style.top  = e.clientY + 'px';
    document.body.appendChild(ghost);

    section.classList.add('mod-dragging');
    this.dragging = { el: section, ghost };
    this._getDropPanels().forEach(p => p.classList.add('mod-drop-panel'));

    const move = (ev) => {
      ghost.style.left = ev.clientX + 'px';
      ghost.style.top  = ev.clientY + 'px';
      this._updateDropInd(ev.clientX, ev.clientY, section);
    };
    const up = (ev) => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      this._executeDrop(section);
      ghost.remove();
      section.classList.remove('mod-dragging');
      this._getDropPanels().forEach(p => p.classList.remove('mod-drop-panel', 'mod-drop-panel-active'));
      this._hideDropInd();
      this.dragging = null;
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }

  /* Find the panel under the cursor, then compute the
     insertion gap between sections and show the glow line. */
  _updateDropInd(x, y, draggedSection) {
    let targetPanel = null;
    for (const p of this._getDropPanels()) {
      const r = p.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) { targetPanel = p; break; }
    }

    if (!targetPanel) {
      this._hideDropInd();
      this._getDropPanels().forEach(p => p.classList.remove('mod-drop-panel-active'));
      this._pendingDrop = null;
      return;
    }

    this._getDropPanels().forEach(p => p.classList.toggle('mod-drop-panel-active', p === targetPanel));

    // Sections in this panel (excluding the one being dragged)
    const secs = [...targetPanel.querySelectorAll(':scope > [data-mod-id]')]
                   .filter(s => s !== draggedSection && !s.classList.contains('mod-floating'));

    let insertBefore = null;
    let indY = 0;
    const pRect = targetPanel.getBoundingClientRect();

    if (!secs.length) {
      indY = pRect.top + 8;
    } else {
      for (const s of secs) {
        const sr = s.getBoundingClientRect();
        if (y < sr.top + sr.height / 2) { insertBefore = s; indY = sr.top; break; }
      }
      if (!insertBefore) {
        indY = secs[secs.length - 1].getBoundingClientRect().bottom;
      }
    }

    this._showDropInd(indY, pRect.left + 6, pRect.right - 6);
    this._pendingDrop = { panel: targetPanel, before: insertBefore };
  }

  _showDropInd(y, left, right) {
    const el = this.dropIndicator; if (!el) return;
    el.style.display = 'block';
    el.style.top   = (y - 2) + 'px';
    el.style.left  = left + 'px';
    el.style.width = (right - left) + 'px';
  }
  _hideDropInd() {
    if (this.dropIndicator) this.dropIndicator.style.display = 'none';
    this._pendingDrop = null;
  }

  _executeDrop(section) {
    const d = this._pendingDrop;
    if (!d || !d.panel) return;

    // If currently floating, unfloat first
    if (section.classList.contains('mod-floating')) {
      this._disarmFloat(section);
      section.classList.remove('mod-floating');
      section.style.left = section.style.top = section.style.width = section.style.height = '';
      this._refreshControls(section);
    }

    if (d.before) d.panel.insertBefore(section, d.before);
    else          this._appendToPanel(section, d.panel);

    this._persistFromDom();
    this._saveState();
  }

  // ── Status bar ────────────────────────────────────────
  _armStatusBar() {
    const bar = document.getElementById('status-bar');
    if (!bar || bar.querySelector('.mod-statusbar-controls')) return;
    const ctrl = document.createElement('span');
    ctrl.className = 'mod-statusbar-controls';
    const pos = this.layout.statusBarPos || 'bottom';
    ctrl.innerHTML =
      `<button type="button" class="mod-sb-toggle" title="Move status bar">${pos === 'bottom' ? '↑ Move Top' : '↓ Move Bottom'}</button>`;
    ctrl.querySelector('.mod-sb-toggle').addEventListener('click', () => this._toggleStatusBarPos());
    bar.appendChild(ctrl);
  }
  _disarmStatusBar() {
    document.querySelector('.mod-statusbar-controls')?.remove();
  }
  _toggleStatusBarPos() {
    const cur = this.layout.statusBarPos || 'bottom';
    this.layout.statusBarPos = cur === 'bottom' ? 'top' : 'bottom';
    this._applyStatusBarPos();
    this._saveState();
    // Update button label
    const btn = document.querySelector('.mod-sb-toggle');
    if (btn) btn.textContent = this.layout.statusBarPos === 'bottom' ? '↑ Move Top' : '↓ Move Bottom';
    this._showToast('Status bar → ' + this.layout.statusBarPos);
  }
  _applyStatusBarPos() {
    const pos = this.layout.statusBarPos || 'bottom';
    const app = document.getElementById('app');
    const bar = document.getElementById('status-bar');
    if (!app || !bar) return;
    app.dataset.statusPos = pos;
    // Physically move in DOM for reliable positioning
    if (pos === 'top') {
      const body = document.getElementById('app-body');
      if (body) app.insertBefore(bar, body);
      else app.insertBefore(bar, app.firstChild);
    } else {
      // After #app-body
      const body = document.getElementById('app-body');
      if (body && body.nextSibling) app.insertBefore(bar, body.nextSibling);
      else app.appendChild(bar);
    }
  }

  // ── Pill ──────────────────────────────────────────────
  _showPill() {
    let pill = document.getElementById('mod-mode-pill');
    if (!pill) {
      pill = document.createElement('div');
      pill.id = 'mod-mode-pill';
      pill.className = 'mod-pill';
      pill.innerHTML =
        '<button type="button" class="mod-pill-btn mod-pill-save" id="mod-pill-exit" title="Save & exit">✓ Save & Exit</button>' +
        '<button type="button" class="mod-pill-btn" id="mod-pill-reset" title="Reset layout">↺</button>';
      document.body.appendChild(pill);
      pill.querySelector('#mod-pill-exit').addEventListener('click', () => this.toggle());
      pill.querySelector('#mod-pill-reset').addEventListener('click', () => this.resetLayout());
    }
    pill.style.display = 'flex';
  }
  _hidePill() { const p = document.getElementById('mod-mode-pill'); if (p) p.style.display = 'none'; }

  // ── Apply layout (page load) ──────────────────────────
  applyLayout() {
    this._applyStatusBarPos();
    const secs = this.layout.sections;
    const ordered = Object.entries(secs)
      .filter(([, m]) => typeof m.index === 'number')
      .sort(([, a], [, b]) => a.index - b.index);

    ordered.forEach(([id, meta]) => {
      const el = document.querySelector(`[data-mod-id="${id}"]`);
      if (!el) return;
      const panel = this._panelEl(meta.panel);
      if (!panel) return;

      if (meta.panel === 'float-layer' && meta.float) {
        this._floatSection(el, meta.float);
      } else {
        if (el.classList.contains('mod-floating')) {
          this._disarmFloat(el);
          el.classList.remove('mod-floating');
          el.style.left = el.style.top = el.style.width = el.style.height = '';
        }
        if (el.parentElement !== panel) this._appendToPanel(el, panel);
      }
      el.classList.toggle('mod-collapsed', !!meta.collapsed);
    });
  }

  // ── Persist from DOM ──────────────────────────────────
  _persistFromDom() {
    const sections = {};
    const idx = {};
    this._getAllSections().forEach(el => {
      const id = el.dataset.modId;
      const pk = this._panelKeyOf(el);
      idx[pk] = (idx[pk] ?? -1) + 1;
      const prev = this.layout.sections[id] || {};
      sections[id] = {
        panel: pk,
        index: idx[pk],
        collapsed: el.classList.contains('mod-collapsed'),
        float: pk === 'float-layer' ? (prev.float || null) : null,
        pinned: !!prev.pinned
      };
    });
    this.layout.sections = sections;
  }

  // ── Reset ─────────────────────────────────────────────
  resetLayout() {
    this.state[this.layoutKey] = this.defaultState();
    this._saveState();
    this._applyStatusBarPos();
    // Update status bar button label
    const sbBtn = document.querySelector('.mod-sb-toggle');
    if (sbBtn) sbBtn.textContent = '↑ Move Top';
    this._getAllSections().forEach(el => {
      if (el.classList.contains('mod-floating')) {
        this._disarmFloat(el); el.classList.remove('mod-floating');
        el.style.left = el.style.top = el.style.width = el.style.height = '';
      }
      const home = el.dataset.modHomePanel || 'sidebar';
      const panel = this._panelEl(home);
      if (panel && el.parentElement !== panel) this._appendToPanel(el, panel);
      el.classList.remove('mod-collapsed');
      el.querySelector(':scope > .mod-collapsed-label')?.remove();
      this._refreshControls(el);
    });
    this._showToast('Layout reset');
  }

  // ── Toast ─────────────────────────────────────────────
  _showToast(msg) {
    const t = document.createElement('div');
    t.className = 'mod-toast';
    t.textContent = msg;
    document.body.appendChild(t);
    requestAnimationFrame(() => t.classList.add('show'));
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 2400);
  }
}