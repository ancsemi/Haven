'use strict';

// Defaults that changed after servers were already running. A server whose
// admin never touched the setting moves to the new default once; anyone who
// changed it keeps their choice. "Never touched" means the value is still
// exactly the old default and the audit log has no change to that key.

const UPDATES = [
  {
    // Auto-Mod no longer bans on its own. Every blocked link counts as a
    // strike, so a new member retrying a link a few times got banned.
    // Warnings and mutes stay; bans are left to people.
    key: 'automod_escalation',
    from: '{"windowHours":24,"warnAt":1,"muteAt":3,"muteMinutes":60,"banAt":5}',
    to: '{"windowHours":24,"warnAt":1,"muteAt":3,"muteMinutes":60,"banAt":0}',
    marker: 'default_update_automod_escalation_2026_10',
  },
];

function applyDefaultUpdates(db) {
  const get = db.prepare('SELECT value FROM server_settings WHERE key = ?');
  const put = db.prepare('INSERT OR REPLACE INTO server_settings (key, value) VALUES (?, ?)');
  const touched = db.prepare(
    "SELECT 1 FROM audit_log WHERE action = 'server_setting_update' AND target_name = ? LIMIT 1"
  );
  for (const u of UPDATES) {
    if (get.get(u.marker)) continue;
    db.transaction(() => {
      if (get.get(u.key)?.value === u.from && !touched.get(u.key)) put.run(u.key, u.to);
      put.run(u.marker, 'done');
    })();
  }
}

module.exports = { applyDefaultUpdates, UPDATES };
