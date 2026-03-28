const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  S3Client,
  HeadBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  CopyObjectCommand
} = require('@aws-sdk/client-s3');
const { DATA_DIR, UPLOADS_DIR, DELETED_ATTACHMENTS_DIR } = require('./paths');

const PENDING_RESTORE_DIR = path.join(DATA_DIR, 'restore-pending');
const PENDING_RESTORE_ROOT_DIR = path.join(PENDING_RESTORE_DIR, 'root');

const STORAGE_KEYS = [
  'storage_provider',
  'storage_s3_endpoint',
  'storage_s3_region',
  'storage_s3_bucket',
  'storage_s3_access_key',
  'storage_s3_secret_key',
  'storage_s3_prefix',
  'storage_s3_force_path_style'
];
const SECURE_STORAGE_KEYS = ['storage_s3_access_key', 'storage_s3_secret_key'];

let s3CacheKey = null;
let s3Client = null;

function getSettingsSecret() {
  const secret = process.env.HAVEN_SETTINGS_SECRET || process.env.JWT_SECRET || '';
  if (!secret) throw new Error('Missing HAVEN_SETTINGS_SECRET');
  return crypto.createHash('sha256').update(secret, 'utf8').digest();
}

function encryptSecureValue(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getSettingsSecret(), iv);
  const encrypted = Buffer.concat([cipher.update(String(value || ''), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc-v1:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

function decryptSecureValue(payload) {
  if (!payload) return '';
  if (!String(payload).startsWith('enc-v1:')) return String(payload);
  const parts = String(payload).split(':');
  if (parts.length !== 4) throw new Error('Invalid secure settings payload');
  const [, ivB64, tagB64, dataB64] = parts;
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    getSettingsSecret(),
    Buffer.from(ivB64, 'base64')
  );
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final()
  ]).toString('utf8');
}

function boolString(value, fallback = false) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

function getDbSafe() {
  try {
    const { getDb } = require('./database');
    return getDb();
  } catch {
    return null;
  }
}

function ensureSecureSettingsMigrated(db = getDbSafe()) {
  if (!db) return;
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS secure_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    const getLegacy = db.prepare('SELECT value FROM server_settings WHERE key = ?');
    const getSecure = db.prepare('SELECT value FROM secure_settings WHERE key = ?');
    const putSecure = db.prepare(`
      INSERT INTO secure_settings (key, value, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
    `);
    const clearLegacy = db.prepare('UPDATE server_settings SET value = ? WHERE key = ?');

    for (const key of SECURE_STORAGE_KEYS) {
      const secureRow = getSecure.get(key);
      const legacyValue = String(getLegacy.get(key)?.value || '').trim();
      if (!secureRow?.value && legacyValue) {
        putSecure.run(key, encryptSecureValue(legacyValue));
      }
      if ((secureRow?.value || legacyValue) && legacyValue) {
        clearLegacy.run('', key);
      }
    }
  } catch (err) {
    console.error('Secure settings migration failed:', err?.message || err);
  }
}

function getSecureSetting(key, db = getDbSafe()) {
  if (!db) return '';
  ensureSecureSettingsMigrated(db);
  try {
    const row = db.prepare('SELECT value FROM secure_settings WHERE key = ?').get(key);
    if (row?.value) return decryptSecureValue(row.value);
  } catch (err) {
    console.error(`Failed to read secure setting ${key}:`, err?.message || err);
  }
  try {
    return String(db.prepare('SELECT value FROM server_settings WHERE key = ?').get(key)?.value || '');
  } catch {
    return '';
  }
}

