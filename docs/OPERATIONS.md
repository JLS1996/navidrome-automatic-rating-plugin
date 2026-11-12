# Operations guide

[README](../README.md) · [Configuration](CONFIGURATION.md) · [Technical reference](REFERENCE.md)

Manage installation, upgrades, migrations, manual runs, and results. For first-time setup, start with the [README](../README.md#installation).

## Verify a download

Download `automatic-ratings.ndp` and `automatic-ratings.ndp.sha256` from the same [release](https://github.com/JLS1996/navidrome-automatic-rating-plugin/releases/latest). In the download directory, run:

```bash
sha256sum -c automatic-ratings.ndp.sha256
```

The result should be `automatic-ratings.ndp: OK`.

## Apply settings and permissions

Grant the intended **users and libraries** in Navidrome's plugin page. Each user's inputs are limited to libraries allowed by both the plugin grant and their own access. Empty grants do not mean unrestricted access.

On **Navidrome 0.64.2**, restart the server/container after settings or grant edits. These edits can unload the plugin without restarting its callbacks. Confirm an `enabled` log event; disabling and re-enabling the plugin may not restore them.

Changing calculation settings or `dry_run` cancels an active run. Save the new settings, apply them with a restart where required, then [request another run](#schedule-and-manual-runs). Changing `dry_run` alone does not rearm `run_now`.

## Validation status

**[v0.2.0](https://github.com/JLS1996/navidrome-automatic-rating-plugin/releases/tag/v0.2.0) is the first regular release.** Production use on Navidrome 0.64.2 has verified album/artist writes, configured coverage thresholds, and adoption of matching existing ratings, with song ratings untouched. Automated tests also cover clears, manual overrides, recovery, performing-artist attribution, and repeat runs without rating or timestamp changes.

**v0.3.0 adds optional zero weights.** Compiled tests and the isolated Navidrome fixture cover independent exclusions, retaining existing ratings when every rated song is excluded, and clearing genuinely unrated outputs. Existing configurations keep their defaults. Keep plugin storage during upgrades and request a fresh run after applying weight changes.

## Migrating from another ratings plugin

Ratings from another plugin start as unmanaged, so **preserve** keeps them. To adopt or regenerate them, choose **replace for the selected output** and run it once with writes enabled. Return to **preserve** afterward if you want later manual edits protected. Adopted ratings continue updating under preserve. Clearing rules also apply during migration; see the [first-run guidance](../README.md#before-you-start) before switching policies.

### Ownership and upgrades

When upgrading, replace the `.ndp` package, keep its filename/ID and plugin storage, and restart Navidrome. This preserves the records used to recognize generated ratings and manual overrides. Upgrading from 0.1.0/0.1.1 resets partial scans; request a fresh run.

Ownership is best-effort: edits to exactly the generated value, or edits away and back between scans, cannot be detected. Dry runs change neither ratings nor ownership records.

## Schedule and manual runs

Use `run_now` for a one-off request without changing the daily schedule. Set the daily start time with `run_time_utc` in **UTC**; see the [schedule settings](CONFIGURATION.md#schedule).

Leaving `run_now=true` does **not** repeat the request, including after restart. To request another run:

1. Save `run_now=false`; restart Navidrome if required to apply the edit.
2. Let at least one worker tick observe false—10 seconds with the default interval.
3. Save `run_now=true` and restart again where required.

Requests during an active run join that run rather than starting another. Saved progress normally resumes after restart; changes to calculation/safety settings or user/library access cancel the partial run. Request a fresh run after such changes. A daily event missed while the server is offline is not automatically made up.

## Monitoring and results

Summaries and `run_progress` stay at info level. Use them to watch a run; `runPreflightSongs` counts bulk song rows read across the run, while `userPreflightSongs` covers the current user. Temporarily use `detail_logging=info` for individual decisions; it can generate large logs.

In a dry run, `updated` counts proposed changes; with writes enabled, it counts verified rating writes. `unchanged` counts matching results; `adopted` is the subset newly taken into management. `preserved` counts protected ratings. `ratingCounts` describes changes from 0 through 5 (0 means clears), rather than all stored ratings. `usersSkipped` counts users with no item evaluations. See the [technical reference](REFERENCE.md#logs-and-counters) for storage metrics and counter identities.

Ratings reflect their **source read time**, not one frozen database state at run completion. An active library scan or incomplete/changing source can defer updates; review failures and request a new run after the source is stable. Include the full intended library scope when comparing artist totals.

When [zero weights](CONFIGURATION.md#exclude-a-star-level) are configured, item logs show `excludedSongs`, `eligibleSongs`, and `contributingRatedSongs` alongside the original source counts. `skip_excluded` means every rated song was excluded: the existing rating is retained and the item counts as `empty`, with no quota failure. Genuinely unrated items still follow the clearing policy; partially contributing items must still meet coverage.

### Check a repeat run

After a successful live run, request another with the same song/target ratings, catalogue, settings, and plugin storage. Expect `updated=0`, `adopted=0`, and all-zero `ratingCounts`; database ratings and `rated_at` timestamps should stay unchanged. Matching owned items count as `unchanged`; preserved and below-quota outcomes can remain. Rearm `run_now` as described [above](#schedule-and-manual-runs).

### Independently verify a calculation

Set **`audit_logging=true`**, apply settings/restart, and request a fresh dry run. **`detail_logging=info` alone does not enable audits.** Startup and summaries show `auditLogging`. Audit mode bypasses the unrated-user precheck (`preflightSongs:0`) and fully scans every user. It logs settings, song ratings/structured credits, and outcomes at info level; runtime and log volume can grow substantially with users and songs. Keep it off for daily use.

Capture **one complete, uninterrupted run**, from `run_started` through `run_summary`, then run the verifier from the repository root:

```bash
python3 scripts/verify-audit.py /path/to/local-audit.log
# Explain one artist, using an ID and username from your log:
python3 scripts/verify-audit.py /path/to/local-audit.log --explain-artist ARTIST_ID --user USERNAME
```

The standard-library verifier checks the whole run using exact fractions, including zero-weight exclusions. Missing evidence or a mismatch fails with a nonzero exit code. Artist explanations list per-album song IDs, credits, raw histograms, filtered coverage counts, quotas, and scores; omit `--user` to explain all matching users. Excluded songs remain visible in the evidence. Checks use captured read-time data, not later database contents or ownership provenance.

Audit logs contain private user identifiers, song IDs, and credit relationships. Keep them local and turn audit logging off afterward, restarting Navidrome where required.
