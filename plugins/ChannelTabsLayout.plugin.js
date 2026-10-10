/**
 * @name Channel Tabs Layout
 * @description Reversible Channels/DMs sidebar tabs with a Join/Create modal.
 * @author birdcrazy
 * @version 1.0.0
 */

class ChannelTabsLayout {
  static ID = 'ChannelTabsLayout';

  constructor() {
    this._started = false;
    this._engaged = false;
    this._suspended = false;

    this._style = null;
    this._tabs = null;
    this._modal = null;
    this._modalContent = null;

    this._moved = [];
    this._createButtonText = null;
    this._notificationHook = null;
    this._hookTimer = null;
    this._listeners = [];
    this._generatedSplit = false;
    this._split = null;

    this._boundOwnerChange = this._onOwnerChange.bind(this);
    this._boundEditingChange = this._onEditingChange.bind(this);
    this._boundDelegatedClick = this._onDelegatedClick.bind(this);
  }

  // ─────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────

  start() {
    if (this._started) return;
    this._started = true;
    this._suspended = document.documentElement.hasAttribute('data-haven-layout-editing');

    document.addEventListener('haven:layout-owner-change', this._boundOwnerChange);
    document.addEventListener('haven:layout-editing', this._boundEditingChange);

    if (HavenApi.Data.load(ChannelTabsLayout.ID, 'layoutOn', '1') !== '0') {
      this._engage(false);
    }
  }

  stop() {
    if (!this._started) return;
    this._disengage(false);
    document.removeEventListener('haven:layout-owner-change', this._boundOwnerChange);
    document.removeEventListener('haven:layout-editing', this._boundEditingChange);
    this._started = false;
  }

  _onOwnerChange() {
    if (!this._engaged) return;

    const owner = document.documentElement.getAttribute('data-haven-layout-owner');

    if (owner && owner !== ChannelTabsLayout.ID) {
      // Another layout has acquired ownership. Restore our DOM,
      // but do not release ownership from the new layout.
      this._disengage(false, false);
    }
  }

  _onEditingChange() {
    const editing = document.documentElement.hasAttribute('data-haven-layout-editing');

    if (editing && this._engaged) {
      this._suspended = true;
      this._disengage(false);
    } else if (!editing && this._suspended) {
      this._suspended = false;

      if (HavenApi.Data.load(ChannelTabsLayout.ID, 'layoutOn', '1' ) !== '0') {
        this._engage(false);
      }
    }
  }

  _engage(persist = true) {
    if (this._engaged || this._suspended) return false;

    const channelsPane = document.getElementById('channels-pane');
    const dmPane = document.getElementById('dm-pane');

    if (!channelsPane || !dmPane) {
      console.warn('[Channel Tabs] Could not find #channels-pane and #dm-pane.');
      return false;
    }

    if (!HavenApi.Layout.acquire(ChannelTabsLayout.ID)) {
      return false;
    }

    try {
      this._engaged = true;
      this._applyLayout();

      if (persist) {
        HavenApi.Data.save(ChannelTabsLayout.ID, 'layoutOn', '1');
      }

      return true;
    } catch (error) {
      this._restoreLayout();
      this._engaged = false;

      try {
        HavenApi.Layout.release(ChannelTabsLayout.ID);
      } catch (_) {}

      console.error('[Channel Tabs] Failed to engage layout:', error);
      return false;
    }
  }

  _disengage(persist = true, releaseOwnership = true) {
    if (!this._engaged) return;

    this._engaged = false;
    this._restoreLayout();

    if (releaseOwnership) {
      try {
        HavenApi.Layout.release(ChannelTabsLayout.ID);
      } catch (error) {
        console.warn('[Channel Tabs] Layout release failed:', error);
      }
    }

    if (persist) {
      HavenApi.Data.save(ChannelTabsLayout.ID, 'layoutOn', '0');
    }
  }

  // ─────────────────────────────────────────────────────
  // Reversible DOM manipulation
  // ─────────────────────────────────────────────────────

  // Only the position is remembered. Haven keeps changing these sections
  // while the layout is on (the Create section is shown or hidden as
  // permissions arrive), so putting back an old class or style would undo
  // Haven's own update.
  _moveElement(element, destination, before = null) {
    if (!element || !element.parentNode) return;

    this._moved.push({
      element,
      parent: element.parentNode,
      nextSibling: element.nextSibling
    });

    destination.insertBefore(element, before);
  }

