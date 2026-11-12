# Automatic Ratings for Navidrome

[![Latest release](https://img.shields.io/github/v/release/JLS1996/navidrome-automatic-rating-plugin)](https://github.com/JLS1996/navidrome-automatic-rating-plugin/releases/latest)
[![Build](https://github.com/JLS1996/navidrome-automatic-rating-plugin/actions/workflows/build.yml/badge.svg?branch=main)](https://github.com/JLS1996/navidrome-automatic-rating-plugin/actions/workflows/build.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Automatically calculate **album and artist ratings from each user's song ratings** in [Navidrome](https://www.navidrome.org/). Artist ratings come directly from songs, independently of album ratings. Song ratings and music files stay unchanged.

## Features

- **Independent outputs:** generate album ratings, artist ratings, or both.
- **Artist credits:** use album artists or the performers credited on each song, including guests.
- **Custom weights:** give different star ratings more influence, or exclude a star level entirely.
- **Coverage requirements:** choose how many songs must be rated before an album or artist qualifies.
- **Rating policies:** protect manual ratings or replace existing ratings when migrating from another plugin.
- **Scheduled runs:** update daily at your chosen UTC time, or request a run from the settings.

## Before you start

> [!CAUTION]
> **This plugin can change or clear album and artist ratings.**
>
> Back up your Navidrome database and plugin storage before applying changes. Preview mode is on by default (`dry_run=true`): review `user_summary` and `run_summary` in the Navidrome logs, then turn it off when ready to apply ratings and request another run.
>
> The `replace` policy can overwrite manual ratings and ratings from other plugins; disable older rating plugins before enabling writes.

## Installation

Requires **Navidrome 0.64.2 or newer** with native plugins enabled. No source build, Node.js, or Python installation is needed on the server.

1. Download **[automatic-ratings.ndp](https://github.com/JLS1996/navidrome-automatic-rating-plugin/releases/latest/download/automatic-ratings.ndp)** from the [latest release](https://github.com/JLS1996/navidrome-automatic-rating-plugin/releases/latest). A [SHA-256 checksum](https://github.com/JLS1996/navidrome-automatic-rating-plugin/releases/latest/download/automatic-ratings.ndp.sha256) is available; see [verification instructions](docs/OPERATIONS.md#verify-a-download).
2. Copy the file into your Navidrome plugins directory and rescan plugins, or restart Navidrome so it appears.
3. Open **Automatic Ratings** in Navidrome, grant access to the intended **users and libraries**, and enable it.
4. Choose your settings and save. **On Navidrome 0.64.2, restart after settings or permission changes** so the plugin's callbacks resume.

For upgrades, keep the filename and plugin storage so the plugin continues to recognize ratings it manages. See the [operations guide](docs/OPERATIONS.md#ownership-and-upgrades).

## Configuration

The plugin works separately for each granted user, using only libraries that both the user and plugin can access.

| Setting | Default |
|---|---|
| Outputs | Albums and artists |
| Artist credits | Album artists |
| Required coverage | At least 30% of eligible songs and at least 1 rated song |
| Song weights, from 1★ to 5★ | `1, 2, 3, 4, 5` — higher ratings have more influence |
| Existing ratings | Preserve existing ratings and manual edits; refresh this plugin's output |
| Daily start time | **03:00 UTC** |

Set all five weights to `1` for a simple average, or use `0` to exclude a star level from scoring and coverage. For example, one 5-star song and four 1-star songs produce **3 stars** with default weights, or **2 stars** with equal weights.

See the [configuration guide](docs/CONFIGURATION.md) for every setting, coverage examples, and clearing rules.

## Running the plugin

Runs start daily at the configured time. To start one manually, turn on **Request one run** (`run_now`), save, and restart where required. Leaving it on does not repeat the request; follow the [manual-run instructions](docs/OPERATIONS.md#schedule-and-manual-runs) to run again.

## Documentation

| Guide | What you'll find |
|---|---|
| [Configuration](docs/CONFIGURATION.md) | Outputs, artist credits, coverage, weights, and rating policies |
| [Operations](docs/OPERATIONS.md) | Download verification, upgrades, migration, manual runs, and logs |
| [Technical reference](docs/REFERENCE.md) | Calculations, recovery, storage, building, and tests |
| [Release notes](RELEASE_NOTES.md) | Changes in the current release |
| [Audit and roadmap ideas](docs/AUDIT.md) | Audit findings, validation, known limitations, and proposed features |

## Support and development

[Report a bug or suggest a feature](https://github.com/JLS1996/navidrome-automatic-rating-plugin/issues). For bugs, include your Navidrome version, plugin version, relevant settings, and a log excerpt with private details removed.

To build or contribute, start with the [development instructions](docs/REFERENCE.md#build-and-benchmark).

## Credits and license

Inspired by [mattnic/navidrome-album-ratings](https://github.com/mattnic/navidrome-album-ratings). Developed with AI assistance.

Released under the [MIT License](LICENSE).
