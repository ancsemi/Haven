'use strict';

const path = require('path');
const fs   = require('fs');
const { utcStamp, isString, isInt, sanitizeText } = require('./helpers');

module.exports = function register(socket, ctx) {
  const { io, db, state, userHasPermission, getUserEffectiveLevel,
          sendPushNotifications, fireWebhookCallbacks, fireWebhookEvent, processSlashCommand,
          touchVoiceActivity, floodCheck, UPLOADS_DIR, DELETED_ATTACHMENTS_DIR } = ctx;
  const { slowModeTracker } = state;

  const UPLOAD_PATH_RE = /\/uploads\/((?!(?:deleted-attachments|stickers)\/)(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+)/g;
  const UPLOAD_PATH_EXACT_RE = /^\/uploads\/((?!(?:deleted-attachments|stickers)\/)(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+)$/;

  function isSafeUploadRelPath(relPath) {
    if (typeof relPath !== 'string' || !relPath) return false;
    if (!/^((?!\.\.)(?!\.\/)(?!\/)[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/.test(relPath)) return false;
    const parts = relPath.split('/');
    if (parts.some(p => !p || p === '.' || p === '..')) return false;
    return true;
  }

  function moveUploadToDeleted(relPath) {
    if (!isSafeUploadRelPath(relPath)) return;
    const src = path.join(UPLOADS_DIR, relPath);
    if (!fs.existsSync(src)) return;
    let stat;
    try {
      stat = fs.statSync(src);
    } catch {
      return;
    }
    if (!stat.isFile()) return;
    const dst = path.join(DELETED_ATTACHMENTS_DIR, relPath);
    try {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.renameSync(src, dst);
    } catch { /* file locked or already moved */ }
  }

  // ── Get message history ─────────────────────────────────
  socket.on('get-messages', (data) => {
    if (!data || typeof data !== 'object') return;
    const code = typeof data.code === 'string' ? data.code.trim() : '';
    if (!code || !/^[a-f0-9]{8}$/i.test(code)) return;
    const before = isInt(data.before) ? data.before : null;
    const after  = isInt(data.after)  ? data.after  : null;
    const around = isInt(data.around) ? data.around : null;
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
        SELECT m.id, m.content, m.created_at, m.reply_to, m.edited_at, m.is_webhook, m.webhook_username, m.webhook_avatar, m.imported_from, m.is_archived, m.poll_data, m.burn_seconds, m.burning_started_at, m.persona_id, m.persona_username, m.persona_avatar, m.break_chain,
               COALESCE(u.display_name, u.username, '[Deleted User]') as real_username,
               COALESCE(m.persona_username, m.webhook_username, u.display_name, u.username, '[Deleted User]') as username, u.id as user_id, u.avatar, COALESCE(u.avatar_shape, 'circle') as avatar_shape
        FROM messages m LEFT JOIN users u ON m.user_id = u.id
        WHERE m.channel_id = ? AND m.id < ? AND m.thread_id IS NULL
        ORDER BY m.created_at DESC, m.id DESC LIMIT ?
      `).all(channel.id, before, limit);
    } else if (after) {
      messages = db.prepare(`
        SELECT m.id, m.content, m.created_at, m.reply_to, m.edited_at, m.is_webhook, m.webhook_username, m.webhook_avatar, m.imported_from, m.is_archived, m.poll_data, m.burn_seconds, m.burning_started_at, m.persona_id, m.persona_username, m.persona_avatar, m.break_chain,
               COALESCE(u.display_name, u.username, '[Deleted User]') as real_username,
               COALESCE(m.persona_username, m.webhook_username, u.display_name, u.username, '[Deleted User]') as username, u.id as user_id, u.avatar, COALESCE(u.avatar_shape, 'circle') as avatar_shape
        FROM messages m LEFT JOIN users u ON m.user_id = u.id
        WHERE m.channel_id = ? AND m.id > ? AND m.thread_id IS NULL
        ORDER BY m.created_at ASC, m.id ASC LIMIT ?
      `).all(channel.id, after, limit);
    } else if (around) {
      const half = Math.floor(limit / 2);
      const beforeMsgs = db.prepare(`
        SELECT m.id, m.content, m.created_at, m.reply_to, m.edited_at, m.is_webhook, m.webhook_username, m.webhook_avatar, m.imported_from, m.is_archived, m.poll_data, m.burn_seconds, m.burning_started_at, m.persona_id, m.persona_username, m.persona_avatar, m.break_chain,
               COALESCE(u.display_name, u.username, '[Deleted User]') as real_username,
               COALESCE(m.persona_username, m.webhook_username, u.display_name, u.username, '[Deleted User]') as username, u.id as user_id, u.avatar, COALESCE(u.avatar_shape, 'circle') as avatar_shape
        FROM messages m LEFT JOIN users u ON m.user_id = u.id
        WHERE m.channel_id = ? AND m.id < ? AND m.thread_id IS NULL
        ORDER BY m.created_at DESC, m.id DESC LIMIT ?
      `).all(channel.id, around, half);
      const targetMsg = db.prepare(`
        SELECT m.id, m.content, m.created_at, m.reply_to, m.edited_at, m.is_webhook, m.webhook_username, m.webhook_avatar, m.imported_from, m.is_archived, m.poll_data, m.burn_seconds, m.burning_started_at, m.persona_id, m.persona_username, m.persona_avatar, m.break_chain,
               COALESCE(u.display_name, u.username, '[Deleted User]') as real_username,
               COALESCE(m.persona_username, m.webhook_username, u.display_name, u.username, '[Deleted User]') as username, u.id as user_id, u.avatar, COALESCE(u.avatar_shape, 'circle') as avatar_shape
        FROM messages m LEFT JOIN users u ON m.user_id = u.id
        WHERE m.channel_id = ? AND m.id = ?
      `).all(channel.id, around);
      const afterMsgs = db.prepare(`
        SELECT m.id, m.content, m.created_at, m.reply_to, m.edited_at, m.is_webhook, m.webhook_username, m.webhook_avatar, m.imported_from, m.is_archived, m.poll_data, m.burn_seconds, m.burning_started_at, m.persona_id, m.persona_username, m.persona_avatar, m.break_chain,
               COALESCE(u.display_name, u.username, '[Deleted User]') as real_username,
               COALESCE(m.persona_username, m.webhook_username, u.display_name, u.username, '[Deleted User]') as username, u.id as user_id, u.avatar, COALESCE(u.avatar_shape, 'circle') as avatar_shape
        FROM messages m LEFT JOIN users u ON m.user_id = u.id
        WHERE m.channel_id = ? AND m.id > ? AND m.thread_id IS NULL
        ORDER BY m.created_at ASC, m.id ASC LIMIT ?
      `).all(channel.id, around, half);
      // Combine: beforeMsgs is DESC so reverse it, target, then afterMsgs ASC
      messages = [...beforeMsgs.reverse(), ...targetMsg, ...afterMsgs];
    } else {
      messages = db.prepare(`
        SELECT m.id, m.content, m.created_at, m.reply_to, m.edited_at, m.is_webhook, m.webhook_username, m.webhook_avatar, m.imported_from, m.is_archived, m.poll_data, m.burn_seconds, m.burning_started_at, m.persona_id, m.persona_username, m.persona_avatar, m.break_chain,
               COALESCE(u.display_name, u.username, '[Deleted User]') as real_username,
               COALESCE(m.persona_username, m.webhook_username, u.display_name, u.username, '[Deleted User]') as username, u.id as user_id, u.avatar, COALESCE(u.avatar_shape, 'circle') as avatar_shape
        FROM messages m LEFT JOIN users u ON m.user_id = u.id
        WHERE m.channel_id = ? AND m.thread_id IS NULL
        ORDER BY m.created_at DESC, m.id DESC LIMIT ?
      `).all(channel.id, limit);
    }

    // Batch-enrich messages (reply context, reactions, pin status) in 3 queries
    const msgIds = messages.map(m => m.id);
    const replyIds = [...new Set(messages.filter(m => m.reply_to).map(m => m.reply_to))];

    const replyMap = new Map();
    if (replyIds.length > 0) {
      const ph = replyIds.map(() => '?').join(',');
      db.prepare(`
        SELECT m.id, m.content, m.user_id, COALESCE(u.display_name, u.username, '[Deleted User]') as username
        FROM messages m LEFT JOIN users u ON m.user_id = u.id
        WHERE m.id IN (${ph}) AND m.channel_id = ?
      `).all(...replyIds, channel.id).forEach(r => replyMap.set(r.id, r));
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

    // ── Thread metadata enrichment ─────────────────────────
    const threadMap = new Map();
    if (msgIds.length > 0) {
      const ph = msgIds.map(() => '?').join(',');
      // Get thread counts and last activity for messages that are thread parents
      db.prepare(`
        SELECT thread_id,
               COUNT(*) as reply_count,
               MAX(created_at) as last_reply_at
        FROM messages WHERE thread_id IN (${ph})
        GROUP BY thread_id
      `).all(...msgIds).forEach(t => {
        threadMap.set(t.thread_id, { count: t.reply_count, lastReplyAt: utcStamp(t.last_reply_at), participants: [] });
      });
      // Get participants for threads (up to 5 unique usernames)
      if (threadMap.size > 0) {
        const threadIds = [...threadMap.keys()];
        const tph = threadIds.map(() => '?').join(',');
        db.prepare(`
          SELECT tm.thread_id, COALESCE(u.display_name, u.username) as username, u.avatar
          FROM (
            SELECT thread_id, user_id, MAX(created_at) as latest
            FROM messages WHERE thread_id IN (${tph})
            GROUP BY thread_id, user_id
          ) tm JOIN users u ON tm.user_id = u.id
          ORDER BY tm.latest DESC
        `).all(...threadIds).forEach(p => {
          const info = threadMap.get(p.thread_id);
          if (info && info.participants.length < 5) {
            info.participants.push({ username: p.username, avatar: p.avatar });
          }
        });
      }
    }

    const enriched = messages.map(m => {
      const obj = { ...m };
      if (obj.created_at && !obj.created_at.endsWith('Z')) obj.created_at = utcStamp(obj.created_at);
      if (obj.edited_at && !obj.edited_at.endsWith('Z')) obj.edited_at = utcStamp(obj.edited_at);
      obj.replyContext = m.reply_to ? (replyMap.get(m.reply_to) || null) : null;
      obj.reactions = reactionMap.get(m.id) || [];
      obj.pinned = pinnedSet ? pinnedSet.has(m.id) : false;
      obj.is_archived = !!m.is_archived;
      obj.thread = threadMap.get(m.id) || null;
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
      // ── Persona override (#86, #5349) ──
      // Persona display always wins over the real user's avatar/name
      // (it loses to webhook/imported because those represent different
      // message types entirely). The real_username field is preserved so
      // the client can show a "@real_username" hint to mods/owner.
      if (m.persona_id && !m.is_webhook && !m.imported_from) {
        obj.persona_id = m.persona_id;
        obj.persona_username = m.persona_username || null;
        obj.persona_avatar = m.persona_avatar || null;
        obj.real_username = m.real_username;
        obj.username = m.persona_username || m.real_username || obj.username;
        obj.avatar = m.persona_avatar || null;
        obj.avatar_shape = 'circle';
      }
      return obj;
    });

    // Include the user's last-read position so the client can show a
    // "NEW MESSAGES" divider between read and unread messages.
    const readPos = db.prepare(
      'SELECT last_read_message_id FROM read_positions WHERE user_id = ? AND channel_id = ?'
    ).get(socket.user.id, channel.id);
    const lastReadMessageId = readPos ? readPos.last_read_message_id : 0;

    socket.emit('message-history', {
      channelCode: code,
      messages: (after || around) ? enriched : enriched.reverse(),
      lastReadMessageId,
      pinnedCount: db.prepare('SELECT COUNT(*) as cnt FROM pinned_messages WHERE channel_id = ?').get(channel.id).cnt,
      ...(around ? { around } : {})
    });
  });

  // ── Search messages ─────────────────────────────────────
  socket.on('search-messages', (data) => {
    if (!data || typeof data !== 'object') return;
    const code = typeof data.code === 'string' ? data.code.trim() : '';
    let query = typeof data.query === 'string' ? data.query.trim() : '';
    if (!code || !query || query.length < 2) return;

    const channel = db.prepare('SELECT id, is_dm FROM channels WHERE code = ?').get(code);
    if (!channel) return;

    const member = db.prepare(
      'SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?'
    ).get(channel.id, socket.user.id);
    if (!member) return;

    if (channel.is_dm) {
      return socket.emit('search-results', { results: [], query, isDM: true });
    }

    // ── Parse search filters ──
    const filters = { from: null, in: null, has: null };
    // Extract from:username
    query = query.replace(/\bfrom:(\S+)/gi, (_, v) => { filters.from = v; return ''; });
    // Extract in:#channel or in:channel
    query = query.replace(/\bin:#?(\S+)/gi, (_, v) => { filters.in = v; return ''; });
    // Extract has:image, has:file, has:link, has:embed
    query = query.replace(/\bhas:(\S+)/gi, (_, v) => { filters.has = v.toLowerCase(); return ''; });
    query = query.trim();

    // Determine target channel(s)
    let targetChannelId = channel.id;
    if (filters.in) {
      const targetChannel = db.prepare('SELECT id FROM channels WHERE name = ? COLLATE NOCASE AND is_dm = 0').get(filters.in);
      if (!targetChannel) {
        return socket.emit('search-results', { results: [], query: data.query, filters });
      }
      // Verify user is a member of the target channel
      const targetMember = db.prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?').get(targetChannel.id, socket.user.id);
      if (!targetMember) {
        return socket.emit('search-results', { results: [], query: data.query, filters });
      }
      targetChannelId = targetChannel.id;
    }

    // Build dynamic WHERE conditions
    const conditions = ['m.channel_id = ?'];
    const params = [targetChannelId];

    // Text search (only if there's remaining query text after extracting filters)
    if (query.length >= 1) {
      const escapedQuery = query.replace(/[%_\\]/g, '\\$&');
      conditions.push("m.content LIKE ? ESCAPE '\\'");
      params.push(`%${escapedQuery}%`);
    }

    // from:username filter
    if (filters.from) {
      conditions.push('(u.username = ? COLLATE NOCASE OR u.display_name = ? COLLATE NOCASE)');
      params.push(filters.from, filters.from);
    }

    // has: filter
    if (filters.has) {
      switch (filters.has) {
        case 'image':
          conditions.push("(m.content LIKE '%/uploads/%.png%' ESCAPE '\\' OR m.content LIKE '%/uploads/%.jpg%' ESCAPE '\\' OR m.content LIKE '%/uploads/%.jpeg%' ESCAPE '\\' OR m.content LIKE '%/uploads/%.gif%' ESCAPE '\\' OR m.content LIKE '%/uploads/%.webp%' ESCAPE '\\' OR m.content LIKE '%/uploads/%.svg%' ESCAPE '\\')");
          break;
        case 'file':
          conditions.push("m.content LIKE '%/uploads/%' ESCAPE '\\'");
          break;
        case 'link':
          conditions.push("(m.content LIKE '%http://%' ESCAPE '\\' OR m.content LIKE '%https://%' ESCAPE '\\')");
          break;
        case 'video':
          conditions.push("(m.content LIKE '%/uploads/%.mp4%' ESCAPE '\\' OR m.content LIKE '%/uploads/%.webm%' ESCAPE '\\' OR m.content LIKE '%/uploads/%.mov%' ESCAPE '\\' OR m.content LIKE '%youtube.com%' ESCAPE '\\' OR m.content LIKE '%youtu.be%' ESCAPE '\\')");
          break;
      }
    }

    const results = db.prepare(`
      SELECT m.id, m.content, m.created_at,
             COALESCE(u.display_name, u.username, '[Deleted User]') as username, u.id as user_id
      FROM messages m LEFT JOIN users u ON m.user_id = u.id
      WHERE ${conditions.join(' AND ')}
      ORDER BY m.created_at DESC LIMIT 50
    `).all(...params);

    results.forEach(r => {
      if (r.created_at && !r.created_at.endsWith('Z')) r.created_at = utcStamp(r.created_at);
    });
    socket.emit('search-results', { results, query: data.query, filters });
  });

  // ── Channel media gallery (#5350) ───────────────────────
  // Returns categorized media + links from all messages in a channel.
  // Photos / videos / audio / files come from /uploads/ URLs and the
  // [file:name](/uploads/path) markdown wrapper. Links are http(s)://
  // URLs in message bodies that don't point at /uploads/.
  socket.on('get-channel-media', (data) => {
    if (!data || typeof data !== 'object') return;
    const code = typeof data.code === 'string' ? data.code.trim() : '';
    if (!code || !/^[a-f0-9]{8}$/i.test(code)) return;

    const channel = db.prepare('SELECT id FROM channels WHERE code = ?').get(code);
    if (!channel) return;

    const member = db.prepare(
      'SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?'
    ).get(channel.id, socket.user.id);
    if (!member && !socket.user.isAdmin) {
      return socket.emit('error-msg', 'Not a member of this channel');
    }

    // Pull every message in this channel that mentions /uploads/ or http(s)://
    // Cap at 5000 to avoid pathological loads on giant channels.
    const rows = db.prepare(`
      SELECT m.id, m.content, m.created_at, m.original_name,
             m.persona_id, m.persona_username, m.persona_avatar,
             COALESCE(m.persona_username, m.webhook_username, u.display_name, u.username, '[Deleted User]') as username,
             u.id as user_id
      FROM messages m LEFT JOIN users u ON m.user_id = u.id
      WHERE m.channel_id = ?
        AND m.thread_id IS NULL
        AND (m.content LIKE '%/uploads/%' ESCAPE '\\' OR m.content LIKE '%http://%' ESCAPE '\\' OR m.content LIKE '%https://%' ESCAPE '\\')
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT 5000
    `).all(channel.id);

    const photos = [];
    const videos = [];
    const audios = [];
    const files  = [];
    const links  = [];

    const IMG_EXT = /\.(jpe?g|png|gif|webp|bmp|svg|avif)(?:$|[?#|])/i;
    const VID_EXT = /\.(mp4|webm|mov|m4v|mkv|ogv)(?:$|[?#|])/i;
    const AUD_EXT = /\.(mp3|wav|ogg|m4a|flac|aac|opus|weba)(?:$|[?#|])/i;

    // [file:Original Name](/uploads/...|size) markdown wrapper
    // File attachments use [file:name](url|size) format; capture url + size separately
    const fileLinkRe = /\[file:([^\]]+)\]\((\/uploads\/[^)|\s]+)(?:\|([^)]*))?\)/g;
    // bare /uploads/ URL (image markdown ![alt](/uploads/x) or plain path)
    const uploadRe   = /(?:!\[[^\]]*\]\(([^)\s]+)\)|(\/uploads\/[^\s)]+))/g;
    // http(s):// URLs (anywhere in content)
    const httpRe     = /(https?:\/\/[^\s<>"']+)/gi;

    // Resolve a /uploads/<name> path to a byte size by stat'ing the file on
    // disk. Memoized per request so a popular file isn't stat'd hundreds of
    // times. Returns 0 when the file is missing or path-traversal would
    // escape UPLOADS_DIR.
    const sizeCache = new Map();
    const safeName = /^[\w\-.]+$/;
    const sizeOf = (url) => {
      if (!url || !url.startsWith('/uploads/')) return 0;
      if (sizeCache.has(url)) return sizeCache.get(url);
      const name = url.slice('/uploads/'.length);
      if (!safeName.test(name)) { sizeCache.set(url, 0); return 0; }
      let s = 0;
      try {
        const full = path.join(UPLOADS_DIR, name);
        const st = fs.statSync(full);
        if (st && st.isFile()) s = st.size;
      } catch { /* missing or permission denied */ }
      sizeCache.set(url, s);
      return s;
    };

    for (const row of rows) {
      const ts = row.created_at && !row.created_at.endsWith('Z') ? utcStamp(row.created_at) : row.created_at;
      const seen = new Set(); // dedupe URLs within a single message
      const baseEntry = (url, name, sizeHint) => {
        let size = 0;
        if (typeof sizeHint === 'number' && sizeHint > 0) size = sizeHint;
        else if (typeof sizeHint === 'string' && /^\d+$/.test(sizeHint)) size = parseInt(sizeHint, 10);
        else size = sizeOf(url);
        return {
          message_id: row.id,
          url,
          name: name || row.original_name || url.split('/').pop(),
          size,
          created_at: ts,
          username: row.username,
          user_id: row.user_id,
        };
      };

      // 1) [file:name](url|size) wrappers
      let m;
      const content = row.content || '';
      while ((m = fileLinkRe.exec(content)) !== null) {
        const name = m[1];
        const url  = m[2];
        const sizeHint = m[3];
        if (seen.has(url)) continue;
        seen.add(url);
        const entry = baseEntry(url, name, sizeHint);
        if      (IMG_EXT.test(url)) photos.push(entry);
        else if (VID_EXT.test(url)) videos.push(entry);
        else if (AUD_EXT.test(url)) audios.push(entry);
        else                        files.push(entry);
      }
      fileLinkRe.lastIndex = 0;

      // 2) bare /uploads/ URLs / image markdown
      while ((m = uploadRe.exec(content)) !== null) {
        const rawUrl = m[1] || m[2];
        if (!rawUrl || !rawUrl.startsWith('/uploads/')) continue;
        // Strip trailing |size suffix that file attachments embed in the URL slot
        const url = rawUrl.replace(/\|[^)]*$/, '');
        if (seen.has(url)) continue;
        seen.add(url);
        const entry = baseEntry(url);
        if      (IMG_EXT.test(url)) photos.push(entry);
        else if (VID_EXT.test(url)) videos.push(entry);
        else if (AUD_EXT.test(url)) audios.push(entry);
        else                        files.push(entry);
      }
      uploadRe.lastIndex = 0;

      // 3) http(s):// links — exclude /uploads/ (already counted above as
      //    relative paths) and exclude raw image/video CDN links being
      //    used as inline media (those are covered by link-preview, but
      //    for the gallery we still treat them as 'link' to avoid noise).
      while ((m = httpRe.exec(content)) !== null) {
        const url = m[1].replace(/[)\].,!?]+$/, '');
        if (seen.has(url)) continue;
        // Skip same-origin /uploads (already captured)
        if (/\/uploads\//i.test(url)) continue;
        seen.add(url);
        links.push(baseEntry(url, url));
      }
      httpRe.lastIndex = 0;
    }

    socket.emit('channel-media', {
      channelCode: code,
      photos,
      videos,
      audios,
      files,
      links,
    });
  });

  // ── Bulk delete from media gallery (#5375) ──────────────
  // Lets admins / users with delete permission remove many attachments at
  // once from the Files & Media view. Reuses the same permission rules and
  // file-move-to-deleted-attachments behavior as the single-message
  // `delete-message` handler. Operates per-message inside a transaction
  // and broadcasts `message-deleted` for each one so other clients update.
  socket.on('delete-channel-media', (data, callback) => {
    const cb = typeof callback === 'function' ? callback : () => {};
    if (!data || typeof data !== 'object') return cb({ error: 'Bad request' });
    const code = typeof data.code === 'string' ? data.code.trim() : '';
    if (!code || !/^[a-f0-9]{8}$/i.test(code)) return cb({ error: 'Bad channel' });

    const ids = Array.isArray(data.messageIds)
      ? Array.from(new Set(data.messageIds.filter(isInt))).slice(0, 500)
      : [];
    if (ids.length === 0) return cb({ error: 'No items selected' });

    const channel = db.prepare('SELECT id, is_dm FROM channels WHERE code = ?').get(code);
    if (!channel) return cb({ error: 'Channel not found' });

    const member = db.prepare(
      'SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?'
    ).get(channel.id, socket.user.id);
    if (!member && !socket.user.isAdmin) return cb({ error: 'Not a member' });

    const canDeleteAny  = socket.user.isAdmin || userHasPermission(socket.user.id, 'delete_message', channel.id);
    const canDeleteLowr = !canDeleteAny && userHasPermission(socket.user.id, 'delete_lower_messages', channel.id);
    const myLevel = (!canDeleteAny && canDeleteLowr) ? getUserEffectiveLevel(socket.user.id, channel.id) : 0;

    // Allow self-delete fallback only if the policy allows it. Mirrors
    // `delete-message`'s logic for own messages.
    let allowOwnDelete = true;
    if (!socket.user.isAdmin) {
      try {
        const deny = db.prepare(
          "SELECT allowed FROM user_role_perms WHERE user_id = ? AND permission = 'delete_own_messages' ORDER BY allowed ASC LIMIT 1"
        ).get(socket.user.id);
        if (deny && deny.allowed === 0) allowOwnDelete = false;
      } catch { /* table may not exist */ }
    }

    const placeholders = ids.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT id, user_id, content FROM messages WHERE channel_id = ? AND id IN (${placeholders})`
    ).all(channel.id, ...ids);

    const deletable = [];
    const skipped = [];
    for (const r of rows) {
      let ok = false;
      if (r.user_id === socket.user.id) {
        ok = allowOwnDelete;
      } else if (canDeleteAny) {
        ok = true;
      } else if (canDeleteLowr) {
        const targetLevel = getUserEffectiveLevel(r.user_id, channel.id);
        ok = myLevel > targetLevel;
      }
      if (ok) deletable.push(r);
      else    skipped.push(r.id);
    }

    if (deletable.length === 0) {
      return cb({ error: 'You don\'t have permission to delete the selected items', deleted: 0, skipped: skipped.length });
    }

    const delPin = db.prepare('DELETE FROM pinned_messages WHERE message_id = ?');
    const delRx  = db.prepare('DELETE FROM reactions WHERE message_id = ?');
    const delMsg = db.prepare('DELETE FROM messages WHERE id = ?');
    const purge = db.transaction(() => {
      for (const r of deletable) {
        delPin.run(r.id);
        delRx.run(r.id);
        delMsg.run(r.id);
      }
    });
    try { purge(); } catch (err) {
      console.error('Bulk media delete error:', err);
      return cb({ error: 'Failed to delete items', detail: err && err.message });
    }

    // Move attachment files to deleted-attachments/ for each deleted message
    const uploadRe = UPLOAD_PATH_RE;
    for (const r of deletable) {
      uploadRe.lastIndex = 0;
      let m;
      while ((m = uploadRe.exec(r.content || '')) !== null) {
        moveUploadToDeleted(m[1]);
      }
      // For E2E DMs the content is ciphertext; honor client-supplied URLs
      // the same way `delete-message` does. (`data.attachmentsByMessage`
      // is an object map { [messageId]: [url, url, ...] }.)
      if (channel.is_dm && data.attachmentsByMessage && typeof data.attachmentsByMessage === 'object') {
        const urls = data.attachmentsByMessage[r.id];
        if (Array.isArray(urls)) {
          for (const url of urls) {
            if (typeof url !== 'string') continue;
            const match = url.match(UPLOAD_PATH_EXACT_RE);
            if (!match || !isSafeUploadRelPath(match[1])) continue;
            moveUploadToDeleted(match[1]);
          }
        }
      }
    }

    // Broadcast individual deletes so all clients' message lists, pin lists,
    // and open Files & Media views stay consistent.
    for (const r of deletable) {
      io.to(`channel:${code}`).emit('message-deleted', {
        channelCode: code,
        messageId: r.id
      });
    }

    cb({ success: true, deleted: deletable.length, skipped: skipped.length });
  });

  // ── Send message ────────────────────────────────────────
  socket.on('send-message', (data) => {
    if (!data || typeof data !== 'object') return;
    const code = typeof data.code === 'string' ? data.code.trim() : '';
    let content = typeof data.content === 'string' ? data.content : '';

    if (!code || !/^[a-f0-9]{8}$/i.test(code)) return;
    if (!content || content.trim().length === 0) return;
    const _maxCharsRow = db.prepare("SELECT value FROM server_settings WHERE key = 'max_message_chars'").get();
    const _maxChars = parseInt(_maxCharsRow?.value) || 2000;
    if (content.length > _maxChars) {
      return socket.emit('error-msg', `Message too long (max ${_maxChars} characters)`);
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

    const channel = db.prepare('SELECT id, name, slow_mode_interval, text_enabled, voice_enabled, media_enabled, read_only, is_dm FROM channels WHERE code = ?').get(code);
    if (!channel) return socket.emit('error-msg', 'Channel not found — try switching channels and back');

    const member = db.prepare(
      'SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?'
    ).get(channel.id, socket.user.id);
    if (!member) return socket.emit('error-msg', 'Not a member of this channel');

    if (channel.read_only === 1 && !socket.user.isAdmin && !userHasPermission(socket.user.id, 'read_only_override', channel.id)) {
      return socket.emit('error-msg', 'This channel is read-only');
    }

    // Strip @everyone / @here from senders who lack mention_everyone, so
    // unauthorized users can't trigger an everyone-mention notification.
    // We replace the trigger with a zero-width-joined form so the visible
    // text is preserved but the client-side mention regex no longer matches.
    if (!socket.user.isAdmin && !userHasPermission(socket.user.id, 'mention_everyone', channel.id)) {
      const stripped = content.replace(/(?<![\w@])@(everyone|here)\b/gi, '@\u200B$1');
      if (stripped !== content) content = stripped;
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

    // Bundled media: images/files attached alongside a text message are sent
    // as a separate socket event by the client. They've already consumed one
    // slow-mode slot (via the text message). Skip the check so the media
    // arrives with its parent message instead of being blocked. (#5342)
    if (channel.slow_mode_interval > 0 && !socket.user.isAdmin && getUserEffectiveLevel(socket.user.id, channel.id) < 25 && !data.bundled) {
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

    // ── /break prefix (#5393) ─────────────────────────────
    // User-controlled override: prefixing a message with "/break " (or
    // "/break\n") forces the renderer to start a new visual message group
    // instead of compacting under the previous message. Strip the prefix
    // before any further processing so it never reaches storage or echo.
    let breakChain = 0;
    {
      const breakMatch = content.match(/^\s*\/break(?:\s+|\n)([\s\S]+)$/);
      if (breakMatch) {
        content = breakMatch[1];
        breakChain = 1;
      }
    }

    const trimmed = content.trim();
    const isImage = data.isImage === true;
    const isUpload = /^\/uploads\b/i.test(trimmed);
    const isPath = trimmed.startsWith('/') && trimmed.indexOf('/', 1) !== -1;
    const slashMatch = (!isImage && !isUpload && !isPath) ? trimmed.match(/^\/([a-zA-Z]+)(?:\s+(.*))?$/) : null;
    if (slashMatch) {
      const cmd = slashMatch[1].toLowerCase();
      const arg = (slashMatch[2] || '').trim();
      const slashResult = processSlashCommand(cmd, arg, socket.user.displayName, channel.id, code);
      if (slashResult && slashResult.botCommand) {
        // Bot command fired — bot will respond via webhook endpoint
        return;
      }
      if (slashResult) {
        const finalContent = slashResult.content;

        const result = db.prepare(
          'INSERT INTO messages (channel_id, user_id, content, reply_to, break_chain) VALUES (?, ?, ?, ?, ?)'
        ).run(channel.id, socket.user.id, finalContent, null, breakChain);

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
          edited_at: null,
          thread: null,
          break_chain: breakChain || undefined
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

    let replyTo = isInt(data.replyTo) ? data.replyTo : null;
    const safeContent = sanitizeText(content.trim());
    if (!safeContent) return;

    // Validate replyTo belongs to same channel (prevents cross-channel data leaks)
    if (replyTo) {
      const replyMsg = db.prepare('SELECT channel_id FROM messages WHERE id = ?').get(replyTo);
      if (!replyMsg || replyMsg.channel_id !== channel.id) replyTo = null;
    }

    // (#5280) burn-after-read for DMs — capped at 5 minutes; only honored
    // for is_dm channels (the issue scopes burn to direct messages only).
    let burnSeconds = 0;
    if (channel.is_dm) {
      const reqBurn = parseInt(data && data.burnSeconds);
      if (Number.isFinite(reqBurn) && reqBurn >= 1 && reqBurn <= 300) burnSeconds = reqBurn;
    }

    // ── Persona detection (#86, #5349) ────────────────────
    // Pattern: "::PersonaName actual message body"
    // The leading "::" is a deliberate, unambiguous trigger that does not
    // conflict with any markdown syntax. We iterate over the sender's own
    // personas (longest name first to handle prefix ambiguity) and do a
    // case-insensitive prefix match — this correctly handles persona names
    // that contain spaces, which a single regex with [^\s] cannot do.
    let personaId = null;
    let personaUsername = null;
    let personaAvatar = null;
    let finalContent = safeContent;
    if (safeContent.startsWith('::')) {
      const userPersonas = db.prepare(
        'SELECT id, name, avatar FROM user_personas WHERE user_id = ?'
      ).all(socket.user.id);
      // Sort longest name first to prefer the most specific match.
      userPersonas.sort((a, b) => b.name.length - a.name.length);
      const lower = safeContent.toLowerCase();
      for (const persona of userPersonas) {
        // Allow "::Name message" (space separator) or "::Name: message" (colon+space)
        const base = '::' + persona.name.toLowerCase();
        let body = null;
        if (lower.startsWith(base + ' ')) {
          body = safeContent.slice(base.length + 1).trim();
        } else if (lower.startsWith(base + ': ')) {
          body = safeContent.slice(base.length + 2).trim();
        } else if (lower.startsWith(base + ':') && safeContent.length > base.length + 1) {
          body = safeContent.slice(base.length + 1).trim();
        }
        if (body && body.length > 0) {
          personaId = persona.id;
          personaUsername = persona.name;
          personaAvatar = persona.avatar || null;
          finalContent = body;
          break;
        }
      }
    }

    try {
      const result = db.prepare(
        'INSERT INTO messages (channel_id, user_id, content, reply_to, burn_seconds, persona_id, persona_username, persona_avatar, break_chain) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(channel.id, socket.user.id, finalContent, replyTo, burnSeconds, personaId, personaUsername, personaAvatar, breakChain);

      const message = {
        id: result.lastInsertRowid,
        content: finalContent,
        created_at: new Date().toISOString(),
        username: personaUsername || socket.user.displayName,
        user_id: socket.user.id,
        avatar: personaAvatar || socket.user.avatar || null,
        avatar_shape: personaId ? 'circle' : (socket.user.avatar_shape || 'circle'),
        reply_to: replyTo,
        replyContext: null,
        reactions: [],
        edited_at: null,
        thread: null,
        burn_seconds: burnSeconds || undefined,
        persona_id: personaId || undefined,
        persona_username: personaUsername || undefined,
        persona_avatar: personaAvatar || undefined,
        real_username: personaId ? socket.user.displayName : undefined,
        break_chain: breakChain || undefined,
      };

      if (replyTo) {
        message.replyContext = db.prepare(`
          SELECT m.id, m.content, m.user_id, COALESCE(u.display_name, u.username, '[Deleted User]') as username FROM messages m
          LEFT JOIN users u ON m.user_id = u.id WHERE m.id = ? AND m.channel_id = ?
        `).get(replyTo, channel.id) || null;
      }

      io.to(`channel:${code}`).emit('new-message', { channelCode: code, message });
      // Burn messages must not reveal their content in push notifications —
      // the whole point is that the recipient has to actively reveal them.
      const pushContent = burnSeconds > 0 ? '🔥 Sent a burn message' : finalContent;
      const pushDisplayName = personaUsername || socket.user.displayName;
      sendPushNotifications(channel.id, code, channel.name, socket.user.id, pushDisplayName, pushContent);
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

  // ── Burn-after-read mark + sweep (#5280) ────────────────────
  // The recipient (or sender, but typically recipient) emits `mark-burning`
  // the first time the message is revealed. Server stamps
  // `burning_started_at` once and fans out `message-burning` so every
  // viewer can run a synced countdown. Subsequent emits for the same
  // message are no-ops. The actual delete fires from the periodic sweep
  // below, which also handles the "server restarted mid-timer" case
  // (sweep on next get-messages catches expired burns regardless).
  socket.on('mark-burning', (data) => {
    if (!data || typeof data !== 'object') return;
    const messageId = parseInt(data.messageId);
    const code = typeof data.code === 'string' ? data.code.trim() : '';
    if (!Number.isFinite(messageId) || !code) return;
    const channel = db.prepare('SELECT id, is_dm FROM channels WHERE code = ?').get(code);
    if (!channel || !channel.is_dm) return;
    const member = db.prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?').get(channel.id, socket.user.id);
    if (!member) return;
    const msg = db.prepare('SELECT id, channel_id, burn_seconds, burning_started_at FROM messages WHERE id = ?').get(messageId);
    if (!msg || msg.channel_id !== channel.id) return;
    if (!msg.burn_seconds || msg.burn_seconds <= 0) return;
    if (msg.burning_started_at) return; // already burning — synced countdown is already live
    const startedAt = new Date().toISOString();
    db.prepare('UPDATE messages SET burning_started_at = ? WHERE id = ?').run(startedAt, messageId);
    io.to(`channel:${code}`).emit('message-burning', {
      channelCode: code,
      messageId,
      burnSeconds: msg.burn_seconds,
      burningStartedAt: startedAt
    });
  });

  // Periodic sweep: every 10 seconds, delete any burning message whose
  // timer is up. Emits `message-burned` so clients can replace the row
  // with a "[message burned]" placeholder. Uses datetime() arithmetic
  // so SQLite handles the timezone math.
  if (!global.__havenBurnSweep) {
    global.__havenBurnSweep = setInterval(() => {
      try {
        const expired = db.prepare(`
          SELECT m.id, m.channel_id, c.code AS channel_code
          FROM messages m
          JOIN channels c ON c.id = m.channel_id
          WHERE m.burn_seconds > 0
            AND m.burning_started_at IS NOT NULL
            AND datetime(m.burning_started_at, '+' || m.burn_seconds || ' seconds') <= datetime('now')
        `).all();
        for (const row of expired) {
          db.prepare('DELETE FROM messages WHERE id = ?').run(row.id);
          io.to(`channel:${row.channel_code}`).emit('message-burned', {
            channelCode: row.channel_code,
            messageId: row.id
          });
        }
      } catch (err) {
        console.error('[burn-sweep] error:', err.message);
      }
    }, 10000);
  }

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
    const _editMaxRow = db.prepare("SELECT value FROM server_settings WHERE key = 'max_message_chars'").get();
    const _editMax = parseInt(_editMaxRow?.value) || 2000;
    if (!isInt(data.messageId) || !isString(data.content, 1, _editMax)) return;

    // Accept an explicit channelCode from the client (e.g. DM PiP, where
    // socket.currentChannel is a different server channel). Fall back to
    // socket.currentChannel for backwards compatibility.
    const rawCode = typeof data.channelCode === 'string' ? data.channelCode.trim() : null;
    const code = (rawCode && /^[a-f0-9]{8}$/i.test(rawCode)) ? rawCode : socket.currentChannel;
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

    // Allow the PiP DM overlay (and similar cases where the socket is joined to
    // a different channel) to pass the target channel explicitly so the lookup
    // isn't blocked by socket.currentChannel pointing at a server channel.
    const rawCode = typeof data.channelCode === 'string' ? data.channelCode.trim() : null;
    const code = (rawCode && /^[a-f0-9]{8}$/i.test(rawCode)) ? rawCode : socket.currentChannel;
    if (!code) return;

    const channel = db.prepare('SELECT id, is_dm FROM channels WHERE code = ?').get(code);
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

    const uploadRe = UPLOAD_PATH_RE;
    let m;
    while ((m = uploadRe.exec(msg.content || '')) !== null) {
      moveUploadToDeleted(m[1]);
    }

    // For E2E DMs, the message content is encrypted ciphertext, so the
    // upload regex above can't find attachments. The client (which has the
    // decrypted content) passes the URLs in `data.attachments`. We honor
    // this for any DM channel — permission gating above already restricts
    // who can delete the message (author or anyone with delete perm). (#5299)
    if (channel.is_dm && Array.isArray(data.attachments)) {
      for (const url of data.attachments) {
        if (typeof url !== 'string') continue;
        const match = url.match(UPLOAD_PATH_EXACT_RE);
        if (!match || !isSafeUploadRelPath(match[1])) continue;
        moveUploadToDeleted(match[1]);
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

      // Look up the channel from the message itself, not socket.currentChannel.
      // Reactions can be triggered from the DM PiP while the user's main pane
      // (and therefore socket.currentChannel) is a completely different
      // channel — using socket.currentChannel made the reaction silently
      // fail because the message wouldn't be found in that channel. (#bug-#4)
      const msg = db.prepare(
        'SELECT m.id, c.code, c.id as channel_id FROM messages m JOIN channels c ON m.channel_id = c.id WHERE m.id = ?'
      ).get(data.messageId);
      if (!msg) return;
      const code = msg.code;

      // Verify membership of the channel the message lives in.
      const member = db.prepare(
        'SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?'
      ).get(msg.channel_id, socket.user.id);
      if (!member && !socket.user.isAdmin) return;

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

      // Webhook event: reaction-added (3.13.0)
      try {
        fireWebhookEvent?.(msg.channel_id, code, 'reaction-added', {
          messageId: data.messageId,
          emoji: data.emoji,
          author: { id: socket.user.id, username: socket.user.displayName }
        });
      } catch { /* best-effort */ }
    } catch (err) {
      console.error('add-reaction error:', err.message);
    }
  });

  socket.on('remove-reaction', (data) => {
    try {
      if (!data || typeof data !== 'object') return;
      if (!isInt(data.messageId) || !isString(data.emoji, 1, 32)) return;

      // Look up the channel from the message (see add-reaction comment).
      const msgRow = db.prepare(
        'SELECT m.id, c.code, c.id as channel_id FROM messages m JOIN channels c ON m.channel_id = c.id WHERE m.id = ?'
      ).get(data.messageId);
      if (!msgRow) return;
      const code = msgRow.code;

      const member = db.prepare(
        'SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?'
      ).get(msgRow.channel_id, socket.user.id);
      if (!member && !socket.user.isAdmin) return;

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
        thread: null,
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

  // Mark entire channel as read (context menu action)
  socket.on('mark-read-channel', (data) => {
    if (!data || typeof data !== 'object') return;
    const code = typeof data.code === 'string' ? data.code.trim() : '';
    if (!code || !/^[a-f0-9]{8}$/i.test(code)) return;

    const channel = db.prepare('SELECT id FROM channels WHERE code = ?').get(code);
    if (!channel) return;

    const member = db.prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?').get(channel.id, socket.user.id);
    if (!member) return;

    try {
      // Mark up to the latest non-thread message. Thread replies have their
      // own panel and don't participate in channel-level read positions.
      const latest = db.prepare('SELECT MAX(id) AS maxId FROM messages WHERE channel_id = ? AND thread_id IS NULL').get(channel.id);
      if (!latest || !latest.maxId) return;

      db.prepare(`
        INSERT INTO read_positions (user_id, channel_id, last_read_message_id)
        VALUES (?, ?, ?)
        ON CONFLICT(user_id, channel_id) DO UPDATE SET last_read_message_id = MAX(last_read_message_id, excluded.last_read_message_id)
      `).run(socket.user.id, channel.id, latest.maxId);
    } catch (err) {
      console.error('Mark read channel error:', err);
    }
  });

  // ═══════════════════════════════════════════════════════
  // THREADS
  // ═══════════════════════════════════════════════════════

  // ── Get thread messages ─────────────────────────────────
  socket.on('get-thread-messages', (data) => {
    if (!data || typeof data !== 'object') return;
    const parentId = isInt(data.parentId) ? data.parentId : null;
    if (!parentId) return;

    // Look up the channel from the parent message rather than relying on
    // socket.currentChannel — the thread panel can persist across channel
    // switches, and a stale currentChannel would silently empty the thread
    // (issue: web users seeing 28 replies but no messages, mobile fine).
    const parentRow = db.prepare(
      'SELECT m.id, m.user_id, m.content, m.created_at, m.channel_id, c.code as channel_code, c.is_dm as is_dm,\n              COALESCE(m.webhook_username, u.display_name, u.username, \'[Deleted User]\') as username,\n              COALESCE(m.webhook_avatar, u.avatar) as avatar,\n              COALESCE(u.avatar_shape, \'circle\') as avatar_shape\n       FROM messages m\n       JOIN channels c ON m.channel_id = c.id\n       LEFT JOIN users u ON m.user_id = u.id\n       WHERE m.id = ?'
    ).get(parentId);
    if (!parentRow) return;
    if (parentRow.is_dm) return; // Threads are not available in DMs
    const channel = { id: parentRow.channel_id };
    const parent = parentRow;

    // Verify the user is a member of the channel (admins exempt).
    const member = db.prepare(
      'SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?'
    ).get(channel.id, socket.user.id);
    if (!member && !socket.user.isAdmin) return;

    const messages = db.prepare(`
      SELECT m.id, m.content, m.created_at, m.reply_to, m.edited_at, m.is_webhook, m.webhook_username, m.webhook_avatar, m.imported_from, m.is_archived,
             COALESCE(m.webhook_username, u.display_name, u.username, '[Deleted User]') as username, u.id as user_id, u.avatar, COALESCE(u.avatar_shape, 'circle') as avatar_shape
      FROM messages m LEFT JOIN users u ON m.user_id = u.id
      WHERE m.thread_id = ?
      ORDER BY m.created_at ASC, m.id ASC
    `).all(parentId);

    // Enrich with reactions and reply context
    const msgIds = messages.map(m => m.id);
    const replyIds = [...new Set(messages.filter(m => m.reply_to).map(m => m.reply_to))];

    const replyMap = new Map();
    if (replyIds.length > 0) {
      const ph = replyIds.map(() => '?').join(',');
      db.prepare(`
        SELECT m.id, m.content, m.user_id, COALESCE(u.display_name, u.username, '[Deleted User]') as username
        FROM messages m LEFT JOIN users u ON m.user_id = u.id WHERE m.id IN (${ph})
      `).all(...replyIds).forEach(r => replyMap.set(r.id, r));
    }

    const reactionMap = new Map();
    if (msgIds.length > 0) {
      const ph = msgIds.map(() => '?').join(',');
      db.prepare(`
        SELECT r.message_id, r.emoji, r.user_id, COALESCE(u.display_name, u.username) as username
        FROM reactions r JOIN users u ON r.user_id = u.id WHERE r.message_id IN (${ph}) ORDER BY r.id
      `).all(...msgIds).forEach(r => {
        if (!reactionMap.has(r.message_id)) reactionMap.set(r.message_id, []);
        reactionMap.get(r.message_id).push({ emoji: r.emoji, user_id: r.user_id, username: r.username });
      });
    }

    const enriched = messages.map(m => {
      const obj = { ...m };
      if (obj.created_at && !obj.created_at.endsWith('Z')) obj.created_at = utcStamp(obj.created_at);
      if (obj.edited_at && !obj.edited_at.endsWith('Z')) obj.edited_at = utcStamp(obj.edited_at);
      obj.replyContext = m.reply_to ? (replyMap.get(m.reply_to) || null) : null;
      obj.reactions = reactionMap.get(m.id) || [];
      return obj;
    });

    socket.emit('thread-messages', {
      parentId,
      parentContent: parent.content,
      parentUserId: parent.user_id || null,
      parentUsername: parent.username || '[Deleted User]',
      parentAvatar: parent.avatar || null,
      parentAvatarShape: parent.avatar_shape || 'circle',
      parentCreatedAt: utcStamp(parent.created_at),
      messages: enriched
    });
  });

  // ── Send message to thread ──────────────────────────────
  socket.on('send-thread-message', (data, callback) => {
    if (!data || typeof data !== 'object') return;
    const parentId = isInt(data.parentId) ? data.parentId : null;
    let content = typeof data.content === 'string' ? data.content.trim() : '';
    if (!parentId || !content) return;

    if (floodCheck('message')) return;

    // Resolve channel via the parent message (not socket.currentChannel) so
    // sending from a thread panel still works after the user has navigated
    // away from the parent's channel. (#thread-blank-web)
    const parent = db.prepare(
      'SELECT m.id, m.thread_id, m.channel_id, c.code as code, c.is_dm FROM messages m JOIN channels c ON m.channel_id = c.id WHERE m.id = ?'
    ).get(parentId);
    if (!parent || parent.thread_id) return; // Can't create sub-threads
    if (parent.is_dm) return socket.emit('error-msg', 'Threads are not available in DMs');
    const code = parent.code;
    const channel = { id: parent.channel_id, is_dm: parent.is_dm };

    // Verify the user is a member of the channel (admins exempt).
    const tMember = db.prepare(
      'SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?'
    ).get(channel.id, socket.user.id);
    if (!tMember && !socket.user.isAdmin) return;

    const safeContent = sanitizeText(content);
    if (!safeContent) return;

    let replyTo = isInt(data.replyTo) ? data.replyTo : null;
    if (replyTo) {
      const replyMsg = db.prepare('SELECT thread_id FROM messages WHERE id = ?').get(replyTo);
      if (!replyMsg || replyMsg.thread_id !== parentId) replyTo = null;
    }

    try {
      const result = db.prepare(
        'INSERT INTO messages (channel_id, user_id, content, thread_id, reply_to) VALUES (?, ?, ?, ?, ?)'
      ).run(channel.id, socket.user.id, safeContent, parentId, replyTo);

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
        edited_at: null,
        thread_id: parentId
      };

      if (replyTo) {
        message.replyContext = db.prepare(`
          SELECT m.id, m.content, m.user_id, COALESCE(u.display_name, u.username, '[Deleted User]') as username
          FROM messages m LEFT JOIN users u ON m.user_id = u.id WHERE m.id = ?
        `).get(replyTo) || null;
      }

      // Emit to everyone in the channel who has the thread open
      io.to(`channel:${code}`).emit('new-thread-message', {
        channelCode: code,
        parentId,
        message
      });

      // Update thread preview on the parent message for all users
      const threadCount = db.prepare('SELECT COUNT(*) as count FROM messages WHERE thread_id = ?').get(parentId);
      const lastMsg = db.prepare(`
        SELECT m.id, m.content, m.created_at, COALESCE(u.display_name, u.username) as username
        FROM messages m LEFT JOIN users u ON m.user_id = u.id
        WHERE m.thread_id = ? ORDER BY m.created_at DESC LIMIT 1
      `).get(parentId);

      // Get up to 5 unique participants
      const participants = db.prepare(`
        SELECT DISTINCT COALESCE(u.display_name, u.username) as username, u.avatar
        FROM messages m JOIN users u ON m.user_id = u.id
        WHERE m.thread_id = ? ORDER BY m.created_at DESC LIMIT 5
      `).all(parentId);

      io.to(`channel:${code}`).emit('thread-updated', {
        channelCode: code,
        parentId,
        thread: {
          count: threadCount.count,
          lastReplyAt: lastMsg ? lastMsg.created_at : null,
          participants: participants.map(p => ({ username: p.username, avatar: p.avatar }))
        }
      });

      if (typeof callback === 'function') callback({ success: true });
    } catch (err) {
      console.error('send-thread-message error:', err.message);
      if (typeof callback === 'function') callback({ error: 'Failed to send thread message' });
    }
  });
};
