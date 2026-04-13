// ── YouTube / Spotify resolution (no io/db dependency) ──

// ── Spotify → YouTube resolution ──────────────────────────
// Spotify embeds only give 30-second previews to non-premium users
// and have no external JS API for sync/volume. We resolve the track
// title via Spotify oEmbed, then find it on YouTube for full playback.
async function resolveSpotifyToYouTube(spotifyUrl) {
  try {
    // 1. Get track title from Spotify oEmbed (no auth needed)
    const oembedRes = await fetch(
      `https://open.spotify.com/oembed?url=${encodeURIComponent(spotifyUrl)}`
    );
    if (!oembedRes.ok) return null;
    const oembed = await oembedRes.json();
    const title = oembed.title; // e.g. "Thank You - Dido"
    if (!title) return null;

    // 2. Search YouTube — try refined query first, then broader
    const queries = [
      title + ' official audio',
      title + ' audio',
      title
    ];
    for (const q of queries) {
      const results = await searchYouTube(q, 1);
      if (results.length > 0) {
        return {
          url: `https://www.youtube.com/watch?v=${results[0].videoId}`,
          title,
          duration: results[0].duration || ''
        };
      }
    }
    return null;
  } catch {
    return null;
  }
}

// ── YouTube search helper ─────────────────────────────────
// Uses YouTube's InnerTube API (primary) with HTML scraping fallback.
// Returns array of { videoId, title, channel, duration, thumbnail }
const YT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function searchYouTube(query, count = 5, offset = 0) {
  // ── Method 1: InnerTube API (structured, reliable) ──────────
  try {
    const resp = await fetch('https://www.youtube.com/youtubei/v1/search?prettyPrint=false', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': YT_UA
      },
      body: JSON.stringify({
        query,
        context: {
          client: { clientName: 'WEB', clientVersion: '2.20241120.01.00', hl: 'en', gl: 'US' }
        },
        params: 'EgIQAQ%3D%3D'  // filter: videos only
      })
    });
    if (resp.ok) {
      const data = await resp.json();
      const contents = data?.contents?.twoColumnSearchResultsRenderer
        ?.primaryContents?.sectionListRenderer?.contents;
      if (contents) {
        const videos = [];
        for (const section of contents) {
          const items = section?.itemSectionRenderer?.contents;
          if (!items) continue;
          for (const item of items) {
            const vr = item.videoRenderer;
            if (!vr || !vr.videoId) continue;
            videos.push({
              videoId: vr.videoId,
              title: vr.title?.runs?.[0]?.text || 'Unknown',
              channel: vr.ownerText?.runs?.[0]?.text || '',
              duration: vr.lengthText?.simpleText || '',
              thumbnail: vr.thumbnail?.thumbnails?.[0]?.url || ''
            });
          }
        }
        if (videos.length > 0) return videos.slice(offset, offset + count);
      }
    }
  } catch { /* InnerTube failed, fall through to HTML scraping */ }

  // ── Method 2: HTML scraping (legacy fallback) ───────────────
  try {
    const res = await fetch(
      `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`,
      { headers: { 'User-Agent': YT_UA } }
    );
    const html = await res.text();

    // Extract ytInitialData JSON which contains structured search results
    const dataMatch = html.match(/var\s+ytInitialData\s*=\s*({.+?});\s*<\/script>/s);
    if (dataMatch) {
      try {
        const ytData = JSON.parse(dataMatch[1]);
        const contents = ytData?.contents?.twoColumnSearchResultsRenderer
          ?.primaryContents?.sectionListRenderer?.contents;
        if (contents) {
          const videos = [];
          for (const section of contents) {
            const items = section?.itemSectionRenderer?.contents;
            if (!items) continue;
            for (const item of items) {
              const vr = item.videoRenderer;
              if (!vr || !vr.videoId) continue;
              videos.push({
                videoId: vr.videoId,
                title: vr.title?.runs?.[0]?.text || 'Unknown',
                channel: vr.ownerText?.runs?.[0]?.text || '',
                duration: vr.lengthText?.simpleText || '',
                thumbnail: vr.thumbnail?.thumbnails?.[0]?.url || ''
              });
            }
          }
          if (videos.length > 0) return videos.slice(offset, offset + count);
        }
      } catch { /* JSON parse failed, fall through to regex */ }
    }

    // Fallback: regex extraction (less info, just videoId)
    const matches = [...html.matchAll(/"videoId":"([a-zA-Z0-9_-]{11})"/g)];
    const seen = new Set();
    const results = [];
    for (const m of matches) {
      if (!seen.has(m[1])) {
        seen.add(m[1]);
        results.push({ videoId: m[1], title: '', channel: '', duration: '', thumbnail: '' });
      }
    }
    return results.slice(offset, offset + count);
  } catch {
    return [];
  }
}

function getYouTubeClientContext() {
  return {
    client: { clientName: 'WEB', clientVersion: '2.20241120.01.00', hl: 'en', gl: 'US' }
  };
}

