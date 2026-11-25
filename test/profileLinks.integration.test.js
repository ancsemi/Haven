'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Database = require('better-sqlite3');
const { io } = require('socket.io-client');
const { createHarness } = require('./socketServerHarness');
const { cleanProfileLinks, profileLinksFromRow } = require('../src/socketHandlers/helpers');
const PORT = 3757;
const h = createHarness(PORT, 'profile-links');
test.before(() => h.start());
test.after(() => h.stop());
const link = (label, url) => ({ label, url });
const good = [link('Code', 'https://github.com/someone'), link('Video', 'https://www.youtube.com/@someone')];
async function member(name) {
  const acct = await h.register(name);
  const db = new Database(path.join(h.dataDir, 'haven.db'));
  try {
    db.prepare("UPDATE users SET created_at = '2020-01-01 00:00:00' WHERE id = ?").run(acct.id);
  } finally {
    db.close();
  }
  return acct;
}
async function card(sock, userId) {
  const got = h.next(sock, 'user-profile', (p) => p.id === userId);
  sock.emit('get-user-profile', { userId });
  return got;
}
async function setLinks(sock, data) {
  const saved = h.next(sock, 'profile-links-updated');
  const refused = h.next(sock, 'error-msg');
  sock.emit('set-profile-links', data);
  return Promise.race([saved.then((d) => d && { saved: d.links }), refused.then((e) => e && { error: e })]);
}
async function sessionInfo(token) {
  const s = io(`http://localhost:${PORT}`, { auth: { token }, transports: ['websocket'], forceNew: true });
  const info = await new Promise((res) => {
    const timer = setTimeout(() => res(null), 5000);
    s.once('session-info', (d) => { clearTimeout(timer); res(d); });
  });
  s.disconnect();
  return info;
}
test('links are saved, shown on the card and in the session, kept in order, and can be cleared', async () => {
  const me = await member('linker');
  const other = await member('looker');
  const sock = await h.connect(me.token);
  const viewer = await h.connect(other.token);
  assert.deepStrictEqual((await card(viewer, me.id)).profileLinks, [], 'none to start');
  assert.deepStrictEqual((await sessionInfo(me.token)).profileLinks, []);
  assert.deepStrictEqual(await setLinks(sock, { links: good }), { saved: good });
  assert.deepStrictEqual((await card(viewer, me.id)).profileLinks, good);
  assert.deepStrictEqual((await card(sock, me.id)).profileLinks, good);
  assert.deepStrictEqual((await card(viewer, other.id)).profileLinks, [], 'only their own');
  assert.deepStrictEqual((await sessionInfo(me.token)).profileLinks, good);
  assert.deepStrictEqual(await setLinks(sock, { links: [good[1], good[0]] }), { saved: [good[1], good[0]] });
  assert.deepStrictEqual((await card(viewer, me.id)).profileLinks, [good[1], good[0]]);
  assert.deepStrictEqual(await setLinks(sock, { links: [] }), { saved: [] });
  assert.deepStrictEqual((await card(viewer, me.id)).profileLinks, []);
});
test('labels are trimmed, addresses are stored in their normal form, and five of the longest are accepted', async () => {
  const me = await member('tidy');
  const sock = await h.connect(me.token);
  assert.deepStrictEqual(await setLinks(sock, { links: [link('  Mine  ', '  HTTPS://GitHub.COM:443/Some%20One?q=1#top ')] }),
    { saved: [link('Mine', 'https://github.com/Some%20One?q=1#top')] });
  const url = 'https://github.com/' + 'a'.repeat(281);
  assert.strictEqual(url.length, 300);
  const links = Array.from({ length: 5 }, (_, i) => link(String(i).repeat(32), url));
  assert.deepStrictEqual(await setLinks(sock, { links }), { saved: links });
  assert.deepStrictEqual((await sessionInfo(me.token)).profileLinks, links);
  assert.ok((await setLinks(sock, { links: links.concat([link('Six', url)]) })).error, 'a sixth is refused');
  assert.deepStrictEqual((await card(sock, me.id)).profileLinks, links, 'and nothing changed');
});
test('anything but up to five labeled https links is refused and changes nothing', async () => {
  const me = await member('mischief');
  const sock = await h.connect(me.token);
  await setLinks(sock, { links: good });
  const ok = 'https://github.com/someone';
  const attempts = [
    {}, { links: null }, { links: ok }, { links: {} }, { links: [null] }, { links: [ok] },
    { links: Array.from({ length: 6 }, () => link('B', ok)) },
    { links: [link('', ok)] }, { links: [link('   ', ok)] }, { links: [link('x'.repeat(33), ok)] },
    { links: [link('Site', ok + 'a'.repeat(300))] },
    { links: [link('Site', 'http://github.com/someone')] }, { links: [link('Site', 'javascript:alert(1)')] },
    { links: [link('Site', 'data:text/html,<script>alert(1)</script>')] }, { links: [link('Site', 'ftp://github.com/')] },
    { links: [link('Site', 'file:///etc/passwd')] }, { links: [link('Site', '//github.com/')] }, { links: [link('Site', 'github.com')] },
    { links: [link('Site', 'https:github.com')] }, { links: [link('Site', 'https:///')] }, { links: [link('Site', 'https://')] },
    { links: [link('Site', 'https://user@github.com/')] }, { links: [link('Site', 'https://user:pass@github.com/')] },
    { links: [link('Site', 'https://github.com@evil.example/')] }, { links: [link('Site', 'https://github.com\n/')] },
    { links: [link('Site', 'https://git\u0000hub.com/')] }, { links: [link('Site', 'https://github.com/\u007f')] },
    { links: [link('Site', 'https://github.com/ x')] }, { links: [link('Site', 'https://github.com/ x')] },
    { links: [link('Si\nte', ok)] }, { links: [link('Si\u0007te', ok)] }, { links: [link('Site‮', ok)] },
    { links: [link(5, ok)] }, { links: [link('Site', 5)] }, { links: [{ label: 'Site' }] }, { links: [{ url: ok }] },
    { links: good.concat([link('Bad', 'http://github.com/')]) },
  ];
  for (const bad of attempts) {
    const r = await setLinks(sock, bad);
    assert.ok(r && r.error, `refused: ${JSON.stringify(bad)}`);
  }
  assert.deepStrictEqual((await card(sock, me.id)).profileLinks, good);
});
test('bad or oversized stored links are never handed out', async () => {
  const me = await member('stored');
  const sock = await h.connect(me.token);
  const db = new Database(path.join(h.dataDir, 'haven.db'));
  const ok = link('Ok', 'https://github.com/someone');
  const stored = [
    [JSON.stringify([ok, link('Bad', 'javascript:alert(1)'), link('Cred', 'https://u:p@github.com/'), link('Http', 'http://github.com/')]), [ok]],
    [JSON.stringify(Array(9).fill(ok)), Array(5).fill(ok)],
    ['not json', []], ['{"label":"x"}', []], ['"https://github.com/"', []], ['[null,1,"x",{"label":1,"url":2}]', []], [null, []], ['', []],
  ];
  try {
    for (const [i, [raw, want]] of stored.entries()) {
      db.prepare('UPDATE users SET profile_links = ? WHERE id = ?').run(raw, me.id);
      assert.deepStrictEqual((await card(sock, me.id)).profileLinks, want, `card for ${raw}`);
      if (i < 2) assert.deepStrictEqual((await sessionInfo(me.token)).profileLinks, want, `session for ${raw}`);
    }
  } finally {
    db.close();
  }
});
test('a new account follows the server link rule, like a bio does', async () => {
  const fresh = await h.register('fresh');
  const sock = await h.connect(fresh.token);
  assert.match((await setLinks(sock, { links: good })).error, /New accounts can't post links yet/);
  assert.deepStrictEqual((await card(sock, fresh.id)).profileLinks, []);
  assert.deepStrictEqual(await setLinks(sock, { links: [] }), { saved: [] }, 'clearing is always allowed');
});
test('the Auto-Mod domain rules apply to profile links', async () => {
  const me = await member('domains');
  const sock = await h.connect(me.token);
  const r = await setLinks(sock, { links: [link('Odd', 'https://not-on-the-list.example/')] });
  assert.match(r.error, /aren't allowed here/);
  assert.deepStrictEqual((await card(sock, me.id)).profileLinks, []);
});
test('the checks hold when called directly', () => {
  assert.strictEqual(cleanProfileLinks(Array(6).fill(link('A', 'https://example.com/'))), null);
  assert.deepStrictEqual(cleanProfileLinks([]), []);
  assert.deepStrictEqual(cleanProfileLinks([{ label: ' A ', url: 'https://example.com', extra: 'x' }]), [link('A', 'https://example.com/')]);
  assert.deepStrictEqual(cleanProfileLinks([link('Bücher', 'https://bücher.example/straße')]), [link('Bücher', 'https://xn--bcher-kva.example/stra%C3%9Fe')]);
  assert.deepStrictEqual(profileLinksFromRow(JSON.stringify([link('A', 'https://example.com/')])), [link('A', 'https://example.com/')]);
  assert.strictEqual(cleanProfileLinks([link('A', 'https://example.com/' + 'é'.repeat(100))]), null);
  assert.strictEqual(cleanProfileLinks([link('x'.repeat(32), 'https://example.com/')]).length, 1);
  assert.strictEqual(cleanProfileLinks([link('x'.repeat(33), 'https://example.com/')]), null);
});
