/**
 * @name AutoMod Quarantine (Experimental)
 * @description Experimental. Holds links until they are checked. Only the link is sent to the AI, never the message. Quarantines links, scans them via AI (this Haven server's local model, Gemini, Claude, Grok, Codex/OpenAI, OpenCode, Ollama, AGY, Meta Muse Spark, OpenRouter, Mistral, DeepSeek, Custom) or a Bearer token, and source trust, releases safe links, blocks threats, and issues moderation warnings.
 * @author Amnibro
 * @version 1.4.0
 */

'use strict';

class AutoModQuarantine {
  static get PROVIDERS() {
    return {
      gemini: {
        id: 'gemini',
        name: 'Google Gemini',
        defaultEndpoint: 'https://generativelanguage.googleapis.com/v1beta/models',
        defaultModel: 'gemini-3.8-flash',
        type: 'gemini',
        needsKey: true,
        placeholder: 'AIzaSy...',
        ssoPlaceholder: 'gcloud auth print-access-token (ya29…)'
      },
      claude: {
        id: 'claude',
        name: 'Anthropic Claude',
        defaultEndpoint: 'https://api.anthropic.com/v1/messages',
        defaultModel: 'claude-sonnet-5-5',
        type: 'anthropic',
        needsKey: true,
        placeholder: 'sk-ant-api03...'
      },
      openai: {
        id: 'openai',
        name: 'OpenAI / Codex',
        defaultEndpoint: 'https://api.openai.com/v1/chat/completions',
        defaultModel: 'gpt-6-luna',
        type: 'openai',
        needsKey: true,
        placeholder: 'sk-proj-...'
      },
      grok: {
        id: 'grok',
        name: 'xAI Grok',
        defaultEndpoint: 'https://api.x.ai/v1/chat/completions',
        defaultModel: 'grok-4.7',
        type: 'openai',
        needsKey: true,
        placeholder: 'xai-...'
      },
      opencode: {
        id: 'opencode',
        name: 'OpenCode',
        defaultEndpoint: 'https://opencode.ai/zen/v1/chat/completions',
        defaultModel: 'glm-5.3-flash',
        type: 'openai',
        needsKey: true,
        placeholder: 'OpenCode Zen key (sk-…)',
        ssoPlaceholder: 'OpenCode Go key (oc_sk_…), endpoint …/zen/go/v1/chat/completions'
      },
      haven: {
        id: 'haven',
        name: 'This Haven Server (Local AI)',
        defaultEndpoint: '/api/automod/scan',
        defaultModel: '',
        type: 'haven',
        needsKey: false,
        placeholder: 'Not needed: the Haven server runs the model'
      },
      ollama: {
        id: 'ollama',
        name: 'Ollama (Local / Open)',
        defaultEndpoint: 'http://localhost:11434/v1/chat/completions',
        defaultModel: 'granite4.2:8b',
        type: 'openai',
        needsKey: false,
        placeholder: 'Optional (leave blank for local)'
      },
      agy: {
        id: 'agy',
        name: 'AGY / Antigravity Gateway',
        defaultEndpoint: 'http://127.0.0.1:41701/v1/chat/completions',
        defaultModel: 'agy-default',
        type: 'openai',
        needsKey: false,
        placeholder: 'Optional Bearer / SSO token'
      },
      muse: {
        id: 'muse',
        name: 'Meta Muse Spark',
        defaultEndpoint: 'https://api.meta.ai/v1/chat/completions',
        defaultModel: 'muse-spark-1.3',
        type: 'openai',
        needsKey: true,
        placeholder: 'Meta Model API key'
      },
      openrouter: { id: 'openrouter', name: 'OpenRouter', defaultEndpoint: 'https://openrouter.ai/api/v1/chat/completions', defaultModel: 'openrouter/auto', type: 'openai', needsKey: true, placeholder: 'sk-or-v1-...' },
      mistral: { id: 'mistral', name: 'Mistral', defaultEndpoint: 'https://api.mistral.ai/v1/chat/completions', defaultModel: 'mistral-small-latest', type: 'openai', needsKey: true, placeholder: 'Mistral API key' },
      deepseek: { id: 'deepseek', name: 'DeepSeek', defaultEndpoint: 'https://api.deepseek.com/chat/completions', defaultModel: 'deepseek-chat', type: 'openai', needsKey: true, placeholder: 'sk-...' },
      custom: {
        id: 'custom',
        name: 'Custom / Other (vLLM, LocalAI, OpenRouter)',
        defaultEndpoint: 'http://localhost:8000/v1/chat/completions',
        defaultModel: 'default',
        type: 'openai',
        needsKey: false,
        placeholder: 'Bearer token or API key'
      }
    };
  }

  static get DEFAULT_SETTINGS() {
    return {
      enabled: true,
      autoReleaseSafe: true,
      // Off by default: a warning is posted in the moderator's name, so a
      // person should decide to send it.
      autoWarnUsers: false,
      maxStrikes: 3,
      aiScanEnabled: true,
      aiProvider: 'gemini',
      aiAuth: 'key',
      aiApiKey: '',
      aiEndpoint: '',
      aiModel: '',
      trustedDomains: [
        'github.com',
        'google.com',
        'wikipedia.org',
        'youtube.com',
        'youtu.be',
        'x.com',
        'twitter.com',
        'reddit.com',
        'gitlab.com',
        'stackoverflow.com',
        'mozilla.org',
        'w3.org',
        'npm.im',
        'npmjs.com',
        'steampowered.com',
        'steamcommunity.com',
        'discord.com',
        'spotify.com',
        'twitch.tv',
        'archive.org'
      ],
      blockedDomains: [
        'grabify.link',
        'iplogger.org',
        '2no.co',
        'yip.su',
        'iplis.ru'
      ],
      blockRawIps: true,
      blockPunycode: true,
      blockDangerousExtensions: true,
      dangerousExtensions: ['.exe', '.scr', '.bat', '.cmd', '.vbs', '.ps1', '.apk', '.msi', '.jar', '.com'],
      maxConcurrentScans: 4,
      autoBlacklistBadHosts: true,
      unloadModelAfterQueue: true,
      warningTemplate: '⚠️ @{user}: [AutoMod] The link you posted was quarantined and blocked for violating server rules: {reason}. (Warning {strikes}/{maxStrikes})',
      serverRules: 'No phishing, scamming, credential harvesting, malware downloads, token logging, hate speech, severe harassment, or unauthorized promotional spam.'
    };
  }

