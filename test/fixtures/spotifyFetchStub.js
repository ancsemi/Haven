'use strict';

// Loaded into the test server with --require: answers Spotify's embed page
// and YouTube's search with fixed data, so the Spotify playlist test runs
// without the network. Any other Spotify or YouTube address gets a 404.

const realFetch = global.fetch;

const TRACKS = [
  { title: 'Song 1', subtitle: 'Band A', entityType: 'track' },
  { title: 'A Podcast', subtitle: 'Show', entityType: 'episode' },
  { title: 'Song 2', subtitle: 'Band B, Guest', entityType: 'track' },
  { title: 'Nowhere Song', subtitle: 'Nobody', entityType: 'track' },
  { title: 'Song 3', subtitle: 'Band C', entityType: 'track' },
];

function embedPage() {
  const data = { props: { pageProps: { state: { data: { entity: { name: 'Mix', trackList: TRACKS } } } } } };
  return `<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script></body></html>`;
}

function searchResult(query) {
  const m = /Song (\d)/.exec(query);
  if (!m || /Nowhere/.test(query)) return { contents: {} };
  const video = { videoRenderer: { videoId: 'songvideo0' + m[1], title: { runs: [{ text: query }] }, lengthText: { simpleText: '3:00' } } };
  return { contents: { twoColumnSearchResultsRenderer: { primaryContents: { sectionListRenderer: {
    contents: [{ itemSectionRenderer: { contents: [video] } }],
  } } } } };
}

global.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u === 'https://open.spotify.com/embed/playlist/MIX1') return new Response(embedPage(), { status: 200 });
  if (u.startsWith('https://www.youtube.com/youtubei/v1/search')) {
    const body = JSON.parse(opts.body || '{}');
    return new Response(JSON.stringify(searchResult(body.query || '')), { status: 200 });
  }
  if (/^https:\/\/([a-z]+\.)?(spotify|youtube|noembed)\.com\//.test(u)) return new Response('', { status: 404 });
  return realFetch(url, opts);
};
