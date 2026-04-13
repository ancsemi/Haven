# Server List Sync — Developer Integration Guide

## What It Does

Haven now stores an encrypted copy of each user's server list on every server they log into. When a user logs in from a new device (or after clearing browser data), their full server list is automatically restored. No manual re-adding.

## Why

The server list was previously stored only in `localStorage` / client-side storage. Switching devices, clearing app data, or reinstalling meant manually re-adding every server. This was the #1 friction point for multi-server users.

## How It Works

### The Flow

1. **On login** (password entry required — not auto-login/JWT refresh):
   - Client derives a wrapping key from the password using `HavenE2E.deriveWrappingKey(password)` — this already happens for E2E encryption
   - Client calls `GET /api/auth/user-servers` → receives an encrypted blob (or null)
   - Client decrypts the blob using AES-256-GCM with the wrapping key
   - Client merges the decrypted server list with its local list (union by URL)
   - If the merged list differs from what the server had, client re-encrypts and calls `PUT /api/auth/user-servers`

2. **On adding/removing a server:**
   - Client updates local storage as before
   - Client re-encrypts the full list and pushes to the current server via `PUT /api/auth/user-servers`

3. **On password change:**
   - Client re-encrypts the server list blob with the new password-derived key (same as E2E key re-wrapping)

### Multi-Device Convergence

The server list converges across devices passively:
- DeviceA adds ServerD → pushes to ServerA
- DeviceB logs into ServerA → pulls the updated list → now has ServerD
- DeviceB visits ServerB → pushes the merged list → ServerB is updated too
- No server-to-server communication ever occurs

### Removal Handling

Removals are **local-only**. When a user removes a server:
- The URL is added to a local `haven_servers_removed` set (stored in localStorage / app storage)
- The server is removed from the local list
- The updated (shorter) list is pushed to the server
- Remote blobs on other servers may still contain the removed URL — but the local removed-set prevents it from reappearing after merge

---

## API Endpoints

Both endpoints are on the auth router (`/api/auth/`), protected by JWT.

### `GET /api/auth/user-servers`

**Headers:** `Authorization: Bearer <jwt>`

**Response:**
```json
{ "blob": "<base64-encoded-encrypted-string>" }
```
or
```json
{ "blob": null }
```

### `PUT /api/auth/user-servers`

**Headers:** `Authorization: Bearer <jwt>`, `Content-Type: application/json`

**Body:**
```json
{ "blob": "<base64-encoded-encrypted-string>" }
```

**Constraints:** Blob must be a string, max 65536 characters.

**Response:**
```json
{ "ok": true }
```

---

## Encryption Format

### Key Derivation

The wrapping key is the same one used for E2E DM encryption:

```
password (plaintext)
  → PBKDF2(SHA-256, salt="haven-e2e-wrapping-v3", iterations=210000)
  → 256 bits
  → hex string (64 chars)
```

This hex string is what `HavenE2E.deriveWrappingKey(password)` returns. The Android app likely already computes this for E2E — reuse it.

### Blob Encryption

The blob stored on the server is: `base64(salt + iv + ciphertext)`

```
wrappingHex (64-char hex string)
  → convert to 32 raw bytes
  → PBKDF2(SHA-256, salt=<random 16 bytes>, iterations=100000)
  → AES-256-GCM key

plaintext = JSON.stringify(serverList)
iv = 12 random bytes
ciphertext = AES-GCM-encrypt(key, iv, plaintext)

blob = base64(salt[16] + iv[12] + ciphertext[...])
```

### Blob Decryption

```
raw = base64decode(blob)
salt = raw[0..15]     (16 bytes)
iv   = raw[16..27]    (12 bytes)
ct   = raw[28..]      (remaining)

key = PBKDF2(SHA-256, wrappingHexBytes, salt, 100000) → AES-256-GCM key
plaintext = AES-GCM-decrypt(key, iv, ct)
serverList = JSON.parse(plaintext)
```

### Plaintext Format

The decrypted JSON is an array of server objects:

```json
[
  {
    "url": "https://haven.example.com",
    "name": "My Server",
    "icon": "https://haven.example.com/uploads/icon.png",
    "addedAt": 1712937600000
  }
]
```

Only `url` is required. `name`, `icon`, and `addedAt` are optional metadata.

---

## Merge Logic

The merge is a **union by URL**:

```
localUrls  = set of URLs from local storage
remoteUrls = set of URLs from decrypted blob
removedUrls = set of URLs the user has explicitly removed (local-only)

for each remote server:
    if URL not in localUrls AND URL not in removedUrls:
        add to local list

if merged list != remote list:
    re-encrypt and push
```

This is commutative and idempotent — order of operations doesn't matter, and running it twice produces the same result.

---

## Integration Checklist for Android

1. **Compute the wrapping key** from the password at login (you probably already do this for E2E):
   ```
   PBKDF2(SHA-256, password, "haven-e2e-wrapping-v3", 210000) → 32 bytes → hex
   ```

2. **After login**, call `GET /api/auth/user-servers` with the JWT

3. **If blob is non-null**, decrypt it using the format above

4. **Merge** with the app's local server list (union by URL, excluding removed servers)

5. **If changed**, re-encrypt and `PUT /api/auth/user-servers`

6. **On add/remove server**, re-encrypt the full list and push

7. **On password change**, re-encrypt with the new wrapping key and push

8. **Store removed-server URLs locally** (app preferences / local DB) so they don't reappear from stale blobs

---

## Security Notes

- The server admin **cannot read** the server list — it's encrypted with the user's password
- AES-GCM is authenticated — tampered blobs fail decryption silently (client falls back to local list)
- No server-to-server communication exists — servers are completely unaware of each other
- The wrapping key never leaves the client device
