# Stickers Feature — Work Scope (Issue #5335)

## Overview

Server-hosted stickers that can be sent as standalone messages anywhere in Haven where the emoji picker is accessible: main channel, sub-channels, DMs (fullscreen and PiP), Threads (docked and PiP).

Stickers live in a second tab inside the existing emoji picker window — no new button added to the input bar.

---

## Design Decisions

- **Format**: Stickers are sent as standalone `/uploads/stickers/<filename>` messages (same mechanism as GIFs). No new socket event or content format needed on the server side beyond the upload/management API.
- **Rendering**: The URL prefix `/uploads/stickers/` triggers a `sticker-img` CSS class for larger display (≈200–280px) vs standard `chat-image` (max 400px wide). Stickers are centered on their own line with no caption.
- **Sending context**: A `_emojiPickerContext` state (`'main'` | `'pip'` | `'thread'`) is set whenever the emoji picker opens, so the sticker click handler knows which send path to use.
- **Permissions**: Upload/delete is admin-only OR `manage_emojis` permission (reusing the existing perm — can rename perm key in a follow-up if desired, but not required).
- **Packs**: Stickers have an optional `pack_name` field (defaults to `'General'`). The picker groups stickers by pack with a filter row.
- **E2E DMs**: Stickers sent as `/uploads/stickers/…` URLs go through `send-message` the same way regular uploaded images do. They are NOT E2E encrypted because sticker files are server-hosted (same as GIFs and server-side uploads). This is acceptable and consistent with how GIFs work.

---

## Part 1 — Database

**File**: `src/database.js`

Add a migration block after the `custom_emojis` table creation:

