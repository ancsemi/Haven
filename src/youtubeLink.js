'use strict';

// The video id of a YouTube link (watch, youtu.be, shorts, live, embed, music),
// or null. Matches the client's _extractYouTubeVideoId.
function youTubeVideoId(url) {
  let u;
  try { u = new URL(url); } catch { return null; } // not a valid address, so not a YouTube link
  const host = u.hostname.replace(/^(www|m)\./, '');
  if (host === 'youtu.be') {
    const id = u.pathname.slice(1).split('/')[0];
    return /^[\w-]{11}$/.test(id) ? id : null;
  }
  if (host !== 'youtube.com' && host !== 'music.youtube.com' && host !== 'gaming.youtube.com') return null;
  const v = u.searchParams.get('v');
  if (v && /^[\w-]{11}$/.test(v)) return v;
  const m = u.pathname.match(/^\/(?:embed|shorts|live|v)\/([\w-]{11})/);
  return m ? m[1] : null;
}

module.exports = { youTubeVideoId };
