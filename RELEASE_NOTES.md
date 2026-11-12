# Automatic Ratings v0.2.0 — first regular release

Download the ready-to-install [automatic-ratings.ndp](https://github.com/JLS1996/navidrome-automatic-rating-plugin/releases/download/v0.2.0/automatic-ratings.ndp) and [SHA-256 checksum](https://github.com/JLS1996/navidrome-automatic-rating-plugin/releases/download/v0.2.0/automatic-ratings.ndp.sha256). Verify with `sha256sum -c automatic-ratings.ndp.sha256`, replace the package in Navidrome's plugins directory, and restart. No source build, Node.js, or Python is needed to install it.

Generate per-user album and artist ratings directly from songs, with independent coverage thresholds, weights, preserve/replace policies, and optional clearing. Dry run remains the default. Structured album-artist and performing-artist modes, safe unrated-user skips, resumable checkpoints, ownership/manual-override handling, and independent local audits are included.

## Fixes and validation

- Recheck settings, user/library access, and scan status after persisting a write intent, immediately before the rating API call. Changes during storage now defer that write, retaining its intent for recovery.
- Keep failed and blocked item events visible at error level even with detailed logging off. Artist-only source failures use a source-error event rather than an uncounted album evaluation.
- Test lost ownership finalization, final write guards for both outputs, and refusal to explain failed/blocked audit evaluations.
- Add an automated integration test using the installed package on a real, isolated Navidrome 0.64.2 server with fictional music and users. It exercises audit dry runs, writes, convergence, recovery from a seeded pending intent, manual edits including zero, replace, clears, performing attribution, and song/file isolation. CI checks this before publication alongside unit tests, WASM smoke tests, native scaling/write checks, package contents, and checksum verification.
- Explain audit mode's operating cost: it fully scans every user, bypasses the unrated-user precheck (`preflightSongs:0`), and can substantially increase runtime and private log volume. Keep it off for normal daily runs.

Calculations, defaults, item fields, ownership keys, and the v0.1.2/0.1.3 checkpoint format remain compatible. Existing dry-run calculations have been independently verified on a real library; the new write integration uses a controlled temporary installation, not a production library.

## Apply ratings in your library

1. Back up the Navidrome database and plugin storage; disable older rating plugins. Install the package and restart.
2. Keep the policies and thresholds you previewed. Set `dry_run=false`, `audit_logging=false`, and `detail_logging=debug` for normal operation.
3. Request a fresh run. If `run_now` is already true, first apply false and let one worker tick observe it, then apply true. On Navidrome 0.64.2, restart after each settings/grant edit and confirm an `enabled` event.
4. Check `user_summary` and `run_summary`: updated counts now represent verified writes. Preserve leaves existing ratings from older plugins protected; preview replace for the selected output before using it to adopt or regenerate those values.

Keep the package filename/ID and plugin storage during upgrades so ownership evidence survives. Partial checkpoints from 0.1.0/0.1.1 still require a fresh run. Audit logs and explanations contain private library metadata and should stay local.
