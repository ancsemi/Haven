# End-to-end encrypted group DMs — Design

Status: planning. Code does not exist yet. Group DMs themselves do not exist either — `start-dm` takes a single `targetUserId` (`src/socketHandlers/channels.js:1560`), so this is greenfield rather than a retrofit.

---

## 1. What we have today

Established by reading the implementation, not assumed:

- **Crypto**: static ECDH P-256 → HKDF-SHA256 (`salt: 'haven-e2e-dm-v1'`, `info: 'aes-gcm-key'`) → AES-256-GCM (`public/js/e2e.js:315-343`).
- **One identity key per *user***, not per device. Private key wrapped with PBKDF2(password, 210k) + AES-GCM, stored server-side as an opaque blob, cached in IndexedDB for auto-login.
- **Every real user has a published public key.** `publish-public-key` fires on every E2E init (`e2e.js:490`), and the server pins it TOFU — overwrites are refused without `force` and raise `public-key-conflict` (`users.js:392-400`). Guests are the only excluded class, and they are barred from DMs server-side anyway (`channels.js:1556`).
- **Android mirrors the web crypto exactly** — same curve, same HKDF salt and info, same AES-GCM (`E2EManager.kt:35-36, 264-269`). Anything chosen here ports to all three clients.

Three properties drive every decision below.

**1. Clients decrypt history on demand, from server-held ciphertext.** `decryptMessages()` runs on every `message-history` payload, including back-pagination. The server stores ciphertext permanently and clients re-decrypt whenever the user scrolls. This is the single most important constraint in this document, and §4 explains why. §4a covers detecting a tampered channel.

**2. There is no forward secrecy.** The pairwise key derives once from two long-term keys and never rotates.

**3. There is no cryptographic sender authentication.** The pairwise key is *symmetric*, so either party can produce a ciphertext the other accepts, and there is no signature anywhere in `e2e.js`. Sender identity is the `user_id` column the server writes — a server assertion. **A DM partner can already forge a message attributed to you**, and the UI renders it normally. This is a live gap in 1:1 DMs today, not a hypothetical introduced by groups.

### Key presence vs. key availability

Worth separating, because they are often conflated:

- **Presence** — a public key exists on the server for this user. Effectively universal, per above.
- **Availability** — the *private* key is usable on *this device right now*. Not guaranteed: a fresh device with only a JWT and no password cannot unwrap the server backup. The code already models this as `ghostState` (`e2e.js:73, 177`).

So a design may assume it can always *encrypt to* any member. It may not assume every member can immediately *decrypt*. Only the recovery path in §6 needs to care.

---

## 2. Add a signing key. This is the foundation, not an enhancement.

Every group scheme worth having needs sender authentication, and Haven has no signing key. So that comes first:

- Generate an **ECDSA P-256** key pair alongside the existing ECDH pair.
- Wrap it with the same password-derived key, in the same backup blob, published by the same flow with the same TOFU pin.
- **ECDSA P-256 over Ed25519** purely for reach: P-256 signing is available in WebCrypto, Android JCA and CryptoKit today, with no polyfill and no new dependency. Ed25519 support in WebCrypto is still uneven across browser versions, and this has to work identically on three independent client implementations.

Every message carries a signature over a context-bound digest:

```
sig = ECDSA-SHA256( sk_sign , "havenmsg:v1" ‖ channel_id ‖ epoch ‖ sender_id ‖ iv ‖ ciphertext )
```

Binding `channel_id`, `epoch` and `sender_id` into the signed input stops a valid ciphertext being replayed into another group, another epoch, or re-attributed to another sender. Recipients verify against the pinned signing key for the `sender_id` the server claims — which turns the server's assertion into something checkable rather than something trusted.

**Apply this to 1:1 DMs as well.** The forge gap in §1.3 exists there today; the fix is the same signature. Doing groups "properly" while leaving 1:1 unauthenticated would be a strange place to stop.

---

## 3. Group keys: one epoch key, wrapped per member

- A group holds a random **AES-256 epoch key**, `K_e`.
- `K_e` is wrapped to each member under the pairwise ECDH key that already exists, and stored as an opaque blob the server cannot read.
- Messages are encrypted **once** with `K_e`, regardless of group size, and signed per §2.
- The epoch rotates on **every membership change**: joining rotates so a new member cannot read history, leaving rotates so a departed member cannot read forward.

Confidentiality comes from the epoch key; authenticity comes from the signature. Separating the two is what lets a single shared key be safe here — every member can decrypt, but only the holder of a signing key can *author*.

