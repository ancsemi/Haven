'use strict';

// PostgreSQL registration uses a pinned transaction for the checks that own
// writes: username uniqueness, admin bootstrap and invite consumption. Network
// CAPTCHA/avatar work and password hashing happen before taking that lock.
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { parseBlockedNames, blockedWordIn, REFUSAL } = require('../../blockedNames');

const unavailable = { error: 'Registration could not be completed: invalid username', code: 'username_unavailable' };
function refuse(status, body) { throw Object.assign(new Error(body.error), { status, body }); }
const settingKeys = [
  'registration_token_enabled', 'invites_bypass_registration_token', 'registration_token',
  'whitelist_enabled', 'registration_captcha_enabled', 'turnstile_secret_key',
  'registration_rate_limit_enabled', 'registration_rate_limit_per_hour',
  'blocked_name_words',
];

async function gates(db, input, verifiedSecret) {
  const rows = await db.prepare(`SELECT key, value FROM server_settings WHERE key IN (${settingKeys.map(() => '?').join(',')})`).all(...settingKeys);
  const settings = Object.fromEntries(rows.map(row => [row.key, row.value]));
  if (blockedWordIn(input.username, parseBlockedNames(settings.blocked_name_words))) refuse(400, { error: REFUSAL });
  let invite = null;
  if (settings.registration_token_enabled === 'true') {
    if (settings.invites_bypass_registration_token === 'true' && input.inviteCode) {
      invite = await db.prepare(`SELECT *, (expires_at IS NOT NULL AND expires_at <= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')) AS is_expired
        FROM invite_codes WHERE code = ?${db._transactionClient ? ' FOR UPDATE' : ''}`).get(input.inviteCode);
      if (!invite) refuse(403, { error: 'Invalid invite link.' });
      if (!invite.enabled) refuse(403, { error: 'This invite link has been disabled.' });
      if (invite.is_expired) refuse(403, { error: 'This invite link has expired.' });
      if (invite.max_uses > 0 && invite.spent >= invite.max_uses) refuse(403, { error: 'This invite link has reached its use limit.' });
    } else {
      const expected = String(settings.registration_token || '').trim();
      if (!expected) refuse(403, { error: 'Registration is restricted. Ask the server admin for an invite.' });
      if (input.registrationToken !== expected) refuse(403, { error: 'Invalid or missing registration token.' });
    }
  }
  if (settings.whitelist_enabled === 'true') {
    const row = await db.prepare(`SELECT 1 FROM whitelist WHERE ${db.sql.caseInsensitiveEqual('username')}`).get(input.username);
    if (!row) refuse(403, { error: 'Registration is restricted. Your username is not on the whitelist.' });
  }
  const secret = settings.registration_captcha_enabled === 'true' ? String(settings.turnstile_secret_key || '').trim() : '';
  if (secret && !input.captchaToken) refuse(400, { error: 'Please complete the CAPTCHA.' });
  if (verifiedSecret !== undefined && secret && verifiedSecret !== secret) refuse(403, { error: 'CAPTCHA verification failed. Please try again.' });
  if (settings.registration_rate_limit_enabled === 'true' && db._transactionClient) {
    const limit = Math.max(1, parseInt(settings.registration_rate_limit_per_hour, 10) || 20);
    const count = await db.prepare("SELECT COUNT(*) AS n FROM users WHERE created_at >= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - INTERVAL '1 hour'").get();
    if (count.n >= limit) refuse(429, { error: 'This server is temporarily limiting new sign-ups. Please try again later.' });
  }
  return { invite, secret };
}

async function grantAdminRole(tx, userId) {
  const row = await tx.prepare("SELECT value FROM server_settings WHERE key = 'admin_role_id'").get();
  const roleId = parseInt(row && row.value, 10);
  if (!Number.isInteger(roleId) || roleId <= 0) return;
  if (!await tx.prepare('SELECT id FROM roles WHERE id = ?').get(roleId)) return;
  await tx.prepare('INSERT INTO user_roles (user_id, role_id, channel_id, granted_by) VALUES (?, ?, NULL, ?) ON CONFLICT DO NOTHING').run(userId, roleId, userId);
}

async function provision(tx, userId, username) {
  const roles = await tx.prepare("SELECT id, link_channel_access FROM roles WHERE auto_assign = 1 AND scope = 'server'").all();
  for (const role of roles) {
    await tx.prepare('INSERT INTO user_roles (user_id, role_id, channel_id, granted_by) VALUES (?, ?, NULL, NULL) ON CONFLICT DO NOTHING').run(userId, role.id);
    if (role.link_channel_access) {
      await tx.prepare(`INSERT INTO channel_members (channel_id, user_id)
        SELECT channel_id, ? FROM role_channel_access WHERE role_id = ? AND grant_on_promote = 1
        ON CONFLICT DO NOTHING`).run(userId, role.id);
    }
  }
  const row = await tx.prepare("SELECT value FROM server_settings WHERE key = 'welcome_message'").get();
  const template = row && typeof row.value === 'string' ? row.value.trim() : '';
  const events = [];
  if (template) {
    const text = template.replace(/\{user\}/gi, username).slice(0, 500);
    const channels = await tx.prepare('SELECT id, code FROM channels WHERE is_dm = 0 AND show_welcome = 1').all();
    for (const ch of channels) {
      const message = await tx.prepare("INSERT INTO messages (channel_id, user_id, content, type) VALUES (?, ?, ?, 'welcome') RETURNING id, created_at").get(ch.id, userId, text);
      events.push({ channelCode: ch.code, message: { ...message, user_id: userId, content: text, type: 'welcome' } });
    }
  }
  return events;
}

