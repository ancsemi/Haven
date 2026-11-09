// ═══════════════════════════════════════════════════════════
// Haven: FCM Push Notification Module
// Sends mobile push notifications via Firebase Cloud Messaging.
// Uses only jsonwebtoken (already a Haven dependency); no firebase-admin needed.
//
// Three modes:
//   1. Direct mode: Service account JSON present → sends to FCM API directly
//   2. Relay mode:  FCM_RELAY_URL set → forwards to a push relay server
//   3. Default:     Neither configured → uses the Haven Global Relay automatically
// ═══════════════════════════════════════════════════════════

const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const webpush = require('web-push');

let serviceAccount = null;
let cachedToken = null;
let cachedTokenExpiry = 0;
let relayUrl = '';
let relayKey = '';
let projectId = '';
// In-memory mirror of the fcm_enabled server setting (Settings → Security → FCM
// Privacy). Kept in sync by setFcmAdminEnabled so the hot message path never
// has to read the database. Default on so nothing breaks before it's loaded.
let adminEnabled = true;
let hideContent = false;
const SEALED_TITLE = 'Haven';
const SEALED_BODY = 'New message';
const SEAL_PAD_BYTES = 512;
const SEAL_MAX_CHARS = 3072;
const SEAL_YIELD_EVERY = 25;

const FCM_SCOPES = 'https://www.googleapis.com/auth/firebase.messaging';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DEFAULT_RELAY = 'https://us-central1-amni-haven.cloudfunctions.net/sendPush';
const DEFAULT_KEY = 'firebase-notifications-007';

/**
 * Initialize FCM. Call once at startup.
 * @param {string} dataDir - Haven data directory (to find service account JSON)
 * @returns {{ mode: string }} - 'direct', 'relay', or 'disabled'
 */
function initFcm(dataDir) {
  const saPath = process.env.FIREBASE_SERVICE_ACCOUNT
    || findServiceAccount(dataDir)
    || findServiceAccount(__dirname);

  let via = null;
  let mode = 'disabled';

  if (saPath && fs.existsSync(saPath)) {
    try {
      serviceAccount = JSON.parse(fs.readFileSync(saPath, 'utf-8'));
      projectId = serviceAccount.project_id;
      via = `direct API, project ${projectId}`;
      mode = 'direct';
    } catch (err) {
      console.warn('⚠️  Failed to parse Firebase service account:', err.message);
    }
  }

  if (!serviceAccount) {
    // Fall back to relay mode, using the Haven Global Relay by default.
    relayUrl = process.env.FCM_RELAY_URL || DEFAULT_RELAY;
    relayKey = process.env.FCM_PUSH_KEY || DEFAULT_KEY;
    if (relayUrl && relayKey) {
      via = relayUrl === DEFAULT_RELAY ? 'Haven Global Relay' : `Custom Relay ${relayUrl}`;
      mode = 'relay';
    }
  }

  if (!via) return { mode: 'disabled' };

  // The log reflects the effective state, not just the configuration: FCM can
  // be wired up here yet still switched off by the admin under Settings >
  // Security > FCM Privacy. adminEnabled is loaded from the DB before this runs.
  if (adminEnabled) {
    console.log(`🔔 FCM enabled via ${via}`);
  } else {
    console.log(`🔕 FCM configured via ${via}, but turned off in Settings > Security > FCM Privacy`);
  }
  return { mode };
}

/**
 * Look for a service account JSON file in a directory.
 */
function findServiceAccount(dir) {
  try {
    const parentDir = path.resolve(dir, '..');
    for (const d of [dir, parentDir]) {
      if (!fs.existsSync(d)) continue;
      const files = fs.readdirSync(d).filter(f =>
        f.endsWith('.json') && (f.includes('service-account') || f.includes('adminsdk'))
      );
      if (files.length > 0) return path.join(d, files[0]);
    }
  } catch { /* folder unreadable: no service account here, so relay mode is used */ }
  return null;
}

/**
 * Get an OAuth2 access token for the FCM API.
 * Caches token for ~55 minutes (tokens last 60 minutes).
 */
