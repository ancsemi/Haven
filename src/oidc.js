/**
 * Haven — OIDC (OpenID Connect) client
 *
 * Authorization Code flow with PKCE, against any standards-compliant provider
 * (Authentik, Keycloak, Authelia, Auth0, Zitadel...). Issue #12.
 *
 * No new npm dependency. Discovery and the token exchange are plain fetch
 * calls, and ID token signatures verify through Node's own crypto: a JWKS key
 * imports directly via createPublicKey({ format: 'jwk' }), which the existing
 * `jsonwebtoken` then checks. Pulling in a full OIDC library for one flow
 * would add a few dozen transitive packages to a project whose whole pitch is
 * that you can read what you are self-hosting.
 *
 * What this file does NOT do, on purpose: account linking to an existing local
 * user, and RP-initiated logout. Both are follow-ups (see issue #12); a first
 * login here always resolves to a federated account keyed by (issuer, sub).
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { getDb } = require('./database');

// Signature algorithms we accept on an ID token. Deliberately excludes the
// HMAC family: with a shared client secret an attacker who learns it could
// mint tokens, and 'none' is never acceptable.
const ALLOWED_ALGS = ['RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'PS256', 'PS384', 'PS512'];

const DISCOVERY_TTL_MS = 60 * 60 * 1000;   // 1 hour
const JWKS_TTL_MS      = 60 * 60 * 1000;
const JWKS_MIN_REFETCH_MS = 60 * 1000;      // floor on unknown-kid refetches
const HTTP_TIMEOUT_MS  = 10000;

const _discoveryCache = new Map();  // issuer → { doc, at }
const _jwksCache      = new Map();  // jwksUri → { keys, at, lastFetch }

/* ── Settings ─────────────────────────────────────────── */

function _setting(key) {
  try {
    const row = getDb().prepare('SELECT value FROM server_settings WHERE key = ?').get(key);
    return row && typeof row.value === 'string' ? row.value.trim() : '';
  } catch {
    return '';
  }
}

/**
 * Canonical form of an issuer URL: no trailing slash.
 *
 * Providers disagree on whether the issuer carries a trailing slash, and both
 * spellings name the same provider. The canonical form is what Haven compares
 * and what it keys federated accounts on, so neither a provider's preference
 * nor an admin's typing changes who a returning user is.
 */
function _canonicalIssuer(value) {
  return String(value || '').replace(/\/+$/, '');
}

/**
 * Current OIDC configuration.
 *
 * The client secret comes from the environment only, never the database. A
 * Haven backup is a copy of the database, and backups get moved around and
 * shared far more casually than an .env file — an IdP credential should not
 * ride along inside one. (Same reasoning as JWT_SECRET.)
 */
function getOidcConfig() {
  // Kept exactly as the admin entered it (#5501, #5503): providers such as
  // Authentik publish the issuer with a trailing slash and reject the other
  // spelling, so Haven must not rewrite it.
  const issuer = _setting('oidc_issuer_url');
  // Identity key for federated accounts. Canonical rather than verbatim, so
  // editing the trailing slash in settings cannot orphan existing SSO users
  // into brand new accounts.
  const issuerKey = _canonicalIssuer(issuer);
  const clientId = _setting('oidc_client_id');
  const clientSecret = process.env.OIDC_CLIENT_SECRET || '';
  const scopes = _setting('oidc_scopes') || 'openid profile email';
  const buttonLabel = _setting('oidc_button_label') || 'Sign in with SSO';
  const createUsers = _setting('oidc_create_users') !== '0';
  const enabled = _setting('oidc_enabled') === '1' && !!issuer && !!clientId && !!clientSecret;
  return { enabled, issuer, issuerKey, clientId, clientSecret, scopes, buttonLabel, createUsers };
}

/**
 * Enabled *and* configured. `oidc_enabled` alone is not enough — an admin can
 * flip the toggle before setting OIDC_CLIENT_SECRET, and a login button that
 * always errors is worse than no button.
 */
function isOidcEnabled() {
  return getOidcConfig().enabled;
}

/* ── Discovery ────────────────────────────────────────── */

