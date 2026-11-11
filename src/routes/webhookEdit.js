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

module.exports = function registerWebhookEdit({ app, express, webhookLimiter, getWebhookByToken, getIo, sanitizeText }) {
  app.patch('/api/webhooks/:token/messages/:messageId', webhookLimiter, express.json({ limit: '64kb' }), (req, res) => {
    const { getDb } = require('../database');
    const db = getDb();

    const webhook = getWebhookByToken(req.params.token);
    if (!webhook) return res.status(404).json({ error: 'Webhook not found or inactive' });

    const mid = parseInt(req.params.messageId, 10);
    if (!Number.isInteger(mid) || mid < 1) return res.status(400).json({ error: 'Invalid message ID' });

    const raw = req.body && typeof req.body.content === 'string' ? req.body.content.trim() : '';
    const content = sanitizeText(raw);
    if (!content || content.length > 4000) return res.status(400).json({ error: 'Content required (max 4000 chars)' });

    const msg = db.prepare('SELECT id, is_webhook, webhook_id, is_archived FROM messages WHERE id = ? AND channel_id = ?').get(mid, webhook.channel_id);
    if (!msg) return res.status(404).json({ error: 'Message not found in this channel' });
    if (!(msg.is_webhook && msg.webhook_id === webhook.id)) {
      return res.status(403).json({ error: 'This bot can only edit its own messages' });
    }
    // Protected means kept as it was, the same as for a person's edit.
    if (msg.is_archived) return res.status(409).json({ error: 'This message is protected. Unprotect it first.' });

    try {
      db.prepare("UPDATE messages SET content = ?, edited_at = datetime('now') WHERE id = ?").run(content, mid);
    } catch (err) {
      console.error('Bot edit message error:', err);
      return res.status(500).json({ error: 'Failed to edit message' });
    }

    const io = getIo();
    if (webhook.channel_code && io) {
      io.to(`channel:${webhook.channel_code}`).emit('message-edited', {
        channelCode: webhook.channel_code,
        messageId: mid,
        userId: null,
        content,
        editedAt: new Date().toISOString()
      });
    }
    res.json({ success: true, message_id: mid });
  });
};