```sql
CREATE TABLE IF NOT EXISTS stickers (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  name      TEXT UNIQUE NOT NULL,
  pack_name TEXT NOT NULL DEFAULT 'General',
  filename  TEXT NOT NULL,
  uploaded_by INTEGER REFERENCES users(id),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

---

## Part 2 — Server API Routes

**File**: `server.js`

Parallel to the existing `/api/upload-emoji`, `/api/emojis`, `/api/emojis/:name` routes.

### `POST /api/upload-sticker`
- Auth: logged-in user with admin or `manage_emojis` permission
- Body: `multipart/form-data` with `sticker` (file), `name` (string), `pack_name` (string, optional)
- Validates: image MIME type, max size (use same `max_emoji_kb` setting or a dedicated `max_sticker_kb`, TBD), name unique
- Saves to `uploads/stickers/<uuid>.<ext>` subdirectory  
  - The `uploads/stickers/` subdirectory needs to be created if absent (`fs.mkdirSync(..., { recursive: true })`)
  - Use a dedicated multer storage config pointing to `uploads/stickers/`
- Inserts row into `stickers` table
- Returns `{ name, pack_name, url: '/uploads/stickers/<filename>' }`

### `GET /api/stickers`
- Auth: any logged-in user
- Returns `{ stickers: [ { id, name, pack_name, url } ] }` sorted by pack_name asc, name asc

### `DELETE /api/stickers/:name`
- Auth: admin or `manage_emojis`
- Deletes DB row and physical file from `uploads/stickers/`
- Returns `{ ok: true }`

### Express static
The existing `app.use('/uploads', express.static(uploadDir))` already covers `uploads/stickers/` automatically since `uploads/stickers/` is under `uploadDir`. No additional static route needed.

---

## Part 3 — Client State

**File**: `public/js/app.js`

Add to initial state:
```js
this.stickers = [];         // [{id, name, pack_name, url}]
this._emojiPickerContext = 'main'; // 'main' | 'pip' | 'thread'
```

---

## Part 4 — Load Stickers

**File**: `public/js/modules/app-media.js`

New method `_loadStickers()` (parallel to `_loadCustomEmojis`):
```js
async _loadStickers() {
  try {
    const res = await fetch('/api/stickers', { headers: { 'Authorization': `Bearer ${this.token}` } });
    if (!res.ok) return;
    const data = await res.json();
    this.stickers = data.stickers || [];
  } catch { /* ignore */ }
},
```

Call `this._loadStickers()` during app init (alongside `_loadCustomEmojis` call or nearby).

---

## Part 5 — Send Sticker

**File**: `public/js/modules/app-utilities.js`

New method `_sendStickerMessage(sticker)` (similar to `_sendGifMessage`):

```js
_sendStickerMessage(sticker) {
  const ctx = this._emojiPickerContext || 'main';

  const code = ctx === 'pip' ? this._activeDMPip : this.currentChannel;
  if (!code) return;

  const payload = { code, content: sticker.url };
  if (ctx === 'pip' && this._dmPipReplyingTo) {
    payload.replyTo = this._dmPipReplyingTo.id;
    this._clearDMPiPReply?.();
  } else if (ctx === 'main' && this.replyingTo) {
    payload.replyTo = this.replyingTo.id;
    this._clearReply();
  }

  this.socket.emit('send-message', payload);
  this.notifications.play('sent');
},
```

---

## Part 6 — Emoji Picker Context Tracking

**File**: `public/js/modules/app-ui.js`

Set `_emojiPickerContext` before calling `_toggleEmojiPicker` in each call site:

**Main emoji button** (around line 1995):
```js
document.getElementById('emoji-btn').addEventListener('click', () => {
  this._emojiPickerContext = 'main';
  this._toggleEmojiPicker();
});
```

**DM PiP emoji button** (around line 1682):
```js
dmPipEmojiBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  this._activeEditTextarea = document.getElementById('dm-pip-input');
  this._emojiPickerContext = 'pip';
  this._toggleEmojiPicker(dmPipEmojiBtn);
});
```

**Thread emoji button** (around line 1795):
```js
threadEmojiBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  this._activeEditTextarea = document.getElementById('thread-input');
  this._emojiPickerContext = 'thread';
  this._toggleEmojiPicker(threadEmojiBtn);
});
```

---

## Part 7 — Sticker Tab in Emoji Picker

**File**: `public/js/modules/app-utilities.js`, inside `_toggleEmojiPicker`

After the existing category tab row, add a "Stickers" tab button (🖼) at the end. When clicked:
- Switches `_emojiPickerSection` between `'emojis'` and `'stickers'`
- Re-renders the picker body accordingly

The sticker view:
1. **Pack filter row**: buttons for each unique `pack_name` in `this.stickers` + "All" button
2. **Search input** (or share the existing emoji search input): filters by sticker name
3. **Sticker grid**: larger cells (~80px) with sticker thumbnails, sticker name as tooltip
4. **Click handler**: calls `this._sendStickerMessage(sticker)` then closes the picker

Picker height/width may need a small CSS adjustment when stickers tab is active (sticker cells are larger than emoji cells). The simplest approach is to keep the same picker dimensions and let the grid scroll.

Active tab state: a top-level `_emojiPickerSection` property (`'emoji'` | `'sticker'`) persists while the picker is open. Reset to `'emoji'` on close.

Structure of the tab addition inside `_toggleEmojiPicker`:
```js
// Add "Stickers" tab after existing category tabs
const stickerTabBtn = document.createElement('button');
stickerTabBtn.className = 'emoji-tab' + (this._emojiPickerSection === 'sticker' ? ' active' : '');
stickerTabBtn.textContent = '🖼';
stickerTabBtn.title = 'Stickers';
stickerTabBtn.addEventListener('click', () => {
  this._emojiPickerSection = 'sticker';
  tabRow.querySelectorAll('.emoji-tab').forEach(t => t.classList.remove('active'));
  stickerTabBtn.classList.add('active');
  renderStickerGrid();
});
tabRow.appendChild(stickerTabBtn);
```

The `renderStickerGrid(filter, pack)` function:
- Gets stickers from `this.stickers`
- Filters by `pack` if provided
- Filters by name if `filter` is provided
- Renders each sticker as a button with `<img class="sticker-picker-thumb">` 
- On click: `this._sendStickerMessage(sticker); picker.style.display = 'none'; ...cleanup`

If no stickers exist, show a muted placeholder "No stickers uploaded yet".

When the emoji tab is clicked (any category tab), `_emojiPickerSection = 'emoji'` and the normal emoji grid shows.

---

## Part 8 — Message Rendering

**File**: `public/js/modules/app-utilities.js`, `_renderMessageContent` method

Replace the existing server-image inline check (around line 350):

```js
// Before:
if (/^\/uploads\/[\w\-]+\.(jpg|jpeg|png|gif|webp|svg)$/i.test(str.trim())) {
  return `<img src="..." class="chat-image" alt="image">`;
}

