'use strict';

// A # in an unquoted .env value starts a comment, so `TURN_SECRET=ab#cd`
// is read as `ab`. Docker's env_file keeps the whole value, so the same file
// worked in Docker and not when Haven ran directly (#5824). Names the
// settings this happened to, never their values, which may be secrets.

const fs = require('fs');

// Keys whose unquoted value has a # after its first character.
function cutAtHash(text) {
  const keys = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const value = m[2];
    if (!value || /^["'`]/.test(value)) continue;
    // "KEY=value # a note" is a comment on purpose; a # inside the value is not.
    const hash = value.indexOf('#');
    if (hash > 0 && !/\s/.test(value[hash - 1])) keys.push(m[1]);
  }
  return keys;
}

function warnCutValues(envPath) {
  let text;
  try { text = fs.readFileSync(envPath, 'utf8'); } catch { return; /* no .env there: nothing to check */ }
  const keys = cutAtHash(text);
  if (keys.length) {
    console.warn(`⚠️  ${envPath}: ${keys.join(', ')} ${keys.length === 1 ? 'has' : 'have'} a # in the value, and everything from the # on is ignored. Put the value in quotes, like KEY="value#with#hash".`);
  }
}

module.exports = { cutAtHash, warnCutValues };
