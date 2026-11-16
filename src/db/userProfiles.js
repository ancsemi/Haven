'use strict';

const { parseBorderTransform, sanitizeBorderTransform } = require('../socketHandlers/helpers');

function readProfile(db, userId) {
  return db.prepare(`
    SELECT u.id, u.username, COALESCE(u.display_name, u.username) AS "displayName",
           u.avatar, u.avatar_shape, u.border, u.border_transform, u.animate_profile, u.status, u.status_text, u.bio, u.created_at,
           CASE WHEN u.birthday_hidden <> 0 OR u.birthday_hidden IS NULL THEN NULL
                WHEN u.birthday_hide_year = 0 THEN u.birthday ELSE substr(u.birthday, 6) END AS birthday
    FROM users u WHERE u.id = ?
  `).get(userId);
}

function profileServerRoles(db, userId) {
  return db.prepare(`
    SELECT DISTINCT r.id, r.name, r.level, r.color, r.color2, r.color_shimmer, COALESCE(r.show_on_profile, 1) AS show_on_profile
    FROM roles r JOIN user_roles ur ON r.id = ur.role_id
    WHERE ur.user_id = ? AND ur.channel_id IS NULL
    GROUP BY r.id ORDER BY r.level DESC
  `).all(userId);
}

function profileChannel(db, code) {
  return db.prepare('SELECT id FROM channels WHERE code = ?').get(code);
}

function profileChannelRoles(db, userId, channelIds) {
  const marks = channelIds.map(() => '?').join(',');
  const level = db.kind === 'postgres' ? 'MAX(COALESCE(ur.custom_level, r.level))' : 'COALESCE(ur.custom_level, r.level)';
  return db.prepare(`
    SELECT DISTINCT r.id, r.name, ${level} AS level, r.color, r.color2, r.color_shimmer, COALESCE(r.show_on_profile, 1) AS show_on_profile
    FROM roles r JOIN user_roles ur ON r.id = ur.role_id
    WHERE ur.user_id = ? AND ur.channel_id IN (${marks})
    GROUP BY r.id ORDER BY ${db.kind === 'postgres' ? 'level' : 'r.level'} DESC
  `).all(userId, ...channelIds);
}

function mergeProfileRoles(roles, channelRoles) {
  const ids = new Set(roles.map(role => role.id));
  for (const role of channelRoles) {
    if (ids.has(role.id)) continue;
    roles.push(role);
    ids.add(role.id);
  }
  roles.sort((a, b) => b.level - a.level);
}

function visibleProfileRoles(roles, seesHidden) {
  if (roles.length > 1) {
    const base = roles.findIndex(role => role.name === 'User' && role.level <= 1);
    if (base !== -1) roles.splice(base, 1);
  }
  // A role switched off for profile cards (#5822) is left off for
  // everyone but the people who manage roles, who see it marked.
  return roles.filter(role => seesHidden || role.show_on_profile !== 0)
    .map(({ show_on_profile, ...role }) => show_on_profile === 0 ? { ...role, hiddenOnProfile: true } : role);
}

function profileCard(row, viewerId, isOnline) {
  // Invisible means offline to everyone else, here as in the member list.
  const hidden = row.status === 'invisible' && row.id !== viewerId;
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    avatar: row.avatar || null,
    avatarShape: row.avatar_shape || 'circle',
    border: row.border || null,
    borderTransform: parseBorderTransform(row.border_transform),
    animateProfile: row.animate_profile || 'trigger',
    status: hidden ? 'offline' : (row.status || 'online'),
    statusText: row.status_text || '',
    bio: row.bio || '',
    // MM-DD, or YYYY-MM-DD when the owner turned off Hide birth year.
    birthday: row.birthday || null,
    online: !hidden && isOnline,
    createdAt: row.created_at,
  };
}

function avatarShape(value) {
  const valid = ['circle', 'rounded', 'squircle', 'hex', 'diamond'];
  return valid.includes(value) ? value : 'circle';
}

function animationMode(value) {
  return value === 'disabled' ? value : 'trigger';
}

function borderFit(value) {
  const clean = sanitizeBorderTransform(value);
  return clean && clean.length ? clean : null;
}

function setAvatarShape(db, userId, shape) {
  return db.prepare('UPDATE users SET avatar_shape = ? WHERE id = ?').run(shape, userId);
}

