# Extension updates from GitHub Releases (draft)

Proposal for #5578. This document is an early contract review, not an implemented
updater. Existing plugin/theme loading is unchanged.

## First implementation

An administrator explicitly clicks **Check for updates**. Haven checks public
GitHub repositories for installed extensions with update metadata. There is no
background polling or automatic installation. A confirmation shows the repository,
installed and proposed versions, release notes, and the access plugins have inside
Haven. After confirmation, the server verifies the download before replacing the
installed file and keeps the previous version for rollback.

The reusable publishing workflow and a marketplace can follow separately.

## Installed file header

Plugins and themes use their existing comment block, with two additional fields:

```js
/**
 * @name Example Layout
 * @id org.example.layout
 * @version 1.1.0
 * @update-repo example-owner/haven-extensions
 */
```

`id` is a stable, case-sensitive identifier: lowercase letters, digits, dots,
underscores and hyphens, starting with a letter or digit (maximum 128 characters).
`update-repo` is an owner/repository pair on github.com, not an arbitrary URL.
Files without these fields continue to work and have no managed update source.
The first implementation supports stable releases only; no channel field yet.

On first use the admin approves the source, which Haven records alongside the
installed ID, type, filename, version and checksum. A downloaded header cannot
silently change that source or the destination filename. Existing filename-based
preferences and theme publication settings must be preserved.

## Release manifest

Each release includes a UTF-8 JSON asset named `haven-release.json` and the actual
`.plugin.js` and/or `.theme.css` assets. No archives or install scripts are used.
See [the release example](examples/extension-updates/haven-release.json).
The example uses a placeholder all-zero checksum and illustrative compatibility
bounds; publishers must supply the actual file hash and tested version range.

| Field | Meaning |
| --- | --- |
| `schemaVersion` | Integer `1`; reject unsupported schema versions. |
| `extensions` | Nonempty array; each ID occurs at most once. |
| `id` | Matches the installed header ID. |
| `type` | `plugin` or `theme`; must match the installed extension. |
| `version` | Strict stable SemVer, compared semantically rather than lexically. |
| `requires.haven` | SemVer range for the installed Haven version. |
| `asset` | Exact release asset basename, ending in `.plugin.js` or `.theme.css` as appropriate. No slashes, backslashes, traversal, or arbitrary URL. |
| `sha256` | Exactly 64 lowercase hexadecimal characters, hashing the raw asset bytes. |

The repository comes from the approved installed source; release ID, asset ID,
tag, release page and notes come from GitHub. They are not duplicated in the
manifest. Multiple extensions may share a release and have independent versions.
The tag need not equal each extension's version.

Use only published, non-prerelease releases. Inspect manifests to select the
highest newer compatible extension version; GitHub's "latest" release alone may
exclude an older compatible version. Pagination and bounded requests must not
silently turn an incomplete check into "up to date". Reject ambiguous duplicate
asset names and conflicting candidates for the same extension version.

## Confirmation and installation contract

All check, install and rollback operations require server-side admin authorization
against current database permissions. Browser visibility is not authorization.

1. A check returns an offer bound server-side to the installed ID/checksum,
   approved repository, release ID, asset ID, version and expected checksum.
2. Render release notes safely as text or sanitized Markdown. Show the repository
   and link to the release in the confirmation. A checksum proves byte integrity,
   not that a publisher's JavaScript is safe.
3. On confirmation, recheck admin permission, the installed checksum and the
   blocklist. Reject stale offers rather than substituting another release.
4. Download to staging with time and size limits. Restrict GitHub API/download
   destinations and redirects; never accept arbitrary URLs or local/private
   network destinations from manifests. Do not send credentials to download hosts.
5. Verify SHA-256 on the original bytes and check header ID/version/source and file
   type against the offer. Never evaluate downloaded JavaScript on the server.
6. Under an extension-specific lock, preserve the current bytes and metadata
   outside public static directories, then atomically replace the file on the same
   filesystem. Failed validation leaves the current file untouched. Persist a
   recoverable transaction record so a crash cannot mismatch file and version state.
7. Offer users a reload; retain their selections. Use a version/hash cache key so
   reload fetches the replacement. Do not hot-swap running plugin code in this pass.

Rollback restores the saved bytes and metadata using the same lock and atomic
replacement rules. It must check the blocklist too and must not restore a known
blocked release. Local edits cause a conflict instead of being overwritten.
Managed storage must survive container recreation and be writable; unsupported
read-only deployments should get an actionable message.

## Blocklist

Proposed location: `https://ancsemi.github.io/Haven/blocklist.json` (not assumed to
exist yet). See [the blocklist example](examples/extension-updates/blocklist.json).

`schemaVersion` is `1`; `updatedAt` is an RFC 3339 UTC timestamp; `blocked` is an
array. Entries identify an approved `repo`, extension `id`, exact `versions`, and a
human-readable `reason`. Repository matching is case-insensitive; IDs and versions
are exact. Scope by repository as well as ID to avoid unrelated ID collisions.
Version ranges and hash-only indicators can be added later if needed.

Check this list when the admin checks for updates and again before install or
rollback. Warn about affected installed extensions and block affected candidates.
Do not silently disable running extensions. There is no background alerting in
this initial manual-only design.

An unavailable or malformed list is not an empty list. Proposed behavior: keep
existing extensions running, show that the security check is unavailable, and
require a successful refresh before installing or rolling back. This availability
tradeoff needs agreement before implementation. Removing a compromised version
does not undo actions it already performed.

## Questions for this draft

- Does this header and manifest shape fit the existing extension conventions?
- Should immutable releases be mandatory from the start? The initial issue
  discussion suggested them; this draft leaves the decision explicit. Checksums
  remain required either way.
- Is exact-version blocking sufficient initially, and is the proposed behavior
  when the blocklist is unavailable appropriate?

## Follow-up implementation and validation

- Strict manifest/header/blocklist parsing; compatibility and candidate selection.
- Admin-only check endpoint and settings control, then review confirmation.
- Bounded download, checksum verification, transaction storage and rollback.
- Blocklist integration and reload notice without changing user preferences.
- Tests for non-admin requests, malformed metadata, incompatible versions, stale
  offers, checksum mismatch, blocked releases, failed downloads, concurrent
  updates, local modifications and crash recovery.
- Browser verification of check, cancel, install failure, successful update and
  rollback. Shared release Actions workflow only after the updater works.
