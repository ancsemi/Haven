#!/usr/bin/env node
/**
 * Builds public/emoji-keywords.json, the extra words the emoji pickers search
 * by ("finger", "hand", "index" for 👆). The words come from Unicode's CLDR
 * annotations, which ship with Unicode's emoji data and are free to use.
 * Haven's own chat words (👆 "this", 💀 "dead") live in
 * public/js/modules/emoji-slang.js and are added in the browser.
 *
 * Run it after a Unicode release, with the two English annotation files:
 *   https://github.com/unicode-org/cldr-json  cldr-json/cldr-annotations-full/annotations/en/annotations.json
 *   https://github.com/unicode-org/cldr-json  cldr-json/cldr-annotations-derived-full/annotationsDerived/en/annotations.json
 *
 *   node scripts/build-emoji-keywords.js annotations.json derived.json
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { parseEmojiTest } = require('../src/emoji');

const [annotationsFile, derivedFile] = process.argv.slice(2);
if (!annotationsFile || !derivedFile) {
  console.error('usage: node scripts/build-emoji-keywords.js <annotations.json> <annotationsDerived.json>');
  process.exit(1);
}

const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const entries = {
  ...read(annotationsFile).annotations.annotations,
  ...read(derivedFile).annotationsDerived.annotations,
};
const strip = (glyph) => glyph.replace(/️/g, '');
const cldr = new Map(Object.entries(entries).map(([glyph, a]) => [strip(glyph), a]));

const data = parseEmojiTest(fs.readFileSync(path.join(__dirname, '..', 'src', 'emoji-test.txt'), 'utf8'));
const out = {};
for (const glyph of Object.values(data.categories).flat()) {
  const a = cldr.get(strip(glyph));
  if (!a) continue;
  // The Unicode name is already searchable, so only the words it lacks are kept.
  const named = new Set(String(data.names[glyph] || '').split(/[\s:,]+/));
  const words = [];
  for (const phrase of a.default || []) {
    const word = phrase.toLowerCase().replace(/’/g, '\'').trim();
    if (word && !named.has(word) && !words.includes(word)) words.push(word);
  }
  if (words.length) out[strip(glyph)] = words.join(' ');
}

const file = path.join(__dirname, '..', 'public', 'emoji-keywords.json');
fs.writeFileSync(file, JSON.stringify(out) + '\n');
console.log(`Wrote ${Object.keys(out).length} emoji to ${path.relative(process.cwd(), file)}`);
