// ═══════════════════════════════════════════════════════════
// Haven — Mod Mode (layout customisation) v2
// - Sections can live in any drop-capable panel (not just the
//   left sidebar) or float freely on a dedicated overlay layer.
// - Panels can be resized and snapped to edges/corners.
// - Per-section collapse state, multi-section select + group
//   drag, 8px grid snapping for floats, and separate layouts
//   for desktop vs. mobile breakpoints.
// ═══════════════════════════════════════════════════════════

class ModMode {
  constructor() {
    this.active = false;
    this.container = null;
    this.floatLayer = null;
    this.draggingPanelKey = null;
    this.snapZones = [];
    this.panelHandles = new Map();
    this.resizeHandles = new Map();
    this.resizeObservers = new Map();
    this.selection = new Set();
    this.dragSrc = null;
    this.dragGroup = [];
    this.gridSnap = true;
    this.gridSize = 8;

    this.panelDefs = {
      'server-bar':    { selector: '#server-bar',    positions: ['left', 'right'],                    dropMode: null,       resizable: false },
      'sidebar':       { selector: '.sidebar',       positions: ['left', 'right'],                    dropMode: 'stack',    resizable: true,  resizeAxis: 'x', defaultSize: 280, minSize: 180, maxSize: 520 },
      'right-sidebar': { selector: '.right-sidebar', positions: ['left', 'right', 'center'],          dropMode: 'stack',    resizable: true,  resizeAxis: 'x', defaultSize: 260, minSize: 180, maxSize: 520 },
      'status-bar':    { selector: '#status-bar',    positions: ['bottom', 'top'],                    dropMode: 'inline',   resizable: false },
      'voice-panel':   { selector: '#voice-panel',   positions: ['right-sidebar', 'left-sidebar', 'bottom', 'center'], dropMode: null, resizable: false }
    };

    this.sectionPanels = ['sidebar-mod-container', 'right-sidebar-drop', 'status-bar-drop', 'float-layer'];

    this.defaultState = () => ({
      panels: {
        'server-bar':    { pos: 'left' },
        'sidebar':       { pos: 'left',  size: 280 },
        'right-sidebar': { pos: 'right', size: 260 },
        'status-bar':    { pos: 'bottom' },
        'voice-panel':   { pos: 'right-sidebar' }
      },
      sections: {},  // id -> { panel, index, collapsed, float: {x,y,w,h}|null }
      settings: { gridSnap: true }
    });

    this.state = { desktop: this.defaultState(), mobile: this.defaultState() };

    this._bound = {
      dragStart:   this._onDragStart.bind(this),
      dragOver:    this._onDragOver.bind(this),
      dragEnter:   this._onDragEnter.bind(this),
      dragLeave:   this._onDragLeave.bind(this),
      drop:        this._onDrop.bind(this),
      dragEnd:     this._onDragEnd.bind(this),
      panelStart:  this._onPanelDragStart.bind(this),
      panelEnd:    this._onPanelDragEnd.bind(this),
      floatDrag:   this._onFloatDragOver.bind(this),
      floatDrop:   this._onFloatDrop.bind(this),
      headerClick: this._onHeaderClick.bind(this),
      keydown:     this._onKey.bind(this),
      mqChange:    this._onBreakpointChange.bind(this),
      panelDropOver: this._onPanelDropOver.bind(this),
      panelDropDrop: this._onPanelDropDrop.bind(this)
    };

    this.mq = window.matchMedia('(max-width: 900px)');
  }

  init() {
    this.container = document.getElementById('sidebar-mod-container');
    if (!this.container) return;
    this._migrateLegacyState();
    this._loadState();
    this._cacheHomePanels();
    this._ensureFloatLayer();
    this.applyLayout();
    document.getElementById('mod-mode-reset')?.addEventListener('click', () => this.resetLayout());
    this.mq.addEventListener?.('change', this._bound.mqChange);
  }

  // ── State ──

  get layoutKey() { return this.mq.matches ? 'mobile' : 'desktop'; }
  get layout()    { return this.state[this.layoutKey]; }

