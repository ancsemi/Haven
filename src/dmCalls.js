'use strict';
const RING_MS = 45000;
const RING_COOLDOWN_MS = 30000;
const RING_WINDOW_MS = 300000;
const RING_WINDOW_MAX = 6;
module.exports = function createDmCalls({ io, db, voiceUsers, sendPushNotifications }) {
  const calls = new Map();
  const ringLog = new Map();
  const mayRing = (userId, code, now) => {
    const recent = (ringLog.get(userId) || []).filter(r => now - r.at < RING_WINDOW_MS);
    ringLog.set(userId, recent);
    if (recent.some(r => r.code === code && now - r.at < RING_COOLDOWN_MS) || recent.length >= RING_WINDOW_MAX) return false;
    recent.push({ code, at: now });
    return true;
  };
  const channelOf = (code) => db.prepare('SELECT id, name, is_dm FROM channels WHERE code = ?').get(code);
  const membersOf = (channelId) => db.prepare('SELECT user_id FROM channel_members WHERE channel_id = ?').all(channelId).map(r => r.user_id);
  const inRoom = (code) => new Set(voiceUsers.get(code)?.keys() || []);
  const emitToUser = (userId, event, data) => {
    for (const [, s] of io.sockets.sockets) if (s.user && s.user.id === userId) s.emit(event, data);
  };
  const describe = (code, call) => ({
    code, callerId: call.callerId, callerName: call.callerName, isGroup: call.isGroup,
    groupName: call.isGroup ? call.name : null, startedAt: call.startedAt, expiresAt: call.startedAt + RING_MS,
  });
  function tellCallerIfAlone(code, call, reason) {
    const room = inRoom(code);
    if (room.size === 1 && room.has(call.callerId) && call.ringing.size === 0) {
      emitToUser(call.callerId, 'dm-call-unanswered', { code, reason });
    }
  }
  function ringTimeout(code) {
    const call = calls.get(code);
    if (!call) return;
    for (const userId of call.ringing) emitToUser(userId, 'dm-call-ring-stop', { code, reason: 'missed', callerName: call.callerName });
    call.ringing.clear();
    tellCallerIfAlone(code, call, 'timeout');
  }
  function joined(code, user) {
    if (calls.has(code)) return sync(code);
    const ch = channelOf(code);
    if (!ch || !ch.is_dm) return;
    const room = inRoom(code);
    if (room.size !== 1 || !room.has(user.id)) return;
    const members = membersOf(ch.id);
    if (!members.includes(user.id)) return;
    const now = Date.now();
    const call = {
      channelId: ch.id, name: ch.name, callerId: user.id, callerName: user.displayName || user.username,
      isGroup: members.length > 2, startedAt: now, ringing: new Set(mayRing(user.id, code, now) ? members.filter(id => id !== user.id) : []), timer: null,
    };
    calls.set(code, call);
    if (call.ringing.size === 0) return;
    const ring = describe(code, call);
    for (const userId of call.ringing) emitToUser(userId, 'dm-call-ring', ring);
    call.timer = setTimeout(() => ringTimeout(code), RING_MS);
    try { sendPushNotifications?.(ch.id, code, call.isGroup ? ch.name : call.callerName, user.id, call.callerName, 'Incoming call'); } catch {}
  }
  function sync(code) {
    const call = calls.get(code);
    if (!call) return;
    const room = inRoom(code);
    if (room.size === 0) {
      clearTimeout(call.timer);
      for (const userId of call.ringing) emitToUser(userId, 'dm-call-ring-stop', { code, reason: 'ended', callerName: call.callerName });
      calls.delete(code);
      io.to(`channel:${code}`).emit('dm-call-ended', { code });
      return;
    }
    for (const userId of [...call.ringing]) {
      if (!room.has(userId)) continue;
      call.ringing.delete(userId);
      emitToUser(userId, 'dm-call-ring-stop', { code, reason: 'answered' });
    }
    if (call.ringing.size === 0) clearTimeout(call.timer);
  }
  function decline(code, user) {
    const call = calls.get(code);
    if (!call || !call.ringing.has(user.id)) return;
    call.ringing.delete(user.id);
    emitToUser(user.id, 'dm-call-ring-stop', { code, reason: 'declined' });
    io.to(`voice:${code}`).emit('dm-call-declined', { code, userId: user.id, username: user.displayName || user.username });
    if (call.ringing.size === 0) clearTimeout(call.timer);
    tellCallerIfAlone(code, call, 'declined');
  }
  function snapshotFor(socket) {
    const userId = socket.user?.id;
    if (!userId) return;
    const list = [];
    for (const [code, call] of calls) {
      if (!membersOf(call.channelId).includes(userId)) continue;
      list.push({ ...describe(code, call), ringing: call.ringing.has(userId) });
    }
    socket.emit('dm-call-state', { calls: list });
  }
  return { joined, sync, decline, snapshotFor };
};
