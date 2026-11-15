'use strict';

// Pinned DMs: the conversations someone keeps at the top of their own DM
// list, saved on their account (preference pinned_dms) so every device shows
// the same pins. Only the person who pins sees it.
//
// The value is a JSON list of DM channel codes in the order they were pinned.
// Only codes of DMs (group DMs included) this account is a member of are
// kept, each once, at most MAX_PINNED_DMS of them.

const MAX_PINNED_DMS = 50;
const CODE_RE = /^[A-Za-z0-9_-]{1,32}$/;

// The cleaned list as JSON, or null when nothing in it can be kept (then
// nothing is saved).
function cleanPinnedDms(db, userId, raw) {
  let list;
  try { list = JSON.parse(raw); } catch { return null; } // not JSON: refused
  if (!Array.isArray(list)) return null;
  const wanted = [...new Set(list.filter(c => typeof c === 'string' && CODE_RE.test(c)))].slice(0, MAX_PINNED_DMS * 2);
  if (!wanted.length) return null;
  const postgres = db.kind === 'postgres';
  const rows = db.prepare(`
    SELECT c.code FROM channels c
    JOIN channel_members cm ON cm.channel_id = c.id
    WHERE cm.user_id = ? AND c.is_dm = 1
    ${postgres ? 'AND c.code = ANY(?::text[]) FOR SHARE OF c, cm' : ''}
  `).all(userId, ...(postgres ? [wanted] : []));
  const filter = memberships => {
    const mine = new Set(memberships.map(row => row.code));
    const kept = wanted.filter(code => mine.has(code)).slice(0, MAX_PINNED_DMS);
    return kept.length ? JSON.stringify(kept) : null;
  };
  return postgres ? rows.then(filter) : filter(rows);
}

module.exports = { cleanPinnedDms, MAX_PINNED_DMS };
