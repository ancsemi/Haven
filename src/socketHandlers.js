const { verifyToken, generateChannelCode, generateToken } = require('./auth');
const crypto = require('crypto');
const webpush = require('web-push');
const HAVEN_VERSION = require('../package.json').version;

// ── Normalize SQLite timestamps to UTC ISO 8601 ────────
// SQLite CURRENT_TIMESTAMP produces UTC without 'Z' suffix;
// browsers mis-interpret bare datetime strings as local time.
function utcStamp(s) {
  if (!s || s.endsWith('Z')) return s;
  return s.replace(' ', 'T') + 'Z';
}

// ── Input validation helpers ────────────────────────────
function isString(v, min = 0, max = Infinity) {
  return typeof v === 'string' && v.length >= min && v.length <= max;
}

function isInt(v) {
  return Number.isInteger(v);
}

// ── Spotify → YouTube resolution ──────────────────────────
// Spotify embeds only give 30-second previews to non-premium users
// and have no external JS API for sync/volume. We resolve the track
// title via Spotify oEmbed, then find it on YouTube for full playback.
async function resolveSpotifyToYouTube(spotifyUrl) {
  try {
    // 1. Get track title from Spotify oEmbed (no auth needed)
    const oembedRes = await fetch(
      `https://open.spotify.com/oembed?url=${encodeURIComponent(spotifyUrl)}`
    );
    if (!oembedRes.ok) return null;
    const oembed = await oembedRes.json();
    const title = oembed.title; // e.g. "Thank You - Dido"
    if (!title) return null;

    // 2. Search YouTube for the track (return first result)
    const results = await searchYouTube(title + ' official audio', 1);
    return results.length > 0 ? `https://www.youtube.com/watch?v=${results[0].videoId}` : null;
  } catch {
    return null;
  }
}

