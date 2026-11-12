# Automatic Ratings v0.1.1 — performance and snapshot clarity

Large scans previously serialized the entire growing source snapshot for every target and reloaded it between chained batches. The worker now loads once per callback and encodes once per checkpoint, with incremental capacity reservations before writes.

- Avoid redundant artist source verification for wholly unrated users when no rating needs changing. Eligible clears still require complete verification; preserved ratings, ownership handling, item outcomes, and summary identities remain intact.
- Report source read/verification times, rated-song counts, and explicit read-time semantics in summaries. Add progress events for unfinished callbacks. Verification compares song rating values as well as IDs and credits; changes after verification remain possible.
- Explain structured collaboration credits and quota denominators, large-library capacity/runtime limits, verbose logging, migration, and configuration restart requirements.
- Add regressions for checkpoint overhead, unrated users and clears, concurrent edits, Unicode capacity accounting, upgrades, and timestamp semantics. Include an optional reproducible native-Extism benchmark using fictional data.

## Upgrade

Replace the package and restart Navidrome. Old partial scan checkpoints are discarded; ownership records are retained. Request a fresh run. A latched `run_now=true` must be rearmed by letting the worker observe false before setting true again. On Navidrome 0.64.2, configuration/grant edits can require a container/server restart; verify the `enabled` event.

Keep `dry_run=true` for the first run and review both summaries. The initial version was installation-tested in dry-run mode on Navidrome 0.64.2. This update is a prerelease; real-server write validation is still outstanding. Automated write/clear tests and benchmarks use fictional, in-memory data. Defaults and rating calculations are unchanged.
