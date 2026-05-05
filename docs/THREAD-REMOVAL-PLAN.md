# Thread System — Removal Plan

> Issue context: GitHub #5336. Threads in DMs are sent as **plaintext** even
> though the parent DM is E2E encrypted, so server admins can read every
> thread reply that was meant to be private. Rather than retrofit E2EE onto
> the thread layer (significant code: thread panel, PiP, drag/resize,
> participant aggregation, dedicated socket events, dedicated DB index), the
> decision is to **remove the thread system entirely**. This plan is written
> for a follow-up Sonnet session — execute top to bottom.

## Verified evidence the thread layer is unencrypted

* `public/js/modules/app-utilities.js` `_sendThreadMessage()` emits raw text:
  ```js
  this.socket.emit('send-thread-message', { parentId, content, replyTo }, ...)
  ```
  No `this.e2e.encrypt(...)`, no `payload.encrypted = true`.
* `src/socketHandlers/messages.js` `send-thread-message` handler stores
  `safeContent` directly into `messages.content` and re-emits it as
  plaintext on `new-thread-message` / `thread-updated`.
* `_appendThreadMessage` in `app-utilities.js` never invokes the e2e
  decrypt path and renders no lock indicator (`e2eTag`) — confirming
  threads were never wired into E2EE on either side.

## Scope of removal

### A. Database (`src/database.js`)

1. Drop the column + index introduced for threads:
   ```sql
   DROP INDEX IF EXISTS idx_messages_thread;
   ALTER TABLE messages DROP COLUMN thread_id;       -- SQLite ≥3.35
   ```
   On older SQLite, do the rebuild dance (create new table without
   `thread_id`, copy rows where `thread_id IS NULL`, drop old, rename).
2. Add a one-shot migration that **deletes thread reply rows**
   (`WHERE thread_id IS NOT NULL`) BEFORE dropping the column so there
   are no dangling FK references and so old replies don't appear as
   loose channel messages once the filter is gone.
3. Remove the comment block `// ── Migration: chat threads ─────` and
   the conditional ALTER from `runMigrations()`.

### B. Server socket handlers

`src/socketHandlers/messages.js`:

* Delete the `socket.on('get-thread-messages', ...)` handler (≈ lines 1286–1361).
* Delete the `socket.on('send-thread-message', ...)` handler (≈ lines 1363–1462).
* Remove every `AND thread_id IS NULL` / `AND m.thread_id IS NULL` filter
  in the `before` / `after` / `around` / default `get-messages` queries
  and in `mark-read-channel`. They become dead conditions once the column
  is gone — leaving them in is a runtime error.
* Remove the `threadMap` enrichment block (≈ lines 140–180) that attaches
  `thread: { count, lastReplyAt, participants }` to outgoing messages.
  Drop the `participants` query and the JOIN that produces them.
* Stop emitting `thread-updated` and `new-thread-message`.

`src/socketHandlers/index.js`:

* Strip the `AND thread_id IS NULL` from the channels-list unread/latest
  queries (≈ lines 258, 269, 273) — once column is gone they error.

### C. Client renderer (modular `public/js/modules/`)

| File | What to delete |
|------|----------------|
| `app-utilities.js` | `_openThread`, `_closeThread`, `_setThreadPiPEnabled`, `_toggleThreadPiP`, `_sendThreadMessage`, `_appendThreadMessage`, `_updateThreadPreview`, `_renderThreadPreview`, `_setThreadParentHeader`, `_setThreadReply`, `_clearThreadReply`, `_quoteThreadMessage`, `_clearThreadMentionsForParent`, `_setupVideos`'s thread-panel branch, the `pip-mode thread-panel` z-index comment block, the `_activeThreadParent` keyboard handler at ~line 1364. |
| `app-socket.js` | The `socket.on('thread-messages', ...)`, `socket.on('new-thread-message', ...)`, `socket.on('thread-updated', ...)` handlers (≈ lines 880–950). |
| `app-ui.js` | The `.thread-preview` click delegation (≈ 1612), all `thread-panel-*` button wiring (close, pip, send, resize handlers ≈ 1619–1922), the `bindOverflowDirection(threadMessages)` call, and the `_quoteThreadMessage` action in the message-overflow handler. |
| `app-channels.js` | The `this._closeThread()` call in the channel-switch flow (line 181) — drop it; thread state no longer exists. |
| `app-messages.js` | The `_appendThreadMessage` call site if any; the `e2eTag` rendering path is unaffected. |
| `app.js` | Remove `this._threadReplyingTo` and `this._activeThreadParent` field initialisers (lines 38–39). |

