# navidrome-automatic-rating-plugin v0.5.1

More space between configuration elements, especially on mobile screens.

## Changes

- Add consistent blank-line spacing between help paragraphs throughout General, Albums, Artists, and Extra.
- Separate explanations from the following setting, including the minimum rated-song count and below-coverage clearing controls.
- Keep each setting's help together with its control and retain the existing tab layout.
- Refresh the README screenshots to show the improved spacing.

Rating calculations, settings, defaults, permissions, and ownership records are unchanged.

## Upgrade

Verify the download's checksum, then replace your installed package and restart Navidrome. Keep its current filename and plugin storage. If your installed file is still `automatic-ratings.ndp`, rename the new download to that filename after verification; do not install a second copy.

Requires Navidrome 0.64.2 or newer with native plugins enabled.

## Validation

120 source tests, compiled-WASM smoke checks, package integrity/checksum verification, and the release workflow's isolated Navidrome integration and legacy-upgrade checks.

The real Navidrome settings editor was checked at 390 px, 430 px, and 1360 px widths: all four tabs, visible spacing, horizontal overflow, saved setting values, and browser errors. The added gaps measure approximately 24 px with the tested host theme. All data used for validation is fictional.
