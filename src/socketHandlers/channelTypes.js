'use strict';

/**
 * Channel types (src/channelTypes.js): list them, make and edit them in
 * Settings, and set a channel's type from its right-click menu.
 *
 * Making, editing and deleting a type changes every channel that has it, so it
 * needs Manage Server (admins always). Setting one channel's type needs the
 * same right as its Channel Functions.
 */
const types = require('../channelTypes');

module.exports = function register(socket, ctx) {
  const { io, db, userHasPermission, broadcastChannelLists, handleVoiceLeave, broadcastVoiceUsers, botAudioManager, state } = ctx;

  const reply = (cb) => (typeof cb === 'function' ? cb : () => {});
  const canManageTypes = () => socket.user.isAdmin || userHasPermission(socket.user.id, 'manage_server');
  // The same check as Channel Functions (_canManageSettingsOf in channels.js).
  const canManageSettingsOf = (channel) => {
    if (socket.user.isAdmin) return true;
    if (!userHasPermission(socket.user.id, 'manage_channel_settings', channel.id)) return false;
    if (!db.prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?').get(channel.id, socket.user.id)) return false;
    return ctx.roleGateAllows(socket.user.id, channel);
  };
  const audit = (action, name, details) => {
    if (typeof ctx.logAudit === 'function') ctx.logAudit({ actor: socket.user, action, target_type: 'channel_type', target_name: name, details });
  };
  const sendTypes = () => io.except('bot-sockets').emit('channel-types', { types: types.listTypes(db) });

  // Gives the channel the type's functions and links it. Voice switched off
  // ends the call there, the same as switching it off in Channel Functions.
  const applyType = (channel, type) => {
    const changes = type ? types.changesFor(channel, type.functions) : [];
    db.transaction(() => {
      for (const [fn, value] of changes) {
        db.prepare(`UPDATE channels SET ${types.COLUMN[fn]} = ? WHERE id = ?`).run(value, channel.id);
      }
      db.prepare('UPDATE channels SET type_id = ? WHERE id = ?').run(type ? type.id : null, channel.id);
    })();
    const code = channel.code;
    if (changes.some(([fn, value]) => fn === 'voice' && !value)) {
      botAudioManager?.stopChannel(code, 'voice-disabled');
      const room = state.voiceUsers.get(code);
      if (room && room.size > 0) {
        for (const entry of Array.from(room.values())) {
          const target = io.sockets.sockets.get(entry.socketId);
          if (!target) continue;
          target.emit('voice-channel-gone', { code });
          handleVoiceLeave(target, code);
        }
        broadcastVoiceUsers(code);
      }
    }
    for (const [fn, value] of changes) {
      io.to(`channel:${code}`).emit('channel-permission-updated', { code, permission: fn, enabled: !!value });
    }
  };

  socket.on('get-channel-types', (_data, cb) => {
    reply(cb)({ types: types.listTypes(db) });
  });

  socket.on('save-channel-type', (data, cb) => {
    const respond = reply(cb);
    if (!canManageTypes()) return respond({ error: 'You need Manage Server to change channel types' });
    const clean = types.normalizeType(data);
    if (clean.error) return respond({ error: clean.error });
    const id = Number.isInteger(data.id) ? data.id : null;
    try {
      let saved;
      if (id) {
        if (!types.getType(db, id)) return respond({ error: 'That channel type no longer exists' });
        db.prepare('UPDATE channel_types SET name = ?, icon = ?, functions = ? WHERE id = ?')
          .run(clean.name, clean.icon, JSON.stringify(clean.functions), id);
        saved = types.getType(db, id);
        // Every channel of this type follows the edit.
        for (const ch of db.prepare('SELECT * FROM channels WHERE type_id = ? AND is_dm = 0').all(id)) applyType(ch, saved);
        audit('channel_type_edit', saved.name);
      } else {
        const count = db.prepare('SELECT COUNT(*) AS n FROM channel_types').get().n;
        if (count >= types.MAX_TYPES) return respond({ error: `A server can have at most ${types.MAX_TYPES} channel types` });
        const position = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM channel_types').get().p;
        const result = db.prepare('INSERT INTO channel_types (name, icon, functions, position) VALUES (?, ?, ?, ?)')
          .run(clean.name, clean.icon, JSON.stringify(clean.functions), position);
        saved = types.getType(db, Number(result.lastInsertRowid));
        audit('channel_type_create', saved.name);
      }
      sendTypes();
      broadcastChannelLists();
      respond({ ok: true, type: saved });
    } catch (err) {
      console.error('[channelTypes] save failed:', err.message);
      respond({ error: 'Could not save the channel type' });
    }
  });

  socket.on('delete-channel-type', (data, cb) => {
    const respond = reply(cb);
    if (!canManageTypes()) return respond({ error: 'You need Manage Server to change channel types' });
    const type = types.getType(db, data && data.id);
    if (!type) return respond({ error: 'That channel type no longer exists' });
    // Its channels keep their functions and go back to showing them one by one.
    db.transaction(() => {
      db.prepare('UPDATE channels SET type_id = NULL WHERE type_id = ?').run(type.id);
      db.prepare('DELETE FROM channel_types WHERE id = ?').run(type.id);
    })();
    audit('channel_type_delete', type.name);
    sendTypes();
    broadcastChannelLists();
    respond({ ok: true });
  });

  socket.on('set-channel-type', (data, cb) => {
    const respond = reply(cb);
    if (!data || typeof data !== 'object') return respond({ error: 'Invalid request' });
    const code = typeof data.code === 'string' ? data.code.trim() : '';
    if (!/^[a-f0-9]{8}$/i.test(code)) return respond({ error: 'Invalid channel' });
    const channel = db.prepare('SELECT * FROM channels WHERE code = ? AND is_dm = 0').get(code);
    if (!channel) return respond({ error: 'Channel not found' });
    if (!canManageSettingsOf(channel)) return respond({ error: 'You don\'t have permission to change this channel\'s functions' });
    let type = null;
    if (data.typeId !== null && data.typeId !== undefined) {
      type = types.getType(db, data.typeId);
      if (!type) return respond({ error: 'That channel type no longer exists' });
    }
    try {
      applyType(channel, type);
      if (typeof ctx.logAudit === 'function') {
        ctx.logAudit({ actor: socket.user, action: 'channel_type_set', target_type: 'channel', target_id: channel.id, target_name: channel.name, details: type ? type.name : 'none' });
      }
      sendTypes();
      broadcastChannelLists();
      respond({ ok: true });
    } catch (err) {
      console.error('[channelTypes] set failed:', err.message);
      respond({ error: 'Could not change the channel type' });
    }
  });
};
