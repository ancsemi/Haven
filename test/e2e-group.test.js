/**
 * Group DM crypto — property tests.
 *
 * Run: node --test test/e2e-group.test.js
 *
 * These assert the claims in docs/group-dm-e2e-plan.md, and most of them are
 * written as attacks: a test that only shows the happy path would pass just as
 * well with the signature check deleted.
 */
const test = require('node:test');
const assert = require('node:assert');
const { webcrypto } = require('node:crypto');
const G = require('../public/js/e2e-group.js');

const subtle = webcrypto.subtle;

/* Stand-in for the pairwise ECDH secret two members already share. The real
   derivation lives in e2e.js; what matters here is that wrapping uses a key
   only those two hold. */
async function pairKey(a, b) {
  const bits = await subtle.deriveBits({ name: 'ECDH', public: b.publicKey }, a.privateKey, 256);
  const hkdf = await subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: Buffer.from('haven-e2e-dm-v1'), info: Buffer.from('aes-gcm-key') },
    hkdf, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  );
}

async function makeMember(id) {
  const ecdh = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const sign = await G.generateSigningKeyPair();
  return { id, ecdh, sign, signJwk: await G.exportPublicJwk(sign.publicKey), ecdhJwk: await G.exportPublicJwk(ecdh.publicKey) };
}

const CHANNEL = 42;

