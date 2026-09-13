'use strict';

/**
 * Plant a small crowd so empty rooms look like people live here.
 * Run again to wipe the last plant and rewrite it.
 *
 *   node scripts/seedDemoBots.js
 */

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const { DB_PATH } = require('../src/paths');

const BIO = 'demo-seed';

const PEOPLE = [
  { u: 'mira', d: 'mira', seed: 'mira-night', shape: 'circle', text: 'up too late' },
  { u: 'jules', d: 'Jules', seed: 'jules-ok', shape: 'circle', text: '' },
  { u: 'theo', d: 'theo', seed: 'theo-ask', shape: 'circle', text: '' },
  { u: 'nico', d: 'Nico', seed: 'nico-voice', shape: 'squircle', text: 'in call maybe' },
  { u: 'reed', d: 'reed', seed: null, shape: 'circle', text: '' },
  { u: 'kira', d: 'kira', seed: 'kira-cam', shape: 'circle', text: '' },
  { u: 'oz', d: 'Oz', seed: 'oz-essay', shape: 'circle', text: 'reading' },
  { u: 'bee', d: 'Bee', seed: 'bee-hype', shape: 'circle', text: '' },
  { u: 'cass', d: 'cass', seed: 'cass-mod', shape: 'circle', text: '' },
  { u: 'vin', d: 'vin', seed: 'vin-css', shape: 'circle', text: 'moving pixels' },
  { u: 'lark', d: 'lark', seed: 'lark-fm', shape: 'circle', text: 'something on' },
  { u: 'june', d: 'June', seed: 'june-new', shape: 'circle', text: 'new here' },
  { u: 'piotr', d: 'Piotr', seed: 'piotr-ok', shape: 'circle', text: '' },
  { u: 'ash', d: 'ash', seed: null, shape: 'circle', text: '' },
];

function avatar(seed) {
  return `https://api.dicebear.com/9.x/adventurer/svg?seed=${encodeURIComponent(seed)}`;
}

function hasCol(db, table, name) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === name);
}

function ensureForumCols(db) {
  for (const col of [
    { name: 'topic_kind', sql: 'ALTER TABLE messages ADD COLUMN topic_kind TEXT DEFAULT NULL' },
    { name: 'subtasks', sql: 'ALTER TABLE messages ADD COLUMN subtasks TEXT DEFAULT NULL' },
  ]) {
    if (!hasCol(db, 'messages', col.name)) db.exec(col.sql);
  }
}

