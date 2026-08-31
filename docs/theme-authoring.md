# Theme API v1 authoring reference

Haven themes are ordinary CSS files served by the Haven server. Theme API v1
defines the CSS variables and semantic layout regions that theme authors can
rely on without depending on Haven's internal class names or DOM structure.

Theme API v1 is intentionally a CSS-only contract. It does not expose JavaScript
helpers, events, component internals, or permission APIs. Structural changes
that require moving elements or creating interactive controls belong in a
plugin, not a theme.

## Theme file format

A theme filename must end in `.theme.css` and should begin with a metadata
comment:

```css
/**
 * @name My Theme
 * @description A short description.
 * @author YourName
 * @version 1.0
 * @icon M
 * @haven-theme-api 1
 */
```

The current theme list reads `@name`, `@description`, `@author`, `@version`, and
`@icon`. The `@haven-theme-api` declaration records the contract targeted by
the theme. Compatibility enforcement is not part of Theme API v1 itself and is
planned separately; older Haven versions simply ignore unknown metadata.

Use a short text character or emoji for `@icon`. Do not put HTML in metadata.

## Installing and publishing

1. Put the file in the server's `themes/` directory.
2. Restart Haven or refresh the Plugins & Themes list.
3. Open Settings, then Admin, Branding, Custom Themes.
4. Publish the theme to add it to every user's theme picker.

A published file is a selectable base theme. Haven applies the built-in Haven
theme as the stable layout base, then loads the selected file after the core
stylesheet. A file that is installed but not published can instead be enabled
per browser as an additive CSS tweak from Plugins & Themes.

Themes are server-managed files. Haven does not download themes from arbitrary
URLs or provide a per-user raw CSS editor.

## Scoping a theme

Both the login page and the main application expose the API version:

```css
html[data-haven-theme-api="1"] {
  /* Theme API v1 rules */
}
```

Use the page marker when a rule belongs to only one page:

```css
[data-haven-page="app"] {
  /* Main application only */
}

[data-haven-page="auth"] {
  /* Login and registration only */
}
```

## Public design tokens

Override public tokens on `:root`. All tokens are optional; omitted values come
from the Haven base theme.

### Backgrounds

| Token | Purpose |
| --- | --- |
| `--bg-primary` | Main content background |
| `--bg-secondary` | Sidebars and primary panels |
| `--bg-tertiary` | Nested panels and controls |
| `--bg-hover` | Hovered controls and rows |
| `--bg-active` | Selected controls and rows |
| `--bg-input` | Text inputs and editors |
| `--bg-card` | Cards, messages, and modal surfaces |

### Accent and text

| Token | Purpose |
| --- | --- |
| `--accent` | Primary accent colour |
| `--accent-hover` | Hovered accent controls |
| `--accent-glow` | Accent shadow or glow colour |
| `--accent-text` | Preferred foreground for core accent controls |
| `--text-primary` | Primary text |
| `--text-secondary` | Secondary text and timestamps |
| `--text-muted` | Hints, placeholders, and quiet labels |
| `--text-link` | Links |

Always check the contrast between `--accent` and `--accent-text`. A light accent
usually needs dark accent text. Some specialised media and voice controls still
define their own foreground colours, so verify those surfaces as well.

### Borders and semantic states

| Token | Purpose |
| --- | --- |
| `--border` | Default border |
| `--border-light` | Stronger or raised border |
| `--success` | Positive and connected states |
| `--danger` | Destructive and error states |
| `--warning` | Warning states |
| `--led-on` | Connected presence indicator |
| `--led-off` | Disconnected presence indicator |
| `--led-glow` | Connected indicator glow |

### Typography and geometry

| Token | Purpose |
| --- | --- |
| `--font-main` | Main interface font stack |
| `--font-mono` | Codes and technical values |
| `--font-heading` | Headings and display labels |
| `--radius` | Default radius |
| `--radius-sm` | Compact control radius |
| `--transition` | Standard transition timing |
| `--sidebar-width` | Navigation sidebar width |
| `--right-width` | Context sidebar width |

Use `rem` for dimensions. Haven's interface zoom changes the root font size, so
pixel-based shell dimensions do not scale with the rest of the interface.

### Decorative tokens

| Token | Purpose |
| --- | --- |
| `--msg-glow` | Optional message hover glow |
| `--scanline` | Optional scanline overlay value |

### Internal values

Message geometry properties such as `--msg-pad-x`, `--msg-pad-y`,
`--msg-avatar`, `--msg-gap`, and `--msg-gutter` are not part of Theme API v1.
Haven changes them for density preferences and responsive breakpoints, and file
themes load after those core rules. Treating them as unconditional theme tokens
would override the user's density and mobile geometry. They may be formalised in
a later API after the related state has a stable pre-paint contract.

## Public layout regions

Select major areas through `data-haven-region`:

```css
[data-haven-region="navigation-sidebar"] {
  background: var(--bg-secondary);
}
```

### Application regions

