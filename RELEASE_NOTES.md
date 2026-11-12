# Automatic Ratings v0.1.3 — explain artist calculations and clarify progress

Download the ready-to-install [automatic-ratings.ndp](https://github.com/JLS1996/navidrome-automatic-rating-plugin/releases/download/v0.1.3/automatic-ratings.ndp) and [SHA-256 checksum](https://github.com/JLS1996/navidrome-automatic-rating-plugin/releases/download/v0.1.3/automatic-ratings.ndp.sha256). Verify with `sha256sum -c automatic-ratings.ndp.sha256`, copy the package to Navidrome's plugins directory, and restart. Users do not need Node.js, Python, or a source build to install the plugin.

- Explain an artist's result with `python3 scripts/verify-audit.py LOG --explain-artist ARTIST_ID --user USERNAME`. The independent verifier checks the entire audit run before listing per-album songs, structured credits, histograms, coverage, exact scores, and calculated versus proposed ratings. Collaboration songs count once per credited artist, including artists absent from the database's primary album-artist column.
- Make audit mode visible in startup and summaries through `auditLogging` and `auditSourceFormat`. Enable `audit_logging=true` for a fresh audit run; `detail_logging=info` alone records item decisions without source evidence. Audit mode remains off by default.
- Clarify bulk-read progress with `userPreflightSongs`, cumulative `runPreflightSongs`, and `preflightSongsScope`. The existing `preflightSongs` field keeps its previous meaning. Counters measure returned song rows, including preliminary pages discarded when falling back to full scans.
- Put the AI-development notice and direct package downloads near the top of the shorter, settings-focused README. Keep public examples fictional.
- Produce the package checksum during `npm run build`, and verify it in CI before publishing the tested artifacts.

## Upgrade and preview

Calculation results, defaults, item-event fields, ownership records, and the v0.1.2 checkpoint format are unchanged. Saved v0.1.2 runs can resume. Partial checkpoints from 0.1.0/0.1.1 still require a fresh run. On Navidrome 0.64.2, restart after settings or grant changes and confirm an `enabled` event. Rearm an already-latched `run_now` by applying false for one worker tick before setting true again.

Leave `dry_run=true` for the first run. For an independent audit, enable `audit_logging=true`, capture one complete uninterrupted run, and keep the source log and explanations local. Disable audit logging afterward.

This is a prerelease. Versions through 0.1.2 were installation-tested in dry-run mode on Navidrome 0.64.2; real-server write validation remains outstanding. Automated tests and compiled-WASM checks exercise simulated writes, clears, recovery, attribution, and the safe unrated-user shortcut.