```sql
ALTER TABLE channels ADD COLUMN key_epoch INTEGER DEFAULT 0;

CREATE TABLE dm_group_keys (
  channel_id   INTEGER NOT NULL,
  epoch        INTEGER NOT NULL,
  recipient_id INTEGER NOT NULL,
  wrapped_key  TEXT    NOT NULL,   -- opaque: {iv, ct} base64
  wrapped_by   INTEGER NOT NULL,
  created_at   TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (channel_id, epoch, recipient_id)
);
```

Envelope, versioned so 1:1 `v:2` traffic is untouched:

```json
{ "v": 3, "e": 4, "prev": "…", "iv": "…", "ct": "…", "sig": "…" }
```

---

## 4. Why not a per-message ratchet

The textbook answer to "do it properly" is Signal's sender keys: a per-sender chain key, ratcheted per message, old keys deleted. That is genuinely the right design **for Signal's architecture**, and it is the wrong one here.

Signal keeps decrypted history in a local database and never re-fetches ciphertext. Haven does the opposite: the server holds ciphertext forever and clients decrypt on every scroll-back (§1.1).

Forward secrecy requires deleting old message keys. If the keys are gone, re-fetched history cannot be decrypted. So on Haven a per-message ratchet buys forward secrecy **only** by making history permanently unreadable — or by forcing every client to persist every message key forever, which is more key material at rest than simply keeping one epoch key, and therefore strictly worse on both counts.

This is not a shortcut being rationalised. Copying the ratchet here would produce a system that looks stronger on paper and is weaker in practice, and would break scrolling back in a group DM.

**Forward secrecy is therefore epoch-granular**, and the epoch is the tuning knob:

- Rotate on every membership change (required for correctness).
- Optionally rotate on a schedule — every N days or N messages — which bounds the blast radius of a compromised key to one epoch's traffic.
- Clients retain the old epoch keys they already hold, so history stays readable. A client that wants stronger guarantees can discard epoch keys past a retention horizon and accept that older history goes dark. That is a **policy choice exposed to the user**, not something the protocol has to decide.

---

## 4a. Detecting a tampered channel

Two distinct worries, often collapsed into one: *is the key I hold really theirs* (MITM), and *is the message stream I received the real one* (compromised delivery). They need different answers.

### Not network identifiers

Binding trust to MAC address or IP was considered and rejected. Recording why, so it does not resurface:

- **A browser cannot read its own MAC.** No web API exposes it, and web is a first-class Haven client.
- **MAC addresses do not survive the first router hop.** Layer 2 addressing is rewritten hop by hop, so the server never sees a remote client's MAC — only the nearest gateway's. It could therefore only ever be *self-reported*.
- **Self-reported values are attacker-controlled.** That is the exact weakness §2 exists to fix. Sender identity today is a server assertion; replacing it with a client assertion is not an improvement, because a compromised client reports whatever passes.
- **A server-observed IP is circular here.** End-to-end encryption exists because the server is not trusted. Asking that server what address it saw, in order to detect server-mediated compromise, closes no loop — it can simply lie.
- **Both identifiers are deliberately unstable now.** iOS and Android randomize MAC per SSID on their own schedule, and addresses change on Wi-Fi/cellular handoff, CGNAT and VPN. The result is a stream of false compromise alerts, which teaches people to dismiss the warning — worse than showing none.
- **It is a privacy regression.** Persisting device and network identifiers builds exactly the tracking surface this project exists to avoid, visible to the operator you are defending against.
- **It does not detect the attack anyway.** MITM here means key substitution. An IP address says nothing about whether the public key you fetched is genuine.

### Key substitution: verify the roster, not the network

Pairwise verification already exists — `getVerificationCode()` (`e2e.js:290`) derives a Signal-style 60-digit safety number from both public keys, and TOFU pinning already refuses silent key changes.

Groups allow something strictly stronger, and it costs almost nothing: **roster gossip**. Each member periodically publishes a signed digest over the sorted list of `(user_id, ECDH pubkey, signing pubkey)` for the whole group. Every client compares the digests.

- All digests equal → every member sees identical keys for everyone. No substitution has occurred anywhere in the group.
- One digest differs → that member has been fed a different key for someone, and the client says so, naming the disagreement.

A 1:1 conversation cannot do this, because there is no third party to disagree with. A group is its own redundancy, so substitution becomes detectable **without** anyone reading digits aloud. Out-of-band safety-number comparison stays available as the manual escalation once a disagreement is flagged.

### Compromised delivery: chain the transcript

Signatures stop tampering and injection, but a signature on each message says nothing about the *set* of messages, so a hostile server can still drop, reorder, or withhold messages from selected members and every remaining signature verifies.

Fix by binding each message to the one before it. Every message carries `prev`, the SHA-256 of the previous message envelope the sender had seen in that channel, and `prev` sits inside the signed digest from §2:

```
sig = ECDSA-SHA256( sk_sign, "havenmsg:v1" ‖ channel_id ‖ epoch ‖ sender_id ‖ prev ‖ iv ‖ ciphertext )
```