  _restoreMovedElements() {
    // Restore in reverse order so sibling anchors that were moved
    // elsewhere are restored before their dependants.
    for (let i = this._moved.length - 1; i >= 0; i--) {
      const { element, parent, nextSibling } = this._moved[i];

      if (!parent) continue;
      const anchor = nextSibling && nextSibling.parentNode === parent ? nextSibling : null;

      parent.insertBefore(element, anchor);
    }

    this._moved = [];

    // Put back the create button's own label, unless Haven changed it since.
    const text = this._createButtonText;
    if (text && text.element.textContent === text.label) {
      text.element.textContent = text.original;
    }
    this._createButtonText = null;
  }

  _applyLayout() {
    const channelsPane = document.getElementById('channels-pane');
    const dmPane = document.getElementById('dm-pane');

    if (!channelsPane || !dmPane) {
      throw new Error('Required sidebar panes were not found.');
    }

    document.documentElement.setAttribute('data-sidebar-tabs-layout', '1');

    this._installStyles();
    this._ensureSplit();
    this._createTabs();
    this._createModal();
    if (!this._installNotificationHook()) this._retryNotificationHook();
    this._moveJoinCreateSections();
    this._bindEvents();

    this._setChannelTab(this._loadActiveTab() === 'DMs' ? 'DMs' : 'channels');
  }

  // The open tab lives with the plugin's own data, not in a loose
  // localStorage key of its own. The first version used 'activeChannelTab';
  // pick that up once and drop it.
  _loadActiveTab() {
    let legacy = null;
    try {
      legacy = localStorage.getItem('activeChannelTab');
      if (legacy !== null) localStorage.removeItem('activeChannelTab');
    } catch (error) {
      console.warn('[Channel Tabs] Could not read the old tab choice:', error);
    }
    if (legacy === 'DMs' || legacy === 'channels') {
      this._saveActiveTab(legacy);
      return legacy;
    }
    try {
      return HavenApi.Data.load(ChannelTabsLayout.ID, 'activeTab', 'channels');
    } catch (error) {
      console.warn('[Channel Tabs] Could not read the tab choice:', error);
      return 'channels';
    }
  }

  _saveActiveTab(tab) {
    try {
      HavenApi.Data.save(ChannelTabsLayout.ID, 'activeTab', tab);
    } catch (error) {
      // The tab still switches; it just is not remembered after a reload.
      console.warn('[Channel Tabs] Could not save the tab choice:', error);
    }
  }

  _ensureSplit() {
    const channelsPane = document.getElementById('channels-pane');
    const dmPane = document.getElementById('dm-pane');

    let split = document.getElementById('sidebar-split');

    if (split) {
      this._split = split;
      return;
    }

    // Older Haven layouts may not have the shared split wrapper.
    // Create one while remembering the original positions of its children.
    split = document.createElement('div');
    split.id = 'sidebar-split';
    split.className = 'sidebar-split';
    split.dataset.modId = 'channels';

    channelsPane.parentNode.insertBefore(split, channelsPane);

    this._moveElement(channelsPane, split);

    const handle = document.getElementById('sidebar-split-handle');
    if (handle) this._moveElement(handle, split);

    this._moveElement(dmPane, split);

    this._split = split;
    this._generatedSplit = true;
  }

  _createTabs() {
    if (this._tabs) return;

    const tabs = document.createElement('div');
    tabs.id = 'channel-dm-select';
    tabs.className = 'sidebar-section channel-tabs';
    tabs.dataset.modId = 'channel-dm-select';

    tabs.innerHTML = `
      <button type="button" class="channel-tab settings-tab" data-channel-tab="channels">
        # <span>Channels</span>
        <span class="channel-tab-notify-dot settings-tab" id="channels-channel-tab-notify-dot" style="display:none">
          <span class="channel-tab-notify-dot-indicator"></span>
        </span>
      </button>

      <button type="button" class="channel-tab settings-tab" data-channel-tab="DMs">
        👥 <span>DMs</span>
        <span class="channel-tab-notify-dot settings-tab" id="DMs-channel-tab-notify-dot" style="display:none">
          <span class="channel-tab-notify-dot-indicator"></span>
        </span>
      </button>

      <button type="button" class="join-create-btn" id="join-create-btn" title="Join or create channels" aria-label="Join or create channels">➕</button>
    `;

    this._split.parentNode.insertBefore(tabs, this._split);
    this._tabs = tabs;
  }

