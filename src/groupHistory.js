'use strict';

// A group DM member is shown nothing from before they joined. Every change of
// membership gets a new key that only the members of the time receive, so
// those messages could never be opened, and who wrote what and when is not
// theirs to see either. Returns the id at or below which this user's history
// stops (0 for anything but a group DM).
function groupHistoryFloor(db, channel, userId) {
  if (!channel || !channel.is_group) return 0;
  const row = db.prepare(`
    SELECT COALESCE(MAX(m.id), 0) AS id
    FROM messages m
    JOIN channel_members cm ON cm.channel_id = m.channel_id AND cm.user_id = ?
    WHERE m.channel_id = ? AND datetime(m.created_at) < datetime(cm.joined_at)
  `).get(userId, channel.id);
  return row ? row.id : 0;
}

async function groupHistoryFloorAsync(db, channel, userId) {
  if (!channel || !channel.is_group) return 0;
  const row = await db.prepare(`
    SELECT COALESCE(MAX(m.id), 0) AS id
    FROM messages m
    JOIN channel_members cm ON cm.channel_id = m.channel_id AND cm.user_id = ?
    WHERE m.channel_id = ? AND ${db.kind === 'postgres' ? 'CAST(m.created_at AS TIMESTAMP) < CAST(cm.joined_at AS TIMESTAMP)' : 'datetime(m.created_at) < datetime(cm.joined_at)'}
  `).get(userId, channel.id);
  return row ? row.id : 0;
}

module.exports = { groupHistoryFloor, groupHistoryFloorAsync };
