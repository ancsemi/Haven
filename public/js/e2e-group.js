/**
 * Haven — group DM crypto primitives (v1)
 *
 * Deliberately free of storage, sockets and DOM so the same file runs in the
 * browser and under `node --test`. All state is passed in; nothing is cached
 * here. `HavenE2E` owns key management and calls into this.
 *
 * Design: docs/group-dm-e2e-plan.md
 *
 *   confidentiality  epoch key, AES-256-GCM, wrapped per member over the
 *                    existing pairwise ECDH secret
 *   authenticity     ECDSA P-256 signature per message, over a digest that
 *                    binds channel, epoch, sender and the previous message
 *   integrity of the
 *   transcript       `prev` chains each message to the one its sender saw
 *
 * The signature is what makes a single shared group key safe: every member can
 * decrypt, but only the holder of a signing key can author.
 */
(function (root, factory) {
  const api = factory(
    (typeof crypto !== 'undefined' && crypto.subtle)
      ? crypto
      : require('crypto').webcrypto
  );
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.HavenGroupCrypto = api;
})(typeof self !== 'undefined' ? self : globalThis, function (cryptoRef) {
  'use strict';

  const subtle = cryptoRef.subtle;
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  const SIG_CONTEXT = 'havenmsg:v1';
  const ROSTER_CONTEXT = 'havenroster:v1';
  const WRAP_INFO = 'haven-group-key-wrap';

  /* ── encoding ─────────────────────────────────────── */

  const b64 = (bytes) => {
    const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (typeof Buffer !== 'undefined') return Buffer.from(arr).toString('base64');
    let s = '';
    for (const b of arr) s += String.fromCharCode(b);
    return btoa(s);
  };

  const unb64 = (str) => {
    if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(str, 'base64'));
    const bin = atob(str);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  };

  /* ── identity ─────────────────────────────────────── */

  /** Signing identity. Separate from the ECDH key: P-256 cannot do both. */
  async function generateSigningKeyPair() {
    return subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  }

  async function exportPublicJwk(key) {
    const jwk = await subtle.exportKey('jwk', key);
    // Only the fields that define the point. Local keys carry ext/key_ops that
    // server-fetched copies do not, and any digest over the JWK must match
    // across both — the same normalisation the pairwise safety number uses.
    return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
  }

  const importVerifyKey = (jwk) =>
    subtle.importKey('jwk', { ...jwk, ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);

  /* ── epoch keys ───────────────────────────────────── */

  async function generateEpochKey() {
    return subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  }

  /**
   * Wrap an epoch key for one member under the pairwise ECDH secret.
   * `pairKey` is the AES-GCM key both sides already derive for 1:1 DMs, so no
   * new key agreement is introduced.
   */
  async function wrapEpochKey(epochKey, pairKey) {
    const raw = new Uint8Array(await subtle.exportKey('raw', epochKey));
    const iv = cryptoRef.getRandomValues(new Uint8Array(12));
    const ct = await subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: enc.encode(WRAP_INFO) }, pairKey, raw
    );
    raw.fill(0);
    return JSON.stringify({ v: 1, iv: b64(iv), ct: b64(new Uint8Array(ct)) });
  }

  async function unwrapEpochKey(wrapped, pairKey) {
    const o = typeof wrapped === 'string' ? JSON.parse(wrapped) : wrapped;
    const raw = await subtle.decrypt(
      { name: 'AES-GCM', iv: unb64(o.iv), additionalData: enc.encode(WRAP_INFO) },
      pairKey, unb64(o.ct)
    );
    return subtle.importKey('raw', raw, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
  }

  /* ── message signing ──────────────────────────────── */

  /**
   * The signed input. Every field that must not be swapped is inside it:
   * moving a valid ciphertext to another channel or epoch, or re-attributing
   * it to another sender, all invalidate the signature.
   * Length-prefixed so no combination of values can collide with another.
   */
  function signingInput({ channelId, epoch, senderId, prev, iv, ct }) {
    const parts = [SIG_CONTEXT, String(channelId), String(epoch), String(senderId), prev || '', iv, ct];
    return enc.encode(parts.map((p) => `${p.length}:${p}`).join('|'));
  }

  const sign = async (signingPrivateKey, fields) =>
    b64(new Uint8Array(await subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' }, signingPrivateKey, signingInput(fields)
    )));

  async function verify(signingPublicJwk, sig, fields) {
    try {
      return await subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        await importVerifyKey(signingPublicJwk),
        unb64(sig), signingInput(fields)
      );
    } catch {
      return false;
    }
  }

  /* ── envelopes ────────────────────────────────────── */

  /** SHA-256 of an envelope, used as the next message's `prev`. */
  async function envelopeHash(envelope) {
    const s = typeof envelope === 'string' ? envelope : JSON.stringify(envelope);
    return b64(new Uint8Array(await subtle.digest('SHA-256', enc.encode(s))));
  }

  async function encryptGroupMessage(plaintext, { epochKey, epoch, channelId, senderId, prev, signingPrivateKey }) {
    const iv = cryptoRef.getRandomValues(new Uint8Array(12));
    const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, epochKey, enc.encode(plaintext));
    const ivB = b64(iv);
    const ctB = b64(new Uint8Array(ct));
    const sig = await sign(signingPrivateKey, { channelId, epoch, senderId, prev, iv: ivB, ct: ctB });
    return { v: 3, e: epoch, prev: prev || null, iv: ivB, ct: ctB, sig };
  }

  /**
   * Verify then decrypt — in that order, and never the reverse. Returns
   * { ok, plaintext, reason }. A caller that ignores `ok` and reads
   * `plaintext` gets null, so a forged message cannot be rendered by mistake.
   */
  async function decryptGroupMessage(envelope, { epochKey, channelId, senderId, signingPublicJwk }) {
    const env = typeof envelope === 'string' ? JSON.parse(envelope) : envelope;
    if (!env || env.v !== 3) return { ok: false, plaintext: null, reason: 'unsupported-version' };
    if (!env.sig) return { ok: false, plaintext: null, reason: 'unsigned' };

    const good = await verify(signingPublicJwk, env.sig, {
      channelId, epoch: env.e, senderId, prev: env.prev, iv: env.iv, ct: env.ct
    });
    if (!good) return { ok: false, plaintext: null, reason: 'bad-signature' };

    try {
      const pt = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(env.iv) }, epochKey, unb64(env.ct));
      return { ok: true, plaintext: dec.decode(pt), reason: null };
    } catch {
      // Right signature, wrong key: the usual cause is an epoch the reader
      // does not hold, e.g. history from before they joined.
      return { ok: false, plaintext: null, reason: 'wrong-epoch-key' };
    }
  }

  /* ── roster gossip ────────────────────────────────── */

  /**
   * Digest over every member's keys. Members compare digests; agreement means
   * nobody has been handed a substituted key. A 1:1 cannot do this, having no
   * third party to disagree with.
   */
  async function rosterDigest(members) {
    const canon = members
      .map((m) => ({
        id: Number(m.id),
        ecdh: m.ecdhJwk ? `${m.ecdhJwk.x}.${m.ecdhJwk.y}` : '',
        sign: m.signJwk ? `${m.signJwk.x}.${m.signJwk.y}` : '',
      }))
      .sort((a, b) => a.id - b.id)
      .map((m) => `${m.id}:${m.ecdh}:${m.sign}`)
      .join('|');
    const bytes = await subtle.digest('SHA-256', enc.encode(`${ROSTER_CONTEXT}|${canon}`));
    return b64(new Uint8Array(bytes));
  }

  /**
   * Walk a channel's messages and report transcript breaks. Concurrent sends
   * legitimately share a `prev`, so a fork is not a fault — only a `prev`
   * naming an envelope that never arrived is.
   */
  function verifyChain(envelopeHashes, messages) {
    const seen = new Set(envelopeHashes);
    const breaks = [];
    for (const m of messages) {
      if (!m.prev) continue;
      if (!seen.has(m.prev)) breaks.push({ id: m.id ?? null, missingPrev: m.prev });
    }
    return { ok: breaks.length === 0, breaks };
  }

  return {
    generateSigningKeyPair, exportPublicJwk,
    generateEpochKey, wrapEpochKey, unwrapEpochKey,
    sign, verify, signingInput,
    encryptGroupMessage, decryptGroupMessage, envelopeHash,
    rosterDigest, verifyChain,
    _b64: b64, _unb64: unb64,
  };
});
