'use strict';

/**
 * Send later takes files like a live send: the upload lines do not count
 * against the typed limit, a channel with uploads off refuses them, and the
 * message goes out with its files.
 *
 *   node --test test/scheduledFiles.integration.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createHarness, wait } = require('./socketServerHarness');

const h = createHarness(3510, 'scheduled-files');
test.before(() => h.start());
test.after(() => h.stop());

test('a scheduled message carries files, within the channel rules', async (t) => {
  const admin = await h.register('admin');
  const bob = await h.register('bob');
  const A = await h.connect(admin.token);
  const B = await h.connect(bob.token);
  const db = new Database(path.join(h.dataDir, 'haven.db'));
  db.pragma('busy_timeout = 5000');
  t.after(() => db.close());

  const made = h.next(A, 'channels-list', (chs) => Array.isArray(chs) && chs.some((c) => c.name === 'later'));
  A.emit('create-channel', { name: 'later' });
  const code = (await made).find((c) => c.name === 'later').code;
  B.emit('join-channel', { code });
  await wait(300);

  db.prepare("INSERT OR REPLACE INTO server_settings (key, value) VALUES ('max_message_chars', '20')").run();
  const sendAt = () => new Date(Date.now() + 3600000).toISOString();
  const files = '[file:notes.txt](/uploads/notes.txt|1.2 KB)\n/uploads/cat.png';

  const ok = await h.ask(B, 'schedule-message', { code, content: 'twenty chars of text\n' + files, sendAt: sendAt() });
  assert.ok(ok && ok.success, 'text at the limit plus files is queued: ' + JSON.stringify(ok));
  const onlyFiles = await h.ask(B, 'schedule-message', { code, content: files, sendAt: sendAt() });
  assert.ok(onlyFiles && onlyFiles.success, 'files alone are queued');
  const tooLong = await h.ask(B, 'schedule-message', { code, content: 'this text is well past twenty', sendAt: sendAt() });
  assert.ok(tooLong && tooLong.error, 'typed text over the limit is still refused');

  db.prepare('UPDATE channels SET media_enabled = 0 WHERE code = ?').run(code);
  const noMedia = await h.ask(B, 'schedule-message', { code, content: 'look\n' + files, sendAt: sendAt() });
  assert.ok(noMedia && /Media uploads are disabled/.test(noMedia.error), 'uploads off refuses files');
  const edit = await h.ask(B, 'update-scheduled-message', { id: ok.id, content: 'still\n' + files, sendAt: sendAt() });
  assert.ok(edit && /Media uploads are disabled/.test(edit.error), 'and an edit cannot add them');
  db.prepare('UPDATE channels SET media_enabled = 1 WHERE code = ?').run(code);

  A.emit('enter-channel', { code });
  await wait(200);
  const out = h.next(A, 'new-message', (d) => d && d.message && /notes\.txt/.test(d.message.content), 20000);
  db.prepare('UPDATE scheduled_messages SET send_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), ok.id);
  const sent = await out;
  assert.ok(sent, 'the scheduled message went out');
  assert.ok(sent.message.content.includes('/uploads/cat.png'), 'with its files');

  A.disconnect(); B.disconnect();
});
