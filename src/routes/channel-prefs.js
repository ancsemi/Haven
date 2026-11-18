'use strict';

const express = require('express');
const { lockUserPreferences } = require('../db/userPreferences');

function muteUpsert(db) {
  return db.prepare(`
    INSERT INTO user_channel_prefs (user_id, channel_code, muted, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id, channel_code) DO UPDATE SET muted = excluded.muted, updated_at = CURRENT_TIMESTAMP
  `);
}

function clearMuted(db, userId) {
  return db.prepare('DELETE FROM user_channel_prefs WHERE user_id = ? AND muted = 1').run(userId);
}

module.exports = function registerChannelPrefs({ app, verifyToken }) {
  // ── Per-user channel notification prefs ──────────────────
  // Mirrors the localStorage `haven_muted_channels` set to the database so
  // sendPushNotifications can filter out muted recipients before they hit
  // FCM/web-push (#5399 follow-up: mobile users were getting pushes for
  // every message regardless of channel mute state because the prefs only
  // ever lived client-side).
  app.get('/api/user/channel-prefs', async (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    const user = req.postgresUser || (token ? verifyToken(token) : null);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    try {
      const { getAsyncDb } = require('../database');
      const rows = await getAsyncDb().prepare(
        'SELECT channel_code FROM user_channel_prefs WHERE user_id = ? AND muted = 1'
      ).all(user.id);
      res.json({ muted: rows.map(r => r.channel_code) });
    } catch (err) {
      console.error('[user/channel-prefs GET]', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.post('/api/user/channel-prefs/mute', express.json({ limit: '4kb' }), async (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    const user = req.postgresUser || (token ? verifyToken(token) : null);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const { code, muted } = req.body || {};
    if (typeof code !== 'string' || !code.length || code.length > 64)
      return res.status(400).json({ error: 'Invalid code' });
    try {
      const { getAsyncDb } = require('../database');
      const db = getAsyncDb();
      if (req.postgresUser) {
        await db.withTransaction(async tx => {
          await lockUserPreferences(tx, user.id);
          await muteUpsert(tx).run(user.id, code, muted ? 1 : 0);
        });
      } else {
        await muteUpsert(db).run(user.id, code, muted ? 1 : 0);
      }
      res.json({ ok: true });
    } catch (err) {
      console.error('[user/channel-prefs POST]', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Bulk replace: used by the client on first sync to push the entire
  // localStorage set up at once (or to converge after offline edits).
  app.put('/api/user/channel-prefs/muted', express.json({ limit: '16kb' }), async (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    const user = req.postgresUser || (token ? verifyToken(token) : null);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const codes = Array.isArray(req.body?.codes) ? req.body.codes : null;
    if (!codes || codes.length > 500)
      return res.status(400).json({ error: 'codes array required (max 500)' });
    // Filter to plausible channel codes only: strings, 1..64 chars
    const clean = codes.filter(c => typeof c === 'string' && c.length > 0 && c.length <= 64);
    try {
      const { getDb } = require('../database');
      const db = getDb();
      if (db.kind === 'postgres') {
        await db.withTransaction(async tx => {
          await lockUserPreferences(tx, user.id);
          await clearMuted(tx, user.id);
          const upsert = muteUpsert(tx);
          for (const code of clean) await upsert.run(user.id, code, 1);
        });
      } else {
        db.transaction(() => {
          clearMuted(db, user.id);
          const upsert = muteUpsert(db);
          for (const code of clean) upsert.run(user.id, code, 1);
        })();
      }
      res.json({ ok: true, count: clean.length });
    } catch (err) {
      console.error('[user/channel-prefs PUT]', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });
};