async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && now < cachedTokenExpiry) return cachedToken;

  const claim = {
    iss: serviceAccount.client_email,
    scope: FCM_SCOPES,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  };

  const assertion = jwt.sign(claim, serviceAccount.private_key, { algorithm: 'RS256' });

  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${assertion}`,
  });

  if (!resp.ok) {
    throw new Error(`OAuth2 token exchange failed: ${resp.status}`);
  }

  const data = await resp.json();
  cachedToken = data.access_token;
  cachedTokenExpiry = now + 3300; // refresh 5 min early
  return cachedToken;
}

/**
 * Send FCM notification directly via the HTTP v1 API.
 */
async function sendDirect(tokens, title, body, dataPayload, sealed = {}) {
  const accessToken = await getAccessToken();
  const url = `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;

  const results = { success: 0, failure: 0, failedTokens: [] };

  // FCM v1 API sends one message at a time; fire all in parallel
  const promises = tokens.map(async (token) => {
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: typeof sealed[token] === 'string' ? {
            token,
            data: { enc: sealed[token] },
            android: { priority: 'high' },
            apns: { headers: { 'apns-priority': '10', 'apns-push-type': 'alert' }, payload: { aps: { alert: { title: SEALED_TITLE, body: SEALED_BODY }, sound: 'default', 'mutable-content': 1 } } },
          } : {
            token,
            notification: { title, body },
            data: dataPayload,
            android: {
              priority: 'high',
              notification: { channel_id: 'haven_messages' },
            },
          },
        }),
      });

      if (resp.ok) {
        results.success++;
      } else {
        results.failure++;
        const errBody = await resp.json().catch(() => ({}));
        const errCode = errBody?.error?.details?.[0]?.errorCode || '';
        const errMessage = String(errBody?.error?.message || '');
        // A dead or malformed token is dropped. INVALID_ARGUMENT also covers a
        // bad message, which would fail for every token alike, so only the
        // answer that names the token counts.
        const badToken = errCode === 'INVALID_ARGUMENT' && /registration token/i.test(errMessage);
        if (errCode === 'UNREGISTERED' || resp.status === 404 || badToken) {
          results.failedTokens.push(token);
        }
      }
    } catch {
      results.failure++;
    }
  });

  await Promise.all(promises);
  return results;
}

/**
 * Send FCM notification via an external relay.
 */
async function sendViaRelay(tokens, title, body, dataPayload, sealed) {
  try {
    const resp = await fetch(relayUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-push-key': relayKey,
      },
      body: JSON.stringify({ tokens, title, body, data: dataPayload, sealed }),
    });

    if (!resp.ok) return { success: 0, failure: tokens.length, failedTokens: [] };
    return await resp.json();
  } catch (err) {
    console.error('FCM relay error:', err.message);
    return { success: 0, failure: tokens.length, failedTokens: [] };
  }
}

/**
 * Send push notifications to the given FCM tokens.
 * Automatically uses direct or relay mode based on config.
 *
 * @param {Array<string|{token: string, p256dh?: string, auth?: string}>} devices - FCM tokens, with the device's push key when it has one
 * @param {string} title - Notification title
 * @param {string} body - Notification body text
 * @param {Object} data - Data payload (channelCode, etc.)
 * @returns {Promise<{success: number, failure: number, failedTokens: string[]}>}
 */
async function sendFcm(devices, title, body, data = {}) {
  if (!devices || devices.length === 0) return { success: 0, failure: 0, failedTokens: [] };

  // Convert all data values to strings (FCM requirement)
  const dataPayload = Object.fromEntries(
    Object.entries(data).map(([k, v]) => [k, String(v)])
  );
  const send = (tokens, t, b, d, sealed) => serviceAccount ? sendDirect(tokens, t, b, d, sealed)
    : relayUrl && relayKey ? sendViaRelay(tokens, t, b, d, sealed)
    : { success: 0, failure: 0, failedTokens: [] };
  const list = devices.map(d => typeof d === 'string' ? { token: d } : d);
  const keyed = list.filter(d => d.p256dh && d.auth);
  const keyless = list.filter(d => !(d.p256dh && d.auth)).map(d => d.token);
  const sends = [];
  if (keyless.length) sends.push(hideContent ? send(keyless, SEALED_TITLE, SEALED_BODY, {}) : send(keyless, title, body, dataPayload));
  if (keyed.length) sends.push(send(keyed.map(d => d.token), SEALED_TITLE, SEALED_BODY, {}, await sealAll(keyed, { title, body, ...dataPayload })));
  const results = await Promise.all(sends);
  return results.reduce((all, r) => ({
    success: all.success + (r.success || 0),
    failure: all.failure + (r.failure || 0),
    failedTokens: all.failedTokens.concat(r.failedTokens || []),
  }), { success: 0, failure: 0, failedTokens: [] });
}

