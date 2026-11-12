# Automatic Ratings for Navidrome

Calculate **album and artist ratings from each user's song ratings**. Choose either output or both, with configurable coverage, weights, and handling of existing ratings. Artist scores come directly from songs. Song ratings and music files stay unchanged.

> **AI notice:** This plugin and its documentation were developed with AI assistance. Review a dry run before enabling writes.

**Defaults:** both outputs enabled, album-artist attribution, 30% coverage with at least one rated song, preservation of existing ratings, daily runs at **03:00 UTC**, and `dry_run=true`.

## Install and try

Requires **Navidrome 0.64.2 or newer** with native plugins enabled:

```toml
[Plugins]
Enabled = true
```

1. Download the ready-to-install **[v0.3.0 package (.ndp)](https://github.com/JLS1996/navidrome-automatic-rating-plugin/releases/download/v0.3.0/automatic-ratings.ndp)** and [checksum](https://github.com/JLS1996/navidrome-automatic-rating-plugin/releases/download/v0.3.0/automatic-ratings.ndp.sha256). Verify with `sha256sum -c automatic-ratings.ndp.sha256`. No source build is needed.
2. Back up the Navidrome database and plugin storage. Copy the package into the plugins directory, rescan plugins, grant the intended **users and libraries**, and enable **Automatic Ratings**.
3. Keep `dry_run=true`, choose your [settings](docs/CONFIGURATION.md), and set `run_now=true`. Save and restart Navidrome.
4. Review `user_summary` and `run_summary`. To apply ratings, disable older rating plugins, set `dry_run=false`, and [request another run](docs/OPERATIONS.md#schedule-and-manual-runs).

**On Navidrome 0.64.2, restart after settings or grant edits** and confirm an `enabled` log event. Leaving `run_now=true` does not repeat a request.

`preserve` protects existing unmanaged ratings and detected manual edits. `replace` can overwrite manual ratings and values from other plugins; [preview a migration first](docs/OPERATIONS.md#migrating-from-another-ratings-plugin).

## Guides

| Guide | Contents |
|---|---|
| [Configuration](docs/CONFIGURATION.md) | Outputs, artist attribution, coverage, weights, policies, schedule, and logging settings. |
| [Operations](docs/OPERATIONS.md) | Installation, migration, upgrades, manual runs, monitoring, repeat-run checks, and independent audits. |
| [Technical reference](docs/REFERENCE.md) | Source validation, recovery, event schemas, storage, building, and tests. |

**New in v0.3.0:** [exclude star levels with zero weights](docs/CONFIGURATION.md#exclude-a-star-level), independently for albums and artists. Defaults stay unchanged.

Album/artist writes have been verified in production on Navidrome 0.64.2. See [validation details](docs/OPERATIONS.md#validation-status) and the [release notes](RELEASE_NOTES.md).

## License

[MIT](LICENSE).
This Plugin is inspired by [mattnic/navidrome-album-ratings](https://github.com/mattnic/navidrome-album-ratings).
