'use strict';

// The mentions:me search filter, behind the @ button in the account bar.
// It matches messages that @mention the searcher by login name or reply to
// one of their messages, and leaves out their own messages. Login names are
// only letters, digits and _, so a GLOB on the lowercased text with character
// classes on both sides matches @bob but not @bobby, and not x@bob.com.
// The caller still limits results to channels the searcher can open.
function mentionsMeCondition(userId, loginName) {
  const name = String(loginName || '').toLowerCase();
  if (!Number.isInteger(userId) || userId <= 0 || !/^[a-z0-9_]+$/.test(name)) return null;
  return {
    sql: `(COALESCE(m.user_id, 0) != ? AND (
      (' ' || lower(m.content) || ' ') GLOB ?
      OR EXISTS (SELECT 1 FROM messages p WHERE p.id = m.reply_to AND p.user_id = ?)
    ))`,
    params: [userId, `*[^a-z0-9_@]@${name}[^a-z0-9_]*`, userId],
  };
}

module.exports = { mentionsMeCondition };
