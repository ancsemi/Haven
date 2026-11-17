'use strict';

// Haven's own CHANGELOG.md, read for the "What's new" popup. Nothing is
// fetched from outside: a server shows the notes it shipped with.

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'CHANGELOG.md');
const MAX_SECTIONS = 12;
const MAX_BODY = 20000;

// "4.27.0-beta.4" -> { base: [4, 27, 0], pre: true }, or null.
function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$/.exec(String(v || '').trim());
  return m ? { base: [+m[1], +m[2], +m[3]], pre: !!m[4] } : null;
}

function compareBase(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

// How big the step from one version to another is: 'major', 'minor' or
// 'patch' (betas of the same release count as 'patch'), or null when it is
// not a step forward.
function updateLevel(from, to) {
  const a = parseVersion(from);
  const b = parseVersion(to);
  if (!a || !b || from === to) return null;
  const cmp = compareBase(a.base, b.base);
  if (cmp > 0 || (cmp === 0 && !a.pre)) return null;
  if (a.base[0] !== b.base[0]) return 'major';
  if (a.base[1] !== b.base[1]) return 'minor';
  return 'patch';
}

// Every "## [X.Y.Z] - date" section, newest first as the file has them.
function parseSections(text) {
  const out = [];
  let cur = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^## \[(\d+\.\d+\.\d+)\]\s*(?:-\s*(.*))?$/.exec(line);
    if (m) {
      cur = { version: m[1], date: (m[2] || '').trim(), lines: [] };
      out.push(cur);
    } else if (cur) {
      if (/^---\s*$/.test(line)) continue;
      cur.lines.push(line);
    }
  }
  return out.map(s => ({ version: s.version, date: s.date, body: s.lines.join('\n').trim().slice(0, MAX_BODY) }));
}

// The sections someone who last saw `since` has not seen, up to `current`.
// Without `since`, just the current release's section. A beta's notes are
// its release's section, which fills in as the betas go out.
function sectionsSince(text, since, current) {
  const cur = parseVersion(current);
  if (!cur) return [];
  const all = parseSections(text).filter(s => compareBase(parseVersion(s.version).base, cur.base) <= 0);
  const from = parseVersion(since);
  if (!from) return all.slice(0, 1);
  return all.filter(s => {
    const cmp = compareBase(parseVersion(s.version).base, from.base);
    return cmp > 0 || (cmp === 0 && from.pre && since !== current);
  }).slice(0, MAX_SECTIONS);
}

let cache = null;
function readChangelog() {
  if (cache !== null) return cache;
  try {
    cache = fs.readFileSync(FILE, 'utf8').replace(/^﻿/, '');
  } catch (err) {
    console.warn('[changelog] CHANGELOG.md not readable, "What\'s new" stays empty:', err.message);
    cache = '';
  }
  return cache;
}

module.exports = { parseVersion, updateLevel, parseSections, sectionsSince, readChangelog };