function setSecureSetting(key, value, db = getDbSafe()) {
  if (!db || !SECURE_STORAGE_KEYS.includes(key)) return false;
  const normalized = String(value || '').trim();
  if (!normalized) return false;
  ensureSecureSettingsMigrated(db);
  db.prepare(`
    INSERT INTO secure_settings (key, value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).run(key, encryptSecureValue(normalized));
  db.prepare('UPDATE server_settings SET value = ? WHERE key = ?').run('', key);
  return true;
}

function hasSecureSetting(key, db = getDbSafe()) {
  return !!String(getSecureSetting(key, db) || '').trim();
}

function readStorageSettings(db = getDbSafe()) {
  ensureSecureSettingsMigrated(db);
  const settings = {
    storage_provider: 'local',
    storage_s3_endpoint: '',
    storage_s3_region: 'auto',
    storage_s3_bucket: '',
    storage_s3_access_key: '',
    storage_s3_secret_key: '',
    storage_s3_prefix: 'haven',
    storage_s3_force_path_style: 'true'
  };

  if (!db) return settings;

  try {
    const placeholders = STORAGE_KEYS.map(() => '?').join(',');
    const rows = db.prepare(`SELECT key, value FROM server_settings WHERE key IN (${placeholders})`).all(...STORAGE_KEYS);
    for (const row of rows) settings[row.key] = row.value;
  } catch {
    return settings;
  }

  for (const key of SECURE_STORAGE_KEYS) {
    settings[key] = getSecureSetting(key, db);
  }

  return settings;
}

function normalizePrefix(prefix) {
  return String(prefix || '')
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .replace(/\/+/g, '/');
}

function getStorageConfig(db = getDbSafe()) {
  const settings = readStorageSettings(db);
  const provider = settings.storage_provider === 's3' ? 's3' : 'local';

  return {
    provider,
    uploadsDir: UPLOADS_DIR,
    deletedAttachmentsDir: DELETED_ATTACHMENTS_DIR,
    s3: {
      endpoint: String(settings.storage_s3_endpoint || '').trim(),
      region: String(settings.storage_s3_region || 'auto').trim() || 'auto',
      bucket: String(settings.storage_s3_bucket || '').trim(),
      accessKeyId: String(settings.storage_s3_access_key || '').trim(),
      secretAccessKey: String(settings.storage_s3_secret_key || '').trim(),
      prefix: normalizePrefix(settings.storage_s3_prefix || 'haven'),
      forcePathStyle: boolString(settings.storage_s3_force_path_style, true)
    }
  };
}

function isSafeUploadName(name) {
  return typeof name === 'string' && /^[\w.-]+$/.test(name);
}

function decodeUploadUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const match = url.match(/^\/uploads\/([\w.-]+)$/);
  return match ? match[1] : null;
}

function getUploadUrl(name) {
  return `/uploads/${name}`;
}

function generateStoredFilename(originalName = '', forcedExt = '') {
  const ext = (forcedExt || path.extname(originalName || '') || '')
    .toLowerCase()
    .replace(/[^.\w-]/g, '')
    .slice(0, 12);
  return `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;
}

function buildObjectKey(name, folder = 'uploads', config = getStorageConfig()) {
  const prefix = config.s3.prefix ? `${config.s3.prefix}/` : '';
  const inner = folder === 'deleted-attachments' ? `deleted-attachments/${name}` : name;
  return `${prefix}${inner}`;
}

function getLocalAbsolutePath(name, folder = 'uploads') {
  if (!isSafeUploadName(name)) throw new Error('Unsafe upload filename');
  return path.join(folder === 'deleted-attachments' ? DELETED_ATTACHMENTS_DIR : UPLOADS_DIR, name);
}

function getS3Client(config = getStorageConfig()) {
  const cacheKey = JSON.stringify({
    endpoint: config.s3.endpoint,
    region: config.s3.region,
    bucket: config.s3.bucket,
    accessKeyId: config.s3.accessKeyId,
    secretAccessKey: config.s3.secretAccessKey,
    forcePathStyle: config.s3.forcePathStyle
  });

  if (s3Client && s3CacheKey === cacheKey) return s3Client;

  s3Client = new S3Client({
    endpoint: config.s3.endpoint,
    region: config.s3.region || 'auto',
    forcePathStyle: !!config.s3.forcePathStyle,
    credentials: {
      accessKeyId: config.s3.accessKeyId,
      secretAccessKey: config.s3.secretAccessKey
    }
  });
  s3CacheKey = cacheKey;
  return s3Client;
}

function ensureS3Config(config) {
  if (!config.s3.endpoint || !config.s3.bucket || !config.s3.accessKeyId || !config.s3.secretAccessKey) {
    throw new Error('S3 storage is missing endpoint, bucket, or credentials');
  }
}

async function storeUploadBuffer(buffer, options = {}) {
  const config = getStorageConfig(options.db);
  const folder = options.folder === 'deleted-attachments' ? 'deleted-attachments' : 'uploads';
  const filename = options.filename && isSafeUploadName(options.filename)
    ? options.filename
    : generateStoredFilename(options.originalName || '', options.forcedExt || '');

  if (config.provider === 'local') {
    fs.mkdirSync(folder === 'deleted-attachments' ? DELETED_ATTACHMENTS_DIR : UPLOADS_DIR, { recursive: true });
    fs.writeFileSync(getLocalAbsolutePath(filename, folder), buffer);
    return { name: filename, url: getUploadUrl(filename), provider: 'local' };
  }

  ensureS3Config(config);
  const client = getS3Client(config);
  await client.send(new PutObjectCommand({
    Bucket: config.s3.bucket,
    Key: buildObjectKey(filename, folder, config),
    Body: buffer,
    ContentType: options.mimeType || 'application/octet-stream',
    CacheControl: options.cacheControl || undefined
  }));
  return { name: filename, url: getUploadUrl(filename), provider: 's3' };
}

async function deleteUploadByName(name, folder = 'uploads', db) {
  if (!isSafeUploadName(name)) return false;
  const config = getStorageConfig(db);

  if (config.provider === 'local') {
    const abs = getLocalAbsolutePath(name, folder);
    if (!fs.existsSync(abs)) return false;
    fs.unlinkSync(abs);
    return true;
  }

  ensureS3Config(config);
  await getS3Client(config).send(new DeleteObjectCommand({
    Bucket: config.s3.bucket,
    Key: buildObjectKey(name, folder, config)
  }));
  return true;
}

async function deleteUploadByUrl(url, db) {
  const name = decodeUploadUrl(url);
  if (!name) return false;
  return deleteUploadByName(name, 'uploads', db);
}

async function moveUploadToDeleted(nameOrUrl, db) {
  const name = isSafeUploadName(nameOrUrl) ? nameOrUrl : decodeUploadUrl(nameOrUrl);
  if (!name) return false;
  const config = getStorageConfig(db);

  if (config.provider === 'local') {
    const src = getLocalAbsolutePath(name, 'uploads');
    const dst = getLocalAbsolutePath(name, 'deleted-attachments');
    if (!fs.existsSync(src)) return false;
    fs.mkdirSync(DELETED_ATTACHMENTS_DIR, { recursive: true });
    fs.renameSync(src, dst);
    return true;
  }

  ensureS3Config(config);
  const client = getS3Client(config);
  const sourceKey = buildObjectKey(name, 'uploads', config);
  const targetKey = buildObjectKey(name, 'deleted-attachments', config);
  await client.send(new CopyObjectCommand({
    Bucket: config.s3.bucket,
    CopySource: `/${config.s3.bucket}/${sourceKey}`,
    Key: targetKey
  }));
  await client.send(new DeleteObjectCommand({
    Bucket: config.s3.bucket,
    Key: sourceKey
  }));
  return true;
}

async function getUploadReadStream(name, db) {
  if (!isSafeUploadName(name)) return null;
  const config = getStorageConfig(db);

  if (config.provider === 'local') {
    const abs = getLocalAbsolutePath(name, 'uploads');
    if (!fs.existsSync(abs)) return null;
    const stat = fs.statSync(abs);
    return {
      stream: fs.createReadStream(abs),
      contentLength: stat.size,
      lastModified: stat.mtime
    };
  }

  ensureS3Config(config);
  try {
    const result = await getS3Client(config).send(new GetObjectCommand({
      Bucket: config.s3.bucket,
      Key: buildObjectKey(name, 'uploads', config)
    }));
    return {
      stream: result.Body,
      contentType: result.ContentType || undefined,
      contentLength: result.ContentLength || undefined,
      lastModified: result.LastModified || undefined
    };
  } catch (err) {
    if (err?.$metadata?.httpStatusCode === 404 || err?.name === 'NoSuchKey') return null;
    throw err;
  }
}

async function listS3Objects(folder, config) {
  const items = [];
  let continuationToken;
  const prefix = buildObjectKey('', folder, config);

  do {
    const resp = await getS3Client(config).send(new ListObjectsV2Command({
      Bucket: config.s3.bucket,
      Prefix: prefix,
      ContinuationToken: continuationToken
    }));
    for (const obj of resp.Contents || []) items.push(obj);
    continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
  } while (continuationToken);

  return items;
}

async function cleanupActiveUploads({ protectedFiles = new Set(), cutoff }) {
  const config = getStorageConfig();
  let uploadsDeleted = 0;
  let deletedAttachmentsDeleted = 0;

  if (config.provider === 'local') {
    if (fs.existsSync(UPLOADS_DIR)) {
      for (const file of fs.readdirSync(UPLOADS_DIR)) {
        if (file === 'deleted-attachments' || protectedFiles.has(file)) continue;
        const fp = path.join(UPLOADS_DIR, file);
        try {
          const stat = fs.statSync(fp);
          if (stat.isFile() && stat.mtimeMs < cutoff) {
            fs.unlinkSync(fp);
            uploadsDeleted++;
          }
        } catch { /* skip */ }
      }
    }

    if (fs.existsSync(DELETED_ATTACHMENTS_DIR)) {
      for (const file of fs.readdirSync(DELETED_ATTACHMENTS_DIR)) {
        const fp = path.join(DELETED_ATTACHMENTS_DIR, file);
        try {
          const stat = fs.statSync(fp);
          if (stat.isFile() && stat.mtimeMs < cutoff) {
            fs.unlinkSync(fp);
            deletedAttachmentsDeleted++;
          }
        } catch { /* skip */ }
      }
    }

    return { uploadsDeleted, deletedAttachmentsDeleted };
  }

  ensureS3Config(config);
  const uploadPrefix = buildObjectKey('', 'uploads', config);
  const deletedPrefix = buildObjectKey('', 'deleted-attachments', config);
  const uploadDeletes = [];
  const deletedDeletes = [];

  for (const obj of await listS3Objects('uploads', config)) {
    const name = obj.Key.startsWith(uploadPrefix) ? obj.Key.slice(uploadPrefix.length) : '';
    if (!name || name.includes('/') || protectedFiles.has(name)) continue;
    if (obj.LastModified && obj.LastModified.getTime() < cutoff) uploadDeletes.push({ Key: obj.Key });
  }

  for (const obj of await listS3Objects('deleted-attachments', config)) {
    const name = obj.Key.startsWith(deletedPrefix) ? obj.Key.slice(deletedPrefix.length) : '';
    if (!name || name.includes('/')) continue;
    if (obj.LastModified && obj.LastModified.getTime() < cutoff) deletedDeletes.push({ Key: obj.Key });
  }

  for (let i = 0; i < uploadDeletes.length; i += 1000) {
    const chunk = uploadDeletes.slice(i, i + 1000);
    if (!chunk.length) continue;
    await getS3Client(config).send(new DeleteObjectsCommand({
      Bucket: config.s3.bucket,
      Delete: { Objects: chunk, Quiet: true }
    }));
    uploadsDeleted += chunk.length;
  }

  for (let i = 0; i < deletedDeletes.length; i += 1000) {
    const chunk = deletedDeletes.slice(i, i + 1000);
    if (!chunk.length) continue;
    await getS3Client(config).send(new DeleteObjectsCommand({
      Bucket: config.s3.bucket,
      Delete: { Objects: chunk, Quiet: true }
    }));
    deletedAttachmentsDeleted += chunk.length;
  }

  return { uploadsDeleted, deletedAttachmentsDeleted };
}

async function testS3Connection(overrides = {}) {
  const base = getStorageConfig();
  const config = {
    ...base,
    provider: 's3',
    s3: {
      ...base.s3,
      ...overrides,
      forcePathStyle: typeof overrides.forcePathStyle === 'boolean' ? overrides.forcePathStyle : base.s3.forcePathStyle
    }
  };

  ensureS3Config(config);
  const client = getS3Client(config);
  await client.send(new HeadBucketCommand({ Bucket: config.s3.bucket }));
  const probeName = `haven-connection-test-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.txt`;
  const probeKey = buildObjectKey(probeName, 'uploads', config);
  await client.send(new PutObjectCommand({
    Bucket: config.s3.bucket,
    Key: probeKey,
    Body: Buffer.from('haven-storage-test', 'utf8'),
    ContentType: 'text/plain'
  }));
  await client.send(new DeleteObjectCommand({
    Bucket: config.s3.bucket,
    Key: probeKey
  }));
  return true;
}

async function migrateLocalUploadsToActiveStorage() {
  const config = getStorageConfig();
  if (config.provider !== 's3') {
    return { provider: config.provider, migrated: 0, skipped: 0, deletedAttachmentsMigrated: 0 };
  }

  let migrated = 0;
  let skipped = 0;
  let deletedAttachmentsMigrated = 0;

  if (fs.existsSync(UPLOADS_DIR)) {
    for (const file of fs.readdirSync(UPLOADS_DIR)) {
      if (file === 'deleted-attachments') continue;
      const abs = path.join(UPLOADS_DIR, file);
      const stat = fs.statSync(abs);
      if (!stat.isFile()) continue;
      if (!isSafeUploadName(file)) {
        skipped++;
        continue;
      }
      await storeUploadBuffer(fs.readFileSync(abs), { filename: file, folder: 'uploads' });
      fs.unlinkSync(abs);
      migrated++;
    }
  }

  if (fs.existsSync(DELETED_ATTACHMENTS_DIR)) {
    for (const file of fs.readdirSync(DELETED_ATTACHMENTS_DIR)) {
      const abs = path.join(DELETED_ATTACHMENTS_DIR, file);
      const stat = fs.statSync(abs);
      if (!stat.isFile()) continue;
      if (!isSafeUploadName(file)) {
        skipped++;
        continue;
      }
      await storeUploadBuffer(fs.readFileSync(abs), { filename: file, folder: 'deleted-attachments' });
      fs.unlinkSync(abs);
      deletedAttachmentsMigrated++;
    }
  }

  return { provider: 's3', migrated, skipped, deletedAttachmentsMigrated };
}

function addDirectoryToZip(zip, dirPath, zipPrefix = '') {
  if (!fs.existsSync(dirPath)) return;
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const abs = path.join(dirPath, entry.name);
    const zipPath = zipPrefix ? `${zipPrefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) addDirectoryToZip(zip, abs, zipPath);
    else zip.addFile(zipPath.replace(/\\/g, '/'), fs.readFileSync(abs));
  }
}

async function appendActiveUploadsToZip(zip) {
  const config = getStorageConfig();
  if (config.provider === 'local') return;

  const uploadPrefix = buildObjectKey('', 'uploads', config);
  const deletedPrefix = buildObjectKey('', 'deleted-attachments', config);

  for (const obj of await listS3Objects('uploads', config)) {
    const name = obj.Key.startsWith(uploadPrefix) ? obj.Key.slice(uploadPrefix.length) : '';
    if (!name || name.includes('/')) continue;
    const file = await getS3Client(config).send(new GetObjectCommand({ Bucket: config.s3.bucket, Key: obj.Key }));
    zip.addFile(`uploads/${name}`, Buffer.from(await file.Body.transformToByteArray()));
  }

  for (const obj of await listS3Objects('deleted-attachments', config)) {
    const name = obj.Key.startsWith(deletedPrefix) ? obj.Key.slice(deletedPrefix.length) : '';
    if (!name || name.includes('/')) continue;
    const file = await getS3Client(config).send(new GetObjectCommand({ Bucket: config.s3.bucket, Key: obj.Key }));
    zip.addFile(`uploads/deleted-attachments/${name}`, Buffer.from(await file.Body.transformToByteArray()));
  }
}

async function restoreUploadsFromDirectory(sourceUploadsDir) {
  const config = getStorageConfig();
  if (!fs.existsSync(sourceUploadsDir)) return { restored: 0, deletedAttachmentsRestored: 0 };

  let restored = 0;
  let deletedAttachmentsRestored = 0;
  const deletedSourceDir = path.join(sourceUploadsDir, 'deleted-attachments');

  if (config.provider === 'local') {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    fs.mkdirSync(DELETED_ATTACHMENTS_DIR, { recursive: true });
  }

  for (const entry of fs.readdirSync(sourceUploadsDir, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name === 'deleted-attachments' || !isSafeUploadName(entry.name)) continue;
    await storeUploadBuffer(fs.readFileSync(path.join(sourceUploadsDir, entry.name)), {
      filename: entry.name,
      folder: 'uploads'
    });
    restored++;
  }

  if (fs.existsSync(deletedSourceDir)) {
    for (const entry of fs.readdirSync(deletedSourceDir, { withFileTypes: true })) {
      if (!entry.isFile() || !isSafeUploadName(entry.name)) continue;
      await storeUploadBuffer(fs.readFileSync(path.join(deletedSourceDir, entry.name)), {
        filename: entry.name,
        folder: 'deleted-attachments'
      });
      deletedAttachmentsRestored++;
    }
  }

  return { restored, deletedAttachmentsRestored };
}

function copyDirectory(sourceDir, destDir) {
  if (!fs.existsSync(sourceDir)) return;
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const src = path.join(sourceDir, entry.name);
    const dst = path.join(destDir, entry.name);
    if (entry.isDirectory()) copyDirectory(src, dst);
    else fs.copyFileSync(src, dst);
  }
}

function clearDirectory(targetDir) {
  if (!fs.existsSync(targetDir)) return;
  for (const entry of fs.readdirSync(targetDir)) {
    fs.rmSync(path.join(targetDir, entry), { recursive: true, force: true });
  }
}

function stagePendingRestore(sourceRootDir) {
  fs.mkdirSync(PENDING_RESTORE_ROOT_DIR, { recursive: true });
  clearDirectory(PENDING_RESTORE_ROOT_DIR);
  copyDirectory(sourceRootDir, PENDING_RESTORE_ROOT_DIR);
}

function applyPendingRestoreIfPresent() {
  if (!fs.existsSync(PENDING_RESTORE_ROOT_DIR)) return false;
  copyDirectory(PENDING_RESTORE_ROOT_DIR, DATA_DIR);
  fs.rmSync(PENDING_RESTORE_DIR, { recursive: true, force: true });
  return true;
}

function getPendingRestoreInfo() {
  return {
    pending: fs.existsSync(PENDING_RESTORE_ROOT_DIR),
    path: PENDING_RESTORE_ROOT_DIR
  };
}

module.exports = {
  PENDING_RESTORE_DIR,
  PENDING_RESTORE_ROOT_DIR,
  SECURE_STORAGE_KEYS,
  STORAGE_KEYS,
  addDirectoryToZip,
  appendActiveUploadsToZip,
  applyPendingRestoreIfPresent,
  cleanupActiveUploads,
  decodeUploadUrl,
  deleteUploadByName,
  deleteUploadByUrl,
  ensureSecureSettingsMigrated,
  generateStoredFilename,
  getPendingRestoreInfo,
  getSecureSetting,
  getStorageConfig,
  getUploadReadStream,
  getUploadUrl,
  hasSecureSetting,
  isSafeUploadName,
  migrateLocalUploadsToActiveStorage,
  moveUploadToDeleted,
  readStorageSettings,
  restoreUploadsFromDirectory,
  setSecureSetting,
  stagePendingRestore,
  storeUploadBuffer,
  testS3Connection
};
