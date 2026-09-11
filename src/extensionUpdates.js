'use strict';

/**
 * Haven — Manual plugin and theme updates (#5578)
 *
 * Check builds a short-lived offer from an immutable GitHub release. Apply
 * revalidates that offer, checks the downloaded bytes, and replaces the existing
 * file without changing its filename or the user's extension preferences.
 *
 * The blocklist is required for both updates and rollback. A failed security
 * check leaves installed extensions running but prevents any replacement.
 * Registry, backups and the recovery journal live outside the public folders.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const semver = require('semver');
const https = require('node:https');
const dns = require('node:dns');
const net = require('node:net');

const BLOCKLIST_URL = 'https://ancsemi.github.io/Haven/blocklist.json';
const EXTENSION_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const REPOSITORY_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38})\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const extensionSuffix = type => (type === 'plugin' ? '.plugin.js' : '.theme.css');
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function assertValid(ok, message) {
  if (!ok) throw new Error(message);
}
function isStableVersion(version) {
  return typeof version === 'string' && semver.valid(version) === version && !semver.prerelease(version);
}
// ── Extension metadata ────────────────────────────────────────────

// Read declarations without evaluating plugin code. Duplicate identity fields
// are ambiguous, so do not silently choose one as the approved update source.
function parseExtensionHeader(bytes) {
  const block = bytes.toString('utf8').match(/\/\*\*[\s\S]*?\*\//)?.[0] || '';
  const fields = {};
  for (const name of ['id', 'version', 'update-repo']) {
    const matches = [...block.matchAll(new RegExp('^\\s*\\*?\\s*@' + name + '\\s+([^\\r\\n]+)', 'gm'))];
    assertValid(matches.length <= 1, 'Duplicate extension header field: ' + name);
    fields[name] = matches[0]?.[1].trim();
  }
  return fields;
}
// Validate every entry before choosing a candidate. Asset names are basenames
// within a GitHub release; manifests cannot supply a destination path or URL.
function validateReleaseManifest(value) {
  assertValid(
    value?.schemaVersion === 1 &&
      Array.isArray(value.extensions) &&
      value.extensions.length > 0 &&
      value.extensions.length <= 100,
    'Invalid release manifest.',
  );
  const ids = new Set();
  for (const e of value.extensions) {
    assertValid(
      e && typeof e.id === 'string' && EXTENSION_ID_PATTERN.test(e.id) && !ids.has(e.id),
      'Invalid or duplicate extension ID.',
    );
    ids.add(e.id);
    assertValid(
      ['plugin', 'theme'].includes(e.type) && isStableVersion(e.version),
      'Invalid extension type or version.',
    );
    assertValid(
      typeof e.requires?.haven === 'string' &&
        e.requires.haven.length <= 128 &&
        semver.validRange(e.requires.haven),
      'Invalid Haven compatibility range.',
    );
    assertValid(
      typeof e.asset === 'string' &&
        /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(e.asset) &&
        e.asset.endsWith(extensionSuffix(e.type)),
      'Invalid release asset filename.',
    );
    assertValid(typeof e.sha256 === 'string' && SHA256_PATTERN.test(e.sha256), 'Invalid SHA-256 checksum.');
  }
  return value;
}
function validateBlocklist(value) {
  assertValid(
    value?.schemaVersion === 1 &&
      typeof value.updatedAt === 'string' &&
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value.updatedAt) &&
      Number.isFinite(Date.parse(value.updatedAt)) &&
      Array.isArray(value.blocked) &&
      value.blocked.length <= 10000,
    'Invalid security blocklist.',
  );
  for (const e of value.blocked) {
    assertValid(
      e &&
        typeof e.repo === 'string' &&
        REPOSITORY_PATTERN.test(e.repo) &&
        typeof e.id === 'string' &&
        EXTENSION_ID_PATTERN.test(e.id) &&
        Array.isArray(e.versions) &&
        e.versions.length > 0 &&
        e.versions.every(isStableVersion) &&
        typeof e.reason === 'string' &&
        e.reason.length > 0 &&
        e.reason.length <= 2000,
      'Invalid security blocklist entry.',
    );
  }
  return value;
}
// IDs are author-chosen. Include the repository when matching an advisory so
// a collision in another author's repository does not block this extension.
function getBlockedReason(list, item) {
  return list.blocked.find(
    e =>
      e.repo.toLowerCase() === item.repo.toLowerCase() &&
      e.id === item.id &&
      e.versions.includes(item.version),
  )?.reason;
}

// ── Bounded GitHub downloads ──────────────────────────────────────

// Force public IPv4 DNS results and pin the selected address to the connection.
// No proxy environment, caller-supplied host, cookies or authorization headers.
function isPublicAddress(address) {
  if (net.isIP(address) !== 4) return false;
  const [a, b] = address.split('.').map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && [0, 168].includes(b)) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && [18, 19, 51].includes(b)) ||
    (a === 203 && b === 0)
  );
}
// Redirects keep the original deadline and re-enter URL/DNS validation. This
// allows GitHub's asset CDN without granting arbitrary outbound access.
function downloadExtensionAsset(url, limit, redirects = 0, deadline = Date.now() + 20000) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
      assertValid(
        u.protocol === 'https:' && !u.username && !u.password && (!u.port || u.port === '443') && !u.hash,
        'Unsafe download URL.',
      );
      assertValid(
        ['api.github.com', 'github.com', 'release-assets.githubusercontent.com'].includes(u.hostname) ||
          (u.origin === 'https://ancsemi.github.io' && u.pathname === '/Haven/blocklist.json' && !u.search),
        'Unapproved download host.',
      );
      assertValid(redirects <= 4 && deadline > Date.now(), 'Download timed out or redirected too often.');
    } catch (e) {
      reject(e);
      return;
    }
    const req = https.get(
      u,
      {
        headers: {
          'User-Agent': 'Haven-extension-updater',
          Accept: /\/releases\/assets\/\d+$/.test(u.pathname)
            ? 'application/octet-stream'
            : 'application/vnd.github+json',
          'Cache-Control': 'no-cache',
        },
        lookup(hostname, options, cb) {
          dns.lookup(hostname, { family: 4 }, (err, address, family) => {
            if (err) return cb(err);
            if (!isPublicAddress(address)) return cb(new Error('Download resolved to a non-public address.'));
            if (options.all) cb(null, [{ address, family }]);
            else cb(null, address, family);
          });
        },
      },
      res => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          res.destroy();
          clearTimeout(timer);
          try {
            resolve(
              downloadExtensionAsset(new URL(res.headers.location, u).href, limit, redirects + 1, deadline),
            );
          } catch (e) {
            reject(e);
          }
          return;
        }
        if (res.statusCode !== 200) {
          res.destroy();
          clearTimeout(timer);
          reject(new Error('Download failed (HTTP ' + res.statusCode + ').'));
          return;
        }
        if (Number(res.headers['content-length']) > limit) {
          res.destroy(new Error('Download exceeds size limit.'));
        }
        const chunks = [];
        let size = 0;
        res.on('data', chunk => {
          size += chunk.length;
          if (size > limit) res.destroy(new Error('Download exceeds size limit.'));
          else chunks.push(chunk);
        });
        res.on('error', reject);
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('close', () => clearTimeout(timer));
      },
    );
    const timer = setTimeout(
      () => req.destroy(new Error('Download timed out.')),
      Math.max(1, deadline - Date.now()),
    );
    req.on('error', e => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

// ── Installed state and recovery ──────────────────────────────────

// One updater owns the installation directories for this server process.
// Injected transport/clock keep tests deterministic and off the public network.
function createExtensionUpdater({
  dirs,
  stateDir,
  havenVersion,
  fetchBytes = downloadExtensionAsset,
  now = Date.now,
}) {
  // Offers stay server-side: the browser submits a token, not replacement
  // metadata. A restart deliberately requires the admin to check again.
  const offers = new Map();
  let busy = false;
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const stateFile = path.join(stateDir, 'state.json');
  const journalFile = path.join(stateDir, 'transaction.json');
  // Stage beside the destination so rename stays on the same filesystem.
  // Readers see a complete old or new file, never a partly written download.
  function writeFileAtomic(file, bytes) {
    const tmp = file + '.' + crypto.randomUUID() + '.tmp';
    try {
      const fd = fs.openSync(tmp, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, bytes);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, file);
    } finally {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    }
  }
  function writeJsonAtomic(file, value) {
    writeFileAtomic(file, Buffer.from(JSON.stringify(value)));
  }
  function readInstalledState() {
    return fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
  }
  function installedFilePath(item) {
    assertValid(
      ['plugin', 'theme'].includes(item.type) &&
        typeof item.file === 'string' &&
        path.basename(item.file) === item.file &&
        !item.file.includes('\\') &&
        item.file.endsWith(extensionSuffix(item.type)),
      'Invalid installed filename.',
    );
    const file = path.join(dirs[item.type], item.file);
    assertValid(fs.lstatSync(file).isFile(), 'Extension must be a regular file, not a symlink.');
    return file;
  }
  // A crash can happen between the file swap and registry write. The journal
  // records both states; the actual file hash tells us which one to restore.
  // An unexpected hash is a local-edit conflict, not permission to overwrite it.
  function recoverInterruptedUpdate() {
    if (!fs.existsSync(journalFile)) return;
    const tx = JSON.parse(fs.readFileSync(journalFile, 'utf8'));
    const current = sha256(fs.readFileSync(installedFilePath(tx.item)));
    assertValid(
      current === tx.before || current === tx.after,
      'An interrupted update conflicts with local edits. Restore the extension file before retrying.',
    );
    writeJsonAtomic(stateFile, current === tx.after ? tx.newState : tx.oldState);
    fs.unlinkSync(journalFile);
  }
  // Check also mutates the offer map, so serialize it with apply/rollback.
  // This is an in-process lock, not coordination for multiple Haven processes.
  async function withUpdateLock(fn) {
    assertValid(!busy, 'An extension operation is already running. Try again when it finishes.');
    busy = true;
    try {
      recoverInterruptedUpdate();
      return await fn();
    } finally {
      busy = false;
    }
  }
  // Keep the original filenames: existing plugin choices and published theme
  // settings use them as keys. Once managed, compare against saved identity and
  // bytes rather than accepting a new source from a modified local header.
  function readInstalledExtensions() {
    const result = [];
    const saved = readInstalledState();
    for (const type of ['plugin', 'theme']) {
      for (const file of fs.readdirSync(dirs[type]).filter(f => f.endsWith(extensionSuffix(type)))) {
        const item = { type, file };
        const bytes = fs.readFileSync(installedFilePath(item));
        const h = parseExtensionHeader(bytes);
        if (!h.id && !h['update-repo']) continue;
        const key = type + ':' + file;
        const previous = saved[key];
        const repo = h['update-repo'];
        assertValid(
          typeof h.id === 'string' &&
            EXTENSION_ID_PATTERN.test(h.id) &&
            typeof repo === 'string' &&
            REPOSITORY_PATTERN.test(repo) &&
            isStableVersion(h.version),
          'Invalid update metadata in ' + file + '.',
        );
        const installed = { ...item, key, id: h.id, repo, version: h.version, sha256: sha256(bytes) };
        if (previous)
          assertValid(
            previous.id === installed.id &&
              previous.repo.toLowerCase() === repo.toLowerCase() &&
              previous.sha256 === installed.sha256 &&
              previous.version === installed.version,
            'Local edits or source changes detected in ' +
              file +
              '. Restore the managed file before updating.',
          );
        assertValid(
          !result.some(e => e.repo.toLowerCase() === repo.toLowerCase() && e.id === h.id),
          'Duplicate installed extension ID: ' + h.id,
        );
        result.push(installed);
      }
    }
    return result;
  }
  // Never interpret an unavailable or malformed list as "nothing blocked".
  // No cached fallback: the maintainer requires a fresh successful security
  // check before either installation or rollback.
  async function fetchBlocklist() {
    try {
      return validateBlocklist(JSON.parse((await fetchBytes(BLOCKLIST_URL, 1024 * 1024)).toString('utf8')));
    } catch {
      throw new Error(
        'The security blocklist could not be fetched or validated. Existing extensions keep running; installation and rollback are unavailable until a fresh check succeeds.',
      );
    }
  }
  async function fetchGitHubJson(url) {
    return JSON.parse((await fetchBytes(url, 2 * 1024 * 1024)).toString('utf8'));
  }
  function findReleaseAsset(release, name) {
    const found = release.assets?.filter(a => a.name === name);
    assertValid(
      found?.length === 1 &&
        Number.isSafeInteger(found[0].id) &&
        found[0].id > 0 &&
        found[0].state === 'uploaded',
      'Missing or ambiguous release asset: ' + name,
    );
    return found[0];
  }
  // ── Manual discovery and confirmation offers ────────────────────

  async function check(userId) {
    return withUpdateLock(async () => {
      offers.clear();
      const list = await fetchBlocklist();
      const installed = readInstalledExtensions();
      const rows = [];
      const repos = new Map();
      for (const item of installed) {
        const row = { ...item, warning: getBlockedReason(list, item) || null, offers: [] };
        rows.push(row);
        let updateOffer;
        try {
          if (!repos.has(item.repo.toLowerCase())) {
            const releases = [];
            let complete = false;
            for (let page = 1; page <= 5; page++) {
              const batch = await fetchGitHubJson(
                `https://api.github.com/repos/${item.repo}/releases?per_page=100&page=${page}`,
              );
              assertValid(Array.isArray(batch), 'Invalid GitHub release list.');
              releases.push(...batch);
              if (batch.length < 100) {
                complete = true;
                break;
              }
            }
            assertValid(complete, 'Too many releases to complete this check.');
            const entries = [];
            for (const r of releases) {
              if (r.draft || r.prerelease || r.immutable !== true) continue;
              if (!r.assets?.some(a => a.name === 'haven-release.json')) continue;
              assertValid(entries.length < 30, 'Too many release manifests to complete this check.');
              const a = findReleaseAsset(r, 'haven-release.json');
              const m = validateReleaseManifest(
                await fetchGitHubJson(`https://api.github.com/repos/${item.repo}/releases/assets/${a.id}`),
              );
              entries.push({ release: r, manifest: m });
            }
            repos.set(item.repo.toLowerCase(), entries);
          }
          const candidates = [];
          for (const { release, manifest: m } of repos.get(item.repo.toLowerCase())) {
            for (const e of m.extensions) {
              if (
                e.id !== item.id ||
                e.type !== item.type ||
                !semver.gt(e.version, item.version) ||
                !semver.satisfies(havenVersion, e.requires.haven)
              )
                continue;
              const reason = getBlockedReason(list, { ...item, version: e.version });
              if (reason) {
                row.blockedUpdate = e.version + ': ' + reason;
                continue;
              }
              const a = findReleaseAsset(release, e.asset);
              candidates.push({
                item,
                candidate: e,
                assetId: a.id,
                releaseId: release.id,
                notes: String(release.body || '').slice(0, 20000),
                releaseUrl: `https://github.com/${item.repo}/releases/tag/${encodeURIComponent(release.tag_name)}`,
                action: 'install',
              });
            }
          }
          // GitHub's latest tag need not be the newest compatible extension.
          // Compare extension versions and reject duplicate-version ambiguity.
          candidates.sort((a, b) => semver.rcompare(a.candidate.version, b.candidate.version));
          for (let i = 1; i < candidates.length; i++)
            assertValid(
              candidates[i].candidate.version !== candidates[i - 1].candidate.version,
              'Conflicting releases for the same version.',
            );
          updateOffer = candidates[0];
        } catch (e) {
          row.error = e.message;
        }
        // Rollback uses local bytes and a fresh blocklist; a GitHub outage must
        // not prevent recovery when the security check itself succeeded.
        const backup = readInstalledState()[item.key]?.backup;
        const rollback =
          backup &&
          backup.havenVersion === havenVersion &&
          !getBlockedReason(list, { ...item, version: backup.version })
            ? {
                item,
                candidate: backup,
                action: 'rollback',
                notes: 'Restore the previous locally saved version.',
                releaseUrl: null,
              }
            : null;
        for (const offer of [updateOffer, rollback].filter(Boolean)) {
          const token = crypto.randomUUID();
          offers.set(token, { ...offer, userId, expires: now() + 10 * 60 * 1000 });
          row.offers.push({
            token,
            action: offer.action,
            version: offer.candidate.version,
            notes: offer.notes,
            releaseUrl: offer.releaseUrl,
          });
        }
      }
      return { extensions: rows };
    });
  }
  // ── Verified replacement / rollback ─────────────────────────────

  async function apply(token, userId, authorized = () => true) {
    return withUpdateLock(async () => {
      const offer = offers.get(token);
      assertValid(
        offer && offer.userId === userId && offer.expires > now(),
        'This update offer expired. Check for updates again.',
      );
      const list = await fetchBlocklist();
      const { item, candidate } = offer;
      assertValid(
        !getBlockedReason(list, { ...item, version: candidate.version }),
        'This version is blocked for security reasons.',
      );
      const current = readInstalledExtensions().find(e => e.key === item.key);
      assertValid(
        current && current.sha256 === item.sha256,
        'The installed file changed. Check for updates again.',
      );
      let bytes;
      if (offer.action === 'install') {
        const r = await fetchGitHubJson(`https://api.github.com/repos/${item.repo}/releases/${offer.releaseId}`);
        assertValid(
          r.immutable === true && !r.draft && !r.prerelease && findReleaseAsset(r, candidate.asset).id === offer.assetId,
          'The release changed or is not immutable. Check for updates again.',
        );
        bytes = await fetchBytes(
          `https://api.github.com/repos/${item.repo}/releases/assets/${offer.assetId}`,
          5 * 1024 * 1024,
        );
      } else {
        assertValid(SHA256_PATTERN.test(candidate.sha256), 'Invalid rollback checksum.');
        bytes = fs.readFileSync(path.join(stateDir, candidate.sha256 + '.backup'));
      }
      assertValid(
        sha256(bytes) === candidate.sha256,
        'Checksum mismatch. The installed file was not changed.',
      );
      const h = parseExtensionHeader(bytes);
      assertValid(
        h.id === item.id &&
          h.version === candidate.version &&
          h['update-repo']?.toLowerCase() === item.repo.toLowerCase(),
        'Downloaded extension metadata does not match the approved offer.',
      );
      // Network requests may have taken time: the admin could have been
      // demoted or the installed file edited since confirmation. Check both
      // again before entering the synchronous file-replacement sequence.
      assertValid(authorized(), 'Administrator permission is required.');
      const file = installedFilePath(item);
      const oldBytes = fs.readFileSync(file);
      assertValid(sha256(oldBytes) === item.sha256, 'The installed file changed during download.');
      if (item.type === 'theme')
        assertValid(
          require('./themeMetadata').parseThemeMetadata(bytes.toString('utf8')).compatible,
          'This theme requires an unsupported Theme API.',
        );
      const oldState = readInstalledState();
      // A rollback consumes the saved previous version. Do not turn the newer
      // file into another backup and offer an endless back-and-forth toggle.
      const newState = {
        ...oldState,
        [item.key]: {
          ...item,
          version: candidate.version,
          sha256: candidate.sha256,
          ...(offer.action === 'install'
            ? { backup: { version: item.version, sha256: item.sha256, havenVersion } }
            : {}),
        },
      };
      // Ordering matters: preserve the old bytes and journal before swapping
      // the live file. Clear the journal only after the new registry is saved.
      if (offer.action === 'install')
        writeFileAtomic(path.join(stateDir, item.sha256 + '.backup'), oldBytes);
      writeJsonAtomic(journalFile, { item, before: item.sha256, after: candidate.sha256, oldState, newState });
      writeFileAtomic(file, bytes);
      writeJsonAtomic(stateFile, newState);
      fs.unlinkSync(journalFile);
      offers.clear();
      return { reloadRequired: true, version: candidate.version };
    });
  }
  recoverInterruptedUpdate();
  return { check, apply };
}

module.exports = {
  createExtensionUpdater,
  validateReleaseManifest,
  validateBlocklist,
  parseExtensionHeader,
  sha256,
  isPublicAddress,
  downloadExtensionAsset,
};
