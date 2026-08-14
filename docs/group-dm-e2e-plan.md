# End-to-end encrypted group DMs — Design

Status: planning. Code does not exist yet. Group DMs themselves do not exist yet either — `start-dm` takes a single `targetUserId` (`src/socketHandlers/channels.js:1560`), so this is greenfield rather than a retrofit.

---

## 1. What we have today

Established by reading the current implementation, not assumed:

- **Crypto**: static ECDH P-256 → HKDF-SHA256 (`salt: 'haven-e2e-dm-v1'`, `info: 'aes-gcm-key'`) → AES-256-GCM (`public/js/e2e.js:315-343`).
- **One identity key per *user***, not per device. The private key is wrapped with PBKDF2(password, 210k) + AES-GCM and stored server-side as an opaque blob; IndexedDB caches it for auto-login (`e2e.js:44-58`).
- **Public keys are pinned TOFU.** `publish-public-key` refuses to overwrite an existing key without `force` and emits `public-key-conflict` (`src/socketHandlers/users.js:392-400`).
- **A DM is just a channel** with `is_dm = 1` and two `channel_members` rows (one for a self-DM).
- **Android mirrors the web crypto exactly** — same curve, same HKDF salt and info, same AES-GCM (`E2EManager.kt:35-36, 264-269`). Any scheme chosen here ports directly.
- **Guests are excluded from DMs** server-side because no password means no wrapping key (`channels.js:1556`).

Two properties of the existing scheme matter enormously for the group design, and both are easy to miss:

1. **There is no forward secrecy.** The pairwise key is derived once from two long-term keys and never rotates. Compromising one identity key retroactively decrypts every DM that user ever sent or received.
2. **There is no cryptographic sender authentication.** The pairwise key is symmetric, so *either* party can produce a ciphertext the other will accept. There is no signature anywhere in `e2e.js`. Sender identity comes from the `user_id` column the server writes — it is a server assertion, not a cryptographic one.

Point 2 is the hinge for the whole design, so it is worth stating plainly: **Haven's 1:1 DMs already have the property that a conversation partner could forge a message attributed to you**, and today's UI would render it normally.

---

## 2. The options

**A — Pairwise fan-out.** Encrypt each message separately to each member with the existing pairwise key; store N ciphertexts.
*Rejected.* Every message costs O(N) storage and bandwidth, and every attachment is duplicated per recipient — a 20 MB image in an 8-person group becomes 160 MB. The sender must also be able to derive a key for every member at send time, which fails for a member whose key is mid-reset.

**B — Sender keys (Signal-style).** Each member holds a per-group symmetric chain key, distributed pairwise, ratcheted per message.
*Rejected for v1.* A symmetric chain key must be given to every recipient so they can decrypt, which means every recipient can also encrypt with it — so sender keys **do not authenticate the sender** unless each message is additionally signed. Signal pairs every sender key with a per-sender signature key. Haven has no signing key, so B without signatures buys considerably more state than C for identical security. It becomes the right answer the moment signing keys exist (§7).

**C — Epoch group key.** One random AES-256 key per group per *epoch*, wrapped to each member over the existing pairwise channel. Encrypt once. Rotate the epoch on every membership change.
**Chosen.**

**D — MLS (RFC 9420).** The correct answer at scale: tree-based agreement, forward secrecy, post-compromise security, thousands of members.
*Rejected.* It requires per-device identity, signature keys, and delivery-service semantics Haven does not have, and there is no vetted MLS stack that drops cleanly into JavaScript *and* Kotlin *and* Swift. It is disproportionate for the 3–10 person groups this feature targets, and the implementation risk is the kind that produces confidently-wrong crypto.

### Why C is not a security regression

C's weakness is that any member can forge a message attributed to any other member, because they all hold the same key. That is **precisely the property 1:1 DMs already have** (§1, point 2). C does not introduce a new class of weakness; it widens the set of people who could forge from one to N−1. Given that every member of a group DM can already read everything, and that the fix (§7) is an additive upgrade rather than a redesign, that is an acceptable v1 trade — provided it is documented rather than glossed.

---

## 3. Data model

```sql
ALTER TABLE channels ADD COLUMN key_epoch INTEGER DEFAULT 0;

CREATE TABLE dm_group_keys (
  channel_id   INTEGER NOT NULL,
  epoch        INTEGER NOT NULL,
  recipient_id INTEGER NOT NULL,
  wrapped_key  TEXT    NOT NULL,   -- opaque to the server: {iv, ct} base64
  wrapped_by   INTEGER NOT NULL,   -- who performed the wrap, for rewrap trust decisions
  created_at   TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (channel_id, epoch, recipient_id)
);
CREATE INDEX idx_dm_group_keys_lookup ON dm_group_keys (channel_id, recipient_id, epoch);
```

Group DMs reuse `is_dm = 1` with more than two members, so channel membership, permissions, and message storage are unchanged.

**Message envelope** gains an epoch and a version bump. 1:1 DMs keep emitting `v:2` and are untouched:

```json
{ "v": 3, "e": 4, "iv": "…", "ct": "…" }
```

`wrapped_key` is `AES-GCM(K_epoch)` under the pairwise ECDH key between `wrapped_by` and `recipient_id` — a key both clients can already derive today with no new primitives.