function sealPush(payload, key) {
  const json = Buffer.from(JSON.stringify(payload));
  const padded = Buffer.concat([json, Buffer.alloc((SEAL_PAD_BYTES - json.length % SEAL_PAD_BYTES) % SEAL_PAD_BYTES, 0x20)]);
  const sealed = webpush.encrypt(key.p256dh, key.auth, padded, 'aes128gcm').cipherText.toString('base64url');
  return sealed.length > SEAL_MAX_CHARS ? null : sealed;
}

async function sealAll(devices, payload) {
  const sealed = {};
  for (let i = 0; i < devices.length; i++) {
    if (i && i % SEAL_YIELD_EVERY === 0) await new Promise(setImmediate);
    try {
      const enc = sealPush(payload, devices[i]);
      if (enc) sealed[devices[i].token] = enc;
    } catch (err) {
      console.error('FCM seal error:', err.message);
    }
  }
  return sealed;
}

function cleanPushKey(key) {
  if (!key || typeof key !== 'object' || typeof key.p256dh !== 'string' || typeof key.auth !== 'string') return null;
  if (key.p256dh.length > 128 || key.auth.length > 64) return null;
  const pub = Buffer.from(key.p256dh, 'base64url');
  const auth = Buffer.from(key.auth, 'base64url');
  if (pub.length !== 65 || pub[0] !== 4 || auth.length !== 16) return null;
  try {
    crypto.createECDH('prime256v1').setPrivateKey(crypto.randomBytes(32)).computeSecret(pub);
  } catch {
    return null;
  }
  return { p256dh: pub.toString('base64url'), auth: auth.toString('base64url') };
}

/**
 * Check if FCM is available: configured (direct or relay mode) AND not turned
 * off by the admin under Settings → Security → FCM Privacy.
 */
function isFcmEnabled() {
  return adminEnabled && !!(serviceAccount || (relayUrl && relayKey));
}

/**
 * Sync the in-memory admin toggle. Called once at startup from the stored
 * setting and again whenever an admin changes it, so isFcmEnabled() stays
 * current without touching the database on the message hot path.
 */
function setFcmAdminEnabled(enabled) {
  adminEnabled = enabled !== false;
}

function setFcmHideContent(hide) {
  hideContent = hide === true;
}

/**
 * Get the push relay key (for the relay endpoint authentication).
 * Returns null if no service account is loaded (relay mode disabled on this server).
 */
function getRelayKey() {
  if (!serviceAccount) return null;
  return process.env.HAVEN_PUSH_KEY || null;
}

// Real FCM tokens are a few hundred characters. The caps keep one account
// from filling the table, or from making every push fan out to thousands of
// junk tokens; the oldest device drops off first, so a reinstall still
// registers. Returns false when the token is refused.
const FCM_TOKEN_MAX_LENGTH = 4096;
const FCM_TOKENS_PER_USER = 10;

// scope, when given, is which messages this device is pushed: 'all', or
// 'mentions' for DMs, replies and pings only (src/pushMutes.js).
function saveFcmToken(db, userId, token, scope, pushKey) {
  if (typeof token !== 'string' || !token || token.length > FCM_TOKEN_MAX_LENGTH) return false;
  const key = cleanPushKey(pushKey);
  db.transaction(() => {
    db.prepare('DELETE FROM fcm_tokens WHERE token = ? AND user_id != ?').run(token, userId);
    db.prepare(`
      INSERT INTO fcm_tokens (user_id, token)
      VALUES (?, ?)
      ON CONFLICT(user_id, token) DO NOTHING
    `).run(userId, token);
    db.prepare('UPDATE fcm_tokens SET push_p256dh = ?, push_auth = ? WHERE user_id = ? AND token = ?').run(key ? key.p256dh : null, key ? key.auth : null, userId, token);
    if (scope === 'all' || scope === 'mentions') {
      db.prepare('UPDATE fcm_tokens SET scope = ? WHERE user_id = ? AND token = ?').run(scope, userId, token);
    }
    db.prepare(`
      DELETE FROM fcm_tokens WHERE user_id = ? AND id NOT IN (
        SELECT id FROM fcm_tokens WHERE user_id = ? ORDER BY id DESC LIMIT ?
      )
    `).run(userId, userId, FCM_TOKENS_PER_USER);
  })();
  return true;
}

module.exports = { initFcm, sendFcm, isFcmEnabled, setFcmAdminEnabled, setFcmHideContent, getRelayKey, saveFcmToken, cleanPushKey, FCM_TOKENS_PER_USER, FCM_TOKEN_MAX_LENGTH };
