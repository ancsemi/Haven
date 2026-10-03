// Reads a Haven backup zip into a staged database file and uploads folder.
// Used by the restore route and by the installer's restore option.

const fs = require('fs');
const path = require('path');

// Stream a full backup zip into staged DB + uploads on disk. Reads entries with
// yauzl (random access, low memory) instead of loading the whole archive into
// RAM the way adm-zip did, so restoring a large backup (15GB+) no longer OOMs
// or crashes the server (#5436). Resolves with the parsed manifest. Rejects with
// an Error whose .status is 400 for a bad/partial backup, or a generic error
// (treated as 500) for IO problems.
function extractFullBackup(zipPath, stagedDb, stagedUploads, onProgress) {
  const yauzl = require('yauzl');
  const bad = (msg) => Object.assign(new Error(msg), { status: 400 });

  const readEntryBuffer = (zipfile, entry) => new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (err, rs) => {
      if (err) return reject(err);
      const chunks = [];
      rs.on('data', c => chunks.push(c));
      rs.on('end', () => resolve(Buffer.concat(chunks)));
      rs.on('error', reject);
    });
  });
  const streamEntryToFile = (zipfile, entry, dest) => new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (err, rs) => {
      if (err) return reject(err);
      const ws = fs.createWriteStream(dest);
      rs.on('error', reject);
      ws.on('error', reject);
      ws.on('finish', resolve);
      rs.pipe(ws);
    });
  });

  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: false }, (err, zipfile) => {
      if (err) return reject(bad('Invalid backup: not a readable zip file'));
      const entries = [];
      zipfile.on('error', reject);
      zipfile.on('entry', (entry) => { entries.push(entry); zipfile.readEntry(); });
      zipfile.on('end', async () => {
        try {
          const find = (n) => entries.find(e => e.fileName === n);
          const manifestEntry = find('manifest.json');
          if (!manifestEntry) throw bad('Invalid backup: missing manifest.json');
          let manifest;
          try { manifest = JSON.parse((await readEntryBuffer(zipfile, manifestEntry)).toString('utf8')); }
          catch { throw bad('Invalid backup: corrupt manifest.json'); }
          if (manifest.app !== 'haven') throw bad('Not a Haven backup file');
          // A backup made with Messages ticked carries the whole database and
          // can be restored whether or not Uploaded files was ticked too: the
          // database is swapped in, and the uploads folder is only replaced
          // when the backup has one. A channels/users/settings-only backup
          // has no database to restore from (#5660).
          const dbEntry = find('haven.db');
          if (!dbEntry) throw bad('This backup has no database in it (Messages was unticked when it was made), so it cannot be restored here. Make the backup with Messages ticked; Uploaded files is optional.');

          // Progress accounting: total = the DB clone + every upload file
          // (uncompressed bytes). Emitted (throttled to ~400ms) via onProgress
          // so the admin's restore UI can show a real extraction bar instead of
          // an opaque multi-minute wait on large backups (#5438).
          const uploadEntries = entries.filter(e => e.fileName.startsWith('uploads/') && !e.fileName.endsWith('/'));
          const bytesTotal = (dbEntry.uncompressedSize || 0) +
            uploadEntries.reduce((sum, e) => sum + (e.uncompressedSize || 0), 0);
          let bytesDone = 0;
          let lastEmit = 0;
          const emitProgress = (force) => {
            if (typeof onProgress !== 'function') return;
            const now = Date.now();
            if (!force && now - lastEmit < 400) return;
            lastEmit = now;
            try { onProgress({ phase: 'extract', bytesDone, bytesTotal }); } catch { /* progress bar only; never fail the restore over it */ }
          };
          emitProgress(true);

          // Stage the DB clone (streamed from the zip to disk).
          await streamEntryToFile(zipfile, dbEntry, stagedDb);
          bytesDone += dbEntry.uncompressedSize || 0;
          emitProgress(true);

          // Stage uploads, one entry at a time, with a path-traversal guard so a
          // crafted entry name can't write outside the staging directory.
          if (fs.existsSync(stagedUploads)) fs.rmSync(stagedUploads, { recursive: true, force: true });
          if (uploadEntries.length) {
            fs.mkdirSync(stagedUploads, { recursive: true });
            const root = path.resolve(stagedUploads);
            for (const ue of uploadEntries) {
              const rel = ue.fileName.slice('uploads/'.length);
              if (!rel) continue;
              const dest = path.resolve(root, rel);
              if (dest !== root && !dest.startsWith(root + path.sep)) continue; // reject ../ escapes
              fs.mkdirSync(path.dirname(dest), { recursive: true });
              await streamEntryToFile(zipfile, ue, dest);
              bytesDone += ue.uncompressedSize || 0;
              emitProgress(false);
            }
          }
          emitProgress(true);
          zipfile.close();
          resolve(manifest);
        } catch (e) {
          try { zipfile.close(); } catch { /* may already be closed; the original error is rejected below */ }
          reject(e);
        }
      });
      zipfile.readEntry();
    });
  });
}

module.exports = { extractFullBackup };