  static get CSS() {
    return `
      /* AutoMod Quarantine Plugin Styles */
      .haven-quarantine-capsule {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 2px 8px;
        margin: 2px 0;
        background: rgba(245, 158, 11, 0.12);
        border: 1px solid rgba(245, 158, 11, 0.35);
        border-radius: 6px;
        font-size: 0.85em;
        color: var(--text-primary, #e2e8f0);
        vertical-align: middle;
        user-select: none;
        transition: all 0.2s ease;
      }
      .haven-quarantine-capsule.scanning {
        border-color: rgba(59, 130, 246, 0.5);
        background: rgba(59, 130, 246, 0.12);
      }
      .hq-icon {
        font-size: 1.1em;
        line-height: 1;
      }
      .hq-pulse-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background-color: #3b82f6;
        animation: hq-pulse 1.4s infinite ease-in-out;
      }
      @keyframes hq-pulse {
        0% { transform: scale(0.8); opacity: 0.4; }
        50% { transform: scale(1.3); opacity: 1; }
        100% { transform: scale(0.8); opacity: 0.4; }
      }
      .hq-label {
        font-weight: 600;
        color: #f59e0b;
        font-size: 0.9em;
      }
      .haven-quarantine-capsule.scanning .hq-label {
        color: #60a5fa;
      }
      .hq-domain {
        color: var(--text-muted, #94a3b8);
        font-family: monospace;
        font-size: 0.85em;
        max-width: 180px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .hq-status-pill {
        font-size: 0.75em;
        padding: 1px 5px;
        border-radius: 4px;
        background: rgba(0, 0, 0, 0.2);
        color: var(--text-secondary, #cbd5e1);
      }

      /* Released Link */
      .haven-automod-released {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        color: var(--accent, #3b82f6);
        text-decoration: underline;
        text-underline-offset: 2px;
        transition: color 0.15s ease;
      }
      .haven-automod-released:hover {
        color: #60a5fa;
      }
      .hq-verified-check {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        font-size: 0.72em;
        background: rgba(34, 197, 94, 0.15);
        color: #22c55e;
        border: 1px solid rgba(34, 197, 94, 0.35);
        border-radius: 4px;
        padding: 0 4px;
        font-weight: 600;
        text-decoration: none;
        margin-left: 2px;
      }
      .hq-unchecked {
        font-size: 0.68em;
        color: var(--text-muted, #94a3b8);
        border: 1px dashed var(--border, rgba(148, 163, 184, 0.4));
        border-radius: 4px;
        padding: 0 4px;
        margin-left: 4px;
        text-decoration: none;
      }

      /* Blocked Card */
      .haven-automod-blocked-card {
        margin: 6px 0;
        padding: 10px 12px;
        border-radius: 8px;
        background: rgba(239, 68, 68, 0.08);
        border: 1px solid rgba(239, 68, 68, 0.3);
        color: var(--text-primary, #f8fafc);
        font-size: 0.88em;
      }
      .hab-header {
        display: flex;
        align-items: center;
        gap: 6px;
        font-weight: 600;
        color: #ef4444;
        margin-bottom: 4px;
      }
      .hab-details {
        color: var(--text-secondary, #cbd5e1);
        margin-bottom: 6px;
        line-height: 1.4;
      }
      .hab-url {
        font-family: monospace;
        font-size: 0.85em;
        background: rgba(0, 0, 0, 0.25);
        padding: 2px 6px;
        border-radius: 4px;
        word-break: break-all;
        color: #f87171;
      }
      .hab-actions {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-top: 8px;
      }
      .hab-btn {
        padding: 3px 8px;
        font-size: 0.78em;
        border-radius: 4px;
        border: 1px solid rgba(255, 255, 255, 0.15);
        background: var(--bg-secondary, rgba(255, 255, 255, 0.08));
        color: var(--text-primary, #fff);
        cursor: pointer;
        transition: background 0.15s ease;
      }
      .hab-btn:hover {
        background: rgba(255, 255, 255, 0.16);
      }
      .hab-btn.warn {
        background: rgba(245, 158, 11, 0.2);
        border-color: rgba(245, 158, 11, 0.4);
        color: #fbbf24;
      }
      .hab-btn.warn:hover {
        background: rgba(245, 158, 11, 0.35);
      }
      .hab-btn.release {
        background: rgba(34, 197, 94, 0.2);
        border-color: rgba(34, 197, 94, 0.4);
        color: #4ade80;
      }
      .hab-btn.release:hover {
        background: rgba(34, 197, 94, 0.35);
      }

      /* AutoMod Interactive Config Modal */
      .hq-modal-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.65);
        backdrop-filter: blur(4px);
        z-index: 10000;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 16px;
      }
      .hq-modal-dialog {
        background: var(--bg-primary, #1e293b);
        border: 1px solid var(--border, rgba(255, 255, 255, 0.12));
        border-radius: 12px;
        width: 100%;
        max-width: 580px;
        max-height: 90vh;
        overflow-y: auto;
        padding: 24px;
        box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5);
        color: var(--text-primary, #f8fafc);
        font-family: inherit;
      }
      .hq-modal-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        border-bottom: 1px solid var(--border, rgba(255, 255, 255, 0.1));
        padding-bottom: 12px;
        margin-bottom: 16px;
      }
      .hq-modal-title {
        font-size: 1.25rem;
        font-weight: 700;
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .hq-close-btn {
        background: transparent;
        border: none;
        color: var(--text-muted, #94a3b8);
        font-size: 1.5rem;
        cursor: pointer;
        padding: 0 4px;
      }
      .hq-form-group {
        margin-bottom: 16px;
      }
      .hq-form-label {
        display: block;
        font-size: 0.85rem;
        font-weight: 600;
        color: var(--text-secondary, #cbd5e1);
        margin-bottom: 6px;
      }
      .hq-input, .hq-select, .hq-textarea {
        width: 100%;
        padding: 8px 12px;
        border-radius: 6px;
        border: 1px solid var(--border, rgba(255, 255, 255, 0.15));
        background: var(--bg-secondary, rgba(15, 23, 42, 0.6));
        color: #fff;
        font-size: 0.9rem;
        box-sizing: border-box;
      }
      .hq-input:focus, .hq-select:focus, .hq-textarea:focus {
        outline: none;
        border-color: var(--accent, #3b82f6);
      }
      .hq-row {
        display: flex;
        gap: 12px;
      }
      .hq-toggle-label {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 0.88rem;
        cursor: pointer;
        user-select: none;
      }
      .hq-btn-row {
        display: flex;
        justify-content: flex-end;
        gap: 10px;
        margin-top: 20px;
        border-top: 1px solid var(--border, rgba(255, 255, 255, 0.1));
        padding-top: 16px;
      }
      .hq-btn-primary {
        background: var(--accent, #3b82f6);
        color: #fff;
        border: none;
        border-radius: 6px;
        padding: 8px 16px;
        font-weight: 600;
        cursor: pointer;
      }
      .hq-btn-test {
        background: rgba(16, 185, 129, 0.2);
        color: #34d399;
        border: 1px solid rgba(16, 185, 129, 0.4);
        border-radius: 6px;
        padding: 8px 14px;
        font-size: 0.85rem;
        cursor: pointer;
      }
      .hq-btn-test:hover {
        background: rgba(16, 185, 129, 0.35);
      }
    `;
  }

  constructor() {
    this._started = false;
    this._settings = Object.assign({}, AutoModQuarantine.DEFAULT_SETTINGS);
    this._cache = new Map(); // url -> { status: 'safe'|'blocked'|'quarantined', reason, timestamp, source }
    this._strikes = new Map(); // userId -> { count: N, infractions: [] }
    this._scanQueue = new Set();
    this._pendingQueue = [];
    this._activeScans = 0;
    this._observer = null;
    this._ocSession = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `hq-${Date.now()}`;
  }

  start() {
    if (this._started) return;
    this._started = true;

    this._loadConfig();
    this._detecting = this._autoDetectLocalAi(false).catch(e => {
      console.warn('[AutoMod Quarantine] Local AI detection failed:', e);
      return null;
    });
    this._injectStyles();
    this._patchMessageFormatting();
    this._setupDomObserver();
    this._attachModActionHandlers();
    this._mountSettingsTrigger();

    console.log('[AutoMod Quarantine] Plugin started (Provider:', this._settings.aiProvider, ')');
  }

  stop() {
    if (!this._started) return;
    this._started = false;

    if (this._observer) {
      this._observer.disconnect();
      this._observer = null;
    }
    if (this._clickHandler) {
      document.removeEventListener('click', this._clickHandler);
      this._clickHandler = null;
    }

    if (typeof HavenApi !== 'undefined' && HavenApi.Patcher) {
      HavenApi.Patcher.unpatchAll('AutoModQuarantine');
    }
    this._removeStyles();
    this._unmountSettingsTrigger();

    console.log('[AutoMod Quarantine] Plugin stopped');
  }

  // ═══════════════════════════════════════════════════════════════════
  // Configuration & Providers
  // ═══════════════════════════════════════════════════════════════════

  _loadConfig() {
    if (typeof HavenApi === 'undefined' || !HavenApi.Data) return;
    try {
      const saved = HavenApi.Data.load('AutoModQuarantine', 'settings', null);
      if (saved && typeof saved === 'object') {
        this._hasSavedSettings = true;
        this._settings = Object.assign({}, AutoModQuarantine.DEFAULT_SETTINGS, saved);
      }
      const savedStrikes = HavenApi.Data.load('AutoModQuarantine', 'strikes', null);
      if (savedStrikes && typeof savedStrikes === 'object') {
        for (const [k, v] of Object.entries(savedStrikes)) {
          this._strikes.set(Number(k) || k, v);
        }
      }
    } catch (e) {
      console.warn('[AutoMod Quarantine] Failed to load config:', e);
    }
  }

