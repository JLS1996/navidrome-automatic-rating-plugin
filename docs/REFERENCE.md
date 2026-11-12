# Technical reference

For installation and settings, see the [README](../README.md). This page covers calculation contracts, source validation, logs, recovery, and development.

## Calculation contracts

The plugin requires Navidrome OpenSubsonic responses. Unrated songs and artists omit `userRating`; that omission means zero. Explicit nulls, strings, out-of-range ratings, or malformed source objects are errors. OpenSubsonic album ratings must be present, including zero.

Coverage uses the full song count, including unrated songs. Only rated songs enter the weighted mean. Both the percentage quota, rounded up, and minimum rated-song count must be met. Empty sources never trigger clearing. Decimal weights use exact integer ratios for half-star comparisons; the logged score is a floating-point approximation.

## Source validation and recovery

For each user, the plugin intersects library grants with the user's accessible libraries. It inventories albums through paginated `getAlbumList2` requests, continuing to explicit empty pages even after short responses. Full scans read each album's song list, validate expected IDs/counts, reject duplicates, and build per-artist song histograms.

Before artist changes, it re-enumerates albums and compares source song IDs, rating values, and attributed artist IDs. An incomplete, unreadable, duplicated, or changed source defers all remaining artist writes for that user. Valid album updates remain independent. A failed album rating write does not invalidate otherwise valid artist source data. Blocked artist events cover known groups; artists absent from unreadable sources cannot be counted.

Active library scans block source processing or writes. Item failures retry on the next full run. Fatal inventory/API failures end the affected user's scan; later users can continue on another tick. Ratings represent individual source reads, not a whole-run transaction. Changes after verification can still be absent from a result.

Before a rating write, the plugin records its intent in KV. It verifies the resulting rating before finalizing ownership. A lost response or interruption can be reconciled from the pending intent on a later scan. Storage failures prevent the affected write; unverifiable writes retain their intent. There is no automatic rollback over subsequent user edits. Ownership keys exceeding the host's 256-byte UTF-8 limit fail without a rating write.

Worker callbacks serialize by atomically cancelling their recurring schedule and rearming it in `finally`. Batches share a 20-second callback budget and checkpoint between batches. Daily callbacks queue requests. A forced termination before rearming can require a Navidrome restart. Persisted requests/progress survive restart, subject to configuration/access checks; missed offline daily events are not automatically replayed.

### Unrated-user precheck

The shortcut uses paginated `search3` song/artist reads, validates unique song IDs and per-album counts against the library inventory, and rechecks album IDs/counts/ratings/credits. Album-artist target IDs use the structured album inventory credits; performing targets use song credits. A positive song rating ends the precheck early.

Missing, malformed, or changing data falls back to full evaluation. Prefix-scoped KV ownership listing includes earlier releases' records. Any enabled-output ownership history also forces full evaluation so manual zero overrides and pending writes are observed. Eligible clears prevent skipping; unmanaged ratings may remain protected under preserve. The precheck changes neither ratings nor ownership.

## Logs and counters

Each plugin line begins `Automatic Ratings: ` followed by JSON with `schemaVersion:1` and an `event` discriminator. Item events share these fields:

```text
action, kind, user, id, name, existingRating, proposedRating, score,
totalSongs, ratedSongs, unratedSongs, requiredRatedSongs, meetsThreshold,
dryRun, reason, error
```

Unavailable item values are null. Routine item records follow `detail_logging`; errors remain visible. Audit mode promotes item records to info and also emits `audit_config` and `source_album` evidence.

`enabled`, `run_started`, `user_summary`, and `run_summary` expose `auditLogging` and `auditSourceFormat` (`structured_song_ratings_v1`, or null when disabled). These fields confirm whether independent evidence was requested; `detail_logging=info` alone never enables it.

`user_summary` and `run_summary` contain separate `albums` and `artists` counters. Primary outcomes are mutually exclusive:

```text
processed = updated + unchanged + preserved + belowQuota + empty + failed
updated = sum(ratingCounts[0..5])
cleared = ratingCounts[0]
```

- `updated`: proposed dry-run changes or verified writes, including clears.
- `unchanged`: calculated rating already matches; can include explicit adoption.
- `preserved`: unmanaged/manual rating protected by preserve policy.
- `belowQuota`: insufficient coverage with no change, because the item is already unrated or clearing is disabled.
- `empty`: no source songs; no clear occurs.
- `failed`: read/write/validation failure, or an artist blocked by incomplete sources.

`quotaFailures` counts all nonempty below-quota evaluations, including preserved ratings, clears, and failures, so it overlaps primary outcomes. `adopted` is a subset of unchanged. `manualOverrides` counts detected ownership overrides. Failed writes do not enter `ratingCounts`. A recovered write may be reported as matching on retry; these summaries are evaluation counts, not a transactional change journal.

Skipped users have `skipped:true`, `skipReason:"no_rated_songs_or_eligible_clears"`, zero processed items/distributions, and no item events. `run_summary.users` includes them; `usersSkipped` counts them. `scannedSongs` includes the validated source used for either scan mode. `preflightSongs` separately counts bulk song rows read, including preliminary rows discarded on fallback. Ordinary full scans of wholly unrated users emit `user_unrated` instead.

### Progress scopes

`run_progress` reports the current user's phase, album/artist cursors and totals, plus the callback's `batches`, `units`, and `callbackMs`. Album and artist cursors reset at each user boundary. Bulk-read counters count **song rows returned**, not pages or unique songs across users:

