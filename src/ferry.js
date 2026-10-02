'use strict';

/**
 * Ferry: the Haven ↔ Discord message bridge.
 *
 * One Discord bot per Haven server. The admin creates the application in
 * Discord's developer portal, pastes the bot token into Settings → Ferry, and
 * pairs Haven channels with Discord channels. Haven can't ship a shared bot:
 * Discord caps unverified applications at 100 guilds and verification needs a
 * real company review, so every self-hoster brings their own token.
 *
 * Two transports, because Discord needs both:
 *
 *   Reading:  a gateway WebSocket. There is no "outgoing webhook" on Discord
 *              that POSTs new messages to us, so a live socket is the only way
 *              to see them. Needs the Message Content privileged intent, which
 *              is a checkbox in the dev portal for anyone under 100 guilds.
 *
 *   Writing:  a per-pairing Discord channel webhook, NOT the bot user. Only
 *              webhooks can override username and avatar per message, which is
 *              what makes a relayed message show up as the Haven user who
 *              actually wrote it instead of as one anonymous bot. We create
 *              those webhooks ourselves when the bot has Manage Webhooks.
 *
 * Forums pair only with forums. A Discord forum post becomes a Haven forum
 * topic and the other way round, and replies follow their post; see the two
 * "Forums" sections below. They use the same two transports: posts arrive as
 * thread and message events on the gateway, and go out through the forum's
 * webhook with `thread_name` (a new post) or `thread_id` (a reply).
 *
 * DMs are the exception to the above and are deliberately limited. A bot can
 * only DM someone who shares a guild with it and has DMs open, it cannot
 * impersonate in a DM, and Discord flags accounts that DM in bulk. So DMs are
 * off by default, outbound only, and every one of them is stamped with the
 * Haven author's name in the body.
 */

const WebSocket = require('ws');
const automod = require('./automod');
const { stripRoleMentions } = require('./socketHandlers/helpers');

/**
 * The tests run Ferry against a stand-in Discord on this machine, set through
 * FERRY_TEST_DISCORD_API and FERRY_TEST_DISCORD_GATEWAY. They only count when
 * NODE_ENV is "test", so a real server ignores them, and only a loopback
 * address is honoured, so a stray environment variable can never send the bot
 * token anywhere but Discord or this same computer.
 */
function loopbackOverride(value, fallback, protocols) {
  if (!value || process.env.NODE_ENV !== 'test') return fallback;
  try {
    const u = new URL(String(value));
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (protocols.includes(u.protocol) && ['127.0.0.1', 'localhost', '::1'].includes(host)) {
      return String(value).replace(/\/+$/, '');
    }
  } catch { /* not a URL, use the real Discord */ }
  return fallback;
}

const API = loopbackOverride(process.env.FERRY_TEST_DISCORD_API, 'https://discord.com/api/v10', ['http:', 'https:']);
const GATEWAY = loopbackOverride(process.env.FERRY_TEST_DISCORD_GATEWAY, 'wss://gateway.discord.gg', ['ws:', 'wss:']);
const USER_AGENT = 'DiscordBot (https://github.com/ancsemi/Haven, 1.0)';

// ── Gateway intents ─────────────────────────────────────────
const INTENT_GUILDS          = 1 << 0;
const INTENT_GUILD_MEMBERS   = 1 << 1;   // privileged, only requested for DM lookup
const INTENT_GUILD_EXPRESSIONS = 1 << 3; // emote list changes, so :name: keeps matching after an admin adds one
const INTENT_GUILD_MESSAGES  = 1 << 9;
const INTENT_MESSAGE_CONTENT = 1 << 15;  // privileged. Without it every message body is empty

// Gateway close codes that mean "stop, a human has to fix this". Reconnecting
// on these just burns the token's session budget and hides the real problem.
const FATAL_CLOSE = {
  4004: 'Discord rejected the bot token. Paste it again from the Developer Portal.',
  4010: 'Discord rejected the shard configuration.',
  4011: 'This bot is in too many servers and needs sharding, which Ferry does not support.',
  4012: 'Discord rejected the gateway version.',
  4013: 'Discord rejected the requested intents.',
};

const DISALLOWED_INTENT = 4014;

// Discord's own limits, enforced here so we fail loudly instead of eating a 400.
const MAX_DISCORD_CONTENT = 2000;
const MAX_WEBHOOK_USERNAME = 80;

// Discord ids are numeric strings. Anything else must never reach an API path.
const SNOWFLAKE = /^[0-9]{15,25}$/;

// ── Module state ────────────────────────────────────────────
let deps = null;          // { db, io, sanitizeText, insertHavenMessage }
let ws = null;
let heartbeatTimer = null;
let reconnectTimer = null;
let seq = null;
let sessionId = null;
let resumeUrl = null;
let heartbeatAcked = true;
let reconnectAttempts = 0;
let running = false;      // admin wants Ferry up
let dropMemberIntent = false;  // set after a 4014 so the retry drops the privileged member intent

let botUser = null;       // { id, username, discriminator, avatar }
let lastError = null;
let connectedAt = null;

// guildId -> { id, name, icon, channels: Map<id, {id,name,type,parentName}> }
const guilds = new Map();

// Discord webhook ids we own, so the gateway echo of our own relays is ignored.
const ownWebhookIds = new Set();

// Discord message id -> what we relayed and where, so a later edit updates the
// Haven copy instead of posting a duplicate. Bounded, and lost on restart: an
// edit to a message from before a restart is simply not applied, which is the
// safe direction to fail in.
const relayedMessages = new Map();
const RELAY_MAP_MAX = 500;

// Active Discord threads the bot can see: thread id -> { id, guildId,
// parentId, name, appliedTags, locked }. A message carries only its thread's
// id, so this is how a new forum post is traced back to its forum. Rebuilt
// from GUILD_CREATE and the THREAD_* events, so it needs no storage.
const threads = new Map();
const THREAD_CACHE_MAX = 5000;

// The first message of a forum post can arrive a moment before Discord says
// the post exists. It waits here, briefly, for its THREAD_CREATE.
const pendingStarters = new Map();
const PENDING_STARTER_MS = 30000;

// Per-destination send queues. Discord rate limits webhooks at roughly five
// messages per two seconds each, and a busy Haven channel will exceed that.
const sendQueues = new Map();

// ══════════════════════════════════════════════════════════════
// Settings
// ══════════════════════════════════════════════════════════════

/**
 * Ferry settings live in server_settings, not .env, for two reasons: the
 * channel pairings have to be in SQLite anyway so the whole feature stays one
 * unit, and .env is frequently read-only in Docker deployments where the admin
 * still needs to change the token from the UI.
 */
function getSetting(key, fallback = '') {
  try {
    const row = deps.db.prepare('SELECT value FROM server_settings WHERE key = ?').get(key);
    return row ? row.value : fallback;
  } catch { return fallback; }
}

