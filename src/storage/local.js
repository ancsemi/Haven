'use strict';

// Files kept on this machine's disk, under uploads/. This is how Haven has
// always stored media; the S3 driver (s3.js) keeps the same keys in a bucket.

const fs = require('fs');
const path = require('path');
const { DELETED_PREFIX } = require('./paths');

function moveFile(src, dst) {
  try { fs.renameSync(src, dst); } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    fs.copyFileSync(src, dst);
    fs.unlinkSync(src);
  }
}

// The same weak tag express.static sent, so browsers' cached copies stay valid.
function weakEtag(size, mtime) {
  return `W/"${size.toString(16)}-${mtime.getTime().toString(16)}"`;
}

class LocalStorage {
  constructor(root) {
    this.root = root;
    this.kind = 'local';
  }

  _abs(rel) { return path.join(this.root, rel); }

  _stat(rel) {
    try {
      const st = fs.statSync(this._abs(rel));
      return st.isFile() ? st : null;
    } catch { return null; }
  }

  async put(rel, localPath) {
    const dst = this._abs(rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    moveFile(localPath, dst);
    return { size: fs.statSync(dst).size };
  }

  async head(rel) {
    const st = this._stat(rel);
    return st ? { size: st.size, lastModified: st.mtime, etag: weakEtag(st.size, st.mtime) } : null;
  }

  async getStream(rel, { range } = {}) {
    const st = this._stat(rel);
    if (!st) return null;
    const stream = fs.createReadStream(this._abs(rel), range ? { start: range.start, end: range.end } : {});
    return { stream, size: st.size, lastModified: st.mtime, etag: weakEtag(st.size, st.mtime) };
  }

  async readBuffer(rel) {
    try { return fs.readFileSync(this._abs(rel)); } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'EISDIR') return null;
      throw err;
    }
  }

  async remove(rel) {
    try { fs.unlinkSync(this._abs(rel)); } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    // A purge empties the sub-folders deleted files kept their layout in;
    // those go, the deleted-attachments folder itself stays.
    if (rel.startsWith(DELETED_PREFIX)) {
      const top = this._abs(DELETED_PREFIX);
      for (let dir = path.dirname(this._abs(rel)); dir.length > top.length && dir.startsWith(top); dir = path.dirname(dir)) {
        try { fs.rmdirSync(dir); } catch { break; }   // not empty, or in use: harmless, the next purge tries again
      }
    }
  }

  async softDelete(rel) {
    if (rel.startsWith(DELETED_PREFIX)) return false;
    if (!this._stat(rel)) return false;
    const dst = this._abs(DELETED_PREFIX + rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    try { fs.renameSync(this._abs(rel), dst); } catch (err) {
      if (err.code === 'ENOENT') return false;   // already moved by another path
      throw err;
    }
    // A rename keeps the upload's own timestamp. The retention window counts
    // from the deletion, so stamp the file now.
    try { const now = new Date(); fs.utimesSync(dst, now, now); } catch { /* purge falls back to the upload time */ }
    return true;
  }

  async restore(rel) {
    const src = this._abs(DELETED_PREFIX + rel);
    if (!fs.existsSync(src)) return false;
    const dst = this._abs(rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    moveFile(src, dst);
    return true;
  }

  async *list(prefix = '') {
    const walk = function* (dir, rel) {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const sub = rel ? `${rel}/${e.name}` : e.name;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { yield* walk(full, sub); continue; }
        if (!e.isFile()) continue;
        let st;
        try { st = fs.statSync(full); } catch { continue; }   // vanished mid-walk
        yield { rel: sub, size: st.size, lastModified: st.mtime };
      }
    };
    const start = prefix.replace(/\/+$/, '');
    yield* walk(start ? this._abs(start) : this.root, start);
  }

  async ping() {
    fs.mkdirSync(this.root, { recursive: true });
    fs.accessSync(this.root, fs.constants.R_OK | fs.constants.W_OK);
  }
}

module.exports = { LocalStorage, moveFile, weakEtag };
