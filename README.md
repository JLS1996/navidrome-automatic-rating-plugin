# Automatic Ratings for Navidrome

> **AI notice:** This plugin and its documentation were developed with AI assistance. Review a dry run before enabling writes.

Calculate **album and artist ratings from each user's song ratings**. Choose either output or both, set how many songs must be rated, and decide how to handle existing ratings. Artist scores come directly from songs; album ratings do not influence them. Song ratings and music files remain unchanged.

**Defaults:** both outputs enabled, album-artist attribution, 30% coverage with at least one rated song, preservation of existing ratings, and dry-run mode.

**[v0.2.0](https://github.com/JLS1996/navidrome-automatic-rating-plugin/releases/tag/v0.2.0) is the first regular release.** Production use on Navidrome 0.64.2 has verified album/artist writes, configured coverage thresholds, and adoption of matching existing ratings, with song ratings untouched. Automated tests also cover clears, manual overrides, recovery, performing-artist attribution, and repeat runs without rating or timestamp changes.

## Install and preview

Requires **Navidrome 0.64.2 or newer** with native plugins enabled:

```toml
[Plugins]
Enabled = true
```

1. Download the ready-to-install **[plugin package (.ndp)](https://github.com/JLS1996/navidrome-automatic-rating-plugin/releases/download/v0.2.0/automatic-ratings.ndp)** and [checksum](https://github.com/JLS1996/navidrome-automatic-rating-plugin/releases/download/v0.2.0/automatic-ratings.ndp.sha256). Verify with `sha256sum -c automatic-ratings.ndp.sha256` in the download directory. No source build is needed.
2. Back up the Navidrome database and plugin storage. Copy the package into the plugins directory and rescan plugins, using `navidrome plugin rescan` where supported.
3. Grant the plugin the intended **users and libraries**, then enable **Automatic Ratings**. Each user's inputs are limited to libraries allowed by both the plugin grant and their own access. Empty grants do not mean unrestricted access.
4. Open the plugin settings. Keep `dry_run=true`, choose the settings below, and set `run_now=true`. Save and restart Navidrome where required. Review `user_summary` and `run_summary`; temporarily choose `detail_logging=info` to inspect individual decisions.
5. When the preview matches your intent, disable older rating plugins, set `dry_run=false`, and request a fresh run. Keep the policies you previewed; turn `audit_logging=false` and `detail_logging=debug` for normal use. Changing dry-run mode cancels any active preview. See [running again](#schedule-and-manual-runs) if `run_now` is already true.

**On Navidrome 0.64.2, restart the server/container after settings or grant edits.** These edits can unload the plugin without restarting its callbacks. Confirm an `enabled` log event; disabling and re-enabling the plugin may not restore them.

Installation uses only the `.ndp` package. Node.js and Python are not required on the Navidrome server.

## Choose what to rate

Album and artist settings are independent: choose either output or both, with separate policies, coverage requirements, and weights.

| Setting | Default | What you can change |
|---|---|---|
| `rate_albums` | `true` | Generate album ratings from all songs in each album, including multiple discs. |
| `rate_artists` | `true` | Generate artist ratings from attributed songs across the selected libraries. |
| `artist_attribution` | `album_artist` | Choose album artists or the performing artists credited on each song. |

Disabling an output leaves its ratings in place. Albums and separate editions follow Navidrome's IDs.

For artist attribution, choose:

- **`album_artist`:** every song contributes once to each artist in the album's structured `artists` credits. Use this to rate artists by their album catalogue.
- **`performing_artist`:** each song contributes once to each artist in its structured `artists` credits, including guest-only performers. Composer and instrumental-contributor credits are not automatically included.

Names are never split on punctuation. A four-song album shared by fictional **Aurora Ensemble** and **Cedar Quartet** contributes four songs to each artist's score and coverage denominator. External checks must use **all IDs in `getAlbum.artists`**; the database's single `media_file.album_artist_id` can omit collaborators. The [audit command](#independently-verify-a-calculation) explains each artist's contributing songs.

Artist ratings belong globally to a user and artist; library grants select their inputs. Include the full intended catalogue before replacing an artist's rating.

## Set the coverage requirement

An item qualifies only when **both** its percentage and minimum-count requirements are met. Unrated songs count toward coverage but stay out of the average.

| Setting | Default | Effect |
|---|---|---|
| `album_minimum_rated_percent` | `30` | Percentage of an album's songs that must be rated, from 0 to 100. |
| `artist_minimum_rated_percent` | `30` | Percentage of an artist's attributed songs that must be rated, from 0 to 100. |
| `album_minimum_rated_songs` | `1` | Minimum rated-song count for an album, from 1 to 1,000,000. |
| `artist_minimum_rated_songs` | `1` | Minimum rated-song count for an artist, from 1 to 1,000,000. |

The required count is `max(minimum count, ceil(total songs × percentage / 100))`. A ten-song album at 30% needs three rated songs, or five if you raise its minimum to five. A percentage of 0 still requires the minimum count; a minimum above the total prevents qualification.

For example, these changes generate only artist ratings, include credited guest performers, and require at least half the songs and at least five rated songs:

```json
{
  "rate_albums": false,
  "rate_artists": true,
  "artist_attribution": "performing_artist",
  "artist_minimum_rated_percent": 50,
  "artist_minimum_rated_songs": 5
}
```

Examples show only the settings to change. Keep the other settings at your chosen values, including `dry_run=true` while previewing.

## Choose how much each star rating counts

You can give songs with a particular rating more influence on the result. Weights are separate for albums and artists; each accepts a number from **1 to 10**, including decimals.

| Settings | Defaults for 1★ through 5★ |
|---|---|
| `album_one_star_weight` … `album_five_star_weight` | `1, 2, 3, 4, 5` |
| `artist_one_star_weight` … `artist_five_star_weight` | `1, 2, 3, 4, 5` |

The defaults give higher-rated songs more influence. Set all five weights to the same value for a plain average. For example, to use a plain average for albums:

```json
{
  "album_one_star_weight": 1,
  "album_two_star_weight": 1,
  "album_three_star_weight": 1,
  "album_four_star_weight": 1,
  "album_five_star_weight": 1
}
```

Use the corresponding `artist_` settings for artists.

The score is `sum(song stars × weight for those stars) / sum(weights)`, using rated songs only. It rounds to the nearest star, with exact ties rounding up: **2.5 → 3**. One 5-star song and four 1-star songs give **3 stars** with default weights (`29/9`), or **2 stars** with equal weights (`9/5`). Longer albums contribute more songs.

## Decide what happens to existing ratings

| Setting | Default | Choices |
|---|---|---|
| `album_rating_policy`, `artist_rating_policy` | `preserve` | Set `preserve` or `replace` independently for each output. |
| `album_clear_below_threshold`, `artist_clear_below_threshold` | `true` | Clear eligible ratings below coverage, or keep them with `false`. |
| `dry_run` | `true` | Preview decisions; set `false` to apply them. |

**Preserve** protects pre-existing nonzero ratings and detected manual overrides. It can rate an unrated item and continues to refresh ratings generated or adopted by this plugin. A detected manual edit, including clearing a rating to zero, stays protected until you choose replace.

**Replace** permits overwriting manual ratings and values from other plugins. With `dry_run=false`, matching calculated values are adopted without a rating write; eligible differences are overwritten. Later replace runs can overwrite manual edits too. Each change is validated before writing.

When clearing is enabled, an eligible item that no longer meets coverage is reset to **0 (unrated)**. Set the relevant `*_clear_below_threshold=false` to retain that value instead. Preserve still protects unmanaged/manual ratings. Empty or incomplete sources never trigger a clear.

### Migrating from another ratings plugin

Ratings from another plugin start as unmanaged, so preserve keeps them. To adopt or regenerate them, preview **replace for the selected output**, apply it once after review, then choose **preserve** if you want later manual edits protected. Adopted ratings continue updating under preserve. Clearing also applies during migration; use your backup to restore previous values if needed.

Ownership is best-effort: edits to exactly the generated value, or edits away and back between scans, cannot be detected. Dry runs change neither ratings nor ownership records. Keep the plugin filename/ID and its storage when upgrading so ownership evidence survives. Upgrading from 0.1.0/0.1.1 resets partial scans; request a fresh run.

## Schedule and manual runs

| Setting | Default | What you can change |
|---|---|---|
| `run_time_utc` | `03:00` | Daily start time as `HH:MM` in **UTC**. Convert from your local time when setting it. |
| `run_now` | `false` | Set true to request one run on the next worker tick, normally within 10 seconds. |

Leaving `run_now=true` does **not** repeat the request, including after restart. To request another run:

1. Save `run_now=false`; restart Navidrome if required to apply the edit.
2. Let at least one worker tick observe false—10 seconds with the default interval.
3. Save `run_now=true` and restart again where required.

Requests during an active run join that run rather than starting another. Saved progress normally resumes after restart; changes to calculation/safety settings or user/library access cancel the partial run. Request a fresh run after such changes. A daily event missed while the server is offline is not automatically made up.

### Performance controls

| Setting | Default | When to change it |
|---|---|---|
| `skip_unrated_users` | `true` | Set false if you want per-item results for every user, including users with no rated songs. |
| `batch_size` | `25` | Work units per checkpoint, from 1 to 100. Larger batches save progress less often. |
| `batch_interval_seconds` | `10` | Delay before continuing unfinished work or checking requests, from 5 to 300 seconds. |

The unrated-user shortcut validates bulk data and existing ratings first. Ownership history, required clears, or uncertain data force a full scan. Skipped users receive `skipped:true` summaries with zero processed items.

Batches share a **20-second callback budget**, followed by the continuation interval. A shorter interval resumes work sooner; larger batches reduce checkpoint overhead but repeat more work after interruptions. Slow host calls can exceed the budget. Keep the defaults unless tuning a large library.

There is no verified maximum song count or guaranteed linear runtime. Snapshot capacity is **24 MiB**, with **64 MB** total plugin storage. Use a complete dry run and the progress logs to assess a large catalogue. A small checkpoint after completion is not the active storage peak.

## Choose how much to log

| Setting | Default | Choices |
|---|---|---|
| `detail_logging` | `debug` | `debug`: item records require server debug logging. `info`: show each item at info level. `off`: hide routine item records. Errors remain visible. |
| `audit_logging` | `false` | Set true to capture source evidence for independent calculation checks. |

Summaries and `run_progress` stay at info level. Use them to watch a run; `runPreflightSongs` counts bulk song rows read across the run, while `userPreflightSongs` covers the current user. Temporarily use `detail_logging=info` for individual decisions; it can generate large logs.

In a dry run, `updated` counts proposed changes; with writes enabled, it counts verified rating writes. `unchanged` counts matching results; `adopted` is the subset newly taken into management. `preserved` counts protected ratings. `ratingCounts` describes changes from 0 through 5 (0 means clears), rather than all stored ratings. `usersSkipped` counts users with no item evaluations. See the [technical reference](docs/REFERENCE.md#logs-and-counters) for storage metrics and counter identities.

Ratings reflect their **source read time**, not one frozen database state at run completion. An active library scan or incomplete/changing source can defer updates; review failures and request a new run after the source is stable. Include the full intended library scope when comparing artist totals.

### Check a repeat run

After a successful live run, request another with the same song/target ratings, catalogue, settings, and plugin storage. Expect `updated=0`, `adopted=0`, and all-zero `ratingCounts`; database ratings and `rated_at` timestamps should stay unchanged. Matching owned items count as `unchanged`; preserved and below-quota outcomes can remain. Rearm `run_now` as described [above](#schedule-and-manual-runs).

### Independently verify a calculation

Set **`audit_logging=true`**, apply settings/restart, and request a fresh dry run. **`detail_logging=info` alone does not enable audits.** Startup and summaries show `auditLogging`. Audit mode bypasses the unrated-user precheck (`preflightSongs:0`) and fully scans every user. It logs settings, song ratings/structured credits, and outcomes at info level; runtime and log volume can grow substantially with users and songs. Keep it off for daily use.

Capture **one complete, uninterrupted run**, from `run_started` through `run_summary`, then run the verifier from a checkout of this repository:

```bash
python3 scripts/verify-audit.py /path/to/local-audit.log
# Explain one artist, using an ID and username from your log:
python3 scripts/verify-audit.py /path/to/local-audit.log --explain-artist ARTIST_ID --user USERNAME
```

The standard-library verifier checks the whole run using exact fractions. Missing evidence or a mismatch fails with a nonzero exit code. Artist explanations list per-album song IDs, credits, histograms, quotas, and scores; omit `--user` to explain all matching users. Checks use captured read-time data, not later database contents or ownership provenance.

Audit logs contain private user identifiers, song IDs, and credit relationships. Keep them local and turn audit logging off afterward, restarting Navidrome where required.

## Development and reference

See the [technical reference](docs/REFERENCE.md) for source validation, recovery, event schemas, storage metrics, and build/benchmark instructions. The [manifest](manifest.json) contains the complete settings schema; [release notes](RELEASE_NOTES.md) describe changes in this version.

## License

[MIT](LICENSE). This Plugin is inspired by [mattnic/navidrome-album-ratings](https://github.com/mattnic/navidrome-album-ratings).
