'use strict';

const { CHANNEL_NAME_RE } = require('./helpers');
const createPermissions = require('./asyncPermissions');
const { channelMembers } = require('./postgresPresence');
const { postingSettings, checkText } = require('./postgresPosting');
const { COLUMN } = require('../channelTypes');
const { messageChannelMember } = require('../db/messageManagement');
const {
  roomForSettings, updateRoomSettings, renameRoom, normalizeCategory, roomTopic, subchannelSortMode,
  roomsForReorder, roomPositionUpdate,
} = require('../db/channelSettings');
const readAuditLog = require('../db/auditLog');

const postingFunctions = { text: 'Text chat', read_only: 'Read-only mode', reactions: 'Reactions' };

function roomCode(value) {
  const code = typeof value === 'string' ? value.trim() : '';
  return /^[a-f0-9]{8}$/i.test(code) ? code : null;
}

async function canReach(tx, user, room, permissions) {
  return user.isAdmin || (!!await messageChannelMember(tx, room.id, user.id) &&
    await permissions.roleGateAllows(user.id, room));
}

async function canOrganize(user, parentId, permissions) {
  return user.isAdmin || (!!parentId && await permissions.userHasPermission(user.id, 'manage_sub_channels', parentId)) ||
    await permissions.userHasPermission(user.id, 'create_channel', parentId || null);
}

async function requireRoomSettings(tx, user, room, permissions, action) {
  if (!user.isAdmin && (!await permissions.userHasPermission(user.id, 'manage_channel_settings', room.id) ||
      !await canReach(tx, user, room, permissions))) {
    throw new Error("You don't have permission to " + action);
  }
}

const settingAudit = (setting, value) => ({ details: { setting, value } });

