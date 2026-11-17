// Server templates (admin only): download this server's layout as one file,
// or upload one, preview what it would change and apply it. The template
// logic itself is in src/serverTemplate.js. `late` holds values server.js
// creates after this file is loaded (the socket server and the socket
// runtime); they are read from it when a request needs them.

const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { verifyToken } = require('../auth');
const serverTemplate = require('../serverTemplate');

module.exports = function registerServerTemplate(deps) {
  const { app, verifyAdminFromDb, uploadLimiter, uploadDiskGuard, THEMES_DIR, late } = deps;
  const pendingTemplates = new Map();
  const templateAdmin = (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    const user = token ? verifyToken(token) : null;
    return user && verifyAdminFromDb(user) ? user : (res.status(403).json({ error: 'Admin only' }), null);
  };
  const templateOptions = (body) => ({ mode: body.mode === 'replace' ? 'replace' : 'merge', posts: body.posts !== false, webhooks: body.webhooks !== false, joinMembers: body.joinMembers !== false });
  const templateUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: serverTemplate.LIMITS.bytes, files: 1, fields: 4 } }).single('template');
  app.get('/api/admin/template/export', async (req, res) => {
    const user = templateAdmin(req, res);
    if (!user) return;
    try {
      const db = require('../database').getDb();
      const { template, warnings } = await serverTemplate.exportTemplate(db, {
        themesDir: THEMES_DIR, posts: req.query.posts === 'none' ? 'none' : 'pinned', assets: req.query.assets !== '0', havenVersion: require('../../package.json').version,
        meta: { name: typeof req.query.name === 'string' ? req.query.name.slice(0, 60) : '', description: typeof req.query.description === 'string' ? req.query.description.slice(0, 500) : '' },
      });
      const slug = (template.meta.name || 'haven').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'haven';
      res.setHeader('Content-Disposition', `attachment; filename="${slug}.haven-template.json"`);
      res.setHeader('X-Template-Warnings', String(warnings.length));
      res.type('application/json').send(JSON.stringify(template, null, 2));
    } catch (err) {
      console.error('Template export failed:', err.message);
      res.status(500).json({ error: 'Template export failed' });
    }
  });
  app.post('/api/admin/template/upload', uploadLimiter, uploadDiskGuard, (req, res) => {
    const user = templateAdmin(req, res);
    if (!user) return;
    templateUpload(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Templates can be at most 12 MB' : 'Upload failed' });
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
      let json;
      try { json = JSON.parse(req.file.buffer.toString('utf8')); } catch { return res.status(400).json({ error: 'That file is not valid JSON' }); }
      const result = serverTemplate.validateTemplate(json);
      if (result.errors) return res.status(400).json({ error: 'That template is not valid', details: result.errors });
      for (const [key, entry] of pendingTemplates) if (Date.now() - entry.at > 30 * 60 * 1000 || entry.userId === user.id) pendingTemplates.delete(key);
      if (pendingTemplates.size >= 10) pendingTemplates.delete(pendingTemplates.keys().next().value);
      const id = crypto.randomBytes(16).toString('hex');
      pendingTemplates.set(id, { template: result.template, userId: user.id, at: Date.now() });
      res.json({ id, summary: serverTemplate.summarizeTemplate(result.template), warnings: result.warnings });
    });
  });
  const pendingTemplate = (req, res, user) => {
    const entry = typeof req.body?.id === 'string' && pendingTemplates.get(req.body.id);
    return entry && entry.userId === user.id ? entry : (res.status(404).json({ error: 'That upload has expired. Choose the file again.' }), null);
  };
  const runTemplate = (entry, user, body, dryRun) => serverTemplate.applyTemplate(require('../database').getDb(), entry.template, {
    ...templateOptions(body), actorId: user.id, themesDir: THEMES_DIR, dryRun,
  });
  app.post('/api/admin/template/plan', express.json({ limit: '4kb' }), async (req, res) => {
    const user = templateAdmin(req, res);
    const entry = user && pendingTemplate(req, res, user);
    if (!entry) return;
    try { res.json(await runTemplate(entry, user, req.body, true)); } catch (err) {
      console.error('Template plan failed:', err.message);
      res.status(500).json({ error: 'Could not work out what the template would change' });
    }
  });
  app.post('/api/admin/template/apply', express.json({ limit: '4kb' }), async (req, res) => {
    const user = templateAdmin(req, res);
    const entry = user && pendingTemplate(req, res, user);
    if (!entry) return;
    let report;
    try { report = await runTemplate(entry, user, req.body, false); } catch (err) {
      if (err.code === 'TEMPLATE_DISK_FULL') return res.status(507).json({ error: err.message });
      console.error('Template apply failed:', err.message);
      return res.status(500).json({ error: 'Applying the template failed; nothing was changed' });
    }
    pendingTemplates.delete(req.body.id);
    try {
      const runtime = late.socketRuntime;
      const effects = runtime.settingEffects;
      require('../automod').invalidate();
      runtime.syncRoleGateMemberships();
      runtime.broadcastChannelLists();
      // Holders of a role the template created or changed get their new
      // permissions now, as when a role is edited in Settings.
      runtime.refreshRoleHolders(Object.values(report.rolePermissions).map((x) => x.id));
      late.io.except('bot-sockets').emit('roles-updated');
      // Each changed setting goes out live and sets off, and is logged, just
      // as if it had been saved on the settings screen.
      for (const [key, value] of Object.entries(report.changedSettings)) {
        effects.emitSettingChanged(key, value);
        effects.afterSettingSaved(key, value);
        effects.auditSettingChange(user, key, value);
      }
      if (report.counts.domains) effects.broadcastLinkPolicy();
      if (report.created.emojis.length) late.io.emit('library-updated', { kind: 'emojis' });
      if (report.created.stickers.length) late.io.emit('library-updated', { kind: 'stickers' });
      const names = (list) => (list.length > 15 ? [...list.slice(0, 15), `and ${list.length - 15} more`] : list);
      runtime.logAudit({
        actor: user, action: 'server_template_apply', target_type: 'server', target_name: entry.template.meta.name || '',
        details: {
          mode: report.mode,
          created: { roles: names(report.created.roles), channels: names(report.created.channels), webhooks: report.created.webhooks.length, emojis: report.created.emojis.length, stickers: report.created.stickers.length },
          updated: { roles: names(report.updated.roles), channels: names(report.updated.channels) },
          settings: report.updated.settings.length, posts: report.counts.posts, roleMenus: report.counts.roleMenus, linkRules: report.counts.domains,
        },
      });
      // One entry per role the template created or changed, with what it may do.
      for (const [name, { id, ...role }] of Object.entries(report.rolePermissions)) {
        runtime.logAudit({ actor: user, action: report.created.roles.includes(name) ? 'role_create' : 'role_update', target_type: 'role', target_id: id, target_name: name, details: { ...role, via: 'server template' } });
      }
    } catch (err) { console.error('Template follow-up failed:', err.message); }
    res.json(report);
  });
};
