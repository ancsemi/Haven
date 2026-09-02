'use strict';

// Desktop used to HTML-escape message content before turning image URLs into
// <img src>, so Ferry's Discord CDN query strings (?ex=&is=&hm=) became
// &amp; and the media proxy requested a URL Discord has never signed. Mobile
// never escapes the URL, which is why the same photo showed there and not on
// desktop. These tests lock the decode + filename regexes the client now uses.

const assert = require('node:assert/strict');
const test = require('node:test');
const { sniffImageType } = require('../src/mediaProxy');

function decodeHtmlEntities(str) {
  return str
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

const IMAGE_RE = /\.(jpg|jpeg|png|gif|webp)(\?[^"'<>]*)?$/i;
const LOCAL_UPLOAD_RE = /^\/uploads\/(?:[\w\-]+\/)?[\w\-.]+\.(jpg|jpeg|png|gif|webp|svg)$/i;
const OLD_LOCAL_RE = /^\/uploads\/[\w\-]+\.(jpg|jpeg|png|gif|webp|svg)$/i;

test('HTML-escaped Discord CDN query strings decode back to a fetchable URL', () => {
  const raw = 'https://cdn.discordapp.com/attachments/1178/8830/photo.png?ex=68b0&is=68af&hm=abcd&';
  const escaped = raw.replace(/&/g, '&amp;');
  assert.notEqual(escaped, raw);
  assert.equal(decodeHtmlEntities(escaped), raw);
  assert.match(decodeHtmlEntities(escaped), IMAGE_RE);
  // encodeURIComponent of the escaped form is what used to 404 upstream.
  assert.match(encodeURIComponent(escaped), /amp%3B/);
  assert.doesNotMatch(encodeURIComponent(raw), /amp%3B/);
});

test('local upload regex allows dots in the basename and one extra path segment', () => {
  assert.match('/uploads/1725-aabbccdd.jpg', LOCAL_UPLOAD_RE);
  assert.match('/uploads/photo.edit.jpg', LOCAL_UPLOAD_RE);
  assert.match('/uploads/images/cat.webp', LOCAL_UPLOAD_RE);
  assert.match('/uploads/stickers/wave.png', LOCAL_UPLOAD_RE);
  assert.doesNotMatch('/uploads/photo.edit.jpg', OLD_LOCAL_RE);
});

test('sniffImageType recognises raster magic bytes when the CDN lies about Content-Type', () => {
  assert.equal(sniffImageType(Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0, 0, 0, 0, 0, 0, 0, 0])), 'image/jpeg');
  assert.equal(sniffImageType(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0, 0, 0, 0, 0, 0, 0, 0])), 'image/png');
  assert.equal(sniffImageType(Buffer.from('GIF89a......')), 'image/gif');
  assert.equal(sniffImageType(Buffer.from('RIFF....WEBP')), 'image/webp');
  assert.equal(sniffImageType(Buffer.from('not an image!!')), null);
});
