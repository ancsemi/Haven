'use strict';

// Bot: edit a message the bot posted earlier.
//
//   PATCH /api/webhooks/<token>/messages/<message_id>   { "content": "new text" }
//
// For tools that mirror something from outside (an n8n flow copying comments
// from another service): when the original changes, the bot changes its copy
// instead of deleting it and posting again.
//
// A bot edits only its own messages, whatever else it may do. A moderation
// bot can delete other people's messages, but rewriting what someone else
// said is not moderation. The same limits as posting apply (4,000
// characters, cleaned the same way), and a protected message stays as it is.
//
// "embeds" and "components" (src/botComponents.js) replace the message's own,
// and an empty list takes them off; left out, they stay. This is how a bot
// answers a click by changing the message: a vote count, a button greyed out.
// "content" may be left out too when only those change.

const botComponents = require('../botComponents');

module.exports = function registerWebhookEdit({ app, express, webhookLimiter, getWebhookByToken, getIo, sanitizeText }) {
  app.patch('/api/webhooks/:token/messages/:messageId', webhookLimiter, express.json({ limit: '64kb' }), (req, res) => {
    const { getDb } = require('../database');
    const db = getDb();

    const webhook = getWebhookByToken(req.params.token);
    if (!webhook) return res.status(404).json({ error: 'Webhook not found or inactive' });

    const mid = parseInt(req.params.messageId, 10);
    if (!Number.isInteger(mid) || mid < 1) return res.status(400).json({ error: 'Invalid message ID' });

    const parts = botComponents.clean(req.body);
    if (parts.error) return res.status(400).json({ error: parts.error });
    const changesParts = parts.embeds !== null || parts.components !== null;
    const hasContent = !!req.body && 'content' in req.body;
    const raw = hasContent && typeof req.body.content === 'string' ? req.body.content.trim() : '';
    const content = sanitizeText(raw);
    if (content.length > 4000 || (!content && !changesParts)) return res.status(400).json({ error: 'Content required (max 4000 chars)' });

    const msg = db.prepare('SELECT id, content, is_webhook, webhook_id, is_archived FROM messages WHERE id = ? AND channel_id = ?').get(mid, webhook.channel_id);
    if (!msg) return res.status(404).json({ error: 'Message not found in this channel' });
    if (!(msg.is_webhook && msg.webhook_id === webhook.id)) {
      return res.status(403).json({ error: 'This bot can only edit its own messages' });
    }
    // Protected means kept as it was, the same as for a person's edit.
    if (msg.is_archived) return res.status(409).json({ error: 'This message is protected. Unprotect it first.' });

    // What the message keeps: its text and parts, unless this edit replaces them.
    const before = botComponents.get(db, mid);
    const next = {
      embeds: parts.embeds !== null ? parts.embeds : (before.embeds || []),
      components: parts.components !== null ? parts.components : (before.components || []),
    };
    // "content": "" with parts clears the text, as on Discord.
    const editsText = hasContent && (!!content || changesParts);
    if (!(editsText ? content : msg.content) && !next.embeds.length && !next.components.length) {
      return res.status(400).json({ error: 'The message would be left empty' });
    }

    try {
      db.transaction(() => {
        if (editsText) db.prepare("UPDATE messages SET content = ?, edited_at = datetime('now') WHERE id = ?").run(content, mid);
        if (changesParts) botComponents.record(db, mid, next);
      })();
    } catch (err) {
      console.error('Bot edit message error:', err);
      return res.status(500).json({ error: 'Failed to edit message' });
    }

    const io = getIo();
    if (webhook.channel_code && io) {
      const room = io.to(`channel:${webhook.channel_code}`);
      if (editsText) {
        room.emit('message-edited', {
          channelCode: webhook.channel_code,
          messageId: mid,
          userId: null,
          content,
          editedAt: new Date().toISOString()
        });
      }
      if (changesParts) {
        room.emit('message-bot-parts', { channelCode: webhook.channel_code, messageId: mid, embeds: next.embeds, components: next.components });
      }
    }
    res.json({ success: true, message_id: mid });
  });
};
