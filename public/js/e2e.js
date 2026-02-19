/**
 * Haven — End-to-End Encryption for DMs
 *
 * Uses ECDH (P-256) for key agreement + AES-256-GCM for message encryption.
 * Private keys are encrypted with a per-account secret (PBKDF2 wrapping) and
 * stored on the server so they sync across devices. The server never sees the
 * plaintext private key — only the secret-encrypted blob.
 *
 * The e2eSecret is a random 32-byte hex string generated server-side per user.
 * It's sent to the client on every login & socket connection, stored in
 * localStorage, and used as the PBKDF2 passphrase for key wrapping.
 * This ensures keys are portable across devices/browsers without needing
 * the user's password.
 *
 * Local IndexedDB is used as a fast cache; the server is the source of truth.
 */

class HavenE2E {
  constructor() {
    this._db = null;          // IndexedDB handle
    this._keyPair = null;     // { publicKey: CryptoKey, privateKey: CryptoKey }
    this._sharedKeys = {};    // targetUserId → AES-GCM CryptoKey (cache)
    this._publicKeyJwk = null; // Our exported public key (JWK)
    this._ready = false;
    this._needsPassword = false; // true when server has data but can't recover keys without password
    this._keyBackupLost = false; // true when server has public key but NO encrypted backup
  }

  /* ── Lifecycle ──────────────────────────────────────── */

  /**
   * Initialize E2E. Tries IndexedDB first (fast), then server (cross-device).
   * If no key exists anywhere, generates a new pair.
   * @param {Object} socket    - Socket.IO instance
   * @param {string} e2eSecret - Per-account secret for key wrapping (from server)
   * @param {string} password  - User's login password (fallback for migrating old keys)
   */
  async init(socket, e2eSecret, password) {
    try {
      await this._openDB();
      this._needsPassword = false;
      this._keyBackupLost = false;

      // 1. Fast path: try local IndexedDB
      this._keyPair = await this._loadKeyPair();

      if (!this._keyPair && socket) {
        // 2. Cross-device: check server for encrypted key
        const serverData = await this._fetchEncryptedKey(socket);

        if (serverData.encryptedKey && serverData.salt) {
          // Server has an encrypted backup — try e2eSecret first, then password fallback
          let unwrapped = false;

          if (e2eSecret) {
            try {
              const privateJwk = await this._unwrapPrivateKey(e2eSecret, serverData.encryptedKey, serverData.salt);
              this._keyPair = await this._importKeyPair(privateJwk);
              await this._storeKeyPair(this._keyPair);
              unwrapped = true;
              console.log('[E2E] Restored key pair from server (cross-device sync)');
            } catch {
              // e2eSecret didn't work — key may be wrapped with old password
              console.warn('[E2E] e2eSecret unwrap failed, trying password migration…');
            }
          }

          if (!unwrapped && password) {
            try {
              const privateJwk = await this._unwrapPrivateKey(password, serverData.encryptedKey, serverData.salt);
              this._keyPair = await this._importKeyPair(privateJwk);
              await this._storeKeyPair(this._keyPair);
              unwrapped = true;
              console.log('[E2E] Restored key pair using password (migration)');
              // Re-wrap with e2eSecret so future logins don't need the password
              if (e2eSecret && socket) {
                try {
                  await this._uploadEncryptedKey(socket, e2eSecret);
                  console.log('[E2E] Migrated key wrapping from password to e2eSecret');
                } catch (err) {
                  console.warn('[E2E] Migration re-wrap failed:', err.message);
                }
              }
            } catch (err) {
              console.warn('[E2E] Password unwrap also failed:', err.message);
            }
          }

          if (!unwrapped) {
            if (!e2eSecret && !password) {
              console.warn('[E2E] Server has encrypted key but no secret/password — need recovery');
              this._needsPassword = true;
            } else {
              // Both secrets failed — key is unrecoverable, will need reset
              console.warn('[E2E] Could not unwrap key with any available secret');
              this._needsPassword = true;
            }
          }
        } else if (serverData.hasPublicKey) {
          // Server has a public key for us but NO encrypted backup!
          // The backup upload was lost (old race condition bug).
          if (e2eSecret || password) {
            console.warn('[E2E] Server has public key but no backup — auto-resetting keys');
            const secret = e2eSecret || password;
            const reset = await this.resetKeys(socket, secret);
            if (!reset) {
              this._needsPassword = true;
              this._keyBackupLost = true;
            }
          } else {
            console.warn('[E2E] Server has public key but no backup — need secret to reset');
            this._needsPassword = true;
            this._keyBackupLost = true;
          }
        }
        // else: server has neither → truly first-time user (fall through to generate)
      }

      if (!this._keyPair && !this._needsPassword) {
        // 3. No key anywhere — truly first-time user, generate new pair
        this._keyPair = await this._generateKeyPair();
        await this._storeKeyPair(this._keyPair);
        console.log('[E2E] Generated new key pair');
      }

      if (this._keyPair) {
        this._publicKeyJwk = await crypto.subtle.exportKey('jwk', this._keyPair.publicKey);

        // Upload encrypted private key to server for cross-device sync
        const wrappingSecret = e2eSecret || password;
        if (socket && wrappingSecret) {
          try {
            await this._uploadEncryptedKey(socket, wrappingSecret);
            console.log('[E2E] Encrypted key backup stored on server');
          } catch (err) {
            console.warn('[E2E] Failed to upload encrypted key:', err.message);
          }
        }

        this._ready = true;
        console.log('[E2E] Ready — public key loaded');
      } else {
        this._ready = false;
        console.warn('[E2E] Not ready — secret required to recover/reset encryption keys');
      }
    } catch (err) {
      console.error('[E2E] Init failed:', err);
      this._ready = false;
    }
    return this._ready;
  }

