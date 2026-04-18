// ═══════════════════════════════════════════════════════════
// Haven — Mod Mode v4 (layout customisation)
// - All sidebar + right-sidebar sections are controllable.
// - Sections can be reordered, moved between panels, or
//   floated as draggable/resizable windows.
// - Floating pill with Save & Exit (non-blocking).
// - Status bar top/bottom toggle in the pill.
// - Per-section collapse, multi-select, separate desktop/mobile.
// ═══════════════════════════════════════════════════════════

class ModMode {
  constructor() {
    this.active = false;
    this.container = null;
    this.floatLayer = null;
    this.selection = new Set();
    this.dragSrc = null;
    this.dragGroup = [];

    this.sectionPanels = ['sidebar-mod-container', 'right-sidebar', 'float-layer'];

    this.defaultState = () => ({
      sections: {},
      statusBarPos: 'bottom',
    });

    this.state = { desktop: this.defaultState(), mobile: this.defaultState() };

    this._bound = {
      dragStart:     this._onDragStart.bind(this),
      dragOver:      this._onDragOver.bind(this),
      dragEnter:     this._onDragEnter.bind(this),
      dragLeave:     this._onDragLeave.bind(this),
      drop:          this._onDrop.bind(this),
      dragEnd:       this._onDragEnd.bind(this),
      floatDrag:     this._onFloatDragOver.bind(this),
      floatDrop:     this._onFloatDrop.bind(this),
      headerClick:   this._onHeaderClick.bind(this),
      keydown:       this._onKey.bind(this),
      mqChange:      this._onBreakpointChange.bind(this),
      panelDropOver: this._onPanelDropOver.bind(this),
      panelDropDrop: this._onPanelDropDrop.bind(this),
    };

    this.mq = window.matchMedia('(max-width: 900px)');
  }

  /* ── Init ─────────────────────────────────────────── */

  init() {
    this.container = document.getElementById('sidebar-mod-container');
    if (!this.container) return;
    this._loadState();
    this._cacheHomePanels();
    this._ensureFloatLayer();
    this.applyLayout();
    this._armAllFloatingPanes();
    document.getElementById('mod-mode-reset')?.addEventListener('click', () => this.resetLayout());
    this.mq.addEventListener?.('change', this._bound.mqChange);
  }