function setSetting(key, value) {
  deps.db.prepare(
    'INSERT INTO server_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}

function boolSetting(key, fallback = false) {
  const v = getSetting(key, fallback ? '1' : '0');
  return v === '1' || v === 'true';
}

function getConfig() {
  return {
    enabled:        boolSetting('ferry_enabled', false),
    token:          getSetting('ferry_bot_token', ''),
    allowPersonas:  boolSetting('ferry_allow_personas', false),
    allowDms:       boolSetting('ferry_allow_dms', false),
    allowMentions:  boolSetting('ferry_allow_mentions', false),
    relayBots:      boolSetting('ferry_relay_bots', false),
    // "=>" and not ">>": a leading ">" is Haven's blockquote marker, so an
    // unresolved ">>Server#general hi" would silently render as a quote
    // instead of showing the user that their target did not match. "=>" has no
    // markdown meaning, and reads as "to".
    trigger:        getSetting('ferry_trigger', '=>'),
  };
}

// ══════════════════════════════════════════════════════════════
// Discord REST
// ══════════════════════════════════════════════════════════════

// Discord answers a burst with a 429 and says how long to wait. A short wait
// is honoured in place (the per-channel queue holds later messages behind
// this one), up to three times; a long one is reported instead, with the
// number of seconds, so the sender knows Discord is throttling the channel
// and the bridge is not broken. Before this the bridge waited at most ten
// seconds once and then showed Discord's own words, which read as a fault.
const RATE_LIMIT_MAX_WAIT_MS = 30000;
const RATE_LIMIT_ATTEMPTS = 3;

async function rateLimitWaitMs(res) {
  let seconds = 0;
  try {
    const info = await res.clone().json();
    if (Number.isFinite(info?.retry_after)) seconds = info.retry_after;
  } catch { /* header-only 429: use the Retry-After header below */ }
  if (!seconds) {
    const header = Number(res.headers.get('retry-after'));
    seconds = Number.isFinite(header) && header > 0 ? header : 1;
  }
  return Math.max(250, Math.ceil(seconds * 1000));
}

function rateLimitError(waitMs) {
  const err = new Error(`Discord is rate limiting this channel; try again in about ${Math.ceil(waitMs / 1000)}s`);
  err.status = 429;
  return err;
}

/**
 * One REST call with bot auth. Waits out short 429s using Discord's own
 * retry_after, retries once on a 5xx. Everything else surfaces to the caller
 * so the admin UI can show the real reason a pairing is broken.
 */
async function discordRequest(method, path, body, attempt = 0) {
  const { token } = getConfig();
  if (!token) throw new Error('No Discord bot token configured');

  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'Authorization': `Bot ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });

  if (res.status === 429) {
    const wait = await rateLimitWaitMs(res);
    console.warn(`[ferry] Discord rate limit on ${method} ${path}: retry after ${Math.ceil(wait / 1000)}s`);
    if (attempt < RATE_LIMIT_ATTEMPTS - 1 && wait <= RATE_LIMIT_MAX_WAIT_MS) {
      await sleep(wait);
      return discordRequest(method, path, body, attempt + 1);
    }
    throw rateLimitError(wait);
  }
  if (res.status >= 500 && attempt < 1) {
    await sleep(1500);
    return discordRequest(method, path, body, attempt + 1);
  }

  if (res.status === 204) return null;

  let payload = null;
  try { payload = await res.json(); } catch { /* empty or non-JSON body; errors below fall back to the HTTP status */ }

  if (!res.ok) {
    const detail = payload?.message || `HTTP ${res.status}`;
    const err = new Error(detail);
    err.status = res.status;
    err.discordCode = payload?.code;
    throw err;
  }
  return payload;
}

/**
 * Webhook execution uses the webhook's own token, not the bot token, so it goes
 * through its own path rather than discordRequest.
 *
 * `threadId` posts into one thread of the webhook's channel, which is how a
 * reply reaches a forum post. Discord unarchives the thread on the way in.
 */
async function executeWebhook(webhookId, webhookToken, payload, { threadId = null } = {}, attempt = 0) {
  const thread = threadId && SNOWFLAKE.test(String(threadId)) ? `&thread_id=${threadId}` : '';
  const res = await fetch(`${API}/webhooks/${webhookId}/${webhookToken}?wait=true${thread}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });

  if (res.status === 429) {
    const wait = await rateLimitWaitMs(res);
    console.warn(`[ferry] Discord rate limit on webhook ${webhookId}: retry after ${Math.ceil(wait / 1000)}s`);
    if (attempt < RATE_LIMIT_ATTEMPTS - 1 && wait <= RATE_LIMIT_MAX_WAIT_MS) {
      await sleep(wait);
      return executeWebhook(webhookId, webhookToken, payload, { threadId }, attempt + 1);
    }
    throw rateLimitError(wait);
  }

  let data = null;
  try { data = await res.json(); } catch { /* 204 or non-JSON body; errors below fall back to the HTTP status */ }
  if (!res.ok) {
    const err = new Error(data?.message || `HTTP ${res.status}`);
    err.status = res.status;
    err.discordCode = data?.code;
    throw err;
  }
  return data;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ══════════════════════════════════════════════════════════════
// Gateway
// ══════════════════════════════════════════════════════════════

function currentIntents() {
  let intents = INTENT_GUILDS | INTENT_GUILD_EXPRESSIONS | INTENT_GUILD_MESSAGES | INTENT_MESSAGE_CONTENT;
  // The member intent is only needed to look people up for DM autocomplete.
  // Asking for a privileged intent the admin never enabled kills the whole
  // connection with a 4014, so it is opt-in twice over: the DM setting has to
  // be on, and a previous 4014 latches it back off.
  const needsMembers = boolSetting('ferry_allow_dms', false) || boolSetting('ferry_allow_mentions', false);
  if (needsMembers && !dropMemberIntent) intents |= INTENT_GUILD_MEMBERS;
  return intents;
}

function connect() {
  const cfg = getConfig();
  if (!cfg.enabled || !cfg.token) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  running = true;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;

  const base = (sessionId && resumeUrl) ? resumeUrl : GATEWAY;
  const url = `${base}/?v=10&encoding=json`;

  try {
    ws = new WebSocket(url);
  } catch (err) {
    lastError = `Could not open the Discord gateway: ${err.message}`;
    scheduleReconnect();
    return;
  }

  ws.on('message', (raw) => {
    let packet;
    try { packet = JSON.parse(raw.toString()); } catch { return; }
    handlePacket(packet);
  });

  ws.on('close', (code, reasonBuf) => {
    stopHeartbeat();
    const reason = reasonBuf ? reasonBuf.toString() : '';

    if (code === DISALLOWED_INTENT) {
      // Either Message Content or Server Members is switched off in the portal.
      // Server Members is the one we can live without, so drop it and retry
      // once before telling the admin to go flip a checkbox.
      if (!dropMemberIntent && (boolSetting('ferry_allow_dms', false) || boolSetting('ferry_allow_mentions', false))) {
        dropMemberIntent = true;
        lastError = 'Discord refused the Server Members intent, so looking Discord people up for DMs and @mentions is off. Enable "Server Members Intent" in the Developer Portal to turn it back on.';
        sessionId = null; resumeUrl = null;
        scheduleReconnect(true);
        return;
      }
      lastError = 'Discord refused the Message Content intent. Open your application in the Developer Portal, go to Bot, and turn on "Message Content Intent".';
      stop();
      return;
    }

    if (FATAL_CLOSE[code]) {
      lastError = FATAL_CLOSE[code];
      stop();
      return;
    }

    // 4009 (session timed out) and 4007 (bad sequence) mean the session is gone
    // but the token is fine, so drop it and start a clean one.
    if (code === 4007 || code === 4009) { sessionId = null; resumeUrl = null; }

    connectedAt = null;
    if (running) {
      if (!lastError) lastError = `Discord connection closed (${code}${reason ? ': ' + reason : ''}). Reconnecting.`;
      scheduleReconnect();
    }
  });

  ws.on('error', (err) => {
    lastError = `Discord gateway error: ${err.message}`;
  });
}

function handlePacket(packet) {
  const { op, d, s, t } = packet;
  if (s !== null && s !== undefined) seq = s;

  switch (op) {
    case 10: // HELLO
      startHeartbeat(d.heartbeat_interval);
      if (sessionId && seq !== null) sendResume();
      else sendIdentify();
      break;

    case 11: // HEARTBEAT ACK
      heartbeatAcked = true;
      break;

    case 1: // Discord asking for a heartbeat now
      sendHeartbeat();
      break;

    case 7: // RECONNECT, resume against the resume URL
      safeClose(4000);
      break;

    case 9: // INVALID SESSION
      if (!d) { sessionId = null; resumeUrl = null; }
      setTimeout(() => { if (running) safeClose(4000); }, 1000 + Math.floor(Math.random() * 4000));
      break;

    case 0: // DISPATCH
      handleDispatch(t, d);
      break;
  }
}

function startHeartbeat(intervalMs) {
  stopHeartbeat();
  heartbeatAcked = true;
  // Discord asks for jitter on the first beat so every bot on the planet does
  // not hit the gateway on the same tick after an outage.
  setTimeout(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    sendHeartbeat();
    heartbeatTimer = setInterval(() => {
      if (!heartbeatAcked) {
        // A missed ack means the socket is a zombie: still open locally, no
        // longer delivering. Close it so the reconnect path takes over.
        safeClose(4000);
        return;
      }
      heartbeatAcked = false;
      sendHeartbeat();
    }, intervalMs);
  }, Math.floor(Math.random() * intervalMs));
}

function stopHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

function gatewaySend(payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try { ws.send(JSON.stringify(payload)); } catch { /* socket died mid-write; its close handler reconnects */ }
}

function sendHeartbeat() { gatewaySend({ op: 1, d: seq }); }

function sendIdentify() {
  gatewaySend({
    op: 2,
    d: {
      token: getConfig().token,
      intents: currentIntents(),
      properties: { os: process.platform, browser: 'Haven Ferry', device: 'Haven Ferry' },
      presence: { status: 'online', afk: false, activities: [] },
    },
  });
}

function sendResume() {
  gatewaySend({ op: 6, d: { token: getConfig().token, session_id: sessionId, seq } });
}

function safeClose(code) {
  try { if (ws) ws.close(code); } catch { /* already gone */ }
}

function scheduleReconnect(immediate = false) {
  if (!running) return;
  clearTimeout(reconnectTimer);
  // Exponential backoff capped at 60s. Discord bans tokens that reconnect in a
  // tight loop, so this is not optional.
  const delay = immediate ? 500 : Math.min(60000, 1000 * Math.pow(2, Math.min(reconnectAttempts, 6)));
  reconnectAttempts++;
  reconnectTimer = setTimeout(() => { ws = null; connect(); }, delay);
}

// ══════════════════════════════════════════════════════════════
// Gateway dispatch
// ══════════════════════════════════════════════════════════════

function handleDispatch(type, d) {
  switch (type) {
    case 'READY':
      reconnectAttempts = 0;
      connectedAt = new Date().toISOString();
      lastError = null;
      sessionId = d.session_id;
      resumeUrl = d.resume_gateway_url || null;
      botUser = d.user ? { id: d.user.id, username: d.user.username, discriminator: d.user.discriminator, avatar: d.user.avatar } : null;
      guilds.clear();
      threads.clear();
      break;

    case 'RESUMED':
      reconnectAttempts = 0;
      connectedAt = connectedAt || new Date().toISOString();
      lastError = null;
      break;

    case 'GUILD_CREATE':
      cacheGuild(d);
      break;

    case 'GUILD_UPDATE': {
      const g = guilds.get(d.id);
      if (g) { g.name = d.name; g.icon = d.icon; }
      break;
    }

    case 'GUILD_DELETE':
      if (!d.unavailable) guilds.delete(d.id);
      break;

    case 'GUILD_EMOJIS_UPDATE': {
      const g = guilds.get(d.guild_id);
      if (g) g.emojis = emojiMap(d.emojis);
      break;
    }

    case 'CHANNEL_CREATE':
    case 'CHANNEL_UPDATE':
      cacheChannel(d);
      break;

    case 'CHANNEL_DELETE': {
      const g = guilds.get(d.guild_id);
      if (g) { g.channels.delete(d.id); g.channelNames?.delete(d.id); }
      break;
    }

    case 'GUILD_ROLE_CREATE':
    case 'GUILD_ROLE_UPDATE': {
      const g = guilds.get(d.guild_id);
      const r = d.role;
      if (g && r && r.id && r.name && r.id !== d.guild_id) {
        if (!g.roles) g.roles = new Map();
        g.roles.set(String(r.id), { id: String(r.id), name: String(r.name), mentionable: !!r.mentionable });
      }
      break;
    }

    case 'GUILD_ROLE_DELETE': {
      const g = guilds.get(d.guild_id);
      if (g && g.roles) g.roles.delete(String(d.role_id));
      break;
    }

    case 'MESSAGE_CREATE':
      relayToHaven(d);
      break;

    case 'MESSAGE_UPDATE':
      relayEditToHaven(d);
      break;

    case 'THREAD_CREATE':
      cacheThread(d);
      takePendingStarter(d && d.id);
      break;

    case 'THREAD_UPDATE': {
      // What the post looked like before this update, read before the cache
      // is overwritten, so only what Discord actually changed is passed on.
      const before = d && d.id ? threads.get(String(d.id)) || null : null;
      cacheThread(d);
      relayThreadUpdateToHaven(d, before);
      break;
    }

    case 'THREAD_DELETE':
      if (d && d.id) {
        threads.delete(String(d.id));
        pendingStarters.delete(String(d.id));
        relayThreadDeleteToHaven(d);
      }
      break;

    case 'THREAD_LIST_SYNC': {
      // Sent when the bot gains access to channels. `channel_ids` names the
      // parents being synced; their old threads are dropped before the fresh
      // list goes in. With no `channel_ids` the whole guild is being synced.
      const parents = Array.isArray(d && d.channel_ids) ? new Set(d.channel_ids.map(String)) : null;
      for (const [id, th] of threads) {
        if (th.guildId === String(d && d.guild_id) && (!parents || parents.has(th.parentId))) threads.delete(id);
      }
      for (const th of (d && d.threads) || []) cacheThread({ ...th, guild_id: th.guild_id || d.guild_id });
      break;
    }
  }
}

