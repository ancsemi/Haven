'use strict';

// Activity from apps on the member's own computer (#5894). Haven Desktop
// listens where a game or music player would announce itself to a Discord
// app, and the member's client reports what it heard here. Nothing leaves
// the member's computer except through this event, and only for members who
// switched it on in Haven Desktop for this server.
//
// The text is the member's own, like a custom status, so src/activity.js
// cleans and caps it. It is kept in memory only and follows the same
// sharing switches as every other activity.

const MIN_GAP_MS = 2000;

module.exports = function register(socket, ctx) {
  const activity = () => ctx.state && ctx.state.activity;
  let last = 0;

  const othersReporting = () => {
    for (const [, s] of ctx.io.of('/').sockets) {
      if (s !== socket && s.user && s.user.id === socket.user.id && s.havenAppActivity) return true;
    }
    return false;
  };

  socket.on('set-app-activity', (data) => {
    if (!socket.user || socket.user.isGuest || !activity()) return;
    const payload = data && typeof data === 'object' ? data : null;
    const clearing = !payload || (!payload.playing && !payload.listening);
    // A clear always goes through; updates are spaced out, and the client
    // repeats its current activity now and then, so a dropped one heals.
    const now = Date.now();
    if (!clearing && now - last < MIN_GAP_MS) return;
    last = now;
    if (clearing || !activity().sharingEnabled(socket.user.id)) {
      socket.havenAppActivity = false;
      if (!othersReporting()) activity().setAppActivity(socket.user.id, null);
      return;
    }
    socket.havenAppActivity = true;
    activity().setAppActivity(socket.user.id, payload);
  });

  // The app that was reporting has gone: stop showing what it reported,
  // unless another of this member's devices is still reporting.
  socket.on('disconnect', () => {
    if (!socket.havenAppActivity || !socket.user || !activity()) return;
    if (!othersReporting()) activity().setAppActivity(socket.user.id, null);
  });
};
