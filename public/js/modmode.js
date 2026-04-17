// ═══════════════════════════════════════════════════════════
// Haven — Mod Mode (layout customisation) v3
// - Sections can be reordered within panels via drag-and-drop.
// - Sections can be floated: free-floating windows that are
//   draggable and resizable even OUTSIDE mod mode.
// - A persistent toolbar appears in mod mode with Save & Exit.
// - Per-section collapse state with safe recovery labels.
// - Separate layouts for desktop vs. mobile breakpoints.
// ═══════════════════════════════════════════════════════════

class ModMode {
  constructor() {
    this.active = false;
    this.container = null;
    this.floatLayer = null;
    this.selection = new Set();
    this.dragSrc = null;
    this.dragGroup = [];

    /* Section panels — where data-mod-id sections can live */
    this.sectionPanels = ['sidebar-mod-container', 'right-sidebar', 'status-bar', 'float-layer'];

    this.defaultState = () => ({
      sections: {},  // id -> { panel, index, collapsed, float: {x,y,w,h}|null }
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

  // ── Initialisation ──

  init() {
    this.container = document.getElementById('sidebar-mod-container');
    if (!this.container) return;
    this._loadState();
    this._cacheHomePanels();
    this._ensureFloatLayer();
    this.applyLayout();
    // Restore floating pane interactivity on load (even outside mod mode)
    this._armAllFloatingPanes();
    document.getElementById('mod-mode-reset')?.addEventListener('click', () => this.resetLayout());
    this.mq.addEventListener?.('change', this._bound.mqChange);
  }

  // ── State ──

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
        el.dataset.modHomePanel = this._detectHomePanel(el);
      }
    });
  }

  _detectHomePanel(el) {
    if (el.closest('#sidebar-mod-container')) return 'sidebar-mod-container';
    if (el.closest('.right-sidebar'))         return 'right-sidebar';
    if (el.closest('#status-bar'))            return 'status-bar';
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

  // ── Enable / Disable ──

  toggle() {
    this.active ? this._disable() : this._enable();
    this.active = !this.active;
  }

  _enable() {
    // Close settings modal so users can see what they're modifying
    const settingsModal = document.getElementById('settings-modal');
    if (settingsModal) settingsModal.style.display = 'none';

    document.body.classList.add('mod-mode-on');
    this.container.classList.add('mod-mode-active');

    this._getAllSections().forEach(s => this._armSection(s));
    this._armDropTargets();
    this._armFloatLayer();
    this._showToolbar();

    document.addEventListener('keydown', this._bound.keydown);
    document.addEventListener('dragend', this._bound.dragEnd);
  }

  _disable() {
    document.body.classList.remove('mod-mode-on');
    this.container.classList.remove('mod-mode-active');

    this._getAllSections().forEach(s => this._disarmSection(s));
    this._disarmDropTargets();
    this._disarmFloatLayer();
    this._clearSelection();
    this._hideToolbar();

    document.removeEventListener('keydown', this._bound.keydown);
    document.removeEventListener('dragend', this._bound.dragEnd);

    this._persistFromDom();
    this._saveState();
    this._showToast('Mod Mode OFF \u2014 layout saved');
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

  // ── Toolbar (visible during mod mode) ──

  _showToolbar() {
    let bar = document.getElementById('mod-mode-toolbar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'mod-mode-toolbar';
      bar.className = 'mod-toolbar';
      bar.innerHTML = `
        <span class="mod-toolbar-label">\u270f\ufe0f Mod Mode</span>
        <button type="button" class="mod-toolbar-btn" id="mod-toolbar-reset" title="Reset to defaults">\u21ba Reset</button>
        <button type="button" class="mod-toolbar-btn mod-toolbar-save" id="mod-toolbar-exit" title="Save & exit mod mode">\u2713 Save & Exit</button>
      `;
      document.body.appendChild(bar);
      bar.querySelector('#mod-toolbar-exit').addEventListener('click', () => this.toggle());
      bar.querySelector('#mod-toolbar-reset').addEventListener('click', () => this.resetLayout());
    }
    bar.style.display = 'flex';
  }

  _hideToolbar() {
    const bar = document.getElementById('mod-mode-toolbar');
    if (bar) bar.style.display = 'none';
  }

  // ── Sections ──

  _getAllSections() { return [...document.querySelectorAll('[data-mod-id]')]; }

  _armSection(s) {
    s.classList.add('mod-draggable');
    // dragstart bubbles from draggable children (labels, handle) to the section
    s.addEventListener('dragstart', this._bound.dragStart);
    // Drop listeners (accept drops from other sections)
    s.addEventListener('dragover',  this._bound.dragOver);
    s.addEventListener('dragenter', this._bound.dragEnter);
    s.addEventListener('dragleave', this._bound.dragLeave);
    s.addEventListener('drop',      this._bound.drop);
    this._injectSectionControls(s);
    // Make section labels and the drag handle actual drag sources \u2014
    // the section body itself is NOT draggable (prevents scroll conflicts)
    s.querySelectorAll('.section-label').forEach(label => {
      label.setAttribute('draggable', 'true');
      label.addEventListener('click', this._bound.headerClick);
    });
    const handle = s.querySelector('.mod-sec-handle');
    if (handle) handle.setAttribute('draggable', 'true');
  }

  _disarmSection(s) {
    s.classList.remove('mod-draggable', 'mod-drag-over', 'mod-drop-above', 'mod-drop-below', 'mod-dragging', 'mod-selected');
    s.removeEventListener('dragstart', this._bound.dragStart);
    s.removeEventListener('dragover',  this._bound.dragOver);
    s.removeEventListener('dragenter', this._bound.dragEnter);
    s.removeEventListener('dragleave', this._bound.dragLeave);
    s.removeEventListener('drop',      this._bound.drop);
    s.querySelectorAll('.section-label').forEach(label => {
      label.removeAttribute('draggable');
      label.removeEventListener('click', this._bound.headerClick);
    });
    const handle = s.querySelector('.mod-sec-handle');
    if (handle) handle.removeAttribute('draggable');
    this._removeSectionControls(s);
    s.querySelector(':scope > .mod-collapsed-label')?.remove();
  }

  _injectSectionControls(s) {
    if (s.querySelector(':scope > .mod-section-controls')) return;
    const bar = document.createElement('div');
    bar.className = 'mod-section-controls';
    bar.innerHTML = `
      <button type="button" class="mod-sec-btn" data-act="collapse" title="Collapse / expand">\u25be</button>
      <button type="button" class="mod-sec-btn" data-act="home" title="Return to home panel">\u2302</button>
      <span class="mod-sec-handle" title="Drag to reorder">\u2725</span>
    `;
    bar.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (!act) return;
      e.stopPropagation();
      if (act === 'collapse') this._toggleCollapse(s);
      else if (act === 'home') this._resetSectionToHome(s.dataset.modId);
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

  _toggleCollapse(s) {
    const id = s.dataset.modId;
    s.classList.toggle('mod-collapsed');
    const collapsed = s.classList.contains('mod-collapsed');
    this.layout.sections[id] = Object.assign(this.layout.sections[id] || {}, { collapsed });
    this._syncCollapseLabel(s);
    this._saveState();
  }

  /* For sections without a direct .section-label (e.g. sidebar-split),
     inject a visible label so they don't vanish when collapsed. */
  _syncCollapseLabel(s) {
    const isCollapsed = s.classList.contains('mod-collapsed');
    const hasDirectLabel = !!s.querySelector(':scope > .section-label:not(.mod-collapsed-label)');
    const existingLabel = s.querySelector(':scope > .mod-collapsed-label');
    if (isCollapsed && !hasDirectLabel) {
      if (!existingLabel) {
        const label = document.createElement('h5');
        label.className = 'section-label mod-collapsed-label';
        const texts = [...s.querySelectorAll('.section-label-text')]
          .map(el => el.textContent.trim()).filter(Boolean);
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

  // ── Section drag/drop (reordering within & between panels) ──

  _onDragStart(e) {
    /* Only start if the drag originated from a draggable child (label/handle) */
    if (!e.target.matches || !e.target.closest('[draggable="true"]')) return;
    const s = e.currentTarget;
    /* Don't allow reorder-drag on floating sections \u2014 they use mousedown drag */
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
    // Activate float layer as drop target while dragging
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

  // ── Drop targets (panels that accept sections) ──

  _armDropTargets() {
    const targets = [
      document.getElementById('sidebar-mod-container'),
      document.querySelector('.right-sidebar'),
      document.getElementById('status-bar')
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
    if (e.target.closest('[data-mod-id]')) return; // section-level drop already handled
    e.preventDefault();
    this.dragGroup.forEach(id => {
      const el = document.querySelector(`[data-mod-id="${id}"]`);
      if (!el) return;
      this._unfloatSection(el);
      if (el.parentElement !== panel) panel.appendChild(el);
    });
  }

  // ── Float layer (detached tiles) ──

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
      this.layout.sections[id] = Object.assign(this.layout.sections[id] || {}, { panel: 'float-layer', float });
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
  }

  /* ---------- Floating pane window-drag (mousedown) ----------
     Works both IN and OUT of mod mode.  Dragging the .mod-float-titlebar
     or any .section-label inside the pane moves it. */
  _armFloatingPane(el) {
    if (el._floatArmed) return;
    el._floatArmed = true;

    const onDown = (e) => {
      // Only initiate window-drag from title bar / section labels
      const trigger = e.target.closest('.mod-float-titlebar, .section-label, .mod-collapsed-label');
      if (!trigger) return;
      // Don't fight with the HTML5 reorder-drag when mod mode labels are draggable
      if (trigger.getAttribute('draggable') === 'true' && this.active) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const layerRect = this.floatLayer.getBoundingClientRect();
      const offX = e.clientX - rect.left;
      const offY = e.clientY - rect.top;

      const onMove = (ev) => {
        let nx = ev.clientX - layerRect.left - offX;
        let ny = ev.clientY - layerRect.top  - offY;
        // Clamp to viewport
        nx = Math.max(0, Math.min(layerRect.width  - 40, nx));
        ny = Math.max(0, Math.min(layerRect.height - 40, ny));
        el.style.left = nx + 'px';
        el.style.top  = ny + 'px';
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        // Persist new position
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

    // Inject a title bar for the floating pane
    if (!el.querySelector(':scope > .mod-float-titlebar')) {
      const titlebar = document.createElement('div');
      titlebar.className = 'mod-float-titlebar';
      const texts = [...el.querySelectorAll('.section-label-text')]
        .map(t => t.textContent.trim()).filter(Boolean);
      titlebar.textContent = texts.length ? texts.join(' & ') : (el.dataset.modId || 'Section');
      el.insertBefore(titlebar, el.firstChild);
    }
  }

  _disarmFloatingPane(el) {
    if (el._floatCleanup) el._floatCleanup();
    el.querySelector(':scope > .mod-float-titlebar')?.remove();
  }

  /** Arm all currently-floating panes (called on init for persistence across reload) */
  _armAllFloatingPanes() {
    this.floatLayer?.querySelectorAll('.mod-floating').forEach(el => {
      this._armFloatingPane(el);
    });
  }

  // ── Apply layout to DOM ──

  applyLayout() { this.applySectionLayout(); }

  applySectionLayout() {
    const sections = this.layout.sections;
    const panelTargets = {
      'sidebar-mod-container': document.getElementById('sidebar-mod-container'),
      'right-sidebar':         document.querySelector('.right-sidebar'),
      'status-bar':            document.getElementById('status-bar'),
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
    if (el.closest('#status-bar'))            return 'status-bar';
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
      'status-bar':            document.getElementById('status-bar')
    }[home];
    if (homeEl) homeEl.appendChild(el);
    el.classList.remove('mod-collapsed');
    el.querySelector(':scope > .mod-collapsed-label')?.remove();
    this.layout.sections[id] = { panel: home, index: 999, collapsed: false, float: null };
    this._saveState();
  }

  // ── Reset ──

  resetLayout() {
    this.state[this.layoutKey] = this.defaultState();
    this._saveState();
    this._getAllSections().forEach(el => {
      this._unfloatSection(el);
      const home = el.dataset.modHomePanel || 'sidebar-mod-container';
      const parent = {
        'sidebar-mod-container': document.getElementById('sidebar-mod-container'),
        'right-sidebar':         document.querySelector('.right-sidebar'),
        'status-bar':            document.getElementById('status-bar')
      }[home];
      if (parent && el.parentElement !== parent) parent.appendChild(el);
      el.classList.remove('mod-collapsed');
      el.querySelector(':scope > .mod-collapsed-label')?.remove();
    });
    this._showToast('Layout reset to defaults');
  }

  // ── Toast ──

  _showToast(msg) {
    const t = document.createElement('div');
    t.className = 'mod-toast';
    t.textContent = msg;
    document.body.appendChild(t);
    requestAnimationFrame(() => t.classList.add('show'));
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 2400);
  }
}
