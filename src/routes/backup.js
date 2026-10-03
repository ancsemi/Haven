// Backup download (GET /api/admin/backup) and restore (POST /api/admin/restore),
// admin only. A restore is staged on disk, then swapped in while the server
// exits, so the process supervisor starts Haven again on the restored data.
// `late` holds values server.js creates after this file is loaded (the
// socket server, bot audio); they are read from it when a request needs them.

const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { DATA_DIR, DB_PATH, UPLOADS_DIR } = require('../paths');
const { verifyToken } = require('../auth');
const { extractFullBackup } = require('../backupExtract');

module.exports = function registerBackup(deps) {
  const { app, verifyAdminFromDb, late } = deps;
  // ── Admin: Server backup download (admin only) ──
  // Configurable per-section via ?include=channels,users,settings,messages,files
  // Backwards-compat: ?mode=structure → channels,users,settings ;
  //                   ?mode=full      → channels,users,settings,messages,files
  // Token may be passed via ?token=... so the browser can trigger a normal download.
  const ALL_BACKUP_SECTIONS = ['channels', 'users', 'settings', 'messages', 'dms', 'files'];

  // Resolve the requested sections into a concrete backup plan (sync, no IO).
  function backupPlan(includeRaw) {
    let include = Array.isArray(includeRaw)
      ? includeRaw.map(s => String(s).trim().toLowerCase()).filter(s => ALL_BACKUP_SECTIONS.includes(s))
      : ALL_BACKUP_SECTIONS.slice();
    if (!include.length) include = ALL_BACKUP_SECTIONS.slice();
    const has = (s) => include.includes(s);
    const mode = (has('messages') && has('files')) ? 'full' : 'partial';
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `haven-backup-${mode === 'full' ? 'full' : include.join('-')}-${ts}.zip`;
    return { include, has, mode, filename };
  }

  // Build a backup zip and pipe it into `destStream` (a file write stream OR the
  // HTTP response). Resolves when the archive has been fully written.
  //
  // Everything is streamed via `archiver` rather than built in memory. The old
  // adm-zip path called `zip.toBuffer()`, holding every upload plus the whole
  // compressed archive in RAM at once — a ~30GB backup blew past Node's Buffer
  // limit (RangeError) and the heap (OOM), crashing the server. Streaming to the
  // response (instead of building a temp file first) also means bytes start
  // flowing immediately, so a large manual download no longer sits silent long
  // enough for a proxy in front of Haven to time out with a 502. See issue #5434.
  function pipeBackupArchive(plan, destStream) {
    const archiver = require('archiver');
    const { include, has, mode } = plan;

    return new Promise((resolve, reject) => {
      let tmpDb = null;
      let settled = false;
      const cleanup = () => {
        if (!tmpDb) return;
        try { fs.unlinkSync(tmpDb); } catch (err) {
          // Missing just means VACUUM INTO never wrote it. Anything else leaves a
          // full copy of the database lying in the data folder.
          if (err.code !== 'ENOENT') console.warn('[Backup] Could not remove temporary database copy:', err.message);
        }
      };
      // Resolve/reject exactly once, always after the temp DB clone is removed.
      const finish = (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (err) reject(err);
        else resolve(plan);
      };

      try {
        const { getDb } = require('../database');
        const db = getDb();

        const archive = archiver('zip', { zlib: { level: 6 } });
        // 'finish' fires for both fs write streams and the HTTP response once all
        // bytes are written; 'close' covers a client that disconnects mid-stream.
        destStream.on('finish', () => finish());
        destStream.on('close', () => finish());
        destStream.on('error', finish);
        archive.on('error', finish);
        // ENOENT here just means a file vanished mid-walk (e.g. an attachment was
        // deleted) — skip it rather than failing the whole backup.
        archive.on('warning', (w) => { if (w.code !== 'ENOENT') finish(w); });
        archive.pipe(destStream);

        const manifest = {
          app: 'haven',
          version: require('../../package.json').version,
          exportedAt: new Date().toISOString(),
          mode,
          include,
          serverName: process.env.SERVER_NAME || 'Haven',
        };
        archive.append(Buffer.from(JSON.stringify(manifest, null, 2)), { name: 'manifest.json' });

        const structureTables = [];
        if (has('channels')) structureTables.push('channels', 'roles', 'role_permissions', 'user_roles', 'channel_members');
        if (has('users')) structureTables.push('users');
        if (has('settings')) structureTables.push('server_settings', 'whitelist');

        if (structureTables.length) {
          const data = {};
          for (const tbl of structureTables) {
            try { data[tbl] = db.prepare(`SELECT * FROM ${tbl}`).all(); }
            catch { data[tbl] = []; }
          }
          // Filter out DM channels (and their members) when DMs aren't included.
          // DM bodies are E2E-encrypted, but the channel rows still leak who
          // talked to whom — keep the metadata out unless the admin opted in.
          if (!has('dms') && data.channels) {
            const dmChannelIds = new Set(data.channels.filter(c => c.is_dm).map(c => c.id));
            data.channels = data.channels.filter(c => !c.is_dm);
            if (data.channel_members) {
              data.channel_members = data.channel_members.filter(m => !dmChannelIds.has(m.channel_id));
            }
          }
          if (data.users) {
            data.users = data.users.map(u => {
              const safe = { ...u };
              delete safe.password_hash;
              delete safe.password_version;
              delete safe.totp_secret;
              delete safe.totp_backup_codes;
              delete safe.recovery_codes_hash;
              delete safe.recovery_codes;
              delete safe.email;
              return safe;
            });
          }
          if (data.server_settings) {
            const SENSITIVE_KEYS = new Set(['vanity_code', 'server_invite_code']);
            data.server_settings = data.server_settings.filter(r => !SENSITIVE_KEYS.has(r.key));
          }
          archive.append(Buffer.from(JSON.stringify(data, null, 2)), { name: 'structure.json' });
        }

        if (has('messages')) {
          tmpDb = path.join(DATA_DIR, `.backup-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
          try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* optional tidy-up; VACUUM INTO reads a consistent snapshot either way */ }
          const safePath = tmpDb.replace(/'/g, "''");
          db.prepare(`VACUUM INTO '${safePath}'`).run();
          // If DMs are NOT included, scrub them from the cloned DB so the backup
          // doesn't ship encrypted-but-still-private DM ciphertext (or attachment
          // refs) to wherever the admin stores their backup files.
          if (!has('dms')) {
            const Database = require('better-sqlite3');
            const tmp = new Database(tmpDb);
            try {
              tmp.exec('DELETE FROM messages WHERE channel_id IN (SELECT id FROM channels WHERE is_dm = 1)');
              tmp.exec('DELETE FROM channels WHERE is_dm = 1');
              tmp.exec('VACUUM');
            } finally {
              tmp.close();
            }
          }
          // Streamed from disk during finalize; the temp clone is unlinked in finish().
          archive.file(tmpDb, { name: 'haven.db' });
        }

        if (has('files') && fs.existsSync(UPLOADS_DIR)) {
          const walk = (dir, rel) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
              if (entry.name === 'deleted-attachments') continue;
              if (!rel && entry.name === 'bot-audio') continue;
              const full = path.join(dir, entry.name);
              const sub = rel ? `${rel}/${entry.name}` : entry.name;
              try {
                if (entry.isFile()) archive.file(full, { name: `uploads/${sub}` });
                else if (entry.isDirectory()) walk(full, sub);
              } catch (err) {
                // Keep going, but the backup is missing these files, so say so.
                console.warn(`[Backup] Skipped uploads/${sub}:`, err.message);
              }
            }
          };
          walk(UPLOADS_DIR, '');
        }

        archive.finalize();
      } catch (err) {
        finish(err);
      }
    });
  }

  // Build a backup zip to a file on disk (used by the auto-backup scheduler).
  // Returns a Promise<{ filePath, filename, mode, include }>.
  function buildBackupFile(includeRaw, outPath) {
    const plan = backupPlan(includeRaw);
    const output = fs.createWriteStream(outPath);
    return pipeBackupArchive(plan, output)
      .then(() => ({ filePath: outPath, filename: plan.filename, mode: plan.mode, include: plan.include }))
      .catch((err) => { try { fs.unlinkSync(outPath); } catch { /* partial zip may not exist; the real error is rethrown */ } throw err; });
  }

  app.get('/api/admin/backup', async (req, res) => {
    const token = req.query.token || req.headers.authorization?.split(' ')[1];
    const user = token ? verifyToken(token) : null;
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    if (!verifyAdminFromDb(user)) return res.status(403).json({ error: 'Admin only' });

    // Resolve which sections to include
    let include = [];
    if (typeof req.query.include === 'string' && req.query.include.trim()) {
      include = req.query.include.split(',');
    } else if (req.query.mode === 'full') {
      include = ALL_BACKUP_SECTIONS.slice();
    } else {
      include = ['channels', 'users', 'settings'];
    }

    // Stream the zip straight to the response. Building a temp file first meant a
    // large (30GB) backup produced no response for minutes, so a proxy in front of
    // Haven returned 502 and the download "failed" (#5434). Piping to res starts
    // the bytes immediately and keeps the connection active; clear the inactivity
    // timeout since a big backup takes longer than the 2 min socket timeout.
    req.setTimeout(0);
    res.setTimeout(0);
    const plan = backupPlan(include);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${plan.filename}"`);
    try {
      await pipeBackupArchive(plan, res);
    } catch (err) {
      console.error('[Backup] Failed:', err);
      if (!res.headersSent) res.status(500).json({ error: 'Backup failed: ' + err.message });
      else { try { res.destroy(); } catch { /* response may already be closed; failure was logged above */ } }
    }
  });

  // ── Admin: Server backup restore (admin only, full backups only) ──
  // Stages the uploaded backup, then schedules a process exit so the
  // supervisor (Docker / systemd / installer service) restarts the server
  // with the restored DB and uploads in place. The pre-restore data is
  // preserved at haven.db.pre-restore / uploads.pre-restore for one cycle.
  const restoreUpload = multer({
    dest: path.join(DATA_DIR, 'tmp-restore'),
    // Admin-only endpoint. A full backup that includes files can be very large
    // (reporters hit 15GB+), and the old 4GB cap rejected the upload part-way,
    // which surfaced to the browser as a "failed to fetch" (#5436). The practical
    // limit is the host's disk, not this number.
    limits: { fileSize: 512 * 1024 * 1024 * 1024 },
  });

  app.post('/api/admin/restore', (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    const user = token ? verifyToken(token) : null;
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    if (!verifyAdminFromDb(user)) return res.status(403).json({ error: 'Admin only' });

    // A large restore uploads a multi-GB body and then stages it to disk, both of
    // which run far longer than the 2 min socket inactivity timeout. Clear the
    // timeout on this admin-only connection so it isn't killed mid-restore (#5436).
    req.setTimeout(0);
    res.setTimeout(0);

    const tmpDir = path.join(DATA_DIR, 'tmp-restore');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

    restoreUpload.single('backup')(req, res, async (err) => {
      if (err) return res.status(400).json({ error: err.message });
      if (!req.file) return res.status(400).json({ error: 'No backup file uploaded' });

      const cleanupTmp = () => {
        try { fs.unlinkSync(req.file.path); } catch (err) {
          // The upload can be many GB, so a leftover copy is worth knowing about.
          if (err.code !== 'ENOENT') console.warn('[Restore] Could not remove uploaded backup temp file:', err.message);
        }
      };
      const stagedDb = DB_PATH + '.restore';
      const stagedUploads = UPLOADS_DIR + '.restore';

      // Push extraction progress to the requesting admin's live socket(s) so the
      // restore UI can show a real "extracting" bar during the long staging step.
      const sendRestoreProgress = (p) => {
        if (!late.io) return;
        for (const [, s] of late.io.sockets.sockets) {
          if (s.user && s.user.id === user.id) { try { s.emit('restore-progress', p); } catch { /* socket may have disconnected */ } }
        }
      };

      let manifest;
      try {
        manifest = await extractFullBackup(req.file.path, stagedDb, stagedUploads, sendRestoreProgress);
      } catch (e) {
        cleanupTmp();
        try { fs.unlinkSync(stagedDb); } catch (err2) {
          if (err2.code !== 'ENOENT') console.warn('[Restore] Could not remove staged database:', err2.message);
        }
        try { fs.rmSync(stagedUploads, { recursive: true, force: true }); } catch (err2) {
          console.warn('[Restore] Could not remove staged uploads:', err2.message);
        }
        const status = e && e.status ? e.status : 500;
        if (status === 500) console.error('[Restore] Failed:', e);
        if (!res.headersSent) res.status(status).json({ error: status === 500 ? ('Restore failed: ' + e.message) : e.message });
        return;
      }

      cleanupTmp();
      res.json({
        ok: true,
        message: 'Backup staged. Server will restart in ~2 seconds to apply. If the server does not come back up, your hosting setup may not auto-restart — start Haven manually.',
        scheduled: true,
      });

      // Apply swap and exit so the supervisor restarts us cleanly
      setTimeout(() => {
        console.log('🔄 Applying staged backup restore and restarting...');
        late.botAudioManager?.shutdown();
        try {
          if (fs.existsSync(stagedDb)) {
            const liveDb = require('../database').getDb();
            // Fold recent writes from the WAL into haven.db first, so the safety
            // copy below has everything, not just what was last checkpointed.
            try {
              const [cp] = liveDb.pragma('wal_checkpoint(TRUNCATE)');
              if (cp && cp.busy) console.warn('[Restore] The database was busy during the checkpoint, so haven.db.pre-restore may miss the last few writes');
            } catch (err2) {
              console.warn('[Restore] Could not checkpoint the database before copying it:', err2.message);
            }
            try { fs.copyFileSync(DB_PATH, DB_PATH + '.pre-restore'); } catch (err2) {
              // Without a copy of the current database, the restore would leave
              // no way back, so it is not applied and the server comes back up
              // on the database it has now.
              throw new Error(`Could not save haven.db.pre-restore (${err2.message}), so the restore was not applied; the server restarts on its current database`);
            }
            // Close the database before swapping files. Windows will not replace
            // or delete a file that is still open, so without this the restore
            // never took effect there. Closing also removes the WAL and SHM.
            liveDb.close();
            try { fs.unlinkSync(DB_PATH + '-wal'); } catch (err2) {
              if (err2.code !== 'ENOENT') console.error('[Restore] Could not remove old haven.db-wal:', err2.message);
            }
            try { fs.unlinkSync(DB_PATH + '-shm'); } catch (err2) {
              if (err2.code !== 'ENOENT') console.error('[Restore] Could not remove old haven.db-shm:', err2.message);
            }
            fs.renameSync(stagedDb, DB_PATH);
          }
          if (fs.existsSync(stagedUploads)) {
            const oldUploads = UPLOADS_DIR + '.pre-restore';
            if (fs.existsSync(oldUploads)) fs.rmSync(oldUploads, { recursive: true, force: true });
            if (fs.existsSync(UPLOADS_DIR)) fs.renameSync(UPLOADS_DIR, oldUploads);
            fs.renameSync(stagedUploads, UPLOADS_DIR);
          }
        } catch (e) {
          console.error('[Restore] Swap failed:', e);
          // Whatever was not applied is removed: a staged copy can be gigabytes,
          // and the backup file it came from is still with the admin.
          try { fs.rmSync(stagedDb, { force: true }); } catch (err2) {
            console.error('[Restore] Could not remove the staged database:', err2.message);
          }
          try { fs.rmSync(stagedUploads, { recursive: true, force: true }); } catch (err2) {
            console.error('[Restore] Could not remove the staged uploads:', err2.message);
          }
        }
        process.exit(0);
      }, 1500);
    });
  });

  return { buildBackupFile };
};