function _assertSafeIssuer(issuer) {
  let u;
  try {
    u = new URL(issuer);
  } catch {
    throw new Error('OIDC issuer URL is not a valid URL');
  }
  const isLocal = /^(localhost|127\.0\.0\.1|\[::1\]|::1)$/i.test(u.hostname);
  if (u.protocol !== 'https:' && !isLocal) {
    throw new Error('OIDC issuer must be https (plain http is only allowed for localhost)');
  }
  return u;
}

async function _fetchJson(url, options = {}) {
  const res = await fetch(url, { ...options, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`Provider returned non-JSON from ${url} (HTTP ${res.status})`);
  }
  if (!res.ok) {
    const detail = body.error_description || body.error || `HTTP ${res.status}`;
    throw new Error(detail);
  }
  return body;
}

/** Fetch (and cache) the provider's discovery document. */
async function discover(issuer) {
  _assertSafeIssuer(issuer);
  // Cached under the canonical form so the two spellings of one provider
  // share an entry instead of fetching discovery twice.
  const cacheKey = _canonicalIssuer(issuer);
  const hit = _discoveryCache.get(cacheKey);
  if (hit && Date.now() - hit.at < DISCOVERY_TTL_MS) return hit.doc;

  // Trailing slash removed here so the well-known path never doubles up.
  const doc = await _fetchJson(`${cacheKey}/.well-known/openid-configuration`);

  // The issuer inside the document is authoritative and must match what the
  // admin configured, or we could be talking to a provider that impersonates
  // another one's identifiers. Compared canonically so the admin does not have
  // to guess which spelling their provider publishes; every other difference
  // still fails.
  if (_canonicalIssuer(doc.issuer) !== cacheKey) {
    throw new Error(`Provider issuer mismatch: configured ${issuer}, document says ${doc.issuer}`);
  }
  for (const field of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
    if (!doc[field]) throw new Error(`Provider discovery document is missing ${field}`);
  }
  const methods = doc.code_challenge_methods_supported;
  if (Array.isArray(methods) && !methods.includes('S256')) {
    throw new Error('Provider does not support PKCE S256');
  }

  _discoveryCache.set(cacheKey, { doc, at: Date.now() });
  return doc;
}

/* ── JWKS ─────────────────────────────────────────────── */

async function _getSigningKey(jwksUri, kid) {
  let entry = _jwksCache.get(jwksUri);
  const stale = !entry || Date.now() - entry.at > JWKS_TTL_MS;

  if (stale) {
    const jwks = await _fetchJson(jwksUri);
    entry = { keys: Array.isArray(jwks.keys) ? jwks.keys : [], at: Date.now(), lastFetch: Date.now() };
    _jwksCache.set(jwksUri, entry);
  }

  let jwk = entry.keys.find(k => k.kid === kid) || (!kid && entry.keys.length === 1 ? entry.keys[0] : null);

  // Unknown kid usually means the provider rotated its signing key mid-cache.
  // Refetch once, rate limited so a token with a bogus kid can't be used to
  // hammer the provider.
  if (!jwk && Date.now() - entry.lastFetch > JWKS_MIN_REFETCH_MS) {
    const jwks = await _fetchJson(jwksUri);
    entry = { keys: Array.isArray(jwks.keys) ? jwks.keys : [], at: Date.now(), lastFetch: Date.now() };
    _jwksCache.set(jwksUri, entry);
    jwk = entry.keys.find(k => k.kid === kid) || null;
  }

  if (!jwk) throw new Error('ID token was signed with a key the provider does not publish');
  return crypto.createPublicKey({ key: jwk, format: 'jwk' });
}

/* ── Authorization request ────────────────────────────── */

function _b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Build the redirect to the provider, plus the secrets we must remember to
 * validate what comes back.
 *
 * state    — ties the callback to the browser that started the login (CSRF)
 * nonce    — ties the ID token to this specific request (replay)
 * verifier — PKCE; proves the code is redeemed by whoever requested it
 */
