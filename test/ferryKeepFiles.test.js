'use strict';

// Pictures and files in a message from Discord can be copied into Haven's
// uploads as it arrives (#5906): Discord's signed links stop working after
// about a day, so a link turns into a broken picture. The copy is off until
// the admin turns it on, only happens for messages Ferry carries, and follows
// the rules an upload follows.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

process.env.HAVEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-ferryfiles-'));
const Database = require('better-sqlite3');
const { UPLOADS_DIR } = require('../src/paths');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
const privacyPassPath = require.resolve('../src/privacyPass');
require.cache[privacyPassPath] = {
  id: privacyPassPath, filename: privacyPassPath, loaded: true,
  exports: { admitFile: async (tmp, rel) => { const dest = path.join(UPLOADS_DIR, rel); fs.renameSync(tmp, dest); return { size: fs.statSync(dest).size }; } },
};
const ferry = require('../src/ferry');
const { buildHavenContent, keepFiles, inbound } = ferry;

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE server_settings (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE channels (id INTEGER PRIMARY KEY, code TEXT);
  CREATE TABLE ferry_links (id INTEGER PRIMARY KEY, channel_id INTEGER, discord_channel_id TEXT, webhook_id TEXT, is_active INTEGER DEFAULT 1, direction TEXT DEFAULT 'both');
  CREATE TABLE ferry_forum_threads (topic_message_id INTEGER, channel_id INTEGER, discord_forum_id TEXT, discord_thread_id TEXT, origin TEXT);
  CREATE TABLE upload_ownership (rel_path TEXT PRIMARY KEY, user_id INTEGER, bytes INTEGER, scope TEXT);
  INSERT INTO channels (id, code) VALUES (1, 'general1');
  INSERT INTO ferry_links (channel_id, discord_channel_id) VALUES (1, '100');
  INSERT INTO ferry_links (channel_id, discord_channel_id, direction) VALUES (1, '200', 'to_discord');
`);
ferry.initFerry({ db, sanitizeText: (s) => s });
const setting = (key, value) => db.prepare('INSERT OR REPLACE INTO server_settings (key, value) VALUES (?, ?)').run(key, value);
const stored = () => fs.readdirSync(UPLOADS_DIR);

const CDN = 'https://cdn.discordapp.com/attachments/1/2/';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const fetched = [];
const realFetch = global.fetch;
let hold = null;
global.fetch = async (url) => {
  fetched.push(String(url));
  if (hold && String(url).includes('slow')) await hold;
  if (String(url).includes('gone')) return new Response('expired', { status: 404 });
  const body = String(url).includes('.png') && !String(url).includes('fake') ? PNG : Buffer.from('%PDF-1.4 hello');
  return new Response(body, { status: 200, headers: { 'content-length': String(body.length) } });
};
test.after(() => { global.fetch = realFetch; fs.rmSync(process.env.HAVEN_DATA_DIR, { recursive: true, force: true }); });
test.beforeEach(() => {
  fetched.length = 0;
  setting('ferry_copy_files', '1');
  setting('blocked_upload_extensions', '');
});

test('it is off until the admin turns it on', async () => {
  db.prepare("DELETE FROM server_settings WHERE key = 'ferry_copy_files'").run();
  const msg = { content: 'look', attachments: [{ url: `${CDN}cat.png?ex=1&hm=a` }] };
  await keepFiles(msg, null);
  assert.deepEqual(fetched, []);
  assert.match(buildHavenContent(msg), /cdn\.discordapp\.com/);
  assert.equal(ferry.getFerryState().copyFiles, false);
  setting('ferry_copy_files', '1');
  assert.equal(ferry.getFerryState().copyFiles, true, 'the options window is told it is on');
});

test('a picture and a file sent from Discord become Haven uploads', async () => {
  const msg = { content: 'look', attachments: [{ url: `${CDN}cat.png?ex=1&hm=a` }, { url: `${CDN}notes.pdf?ex=1&hm=a` }] };
  assert.match(buildHavenContent(msg), /cdn\.discordapp\.com/, 'a link until the files are copied');
  await keepFiles(msg, null);
  const lines = buildHavenContent(msg).split('\n');
  assert.equal(lines[0], 'look');
  assert.match(lines[1], /^\/uploads\/\d+-[0-9a-f]{16}\.png$/);
  assert.match(lines[2], /^\[file:notes\.pdf\]\(\/uploads\/\d+-[0-9a-f]{16}\.pdf\|\d+ B\)$/);
  const rel = lines[1].slice('/uploads/'.length);
  assert.ok(fs.existsSync(path.join(UPLOADS_DIR, rel)), 'the picture is stored');
  assert.deepEqual(db.prepare('SELECT user_id, scope FROM upload_ownership WHERE rel_path = ?').get(rel), { user_id: null, scope: 'channel' },
    'recorded with no owner, so deleting the message can take it');
});

test('a picture that cannot be copied stays the Discord link', async () => {
  const msg = { content: '', attachments: [{ url: `${CDN}gone.png?ex=1` }, { url: `${CDN}cat.png?ex=1` }] };
  await keepFiles(msg, null);
  const lines = buildHavenContent(msg).split('\n');
  assert.equal(lines[0], `${CDN}gone.png?ex=1`);
  assert.match(lines[1], /^\/uploads\//);
});

test('a file type the admin blocks is not fetched at all', async () => {
  setting('blocked_upload_extensions', 'exe,bat');
  const msg = { content: '', attachments: [{ url: `${CDN}setup.exe?ex=1` }, { url: `${CDN}cat.png?ex=1` }] };
  await keepFiles(msg, null);
  assert.deepEqual(fetched, [`${CDN}cat.png?ex=1`]);
  assert.equal(buildHavenContent(msg).split('\n')[0], `${CDN}setup.exe?ex=1`);
});

test('a file named as a picture that is not one is not kept', async () => {
  const before = stored().length;
  const msg = { content: '', attachments: [{ url: `${CDN}fake.png?ex=1` }] };
  await keepFiles(msg, null);
  assert.equal(buildHavenContent(msg), `${CDN}fake.png?ex=1`);
  assert.equal(stored().length, before);
});

test('a forwarded picture is copied too, and sits under the quote as a picture', async () => {
  const msg = { content: '', attachments: [], message_snapshots: [{ message: { content: 'look at this', attachments: [{ url: `${CDN}cat.png?ex=1` }] } }] };
  await keepFiles(msg, null);
  assert.match(buildHavenContent(msg), /^> \*Forwarded\*\n> look at this\n\/uploads\/\d+-[0-9a-f]{16}\.png$/);
});

test('an edit keeps the copies, and copies only a file that is new', async () => {
  const first = { content: 'one', attachments: [{ url: `${CDN}cat.png?ex=1&hm=a` }] };
  await keepFiles(first, null);
  const kept = buildHavenContent(first);
  fetched.length = 0;
  const edit = { content: 'one, fixed', attachments: [{ url: `${CDN}cat.png?ex=2&hm=b` }, { url: `${CDN}notes.pdf?ex=2&hm=b` }] };
  await keepFiles(edit, first._files);
  const lines = buildHavenContent(edit).split('\n');
  assert.equal(lines[1], kept.split('\n')[1], 'the picture already in Haven is not copied again');
  assert.match(lines[2], /^\[file:notes\.pdf\]/);
  assert.deepEqual(fetched, [`${CDN}notes.pdf?ex=2&hm=b`]);
});

test('only Discord attachment links are fetched', async () => {
  const msg = { content: '', attachments: [{ url: 'https://example.com/a.png' }, { url: 'https://cdn.discordapp.com/avatars/1/2.png' }] };
  await keepFiles(msg, null);
  assert.deepEqual(fetched, []);
  assert.equal(buildHavenContent(msg), 'https://example.com/a.png\nhttps://cdn.discordapp.com/avatars/1/2.png');
});

test('nothing is fetched for a channel that is not paired, a one-way pairing out, or another bot', async () => {
  const seen = [];
  const relay = (m) => { seen.push(m.id); };
  const file = [{ url: `${CDN}cat.png?ex=1` }];
  await inbound({ id: 'u1', channel_id: '999', type: 0, content: '', attachments: file }, relay);
  await inbound({ id: 'u2', channel_id: '200', type: 0, content: '', attachments: file }, relay);
  await inbound({ id: 'u3', channel_id: '100', type: 0, author: { id: '5', bot: true }, content: '', attachments: file }, relay);
  await inbound({ id: 'u4', channel_id: '100', type: 7, content: '', attachments: file }, relay);
  assert.deepEqual(fetched, [], 'no downloads');
  assert.deepEqual(seen, ['u1', 'u2', 'u3', 'u4'], 'the messages still go on to the usual checks');
});

test('a copy made for a message that did not reach Haven is removed', async () => {
  const before = stored().length;
  // Paired, so the file is copied; the relay here carries nothing over.
  await inbound({ id: 'dropped', channel_id: '100', type: 0, content: '', attachments: [{ url: `${CDN}cat.png?ex=1` }] }, () => {});
  assert.equal(fetched.length, 1);
  assert.equal(stored().length, before, 'the copy is gone again');
});

test('a message waits for the one before it that is still copying files, so Discord\'s order holds', async () => {
  const order = [];
  let release;
  hold = new Promise((resolve) => { release = resolve; });
  const relay = (m) => { order.push(m.id); };
  inbound({ id: 'a', channel_id: '100', type: 0, content: '', attachments: [{ url: `${CDN}slow.png?ex=1` }] }, relay);
  const last = inbound({ id: 'b', channel_id: '100', type: 0, content: 'hi', attachments: [] }, relay);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(order, [], 'neither is in Haven while the first one is still being copied');
  release();
  await last;
  hold = null;
  assert.deepEqual(order, ['a', 'b']);
  assert.equal(inbound({ id: 'c', channel_id: '100', type: 0, content: 'now', attachments: [] }, relay), undefined, 'with nothing waiting a plain message goes straight through');
  assert.deepEqual(order, ['a', 'b', 'c']);
});
