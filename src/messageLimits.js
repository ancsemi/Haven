'use strict';

const mediaGroup = require('./mediaGroup');

// The length limit is on what people type. An encrypted DM reaches the
// server as ciphertext: AES-GCM output in base64 inside a small JSON wrapper,
// up to about four times the typed length (a character can take three bytes
// as UTF-8 and base64 adds a third). A DM near the limit was refused after
// the message box had already cleared (#5691), so ciphertext gets that room.
function encryptedDmCap(maxChars) {
  return maxChars * 4 + 256;
}
function looksEncrypted(content) {
  if (typeof content !== 'string' || content.charCodeAt(0) !== 123) return false;
  try {
    const o = JSON.parse(content);
    return !!(o && (o.v === 1 || o.v === 2 || (o.v === 3 && Number.isInteger(o.e) && typeof o.sig === 'string')) && typeof o.iv === 'string' && typeof o.ct === 'string');
  } catch { return false; }
}
function isGroupEnvelope(content) {
  return looksEncrypted(content) && JSON.parse(content).v === 3;
}
// The longest a message can be before its channel is known: ciphertext room
// for a DM, or text at the limit with a full set of upload lines.
function sizeCeiling(maxChars) {
  return Math.max(encryptedDmCap(maxChars), mediaGroup.ceiling(maxChars));
}
// Why a message cannot go out for its size, or null. An encrypted DM gets
// ciphertext room; anything else is held to the typed limit, with room for
// the upload lines of pictures sent together, and to the number of files one
// message carries (src/mediaGroup.js, #5799).
function sizeRefusal(content, channel, { maxChars, maxAttachments, forumTopic = false }) {
  if (channel && channel.is_dm && looksEncrypted(content)) {
    return content.length > encryptedDmCap(maxChars) ? `Message too long (max ${maxChars} characters)` : null;
  }
  return mediaGroup.refusal(content, { maxChars, maxAttachments, forumTopic });
}

module.exports = { sizeCeiling, sizeRefusal, looksEncrypted, isGroupEnvelope };
