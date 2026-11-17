// Plugin and theme update endpoints (admin only, #5578). The updater itself
// is src/extensionUpdates.js; these routes check who is asking. `late` holds
// values server.js creates after this file is loaded (the socket server).

module.exports = function registerExtensionUpdates(deps) {
  const { app, verifyToken, verifyAdminFromDb, extensionUpdater, late } = deps;

  // ── Plugin & theme update endpoints ────────────────────
  // Explicit admin actions only. Do not use JWT admin claims: permissions may
  // have changed since sign-in. Scoped account-linking tokens are not sessions.
  app.post('/api/admin/extensions/check', async (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    const user = token ? verifyToken(token) : null;
    if (!user || user.purpose) return res.status(401).json({ error: 'Unauthorized' });
    if (!verifyAdminFromDb(user)) return res.status(403).json({ error: 'Admin only' });
    res.set('Cache-Control', 'no-store');

    try {
      res.json(await extensionUpdater.check(user.id));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/admin/extensions/apply', async (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    const user = token ? verifyToken(token) : null;
    if (!user || user.purpose) return res.status(401).json({ error: 'Unauthorized' });
    if (!verifyAdminFromDb(user)) return res.status(403).json({ error: 'Admin only' });
    res.set('Cache-Control', 'no-store');

    try {
      // Downloading can take time. Recheck current admin status immediately
      // before replacement, not just when the HTTP request arrives.
      const result = await extensionUpdater.apply(req.body?.token, user.id, () => verifyAdminFromDb(user));
      // io is initialized before the server accepts requests. Notify clients
      // after replacement; they keep their running extensions until reload.
      late.io.emit('extensions-updated');
      require('../httpAudit').auditHttp(user, 'extensions_update', { details: { version: result && result.version } });
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });
};
