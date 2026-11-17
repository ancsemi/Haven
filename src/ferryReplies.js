'use strict';

// Replies across the Ferry bridge.
//
// Ferry carries messages both ways, but a reply used to arrive as a plain
// message: a Discord reply to a Haven member's message did not notify them,
// and a Haven reply showed on Discord with nothing to say what it answered.
//
// Each relayed message's two ids are kept here, the Haven message and the
// Discord one it became (or came from), with the Discord author for messages
// that came from Discord. A Discord reply then lands in Haven as a real
// reply, and a Haven reply goes to Discord led by a line that names the
// message it answers, with a jump link. A webhook cannot make a true Discord
// reply, so that line is the closest thing.

const KEEP_DAYS = 90;
const SNOWFLAKE = /^\d{5,25}$/;

let pruneCountdown = 0;

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ferry_message_map (
      haven_message_id   INTEGER NOT NULL,
      discord_message_id TEXT    NOT NULL,
      discord_channel_id TEXT    NOT NULL,
      discord_author_id  TEXT    DEFAULT NULL,
      created_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (haven_message_id, discord_message_id)
    );
    CREATE INDEX IF NOT EXISTS idx_ferry_message_map_discord ON ferry_message_map (discord_message_id);
  `);
}

// Remembers that a Haven message and a Discord message are the same one.
function recordPair(db, { havenMessageId, discordMessageId, discordChannelId, discordAuthorId = null }) {
  if (!Number.isInteger(havenMessageId) && !(typeof havenMessageId === 'bigint')) return;
  if (!SNOWFLAKE.test(String(discordMessageId || '')) || !SNOWFLAKE.test(String(discordChannelId || ''))) return;
  const author = SNOWFLAKE.test(String(discordAuthorId || '')) ? String(discordAuthorId) : null;
  db.prepare(`INSERT OR IGNORE INTO ferry_message_map (haven_message_id, discord_message_id, discord_channel_id, discord_author_id)
    VALUES (?, ?, ?, ?)`).run(Number(havenMessageId), String(discordMessageId), String(discordChannelId), author);
  // Old pairs are only needed for replies to old messages; a few hundred
  // inserts between sweeps keeps the table from growing without end.
  if (--pruneCountdown <= 0) {
    pruneCountdown = 500;
    db.prepare(`DELETE FROM ferry_message_map WHERE created_at < datetime('now', ?)`).run(`-${KEEP_DAYS} days`);
  }
}

// The Haven message, in this Haven channel, that a Discord message is.
function havenIdFor(db, channelId, discordMessageId) {
  if (!SNOWFLAKE.test(String(discordMessageId || ''))) return null;
  const copy = db.prepare('SELECT id FROM messages WHERE channel_id = ? AND discord_message_id = ?').get(channelId, String(discordMessageId));
  if (copy) return copy.id;
  const pair = db.prepare(`
    SELECT m.id FROM ferry_message_map f JOIN messages m ON m.id = f.haven_message_id
    WHERE f.discord_message_id = ? AND m.channel_id = ?
  `).get(String(discordMessageId), channelId);
  return pair ? pair.id : null;
}

// The Discord message, in this Discord channel, that a Haven message is, and
// who wrote it there when it came from Discord.
function discordFor(db, havenMessageId, discordChannelId) {
  const pair = db.prepare(`
    SELECT discord_message_id AS id, discord_author_id AS authorId FROM ferry_message_map
    WHERE haven_message_id = ? AND discord_channel_id = ?
  `).get(havenMessageId, String(discordChannelId));
  if (pair) return pair;
  // A copy of a Discord message from before its pair was kept here.
  const copy = db.prepare('SELECT discord_message_id AS id FROM messages WHERE id = ? AND discord_message_id IS NOT NULL').get(havenMessageId);
  return copy ? { id: copy.id, authorId: null } : null;
}

// One line of plain text from a message, for the line that names it.
function excerptOf(content) {
  let text = String(content || '');
  // An encrypted message has nothing readable to quote.
  if (text.charCodeAt(0) === 123) {
    try { if (JSON.parse(text).ct) return ''; } catch { /* not JSON: ordinary text */ }
  }
  text = text.replace(/\[file:[^\]]*\]\([^)]*\)/g, '📎').replace(/\s+/g, ' ').trim();
  return text.length > 80 ? text.slice(0, 77) + '...' : text;
}

// The line a Haven reply starts with on Discord, or '' when the message it
// answers is gone. Discord markdown: "-#" is small grey text.
function replyLine(db, { replyToHavenId, link, guildId }) {
  if (!replyToHavenId) return '';
  const target = db.prepare(`
    SELECT m.content, m.is_webhook, m.webhook_username, COALESCE(u.display_name, u.username) AS name
    FROM messages m LEFT JOIN users u ON u.id = m.user_id WHERE m.id = ?
  `).get(replyToHavenId);
  if (!target) return '';
  const name = target.is_webhook ? (target.webhook_username || 'Discord') : (target.name || 'someone');
  const discord = discordFor(db, replyToHavenId, link.discord_channel_id);
  // A mention shows the Discord name; whether it pings is up to the
  // admin's "Allow mentions" setting, which the message is sent under.
  const who = discord && discord.authorId ? `<@${discord.authorId}>` : `**${name.replace(/[*_`~|\\]/g, '')}**`;
  const quote = excerptOf(target.content).replace(/[*_`~|\\]/g, '');
  const jump = discord && guildId && SNOWFLAKE.test(String(guildId))
    ? ` [↗](https://discord.com/channels/${guildId}/${link.discord_channel_id}/${discord.id})`
    : '';
  return `-# ↩ ${who}${quote ? `: ${quote}` : ''}${jump}\n`;
}

module.exports = { ensureSchema, recordPair, havenIdFor, discordFor, replyLine, excerptOf };
