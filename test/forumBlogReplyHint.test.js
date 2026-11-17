'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const load = async (name) => (await import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'modules', name)).href)).default;
let app;
const els = {};
const msgEl = { dataset: { username: 'guest', rawContent: 'nice shots' }, querySelector: () => null };
test.before(async () => {
  globalThis.t = (key) => key;
  globalThis.document = { getElementById: (id) => els[id] || null };
  app = { ...(await load('app-forum-blog.js')), ...(await load('app-threads.js')), _escapeHtml: (s) => s, _getNickname: () => null };
});
test.beforeEach(() => {
  els['thread-input'] = { placeholder: '', focus() {} };
  els['thread-reply-bar'] = { style: {} };
  els['thread-reply-preview-text'] = {};
  app.user = { id: 1 };
  app._threadReplyingTo = null;
  app._forumBlogThread = { parentId: 10, authorId: 1, authorName: 'bob', picsOnly: false, openPiece: null };
});
const hint = () => els['thread-input'].placeholder;
test('the author\'s box says it adds to the post until a reply is armed', () => {
  app._forumBlogComposerHint();
  assert.equal(hint(), 'forum.blog_add_to_post');
});
test('arming a reply to a comment turns the author\'s hint into a comment hint', () => {
  app._forumBlogComposerHint();
  app._setThreadReply(msgEl, 11);
  assert.equal(hint(), 'forum.blog_write_comment');
});
test('clearing the reply puts the add-to-post hint back', () => {
  app._setThreadReply(msgEl, 11);
  app._clearThreadReply();
  assert.equal(hint(), 'forum.blog_add_to_post');
});
test('someone who is not the author always sees the comment hint', () => {
  app.user = { id: 2 };
  app._forumBlogComposerHint();
  assert.equal(hint(), 'forum.blog_write_comment');
  app._setThreadReply(msgEl, 11);
  app._clearThreadReply();
  assert.equal(hint(), 'forum.blog_write_comment');
});
test('a thread outside blog mode keeps whatever placeholder it has', () => {
  app._forumBlogThread = null;
  els['thread-input'].placeholder = 'Reply in thread...';
  app._setThreadReply(msgEl, 11);
  app._clearThreadReply();
  assert.equal(hint(), 'Reply in thread...');
});
