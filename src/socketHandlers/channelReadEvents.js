'use strict';

// Tell every connected device of one account that channels were read, so
// each can drop its own notification for them. Looks at the sockets once
// however many channels there are. Other accounts never see it.
module.exports = function emitChannelRead(io, userId, reads) {
  if (!reads.length) return;
  const devices = [];
  for (const [, connected] of io.sockets.sockets) {
    if (connected.user && connected.user.id === userId) devices.push(connected);
  }
  for (const connected of devices) {
    for (const read of reads) connected.emit('channel-read', read);
  }
};