  get ready() { return this._ready; }
  get publicKeyJwk() { return this._publicKeyJwk; }
  get needsPassword() { return this._needsPassword; }
  get keyBackupLost() { return this._keyBackupLost || false; }

  /**
   * Retry key recovery with a secret or password (after auto-login failed).
   * If the backup was lost (old race condition bug), generates fresh keys instead.
   * @param {Object} socket    - Socket.IO instance
   * @param {string} secret    - e2eSecret or password for unwrapping
   * @param {string} e2eSecret - If provided, re-wraps with this after successful recovery
   */
  async recoverWithPassword(socket, secret, e2eSecret) {
    if (!secret) return false;

    // If the server backup was lost, we can't recover — reset instead
    if (this._keyBackupLost) {
      return this.resetKeys(socket, e2eSecret || secret);
    }

    try {
      const serverData = await this._fetchEncryptedKey(socket);
      if (!serverData.encryptedKey || !serverData.salt) return false;
      const privateJwk = await this._unwrapPrivateKey(secret, serverData.encryptedKey, serverData.salt);
      this._keyPair = await this._importKeyPair(privateJwk);
      await this._storeKeyPair(this._keyPair);
      this._publicKeyJwk = await crypto.subtle.exportKey('jwk', this._keyPair.publicKey);
      // Re-wrap with e2eSecret (migrates old password-wrapped keys)
      const wrappingSecret = e2eSecret || secret;
      try { await this._uploadEncryptedKey(socket, wrappingSecret); } catch {}
      this._ready = true;
      this._needsPassword = false;
      console.log('[E2E] Key recovered');
      return true;
    } catch (err) {
      console.warn('[E2E] Recovery failed:', err.message);
      return false;
    }
  }

  /**
   * Generate fresh keys, upload backup, and mark as needing force-publish.
   * Used when the encrypted backup was lost and the old key is unrecoverable.
   * Old encrypted messages will become permanently unreadable.
   * @param {Object} socket - Socket.IO instance
   * @param {string} secret - e2eSecret or password for wrapping
   */
  async resetKeys(socket, secret) {
    if (!secret) return false;
    try {
      this._keyPair = await this._generateKeyPair();
      await this._storeKeyPair(this._keyPair);
      this._publicKeyJwk = await crypto.subtle.exportKey('jwk', this._keyPair.publicKey);
      // Upload encrypted backup
      await this._uploadEncryptedKey(socket, secret);
      this._ready = true;
      this._needsPassword = false;
      this._keyBackupLost = false;
      this._forcePublish = true; // Signal to caller that publish needs force=true
      console.log('[E2E] Keys reset successfully');
      return true;
    } catch (err) {
      console.warn('[E2E] Key reset failed:', err.message);
      return false;
    }
  }

