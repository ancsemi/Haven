'use strict';

// Copying a Discord import's pictures and files into Haven (#5811).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

process.env.HAVEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-importfiles-'));
const { UPLOADS_DIR } = require('../src/paths');
const { copyAttachments, isDiscordFile } = require('../src/importFiles');

fs.mkdirSync(UPLOADS_DIR, { recursive: true });
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const CDN = 'https://cdn.discordapp.com/attachments/1/2/';

const fetched = [];
const fakeFetch = async (url) => {
  fetched.push(url);
  if (url.includes('gone')) return new Response('expired', { status: 404 });
  if (url.includes('huge')) return new Response(Buffer.alloc(2048), { status: 200, headers: { 'content-length': '2048' } });
  if (url.includes('sneaky')) return new Response(Buffer.alloc(4096), { status: 200 }); // no length given
  const body = url.includes('.png') ? PNG : Buffer.from('%PDF-1.4 hello');
  return new Response(body, { status: 200, headers: { 'content-length': String(body.length) } });
};
// The privacy pass is tested on its own; here it only has to move the file in.
const admit = async (tmp, rel) => {
  const dest = path.join(UPLOADS_DIR, rel);
  fs.renameSync(tmp, dest);
  return { size: fs.statSync(dest).size };
};
const opts = (state = {}) => ({ capBytes: 1024, state, fetchImpl: fakeFetch, admit });

test('only Discord file links count', () => {
  assert.equal(isDiscordFile(CDN + 'cat.png?ex=1'), true);
  assert.equal(isDiscordFile('https://media.discordapp.net/attachments/1/2/cat.png'), true);
  assert.equal(isDiscordFile('https://cdn.discordapp.com/avatars/1/2.png'), false);
  assert.equal(isDiscordFile('http://cdn.discordapp.com/attachments/1/2/cat.png'), false);
  assert.equal(isDiscordFile('https://127.0.0.1/attachments/x.png'), false);
  assert.equal(isDiscordFile('not a link'), false);
});

test('a picture becomes a stored picture, a file a file line', async () => {
  const state = {};
  const out = await copyAttachments(`look\n📎 [cat.png](${CDN}cat.png?ex=1)\n📎 [notes.pdf](${CDN}notes.pdf)`, opts(state));
  const [text, pic, file] = out.split('\n');
  assert.equal(text, 'look');
  assert.match(pic, /^\/uploads\/\d+-[0-9a-f]{16}\.png$/);
  assert.ok(fs.existsSync(path.join(UPLOADS_DIR, path.basename(pic))));
  assert.match(file, /^\[file:notes\.pdf\]\(\/uploads\/\d+-[0-9a-f]{16}\.pdf\|14 B\)$/);
  assert.equal(state.copied, 2);
});

test('links anywhere else are never fetched', async () => {
  fetched.length = 0;
  const line = '📎 [x.png](https://192.168.1.10/attachments/x.png)';
  assert.equal(await copyAttachments(line, opts()), line);
  assert.equal(fetched.length, 0);
});

test('expired, too large or growing past the limit: the link stays', async () => {
  const state = {};
  const lines = [`📎 [a.png](${CDN}gone.png)`, `📎 [b.png](${CDN}huge.png)`, `📎 [c.png](${CDN}sneaky.png)`];
  assert.equal(await copyAttachments(lines.join('\n'), opts(state)), lines.join('\n'));
  assert.equal(state.skipped, 3);
  assert.equal(state.copied, undefined);
  assert.deepEqual(fs.readdirSync(path.join(process.env.HAVEN_DATA_DIR, 'unprocessed')).filter(f => f.startsWith('import-')), [], 'no half-written files left behind');
});

test('a forward keeps its quote, the file goes under it', async () => {
  const out = await copyAttachments(`> *Forwarded*\n> look\n📎 [cat.png](${CDN}cat.png)`, opts());
  assert.match(out, /^> \*Forwarded\*\n> look\n\/uploads\/\S+\.png$/);
});

test.after(() => fs.rmSync(process.env.HAVEN_DATA_DIR, { recursive: true, force: true }));
