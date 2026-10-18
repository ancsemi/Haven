'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const Database = require('better-sqlite3');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-template-'));
process.env.HAVEN_DATA_DIR = path.join(ROOT, 'source');
const { initDatabase } = require('../src/database');
const tpl = require('../src/serverTemplate');
const SECRET = 'SECRETMARKER';
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4), sum = Buffer.alloc(4), body = Buffer.concat([Buffer.from(type), data]); len.writeUInt32BE(data.length); sum.writeUInt32BE(crc(body)); return Buffer.concat([len, body, sum]); };
const png = (rgb) => { const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 2; return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('tEXt', Buffer.from(`Comment\0${SECRET}-exif`)), chunk('IDAT', zlib.deflateSync(Buffer.from([0, ...rgb]))), chunk('IEND', Buffer.alloc(0))]); };
const dirs = (name) => { const d = path.join(ROOT, name); fs.mkdirSync(path.join(d, 'uploads', 'stickers'), { recursive: true }); return { data: d, uploads: path.join(d, 'uploads'), themes: path.join(d, 'themes') }; };
const src = dirs('source');
const source = initDatabase();
const pristine = path.join(ROOT, 'pristine.db');
source.exec(`VACUUM INTO '${pristine.replace(/'/g, "''")}'`);
const freshDb = (name) => { const file = path.join(ROOT, `${name}.db`); fs.copyFileSync(pristine, file); const db = new Database(file); db.pragma('foreign_keys = ON'); return db; };
const run = (sql, ...args) => source.prepare(sql).run(...args);
const seed = () => {
  const admin = run('INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, 1)', 'owner', `$2a$${SECRET}hash`).lastInsertRowid;
  const bob = run('INSERT INTO users (username, password_hash) VALUES (?, ?)', 'bob', `$2a$${SECRET}hash2`).lastInsertRowid;
  try { run('UPDATE users SET email = ? WHERE id = ?', `bob@${SECRET}.example`, bob); } catch { /* no email column in this schema */ }
  const set = (k, v) => run('INSERT OR REPLACE INTO server_settings (key, value) VALUES (?, ?)', k, v);
  set('server_name', 'Test Town'); set('server_title', 'Test Town hangout'); set('welcome_message', 'Hi {user}, read #rules');
  set('channel_sort_mode', 'manual'); set('channel_cat_order', JSON.stringify(['Start', 'Talk', 'Staff'])); set('channel_cat_sort', 'manual');
  set('turn_password', `${SECRET}-turn`); set('turnstile_secret_key', `${SECRET}-turnstile`); set('giphy_api_key', `${SECRET}-giphy-key-1234`);
  set('vanity_code', 'secretvanity'); set('server_code', 'abcd1234'); set('registration_token', `${SECRET}-regtoken`); set('turn_url', 'turn:10.1.2.3:3478');
  set('server_icon', '/uploads/icon.png'); set('permission_thresholds', JSON.stringify({ create_channel: 50 }));
  fs.writeFileSync(path.join(src.uploads, 'icon.png'), png([200, 155, 78]));
  fs.writeFileSync(path.join(src.uploads, 'hero.png'), png([10, 20, 30]));
  const role = (name, level, color, perms, auto = 0) => { const id = run('INSERT INTO roles (name, level, scope, color, auto_assign) VALUES (?, ?, ?, ?, ?)', name, level, 'server', color, auto).lastInsertRowid; perms.forEach((p) => run('INSERT INTO role_permissions (role_id, permission, allowed) VALUES (?, ?, 1)', id, p)); return id; };
  const tester = role('Tester', 10, '#C89B4E', ['upload_files', 'use_voice']);
  const ch = (name, extra = {}) => { const id = run('INSERT INTO channels (name, code, created_by) VALUES (?, ?, ?)', name, Math.random().toString(16).slice(2, 10).padEnd(8, '0'), admin).lastInsertRowid; const cols = Object.keys(extra); if (cols.length) source.prepare(`UPDATE channels SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...Object.values(extra), id); run('INSERT INTO channel_members (channel_id, user_id) VALUES (?, ?)', id, admin); return id; };
  const welcome = ch('welcome', { category: 'Start', position: 1, read_only: 1, topic: 'Start here', voice_enabled: 0 });
  const rules = ch('rules', { category: 'Start', position: 2, read_only: 1 });
  const general = ch('general', { category: 'Talk', position: 3, show_welcome: 1, slow_mode_interval: 5 });
  const forum = ch('ideas', { category: 'Talk', position: 4, is_forum: 1, forum_tags: JSON.stringify([{ name: 'Big', emoji: '🔶' }, { name: 'Small' }]), forum_layout: JSON.stringify({ view: 'gallery', tile: 12, shape: '4:3', locked: true, at: 1 }) });
  const lounge = ch('lounge', { category: 'Talk', position: 5, text_enabled: 0 });
  const afk = ch('afk', { parent_channel_id: lounge, position: 6 });
  run('UPDATE channels SET afk_sub_code = (SELECT code FROM channels WHERE id = ?), afk_timeout_minutes = 10 WHERE id = ?', afk, lounge);
  const staff = ch('testers', { category: 'Staff', position: 7, is_private: 1, role_gate: JSON.stringify({ mode: 'any', roles: [tester] }) });
  run("UPDATE channels SET afk_sub_code = '__leave__' WHERE id = ?", staff); // disconnect idle people (#5801)
  ch('secret-plans', { category: 'Staff', position: 8 });
  const dm = ch('dm-bob', { is_dm: 1 });
  run('INSERT INTO messages (channel_id, user_id, content) VALUES (?, ?, ?)', dm, bob, `${SECRET} private dm`);
  run('INSERT INTO messages (channel_id, user_id, content) VALUES (?, ?, ?)', general, bob, `${SECRET} user chat`);
  const pin = (channel, author, content) => { const mid = run('INSERT INTO messages (channel_id, user_id, content, is_webhook, webhook_username, webhook_avatar) VALUES (?, NULL, ?, 1, ?, ?)', channel, content, author, '/uploads/icon.png').lastInsertRowid; run('INSERT INTO pinned_messages (message_id, channel_id, pinned_by) VALUES (?, ?, ?)', mid, channel, admin); };
  pin(welcome, 'Guide', '# Welcome\nRead #rules first.\n/uploads/hero.png');
  pin(rules, 'Guide', '1. Be kind <script>alert(1)</script>');
  const userPin = run('INSERT INTO messages (channel_id, user_id, content) VALUES (?, ?, ?)', general, bob, `${SECRET} pinned by a member`).lastInsertRowid;
  run('INSERT INTO pinned_messages (message_id, channel_id, pinned_by) VALUES (?, ?, ?)', userPin, general, admin);
  const menu = run('INSERT INTO messages (channel_id, user_id, content) VALUES (?, ?, ?)', general, admin, '🎭 Roles\n🧪  Tester').lastInsertRowid;
  run('INSERT INTO role_menus (message_id, channel_id, created_by, title, data) VALUES (?, ?, ?, ?, ?)', menu, general, admin, 'Roles', JSON.stringify({ roles: [{ roleId: tester, emoji: '🧪' }] }));
  run('INSERT INTO webhooks (channel_id, name, token, avatar_url, created_by, callback_url, callback_secret, subscribed_events) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', general, 'Guide', `${SECRET}token0000`, '/uploads/icon.png', admin, `http://127.0.0.1:9/${SECRET}`, `${SECRET}-cbsecret`, 'member-joined');
  run('INSERT INTO role_channel_access (role_id, channel_id, grant_on_promote, revoke_on_demote) VALUES (?, ?, 1, 1)', tester, staff);
  run('INSERT INTO invite_codes (code, label, created_by) VALUES (?, ?, ?)', `${SECRET}inv`, 'friends', admin);
  run('INSERT OR REPLACE INTO automod_domains (domain, mode, include_subdomains, note, added_by) VALUES (?, ?, ?, ?, ?)', 'example.org', 'deny', 0, 'spam', admin);
  run('INSERT INTO custom_emojis (name, filename, uploaded_by) VALUES (?, ?, ?)', 'wave', 'hero.png', admin);
  try { run('INSERT INTO user_ips (user_id, ip) VALUES (?, ?)', bob, '203.0.113.77'); } catch { /* no user_ips table in this schema */ }
  return { admin };
};
const seeded = seed();
const exported = () => tpl.exportTemplate(source, { uploadsDir: src.uploads, themesDir: src.themes, excludeChannels: ['secret-plans'], havenVersion: 'test' });
const strip = (t) => { const o = JSON.parse(JSON.stringify(t)); delete o.exportedAt; const names = Object.fromEntries(Object.entries(o.assets).map(([n, a]) => [n, a.sha256])); const fix = (v) => names[v] || v; o.server.icon = fix(o.server.icon); o.roles = o.roles.map((r) => ({ ...r, icon: fix(r.icon) })); o.webhooks = o.webhooks.map((w) => ({ ...w, avatar: fix(w.avatar) })); o.posts = o.posts.map((p) => ({ ...p, avatar: fix(p.avatar), content: p.content.replace(/\{\{asset:([^}]+)\}\}/g, (_, n) => fix(n)) })); o.emojis = o.emojis.map((e) => ({ ...e, asset: fix(e.asset) })); o.assets = Object.values(names).sort(); return o; };
test.after(() => {
  try { source.close(); } catch { /* already closed */ }
  // Windows can hold a file in the temp folder a moment longer (indexer,
  // antivirus); a leftover temp folder is not a failed test.
  try { fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (err) { console.warn('[test] could not remove', ROOT, err.code); }
});
test('export keeps the layout and leaves out people, messages and secrets', async () => {
  const { template } = await exported();
  const json = JSON.stringify(template);
  assert.equal(template.format, 'haven-server-template');
  assert.equal(template.version, tpl.VERSION);
  assert.ok(!json.includes(SECRET), 'no secret, member, message or token text');
  for (const bad of ['secretvanity', 'abcd1234', 'turn:10.1.2.3', '203.0.113.77', 'owner', 'bob', 'password', 'dm-bob', 'secret-plans']) assert.ok(!json.includes(bad), `${bad} is not exported`);
  assert.deepEqual(template.channels.map((c) => c.name), ['welcome', 'rules', 'general', 'ideas', 'lounge', 'afk', 'testers']);
  assert.deepEqual(Object.keys(template.server.settings).filter((k) => /turn|giphy|turnstile|registration|vanity|server_code/.test(k)), []);
  const lounge = template.channels.find((c) => c.name === 'lounge');
  assert.equal(lounge.afkChannel, 'afk');
  assert.equal(template.channels.find((c) => c.name === 'testers').afkDisconnect, true, 'disconnecting idle people travels too');
  assert.deepEqual(template.channels.find((c) => c.name === 'testers').roleGate, { mode: 'any', roles: ['tester'] });
  assert.equal(template.posts.length, 2, 'only webhook-authored pinned posts');
  assert.match(template.posts[0].content, /\{\{asset:hero\.png\}\}/);
  assert.deepEqual(template.webhooks, [{ channel: 'general', name: 'Guide', avatar: 'icon.png', events: 'member-joined', canModerate: false, canUseVoice: false }]);
  assert.equal(template.roleMenus[0].roles[0].role, 'tester');
  const icon = Buffer.from(template.assets['icon.png'].data, 'base64');
  assert.ok(!icon.includes(Buffer.from(SECRET)), 'image metadata is stripped');
});
test('a fresh server built from the template exports the same template back', async () => {
  const { template } = await exported();
  const v = tpl.validateTemplate(JSON.parse(JSON.stringify(template)));
  assert.ok(v.template, JSON.stringify(v.errors));
  const dst = dirs('dest');
  const db = freshDb('dest');
  const admin = db.prepare('INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, 1)').run('newadmin', 'x').lastInsertRowid;
  const report = await tpl.applyTemplate(db, v.template, { mode: 'replace', actorId: admin, uploadsDir: dst.uploads, themesDir: dst.themes });
  assert.equal(report.created.channels.length, 7);
  assert.ok(report.created.roles.includes('Tester'));
  assert.equal(report.counts.posts, 2);
  assert.equal(report.counts.roleMenus, 1);
  const again = (await tpl.exportTemplate(db, { uploadsDir: dst.uploads, themesDir: dst.themes, havenVersion: 'test' })).template;
  const a = strip(template), b = strip(again);
  b.roles = b.roles.filter((r) => a.roles.some((x) => x.name === r.name));
  b.automodDomains = b.automodDomains.filter((d) => a.automodDomains.some((x) => x.domain === d.domain));
  assert.deepEqual(b, a);
  const posts = db.prepare('SELECT content FROM messages WHERE is_webhook = 1 ORDER BY id').all().map((r) => r.content);
  assert.ok(!posts.join('').includes('<script'), 'post text is sanitised');
  assert.match(posts[0], /\/uploads\/hero-[0-9a-f]{10}\.png/);
  assert.ok(fs.readdirSync(dst.uploads).some((f) => /^icon-[0-9a-f]{10}\.png$/.test(f)));
  const token = db.prepare('SELECT token FROM webhooks').get().token;
  assert.match(token, /^[0-9a-f]{64}$/);
  db.close();
});
test('merge adds what is missing, leaves existing things alone and never deletes', async () => {
  const { template } = await exported();
  const v = tpl.validateTemplate(template).template;
  const dst = dirs('merge');
  const db = freshDb('merge');
  const admin = db.prepare('INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, 1)').run('a', 'x').lastInsertRowid;
  db.prepare("INSERT INTO channels (name, code, topic, category, position) VALUES ('general', 'ffff0001', 'my own topic', 'Mine', 1)").run();
  db.prepare("INSERT INTO channels (name, code, position) VALUES ('keep-me', 'ffff0002', 2)").run();
  db.prepare("INSERT OR REPLACE INTO server_settings (key, value) VALUES ('server_name', 'Mine')").run();
  const report = await tpl.applyTemplate(db, v, { mode: 'merge', actorId: admin, uploadsDir: dst.uploads, themesDir: dst.themes });
  const general = db.prepare("SELECT topic, category FROM channels WHERE name = 'general'").get();
  assert.deepEqual(general, { topic: 'my own topic', category: 'Mine' });
  assert.ok(db.prepare("SELECT 1 FROM channels WHERE name = 'keep-me'").get());
  assert.equal(db.prepare("SELECT value FROM server_settings WHERE key = 'server_name'").get().value, 'Mine');
  assert.deepEqual(report.existing.channels, ['general']);
  assert.ok(report.extra.channels.includes('keep-me'));
  assert.equal(report.created.channels.length, 6);
  const second = await tpl.applyTemplate(db, v, { mode: 'merge', actorId: admin, uploadsDir: dst.uploads, themesDir: dst.themes });
  assert.equal(second.created.channels.length + second.created.roles.length + second.counts.posts + second.counts.roleMenus + second.created.webhooks.length, 0, 'applying twice changes nothing');
  const replaced = await tpl.applyTemplate(db, v, { mode: 'replace', actorId: admin, uploadsDir: dst.uploads, themesDir: dst.themes });
  assert.deepEqual(db.prepare("SELECT topic, category FROM channels WHERE name = 'general'").get(), { topic: '', category: 'Talk' });
  assert.ok(db.prepare("SELECT 1 FROM channels WHERE name = 'keep-me'").get(), 'replace keeps channels outside the template');
  assert.ok(replaced.updated.settings.includes('server_name'));
  db.close();
});
test('a dry run changes nothing and writes no files', async () => {
  const v = tpl.validateTemplate((await exported()).template).template;
  const dst = dirs('dry');
  const db = freshDb('dry');
  const before = db.prepare('SELECT (SELECT count(*) FROM channels) + (SELECT count(*) FROM roles) + (SELECT count(*) FROM server_settings) AS n').get().n;
  const report = await tpl.applyTemplate(db, v, { mode: 'replace', uploadsDir: dst.uploads, themesDir: dst.themes, dryRun: true });
  assert.equal(report.created.channels.length, 7);
  assert.ok(report.created.files.length > 0);
  assert.equal(db.prepare('SELECT (SELECT count(*) FROM channels) + (SELECT count(*) FROM roles) + (SELECT count(*) FROM server_settings) AS n').get().n, before);
  assert.deepEqual(fs.readdirSync(dst.uploads), ['stickers']);
  db.close();
});
test('imports are checked strictly', async () => {
  const once = (await exported()).template;
  const base = () => JSON.parse(JSON.stringify(once));
  const bad = (mutate, pattern) => { const t = base(); mutate(t); const r = tpl.validateTemplate(t); assert.ok(r.errors, 'rejected'); assert.ok(r.errors.some((e) => pattern.test(e)), r.errors.join('\n')); };
  assert.deepEqual(tpl.validateTemplate({ format: 'something-else' }).errors, ['This is not a Haven server template']);
  bad((t) => { t.version = 99; }, /newer Haven/);
  bad((t) => { t.channels[0].name = '<img src=x onerror=alert(1)>'; }, /channels\[0\]\.name/);
  bad((t) => { t.channels[1].parent = '../../etc'; }, /parent/);
  bad((t) => { t.channels[1].ref = t.channels[0].ref; }, /used twice/);
  bad((t) => { t.assets['../evil.png'] = t.assets['icon.png']; }, /plain file name/);
  bad((t) => { t.assets['fake.png'] = { data: Buffer.from('<svg onload=alert(1)>').toString('base64') }; }, /PNG, JPEG/);
  bad((t) => { t.assets['icon.png'].sha256 = '0'.repeat(64); }, /checksum/);
  bad((t) => { t.roles[0].permissions.push('launch_missiles'); }, /unknown permission/);
  bad((t) => { t.roles[0].name = 'x'.repeat(31); }, /roles\[0\]\.name/);
  bad((t) => { t.server.settings.server_name = 'x'.repeat(33); }, /server_name/);
  bad((t) => { t.posts[0].channel = 'nowhere'; }, /unknown channel/);
  bad((t) => { t.webhooks[0].events = 'everything'; }, /events/);
  bad((t) => { t.channels = Array.from({ length: tpl.LIMITS.channels + 1 }, (_, i) => ({ ref: `c${i}`, name: `c${i}` })); }, /at most/);
  const t = base();
  t.server.settings.turn_password = 'x';
  t.server.settings.registration_token = 'y';
  t.channels[0].topic = '<script>alert(1)</script>Hello';
  const ok = tpl.validateTemplate(t);
  assert.ok(ok.template);
  assert.equal(ok.template.server.settings.turn_password, undefined);
  assert.ok(ok.warnings.some((w) => /turn_password/.test(w)));
  assert.equal(ok.template.channels[0].topic, 'Hello');
});
test('an older template\'s level thresholds become ticks on its roles, never admin-only ones', async () => {
  const t = JSON.parse(JSON.stringify((await exported()).template));
  assert.equal(t.server.settings.permission_thresholds, undefined, 'exports no longer carry thresholds');
  t.server.settings.permission_thresholds = JSON.stringify({ transfer_admin: 1, manage_server: 1, manage_roles: 1, pin_message: 10 });
  const v = tpl.validateTemplate(t);
  assert.ok(v.template, JSON.stringify(v.errors));
  assert.deepEqual(JSON.parse(v.template.server.settings.permission_thresholds), { pin_message: 10 });
  assert.ok(v.warnings.some((w) => /transfer_admin/.test(w)), 'the admin is told what was left out');
  const dst = dirs('thresholds');
  const db = freshDb('thresholds');
  const admin = db.prepare('INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, 1)').run('a', 'x').lastInsertRowid;
  db.prepare("INSERT OR REPLACE INTO server_settings (key, value) VALUES ('permission_thresholds', '{}')").run();
  const roles = v.template.roles.filter((r) => r.scope === 'server' && r.level > 0 && !r.denied.includes('pin_message'));
  const ticked = new Map(roles.map((r) => [r.name, r.permissions.includes('pin_message')]));
  await tpl.applyTemplate(db, v.template, { mode: 'replace', actorId: admin, uploadsDir: dst.uploads, themesDir: dst.themes });
  const after = db.prepare("SELECT value FROM server_settings WHERE key = 'permission_thresholds'").get().value;
  assert.equal(after, '{}', 'the setting itself is not brought back');
  const has = (name, perm) => !!db.prepare('SELECT 1 FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE r.name = ? AND rp.permission = ? AND rp.allowed = 1').get(name, perm);
  assert.ok(roles.length, 'the template has server roles to check');
  for (const role of roles) {
    assert.equal(has(role.name, 'pin_message'), role.level >= 10 || ticked.get(role.name), `${role.name} (level ${role.level})`);
    assert.equal(has(role.name, 'transfer_admin'), false);
  }
  db.close();
});
test('a template cannot hand out power through roles, role menus or channel default roles', async () => {
  const { template } = await exported();
  assert.ok(!template.roles.some((r) => r.name === 'Admin'), 'the Admin role is never exported');
  const t = {
    format: 'haven-server-template', version: 1, meta: { name: 'Takeover' },
    server: { settings: {} },
    roles: [
      { ref: 'admin', name: 'Admin', level: 99, permissions: ['ban_user'] },
      { ref: 'member', name: 'Member', level: 1, permissions: ['ban_user', 'use_voice'] },
      { ref: 'boss', name: 'Boss', level: 90, autoAssign: true, permissions: ['manage_server', 'transfer_admin', 'ban_user'] },
      { ref: 'mod', name: 'Picky', level: 5, permissions: ['kick_user'] },
      { ref: 'fun', name: 'Fun', level: 5, permissions: ['use_voice'] },
    ],
    channels: [{ ref: 'hall', name: 'hall', defaultRole: 'boss' }, { ref: 'side', name: 'side', defaultRole: 'fun' }],
    roleMenus: [{ channel: 'hall', title: 'Roles', content: 'Pick one', roles: [{ role: 'mod', emoji: '🔨' }, { role: 'fun', emoji: '🎉' }, { role: 'boss', emoji: '👑' }] }],
  };
  const v = tpl.validateTemplate(t);
  assert.ok(v.template, JSON.stringify(v.errors));
  assert.deepEqual(v.template.roles.find((r) => r.ref === 'boss').permissions, ['ban_user']);
  assert.ok(v.warnings.some((w) => /manage_server, transfer_admin/.test(w)));
  const dst = dirs('power');
  const db = freshDb('power');
  const admin = db.prepare('INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, 1)').run('a', 'x').lastInsertRowid;
  const perms = (name) => db.prepare('SELECT rp.permission FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE r.name = ? AND rp.allowed = 1 ORDER BY rp.permission').all(name).map((x) => x.permission);
  const adminBefore = perms('Admin');
  const memberBefore = perms('Member');
  const report = await tpl.applyTemplate(db, v.template, { mode: 'replace', actorId: admin, uploadsDir: dst.uploads, themesDir: dst.themes });
  assert.deepEqual(perms('Admin'), adminBefore, 'the Admin role is left alone');
  assert.equal(db.prepare("SELECT level FROM roles WHERE name = 'Admin'").get().level, 99);
  assert.deepEqual(perms('Member'), memberBefore, 'the role every member gets is not given more power');
  assert.equal(db.prepare("SELECT auto_assign FROM roles WHERE name = 'Member'").get().auto_assign, 1);
  assert.deepEqual(perms('Boss'), ['ban_user']);
  assert.equal(db.prepare("SELECT auto_assign FROM roles WHERE name = 'Boss'").get().auto_assign, 0, 'a powerful role is not handed to new members');
  assert.equal(db.prepare("SELECT default_role_id FROM channels WHERE name = 'hall'").get().default_role_id, null, 'nor to everyone who joins a channel');
  assert.ok(db.prepare("SELECT default_role_id FROM channels WHERE name = 'side'").get().default_role_id, 'a harmless default role is kept');
  const menu = JSON.parse(db.prepare('SELECT data FROM role_menus').get().data).roles;
  const fun = db.prepare("SELECT id FROM roles WHERE name = 'Fun'").get().id;
  assert.deepEqual(menu, [{ roleId: fun, emoji: '🎉' }], 'only the harmless role is on the menu');
  for (const pattern of [/Admin role/, /Member was left as it is/, /Boss was not made the role new members get/, /#hall does not give/, /Picky was left off a role menu/]) {
    assert.ok(report.warnings.some((w) => pattern.test(w)), `${pattern} in ${report.warnings.join(' | ')}`);
  }
  db.close();
});
test('role menus are posted with the standard text, never text from the file', async () => {
  assert.equal((await exported()).template.roleMenus[0].content, undefined, 'menu text is not exported');
  const t = () => ({
    format: 'haven-server-template', version: 1, meta: { name: 'Menus' }, server: { settings: {} },
    roles: [{ ref: 'fun', name: 'Fun', level: 1 }, { ref: 'art', name: 'Art', level: 1 }],
    channels: [{ ref: 'hall', name: 'hall' }],
    roleMenus: [{ channel: 'hall', title: 'Pick', content: '@everyone the owner says: send your password to evil.example', roles: [{ role: 'fun', emoji: '🎉' }, { role: 'art', emoji: '🎨' }] }],
  });
  const v = tpl.validateTemplate(t());
  assert.ok(v.template, JSON.stringify(v.errors));
  const dst = dirs('menus');
  const db = freshDb('menus');
  const admin = db.prepare('INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, 1)').run('a', 'x').lastInsertRowid;
  await tpl.applyTemplate(db, v.template, { mode: 'merge', actorId: admin, uploadsDir: dst.uploads, themesDir: dst.themes });
  const posted = db.prepare('SELECT m.content FROM role_menus rm JOIN messages m ON m.id = rm.message_id').get().content;
  assert.equal(posted, '🎭 Pick\n🎉  Fun\n🎨  Art');
  db.close();
  const bad = (mutate, pattern) => { const x = t(); mutate(x.roleMenus[0]); const r = tpl.validateTemplate(x); assert.ok(r.errors && r.errors.some((e) => pattern.test(e)), JSON.stringify(r)); };
  bad((m) => { m.roles[0].emoji = 'click me'; }, /needs a role and an emoji/);
  bad((m) => { m.roles[0].emoji = '🎉🎉🎉🎉🎉'; }, /needs a role and an emoji/);
  bad((m) => { m.roles[1].emoji = '🎉'; }, /twice/);
  bad((m) => { m.roles[1].role = 'fun'; }, /twice/);
});
test('a server with names saved under older rules still exports a file its own import accepts', async () => {
  const from = dirs('legacy');
  const db = freshDb('legacy');
  const q = (sql, ...args) => db.prepare(sql).run(...args);
  const admin = q('INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, 1)', 'a', 'x').lastInsertRowid;
  let code = 0;
  const ch = (name, extra = {}) => { const id = q('INSERT INTO channels (name, code, created_by) VALUES (?, ?, ?)', name, `ab${String(++code).padStart(6, '0')}`, admin).lastInsertRowid; for (const [k, v] of Object.entries(extra)) q(`UPDATE channels SET ${k} = ? WHERE id = ?`, v, id); return id; };
  const news = ch('news: updates / misc', { category: 'Old <Stuff>', topic: 't'.repeat(300) });
  ch('x'.repeat(60));
  ch('General');
  ch('general');
  ch('ideas', { is_forum: 1, forum_layout: JSON.stringify({ view: 'weird', tile: 100, shape: 'round' }), forum_tags: JSON.stringify([{ name: 'Big', emoji: 'not an emoji at all, far too long' }]) });
  const boss = q('INSERT INTO roles (name, level, scope, color) VALUES (?, ?, ?, ?)', '<b>Boss</b>', 40, 'server', 'red').lastInsertRowid;
  q('INSERT INTO roles (name, level, scope) VALUES (?, ?, ?)', 'bBoss/b', 30, 'server');
  q('INSERT INTO webhooks (channel_id, name, token, created_by, subscribed_events) VALUES (?, ?, ?, ?, ?)', news, 'A <very> long webhook name that is way over the limit', 'f'.repeat(64), admin, 'message,bogus');
  const post = (author, content) => { const mid = q('INSERT INTO messages (channel_id, user_id, content, is_webhook, webhook_username) VALUES (?, NULL, ?, 1, ?)', news, content, author).lastInsertRowid; q('INSERT INTO pinned_messages (message_id, channel_id, pinned_by) VALUES (?, ?, ?)', mid, news, admin); };
  post('<Server Bot> with a name far longer than thirty-two characters', 'Read this {{asset:missing.png}} first');
  post('Bot', '<script></script>');
  const menu = q('INSERT INTO messages (channel_id, user_id, content) VALUES (?, ?, ?)', news, admin, 'menu').lastInsertRowid;
  q('INSERT INTO role_menus (message_id, channel_id, created_by, title, data) VALUES (?, ?, ?, ?, ?)', menu, news, admin, 'Roles', JSON.stringify({ roles: [{ roleId: boss, emoji: '🎉' }, { roleId: boss, emoji: '🎈' }] }));
  q("INSERT OR REPLACE INTO automod_domains (domain, mode, include_subdomains, note, added_by) VALUES ('not a domain', 'deny', 1, '', ?)", admin);
  fs.writeFileSync(path.join(from.uploads, 'party.png'), png([1, 2, 3]));
  q('INSERT INTO custom_emojis (name, filename, uploaded_by) VALUES (?, ?, ?)', 'Party Time!', 'party.png', admin);
  const first = await tpl.exportTemplate(db, { uploadsDir: from.uploads, themesDir: from.themes });
  const v = tpl.validateTemplate(JSON.parse(JSON.stringify(first.template)));
  assert.ok(v.template, (v.errors || []).join('\n'));
  const names = first.template.channels.map((c) => c.name);
  assert.ok(names.includes('news updates  misc'));
  assert.ok(names.includes('x'.repeat(50)));
  assert.ok(names.includes('General') && names.includes('general-2'));
  assert.deepEqual(first.template.webhooks[0], { channel: 'news-updates-misc', name: 'A very long webhook name that is', avatar: null, events: 'message', canModerate: false, canUseVoice: false });
  assert.deepEqual(first.template.posts.map((p) => [p.author, p.content]), [['Server Bot with a name far longe', 'Read this  first']]);
  assert.deepEqual(first.template.roleMenus[0].roles, [{ role: first.template.roles.find((r) => r.name === 'bBoss/b').ref, emoji: '🎉' }]);
  assert.deepEqual(first.template.emojis.map((e) => e.name), ['partytime']);
  assert.ok(first.warnings.some((w) => /not a domain/.test(w)));
  const to = dirs('legacy-copy');
  const copy = freshDb('legacy-copy');
  const copyAdmin = copy.prepare('INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, 1)').run('a', 'x').lastInsertRowid;
  await tpl.applyTemplate(copy, v.template, { mode: 'replace', actorId: copyAdmin, uploadsDir: to.uploads, themesDir: to.themes });
  const again = tpl.validateTemplate(JSON.parse(JSON.stringify((await tpl.exportTemplate(copy, { uploadsDir: to.uploads, themesDir: to.themes })).template)));
  assert.ok(again.template, (again.errors || []).join('\n'));
  assert.deepEqual(again.template.channels.map((c) => c.name), v.template.channels.map((c) => c.name));
  db.close();
  copy.close();
});
test('template images keep to the emoji and sticker size limits and the disk headroom', async () => {
  const small = png([1, 1, 1]);
  const big = Buffer.concat([small.subarray(0, small.length - 12), chunk('zzZz', Buffer.alloc(80 * 1024)), small.subarray(small.length - 12)]);
  const entry = (buf, kind = 'upload') => ({ kind, sha256: require('node:crypto').createHash('sha256').update(buf).digest('hex'), data: buf.toString('base64') });
  const t = {
    format: 'haven-server-template', version: 1, meta: { name: 'Images' }, server: { settings: {} },
    emojis: [{ name: 'small', asset: 'small.png' }, { name: 'huge', asset: 'big.png' }],
    assets: { 'small.png': entry(small), 'big.png': entry(big), 'unused.png': entry(png([9, 9, 9])) },
  };
  const v = tpl.validateTemplate(t);
  assert.ok(v.template, JSON.stringify(v.errors));
  const dst = dirs('images');
  const db = freshDb('images');
  const admin = db.prepare('INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, 1)').run('a', 'x').lastInsertRowid;
  db.prepare("INSERT OR REPLACE INTO server_settings (key, value) VALUES ('max_emoji_kb', '64')").run();
  await assert.rejects(() => tpl.applyTemplate(db, v.template, { mode: 'merge', actorId: admin, uploadsDir: dst.uploads, themesDir: dst.themes, hasRoom: () => false }), { code: 'TEMPLATE_DISK_FULL' });
  assert.deepEqual(fs.readdirSync(dst.uploads), ['stickers'], 'nothing is written when the disk is low');
  assert.equal(db.prepare('SELECT count(*) AS n FROM custom_emojis').get().n, 0);
  const report = await tpl.applyTemplate(db, v.template, { mode: 'merge', actorId: admin, uploadsDir: dst.uploads, themesDir: dst.themes });
  assert.deepEqual(report.created.emojis, ['small']);
  assert.ok(report.warnings.some((w) => /huge was left out/.test(w)));
  assert.deepEqual(fs.readdirSync(dst.uploads).filter((f) => f !== 'stickers').map((f) => f.replace(/-[0-9a-f]{10}/, '')), ['small.png'], 'only images the template uses are copied');
  db.close();
});
