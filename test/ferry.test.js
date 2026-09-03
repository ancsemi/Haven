'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  resolveFerryTarget,
  sanitizeWebhookUsername,
  buildHavenContent,
  discordAvatarUrl,
} = require('../src/ferry');

// Two pairings on one Haven channel, one of them sharing a channel name with
// the other so the guild-qualified form is the only way to tell them apart.
const LINKS = [
  { id: 1, guild_name: 'My Server',    discord_channel_name: 'general', out_mode: 'command' },
  { id: 2, guild_name: 'Other Server', discord_channel_name: 'general', out_mode: 'all' },
  { id: 3, guild_name: 'My Server',    discord_channel_name: 'dev',     out_mode: 'command' },
];

const base = { trigger: '=>', links: LINKS, allowDms: false, dmUserId: null };

test('a message with no trigger is not addressed', () => {
  assert.equal(resolveFerryTarget({ ...base, content: 'just talking' }), null);
  // A lone ">" is Haven's blockquote marker and must not be mistaken for one.
  assert.equal(resolveFerryTarget({ ...base, content: '> quoted text' }), null);
});

test('guild-qualified target resolves and is stripped from the body', () => {
  const r = resolveFerryTarget({ ...base, content: '=>My Server#general hello there' });
  assert.equal(r.link.id, 1);
  assert.equal(r.body, 'hello there');
});

test('a guild name containing spaces matches in full', () => {
  const r = resolveFerryTarget({ ...base, content: '=>Other Server#general hi' });
  assert.equal(r.link.id, 2);
  assert.equal(r.body, 'hi');
});

test('the bare #channel form resolves when it is unambiguous', () => {
  const r = resolveFerryTarget({ ...base, content: '=>#dev shipping now' });
  assert.equal(r.link.id, 3);
  assert.equal(r.body, 'shipping now');
});

test('longest label wins, so the qualified form is never shadowed', () => {
  // "#general" is also a valid label, but "Other Server#general" is longer and
  // must be preferred or the message would silently go to the wrong server.
  const r = resolveFerryTarget({ ...base, content: '=>Other Server#general x' });
  assert.equal(r.link.id, 2);
});

test('matching is case insensitive but the body keeps its original case', () => {
  const r = resolveFerryTarget({ ...base, content: '=>my server#GENERAL Hello World' });
  assert.equal(r.link.id, 1);
  assert.equal(r.body, 'Hello World');
});

test('an unknown target does not resolve, so the prefix stays visible', () => {
  assert.equal(resolveFerryTarget({ ...base, content: '=>Nope#nowhere hi' }), null);
});

test('a target with no message body resolves to an empty body', () => {
  const r = resolveFerryTarget({ ...base, content: '=>My Server#dev' });
  assert.equal(r.link.id, 3);
  assert.equal(r.body, '');
});

test('a partial target does not resolve', () => {
  // "=>My Serv" is mid-autocomplete, not a destination.
  assert.equal(resolveFerryTarget({ ...base, content: '=>My Serv hello' }), null);
});

test('DMs need both the server setting and a resolved Discord user id', () => {
  const content = '=>@Alice hey';
  assert.equal(resolveFerryTarget({ ...base, content }), null, 'DMs off');
  assert.equal(resolveFerryTarget({ ...base, allowDms: true, content }), null, 'no user id');

  const r = resolveFerryTarget({ ...base, allowDms: true, dmUserId: '123456789012345678', content });
  assert.equal(r.dm, true);
  assert.equal(r.discordUserId, '123456789012345678');
  assert.equal(r.body, 'hey');
});

test('a malformed Discord user id is refused before it can reach the API', () => {
  // The id comes from the client. Anything that is not a snowflake must not
  // reach a Discord request path or body.
  const dm = { ...base, allowDms: true, content: '=>@Alice hey' };
  for (const bad of ['../../channels/1', '123', 'abc', '1'.repeat(30), '12345678901234567890abc', '']) {
    assert.equal(resolveFerryTarget({ ...dm, dmUserId: bad }), null, `accepted ${bad}`);
  }
  assert.equal(resolveFerryTarget({ ...dm, dmUserId: { toString: () => '123456789012345678' } }), null,
    'a non-string id must not be coerced into an API call');
  assert.equal(resolveFerryTarget({ ...dm, dmUserId: '123456789012345678' }).discordUserId, '123456789012345678');
});

