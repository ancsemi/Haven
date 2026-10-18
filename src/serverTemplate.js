'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { sanitizeText, VALID_ROLE_PERMS, ADMIN_ONLY_PERMS, CHANNEL_NAME_RE, ROLE_MENU_EMOJI_RE, roleMenuContent, normalizeWordGroups, validEscalation } = require('./socketHandlers/helpers');
const { sniffImageType, stripImageBuffer } = require('./imageMetadata');
const { generateUniqueChannelCode } = require('./channelRotation');
const diskGuard = require('./diskGuard');
const { STAGING_DIR } = require('./paths');
const { MEMBER_PERMS, getAdminRoleId } = require('./roleDefaults');
const { normalizeHost } = require('../public/js/automod-rules.js');
const { BUILTIN_THEMES, isThemeFilename, parseThemeMetadata } = require('./themeMetadata');
const memberDefaults = require('./memberDefaults');
const { MEDIA_GROUP_LAYOUTS } = require('./mediaGroup');
const FORMAT = 'haven-server-template';
const VERSION = 1;
const LIMITS = { bytes: 12 * 1024 * 1024, asset: 2 * 1024 * 1024, theme: 512 * 1024, assets: 8 * 1024 * 1024, assetCount: 200, channels: 500, roles: 100, posts: 500, post: 16000, webhooks: 200, domains: 2000, menus: 50, access: 5000, emojis: 500, stickers: 500, categories: 200 };
const SORT_MODES = ['manual', 'alpha', 'created', 'oldest', 'dynamic'];
const ROLLBACK = Symbol('rollback');
const REF_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const LABEL_RE = /^[^<>\u0000-\u001f\u007f]+$/;
const ASSET_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.(png|jpe?g|gif|webp)$/;
const ASSET_TOKEN_RE = /\{\{asset:([^{}]{1,80})\}\}/g;
const UPLOAD_REF_RE = /\/uploads\/([A-Za-z0-9][A-Za-z0-9_.-]{0,120})(?![A-Za-z0-9_./-])/g;
const IMAGE_EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' };
// Where template images are read from and written to: this server's storage
// (src/storage, which also keeps the media index), or a plain uploads folder
// given by path, as the tests do with two servers in one process.
function mediaFor(uploadsDir) {
  if (!uploadsDir) return require('./storage');
  const local = new (require('./storage/local').LocalStorage)(uploadsDir);
  return { head: (rel) => local.head(rel), readBuffer: (rel) => local.readBuffer(rel), admit: (rel, file) => local.put(rel, file), remove: (rel) => local.remove(rel) };
}
// Array.map, one item after another, for steps that read files: the order
// assets are met in decides their names.
async function mapInOrder(list, fn) {
  const out = [];
  for (const x of list) out.push(await fn(x));
  return out;
}
const WEBHOOK_EVENTS = ['message', 'reaction-added', 'member-joined'];
const FORUM_VIEWS = ['list', 'gallery', 'feed'];
const FORUM_SHAPES = ['square', '4:3', '3:4', '3:2', '2:3', '16:9', '9:16'];
const CHANNEL_FIELDS = [
  ['private', 'is_private', 'flag', null, false], ['forum', 'is_forum', 'flag', null, false], ['readOnly', 'read_only', 'flag', null, false],
  ['text', 'text_enabled', 'flag', null, true], ['voice', 'voice_enabled', 'flag', null, true], ['media', 'media_enabled', 'flag', null, true],
  ['streams', 'streams_enabled', 'flag', null, true], ['music', 'music_enabled', 'flag', null, true], ['soundboard', 'soundboard_enabled', 'flag', null, true],
  ['reactions', 'reactions_enabled', 'flag', null, true], ['nsfw', 'is_nsfw', 'flag', null, false], ['sortAlphabetical', 'sort_alphabetical', 'flag', null, false],
  ['cleanupExempt', 'cleanup_exempt', 'flag', null, false], ['welcome', 'show_welcome', 'flag', null, false],
  ['slowMode', 'slow_mode_interval', 'range', [0, 3600], 0], ['voiceUserLimit', 'voice_user_limit', 'range', [0, 99], 0],
  ['afkMinutes', 'afk_timeout_minutes', 'range', [0, 1440], 0], ['codeRotationInterval', 'code_rotation_interval', 'range', [1, 10000], 60],
  ['notifications', 'notification_type', 'enum', ['default', 'announcement'], 'default'], ['voiceBitrate', 'voice_bitrate', 'enum', [0, 32, 64, 96, 128, 256, 512], 0],
  ['codeVisibility', 'code_visibility', 'enum', ['public', 'private'], 'public'], ['codeMode', 'code_mode', 'enum', ['static', 'dynamic'], 'static'],
  ['codeRotationType', 'code_rotation_type', 'enum', ['time', 'joins'], 'time'], ['autoDeleteMode', 'auto_delete_mode', 'enum', ['delete', 'clear'], 'delete'],
];
const TEMPLATE_FIELDS = { isPrivate: 'boolean', isForum: 'boolean', readOnly: 'boolean', announcement: 'boolean', mediaEnabled: 'boolean', voiceEnabled: 'boolean', addAllMembers: 'boolean', temporary: 'boolean', slowMode: 'number', duration: 'number', topic: 'string' };
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const label = (v, max) => typeof v === 'string' && v.trim().length >= 1 && v.trim().length <= max && LABEL_RE.test(v.trim());
const jsonOf = (fn) => (v) => { try { const o = JSON.parse(v); return fn(o) ? JSON.stringify(o) : null; } catch { return null; } };
const adminOnlyKeys = (o) => Object.keys(o).filter((k) => ADMIN_ONLY_PERMS.includes(k));
// A threshold hands its permission to everyone at or above a level, so a
// template never carries one for a permission only the admin may hand out.
const thresholdsOf = (v) => {
  const s = jsonOf((o) => isObj(o) && Object.entries(o).every(([k, n]) => VALID_ROLE_PERMS.includes(k) && Number.isInteger(n) && n >= 1 && n <= 100))(v);
  return s && JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(s)).filter(([k]) => !ADMIN_ONLY_PERMS.includes(k))));
};
const B = { t: 'bool' }, N = (lo, hi) => ({ t: 'int', lo, hi }), E = (...v) => ({ t: 'enum', v }), T = (max) => ({ t: 'text', max }), F = (fn) => ({ t: 'fn', fn });
const SETTINGS = {
  server_name: T(32), server_title: T(40), welcome_message: T(500), custom_tos: T(50000), default_locale: E('', 'en', 'fr', 'de', 'es', 'pl', 'ru', 'uk', 'zh', 'pt', 'fa', 'ja', 'ko'),
  member_visibility: E('all', 'online', 'none'), allow_self_purge: B, hide_disabled_channel_badges: B, guests_enabled: B, guests_allow_voice: B,
  media_group_layout: E(...MEDIA_GROUP_LAYOUTS),
  max_upload_mb: N(1, 102400), max_attachments: N(1, 50), max_poll_options: N(2, 25), max_message_chars: N(200, 100000), max_tags_per_attachment: N(1, 20),
  max_tag_len: N(1, 50), max_sound_kb: N(256, 10240), max_avatar_mb: N(1, 10), max_emoji_kb: N(64, 1024), max_sticker_kb: N(256, 10240),
  role_icon_sidebar: B, role_icon_chat: B, role_icon_after_name: B, channel_sort_mode: E(...SORT_MODES), channel_cat_sort: E('az', 'za', 'manual'),
  channel_cat_order: F(jsonOf((o) => Array.isArray(o) && o.length <= LIMITS.categories && o.every((c) => label(c, 40)))),
  channel_tag_sorts: F(jsonOf((o) => isObj(o) && Object.keys(o).length <= LIMITS.categories && Object.entries(o).every(([k, v]) => label(k, 40) && SORT_MODES.includes(v)))),
  permission_thresholds: F(thresholdsOf),
  channel_templates: F(jsonOf((o) => Array.isArray(o) && o.length <= 20 && o.every((x) => isObj(x) && label(x.name, 30) && isObj(x.fields) && Object.entries(x.fields).every(([k, v]) => typeof v === TEMPLATE_FIELDS[k] && (typeof v !== 'string' || (v.length <= 256 && LABEL_RE.test(v || ' '))) && (typeof v !== 'number' || (Number.isInteger(v) && v >= 0 && v <= 3600)))))),
  automod_enabled: B, automod_link_mode: E('off', 'allowlist', 'blocklist'), automod_link_exempt_level: N(0, 100), automod_link_min_account_hours: N(0, 8760), automod_new_account_post_minutes: N(0, 10080),
  automod_scan_edits: B, automod_scan_profile: B, automod_scan_dms: B, automod_block_ip_urls: B, automod_block_punycode: B, automod_block_obfuscated: B,
  automod_preview_allowlist_only: B, automod_ban_ip: B, automod_escalation: F((v) => (validEscalation(v) ? v : null)), automod_words: F(normalizeWordGroups),
  default_theme: F((v) => (BUILTIN_THEMES.includes(v) || (v.startsWith('file:') && isThemeFilename(v.slice(5))) ? v : null)),
  published_themes: F(jsonOf((o) => Array.isArray(o) && o.length <= 500 && o.every(isThemeFilename) && new Set(o).size === o.length)),
  // Defaults for new members (#5739): the look-and-feel snapshot, without the
  // source server's version.
  member_defaults: F(memberDefaults.templateValue),
};
function checkSetting(key, raw) {
  const s = SETTINGS[key];
  if (!s || typeof raw !== 'string') return null;
  const v = raw.trim();
  return s.t === 'bool' ? (['true', 'false'].includes(v) ? v : null)
    : s.t === 'int' ? (/^\d{1,9}$/.test(v) && +v >= s.lo && +v <= s.hi ? String(+v) : null)
      : s.t === 'enum' ? (s.v.includes(v) ? v : null)
        : s.t === 'text' ? (v.length <= s.max ? sanitizeText(v) : null)
          : s.fn(v);
}
function refMaker() {
  const used = new Set();
  return (name) => {
    const base = String(name).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'item';
    let ref = base;
    for (let n = 2; used.has(ref); n++) ref = `${base}-${n}`;
    used.add(ref);
    return ref;
  };
}
async function exportTemplate(db, opts = {}) {
  const { uploadsDir = null, themesDir = null, posts = 'pinned', postAuthors = null, excludeChannels = [], assets: withAssets = true, meta = {}, havenVersion = null } = opts;
  const warnings = [], assets = {};
  // The file has to pass this server's own import, so names and values saved
  // under older rules are tidied here instead of making it unusable.
  const fit = (s, max) => { let out = ''; for (const ch of String(s ?? '').trim()) { if (out.length + ch.length > max) break; out += ch; } return out.trim(); };
  const tidy = (v, max, fallback = '') => fit(String(v ?? '').replace(/[<>\u0000-\u001f\u007f]/g, ''), max) || fallback;
  const uniqueIn = (used, name, max) => {
    let out = name;
    for (let n = 2; used.has(out.toLowerCase()); n++) out = `${fit(name, max - String(n).length - 1)}-${n}`;
    used.add(out.toLowerCase());
    return out;
  };
  const cap = (list, max, what) => {
    if (list.length > max) warnings.push(`Left out ${list.length - max} ${what}: a template holds at most ${max}`);
    return list.slice(0, max);
  };
  let assetBytes = 0;
  const room = (size, what) => {
    if (assetBytes + size <= LIMITS.assets && Object.keys(assets).length < LIMITS.assetCount) return (assetBytes += size), true;
    return warnings.push(`Left out ${what}: a template holds at most ${LIMITS.assetCount} files and 8 MB of them`), false;
  };
  const put = (base, ext, entry, size) => {
    let name = `${base}${ext}`;
    for (let n = 2; assets[name] && assets[name].sha256 !== entry.sha256; n++) name = `${base}-${n}${ext}`;
    if (!assets[name] && !room(size, name)) return null;
    assets[name] = entry;
    return name;
  };
  const media = mediaFor(uploadsDir);
  const addAsset = async (url, kind = 'upload') => {
    if (!url) return null;
    if (!withAssets) return warnings.push(`Left out ${url}: assets are off`), null;
    const m = /^\/uploads\/(stickers\/)?([A-Za-z0-9][A-Za-z0-9_.-]{0,120})$/.exec(String(url).trim());
    if (!m) return warnings.push(`Left out ${url}: only files at the top of the uploads folder can go in a template`), null;
    let buf;
    try {
      const head = await media.head(`${m[1] || ''}${m[2]}`);
      // Not read at all when it could never fit (a video, say); the 2 MB check
      // below runs after metadata is stripped, as it always has.
      if (head && head.size > LIMITS.bytes) return warnings.push(`Left out ${url}: not a PNG, JPEG, GIF or WebP image under 2 MB`), null;
      buf = head && await media.readBuffer(`${m[1] || ''}${m[2]}`);
    } catch { buf = null; }
    if (!buf) return warnings.push(`Left out ${url}: file not found`), null;
    buf = stripImageBuffer(buf);
    const type = sniffImageType(buf);
    if (!type || buf.length > LIMITS.asset) return warnings.push(`Left out ${url}: not a PNG, JPEG, GIF or WebP image under 2 MB`), null;
    const base = path.basename(m[2], path.extname(m[2])).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^[-_]+/, '').slice(0, 48) || 'asset';
    return put(base, IMAGE_EXT[type], { kind, type, sha256: sha256(buf), data: buf.toString('base64') }, buf.length);
  };
  const rows = new Map(db.prepare('SELECT key, value FROM server_settings').all().map((r) => [r.key, r.value]));
  const settings = {};
  for (const key of Object.keys(SETTINGS)) {
    if (!rows.has(key) || key === 'permission_thresholds') continue;
    const v = checkSetting(key, rows.get(key));
    v === null ? warnings.push(`Left out setting ${key}: its stored value is not valid`) : (settings[key] = v);
  }
  const skip = new Set(excludeChannels.map((n) => String(n).toLowerCase()));
  const all = db.prepare('SELECT * FROM channels ORDER BY position, id').all().filter((r) => !r.is_dm && !r.is_group && !r.is_temp_voice && !(r.expires_at && r.auto_delete_mode !== 'clear'));
  const top = new Set(all.filter((r) => !r.parent_channel_id && !skip.has(r.name.toLowerCase())).map((r) => r.id));
  const listed = all.filter((r) => (r.parent_channel_id ? top.has(r.parent_channel_id) && !skip.has(r.name.toLowerCase()) : top.has(r.id)));
  const kept = new Set(cap(listed, LIMITS.channels, 'channels').map((r) => r.id));
  const chRows = listed.filter((r) => kept.has(r.id) && (!r.parent_channel_id || kept.has(r.parent_channel_id)));
  const chMake = refMaker(), chRef = new Map(chRows.map((r) => [r.id, chMake(r.name)])), byCode = new Map(chRows.map((r) => [r.code, r]));
  const chName = new Map(), siblings = new Map();
  for (const r of chRows) {
    const at = r.parent_channel_id || 0;
    if (!siblings.has(at)) siblings.set(at, new Set());
    chName.set(r.id, uniqueIn(siblings.get(at), fit([...String(r.name)].filter((ch) => CHANNEL_NAME_RE.test(ch)).join(''), 50) || 'channel', 50));
  }
  // The Admin role is the one whoever holds admin wears; another server has
  // its own, so it never travels in a template.
  const adminRoleId = getAdminRoleId(db);
  const roleRows = cap(db.prepare('SELECT * FROM roles ORDER BY level DESC, id').all().filter((r) => r.id !== adminRoleId), LIMITS.roles, 'roles');
  const roleNames = new Set();
  const roleMake = refMaker(), roleRef = new Map(roleRows.map((r) => [r.id, roleMake(r.name)]));
  const perms = db.prepare('SELECT role_id, permission, allowed FROM role_permissions ORDER BY permission').all();
  const roles = await mapInOrder(roleRows, async (r) => {
    const allowed = perms.filter((p) => p.role_id === r.id && p.allowed && VALID_ROLE_PERMS.includes(p.permission)).map((p) => p.permission);
    const adminOnly = allowed.filter((p) => ADMIN_ONLY_PERMS.includes(p));
    if (adminOnly.length) warnings.push(`Left out ${adminOnly.join(', ')} from role ${r.name}: templates never hand out admin-only permissions`);
    return {
      ref: roleRef.get(r.id), name: uniqueIn(roleNames, tidy(r.name, 30, 'Role'), 30), level: Math.min(99, Math.max(0, Math.round(Number(r.level) || 0))),
      scope: r.scope === 'channel' ? 'channel' : 'server', color: typeof r.color === 'string' && /^#[0-9a-fA-F]{3,6}$/.test(r.color) ? r.color : null,
      autoAssign: !!r.auto_assign, linkChannelAccess: !!r.link_channel_access, icon: r.icon ? await addAsset(r.icon) : null,
      maxUploadMb: Number.isInteger(r.max_upload_mb) && r.max_upload_mb >= 1 && r.max_upload_mb <= 102400 ? r.max_upload_mb : null,
      permissions: allowed.filter((p) => !ADMIN_ONLY_PERMS.includes(p)),
      denied: perms.filter((p) => p.role_id === r.id && !p.allowed && VALID_ROLE_PERMS.includes(p.permission)).map((p) => p.permission),
    };
  });
  const parse = (v) => { try { return JSON.parse(v); } catch { return null; } };
  const channels = chRows.map((r) => {
    const o = { ref: chRef.get(r.id), name: chName.get(r.id) };
    if (tidy(r.category, 30)) o.category = tidy(r.category, 30);
    if (r.parent_channel_id) o.parent = chRef.get(r.parent_channel_id);
    if (fit(r.topic, 256)) o.topic = fit(r.topic, 256);
    for (const [k, col, kind, arg, dflt] of CHANNEL_FIELDS) {
      const raw = r[col] ?? dflt;
      const v = kind === 'flag' ? !!raw : kind === 'range' ? Math.min(arg[1], Math.max(arg[0], Number(raw) || 0)) : arg.includes(raw) ? raw : dflt;
      if (v !== dflt) o[k] = v;
    }
    const gate = parse(r.role_gate);
    const gateRoles = gate && Array.isArray(gate.roles) ? gate.roles.map((id) => roleRef.get(Number(id))).filter(Boolean) : [];
    if (gateRoles.length) o.roleGate = { mode: gate.mode === 'all' ? 'all' : 'any', roles: gateRoles.slice(0, 50) };
    if (r.default_role_id && roleRef.has(r.default_role_id)) o.defaultRole = roleRef.get(r.default_role_id);
    const afk = r.afk_sub_code && byCode.get(r.afk_sub_code);
    if (afk && afk.parent_channel_id === r.id) o.afkChannel = chRef.get(afk.id);
    // "Disconnect from voice" instead of moving idle people (#5801).
    if (r.afk_sub_code === '__leave__') o.afkDisconnect = true;
    const tags = parse(r.forum_tags);
    const tagEmoji = (e) => typeof e === 'string' && e.length <= 16 && LABEL_RE.test(e);
    if (Array.isArray(tags) && tags.length) o.forumTags = tags.filter((t) => t && label(t.name, 30)).slice(0, 40).map((t) => (tagEmoji(t.emoji) ? { name: t.name.trim(), emoji: t.emoji } : { name: t.name.trim() }));
    const layout = parse(r.forum_layout);
    if (isObj(layout)) {
      const tile = typeof layout.tile === 'number' && layout.tile >= 7 && layout.tile <= 28 ? layout.tile : 11;
      o.forumLayout = { view: FORUM_VIEWS.includes(layout.view) ? layout.view : 'list', tile, shape: FORUM_SHAPES.includes(layout.shape) ? layout.shape : 'square', locked: !!layout.locked };
    }
    if (r.auto_delete_mode === 'clear' && r.auto_delete_interval_hours) o.autoDeleteHours = Math.min(720, Math.max(1, Math.round(Number(r.auto_delete_interval_hours) || 1)));
    return o;
  });
  const roleChannelAccess = cap(db.prepare('SELECT * FROM role_channel_access').all().filter((a) => roleRef.has(a.role_id) && chRef.has(a.channel_id))
    .map((a) => ({ role: roleRef.get(a.role_id), channel: chRef.get(a.channel_id), grantOnPromote: !!a.grant_on_promote, revokeOnDemote: !!a.revoke_on_demote })), LIMITS.access, 'role channel access rows');
  // A menu's text is not exported: an import always posts the standard text
  // the menu's roles make.
  const menuEmoji = (e) => typeof e === 'string' && e.length <= 8 && ROLE_MENU_EMOJI_RE.test(e);
  const menuRoles = (list) => {
    const seen = new Set();
    return (Array.isArray(list) ? list : []).filter((x) => x && roleRef.has(x.roleId) && menuEmoji(x.emoji) && !seen.has(`r:${x.roleId}`) && !seen.has(`e:${x.emoji}`) && seen.add(`r:${x.roleId}`).add(`e:${x.emoji}`))
      .slice(0, 20).map((x) => ({ role: roleRef.get(x.roleId), emoji: x.emoji }));
  };
  const roleMenus = cap(db.prepare('SELECT rm.channel_id, rm.title, rm.data FROM role_menus rm JOIN messages m ON m.id = rm.message_id ORDER BY rm.message_id').all()
    .filter((m) => chRef.has(m.channel_id)).map((m) => ({ channel: chRef.get(m.channel_id), title: fit(m.title, 120), roles: menuRoles((parse(m.data) || {}).roles) }))
    .filter((m) => m.roles.length), LIMITS.menus, 'role menus');
  const hookEvents = (v) => {
    const list = String(v || '*').split(',').map((e) => e.trim()).filter((e) => WEBHOOK_EVENTS.includes(e));
    return String(v || '*').trim() === '*' || !list.length ? '*' : [...new Set(list)].join(',');
  };
  const webhooks = await mapInOrder(cap(db.prepare('SELECT channel_id, name, avatar_url, subscribed_events, can_moderate, can_use_voice FROM webhooks ORDER BY id').all().filter((w) => chRef.has(w.channel_id)), LIMITS.webhooks, 'webhooks'),
    async (w) => ({ channel: chRef.get(w.channel_id), name: tidy(w.name, 32, 'Webhook'), avatar: w.avatar_url ? await addAsset(w.avatar_url) : null, events: hookEvents(w.subscribed_events), canModerate: !!w.can_moderate, canUseVoice: !!w.can_use_voice }));
  const authors = Array.isArray(postAuthors) && postAuthors.length ? new Set(postAuthors) : null;
  const postRows = posts === 'none' ? [] : db.prepare('SELECT m.channel_id, m.content, m.webhook_username, m.webhook_avatar FROM pinned_messages p JOIN messages m ON m.id = p.message_id WHERE m.is_webhook = 1 AND m.thread_id IS NULL ORDER BY m.id').all()
    .filter((m) => chRef.has(m.channel_id) && (!authors || authors.has(m.webhook_username)));
  const postText = async (m) => {
    // Text that only looks like an asset reference is dropped, so the import
    // does not go looking for a file that is not there.
    const text = sanitizeText(m.content || '').trim().replace(ASSET_TOKEN_RE, '');
    const found = new Map();
    for (const [, file] of text.matchAll(UPLOAD_REF_RE)) found.set(file, await addAsset(`/uploads/${file}`));
    return text.replace(UPLOAD_REF_RE, (whole, file) => { const a = found.get(file); return a ? `{{asset:${a}}}` : whole; }).trim();
  };
  const postList = (await mapInOrder(cap(postRows, LIMITS.posts, 'posts'),
    async (m) => ({ channel: chRef.get(m.channel_id), author: tidy(m.webhook_username, 32, 'Server'), avatar: m.webhook_avatar ? await addAsset(m.webhook_avatar) : null, pinned: true, content: await postText(m) })))
    .filter((p) => (p.content && p.content.length <= LIMITS.post) || (warnings.push(`Left out a post in #${chRows.find((c) => chRef.get(c.id) === p.channel).name}: ${p.content ? `longer than ${LIMITS.post} characters` : 'nothing left once cleaned up'}`), false));
  const automodDomains = cap(db.prepare('SELECT domain, mode, include_subdomains, note FROM automod_domains ORDER BY domain').all(), LIMITS.domains, 'link rules')
    .map((d) => ({ domain: typeof d.domain === 'string' && d.domain.length <= 253 ? normalizeHost(d.domain.trim()) : '', mode: d.mode === 'deny' ? 'deny' : 'allow', includeSubdomains: d.include_subdomains !== 0, note: fit(d.note, 200) }))
    .filter((d) => (d.domain.includes('.') && /^[a-z0-9.-]+$/.test(d.domain)) || (warnings.push(`Left out the link rule for ${d.domain || 'an empty domain'}: it is not a plain domain name`), false));
  const libraryName = (v, max) => String(v || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '').slice(0, max);
  const emojis = (await mapInOrder(cap(db.prepare('SELECT name, filename FROM custom_emojis ORDER BY name').all().filter((e) => libraryName(e.name, 30)), LIMITS.emojis, 'custom emojis'),
    async (e) => ({ name: libraryName(e.name, 30), asset: await addAsset(`/uploads/${e.filename}`) }))).filter((e) => e.asset);
  const stickers = (await mapInOrder(cap(db.prepare("SELECT name, pack_name, filename FROM stickers WHERE NOT (uploaded_by IS NULL AND filename LIKE 'starter-%') ORDER BY pack_name, name").all().filter((s) => libraryName(s.name, 40)), LIMITS.stickers, 'stickers'),
    async (s) => ({ name: libraryName(s.name, 40), pack: tidy(s.pack_name, 40, 'General'), asset: await addAsset(`/uploads/stickers/${s.filename}`, 'sticker') }))).filter((s) => s.asset);
  const ids = (list) => (Array.isArray(list) ? list.map((id) => chRef.get(Number(id))).filter(Boolean) : null);
  const creator = rows.get('channel_creator_role');
  const server = {
    settings, icon: rows.get('server_icon') ? await addAsset(rows.get('server_icon')) : null, banner: rows.get('server_banner') ? await addAsset(rows.get('server_banner')) : null,
    defaultJoinChannels: rows.get('default_join_channels') ? ids(parse(rows.get('default_join_channels'))) : null,
    guestChannels: rows.has('guest_channels') ? ids(String(rows.get('guest_channels')).split(',').filter(Boolean)) : null,
    automodLogChannel: rows.get('automod_log_channel') && byCode.has(rows.get('automod_log_channel')) ? chRef.get(byCode.get(rows.get('automod_log_channel')).id) : null,
    channelCreatorRole: /^\d+$/.test(creator || '') ? roleRef.get(Number(creator)) || null : ['default', 'none'].includes(creator) ? creator : null,
  };
  const themeNames = [...new Set([...(settings.default_theme || '').startsWith('file:') ? [settings.default_theme.slice(5)] : [], ...(settings.published_themes ? JSON.parse(settings.published_themes) : [])])];
  for (const file of themeNames) {
    if (!withAssets || !themesDir) break;
    let buf;
    try { buf = fs.readFileSync(path.join(themesDir, file)); } catch { warnings.push(`Left out theme ${file}: not installed`); continue; }
    if (buf.length > LIMITS.theme || buf.includes(0) || !parseThemeMetadata(buf.toString('utf8')).compatible) { warnings.push(`Left out theme ${file}: too large or not compatible`); continue; }
    if (!room(buf.length, `theme ${file}`)) continue;
    assets[file] = { kind: 'theme', type: 'text/css', sha256: sha256(buf), data: buf.toString('base64') };
  }
  const template = {
    format: FORMAT, version: VERSION, exportedAt: new Date().toISOString(), havenVersion,
    meta: { name: fit(meta.name || settings.server_name || 'Haven server', 60), description: fit(meta.description, 500), author: fit(meta.author, 60) },
    server, roles, channels, roleChannelAccess, roleMenus, webhooks, posts: postList, automodDomains, emojis, stickers, assets,
  };
  return { template, warnings };
}
function checker() {
  const errors = [];
  const fail = (at, msg) => { if (errors.length < 100) errors.push(`${at}: ${msg}`); return null; };
  const list = (v, max, at) => (v === undefined || v === null ? [] : Array.isArray(v) && v.length <= max ? v : (fail(at, `expected a list of at most ${max}`), []));
  const text = (v, max, at, dflt = '') => (v === undefined || v === null ? dflt : typeof v === 'string' && v.length <= max ? sanitizeText(v).trim() : (fail(at, `expected text up to ${max} characters`), dflt));
  const name = (v, max, at) => (label(v, max) ? v.trim() : fail(at, `expected a name of 1-${max} characters without < or >`));
  const flag = (v, at, dflt) => (v === undefined || v === null ? dflt : typeof v === 'boolean' ? v : (fail(at, 'expected true or false'), dflt));
  const int = (v, lo, hi, at, dflt) => (v === undefined || v === null ? dflt : Number.isInteger(v) && v >= lo && v <= hi ? v : (fail(at, `expected a whole number from ${lo} to ${hi}`), dflt));
  const pick = (v, opts, at, dflt) => (v === undefined || v === null ? dflt : opts.includes(v) ? v : (fail(at, `expected one of ${opts.join(', ')}`), dflt));
  const ref = (v, at) => (typeof v === 'string' && REF_RE.test(v) ? v : fail(at, 'expected a reference id (a-z, 0-9, _ and -)'));
  const opt = (v, fn) => (v === undefined || v === null ? null : fn(v));
  return { errors, fail, list, text, name, flag, int, pick, ref, opt };
}
function validateTemplate(input) {
  const c = checker(), warnings = [];
  if (!isObj(input)) return { errors: ['This is not a Haven server template'] };
  if (input.format !== FORMAT) return { errors: ['This is not a Haven server template'] };
  if (!Number.isInteger(input.version) || input.version < 1) return { errors: ['The template has no valid version'] };
  if (input.version > VERSION) return { errors: [`This template was made by a newer Haven (template version ${input.version}); update Haven to import it`] };
  const assets = {};
  let total = 0;
  const rawAssets = isObj(input.assets) ? input.assets : (input.assets === undefined ? {} : (c.fail('assets', 'expected an object'), {}));
  if (Object.keys(rawAssets).length > LIMITS.assetCount) c.fail('assets', `at most ${LIMITS.assetCount} files`);
  for (const [key, a] of Object.entries(rawAssets).slice(0, LIMITS.assetCount)) {
    const at = `assets.${key.slice(0, 80)}`;
    if (!isObj(a) || typeof a.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(a.data) || a.data.length > Math.ceil(LIMITS.asset / 3) * 4 + 4) { c.fail(at, 'expected base64 data under 2 MB'); continue; }
    const kind = c.pick(a.kind, ['upload', 'sticker', 'theme'], `${at}.kind`, 'upload');
    const buf = Buffer.from(a.data, 'base64');
    total += buf.length;
    if (a.sha256 !== undefined && a.sha256 !== sha256(buf)) { c.fail(at, 'the file does not match its checksum'); continue; }
    if (kind === 'theme') {
      const css = buf.toString('utf8');
      if (!isThemeFilename(key) || buf.length > LIMITS.theme || css.includes('\u0000') || !parseThemeMetadata(css).compatible) { c.fail(at, 'expected a compatible *.theme.css file under 512 KB'); continue; }
    } else {
      const type = sniffImageType(buf);
      if (!ASSET_RE.test(key) || !type || IMAGE_EXT[type] !== (path.extname(key).toLowerCase() === '.jpeg' ? '.jpg' : path.extname(key).toLowerCase())) { c.fail(at, 'expected a PNG, JPEG, GIF or WebP image with a plain file name that matches its type'); continue; }
    }
    assets[key] = { kind, buf: kind === 'theme' ? buf : stripImageBuffer(buf), sha256: sha256(buf) };
  }
  if (total > LIMITS.assets) c.fail('assets', 'more than 8 MB of files in total');
  const asset = (v, at, kind = 'upload') => (v === undefined || v === null ? null : typeof v === 'string' && assets[v] && assets[v].kind === kind ? v : c.fail(at, `unknown ${kind} file ${String(v).slice(0, 80)}`));
  const meta = isObj(input.meta) ? input.meta : {};
  const out = {
    meta: { name: c.text(meta.name, 60, 'meta.name'), description: c.text(meta.description, 500, 'meta.description'), author: c.text(meta.author, 60, 'meta.author') },
    assets,
  };
  out.roles = c.list(input.roles, LIMITS.roles, 'roles').map((r, i) => {
    const at = `roles[${i}]`;
    if (!isObj(r)) return c.fail(at, 'expected an object');
    const permsOf = (v, key) => [...new Set(c.list(v, 100, `${at}.${key}`).filter((p) => VALID_ROLE_PERMS.includes(p) || c.fail(`${at}.${key}`, `unknown permission ${String(p).slice(0, 40)}`)))];
    const allowed = permsOf(r.permissions, 'permissions');
    const adminOnly = allowed.filter((p) => ADMIN_ONLY_PERMS.includes(p));
    if (adminOnly.length) warnings.push(`Left out ${adminOnly.join(', ')} from role ${String(r.name).slice(0, 30)}: only the server admin can hand those out`);
    return {
      ref: c.ref(r.ref, `${at}.ref`), name: c.name(r.name, 30, `${at}.name`), level: c.int(r.level, 0, 99, `${at}.level`, 25), scope: c.pick(r.scope, ['server', 'channel'], `${at}.scope`, 'server'),
      color: c.opt(r.color, (v) => (typeof v === 'string' && /^#[0-9a-fA-F]{3,6}$/.test(v) ? v : c.fail(`${at}.color`, 'expected a colour like #3498db'))),
      autoAssign: c.flag(r.autoAssign, `${at}.autoAssign`, false), linkChannelAccess: c.flag(r.linkChannelAccess, `${at}.linkChannelAccess`, false),
      icon: asset(r.icon, `${at}.icon`), maxUploadMb: c.int(r.maxUploadMb, 1, 102400, `${at}.maxUploadMb`, null), permissions: allowed.filter((p) => !ADMIN_ONLY_PERMS.includes(p)), denied: permsOf(r.denied, 'denied'),
    };
  }).filter(Boolean);
  out.channels = c.list(input.channels, LIMITS.channels, 'channels').map((ch, i) => {
    const at = `channels[${i}]`;
    if (!isObj(ch)) return c.fail(at, 'expected an object');
    const name = typeof ch.name === 'string' ? ch.name.trim() : '';
    if (!name || name.length > 50 || !CHANNEL_NAME_RE.test(name)) c.fail(`${at}.name`, 'expected a channel name of 1-50 letters, numbers, spaces, emoji or - ! ? . , \' & +');
    const o = {
      ref: c.ref(ch.ref, `${at}.ref`), name, category: c.opt(ch.category, (v) => c.name(v, 30, `${at}.category`)), parent: c.opt(ch.parent, (v) => c.ref(v, `${at}.parent`)),
      topic: c.text(ch.topic, 256, `${at}.topic`), afkChannel: c.opt(ch.afkChannel, (v) => c.ref(v, `${at}.afkChannel`)), afkDisconnect: ch.afkDisconnect === true, defaultRole: c.opt(ch.defaultRole, (v) => c.ref(v, `${at}.defaultRole`)),
      autoDeleteHours: c.int(ch.autoDeleteHours, 1, 720, `${at}.autoDeleteHours`, null),
      roleGate: c.opt(ch.roleGate, (g) => (isObj(g) ? { mode: c.pick(g.mode, ['any', 'all'], `${at}.roleGate.mode`, 'any'), roles: c.list(g.roles, 50, `${at}.roleGate.roles`).map((x) => c.ref(x, `${at}.roleGate.roles`)) } : c.fail(`${at}.roleGate`, 'expected an object'))),
      forumTags: c.opt(ch.forumTags, (tags) => {
        const seen = new Set();
        return c.list(tags, 40, `${at}.forumTags`).map((t) => (isObj(t) && c.name(t.name, 30, `${at}.forumTags`) ? { name: t.name.trim(), ...(t.emoji ? { emoji: c.opt(t.emoji, (e) => (typeof e === 'string' && e.length <= 16 && LABEL_RE.test(e) ? e : c.fail(`${at}.forumTags`, 'bad emoji'))) } : {}) } : null))
          .filter((t) => t && !seen.has(t.name.toLowerCase()) && seen.add(t.name.toLowerCase()));
      }),
      forumLayout: c.opt(ch.forumLayout, (l) => (isObj(l) ? {
        view: c.pick(l.view, FORUM_VIEWS, `${at}.forumLayout.view`, 'list'), shape: c.pick(l.shape, FORUM_SHAPES, `${at}.forumLayout.shape`, 'square'),
        tile: l.tile === undefined ? 11 : typeof l.tile === 'number' && l.tile >= 7 && l.tile <= 28 ? Math.round(l.tile * 2) / 2 : (c.fail(`${at}.forumLayout.tile`, 'expected 7-28'), 11), locked: c.flag(l.locked, `${at}.forumLayout.locked`, false),
      } : c.fail(`${at}.forumLayout`, 'expected an object'))),
    };
    for (const [k, , kind, arg, dflt] of CHANNEL_FIELDS) o[k] = kind === 'flag' ? c.flag(ch[k], `${at}.${k}`, dflt) : kind === 'range' ? c.int(ch[k], arg[0], arg[1], `${at}.${k}`, dflt) : c.pick(ch[k], arg, `${at}.${k}`, dflt);
    return o;
  }).filter(Boolean);
  const chByRef = new Map(), roleByRef = new Map(), siblings = new Set(), roleNames = new Set();
  out.channels.forEach((ch, i) => (chByRef.has(ch.ref) ? c.fail(`channels[${i}].ref`, `${ch.ref} is used twice`) : chByRef.set(ch.ref, ch)));
  out.roles.forEach((r, i) => {
    roleByRef.has(r.ref) ? c.fail(`roles[${i}].ref`, `${r.ref} is used twice`) : roleByRef.set(r.ref, r);
    const key = String(r.name).toLowerCase();
    roleNames.has(key) ? c.fail(`roles[${i}].name`, `${r.name} is used twice`) : roleNames.add(key);
  });
  const chRef = (v, at) => (v && chByRef.has(v) ? v : c.fail(at, `unknown channel ${String(v).slice(0, 48)}`));
  const roleRef = (v, at) => (v && roleByRef.has(v) ? v : c.fail(at, `unknown role ${String(v).slice(0, 48)}`));
  out.channels.forEach((ch, i) => {
    const at = `channels[${i}]`;
    if (ch.parent && (!chByRef.has(ch.parent) || chByRef.get(ch.parent).parent || ch.parent === ch.ref)) c.fail(`${at}.parent`, 'must be a top-level channel in this template');
    const key = `${ch.parent || ''}/${ch.name.toLowerCase()}`;
    siblings.has(key) ? c.fail(`${at}.name`, `${ch.name} is used twice at the same level`) : siblings.add(key);
    if (ch.afkChannel && (!chByRef.has(ch.afkChannel) || chByRef.get(ch.afkChannel).parent !== ch.ref)) c.fail(`${at}.afkChannel`, 'must be a sub-channel of this channel');
    if (ch.roleGate) ch.roleGate.roles.forEach((r) => roleRef(r, `${at}.roleGate.roles`));
    if (ch.defaultRole) roleRef(ch.defaultRole, `${at}.defaultRole`);
  });
  out.roleChannelAccess = c.list(input.roleChannelAccess, LIMITS.access, 'roleChannelAccess').map((a, i) => (isObj(a) ? {
    role: roleRef(a.role, `roleChannelAccess[${i}].role`), channel: chRef(a.channel, `roleChannelAccess[${i}].channel`),
    grantOnPromote: c.flag(a.grantOnPromote, `roleChannelAccess[${i}]`, false), revokeOnDemote: c.flag(a.revokeOnDemote, `roleChannelAccess[${i}]`, false),
  } : c.fail(`roleChannelAccess[${i}]`, 'expected an object'))).filter(Boolean);
  out.roleMenus = c.list(input.roleMenus, LIMITS.menus, 'roleMenus').map((m, i) => {
    const at = `roleMenus[${i}]`;
    if (!isObj(m)) return c.fail(at, 'expected an object');
    // The same rules as posting a menu by hand. Any text in the file is
    // ignored: the menu is posted with the standard text its roles make.
    const seen = new Set();
    const roles = c.list(m.roles, 20, `${at}.roles`).map((x) => {
      if (!isObj(x) || typeof x.emoji !== 'string' || x.emoji.length > 8 || !ROLE_MENU_EMOJI_RE.test(x.emoji)) return c.fail(`${at}.roles`, 'each entry needs a role and an emoji');
      if (seen.has(`r:${x.role}`) || seen.has(`e:${x.emoji}`)) return c.fail(`${at}.roles`, 'a role or an emoji is on the menu twice');
      seen.add(`r:${x.role}`).add(`e:${x.emoji}`);
      return { role: roleRef(x.role, `${at}.roles`), emoji: x.emoji };
    });
    if (!roles.length) c.fail(at, 'needs at least one role');
    return { channel: chRef(m.channel, `${at}.channel`), title: c.text(m.title, 120, `${at}.title`), roles };
  }).filter(Boolean);
  out.webhooks = c.list(input.webhooks, LIMITS.webhooks, 'webhooks').map((w, i) => {
    const at = `webhooks[${i}]`;
    if (!isObj(w)) return c.fail(at, 'expected an object');
    const events = w.events === undefined || w.events === '*' ? '*' : typeof w.events === 'string' && w.events.split(',').every((e) => WEBHOOK_EVENTS.includes(e.trim())) ? w.events.split(',').map((e) => e.trim()).join(',') : (c.fail(`${at}.events`, `expected * or ${WEBHOOK_EVENTS.join(', ')}`), '*');
    return { channel: chRef(w.channel, `${at}.channel`), name: c.name(w.name, 32, `${at}.name`), avatar: asset(w.avatar, `${at}.avatar`), events, canModerate: c.flag(w.canModerate, `${at}.canModerate`, false), canUseVoice: c.flag(w.canUseVoice, `${at}.canUseVoice`, false) };
  }).filter(Boolean);
  out.posts = c.list(input.posts, LIMITS.posts, 'posts').map((p, i) => {
    const at = `posts[${i}]`;
    if (!isObj(p)) return c.fail(at, 'expected an object');
    const content = c.text(p.content, LIMITS.post, `${at}.content`);
    if (!content) c.fail(`${at}.content`, 'is empty');
    for (const [, file] of content.matchAll(ASSET_TOKEN_RE)) asset(file, `${at}.content`);
    return { channel: chRef(p.channel, `${at}.channel`), author: c.name(p.author, 32, `${at}.author`), avatar: asset(p.avatar, `${at}.avatar`), pinned: c.flag(p.pinned, `${at}.pinned`, false), content };
  }).filter(Boolean);
  out.automodDomains = c.list(input.automodDomains, LIMITS.domains, 'automodDomains').map((d, i) => {
    const at = `automodDomains[${i}]`;
    const host = isObj(d) && typeof d.domain === 'string' && d.domain.length <= 253 ? normalizeHost(d.domain.trim()) : '';
    if (!host || !host.includes('.') || !/^[a-z0-9.-]+$/.test(host)) return c.fail(`${at}.domain`, 'expected a domain like example.com');
    return { domain: host, mode: c.pick(d.mode, ['allow', 'deny'], `${at}.mode`, 'allow'), includeSubdomains: c.flag(d.includeSubdomains, `${at}.includeSubdomains`, true), note: c.text(d.note, 200, `${at}.note`) };
  }).filter(Boolean);
  out.emojis = c.list(input.emojis, LIMITS.emojis, 'emojis').map((e, i) => (isObj(e) && typeof e.name === 'string' && /^[a-z0-9_-]{1,30}$/.test(e.name) ? { name: e.name, asset: asset(e.asset, `emojis[${i}].asset`) } : c.fail(`emojis[${i}]`, 'expected a name of a-z, 0-9, _ and - and a file'))).filter(Boolean);
  out.stickers = c.list(input.stickers, LIMITS.stickers, 'stickers').map((s, i) => (isObj(s) && typeof s.name === 'string' && /^[a-z0-9_-]{1,40}$/.test(s.name) ? { name: s.name, pack: s.pack === undefined ? 'General' : c.name(s.pack, 40, `stickers[${i}].pack`), asset: asset(s.asset, `stickers[${i}].asset`, 'sticker') } : c.fail(`stickers[${i}]`, 'expected a name of a-z, 0-9, _ and - and a file'))).filter(Boolean);
  const srv = isObj(input.server) ? input.server : {};
  const settings = {};
  for (const [key, value] of Object.entries(isObj(srv.settings) ? srv.settings : {})) {
    if (!SETTINGS[key]) { warnings.push(`Ignored setting ${key.slice(0, 60)}: templates cannot change it`); continue; }
    const v = checkSetting(key, value);
    v === null ? c.fail(`server.settings.${key}`, 'is not a valid value') : (settings[key] = v);
    const dropped = key === 'permission_thresholds' && v !== null ? adminOnlyKeys(JSON.parse(value)) : [];
    if (dropped.length) warnings.push(`Left out the level thresholds for ${dropped.join(', ')}: only the server admin can hand those out`);
  }
  const refs = (v, at) => c.opt(v, (x) => c.list(x, LIMITS.channels, at).map((r) => chRef(r, at)).filter(Boolean));
  out.server = {
    settings, icon: asset(srv.icon, 'server.icon'), banner: asset(srv.banner, 'server.banner'), defaultJoinChannels: refs(srv.defaultJoinChannels, 'server.defaultJoinChannels'), guestChannels: refs(srv.guestChannels, 'server.guestChannels'),
    automodLogChannel: c.opt(srv.automodLogChannel, (v) => chRef(v, 'server.automodLogChannel')),
    channelCreatorRole: c.opt(srv.channelCreatorRole, (v) => (['default', 'none'].includes(v) ? v : roleRef(v, 'server.channelCreatorRole'))),
  };
  return c.errors.length ? { errors: c.errors, warnings } : { template: out, warnings };
}
function summarizeTemplate(tpl) {
  return {
    name: tpl.meta.name, description: tpl.meta.description, author: tpl.meta.author, roles: tpl.roles.length, channels: tpl.channels.length,
    categories: [...new Set(tpl.channels.map((ch) => ch.category).filter(Boolean))].length, posts: tpl.posts.length, roleMenus: tpl.roleMenus.length,
    webhooks: tpl.webhooks.length, automodDomains: tpl.automodDomains.length, emojis: tpl.emojis.length, stickers: tpl.stickers.length,
    settings: Object.keys(tpl.server.settings).length, assets: Object.keys(tpl.assets).length,
  };
}
// Templates made before level thresholds were retired may carry them: each
// server role of the template at or above a threshold gets that permission
// ticked, unless the template denies it there. Admin-only permissions were
// already left out when the template was checked.
function thresholdsToTicks(tpl) {
  let thresholds = {};
  try { thresholds = JSON.parse(tpl.server.settings.permission_thresholds || '{}') || {}; } catch { thresholds = {}; }
  for (const [perm, min] of Object.entries(isObj(thresholds) ? thresholds : {})) {
    if (!Number.isInteger(min)) continue;
    for (const role of tpl.roles) {
      if (role.scope !== 'server' || role.level <= 0 || role.level < min) continue;
      if (role.denied.includes(perm) || role.permissions.includes(perm)) continue;
      role.permissions.push(perm);
    }
  }
}

async function applyTemplate(db, tpl, opts = {}) {
  thresholdsToTicks(tpl);
  const { mode = 'merge', actorId = null, uploadsDir = null, themesDir = null, dryRun = false, posts: withPosts = true, webhooks: withWebhooks = true, joinMembers = true, installThemes = false, hasRoom = diskGuard.hasHeadroom } = opts;
  const replace = mode === 'replace';
  const r = {
    mode: replace ? 'replace' : 'merge', dryRun,
    created: { roles: [], channels: [], webhooks: [], emojis: [], stickers: [], files: [], themes: [] }, updated: { roles: [], channels: [], settings: [] },
    existing: { roles: [], channels: [], settings: [] }, extra: { roles: [], channels: [] }, counts: { posts: 0, roleMenus: 0, domains: 0, access: 0 }, warnings: [], changedSettings: {}, rolePermissions: {},
  };
  const warn = (msg) => { if (!r.warnings.includes(msg)) r.warnings.push(msg); };
  // Emojis and stickers keep to this server's own size limits, as an upload
  // would, and only images something in the template uses are copied.
  const kb = (key, dflt) => parseInt(db.prepare('SELECT value FROM server_settings WHERE key = ?').get(key)?.value, 10) || dflt;
  const fits = (list, key, dflt, what) => list.filter((x) => tpl.assets[x.asset].buf.length <= kb(key, dflt) * 1024
    || (warn(`The ${what} ${x.name} was left out: it is larger than this server's ${kb(key, dflt)} KB limit`), false));
  const emojis = fits(tpl.emojis, 'max_emoji_kb', 256, 'emoji'), stickers = fits(tpl.stickers, 'max_sticker_kb', 1024, 'sticker');
  const used = new Set([
    tpl.server.icon, tpl.server.banner, ...tpl.roles.map((x) => x.icon), ...tpl.webhooks.map((x) => x.avatar), ...tpl.posts.map((x) => x.avatar),
    ...tpl.posts.flatMap((x) => [...x.content.matchAll(ASSET_TOKEN_RE)].map((m) => m[1])), ...emojis.map((x) => x.asset), ...stickers.map((x) => x.asset),
  ].filter(Boolean));
  // Themes are files in themesDir; images go to storage, under a name that
  // carries their hash, so one already there is the same picture.
  const media = mediaFor(uploadsDir);
  const files = [], urls = {}, themes = new Set();
  for (const [name, a] of Object.entries(tpl.assets)) {
    if (a.kind !== 'theme' && !used.has(name)) continue;
    const file = a.kind === 'theme' ? name : `${path.basename(name, path.extname(name))}-${a.sha256.slice(0, 10)}${path.extname(name).toLowerCase()}`;
    const rel = `${a.kind === 'sticker' ? 'stickers/' : ''}${file}`;
    urls[name] = { file, url: `/uploads/${rel}` };
    if (a.kind === 'theme') {
      const dest = themesDir && path.join(themesDir, file);
      const current = dest && fs.existsSync(dest) ? fs.readFileSync(dest) : null;
      if (current && sha256(current) === a.sha256) themes.add(name);
      else if (current) warn(`Theme ${name} is already installed with different contents; it was left as it is`), themes.add(name);
      else if (installThemes && dest) files.push({ dest, buf: a.buf, name }), themes.add(name);
      else warn(`Theme ${name} is not installed on this server, so it was not made the default. Copy it into Haven's themes folder, or import with tools/template.js --install-themes`);
    } else if (!(await media.head(rel))) files.push({ rel, buf: a.buf, name: file });
  }
  const url = (name) => (name && urls[name] ? urls[name].url : null);
  // The same disk headroom uploads keep, so an import never eats the space
  // the database needs.
  if (files.length && !hasRoom(files.reduce((n, f) => n + f.buf.length, 0))) {
    if (!dryRun) throw Object.assign(new Error('The server is low on disk space, so the template was not imported. Free some space and try again.'), { code: 'TEMPLATE_DISK_FULL' });
    warn('The server is low on disk space, so importing this template would be refused');
  }
  const run = () => {
    const now = Date.now();
    const roleId = new Map(), chId = new Map(), touched = new Set();
    const existingRoles = db.prepare('SELECT id, name FROM roles').all();
    const roleByName = new Map(existingRoles.map((x) => [x.name.toLowerCase(), x.id]));
    const insPerm = db.prepare('INSERT OR REPLACE INTO role_permissions (role_id, permission, allowed) VALUES (?, ?, ?)');
    const setPerms = (id, role) => { db.prepare('DELETE FROM role_permissions WHERE role_id = ?').run(id); if (role.level > 0) { role.permissions.forEach((p) => insPerm.run(id, p, 1)); role.denied.forEach((p) => insPerm.run(id, p, 0)); } };
    let autoRole = db.prepare('SELECT id FROM roles WHERE auto_assign = 1').get()?.id || null;
    // Roles people get without an admin choosing them (every new member, a
    // role menu, everyone who joins a channel) may only carry what the stock
    // Member role has, sit below every level threshold and leave the upload
    // cap alone, so a template cannot hand power to anyone who clicks.
    const levels = (raw) => { try { const o = JSON.parse(raw || '{}'); return isObj(o) ? Object.values(o).filter(Number.isInteger) : []; } catch { return []; } };
    const lowest = Math.min(...levels(db.prepare("SELECT value FROM server_settings WHERE key = 'permission_thresholds'").get()?.value), ...levels(tpl.server.settings.permission_thresholds));
    const powerful = (level, perms, maxUploadMb) => level >= lowest || !!maxUploadMb || (level > 0 && perms.some((p) => !MEMBER_PERMS.includes(p)));
    const powerfulRole = (id) => {
      const row = db.prepare('SELECT level, max_upload_mb FROM roles WHERE id = ?').get(id);
      return !row || powerful(row.level, db.prepare('SELECT permission FROM role_permissions WHERE role_id = ? AND allowed = 1').all(id).map((x) => x.permission), row.max_upload_mb);
    };
    const handedOut = new Set([
      ...db.prepare('SELECT id FROM roles WHERE auto_assign = 1').all().map((x) => x.id),
      ...db.prepare('SELECT default_role_id AS id FROM channels WHERE default_role_id IS NOT NULL').all().map((x) => x.id),
    ]);
    for (const row of db.prepare('SELECT data FROM role_menus').all()) {
      try { (JSON.parse(row.data).roles || []).forEach((e) => handedOut.add(e.roleId)); } catch { /* a malformed menu offers no roles */ }
    }
    const adminRole = getAdminRoleId(db);
    for (const role of tpl.roles) {
      const found = roleByName.get(role.name.toLowerCase());
      if (found && found === adminRole) {
        roleId.set(role.ref, found);
        r.existing.roles.push(role.name);
        if (replace) warn(`${role.name} is this server's Admin role, so it was left as it is`);
        continue;
      }
      if (found && !replace) { roleId.set(role.ref, found); r.existing.roles.push(role.name); continue; }
      const tooMuch = powerful(role.level, role.permissions, role.maxUploadMb);
      if (found && tooMuch && handedOut.has(found)) {
        roleId.set(role.ref, found);
        r.existing.roles.push(role.name);
        warn(`${role.name} was left as it is: members get it without an admin choosing them, and the template would give it more than the Member role has`);
        continue;
      }
      const auto = role.autoAssign && !tooMuch && (replace || !autoRole || autoRole === found);
      if (role.autoAssign && tooMuch) warn(`${role.name} was not made the role new members get, because it carries more than the Member role has`);
      else if (role.autoAssign && !auto) warn(`${role.name} was not made the role new members get, because this server already has one`);
      if (auto) db.prepare('UPDATE roles SET auto_assign = 0 WHERE auto_assign = 1').run();
      const vals = [role.level, role.scope, role.color, auto ? 1 : 0, role.linkChannelAccess ? 1 : 0, url(role.icon), role.maxUploadMb];
      const id = found || db.prepare('INSERT INTO roles (name, level, scope, color, auto_assign, link_channel_access, icon, max_upload_mb) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(role.name, ...vals).lastInsertRowid;
      if (found) db.prepare('UPDATE roles SET name = ?, level = ?, scope = ?, color = ?, auto_assign = ?, link_channel_access = ?, icon = ?, max_upload_mb = ? WHERE id = ?').run(role.name, ...vals, found);
      setPerms(id, role);
      r.rolePermissions[role.name] = { id, level: role.level, permissions: role.level > 0 ? role.permissions : [], denied: role.level > 0 ? role.denied : [] };
      roleId.set(role.ref, id);
      (found ? r.updated : r.created).roles.push(role.name);
      if (auto) autoRole = id;
    }
    const tplRoles = new Set(tpl.roles.map((x) => x.name.toLowerCase()));
    r.extra.roles = existingRoles.filter((x) => !tplRoles.has(x.name.toLowerCase())).map((x) => x.name);
    const existing = db.prepare('SELECT id, name, parent_channel_id, position, show_welcome FROM channels WHERE is_dm = 0 ORDER BY position, id').all();
    const hadWelcome = existing.find((x) => x.show_welcome);
    const matched = new Set();
    const users = joinMembers ? db.prepare('SELECT id FROM users').all() : [];
    const addMember = db.prepare('INSERT OR IGNORE INTO channel_members (channel_id, user_id) VALUES (?, ?)');
    const newCode = () => generateUniqueChannelCode(db, () => crypto.randomBytes(4).toString('hex'));
    let pos = existing.reduce((m, x) => Math.max(m, x.position || 0), 0);
    const order = new Map(tpl.channels.map((ch, i) => [ch.ref, i + 1]));
    for (const ch of [...tpl.channels.filter((x) => !x.parent), ...tpl.channels.filter((x) => x.parent)]) {
      const parentId = ch.parent ? chId.get(ch.parent) : null;
      const found = existing.find((x) => !matched.has(x.id) && x.name.toLowerCase() === ch.name.toLowerCase() && (x.parent_channel_id || null) === parentId);
      if (found) matched.add(found.id);
      if (found && !replace) { chId.set(ch.ref, found.id); r.existing.channels.push(ch.name); continue; }
      const id = found ? found.id : db.prepare('INSERT INTO channels (name, code, created_by) VALUES (?, ?, ?)').run(ch.name, newCode(), actorId).lastInsertRowid;
      chId.set(ch.ref, id);
      touched.add(ch.ref);
      (found ? r.updated : r.created).channels.push(ch.name);
      if (!found && actorId) addMember.run(id, actorId);
      if (!found && !ch.private && !ch.roleGate) users.forEach((u) => addMember.run(id, u.id));
      const cols = {
        name: ch.name, category: ch.category, parent_channel_id: parentId, topic: ch.topic, position: replace ? order.get(ch.ref) : ++pos,
        role_gate: ch.roleGate && ch.roleGate.roles.length ? JSON.stringify({ mode: ch.roleGate.mode, roles: ch.roleGate.roles.map((x) => roleId.get(x)) }) : null,
        default_role_id: ch.defaultRole && !powerfulRole(roleId.get(ch.defaultRole)) ? roleId.get(ch.defaultRole) : null, forum_tags: ch.forumTags && ch.forumTags.length ? JSON.stringify(ch.forumTags) : null,
        forum_layout: ch.forumLayout ? JSON.stringify({ ...ch.forumLayout, at: now }) : null, auto_delete_interval_hours: ch.autoDeleteMode === 'clear' ? ch.autoDeleteHours : null,
        expires_at: ch.autoDeleteMode === 'clear' && ch.autoDeleteHours ? new Date(now + ch.autoDeleteHours * 3600000).toISOString() : null,
      };
      for (const [k, col, kind] of CHANNEL_FIELDS) cols[col] = kind === 'flag' ? (ch[k] ? 1 : 0) : ch[k];
      if (ch.defaultRole && !cols.default_role_id) warn(`#${ch.name} does not give everyone who joins the ${tpl.roles.find((x) => x.ref === ch.defaultRole).name} role, because it carries more than the Member role has`);
      if (ch.welcome && !replace && hadWelcome) cols.show_welcome = 0, warn(`#${ch.name} was not made the welcome channel, because this server already has one`);
      db.prepare(`UPDATE channels SET ${Object.keys(cols).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...Object.values(cols), id);
    }
    const extra = existing.filter((x) => !matched.has(x.id));
    r.extra.channels = extra.map((x) => x.name);
    if (replace) extra.forEach((x, i) => db.prepare('UPDATE channels SET position = ? WHERE id = ?').run(tpl.channels.length + i + 1, x.id));
    const welcome = tpl.channels.find((ch) => ch.welcome && touched.has(ch.ref));
    if (welcome && replace) db.prepare('UPDATE channels SET show_welcome = 0 WHERE is_dm = 0 AND id != ?').run(chId.get(welcome.ref));
    for (const ch of tpl.channels) if (ch.afkChannel && touched.has(ch.ref)) db.prepare('UPDATE channels SET afk_sub_code = (SELECT code FROM channels WHERE id = ?) WHERE id = ?').run(chId.get(ch.afkChannel), chId.get(ch.ref));
    for (const ch of tpl.channels) if (!ch.afkChannel && ch.afkDisconnect && touched.has(ch.ref)) db.prepare("UPDATE channels SET afk_sub_code = '__leave__' WHERE id = ?").run(chId.get(ch.ref));
    const access = db.prepare(`INSERT OR ${replace ? 'REPLACE' : 'IGNORE'} INTO role_channel_access (role_id, channel_id, grant_on_promote, revoke_on_demote) VALUES (?, ?, ?, ?)`);
    for (const a of tpl.roleChannelAccess) r.counts.access += access.run(roleId.get(a.role), chId.get(a.channel), a.grantOnPromote ? 1 : 0, a.revokeOnDemote ? 1 : 0).changes;
    const cur = new Map(db.prepare('SELECT key, value FROM server_settings').all().map((x) => [x.key, x.value]));
    const set = (key, value, force = false) => {
      if (value === null || value === undefined || cur.get(key) === value) return;
      if (!replace && !force && cur.has(key) && cur.get(key) !== '') return r.existing.settings.push(key);
      db.prepare('INSERT OR REPLACE INTO server_settings (key, value) VALUES (?, ?)').run(key, value);
      cur.set(key, value);
      r.updated.settings.push(key);
      r.changedSettings[key] = value;
    };
    const s = { ...tpl.server.settings };
    const tplCats = [...(s.channel_cat_order ? JSON.parse(s.channel_cat_order) : []), ...tpl.channels.map((ch) => ch.category).filter(Boolean)].filter((x, i, a) => a.indexOf(x) === i);
    let curCats = [];
    try { curCats = JSON.parse(cur.get('channel_cat_order') || '[]'); } catch { curCats = []; }
    if (!Array.isArray(curCats)) curCats = [];
    delete s.channel_cat_order;
    if (tplCats.length) set('channel_cat_order', JSON.stringify(replace ? [...tplCats, ...curCats.filter((x) => !tplCats.includes(x))] : [...curCats, ...tplCats.filter((x) => !curCats.includes(x))]), true);
    if (s.published_themes) {
      const want = JSON.parse(s.published_themes);
      want.filter((f) => !themes.has(f)).forEach((f) => warn(`Theme ${f} is not installed on this server, so it was not published`));
      s.published_themes = JSON.stringify(want.filter((f) => themes.has(f)));
    }
    if (s.default_theme && s.default_theme.startsWith('file:') && !themes.has(s.default_theme.slice(5))) delete s.default_theme;
    const dflt = s.default_theme && s.default_theme.startsWith('file:') ? s.default_theme.slice(5) : null;
    if (dflt && replace && s.published_themes) s.published_themes = JSON.stringify([...new Set([...JSON.parse(s.published_themes), dflt])]);
    else if (dflt && (replace || !cur.get('default_theme'))) {
      let published = [];
      try { published = JSON.parse(cur.get('published_themes') || '[]'); } catch { published = []; }
      if (Array.isArray(published) && !published.includes(dflt)) set('published_themes', JSON.stringify([...published, dflt]), true);
    }
    // Turned into ticks on the template's roles (thresholdsToTicks).
    delete s.permission_thresholds;
    for (const [key, value] of Object.entries(s)) set(key, value);
    set('server_icon', url(tpl.server.icon));
    set('server_banner', url(tpl.server.banner));
    if (tpl.server.defaultJoinChannels) set('default_join_channels', JSON.stringify(tpl.server.defaultJoinChannels.map((x) => chId.get(x))));
    if (tpl.server.guestChannels) set('guest_channels', tpl.server.guestChannels.map((x) => chId.get(x)).join(','));
    if (tpl.server.automodLogChannel) set('automod_log_channel', db.prepare('SELECT code FROM channels WHERE id = ?').get(chId.get(tpl.server.automodLogChannel)).code);
    if (tpl.server.channelCreatorRole) set('channel_creator_role', ['default', 'none'].includes(tpl.server.channelCreatorRole) ? tpl.server.channelCreatorRole : String(roleId.get(tpl.server.channelCreatorRole)));
    const withAsset = (text) => text.replace(ASSET_TOKEN_RE, (_, name) => url(name) || '');
    if (withPosts) {
      const has = db.prepare('SELECT 1 FROM messages WHERE channel_id = ? AND content = ? LIMIT 1');
      const ins = db.prepare('INSERT INTO messages (channel_id, user_id, content, is_webhook, webhook_username, webhook_avatar) VALUES (?, NULL, ?, 1, ?, ?)');
      const pin = db.prepare('INSERT OR IGNORE INTO pinned_messages (message_id, channel_id, pinned_by) VALUES (?, ?, ?)');
      for (const p of tpl.posts) {
        const cid = chId.get(p.channel), content = withAsset(p.content);
        if (has.get(cid, content)) continue;
        const mid = ins.run(cid, content, p.author, url(p.avatar)).lastInsertRowid;
        r.counts.posts++;
        if (p.pinned) actorId ? pin.run(mid, cid, actorId) : warn('Posts were added but not pinned, because no admin account was given to pin them as');
      }
      if (tpl.roleMenus.length && !actorId) warn('Role menus were not posted, because no admin account was given to post them as');
      for (const m of actorId ? tpl.roleMenus : []) {
        const cid = chId.get(m.channel), entries = m.roles.map((x) => ({ roleId: roleId.get(x.role), emoji: x.emoji, name: db.prepare('SELECT name FROM roles WHERE id = ?').get(roleId.get(x.role)).name }))
          .filter((e) => !powerfulRole(e.roleId) || (warn(`${e.name} was left off a role menu, because anyone could pick it and it carries more than the Member role has`), false));
        if (!entries.length) continue;
        const key = JSON.stringify(entries.map((e) => e.roleId).sort());
        const same = db.prepare('SELECT data FROM role_menus WHERE channel_id = ?').all(cid).some((row) => { try { return JSON.stringify((JSON.parse(row.data).roles || []).map((e) => e.roleId).sort()) === key; } catch { return false; } });
        if (same) continue;
        const mid = db.prepare('INSERT INTO messages (channel_id, user_id, content) VALUES (?, ?, ?)').run(cid, actorId, roleMenuContent(m.title, entries)).lastInsertRowid;
        db.prepare('INSERT INTO role_menus (message_id, channel_id, created_by, title, data) VALUES (?, ?, ?, ?, ?)').run(mid, cid, actorId, m.title, JSON.stringify({ roles: entries.map((e) => ({ roleId: e.roleId, emoji: e.emoji })) }));
        entries.forEach((e) => db.prepare('INSERT OR IGNORE INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?)').run(mid, actorId, e.emoji));
        r.counts.roleMenus++;
      }
    }
    for (const w of withWebhooks ? tpl.webhooks : []) {
      const cid = chId.get(w.channel);
      if (db.prepare('SELECT 1 FROM webhooks WHERE channel_id = ? AND name = ?').get(cid, w.name)) continue;
      db.prepare('INSERT INTO webhooks (channel_id, name, token, avatar_url, created_by, subscribed_events, can_moderate, can_use_voice) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(cid, w.name, crypto.randomBytes(32).toString('hex'), url(w.avatar), actorId, w.events, w.canModerate ? 1 : 0, w.canUseVoice ? 1 : 0);
      r.created.webhooks.push(`${w.name} (#${tpl.channels.find((ch) => ch.ref === w.channel).name})`);
    }
    const dom = db.prepare(`INSERT OR ${replace ? 'REPLACE' : 'IGNORE'} INTO automod_domains (domain, mode, include_subdomains, note, added_by) VALUES (?, ?, ?, ?, ?)`);
    for (const d of tpl.automodDomains) r.counts.domains += dom.run(d.domain, d.mode, d.includeSubdomains ? 1 : 0, d.note, actorId).changes;
    const emo = db.prepare(`INSERT OR ${replace ? 'REPLACE' : 'IGNORE'} INTO custom_emojis (name, filename, uploaded_by) VALUES (?, ?, ?)`);
    for (const e of emojis) if (emo.run(e.name, urls[e.asset].file, actorId).changes) r.created.emojis.push(e.name);
    const stk = db.prepare(`INSERT OR ${replace ? 'REPLACE' : 'IGNORE'} INTO stickers (name, pack_name, filename, uploaded_by) VALUES (?, ?, ?, ?)`);
    for (const st of stickers) if (stk.run(st.name, st.pack, urls[st.asset].file, actorId).changes) r.created.stickers.push(st.name);
  };
  // Files go in before the database changes, and come out again if those
  // fail: an unused image costs a little space, a row pointing at a missing
  // one shows broken. Images are admitted to storage, so they are indexed.
  const written = [];
  try {
    if (!dryRun) {
      for (const f of files) {
        if (f.dest) {
          fs.mkdirSync(path.dirname(f.dest), { recursive: true });
          fs.writeFileSync(f.dest, f.buf, { flag: 'wx' });
        } else {
          const staged = path.join(STAGING_DIR, `template-${process.pid}-${crypto.randomBytes(6).toString('hex')}-${path.basename(f.rel)}`);
          fs.writeFileSync(staged, f.buf);
          await media.admit(f.rel, staged);
        }
        written.push(f);
      }
    }
    db.transaction(() => { run(); if (dryRun) throw ROLLBACK; })();
  } catch (err) {
    for (const f of written) {
      try {
        if (f.dest) fs.unlinkSync(f.dest);
        else await media.remove(f.rel);
      } catch (e) { console.warn('[template] could not remove a copied file after a failed import:', e.message); }
    }
    if (err !== ROLLBACK) throw err;
  }
  r.created.files = files.filter((f) => tpl.assets[f.name]?.kind !== 'theme').map((f) => f.name);
  r.created.themes = files.filter((f) => tpl.assets[f.name]?.kind === 'theme').map((f) => f.name);
  return r;
}
module.exports = { FORMAT, VERSION, LIMITS, SETTINGS, checkSetting, exportTemplate, validateTemplate, summarizeTemplate, applyTemplate };