| Region | Purpose |
| --- | --- |
| `app-shell` | Primary application shell, including the status bar |
| `workspace` | Main multi-column workspace |
| `server-rail` | Server navigation rail |
| `navigation-sidebar` | Channels and direct-message sidebar |
| `account` | Current account identity and account actions |
| `sidebar-content` | Reorderable sidebar content |
| `join-channel` | Join-channel section |
| `create-channel` | Create-channel section |
| `channels` | Channel list section |
| `direct-messages` | Direct-message list section |
| `sidebar-footer` | Pinned sidebar footer and controls |
| `theme-picker` | Theme selector |
| `main` | Main content column |
| `channel-header` | Active channel header |
| `welcome` | No-channel welcome state |
| `message-area` | Active chat area |
| `webcams` | Webcam viewer |
| `screen-shares` | Screen-share viewer |
| `music-player` | Listen Together player |
| `pinned-messages` | Docked pinned-message panel |
| `message-list` | Scrollable message list |
| `composer` | Message composer |
| `soundboard` | Docked soundboard panel |
| `context-sidebar` | Voice and member context sidebar |
| `search-results` | Docked search-results panel |
| `voice-roster` | Current voice participant list |
| `member-list` | Current channel member list |
| `voice-settings` | Voice device and quality settings |
| `voice-controls` | Active call controls |
| `status-bar` | Debug and connection status bar |
| `thread-panel` | Thread conversation panel |
| `settings` | Settings surface |

### Authentication regions

| Region | Purpose |
| --- | --- |
| `auth-shell` | Authentication page layout |
| `auth-card` | Login and registration card |
| `auth-header` | Authentication branding header |
| `theme-picker` | Authentication theme selector |

`theme-picker` exists on both pages, but only one page is loaded in a document.

## Stability policy

For Theme API v1, Haven intends to keep these stable:

- `data-haven-theme-api="1"`
- `data-haven-page` values
- documented `data-haven-region` values
- documented public design tokens

The following are not part of Theme API v1:

- element IDs and class names
- exact DOM nesting or sibling order
- inline styles used to represent runtime state
- dynamically generated message, channel, member, and modal internals
- undocumented custom properties
- plugin APIs or JavaScript objects

A region keeps its semantic responsibility, but Haven may change its element
type, class, ID, children, or location. Write selectors against the region and
avoid depending on its internal descendants when possible.

## Responsive layout

Haven's core breakpoints are:

- above `900px`: full desktop shell
- `769px` through `900px`: tablet layout with an overlay context sidebar
- `768px` and below: mobile overlay navigation and context sidebars
- `480px` and below: phone sizing

Restrict deep desktop layout changes to the full desktop shell unless the theme
also implements and tests the tablet and mobile states:

```css
@media (min-width: 901px) {
  [data-haven-region="navigation-sidebar"] {
    width: 15rem;
  }

  [data-haven-region="context-sidebar"] {
    width: 15rem;
  }
}
```

Do not remove the mobile overlay controls solely because they are hidden on a
desktop screenshot.

## Assets and backgrounds

Assets placed beside a theme are served from `/themes/`. Use a relative path:

```css
[data-haven-region="main"] {
  background-image:
    linear-gradient(rgba(0, 0, 0, 0.55), rgba(0, 0, 0, 0.55)),
    url("wallpaper.jpg");
  background-position: center;
  background-size: cover;
}
```

Keep assets small and provide enough contrast for text. Remote resources expose
members' IP addresses to their hosts and may be blocked by Haven's security
policy. Prefer files installed with the theme.

## Motion and accessibility

Respect reduced-motion preferences:

```css
@media (prefers-reduced-motion: reduce) {
  * {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    scroll-behavior: auto !important;
  }
}
```

Keep visible focus states, readable contrast, keyboard access, and touch target
sizes. Hiding a duplicate-looking control is unsafe unless every function it
provides remains reachable elsewhere.

## Theme or plugin?

Use a theme for:

- colour, typography, spacing, radii, and backgrounds
- sizing major regions
- styling or hiding optional decoration
- reordering direct flex or grid children when behavior remains intact

Use a plugin for:

- moving controls between different DOM parents
- creating menus, buttons, or interactive state
- preserving access to actions removed from persistent chrome
- reacting to voice, channel, media, or permission changes
- restoring changed DOM when the customization is disabled

CSS can visually position an element outside its parent, but that does not move
its semantics, clipping context, keyboard order, or event assumptions. Prefer a
reversible plugin when a layout requires a real structural move.

## Security

Themes are trusted server-managed CSS. CSS cannot use Haven's JavaScript API,
but it can hide or imitate interface elements and can request external assets.
Only install themes from sources you trust.

Plugins have a different security model: they execute JavaScript in the Haven
page and are fully trusted code. Theme API v1 does not make plugins safe or
sandbox them.

## Minimal complete example

```css
/**
 * @name Calm Slate
 * @description A small Theme API v1 example.
 * @author Example
 * @version 1.0
 * @icon S
 * @haven-theme-api 1
 */

:root {
  --bg-primary: #202225;
  --bg-secondary: #17191c;
  --bg-tertiary: #292c30;
  --bg-hover: #33373d;
  --bg-active: #3c4249;
  --bg-input: #111315;
  --bg-card: #24272b;
  --accent: #7aa2f7;
  --accent-hover: #8fb1fa;
  --accent-glow: rgba(122, 162, 247, 0.25);
  --accent-text: #101216;
  --text-primary: #f0f1f3;
  --text-secondary: #b3b7bd;
  --text-muted: #7f858e;
  --text-link: #8ab4f8;
  --border: #34383e;
  --border-light: #454a52;
}

@media (min-width: 901px) {
  [data-haven-region="navigation-sidebar"] {
    width: 15rem;
  }
}
```

For a commented template containing every public token, copy
`themes/custom.css.example`.
