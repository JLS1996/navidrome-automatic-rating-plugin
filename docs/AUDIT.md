# Audit and feature recommendations

Audit date: 2026-11-12. Baseline: `20505130d93566ccb27db5427a027a59a34646b4` (v0.3.0).

## Scope

Reviewed the complete runtime, manifest/settings UI, build/release workflow, test fixtures, WASM smoke test, native benchmark, isolated Navidrome test, offline audit verifier, and user documentation. Runtime review covered calculation/rounding, zero weights, independent album/artist outputs, structured credits, pagination, grant boundaries, preserve/replace, clears, write verification, ownership recovery, checkpoint validation/capacity, scheduling, and logs.

The plugin derives album and artist ratings from user-rated songs. It does not infer song ratings from playback. No song-write path, music-file access, external HTTP permission, or external telemetry was added. Defaults and configuration/storage keys are unchanged.

## Confirmed findings and fixes

| Severity | Finding and trigger | Fix and evidence |
|---|---|---|
| High | A manual target edit made during ownership-intent persistence could be overwritten. The old fresh read happened before that storage call. | Re-read the target after intent persistence; albums also revalidate source song ratings. Continue to check settings, grants, and scanner status before the write. Regression tests cover albums/artists under both policies; compiled WASM exercises both targets. |
| Medium | An intent for a write that was never attempted could later make a matching manual rating look plugin-owned. This could happen after a source, scanner, or access check deferred the write. | Restore the resolved ownership record when the API call was never attempted. Retain pending intent after attempted calls, since a successful write may have lost its response. A regression test defers a source change, then confirms a later manual rating is preserved. |
| Medium | A transient KV checkpoint-read error was caught as corruption and replaced with a fresh, inactive state, losing resumable work. | Separate host/read-response failures from checkpoint decoding/validation. Retry unreadable storage without resetting it; actual invalid saved data still follows the existing reset path. Tests confirm unchanged checkpoint bytes, worker rearming, and successful resume. |
| Medium | Failure to save snapshot metrics could abort a valid user scan, report a source error, or prevent a capacity cancellation from reaching the checkpoint. | Persist the authoritative checkpoint first and treat metric saves as optional telemetry. Emit `snapshot_metrics_save_failed` warnings. Regression tests cover normal completion and persisted capacity cancellation with metric storage failing. |
| Low | Percentage ceilings could be one song too low for accepted counts near JavaScript's safe-integer limit because `count * percent` loses precision. | Split the integer count before multiplication. The regression uses 9,007,199,254,739,991 songs at 10%; it is a numerical boundary test, not a realistic library size. |
| Usability | Navidrome 0.64.2's JSON Forms 2.5 checkbox renderer hides schema descriptions. Flat controls and inline weight groups also crowded related settings. | Use visible help labels for switches, padded groups, and explicit vertical layouts. Separate preview, outputs, artist credits, coverage, policies, weights, performance, and logging. Dropdowns show readable labels while preserving stored values. |

Added comments explain the recovery boundaries, optional telemetry, exact percentage calculation, and Navidrome's omitted false KV fields. The shared host fixture now mirrors Navidrome's actual empty KV response (`{}`), verified against its generated Go host contract and the real-server integration.

## Validation

- 117 Node tests pass, including six new recovery/numeric regression tests. On the validation machine, `node --test --test-isolation=none test/*.test.js` exposes all individual test results.
- NDP build, archive integrity, and checksum verification pass using the CI-pinned Extism JS 1.7.0 and Binaryen v125 tools.
- Compiled WASM smoke test passes, including the new concurrent-edit checks and existing lost-response recovery, dry-run, zero-weight, attribution, and audit-verifier checks.
- Isolated Navidrome 0.64.2 integration validates real writes, matching-rating adoption, pending recovery, repeat-run convergence, manual overrides, clears, performing credits, zero weights, and unchanged songs/files.
- Browser validation uses the actual Navidrome 0.64.2 settings editor in Chromium, rather than an approximation of its renderer.

No production Navidrome instance or real music library was used. These checks establish the tested behavior; they do not guarantee every host version or failure interleaving.

## Remaining constraints

- Navidrome offers no atomic rating compare-and-set or whole-run transaction. A user edit can still occur between the final host checks and `setRating`. Artist results represent verified source reads, not a frozen library snapshot.
- If storage also fails while restoring an unattempted intent, `write_intent_cleanup_failed` is logged; that record needs review before relying on ownership provenance. Attempted but unverified writes deliberately retain recovery intent.
- Preserve mode cannot detect a manual edit to the exact same value already stored by the plugin, or an edit that is changed back between observations.
- Navidrome 0.64.2 requires a restart after setting/grant edits. Manual requests still use the existing off/on latch. A forced termination before worker rearming can require a restart; offline daily runs are not replayed.
- Source checkpoints remain bounded at 24 MiB with a 64 MB KV grant. Large libraries can reach that limit. Source logs contain private listening-library data when audit logging is enabled.
- Artist annotations are global per user/artist; library grants select the input catalogue. Review the intended library scope before using replace.
- Visual spacing and colors come from the host renderer. The manifest supplies supported groups/layouts; it cannot change Navidrome's global theme.

## Recommended features — not implemented

| Priority | Feature | Why it helps | Design consideration |
|---|---|---|---|
| 1 | **Preview changes in Navidrome** | Show old → proposed ratings, clears, protected manual ratings, and a filterable summary before applying changes. Users should not need to read JSON logs for routine setup. | Bind every preview to its settings and source revision; refresh stale previews before applying. Requires host UI/route support. |
| 2 | **“Why this rating?” explanations** | Show the contributing songs, weights, weighted mean, coverage, and the reason a rating was preserved or skipped. “4 of 12 songs rated; 4 required” makes thresholds tangible. | Reuse the existing audit calculation model, with on-demand explanations rather than full evidence logging by default. |
| 3 | **Explicit manual locks and “resume automatic”** | Let users protect a particular album/artist and intentionally return it to automatic management. This is clearer than inferring every override from rating differences. | Keep locks per user and target. Display who/what owns the current rating; require an explicit action to unlock. |
| 4 | **Run/status panel with Run now, Pause, and Cancel** | Expose progress, next UTC/local run time, last success/error, and resumable state. Replace the awkward boolean request latch. | Use durable request IDs and serialized workers. Depends on Navidrome support for plugin actions/UI; cancellation cannot undo earlier writes. |
| 5 | **Safe rollback journal** | Recover from a mistaken weight, attribution, or replace configuration without restoring the entire database. | Record before/after values and ownership changes; roll back only values still matching that run's output, preserving later manual edits. Bound retention and offer a rollback preview. |
| 6 | **Incremental recalculation** | Update only affected albums and credited artists after song-rating or library changes, with much less waiting on large libraries. | Needs suitable host events or reliable change tracking. Debounce bursts and retain periodic full reconciliation to catch missed events. |
| 7 | **Per-user calculation profiles** | Different users can prefer simple averages, stronger favorite-song weighting, or different coverage requirements. | Keep profiles scoped to granted users; make inheritance and overrides explicit so one user's choices cannot affect another's output. |
| 8 | **Interactive coverage/weight examples and presets** | Offer “simple average,” “favor highly rated songs,” and “require broader coverage,” with a small worked example showing their effects. | Preview only until saved; explain that current default weights intentionally favor higher-rated songs. Avoid implying low coverage is confidence. |

Start with preview and explanations: they remove the largest usability burden while making existing safeguards understandable. Locks and run controls would be the next most useful additions. All recommendations above remain proposals only.
