'use strict';

// Keys under uploads/: the part of a /uploads/... URL after "/uploads/".

const DELETED_PREFIX = 'deleted-attachments/';

// Strict check for paths Haven writes or moves. Serving does not use it:
// stored names keep the uploader's own extension, which may hold characters
// this refuses.
function isSafeUploadRelPath(relPath) {
  if (typeof relPath !== 'string' || !relPath) return false;
  if (!/^((?!\.\.)(?!\.\/)(?!\/)[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/.test(relPath)) return false;
  const parts = relPath.split('/');
  if (parts.some(p => !p || p === '.' || p === '..')) return false;
  return true;
}

// What the storage layer itself accepts: anything that stays inside uploads/.
// Names keep the uploader's extension (spaces, accents), so this checks
// containment, not characters.
function isContainedRelPath(relPath) {
  if (typeof relPath !== 'string' || !relPath || relPath.length > 1024) return false;
  if (/[\\:\0]/.test(relPath) || relPath.startsWith('/')) return false;
  return relPath.split('/').every(p => p && p !== '.' && p !== '..');
}

module.exports = { DELETED_PREFIX, isSafeUploadRelPath, isContainedRelPath };
