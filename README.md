# Automatic Ratings for Navidrome

Calculate **album and artist ratings from each user's song ratings**. Choose either output or both, set how many songs must be rated, and decide how to handle existing ratings. Artist scores come directly from songs; album ratings do not influence them. Song ratings and music files remain unchanged.

**Defaults:** both outputs enabled, album-artist attribution, 30% coverage with at least one rated song, preservation of existing ratings, and dry-run mode.

**v0.1.2 is a prerelease.** Earlier releases were installation-tested in dry-run mode on Navidrome 0.64.2; real-server write validation remains outstanding. This project was developed with AI assistance. Preview results before enabling writes.

## Install and preview

Requires **Navidrome 0.64.2 or newer** with native plugins enabled:

```toml
[Plugins]
Enabled = true
```

1. Download `automatic-ratings.ndp` and `automatic-ratings.ndp.sha256` from [Releases](https://github.com/JLS1996/navidrome-automatic-rating-plugin/releases). In the download directory, verify with `sha256sum -c automatic-ratings.ndp.sha256`.
2. Back up the Navidrome database and plugin storage. Copy the package into the plugins directory and rescan plugins, using `navidrome plugin rescan` where supported.
3. Grant the plugin the intended **users and libraries**, then enable **Automatic Ratings**. Each user's inputs are limited to libraries allowed by both the plugin grant and their own access. Empty grants do not mean unrestricted access.
4. Open the plugin settings. Keep `dry_run=true`, choose the settings below, and set `run_now=true`. Save and restart Navidrome where required. Review `user_summary` and `run_summary`; temporarily choose `detail_logging=info` to inspect individual decisions.
5. When the preview matches your intent, disable older rating plugins, set `dry_run=false`, and request a fresh run. Changing dry-run mode cancels any active preview. See [running again](#schedule-and-manual-runs) if `run_now` is already true.

**On Navidrome 0.64.2, restart the server/container after settings or grant edits.** These edits can unload the plugin without restarting its callbacks. Confirm an `enabled` log event; disabling and re-enabling the plugin may not restore them.

Installation uses only the `.ndp` package. Node.js and Python are not required on the Navidrome server.

## Choose what to rate

Album and artist settings are independent: you can generate one kind, preserve the other, or give them different coverage requirements and weights.

| Setting | Default | What you can change |
|---|---|---|
| `rate_albums` | `true` | Generate album ratings from all songs in each album, including multiple discs. |
| `rate_artists` | `true` | Generate artist ratings from attributed songs across the selected libraries. |
| `artist_attribution` | `album_artist` | Choose album artists or the performing artists credited on each song. |

Turning an output off leaves its existing ratings in place. Singles, EPs, compilations, and separate editions follow Navidrome's IDs.

For artist attribution, choose:

- **`album_artist`:** every song contributes once to each artist in the album's structured `artists` credits. Use this to rate artists by their album catalogue.
- **`performing_artist`:** each song contributes once to each artist in its structured `artists` credits, including guest-only performers. Composer and instrumental-contributor credits are not automatically included.

Names are never split on punctuation. For example, a four-song album shared by fictional **Aurora Ensemble** and **Cedar Quartet** contributes four songs to each artist. Those songs also count toward each artist's coverage requirement. To verify album-artist results externally, use **all IDs in `getAlbum.artists`**; the database's single `media_file.album_artist_id` can omit collaborators.

Artist ratings belong globally to a user and artist; library grants select their inputs. Include the full intended catalogue before replacing an artist's rating.

## Set the coverage requirement

An item qualifies only when **both** its percentage and minimum-count requirements are met. Unrated songs count toward coverage but stay out of the average.

| Setting | Default | Effect |
|---|---|---|
| `album_minimum_rated_percent` | `30` | Percentage of an album's songs that must be rated, from 0 to 100. |
| `artist_minimum_rated_percent` | `30` | Percentage of an artist's attributed songs that must be rated, from 0 to 100. |
| `album_minimum_rated_songs` | `1` | Minimum rated-song count for an album, from 1 to 1,000,000. |
| `artist_minimum_rated_songs` | `1` | Minimum rated-song count for an artist, from 1 to 1,000,000. |

The required count is `max(minimum count, ceil(total songs × percentage / 100))`. A ten-song album at 30% needs three rated songs; raising its minimum count to five means it needs five. Setting the percentage to 0 leaves the minimum-count requirement in force. Raising the minimum above an item's total song count prevents it from qualifying.

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

Use the corresponding `artist_` settings to make the same change for artists. Changing album weights does not change artist calculations.

The score is `sum(song stars × weight for those stars) / sum(weights)`, using rated songs only. It rounds to the nearest star, with exact half-star ties rounding up: **2.5 → 3**. Decimal-weight ties use exact ratios. An artist with one 5-star song and four 1-star songs gets **3 stars** with the default weights (`29/9`), or **2 stars** with equal weights (`9/5`). Longer albums contribute more songs; there is no normalization of the final rating distribution.

## Decide what happens to existing ratings

| Setting | Default | Choices |
|---|---|---|
| `album_rating_policy`, `artist_rating_policy` | `preserve` | Set `preserve` or `replace` independently for each output. |
| `album_clear_below_threshold`, `artist_clear_below_threshold` | `true` | Clear eligible ratings below coverage, or keep them with `false`. |
| `dry_run` | `true` | Preview decisions; set `false` to apply them. |

**Preserve** protects pre-existing nonzero ratings and detected manual overrides. It can rate an unrated item and continues to refresh ratings previously generated by this plugin. A detected manual edit, including clearing a rating to zero, stays protected until you choose replace.

**Replace** permits overwriting existing ratings, including manual ratings. Matching calculated values are adopted into this plugin's ownership without an unnecessary rating write. It validates each change before applying it; there is no initial wipe.

When clearing is enabled, an eligible item that no longer meets coverage is reset to **0 (unrated)**. Set the relevant `*_clear_below_threshold=false` to retain that value instead. Preserve still protects unmanaged/manual ratings. Empty or incomplete sources never trigger a clear.

For example, keep existing album ratings while allowing artist ratings to be regenerated with `album_rating_policy=preserve` and `artist_rating_policy=replace`.

### Migrating from another ratings plugin

Ratings created by another plugin initially count as unmanaged, so preserve keeps them. To adopt or regenerate them, preview **replace for the selected output**, run it once after review, and switch back to preserve if desired. The clearing option also applies during that migration. Keep preserve if you want the old values retained without adoption.

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

The unrated-user shortcut checks bulk song/artist data and existing ratings first. Any enabled-output ownership history, required clear, or uncertain source falls back to a full scan, preserving manual-override detection and interrupted-write recovery. Skipped users still receive a summary, with `skipped:true` and zero processed items.

Batches chain within a shared **20-second callback budget**; the continuation interval is not a sleep after every batch. Lowering the interval resumes unfinished work sooner. Raising the batch size reduces checkpoint overhead but increases work repeated after an interruption. Individual slow host calls can exceed the budget. Leave these controls at their defaults unless you need to tune a large library.

There is no verified maximum song count or guaranteed linear runtime. Snapshot capacity is **24 MiB**, with **64 MB** total plugin storage. Use a complete dry run and the progress logs to assess a large catalogue. A small checkpoint after completion is not the active storage peak.

## Choose how much to log

| Setting | Default | Choices |
|---|---|---|
| `detail_logging` | `debug` | `debug`: item records require server debug logging. `info`: show each item at info level. `off`: hide routine item records. Errors remain visible. |
| `audit_logging` | `false` | Set true to capture source evidence for independent calculation checks. |

`user_summary` and `run_summary` stay at info level. `run_progress` reports phase and progress when work continues on another callback. Use those events to watch a run without enabling every item record. Temporarily set `detail_logging=info` when reviewing individual proposed changes; it can generate large logs.

In a dry run, `updated` counts proposed changes; with writes enabled, it counts verified changes. `preserved` counts protected ratings. `ratingCounts` gives the distribution from 0 through 5, with index 0 representing clears. `usersSkipped` explains users with no item evaluations. For sizes, check `peakSnapshotBytes` and `snapshotLimitBytes`. The full event fields and counter identities are in the [technical reference](docs/REFERENCE.md#logs-and-counters).

Ratings reflect their **source read time**, not one frozen database state at run completion. An active library scan or incomplete/changing source can defer updates; review failures and request a new run after the source is stable. Include the full intended library scope when comparing artist totals.

### Independently verify a calculation

Enable `audit_logging=true` and start a fresh run. Audit mode forces full scans and logs settings, source song ratings/structured artist IDs, and item outcomes at info level, even if `detail_logging` is debug or off.

Capture **one complete, uninterrupted run**, from `run_started` through `run_summary`, then run the verifier from a checkout of this repository:

```bash
python3 scripts/verify-audit.py /path/to/local-audit.log
```

The verifier uses Python's standard library and exact fractions to independently reconstruct attribution, coverage, scores, rounded targets, and summary counts. Missing evidence or a mismatch returns a nonzero exit code. It checks calculations against the captured read-time data, not ownership provenance or later database changes.

Audit logs contain private user identifiers, song IDs, and credit relationships. Keep them local and turn audit logging off afterward, restarting Navidrome where required.

## Development and reference

See the [technical reference](docs/REFERENCE.md) for source validation, recovery, event schemas, storage metrics, and build/benchmark instructions. The [manifest](manifest.json) contains the complete settings schema; [release notes](RELEASE_NOTES.md) describe changes in this version.

## License

[MIT](LICENSE). This separate combined implementation builds on the Artist Ratings plugin and is inspired by [mattnic/navidrome-album-ratings](https://github.com/mattnic/navidrome-album-ratings).
