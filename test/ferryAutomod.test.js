'use strict';

// Ferry relays Discord attachments as cdn.discordapp.com links that it builds
// itself out of Discord's API response. Those hosts are not on Haven's default
// automod allowlist, so when the whole relayed string was fed to the link
// filter, a stock server threw away every Discord message carrying an image,
// the author's text along with it. Only the authored half is filtered now.
//
// The main ferry test file exercises buildHavenContent with automod effectively
// off, because there is no database behind it in a unit test and the module
// short-circuits to { ok: true }. That is why the bug got through, so this file
// loads ferry with a stubbed automod that is switched ON and carrying the real
// seeded allowlist from src/database.js.

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const Module = require('node:module');

const rules = require('../public/js/automod-rules.js');

// The starter allowlist seeded into every new server, copied from src/database.js.
const SEEDED = [
  'youtube.com', 'youtu.be', 'twitch.tv', 'x.com', 'twitter.com', 'bsky.app',
  'reddit.com', 'github.com', 'gitlab.com', 'stackoverflow.com', 'wikipedia.org',
  'imgur.com', 'giphy.com', 'tenor.com', 'spotify.com', 'soundcloud.com',
  'steamcommunity.com', 'steampowered.com', 'last.fm', 'archive.org',
];

const POLICY = {
  mode: 'allowlist',
  allow: SEEDED.map(domain => ({ domain, includeSubdomains: true })),
  deny: [],
  blockIpUrls: true,
  blockPunycode: true,
  blockObfuscated: true,
};

// Stand in for src/automod.js before ferry pulls it in, so this file measures
// the filtering decision rather than the database.
const automodPath = require.resolve('../src/automod.js');
require.cache[automodPath] = {
  id: automodPath,
  filename: automodPath,
  loaded: true,
  paths: Module._nodeModulePaths(path.dirname(automodPath)),
  exports: {
    checkText(text) {
      const hit = rules.checkText(text, POLICY);
      return hit ? { ok: false, rule: hit.rule, host: hit.host } : { ok: true };
    },
  },
};

const { buildHavenContent } = require('../src/ferry');

const ATTACHMENT = 'https://cdn.discordapp.com/attachments/1178/8830/photo.png?ex=68b0&is=68af&hm=abcd&';

test('the allowlist really does reject Discord CDN links', () => {
  // If this ever stops being true the rest of the file proves nothing.
  assert.ok(rules.checkText(ATTACHMENT, POLICY), 'expected the stock allowlist to block cdn.discordapp.com');
});

test('a Discord image survives automod and keeps the text next to it', () => {
  const out = buildHavenContent({
    content: 'look at this',
    attachments: [{ url: ATTACHMENT }],
  });
  assert.equal(out, `look at this\n${ATTACHMENT}`);
});

test('an image-only Discord message is not silently dropped', () => {
  assert.equal(buildHavenContent({ content: '', attachments: [{ url: ATTACHMENT }] }), ATTACHMENT);
});

test('Discord stickers relay too', () => {
  const out = buildHavenContent({ content: '', sticker_items: [{ id: '123' }] });
  assert.equal(out, 'https://media.discordapp.net/stickers/123.png');
});

test('a blocked link the Discord user typed is still filtered out', () => {
  // The protection this whole check exists for has to keep working: a domain
  // somebody typed is not the same as a URL Ferry built.
  assert.equal(buildHavenContent({ content: 'free stuff https://totally-not-spam.example/x' }), '');
  // And it stays blocked even when an attachment rides along with it.
  assert.equal(
    buildHavenContent({
      content: 'free stuff https://totally-not-spam.example/x',
      attachments: [{ url: ATTACHMENT }],
    }),
    ''
  );
});

test('an allowed domain the user typed still passes', () => {
  assert.equal(
    buildHavenContent({ content: 'clip https://www.youtube.com/watch?v=abc' }),
    'clip https://www.youtube.com/watch?v=abc'
  );
});

test('a promoted stream link is kept when the allowlist permits it', () => {
  const out = buildHavenContent({
    content: '@everyone Streamer is live!',
    embeds: [{
      type: 'rich',
      title: 'Streamer on Twitch',
      url: 'https://www.twitch.tv/streamer',
      image: { url: 'https://static-cdn.jtvnw.net/previews-ttv/live_user_streamer-1280x720.jpg' },
    }],
  });
  assert.equal(
    out,
    '@everyone Streamer is live!\nStreamer on Twitch https://www.twitch.tv/streamer\nhttps://static-cdn.jtvnw.net/previews-ttv/live_user_streamer-1280x720.jpg'
  );
});

test('a promoted link off the allowlist drops just the link, not the announcement', () => {
  // kick.com is not in the starter allowlist. The old path would have fed the
  // link through with the text and lost the whole message.
  const out = buildHavenContent({
    content: '@everyone Streamer is live on Kick!',
    embeds: [{
      type: 'rich',
      title: 'Streamer on Kick',
      url: 'https://kick.com/streamer',
      image: { url: 'https://images.kick.com/video_thumbnails/streamer/720.webp' },
    }],
  });
  assert.equal(
    out,
    '@everyone Streamer is live on Kick!\nStreamer on Kick\nhttps://images.kick.com/video_thumbnails/streamer/720.webp'
  );
});
