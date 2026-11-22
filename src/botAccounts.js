'use strict';

// Bot accounts: a member account that a program signs in to with a token
// instead of a password. Unlike a webhook it is a real member, so roles,
// channels and every member feature apply to it as they would to a person.
//
// Who may do what with a bot. Bot Manager is the role permission; a bot's
// Bot Creators are the people on its own list, plus whoever made it.
//   make one                    the admin, or Bot Manager
//   token, name, picture,       the admin, Bot Manager, and the bot's
//   enable or disable           Bot Creators
//   change its Bot Creators     the admin, or Bot Manager
//   delete it                   Bot Manager while it has never posted; once
//                               it has, only the admin, and its messages go
// Its roles and channels are not a Bot Creator's to change: those go through
// role management and Manage members, with the usual rules.

const { nameRefusal } = require('./blockedNames');
const createPermissions = require('./socketHandlers/permissions');

const ADMIN_USERNAME = (process.env.ADMIN_USERNAME || 'admin').toLowerCase();

// Never a bcrypt hash, so no password can ever match it.
const NO_PASSWORD = '!bot-no-password';

function ensureTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bot_creators (
      bot_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (bot_id, user_id)
    );
  `);
}

function getBot(db, botId) {
  return db.prepare('SELECT id, username, display_name, avatar, bot_disabled, bot_created_by, is_admin FROM users WHERE id = ? AND is_bot = 1').get(botId) || null;
}

// What this person may do with the bot: { bot, full }, where full means
// the admin or Bot Manager, or null when they may do nothing with it.
function access(db, actor, botId, userHasPermission) {
  const bot = Number.isInteger(botId) ? getBot(db, botId) : null;
  if (!bot || !actor) return null;
  const full = !!actor.isAdmin || !!userHasPermission(actor.id, 'manage_bots');
  if (!full && !isCreatorOf(db, bot, actor.id)) return null;
  // Whoever holds a bot's token acts with the bot's roles. So nobody but
  // the admin manages a bot that outranks them, or one that is the admin:
  // a new token would hand them that rank.
  if (!actor.isAdmin) {
    if (bot.is_admin) return null;
    const { getUserEffectiveLevel } = createPermissions(db);
    if (getUserEffectiveLevel(bot.id) > getUserEffectiveLevel(actor.id)) return null;
  }
  return { bot, full };
}

function isCreatorOf(db, bot, userId) {
  return bot.bot_created_by === userId
    || !!db.prepare('SELECT 1 FROM bot_creators WHERE bot_id = ? AND user_id = ?').get(bot.id, userId);
}

// Whether this person is a Bot Creator of any bot, for showing them the
// Bots page in Admin settings.
function isBotCreator(db, userId) {
  return !!db.prepare(`
    SELECT 1 FROM users u WHERE u.is_bot = 1 AND (u.bot_created_by = ?
      OR EXISTS (SELECT 1 FROM bot_creators c WHERE c.bot_id = u.id AND c.user_id = ?)) LIMIT 1
  `).get(userId, userId);
}

// A bot's name follows the rules for usernames, and like a username
// it must be free. Returns { name } or { error }.
function checkName(db, raw, botId = null) {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (name.length < 3 || name.length > 20) return { error: 'A bot name must be 3 to 20 characters' };
  if (!/^[a-zA-Z0-9_]+$/.test(name)) return { error: 'A bot name may use letters, numbers and underscores only' };
  // The ADMIN_USERNAME name is what admin recovery and first-run setup
  // trust, so no bot takes it (registration refuses it the same way).
  if (name.toLowerCase() === ADMIN_USERNAME) return { error: 'That name is already taken on this server' };
  const blocked = nameRefusal(db, name);
  if (blocked) return { error: blocked };
  const taken = db.prepare(`
    SELECT id FROM users WHERE id != ? AND (LOWER(username) = LOWER(?) OR LOWER(COALESCE(display_name, '')) = LOWER(?)) LIMIT 1
  `).get(botId || 0, name, name);
  if (taken) return { error: 'That name is already taken on this server' };
  return { name };
}

// Which of these authors are bots, for the BOT tag in history.
function botIds(db, userIds) {
  const ids = [...new Set(userIds.filter(Number.isInteger))];
  if (!ids.length) return new Set();
  const ph = ids.map(() => '?').join(',');
  return new Set(db.prepare(`SELECT id FROM users WHERE is_bot = 1 AND id IN (${ph})`).all(...ids).map(r => r.id));
}

function messageCount(db, botId) {
  return db.prepare('SELECT COUNT(*) AS n FROM messages WHERE user_id = ?').get(botId).n;
}

module.exports = { NO_PASSWORD, botIds, ensureTable, getBot, access, isBotCreator, checkName, messageCount };
