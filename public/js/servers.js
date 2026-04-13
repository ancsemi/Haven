// ═══════════════════════════════════════════════════════════
// Haven — Multi-Server Manager
// See other Haven servers in your sidebar with live status
// ═══════════════════════════════════════════════════════════

class ServerManager {
  constructor() {
    this.servers = this._load();
    this.statusCache = new Map();
    this.checkInterval = null;
  }

  _load() {
    try {
      return JSON.parse(localStorage.getItem('haven_servers') || '[]');
    } catch { return []; }
  }

  _save() {
    localStorage.setItem('haven_servers', JSON.stringify(this.servers));
  }

  add(name, url, icon = null) {
    url = url.replace(/\/+$/, '');
    if (!/^https?:\/\//.test(url)) url = 'https://' + url;
    if (this.servers.find(s => s.url === url)) return false;

    this.servers.push({ name, url, icon, addedAt: Date.now() });
    this._save();
    this.checkServer(url);
    return true;
  }

  update(url, updates) {
    const server = this.servers.find(s => s.url === url);
    if (!server) return false;
    if (updates.name !== undefined) server.name = updates.name;
    if (updates.icon !== undefined) server.icon = updates.icon;
    this._save();
    return true;
  }

  remove(url) {
    this.servers = this.servers.filter(s => s.url !== url);
    this.statusCache.delete(url);
    this._save();
  }

  getAll() {
    return this.servers.map(s => ({
      ...s,
      status: this.statusCache.get(s.url) || { online: null, name: s.name }
    }));
  }

  async checkServer(url) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      // Use only the origin for health checks — if someone stored a URL
      // like https://example.com/app, we don't want /app/api/health (404).
      let healthBase;
      try { healthBase = new URL(url).origin; } catch { healthBase = url; }

      const res = await fetch(`${healthBase}/api/health`, {
        signal: controller.signal,
        mode: 'cors'
      });
      clearTimeout(timeout);

      if (res.ok) {
        const data = await res.json();
        const discoveredIcon = data.icon ? `${url}${data.icon}` : null;
        this.statusCache.set(url, {
          online: true,
          name: data.name || url,
          icon: discoveredIcon,
          version: data.version,
          checkedAt: Date.now()
        });
        // Persist discovered icon to the server entry so it survives
        // across page reloads and offline periods
        if (discoveredIcon) {
          const entry = this.servers.find(s => s.url === url);
          if (entry && !entry.icon) {
            entry.icon = discoveredIcon;
            this._save();
          }
        }
      } else {
        this.statusCache.set(url, { online: false, checkedAt: Date.now() });
      }
    } catch {
      this.statusCache.set(url, { online: false, checkedAt: Date.now() });
    }
  }

  async checkAll() {
    await Promise.allSettled(this.servers.map(s => this.checkServer(s.url)));
  }

  startPolling(intervalMs = 30000) {
    this.checkAll();
    this.checkInterval = setInterval(() => this.checkAll(), intervalMs);
  }

  stopPolling() {
    if (this.checkInterval) clearInterval(this.checkInterval);
  }

  // ── Encrypted server-side sync ───────────────────────
  // Stores the server list as an AES-256-GCM blob on each Haven server.
  // wrappingHex: the 64-char hex string from HavenE2E.deriveWrappingKey()

  async syncWithServer(token, wrappingHex) {
    if (!token || !wrappingHex) return;
    try {
      // 1. Fetch the encrypted blob from the server
      const res = await fetch('/api/auth/user-servers', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!res.ok) return;
      const { blob } = await res.json();

      // 2. Decrypt server-side list (if any)
      let remoteServers = [];
      if (blob) {
        try {
          const decrypted = await this._decryptBlob(blob, wrappingHex);
          remoteServers = JSON.parse(decrypted);
          if (!Array.isArray(remoteServers)) remoteServers = [];
        } catch {
          // Decryption failed — blob was encrypted with a different password
          // or is corrupted. Start fresh from localStorage.
          console.warn('[ServerSync] Could not decrypt server blob — using local list');
        }
      }

      // 3. Load removed-servers set (removals are local-only, never synced)
      const removed = this._loadRemoved();

      // 4. Merge: union by URL, filtering out locally-removed servers
      const localUrls = new Set(this.servers.map(s => s.url));
      const remoteUrls = new Set(remoteServers.map(s => s.url));
      let changed = false;

      // Add remote servers we don't have locally (and haven't removed)
      for (const rs of remoteServers) {
        if (!localUrls.has(rs.url) && !removed.has(rs.url)) {
          this.servers.push(rs);
          changed = true;
        }
      }

      // Check if we have servers the remote doesn't
      for (const ls of this.servers) {
        if (!remoteUrls.has(ls.url)) changed = true;
      }

      // 5. Save merged list locally
      if (changed) this._save();

      // 6. Push updated encrypted blob back if our list is longer
      if (changed || !blob) {
        await this._pushToServer(token, wrappingHex);
      }
    } catch (err) {
      console.warn('[ServerSync] Sync failed:', err.message);
    }
  }

  async _pushToServer(token, wrappingHex) {
    try {
      const payload = JSON.stringify(this.servers.map(s => ({
        url: s.url, name: s.name, icon: s.icon, addedAt: s.addedAt
      })));
      const blob = await this._encryptBlob(payload, wrappingHex);
      await fetch('/api/auth/user-servers', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ blob })
      });
    } catch (err) {
      console.warn('[ServerSync] Push failed:', err.message);
    }
  }

  // ── Crypto helpers (AES-256-GCM with PBKDF2) ─────────

  async _encryptBlob(plaintext, wrappingHex) {
    const keyBytes = this._hexToBytes(wrappingHex);
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await this._deriveAESKey(keyBytes, salt);
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      new TextEncoder().encode(plaintext)
    );
    // Format: base64(salt + iv + ciphertext)
    const combined = new Uint8Array(16 + 12 + ct.byteLength);
    combined.set(salt, 0);
    combined.set(iv, 16);
    combined.set(new Uint8Array(ct), 28);
    return btoa(String.fromCharCode(...combined));
  }

  async _decryptBlob(blob, wrappingHex) {
    const keyBytes = this._hexToBytes(wrappingHex);
    const raw = Uint8Array.from(atob(blob), c => c.charCodeAt(0));
    const salt = raw.slice(0, 16);
    const iv = raw.slice(16, 28);
    const ct = raw.slice(28);
    const key = await this._deriveAESKey(keyBytes, salt);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    return new TextDecoder().decode(pt);
  }

  async _deriveAESKey(keyBytes, salt) {
    const raw = await crypto.subtle.importKey('raw', keyBytes, 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100_000 },
      raw,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  _hexToBytes(hex) {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
      bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
    }
    return bytes;
  }

  // ── Removed-servers tracking (local-only) ─────────────

  _loadRemoved() {
    try {
      return new Set(JSON.parse(localStorage.getItem('haven_servers_removed') || '[]'));
    } catch { return new Set(); }
  }

  _saveRemoved(set) {
    localStorage.setItem('haven_servers_removed', JSON.stringify([...set]));
  }

  markRemoved(url) {
    const removed = this._loadRemoved();
    removed.add(url);
    this._saveRemoved(removed);
  }
}
