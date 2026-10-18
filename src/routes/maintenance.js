// Background jobs and the admin routes that drive them: auto-cleanup of old
// messages and files, scheduled backups, dynamic DNS and in-app updates.
// `late` holds values server.js creates after this file is loaded (the
// socket server, bot audio); they are read from it when a request needs them.

const releaseChannel = require('../releaseChannel');
const fs = require('fs');
const path = require('path');
const { DATA_DIR, DB_PATH, UPLOADS_DIR } = require('../paths');
const { purgeDeletedAttachments, resolveDeletedRetentionDays } = require('../deletedAttachments');
const storage = require('../storage');
const { trimUploadsToLimit } = require('../uploadsTrim');
const { findOrphanDms } = require('../orphanDms');
const protectedMessages = require('../protectedMessages');

// What auto-cleanup may remove from a message table aliased m: not protected
// (nor a thread head holding a protected reply), not pinned, and not in a
// channel exempt from cleanup.
const CLEANABLE = `${protectedMessages.deletableSql('m')} AND m.id NOT IN (SELECT message_id FROM pinned_messages) AND m.channel_id NOT IN (SELECT id FROM channels WHERE cleanup_exempt = 1)`;
const { verifyToken } = require('../auth');
const { takeTicket } = require('../adminReauth');
const { getDdnsStatus, triggerDdnsNow } = require('../ddns');

