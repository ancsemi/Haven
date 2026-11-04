'use strict';

/**
 * Haven's own image emoji (flags, platforms) and the server's custom ones
 * work wherever an emoji is picked: reactions and role menus. The server's
 * list of built-in names matches the client's.
 *
 *   node --test test/builtinEmojis.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { BUILTIN_EMOJI_NAMES, isUsableEmoji, isPortableEmoji } = require('../src/builtinEmojis');
const { createHarness, wait } = require('./socketServerHarness');

const ROOT = path.join(__dirname, '..');

test('the server knows the same built-in emoji as the client, and each has its picture', () => {
  const app = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
  const list = app.slice(app.indexOf('this.builtinEmojis = ['), app.indexOf('];', app.indexOf('this.builtinEmojis = [')));
  const client = [...list.matchAll(/name: '([a-z0-9_]+)', url: '([^']+)'/g)];
  assert.deepStrictEqual(client.map(m => m[1]).sort(), [...BUILTIN_EMOJI_NAMES].sort());
  for (const [, name, url] of client) assert.ok(fs.existsSync(path.join(ROOT, 'public', url)), `${name}: ${url}`);
  for (const os of ['windows', 'mac', 'ios', 'android', 'linux']) {
    const svg = fs.readFileSync(path.join(ROOT, 'public/emoji/platforms', `${os}.svg`), 'utf8');
    assert.doesNotMatch(svg, /<script|on\w+=|href=|xlink/i, `${os}.svg is a plain picture`);
  }
});

test('which emoji are accepted', () => {
  const db = { prepare: () => ({ get: (name) => (name === 'partyparrot' ? { 1: 1 } : undefined) }) };
  for (const ok of ['🎮', '🪟', ':os_windows:', ':flag_us:', ':partyparrot:']) assert.ok(isUsableEmoji(db, ok), ok);
  for (const bad of [':nope:', 'text', '', ':os_windows', 'a'.repeat(40), null]) assert.ok(!isUsableEmoji(db, bad), String(bad));
  assert.ok(isPortableEmoji(':os_linux:'), 'a built-in one travels in a template');
  assert.ok(!isPortableEmoji(':partyparrot:'), 'a custom one may not exist where a template goes');
  assert.ok(isPortableEmoji('🐧'));
});

const h = createHarness(3592, 'builtin-emojis');
test.before(() => h.start());
test.after(() => h.stop());

test('a role menu and reactions take platform emoji', async (t) => {
  const admin = await h.register('admin');
  const bob = await h.register('bob');
  const A = await h.connect(admin.token);
  const db = new Database(path.join(h.dataDir, 'haven.db'));
  db.pragma('busy_timeout = 5000');
  t.after(() => db.close());

  const win = await h.ask(A, 'create-role', { name: 'Windows', level: 0, permissions: [] });
  assert.ok(win.success, JSON.stringify(win));
  A.emit('create-channel', { name: 'roles' });
  let ch;
  for (let i = 0; i < 30 && !ch; i++) { ch = db.prepare('SELECT id, code FROM channels WHERE name = ?').get('roles'); if (!ch) await wait(100); }
  const B = await h.connect(bob.token);
  B.emit('join-channel', { code: ch.code });
  await wait(300);

  const menu = await h.ask(A, 'create-role-menu', { code: ch.code, title: 'Platforms', roles: [{ roleId: win.roleId, emoji: ':os_windows:' }] });
  assert.ok(menu.success, JSON.stringify(menu));
  assert.match(db.prepare('SELECT content FROM messages WHERE id = ?').get(menu.messageId).content, /:os_windows: {2}Windows/);
  const bad = await h.ask(A, 'create-role-menu', { code: ch.code, roles: [{ roleId: win.roleId, emoji: ':not_a_thing:' }] });
  assert.ok(bad.error, 'an unknown name is refused');

  B.emit('add-reaction', { messageId: menu.messageId, emoji: ':os_windows:' });
  await wait(500);
  const held = db.prepare('SELECT 1 FROM user_roles WHERE user_id = ? AND role_id = ? AND channel_id IS NULL').get(bob.id, win.roleId);
  assert.ok(held, 'reacting with the platform emoji gives the role');

  A.disconnect();
  B.disconnect();
});
