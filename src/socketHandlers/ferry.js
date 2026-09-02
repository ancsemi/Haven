'use strict';

/**
 * Socket handlers for Ferry, the Haven ↔ Discord bridge.
 *
 * Split across two audiences:
 *
 *   Admin:  the bot token, the global toggles, and the channel pairings.
 *            Admin-only, not `manage_webhooks`: the token is server-wide
 *            credentials for an account on someone else's platform, and the
 *            pairings decide which outside servers this Haven can reach.
 *
 *   Member: the small read-only surface the composer needs to offer
 *            autocomplete: which Discord channels the channel you are standing
 *            in is paired with, and a live Discord user lookup for DMs.
 */

const SNOWFLAKE = /^[0-9]{15,25}$/;
const DIRECTIONS = new Set(['both', 'to_discord', 'to_haven']);
const OUT_MODES = new Set(['all', 'command']);

// Booleans an admin may flip. Anything outside this list is ignored, so a
// crafted payload cannot reach ferry_bot_token through the options handler.
const TOGGLES = new Set([
  'ferry_enabled',
  'ferry_allow_personas',
  'ferry_allow_dms',
  'ferry_allow_mentions',
  'ferry_relay_bots',
]);

module.exports = function register(socket, ctx) {
  const { db, ferry, userHasPermission, logAudit, floodCheck } = ctx;

  const isAdmin = () => !!socket.user?.isAdmin;
  // Scoped to the channel being acted on, so a channel-scoped role grant of
  // use_ferry works and a server-wide one is not required.
  const canUseFerry = (channelId) => isAdmin() || userHasPermission(socket.user.id, 'use_ferry', channelId);

  // ── Shared payload builders ─────────────────────────────

  function linkRows() {
    return db.prepare(`
      SELECT f.id, f.channel_id, f.guild_id, f.guild_name, f.discord_channel_id, f.discord_channel_name,
             f.direction, f.out_mode, f.is_active, f.last_activity_at, f.last_error, f.created_at,
             c.code AS channel_code, c.name AS channel_name,
             (f.webhook_id IS NOT NULL) AS has_webhook
      FROM ferry_links f
      JOIN channels c ON f.channel_id = c.id
      ORDER BY c.name COLLATE NOCASE, f.guild_name COLLATE NOCASE
    `).all();
  }

  /**
   * The token never leaves the server, not even back to the admin who set it.
   * A masked tail is enough to answer "is the right one in there", and it keeps
   * a stolen session from lifting a working bot credential out of the settings
   * panel.
   */
  function tokenHint() {
    const token = ferry.getSetting('ferry_bot_token', '');
    if (!token) return null;
    return `••••••••${token.slice(-6)}`;
  }

  /**
   * Ferry is useless until some role actually holds use_ferry, and the default
   * roles do not: an admin sets it all up, tests it successfully as an admin,
   * and it silently does nothing for everyone else. Surfacing the roles right
   * in the panel is what closes that gap.
   */
  function roleRows() {
    return db.prepare(`
      SELECT r.id, r.name, r.level, r.color,
             EXISTS(SELECT 1 FROM role_permissions rp
                    WHERE rp.role_id = r.id AND rp.permission = 'use_ferry' AND rp.allowed = 1) AS can_ferry
      FROM roles r
      ORDER BY r.level DESC, r.name COLLATE NOCASE
    `).all();
  }

  function configPayload() {
    return {
      state: ferry.getFerryState(),
      tokenHint: tokenHint(),
      links: linkRows(),
      guilds: ferry.getDirectory(),
      roles: roleRows(),
    };
  }

  function sendConfig() {
    socket.emit('ferry:config', configPayload());
  }

  // ══════════════════════════════════════════════════════════
  // Admin
  // ══════════════════════════════════════════════════════════

  socket.on('ferry:get-config', () => {
    if (!isAdmin()) return;
    sendConfig();
  });

  socket.on('ferry:set-token', async (data) => {
    if (!isAdmin()) return socket.emit('error-msg', 'Only admins can configure Ferry');
    const token = typeof data?.token === 'string' ? data.token.trim() : '';
    if (!token) return socket.emit('error-msg', 'Paste a bot token first');
    // Rejects a newline before it can reach any header, and a pasted invite URL
    // or client secret before it wastes a round trip to Discord.
    if (/[\s\r\n]/.test(token) || token.length < 50 || token.length > 120) {
      return socket.emit('error-msg', 'That does not look like a Discord bot token. Copy it from the Bot tab of your application, not the OAuth2 tab.');
    }

    try {
      // Verified before saving, so a typo fails at paste time instead of
      // silently leaving Ferry unable to connect.
      const bot = await ferry.verifyToken(token);
      ferry.setSetting('ferry_bot_token', token);
      ferry.reconnectFerry();
      logAudit({ actor: socket.user, action: 'ferry_token_set', target_type: 'server', target_id: null,
        details: { discord_bot: bot.username } });
      socket.emit('ferry:token-ok', { bot, inviteUrl: ferry.inviteUrl(bot.id) });
      setTimeout(sendConfig, 1500);
    } catch (err) {
      socket.emit('error-msg', err.message || 'Could not verify that token with Discord');
    }
  });

  socket.on('ferry:clear-token', () => {
    if (!isAdmin()) return socket.emit('error-msg', 'Only admins can configure Ferry');
    ferry.setSetting('ferry_bot_token', '');
    ferry.setSetting('ferry_enabled', '0');
    ferry.stopFerry();
    logAudit({ actor: socket.user, action: 'ferry_token_cleared', target_type: 'server', target_id: null, details: {} });
    sendConfig();
  });

  socket.on('ferry:set-option', (data) => {
    if (!isAdmin()) return socket.emit('error-msg', 'Only admins can configure Ferry');
    const key = typeof data?.key === 'string' ? data.key : '';
    if (!TOGGLES.has(key)) return;

    const value = data.value ? '1' : '0';
    if (key === 'ferry_enabled' && value === '1' && !ferry.getSetting('ferry_bot_token', '')) {
      return socket.emit('error-msg', 'Add a Discord bot token before turning Ferry on');
    }

    ferry.setSetting(key, value);
    // The member intent is decided at connect time by the DM setting, so
    // toggling DMs has to rebuild the gateway session rather than just the
    // in-memory flag.
    if (key === 'ferry_allow_dms') ferry.reconnectFerry();
    else ferry.applySettings();

    logAudit({ actor: socket.user, action: 'ferry_option_set', target_type: 'server', target_id: null,
      details: { key, value } });
    setTimeout(sendConfig, 600);
  });

  socket.on('ferry:set-role-permission', (data) => {
    if (!isAdmin()) return socket.emit('error-msg', 'Only admins can configure Ferry');
    const roleId = parseInt(data?.roleId);
    if (!Number.isInteger(roleId)) return;

    const role = db.prepare('SELECT id, name FROM roles WHERE id = ?').get(roleId);
    if (!role) return socket.emit('error-msg', 'Role not found');

    try {
      if (data.allowed) {
        db.prepare(
          "INSERT OR IGNORE INTO role_permissions (role_id, permission, allowed) VALUES (?, 'use_ferry', 1)"
        ).run(roleId);
      } else {
        db.prepare(
          "DELETE FROM role_permissions WHERE role_id = ? AND permission = 'use_ferry'"
        ).run(roleId);
      }
      logAudit({ actor: socket.user, action: 'ferry_role_permission', target_type: 'role', target_id: roleId,
        details: { role: role.name, allowed: !!data.allowed } });
      sendConfig();
    } catch (err) {
      console.error('ferry:set-role-permission error:', err.message);
      socket.emit('error-msg', 'Could not change that role');
    }
  });

  socket.on('ferry:reconnect', () => {
    if (!isAdmin()) return;
    ferry.reconnectFerry();
    setTimeout(sendConfig, 2000);
  });

  socket.on('ferry:create-link', (data) => {
    if (!isAdmin()) return socket.emit('error-msg', 'Only admins can configure Ferry');
    if (!data || typeof data !== 'object') return;

    const channelCode = typeof data.channelCode === 'string' ? data.channelCode.trim() : '';
    const guildId = typeof data.guildId === 'string' ? data.guildId.trim() : '';
    const discordChannelId = typeof data.discordChannelId === 'string' ? data.discordChannelId.trim() : '';
    const direction = DIRECTIONS.has(data.direction) ? data.direction : 'both';
    const outMode = OUT_MODES.has(data.outMode) ? data.outMode : 'command';

    if (!/^[a-f0-9]{8}$/i.test(channelCode)) return socket.emit('error-msg', 'Pick a Haven channel');
    if (!SNOWFLAKE.test(guildId) || !SNOWFLAKE.test(discordChannelId)) {
      return socket.emit('error-msg', 'Pick a Discord server and channel');
    }

    // DM channels are per-person and paired with nothing, and a bridge into one
    // would expose a private conversation to a Discord server.
    const channel = db.prepare('SELECT id, name FROM channels WHERE code = ? AND is_dm = 0').get(channelCode);
    if (!channel) return socket.emit('error-msg', 'Channel not found');

    // Confirm the target against what the bot can actually see. A pairing to a
    // channel the bot is not in would otherwise sit there looking healthy and
    // silently drop every message.
    const guild = ferry.getDirectory().find(g => g.id === guildId);
    if (!guild) return socket.emit('error-msg', 'The bot is not in that Discord server');
    const dChannel = guild.channels.find(c => c.id === discordChannelId);
    if (!dChannel) return socket.emit('error-msg', 'The bot cannot see that Discord channel');

    try {
      db.prepare(`
        INSERT INTO ferry_links (channel_id, guild_id, guild_name, discord_channel_id, discord_channel_name,
                                 direction, out_mode, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(channel.id, guildId, guild.name, discordChannelId, dChannel.name, direction, outMode, socket.user.id);

      logAudit({ actor: socket.user, action: 'ferry_link_create', target_type: 'channel', target_id: channel.id,
        details: { guild: guild.name, discord_channel: dChannel.name, direction, out_mode: outMode } });
      sendConfig();
    } catch (err) {
      if (String(err.message).includes('UNIQUE')) {
        return socket.emit('error-msg', `#${channel.name} is already paired with #${dChannel.name}`);
      }
      console.error('ferry:create-link error:', err.message);
      socket.emit('error-msg', 'Could not create that pairing');
    }
  });

  socket.on('ferry:update-link', (data) => {
    if (!isAdmin()) return socket.emit('error-msg', 'Only admins can configure Ferry');
    const id = parseInt(data?.id);
    if (!Number.isInteger(id)) return;

    const link = db.prepare('SELECT id FROM ferry_links WHERE id = ?').get(id);
    if (!link) return socket.emit('error-msg', 'Pairing not found');

    const sets = [];
    const args = [];
    if (DIRECTIONS.has(data.direction)) { sets.push('direction = ?'); args.push(data.direction); }
    if (OUT_MODES.has(data.outMode))    { sets.push('out_mode = ?');  args.push(data.outMode); }
    if (data.isActive !== undefined)    { sets.push('is_active = ?'); args.push(data.isActive ? 1 : 0); }
    if (!sets.length) return;

    // Clearing the stored error on any edit is deliberate: the admin has just
    // changed something, so a stale "needs Manage Webhooks" line would be
    // reporting a problem that may already be solved.
    sets.push('last_error = NULL');
    args.push(id);
    db.prepare(`UPDATE ferry_links SET ${sets.join(', ')} WHERE id = ?`).run(...args);

    logAudit({ actor: socket.user, action: 'ferry_link_update', target_type: 'channel', target_id: id,
      details: { direction: data.direction, out_mode: data.outMode, active: data.isActive } });
    sendConfig();
  });

  socket.on('ferry:delete-link', (data) => {
    if (!isAdmin()) return socket.emit('error-msg', 'Only admins can configure Ferry');
    const id = parseInt(data?.id);
    if (!Number.isInteger(id)) return;

    // The Discord webhook is left in place on purpose. Deleting it would need
    // Manage Webhooks that the bot may no longer have, and an orphaned webhook
    // sends nothing on its own; the Discord admin can remove it if they want.
    db.prepare('DELETE FROM ferry_links WHERE id = ?').run(id);
    logAudit({ actor: socket.user, action: 'ferry_link_delete', target_type: 'channel', target_id: id, details: {} });
    sendConfig();
  });

  // ══════════════════════════════════════════════════════════
  // Members: composer autocomplete
  // ══════════════════════════════════════════════════════════

  /**
   * The Discord destinations reachable from one Haven channel. Scoped to that
   * channel's own pairings, which is what stops `use_ferry` from meaning "post
   * into any server the bot happens to be in".
   */
  socket.on('ferry:targets', (data) => {
    const code = typeof data?.code === 'string' ? data.code.trim() : '';
    if (!/^[a-f0-9]{8}$/i.test(code)) return;

    const cfg = ferry.getConfig();
    const channel = db.prepare('SELECT id FROM channels WHERE code = ? AND is_dm = 0').get(code);
    if (!channel) return;

    if (!cfg.enabled || !canUseFerry(channel.id)) {
      return socket.emit('ferry:targets', { code, enabled: false, targets: [], allowDms: false });
    }

    // Membership matters here as much as the permission: the target list names
    // the Discord servers an admin paired, which is not public information.
    const member = db.prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?')
      .get(channel.id, socket.user.id);
    if (!member) return;

    const targets = db.prepare(`
      SELECT id, guild_id, guild_name, discord_channel_id, discord_channel_name, out_mode
      FROM ferry_links
      WHERE channel_id = ? AND is_active = 1 AND direction IN ('both','to_discord')
      ORDER BY guild_name COLLATE NOCASE, discord_channel_name COLLATE NOCASE
    `).all(channel.id);

    socket.emit('ferry:targets', {
      code,
      enabled: true,
      trigger: cfg.trigger || '=>',
      allowDms: cfg.allowDms && targets.length > 0,
      targets,
    });
  });

  /** Live Discord member lookup for `=>@` DM autocomplete. */
  socket.on('ferry:search-users', async (data) => {
    const code = typeof data?.code === 'string' ? data.code.trim() : '';
    const query = typeof data?.query === 'string' ? data.query : '';
    if (!/^[a-f0-9]{8}$/i.test(code) || query.trim().length < 2) return;

    const cfg = ferry.getConfig();
    if (!cfg.enabled || !cfg.allowDms) return;

    const channel = db.prepare('SELECT id FROM channels WHERE code = ? AND is_dm = 0').get(code);
    if (!channel) return;
    if (!canUseFerry(channel.id)) return;
    const member = db.prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?')
      .get(channel.id, socket.user.id);
    if (!member) return;

    // Checked after the cheap gates so a rejected caller does not consume
    // budget, and before any Discord call so a flood cannot reach the API.
    if (floodCheck('ferrySearch')) {
      return socket.emit('error-msg', 'Slow down, too many Discord lookups');
    }

    // Searchable guilds are only those already paired with this channel, so the
    // DM lookup cannot be used to enumerate members of unrelated servers the
    // bot happens to be in.
    const guildIds = [...new Set(db.prepare(`
      SELECT DISTINCT guild_id FROM ferry_links
      WHERE channel_id = ? AND is_active = 1 AND direction IN ('both','to_discord')
    `).all(channel.id).map(r => r.guild_id))];
    if (!guildIds.length) return;

    const seen = new Set();
    const results = [];
    for (const guildId of guildIds.slice(0, 5)) {
      const rows = await ferry.searchMembers(guildId, query);
      for (const r of rows) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        results.push(r);
      }
      if (results.length >= 10) break;
    }

    socket.emit('ferry:search-users', { code, query, results: results.slice(0, 10) });
  });
};
