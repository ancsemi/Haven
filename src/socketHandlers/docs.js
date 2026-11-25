'use strict';

// Docs channels. Storage and checks live in src/docs.js.
//
//   doc-list   { code }                                  a channel's documents, without bodies
//   doc-get    { id }                                    one document with its body
//   doc-create { code, title, body, shared }             anyone who may post
//   doc-update { id, version, title?, body?, shared? }   its author or a moderator; anyone who
//                                                        may post when it is shared
//   doc-delete { id }                                    its author or a moderator
//
// `version` is the version the edit started from. When someone saved a newer
// one first, the reply is { error, conflict: true, doc } with the stored
// document. Every change reaches the channel room live: 'doc-changed' carries
// the document without its body, and 'doc-removed' its id. Replies come back
// through the callback as { ok, ... } or { error }.

const docs = require('../docs');
const { reachableChannel, reachableChannelByCode } = require('./channelAccess');
const { sanitizeText } = require('./helpers');

module.exports = function register(socket, ctx) {
  const { io, db, userHasPermission, enforceAutomod, floodCheck } = ctx;
  const uid = () => socket.user.id;
  const ack = (fn) => (typeof fn === 'function' ? fn : () => {});
  const idOf = (data) => (data && Number.isInteger(data.id) && data.id > 0 ? data.id : null);

  // The docs channel behind a code, when this user can reach it.
  const channelByCode = (code) => {
    const ch = reachableChannelByCode(ctx, socket.user, typeof code === 'string' ? code.trim() : '');
    return ch && ch.is_docs && !ch.is_dm ? ch : null;
  };
  // A document and its channel, when this user can reach that channel.
  const docById = (id) => {
    const row = id ? docs.getRow(db, id) : null;
    const ch = row ? reachableChannel(ctx, socket.user, row.channel_id) : null;
    return ch && ch.is_docs && !ch.is_dm ? { row, ch } : null;
  };

  const muted = () => !!db.prepare("SELECT 1 FROM mutes WHERE user_id = ? AND expires_at > datetime('now') LIMIT 1").get(uid());
  const moderates = (ch) => socket.user.isAdmin || userHasPermission(uid(), 'delete_message', ch.id);
  // Writing a document is posting: a read-only channel takes the override, as
  // it does for messages.
  const mayPost = (ch) => socket.user.isAdmin || !ch.read_only || userHasPermission(uid(), 'read_only_override', ch.id);
  const postRefusal = (ch) => (!mayPost(ch) ? 'Only some members can write documents here'
    : (muted() && !socket.user.isAdmin ? 'You are muted' : null));
  // Its author owns a document while they may still post there; a moderator any time.
  const owns = (row, ch) => moderates(ch) || (row.created_by === uid() && !postRefusal(ch));
  const mayEdit = (row, ch) => owns(row, ch) || (!!row.shared && !postRefusal(ch));

  // Clean the text, then let automod judge it as one message would be judged.
  // automod tells the sender itself when it refuses.
  const clean = (d) => ({ title: sanitizeText(d.title).trim(), body: sanitizeText(d.body), shared: d.shared });
  const screen = (d, ch) => !enforceAutomod([d.title, d.body].filter(Boolean).join('\n'), { surface: 'message', channelId: ch.id });

  const announce = (ch, id) => {
    const doc = docs.getDoc(db, id);
    if (doc) {
      const { body, ...summary } = doc;
      io.to(`channel:${ch.code}`).emit('doc-changed', { channelCode: ch.code, doc: summary });
    }
    return doc;
  };

  socket.on('doc-list', (data, callback) => {
    const cb = ack(callback);
    try {
      const ch = channelByCode(data && data.code);
      if (!ch) return cb({ error: 'Documents not found' });
      cb({ ok: true, docs: docs.list(db, ch.id), canPost: !postRefusal(ch), canModerate: moderates(ch) });
    } catch (err) {
      console.error('doc-list error:', err);
      cb({ error: 'Failed to load the documents' });
    }
  });

  socket.on('doc-get', (data, callback) => {
    const cb = ack(callback);
    try {
      const found = docById(idOf(data));
      if (!found) return cb({ error: 'Document not found' });
      cb({ ok: true, doc: docs.getDoc(db, found.row.id) });
    } catch (err) {
      console.error('doc-get error:', err);
      cb({ error: 'Failed to load the document' });
    }
  });

  socket.on('doc-create', (data, callback) => {
    const cb = ack(callback);
    try {
      if (floodCheck('message')) return cb({ error: 'Slow down a moment' });
      const ch = channelByCode(data && data.code);
      if (!ch) return cb({ error: 'Documents not found' });
      const why = postRefusal(ch);
      if (why) return cb({ error: why });
      const parsed = docs.parseDoc(data);
      if (parsed.error) return cb({ error: parsed.error });
      const d = clean(parsed.doc);
      if (!d.title) return cb({ error: 'Give the document a title' });
      if (!screen(d, ch)) return cb({ blocked: true });
      const made = docs.createDoc(db, ch.id, uid(), d);
      if (made.error) return cb({ error: made.error });
      cb({ ok: true, doc: announce(ch, made.id) });
    } catch (err) {
      console.error('doc-create error:', err);
      cb({ error: 'Failed to save the document' });
    }
  });

  socket.on('doc-update', (data, callback) => {
    const cb = ack(callback);
    try {
      if (floodCheck('message')) return cb({ error: 'Slow down a moment' });
      const found = docById(idOf(data));
      if (!found) return cb({ error: 'Document not found' });
      const { row, ch } = found;
      if (!mayEdit(row, ch)) return cb({ error: 'Only the person who wrote this document can change it' });
      if (!Number.isInteger(data.version)) return cb({ error: 'Invalid document' });
      const parsed = docs.parseDoc(data, row);
      if (parsed.error) return cb({ error: parsed.error });
      // Only the author or a moderator decides who else may edit.
      if (!owns(row, ch)) parsed.doc.shared = !!row.shared;
      const d = clean(parsed.doc);
      if (!d.title) return cb({ error: 'Give the document a title' });
      if (!screen(d, ch)) return cb({ blocked: true });
      const saved = docs.updateDoc(db, row.id, uid(), d, data.version);
      if (saved.conflict) {
        return cb({ error: 'Someone saved a newer version while you were writing', conflict: true, doc: docs.getDoc(db, row.id) });
      }
      cb({ ok: true, doc: announce(ch, row.id) });
    } catch (err) {
      console.error('doc-update error:', err);
      cb({ error: 'Failed to save the document' });
    }
  });

  socket.on('doc-delete', (data, callback) => {
    const cb = ack(callback);
    try {
      const found = docById(idOf(data));
      if (!found) return cb({ error: 'Document not found' });
      const { row, ch } = found;
      if (!owns(row, ch)) return cb({ error: 'Only the person who wrote this document can delete it' });
      docs.removeDoc(db, row.id);
      io.to(`channel:${ch.code}`).emit('doc-removed', { channelCode: ch.code, id: row.id });
      cb({ ok: true });
    } catch (err) {
      console.error('doc-delete error:', err);
      cb({ error: 'Failed to delete the document' });
    }
  });
};
