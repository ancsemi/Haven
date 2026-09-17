# Extension updates

Haven can update plugins and themes from public GitHub releases. Updates are
manual and administrator-only: Haven does not poll repositories or install an
extension in the background.

Extensions without update metadata continue to load normally, but Haven does
not check them for updates.

## Updating an extension

Open **Settings → Admin → Extension Updates** and select **Check for updates**.
Haven checks the repositories declared by the installed extensions and lists
newer compatible versions.

Before making a change, Haven shows the repository, installed and proposed
versions, the GitHub release notes, and a security warning. Release notes are
shown as escaped plain text. Select **I understand, update** to continue.

Haven checks that:

- the current user is still an administrator;
- the release is published, immutable, and not a prerelease;
- the installed file has not changed since the update check;
- the version is not on Haven's security blocklist;
- the downloaded file has the SHA-256 checksum declared by its manifest; and
- the downloaded metadata matches the installed extension and repository.

The existing file remains in place if any check fails. After a successful
update, Haven keeps the previous file for rollback and asks connected users to
reload.

## Rolling back

When a previous version is available, an administrator can review and restore
it from the same settings page. Rollback uses the same administrator,
blocklist, local-file, and atomic-replacement checks as an update.

A backup is only offered on the Haven version where it was created. Restore an
extension manually after upgrading Haven if its saved version is no longer
eligible for rollback. A version listed on the security blocklist cannot be
restored.

## Extension maintainer guide

An updateable extension needs metadata in its source file and a matching
`haven-release.json` asset in each GitHub release. Haven downloads the
`.plugin.js` or `.theme.css` file directly; do not package it in an archive or
use an install script.

### Add update metadata

Add `@id`, `@version`, and `@update-repo` to the extension's leading comment
block:

```js
/**
 * @name Example Layout
 * @id org.example.layout
 * @version 1.1.0
 * @update-repo example-owner/haven-extensions
 */
```

| Field | Requirement |
| --- | --- |
| `@id` | A stable, case-sensitive identifier containing lowercase letters, digits, dots, underscores, or hyphens. It must start with a letter or digit and cannot exceed 128 characters. |
| `@version` | A complete, stable semantic version such as `1.1.0`. Prerelease versions are not supported. |
| `@update-repo` | The public GitHub `owner/repository` containing the releases. Do not use a URL. |

Keep the ID and repository unchanged in future builds. Haven rejects a download
that changes either value. Keep the extension filename stable as well, because
Haven replaces the installed file without changing its name.

### Build the release asset

Produce a single `.plugin.js` file for a plugin or `.theme.css` file for a
theme. The built file must contain the same ID, version, and repository as its
metadata and the release manifest.

Calculate SHA-256 from the exact bytes that will be uploaded. For example:

```sh
shasum -a 256 ExampleLayout.plugin.js
```

Do not modify or regenerate the asset after calculating the checksum.

### Create `haven-release.json`

Add one entry for each extension shipped by the release:

```json
{
  "schemaVersion": 1,
  "extensions": [
    {
      "id": "org.example.layout",
      "type": "plugin",
      "version": "1.1.0",
      "requires": { "haven": ">=4.5.0 <5.0.0" },
      "asset": "ExampleLayout.plugin.js",
      "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    }
  ]
}
```

| Field | Requirement |
| --- | --- |
| `schemaVersion` | The integer `1`. |
| `extensions` | A nonempty array containing no more than 100 entries. Each ID can occur once. |
| `id` | The exact `@id` from the extension file. |
| `type` | `plugin` or `theme`. |
| `version` | The exact stable semantic version from the extension file. |
| `requires.haven` | A semantic-version range describing the Haven versions tested with this build. |
| `asset` | The exact release asset basename. It must end in `.plugin.js` for a plugin or `.theme.css` for a theme. Paths and URLs are rejected. |
| `sha256` | The lowercase, 64-character SHA-256 digest of the raw extension asset. |

The release tag does not have to match the extension version. A repository may
publish several extensions in one release, and each entry may have its own
version and compatibility range. See the complete
[release manifest example](examples/extension-updates/haven-release.json).

### Publish the GitHub release

1. Create a release in the public repository named by `@update-repo`.
2. Upload `haven-release.json` and every extension file named in the manifest
   as release assets.
3. Add release notes. Haven shows the GitHub release body as plain text when an
   administrator reviews the update.
4. Publish the release as a normal release, not a draft or prerelease.
5. Make the release immutable in the repository's GitHub settings.

Haven ignores a release until all of these conditions are satisfied. It checks
published releases and chooses the highest newer compatible extension version,
so the GitHub “latest” release does not need to support every Haven version.

Treat a published asset and manifest as permanent. Publish a new immutable
release for corrections instead of replacing an existing asset.

### Test a release

Install the extension file in Haven's normal `plugins/` or `themes/` directory,
then open **Settings → Admin → Extension Updates** and run a check. Confirm that Haven finds the
expected version, displays the repository and release notes, installs the file,
and offers the previous version for rollback.

If Haven reports a checksum mismatch, calculate the digest from the uploaded
release asset and compare it with `sha256` in `haven-release.json`. Metadata
errors usually mean the ID, version, repository, asset name, extension type, or
Haven compatibility range differs between the installed file, downloaded file,
and manifest.

## Security blocklist

Haven reads its blocklist from
`https://ancsemi.github.io/Haven/blocklist.json` before checking, installing,
or rolling back an extension. Each entry identifies a repository, extension ID,
exact versions, and a reason:

```json
{
  "schemaVersion": 1,
  "updatedAt": "2026-09-08T00:00:00Z",
  "blocked": [
    {
      "repo": "example-owner/haven-extensions",
      "id": "org.example.layout",
      "versions": ["1.0.1"],
      "reason": "This release has been withdrawn by its publisher."
    }
  ]
}
```

Repository matching is case-insensitive; IDs and versions are exact. Haven
warns administrators when an installed version is listed and prevents listed
versions from being installed or restored. It does not silently disable an
extension that is already running.

If the blocklist is unavailable or malformed, existing extensions continue to
run, but Haven prevents updates and rollbacks until it can complete a fresh
security check. See the [blocklist example](examples/extension-updates/blocklist.json).

## Deployment notes

Updater state, backups, and the recovery journal are stored under
`HAVEN_DATA_DIR/extension-updates`. Plugin and theme files remain in Haven's
existing `plugins/` and `themes/` directories. Container deployments must keep
these locations writable and persistent. Back up the extension directories and
updater state together.

Run one Haven process against these directories. The updater serializes work
inside one process but does not coordinate multiple Haven processes sharing the
same storage.

Update offers belong to the administrator who checked and expire after ten
minutes. A new check or successful replacement invalidates earlier offers.
Local edits and source changes are reported as conflicts and are never
overwritten automatically.

Downloads use HTTPS and approved public GitHub hosts without credentials.
Requests have time and size limits. Haven caps the blocklist at 1 MiB, GitHub
JSON responses at 2 MiB, and extension assets at 5 MiB. It checks at most five
pages of releases and 30 manifests per repository. An incomplete check is
reported as an error rather than “up to date.”
