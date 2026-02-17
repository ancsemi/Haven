/**
 * Haven — End-to-End Encryption for DMs
 *
 * Uses ECDH (P-256) for key agreement + AES-256-GCM for message encryption.
 * Private keys are encrypted with the user's password (PBKDF2 wrapping) and
 * stored on the server so they sync across devices. The server never sees the
 * plaintext private key — only the password-encrypted blob.
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
  }

  /* ── Lifecycle ──────────────────────────────────────── */

  /**
   * Initialize E2E. Tries IndexedDB first (fast), then server (cross-device).
   * If no key exists anywhere, generates a new pair.
   * @param {Object} socket   - Socket.IO instance
   * @param {string} password - User's login password (for wrapping/unwrapping)
   */
  async init(socket, password) {
    try {
      await this._openDB();

      // 1. Fast path: try local IndexedDB
      this._keyPair = await this._loadKeyPair();

      if (!this._keyPair && socket && password) {
        // 2. Cross-device: check server for password-encrypted key
        const serverData = await this._fetchEncryptedKey(socket);
        if (serverData.encryptedKey && serverData.salt) {
          try {
            const privateJwk = await this._unwrapPrivateKey(password, serverData.encryptedKey, serverData.salt);
            this._keyPair = await this._importKeyPair(privateJwk);
            await this._storeKeyPair(this._keyPair);
            console.log('[E2E] Restored key pair from server (cross-device sync)');
          } catch (err) {
            console.warn('[E2E] Failed to decrypt server key (password may have changed):', err.message);
          }
        }
      }

      if (!this._keyPair) {
        // 3. Generate brand-new key pair
        this._keyPair = await this._generateKeyPair();
        await this._storeKeyPair(this._keyPair);
        console.log('[E2E] Generated new key pair');
      }

      this._publicKeyJwk = await crypto.subtle.exportKey('jwk', this._keyPair.publicKey);

      // Upload encrypted private key to server for cross-device sync
      if (socket && password) {
        try {
          await this._uploadEncryptedKey(socket, password);
        } catch (err) {
          console.warn('[E2E] Failed to upload encrypted key:', err.message);
        }
      }

      this._ready = true;
      console.log('[E2E] Ready — public key loaded');
    } catch (err) {
      console.error('[E2E] Init failed:', err);
      this._ready = false;
    }
    return this._ready;
  }

  get ready() { return this._ready; }
  get publicKeyJwk() { return this._publicKeyJwk; }

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
    } catch {
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

  /* ── Password-Based Key Wrapping (PBKDF2 + AES-GCM) ── */

  async _deriveWrappingKey(password, saltBase64) {
    const salt = this._base64ToBuf(saltBase64);
    const passKey = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(password),
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

  async _wrapPrivateKey(password) {
    const privateJwk = await crypto.subtle.exportKey('jwk', this._keyPair.privateKey);
    const salt = crypto.getRandomValues(new Uint8Array(32));
    const saltB64 = this._bufToBase64(salt);
    const wrappingKey = await this._deriveWrappingKey(password, saltB64);

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

  async _unwrapPrivateKey(password, encryptedKeyB64, saltB64) {
    const wrappingKey = await this._deriveWrappingKey(password, saltB64);
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

  async _uploadEncryptedKey(socket, password) {
    const { encryptedKey, salt } = await this._wrapPrivateKey(password);
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
    // SHA-256 → take first 30 bytes → convert to decimal groups
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', combined));
    let code = '';
    for (let i = 0; i < 30; i += 5) {
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
