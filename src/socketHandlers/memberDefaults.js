'use strict';

// Defaults for new members (#5739): the admin's controls, and the one-time
// hand-over of the account-level defaults to each member.

const path = require('node:path');
const memberDefaults = require('../memberDefaults');
const { createSettingEffects } = require('./settingEffects');
const { BUILTIN_THEMES, compatibleThemeFiles, validatedThemeDefault } = require('../themeMetadata');

const THEMES_DIR = path.join(__dirname, '..', '..', 'themes');

// The server's Default Theme a shared theme can stand in for: a built-in, or
// a published custom theme that still works. '' when it can be neither.
function usableDefaultTheme(db, theme) {
  if (BUILTIN_THEMES.includes(theme)) return theme;
  if (typeof theme !== 'string' || !theme.startsWith('file:')) return '';
  let published = [];
  try {
    published = JSON.parse(db.prepare("SELECT value FROM server_settings WHERE key = 'published_themes'").get()?.value || '[]');
  } catch { return ''; } // malformed list: nothing counts as published
  if (!Array.isArray(published)) return '';
  return validatedThemeDefault(THEMES_DIR, theme, compatibleThemeFiles(THEMES_DIR, published));
}

module.exports = function register(socket, ctx) {
  const { io, db, userHasPermission, automod, emitOnlineUsers, onReferrerPolicyChange, logAudit } = ctx;
  const { emitSettingChanged, auditSettingChange } = ctx.settingEffects
    || createSettingEffects({ io, automod, channelUsers: ctx.state?.channelUsers || new Map(), emitOnlineUsers, onReferrerPolicyChange, logAudit });

  // Same gate as the rest of the server settings. Any error denies.
  const canManage = () => {
    try {
      return !!(socket.user && (socket.user.isAdmin || userHasPermission(socket.user.id, 'manage_server')));
    } catch (err) {
      console.warn('[member-defaults] permission check failed:', err.message);
      return false;
    }
  };

  const saved = (value, message) => {
    emitSettingChanged(memberDefaults.SETTING_KEY, value);
    auditSettingChange(socket.user, memberDefaults.SETTING_KEY, value);
    socket.emit('toast', { message, type: 'success' });
  };

  socket.on('set-member-defaults', (data) => {
    if (!canManage()) return socket.emit('error-msg', 'Only admins can change server settings');
    if (!data || typeof data !== 'object') return;
    const value = memberDefaults.saveDefaults(db, data.settings);
    if (!value) return socket.emit('error-msg', 'Pick at least one setting to share');
    saved(value, 'Defaults for new members saved');

    // A shared theme is also the server's Default Theme (#5747), which the
    // sign-in page and members who never picked a theme see.
    const theme = usableDefaultTheme(db, memberDefaults.readSnapshot(db).s.theme);
    const current = db.prepare("SELECT value FROM server_settings WHERE key = 'default_theme'").get()?.value || '';
    if (theme && theme !== current) {
      db.prepare('INSERT OR REPLACE INTO server_settings (key, value) VALUES (?, ?)').run('default_theme', theme);
      emitSettingChanged('default_theme', theme);
      auditSettingChange(socket.user, 'default_theme', theme);
    }
  });

  socket.on('clear-member-defaults', () => {
    if (!canManage()) return socket.emit('error-msg', 'Only admins can change server settings');
    saved(memberDefaults.clearDefaults(db), 'Defaults for new members cleared');
  });

  socket.on('push-member-defaults', () => {
    if (!canManage()) return socket.emit('error-msg', 'Only admins can change server settings');
    const value = memberDefaults.bumpDefaults(db);
    if (!value) return socket.emit('error-msg', 'Save some defaults first');
    saved(value, 'Everyone gets these defaults once at their next load');
  });

  // Asked by the member's own client at load. Only ever touches the asking
  // member's own preferences.
  socket.on('apply-member-defaults', () => {
    if (!socket.user || !socket.user.id) return;
    let applied = {};
    try {
      applied = memberDefaults.applyAccountDefaults(db, socket.user.id);
    } catch (err) {
      console.warn('[member-defaults] could not apply:', err.message);
    }
    socket.emit('member-defaults-applied', applied);
  });
};
