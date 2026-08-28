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
 * DMs are the exception to the above and are deliberately limited. A bot can
 * only DM someone who shares a guild with it and has DMs open, it cannot
 * impersonate in a DM, and Discord flags accounts that DM in bulk. So DMs are
 * off by default, outbound only, and every one of them is stamped with the
 * Haven author's name in the body.
 */

const WebSocket = require('ws');
const automod = require('./automod');

const API = 'https://discord.com/api/v10';
const USER_AGENT = 'DiscordBot (https://github.com/ancsemi/Haven, 1.0)';

// ── Gateway intents ─────────────────────────────────────────
const INTENT_GUILDS          = 1 << 0;
const INTENT_GUILD_MEMBERS   = 1 << 1;   // privileged, only requested for DM lookup
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

/**
 * One REST call with bot auth. Retries once on a 429 using Discord's own
 * retry_after, and once on a 5xx. Everything else surfaces to the caller so the
 * admin UI can show the real reason a pairing is broken.
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

  if (res.status === 429 && attempt < 1) {
    let wait = 1000;
    try { wait = Math.min(10000, Math.ceil((await res.clone().json()).retry_after * 1000) || 1000); } catch { /* header-only 429 */ }
    await sleep(wait);
    return discordRequest(method, path, body, attempt + 1);
  }
  if (res.status >= 500 && attempt < 1) {
    await sleep(1500);
    return discordRequest(method, path, body, attempt + 1);
  }

  if (res.status === 204) return null;

  let payload = null;
  try { payload = await res.json(); } catch { /* empty body */ }

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
 */
async function executeWebhook(webhookId, webhookToken, payload, attempt = 0) {
  const res = await fetch(`${API}/webhooks/${webhookId}/${webhookToken}?wait=true`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });

  if (res.status === 429 && attempt < 2) {
    let wait = 1000;
    try {
      const info = await res.clone().json();
      wait = Math.min(10000, Math.ceil((info.retry_after || 1) * 1000));
    } catch { /* header-only 429, fall back to the 1s default */ }
    await sleep(wait);
    return executeWebhook(webhookId, webhookToken, payload, attempt + 1);
  }

  let data = null;
  try { data = await res.json(); } catch { /* 204 */ }
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
  let intents = INTENT_GUILDS | INTENT_GUILD_MESSAGES | INTENT_MESSAGE_CONTENT;
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

  const base = (sessionId && resumeUrl) ? resumeUrl : 'wss://gateway.discord.gg';
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
  try { ws.send(JSON.stringify(payload)); } catch { /* socket died mid-write */ }
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

    case 'CHANNEL_CREATE':
    case 'CHANNEL_UPDATE':
      cacheChannel(d);
      break;

    case 'CHANNEL_DELETE': {
      const g = guilds.get(d.guild_id);
      if (g) g.channels.delete(d.id);
      break;
    }

    case 'MESSAGE_CREATE':
      relayToHaven(d);
      break;

    case 'MESSAGE_UPDATE':
      relayEditToHaven(d);
      break;
  }
}

// Text-ish channel types worth pairing. 0 text, 5 announcement, 11/12 threads.
const RELAYABLE_TYPES = new Set([0, 5, 11, 12]);

function cacheGuild(g) {
  const channels = new Map();
  const byId = new Map((g.channels || []).map(c => [c.id, c]));
  for (const c of g.channels || []) {
    if (!RELAYABLE_TYPES.has(c.type)) continue;
    channels.set(c.id, {
      id: c.id,
      name: c.name,
      type: c.type,
      category: c.parent_id ? (byId.get(c.parent_id)?.name || null) : null,
    });
  }
  guilds.set(g.id, { id: g.id, name: g.name, icon: g.icon || null, channels });
}