### D. HTML / CSS / assets

* `public/app.html`: delete the `<div id="thread-panel">…</div>` block
  (lines 751–~840 — includes header, resizer, messages list, input row,
  PiP/close buttons). Remove any reply context buttons that emit
  `data-action="thread"` and the floating jump-to-thread chip.
* `public/css/style.css`: delete every `.thread-preview*`, `.thread-panel*`,
  `.thread-msg-*`, `.resizing-thread-panel`, `.thread-action-react-icon`
  rule (≈ lines 7471–7900 region — search for the prefix `.thread-`).
* `public/css/style.css` PiP z-index comment about thread-panel:
  collapse the comment, leave dm-pip alone.
* `public/sounds/`: no thread-specific sound files to remove.

### E. Stickers / docs

* `docs/stickers-scope.md`: rip out the example that emits
  `send-thread-message` (lines ~115–117) — replace with a regular
  `send-message` example or delete the section.
* `docs/server-list-sync.md`, `desktop-directive.md`: no thread refs
  found in the spot-check, but `grep -r "thread" docs/` and clean any
  stragglers.

### F. Backups / legacy

* `public/js/app.js.bak`, `public/js/modules/app.js.bak`,
  `public/js/modmode.v3.bak`, `public/js/modmode.v4.bak`: leave as-is.
  These are explicit `.bak` snapshots — Sonnet should NOT edit `.bak`
  files, only the live source.

### G. CHANGELOG

Add a top entry under `[Unreleased]`:

```markdown
### Removed
- **Threads** — the entire thread system (panel, PiP, replies, DB
  column) has been removed. Threads in DMs were never end-to-end
  encrypted, which silently exposed reply text to server admins. Rather
  than retrofit E2EE onto a feature with low usage, threads are gone.
  Existing thread-reply rows are deleted by the DB migration; the
  parent message survives unchanged. (#5336)
```

## Order of operations (so nothing 500s mid-deploy)

1. **Renderer first** — ship a build that no longer renders the thread
   UI, no longer subscribes to `thread-*` events, no longer emits
   `get-thread-messages` or `send-thread-message`. Old servers continue
   to accept those events but nobody calls them.
2. **Server next** — delete the handlers and the `thread_id` filters in
   the message queries.
3. **DB last** — run the migration that deletes thread-reply rows and
   drops the column + index.

Steps 1 and 2 can be the same commit if you're confident clients update
quickly. Step 3 is the irreversible one — gate it on a backup script
and ship it as its own release.

## Acceptance checklist

- [ ] `grep -ri "thread_id\|thread-panel\|threadCount\|send-thread-message\|new-thread-message\|thread-updated\|_activeThreadParent\|_openThread\|_closeThread" Haven/src Haven/public/js/modules Haven/public/css Haven/public/app.html` returns **zero hits** in non-`.bak` files.
- [ ] `npm start` boots clean — no migration errors, no missing-handler warnings.
- [ ] Sending a normal DM still works.
- [ ] Sending a normal channel message still works.
- [ ] The 🔒 lock icon still appears on encrypted DM messages.
- [ ] The right-click context menu on a message no longer offers "Open in Thread".
- [ ] PiP DM still works (it shares no code with the thread PiP after this cleanup).
- [ ] Reply functionality (`reply_to`) is unchanged — that's a separate
      feature from threads and stays.

## Out of scope

* No replacement feature. If users want a "branch" off a message in the
  future, the right answer is per-message E2EE-aware nested replies
  built into the existing message renderer — not a parallel surface
  with its own DB column and socket events.
* Push notifications: there's no `thread-message` FCM topic to revoke.
  Confirm by grepping `haven-push-relay/` for `thread` (currently
  returns nothing).
