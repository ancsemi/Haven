'use strict';

// Upload tags limited to a role (#5751): only members holding the role are
// offered the tag and can put it on or take it off an upload; the server
// refuses everyone else. Admins always can.
//
//   node --test test/uploadTagRoles.test.js

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');
const tags = require('../src/uploadTags');
const { tagAccess, canUseTag, setTagRole } = require('../src/uploadTagRoles');
const { createHarness, wait } = require('./socketServerHarness');

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE roles (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, level INTEGER DEFAULT 0);
    CREATE TABLE user_roles (id INTEGER PRIMARY KEY, user_id INTEGER, role_id INTEGER, channel_id INTEGER);
    CREATE TABLE upload_tags (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, name_norm TEXT UNIQUE, created_by INTEGER, role_id INTEGER DEFAULT NULL);
    CREATE TABLE attachment_tags (message_id INTEGER, rel_path TEXT, tag_id INTEGER, PRIMARY KEY (message_id, rel_path, tag_id));
  `);
  db.prepare("INSERT INTO roles (id, name) VALUES (1, 'NSFW'), (2, 'Artist')").run();
  db.prepare("INSERT INTO upload_tags (id, name, name_norm, role_id) VALUES (1, 'art', 'art', NULL), (2, 'NSFW', 'nsfw', 1)").run();
  return db;
}
const one = (content) => ({ messageId: 7, content, userId: 5, canCreate: false, maxTags: 3, maxLen: 20 });

test('only the role holder may use a limited tag; admins always may', () => {
  const db = makeDb();
  const nsfw = { role_id: 1 };
  assert.equal(canUseTag(tagAccess(db, { userId: 5 }), nsfw), false);
  db.prepare('INSERT INTO user_roles (user_id, role_id, channel_id) VALUES (5, 1, NULL)').run();
  assert.equal(canUseTag(tagAccess(db, { userId: 5 }), nsfw), true);
  assert.equal(canUseTag(tagAccess(db, { userId: 6, isAdmin: true }), nsfw), true);
  assert.equal(canUseTag(null, nsfw), false, 'no access given fails closed');
  assert.equal(canUseTag(null, { role_id: null }), true);
  // A role held in one channel counts there and in its sub-channels only.
  db.prepare('INSERT INTO user_roles (user_id, role_id, channel_id) VALUES (8, 1, 40)').run();
  assert.equal(canUseTag(tagAccess(db, { userId: 8, channelIds: [41, 40] }), nsfw), true);
  assert.equal(canUseTag(tagAccess(db, { userId: 8, channelIds: [50] }), nsfw), false);
});

test('the picker leaves out tags the searcher cannot use', () => {
  const db = makeDb();
  assert.deepEqual(tags.searchTags(db, '', 50, tagAccess(db, { userId: 5 })).map(t => t.name), ['art']);
  assert.deepEqual(tags.searchTags(db, 'ns', 50, tagAccess(db, { userId: 5 })), []);
  db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (5, 1)').run();
  assert.deepEqual(tags.searchTags(db, '', 50, tagAccess(db, { userId: 5 })).map(t => t.name), ['art', 'NSFW']);
  assert.deepEqual(tags.searchTags(db, 'ns', 50, tagAccess(db, { userId: 9, isAdmin: true })).map(t => t.name), ['NSFW']);
});

test('applying a limited tag without the role is refused, with it allowed', () => {
  const db = makeDb();
  const content = '/uploads/a.png';
  const applied = tags.applyTagsToMessage(db, { ...one(content), tagNames: ['NSFW', 'art'], access: tagAccess(db, { userId: 5 }) });
  assert.deepEqual(applied, ['art']);
  db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (5, 1)').run();
  const again = tags.applyTagsToMessage(db, { ...one(content), tagNames: ['NSFW'], access: tagAccess(db, { userId: 5 }) });
  assert.deepEqual(again, ['NSFW']);
  // Several files at once go through the same check.
  const db2 = makeDb();
  const two = '/uploads/a.png\n/uploads/b.png';
  const got = tags.applyTagsToFiles(db2, { ...one(two), perFile: [{ url: '/uploads/a.png', tags: ['NSFW'] }, { url: '/uploads/b.png', tags: ['art'] }], access: tagAccess(db2, { userId: 5 }) });
  assert.deepEqual(got, ['art']);
});

test('editing tags without the role neither adds nor removes the limited one', () => {
  const db = makeDb();
  const content = '/uploads/a.png';
  // Put there by someone allowed to.
  tags.applyTagsToMessage(db, { ...one(content), tagNames: ['NSFW', 'art'], access: tagAccess(db, { userId: 1, isAdmin: true }) });
  const member = tagAccess(db, { userId: 5 });
  assert.deepEqual(tags.setMessageTags(db, { ...one(content), tagNames: [], access: member }), ['NSFW'], 'clearing keeps the tag they cannot remove');
  assert.deepEqual(tags.setMessageTags(db, { ...one(content), tagNames: ['art'], access: member }).sort(), ['NSFW', 'art']);
  // With several files the shared edit keeps it too.
  const two = '/uploads/a.png\n/uploads/b.png';
  db.prepare("INSERT INTO attachment_tags VALUES (8, '/uploads/b.png', 2)").run();
  assert.deepEqual(tags.setMessageTags(db, { ...one(two), messageId: 8, tagNames: [], access: member }), ['NSFW']);
});

test('a tag whose role was deleted stays limited, to admins', () => {
  const db = makeDb();
  db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (5, 1)').run();
  db.prepare('DELETE FROM roles WHERE id = 1').run();
  db.prepare('DELETE FROM user_roles WHERE role_id = 1').run();
  assert.deepEqual(tags.searchTags(db, '', 50, tagAccess(db, { userId: 5 })).map(t => t.name), ['art']);
  assert.deepEqual(tags.searchTags(db, '', 50, tagAccess(db, { userId: 1, isAdmin: true })).map(t => t.name), ['art', 'NSFW']);
});

test('setting a tag role checks the tag and the role', () => {
  const db = makeDb();
  assert.deepEqual(setTagRole(db, { tagId: 1, roleId: 2 }), { ok: true, tag: { id: 1, name: 'art', roleId: 2 } });
  assert.equal(db.prepare('SELECT role_id FROM upload_tags WHERE id = 1').get().role_id, 2);
  assert.deepEqual(setTagRole(db, { tagId: 1, roleId: null }).ok, true);
  assert.equal(db.prepare('SELECT role_id FROM upload_tags WHERE id = 1').get().role_id, null);
  assert.deepEqual(setTagRole(db, { tagId: 1, roleId: 99 }), { error: 'no_role' });
  assert.deepEqual(setTagRole(db, { tagId: 99, roleId: 1 }), { error: 'not_found' });
  assert.deepEqual(setTagRole(db, { tagId: 1, roleId: '1' }), { error: 'bad_request' });
  assert.deepEqual(setTagRole(db, { tagId: 'x', roleId: 1 }), { error: 'bad_request' });
});

// ── Against a running server ─────────────────────────────────────────────
const h = createHarness(3516, 'upload-tag-roles');
test.before(() => h.start());
test.after(() => h.stop());

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000'
  + '1f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4bf0000000049454e44ae426082', 'hex');
async function upload(token) {
  const fd = new FormData();
  fd.append('scope', 'channel');
  fd.append('image', new Blob([PNG], { type: 'image/png' }), 'pic.png');
  const r = await fetch('http://localhost:3516/api/upload', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
  const j = await r.json();
  assert.ok(j.url, 'uploaded: ' + JSON.stringify(j));
  return j.url;
}
const readDb = (sql, ...args) => {
  const db = new Database(path.join(h.dataDir, 'haven.db'), { readonly: true, fileMustExist: true });
  try { return db.prepare(sql).all(...args); } finally { db.close(); }
};

test('the server offers and applies a limited tag only to its role holders', async () => {
  const admin = await h.register('admin');
  const bob = await h.register('bob');
  const A = await h.connect(admin.token);
  const B = await h.connect(bob.token);
  await wait(300);

  const list = h.next(A, 'channels-list', (c) => Array.isArray(c) && c.some((x) => x.name === 'art'));
  A.emit('create-channel', { name: 'art' });
  const code = (await list).find((c) => c.name === 'art').code;
  B.emit('join-channel', { code });
  await wait(300);

  const made = await h.ask(A, 'admin-create-tag', { name: 'NSFW' });
  assert.ok(made && made.ok, JSON.stringify(made));
  assert.ok((await h.ask(A, 'admin-create-tag', { name: 'sketch' })).ok);
  const role = await h.ask(A, 'create-role', { name: 'Spicy', level: 1, permissions: [] });
  assert.ok(role && !role.error, JSON.stringify(role));
  const roleId = readDb("SELECT id FROM roles WHERE name = 'Spicy'")[0].id;

  // Admin settings: validated, and only for people who manage tags.
  assert.deepEqual(await h.ask(B, 'admin-set-tag-role', { tagId: made.tag.id, roleId }), { error: 'forbidden' });
  assert.deepEqual(await h.ask(A, 'admin-set-tag-role', { tagId: made.tag.id, roleId: 999999 }), { error: 'no_role' });
  assert.deepEqual(await h.ask(A, 'admin-set-tag-role', { tagId: made.tag.id, roleId: 'Spicy' }), { error: 'bad_request' });
  assert.deepEqual(await h.ask(A, 'admin-set-tag-role', { tagId: 999999, roleId }), { error: 'not_found' });
  const set = await h.ask(A, 'admin-set-tag-role', { tagId: made.tag.id, roleId });
  assert.ok(set && set.ok, JSON.stringify(set));
  const listed = await h.ask(A, 'admin-list-tags', {});
  assert.equal(listed.tags.find((t) => t.name === 'NSFW').roleId, roleId);
  assert.ok(listed.roles.some((r) => r.id === roleId && r.name === 'Spicy'), 'the panel gets the roles to pick from');

  // Without the role: not offered, and not applied when sent anyway.
  const offered = async () => ((await h.ask(B, 'search-upload-tags', { query: '', code })) || {}).tags.map((t) => t.name);
  assert.deepEqual(await offered(), ['sketch']);
  const pic = await upload(bob.token);
  const sent = h.next(A, 'new-message', (d) => d.channelCode === code && d.message.content === pic);
  B.emit('send-message', { code, content: pic, isImage: true, attachmentTags: ['NSFW', 'sketch'] });
  const msg = (await sent).message;
  assert.deepEqual(msg.attachmentTags, ['sketch'], 'the limited tag is refused');
  const edited = h.next(A, 'message-tags-updated', (d) => d.messageId === msg.id);
  B.emit('set-message-tags', { messageId: msg.id, tags: ['NSFW', 'sketch'] });
  assert.deepEqual((await edited).tags, ['sketch'], 'an edit cannot add it either');

  // With the role: offered and applied.
  const given = await h.ask(A, 'assign-role', { userId: bob.id, roleId });
  assert.ok(given && given.success, JSON.stringify(given));
  assert.deepEqual((await offered()).sort(), ['NSFW', 'sketch']);
  const pic2 = await upload(bob.token);
  const sent2 = h.next(A, 'new-message', (d) => d.channelCode === code && d.message.content === pic2);
  B.emit('send-message', { code, content: pic2, isImage: true, attachmentTags: ['NSFW'] });
  assert.deepEqual((await sent2).message.attachmentTags, ['NSFW']);
});
