'use strict';

// GET /uploads/<rel>. Haven reads the file from storage (local disk or the
// bucket) and streams it out itself, so the safety headers below apply
// whichever driver holds it. This follows what express.static (send) did for
// the same requests: conditional GETs, one byte range, HEAD, and falling
// through to the app's 404 for anything it will not serve.

const path = require('path');
const mime = require('express').static.mime;
const { UPLOADS_DIR } = require('../paths');
const { isContainedRelPath } = require('./paths');

const UPLOAD_MEDIA_EXTS = new Set([
  '.mp3', '.ogg', '.oga', '.wav', '.m4a', '.aac', '.flac', '.opus', '.weba',
  '.mp4', '.webm', '.mov', '.m4v', '.ogv',
]);
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);
const MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

// ── Block access to internal upload folders ─────────────
// Files moved into deleted-attachments are no longer part of any message and
// must stop being reachable, which is the entire point of moving them.
//
// A 404 mounted at the prefix does not achieve that. Express matches the mount
// against the raw path while the file lookup decodes before it resolves, so
// three shapes walked straight past the guard and served the file:
// /uploads/deleted%2Dattachments/x, /uploads//deleted-attachments/x, and
// /uploads/deleted-attachments%2Fx. Anyone who saw an attachment before it was
// deleted knows its filename, so deletion was not actually revoking access.
//
// Decode the path, resolve it against the uploads root, and check containment,
// so it is the real target being judged rather than the spelling of the URL.
// path.resolve is only string work here; the folder need not exist. Compared
// case-insensitively because NTFS is.
const BLOCKED_UPLOAD_DIRS = ['deleted-attachments', 'bot-audio'].map(
  dir => path.resolve(UPLOADS_DIR, dir).toLowerCase()
);
function blockInternalUploads(req, res, next) {
  let decoded;
  try { decoded = decodeURIComponent(req.path); } catch { return res.status(400).end(); }
  // Windows also answers to a folder's 8.3 short name (DELETE~1 for
  // deleted-attachments), and ignores a trailing dot or space and anything
  // after a colon (alternate streams). None of those appear in a real upload
  // name, so a path with any of them is refused before it can slip past.
  if (decoded.split(/[\\/]/).some(seg => seg.includes('~') || seg.includes(':') || /[. ]$/.test(seg))) {
    return res.status(404).end();
  }
  // path.resolve treats a backslash as a separator on Windows and as an
  // ordinary filename character on Linux, which is exactly right in both
  // cases, so the raw decoded path goes in as-is.
  const target = path.resolve(UPLOADS_DIR, '.' + decoded).toLowerCase();
  for (const blocked of BLOCKED_UPLOAD_DIRS) {
    if (target === blocked || target.startsWith(blocked + path.sep)) return res.status(404).end();
  }
  return next();
}

// Force download for non-image files (prevents HTML/SVG execution in browser).
function setSafetyHeaders(res, ext) {
  if (IMAGE_EXTS.has(ext)) {
    // Allow cross-origin access for images (needed for server icon pulling).
    // CORP override is required because helmet defaults to 'same-origin', which
    // would otherwise block cross-origin <img> loads even with ACAO set.
    // Vary: Origin prevents a non-CORS cached response from being reused for a
    // CORS request (which is what causes the "No 'Access-Control-Allow-Origin'
    // header is present" error on a cached image).
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Vary', 'Origin');
  } else if (ext === '.svg') {
    // SVG (issue #5309): renderable inline via <img> tag (browsers run SVG in
    // "secure static mode": no scripts, no XHR), but direct navigation still
    // gets attachment-disposition so opening the raw URL in a new tab can't
    // execute the file. CSP doubles up on that: even if a future browser
    // change allowed any external loads inside <img>-rendered SVG, this
    // header forbids everything except inline styles (needed for fill/stroke).
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Vary', 'Origin');
    res.setHeader('Content-Disposition', 'attachment');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  } else {
    res.setHeader('Content-Disposition', 'attachment');
    // Anyone can upload a file, and one served as JavaScript (or HTML, CSS,
    // XML) from Haven's own origin counts as 'self' in the CSP: a <script
    // src="/uploads/x.js"> anywhere would run it, whatever the disposition
    // says. Only audio and video keep their real type, for the inline
    // players; everything else is opaque bytes, which nosniff refuses to
    // run as script.
    if (!UPLOAD_MEDIA_EXTS.has(ext)) res.setHeader('Content-Type', 'application/octet-stream');
  }
}