// Text-ish channel types worth pairing. 0 text, 5 announcement, 11/12 threads,
// 15 forum, 16 media. Media channels are forums whose posts lead with a
// picture, and Discord treats their posts exactly like forum posts.
const RELAYABLE_TYPES = new Set([0, 5, 11, 12, 15, 16]);
const FORUM_TYPES = new Set([15, 16]);
// Discord's channel flag for "a post here must carry a tag".
const FLAG_REQUIRE_TAG = 1 << 4;

function isForumType(type) {
  return FORUM_TYPES.has(Number(type));
}

// The forum-only parts of a Discord channel: its tags, whether a post must
// carry one, and whether the forum is age-restricted (NSFW), which decides if
// an NSFW Haven topic may go there. Empty for every other kind of channel.
function forumFields(c) {
  if (!isForumType(c.type)) return {};
  return {
    tags: (c.available_tags || [])
      .filter(t => t && t.id && t.name)
      .map(t => ({ id: String(t.id), name: String(t.name), moderated: !!t.moderated })),
    requireTag: !!((Number(c.flags) || 0) & FLAG_REQUIRE_TAG),
    nsfw: c.nsfw === true,
  };
}

function cacheThread(t) {
  if (!t || !t.id || !t.parent_id) return;
  if (threads.size >= THREAD_CACHE_MAX && !threads.has(String(t.id))) {
    threads.delete(threads.keys().next().value);
  }
  threads.set(String(t.id), {
    id: String(t.id),
    guildId: String(t.guild_id || ''),
    parentId: String(t.parent_id),
    name: String(t.name || ''),
    appliedTags: Array.isArray(t.applied_tags) ? t.applied_tags.map(String) : [],
    locked: !!(t.thread_metadata && t.thread_metadata.locked),
  });
}

function cacheGuild(g) {
  const channels = new Map();
  const byId = new Map((g.channels || []).map(c => [c.id, c]));
  // Every channel's name, voice and categories included, for turning a
  // <#id> in a message into a name people can read.
  const channelNames = new Map();
  for (const c of g.channels || []) if (c && c.id && c.name) channelNames.set(c.id, c.name);
  for (const c of g.channels || []) {
    if (!RELAYABLE_TYPES.has(c.type)) continue;
    channels.set(c.id, {
      id: c.id,
      name: c.name,
      type: c.type,
      category: c.parent_id ? (byId.get(c.parent_id)?.name || null) : null,
      ...forumFields(c),
    });
  }
  guilds.set(g.id, { id: g.id, name: g.name, icon: g.icon || null, channels, channelNames, emojis: emojiMap(g.emojis), roles: roleMap(g.roles, g.id) });
  // Every active thread the bot can see comes with the guild, forum posts
  // among them. Archived ones do not, and are learned when they wake up.
  for (const th of g.threads || []) cacheThread({ ...th, guild_id: th.guild_id || g.id });
}

// Role id -> { id, name, mentionable }. GUILD_CREATE carries the full list and
// the GUILD_ROLE_* events keep it current. @everyone is a role too, with the
// guild's own id, and is left out: it never relays as a role.
function roleMap(list, guildId) {
  const map = new Map();
  for (const r of list || []) {
    if (!r || !r.id || !r.name || r.id === guildId || r.name === '@everyone') continue;
    map.set(String(r.id), { id: String(r.id), name: String(r.name), mentionable: !!r.mentionable });
  }
  return map;
}

// Lowercased name -> { id, name, animated }, so a Haven :name: can go out as
// the guild's own emote. GUILD_CREATE carries the full list and
// GUILD_EMOJIS_UPDATE replaces it whenever an admin adds or removes one.
function emojiMap(list) {
  const map = new Map();
  for (const e of list || []) {
    if (!e || !e.id || !e.name) continue;
    map.set(String(e.name).toLowerCase(), { id: String(e.id), name: String(e.name), animated: !!e.animated });
  }
  return map;
}

function cacheChannel(c) {
  if (!c.guild_id) return;
  const g = guilds.get(c.guild_id);
  if (!g) return;
  if (g.channelNames && c.id && c.name) g.channelNames.set(c.id, c.name);
  if (!RELAYABLE_TYPES.has(c.type)) { g.channels.delete(c.id); return; }
  g.channels.set(c.id, { id: c.id, name: c.name, type: c.type, category: g.channels.get(c.id)?.category || null, ...forumFields(c) });
}

// ══════════════════════════════════════════════════════════════
// Discord → Haven
// ══════════════════════════════════════════════════════════════

function relayToHaven(msg) {
  try {
    if (!msg || !msg.channel_id) return;

    // Loop guard, and the reason this bridge cannot feed itself: every message
    // we relay outward comes back through the gateway a moment later. Our own
    // webhook ids and our own bot id are always dropped. Other bots are dropped
    // too unless an admin deliberately opts in, which also stops one chatty
    // Discord bot from flooding a Haven channel.
    if (msg.webhook_id && ownWebhookIds.has(msg.webhook_id)) return;
    if (botUser && msg.author && msg.author.id === botUser.id) return;
    if (msg.author && msg.author.bot && !boolSetting('ferry_relay_bots', false)) return;

    // Type 0 is a normal message, 19 is a reply. Everything else is a join
    // notice, pin notice, boost notice and so on, which is noise in Haven.
    if (msg.type !== undefined && msg.type !== 0 && msg.type !== 19) return;

    // Posts and replies in a paired Discord forum take their own route,
    // because they become topics and thread replies rather than chat lines.
    if (relayForumMessage(msg)) return;

    const rows = deps.db.prepare(`
      SELECT f.id, f.channel_id, f.direction, f.discord_channel_id, f.guild_name, f.discord_channel_name,
             c.code AS channel_code, c.name AS channel_name, c.is_forum
      FROM ferry_links f
      JOIN channels c ON f.channel_id = c.id
      WHERE f.discord_channel_id = ? AND f.is_active = 1 AND f.direction IN ('both','to_haven')
    `).all(msg.channel_id);
    // A chat line has no title and no place in a forum. This only happens when
    // a paired Haven channel was switched to a forum after it was paired.
    const links = rows.filter(l => {
      if (!l.is_forum) return true;
      touchLink(l.id, KIND_MISMATCH);
      return false;
    });
    if (!links.length) return;

    const content = buildHavenContent(msg);
    if (!content) return;

    const author = msg.member?.nick || msg.author?.global_name || msg.author?.username || 'Discord user';
    const avatar = discordAvatarUrl(msg.author);

    const targets = [];
    for (const link of links) {
      const havenId = deps.insertHavenMessage({
        channelId: link.channel_id,
        channelCode: link.channel_code,
        username: author,
        avatarUrl: avatar,
        content,
      });
      if (havenId) targets.push({ havenMessageId: havenId, channelCode: link.channel_code });
      touchLink(link.id, null);
    }
    if (targets.length) rememberRelay(msg.id, content, targets);
  } catch (err) {
    console.error('Ferry inbound relay error:', err.message);
  }
}

function rememberRelay(discordMessageId, content, targets) {
  // Map preserves insertion order, so the first key is the oldest entry.
  if (relayedMessages.size >= RELAY_MAP_MAX) {
    relayedMessages.delete(relayedMessages.keys().next().value);
  }
  relayedMessages.set(discordMessageId, { content, targets });
}

/**
 * Applies a Discord edit to the Haven copy rather than posting it again.
 *
 * Two deliberate refusals. A message we never relayed is never resurrected by
 * an edit, which is what stops a third-party bot's delayed embed from arriving
 * in Haven after its original was filtered out. And an update with no `content`
 * field is ignored: Discord sends a partial object when it attaches a link
 * preview to an existing message, and treating that as the new body would
 * replace the author's text with an embed summary.
 */
function relayEditToHaven(msg) {
  try {
    if (!msg || !msg.id) return;
    if (typeof msg.content !== 'string') return;

    const known = relayedMessages.get(msg.id);
    if (!known) return;

    const content = buildHavenContent(msg);
    if (!content || content === known.content) return;

    known.content = content;
    for (const target of known.targets) {
      deps.editHavenMessage({ ...target, content });
    }
  } catch (err) {
    console.error('Ferry edit relay error:', err.message);
  }
}

// ══════════════════════════════════════════════════════════════
// Forums, Discord → Haven
// ══════════════════════════════════════════════════════════════
//
// A Discord forum post is a thread whose first message has the same id as the
// thread. It becomes a Haven forum topic: the post's name is the title, its
// first message the body, and its tags are matched to the Haven forum's tags
// by name. Later messages in the thread become replies in the topic. Which
// topic is which post is stored in ferry_forum_threads, so replies keep their
// place across restarts.
//
// Only posts made while the pairing exists come across. A reply in an older
// post, or in a post whose Haven topic was deleted, is dropped rather than
// rebuilding the topic, so deleting a topic in Haven keeps it deleted.

const KIND_MISMATCH = 'This pairing joins a forum to a channel that is not a forum, so nothing crosses. Remove it and pair a forum with a forum.';

function discordAuthorName(msg) {
  return msg.member?.nick || msg.author?.global_name || msg.author?.username || 'Discord user';
}

// Active pairings for one Discord forum that bring things into Haven, with
// the Haven forum's tag list. A Haven channel that stopped being a forum is
// marked on the pairing and skipped.
function inboundForumLinks(discordForumId) {
  const rows = deps.db.prepare(`
    SELECT f.id, f.channel_id, f.guild_id, f.discord_channel_id, f.direction,
           c.code AS channel_code, c.is_forum, c.forum_tags
    FROM ferry_links f JOIN channels c ON f.channel_id = c.id
    WHERE f.discord_channel_id = ? AND f.is_active = 1 AND f.direction IN ('both','to_haven')
  `).all(String(discordForumId));
  return rows.filter(l => {
    if (l.is_forum) return true;
    touchLink(l.id, KIND_MISMATCH);
    return false;
  });
}

// Every Haven topic one Discord post is carried in, with whether its pairing
// still brings things into Haven.
function mappedTopics(discordThreadId) {
  return deps.db.prepare(`
    SELECT t.topic_message_id, t.channel_id, t.discord_forum_id, t.origin,
           c.code AS channel_code, f.id AS link_id,
           (f.is_active = 1 AND f.direction IN ('both','to_haven')) AS inbound
    FROM ferry_forum_threads t
    JOIN channels c ON c.id = t.channel_id
    JOIN ferry_links f ON f.channel_id = t.channel_id AND f.discord_channel_id = t.discord_forum_id
    WHERE t.discord_thread_id = ?
  `).all(String(discordThreadId));
}

