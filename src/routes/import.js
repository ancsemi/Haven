// Discord history import: upload a DiscordChatExporter file and preview it,
// or read a server straight from Discord's API, then run the import. Admin only.

const fs = require('fs');
const path = require('path');
const express = require('express');
const crypto = require('crypto');
const os = require('os');
const { verifyToken } = require('../auth');
const { parseDiscordExport, isReactionEmoji, importedReactionEmoji } = require('../importDiscord');
const { accessContext, canReadHistory } = require('../discordPermissions');
const { sanitizeText } = require('../socketHandlers/helpers');
const { unescapeDiscord, forwardedMessage, quoteForwarded } = require('../discordText');
const { copyAttachments } = require('../importFiles');

module.exports = function registerImport(deps) {
  const { uploadDiskGuard, app, verifyAdminFromDb, uploadLimiter, importUpload } = deps;
  // ── Step 1: Upload & parse → return preview ──────────────
  app.post('/api/import/discord/upload', uploadLimiter, uploadDiskGuard, (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    const user = token ? verifyToken(token) : null;
    if (!user || !verifyAdminFromDb(user)) return res.status(403).json({ error: 'Admin only' });

    importUpload.single('file')(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message });
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

      try {
        const result = parseDiscordExport(req.file.path);

        // Save parsed data to temp so the execute step can read it
        const importId = crypto.randomBytes(16).toString('hex');
        const tempPath = path.join(os.tmpdir(), `haven-import-${importId}.json`);
        fs.writeFileSync(tempPath, JSON.stringify(result));

        // Clean up the uploaded raw file
        try { fs.unlinkSync(req.file.path); } catch { /* cleanupTempImports() sweeps any haven-import leftover */ }

        // Return preview (channel list + counts, NOT the full messages)
        res.json({
          importId,
          format: result.format,
          serverName: result.serverName,
          channels: result.channels.map(c => ({
            discordId: c.discordId,
            name: c.name,
            topic: c.topic,
            category: c.category,
            messageCount: c.messageCount
          })),
          totalMessages: result.channels.reduce((sum, c) => sum + c.messageCount, 0)
        });
      } catch (parseErr) {
        try { fs.unlinkSync(req.file.path); } catch { /* rejected temp upload may already be gone */ }
        res.status(400).json({ error: parseErr.message });
      }
    });
  });

  // ── Discord Direct Connect: pull messages straight from Discord's API ──
  const DISCORD_API = 'https://discord.com/api/v10';

  async function discordApiFetch(endpoint, auth, retries = 2) {
    const resp = await fetch(`${DISCORD_API}${endpoint}`, {
      headers: auth.headers,
      signal: AbortSignal.timeout(30000)
    });
    if (resp.status === 401) {
      throw new Error(auth.ferry
        ? "Discord rejected the Ferry bot's token. Set Ferry up again in Settings, then try again."
        : 'Invalid or expired Discord token');
    }
    if (resp.status === 403) {
      const err = new Error(auth.ferry
        ? "The Ferry bot isn't allowed to read that on Discord."
        : 'Access denied. Check the token can see this.');
      err.status = 403;
      throw err;
    }
    if (resp.status === 429 && retries > 0) {
      const wait = parseFloat(resp.headers.get('retry-after') || '3');
      await new Promise(r => setTimeout(r, wait * 1000));
      return discordApiFetch(endpoint, auth, retries - 1);
    }
    if (!resp.ok) throw new Error(`Discord API error ${resp.status}`);
    return resp.json();
  }

  // Who the import reads Discord as. The Ferry bot is the normal way: its token
  // stays on the server and the client only sends useFerry. A personal login
  // token is the fallback the client keeps behind a warning, since Discord's
  // rules don't allow apps to drive a personal account.
  function resolveImportAuth(body) {
    if (body?.useFerry) {
      const headers = require('../ferry').importHeaders();
      if (!headers) return { error: 'Ferry is not set up yet. Set it up in Settings, then try again.' };
      return { ferry: true, headers };
    }
    const discordToken = body?.discordToken;
    if (!discordToken || typeof discordToken !== 'string') return { error: 'Discord token required' };
    return { ferry: false, headers: { Authorization: discordToken } };
  }

  // Discord ids are numbers; anything else never reaches a Discord URL.
  const DISCORD_ID = /^\d{5,25}$/;

  // What the Ferry bot may read in a guild. Discord lists private channels to
  // a bot but keeps them closed until its role is added, so the picker greys
  // those out. Only a hint: when it can't be worked out, every channel is
  // offered as before and a channel Discord refuses is still skipped by name.
  async function ferryAccess(guildId, auth) {
    if (!auth.ferry) return null;
    try {
      const me = await discordApiFetch('/users/@me', auth);
      if (!me || !DISCORD_ID.test(String(me.id))) return null;
      const guild = await discordApiFetch(`/guilds/${guildId}`, auth);
      const member = await discordApiFetch(`/guilds/${guildId}/members/${me.id}`, auth);
      return accessContext({ guild, member, userId: me.id });
    } catch (err) {
      console.warn('[import] Could not work out which channels the Ferry bot can read:', err.message);
      return null;
    }
  }

  // Step A: validate token → list servers
  app.post('/api/import/discord/connect', express.json(), async (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    const user = token ? verifyToken(token) : null;
    if (!user || !verifyAdminFromDb(user)) return res.status(403).json({ error: 'Admin only' });

    const auth = resolveImportAuth(req.body);
    if (auth.error) return res.status(400).json({ error: auth.error });

    try {
      const me = await discordApiFetch('/users/@me', auth);
      const guilds = await discordApiFetch('/users/@me/guilds?limit=200', auth);
      if (auth.ferry && !guilds.length) {
        return res.status(400).json({ error: "The Ferry bot isn't in any Discord server yet. Add it to yours with the invite link in Settings, Ferry, then try again." });
      }
      res.json({
        ferry: auth.ferry,
        user: { username: me.global_name || me.username },
        guilds: guilds.map(g => ({ id: g.id, name: g.name, icon: g.icon }))
      });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Step B: list text channels, announcement channels, forums, and threads for a guild
  app.post('/api/import/discord/guild-channels', express.json(), async (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    const user = token ? verifyToken(token) : null;
    if (!user || !verifyAdminFromDb(user)) return res.status(403).json({ error: 'Admin only' });

    const auth = resolveImportAuth(req.body);
    if (auth.error) return res.status(400).json({ error: auth.error });
    const { guildId } = req.body;
    if (typeof guildId !== 'string' || !DISCORD_ID.test(guildId)) return res.status(400).json({ error: 'Missing params' });

    try {
      const allChannels = await discordApiFetch(`/guilds/${guildId}/channels`, auth);
      const access = await ferryAccess(guildId, auth);

      // Build category map
      const categories = {};
      allChannels.filter(c => c.type === 4).forEach(c => { categories[c.id] = c.name; });

      // Text (0), Announcement (5), Forum (15), Media (16): all contain readable content
      const textTypes = new Set([0, 5, 15, 16]);
      const channelsList = allChannels
        .filter(c => textTypes.has(c.type))
        .sort((a, b) => a.position - b.position)
        .map(c => ({
          id: c.id,
          name: c.name,
          topic: c.topic || '',
          category: (c.parent_id && categories[c.parent_id]) || null,
          type: c.type === 5 ? 'announcement' : c.type === 15 ? 'forum' : c.type === 16 ? 'media' : 'text',
          // Forum tags (available on type 15 and 16)
          tags: Array.isArray(c.available_tags) ? c.available_tags.map(t => ({ id: t.id, name: t.name })) : [],
          // Only present when it could be worked out; false greys the row out.
          ...(access ? { readable: canReadHistory(access, c) } : {})
        }));

      // Fetch threads (active + archived public)
      const threads = [];

      // Active threads
      try {
        const active = await discordApiFetch(`/guilds/${guildId}/threads/active`, auth);
        if (active.threads) threads.push(...active.threads);
      } catch { /* bot may lack access to active threads; list the channels without them */ }

      // Archived threads per text/forum/announcement channel, a page of 100 at
      // a time (#5772), up to 2,000 per channel.
      for (const ch of channelsList) {
        if (ch.readable === false) continue;
        let before = null;
        for (let page = 0; page < 20; page++) {
          try {
            const q = before ? `&before=${encodeURIComponent(before)}` : '';
            const archived = await discordApiFetch(`/channels/${ch.id}/threads/archived/public?limit=100${q}`, auth);
            const list = Array.isArray(archived.threads) ? archived.threads : [];
            threads.push(...list);
            const last = list[list.length - 1];
            before = last && last.thread_metadata && last.thread_metadata.archive_timestamp;
            if (!archived.has_more || !before) break;
          } catch { break; /* channels the bot cannot read have no archived threads to list */ }
          await new Promise(r => setTimeout(r, 200));
        }
        await new Promise(r => setTimeout(r, 200));
      }

      // De-duplicate threads and map to entries
      const seen = new Set();
      const threadEntries = [];
      for (const t of threads) {
        if (seen.has(t.id)) continue;
        seen.add(t.id);
        // Find parent channel
        const parent = channelsList.find(c => c.id === t.parent_id);
        const parentName = parent ? parent.name : null;

        // Resolve applied forum tags
        let tagNames = [];
        if (Array.isArray(t.applied_tags) && parent && parent.tags.length) {
          tagNames = t.applied_tags
            .map(tid => parent.tags.find(tag => tag.id === tid))
            .filter(Boolean)
            .map(tag => tag.name);
        }

        threadEntries.push({
          id: t.id,
          name: t.name,
          topic: '',
          category: (parent && parent.category) || null,
          type: 'thread',
          parentId: t.parent_id,
          parentName,
          tags: tagNames,
          // A public thread is open exactly when its parent channel is.
          ...(parent && parent.readable === false ? { readable: false } : {})
        });
      }

      res.json({ channels: channelsList, threads: threadEntries });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Step C: fetch all messages from selected channels → save temp → return preview
  // Reading a large server takes minutes. Held open as one request, it was
  // cut off by whatever sits in front of Haven (Cloudflare Tunnel gives up
  // after 100 seconds and answers with an HTML page). So the read runs as a
  // job: this starts it and answers at once, and the page asks for progress
  // until the result is ready.
  const fetchJobs = new Map();
  const executeJobs = new Map(); // the write step below runs the same way
  const FETCH_JOB_TTL = 30 * 60 * 1000;
  setInterval(() => {
    const cutoff = Date.now() - FETCH_JOB_TTL;
    for (const jobs of [fetchJobs, executeJobs]) {
      for (const [id, job] of jobs) if (job.updatedAt < cutoff) jobs.delete(id);
    }
  }, 5 * 60 * 1000).unref();

  app.post('/api/import/discord/fetch', express.json(), (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    const user = token ? verifyToken(token) : null;
    if (!user || !verifyAdminFromDb(user)) return res.status(403).json({ error: 'Admin only' });

    const auth = resolveImportAuth(req.body);
    if (auth.error) return res.status(400).json({ error: auth.error });
    const { guildName, channels: selected } = req.body;
    const guildId = typeof req.body.guildId === 'string' && DISCORD_ID.test(req.body.guildId) ? req.body.guildId : null;
    if (!Array.isArray(selected) || !selected.length || !selected.every(ch => typeof ch?.id === 'string' && DISCORD_ID.test(ch.id))) {
      return res.status(400).json({ error: 'Missing params' });
    }
    if ([...fetchJobs.values()].filter(j => j.state === 'running').length >= 3) {
      return res.status(429).json({ error: 'Other imports are still reading from Discord. Try again when they finish.' });
    }

    const jobId = crypto.randomBytes(16).toString('hex');
    const job = { userId: user.id, state: 'running', channelsDone: 0, channelsTotal: selected.length, messages: 0, updatedAt: Date.now() };
    fetchJobs.set(jobId, job);
    res.status(202).json({ jobId });
    readDiscordChannels(job, auth, guildName, selected, guildId).catch((err) => {
      console.warn('[import] Discord read failed:', err.message);
      Object.assign(job, { state: 'done', status: 400, body: { error: err.message }, updatedAt: Date.now() });
    });
  });

  app.get('/api/import/discord/fetch/:jobId', (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    const user = token ? verifyToken(token) : null;
    if (!user || !verifyAdminFromDb(user)) return res.status(403).json({ error: 'Admin only' });
    const job = fetchJobs.get(String(req.params.jobId));
    if (!job || job.userId !== user.id) return res.status(404).json({ error: 'That import is no longer running. Fetch the messages again.' });
    if (job.state === 'running') {
      return res.json({ state: 'running', channelsDone: job.channelsDone, channelsTotal: job.channelsTotal, messages: job.messages });
    }
    fetchJobs.delete(String(req.params.jobId));
    res.status(job.status).json({ state: 'done', ...job.body });
  });

  // Selected entries the Ferry bot can't read, worked out the same way as the
  // picker, so one picked anyway is skipped by name instead of importing as an
  // empty channel (Discord answers a channel without Read Message History
  // with no messages rather than an error).
  async function hiddenSelections(guildId, auth, selected) {
    const hidden = new Set();
    if (!auth.ferry || !guildId) return hidden;
    const access = await ferryAccess(guildId, auth);
    if (!access) return hidden;
    let byId;
    try {
      byId = new Map((await discordApiFetch(`/guilds/${guildId}/channels`, auth)).map(c => [String(c.id), c]));
    } catch (err) {
      // The read below still skips, by name, any channel Discord refuses.
      console.warn('[import] Could not list channels to check the Ferry bot can read them:', err.message);
      return hidden;
    }
    for (const ch of selected) {
      const own = byId.get(ch.id) || (typeof ch.parentId === 'string' ? byId.get(ch.parentId) : null);
      if (own && !canReadHistory(access, own)) hidden.add(ch.id);
    }
    return hidden;
  }

  async function readDiscordChannels(job, auth, guildName, selected, guildId = null) {
    const finish = (status, body) => Object.assign(job, { state: 'done', status, body, updatedAt: Date.now() });
    const result = {
      format: 'Discord Direct',
      serverName: guildName || 'Discord Import',
      channels: []
    };
    // Channels the reader can't open (a bot only sees what its roles allow)
    // are skipped and named, instead of failing the whole import.
    const skipped = [];
    const hidden = await hiddenSelections(guildId, auth, selected);
    // A bot without the Message Content intent gets every message with an
    // empty body, which would import as nothing at all.
    let peopleMessages = 0, emptyPeopleMessages = 0;

    // Discord rate-limits message reads per channel, so several channels can
    // be fetched at once without hitting the limits.
    const IMPORT_CONCURRENCY = 4;
    const fetched = new Array(selected.length);
    let nextIdx = 0;
    const worker = async () => {
    while (nextIdx < selected.length) {
      const idx = nextIdx++;
      const ch = selected[idx];
      const messages = [];
      let before = null, batch;
      // What the entry is (#5772): a thread goes into its parent channel, and
      // a forum becomes a Haven forum whose posts are its topics.
      const kind = ['text', 'announcement', 'forum', 'media', 'thread'].includes(ch.kind) ? ch.kind : 'text';
      const parentId = typeof ch.parentId === 'string' && DISCORD_ID.test(ch.parentId) ? ch.parentId : null;
      const tags = Array.isArray(ch.tags)
        ? ch.tags.filter(t => typeof t === 'string' && t.trim()).map(t => t.trim().slice(0, 30)).slice(0, 20)
        : [];
      const isForum = kind === 'forum' || kind === 'media';
      if (hidden.has(ch.id)) {
        skipped.push(ch.name || ch.id);
        job.channelsDone++;
        continue;
      }

      try {
        if (!isForum) do {
          let ep = `/channels/${ch.id}/messages?limit=100`;
          if (before) ep += `&before=${before}`;
          batch = await discordApiFetch(ep, auth);
          job.messages += batch.length;
          job.updatedAt = Date.now();

          for (const msg of batch) {
            if (msg.type !== 0 && msg.type !== 19) continue; // Default + Reply only
            if (!msg.author?.bot) {
              peopleMessages++;
              if (!msg.content && !msg.attachments?.length && !msg.embeds?.length && !msg.message_snapshots?.length) emptyPeopleMessages++;
            }
            // A forward keeps what was forwarded in a snapshot, not in its own content.
            const fwd = forwardedMessage(msg);
            const src = fwd && !msg.content && !msg.attachments?.length ? fwd : msg;
            let text = unescapeDiscord(src.content || '');
            if (Array.isArray(src.embeds)) {
              for (const e of src.embeds) {
                if (e.title) text += `\n🔗 **${unescapeDiscord(e.title)}**`;
                if (e.description) text += `\n${unescapeDiscord(e.description)}`;
                if (e.url && !text.includes(e.url)) text += `\n${e.url}`;
              }
            }
            text = text.trim();
            // Attachments go on lines of their own, under a forward's quote
            // rather than in it, so a copied picture still shows (importFiles.js).
            const files = (Array.isArray(src.attachments) ? src.attachments : [])
              .map(a => `📎 ${a.url ? '[' + a.filename + '](' + a.url + ')' : a.filename}`);
            if (!text && !files.length) continue;
            const head = src !== msg ? quoteForwarded(text) : text;
            const content = [head, ...files].filter(Boolean).join('\n');

            messages.push({
              discordId: msg.id,
              author: msg.author?.global_name || msg.author?.username || 'Unknown',
              authorId: msg.author?.id || null,
              authorAvatar: msg.author?.avatar
                ? `https://cdn.discordapp.com/avatars/${msg.author.id}/${msg.author.avatar}.png?size=64`
                : null,
              isBot: msg.author?.bot || false,
              content,
              timestamp: msg.timestamp,
              isPinned: msg.pinned || false,
              reactions: (msg.reactions || []).map(r => ({
                emoji: importedReactionEmoji(r.emoji),
                count: r.count || 1
              })).filter(r => isReactionEmoji(r.emoji)),
              replyTo: msg.message_reference?.message_id || null
            });
          }

          if (batch.length > 0) before = batch[batch.length - 1].id;
          await new Promise(r => setTimeout(r, 300)); // respect rate limits
        } while (batch.length === 100);
      } catch (err) {
        if (err.status !== 403) throw err;
        skipped.push(ch.name || ch.id);
        job.channelsDone++;
        continue;
      }
      job.channelsDone++;

      fetched[idx] = {
        discordId: ch.id,
        name: ch.name,
        topic: ch.topic || '',
        category: ch.category || null,
        kind,
        parentId,
        tags,
        messageCount: messages.length,
        messages
      };
    }
    };
    await Promise.all(Array.from({ length: Math.min(IMPORT_CONCURRENCY, selected.length) }, worker));
    for (const c of fetched) if (c) result.channels.push(c);

    if (auth.ferry && peopleMessages >= 5 && emptyPeopleMessages === peopleMessages) {
      return finish(400, { error: "Discord sent the messages without their text. On the Ferry bot's Bot page in the Discord Developer Portal, turn on Message Content Intent, then try again." });
    }
    if (!result.channels.length) {
      return finish(400, { error: auth.ferry
        ? "The Ferry bot can't read any of those channels. In Discord, add the bot's role to each one with View Channel and Read Message History, then try again."
        : "Couldn't read any of those channels." });
    }

    const importId = crypto.randomBytes(16).toString('hex');
    const tempPath = path.join(os.tmpdir(), `haven-import-${importId}.json`);
    fs.writeFileSync(tempPath, JSON.stringify(result));

    finish(200, {
      importId,
      skipped,
      format: result.format,
      serverName: result.serverName,
      channels: result.channels.map(c => ({
        discordId: c.discordId,
        name: c.name,
        topic: c.topic,
        category: c.category,
        messageCount: c.messageCount
      })),
      totalMessages: result.channels.reduce((sum, c) => sum + c.messageCount, 0)
    });
  }

  // ── Step 2: Execute the import ───────────────────────────
  // Writing a large import takes a while. Held open as one request it was cut
  // off by proxies in front of Haven (Cloudflare answers 524 after about 100
  // seconds), and as one transaction it froze the server for everyone until
  // it ended. So it runs as a job like the read above, writing a batch of
  // messages per transaction and letting other requests in between batches.
  const EXECUTE_BATCH = 1000;

  app.post('/api/import/discord/execute', express.json({ limit: '1mb' }), (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    const user = token ? verifyToken(token) : null;
    if (!user || !verifyAdminFromDb(user)) return res.status(403).json({ error: 'Admin only' });

    const { importId, selectedChannels } = req.body;
    // Copying pictures and files into Haven is on unless the page says not to.
    const copyFiles = req.body.copyFiles !== false;
    if (!importId || !Array.isArray(selectedChannels) || selectedChannels.length === 0) {
      return res.status(400).json({ error: 'Missing importId or selectedChannels' });
    }

    // Validate importId is hex-only (prevent path traversal)
    if (!/^[a-f0-9]{32}$/.test(importId)) {
      return res.status(400).json({ error: 'Invalid import ID' });
    }

    const tempPath = path.join(os.tmpdir(), `haven-import-${importId}.json`);
    if (!fs.existsSync(tempPath)) {
      return res.status(404).json({ error: 'Import data expired or not found. Please re-upload.' });
    }
    // One at a time: two imports writing the same channels would only slow
    // each other down.
    if ([...executeJobs.values()].some(j => j.state === 'running')) {
      return res.status(429).json({ error: 'Another import is being written. Try again when it finishes.' });
    }

    const jobId = crypto.randomBytes(16).toString('hex');
    const job = { userId: user.id, state: 'running', channelsDone: 0, channelsTotal: 0, messagesDone: 0, messagesTotal: 0, filesCopied: 0, updatedAt: Date.now() };
    executeJobs.set(jobId, job);
    res.status(202).json({ jobId });
    require('../httpAudit').auditHttp(user, 'discord_import', {
      details: { channels: selectedChannels.length, copyFiles },
    });
    writeImport(job, user, tempPath, selectedChannels, { copyFiles });
  });

  app.get('/api/import/discord/execute/:jobId', (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    const user = token ? verifyToken(token) : null;
    if (!user || !verifyAdminFromDb(user)) return res.status(403).json({ error: 'Admin only' });
    const job = executeJobs.get(String(req.params.jobId));
    if (!job || job.userId !== user.id) {
      return res.status(404).json({ error: 'That import is no longer running. Check the imported channels, and run the import again if messages are missing; messages already in Haven are skipped.' });
    }
    if (job.state === 'running') {
      return res.json({ state: 'running', channelsDone: job.channelsDone, channelsTotal: job.channelsTotal, messagesDone: job.messagesDone, messagesTotal: job.messagesTotal, filesCopied: job.filesCopied });
    }
    executeJobs.delete(String(req.params.jobId));
    res.status(job.status).json({ state: 'done', ...job.body });
  });

  // Writes the selected channels. Every step can run again safely: a channel
  // is found again by its Discord id, a thread by its starting message, and a
  // message already written is skipped. That is what makes batches safe: if
  // the import stops halfway, what was written stays, the job reports a
  // failure with how much got in, and running the import again finishes it.
  async function writeImport(job, user, tempPath, selectedChannels, { copyFiles = false } = {}) {
    const stats = { channelsCreated: 0, channelsReused: 0, messagesImported: 0, messagesSkipped: 0, threadsImported: 0, filesCopied: 0, filesLeftAsLinks: 0, diskFull: false };
    const finish = (status, body) => Object.assign(job, { state: 'done', status, body, updatedAt: Date.now() });
    const nextBatch = () => {
      job.updatedAt = Date.now();
      return new Promise(resolve => setImmediate(resolve));
    };

    try {
      const data = JSON.parse(await fs.promises.readFile(tempPath, 'utf-8'));
      const { getDb } = require('../database');
      const db = getDb();
      const { generateChannelCode } = require('../auth');
      const { generateUniqueChannelCode } = require('../channelRotation');

      // Where an imported message goes. user_id is NULL: imported messages
      // belong to no Haven account (#5771, src/importAuthors.js).
      const insertMsg = db.prepare(`
        INSERT OR IGNORE INTO messages (channel_id, user_id, content, created_at, webhook_username, webhook_avatar, is_webhook, imported_from, reply_to, discord_message_id, thread_id, title, tags)
        VALUES (?, NULL, ?, ?, ?, ?, 0, 'discord', ?, ?, ?, ?, ?)
      `);
      const lookupByDiscordId = db.prepare('SELECT id FROM messages WHERE channel_id = ? AND discord_message_id = ?');
      const insertPin = db.prepare('INSERT INTO pinned_messages (message_id, channel_id, pinned_by) VALUES (?, ?, ?)');
      const insertReaction = db.prepare('INSERT OR IGNORE INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?)');
      const channelByDiscordId = db.prepare('SELECT id, is_forum FROM channels WHERE discord_channel_id = ?');
      const toTs = (raw) => {
        try { return new Date(raw).toISOString().replace('T', ' ').replace('Z', ''); }
        catch { return raw; }
      };
      // Pictures and files come into Haven before their message is written
      // (src/importFiles.js), each held to the server's upload size limit.
      // A message already in Haven is not fetched again.
      const capBytes = (parseInt(db.prepare("SELECT value FROM server_settings WHERE key = 'max_upload_mb'").get()?.value, 10) || 25) * 1024 * 1024;
      const fileState = {};
      const copyFilesOf = async (channelId, msgs) => {
        if (!copyFiles) return;
        for (const msg of msgs) {
          if (fileState.stopped) break;
          if (!msg.content || !msg.content.includes('📎')) continue;
          if (msg.discordId && lookupByDiscordId.get(channelId, msg.discordId)) continue;
          msg.content = await copyAttachments(msg.content, { capBytes, state: fileState });
          job.filesCopied = fileState.copied || 0;
          job.updatedAt = Date.now();
        }
      };

      // Oldest first. Each time is worked out once, not on every comparison,
      // which on a channel of half a million messages saves seconds.
      const byTime = (list) => list
        .map(m => ({ m, t: +new Date(m.timestamp) }))
        .sort((a, b) => a.t - b.t)
        .map(e => e.m);

      const writeMessage = (channelId, threadId, msg, idMap) => {
        const content = (msg.content || '').trim();
        if (!content) return;
        const replyTo = msg.replyTo && idMap.has(msg.replyTo) ? idMap.get(msg.replyTo) : null;
        const result = insertMsg.run(
          channelId, content, toTs(msg.timestamp), msg.author || 'Unknown', msg.authorAvatar || null,
          replyTo, msg.discordId || null, threadId, null, null
        );
        if (result.changes === 0) {
          if (msg.discordId) {
            const existing = lookupByDiscordId.get(channelId, msg.discordId);
            if (existing) idMap.set(msg.discordId, existing.id);
          }
          stats.messagesSkipped++;
          return;
        }
        if (msg.discordId) idMap.set(msg.discordId, result.lastInsertRowid);
        stats.messagesImported++;

        if (msg.isPinned && !threadId) {
          try {
            insertPin.run(result.lastInsertRowid, channelId, user.id);
          } catch (err) {
            // Do not abort the import over one pin, but do not lose it silently either.
            console.warn('[import] Could not pin an imported message:', err.message);
          }
        }
        if (Array.isArray(msg.reactions)) {
          for (const r of msg.reactions) {
            if (!r || !isReactionEmoji(r.emoji)) continue;
            try {
              insertReaction.run(result.lastInsertRowid, user.id, r.emoji);
            } catch { /* a reaction is cosmetic and can number in the thousands; never abort the import over one */ }
          }
        }
      };

      // Adds one channel's (or one thread's) messages, oldest first, a batch
      // per transaction. Duplicates (same Discord id in the same channel) are
      // skipped, which is what makes importing again, or importing what Ferry
      // already carried, safe. The reply map lives across batches, so a reply
      // still finds a message written in an earlier one.
      const importMessages = async (channelId, messages, { threadId = null } = {}) => {
        const sorted = byTime(messages);
        const idMap = new Map(); // Discord message id -> Haven id, for replies
        for (let i = 0; i < sorted.length; i += EXECUTE_BATCH) {
          const batch = sorted.slice(i, i + EXECUTE_BATCH);
          await copyFilesOf(channelId, batch);
          const counted = { ...stats };
          try {
            db.transaction(() => {
              for (const msg of batch) writeMessage(channelId, threadId, msg, idMap);
            })();
          } catch (err) {
            // The batch was rolled back, so its messages do not count.
            Object.assign(stats, counted);
            throw err;
          }
          job.messagesDone += batch.length;
          await nextBatch();
        }
      };

      // A Discord thread inside a channel that is in Haven (#5772): its
      // messages become a Haven thread there. In a forum the post becomes a
      // topic, its first message the opening post. In a chat channel the
      // thread hangs from the message it was started from, or from a line with
      // its name when that message is not in Haven.
      const importThread = async (parent, channelData) => {
        const threadDiscordId = channelData.discordId;
        const messages = channelData.messages || [];
        let root = lookupByDiscordId.get(parent.id, threadDiscordId);
        let replies = messages;
        if (parent.is_forum) {
          const starter = messages.find(m => m.discordId === threadDiscordId) || byTime(messages)[0];
          if (!root) {
            if (!starter) return;
            await copyFilesOf(parent.id, [starter]);
            const title = sanitizeText(String(channelData.name || '').trim().replace(/\s+/g, ' ').slice(0, 120)) || 'Untitled';
            const tags = Array.isArray(channelData.tags) && channelData.tags.length ? JSON.stringify(channelData.tags.slice(0, 5)) : null;
            const r = insertMsg.run(
              parent.id, (starter.content || '').trim() || title, toTs(starter.timestamp), starter.author || 'Unknown',
              starter.authorAvatar || null, null, threadDiscordId, null, title, tags
            );
            root = { id: r.lastInsertRowid };
            stats.messagesImported++;
          }
          if (starter) job.messagesDone++;
          replies = messages.filter(m => m !== starter);
        } else if (!root) {
          const first = byTime(messages)[0];
          if (!first) return;
          const r = insertMsg.run(
            parent.id, `🧵 ${sanitizeText(String(channelData.name || '').slice(0, 100)) || 'Thread'}`, toTs(first.timestamp),
            first.author || 'Unknown', first.authorAvatar || null, null, threadDiscordId, null, null, null
          );
          root = { id: r.lastInsertRowid };
        }
        await importMessages(parent.id, replies, { threadId: root.id });
        stats.threadsImported++;
      };

      // Finds the Haven channel made from this Discord channel, or makes one.
      // Reusing it makes re-importing (or importing a second overlapping
      // export) idempotent: new messages are appended, duplicates are
      // skipped, and native Haven messages are untouched.
      const channelFor = db.transaction((sel, channelData) => {
        const discordChannelId = channelData.discordId || null;
        if (discordChannelId) {
          const existing = channelByDiscordId.get(discordChannelId);
          if (existing) {
            stats.channelsReused++;
            return existing.id;
          }
        }
        const channelName = [...(sel.name || channelData.name)].slice(0, 50).join('');
        const code = generateUniqueChannelCode(db, generateChannelCode);
        // A Discord forum (or media channel) becomes a Haven forum with the
        // same tags; its posts come in as topics (#5772).
        const isForum = channelData.kind === 'forum' || channelData.kind === 'media';
        const forumTags = isForum && Array.isArray(channelData.tags) && channelData.tags.length
          ? JSON.stringify(channelData.tags.slice(0, 20).map(name => ({ name })))
          : null;
        const chResult = db.prepare(
          'INSERT INTO channels (name, code, created_by, topic, discord_channel_id, is_forum, forum_tags) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run(channelName, code, user.id, channelData.topic || '', discordChannelId, isForum ? 1 : 0, forumTags);
        // Auto-join the importing admin
        db.prepare('INSERT OR IGNORE INTO channel_members (channel_id, user_id) VALUES (?, ?)').run(chResult.lastInsertRowid, user.id);
        stats.channelsCreated++;
        return chResult.lastInsertRowid;
      });

      // Channels first, so a thread finds its parent already in Haven.
      const entries = [];
      for (const sel of selectedChannels) {
        // Find channel data by discordId or original name
        const channelData = data.channels.find(c =>
          (sel.discordId && c.discordId === sel.discordId) ||
          c.name === sel.originalName
        );
        if (!channelData || !channelData.messages) continue;
        entries.push({ sel, channelData });
      }
      entries.sort((a, b) => (a.channelData.kind === 'thread') - (b.channelData.kind === 'thread'));
      job.channelsTotal = entries.length;
      job.messagesTotal = entries.reduce((n, e) => n + (Array.isArray(e.channelData.messages) ? e.channelData.messages.length : 0), 0);
      await nextBatch();

      for (const { sel, channelData } of entries) {
        let parent = null;
        if (channelData.kind === 'thread' && channelData.parentId) {
          parent = channelByDiscordId.get(channelData.parentId);
          // Without it in Haven, the thread gets a channel of its own.
        }
        if (parent) await importThread(parent, channelData);
        else await importMessages(channelFor(sel, channelData), channelData.messages);
        job.channelsDone++;
      }

      // Clean up temp file
      try { fs.unlinkSync(tempPath); } catch { /* cleanupTempImports() sweeps any haven-import leftover */ }

      Object.assign(stats, { filesCopied: fileState.copied || 0, filesLeftAsLinks: fileState.skipped || 0, diskFull: !!fileState.stopped });
      finish(200, { success: true, ...stats });
    } catch (err) {
      console.error('Import execute error:', err);
      // The batches written so far stay. Keep the import file a while longer
      // so running the import again can finish the rest.
      try {
        const now = new Date();
        fs.utimesSync(tempPath, now, now);
      } catch (touchErr) {
        console.warn('[import] Could not keep the import file for a retry:', touchErr.message);
      }
      finish(500, { error: 'Import failed: ' + err.message, ...stats });
    }
  }

  // ── Periodic cleanup of orphaned import temp files (1 hour TTL) ──
  function cleanupTempImports() {
    try {
      const tmpDir = os.tmpdir();
      const cutoff = Date.now() - 60 * 60 * 1000; // 1 hour
      for (const f of fs.readdirSync(tmpDir)) {
        if (!f.startsWith('haven-import-')) continue;
        const fp = path.join(tmpDir, f);
        try {
          const stat = fs.statSync(fp);
          if (stat.mtimeMs < cutoff) fs.unlinkSync(fp);
        } catch { /* file in use or already removed; the next sweep retries */ }
      }
    } catch { /* temp dir unreadable; orphaned import files are only disk clutter */ }
  }
  // Run once at startup to clean up any stale files from previous crashes
  cleanupTempImports();
  setInterval(cleanupTempImports, 15 * 60 * 1000); // then every 15 min

};
