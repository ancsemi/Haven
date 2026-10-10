// Link previews (Open Graph and oEmbed) and the media proxy, which fetches
// remote images for clients so their own addresses never reach other sites.

const { verifyToken } = require('../auth');
const { youTubeVideoId } = require('../youtubeLink');

module.exports = function registerLinkPreview(deps) {
  const { app } = deps;
  // ── Link preview (Open Graph metadata) ──────────────────
  const linkPreviewCache = new Map(); // url → { data, ts }
  const PREVIEW_CACHE_TTL = 30 * 60 * 1000; // 30 min
  let _previewGateErrorLogged = false;
  const PREVIEW_MAX_SIZE = 256 * 1024; // only read first 256 KB of page

  // Decode common HTML entities in OG-scraped attribute values.
  // Without this, image URLs containing '&amp;' get double-encoded on the client.
  function decodeHtmlEntities(str) {
    if (!str) return str;
    return str
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
      .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/&quot;/gi, '"')
      .replace(/&apos;/gi, "'")
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&amp;/gi, '&');
  }
  const { resolveCallbackDestination } = require('../webhookCallback');
  const { safeGet } = require('../safeFetch');

  // Rate limit link preview fetches (per IP, separate from upload limiter).
  // Returns true when the request is within the window, false if the caller
  // should serve a 429.  The route handler invokes this AFTER the cache
  // lookup, so cache hits never consume a rate-limit token — fixes a bug
  // where reopening a chat with many links 429'd legitimate fresh requests
  // because each cached preview burned a slot.  (#5337)
  const previewLimitStore = new Map();
  function previewLimiterCheck(req) {
    const ip = req.ip || req.socket.remoteAddress;
    const now = Date.now();
    const windowMs = 60 * 1000;
    const maxReqs = 60; // 60 previews/min/user (was 30; bumped per #5337)
    if (!previewLimitStore.has(ip)) previewLimitStore.set(ip, []);
    const stamps = previewLimitStore.get(ip).filter(t => now - t < windowMs);
    previewLimitStore.set(ip, stamps);
    if (stamps.length >= maxReqs) return false;
    stamps.push(now);
    return true;
  }
  setInterval(() => { const now = Date.now(); for (const [ip, t] of previewLimitStore) { const f = t.filter(x => now - x < 60000); if (!f.length) previewLimitStore.delete(ip); else previewLimitStore.set(ip, f); } }, 5 * 60 * 1000);

  // Validate a URL a member asked Haven to fetch: http(s) only, and every
  // address the host resolves to (IPv4 and IPv6, any spelling of loopback)
  // outside the private, loopback, link-local and metadata ranges. This is an
  // early refusal only; the fetches themselves go through safeGet, which repeats
  // the check on every redirect and connects to exactly the address it checked.
  // Set ALLOW_PRIVATE_PREVIEWS=true in .env to allow link previews for local/private
  // services (link-local and cloud metadata addresses stay blocked either way).
  const allowPrivatePreviews = (process.env.ALLOW_PRIVATE_PREVIEWS || '').toLowerCase() === 'true';
  async function validateUrlSafe(urlStr) {
    const parsed = new URL(urlStr);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('Only http/https URLs allowed');
    }
    try {
      await resolveCallbackDestination(urlStr, { allowPrivateCallbacks: allowPrivatePreviews });
    } catch (err) {
      if (err && err.code === 'ERR_UNSAFE_CALLBACK_URL') throw new Error('Private addresses not allowed');
      throw err;
    }
    return parsed;
  }

  // ── Media proxy (v3.43.0) ─────────────────────────────────
  // Clients never fetch remote media directly any more; they ask Haven, Haven
  // fetches once and caches on disk. Closes the passive IP leak completely
  // rather than only for non-allowlisted domains, and keeps embeds working
  // after the origin expires.
  const mediaProxy = require('../mediaProxy');
  mediaProxy.loadIndex();

  function mediaProxyEnabled() {
    try {
      const { getDb } = require('../database');
      const row = getDb().prepare("SELECT value FROM server_settings WHERE key = 'media_proxy_enabled'").get();
      return !row || row.value !== 'false';
    } catch { return true; }
  }
  app.set('mediaProxyEnabled', mediaProxyEnabled);

  // Hands the client its short-lived media token. Authenticated normally; the
  // token it returns is what <img> tags carry, since they cannot send headers.
  app.get('/api/media-token', (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    const user = token ? verifyToken(token) : null;
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    if (!mediaProxyEnabled()) return res.json({ enabled: false, token: null });
    res.json({ enabled: true, token: mediaProxy.issueToken(user.id) });
  });

  // Per-user rate limit. Generous, because opening a busy channel legitimately
  // requests many images at once; the cache means repeats are nearly free.
  const _mediaRate = new Map();   // userId -> { count, resetAt }
  function _mediaRateOk(userId) {
    const now = Date.now();
    let e = _mediaRate.get(userId);
    if (!e || now > e.resetAt) { e = { count: 0, resetAt: now + 60000 }; _mediaRate.set(userId, e); }
    e.count++;
    return e.count <= 600;
  }
  setInterval(() => {
    const now = Date.now();
    for (const [uid, e] of _mediaRate) if (now > e.resetAt + 120000) _mediaRate.delete(uid);
  }, 5 * 60 * 1000).unref?.();

  app.get('/api/media-proxy', async (req, res) => {
    if (!mediaProxyEnabled()) return res.status(404).json({ error: 'Media proxy disabled' });

    const userId = mediaProxy.verifyToken((req.query.mt || '').trim());
    if (!userId) return res.status(401).json({ error: 'Invalid or expired media token' });
    if (!_mediaRateOk(userId)) return res.status(429).json({ error: 'Rate limited' });

    const url = (req.query.url || '').trim();
    if (!url || url.length > 2048) return res.status(400).json({ error: 'Missing or oversized url' });

    // Serve straight from disk when we already hold it — no upstream request,
    // so a link that has since expired or gone offline still renders.
    const send = (item) => {
      res.set('Content-Type', item.type);
      res.set('Content-Length', String(item.size));
      // Immutable: the cache key is a hash of the source URL, so a given proxy
      // URL always resolves to the same bytes.
      res.set('Cache-Control', 'public, max-age=604800, immutable');
      res.set('X-Content-Type-Options', 'nosniff');
      res.set('Cross-Origin-Resource-Policy', 'same-origin');
      return res.sendFile(item.path);
    };

    const cached = mediaProxy.get(url);
    if (cached) return send(cached);

    try {
      const item = await mediaProxy.fetchAndCache(url, { allowPrivate: allowPrivatePreviews });
      return send(item);
    } catch (err) {
      // A transparent 1x1 would silently hide broken images; a status code lets
      // the client fall back to its own placeholder.
      return res.status(502).json({ error: String(err.message || 'fetch failed').slice(0, 120) });
    }
  });

  app.get('/api/link-preview', async (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    const user = token ? verifyToken(token) : null;
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const url = (req.query.url || '').trim();
    if (!url) return res.status(400).json({ error: 'Missing url param' });

    // Cache check FIRST — cache hits should never consume a rate-limit slot.
    // Reopening a chat full of links was hitting 429 because the limiter ran
    // before the cache lookup. (#5337)
    const cached = linkPreviewCache.get(url);
    if (cached && Date.now() - cached.ts < PREVIEW_CACHE_TTL) {
      return res.json(cached.data);
    }

    // Cache miss — now apply the per-IP rate limit.
    if (!previewLimiterCheck(req)) {
      // Tell the client roughly when a slot frees so it can pace its retries
      // instead of hammering (or, worse, silently dropping the embed). The
      // client-side scheduler honours this header. (#5337 follow-up)
      res.set('Retry-After', '3');
      return res.status(429).json({ error: 'Rate limited, try again shortly' });
    }

    // Validate the initial URL is safe (protocol, hostname, DNS)
    let parsed;
    try {
      parsed = await validateUrlSafe(url);
    } catch (err) {
      return res.status(400).json({ error: err.message || 'Invalid URL' });
    }

    // ── Auto-mod domain gate (v3.42.0) ──────────────────────
    // This is the control that closes the passive IP leak, and it matters more
    // than the click-through case. Haven renders og:image and bare image URLs
    // straight from the third-party host in every viewer's browser, so a hostile
    // link hands the attacker the IP and User-Agent of everyone who merely
    // scrolls past the message. Refusing to unfurl a non-allowlisted host means
    // no client is ever told to fetch from it.
    try {
      const automod = require('../automod');
      if (!automod.previewAllowed(url)) {
        return res.status(403).json({ error: 'Link previews are not enabled for that domain' });
      }
    } catch (err) {
      // Fail closed: unfurling a host the admin has not allowed is the IP leak
      // this gate exists to stop. Logged once so a broken gate cannot flood the log.
      if (!_previewGateErrorLogged) {
        _previewGateErrorLogged = true;
        console.error('[link-preview] Domain allowlist check failed, refusing previews:', err.message);
      }
      return res.status(403).json({ error: 'Link previews are not enabled for that domain' });
    }

    // Use a real browser UA — many sites (Twitter/X, Instagram, etc.) serve
    // JS-only pages to unknown bots, omitting the OG meta tags we need.
    const PREVIEW_UA = 'Mozilla/5.0 (compatible; HavenBot/2.1; +https://github.com/ancsemi/Haven)';

    try {
      let data = null;

      // ── Site-specific handlers ───────────────────────────
      // Native twitter.com / x.com — their HTML requires JS rendering so the generic
      // scraper gets blank OG tags. The fxtwitter public JSON API returns structured
      // post data (author, avatar, text, media, engagement counts) with no auth, so
      // the client can render a rich social card matching the mobile app's embeds.
      // NOTE: fxtwitter / vxtwitter / fixupx proxy URLs are NOT matched here; they
      // serve their own OG-enriched HTML and fall through to the generic scraper.
      const twitterMatch = url.match(/^https?:\/\/(?:(?:www\.|mobile\.)?(?:twitter|x)\.com)\/([A-Za-z0-9_]{1,20})\/status(?:es)?\/(\d+)/i);
      if (twitterMatch) {
        try {
          const fxApi = await fetch(
            `https://api.fxtwitter.com/${twitterMatch[1]}/status/${twitterMatch[2]}`,
            { signal: AbortSignal.timeout(6000), headers: { 'User-Agent': PREVIEW_UA } }
          );
          if (fxApi.ok) {
            const tw = (await fxApi.json())?.tweet;
            if (tw) {
              const a = tw.author || {};
              const photos = (tw.media?.photos || []).map(p => p.url).filter(Boolean);
              const vid = tw.media?.videos?.[0] || null;
              const text = tw.text || '';
              data = {
                kind: 'twitter',
                siteName: 'X / Twitter',
                accentColor: '#1d9bf0',
                author: a.name || null,
                handle: a.screen_name ? `@${a.screen_name}` : null,
                avatar: a.avatar_url || null,
                title: a.name ? `${a.name} on X` : 'X / Twitter',
                text: text || null,
                description: text.slice(0, 280) || null,
                image: vid?.thumbnail_url || photos[0] || null,
                images: photos.length >= 2 ? photos.slice(0, 4) : undefined,
                video: vid?.url || null,
                videoType: vid?.url ? 'video/mp4' : undefined,
                stats: { replies: tw.replies ?? -1, reposts: tw.retweets ?? -1, likes: tw.likes ?? -1, views: tw.views ?? -1 },
                url
              };
            }
          }
        } catch { /* fall through to fxtwitter OG scrape / generic */ }
      }

      // ── fxtwitter / vxtwitter / fixupx fallback for native Twitter/X links ──
      // If the oEmbed handler above didn't fire (non-matching URL) or failed,
      // and the URL is a native twitter.com/x.com link, try fxtwitter as an
      // OG-enriched proxy. fxtwitter serves bot-friendly HTML with OG tags.
      if (!data && /^https?:\/\/(?:(?:www\.|mobile\.)?(?:twitter|x)\.com)\/\w+\/status\/\d+/i.test(url)) {
        try {
          const fxUrl = url.replace(/^https?:\/\/(?:www\.|mobile\.)?(?:twitter|x)\.com/i, 'https://fxtwitter.com');
          const fxResp = await fetch(fxUrl, {
            signal: AbortSignal.timeout(6000),
            headers: { 'User-Agent': PREVIEW_UA, 'Accept': 'text/html' },
            redirect: 'manual'
          });
          if (fxResp.ok) {
            const fxHtml = (await fxResp.text()).slice(0, PREVIEW_MAX_SIZE);
            const fxMeta = (prop) => {
              const r1 = new RegExp(`<meta[^>]*?(?:property|name)=["']${prop}["'][^>]*?content=["']([^"']+)["']`, 'is');
              const r2 = new RegExp(`<meta[^>]*?content=["']([^"']+)["'][^>]*?(?:property|name)=["']${prop}["']`, 'is');
              const m = fxHtml.match(r1) || fxHtml.match(r2);
              return m ? decodeHtmlEntities(m[1].trim()) : null;
            };
            const fxTitle = fxMeta('og:title') || fxMeta('twitter:title');
            const fxDesc = fxMeta('og:description') || fxMeta('twitter:description');
            const fxImg = fxMeta('og:image') || fxMeta('twitter:image');
            if (fxTitle || fxDesc) {
              data = {
                title: fxTitle,
                description: fxDesc,
                image: fxImg,
                siteName: fxMeta('og:site_name') || 'X',
                url
              };
            }
          }
        } catch { /* fxtwitter fallback failed — continue to generic scrape */ }
      }

      // ── Reddit — serves no OG tags to unknown bots; use JSON API instead ──
      if (!data && /^https?:\/\/(?:(?:www|old|new)\.)?reddit\.com\/r\/[\w]+\/comments\/[\w]+/i.test(url)) {
        try {
          // Reddit's .json endpoint works with any User-Agent
          const jsonUrl = url.replace(/\/?(?:\?.*)?$/, '/.json');
          const rResp = await fetch(jsonUrl, {
            signal: AbortSignal.timeout(6000),
            headers: { 'User-Agent': PREVIEW_UA }
          });
          if (rResp.ok) {
            const rJson = await rResp.json();
            const post = rJson?.[0]?.data?.children?.[0]?.data;
            if (post) {
              const redTitle = `${post.subreddit_name_prefixed || 'Reddit'}: ${post.title || ''}`;
              let redImage = null;
              let redImages;

              if (post.is_gallery && post.media_metadata) {
                // Gallery post — collect up to 4 preview images
                const imgs = Object.values(post.media_metadata)
                  .filter(m => m.status === 'valid' && m.s?.u)
                  .map(m => decodeHtmlEntities(m.s.u))
                  .slice(0, 4);
                if (imgs.length >= 2) redImages = imgs;
                redImage = imgs[0] || null;
              } else if (post.preview?.images?.[0]?.source?.url) {
                redImage = decodeHtmlEntities(post.preview.images[0].source.url);
              } else if (post.thumbnail && post.thumbnail !== 'self' && post.thumbnail !== 'default' && post.thumbnail !== 'nsfw' && post.thumbnail !== 'spoiler') {
                redImage = post.thumbnail;
              }

              data = {
                title: redTitle,
                description: post.selftext ? post.selftext.slice(0, 280) : null,
                image: redImage,
                images: redImages,
                siteName: 'Reddit',
                url
              };
            }
          }
        } catch { /* Reddit JSON fallback failed — continue to generic scrape */ }
      }

      // ── YouTube: the watch page is over a megabyte and its OG tags sit far
      // past the part the generic scrape reads, so a video came back with no
      // title and no picture. YouTube's oEmbed endpoint answers with both
      // (#5745). The thumbnail reaches viewers through the media proxy. ──
      const ytId = !data ? youTubeVideoId(url) : null;
      if (ytId) {
        try {
          const watch = `https://www.youtube.com/watch?v=${ytId}`;
          const yResp = await fetch(
            `https://www.youtube.com/oembed?url=${encodeURIComponent(watch)}&format=json`,
            { signal: AbortSignal.timeout(6000), headers: { 'User-Agent': PREVIEW_UA, 'Accept': 'application/json' } }
          );
          if (yResp.ok) {
            const oj = await yResp.json();
            data = {
              title: oj.title || null,
              description: oj.author_name || null,
              image: (typeof oj.thumbnail_url === 'string' && /^https:\/\//i.test(oj.thumbnail_url)) ? oj.thumbnail_url : `https://i.ytimg.com/vi/${ytId}/hqdefault.jpg`,
              siteName: 'YouTube',
              accentColor: '#ff0000',
              url
            };
          }
        } catch { /* oEmbed unreachable or not JSON: fall through to the generic scrape */ }
      }

      // ── Pixiv — blocks bots for HTML but provides an oEmbed API ────────
      if (!data && /^https?:\/\/(?:www\.)?pixiv\.net\/(?:en\/)?artworks\/\d+/i.test(url)) {
        try {
          const poEmbed = await fetch(
            `https://embed.pixiv.net/oembed.php?url=${encodeURIComponent(url)}&format=json`,
            { signal: AbortSignal.timeout(6000), headers: { 'User-Agent': PREVIEW_UA } }
          );
          if (poEmbed.ok) {
            const oj = await poEmbed.json();
            data = {
              title: oj.title || null,
              description: oj.author_name ? `by ${oj.author_name}` : null,
              image: oj.thumbnail_url || null,
              siteName: 'pixiv',
              url
            };
          }
        } catch { /* fall through to generic scrape */ }
      }

      // ── Bluesky — HTML is client-rendered (blank OG tags); the public AT Protocol
      // app view returns structured post data with no auth. Resolve the handle to a
      // DID when needed, then hydrate the post and pull author / text / media. ──
      if (!data && /^https?:\/\/bsky\.app\/profile\/[^/]+\/post\/[A-Za-z0-9]+/i.test(url)) {
        try {
          const m = url.match(/^https?:\/\/bsky\.app\/profile\/([^/?#]+)\/post\/([A-Za-z0-9]+)/i);
          let did = m[1];
          if (!did.startsWith('did:')) {
            const rh = await fetch(
              `https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(did)}`,
              { signal: AbortSignal.timeout(6000), headers: { 'User-Agent': PREVIEW_UA } }
            );
            if (rh.ok) did = (await rh.json()).did || did;
          }
          if (did.startsWith('did:')) {
            const atUri = `at://${did}/app.bsky.feed.post/${m[2]}`;
            const pResp = await fetch(
              `https://public.api.bsky.app/xrpc/app.bsky.feed.getPosts?uris=${encodeURIComponent(atUri)}`,
              { signal: AbortSignal.timeout(6000), headers: { 'User-Agent': PREVIEW_UA } }
            );
            if (pResp.ok) {
              const post = (await pResp.json())?.posts?.[0];
              if (post) {
                const author = post.author || {};
                const name = author.displayName || author.handle || 'Bluesky';
                const embed = post.embed || {};
                // recordWithMedia nests the real media one level down under .media
                const media = (embed.$type || '').startsWith('app.bsky.embed.recordWithMedia') ? (embed.media || {}) : embed;
                const mType = media.$type || '';
                let image = null, images;
                if (mType.startsWith('app.bsky.embed.images')) {
                  const imgs = (media.images || []).map(i => i.fullsize).filter(Boolean);
                  if (imgs.length >= 2) images = imgs.slice(0, 4);
                  image = imgs[0] || null;
                } else if (mType.startsWith('app.bsky.embed.video')) {
                  image = media.thumbnail || null;
                } else if (mType.startsWith('app.bsky.embed.external')) {
                  image = media.external?.thumb || null;
                }
                const text = post.record?.text || '';
                data = {
                  kind: 'bsky',
                  siteName: 'Bluesky',
                  accentColor: '#0085ff',
                  author: name,
                  handle: author.handle ? `@${author.handle}` : null,
                  avatar: author.avatar || null,
                  title: `${name} on Bluesky`,
                  text: text || null,
                  description: text.slice(0, 280) || null,
                  image,
                  images,
                  video: mType.startsWith('app.bsky.embed.video') ? url : null,
                  stats: { replies: post.replyCount ?? -1, reposts: post.repostCount ?? -1, likes: post.likeCount ?? -1, views: -1 },
                  url
                };
              }
            }
          }
        } catch { /* Bluesky app view failed — continue to generic scrape */ }
      }

      // ── Generic OG scrape (manual redirect following with SSRF checks) ──
      if (!data) {
        // safeGet follows up to five redirects, checking every hop and
        // connecting to the address it checked, and stops reading at
        // PREVIEW_MAX_SIZE rather than buffering the whole page first.
        let resp;
        try {
          resp = await safeGet(url, {
            allowPrivate: allowPrivatePreviews,
            timeoutMs: 8000,
            maxBytes: PREVIEW_MAX_SIZE,
            truncate: true,
            maxRedirects: 5,
            headers: {
              'User-Agent': PREVIEW_UA,
              'Accept': 'text/html,application/xhtml+xml',
              'Accept-Language': 'en-US,en;q=0.9'
            }
          });
        } catch {
          // A hop pointed somewhere private, or the page never answered.
          return res.json({ title: null, description: null, image: null, siteName: null });
        }
        const currentUrl = resp.url;

        const contentType = String(resp.headers['content-type'] || '');
        if (resp.status < 200 || resp.status >= 300 ||
            (!contentType.includes('text/html') && !contentType.includes('application/xhtml'))) {
          linkPreviewCache.set(url, { data: { title: null, description: null, image: null, siteName: null }, ts: Date.now() });
          return res.json({ title: null, description: null, image: null, siteName: null });
        }

        const chunk = resp.body.toString('utf8');

        // Regex helper — handles attributes spanning multiple lines and both
        // orderings: property before content, and content before property.
        // Decodes HTML entities so image URLs with &amp; etc. work correctly.
        // Bounded quantifiers: a page full of unclosed tags would otherwise make
        // these backtrack across the whole chunk, seconds of CPU per request.
        const getMetaContent = (property) => {
          const re1 = new RegExp(`<meta[^>]{0,1000}?(?:property|name)=["']${property}["'][^>]{0,1000}?content=["']([^"']{1,4000})["']`, 'is');
          const re2 = new RegExp(`<meta[^>]{0,1000}?content=["']([^"']{1,4000})["'][^>]{0,1000}?(?:property|name)=["']${property}["']`, 'is');
          const m = chunk.match(re1) || chunk.match(re2);
          return m ? decodeHtmlEntities(m[1].trim()) : null;
        };

        // Returns ALL values for a given OG property (e.g. multiple og:image tags
        // for tweet galleries or reddit image galleries). Deduped, max 4 results.
        // Decodes HTML entities in each value.
        const getAllMetaContent = (property) => {
          const seen = new Set();
          const re1 = new RegExp(`<meta[^>]{0,1000}?(?:property|name)=["']${property}["'][^>]{0,1000}?content=["']([^"']{1,4000})["']`, 'gi');
          const re2 = new RegExp(`<meta[^>]{0,1000}?content=["']([^"']{1,4000})["'][^>]{0,1000}?(?:property|name)=["']${property}["']`, 'gi');
          let m;
          while ((m = re1.exec(chunk)) !== null) seen.add(decodeHtmlEntities(m[1].trim()));
          while ((m = re2.exec(chunk)) !== null) seen.add(decodeHtmlEntities(m[1].trim()));
          return [...seen].slice(0, 4);
        };

        const titleTag = chunk.match(/<title[^>]{0,200}>([^<]{1,1000})<\/title>/i);

        const ogImages = getAllMetaContent('og:image');

        // Extract og:video for inline video embeds (MP4, WebM)
        const ogVideo = getMetaContent('og:video') || getMetaContent('og:video:url') || getMetaContent('og:video:secure_url');
        const ogVideoType = getMetaContent('og:video:type') || '';
        // Only embed direct video files (not Flash, iframes, etc.)
        const isEmbeddableVideo = ogVideo && (
          /^video\/(mp4|webm|ogg)$/i.test(ogVideoType) ||
          /\.(mp4|webm|ogg)(\?[^#]*)?$/i.test(ogVideo)
        );

        data = {
          title: getMetaContent('og:title') || getMetaContent('twitter:title') || (titleTag ? titleTag[1].trim() : null),
          description: getMetaContent('og:description') || getMetaContent('twitter:description') || getMetaContent('description'),
          image: ogImages[0] || getMetaContent('twitter:image'),
          images: ogImages.length >= 2 ? ogImages : undefined,
          video: isEmbeddableVideo ? ogVideo : undefined,
          videoType: isEmbeddableVideo ? (ogVideoType || 'video/mp4') : undefined,
          siteName: getMetaContent('og:site_name') || parsed.hostname,
          url: getMetaContent('og:url') || url
        };

        // oEmbed autodiscovery — if OG tags came back empty and the page advertises a
        // JSON oEmbed endpoint, use it. This future-proofs support for any oEmbed-compatible
        // site without needing a dedicated handler.
        if (!data.title && !data.image) {
          const oembedHref =
            chunk.match(/<link[^>]{0,1000}?type=["']application\/json\+oembed["'][^>]{0,1000}?href=["']([^"']{1,2000})["']/i) ||
            chunk.match(/<link[^>]{0,1000}?href=["']([^"']{1,2000})["'][^>]{0,1000}?type=["']application\/json\+oembed["']/i);
          if (oembedHref) {
            try {
              const oembedEndpoint = new URL(decodeHtmlEntities(oembedHref[1]), currentUrl).href;
              const oResp = await safeGet(oembedEndpoint, {
                allowPrivate: allowPrivatePreviews,
                timeoutMs: 5000,
                maxBytes: 256 * 1024,
                maxRedirects: 3,
                headers: { 'User-Agent': PREVIEW_UA, 'Accept': 'application/json' }
              });
              if (oResp.status >= 200 && oResp.status < 300) {
                const oj = JSON.parse(oResp.body.toString('utf8'));
                data.title = data.title || oj.title || null;
                data.image = data.image || oj.thumbnail_url || null;
                if (!data.siteName || data.siteName === parsed.hostname) {
                  data.siteName = oj.provider_name || data.siteName;
                }
              }
            } catch { /* autodiscovery failed — keep OG data as-is */ }
          }
        }
      } else {
        // Twitter oEmbed succeeded — try a quick scrape for the image only.
        // First try fxtwitter (bot-friendly proxy), then fall back to the original URL.
        const imageSource = /^https?:\/\/(?:(?:www\.|mobile\.)?(?:twitter|x)\.com)\/\w+\/status\/\d+/i.test(url)
          ? url.replace(/^https?:\/\/(?:www\.|mobile\.)?(?:twitter|x)\.com/i, 'https://fxtwitter.com')
          : url;
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 5000);
          const resp = await fetch(imageSource, {
            signal: controller.signal,
            headers: { 'User-Agent': PREVIEW_UA, 'Accept': 'text/html' },
            redirect: 'manual'  // no blind redirect following
          });
          clearTimeout(timeout);
          // Only scrape if we got a direct 200 (no redirect chasing for image-only pass)
          if (resp.status === 200) {
            const html = (await resp.text()).slice(0, PREVIEW_MAX_SIZE);
            const imgMatch = html.match(/<meta[^>]*?(?:property|name)=["'](?:og:image|twitter:image)["'][^>]*?content=["']([^"']+)["']/is)
                          || html.match(/<meta[^>]*?content=["']([^"']+)["'][^>]*?(?:property|name)=["'](?:og:image|twitter:image)["']/is);
            if (imgMatch) data.image = decodeHtmlEntities(imgMatch[1].trim());
          }
        } catch { /* image is optional */ }
      }

      linkPreviewCache.set(url, { data, ts: Date.now() });

      // Prune old cache entries if over 500
      if (linkPreviewCache.size > 500) {
        const now = Date.now();
        for (const [k, v] of linkPreviewCache) {
          if (now - v.ts > PREVIEW_CACHE_TTL) linkPreviewCache.delete(k);
        }
      }

      res.json(data);
    } catch {
      res.json({ title: null, description: null, image: null, siteName: null });
    }
  });

};
