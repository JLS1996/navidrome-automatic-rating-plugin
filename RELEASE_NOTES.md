# Automatic Ratings v0.1.2 — safe unrated-user skips and independent verification

A wholly unrated user can now skip per-album and per-artist evaluations after validated paginated song/artist reads, a rechecked album inventory, and ownership/target checks. Missing or changing data falls back to the full scan. Any enabled-output ownership history also forces a full scan so manual overrides, interrupted writes, and eligible clears retain their existing protections.

- Add `skip_unrated_users=true` by default, explicit skipped-user summaries, `usersSkipped`, and bulk-read diagnostics. Skipped users have zero processed items; reconciliation identities remain valid.
- Fix fractional-weight half-star rounding. For example, weights 1.1 and 3.3 on 1-star and 3-star songs produce exactly 2.5 → 3. Exact ratios distinguish ties from nearby values without an arbitrary epsilon. Default integer-weight calculations retain their results.
- Add optional `audit_logging=false` and an offline verifier. Audit mode captures normalized settings, raw structured album/song artist IDs and song ratings, and item outcomes. The standalone Python verifier independently reconstructs attribution, quotas, scores, targets, and summary counts using exact fractions.
- Report current and peak snapshot sizes plus the conservative reservation peak and capacity limit. A small completed checkpoint does not represent peak active storage. Document that full snapshots still grow and large-library runtime is not guaranteed to scale linearly.
- Keep detailed logging at debug by default and preserve the existing item-event schema. Public examples and tests use fictional data.

## Upgrade and preview

Replace the package and restart Navidrome. Partial checkpoints from 0.1.0/0.1.1 are discarded; ownership records remain. Request a fresh dry run, rearming a previously latched `run_now` if needed. Configuration edits on Navidrome 0.64.2 can require another server/container restart.

Leave `dry_run=true` for the first run. Use `skip_unrated_users=false` if you need every user's per-item outcomes. For an independent calculation check, enable `audit_logging=true`, capture one complete uninterrupted run, and execute `python3 scripts/verify-audit.py /path/to/local-audit.log`. Audit mode uses full scans and emits private source evidence at info level; keep that log local and disable audit logging afterward.

This is a prerelease. Earlier versions were installation-tested in dry-run mode on Navidrome 0.64.2; real-server write validation remains outstanding. Automated tests and native-WASM checks exercise writes, clears, ownership, and the new fast-path fallbacks against fictional in-memory data.
