'use strict';

const path = require('path');
const fs   = require('fs');
const { utcStamp, isString, isInt, sanitizeText } = require('./helpers');

module.exports = function register(socket, ctx) {
  const { io, db, state, userHasPermission, getUserEffectiveLevel,
          sendPushNotifications, fireWebhookCallbacks, processSlashCommand,
          touchVoiceActivity, floodCheck, UPLOADS_DIR, DELETED_ATTACHMENTS_DIR } = ctx;
  const { slowModeTracker } = state;

  // ── Get message history ─────────────────────────────────
  socket.on('get-messages', (data) => {
    if (!data || typeof data !== 'object') return;
    const code = typeof data.code === 'string' ? data.code.trim() : '';
    if (!code || !/^[a-f0-9]{8}$/i.test(code)) return;
    const before = isInt(data.before) ? data.before : null;
    const after  = isInt(data.after)  ? data.after  : null;
    const limit = isInt(data.limit) && data.limit > 0 && data.limit <= 100 ? data.limit : 80;

    const channel = db.prepare('SELECT id FROM channels WHERE code = ?').get(code);
    if (!channel) return;

    const member = db.prepare(
      'SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?'
    ).get(channel.id, socket.user.id);
    if (!member && !socket.user.isAdmin) return socket.emit('error-msg', 'Not a member of this channel');

    let messages;
    if (before) {
      messages = db.prepare(`
        SELECT m.id, m.content, m.created_at, m.reply_to, m.edited_at, m.is_webhook, m.webhook_username, m.webhook_avatar, m.imported_from, m.is_archived, m.poll_data,
               COALESCE(m.webhook_username, u.display_name, u.username, '[Deleted User]') as username, u.id as user_id, u.avatar, COALESCE(u.avatar_shape, 'circle') as avatar_shape
        FROM messages m LEFT JOIN users u ON m.user_id = u.id
        WHERE m.channel_id = ? AND m.id < ?
        ORDER BY m.created_at DESC LIMIT ?
      `).all(channel.id, before, limit);
    } else if (after) {
      messages = db.prepare(`
        SELECT m.id, m.content, m.created_at, m.reply_to, m.edited_at, m.is_webhook, m.webhook_username, m.webhook_avatar, m.imported_from, m.is_archived, m.poll_data,
               COALESCE(m.webhook_username, u.display_name, u.username, '[Deleted User]') as username, u.id as user_id, u.avatar, COALESCE(u.avatar_shape, 'circle') as avatar_shape
        FROM messages m LEFT JOIN users u ON m.user_id = u.id
        WHERE m.channel_id = ? AND m.id > ?
        ORDER BY m.created_at ASC LIMIT ?
      `).all(channel.id, after, limit);
    } else {
      messages = db.prepare(`
        SELECT m.id, m.content, m.created_at, m.reply_to, m.edited_at, m.is_webhook, m.webhook_username, m.webhook_avatar, m.imported_from, m.is_archived, m.poll_data,
               COALESCE(m.webhook_username, u.display_name, u.username, '[Deleted User]') as username, u.id as user_id, u.avatar, COALESCE(u.avatar_shape, 'circle') as avatar_shape
        FROM messages m LEFT JOIN users u ON m.user_id = u.id
        WHERE m.channel_id = ?
        ORDER BY m.created_at DESC LIMIT ?
      `).all(channel.id, limit);
    }

    // Batch-enrich messages (reply context, reactions, pin status) in 3 queries
    const msgIds = messages.map(m => m.id);
    const replyIds = [...new Set(messages.filter(m => m.reply_to).map(m => m.reply_to))];

    const replyMap = new Map();
    if (replyIds.length > 0) {
      const ph = replyIds.map(() => '?').join(',');
      db.prepare(`
        SELECT m.id, m.content, COALESCE(u.display_name, u.username, '[Deleted User]') as username
        FROM messages m LEFT JOIN users u ON m.user_id = u.id
        WHERE m.id IN (${ph})
      `).all(...replyIds).forEach(r => replyMap.set(r.id, r));
    }

    const reactionMap = new Map();
    const pollVoteMap = new Map();
    let pinnedSet = null;
    if (msgIds.length > 0) {
      const ph = msgIds.map(() => '?').join(',');
      db.prepare(`
        SELECT r.message_id, r.emoji, r.user_id, COALESCE(u.display_name, u.username) as username
        FROM reactions r JOIN users u ON r.user_id = u.id
        WHERE r.message_id IN (${ph}) ORDER BY r.id
      `).all(...msgIds).forEach(r => {
        if (!reactionMap.has(r.message_id)) reactionMap.set(r.message_id, []);
        reactionMap.get(r.message_id).push({ emoji: r.emoji, user_id: r.user_id, username: r.username });
      });

      pinnedSet = new Set(
        db.prepare(`SELECT message_id FROM pinned_messages WHERE message_id IN (${ph})`)
          .all(...msgIds).map(r => r.message_id)
      );

      db.prepare(`
        SELECT pv.message_id, pv.option_index, pv.user_id, COALESCE(u.display_name, u.username) as username
        FROM poll_votes pv JOIN users u ON pv.user_id = u.id
        WHERE pv.message_id IN (${ph}) ORDER BY pv.id
      `).all(...msgIds).forEach(v => {
        if (!pollVoteMap.has(v.message_id)) pollVoteMap.set(v.message_id, []);
        pollVoteMap.get(v.message_id).push(v);
      });
    }

    const webhookAvatarMap = new Map();
    const webhookNamesNeedingAvatar = [...new Set(
      messages.filter(m => m.is_webhook && !m.webhook_avatar && m.webhook_username)
        .map(m => m.webhook_username)
    )];
    if (webhookNamesNeedingAvatar.length > 0) {
      const ph = webhookNamesNeedingAvatar.map(() => '?').join(',');
      db.prepare(
        `SELECT name, avatar_url FROM webhooks WHERE channel_id = ? AND name IN (${ph}) AND avatar_url IS NOT NULL`
      ).all(channel.id, ...webhookNamesNeedingAvatar).forEach(w => {
        webhookAvatarMap.set(w.name, w.avatar_url);
      });
    }

    const enriched = messages.map(m => {
      const obj = { ...m };
      if (obj.created_at && !obj.created_at.endsWith('Z')) obj.created_at = utcStamp(obj.created_at);
      if (obj.edited_at && !obj.edited_at.endsWith('Z')) obj.edited_at = utcStamp(obj.edited_at);
      obj.replyContext = m.reply_to ? (replyMap.get(m.reply_to) || null) : null;
      obj.reactions = reactionMap.get(m.id) || [];
      obj.pinned = pinnedSet ? pinnedSet.has(m.id) : false;
      obj.is_archived = !!m.is_archived;
      if (m.poll_data) {
        try {
          obj.poll = JSON.parse(m.poll_data);
          const votes = pollVoteMap.get(m.id) || [];
          obj.poll.votes = {};
          obj.poll.options.forEach((_, i) => { obj.poll.votes[i] = []; });
          votes.forEach(v => {
            if (!obj.poll.votes[v.option_index]) obj.poll.votes[v.option_index] = [];
            obj.poll.votes[v.option_index].push({ user_id: v.user_id, username: v.username });
          });
          obj.poll.totalVotes = votes.length;
        } catch (e) { /* invalid poll_data */ }
      }
      if (m.is_webhook) {
        obj.is_webhook = true;
        obj.username = `[BOT] ${m.webhook_username || 'Bot'}`;
        obj.avatar_shape = 'square';
        obj.avatar = m.webhook_avatar || webhookAvatarMap.get(m.webhook_username) || null;
      }
      if (m.imported_from) {
        obj.imported_from = m.imported_from;
        obj.username = m.webhook_username || 'Unknown';
      }
      return obj;
    });

    socket.emit('message-history', {
      channelCode: code,
      messages: after ? enriched : enriched.reverse()
    });
  });

  // ── Search messages ─────────────────────────────────────
  socket.on('search-messages', (data) => {
    if (!data || typeof data !== 'object') return;
    const code = typeof data.code === 'string' ? data.code.trim() : '';
    const query = typeof data.query === 'string' ? data.query.trim() : '';
    if (!code || !query || query.length < 2) return;

    const channel = db.prepare('SELECT id FROM channels WHERE code = ?').get(code);
    if (!channel) return;

    const member = db.prepare(
      'SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?'
    ).get(channel.id, socket.user.id);
    if (!member) return;

    const escapedQuery = query.replace(/[%_\\]/g, '\\$&');
    const results = db.prepare(`
      SELECT m.id, m.content, m.created_at,
             COALESCE(u.display_name, u.username, '[Deleted User]') as username, u.id as user_id
      FROM messages m LEFT JOIN users u ON m.user_id = u.id
      WHERE m.channel_id = ? AND m.content LIKE ? ESCAPE '\\'
      ORDER BY m.created_at DESC LIMIT 25
    `).all(channel.id, `%${escapedQuery}%`);

    results.forEach(r => {
      if (r.created_at && !r.created_at.endsWith('Z')) r.created_at = utcStamp(r.created_at);
    });
    socket.emit('search-results', { results, query });
  });

  // ── Send message ────────────────────────────────────────
  socket.on('send-message', (data) => {
    if (!data || typeof data !== 'object') return;
    const code = typeof data.code === 'string' ? data.code.trim() : '';
    const content = typeof data.content === 'string' ? data.content : '';

    if (!code || !/^[a-f0-9]{8}$/i.test(code)) return;
    if (!content || content.trim().length === 0) return;
    if (content.length > 2000) {
      return socket.emit('error-msg', 'Message too long (max 2000 characters)');
    }

    touchVoiceActivity(socket.user.id);

    if (floodCheck('message')) {
      return socket.emit('error-msg', 'Slow down — you\'re sending messages too fast');
    }

    const activeMute = db.prepare(
      'SELECT id, expires_at FROM mutes WHERE user_id = ? AND expires_at > datetime(\'now\') ORDER BY expires_at DESC LIMIT 1'
    ).get(socket.user.id);
    if (activeMute) {
      const remaining = Math.ceil((new Date(activeMute.expires_at + 'Z') - Date.now()) / 60000);
      return socket.emit('error-msg', `You are muted for ${remaining} more minute${remaining !== 1 ? 's' : ''}`);
    }

    const channel = db.prepare('SELECT id, name, slow_mode_interval, text_enabled, voice_enabled, media_enabled, read_only FROM channels WHERE code = ?').get(code);
    if (!channel) return socket.emit('error-msg', 'Channel not found — try switching channels and back');

    const member = db.prepare(
      'SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?'
    ).get(channel.id, socket.user.id);
    if (!member) return socket.emit('error-msg', 'Not a member of this channel');

    if (channel.read_only === 1 && !socket.user.isAdmin && !userHasPermission(socket.user.id, 'read_only_override', channel.id)) {
      return socket.emit('error-msg', 'This channel is read-only');
    }

    if (channel.text_enabled === 0) {
      const isMedia = /^\/uploads\b/i.test(content.trim()) || /^\[file:[^\]]+\]\(/i.test(content.trim());
      if (!isMedia || channel.media_enabled === 0) {
        return socket.emit('error-msg', 'Text messages are disabled in this channel');
      }
    }

    if (channel.media_enabled === 0 && !socket.user.isAdmin) {
      const isMediaContent = /^\/uploads\b/i.test(content.trim()) || /^\[file:[^\]]+\]\(/i.test(content.trim());
      if (isMediaContent) {
        return socket.emit('error-msg', 'Media uploads are disabled in this channel');
      }
    }

    if (channel.slow_mode_interval > 0 && !socket.user.isAdmin && getUserEffectiveLevel(socket.user.id, channel.id) < 25) {
      const slowKey = `slow:${socket.user.id}:${channel.id}`;
      const now = Date.now();
      const lastSent = slowModeTracker.get(slowKey) || 0;
      const waitMs = channel.slow_mode_interval * 1000;
      if (now - lastSent < waitMs) {
        const remaining = Math.ceil((waitMs - (now - lastSent)) / 1000);
        return socket.emit('error-msg', `Slow mode — wait ${remaining}s before sending another message`);
      }
      slowModeTracker.set(slowKey, now);
    }

    const trimmed = content.trim();
    const isImage = data.isImage === true;
    const isUpload = /^\/uploads\b/i.test(trimmed);
    const isPath = trimmed.startsWith('/') && trimmed.indexOf('/', 1) !== -1;
    const slashMatch = (!isImage && !isUpload && !isPath) ? trimmed.match(/^\/([a-zA-Z]+)(?:\s+(.*))?$/) : null;
    if (slashMatch) {
      const cmd = slashMatch[1].toLowerCase();
      const arg = (slashMatch[2] || '').trim();
      const slashResult = processSlashCommand(cmd, arg, socket.user.displayName, socket.user.id);
      if (slashResult) {
        const finalContent = slashResult.content;

        const result = db.prepare(
          'INSERT INTO messages (channel_id, user_id, content, reply_to) VALUES (?, ?, ?, ?)'
        ).run(channel.id, socket.user.id, finalContent, null);

        const message = {
          id: result.lastInsertRowid,
          content: finalContent,
          created_at: new Date().toISOString(),
          username: socket.user.displayName,
          user_id: socket.user.id,
          avatar: socket.user.avatar || null,
          avatar_shape: socket.user.avatar_shape || 'circle',
          reply_to: null,
          replyContext: null,
          reactions: [],
          edited_at: null
        };
        if (slashResult.tts) message.tts = true;

        io.to(`channel:${code}`).emit('new-message', { channelCode: code, message });
        sendPushNotifications(channel.id, code, channel.name, socket.user.id, socket.user.displayName, slashResult.content);
        fireWebhookCallbacks(channel.id, code, message);

        try {
          db.prepare(`
            INSERT INTO read_positions (user_id, channel_id, last_read_message_id)
            VALUES (?, ?, ?)
            ON CONFLICT(user_id, channel_id) DO UPDATE SET last_read_message_id = MAX(last_read_message_id, excluded.last_read_message_id)
          `).run(socket.user.id, channel.id, result.lastInsertRowid);
        } catch (e) { /* non-critical */ }
        return;
      }
    }

    const replyTo = isInt(data.replyTo) ? data.replyTo : null;
    const safeContent = sanitizeText(content.trim());
    if (!safeContent) return;

    try {
      const result = db.prepare(
        'INSERT INTO messages (channel_id, user_id, content, reply_to) VALUES (?, ?, ?, ?)'
      ).run(channel.id, socket.user.id, safeContent, replyTo);

      const message = {
        id: result.lastInsertRowid,
        content: safeContent,
        created_at: new Date().toISOString(),
        username: socket.user.displayName,
        user_id: socket.user.id,
        avatar: socket.user.avatar || null,
        avatar_shape: socket.user.avatar_shape || 'circle',
        reply_to: replyTo,
        replyContext: null,
        reactions: [],
        edited_at: null
      };

      if (replyTo) {
        message.replyContext = db.prepare(`
          SELECT m.id, m.content, COALESCE(u.display_name, u.username, '[Deleted User]') as username FROM messages m
          LEFT JOIN users u ON m.user_id = u.id WHERE m.id = ?
        `).get(replyTo) || null;
      }

      io.to(`channel:${code}`).emit('new-message', { channelCode: code, message });
      sendPushNotifications(channel.id, code, channel.name, socket.user.id, socket.user.displayName, safeContent);
      fireWebhookCallbacks(channel.id, code, message);

      try {
        db.prepare(`
          INSERT INTO read_positions (user_id, channel_id, last_read_message_id)
          VALUES (?, ?, ?)
          ON CONFLICT(user_id, channel_id) DO UPDATE SET last_read_message_id = MAX(last_read_message_id, excluded.last_read_message_id)
        `).run(socket.user.id, channel.id, result.lastInsertRowid);
      } catch (e) { /* non-critical */ }
    } catch (err) {
      console.error('send-message error:', err.message);
      socket.emit('error-msg', 'Failed to send message — please try again');
    }
  });

  // ── Typing indicator ────────────────────────────────────
  socket.on('typing', (data) => {
    if (!data || typeof data !== 'object') return;
    if (!isString(data.code, 8, 8)) return;
    if (data.code !== socket.currentChannel) return;
    socket.to(`channel:${data.code}`).emit('user-typing', {
      channelCode: data.code,
      username: socket.user.displayName
    });
  });

  // ── Ping / latency measurement ──────────────────────────
  socket.on('ping-check', () => {
    socket.emit('pong-check');
  });

  // ── Edit message ────────────────────────────────────────
  socket.on('edit-message', (data) => {
    if (!data || typeof data !== 'object') return;
    if (!isInt(data.messageId) || !isString(data.content, 1, 2000)) return;

    const code = socket.currentChannel;
    if (!code) return;

    const channel = db.prepare('SELECT id FROM channels WHERE code = ?').get(code);
    if (!channel) return;

    const msg = db.prepare(
      'SELECT id, user_id FROM messages WHERE id = ? AND channel_id = ?'
    ).get(data.messageId, channel.id);
    if (!msg) return;

    if (msg.user_id !== socket.user.id) {
      return socket.emit('error-msg', 'You can only edit your own messages');
    }
    if (!socket.user.isAdmin && !userHasPermission(socket.user.id, 'edit_own_messages', channel.id)) {
      return socket.emit('error-msg', 'You don\'t have permission to edit messages');
    }

    const newContent = sanitizeText(data.content.trim());
    if (!newContent) return;

    if (/^\/uploads\/[\w\-]+\.(jpg|jpeg|png|gif|webp)$/i.test(newContent)) {
      const origMsg = db.prepare('SELECT original_name FROM messages WHERE id = ?').get(data.messageId);
      if (!origMsg || !origMsg.original_name) {
        return socket.emit('error-msg', 'Cannot change a text message into an image');
      }
    }

    try {
      db.prepare(
        'UPDATE messages SET content = ?, edited_at = datetime(\'now\') WHERE id = ?'
      ).run(newContent, data.messageId);
    } catch (err) {
      console.error('Edit message error:', err);
      return socket.emit('error-msg', 'Failed to edit message');
    }

    io.to(`channel:${code}`).emit('message-edited', {
      channelCode: code,
      messageId: data.messageId,
      content: newContent,
      editedAt: new Date().toISOString()
    });
  });

  // ── Delete message ──────────────────────────────────────
  socket.on('delete-message', (data) => {
    if (!data || typeof data !== 'object') return;
    if (!isInt(data.messageId)) return;

    const code = socket.currentChannel;
    if (!code) return;

    const channel = db.prepare('SELECT id FROM channels WHERE code = ?').get(code);
    if (!channel) return;

    const msg = db.prepare(
      'SELECT id, user_id, content FROM messages WHERE id = ? AND channel_id = ?'
    ).get(data.messageId, channel.id);
    if (!msg) return;

    if (msg.user_id === socket.user.id) {
      if (!socket.user.isAdmin) {
        try {
          const deny = db.prepare(
            "SELECT allowed FROM user_role_perms WHERE user_id = ? AND permission = 'delete_own_messages' ORDER BY allowed ASC LIMIT 1"
          ).get(socket.user.id);
          if (deny && deny.allowed === 0) {
            return socket.emit('error-msg', 'You don\'t have permission to delete messages');
          }
        } catch { /* table may not exist */ }
      }
    } else {
      const canDeleteAny = socket.user.isAdmin || userHasPermission(socket.user.id, 'delete_message', channel.id);
      let canDeleteLower = false;
      if (!canDeleteAny && userHasPermission(socket.user.id, 'delete_lower_messages', channel.id)) {
        const myLevel = getUserEffectiveLevel(socket.user.id, channel.id);
        const targetLevel = getUserEffectiveLevel(msg.user_id, channel.id);
        canDeleteLower = myLevel > targetLevel;
      }
      if (!canDeleteAny && !canDeleteLower) {
        return socket.emit('error-msg', 'You can only delete your own messages');
      }
    }

    try {
      db.prepare('DELETE FROM pinned_messages WHERE message_id = ?').run(data.messageId);
      db.prepare('DELETE FROM reactions WHERE message_id = ?').run(data.messageId);
      db.prepare('DELETE FROM messages WHERE id = ?').run(data.messageId);
    } catch (err) {
      console.error('Delete message error:', err);
      return socket.emit('error-msg', 'Failed to delete message');
    }

    const uploadRe = /\/uploads\/((?!deleted-attachments)[\w\-.]+)/g;
    let m;
    while ((m = uploadRe.exec(msg.content || '')) !== null) {
      const src = path.join(UPLOADS_DIR, m[1]);
      const dst = path.join(DELETED_ATTACHMENTS_DIR, m[1]);
      if (fs.existsSync(src)) {
        try { fs.renameSync(src, dst); } catch { /* file locked or already moved */ }
      }
    }

    io.to(`channel:${code}`).emit('message-deleted', {
      channelCode: code,
      messageId: data.messageId
    });
  });

  // ── Move messages ───────────────────────────────────────
  socket.on('move-messages', (data, callback) => {
    if (!data || typeof data !== 'object') return;
    const cb = typeof callback === 'function' ? callback : () => {};

    const messageIds = Array.isArray(data.messageIds) ? data.messageIds.filter(id => isInt(id)) : [];
    if (messageIds.length === 0 || messageIds.length > 200) return cb({ error: 'Select between 1 and 200 messages' });

    const fromCode = typeof data.fromChannel === 'string' ? data.fromChannel.trim() : '';
    const toCode   = typeof data.toChannel   === 'string' ? data.toChannel.trim()   : '';
    if (!fromCode || !toCode || fromCode === toCode) return cb({ error: 'Invalid channels' });
    if (!/^[a-f0-9]{8}$/i.test(fromCode) || !/^[a-f0-9]{8}$/i.test(toCode)) return cb({ error: 'Invalid channel codes' });

    const fromCh = db.prepare('SELECT id, is_dm FROM channels WHERE code = ?').get(fromCode);
    const toCh   = db.prepare('SELECT id, is_dm FROM channels WHERE code = ?').get(toCode);
    if (!fromCh || !toCh) return cb({ error: 'Channel not found' });
    if (fromCh.is_dm || toCh.is_dm) return cb({ error: 'Cannot move messages to or from DMs' });

    if (!socket.user.isAdmin && !userHasPermission(socket.user.id, 'delete_message', fromCh.id)) {
      return cb({ error: 'You need message management permissions to move messages' });
    }

    const placeholders = messageIds.map(() => '?').join(',');
    const count = db.prepare(
      `SELECT COUNT(*) as cnt FROM messages WHERE id IN (${placeholders}) AND channel_id = ?`
    ).get(...messageIds, fromCh.id);
    if (!count || count.cnt !== messageIds.length) return cb({ error: 'Some messages were not found in the source channel' });

    try {
      db.prepare(
        `UPDATE messages SET channel_id = ? WHERE id IN (${placeholders}) AND channel_id = ?`
      ).run(toCh.id, ...messageIds, fromCh.id);

      db.prepare(
        `UPDATE pinned_messages SET channel_id = ? WHERE message_id IN (${placeholders}) AND channel_id = ?`
      ).run(toCh.id, ...messageIds, fromCh.id);
    } catch (err) {
      console.error('Move messages error:', err);
      return cb({ error: 'Failed to move messages' });
    }

    io.to(`channel:${fromCode}`).emit('messages-moved', {
      channelCode: fromCode,
      messageIds,
      toChannel: toCode
    });
    io.to(`channel:${toCode}`).emit('messages-received', {
      channelCode: toCode,
      fromChannel: fromCode,
      messageIds
    });

    cb({ success: true, moved: messageIds.length });
  });

  // ── Pin / Unpin message ─────────────────────────────────
  socket.on('pin-message', (data) => {
    if (!data || typeof data !== 'object') return;
    if (!isInt(data.messageId)) return;

    const pinCode = socket.currentChannel;
    const pinCh = pinCode ? db.prepare('SELECT id FROM channels WHERE code = ?').get(pinCode) : null;
    if (!socket.user.isAdmin && !userHasPermission(socket.user.id, 'pin_message', pinCh ? pinCh.id : null)) {
      return socket.emit('error-msg', 'You don\'t have permission to pin messages');
    }

    const code = socket.currentChannel;
    if (!code) return;

    const channel = db.prepare('SELECT id FROM channels WHERE code = ?').get(code);
    if (!channel) return;

    const msg = db.prepare(
      'SELECT id FROM messages WHERE id = ? AND channel_id = ?'
    ).get(data.messageId, channel.id);
    if (!msg) return socket.emit('error-msg', 'Message not found');

    const existing = db.prepare(
      'SELECT id FROM pinned_messages WHERE message_id = ?'
    ).get(data.messageId);
    if (existing) return socket.emit('error-msg', 'Message is already pinned');

    const pinCount = db.prepare(
      'SELECT COUNT(*) as cnt FROM pinned_messages WHERE channel_id = ?'
    ).get(channel.id);
    if (pinCount.cnt >= 50) {
      return socket.emit('error-msg', 'Channel has reached the 50-pin limit');
    }

    try {
      db.prepare(
        'INSERT INTO pinned_messages (message_id, channel_id, pinned_by) VALUES (?, ?, ?)'
      ).run(data.messageId, channel.id, socket.user.id);
    } catch (err) {
      console.error('Pin message error:', err);
      return socket.emit('error-msg', 'Failed to pin message');
    }

    io.to(`channel:${code}`).emit('message-pinned', {
      channelCode: code,
      messageId: data.messageId,
      pinnedBy: socket.user.displayName
    });
  });

  socket.on('unpin-message', (data) => {
    if (!data || typeof data !== 'object') return;
    if (!isInt(data.messageId)) return;

    const unpinCode = socket.currentChannel;
    const unpinCh = unpinCode ? db.prepare('SELECT id FROM channels WHERE code = ?').get(unpinCode) : null;
    if (!socket.user.isAdmin && !userHasPermission(socket.user.id, 'pin_message', unpinCh ? unpinCh.id : null)) {
      return socket.emit('error-msg', 'You don\'t have permission to unpin messages');
    }

    const code = socket.currentChannel;
    if (!code) return;

    const channel = db.prepare('SELECT id FROM channels WHERE code = ?').get(code);
    if (!channel) return;

    const pin = db.prepare(
      'SELECT id FROM pinned_messages WHERE message_id = ? AND channel_id = ?'
    ).get(data.messageId, channel.id);
    if (!pin) return socket.emit('error-msg', 'Message is not pinned');

    try {
      db.prepare('DELETE FROM pinned_messages WHERE message_id = ?').run(data.messageId);
    } catch (err) {
      console.error('Unpin message error:', err);
      return socket.emit('error-msg', 'Failed to unpin message');
    }

    io.to(`channel:${code}`).emit('message-unpinned', {
      channelCode: code,
      messageId: data.messageId
    });
  });

  // ── Archive / Unarchive message ─────────────────────────
  socket.on('archive-message', (data) => {
    if (!data || typeof data !== 'object') return;
    if (!isInt(data.messageId)) return;

    const archCode = socket.currentChannel;
    const archCh = archCode ? db.prepare('SELECT id FROM channels WHERE code = ?').get(archCode) : null;
    if (!socket.user.isAdmin && !userHasPermission(socket.user.id, 'archive_messages', archCh ? archCh.id : null)) {
      return socket.emit('error-msg', 'You don\'t have permission to archive messages');
    }

    const code = socket.currentChannel;
    if (!code) return;

    const channel = db.prepare('SELECT id FROM channels WHERE code = ?').get(code);
    if (!channel) return;

    const msg = db.prepare('SELECT id, is_archived FROM messages WHERE id = ? AND channel_id = ?').get(data.messageId, channel.id);
    if (!msg) return socket.emit('error-msg', 'Message not found');
    if (msg.is_archived) return socket.emit('error-msg', 'Message is already archived');

    try {
      db.prepare('UPDATE messages SET is_archived = 1 WHERE id = ?').run(data.messageId);
    } catch (err) {
      console.error('Archive message error:', err);
      return socket.emit('error-msg', 'Failed to archive message');
    }

    io.to(`channel:${code}`).emit('message-archived', {
      channelCode: code,
      messageId: data.messageId,
      archivedBy: socket.user.displayName
    });
  });

  socket.on('unarchive-message', (data) => {
    if (!data || typeof data !== 'object') return;
    if (!isInt(data.messageId)) return;

    const unarchCode = socket.currentChannel;
    const unarchCh = unarchCode ? db.prepare('SELECT id FROM channels WHERE code = ?').get(unarchCode) : null;
    if (!socket.user.isAdmin && !userHasPermission(socket.user.id, 'archive_messages', unarchCh ? unarchCh.id : null)) {
      return socket.emit('error-msg', 'You don\'t have permission to unarchive messages');
    }

    const code = socket.currentChannel;
    if (!code) return;

    const channel = db.prepare('SELECT id FROM channels WHERE code = ?').get(code);
    if (!channel) return;

    const msg = db.prepare('SELECT id, is_archived FROM messages WHERE id = ? AND channel_id = ?').get(data.messageId, channel.id);
    if (!msg) return socket.emit('error-msg', 'Message not found');
    if (!msg.is_archived) return socket.emit('error-msg', 'Message is not archived');

    try {
      db.prepare('UPDATE messages SET is_archived = 0 WHERE id = ?').run(data.messageId);
    } catch (err) {
      console.error('Unarchive message error:', err);
      return socket.emit('error-msg', 'Failed to unarchive message');
    }

    io.to(`channel:${code}`).emit('message-unarchived', {
      channelCode: code,
      messageId: data.messageId
    });
  });

  // ── Get pinned messages ─────────────────────────────────
  socket.on('get-pinned-messages', (data) => {
    if (!data || typeof data !== 'object') return;
    const code = typeof data.code === 'string' ? data.code.trim() : '';
    if (!code || !/^[a-f0-9]{8}$/i.test(code)) return;

    const channel = db.prepare('SELECT id FROM channels WHERE code = ?').get(code);
    if (!channel) return;

    const member = db.prepare(
      'SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?'
    ).get(channel.id, socket.user.id);
    if (!member) return;

    const pins = db.prepare(`
      SELECT m.id, m.content, m.created_at, m.edited_at, m.is_webhook, m.webhook_username, m.webhook_avatar,
             COALESCE(m.webhook_username, u.display_name, u.username, '[Deleted User]') as username, u.id as user_id,
             pm.pinned_at, COALESCE(pb.display_name, pb.username, '[Deleted User]') as pinned_by
      FROM pinned_messages pm
      JOIN messages m ON pm.message_id = m.id
      LEFT JOIN users u ON m.user_id = u.id
      LEFT JOIN users pb ON pm.pinned_by = pb.id
      WHERE pm.channel_id = ?
      ORDER BY pm.pinned_at DESC
    `).all(channel.id);

    pins.forEach(p => {
      p.created_at = utcStamp(p.created_at);
      p.edited_at = utcStamp(p.edited_at);
      p.pinned_at = utcStamp(p.pinned_at);
      if (p.is_webhook) {
        p.username = `[BOT] ${p.webhook_username || 'Bot'}`;
      }
    });

    socket.emit('pinned-messages', { channelCode: code, pins });
  });

  // ── Reactions ───────────────────────────────────────────
  socket.on('add-reaction', (data) => {
    try {
      if (!data || typeof data !== 'object') return;
      if (!isInt(data.messageId) || !isString(data.emoji, 1, 32)) return;

      const allowed = /^[\p{Emoji}\p{Emoji_Component}\uFE0F\u200D]+$/u;
      const customEmojiPattern = /^:[a-zA-Z0-9_-]{1,30}:$/;
      if (!allowed.test(data.emoji) && !customEmojiPattern.test(data.emoji)) return;
      if (data.emoji.length > 32) return;

      if (customEmojiPattern.test(data.emoji)) {
        const emojiName = data.emoji.slice(1, -1).toLowerCase();
        const exists = db.prepare('SELECT 1 FROM custom_emojis WHERE name = ?').get(emojiName);
        if (!exists) return;
      }

      const code = socket.currentChannel;
      if (!code) return;

      const channel = db.prepare('SELECT id FROM channels WHERE code = ?').get(code);
      if (!channel) return;

      const msg = db.prepare('SELECT id FROM messages WHERE id = ? AND channel_id = ?').get(data.messageId, channel.id);
      if (!msg) return;

      db.prepare(
        'INSERT OR IGNORE INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?)'
      ).run(data.messageId, socket.user.id, data.emoji);

      const reactions = db.prepare(`
        SELECT r.emoji, r.user_id, COALESCE(u.display_name, u.username) as username FROM reactions r
        JOIN users u ON r.user_id = u.id WHERE r.message_id = ? ORDER BY r.id
      `).all(data.messageId);

      io.to(`channel:${code}`).emit('reactions-updated', {
        channelCode: code,
        messageId: data.messageId,
        reactions
      });
    } catch (err) {
      console.error('add-reaction error:', err.message);
    }
  });

  socket.on('remove-reaction', (data) => {
    try {
      if (!data || typeof data !== 'object') return;
      if (!isInt(data.messageId) || !isString(data.emoji, 1, 32)) return;

      const code = socket.currentChannel;
      if (!code) return;

      const channel = db.prepare('SELECT id FROM channels WHERE code = ?').get(code);
      if (!channel) return;
      const msgCheck = db.prepare('SELECT id FROM messages WHERE id = ? AND channel_id = ?').get(data.messageId, channel.id);
      if (!msgCheck) return;

      db.prepare(
        'DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?'
      ).run(data.messageId, socket.user.id, data.emoji);

      const reactions = db.prepare(`
        SELECT r.emoji, r.user_id, COALESCE(u.display_name, u.username) as username FROM reactions r
        JOIN users u ON r.user_id = u.id WHERE r.message_id = ? ORDER BY r.id
      `).all(data.messageId);

      io.to(`channel:${code}`).emit('reactions-updated', {
        channelCode: code,
        messageId: data.messageId,
        reactions
      });
    } catch (err) {
      console.error('remove-reaction error:', err.message);
    }
  });

  // ── Polls ───────────────────────────────────────────────
  socket.on('create-poll', (data) => {
    try {
      if (!data || typeof data !== 'object') return;
      const question = typeof data.question === 'string' ? data.question.trim() : '';
      if (!question || question.length > 300) return;
      const maxPollOpts = parseInt(db.prepare('SELECT value FROM server_settings WHERE key = ?').get('max_poll_options')?.value) || 10;
      const options = Array.isArray(data.options) ? data.options : [];
      if (options.length < 2 || options.length > maxPollOpts) return;
      const cleanOptions = options.map(o => typeof o === 'string' ? sanitizeText(o.trim()) : '').filter(Boolean);
      if (cleanOptions.length < 2 || cleanOptions.length > maxPollOpts) return;
      if (cleanOptions.some(o => o.length > 100)) return;
      const multiVote = !!data.multiVote;
      const anonymous = !!data.anonymous;

      if (floodCheck('message')) {
        return socket.emit('error-msg', 'Slow down — you\'re sending messages too fast');
      }

      const activeMute = db.prepare(
        'SELECT id, expires_at FROM mutes WHERE user_id = ? AND expires_at > datetime(\'now\') ORDER BY expires_at DESC LIMIT 1'
      ).get(socket.user.id);
      if (activeMute) {
        const remaining = Math.ceil((new Date(activeMute.expires_at + 'Z') - Date.now()) / 60000);
        return socket.emit('error-msg', `You are muted for ${remaining} more minute${remaining !== 1 ? 's' : ''}`);
      }

      const code = socket.currentChannel;
      if (!code) return;
      const channel = db.prepare('SELECT id, name, text_enabled FROM channels WHERE code = ?').get(code);
      if (!channel) return;
      if (channel.text_enabled === 0) return socket.emit('error-msg', 'Polls are not allowed when text is disabled');
      const member = db.prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?').get(channel.id, socket.user.id);
      if (!member) return socket.emit('error-msg', 'Not a member of this channel');

      const safeQuestion = sanitizeText(question);
      if (!safeQuestion) return;

      const pollData = JSON.stringify({ question: safeQuestion, options: cleanOptions, multiVote, anonymous });
      const content = `📊 Poll: ${safeQuestion}`;
      const result = db.prepare(
        'INSERT INTO messages (channel_id, user_id, content, poll_data) VALUES (?, ?, ?, ?)'
      ).run(channel.id, socket.user.id, content, pollData);

      const message = {
        id: result.lastInsertRowid,
        content,
        created_at: new Date().toISOString(),
        username: socket.user.displayName,
        user_id: socket.user.id,
        avatar: socket.user.avatar || null,
        avatar_shape: socket.user.avatar_shape || 'circle',
        reply_to: null,
        replyContext: null,
        reactions: [],
        edited_at: null,
        poll: { question: safeQuestion, options: cleanOptions, multiVote, anonymous, votes: {}, totalVotes: 0 }
      };
      cleanOptions.forEach((_, i) => { message.poll.votes[i] = []; });

      io.to(`channel:${code}`).emit('new-message', { channelCode: code, message });
      sendPushNotifications(channel.id, code, channel.name, socket.user.id, socket.user.displayName, content);
      fireWebhookCallbacks(channel.id, code, message);

      try {
        db.prepare(`
          INSERT INTO read_positions (user_id, channel_id, last_read_message_id)
          VALUES (?, ?, ?)
          ON CONFLICT(user_id, channel_id) DO UPDATE SET last_read_message_id = MAX(last_read_message_id, excluded.last_read_message_id)
        `).run(socket.user.id, channel.id, result.lastInsertRowid);
      } catch (e) { /* non-critical */ }
    } catch (err) {
      console.error('create-poll error:', err.message);
      socket.emit('error-msg', 'Failed to create poll');
    }
  });

  socket.on('vote-poll', (data) => {
    try {
      if (!data || typeof data !== 'object') return;
      if (!isInt(data.messageId)) return;
      const optionIndex = typeof data.optionIndex === 'number' ? data.optionIndex : -1;
      if (optionIndex < 0 || optionIndex > 9 || !Number.isInteger(optionIndex)) return;

      const code = socket.currentChannel;
      if (!code) return;
      const channel = db.prepare('SELECT id FROM channels WHERE code = ?').get(code);
      if (!channel) return;

      const msg = db.prepare('SELECT id, poll_data FROM messages WHERE id = ? AND channel_id = ?').get(data.messageId, channel.id);
      if (!msg || !msg.poll_data) return;

      let poll;
      try { poll = JSON.parse(msg.poll_data); } catch (e) { return; }
      if (optionIndex >= poll.options.length) return;

      if (!poll.multiVote) {
        db.prepare('DELETE FROM poll_votes WHERE message_id = ? AND user_id = ?').run(data.messageId, socket.user.id);
      }

      db.prepare(
        'INSERT OR IGNORE INTO poll_votes (message_id, user_id, option_index) VALUES (?, ?, ?)'
      ).run(data.messageId, socket.user.id, optionIndex);

      const votes = db.prepare(`
        SELECT pv.option_index, pv.user_id, COALESCE(u.display_name, u.username) as username
        FROM poll_votes pv JOIN users u ON pv.user_id = u.id
        WHERE pv.message_id = ? ORDER BY pv.id
      `).all(data.messageId);

      const votesByOption = {};
      poll.options.forEach((_, i) => { votesByOption[i] = []; });
      votes.forEach(v => {
        if (!votesByOption[v.option_index]) votesByOption[v.option_index] = [];
        votesByOption[v.option_index].push({ user_id: v.user_id, username: v.username });
      });

      io.to(`channel:${code}`).emit('poll-updated', {
        channelCode: code,
        messageId: data.messageId,
        votes: votesByOption,
        totalVotes: votes.length
      });
    } catch (err) {
      console.error('vote-poll error:', err.message);
    }
  });

  socket.on('unvote-poll', (data) => {
    try {
      if (!data || typeof data !== 'object') return;
      if (!isInt(data.messageId)) return;
      const optionIndex = typeof data.optionIndex === 'number' ? data.optionIndex : -1;
      if (optionIndex < 0 || optionIndex > 9 || !Number.isInteger(optionIndex)) return;

      const code = socket.currentChannel;
      if (!code) return;
      const channel = db.prepare('SELECT id FROM channels WHERE code = ?').get(code);
      if (!channel) return;
      const msg = db.prepare('SELECT id, poll_data FROM messages WHERE id = ? AND channel_id = ?').get(data.messageId, channel.id);
      if (!msg || !msg.poll_data) return;

      db.prepare('DELETE FROM poll_votes WHERE message_id = ? AND user_id = ? AND option_index = ?')
        .run(data.messageId, socket.user.id, optionIndex);

      let poll;
      try { poll = JSON.parse(msg.poll_data); } catch (e) { return; }

      const votes = db.prepare(`
        SELECT pv.option_index, pv.user_id, COALESCE(u.display_name, u.username) as username
        FROM poll_votes pv JOIN users u ON pv.user_id = u.id
        WHERE pv.message_id = ? ORDER BY pv.id
      `).all(data.messageId);

      const votesByOption = {};
      poll.options.forEach((_, i) => { votesByOption[i] = []; });
      votes.forEach(v => {
        if (!votesByOption[v.option_index]) votesByOption[v.option_index] = [];
        votesByOption[v.option_index].push({ user_id: v.user_id, username: v.username });
      });

      io.to(`channel:${code}`).emit('poll-updated', {
        channelCode: code,
        messageId: data.messageId,
        votes: votesByOption,
        totalVotes: votes.length
      });
    } catch (err) {
      console.error('unvote-poll error:', err.message);
    }
  });

  // ── Read positions ──────────────────────────────────────
  socket.on('mark-read', (data) => {
    if (!data || typeof data !== 'object') return;
    const code = typeof data.code === 'string' ? data.code.trim() : '';
    if (!code || !/^[a-f0-9]{8}$/i.test(code)) return;
    if (!isInt(data.messageId) || data.messageId <= 0) return;

    const channel = db.prepare('SELECT id FROM channels WHERE code = ?').get(code);
    if (!channel) return;

    const member = db.prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?').get(channel.id, socket.user.id);
    if (!member) return;

    try {
      db.prepare(`
        INSERT INTO read_positions (user_id, channel_id, last_read_message_id)
        VALUES (?, ?, ?)
        ON CONFLICT(user_id, channel_id) DO UPDATE SET last_read_message_id = MAX(last_read_message_id, excluded.last_read_message_id)
      `).run(socket.user.id, channel.id, data.messageId);
    } catch (err) {
      console.error('Mark read error:', err);
    }
  });
};