/**
 * Handles a message if it belongs to a Discord forum post. Returns true when
 * it did (or deliberately dropped it), false to let the chat path try.
 */
function relayForumMessage(msg) {
  const threadId = String(msg.channel_id);
  const isStarter = String(msg.id) === threadId;

  const mapped = mappedTopics(threadId);
  if (mapped.length) {
    // The first message of a post Ferry already carries is never a reply.
    // That is how our own posts look when they echo back.
    if (isStarter) return true;
    const live = mapped.filter(r => r.inbound);
    if (!live.length) return true;
    const content = buildHavenContent(msg);
    if (!content) return true;
    const username = discordAuthorName(msg);
    const avatarUrl = discordAvatarUrl(msg.author);
    const targets = [];
    for (const r of live) {
      const id = deps.insertHavenThreadReply({
        channelId: r.channel_id, channelCode: r.channel_code, parentId: r.topic_message_id,
        username, avatarUrl, content,
      });
      if (id) targets.push({ havenMessageId: id, channelCode: r.channel_code });
      touchLink(r.link_id, null);
    }
    if (targets.length) rememberRelay(msg.id, content, targets);
    return true;
  }

  const thread = threads.get(threadId);
  if (!thread) {
    // Only a forum post's first message shares its id with its channel, so
    // this is a post whose THREAD_CREATE has not arrived yet.
    if (isStarter) stashStarter(msg);
    return false;
  }

  // A thread in a channel that is not a paired forum is left to the chat path.
  const parentPaired = deps.db.prepare(
    'SELECT 1 FROM ferry_links WHERE discord_channel_id = ? LIMIT 1'
  ).get(thread.parentId);
  if (!parentPaired) return false;

  if (isStarter) relayForumStarter(msg, thread);
  return true;
}

function stashStarter(msg) {
  const now = Date.now();
  for (const [id, p] of pendingStarters) if (now - p.at > PENDING_STARTER_MS) pendingStarters.delete(id);
  if (pendingStarters.size >= 100) return;
  pendingStarters.set(String(msg.id), { msg, at: now });
}

function takePendingStarter(threadId) {
  if (!threadId) return;
  const pending = pendingStarters.get(String(threadId));
  if (!pending) return;
  pendingStarters.delete(String(threadId));
  if (Date.now() - pending.at > PENDING_STARTER_MS) return;
  try { relayToHaven(pending.msg); } catch (err) { console.error('Ferry forum relay error:', err.message); }
}

// An automod fault must never take the bridge down, so the text passes
// unfiltered; but it means filtering is off for bridged messages, so the
// admin hears about it once rather than once per message.
let automodFaultLogged = false;
function noteAutomodFault(err) {
  if (automodFaultLogged) return;
  automodFaultLogged = true;
  console.warn('[ferry] Automod check failed, bridged text is passing unfiltered:', err && err.message);
}

/**
 * A forum post's title, cleaned the way Haven cleans a topic title typed in
 * Haven. Empty when there is nothing left or the link policy refuses it.
 */
function havenTopicTitle(name) {
  let title = String(name || '').trim().replace(/\s+/g, ' ').slice(0, 120);
  if (deps?.sanitizeText) title = deps.sanitizeText(title);
  title = neutralizeLiteralPings(title).trim();
  if (!title) return '';
  try {
    if (automod.checkText(title, { surface: 'message' }).ok === false) return '';
  } catch (err) { noteAutomodFault(err); }
  return title;
}

/**
 * Discord tag names to the Haven forum's own tag names, matched without
 * regard to case. Tags Haven does not have are left off. Pure, unit tested.
 */
function matchForumTags(discordNames, havenTagsJson) {
  let haven = [];
  try { haven = JSON.parse(havenTagsJson || '[]'); } catch { haven = []; }
  if (!Array.isArray(haven)) return [];
  const byLower = new Map();
  for (const t of haven) if (t && typeof t.name === 'string') byLower.set(t.name.toLowerCase(), t.name);
  const out = [];
  for (const n of discordNames || []) {
    const hit = byLower.get(String(n).trim().toLowerCase());
    if (hit && !out.includes(hit)) out.push(hit);
  }
  return out.slice(0, 5);
}

/**
 * Haven tag names to the Discord forum's tag ids, matched without regard to
 * case. Moderated tags are skipped: only Discord moderators may set those,
 * and asking for one fails the whole post. Discord allows five.
 */
function discordTagIdsFor(havenNames, discordTags) {
  const byLower = new Map();
  for (const t of discordTags || []) {
    if (t && t.id && t.name && !t.moderated) byLower.set(String(t.name).toLowerCase(), String(t.id));
  }
  const out = [];
  for (const n of havenNames || []) {
    const id = byLower.get(String(n).trim().toLowerCase());
    if (id && !out.includes(id)) out.push(id);
  }
  return out.slice(0, 5);
}

// The tag names on a Discord post, read from its forum's tag list.
function discordTagNames(thread) {
  const forum = guilds.get(thread.guildId)?.channels.get(thread.parentId);
  if (!forum || !forum.tags) return [];
  return thread.appliedTags
    .map(id => forum.tags.find(t => t.id === id))
    .filter(Boolean)
    .map(t => t.name);
}

function relayForumStarter(msg, thread) {
  try {
    const links = inboundForumLinks(thread.parentId);
    if (!links.length) return;

    // A post the link policy refuses, in its title or its body, does not
    // come across at all, and its replies have no topic to land in.
    const title = havenTopicTitle(thread.name);
    if (!title) return;
    const content = buildHavenContent(msg);
    if (!content) return;

    const username = discordAuthorName(msg);
    const avatarUrl = discordAvatarUrl(msg.author);
    const tagNames = discordTagNames(thread);
    const remember = deps.db.prepare(`
      INSERT OR IGNORE INTO ferry_forum_threads
        (topic_message_id, channel_id, guild_id, discord_forum_id, discord_thread_id, origin)
      VALUES (?, ?, ?, ?, ?, 'discord')
    `);
    const already = deps.db.prepare(
      'SELECT 1 FROM ferry_forum_threads WHERE discord_thread_id = ? AND channel_id = ?'
    );

    const targets = [];
    for (const link of links) {
      // Discord can deliver the same event twice across a resume.
      if (already.get(thread.id, link.channel_id)) continue;
      const tags = matchForumTags(tagNames, link.forum_tags);
      const topicId = deps.insertHavenMessage({
        channelId: link.channel_id,
        channelCode: link.channel_code,
        username, avatarUrl, content,
        title,
        tags: tags.length ? tags : null,
      });
      if (!topicId) continue;
      remember.run(topicId, link.channel_id, thread.guildId || link.guild_id, thread.parentId, thread.id);
      if (thread.locked) deps.updateHavenTopic({ messageId: topicId, channelCode: link.channel_code, closed: true });
      targets.push({ havenMessageId: topicId, channelCode: link.channel_code });
      touchLink(link.id, null);
    }
    if (targets.length) rememberRelay(msg.id, content, targets);
  } catch (err) {
    console.error('Ferry forum relay error:', err.message);
  }
}

/**
 * A renamed, retagged, locked or unlocked Discord post updates its Haven
 * topic. Only topics that started on Discord follow along: a topic written in
 * Haven belongs to its Haven author, and a Discord moderator does not get to
 * retitle it. A lock closes the topic and an unlock opens it again. Archiving
 * is ignored, because Discord archives every quiet post on a timer.
 *
 * Discord sends the post's whole current state, archive and unarchive
 * included, so only the fields that changed since the previous state are
 * passed on. Otherwise a Haven moderator's close, new title or tag would be
 * undone the next time Discord archived the post. With no previous state
 * (after a restart, or for a post that was archived when Ferry connected)
 * there is no telling what Discord changed, so nothing is passed on; the next
 * real change on Discord's side is.
 */
function relayThreadUpdateToHaven(t, before) {
  try {
    if (!t || !t.id || !before) return;
    const thread = threads.get(String(t.id));
    if (!thread) return;
    const renamed = thread.name !== before.name;
    const retagged = [...thread.appliedTags].sort().join(',') !== [...before.appliedTags].sort().join(',');
    const relocked = thread.locked !== before.locked;
    if (!renamed && !retagged && !relocked) return;
    const rows = mappedTopics(thread.id).filter(r => r.inbound && r.origin === 'discord');
    if (!rows.length) return;

    const title = renamed ? havenTopicTitle(thread.name) : '';
    const tagNames = discordTagNames(thread);
    for (const r of rows) {
      const current = deps.db.prepare('SELECT title, tags, closed FROM messages WHERE id = ?').get(r.topic_message_id);
      if (!current) continue;
      const update = {};
      if (title && title !== current.title) update.title = title;
      if (retagged) {
        const forumTags = deps.db.prepare('SELECT forum_tags FROM channels WHERE id = ?').get(r.channel_id)?.forum_tags;
        const tags = matchForumTags(tagNames, forumTags);
        const tagsJson = tags.length ? JSON.stringify(tags) : null;
        if (tagsJson !== (current.tags || null)) update.tags = tags;
      }
      if (relocked && !!current.closed !== thread.locked) update.closed = thread.locked;
      if (!Object.keys(update).length) continue;
      deps.updateHavenTopic({ messageId: r.topic_message_id, channelCode: r.channel_code, ...update });
    }
  } catch (err) {
    console.error('Ferry forum update error:', err.message);
  }
}

/**
 * A post deleted on Discord is unlinked. Its Haven topic stays, the same way
 * a deleted Discord message stays in Haven, but a topic that came from
 * Discord is closed so nobody waits for answers from a post that is gone.
 * Replies to a Haven topic whose Discord copy was deleted stay in Haven.
 */
function relayThreadDeleteToHaven(d) {
  try {
    const rows = mappedTopics(d.id);
    for (const r of rows) {
      if (r.inbound && r.origin === 'discord') {
        deps.updateHavenTopic({ messageId: r.topic_message_id, channelCode: r.channel_code, closed: true });
      }
    }
    deps.db.prepare('DELETE FROM ferry_forum_threads WHERE discord_thread_id = ?').run(String(d.id));
  } catch (err) {
    console.error('Ferry forum delete error:', err.message);
  }
}

/**
 * Flattens a Discord message into the plain text Haven stores. Attachments and
 * stickers become links rather than being re-hosted: Discord CDN links are
 * signed and expire after roughly a day, so a copy in Haven's uploads folder
 * would be the only durable option and that is a disk-growth decision for the
 * admin, not something a bridge should do silently.
 */
