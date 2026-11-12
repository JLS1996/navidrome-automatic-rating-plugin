# Configuration

[README](../README.md) · [Operations guide](OPERATIONS.md) · [Technical reference](REFERENCE.md)

Change these settings in Navidrome's plugin UI. Album and artist options are independent. Preview changes with `dry_run=true`, then follow the [operations guide](OPERATIONS.md) to apply ratings or request another run. The [manifest](../manifest.json) contains the complete schema.

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

Names are never split on punctuation. A four-song album shared by fictional **Aurora Ensemble** and **Cedar Quartet** contributes four songs to each artist's score and coverage denominator. External checks must use **all IDs in `getAlbum.artists`**; the database's single `media_file.album_artist_id` can omit collaborators. The [audit command](OPERATIONS.md#independently-verify-a-calculation) explains each artist's contributing songs.

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

For a first run after another ratings plugin, see [migration and ownership](OPERATIONS.md#migrating-from-another-ratings-plugin).

## Schedule

| Setting | Default | What you can change |
|---|---|---|
| `run_time_utc` | `03:00` | Daily start time as `HH:MM` in **UTC**. Convert from your local time when setting it. |
| `run_now` | `false` | Set true to request one run on the next worker tick, normally within 10 seconds. |

For the one-shot request latch and restart steps, see [manual runs](OPERATIONS.md#schedule-and-manual-runs).

## Performance controls

| Setting | Default | When to change it |
|---|---|---|
| `skip_unrated_users` | `true` | Set false if you want per-item results for every user, including users with no rated songs. |
| `batch_size` | `25` | Work units per checkpoint, from 1 to 100. Larger batches save progress less often. |
| `batch_interval_seconds` | `10` | Delay before continuing unfinished work or checking requests, from 5 to 300 seconds. |

The unrated-user shortcut validates bulk data and existing ratings first. Ownership history, required clears, or uncertain data force a full scan. Skipped users receive `skipped:true` summaries with zero processed items.

Batches share a **20-second callback budget**, followed by the continuation interval. A shorter interval resumes work sooner; larger batches reduce checkpoint overhead but repeat more work after interruptions. Slow host calls can exceed the budget. Keep the defaults unless tuning a large library.

There is no verified maximum song count or guaranteed linear runtime. Snapshot capacity is **24 MiB**, with **64 MB** total plugin storage. Use a complete dry run and the progress logs to assess a large catalogue. A small checkpoint after completion is not the active storage peak.

## Logging settings

| Setting | Default | Choices |
|---|---|---|
| `detail_logging` | `debug` | `debug`: item records require server debug logging. `info`: show each item at info level. `off`: hide routine item records. Errors remain visible. |
| `audit_logging` | `false` | Set true to capture source evidence for independent calculation checks. |

Keep `audit_logging=false` for normal daily use. Audit mode forces full scans for every user, bypasses the unrated-user precheck, and can substantially increase runtime and private log volume. See [monitoring and verification](OPERATIONS.md#monitoring-and-results) for summary counters, repeat-run checks, and local audits.