| Field | Scope |
|---|---|
| `userPreflightSongs` | Rows read for the current user across precheck phases, or 0 between users. |
| `runPreflightSongs` | Completed users' rows plus the current user's rows; cumulative within the run, including after resume. |
| `preflightSongs` | Compatibility alias for `userPreflightSongs` in progress; `preflightSongsScope:"user"` makes this explicit. |

Summaries retain `preflightSongs`, labelled `preflightSongsScope:"user"` or `"run"`. These counters include early-fallback pages even though their ratings are discarded; they measure read cost, unlike `scannedSongs`.

### Read-time fields

`sourceReadMode` is `album`, `song_pages`, or (for a mixed run) `mixed`. Corresponding `ratingsAsOf` values are `per_album_read_time`, `per_song_page_read_time`, and `per_source_read_time`.

`sourceReadStartedAt` and `sourceReadCompletedAt` bound the source reads actually used; discarded preliminary reads are excluded. `sourceVerifiedAt` marks the end of a successful full verification sweep. Times are UTC Unix milliseconds, or null when unavailable. Run-level values are the earliest start, latest completion, and latest successful **user** verification; that final verification time does not apply to every user.

`sourceVerified` is false for skipped users, unnecessary second passes, or failed verification. `sourceComplete` means no source error was observed, not that the library stayed frozen until completion. Audit verification checks captured read-time calculations, not later database contents or ownership provenance.

### Independent artist explanations

Enable `audit_logging`, then capture one complete, uninterrupted run from `run_started` through `run_summary`. `source_album` events contain raw song/rating/performing-credit tuples and structured album artist IDs; the verifier independently deduplicates each song's selected credits. It uses every `getAlbum.artists` ID in album-artist mode, rather than the database's primary `media_file.album_artist_id`.

`python3 scripts/verify-audit.py LOG --explain-artist ARTIST_ID [--user USERNAME]` verifies **the entire run** before returning `artistExplanations`. Each explanation contains the selected attribution, histogram (0–5), counts, quota, approximate `score`, exact rational `scoreExact`, `calculatedRating`, logged action/existing/proposed ratings, and per-album song/credit evidence. `calculatedRating:0` means insufficient coverage; a preserved item's `proposedRating` remains null even when its calculated rating is positive. Omitting `--user` selects every matching user. Unknown selections fail; ordinary verification output is unchanged. Keep source logs and explanations local.

### Storage metrics

Snapshot capacity is 24 MiB and total KV permission is 64 MB. A conservative growth guard cancels before an uncheckpointable target write. Progress and summaries expose:

| Field | Meaning |
|---|---|
| `snapshotBytes` | Bytes in the latest saved checkpoint at event time. |
| `peakSnapshotBytes` | Largest measured checkpoint, including a save before discarding each user's source. |
| `peakReservedBytes` | Conservative growth bound used between checkpoints. |
| `snapshotLimitBytes` | Configured snapshot capacity. |

`snapshotMetricsScope:"run"` identifies the scope of the peaks. Sizes count decoded checkpoint bytes, not base64 or process memory. Peaks persist separately across callbacks. The final compact checkpoint is saved before `run_summary`; its size can be much smaller than the active peak. Full snapshot encoding still costs time, so runtime is not guaranteed to scale linearly with song count.

## Build and benchmark

CI uses Node.js 22+, Python 3, `zip`, Binaryen v125, and Extism JS PDK v1.7.0. Compiler downloads are checksum-verified. Put `extism-js`, `wasm-merge`, and `wasm-opt` on PATH, or set `EXTISM_JS` to the compiler path.

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run build
npm run test:wasm
```

The build creates `dist/automatic-ratings.ndp` containing exactly `manifest.json`, `plugin.wasm`, and `LICENSE`, plus the adjacent `automatic-ratings.ndp.sha256` checksum. Run `sha256sum -c automatic-ratings.ndp.sha256` from `dist` to verify it. Compiled-WASM tests use simulated host functions and fictional data, including write/clear branches and fresh callback instances. The pinned npm SDK is a development dependency; the deployed plugin requires neither npm nor Python.

[CI](../.github/workflows/build.yml) tests, builds, verifies package contents, runs native scaling/write checks, and uploads an artifact/checksum. Matching version tags publish prereleases with the package and checksum.

For the native Extism benchmark:

```bash
python3 -m venv .venv
.venv/bin/pip install -r scripts/benchmark-requirements.txt
.venv/bin/python scripts/benchmark-wasm.py --albums 64 128 256
.venv/bin/python scripts/benchmark-wasm.py --albums 256 --write
.venv/bin/python scripts/benchmark-wasm.py --albums 256 --full-scan
```

Run these commands from the repository root. `--wasm /path/to/previous/plugin.wasm` compares builds; `--full-scan` disables skipping. The script reconciles fictional rated/unrated-user outcomes and compares reported peaks with observed checkpoints. Timing separates execution from instance compilation and excludes scheduler delays and real-server latency. `--write` affects only the in-memory fixture. Native Extism avoids the JavaScript development SDK's signed allocation-address limitation in long simulated callbacks.

The plugin exports `nd_on_init`, `nd_scheduler_callback`, and `automatic_ratings_calculate` (input: `{histogram:[unrated,one,two,three,four,five],options:{...}}`). Host permissions cover Subsonic API, users, library metadata, scheduler, and KV. No filesystem, direct database, or external HTTP permission is requested. See the [manifest](../manifest.json) and [source](../src/plugin.js) for the complete contracts.