  /* ── Encrypt / Decrypt ─────────────────────────────── */

  async encrypt(plaintext, targetUserId, targetPublicKeyJwk) {
    const sharedKey = await this._deriveSharedKey(targetUserId, targetPublicKeyJwk);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(plaintext);
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      sharedKey,
      encoded
    );
    return JSON.stringify({
      v: 1,
      iv: this._bufToBase64(iv),
      ct: this._bufToBase64(new Uint8Array(ciphertext))
    });
  }

  async decrypt(ciphertextJson, partnerUserId, partnerPublicKeyJwk) {
    try {
      const { v, iv, ct } = JSON.parse(ciphertextJson);
      if (v !== 1) return null;
      const sharedKey = await this._deriveSharedKey(partnerUserId, partnerPublicKeyJwk);
      const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: this._base64ToBuf(iv) },
        sharedKey,
        this._base64ToBuf(ct)
      );
      return new TextDecoder().decode(decrypted);
    } catch (err) {
      console.warn(`[E2E] Decrypt failed for partner ${partnerUserId}:`, err.message || err);
      return null;
    }
  }

  static isEncrypted(content) {
    if (!content || content.length < 20) return false;
    try {
      const obj = JSON.parse(content);
      return obj && obj.v === 1 && obj.iv && obj.ct;
    } catch {
      return false;
    }
  }

  /* ── Key Derivation (DM shared secret) ────────────── */

  async _deriveSharedKey(targetUserId, targetPublicKeyJwk) {
    const cacheKey = `${targetUserId}:${targetPublicKeyJwk.x}`;
    if (this._sharedKeys[cacheKey]) return this._sharedKeys[cacheKey];

    const theirPublicKey = await crypto.subtle.importKey(
      'jwk',
      targetPublicKeyJwk,
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      []
    );

    const sharedSecret = await crypto.subtle.deriveBits(
      { name: 'ECDH', public: theirPublicKey },
      this._keyPair.privateKey,
      256
    );

    const rawKey = await crypto.subtle.importKey(
      'raw', sharedSecret, 'HKDF', false, ['deriveKey']
    );

    const aesKey = await crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: new TextEncoder().encode('haven-e2e-dm-v1'),
        info: new TextEncoder().encode('aes-gcm-key')
      },
      rawKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );

    this._sharedKeys[cacheKey] = aesKey;
    return aesKey;
  }

  /* ── Secret-Based Key Wrapping (PBKDF2 + AES-GCM) ──── */

  async _deriveWrappingKey(secret, saltBase64) {
    const salt = this._base64ToBuf(saltBase64);
    const passKey = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      'PBKDF2',
      false,
      ['deriveKey']
    );
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 600000 },
      passKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async _wrapPrivateKey(secret) {
    const privateJwk = await crypto.subtle.exportKey('jwk', this._keyPair.privateKey);
    const salt = crypto.getRandomValues(new Uint8Array(32));
    const saltB64 = this._bufToBase64(salt);
    const wrappingKey = await this._deriveWrappingKey(secret, saltB64);

    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode(JSON.stringify(privateJwk));
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      wrappingKey,
      plaintext
    );

    const combined = new Uint8Array(iv.length + ciphertext.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(ciphertext), iv.length);

    return { encryptedKey: this._bufToBase64(combined), salt: saltB64 };
  }

  async _unwrapPrivateKey(secret, encryptedKeyB64, saltB64) {
    const wrappingKey = await this._deriveWrappingKey(secret, saltB64);
    const combined = this._base64ToBuf(encryptedKeyB64);

    const iv = combined.slice(0, 12);
    const ciphertext = combined.slice(12);

    const plainBytes = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      wrappingKey,
      ciphertext
    );
    return JSON.parse(new TextDecoder().decode(plainBytes));
  }

  async _importKeyPair(privateJwk) {
    const privateKey = await crypto.subtle.importKey(
      'jwk',
      privateJwk,
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveKey', 'deriveBits']
    );
    const pubJwk = { ...privateJwk };
    delete pubJwk.d;
    pubJwk.key_ops = [];
    const publicKey = await crypto.subtle.importKey(
      'jwk',
      pubJwk,
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      []
    );
    return { publicKey, privateKey };
  }

  /* ── Server Communication ─────────────────────────── */

  _fetchEncryptedKey(socket) {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => resolve({ encryptedKey: null, salt: null }), 5000);
      socket.once('encrypted-key-result', (data) => {
        clearTimeout(timeout);
        resolve(data || { encryptedKey: null, salt: null });
      });
      socket.emit('get-encrypted-key');
    });
  }

  /**
   * Re-wrap and upload the private key with a new secret.
   * Call this after a password change if the wrapping secret changes.
   */
  async reWrapKey(socket, newSecret) {
    if (!this._ready || !this._keyPair) return;
    await this._uploadEncryptedKey(socket, newSecret);
  }

  async _uploadEncryptedKey(socket, secret) {
    const { encryptedKey, salt } = await this._wrapPrivateKey(secret);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Upload timeout')), 5000);
      socket.once('encrypted-key-stored', () => { clearTimeout(timeout); resolve(); });
      socket.emit('store-encrypted-key', { encryptedKey, salt });
    });
  }

  /* ── Key Pair Management (IndexedDB cache) ────────── */

  async _generateKeyPair() {
    return crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,    // extractable — needed for password-wrapping & server sync
      ['deriveKey', 'deriveBits']
    );
  }

  _openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('haven_e2e', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('keys')) {
          db.createObjectStore('keys');
        }
      };
      req.onsuccess = () => { this._db = req.result; resolve(); };
      req.onerror = () => reject(req.error);
    });
  }

  _storeKeyPair(keyPair) {
    return new Promise((resolve, reject) => {
      const txn = this._db.transaction('keys', 'readwrite');
      const store = txn.objectStore('keys');
      store.put(keyPair.publicKey, 'publicKey');
      store.put(keyPair.privateKey, 'privateKey');
      txn.oncomplete = () => resolve();
      txn.onerror = () => reject(txn.error);
    });
  }

  _loadKeyPair() {
    return new Promise((resolve, reject) => {
      const txn = this._db.transaction('keys', 'readonly');
      const store = txn.objectStore('keys');
      const pubReq = store.get('publicKey');
      const privReq = store.get('privateKey');
      txn.oncomplete = () => {
        if (pubReq.result && privReq.result) {
          resolve({ publicKey: pubReq.result, privateKey: privReq.result });
        } else {
          resolve(null);
        }
      };
      txn.onerror = () => reject(txn.error);
    });
  }

  /* ── Helpers ───────────────────────────────────────── */

  /**
   * Generate a human-readable safety number from two public keys.
   * Both users will derive the same code (keys are sorted canonically).
   * Format: 12 groups of 5 digits (60 digits total), like Signal.
   */
  async getVerificationCode(myPublicKeyJwk, theirPublicKeyJwk) {
    // Sort keys canonically by their 'x' coordinate so both sides get the same hash
    const keys = [myPublicKeyJwk, theirPublicKeyJwk].sort((a, b) =>
      a.x < b.x ? -1 : a.x > b.x ? 1 : 0
    );
    // Concatenate the raw key material
    const combined = new TextEncoder().encode(
      JSON.stringify(keys[0]) + JSON.stringify(keys[1])
    );
    // SHA-512 → 64 bytes → 12 groups of 5 digits (60 digits total)
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-512', combined));
    let code = '';
    for (let i = 0; i < 60; i += 5) {
      // Each group: 5 bytes → 5-digit number (mod 100000, zero-padded)
      const num = ((hash[i] << 24) | (hash[i+1] << 16) | (hash[i+2] << 8) | hash[i+3]) >>> 0;
      const group = String(num % 100000).padStart(5, '0');
      code += (code ? ' ' : '') + group;
    }
    return code;
  }

  _bufToBase64(buf) {
    let binary = '';
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  _base64ToBuf(b64) {
    const binary = atob(b64);
    const buf = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
    return buf;
  }
}

// Singleton
window.HavenE2E = HavenE2E;
