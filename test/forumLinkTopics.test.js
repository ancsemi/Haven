'use strict';

/**
 * A forum topic that is only a link (#5745): the card takes the link's title
 * and picture from its preview, and the open topic gets the same player or
 * link card the post gets in chat.
 *
 *   node --test test/forumLinkTopics.test.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const { youTubeVideoId } = require('../src/youtubeLink');

const ROOT = path.join(__dirname, '..');
const forumPath = path.join(ROOT, 'public', 'js', 'modules', 'app-forum.js');
const forumSrc = fs.readFileSync(forumPath, 'utf8');
const routeSrc = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'link-preview.js'), 'utf8');

const VIDEO = 'https://www.youtube.com/watch?v=oDfMotCtS6M';
let F;
test.before(async () => {
  const mod = (await import(pathToFileURL(forumPath).href)).default;
  globalThis.t = globalThis.t || ((k) => k);
  F = () => Object.assign({}, mod, {
    _isImageUrl: (u) => /\.(png|jpe?g|gif|webp)(\?.*)?$/i.test(u),
  });
});

test('the lead link is a first line that is only a link', () => {
  const f = F();
  assert.equal(f._forumLeadLinkOf({ content: VIDEO }), VIDEO);
  assert.equal(f._forumLeadLinkOf({ content: `  ${VIDEO}  \nmore words` }), VIDEO);
  assert.equal(f._forumLeadLinkOf({ content: `watch this ${VIDEO}` }), null);
  assert.equal(f._forumLeadLinkOf({ content: 'Just words' }), null);
  assert.equal(f._forumLeadLinkOf({ content: `https://x.test/a.png\n${VIDEO}` }), VIDEO, 'a picture line is skipped');
  assert.equal(f._forumLeadLinkOf({ content: `||${VIDEO}||` }), null, 'a spoilered link is left alone');
});

test('a link-only topic is titled after its preview once it is in', () => {
  const f = F();
  assert.equal(f._forumTitleOf({ content: VIDEO }), VIDEO, 'the link until the preview arrives');
  f._forumLinkMeta = new Map([[VIDEO, { title: 'A lil VOTV before bed', image: 'https://i.ytimg.com/vi/oDfMotCtS6M/hqdefault.jpg' }]]);
  assert.equal(f._forumTitleOf({ content: VIDEO }), 'A lil VOTV before bed');
  assert.equal(f._forumTitleOf({ title: 'My own title', content: VIDEO }), 'My own title', 'a typed title wins');
  assert.equal(f._forumSnippetOf({ content: VIDEO }), '', 'no snippet repeats the link');
});

test('the card picture is a posted image first, then the link preview image', () => {
  const f = F();
  assert.equal(f._forumThumbOf({ content: VIDEO }), null);
  f._forumLinkMeta = new Map([[VIDEO, { title: 'x', image: 'https://i.ytimg.com/vi/oDfMotCtS6M/hqdefault.jpg' }]]);
  assert.equal(f._forumThumbOf({ content: VIDEO }), 'https://i.ytimg.com/vi/oDfMotCtS6M/hqdefault.jpg');
  assert.equal(f._forumThumbOf({ title: 'Titled', content: VIDEO }), 'https://i.ytimg.com/vi/oDfMotCtS6M/hqdefault.jpg');
  assert.equal(f._forumThumbOf({ content: `${VIDEO}\nhttps://x.test/own.png` }), 'https://x.test/own.png');
  f._forumLinkMeta = new Map([[VIDEO, { title: 'x', image: 'javascript:alert(1)' }]]);
  assert.equal(f._forumThumbOf({ content: VIDEO }), null, 'only web addresses become pictures');
});

test('the preview of a lead link is asked for once and remembered', async () => {
  const f = F();
  let calls = 0;
  f._forumTopics = new Map();
  f._linkPreviewData = async () => { calls++; return { title: 'Video', image: 'https://i.ytimg.com/vi/oDfMotCtS6M/hqdefault.jpg' }; };
  f._forumLoadLinkPreview({ id: 1, content: VIDEO });
  f._forumLoadLinkPreview({ id: 2, content: VIDEO });
  await new Promise(r => setImmediate(r));
  assert.equal(calls, 1);
  assert.equal(f._forumTitleOf({ content: VIDEO }), 'Video');
  f._forumLoadLinkPreview({ id: 3, content: 'no link here' });
  assert.equal(calls, 1);
});

test('cards and the open topic use the proxy and the chat link cards', () => {
  assert.match(forumSrc, /this\._lazySrcAttr\(this\._imgSrcAttr\(thumb\)\)/, 'card picture goes through the media proxy');
  assert.match(forumSrc, /thread-forum-thumb"><img \$\{this\._imgSrcAttr\(thumb\)\}/, 'topic header picture goes through the media proxy');
  assert.match(forumSrc, /this\._forumLoadLinkPreview\(msg\);/);
  assert.match(forumSrc, /container\.prepend\(body\);\s*\/\/[^\n]*\n\s*this\._fetchLinkPreviews\?\.\(body\);/);
});

test('the server reads YouTube links and asks oEmbed for their title and thumbnail', () => {
  assert.equal(youTubeVideoId(VIDEO), 'oDfMotCtS6M');
  assert.equal(youTubeVideoId('https://youtu.be/oDfMotCtS6M?t=30'), 'oDfMotCtS6M');
  assert.equal(youTubeVideoId('https://m.youtube.com/shorts/oDfMotCtS6M'), 'oDfMotCtS6M');
  assert.equal(youTubeVideoId('https://music.youtube.com/watch?v=oDfMotCtS6M&list=x'), 'oDfMotCtS6M');
  assert.equal(youTubeVideoId('https://www.youtube.com/live/oDfMotCtS6M'), 'oDfMotCtS6M');
  assert.equal(youTubeVideoId('https://example.com/watch?v=oDfMotCtS6M'), null);
  assert.equal(youTubeVideoId('https://www.youtube.com/watch?v=short'), null);
  assert.equal(youTubeVideoId('not a link'), null);
  assert.match(routeSrc, /https:\/\/www\.youtube\.com\/oembed\?url=/);
});
