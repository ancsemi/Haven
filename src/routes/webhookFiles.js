'use strict';

// Files sent with a bot's message. A bot that forwarded only links (from
// Discord, say) saw its pictures break once those links expired, so a bot can
// send the files themselves as multipart/form-data: the message's fields in
// "payload_json" (or as plain form fields) and the files under "files[0]",
// "files[1]" and so on, the way Discord's webhooks take them.
//
// The files go through the same steps as a member's: the privacy pass, the
// server's upload cap, the admin's blocked file types, the disk guard and
// upload accounting (charged to the person who made the bot). The bot's
// creator must still be allowed to upload files.

const fs = require('fs');
const path = require('path');
const multer = require('multer');
const storage = require('../storage');
const { blockedUploadType } = require('../uploadBlocklist');

const MAX_FILES = 10;
const FILE_FIELD = /^(?:files?(?:\[\d{1,2}\])?|file\d{0,2})$/;

const IMAGE_EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp' };

function isImageBytes(hdr, mime) {
  if (mime === 'image/jpeg') return hdr[0] === 0xFF && hdr[1] === 0xD8 && hdr[2] === 0xFF;
  if (mime === 'image/png') return hdr[0] === 0x89 && hdr[1] === 0x50 && hdr[2] === 0x4E && hdr[3] === 0x47;
  if (mime === 'image/gif') return hdr.subarray(0, 6).toString('latin1').startsWith('GIF8');
  if (mime === 'image/webp') return hdr.subarray(0, 4).toString('latin1') === 'RIFF' && hdr.subarray(8, 12).toString('latin1') === 'WEBP';
  return false;
}

function readHeader(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const hdr = Buffer.alloc(12);
    fs.readSync(fd, hdr, 0, 12, 0);
    return hdr;
  } finally {
    fs.closeSync(fd);
  }
}

// The name shown on a file card, safe inside [file:NAME](url|size).
function displayName(raw) {
  const name = Buffer.from(String(raw || 'file'), 'latin1').toString('utf8')
    .replace(/[\u0000-\u001f\u007f[\]()|]/g, '_').trim().slice(0, 200);
  return name || 'file';
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function removeTemp(file) {
  if (!file || file._admitted || !file.path) return;
  try { fs.unlinkSync(file.path); } catch (err) {
    if (err.code !== 'ENOENT') console.warn('[webhook-files] could not remove a temporary upload:', err.code);
  }
}

module.exports = function createWebhookFiles({ uploadStorage, uploadDiskGuard, findWebhook, getDb, verifyAdminFromDb, userHasPermission, recordUploadOwnership }) {
  function serverCapMb() {
    const mb = parseInt(getDb().prepare("SELECT value FROM server_settings WHERE key = 'max_upload_mb'").get()?.value, 10);
    return Number.isFinite(mb) && mb > 0 ? mb : 25;
  }

  // Middleware for a multipart post. The bot is looked up before any file is
  // read, so an unknown token never gets to write to disk.
  function parse(req, res, next) {
    const webhook = findWebhook(req.params.token);
    if (!webhook) return res.status(404).json({ error: 'Webhook not found or inactive' });
    const ownerId = webhook.created_by;
    const ownerMayUpload = Number.isInteger(ownerId)
      && (verifyAdminFromDb({ id: ownerId }) || userHasPermission(ownerId, 'upload_files'));
    if (!ownerMayUpload) return res.status(403).json({ error: 'The person who made this bot is not allowed to upload files' });

    uploadDiskGuard(req, res, () => {
      const capMb = serverCapMb();
      const upload = multer({
        storage: uploadStorage,
        limits: { fileSize: capMb * 1024 * 1024 + 1, files: MAX_FILES, fields: 12, fieldSize: 64 * 1024, parts: MAX_FILES + 12 },
      }).any();
      upload(req, res, (err) => {
        const files = Array.isArray(req.files) ? req.files : [];
        // Whatever the route does not keep is removed once it has answered.
        res.on('close', () => files.forEach(removeTemp));
        if (err) {
          const msg = err.code === 'LIMIT_FILE_SIZE' ? `File too large (max ${capMb} MB)`
            : err.code === 'LIMIT_FILE_COUNT' ? `At most ${MAX_FILES} files per message`
            : err.message;
          return res.status(400).json({ error: msg, code: err.code });
        }
        if (files.some(f => !FILE_FIELD.test(f.fieldname))) {
          return res.status(400).json({ error: 'Send files as files[0], files[1] and so on' });
        }
        if (typeof req.body?.payload_json === 'string') {
          let body;
          try { body = JSON.parse(req.body.payload_json); } catch { body = null; }
          if (!body || typeof body !== 'object' || Array.isArray(body)) {
            return res.status(400).json({ error: 'payload_json must be a JSON object' });
          }
          req.body = body;
        } else {
          // Plain form fields are strings; the yes/no ones are read as such.
          const body = { ...req.body };
          for (const key of ['silent', 'ephemeral']) {
            if (body[key] === 'true') body[key] = true;
            else if (body[key] === 'false') body[key] = false;
          }
          req.body = body;
        }
        req.webhookFiles = files;
        next();
      });
    });
  }

  // Checks every file first, then stores them. Returns the message lines in
  // the format the app shows (a picture's address, or a file card), or an
  // { error } when one is refused, in which case nothing is kept.
  async function store(files, webhook) {
    const blockedList = getDb().prepare("SELECT value FROM server_settings WHERE key = 'blocked_upload_extensions'").get()?.value;
    const planned = [];
    for (const file of files) {
      const name = displayName(file.originalname);
      const blocked = blockedUploadType(name, blockedList) || blockedUploadType(file.filename, blockedList);
      if (blocked) return { error: `.${blocked} files can't be uploaded on this server` };
      let finalName = file.filename;
      let image = false;
      const safeExt = IMAGE_EXT[file.mimetype];
      if (safeExt) {
        let hdr;
        try { hdr = readHeader(file.path); } catch { return { error: 'Failed to read an uploaded file' }; }
        if (isImageBytes(hdr, file.mimetype)) {
          image = true;
          if (path.extname(finalName).toLowerCase() !== safeExt) finalName = finalName.replace(/\.[^.]*$/, '') + safeExt;
        }
      }
      planned.push({ file, name, finalName, image });
    }
    const lines = [];
    for (const p of planned) {
      if (p.finalName !== p.file.filename) {
        const dest = path.join(path.dirname(p.file.path), p.finalName);
        fs.renameSync(p.file.path, dest);
        p.file.path = dest;
      }
      await storage.admitUpload(p.file, p.finalName);
      p.file._admitted = true;
      recordUploadOwnership(webhook.created_by, p.finalName, p.file.size, 'channel');
      const url = `/uploads/${p.finalName}`;
      lines.push(p.image ? url : `[file:${p.name}](${url}|${formatSize(p.file.size)})`);
    }
    return { lines };
  }

  return { parse, store, MAX_FILES };
};

module.exports.displayName = displayName;
