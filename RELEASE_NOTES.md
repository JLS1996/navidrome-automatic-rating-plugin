# Automatic Ratings v0.3.0 — optional star exclusions

Download the ready-to-install [automatic-ratings.ndp](https://github.com/JLS1996/navidrome-automatic-rating-plugin/releases/download/v0.3.0/automatic-ratings.ndp) and [SHA-256 checksum](https://github.com/JLS1996/navidrome-automatic-rating-plugin/releases/download/v0.3.0/automatic-ratings.ndp.sha256). Verify with `sha256sum -c automatic-ratings.ndp.sha256`. No source build is needed.

## Exclude 1-star songs with the existing weight controls

Weights now accept **0 to 10**, independently for albums and artists. To exclude 1-star songs from both outputs, set:

```json
{
  "album_one_star_weight": 0,
  "artist_one_star_weight": 0
}
```

Change either setting independently; any star level can be excluded. Defaults stay **1, 2, 3, 4, 5**, so existing configurations behave as before. A positive decimal such as `0.1` softens a tier's influence without excluding it. At least one tier per output must stay positive.

Excluded songs leave both scoring and the coverage pool. Unrated songs remain in coverage, and the minimum rated-song count applies to contributing songs. If every rated song is excluded, the item retains its existing rating, even under replace with clearing enabled. Genuinely unrated sources still follow clearing policy. Song ratings and music files stay unchanged.

## Diagnostics and validation

- Item logs and independent artist explanations include `excludedSongs`, `eligibleSongs`, and `contributingRatedSongs`. Raw source counts and audit evidence remain available.
- Small positive decimal weights, including scientific notation, retain exact half-up rounding and finite logged scores.
- Release checks cover 111 source tests, compiled WASM smoke tests, independent audit verification, native scaling/write checks, package integrity, and an isolated Navidrome 0.64.2 fixture with fictional users and music. The fixture exercises independent exclusions, retention when all rated songs are excluded, ordinary clears, migration, repeat runs, recovery, and song/file isolation.

## Upgrade

Back up the Navidrome database and plugin storage, replace the `.ndp` package, and restart Navidrome. Keep the package filename/ID and plugin storage so ownership evidence survives. Preview weight changes with `dry_run=true`, then request a fresh run. On Navidrome 0.64.2, restart after settings/grant edits too.

See the [configuration guide](https://github.com/JLS1996/navidrome-automatic-rating-plugin/blob/v0.3.0/docs/CONFIGURATION.md#exclude-a-star-level) for coverage examples and the [operations guide](https://github.com/JLS1996/navidrome-automatic-rating-plugin/blob/v0.3.0/docs/OPERATIONS.md#schedule-and-manual-runs) for rearming `run_now`. Audit logs contain private library metadata; keep them local.
