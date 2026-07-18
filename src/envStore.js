'use strict';

/**
 * Haven — Safe .env upsert for admin-editable integration keys
 *
 * server.js already writes .env in a few places (JWT_SECRET, VAPID keys), but
 * always with values it generated itself. This module exists for values that
 * arrive over the wire from an admin's browser, which is a different threat
 * model — hence the strict allow-list and format validation below.
 *
 * Two rules that must not be relaxed:
 *
 *  1. Only keys in ALLOWED_KEYS can be written. Without this, one compromised
 *     or careless admin session could set JWT_SECRET, ADMIN_USERNAME, or
 *     HAVEN_DATA_DIR and take over the server on next boot.
 *
 *  2. Values are format-checked and must not contain newlines. A value like
 *     "abc\nJWT_SECRET=known" would otherwise inject a second variable into
 *     the file — a full authentication bypass from a single text field.
 */

const fs = require('fs');
const { ENV_PATH } = require('./paths');

/**
 * Every writable key, with the shape its value must match. Steam and Spotify
 * all issue 32-char hex identifiers; anchoring the pattern also rejects
 * pasted-in whitespace, quotes, and newline injection in one step.
 */
const ALLOWED_KEYS = {
  STEAM_API_KEY:         /^[A-Fa-f0-9]{32}$/,
  SPOTIFY_CLIENT_ID:     /^[A-Fa-f0-9]{32}$/,
  SPOTIFY_CLIENT_SECRET: /^[A-Fa-f0-9]{32}$/,
  LASTFM_API_KEY:        /^[A-Fa-f0-9]{32}$/,
};

function isWritableKey(key) {
  return Object.prototype.hasOwnProperty.call(ALLOWED_KEYS, key);
}

/**
 * Validate a value for a key without writing it.
 * @returns {{ ok: boolean, reason?: string }}
 */
function validate(key, value) {
  if (!isWritableKey(key)) return { ok: false, reason: 'unknown key' };
  if (typeof value !== 'string') return { ok: false, reason: 'value must be text' };

  const trimmed = value.trim();
  if (!trimmed) return { ok: false, reason: 'value is empty' };
  // Belt and braces: the per-key regexes below already exclude these, but this
  // check is the one that must never be removed if a looser key is ever added.
  if (/[\r\n]/.test(trimmed)) return { ok: false, reason: 'value cannot contain line breaks' };
  if (!ALLOWED_KEYS[key].test(trimmed)) {
    return { ok: false, reason: 'that does not look like a valid key — expected 32 hex characters' };
  }
  return { ok: true };
}

/**
 * Write (or replace) a key in .env and update process.env so it takes effect
 * without a restart. Returns the same shape as validate().
 *
 * The file is rewritten line-by-line rather than with a blanket regex replace,
 * so a value containing regex metacharacters can't corrupt unrelated lines and
 * commented-out entries (`# STEAM_API_KEY=`) are left alone rather than being
 * mistaken for the real setting.
 */
function setEnvValue(key, value) {
  const check = validate(key, value);
  if (!check.ok) return check;

  const trimmed = value.trim();

  let content = '';
  try {
    content = fs.readFileSync(ENV_PATH, 'utf-8');
  } catch {
    return { ok: false, reason: 'could not read .env' };
  }

  const lines = content.split(/\r?\n/);
  let replaced = false;
  for (let i = 0; i < lines.length; i++) {
    // Match assignments only, ignoring leading whitespace. Commented lines are
    // intentionally skipped so we never "uncomment" something unexpectedly.
    const m = lines[i].match(/^\s*([A-Z0-9_]+)\s*=/);
    if (m && m[1] === key) {
      lines[i] = `${key}=${trimmed}`;
      replaced = true;
      break;
    }
  }
  if (!replaced) {
    // Drop trailing blanks before appending, otherwise every saved key leaves
    // another empty line behind and the file slowly fills with gaps.
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    lines.push(`${key}=${trimmed}`);
  }

  try {
    // 0o600: the file holds JWT_SECRET and OAuth secrets. No-op on Windows,
    // meaningful on the Linux/Docker deployments where Haven usually runs.
    fs.writeFileSync(ENV_PATH, lines.join('\n') + '\n', { mode: 0o600 });
  } catch {
    return { ok: false, reason: 'could not write .env — check file permissions' };
  }

  process.env[key] = trimmed;
  return { ok: true };
}

/** Remove a key from .env and process.env. */
function clearEnvValue(key) {
  if (!isWritableKey(key)) return { ok: false, reason: 'unknown key' };
  let content = '';
  try {
    content = fs.readFileSync(ENV_PATH, 'utf-8');
  } catch {
    return { ok: false, reason: 'could not read .env' };
  }
  const lines = content.split(/\r?\n/).filter(line => {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=/);
    return !(m && m[1] === key);
  });
  try {
    fs.writeFileSync(ENV_PATH, lines.join('\n'), { mode: 0o600 });
  } catch {
    return { ok: false, reason: 'could not write .env — check file permissions' };
  }
  delete process.env[key];
  return { ok: true };
}

module.exports = { setEnvValue, clearEnvValue, validate, isWritableKey, ALLOWED_KEYS };
