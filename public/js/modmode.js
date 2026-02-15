class ModMode {
  constructor() {
    this.active = false;
    this.container = null;
    this.sections = [];
    this.dragSrc = null;
    this.savedLayout = null;
    this._boundDragStart = this._onDragStart.bind(this);
    this._boundDragOver = this._onDragOver.bind(this);
    this._boundDragEnter = this._onDragEnter.bind(this);
    this._boundDragLeave = this._onDragLeave.bind(this);
    this._boundDrop = this._onDrop.bind(this);
    this._boundDragEnd = this._onDragEnd.bind(this);
  }
  init() {
    this.container = document.getElementById('sidebar-mod-container');
    if (!this.container) return;
    this._loadLayout();
    this._cacheSections();
    this.applyLayout();
    document.getElementById('mod-mode-toggle')?.addEventListener('click', () => this.toggle());
    document.getElementById('mod-mode-reset')?.addEventListener('click', () => this.resetLayout());
  }
  _cacheSections() {
    this.sections = [...this.container.querySelectorAll('[data-mod-id]')];
  }
  _loadLayout() {
    try { this.savedLayout = JSON.parse(localStorage.getItem('haven-layout')); } catch { this.savedLayout = null; }
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
    this._showToast('Mod Mode ON — drag sections to rearrange');
  }
  _disable() {
    this.container.classList.remove('mod-mode-active');
    document.body.classList.remove('mod-mode-on');
    this.sections.forEach(s => {
      s.setAttribute('draggable', 'false');
      s.classList.remove('mod-draggable', 'mod-drag-over');
      s.removeEventListener('dragstart', this._boundDragStart);
      s.removeEventListener('dragover', this._boundDragOver);
      s.removeEventListener('dragenter', this._boundDragEnter);
      s.removeEventListener('dragleave', this._boundDragLeave);
      s.removeEventListener('drop', this._boundDrop);
      s.removeEventListener('dragend', this._boundDragEnd);
    });
    this._saveLayout();
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
    e.currentTarget !== this.dragSrc && e.currentTarget.classList.add('mod-drag-over');
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
    insertBefore ? this.container.insertBefore(this.dragSrc, target) : target.nextSibling ? this.container.insertBefore(this.dragSrc, target.nextSibling) : this.container.appendChild(this.dragSrc);
    this._cacheSections();
  }
  _onDragEnd(e) {
    e.currentTarget.classList.remove('mod-dragging');
    this.sections.forEach(s => s.classList.remove('mod-drag-over', 'mod-drop-above', 'mod-drop-below'));
    this.dragSrc = null;
  }
  _saveLayout() {
    const order = this.sections.map(s => s.dataset.modId);
    localStorage.setItem('haven-layout', JSON.stringify(order));
    this.savedLayout = order;
  }
  applyLayout() {
    if (!this.savedLayout || !this.container) return;
    const existing = new Map();
    this.sections.forEach(s => existing.set(s.dataset.modId, s));
    this.savedLayout.forEach(id => {
      const el = existing.get(id);
      el && this.container.appendChild(el);
    });
    this._cacheSections();
  }
  resetLayout() {
    localStorage.removeItem('haven-layout');
    this.savedLayout = null;
    const defaultOrder = ['channels'];
    const existing = new Map();
    this.sections.forEach(s => existing.set(s.dataset.modId, s));
    defaultOrder.forEach(id => {
      const el = existing.get(id);
      el && this.container.appendChild(el);
    });
    this._cacheSections();
    this._showToast('Layout reset to default');
  }
  _showToast(msg) {
    const t = document.createElement('div');
    t.className = 'mod-toast';
    t.textContent = msg;
    document.body.appendChild(t);
    requestAnimationFrame(() => t.classList.add('show'));
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 2000);
  }
}
