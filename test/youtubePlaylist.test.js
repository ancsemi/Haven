'use strict';

/**
 * Listen Together reads a YouTube playlist from YouTube's browse reply (#5840).
 * In October 2026 YouTube started sending each video as a lockupViewModel, and
 * the next page's token on a continuationItemViewModel, so playlists came back
 * empty. Both the old and the new shape must read.
 *
 *   node --test test/youtubePlaylist.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { fetchYouTubePlaylist } = require('../src/socketHandlers/musicResolver');

const section = (contents) => ({
  contents: { twoColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: { content: {
    sectionListRenderer: { contents: [{ itemSectionRenderer: { contents } }] },
  } } }] } },
});
const lockup = (id, title) => ({ lockupViewModel: {
  contentId: id, contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
  metadata: { lockupMetadataViewModel: { title: { content: title } } },
} });
const nextPage = (token) => ({ continuationItemViewModel: {
  continuationCommand: { innertubeCommand: { continuationCommand: { token } } },
} });

function withReplies(replies, fn) {
  const real = global.fetch;
  const asked = [];
  global.fetch = async (url, opts) => {
    asked.push(JSON.parse(opts.body));
    const body = replies.shift();
    return { ok: !!body, json: async () => body };
  };
  return fn().finally(() => { global.fetch = real; }).then((r) => ({ r, asked }));
}

test('the new layout reads, across pages', async () => {
  const { r, asked } = await withReplies([
    section([lockup('aaaaaaaaaaa', 'One'), { lockupViewModel: { contentType: 'LOCKUP_CONTENT_TYPE_PLAYLIST', contentId: 'PLx' } }, nextPage('tok2')]),
    { onResponseReceivedActions: [{ appendContinuationItemsAction: { continuationItems: [lockup('bbbbbbbbbbb', 'Two')] } }] },
  ], () => fetchYouTubePlaylist('PLtest'));
  assert.deepEqual(r, [{ videoId: 'aaaaaaaaaaa', title: 'One' }, { videoId: 'bbbbbbbbbbb', title: 'Two' }]);
  assert.equal(asked[1].continuation, 'tok2', 'the second page is asked for with the new token');
});

test('the old layout still reads', async () => {
  const { r } = await withReplies([
    section([{ playlistVideoListRenderer: { contents: [
      { playlistVideoRenderer: { videoId: 'ccccccccccc', title: { runs: [{ text: 'Three' }] } } },
    ] } }]),
  ], () => fetchYouTubePlaylist('PLtest'));
  assert.deepEqual(r, [{ videoId: 'ccccccccccc', title: 'Three' }]);
});