  async _autoDetectLocalAi(force = false) {
    if (typeof fetch === 'undefined' || typeof localStorage === 'undefined') return null;
    const legacy = this._settings.aiProvider === 'ollama' && this._isLocalUrl(this._settings.aiEndpoint || AutoModQuarantine.PROVIDERS.ollama.defaultEndpoint);
    if (!force && this._hasSavedSettings && !legacy) return null;
    // A 404 means the admin has not turned on AI link checks on this server.
    const d = await fetch('/api/automod/local-status', { headers: this._havenAuth() }).then(r => r.ok ? r.json() : null).catch(e => {
      console.warn('[AutoMod Quarantine] Could not ask the server about local AI:', e.message);
      return null;
    });
    if (d?.available) {
      force || Object.assign(this._settings, { aiProvider: 'haven', aiModel: '', aiEndpoint: '' }, d.rules ? { serverRules: d.rules } : {});
      return { provider: 'haven', model: d.model, endpoint: '', models: [d.model], rules: d.rules || '', source: 'server' };
    }
    if (!force) return null;
    // No Ollama on this device is the normal case, so a refused request is expected.
    const lr = await fetch('http://localhost:11434/api/tags').catch(() => null);
    const tags = lr?.ok ? await lr.json().catch(e => {
      console.warn('[AutoMod Quarantine] Ollama sent an unreadable model list:', e.message);
      return null;
    }) : null;
    const models = (tags?.models || []).map(m => m.name).filter(Boolean);
    return models.length ? { provider: 'ollama', model: models[0], endpoint: AutoModQuarantine.PROVIDERS.ollama.defaultEndpoint, models, source: 'local', reason: d?.reason || '' } : (d ? { provider: null, reason: d.reason } : null);
  }

  _saveConfig() {
    if (typeof HavenApi === 'undefined' || !HavenApi.Data) return;
    try {
      HavenApi.Data.save('AutoModQuarantine', 'settings', this._settings);
      const strikesObj = {};
      for (const [k, v] of this._strikes) strikesObj[k] = v;
      HavenApi.Data.save('AutoModQuarantine', 'strikes', strikesObj);
    } catch (e) {
      console.warn('[AutoMod Quarantine] Failed to save config:', e);
    }
  }

  getEffectiveAiConfig() {
    const providerId = this._settings.aiProvider || 'gemini';
    const providerMeta = AutoModQuarantine.PROVIDERS[providerId] || AutoModQuarantine.PROVIDERS.custom;

    const endpoint = (this._settings.aiEndpoint || '').trim() || providerMeta.defaultEndpoint;
    const model = (this._settings.aiModel || '').trim() || providerMeta.defaultModel;
    const apiKey = (this._settings.aiApiKey || '').trim();

    return {
      providerId,
      name: providerMeta.name,
      type: providerMeta.type,
      endpoint,
      model,
      apiKey,
      auth: this._settings.aiAuth === 'sso' ? 'sso' : 'key'
    };
  }

  _token(config) {
    return String(config?.apiKey || '').trim().replace(/^Bearer\s+/i, '');
  }

  _useSso(config) {
    return config?.auth === 'sso' || /^Bearer\s+/i.test(String(config?.apiKey || ''));
  }

  _authHeaders(config) {
    const token = this._token(config);
    const headers = {};
    if (config?.providerId === 'opencode' && this._ocSession) headers['x-opencode-session'] = this._ocSession;
    if (!token) return headers;
    if (config.type === 'gemini') {
      this._useSso(config) ? headers.Authorization = `Bearer ${token}` : headers['x-goog-api-key'] = token;
      return headers;
    }
    if (config.type === 'anthropic') {
      this._useSso(config) ? headers.Authorization = `Bearer ${token}` : headers['x-api-key'] = token;
      return headers;
    }
    headers.Authorization = `Bearer ${token}`;
    return headers;
  }

