/**
 * @name Compact Layout
 * @description Reversible desktop layout from Theme → Layout (Compact layout). Folds the server rail into the navigation sidebar and docks account and voice controls in its footer. Works with any palette. Preserves Haven's tablet, mobile, and message-density behavior.
 * @author bernardokcosta
 * @version 1.1.0
 */
class CompactLayout {
  start() {
    if (this._started) return;
    this._started = true;
    this._engaged = false;
    this._blocked = false;
    this._suspended = document.documentElement.hasAttribute('data-haven-layout-editing');
    this._listeners = [];
    this._placements = [];
    this._inlineRestores = [];
    this._media = window.matchMedia('(min-width: 901px)');

    try {
      HavenApi.DOM.addStyle('CompactLayout', CompactLayout.CSS);
      this._listen(document, 'keydown', (event) => {
        if (!event.ctrlKey || !event.altKey || event.key.toLowerCase() !== 'c') return;
        event.preventDefault();
        this._toggle();
      }, true);
      this._listen(document, 'haven:layout-editing', (event) => {
        this._suspended = event.detail?.active === true;
        if (!this._suspended && event.detail?.owner && event.detail.owner !== 'CompactLayout') {
          this._restoreDesktop();
          return;
        }
        this._syncDesktop();
      });
      this._listen(document, 'haven:layout-owner-change', (event) => {
        if (event.detail?.owner !== 'CompactLayout') this._syncDesktop();
      });
      this._listen(this._media, 'change', () => this._syncDesktop());
      this._listen(document, 'haven:layout-effect', (event) => {
        if (typeof event.detail?.compact !== 'boolean') return;
        if (event.detail.compact) this._engage();
        else this._disengage();
      });
      this._listen(document, 'haven:original-layout', (event) => {
        if (event.detail?.original) this._disengage();
      });

      const saved = HavenApi.Data.load('CompactLayout', 'layoutOn', null);
      const originalOn = document.documentElement.hasAttribute('data-haven-original-layout');
      if (saved !== '0' && !originalOn) this._engage(false);
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  stop() {
    if (!this._started) return;
    this._disengage(false);
    for (const [target, type, listener, options] of this._listeners) {
      target.removeEventListener(type, listener, options);
    }
    this._listeners = [];
    this._media = null;
    HavenApi.DOM.removeStyle('CompactLayout');
    this._started = false;
  }

  _listen(target, type, listener, options) {
    target.addEventListener(type, listener, options);
    this._listeners.push([target, type, listener, options]);
  }

  _region(name) {
    return HavenApi.DOM.query(`[data-haven-region="${CompactLayout.REGIONS[name]}"]`);
  }

  _toggle() {
    this._engaged ? this._disengage() : this._engage();
  }

  _engage(persist = true) {
    if (this._engaged) return;
    if (typeof window.setHavenOriginalLayout === 'function'
        && document.documentElement.hasAttribute('data-haven-original-layout')) {
      window.setHavenOriginalLayout(false);
    }
    this._engaged = true;
    document.documentElement.setAttribute('data-compact-layout', '1');
    try {
      this._syncDesktop();
      if (persist) HavenApi.Data.save('CompactLayout', 'layoutOn', '1');
      this._renderControl();
      document.dispatchEvent(new CustomEvent('haven:compact-layout', { detail: { on: true } }));
    } catch (error) {
      this._engaged = false;
      try { this._restoreDesktop(); }
      finally {
        document.documentElement.removeAttribute('data-compact-layout');
      }
      throw error;
    }
  }

  _disengage(persist = true) {
    if (!this._engaged) return;
    this._engaged = false;
    this._restoreDesktop();
    document.documentElement.removeAttribute('data-compact-layout');
    if (persist) HavenApi.Data.save('CompactLayout', 'layoutOn', '0');
    this._renderControl();
    document.dispatchEvent(new CustomEvent('haven:compact-layout', { detail: { on: false } }));
  }

  _renderControl() {
    if (!this._control) return;
    this._control.setAttribute('aria-pressed', this._engaged ? 'true' : 'false');
    const blocked = this._engaged && this._blocked;
    this._control.title = blocked
      ? 'Compact layout is waiting for another layout plugin'
      : 'Compact layout (Ctrl+Alt+C)';
    this._control.setAttribute(
      'aria-label',
      blocked
        ? 'Compact layout waiting for another layout plugin'
        : (this._engaged ? 'Switch to classic layout' : 'Switch to compact layout')
    );
  }

  _syncDesktop() {
    const editing = document.documentElement.hasAttribute('data-haven-layout-editing');
    if (this._engaged && !this._suspended && !editing && this._media?.matches) this._applyDesktop();
    else this._restoreDesktop();
  }

  _applyDesktop() {
    if (this._placements.length) return;
    const serverRail = this._region('serverRail');
    const navigation = this._region('navigation');
    const account = this._region('account');
    const footer = this._region('footer');
    const sidebarActions = this._region('sidebarActions');
    const voiceSettings = this._region('voiceSettings');
    const voiceControls = this._region('voiceControls');
    if (!serverRail || !navigation || !account || !footer || !sidebarActions
        || !voiceSettings || !voiceControls) {
      console.warn('[CompactLayout] Required public layout regions are unavailable');
      return;
    }
    if (HavenApi.Layout && !HavenApi.Layout.acquire('CompactLayout')) {
      this._blocked = true;
      return;
    }

    this._blocked = false;
    this._move(serverRail, navigation, navigation.firstChild);
    this._move(account, footer, sidebarActions);
    this._move(voiceSettings, footer, account);
    this._move(voiceControls, footer, account);
    this._dockVoiceControls(voiceControls);
    document.documentElement.setAttribute('data-compact-layout-desktop', '1');
  }

  _move(element, parent, before) {
    this._placements.push([element, element.parentNode, element.nextSibling]);
    parent.insertBefore(element, before || null);
  }

  _dockVoiceControls(element) {
    const overrides = {
      position: 'static',
      top: 'auto',
      right: 'auto',
      bottom: 'auto',
      left: 'auto',
      width: 'auto',
      'max-width': 'none',
      transform: 'none',
      'z-index': 'auto',
      border: '0',
      'border-radius': '0',
      'box-shadow': 'none',
      overflow: 'auto hidden',
      resize: 'none'
    };
    for (const [property, value] of Object.entries(overrides)) {
      this._inlineRestores.push([
        element,
        property,
        element.style.getPropertyValue(property),
        element.style.getPropertyPriority(property)
      ]);
      element.style.setProperty(property, value, 'important');
    }
  }

  _restoreDesktop() {
    document.documentElement.removeAttribute('data-compact-layout-desktop');
    for (let index = this._inlineRestores.length - 1; index >= 0; index--) {
      const [element, property, value, priority] = this._inlineRestores[index];
      if (value) element.style.setProperty(property, value, priority);
      else element.style.removeProperty(property);
    }
    this._inlineRestores = [];
    for (let index = this._placements.length - 1; index >= 0; index--) {
      const [element, parent, next] = this._placements[index];
      parent.insertBefore(element, next?.parentNode === parent ? next : null);
    }
    this._placements = [];
    HavenApi.Layout?.release('CompactLayout');
    this._blocked = Boolean(
      this._engaged && HavenApi.Layout?.owner && HavenApi.Layout.owner !== 'CompactLayout'
    );
  }
}

CompactLayout.REGIONS = Object.freeze({
  serverRail: 'server-rail',
  navigation: 'navigation-sidebar',
  account: 'account',
  footer: 'sidebar-footer',
  sidebarActions: 'sidebar-actions',
  voiceSettings: 'voice-settings',
  voiceControls: 'voice-controls'
});

CompactLayout.CSS = `
html[data-compact-layout-desktop="1"] :where([data-haven-region="server-rail"]) {
  order: -1 !important;
  width: 100%;
  min-width: 0;
  height: 3.25rem;
  min-height: 3.25rem;
  box-sizing: border-box;
  flex-direction: row;
  align-items: center;
  padding: 0.375rem 0.5rem;
  border-inline: 0 !important;
  border-block-end: 1px solid var(--border);
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: thin;
}

html[data-compact-layout-desktop="1"] :where([data-haven-region="server-rail"]) > * {
  flex: 0 0 auto;
}

html[data-compact-layout-desktop="1"] :where([data-haven-region="server-list"]) {
  display: flex;
  flex: 1 1 auto;
  min-width: 0;
  align-items: center;
  gap: 0.25rem;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: thin;
}

html[data-compact-layout-desktop="1"] :where([data-haven-region="sidebar-footer"]) {
  background: var(--bg-tertiary);
}

html[data-compact-layout-desktop="1"] :where([data-haven-region="account"]) {
  margin: 0.375rem 0.5rem;
  border: 1px solid var(--border);
}

html[data-compact-layout-desktop="1"] :where([data-haven-region="voice-settings"]) {
  max-height: 45vh;
  overflow-y: auto;
}

html[data-compact-layout-desktop="1"] :where([data-haven-region="voice-controls"]) {
  justify-content: flex-start;
  overflow-x: auto;
  padding: 0.375rem 0.5rem;
}
`;

if (typeof module !== 'undefined') module.exports = CompactLayout;
if (typeof _win !== 'undefined') _win.CompactLayout = CompactLayout;
