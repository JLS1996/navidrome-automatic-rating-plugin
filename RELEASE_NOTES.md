# Automatic Ratings v0.4.0

Request a scan by flipping the switch either way and saving. No reset step or Navidrome restart is needed.

## Changes

- Rename the manual control to **Toggle to request a scan**. Both off → on and on → off request one scan; requests during an active scan join it.
- Capture requests during plugin initialization after a settings save, as well as on worker ticks, so rapid saves cannot hide a switch change.
- Remember the consumed position across reloads and restarts. Saving the same position does not repeat a scan; the default off position does not start a fresh installation.
- Reject malformed persisted manual-request state instead of interpreting it as a new request.
- Correct the earlier restart instructions. The official Navidrome 0.64.2 binary successfully reloads this plugin after settings and permission saves. The v0.3.1 package also passed live settings-save tests; a general host restart requirement was not supported by those checks.
- Keep the README short and put detailed behavior, upgrade notes, and troubleshooting in the operations guide.

## Upgrade

Download `automatic-ratings.ndp` and its SHA-256 checksum from this release. Replace the existing package, keep the filename and plugin storage, and follow the upgrade instructions in the operations guide. Existing settings and ownership records remain compatible.

**Behavior change:** if the scan switch is currently on, switching it off now requests a scan too. Flip it only when you want a scan. Song ratings, calculation defaults, and music files are unchanged.

Requires Navidrome 0.64.2 or newer with native plugins enabled.

## Validation

- 120 source tests, including both switch directions, rapid reloads, active-run coalescing, no replay after restart, and malformed request state.
- Compiled-WASM smoke tests, native scaling/write benchmarks, package integrity, and SHA-256 verification.
- Isolated official Navidrome 0.64.2 integration using fictional users and music: authenticated live settings/permission saves, repeated scans in both directions, unchanged-save/restart checks, migration, adoption, recovery, manual overrides, clears, zero weights, and song/file isolation.

No production library was used.
