'use strict';

// A click on a bot's button, or a pick from its dropdown (src/botComponents.js).
// A webhook's goes to its callback URL as an "interaction" event, and the
// webhook answers through its API: a private reply to the person (ephemeral
// with recipient_id), a new message, or an edit of the message clicked.
// A bot account's goes straight to its own connection as a "bot-interaction"
// event, and it answers like any member, or by changing the message's parts
// with edit-bot-parts.
//
// Everything the bot is told is checked first: the person can read the
// channel, the message is this bot's, the button exists and is not greyed
// out, and a dropdown's picks are its own values.

const crypto = require('crypto');
const botComponents = require('../botComponents');
const { creatorCanReachChannel } = require('../botAccess');

module.exports = function register(socket, ctx) {
  const { io, db, deliverBotInteraction, floodCheck } = ctx;

  socket.on('bot-interaction', async (data, cb) => {
    const reply = typeof cb === 'function' ? cb : () => {};
    if (!socket.user || !data || typeof data !== 'object') return reply({ error: 'Invalid request' });
    const messageId = Number(data.messageId);
    const customId = typeof data.customId === 'string' ? data.customId : '';
    if (!Number.isInteger(messageId) || messageId <= 0 || !customId) return reply({ error: 'Invalid request' });
    if (floodCheck?.('botInteraction')) return reply({ error: 'Slow down a little' });

    const msg = db.prepare(`
      SELECT m.id, m.thread_id, m.is_webhook, m.webhook_id, m.user_id, u.is_bot, c.id AS channel_id, c.code, c.is_dm, c.role_gate
      FROM messages m JOIN channels c ON c.id = m.channel_id LEFT JOIN users u ON u.id = m.user_id WHERE m.id = ?
    `).get(messageId);
    const fromWebhook = !!(msg && msg.is_webhook && msg.webhook_id);
    if (!msg || msg.is_dm || (!fromWebhook && !msg.is_bot)) return reply({ error: 'Message not found' });

    const channel = { id: msg.channel_id, is_dm: msg.is_dm, role_gate: msg.role_gate };
    const member = db.prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?').get(msg.channel_id, socket.user.id);
    if (!socket.user.isAdmin && (!member || !ctx.roleGateAllows(socket.user.id, channel))) return reply({ error: 'Message not found' });

    const component = botComponents.findComponent(botComponents.get(db, messageId).components, customId);
    if (!component || component.disabled) return reply({ error: 'That button is no longer there' });
    const picked = botComponents.checkValues(component, data.values);
    if (picked.error) return reply({ error: picked.error });

    const interaction = {
      id: crypto.randomUUID(),
      type: 'component',
      message_id: messageId,
      thread_id: msg.thread_id || null,
      custom_id: customId,
      component_type: component.type,
      values: component.type === botComponents.SELECT ? picked.values : undefined,
      user: { id: socket.user.id, username: socket.user.displayName || socket.user.username },
    };

    if (!fromWebhook) {
      const live = [...io.sockets.sockets.values()].filter(s => s.user && s.user.id === msg.user_id);
      if (!live.length) return reply({ error: 'This bot is offline' });
      for (const s of live) s.emit('bot-interaction', { channelCode: msg.code, interaction });
      return reply({ ok: true });
    }

    const bot = db.prepare('SELECT id, callback_url, callback_secret, created_by FROM webhooks WHERE id = ? AND channel_id = ? AND is_active = 1')
      .get(msg.webhook_id, msg.channel_id);
    if (!bot || !bot.callback_url || !creatorCanReachChannel(db, bot.created_by, channel)) {
      return reply({ error: 'This bot is not listening' });
    }

    const result = await deliverBotInteraction(bot, { channelId: msg.code, interaction });
    reply(result.ok ? { ok: true } : { error: 'The bot did not answer' });
  });

  // A bot account changes the embeds and components on a message of its own:
  // each given list replaces the message's, an empty one removes them.
  socket.on('edit-bot-parts', (data, cb) => {
    const reply = typeof cb === 'function' ? cb : () => {};
    if (!socket.user || !socket.user.botAccount || !data || typeof data !== 'object') return reply({ error: 'Invalid request' });
    const messageId = Number(data.messageId);
    if (!Number.isInteger(messageId) || messageId <= 0) return reply({ error: 'Invalid request' });
    const parts = botComponents.clean(data);
    if (parts.error) return reply({ error: parts.error });
    if (parts.embeds === null && parts.components === null) return reply({ error: 'Nothing to change' });
    const msg = db.prepare('SELECT m.id, m.user_id, m.content, m.is_archived, c.code FROM messages m JOIN channels c ON c.id = m.channel_id WHERE m.id = ?').get(messageId);
    if (!msg || msg.user_id !== socket.user.id) return reply({ error: 'You can only change your own messages' });
    if (msg.is_archived) return reply({ error: 'This message is protected. Unprotect it first.' });
    const before = botComponents.get(db, messageId);
    const next = {
      embeds: parts.embeds !== null ? parts.embeds : (before.embeds || []),
      components: parts.components !== null ? parts.components : (before.components || []),
    };
    if (!msg.content && !next.embeds.length && !next.components.length) return reply({ error: 'The message would be left empty' });
    botComponents.record(db, messageId, next);
    io.to(`channel:${msg.code}`).emit('message-bot-parts', { channelCode: msg.code, messageId, embeds: next.embeds, components: next.components });
    reply({ success: true });
  });
};