function buildHavenContent(msg) {
  // What the Discord author actually typed, and what Discord itself attached,
  // are kept apart on purpose. Only the typed half is content somebody chose to
  // write, so only that half is worth filtering. See the automod note below.
  const authored = [];
  const media = [];

  // Custom emotes stay as Discord wrote them, <:name:id> or <a:name:id>. Every
  // Haven client renders that token as the emote itself, through the server's
  // emote cache, so nothing is lost by keeping the id. Folding it to :name:
  // used to leave a bare shortcode on any server without a same-named emoji.
  const text = translateDiscordMentions(msg.content || '', msg).trim();
  if (text) authored.push(text);

  for (const att of msg.attachments || []) {
    if (att.url) media.push(att.url);
  }
  // Discord's own client now sends a post with two or more pictures as a
  // media gallery component and leaves `attachments` empty, so walking the
  // attachments alone relayed those posts as nothing. Amnibro spotted this.
  collectComponentMedia(msg.components, media);
  for (const sticker of msg.sticker_items || []) {
    media.push(`https://media.discordapp.net/stickers/${sticker.id}.png`);
  }
  // Discord attaches two kinds of embed, and they mean different things.
  //
  // A bot composes a 'rich' embed itself, and for a stream or video
  // announcement bot that embed IS the message: the typed line is
  // "@everyone X is live", while the stream link sits in embed.url and the
  // thumbnail in embed.image. Reading the embed only when the body was empty
  // relayed that line alone, so Haven got a bare "X is live" with nothing to
  // click and nothing to look at. Rich embeds are read whether or not the bot
  // also typed something, and their url is kept because the link is the thing
  // being promoted. That link is checked against the link policy on its own,
  // so an allowlist server that has not added, say, kick.com drops just the
  // link and still relays the announcement and its picture.
  //
  // Everything else ('link', 'video', 'article', 'image', 'gifv') is Discord's
  // own unfurl of a link already in the text, so it is only worth reading
  // when there is no text at all, otherwise Haven would unfurl the same link
  // a second time. That is the link-only message shape: an empty body and one
  // embed, which would otherwise relay as nothing at all. It counts as
  // authored: the person chose to post the link, Discord only unfurled it.
  //
  // Image bots (SaucyBot and friends) are the other shape here: the picture is
  // the point of the message and it lives in embed.image, with the source page
  // in embed.url. Relaying the summary alone gave Haven a link to unfurl, and a
  // link preview is the fragile path, so a channel full of them ends up with
  // dead previews. Carrying the image URL instead lets it render as an ordinary
  // chat image, which is what was asked for.
  //
  // The image goes in media rather than authored for the same reason
  // attachments do: Ferry builds it out of Discord's own response instead of
  // anyone typing it, and running it through the link filter would throw the
  // whole message away on an allowlist server. Nothing is loosened by that,
  // because whether a viewer's browser actually fetches the image is decided by
  // the preview allowlist at render time, which is the control that exists to
  // stop a third-party host seeing everyone who scrolls past.
  const allEmbeds = (msg.embeds || []).filter(Boolean).slice(0, 10);
  const richEmbeds = allEmbeds.filter(e => e.type === 'rich');
  const embeds = richEmbeds.length ? richEmbeds
    : (!authored.length && !media.length ? allEmbeds : []);
  if (embeds.length) {
    for (const e of embeds) {
      const image = (e.image && e.image.url) || (e.thumbnail && e.thumbnail.url);
      if (image) media.push(image);
    }
    const e = embeds[0];
    let link = typeof e.url === 'string' ? e.url : '';
    if (e.type === 'rich') {
      // The promoted link stands or falls on its own, never taking the
      // announcement down with it.
      try {
        if (link && automod.checkText(link, { surface: 'message' }).ok === false) link = '';
      } catch (err) { noteAutomodFault(err); }
    } else if (media.length) {
      // Once the image is coming through, e.url is the link that would be
      // unfurled, so it is dropped and the readable parts are kept for context.
      link = '';
    }
    // A bot that already typed the title or the link gets it once, not twice.
    const typed = authored.join('\n');
    const parts = [e.title, link, e.description]
      .filter(p => typeof p === 'string' && p.trim() && !typed.includes(p.trim()));
    const summary = parts.join(' ');
    if (summary) authored.push(summary.slice(0, 500));
  }

  const cleanOf = (str) => (deps?.sanitizeText ? deps.sanitizeText(str) : str);
  const authoredText = cleanOf(authored.join('\n'));

  // A bridge is an excellent spam vector, and a relayed message would otherwise
  // skip the link controls every Haven member is held to. Checked with no user
  // context: there is no Haven account to strike, so this filters content only.
  //
  // Only the authored text goes through the filter. Attachment and sticker URLs
  // are built by Ferry out of Discord's own API response rather than typed by
  // anyone, and they live on cdn.discordapp.com / media.discordapp.net, which
  // are not on the default allowlist. Checking them meant a stock server threw
  // away every Discord message carrying an image, the text along with it. Adding
  // Discord's CDN to the allowlist instead would have opened that domain to
  // everybody on the server rather than just to the bridge.
  try {
    if (authoredText && automod.checkText(authoredText, { surface: 'message', markdown: true }).ok === false) return '';
  } catch (err) { noteAutomodFault(err); }

  // A picture referenced from both a component and an attachment goes once.
  const uniqueMedia = [...new Set(media.filter(Boolean))];
  return cleanOf([...authored, ...uniqueMedia].join('\n').slice(0, 4000));
}

function discordHttpUrl(obj) {
  if (!obj || typeof obj !== 'object') return '';
  const u = obj.url || obj.proxy_url || '';
  return /^https?:\/\//i.test(u) ? u : '';
}

// Walk a message's components (containers, sections, media galleries, file
// blocks) and collect every picture or file URL in them.
function collectComponentMedia(node, into, depth = 0) {
  if (!node || depth > 8) return;
  if (Array.isArray(node)) {
    for (const child of node) collectComponentMedia(child, into, depth + 1);
    return;
  }
  if (typeof node !== 'object') return;
  const url = discordHttpUrl(node.media) || discordHttpUrl(node.file);
  if (url) into.push(url);
  collectComponentMedia(node.items, into, depth + 1);
  collectComponentMedia(node.components, into, depth + 1);
  collectComponentMedia(node.accessory, into, depth + 1);
}

/**
 * Discord writes mentions into message text as <@1178833036244652178>. The
 * names come from the message's own `mentions` array, so this is exact rather
 * than a lookup, and an unresolved id is left as-is rather than guessed at.
 */
function translateDiscordMentions(text, msg) {
  // Anything typed as plain text that would ping a group on Haven is
  // defused first: @everyone and @here unless Discord itself says the
  // message pinged everyone (it only does when the author was allowed to),
  // and a Haven role's name typed out. A real Discord role mention,
  // translated below and only when pings are allowed, is the one way a
  // Discord message pings a Haven role.
  let out = neutralizeLiteralPings(String(text || ''), msg && msg.mention_everyone === true);
  for (const u of (msg && msg.mentions) || []) {
    if (!u || !u.id) continue;
    const name = u.global_name || u.username;
    if (!name) continue;
    out = out.split(`<@${u.id}>`).join(`@${name}`).split(`<@!${u.id}>`).join(`@${name}`);
  }
  const guild = msg && msg.guild_id ? guilds.get(String(msg.guild_id)) : null;
  return translateDiscordRefs(out, guild, {
    pingRoles: deps ? boolSetting('ferry_allow_mentions', false) : false,
    havenChannelFor: pairedHavenChannelName,
  });
}

function neutralizeLiteralPings(text, discordPingedEveryone = false) {
  let out = String(text || '');
  if (!discordPingedEveryone) out = out.replace(/(?<![\w@])@(everyone|here)\b/gi, '@\u200B$1');
  if (deps && deps.db) {
    try { out = stripRoleMentions(out, deps.db.prepare('SELECT name FROM roles').all().map(r => r.name)); } catch { /* roles table optional in tests; always present on a real server */ }
  }
  return out;
}

/**
 * Role and channel mentions from Discord, which arrive as <@&id> and <#id>.
 *
 * A role becomes @Name, so a Haven role of the same name lights up for the
 * people who hold it: the two sides ping together. That only happens when the
 * admin has pings on and the Discord role is one anybody there may mention;
 * otherwise the name shows with a zero-width space after the @, which reads
 * the same and pings nobody, the way Haven treats a role ping from someone
 * not allowed to send one.
 *
 * A channel becomes #name: the Haven channel it is paired with when there is
 * one, so it turns into a link people can click, and the Discord name when
 * there is not. Unknown ids are left as they are rather than guessed at.
 */
function translateDiscordRefs(text, guild, { pingRoles = false, havenChannelFor = null } = {}) {
  let out = String(text || '');
  if (!guild) return out;
  out = out.replace(/<@&([0-9]{15,25})>/g, (full, id) => {
    const r = guild.roles && guild.roles.get(id);
    if (!r) return full;
    return (pingRoles && r.mentionable ? '@' : '@\u200B') + r.name;
  });
  out = out.replace(/<#([0-9]{15,25})>/g, (full, id) => {
    const haven = havenChannelFor ? havenChannelFor(id) : null;
    const name = haven || (guild.channelNames && guild.channelNames.get(id)) || (guild.channels && guild.channels.get(id)?.name);
    return name ? '#' + String(name).replace(/\s+/g, '_') : full;
  });
  return out;
}

// The Haven channel a Discord channel is paired with, by name, if any.
function pairedHavenChannelName(discordChannelId) {
  if (!deps || !deps.db) return null;
  try {
    const row = deps.db.prepare(`
      SELECT c.name FROM ferry_links f JOIN channels c ON f.channel_id = c.id
      WHERE f.discord_channel_id = ? AND f.is_active = 1 ORDER BY f.id LIMIT 1
    `).get(String(discordChannelId));
    return row ? row.name : null;
  } catch { return null; }
}

// The Discord channel a Haven channel is paired with in one guild, by the
// Haven channel's name (a #name in a Haven message).
function pairedDiscordChannelId(guildId, havenName) {
  if (!deps || !deps.db) return null;
  try {
    const rows = deps.db.prepare(`
      SELECT f.discord_channel_id, c.name FROM ferry_links f JOIN channels c ON f.channel_id = c.id
      WHERE f.guild_id = ? AND f.is_active = 1
    `).all(String(guildId));
    const want = String(havenName).toLowerCase();
    const hit = rows.filter(r => r.name && (r.name.toLowerCase() === want || r.name.toLowerCase().replace(/\s+/g, '_') === want));
    return hit.length === 1 ? hit[0].discord_channel_id : null;
  } catch { return null; }
}