async function buildAuthorizationUrl(redirectUri) {
  const cfg = getOidcConfig();
  if (!cfg.enabled) throw new Error('OIDC is not enabled');
  const doc = await discover(cfg.issuer);

  const state = crypto.randomBytes(32).toString('hex');
  const nonce = crypto.randomBytes(32).toString('hex');
  const verifier = _b64url(crypto.randomBytes(32));
  const challenge = _b64url(crypto.createHash('sha256').update(verifier).digest());

  const url = new URL(doc.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', cfg.clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', cfg.scopes);
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');

  return { url: url.toString(), state, nonce, verifier };
}

/* ── Token exchange + verification ────────────────────── */

async function exchangeCode(code, verifier, redirectUri) {
  const cfg = getOidcConfig();
  const doc = await discover(cfg.issuer);

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: cfg.clientId,
    code_verifier: verifier,
  });

  // client_secret_basic first — it is what most providers register by default
  // and what the spec recommends. Providers configured for client_secret_post
  // reject the header form, so fall back rather than making the admin care.
  const basic = Buffer.from(`${encodeURIComponent(cfg.clientId)}:${encodeURIComponent(cfg.clientSecret)}`).toString('base64');
  try {
    return await _fetchJson(doc.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${basic}` },
      body: body.toString(),
    });
  } catch (err) {
    const post = new URLSearchParams(body);
    post.set('client_secret', cfg.clientSecret);
    return await _fetchJson(doc.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: post.toString(),
    });
  }
}

/**
 * Verify an ID token and return its claims.
 * Throws with a human-readable reason on any failure.
 */
async function verifyIdToken(idToken, expectedNonce) {
  if (typeof idToken !== 'string' || !idToken) throw new Error('Provider did not return an ID token');
  const cfg = getOidcConfig();
  const doc = await discover(cfg.issuer);

  const [rawHeader] = idToken.split('.');
  let header;
  try {
    header = JSON.parse(Buffer.from(rawHeader, 'base64url').toString('utf8'));
  } catch {
    throw new Error('ID token header is malformed');
  }
  if (!ALLOWED_ALGS.includes(header.alg)) {
    throw new Error(`ID token uses an unsupported signature algorithm (${header.alg})`);
  }

  const key = await _getSigningKey(doc.jwks_uri, header.kid);
  const claims = jwt.verify(idToken, key, {
    algorithms: ALLOWED_ALGS,
    // The provider signs `iss` in its own spelling. discover() has already
    // proven that equals the configured issuer, so this is the string to
    // check against; the configured one rejects the other spelling.
    issuer: doc.issuer,
    audience: cfg.clientId,
    clockTolerance: 60,
  });

  // With more than one audience the spec requires azp, and it must be us.
  if (Array.isArray(claims.aud) && claims.aud.length > 1 && claims.azp !== cfg.clientId) {
    throw new Error('ID token azp does not identify this client');
  }
  if (!claims.sub) throw new Error('ID token has no subject claim');
  if (expectedNonce && claims.nonce !== expectedNonce) {
    throw new Error('ID token nonce does not match this login attempt');
  }
  return claims;
}

/* ── Login transactions ───────────────────────────────── */

/**
 * In-flight logins, keyed by state. Kept in memory rather than a cookie: it
 * needs no cookie plumbing (Haven ships none), and the secrets never leave the
 * server. A restart mid-login drops the transaction, which just means the user
 * clicks the button again.
 */
const _transactions = new Map();
const TRANSACTION_TTL_MS = 10 * 60 * 1000;

function saveTransaction(state, data) {
  _transactions.set(state, { ...data, at: Date.now() });
  if (_transactions.size > 500) sweepTransactions();
}

/** Single-use: taking a transaction removes it, so a replayed code fails. */
function takeTransaction(state) {
  const tx = _transactions.get(state);
  if (!tx) return null;
  _transactions.delete(state);
  if (Date.now() - tx.at > TRANSACTION_TTL_MS) return null;
  return tx;
}

function sweepTransactions() {
  const cutoff = Date.now() - TRANSACTION_TTL_MS;
  for (const [state, tx] of _transactions) {
    if (tx.at < cutoff) _transactions.delete(state);
  }
}

setInterval(sweepTransactions, 5 * 60 * 1000).unref?.();

module.exports = {
  getOidcConfig,
  isOidcEnabled,
  discover,
  buildAuthorizationUrl,
  exchangeCode,
  verifyIdToken,
  saveTransaction,
  takeTransaction,
};
