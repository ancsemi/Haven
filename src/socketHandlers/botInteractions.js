'use strict';

// A click on a bot's button, or a pick from its dropdown (src/botComponents.js),
// sent on to that bot's callback URL as an "interaction" event. The bot
// answers through its API: a private reply to the person (ephemeral with
// recipient_id), a new message, or an edit of the message clicked.
//
// Everything the bot is told is checked first: the person can read the
// channel, the message is this bot's, the button exists and is not greyed
// out, and a dropdown's picks are its own values.

const crypto = require('crypto');
const botComponents = require('../botComponents');
const { creatorCanReachChannel } = require('../botAccess');

module.exports = function register(socket, ctx) {
  const { db, deliverBotInteraction, floodCheck } = ctx;

  socket.on('bot-interaction', async (data, cb) => {
    const reply = typeof cb === 'function' ? cb : () => {};
    if (!socket.user || !data || typeof data !== 'object') return reply({ error: 'Invalid request' });
    const messageId = Number(data.messageId);
    const customId = typeof data.customId === 'string' ? data.customId : '';
    if (!Number.isInteger(messageId) || messageId <= 0 || !customId) return reply({ error: 'Invalid request' });
    if (floodCheck?.('botInteraction')) return reply({ error: 'Slow down a little' });

    const msg = db.prepare(`
      SELECT m.id, m.thread_id, m.is_webhook, m.webhook_id, c.id AS channel_id, c.code, c.is_dm, c.role_gate
      FROM messages m JOIN channels c ON c.id = m.channel_id WHERE m.id = ?
    `).get(messageId);
    if (!msg || msg.is_dm || !msg.is_webhook || !msg.webhook_id) return reply({ error: 'Message not found' });

    const channel = { id: msg.channel_id, is_dm: msg.is_dm, role_gate: msg.role_gate };
    const member = db.prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?').get(msg.channel_id, socket.user.id);
    if (!socket.user.isAdmin && (!member || !ctx.roleGateAllows(socket.user.id, channel))) return reply({ error: 'Message not found' });

    const component = botComponents.findComponent(botComponents.get(db, messageId).components, customId);
    if (!component || component.disabled) return reply({ error: 'That button is no longer there' });
    const picked = botComponents.checkValues(component, data.values);
    if (picked.error) return reply({ error: picked.error });

    const bot = db.prepare('SELECT id, callback_url, callback_secret, created_by FROM webhooks WHERE id = ? AND channel_id = ? AND is_active = 1')
      .get(msg.webhook_id, msg.channel_id);
    if (!bot || !bot.callback_url || !creatorCanReachChannel(db, bot.created_by, channel)) {
      return reply({ error: 'This bot is not listening' });
    }

    const result = await deliverBotInteraction(bot, {
      channelId: msg.code,
      interaction: {
        id: crypto.randomUUID(),
        type: 'component',
        message_id: messageId,
        thread_id: msg.thread_id || null,
        custom_id: customId,
        component_type: component.type,
        values: component.type === botComponents.SELECT ? picked.values : undefined,
        user: { id: socket.user.id, username: socket.user.displayName || socket.user.username },
      },
    });
    reply(result.ok ? { ok: true } : { error: 'The bot did not answer' });
  });
};