test('Discord mentions become readable names', () => {
  // Discord writes mentions as <@id>. Relayed raw a Haven reader sees a bare
  // number, so the names come from the message's own resolved mentions list.
  const msg = {
    content: 'hey <@111111111111111111> and <@!222222222222222222>',
    mentions: [
      { id: '111111111111111111', username: 'alice', global_name: 'Alice' },
      { id: '222222222222222222', username: 'bob' },
    ],
  };
  assert.equal(buildHavenContent(msg), 'hey @Alice and @bob');

  // An id with nobody attached is left alone rather than guessed at.
  assert.equal(
    buildHavenContent({ content: 'ping <@999999999999999999>', mentions: [] }),
    'ping <@999999999999999999>'
  );
});

test('an image bot embed relays the picture instead of a link to unfurl', () => {
  // The SaucyBot shape: no body, the picture in embed.image, the source page in
  // embed.url. Relaying the summary alone left Haven a link to preview, which is
  // the path that dies in bulk. (#5426-adjacent, reported against Ferry)
  const saucy = {
    content: '',
    embeds: [{
      title: 'Sonic and Amy',
      url: 'https://www.pixiv.net/artworks/12345678',
      description: 'by someone',
      image: { url: 'https://i.pximg.net/img-master/img/12345678_p0.jpg' },
    }],
  };
  const out = buildHavenContent(saucy);
  // The image is carried so Haven renders it as a chat image.
  assert.ok(out.includes('https://i.pximg.net/img-master/img/12345678_p0.jpg'));
  // The source link is dropped, because that is the thing that would be unfurled.
  assert.ok(!out.includes('pixiv.net/artworks'));
  // The readable parts survive as context.
  assert.ok(out.includes('Sonic and Amy'));

  // A thumbnail-only embed is still an image.
  assert.ok(buildHavenContent({
    content: '',
    embeds: [{ thumbnail: { url: 'https://example.test/thumb.png' } }],
  }).includes('https://example.test/thumb.png'));

  // Multi-image posts carry every picture, not just the first.
  const multi = buildHavenContent({
    content: '',
    embeds: [
      { image: { url: 'https://example.test/a.png' } },
      { image: { url: 'https://example.test/b.png' } },
    ],
  });
  assert.ok(multi.includes('a.png') && multi.includes('b.png'));

  // An embed with no image at all keeps the old summary, link included, so a
  // plain shared link still relays as before.
  const linkOnly = buildHavenContent({
    content: '',
    embeds: [{ title: 'A page', url: 'https://example.test/page', description: 'about things' }],
  });
  assert.ok(linkOnly.includes('https://example.test/page'));

  // A message the author actually typed is untouched by any of this.
  assert.equal(
    buildHavenContent({ content: 'hello', embeds: [{ image: { url: 'https://example.test/x.png' } }] }),
    'hello'
  );
});

test('a stream announcement bot relays its link and thumbnail next to the text', () => {
  // The CouchBot / stream-notifier shape: the bot types the ping line and puts
  // everything worth having (stream link, title, thumbnail) in a rich embed.
  // Reading the embed only for empty bodies relayed the ping line alone.
  const live = {
    content: '@everyone Streamer is now live!',
    embeds: [{
      type: 'rich',
      title: 'Streamer is playing Spira Speedruns',
      url: 'https://www.twitch.tv/streamer',
      description: 'Come hang out',
      image: { url: 'https://static-cdn.jtvnw.net/previews-ttv/live_user_streamer-1280x720.jpg' },
    }],
  };
  const out = buildHavenContent(live);
  assert.ok(out.startsWith('@everyone Streamer is now live!'));
  assert.ok(out.includes('https://www.twitch.tv/streamer'));
  assert.ok(out.includes('Streamer is playing Spira Speedruns'));
  assert.ok(out.includes('https://static-cdn.jtvnw.net/previews-ttv/live_user_streamer-1280x720.jpg'));

  // Thumbnail-shaped previews (YouTube, Kick) count as the picture too.
  const video = buildHavenContent({
    content: 'New upload!',
    embeds: [{
      type: 'rich',
      url: 'https://www.youtube.com/watch?v=abc123',
      thumbnail: { url: 'https://i.ytimg.com/vi/abc123/maxresdefault.jpg' },
    }],
  });
  assert.ok(video.includes('https://www.youtube.com/watch?v=abc123'));
  assert.ok(video.includes('https://i.ytimg.com/vi/abc123/maxresdefault.jpg'));

  // A bot that already typed the link does not get it twice.
  const typed = buildHavenContent({
    content: 'Live now https://kick.com/streamer',
    embeds: [{ type: 'rich', url: 'https://kick.com/streamer', title: 'Live now' }],
  });
  assert.equal(typed, 'Live now https://kick.com/streamer');

  // Discord's own unfurl of a typed link is still ignored, or Haven would
  // unfurl the same link a second time.
  assert.equal(
    buildHavenContent({
      content: 'watch https://www.youtube.com/watch?v=abc123',
      embeds: [{ type: 'video', url: 'https://www.youtube.com/watch?v=abc123', thumbnail: { url: 'https://i.ytimg.com/vi/abc123/hq.jpg' } }],
    }),
    'watch https://www.youtube.com/watch?v=abc123'
  );
});

