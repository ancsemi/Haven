'use strict';

module.exports = function registerHealth({ app }) {
  // ── Health check (CORS allowed for multi-server status pings) ──
  app.get('/api/health', async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Cross-Origin-Resource-Policy', 'cross-origin');
    res.set('Vary', 'Origin');
    let name = process.env.SERVER_NAME || 'Haven';
    let icon = null;
    let fingerprint = null;
    try {
      const { getAsyncDb } = require('../database');
      const db = getAsyncDb();
      const row = await db.prepare("SELECT value FROM server_settings WHERE key = 'server_name'").get();
      if (row && row.value) name = row.value;
      const iconRow = await db.prepare("SELECT value FROM server_settings WHERE key = 'server_icon'").get();
      if (iconRow && iconRow.value) icon = iconRow.value;
      const fpRow = await db.prepare("SELECT value FROM server_settings WHERE key = 'server_fingerprint'").get();
      if (fpRow && fpRow.value) fingerprint = fpRow.value;
    } catch { /* frequent unauthenticated ping: answer with the env defaults rather than fail or log */ }
    res.json({
      status: 'online',
      name,
      icon,
      fingerprint
      // version intentionally omitted: don't fingerprint the server for attackers
    });
  });
};
