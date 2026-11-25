'use strict';

// Notification previews: a message is plain text in a notification, so a
// markdown table arrived as "| a | b |" over "|---|---|". The server's push
// body and the web client's desktop notifications flatten it the way the
// Android and iOS apps flatten their local notifications. The vectors below
// are the same ones the apps' shared code is tested against
// (HavenShared fixtures/notify_preview.json in the mobile repo), so all
// platforms show the same text.

const assert = require('node:assert/strict');
const test = require('node:test');

const { preview, parts, SPOILER_MASK } = require('../public/js/notify-preview.js');
const { pushBody } = require('../src/pushBody.js');

const VECTORS = [
  {
    "name": "plain text",
    "in": "hello there",
    "out": "hello there"
  },
  {
    "name": "table header and rows",
    "in": "| a | b |\n|---|---|\n| 1 | 2 |",
    "out": "a · b\n1 · 2"
  },
  {
    "name": "text around a table",
    "in": "Scores:\n| a | b |\n|---|---|\n| 1 | 2 |\nThat's all",
    "out": "Scores:\na · b\n1 · 2\nThat's all"
  },
  {
    "name": "first rows then the rest counted",
    "in": "| n | v |\n|---|---|\n| 1 | a |\n| 2 | b |\n| 3 | c |\n| 4 | d |\n| 5 | e |",
    "out": "n · v\n1 · a\n2 · b\n3 · c\n+2 more rows"
  },
  {
    "name": "markdown inside cells",
    "in": "| **Name** | `Link` |\n|:--|--:|\n| *Ann* | [site](https://x.y) |",
    "out": "Name · Link\nAnn · site"
  },
  {
    "name": "bold italic strike highlight underline code",
    "in": "**bold** *it* ~~gone~~ ==mark== __under__ `x = 1`",
    "out": "bold it gone mark under x = 1"
  },
  {
    "name": "spoilers stay hidden",
    "in": "the killer is ||the butler||",
    "out": "the killer is ▒▒▒▒▒"
  },
  {
    "name": "spoiler after a table",
    "in": "| who | why |\n|---|---|\n| Bob | money |\n\nreally ||Bob||",
    "out": "who · why\nBob · money\nreally ▒▒▒▒▒"
  },
  {
    "name": "code fence keeps the code, drops the fence",
    "in": "look:\n```js\nconst a = 1;\n**not bold**\n```\ndone",
    "out": "look:\nconst a = 1;\n**not bold**\ndone"
  },
  {
    "name": "no table inside a code fence",
    "in": "```\n| a | b |\n|---|---|\n```",
    "out": "| a | b |\n|---|---|"
  },
  {
    "name": "one line fence",
    "in": "run ```npm test``` now",
    "out": "run npm test now"
  },
  {
    "name": "headings quotes subtext",
    "in": "# Title\n> quoted **line**\n-# small print",
    "out": "Title\nquoted line\nsmall print"
  },
  {
    "name": "links images emotes colors",
    "in": "see [docs](https://a.b/c) ![cat](https://a.b/cat.png) <a:wave:123456789012345678> c#ff0000red#c",
    "out": "see docs cat :wave: red"
  },
  {
    "name": "blank lines dropped",
    "in": "one\n\n\ntwo\r\nthree",
    "out": "one\ntwo\nthree"
  },
  {
    "name": "pipes that are not a table",
    "in": "a | b and - c",
    "out": "a | b and - c"
  },
  {
    "name": "channel mention is not a heading",
    "in": "#general is open",
    "out": "#general is open"
  }
];

for (const v of VECTORS) {
  test(`preview: ${v.name}`, () => {
    assert.equal(preview(v.in), v.out);
  });
}

test('the "+N more rows" label and row count can be set', () => {
  const tbl = '| a |\n|---|\n| 1 |\n| 2 |\n| 3 |';
  assert.equal(preview(tbl, { rows: 1, more: n => `+${n} weitere` }), 'a\n1\n+2 weitere');
  assert.equal(preview(tbl), 'a\n1\n2\n3');
});

test('a preview is stable when run on its own output', () => {
  const once = preview('**hi** | a | b |\n| a | b |\n|---|---|\n| 1 | 2 |\n\n||x|| *y*');
  assert.equal(preview(once), once);
});

test('a spoiler mask does not give away the length', () => {
  assert.equal(preview('||a||'), preview('||a much longer secret||'));
  assert.equal(preview('||a||'), SPOILER_MASK);
});

test('tables are split out as parts, never inside a code fence', () => {
  assert.equal(parts('x\n| a | b |\n|---|---|\n| 1 | 2 |').filter(p => p.table).length, 1);
  assert.equal(parts('```\n| a | b |\n|---|---|\n```').filter(p => p.table).length, 0);
});

test('push body: a table is flattened instead of sent as pipes', () => {
  assert.equal(pushBody('| a | b |\n|---|---|\n| 1 | 2 |'), 'a · b\n1 · 2');
});

test('push body: E2E ciphertext never leaks', () => {
  assert.equal(pushBody(JSON.stringify({ v: 1, iv: 'x', ct: 'secret' })), 'Sent a message');
});

test('push body: capped at 120 characters after flattening', () => {
  const body = pushBody('**' + 'x'.repeat(200) + '**');
  assert.equal(body.length, 120);
  assert.ok(body.endsWith('...'));
  assert.ok(!body.includes('*'));
});

test('push body: a message that flattens to nothing still says something', () => {
  assert.equal(pushBody('```\n```'), 'Sent a message');
  assert.equal(pushBody('Incoming call'), 'Incoming call');
});