  _havenAuth() {
    return { Authorization: `Bearer ${(typeof localStorage !== 'undefined' && localStorage.getItem('haven_token')) || ''}` };
  }
  _isMod() {
    const app = typeof window !== 'undefined' ? window.app : null;
    return typeof HavenApi === 'undefined' || !HavenApi.currentUser || !!(HavenApi.currentUser.isAdmin || app?._hasPerm?.('delete_message') || app?._canModerate?.());
  }
  async _claimWarn(key) {
    if (typeof fetch === 'undefined' || typeof localStorage === 'undefined') return true;
    const r = await fetch('/api/automod/claim-warn', { method: 'POST', headers: { 'Content-Type': 'application/json', ...this._havenAuth() }, body: JSON.stringify({ key }) }).catch(e => {
      console.warn('[AutoMod Quarantine] Could not claim the warning:', e.message);
      return null;
    });
    // Without a server to share the claim (unreachable, or AI checks off),
    // nobody else can be told, so warn rather than stay silent.
    if (!r || r.status === 404) return true;
    if (!r.ok) return false;
    const d = await r.json().catch(e => {
      console.warn('[AutoMod Quarantine] Unreadable claim answer:', e.message);
      return null;
    });
    return d?.claimed === true;
  }
  _isLocalUrl(url) {
    try { return /^(localhost|127\.|0\.0\.0\.0$|\[::1\]$|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)|\.local$/.test(new URL(url).hostname); } catch { return false; }
  }
  async _post(url, headers, body) {
    const host = (() => { try { return new URL(url).hostname; } catch { return ''; } })(), relayed = (this._relayHosts ||= new Set());
    if (!relayed.has(host)) {
      try { return await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) }); } catch (e) { if (this._isLocalUrl(url) || typeof localStorage === 'undefined') throw e; relayed.add(host); }
    }
    const r = await fetch('/api/automod/relay', { method: 'POST', headers: { 'Content-Type': 'application/json', ...this._havenAuth() }, body: JSON.stringify({ url, headers, body }) });
    // A non-JSON reply still gets reported below through its status code.
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(r.status === 404 ? `${host} blocks browser requests and this Haven server has no AI relay` : (d.error || `Relay status ${r.status}`));
    return { ok: d.status >= 200 && d.status < 300, status: d.status, text: async () => d.body || '', json: async () => JSON.parse(d.body || '{}') };
  }
  async _fail(name, resp) {
    // The status alone still makes a useful error when the body is unreadable.
    const t = await resp.text().catch(() => '');
    const m = (() => { try { const j = JSON.parse(t); return j.error?.message || j.error || j.message || ''; } catch { return t; } })();
    throw new Error(`${name} status ${resp.status}${m ? `: ${String(typeof m === 'string' ? m : JSON.stringify(m)).slice(0, 160)}` : ''}`);
  }
  _aiText(data) {
    if (!data || typeof data !== 'object') return '';
    const choice = data.choices?.[0]?.message?.content;
    if (typeof choice === 'string' && choice.trim()) return choice;
    if (typeof data.output_text === 'string' && data.output_text.trim()) return data.output_text;
    const blocks = Array.isArray(data.output) ? data.output : [];
    const joined = blocks.flatMap(o => Array.isArray(o?.content) ? o.content : []).map(c => c?.text || '').join('');
    return joined.trim() ? joined : (data.content?.[0]?.text || '');
  }

  _injectStyles() {
    if (typeof HavenApi !== 'undefined' && HavenApi.DOM) {
      HavenApi.DOM.addStyle('AutoModQuarantine', AutoModQuarantine.CSS);
    } else if (typeof document !== 'undefined') {
      const el = document.createElement('style');
      el.id = 'haven-plugin-style-AutoModQuarantine';
      el.textContent = AutoModQuarantine.CSS;
      document.head.appendChild(el);
    }
  }

  _removeStyles() {
    if (typeof HavenApi !== 'undefined' && HavenApi.DOM) {
      HavenApi.DOM.removeStyle('AutoModQuarantine');
    } else if (typeof document !== 'undefined') {
      document.getElementById('haven-plugin-style-AutoModQuarantine')?.remove();
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // URL Extraction & Normalization
  // ═══════════════════════════════════════════════════════════════════

  extractUrls(text) {
    if (typeof text !== 'string' || !text.trim()) return [];
    const urls = [];
    const seen = new Set();

    // Markdown URLs [text](url) and ![alt](url)
    const mdRegex = /!?\[([^\]]*)\]\(\s*([^\s)]+)\s*\)/gi;
    let m;
    while ((m = mdRegex.exec(text)) !== null) {
      let rawUrl = m[2];
      try {
        const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(rawUrl) ? rawUrl : 'http://' + rawUrl);
        const url = u.href;
        if (!seen.has(url)) {
          seen.add(url);
          urls.push({ url, raw: rawUrl, label: m[1] || url, isMarkdown: true });
        }
      } catch {
        // Not a URL after all (e.g. "[x](not a link)"): leave it as text.
      }
    }

    const withoutMd = text.replace(mdRegex, ' ');

    // Bare autolinks
    const autoRegex = /\bhttps?:\/\/[^\s<>"'`\])]+/gi;
    while ((m = autoRegex.exec(withoutMd)) !== null) {
      let rawUrl = m[0].replace(/[.,;:!?)]+$/, '');
      try {
        const u = new URL(rawUrl);
        const url = u.href;
        if (!seen.has(url)) {
          seen.add(url);
          urls.push({ url, raw: rawUrl, label: rawUrl, isMarkdown: false });
        }
      } catch {
        // Looked like a link but does not parse: leave it as text.
      }
    }

    return urls;
  }

  normalizeHost(rawHost) {
    if (!rawHost || typeof rawHost !== 'string') return '';
    let host = rawHost.trim().toLowerCase();
    host = host.replace(/\.+$/, '');
    if (host.startsWith('www.')) host = host.slice(4);
    host = host.replace(/:\d+$/, '');
    return host;
  }

  getHost(url) {
    try {
      const parsed = new URL(url);
      return this.normalizeHost(parsed.hostname);
    } catch {
      return '';
    }
  }

  isSubdomainOf(host, parent) {
    if (!host || !parent) return false;
    if (host === parent) return true;
    return host.endsWith('.' + parent);
  }

  // ═══════════════════════════════════════════════════════════════════
  // Source Trust Engine
  // ═══════════════════════════════════════════════════════════════════

  checkSourceTrust(url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return { ok: false, reason: 'Invalid or malformed URL syntax' };
    }

    const host = this.normalizeHost(parsed.hostname);
    if (!host) return { ok: false, reason: 'Missing or empty hostname' };

    // 1. Raw IP check
    if (this._settings.blockRawIps) {
      const isIp = /^(\d{1,3}\.){3}\d{1,3}$/.test(host) || host.includes(':') || /^\[[a-f0-9:]+\]$/i.test(host);
      if (isIp) {
        return { ok: false, reason: 'Direct IP address links are prohibited (anti-reconnaissance security rule)' };
      }
    }

    // 2. Punycode check (homoglyphs)
    if (this._settings.blockPunycode) {
      if (host.includes('xn--')) {
        return { ok: false, reason: 'Suspicious internationalized/homoglyph domain (punycode) blocked' };
      }
    }

    // 3. Dangerous executable extensions
    if (this._settings.blockDangerousExtensions) {
      const pathname = parsed.pathname.toLowerCase();
      for (const ext of this._settings.dangerousExtensions) {
        if (pathname.endsWith(ext) || pathname.includes(ext + '?')) {
          return { ok: false, reason: `Direct download of executable/binary (${ext}) is blocked for server security` };
        }
      }
    }

    // 4. Server blocked domains
    for (const b of this._settings.blockedDomains || []) {
      const normB = this.normalizeHost(b);
      if (normB && this.isSubdomainOf(host, normB)) {
        return { ok: false, reason: `Domain ${host} is on the server blocked source list` };
      }
    }

    // 5. Well-known Phishing / Scam patterns
    const pathAndQuery = (parsed.pathname + parsed.search).toLowerCase();
    const fullLower = url.toLowerCase();

    // Discord Nitro Phishing
    if (/(nitro|free-nitro|claim-nitro|gift-nitro)/.test(fullLower) && !this.isSubdomainOf(host, 'discord.com')) {
      return { ok: false, reason: 'Suspected Discord Nitro phishing scam' };
    }

    // Steam scams
    if (/(tradeoffer|steamcommunity-.*|steampowered-.*|gift-steam)/.test(fullLower) && !this.isSubdomainOf(host, 'steampowered.com') && !this.isSubdomainOf(host, 'steamcommunity.com')) {
      return { ok: false, reason: 'Suspected Steam credential harvesting / trade scam' };
    }

    // Crypto wallet drainers
    if (/(airdrop-claim|claim-airdrop|connect-wallet|drainer|metamask-verify|phantom-claim)/.test(pathAndQuery)) {
      return { ok: false, reason: 'Suspected cryptocurrency wallet drainer / airdrop scam' };
    }

    // 6. Trusted Domain whitelist match
    for (const t of this._settings.trustedDomains || []) {
      const normT = this.normalizeHost(t);
      if (normT && this.isSubdomainOf(host, normT)) {
        return { ok: true, trusted: true, reason: `Verified trusted source (${normT})` };
      }
    }

    // Neutral - needs AI/heuristic content check
    return { ok: true, trusted: false, reason: 'Unverified third-party domain' };
  }

  // ═══════════════════════════════════════════════════════════════════
  // Multi-Provider AI Content & Security Scanner
  // ═══════════════════════════════════════════════════════════════════

  async scanContentAndLink(url, contextText = '') {
    if (this._cache.has(url)) {
      return this._cache.get(url);
    }

    // Step 1: Source trust check
    const trust = this.checkSourceTrust(url);
    if (!trust.ok) {
      const verdict = {
        status: 'blocked',
        reason: trust.reason,
        url,
        host: this.getHost(url),
        source: 'source_trust',
        timestamp: Date.now()
      };
      this._cache.set(url, verdict);
      return verdict;
    }

    if (trust.trusted) {
      const verdict = {
        status: 'safe',
        reason: trust.reason,
        url,
        host: this.getHost(url),
        source: 'trusted_whitelist',
        timestamp: Date.now()
      };
      this._cache.set(url, verdict);
      return verdict;
    }

    // Step 2: Multi-Provider AI / Heuristic evaluation
    let aiVerdict;
    if (this._settings.aiScanEnabled) {
      await this._detecting;
      const config = this.getEffectiveAiConfig();
      aiVerdict = await this._dispatchAiScan(url, contextText, config);
    } else {
      aiVerdict = this._scanWithLocalHeuristicAI(url, contextText);
    }

    const verdict = {
      status: aiVerdict.safe ? 'safe' : 'blocked',
      reason: aiVerdict.reason,
      url,
      host: this.getHost(url),
      source: aiVerdict.source,
      timestamp: Date.now()
    };

    if (verdict.status === 'blocked' && verdict.source !== 'heuristic_ai' && this._settings.autoBlacklistBadHosts !== false && verdict.host) {
      this._blacklistHost(verdict.host);
    }

    this._cache.set(url, verdict);
    return verdict;
  }

  _blacklistHost(host) {
    const norm = this.normalizeHost(host);
    if (!norm) return;
    for (const t of this._settings.trustedDomains || []) {
      const normT = this.normalizeHost(t);
      if (normT && this.isSubdomainOf(norm, normT)) return;
    }
    this._settings.blockedDomains ||= [];
    const exists = this._settings.blockedDomains.some(b => this.normalizeHost(b) === norm);
    if (!exists) {
      this._settings.blockedDomains.push(norm);
      this._saveConfig();
    }
  }

  _unblacklistHost(host) {
    const norm = this.normalizeHost(host);
    if (!norm || !Array.isArray(this._settings.blockedDomains)) return;
    const before = this._settings.blockedDomains.length;
    this._settings.blockedDomains = this._settings.blockedDomains.filter(b => this.normalizeHost(b) !== norm);
    if (this._settings.blockedDomains.length !== before) {
      this._saveConfig();
    }
  }

  // Only the link goes to the AI. The message around it can be a private
  // channel or a decrypted DM, and it never leaves this browser; the keyword
  // checks in _scanWithLocalHeuristicAI still read it locally.
  _scanPrompts(url) {
    return [`You are an automated security and content moderation analyzer for a community chat server.
Evaluate this link for security threats (phishing, malware, exploits, token loggers, credential theft) and server rule violations (hate speech, severe harassment, NSFW/illicit, fraud).
Server Rules: "${this._settings.serverRules}"
Respond ONLY in valid raw JSON matching: {"safe": boolean, "category": string, "reason": string, "confidence": number}`, `Target URL: "${url}"\nDomain: "${this.getHost(url)}"`];
  }

  async _dispatchAiScan(url, contextText, config, strict = false) {
    const [systemPrompt, userPrompt] = this._scanPrompts(url);

    try {
      if (config.type === 'haven') {
        const r = await fetch('/api/automod/scan', { method: 'POST', headers: { 'Content-Type': 'application/json', ...this._havenAuth() }, body: JSON.stringify({ url }) });
        if (r.status === 202) throw new Error('Only moderators can start new scans on the Haven server AI');
        if (!r.ok) await this._fail('Haven server AI', r);
        const v = await r.json();
        if (typeof v.safe !== 'boolean') throw new Error('The Haven server AI gave no verdict');
        return { safe: v.safe, reason: v.reason || 'Checked by the Haven server AI', source: 'haven_ai' };
      }
      if (!this._token(config) && AutoModQuarantine.PROVIDERS[config.providerId]?.needsKey) {
        if (strict) throw new Error('No API key or token entered');
        return this._scanWithLocalHeuristicAI(url, contextText);
      }
      if (config.type === 'gemini') {
        const endpoint = `${String(config.endpoint).replace(/\/+$/, '')}/${encodeURIComponent(config.model)}:generateContent`;
        const resp = await this._post(endpoint, { 'Content-Type': 'application/json', ...this._authHeaders(config) }, {
          contents: [{ parts: [{ text: `${systemPrompt}\n\n${userPrompt}` }] }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 1024, responseMimeType: 'application/json' }
        });
        if (!resp.ok) await this._fail('Gemini', resp);
        const data = await resp.json();
        const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        return this._parseAiResponse(rawText, 'gemini_ai');
      }

      if (config.type === 'anthropic') {
        const headers = {
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
          ...this._authHeaders(config)
        };
        const resp = await this._post(config.endpoint, headers, { model: config.model, max_tokens: 1024, system: systemPrompt, messages: [{ role: 'user', content: userPrompt }] });
        if (!resp.ok) await this._fail('Claude', resp);
        const data = await resp.json();
        const rawText = data?.content?.[0]?.text;
        return this._parseAiResponse(rawText, 'claude_ai');
      }

      const payload = {
        model: config.model,
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
        max_tokens: 1024
      };
      if (config.providerId === 'ollama' && this._settings.unloadModelAfterQueue) {
        const queueEmpty = (!this._pendingQueue || this._pendingQueue.length === 0) && (this._activeScans || 0) <= 1;
        payload.keep_alive = queueEmpty ? 0 : '2m';
      }
      const resp = await this._post(config.endpoint, { 'Content-Type': 'application/json', ...this._authHeaders(config) }, payload);
      if (!resp.ok) await this._fail(config.name, resp);
      const data = await resp.json();
      if (config.providerId === 'ollama') this._ollamaLoaded = payload.keep_alive !== 0;
      return this._parseAiResponse(this._aiText(data), `${config.providerId}_ai`);
    } catch (err) {
      if (strict) throw err;
      console.warn(`[AutoMod ${config.name}] API failed, falling back to heuristics:`, err.message);
      return this._scanWithLocalHeuristicAI(url, contextText);
    }
  }

  async _unloadLocalModel() {
    if (!this._settings.unloadModelAfterQueue || typeof fetch === 'undefined') return false;
    const config = this.getEffectiveAiConfig();
    if (config.providerId !== 'ollama' || !config.model) return false;
    try {
      const u = new URL(config.endpoint);
      const genUrl = `${u.protocol}//${u.host}/api/generate`;
      await fetch(genUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: config.model, keep_alive: 0 })
      });
      this._ollamaLoaded = false;
      return true;
    } catch (e) {
      console.warn('[AutoMod Quarantine] Could not unload the local model:', e.message);
      return false;
    }
  }

  // A missing or garbled answer is never read as safe: it throws, and the
  // caller falls back to the keyword checks, which do not earn the AI badge.
  _parseAiResponse(rawText, sourceLabel) {
    if (!rawText) throw new Error('The AI returned an empty answer');
    const clean = rawText.replace(/```json\s*/gi, '').replace(/```\s*$/gi, '').trim();
    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch {
      throw new Error('The AI answer was not valid JSON');
    }
    if (typeof parsed?.safe !== 'boolean') throw new Error('The AI answer had no safe/unsafe verdict');
    return {
      safe: parsed.safe,
      reason: parsed.reason || (parsed.safe ? 'AI found nothing wrong' : 'AI flagged a security risk'),
      source: sourceLabel
    };
  }

  async testAiConnection() {
    const config = this.getEffectiveAiConfig();
    try {
      const res = await this._dispatchAiScan('https://wikipedia.org/wiki/Computer_security', 'Checking server rules and security status', config, true);
      return { ok: true, message: `Connected to ${config.name}${config.model ? ` (${config.model})` : ''}${(this._relayHosts || new Set()).has((() => { try { return new URL(config.endpoint).hostname; } catch { return ''; } })()) ? ' through the Haven relay' : ''}. Test verdict: ${res.safe ? 'Safe' : 'Flagged'} (${res.reason})` };
    } catch (err) {
      return { ok: false, message: `Failed to connect to ${config.name}: ${err.message}` };
    }
  }

  _scanWithLocalHeuristicAI(url, contextText) {
    const host = this.getHost(url);
    const full = (url + ' ' + (contextText || '')).toLowerCase();

    // High-risk TLD list
    const suspiciousTlds = ['.xyz', '.top', '.buzz', '.click', '.country', '.mom', '.fit', '.kim', '.gq', '.cf', '.tk', '.ml', '.ga', '.work'];
    for (const tld of suspiciousTlds) {
      if (host.endsWith(tld)) {
        return {
          safe: false,
          reason: `High-risk / abused top-level domain (${tld}) detected without verified reputation`,
          source: 'heuristic_ai'
        };
      }
    }

    // Suspicious social engineering keyword combinations
    const scamTriggers = [
      { pattern: /(free|claim|gift|win|get).*(nitro|robux|vbucks|steam|airdrop)/i, label: 'Free reward / gift bait scam' },
      { pattern: /(test my game|playtest|download this|try my build).*(exe|game|link)/i, label: 'Malicious payload / game test scam' },
      { pattern: /(urgent|action required|verify account|login to keep)/i, label: 'Urgency credential harvesting bait' },
      { pattern: /(token|auth|session).*(grab|log|stealer)/i, label: 'Credential theft script' }
    ];

    for (const trigger of scamTriggers) {
      if (trigger.pattern.test(full)) {
        return {
          safe: false,
          reason: trigger.label,
          source: 'heuristic_ai'
        };
      }
    }

    // High entropy or suspicious random subdomains (e.g. kj23jk4h2.evil.com)
    const subdomains = host.split('.');
    if (subdomains.length > 3) {
      for (const sub of subdomains.slice(0, -2)) {
        if (sub.length > 12 && /[0-9]/.test(sub) && /[a-z]/.test(sub)) {
          return {
            safe: false,
            reason: 'Suspicious randomized subdomain structure (DGA/entropy risk)',
            source: 'heuristic_ai'
          };
        }
      }
    }

    return {
      safe: true,
      reason: 'Only the basic keyword checks ran; no AI looked at this link',
      source: 'heuristic_ai'
    };
  }

  // The shield badge means an AI, the trusted list or a moderator vouched for
  // the link. Passing the keyword checks alone is not that.
  _safeBadge(verdict) {
    if (verdict.source === 'heuristic_ai') {
      return `<span class="hq-unchecked" title="${this._escapeHtml(verdict.reason)}">not AI-checked</span>`;
    }
    return '<span class="hq-verified-check" title="Checked by AutoMod">🛡️✓</span>';
  }

  _blockedCardHtml(url, verdict) {
    // Only moderators can warn; everyone else can still choose to reveal the link.
    const warn = this._isMod() ? `<button class="hab-btn warn hq-warn-btn" data-url="${this._escapeHtml(url)}" data-reason="${this._escapeHtml(verdict.reason)}">⚠️ Warn User</button>` : '';
    return `
          <div class="hab-header">
            <span class="hq-icon">🚫</span>
            <span>Link Blocked by AutoMod</span>
          </div>
          <div class="hab-details">
            <strong>Violation:</strong> ${this._escapeHtml(verdict.reason)}
          </div>
          <div class="hab-url"><code>${this._escapeHtml(url)}</code></div>
          <div class="hab-actions">
            ${warn}
            <button class="hab-btn release hq-override-btn" data-url="${this._escapeHtml(url)}">🔓 ${this._isMod() ? 'Override &amp; Release' : 'Show link anyway'}</button>
          </div>
        `;
  }

  // ═══════════════════════════════════════════════════════════════════
  // User Strikes & Warnings
  // ═══════════════════════════════════════════════════════════════════

  recordInfraction(userId, username, reason, url) {
    const key = Number(userId) || userId || username || 'unknown';
    let record = this._strikes.get(key);
    if (!record) {
      record = { count: 0, infractions: [] };
      this._strikes.set(key, record);
    }

    record.count += 1;
    record.infractions.push({
      time: new Date().toISOString(),
      url,
      reason
    });

    this._saveConfig();
    return record.count;
  }

  getUserStrikes(userId) {
    const key = Number(userId) || userId;
    return this._strikes.get(key)?.count || 0;
  }

  clearUserStrikes(userId) {
    const key = Number(userId) || userId;
    this._strikes.delete(key);
    this._saveConfig();
  }

  issueWarning(username, userId, reason, url, channelCode) {
    const strikes = this.recordInfraction(userId, username, reason, url);
    const maxStrikes = this._settings.maxStrikes;

    const warnMsg = this._settings.warningTemplate
      .replace('{user}', username || 'User')
      .replace('{reason}', reason)
      .replace('{url}', url)
      .replace('{strikes}', strikes)
      .replace('{maxStrikes}', maxStrikes);

    // 1. Post to Haven channel if socket is available
    if (typeof HavenApi !== 'undefined' && HavenApi.socket && channelCode) {
      try {
        HavenApi.socket.emit('send-message', {
          code: channelCode,
          content: warnMsg
        });
      } catch (e) {
        console.warn('[AutoMod] Failed to emit warning message:', e);
      }
    }

    // 2. UI toast notice
    if (typeof HavenApi !== 'undefined' && HavenApi.UI) {
      HavenApi.UI.showToast(`AutoMod warning issued to @${username} (Strike ${strikes}/${maxStrikes})`, 'warning');
    }

    // 3. Escalation check
    if (strikes >= maxStrikes) {
      this._handleEscalation(username, userId, channelCode);
    }

    return { strikes, message: warnMsg };
  }

  _handleEscalation(username, userId, channelCode) {
    if (typeof HavenApi === 'undefined' || !HavenApi.currentUser) return;
    const isModOrAdmin = this._isMod();

    const summary = `🚨 AutoMod Escalation: @${username} has reached ${this._settings.maxStrikes} strikes.`;
    if (HavenApi.UI) {
      HavenApi.UI.showToast(summary, 'error');
    }

    if (isModOrAdmin && HavenApi.socket && channelCode) {
      try {
        HavenApi.socket.emit('send-message', {
          code: channelCode,
          content: `${summary} Action may be taken by server moderators.`
        });
      } catch (e) {
        console.warn('[AutoMod] Failed to post the escalation notice:', e);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Formatting & DOM Interception
  // ═══════════════════════════════════════════════════════════════════

  _patchMessageFormatting() {
    if (typeof HavenApi === 'undefined' || !HavenApi.Patcher || !window.app) return;

    const self = this;
    HavenApi.Patcher.instead('AutoModQuarantine', window.app, '_formatContent', function(args, orig) {
      const rawText = args[0];
      const origHtml = orig.apply(this, args);
      if (!self._settings.enabled) return origHtml;
      // Text from an end-to-end encrypted DM stays between its two people, so
      // its links are never sent to the server's AI or a cloud one.
      if (args[1] && args[1].e2e) return origHtml;

      return self.transformMessageHtml(origHtml, rawText);
    });
  }

  _linkRegex(item) {
    const raw = item?.raw || item?.url || '';
    const url = item?.url || raw;
    const candidates = new Set([
      url,
      raw,
      url.replace(/\/$/, ''),
      this._escapeHtml(url),
      this._escapeHtml(raw),
      this._escapeHtml(url.replace(/\/$/, ''))
    ].filter(Boolean));
    const alts = Array.from(candidates, c => this._escapeRegex(c)).join('|');
    return new RegExp(`<a\\s+[^>]*href=["'](?:${alts})["'][^>]*>(.*?)<\\/a>`, 'gi');
  }

  transformMessageHtml(html, rawText) {
    if (typeof html !== 'string' || !html.includes('href=')) return html;

    const urls = this.extractUrls(rawText || '');
    if (!urls.length) return html;

    let modified = html;
    for (const item of urls) {
      const url = item.url;
      const host = this.getHost(url);
      const verdict = this._cache.get(url);
      const linkPattern = this._linkRegex(item);

      if (verdict && verdict.status === 'safe') {
        modified = modified.replace(linkPattern, (match, text) => {
          return `<a href="${this._escapeHtml(url)}" target="_blank" rel="noopener noreferrer nofollow" class="haven-automod-released">${text}${this._safeBadge(verdict)}</a>`;
        });
      } else if (verdict && verdict.status === 'blocked') {
        const blockedCard = `<div class="haven-automod-blocked-card" data-hq-url="${this._escapeHtml(url)}">${this._blockedCardHtml(url, verdict)}</div>`;
        modified = modified.replace(linkPattern, () => blockedCard);
      } else {
        const quarantineCapsule = `
          <span class="haven-quarantine-capsule scanning" data-hq-url="${this._escapeHtml(url)}" data-hq-text="${this._escapeHtml(item.label)}">
            <span class="hq-icon">🛡️</span>
            <span class="hq-pulse-dot"></span>
            <span class="hq-label">Quarantined Link</span>
            <span class="hq-domain">${this._escapeHtml(host || url)}</span>
            <span class="hq-status-pill">Scanning...</span>
          </span>
        `;
        modified = modified.replace(linkPattern, () => quarantineCapsule);

        this._enqueueScan(url, rawText);
      }
    }

    return modified;
  }

  _enqueueScan(url, contextText) {
    if (this._cache.has(url) || this._scanQueue.has(url)) return;
    this._scanQueue.add(url);
    this._pendingQueue ||= [];
    this._pendingQueue.push({ url, contextText });
    this._updateQueuedCapsulePills();
    this._drainScanQueue();
  }

  _updateQueuedCapsulePills() {
    if (typeof document === 'undefined' || !this._pendingQueue) return;
    this._pendingQueue.forEach((item, idx) => {
      const escapedUrl = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(item.url) : item.url.replace(/"/g, '\\"');
      const pills = document.querySelectorAll(`.haven-quarantine-capsule[data-hq-url="${escapedUrl}"] .hq-status-pill`);
      pills.forEach(p => {
        p.textContent = (this._activeScans > 0 || idx > 0) ? `Queued (#${idx + 1})...` : 'Scanning...';
      });
    });
  }

  async _drainScanQueue() {
    const maxConcurrent = this.getEffectiveAiConfig().providerId === 'ollama' ? 1 : Math.max(1, Number(this._settings.maxConcurrentScans) || 1);
    while ((this._activeScans || 0) < maxConcurrent && this._pendingQueue && this._pendingQueue.length > 0) {
      const next = this._pendingQueue.shift();
      if (!next) break;
      this._activeScans = (this._activeScans || 0) + 1;

      if (typeof document !== 'undefined') {
        const escapedUrl = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(next.url) : next.url.replace(/"/g, '\\"');
        document.querySelectorAll(`.haven-quarantine-capsule[data-hq-url="${escapedUrl}"] .hq-status-pill`).forEach(p => {
          p.textContent = 'Scanning...';
        });
      }
      this._updateQueuedCapsulePills();

      Promise.resolve().then(async () => {
        try {
          const verdict = await this.scanContentAndLink(next.url, next.contextText);
          this._applyVerdictToDom(verdict);

          if (verdict.status === 'blocked' && this._settings.autoWarnUsers) {
            const currentChannel = typeof HavenApi !== 'undefined' ? HavenApi.currentChannel : null;
            const escapedUrl = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(next.url) : next.url.replace(/"/g, '\\"');
            const card = typeof document !== 'undefined' ? document.querySelector(`[data-hq-url="${escapedUrl}"]`) : null;
            const msgEl = card?.closest('.message, .message-compact');
            const msgId = msgEl?.dataset?.msgId || '';
            const author = msgEl?.dataset?.username || 'user';
            const userId = msgEl?.dataset?.userId || null;
            const warnKey = `${currentChannel || ''}:${msgId || author}:${next.url}`;
            this._autoWarned ||= new Set();

            if (this._isMod() && !this._autoWarned.has(warnKey) && this._autoWarned.add(warnKey) && await this._claimWarn(warnKey)) {
              this.issueWarning(author, userId, verdict.reason, next.url, currentChannel);
            }
          }
        } finally {
          this._scanQueue.delete(next.url);
          this._activeScans = Math.max(0, (this._activeScans || 1) - 1);
          this._updateQueuedCapsulePills();
          if (this._activeScans === 0 && (!this._pendingQueue || this._pendingQueue.length === 0)) {
            if (this._ollamaLoaded && this._settings.unloadModelAfterQueue) {
              this._unloadLocalModel();
            }
          } else {
            this._drainScanQueue();
          }
        }
      });
    }
  }

  _applyVerdictToDom(verdict) {
    if (typeof document === 'undefined') return;
    const url = verdict.url;
    const escapedUrl = CSS.escape(url);
    const capsules = document.querySelectorAll(`.haven-quarantine-capsule[data-hq-url="${escapedUrl}"]`);

    for (const capsule of capsules) {
      if (verdict.status === 'safe') {
        const label = capsule.getAttribute('data-hq-text') || url;
        const linkEl = document.createElement('a');
        linkEl.href = url;
        linkEl.target = '_blank';
        linkEl.rel = 'noopener noreferrer nofollow';
        linkEl.className = 'haven-automod-released';
        linkEl.innerHTML = `${this._escapeHtml(label)}${this._safeBadge(verdict)}`;
        capsule.replaceWith(linkEl);
      } else {
        const blockedEl = document.createElement('div');
        blockedEl.className = 'haven-automod-blocked-card';
        blockedEl.setAttribute('data-hq-url', url);
        blockedEl.innerHTML = this._blockedCardHtml(url, verdict);
        capsule.replaceWith(blockedEl);
      }
    }
  }

  _setupDomObserver() {
    if (typeof document === 'undefined') return;
    const container = document.getElementById('messages') || document.body;
    if (!container) return;

    this._observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === 1) {
            const capsules = node.querySelectorAll?.('.haven-quarantine-capsule.scanning');
            if (capsules) {
              capsules.forEach(c => {
                const url = c.getAttribute('data-hq-url');
                if (url && !this._cache.has(url)) {
                  this._enqueueScan(url, '');
                }
              });
            }
          }
        }
      }
    });

    this._observer.observe(container, { childList: true, subtree: true });
  }

  _attachModActionHandlers() {
    if (typeof document === 'undefined') return;

    this._clickHandler = (event) => {
      const target = event.target;
      if (!target) return;

      // Warn button
      if (target.classList.contains('hq-warn-btn')) {
        const url = target.getAttribute('data-url');
        const reason = target.getAttribute('data-reason');
        const msgEl = target.closest('.message, .message-compact');
        const username = msgEl?.dataset?.username || 'user';
        const userId = msgEl?.dataset?.userId || null;
        const currentChannel = typeof HavenApi !== 'undefined' ? HavenApi.currentChannel : null;

        if (confirm(`Issue formal warning to @${username} for link: ${url}?`)) {
          this.issueWarning(username, userId, reason, url, currentChannel);
        }
      }

      // Override & Release button
      if (target.classList.contains('hq-override-btn')) {
        const url = target.getAttribute('data-url');
        if (confirm(`Manually override quarantine and release link:\n${url}?`)) {
          const host = this.getHost(url);
          this._unblacklistHost(host);
          const verdict = {
            status: 'safe',
            reason: 'Manually released by moderator',
            url,
            host,
            source: 'manual_override',
            timestamp: Date.now()
          };
          this._cache.set(url, verdict);
          this._applyVerdictToDom(verdict);
          if (typeof HavenApi !== 'undefined' && HavenApi.UI) {
            HavenApi.UI.showToast(`Link released: ${url}`, 'info');
          }
        }
      }
    };
    document.addEventListener('click', this._clickHandler);
  }

  // ═══════════════════════════════════════════════════════════════════
  // Settings UI Modal
  // ═══════════════════════════════════════════════════════════════════

  _mountSettingsTrigger() {
    if (typeof document === 'undefined') return;
    this._unmountSettingsTrigger();

    const trigger = document.createElement('div');
    trigger.id = 'automod-settings-launcher';
    trigger.className = 'automod-settings-bar';
    trigger.innerHTML = `<button type="button" class="automod-settings-btn" title="Configure AutoMod AI Provider & Rules">🛡️ AutoMod</button>`;

    const header = document.querySelector('#header-actions-box, .header-right, .top-bar-right, #app-header');
    if (header) {
      header.appendChild(trigger);
      trigger.querySelector('button').addEventListener('click', () => this.openSettingsModal());
    }
  }

  _unmountSettingsTrigger() {
    if (typeof document === 'undefined') return;
    document.getElementById('automod-settings-launcher')?.remove();
  }

  openSettingsModal() {
    if (typeof document === 'undefined') return;
    document.getElementById('automod-config-modal')?.remove();

    const providerOptions = Object.values(AutoModQuarantine.PROVIDERS).map(p => {
      const selected = p.id === this._settings.aiProvider ? 'selected' : '';
      return `<option value="${p.id}" ${selected}>${p.name}</option>`;
    }).join('');

    const effective = this.getEffectiveAiConfig();
    const presetModels = [
      'granite4.2:8b',
      'granite4.2:latest',
      'granite4:7b-a1b-h',
      'granite4.2:3b',
      'granite4:1b-h',
      'qwen3.8:27b',
      'qwen3.6:35b-a3b',
      'qwen3.5:9b',
      'qwen3.5:4b',
      'qwen3.5:2b',
      'qwen3.5:0.8b',
      'gemini-3.8-flash',
      'claude-sonnet-5-5',
      'gpt-6-luna',
      'grok-4.7',
      'muse-spark-1.3',
      'glm-5.3-flash',
      'openrouter/auto',
      'mistral-small-latest',
      'deepseek-chat'
    ];
    const datalistOptions = presetModels.map(m => `<option value="${m}"></option>`).join('');

    const modal = document.createElement('div');
    modal.id = 'automod-config-modal';
    modal.className = 'hq-modal-backdrop';
    modal.innerHTML = `
      <div class="hq-modal-dialog">
        <div class="hq-modal-header">
          <div class="hq-modal-title">🛡️ AutoMod Quarantine Settings</div>
          <button type="button" class="hq-close-btn" id="hq-modal-close">&times;</button>
        </div>

        <div class="hq-form-group">
          <label class="hq-form-label">AI Scanning Provider</label>
          <select id="hq-ai-provider" class="hq-select">
            ${providerOptions}
          </select>
        </div>

        <div class="hq-form-group">
          <label class="hq-form-label">API Key / Bearer Token</label>
          <input type="password" id="hq-ai-key" class="hq-input" value="${this._escapeHtml(this._settings.aiApiKey || '')}" placeholder="${this._escapeHtml((this._settings.aiAuth === 'sso' && (AutoModQuarantine.PROVIDERS[this._settings.aiProvider] || {}).ssoPlaceholder) || (AutoModQuarantine.PROVIDERS[this._settings.aiProvider] || {}).placeholder || 'Paste API key or Bearer token')}">
        </div>

        <div class="hq-form-group">
          <label class="hq-toggle-label">
            <input type="checkbox" id="hq-ai-sso" ${this._settings.aiAuth === 'sso' ? 'checked' : ''}>
            <span>Bearer token instead of an API key: a Google Cloud access token for Gemini, an OpenCode Go key, or your own proxy's token.</span>
          </label>
        </div>

        <div class="hq-row">
          <div class="hq-form-group" style="flex:1">
            <label class="hq-form-label">Endpoint URL</label>
            <input type="text" id="hq-ai-endpoint" class="hq-input" value="${this._escapeHtml(this._settings.aiEndpoint || '')}" placeholder="${effective.endpoint}">
          </div>
          <div class="hq-form-group" style="flex:1">
            <label class="hq-form-label">Model Name (Pick or Type Any Model)</label>
            <input type="text" id="hq-ai-model" list="hq-model-presets" class="hq-input" value="${this._escapeHtml(this._settings.aiModel || '')}" placeholder="${effective.model}">
            <datalist id="hq-model-presets">${datalistOptions}</datalist>
          </div>
        </div>

        <div class="hq-form-group" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <button type="button" class="hq-btn-test" id="hq-test-ai-btn">🔌 Test AI Connection</button>
          <button type="button" class="hq-btn-test" id="hq-detect-local-btn">🖥️ Auto-Detect Local AI</button>
          <a href="https://github.com/ancsemi/Haven/blob/main/docs/automod.md" target="_blank" rel="noopener noreferrer" class="hq-btn-test" style="text-decoration:none;display:inline-flex;align-items:center">📖 How It Works</a>
          <span id="hq-test-status" style="margin-left: 4px; font-size: 0.85em;"></span>
        </div>

        <div class="hq-form-group">
          <label class="hq-form-label">Server Rules & Moderation Directive</label>
          <textarea id="hq-server-rules" class="hq-textarea" rows="2">${this._escapeHtml(this._settings.serverRules)}</textarea>
        </div>

        <div class="hq-form-group">
          <label class="hq-toggle-label">
            <input type="checkbox" id="hq-auto-release" ${this._settings.autoReleaseSafe ? 'checked' : ''}>
            <span>Automatically release links verified as safe</span>
          </label>
        </div>

        <div class="hq-form-group">
          <label class="hq-toggle-label">
            <input type="checkbox" id="hq-auto-warn" ${this._settings.autoWarnUsers ? 'checked' : ''}>
            <span>Automatically post a warning in the channel when a link is blocked (sent under your name)</span>
          </label>
        </div>

        <div class="hq-form-group">
          <label class="hq-toggle-label">
            <input type="checkbox" id="hq-unload-after-queue" ${this._settings.unloadModelAfterQueue !== false ? 'checked' : ''}>
            <span>Load on queued links &amp; unload local AI model from GPU/RAM immediately when queue finishes</span>
          </label>
        </div>

        <div class="hq-btn-row">
          <button type="button" class="hab-btn" id="hq-modal-cancel">Cancel</button>
          <button type="button" class="hq-btn-primary" id="hq-modal-save">Save Settings</button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    // Event listeners
    const close = () => modal.remove();
    modal.querySelector('#hq-modal-close').addEventListener('click', close);
    modal.querySelector('#hq-modal-cancel').addEventListener('click', close);

    const providerSelect = modal.querySelector('#hq-ai-provider');
    const endpointInput = modal.querySelector('#hq-ai-endpoint');
    const modelInput = modal.querySelector('#hq-ai-model');
    const keyInput = modal.querySelector('#hq-ai-key');
    const datalistEl = modal.querySelector('#hq-model-presets');

    const ssoInput = modal.querySelector('#hq-ai-sso');
    const applyProviderPlaceholders = () => {
      const meta = AutoModQuarantine.PROVIDERS[providerSelect.value];
      if (!meta) return;
      endpointInput.placeholder = meta.defaultEndpoint;
      modelInput.placeholder = meta.defaultModel;
      keyInput.placeholder = (ssoInput.checked && meta.ssoPlaceholder) || meta.placeholder;
    };
    providerSelect.addEventListener('change', applyProviderPlaceholders);
    ssoInput.addEventListener('change', applyProviderPlaceholders);

    // Populate installed local Ollama models into the model selector datalist without overwriting current form selections
    (async () => {
      const found = await this._autoDetectLocalAi(true);
      if (found && Array.isArray(found.models) && datalistEl) {
        const merged = Array.from(new Set([...found.models, ...presetModels]));
        datalistEl.innerHTML = merged.map(m => `<option value="${this._escapeHtml(m)}"></option>`).join('');
      }
    })().catch(e => console.warn('[AutoMod Quarantine] Could not list local models:', e));

    // Auto-detect local AI button
    modal.querySelector('#hq-detect-local-btn')?.addEventListener('click', async () => {
      const statusEl = modal.querySelector('#hq-test-status');
      statusEl.textContent = 'Scanning local & server AI runtimes...';
      statusEl.style.color = '#38bdf8';
      const found = await this._autoDetectLocalAi(true);
      if (found?.provider) {
        providerSelect.value = found.provider;
        endpointInput.value = found.endpoint;
        modelInput.value = found.model;
        keyInput.value = '';
        ssoInput.checked = false;
        applyProviderPlaceholders();
        if (Array.isArray(found.models) && datalistEl) {
          const merged = Array.from(new Set([...found.models, ...presetModels]));
          datalistEl.innerHTML = merged.map(m => `<option value="${this._escapeHtml(m)}"></option>`).join('');
        }
        found.rules && (modal.querySelector('#hq-server-rules').value = found.rules);
        statusEl.textContent = found.source === 'server' ? `Using this Haven server's local AI (${found.model}) for every moderator.` : `Found Ollama on this device (${found.model}). Other devices can't reach it; run scripts/setup-automod-ai.sh on the Haven server instead.`;
        statusEl.style.color = '#4ade80';
      } else {
        statusEl.textContent = found?.reason || 'No local AI found. Run scripts/setup-automod-ai.sh on the Haven server to set it up.';
        statusEl.style.color = '#f87171';
      }
    });

    // Test connection button
    modal.querySelector('#hq-test-ai-btn').addEventListener('click', async () => {
      const statusEl = modal.querySelector('#hq-test-status');
      statusEl.textContent = 'Testing connection...';
      statusEl.style.color = '#38bdf8';

      // Temporarily stage fields for test
      const prevProvider = this._settings.aiProvider;
      const prevAuth = this._settings.aiAuth;
      const prevKey = this._settings.aiApiKey;
      const prevEndpoint = this._settings.aiEndpoint;
      const prevModel = this._settings.aiModel;

      this._settings.aiProvider = providerSelect.value;
      this._settings.aiAuth = ssoInput.checked ? 'sso' : 'key';
      this._settings.aiApiKey = keyInput.value.trim();
      this._settings.aiEndpoint = endpointInput.value.trim();
      this._settings.aiModel = modelInput.value.trim();

      const testRes = await this.testAiConnection();

      this._settings.aiProvider = prevProvider;
      this._settings.aiAuth = prevAuth;
      this._settings.aiApiKey = prevKey;
      this._settings.aiEndpoint = prevEndpoint;
      this._settings.aiModel = prevModel;

      statusEl.textContent = testRes.message;
      statusEl.style.color = testRes.ok ? '#4ade80' : '#f87171';
    });

    // Save
    modal.querySelector('#hq-modal-save').addEventListener('click', () => {
      this._settings.aiProvider = providerSelect.value;
      this._settings.aiAuth = ssoInput.checked ? 'sso' : 'key';
      this._settings.aiApiKey = keyInput.value.trim();
      this._settings.aiEndpoint = endpointInput.value.trim();
      this._settings.aiModel = modelInput.value.trim();
      this._settings.serverRules = modal.querySelector('#hq-server-rules').value.trim();
      this._settings.autoReleaseSafe = modal.querySelector('#hq-auto-release').checked;
      this._settings.autoWarnUsers = modal.querySelector('#hq-auto-warn').checked;
      this._settings.unloadModelAfterQueue = modal.querySelector('#hq-unload-after-queue').checked;

      this._saveConfig();
      this._settings.aiProvider === 'haven' && typeof HavenApi !== 'undefined' && HavenApi.currentUser?.isAdmin && fetch('/api/automod/rules', { method: 'PUT', headers: { 'Content-Type': 'application/json', ...this._havenAuth() }, body: JSON.stringify({ rules: this._settings.serverRules }) }).catch(e => console.warn('[AutoMod Quarantine] Could not save the rules on the server:', e));
      if (typeof HavenApi !== 'undefined' && HavenApi.UI) {
        HavenApi.UI.showToast('AutoMod settings saved successfully!', 'info');
      }
      close();
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // Helper Utilities
  // ═══════════════════════════════════════════════════════════════════

  _escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  _escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}

// Export for Plugin Loader and Node.js testing
if (typeof _win !== 'undefined') _win.AutoModQuarantine = AutoModQuarantine;
if (typeof module !== 'undefined' && module.exports) module.exports = AutoModQuarantine;
