'use strict';

// The Bots page in Settings (src/botAccounts.js has who may do what).
//
//   get-bots                       gives { bots, canCreate }
//   create-bot { name }            gives { bot, token }
//   regenerate-bot-token { botId } gives { token }
//   set-bot-disabled { botId, disabled }
//   rename-bot { botId, name }     also open to the bot itself
//   bot-avatar-changed { botId }   after a new picture was uploaded or removed
//   add-bot-creator / remove-bot-creator { botId, userId or username }
//   delete-bot { botId }
//
// Each answers through its callback: what was asked for, or { error }.
// Anyone who could be looking at a bot is told to load the list again.

const bots = require('../botAccounts');
const { issueBotToken, forgetSession, provisionNewUser } = require('../auth');
const { joinDefaultChannels } = require('./channelList');

module.exports = function register(socket, ctx) {
  const { io, db, userHasPermission, emitOnlineUsers, broadcastVoiceUsers, logAudit } = ctx;
  const { channelUsers, voiceUsers } = ctx.state;
  const audit = typeof logAudit === 'function' ? logAudit : () => {};
  const canCreate = () => !!socket.user.isAdmin || !!userHasPermission(socket.user.id, 'manage_bots');
  const botId = (data) => (data && Number.isInteger(data.botId) ? data.botId : null);
  const reply = (cb) => (typeof cb === 'function' ? cb : () => {});

  // Every live connection of the bot.
  const botSockets = (id) => [...io.sockets.sockets.values()].filter(s => s.user && s.user.id === id);
  const signOut = (id) => botSockets(id).forEach(s => s.disconnect(true));
  const changed = () => io.emit('bots-changed');

  // A new name or picture, wherever the bot is shown right now.
  function refreshLive(id) {
    const row = db.prepare('SELECT username, display_name, avatar FROM users WHERE id = ?').get(id);
    if (!row) return;
    const name = row.display_name || row.username;
    for (const s of botSockets(id)) {
      s.user.username = row.username;
      s.user.displayName = name;
      s.user.avatar = row.avatar || null;
    }
    for (const [code, users] of channelUsers) {
      if (!users.has(id)) continue;
      Object.assign(users.get(id), { username: name, avatar: row.avatar || null });
      emitOnlineUsers(code);
    }
    for (const [code, users] of voiceUsers) {
      if (!users.has(id)) continue;
      users.get(id).username = name;
      broadcastVoiceUsers(code);
    }
  }

  function describe(bot, a) {
    const creators = db.prepare(`
      SELECT u.id, COALESCE(u.display_name, u.username) AS name FROM bot_creators c
      JOIN users u ON u.id = c.user_id WHERE c.bot_id = ? ORDER BY LOWER(COALESCE(u.display_name, u.username))
    `).all(bot.id);
    const madeBy = bot.bot_created_by
      ? db.prepare('SELECT id, COALESCE(display_name, username) AS name FROM users WHERE id = ?').get(bot.bot_created_by)
      : null;
    const posted = bots.messageCount(db, bot.id) > 0;
    return {
      id: bot.id, name: bot.display_name || bot.username, avatar: bot.avatar || null,
      disabled: !!bot.bot_disabled, madeBy: madeBy || null, creators,
      editCreators: a.full, hasMessages: posted,
      canDelete: socket.user.isAdmin || (a.full && !posted),
    };
  }

  socket.on('get-bots', (data, cb) => {
    const done = reply(cb);
    try {
      const all = canCreate();
      const rows = all
        ? db.prepare('SELECT id FROM users WHERE is_bot = 1 ORDER BY LOWER(username)').all()
        : db.prepare(`
            SELECT u.id FROM users u WHERE u.is_bot = 1 AND (u.bot_created_by = ?
              OR EXISTS (SELECT 1 FROM bot_creators c WHERE c.bot_id = u.id AND c.user_id = ?))
            ORDER BY LOWER(u.username)
          `).all(socket.user.id, socket.user.id);
      const list = [];
      for (const { id } of rows) {
        const a = bots.access(db, socket.user, id, userHasPermission);
        if (a) list.push(describe(a.bot, a));
      }
      done({ bots: list, canCreate: all });
    } catch (err) {
      console.error('[bots] list failed:', err.message);
      done({ error: 'Could not load bots' });
    }
  });

  socket.on('create-bot', (data, cb) => {
    const done = reply(cb);
    if (!canCreate()) return done({ error: "You don't have permission to make bots" });
    const checked = bots.checkName(db, data && data.name);
    if (checked.error) return done({ error: checked.error });
    let bot, token;
    try {
      const id = db.prepare('INSERT INTO users (username, password_hash, is_bot, bot_created_by) VALUES (?, ?, 1, ?)')
        .run(checked.name, bots.NO_PASSWORD, socket.user.id).lastInsertRowid;
      // The roles and channels a new member gets, without the welcome post.
      // A member with no channel by then joins the default ones when they
      // first connect; a bot joins them now, so its page shows them.
      provisionNewUser(db, id, checked.name, io, { welcome: false });
      if (!db.prepare('SELECT 1 FROM channel_members WHERE user_id = ?').get(id)) joinDefaultChannels(db, id);
      bot = bots.getBot(db, id);
      token = issueBotToken(db, bot);
    } catch (err) {
      console.error('[bots] create failed:', err.message);
      return done({ error: 'Could not make the bot' });
    }
    audit({ actor: socket.user, action: 'bot_create', target_type: 'user', target_id: bot.id, target_name: bot.username });
    changed();
    done({ bot: describe(bot, bots.access(db, socket.user, bot.id, userHasPermission)), token });
  });

  socket.on('regenerate-bot-token', (data, cb) => {
    const done = reply(cb);
    const a = bots.access(db, socket.user, botId(data), userHasPermission);
    if (!a) return done({ error: 'Bot not found' });
    let token;
    try { token = issueBotToken(db, a.bot); } catch (err) {
      console.error('[bots] token failed:', err.message);
      return done({ error: 'Could not make a new token' });
    }
    // The old token is dead; so are the connections made with it.
    signOut(a.bot.id);
    audit({ actor: socket.user, action: 'bot_token_regenerate', target_type: 'user', target_id: a.bot.id, target_name: a.bot.username });
    done({ token });
  });

  socket.on('set-bot-disabled', (data, cb) => {
    const done = reply(cb);
    const a = bots.access(db, socket.user, botId(data), userHasPermission);
    if (!a) return done({ error: 'Bot not found' });
    const disabled = !!(data && data.disabled);
    db.prepare('UPDATE users SET bot_disabled = ? WHERE id = ?').run(disabled ? 1 : 0, a.bot.id);
    forgetSession(a.bot.id);
    if (disabled) signOut(a.bot.id);
    audit({ actor: socket.user, action: disabled ? 'bot_disable' : 'bot_enable', target_type: 'user', target_id: a.bot.id, target_name: a.bot.username });
    changed();
    done({ success: true, disabled });
  });

  socket.on('rename-bot', (data, cb) => {
    const done = reply(cb);
    const id = botId(data);
    // A bot may rename itself; otherwise its Bot Creators or Bot Manager.
    const self = id === socket.user.id && !!socket.user.botAccount;
    const bot = self ? bots.getBot(db, id) : bots.access(db, socket.user, id, userHasPermission)?.bot;
    if (!bot) return done({ error: 'Bot not found' });
    const checked = bots.checkName(db, data && data.name, bot.id);
    if (checked.error) return done({ error: checked.error });
    db.prepare('UPDATE users SET username = ?, display_name = ? WHERE id = ?').run(checked.name, checked.name, bot.id);
    refreshLive(bot.id);
    audit({ actor: socket.user, action: 'bot_rename', target_type: 'user', target_id: bot.id, target_name: checked.name, details: { from: bot.username } });
    changed();
    done({ success: true, name: checked.name });
  });

  // The picture is stored by /api/upload-avatar (or cleared by
  // /api/remove-avatar) with the bot's id; this shows it where the bot is live.
  socket.on('bot-avatar-changed', (data) => {
    const id = botId(data);
    if (!bots.access(db, socket.user, id, userHasPermission)) return;
    refreshLive(id);
    changed();
  });

  // Only the admin and Bot Manager change who a bot's Bot Creators are.
  function editCreators(data, cb, add) {
    const done = reply(cb);
    const a = bots.access(db, socket.user, botId(data), userHasPermission);
    if (!a || !a.full) return done({ error: "You can't change this bot's Bot Creators" });
    // By id, or by the name typed into the page.
    const name = data && typeof data.username === 'string' ? data.username.trim() : '';
    const person = data && Number.isInteger(data.userId)
      ? db.prepare('SELECT id, is_bot FROM users WHERE id = ?').get(data.userId)
      : name && db.prepare('SELECT id, is_bot FROM users WHERE LOWER(username) = LOWER(?) OR LOWER(display_name) = LOWER(?) LIMIT 1').get(name, name);
    const userId = person ? person.id : null;
    if (!person || person.is_bot) return done({ error: 'User not found' });
    if (add) db.prepare('INSERT OR IGNORE INTO bot_creators (bot_id, user_id) VALUES (?, ?)').run(a.bot.id, userId);
    else db.prepare('DELETE FROM bot_creators WHERE bot_id = ? AND user_id = ?').run(a.bot.id, userId);
    audit({ actor: socket.user, action: add ? 'bot_creator_add' : 'bot_creator_remove', target_type: 'user', target_id: a.bot.id, target_name: a.bot.username, details: { user: userId } });
    changed();
    done({ success: true });
  }
  socket.on('add-bot-creator', (data, cb) => editCreators(data, cb, true));
  socket.on('remove-bot-creator', (data, cb) => editCreators(data, cb, false));

  socket.on('delete-bot', (data, cb) => {
    const done = reply(cb);
    const a = bots.access(db, socket.user, botId(data), userHasPermission);
    if (!a) return done({ error: 'Bot not found' });
    // Once a bot has posted, deleting it clears what it said, which only the
    // admin decides.
    const posted = bots.messageCount(db, a.bot.id) > 0;
    if (posted ? !socket.user.isAdmin : !a.full) {
      return done({ error: posted ? 'This bot has posted messages, so only the admin can delete it' : "You don't have permission to delete bots" });
    }
    try {
      ctx.removeAccount({ id: a.bot.id, username: a.bot.username, display_name: a.bot.display_name }, posted, 'Bot deleted');
    } catch (err) {
      console.error('[bots] delete failed:', err.message);
      return done({ error: 'Could not delete the bot' });
    }
    audit({ actor: socket.user, action: 'bot_delete', target_type: 'user', target_id: a.bot.id, target_name: a.bot.username, details: { messagesCleared: posted } });
    changed();
    done({ success: true });
  });
};