  /* ── State ────────────────────────────────────────── */

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
      if (!el.dataset.modHomePanel) el.dataset.modHomePanel = this._detectHomePanel(el);
    });
  }

  _detectHomePanel(el) {
    if (el.closest('#sidebar-mod-container')) return 'sidebar-mod-container';
    if (el.closest('.right-sidebar'))         return 'right-sidebar';
    return 'sidebar-mod-container';
  }

  _ensureFloatLayer() {
    let layer = document.getElementById('mod-float-layer');
    if (!layer) {
      layer = document.createElement('div');
      layer.id = 'mod-float-layer';
      layer.className = 'mod-float-layer';
      document.body.appendChild(layer);
    }
    this.floatLayer = layer;
  }

  /* ── Enable / Disable ─────────────────────────────── */

  toggle() {
    this.active ? this._disable() : this._enable();
    this.active = !this.active;
  }

  _enable() {
    const settingsModal = document.getElementById('settings-modal');
    if (settingsModal) settingsModal.style.display = 'none';

    document.body.classList.add('mod-mode-on');
    this.container?.classList.add('mod-mode-active');

    this._getAllSections().forEach(s => this._armSection(s));
    this._armDropTargets();
    this._armFloatLayer();
    this._showPill();

    document.addEventListener('keydown', this._bound.keydown);
    document.addEventListener('dragend', this._bound.dragEnd);
    this._showToast('Mod Mode ON — drag headers or ⋮⋮ handles to rearrange');
  }

  _disable() {
    document.body.classList.remove('mod-mode-on');
    this.container?.classList.remove('mod-mode-active');

    this._getAllSections().forEach(s => this._disarmSection(s));
    this._disarmDropTargets();
    this._disarmFloatLayer();
    this._clearSelection();
    this._hidePill();

    document.removeEventListener('keydown', this._bound.keydown);
    document.removeEventListener('dragend', this._bound.dragEnd);

    this._persistFromDom();
    this._saveState();
    this._showToast('Mod Mode OFF — layout saved');
  }

  _onBreakpointChange() {
    if (this.active) this._persistFromDom();
    this._saveState();
    this.applyLayout();
  }

  _onKey(e) {
    if (e.key === 'Escape' && this.active) { this.toggle(); return; }
    if (e.key === 'Delete' && this.selection.size > 0) {
      this.selection.forEach(id => this._resetSectionToHome(id));
      this._clearSelection();
    }
  }

  /* ── Pill (floating Save & Exit + status bar toggle) ── */

  _showPill() {
    let pill = document.getElementById('mod-mode-pill');
    if (!pill) {
      pill = document.createElement('div');
      pill.id = 'mod-mode-pill';
      pill.className = 'mod-pill';
      const sbPos = this.layout.statusBarPos || 'bottom';
      const sbLabel = sbPos === 'bottom' ? '↑ Bar Top' : '↓ Bar Bottom';
      pill.innerHTML = `
        <button type="button" class="mod-pill-btn mod-pill-save" id="mod-pill-exit" title="Save & exit">✓ Save & Exit</button>
        <button type="button" class="mod-pill-btn" id="mod-pill-reset" title="Reset layout">↺</button>
        <button type="button" class="mod-pill-btn" id="mod-pill-sb" title="Move status bar">${sbLabel}</button>
      `;
      document.body.appendChild(pill);
      pill.querySelector('#mod-pill-exit').addEventListener('click', () => this.toggle());
      pill.querySelector('#mod-pill-reset').addEventListener('click', () => this.resetLayout());
      pill.querySelector('#mod-pill-sb').addEventListener('click', () => this._toggleStatusBarPos());
    }
    pill.style.display = 'flex';
    this._updatePillSbLabel();
  }

  _hidePill() {
    const pill = document.getElementById('mod-mode-pill');
    if (pill) pill.style.display = 'none';
  }

  _toggleStatusBarPos() {
    const cur = this.layout.statusBarPos || 'bottom';
    this.layout.statusBarPos = cur === 'bottom' ? 'top' : 'bottom';
    this._applyStatusBarPos();
    this._saveState();
    this._updatePillSbLabel();
    this._showToast(`Status bar → ${this.layout.statusBarPos}`);
  }

  _applyStatusBarPos() {
    const pos = this.layout.statusBarPos || 'bottom';
    const app = document.getElementById('app');
    if (app) app.dataset.statusPos = pos;
  }

  _updatePillSbLabel() {
    const btn = document.getElementById('mod-pill-sb');
    if (!btn) return;
    const pos = this.layout.statusBarPos || 'bottom';
    btn.textContent = pos === 'bottom' ? '↑ Bar Top' : '↓ Bar Bottom';
  }

  /* ── Sections ─────────────────────────────────────── */

  _getAllSections() { return [...document.querySelectorAll('[data-mod-id]')]; }

  /* Find a label element inside a section — supports both
     .section-label (sidebar) and .panel-title (right sidebar) */
  _findLabels(s) {
    return [...s.querySelectorAll('.section-label, .panel-title')];
  }

  _armSection(s) {
    s.classList.add('mod-draggable');
    s.addEventListener('dragstart', this._bound.dragStart);
    s.addEventListener('dragover',  this._bound.dragOver);
    s.addEventListener('dragenter', this._bound.dragEnter);
    s.addEventListener('dragleave', this._bound.dragLeave);
    s.addEventListener('drop',      this._bound.drop);
    this._injectSectionControls(s);
    /* Make labels and the drag handle draggable sources */
    this._findLabels(s).forEach(label => {
      label.setAttribute('draggable', 'true');
      label.style.cursor = 'grab';
      label.addEventListener('click', this._bound.headerClick);
    });
    const handle = s.querySelector('.mod-sec-handle');
    if (handle) handle.setAttribute('draggable', 'true');
  }

  _disarmSection(s) {
    s.classList.remove('mod-draggable', 'mod-drag-over', 'mod-drop-above',
                       'mod-drop-below', 'mod-dragging', 'mod-selected');
    s.removeEventListener('dragstart', this._bound.dragStart);
    s.removeEventListener('dragover',  this._bound.dragOver);
    s.removeEventListener('dragenter', this._bound.dragEnter);
    s.removeEventListener('dragleave', this._bound.dragLeave);
    s.removeEventListener('drop',      this._bound.drop);
    this._findLabels(s).forEach(label => {
      label.removeAttribute('draggable');
      label.style.cursor = '';
      label.removeEventListener('click', this._bound.headerClick);
    });
    const handle = s.querySelector('.mod-sec-handle');
    if (handle) handle.removeAttribute('draggable');
    this._removeSectionControls(s);
    s.querySelector(':scope > .mod-collapsed-label')?.remove();
  }

  _injectSectionControls(s) {
    if (s.querySelector(':scope > .mod-section-controls')) return;
    const isFloating = s.classList.contains('mod-floating');
    const bar = document.createElement('div');
    bar.className = 'mod-section-controls';
    bar.innerHTML = `
      <button type="button" class="mod-sec-btn" data-act="collapse" title="Collapse / Expand">▾</button>
      <button type="button" class="mod-sec-btn" data-act="float" title="${isFloating ? 'Dock back' : 'Float as window'}">
        ${isFloating ? '⮽' : '⧉'}
      </button>
      <span class="mod-sec-handle" title="Drag to reorder">⋮⋮</span>
    `;
    bar.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (!act) return;
      e.stopPropagation();
      if (act === 'collapse') this._toggleCollapse(s);
      else if (act === 'float') this._toggleFloat(s);
    });
    s.appendChild(bar);
    const id = s.dataset.modId;
    const meta = this.layout.sections[id];
    if (meta?.collapsed) s.classList.add('mod-collapsed');
    this._syncCollapseLabel(s);
  }

  _removeSectionControls(s) {
    s.querySelector(':scope > .mod-section-controls')?.remove();
  }

  _updateFloatBtn(s) {
    const btn = s.querySelector('.mod-section-controls [data-act="float"]');
    if (!btn) return;
    const isFloating = s.classList.contains('mod-floating');
    btn.innerHTML = isFloating ? '⮽' : '⧉';
    btn.title = isFloating ? 'Dock back' : 'Float as window';
  }

  _toggleCollapse(s) {
    const id = s.dataset.modId;
    s.classList.toggle('mod-collapsed');
    this.layout.sections[id] = Object.assign(this.layout.sections[id] || {}, {
      collapsed: s.classList.contains('mod-collapsed')
    });
    this._syncCollapseLabel(s);
    this._saveState();
  }

  _toggleFloat(s) {
    const id = s.dataset.modId;
    if (s.classList.contains('mod-floating')) {
      /* Dock back to home panel */
      this._resetSectionToHome(id);
      this._updateFloatBtn(s);
    } else {
      /* Float it */
      const float = { x: 120, y: 80, w: 320, h: 280 };
      this._placeFloat(s, float);
      this.layout.sections[id] = Object.assign(this.layout.sections[id] || {}, {
        panel: 'float-layer', float
      });
      this._updateFloatBtn(s);
      this._saveState();
    }
  }

  _syncCollapseLabel(s) {
    const isCollapsed = s.classList.contains('mod-collapsed');
    /* Only truly direct .section-label children survive the collapse CSS rule */
    const hasDirectLabel = !!s.querySelector(':scope > .section-label:not(.mod-collapsed-label)');
    const existingLabel = s.querySelector(':scope > .mod-collapsed-label');
    if (isCollapsed && !hasDirectLabel) {
      if (!existingLabel) {
        const label = document.createElement('h5');
        label.className = 'section-label mod-collapsed-label';
        const texts = [...s.querySelectorAll('.section-label-text')]
          .map(el => el.textContent.trim()).filter(Boolean);
        if (!texts.length) {
          const pt = s.querySelector('.panel-title');
          if (pt) texts.push(pt.textContent.trim());
        }
        label.textContent = texts.length ? texts.join(' & ') : (s.dataset.modId || 'Section');
        label.style.cursor = 'pointer';
        label.addEventListener('click', () => this._toggleCollapse(s));
        if (s.classList.contains('mod-draggable')) label.setAttribute('draggable', 'true');
        s.insertBefore(label, s.firstChild);
      }
    } else if (existingLabel) {
      existingLabel.remove();
    }
  }

  _onHeaderClick(e) {
    if (!this.active) return;
    if (!e.shiftKey) return;
    e.preventDefault();
    e.stopPropagation();
    const section = e.currentTarget.closest('[data-mod-id]');
    if (!section) return;
    this._toggleSelected(section);
  }

  _toggleSelected(section) {
    const id = section.dataset.modId;
    if (this.selection.has(id)) { this.selection.delete(id); section.classList.remove('mod-selected'); }
    else                        { this.selection.add(id);    section.classList.add('mod-selected'); }
  }

  _clearSelection() {
    this.selection.forEach(id => {
      document.querySelector(`[data-mod-id="${id}"]`)?.classList.remove('mod-selected');
    });
    this.selection.clear();
  }

  /* ── Section drag/drop (reorder within & between panels) ── */

  _onDragStart(e) {
    /* Only allow drag from an element marked draggable="true" */
    const draggable = e.target.closest?.('[draggable="true"]');
    if (!draggable) return;
    const s = e.currentTarget;
    /* Floating sections use mousedown-drag, not HTML5 drag */
    if (s.classList.contains('mod-floating')) { e.preventDefault(); return; }
    this.dragSrc = s;
    const id = s.dataset.modId;
    if (this.selection.size > 0 && this.selection.has(id)) {
      this.dragGroup = [...this.selection];
    } else {
      this.dragGroup = [id];
      this._clearSelection();
    }
    this.dragGroup.forEach(gid => {
      document.querySelector(`[data-mod-id="${gid}"]`)?.classList.add('mod-dragging');
    });
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('application/x-mod-ids', JSON.stringify(this.dragGroup));
    e.dataTransfer.setData('text/plain', id);
    this._activateFloatLayer();
  }

  _onDragOver(e) {
    if (!this.dragGroup.length) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const target = e.currentTarget;
    if (this.dragGroup.includes(target.dataset.modId)) return;
    const rect = target.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    target.classList.toggle('mod-drop-above', e.clientY < midY);
    target.classList.toggle('mod-drop-below', e.clientY >= midY);
  }

  _onDragEnter(e) {
    if (!this.dragGroup.length) return;
    e.preventDefault();
    if (!this.dragGroup.includes(e.currentTarget.dataset.modId)) {
      e.currentTarget.classList.add('mod-drag-over');
    }
  }

  _onDragLeave(e) {
    e.currentTarget.classList.remove('mod-drag-over', 'mod-drop-above', 'mod-drop-below');
  }

  _onDrop(e) {
    if (!this.dragGroup.length) return;
    e.preventDefault();
    const target = e.currentTarget;
    target.classList.remove('mod-drag-over', 'mod-drop-above', 'mod-drop-below');
    if (this.dragGroup.includes(target.dataset.modId)) return;
    const parent = target.parentElement;
    const rect = target.getBoundingClientRect();
    const insertBefore = e.clientY < rect.top + rect.height / 2;
    const anchor = insertBefore ? target : target.nextSibling;
    this.dragGroup.forEach(id => {
      const el = document.querySelector(`[data-mod-id="${id}"]`);
      if (el && el !== target) {
        this._unfloatSection(el);
        parent.insertBefore(el, anchor);
      }
    });
  }

  _onDragEnd() {
    document.querySelectorAll('.mod-dragging').forEach(el => el.classList.remove('mod-dragging'));
    document.querySelectorAll('.mod-drag-over, .mod-drop-above, .mod-drop-below').forEach(el => {
      el.classList.remove('mod-drag-over', 'mod-drop-above', 'mod-drop-below');
    });
    this.dragSrc = null;
    this.dragGroup = [];
    this._deactivateFloatLayer();
  }

  /* ── Drop target panels ───────────────────────────── */

  _armDropTargets() {
    const targets = [
      document.getElementById('sidebar-mod-container'),
      document.querySelector('.right-sidebar'),
    ].filter(Boolean);
    targets.forEach(t => {
      t.classList.add('mod-drop-panel');
      t.addEventListener('dragover', this._bound.panelDropOver);
      t.addEventListener('drop',     this._bound.panelDropDrop);
    });
    this._dropTargets = targets;
  }

  _disarmDropTargets() {
    (this._dropTargets || []).forEach(t => {
      t.removeEventListener('dragover', this._bound.panelDropOver);
      t.removeEventListener('drop',     this._bound.panelDropDrop);
      t.classList.remove('mod-drop-panel', 'mod-drop-panel-active');
    });
    this._dropTargets = [];
  }

  _onPanelDropOver(e) {
    if (!this.dragGroup.length) return;
    e.preventDefault();
    e.currentTarget.classList.add('mod-drop-panel-active');
  }

  _onPanelDropDrop(e) {
    if (!this.dragGroup.length) return;
    const panel = e.currentTarget;
    panel.classList.remove('mod-drop-panel-active');
    if (e.target.closest('[data-mod-id]')) return;
    e.preventDefault();
    this.dragGroup.forEach(id => {
      const el = document.querySelector(`[data-mod-id="${id}"]`);
      if (!el) return;
      this._unfloatSection(el);
      if (el.parentElement !== panel) panel.appendChild(el);
    });
  }

  /* ── Float layer ──────────────────────────────────── */

  _armFloatLayer() {
    if (!this.floatLayer) return;
    this.floatLayer.addEventListener('dragover', this._bound.floatDrag);
    this.floatLayer.addEventListener('drop', this._bound.floatDrop);
  }

  _disarmFloatLayer() {
    if (!this.floatLayer) return;
    this.floatLayer.classList.remove('active');
    this.floatLayer.removeEventListener('dragover', this._bound.floatDrag);
    this.floatLayer.removeEventListener('drop', this._bound.floatDrop);
  }

  _activateFloatLayer()   { if (this.floatLayer) this.floatLayer.classList.add('active'); }
  _deactivateFloatLayer() { if (this.floatLayer) this.floatLayer.classList.remove('active'); }

  _onFloatDragOver(e) {
    if (!this.dragGroup.length) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }

  _onFloatDrop(e) {
    if (!this.dragGroup.length) return;
    e.preventDefault();
    const layerRect = this.floatLayer.getBoundingClientRect();
    let x = e.clientX - layerRect.left;
    let y = e.clientY - layerRect.top;
    this.dragGroup.forEach((id, i) => {
      const el = document.querySelector(`[data-mod-id="${id}"]`);
      if (!el) return;
      const existing = this.layout.sections[id]?.float;
      const float = {
        x: x + (i * 14),
        y: y + (i * 14),
        w: existing?.w || 320,
        h: existing?.h || 260
      };
      this._placeFloat(el, float);
      this.layout.sections[id] = Object.assign(this.layout.sections[id] || {}, {
        panel: 'float-layer', float
      });
    });
    this._saveState();
  }

  _placeFloat(el, float) {
    if (el.parentElement !== this.floatLayer) this.floatLayer.appendChild(el);
    el.classList.add('mod-floating');
    el.style.left   = float.x + 'px';
    el.style.top    = float.y + 'px';
    el.style.width  = float.w + 'px';
    el.style.height = float.h + 'px';
    this._armFloatingPane(el);
    this._updateFloatBtn(el);
  }

  /* ── Floating pane window-drag (mousedown) ────────── */

  _armFloatingPane(el) {
    if (el._floatArmed) return;
    el._floatArmed = true;

    const onDown = (e) => {
      const trigger = e.target.closest('.mod-float-titlebar, .section-label, .panel-title, .mod-collapsed-label');
      if (!trigger) return;
      if (trigger.getAttribute('draggable') === 'true' && this.active) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const layerRect = this.floatLayer.getBoundingClientRect();
      const offX = e.clientX - rect.left;
      const offY = e.clientY - rect.top;
      const onMove = (ev) => {
        let nx = ev.clientX - layerRect.left - offX;
        let ny = ev.clientY - layerRect.top  - offY;
        nx = Math.max(0, Math.min(layerRect.width  - 40, nx));
        ny = Math.max(0, Math.min(layerRect.height - 40, ny));
        el.style.left = nx + 'px';
        el.style.top  = ny + 'px';
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        const id = el.dataset.modId;
        const meta = this.layout.sections[id];
        if (meta?.float) {
          meta.float.x = parseInt(el.style.left) || 0;
          meta.float.y = parseInt(el.style.top)  || 0;
        }
        this._saveState();
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    };

    el.addEventListener('mousedown', onDown);
    el._floatCleanup = () => {
      el.removeEventListener('mousedown', onDown);
      el._floatArmed = false;
      delete el._floatCleanup;
    };

    if (!el.querySelector(':scope > .mod-float-titlebar')) {
      const titlebar = document.createElement('div');
      titlebar.className = 'mod-float-titlebar';
      const texts = [...el.querySelectorAll('.section-label-text')]
        .map(t => t.textContent.trim()).filter(Boolean);
      if (!texts.length) {
        const pt = el.querySelector('.panel-title');
        if (pt) texts.push(pt.textContent.trim());
      }
      titlebar.textContent = texts.length ? texts.join(' & ') : (el.dataset.modId || 'Section');
      el.insertBefore(titlebar, el.firstChild);
    }
  }

  _disarmFloatingPane(el) {
    if (el._floatCleanup) el._floatCleanup();
    el.querySelector(':scope > .mod-float-titlebar')?.remove();
  }

  _armAllFloatingPanes() {
    this.floatLayer?.querySelectorAll('.mod-floating').forEach(el => {
      this._armFloatingPane(el);
    });
  }

  /* ── Apply layout ─────────────────────────────────── */

  applyLayout() {
    this._applyStatusBarPos();
    this.applySectionLayout();
  }

  applySectionLayout() {
    const sections = this.layout.sections;
    const panelTargets = {
      'sidebar-mod-container': document.getElementById('sidebar-mod-container'),
      'right-sidebar':         document.querySelector('.right-sidebar'),
      'float-layer':           this.floatLayer
    };
    const ordered = Object.entries(sections)
      .filter(([, m]) => typeof m.index === 'number')
      .sort(([, a], [, b]) => a.index - b.index);

    ordered.forEach(([id, meta]) => {
      const el = document.querySelector(`[data-mod-id="${id}"]`);
      if (!el) return;
      const parent = panelTargets[meta.panel];
      if (!parent) return;
      if (meta.panel === 'float-layer' && meta.float) {
        this._placeFloat(el, meta.float);
      } else {
        this._unfloatSection(el);
        if (el.parentElement !== parent) parent.appendChild(el);
      }
      el.classList.toggle('mod-collapsed', !!meta.collapsed);
      this._syncCollapseLabel(el);
    });
  }

  _unfloatSection(el) {
    if (el.classList.contains('mod-floating')) {
      this._disarmFloatingPane(el);
      el.classList.remove('mod-floating');
      el.style.left = el.style.top = el.style.width = el.style.height = '';
    }
  }

  _persistFromDom() {
    const sections = {};
    const panelIndices = {};
    this._getAllSections().forEach(el => {
      const id = el.dataset.modId;
      const panel = this._resolvePanelOf(el);
      panelIndices[panel] = (panelIndices[panel] ?? -1) + 1;
      const prev = this.layout.sections[id] || {};
      sections[id] = {
        panel,
        index: panelIndices[panel],
        collapsed: el.classList.contains('mod-collapsed'),
        float: panel === 'float-layer' ? (prev.float || null) : null
      };
    });
    this.layout.sections = sections;
  }

  _resolvePanelOf(el) {
    if (el.closest('#mod-float-layer'))       return 'float-layer';
    if (el.closest('#sidebar-mod-container')) return 'sidebar-mod-container';
    if (el.closest('.right-sidebar'))         return 'right-sidebar';
    return el.dataset.modHomePanel || 'sidebar-mod-container';
  }

  _resetSectionToHome(id) {
    const el = document.querySelector(`[data-mod-id="${id}"]`);
    if (!el) return;
    this._unfloatSection(el);
    const home = el.dataset.modHomePanel || 'sidebar-mod-container';
    const homeEl = {
      'sidebar-mod-container': document.getElementById('sidebar-mod-container'),
      'right-sidebar':         document.querySelector('.right-sidebar'),
    }[home];
    if (homeEl) homeEl.appendChild(el);
    el.classList.remove('mod-collapsed');
    el.querySelector(':scope > .mod-collapsed-label')?.remove();
    this.layout.sections[id] = { panel: home, index: 999, collapsed: false, float: null };
    this._updateFloatBtn(el);
    this._saveState();
  }

  /* ── Reset ────────────────────────────────────────── */

  resetLayout() {
    this.state[this.layoutKey] = this.defaultState();
    this._saveState();
    this._applyStatusBarPos();
    this._updatePillSbLabel();
    this._getAllSections().forEach(el => {
      this._unfloatSection(el);
      const home = el.dataset.modHomePanel || 'sidebar-mod-container';
      const parent = {
        'sidebar-mod-container': document.getElementById('sidebar-mod-container'),
        'right-sidebar':         document.querySelector('.right-sidebar'),
      }[home];
      if (parent && el.parentElement !== parent) parent.appendChild(el);
      el.classList.remove('mod-collapsed');
      el.querySelector(':scope > .mod-collapsed-label')?.remove();
    });
    this._showToast('Layout reset to defaults');
  }

  /* ── Toast ────────────────────────────────────────── */

  _showToast(msg) {
    const t = document.createElement('div');
    t.className = 'mod-toast';
    t.textContent = msg;
    document.body.appendChild(t);
    requestAnimationFrame(() => t.classList.add('show'));
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 2400);
  }
}