test('Discord custom emotes become readable shortcodes', () => {
  // Relayed raw these read as "<:blue_heart:1178833036244652178>" mid-sentence.
  assert.equal(buildHavenContent({ content: 'hi <:wave:1178833036244652178> there' }), 'hi :wave: there');
  assert.equal(buildHavenContent({ content: '<a:spin:1178833036244652178>' }), ':spin:');
  // A lone angle-bracket expression that is not an emote is left alone.
  assert.equal(buildHavenContent({ content: 'a < b and c > d' }), 'a < b and c > d');
  // No mentions array means nothing to resolve it against, so it stays put.
  assert.equal(buildHavenContent({ content: '<@1178833036244652178>' }), '<@1178833036244652178>');
});

test('a custom trigger is honored and the default is not', () => {
  const custom = { ...base, trigger: '>>' };
  assert.equal(resolveFerryTarget({ ...custom, content: '=>My Server#dev hi' }), null);
  assert.equal(resolveFerryTarget({ ...custom, content: '>>My Server#dev hi' }).link.id, 3);
});

test('webhook usernames are repaired rather than rejected by Discord', () => {
  // Discord 400s on webhook usernames containing "discord" or "clyde", which
  // would fail the whole send rather than just the name.
  assert.doesNotMatch(sanitizeWebhookUsername('discord fan'), /discord/i);
  assert.doesNotMatch(sanitizeWebhookUsername('CLYDE'), /clyde/i);
  // Newlines would break out of the JSON field's intent; length is capped at 80.
  assert.doesNotMatch(sanitizeWebhookUsername('two\nlines'), /\n/);
  assert.equal(sanitizeWebhookUsername('x'.repeat(200)).length, 80);
  assert.equal(sanitizeWebhookUsername(''), 'Haven user');
  assert.equal(sanitizeWebhookUsername(null), 'Haven user');
});

test('inbound Discord messages flatten text, attachments and stickers', () => {
  assert.equal(buildHavenContent({ content: 'hello' }), 'hello');

  const withFile = buildHavenContent({
    content: 'look',
    attachments: [{ url: 'https://cdn.discordapp.com/a.png' }],
  });
  assert.equal(withFile, 'look\nhttps://cdn.discordapp.com/a.png');

  // An attachment-only message must still relay something.
  assert.equal(
    buildHavenContent({ content: '', attachments: [{ url: 'https://cdn.discordapp.com/b.png' }] }),
    'https://cdn.discordapp.com/b.png'
  );

  // A link-only message arrives with an empty body and one embed.
  assert.match(
    buildHavenContent({ content: '', embeds: [{ title: 'A page', url: 'https://example.com' }] }),
    /A page/
  );

  // Nothing to say means nothing is relayed, rather than an empty row.
  assert.equal(buildHavenContent({ content: '   ' }), '');
});

test('avatar URLs cover custom, animated, and both default schemes', () => {
  assert.match(
    discordAvatarUrl({ id: '80351110224678912', avatar: 'abc123' }),
    /avatars\/80351110224678912\/abc123\.png/
  );
  assert.match(
    discordAvatarUrl({ id: '80351110224678912', avatar: 'a_abc123' }),
    /\.gif/,
    'animated avatars must keep their extension or Discord serves a still'
  );
  // Post-migration accounts (discriminator "0") index by id, legacy ones by
  // discriminator. Getting this wrong yields a 404 image, not an error.
  assert.match(discordAvatarUrl({ id: '80351110224678912', discriminator: '0' }), /embed\/avatars\/[0-5]\.png/);
  assert.match(discordAvatarUrl({ id: '80351110224678912', discriminator: '1234' }), /embed\/avatars\/[0-4]\.png/);
  assert.equal(discordAvatarUrl(null), null);
});
