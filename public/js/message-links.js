/**
 * Haven: links to a channel or a message on this server
 *
 * Loaded by the auth page and the app (plain <script> tags) and by the tests
 * (require). Pure functions only.
 *
 * The forms a link can take:
 *   /app.html?channel=CODE&message=ID   web "Copy link" (also /app, /?…)
 *   /#CODE/ID  and  /#CODE              the Android and iOS apps' Copy link
 *
 * jumpPlan() decides what opening a message does once the server has said
 * where it lives (message-history `threadReply`). The Android and iOS apps
 * run the same rules (HavenShared HavenLinks.jump), so a link opens the same
 * way everywhere:
 *   - a channel message: scroll to it
 *   - a thread reply: scroll to the thread's parent, open the thread, and
 *     bring the reply into view
 *   - a forum topic: open the topic
 *   - a reply in a forum topic: open the topic at the reply
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HavenMessageLinks = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const HASH_CODE = /^[0-9a-f]{8}$/i;
  const PARAM_CODE = /^[A-Za-z0-9_-]{1,64}$/;
  const LEAVES = ['', 'app', 'app.html', 'index.html'];

  function id(s) {
    if (!/^[0-9]{1,12}$/.test(s || '')) return 0;
    const n = Number(s);
    return n >= 1 && n <= 2147483647 ? n : 0;
  }

  // "#CODE" or "#CODE/ID", as the apps copy them.
  function fromHash(hash) {
    const parts = String(hash || '').replace(/^#/, '').replace(/^\/+|\/+$/g, '').split('/');
    if (parts.length > 2 || !HASH_CODE.test(parts[0])) return null;
    if (parts.length === 2 && !id(parts[1])) return null;
    return { channel: parts[0].toLowerCase(), message: parts.length === 2 ? id(parts[1]) : 0 };
  }

  // "?channel=CODE&message=ID", as the web client copies them.
  function fromSearch(search) {
    const q = new URLSearchParams(search || '');
    const channel = (q.get('channel') || '').trim();
    if (!PARAM_CODE.test(channel)) return null;
    return { channel, message: id((q.get('message') || '').trim()) };
  }

  // A link to a channel or message on this server (same origin), or null.
  function parse(href, origin) {
    let u;
    try { u = new URL(href, origin); } catch { return null; }
    if (u.origin !== origin) return null;
    const leaf = u.pathname.replace(/\/+$/, '').split('/').pop().toLowerCase();
    if (!LEAVES.includes(leaf)) return null;
    return fromSearch(u.search) || fromHash(u.hash);
  }

  // What to do with a message once the server has placed it.
  // around: the message the history window is centred on; threadParent and
  // threadReply come from message-history's threadReply. Returns the message
  // to scroll the channel to, the thread (or forum topic) to open, and the
  // reply to bring into view inside it (0 = none).
  function jumpPlan({ forum = false, around = 0, threadParent = 0, threadReply = 0 } = {}) {
    if (threadParent > 0) return { scroll: forum ? 0 : threadParent, thread: threadParent, reply: threadReply !== threadParent ? threadReply : 0 };
    if (forum) return { scroll: 0, thread: around, reply: 0 };
    return { scroll: around, thread: 0, reply: 0 };
  }

  return { fromHash, fromSearch, parse, jumpPlan };
}));
