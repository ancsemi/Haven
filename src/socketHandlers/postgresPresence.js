'use strict';

const { parseStatus, readStatus, updateStatus, dmChannelCodes } = require('./profileStatus');
const { parseBorderTransform } = require('./helpers');
const { parseRoleGate } = require('../roleGate');
const { postingSettings, checkText } = require('./postgresPosting');

async function channelMembers(db, channel, permissions) {
  const rows = await db.prepare(`
    SELECT u.id, u.username AS "loginName", COALESCE(u.display_name, u.username) AS username,
           u.is_admin, u.is_guest, u.status, u.status_text, u.avatar, u.avatar_shape,
           u.border, u.border_transform, u.animate_profile,
           CASE WHEN u.birthday_hidden = 0 THEN substr(u.birthday, 6) END AS birthday
    FROM channel_members cm
    JOIN users u ON u.id = cm.user_id
    WHERE cm.channel_id = ? AND NOT EXISTS (SELECT 1 FROM bans b WHERE b.user_id = u.id)
    ORDER BY COALESCE(u.display_name, u.username)
  `).all(channel.id);
  if (!parseRoleGate(channel.role_gate)) return rows;
  const allowed = [];
  for (const row of rows) {
    if (row.is_admin || await permissions.roleGateAllows(row.id, channel)) allowed.push(row);
  }
  return allowed;
}

function createPostgresPresence(io, db, permissions) {
  const statusWrites = new Map();

  async function emitMembers(code) {
    const room = 'channel:' + code;
    if (!io.sockets.adapter.rooms.has(room)) return;
    const channel = await db.prepare('SELECT id, code, is_dm, role_gate FROM channels WHERE code = ?').get(code);
    if (!channel) return;
    const rows = await channelMembers(db, channel, permissions);
    const mode = (await db.prepare("SELECT value FROM server_settings WHERE key = 'member_visibility'").get())?.value || 'online';
    const members = new Set(rows.map(row => row.id));
    const live = new Map([...io.sockets.sockets.values()].map(socket => [socket.user.id, socket.user]));
    const users = [];
    if (mode !== 'none') {
      for (const row of rows) {
        const online = live.has(row.id);
        if (mode !== 'all' && !online) continue;
        users.push({
          id: row.id, username: row.username, loginName: row.loginName, online,
          avatar: row.avatar, avatarShape: row.avatar_shape || 'circle', avatar_shape: row.avatar_shape || 'circle',
          isAdmin: !!row.is_admin, isGuest: !!row.is_guest,
          border: row.border, borderTransform: parseBorderTransform(row.border_transform),
          animateProfile: row.animate_profile || 'trigger', birthday: row.birthday,
          status: row.status || 'online', statusText: row.status_text || '',
          roles: await permissions.getUserRoles(row.id), effectiveLevel: await permissions.getUserEffectiveLevel(row.id, channel.id),
        });
      }
    }
    // A status write or disconnect can finish while roles are loading.
    // Read the latest live state before hiding invisible members.
    const current = new Map([...io.sockets.sockets.values()].map(socket => [socket.user.id, socket.user]));
    for (const member of users) {
      const user = current.get(member.id);
      member.online = !!user;
      if (!user) continue;
      member.status = user.status;
      member.statusText = user.statusText;
    }
    const publicUsers = [];
    const hidden = new Map();
    for (const member of users) {
      if (mode !== 'all' && !member.online) continue;
      if (member.status !== 'invisible') {
        publicUsers.push(member);
        continue;
      }
      hidden.set(member.id, member);
      if (mode === 'all') publicUsers.push({ ...member, status: 'offline', online: false });
    }
    for (const id of io.sockets.adapter.rooms.get(room) || []) {
      const socket = io.sockets.sockets.get(id);
      if (!socket || (!members.has(socket.user.id) && (!socket.user.isAdmin || channel.is_dm))) continue;
      const own = hidden.get(socket.user.id);
      const visible = own ? publicUsers.filter(member => member.id !== own.id).concat(own) : publicUsers;
      socket.emit('online-users', { channelCode: code, users: visible, visibilityMode: mode });
    }
  }

  async function refreshUser(userId, extraCode) {
    const dms = await dmChannelCodes(db, userId);
    const codes = new Set(dms.map(row => row.code));
    if (extraCode) codes.add(extraCode);
    for (const peer of io.sockets.sockets.values()) {
      if (peer.user.id === userId && peer.currentChannel) codes.add(peer.currentChannel);
    }
    for (const code of codes) await emitMembers(code);
  }

  async function queueStatus(userId, update) {
    const previous = statusWrites.get(userId);
    // Serialise status changes and reconnects across every device of one account.
    const change = (previous || Promise.resolve())
      .catch(() => { /* the earlier request reports its own failure */ })
      .then(update);
    statusWrites.set(userId, change);
    try {
      return await change;
    } finally {
      if (statusWrites.get(userId) === change) statusWrites.delete(userId);
    }
  }

  function notifyStatus(userId, next) {
    for (const peer of io.sockets.sockets.values()) {
      if (peer.user.id !== userId) continue;
      Object.assign(peer.user, next);
      peer.emit('status-updated', next);
    }
  }

  function statusOnConnect(userId) {
    return queueStatus(userId, async () => {
      let row = await readStatus(db, userId);
      if (row?.status === 'away') {
        const reset = await db.prepare("UPDATE users SET status = 'online' WHERE id = ? AND status = 'away' RETURNING status, status_text")
          .get(userId);
        if (reset) notifyStatus(userId, { status: reset.status, statusText: reset.status_text || '' });
        row = reset || await readStatus(db, userId);
      }
      return { status: row?.status || 'online', statusText: row?.status_text || '' };
    });
  }

  function setStatus(socket, data) {
    const next = parseStatus(data);
    if (!next) return;
    const user = socket.user;
    return queueStatus(user.id, async () => {
      if (next.statusText && !user.isAdmin) {
        const saved = await postingSettings(db);
        const level = saved.automod_enabled === 'true' ? await permissions.getUserEffectiveLevel(user.id) : 0;
        await checkText(db, next.statusText, user, saved, { surface: 'profile', effectiveLevel: level });
      }
      const result = await updateStatus(db, user.id, next);
      if (!result.changes) return;
      notifyStatus(user.id, next);
      try {
        await refreshUser(user.id);
      } catch (err) {
        console.warn('[postgres-preview] status presence refresh failed:', err.code || err.message);
      }
    });
  }

  return { emitMembers, refreshUser, setStatus, statusOnConnect };
}

module.exports = { createPostgresPresence, channelMembers };
