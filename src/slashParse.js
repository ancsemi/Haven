'use strict';

// "/name the rest of the message" as a command and its text, or null. The text
// may run over several lines and hold slashes of its own (a link, "and/or");
// only the first word decides, so /usr/bin/foo is still just a message.
function parseSlash(text) {
  const m = String(text).match(/^\/([a-zA-Z]+)(?:\s+([\s\S]*))?$/);
  return m ? { cmd: m[1].toLowerCase(), arg: (m[2] || '').trim() } : null;
}

module.exports = { parseSlash };