const parseHttpDate = (d) => { const t = d && Date.parse(d); return typeof t === 'number' ? t : NaN; };

function preconditionFailed(req, res) {
  const match = req.headers['if-match'];
  if (match) {
    const etag = res.getHeader('ETag');
    return !etag || (match !== '*' && match.split(/ *, */).every(m => m !== etag && m !== 'W/' + etag && 'W/' + m !== etag));
  }
  const since = parseHttpDate(req.headers['if-unmodified-since']);
  if (!isNaN(since)) {
    const last = parseHttpDate(res.getHeader('Last-Modified'));
    return isNaN(last) || last > since;
  }
  return false;
}

function rangeFresh(req, res) {
  const ifRange = req.headers['if-range'];
  if (!ifRange) return true;
  if (ifRange.includes('"')) {
    const etag = res.getHeader('ETag');
    return Boolean(etag && ifRange.includes(etag));
  }
  return parseHttpDate(res.getHeader('Last-Modified')) <= parseHttpDate(ifRange);
}

function notModified(res) {
  for (const h of ['Content-Encoding', 'Content-Language', 'Content-Length', 'Content-Range', 'Content-Type']) res.removeHeader(h);
  res.statusCode = 304;
  res.end();
}

/** The rel path a request names, or null when it names nothing servable. */
function relFromRequest(req) {
  let p;
  try { p = decodeURIComponent(req.path); } catch { return null; }
  if (p.includes('\0')) return null;
  if (process.platform === 'win32') p = p.replace(/\\/g, '/');
  if (p.endsWith('/')) return null;                     // a folder: nothing to serve
  if (p.split('/').includes('..')) return null;
  const rel = path.posix.normalize(p).replace(/^\/+/, '');
  if (!isContainedRelPath(rel)) return null;
  // Dotfiles are refused, as express.static's dotfiles: 'deny' did.
  if (rel.split('/').some(s => s.length > 1 && s[0] === '.')) return null;
  return rel;
}

function serveUploads(storage) {
  return async function serveUpload(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const rel = relFromRequest(req);
    if (!rel) return next();

    let meta;
    try { meta = await storage.head(rel); } catch (err) { return next(err); }
    if (!meta) return next();

    const ext = path.extname(rel).toLowerCase();
    setSafetyHeaders(res, ext);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', `public, max-age=${MAX_AGE_SECONDS}, immutable`);
    res.setHeader('Last-Modified', meta.lastModified.toUTCString());
    res.setHeader('ETag', meta.etag);
    if (!res.getHeader('Content-Type')) {
      const type = mime.lookup(rel);
      const charset = mime.charsets.lookup(type);
      res.setHeader('Content-Type', type + (charset ? '; charset=' + charset : ''));
    }

    // Once the file was found, express.static passed a failed precondition or
    // an unsatisfiable range on to the app's error handler; it still goes there.
    const httpError = (status, headers) => Object.assign(new Error(status === 412 ? 'Precondition Failed' : 'Range Not Satisfiable'),
      { status, statusCode: status, expose: true, headers });
    if (preconditionFailed(req, res)) return next(httpError(412));
    if (req.fresh) return notModified(res);

    let len = meta.size;
    let range;
    const header = req.headers.range;
    if (header && /^ *bytes=/.test(header)) {
      let ranges = req.range(meta.size, { combine: true });
      if (!rangeFresh(req, res)) ranges = -2;
      if (ranges === -1) {
        res.setHeader('Content-Range', `bytes */${meta.size}`);
        return next(httpError(416, { 'Content-Range': `bytes */${meta.size}` }));
      }
      if (ranges !== -2 && Array.isArray(ranges) && ranges.length === 1) {
        range = ranges[0];
        res.statusCode = 206;
        res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${meta.size}`);
        len = range.end - range.start + 1;
      }
    }
    res.setHeader('Content-Length', len);
    if (req.method === 'HEAD') return res.end();

    let body;
    try { body = await storage.getStream(rel, { range }); } catch (err) { return next(err); }
    if (!body) return next();
    const { stream } = body;
    // A seek or a closed tab abandons the response; let go of the source too.
    res.on('close', () => stream.destroy());
    stream.on('error', (err) => {
      if (!res.headersSent) return next(err);
      res.destroy(err);
    });
    stream.pipe(res);
  };
}

module.exports = { blockInternalUploads, serveUploads, setSafetyHeaders, UPLOAD_MEDIA_EXTS };
