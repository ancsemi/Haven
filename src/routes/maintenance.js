// Background jobs and the admin routes that drive them: auto-cleanup of old
// messages and files, scheduled backups, dynamic DNS and in-app updates.
// `late` holds values server.js creates after this file is loaded (the
// socket server, bot audio); they are read from it when a request needs them.

const fs = require('fs');
const path = require('path');
const { DATA_DIR, DB_PATH, UPLOADS_DIR, DELETED_ATTACHMENTS_DIR } = require('../paths');
const { purgeDeletedAttachments, resolveDeletedRetentionDays } = require('../deletedAttachments');
const { trimUploadsToLimit } = require('../uploadsTrim');
const { findOrphanDms } = require('../orphanDms');
const { verifyToken } = require('../auth');
const { getDdnsStatus, triggerDdnsNow } = require('../ddns');

module.exports = function registerMaintenance(deps) {
  const { app, UPLOAD_PATH_RE, isSafeUploadRelPath, moveUploadToDeleted, verifyAdminFromDb, buildBackupFile, db, late } = deps;
  // ── Auto-cleanup interval (runs every 15 minutes) ───────
  function runAutoCleanup() {
    try {
      const getSetting = (key) => {
        const row = db.prepare('SELECT value FROM server_settings WHERE key = ?').get(key);
        return row ? row.value : null;
      };

      // Deleted items never sit around forever. Attachments that message and
      // channel deletes park in deleted-attachments are removed for good once
      // they have been there longer than the retention window (a week unless
      // the admin changes it), whether or not auto-cleanup is switched on.
      try {
        const removed = purgeDeletedAttachments(
          DELETED_ATTACHMENTS_DIR, resolveDeletedRetentionDays(getSetting('deleted_retention_days')));
        if (removed > 0) console.log(`Auto-cleanup: removed ${removed} expired file(s) from deleted-attachments`);
      } catch (e) { console.error('deleted-attachments purge error:', e.message); }

      const enabled = getSetting('cleanup_enabled');
      if (enabled !== 'true') return;

      const maxAgeDays = parseInt(getSetting('cleanup_max_age_days') || '0');
      const maxSizeMb = parseInt(getSetting('cleanup_max_size_mb') || '0');
      let totalDeleted = 0;

      // Pull every /uploads/ attachment path out of a message body. Reuses the
      // shared UPLOAD_PATH_RE (global regex — reset lastIndex before each use).
      const extractUploadRelPaths = (content) => {
        const out = [];
        if (typeof content !== 'string' || !content) return out;
        UPLOAD_PATH_RE.lastIndex = 0;
        let m;
        while ((m = UPLOAD_PATH_RE.exec(content)) !== null) {
          if (isSafeUploadRelPath(m[1])) out.push(m[1]);
        }
        return out;
      };

      // Relocate the given attachment paths into deleted-attachments, but only
      // if no surviving message still references them (a file can be linked from
      // more than one message via copy/paste). This is the ONLY way auto-cleanup
      // removes files: it follows the messages it deletes. It never scans the
      // uploads/ directory directly, so avatars, persona avatars, custom emojis,
      // soundboard sounds, stickers, and the server icon are never at risk (#5423).
      const relocateOrphanAttachments = (relPaths) => {
        for (const rel of relPaths) {
          try {
            const like = '%/uploads/' + rel.replace(/[\\%_]/g, '\\$&') + '%';
            const still = db.prepare(
              "SELECT 1 FROM messages WHERE content LIKE ? ESCAPE '\\' LIMIT 1"
            ).get(like);
            if (!still) moveUploadToDeleted(rel, UPLOADS_DIR);
          } catch (err) {
            console.warn(`[cleanup] Could not check whether ${rel} is still referenced:`, err.message);
          }
        }
      };

      // 1. Delete messages older than N days (skip archived/pinned messages
      // and exempt channels)
      if (maxAgeDays > 0) {
        // Capture the attachments of the messages we're about to delete first,
        // so their files can follow them into deleted-attachments afterward.
        const doomed = db.prepare(
          "SELECT content FROM messages WHERE created_at < datetime('now', ?) AND is_archived = 0 AND id NOT IN (SELECT message_id FROM pinned_messages) AND channel_id NOT IN (SELECT id FROM channels WHERE cleanup_exempt = 1)"
        ).all(`-${maxAgeDays} days`);
        const doomedAttachments = new Set();
        for (const row of doomed) for (const p of extractUploadRelPaths(row.content)) doomedAttachments.add(p);

        // Delete reactions for old messages first
        db.prepare(`
        DELETE FROM reactions WHERE message_id IN (
          SELECT id FROM messages WHERE created_at < datetime('now', ?) AND is_archived = 0
          AND id NOT IN (SELECT message_id FROM pinned_messages)
          AND channel_id NOT IN (SELECT id FROM channels WHERE cleanup_exempt = 1)
        )
      `).run(`-${maxAgeDays} days`);
        const result = db.prepare(
          "DELETE FROM messages WHERE created_at < datetime('now', ?) AND is_archived = 0 AND id NOT IN (SELECT message_id FROM pinned_messages) AND channel_id NOT IN (SELECT id FROM channels WHERE cleanup_exempt = 1)"
        ).run(`-${maxAgeDays} days`);
        totalDeleted += result.changes;

        relocateOrphanAttachments(doomedAttachments);
      }

      // 2. If total DB size exceeds maxSizeMb, trim oldest messages (skip
      // archived and pinned)
      if (maxSizeMb > 0) {
        const dbPath = DB_PATH;
        const stats = require('fs').statSync(dbPath);
        const sizeMb = stats.size / (1024 * 1024);
        if (sizeMb > maxSizeMb) {
          // Delete oldest 10% of non-archived, non-pinned messages to bring
          // size down.
          const totalCount = db.prepare('SELECT COUNT(*) as cnt FROM messages WHERE is_archived = 0 AND id NOT IN (SELECT message_id FROM pinned_messages) AND channel_id NOT IN (SELECT id FROM channels WHERE cleanup_exempt = 1)').get().cnt;
          const deleteCount = Math.max(Math.floor(totalCount * 0.1), 100);
          const oldestRows = db.prepare(
            'SELECT id, content FROM messages WHERE is_archived = 0 AND id NOT IN (SELECT message_id FROM pinned_messages) AND channel_id NOT IN (SELECT id FROM channels WHERE cleanup_exempt = 1) ORDER BY created_at ASC LIMIT ?'
          ).all(deleteCount);
          const oldestIds = oldestRows.map(r => r.id);
          const trimmedAttachments = new Set();
          for (const row of oldestRows) for (const p of extractUploadRelPaths(row.content)) trimmedAttachments.add(p);
          if (oldestIds.length > 0) {
            // Chunk deletes to avoid creating extremely long SQL statements
            const CHUNK_SIZE = 1000;
            for (let i = 0; i < oldestIds.length; i += CHUNK_SIZE) {
              const chunk = oldestIds.slice(i, i + CHUNK_SIZE);
              const placeholders = chunk.map(() => '?').join(',');
              db.prepare(`DELETE FROM reactions WHERE message_id IN (${placeholders})`).run(...chunk);
              db.prepare(`DELETE FROM messages WHERE id IN (${placeholders})`).run(...chunk);
            }
            totalDeleted += oldestIds.length;
            relocateOrphanAttachments(trimmedAttachments);
          }
        }
      }

      // Uploads limit: once the uploads folder passes N MB, the oldest messages
      // with files go until it is back under. It runs in the background because
      // it has to add up the folder; see src/uploadsTrim.js.
      const maxUploadsMb = parseInt(getSetting('cleanup_max_uploads_mb') || '0');
      if (maxUploadsMb > 0) {
        trimUploadsToLimit({
          db, uploadsDir: UPLOADS_DIR, maxBytes: maxUploadsMb * 1024 * 1024,
          extractPaths: extractUploadRelPaths, move: (rel) => moveUploadToDeleted(rel, UPLOADS_DIR),
        }).then((r) => {
          if (r.deleted > 0) console.log(`Auto-cleanup: uploads were over ${maxUploadsMb} MB, removed ${r.deleted} old message(s) with files`);
        }).catch((e) => console.error('Uploads limit error:', e.message));
      }

      // Files in deleted-attachments are purged on their own clock at the top
      // of this run, whether or not cleanup is enabled. Nothing here scans the
      // main uploads/ directory: it also holds avatars, custom emojis,
      // soundboard sounds, stickers and the server icon, none of which are
      // posted media, and an allow-list approach kept eating whichever type
      // nobody remembered to list (#5423).

      // 3. (#5282) Orphan-DM sweep — delete any DM channel that has dropped
      // below 2 members (one or both participants deleted their account or
      // were force-removed). channel_members.user_id has ON DELETE CASCADE
      // so the row vanishes when the user does, but the DM channel itself
      // is left lingering with stale messages forever; this is the
      // "orphaned conversation" issue called out in #5282. Runs regardless
      // of cleanup_enabled so the data isn't retained indefinitely. Which
      // DMs count as orphaned is decided in src/orphanDms.js.
      try {
        const orphanRows = findOrphanDms(db);
        let orphansDeleted = 0;
        for (const ch of orphanRows) {
          try {
            // Move any /uploads/<file> referenced in this DM's messages to
            // deleted-attachments first so file cleanup doesn't lose track.
            const msgs = db.prepare('SELECT content FROM messages WHERE channel_id = ?').all(ch.id);
            const uploadRe = UPLOAD_PATH_RE;
            const seen = new Set();
            for (const m of msgs) {
              if (typeof m.content !== 'string') continue;
              uploadRe.lastIndex = 0;
              let mm;
              while ((mm = uploadRe.exec(m.content)) !== null) {
                if (isSafeUploadRelPath(mm[1])) seen.add(mm[1]);
              }
            }
            if (seen.size) {
              const deletedDir = path.join(UPLOADS_DIR, 'deleted-attachments');
              require('fs').mkdirSync(deletedDir, { recursive: true });
              for (const fn of seen) {
                moveUploadToDeleted(fn, UPLOADS_DIR);
              }
            }
            // Delete the channel — cascades to messages + read_positions +
            // channel_members + reactions etc. via the existing FKs.
            db.prepare('DELETE FROM channels WHERE id = ?').run(ch.id);
            for (const table of ['dm_group_keys', 'dm_group_epochs', 'dm_group_invites', 'dm_group_rewrap_requests']) {
              db.prepare(`DELETE FROM ${table} WHERE channel_id = ?`).run(ch.id);
            }
            orphansDeleted++;
          } catch (e) {
            console.error('[orphan-DM] failed to clean', ch.code, e.message);
          }
        }
        if (orphansDeleted > 0) {
          console.log(`🗑️  Auto-cleanup: removed ${orphansDeleted} orphan DM channel(s)`);
        }
      } catch (e) {
        console.warn('[orphan-DM] Sweep failed:', e.message);
      }

      if (totalDeleted > 0) {
        console.log(`🗑️  Auto-cleanup: deleted ${totalDeleted} old messages`);
      }
    } catch (err) {
      console.error('Auto-cleanup error:', err);
    }
  }

  // Run cleanup every 15 minutes
  setInterval(runAutoCleanup, 15 * 60 * 1000);

  // Encrypted DM files whose message was deleted (#5699; the trigger that notes
  // them is in src/database.js). Each goes to deleted-attachments like any other
  // deleted file, unless a message still points at it.
  function releaseDeletedE2eFiles() {
    try {
      const { getDb } = require('../database');
      const db = getDb();
      const rows = db.prepare('SELECT rel_path FROM released_uploads LIMIT 500').all();
      if (!rows.length) return;
      const inEncrypted = db.prepare(`
      SELECT 1 FROM messages m, json_each(m.e2e_files) j
      WHERE m.e2e_files IS NOT NULL AND json_valid(m.e2e_files) AND j.value = ? LIMIT 1`);
      const inContent = db.prepare("SELECT 1 FROM messages WHERE content LIKE ? ESCAPE '\\' LIMIT 1");
      const done = db.prepare('DELETE FROM released_uploads WHERE rel_path = ?');
      let moved = 0;
      for (const { rel_path: rel } of rows) {
        const like = '%/uploads/' + rel.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
        if (isSafeUploadRelPath(rel) && !inEncrypted.get(rel) && !inContent.get(like)) {
          moveUploadToDeleted(rel);
          moved++;
        }
        done.run(rel);
      }
      if (moved) console.log(`🗑️  Moved ${moved} file(s) from deleted encrypted messages to deleted-attachments`);
    } catch (err) {
      console.error('Releasing deleted encrypted files failed:', err.message);
    }
  }
  releaseDeletedE2eFiles();
  setInterval(releaseDeletedE2eFiles, 5 * 60 * 1000);
  // Also run once at startup (delayed 30s to let DB settle)
  setTimeout(runAutoCleanup, 30000);
  // Expose globally so socketHandlers can trigger it
  global.runAutoCleanup = runAutoCleanup;

  // ── Auto-backup (runs hourly, decides per server settings) ───────
  // Stored under DATA_DIR/auto-backups. Pruned to keep N most recent.
  const AUTO_BACKUP_DIR = path.join(DATA_DIR, 'auto-backups');
  function pruneAutoBackups(retain) {
    try {
      if (!fs.existsSync(AUTO_BACKUP_DIR)) return;
      const files = fs.readdirSync(AUTO_BACKUP_DIR)
        .filter(f => f.endsWith('.zip') && !f.startsWith('.'))
        .map(f => ({ name: f, full: path.join(AUTO_BACKUP_DIR, f), mtime: fs.statSync(path.join(AUTO_BACKUP_DIR, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      for (const f of files.slice(retain)) {
        try { fs.unlinkSync(f.full); } catch (err) {
          if (err.code !== 'ENOENT') console.warn(`[AutoBackup] Could not prune ${f.name}:`, err.message);
        }
      }
    } catch (err) {
      console.error('[AutoBackup] Prune failed:', err);
    }
  }

  async function runAutoBackup() {
    try {
      const getSetting = (key) => {
        const row = db.prepare('SELECT value FROM server_settings WHERE key = ?').get(key);
        return row ? row.value : null;
      };
      if (getSetting('auto_backup_enabled') !== 'true') return;
      const intervalH = Math.max(1, parseInt(getSetting('auto_backup_interval_hours') || '24'));
      const retain = Math.max(1, Math.min(50, parseInt(getSetting('auto_backup_retention') || '7')));
      const sectionsRaw = getSetting('auto_backup_sections') || 'channels,users,settings,messages';
      const include = sectionsRaw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

      const lastRunRaw = getSetting('auto_backup_last_run');
      const lastRun = lastRunRaw ? parseInt(lastRunRaw) : 0;
      const now = Date.now();
      if (lastRun && (now - lastRun) < intervalH * 60 * 60 * 1000) return;

      if (!fs.existsSync(AUTO_BACKUP_DIR)) fs.mkdirSync(AUTO_BACKUP_DIR, { recursive: true });

      // Stream to a .partial file first so a crash mid-write can't leave a
      // truncated .zip that pruning/restore would treat as valid, then rename in.
      const tmpOut = path.join(AUTO_BACKUP_DIR, `.partial-${Date.now()}-${Math.random().toString(36).slice(2)}.zip`);
      const { filePath, filename } = await buildBackupFile(include, tmpOut);
      const outPath = path.join(AUTO_BACKUP_DIR, filename);
      fs.renameSync(filePath, outPath);
      const sizeMB = (fs.statSync(outPath).size / 1024 / 1024).toFixed(2);
      db.prepare("INSERT OR REPLACE INTO server_settings (key, value) VALUES ('auto_backup_last_run', ?)").run(String(now));
      pruneAutoBackups(retain);
      console.log(`💾 Auto-backup written: ${filename} (${sizeMB} MB)`);
    } catch (err) {
      console.error('[AutoBackup] Failed:', err);
    }
  }

  // Check hourly whether it's time for an auto-backup. The function itself
  // honors the configured interval, so this can be cheap.
  setInterval(runAutoBackup, 60 * 60 * 1000);
  // First check 60s after boot so it doesn't fight with cleanup or migrations
  setTimeout(runAutoBackup, 60000);

  // ── Admin: list / download / delete / trigger auto-backups ─────
  app.get('/api/admin/auto-backups', (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    const user = token ? verifyToken(token) : null;
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    if (!verifyAdminFromDb(user)) return res.status(403).json({ error: 'Admin only' });
    try {
      if (!fs.existsSync(AUTO_BACKUP_DIR)) return res.json({ files: [] });
      const files = fs.readdirSync(AUTO_BACKUP_DIR)
        .filter(f => f.endsWith('.zip') && !f.startsWith('.'))
        .map(f => {
          const st = fs.statSync(path.join(AUTO_BACKUP_DIR, f));
          return { name: f, size: st.size, mtime: st.mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime);
      res.json({ files });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/admin/auto-backups/:name', (req, res) => {
    const token = req.query.token || req.headers.authorization?.split(' ')[1];
    const user = token ? verifyToken(token) : null;
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    if (!verifyAdminFromDb(user)) return res.status(403).json({ error: 'Admin only' });
    const name = req.params.name;
    // Path traversal guard: backups are flat zip files only.
    if (!/^[\w.-]+\.zip$/.test(name)) return res.status(400).json({ error: 'Invalid name' });
    const full = path.join(AUTO_BACKUP_DIR, name);
    if (!fs.existsSync(full) || !full.startsWith(AUTO_BACKUP_DIR)) return res.status(404).json({ error: 'Not found' });
    res.download(full, name);
  });

  app.delete('/api/admin/auto-backups/:name', (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    const user = token ? verifyToken(token) : null;
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    if (!verifyAdminFromDb(user)) return res.status(403).json({ error: 'Admin only' });
    const name = req.params.name;
    if (!/^[\w.-]+\.zip$/.test(name)) return res.status(400).json({ error: 'Invalid name' });
    const full = path.join(AUTO_BACKUP_DIR, name);
    if (!fs.existsSync(full) || !full.startsWith(AUTO_BACKUP_DIR)) return res.status(404).json({ error: 'Not found' });
    try { fs.unlinkSync(full); res.json({ ok: true }); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/admin/auto-backups/run-now', (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    const user = token ? verifyToken(token) : null;
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    if (!verifyAdminFromDb(user)) return res.status(403).json({ error: 'Admin only' });
    // Reset last-run so runAutoBackup definitely fires.
    try { db.prepare("DELETE FROM server_settings WHERE key = 'auto_backup_last_run'").run(); } catch (err) {
      console.warn('[AutoBackup] Could not reset last-run time, so this run may be skipped:', err.message);
    }
    setImmediate(runAutoBackup);
    res.json({ ok: true });
  });

  // ── Admin: dynamic DNS status + force-refresh ─────────────
  // Returns the last DDNS update result (provider, IP, ok/error, timestamp).
  // POST forces an immediate update — useful if the user just changed their
  // .env or believes the cached IP is stale (ISP rotation, VPN toggle, etc.).
  app.get('/api/admin/ddns/status', (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    const user = token ? verifyToken(token) : null;
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    if (!verifyAdminFromDb(user)) return res.status(403).json({ error: 'Admin only' });
    res.json(getDdnsStatus());
  });

  app.post('/api/admin/ddns/refresh', async (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    const user = token ? verifyToken(token) : null;
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    if (!verifyAdminFromDb(user)) return res.status(403).json({ error: 'Admin only' });
    try {
      const status = await triggerDdnsNow();
      res.json(status);
    } catch (err) {
      res.status(500).json({ error: (err && err.message) || 'Failed to refresh DDNS' });
    }
  });

  // ── Admin: in-app update check + run ─────────────────────
  // Detects how Haven was installed and returns the right command (or runs it).
  // Docker is intentionally NOT auto-runnable from inside the container — we just
  // surface the right command for the operator to run on the host.
  function detectInstallMethod() {
    const cwd = process.cwd();
    const inDocker = fs.existsSync('/.dockerenv') || process.env.HAVEN_IN_DOCKER === 'true';
    if (inDocker) return 'docker';
    if (fs.existsSync(path.join(cwd, '.git'))) return 'git';
    if (process.platform === 'win32' && fs.existsSync(path.join(cwd, 'Install Haven.bat'))) return 'windows-installer';
    if (fs.existsSync(path.join(cwd, 'install.sh'))) return 'shell-installer';
    return 'manual';
  }

  function getUpdateInstructions(method) {
    switch (method) {
      case 'docker': return {
        runnable: false,
        command: 'docker compose pull && docker compose up -d',
        message: 'Update from the host machine: cd into the haven-docker folder and run the command below.',
      };
      case 'git': return {
        runnable: true,
        command: 'git pull --ff-only && npm install --omit=dev',
        message: 'Pull latest from GitHub and reinstall dependencies. The server will exit after the update so your supervisor (systemd / Docker / installer service) restarts it on the new code.',
      };
      case 'windows-installer': return {
        runnable: true,
        command: '"Install Haven.bat" /update',
        message: 'Re-run the Windows installer in update mode. The server will exit so the installer can replace files and restart the service.',
      };
      case 'shell-installer': return {
        runnable: true,
        command: 'bash install.sh --update',
        message: 'Re-run the install script in update mode. The server will exit so the installer can refresh files and restart the service.',
      };
      default: return {
        runnable: false,
        message: 'Update method could not be detected. Pull the latest release from https://github.com/ancsemi/Haven/releases and replace your install manually.',
      };
    }
  }

  app.get('/api/admin/update/check', async (req, res) => {
    const token = req.query.token || req.headers.authorization?.split(' ')[1];
    const user = token ? verifyToken(token) : null;
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    if (!verifyAdminFromDb(user)) return res.status(403).json({ error: 'Admin only' });
    const currentVersion = require('../../package.json').version;
    const method = detectInstallMethod();
    const instructions = getUpdateInstructions(method);
    try {
      const r = await fetch('https://api.github.com/repos/ancsemi/Haven/releases/latest', {
        headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'haven-update-check' },
      });
      if (!r.ok) throw new Error(`GitHub HTTP ${r.status}`);
      const data = await r.json();
      const latestVersion = String(data.tag_name || '').replace(/^v/, '');
      const cmp = compareVersions(currentVersion, latestVersion);
      res.json({
        currentVersion,
        latestVersion,
        updateAvailable: cmp < 0,
        releaseUrl: data.html_url,
        releaseNotes: data.body || '',
        method,
        ...instructions,
      });
    } catch (err) {
      res.status(502).json({ error: 'Could not reach GitHub: ' + err.message, currentVersion, method, ...instructions });
    }
  });

  function compareVersions(a, b) {
    const pa = String(a).split('.').map(n => parseInt(n) || 0);
    const pb = String(b).split('.').map(n => parseInt(n) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      if ((pa[i] || 0) < (pb[i] || 0)) return -1;
      if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    }
    return 0;
  }

  app.post('/api/admin/update/run', (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    const user = token ? verifyToken(token) : null;
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    if (!verifyAdminFromDb(user)) return res.status(403).json({ error: 'Admin only' });
    const method = detectInstallMethod();
    const instructions = getUpdateInstructions(method);
    if (!instructions.runnable) {
      return res.status(400).json({ error: instructions.message, method });
    }
    // Trigger an auto-backup first so we have a rollback point.
    try { db.prepare("DELETE FROM server_settings WHERE key = 'auto_backup_last_run'").run(); } catch (err) {
      console.error('[Update] Could not reset auto-backup last-run time, so the pre-update backup may be skipped:', err.message);
    }
    try { runAutoBackup(); } catch (err) { console.error('[Update] Pre-update backup failed:', err); }

    res.json({ ok: true, method, message: instructions.message });

    // Run the update command in a detached child process so the parent can exit cleanly.
    const { spawn } = require('child_process');
    console.log(`🔄 [Update] Running update command for method=${method}: ${instructions.command}`);
    setTimeout(() => {
      try {
        const child = spawn(instructions.command, {
          cwd: process.cwd(),
          shell: true,
          detached: true,
          stdio: 'ignore',
        });
        child.unref();
      } catch (err) {
        console.error('[Update] Failed to spawn update command:', err);
      }
      // Give the child a moment to start, then exit so the supervisor restarts us.
      setTimeout(() => {
        console.log('🔄 [Update] Exiting so supervisor restarts on new code…');
        late.botAudioManager?.shutdown();
        process.exit(0);
      }, 1500);
    }, 1500);
  });

};
