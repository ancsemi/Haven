'use strict';

// Who may see the people in a channel (#5931). "View Channel Members" used
// to cover only the Members window; someone without it still saw everyone
// in the sidebar and in the @mention list, and could open a DM with any of
// them. A server that parks new arrivals in a waiting channel, with a first
// role that lacks the permission, now really keeps the members out of view
// until the person is let in.
//
// Staff see members as before: the admin, and anyone who can already list
// every member (view_all_members) or moderate them (kick, ban).

// A yes is remembered per connection for this long. A no is asked again
// every time, so someone who was just given a role sees the members on the
// next update; the people held back are few, so that costs little.
const ALLOWED_TTL_MS = 30 * 1000;

function createMemberView({ db, userHasPermission, roleGateAllows }) {
  const STAFF_PERMS = ['view_all_members', 'kick_user', 'ban_user'];

  function isStaff(user) {
    return !!user.isAdmin || STAFF_PERMS.some(p => userHasPermission(user.id, p));
  }

  /** May this person see who is in this channel? Fails closed. */
  function canViewChannelMembers(user, channelId) {
    if (!user) return false;
    try {
      return !!user.isAdmin || userHasPermission(user.id, 'view_channel_members', channelId) || isStaff(user);
    } catch (err) {
      console.warn('[members] could not check who may see the member list, hiding it:', err.message);
      return false;
    }
  }

  /** The same answer for a connection's member list updates, which ask on
   *  every presence change. Returns the remembered entry: { allowed, flipped,
   *  sentOwn }. flipped is true when the answer changed since the last ask,
   *  so the caller sends a whole list again. */
  function forSocket(socket, code, channelId, now = Date.now()) {
    const seen = socket.memberView || (socket.memberView = new Map());
    const last = seen.get(code);
    if (last && last.allowed && now - last.at < ALLOWED_TTL_MS) { last.flipped = false; return last; }
    const allowed = canViewChannelMembers(socket.user, channelId);
    const entry = {
      allowed,
      at: now,
      flipped: !!last && last.allowed !== allowed,
      sentOwn: last && last.allowed === allowed ? last.sentOwn : null,
    };
    seen.set(code, entry);
    return entry;
  }

  /** May this person start a conversation with that one? Someone who holds
   *  View Channel Members server-wide may, as before. Someone who does not
   *  may only where they were given it: a channel both are in. Fails closed. */
  function canSeeMember(user, targetId) {
    if (!user) return false;
    if (user.id === targetId) return true;
    try {
      if (user.isAdmin || userHasPermission(user.id, 'view_channel_members') || isStaff(user)) return true;
      const shared = db.prepare(`
        SELECT c.id, c.role_gate FROM channel_members mine
        JOIN channel_members theirs ON theirs.channel_id = mine.channel_id
        JOIN channels c ON c.id = mine.channel_id
        WHERE mine.user_id = ? AND theirs.user_id = ? AND c.is_dm = 0
      `).all(user.id, targetId);
      return shared.some(ch => roleGateAllows(user.id, ch) && userHasPermission(user.id, 'view_channel_members', ch.id));
    } catch (err) {
      console.warn('[members] could not check whether a member is in view, refusing:', err.message);
      return false;
    }
  }

  return { canViewChannelMembers, forSocket, canSeeMember };
}

module.exports = { createMemberView, ALLOWED_TTL_MS };
