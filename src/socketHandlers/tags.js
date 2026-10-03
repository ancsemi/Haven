/**
 * Upload-tag lookups for the composer's tag picker, plus the admin Tags panel.
 *
 * `search-upload-tags` is a prefix search over the global upload-tag vocabulary
 * so a user can pick an existing tag. Minting new tags at compose time happens on
 * message send (see uploadTags.applyTagsToMessage), not here.
 *
 * The admin handlers (`admin-*-tag`) back the Settings → Tags panel: list the
 * vocabulary and add / rename / delete entries. Rename and delete are HARD and
 * destructive by decision (no soft delete) and propagate to every attachment
 * through the tag_id the association carries; both rebroadcast the affected
 * messages so open footers repaint live. Gated by manage_tags (admins always).
 *
 * The search fans out to an indexed LIKE, which is cheap, but it is still a DB
 * hit per keystroke, so it gets its own tight per-account flood bucket
 * (`tagSearch`) on top of the shared event budget; the composer also debounces.
 */
const {
  searchTags, MAX_TAG_LEN, effectiveLimits,
  listAllTags, createTag, renameTag, deleteTag,
} = require('../uploadTags');

module.exports = function register(socket, ctx) {
  const { db, io, floodCheck, userHasPermission } = ctx;

  const canManageTags = () =>
    socket.user.isAdmin || userHasPermission(socket.user.id, 'manage_tags');

  // Recompute and rebroadcast the tag footer of every message a mutation
  // touched, so anyone with those messages on screen sees the rename/delete
  // land live. `targets` is the [{ messageId, channelCode }] the uploadTags
  // helper gathered by iterating the tag's attachment associations.
  const readFull = db.prepare(
    `SELECT ut.name FROM attachment_tags at JOIN upload_tags ut ON ut.id = at.tag_id
      WHERE at.message_id = ? ORDER BY ut.name_norm`
  );
  const rebroadcastTargets = (targets) => {
    for (const { messageId, channelCode } of targets || []) {
      const tags = readFull.all(messageId).map(r => r.name);
      io.to(`channel:${channelCode}`).emit('message-tags-updated', { channelCode, messageId, tags });
    }
  };

  socket.on('search-upload-tags', (data, cb) => {
    const respond = typeof cb === 'function' ? cb : () => {};
    if (!data || typeof data !== 'object') return respond({ tags: [] });
    const query = typeof data.query === 'string' ? data.query : '';
    if (query.length > MAX_TAG_LEN) return respond({ tags: [] });

    if (floodCheck('tagSearch')) return respond({ error: 'rate_limited', tags: [] });

    try {
      // Empty query browses the whole vocabulary (picker just opened); a typed
      // query narrows by prefix. Both capped inside searchTags.
      respond({ tags: searchTags(db, query, 100) });
    } catch (e) {
      respond({ tags: [] });
    }
  });

  // ── Admin Tags panel (Phase 4) ────────────────────────
  socket.on('admin-list-tags', (data, cb) => {
    const respond = typeof cb === 'function' ? cb : () => {};
    if (!canManageTags()) return respond({ error: 'forbidden' });
    try {
      respond({ tags: listAllTags(db) });
    } catch (e) {
      respond({ error: 'failed' });
    }
  });

  socket.on('admin-create-tag', (data, cb) => {
    const respond = typeof cb === 'function' ? cb : () => {};
    if (!canManageTags()) return respond({ error: 'forbidden' });
    if (!data || typeof data !== 'object') return respond({ error: 'bad_request' });
    if (floodCheck('tagEdit')) return respond({ error: 'rate_limited' });
    try {
      const { maxLen } = effectiveLimits(db);
      const res = createTag(db, { name: data.name, userId: socket.user.id, maxLen });
      if (res.error) return respond(res);
      respond({ ok: true, tag: { id: res.id, name: res.name } });
    } catch (e) {
      respond({ error: 'failed' });
    }
  });

  socket.on('admin-rename-tag', (data, cb) => {
    const respond = typeof cb === 'function' ? cb : () => {};
    if (!canManageTags()) return respond({ error: 'forbidden' });
    if (!data || typeof data !== 'object' || !Number.isInteger(data.tagId)) return respond({ error: 'bad_request' });
    if (floodCheck('tagEdit')) return respond({ error: 'rate_limited' });
    try {
      const { maxLen } = effectiveLimits(db);
      const res = renameTag(db, { tagId: data.tagId, newName: data.newName, maxLen });
      if (res.error) return respond(res);
      rebroadcastTargets(res.targets);
      respond({ ok: true, merged: res.merged });
    } catch (e) {
      respond({ error: 'failed' });
    }
  });

  socket.on('admin-delete-tag', (data, cb) => {
    const respond = typeof cb === 'function' ? cb : () => {};
    if (!canManageTags()) return respond({ error: 'forbidden' });
    if (!data || typeof data !== 'object' || !Number.isInteger(data.tagId)) return respond({ error: 'bad_request' });
    if (floodCheck('tagEdit')) return respond({ error: 'rate_limited' });
    try {
      const res = deleteTag(db, { tagId: data.tagId });
      if (res.error) return respond(res);
      rebroadcastTargets(res.targets);
      respond({ ok: true });
    } catch (e) {
      respond({ error: 'failed' });
    }
  });
};
