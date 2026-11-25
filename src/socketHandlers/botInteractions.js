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
//
// A bot may answer a click with a form of text boxes (Discord's modal): a
// webhook in its reply to the interaction, a bot account with
// open-bot-modal within a few seconds. The form opens for the person who
// clicked, on the device they clicked on, and what they send back reaches
// the bot as a "modal_submit" interaction only if it is that form, still
// open, with one answer per box that passes the box's rules.

const crypto = require('crypto');
const botComponents = require('../botComponents');
const { creatorCanReachChannel } = require('../botAccess');

// Shared by every connection, and kept in memory only: both are short lived.
const ANSWER_MS = 5000;           // a bot account answers a click with a form within this
const FORM_MS = 15 * 60 * 1000;   // a person has this long to fill one in
const clicks = new Map();         // interaction id: a bot account's click it may still answer
const forms = new Map();          // form id: a form open on someone's screen

function sweep(map) {
  const now = Date.now();
  for (const [id, entry] of map) if (entry.expires < now) map.delete(id);
}

module.exports = function register(socket, ctx) {
  const { io, db, deliverBotInteraction, floodCheck } = ctx;

  const maxChars = () => parseInt(db.prepare("SELECT value FROM server_settings WHERE key = 'max_message_chars'").get()?.value) || 2000;
  const clicker = () => ({ id: socket.user.id, username: socket.user.displayName || socket.user.username });

  // The bot message behind a click or a form, while this person can still
  // read its channel; null otherwise.
  function botMessage(messageId) {
    const msg = db.prepare(`
      SELECT m.id, m.thread_id, m.is_webhook, m.webhook_id, m.user_id, u.is_bot, c.id AS channel_id, c.code, c.is_dm, c.role_gate
      FROM messages m JOIN channels c ON c.id = m.channel_id LEFT JOIN users u ON u.id = m.user_id WHERE m.id = ?
    `).get(messageId);
    const fromWebhook = !!(msg && msg.is_webhook && msg.webhook_id);
    if (!msg || msg.is_dm || (!fromWebhook && !msg.is_bot)) return null;
    const channel = { id: msg.channel_id, is_dm: msg.is_dm, role_gate: msg.role_gate };
    const member = db.prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?').get(msg.channel_id, socket.user.id);
    if (!socket.user.isAdmin && (!member || !ctx.roleGateAllows(socket.user.id, channel))) return null;
    return { ...msg, fromWebhook, channel };
  }

  // Hands an interaction to the bot behind msg: a bot account over its own
  // connection, a webhook at its callback URL. { ok, body } or { error }.
  async function deliver(msg, interaction) {
    if (!msg.fromWebhook) {
      const live = [...io.sockets.sockets.values()].filter(s => s.user && s.user.id === msg.user_id);
      if (!live.length) return { error: 'This bot is offline' };
      for (const s of live) s.emit('bot-interaction', { channelCode: msg.code, interaction });
      return { ok: true };
    }
    const bot = db.prepare('SELECT id, callback_url, callback_secret, created_by FROM webhooks WHERE id = ? AND channel_id = ? AND is_active = 1')
      .get(msg.webhook_id, msg.channel_id);
    if (!bot || !bot.callback_url || !creatorCanReachChannel(db, bot.created_by, msg.channel)) {
      return { error: 'This bot is not listening' };
    }
    const result = await deliverBotInteraction(bot, { channelId: msg.code, interaction });
    return result.ok ? { ok: true, body: result.body } : { error: 'The bot did not answer' };
  }

  // Puts a form on the screen of the person who clicked. One at a time: a
  // new one replaces theirs. False when that connection is gone.
  function showForm(click, modal) {
    const target = io.sockets.sockets.get(click.socketId);
    if (!target) return false;
    for (const [id, f] of forms) if (f.userId === click.userId) forms.delete(id);
    sweep(forms);
    const formId = crypto.randomUUID();
    forms.set(formId, { userId: click.userId, messageId: click.messageId, modal, expires: Date.now() + FORM_MS });
    target.emit('bot-modal', { formId, title: modal.title, components: modal.components });
    return true;
  }

  socket.on('bot-interaction', async (data, cb) => {
    const reply = typeof cb === 'function' ? cb : () => {};
    if (!socket.user || !data || typeof data !== 'object') return reply({ error: 'Invalid request' });
    const messageId = Number(data.messageId);
    const customId = typeof data.customId === 'string' ? data.customId : '';
    if (!Number.isInteger(messageId) || messageId <= 0 || !customId) return reply({ error: 'Invalid request' });
    if (floodCheck?.('botInteraction')) return reply({ error: 'Slow down a little' });

    const msg = botMessage(messageId);
    if (!msg) return reply({ error: 'Message not found' });

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
      user: clicker(),
    };

    const click = { userId: socket.user.id, socketId: socket.id, messageId, channelId: msg.channel_id };
    if (!msg.fromWebhook) {
      sweep(clicks);
      clicks.set(interaction.id, { ...click, botId: msg.user_id, expires: Date.now() + ANSWER_MS });
    }
    const result = await deliver(msg, interaction);
    if (result.error) {
      clicks.delete(interaction.id);
      return reply({ error: result.error });
    }

    // A webhook opens a form by answering with Discord's modal reply,
    // { "type": 9, "data": { custom_id, title, components } }. Any other
    // answer, an empty 200 say, opens nothing.
    let answer = null;
    try { answer = JSON.parse(result.body); } catch { /* not JSON: no form */ }
    if (answer && answer.type === 9) {
      const modal = botComponents.cleanModal(answer.data, maxChars());
      if (modal.error) return reply({ error: `The bot's form could not be shown: ${modal.error}` });
      showForm(click, modal);
    }
    reply({ ok: true });
  });

  // A bot account answers a click with a form, as Discord's modal data:
  // { interactionId, custom_id, title, components }.
  socket.on('open-bot-modal', (data, cb) => {
    const reply = typeof cb === 'function' ? cb : () => {};
    if (!socket.user || !socket.user.botAccount || !data || typeof data !== 'object') return reply({ error: 'Invalid request' });
    const click = clicks.get(data.interactionId);
    if (!click || click.botId !== socket.user.id || click.expires < Date.now()) {
      return reply({ error: 'That click can no longer be answered with a form' });
    }
    const modal = botComponents.cleanModal(data, maxChars());
    if (modal.error) return reply({ error: modal.error });
    // Held to AutoMod like the bot's messages.
    const words = [modal.title, botComponents.plainText({ components: modal.components })].join('\n');
    if (!ctx.enforceAutomod || ctx.enforceAutomod(words, { surface: 'message', channelId: click.channelId, markdown: true })) {
      return reply({ error: 'That form was blocked' });
    }
    clicks.delete(data.interactionId);
    if (!showForm(click, modal)) return reply({ error: 'The person who clicked has left' });
    reply({ success: true });
  });

  // The person sends back the form a bot opened for them.
  socket.on('submit-bot-modal', async (data, cb) => {
    const reply = typeof cb === 'function' ? cb : () => {};
    if (!socket.user || !data || typeof data !== 'object') return reply({ error: 'Invalid request' });
    if (floodCheck?.('botInteraction')) return reply({ error: 'Slow down a little' });
    const form = forms.get(data.formId);
    if (!form || form.userId !== socket.user.id || form.expires < Date.now()) {
      return reply({ error: 'This form has closed. Click the button again to get a new one.' });
    }
    if (form.sending) return reply({ error: 'Already sending' });
    const answers = botComponents.checkModalSubmit(form.modal, data.fields);
    if (answers.error) return reply({ error: answers.error });

    const msg = botMessage(form.messageId);
    if (!msg) {
      forms.delete(data.formId);
      return reply({ error: 'Message not found' });
    }
    // The form stays open until the bot has it, so a bot that did not
    // answer does not cost the person what they typed.
    form.sending = true;
    const result = await deliver(msg, {
      id: crypto.randomUUID(),
      type: 'modal_submit',
      message_id: form.messageId,
      thread_id: msg.thread_id || null,
      custom_id: form.modal.custom_id,
      fields: answers.fields,
      user: clicker(),
    });
    form.sending = false;
    if (result.error) return reply({ error: result.error });
    forms.delete(data.formId);
    reply({ ok: true });
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
    const msg = db.prepare('SELECT m.id, m.user_id, m.content, m.is_archived, c.code, c.id AS channel_id FROM messages m JOIN channels c ON c.id = m.channel_id WHERE m.id = ?').get(messageId);
    if (!msg || msg.user_id !== socket.user.id) return reply({ error: 'You can only change your own messages' });
    if (msg.is_archived) return reply({ error: 'This message is protected. Unprotect it first.' });
    // The new parts are held to AutoMod like the bot's text. Without the
    // check there is nothing to run them through, so they are refused.
    if (!ctx.enforceAutomod || ctx.enforceAutomod(botComponents.plainText(parts), { surface: 'edit', channelId: msg.channel_id, markdown: true })) {
      return reply({ error: 'That message was blocked' });
    }
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