  _createModal() {
    if (this._modal) return;

    const modal = document.createElement('div');
    modal.id = 'join-create-modal';
    modal.className = 'modal-overlay';
    modal.style.display = 'none';

    modal.innerHTML = `
      <div class="modal modal-wide channel-tabs-modal"
           role="dialog"
           aria-modal="true"
           aria-labelledby="channel-tabs-modal-title">

        <h3 id="channel-tabs-modal-title">
          ➕ Join or Create Channel
        </h3>

        <div class="channel-tabs-modal-content"></div>

        <div class="modal-actions">
          <button type="button"
                  class="btn-sm"
                  id="close-join-create-btn">Close</button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    this._modal = modal;
    this._modalContent = modal.querySelector('.channel-tabs-modal-content');
  }

  _updateChannelTabNotificationDots(channels = [], unreadCounts = {}) {
    const channelDot = document.getElementById('channels-channel-tab-notify-dot');
    const dmDot = document.getElementById('DMs-channel-tab-notify-dot');

    if (!channelDot && !dmDot) return;

    let hasChannelUnread = false;
    let hasDmUnread = false;

    // Muted channels do not count, the same as Haven's tab title and
    // desktop badge.
    let muted = new Set();
    try {
      muted = new Set(JSON.parse(localStorage.getItem('haven_muted_channels') || '[]'));
    } catch (error) {
      console.warn('[Channel Tabs] Could not read muted channels:', error);
    }

    for (const ch of channels || []) {
      if (!ch || muted.has(ch.code)) continue;
      const counts = unreadCounts || {};
      const count = Object.prototype.hasOwnProperty.call(counts, ch.code) ? counts[ch.code] : (ch.unreadCount || 0);
      if (!(count > 0)) continue;

      if (ch.is_dm) {
        hasDmUnread = true;
      } else {
        hasChannelUnread = true;
      }

      if (hasChannelUnread && hasDmUnread) break;
    }

    if (channelDot) {
      channelDot.style.display = hasChannelUnread ? '' : 'none';
    }

    if (dmDot) {
      dmDot.style.display = hasDmUnread ? '' : 'none';
    }
  }

  _installNotificationHook() {
    const app = window.app;

    if (!app || typeof app._renderChannels !== 'function') {
      return false;
    }

    if (this._notificationHook?.app === app) {
      return true;
    }

    this._removeNotificationHook();

    const plugin = this;
    const hooks = [];

    // Refresh the dots after the channel list renders and whenever Haven
    // recounts unread messages. _updateBadge always ends in _updateTabTitle,
    // and the paths that skip _updateBadge (reading a DM in PiP, coming back
    // to the window) call _updateTabTitle directly.
    for (const method of ['_renderChannels', '_updateTabTitle']) {
      if (typeof app[method] !== 'function') continue;

      const original = app[method];
      const own = Object.prototype.hasOwnProperty.call(app, method);

      const wrapped = function (...args) {
        const result = original.apply(this, args);
        plugin._updateChannelTabNotificationDots(this.channels, this.unreadCounts);
        return result;
      };

      app[method] = wrapped;
      hooks.push({ method, original, wrapped, own });
    }

    this._notificationHook = { app, hooks };

    // Initialize the dots using the current state.
    this._updateChannelTabNotificationDots(app.channels, app.unreadCounts);

    return true;
  }

  // The layout can come on before Haven's app object exists (a saved
  // choice applied at page load); keep trying for a little while.
  _retryNotificationHook(attempt = 0) {
    clearTimeout(this._hookTimer);
    this._hookTimer = null;
    if (!this._engaged || attempt >= 40) return;
    this._hookTimer = setTimeout(() => {
      this._hookTimer = null;
      if (this._engaged && !this._installNotificationHook()) {
        this._retryNotificationHook(attempt + 1);
      }
    }, 250);
  }

  _removeNotificationHook() {
    clearTimeout(this._hookTimer);
    this._hookTimer = null;
    const hook = this._notificationHook;
    if (!hook) return;

    for (const { method, original, wrapped, own } of hook.hooks) {
      // Don't overwrite another component's wrapper.
      if (hook.app[method] !== wrapped) continue;
      // Haven's methods live on the prototype: deleting the wrapper brings
      // it back rather than leaving a copy on the instance.
      if (own) hook.app[method] = original;
      else delete hook.app[method];
    }

    this._notificationHook = null;
  }

  _moveJoinCreateSections() {
    const joinSection = document.querySelector(
      '.sidebar-section[data-mod-id="join"][data-haven-region="join-channel"]'
    );

    const createSection = document.getElementById('admin-controls');

    if (joinSection) {
      this._moveElement(joinSection, this._modalContent);
    }

    if (createSection) {
      this._moveElement(createSection, this._modalContent);
    }

    const createButton = document.getElementById('create-channel-btn');
    if (createButton) {
      const label = 'Create';
      this._createButtonText = { element: createButton, original: createButton.textContent, label };
      createButton.textContent = label;
    }
  }


  // ─────────────────────────────────────────────────────
  // Tab behavior
  // ─────────────────────────────────────────────────────

  _setChannelTab(tab) {
    if (tab !== 'channels' && tab !== 'DMs') return;

    if (!this._tabs || !this._split) return;

    this._saveActiveTab(tab);

    this._tabs.querySelectorAll('[data-channel-tab]').forEach(button => {
      const active = button.dataset.channelTab === tab;

      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
    });

    const channelsPane = document.getElementById('channels-pane');
    const dmPane = document.getElementById('dm-pane');

    if (channelsPane) {
      channelsPane.classList.toggle('pane-hidden', tab !== 'channels');
    }

    if (dmPane) {
      dmPane.classList.toggle('pane-hidden', tab !== 'DMs');
    }
  }

  _onDelegatedClick(event) {
    const tabButton = event.target.closest('[data-channel-tab]');

    if (tabButton && this._tabs?.contains(tabButton)) {
      this._setChannelTab(tabButton.dataset.channelTab);
      return;
    }

    if (event.target.closest('#join-create-btn')) {
      this._openModal();
      return;
    }

    if (event.target.closest('#close-join-create-btn')) {
      this._closeModal();
      return;
    }

    if (event.target === this._modal) {
      this._closeModal();
      return;
    }

    // Selecting an item in either list selects the matching tab.
    if (event.target.closest('#channel-list .channel-item')) {
      this._setChannelTab('channels');
      return;
    }

    if (event.target.closest('#dm-list .channel-item')) {
      this._setChannelTab('DMs');
      return;
    }

    // Let Haven's existing join/create handlers process the form first.
    if (event.target.closest('#join-channel-btn')) {
      const input = document.getElementById('channel-code-input');

      if (input?.value.trim()) {
        setTimeout(() => {
          if (this._modal) this._closeModal();
          this._setChannelTab('channels');
        }, 0);
      }

      return;
    }

    if (event.target.closest('#create-channel-btn')) {
      const input = document.getElementById('new-channel-name');

      if (input?.value.trim()) {
        setTimeout(() => {
          if (this._modal) this._closeModal();
          this._setChannelTab('channels');
        }, 0);
      }

      return;
    }

    if (event.target.closest('#create-temp-channel-btn')) {
      setTimeout(() => {
        if (this._modal) this._closeModal();
        this._setChannelTab('channels');
      }, 0);
    }
  }

  _bindEvents() {
    document.addEventListener('click', this._boundDelegatedClick, true);

    this._listeners.push(() => {
      document.removeEventListener('click', this._boundDelegatedClick, true);
    });

    const keyHandler = event => {
      if (event.key === 'Escape' && this._modal?.style.display !== 'none') {
        this._closeModal();
      }
    };

    document.addEventListener('keydown', keyHandler);

    this._listeners.push(() => {
      document.removeEventListener('keydown', keyHandler);
    });
  }

  _openModal() {
    if (!this._modal) return;

    // Haven shows or hides the Create section by permission; leave it be.
    this._modal.style.display = 'flex';
    document.getElementById('channel-code-input')?.focus();
  }

  _closeModal() {
    if (!this._modal) return;

    this._modal.style.display = 'none';
  }

  // ─────────────────────────────────────────────────────
  // Styling
  // ─────────────────────────────────────────────────────

  _installStyles() {
    if (this._style) return;

    const style = document.createElement('style');
    style.id = 'sidebar-tabs-layout-styles';

    style.textContent = `
      html[data-sidebar-tabs-layout="1"] #sidebar-split .channel-section,
      html[data-sidebar-tabs-layout="1"] #sidebar-split .dm-section-pane {
          display: flex;
          flex-direction: column;
          flex: 1 1 0px !important;
          min-height: 0;
          overflow: hidden;
      }
      
