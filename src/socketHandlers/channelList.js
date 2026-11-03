'use strict';

// The synchronous list remains for unconverted broadcasts and write handlers.
// get-channels uses the async list; SQLite's membership repair stays in its
// original synchronous block until async transactions cover those writes.

const { groupHistoryFloor, groupHistoryFloorAsync } = require('../groupHistory');
const forumUnread = require('../forumUnread');
const automod = require('../automod');
const createPermissions = require('./permissions');
const createAsyncPermissions = require('./asyncPermissions');

module.exports = function createChannelLists({ db, userHasPermission, roleGateAllows, getUserEffectiveLevel = createPermissions(db).getUserEffectiveLevel }) {
  function getChannelRows(userId, isAdmin) {
    // Holders of 'view_all_channels' (e.g. a server-wide Mod role) get the
    // same visibility treatment as the admin: every non-DM channel, with
    // membership filled in on the fly, so channels created after the role
    // was granted show up for them automatically instead of someone having
    // to add every mod to every new channel by hand.
    const seesAll = isAdmin || userHasPermission(userId, 'view_all_channels');
    // Only auto-joins owed to the permission are marked. An admin's are not:
    // admin is not a role that gets revoked in the same casual way, and their
    // memberships should survive a permission cleanup. (#5512)
    const autoJoin = seesAll && !isAdmin ? 1 : 0;
    let channels;
    if (seesAll) {
      channels = db.prepare(`
        SELECT c.id, c.name, c.code, c.created_by, c.topic, c.is_dm, c.is_group,
               c.code_visibility, c.code_mode, c.code_rotation_type, c.code_rotation_interval,
               c.parent_channel_id, c.position, c.is_private, c.expires_at, c.is_temp_voice,
               c.streams_enabled, c.music_enabled, c.media_enabled, c.soundboard_enabled, c.reactions_enabled, c.slow_mode_interval, c.category, c.sort_alphabetical,
               c.cleanup_exempt, c.channel_type, c.voice_user_limit, c.notification_type, c.voice_enabled, c.text_enabled, c.voice_bitrate,
               c.afk_sub_code, c.afk_timeout_minutes, c.read_only, c.auto_delete_mode, c.auto_delete_interval_hours, c.default_role_id, c.show_welcome, c.is_forum, c.forum_tags, c.is_nsfw, c.former_names, c.role_gate, c.forum_layout, c.forum_votes, c.forum_blog, c.forum_blog_pics_only, c.type_id
        FROM channels c WHERE c.is_dm = 0
        UNION
        SELECT c.id, c.name, c.code, c.created_by, c.topic, c.is_dm, c.is_group,
               c.code_visibility, c.code_mode, c.code_rotation_type, c.code_rotation_interval,
               c.parent_channel_id, c.position, c.is_private, c.expires_at, c.is_temp_voice,
               c.streams_enabled, c.music_enabled, c.media_enabled, c.soundboard_enabled, c.reactions_enabled, c.slow_mode_interval, c.category, c.sort_alphabetical,
               c.cleanup_exempt, c.channel_type, c.voice_user_limit, c.notification_type, c.voice_enabled, c.text_enabled, c.voice_bitrate,
               c.afk_sub_code, c.afk_timeout_minutes, c.read_only, c.auto_delete_mode, c.auto_delete_interval_hours, c.default_role_id, c.show_welcome, c.is_forum, c.forum_tags, c.is_nsfw, c.former_names, c.role_gate, c.forum_layout, c.forum_votes, c.forum_blog, c.forum_blog_pics_only, c.type_id
        FROM channels c
        JOIN channel_members cm ON c.id = cm.channel_id
        WHERE cm.user_id = ? AND c.is_dm = 1
        ORDER BY is_dm, position, name
      `).all(userId);
      // OR IGNORE, so a membership the user already had by other means keeps
      // its existing flag and survives a later cleanup.
      const insertMember = db.prepare('INSERT OR IGNORE INTO channel_members (channel_id, user_id, auto_all_channels) VALUES (?, ?, ?)');
      channels.forEach(ch => { if (!ch.is_dm) insertMember.run(ch.id, userId, autoJoin); });
    } else {
      channels = db.prepare(`
        SELECT c.id, c.name, c.code, c.created_by, c.topic, c.is_dm, c.is_group,
               c.code_visibility, c.code_mode, c.code_rotation_type, c.code_rotation_interval,
               c.parent_channel_id, c.position, c.is_private, c.expires_at, c.is_temp_voice,
               c.streams_enabled, c.music_enabled, c.media_enabled, c.soundboard_enabled, c.reactions_enabled, c.slow_mode_interval, c.category, c.sort_alphabetical,
               c.cleanup_exempt, c.channel_type, c.voice_user_limit, c.notification_type, c.voice_enabled, c.text_enabled, c.voice_bitrate,
               c.afk_sub_code, c.afk_timeout_minutes, c.read_only, c.auto_delete_mode, c.auto_delete_interval_hours, c.default_role_id, c.show_welcome, c.is_forum, c.forum_tags, c.is_nsfw, c.former_names, c.role_gate, c.forum_layout, c.forum_votes, c.forum_blog, c.forum_blog_pics_only, c.type_id
        FROM channels c
        JOIN channel_members cm ON c.id = cm.channel_id
        WHERE cm.user_id = ?
        ORDER BY c.is_dm, c.position, c.name
      `).all(userId);

      // Self-heal legacy accounts that somehow ended up with zero memberships.
      // Never into a channel whose code is hidden: that is how someone kicked
      // from their only channel was put straight back into it.
      // This restores visibility without requiring the user to manually join by code.
      if (channels.length === 0) {
        const userRow = db.prepare('SELECT is_guest FROM users WHERE id = ?').get(userId);
        if (!userRow || !userRow.is_guest) {
          let targetRows = [];
          try {
            const djc = db.prepare("SELECT value FROM server_settings WHERE key = 'default_join_channels'").get();
            const parsed = djc && djc.value ? JSON.parse(djc.value) : [];
            const ids = Array.isArray(parsed)
              ? parsed.map(n => parseInt(n, 10)).filter(n => Number.isInteger(n) && n > 0)
              : [];

            if (ids.length > 0) {
              const ph = ids.map(() => '?').join(',');
              targetRows = db.prepare(
                `SELECT id FROM channels WHERE is_dm = 0 AND is_private = 0 AND (code_visibility IS NULL OR code_visibility != 'private') AND id IN (${ph})`
              ).all(...ids);
            }
          } catch {
            targetRows = []; // a malformed default_join_channels setting: join nothing extra
          }

          if (targetRows.length === 0) {
            targetRows = db.prepare(
              "SELECT id FROM channels WHERE is_dm = 0 AND is_private = 0 AND (code_visibility IS NULL OR code_visibility != 'private') ORDER BY position, name"
            ).all();
          }

          if (targetRows.length > 0) {
            const insertMember = db.prepare('INSERT OR IGNORE INTO channel_members (channel_id, user_id) VALUES (?, ?)');
            for (const row of targetRows) insertMember.run(row.id, userId);
            channels = db.prepare(`
              SELECT c.id, c.name, c.code, c.created_by, c.topic, c.is_dm, c.is_group,
                     c.code_visibility, c.code_mode, c.code_rotation_type, c.code_rotation_interval,
                     c.parent_channel_id, c.position, c.is_private, c.expires_at, c.is_temp_voice,
                     c.streams_enabled, c.music_enabled, c.media_enabled, c.soundboard_enabled, c.reactions_enabled, c.slow_mode_interval, c.category, c.sort_alphabetical,
                     c.cleanup_exempt, c.channel_type, c.voice_user_limit, c.notification_type, c.voice_enabled, c.text_enabled, c.voice_bitrate,
                     c.afk_sub_code, c.afk_timeout_minutes, c.read_only, c.auto_delete_mode, c.auto_delete_interval_hours, c.default_role_id, c.show_welcome, c.is_forum, c.forum_tags, c.is_nsfw, c.former_names, c.role_gate, c.forum_layout, c.forum_votes, c.forum_blog, c.forum_blog_pics_only, c.type_id
              FROM channels c
              JOIN channel_members cm ON c.id = cm.channel_id
              WHERE cm.user_id = ?
              ORDER BY c.is_dm, c.position, c.name
            `).all(userId);
          }
        }
      }
    }

    return channels;
  }

  // ── getEnrichedChannels ─────────────────────────────────
  // `shared` (optional) carries per-channel answers that are the same for
  // every viewer, so a broadcast to thousands of people works them out once.
  function getEnrichedChannels(userId, isAdmin, joinRooms, shared = null) {
    let channels = getChannelRows(userId, isAdmin);

    // A role gate hides the channel from anyone who fails it, membership or
    // not. Admins see everything, as they do for private channels.
    if (!isAdmin) channels = channels.filter(ch => ch.is_dm || roleGateAllows(userId, ch));

    if (channels.length > 0) {
      const channelIds = channels.map(c => c.id);
      const placeholders = channelIds.map(() => '?').join(',');

      const readRows = db.prepare(
        `SELECT channel_id, last_read_message_id FROM read_positions WHERE user_id = ? AND channel_id IN (${placeholders})`
      ).all(userId, ...channelIds);
      const readMap = {};
      readRows.forEach(r => { readMap[r.channel_id] = r.last_read_message_id; });

      const latestMap = {};
      const unknown = shared ? channelIds.filter(id => !shared.latest.has(id)) : channelIds;
      if (unknown.length) {
        const latestRows = db.prepare(
          `SELECT channel_id, MAX(id) as latest_id FROM messages WHERE channel_id IN (${unknown.map(() => '?').join(',')}) AND thread_id IS NULL GROUP BY channel_id`
        ).all(...unknown);
        if (shared) unknown.forEach(id => shared.latest.set(id, 0));
        latestRows.forEach(r => { latestMap[r.channel_id] = r.latest_id; if (shared) shared.latest.set(r.channel_id, r.latest_id); });
      }
      if (shared) channelIds.forEach(id => { latestMap[id] = shared.latest.get(id) || 0; });

      channels.forEach(ch => {
        // A group DM member's count starts where their history does.
        const lastRead = Math.max(readMap[ch.id] || 0, groupHistoryFloor(db, ch, userId));
        const latestId = latestMap[ch.id] || 0;
        ch.latestMessageId = latestId;
        if (latestId > lastRead) {
          const countRow = db.prepare(
            // Exclude thread replies (thread_id IS NOT NULL): they live in their
            // own thread panel, never appear in the channel scroll, and so can
            // never be marked-read by scrolling. Counting them here pins a
            // phantom unread on the channel forever.
            // Counting stops at 1000: badges show 99+ past 99 anyway, and an
            // uncapped count walked every unread message of a long-idle member
            // on every channel-list refresh.
            // (user_id IS NULL OR ...): imported and relayed messages belong
            // to no account, and NULL != ? is never true, so they never
            // counted (#5771). A group DM's "joined" / "left" lines are not
            // new messages.
            "SELECT COUNT(*) as cnt FROM (SELECT 1 FROM messages WHERE channel_id = ? AND id > ? AND (user_id IS NULL OR user_id != ?) AND thread_id IS NULL AND COALESCE(type, 'user') != 'notice' LIMIT 1000)"
          ).get(ch.id, lastRead, userId);
          ch.unreadCount = countRow ? countRow.cnt : 0;
        } else {
          ch.unreadCount = 0;
        }
        // A forum's replies are not counted above, so it reports its unread
        // topics separately for the sidebar dot.
        if (ch.is_forum) {
          try {
            ch.forumUnread = forumUnread.countCached(db, userId, ch.id);
          } catch (err) {
            console.warn('[forum-unread] count failed:', err.message);
            ch.forumUnread = 0;
          }
        }

        // Whether this viewer may post in a read-only channel, answered per
        // channel. The client only ever had a flat permission list that merges
        // server-wide grants with every channel-scoped one, so holding
        // read_only_override in a single channel made the composer appear in
        // every read-only channel. The send was still refused server-side, so
        // the box looked usable and silently was not. (#5468)
        if (ch.read_only === 1 && !ch.is_dm) {
          ch.canOverrideReadOnly = isAdmin || userHasPermission(userId, 'read_only_override', ch.id);
        }

        // Whether this viewer may invite someone into this private channel.
        // Mirrors the rule the invite-to-channel handler already enforces:
        // admin, the channel's creator, or a moderator within that channel.
        // The menu only ever offered private channels to admins, so creators
        // and channel moderators held the right with no way to use it. This
        // does not widen the rule, it just lets the UI match it. (#5466)
        if (!ch.is_dm && (ch.is_private || ch.code_visibility === 'private')) {
          ch.canInvitePrivate = isAdmin
            || ch.created_by === userId
            || userHasPermission(userId, 'kick_user', ch.id);
        }

        // Same per-channel answer for the two channel-management surfaces the
        // flat permission list gets wrong. Holding manage_channel_settings in
        // one channel put "Channel Functions" in every channel's menu, and
        // holding manage_sub_channels in one channel offered "Create
        // Sub-channel" everywhere. Both were refused server-side, so the
        // controls were there but dead. (#5467)
        if (!ch.is_dm) {
          ch.canManageSettings = isAdmin || userHasPermission(userId, 'manage_channel_settings', ch.id);
          ch.canManageSubs = isAdmin || userHasPermission(userId, 'manage_sub_channels', ch.id);
        }

        if (ch.is_dm) {
          const otherUser = db.prepare(`
            SELECT u.id, COALESCE(u.display_name, u.username) as username,
                   u.avatar, u.avatar_shape AS avatarShape
            FROM users u
            JOIN channel_members cm ON u.id = cm.user_id
            WHERE cm.channel_id = ? AND u.id != ?
          `).get(ch.id, userId);
          if (ch.is_group) {
            ch.dm_target = otherUser || null;
            ch.group_members = db.prepare(`
              SELECT u.id, COALESCE(u.display_name, u.username) as username, u.avatar, u.avatar_shape AS avatarShape
              FROM users u JOIN channel_members cm ON u.id = cm.user_id WHERE cm.channel_id = ? ORDER BY u.id
            `).all(ch.id);
            ch.group_pending = db.prepare(`
              SELECT u.id, COALESCE(u.display_name, u.username) as username
              FROM users u JOIN dm_group_invites i ON u.id = i.user_id WHERE i.channel_id = ? ORDER BY u.id
            `).all(ch.id);
          } else if (otherUser) {
            ch.dm_target = otherUser;
          } else {
            // Self-DM: only one channel_members row, no "other" user. Use self as the partner.
            const self = db.prepare(
              'SELECT id, COALESCE(display_name, username) as username, avatar, avatar_shape AS avatarShape FROM users WHERE id = ?'
            ).get(userId);
            ch.dm_target = self || null;
            ch.is_self_dm = 1;
          }
          // Who in this DM skips the link filter: the browser checks links in
          // encrypted messages itself, and marked an admin's links blocked.
          try {
            ch.link_exempt_ids = db.prepare(`
              SELECT u.id, u.is_admin FROM users u JOIN channel_members cm ON u.id = cm.user_id WHERE cm.channel_id = ?
            `).all(ch.id).filter(m => automod.linkExempt({ isAdmin: !!m.is_admin, effectiveLevel: getUserEffectiveLevel(m.id) })).map(m => m.id);
          } catch (err) {
            // Nobody counted as exempt: links are checked as before.
            console.warn('[automod] DM exemption lookup failed:', err.message);
            ch.link_exempt_ids = [];
          }
        }
      });
    }

    if (joinRooms) {
      channels.forEach(ch => joinRooms(`channel:${ch.code}`));
    }

    channels.forEach(ch => {
      // DM channels route by code internally but the code is a pure implementation
      // detail. Never expose it as a copyable value: strip all code-related fields
      // so no client surface can accidentally reveal or share it.
      if (ch.is_dm) {
        ch.display_code = null;
        delete ch.code_visibility;
        delete ch.code_mode;
        delete ch.code_rotation_type;
        delete ch.code_rotation_interval;
        return;
      }
      if (isAdmin) {
        ch.display_code = ch.code;
      } else if (ch.code_visibility === 'private' || ch.is_private) {
        const isMod = ch.created_by === userId || userHasPermission(userId, 'kick_user', ch.id);
        ch.display_code = isMod ? ch.code : '••••••••';
      } else {
        ch.display_code = ch.code;
      }
    });

    return channels;
  }

  async function getChannelRowsAsync(userId, isAdmin, driver, asyncPermissions) {
    // Holders of 'view_all_channels' (e.g. a server-wide Mod role) get the
    // same visibility treatment as the admin: every non-DM channel, with
    // membership filled in on the fly, so channels created after the role
    // was granted show up for them automatically instead of someone having
    // to add every mod to every new channel by hand.
    const seesAll = isAdmin || await asyncPermissions.userHasPermission(userId, 'view_all_channels');
    // Only auto-joins owed to the permission are marked. An admin's are not:
    // admin is not a role that gets revoked in the same casual way, and their
    // memberships should survive a permission cleanup. (#5512)
    const autoJoin = seesAll && !isAdmin ? 1 : 0;
    let channels;
    if (seesAll) {
      channels = await driver.prepare(`
        SELECT c.id, c.name, c.code, c.created_by, c.topic, c.is_dm, c.is_group,
               c.code_visibility, c.code_mode, c.code_rotation_type, c.code_rotation_interval,
               c.parent_channel_id, c.position, c.is_private, c.expires_at, c.is_temp_voice,
               c.streams_enabled, c.music_enabled, c.media_enabled, c.soundboard_enabled, c.reactions_enabled, c.slow_mode_interval, c.category, c.sort_alphabetical,
               c.cleanup_exempt, c.channel_type, c.voice_user_limit, c.notification_type, c.voice_enabled, c.text_enabled, c.voice_bitrate,
               c.afk_sub_code, c.afk_timeout_minutes, c.read_only, c.auto_delete_mode, c.auto_delete_interval_hours, c.default_role_id, c.show_welcome, c.is_forum, c.forum_tags, c.is_nsfw, c.former_names, c.role_gate, c.forum_layout, c.forum_votes, c.forum_blog, c.forum_blog_pics_only, c.type_id
        FROM channels c WHERE c.is_dm = 0
        UNION
        SELECT c.id, c.name, c.code, c.created_by, c.topic, c.is_dm, c.is_group,
               c.code_visibility, c.code_mode, c.code_rotation_type, c.code_rotation_interval,
               c.parent_channel_id, c.position, c.is_private, c.expires_at, c.is_temp_voice,
               c.streams_enabled, c.music_enabled, c.media_enabled, c.soundboard_enabled, c.reactions_enabled, c.slow_mode_interval, c.category, c.sort_alphabetical,
               c.cleanup_exempt, c.channel_type, c.voice_user_limit, c.notification_type, c.voice_enabled, c.text_enabled, c.voice_bitrate,
               c.afk_sub_code, c.afk_timeout_minutes, c.read_only, c.auto_delete_mode, c.auto_delete_interval_hours, c.default_role_id, c.show_welcome, c.is_forum, c.forum_tags, c.is_nsfw, c.former_names, c.role_gate, c.forum_layout, c.forum_votes, c.forum_blog, c.forum_blog_pics_only, c.type_id
        FROM channels c
        JOIN channel_members cm ON c.id = cm.channel_id
        WHERE cm.user_id = ? AND c.is_dm = 1
        ORDER BY is_dm, position, name
      `).all(userId);
      // OR IGNORE, so a membership the user already had by other means keeps
      // its existing flag and survives a later cleanup.
      const insertMember = driver.prepare('INSERT INTO channel_members (channel_id, user_id, auto_all_channels) VALUES (?, ?, ?) ON CONFLICT(channel_id, user_id) DO NOTHING');
      for (const ch of channels) { if (!ch.is_dm) await insertMember.run(ch.id, userId, autoJoin); }
    } else {
      channels = await driver.prepare(`
        SELECT c.id, c.name, c.code, c.created_by, c.topic, c.is_dm, c.is_group,
               c.code_visibility, c.code_mode, c.code_rotation_type, c.code_rotation_interval,
               c.parent_channel_id, c.position, c.is_private, c.expires_at, c.is_temp_voice,
               c.streams_enabled, c.music_enabled, c.media_enabled, c.soundboard_enabled, c.reactions_enabled, c.slow_mode_interval, c.category, c.sort_alphabetical,
               c.cleanup_exempt, c.channel_type, c.voice_user_limit, c.notification_type, c.voice_enabled, c.text_enabled, c.voice_bitrate,
               c.afk_sub_code, c.afk_timeout_minutes, c.read_only, c.auto_delete_mode, c.auto_delete_interval_hours, c.default_role_id, c.show_welcome, c.is_forum, c.forum_tags, c.is_nsfw, c.former_names, c.role_gate, c.forum_layout, c.forum_votes, c.forum_blog, c.forum_blog_pics_only, c.type_id
        FROM channels c
        JOIN channel_members cm ON c.id = cm.channel_id
        WHERE cm.user_id = ?
        ORDER BY c.is_dm, c.position, c.name
      `).all(userId);

      // Self-heal legacy accounts that somehow ended up with zero memberships.
      // Never into a channel whose code is hidden: that is how someone kicked
      // from their only channel was put straight back into it.
      // This restores visibility without requiring the user to manually join by code.
      if (channels.length === 0) {
        const userRow = await driver.prepare('SELECT is_guest FROM users WHERE id = ?').get(userId);
        if (!userRow || !userRow.is_guest) {
          let targetRows = [];
          try {
            const djc = await driver.prepare("SELECT value FROM server_settings WHERE key = 'default_join_channels'").get();
            const parsed = djc && djc.value ? JSON.parse(djc.value) : [];
            const ids = Array.isArray(parsed)
              ? parsed.map(n => parseInt(n, 10)).filter(n => Number.isInteger(n) && n > 0)
              : [];

            if (ids.length > 0) {
              const ph = ids.map(() => '?').join(',');
              targetRows = await driver.prepare(
                `SELECT id FROM channels WHERE is_dm = 0 AND is_private = 0 AND (code_visibility IS NULL OR code_visibility != 'private') AND id IN (${ph})`
              ).all(...ids);
            }
          } catch {
            targetRows = []; // a malformed default_join_channels setting: join nothing extra
          }

          if (targetRows.length === 0) {
            targetRows = await driver.prepare(
              "SELECT id FROM channels WHERE is_dm = 0 AND is_private = 0 AND (code_visibility IS NULL OR code_visibility != 'private') ORDER BY position, name"
            ).all();
          }

          if (targetRows.length > 0) {
            // Recheck the empty membership set and channel visibility in the
            // insert itself. Concurrent repairs share the membership primary key.
            const ids = targetRows.map(row => row.id);
            const marks = ids.map(() => '?').join(',');
            await driver.prepare(`
              INSERT INTO channel_members (channel_id, user_id)
              SELECT id, ? FROM channels
              WHERE id IN (${marks}) AND is_dm = 0 AND is_private = 0
                AND (code_visibility IS NULL OR code_visibility != 'private')
                AND NOT EXISTS (SELECT 1 FROM channel_members WHERE user_id = ?)
              ON CONFLICT(channel_id, user_id) DO NOTHING
            `).run(userId, ...ids, userId);
            channels = await driver.prepare(`
              SELECT c.id, c.name, c.code, c.created_by, c.topic, c.is_dm, c.is_group,
                     c.code_visibility, c.code_mode, c.code_rotation_type, c.code_rotation_interval,
                     c.parent_channel_id, c.position, c.is_private, c.expires_at, c.is_temp_voice,
                     c.streams_enabled, c.music_enabled, c.media_enabled, c.soundboard_enabled, c.reactions_enabled, c.slow_mode_interval, c.category, c.sort_alphabetical,
                     c.cleanup_exempt, c.channel_type, c.voice_user_limit, c.notification_type, c.voice_enabled, c.text_enabled, c.voice_bitrate,
                     c.afk_sub_code, c.afk_timeout_minutes, c.read_only, c.auto_delete_mode, c.auto_delete_interval_hours, c.default_role_id, c.show_welcome, c.is_forum, c.forum_tags, c.is_nsfw, c.former_names, c.role_gate, c.forum_layout, c.forum_votes, c.forum_blog, c.forum_blog_pics_only, c.type_id
              FROM channels c
              JOIN channel_members cm ON c.id = cm.channel_id
              WHERE cm.user_id = ?
              ORDER BY c.is_dm, c.position, c.name
            `).all(userId);
          }
        }
      }
    }

    return channels;
  }

  async function getEnrichedChannelsAsync(userId, isAdmin, joinRooms, shared = null) {
    // Membership repair, permission checks and joining rooms used to run
    // without yielding on SQLite. Keep that whole operation atomic behind
    // this promise until its write paths have async transaction support.
    const driver = db.async;
    if (!driver || driver.kind === 'sqlite') return getEnrichedChannels(userId, isAdmin, joinRooms, shared);
    const asyncPermissions = createAsyncPermissions(driver);
    let channels = await getChannelRowsAsync(userId, isAdmin, driver, asyncPermissions);

    // A role gate hides the channel from anyone who fails it, membership or
    // not. Admins see everything, as they do for private channels.
    if (!isAdmin) {
      const visible = [];
      for (const ch of channels) {
        if (ch.is_dm || await asyncPermissions.roleGateAllows(userId, ch)) visible.push(ch);
      }
      channels = visible;
    }

    if (channels.length > 0) {
      const channelIds = channels.map(c => c.id);
      const placeholders = channelIds.map(() => '?').join(',');

      const readRows = await driver.prepare(
        `SELECT channel_id, last_read_message_id FROM read_positions WHERE user_id = ? AND channel_id IN (${placeholders})`
      ).all(userId, ...channelIds);
      const readMap = {};
      readRows.forEach(r => { readMap[r.channel_id] = r.last_read_message_id; });

      const latestMap = {};
      const unknown = shared ? channelIds.filter(id => !shared.latest.has(id)) : channelIds;
      if (unknown.length) {
        const latestRows = await driver.prepare(
          `SELECT channel_id, MAX(id) as latest_id FROM messages WHERE channel_id IN (${unknown.map(() => '?').join(',')}) AND thread_id IS NULL GROUP BY channel_id`
        ).all(...unknown);
        if (shared) unknown.forEach(id => shared.latest.set(id, 0));
        latestRows.forEach(r => { latestMap[r.channel_id] = r.latest_id; if (shared) shared.latest.set(r.channel_id, r.latest_id); });
      }
      if (shared) channelIds.forEach(id => { latestMap[id] = shared.latest.get(id) || 0; });

      for (const ch of channels) {
        // A group DM member's count starts where their history does.
        const lastRead = Math.max(readMap[ch.id] || 0, await groupHistoryFloorAsync(driver, ch, userId));
        const latestId = latestMap[ch.id] || 0;
        ch.latestMessageId = latestId;
        if (latestId > lastRead) {
          const countRow = await driver.prepare(
            // Exclude thread replies (thread_id IS NOT NULL): they live in their
            // own thread panel, never appear in the channel scroll, and so can
            // never be marked-read by scrolling. Counting them here pins a
            // phantom unread on the channel forever.
            // Counting stops at 1000: badges show 99+ past 99 anyway, and an
            // uncapped count walked every unread message of a long-idle member
            // on every channel-list refresh.
            // (user_id IS NULL OR ...): imported and relayed messages belong
            // to no account, and NULL != ? is never true, so they never
            // counted (#5771). A group DM's "joined" / "left" lines are not
            // new messages.
            "SELECT COUNT(*) as cnt FROM (SELECT 1 FROM messages WHERE channel_id = ? AND id > ? AND (user_id IS NULL OR user_id != ?) AND thread_id IS NULL AND COALESCE(type, 'user') != 'notice' LIMIT 1000)"
          ).get(ch.id, lastRead, userId);
          ch.unreadCount = countRow ? countRow.cnt : 0;
        } else {
          ch.unreadCount = 0;
        }
        // A forum's replies are not counted above, so it reports its unread
        // topics separately for the sidebar dot.
        if (ch.is_forum) {
          try {
            ch.forumUnread = await forumUnread.countAsync(db, userId, ch.id);
          } catch (err) {
            console.warn('[forum-unread] count failed:', err.message);
            ch.forumUnread = 0;
          }
        }

        // Whether this viewer may post in a read-only channel, answered per
        // channel. The client only ever had a flat permission list that merges
        // server-wide grants with every channel-scoped one, so holding
        // read_only_override in a single channel made the composer appear in
        // every read-only channel. The send was still refused server-side, so
        // the box looked usable and silently was not. (#5468)
        if (ch.read_only === 1 && !ch.is_dm) {
          ch.canOverrideReadOnly = isAdmin || await asyncPermissions.userHasPermission(userId, 'read_only_override', ch.id);
        }

        // Whether this viewer may invite someone into this private channel.
        // Mirrors the rule the invite-to-channel handler already enforces:
        // admin, the channel's creator, or a moderator within that channel.
        // The menu only ever offered private channels to admins, so creators
        // and channel moderators held the right with no way to use it. This
        // does not widen the rule, it just lets the UI match it. (#5466)
        if (!ch.is_dm && (ch.is_private || ch.code_visibility === 'private')) {
          ch.canInvitePrivate = isAdmin
            || ch.created_by === userId
            || await asyncPermissions.userHasPermission(userId, 'kick_user', ch.id);
        }

        // Same per-channel answer for the two channel-management surfaces the
        // flat permission list gets wrong. Holding manage_channel_settings in
        // one channel put "Channel Functions" in every channel's menu, and
        // holding manage_sub_channels in one channel offered "Create
        // Sub-channel" everywhere. Both were refused server-side, so the
        // controls were there but dead. (#5467)
        if (!ch.is_dm) {
          ch.canManageSettings = isAdmin || await asyncPermissions.userHasPermission(userId, 'manage_channel_settings', ch.id);
          ch.canManageSubs = isAdmin || await asyncPermissions.userHasPermission(userId, 'manage_sub_channels', ch.id);
        }

        if (ch.is_dm) {
          const otherUser = await driver.prepare(`
            SELECT u.id, COALESCE(u.display_name, u.username) as username,
                   u.avatar, u.avatar_shape AS "avatarShape"
            FROM users u
            JOIN channel_members cm ON u.id = cm.user_id
            WHERE cm.channel_id = ? AND u.id != ?
          `).get(ch.id, userId);
          if (ch.is_group) {
            ch.dm_target = otherUser || null;
            ch.group_members = await driver.prepare(`
              SELECT u.id, COALESCE(u.display_name, u.username) as username, u.avatar, u.avatar_shape AS "avatarShape"
              FROM users u JOIN channel_members cm ON u.id = cm.user_id WHERE cm.channel_id = ? ORDER BY u.id
            `).all(ch.id);
            ch.group_pending = await driver.prepare(`
              SELECT u.id, COALESCE(u.display_name, u.username) as username
              FROM users u JOIN dm_group_invites i ON u.id = i.user_id WHERE i.channel_id = ? ORDER BY u.id
            `).all(ch.id);
          } else if (otherUser) {
            ch.dm_target = otherUser;
          } else {
            // Self-DM: only one channel_members row, no "other" user. Use self as the partner.
            const self = await driver.prepare(
              'SELECT id, COALESCE(display_name, username) as username, avatar, avatar_shape AS "avatarShape" FROM users WHERE id = ?'
            ).get(userId);
            ch.dm_target = self || null;
            ch.is_self_dm = 1;
          }
          // Who in this DM skips the link filter: the browser checks links in
          // encrypted messages itself, and marked an admin's links blocked.
          try {
            const members = await driver.prepare(`
              SELECT u.id, u.is_admin FROM users u JOIN channel_members cm ON u.id = cm.user_id WHERE cm.channel_id = ?
            `).all(ch.id);
            ch.link_exempt_ids = [];
            for (const m of members) {
              if (automod.linkExempt({ isAdmin: !!m.is_admin, effectiveLevel: await asyncPermissions.getUserEffectiveLevel(m.id) })) ch.link_exempt_ids.push(m.id);
            }
          } catch (err) {
            // Nobody counted as exempt: links are checked as before.
            console.warn('[automod] DM exemption lookup failed:', err.message);
            ch.link_exempt_ids = [];
          }
        }
      }
    }

    if (joinRooms) {
      channels.forEach(ch => joinRooms(`channel:${ch.code}`));
    }

    for (const ch of channels) {
      // DM channels route by code internally but the code is a pure implementation
      // detail. Never expose it as a copyable value: strip all code-related fields
      // so no client surface can accidentally reveal or share it.
      if (ch.is_dm) {
        ch.display_code = null;
        delete ch.code_visibility;
        delete ch.code_mode;
        delete ch.code_rotation_type;
        delete ch.code_rotation_interval;
        continue;
      }
      if (isAdmin) {
        ch.display_code = ch.code;
      } else if (ch.code_visibility === 'private' || ch.is_private) {
        const isMod = ch.created_by === userId || await asyncPermissions.userHasPermission(userId, 'kick_user', ch.id);
        ch.display_code = isMod ? ch.code : '••••••••';
      } else {
        ch.display_code = ch.code;
      }
    }

    return channels;
  }

  return { getEnrichedChannels, getEnrichedChannelsAsync };
};
