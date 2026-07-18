'use strict';

/**
 * Haven — Account linking routes for rich presence
 *
 * Two redirect flows live here:
 *
 *   Steam   — OpenID 2.0. No app secret; you register a Web API key and Steam
 *             hands back a SteamID64 that we verify by echoing the response
 *             back to Steam for confirmation.
 *   Spotify — OAuth 2.0 authorization code. Needs a client ID + secret from
 *             the Spotify developer dashboard.
 *
 * Both are top-level browser navigations, so neither can carry the normal
 * Authorization header. The client first asks over the socket for a 5-minute
 * 'connect'-scoped token (auth.js: generateConnectToken) and puts that in the
 * URL. Every route below re-verifies that token and refuses anything without
 * the right scope — a full session token is not accepted, and a connect token
 * is useless for anything except linking.
 *
 * Server admin setup (.env):
 *   STEAM_API_KEY=...............  https://steamcommunity.com/dev/apikey
 *   SPOTIFY_CLIENT_ID=..........   https://developer.spotify.com/dashboard
 *   SPOTIFY_CLIENT_SECRET=......
 *
 * The Spotify dashboard needs the redirect URI allow-listed exactly:
 *   https://<your-haven-host>/connect/spotify/callback
 */

const express = require('express');
const { verifyToken } = require('./auth');

const SPOTIFY_SCOPES = 'user-read-currently-playing user-read-playback-state';

function baseUrl(req) {
  // Honours X-Forwarded-Proto/Host when the app has 'trust proxy' set, which
  // matters because Haven is usually behind Traefik/nginx terminating TLS.
  return `${req.protocol}://${req.get('host')}`;
}

/** Verify a 'connect'-scoped token and return the user id, or null. */
function connectUserId(token, provider) {
  if (!token || typeof token !== 'string') return null;
  const decoded = verifyToken(token);
  if (!decoded || decoded.scope !== 'connect') return null;
  if (provider && decoded.provider !== provider) return null;
  return typeof decoded.id === 'number' ? decoded.id : null;
}

/**
 * End the linking flow.
 *
 * This deliberately does NOT redirect to /app.html. The OAuth round-trip can
 * finish anywhere — a popup, a different browser than the one that started it
 * (Steam's QR sign-in does exactly this), or the desktop app's child window.
 * Landing on /app.html in any of those places boots a whole second Haven
 * client, which for a browser that isn't logged in means the user is dumped on
 * a login screen with no idea why.
 *
 * Instead we serve a small self-contained page that reports the result and
 * closes itself. The real app finds out over its socket — saveConnection
 * pushes a fresh connections payload to every socket the user has open — so it
 * updates live no matter where this page ended up.
 *
 * Nothing from the provider is interpolated here; `provider` is validated
 * against a fixed list and `status` is a boolean in disguise.
 */
const PROVIDER_LABELS = { steam: 'Steam', spotify: 'Spotify' };