---

## 4. Key lifecycle

**Create.** Creator generates a random 256-bit `K₁`, sets `epoch = 1`, wraps `K₁` once per member, uploads all rows in one transaction.

**Send.** Encrypt once under `K_current`. Stamp the epoch into the envelope.

**Receive.** Read `e` from the envelope, look up that epoch's key from the local cache, and unwrap from `dm_group_keys` on a miss. Cache alongside the identity key (IndexedDB on web, the existing encrypted prefs on Android).

**Add a member.** Rotate to `epoch + 1` and wrap for everyone including the newcomer. Rotating on join is what stops a new member reading history — they never receive the older epoch keys. This is deliberate and matches Signal.

**Remove a member.** Rotate to `epoch + 1` and wrap for the remaining members only. The removed member keeps whatever they already downloaded; that is unavoidable in any scheme and should be said out loud in the UI.

**Concurrent rotation.** Two members can rotate at once. The `PRIMARY KEY (channel_id, epoch, recipient_id)` makes the second writer lose; on conflict it refetches the current epoch and retries. Rotation is idempotent from the user's perspective.

---

## 5. What the server enforces without seeing plaintext

The server never holds a key, but it is not passive — it enforces structure:

- Only a **current member** may publish an epoch, and only for the channel they belong to.
- An epoch publish must contain **exactly one row per current member** — no more, no fewer. This is the important one: without it, a malicious member could publish an epoch that silently omits someone, locking them out of the conversation while the UI shows them as a participant.
- `epoch` must be exactly `channels.key_epoch + 1`. Monotonic, no gaps, no rewrites of a published epoch.
- A user may read **only their own** `wrapped_key` rows. `SELECT … WHERE recipient_id = socket.user.id`, never a bulk fetch.
- Deleting a member's rows is not a thing; epochs are append-only history.

---

## 6. Failure modes that need real handling

**A member resets their keys.** Haven already has this flow, and it is the sharpest edge here. Their old wrapped rows become undecryptable garbage, because they are sealed to a private key that no longer exists. Handling: the client detects it cannot unwrap, emits `request-group-rewrap`, and any member who is online and holds the current epoch re-wraps it under the new public key. Until someone does, that member sees a "waiting for keys" state — Haven already renders a ghost-state for exactly this situation in 1:1.

The rewrap must respect the existing TOFU pin: re-wrapping to a public key that differs from the pinned one is precisely the moment a server operator could substitute their own key, so it should surface the same `public-key-conflict` warning the 1:1 path uses rather than silently trusting it.

**Nobody online holds the key.** If every member who has the current epoch is offline, a rewrap simply waits. The group is not lost — it is pending. Worth an explicit UI string rather than an infinite spinner.

**A member is added while a rotation is in flight.** Server-side epoch monotonicity resolves it; the loser retries against the newer membership list.

---

## 7. Deliberate non-goals for v1, and the upgrade path

Not in v1, each for a reason:

- **Forward secrecy.** The epoch key is static within an epoch. This matches today's 1:1 exactly, so it is not a regression — but it is the weakest property of the design.
- **Post-compromise security.**
- **History for new joiners.** Deliberate.
- **Server-side search of group DMs.** DM search is already local-cache-only, so group DMs inherit the existing limitation rather than adding one.
- **Push previews.** The server cannot decrypt, so notifications stay generic — same as 1:1 today.

The upgrade path, in dependency order:

1. **Add an ECDSA P-256 signing key** to the identity blob, wrapped by the same password-derived key, published alongside the ECDH key. Cheap: same WebCrypto, same JCA on Android, no new dependency. Sign every message.
   This closes the forge-within-group gap **and** the equivalent gap that already exists in 1:1 DMs today — arguably worth doing for its own sake, independent of groups.
2. **Ratchet the epoch key per message** (`K_{n+1} = HKDF(K_n)`) once signatures exist, giving forward secrecy within an epoch at negligible cost.
3. **Sender keys (option B)** become correct once (1) lands, if per-sender ratcheting is wanted.
4. **MLS** only if group sizes ever grow past what pairwise rewrapping tolerates.

---

## 8. Cost

For a 10-member group, one rotation writes 10 rows of roughly 100 bytes — about 1 KB, and only on membership change. Messages and attachments are encrypted exactly once regardless of group size.

The rejected fan-out design would instead multiply **every message and every attachment** by the member count, forever.

---

## 9. Acceptance criteria

- [ ] A group DM with 3+ members exchanges messages no server-side observer can read; verified by reading `messages.content` directly out of SQLite and confirming it is ciphertext.
- [ ] A member added at epoch N cannot decrypt messages from epoch N−1, verified rather than assumed.
- [ ] A member removed at epoch N cannot decrypt anything sent at epoch N+1.
- [ ] An epoch publish that omits a current member is rejected by the server.
- [ ] A member who resets their keys recovers full access after a rewrap, and sees an explicit waiting state before it.
- [ ] Web, Android, and iOS interoperate in the same group — the strongest end-to-end check, since all three implement the crypto independently.
- [ ] 1:1 DMs still emit and accept `v:2` envelopes with no behavior change.