async function registerPostgres(req, res, options) {
  const { db, sanitizeString, adminUsername, verifyTurnstile, downloadSSOAvatar, signOptions, secret } = options;
  try {
    const username = sanitizeString(req.body.username, 20);
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    const eulaVersion = typeof req.body.eulaVersion === 'string' ? req.body.eulaVersion.trim() : '';
    const ageVerified = req.body.ageVerified === true;
    if (!username || !password) refuse(400, { error: 'Username and password required' });
    if (!eulaVersion) refuse(400, { error: 'You must accept the Terms of Service & Release of Liability Agreement' });
    if (!ageVerified) refuse(400, { error: 'You must confirm that you are 18 years of age or older' });
    if (username.length < 3 || username.length > 20) refuse(400, { error: 'Username must be 3-20 characters' });
    if (!/^[a-zA-Z0-9_]+$/.test(username)) refuse(400, { error: 'Username: letters, numbers, underscores only' });
    if (password.length < 8 || password.length > 128) refuse(400, { error: 'Password must be 8-128 characters' });
    if (password.toLowerCase().includes(username.toLowerCase())) refuse(400, { error: 'Password must not contain your username' });
    const input = {
      username, inviteCode: typeof req.body.inviteCode === 'string' ? req.body.inviteCode.trim() : '',
      registrationToken: typeof req.body.registrationToken === 'string' ? req.body.registrationToken.trim() : '',
      captchaToken: typeof req.body.captchaToken === 'string' ? req.body.captchaToken : '',
    };
    const checked = await gates(db, input);
    if (checked.secret && !await verifyTurnstile(checked.secret, input.captchaToken, req.ip)) {
      refuse(403, { error: 'CAPTCHA verification failed. Please try again.' });
    }
    if (await db.prepare(`SELECT id FROM users WHERE ${db.sql.caseInsensitiveEqual('username')}`).get(username)) refuse(400, unavailable);
    const hash = await bcrypt.hash(password, 12);
    let avatar = null;
    if (typeof req.body.ssoProfilePicture === 'string' && req.body.ssoProfilePicture.trim()) {
      try { avatar = await downloadSSOAvatar(req.body.ssoProfilePicture.trim().slice(0, 500)); }
      catch (err) { console.warn('[SSO] Avatar download failed:', err.message); }
    }
    const result = await db.withTransaction(async tx => {
      await tx.prepare("SELECT pg_advisory_xact_lock(hashtext(current_schema() || ':haven_registration'))").get();
      const current = await gates(tx, input, checked.secret);
      if (await tx.prepare(`SELECT id FROM users WHERE ${tx.sql.caseInsensitiveEqual('username')}`).get(username)) refuse(400, unavailable);
      const anyAdmin = await tx.prepare('SELECT id FROM users WHERE is_admin = 1 LIMIT 1').get();
      if (anyAdmin && username.toLowerCase() === adminUsername) refuse(400, unavailable);
      const isAdmin = !anyAdmin && username.toLowerCase() === adminUsername ? 1 : 0;
      if (current.invite) {
        const took = await tx.prepare('UPDATE invite_codes SET spent = spent + 1 WHERE id = ? AND (max_uses <= 0 OR spent < max_uses)').run(current.invite.id);
        if (!took.changes) refuse(403, { error: 'This invite link has reached its use limit.' });
      }
      const user = await tx.prepare('INSERT INTO users (username, password_hash, is_admin, avatar) VALUES (?, ?, ?, ?) RETURNING id').get(username, hash, isAdmin, avatar);
      if (isAdmin) await grantAdminRole(tx, user.id);
      if (current.invite) await tx.prepare('INSERT INTO invite_code_uses (invite_code_id, user_id) VALUES (?, ?)').run(current.invite.id, user.id);
      const events = await provision(tx, user.id, username);
      await tx.prepare('INSERT INTO eula_acceptances (user_id, version, ip_address, age_verified) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, version) DO NOTHING')
        .run(user.id, eulaVersion, req.ip || req.socket.remoteAddress || '', 1);
      return { id: user.id, isAdmin, events };
    });
    for (const event of result.events) req.app.get('io')?.to('channel:' + event.channelCode).emit('welcome-message', event);
    const token = jwt.sign({ id: result.id, username, isAdmin: !!result.isAdmin, displayName: username, pwv: 1 }, secret, await signOptions());
    res.json({ token, user: { id: result.id, username, isAdmin: !!result.isAdmin, displayName: username } });
  } catch (err) {
    if (err.status) return res.status(err.status).json(err.body);
    if (err.code === '23505') return res.status(400).json(unavailable);
    console.error('[register] PostgreSQL registration failed:', err.code || err.message);
    res.status(500).json({ error: 'Server error' });
  }
}

module.exports = { registerPostgres, grantAdminRole };
