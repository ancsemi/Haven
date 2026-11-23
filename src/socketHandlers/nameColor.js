'use strict';

// Picking which of your colored roles colors your name (see src/nameColor.js).

const nameColor = require('../nameColor');

module.exports = function register(socket, ctx) {
  const { db, state, getUserAllRoles, emitOnlineUsers, emitDmPresence, broadcastVoiceUsers } = ctx;

  // Server-wide roles only: a role held in one channel colors nothing else.
  const options = () => {
    const roles = getUserAllRoles(socket.user.id);
    const choices = nameColor.colorChoices(roles).map(r => ({
      id: r.id, name: r.name, color: r.color, color2: r.color2 || null, color_shimmer: r.color2 ? r.color_shimmer : 0,
    }));
    const chosen = nameColor.chosenRoleId(db, socket.user.id);
    return { choices, chosen: choices.some(r => r.id === chosen) ? chosen : null };
  };

  socket.on('get-name-color', (callback) => {
    if (!socket.user || typeof callback !== 'function') return;
    try {
      callback(options());
    } catch (err) {
      console.warn('[name color] could not list the choices:', err.message);
      callback({ choices: [], chosen: null });
    }
  });

  socket.on('set-name-color', (data, callback) => {
    if (!socket.user || !data || typeof data !== 'object') return;
    const cb = typeof callback === 'function' ? callback : () => {};
    const roleId = data.roleId == null ? null : Number(data.roleId);
    try {
      // Only a colored role this person holds can color their name.
      if (roleId !== null && !options().choices.some(r => r.id === roleId)) return cb({ error: 'not-held' });
      nameColor.setChoice(db, socket.user.id, roleId);
    } catch (err) {
      console.warn('[name color] could not save the choice:', err.message);
      return cb({ error: 'failed' });
    }
    // Everyone who lists this person sees the new color right away.
    for (const [code, users] of state.channelUsers) {
      if (users.has(socket.user.id)) emitOnlineUsers(code);
    }
    if (emitDmPresence) emitDmPresence(socket.user.id);
    for (const [code, room] of state.voiceUsers) {
      if (room.has(socket.user.id)) broadcastVoiceUsers(code);
    }
    cb(options());
  });
};
