'use strict';

// Pictures and files in a message from Discord are copied into Haven's uploads
// as it arrives (#29533): Discord's signed links stop working after about a
// day, so a link would turn into a broken picture.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

process.env.HAVEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-ferryfiles-'));
const { UPLOADS_DIR } = require('../src/paths');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
const privacyPassPath = require.resolve('../src/privacyPass');
require.cache[privacyPassPath] = {
  id: privacyPassPath, filename: privacyPassPath, loaded: true,
  exports: { admitFile: async (tmp, rel) => { const dest = path.join(UPLOADS_DIR, rel); fs.renameSync(tmp, dest); return { size: fs.statSync(dest).size }; } },
};
const { buildHavenContent, keepFiles, inbound } = require('../src/ferry');

const CDN = 'https://cdn.discordapp.com/attachments/1/2/';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const fetched = [];
const realFetch = global.fetch;
let hold = null;
global.fetch = async (url) => {
  fetched.push(String(url));
  if (hold && String(url).includes('slow')) await hold;
  if (String(url).includes('gone')) return new Response('expired', { status: 404 });
  const body = String(url).includes('.png') ? PNG : Buffer.from('%PDF-1.4 hello');
  return new Response(body, { status: 200, headers: { 'content-length': String(body.length) } });
};
test.after(() => { global.fetch = realFetch; fs.rmSync(process.env.HAVEN_DATA_DIR, { recursive: true, force: true }); });
test.beforeEach(() => { fetched.length = 0; });

test('a picture and a file sent from Discord become Haven uploads', async () => {
  const msg = { content: 'look', attachments: [{ url: `${CDN}cat.png?ex=1&hm=a` }, { url: `${CDN}notes.pdf?ex=1&hm=a` }] };
  assert.match(buildHavenContent(msg), /cdn\.discordapp\.com/, 'a link until the files are copied');
  await keepFiles(msg, null);
  const lines = buildHavenContent(msg).split('\n');
  assert.equal(lines[0], 'look');
  assert.match(lines[1], /^\/uploads\/\d+-[0-9a-f]{16}\.png$/);
  assert.match(lines[2], /^\[file:notes\.pdf\]\(\/uploads\/\d+-[0-9a-f]{16}\.pdf\|\d+ B\)$/);
  assert.ok(fs.existsSync(path.join(UPLOADS_DIR, lines[1].slice('/uploads/'.length))), 'the picture is stored');
});

test('a picture that cannot be copied stays the Discord link', async () => {
  const msg = { content: '', attachments: [{ url: `${CDN}gone.png?ex=1` }, { url: `${CDN}cat.png?ex=1` }] };
  await keepFiles(msg, null);
  const lines = buildHavenContent(msg).split('\n');
  assert.equal(lines[0], `${CDN}gone.png?ex=1`);
  assert.match(lines[1], /^\/uploads\//);
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

test('a message waits for the one before it that is still copying files, so Discord\'s order holds', async () => {
  const order = [];
  let release;
  hold = new Promise((resolve) => { release = resolve; });
  const relay = (m) => { order.push(m.id); };
  inbound({ id: 'a', content: '', attachments: [{ url: `${CDN}slow.png?ex=1` }] }, relay);
  const last = inbound({ id: 'b', content: 'hi', attachments: [] }, relay);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(order, [], 'neither is in Haven while the first one is still being copied');
  release();
  await last;
  hold = null;
  assert.deepEqual(order, ['a', 'b']);
  assert.equal(inbound({ id: 'c', content: 'now', attachments: [] }, relay), undefined, 'with nothing waiting a plain message goes straight through');
  assert.deepEqual(order, ['a', 'b', 'c']);
});
