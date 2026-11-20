# navidrome-automatic-rating-plugin v0.5.0

The plugin now uses its repository name in Navidrome and in its logs. New downloads are named `navidrome-automatic-rating-plugin.ndp`.

## Existing installations

**Keep your installed filename and plugin storage.** Verify the new download's checksum first, then rename it to your existing installed filename (usually `automatic-ratings.ndp`) and replace that package. Restart Navidrome after replacing it.

Do not install both filenames. Navidrome uses the filename as the plugin ID; changing it creates a separate installation with separate settings, grants, and rating-ownership records.

The displayed name will become `navidrome-automatic-rating-plugin` even when you retain the original installed filename. Storage keys, settings, and ownership records remain compatible.

## Changes

- Rename the plugin's manifest/display name and log prefix to `navidrome-automatic-rating-plugin`.
- Rename the release package and checksum to `navidrome-automatic-rating-plugin.ndp` and `navidrome-automatic-rating-plugin.ndp.sha256`.
- Update downloads, build/release workflows, and documentation to use the new name.
- Keep the offline audit verifier compatible with both new logs and older `Automatic Ratings:` logs.
- Validate fresh installation under the new filename and an in-place upgrade from v0.4.1 under the original filename.

Rating calculations, configuration defaults, permissions, and the General, Albums, Artists, and Extra settings layout are unchanged.

## Validation

120 source tests, compiled-WASM smoke checks, package integrity/checksum verification, and isolated official Navidrome 0.64.2 tests using fictional users and music. Integration covers the new filename, legacy-filename upgrades, live settings saves, scan requests, rating ownership, pending recovery, manual overrides, clearing, and song/file isolation.

Requires Navidrome 0.64.2 or newer with native plugins enabled. No production library was used.
