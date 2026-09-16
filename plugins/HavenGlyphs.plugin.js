/**
 * @name Haven Glyphs
 * @description Replaces selected interface affordance emojis with local Font Awesome Solid glyphs. User content, reactions, pickers, activities, sound names, and form fields are preserved.
 * @author bernardokcosta
 * @version 1.0.0
 */
class HavenGlyphs {
  start() {
    if (this._started) return;
    this._started = true;
    this._listeners = [];
    this._iconSwapped = [];
    this._iconParents = [];
    this._iconBusy = false;

    try {
      HavenApi.DOM.addStyle('HavenGlyphs', HavenGlyphs.CSS);
      this._sweepIcons(document.body);
      this._iconObs = new MutationObserver((mutations) => {
        if (this._iconBusy) return;
        this._iconBusy = true;
        try {
          for (const mutation of mutations) {
            if (mutation.type === 'characterData') {
              this._swapIconNode(mutation.target);
            } else {
              for (const node of mutation.addedNodes) {
                if (node.nodeType === 3) this._swapIconNode(node);
                else if (node.nodeType === 1) this._sweepIcons(node);
              }
            }
          }
        } finally {
          this._iconBusy = false;
        }
      });
      this._iconObs.observe(document.body, { childList: true, characterData: true, subtree: true });
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  stop() {
    if (!this._started) return;
    try { this._iconObs?.disconnect(); } catch {}
    this._iconObs = null;
    for (const [icon, emoji] of this._iconSwapped) {
      try {
        if (icon.isConnected) icon.replaceWith(document.createTextNode(emoji));
      } catch {}
    }
    this._iconSwapped = [];
    for (const parent of this._iconParents) {
      try { if (parent.isConnected) parent.normalize(); } catch {}
    }
    this._iconParents = [];
    HavenApi.DOM.removeStyle('HavenGlyphs');
    this._started = false;
  }

  _iconHost(element) {
    if (!element) return null;
    const direct = element.closest(HavenGlyphs.ICON_HOST_SELECTOR);
    if (direct) return direct;

    // Some static labels put the icon in a span immediately before a
    // translated child, such as "🔒 <span data-i18n>Private</span>". Do not
    // climb farther: a broad ancestor may contain unrelated or user content.
    if (element.tagName === 'SPAN' && [...element.children].some(child =>
      child.hasAttribute('data-i18n') || child.hasAttribute('data-i18n-html'))) {
      return element;
    }
    return null;
  }

  _iconExcluded(element, host) {
    if (host?.matches?.(HavenGlyphs.ICON_EXPLICIT_SELECTOR)) return false;
    return !!element.closest(HavenGlyphs.ICON_EXCLUSION_SELECTOR);
  }

  _iconSpec(emoji, host) {
    // Deafen buttons draw their own red slash while active. Keep the base
    // speaker there so the control does not show a slashed microphone twice.
    if (emoji === '🔇' && host?.matches?.('#voice-deafen-btn, #voice-deafen-btn-header')) {
      return ['fa-volume-high'];
    }
    return HavenGlyphs.ICON_MAP[emoji];
  }

  _sweepIcons(root) {
    if (root.nodeType === 3) {
      this._swapIconNode(root);
      return;
    }
    if (root.nodeType !== 1 || root.classList?.contains('haven-glyph')) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let current;
    while ((current = walker.nextNode())) nodes.push(current);
    for (const node of nodes) this._swapIconNode(node);
  }

  _swapIconNode(node) {
    if (!node || node.nodeType !== 3 || !node.data) return;
    const parent = node.parentElement;
    const host = this._iconHost(parent);
    if (!parent || !host || this._iconExcluded(parent, host)) return;

    const explicit = host.matches?.(HavenGlyphs.ICON_EXPLICIT_SELECTOR) === true;
    let data = node.data;
    const fragment = document.createDocumentFragment();
    let found = false;
    while (true) {
      let index = -1;
      let hit = null;
      for (const key of HavenGlyphs.ICON_KEYS) {
        const at = data.indexOf(key);
        const isLeading = at !== -1 && /^\s*$/.test(data.slice(0, at));
        if (at !== -1 && (explicit || isLeading) && (index === -1 || at < index)) {
          index = at;
          hit = key;
        }
      }
      if (hit === null) break;
      found = true;
      if (index > 0) fragment.appendChild(document.createTextNode(data.slice(0, index)));
      const icon = document.createElement('i');
      const [name, extra] = this._iconSpec(hit, host);
      icon.className = 'haven-glyph ' + name + (extra ? ' ' + extra : '');
      icon.setAttribute('aria-hidden', 'true');
      fragment.appendChild(icon);
      this._iconSwapped.push([icon, hit]);
      data = data.slice(index + hit.length);
    }
    if (!found) return;
    if (data) fragment.appendChild(document.createTextNode(data));
    node.replaceWith(fragment);
    if (parent.isConnected) {
      parent.normalize();
      this._iconParents.push(parent);
    }
  }
}

HavenGlyphs.ICON_EXPLICIT_SELECTOR = [
  '[data-haven-icon]',
  '.channel-hash', '.channel-collapse-arrow', '.channel-indicators',
  '.ch-disabled-badge', '.sub-panel-toggle-label', '.title-emoji',
  '.voice-settings-section-label', '.voice-settings-label',
  '.voice-indicator-icon', '.voice-stream-badge', '.voice-status-icon',
  '.voice-user-menu-label', '.voice-user-menu-action',
  '.user-action-btn', '.profile-popup-action-btn',
  '.pinned-tag', '.archived-tag', '.e2e-tag', '.ferry-badge',
  '.forum-tag-nsfw', '.forum-tag-protected', '.forum-tag-pinned',
  '.forum-topic-replies', '.forum-view-btn', '.forum-lock-layout',
  '.forum-new-post', '.forum-topic-edit', '.thread-panel-icon',
  '.tb-icon-emoji', '.thread-preview-arrow', '.profile-activity-verb',
  '.connection-help', '.media-grid-jump', '.media-list-jump',
  '.voice-icon', '.cvu-mic', '.cvu-deafen', '.rgb-slider-label',
  '.hidden-channels-bar > span:first-child', '.temp-channel-create-btn > span:first-child',
  '.import-server-icon-placeholder', '.audit-icon',
  '.pins-pip-icon', '.media-grid-play', '.media-list-icon',
  '.file-icon', '.file-download-arrow', '.manage-server-visit',
  '.manage-server-edit', '.manage-server-delete', '.status-bar-toggle-tab',
  '.status-url-toggle', '.sb-sidebar-header', '.sb-toggle-mark',
  '.sb-toggle-arrow', '.upload-icon-clippy', '.btn-burn',
  '.desktop-app-icon', '.android-beta-icon', '.burn-pending-label',
  '.burn-reveal-btn', '.burn-countdown-pill', '.burn-complete-label',
  '.risky-download-icon', '.transfer-admin-warning-icon', '.dm-safety-icon',
  '.rac-channel-icon', '.rac-card-locked', '.badge-scope', '.aml-member-storage',
  '.settings-nav-item', '.settings-group-label',
  '#section-score-badges > .settings-hint', '#totp-manage-area > .settings-hint:first-child',
  '.role-tpl-emoji', '.connection-icon', '.stream-size-label',
  '[data-i18n-title="modals.game_overlay.volume_label"]',
  '#manage-servers-btn .server-icon-text', '#sync-servers-btn .server-icon-text',
  '#webcam-label', '#screen-share-label',
  '.voice-bar-icon', '.music-pip-label-icon', '.music-pip-vol-icon',
  '.stream-audio-badge', '.stream-no-audio-badge', '.viewer-eye',
  '.music-search-picker-thumb', '.organize-tag-icon', '.thread-mention-badge',
  '.import-channel-type-icon', '.connectivity-test-icon',
  '.webhook-avatar-icon', '.webhook-status-icon',
  '.wizard-check', '.file-type-icon'
].join(',');

HavenGlyphs.ICON_HOST_SELECTOR = [
  HavenGlyphs.ICON_EXPLICIT_SELECTOR,
  '[data-i18n]',
  'button:not(.theme-btn):not(.effect-btn):not(.gif-tab):not(.soundboard-btn):not(.role-tpl-card):not(.forum-tag-chip):not(.activity-card):not(.connection-card)',
  '[role="button"]:not(.theme-btn):not(.effect-btn):not(.gif-tab):not(.soundboard-btn):not(.role-tpl-card):not(.forum-tag-chip)',
  'label[data-haven-icon], summary[data-haven-icon]',
  'h1, h2, h3, h4, h5, [role="heading"]'
].join(',');

HavenGlyphs.ICON_EXCLUSION_SELECTOR = [
  'input, textarea, select, option, optgroup, code, pre, kbd, samp, script, style',
  '[contenteditable], .haven-glyph',
  '[data-haven-region="composer"], [data-haven-region="thread-panel"]',
  '[data-haven-region="soundboard"], [data-haven-region="pinned-messages"]',
  '[data-haven-region="search-results"]',
  '#emoji-picker, .emoji-picker, #gif-picker, #format-picker, #emoji-modal, #sticker-modal',
  '.message-content, .message-author, .message-username, .message-reactions',
  '.pinned-item-content, .search-result, .search-result-content',
  '.poll-widget, .poll-options, .role-menu-widget, .role-tpl-card',
  '.reaction, .reaction-chip, .reaction-badge, .emoji-only-msg',
  '.soundboard-btn, .soundboard-name, .sb-name, .forum-tag-chip',
  '.theme-icon, .activity-card, .activity-item, .connection-card, .provider-card',
  '.channel-name, .sub-panel-tile-name, .profile-status-text, .profile-bio',
  '.profile-popup-nickname, .user-status-text, .server-icon-text',
  '.server-name, .server-label, .user-name, .username, .display-name',
  '.activity-name, .activity-title, .connection-name, .connection-label',
  '.role-name, .role-label, .tag-name, .topic-title, .thread-topic-title',
  '.thread-msg-content, .thread-msg-author, .thread-list-author, .thread-list-preview',
  '.reply-preview',
  '.forum-topic-title, .forum-topic-meta, .file-name, .file-info, .role-preview-item',
  '.mobile-server-item, .server-item, .server-button',
  '[data-user-content]'
].join(',');

HavenGlyphs.ICON_MAP = Object.freeze({
  '\u2699\ufe0f': ['fa-gear'], '\u2699': ['fa-gear'],
  '\ud83d\udd0d': ['fa-magnifying-glass'], '\ud83d\udd0e': ['fa-magnifying-glass'],
  '\ud83d\udccc': ['fa-thumbtack'], '\ud83e\uddf5': ['fa-comments'],
  '\ud83d\uddbc\ufe0f': ['fa-image'], '\ud83d\uddbc': ['fa-image'],
  '\ud83d\udcf7': ['fa-camera'], '\ud83d\udcf9': ['fa-video'],
  '\ud83c\udfa4': ['fa-microphone'], '\ud83c\udf99\ufe0f': ['fa-microphone'],
  '\ud83d\udd07': ['fa-volume-xmark'], '\ud83d\udd0a': ['fa-volume-high'],
  '\ud83d\udd14': ['fa-bell'], '\ud83d\udd15': ['fa-bell-slash'],
  '\ud83d\udccb': ['fa-clipboard'], '\ud83d\udd10': ['fa-lock'],
  '\ud83d\udd11': ['fa-key'], '\ud83d\udd12': ['fa-lock'], '\ud83d\udd13': ['fa-unlock'],
  '\ud83d\udd04': ['fa-arrows-rotate'], '\u27f3': ['fa-arrows-rotate'],
  '\u21ba': ['fa-arrow-rotate-left'], '\u21b6': ['fa-arrow-rotate-left'],
  '\u23ed': ['fa-forward-step'], '\u23ed\ufe0f': ['fa-forward-step'],
  '\u23f8': ['fa-pause'], '\u23f8\ufe0f': ['fa-pause'],
  '\u25b6': ['fa-play'], '\u25b6\ufe0f': ['fa-play'],
  '\u26a0': ['fa-triangle-exclamation'], '\u26a0\ufe0f': ['fa-triangle-exclamation'],
  '\u2705': ['fa-circle-check'], '\u2713': ['fa-check'], '\u2714': ['fa-check'],
  '\u274c': ['fa-circle-xmark'], '\u2715': ['fa-xmark'], '\u00d7': ['fa-xmark'],
  '\ud83d\udd1e': ['fa-ban'], '\ud83d\udd34': ['fa-circle'], '\ud83d\udfe2': ['fa-circle'],
  '\ud83d\ude48': ['fa-eye-slash'], '\ud83d\udd12': ['fa-lock'],
  '\u23f1\ufe0f': ['fa-stopwatch'], '\u23f3': ['fa-hourglass-half', 'fa-spin'],
  '\ud83d\udc65': ['fa-users'], '\ud83d\udc64': ['fa-user'], '\ud83d\udc51': ['fa-crown'],
  '\ud83e\udd16': ['fa-robot'], '\ud83d\udce1': ['fa-satellite-dish'],
  '\ud83d\udee1\ufe0f': ['fa-shield-halved'], '\ud83d\udde1\ufe0f': ['fa-shield'],
  '\ud83d\udda5': ['fa-desktop'], '\ud83d\udda5\ufe0f': ['fa-desktop'],
  '\ud83d\udcbb': ['fa-laptop'], '\ud83d\udcf1': ['fa-mobile-screen'],
  '\ud83d\udcca': ['fa-chart-column'], '\ud83d\udc41': ['fa-eye'],
  '\ud83d\udc41\ufe0f': ['fa-eye'],
  '\ud83d\udc41\ufe0f\u200d\ud83d\udde8\ufe0f': ['fa-eye'],
  '\ud83d\udc41\u200d\ud83d\udde8': ['fa-eye'],
  '\ud83d\udcc1': ['fa-folder'], '\ud83d\udcc2': ['fa-folder-open'],
  '\ud83d\uddc2': ['fa-folder-open'], '\ud83d\uddc2\ufe0f': ['fa-folder-open'],
  '\ud83d\udce6': ['fa-box'], '\ud83d\udcc4': ['fa-file-lines'],
  '\ud83d\udcdc': ['fa-scroll'], '\ud83d\udcd0': ['fa-ruler'],
  '\ud83d\udcdd': ['fa-note-sticky'], '\ud83d\udcbe': ['fa-floppy-disk'],
  '\ud83d\udce5': ['fa-download'], '\ud83d\uddd1': ['fa-trash-can'],
  '\ud83d\uddd1\ufe0f': ['fa-trash-can'], '\ud83d\udd27': ['fa-wrench'],
  '\ud83e\uddf0': ['fa-toolbox'], '\ud83e\uddf9': ['fa-broom'],
  '\ud83e\udded': ['fa-compass'], '\ud83e\ude7a': ['fa-droplet'],
  '\ud83c\udfb5': ['fa-music'], '\u266a': ['fa-music'], '\ud83c\udfb6': ['fa-headphones'],
  '\ud83c\udfa7': ['fa-headphones'], '\ud83c\udf9a\ufe0f': ['fa-sliders'],
  '\ud83c\udf9b\ufe0f': ['fa-icons'], '\ud83c\udf9e\ufe0f': ['fa-film'],
  '\ud83c\udfac': ['fa-clapperboard'], '\ud83d\udca1': ['fa-lightbulb'],
  '\ud83d\udcac': ['fa-comment'], '\ud83d\udce3': ['fa-bullhorn'],
  '\ud83d\udce2': ['fa-bullhorn'], '\ud83c\udfe0': ['fa-house'],
  '\ud83c\udf10': ['fa-globe'], '\ud83d\ude80': ['fa-rocket'],
  '\ud83d\udea2': ['fa-ship'], '\ud83d\udef6': ['fa-arrow-right-arrow-left'],
  '\u2b06': ['fa-arrow-up'], '\u2b06\ufe0f': ['fa-arrow-up'],
  '\u2b07': ['fa-arrow-down'], '\u2b07\ufe0f': ['fa-arrow-down'],
  '\ud83c\udff7\ufe0f': ['fa-tag'], '\u2795': ['fa-plus'], '\u2796': ['fa-minus'],
  '\ud83d\udeaa': ['fa-arrow-right-from-bracket'], '\ud83d\udce4': ['fa-paper-plane'],
  '\ud83d\udce8': ['fa-envelope'], '\ud83d\udc4b': ['fa-hand'],
  '\ud83d\udc22': ['fa-clock'], '\ud83d\udca4': ['fa-bed'], '\u2615': ['fa-mug-saucer'],
  '\ud83d\udc9b': ['fa-heart'], '\u2764\ufe0f': ['fa-heart'], '\ud83d\udcf0': ['fa-newspaper'],
  '\ud83d\uddb1\ufe0f': ['fa-computer-mouse'], '\ud83d\udd17': ['fa-link'],
  '\u2696\ufe0f': ['fa-scale-balanced'], '\ud83d\udde3\ufe0f': ['fa-language'],
  '\ud83d\udd24': ['fa-text-height'], '\u2328\ufe0f': ['fa-keyboard'],
  '\ud83d\udc1e': ['fa-bug'], '\ud83e\udde9': ['fa-puzzle-piece'],
  '\ud83e\udd2b': ['fa-ear-deaf'], '\ud83d\ude0e': ['fa-face-smile'],
  '\ud83d\ude00': ['fa-face-smile'], '\ud83c\udfae': ['fa-gamepad'], '\u26a1': ['fa-bolt'],
  '\u2744': ['fa-snowflake'], '\ud83d\udd25': ['fa-fire'], '\ud83d\udc8d': ['fa-ring'],
  '\ud83e\uddca': ['fa-icicles'], '\ud83c\udf0a': ['fa-water'],
  '\ud83c\udf89': ['fa-champagne-glasses'], '\ud83c\udf0e': ['fa-globe'],
  '\ud83e\udd1d': ['fa-handshake'], '\ud83d\udcf8': ['fa-camera'],
  '\ud83d\udcf2': ['fa-mobile-screen'], '\ud83d\udccf': ['fa-ruler'],
  '\u25aa\ufe0f': ['fa-square'], '\u25aa': ['fa-square'], '\u25fe': ['fa-square'], '\u2b1b': ['fa-square'],
  '\u2709\ufe0f': ['fa-envelope'], '\u2709': ['fa-envelope'], '\u2728': ['fa-wand-magic-sparkles'],
  '\u2611\ufe0f': ['fa-circle-check'], '\u2611': ['fa-circle-check'],
  '\ud83d\udddd\ufe0f': ['fa-key'], '\ud83d\udddd': ['fa-key'],
  '\ud83c\udf9f\ufe0f': ['fa-ticket'], '\ud83c\udf9f': ['fa-ticket'],
  '\u23f0': ['fa-clock'], '\ud83d\udcc5': ['fa-calendar-days'], '\ud83d\udd50': ['fa-clock'],
  '\u2139\ufe0f': ['fa-circle-info'], '\u2139': ['fa-circle-info'],
  '\ud83e\ude78': ['fa-droplet'], '\ud83d\udc0d': ['fa-code'],
  '\u2694\ufe0f': ['fa-khanda'], '\u2622\ufe0f': ['fa-radiation'],
  '\u271d\ufe0f': ['fa-cross'], '\u26ea': ['fa-church'], '\ud83d\udd4a\ufe0f': ['fa-dove'],
  '\ud83d\udcfa': ['fa-tv'], '\ud83c\udfa8': ['fa-palette'], '\ud83c\udf08': ['fa-rainbow'],
  '\u2600\ufe0f': ['fa-sun'], '\u2601\ufe0f': ['fa-cloud'], '\ud83d\udeab': ['fa-ban'],
  '\u26d4': ['fa-ban'], '\u26cf\ufe0f': ['fa-cube'], '\ud83d\udd2e': ['fa-wand-magic-sparkles'],
  '\ud83e\ude9f': ['fa-window-maximize'], '\u25c8': ['fa-gem'], '\u2301': ['fa-circle-nodes'],
  '\ud83e\udddb': ['fa-moon'], '\u269c': ['fa-scroll'], '\u2630': ['fa-bars'],
  '\u25a4': ['fa-bars'], '\u29c9': ['fa-up-right-and-down-left-from-center'],
  '\u29c8': ['fa-down-left-and-up-right-to-center'], '\u26f6': ['fa-expand'],
  '\u2922': ['fa-expand'], '\u2921': ['fa-compress'], '\u25a3': ['fa-crop'],
  '\u2725': ['fa-up-down-left-right'], '\u25d0': ['fa-circle-half-stroke'],
  '\u25c7': ['fa-diamond'], '\u229e': ['fa-table-cells-large'], '\u229f': ['fa-table-cells'],
  '\u25eb': ['fa-table-columns'], '\u25ac': ['fa-grip-lines-vertical'],
  '\u22ef': ['fa-ellipsis'], '\u22ee': ['fa-grip-vertical'], '\u283f': ['fa-grip-vertical'],
  '\u25be': ['fa-caret-down'], '\u25b8': ['fa-caret-right'], '\u21a9\ufe0f': ['fa-reply'],
  '\u2197': ['fa-arrow-turn-up'], '\u2197\ufe0f': ['fa-up-right-from-square'],
  '\u270f\ufe0f': ['fa-pen'], '\u270e': ['fa-pen'], '\u2718': ['fa-pen'],
  '\u2702\ufe0f': ['fa-scissors'], '\ud83d\udcce': ['fa-paperclip'], '\u2b50': ['fa-star'],
  '\ud83d\uded1': ['fa-stop'], '\ud83d\udcf4': ['fa-phone-slash'], '\ud83d\udd01': ['fa-repeat'],
  '\ud83c\udfad': ['fa-masks-theater'], '\ud83d\udc62': ['fa-shoe-prints'],
  '\ud83c\udfc6': ['fa-trophy'], '\u2708\ufe0f': ['fa-plane'], '\ud83d\udc36': ['fa-paw'],
  '\ud83c\udf55': ['fa-pizza-slice'], '\ud83d\udea9': ['fa-flag'], '\u270b': ['fa-hand'],
  '\ud83c\udfde\ufe0f': ['fa-panorama'], '\ud83d\udd75\ufe0f': ['fa-user-secret'],
  '\ud83d\udcbf': ['fa-compact-disc'], '\u276e': ['fa-chevron-left'], '\u276f': ['fa-chevron-right'],
  '\u2039': ['fa-chevron-left'], '\u203a': ['fa-chevron-right'], '\ud83d\udfe2': ['fa-circle']
});

HavenGlyphs.ICON_KEYS = Object.keys(HavenGlyphs.ICON_MAP).sort((a, b) => b.length - a.length);

HavenGlyphs.ICON_CODEPOINTS = Object.freeze({
  'fa-arrow-down': 'f063', 'fa-arrow-right-arrow-left': 'f0ec',
  'fa-arrow-right-from-bracket': 'f08b', 'fa-arrow-rotate-left': 'f0e2',
  'fa-arrow-turn-up': 'f148', 'fa-arrow-up': 'f062', 'fa-arrows-rotate': 'f021',
  'fa-ban': 'f05e', 'fa-bars': 'f0c9', 'fa-bed': 'f236', 'fa-bell': 'f0f3',
  'fa-bell-slash': 'f1f6', 'fa-bolt': 'f0e7', 'fa-box': 'f466', 'fa-broom': 'f51a',
  'fa-bug': 'f188', 'fa-bullhorn': 'f0a1', 'fa-camera': 'f030', 'fa-calendar-days': 'f133',
  'fa-caret-down': 'f0d7',
  'fa-caret-right': 'f0da', 'fa-champagne-glasses': 'f79f', 'fa-chart-column': 'e0e3',
  'fa-check': 'f00c', 'fa-church': 'f51d', 'fa-circle': 'f111', 'fa-circle-check': 'f058',
  'fa-circle-half-stroke': 'f042', 'fa-circle-nodes': 'e4e2', 'fa-circle-xmark': 'f057',
  'fa-circle-info': 'f05a', 'fa-clapperboard': 'e131', 'fa-clipboard': 'f328', 'fa-clock': 'f017',
  'fa-code': 'f121', 'fa-cloud': 'f0c2',
  'fa-comment': 'f075', 'fa-comments': 'f086', 'fa-compact-disc': 'f51f', 'fa-compass': 'f14e',
  'fa-compress': 'f066', 'fa-computer-mouse': 'f8cc', 'fa-crop': 'f125', 'fa-cross': 'f654',
  'fa-crown': 'f521', 'fa-cube': 'f1b2', 'fa-desktop': 'f390', 'fa-diamond': 'f219',
  'fa-dove': 'f4ba', 'fa-down-left-and-up-right-to-center': 'f422', 'fa-download': 'f019',
  'fa-droplet': 'f043', 'fa-ear-deaf': 'f2a4', 'fa-ellipsis': 'f141', 'fa-envelope': 'f0e0',
  'fa-expand': 'f065', 'fa-eye': 'f06e', 'fa-eye-slash': 'f070', 'fa-face-smile': 'f118',
  'fa-file-lines': 'f15c', 'fa-film': 'f008', 'fa-fire': 'f06d', 'fa-flag': 'f024',
  'fa-floppy-disk': 'f0c7', 'fa-folder': 'f07b', 'fa-folder-open': 'f07c',
  'fa-forward-step': 'f051', 'fa-gamepad': 'f11b', 'fa-gear': 'f013', 'fa-gem': 'f3a5',
  'fa-globe': 'f0ac', 'fa-grip-lines-vertical': 'f7a5', 'fa-grip-vertical': 'f58e',
  'fa-hand': 'f256', 'fa-handshake': 'f2b5', 'fa-headphones': 'f025', 'fa-heart': 'f004',
  'fa-hourglass-half': 'f252',
  'fa-house': 'f015', 'fa-icicles': 'f7ad', 'fa-icons': 'f86d', 'fa-image': 'f03e',
  'fa-key': 'f084', 'fa-keyboard': 'f11c', 'fa-khanda': 'f66d', 'fa-language': 'f1ab',
  'fa-laptop': 'f109', 'fa-lightbulb': 'f0eb', 'fa-link': 'f0c1', 'fa-lock': 'f023',
  'fa-magnifying-glass': 'f002', 'fa-masks-theater': 'f630', 'fa-microphone': 'f130',
  'fa-microphone-slash': 'f131', 'fa-minus': 'f068', 'fa-mobile-screen': 'f3cf', 'fa-moon': 'f186',
  'fa-mug-saucer': 'f0f4', 'fa-music': 'f001', 'fa-newspaper': 'f1ea', 'fa-note-sticky': 'f249',
  'fa-palette': 'f53f', 'fa-panorama': 'e209', 'fa-paper-plane': 'f1d8', 'fa-paperclip': 'f0c6',
  'fa-pause': 'f04c', 'fa-paw': 'f1b0', 'fa-pen': 'f304', 'fa-phone-slash': 'f3dd',
  'fa-pizza-slice': 'f818', 'fa-plane': 'f072', 'fa-play': 'f04b', 'fa-plus': '2b',
  'fa-puzzle-piece': 'f12e', 'fa-radiation': 'f7b9', 'fa-rainbow': 'f75b', 'fa-repeat': 'f363',
  'fa-reply': 'f3e5', 'fa-ring': 'f70b', 'fa-robot': 'f544', 'fa-rocket': 'f135', 'fa-ruler': 'f545',
  'fa-satellite-dish': 'f7c0', 'fa-scale-balanced': 'f24e', 'fa-scissors': 'f0c4',
  'fa-scroll': 'f70e', 'fa-shield': 'f132', 'fa-shield-halved': 'f3ed', 'fa-ship': 'f21a',
  'fa-shoe-prints': 'f54b', 'fa-sliders': 'f1de', 'fa-snowflake': 'f2dc', 'fa-square': 'f0c8',
  'fa-star': 'f005',
  'fa-stop': 'f04d', 'fa-stopwatch': 'f2f2', 'fa-sun': 'f185', 'fa-table-cells': 'f00a',
  'fa-table-cells-large': 'f009', 'fa-table-columns': 'f0db', 'fa-tag': 'f02b',
  'fa-text-height': 'f034', 'fa-thumbtack': 'f08d', 'fa-ticket': 'f145', 'fa-toolbox': 'f552',
  'fa-trash-can': 'f2ed',
  'fa-triangle-exclamation': 'f071', 'fa-trophy': 'f091', 'fa-tv': 'f26c',
  'fa-up-down-left-right': 'f0b2', 'fa-up-right-and-down-left-from-center': 'f424',
  'fa-up-right-from-square': 'f35d', 'fa-unlock': 'f09c', 'fa-user': 'f007',
  'fa-user-secret': 'f21b', 'fa-users': 'f0c0', 'fa-video': 'f03d', 'fa-volume-high': 'f028',
  'fa-volume-xmark': 'f6a9',
  'fa-wand-magic-sparkles': 'e2ca', 'fa-water': 'f773', 'fa-window-maximize': 'f2d0',
  'fa-wrench': 'f0ad', 'fa-xmark': 'f00d', 'fa-chevron-left': 'f053', 'fa-chevron-right': 'f054'
});

HavenGlyphs.CSS = `@font-face {
  font-family: 'HavenGlyphs';
  font-style: normal;
  font-weight: 900;
  font-display: swap;
  src: url('/fonts/fa-solid-900.woff2') format('woff2');
}
.haven-glyph {
  font-family: 'HavenGlyphs';
  font-weight: 900;
  font-style: normal;
  font-variant: normal;
  line-height: 1;
  text-indent: 0;
  text-rendering: auto;
  display: inline-block;
  -moz-osx-font-smoothing: grayscale;
  -webkit-font-smoothing: antialiased;
}
.user-action-btn > .haven-glyph { color: var(--text-secondary); }
.user-action-btn:hover > .haven-glyph { color: var(--text-primary); }
.haven-glyph.fa-spin { animation: haven-glyph-spin 2s linear infinite; }
@keyframes haven-glyph-spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
` + Object.entries(HavenGlyphs.ICON_CODEPOINTS)
  .map(([name, codepoint]) => `.haven-glyph.${name}::before { content: "\\${codepoint}"; }`)
  .join('\n');

if (typeof module !== 'undefined') module.exports = HavenGlyphs;
if (typeof _win !== 'undefined') _win.HavenGlyphs = HavenGlyphs;