/**
 * The other way round: a Haven @Role and #channel go out as Discord's own
 * <@&id> and <#id>. Returns the text and the role ids it may ping.
 *
 * A role is only turned into a ping when pings are on and the Discord role is
 * one anybody there may mention, which is Discord's own rule for a member
 * typing it. A Haven sender who may not ping roles here has had the ping
 * broken with a zero-width space before this runs, so it never matches.
 * Names are matched whole and case-insensitively; two roles sharing a name is
 * ambiguous, and neither is pinged.
 *
 * A channel is the one its Haven channel is paired with in this guild, or
 * failing that the one Discord channel with that name. Channel links ping
 * nobody, so they are translated whether or not pings are on.
 */
function translateHavenRefs(content, guild, { pingRoles = false, discordChannelFor = null } = {}) {
  let text = String(content || '');
  const roleIds = [];
  if (!guild) return { content: text, roleIds };
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  if (pingRoles && guild.roles && guild.roles.size && text.includes('@')) {
    const byName = new Map();
    for (const r of guild.roles.values()) {
      const key = r.name.toLowerCase();
      byName.set(key, byName.has(key) ? null : r);
    }
    const names = [...byName.keys()].filter(k => byName.get(k) && byName.get(k).mentionable)
      .sort((a, b) => b.length - a.length);
    if (names.length) {
      const re = new RegExp(`(?<![\\w@<])@(${names.map(esc).join('|')})(?![\\w])`, 'gi');
      text = text.replace(re, (full, name) => {
        const r = byName.get(name.toLowerCase());
        if (!r) return full;
        if (!roleIds.includes(r.id)) roleIds.push(r.id);
        return `<@&${r.id}>`;
      });
    }
  }

  if (text.includes('#')) {
    const byName = new Map();
    const names = guild.channelNames && guild.channelNames.size ? guild.channelNames : new Map([...(guild.channels || new Map()).values()].map(c => [c.id, c.name]));
    for (const [id, name] of names) {
      const key = String(name).toLowerCase();
      byName.set(key, byName.has(key) ? null : id);
    }
    text = text.replace(/(?<![\w#&<\/])#([\p{L}\p{N}_-]{1,100})/gu, (full, name) => {
      const lower = name.toLowerCase();
      const id = (discordChannelFor && discordChannelFor(lower))
        || byName.get(lower) || byName.get(lower.replace(/_/g, '-'));
      return id ? `<#${id}>` : full;
    });
  }
  return { content: text, roleIds };
}

/**
 * Turns a Haven :name: into the paired guild's own emote, <:name:id>, so it
 * shows as a picture on the Discord side instead of a shortcode. Only names the
 * guild actually has are touched. A token already in Discord's form is left
 * alone, and so is anything glued to other text, like the colons in a time.
 */
function translateHavenEmotes(content, emojis) {
  const text = String(content || '');
  if (!emojis || !emojis.size) return text;
  return text.replace(/(?<![<\w]):([A-Za-z0-9_]{2,32}):(?![\w>])/g, (full, name) => {
    const e = emojis.get(name.toLowerCase());
    return e ? `<${e.animated ? 'a' : ''}:${e.name}:${e.id}>` : full;
  });
}

function discordAvatarUrl(author) {
  if (!author) return null;
  if (author.avatar) {
    const ext = author.avatar.startsWith('a_') ? 'gif' : 'png';
    return `https://cdn.discordapp.com/avatars/${author.id}/${author.avatar}.${ext}?size=64`;
  }
  // Post-migration accounts use (id >> 22) % 6, legacy ones use the discriminator.
  const idx = author.discriminator && author.discriminator !== '0'
    ? Number(author.discriminator) % 5
    : Number((BigInt(author.id) >> 22n) % 6n);
  return `https://cdn.discordapp.com/embed/avatars/${idx}.png`;
}

// ══════════════════════════════════════════════════════════════
// Haven → Discord
// ══════════════════════════════════════════════════════════════

/**
 * Discord rejects webhook usernames containing "discord" or "clyde", and caps
 * them at 80 characters. A rejected username fails the whole send, so the name
 * is repaired rather than passed through and hoped for.
 */
function sanitizeWebhookUsername(name) {
  let out = String(name || 'Haven user').replace(/discord/gi, 'disc0rd').replace(/clyde/gi, 'clyd3');
  out = out.replace(/[\r\n]+/g, ' ').trim();
  if (!out) out = 'Haven user';
  return out.slice(0, MAX_WEBHOOK_USERNAME);
}

/**
 * Haven avatars are server-relative paths, which Discord cannot fetch. Only a
 * configured PUBLIC_URL can turn them into something Discord's CDN can reach;
 * without one we send no avatar rather than a broken link.
 */
function absoluteAvatarUrl(avatar) {
  if (!avatar || typeof avatar !== 'string') return null;
  if (/^https?:\/\//i.test(avatar)) return avatar;
  const base = (process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
  if (!base) return null;
  return base + (avatar.startsWith('/') ? avatar : '/' + avatar);
}

function absolutizeUploads(content) {
  const base = (process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
  if (!base) return content;
  return content.replace(/(^|\s)(\/uploads\/[^\s]+)/g, (_m, pre, p) => `${pre}${base}${p}`);
}

/**
 * Mentions are blocked by default. Without this a single Haven user could
 * @everyone someone else's Discord server through the bridge, and the server
 * owner would see it as coming from the bot they installed.
 */
function mentionPolicy(roleIds = []) {
  if (!boolSetting('ferry_allow_mentions', false)) return { parse: [] };
  // Never @everyone. Roles only by id, the ones translateHavenRefs checked.
  return roleIds.length ? { parse: ['users'], roles: roleIds.slice(0, 100) } : { parse: ['users'] };
}

/**
 * Turns "@Name" in an outgoing message into a real Discord ping.
 *
 * Discord only pings when the text contains <@id>, so a relayed "@alice" is
 * inert plain text no matter what allowed_mentions says. Names are resolved
 * against the destination guild, and only an exact case-insensitive hit on a
 * username, global name, or nickname is replaced. Anything ambiguous or
 * unmatched is left as written, because quietly pinging the wrong person is
 * worse than not pinging at all.
 *
 * Skipped entirely when pings are off, so the lookup cost is only paid by
 * servers that asked for the feature.
 */
const mentionCache = new Map();   // `${guildId}:${lowercased name}` -> id or null
const MENTION_TTL_MS = 300000;

async function resolveOutgoingMentions(guildId, content) {
  if (!boolSetting('ferry_allow_mentions', false)) return content;
  if (!SNOWFLAKE.test(String(guildId || ''))) return content;

  // Deliberately conservative: a run of name-ish characters, no spaces. A
  // greedier pattern would swallow following words and match nobody.
  const names = [...new Set((String(content).match(/@[A-Za-z0-9._-]{2,32}/g) || []))];
  if (!names.length) return content;

  let out = content;
  for (const token of names.slice(0, 5)) {
    const bare = token.slice(1);
    const key = `${guildId}:${bare.toLowerCase()}`;
    const now = Date.now();

    let hit = mentionCache.get(key);
    if (!hit || now - hit.at > MENTION_TTL_MS) {
      let id = null;
      try {
        const rows = await discordRequest('GET', `/guilds/${guildId}/members/search?query=${encodeURIComponent(bare)}&limit=10`);
        const wanted = bare.toLowerCase();
        const exact = (rows || []).filter(m => m.user && !m.user.bot && [
          m.nick, m.user.global_name, m.user.username
        ].some(n => n && String(n).toLowerCase() === wanted));
        // More than one person answering to the same name is ambiguous, and
        // picking one would ping a stranger.
        if (exact.length === 1) id = exact[0].user.id;
      } catch (err) {
        // 403 means the Server Members intent is off. Leave the text alone.
        if (err.status !== 403 && err.status !== 404) {
          console.error('Ferry mention lookup failed:', err.message);
        }
      }
      hit = { id, at: now };
      if (mentionCache.size > 500) mentionCache.clear();
      mentionCache.set(key, hit);
    }

    if (hit.id) out = out.split(token).join(`<@${hit.id}>`);
  }
  return out;
}

/**
 * Serializes sends per destination. Discord rate limits each webhook at about
 * five messages per two seconds and answers a burst with 429s, so a busy
 * mirrored channel needs a queue rather than parallel fire-and-forget.
 */
function enqueue(key, task) {
  const prev = sendQueues.get(key) || Promise.resolve();
  const run = prev.then(task);
  // The stored chain swallows failures so one rejected send does not poison
  // every later message to the same destination. The caller still sees the
  // real rejection through `run`.
  const chain = run.catch(() => { /* the caller sees this failure through run */ });
  sendQueues.set(key, chain);
  // Drop the entry once drained, so the map does not grow one dead promise per
  // destination for the life of the process.
  chain.then(() => { if (sendQueues.get(key) === chain) sendQueues.delete(key); });
  return run;
}

/**
 * Finds or creates the Discord webhook a pairing sends through. Creating it
 * needs Manage Webhooks on the bot; when that is missing the error is stored on
 * the pairing so the admin sees the actual reason in the UI.
 */
async function ensureLinkWebhook(link) {
  if (link.webhook_id && link.webhook_token) {
    ownWebhookIds.add(link.webhook_id);
    return { id: link.webhook_id, token: link.webhook_token };
  }

  // Reuse a webhook we made earlier in this channel before creating another,
  // so repaired pairings do not pile up webhooks against Discord's per-channel
  // limit of 15.
  let created = null;
  try {
    const existing = await discordRequest('GET', `/channels/${link.discord_channel_id}/webhooks`);
    created = (existing || []).find(w => w.token && botUser && w.application_id === botUser.id) || null;
  } catch { /* cannot list webhooks: fall through to create, which reports its own error */ }

  if (!created) {
    created = await discordRequest('POST', `/channels/${link.discord_channel_id}/webhooks`, { name: 'Haven Ferry' });
  }
  if (!created || !created.id || !created.token) {
    throw new Error('Discord did not return a usable webhook');
  }

  deps.db.prepare('UPDATE ferry_links SET webhook_id = ?, webhook_token = ? WHERE id = ?')
    .run(created.id, created.token, link.id);
  ownWebhookIds.add(created.id);
  return { id: created.id, token: created.token };
}

/**
 * Relays one Haven message to one paired Discord channel, as the Haven author.
 */
async function sendToDiscord(link, { username, avatar, content }) {
  const guild = guilds.get(String(link.guild_id || ''));
  const body = outboundBody(content, guild);
  if (!body.trim()) return;
  if (isForumType(link.discord_channel_type)) { touchLink(link.id, KIND_MISMATCH); return; }

  return enqueue(`ch:${link.discord_channel_id}`, async () => {
    try {
      const hook = await ensureLinkWebhook(link);
      await executeWebhook(hook.id, hook.token, await webhookPayload(link, guild, { username, avatar, body }));
      touchLink(link.id, null);
    } catch (err) {
      throw sendFailure(link, err);
    }
  });
}

// Haven's text made ready for Discord: uploads as full links, :name: as the
// guild's own emotes, and cut to Discord's length limit.
function outboundBody(content, guild) {
  return translateHavenEmotes(absolutizeUploads(String(content || '')), guild && guild.emojis)
    .slice(0, MAX_DISCORD_CONTENT);
}

// The webhook body for one relayed message, shown as its Haven author.
async function webhookPayload(link, guild, { username, avatar, body }) {
  // Resolved per destination: the same @name can be a different person in
  // a different Discord server.
  const withMentions = await resolveOutgoingMentions(link.guild_id, body);
  // Roles and channels after people, so a person who shares a role's
  // name is the one pinged, the same as in Haven.
  const refs = translateHavenRefs(withMentions, guild, {
    pingRoles: boolSetting('ferry_allow_mentions', false),
    discordChannelFor: (name) => pairedDiscordChannelId(link.guild_id, name),
  });
  return {
    content: refs.content.slice(0, MAX_DISCORD_CONTENT),
    username: sanitizeWebhookUsername(username),
    avatar_url: absoluteAvatarUrl(avatar) || undefined,
    allowed_mentions: mentionPolicy(refs.roleIds),
  };
}

/**
 * Turns a failed send into the sentence the admin sees on the pairing and the
 * author sees in a toast, and repairs what can be repaired.
 */
function sendFailure(link, err) {
  // A 10015 means the webhook was deleted on Discord's side. Clear it so
  // the next send recreates one instead of failing forever.
  if (err.discordCode === 10015 || (err.status === 404 && err.discordCode !== 10003)) {
    deps.db.prepare('UPDATE ferry_links SET webhook_id = NULL, webhook_token = NULL WHERE id = ?').run(link.id);
  }
  let reason = err.message;
  if (err.status === 403) reason = 'The bot needs the "Manage Webhooks" permission in that Discord channel.';
  // Discord's codes for "this forum needs a tag on every post", and for a
  // forum webhook sent without a post to go in.
  else if (err.discordCode === 40067) reason = 'That Discord forum requires a tag on every post. Give the Haven forum a tag with the same name as one of the Discord forum\'s tags, and tag the topic with it.';
  else if (err.discordCode === 220001) reason = KIND_MISMATCH;
  touchLink(link.id, reason);
  return new Error(reason);
}

// ══════════════════════════════════════════════════════════════
// Forums, Haven → Discord
// ══════════════════════════════════════════════════════════════

/**
 * A Discord post's name. Discord needs one of 1 to 100 characters, and a
 * Haven topic always has a title, but an older client can post without one,
 * so the first line of the body stands in.
 */
function forumThreadName(title, body) {
  const pick = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  let name = pick(title) || pick(String(body || '').split('\n')[0]) || 'Haven topic';
  if (name.length > 100) name = name.slice(0, 99) + '…';
  return name;
}

const NSFW_HELD = 'This topic is marked NSFW and the paired Discord forum is not age-restricted, so it stayed in Haven. Mark the Discord forum as age-restricted to carry NSFW topics.';

// Whether a Haven topic is marked NSFW, read from the stored topic so it holds
// whatever the caller passed along.
function topicIsNsfw(topicId) {
  if (!Number.isInteger(topicId)) return false;
  try {
    return !!deps.db.prepare('SELECT nsfw FROM messages WHERE id = ?').get(topicId)?.nsfw;
  } catch { return false; }
}

// Whether the paired Discord forum is age-restricted. Comes from the channel
// Discord sent on connect and on every change. Not knowing counts as no.
function discordForumIsNsfw(guild, link) {
  const forum = guild && guild.channels.get(String(link.discord_channel_id));
  return !!(forum && forum.nsfw === true);
}

/**
 * A new topic in a paired Haven forum becomes a new post in the Discord forum,
 * made through the pairing's webhook so it shows the Haven author. Discord
 * makes the post when the webhook call carries `thread_name`, and answers with
 * the post's first message, whose channel is the new post.
 */
async function sendTopicToDiscord(link, { username, avatar, content, title, tags, topicId, nsfw = false }) {
  const guild = guilds.get(String(link.guild_id || ''));
  const body = outboundBody(content, guild);
  if (!body.trim()) return;
  if (!isForumType(link.discord_channel_type)) { touchLink(link.id, KIND_MISMATCH); return; }
  // An NSFW topic only goes to a Discord forum that is age-restricted too.
  // Held back, it has no Discord post, so its replies stay in Haven as well.
  if ((nsfw === true || topicIsNsfw(topicId)) && !discordForumIsNsfw(guild, link)) {
    touchLink(link.id, NSFW_HELD);
    throw new Error(NSFW_HELD);
  }

  return enqueue(`ch:${link.discord_channel_id}`, async () => {
    try {
      const hook = await ensureLinkWebhook(link);
      const payload = await webhookPayload(link, guild, { username, avatar, body });
      payload.thread_name = forumThreadName(title, body);
      const forum = guild && guild.channels.get(String(link.discord_channel_id));
      const tagIds = discordTagIdsFor(tags, forum && forum.tags);
      if (tagIds.length) payload.applied_tags = tagIds;
      const sent = await executeWebhook(hook.id, hook.token, payload);
      const threadId = String((sent && (sent.channel_id || sent.id)) || '');
      if (SNOWFLAKE.test(threadId) && Number.isInteger(topicId)) {
        deps.db.prepare(`
          INSERT OR IGNORE INTO ferry_forum_threads
            (topic_message_id, channel_id, guild_id, discord_forum_id, discord_thread_id, origin)
          VALUES (?, ?, ?, ?, ?, 'haven')
        `).run(topicId, link.channel_id, String(link.guild_id), String(link.discord_channel_id), threadId);
      }
      touchLink(link.id, null);
    } catch (err) {
      throw sendFailure(link, err);
    }
  });
}

/**
 * A reply in a Haven topic goes into the Discord post the topic is linked to,
 * through the same webhook with `thread_id`. A topic with no Discord post
 * (written before the pairing, or its post was deleted on Discord) keeps its
 * replies in Haven. The lookup runs inside the queue, so a reply sent right
 * after its topic waits for the topic's post to exist.
 */
async function sendReplyToDiscord(link, { username, avatar, content, topicId }) {
  const guild = guilds.get(String(link.guild_id || ''));
  const body = outboundBody(content, guild);
  if (!body.trim()) return;
  if (!isForumType(link.discord_channel_type)) return;

  return enqueue(`ch:${link.discord_channel_id}`, async () => {
    const row = deps.db.prepare(
      'SELECT discord_thread_id FROM ferry_forum_threads WHERE topic_message_id = ? AND channel_id = ? AND discord_forum_id = ?'
    ).get(topicId, link.channel_id, String(link.discord_channel_id));
    if (!row) return;
    // A topic marked NSFW after its post was made stops sending replies to a
    // forum that is not age-restricted.
    if (topicIsNsfw(topicId) && !discordForumIsNsfw(guild, link)) {
      throw new Error('This topic is marked NSFW and the paired Discord forum is not age-restricted, so this reply stayed in Haven.');
    }
    try {
      const hook = await ensureLinkWebhook(link);
      await executeWebhook(hook.id, hook.token,
        await webhookPayload(link, guild, { username, avatar, body }),
        { threadId: row.discord_thread_id });
      touchLink(link.id, null);
    } catch (err) {
      // 10003 is "unknown channel": the post is gone, so forget it.
      if (err.discordCode === 10003) {
        deps.db.prepare('DELETE FROM ferry_forum_threads WHERE discord_thread_id = ?').run(row.discord_thread_id);
        throw new Error('That Discord post was deleted, so replies now stay in Haven.');
      }
      // Discord's codes for a locked or archived post.
      if (err.discordCode === 160005 || err.discordCode === 50083) {
        throw new Error('That Discord post is locked, so this reply stayed in Haven.');
      }
      throw sendFailure(link, err);
    }
  });
}

/**
 * DMs cannot be impersonated, so the Haven author's name goes in the body. The
 * footer is not decoration: a Discord user who replies to this DM is replying
 * to the bot, and nothing carries that reply back into Haven.
 */
async function sendDiscordDm(discordUserId, { fromName, content }) {
  const cfg = getConfig();
  if (!cfg.allowDms) throw new Error('Discord DMs are turned off for this server');

  const body = absolutizeUploads(String(content || '')).trim();
  if (!body) throw new Error('Message is empty');

  return enqueue(`dm:${discordUserId}`, async () => {
    let channel;
    try {
      channel = await discordRequest('POST', '/users/@me/channels', { recipient_id: discordUserId });
    } catch (err) {
      throw new Error(err.status === 403
        ? 'Discord would not open a DM with that user.'
        : `Could not open a Discord DM: ${err.message}`);
    }

    const prefix = `**${sanitizeWebhookUsername(fromName)}** sent this from Haven:\n`;
    const footer = '\n\n_Replies to this DM stay in Discord and do not reach Haven._';
    const room = MAX_DISCORD_CONTENT - prefix.length - footer.length;

    try {
      await discordRequest('POST', `/channels/${channel.id}/messages`, {
        content: prefix + body.slice(0, room) + footer,
        allowed_mentions: mentionPolicy(),
      });
    } catch (err) {
      // 50007 is Discord's "this user does not accept DMs from me".
      if (err.discordCode === 50007) {
        throw new Error('That Discord user does not accept DMs from this bot. They have to share a server with it and allow DMs from server members.');
      }
      throw new Error(`Discord rejected the DM: ${err.message}`);
    }
  });
}

/**
 * Answers whether a Discord user can be DMed from a given Haven channel, by
 * checking that they are a member of at least one guild that channel is paired
 * with.
 *
 * This exists because scoping the autocomplete is not a control. The composer
 * only offers members of paired guilds, but the id travels with the send, and
 * a client that skips the lookup could otherwise name any user in any guild
 * the bot happens to belong to. Discord will not deliver to a stranger either
 * way, but "the other platform would probably refuse" is not authorization.
 *
 * Answers are cached briefly so a burst of messages to one person is one
 * lookup rather than one per message.
 */
const dmAuthCache = new Map();   // `${guildId}:${userId}` -> { ok, at }
const DM_AUTH_TTL_MS = 60000;

async function authorizeDmTarget(guildIds, userId) {
  if (!SNOWFLAKE.test(String(userId || ''))) return false;
  if (!Array.isArray(guildIds) || !guildIds.length) return false;

  const now = Date.now();
  // Bound the cache so a long-lived server does not accumulate one entry per
  // id anyone has ever typed.
  if (dmAuthCache.size > 500) {
    for (const [k, v] of dmAuthCache) if (now - v.at > DM_AUTH_TTL_MS) dmAuthCache.delete(k);
  }

  for (const guildId of guildIds.slice(0, 5)) {
    if (!SNOWFLAKE.test(String(guildId || ''))) continue;
    const key = `${guildId}:${userId}`;
    const hit = dmAuthCache.get(key);
    if (hit && now - hit.at < DM_AUTH_TTL_MS) {
      if (hit.ok) return true;
      continue;
    }
    try {
      const member = await discordRequest('GET', `/guilds/${guildId}/members/${userId}`);
      const ok = !!(member && member.user && !member.user.bot);
      dmAuthCache.set(key, { ok, at: now });
      if (ok) return true;
    } catch (err) {
      // 404 is a definite "not in this guild" and is worth caching. A 403 means
      // the Server Members intent is off, which is not a negative answer about
      // this user, so it is never cached as one.
      if (err.status === 404) dmAuthCache.set(key, { ok: false, at: now });
      else if (err.status !== 403) console.error('Ferry DM authorization check failed:', err.message);
    }
  }
  return false;
}

function touchLink(linkId, error) {
  try {
    deps.db.prepare(
      'UPDATE ferry_links SET last_activity_at = CURRENT_TIMESTAMP, last_error = ? WHERE id = ?'
    ).run(error || null, linkId);
  } catch { /* best-effort health tracking, runs per relayed message, so not logged */ }
}

// ══════════════════════════════════════════════════════════════
// Target resolution (pure, unit tested in test/ferry.test.js)
// ══════════════════════════════════════════════════════════════

/**
 * Pulls an explicit `=>Target ` prefix off a message.
 *
 * Matching runs against the caller's own pairings rather than a regex, because
 * Discord server names contain spaces and no delimiter reliably separates the
 * target from the message body. The candidate list is short and
 * admin-controlled, so longest-label-first prefix matching is both exact and
 * cheap.
 *
 * Returns { link, body } for a channel target, { dm: true, discordUserId, body }
 * for a DM, or null when the message is not addressed at all.
 */
function resolveFerryTarget({ trigger, links, content, dmUserId, allowDms }) {
  const trig = trigger || '=>';
  if (typeof content !== 'string' || !content.startsWith(trig)) return null;

  const rest = content.slice(trig.length);

  // "=>@" is a DM. The user id comes from the composer's live Discord lookup
  // rather than from the text, because Discord display names are not unique
  // and cannot be resolved from a name alone.
  if (rest.startsWith('@')) {
    // The id arrives from the client, so it is shape-checked before it can
    // reach a Discord API path or body. Authorization that this user is
    // actually reachable from this channel happens separately, in the caller.
    if (!allowDms || typeof dmUserId !== 'string' || !SNOWFLAKE.test(dmUserId)) return null;
    const space = rest.indexOf(' ');
    return { dm: true, discordUserId: dmUserId, body: space === -1 ? '' : rest.slice(space + 1).trim() };
  }

  const labelled = [];
  for (const link of links || []) {
    if (link.guild_name && link.discord_channel_name) {
      labelled.push({ link, label: `${link.guild_name}#${link.discord_channel_name}` });
    }
    if (link.discord_channel_name) {
      labelled.push({ link, label: `#${link.discord_channel_name}` });
    }
  }
  labelled.sort((a, b) => b.label.length - a.label.length);

  const lower = rest.toLowerCase();
  for (const { link, label } of labelled) {
    const key = label.toLowerCase();
    if (lower === key) return { link, body: '' };
    if (lower.startsWith(key + ' ')) return { link, body: rest.slice(label.length + 1).trim() };
  }
  return null;
}

// ══════════════════════════════════════════════════════════════
// Directory (autocomplete source)
// ══════════════════════════════════════════════════════════════

/** Guilds and channels the bot can currently see, for the composer dropdown. */
function getDirectory() {
  const out = [];
  for (const g of guilds.values()) {
    out.push({
      id: g.id,
      name: g.name,
      channels: [...g.channels.values()]
        // `forum` lets the pairing form offer a Haven forum only Discord
        // forums, and a chat channel only the rest.
        .map(c => ({ id: c.id, name: c.name, category: c.category, type: c.type, forum: isForumType(c.type) }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Live member search for DM autocomplete. Deliberately not a full member cache:
 * a large guild is tens of thousands of members and none of them need to sit in
 * Haven's memory to answer one lookup.
 */
async function searchMembers(guildId, query) {
  if (!boolSetting('ferry_allow_dms', false)) return [];
  const q = String(query || '').trim().slice(0, 32);
  if (!q) return [];
  if (!guilds.has(guildId)) return [];

  try {
    const rows = await discordRequest('GET', `/guilds/${guildId}/members/search?query=${encodeURIComponent(q)}&limit=10`);
    return (rows || [])
      .filter(m => m.user && !m.user.bot)
      .map(m => ({
        id: m.user.id,
        name: m.nick || m.user.global_name || m.user.username,
        username: m.user.username,
        avatar: discordAvatarUrl(m.user),
      }));
  } catch (err) {
    // Almost always the Server Members intent being off. Answer empty rather
    // than breaking the composer for the user who is typing.
    if (err.status !== 403) console.error('Ferry member search failed:', err.message);
    return [];
  }
}

// ══════════════════════════════════════════════════════════════
// Lifecycle
// ══════════════════════════════════════════════════════════════

function initFerry(dependencies) {
  deps = dependencies;
  try {
    // Rebuild the loop guard from existing pairings, otherwise the first
    // messages after a restart echo straight back into Haven.
    for (const row of deps.db.prepare('SELECT webhook_id FROM ferry_links WHERE webhook_id IS NOT NULL').all()) {
      ownWebhookIds.add(row.webhook_id);
    }
  } catch (err) {
    // Without this list, the first messages after a restart can echo back into Haven.
    console.warn('[ferry] Could not load webhook ids for the loop guard:', err.message);
  }

  if (getConfig().enabled && getConfig().token) {
    connect();
  }
}

/** Called after an admin changes any Ferry setting. */
function applySettings() {
  const cfg = getConfig();
  if (cfg.enabled && cfg.token) {
    if (!running || !ws || ws.readyState === WebSocket.CLOSED) {
      dropMemberIntent = false;
      reconnectAttempts = 0;
      lastError = null;
      connect();
    }
  } else {
    stop();
  }
}

/** Full restart, used when the token changes and the old session is invalid. */
function reconnectFerry() {
  stop();
  sessionId = null;
  resumeUrl = null;
  dropMemberIntent = false;
  reconnectAttempts = 0;
  lastError = null;
  guilds.clear();
  threads.clear();
  setTimeout(() => { if (getConfig().enabled && getConfig().token) connect(); }, 250);
}

function stop() {
  running = false;
  stopHeartbeat();
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  connectedAt = null;
  if (ws) { try { ws.removeAllListeners('close'); ws.close(1000); } catch { /* already closed */ } }
  ws = null;
}

function getFerryState() {
  const cfg = getConfig();
  return {
    enabled: cfg.enabled,
    hasToken: !!cfg.token,
    connected: !!(ws && ws.readyState === WebSocket.OPEN && botUser && connectedAt),
    connectedAt,
    bot: botUser ? { id: botUser.id, username: botUser.username, avatar: discordAvatarUrl(botUser) } : null,
    guildCount: guilds.size,
    lastError,
    allowPersonas: cfg.allowPersonas,
    allowDms: cfg.allowDms,
    allowMentions: cfg.allowMentions,
    relayBots: cfg.relayBots,
    trigger: cfg.trigger,
    // The admin needs to know avatars will be missing before wondering why.
    publicUrlSet: !!(process.env.PUBLIC_URL || '').trim(),
  };
}

/** Verifies a token before it is saved, so a typo fails at paste time. */
async function verifyToken(token) {
  const res = await fetch(`${API}/users/@me`, {
    headers: { 'Authorization': `Bot ${token}`, 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(10000),
  });
  if (res.status === 401) throw new Error('Discord rejected that token.');
  if (!res.ok) throw new Error(`Discord returned HTTP ${res.status}.`);
  const user = await res.json();
  return { id: user.id, username: user.username, avatar: discordAvatarUrl(user) };
}

/**
 * Headers for reading Discord as the Ferry bot, for the Discord import. The
 * token never leaves the server: the import routes call Discord with these
 * and the client only says "use Ferry". Null when Ferry has no token.
 */
function importHeaders() {
  const { token } = getConfig();
  if (!token) return null;
  return { 'Authorization': `Bot ${token}`, 'User-Agent': USER_AGENT };
}

/** The invite link an admin needs, with exactly the permissions Ferry uses. */
function inviteUrl(applicationId) {
  // 536870912 Manage Webhooks + 2048 Send Messages + 1024 View Channel
  //  + 32768 Attach Files + 16384 Embed Links + 65536 Read Message History
  const perms = 536870912 + 2048 + 1024 + 32768 + 16384 + 65536;
  return `https://discord.com/oauth2/authorize?client_id=${applicationId}&permissions=${perms}&scope=bot`;
}

module.exports = {
  initFerry,
  // Pure helpers, exported for tests as much as for callers.
  resolveFerryTarget,
  sanitizeWebhookUsername,
  buildHavenContent,
  translateHavenEmotes,
  translateDiscordRefs,
  translateHavenRefs,
  roleMap,
  discordAvatarUrl,
  isForumType,
  matchForumTags,
  discordTagIdsFor,
  forumThreadName,
  applySettings,
  reconnectFerry,
  stopFerry: stop,
  getFerryState,
  importHeaders,
  getDirectory,
  searchMembers,
  sendToDiscord,
  sendTopicToDiscord,
  sendReplyToDiscord,
  sendDiscordDm,
  authorizeDmTarget,
  verifyToken,
  inviteUrl,
  getSetting,
  setSetting,
  getConfig,
};
