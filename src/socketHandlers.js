const { verifyToken, generateChannelCode, generateToken } = require('./auth');

// ── Input validation helpers ────────────────────────────
function isString(v, min = 0, max = Infinity) {
  return typeof v === 'string' && v.length >= min && v.length <= max;
}

function isInt(v) {
  return Number.isInteger(v);
}

function setupSocketHandlers(io, db) {

  // ── Socket connection rate limiting (per IP) ────────────
  const connTracker = new Map(); // ip → { count, resetTime }
  const MAX_CONN_PER_MIN = 15;

  io.use((socket, next) => {
    const ip = socket.handshake.address;
    const now = Date.now();

    if (!connTracker.has(ip)) {
      connTracker.set(ip, { count: 0, resetTime: now + 60000 });
    }

    const entry = connTracker.get(ip);
    if (now > entry.resetTime) {
      entry.count = 0;
      entry.resetTime = now + 60000;
    }

    entry.count++;
    if (entry.count > MAX_CONN_PER_MIN) {
      return next(new Error('Rate limited — too many connections'));
    }

    next();
  });

  // ── Auth middleware ───────────────────────────────────────
  io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token || typeof token !== 'string') return next(new Error('Authentication required'));

    const user = verifyToken(token);
    if (!user) return next(new Error('Invalid token'));

    // Check if user is banned
    const ban = db.prepare('SELECT id FROM bans WHERE user_id = ?').get(user.id);
    if (ban) return next(new Error('You have been banned from this server'));

    socket.user = user;
    next();
  });

  // Clean up connection tracker every 5 min
  setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of connTracker) {
      if (now > entry.resetTime + 120000) connTracker.delete(ip);
    }
  }, 5 * 60 * 1000);

  // Online tracking:  code → Map<userId, { id, username, socketId }>
  const channelUsers = new Map();
  const voiceUsers = new Map();

  io.on('connection', (socket) => {
    // Guard: if auth middleware somehow didn't attach user, disconnect
    if (!socket.user || !socket.user.username) {
      console.warn('⚠️  Connection without valid user — disconnecting');
      socket.disconnect(true);
      return;
    }

    console.log(`✅ ${socket.user.username} connected`);
    socket.currentChannel = null;

    // ── Per-socket flood protection ─────────────────────────
    const floodBuckets = { message: [], event: [] };
    const FLOOD_LIMITS = {
      message: { max: 10, windowMs: 10000 },  // 10 msgs per 10s
      event:   { max: 60, windowMs: 10000 },  // 60 events per 10s (total)
    };

    function floodCheck(bucket) {
      const limit = FLOOD_LIMITS[bucket];
      const now = Date.now();
      const timestamps = floodBuckets[bucket].filter(t => now - t < limit.windowMs);
      floodBuckets[bucket] = timestamps;

      if (timestamps.length >= limit.max) {
        return true; // flooded
      }
      timestamps.push(now);
      return false;
    }

    // Global event counter — disconnect if spamming
    socket.use((packet, next) => {
      if (floodCheck('event')) {
        socket.emit('error-msg', 'Slow down — too many requests');
        return; // drop the event silently
      }
      next();
    });

    // ── Get user's channels ─────────────────────────────────
    socket.on('get-channels', () => {
      const channels = db.prepare(`
        SELECT c.id, c.name, c.code, c.created_by
        FROM channels c
        JOIN channel_members cm ON c.id = cm.channel_id
        WHERE cm.user_id = ?
        ORDER BY c.name
      `).all(socket.user.id);

      // Join all channel rooms for message delivery
      channels.forEach(ch => socket.join(`channel:${ch.code}`));

      socket.emit('channels-list', channels);
    });

    // ── Create channel (admin only) ─────────────────────────
    socket.on('create-channel', (data) => {
      if (!data || typeof data !== 'object') return;
      if (!socket.user.isAdmin) {
        return socket.emit('error-msg', 'Only admins can create channels');
      }

      const name = typeof data.name === 'string' ? data.name.trim() : '';
      if (!name || name.length === 0) {
        return socket.emit('error-msg', 'Channel name required');
      }
      if (name.length > 50) {
        return socket.emit('error-msg', 'Channel name too long (max 50)');
      }
      // Only allow safe characters in channel names
      if (!/^[\w\s\-!?.,']+$/i.test(name)) {
        return socket.emit('error-msg', 'Channel name contains invalid characters');
      }

      const code = generateChannelCode();

      try {
        const result = db.prepare(
          'INSERT INTO channels (name, code, created_by) VALUES (?, ?, ?)'
        ).run(name.trim(), code, socket.user.id);

        // Auto-join creator
        db.prepare(
          'INSERT INTO channel_members (channel_id, user_id) VALUES (?, ?)'
        ).run(result.lastInsertRowid, socket.user.id);

        const channel = {
          id: result.lastInsertRowid,
          name: name.trim(),
          code,
          created_by: socket.user.id
        };

        socket.join(`channel:${code}`);
        socket.emit('channel-created', channel);
      } catch (err) {
        console.error('Create channel error:', err);
        socket.emit('error-msg', 'Failed to create channel');
      }
    });

    // ── Join channel by code ────────────────────────────────
    socket.on('join-channel', (data) => {
      if (!data || typeof data !== 'object') return;
      const code = typeof data.code === 'string' ? data.code.trim() : '';
      if (!code || !/^[a-f0-9]{8}$/i.test(code)) {
        return socket.emit('error-msg', 'Invalid channel code format');
      }

      const channel = db.prepare('SELECT * FROM channels WHERE code = ?').get(code);
      if (!channel) {
        return socket.emit('error-msg', 'Invalid channel code — double-check it');
      }

      // Add membership if not already a member
      const membership = db.prepare(
        'SELECT * FROM channel_members WHERE channel_id = ? AND user_id = ?'
      ).get(channel.id, socket.user.id);

      if (!membership) {
        db.prepare(
          'INSERT INTO channel_members (channel_id, user_id) VALUES (?, ?)'
        ).run(channel.id, socket.user.id);
      }

      socket.join(`channel:${code}`);

      // Notify channel
      io.to(`channel:${code}`).emit('user-joined', {
        channelCode: code,
        user: { id: socket.user.id, username: socket.user.username }
      });

      // Send channel info to joiner
      socket.emit('channel-joined', {
        id: channel.id,
        name: channel.name,
        code: channel.code,
        created_by: channel.created_by
      });
    });

    // ── Switch active channel ───────────────────────────────
    socket.on('enter-channel', (data) => {
      if (!data || typeof data !== 'object') return;
      const code = typeof data.code === 'string' ? data.code.trim() : '';
      if (!code || !/^[a-f0-9]{8}$/i.test(code)) return;

      // Verify membership before allowing channel access
      const ch = db.prepare('SELECT id FROM channels WHERE code = ?').get(code);
      if (!ch) return;
      const isMember = db.prepare(
        'SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?'
      ).get(ch.id, socket.user.id);
      if (!isMember) return socket.emit('error-msg', 'Not a member of this channel');

      // Remove from previous channel's online tracking
      if (socket.currentChannel && socket.currentChannel !== code) {
        const prevUsers = channelUsers.get(socket.currentChannel);
        if (prevUsers) {
          prevUsers.delete(socket.user.id);
          emitOnlineUsers(socket.currentChannel);
        }
      }

      socket.currentChannel = code;
      socket.join(`channel:${code}`);

      // Track in new channel
      if (!channelUsers.has(code)) channelUsers.set(code, new Map());
      channelUsers.get(code).set(socket.user.id, {
        id: socket.user.id,
        username: socket.user.username,
        socketId: socket.id
      });

      // Broadcast online users
      emitOnlineUsers(code);
    });

    // ── Get message history ─────────────────────────────────
    socket.on('get-messages', (data) => {
      if (!data || typeof data !== 'object') return;
      const code = typeof data.code === 'string' ? data.code.trim() : '';
      if (!code || !/^[a-f0-9]{8}$/i.test(code)) return;
      const before = isInt(data.before) ? data.before : null;
      const limit = isInt(data.limit) && data.limit > 0 && data.limit <= 100 ? data.limit : 80;

      const channel = db.prepare('SELECT id FROM channels WHERE code = ?').get(code);
      if (!channel) return;

      const member = db.prepare(
        'SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?'
      ).get(channel.id, socket.user.id);
      if (!member) return socket.emit('error-msg', 'Not a member of this channel');

      let messages;
      if (before) {
        messages = db.prepare(`
          SELECT m.id, m.content, m.created_at, m.reply_to, m.edited_at,
                 COALESCE(u.username, '[Deleted User]') as username, u.id as user_id
          FROM messages m LEFT JOIN users u ON m.user_id = u.id
          WHERE m.channel_id = ? AND m.id < ?
          ORDER BY m.created_at DESC LIMIT ?
        `).all(channel.id, before, limit);
      } else {
        messages = db.prepare(`
          SELECT m.id, m.content, m.created_at, m.reply_to, m.edited_at,
                 COALESCE(u.username, '[Deleted User]') as username, u.id as user_id
          FROM messages m LEFT JOIN users u ON m.user_id = u.id
          WHERE m.channel_id = ?
          ORDER BY m.created_at DESC LIMIT ?
        `).all(channel.id, limit);
      }

      // Attach reply context and reactions to each message
      const getReplyStmt = db.prepare(`
        SELECT m.id, m.content, COALESCE(u.username, '[Deleted User]') as username FROM messages m
        LEFT JOIN users u ON m.user_id = u.id WHERE m.id = ?
      `);
      const getReactionsStmt = db.prepare(`
        SELECT r.emoji, r.user_id, u.username FROM reactions r
        JOIN users u ON r.user_id = u.id WHERE r.message_id = ?
      `);

      const enriched = messages.map(m => {
        const obj = { ...m };
        if (m.reply_to) {
          obj.replyContext = getReplyStmt.get(m.reply_to) || null;
        }
        obj.reactions = getReactionsStmt.all(m.id);
        return obj;
      });

      socket.emit('message-history', {
        channelCode: code,
        messages: enriched.reverse()
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

      const results = db.prepare(`
        SELECT m.id, m.content, m.created_at,
               COALESCE(u.username, '[Deleted User]') as username, u.id as user_id
        FROM messages m LEFT JOIN users u ON m.user_id = u.id
        WHERE m.channel_id = ? AND m.content LIKE ?
        ORDER BY m.created_at DESC LIMIT 25
      `).all(channel.id, `%${query}%`);

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

      // Flood check for messages specifically
      if (floodCheck('message')) {
        return socket.emit('error-msg', 'Slow down — you\'re sending messages too fast');
      }

      // ── Mute check ───────────────────────────────────
      const activeMute = db.prepare(
        'SELECT id, expires_at FROM mutes WHERE user_id = ? AND expires_at > datetime(\'now\') ORDER BY expires_at DESC LIMIT 1'
      ).get(socket.user.id);
      if (activeMute) {
        const remaining = Math.ceil((new Date(activeMute.expires_at + 'Z') - Date.now()) / 60000);
        return socket.emit('error-msg', `You are muted for ${remaining} more minute${remaining !== 1 ? 's' : ''}`);
      }

      const channel = db.prepare('SELECT id FROM channels WHERE code = ?').get(code);
      if (!channel) return;

      const member = db.prepare(
        'SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?'
      ).get(channel.id, socket.user.id);
      if (!member) return socket.emit('error-msg', 'Not a member of this channel');

      // ── Slash commands ────────────────────────────────
      // Skip slash command parsing for image uploads and file paths
      const trimmed = content.trim();
      const isImage = data.isImage === true;
      const isUpload = /^\/uploads\b/i.test(trimmed);
      const isPath = trimmed.startsWith('/') && trimmed.indexOf('/', 1) !== -1;
      const slashMatch = (!isImage && !isUpload && !isPath) ? trimmed.match(/^\/([a-zA-Z]+)(?:\s+(.*))?$/) : null;
      if (slashMatch) {
        const cmd = slashMatch[1].toLowerCase();
        const arg = (slashMatch[2] || '').trim();
        const slashResult = processSlashCommand(cmd, arg, socket.user.username);
        if (slashResult) {
          const finalContent = slashResult.content;

          const result = db.prepare(
            'INSERT INTO messages (channel_id, user_id, content, reply_to) VALUES (?, ?, ?, ?)'
          ).run(channel.id, socket.user.id, finalContent, null);

          const message = {
            id: result.lastInsertRowid,
            content: finalContent,
            created_at: new Date().toISOString(),
            username: socket.user.username,
            user_id: socket.user.id,
            reply_to: null,
            replyContext: null,
            reactions: [],
            edited_at: null
          };
          if (slashResult.tts) message.tts = true;

          io.to(`channel:${code}`).emit('new-message', { channelCode: code, message });
          return;
        }
        // Unknown command — tell the user
        return socket.emit('error-msg', `Unknown command: /${cmd}`);
      }

      const replyTo = isInt(data.replyTo) ? data.replyTo : null;

      const result = db.prepare(
        'INSERT INTO messages (channel_id, user_id, content, reply_to) VALUES (?, ?, ?, ?)'
      ).run(channel.id, socket.user.id, content.trim(), replyTo);

      const message = {
        id: result.lastInsertRowid,
        content: content.trim(),
        created_at: new Date().toISOString(),
        username: socket.user.username,
        user_id: socket.user.id,
        reply_to: replyTo,
        replyContext: null,
        reactions: [],
        edited_at: null
      };

      // Attach reply context if replying
      if (replyTo) {
        message.replyContext = db.prepare(`
          SELECT m.id, m.content, COALESCE(u.username, '[Deleted User]') as username FROM messages m
          LEFT JOIN users u ON m.user_id = u.id WHERE m.id = ?
        `).get(replyTo) || null;
      }

      io.to(`channel:${code}`).emit('new-message', { channelCode: code, message });
    });

    // ── Typing indicator ────────────────────────────────────
    socket.on('typing', (data) => {
      if (!data || typeof data !== 'object') return;
      if (!isString(data.code, 8, 8)) return;
      socket.to(`channel:${data.code}`).emit('user-typing', {
        channelCode: data.code,
        username: socket.user.username
      });
    });

    // ── Ping / latency measurement ──────────────────────────
    socket.on('ping-check', () => {
      socket.emit('pong-check');
    });

    // ═══════════════ VOICE (WebRTC Signaling) ═══════════════

    socket.on('voice-join', (data) => {
      if (!data || typeof data !== 'object') return;
      const code = typeof data.code === 'string' ? data.code.trim() : '';
      if (!code || !/^[a-f0-9]{8}$/i.test(code)) return;

      // Verify channel membership before allowing voice
      const vch = db.prepare('SELECT id FROM channels WHERE code = ?').get(code);
      if (!vch) return;
      const vMember = db.prepare(
        'SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?'
      ).get(vch.id, socket.user.id);
      if (!vMember) return socket.emit('error-msg', 'Not a member of this channel');

      if (!voiceUsers.has(code)) voiceUsers.set(code, new Map());

      // Existing users before this one joins
      const existingUsers = Array.from(voiceUsers.get(code).values());

      // Add new voice user
      voiceUsers.get(code).set(socket.user.id, {
        id: socket.user.id,
        username: socket.user.username,
        socketId: socket.id
      });

      // Tell new user about existing peers (they'll create offers)
      socket.emit('voice-existing-users', {
        channelCode: code,
        users: existingUsers.map(u => ({ id: u.id, username: u.username }))
      });

      // Tell existing users about new peer (they'll expect offers)
      existingUsers.forEach(u => {
        io.to(u.socketId).emit('voice-user-joined', {
          channelCode: code,
          user: { id: socket.user.id, username: socket.user.username }
        });
      });

      // Update voice user list for the whole channel
      broadcastVoiceUsers(code);
    });

    socket.on('voice-offer', (data) => {
      if (!data || typeof data !== 'object') return;
      if (!isString(data.code, 8, 8) || !isInt(data.targetUserId) || !data.offer) return;
      const target = voiceUsers.get(data.code)?.get(data.targetUserId);
      if (target) {
        io.to(target.socketId).emit('voice-offer', {
          from: { id: socket.user.id, username: socket.user.username },
          offer: data.offer,
          channelCode: data.code
        });
      }
    });

    socket.on('voice-answer', (data) => {
      if (!data || typeof data !== 'object') return;
      if (!isString(data.code, 8, 8) || !isInt(data.targetUserId) || !data.answer) return;
      const target = voiceUsers.get(data.code)?.get(data.targetUserId);
      if (target) {
        io.to(target.socketId).emit('voice-answer', {
          from: { id: socket.user.id, username: socket.user.username },
          answer: data.answer,
          channelCode: data.code
        });
      }
    });

    socket.on('voice-ice-candidate', (data) => {
      if (!data || typeof data !== 'object') return;
      if (!isString(data.code, 8, 8) || !isInt(data.targetUserId)) return;
      const target = voiceUsers.get(data.code)?.get(data.targetUserId);
      if (target) {
        io.to(target.socketId).emit('voice-ice-candidate', {
          from: { id: socket.user.id, username: socket.user.username },
          candidate: data.candidate,
          channelCode: data.code
        });
      }
    });

    socket.on('voice-leave', (data) => {
      if (!data || typeof data !== 'object') return;
      if (!isString(data.code, 8, 8)) return;
      handleVoiceLeave(socket, data.code);
    });

    // ═══════════════ REACTIONS ═════════════════════════════════

    socket.on('add-reaction', (data) => {
      if (!data || typeof data !== 'object') return;
      if (!isInt(data.messageId) || !isString(data.emoji, 1, 8)) return;

      // Verify the emoji is a real emoji (allow compound emojis, skin tones, ZWJ sequences)
      const allowed = /^[\p{Emoji}\p{Emoji_Component}\uFE0F\u200D]+$/u;
      if (!allowed.test(data.emoji) || data.emoji.length > 16) return;

      const code = socket.currentChannel;
      if (!code) return;

      const channel = db.prepare('SELECT id FROM channels WHERE code = ?').get(code);
      if (!channel) return;

      // Verify message belongs to this channel
      const msg = db.prepare('SELECT id FROM messages WHERE id = ? AND channel_id = ?').get(data.messageId, channel.id);
      if (!msg) return;

      try {
        db.prepare(
          'INSERT OR IGNORE INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?)'
        ).run(data.messageId, socket.user.id, data.emoji);

        // Broadcast updated reactions for this message
        const reactions = db.prepare(`
          SELECT r.emoji, r.user_id, u.username FROM reactions r
          JOIN users u ON r.user_id = u.id WHERE r.message_id = ?
        `).all(data.messageId);

        io.to(`channel:${code}`).emit('reactions-updated', {
          channelCode: code,
          messageId: data.messageId,
          reactions
        });
      } catch { /* duplicate — ignore */ }
    });

    socket.on('remove-reaction', (data) => {
      if (!data || typeof data !== 'object') return;
      if (!isInt(data.messageId) || !isString(data.emoji, 1, 8)) return;

      const code = socket.currentChannel;
      if (!code) return;

      db.prepare(
        'DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?'
      ).run(data.messageId, socket.user.id, data.emoji);

      const reactions = db.prepare(`
        SELECT r.emoji, r.user_id, u.username FROM reactions r
        JOIN users u ON r.user_id = u.id WHERE r.message_id = ?
      `).all(data.messageId);

      io.to(`channel:${code}`).emit('reactions-updated', {
        channelCode: code,
        messageId: data.messageId,
        reactions
      });
    });

    // ═══════════════ CHANNEL MEMBERS (for @mentions) ═════════

    socket.on('get-channel-members', (data) => {
      if (!data || typeof data !== 'object') return;
      const code = typeof data.code === 'string' ? data.code.trim() : '';
      if (!code || !/^[a-f0-9]{8}$/i.test(code)) return;

      const channel = db.prepare('SELECT id FROM channels WHERE code = ?').get(code);
      if (!channel) return;

      const member = db.prepare(
        'SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?'
      ).get(channel.id, socket.user.id);
      if (!member) return;

      const members = db.prepare(`
        SELECT u.id, u.username FROM users u
        JOIN channel_members cm ON u.id = cm.user_id
        WHERE cm.channel_id = ?
        ORDER BY u.username
      `).all(channel.id);

      socket.emit('channel-members', { channelCode: code, members });
    });

    // ═══════════════ USERNAME RENAME ══════════════════

    socket.on('rename-user', (data) => {
      if (!data || typeof data !== 'object') return;
      const newName = typeof data.username === 'string' ? data.username.trim() : '';

      if (!newName || newName.length < 3 || newName.length > 20) {
        return socket.emit('error-msg', 'Username must be 3-20 characters');
      }
      if (!/^[a-zA-Z0-9_]+$/.test(newName)) {
        return socket.emit('error-msg', 'Letters, numbers, and underscores only');
      }

      // Check if name is taken by someone else
      const existing = db.prepare(
        'SELECT id FROM users WHERE username = ? COLLATE NOCASE AND id != ?'
      ).get(newName, socket.user.id);
      if (existing) {
        return socket.emit('error-msg', 'Username already taken');
      }

      try {
        db.prepare('UPDATE users SET username = ? WHERE id = ?').run(newName, socket.user.id);
      } catch (err) {
        console.error('Rename error:', err);
        return socket.emit('error-msg', 'Failed to update username');
      }

      // Block renaming to the admin username (privilege escalation prevention)
      const adminName = (process.env.ADMIN_USERNAME || 'admin').toLowerCase();
      if (newName.toLowerCase() === adminName && socket.user.id !== db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(adminName)?.id) {
        return socket.emit('error-msg', 'That username is reserved');
      }

      const oldName = socket.user.username;
      socket.user.username = newName;

      // Issue fresh JWT with new username
      const newToken = generateToken({
        id: socket.user.id,
        username: newName,
        isAdmin: socket.user.isAdmin
      });

      // Update online tracking maps
      for (const [code, users] of channelUsers) {
        if (users.has(socket.user.id)) {
          users.get(socket.user.id).username = newName;
          emitOnlineUsers(code);
        }
      }

      for (const [code, users] of voiceUsers) {
        if (users.has(socket.user.id)) {
          users.get(socket.user.id).username = newName;
          broadcastVoiceUsers(code);
        }
      }

      // Send new credentials to client
      socket.emit('renamed', {
        token: newToken,
        user: { id: socket.user.id, username: newName, isAdmin: socket.user.isAdmin },
        oldName
      });

      // Announce in current channel
      if (socket.currentChannel) {
        socket.to(`channel:${socket.currentChannel}`).emit('user-renamed', {
          channelCode: socket.currentChannel,
          oldName,
          newName
        });
      }

      console.log(`✏️  ${oldName} renamed to ${newName}`);
    });

    // ═══════════════ ADMIN: DELETE CHANNEL ═══════════════════

    socket.on('delete-channel', (data) => {
      if (!data || typeof data !== 'object') return;
      if (!socket.user.isAdmin) {
        return socket.emit('error-msg', 'Only admins can delete channels');
      }

      const code = typeof data.code === 'string' ? data.code.trim() : '';
      if (!code || !/^[a-f0-9]{8}$/i.test(code)) return;
      const channel = db.prepare('SELECT * FROM channels WHERE code = ?').get(code);
      if (!channel) return;

      const deleteAll = db.transaction((chId) => {
        // Delete reactions first (they reference messages)
        db.prepare('DELETE FROM reactions WHERE message_id IN (SELECT id FROM messages WHERE channel_id = ?)').run(chId);
        db.prepare('DELETE FROM messages WHERE channel_id = ?').run(chId);
        db.prepare('DELETE FROM channel_members WHERE channel_id = ?').run(chId);
        db.prepare('DELETE FROM channels WHERE id = ?').run(chId);
      });
      deleteAll(channel.id);

      io.to(`channel:${code}`).emit('channel-deleted', { code });

      channelUsers.delete(code);
      voiceUsers.delete(code);
    });

    // ═══════════════ EDIT MESSAGE ═══════════════════════════

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

      // Only author can edit
      if (msg.user_id !== socket.user.id) {
        return socket.emit('error-msg', 'You can only edit your own messages');
      }

      const newContent = data.content.trim();
      if (!newContent) return;

      db.prepare(
        'UPDATE messages SET content = ?, edited_at = datetime(\'now\') WHERE id = ?'
      ).run(newContent, data.messageId);

      io.to(`channel:${code}`).emit('message-edited', {
        channelCode: code,
        messageId: data.messageId,
        content: newContent,
        editedAt: new Date().toISOString()
      });
    });

    // ═══════════════ DELETE MESSAGE ═════════════════════════

    socket.on('delete-message', (data) => {
      if (!data || typeof data !== 'object') return;
      if (!isInt(data.messageId)) return;

      const code = socket.currentChannel;
      if (!code) return;

      const channel = db.prepare('SELECT id FROM channels WHERE code = ?').get(code);
      if (!channel) return;

      const msg = db.prepare(
        'SELECT id, user_id FROM messages WHERE id = ? AND channel_id = ?'
      ).get(data.messageId, channel.id);
      if (!msg) return;

      // Author or admin can delete
      if (msg.user_id !== socket.user.id && !socket.user.isAdmin) {
        return socket.emit('error-msg', 'You can only delete your own messages');
      }

      db.prepare('DELETE FROM reactions WHERE message_id = ?').run(data.messageId);
      db.prepare('DELETE FROM messages WHERE id = ?').run(data.messageId);

      io.to(`channel:${code}`).emit('message-deleted', {
        channelCode: code,
        messageId: data.messageId
      });
    });

    // ═══════════════ ADMIN: KICK USER ═══════════════════════

    socket.on('kick-user', (data) => {
      if (!data || typeof data !== 'object') return;
      if (!socket.user.isAdmin) {
        return socket.emit('error-msg', 'Only admins can kick users');
      }
      if (!isInt(data.userId)) return;
      if (data.userId === socket.user.id) {
        return socket.emit('error-msg', 'You can\'t kick yourself');
      }

      const code = socket.currentChannel;
      if (!code) return;

      // Find target socket and disconnect from channel
      const channelRoom = channelUsers.get(code);
      const targetInfo = channelRoom ? channelRoom.get(data.userId) : null;
      if (!targetInfo) {
        return socket.emit('error-msg', 'User is not currently online in this channel (use ban instead)');
      }

      // Emit kicked event to target
      io.to(targetInfo.socketId).emit('kicked', {
        channelCode: code,
        reason: typeof data.reason === 'string' ? data.reason.trim().slice(0, 200) : ''
      });

      // Remove from channel tracking
      channelRoom.delete(data.userId);

      // Broadcast updated online users
      const online = Array.from(channelRoom.values()).map(u => ({
        id: u.id, username: u.username
      }));
      io.to(`channel:${code}`).emit('online-users', {
        channelCode: code,
        users: online
      });

      io.to(`channel:${code}`).emit('new-message', {
        channelCode: code,
        message: {
          id: 0, content: `${targetInfo.username} was kicked`, created_at: new Date().toISOString(),
          username: 'System', user_id: 0, reply_to: null, replyContext: null, reactions: [], edited_at: null, system: true
        }
      });

      socket.emit('error-msg', `Kicked ${targetInfo.username}`);
    });

    // ═══════════════ ADMIN: BAN USER ════════════════════════

    socket.on('ban-user', (data) => {
      if (!data || typeof data !== 'object') return;
      if (!socket.user.isAdmin) {
        return socket.emit('error-msg', 'Only admins can ban users');
      }
      if (!isInt(data.userId)) return;
      if (data.userId === socket.user.id) {
        return socket.emit('error-msg', 'You can\'t ban yourself');
      }

      const reason = typeof data.reason === 'string' ? data.reason.trim().slice(0, 200) : '';

      // Get username before banning (works for ANY user, online or offline)
      const targetUser = db.prepare('SELECT id, username FROM users WHERE id = ?').get(data.userId);
      if (!targetUser) return socket.emit('error-msg', 'User not found');

      try {
        db.prepare(
          'INSERT OR REPLACE INTO bans (user_id, banned_by, reason) VALUES (?, ?, ?)'
        ).run(data.userId, socket.user.id, reason);
      } catch (err) {
        console.error('Ban error:', err);
        return socket.emit('error-msg', 'Failed to ban user');
      }

      // Disconnect all sockets of banned user
      for (const [, s] of io.sockets.sockets) {
        if (s.user && s.user.id === data.userId) {
          s.emit('banned', { reason });
          s.disconnect(true);
        }
      }

      // Re-emit online users for all channels to remove banned user from lists
      for (const [code] of channelUsers) {
        emitOnlineUsers(code);
      }

      socket.emit('error-msg', `Banned ${targetUser.username}`);
    });

    // ═══════════════ ADMIN: UNBAN USER ══════════════════════

    socket.on('unban-user', (data) => {
      if (!data || typeof data !== 'object') return;
      if (!socket.user.isAdmin) {
        return socket.emit('error-msg', 'Only admins can unban users');
      }
      if (!isInt(data.userId)) return;

      db.prepare('DELETE FROM bans WHERE user_id = ?').run(data.userId);
      const targetUser = db.prepare('SELECT username FROM users WHERE id = ?').get(data.userId);
      socket.emit('error-msg', `Unbanned ${targetUser ? targetUser.username : 'user'}`);

      // Send updated ban list to admin
      const bans = db.prepare(`
        SELECT b.id, b.user_id, b.reason, b.created_at, u.username
        FROM bans b JOIN users u ON b.user_id = u.id ORDER BY b.created_at DESC
      `).all();
      socket.emit('ban-list', bans);
    });

    // ═══════════════ ADMIN: DELETE USER (purge) ═════════════

    socket.on('delete-user', (data) => {
      if (!data || typeof data !== 'object') return;
      if (!socket.user.isAdmin) {
        return socket.emit('error-msg', 'Only admins can delete users');
      }
      if (!isInt(data.userId)) return;
      if (data.userId === socket.user.id) {
        return socket.emit('error-msg', 'You can\'t delete yourself');
      }

      const targetUser = db.prepare('SELECT id, username FROM users WHERE id = ?').get(data.userId);
      if (!targetUser) return socket.emit('error-msg', 'User not found');

      // Disconnect the user if online
      for (const [, s] of io.sockets.sockets) {
        if (s.user && s.user.id === data.userId) {
          s.emit('banned', { reason: 'Your account has been deleted by an admin.' });
          s.disconnect(true);
        }
      }

      // Remove from online/voice tracking
      for (const [code, users] of channelUsers) {
        if (users.has(data.userId)) {
          users.delete(data.userId);
          emitOnlineUsers(code);
        }
      }
      for (const [code, users] of voiceUsers) {
        if (users.has(data.userId)) {
          users.delete(data.userId);
          broadcastVoiceUsers(code);
        }
      }

      // Purge all user data in a transaction
      const purge = db.transaction((uid) => {
        db.prepare('DELETE FROM reactions WHERE user_id = ?').run(uid);
        db.prepare('DELETE FROM mutes WHERE user_id = ?').run(uid);
        db.prepare('DELETE FROM bans WHERE user_id = ?').run(uid);
        db.prepare('DELETE FROM channel_members WHERE user_id = ?').run(uid);
        // Mark their messages as [deleted user] instead of deleting (preserves chat history)
        db.prepare('UPDATE messages SET user_id = NULL WHERE user_id = ?').run(uid);
        db.prepare('DELETE FROM users WHERE id = ?').run(uid);
      });

      try {
        purge(data.userId);
      } catch (err) {
        console.error('Delete user error:', err);
        return socket.emit('error-msg', 'Failed to delete user');
      }

      socket.emit('error-msg', `Deleted user "${targetUser.username}" — username is now available`);

      // Refresh ban list for admin
      const bans = db.prepare(`
        SELECT b.id, b.user_id, b.reason, b.created_at, u.username
        FROM bans b JOIN users u ON b.user_id = u.id ORDER BY b.created_at DESC
      `).all();
      socket.emit('ban-list', bans);

      console.log(`🗑️  Admin deleted user "${targetUser.username}" (id: ${data.userId})`);
    });

    // ═══════════════ ADMIN: MUTE USER ═══════════════════════

    socket.on('mute-user', (data) => {
      if (!data || typeof data !== 'object') return;
      if (!socket.user.isAdmin) {
        return socket.emit('error-msg', 'Only admins can mute users');
      }
      if (!isInt(data.userId)) return;
      if (data.userId === socket.user.id) {
        return socket.emit('error-msg', 'You can\'t mute yourself');
      }

      const durationMinutes = isInt(data.duration) && data.duration > 0 && data.duration <= 43200
        ? data.duration : 10; // default 10 min, max 30 days
      const reason = typeof data.reason === 'string' ? data.reason.trim().slice(0, 200) : '';

      const targetUser = db.prepare('SELECT username FROM users WHERE id = ?').get(data.userId);
      if (!targetUser) return socket.emit('error-msg', 'User not found');

      try {
        db.prepare(
          'INSERT INTO mutes (user_id, muted_by, reason, expires_at) VALUES (?, ?, ?, datetime(\'now\', ?))'
        ).run(data.userId, socket.user.id, reason, `+${durationMinutes} minutes`);
      } catch (err) {
        console.error('Mute error:', err);
        return socket.emit('error-msg', 'Failed to mute user');
      }

      // Notify the muted user
      for (const [, s] of io.sockets.sockets) {
        if (s.user && s.user.id === data.userId) {
          s.emit('muted', { duration: durationMinutes, reason });
        }
      }

      socket.emit('error-msg', `Muted ${targetUser.username} for ${durationMinutes} min`);
    });

    // ═══════════════ ADMIN: UNMUTE USER ═════════════════════

    socket.on('unmute-user', (data) => {
      if (!data || typeof data !== 'object') return;
      if (!socket.user.isAdmin) {
        return socket.emit('error-msg', 'Only admins can unmute users');
      }
      if (!isInt(data.userId)) return;

      db.prepare('DELETE FROM mutes WHERE user_id = ?').run(data.userId);
      const targetUser = db.prepare('SELECT username FROM users WHERE id = ?').get(data.userId);
      socket.emit('error-msg', `Unmuted ${targetUser ? targetUser.username : 'user'}`);
    });

    // ═══════════════ ADMIN: GET BAN LIST ════════════════════

    socket.on('get-bans', () => {
      if (!socket.user.isAdmin) return;
      const bans = db.prepare(`
        SELECT b.id, b.user_id, b.reason, b.created_at, u.username
        FROM bans b JOIN users u ON b.user_id = u.id ORDER BY b.created_at DESC
      `).all();
      socket.emit('ban-list', bans);
    });

    // ═══════════════ SERVER SETTINGS ════════════════════════

    socket.on('get-server-settings', () => {
      const rows = db.prepare('SELECT key, value FROM server_settings').all();
      const settings = {};
      rows.forEach(r => { settings[r.key] = r.value; });
      socket.emit('server-settings', settings);
    });

    // ═══════════════ USER PREFERENCES ═══════════════════

    socket.on('get-preferences', () => {
      const rows = db.prepare('SELECT key, value FROM user_preferences WHERE user_id = ?').all(socket.user.id);
      const prefs = {};
      rows.forEach(r => { prefs[r.key] = r.value; });
      socket.emit('preferences', prefs);
    });

    socket.on('set-preference', (data) => {
      if (!data || typeof data !== 'object') return;
      const key = typeof data.key === 'string' ? data.key.trim() : '';
      const value = typeof data.value === 'string' ? data.value.trim() : '';

      const allowedKeys = ['theme'];
      if (!allowedKeys.includes(key) || !value || value.length > 50) return;

      db.prepare(
        'INSERT OR REPLACE INTO user_preferences (user_id, key, value) VALUES (?, ?, ?)'
      ).run(socket.user.id, key, value);

      socket.emit('preference-saved', { key, value });
    });

    // ═══════════════ HIGH SCORES ════════════════════════

    socket.on('submit-high-score', (data) => {
      if (!data || typeof data !== 'object') return;
      const game = typeof data.game === 'string' ? data.game.trim() : '';
      const score = isInt(data.score) && data.score >= 0 ? data.score : 0;
      if (!game || !['flappy'].includes(game)) return;

      const current = db.prepare(
        'SELECT score FROM high_scores WHERE user_id = ? AND game = ?'
      ).get(socket.user.id, game);

      if (!current || score > current.score) {
        db.prepare(
          'INSERT OR REPLACE INTO high_scores (user_id, game, score, updated_at) VALUES (?, ?, ?, datetime(\'now\'))'
        ).run(socket.user.id, game, score);
      }

      // Broadcast updated leaderboard
      const leaderboard = db.prepare(`
        SELECT hs.user_id, u.username, hs.score
        FROM high_scores hs JOIN users u ON hs.user_id = u.id
        WHERE hs.game = ? AND hs.score > 0
        ORDER BY hs.score DESC LIMIT 50
      `).all(game);
      io.emit('high-scores', { game, leaderboard });
    });

    socket.on('get-high-scores', (data) => {
      if (!data || typeof data !== 'object') return;
      const game = typeof data.game === 'string' ? data.game.trim() : 'flappy';
      const leaderboard = db.prepare(`
        SELECT hs.user_id, u.username, hs.score
        FROM high_scores hs JOIN users u ON hs.user_id = u.id
        WHERE hs.game = ? AND hs.score > 0
        ORDER BY hs.score DESC LIMIT 50
      `).all(game);
      socket.emit('high-scores', { game, leaderboard });
    });

    socket.on('update-server-setting', (data) => {
      if (!data || typeof data !== 'object') return;
      if (!socket.user.isAdmin) {
        return socket.emit('error-msg', 'Only admins can change server settings');
      }

      const key = typeof data.key === 'string' ? data.key.trim() : '';
      const value = typeof data.value === 'string' ? data.value.trim() : '';

      const allowedKeys = ['member_visibility', 'cleanup_enabled', 'cleanup_max_age_days', 'cleanup_max_size_mb'];
      if (!allowedKeys.includes(key)) return;

      if (key === 'member_visibility' && !['all', 'online', 'none'].includes(value)) return;
      if (key === 'cleanup_enabled' && !['true', 'false'].includes(value)) return;
      if (key === 'cleanup_max_age_days') {
        const n = parseInt(value);
        if (isNaN(n) || n < 0 || n > 3650) return;
      }
      if (key === 'cleanup_max_size_mb') {
        const n = parseInt(value);
        if (isNaN(n) || n < 0 || n > 100000) return;
      }

      db.prepare(
        'INSERT OR REPLACE INTO server_settings (key, value) VALUES (?, ?)'
      ).run(key, value);

      // Broadcast to all connected clients
      io.emit('server-setting-changed', { key, value });

      // If visibility changed, re-emit online users for all channels
      if (key === 'member_visibility') {
        for (const [code, users] of channelUsers) {
          emitOnlineUsers(code);
        }
      }
    });

    // ═══════════════ ADMIN: RUN CLEANUP NOW ═════════════════

    socket.on('run-cleanup-now', () => {
      if (!socket.user.isAdmin) {
        return socket.emit('error-msg', 'Only admins can run cleanup');
      }
      // Trigger the global cleanup function exposed on the server
      if (typeof global.runAutoCleanup === 'function') {
        global.runAutoCleanup();
        socket.emit('error-msg', 'Cleanup ran — check server console for details');
      } else {
        socket.emit('error-msg', 'Cleanup function not available');
      }
    });

    // ═══════════════ DISCONNECT ═════════════════════════════

    socket.on('disconnect', () => {
      if (!socket.user) return; // safety guard
      console.log(`❌ ${socket.user.username} disconnected`);

      // Remove from all channel online lists
      for (const [code, users] of channelUsers) {
        if (users.has(socket.user.id)) {
          users.delete(socket.user.id);
          emitOnlineUsers(code);
        }
      }

      // Remove from all voice channels
      for (const [code] of voiceUsers) {
        handleVoiceLeave(socket, code);
      }
    });

    // ── Helpers ─────────────────────────────────────────────

    function handleVoiceLeave(socket, code) {
      const voiceRoom = voiceUsers.get(code);
      if (!voiceRoom || !voiceRoom.has(socket.user.id)) return;

      voiceRoom.delete(socket.user.id);

      // Tell remaining peers to close connection to this user
      for (const [, user] of voiceRoom) {
        io.to(user.socketId).emit('voice-user-left', {
          channelCode: code,
          user: { id: socket.user.id, username: socket.user.username }
        });
      }

      broadcastVoiceUsers(code);
    }

    function broadcastVoiceUsers(code) {
      const room = voiceUsers.get(code);
      const users = room
        ? Array.from(room.values()).map(u => ({ id: u.id, username: u.username }))
        : [];
      io.to(`channel:${code}`).emit('voice-users-update', {
        channelCode: code,
        users
      });
    }

    function emitOnlineUsers(code) {
      const room = channelUsers.get(code);

      const visibility = db.prepare(
        "SELECT value FROM server_settings WHERE key = 'member_visibility'"
      ).get();
      const mode = visibility ? visibility.value : 'online';

      // Also fetch high scores to include in user data
      const scores = {};
      try {
        const scoreRows = db.prepare(
          'SELECT user_id, score FROM high_scores WHERE game = ? AND score > 0'
        ).all('flappy');
        scoreRows.forEach(r => { scores[r.user_id] = r.score; });
      } catch { /* table may not exist yet */ }

      let users;
      if (mode === 'none') {
        users = [];
      } else if (mode === 'all') {
        // Show ALL registered users on the server, mark online ones
        // Exclude banned users
        const allUsers = db.prepare(
          'SELECT u.id, u.username FROM users u LEFT JOIN bans b ON u.id = b.user_id WHERE b.id IS NULL ORDER BY u.username'
        ).all();
        const onlineIds = room ? new Set(room.keys()) : new Set();
        users = allUsers.map(m => ({
          id: m.id, username: m.username, online: onlineIds.has(m.id),
          highScore: scores[m.id] || 0
        }));
      } else {
        // 'online' — only currently online users
        if (!room) return;
        users = Array.from(room.values()).map(u => ({
          id: u.id, username: u.username, online: true,
          highScore: scores[u.id] || 0
        }));
      }

      // Sort: online first, then alphabetical within each group
      users.sort((a, b) => {
        if (a.online !== b.online) return a.online ? -1 : 1;
        return a.username.toLowerCase().localeCompare(b.username.toLowerCase());
      });

      io.to(`channel:${code}`).emit('online-users', {
        channelCode: code,
        users,
        visibilityMode: mode
      });
    }

    // ── Slash command processor ──────────────────────────────
    function processSlashCommand(cmd, arg, username) {
      const commands = {
        shrug:     () => ({ content: `${arg ? arg + ' ' : ''}¯\\_(ツ)_/¯` }),
        tableflip: () => ({ content: `${arg ? arg + ' ' : ''}(╯°□°)╯︵ ┻━┻` }),
        unflip:    () => ({ content: `${arg ? arg + ' ' : ''}┬─┬ ノ( ゜-゜ノ)` }),
        lenny:     () => ({ content: `${arg ? arg + ' ' : ''}( ͡° ͜ʖ ͡°)` }),
        disapprove:() => ({ content: `${arg ? arg + ' ' : ''}ಠ_ಠ` }),
        bbs:       () => ({ content: `🕐 ${username} will be back soon` }),
        boobs:     () => ({ content: `( . Y . )` }),
        brb:       () => ({ content: `⏳ ${username} will be right back` }),
        afk:       () => ({ content: `💤 ${username} is away from keyboard` }),
        me:        () => arg ? ({ content: `_${username} ${arg}_` }) : null,
        spoiler:   () => arg ? ({ content: `||${arg}||` }) : null,
        tts:       () => arg ? ({ content: arg, tts: true }) : null,
        flip:      () => ({ content: `🪙 ${username} flipped a coin: **${Math.random() < 0.5 ? 'Heads' : 'Tails'}**!` }),
        roll:      () => {
          const m = (arg || '1d6').match(/^(\d{1,2})?d(\d{1,4})$/i);
          if (!m) return { content: `🎲 ${username} rolled: **${Math.floor(Math.random() * 6) + 1}**` };
          const count = Math.min(parseInt(m[1] || '1'), 20);
          const sides = Math.min(parseInt(m[2]), 1000);
          const rolls = Array.from({ length: count }, () => Math.floor(Math.random() * sides) + 1);
          const total = rolls.reduce((a, b) => a + b, 0);
          return { content: `🎲 ${username} rolled ${count}d${sides}: [${rolls.join(', ')}] = **${total}**` };
        },
        hug:       () => arg ? ({ content: `🤗 ${username} hugs ${arg}` }) : null,
        wave:      () => ({ content: `👋 ${username} waves${arg ? ' ' + arg : ''}` }),
      };

      const handler = commands[cmd];
      if (!handler) return null;
      return handler();
    }
  });
}

module.exports = { setupSocketHandlers };
