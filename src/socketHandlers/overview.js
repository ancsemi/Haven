'use strict';

// Overview channels. What the page shows lives in src/overview.js.
//
//   overview-data { code }   the front page of one overview channel
//
// Replies through the callback with { ok, events, announcements, topics,
// watch } or { error }.

const overview = require('../overview');
const { reachableChannelByCode } = require('./channelAccess');

module.exports = function register(socket, ctx) {
  socket.on('overview-data', (data, callback) => {
    const reply = typeof callback === 'function' ? callback : () => {};
    try {
      const code = data && typeof data.code === 'string' ? data.code.trim() : '';
      const ch = reachableChannelByCode(ctx, socket.user, code);
      if (!ch || !ch.is_overview || ch.is_dm) return reply({ error: 'Overview not found' });
      reply({ ok: true, ...overview.build(ctx.db, socket.user, ctx.roleGateAllows, { nsfw: !!ch.is_nsfw }) });
    } catch (err) {
      console.error('[overview] could not build the page:', err.message);
      reply({ error: 'Could not load the overview' });
    }
  });
};