Now the message history is an append-only hash chain that the server cannot rewrite:

- **Dropped or withheld message** → the next message's `prev` refers to something the recipient never received. Gap detected.
- **Reordering** → the chain does not link. Detected.
- **Split view** (different members shown different histories) → their chains diverge, and roster gossip surfaces the divergence because the heads disagree.

Cost is 32 bytes per message and no new primitives. Concurrent sends legitimately produce branches — several senders can share the same `prev` — so clients treat it as a DAG and only alarm on a `prev` that never arrives, not on ordinary forks.

This is the honest version of the instinct behind checking network identity: verify the *conversation*, cryptographically, instead of guessing from the transport.

---

## 5. What the server enforces without holding a key

The server never sees a key, but it is not passive:

- Only a **current member** may publish an epoch, for their own channel.
- An epoch publish must contain **exactly one row per current member** — no more, no fewer. Without this rule a malicious member could publish an epoch silently omitting someone, locking them out while the UI still lists them as a participant.
- `epoch` must be exactly `key_epoch + 1`. Monotonic, append-only, no rewrites.
- A user may read **only their own** wrapped rows.
- Signing keys get the same TOFU pinning as ECDH keys, since an unpinned signing key is a server-operator impersonation vector.

Concurrent rotations resolve on the primary key: the loser refetches and retries against the newer membership.

---

## 6. Failure modes

**A member resets their keys.** Their wrapped rows become undecryptable — sealed to a private key that no longer exists. The client emits `request-group-rewrap`, and any online member holding the current epoch re-wraps it under the new public key. Until then that member sees an explicit waiting state; Haven already renders a ghost-state for exactly this in 1:1.

The rewrap must respect the TOFU pin. Re-wrapping to a public key that differs from the pinned one is precisely when a server operator would substitute their own key, so it raises the same `public-key-conflict` prompt rather than trusting silently.

**Nobody online holds the epoch key.** The rewrap waits. The group is pending, not lost — worth a real UI string rather than a spinner.

**Rollout with mixed clients.** Old clients emit no signature. Verify-if-present during migration, surfacing unsigned messages as unverified; enforce once all three clients ship. Never silently accept an unsigned message after enforcement, or the authentication is decorative.

---

## 7. What this does and does not give

Delivered:

- **Sender authentication** — cryptographic, for group *and* 1:1, closing a gap that exists today.
- **Confidentiality** from a server that stores everything.
- **Encrypt-once** — one ciphertext and one attachment copy regardless of group size.
- **Forward secrecy at epoch granularity**, tunable by rotation policy.
- **No new dependencies** — WebCrypto, JCA and CryptoKit all cover ECDSA P-256, ECDH P-256, HKDF and AES-GCM.

Not delivered:

- **Post-compromise security.** Nothing here heals after a compromise; an attacker holding an identity key keeps reading until keys are rotated and re-pinned. MLS is the only real answer, and it needs per-device identity, credential handling and delivery-service ordering semantics that Haven does not have — plus a Rust/WASM stack across all three clients. Worth revisiting only if group sizes or the threat model change materially.
- **Metadata privacy.** The server always knows who is in a group and who posted when.

---

## 8. Cost

A 10-member group writes 10 wrapped rows (~100 bytes each) per rotation, and only on membership change. Messages and attachments are encrypted once at any group size. Per-message overhead is one ~64-byte signature.

The rejected fan-out alternative would instead multiply every message *and every attachment* by member count, permanently — a 20 MB image in an 8-person group becomes 160 MB.

---

## 9. Acceptance criteria

- [ ] A 3+ member group exchanges messages no server-side observer can read — verified by reading `messages.content` straight out of SQLite.
- [ ] A message with a tampered ciphertext, a swapped `sender_id`, or a signature lifted from another channel or epoch is **rejected**, not merely rendered oddly.
- [ ] A member added at epoch N cannot decrypt epoch N−1; a member removed at N cannot decrypt N+1. Both verified, not assumed.
- [ ] An epoch publish omitting a current member is rejected server-side.
- [ ] A member who resets keys recovers after a rewrap, with an explicit waiting state before it, and a conflict prompt if the pinned key changed.
- [ ] Scrolling back through a group DM still decrypts after several epoch rotations — the specific regression a ratchet design would have caused.
- [ ] A message withheld from one member by the server is **detected** by that member via a broken `prev` chain, not silently absent.
- [ ] A member fed a substituted public key is detected by roster-digest disagreement, without any out-of-band step.
- [ ] Concurrent sends sharing the same `prev` do **not** raise a false alarm.
- [ ] Web, Android and iOS interoperate in one group, including signature verification across all three.
- [ ] 1:1 DMs keep working throughout, and gain signatures on the same schedule.
