'use strict';

// File types an admin chose to refuse as uploads (#5833), such as exe or
// bat, kept in server_settings.blocked_upload_extensions as "exe,bat,dll".

const MAX_TYPES = 100;

// The setting cleaned up: lowercase types without the dot, letters and digits
// only, each once, comma separated. null when it holds anything else.
function normalizeBlockedExtensions(value) {
  if (typeof value !== 'string') return null;
  const out = [];
  for (const part of value.split(/[\s,;]+/)) {
    const ext = part.toLowerCase().replace(/^\*?\./, '');
    if (!ext) continue;
    if (!/^[a-z0-9]{1,15}$/.test(ext)) return null;
    if (!out.includes(ext)) out.push(ext);
  }
  if (out.length > MAX_TYPES) return null;
  return out.join(',');
}

// The type a file name ends in, read the way Windows reads it: trailing dots
// and spaces are dropped, so "setup.exe." is still an exe.
function fileExtension(name) {
  const m = /\.([^.\\/]+)$/.exec(String(name || '').replace(/[.\s]+$/, ''));
  return m ? m[1].toLowerCase() : '';
}

// The blocked type a file name has, or '' when it may be uploaded.
function blockedUploadType(name, setting) {
  const ext = fileExtension(name);
  if (!ext || !setting) return '';
  return String(setting).split(',').includes(ext) ? ext : '';
}

module.exports = { normalizeBlockedExtensions, fileExtension, blockedUploadType };
