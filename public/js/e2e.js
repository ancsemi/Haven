/**
 * Haven — End-to-End Encryption for DMs (v3 — True E2E)
 *
 * Crypto: ECDH P-256 key agreement → HKDF-SHA256 → AES-256-GCM
 *
 * Architecture:
 *   - Each user has an ECDH key pair generated in the browser.
 *   - The private key is wrapped (PBKDF2 + AES-GCM) with a key derived
 *     from the user's PASSWORD (never sent to the server as a wrapping key).
 *   - The server stores only the encrypted blob — it cannot decrypt.
 *   - Local IndexedDB caches the key pair for fast startup.
 *   - On login the password is available → wrapping key is derived client-side.
 *   - On auto-login (JWT, no password) IndexedDB provides the cached key pair.
 *   - DM messages are encrypted with a shared secret derived from both users'
 *     public keys via ECDH + HKDF. The server never sees plaintext.
 *
 * Init flow:  IndexedDB → server backup (unwrap with password-key) → generate new
 * If unwrap fails, keys are auto-reset (clean break over stale state).
 */

class HavenE2E {
  constructor() {
    this._db = null;
    this._keyPair = null;
    this._publicKeyJwk = null;
    this._sharedKeys = {};     // "userId:x" → CryptoKey
    this._ready = false;
    this._keysWereReset = false; // true when init generated fresh keys over existing server data
    this._serverBackupExists = false; // true if server has an encrypted backup (even if unwrap failed)
    this._freshlyGenerated = false; // true when init just generated new keys (triggers backup upload)
  }

  /* ─── Public getters ──────────────────────────────── */

  get ready()          { return this._ready; }
  get publicKeyJwk()   { return this._publicKeyJwk; }
  get keysWereReset()  { return this._keysWereReset; }

  /* ─── Lifecycle ───────────────────────────────────── */

