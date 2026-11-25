'use strict';

// The text of a push notification for a message. Notifications are plain
// text, so the message is flattened the way the apps flatten their own local
// notifications (public/js/notify-preview.js): a table reads "a · b" a row
// with "+N more rows" after the first three, markdown markers go and a
// spoiler stays hidden. An E2E envelope never leaks its ciphertext.
const { preview } = require('../public/js/notify-preview.js');

const MAX = 120;

function pushBody(messageContent) {
  let text = typeof messageContent === 'string' ? messageContent : '';
  try {
    const parsed = JSON.parse(text);
    if (parsed && parsed.v && parsed.ct) return 'Sent a message';
  } catch { /* not JSON, use as-is */ }
  text = preview(text) || 'Sent a message';
  return text.length > MAX ? text.slice(0, MAX - 3) + '...' : text;
}

module.exports = { pushBody };
