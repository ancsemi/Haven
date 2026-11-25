'use strict';

// Sub-servers. Storage and the rules live in src/subservers.js.
//
//   subserver-list    {}                                  the sub-servers this member can see
//   subserver-create  { name, icon }                      Manage Server
//   subserver-update  { id, name?, icon?, mode?, roles? } the same; roles: [] removes them
//   subserver-delete  { id }                              the same; its channels go to the main server
//   subserver-reorder { ids }                             the same
//   channel-set-subserver { code, subserverId }           the same; null is the main server
//
// Any change tells every client 'subservers-changed', and they ask again.
// Replies come back through the callback as { ok, ... } or { error }.

const subs = require('../subservers');
const { sanitizeText } = require('./helpers');
const { reachableChannel } = require('./channelAccess');

module.exports = function register(socket, ctx) {
  const { io, db, userHasPermission, broadcastChannelLists, parseRoleGate, applyRoleGate } = ctx;
  const ack = (fn) => (typeof fn === 'function' ? fn : () => {});
  const manages = () => socket.user.isAdmin || userHasPermission(socket.user.id, 'manage_server');
  const changed = () => io.except('bot-sockets').emit('subservers-changed');
  const allows = (uid, ch) => ctx.roleGateAllows(uid, ch);
  // A manager without a sub-server's roles cannot see it, so cannot change it.
  const find = (id) => { const row = subs.get(db, id); return subs.canSee(socket.user, row, allows) ? row : null; };
  // Required roles let everyone who holds them into a private channel, which
  // is the admin's call (as in Channel Functions).
  const privateRefusal = (channels) => (!socket.user.isAdmin && channels.some(c => c.is_private)
    ? 'Only the admin can put required roles on a private channel' : null);
  // Required roles sent by a client, as stored JSON, keeping only roles that exist.
  const readGate = (data) => {
    const gate = parseRoleGate({ mode: data.mode, roles: Array.isArray(data.roles) ? data.roles.slice(0, 50) : [] });
    if (!gate) return null;
    const ph = gate.roles.map(() => '?').join(',');
    const known = new Set(db.prepare(`SELECT id FROM roles WHERE id IN (${ph})`).all(...gate.roles).map(r => r.id));
    gate.roles = gate.roles.filter(id => known.has(id));
    return gate.roles.length ? JSON.stringify(gate) : null;
  };
  const guard = (name, fn) => (data, callback) => {
    const cb = ack(callback);
    try {
      if (name !== 'subserver-list' && !manages()) return cb({ error: 'You need Manage Server to change sub-servers' });
      fn(data && typeof data === 'object' ? data : {}, cb);
    } catch (err) {
      console.error(`${name} error:`, err);
      cb({ error: 'Failed to save the sub-server' });
    }
  };

  socket.on('subserver-list', guard('subserver-list', (data, cb) => {
    const canManage = manages();
    cb({ ok: true, canManage, subservers: subs.visibleTo(db, socket.user, allows).map(s => subs.shape(s, canManage)) });
  }));

  socket.on('subserver-create', guard('subserver-create', (data, cb) => {
    const parsed = subs.parseSubserver({ name: sanitizeText(String(data.name ?? '')), icon: sanitizeText(String(data.icon ?? '')) });
    if (parsed.error) return cb({ error: parsed.error });
    const made = subs.create(db, parsed.subserver);
    if (made.error) return cb({ error: made.error });
    changed();
    cb({ ok: true, subserver: subs.shape(subs.get(db, made.id), true) });
  }));

  socket.on('subserver-update', guard('subserver-update', (data, cb) => {
    const row = find(data.id);
    if (!row) return cb({ error: 'Sub-server not found' });
    const fields = {};
    if ('name' in data) fields.name = sanitizeText(String(data.name ?? ''));
    if ('icon' in data) fields.icon = sanitizeText(String(data.icon ?? ''));
    const parsed = subs.parseSubserver(fields, row);
    if (parsed.error) return cb({ error: parsed.error });
    if ('roles' in data) {
      const stored = readGate(data);
      const channels = subs.channelsIn(db, row.id);
      const changes = stored !== row.role_gate;
      const why = stored && changes ? privateRefusal(channels) : null;
      if (why) return cb({ error: why });
      subs.setGate(db, row.id, stored);
      // With roles, every channel takes them. Without, the channels lose the
      // roles they had from the sub-server and keep their members.
      if (changes) for (const ch of channels) applyRoleGate(ch, stored);
    }
    subs.update(db, row.id, parsed.subserver);
    changed();
    cb({ ok: true, subserver: subs.shape(subs.get(db, row.id), true) });
  }));

  socket.on('subserver-delete', guard('subserver-delete', (data, cb) => {
    const row = find(data.id);
    if (!row) return cb({ error: 'Sub-server not found' });
    subs.remove(db, row.id);
    broadcastChannelLists();
    changed();
    cb({ ok: true });
  }));

  socket.on('subserver-reorder', guard('subserver-reorder', (data, cb) => {
    const done = subs.reorder(db, data.ids);
    if (done.error) return cb({ error: done.error });
    changed();
    cb({ ok: true });
  }));

  socket.on('channel-set-subserver', guard('channel-set-subserver', (data, cb) => {
    const code = typeof data.code === 'string' ? data.code.trim() : '';
    const channel = /^[a-f0-9]{8}$/i.test(code) ? db.prepare('SELECT id, code, parent_channel_id, subserver_id FROM channels WHERE code = ? AND is_dm = 0').get(code) : null;
    if (!channel || (!socket.user.isAdmin && !reachableChannel(ctx, socket.user, channel.id))) return cb({ error: 'Channel not found' });
    if (channel.parent_channel_id) return cb({ error: 'A sub-channel stays with its parent channel. Move the parent instead' });
    const target = data.subserverId === null || data.subserverId === undefined ? null : find(data.subserverId);
    if (data.subserverId != null && !target) return cb({ error: 'Sub-server not found' });
    if ((target ? target.id : null) === channel.subserver_id) return cb({ ok: true });
    const gate = target && parseRoleGate(target.role_gate) ? target.role_gate : null;
    if (gate) {
      const family = db.prepare('SELECT is_private FROM channels WHERE (id = ? OR parent_channel_id = ?) AND is_dm = 0').all(channel.id, channel.id);
      const why = privateRefusal(family);
      if (why) return cb({ error: why });
    }
    // Moving out of a sub-server with required roles keeps them on the
    // channel, where Channel Functions can then change them.
    const moved = subs.place(db, channel.id, target ? target.id : null);
    if (gate) for (const ch of moved) applyRoleGate(ch, gate);
    broadcastChannelLists();
    cb({ ok: true });
  }));
};