  /**
   * Derive a wrapping key from the user's password.
   * This is a one-way derivation — password cannot be recovered from the result.
   * Uses PBKDF2 with a fixed domain-separation salt (the final wrap adds a random salt).
   * @param  {string} password - The user's plaintext password
   * @return {Promise<string>} 64-char hex string
   */
  static async deriveWrappingKey(password) {
    const enc = new TextEncoder();
    const raw = await crypto.subtle.importKey(
      'raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']
    );
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode('haven-e2e-wrapping-v3'), iterations: 210_000 },
      raw, 256
    );
    return Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Initialise E2E. Resolves true if the key pair is usable.
   * @param {Object}      socket     - Socket.IO instance
   * @param {string|null} wrappingKey - Hex key derived from the user's password.
   *                                    Null on auto-login (IndexedDB-only mode).
   */
  async init(socket, wrappingKey) {
    try {
      await this._openDB();
      this._keysWereReset = false;
      this._serverBackupExists = false;
      this._serverBackupState = 'unknown';  // 'present' | 'none' | 'unknown'
      this._divergent = false;              // local pub != server pub
      this._ghostState = false;             // init aborted to protect a possibly-good server backup

      /* 1. Fast path — local IndexedDB */
      this._keyPair = await this._loadLocal();

      /* 1b. If loaded from IndexedDB, probe server state explicitly.
       *     Three outcomes:
       *       present — verify local pub matches server pub; flag divergence if not
       *       none    — server actually has no backup; re-upload ours
       *       unknown — request timed out; do NOT mutate server state */
      if (this._keyPair && socket && wrappingKey) {
        const probe = await this._fetchBackupWithState(socket);
        this._serverBackupState = probe.status;
        if (probe.status === 'present') {
          this._serverBackupExists = true;
          try {
            const localPub = await crypto.subtle.exportKey('jwk', this._keyPair.publicKey);
            if (probe.serverPublicKey && localPub && probe.serverPublicKey.x && localPub.x && probe.serverPublicKey.x !== localPub.x) {
              this._divergent = true;
              console.warn('[E2E] Local key diverges from server backup — awaiting user action');
            }
          } catch { /* best-effort divergence check */ }
        } else if (probe.status === 'none') {
          // Server confirmed empty — safe to re-upload our local key
          try { await this._uploadBackup(socket, wrappingKey); this._serverBackupExists = true; }
          catch (err) { console.warn('[E2E] Re-upload after recovery failed:', err.message); }
        } else {
          // probe.status === 'unknown' — flaky network. Do NOT upload; it would
          // clobber whatever the server actually has.
          console.warn('[E2E] Could not reach server for backup probe — skipping re-upload to avoid clobber');
        }
      }

      /* 2. Cross-device — try server backup (only if we have a wrapping key) */
      if (!this._keyPair && socket && wrappingKey) {
        const restored = await this._restoreFromServerWithState(socket, wrappingKey);
        this._keyPair = restored.pair;
        this._serverBackupState = restored.status;
        if (restored.status === 'present') this._serverBackupExists = true;
      }

      /* 3. No key anywhere — generate ONLY if we affirmatively confirmed the
       *    server has no backup. On 'unknown' we bail out entirely: generating
       *    a fresh key here and uploading would clobber a potentially-good
       *    backup once the network comes back. A 5-min cooldown prevents
       *    flap-regenerate storms across reconnects. */
      if (!this._keyPair && wrappingKey) {
        if (this._serverBackupState !== 'none') {
          this._ghostState = true;
          console.warn('[E2E] Server state ' + this._serverBackupState + ' — refusing to generate keys (would risk clobber)');
          this._ready = false;
          return false;
        }
        if (!(await this._canAttemptGenerate())) {
          this._ghostState = true;
          console.warn('[E2E] Regenerate cooldown active — refusing to mint new keypair');
          this._ready = false;
          return false;
        }
        this._keyPair = await this._generate();
        await this._saveLocal(this._keyPair);
        await this._markGenerateAttempt();
        this._freshlyGenerated = true;
        console.log('[E2E] Generated new key pair (first-time setup, server confirmed empty)');
      }

      /* 4. Auto-login without IndexedDB — E2E unavailable until real login */
      if (!this._keyPair) {
        if (this._serverBackupExists) {
          console.warn('[E2E] Server backup exists but could not be decrypted — password may be wrong');
        } else {
          console.warn('[E2E] No key pair available — login with password to unlock E2E');
        }
        this._ready = false;
        return false;
      }

      this._publicKeyJwk = await crypto.subtle.exportKey('jwk', this._keyPair.publicKey);

      /* Upload encrypted backup so other devices can sync.
       * Only upload when we just GENERATED a new key (first-time setup).
       * Do NOT upload when loaded from IndexedDB — the server backup may
       * contain a NEWER key from another device, and overwriting it would
       * break cross-device sync and cause infinite conflict loops. */
      if (socket && wrappingKey && this._freshlyGenerated) {
        try { await this._uploadBackup(socket, wrappingKey); }
        catch (err) { console.warn('[E2E] Backup upload failed:', err.message); }
        this._freshlyGenerated = false;
      }

      this._ready = true;
      console.log('[E2E] Ready');
      return true;
    } catch (err) {
      console.error('[E2E] Init failed:', err);
      this._ready = false;
      return false;
    }
  }

  /** True if local and server backups disagree on the public key. UI can prompt user to sync or reset. */
  get divergent() { return !!this._divergent; }

  /** True if init bailed out to protect a possibly-good server backup. UI should prompt for action. */
  get ghostState() { return !!this._ghostState; }

  /** Last observed server backup state: 'present' | 'none' | 'unknown'. */
  get serverBackupState() { return this._serverBackupState || 'unknown'; }

  /**
   * Generate fresh keys, upload backup, publish to server.
   * Old encrypted messages become permanently unreadable.
   */
  async resetKeys(socket, wrappingKey) {
    if (!wrappingKey) return false;
    try {
      this._sharedKeys = {};
      this._keyPair = await this._generate();
      await this._saveLocal(this._keyPair);
      this._publicKeyJwk = await crypto.subtle.exportKey('jwk', this._keyPair.publicKey);
      await this._uploadBackup(socket, wrappingKey);
      this._ready = true;
      this._keysWereReset = true;
      console.log('[E2E] Keys reset');
      return true;
    } catch (err) {
      console.warn('[E2E] Reset failed:', err.message);
      return false;
    }
  }

  /**
   * Re-wrap and upload the private key with a new wrapping key.
   * Call after password change (derive new key from new password).
   */
  async reWrapKey(socket, newWrappingKey) {
    if (!this._ready || !this._keyPair) return;
    await this._uploadBackup(socket, newWrappingKey);
  }

  /**
   * Invalidate the cached shared secret for a partner whose key changed.
   */
  clearSharedKey(userId) {
    this._sharedKeys = Object.fromEntries(
      Object.entries(this._sharedKeys).filter(([k]) => !k.startsWith(userId + ':'))
    );
  }

  /* ─── Encrypt / Decrypt ───────────────────────────── */

  async encrypt(plaintext, partnerId, partnerJwk) {
    if (!this._ready) throw new Error('E2E not ready');
    const key = await this._deriveShared(partnerId, partnerJwk);
    const iv  = crypto.getRandomValues(new Uint8Array(12));
    const ct  = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      new TextEncoder().encode(plaintext)
    );
    return JSON.stringify({
      v: 2,
      iv: this._toB64(iv),
      ct: this._toB64(new Uint8Array(ct))
    });
  }

  /** Encrypt raw bytes (e.g. image data). Returns Uint8Array: [12-byte IV][ciphertext]. */
  async encryptBytes(arrayBuffer, partnerId, partnerJwk) {
    if (!this._ready) throw new Error('E2E not ready');
    const key = await this._deriveShared(partnerId, partnerJwk);
    const iv  = crypto.getRandomValues(new Uint8Array(12));
    const ct  = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, arrayBuffer);
    const out = new Uint8Array(12 + ct.byteLength);
    out.set(iv, 0);
    out.set(new Uint8Array(ct), 12);
    return out;
  }

  /** Decrypt raw bytes produced by encryptBytes. Returns ArrayBuffer. */
  async decryptBytes(encData, partnerId, partnerJwk) {
    const key = await this._deriveShared(partnerId, partnerJwk);
    const iv  = encData.slice(0, 12);
    const ct  = encData.slice(12);
    return crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  }

  async decrypt(json, partnerId, partnerJwk) {
    try {
      const { v, iv, ct } = JSON.parse(json);
      if (v !== 1 && v !== 2) return null;   // accept v1 (legacy) and v2
      const key = await this._deriveShared(partnerId, partnerJwk);
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: this._fromB64(iv) },
        key,
        this._fromB64(ct)
      );
      return new TextDecoder().decode(plain);
    } catch {
      return null;
    }
  }

  static isEncrypted(content) {
    if (!content || content.length < 20) return false;
    try {
      const o = JSON.parse(content);
      return o && (o.v === 1 || o.v === 2) && o.iv && o.ct;
    } catch { return false; }
  }

  /* ─── Verification ────────────────────────────────── */

  /**
   * Derive a human-readable safety number from two public JWKs.
   * Both users get the same code (keys sorted canonically by 'x').
   * Format: 12 groups of 5 digits (60 digits), Signal-style.
   */
  async getVerificationCode(myJwk, theirJwk) {
    const sorted = [myJwk, theirJwk].sort((a, b) => (a.x < b.x ? -1 : a.x > b.x ? 1 : 0));
    // Normalize to only the essential fields in a fixed order so that local keys
    // (which may carry 'ext', 'key_ops', etc.) and server-fetched keys (plain JSON)
    // produce identical strings — and therefore identical safety numbers.
    const normalize = jwk => ({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y });
    const data = new TextEncoder().encode(JSON.stringify(normalize(sorted[0])) + JSON.stringify(normalize(sorted[1])));
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
    // 32 bytes → 12 groups (3 bytes each = 36 bytes, but we XOR-fold excess)
    // Use first 30 bytes directly → 10 groups, then fold remaining 2 bytes
    // Simpler: take 4 bytes per group from SHA-512
    const hash512 = new Uint8Array(await crypto.subtle.digest('SHA-512', data));
    let code = '';
    for (let g = 0; g < 12; g++) {
      const off = g * 4;
      const num = ((hash512[off] << 24) | (hash512[off + 1] << 16) |
                   (hash512[off + 2] << 8) | hash512[off + 3]) >>> 0;
      code += (code ? ' ' : '') + String(num % 100000).padStart(5, '0');
    }
    return code;
  }

  /* ─── ECDH shared secret derivation ───────────────── */

  async _deriveShared(partnerId, partnerJwk) {
    const cacheKey = `${partnerId}:${partnerJwk.x}`;
    if (this._sharedKeys[cacheKey]) return this._sharedKeys[cacheKey];

    const theirKey = await crypto.subtle.importKey(
      'jwk', partnerJwk,
      { name: 'ECDH', namedCurve: 'P-256' },
      false, []
    );
    const bits = await crypto.subtle.deriveBits(
      { name: 'ECDH', public: theirKey },
      this._keyPair.privateKey,
      256
    );
    const hkdfKey = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
    const aes = await crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: new TextEncoder().encode('haven-e2e-dm-v1'),
        info: new TextEncoder().encode('aes-gcm-key')
      },
      hkdfKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
    this._sharedKeys[cacheKey] = aes;
    return aes;
  }

  /* ─── Key wrapping (PBKDF2 + AES-GCM) ────────────── */

  async _deriveWrappingKey(secret, salt) {
    const raw = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(secret), 'PBKDF2', false, ['deriveKey']
    );
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 600_000 },
      raw,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async _wrap(secret) {
    const jwk = await crypto.subtle.exportKey('jwk', this._keyPair.privateKey);
    const salt = crypto.getRandomValues(new Uint8Array(32));
    const wk = await this._deriveWrappingKey(secret, salt);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv }, wk,
      new TextEncoder().encode(JSON.stringify(jwk))
    );
    const blob = new Uint8Array(12 + ct.byteLength);
    blob.set(iv, 0);
    blob.set(new Uint8Array(ct), 12);
    return { encryptedKey: this._toB64(blob), salt: this._toB64(salt) };
  }

  async _unwrap(secret, encB64, saltB64) {
    const wk = await this._deriveWrappingKey(secret, this._fromB64(saltB64));
    const blob = this._fromB64(encB64);
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: blob.slice(0, 12) },
      wk,
      blob.slice(12)
    );
    return JSON.parse(new TextDecoder().decode(plain));
  }

  async _importPair(privJwk) {
    const priv = await crypto.subtle.importKey(
      'jwk', privJwk,
      { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']
    );
    const pubJwk = { ...privJwk, key_ops: [] };
    delete pubJwk.d;
    const pub = await crypto.subtle.importKey(
      'jwk', pubJwk,
      { name: 'ECDH', namedCurve: 'P-256' }, true, []
    );
    return { publicKey: pub, privateKey: priv };
  }

  /* ─── Server communication ────────────────────────── */

  _fetchBackup(socket) {
    return this._fetchBackupWithState(socket).then(r => r.status === 'present' ? r.data : null);
  }

  /**
   * Fetch encrypted key backup with explicit status tracking.
   * Returns { status, data, serverPublicKey }:
   *   status = 'present' — server returned a backup blob
   *   status = 'none'    — server confirmed there is no backup (safe to generate)
   *   status = 'unknown' — request timed out or errored (do NOT treat as empty)
   * Retries once before giving up, so transient network blips aren't treated as "no backup".
   * This distinction is load-bearing: the previous 5s-timeout-returns-null design
   * conflated "confirmed empty" with "unreachable", which could let the client
   * overwrite a good server backup after flaky mobile reconnects.
   */
  _fetchBackupWithState(socket) {
    const TIMEOUT = 15000;
    const attempt = () => new Promise(resolve => {
      let done = false;
      const t = setTimeout(() => {
        if (done) return;
        done = true;
        resolve({ status: 'unknown', data: null, serverPublicKey: null });
      }, TIMEOUT);
      socket.once('encrypted-key-result', data => {
        if (done) return;
        done = true;
        clearTimeout(t);
        const hasBlob = data && data.encryptedKey && data.salt;
        if (hasBlob) {
          resolve({ status: 'present', data, serverPublicKey: data.publicKey || null });
        } else if (data && (data.state === 'empty' || (data.state === undefined && data.hasPublicKey === false))) {
          // Server-confirmed empty. Legacy servers (no `state` field) fall back to
          // the hasPublicKey heuristic: if the user has no public key either, the
          // account is truly fresh.
          resolve({ status: 'none', data: null, serverPublicKey: null });
        } else if (data && data.state === 'empty') {
          resolve({ status: 'none', data: null, serverPublicKey: null });
        } else {
          // Legacy server returned null blob but has a public key — ambiguous.
          // Treat as unknown to be safe; we'd rather retry than risk a clobber.
          resolve({ status: 'unknown', data: null, serverPublicKey: null });
        }
      });
      socket.emit('get-encrypted-key');
    });
    return attempt().then(first => {
      if (first.status !== 'unknown') return first;
      console.warn('[E2E] Backup fetch timed out, retrying once');
      return attempt();
    });
  }

  async _uploadBackup(socket, secret) {
    const { encryptedKey, salt } = await this._wrap(secret);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Upload timeout')), 5000);
      socket.once('encrypted-key-stored', () => { clearTimeout(t); resolve(); });
      socket.emit('store-encrypted-key', { encryptedKey, salt });
    });
  }

  /**
   * Publish our public key to the server.
   * @param {Object}  socket
   * @param {boolean} force - Overwrite even if server has a different key
   */
  publishKey(socket, force = false) {
    return new Promise(resolve => {
      const t = setTimeout(() => resolve({ ok: false, conflict: false }), 5000);
      socket.once('public-key-published', () => {
        clearTimeout(t);
        resolve({ ok: true, conflict: false });
      });
      socket.once('public-key-conflict', (data) => {
        clearTimeout(t);
        if (force) {
          // Explicit key reset — overwrite server key
          socket.emit('publish-public-key', { jwk: this._publicKeyJwk, force: true });
          resolve({ ok: true, conflict: false });
        } else {
          // Server has a different key — don't auto-overwrite.
          // Return conflict so the caller can decide (sync from server, prompt user, etc.)
          console.warn('[E2E] Public key conflict — server has a different key');
          resolve({ ok: false, conflict: true, serverKey: data?.existing || null });
        }
      });
      socket.emit('publish-public-key', { jwk: this._publicKeyJwk, force });
    });
  }

  /**
   * Request a partner's public key from the server.
   * Returns a promise that resolves with the JWK or null.
   */
  requestPartnerKey(socket, userId) {
    return new Promise(resolve => {
      const t = setTimeout(() => resolve(null), 5000);
      const handler = (data) => {
        if (data.userId === userId) {
          clearTimeout(t);
          socket.off('public-key-result', handler);
          resolve(data.jwk || null);
        }
      };
      socket.on('public-key-result', handler);
      socket.emit('get-public-key', { userId });
    });
  }

  /* ─── Server restore helper ───────────────────────── */

  async _restoreFromServer(socket, secret) {
    const r = await this._restoreFromServerWithState(socket, secret);
    return r.pair;
  }

  /**
   * Restore with status awareness. Returns { pair, status }:
   *   status = 'present' — backup found (pair may still be null if unwrap failed)
   *   status = 'none'    — server confirmed empty; caller may generate fresh keys
   *   status = 'unknown' — network issue; caller MUST NOT overwrite server state
   */
  async _restoreFromServerWithState(socket, secret) {
    const probe = await this._fetchBackupWithState(socket);
    if (probe.status !== 'present') return { pair: null, status: probe.status };
    this._serverBackupExists = true;
    try {
      const jwk = await this._unwrap(secret, probe.data.encryptedKey, probe.data.salt);
      const pair = await this._importPair(jwk);
      await this._saveLocal(pair);
      console.log('[E2E] Restored from server backup');
      return { pair, status: 'present' };
    } catch {
      console.warn('[E2E] Server backup unwrap failed — keys NOT auto-regenerated to protect other devices');
      return { pair: null, status: 'present' };
    }
  }

  /* ─── Regenerate cooldown ─────────────────────────── */

  _cooldownGet() {
    return new Promise(resolve => {
      try {
        const tx = this._db.transaction('keys', 'readonly');
        const r = tx.objectStore('keys').get('last_generate_attempt');
        tx.oncomplete = () => resolve(typeof r.result === 'number' ? r.result : 0);
        tx.onerror = () => resolve(0);
      } catch { resolve(0); }
    });
  }

  _cooldownSet(val) {
    return new Promise(resolve => {
      try {
        const tx = this._db.transaction('keys', 'readwrite');
        const s = tx.objectStore('keys');
        if (val === null) s.delete('last_generate_attempt');
        else s.put(val, 'last_generate_attempt');
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch { resolve(); }
    });
  }

  async _canAttemptGenerate() {
    const last = await this._cooldownGet();
    if (!last) return true;
    return Date.now() - last >= 5 * 60 * 1000;
  }

  async _markGenerateAttempt() { await this._cooldownSet(Date.now()); }

  /** Clear the regenerate cooldown (e.g. on explicit user-driven reset). */
  async clearGenerateCooldown() { await this._cooldownSet(null); }

  /**
   * Sync keys from the server backup (clears local keys first).
   * Used when another device changed the key and this device needs to catch up.
   */
  async syncFromServer(socket, wrappingKey) {
    if (!wrappingKey) return false;
    try {
      await this._openDB();
      // Clear stale local keys before restoring
      await this._clearLocal();
      this._keyPair = null;
      this._publicKeyJwk = null;
      this._sharedKeys = {};

      const backup = await this._fetchBackup(socket);
      if (!backup) {
        console.warn('[E2E] No server backup to sync from');
        return false;
      }

      const jwk = await this._unwrap(wrappingKey, backup.encryptedKey, backup.salt);
      this._keyPair = await this._importPair(jwk);
      await this._saveLocal(this._keyPair);
      this._publicKeyJwk = await crypto.subtle.exportKey('jwk', this._keyPair.publicKey);
      this._ready = true;
      console.log('[E2E] Synced keys from server backup');
      return true;
    } catch (err) {
      console.warn('[E2E] Sync from server failed:', err.message);
      return false;
    }
  }

  /**
   * Clear local IndexedDB keys.
   */
  _clearLocal() {
    return new Promise((resolve, reject) => {
      const tx = this._db.transaction('keys', 'readwrite');
      const s  = tx.objectStore('keys');
      s.delete('pub');
      s.delete('priv');
      tx.oncomplete = () => resolve();
      tx.onerror    = () => reject(tx.error);
    });
  }

  /* ─── IndexedDB cache ─────────────────────────────── */

  async _generate() {
    return crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true, ['deriveKey', 'deriveBits']
    );
  }

  _openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('haven_e2e', 2);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('keys')) db.createObjectStore('keys');
      };
      req.onsuccess = () => { this._db = req.result; resolve(); };
      req.onerror  = () => reject(req.error);
    });
  }

  _saveLocal(pair) {
    return new Promise((resolve, reject) => {
      const tx = this._db.transaction('keys', 'readwrite');
      const s  = tx.objectStore('keys');
      s.put(pair.publicKey, 'pub');
      s.put(pair.privateKey, 'priv');
      tx.oncomplete = () => resolve();
      tx.onerror    = () => reject(tx.error);
    });
  }

  _loadLocal() {
    return new Promise((resolve, reject) => {
      const tx = this._db.transaction('keys', 'readonly');
      const s  = tx.objectStore('keys');
      const a  = s.get('pub');
      const b  = s.get('priv');
      tx.oncomplete = () => resolve(a.result && b.result ? { publicKey: a.result, privateKey: b.result } : null);
      tx.onerror    = () => reject(tx.error);
    });
  }

  /* ─── Base64 helpers ──────────────────────────────── */

  _toB64(buf) {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  _fromB64(b64) {
    const bin = atob(b64);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    return buf;
  }
}

window.HavenE2E = HavenE2E;
