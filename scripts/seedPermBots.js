'use strict';

/**
 * Fake members for poking at Settings → Permissions.
 * Re-run to wipe the last plant and write it again.
 *
 *   node scripts/seedPermBots.js
 */

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const { DB_PATH } = require('../src/paths');

const BIO = 'perm-seed';

const PEOPLE = [
  { u: 'mira', d: 'mira', seed: 'mira-night', role: 'member', status: 'online', text: 'up too late' },
  { u: 'jules', d: 'Jules', seed: 'jules-ok', role: 'mod', status: 'online', text: '' },
  { u: 'theo', d: 'theo', seed: 'theo-ask', role: 'member', status: 'away', text: '' },
  { u: 'nico', d: 'Nico', seed: 'nico-voice', role: 'member', status: 'online', text: 'in call maybe' },
  { u: 'reed', d: 'reed', seed: 'reed-quiet', role: 'member', status: 'offline', text: '' },
  { u: 'kira', d: 'kira', seed: 'kira-cam', role: 'mod', status: 'away', text: '' },
  { u: 'oz', d: 'Oz', seed: 'oz-essay', role: 'member', status: 'online', text: 'reading' },
  { u: 'bee', d: 'Bee', seed: 'bee-hype', role: 'member', status: 'online', text: '' },
  { u: 'cass', d: 'cass', seed: 'cass-mod', role: 'mod', status: 'online', text: '' },
  { u: 'vin', d: 'vin', seed: 'vin-css', role: 'member', status: 'away', text: 'moving pixels' },
  { u: 'lark', d: 'lark', seed: 'lark-fm', role: 'member', status: 'offline', text: 'something on' },
  { u: 'june', d: 'June', seed: 'june-new', role: 'member', status: 'online', text: 'new here' },
  { u: 'piotr', d: 'Piotr', seed: 'piotr-ok', role: 'member', status: 'offline', text: '' },
  { u: 'ash', d: 'ash', seed: 'ash-ok', role: 'member', status: 'away', text: '' },
];

function avatar(seed) {
  return `https://api.dicebear.com/9.x/adventurer/svg?seed=${encodeURIComponent(seed)}`;
}

function pickRoles(db) {
  const server = db.prepare("SELECT * FROM roles WHERE scope = 'server' AND level > 0 ORDER BY level DESC").all();
  const auto = server.find((r) => r.auto_assign) || server[server.length - 1];
  const mod = server.find((r) => /mod/i.test(r.name) && r.level >= 25) || server[0];
  if (!auto) throw new Error('No server roles to assign. Open Permissions once or Reset to Default first.');
  return { member: auto, mod: mod || auto };
}

function wipe(db) {
  const old = db.prepare('SELECT id FROM users WHERE bio = ?').all(BIO);
  if (!old.length) return 0;
  const ids = old.map((r) => r.id);
  const marks = ids.map(() => '?').join(',');
  db.transaction(() => {
    db.prepare(`DELETE FROM user_role_perms WHERE user_id IN (${marks})`).run(...ids);
    db.prepare(`DELETE FROM user_roles WHERE user_id IN (${marks})`).run(...ids);
    db.prepare(`DELETE FROM channel_members WHERE user_id IN (${marks})`).run(...ids);
    db.prepare(`DELETE FROM users WHERE id IN (${marks})`).run(...ids);
  })();
  return ids.length;
}

function seed(db) {
  const roles = pickRoles(db);
  const removed = wipe(db);
  const hash = bcrypt.hashSync(crypto.randomBytes(24).toString('hex'), 4);
  const insert = db.prepare(`
    INSERT INTO users (username, password_hash, is_admin, display_name, avatar, avatar_shape, bio, status, status_text)
    VALUES (?, ?, 0, ?, ?, 'circle', ?, ?, ?)
  `);
  const join = db.prepare('INSERT OR IGNORE INTO channel_members (channel_id, user_id) VALUES (?, ?)');
  const grant = db.prepare('INSERT OR IGNORE INTO user_roles (user_id, role_id, channel_id, granted_by) VALUES (?, ?, NULL, NULL)');
  const channels = db.prepare('SELECT id FROM channels WHERE COALESCE(is_dm, 0) = 0').all();
  const created = [];

  db.transaction(() => {
    for (const p of PEOPLE) {
      const taken = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(p.u);
      const username = taken ? `fake_${p.u}` : p.u;
      const id = Number(insert.run(username, hash, p.d, avatar(p.seed), BIO, p.status, p.text).lastInsertRowid);
      for (const ch of channels) join.run(ch.id, id);
      const role = roles[p.role] || roles.member;
      grant.run(id, role.id);
      created.push({ username, display: p.d, role: role.name });
    }
  })();

  return { removed, created, roles };
}

function main() {
  const db = new Database(DB_PATH);
  try {
    const result = seed(db);
    console.log(`[perm-seed] wrote ${result.created.length} users to ${DB_PATH} (wiped ${result.removed})`);
    console.log(`[perm-seed] member=${result.roles.member.name}  mod=${result.roles.mod.name}`);
    for (const u of result.created) console.log(`  ${u.username}  (${u.display})  →  ${u.role}`);
  } finally {
    db.close();
  }
}

if (require.main === module) main();

module.exports = { seed };