function finish(res, status, provider) {
  const ok = status === 'ok';
  const label = PROVIDER_LABELS[provider] || 'Account';
  const title = ok ? `${label} linked` : `Couldn't link ${label}`;
  const body = ok
    ? 'You can close this window and go back to Haven.'
    : 'Something went wrong. Close this window and try again from Haven.';

  res.status(ok ? 200 : 400).type('html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>${title}</title>
<style>
  body { margin:0; height:100vh; display:flex; align-items:center; justify-content:center;
         background:#15161a; color:#e6e6e6;
         font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif; }
  .card { text-align:center; padding:32px 40px; background:#1d1f24;
          border:1px solid #2c2f36; border-radius:12px; max-width:420px; }
  h1 { font-size:18px; margin:0 0 8px; color:${ok ? '#4ade80' : '#f87171'}; }
  p { font-size:13px; margin:0; color:#a1a1aa; line-height:1.5; }
</style></head>
<body><div class="card"><h1>${ok ? '✓' : '✕'} ${title}</h1><p>${body}</p></div>
<script>
  // Only works when this page was opened via window.open (the normal path).
  // A tab the user landed in some other way just shows the message.
  setTimeout(function(){ try { window.close(); } catch (e) {} }, ${ok ? 1200 : 4000});
</script></body></html>`);
}

async function postForm(url, params, headers = {}) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(params),
  });
  return resp;
}

/**
 * @param {function} getActivity returns the engine from src/activity.js. Passed as a
 *   getter rather than the object because these routes must be mounted before
 *   the SPA catch-all in server.js, which is earlier than where the socket
 *   layer (and with it the activity engine) gets constructed.
 */
function createConnectRoutes(getActivity) {
  const router = express.Router();

  // Every route needs the engine; bail cleanly if it isn't up yet.
  router.use((req, res, next) => {
    const engine = getActivity();
    if (!engine) return res.status(503).send('Server still starting — try again in a moment.');
    req.activity = engine;
    next();
  });

  // ══════════════════════════════════════════════════════
  // Steam — OpenID 2.0
  // ══════════════════════════════════════════════════════
  router.get('/steam', (req, res) => {
    if (!req.activity.isSteamConfigured()) return res.status(503).send('Steam integration not configured on this server');
    const userId = connectUserId(req.query.token, 'steam');
    if (!userId) return res.status(401).send('Link session expired — close this tab and try again from Haven.');

    // The connect token rides along in return_to so the callback can re-verify
    // who started the flow. It is signed and short-lived, so a tampered or
    // replayed return_to fails verification rather than linking the wrong user.
    const returnTo = `${baseUrl(req)}/connect/steam/callback?token=${encodeURIComponent(req.query.token)}`;
    const params = new URLSearchParams({
      'openid.ns': 'http://specs.openid.net/auth/2.0',
      'openid.mode': 'checkid_setup',
      'openid.return_to': returnTo,
      'openid.realm': baseUrl(req),
      'openid.identity': 'http://specs.openid.net/auth/2.0/identifier_select',
      'openid.claimed_id': 'http://specs.openid.net/auth/2.0/identifier_select',
    });
    res.redirect(`https://steamcommunity.com/openid/login?${params}`);
  });

  router.get('/steam/callback', async (req, res) => {
    if (!req.activity.isSteamConfigured()) return finish(res, 'error', 'steam');
    const userId = connectUserId(req.query.token, 'steam');
    if (!userId) return finish(res, 'error', 'steam');

    try {
      // Echo every openid.* param back to Steam with mode=check_authentication.
      // This is the whole security model of OpenID 2.0 — without it, anyone
      // could hand us a hand-written callback URL claiming any SteamID.
      const check = {};
      for (const [k, v] of Object.entries(req.query)) {
        if (k.startsWith('openid.')) check[k] = v;
      }
      check['openid.mode'] = 'check_authentication';

      const resp = await postForm('https://steamcommunity.com/openid/login', check);
      const body = await resp.text();
      if (!/is_valid\s*:\s*true/i.test(body)) return finish(res, 'error', 'steam');

      const claimed = String(req.query['openid.claimed_id'] || '');
      const match = claimed.match(/^https?:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/);
      if (!match) return finish(res, 'error', 'steam');
      const steamId = match[1];

      // Pull the persona name so the settings UI can show which account is
      // linked. Non-fatal: a linked-but-unnamed connection still works.
      let personaName = '';
      try {
        const sumResp = await fetch(
          `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=${encodeURIComponent(process.env.STEAM_API_KEY)}&steamids=${steamId}`
        );
        if (sumResp.ok) {
          const data = await sumResp.json();
          personaName = data?.response?.players?.[0]?.personaname || '';
        }
      } catch { /* name is cosmetic */ }

      req.activity.saveConnection(userId, 'steam', {
        externalId: steamId,
        displayName: personaName,
        accessToken: null,   // Steam needs no per-user token; the API key is server-wide
        refreshToken: null,
        expiresAt: 0,
      });

      // Populate immediately so the user sees their game without waiting up to
      // a minute for the next poll tick.
      req.activity.pollSteam().catch(() => {});
      return finish(res, 'ok', 'steam');
    } catch (err) {
      console.error('[Haven activity] Steam link failed:', err.message);
      return finish(res, 'error', 'steam');
    }
  });

  // ══════════════════════════════════════════════════════
  // Spotify — OAuth 2.0 authorization code
  // ══════════════════════════════════════════════════════
  router.get('/spotify', (req, res) => {
    if (!req.activity.isSpotifyConfigured()) return res.status(503).send('Spotify integration not configured on this server');
    const userId = connectUserId(req.query.token, 'spotify');
    if (!userId) return res.status(401).send('Link session expired — close this tab and try again from Haven.');

    const params = new URLSearchParams({
      client_id: process.env.SPOTIFY_CLIENT_ID,
      response_type: 'code',
      redirect_uri: `${baseUrl(req)}/connect/spotify/callback`,
      scope: SPOTIFY_SCOPES,
      // The signed connect token doubles as the CSRF state value.
      state: req.query.token,
      show_dialog: 'false',
    });
    res.redirect(`https://accounts.spotify.com/authorize?${params}`);
  });

  router.get('/spotify/callback', async (req, res) => {
    if (!req.activity.isSpotifyConfigured()) return finish(res, 'error', 'spotify');
    const userId = connectUserId(req.query.state, 'spotify');
    if (!userId) return finish(res, 'error', 'spotify');
    if (req.query.error || !req.query.code) return finish(res, 'error', 'spotify');

    try {
      const basic = Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString('base64');
      const tokenResp = await postForm(
        'https://accounts.spotify.com/api/token',
        {
          grant_type: 'authorization_code',
          code: String(req.query.code),
          redirect_uri: `${baseUrl(req)}/connect/spotify/callback`,
        },
        { Authorization: `Basic ${basic}` }
      );
      if (!tokenResp.ok) {
        console.error('[Haven activity] Spotify token exchange failed:', tokenResp.status);
        return finish(res, 'error', 'spotify');
      }
      const tok = await tokenResp.json();
      if (!tok.access_token || !tok.refresh_token) return finish(res, 'error', 'spotify');

      let displayName = '';
      let externalId = '';
      try {
        const meResp = await fetch('https://api.spotify.com/v1/me', {
          headers: { Authorization: `Bearer ${tok.access_token}` },
        });
        if (meResp.ok) {
          const me = await meResp.json();
          displayName = me.display_name || me.id || '';
          externalId = me.id || '';
        }
      } catch { /* cosmetic */ }

      req.activity.saveConnection(userId, 'spotify', {
        externalId,
        displayName,
        accessToken: tok.access_token,
        refreshToken: tok.refresh_token,
        expiresAt: Date.now() + ((Number(tok.expires_in) || 3600) * 1000),
      });

      req.activity.pollSpotifyUser(userId).catch(() => {});
      return finish(res, 'ok', 'spotify');
    } catch (err) {
      console.error('[Haven activity] Spotify link failed:', err.message);
      return finish(res, 'error', 'spotify');
    }
  });

  return router;
}

module.exports = { createConnectRoutes };