module.exports = function registerMaintenance(deps) {
  const { app, UPLOAD_PATH_RE, isSafeUploadRelPath, moveUploadToDeleted, verifyAdminFromDb, buildBackupFile, db, late } = deps;
  // ── Auto-cleanup interval (runs every 15 minutes) ───────
  async function runAutoCleanup() {
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
        const removed = await purgeDeletedAttachments(
          db, storage, resolveDeletedRetentionDays(getSetting('deleted_retention_days')));
        if (removed > 0) console.log(`Auto-cleanup: removed ${removed} expired file(s) from deleted-attachments`);
      } catch (e) { console.error('deleted-attachments purge error:', e.message); }

      const enabled = getSetting('cleanup_enabled');
      if (enabled !== 'true') return;

      const maxAgeDays = parseInt(getSetting('cleanup_max_age_days') || '0');
      const maxSizeMb = parseInt(getSetting('cleanup_max_size_mb') || '0');
      let totalDeleted = 0;

      // Pull every /uploads/ attachment path out of a message body. Reuses the
      // shared UPLOAD_PATH_RE (global regex, so reset lastIndex before each use).
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
      const relocateOrphanAttachments = async (relPaths) => {
        for (const rel of relPaths) {
          try {
            const like = '%/uploads/' + rel.replace(/[\\%_]/g, '\\$&') + '%';
            const still = db.prepare(
              "SELECT 1 FROM messages WHERE content LIKE ? ESCAPE '\\' LIMIT 1"
            ).get(like);
            if (!still) await moveUploadToDeleted(rel);
          } catch (err) {
            console.warn(`[cleanup] Could not check whether ${rel} is still referenced:`, err.message);
          }
        }
      };

      // 1. Delete messages older than N days (skip protected and pinned
      // messages, thread heads holding a protected reply, and exempt channels)
      if (maxAgeDays > 0) {
        const oldSql = `SELECT m.id FROM messages m WHERE m.created_at < datetime('now', ?) AND ${CLEANABLE}`;
        // Capture the attachments of the messages we're about to delete first,
        // so their files can follow them into deleted-attachments afterward.
        const doomed = db.prepare(
          `SELECT content FROM messages WHERE id IN (${oldSql})`
        ).all(`-${maxAgeDays} days`);
        const doomedAttachments = new Set();
        for (const row of doomed) for (const p of extractUploadRelPaths(row.content)) doomedAttachments.add(p);

        // Delete reactions for old messages first
        db.prepare(`DELETE FROM reactions WHERE message_id IN (${oldSql})`).run(`-${maxAgeDays} days`);
        const result = db.prepare(`DELETE FROM messages WHERE id IN (${oldSql})`).run(`-${maxAgeDays} days`);
        totalDeleted += result.changes;

        await relocateOrphanAttachments(doomedAttachments);
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
          const totalCount = db.prepare(`SELECT COUNT(*) as cnt FROM messages m WHERE ${CLEANABLE}`).get().cnt;
          const deleteCount = Math.max(Math.floor(totalCount * 0.1), 100);
          const oldestRows = db.prepare(
            `SELECT m.id, m.content FROM messages m WHERE ${CLEANABLE} ORDER BY m.created_at ASC LIMIT ?`
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
            await relocateOrphanAttachments(trimmedAttachments);
          }
        }
      }

      // Uploads limit: once the uploads folder passes N MB, the oldest messages
      // with files go until it is back under. It runs in the background because
      // it has to add up the folder; see src/uploadsTrim.js.
      const maxUploadsMb = parseInt(getSetting('cleanup_max_uploads_mb') || '0');
      if (maxUploadsMb > 0) {
        trimUploadsToLimit({
          db, localDirs: [path.join(UPLOADS_DIR, 'bot-audio')], maxBytes: maxUploadsMb * 1024 * 1024,
          extractPaths: extractUploadRelPaths, move: (rel) => moveUploadToDeleted(rel),
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

      // 3. (#5282) Orphan-DM sweep: delete any DM channel that has dropped
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
            // A DM holding protected messages stays, and only the rest of
            // it goes. Their files stay where they are.
            if (protectedMessages.protectedCount(db, [ch.id])) {
              if (db.prepare(`SELECT 1 FROM messages m WHERE m.channel_id = ? AND ${protectedMessages.deletableSql('m')} LIMIT 1`).get(ch.id)) {
                protectedMessages.keepChannel(db, ch, 'orphaned DM');
              }
              continue;
            }
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
            for (const fn of seen) await moveUploadToDeleted(fn);
            // Delete the channel: cascades to messages + read_positions +
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
  async function releaseDeletedE2eFiles() {
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
          await moveUploadToDeleted(rel);
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
      if (include.includes('files') && storage.getStorage().kind === 's3') {
        console.warn('[AutoBackup] Files are included, so every run copies the whole bucket into the backup; the bucket is usually the better backup of the files themselves');
      }

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

  // Downloaded with a one-time ticket (POST /api/admin/download-ticket),
  // not the session token in the URL.
  app.get('/api/admin/auto-backups/:name', (req, res) => {
    const entry = takeTicket(req.query.ticket, 'auto-backup');
    if (!entry || entry.data.name !== req.params.name) return res.status(401).json({ error: 'This download link has expired. Try again.' });
    if (!verifyAdminFromDb({ id: entry.userId })) return res.status(403).json({ error: 'Admin only' });
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

  // ── Admin: rebuild the media index from storage ───────────
  // For after files were added or removed outside Haven (a restore by hand,
  // a bucket tool); scripts/reconcile-media.js does the same from a shell.
  app.post('/api/admin/media/reconcile', async (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    const user = token ? verifyToken(token) : null;
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    if (!verifyAdminFromDb(user)) return res.status(403).json({ error: 'Admin only' });
    try {
      const summary = await require('../storage/reconcile').reconcile(db, storage.getStorage());
      console.log(`[storage] Media index reconciled: ${summary.added} added, ${summary.fixed} corrected, ${summary.dropped} dropped`);
      res.json(summary);
    } catch (err) {
      console.error('[storage] Reconcile failed:', err.message);
      res.status(500).json({ error: 'Could not read storage' });
    }
  });

  // ── Admin: dynamic DNS status + force-refresh ─────────────
  // Returns the last DDNS update result (provider, IP, ok/error, timestamp).
  // POST forces an immediate update, useful if the user just changed their
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
  // Docker is intentionally NOT auto-runnable from inside the container; we just
  // surface the right command for the operator to run on the host.
  // The code folder, which is where the updater works, whatever folder Haven
  // was started from.
  const CODE_DIR = path.resolve(__dirname, '..', '..');
  function detectInstallMethod() {
    const cwd = CODE_DIR;
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
        mode: 'git',
        command: 'node scripts/update.js git',
        message: 'Haven pulls the latest code from GitHub, reinstalls dependencies and starts again. It is offline for a minute or two; this page reconnects by itself.',
      };
      // Install Haven.bat, install.sh and release zips have no git history, so
      // the updater downloads the latest release and copies it over the code.
      case 'windows-installer':
      case 'shell-installer': return {
        runnable: true,
        mode: 'release',
        command: 'node scripts/update.js release',
        message: 'Haven downloads the latest release, installs it and starts again. It is offline for a minute or two; this page reconnects by itself. Your data folder is not touched.',
      };
      default: return {
        runnable: false,
        message: 'Update method could not be detected. Pull the latest release from https://github.com/ancsemi/Haven/releases and replace your install manually.',
      };
    }
  }

  app.get('/api/admin/update/check', async (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    const user = token ? verifyToken(token) : null;
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    if (!verifyAdminFromDb(user)) return res.status(403).json({ error: 'Admin only' });
    const currentVersion = require('../../package.json').version;
    const method = detectInstallMethod();
    const instructions = getUpdateInstructions(method);
    const early = releaseChannel.earlyAccessOn(db);
    try {
      const data = await releaseChannel.latestRelease({
        early, headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'haven-update-check' },
      });
      const latestVersion = String(data.tag_name || '').replace(/^v/, '');
      const cmp = releaseChannel.compareVersions(currentVersion, latestVersion);
      res.json({
        currentVersion,
        latestVersion,
        prerelease: !!data.prerelease,
        channel: early ? 'early' : 'stable',
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

    // scripts/update.js does the work and writes to update.log in the data
    // folder. Under systemd or pm2 it updates in place and Haven exits after it,
    // so the service manager starts the new code. Otherwise Haven exits first,
    // which frees files Windows keeps locked while they are loaded (the SQLite
    // module), and the script starts Haven again when it is done.
    const { spawn } = require('child_process');
    const supervised = !!(process.env.INVOCATION_ID || process.env.pm_id || process.env.HAVEN_SUPERVISED === 'true');
    const updArgs = [path.join(CODE_DIR, 'scripts', 'update.js'), instructions.mode, '--port', String(process.env.PORT || 3000)];
    if (supervised) updArgs.push('--no-restart');
    if (releaseChannel.earlyAccessOn(db)) updArgs.push('--early');
    else updArgs.push('--wait-pid', String(process.pid));
    const shutdown = () => {
      console.log('🔄 [Update] Exiting so the updated Haven can start…');
      late.botAudioManager?.shutdown();
      process.exit(0);
    };
    console.log(`🔄 [Update] Updating (${method}), log: ${path.join(DATA_DIR, 'update.log')}`);
    setTimeout(() => {
      let child;
      try {
        const logFd = fs.openSync(path.join(DATA_DIR, 'update.log'), 'a');
        child = spawn(process.execPath, updArgs, { cwd: CODE_DIR, detached: !supervised, windowsHide: true, stdio: ['ignore', logFd, logFd] });
        fs.closeSync(logFd);
      } catch (err) {
        console.error('[Update] Could not start the updater, so Haven keeps running:', err);
        return;
      }
      if (supervised) {
        child.on('exit', (code) => {
          if (code === 0) return shutdown();
          console.error(`[Update] Update failed (exit ${code}), so Haven keeps running. See update.log.`);
        });
      } else {
        child.unref();
        setTimeout(shutdown, 1500);
      }
    }, 1500);
  });

};