// ── YouTube search helper ─────────────────────────────────
// Scrapes YouTube search results HTML and extracts video info.
// Returns array of { videoId, title, channel, duration, thumbnail }
const YT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function searchYouTube(query, count = 5, offset = 0) {
  try {
    const res = await fetch(
      `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`,
      { headers: { 'User-Agent': YT_UA } }
    );
    const html = await res.text();

    // Extract ytInitialData JSON which contains structured search results
    const dataMatch = html.match(/var\s+ytInitialData\s*=\s*({.+?});\s*<\/script>/s);
    if (dataMatch) {
      try {
        const ytData = JSON.parse(dataMatch[1]);
        const contents = ytData?.contents?.twoColumnSearchResultsRenderer
          ?.primaryContents?.sectionListRenderer?.contents;
        if (contents) {
          const videos = [];
          for (const section of contents) {
            const items = section?.itemSectionRenderer?.contents;
            if (!items) continue;
            for (const item of items) {
              const vr = item.videoRenderer;
              if (!vr || !vr.videoId) continue;
              videos.push({
                videoId: vr.videoId,
                title: vr.title?.runs?.[0]?.text || 'Unknown',
                channel: vr.ownerText?.runs?.[0]?.text || '',
                duration: vr.lengthText?.simpleText || '',
                thumbnail: vr.thumbnail?.thumbnails?.[0]?.url || ''
              });
            }
          }
          return videos.slice(offset, offset + count);
        }
      } catch { /* JSON parse failed, fall through to regex */ }
    }

    // Fallback: regex extraction (less info, just videoId)
    const matches = [...html.matchAll(/"videoId":"([a-zA-Z0-9_-]{11})"/g)];
    const seen = new Set();
    const results = [];
    for (const m of matches) {
      if (!seen.has(m[1])) {
        seen.add(m[1]);
        results.push({ videoId: m[1], title: '', channel: '', duration: '', thumbnail: '' });
      }
    }
    return results.slice(offset, offset + count);
  } catch {
    return [];
  }
}
function setupSocketHandlers(io, db) {
  const ADMIN_USERNAME = (process.env.ADMIN_USERNAME || 'admin').toLowerCase();

  // ── Permission system helpers ───────────────────────────
  // Role hierarchy: Admin (100) > Server Mod (50) > Channel Mod (25) > User (0)
  function getUserEffectiveLevel(userId, channelId = null) {
    // Admin is always level 100
    const user = db.prepare('SELECT is_admin FROM users WHERE id = ?').get(userId);
    if (user && user.is_admin) return 100;

    // Check server-scoped roles first (highest level wins)
    const serverRole = db.prepare(`
      SELECT MAX(r.level) as maxLevel FROM roles r
      JOIN user_roles ur ON r.id = ur.role_id
      WHERE ur.user_id = ? AND r.scope = 'server' AND ur.channel_id IS NULL
    `).get(userId);
    let level = (serverRole && serverRole.maxLevel) || 0;

    // If channel specified, also check channel-scoped roles
    if (channelId) {
      const channelRole = db.prepare(`
        SELECT MAX(r.level) as maxLevel FROM roles r
        JOIN user_roles ur ON r.id = ur.role_id
        WHERE ur.user_id = ? AND ur.channel_id = ?
      `).get(userId, channelId);
      if (channelRole && channelRole.maxLevel && channelRole.maxLevel > level) {
        level = channelRole.maxLevel;
      }
    }
    return level;
  }

  function userHasPermission(userId, permission, channelId = null) {
    // Admin has all permissions
    const user = db.prepare('SELECT is_admin FROM users WHERE id = ?').get(userId);
    if (user && user.is_admin) return true;

    // Check server-scoped roles
    const serverPerm = db.prepare(`
      SELECT rp.allowed FROM role_permissions rp
      JOIN roles r ON rp.role_id = r.id
      JOIN user_roles ur ON r.id = ur.role_id
      WHERE ur.user_id = ? AND rp.permission = ? AND r.scope = 'server' AND ur.channel_id IS NULL AND rp.allowed = 1
      LIMIT 1
    `).get(userId, permission);
    if (serverPerm) return true;

    // Check channel-scoped roles
    if (channelId) {
      const channelPerm = db.prepare(`
        SELECT rp.allowed FROM role_permissions rp
        JOIN roles r ON rp.role_id = r.id
        JOIN user_roles ur ON r.id = ur.role_id
        WHERE ur.user_id = ? AND rp.permission = ? AND ur.channel_id = ? AND rp.allowed = 1
        LIMIT 1
      `).get(userId, permission, channelId);
      if (channelPerm) return true;
    }
    return false;
  }

  function getUserRoles(userId) {
    return db.prepare(`
      SELECT r.id, r.name, r.level, r.scope, r.color, ur.channel_id
      FROM roles r
      JOIN user_roles ur ON r.id = ur.role_id
      WHERE ur.user_id = ?
      ORDER BY r.level DESC
    `).all(userId);
  }

  function getUserHighestRole(userId, channelId = null) {
    const user = db.prepare('SELECT is_admin FROM users WHERE id = ?').get(userId);
    if (user && user.is_admin) return { name: 'Admin', level: 100, color: '#e74c3c' };

    let role = db.prepare(`
      SELECT r.name, r.level, r.color FROM roles r
      JOIN user_roles ur ON r.id = ur.role_id
      WHERE ur.user_id = ? AND r.scope = 'server' AND ur.channel_id IS NULL
      ORDER BY r.level DESC LIMIT 1
    `).get(userId);

    if (channelId) {
      const chRole = db.prepare(`
        SELECT r.name, r.level, r.color FROM roles r
        JOIN user_roles ur ON r.id = ur.role_id
        WHERE ur.user_id = ? AND ur.channel_id = ?
        ORDER BY r.level DESC LIMIT 1
      `).get(userId, channelId);
      if (chRole && (!role || chRole.level > role.level)) role = chRole;
    }
    return role || null;
  }

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

    // Refresh display_name, avatar AND is_admin from DB (JWT may be stale)
    try {
      const uRow = db.prepare('SELECT display_name, is_admin, username, avatar, avatar_shape FROM users WHERE id = ?').get(user.id);
      socket.user.displayName = (uRow && uRow.display_name) ? uRow.display_name : user.username;
      socket.user.avatar = (uRow && uRow.avatar) ? uRow.avatar : null;
      socket.user.avatar_shape = (uRow && uRow.avatar_shape) ? uRow.avatar_shape : 'circle';
      if (uRow) {
        // Sync admin status from .env (handles ADMIN_USERNAME changes)
        const shouldBeAdmin = uRow.username.toLowerCase() === ADMIN_USERNAME ? 1 : 0;
        if (uRow.is_admin !== shouldBeAdmin) {
          db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(shouldBeAdmin, user.id);
        }
        socket.user.isAdmin = !!shouldBeAdmin;
      }
    } catch {
      socket.user.displayName = user.displayName || user.username;
    }

    // Load user status from DB
    try {
      const statusRow = db.prepare('SELECT status, status_text FROM users WHERE id = ?').get(user.id);
      if (statusRow) {
        socket.user.status = statusRow.status || 'online';
        socket.user.statusText = statusRow.status_text || '';
      }
    } catch { /* columns may not exist on old db */ }

    // Load user roles
    try {
      socket.user.roles = getUserRoles(user.id);
      socket.user.effectiveLevel = getUserEffectiveLevel(user.id);
    } catch { socket.user.roles = []; socket.user.effectiveLevel = socket.user.isAdmin ? 100 : 0; }

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
  // Active music per voice room:  code → { url, userId, username } | null
  const activeMusic = new Map();
  // Active screen sharers per voice room:  code → Set<userId>
  const activeScreenSharers = new Map();

  // ── Push notification helper ──────────────────────────────
  // Sends push notifications for a new message to all channel members
  // who are NOT currently connected via Socket.IO.
  function sendPushNotifications(channelId, channelCode, channelName, senderUserId, senderUsername, messageContent) {
    try {
      // Get all connected user IDs
      const connectedUserIds = new Set();
      for (const [, s] of io.sockets.sockets) {
        if (s.user) connectedUserIds.add(s.user.id);
      }

      // Get push subscriptions for channel members who are offline
      const subs = db.prepare(`
        SELECT ps.endpoint, ps.p256dh, ps.auth, ps.user_id
        FROM push_subscriptions ps
        JOIN channel_members cm ON cm.user_id = ps.user_id
        WHERE cm.channel_id = ?
          AND ps.user_id != ?
      `).all(channelId, senderUserId);

      if (!subs.length) return;

      // Truncate message for notification body
      const body = messageContent.length > 120
        ? messageContent.slice(0, 117) + '...'
        : messageContent;

      const payload = JSON.stringify({
        title: `${senderUsername} in #${channelName}`,
        body,
        channelCode,
        tag: `haven-${channelCode}`,
        url: '/app.html'
      });

      for (const sub of subs) {
        // Skip users who are currently connected (they get real-time events)
        if (connectedUserIds.has(sub.user_id)) continue;

        const pushSub = {
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth }
        };

        webpush.sendNotification(pushSub, payload).catch((err) => {
          if (err.statusCode === 410 || err.statusCode === 404) {
            // Subscription expired or invalid — remove it
            try {
              db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(sub.endpoint);
            } catch { /* non-critical */ }
          }
        });
      }
    } catch (err) {
      console.error('Push notification error:', err.message);
    }
  }

  // ── Time-based channel code rotation (check every 30s) ───
  setInterval(() => {
    try {
      const dynamicChannels = db.prepare(
        "SELECT * FROM channels WHERE code_mode = 'dynamic' AND code_rotation_type = 'time' AND is_dm = 0"
      ).all();

      const now = Date.now();

      for (const ch of dynamicChannels) {
        const lastRotated = new Date(ch.code_last_rotated + 'Z').getTime();
        const intervalMs = (ch.code_rotation_interval || 60) * 60 * 1000;

        if (now - lastRotated >= intervalMs) {
          const oldCode = ch.code;
          const newCode = generateChannelCode();

          db.prepare(
            'UPDATE channels SET code = ?, code_rotation_counter = 0, code_last_rotated = CURRENT_TIMESTAMP WHERE id = ?'
          ).run(newCode, ch.id);

          // Move all sockets from old room to new room
          const oldRoom = `channel:${oldCode}`;
          const newRoom = `channel:${newCode}`;
          const roomSockets = io.sockets.adapter.rooms.get(oldRoom);
          if (roomSockets) {
            for (const sid of [...roomSockets]) {
              const s = io.sockets.sockets.get(sid);
              if (s) { s.leave(oldRoom); s.join(newRoom); }
            }
          }

          // Update channelUsers map key
          if (channelUsers.has(oldCode)) {
            channelUsers.set(newCode, channelUsers.get(oldCode));
            channelUsers.delete(oldCode);
          }

          // Update voiceUsers map key
          if (voiceUsers.has(oldCode)) {
            voiceUsers.set(newCode, voiceUsers.get(oldCode));
            voiceUsers.delete(oldCode);
          }

          // Notify all members of the code change
          io.to(newRoom).emit('channel-code-rotated', {
            channelId: ch.id,
            oldCode,
            newCode
          });

          console.log(`🔄 Auto-rotated code for channel "${ch.name}": ${oldCode} → ${newCode}`);
        }
      }
    } catch (err) {
      console.error('Channel code rotation error:', err);
    }
  }, 30 * 1000);

  io.on('connection', (socket) => {
    // Guard: if auth middleware somehow didn't attach user, disconnect
    if (!socket.user || !socket.user.username) {
      console.warn('⚠️  Connection without valid user — disconnecting');
      socket.disconnect(true);
      return;
    }

    console.log(`✅ ${socket.user.username} connected`);
    socket.currentChannel = null;

    // Push authoritative user info to the client on every connect/reconnect
    // so stale localStorage is always corrected
    socket.emit('session-info', {
      id: socket.user.id,
      username: socket.user.username,
      isAdmin: socket.user.isAdmin,
      displayName: socket.user.displayName,
      avatar: socket.user.avatar || null,
      avatarShape: socket.user.avatar_shape || 'circle',
      version: HAVEN_VERSION,
      roles: socket.user.roles || [],
      effectiveLevel: socket.user.effectiveLevel || 0
    });

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

    // ── Helper: get enriched channel list for a user ───────
    function getEnrichedChannels(userId, isAdmin, joinRooms) {
      const channels = db.prepare(`
        SELECT c.id, c.name, c.code, c.created_by, c.topic, c.is_dm,
               c.code_visibility, c.code_mode, c.code_rotation_type, c.code_rotation_interval,
               c.parent_channel_id, c.position, c.is_private
        FROM channels c
        JOIN channel_members cm ON c.id = cm.channel_id
        WHERE cm.user_id = ?
        ORDER BY c.is_dm, c.name
      `).all(userId);

      if (channels.length > 0) {
        const channelIds = channels.map(c => c.id);
        const placeholders = channelIds.map(() => '?').join(',');

        const readRows = db.prepare(
          `SELECT channel_id, last_read_message_id FROM read_positions WHERE user_id = ? AND channel_id IN (${placeholders})`
        ).all(userId, ...channelIds);
        const readMap = {};
        readRows.forEach(r => { readMap[r.channel_id] = r.last_read_message_id; });

        const latestRows = db.prepare(
          `SELECT channel_id, MAX(id) as latest_id FROM messages WHERE channel_id IN (${placeholders}) GROUP BY channel_id`
        ).all(...channelIds);
        const latestMap = {};
        latestRows.forEach(r => { latestMap[r.channel_id] = r.latest_id; });

        channels.forEach(ch => {
          const lastRead = readMap[ch.id] || 0;
          const latestId = latestMap[ch.id] || 0;
          if (latestId > lastRead) {
            const countRow = db.prepare(
              'SELECT COUNT(*) as cnt FROM messages WHERE channel_id = ? AND id > ? AND user_id != ?'
            ).get(ch.id, lastRead, userId);
            ch.unreadCount = countRow ? countRow.cnt : 0;
          } else {
            ch.unreadCount = 0;
          }

          if (ch.is_dm) {
            const otherUser = db.prepare(`
              SELECT u.id, COALESCE(u.display_name, u.username) as username FROM users u
              JOIN channel_members cm ON u.id = cm.user_id
              WHERE cm.channel_id = ? AND u.id != ?
            `).get(ch.id, userId);
            ch.dm_target = otherUser || null;
          }
        });
      }

      if (joinRooms) {
        channels.forEach(ch => joinRooms(`channel:${ch.code}`));
      }

      if (!isAdmin) {
        channels.forEach(ch => {
          if (ch.code_visibility === 'private') ch.code = '••••••••';
        });
      }

      return channels;
    }

    // Helper: broadcast enriched channel list to all connected clients
    function broadcastChannelLists() {
      for (const [, s] of io.sockets.sockets) {
        if (s.user) {
          s.emit('channels-list', getEnrichedChannels(s.user.id, s.user.isAdmin, null));
        }
      }
    }

    // ── Get user's channels ─────────────────────────────────
    socket.on('get-channels', () => {
      const channels = getEnrichedChannels(
        socket.user.id,
        socket.user.isAdmin,
        (room) => socket.join(room)
      );
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
          created_by: socket.user.id,
          topic: '',
          is_dm: 0
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

        // Auto-add to all non-private sub-channels of this channel
        if (!channel.parent_channel_id) {
          const subs = db.prepare(
            'SELECT id, code FROM channels WHERE parent_channel_id = ? AND is_private = 0'
          ).all(channel.id);
          const insertSub = db.prepare('INSERT OR IGNORE INTO channel_members (channel_id, user_id) VALUES (?, ?)');
          subs.forEach(sub => {
            insertSub.run(sub.id, socket.user.id);
            socket.join(`channel:${sub.code}`);
          });
        }

        // Join-based code rotation: increment counter and rotate if threshold reached
        if (channel.code_mode === 'dynamic' && channel.code_rotation_type === 'joins') {
          const newCount = (channel.code_rotation_counter || 0) + 1;
          const threshold = channel.code_rotation_interval || 5;
          if (newCount >= threshold) {
            const newCode = generateChannelCode();
            db.prepare(
              'UPDATE channels SET code = ?, code_rotation_counter = 0, code_last_rotated = CURRENT_TIMESTAMP WHERE id = ?'
            ).run(newCode, channel.id);
            // Move all sockets from old room to new room
            const oldRoom = `channel:${code}`;
            const newRoom = `channel:${newCode}`;
            const roomSockets = io.sockets.adapter.rooms.get(oldRoom);
            if (roomSockets) {
              for (const sid of [...roomSockets]) {
                const s = io.sockets.sockets.get(sid);
                if (s) { s.leave(oldRoom); s.join(newRoom); }
              }
            }
            // Update channelUsers map key
            if (channelUsers.has(code)) {
              channelUsers.set(newCode, channelUsers.get(code));
              channelUsers.delete(code);
            }
            // Notify all channel members of the code rotation
            io.to(newRoom).emit('channel-code-rotated', { channelId: channel.id, oldCode: code, newCode });
            channel.code = newCode;
          } else {
            db.prepare('UPDATE channels SET code_rotation_counter = ? WHERE id = ?').run(newCount, channel.id);
          }
        }
      }

      // Use channel.code (may have been rotated above)
      const activeCode = channel.code;
      socket.join(`channel:${activeCode}`);

      // Notify channel
      io.to(`channel:${activeCode}`).emit('user-joined', {
        channelCode: activeCode,
        user: { id: socket.user.id, username: socket.user.displayName }
      });

      // Send channel info to joiner
      socket.emit('channel-joined', {
        id: channel.id,
        name: channel.name,
        code: activeCode,
        created_by: channel.created_by,
        topic: channel.topic || '',
        is_dm: channel.is_dm || 0
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
        username: socket.user.displayName,
        socketId: socket.id,
        status: socket.user.status || 'online',
        statusText: socket.user.statusText || '',
        avatar: socket.user.avatar || null,
        avatar_shape: socket.user.avatar_shape || 'circle'
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
          SELECT m.id, m.content, m.created_at, m.reply_to, m.edited_at, m.is_webhook, m.webhook_username,
                 COALESCE(m.webhook_username, u.display_name, u.username, '[Deleted User]') as username, u.id as user_id, u.avatar, COALESCE(u.avatar_shape, 'circle') as avatar_shape
          FROM messages m LEFT JOIN users u ON m.user_id = u.id
          WHERE m.channel_id = ? AND m.id < ?
          ORDER BY m.created_at DESC LIMIT ?
        `).all(channel.id, before, limit);
      } else {
        messages = db.prepare(`
          SELECT m.id, m.content, m.created_at, m.reply_to, m.edited_at, m.is_webhook, m.webhook_username,
                 COALESCE(m.webhook_username, u.display_name, u.username, '[Deleted User]') as username, u.id as user_id, u.avatar, COALESCE(u.avatar_shape, 'circle') as avatar_shape
          FROM messages m LEFT JOIN users u ON m.user_id = u.id
          WHERE m.channel_id = ?
          ORDER BY m.created_at DESC LIMIT ?
        `).all(channel.id, limit);
      }

      // Batch-enrich messages (reply context, reactions, pin status) in 3 queries
      // instead of N+1 per-message lookups.
      const msgIds = messages.map(m => m.id);
      const replyIds = [...new Set(messages.filter(m => m.reply_to).map(m => m.reply_to))];

      // Batch reply context
      const replyMap = new Map();
      if (replyIds.length > 0) {
        const ph = replyIds.map(() => '?').join(',');
        db.prepare(`
          SELECT m.id, m.content, COALESCE(u.display_name, u.username, '[Deleted User]') as username
          FROM messages m LEFT JOIN users u ON m.user_id = u.id
          WHERE m.id IN (${ph})
        `).all(...replyIds).forEach(r => replyMap.set(r.id, r));
      }

      // Batch reactions
      const reactionMap = new Map(); // messageId → [reactions]
      if (msgIds.length > 0) {
        const ph = msgIds.map(() => '?').join(',');
        db.prepare(`
          SELECT r.message_id, r.emoji, r.user_id, COALESCE(u.display_name, u.username) as username
          FROM reactions r JOIN users u ON r.user_id = u.id
          WHERE r.message_id IN (${ph})
        `).all(...msgIds).forEach(r => {
          if (!reactionMap.has(r.message_id)) reactionMap.set(r.message_id, []);
          reactionMap.get(r.message_id).push({ emoji: r.emoji, user_id: r.user_id, username: r.username });
        });

        // Batch pin status
        var pinnedSet = new Set(
          db.prepare(`SELECT message_id FROM pinned_messages WHERE message_id IN (${ph})`)
            .all(...msgIds).map(r => r.message_id)
        );
      }

      const enriched = messages.map(m => {
        const obj = { ...m };
        // Normalize SQLite UTC timestamps to proper ISO 8601 with Z suffix
        if (obj.created_at && !obj.created_at.endsWith('Z')) obj.created_at = utcStamp(obj.created_at);
        if (obj.edited_at && !obj.edited_at.endsWith('Z')) obj.edited_at = utcStamp(obj.edited_at);
        obj.replyContext = m.reply_to ? (replyMap.get(m.reply_to) || null) : null;
        obj.reactions = reactionMap.get(m.id) || [];
        obj.pinned = pinnedSet ? pinnedSet.has(m.id) : false;
        // Flag webhook messages so the client renders a BOT badge
        if (m.is_webhook) {
          obj.is_webhook = true;
          obj.username = `[BOT] ${m.webhook_username || 'Bot'}`;
          obj.avatar_shape = 'square';
        }
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

      // Escape LIKE wildcards so user can't match everything with % or _
      const escapedQuery = query.replace(/[%_\\]/g, '\\$&');
      const results = db.prepare(`
        SELECT m.id, m.content, m.created_at,
               COALESCE(u.display_name, u.username, '[Deleted User]') as username, u.id as user_id
        FROM messages m LEFT JOIN users u ON m.user_id = u.id
        WHERE m.channel_id = ? AND m.content LIKE ? ESCAPE '\\'
        ORDER BY m.created_at DESC LIMIT 25
      `).all(channel.id, `%${escapedQuery}%`);

      // Normalize SQLite UTC timestamps for search results
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

      const channel = db.prepare('SELECT id, name FROM channels WHERE code = ?').get(code);
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
        const slashResult = processSlashCommand(cmd, arg, socket.user.displayName);
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

          // Send push notifications to offline channel members
          sendPushNotifications(channel.id, code, channel.name, socket.user.id, socket.user.displayName, slashResult.content);

          // Auto-update sender's read position for slash command messages too
          try {
            db.prepare(`
              INSERT INTO read_positions (user_id, channel_id, last_read_message_id)
              VALUES (?, ?, ?)
              ON CONFLICT(user_id, channel_id) DO UPDATE SET last_read_message_id = MAX(last_read_message_id, excluded.last_read_message_id)
            `).run(socket.user.id, channel.id, result.lastInsertRowid);
          } catch (e) { /* non-critical */ }
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
        username: socket.user.displayName,
        user_id: socket.user.id,
        avatar: socket.user.avatar || null,
        avatar_shape: socket.user.avatar_shape || 'circle',
        reply_to: replyTo,
        replyContext: null,
        reactions: [],
        edited_at: null
      };

      // Attach reply context if replying
      if (replyTo) {
        message.replyContext = db.prepare(`
          SELECT m.id, m.content, COALESCE(u.display_name, u.username, '[Deleted User]') as username FROM messages m
          LEFT JOIN users u ON m.user_id = u.id WHERE m.id = ?
        `).get(replyTo) || null;
      }

      io.to(`channel:${code}`).emit('new-message', { channelCode: code, message });

      // Send push notifications to offline channel members
      sendPushNotifications(channel.id, code, channel.name, socket.user.id, socket.user.displayName, content.trim());

      // Auto-update sender's read position so own messages never count as unread
      try {
        db.prepare(`
          INSERT INTO read_positions (user_id, channel_id, last_read_message_id)
          VALUES (?, ?, ?)
          ON CONFLICT(user_id, channel_id) DO UPDATE SET last_read_message_id = MAX(last_read_message_id, excluded.last_read_message_id)
        `).run(socket.user.id, channel.id, result.lastInsertRowid);
      } catch (e) { /* non-critical */ }
    });

    // ── Typing indicator ────────────────────────────────────
    socket.on('typing', (data) => {
      if (!data || typeof data !== 'object') return;
      if (!isString(data.code, 8, 8)) return;
      // Only allow typing in the channel the user is currently in
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

      // Leave any previous voice room first
      for (const [prevCode, room] of voiceUsers) {
        if (room.has(socket.user.id) && prevCode !== code) {
          handleVoiceLeave(socket, prevCode);
        }
      }

      if (!voiceUsers.has(code)) voiceUsers.set(code, new Map());

      // Join dedicated voice socket.io room (independent of text channel room)
      socket.join(`voice:${code}`);

      // Existing users before this one joins
      const existingUsers = Array.from(voiceUsers.get(code).values());

      // Add new voice user
      voiceUsers.get(code).set(socket.user.id, {
        id: socket.user.id,
        username: socket.user.displayName,
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
          user: { id: socket.user.id, username: socket.user.displayName }
        });
      });

      // Update voice user list for voice participants + text viewers
      broadcastVoiceUsers(code);

      // Send active music state to late joiner
      const music = activeMusic.get(code);
      if (music) {
        socket.emit('music-shared', {
          userId: music.userId,
          username: music.username,
          url: music.url,
          channelCode: code,
          resolvedFrom: music.resolvedFrom
        });
      }

      // Send active screen share info to late joiner — tell screen sharers to renegotiate
      const sharers = activeScreenSharers.get(code);
      if (sharers && sharers.size > 0) {
        // Notify the late joiner about active sharers (for UI indicators)
        socket.emit('active-screen-sharers', {
          channelCode: code,
          sharers: Array.from(sharers).map(uid => {
            const u = voiceUsers.get(code)?.get(uid);
            return u ? { id: uid, username: u.username } : null;
          }).filter(Boolean)
        });
        // After a short delay (let initial offer/answer complete), tell each
        // screen sharer to renegotiate so the late joiner receives video tracks.
        setTimeout(() => {
          for (const sharerId of sharers) {
            const sharerInfo = voiceUsers.get(code)?.get(sharerId);
            if (sharerInfo) {
              io.to(sharerInfo.socketId).emit('renegotiate-screen', {
                targetUserId: socket.user.id,
                channelCode: code
              });
            }
          }
        }, 2000);
      }
    });

    socket.on('voice-offer', (data) => {
      if (!data || typeof data !== 'object') return;
      if (!isString(data.code, 8, 8) || !isInt(data.targetUserId) || !data.offer) return;
      // Verify sender is in the voice room
      if (!voiceUsers.get(data.code)?.has(socket.user.id)) return;
      const target = voiceUsers.get(data.code)?.get(data.targetUserId);
      if (target) {
        io.to(target.socketId).emit('voice-offer', {
          from: { id: socket.user.id, username: socket.user.displayName },
          offer: data.offer,
          channelCode: data.code
        });
      }
    });

    socket.on('voice-answer', (data) => {
      if (!data || typeof data !== 'object') return;
      if (!isString(data.code, 8, 8) || !isInt(data.targetUserId) || !data.answer) return;
      if (!voiceUsers.get(data.code)?.has(socket.user.id)) return;
      const target = voiceUsers.get(data.code)?.get(data.targetUserId);
      if (target) {
        io.to(target.socketId).emit('voice-answer', {
          from: { id: socket.user.id, username: socket.user.displayName },
          answer: data.answer,
          channelCode: data.code
        });
      }
    });

    socket.on('voice-ice-candidate', (data) => {
      if (!data || typeof data !== 'object') return;
      if (!isString(data.code, 8, 8) || !isInt(data.targetUserId)) return;
      if (!voiceUsers.get(data.code)?.has(socket.user.id)) return;
      const target = voiceUsers.get(data.code)?.get(data.targetUserId);
      if (target) {
        io.to(target.socketId).emit('voice-ice-candidate', {
          from: { id: socket.user.id, username: socket.user.displayName },
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

    // ── Screen Sharing Signaling ──────────────────────────

    socket.on('screen-share-started', (data) => {
      if (!data || typeof data !== 'object') return;
      if (!isString(data.code, 8, 8)) return;
      const voiceRoom = voiceUsers.get(data.code);
      if (!voiceRoom || !voiceRoom.has(socket.user.id)) return;
      // Track active screen sharer
      if (!activeScreenSharers.has(data.code)) activeScreenSharers.set(data.code, new Set());
      activeScreenSharers.get(data.code).add(socket.user.id);
      // Broadcast to all voice users in the channel
      for (const [uid, user] of voiceRoom) {
        if (uid !== socket.user.id) {
          io.to(user.socketId).emit('screen-share-started', {
            userId: socket.user.id,
            username: socket.user.displayName,
            channelCode: data.code,
            hasAudio: !!data.hasAudio
          });
        }
      }
    });

    socket.on('screen-share-stopped', (data) => {
      if (!data || typeof data !== 'object') return;
      if (!isString(data.code, 8, 8)) return;
      const voiceRoom = voiceUsers.get(data.code);
      if (!voiceRoom || !voiceRoom.has(socket.user.id)) return;
      // Untrack screen sharer
      const sharers = activeScreenSharers.get(data.code);
      if (sharers) { sharers.delete(socket.user.id); if (sharers.size === 0) activeScreenSharers.delete(data.code); }
      for (const [uid, user] of voiceRoom) {
        if (uid !== socket.user.id) {
          io.to(user.socketId).emit('screen-share-stopped', {
            userId: socket.user.id,
            channelCode: data.code
          });
        }
      }
    });

    // ── Music Sharing ───────────────────────────────────

    socket.on('music-share', async (data) => {
      if (!data || typeof data !== 'object') return;
      if (!isString(data.code, 8, 8)) return;
      if (!isString(data.url, 1, 500)) return;
      const voiceRoom = voiceUsers.get(data.code);
      if (!voiceRoom || !voiceRoom.has(socket.user.id)) return;

      let playUrl = data.url;
      let resolvedFrom = null;

      // Convert Spotify tracks → YouTube for universal full playback + sync
      const spotifyTrack = data.url.match(/open\.spotify\.com\/(track)\/([a-zA-Z0-9]+)/);
      if (spotifyTrack) {
        const ytUrl = await resolveSpotifyToYouTube(data.url);
        if (ytUrl) {
          playUrl = ytUrl;
          resolvedFrom = 'spotify';
        }
      }

      // Store active music for late joiners
      activeMusic.set(data.code, {
        url: playUrl,
        userId: socket.user.id,
        username: socket.user.displayName,
        resolvedFrom
      });
      for (const [uid, user] of voiceRoom) {
        io.to(user.socketId).emit('music-shared', {
          userId: socket.user.id,
          username: socket.user.displayName,
          url: playUrl,
          channelCode: data.code,
          resolvedFrom
        });
      }
    });

    socket.on('music-stop', (data) => {
      if (!data || typeof data !== 'object') return;
      if (!isString(data.code, 8, 8)) return;
      const voiceRoom = voiceUsers.get(data.code);
      if (!voiceRoom || !voiceRoom.has(socket.user.id)) return;
      // Clear active music
      activeMusic.delete(data.code);
      for (const [uid, user] of voiceRoom) {
        io.to(user.socketId).emit('music-stopped', {
          userId: socket.user.id,
          username: socket.user.displayName,
          channelCode: data.code
        });
      }
    });

    // Music playback control sync (play/pause)
    socket.on('music-control', (data) => {
      if (!data || typeof data !== 'object') return;
      if (!isString(data.code, 8, 8)) return;
      const action = data.action;
      if (action !== 'play' && action !== 'pause') return;
      const voiceRoom = voiceUsers.get(data.code);
      if (!voiceRoom || !voiceRoom.has(socket.user.id)) return;
      for (const [uid, user] of voiceRoom) {
        if (uid === socket.user.id) continue; // don't echo back to sender
        io.to(user.socketId).emit('music-control', {
          action,
          userId: socket.user.id,
          username: socket.user.displayName,
          channelCode: data.code
        });
      }
    });

    // Music search — user types /play <query> to search by name
    socket.on('music-search', async (data) => {
      if (!data || typeof data !== 'object') return;
      if (!isString(data.query, 1, 200)) return;
      const offset = isInt(data.offset) && data.offset >= 0 ? data.offset : 0;

      try {
        const results = await searchYouTube(data.query, 5, offset);
        socket.emit('music-search-results', {
          results,
          query: data.query,
          offset
        });
      } catch {
        socket.emit('music-search-results', { results: [], query: data.query, offset });
      }
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
          SELECT r.emoji, r.user_id, COALESCE(u.display_name, u.username) as username FROM reactions r
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

      // Verify message belongs to this channel
      const channel = db.prepare('SELECT id FROM channels WHERE code = ?').get(code);
      if (!channel) return;
      const msgCheck = db.prepare('SELECT id FROM messages WHERE id = ? AND channel_id = ?').get(data.messageId, channel.id);
      if (!msgCheck) return;

      db.prepare(
        'DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?'
      ).run(data.messageId, socket.user.id, data.emoji);

      const reactions = db.prepare(`
        SELECT r.emoji, r.user_id, COALESCE(u.display_name, u.username) as username FROM reactions r
        JOIN users u ON r.user_id = u.id WHERE r.message_id = ?
      `).all(data.messageId);

      io.to(`channel:${code}`).emit('reactions-updated', {
        channelCode: code,
        messageId: data.messageId,
        reactions
      });
    });

    // ═══════════════ CHANNEL MEMBERS (for @mentions) ═════════

    // Periodic member list refresh — client sends this every 30s
    socket.on('request-online-users', (data) => {
      if (!data || typeof data !== 'object') return;
      const code = typeof data.code === 'string' ? data.code.trim() : '';
      if (!code || !/^[a-f0-9]{8}$/i.test(code)) return;
      emitOnlineUsers(code);
    });

    // On-demand voice user list fetch — client can request at any time
    socket.on('request-voice-users', (data) => {
      if (!data || typeof data !== 'object') return;
      const code = typeof data.code === 'string' ? data.code.trim() : '';
      if (!code || !/^[a-f0-9]{8}$/i.test(code)) return;
      const room = voiceUsers.get(code);
      const users = room
        ? Array.from(room.values()).map(u => ({ id: u.id, username: u.username }))
        : [];
      socket.emit('voice-users-update', { channelCode: code, users });
    });

    // Voice re-join after socket reconnect — server lost state during disconnect
    socket.on('voice-rejoin', (data) => {
      if (!data || typeof data !== 'object') return;
      const code = typeof data.code === 'string' ? data.code.trim() : '';
      if (!code || !/^[a-f0-9]{8}$/i.test(code)) return;

      // Verify channel membership
      const vch = db.prepare('SELECT id FROM channels WHERE code = ?').get(code);
      if (!vch) return;
      const vMember = db.prepare(
        'SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?'
      ).get(vch.id, socket.user.id);
      if (!vMember) return;

      // Leave any other voice rooms first
      for (const [prevCode, room] of voiceUsers) {
        if (room.has(socket.user.id) && prevCode !== code) {
          handleVoiceLeave(socket, prevCode);
        }
      }

      if (!voiceUsers.has(code)) voiceUsers.set(code, new Map());

      // Re-join the voice socket.io room
      socket.join(`voice:${code}`);

      // Re-add to voice users (update socketId to new socket)
      voiceUsers.get(code).set(socket.user.id, {
        id: socket.user.id,
        username: socket.user.displayName,
        socketId: socket.id
      });

      // Tell existing peers about the re-joined user so they can re-establish WebRTC
      const existingUsers = Array.from(voiceUsers.get(code).values())
        .filter(u => u.id !== socket.user.id);

      socket.emit('voice-existing-users', {
        channelCode: code,
        users: existingUsers.map(u => ({ id: u.id, username: u.username }))
      });

      existingUsers.forEach(u => {
        io.to(u.socketId).emit('voice-user-joined', {
          channelCode: code,
          user: { id: socket.user.id, username: socket.user.displayName }
        });
      });

      broadcastVoiceUsers(code);
    });

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
        SELECT u.id, COALESCE(u.display_name, u.username) as username, u.username as loginName FROM users u
        JOIN channel_members cm ON u.id = cm.user_id
        WHERE cm.channel_id = ?
        ORDER BY COALESCE(u.display_name, u.username)
      `).all(channel.id);

      socket.emit('channel-members', { channelCode: code, members });
    });

    // ═══════════════ USERNAME RENAME ══════════════════

    socket.on('rename-user', (data) => {
      if (!data || typeof data !== 'object') return;
      const newName = typeof data.username === 'string' ? data.username.trim().replace(/\s+/g, ' ') : '';

      if (!newName || newName.length < 2 || newName.length > 20) {
        return socket.emit('error-msg', 'Display name must be 2-20 characters');
      }
      if (!/^[a-zA-Z0-9_ ]+$/.test(newName)) {
        return socket.emit('error-msg', 'Letters, numbers, underscores, and spaces only');
      }

      // Display names don't need to be unique — multiple users can share a name
      try {
        db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(newName, socket.user.id);
      } catch (err) {
        console.error('Rename error:', err);
        return socket.emit('error-msg', 'Failed to update display name');
      }

      const oldName = socket.user.displayName;
      socket.user.displayName = newName;

      // Issue fresh JWT with new display name (login username unchanged)
      const newToken = generateToken({
        id: socket.user.id,
        username: socket.user.username,
        isAdmin: socket.user.isAdmin,
        displayName: newName
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
        user: { id: socket.user.id, username: socket.user.username, isAdmin: socket.user.isAdmin, displayName: newName },
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
        // Delete child records first (reactions, pins reference messages)
        db.prepare('DELETE FROM reactions WHERE message_id IN (SELECT id FROM messages WHERE channel_id = ?)').run(chId);
        db.prepare('DELETE FROM pinned_messages WHERE channel_id = ?').run(chId);
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

      // Author, admin, or users with delete_message permission can delete
      if (msg.user_id !== socket.user.id && !socket.user.isAdmin && !userHasPermission(socket.user.id, 'delete_message', channel.id)) {
        return socket.emit('error-msg', 'You can only delete your own messages');
      }

      try {
        db.prepare('DELETE FROM pinned_messages WHERE message_id = ?').run(data.messageId);
        db.prepare('DELETE FROM reactions WHERE message_id = ?').run(data.messageId);
        db.prepare('DELETE FROM messages WHERE id = ?').run(data.messageId);
      } catch (err) {
        console.error('Delete message error:', err);
        return socket.emit('error-msg', 'Failed to delete message');
      }

      io.to(`channel:${code}`).emit('message-deleted', {
        channelCode: code,
        messageId: data.messageId
      });
    });

    // ═══════════════ PIN / UNPIN MESSAGE ════════════════════

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

      // Check if already pinned
      const existing = db.prepare(
        'SELECT id FROM pinned_messages WHERE message_id = ?'
      ).get(data.messageId);
      if (existing) return socket.emit('error-msg', 'Message is already pinned');

      // Max 50 pins per channel
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
        SELECT m.id, m.content, m.created_at, m.edited_at,
               COALESCE(u.display_name, u.username, '[Deleted User]') as username, u.id as user_id,
               pm.pinned_at, COALESCE(pb.display_name, pb.username, '[Deleted User]') as pinned_by
        FROM pinned_messages pm
        JOIN messages m ON pm.message_id = m.id
        LEFT JOIN users u ON m.user_id = u.id
        LEFT JOIN users pb ON pm.pinned_by = pb.id
        WHERE pm.channel_id = ?
        ORDER BY pm.pinned_at DESC
      `).all(channel.id);

      // Normalize UTC timestamps
      pins.forEach(p => {
        p.created_at = utcStamp(p.created_at);
        p.edited_at = utcStamp(p.edited_at);
        p.pinned_at = utcStamp(p.pinned_at);
      });

      socket.emit('pinned-messages', { channelCode: code, pins });
    });

    // ═══════════════ ADMIN: KICK USER ═══════════════════════

    socket.on('kick-user', (data) => {
      if (!data || typeof data !== 'object') return;
      const kickCode = socket.currentChannel;
      const kickCh = kickCode ? db.prepare('SELECT id FROM channels WHERE code = ?').get(kickCode) : null;
      if (!socket.user.isAdmin && !userHasPermission(socket.user.id, 'kick_user', kickCh ? kickCh.id : null)) {
        return socket.emit('error-msg', 'You don\'t have permission to kick users');
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
      const targetUser = db.prepare('SELECT id, COALESCE(display_name, username) as username FROM users WHERE id = ?').get(data.userId);
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
      const targetUser = db.prepare('SELECT COALESCE(display_name, username) as username FROM users WHERE id = ?').get(data.userId);
      socket.emit('error-msg', `Unbanned ${targetUser ? targetUser.username : 'user'}`);

      // Send updated ban list to admin
      const bans = db.prepare(`
        SELECT b.id, b.user_id, b.reason, b.created_at, COALESCE(u.display_name, u.username) as username
        FROM bans b JOIN users u ON b.user_id = u.id ORDER BY b.created_at DESC
      `).all();
      bans.forEach(b => { b.created_at = utcStamp(b.created_at); });
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

      const targetUser = db.prepare('SELECT id, COALESCE(display_name, username) as username FROM users WHERE id = ?').get(data.userId);
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
        // Re-assign pins to the admin performing the deletion, then nullify messages
        db.prepare('UPDATE pinned_messages SET pinned_by = ? WHERE pinned_by = ?').run(socket.user.id, uid);
        db.prepare('DELETE FROM high_scores WHERE user_id = ?').run(uid);
        db.prepare('DELETE FROM eula_acceptances WHERE user_id = ?').run(uid);
        db.prepare('DELETE FROM user_preferences WHERE user_id = ?').run(uid);
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
        SELECT b.id, b.user_id, b.reason, b.created_at, COALESCE(u.display_name, u.username) as username
        FROM bans b JOIN users u ON b.user_id = u.id ORDER BY b.created_at DESC
      `).all();
      bans.forEach(b => { b.created_at = utcStamp(b.created_at); });
      socket.emit('ban-list', bans);

      console.log(`🗑️  Admin deleted user "${targetUser.username}" (id: ${data.userId})`);
    });

    // ═══════════════ ADMIN: MUTE USER ═══════════════════════

    socket.on('mute-user', (data) => {
      if (!data || typeof data !== 'object') return;
      const muteCode = socket.currentChannel;
      const muteCh = muteCode ? db.prepare('SELECT id FROM channels WHERE code = ?').get(muteCode) : null;
      if (!socket.user.isAdmin && !userHasPermission(socket.user.id, 'mute_user', muteCh ? muteCh.id : null)) {
        return socket.emit('error-msg', 'You don\'t have permission to mute users');
      }
      if (!isInt(data.userId)) return;
      if (data.userId === socket.user.id) {
        return socket.emit('error-msg', 'You can\'t mute yourself');
      }

      const durationMinutes = isInt(data.duration) && data.duration > 0 && data.duration <= 43200
        ? data.duration : 10; // default 10 min, max 30 days
      const reason = typeof data.reason === 'string' ? data.reason.trim().slice(0, 200) : '';

      const targetUser = db.prepare('SELECT COALESCE(display_name, username) as username FROM users WHERE id = ?').get(data.userId);
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
      const targetUser = db.prepare('SELECT COALESCE(display_name, username) as username FROM users WHERE id = ?').get(data.userId);
      socket.emit('error-msg', `Unmuted ${targetUser ? targetUser.username : 'user'}`);
    });

    // ═══════════════ ADMIN: GET BAN LIST ════════════════════

    socket.on('get-bans', () => {
      if (!socket.user.isAdmin) return;
      const bans = db.prepare(`
        SELECT b.id, b.user_id, b.reason, b.created_at, COALESCE(u.display_name, u.username) as username
        FROM bans b JOIN users u ON b.user_id = u.id ORDER BY b.created_at DESC
      `).all();
      bans.forEach(b => { b.created_at = utcStamp(b.created_at); });
      socket.emit('ban-list', bans);
    });

    // ═══════════════ SERVER SETTINGS ════════════════════════

    socket.on('get-server-settings', () => {
      const rows = db.prepare('SELECT key, value FROM server_settings').all();
      const settings = {};
      const sensitiveKeys = ['giphy_api_key'];
      rows.forEach(r => {
        if (sensitiveKeys.includes(r.key) && !socket.user.isAdmin) return;
        settings[r.key] = r.value;
      });
      socket.emit('server-settings', settings);
    });

    // ═══════════════ WHITELIST MANAGEMENT ═══════════════════

    socket.on('get-whitelist', () => {
      if (!socket.user.isAdmin) return;
      const rows = db.prepare('SELECT id, username, created_at FROM whitelist ORDER BY username').all();
      rows.forEach(r => { r.created_at = utcStamp(r.created_at); });
      socket.emit('whitelist-list', rows);
    });

    socket.on('whitelist-add', (data) => {
      if (!socket.user.isAdmin) return;
      if (!data || typeof data !== 'object') return;
      const username = typeof data.username === 'string' ? data.username.trim() : '';
      if (!username || username.length < 3 || username.length > 20) {
        return socket.emit('error-msg', 'Username must be 3-20 characters');
      }
      if (!/^[a-zA-Z0-9_]+$/.test(username)) {
        return socket.emit('error-msg', 'Invalid username format');
      }

      try {
        db.prepare('INSERT OR IGNORE INTO whitelist (username, added_by) VALUES (?, ?)').run(username, socket.user.id);
        socket.emit('error-msg', `Added "${username}" to whitelist`);
        // Send updated list
        const rows = db.prepare('SELECT id, username, created_at FROM whitelist ORDER BY username').all();
        rows.forEach(r => { r.created_at = utcStamp(r.created_at); });
        socket.emit('whitelist-list', rows);
      } catch {
        socket.emit('error-msg', 'Failed to add to whitelist');
      }
    });

    socket.on('whitelist-remove', (data) => {
      if (!socket.user.isAdmin) return;
      if (!data || typeof data !== 'object') return;
      const username = typeof data.username === 'string' ? data.username.trim() : '';
      if (!username) return;

      db.prepare('DELETE FROM whitelist WHERE username = ?').run(username);
      socket.emit('error-msg', `Removed "${username}" from whitelist`);
      // Send updated list
      const rows = db.prepare('SELECT id, username, created_at FROM whitelist ORDER BY username').all();
      rows.forEach(r => { r.created_at = utcStamp(r.created_at); });
      socket.emit('whitelist-list', rows);
    });

    socket.on('whitelist-toggle', (data) => {
      if (!socket.user.isAdmin) return;
      if (!data || typeof data !== 'object') return;
      const enabled = data.enabled === true ? 'true' : 'false';
      db.prepare("INSERT OR REPLACE INTO server_settings (key, value) VALUES ('whitelist_enabled', ?)").run(enabled);
      socket.emit('error-msg', `Whitelist ${enabled === 'true' ? 'enabled' : 'disabled'}`);
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

        // Broadcast personal high score to channel
        if (socket.currentChannel) {
          io.to(socket.currentChannel).emit('new-high-score', {
            username: socket.user.displayName,
            game,
            score,
            previous: current ? current.score : 0
          });
        }
      }

      // Broadcast updated leaderboard
      const leaderboard = db.prepare(`
        SELECT hs.user_id, COALESCE(u.display_name, u.username) as username, hs.score
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
        SELECT hs.user_id, COALESCE(u.display_name, u.username) as username, hs.score
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

      const allowedKeys = ['member_visibility', 'cleanup_enabled', 'cleanup_max_age_days', 'cleanup_max_size_mb', 'giphy_api_key'];
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
      if (key === 'giphy_api_key') {
        // Allow empty value to clear the key, otherwise validate format
        if (value && (value.length < 10 || value.length > 100)) return;
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

    // ═══════════════ USER STATUS ════════════════════════════

    // set-avatar via socket is now only used to broadcast the URL after HTTP upload
    // The actual file upload + DB write happens via /api/upload-avatar
    socket.on('set-avatar', (data) => {
      if (!data || typeof data !== 'object') return;
      const url = typeof data.url === 'string' ? data.url.trim() : '';
      // Only allow /uploads/ paths or empty (clear) — no data: URLs via socket
      if (url && !url.startsWith('/uploads/')) return;
      // DB was already updated by the HTTP endpoint; just sync the in-memory state
      socket.user.avatar = url || null;
      console.log(`[Avatar] ${socket.user.username} broadcast avatar: ${url || '(removed)'}`);
      // Refresh online users in all channels this user is in
      for (const [code, users] of channelUsers) {
        if (users.has(socket.user.id)) {
          users.get(socket.user.id).avatar = url || null;
          emitOnlineUsers(code);
        }
      }
    });

    // Set avatar shape (circle, rounded, squircle, hex, diamond)
    socket.on('set-avatar-shape', (data) => {
      if (!data || typeof data !== 'object') return;
      const validShapes = ['circle', 'rounded', 'squircle', 'hex', 'diamond'];
      const shape = validShapes.includes(data.shape) ? data.shape : 'circle';
      try {
        db.prepare('UPDATE users SET avatar_shape = ? WHERE id = ?').run(shape, socket.user.id);
        socket.user.avatar_shape = shape;
        console.log(`[Avatar] ${socket.user.username} set shape: ${shape}`);
        // Refresh online users so other clients see the new shape
        for (const [code, users] of channelUsers) {
          if (users.has(socket.user.id)) {
            users.get(socket.user.id).avatar_shape = shape;
            emitOnlineUsers(code);
          }
        }
        socket.emit('avatar-shape-updated', { shape });
      } catch (err) {
        console.error('Set avatar shape error:', err);
      }
    });

    socket.on('set-status', (data) => {
      if (!data || typeof data !== 'object') return;
      const validStatuses = ['online', 'away', 'dnd', 'invisible'];
      const status = validStatuses.includes(data.status) ? data.status : 'online';
      const statusText = isString(data.statusText, 0, 128) ? data.statusText.trim() : '';

      try {
        db.prepare('UPDATE users SET status = ?, status_text = ? WHERE id = ?')
          .run(status, statusText, socket.user.id);
      } catch (err) {
        console.error('Set status error:', err);
        return;
      }

      socket.user.status = status;
      socket.user.statusText = statusText;

      // Refresh online users in all channels this user is in
      for (const [code, users] of channelUsers) {
        if (users.has(socket.user.id)) {
          users.get(socket.user.id).status = status;
          users.get(socket.user.id).statusText = statusText;
          emitOnlineUsers(code);
        }
      }

      socket.emit('status-updated', { status, statusText });
    });

    // ═══════════════ USER PROFILE ══════════════════════════

    socket.on('get-user-profile', (data) => {
      if (!data || typeof data.userId !== 'number') return;
      try {
        const row = db.prepare(
          `SELECT u.id, u.username, COALESCE(u.display_name, u.username) as displayName,
                  u.avatar, u.avatar_shape, u.status, u.status_text, u.bio, u.created_at
           FROM users u WHERE u.id = ?`
        ).get(data.userId);
        if (!row) return;

        // Get user's roles
        const roles = db.prepare(
          `SELECT r.id, r.name, r.level, r.color
           FROM roles r
           JOIN user_roles ur ON r.id = ur.role_id
           WHERE ur.user_id = ?
           ORDER BY r.level DESC`
        ).all(data.userId);

        // Check online status
        let isOnline = false;
        for (const [, s] of io.of('/').sockets) {
          if (s.user && s.user.id === data.userId) { isOnline = true; break; }
        }

        socket.emit('user-profile', {
          id: row.id,
          username: row.username,
          displayName: row.displayName,
          avatar: row.avatar || null,
          avatarShape: row.avatar_shape || 'circle',
          status: row.status || 'online',
          statusText: row.status_text || '',
          bio: row.bio || '',
          roles: roles,
          online: isOnline,
          createdAt: row.created_at
        });
      } catch (err) {
        console.error('Get user profile error:', err);
      }
    });

    socket.on('set-bio', (data) => {
      if (!data || typeof data.bio !== 'string') return;
      const bio = data.bio.trim().slice(0, 190);
      try {
        db.prepare('UPDATE users SET bio = ? WHERE id = ?').run(bio, socket.user.id);
        socket.emit('bio-updated', { bio });
      } catch (err) {
        console.error('Set bio error:', err);
      }
    });

    // ═══════════════ PUSH NOTIFICATIONS ═════════════════════

    socket.on('push-subscribe', (data) => {
      if (!data || typeof data !== 'object') return;
      const { endpoint, keys } = data;
      if (!endpoint || !keys || !keys.p256dh || !keys.auth) return;

      try {
        db.prepare(`
          INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(user_id, endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth
        `).run(socket.user.id, endpoint, keys.p256dh, keys.auth);
        socket.emit('push-subscribed');
      } catch (err) {
        console.error('Push subscribe error:', err);
      }
    });

    socket.on('push-unsubscribe', (data) => {
      if (!data || typeof data !== 'object') return;
      const endpoint = typeof data.endpoint === 'string' ? data.endpoint : '';
      if (!endpoint) return;

      try {
        db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?')
          .run(socket.user.id, endpoint);
        socket.emit('push-unsubscribed');
      } catch (err) {
        console.error('Push unsubscribe error:', err);
      }
    });

    // ═══════════════ CHANNEL TOPICS ════════════════════════

    socket.on('set-channel-topic', (data) => {
      if (!data || typeof data !== 'object') return;

      const code = typeof data.code === 'string' ? data.code.trim() : '';
      if (!code || !/^[a-f0-9]{8}$/i.test(code)) return;

      const channel = db.prepare('SELECT id FROM channels WHERE code = ?').get(code);
      if (!channel) return;

      if (!socket.user.isAdmin && !userHasPermission(socket.user.id, 'set_channel_topic', channel.id)) {
        return socket.emit('error-msg', 'You don\'t have permission to set channel topics');
      }

      const topic = isString(data.topic, 0, 256) ? data.topic.trim() : '';

      try {
        db.prepare('UPDATE channels SET topic = ? WHERE id = ?').run(topic, channel.id);
      } catch (err) {
        console.error('Set topic error:', err);
        return socket.emit('error-msg', 'Failed to update topic');
      }

      io.to(`channel:${code}`).emit('channel-topic-changed', { code, topic });
    });

    // ═══════════════ CHANNEL CODE SETTINGS (Admin) ═════════

    socket.on('update-channel-code-settings', (data) => {
      if (!data || typeof data !== 'object') return;
      if (!socket.user.isAdmin) {
        return socket.emit('error-msg', 'Only admins can change channel code settings');
      }

      const channelId = typeof data.channelId === 'number' ? data.channelId : null;
      if (!channelId) return;

      const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
      if (!channel || channel.is_dm) return;

      const validVisibility = ['public', 'private'];
      const validMode = ['static', 'dynamic'];
      const validRotationType = ['time', 'joins'];

      const updates = {};
      if (data.code_visibility && validVisibility.includes(data.code_visibility)) {
        updates.code_visibility = data.code_visibility;
      }
      if (data.code_mode && validMode.includes(data.code_mode)) {
        updates.code_mode = data.code_mode;
      }
      if (data.code_rotation_type && validRotationType.includes(data.code_rotation_type)) {
        updates.code_rotation_type = data.code_rotation_type;
      }
      if (data.code_rotation_interval !== undefined) {
        const n = parseInt(data.code_rotation_interval);
        if (!isNaN(n) && n >= 1 && n <= 10000) {
          updates.code_rotation_interval = n;
        }
      }

      if (Object.keys(updates).length === 0) return;

      // Build SET clause dynamically
      const setParts = [];
      const values = [];
      for (const [key, val] of Object.entries(updates)) {
        setParts.push(`${key} = ?`);
        values.push(val);
      }

      // If switching to dynamic, reset the counter and last-rotated timestamp
      if (updates.code_mode === 'dynamic') {
        setParts.push('code_rotation_counter = 0');
        setParts.push('code_last_rotated = CURRENT_TIMESTAMP');
      }

      values.push(channelId);
      db.prepare(`UPDATE channels SET ${setParts.join(', ')} WHERE id = ?`).run(...values);

      // Re-fetch and broadcast updated channel info to all members
      const updated = db.prepare(
        'SELECT id, code_visibility, code_mode, code_rotation_type, code_rotation_interval FROM channels WHERE id = ?'
      ).get(channelId);

      io.to(`channel:${channel.code}`).emit('channel-code-settings-updated', {
        channelId,
        channelCode: channel.code,
        settings: updated
      });

      socket.emit('error-msg', 'Channel code settings updated');
    });

    // Admin can manually rotate a channel code
    socket.on('rotate-channel-code', (data) => {
      if (!data || typeof data !== 'object') return;
      if (!socket.user.isAdmin) {
        return socket.emit('error-msg', 'Only admins can rotate channel codes');
      }

      const channelId = typeof data.channelId === 'number' ? data.channelId : null;
      if (!channelId) return;

      const channel = db.prepare('SELECT * FROM channels WHERE id = ? AND is_dm = 0').get(channelId);
      if (!channel) return;

      const oldCode = channel.code;
      const newCode = generateChannelCode();

      db.prepare(
        'UPDATE channels SET code = ?, code_rotation_counter = 0, code_last_rotated = CURRENT_TIMESTAMP WHERE id = ?'
      ).run(newCode, channelId);

      // Move all sockets from old room to new room
      const oldRoom = `channel:${oldCode}`;
      const newRoom = `channel:${newCode}`;
      const roomSockets = io.sockets.adapter.rooms.get(oldRoom);
      if (roomSockets) {
        for (const sid of [...roomSockets]) {
          const s = io.sockets.sockets.get(sid);
          if (s) { s.leave(oldRoom); s.join(newRoom); }
        }
      }

      // Update channelUsers map key
      if (channelUsers.has(oldCode)) {
        channelUsers.set(newCode, channelUsers.get(oldCode));
        channelUsers.delete(oldCode);
      }

      // Update voiceUsers map key if exists
      if (voiceUsers.has(oldCode)) {
        voiceUsers.set(newCode, voiceUsers.get(oldCode));
        voiceUsers.delete(oldCode);
      }

      // Notify all members of the code change
      io.to(newRoom).emit('channel-code-rotated', {
        channelId,
        oldCode,
        newCode
      });
    });

    // ═══════════════ DIRECT MESSAGES ═══════════════════════

    socket.on('start-dm', (data) => {
      if (!data || typeof data !== 'object') return;
      const targetId = isInt(data.targetUserId) ? data.targetUserId : null;
      if (!targetId || targetId === socket.user.id) return;

      // Verify target user exists and isn't banned
      const target = db.prepare(
        'SELECT u.id, COALESCE(u.display_name, u.username) as username FROM users u LEFT JOIN bans b ON u.id = b.user_id WHERE u.id = ? AND b.id IS NULL'
      ).get(targetId);
      if (!target) return socket.emit('error-msg', 'User not found');

      // Check if DM channel already exists between these two users
      const existingDm = db.prepare(`
        SELECT c.id, c.code, c.name FROM channels c
        WHERE c.is_dm = 1
        AND EXISTS (SELECT 1 FROM channel_members WHERE channel_id = c.id AND user_id = ?)
        AND EXISTS (SELECT 1 FROM channel_members WHERE channel_id = c.id AND user_id = ?)
      `).get(socket.user.id, targetId);

      if (existingDm) {
        // Already exists — just tell client to switch to it
        socket.emit('dm-opened', {
          id: existingDm.id,
          code: existingDm.code,
          name: existingDm.name,
          is_dm: 1,
          dm_target: { id: target.id, username: target.username }
        });
        return;
      }

      // Create new DM channel
      const code = generateChannelCode();
      const name = `DM`;

      try {
        const result = db.prepare(
          'INSERT INTO channels (name, code, created_by, is_dm) VALUES (?, ?, ?, 1)'
        ).run(name, code, socket.user.id);

        const channelId = result.lastInsertRowid;
        db.prepare('INSERT INTO channel_members (channel_id, user_id) VALUES (?, ?)').run(channelId, socket.user.id);
        db.prepare('INSERT INTO channel_members (channel_id, user_id) VALUES (?, ?)').run(channelId, targetId);

        socket.join(`channel:${code}`);

        const dmData = {
          id: channelId,
          code,
          name,
          is_dm: 1,
          dm_target: { id: target.id, username: target.username }
        };
        socket.emit('dm-opened', dmData);

        // Also notify the target if they're online
        for (const [, s] of io.of('/').sockets) {
          if (s.user && s.user.id === targetId) {
            s.join(`channel:${code}`);
            s.emit('dm-opened', {
              id: channelId,
              code,
              name,
              is_dm: 1,
              dm_target: { id: socket.user.id, username: socket.user.displayName }
            });
          }
        }
      } catch (err) {
        console.error('Start DM error:', err);
        socket.emit('error-msg', 'Failed to create DM');
      }
    });

    // ═══════════════ READ POSITIONS ════════════════════════

    socket.on('mark-read', (data) => {
      if (!data || typeof data !== 'object') return;
      const code = typeof data.code === 'string' ? data.code.trim() : '';
      if (!code || !/^[a-f0-9]{8}$/i.test(code)) return;
      if (!isInt(data.messageId) || data.messageId <= 0) return;

      const channel = db.prepare('SELECT id FROM channels WHERE code = ?').get(code);
      if (!channel) return;

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

    // ═══════════════ DISCONNECT ═════════════════════════════

    socket.on('disconnect', () => {
      if (!socket.user) return; // safety guard
      console.log(`❌ ${socket.user.username} disconnected`);

      // Collect channels this user was actually in before removing
      const affectedChannels = new Set();
      for (const [code, users] of channelUsers) {
        if (users.has(socket.user.id)) {
          // Only remove if no other socket from same user is still connected
          let otherSocketAlive = false;
          for (const [, s] of io.of('/').sockets) {
            if (s.user && s.user.id === socket.user.id && s.id !== socket.id) {
              // Another socket for same user exists — update socketId instead of removing
              users.set(socket.user.id, { ...users.get(socket.user.id), socketId: s.id });
              otherSocketAlive = true;
              break;
            }
          }
          if (!otherSocketAlive) {
            users.delete(socket.user.id);
          }
          affectedChannels.add(code);
        }
      }

      // Only broadcast to channels the user was actually in
      for (const code of affectedChannels) {
        emitOnlineUsers(code);
      }

      // Remove from voice channels — only if this was the socket in the voice room
      for (const [code, room] of voiceUsers) {
        const voiceEntry = room.get(socket.user.id);
        if (voiceEntry && voiceEntry.socketId === socket.id) {
          handleVoiceLeave(socket, code);
        }
      }
    });

    // ── Helpers ─────────────────────────────────────────────

    function handleVoiceLeave(socket, code) {
      const voiceRoom = voiceUsers.get(code);
      if (!voiceRoom || !voiceRoom.has(socket.user.id)) return;

      voiceRoom.delete(socket.user.id);
      socket.leave(`voice:${code}`);

      // Untrack screen sharer if they were sharing
      const sharers = activeScreenSharers.get(code);
      if (sharers) { sharers.delete(socket.user.id); if (sharers.size === 0) activeScreenSharers.delete(code); }

      // Tell remaining peers to close connection to this user
      for (const [, user] of voiceRoom) {
        io.to(user.socketId).emit('voice-user-left', {
          channelCode: code,
          user: { id: socket.user.id, username: socket.user.displayName }
        });
      }

      broadcastVoiceUsers(code);
    }

    function broadcastVoiceUsers(code) {
      const room = voiceUsers.get(code);
      const users = room
        ? Array.from(room.values()).map(u => ({ id: u.id, username: u.username }))
        : [];
      // Emit to voice participants (may have switched text channels) AND text viewers
      io.to(`voice:${code}`).to(`channel:${code}`).emit('voice-users-update', {
        channelCode: code,
        users
      });
      // Lightweight count for sidebar voice indicators (all connected clients)
      io.emit('voice-count-update', { code, count: users.length });
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

      // Fetch user statuses and avatars
      const statusMap = {};
      try {
        const statusRows = db.prepare('SELECT id, status, status_text, avatar, avatar_shape FROM users').all();
        statusRows.forEach(r => { statusMap[r.id] = { status: r.status || 'online', statusText: r.status_text || '', avatar: r.avatar || null, avatarShape: r.avatar_shape || 'circle' }; });
      } catch { /* columns may not exist yet */ }

      // Build set of user IDs who are members of THIS channel
      const channel = db.prepare('SELECT id FROM channels WHERE code = ?').get(code);
      const memberIds = new Set();
      if (channel) {
        const rows = db.prepare('SELECT user_id FROM channel_members WHERE channel_id = ?').all(channel.id);
        rows.forEach(r => memberIds.add(r.user_id));
      }

      let users;
      if (mode === 'none') {
        users = [];
      } else if (mode === 'all') {
        // All channel members (online + offline), filtered to this channel
        const allMembers = db.prepare(
          `SELECT u.id, COALESCE(u.display_name, u.username) as username
           FROM users u
           JOIN channel_members cm ON u.id = cm.user_id
           JOIN channels c ON cm.channel_id = c.id
           LEFT JOIN bans b ON u.id = b.user_id
           WHERE c.code = ? AND b.id IS NULL
           ORDER BY COALESCE(u.display_name, u.username)`
        ).all(code);
        // Check all connected sockets for true online status
        const globalOnlineIds = new Set();
        for (const [, s] of io.of('/').sockets) {
          if (s.user) globalOnlineIds.add(s.user.id);
        }
        users = allMembers.map(m => ({
          id: m.id, username: m.username, online: globalOnlineIds.has(m.id),
          highScore: scores[m.id] || 0,
          status: statusMap[m.id]?.status || 'online',
          statusText: statusMap[m.id]?.statusText || '',
          avatar: statusMap[m.id]?.avatar || null,
          avatarShape: statusMap[m.id]?.avatarShape || 'circle',
          role: getUserHighestRole(m.id, channel ? channel.id : null)
        }));
      } else {
        // 'online' — connected users who are members of this channel
        const onlineMap = new Map();
        for (const [, s] of io.of('/').sockets) {
          if (s.user && !onlineMap.has(s.user.id) && memberIds.has(s.user.id)) {
            onlineMap.set(s.user.id, {
              id: s.user.id,
              username: s.user.displayName,
              online: true,
              highScore: scores[s.user.id] || 0,
              status: statusMap[s.user.id]?.status || 'online',
              statusText: statusMap[s.user.id]?.statusText || '',
              avatar: statusMap[s.user.id]?.avatar || s.user.avatar || null,
              avatarShape: statusMap[s.user.id]?.avatarShape || s.user.avatar_shape || 'circle',
              role: getUserHighestRole(s.user.id, channel ? channel.id : null)
            });
          }
        }
        users = Array.from(onlineMap.values());
      }

      // Sort: online first, then alphabetical within each group
      users.sort((a, b) => {
        if (a.online !== b.online) return a.online ? -1 : 1;
        return a.username.toLowerCase().localeCompare(b.username.toLowerCase());
      });

      // Send per-socket: invisible users appear offline to others, but normal to themselves
      const hasInvisible = users.some(u => u.status === 'invisible');
      if (!hasInvisible) {
        // Fast path: no invisible users, broadcast to everyone
        io.to(`channel:${code}`).emit('online-users', {
          channelCode: code,
          users,
          visibilityMode: mode
        });
      } else {
        // Slow path: customize the list per recipient
        for (const [, s] of io.of('/').sockets) {
          if (!s.user || !s.rooms || !s.rooms.has(`channel:${code}`)) continue;
          const viewerId = s.user.id;
          const customUsers = users.map(u => {
            if (u.status === 'invisible' && u.id !== viewerId) {
              return { ...u, online: false, status: 'offline' };
            }
            return u;
          });
          customUsers.sort((a, b) => {
            if (a.online !== b.online) return a.online ? -1 : 1;
            return a.username.toLowerCase().localeCompare(b.username.toLowerCase());
          });
          s.emit('online-users', {
            channelCode: code,
            users: customUsers,
            visibilityMode: mode
          });
        }
      }
    }

    // ═══════════════ ROLE MANAGEMENT ═════════════════════════

    socket.on('get-roles', (data, callback) => {
      const roles = db.prepare('SELECT * FROM roles ORDER BY level DESC').all();
      const permissions = db.prepare('SELECT * FROM role_permissions').all();
      const permMap = {};
      permissions.forEach(p => {
        if (!permMap[p.role_id]) permMap[p.role_id] = [];
        permMap[p.role_id].push(p.permission);
      });
      roles.forEach(r => { r.permissions = permMap[r.id] || []; });
      if (typeof callback === 'function') callback({ roles });
      else if (typeof data === 'function') data({ roles }); // handle emit('get-roles', callback)
      else socket.emit('roles-list', roles);
    });

    socket.on('get-user-roles', (data) => {
      if (!data || typeof data !== 'object') return;
      const userId = isInt(data.userId) ? data.userId : null;
      if (!userId) return;
      const roles = getUserRoles(userId);
      const highestRole = getUserHighestRole(userId);
      socket.emit('user-roles', { userId, roles, highestRole });
    });

    socket.on('create-role', (data, callback) => {
      if (!data || typeof data !== 'object') return;
      const cb = typeof callback === 'function' ? callback : () => {};
      if (!socket.user.isAdmin) return cb({ error: 'Only admins can create roles' });

      const name = isString(data.name, 1, 30) ? data.name.trim() : '';
      if (!name) return cb({ error: 'Role name required (1-30 chars)' });

      const level = isInt(data.level) && data.level >= 1 && data.level <= 99 ? data.level : 25;
      const scope = data.scope === 'channel' ? 'channel' : 'server';
      const color = isString(data.color, 4, 7) ? data.color : null;

      try {
        const result = db.prepare('INSERT INTO roles (name, level, scope, color) VALUES (?, ?, ?, ?)').run(name, level, scope, color);

        // Add permissions
        const perms = Array.isArray(data.permissions) ? data.permissions : [];
        const validPerms = ['kick_user', 'mute_user', 'delete_message', 'pin_message', 'set_channel_topic', 'manage_sub_channels', 'ban_user'];
        const insertPerm = db.prepare('INSERT OR IGNORE INTO role_permissions (role_id, permission, allowed) VALUES (?, ?, 1)');
        perms.forEach(p => { if (validPerms.includes(p)) insertPerm.run(result.lastInsertRowid, p); });

        cb({ success: true, roleId: result.lastInsertRowid });
      } catch (err) {
        console.error('Create role error:', err);
        cb({ error: 'Failed to create role' });
      }
    });

    socket.on('update-role', (data, callback) => {
      if (!data || typeof data !== 'object') return;
      const cb = typeof callback === 'function' ? callback : () => {};
      if (!socket.user.isAdmin) return cb({ error: 'Only admins can edit roles' });

      const roleId = isInt(data.roleId) ? data.roleId : null;
      if (!roleId) return;

      const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(roleId);
      if (!role) return cb({ error: 'Role not found' });

      const updates = [];
      const values = [];

      if (isString(data.name, 1, 30)) { updates.push('name = ?'); values.push(data.name.trim()); }
      if (isInt(data.level) && data.level >= 1 && data.level <= 99) { updates.push('level = ?'); values.push(data.level); }
      if (data.color !== undefined) { updates.push('color = ?'); values.push(data.color || null); }

      if (updates.length > 0) {
        values.push(roleId);
        db.prepare(`UPDATE roles SET ${updates.join(', ')} WHERE id = ?`).run(...values);
      }

      // Update permissions
      if (Array.isArray(data.permissions)) {
        const validPerms = ['kick_user', 'mute_user', 'delete_message', 'pin_message', 'set_channel_topic', 'manage_sub_channels', 'ban_user'];
        db.prepare('DELETE FROM role_permissions WHERE role_id = ?').run(roleId);
        const insertPerm = db.prepare('INSERT INTO role_permissions (role_id, permission, allowed) VALUES (?, ?, 1)');
        data.permissions.forEach(p => { if (validPerms.includes(p)) insertPerm.run(roleId, p); });
      }

      // Refresh all online users' role data
      for (const [code] of channelUsers) { emitOnlineUsers(code); }
      cb({ success: true });
    });

    socket.on('delete-role', (data, callback) => {
      if (!data || typeof data !== 'object') return;
      const cb = typeof callback === 'function' ? callback : () => {};
      if (!socket.user.isAdmin) return cb({ error: 'Only admins can delete roles' });

      const roleId = isInt(data.roleId) ? data.roleId : null;
      if (!roleId) return;

      db.prepare('DELETE FROM user_roles WHERE role_id = ?').run(roleId);
      db.prepare('DELETE FROM role_permissions WHERE role_id = ?').run(roleId);
      db.prepare('DELETE FROM roles WHERE id = ?').run(roleId);
      // Refresh all online users' role data
      for (const [code] of channelUsers) { emitOnlineUsers(code); }
      cb({ success: true });
    });

    socket.on('assign-role', (data, callback) => {
      if (!data || typeof data !== 'object') return;
      const cb = typeof callback === 'function' ? callback : () => {};
      if (!socket.user.isAdmin) return cb({ error: 'Only admins can assign roles' });

      const userId = isInt(data.userId) ? data.userId : null;
      const roleId = isInt(data.roleId) ? data.roleId : null;
      if (!userId || !roleId) return;

      const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(roleId);
      if (!role) return cb({ error: 'Role not found' });

      const channelId = isInt(data.channelId) ? data.channelId : null;

      try {
        db.prepare('INSERT OR REPLACE INTO user_roles (user_id, role_id, channel_id, granted_by) VALUES (?, ?, ?, ?)').run(userId, roleId, channelId, socket.user.id);

        // Notify the target user if online
        for (const [, s] of io.sockets.sockets) {
          if (s.user && s.user.id === userId) {
            s.user.roles = getUserRoles(userId);
            s.user.effectiveLevel = getUserEffectiveLevel(userId);
            s.emit('roles-updated', { roles: s.user.roles, effectiveLevel: s.user.effectiveLevel });
          }
        }

        // Refresh online users to show role badges
        for (const [code] of channelUsers) { emitOnlineUsers(code); }
        cb({ success: true });
      } catch (err) {
        console.error('Assign role error:', err);
        cb({ error: 'Failed to assign role' });
      }
    });

    socket.on('revoke-role', (data) => {
      if (!data || typeof data !== 'object') return;
      if (!socket.user.isAdmin) return socket.emit('error-msg', 'Only admins can revoke roles');

      const userId = isInt(data.userId) ? data.userId : null;
      const roleId = isInt(data.roleId) ? data.roleId : null;
      if (!userId || !roleId) return;

      const channelId = isInt(data.channelId) ? data.channelId : null;

      if (channelId) {
        db.prepare('DELETE FROM user_roles WHERE user_id = ? AND role_id = ? AND channel_id = ?').run(userId, roleId, channelId);
      } else {
        db.prepare('DELETE FROM user_roles WHERE user_id = ? AND role_id = ? AND channel_id IS NULL').run(userId, roleId);
      }

      const target = db.prepare('SELECT COALESCE(display_name, username) as username FROM users WHERE id = ?').get(userId);
      socket.emit('error-msg', `Revoked role from ${target ? target.username : 'user'}`);

      // Notify target user if online
      for (const [, s] of io.sockets.sockets) {
        if (s.user && s.user.id === userId) {
          s.user.roles = getUserRoles(userId);
          s.user.effectiveLevel = getUserEffectiveLevel(userId);
          s.emit('roles-updated', { roles: s.user.roles, effectiveLevel: s.user.effectiveLevel });
        }
      }
      for (const [code] of channelUsers) { emitOnlineUsers(code); }
    });

    // ═══════════════ SUB-CHANNELS ══════════════════════════

    // ═══════════════ RENAME CHANNEL / SUB-CHANNEL ═════════
    socket.on('rename-channel', (data) => {
      if (!data || typeof data !== 'object') return;
      const code = typeof data.code === 'string' ? data.code.trim() : '';
      if (!code || !/^[a-f0-9]{8}$/i.test(code)) return;

      const name = typeof data.name === 'string' ? data.name.trim() : '';
      if (!name || name.length === 0 || name.length > 50) {
        return socket.emit('error-msg', 'Channel name must be 1-50 characters');
      }
      if (!/^[\w\s\-!?.,']+$/i.test(name)) {
        return socket.emit('error-msg', 'Channel name contains invalid characters');
      }

      const channel = db.prepare('SELECT * FROM channels WHERE code = ? AND is_dm = 0').get(code);
      if (!channel) return socket.emit('error-msg', 'Channel not found');

      // Permission check: admin, server mod, or channel mod
      const permChannel = channel.parent_channel_id || channel.id;
      if (!socket.user.isAdmin && getUserEffectiveLevel(socket.user.id, permChannel) < 25) {
        return socket.emit('error-msg', 'You don\'t have permission to rename channels');
      }

      try {
        db.prepare('UPDATE channels SET name = ? WHERE id = ?').run(name, channel.id);

        // Broadcast enriched channel list to all connected clients
        broadcastChannelLists();
        // Also update the header for anyone currently in this channel
        io.to(code).emit('channel-renamed', { code, name });
      } catch (err) {
        console.error('Rename channel error:', err);
        socket.emit('error-msg', 'Failed to rename channel');
      }
    });

    socket.on('create-sub-channel', (data) => {
      if (!data || typeof data !== 'object') return;

      const parentCode = typeof data.parentCode === 'string' ? data.parentCode.trim() : '';
      if (!parentCode || !/^[a-f0-9]{8}$/i.test(parentCode)) return;

      const parentChannel = db.prepare('SELECT * FROM channels WHERE code = ? AND is_dm = 0').get(parentCode);
      if (!parentChannel) return socket.emit('error-msg', 'Parent channel not found');

      // Check permission: admin, server mod, or channel mod for this channel
      if (!socket.user.isAdmin && !userHasPermission(socket.user.id, 'manage_sub_channels', parentChannel.id)) {
        return socket.emit('error-msg', 'You don\'t have permission to create sub-channels');
      }

      const name = typeof data.name === 'string' ? data.name.trim() : '';
      if (!name || name.length === 0 || name.length > 50) {
        return socket.emit('error-msg', 'Sub-channel name must be 1-50 characters');
      }
      if (!/^[\w\s\-!?.,']+$/i.test(name)) {
        return socket.emit('error-msg', 'Sub-channel name contains invalid characters');
      }

      // Don't allow nested sub-channels (max 1 level deep)
      if (parentChannel.parent_channel_id) {
        return socket.emit('error-msg', 'Cannot create sub-channels inside sub-channels');
      }

      const code = generateChannelCode();
      const isPrivate = data.isPrivate ? 1 : 0;

      // Get max position for ordering
      const maxPos = db.prepare('SELECT MAX(position) as mp FROM channels WHERE parent_channel_id = ?').get(parentChannel.id);
      const position = (maxPos && maxPos.mp != null) ? maxPos.mp + 1 : 0;

      try {
        const result = db.prepare(
          'INSERT INTO channels (name, code, created_by, parent_channel_id, position, is_private) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(name, code, socket.user.id, parentChannel.id, position, isPrivate);

        // Auto-join all members of the parent channel (even for private — creator controls who's in)
        const parentMembers = db.prepare('SELECT user_id FROM channel_members WHERE channel_id = ?').all(parentChannel.id);
        // For private sub-channels, only auto-join the creator
        const membersToAdd = isPrivate
          ? [{ user_id: socket.user.id }]
          : parentMembers;
        const insertMember = db.prepare('INSERT OR IGNORE INTO channel_members (channel_id, user_id) VALUES (?, ?)');
        membersToAdd.forEach(m => insertMember.run(result.lastInsertRowid, m.user_id));

        // Broadcast enriched channel list to all connected clients
        broadcastChannelLists();
      } catch (err) {
        console.error('Create sub-channel error:', err);
        socket.emit('error-msg', 'Failed to create sub-channel');
      }
    });

    socket.on('delete-sub-channel', (data) => {
      if (!data || typeof data !== 'object') return;
      const code = typeof data.code === 'string' ? data.code.trim() : '';
      if (!code || !/^[a-f0-9]{8}$/i.test(code)) return;

      const channel = db.prepare('SELECT * FROM channels WHERE code = ?').get(code);
      if (!channel || !channel.parent_channel_id) {
        return socket.emit('error-msg', 'Sub-channel not found');
      }

      if (!socket.user.isAdmin && !userHasPermission(socket.user.id, 'manage_sub_channels', channel.parent_channel_id)) {
        return socket.emit('error-msg', 'You don\'t have permission to delete sub-channels');
      }

      try {
        db.prepare('DELETE FROM reactions WHERE message_id IN (SELECT id FROM messages WHERE channel_id = ?)').run(channel.id);
        db.prepare('DELETE FROM pinned_messages WHERE channel_id = ?').run(channel.id);
        db.prepare('DELETE FROM messages WHERE channel_id = ?').run(channel.id);
        db.prepare('DELETE FROM channel_members WHERE channel_id = ?').run(channel.id);
        db.prepare('DELETE FROM channels WHERE id = ?').run(channel.id);

        // Broadcast enriched channel list
        broadcastChannelLists();

        socket.emit('error-msg', `Sub-channel deleted`);
      } catch (err) {
        console.error('Delete sub-channel error:', err);
        socket.emit('error-msg', 'Failed to delete sub-channel');
      }
    });

    // ═══════════════════════════════════════════════════════════
    // WEBHOOK / BOT MANAGEMENT
    // ═══════════════════════════════════════════════════════════

    // Create a webhook for a channel
    socket.on('create-webhook', (data) => {
      if (!data || typeof data !== 'object') return;
      if (!socket.user.isAdmin) return socket.emit('error-msg', 'Only admins can create webhooks');

      const channelCode = typeof data.channelCode === 'string' ? data.channelCode.trim() : '';
      if (!channelCode || !/^[a-f0-9]{8}$/i.test(channelCode)) return;

      const channel = db.prepare('SELECT id, code FROM channels WHERE code = ? AND is_dm = 0').get(channelCode);
      if (!channel) return socket.emit('error-msg', 'Channel not found');

      const name = typeof data.name === 'string' ? data.name.trim().slice(0, 32) : 'Bot';
      if (!name) return socket.emit('error-msg', 'Webhook name is required');

      const token = crypto.randomBytes(32).toString('hex'); // 64-char token

      try {
        const result = db.prepare(
          'INSERT INTO webhooks (channel_id, name, token, created_by) VALUES (?, ?, ?, ?)'
        ).run(channel.id, name, token, socket.user.id);

        socket.emit('webhook-created', {
          id: result.lastInsertRowid,
          channel_id: channel.id,
          channel_code: channel.code,
          name,
          token,
          is_active: 1,
          created_at: new Date().toISOString()
        });
      } catch (err) {
        console.error('Create webhook error:', err);
        socket.emit('error-msg', 'Failed to create webhook');
      }
    });

    // List webhooks for a channel
    socket.on('get-webhooks', (data) => {
      if (!data || typeof data !== 'object') return;
      if (!socket.user.isAdmin) return socket.emit('error-msg', 'Only admins can view webhooks');

      const channelCode = typeof data.channelCode === 'string' ? data.channelCode.trim() : '';
      if (!channelCode || !/^[a-f0-9]{8}$/i.test(channelCode)) return;

      const channel = db.prepare('SELECT id FROM channels WHERE code = ?').get(channelCode);
      if (!channel) return;

      const webhooks = db.prepare(
        'SELECT id, channel_id, name, token, avatar_url, is_active, created_at FROM webhooks WHERE channel_id = ? ORDER BY created_at DESC'
      ).all(channel.id);

      socket.emit('webhooks-list', { channelCode, webhooks });
    });

    // Delete a webhook
    socket.on('delete-webhook', (data) => {
      if (!data || typeof data !== 'object') return;
      if (!socket.user.isAdmin) return socket.emit('error-msg', 'Only admins can delete webhooks');

      const webhookId = parseInt(data.webhookId);
      if (!webhookId || isNaN(webhookId)) return;

      try {
        db.prepare('DELETE FROM webhooks WHERE id = ?').run(webhookId);
        socket.emit('webhook-deleted', { webhookId });
      } catch (err) {
        console.error('Delete webhook error:', err);
        socket.emit('error-msg', 'Failed to delete webhook');
      }
    });

    // Toggle webhook active/inactive
    socket.on('toggle-webhook', (data) => {
      if (!data || typeof data !== 'object') return;
      if (!socket.user.isAdmin) return socket.emit('error-msg', 'Only admins can manage webhooks');

      const webhookId = parseInt(data.webhookId);
      if (!webhookId || isNaN(webhookId)) return;

      const webhook = db.prepare('SELECT is_active FROM webhooks WHERE id = ?').get(webhookId);
      if (!webhook) return socket.emit('error-msg', 'Webhook not found');

      const newState = webhook.is_active ? 0 : 1;
      db.prepare('UPDATE webhooks SET is_active = ? WHERE id = ?').run(newState, webhookId);
      socket.emit('webhook-toggled', { webhookId, is_active: newState });
    });

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
        butt:      () => ({ content: `( . )( . )` }),
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
