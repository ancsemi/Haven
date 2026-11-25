'use strict';

// Bracket channels. Storage, seeding and checks live in src/brackets.js.
//
//   bracket-list   { code }                         a channel's brackets
//   bracket-create { code, title, description, entrants }   anyone who may post
//   bracket-update { id, title?, description?, entrants? }  its creator, or Delete Messages
//   bracket-delete { id }                           the same
//   bracket-result { id, round, slot, winner, note }        the same; winner null clears
//
// entrants are names in seed order. Every change reaches the channel room
// live: 'bracket-changed' carries the whole bracket with its matches worked
// out, and 'bracket-removed' its id. Replies come back through the callback as
// { ok, ... } or { error }.

const br = require('../brackets');
const { reachableChannel, reachableChannelByCode } = require('./channelAccess');
const { sanitizeText } = require('./helpers');

module.exports = function register(socket, ctx) {
  const { io, db, userHasPermission, enforceAutomod, floodCheck } = ctx;
  const uid = () => socket.user.id;
  const ack = (fn) => (typeof fn === 'function' ? fn : () => {});
  const idOf = (data) => (data && Number.isInteger(data.id) && data.id > 0 ? data.id : null);

  // The bracket channel behind a code, when this user can reach it.
  const channelByCode = (code) => {
    const ch = reachableChannelByCode(ctx, socket.user, typeof code === 'string' ? code.trim() : '');
    return ch && ch.is_bracket && !ch.is_dm ? ch : null;
  };
  // A bracket and its channel, when this user can reach that channel.
  const bracketById = (id) => {
    const row = id ? br.getRow(db, id) : null;
    const ch = row ? reachableChannel(ctx, socket.user, row.channel_id) : null;
    return ch && ch.is_bracket && !ch.is_dm ? { row, ch } : null;
  };

  const muted = () => !!db.prepare("SELECT 1 FROM mutes WHERE user_id = ? AND expires_at > datetime('now') LIMIT 1").get(uid());
  const moderates = (ch) => socket.user.isAdmin || userHasPermission(uid(), 'delete_message', ch.id);
  // Starting a bracket is posting: a read-only channel takes the override, as
  // it does for messages.
  const mayPost = (ch) => socket.user.isAdmin || !ch.read_only || userHasPermission(uid(), 'read_only_override', ch.id);
  const postRefusal = (ch) => (!mayPost(ch) ? 'Only some members can start brackets here'
    : (muted() && !socket.user.isAdmin ? 'You are muted' : null));
  // Its creator runs a bracket while they may still post there; a moderator any time.
  const runs = (row, ch) => moderates(ch) || (row.created_by === uid() && !postRefusal(ch));

  // Clean the text, then let automod judge it as one message would be judged.
  // automod tells the sender itself when it refuses.
  const screen = (texts, ch) => !enforceAutomod(texts.filter(Boolean).join('\n'), { surface: 'message', channelId: ch.id });
  const cleanBracket = (b) => {
    const clean = (s) => sanitizeText(s).trim();
    const out = { title: clean(b.title), description: clean(b.description), entrants: b.entrants.map(clean) };
    if (!out.title) return { error: 'Give the bracket a name' };
    if (out.entrants.some(n => !n)) return { error: 'Every entrant needs a name' };
    return { bracket: out };
  };

  const announce = (ch, id) => {
    const bracket = br.getBracket(db, id);
    if (bracket) io.to(`channel:${ch.code}`).emit('bracket-changed', { channelCode: ch.code, bracket });
    return bracket;
  };

  socket.on('bracket-list', (data, callback) => {
    const cb = ack(callback);
    try {
      const ch = channelByCode(data && data.code);
      if (!ch) return cb({ error: 'Brackets not found' });
      cb({ ok: true, brackets: br.list(db, ch.id), canPost: !postRefusal(ch), canModerate: moderates(ch) });
    } catch (err) {
      console.error('bracket-list error:', err);
      cb({ error: 'Failed to load the brackets' });
    }
  });

  socket.on('bracket-create', (data, callback) => {
    const cb = ack(callback);
    try {
      if (floodCheck('message')) return cb({ error: 'Slow down a moment' });
      const ch = channelByCode(data && data.code);
      if (!ch) return cb({ error: 'Brackets not found' });
      const why = postRefusal(ch);
      if (why) return cb({ error: why });
      const parsed = br.parseBracket(data);
      if (parsed.error) return cb({ error: parsed.error });
      const clean = cleanBracket(parsed.bracket);
      if (clean.error) return cb({ error: clean.error });
      const b = clean.bracket;
      if (!screen([b.title, b.description, ...b.entrants], ch)) return cb({ blocked: true });
      const made = br.createBracket(db, ch.id, uid(), b);
      if (made.error) return cb({ error: made.error });
      cb({ ok: true, bracket: announce(ch, made.id) });
    } catch (err) {
      console.error('bracket-create error:', err);
      cb({ error: 'Failed to start the bracket' });
    }
  });

  socket.on('bracket-update', (data, callback) => {
    const cb = ack(callback);
    try {
      if (floodCheck('message')) return cb({ error: 'Slow down a moment' });
      const found = bracketById(idOf(data));
      if (!found) return cb({ error: 'Bracket not found' });
      const { row, ch } = found;
      if (!runs(row, ch)) return cb({ error: 'Only the person who started this bracket can change it' });
      const parsed = br.parseBracket(data, row);
      if (parsed.error) return cb({ error: parsed.error });
      const clean = cleanBracket(parsed.bracket);
      if (clean.error) return cb({ error: clean.error });
      const b = clean.bracket;
      if (!screen([b.title, b.description, ...b.entrants], ch)) return cb({ blocked: true });
      br.updateBracket(db, row.id, b);
      cb({ ok: true, bracket: announce(ch, row.id) });
    } catch (err) {
      console.error('bracket-update error:', err);
      cb({ error: 'Failed to save the bracket' });
    }
  });

  socket.on('bracket-delete', (data, callback) => {
    const cb = ack(callback);
    try {
      const found = bracketById(idOf(data));
      if (!found) return cb({ error: 'Bracket not found' });
      const { row, ch } = found;
      if (row.created_by !== uid() && !moderates(ch)) return cb({ error: 'Only the person who started this bracket can delete it' });
      br.deleteBracket(db, row.id);
      io.to(`channel:${ch.code}`).emit('bracket-removed', { channelCode: ch.code, id: row.id });
      cb({ ok: true });
    } catch (err) {
      console.error('bracket-delete error:', err);
      cb({ error: 'Failed to delete the bracket' });
    }
  });

  socket.on('bracket-result', (data, callback) => {
    const cb = ack(callback);
    try {
      if (floodCheck('message')) return cb({ error: 'Slow down a moment' });
      const found = bracketById(idOf(data));
      if (!found) return cb({ error: 'Bracket not found' });
      const { row, ch } = found;
      if (!runs(row, ch)) return cb({ error: 'Only the person who started this bracket can report results' });
      const parsed = br.parseResult(data);
      if (parsed.error) return cb({ error: parsed.error });
      const res = { ...parsed.result, note: sanitizeText(parsed.result.note).trim() };
      if (res.note && !screen([res.note], ch)) return cb({ blocked: true });
      const done = br.setResult(db, row, res);
      if (done.error) return cb({ error: done.error });
      cb({ ok: true, bracket: announce(ch, row.id) });
    } catch (err) {
      console.error('bracket-result error:', err);
      cb({ error: 'Failed to save the result' });
    }
  });
};
