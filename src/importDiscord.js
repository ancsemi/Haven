// ── Discord Import Parser ─────────────────────────────────
// Supports:
//   1. DiscordChatExporter JSON   (single channel)
//   2. DiscordChatExporter ZIP    (multi-channel)
//   3. Discord official data package ZIP (Settings → Privacy → Request Data)
//
// Returns: { format, serverName, channels: [{ name, topic, category, messageCount, messages }] }

const fs = require('fs');
const path = require('path');

// ── Public entry point ──────────────────────────────────────
function parseDiscordExport(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.json') return parseSingleJson(filePath);
  if (ext === '.zip')  return parseZip(filePath);

  throw new Error('Unsupported file type. Upload a .json or .zip file.');
}

// ── Single JSON (DiscordChatExporter) ───────────────────────
function parseSingleJson(filePath) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  let data;
  try { data = JSON.parse(raw); }
  catch { throw new Error('File is not valid JSON.'); }

  // Standard DCE format: { guild, channel, messages }
  if (data.guild && data.channel && Array.isArray(data.messages)) {
    return buildDCEResult(data);
  }

  // Array of exports (rare but possible)
  if (Array.isArray(data)) {
    const channels = [];
    let serverName = 'Unknown Server';
    for (const item of data) {
      if (item.guild && item.channel && Array.isArray(item.messages)) {
        const r = buildDCEResult(item);
        serverName = r.serverName;
        channels.push(...r.channels);
      }
    }
    if (channels.length > 0) return { format: 'DiscordChatExporter', serverName, channels };
  }

  throw new Error('Unrecognized JSON format. Expected a DiscordChatExporter export.');
}

// ── ZIP file (detect DCE vs official package) ───────────────
function parseZip(filePath) {
  const AdmZip = require('adm-zip');
  let zip;
  try { zip = new AdmZip(filePath); }
  catch { throw new Error('Could not open ZIP file — it may be corrupt.'); }

  const entries = zip.getEntries();

  const jsonFiles = entries.filter(e => !e.isDirectory && e.entryName.endsWith('.json')
    && !e.entryName.startsWith('__MACOSX'));
  const csvEntries = entries.filter(e => !e.isDirectory &&
    /messages[/\\]c?\d+[/\\]messages\.csv$/i.test(e.entryName));

  // DiscordChatExporter ZIPs contain per-channel .json files
  if (jsonFiles.length > 0 && csvEntries.length === 0) {
    return parseDCEZip(zip, jsonFiles);
  }

  // Discord official data package has messages/cXXXX/messages.csv
  if (csvEntries.length > 0) {
    return parseOfficialZip(zip, entries);
  }

  throw new Error('Could not detect export format inside ZIP. Expected DiscordChatExporter JSON files or a Discord data package.');
}

// ── DCE ZIP (multiple .json files) ──────────────────────────
function parseDCEZip(zip, jsonFiles) {
  const channels = [];
  let serverName = 'Unknown Server';

  for (const entry of jsonFiles) {
    try {
      const raw = zip.readAsText(entry);
      const data = JSON.parse(raw);
      if (data.guild && data.channel && Array.isArray(data.messages)) {
        const r = buildDCEResult(data);
        serverName = r.serverName;
        channels.push(...r.channels);
      }
    } catch { /* skip unparseable */ }
  }

  if (channels.length === 0) {
    throw new Error('No valid DiscordChatExporter channels found in the ZIP.');
  }

  return { format: 'DiscordChatExporter', serverName, channels };
}

