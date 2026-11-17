'use strict';

/**
 * A stand-in for Discord, for testing Ferry without a real bot or a network.
 *
 * One local port answers both halves Ferry talks to: the REST API (token
 * check, webhooks, webhook execution) and the gateway WebSocket. Point a
 * Haven server at it with
 *
 *   FERRY_TEST_DISCORD_API=http://127.0.0.1:<port>
 *   FERRY_TEST_DISCORD_GATEWAY=ws://127.0.0.1:<port>
 *
 * and NODE_ENV=test. Ferry only honours those under NODE_ENV=test and for a
 * loopback address. The test then plays Discord's side by calling dispatch()
 * with gateway events, and reads what Haven sent through `executions`.
 */

const http = require('node:http');
const { WebSocketServer } = require('ws');

const GUILD_ID = '1300000000000000001';
const TEXT_ID = '1300000000000000002';
const FORUM_ID = '1300000000000000003';
const BOT_ID = '1300000000000000004';
const TAG_BUG = '1300000000000000005';
const TAG_IDEA = '1300000000000000006';
const TAG_STAFF = '1300000000000000007';

function startFakeDiscord(port) {
  let nextId = 1300000000000001000n;
  const newId = () => String(nextId++);

  const sockets = new Set();
  const webhooks = new Map();      // id -> { id, token, channelId }
  const executions = [];           // { webhookId, threadId, body }
  const botMessages = [];
  const reactions = [];            // { method, channelId, messageId, emoji } the bot's own
  let seq = 0;
  let identified = 0;

  // The forum as Discord describes it. Not age-restricted: Discord leaves
  // `nsfw` false on a channel until a moderator turns it on.
  const forumChannel = () => ({
    id: FORUM_ID, name: 'help-forum', type: 15, parent_id: null, flags: 0, nsfw: false,
    available_tags: [
      { id: TAG_BUG, name: 'Bug', moderated: false },
      { id: TAG_IDEA, name: 'Idea', moderated: false },
      { id: TAG_STAFF, name: 'Staff', moderated: true },
    ],
  });

  // @everyone can view and read history, and the bot's own member entry
  // comes along as it does from Discord, so Ferry can tell which channels the
  // bot is kept out of.
  const guild = () => ({
    id: GUILD_ID,
    name: 'Test Guild',
    icon: null,
    owner_id: '1300000000000000099',
    roles: [{ id: GUILD_ID, name: '@everyone', mentionable: false, permissions: String(1024 + 2048 + 65536) }],
    members: [{ user: { id: BOT_ID, username: 'FerryBot' }, roles: [] }],
    emojis: [],
    threads: [],
    channels: [
      { id: TEXT_ID, name: 'general', type: 0, parent_id: null },
      forumChannel(),
    ],
  });

  function send(ws, packet) {
    try { ws.send(JSON.stringify(packet)); } catch { /* closed */ }
  }

  function dispatch(t, d) {
    seq++;
    for (const ws of sockets) send(ws, { op: 0, t, s: seq, d });
  }

  function json(res, status, body) {
    const data = body === undefined ? '' : JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(data);
  }

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => { chunks.push(c); });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const parts = url.pathname.split('/').filter(Boolean);
      const raw = Buffer.concat(chunks).toString('latin1');
      let body = null;
      const boundary = /multipart\/form-data;\s*boundary=(.+)$/.exec(req.headers['content-type'] || '');
      if (boundary) {
        // An upload: the message is in payload_json, and each file is noted
        // with its name and size.
        const files = [];
        for (const part of raw.split('--' + boundary[1].replace(/^"|"$/g, ''))) {
          const name = /name="([^"]+)"/.exec(part);
          const sep = part.indexOf('\r\n\r\n');
          if (!name || sep < 0) continue;
          const value = part.slice(sep + 4).replace(/\r\n$/, '');
          if (name[1] === 'payload_json') {
            try { body = JSON.parse(value); } catch { body = null; }
          } else {
            const filename = /filename="([^"]*)"/.exec(part);
            files.push({ field: name[1], filename: filename ? filename[1] : null, size: Buffer.from(value, 'latin1').length });
          }
        }
        if (body) body.files = files;
      } else {
        // JSON is UTF-8; raw above is latin1 only so file bytes keep their size.
        try { body = raw ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null; } catch { body = null; }
      }

      if (req.method === 'GET' && url.pathname === '/users/@me') {
        return json(res, 200, { id: BOT_ID, username: 'FerryBot', discriminator: '0', avatar: null });
      }
      // /channels/:id/webhooks
      if (parts[0] === 'channels' && parts[2] === 'webhooks') {
        if (req.method === 'GET') {
          return json(res, 200, [...webhooks.values()].filter(w => w.channelId === parts[1])
            .map(w => ({ id: w.id, token: w.token, application_id: BOT_ID })));
        }
        if (req.method === 'POST') {
          const hook = { id: newId(), token: 'hooktoken' + webhooks.size, channelId: parts[1] };
          webhooks.set(hook.id, hook);
          return json(res, 200, { id: hook.id, token: hook.token, application_id: BOT_ID });
        }
      }
      // /channels/:id/messages/:id/reactions/:emoji/@me, the bot reacting
      if ((req.method === 'PUT' || req.method === 'DELETE') && parts[0] === 'channels' && parts[2] === 'messages'
        && parts[4] === 'reactions' && parts[6] === '@me') {
        reactions.push({ method: req.method, channelId: parts[1], messageId: parts[3], emoji: decodeURIComponent(parts[5]) });
        res.writeHead(204); return res.end();
      }
      if (req.method === 'POST' && url.pathname === '/users/@me/channels') return json(res, 200, { id: newId(), type: 1, recipient_id: body && body.recipient_id });
      if (req.method === 'GET' && parts[0] === 'guilds' && parts[2] === 'members' && parts.length === 4) return json(res, 200, { user: { id: parts[3], username: 'member', bot: false } });
      if (req.method === 'POST' && parts[0] === 'channels' && parts[2] === 'messages') {
        botMessages.push({ channelId: parts[1], body });
        return json(res, 200, { id: newId(), channel_id: parts[1], content: body && body.content });
      }
      // /webhooks/:id/:token
      if (req.method === 'POST' && parts[0] === 'webhooks' && parts.length === 3) {
        const hook = webhooks.get(parts[1]);
        if (!hook || hook.token !== parts[2]) return json(res, 404, { message: 'Unknown Webhook', code: 10015 });
        const threadId = url.searchParams.get('thread_id');
        const forum = hook.channelId === FORUM_ID;
        if (forum && !threadId && !(body && body.thread_name)) {
          return json(res, 400, { message: 'Webhooks posted to forum channels must have a thread_name or thread_id', code: 220001 });
        }
        const id = newId();
        // A new forum post's first message has the post's own id.
        const channelId = threadId || (body && body.thread_name ? id : hook.channelId);
        const result = { id, channel_id: channelId, webhook_id: hook.id, content: body && body.content };
        executions.push({ webhookId: hook.id, threadId, body, result });
        return json(res, 200, result);
      }
      json(res, 404, { message: 'Not handled by the fake Discord', code: 0 });
    });
  });

  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws) => {
    sockets.add(ws);
    ws.on('close', () => sockets.delete(ws));
    send(ws, { op: 10, d: { heartbeat_interval: 45000 } });
    ws.on('message', (raw) => {
      let p;
      try { p = JSON.parse(raw.toString()); } catch { return; }
      if (p.op === 1) send(ws, { op: 11 });
      if (p.op === 2 || p.op === 6) {
        identified++;
        seq++;
        send(ws, { op: 0, t: 'READY', s: seq, d: {
          session_id: 'fake-session-' + identified,
          resume_gateway_url: `ws://127.0.0.1:${port}`,
          user: { id: BOT_ID, username: 'FerryBot', discriminator: '0', avatar: null },
        } });
        seq++;
        send(ws, { op: 0, t: 'GUILD_CREATE', s: seq, d: guild() });
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve({
      port,
      dispatch,
      forumChannel,
      executions,
      botMessages,
      reactions,
      webhooks,
      newId,
      get identified() { return identified; },
      get connections() { return sockets.size; },
      close: () => new Promise((r) => {
        for (const ws of sockets) { try { ws.terminate(); } catch { /* gone */ } }
        wss.close();
        server.close(() => r());
      }),
    }));
  });
}

module.exports = { startFakeDiscord, GUILD_ID, TEXT_ID, FORUM_ID, BOT_ID, TAG_BUG, TAG_IDEA, TAG_STAFF };