function setAnimationMode(db, userId, mode) {
  return db.prepare('UPDATE users SET animate_profile = ? WHERE id = ?').run(mode, userId);
}

function setBorderFit(db, userId, fit) {
  return db.prepare('UPDATE users SET border_transform = ? WHERE id = ?').run(fit ? JSON.stringify(fit) : null, userId);
}

function setBio(db, userId, bio) {
  return db.prepare('UPDATE users SET bio = ? WHERE id = ?').run(bio, userId);
}

// A real calendar date from 1900 up to today as YYYY-MM-DD, else null. A day
// of slack lets someone whose local date is ahead of UTC pick their today.
function cleanBirthday(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  if (y < 1900 || date.getTime() > Date.now() + 86400000) return null;
  return value;
}

function birthdayForUpdate(db, userId) {
  const lock = db.kind === 'postgres' ? ' FOR NO KEY UPDATE' : '';
  return db.prepare('SELECT birthday, birthday_set_at, birthday_hide_year, birthday_hidden FROM users WHERE id = ?' + lock).get(userId);
}

function birthdayChange(row, data, birthday) {
  if (row.birthday && birthday && birthday !== row.birthday) return { error: 'Your birthday can only be set once.' };
  const firstSet = !row.birthday && !!birthday;
  const date = row.birthday || birthday;
  const setAt = firstSet ? new Date().toISOString() : row.birthday_set_at;
  // A missing or NULL flag counts as hidden, so privacy fails closed.
  const wasHidden = row.birthday_hidden !== 0;
  const hidden = typeof data.hidden === 'boolean' ? data.hidden
    : data.birthday === null ? true
    : firstSet ? false
    : wasHidden;
  const hideYear = typeof data.hideYear === 'boolean' ? data.hideYear : row.birthday_hide_year !== 0;
  // Member lists only carry MM-DD, so Hide birth year alone leaves them be.
  const listsChanged = date !== row.birthday || hidden !== wasHidden;
  if (!listsChanged && hideYear === (row.birthday_hide_year !== 0)) return;
  return {
    listsChanged,
    value: { birthday: date, birthdaySetAt: setAt, birthdayHideYear: hideYear, birthdayHidden: hidden },
  };
}

function setBirthday(db, userId, value) {
  return db.prepare('UPDATE users SET birthday = ?, birthday_set_at = ?, birthday_hide_year = ?, birthday_hidden = ? WHERE id = ?')
    .run(value.birthday, value.birthdaySetAt, value.birthdayHideYear ? 1 : 0, value.birthdayHidden ? 1 : 0, userId);
}

function lockAccountNames(db) {
  return db.prepare("SELECT pg_advisory_xact_lock(hashtext(current_schema() || ':haven_registration'))").get();
}

function displayNameForUpdate(db, userId) {
  const sql = db.kind === 'postgres'
    ? 'SELECT username, display_name, display_name_locked, is_admin, password_version FROM users WHERE id = ? FOR NO KEY UPDATE'
    : 'SELECT display_name_locked FROM users WHERE id = ?';
  return db.prepare(sql).get(userId);
}

function conflictingDisplayName(db, userId, name) {
  return db.prepare(`
    SELECT id FROM users WHERE id != ?
      AND (LOWER(display_name) = LOWER(?) OR (display_name IS NULL AND LOWER(username) = LOWER(?)))
    LIMIT 1
  `).get(userId, name, name);
}

function setDisplayName(db, userId, name) {
  return db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(name, userId);
}

function dmPartners(db, userId) {
  return db.prepare(`
    SELECT DISTINCT cm2.user_id FROM channel_members cm1
    JOIN channels c ON c.id = cm1.channel_id AND c.is_dm = 1
    JOIN channel_members cm2 ON cm2.channel_id = c.id AND cm2.user_id != ?
    WHERE cm1.user_id = ?
  `).all(userId, userId);
}

module.exports = {
  readProfile, profileServerRoles, profileChannel, profileChannelRoles, mergeProfileRoles, visibleProfileRoles, profileCard,
  avatarShape, animationMode, borderFit, setAvatarShape, setAnimationMode, setBorderFit, setBio,
  cleanBirthday, birthdayForUpdate, birthdayChange, setBirthday,
  lockAccountNames, displayNameForUpdate, conflictingDisplayName, setDisplayName, dmPartners,
};