function parseYouTubePlaylistPage(data) {
  const listRenderer = data?.contents?.twoColumnBrowseResultsRenderer?.tabs?.[0]
    ?.tabRenderer?.content?.sectionListRenderer?.contents?.[0]
    ?.itemSectionRenderer?.contents?.[0]?.playlistVideoListRenderer;
  const items = Array.isArray(listRenderer?.contents) ? listRenderer.contents : [];
  const continuation = listRenderer?.continuations?.[0]?.nextContinuationData?.continuation || null;
  return { items, continuation };
}

function getContinuationItemsFromAppendAction(data) {
  const appendAction = data?.onResponseReceivedActions?.find(action => action?.appendContinuationItemsAction)
    ?.appendContinuationItemsAction;
  if (Array.isArray(appendAction?.continuationItems)) return appendAction.continuationItems;

  const appendEndpoint = data?.onResponseReceivedEndpoints?.find(endpoint => endpoint?.appendContinuationItemsAction)
    ?.appendContinuationItemsAction;
  if (Array.isArray(appendEndpoint?.continuationItems)) return appendEndpoint.continuationItems;

  return [];
}

function getContinuationTokenFromItems(items) {
  if (!Array.isArray(items)) return null;
  const continuationItem = items.find(item => item?.continuationItemRenderer);
  return continuationItem?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token || null;
}

function getContinuationItemsFromPlaylistContents(data) {
  return data?.continuationContents?.playlistVideoListContinuation?.contents || [];
}

function getContinuationTokenFromPlaylistContents(data) {
  return data?.continuationContents?.playlistVideoListContinuation?.continuations?.[0]
    ?.nextContinuationData?.continuation || null;
}

function parseYouTubePlaylistContinuation(data) {
  // InnerTube playlist continuations are not stable. Depending on client/experiment bucket, YouTube may return appended rows under response "actions", "endpoints",
  //or direct "continuationContents", so we check for all of them.
  const appendItems = getContinuationItemsFromAppendAction(data);
  if (appendItems.length > 0) {
    return {
      items: appendItems,
      continuation: getContinuationTokenFromItems(appendItems)
    };
  }

  const playlistItems = getContinuationItemsFromPlaylistContents(data);
  return {
    items: playlistItems,
    continuation: getContinuationTokenFromPlaylistContents(data)
  };
}

function appendYouTubePlaylistTracks(tracks, items, maxTracks) {
  if (!Array.isArray(items)) return;
  for (const item of items) {
    const v = item?.playlistVideoRenderer;
    if (!v?.videoId) continue;
    tracks.push({ videoId: v.videoId, title: v.title?.runs?.[0]?.text || '' });
    if (tracks.length >= maxTracks) break;
  }
}

// Pull a max of 200 tracks from a playlist provided by a user. Potentially should
// have maxTracks be a server configurable setting instead of hardcoded.
async function fetchYouTubePlaylist(playlistId, maxTracks = 200) {
  try {
    const resp = await fetch('https://www.youtube.com/youtubei/v1/browse?prettyPrint=false', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': YT_UA },
      body: JSON.stringify({
        browseId: 'VL' + playlistId,
        context: getYouTubeClientContext()
      })
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    const tracks = [];
    const firstPage = parseYouTubePlaylistPage(data);
    appendYouTubePlaylistTracks(tracks, firstPage.items, maxTracks);
    let continuation = firstPage.continuation;

    while (continuation && tracks.length < maxTracks) {
      const pageResp = await fetch('https://www.youtube.com/youtubei/v1/browse?prettyPrint=false', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': YT_UA },
        body: JSON.stringify({
          continuation,
          context: getYouTubeClientContext()
        })
      });
      if (!pageResp.ok) break;
      const pageData = await pageResp.json();
      const nextPage = parseYouTubePlaylistContinuation(pageData);
      appendYouTubePlaylistTracks(tracks, nextPage.items, maxTracks);
      if (!nextPage.continuation || nextPage.continuation === continuation) break;
      continuation = nextPage.continuation;
    }
    return tracks;
  } catch { return []; }
}

function extractYouTubeVideoId(url) {
  if (typeof url !== 'string') return null;
  const match = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/|music\.youtube\.com\/watch\?v=)([a-zA-Z0-9_-]{11})/);
  return match ? match[1] : null;
}

//Grab metadata for queue and up next system
async function resolveMusicMetadata(url) {
  if (!url || typeof url !== 'string') return { title: '', duration: '' };
  try {
    const ytId = extractYouTubeVideoId(url);
    if (ytId) {
      const res = await fetch(
        `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${ytId}`)}&format=json`,
        { signal: AbortSignal.timeout(5000) }
      );
      if (res.ok) {
        const data = await res.json();
        return { title: data.title || '', duration: '' };
      }
    }
    if (url.includes('soundcloud.com/') || url.includes('spotify.com/')) {
      const res = await fetch(
        `https://noembed.com/embed?url=${encodeURIComponent(url)}`,
        { signal: AbortSignal.timeout(5000) }
      );
      if (res.ok) {
        const data = await res.json();
        return { title: data.title || '', duration: '' };
      }
    }
  } catch {}
  return { title: '', duration: '' };
}

module.exports = {
  resolveSpotifyToYouTube, searchYouTube, fetchYouTubePlaylist,
  extractYouTubeVideoId, resolveMusicMetadata
};