// ── Discord official data package ───────────────────────────
function parseOfficialZip(zip, entries) {
  let serverName = 'Discord Import';

  // Try to grab the server name from servers/*/guild.json
  const guildJsons = entries.filter(e =>
    /servers[/\\]\d+[/\\]guild\.json$/i.test(e.entryName) && !e.isDirectory);
  if (guildJsons.length > 0) {
    try {
      const g = JSON.parse(zip.readAsText(guildJsons[0]));
      if (g.name) serverName = g.name;
    } catch {}
  }

  // Build channel map from channel.json files
  const channelJsons = entries.filter(e =>
    /messages[/\\]c?\d+[/\\]channel\.json$/i.test(e.entryName) && !e.isDirectory);
  const csvEntries = entries.filter(e =>
    /messages[/\\]c?\d+[/\\]messages\.csv$/i.test(e.entryName) && !e.isDirectory);

  const channelMap = {};
  for (const entry of channelJsons) {
    try {
      const dir = path.posix.dirname(entry.entryName.replace(/\\/g, '/'));
      const info = JSON.parse(zip.readAsText(entry));
      channelMap[dir] = {
        discordId: info.id || dir,
        name: info.name || 'unknown-channel',
        topic: '',
        category: null,
        messages: [],
        messageCount: 0
      };
      if (info.guild?.name) serverName = info.guild.name;
    } catch {}
  }

  // Parse CSV files
  for (const entry of csvEntries) {
    const dir = path.posix.dirname(entry.entryName.replace(/\\/g, '/'));
    const ch = channelMap[dir];
    if (!ch) continue;
    try {
      const csv = zip.readAsText(entry);
      const msgs = parseCSV(csv);
      ch.messages = msgs;
      ch.messageCount = msgs.length;
    } catch {}
  }

  const channels = Object.values(channelMap).filter(c => c.messageCount > 0);
  if (channels.length === 0) {
    throw new Error('No channels with messages found in the data package.');
  }

  return { format: 'Discord Data Package', serverName, channels };
}

// ── Build a result from a single DCE JSON object ────────────
function buildDCEResult(data) {
  const messages = [];

  for (const msg of data.messages) {
    // Only import regular messages and replies
    const type = msg.type || 'Default';
    if (type !== 'Default' && type !== 'Reply') continue;

    let content = msg.content || '';
    // Append attachment links
    if (Array.isArray(msg.attachments)) {
      for (const a of msg.attachments) {
        const name = a.fileName || a.filename || 'file';
        const url = a.url || '';
        content += `\n📎 ${url ? `[${name}](${url})` : name}`;
      }
    }
    content = content.trim();
    if (!content) continue;

    messages.push({
      discordId: msg.id,
      author: msg.author?.nickname || msg.author?.name || 'Unknown',
      authorId: msg.author?.id || null,
      authorAvatar: msg.author?.avatarUrl || null,
      isBot: msg.author?.isBot || false,
      content,
      timestamp: msg.timestamp,
      isPinned: msg.isPinned || false,
      reactions: (msg.reactions || []).map(r => ({
        emoji: typeof r.emoji === 'string' ? r.emoji : (r.emoji?.name || '❓'),
        count: r.count || 1
      })),
      replyTo: msg.reference?.messageId || null
    });
  }

  return {
    format: 'DiscordChatExporter',
    serverName: data.guild?.name || 'Unknown Server',
    channels: [{
      discordId: data.channel?.id || null,
      name: data.channel?.name || 'unknown',
      topic: data.channel?.topic || '',
      category: data.channel?.category || null,
      messageCount: messages.length,
      messages
    }]
  };
}

// ── CSV parser for official data package ────────────────────
// Format: ID,Timestamp,Contents,Attachments
function parseCSV(csvText) {
  const lines = csvText.split('\n');
  if (lines.length < 2) return [];

  const messages = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const fields = splitCSVLine(line);
    if (fields.length < 3) continue;

    const [id, timestamp, contents, attachments] = fields;
    let content = contents || '';

    // Append any attachment URLs
    if (attachments) {
      const urls = attachments.split(' ').filter(u => u.startsWith('http'));
      for (const url of urls) {
        const name = url.split('/').pop()?.split('?')[0] || 'file';
        content += `\n📎 [${name}](${url})`;
      }
    }
    content = content.trim();
    if (!content) continue;

    messages.push({
      discordId: id,
      author: 'You',               // Official package only has your own messages
      authorId: null,
      isBot: false,
      content,
      timestamp,
      isPinned: false,
      reactions: [],
      replyTo: null
    });
  }

  return messages;
}

// ── RFC 4180 CSV line splitter ──────────────────────────────
function splitCSVLine(line) {
  const fields = [];
  let cur = '';
  let inQ = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else {
        cur += ch;
      }
    } else {
      if (ch === '"') inQ = true;
      else if (ch === ',') { fields.push(cur); cur = ''; }
      else cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

module.exports = { parseDiscordExport };
