'use strict';

const bcrypt = require('bcryptjs');
const { isString, isInt, VALID_ROLE_PERMS } = require('./helpers');

module.exports = function register(socket, ctx) {
  const {
    io, db, state, userHasPermission, getUserEffectiveLevel,
    getUserPermissions, getUserRoles, getUserHighestRole,
    emitOnlineUsers, broadcastChannelLists, getEnrichedChannels,
    transferAdminRef, HAVEN_VERSION, logAudit
  } = ctx;
  const { channelUsers } = state;
  const _audit = (typeof logAudit === 'function') ? logAudit : () => {};

  // ── Helper: apply role-linked channel access ────────────
  function applyRoleChannelAccess(roleId, userId, direction) {
    const role = db.prepare('SELECT link_channel_access FROM roles WHERE id = ?').get(roleId);
    if (!role || !role.link_channel_access) return;

    const col = direction === 'grant' ? 'grant_on_promote' : 'revoke_on_demote';
    const channelRows = db.prepare(
      `SELECT channel_id FROM role_channel_access WHERE role_id = ? AND ${col} = 1`
    ).all(roleId);

    if (direction === 'grant') {
      const ins = db.prepare('INSERT OR IGNORE INTO channel_members (channel_id, user_id) VALUES (?, ?)');
      channelRows.forEach(r => ins.run(r.channel_id, userId));
    } else {
      const del = db.prepare('DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?');
      channelRows.forEach(r => del.run(r.channel_id, userId));
    }

    for (const [, s] of io.sockets.sockets) {
      if (s.user && s.user.id === userId) {
        s.emit('channels-list', getEnrichedChannels(userId, s.user.isAdmin, (room) => s.join(room)));
      }
    }
  }

  // Expose on ctx so other modules can use it if needed
  ctx.applyRoleChannelAccess = applyRoleChannelAccess;

  // ── Notify helper: refresh a user's role state on all sockets ──
  function refreshUserRoles(userId) {
    for (const [, s] of io.sockets.sockets) {
      if (s.user && s.user.id === userId) {
        s.user.roles = getUserRoles(userId);
        s.user.effectiveLevel = getUserEffectiveLevel(userId);
        s.emit('roles-updated', {
          roles: s.user.roles,
          effectiveLevel: s.user.effectiveLevel,
          permissions: getUserPermissions(userId)
        });
      }
    }
    for (const [code] of channelUsers) { emitOnlineUsers(code); }
  }

  // ── Get roles ───────────────────────────────────────────
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
    else if (typeof data === 'function') data({ roles });
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

  // ── Get channel member roles ────────────────────────────
  socket.on('get-channel-member-roles', (data, callback) => {
    if (!data || typeof data !== 'object') return;
    const cb = typeof callback === 'function' ? callback : () => {};
    if (!socket.user.isAdmin && !userHasPermission(socket.user.id, 'manage_roles')) {
      return cb({ error: 'Only admins can view channel roles' });
    }

    const code = typeof data.code === 'string' ? data.code.trim() : '';
    if (!code || !/^[a-f0-9]{8}$/i.test(code)) return cb({ error: 'Invalid channel' });

    const channel = db.prepare('SELECT id, name FROM channels WHERE code = ?').get(code);
    if (!channel) return cb({ error: 'Channel not found' });

    const members = db.prepare(`
      SELECT u.id, COALESCE(u.display_name, u.username) as displayName,
             u.username as loginName, u.avatar, u.avatar_shape, u.is_admin
      FROM users u
      JOIN channel_members cm ON u.id = cm.user_id
      WHERE cm.channel_id = ?
      ORDER BY COALESCE(u.display_name, u.username)
    `).all(channel.id);

    const memberIds = members.map(m => m.id);
    const userRolesMap = {};
    if (memberIds.length > 0) {
      const placeholders = memberIds.map(() => '?').join(',');
      const roleRows = db.prepare(`
        SELECT ur.user_id, r.id as role_id, r.name, r.level, r.color, r.icon, ur.channel_id
        FROM user_roles ur
        JOIN roles r ON ur.role_id = r.id
        WHERE ur.user_id IN (${placeholders})
          AND (ur.channel_id IS NULL OR ur.channel_id = ?)
        ORDER BY r.level DESC
      `).all(...memberIds, channel.id);
      roleRows.forEach(row => {
        if (!userRolesMap[row.user_id]) userRolesMap[row.user_id] = [];
        userRolesMap[row.user_id].push({
          roleId: row.role_id, name: row.name, level: row.level,
          color: row.color, icon: row.icon, scope: row.channel_id ? 'channel' : 'server'
        });
      });
    }

    const result = members.map(m => ({
      id: m.id, displayName: m.displayName, loginName: m.loginName,
      avatar: m.avatar, avatarShape: m.avatar_shape || 'circle',
      isAdmin: !!m.is_admin, roles: userRolesMap[m.id] || []
    }));

    cb({ channelId: channel.id, channelName: channel.name, members: result });
  });

  // ── Create role ─────────────────────────────────────────
  socket.on('create-role', (data, callback) => {
    if (!data || typeof data !== 'object') return;
    const cb = typeof callback === 'function' ? callback : () => {};
    if (!socket.user.isAdmin && !userHasPermission(socket.user.id, 'manage_roles')) {
      return cb({ error: 'Only admins can create roles' });
    }

    const name = isString(data.name, 1, 30) ? data.name.trim() : '';
    if (!name) return cb({ error: 'Role name required (1-30 chars)' });

    const level = isInt(data.level) && data.level >= 1 && data.level <= 99 ? data.level : 25;
    const scope = data.scope === 'channel' ? 'channel' : 'server';
    const color = isString(data.color, 4, 7) && /^#[0-9a-fA-F]{3,6}$/.test(data.color) ? data.color : null;
    const autoAssign = data.autoAssign ? 1 : 0;
    const icon = isString(data.icon, 1, 512) && /^\/uploads\//i.test(data.icon) ? data.icon : null;

    try {
      if (autoAssign) {
        db.prepare('UPDATE roles SET auto_assign = 0').run();
      }
      const result = db.prepare(
        'INSERT INTO roles (name, level, scope, color, auto_assign, icon) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(name, level, scope, color, autoAssign, icon);

      const perms = Array.isArray(data.permissions) ? data.permissions : [];
      const adminOnlyPerms = ['transfer_admin', 'manage_roles', 'manage_server', 'delete_channel'];
      const insertPerm = db.prepare('INSERT OR IGNORE INTO role_permissions (role_id, permission, allowed) VALUES (?, ?, 1)');
      perms.forEach(p => {
        if (!VALID_ROLE_PERMS.includes(p)) return;
        if (!socket.user.isAdmin && (adminOnlyPerms.includes(p) || !userHasPermission(socket.user.id, p))) return;
        insertPerm.run(result.lastInsertRowid, p);
      });

      cb({ success: true, roleId: result.lastInsertRowid });
      _audit({ actor: socket.user, action: 'role_create',
        target_type: 'role', target_id: result.lastInsertRowid, target_name: name,
        details: { level, scope, color, autoAssign: !!autoAssign, permissions: perms } });
    } catch (err) {
      console.error('Create role error:', err);
      cb({ error: 'Failed to create role' });
    }
  });

  // ── Update role ─────────────────────────────────────────
  socket.on('update-role', (data, callback) => {
    if (!data || typeof data !== 'object') return;
    const cb = typeof callback === 'function' ? callback : () => {};
    if (!socket.user.isAdmin && !userHasPermission(socket.user.id, 'manage_roles')) {
      return cb({ error: 'Only admins can edit roles' });
    }

    const roleId = isInt(data.roleId) ? data.roleId : null;
    if (!roleId) return;

    const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(roleId);
    if (!role) return cb({ error: 'Role not found' });

    const updateRoleTx = db.transaction(() => {
      const updates = [];
      const values = [];

      if (isString(data.name, 1, 30)) { updates.push('name = ?'); values.push(data.name.trim()); }
      if (isInt(data.level) && data.level >= 1 && data.level <= 99) { updates.push('level = ?'); values.push(data.level); }
      if (data.color !== undefined) {
        const safeColor = (isString(data.color, 4, 7) && /^#[0-9a-fA-F]{3,6}$/.test(data.color)) ? data.color : null;
        updates.push('color = ?'); values.push(safeColor);
      }
      if (data.icon !== undefined) {
        const safeIcon = (isString(data.icon, 1, 512) && /^\/uploads\//i.test(data.icon)) ? data.icon : null;
        updates.push('icon = ?'); values.push(safeIcon);
      }
      if (data.autoAssign !== undefined) {
        if (data.autoAssign) {
          db.prepare('UPDATE roles SET auto_assign = 0').run();
        }
        updates.push('auto_assign = ?'); values.push(data.autoAssign ? 1 : 0);
      }
      if (data.linkChannelAccess !== undefined) {
        updates.push('link_channel_access = ?'); values.push(data.linkChannelAccess ? 1 : 0);
      }

      if (updates.length > 0) {
        values.push(roleId);
        db.prepare(`UPDATE roles SET ${updates.join(', ')} WHERE id = ?`).run(...values);
      }

      if (Array.isArray(data.permissions)) {
        const adminOnlyPerms = ['transfer_admin', 'manage_roles', 'manage_server', 'delete_channel'];
        db.prepare('DELETE FROM role_permissions WHERE role_id = ?').run(roleId);
        const insertPerm = db.prepare('INSERT INTO role_permissions (role_id, permission, allowed) VALUES (?, ?, 1)');
        data.permissions.forEach(p => {
          if (!VALID_ROLE_PERMS.includes(p)) return;
          if (!socket.user.isAdmin && (adminOnlyPerms.includes(p) || !userHasPermission(socket.user.id, p))) return;
          insertPerm.run(roleId, p);
        });
      }
    });
    updateRoleTx();

    const freshRoles = db.prepare('SELECT * FROM roles ORDER BY level DESC').all();
    const perms = db.prepare('SELECT * FROM role_permissions').all();
    const pm = {};
    perms.forEach(p => { if (!pm[p.role_id]) pm[p.role_id] = []; pm[p.role_id].push(p.permission); });
    freshRoles.forEach(r => { r.permissions = pm[r.id] || []; });

    for (const [code] of channelUsers) { emitOnlineUsers(code); }
    socket.broadcast.emit('roles-updated');
    cb({ success: true, roles: freshRoles });
    _audit({ actor: socket.user, action: 'role_update',
      target_type: 'role', target_id: roleId, target_name: role.name,
      details: {
        nameChanged: data.name !== undefined,
        levelChanged: data.level !== undefined,
        permissionsChanged: Array.isArray(data.permissions),
        permissions: Array.isArray(data.permissions) ? data.permissions : undefined
      } });
  });

  // ── Delete role ─────────────────────────────────────────
  socket.on('delete-role', (data, callback) => {
    if (!data || typeof data !== 'object') return;
    const cb = typeof callback === 'function' ? callback : () => {};
    if (!socket.user.isAdmin && !userHasPermission(socket.user.id, 'manage_roles')) {
      return cb({ error: 'Only admins can delete roles' });
    }

    const roleId = isInt(data.roleId) ? data.roleId : null;
    if (!roleId) return;

    db.prepare('DELETE FROM user_roles WHERE role_id = ?').run(roleId);
    db.prepare('DELETE FROM role_permissions WHERE role_id = ?').run(roleId);
    db.prepare('DELETE FROM role_channel_access WHERE role_id = ?').run(roleId);
    db.prepare('DELETE FROM roles WHERE id = ?').run(roleId);
    for (const [code] of channelUsers) { emitOnlineUsers(code); }
    cb({ success: true });
    _audit({ actor: socket.user, action: 'role_delete',
      target_type: 'role', target_id: roleId, target_name: null,
      details: null });
  });

  // ── Reset roles to default ─────────────────────────────
  socket.on('reset-roles-to-default', (data, callback) => {
    const cb = typeof callback === 'function' ? callback : () => {};
    if (!socket.user.isAdmin) return cb({ error: 'Only admins can reset roles' });

    try {
      db.exec('DELETE FROM user_roles');
      db.exec('DELETE FROM role_permissions');
      db.exec('DELETE FROM role_channel_access');
      db.exec('DELETE FROM roles');

      const insertRole = db.prepare('INSERT INTO roles (name, level, scope, color) VALUES (?, ?, ?, ?)');
      const insertPerm = db.prepare('INSERT INTO role_permissions (role_id, permission, allowed) VALUES (?, ?, 1)');

      const serverMod = insertRole.run('Server Mod', 50, 'server', '#3498db');
      ['kick_user','mute_user','delete_message','pin_message','set_channel_topic','manage_sub_channels','rename_channel','rename_sub_channel','delete_lower_messages','manage_webhooks','upload_files','use_voice','view_history','view_all_members','manage_music_queue','delete_own_messages','edit_own_messages']
        .forEach(p => insertPerm.run(serverMod.lastInsertRowid, p));

      const channelMod = insertRole.run('Channel Mod', 25, 'channel', '#2ecc71');
      ['kick_user','mute_user','delete_message','pin_message','manage_sub_channels','rename_sub_channel','delete_lower_messages','upload_files','use_voice','view_history','view_channel_members','manage_music_queue','delete_own_messages','edit_own_messages']
        .forEach(p => insertPerm.run(channelMod.lastInsertRowid, p));

      const userRole = insertRole.run('User', 1, 'server', '#95a5a6');
      db.prepare('UPDATE roles SET auto_assign = 1 WHERE id = ?').run(userRole.lastInsertRowid);
      ['delete_own_messages','edit_own_messages','upload_files','use_voice','view_history']
        .forEach(p => insertPerm.run(userRole.lastInsertRowid, p));

      const autoRoles = db.prepare('SELECT id FROM roles WHERE auto_assign = 1 AND scope = ?').all('server');
      for (const ar of autoRoles) {
        db.prepare(`
          INSERT OR IGNORE INTO user_roles (user_id, role_id, channel_id, granted_by)
          SELECT u.id, ?, NULL, NULL FROM users u
        `).run(ar.id);
      }

      for (const [code] of channelUsers) { emitOnlineUsers(code); }
      io.emit('roles-updated');
      cb({ success: true });
    } catch (err) {
      cb({ error: 'Failed to reset roles: ' + err.message });
    }
  });

  // ── Get role assignment data (three-pane) ───────────────
  socket.on('get-role-assignment-data', (data, callback) => {
    if (!data || typeof data !== 'object') return;
    const cb = typeof callback === 'function' ? callback : () => {};
    if (!socket.user.isAdmin && !userHasPermission(socket.user.id, 'promote_user') && !userHasPermission(socket.user.id, 'manage_roles')) {
      return cb({ error: 'You lack permission to manage roles' });
    }

    try {
      const callerId = socket.user.id;
      const callerIsAdmin = socket.user.isAdmin;
      const callerServerLevel = getUserEffectiveLevel(callerId);

      const callerChannels = db.prepare(`
        SELECT c.id, c.name, c.code, c.parent_channel_id, c.position
        FROM channels c
        JOIN channel_members cm ON c.id = cm.channel_id
        WHERE cm.user_id = ? AND c.is_dm = 0
        ORDER BY c.position, c.name
      `).all(callerId);

      if (callerChannels.length === 0) {
        const roles = db.prepare('SELECT * FROM roles ORDER BY level DESC').all();
        const permissions = db.prepare('SELECT * FROM role_permissions').all();
        const permMap = {};
        permissions.forEach(p => { if (!permMap[p.role_id]) permMap[p.role_id] = []; permMap[p.role_id].push(p.permission); });
        roles.forEach(r => { r.permissions = permMap[r.id] || []; });
        return cb({ users: [], userChannelMap: {}, channels: [], roles, callerPerms: getUserPermissions(callerId), callerLevel: callerServerLevel, callerIsAdmin });
      }

      const allMembers = db.prepare(`
        SELECT DISTINCT u.id, u.username, COALESCE(u.display_name, u.username) as displayName,
               u.avatar, u.avatar_shape, u.is_admin
        FROM users u
        JOIN channel_members cm ON u.id = cm.user_id
        WHERE cm.channel_id IN (${callerChannels.map(() => '?').join(',')})
          AND u.id != ?
        ORDER BY COALESCE(u.display_name, u.username)
      `).all(...callerChannels.map(c => c.id), callerId);

      const users = [];
      const userChannelMap = {};
      for (const m of allMembers) {
        if (m.is_admin) continue;
        const userServerLevel = getUserEffectiveLevel(m.id);
        if (!callerIsAdmin && userServerLevel >= callerServerLevel) continue;

        const uChans = db.prepare(`
          SELECT cm.channel_id FROM channel_members cm
          WHERE cm.user_id = ? AND cm.channel_id IN (${callerChannels.map(() => '?').join(',')})
        `).all(m.id, ...callerChannels.map(c => c.id));

        const sharedChannels = [];
        for (const uc of uChans) {
          const callerChanLevel = getUserEffectiveLevel(callerId, uc.channel_id);
          const userChanLevel = getUserEffectiveLevel(m.id, uc.channel_id);
          if (callerIsAdmin || callerChanLevel > userChanLevel) {
            sharedChannels.push(uc.channel_id);
          }
        }
        if (sharedChannels.length === 0 && !callerIsAdmin) continue;

        const currentRoles = db.prepare(`
          SELECT ur.role_id, ur.channel_id, r.name, r.level, r.color
          FROM user_roles ur
          JOIN roles r ON ur.role_id = r.id
          WHERE ur.user_id = ?
          GROUP BY ur.role_id, COALESCE(ur.channel_id, -1)
        `).all(m.id);

        users.push({
          id: m.id, username: m.username, displayName: m.displayName,
          avatar: m.avatar || null, avatarShape: m.avatar_shape || 'circle',
          serverLevel: userServerLevel, currentRoles
        });
        userChannelMap[m.id] = sharedChannels;
      }

      const channelsWithHierarchy = callerChannels.map(c => ({
        id: c.id, name: c.name, code: c.code,
        parentId: c.parent_channel_id, position: c.position
      }));

      const roles = db.prepare('SELECT * FROM roles ORDER BY level DESC').all();
      const permissions = db.prepare('SELECT * FROM role_permissions').all();
      const permMap = {};
      permissions.forEach(p => { if (!permMap[p.role_id]) permMap[p.role_id] = []; permMap[p.role_id].push(p.permission); });
      roles.forEach(r => { r.permissions = permMap[r.id] || []; });

      const callerPerms = getUserPermissions(callerId);

      cb({
        users, userChannelMap, channels: channelsWithHierarchy,
        roles, callerPerms, callerLevel: callerServerLevel, callerIsAdmin
      });
    } catch (err) {
      console.error('get-role-assignment-data error:', err);
      cb({ error: 'Failed to load role assignment data' });
    }
  });

  // ── Assign role ─────────────────────────────────────────
  socket.on('assign-role', (data, callback) => {
    const cb = typeof callback === 'function' ? callback : () => {};
    if (!data || typeof data !== 'object') return cb({ error: 'Invalid request' });
    if (!socket.user.isAdmin && !userHasPermission(socket.user.id, 'promote_user')) {
      return cb({ error: 'You lack permission to assign roles' });
    }

    const userId = isInt(data.userId) ? data.userId : null;
    const roleId = isInt(data.roleId) ? data.roleId : null;
    if (!userId || !roleId) return cb({ error: 'Missing userId or roleId' });

    if (userId === socket.user.id) {
      return cb({ error: 'You cannot modify your own roles' });
    }

    const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(roleId);
    if (!role) return cb({ error: 'Role not found' });

    if (!socket.user.isAdmin) {
      const myLevel = getUserEffectiveLevel(socket.user.id);
      if (role.level >= myLevel) {
        return cb({ error: `You can only assign roles below your level (${myLevel})` });
      }
    }

    const channelId = isInt(data.channelId) ? data.channelId : null;

    let assignLevel = role.level;
    if (data.customLevel !== undefined && data.customLevel !== null) {
      const cl = parseInt(data.customLevel);
      if (!isNaN(cl) && cl >= 1 && cl <= 99) {
        if (!socket.user.isAdmin) {
          const myLevel = getUserEffectiveLevel(socket.user.id);
          if (cl >= myLevel) {
            return cb({ error: `Custom level must be below your level (${myLevel})` });
          }
        }
        assignLevel = cl;
      }
    }

    try {
      if (channelId) {
        db.prepare('DELETE FROM user_roles WHERE user_id = ? AND channel_id = ?').run(userId, channelId);
      } else {
        db.prepare(
          `DELETE FROM user_roles WHERE user_id = ? AND channel_id IS NULL
           AND role_id IN (SELECT id FROM roles WHERE scope = ?)`
        ).run(userId, role.scope);
      }
      db.prepare(
        'INSERT INTO user_roles (user_id, role_id, channel_id, granted_by, custom_level) VALUES (?, ?, ?, ?, ?)'
      ).run(userId, roleId, channelId, socket.user.id, assignLevel !== role.level ? assignLevel : null);

      if (data.customPerms && Array.isArray(data.customPerms)) {
        if (channelId) {
          db.prepare('DELETE FROM user_role_perms WHERE user_id = ? AND role_id = ? AND channel_id = ?').run(userId, roleId, channelId);
        } else {
          db.prepare('DELETE FROM user_role_perms WHERE user_id = ? AND role_id = ? AND channel_id IS NULL').run(userId, roleId);
        }
        const rolePerms = db.prepare('SELECT permission FROM role_permissions WHERE role_id = ? AND allowed = 1').all(roleId).map(r => r.permission);
        const customPerms = data.customPerms.filter(p => typeof p === 'string');
        const added = customPerms.filter(p => !rolePerms.includes(p));
        const removed = rolePerms.filter(p => !customPerms.includes(p));
        if (added.length > 0 || removed.length > 0) {
          const insertStmt = db.prepare('INSERT INTO user_role_perms (user_id, role_id, channel_id, permission, allowed) VALUES (?, ?, ?, ?, ?)');
          for (const p of added) insertStmt.run(userId, roleId, channelId, p, 1);
          for (const p of removed) insertStmt.run(userId, roleId, channelId, p, 0);
        }
      }

      applyRoleChannelAccess(roleId, userId, 'grant');
      refreshUserRoles(userId);
      cb({ success: true });
      try {
        const tgt = db.prepare('SELECT COALESCE(display_name, username) AS u FROM users WHERE id = ?').get(userId);
        _audit({ actor: socket.user, action: 'role_assign',
          target_type: 'user', target_id: userId, target_name: tgt ? tgt.u : null,
          details: { roleId, roleName: role.name, channelId, customLevel: assignLevel !== role.level ? assignLevel : null } });
      } catch {}
    } catch (err) {
      console.error('Assign role error:', err);
      cb({ error: 'Failed to assign role' });
    }
  });

  // ── Revoke role ─────────────────────────────────────────
  socket.on('revoke-role', (data, callback) => {
    const cb = typeof callback === 'function' ? callback : () => {};
    if (!data || typeof data !== 'object') return cb({ error: 'Invalid request' });
    if (!socket.user.isAdmin && !userHasPermission(socket.user.id, 'promote_user')) {
      return cb({ error: 'You lack permission to revoke roles' });
    }

    const userId = isInt(data.userId) ? data.userId : null;
    const roleId = isInt(data.roleId) ? data.roleId : null;
    if (!userId || !roleId) return cb({ error: 'Missing userId or roleId' });

    if (userId === socket.user.id) {
      return cb({ error: 'You cannot modify your own roles' });
    }

    if (!socket.user.isAdmin) {
      const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(roleId);
      if (role) {
        const myLevel = getUserEffectiveLevel(socket.user.id);
        if (role.level >= myLevel) {
          return cb({ error: `You can only revoke roles below your level (${myLevel})` });
        }
      }
    }

    const channelId = isInt(data.channelId) ? data.channelId : null;

    applyRoleChannelAccess(roleId, userId, 'revoke');

    if (channelId) {
      db.prepare('DELETE FROM user_roles WHERE user_id = ? AND role_id = ? AND channel_id = ?').run(userId, roleId, channelId);
    } else {
      db.prepare('DELETE FROM user_roles WHERE user_id = ? AND role_id = ? AND channel_id IS NULL').run(userId, roleId);
    }

    const target = db.prepare('SELECT COALESCE(display_name, username) as username FROM users WHERE id = ?').get(userId);
    cb({ success: true, message: `Revoked role from ${target ? target.username : 'user'}` });

    try {
      const r = db.prepare('SELECT name FROM roles WHERE id = ?').get(roleId);
      _audit({ actor: socket.user, action: 'role_revoke',
        target_type: 'user', target_id: userId, target_name: target ? target.username : null,
        details: { roleId, roleName: r ? r.name : null, channelId } });
    } catch {}

    refreshUserRoles(userId);
  });

  // ── Role channel access ─────────────────────────────────
  socket.on('get-role-channel-access', (data, callback) => {
    if (!data || typeof data !== 'object') return;
    const cb = typeof callback === 'function' ? callback : () => {};
    if (!socket.user.isAdmin && !userHasPermission(socket.user.id, 'manage_roles')) {
      return cb({ error: 'Only admins can view role channel access' });
    }

    const roleId = isInt(data.roleId) ? data.roleId : null;
    if (!roleId) return cb({ error: 'Invalid role ID' });

    const rows = db.prepare('SELECT channel_id, grant_on_promote, revoke_on_demote FROM role_channel_access WHERE role_id = ?').all(roleId);
    const channels = db.prepare('SELECT id, name, parent_channel_id, is_dm, is_private, position FROM channels WHERE is_dm = 0 ORDER BY parent_channel_id IS NOT NULL, position, name').all();
    cb({ success: true, access: rows, channels });
  });

  socket.on('update-role-channel-access', (data, callback) => {
    if (!data || typeof data !== 'object') return;
    const cb = typeof callback === 'function' ? callback : () => {};
    if (!socket.user.isAdmin && !userHasPermission(socket.user.id, 'manage_roles')) {
      return cb({ error: 'Only admins can edit role channel access' });
    }

    const roleId = isInt(data.roleId) ? data.roleId : null;
    if (!roleId) return cb({ error: 'Invalid role ID' });
    if (!Array.isArray(data.access)) return cb({ error: 'Invalid access data' });

    try {
      const txn = db.transaction(() => {
        db.prepare('DELETE FROM role_channel_access WHERE role_id = ?').run(roleId);
        const ins = db.prepare('INSERT INTO role_channel_access (role_id, channel_id, grant_on_promote, revoke_on_demote) VALUES (?, ?, ?, ?)');
        data.access.forEach(a => {
          const chId = isInt(a.channelId) ? a.channelId : null;
          if (!chId) return;
          const grant = a.grant ? 1 : 0;
          const revoke = a.revoke ? 1 : 0;
          if (grant || revoke) ins.run(roleId, chId, grant, revoke);
        });
        if (data.linkEnabled !== undefined) {
          db.prepare('UPDATE roles SET link_channel_access = ? WHERE id = ?').run(data.linkEnabled ? 1 : 0, roleId);
        }
      });
      txn();
      cb({ success: true });
    } catch (err) {
      console.error('Update role channel access error:', err);
      cb({ error: 'Failed to update channel access' });
    }
  });

  socket.on('reapply-role-access', (data, callback) => {
    if (!data || typeof data !== 'object') return;
    const cb = typeof callback === 'function' ? callback : () => {};
    if (!socket.user.isAdmin && !userHasPermission(socket.user.id, 'manage_roles')) {
      return cb({ error: 'Only admins can reapply access' });
    }

    const roleId = isInt(data.roleId) ? data.roleId : null;
    if (!roleId) return cb({ error: 'Invalid role ID' });

    const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(roleId);
    if (!role) return cb({ error: 'Role not found' });
    if (!role.link_channel_access) return cb({ error: 'Channel access linking is not enabled for this role' });

    const roleUsers = db.prepare('SELECT DISTINCT user_id FROM user_roles WHERE role_id = ?').all(roleId);
    const grantChannels = db.prepare('SELECT channel_id FROM role_channel_access WHERE role_id = ? AND grant_on_promote = 1').all(roleId);
    const ins = db.prepare('INSERT OR IGNORE INTO channel_members (channel_id, user_id) VALUES (?, ?)');

    const txn = db.transaction(() => {
      roleUsers.forEach(u => {
        grantChannels.forEach(c => ins.run(c.channel_id, u.user_id));
      });
    });
    txn();

    broadcastChannelLists();
    cb({ success: true, affected: roleUsers.length });
  });

  // ── Promote user ────────────────────────────────────────
  socket.on('promote-user', (data, callback) => {
    if (!data || typeof data !== 'object') return;
    const cb = typeof callback === 'function' ? callback : () => {};

    const userId = isInt(data.userId) ? data.userId : null;
    const roleId = isInt(data.roleId) ? data.roleId : null;
    if (!userId || !roleId) return cb({ error: 'Invalid parameters' });
    if (userId === socket.user.id) return cb({ error: 'Cannot promote yourself' });

    const myLevel = getUserEffectiveLevel(socket.user.id);
    const hasPromotePerm = socket.user.isAdmin || userHasPermission(socket.user.id, 'promote_user');
    if (!hasPromotePerm) return cb({ error: 'You lack the promote_user permission' });

    const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(roleId);
    if (!role) return cb({ error: 'Role not found' });
    if (role.level >= myLevel) {
      return cb({ error: `You can only assign roles below your level (${myLevel})` });
    }

    const channelId = isInt(data.channelId) ? data.channelId : null;
    try {
      if (channelId) {
        db.prepare('DELETE FROM user_roles WHERE user_id = ? AND role_id = ? AND channel_id = ?').run(userId, roleId, channelId);
      } else {
        db.prepare('DELETE FROM user_roles WHERE user_id = ? AND role_id = ? AND channel_id IS NULL').run(userId, roleId);
      }
      db.prepare(
        'INSERT INTO user_roles (user_id, role_id, channel_id, granted_by) VALUES (?, ?, ?, ?)'
      ).run(userId, roleId, channelId, socket.user.id);

      refreshUserRoles(userId);
      cb({ success: true });
    } catch (err) {
      console.error('Promote user error:', err);
      cb({ error: 'Failed to promote user' });
    }
  });

  // ── Transfer admin ──────────────────────────────────────
  socket.on('transfer-admin', async (data, callback) => {
    if (!data || typeof data !== 'object') return;
    const cb = typeof callback === 'function' ? callback : () => {};

    if (!socket.user.isAdmin) return cb({ error: 'Only admins can transfer admin' });

    if (transferAdminRef.value) return cb({ error: 'A transfer is already in progress' });
    transferAdminRef.value = true;

    try {
      const password = typeof data.password === 'string' ? data.password : '';
      if (!password) { transferAdminRef.value = false; return cb({ error: 'Password is required for this action' }); }

      const adminUser = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(socket.user.id);
      if (!adminUser) { transferAdminRef.value = false; return cb({ error: 'Admin user not found' }); }

      let validPw;
      try {
        validPw = await bcrypt.compare(password, adminUser.password_hash);
        if (!validPw) { transferAdminRef.value = false; return cb({ error: 'Incorrect password' }); }
      } catch (err) {
        console.error('Password verification error:', err);
        transferAdminRef.value = false;
        return cb({ error: 'Password verification failed' });
      }

      const stillAdmin = db.prepare('SELECT is_admin FROM users WHERE id = ?').get(socket.user.id);
      if (!stillAdmin || !stillAdmin.is_admin) { transferAdminRef.value = false; return cb({ error: 'You are no longer an admin' }); }

      const userId = isInt(data.userId) ? data.userId : null;
      if (!userId) return cb({ error: 'Invalid user' });
      if (userId === socket.user.id) return cb({ error: 'Cannot transfer to yourself' });

      const targetUser = db.prepare('SELECT id, username, is_admin FROM users WHERE id = ?').get(userId);
      if (!targetUser) return cb({ error: 'User not found' });
      if (targetUser.is_admin) return cb({ error: 'User is already an admin' });

      try {
        const transferTxn = db.transaction(() => {
          db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(userId);
          db.prepare('UPDATE users SET is_admin = 0 WHERE id = ?').run(socket.user.id);

          let formerAdminRole = db.prepare("SELECT id FROM roles WHERE name = 'Former Admin' AND level = 99").get();
          if (!formerAdminRole) {
            const r = db.prepare("INSERT INTO roles (name, level, scope, color) VALUES ('Former Admin', 99, 'server', '#e74c3c')").run();
            formerAdminRole = { id: r.lastInsertRowid };
            const allPerms = [...VALID_ROLE_PERMS];
            const insertPerm = db.prepare('INSERT OR IGNORE INTO role_permissions (role_id, permission, allowed) VALUES (?, ?, 1)');
            allPerms.forEach(p => insertPerm.run(formerAdminRole.id, p));
          }
          db.prepare('DELETE FROM user_roles WHERE user_id = ? AND role_id = ? AND channel_id IS NULL').run(socket.user.id, formerAdminRole.id);
          db.prepare('INSERT INTO user_roles (user_id, role_id, channel_id, granted_by) VALUES (?, ?, NULL, ?)').run(
            socket.user.id, formerAdminRole.id, socket.user.id
          );
        });
        transferTxn();

        for (const [, s] of io.sockets.sockets) {
          if (s.user && s.user.id === userId) {
            s.user.isAdmin = true;
            s.user.roles = getUserRoles(userId);
            s.user.effectiveLevel = 100;
            s.emit('session-info', {
              id: s.user.id, username: s.user.username, isAdmin: true,
              displayName: s.user.displayName, avatar: s.user.avatar || null,
              avatarShape: s.user.avatar_shape || 'circle',
              version: HAVEN_VERSION, roles: s.user.roles,
              effectiveLevel: 100, permissions: ['*'],
              status: s.user.status || 'online',
              statusText: s.user.statusText || ''
            });
          }
          if (s.user && s.user.id === socket.user.id) {
            s.user.isAdmin = false;
            s.user.roles = getUserRoles(socket.user.id);
            s.user.effectiveLevel = getUserEffectiveLevel(socket.user.id);
            s.emit('session-info', {
              id: s.user.id, username: s.user.username, isAdmin: false,
              displayName: s.user.displayName, avatar: s.user.avatar || null,
              avatarShape: s.user.avatar_shape || 'circle',
              version: HAVEN_VERSION, roles: s.user.roles,
              effectiveLevel: s.user.effectiveLevel,
              permissions: getUserPermissions(socket.user.id),
              status: s.user.status || 'online',
              statusText: s.user.statusText || ''
            });
          }
        }
        for (const [code] of channelUsers) { emitOnlineUsers(code); }
        cb({ success: true, message: `Admin transferred to ${targetUser.username}` });
      } catch (err) {
        console.error('Transfer admin error:', err);
        cb({ error: 'Failed to transfer admin' });
      }
    } finally {
      transferAdminRef.value = false;
    }
  });
};
