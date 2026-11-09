'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const Database = require('better-sqlite3');
const webpush = require('web-push');
const fcm = require('../src/fcm');
const b = s => Buffer.from(s, 'base64url');
const hkdf = (salt, ikm, info, len) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, len));
function openPush(sealed, uaPrivate, uaPublic, auth) {
  const salt = sealed.subarray(0, 16);
  const idLen = sealed[20];
  assert.equal(idLen, 65);
  const asPublic = sealed.subarray(21, 86);
  const body = sealed.subarray(86);
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(uaPrivate);
  const ikm = hkdf(auth, ecdh.computeSecret(asPublic), Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(body.subarray(body.length - 16));
  const out = Buffer.concat([d.update(body.subarray(0, body.length - 16)), d.final()]);
  let end = out.length;
  while (end > 0 && out[end - 1] === 0) end--;
  assert.equal(out[end - 1], 2);
  return out.subarray(0, end - 1);
}
function device(token) {
  const ecdh = crypto.createECDH('prime256v1');
  const pub = ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return { token, p256dh: pub.toString('base64url'), auth: auth.toString('base64url'), priv: ecdh.getPrivateKey(), pub, authRaw: auth };
}
async function relayCalls(run) {
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url, init) => {
    calls.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({ success: calls.at(-1).tokens.length, failure: 0, failedTokens: [`dead-${calls.length}`] }) };
  };
  try {
    const result = await run();
    return { calls, result };
  } finally {
    global.fetch = original;
  }
}
test('the open routine matches the RFC 8291 section 5 example', () => {
  const sealed = b('DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
  const plain = openPush(sealed, b('q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94'), b('BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4'), b('BTBZMqHH6r4Tts7J_aSIgg'));
  assert.equal(plain.toString(), 'When I grow up, I want to be a watermelon');
});
test('a device with a key gets a sealed push and nothing readable reaches the relay', async () => {
  fcm.setFcmHideContent(false);
  process.env.FCM_RELAY_URL = 'https://relay.invalid/sendPush';
  process.env.FCM_PUSH_KEY = 'test';
  fcm.initFcm('/nonexistent-haven-data');
  const a = device('phone-a');
  const c = device('phone-c');
  const { calls, result } = await relayCalls(() => fcm.sendFcm([a, 'old-phone', c], 'sam in #secret-room', 'the launch code is 1234', { channelCode: 'JOINCODE', tag: 'haven-JOINCODE' }));
  assert.equal(calls.length, 2);
  const keyless = calls.find(x => x.tokens.includes('old-phone'));
  assert.equal(keyless.body, 'the launch code is 1234');
  assert.equal(keyless.sealed, undefined);
  const sealedCall = calls.find(x => x.sealed);
  assert.deepEqual(sealedCall.tokens, ['phone-a', 'phone-c']);
  assert.equal(sealedCall.title, 'Haven');
  assert.equal(sealedCall.body, 'New message');
  assert.deepEqual(sealedCall.data, {});
  for (const needle of ['launch', 'secret-room', 'JOINCODE', 'sam']) assert.ok(!JSON.stringify({ ...sealedCall, tokens: [], sealed: {} }).includes(needle), needle);
  const plainA = openPush(b(sealedCall.sealed['phone-a']), a.priv, a.pub, a.authRaw);
  assert.equal(plainA.length % 512, 0);
  assert.deepEqual(JSON.parse(plainA), { title: 'sam in #secret-room', body: 'the launch code is 1234', channelCode: 'JOINCODE', tag: 'haven-JOINCODE' });
  assert.notEqual(sealedCall.sealed['phone-a'], sealedCall.sealed['phone-c']);
  assert.equal(result.success, 3);
  assert.deepEqual(result.failedTokens.sort(), ['dead-1', 'dead-2']);
});
test('a key that will not seal still sends only the placeholder', async () => {
  const bad = { token: 'bad', p256dh: 'AAAA', auth: 'AAAA' };
  const { calls } = await relayCalls(() => fcm.sendFcm([bad], 'sam in #room', 'private', { channelCode: 'JOIN' }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body, 'New message');
  assert.deepEqual(calls[0].sealed, {});
  assert.ok(!JSON.stringify(calls[0]).includes('private'));
});
test('the hide setting strips the text and channel from keyless devices', async () => {
  fcm.setFcmHideContent(true);
  const { calls } = await relayCalls(() => fcm.sendFcm(['old-phone'], 'sam in #room', 'private', { channelCode: 'JOIN', tag: 'haven-JOIN' }));
  fcm.setFcmHideContent(false);
  assert.deepEqual(calls[0], { tokens: ['old-phone'], title: 'Haven', body: 'New message', data: {} });
});
test('messages long enough to matter still fit in a push', () => {
  const key = device('x');
  const sealed = webpush.encrypt(key.p256dh, key.auth, Buffer.alloc(2048, 0x20), 'aes128gcm').cipherText.toString('base64url');
  assert.ok(sealed.length <= 3072);
});
test('push keys are validated and follow what the app last reported', t => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE fcm_tokens (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, token TEXT NOT NULL, scope TEXT NOT NULL DEFAULT 'all', push_p256dh TEXT, push_auth TEXT, UNIQUE(user_id, token));`);
  const key = device('x');
  const good = { p256dh: key.p256dh, auth: key.auth };
  const row = () => db.prepare('SELECT push_p256dh, push_auth FROM fcm_tokens WHERE token = ?').get('phone');
  fcm.saveFcmToken(db, 5, 'phone', 'all', good);
  assert.deepEqual(row(), { push_p256dh: key.p256dh, push_auth: key.auth });
  fcm.saveFcmToken(db, 5, 'phone', 'all');
  assert.deepEqual(row(), { push_p256dh: null, push_auth: null }, 'an app without a key must not be sent blobs it cannot open');
  for (const junk of [{ p256dh: 'AAAA', auth: key.auth }, { p256dh: key.p256dh, auth: 'AAAA' }, { p256dh: Buffer.alloc(65, 4).toString('base64url'), auth: key.auth }, { p256dh: 'x'.repeat(5000), auth: key.auth }, 'nope', { p256dh: 5, auth: 7 }]) {
    fcm.saveFcmToken(db, 5, 'phone', 'all', junk);
    assert.deepEqual(row(), { push_p256dh: null, push_auth: null });
  }
});
