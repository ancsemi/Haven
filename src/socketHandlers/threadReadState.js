'use strict';

// How far this person has read in some threads, for the thread mention bell.
// The bell is kept per device, so a device that was closed while the thread
// was read somewhere else asks on startup which of its remembered mentions
// are already read, and drops those instead of ringing days later.

const createReadPositions = require('../db/readPositions');
const MAX_THREADS = 200;

module.exports = function register(socket, ctx) {
  const { db } = ctx;
  const readPositions = createReadPositions(db);

  // Answers { [parentId]: lastReadReplyId } for the threads asked about,
  // leaving out any this person cannot see.
  socket.on('get-thread-read-state', async (data, callback) => {
    const cb = typeof callback === 'function' ? callback : () => {};
    const ids = Array.isArray(data && data.parentIds)
      ? [...new Set(data.parentIds.filter(id => Number.isInteger(id) && id > 0))].slice(0, MAX_THREADS)
      : [];
    if (!ids.length) return cb({ reads: {} });
    try {
      const rows = await readPositions.threadState(socket.user.id, ids);
      const reads = {};
      for (const r of rows) reads[r.parentId] = r.lastRead;
      cb({ reads });
    } catch (err) {
      console.warn('[thread-read-state] lookup failed:', err.message);
      cb({ reads: {} });
    }
  });
};
