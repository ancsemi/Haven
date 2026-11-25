'use strict';
/**
 * An admin, or a moderator holding ban_user, sees a member's live devices and
 * signs the member out everywhere. The same rank rules as banning apply, the
 * address of a device never leaves the server in that view, and the sign-out
 * is on the audit log.
 *
 *   node --test test/memberSessions.integration.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const { io } = require('socket.io-client');
const { createHarness, wait } = require('./socketServerHarness');
const PORT = 3732;
const h = createHarness(PORT, 'member-sessions');
const open = [];
const device = (token, ua) => new Promise((res, rej) => {
  const s = io(`http://localhost:${PORT}`, { auth: { token }, transports: ['websocket'], forceNew: true, reconnection: false, extraHeaders: { 'user-agent': ua } });
  open.push(s);
  s.on('connect', () => res(s));
  s.on('connect_error', rej);
});
const login = (username) => h.post('/api/auth/login', { username, password: 'access12345', eulaVersion: '2.0', ageVerified: true });
test.before(() => h.start());
test.after(async () => { open.forEach((s) => s.close()); await h.stop(); });
test('sessions are listed without addresses, signed out together and logged', async () => {
  const admin = await h.register('admin');
  const mod = await h.register('mod');
  const peer = await h.register('peer');
  const bob = await h.register('bob');
  const A = await h.connect(admin.token);
  const M = await h.connect(mod.token);
  const P = await h.connect(peer.token);
  const B = await h.connect(bob.token);
  await h.ask(A, 'create-role', { name: 'Warden', level: 50, permissions: ['ban_user'] });
  const roles = await h.ask(A, 'get-roles');
  const warden = (Array.isArray(roles) ? roles : roles.roles || []).find((r) => r.name === 'Warden');
  assert.ok(warden, 'role made');
  for (const u of [mod, peer]) assert.ok((await h.ask(A, 'assign-role', { userId: u.id, roleId: warden.id })).success);
  await wait(300);
  const phone = await device(bob.token, 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36');
  const laptop = await device(bob.token, 'Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0');
  await wait(200);
  const asAdmin = await h.ask(A, 'get-member-sessions', { userId: bob.id });
  assert.ok(Array.isArray(asAdmin.sessions), JSON.stringify(asAdmin));
  assert.strictEqual(asAdmin.sessions.length, 3, 'the web socket and both devices');
  assert.ok(asAdmin.sessions.some((s) => /Chrome/.test(s.device) && /Android/.test(s.device)));
  assert.ok(asAdmin.sessions.some((s) => /Firefox/.test(s.device)));
  for (const s of asAdmin.sessions) {
    assert.deepStrictEqual(Object.keys(s).sort(), ['current', 'device', 'id', 'since']);
    assert.strictEqual(s.current, false);
    assert.ok(Number.isFinite(s.since));
  }
  assert.ok(!JSON.stringify(asAdmin).match(/127\.0\.0\.1|::1|::ffff|"ip"/), 'no address in what an admin sees');
  assert.ok((await h.ask(M, 'get-member-sessions', { userId: bob.id })).sessions, 'ban_user is enough');
  for (const [who, sock] of [['a member', B], ['an equal rank', P]]) {
    const r = await h.ask(sock, 'get-member-sessions', { userId: mod.id });
    assert.ok(r.error && !r.sessions, `${who}: ${JSON.stringify(r)}`);
  }
  assert.ok((await h.ask(M, 'get-member-sessions', { userId: admin.id })).error, 'not an admin');
  assert.ok((await h.ask(M, 'get-member-sessions', { userId: peer.id })).error, 'not an equal rank');
  assert.ok((await h.ask(M, 'get-member-sessions', { userId: mod.id })).error, 'not yourself');
  assert.ok((await h.ask(A, 'get-member-sessions', { userId: admin.id })).error, 'not yourself');
  for (const bad of [null, 'bob', {}, { userId: '2' }, { userId: 99999 }, { userId: -1 }]) assert.ok((await h.ask(A, 'get-member-sessions', bad)).error, JSON.stringify(bad));
  for (const sock of [B, P]) assert.ok((await h.ask(sock, 'revoke-member-sessions', { userId: mod.id })).error, 'a member and an equal rank cannot sign them out');
  assert.ok((await h.ask(M, 'revoke-member-sessions', { userId: peer.id })).error);
  assert.ok((await h.ask(M, 'revoke-member-sessions', { userId: admin.id })).error);
  assert.ok(B.connected && phone.connected && laptop.connected, 'nothing happened to bob so far');
  const gone = [B, phone, laptop].map((s) => new Promise((r) => { s.once('disconnect', r); }));
  const forced = h.next(phone, 'force-logout', () => true);
  const done = await h.ask(M, 'revoke-member-sessions', { userId: bob.id });
  assert.deepStrictEqual(done, { ok: true, closed: 3 });
  assert.strictEqual((await forced).reason, 'sessions_revoked');
  await Promise.all(gone);
  assert.ok(!B.connected && !phone.connected && !laptop.connected, 'every socket of bob is closed');
  await assert.rejects(() => h.connect(bob.token), 'the token they held no longer works');
  const again = await login('bob');
  assert.ok(again.token && again.token !== bob.token, 'they can log in again');
  const C = await h.connect(again.token);
  assert.ok(C.connected);
  const row = (await h.ask(A, 'get-audit-log', { action: 'user_sessions_revoke' })).rows[0];
  assert.ok(row, 'logged');
  assert.strictEqual(row.actor_username, 'mod');
  assert.strictEqual(row.target_name, 'bob');
  assert.strictEqual(row.target_id, bob.id);
  assert.deepStrictEqual(JSON.parse(row.details), { sessions: 3 });
  assert.strictEqual((await h.ask(A, 'get-audit-log', { action: 'user_sessions_revoke' })).rows.length, 1, 'only the sign-out is logged, not the look');
});