function cacheChannel(c) {
  if (!c.guild_id) return;
  const g = guilds.get(c.guild_id);
  if (!g) return;
  if (!RELAYABLE_TYPES.has(c.type)) { g.channels.delete(c.id); return; }
  g.channels.set(c.id, { id: c.id, name: c.name, type: c.type, category: g.channels.get(c.id)?.category || null });
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

    const links = deps.db.prepare(`
      SELECT f.id, f.channel_id, f.direction, f.discord_channel_id, f.guild_name, f.discord_channel_name,
             c.code AS channel_code, c.name AS channel_name
      FROM ferry_links f
      JOIN channels c ON f.channel_id = c.id
      WHERE f.discord_channel_id = ? AND f.is_active = 1 AND f.direction IN ('both','to_haven')
    `).all(msg.channel_id);
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

  const text = translateDiscordEmotes(translateDiscordMentions(msg.content || '', msg)).trim();
  if (text) authored.push(text);

  for (const att of msg.attachments || []) {
    if (att.url) media.push(att.url);
  }
  for (const sticker of msg.sticker_items || []) {
    media.push(`https://media.discordapp.net/stickers/${sticker.id}.png`);
  }
  // A link-only message arrives with an empty body and one embed. Without this
  // it would relay as nothing at all. This counts as authored: the person chose
  // to post the link, Discord only unfurled it.
  if (!authored.length && !media.length && (msg.embeds || []).length) {
    const e = msg.embeds[0];
    const summary = [e.title, e.url, e.description].filter(Boolean).join(' ');
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
    if (authoredText && automod.checkText(authoredText, { surface: 'message' }).ok === false) return '';
  } catch { /* an automod fault must never take the bridge down */ }

  return cleanOf([...authored, ...media].join('\n').slice(0, 4000));
}

/**
 * Discord writes custom emotes into message text as <:name:id> (or <a:name:id>
 * when animated). Relayed raw, a Haven reader sees "<:blue_heart:117883303624>"
 * in the middle of a sentence.
 *
 * They become :name: rather than the emote's CDN image, because Haven renders a
 * bare image URL at full chat-image size. As :name: it reads correctly as text
 * and, when the Haven server happens to have an emoji of the same name, renders
 * as that emoji.
 */
/**
 * Discord writes mentions into message text as <@1178833036244652178>. The
 * names come from the message's own `mentions` array, so this is exact rather
 * than a lookup, and an unresolved id is left as-is rather than guessed at.
 */
function translateDiscordMentions(text, msg) {
  let out = String(text || '');
  for (const u of (msg && msg.mentions) || []) {
    if (!u || !u.id) continue;
    const name = u.global_name || u.username;
    if (!name) continue;
    out = out.split(`<@${u.id}>`).join(`@${name}`).split(`<@!${u.id}>`).join(`@${name}`);
  }
  return out;
}

function translateDiscordEmotes(text) {
  return String(text || '').replace(/<(a?):([A-Za-z0-9_]{2,32}):\d{15,25}>/g, ':$2:');
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
function mentionPolicy() {
  return boolSetting('ferry_allow_mentions', false)
    ? { parse: ['users'] }     // still never everyone or roles
    : { parse: [] };
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
  const chain = run.catch(() => {});
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
  } catch { /* fall through to create */ }

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
  const body = absolutizeUploads(String(content || '')).slice(0, MAX_DISCORD_CONTENT);
  if (!body.trim()) return;

  return enqueue(`ch:${link.discord_channel_id}`, async () => {
    try {
      const hook = await ensureLinkWebhook(link);
      // Resolved per destination: the same @name can be a different person in
      // a different Discord server.
      const withMentions = await resolveOutgoingMentions(link.guild_id, body);
      await executeWebhook(hook.id, hook.token, {
        content: withMentions,
        username: sanitizeWebhookUsername(username),
        avatar_url: absoluteAvatarUrl(avatar) || undefined,
        allowed_mentions: mentionPolicy(),
      });
      touchLink(link.id, null);
    } catch (err) {
      // A 10015 means the webhook was deleted on Discord's side. Clear it so
      // the next send recreates one instead of failing forever.
      if (err.discordCode === 10015 || err.status === 404) {
        deps.db.prepare('UPDATE ferry_links SET webhook_id = NULL, webhook_token = NULL WHERE id = ?').run(link.id);
      }
      const reason = err.status === 403
        ? 'The bot needs the "Manage Webhooks" permission in that Discord channel.'
        : err.message;
      touchLink(link.id, reason);
      throw new Error(reason);
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
  } catch { /* best-effort health tracking */ }
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
        .map(c => ({ id: c.id, name: c.name, category: c.category }))
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
  } catch { /* table arrives with the migration */ }

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
  discordAvatarUrl,
  applySettings,
  reconnectFerry,
  stopFerry: stop,
  getFerryState,
  getDirectory,
  searchMembers,
  sendToDiscord,
  sendDiscordDm,
  authorizeDmTarget,
  verifyToken,
  inviteUrl,
  getSetting,
  setSetting,
  getConfig,
};