function createPostgresChannelSettings({ io, db, permissions, broadcastChannelLists, logAudit }) {
  const pending = new Map();

  async function inRoomOrder(code, change) {
    // Keep live events for concurrent changes to one room in write order.
    const previous = pending.get(code) || Promise.resolve();
    const current = previous.catch(() => { /* reported by its own handler */ }).then(change);
    pending.set(code, current);
    try {
      await current;
    } finally {
      if (pending.get(code) === current) pending.delete(code);
    }
  }

  async function emitRoomEvent(room, { event, payload }) {
    const subscription = 'channel:' + room.code;
    if (!io.sockets.adapter.rooms.has(subscription)) return;
    const members = new Set((await channelMembers(db, room, permissions)).map(member => member.id));
    const receivers = [...(io.sockets.adapter.rooms.get(subscription) || [])].filter(id =>
      members.has(io.sockets.sockets.get(id)?.user?.id));
    if (receivers.length) io.to(receivers).emit(event, { code: room.code, ...payload });
  }

  return function register(socket, on) {
    const user = socket.user;

    function changeRoom(data, update) {
      const code = roomCode(data?.code);
      if (!code) return;
      return inRoomOrder(code, async () => {
        const { room, change } = await db.withTransaction(async tx => {
          // Posting takes a shared lock on this row, so the new rules apply
          // to sends in the order their transactions are committed.
          const room = await roomForSettings(tx, code);
          if (!room) throw new Error('Channel not found');
          return { room, change: await update(tx, room, createPermissions(tx)) };
        });
        if (!change) return;
        if (change.audit) await logAudit({
          actor: user, action: 'channel_setting_update',
          target_type: 'channel', target_id: room.id, target_name: room.name,
          ...change.audit,
        });
        if (change.event) {
          try { await emitRoomEvent(room, change); }
          catch (err) { console.warn('[postgres-preview] room settings notification failed:', err.code || err.message); }
        }
        broadcastChannelLists();
        if (change.toast) socket.emit('toast', { message: change.toast, type: 'success' });
      });
    }

    on('set-slow-mode', data => {
      if (!roomCode(data?.code)) return;
      const interval = parseInt(data.interval, 10);
      if (Number.isNaN(interval) || interval < 0 || interval > 3600) {
        throw new Error('Slow mode interval must be 0-3600 seconds');
      }
      return changeRoom(data, async (tx, room, perms) => {
        await requireRoomSettings(tx, user, room, perms, 'set slow mode');
        await updateRoomSettings(tx, room.id, { slow_mode_interval: interval });
        return {
          audit: settingAudit('slow_mode_seconds', interval),
          event: 'slow-mode-updated', payload: { interval },
          toast: interval > 0 ? `Slow mode set to ${interval}s` : 'Slow mode disabled',
        };
      });
    });

    on('toggle-channel-permission', data => {
      if (!roomCode(data?.code)) return;
      const permission = typeof data.permission === 'string' ? data.permission.trim() : '';
      if (!Object.hasOwn(postingFunctions, permission)) throw new Error('This channel function is not available on this server yet');
      return changeRoom(data, async (tx, room, perms) => {
        await requireRoomSettings(tx, user, room, perms, 'toggle channel permissions');
        const column = COLUMN[permission];
        const enabled = !room[column];
        const values = { [column]: enabled ? 1 : 0 };
        // A manual function change takes the room out of its channel type.
        if (room.type_id) values.type_id = null;
        await updateRoomSettings(tx, room.id, values);
        return {
          audit: settingAudit(permission, enabled), event: 'channel-permission-updated', payload: { permission, enabled },
          toast: `${postingFunctions[permission]} ${enabled ? 'enabled' : 'disabled'} for this channel`,
        };
      });
    });

    on('rename-channel', data => {
      if (!roomCode(data?.code)) return;
      const name = typeof data.name === 'string' ? data.name.trim() : '';
      if (!name || name.length > 50) throw new Error('Channel name must be 1-50 characters');
      if (!CHANNEL_NAME_RE.test(name)) throw new Error('Channel name contains invalid characters');
      return changeRoom(data, async (tx, room, perms) => {
        if (!await canReach(tx, user, room, perms)) throw new Error('Channel not found');
        const permission = room.parent_channel_id ? 'rename_sub_channel' : 'rename_channel';
        if (!user.isAdmin && !await perms.userHasPermission(user.id, permission, room.parent_channel_id || room.id)) {
          throw new Error("You don't have permission to rename channels");
        }
        await renameRoom(tx, room, name);
        return {
          audit: { action: 'channel_rename', target_name: name, details: { code: room.code, oldName: room.name, newName: name } },
          event: 'channel-renamed', payload: { name },
        };
      });
    });

    on('set-channel-topic', data => changeRoom(data, async (tx, room, perms) => {
      if (!await canReach(tx, user, room, perms)) return;
      if (!user.isAdmin && !await perms.userHasPermission(user.id, 'set_channel_topic', room.id)) {
        throw new Error("You don't have permission to set channel topics");
      }
      const topic = roomTopic(data.topic);
      // The topic is visible to everyone in the room, including any links.
      if (topic && !user.isAdmin) {
        const saved = await postingSettings(tx);
        const level = saved.automod_enabled === 'true' ? await perms.getUserEffectiveLevel(user.id, room.id) : 0;
        await checkText(tx, topic, user, saved, { surface: 'channel', effectiveLevel: level });
      }
      await updateRoomSettings(tx, room.id, { topic });
      return { audit: settingAudit('topic', topic), event: 'channel-topic-changed', payload: { topic } };
    }));

    on('set-channel-category', data => changeRoom(data, async (tx, room, perms) => {
      if (!await canReach(tx, user, room, perms) || !await canOrganize(user, room.parent_channel_id, perms)) {
        throw new Error("You don't have permission to set categories");
      }
      // Canonical casing is shared across rooms. Serialize its lookup and write.
      await tx.prepare("SELECT pg_advisory_xact_lock(hashtext(current_schema() || ':haven_channel_categories'))").get();
      const category = await normalizeCategory(tx, data.category, room.id);
      await updateRoomSettings(tx, room.id, { category });
      return { toast: category ? `Category set to "${category}"` : 'Category removed' };
    }));

    on('set-sort-alphabetical', data => changeRoom(data, async (tx, room, perms) => {
      await requireRoomSettings(tx, user, room, perms, 'change sort settings');
      await updateRoomSettings(tx, room.id, { sort_alphabetical: subchannelSortMode(data) });
      return {};
    }));

    on('reorder-channels', async data => {
      const order = data?.order;
      if (!Array.isArray(order) || order.length > 500) return;
      const positions = new Map();
      for (const item of order) {
        const code = roomCode(item?.code);
        if (code && Number.isSafeInteger(item.position)) positions.set(code, item.position);
      }
      if (!positions.size) return;
      await db.withTransaction(async tx => {
        const rooms = await roomsForReorder(tx, [...positions.keys()]);
        if (rooms.length !== positions.size) throw new Error('Channel not found');
        const parents = new Set(rooms.map(room => room.parent_channel_id));
        const parentId = parents.size === 1 ? rooms[0].parent_channel_id : null;
        const perms = createPermissions(tx);
        if (!await canOrganize(user, parentId, perms)) throw new Error("You don't have permission to reorder channels");
        for (const room of rooms) {
          if (!await canReach(tx, user, room, perms)) throw new Error("You don't have permission to reorder channels");
        }
        const update = roomPositionUpdate(tx);
        for (const room of rooms) await update.run(positions.get(room.code), room.code);
      });
      broadcastChannelLists();
    });

    on('set-notification-type', data => {
      if (!roomCode(data?.code)) return;
      const type = data.type;
      if (!['default', 'announcement'].includes(type)) throw new Error('Invalid notification type');
      return changeRoom(data, async (tx, room, perms) => {
        await requireRoomSettings(tx, user, room, perms, 'change channel notification type');
        await updateRoomSettings(tx, room.id, { notification_type: type });
        return {
          audit: settingAudit('notification_type', type),
          toast: type === 'announcement' ? '📢 Channel set to announcement mode' : '🔔 Channel notifications reset to default',
        };
      });
    });

    on('toggle-welcome-channel', data => {
      if (!roomCode(data?.code)) return;
      if (!user.isAdmin) throw new Error('Only admins can change welcome message settings');
      return changeRoom(data, async (tx, room) => {
        const enabled = !room.show_welcome;
        await updateRoomSettings(tx, room.id, { show_welcome: enabled ? 1 : 0 });
        return {
          audit: settingAudit('welcome_messages', enabled),
          toast: enabled ? '👋 New-member welcome messages will post in this channel' : 'Welcome messages disabled for this channel',
        };
      });
    });

    on('get-audit-log', async (opts, cb) => {
      if (typeof cb !== 'function') return;
      try {
        if (!user.isAdmin && !await permissions.userHasPermission(user.id, 'view_audit_log')) {
          return cb({ error: 'Permission denied' });
        }
        cb(await readAuditLog(db, opts, user.isAdmin));
      } catch (err) {
        console.error('get-audit-log error:', err);
        cb({ error: 'Failed to load audit log' });
      }
    });
  };
}

module.exports = { createPostgresChannelSettings };