      html[data-sidebar-tabs-layout="1"] .temp-channel-create-btn {
        display: none !important;
      }

      html[data-sidebar-tabs-layout="1"] .sidebar-mod-container {
        display: flex;
        flex-direction: column;
        min-height: 0;
      }

      html[data-sidebar-tabs-layout="1"] #sidebar-split {
        display: flex !important;
        flex: 1 1 0;
        flex-direction: column;
        min-height: 0;
        overflow: hidden;
      }

      html[data-sidebar-tabs-layout="1"] #sidebar-split-handle {
        display: none !important;
      }

      html[data-sidebar-tabs-layout="1"] #sidebar-split .channel-section,
      html[data-sidebar-tabs-layout="1"] #sidebar-split .dm-section-pane {
        display: flex;
        flex: 1 1 0;
        flex-direction: column;
        min-height: 0;
        overflow: hidden;
      }

      html[data-sidebar-tabs-layout="1"] #sidebar-split .channel-list,
      html[data-sidebar-tabs-layout="1"] #sidebar-split .dm-list-scroll {
        flex: 1 1 0;
        min-height: 0;
        overflow-x: hidden;
        overflow-y: auto;
      }

      html[data-sidebar-tabs-layout="1"] #sidebar-split .pane-hidden {
        display: none !important;
      }

      html[data-sidebar-tabs-layout="1"] .channel-tabs {
        display: flex;
        flex: 0 0 auto;
        align-items: center;
        gap: 8px;
      }

      html[data-sidebar-tabs-layout="1"] .channel-tab {
        position: relative;
        padding: 0.3125rem 0.875rem;
        font-size: 0.75rem;
        font-weight: 600;
        cursor: pointer;
        transition:
          background 0.15s,
          color 0.15s,
          border-color 0.15s;
      }

      html[data-sidebar-tabs-layout="1"] .channel-tab:hover {
        background: var(--bg-tertiary);
        color: var(--text-primary);
      }

      html[data-sidebar-tabs-layout="1"] .channel-tab.active {
        background: var(--accent);
        color: var(--accent-text);
        border-color: var(--accent);
      }

      html[data-sidebar-tabs-layout="1"] .channel-tab-notify-dot {
        position: absolute;
        top:    -1px;
        right:  -1px;
        width:  13px;
        height: 13px;
        background-color: var(--bg-secondary);
        padding: 0 0;
        border-top: none;
        border-right: none;
        border-radius: 0px 0px 0px 75%;
      }

      html[data-sidebar-tabs-layout="1"] .channel-tab-notify-dot-indicator {
        position: absolute;
        top:    0px;
        right:  0px;
        width:  8px;
        height: 8px;
        background-color: var(--danger);
        border-radius: 50%;
      }

      html[data-sidebar-tabs-layout="1"] .join-create-btn {
        margin-left: auto;
        border-radius: var(--radius-sm);
        background: transparent;
        font-size: 1.2em;
      }

      html[data-sidebar-tabs-layout="1"] .join-create-btn:hover {
        background: var(--bg-hover);
      }

      html[data-sidebar-tabs-layout="1"] #join-create-modal {
        z-index: 10000;
        align-items: center;
        justify-content: center;
      }

      html[data-sidebar-tabs-layout="1"] #join-create-modal .channel-tabs-modal {
        display: flex;
        flex-direction: column;
        width: min(450px, calc(100vw - 24px));
        max-height: 85vh;
        min-width: min(320px, calc(100vw - 24px));
        overflow: hidden;
      }

      html[data-sidebar-tabs-layout="1"] #join-create-modal
      .channel-tabs-modal-content {
        flex: 1 1 auto;
        min-height: 0;
        overflow-y: auto;
      }

      html[data-sidebar-tabs-layout="1"] #join-create-modal
      .channel-tabs-modal-content > .sidebar-section {
        margin-bottom: 8px;
        padding: 0.75rem 1rem;
        border-bottom: 1px solid var(--border);
      }

      html[data-sidebar-tabs-layout="1"] #join-create-modal .modal-actions {
        display: flex;
        justify-content: flex-end;
        flex: 0 0 auto;
        margin-top: auto;
        padding-top: 12px;
      }
    `;

    document.head.appendChild(style);
    this._style = style;
  }

  // ─────────────────────────────────────────────────────
  // Restoration
  // ─────────────────────────────────────────────────────

  _restoreLayout() {
    for (const cleanup of this._listeners.splice(0)) {
      try {
        cleanup();
      } catch (_) {}
    }

    // Sections go home before the modal holding them is removed.
    this._restoreMovedElements();

    if (this._modal) {
      this._modal.remove();
      this._modal = null;
      this._modalContent = null;
    }

    if (this._tabs) {
      this._tabs.remove();
      this._tabs = null;
    }

    for (const id of ['channels-pane', 'dm-pane']) {
      document.getElementById(id)?.classList.remove('pane-hidden');
    }

    this._removeNotificationHook();

    if (this._generatedSplit && this._split) {
      this._split.remove();
    }

    this._split = null;
    this._generatedSplit = false;

    if (this._style) {
      this._style.remove();
      this._style = null;
    }

    document.documentElement.removeAttribute('data-sidebar-tabs-layout');
  }
}

if (typeof module !== 'undefined') {
  module.exports = ChannelTabsLayout;
}

if (typeof _win !== 'undefined') {
  _win.ChannelTabsLayout = ChannelTabsLayout;
}