  _migrateLegacyState() {
    if (localStorage.getItem('haven-layout-v2')) return;
    let order = null, panel = null;
    try { order = JSON.parse(localStorage.getItem('haven-layout')); } catch {}
    try { panel = JSON.parse(localStorage.getItem('haven-panel-layout')); } catch {}
    if (!order && !panel) return;
    const desktop = this.defaultState();
    if (Array.isArray(order)) {
      order.forEach((id, i) => {
        desktop.sections[id] = { panel: 'sidebar-mod-container', index: i, collapsed: false, float: null };
      });
    }
    if (panel && typeof panel === 'object') {
      Object.keys(desktop.panels).forEach(k => {
        if (this.panelDefs[k]?.positions.includes(panel[k])) desktop.panels[k].pos = panel[k];
      });
    }
    this.state.desktop = desktop;
    localStorage.setItem('haven-layout-v2', JSON.stringify(this.state));
  }

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
    this.gridSnap = this.layout.settings?.gridSnap !== false;
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
    if (el.closest('.right-sidebar'))         return 'right-sidebar-drop';
    if (el.closest('#status-bar'))            return 'status-bar-drop';
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

  toggle() { this.active ? this._disable() : this._enable(); this.active = !this.active; }

  _enable() {
    // Close settings modal so users can see what they're modifying
    const settingsModal = document.getElementById('settings-modal');
    if (settingsModal) settingsModal.style.display = 'none';
    document.body.classList.add('mod-mode-on');
    this.container.classList.add('mod-mode-active');
    this._getAllSections().forEach(s => this._armSection(s));
    this._armPanels();
    this._armDropTargets();
    this._armFloatLayer();
    document.addEventListener('keydown', this._bound.keydown);
    document.addEventListener('dragend', this._bound.dragEnd);
    this._showToast('Mod Mode ON \u2014 drag section headers or \u2725 handles to rearrange');
  }

  _disable() {
    document.body.classList.remove('mod-mode-on');
    this.container.classList.remove('mod-mode-active');
    this._getAllSections().forEach(s => this._disarmSection(s));
    this._disarmPanels();
    this._disarmDropTargets();
    this._disarmFloatLayer();
    this._clearSelection();
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
    // Make section labels and the drag handle the actual drag sources —
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
    // Remove draggable from all labels and handle
    s.querySelectorAll('.section-label').forEach(label => {
      label.removeAttribute('draggable');
      label.removeEventListener('click', this._bound.headerClick);
    });
    const handle = s.querySelector('.mod-sec-handle');
    if (handle) handle.removeAttribute('draggable');
    this._removeSectionControls(s);
    // Remove injected collapsed label (collapse state persists via class)
    s.querySelector(':scope > .mod-collapsed-label')?.remove();
  }