function stamp(hoursAgo) {
  const d = new Date(Date.now() - hoursAgo * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

function wipe(db) {
  db.prepare("DELETE FROM messages WHERE imported_from = 'demo-bots'").run();
  const old = db.prepare('SELECT id FROM users WHERE bio = ?').all(BIO);
  if (old.length) {
    const ids = old.map((r) => r.id);
    db.prepare(`DELETE FROM users WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
  }
}

function ensurePeople(db) {
  const hash = bcrypt.hashSync(crypto.randomBytes(24).toString('hex'), 4);
  const insert = db.prepare(`
    INSERT INTO users (username, password_hash, is_admin, display_name, avatar, avatar_shape, bio, status, status_text, created_at)
    VALUES (?, ?, 0, ?, ?, ?, ?, 'invisible', ?, ?)
  `);
  const join = db.prepare('INSERT OR IGNORE INTO channel_members (channel_id, user_id) VALUES (?, ?)');
  const grant = db.prepare('INSERT OR IGNORE INTO user_roles (user_id, role_id, channel_id) VALUES (?, ?, NULL)');
  const channels = db.prepare('SELECT id FROM channels WHERE COALESCE(is_dm, 0) = 0').all();
  const roles = db.prepare("SELECT id FROM roles WHERE auto_assign = 1 AND scope = 'server'").all();
  const people = {};
  PEOPLE.forEach((p, i) => {
    const created = stamp(720 - i * 18);
    const id = Number(insert.run(
      p.u,
      hash,
      p.d,
      p.seed ? avatar(p.seed) : null,
      p.shape,
      BIO,
      p.text,
      created
    ).lastInsertRowid);
    for (const ch of channels) join.run(ch.id, id);
    for (const role of roles) grant.run(id, role.id);
    people[p.u] = { id, name: p.d };
  });
  return people;
}

function seedDemoBotChats(db) {
  ensureForumCols(db);
  wipe(db);
  const canKind = hasCol(db, 'messages', 'topic_kind');
  const canSub = hasCol(db, 'messages', 'subtasks');
  const people = ensurePeople(db);

  const insert = db.prepare(`
    INSERT INTO messages (
      channel_id, user_id, content, created_at, reply_to, thread_id, title, tags, request_status
      ${canKind ? ', topic_kind' : ''} ${canSub ? ', subtasks' : ''}
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?
      ${canKind ? ', ?' : ''} ${canSub ? ', ?' : ''})
  `);
  const react = db.prepare('INSERT OR IGNORE INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?)');

  const post = (channelId, who, content, hoursAgo, extra = {}) => {
    const args = [
      channelId,
      who.id,
      content,
      stamp(hoursAgo),
      extra.replyTo || null,
      extra.threadId || null,
      extra.title || null,
      extra.tags ? JSON.stringify(extra.tags) : null,
      extra.status || null,
    ];
    if (canKind) args.push(extra.kind || null);
    if (canSub) args.push(extra.subtasks ? JSON.stringify(extra.subtasks) : null);
    return Number(insert.run(...args).lastInsertRowid);
  };

  const channels = db.prepare(`
    SELECT id, name, is_forum FROM channels WHERE COALESCE(is_dm, 0) = 0 ORDER BY id
  `).all();

  let planted = 0;
  const tx = db.transaction(() => {
    for (const ch of channels) {
      const name = (ch.name || '').toLowerCase();
      if (ch.is_forum) planted += name.includes('show') ? showcase(db, ch, people, post, react) : requests(db, ch, people, post, react);
      else if (name === 'general') planted += general(ch, people, post, react);
      else if (name === '1') planted += room1(ch, people, post, react);
      else if (name === '2') planted += room2(ch, people, post, react);
      else if (name === '3') planted += room3(ch, people, post, react);
      else planted += leftover(ch, people, post);
    }
  });
  tx();
  return { planted, people: Object.keys(people).length };
}

function play(lines, post, react) {
  const ids = [];
  let n = 0;
  for (const line of lines) {
    const [who, content, hours, extra] = line;
    const id = post(who, content, hours, extra || {});
    ids.push(id);
    n += 1;
    if (extra && extra.react) {
      for (const [person, emoji] of extra.react) react.run(id, person.id, emoji);
    }
  }
  return n;
}

function general(ch, p, post0, react) {
  const post = (who, content, hours, extra) => post0(ch.id, who, content, hours, extra);
  return play([
    [p.bee, 'anyone up', 97.2],
    [p.nico, 'yeah', 97.15],
    [p.mira, 'barely', 97.1],
    [p.bee, 'this place feels dead tonight', 97.05],
    [p.jules, 'half of you are in #2 typing the word test', 96.9, { react: [[p.reed, '😂'], [p.ash, '💀']] }],
    [p.theo, 'wait what is #2', 96.8],
    [p.jules, 'the channel named 2', 96.78],
    [p.theo, 'who named these', 96.7],
    [p.cass, 'amni. don\'t', 96.65],
    [p.reed, 'lmao', 96.6],
    [p.nico, 'voice in like 10?', 96.4],
    [p.mira, 'can\'t, food', 96.35],
    [p.nico, 'ok nvm', 96.3],
    [p.lark, 'putting something on anyway', 96.1],
    [p.ash, '👍', 96.05],

    [p.vin, 'did the sidebar get smaller or am i losing it', 51.8],
    [p.kira, 'braid', 51.75],
    [p.vin, 'i turned it on and search is just gone', 51.7],
    [p.cass, 'bottom left. Menu', 51.65],
    [p.vin, 'oh', 51.6],
    [p.june, 'i have been looking for that for twenty minutes', 51.55, { react: [[p.jules, '😂'], [p.bee, '💀']] }],
    [p.jules, 'welcome', 51.5],
    [p.theo, 'the + next to CHANNELS is join/create/temp now too', 51.4],
    [p.bee, 'THE PLUS', 51.38],
    [p.oz, 'yeah they stuffed three things in one menu. i liked seeing them. whatever', 51.2],
    [p.reed, 'less junk', 51.15],
    [p.piotr, 'my window still has the old circles on top', 51.0],
    [p.cass, 'hard reload', 50.95],
    [p.piotr, 'ok that did it', 50.8],
    [p.kira, 'dumped a photo in showcase if anyone cares', 50.4],
    [p.bee, 'going', 50.2],
    [p.ash, 'later', 50.15],

    [p.mira, 'why is it 2am', 20.6],
    [p.reed, 'you\'re asking us?', 20.55],
    [p.mira, 'fair', 20.5],
    [p.nico, 'call just died', 20.3],
    [p.lark, 'yeah i dropped', 20.28],
    [p.nico, 'we were 4 and then it was me talking to nobody', 20.2],
    [p.cass, 'if it happens again tell me', 20.1],
    [p.nico, 'was probably the laptop. lid closed itself', 20.0],
    [p.ash, 'F', 19.95, { react: [[p.bee, '😂']] }],
    [p.june, 'is this the main room or is there another one i\'m supposed to be in', 19.4],
    [p.jules, 'this is it. 1 is junk. 3 is whenever nico wants a call', 19.3],
    [p.june, 'and requests is the board', 19.25],
    [p.jules, 'yeah', 19.22],
    [p.theo, 'i put something there about the webhook cap', 19.0],
    [p.oz, 'saw it. 30 a minute is miserable if you\'re dumping history', 18.8],
    [p.theo, 'that\'s what i hit', 18.7],

    [p.bee, 'morning', 6.4],
    [p.reed, 'hey', 6.35],
    [p.kira, 'is the dog pic still up', 6.1],
    [p.bee, 'yes go look', 6.05],
    [p.vin, 'the buttons next to the text box finally sit on the same line as menu', 4.8],
    [p.jules, 'they were floating higher than the sidebar it was making my eye twitch', 4.7],
    [p.vin, 'SAME', 4.65, { react: [[p.mira, '👍'], [p.ash, '🔥']] }],
    [p.nico, 'voice later? like 8', 3.2],
    [p.mira, 'maybe', 3.15],
    [p.piotr, 'i can', 3.1],
    [p.nico, 'cool', 3.05],
    [p.june, 'how do i join', 2.8],
    [p.cass, 'Join Voice, top right', 2.75],
    [p.june, 'got it', 2.7],
    [p.bee, 'ok i gotta run', 1.4],
    [p.jules, 'later', 1.35],
    [p.lark, 'i\'ll be around', 0.9],
    [p.reed, 'same', 0.8],
  ], post, react);
}

function room1(ch, p, post0, react) {
  const post = (who, content, hours, extra) => post0(ch.id, who, content, hours, extra);
  return play([
    [p.oz, 'parking this so i don\'t lose it', 80.4],
    [p.oz, 'wait that\'s the wrong notes', 80.35],
    [p.oz, 'ignore me', 80.3],
    [p.bee, 'this channel is a graveyard', 72.1],
    [p.reed, 'on purpose', 72.0],
    [p.kira, 'https://picsum.photos/id/28/640/400.jpg', 55.2],
    [p.bee, 'wrong room??', 55.1],
    [p.kira, 'i know', 55.05],
    [p.june, 'what is this one even for', 40.6],
    [p.jules, 'whatever you don\'t want in general', 40.5],
    [p.theo, 'so everything i say', 40.4, { react: [[p.jules, '😂'], [p.reed, '💀']] }],
    [p.jules, 'pretty much', 40.35],
    [p.piotr, 'i keep thinking 1 means first channel', 28.2],
    [p.cass, 'it does not', 28.1],
    [p.ash, 'lol', 28.05],
    [p.vin, 'pastebin energy', 12.4],
    [p.nico, 'yeah', 12.3],
    [p.mira, 'i dumped a grocery list in here last week and i\'m not sorry', 8.1],
    [p.reed, 'we know. milk was on it twice', 8.0],
    [p.mira, 'needed milk', 7.9],
  ], post, react);
}

function room2(ch, p, post0, react) {
  const post = (who, content, hours, extra) => post0(ch.id, who, content, hours, extra);
  return play([
    [p.jules, 'testest', 70.4, { react: [[p.bee, '😂'], [p.ash, '💀'], [p.reed, '😂']] }],
    [p.bee, 'lmao', 70.3],
    [p.reed, 'cinematic', 70.2],
    [p.theo, 'is this a bit', 69.8],
    [p.jules, 'amni left those two lines in august', 69.7],
    [p.nico, 'respect', 69.6],
    [p.june, 'should someone delete them', 48.2],
    [p.cass, 'leave it they\'re funny', 48.1],
    [p.vin, 'test then test again like he forgot he already sent it', 47.9],
    [p.mira, 'i do that constantly', 47.8],
    [p.ash, 'same', 47.75],
    [p.kira, 'did anyone actually try the new layout or are we just roasting amni', 30.4],
    [p.vin, 'i tried it. search lives in the hamburger now', 30.2],
    [p.kira, 'ok', 30.1],
    [p.piotr, 'i refreshed three times before it stuck', 14.6],
    [p.jules, 'desktop cache is like that', 14.5],
    [p.bee, 'anyway i\'m not deleting the tests', 6.2],
    [p.reed, 'good', 6.1],
  ], post, react);
}

function room3(ch, p, post0, react) {
  const post = (who, content, hours, extra) => post0(ch.id, who, content, hours, extra);
  return play([
    [p.nico, 'hopping on', 44.8],
    [p.lark, '2 min', 44.7],
    [p.nico, 'ok', 44.65],
    [p.nico, 'lark', 44.1],
    [p.lark, 'sorry kid woke up', 44.0],
    [p.nico, 'all good we just sat there', 43.9, { react: [[p.reed, '😂'], [p.jules, '💀']] }],
    [p.reed, 'iconic', 43.8],
    [p.mira, 'i heard you for like 4 seconds then nothing', 43.5],
    [p.nico, 'yeah that was the sleep thing', 43.4],
    [p.cass, 'don\'t close the lid', 43.3],
    [p.nico, 'i will not take this advice', 43.2],
    [p.bee, 'i\'m in if you\'re still going', 42.6],
    [p.nico, 'we ended', 42.55],
    [p.bee, 'of course', 42.5],
    [p.piotr, 'tomorrow?', 22.4],
    [p.nico, 'after 8', 22.3],
    [p.ash, 'k', 22.25],
    [p.june, 'i\'ll try to make it', 21.8],
    [p.jules, 'june you\'re gonna hate how quiet it is until someone talks', 21.7],
    [p.june, 'that\'s every call i\'ve ever been in', 21.6],
    [p.lark, 'i\'ll be there if the house is calm', 8.2],
    [p.nico, 'no promises on my end either', 8.0],
  ], post, react);
}

function leftover(ch, p, post0) {
  post0(ch.id, p.jules, `is anyone actually using ${ch.name}`, 12);
  post0(ch.id, p.reed, 'now we are', 11.8);
  post0(ch.id, p.june, 'hi', 11.5);
  post0(ch.id, p.bee, 'hi june', 11.4);
  return 4;
}

function requests(db, ch, p, post0, react) {
  const post = (who, content, hours, extra) => post0(ch.id, who, content, hours, extra);
  const existing = db.prepare(
    'SELECT id, title FROM messages WHERE channel_id = ? AND thread_id IS NULL ORDER BY id'
  ).all(ch.id);
  let n = 0;

  const rate = post(p.theo, 'keep hitting 30/min when i try to import old stuff. is that per token or per channel because i made a second webhook and it still 429\'d', 28.4, {
    title: 'webhook import keeps 429ing',
    tags: ['bots', 'api'],
    kind: 'request',
    status: 'planned',
  });
  n += 1;
  n += 1; post(p.oz, 'pretty sure it\'s per token but they share a bucket. i ran into this last month', 27.8, { threadId: rate });
  n += 1; post(p.vin, '+1 i tried to dump a discord export and it just stopped halfway', 26.2, { threadId: rate });
  n += 1; post(p.bee, 'just wait a minute lol', 25.9, { threadId: rate });
  n += 1; post(p.theo, 'i waited. it still 429\'d. i\'m not sitting here clicking every 30 seconds', 25.4, { threadId: rate });
  n += 1; post(p.cass, 'it\'s on the list. don\'t burn a third token it won\'t help', 18.6, { threadId: rate });
  n += 1; post(p.reed, 'cass said the thing', 18.4, { threadId: rate });

  const search = post(p.vin, 'turned braid on and search / pins / gallery just vanished from the top. i thought it broke', 50.8, {
    title: 'search missing after braid',
    tags: ['ui'],
    kind: 'bug',
    status: 'complete',
  });
  n += 1;
  n += 1; post(p.june, 'it\'s in Menu. bottom left. i also thought it was gone', 50.2, { threadId: search });
  n += 1; post(p.vin, 'that should not be a treasure hunt', 49.8, { threadId: search });
  n += 1; post(p.cass, 'that\'s the whole point of the hamburger. header was a junk drawer', 49.4, { threadId: search });
  n += 1; post(p.jules, 'i like it actually', 49.1, { threadId: search });
  n += 1; post(p.vin, 'of course you do', 49.0, { threadId: search });
  n += 1; post(p.ash, 'lol', 48.9, { threadId: search });

  const roles = post(p.june, 'i joined and i have a User role and i don\'t know what that gets me. can i make a channel or not', 16.2, {
    title: 'what does User actually allow',
    tags: ['roles'],
    kind: 'discussion',
  });
  n += 1;
  n += 1; post(p.cass, 'User is automatic. create channel is a separate permission, you probably don\'t have it', 15.8, { threadId: roles });
  n += 1; post(p.oz, 'if the + items are greyed that\'s the hover telling you. join still works', 15.4, { threadId: roles });
  n += 1; post(p.june, 'ok i think i get it', 15.0, { threadId: roles });
  n += 1; post(p.reed, 'you don\'t', 14.9, { threadId: roles });
  n += 1; post(p.june, 'rude', 14.8, { threadId: roles });
  n += 1; post(p.reed, 'affectionate', 14.7, { threadId: roles, react: [[p.jules, '😂'], [p.bee, '❤️']] });

  const contrast = existing.find((t) => /contrast/i.test(t.title || ''));
  if (contrast) {
    n += 1; post(p.vin, 'yeah the chips wash out. i can still read them but only because i already know what they say', 8.4, { threadId: contrast.id });
    n += 1; post(p.kira, 'same on braid light. dark is fine', 7.2, { threadId: contrast.id });
    n += 1; post(p.bee, 'please fix this i keep thinking planned is complete', 3.6, { threadId: contrast.id });
  }
  const howTo = existing.find((t) => /how to use/i.test(t.title || ''));
  if (howTo) {
    n += 1; post(p.june, 'ok so planned means nobody started. i was treating it like a backlog column', 11.2, { threadId: howTo.id });
    n += 1; post(p.cass, 'that\'s what it is. closed is separate, it\'s not a status', 10.8, { threadId: howTo.id });
  }
  return n;
}

function showcase(db, ch, p, post0, react) {
  const post = (who, content, hours, extra) => post0(ch.id, who, content, hours, extra);
  const existing = db.prepare(
    'SELECT id, title FROM messages WHERE channel_id = ? AND thread_id IS NULL ORDER BY id'
  ).all(ch.id);
  let n = 0;

  const kitchen = post(p.kira, 'saturday. light was being nice for once\nhttps://picsum.photos/id/292/800/520.jpg', 49.6, {
    title: 'kitchen window',
    tags: ['photo'],
    kind: 'showcase',
  });
  n += 1;
  n += 1; post(p.bee, 'wait is that your kitchen', 49.2, { threadId: kitchen });
  n += 1; post(p.kira, 'yeah. the plant is dying ignore it', 49.0, { threadId: kitchen });
  n += 1; post(p.mira, 'the plant is the photo', 48.6, { threadId: kitchen, react: [[p.kira, '😂']] });
  n += 1; post(p.piotr, 'nice light', 30.4, { threadId: kitchen });
  n += 1; post(p.ash, 'steal', 12.1, { threadId: kitchen });

  const walk = post(p.mira, 'couldn\'t sleep so i walked\nhttps://picsum.photos/id/1015/800/500.jpg', 19.8, {
    title: '2am walk',
    tags: ['photo'],
    kind: 'showcase',
  });
  n += 1;
  n += 1; post(p.reed, 'of course you did', 19.4, { threadId: walk });
  n += 1; post(p.nico, 'that sky is illegal', 18.9, { threadId: walk });
  n += 1; post(p.lark, 'i want to be there and also i want to be in bed', 18.2, { threadId: walk });
  n += 1; post(p.june, 'ok this server has actual photos. i thought it was just screenshots', 10.6, { threadId: walk });

  const porch = existing.find((t) => /porch|dog/i.test(t.title || ''));
  if (porch) {
    n += 1; post(p.bee, 'i come back to this one like every day', 6.4, { threadId: porch.id });
    n += 1; post(p.kira, 'he\'s a menace and i would die for him', 5.8, { threadId: porch.id });
    n += 1; post(p.jules, 'name', 5.6, { threadId: porch.id });
    n += 1; post(p.kira, 'bean', 5.5, { threadId: porch.id, react: [[p.bee, '❤️'], [p.ash, '🔥'], [p.june, '❤️']] });
  }
  return n;
}

function main() {
  const db = new Database(DB_PATH);
  try {
    const result = seedDemoBotChats(db);
    console.log(`[demo-seed] ${result.people} people, ${result.planted} messages in ${DB_PATH}`);
  } finally {
    db.close();
  }
}

if (require.main === module) main();

module.exports = { seedDemoBotChats };
