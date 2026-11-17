'use strict';

// The preview serves the real app and its migrated APIs. Unsupported actions
// fail explicitly instead of running synchronous SQLite handlers on promises.
const { getDb } = require('../../database');
const { verifyTokenAsync } = require('../../auth');
const publicGets = new Set(['/api/health','/api/version','/api/public-config','/api/themes','/api/plugins','/api/donors','/api/games','/api/media-proxy','/api/auth/registration-info','/api/auth/guest-info']);
const authPosts = new Set(['/api/auth/register','/api/auth/login']);
const protectedGets = new Set(['/api/auth/validate','/api/auth/totp/status','/api/auth/recovery-codes/status','/api/auth/user-servers',
  '/api/sounds','/api/emojis','/api/stickers','/api/standard-emojis','/api/user-sound-prefs','/api/user/channel-prefs',
  '/api/personas','/api/connection-address','/api/media-token','/api/ice-servers','/api/bot-commands','/api/push/vapid-key','/api/changelog']);
const writes = new Set([
  'PUT /api/auth/user-servers', 'POST /api/auth/verify-password',
  'POST /api/user/channel-prefs/mute', 'PUT /api/user/channel-prefs/muted',
  'POST /api/set-border-transform', 'POST /api/set-avatar-shape', 'POST /api/set-animate-profile',
  'POST /api/user-sound-prefs',
]);

function installPostgresPreviewHttp(app) {
  app.use(async (req, res, next) => {
    const db = getDb();
    if (db?.kind !== 'postgres') return next();
    // Express routes are case-insensitive and accept a trailing slash by
    // default. Apply the feature gate to those spellings as well.
    const route = req.path.toLowerCase().replace(/\/+$/, '');
    if (!route.startsWith('/api/')) return next();
    const publicRequest = (req.method === 'GET' && publicGets.has(route)) || (req.method === 'POST' && authPosts.has(route));
    const soundVolume = req.method === 'PUT' && /^\/api\/sounds\/[^/]+\/volume$/.test(route);
    const supported = publicRequest || (req.method === 'GET' && protectedGets.has(route)) || writes.has(req.method + ' ' + route) || soundVolume;
    if (!supported) return res.status(501).json({ error: 'This feature is not available on this server yet', code: 'postgres_preview_unsupported' });
    if (publicRequest) return next();
    try {
      const decoded = await verifyTokenAsync(req.headers.authorization?.split(' ')[1]);
      if (!decoded) return res.status(401).json({ error: 'Unauthorized' });
      const account = await db.prepare('SELECT username, is_admin FROM users WHERE id = ?').get(decoded.id);
      if (!account || account.username !== decoded.username) return res.status(401).json({ error: 'Unauthorized' });
      if (await db.prepare('SELECT 1 FROM bans WHERE user_id = ?').get(decoded.id)) return res.status(403).json({ error: 'Forbidden' });
      req.postgresUser = { ...decoded, isAdmin: !!account.is_admin };
      if (route === '/api/ice-servers') return res.json({ iceServers: [] });
      if (route === '/api/bot-commands') return res.json({ commands: [] });
      if (route === '/api/push/vapid-key') return res.json({ key: null });
      if (route === '/api/personas') {
        const personas = await db.prepare('SELECT id, name, avatar, bio, created_at FROM user_personas WHERE user_id = ? ORDER BY LOWER(name)').all(decoded.id);
        return res.json({ personas });
      }
      if (route === '/api/stickers') {
        const rows = await db.prepare('SELECT id, name, pack_name, filename FROM stickers ORDER BY LOWER(pack_name), LOWER(name)').all();
        return res.json({ stickers: rows.map(row => ({ id: row.id, name: row.name, pack_name: row.pack_name, url: '/uploads/stickers/' + row.filename })) });
      }
      next();
    } catch (err) {
      console.warn('[postgres-preview] HTTP bootstrap failed:', err.code || err.message);
      res.status(500).json({ error: 'Server error' });
    }
  });
}
module.exports = { installPostgresPreviewHttp };