  _injectSectionControls(s) {
    if (s.querySelector(':scope > .mod-section-controls')) return;
    const bar = document.createElement('div');
    bar.className = 'mod-section-controls';
    bar.innerHTML = `
      <button type="button" class="mod-sec-btn" data-act="collapse" title="Collapse / expand">\u25be</button>
      <button type="button" class="mod-sec-btn" data-act="home" title="Return to home panel">\u2302</button>
      <span class="mod-sec-handle" title="Drag">\u2725</span>
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

  // ── Section drag/drop ──

  _onDragStart(e) {
    const s = e.currentTarget;
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
    // Activate float layer as a drop target only while dragging
    this._activateFloatLayer();
  }

  _onDragOver(e) {
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
    e.preventDefault();
    if (!this.dragGroup.includes(e.currentTarget.dataset.modId)) {
      e.currentTarget.classList.add('mod-drag-over');
    }
  }

  _onDragLeave(e) {
    e.currentTarget.classList.remove('mod-drag-over', 'mod-drop-above', 'mod-drop-below');
  }

  _onDrop(e) {
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
      if (el && el !== target) parent.insertBefore(el, anchor);
    });
  }

  _onDragEnd() {
    document.querySelectorAll('.mod-dragging').forEach(el => el.classList.remove('mod-dragging'));
    document.querySelectorAll('.mod-drag-over, .mod-drop-above, .mod-drop-below').forEach(el => {
      el.classList.remove('mod-drag-over', 'mod-drop-above', 'mod-drop-below');
    });
    this.dragSrc = null;
    this.dragGroup = [];
    // Deactivate float layer so it stops blocking clicks
    this._deactivateFloatLayer();
  }

  // ── Drop targets (panels accepting sections) ──

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
      el.classList.remove('mod-floating');
      el.style.left = el.style.top = el.style.width = el.style.height = '';
      if (el.parentElement !== panel) panel.appendChild(el);
    });
  }

  // ── Float layer (detached tiles) ──

  _armFloatLayer() {
    if (!this.floatLayer) return;
    // Don't add 'active' here — it enables pointer-events on the full-screen
    // overlay which blocks all clicks.  Instead, activate only during drags.
    this.floatLayer.addEventListener('dragover', this._bound.floatDrag);
    this.floatLayer.addEventListener('drop', this._bound.floatDrop);
    Object.entries(this.layout.sections).forEach(([id, meta]) => {
      if (meta.panel === 'float-layer' && meta.float) {
        const el = document.querySelector(`[data-mod-id="${id}"]`);
        if (el) this._placeFloat(el, meta.float);
      }
    });
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
    const snap = this.gridSnap && !e.altKey;
    if (snap) { x = Math.round(x / this.gridSize) * this.gridSize; y = Math.round(y / this.gridSize) * this.gridSize; }
    this.dragGroup.forEach((id, i) => {
      const el = document.querySelector(`[data-mod-id="${id}"]`);
      if (!el) return;
      const existing = this.layout.sections[id]?.float;
      const float = {
        x: x + (i * 14),
        y: y + (i * 14),
        w: existing?.w || 260,
        h: existing?.h || 200
      };
      this._placeFloat(el, float);
      this.layout.sections[id] = Object.assign(this.layout.sections[id] || {}, { panel: 'float-layer', float });
    });
    this._saveState();
  }

  _placeFloat(el, float) {
    if (el.parentElement !== this.floatLayer) this.floatLayer.appendChild(el);
    el.classList.add('mod-floating');
    el.style.left = float.x + 'px';
    el.style.top  = float.y + 'px';
    el.style.width = float.w + 'px';
    el.style.height = float.h + 'px';
    this._observeFloatResize(el);
  }

  _observeFloatResize(el) {
    const id = el.dataset.modId;
    if (this.resizeObservers.has(id)) return;
    const ro = new ResizeObserver(entries => {
      for (const entry of entries) {
        const r = entry.contentRect;
        const meta = this.layout.sections[id];
        if (!meta?.float) continue;
        meta.float.w = Math.round(r.width);
        meta.float.h = Math.round(r.height);
      }
      this._saveStateDebounced();
    });
    ro.observe(el);
    this.resizeObservers.set(id, ro);
  }

  _saveStateDebounced() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this._saveState(), 400);
  }

  // ── Panels (snap handles + resize) ──

  _armPanels() {
    Object.entries(this.panelDefs).forEach(([key, def]) => {
      const panel = document.querySelector(def.selector);
      if (!panel) return;
      panel.classList.add('mod-panel-target');
      let handle = panel.querySelector(':scope > .mod-panel-handle');
      if (!handle) {
        handle = document.createElement('button');
        handle.type = 'button';
        handle.className = 'mod-panel-handle';
        handle.textContent = '\u2725';
        handle.title = `Drag to reposition ${key.replace(/-/g, ' ')}`;
        panel.appendChild(handle);
      }
      handle.setAttribute('draggable', 'true');
      handle.dataset.panelKey = key;
      handle.addEventListener('dragstart', this._bound.panelStart);
      handle.addEventListener('dragend',   this._bound.panelEnd);
      this.panelHandles.set(key, handle);
      if (def.resizable) this._armResize(key, panel, def);
    });
  }

  _disarmPanels() {
    this._clearSnapZones();
    this.draggingPanelKey = null;
    this.panelHandles.forEach((handle, key) => {
      handle.removeEventListener('dragstart', this._bound.panelStart);
      handle.removeEventListener('dragend',   this._bound.panelEnd);
      handle.removeAttribute('draggable');
      const panel = document.querySelector(this.panelDefs[key].selector);
      panel?.classList.remove('mod-panel-target');
    });
    this.panelHandles.clear();
    this._disarmResize();
  }

  _armResize(key, panel, def) {
    let handle = panel.querySelector(':scope > .mod-resize-handle');
    if (!handle) {
      handle = document.createElement('div');
      handle.className = `mod-resize-handle axis-${def.resizeAxis}`;
      panel.appendChild(handle);
    }
    const onDown = (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = panel.getBoundingClientRect().width;
      const isRight = panel.dataset.panelPos === 'right';
      const onMove = (ev) => {
        const delta = (ev.clientX - startX) * (isRight ? -1 : 1);
        let w = Math.max(def.minSize, Math.min(def.maxSize, startW + delta));
        panel.style.width = w + 'px';
        this.layout.panels[key].size = Math.round(w);
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        this._saveState();
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    };
    handle.addEventListener('mousedown', onDown);
    this.resizeHandles.set(key, { handle, onDown });
  }

  _disarmResize() {
    this.resizeHandles.forEach(({ handle, onDown }) => {
      handle.removeEventListener('mousedown', onDown);
    });
    this.resizeHandles.clear();
  }

  _onPanelDragStart(e) {
    const key = e.currentTarget.dataset.panelKey;
    if (!key || !this.panelDefs[key]) return;
    this.draggingPanelKey = key;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', `panel:${key}`);
    e.currentTarget.classList.add('dragging');
    this._showSnapZones(key);
  }

  _onPanelDragEnd(e) {
    e.currentTarget.classList.remove('dragging');
    this.draggingPanelKey = null;
    this._clearSnapZones();
  }

  _showSnapZones(key) {
    this._clearSnapZones();
    const positions = this.panelDefs[key]?.positions || [];
    const labels = {
      left: '\u2190 Left', right: 'Right \u2192', top: '\u2191 Top',
      bottom: '\u2193 Bottom', center: '\u2b24 Float',
      'right-sidebar': 'In right panel', 'left-sidebar': 'In left panel'
    };
    positions.forEach(pos => {
      const zone = document.createElement('div');
      zone.className = `mod-snap-zone ${pos}`;
      zone.dataset.panelKey = key;
      zone.dataset.pos = pos;
      zone.textContent = labels[pos] || pos;
      zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('active'); });
      zone.addEventListener('dragleave', () => zone.classList.remove('active'));
      zone.addEventListener('drop', (e) => {
        e.preventDefault();
        zone.classList.remove('active');
        this._setPanelPosition(key, pos);
      });
      document.body.appendChild(zone);
      this.snapZones.push(zone);
    });
  }

  _clearSnapZones() {
    this.snapZones.forEach(z => z.remove());
    this.snapZones = [];
  }

  _setPanelPosition(key, pos) {
    if (!this.panelDefs[key]?.positions.includes(pos)) return;
    this.layout.panels[key] = Object.assign(this.layout.panels[key] || {}, { pos });
    this.applyPanelLayout();
    this._saveState();
    this._showToast(`Moved ${key.replace(/-/g, ' ')} \u2192 ${pos.replace(/-/g, ' ')}`);
  }

  // ── Apply layout to DOM ──

  applyLayout() {
    this.applyPanelLayout();
    this.applySectionLayout();
  }

  applyPanelLayout() {
    const panels = this.layout.panels;
    const serverBar    = document.getElementById('server-bar');
    const sidebar      = document.querySelector('.sidebar');
    const rightSidebar = document.querySelector('.right-sidebar');
    const app          = document.getElementById('app');
    const voicePanel   = document.getElementById('voice-panel');

    if (serverBar)    serverBar.dataset.panelPos = panels['server-bar']?.pos || 'left';
    if (sidebar)      sidebar.dataset.panelPos   = panels.sidebar?.pos || 'left';
    if (app)          app.dataset.statusPos      = panels['status-bar']?.pos || 'bottom';

    if (sidebar && panels.sidebar?.size) sidebar.style.width = panels.sidebar.size + 'px';
    if (rightSidebar && panels['right-sidebar']?.size) rightSidebar.style.width = panels['right-sidebar'].size + 'px';

    if (rightSidebar) {
      const rsPos = panels['right-sidebar']?.pos || 'right';
      rightSidebar.dataset.panelPos = rsPos;
      rightSidebar.classList.toggle('mod-float', rsPos === 'center');
    }

    if (voicePanel) {
      const vpPos = panels['voice-panel']?.pos || 'right-sidebar';
      voicePanel.dataset.modPos = vpPos;
      voicePanel.classList.remove('mod-float', 'mod-voice-bottom', 'mod-voice-left');

      if (vpPos === 'center') {
        voicePanel.classList.add('mod-float');
      } else if (vpPos === 'bottom') {
        voicePanel.classList.add('mod-voice-bottom');
      } else if (vpPos === 'left-sidebar') {
        voicePanel.classList.add('mod-voice-left');
        const sidebarBottom = document.querySelector('.sidebar-bottom');
        if (sidebarBottom && voicePanel.parentElement !== sidebarBottom) {
          sidebarBottom.insertBefore(voicePanel, sidebarBottom.firstChild);
        }
      } else if (rightSidebar && voicePanel.parentElement !== rightSidebar) {
        rightSidebar.appendChild(voicePanel);
      }
    }
  }

  applySectionLayout() {
    const sections = this.layout.sections;
    const panelTargets = {
      'sidebar-mod-container': document.getElementById('sidebar-mod-container'),
      'right-sidebar-drop':    document.querySelector('.right-sidebar'),
      'status-bar-drop':       document.getElementById('status-bar'),
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
        el.classList.remove('mod-floating');
        el.style.left = el.style.top = el.style.width = el.style.height = '';
        if (el.parentElement !== parent) parent.appendChild(el);
      }
      el.classList.toggle('mod-collapsed', !!meta.collapsed);
      this._syncCollapseLabel(el);
    });
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
    this.layout.settings = { gridSnap: this.gridSnap };
  }

  _resolvePanelOf(el) {
    if (el.closest('#mod-float-layer'))      return 'float-layer';
    if (el.closest('#sidebar-mod-container'))return 'sidebar-mod-container';
    if (el.closest('.right-sidebar'))        return 'right-sidebar-drop';
    if (el.closest('#status-bar'))           return 'status-bar-drop';
    return el.dataset.modHomePanel || 'sidebar-mod-container';
  }

  _resetSectionToHome(id) {
    const el = document.querySelector(`[data-mod-id="${id}"]`);
    if (!el) return;
    const home = el.dataset.modHomePanel || 'sidebar-mod-container';
    const homeEl = {
      'sidebar-mod-container': document.getElementById('sidebar-mod-container'),
      'right-sidebar-drop':    document.querySelector('.right-sidebar'),
      'status-bar-drop':       document.getElementById('status-bar')
    }[home];
    if (homeEl) homeEl.appendChild(el);
    el.classList.remove('mod-floating');
    el.style.left = el.style.top = el.style.width = el.style.height = '';
    this.layout.sections[id] = { panel: home, index: 999, collapsed: false, float: null };
    this._saveState();
  }

  // ── Reset ──

  resetLayout() {
    this.state[this.layoutKey] = this.defaultState();
    this._saveState();
    this._getAllSections().forEach(el => {
      const home = el.dataset.modHomePanel || 'sidebar-mod-container';
      const parent = {
        'sidebar-mod-container': document.getElementById('sidebar-mod-container'),
        'right-sidebar-drop':    document.querySelector('.right-sidebar'),
        'status-bar-drop':       document.getElementById('status-bar')
      }[home];
      if (parent && el.parentElement !== parent) parent.appendChild(el);
      el.classList.remove('mod-floating', 'mod-collapsed');
      el.style.left = el.style.top = el.style.width = el.style.height = '';
    });
    const sidebar = document.querySelector('.sidebar');
    const rightSidebar = document.querySelector('.right-sidebar');
    if (sidebar) sidebar.style.width = '';
    if (rightSidebar) rightSidebar.style.width = '';
    const voicePanel = document.getElementById('voice-panel');
    if (voicePanel && rightSidebar) {
      rightSidebar.appendChild(voicePanel);
      voicePanel.classList.remove('mod-float', 'mod-voice-bottom', 'mod-voice-left');
    }
    this.applyPanelLayout();
    this._showToast('Layout reset to default');
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
