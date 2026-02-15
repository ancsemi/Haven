class ModMode {
  constructor() {
    this.active = false;
    this.container = null;
    this.sections = [];
    this.dragSrc = null;
    this.savedLayout = null;
    this.panelLayout = { 'server-bar': 'left', 'sidebar': 'left', 'status-bar': 'bottom' };
    this.panelDefs = {
      'server-bar': { selector: '#server-bar', positions: ['left', 'right'] },
      'sidebar': { selector: '.sidebar', positions: ['left', 'right'] },
      'status-bar': { selector: '#status-bar', positions: ['bottom', 'top'] }
    };
    this.panelHandles = new Map();
    this.snapZones = [];
    this.draggingPanelKey = null;
    this._boundDragStart = this._onDragStart.bind(this);
    this._boundDragOver = this._onDragOver.bind(this);
    this._boundDragEnter = this._onDragEnter.bind(this);
    this._boundDragLeave = this._onDragLeave.bind(this);
    this._boundDrop = this._onDrop.bind(this);
    this._boundDragEnd = this._onDragEnd.bind(this);
    this._boundPanelDragStart = this._onPanelDragStart.bind(this);
    this._boundPanelDragEnd = this._onPanelDragEnd.bind(this);
  }
  init() {
    this.container = document.getElementById('sidebar-mod-container');
    if (!this.container) return;
    this._loadLayout();
    this._loadPanelLayout();
    this._cacheSections();
    this.applyLayout();
    this.applyPanelLayout();
    document.getElementById('mod-mode-toggle')?.addEventListener('click', () => this.toggle());
    document.getElementById('mod-mode-reset')?.addEventListener('click', () => this.resetLayout());
  }
  _cacheSections() {
    this.sections = [...this.container.querySelectorAll('[data-mod-id]')];
  }
  _loadLayout() {
    try { this.savedLayout = JSON.parse(localStorage.getItem('haven-layout')); } catch { this.savedLayout = null; }
  }
  _loadPanelLayout() {
    try {
      const raw = JSON.parse(localStorage.getItem('haven-panel-layout') || 'null');
      if (!raw || typeof raw !== 'object') return;
      Object.keys(this.panelDefs).forEach(k => {
        if (this.panelDefs[k].positions.includes(raw[k])) this.panelLayout[k] = raw[k];
      });
    } catch {}
  }
  toggle() {
    this.active = !this.active;
    this.active ? this._enable() : this._disable();
  }
  _enable() {
    this.container.classList.add('mod-mode-active');
    document.body.classList.add('mod-mode-on');
    this._cacheSections();
    this.sections.forEach(s => {
      s.setAttribute('draggable', 'true');
      s.classList.add('mod-draggable');
      s.addEventListener('dragstart', this._boundDragStart);
      s.addEventListener('dragover', this._boundDragOver);
      s.addEventListener('dragenter', this._boundDragEnter);
      s.addEventListener('dragleave', this._boundDragLeave);
      s.addEventListener('drop', this._boundDrop);
      s.addEventListener('dragend', this._boundDragEnd);
    });
    this._enablePanelMode();
    this._showToast('Mod Mode ON — drag sections or panel handles');
  }
  _disable() {
    this.container.classList.remove('mod-mode-active');
    document.body.classList.remove('mod-mode-on');
    this.sections.forEach(s => {
      s.setAttribute('draggable', 'false');
      s.classList.remove('mod-draggable', 'mod-drag-over', 'mod-drop-above', 'mod-drop-below', 'mod-dragging');
      s.removeEventListener('dragstart', this._boundDragStart);
      s.removeEventListener('dragover', this._boundDragOver);
      s.removeEventListener('dragenter', this._boundDragEnter);
      s.removeEventListener('dragleave', this._boundDragLeave);
      s.removeEventListener('drop', this._boundDrop);
      s.removeEventListener('dragend', this._boundDragEnd);
    });
    this._disablePanelMode();
    this._saveLayout();
    this._savePanelLayout();
    this._showToast('Mod Mode OFF — layout saved');
  }
  _onDragStart(e) {
    this.dragSrc = e.currentTarget;
    e.currentTarget.classList.add('mod-dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', e.currentTarget.dataset.modId);
  }
  _onDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const target = e.currentTarget;
    if (target === this.dragSrc) return;
    const rect = target.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    target.classList.toggle('mod-drop-above', e.clientY < midY);
    target.classList.toggle('mod-drop-below', e.clientY >= midY);
  }
  _onDragEnter(e) {
    e.preventDefault();
    if (e.currentTarget !== this.dragSrc) e.currentTarget.classList.add('mod-drag-over');
  }
  _onDragLeave(e) {
    e.currentTarget.classList.remove('mod-drag-over', 'mod-drop-above', 'mod-drop-below');
  }
  _onDrop(e) {
    e.preventDefault();
    const target = e.currentTarget;
    target.classList.remove('mod-drag-over', 'mod-drop-above', 'mod-drop-below');
    if (!this.dragSrc || target === this.dragSrc) return;
    const rect = target.getBoundingClientRect();
    const insertBefore = e.clientY < rect.top + rect.height / 2;
    if (insertBefore) this.container.insertBefore(this.dragSrc, target);
    else if (target.nextSibling) this.container.insertBefore(this.dragSrc, target.nextSibling);
    else this.container.appendChild(this.dragSrc);
    this._cacheSections();
  }
  _onDragEnd(e) {
    e.currentTarget.classList.remove('mod-dragging');
    this.sections.forEach(s => s.classList.remove('mod-drag-over', 'mod-drop-above', 'mod-drop-below'));
    this.dragSrc = null;
  }
  _enablePanelMode() {
    Object.keys(this.panelDefs).forEach(key => {
      const panel = document.querySelector(this.panelDefs[key].selector);
      if (!panel) return;
      panel.classList.add('mod-panel-target');
      let handle = panel.querySelector('.mod-panel-handle');
      if (!handle) {
        handle = document.createElement('button');
        handle.type = 'button';
        handle.className = 'mod-panel-handle';
        handle.textContent = '↕';
        panel.appendChild(handle);
      }
      handle.setAttribute('draggable', 'true');
      handle.dataset.panelKey = key;
      handle.addEventListener('dragstart', this._boundPanelDragStart);
      handle.addEventListener('dragend', this._boundPanelDragEnd);
      this.panelHandles.set(key, handle);
    });
  }
  _disablePanelMode() {
    this._clearSnapZones();
    this.draggingPanelKey = null;
    this.panelHandles.forEach((handle, key) => {
      handle.removeEventListener('dragstart', this._boundPanelDragStart);
      handle.removeEventListener('dragend', this._boundPanelDragEnd);
      handle.removeAttribute('draggable');
      const panel = document.querySelector(this.panelDefs[key].selector);
      if (panel) panel.classList.remove('mod-panel-target');
    });
    this.panelHandles.clear();
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
    positions.forEach(pos => {
      const zone = document.createElement('div');
      zone.className = `mod-snap-zone ${pos}`;
      zone.dataset.panelKey = key;
      zone.dataset.pos = pos;
      zone.textContent = `${key.replace('-', ' ')}: ${pos}`;
      zone.addEventListener('dragover', (e) => {
        e.preventDefault();
        zone.classList.add('active');
      });
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
    this.panelLayout[key] = pos;
    this.applyPanelLayout();
    this._savePanelLayout();
    this._showToast(`Moved ${key.replace('-', ' ')} to ${pos}`);
  }
  _saveLayout() {
    const order = this.sections.map(s => s.dataset.modId);
    localStorage.setItem('haven-layout', JSON.stringify(order));
    this.savedLayout = order;
  }
  _savePanelLayout() {
    localStorage.setItem('haven-panel-layout', JSON.stringify(this.panelLayout));
  }
  applyLayout() {
    if (!this.savedLayout || !this.container) return;
    const existing = new Map();
    this.sections.forEach(s => existing.set(s.dataset.modId, s));
    this.savedLayout.forEach(id => {
      const el = existing.get(id);
      if (el) this.container.appendChild(el);
    });
    this._cacheSections();
  }
  applyPanelLayout() {
    const serverBar = document.getElementById('server-bar');
    const sidebar = document.querySelector('.sidebar');
    const app = document.getElementById('app');
    if (serverBar) serverBar.dataset.panelPos = this.panelLayout['server-bar'];
    if (sidebar) sidebar.dataset.panelPos = this.panelLayout.sidebar;
    if (app) app.dataset.statusPos = this.panelLayout['status-bar'];
  }
  resetLayout() {
    localStorage.removeItem('haven-layout');
    localStorage.removeItem('haven-panel-layout');
    this.savedLayout = null;
    this.panelLayout = { 'server-bar': 'left', 'sidebar': 'left', 'status-bar': 'bottom' };
    const defaultOrder = ['join', 'create', 'channels'];
    const existing = new Map();
    this.sections.forEach(s => existing.set(s.dataset.modId, s));
    defaultOrder.forEach(id => {
      const el = existing.get(id);
      if (el) this.container.appendChild(el);
    });
    this._cacheSections();
    this.applyPanelLayout();
    this._showToast('Layout reset to default');
  }
  _showToast(msg) {
    const t = document.createElement('div');
    t.className = 'mod-toast';
    t.textContent = msg;
    document.body.appendChild(t);
    requestAnimationFrame(() => t.classList.add('show'));
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 2200);
  }
}