test('a member decrypts a message and the signature verifies', async () => {
  const [alice, bob] = [await makeMember(1), await makeMember(2)];
  const K = await G.generateEpochKey();
  const wrapped = await G.wrapEpochKey(K, await pairKey(alice.ecdh, bob.ecdh));
  const bobKey = await G.unwrapEpochKey(wrapped, await pairKey(bob.ecdh, alice.ecdh));

  const env = await G.encryptGroupMessage('the eagle lands at noon', {
    epochKey: K, epoch: 1, channelId: CHANNEL, senderId: alice.id, prev: null,
    signingPrivateKey: alice.sign.privateKey,
  });

  const r = await G.decryptGroupMessage(env, {
    epochKey: bobKey, channelId: CHANNEL, senderId: alice.id, signingPublicJwk: alice.signJwk,
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.plaintext, 'the eagle lands at noon');
});

test('the server cannot read the ciphertext', async () => {
  const alice = await makeMember(1);
  const K = await G.generateEpochKey();
  const env = await G.encryptGroupMessage('salary figures', {
    epochKey: K, epoch: 1, channelId: CHANNEL, senderId: alice.id, prev: null,
    signingPrivateKey: alice.sign.privateKey,
  });
  const stored = JSON.stringify(env);
  assert.ok(!stored.includes('salary'), 'plaintext must not appear in what the server stores');
});

/* ── forgery ──────────────────────────────────────── */

test('a member cannot forge a message as another member', async () => {
  // Mallory holds the epoch key — she is in the group — so she can encrypt
  // perfectly well. Without Alice's signing key she still cannot author as her.
  const [alice, mallory] = [await makeMember(1), await makeMember(3)];
  const K = await G.generateEpochKey();

  const forged = await G.encryptGroupMessage('transfer the money', {
    epochKey: K, epoch: 1, channelId: CHANNEL, senderId: alice.id, prev: null,
    signingPrivateKey: mallory.sign.privateKey,
  });

  const r = await G.decryptGroupMessage(forged, {
    epochKey: K, channelId: CHANNEL, senderId: alice.id, signingPublicJwk: alice.signJwk,
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'bad-signature');
  assert.strictEqual(r.plaintext, null, 'a rejected message must not surface plaintext');
});

test('re-attributing a genuine message to another sender fails', async () => {
  const [alice, bob] = [await makeMember(1), await makeMember(2)];
  const K = await G.generateEpochKey();
  const env = await G.encryptGroupMessage('I approve', {
    epochKey: K, epoch: 1, channelId: CHANNEL, senderId: alice.id, prev: null,
    signingPrivateKey: alice.sign.privateKey,
  });
  // The server relabels the row as Bob's and serves Bob's signing key with it.
  const r = await G.decryptGroupMessage(env, {
    epochKey: K, channelId: CHANNEL, senderId: bob.id, signingPublicJwk: bob.signJwk,
  });
  assert.strictEqual(r.ok, false);
});

test('a tampered ciphertext is rejected', async () => {
  const alice = await makeMember(1);
  const K = await G.generateEpochKey();
  const env = await G.encryptGroupMessage('original', {
    epochKey: K, epoch: 1, channelId: CHANNEL, senderId: alice.id, prev: null,
    signingPrivateKey: alice.sign.privateKey,
  });
  const bytes = G._unb64(env.ct);
  bytes[0] ^= 0xff;
  const r = await G.decryptGroupMessage({ ...env, ct: G._b64(bytes) }, {
    epochKey: K, channelId: CHANNEL, senderId: alice.id, signingPublicJwk: alice.signJwk,
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'bad-signature');
});

test('an unsigned message is rejected outright', async () => {
  const alice = await makeMember(1);
  const K = await G.generateEpochKey();
  const env = await G.encryptGroupMessage('hello', {
    epochKey: K, epoch: 1, channelId: CHANNEL, senderId: alice.id, prev: null,
    signingPrivateKey: alice.sign.privateKey,
  });
  delete env.sig;
  const r = await G.decryptGroupMessage(env, {
    epochKey: K, channelId: CHANNEL, senderId: alice.id, signingPublicJwk: alice.signJwk,
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'unsigned');
});

/* ── replay across contexts ───────────────────────── */

test('a message cannot be replayed into another channel', async () => {
  const alice = await makeMember(1);
  const K = await G.generateEpochKey();
  const env = await G.encryptGroupMessage('context matters', {
    epochKey: K, epoch: 1, channelId: CHANNEL, senderId: alice.id, prev: null,
    signingPrivateKey: alice.sign.privateKey,
  });
  const r = await G.decryptGroupMessage(env, {
    epochKey: K, channelId: 999, senderId: alice.id, signingPublicJwk: alice.signJwk,
  });
  assert.strictEqual(r.ok, false, 'signature binds the channel');
});

test('a message cannot be replayed into another epoch', async () => {
  const alice = await makeMember(1);
  const K = await G.generateEpochKey();
  const env = await G.encryptGroupMessage('epoch bound', {
    epochKey: K, epoch: 1, channelId: CHANNEL, senderId: alice.id, prev: null,
    signingPrivateKey: alice.sign.privateKey,
  });
  const r = await G.decryptGroupMessage({ ...env, e: 2 }, {
    epochKey: K, channelId: CHANNEL, senderId: alice.id, signingPublicJwk: alice.signJwk,
  });
  assert.strictEqual(r.ok, false, 'signature binds the epoch');
});

/* ── epoch isolation ──────────────────────────────── */

test('a member added at epoch 2 cannot read epoch 1', async () => {
  const alice = await makeMember(1);
  const K1 = await G.generateEpochKey();
  const K2 = await G.generateEpochKey();
  const old = await G.encryptGroupMessage('said before you joined', {
    epochKey: K1, epoch: 1, channelId: CHANNEL, senderId: alice.id, prev: null,
    signingPrivateKey: alice.sign.privateKey,
  });
  // The newcomer holds K2 only — K1 was never wrapped for them.
  const r = await G.decryptGroupMessage(old, {
    epochKey: K2, channelId: CHANNEL, senderId: alice.id, signingPublicJwk: alice.signJwk,
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'wrong-epoch-key', 'signature is valid; the key is not held');
});

test('a removed member cannot read the next epoch', async () => {
  const alice = await makeMember(1);
  const K1 = await G.generateEpochKey();
  const K2 = await G.generateEpochKey();
  const after = await G.encryptGroupMessage('said after you left', {
    epochKey: K2, epoch: 2, channelId: CHANNEL, senderId: alice.id, prev: null,
    signingPrivateKey: alice.sign.privateKey,
  });
  const r = await G.decryptGroupMessage(after, {
    epochKey: K1, channelId: CHANNEL, senderId: alice.id, signingPublicJwk: alice.signJwk,
  });
  assert.strictEqual(r.ok, false);
});

test('a non-member cannot unwrap an epoch key not wrapped for them', async () => {
  const [alice, bob, eve] = [await makeMember(1), await makeMember(2), await makeMember(4)];
  const K = await G.generateEpochKey();
  const forBob = await G.wrapEpochKey(K, await pairKey(alice.ecdh, bob.ecdh));
  await assert.rejects(() => G.unwrapEpochKey(forBob, pairKey(eve.ecdh, alice.ecdh).then((k) => k)));
});

/* ── scrollback: the regression a ratchet would cause ── */

test('history still decrypts after several epoch rotations', async () => {
  const alice = await makeMember(1);
  const keys = [await G.generateEpochKey(), await G.generateEpochKey(), await G.generateEpochKey()];
  const sent = [];
  for (let e = 0; e < 3; e++) {
    sent.push(await G.encryptGroupMessage(`message in epoch ${e + 1}`, {
      epochKey: keys[e], epoch: e + 1, channelId: CHANNEL, senderId: alice.id, prev: null,
      signingPrivateKey: alice.sign.privateKey,
    }));
  }
  // A long-standing member retains every epoch key they were given, so
  // scrolling back keeps working. This is the property a per-message ratchet
  // would have destroyed.
  for (let e = 0; e < 3; e++) {
    const r = await G.decryptGroupMessage(sent[e], {
      epochKey: keys[e], channelId: CHANNEL, senderId: alice.id, signingPublicJwk: alice.signJwk,
    });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.plaintext, `message in epoch ${e + 1}`);
  }
});

/* ── transcript chaining ──────────────────────────── */

test('a withheld message is detected as a chain break', async () => {
  const alice = await makeMember(1);
  const K = await G.generateEpochKey();
  const mk = async (text, prev) => G.encryptGroupMessage(text, {
    epochKey: K, epoch: 1, channelId: CHANNEL, senderId: alice.id, prev,
    signingPrivateKey: alice.sign.privateKey,
  });

  const m1 = await mk('one', null);
  const h1 = await G.envelopeHash(m1);
  const m2 = await mk('two', h1);
  const h2 = await G.envelopeHash(m2);
  const m3 = await mk('three', h2);

  const full = G.verifyChain([h1, h2], [m1, m2, m3]);
  assert.strictEqual(full.ok, true, 'an intact transcript raises nothing');

  // The server withholds m2 from this member. m3 still verifies on its own —
  // which is exactly why signatures alone are not enough.
  const solo = await G.decryptGroupMessage(m3, {
    epochKey: K, channelId: CHANNEL, senderId: alice.id, signingPublicJwk: alice.signJwk,
  });
  assert.strictEqual(solo.ok, true, 'the withheld-from view still sees a valid signature');

  const gapped = G.verifyChain([h1], [m1, m3]);
  assert.strictEqual(gapped.ok, false, 'but the chain shows the gap');
  assert.strictEqual(gapped.breaks[0].missingPrev, h2);
});

test('concurrent sends sharing a prev do not raise a false alarm', async () => {
  const [alice, bob] = [await makeMember(1), await makeMember(2)];
  const K = await G.generateEpochKey();
  const root = await G.encryptGroupMessage('root', {
    epochKey: K, epoch: 1, channelId: CHANNEL, senderId: alice.id, prev: null,
    signingPrivateKey: alice.sign.privateKey,
  });
  const h = await G.envelopeHash(root);
  // Both reply before seeing each other — a legitimate fork, not tampering.
  const a = await G.encryptGroupMessage('alice replies', {
    epochKey: K, epoch: 1, channelId: CHANNEL, senderId: alice.id, prev: h,
    signingPrivateKey: alice.sign.privateKey,
  });
  const b = await G.encryptGroupMessage('bob replies', {
    epochKey: K, epoch: 1, channelId: CHANNEL, senderId: bob.id, prev: h,
    signingPrivateKey: bob.sign.privateKey,
  });
  assert.strictEqual(G.verifyChain([h], [root, a, b]).ok, true);
});

/* ── roster gossip ────────────────────────────────── */

test('members agree on the roster digest, and disagree under substitution', async () => {
  const [alice, bob, carol] = [await makeMember(1), await makeMember(2), await makeMember(3)];
  const roster = [alice, bob, carol].map((m) => ({ id: m.id, ecdhJwk: m.ecdhJwk, signJwk: m.signJwk }));

  const d1 = await G.rosterDigest(roster);
  const d2 = await G.rosterDigest([...roster].reverse()); // order must not matter
  assert.strictEqual(d1, d2, 'digest is canonical regardless of member order');

  // The server feeds Carol a substituted key for Bob.
  const attacker = await makeMember(99);
  const carolsView = roster.map((m) => (m.id === bob.id ? { ...m, ecdhJwk: attacker.ecdhJwk } : m));
  assert.notStrictEqual(await G.rosterDigest(carolsView), d1, 'substitution changes the digest');
});

test('a substituted signing key also changes the digest', async () => {
  const [alice, bob] = [await makeMember(1), await makeMember(2)];
  const roster = [alice, bob].map((m) => ({ id: m.id, ecdhJwk: m.ecdhJwk, signJwk: m.signJwk }));
  const attacker = await makeMember(99);
  const tampered = roster.map((m) => (m.id === bob.id ? { ...m, signJwk: attacker.signJwk } : m));
  assert.notStrictEqual(await G.rosterDigest(tampered), await G.rosterDigest(roster));
});
