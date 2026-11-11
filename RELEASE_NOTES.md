# Automatic Ratings v0.1.0 — prototype

Initial combined plugin: calculate album and artist ratings independently from each user's song ratings. Song ratings and music files remain read-only.

- Choose album-artist attribution (default) or structured performing-artist credits, including collaborations.
- Independently enable outputs and configure quotas, minimum samples, weights, preservation/replacement, and clearing.
- Preserve pre-existing ratings and detected manual overrides while refreshing this plugin's own output. Explicit replacement adopts matching results and validates changes before overwriting; there is no initial wipe.
- Dry-run by default. Use stable JSON item events and compact per-user/run summaries with distributions and clear-path accounting. Detailed item events default to debug.
- Intersect plugin library grants with each user's accessible libraries. Warn about empty scopes and inventories.
- Revalidate source inventories and song/artist-credit snapshots before artist updates; incomplete sources defer artist writes.
- Persist checkpoints, ownership and write intents; verify rating writes and recover interrupted operations. Serialize scheduler workers and support daily and latched manual requests.
- Include grouped configuration UI, a repository website link, pinned CI toolchains, compiled-WASM smoke tests, and installable packages/checksums.

## Install safely

This combined plugin has not yet been validated on a real Navidrome server. Automated tests and compiled-WASM smoke tests use simulated host functions and fictional data. Keep `dry_run=true`, grant users **and libraries**, and review the summaries before enabling writes. Disable older album/artist rating plugins before allowing this plugin to write.

Restart Navidrome after installation. Some versions also require a server/container restart after configuration/grant edits because plugins are unloaded without reinitialization. See [README.md](README.md) for manual-trigger rearming, migration, counter meanings, storage limits, and ownership limitations.