// After:
const trimmed = str.trim();
if (/^\/uploads\/[\w\-]+\.(jpg|jpeg|png|gif|webp|svg)$/i.test(trimmed)) {
  // Sticker files live under uploads/stickers/ — render with sticker-img class
  const isSticker = /^\/uploads\/stickers\/[\w\-.]+\.(jpg|jpeg|png|gif|webp|svg)$/i.test(trimmed);
  const cls = isSticker ? 'sticker-img' : 'chat-image';
  return `<img src="${this._escapeHtml(trimmed)}" class="${cls}" alt="${isSticker ? 'sticker' : 'image'}">`;
}
```

The sticker path regex must match exactly `uploads/stickers/<filename>` (one level deep) to prevent path traversal confusion.

---

## Part 9 — CSS

**File**: `public/css/style.css`

```css
/* Sticker messages — larger than regular images, transparent bg, centered */
.sticker-img {
  display: block;
  max-width: 200px;
  max-height: 200px;
  width: auto;
  height: auto;
  margin: 4px 0;
  border-radius: 4px;
  cursor: default;
}

/* Sticker picker grid cells */
.sticker-picker-thumb {
  width: 72px;
  height: 72px;
  object-fit: contain;
  border-radius: 6px;
  background: rgba(255,255,255,0.05);
}

/* Pack filter row in sticker tab */
.sticker-pack-row {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 4px 8px;
}
.sticker-pack-btn {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: transparent;
  cursor: pointer;
  color: var(--text-muted);
}
.sticker-pack-btn.active {
  background: var(--accent);
  color: #fff;
  border-color: var(--accent);
}
```

---

## Part 10 — Admin Panel UI

**File**: `public/app.html`

Add a "Sticker Manager" section to the admin settings, modeled after the emoji modal. It can either be a separate modal (`id="sticker-modal"`) or a new section within the existing emoji modal with a tab toggle ("Emojis | Stickers").

Recommend: separate section in the Emojis settings panel (same sidebar tab, new card below).

Elements needed:
- `open-sticker-manager-btn` — button to open the sticker modal
- `sticker-modal` — modal overlay  
- `sticker-name-input` — name text field
- `sticker-pack-input` — pack name text field (default "General")
- `sticker-file-input` — file picker
- `sticker-upload-btn` — upload button
- `stickers-list` — container for the rendered sticker list

**File**: `public/js/modules/app-media.js`

New method `_setupStickerManagement()` (parallel to `_setupEmojiManagement`):
- Opens/closes the sticker modal
- Handles file selection (no cropper — stickers are allowed at their natural aspect ratio)
- Max size check (use `max_emoji_kb` setting or a separate TBD setting)
- POSTs to `/api/upload-sticker`
- Calls `_loadStickers()` after upload/delete
- `_renderStickerList(stickers)` — renders a list with thumbnail, name/pack, delete button

Call `_setupStickerManagement()` at the end of the emoji setup block.

---

## Part 11 — i18n Keys

**File**: `public/locales/en.json` (and mirror in other locale files)

```json
"stickers": {
  "tab_label": "Stickers",
  "no_stickers": "No stickers uploaded yet",
  "pack_all": "All",
  "search_placeholder": "Search stickers...",
  "send": "Send sticker"
},
"settings": {
  "admin": {
    "manage_stickers_btn": "Manage Stickers"
  }
}
```

---

## Part 12 — Service Worker Cache Bust

**File**: `public/sw.js`

The sticker picker tab and new CSS/JS are incremental changes to existing cached files. The SW version string should be bumped as part of the release so browsers pick up the new picker tab.

---

## Execution Order

1. Database migration (`src/database.js`)
2. Server routes (`server.js`) + `uploads/stickers/` directory creation
3. Client state init (`app.js`)
4. `_loadStickers()` + app init call (`app-media.js`)
5. `_sendStickerMessage()` + `_emojiPickerContext` tracking (`app-utilities.js`, `app-ui.js`)
6. Sticker tab in emoji picker (`app-utilities.js`)
7. Message rendering (`app-utilities.js` — `_renderMessageContent`)
8. CSS (`style.css`)
9. Admin UI (`app.html`, `app-media.js` — `_setupStickerManagement`)
10. i18n keys (`locales/*.json`)
11. CHANGELOG + version bump (`package.json`, `CHANGELOG.md`)

---

## Out of Scope (Follow-up candidates)

- User-contributed sticker packs (packs from other users' servers — requires pack import/export)
- Per-user favorite stickers
- Sticker search via GIPHY-style external provider
- Animated sticker support (APNG / WEBP animated) — already works implicitly since we serve the file as-is
- `manage_stickers` as a separate permission key (currently piggybacks on `manage_emojis`)
