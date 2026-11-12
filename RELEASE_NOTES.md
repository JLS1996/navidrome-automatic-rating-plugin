# Automatic Ratings v0.3.1

Safer rating updates and clearer settings in Navidrome, with a reorganized README and setup guides.

## Fixes

- Recheck ratings after saving a write intent so manual edits made during preparation are deferred instead of overwritten. Album updates also recheck their source songs.
- Restore ownership when no rating write was attempted, preventing a later matching manual rating from being mistaken for plugin output. Attempted but unverified writes keep their recovery intent.
- Preserve scan progress when checkpoint storage is temporarily unreadable.
- Keep metrics-save failures from interrupting scans or preventing capacity cancellation.
- Correct percentage-quota rounding for very large song counts.

## Settings and documentation

- Add spacing and clear sections for outputs, artist credits, coverage, policies, weights, performance, and logging.
- Show readable dropdown choices and visible help for checkboxes in Navidrome 0.64.2.
- Simplify installation instructions and consolidate first-run guidance into one prominent README callout.
- Add an [audit report](https://github.com/JLS1996/navidrome-automatic-rating-plugin/blob/v0.3.1/docs/AUDIT.md) with findings, remaining limitations, and feature recommendations. Proposed features are not implemented.

## Download and upgrade

Download [automatic-ratings.ndp](https://github.com/JLS1996/navidrome-automatic-rating-plugin/releases/download/v0.3.1/automatic-ratings.ndp) and its [SHA-256 checksum](https://github.com/JLS1996/navidrome-automatic-rating-plugin/releases/download/v0.3.1/automatic-ratings.ndp.sha256). Verify them in the download directory:

```bash
sha256sum -c automatic-ratings.ndp.sha256
```

Replace the existing package, keeping the filename and plugin storage, then restart Navidrome. On Navidrome 0.64.2, restart after settings or permission edits as well. Existing settings, defaults, permissions, and ownership records remain compatible. Song ratings and music files stay unchanged.

Requires **Navidrome 0.64.2 or newer** with native plugins enabled. For setup and usage, see the [README](https://github.com/JLS1996/navidrome-automatic-rating-plugin/blob/v0.3.1/README.md).

## Validation

117 source tests, compiled WASM smoke tests, native scaling/write checks, package integrity, and isolated Navidrome 0.64.2 integration. The integration fixture uses fictional users and music and checks migration, adoption, recovery, manual overrides, clears, zero-weight exclusions, repeat-run convergence, and unchanged songs/files.
