/**
 * Haven: notification previews
 *
 * Loaded by BOTH the Node server (push notifications, src/socketHandlers)
 * and the browser (desktop notifications, plain <script> tag), so a push and
 * an in-page notification read the same. The Android and iOS apps run the
 * same rules (HavenShared MarkdownTable.preview) on their local
 * notifications; the expected outputs in test/notifyPreview.test.js are the
 * shared vectors both sides are held to.
 *
 * A notification is plain text, so markdown shows up raw: a table arrives as
 * "| a | b |" over "|---|---|". The preview flattens it the way the apps'
 * reply previews do: each row's cells joined with " · ", the header and the
 * first three rows, then "+N more rows". Bold/italic/strike/highlight/
 * underline markers, inline code ticks, code fences, headings, quotes, link
 * and image syntax go; a spoiler stays hidden behind a fixed mask so its
 * length gives nothing away either.
 *
 * Table detection follows the apps' parser: a header row with pipes, a
 * delimiter row of dashes (optionally with colons) with as many cells, then
 * rows until a blank line, a fence or a line with no pipe.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HavenNotifyPreview = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const PREVIEW_ROWS = 3;
  const MAX_COLUMNS = 20;
  const MAX_ROWS = 200;
  const SPOILER_MASK = '▒▒▒▒▒';
  const DELIM = /^:?-+:?$/;
  const SPOILER = /\|\|(.+?)\|\|/g;
  const INLINE_PRE = [
    [/!\[([^\]]*)]\((?:[^)]+)\)/g, '$1'],
    [/c#[0-9a-fA-F]{6}(.+?)#c/g, '$1'],
    [/c#\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)(.+?)#c/g, '$1'],
  ];
  const PLAIN = [
    [/\[([^\]]+)]\((?:[^)]+)\)/g, '$1'],
    [/(\*\*|__|~~|==|\|\||`)(.+?)\1/g, '$2'],
    [/(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?!\*)/g, '$1'],
    [/<a?:([A-Za-z0-9_]{2,32}):[0-9]{15,25}>/g, ':$1:'],
  ];
  const BLOCK = /^\s*(?:#{1,6}\s+|-#\s+|(?:>\s?)+)/;
  const FENCE = /^\s*(?:```|~~~)/;
  const ONE_LINE_FENCE = /```([^`\n]+)```/g;

  function ticks(s, at) { let n = 0; while (at + n < s.length && s[at + n] === '`') n++; return n; }
  function closes(s, from, run) {
    let i = from;
    while (i < s.length) { const n = ticks(s, i); if (n === run) return true; i += Math.max(n, 1); }
    return false;
  }

  // One table row's cells, or null when the line has no unescaped pipe
  // outside inline code.
  function cells(line) {
    const s = line.trim();
    if (!s || s === '|') return null;
    const out = [];
    let cur = '';
    let i = 0, code = 0, pipes = 0, trailing = false;
    while (i < s.length) {
      const c = s[i];
      trailing = false;
      if (c === '\\' && i + 1 < s.length) {
        cur += s[i + 1] === '|' ? '|' : c + s[i + 1];
        i += 2;
      } else if (c === '`') {
        const n = ticks(s, i);
        code = code === 0 ? (closes(s, i + n, n) ? n : 0) : (n === code ? 0 : code);
        cur += s.slice(i, i + n);
        i += n;
      } else if (c === '|' && code === 0) {
        out.push(cur); cur = ''; pipes++; i++; trailing = true;
      } else {
        cur += c; i++;
      }
    }
    if (pipes === 0) return null;
    if (!trailing) out.push(cur);
    if (s.startsWith('|')) out.shift();
    const trimmed = out.map(x => x.trim());
    return trimmed.length ? trimmed : null;
  }

  function isDelimiterRow(line) {
    const c = cells(line);
    return !!c && c.every(x => DELIM.test(x)) ? c : null;
  }

  function fenceToggle(line) { return ((line.match(/```|~~~/g) || []).length % 2) === 1; }

  function table(lines, i) {
    const head = cells(lines[i]);
    if (!head) return null;
    const delim = isDelimiterRow(lines[i + 1]);
    if (!delim || head.length !== delim.length || head.length > MAX_COLUMNS) return null;
    let j = i + 2;
    const rows = [];
    while (j < lines.length && lines[j].trim() && !fenceToggle(lines[j])) {
      const c = cells(lines[j]);
      if (!c) break;
      rows.push(head.map((_, k) => c[k] !== undefined ? c[k] : ''));
      j++;
    }
    return rows.length > MAX_ROWS ? null : { table: { header: head, rows }, next: j };
  }

  // The message split into text and table parts, like the apps'
  // MarkdownTable.parts. No table is found inside a code fence.
  function parts(text) {
    if (!text.includes('|') || !text.includes('-')) return [{ text }];
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    const out = [];
    let buf = [];
    let fence = false;
    let i = 0;
    const flush = () => {
      if (buf.length) { const t = buf.join('\n'); if (t.trim()) out.push({ text: t }); buf = []; }
    };
    while (i < lines.length) {
      const t = !fence && i + 1 < lines.length ? table(lines, i) : null;
      if (t) { flush(); out.push({ table: t.table }); i = t.next; continue; }
      if (fenceToggle(lines[i])) fence = !fence;
      buf.push(lines[i]);
      i++;
    }
    flush();
    return out.length ? out : [{ text }];
  }

  function plain(s) {
    return PLAIN.reduce((acc, [re, to]) => acc.replace(re, to), s).trim();
  }

  function inlinePlain(s) {
    return plain(INLINE_PRE.reduce((acc, [re, to]) => acc.replace(re, to), s.replace(SPOILER, SPOILER_MASK)));
  }

  /**
   * A message as notification text.
   * @param {string} text  the message as sent
   * @param {object} [opts]
   * @param {number} [opts.rows=3]  table rows shown under the header
   * @param {(n:number)=>string} [opts.more]  label for the rows left out
   */
  function preview(text, opts = {}) {
    const rows = Number.isInteger(opts.rows) ? opts.rows : PREVIEW_ROWS;
    const more = typeof opts.more === 'function' ? opts.more : (n => `+${n} more rows`);
    let fence = false;
    const lines = [];
    for (const p of parts(String(text || '').replace(/\r\n/g, '\n').replace(ONE_LINE_FENCE, '$1'))) {
      if (p.table) {
        for (const r of [p.table.header, ...p.table.rows.slice(0, rows)]) lines.push(r.map(inlinePlain).join(' · '));
        if (p.table.rows.length > rows) lines.push(more(p.table.rows.length - rows));
        continue;
      }
      for (const l of p.text.split('\n')) {
        if (FENCE.test(l)) { fence = !fence; continue; }
        lines.push(fence ? l.trimEnd() : inlinePlain(l.replace(BLOCK, '')).trimEnd());
      }
    }
    return lines.filter(l => l.trim()).join('\n').trim();
  }

  return { PREVIEW_ROWS, SPOILER_MASK, parts, preview };
}));
