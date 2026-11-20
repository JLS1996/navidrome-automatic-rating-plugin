# Automatic Ratings v0.4.1

Clearer configuration help and a simpler settings layout in Navidrome.

## Settings tabs

- **General:** preview only, request a scan, daily UTC start time, and artist credits.
- **Albums:** album output at the top, followed by existing-rating policy, coverage, and weights.
- **Artists:** artist output at the top, followed by its own policy, coverage, and weights.
- **Extra:** performance settings and logging.

## Clearer help

Each setting now explains what it changes, when to use it, and relevant limits or examples. Separate text blocks provide visible line breaks in Navidrome's configuration renderer, including help for checkboxes whose descriptions are otherwise hidden.

The guidance covers preview versus live writes, both scan-switch directions, UTC scheduling, artist credit choices, manual-rating protection and migration, coverage and clearing, zero weights, checkpoint tuning, and private audit logs.

Updated the configuration guide and README screenshots to match the new layout. Calculation behavior, defaults, configuration keys, permissions, and ownership records are unchanged. Either scan-switch direction still requests one scan without a Navidrome restart.

## Upgrade

Download `automatic-ratings.ndp` and its SHA-256 checksum from this release. Replace the existing package, keeping its filename and plugin storage, and follow the upgrade instructions in the operations guide.

Requires Navidrome 0.64.2 or newer with native plugins enabled.

## Validation

120 source tests, compiled-WASM smoke checks, package integrity/checksum verification, and isolated official Navidrome 0.64.2 integration with fictional users and music. Browser checks use the real Navidrome settings editor to verify tab contents, output-switch placement, and visibly separated help text.

No production library was used.
