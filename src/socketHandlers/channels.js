// ── Channel CRUD, sub-channels, settings, reordering, categories, DMs ──

const UPLOAD_PATH_RE = /\/uploads\/((?!(?:bot-audio|deleted-attachments|stickers)\/)(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+)/g;
const UPLOAD_PATH_EXACT_RE = /^\/uploads\/((?!(?:bot-audio|deleted-attachments|stickers)\/)(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+)$/;

const storage = require('../storage');
const { isSafeUploadRelPath } = storage;
const { isString, isInt, releasableUploads, CHANNEL_NAME_RE, NEW_DMS_PER_HOUR } = require('./helpers');

// The files the messages in these channels point at, kept per author, read
// before the rows go. A file only goes with its own uploader's messages
// (releasableUploads), so posting another member's avatar or emoji in a
// channel of your own and deleting it cannot take that file from everyone.
function channelUploadsByAuthor(db, channelIds) {
  const byAuthor = new Map();
  const marks = channelIds.map(() => '?').join(',');
  const msgs = db.prepare(`SELECT user_id, content FROM messages WHERE channel_id IN (${marks})`).all(...channelIds);
  for (const row of msgs) {
    if (!Number.isInteger(row.user_id)) continue;
    const text = row.content || '';
    UPLOAD_PATH_RE.lastIndex = 0;
    let m;
    while ((m = UPLOAD_PATH_RE.exec(text)) !== null) {
      if (!isSafeUploadRelPath(m[1])) continue;
      if (!byAuthor.has(row.user_id)) byAuthor.set(row.user_id, new Set());
      byAuthor.get(row.user_id).add(m[1]);
    }
  }
  return byAuthor;
}

// After the delete: move out the files nothing else points at anymore. The
// same file can be linked from more than one message (a copy pasted image
// URL), so a file still used elsewhere stays. Mirrors auto-cleanup (#5423).
async function releaseChannelUploads(db, byAuthor, label) {
  for (const [authorId, rels] of byAuthor) {
    try {
      for (const rel of releasableUploads(db, [...rels], [authorId])) await storage.softDelete(rel);
    } catch (err) { console.warn(`${label} attachment cleanup failed:`, err.message); /* the files stay in uploads/; nothing is lost */ }
  }
}
const { clearChannelRuntimeState } = require('../channelRotation');
const { reachableChannel } = require('./channelAccess');
const protectedMessages = require('../protectedMessages');
const channelTypes = require('../channelTypes');

module.exports = function register(socket, ctx) {
  const {
    io, db, state, userHasPermission, getUserEffectiveLevel,
    broadcastChannelLists, getEnrichedChannels, getEnrichedChannelsAsync, emitOnlineUsers, emitDmPresence, resetPresenceSync,
    handleVoiceLeave, broadcastVoiceUsers, generateUniqueSharedCode,
    logAudit, fireWebhookEvent, enforceAutomod,
    rotateChannelCode, rotatePrivateCodesAfterRemoval, botAudioManager
  } = ctx;
  // roles.js puts this on ctx after this file has read it, so look it up at
  // call time. Read once above, it was always undefined: the auto-role loops
  // threw after the first role and the rest were never granted.
  const applyRoleChannelAccess = (...args) => (typeof ctx.applyRoleChannelAccess === 'function' ? ctx.applyRoleChannelAccess(...args) : undefined);
  const { refuseYoungAccount } = require('./postingWait')(socket, ctx);
  // New one to one conversations per hour: NEW_DMS_PER_HOUR (helpers.js).
  // Existing conversations are not counted.
  const { channelUsers, voiceUsers, activeMusic, musicQueues } = state;
  const _audit = (typeof logAudit === 'function') ? logAudit : () => {};
  // One entry per changed channel setting: which setting, and what it is now.
  const auditChannel = (channelId, setting, value) => {
    const ch = db.prepare('SELECT name FROM channels WHERE id = ?').get(channelId);
    _audit({ actor: socket.user, action: 'channel_setting_update',
      target_type: 'channel', target_id: channelId, target_name: ch ? ch.name : null,
      details: { setting, value } });
  };

  // (#5389) Auto-grant a channel's default_role_id to a user when they join
  // or are added to that channel. No-op if the channel has no default role.
  // Safe to call repeatedly: INSERT OR IGNORE avoids duplicates.
  const _applyChannelDefaultRole = (channelId, userId, grantedBy = null) => {
    try {
      const row = db.prepare('SELECT default_role_id FROM channels WHERE id = ?').get(channelId);
      if (!row || !row.default_role_id) return;
      db.prepare(
        'INSERT OR IGNORE INTO user_roles (user_id, role_id, channel_id, granted_by) VALUES (?, ?, ?, ?)'
      ).run(userId, row.default_role_id, channelId, grantedBy);
      if (typeof applyRoleChannelAccess === 'function') {
        try { applyRoleChannelAccess(row.default_role_id, userId, 'grant'); } catch (err) {
          // The role landed but its linked channels did not.
          console.warn('applyChannelDefaultRole channel access grant failed:', err.message);
        }
      }
    } catch (e) {
      console.warn('applyChannelDefaultRole failed:', e.message);
    }
  };

  // (#5424) Organizing a parent's sub-channels is sub-channel management, not
  // server administration. A user may do it if they hold manage_sub_channels
  // for that parent (channel-scoped roles cascade onto the parent), or
  // create_channel. parentId === null means top-level / server structure,
  // which still requires a server-wide create_channel (or admin).
  // (#5467) That create_channel check is now scoped to the parent being
  // reorganized. A server-wide grant still passes everywhere (server-scoped
  // roles are checked regardless of channelId), but a grant made on one
  // specific channel no longer reaches every other channel's structure.
  const _canManageSubsOf = (parentId) =>
    socket.user.isAdmin ||
    (!!parentId && userHasPermission(socket.user.id, 'manage_sub_channels', parentId)) ||
    userHasPermission(socket.user.id, 'create_channel', parentId || null);

  // (#5467) Editing an existing channel's configuration (feature toggles,
  // slow mode, voice limits, notification type, AFK, self-destruct, code
  // settings) is channel management, not server administration. It used to
  // gate on the server-wide create_channel permission, so anyone trusted to
  // create a channel could also silence voice, arm a self-destruct timer, or
  // flip a channel read-only anywhere on the server. manage_channel_settings
  // is the dedicated grant, and it is always checked against the channel
  // being edited: a channel-scoped assignment stays inside that channel and
  // its sub-channels (via the role chain), while a server-wide one applies
  // everywhere as before.
  // Server-wide permission is not a reach into every channel: someone who is
  // not the admin changes settings only of channels they are in, through
  // their gate. Without that, a Mod could put a deletion timer on, or open
  // up, a private channel they could not even see.
  const _canManageSettingsOf = (channelId) => {
    if (socket.user.isAdmin) return true;
    if (!userHasPermission(socket.user.id, 'manage_channel_settings', channelId)) return false;
    const ch = db.prepare('SELECT id, role_gate FROM channels WHERE id = ?').get(channelId);
    if (!ch || !db.prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?').get(channelId, socket.user.id)) return false;
    return ctx.roleGateAllows(socket.user.id, ch);
  };

  // (#5492) Authority over ONE END of a move. Nesting a channel under a parent
  // adds a child to that parent's structure, so it needs authority over that
  // specific parent: admin, or a channel-scoped manage_sub_channels grant.
  // Unlike _canManageSubsOf, the server-wide create_channel permission is
  // deliberately NOT enough; otherwise anyone who can create a channel could
  // make a top-level channel and move it under a parent they don't moderate,
  // sidestepping manage_sub_channels entirely.
  //
  // A null parent means top level, which is nobody's to manage, so it imposes
  // no requirement of its own. That keeps the rule symmetric: taking a channel
  // out of a parent and putting one back in both cost the same permission on
  // the same parent. Treating null as admin-only instead would let a
  // sub-channel manager promote a channel out and then be unable to put it
  // back. Touching top level at all is already gated on create_channel above.
  const _canManageSubsScoped = (parentId) =>
    !parentId ||
    socket.user.isAdmin ||
    userHasPermission(socket.user.id, 'manage_sub_channels', parentId);

  // ── Get user's channels ─────────────────────────────────
  socket.on('get-channels', async () => {
    try {
      const joinRoom = (room) => socket.join(room);
      // SQLite answers right here with no await, so channels-list keeps its
      // place ahead of the other replies in the client's startup burst.
      const channels = db.async?.kind === 'sqlite' || !getEnrichedChannelsAsync
        ? getEnrichedChannels(socket.user.id, socket.user.isAdmin, joinRoom)
        : await getEnrichedChannelsAsync(socket.user.id, socket.user.isAdmin, joinRoom);
      socket.emit('channels-list', channels);
      // Now in every DM room: let partners know this user is here (#5574).
      if (emitDmPresence) emitDmPresence(socket.user.id);
      ctx.dmCalls?.snapshotFor(socket);
    } catch (err) {
      console.error('Channel list failed:', err.message);
      socket.emit('error-msg', 'Could not load channels');
    }
  });

  // An Organize tag as stored: trimmed, at most 30 characters, null when
  // empty. If another channel already uses it in different casing, that
  // casing is adopted so the two group together.
  function normalizeCategory(raw, ownId = 0) {
    const category = typeof raw === 'string' ? raw.trim().slice(0, 30) : '';
    if (!category) return null;
    const existing = db.prepare(
      'SELECT category FROM channels WHERE category IS NOT NULL AND id != ? AND category COLLATE NOCASE = ?'
    ).get(ownId, category);
    return existing ? existing.category : category;
  }

  // ── Create channel (permission-based) ─────────────────
  // (#5461) Assign the configured "channel creator role" to a non-admin who
  // just created a channel, scoped to that channel. The role is configurable
  // in Admin → Roles: '' / 'default' keeps the pre-5461 behavior (the
  // highest-level channel-scoped role), 'none' disables the auto-grant, and a
  // numeric id assigns that specific role. Admins already have full power
  // everywhere, so they are never auto-assigned anything. Applies to both
  // top-level channels and sub-channels for consistency.
  function assignChannelCreatorRole(userId, channelId) {
    try {
      const creator = db.prepare('SELECT is_admin FROM users WHERE id = ?').get(userId);
      if (creator && creator.is_admin) return;

      const row = db.prepare("SELECT value FROM server_settings WHERE key = 'channel_creator_role'").get();
      const setting = row && typeof row.value === 'string' ? row.value.trim() : '';
      if (setting === 'none') return; // admin disabled the auto-grant

      let roleId = null;
      if (setting === '' || setting === 'default') {
        const def = db.prepare(
          "SELECT id FROM roles WHERE scope = 'channel' ORDER BY level DESC LIMIT 1"
        ).get();
        roleId = def ? def.id : null;
      } else {
        const rid = parseInt(setting, 10);
        const exists = isNaN(rid) ? null : db.prepare('SELECT id FROM roles WHERE id = ?').get(rid);
        roleId = exists ? exists.id : null;
      }
      if (!roleId) return;

      db.prepare(
        'INSERT OR IGNORE INTO user_roles (user_id, role_id, channel_id, granted_by) VALUES (?, ?, ?, NULL)'
      ).run(userId, roleId, channelId);
    } catch (e) {
      console.warn('assignChannelCreatorRole failed:', e && e.message);
    }
  }

  socket.on('create-channel', (data) => {
    if (!data || typeof data !== 'object') return;
    if (!userHasPermission(socket.user.id, 'create_channel')) {
      return socket.emit('error-msg', 'You don\'t have permission to create channels');
    }

    const name = typeof data.name === 'string' ? data.name.trim() : '';
    if (!name || name.length === 0) {
      return socket.emit('error-msg', 'Channel name required');
    }
    if (name.length > 50) {
      return socket.emit('error-msg', 'Channel name too long (max 50)');
    }
    if (!CHANNEL_NAME_RE.test(name)) {
      return socket.emit('error-msg', 'Channel name contains invalid characters');
    }

    const code = generateUniqueSharedCode();
    const isPrivate = data.isPrivate ? 1 : 0;
    // Putting everyone in the channel is inviting them all, so it takes what
    // inviting people takes (the switch only shows for them).
    const addAll = !!data.addAllMembers && !isPrivate && (socket.user.isAdmin
      || userHasPermission(socket.user.id, 'invite_users') || userHasPermission(socket.user.id, 'manage_server'));

    let expiresAt = null;
    if (data.temporary && data.duration) {
      const hours = Math.max(1, Math.min(720, parseInt(data.duration, 10)));
      if (!isNaN(hours)) {
        expiresAt = new Date(Date.now() + hours * 3600000).toISOString();
      }
    }

    try {
      const result = db.prepare(
        'INSERT INTO channels (name, code, created_by, is_private, expires_at, is_forum) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(name.trim(), code, socket.user.id, isPrivate, expiresAt, data.isForum ? 1 : 0);

      // Channel templates send the rest of the setup along with the name, so
      // an "Announcements" channel comes out read-only and in announcement
      // mode in one go instead of three trips through Channel Functions.
      const extras = [];
      const { sanitizeText } = require('./helpers');
      const topic = isString(data.topic, 1, 256) ? sanitizeText(data.topic.trim()) : '';
      if (topic && !enforceAutomod(topic, { surface: 'channel', channelId: result.lastInsertRowid })) extras.push(['topic', topic]);
      if (data.readOnly) extras.push(['read_only', 1]);
      if (data.announcement) extras.push(['notification_type', 'announcement']);
      if (isInt(data.slowMode) && data.slowMode > 0) extras.push(['slow_mode_interval', Math.min(3600, data.slowMode)]);
      if (data.mediaEnabled === false) extras.push(['media_enabled', 0]);
      if (data.voiceEnabled === false) extras.push(['voice_enabled', 0]);
      if (extras.length) {
        db.prepare(`UPDATE channels SET ${extras.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`)
          .run(...extras.map(([, v]) => v), result.lastInsertRowid);
      }

      db.prepare(
        'INSERT INTO channel_members (channel_id, user_id) VALUES (?, ?)'
      ).run(result.lastInsertRowid, socket.user.id);

      // The first non-DM channel on a fresh server becomes the default welcome
      // channel, so persistent new-member welcome messages have somewhere to go
      // out of the box. Admins can move it later in Channel Functions.
      try {
        const nonDmCount = db.prepare('SELECT COUNT(*) AS n FROM channels WHERE is_dm = 0').get().n;
        if (nonDmCount === 1) {
          db.prepare('UPDATE channels SET show_welcome = 1 WHERE id = ?').run(result.lastInsertRowid);
        }
      } catch { /* only a starting default; admins can pick the welcome channel by hand */ }

      // Optional: bulk-add every existing user to the new channel.
      // Lets admins approximate Discord-style "everyone is in every channel"
      // when a server uses the server-wide invite code. (#5271)
      if (addAll) {
        try {
          const allUsers = db.prepare('SELECT id FROM users').all();
          const insertMember = db.prepare(
            'INSERT OR IGNORE INTO channel_members (channel_id, user_id) VALUES (?, ?)'
          );
          const txn = db.transaction(() => {
            for (const u of allUsers) insertMember.run(result.lastInsertRowid, u.id);
          });
          txn();
        } catch (e) {
          console.warn('addAllMembers failed:', e.message);
        }
      }

      assignChannelCreatorRole(socket.user.id, result.lastInsertRowid);

      const channel = {
        id: result.lastInsertRowid,
        name: name.trim(),
        code,
        display_code: code,
        created_by: socket.user.id,
        topic: '',
        is_dm: 0,
        is_private: isPrivate,
        expires_at: expiresAt,
        // The creator's sidebar renders from this stub until the enriched
        // list lands, so a forum has to say so here or it shows up as #.
        is_forum: data.isForum ? 1 : 0
      };

      socket.join(`channel:${code}`);
      socket.emit('channel-created', channel);

      // channel-created carries a hand-built stub, not an enriched row, so the
      // per-channel permission answers (canManageSettings / canManageSubs) are
      // missing from it. Follow up with the real list (sub-channel creation
      // already does); otherwise the creator's own context menu hides the
      // options they just earned until something else refreshes it. (#5467)
      broadcastChannelLists();

      _audit({ actor: socket.user, action: 'channel_create',
        target_type: 'channel', target_id: result.lastInsertRowid, target_name: name.trim(),
        details: { code, isPrivate: !!isPrivate, expiresAt } });

      // If we mass-added every user, push the new channel to all currently
      // connected sockets so it appears for them without a refresh. (#5271)
      if (addAll) {
        for (const [, s] of io.sockets.sockets) {
          if (!s.user || s.user.isBot || s.user.id === socket.user.id) continue;
          s.join(`channel:${code}`);
          s.emit('channel-created', channel);
        }
      }
    } catch (err) {
      console.error('Create channel error:', err);
      socket.emit('error-msg', 'Failed to create channel');
    }
  });

  // ── Create temporary voice channel (#163) ───────────────
  socket.on('create-temp-channel', (data) => {
    if (!data || typeof data !== 'object') return;
    if (!socket.user.isAdmin && !userHasPermission(socket.user.id, 'create_temp_channel')) {
      return socket.emit('error-msg', 'You don\'t have permission to create temporary channels');
    }

    const name = typeof data.name === 'string' ? data.name.trim() : '';
    if (!name || name.length === 0) return socket.emit('error-msg', 'Channel name required');
    if (name.length > 50) return socket.emit('error-msg', 'Channel name too long (max 50)');
    if (!CHANNEL_NAME_RE.test(name)) {
      return socket.emit('error-msg', 'Channel name contains invalid characters');
    }

    try {
      const existing = db.prepare(
        "SELECT COUNT(*) as cnt FROM channels WHERE created_by = ? AND expires_at IS NOT NULL"
      ).get(socket.user.id);
      if (existing && existing.cnt >= 3) {
        return socket.emit('error-msg', 'You already have the maximum number of temporary channels (3)');
      }
    } catch (err) {
      // The cap could not be checked, so the channel is not made.
      console.warn('create-temp-channel limit check failed, refusing:', err.message);
      return socket.emit('error-msg', 'Could not create the temporary channel. Try again in a moment.');
    }

    const code = generateUniqueSharedCode();
    const expiresAt = new Date(Date.now() + 24 * 3600000).toISOString();

    try {
      const result = db.prepare(
        'INSERT INTO channels (name, code, created_by, is_private, expires_at, voice_enabled, is_temp_voice) VALUES (?, ?, ?, 0, ?, 1, 1)'
      ).run(name.trim(), code, socket.user.id, expiresAt);

      const channelId = result.lastInsertRowid;
      const allUsers = db.prepare('SELECT id FROM users').all();
      const insertMember = db.prepare('INSERT OR IGNORE INTO channel_members (channel_id, user_id) VALUES (?, ?)');
      for (const u of allUsers) insertMember.run(channelId, u.id);

      const channel = {
        id: channelId, name: name.trim(), code, display_code: code,
        created_by: socket.user.id, topic: '', is_dm: 0, is_private: 0,
        expires_at: expiresAt, voice_enabled: 1, is_temp_voice: 1
      };

      for (const [, s] of io.sockets.sockets) {
        if (s.user && !s.user.isBot) s.join(`channel:${code}`);
      }
      io.except('bot-sockets').emit('temp-channel-created', channel);
      socket.emit('temp-channel-join-voice', { code });
    } catch (err) {
      console.error('Create temp channel error:', err);
      socket.emit('error-msg', 'Failed to create temporary channel');
    }
  });

  // ── Join channel by code ────────────────────────────────
  socket.on('join-channel', (data) => {
    if (!data || typeof data !== 'object') return;
    // (#5381) Guests can't widen their own access beyond the admin's
    // guest_channels whitelist by entering an invite code.
    if (socket.user.isGuest) {
      return socket.emit('error-msg', 'Guests cannot join channels by code');
    }
    const code = typeof data.code === 'string' ? data.code.trim() : '';
    if (!code) return socket.emit('error-msg', 'Invalid channel code');

    // (#5345) Helper: figure out which channels a server-code / vanity-code
    // joiner should be added to. Always EXCLUDES private parents (private
    // channels were never supposed to be unlocked by an invite code).
    // If the admin has set `default_join_channels` to a non-empty JSON
    // array of channel IDs, we restrict the auto-join to that intersection
    // so admins can curate which public channels new arrivals land in.
    // When `explicitChannelIds` is passed (a managed invite link's own channel
    // grant), it overrides the global default_join_channels setting. An empty
    // array means "all public", same as leaving the global default unset.
    const _resolveAutoJoinChannels = (explicitChannelIds) => {
      const allParents = db.prepare(
        "SELECT id, code, parent_channel_id FROM channels WHERE parent_channel_id IS NULL AND is_dm = 0 AND is_private = 0 AND (code_visibility IS NULL OR code_visibility != 'private')"
      ).all();
      let allowSet = null;
      if (Array.isArray(explicitChannelIds)) {
        // Managed invite: the invite's channel list is authoritative.
        // An empty array means no channels.
        allowSet = new Set(explicitChannelIds.map(n => parseInt(n, 10)).filter(n => Number.isFinite(n)));
      } else {
        // Legacy server/vanity code: use the global default join-channel
        // setting when configured. Empty/unset means all public.
        try {
          const djc = db.prepare("SELECT value FROM server_settings WHERE key = 'default_join_channels'").get();
          if (djc && djc.value) {
            const parsed = JSON.parse(djc.value);
            if (Array.isArray(parsed) && parsed.length > 0) {
              allowSet = new Set(parsed.map(n => parseInt(n, 10)).filter(n => Number.isFinite(n)));
            }
          }
        } catch { /* malformed JSON falls through to "all public" */ }
      }

      const parents = allowSet ? allParents.filter(p => allowSet.has(p.id)) : allParents;
      return { parents, allowSet };
    };

    const _doAutoJoin = (explicitChannelIds) => {
      const { parents, allowSet } = _resolveAutoJoinChannels(explicitChannelIds);
      const insertMember = db.prepare('INSERT OR IGNORE INTO channel_members (channel_id, user_id) VALUES (?, ?)');
      const joinedChannelIds = [];
      let joinedCount = 0;
      const txn = db.transaction(() => {
        // Rooms are joined by the channel list sent right after this, which
        // leaves out any channel whose required roles the person lacks.
        // Joining them here put the live feed of gated channels in front of
        // people the gate is meant to keep out.
        for (const parent of parents) {
          insertMember.run(parent.id, socket.user.id);
          joinedChannelIds.push(parent.id);
          joinedCount++;
          // Sub-channels: never grant private subs via invite. When a
          // default-channels allowlist is set, only grant subs whose
          // parent is on the list (matches admin intent).
          const subs = db.prepare('SELECT id, code FROM channels WHERE parent_channel_id = ? AND is_private = 0').all(parent.id);
          for (const sub of subs) {
            insertMember.run(sub.id, socket.user.id);
            joinedChannelIds.push(sub.id);
            joinedCount++;
          }
        }
      });
      txn();
      // (#5389) Apply each channel's default role after membership is settled.
      for (const chId of joinedChannelIds) _applyChannelDefaultRole(chId, socket.user.id);
      return joinedCount;
    };

    // ── Managed invite link (multi-code menu) ──────────
    // Checked before the legacy vanity/server codes and before the hex-format
    // gate, since a managed code can be a custom slug. Each carries its own
    // channel grant, on/off switch, and optional expiry by time / distinct-user
    // count. A user who already redeemed a code can re-enter it freely (e.g. to
    // refresh) without burning another use against the limit.
    const inviteRow = db.prepare(
      "SELECT *, (expires_at IS NOT NULL AND expires_at <= CURRENT_TIMESTAMP) AS is_expired FROM invite_codes WHERE code = ?"
    ).get(code);
    if (inviteRow) {
      if (!inviteRow.enabled) {
        return socket.emit('error-msg', 'This invite link has been disabled.');
      }
      if (inviteRow.is_expired) {
        return socket.emit('error-msg', 'This invite link has expired.');
      }
      const alreadyUsed = db.prepare(
        'SELECT 1 FROM invite_code_uses WHERE invite_code_id = ? AND user_id = ?'
      ).get(inviteRow.id, socket.user.id);
      if (!alreadyUsed && inviteRow.max_uses > 0) {
        const used = db.prepare(
          'SELECT spent AS n FROM invite_codes WHERE id = ?'
        ).get(inviteRow.id).n;
        if (used >= inviteRow.max_uses) {
          return socket.emit('error-msg', 'This invite link has reached its use limit.');
        }
      }
      // Links saved before 4.4.2 stored '' for "every public channel". Since
      // #5583 a list is authoritative, an empty one included, so only a real
      // list is passed along and the old blank keeps meaning what it meant.
      let chList = null;
      if (inviteRow.channels) {
        try {
          const parsed = JSON.parse(inviteRow.channels);
          if (Array.isArray(parsed)) chList = parsed;
        } catch { /* malformed: fall back to the legacy meaning */ }
      }
      const joinedCount = _doAutoJoin(chList);
      const use = db.prepare(
        'INSERT OR IGNORE INTO invite_code_uses (invite_code_id, user_id) VALUES (?, ?)'
      ).run(inviteRow.id, socket.user.id);
      // A redemption counts on the link itself, so it survives the user (#5562).
      if (use.changes) db.prepare('UPDATE invite_codes SET spent = spent + 1 WHERE id = ?').run(inviteRow.id);
      socket.emit('channels-list', getEnrichedChannels(socket.user.id, socket.user.isAdmin, (room) => socket.join(room)));
      socket.emit('toast', { message: `Invite accepted: joined ${joinedCount} channel${joinedCount !== 1 ? 's' : ''}`, type: 'success' });
      return;
    }

    // Check if this is a vanity invite code first
    const vanityRow = db.prepare("SELECT value FROM server_settings WHERE key = 'vanity_code'").get();
    const isVanity = vanityRow && vanityRow.value && vanityRow.value === code;

    // For vanity codes, resolve to the actual server code
    if (isVanity) {
      const joinedCount = _doAutoJoin();
      socket.emit('channels-list', getEnrichedChannels(socket.user.id, socket.user.isAdmin, (room) => socket.join(room)));
      socket.emit('toast', { message: `Invite accepted: joined ${joinedCount} channel${joinedCount !== 1 ? 's' : ''}`, type: 'success' });
      return;
    }

    // Standard 8-char hex code
    if (!/^[a-f0-9]{8}$/i.test(code)) {
      return socket.emit('error-msg', 'Invalid channel code format');
    }

    // ── Check if this is a server-wide invite code ─────
    const serverCodeRow = db.prepare("SELECT value FROM server_settings WHERE key = 'server_code'").get();
    if (serverCodeRow && serverCodeRow.value && serverCodeRow.value === code) {
      const joinedCount = _doAutoJoin();
      socket.emit('channels-list', getEnrichedChannels(socket.user.id, socket.user.isAdmin, (room) => socket.join(room)));
      socket.emit('error-msg', `Server code accepted: joined ${joinedCount} channel${joinedCount !== 1 ? 's' : ''}`);
      return;
    }

    const channel = db.prepare('SELECT * FROM channels WHERE code = ?').get(code);
    if (!channel) {
      return socket.emit('error-msg', 'Invalid channel code. Double-check it');
    }

    // (#5348) DMs are private one-to-one channels. Their codes must never be
    // usable by a third party; even a read-only presence leaks metadata
    // (who is talking to whom, timing, frequency). Reject silently with the
    // same generic error so callers can't distinguish "no channel" from "is DM".
    if (channel.is_dm) {
      return socket.emit('error-msg', 'Invalid channel code. Double-check it');
    }

    const membership = db.prepare(
      'SELECT * FROM channel_members WHERE channel_id = ? AND user_id = ?'
    ).get(channel.id, socket.user.id);

    // (#5408) A channel code is not a skeleton key for sub-channels. Access to
    // a sub-channel is inherited by joining its PARENT (which auto-adds the
    // parent's public subs); you never join a sub-channel directly by entering
    // or crafting its code. Without this, a non-member could paste a
    // sub-channel's code (or open a ?channel=<sub> deep link) and the plain
    // join below would hand them membership, unlocking its history and the
    // ability to post. Only gate NEW joins; existing members re-emit
    // join-channel to refresh (e.g. after a message move) and must still pass.
    // A private channel is joined by being added to it, never by its code.
    if (!membership && !socket.user.isAdmin && !channel.parent_channel_id && channel.is_private && channel.created_by !== socket.user.id) {
      return socket.emit('error-msg', 'Invalid channel code. Double-check it');
    }
    if (!membership && !socket.user.isAdmin && channel.parent_channel_id) {
      const isPrivateSub = channel.is_private || channel.code_visibility === 'private';
      const parentMember = db.prepare(
        'SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?'
      ).get(channel.parent_channel_id, socket.user.id);
      // Private subs are never granted by code (they need an explicit add,
      // matching the public-only auto-join rule); public subs require parent
      // membership. Reuse the generic error so the code's existence stays hidden.
      if (isPrivateSub || !parentMember) {
        return socket.emit('error-msg', 'Invalid channel code. Double-check it');
      }
    }

    if (!membership) {
      db.prepare(
        'INSERT INTO channel_members (channel_id, user_id) VALUES (?, ?)'
      ).run(channel.id, socket.user.id);

      try {
        const autoRoles = db.prepare('SELECT id FROM roles WHERE auto_assign = 1').all();
        const insertAutoRole = db.prepare('INSERT OR IGNORE INTO user_roles (user_id, role_id, channel_id, granted_by) VALUES (?, ?, NULL, NULL)');
        for (const ar of autoRoles) {
          insertAutoRole.run(socket.user.id, ar.id);
          applyRoleChannelAccess(ar.id, socket.user.id, 'grant');
        }
      } catch (err) {
        // The join still stands, but the auto-assign roles may be missing.
        console.warn('join-channel auto-role grant failed:', err.message);
      }

      // (#5389) Per-channel default role auto-grant.
      _applyChannelDefaultRole(channel.id, socket.user.id);
    }

    // A role-gated channel's live feed is only for those its gate lets in,
    // the same rule get-messages and the channel list apply. Joining its room
    // here regardless let anyone listen in by entering a code.
    const gateOk = (ch) => socket.user.isAdmin || ctx.roleGateAllows(socket.user.id, ch);
    if (!channel.parent_channel_id) {
      const subs = db.prepare(
        'SELECT id, code, role_gate FROM channels WHERE parent_channel_id = ? AND is_private = 0'
      ).all(channel.id);
      const insertSub = db.prepare('INSERT OR IGNORE INTO channel_members (channel_id, user_id) VALUES (?, ?)');
      subs.forEach(sub => {
        insertSub.run(sub.id, socket.user.id);
        if (gateOk(sub)) socket.join(`channel:${sub.code}`);
        _applyChannelDefaultRole(sub.id, socket.user.id);
      });
    }

    if (!membership) {
      if (channel.code_mode === 'dynamic' && channel.code_rotation_type === 'joins') {
        const newCount = (channel.code_rotation_counter || 0) + 1;
        const threshold = channel.code_rotation_interval || 5;
        if (newCount >= threshold) {
          try {
            channel.code = rotateChannelCode(channel.id, code);
          } catch (err) {
            console.warn(`[ChannelRotation] Join-triggered rotation failed for channel ${channel.id}:`, err.message);
          }
        } else {
          db.prepare('UPDATE channels SET code_rotation_counter = ? WHERE id = ?').run(newCount, channel.id);
        }
      }
    }

    const activeCode = channel.code;
    if (gateOk(channel)) socket.join(`channel:${activeCode}`);

    // Only a new member is announced. Entering the code of a channel you are
    // already in runs this handler too, and used to post "joined the channel"
    // for everyone again each time.
    if (!membership) {
      io.to(`channel:${activeCode}`).emit('user-joined', {
        channelCode: activeCode,
        user: { id: socket.user.id, username: socket.user.displayName }
      });

      // Webhook event: member-joined (3.13.0)
      try {
        fireWebhookEvent?.(channel.id, activeCode, 'member-joined', {
          user: { id: socket.user.id, username: socket.user.displayName }
        });
      } catch { /* fireWebhookEvent catches and logs its own errors; this only guards the call */ }
    }

    const isPrivateCode = channel.code_visibility === 'private' || channel.is_private;
    const joinerCanSeeCode = socket.user.isAdmin
      || channel.created_by === socket.user.id
      || userHasPermission(socket.user.id, 'kick_user', channel.id);
    socket.emit('channel-joined', {
      id: channel.id, name: channel.name, code: activeCode,
      display_code: (isPrivateCode && !joinerCanSeeCode) ? '••••••••' : activeCode,
      created_by: channel.created_by, topic: channel.topic || '', is_dm: channel.is_dm || 0
    });

    // Every app this person has open gets the channel and its rooms, not
    // only this one: joined on a phone, the desktop app showed the channel
    // later but never heard who was in its voice room (#5782).
    const mine = [...io.sockets.sockets.values()].filter(s => s.connected && s.user && s.user.id === socket.user.id);
    const list = getEnrichedChannels(socket.user.id, socket.user.isAdmin, (room) => { for (const s of mine) s.join(room); });
    for (const s of mine) s.emit('channels-list', list);
  });

  // ── Leave channel ───────────────────────────────────────
  socket.on('leave-channel', (data, callback) => {
    if (!data || typeof data !== 'object') return;
    const cb = typeof callback === 'function' ? callback : () => {};
    const code = typeof data.code === 'string' ? data.code.trim() : '';
    if (!code || !/^[a-f0-9]{8}$/i.test(code)) return cb({ error: 'Invalid code' });

    const channel = db.prepare('SELECT * FROM channels WHERE code = ?').get(code);
    if (!channel) return cb({ error: 'Channel not found' });
    if (socket.user.isAdmin) return cb({ error: 'Admins cannot leave channels' });
    if (channel.is_dm) return cb({ error: 'Use Delete DM instead' });

    db.prepare('DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?').run(channel.id, socket.user.id);

    const leftCodes = [code];
    if (!channel.parent_channel_id) {
      const subs = db.prepare('SELECT id, code FROM channels WHERE parent_channel_id = ?').all(channel.id);
      const delSub = db.prepare('DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?');
      subs.forEach(s => { delSub.run(s.id, socket.user.id); leftCodes.push(s.code); });
    }

    // Every tab and device leaves, sub-channels included, not just this one.
    const wasHere = !!channelUsers.get(code)?.has(socket.user.id);
    ctx.liveAccess?.cutOff(socket.user.id, leftCodes, 'You left this channel');
    if (wasHere) emitOnlineUsers(code);

    socket.emit('channels-list', getEnrichedChannels(socket.user.id, socket.user.isAdmin, (room) => socket.join(room)));
    cb({ success: true });
  });

  // ── Switch active channel ───────────────────────────────
  socket.on('enter-channel', (data) => {
    if (!data || typeof data !== 'object') return;
    const code = typeof data.code === 'string' ? data.code.trim() : '';
    if (!code || !/^[a-f0-9]{8}$/i.test(code)) return;

    const ch = db.prepare('SELECT id, is_dm FROM channels WHERE code = ?').get(code);
    if (!ch) return;
    const isMember = db.prepare(
      'SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?'
    ).get(ch.id, socket.user.id);
    if (!isMember) {
      if (socket.user.isAdmin && !ch.is_dm) {
        db.prepare('INSERT OR IGNORE INTO channel_members (channel_id, user_id) VALUES (?, ?)').run(ch.id, socket.user.id);
      } else {
        return socket.emit('error-msg', 'Not a member of this channel');
      }
    }
    // Entering joins the channel's live room, which is reading it, so its
    // required roles apply here as they do to its history.
    if (!socket.user.isAdmin && !ch.is_dm && !ctx.roleGateAllows(socket.user.id, db.prepare('SELECT id, role_gate FROM channels WHERE id = ?').get(ch.id))) {
      return socket.emit('error-msg', 'This channel needs a role you do not hold');
    }

    if (socket.currentChannel && socket.currentChannel !== code) {
      const prevUsers = channelUsers.get(socket.currentChannel);
      if (prevUsers) {
        prevUsers.delete(socket.user.id);
        emitOnlineUsers(socket.currentChannel);
      }
    }

    socket.currentChannel = code;
    socket.join(`channel:${code}`);
    // Opening a channel shows its member list from the next update, so that
    // update has to be the whole list for this socket.
    resetPresenceSync(socket, code);

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

    emitOnlineUsers(code);
  });

  // ── Delete channel ──────────────────────────────────────
  socket.on('delete-channel', async (data) => {
    if (!data || typeof data !== 'object') return;
    const delCode = typeof data.code === 'string' ? data.code.trim() : '';
    const delCh = delCode ? db.prepare('SELECT id, created_by, is_temp_voice FROM channels WHERE code = ?').get(delCode) : null;
    const isOwnTemp = delCh && delCh.is_temp_voice && delCh.created_by === socket.user.id;
    // Pass the channel so channel-scoped grants count. Without it this only saw
    // server-wide roles, so a channel creator holding delete_channel through the
    // channel's own role could not delete the channel they had just made, nor
    // its sub-channels. getChannelRoleChain walks parents, so a grant on the
    // parent covers its children too. (#5461)
    if (!socket.user.isAdmin && !isOwnTemp &&
        !userHasPermission(socket.user.id, 'delete_channel', delCh ? delCh.id : null)) {
      return socket.emit('error-msg', 'Only admins can delete channels');
    }

    const code = delCode;
    if (!code || !/^[a-f0-9]{8}$/i.test(code)) return;
    const channel = db.prepare('SELECT * FROM channels WHERE code = ?').get(code);
    if (!channel) return;
    // A DM is removed by its own people through delete-dm, never here: a
    // server-wide delete_channel is not a key to other people's DMs.
    if (channel.is_dm) return socket.emit('error-msg', 'Channel not found');

    // A parent goes with everything under it. The parent link is ON DELETE
    // SET NULL, so sub-channels used to survive their parent's deletion as
    // top-level channels nobody had asked for. The client warns before it
    // gets here and points at moving any sub-channel worth keeping first.
    const subChannels = db.prepare(
      'SELECT id, code, name FROM channels WHERE parent_channel_id = ?'
    ).all(channel.id);
    const doomed = [...subChannels, channel]; // sub-channels first, then the parent
    const deletedCodes = doomed.map(c => c.code);
    const ids = doomed.map(c => c.id);
    // Protected messages outlive any delete, so a channel (or a sub-channel)
    // still holding one stays until they are unprotected.
    if (protectedMessages.protectedCount(db, ids)) return socket.emit('error-msg', protectedMessages.CHANNEL_REFUSAL);

    // Deleting a channel is deleting its messages in bulk, so their files go
    // too, as they do for a single message (#5487).
    let doomedUploads = new Map();
    try {
      doomedUploads = channelUploadsByAuthor(db, ids);
    } catch (err) {
      // Never block the delete; the channel's files just stay in uploads/.
      console.warn('delete-channel attachment scan failed:', err.message);
    }

    const deleteAll = db.transaction((chIds) => {
      for (const chId of chIds) {
        db.prepare('DELETE FROM reactions WHERE message_id IN (SELECT id FROM messages WHERE channel_id = ?)').run(chId);
        db.prepare('DELETE FROM pinned_messages WHERE channel_id = ?').run(chId);
        db.prepare('DELETE FROM messages WHERE channel_id = ?').run(chId);
        db.prepare('DELETE FROM channel_members WHERE channel_id = ?').run(chId);
        db.prepare('DELETE FROM channels WHERE id = ?').run(chId);
      }
    });
    deleteAll(ids);
    for (const deletedCode of deletedCodes) botAudioManager?.stopChannel(deletedCode, 'channel-deleted');
    broadcastChannelLists();

    await releaseChannelUploads(db, doomedUploads, 'delete-channel');

    for (const deletedCode of deletedCodes) {
      io.to(`channel:${deletedCode}`).to(`voice:${deletedCode}`).emit('channel-deleted', { code: deletedCode });
      clearChannelRuntimeState(state, deletedCode);
    }

    _audit({ actor: socket.user, action: 'channel_delete',
      target_type: 'channel', target_id: channel.id, target_name: channel.name,
      details: { code, parent_channel_id: channel.parent_channel_id || null,
        sub_channels: subChannels.map(s => ({ code: s.code, name: s.name })) } });
    for (const sub of subChannels) {
      _audit({ actor: socket.user, action: 'channel_delete',
        target_type: 'channel', target_id: sub.id, target_name: sub.name,
        details: { code: sub.code, parent_channel_id: channel.id, deleted_with_parent: code } });
    }
  });

  // ── Rename channel ──────────────────────────────────────
  socket.on('rename-channel', (data) => {
    if (!data || typeof data !== 'object') return;
    const code = typeof data.code === 'string' ? data.code.trim() : '';
    if (!code || !/^[a-f0-9]{8}$/i.test(code)) return;

    const name = typeof data.name === 'string' ? data.name.trim() : '';
    if (!name || name.length === 0 || name.length > 50) {
      return socket.emit('error-msg', 'Channel name must be 1-50 characters');
    }
    if (!CHANNEL_NAME_RE.test(name)) {
      return socket.emit('error-msg', 'Channel name contains invalid characters');
    }

    const channel = db.prepare('SELECT * FROM channels WHERE code = ? AND is_dm = 0').get(code);
    if (!channel) return socket.emit('error-msg', 'Channel not found');

    // Only a channel the renamer is in, through its gate.
    if (!socket.user.isAdmin && !reachableChannel(ctx, socket.user, channel.id)) return socket.emit('error-msg', 'Channel not found');
    const permChannel = channel.parent_channel_id || channel.id;
    const renamePermission = channel.parent_channel_id ? 'rename_sub_channel' : 'rename_channel';
    if (!socket.user.isAdmin && !userHasPermission(socket.user.id, renamePermission, permChannel)) {
      return socket.emit('error-msg', 'You don\'t have permission to rename channels');
    }

    try {
      // Keep the old name, so a #old-name typed before the rename still points
      // here and clients can show the name it has now (#5602). Newest first,
      // capped, and a name the channel has come back to drops out of the list.
      let former = [];
      try { former = JSON.parse(channel.former_names || '[]'); } catch { former = []; }
      if (!Array.isArray(former)) former = [];
      former = [channel.name, ...former]
        .filter((n, i, arr) => typeof n === 'string' && n && n.toLowerCase() !== name.toLowerCase() && arr.indexOf(n) === i)
        .slice(0, 10);
      db.prepare('UPDATE channels SET name = ?, former_names = ? WHERE id = ?').run(name, JSON.stringify(former), channel.id);
      broadcastChannelLists();
      io.to(code).emit('channel-renamed', { code, name });
      _audit({ actor: socket.user, action: 'channel_rename',
        target_type: 'channel', target_id: channel.id, target_name: name,
        details: { code, oldName: channel.name, newName: name } });
    } catch (err) {
      console.error('Rename channel error:', err);
      socket.emit('error-msg', 'Failed to rename channel');
    }
  });

  // ── Sub-channels ─────────────────────────────────────────
  socket.on('create-sub-channel', (data) => {
    if (!data || typeof data !== 'object') return;
    const parentCode = typeof data.parentCode === 'string' ? data.parentCode.trim() : '';
    if (!parentCode || !/^[a-f0-9]{8}$/i.test(parentCode)) return;

    const parentChannel = db.prepare('SELECT * FROM channels WHERE code = ? AND is_dm = 0').get(parentCode);
    if (!parentChannel) return socket.emit('error-msg', 'Parent channel not found');
    if (!socket.user.isAdmin && !reachableChannel(ctx, socket.user, parentChannel.id)) return socket.emit('error-msg', 'Parent channel not found');

    // (#5467) Adding a sub-channel to an existing channel is that channel's
    // business, so it takes manage_sub_channels on the parent and nothing
    // else. create_channel used to pass here too, which meant anyone allowed
    // to start their own channel could also add rooms inside channels they
    // had nothing to do with.
    if (!socket.user.isAdmin && !userHasPermission(socket.user.id, 'manage_sub_channels', parentChannel.id)) {
      return socket.emit('error-msg', 'You don\'t have permission to create sub-channels');
    }

    const name = typeof data.name === 'string' ? data.name.trim() : '';
    if (!name || name.length === 0 || name.length > 50) {
      return socket.emit('error-msg', 'Sub-channel name must be 1-50 characters');
    }
    if (!CHANNEL_NAME_RE.test(name)) {
      return socket.emit('error-msg', 'Sub-channel name contains invalid characters');
    }

    if (parentChannel.parent_channel_id) {
      return socket.emit('error-msg', 'Cannot create sub-channels inside sub-channels');
    }

    const code = generateUniqueSharedCode();
    const isPrivate = data.isPrivate ? 1 : 0;

    let expiresAt = null;
    if (data.temporary && data.duration) {
      const hours = Math.max(1, Math.min(720, parseInt(data.duration, 10)));
      if (!isNaN(hours)) {
        expiresAt = new Date(Date.now() + hours * 3600000).toISOString();
      }
    }

    const maxPos = db.prepare('SELECT MAX(position) as mp FROM channels WHERE parent_channel_id = ?').get(parentChannel.id);
    const position = (maxPos && maxPos.mp != null) ? maxPos.mp + 1 : 0;
    // The Organize tag, set here so it needs no second step. Same rules as
    // set-channel-category, which the creator is allowed to use on it too.
    const category = normalizeCategory(data.category);

    try {
      const result = db.prepare(
        'INSERT INTO channels (name, code, created_by, parent_channel_id, position, is_private, expires_at, category) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(name, code, socket.user.id, parentChannel.id, position, isPrivate, expiresAt, category);

      const parentMembers = db.prepare('SELECT user_id FROM channel_members WHERE channel_id = ?').all(parentChannel.id);
      const membersToAdd = isPrivate ? [{ user_id: socket.user.id }] : parentMembers;
      const insertMember = db.prepare('INSERT OR IGNORE INTO channel_members (channel_id, user_id) VALUES (?, ?)');
      membersToAdd.forEach(m => insertMember.run(result.lastInsertRowid, m.user_id));

      // (#5461) Give a non-admin sub-channel creator the configured creator
      // role too, scoped to the new sub-channel (top-level create already does).
      assignChannelCreatorRole(socket.user.id, result.lastInsertRowid);
      _audit({ actor: socket.user, action: 'channel_create',
        target_type: 'channel', target_id: result.lastInsertRowid, target_name: name,
        details: { parent: parentChannel.name, isPrivate: !!isPrivate, temporary: !!expiresAt } });

      // (#5328) Inherit role-channel-access from the parent channel so that
      // roles configured to grant/revoke access on the parent automatically
      // apply to newly-created sub-channels. Without this, server owners had
      // to re-add every role to every new sub-channel manually. Admins can
      // still customize per-sub-channel access afterwards via the role UI.
      try {
        const parentAccess = db.prepare(
          'SELECT role_id, grant_on_promote, revoke_on_demote FROM role_channel_access WHERE channel_id = ?'
        ).all(parentChannel.id);
        if (parentAccess.length) {
          const insAccess = db.prepare(
            'INSERT OR IGNORE INTO role_channel_access (role_id, channel_id, grant_on_promote, revoke_on_demote) VALUES (?, ?, ?, ?)'
          );
          const insMemberRole = db.prepare(
            'INSERT OR IGNORE INTO channel_members (channel_id, user_id) VALUES (?, ?)'
          );
          parentAccess.forEach(a => {
            insAccess.run(a.role_id, result.lastInsertRowid, a.grant_on_promote, a.revoke_on_demote);
            // Mirror channel membership for current role holders if the role
            // is configured to grant access on promote. Private sub-channels
            // also receive role-based members so the role still works there.
            if (a.grant_on_promote) {
              const holders = db.prepare('SELECT DISTINCT user_id FROM user_roles WHERE role_id = ?').all(a.role_id);
              holders.forEach(h => insMemberRole.run(result.lastInsertRowid, h.user_id));
            }
          });
        }
      } catch (rcaErr) {
        console.error('Sub-channel role inheritance error:', rcaErr);
      }

      broadcastChannelLists();
    } catch (err) {
      console.error('Create sub-channel error:', err);
      socket.emit('error-msg', 'Failed to create sub-channel');
    }
  });

  socket.on('delete-sub-channel', async (data) => {
    if (!data || typeof data !== 'object') return;
    const code = typeof data.code === 'string' ? data.code.trim() : '';
    if (!code || !/^[a-f0-9]{8}$/i.test(code)) return;

    const channel = db.prepare('SELECT * FROM channels WHERE code = ?').get(code);
    if (!channel || !channel.parent_channel_id) {
      return socket.emit('error-msg', 'Sub-channel not found');
    }

    // Deleting a sub-channel destroys its history, so create_channel alone is
    // not enough: it takes delete_channel or managing that parent's
    // sub-channels, and you have to be in the sub-channel you delete (a
    // private one you cannot see is not yours to remove).
    const _canDeleteSub = socket.user.isAdmin || (
      !!db.prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?').get(channel.id, socket.user.id) &&
      (userHasPermission(socket.user.id, 'delete_channel', channel.id) ||
       userHasPermission(socket.user.id, 'manage_sub_channels', channel.parent_channel_id))
    );
    if (!_canDeleteSub) {
      return socket.emit('error-msg', 'You don\'t have permission to delete sub-channels');
    }
    if (protectedMessages.protectedCount(db, [channel.id])) return socket.emit('error-msg', protectedMessages.CHANNEL_REFUSAL);

    // Its files go with it, as with delete-channel (#5783).
    let doomedUploads = new Map();
    try {
      doomedUploads = channelUploadsByAuthor(db, [channel.id]);
    } catch (err) {
      // Never block the delete; the sub-channel's files just stay in uploads/.
      console.warn('delete-sub-channel attachment scan failed:', err.message);
    }

    try {
      db.prepare('DELETE FROM reactions WHERE message_id IN (SELECT id FROM messages WHERE channel_id = ?)').run(channel.id);
      db.prepare('DELETE FROM pinned_messages WHERE channel_id = ?').run(channel.id);
      db.prepare('DELETE FROM messages WHERE channel_id = ?').run(channel.id);
      db.prepare('DELETE FROM channel_members WHERE channel_id = ?').run(channel.id);
      db.prepare('DELETE FROM channels WHERE id = ?').run(channel.id);
      await releaseChannelUploads(db, doomedUploads, 'delete-sub-channel');
      botAudioManager?.stopChannel(code, 'channel-deleted');
      io.to(`channel:${code}`).to(`voice:${code}`).emit('channel-deleted', { code });
      clearChannelRuntimeState(state, code);
      broadcastChannelLists();
      socket.emit('error-msg', 'Sub-channel deleted');
      _audit({ actor: socket.user, action: 'channel_delete',
        target_type: 'channel', target_id: channel.id, target_name: channel.name,
        details: { code, sub_channel: true } });
    } catch (err) {
      console.error('Delete sub-channel error:', err);
      socket.emit('error-msg', 'Failed to delete sub-channel');
    }
  });

  // ── Channel feature toggles ─────────────────────────────
  // Forum tags: the list a forum's topics pick from. JSON array of
  // { name, emoji } kept on the channel row; topics store the names they use.
  socket.on('set-forum-tags', (data) => {
    if (!data || typeof data !== 'object') return;
    const code = typeof data.code === 'string' ? data.code.trim() : '';
    if (!code || !/^[a-f0-9]{8}$/i.test(code)) return;
    const channel = db.prepare('SELECT id, is_dm FROM channels WHERE code = ?').get(code);
    if (!channel || channel.is_dm) return socket.emit('error-msg', 'Channel not found');
    if (!_canManageSettingsOf(channel.id)) return socket.emit('error-msg', 'You don\'t have permission to edit forum tags');
    const raw = Array.isArray(data.tags) ? data.tags : [];
    const seen = new Set();
    const tags = [];
    for (const t of raw) {
      const name = String(typeof t === 'string' ? t : (t && t.name) || '').trim().slice(0, 30);
      const emoji = typeof t === 'object' && t && typeof t.emoji === 'string' ? t.emoji.trim().slice(0, 8) : '';
      if (!name || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      tags.push(emoji ? { name, emoji } : { name });
      if (tags.length >= 20) break;
    }
    try {
      db.prepare('UPDATE channels SET forum_tags = ? WHERE id = ?').run(tags.length ? JSON.stringify(tags) : null, channel.id);
      broadcastChannelLists();
      io.to(`channel:${code}`).emit('forum-tags-updated', { code, tags });
      auditChannel(channel.id, 'forum_tags', tags.map(t => t.name));
    } catch (err) {
      console.error('set-forum-tags error:', err);
      socket.emit('error-msg', 'Failed to save forum tags');
    }
  });

  // The layout a forum opens in for everyone: list, gallery or feed, plus
  // the tile size. A reader's own pick, made after this was set, still wins
  // on their browser (#5656).
  socket.on('set-forum-layout', (data, callback) => {
    const cb = typeof callback === 'function' ? callback : () => {};
    if (!data || typeof data !== 'object') return;
    const code = typeof data.code === 'string' ? data.code.trim() : '';
    if (!code || !/^[a-f0-9]{8}$/i.test(code)) return cb({ error: 'Invalid channel' });
    const channel = db.prepare('SELECT id, is_dm FROM channels WHERE code = ?').get(code);
    if (!channel || channel.is_dm) return cb({ error: 'Channel not found' });
    if (!_canManageSettingsOf(channel.id)) return cb({ error: 'You don\'t have permission to set the forum layout' });
    const view = ['list', 'gallery', 'feed'].includes(data.view) ? data.view : 'list';
    const tileN = Number(data.tile);
    const tile = Number.isFinite(tileN) ? Math.min(28, Math.max(7, Math.round(tileN * 2) / 2)) : 11;
    const shapes = ['square', 'square-fit', '4:3', '3:4', '3:2', '2:3', '16:9', '9:16'];
    const shape = shapes.includes(data.shape) ? data.shape : 'square';
    // Locked: only people who can change the channel's settings may switch
    // the view or shape; the size slider stays for everyone (#5656).
    const layout = { view, tile, shape, locked: !!data.locked, at: Date.now() };
    try {
      db.prepare('UPDATE channels SET forum_layout = ? WHERE id = ?').run(JSON.stringify(layout), channel.id);
      broadcastChannelLists();
      io.to(`channel:${code}`).emit('forum-layout-updated', { code, layout });
      auditChannel(channel.id, 'forum_layout', layout.locked ? `${view} (locked)` : view);
      cb({ success: true, layout });
    } catch (err) {
      console.error('set-forum-layout error:', err);
      cb({ error: 'Failed to save the forum layout' });
    }
  });

  socket.on('toggle-channel-permission', (data) => {
    if (!data || typeof data !== 'object') return;
    const code = typeof data.code === 'string' ? data.code.trim() : '';
    if (!code || !/^[a-f0-9]{8}$/i.test(code)) return;

    const permission = typeof data.permission === 'string' ? data.permission.trim() : '';
    const validPerms = ['streams', 'music', 'media', 'voice', 'text', 'read_only', 'soundboard', 'forum', 'private', 'nsfw', 'reactions', 'forum_blog', 'forum_blog_pics_only'];
    if (!validPerms.includes(permission)) return socket.emit('error-msg', 'Invalid permission');

    const channel = db.prepare('SELECT * FROM channels WHERE code = ? AND is_dm = 0').get(code);
    if (!channel) return socket.emit('error-msg', 'Channel not found');
    if (!_canManageSettingsOf(channel.id)) return socket.emit('error-msg', 'You don\'t have permission to toggle channel permissions');

    const colMap = { streams: 'streams_enabled', music: 'music_enabled', media: 'media_enabled', voice: 'voice_enabled', text: 'text_enabled', read_only: 'read_only', soundboard: 'soundboard_enabled', forum: 'is_forum', private: 'is_private', nsfw: 'is_nsfw', reactions: 'reactions_enabled', forum_blog: 'forum_blog', forum_blog_pics_only: 'forum_blog_pics_only' };
    const colName = colMap[permission];
    const current = channel[colName];
    const newVal = current ? 0 : 1;

    if ((permission === 'streams' || permission === 'music') && newVal === 1 && channel.voice_enabled === 0) {
      return socket.emit('error-msg', 'Enable voice first: streams and music require voice');
    }

    try {
      db.prepare(`UPDATE channels SET ${colName} = ? WHERE id = ?`).run(newVal, channel.id);
      // Changing a function by hand takes the channel out of its type
      // (src/channelTypes.js), so the type's icon stops showing for it.
      if (channel.type_id && channelTypes.FUNCTIONS.includes(permission)) {
        db.prepare('UPDATE channels SET type_id = NULL WHERE id = ?').run(channel.id);
      }
      // Going private keeps everyone who is already in (#5563), but anyone
      // else who still has the room open on a socket is shown the door now
      // rather than on their next reconnect.
      if (permission === 'private' && newVal === 1) {
        const isMember = db.prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?');
        for (const [, s] of io.sockets.sockets) {
          if (!s.user || s.user.isAdmin) continue;
          if (!isMember.get(channel.id, s.user.id)) ctx.liveAccess?.cutOff(s.user.id, [channel.code], 'This channel is private now');
        }
      }
      if (permission === 'voice' && newVal === 0) {
        botAudioManager?.stopChannel(code, 'voice-disabled');
        db.prepare('UPDATE channels SET streams_enabled = 0, music_enabled = 0 WHERE id = ?').run(channel.id);
        const room = voiceUsers.get(code);
        if (room && room.size > 0) {
          for (const entry of Array.from(room.values())) {
            const targetSocket = io.sockets.sockets.get(entry.socketId);
            if (!targetSocket) continue;
            // Force clients out of voice immediately so they don't keep
            // reconnecting to a channel that no longer permits voice.
            targetSocket.emit('voice-channel-gone', { code });
            handleVoiceLeave(targetSocket, code);
          }
          broadcastVoiceUsers(code);
        }
      }

      const labelMap = { streams: 'Screen sharing', music: 'Music sharing', media: 'Media uploads', voice: 'Voice chat', text: 'Text chat', read_only: 'Read-only mode', soundboard: 'Soundboard', forum: 'Forum mode', private: 'Private', nsfw: 'NSFW', reactions: 'Reactions', forum_blog: 'Blog mode', forum_blog_pics_only: 'Comments on pictures only' };
      broadcastChannelLists();
      io.to(`channel:${code}`).emit('channel-permission-updated', { code, permission, enabled: !!newVal });
      auditChannel(channel.id, permission, !!newVal);
      socket.emit('toast', { message: `${labelMap[permission]} ${newVal ? 'enabled' : 'disabled'} for this channel`, type: 'success' });
    } catch (err) {
      console.error('Toggle permission error:', err);
      socket.emit('error-msg', 'Failed to toggle permission');
    }
  });

  socket.on('toggle-cleanup-exempt', (data) => {
    if (!data || typeof data !== 'object') return;
    if (!socket.user.isAdmin) return socket.emit('error-msg', 'Only admins can change cleanup exemptions');
    const code = typeof data.code === 'string' ? data.code.trim() : '';
    if (!code || !/^[a-f0-9]{8}$/i.test(code)) return;
    const channel = db.prepare('SELECT * FROM channels WHERE code = ? AND is_dm = 0').get(code);
    if (!channel) return socket.emit('error-msg', 'Channel not found');
    const newVal = channel.cleanup_exempt ? 0 : 1;
    try {
      db.prepare('UPDATE channels SET cleanup_exempt = ? WHERE id = ?').run(newVal, channel.id);
      auditChannel(channel.id, 'cleanup_exempt', !!newVal);
      broadcastChannelLists();
      socket.emit('toast', { message: newVal ? '🛡️ Channel exempt from auto-cleanup' : 'Cleanup protection removed', type: 'success' });
    } catch (err) {
      console.error('Toggle cleanup exempt error:', err);
      socket.emit('error-msg', 'Failed to toggle cleanup exemption');
    }
  });

  socket.on('toggle-welcome-channel', (data) => {
    if (!data || typeof data !== 'object') return;
    if (!socket.user.isAdmin) return socket.emit('error-msg', 'Only admins can change welcome message settings');
    const code = typeof data.code === 'string' ? data.code.trim() : '';
    if (!code || !/^[a-f0-9]{8}$/i.test(code)) return;
    const channel = db.prepare('SELECT * FROM channels WHERE code = ? AND is_dm = 0').get(code);
    if (!channel) return socket.emit('error-msg', 'Channel not found');
    const newVal = channel.show_welcome ? 0 : 1;
    try {
      db.prepare('UPDATE channels SET show_welcome = ? WHERE id = ?').run(newVal, channel.id);
      auditChannel(channel.id, 'welcome_messages', !!newVal);
      broadcastChannelLists();
      socket.emit('toast', { message: newVal ? '👋 New-member welcome messages will post in this channel' : 'Welcome messages disabled for this channel', type: 'success' });
    } catch (err) {
      console.error('Toggle welcome channel error:', err);
      socket.emit('error-msg', 'Failed to toggle welcome messages');
    }
  });

  socket.on('set-slow-mode', (data) => {
    if (!data || typeof data !== 'object') return;
    const code = typeof data.code === 'string' ? data.code.trim() : '';
    if (!code || !/^[a-f0-9]{8}$/i.test(code)) return;
    const interval = parseInt(data.interval);
    if (isNaN(interval) || interval < 0 || interval > 3600) {
      return socket.emit('error-msg', 'Slow mode interval must be 0-3600 seconds');
    }
    const channel = db.prepare('SELECT id FROM channels WHERE code = ? AND is_dm = 0').get(code);
    if (!channel) return socket.emit('error-msg', 'Channel not found');
    if (!_canManageSettingsOf(channel.id)) return socket.emit('error-msg', 'You don\'t have permission to set slow mode');
    try {
      db.prepare('UPDATE channels SET slow_mode_interval = ? WHERE id = ?').run(interval, channel.id);
      auditChannel(channel.id, 'slow_mode_seconds', interval);
      broadcastChannelLists();
      io.to(`channel:${code}`).emit('slow-mode-updated', { code, interval });
      socket.emit('toast', { message: interval > 0 ? `Slow mode set to ${interval}s` : 'Slow mode disabled', type: 'success' });
    } catch (err) {
      console.error('Set slow mode error:', err);
      socket.emit('error-msg', 'Failed to set slow mode');
    }
  });

  // (#5389) Per-channel default role. Setting it auto-grants the role
  // (channel-scoped) to every existing member and every future joiner.
  // Clearing it (roleId = null/0) leaves existing grants alone; admins can
  // revoke from the Roles UI if they want to strip them.
  socket.on('set-channel-default-role', (data) => {
    if (!data || typeof data !== 'object') return;
    if (!socket.user.isAdmin && !userHasPermission(socket.user.id, 'manage_roles')) {
      return socket.emit('error-msg', 'You don\'t have permission to set a default role');
    }
    const code = typeof data.code === 'string' ? data.code.trim() : '';
    if (!code || !/^[a-f0-9]{8}$/i.test(code)) return;
    const channel = db.prepare('SELECT id FROM channels WHERE code = ? AND is_dm = 0').get(code);
    if (!channel) return socket.emit('error-msg', 'Channel not found');

    let roleId = null;
    if (data.roleId !== null && data.roleId !== undefined && data.roleId !== 0 && data.roleId !== '') {
      const parsed = parseInt(data.roleId, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return socket.emit('error-msg', 'Invalid role');
      }
      const role = db.prepare('SELECT id, name, level FROM roles WHERE id = ?').get(parsed);
      if (!role) return socket.emit('error-msg', 'Role not found');
      // A default role is handed to every member of the channel, the person
      // setting it included, so it follows the same line as assigning a role:
      // only roles below your own level, and only in a channel you are in.
      if (!socket.user.isAdmin) {
        const myLevel = getUserEffectiveLevel(socket.user.id);
        if (role.level >= myLevel) return socket.emit('error-msg', `You can only use roles below your level (${myLevel})`);
        if (!db.prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?').get(channel.id, socket.user.id)) {
          return socket.emit('error-msg', 'Channel not found');
        }
        // Everyone in the channel gets it, the setter too, so it may carry
        // nothing the setter could not hand out themselves.
        const refusal = typeof ctx.roleGrantRefusal === 'function' ? ctx.roleGrantRefusal(role.id) : 'Roles are not ready yet';
        if (refusal) return socket.emit('error-msg', refusal);
      }
      roleId = role.id;
    }

    try {
      db.prepare('UPDATE channels SET default_role_id = ? WHERE id = ?').run(roleId, channel.id);

      if (roleId) {
        // Backfill: grant the new default to every current member of this
        // channel. INSERT OR IGNORE protects against duplicates if any
        // member already holds the role channel-scoped.
        const members = db.prepare('SELECT user_id FROM channel_members WHERE channel_id = ?').all(channel.id);
        const insertRole = db.prepare(
          'INSERT OR IGNORE INTO user_roles (user_id, role_id, channel_id, granted_by) VALUES (?, ?, ?, ?)'
        );
        const txn = db.transaction(() => {
          for (const m of members) insertRole.run(m.user_id, roleId, channel.id, socket.user.id);
        });
        txn();
        if (typeof applyRoleChannelAccess === 'function') {
          let accessErr = null;
          for (const m of members) {
            try { applyRoleChannelAccess(roleId, m.user_id, 'grant'); } catch (err) { accessErr = accessErr || err; }
          }
          // One line per backfill, not per member: the role landed but some
          // members may be missing its linked channels.
          if (accessErr) console.warn('default role channel access backfill failed:', accessErr.message);
        }
      }

      broadcastChannelLists();
      io.to(`channel:${code}`).emit('channel-default-role-updated', { code, roleId });
      socket.emit('toast', { message: roleId ? 'Default role set' : 'Default role cleared', type: 'success' });
      _audit({ actor: socket.user, action: 'channel_default_role_set',
        target_type: 'channel', target_id: channel.id, details: { code, roleId } });
    } catch (err) {
      console.error('Set default role error:', err);
      socket.emit('error-msg', 'Failed to set default role');
    }
  });

  socket.on('set-sort-alphabetical', (data) => {
    if (!data || typeof data !== 'object') return;
    const code = typeof data.code === 'string' ? data.code.trim() : '';
    if (!code || !/^[a-f0-9]{8}$/i.test(code)) return;
    let sortVal = 0;
    if (data.mode === 'alpha' || data.enabled === true) sortVal = 1;
    else if (data.mode === 'created') sortVal = 2;
    else if (data.mode === 'oldest') sortVal = 3;
    else if (data.mode === 'dynamic') sortVal = 4;
    const channel = db.prepare('SELECT id FROM channels WHERE code = ? AND is_dm = 0').get(code);
    if (!channel) return socket.emit('error-msg', 'Channel not found');
    if (!_canManageSettingsOf(channel.id)) return socket.emit('error-msg', 'You don\'t have permission to change sort settings');
    try {
      db.prepare('UPDATE channels SET sort_alphabetical = ? WHERE id = ?').run(sortVal, channel.id);
      broadcastChannelLists();
    } catch (err) {
      console.error('Set sort mode error:', err);
      socket.emit('error-msg', 'Failed to update sort setting');
    }
  });

  socket.on('set-voice-user-limit', (data) => {
    if (!data || typeof data !== 'object') return;
    const code = typeof data.code === 'string' ? data.code.trim() : '';
    if (!code || !/^[a-f0-9]{8}$/i.test(code)) return;
    const limit = typeof data.limit === 'number' ? data.limit : parseInt(data.limit);
    if (isNaN(limit) || limit < 0 || limit > 99) {
      return socket.emit('error-msg', 'Voice user limit must be 0 (unlimited) or 2 to 99');
    }
    const normalizedLimit = (limit === 1) ? 0 : limit;
    const channel = db.prepare('SELECT id FROM channels WHERE code = ? AND is_dm = 0').get(code);
    if (!channel) return socket.emit('error-msg', 'Channel not found');
    if (!_canManageSettingsOf(channel.id)) {
      return socket.emit('error-msg', 'You don\'t have permission to change the voice user limit');
    }
    try {
      db.prepare('UPDATE channels SET voice_user_limit = ? WHERE id = ?').run(normalizedLimit, channel.id);
      auditChannel(channel.id, 'voice_user_limit', normalizedLimit);
      broadcastChannelLists();
      socket.emit('toast', { message: normalizedLimit >= 2 ? `👥 Voice limit set to ${normalizedLimit}` : '👥 Voice user limit removed', type: 'success' });
    } catch (err) {
      console.error('Set voice user limit error:', err);
      socket.emit('error-msg', 'Failed to set voice user limit');
    }
  });

  socket.on('set-voice-bitrate', (data) => {
    if (!data || typeof data !== 'object') return;
    const code = typeof data.code === 'string' ? data.code.trim() : '';
    if (!code || !/^[a-f0-9]{8}$/i.test(code)) return;
    const bitrate = typeof data.bitrate === 'number' ? data.bitrate : parseInt(data.bitrate);
    const validBitrates = [0, 32, 64, 96, 128, 256, 512];
    if (!validBitrates.includes(bitrate)) {
      return socket.emit('error-msg', 'Invalid bitrate value');
    }
    const channel = db.prepare('SELECT id FROM channels WHERE code = ? AND is_dm = 0').get(code);
    if (!channel) return socket.emit('error-msg', 'Channel not found');
    if (!_canManageSettingsOf(channel.id)) {
      return socket.emit('error-msg', 'You don\'t have permission to change voice bitrate');
    }
    try {
      db.prepare('UPDATE channels SET voice_bitrate = ? WHERE id = ?').run(bitrate, channel.id);
      auditChannel(channel.id, 'voice_bitrate', bitrate);
      broadcastChannelLists();
      io.to(`voice:${code}`).emit('voice-bitrate-updated', { code, bitrate });
      socket.emit('toast', { message: bitrate > 0 ? `🎙️ Voice bitrate set to ${bitrate} kbps` : '🎙️ Voice bitrate set to auto', type: 'success' });
    } catch (err) {
      console.error('Set voice bitrate error:', err);
      socket.emit('error-msg', 'Failed to set voice bitrate');
    }
  });

  socket.on('set-channel-expiry', (data) => {
    if (!data || typeof data !== 'object') return;
    const code = typeof data.code === 'string' ? data.code.trim() : '';
    if (!code || !/^[a-f0-9]{8}$/i.test(code)) return;
    const channel = db.prepare('SELECT id FROM channels WHERE code = ? AND is_dm = 0').get(code);
    if (!channel) return socket.emit('error-msg', 'Channel not found');
    if (!_canManageSettingsOf(channel.id)) {
      return socket.emit('error-msg', 'You don\'t have permission to set self-destruct timers');
    }
    // (#5390) second mode: 'clear' wipes messages periodically instead of
    // deleting the whole channel. Anything other than 'clear' is treated
    // as the legacy 'delete' behaviour so unknown values fail closed
    // toward the original semantics.
    const mode = data.mode === 'clear' ? 'clear' : 'delete';
    // A timer that deletes the channel is deleting it: it takes the delete
    // permission, and a channel exempt from cleanup is the admin's to time.
    if (data.hours && data.hours > 0 && mode === 'delete' && !socket.user.isAdmin) {
      if (!userHasPermission(socket.user.id, 'delete_channel', channel.id)) return socket.emit('error-msg', 'You don\'t have permission to delete this channel');
      if (db.prepare('SELECT cleanup_exempt FROM channels WHERE id = ?').get(channel.id)?.cleanup_exempt) {
        return socket.emit('error-msg', 'This channel is exempt from cleanup. Only the admin can set a deletion timer on it.');
      }
    }
    let expiresAt = null;
    let intervalHours = null;
    if (data.hours && data.hours > 0) {
      const hours = Math.max(1, Math.min(720, parseInt(data.hours, 10)));
      if (isNaN(hours)) return socket.emit('error-msg', 'Invalid duration');
      expiresAt = new Date(Date.now() + hours * 3600000).toISOString();
      intervalHours = hours;
    }
    try {
      db.prepare(
        'UPDATE channels SET expires_at = ?, auto_delete_mode = ?, auto_delete_interval_hours = ? WHERE id = ?'
      ).run(expiresAt, mode, intervalHours, channel.id);
      auditChannel(channel.id, 'self_destruct', expiresAt ? `${mode} at ${expiresAt}` : 'off');
      broadcastChannelLists();
      if (expiresAt) {
        const hours = Math.round((new Date(expiresAt) - Date.now()) / 3600000);
        const verb = mode === 'clear' ? `clear messages every ${hours}h` : `self-destruct in ${hours}h`;
        socket.emit('toast', { message: `⏱️ Channel will ${verb}`, type: 'success' });
      } else {
        socket.emit('toast', { message: '⏱️ Self-destruct timer removed', type: 'success' });
      }
    } catch (err) {
      console.error('Set channel expiry error:', err);
      socket.emit('error-msg', 'Failed to set self-destruct timer');
    }
  });

  // ── Role gate: who may open this channel, on top of membership ──
  socket.on('set-channel-role-gate', (data, callback) => {
    const cb = typeof callback === 'function' ? callback : () => {};
    if (!data || typeof data !== 'object') return;
    const code = typeof data.code === 'string' ? data.code.trim() : '';
    if (!code || !/^[a-f0-9]{8}$/i.test(code)) return;
    const channel = db.prepare('SELECT id, code FROM channels WHERE code = ? AND is_dm = 0').get(code);
    if (!channel) return cb({ error: 'Channel not found' });
    if (!_canManageSettingsOf(channel.id)) return cb({ error: 'You don\'t have permission to change who can open this channel' });
    // A gate makes everyone who passes it a member. On a private channel that
    // is inviting people in, which is the admin's call.
    if (!socket.user.isAdmin && db.prepare('SELECT is_private FROM channels WHERE id = ?').get(channel.id)?.is_private) {
      return cb({ error: 'Only the admin can change who can open a private channel' });
    }
    const gate = ctx.parseRoleGate({ mode: data.mode, roles: Array.isArray(data.roles) ? data.roles.slice(0, 50) : [] });
    if (gate) {
      const ph = gate.roles.map(() => '?').join(',');
      const known = new Set(db.prepare(`SELECT id FROM roles WHERE id IN (${ph})`).all(...gate.roles).map(r => r.id));
      gate.roles = gate.roles.filter(id => known.has(id));
    }
    const stored = gate && gate.roles.length ? JSON.stringify(gate) : null;
    try {
      db.prepare('UPDATE channels SET role_gate = ? WHERE id = ?').run(stored, channel.id);
    } catch (err) {
      console.error('Set role gate error:', err);
      return cb({ error: 'Failed to save the role gate' });
    }
    // Holding the required roles is membership (#5649): everyone who passes
    // the gate is put in the channel, and rows the gate added come out for
    // anyone who no longer passes. Removing the gate keeps whoever it let in.
    if (!stored) {
      db.prepare('UPDATE channel_members SET via_role_gate = 0 WHERE channel_id = ?').run(channel.id);
    }
    let changes = [];
    try { changes = ctx.syncRoleGateMemberships({ channelId: channel.id }); } catch (err) { console.error('role gate membership sync failed:', err.message); }
    const joined = new Set(changes.filter(c => c.joined).map(c => c.userId));
    // Anyone who no longer qualifies leaves the room now; broadcastChannelLists
    // rebuilds every list, so their sidebar entry goes with it.
    const fresh = db.prepare('SELECT id, role_gate FROM channels WHERE id = ?').get(channel.id);
    for (const [, s] of io.sockets.sockets) {
      if (!s.user || s.user.isAdmin) continue;
      if (joined.has(s.user.id)) s.join(`channel:${channel.code}`);
      else if (stored && !ctx.roleGateAllows(s.user.id, fresh)) ctx.liveAccess?.cutOff(s.user.id, [channel.code], 'This channel needs a role you do not hold');
    }
    broadcastChannelLists();
    // The member list follows the requirement too (#5703).
    emitOnlineUsers(channel.code);
    io.to(`channel:${code}`).emit('channel-role-gate-updated', { code, roleGate: stored ? JSON.parse(stored) : null });
    cb({ success: true, roleGate: stored ? JSON.parse(stored) : null });
    _audit({ actor: socket.user, action: 'channel_role_gate',
      target_type: 'channel', target_id: channel.id, target_name: code,
      details: { roleGate: stored ? JSON.parse(stored) : null } });
  });

  socket.on('set-notification-type', (data) => {
    if (!data || typeof data !== 'object') return;
    const code = typeof data.code === 'string' ? data.code.trim() : '';
    if (!code || !/^[a-f0-9]{8}$/i.test(code)) return;
    const type = typeof data.type === 'string' ? data.type : '';
    if (!['default', 'announcement'].includes(type)) return socket.emit('error-msg', 'Invalid notification type');
    const channel = db.prepare('SELECT id FROM channels WHERE code = ? AND is_dm = 0').get(code);
    if (!channel) return socket.emit('error-msg', 'Channel not found');
    if (!_canManageSettingsOf(channel.id)) {
      return socket.emit('error-msg', 'You don\'t have permission to change channel notification type');
    }
    try {
      db.prepare('UPDATE channels SET notification_type = ? WHERE id = ?').run(type, channel.id);
      auditChannel(channel.id, 'notification_type', type);
      broadcastChannelLists();
      const labels = { default: '🔔 Channel notifications reset to default', announcement: '📢 Channel set to announcement mode' };
      socket.emit('toast', { message: labels[type], type: 'success' });
    } catch (err) {
      console.error('Set notification type error:', err);
      socket.emit('error-msg', 'Failed to set notification type');
    }
  });

  socket.on('set-channel-afk', (data) => {
    if (!data || typeof data !== 'object') return;
    const code = typeof data.code === 'string' ? data.code.trim() : '';
    if (!code || !/^[a-f0-9]{8}$/i.test(code)) return;
    const subCode = typeof data.subCode === 'string' ? data.subCode.trim() : '';
    const timeout = parseInt(data.timeout);
    if (!Number.isFinite(timeout) || timeout < 0 || timeout > 1440) return;
    const channel = db.prepare('SELECT id FROM channels WHERE code = ? AND is_dm = 0 AND parent_channel_id IS NULL').get(code);
    if (!channel) return socket.emit('error-msg', 'Channel not found or is a sub-channel');
    if (!_canManageSettingsOf(channel.id)) {
      return socket.emit('error-msg', 'You don\'t have permission to change AFK settings');
    }
    // '__leave__' disconnects idle people from voice instead of moving them
    // (#5801): it needs no sub-channel, and it frees the connection.
    if (subCode && subCode !== '__leave__') {
      if (!/^[a-f0-9]{8}$/i.test(subCode)) return;
      const sub = db.prepare('SELECT id FROM channels WHERE code = ? AND parent_channel_id = ?').get(subCode, channel.id);
      if (!sub) return socket.emit('error-msg', 'Sub-channel not found or does not belong to this channel');
    }
    try {
      db.prepare('UPDATE channels SET afk_sub_code = ?, afk_timeout_minutes = ? WHERE id = ?')
        .run(subCode || null, timeout, channel.id);
      auditChannel(channel.id, 'afk', subCode ? `${timeout} min` : 'off');
      broadcastChannelLists();
      if (subCode === '__leave__' && timeout > 0) {
        socket.emit('toast', { message: `💤 Idle people leave voice after ${timeout} min`, type: 'success' });
      } else if (subCode && timeout > 0) {
        socket.emit('toast', { message: `💤 AFK sub-channel set (${timeout}min timeout)`, type: 'success' });
      } else {
        socket.emit('toast', { message: '💤 AFK sub-channel disabled', type: 'success' });
      }
    } catch (err) {
      console.error('Set channel AFK error:', err);
      socket.emit('error-msg', 'Failed to set AFK settings');
    }
  });

  // ── Channel reordering ──────────────────────────────────
  socket.on('reorder-channels', (data) => {
    if (!data || typeof data !== 'object') return;
    const order = data.order;
    if (!Array.isArray(order) || order.length > 500) return;
    // (#5424) If every channel in this reorder is a sub-channel under one
    // parent, manage_sub_channels on that parent is enough. A top-level (or
    // mixed-parent) reorder still requires create_channel.
    let _reorderParent = null;
    try {
      const codes = order.map(it => (it && typeof it.code === 'string') ? it.code : null).filter(Boolean);
      if (codes.length) {
        const ph = codes.map(() => '?').join(',');
        const rows = db.prepare(`SELECT parent_channel_id FROM channels WHERE code IN (${ph}) AND is_dm = 0`).all(...codes);
        const parents = new Set(rows.map(r => r.parent_channel_id));
        if (parents.size === 1) _reorderParent = [...parents][0];
      }
    } catch { /* fall through to the stricter create_channel check, so this fails closed */ }
    if (!_canManageSubsOf(_reorderParent)) return socket.emit('error-msg', 'You don\'t have permission to reorder channels');
    try {
      const update = db.prepare('UPDATE channels SET position = ? WHERE code = ?');
      const txn = db.transaction(() => {
        for (const item of order) {
          if (typeof item.code === 'string' && typeof item.position === 'number') {
            update.run(item.position, item.code);
          }
        }
      });
      txn();
      broadcastChannelLists();
    } catch (err) {
      console.error('Reorder channels error:', err);
      socket.emit('error-msg', 'Failed to reorder channels');
    }
  });

  socket.on('move-channel', (data) => {
    if (!data || typeof data !== 'object') return;
    const code = typeof data.code === 'string' ? data.code.trim() : '';
    if (!code || !/^[a-f0-9]{8}$/i.test(code)) return;
    const direction = data.direction;
    if (direction !== 'up' && direction !== 'down') return;
    const channel = db.prepare('SELECT * FROM channels WHERE code = ? AND is_dm = 0').get(code);
    if (!channel) return;
    if (!_canManageSubsOf(channel.parent_channel_id)) return socket.emit('error-msg', 'You don\'t have permission to reorder channels'); // (#5424)
    try {
      const parentId = channel.parent_channel_id;
      let siblings;
      if (parentId) {
        siblings = db.prepare('SELECT id, code, position FROM channels WHERE parent_channel_id = ? ORDER BY position').all(parentId);
      } else {
        siblings = db.prepare('SELECT id, code, position FROM channels WHERE parent_channel_id IS NULL AND is_dm = 0 ORDER BY position').all();
      }
      const idx = siblings.findIndex(s => s.code === code);
      if (idx < 0) return;
      const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
      if (swapIdx < 0 || swapIdx >= siblings.length) return;
      const myPos = siblings[idx].position;
      const theirPos = siblings[swapIdx].position;
      if (myPos === theirPos) {
        const update = db.prepare('UPDATE channels SET position = ? WHERE id = ?');
        siblings.forEach((s, i) => update.run(i, s.id));
        return socket.emit('get-channels');
      }
      db.prepare('UPDATE channels SET position = ? WHERE id = ?').run(theirPos, siblings[idx].id);
      db.prepare('UPDATE channels SET position = ? WHERE id = ?').run(myPos, siblings[swapIdx].id);
      broadcastChannelLists();
    } catch (err) {
      console.error('Move channel error:', err);
      socket.emit('error-msg', 'Failed to move channel');
    }
  });

  // ── Channel reparenting ─────────────────────────────────
  socket.on('reparent-channel', (data) => {
    if (!data || typeof data !== 'object') return;
    const code = typeof data.code === 'string' ? data.code.trim() : '';
    if (!code || !/^[a-f0-9]{8}$/i.test(code)) return;
    const newParentCode = data.newParentCode;
    const channel = db.prepare('SELECT * FROM channels WHERE code = ? AND is_dm = 0').get(code);
    if (!channel) return socket.emit('error-msg', 'Channel not found');
    // (#5424) Promoting a sub to top-level, or demoting a top-level channel,
    // changes server structure -> create_channel. Re-nesting an existing
    // sub-channel under a parent is sub-channel management.
    const _promoting = (newParentCode === null || newParentCode === undefined);
    if (_promoting || !channel.parent_channel_id) {
      if (!socket.user.isAdmin && !userHasPermission(socket.user.id, 'create_channel')) return socket.emit('error-msg', 'You don\'t have permission to move channels');
    }
    try {
      if (newParentCode === null || newParentCode === undefined) {
        if (!channel.parent_channel_id) return socket.emit('error-msg', 'Channel is already top-level');
        if (!_canManageSubsScoped(channel.parent_channel_id)) {
          return socket.emit('error-msg', 'You don\'t have permission to promote this channel');
        }
        const maxPos = db.prepare('SELECT MAX(position) as mp FROM channels WHERE parent_channel_id IS NULL AND is_dm = 0').get();
        const position = (maxPos && maxPos.mp != null) ? maxPos.mp + 1 : 0;
        db.prepare('UPDATE channels SET parent_channel_id = NULL, position = ?, category = NULL WHERE id = ?').run(position, channel.id);
        broadcastChannelLists();
        socket.emit('error-msg', `"${channel.name}" promoted to top-level channel`);
      } else {
        const parentCode = typeof newParentCode === 'string' ? newParentCode.trim() : '';
        if (!parentCode || !/^[a-f0-9]{8}$/i.test(parentCode)) return;
        const newParent = db.prepare('SELECT * FROM channels WHERE code = ? AND is_dm = 0').get(parentCode);
        if (!newParent) return socket.emit('error-msg', 'Target parent not found');
        if (newParent.parent_channel_id) return socket.emit('error-msg', 'Cannot nest channels more than one level deep');
        if (channel.id === newParent.id) return socket.emit('error-msg', 'Cannot move a channel under itself');
        const subCount = db.prepare('SELECT COUNT(*) as cnt FROM channels WHERE parent_channel_id = ?').get(channel.id);
        if (subCount && subCount.cnt > 0) return socket.emit('error-msg', 'Cannot make a channel with sub-channels into a sub-channel. Move or remove its sub-channels first.');
        if (channel.parent_channel_id === newParent.id) return socket.emit('error-msg', 'Channel is already under that parent');
        // (#5492) Both ends, because a move takes a child away from one parent
        // and gives it to another, and each of those is that parent's business.
        // Authority is channel-scoped only: server-wide create_channel does not
        // let you nest under a parent you don't manage, which was the bypass.
        // A top-level source is null and passes freely (see _canManageSubsScoped),
        // so pulling an existing channel into a parent you manage still works.
        if (!_canManageSubsScoped(newParent.id) || !_canManageSubsScoped(channel.parent_channel_id)) {
          return socket.emit('error-msg', 'You don\'t have permission to move channels');
        }
        // A top-level channel moved under a parent becomes one that parent's
        // sub-channel managers can delete, while deleting a top-level channel
        // is otherwise delete_channel's business (admin-only by default). So
        // pulling one in takes delete_channel on that channel.
        if (!channel.parent_channel_id && !socket.user.isAdmin && !userHasPermission(socket.user.id, 'delete_channel', channel.id)) {
          return socket.emit('error-msg', "You don't have permission to move a top-level channel under another");
        }
        const maxPos = db.prepare('SELECT MAX(position) as mp FROM channels WHERE parent_channel_id = ?').get(newParent.id);
        const position = (maxPos && maxPos.mp != null) ? maxPos.mp + 1 : 0;
        db.prepare('UPDATE channels SET parent_channel_id = ?, position = ?, category = NULL WHERE id = ?').run(newParent.id, position, channel.id);
        broadcastChannelLists();
        socket.emit('error-msg', `"${channel.name}" moved under "${newParent.name}"`);
      }
    } catch (err) {
      console.error('Reparent channel error:', err);
      socket.emit('error-msg', 'Failed to move channel');
    }
  });

  // ── Channel categories ──────────────────────────────────
  socket.on('set-channel-category', (data) => {
    if (!data || typeof data !== 'object') return;
    const code = typeof data.code === 'string' ? data.code.trim() : '';
    if (!code || !/^[a-f0-9]{8}$/i.test(code)) return;
    const channel = db.prepare('SELECT id, parent_channel_id FROM channels WHERE code = ? AND is_dm = 0').get(code);
    if (!channel) return socket.emit('error-msg', 'Channel not found');
    if (!_canManageSubsOf(channel.parent_channel_id)) return socket.emit('error-msg', 'You don\'t have permission to set categories'); // (#5424)
    const category = normalizeCategory(data.category, channel.id);
    try {
      db.prepare('UPDATE channels SET category = ? WHERE id = ?').run(category, channel.id);
      broadcastChannelLists();
      socket.emit('toast', { message: category ? `Category set to "${category}"` : 'Category removed', type: 'success' });
    } catch (err) {
      console.error('Set category error:', err);
      socket.emit('error-msg', 'Failed to set category');
    }
  });

  // ── Channel topics ──────────────────────────────────────
  socket.on('set-channel-topic', (data) => {
    if (!data || typeof data !== 'object') return;
    const code = typeof data.code === 'string' ? data.code.trim() : '';
    if (!code || !/^[a-f0-9]{8}$/i.test(code)) return;
    const channel = db.prepare('SELECT id FROM channels WHERE code = ? AND is_dm = 0').get(code);
    if (!channel) return;
    if (!socket.user.isAdmin && !reachableChannel(ctx, socket.user, channel.id)) return;
    if (!socket.user.isAdmin && !userHasPermission(socket.user.id, 'set_channel_topic', channel.id)) {
      return socket.emit('error-msg', 'You don\'t have permission to set channel topics');
    }
    const { sanitizeText } = require('./helpers');
    const topic = isString(data.topic, 0, 256) ? sanitizeText(data.topic.trim()) : '';
    // A channel topic sits above the message list for everyone in the channel,
    // so it is a link-placement surface like any other. (v3.42.0)
    if (topic && enforceAutomod(topic, { surface: 'channel', channelId: channel.id })) return;
    try {
      db.prepare('UPDATE channels SET topic = ? WHERE id = ?').run(topic, channel.id);
      auditChannel(channel.id, 'topic', topic);
    } catch (err) {
      console.error('Set topic error:', err);
      return socket.emit('error-msg', 'Failed to update topic');
    }
    io.to(`channel:${code}`).emit('channel-topic-changed', { code, topic });
  });

  // ── Channel code settings ───────────────────────────────
  socket.on('update-channel-code-settings', (data) => {
    if (!data || typeof data !== 'object') return;
    const channelId = typeof data.channelId === 'number' ? data.channelId : null;
    if (!channelId) return;
    const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
    if (!channel || channel.is_dm) return;
    if (!_canManageSettingsOf(channel.id)) {
      return socket.emit('error-msg', 'You don\'t have permission to change channel code settings');
    }
    const validVisibility = ['public', 'private'];
    const validMode = ['static', 'dynamic'];
    const validRotationType = ['time', 'joins'];
    const updates = {};
    if (data.code_visibility && validVisibility.includes(data.code_visibility)) updates.code_visibility = data.code_visibility;
    if (data.code_mode && validMode.includes(data.code_mode)) updates.code_mode = data.code_mode;
    if (data.code_rotation_type && validRotationType.includes(data.code_rotation_type)) updates.code_rotation_type = data.code_rotation_type;
    if (data.code_rotation_interval !== undefined) {
      const n = parseInt(data.code_rotation_interval);
      if (!isNaN(n) && n >= 1 && n <= 10000) updates.code_rotation_interval = n;
    }
    if (Object.keys(updates).length === 0) return;
    const setParts = [];
    const values = [];
    for (const [key, val] of Object.entries(updates)) { setParts.push(`${key} = ?`); values.push(val); }
    if (updates.code_mode === 'dynamic') {
      setParts.push('code_rotation_counter = 0');
      setParts.push('code_last_rotated = CURRENT_TIMESTAMP');
    }
    values.push(channelId);
    db.prepare(`UPDATE channels SET ${setParts.join(', ')} WHERE id = ?`).run(...values);
    const updated = db.prepare('SELECT id, code_visibility, code_mode, code_rotation_type, code_rotation_interval FROM channels WHERE id = ?').get(channelId);
    auditChannel(channelId, 'invite_code', `${updated.code_visibility}, ${updated.code_mode}`);
    io.to(`channel:${channel.code}`).emit('channel-code-settings-updated', { channelId, channelCode: channel.code, settings: updated });
    socket.emit('error-msg', 'Channel code settings updated');
  });

  socket.on('rotate-channel-code', (data) => {
    if (!data || typeof data !== 'object') return;
    if (!socket.user.isAdmin) return socket.emit('error-msg', 'Only admins can rotate channel codes');
    const channelId = typeof data.channelId === 'number' ? data.channelId : null;
    if (!channelId) return;
    const channel = db.prepare('SELECT * FROM channels WHERE id = ? AND is_dm = 0').get(channelId);
    if (!channel) return;
    const oldCode = channel.code;
    try {
      rotateChannelCode(channelId, oldCode);
      auditChannel(channelId, 'invite_code', 'new code');
    } catch (err) {
      console.warn(`[ChannelRotation] Manual rotation failed for channel ${channelId}:`, err.message);
      socket.emit('error-msg', 'Channel code rotation failed. Please try again.');
    }
  });

  // ── Invite user to channel ──────────────────────────────
  socket.on('invite-to-channel', (data) => {
    if (!data || typeof data !== 'object') return;
    const targetUserId = isInt(data.targetUserId) ? data.targetUserId : null;
    const channelId = isInt(data.channelId) ? data.channelId : null;
    if (!targetUserId || !channelId) return socket.emit('error-msg', 'Invalid invite data');
    if (targetUserId === socket.user.id) return;
    const inviterMember = db.prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?').get(channelId, socket.user.id);
    if (!inviterMember && !socket.user.isAdmin) return socket.emit('error-msg', 'You are not a member of that channel');
    const channel = db.prepare('SELECT * FROM channels WHERE id = ? AND is_dm = 0').get(channelId);
    if (!channel) return socket.emit('error-msg', 'Channel not found');
    // A sub-channel is reached through its parent, so one under a private
    // parent is as private as the parent.
    const parentCh = channel.parent_channel_id
      ? db.prepare('SELECT created_by, is_private, code_visibility FROM channels WHERE id = ?').get(channel.parent_channel_id)
      : null;
    const channelIsPrivate = channel.is_private || channel.code_visibility === 'private'
      || !!(parentCh && (parentCh.is_private || parentCh.code_visibility === 'private'));
    if (channelIsPrivate && !socket.user.isAdmin) {
      const isCreator = channel.created_by === socket.user.id || !!(parentCh && parentCh.created_by === socket.user.id);
      const isMod = userHasPermission(socket.user.id, 'kick_user', channelId);
      if (!isCreator && !isMod) return socket.emit('error-msg', 'Only the channel creator or moderators can invite people to private channels');
    }
    const targetUser = db.prepare(`
      SELECT u.id, u.username, u.is_guest, (b.id IS NOT NULL) AS banned
      FROM users u LEFT JOIN bans b ON b.user_id = u.id WHERE u.id = ?
    `).get(targetUserId);
    if (!targetUser || targetUser.banned) return socket.emit('error-msg', 'User not found');
    // A guest sees only the channels the admin opened to guests (join-channel
    // refuses them a code too), so an invite is no way past that list.
    if (targetUser.is_guest && !socket.user.isAdmin) return socket.emit('error-msg', 'Guests can only use the channels the admin opened to them');
    const alreadyMember = db.prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?').get(channelId, targetUserId);
    if (alreadyMember) return socket.emit('error-msg', `${targetUser.username} is already in #${channel.name}`);
    db.prepare('INSERT INTO channel_members (channel_id, user_id) VALUES (?, ?)').run(channelId, targetUserId);
    if (!channel.parent_channel_id) {
      const subs = db.prepare('SELECT id, code FROM channels WHERE parent_channel_id = ? AND is_private = 0').all(channel.id);
      const insertSub = db.prepare('INSERT OR IGNORE INTO channel_members (channel_id, user_id) VALUES (?, ?)');
      subs.forEach(sub => insertSub.run(sub.id, targetUserId));
    }
    try {
      const autoRoles = db.prepare('SELECT id FROM roles WHERE auto_assign = 1').all();
      const insertAutoRole = db.prepare('INSERT OR IGNORE INTO user_roles (user_id, role_id, channel_id, granted_by) VALUES (?, ?, NULL, NULL)');
      for (const ar of autoRoles) {
        insertAutoRole.run(targetUserId, ar.id);
        applyRoleChannelAccess(ar.id, targetUserId, 'grant');
      }
    } catch (err) {
      // The invite still stands, but the auto-assign roles may be missing.
      console.warn('invite-to-channel auto-role grant failed:', err.message);
    }
    const targetSockets = [...io.sockets.sockets.values()].filter(s => s.user && s.user.id === targetUserId);
    // Only into the rooms the invited person's role gates allow.
    const targetIsAdmin = !!db.prepare('SELECT is_admin FROM users WHERE id = ?').get(targetUserId)?.is_admin;
    const gateFor = (ch) => targetIsAdmin || ctx.roleGateAllows(targetUserId, ch);
    const gatedRow = db.prepare('SELECT id, role_gate FROM channels WHERE id = ?').get(channel.id);
    for (const ts of targetSockets) {
      if (gateFor(gatedRow)) ts.join(`channel:${channel.code}`);
      if (!channel.parent_channel_id) {
        const subs = db.prepare('SELECT id, code, role_gate FROM channels WHERE parent_channel_id = ? AND is_private = 0').all(channel.id);
        subs.forEach(sub => { if (gateFor(sub)) ts.join(`channel:${sub.code}`); });
      }
      ts.emit('channels-list', getEnrichedChannels(targetUserId, ts.user.isAdmin, (room) => ts.join(room)));
      ts.emit('toast', { message: `${socket.user.username} invited you to #${channel.name}`, type: 'info' });
    }
    socket.emit('toast', { message: `Invited ${targetUser.username} to #${channel.name}`, type: 'success' });
  });

  // ── Remove from channel ─────────────────────────────────
  socket.on('remove-from-channel', (data, callback) => {
    const cb = typeof callback === 'function' ? callback : () => {};
    if (!data || typeof data !== 'object') return cb({ error: 'Invalid data' });
    const targetUserId = isInt(data.userId) ? data.userId : null;
    const channelId = isInt(data.channelId) ? data.channelId : null;
    if (!targetUserId || !channelId) return cb({ error: 'Invalid data' });
    if (targetUserId === socket.user.id) return cb({ error: 'You can\'t remove yourself' });
    // Only from a channel the remover can reach themselves, and the same
    // answer for one that does not exist, so ids cannot be walked for names.
    const reach = reachableChannel(ctx, socket.user, channelId);
    if (!reach || reach.is_dm) return cb({ error: 'Channel not found' });
    if (!socket.user.isAdmin && !userHasPermission(socket.user.id, 'kick_user', channelId)) {
      return cb({ error: 'You don\'t have permission to remove users from channels' });
    }
    if (!socket.user.isAdmin) {
      const myLevel = getUserEffectiveLevel(socket.user.id, channelId);
      const targetLevel = getUserEffectiveLevel(targetUserId, channelId);
      if (targetLevel >= myLevel) return cb({ error: 'You can\'t remove a user with equal or higher rank' });
    }
    const channel = db.prepare('SELECT * FROM channels WHERE id = ? AND is_dm = 0').get(channelId);
    if (!channel) return cb({ error: 'Channel not found' });
    const targetUser = db.prepare('SELECT id, username, COALESCE(display_name, username) as displayName FROM users WHERE id = ?').get(targetUserId);
    if (!targetUser) return cb({ error: 'User not found' });
    const membershipCheck = db.prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?').get(channelId, targetUserId);
    if (!membershipCheck) return cb({ error: `${targetUser.username} is not in #${channel.name}` });
    db.prepare('DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?').run(channelId, targetUserId);
    const subs = db.prepare('SELECT id, code FROM channels WHERE parent_channel_id = ?').all(channelId);
    const delSub = db.prepare('DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?');
    subs.forEach(s => delSub.run(s.id, targetUserId));
    // Roles held in that channel go with the membership; kept, a removed
    // Channel Mod could still act there.
    const delScoped = db.prepare('DELETE FROM user_roles WHERE user_id = ? AND channel_id = ?');
    [channelId, ...subs.map(s => s.id)].forEach(id => delScoped.run(targetUserId, id));
    // Out of the call too, before the code rotates below.
    ctx.liveAccess?.cutOff(targetUserId, [channel.code, ...subs.map(s => s.code)], 'You were removed from this channel');
    const targetSockets = [...io.sockets.sockets.values()].filter(s => s.user && s.user.id === targetUserId);
    for (const ts of targetSockets) {
      if (ts.currentChannel === channel.code || subs.some(sub => sub.code === ts.currentChannel)) ts.currentChannel = null;
      ts.leave(`channel:${channel.code}`);
      subs.forEach(sub => ts.leave(`channel:${sub.code}`));
      ts.emit('channels-list', getEnrichedChannels(targetUserId, ts.user.isAdmin, (room) => ts.join(room)));
      ts.emit('toast', { message: `You were removed from #${channel.name}`, type: 'warning' });
    }
    const channelRoom = channelUsers.get(channel.code);
    if (channelRoom) {
      channelRoom.delete(targetUserId);
      emitOnlineUsers(channel.code);
    }
    if (typeof rotatePrivateCodesAfterRemoval === 'function') rotatePrivateCodesAfterRemoval(channelId);
    cb({ success: true });
    _audit({ actor: socket.user, action: 'channel_member_remove',
      target_type: 'user', target_id: targetUserId, target_name: targetUser.displayName,
      details: { channel: channel.name } });
    socket.emit('error-msg', `Removed ${targetUser.username} from #${channel.name}`);
  });

  // ── Direct Messages ─────────────────────────────────────
  socket.on('start-dm', (data) => {
    if (!data || typeof data !== 'object') return;
    // (#5381) Guests have no E2E key (no password → no PBKDF2-derived
    // wrap key), so DMs would be unencryptable. The DM tab is hidden in
    // the guest UI; this is the server-side enforcement.
    if (socket.user.isGuest) {
      return socket.emit('error-msg', 'Guests cannot send direct messages');
    }
    const targetId = isInt(data.targetUserId) ? data.targetUserId : null;
    if (!targetId) return;
    const isSelfDm = targetId === socket.user.id;
    const target = db.prepare(
      'SELECT u.id, COALESCE(u.display_name, u.username) as username FROM users u LEFT JOIN bans b ON u.id = b.user_id WHERE u.id = ? AND b.id IS NULL'
    ).get(targetId);
    if (!target) return socket.emit('error-msg', 'User not found');
    // For self-DM, the channel has only one channel_members row, so both EXISTS
    // clauses below collapse to the same check, which still matches correctly.
    // A group DM that shrank to two (or one) members is still a group, not
    // this pair's 1:1 conversation.
    const existingDm = db.prepare(`
      SELECT c.id, c.code, c.name FROM channels c
      WHERE c.is_dm = 1 AND COALESCE(c.is_group, 0) = 0
      AND EXISTS (SELECT 1 FROM channel_members WHERE channel_id = c.id AND user_id = ?)
      AND EXISTS (SELECT 1 FROM channel_members WHERE channel_id = c.id AND user_id = ?)
      AND (SELECT COUNT(*) FROM channel_members WHERE channel_id = c.id) = ${isSelfDm ? 1 : 2}
    `).get(socket.user.id, targetId);
    if (existingDm) {
      socket.emit('dm-opened', {
        id: existingDm.id, code: existingDm.code, name: existingDm.name,
        is_dm: 1, is_self_dm: isSelfDm ? 1 : 0,
        dm_target: { id: target.id, username: target.username }
      });
      return;
    }
    if (!isSelfDm) {
      if (refuseYoungAccount(null)) return;
      if (!socket.user.isAdmin) {
        let started;
        try {
          started = db.prepare(`
            SELECT COUNT(*) AS n FROM channels
            WHERE created_by = ? AND is_dm = 1 AND COALESCE(is_group, 0) = 0 AND COALESCE(is_self_dm, 0) = 0
              AND created_at >= datetime('now', '-1 hour')
          `).get(socket.user.id).n;
        } catch (err) {
          console.warn('[dm] could not count new conversations, refusing:', err.message);
          return socket.emit('error-msg', 'Could not start the conversation. Try again in a moment.');
        }
        if (started >= NEW_DMS_PER_HOUR) {
          return socket.emit('error-msg', 'You have started a lot of new conversations in the last hour. Try again later.');
        }
      }
    }
    const code = generateUniqueSharedCode();
    try {
      const result = db.prepare('INSERT INTO channels (name, code, created_by, is_dm, is_self_dm) VALUES (?, ?, ?, 1, ?)').run('DM', code, socket.user.id, isSelfDm ? 1 : 0);
      const channelId = result.lastInsertRowid;
      db.prepare('INSERT INTO channel_members (channel_id, user_id) VALUES (?, ?)').run(channelId, socket.user.id);
      // Self-DMs only have one member; PRIMARY KEY prevents duplicate insert.
      if (!isSelfDm) {
        db.prepare('INSERT INTO channel_members (channel_id, user_id) VALUES (?, ?)').run(channelId, targetId);
      }
      socket.join(`channel:${code}`);
      socket.emit('dm-opened', { id: channelId, code, name: 'DM', is_dm: 1, is_self_dm: isSelfDm ? 1 : 0, dm_target: { id: target.id, username: target.username } });
      if (!isSelfDm) {
        for (const [, s] of io.of('/').sockets) {
          if (s.user && s.user.id === targetId) {
            s.join(`channel:${code}`);
            s.emit('dm-opened', { id: channelId, code, name: 'DM', is_dm: 1, dm_target: { id: socket.user.id, username: socket.user.displayName } });
          }
        }
      }
    } catch (err) {
      console.error('Start DM error:', err);
      socket.emit('error-msg', 'Failed to create DM');
    }
  });

  // Returns false, deleting nothing, when the DM holds protected messages.
  async function purgeDmChannel(channel, attachments, extraOwners = []) {
    if (protectedMessages.protectedCount(db, [channel.id])) return false;
    // Collect attachment filenames before we drop the message rows. We
    // scan plaintext message content server-side, and also accept a
    // `data.attachments` list from the client for E2E-encrypted DM
    // messages whose ciphertext we can't read here. (#5299)
    const filenames = new Set();
    try {
      const msgs = db.prepare('SELECT content FROM messages WHERE channel_id = ?').all(channel.id);
      const uploadRe = UPLOAD_PATH_RE;
      for (const row of msgs) {
        const text = row.content || '';
        uploadRe.lastIndex = 0;
        let m;
        while ((m = uploadRe.exec(text)) !== null) {
          if (isSafeUploadRelPath(m[1])) filenames.add(m[1]);
        }
      }
    } catch (err) {
      // Never block the delete; the DM's attachments just stay in uploads/.
      console.warn('delete-dm attachment scan failed:', err.message);
    }
    if (Array.isArray(attachments)) {
      for (const url of attachments) {
        if (typeof url !== 'string') continue;
        const match = url.match(UPLOAD_PATH_EXACT_RE);
        if (match && isSafeUploadRelPath(match[1])) filenames.add(match[1]);
      }
    }

    // Only the DM's own participants' attachments go with it.
    const participants = [...new Set([...db.prepare('SELECT user_id FROM channel_members WHERE channel_id = ?').all(channel.id).map(r => r.user_id), ...extraOwners])];

    const deleteAll = db.transaction((chId) => {
      db.prepare('DELETE FROM reactions WHERE message_id IN (SELECT id FROM messages WHERE channel_id = ?)').run(chId);
      db.prepare('DELETE FROM pinned_messages WHERE channel_id = ?').run(chId);
      db.prepare('DELETE FROM messages WHERE channel_id = ?').run(chId);
      db.prepare('DELETE FROM channel_members WHERE channel_id = ?').run(chId);
      // A group DM's keys and invites go with it, whoever deletes it.
      for (const table of ['dm_group_keys', 'dm_group_epochs', 'dm_group_invites', 'dm_group_rewrap_requests']) {
        db.prepare(`DELETE FROM ${table} WHERE channel_id = ?`).run(chId);
      }
      db.prepare('DELETE FROM channels WHERE id = ?').run(chId);
    });
    deleteAll(channel.id);

    for (const name of releasableUploads(db, filenames, participants)) await storage.softDelete(name);
    return true;
  }
  ctx.purgeDmChannel = purgeDmChannel;
  socket.on('delete-dm', async (data) => {
    if (!data || typeof data !== 'object') return;
    const code = typeof data.code === 'string' ? data.code.trim() : '';
    if (!code || !/^[a-f0-9]{8}$/i.test(code)) return;
    // Deleting a DM erases it for everyone in it, so the app must have asked
    // first. An app that sends this from a plain "close" gets refused instead.
    if (data.confirmed !== true) {
      return socket.emit('error-msg', 'Deleting a conversation removes it for everyone in it. Please update your app so it asks before deleting.');
    }
    const channel = db.prepare('SELECT * FROM channels WHERE code = ? AND is_dm = 1').get(code);
    if (!channel) return socket.emit('error-msg', 'DM not found');
    const isMember = db.prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?').get(channel.id, socket.user.id);
    if (!isMember && !socket.user.isAdmin) return socket.emit('error-msg', 'Not authorized');
    if (isMember && channel.is_group && ctx.leaveGroupDm) return void (await ctx.leaveGroupDm(code, socket.user.id, data.attachments));
    // An admin outside a group deletes it for everyone, with the same checks and notices as from its menu.
    if (channel.is_group) return void (ctx.deleteGroupDmForEveryone ? await ctx.deleteGroupDmForEveryone(code, data.attachments) : socket.emit('error-msg', 'Not authorized'));

    // An admin deleting a conversation they are not in is on the record.
    const outsiders = isMember ? null : db.prepare(`
      SELECT COALESCE(u.display_name, u.username) AS name FROM channel_members cm JOIN users u ON u.id = cm.user_id WHERE cm.channel_id = ?
    `).all(channel.id).map(r => r.name);
    if (!(await purgeDmChannel(channel, data.attachments))) return socket.emit('error-msg', protectedMessages.CONVERSATION_REFUSAL);
    if (outsiders) {
      _audit({ actor: socket.user, action: 'dm_delete',
        target_type: 'channel', target_id: channel.id, target_name: outsiders.join(', ') });
    }

    io.to(`channel:${code}`).to(`voice:${code}`).emit('channel-deleted', { code });
    clearChannelRuntimeState(state, code);
  });
};
