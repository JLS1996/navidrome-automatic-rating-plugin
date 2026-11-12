"use strict";

const VERSION = "0.1.2";
const PREFIX = "automatic-ratings:v1:";
const STATE_KEY = PREFIX + "scan";
const MANUAL_KEY = PREFIX + "manual";
const DAILY_KEY = PREFIX + "daily";
const HANDLED_KEY = PREFIX + "daily-handled";
const SCHEDULE_KEY = PREFIX + "schedule";
const METRICS_KEY = PREFIX + "snapshot-metrics";
const WORKER_ID = "automatic-ratings-worker";
const DAILY_ID = "automatic-ratings-daily";
const BUDGET_MS = 20000;
const PAGE_SIZE = 500;
const MAX_STATE_BYTES = 24 * 1024 * 1024;
// Reserve more than the maximum growth of all mutable counters/timestamps in
// one unit. Collection growth is charged separately, without encoding the
// entire snapshot for every target. Checkpoints reset this conservative bound.
const UNIT_GROWTH_BYTES = 2048;
const STAR_NAMES = ["one", "two", "three", "four", "five"];
const DEFAULTS = {
  rate_albums: true, rate_artists: true, artist_attribution: "album_artist",
  album_rating_policy: "preserve", artist_rating_policy: "preserve",
  album_minimum_rated_percent: 30, artist_minimum_rated_percent: 30,
  album_minimum_rated_songs: 1, artist_minimum_rated_songs: 1,
  album_clear_below_threshold: true, artist_clear_below_threshold: true,
  dry_run: true, run_now: false, run_time_utc: "03:00",
  batch_size: 25, batch_interval_seconds: 10, detail_logging: "debug",
  skip_unrated_users: true, audit_logging: false,
};
for (const kind of ["album", "artist"]) {
  STAR_NAMES.forEach((star, i) => { DEFAULTS[`${kind}_${star}_star_weight`] = i + 1; });
}
Object.freeze(DEFAULTS);
const OUTCOMES = ["updated", "unchanged", "preserved", "belowQuota", "empty", "failed"];
const COUNTERS = ["processed", ...OUTCOMES, "quotaFailures", "cleared", "adopted", "manualOverrides"];

function readSettings(read) {
  const result = {};
  for (const [key, fallback] of Object.entries(DEFAULTS)) {
    const raw = read(key);
    if (raw === undefined || raw === null || raw === "") { result[key] = fallback; continue; }
    if (typeof fallback === "boolean") {
      if (![true, false, "true", "false"].includes(raw)) throw Error(`${key} must be boolean`);
      result[key] = raw === true || raw === "true";
    } else if (typeof fallback === "number") {
      const value = typeof raw === "number" || (typeof raw === "string" && raw.trim()) ? Number(raw) : NaN;
      const [min, max] = key.endsWith("_weight") ? [1, 10] : key.endsWith("_percent") ? [0, 100] :
        key.endsWith("_songs") ? [1, 1000000] : key === "batch_size" ? [1, 100] : [5, 300];
      if (!Number.isFinite(value) || value < min || value > max || (!key.endsWith("_weight") && !Number.isInteger(value))) {
        throw Error(`${key} must be ${key.endsWith("_weight") ? "a number" : "an integer"} between ${min} and ${max}`);
      }
      result[key] = value;
    } else if (key === "run_time_utc") {
      if (typeof raw !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(raw)) throw Error("run_time_utc must be HH:MM UTC");
      result[key] = raw;
    } else {
      const choices = key === "artist_attribution" ? ["album_artist", "performing_artist"] :
        key === "detail_logging" ? ["debug", "info", "off"] : ["preserve", "replace"];
      if (!choices.includes(raw)) throw Error(`${key} must be one of ${choices.join(", ")}`);
      result[key] = raw;
    }
  }
  return result;
}
function signature(settings) {
  return JSON.stringify(Object.entries(settings).filter(([key]) => ![
    "run_now", "run_time_utc", "batch_size", "batch_interval_seconds", "detail_logging",
  ].includes(key)).sort(([a], [b]) => compare(a, b)));
}
function compare(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
function validId(id) { return typeof id === "string" && id.length > 0 && id.length <= 1024; }
function starRating(value, omittedZero = false) {
  if (value === undefined && omittedZero) return 0;
  if (!Number.isInteger(value) || value < 0 || value > 5) throw Error("Invalid or missing userRating");
  return value;
}
function emptyHistogram() { return [0, 0, 0, 0, 0, 0]; }
function calculateRating(histogram, { minimumRatedPercent = 30, minimumRatedSongs = 1, weights = [1, 2, 3, 4, 5] } = {}) {
  if (!Array.isArray(histogram) || histogram.length !== 6 ||
      histogram.some(n => !Number.isSafeInteger(n) || n < 0)) throw Error("Invalid song histogram");
  if (!Number.isInteger(minimumRatedPercent) || minimumRatedPercent < 0 || minimumRatedPercent > 100 ||
      !Number.isSafeInteger(minimumRatedSongs) || minimumRatedSongs < 1) throw Error("Invalid quota");
  if (!Array.isArray(weights) || weights.length !== 5 || weights.some(w => !Number.isFinite(w) || w < 1 || w > 10)) {
    throw Error("Invalid weights");
  }
  const totalSongs = histogram.reduce((sum, n) => sum + n, 0);
  if (!Number.isSafeInteger(totalSongs)) throw Error("Song count overflow");
  const unratedSongs = histogram[0], ratedSongs = totalSongs - unratedSongs;
  const requiredRatedSongs = Math.max(minimumRatedSongs, Math.ceil(totalSongs * minimumRatedPercent / 100));
  const meetsThreshold = totalSongs > 0 && ratedSongs >= requiredRatedSongs;
  let sum = 0, weight = 0;
  for (let stars = 1; stars <= 5; stars++) {
    sum += histogram[stars] * stars * weights[stars - 1];
    weight += histogram[stars] * weights[stars - 1];
  }
  let score = null, rating = 0;
  if (meetsThreshold) {
    if (weights.every(Number.isInteger) && Number.isSafeInteger(sum) && Number.isSafeInteger(weight)) {
      score = sum / weight;
      const remainder = sum % weight;
      rating = (sum - remainder) / weight + (remainder >= weight / 2 ? 1 : 0);
    } else {
      // Decimal settings must not turn an exact half-star tie into a value just
      // below it through binary floating-point arithmetic. Scale their decimal
      // representations to integers and compare the rational value exactly.
      const decimals = weights.map(w => String(w).split("."));
      const places = Math.max(...decimals.map(parts => (parts[1] || "").length));
      const scaled = decimals.map(parts => BigInt(parts[0] + (parts[1] || "").padEnd(places, "0")));
      let numerator = 0n, denominator = 0n;
      for (let stars = 1; stars <= 5; stars++) {
        const weightedCount = BigInt(histogram[stars]) * scaled[stars - 1];
        numerator += weightedCount * BigInt(stars); denominator += weightedCount;
      }
      score = Number(numerator) / Number(denominator);
      rating = Number((2n * numerator + denominator) / (2n * denominator));
    }
  }
  return { score, rating, totalSongs, ratedSongs, unratedSongs,
    requiredRatedSongs, meetsThreshold };
}
function calculateFor(kind, histogram, settings) {
  return calculateRating(histogram, { minimumRatedPercent: settings[`${kind}_minimum_rated_percent`],
    minimumRatedSongs: settings[`${kind}_minimum_rated_songs`],
    weights: STAR_NAMES.map(star => settings[`${kind}_${star}_star_weight`]) });
}
function credits(value) {
  if (!Array.isArray(value) || value.length === 0) throw Error("Structured artist credits are unavailable");
  const result = new Map();
  for (const artist of value) {
    if (!artist || !validId(artist.id) || typeof artist.name !== "string") throw Error("Invalid structured artist credit");
    result.set(artist.id, { id: artist.id, name: artist.name });
  }
  return [...result.values()].sort((a, b) => compare(a.id, b.id));
}
function validateAlbum(album, expected) {
  if (!album || album.id !== expected.id || !Number.isSafeInteger(album.songCount) || album.songCount < 0 ||
      album.songCount !== expected.songCount || !Array.isArray(album.song ?? []) ||
      (album.song ?? []).length !== album.songCount) throw Error("Invalid album or incomplete song list");
  starRating(album.userRating); // OpenSubsonic album ratings are explicit, including zero.
  const seen = new Set(), histogram = emptyHistogram();
  const songs = (album.song ?? []).map(song => {
    if (!song || !validId(song.id) || song.albumId !== album.id || seen.has(song.id) || song.isDir === true) {
      throw Error("Invalid, duplicate, or incorrectly grouped song");
    }
    seen.add(song.id);
    // Navidrome Child.userRating has omitempty: absent means unrated. The API
    // wrapper requires Navidrome + OpenSubsonic before accepting these objects.
    const rating = starRating(song.userRating, !Object.prototype.hasOwnProperty.call(song, "userRating"));
    histogram[rating]++;
    return { ...song, userRating: rating };
  }).sort((a, b) => compare(a.id, b.id));
  return { songs, histogram };
}
function attributedSongs(album, songs, settings) {
  if (!settings.rate_artists) return songs.map(song => ({ id: song.id, rating: song.userRating, artists: [] }));
  const albumArtists = settings.artist_attribution === "album_artist" && songs.length ? credits(album.artists) : null;
  return songs.map(song => ({ id: song.id, rating: song.userRating,
    artists: albumArtists || credits(song.artists) }));
}
function fingerprint(songs) {
  return JSON.stringify(songs.map(song => [song.id, song.rating, song.artists.map(artist => artist.id)]));
}
function emptyCounts() {
  return { ...Object.fromEntries(COUNTERS.map(key => [key, 0])), ratingCounts: emptyHistogram() };
}
function addCounts(target, source) {
  for (const key of COUNTERS) target[key] += source[key];
  source.ratingCounts.forEach((count, i) => { target.ratingCounts[i] += count; });
}
function validCounts(c) {
  return c && COUNTERS.every(key => Number.isSafeInteger(c[key]) && c[key] >= 0) &&
    Array.isArray(c.ratingCounts) && c.ratingCounts.length === 6 &&
    c.ratingCounts.every(n => Number.isSafeInteger(n) && n >= 0) &&
    c.processed === OUTCOMES.reduce((sum, key) => sum + c[key], 0) &&
    c.updated === c.ratingCounts.reduce((sum, n) => sum + n, 0) && c.cleared === c.ratingCounts[0];
}
function asciiJSON(value) {
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g,
    ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
function encode(value) { return btoa(asciiJSON(value)); }
function decode(value) { return JSON.parse(atob(value)); }
function ownerKey(user, kind, id) {
  // Host keys are limited to 256 UTF-8 bytes. Encode identifiers without leaking
  // them to any external service; unusually long keys fail before a rating write.
  const key = PREFIX + "owner:" + JSON.stringify([user, kind, id]);
  if (unescape(encodeURIComponent(key)).length > 256) throw Error("Ownership key exceeds host limit");
  return key;
}
function validOwner(owner) {
  return owner && owner.version === 1 && typeof owner.manual === "boolean" &&
    (owner.rating === null || (Number.isInteger(owner.rating) && owner.rating >= 0 && owner.rating <= 5)) &&
    (owner.pending === null || (owner.pending && [owner.pending.before, owner.pending.target].every(v =>
      Number.isInteger(v) && v >= 0 && v <= 5)));
}
function resolveOwner(owner, current) {
  if (!owner) return { owner: null, recovered: false, manualOverride: false };
  if (!validOwner(owner)) throw Error("Corrupt ownership record; rating left untouched");
  let next = { ...owner }, recovered = false;
  if (owner.pending) {
    if (current === owner.pending.target) {
      next = { version: 1, rating: current, manual: false, pending: null };
      recovered = true;
    } else if (current === owner.pending.before) next.pending = null;
    else next = { version: 1, rating: null, manual: true, pending: null };
  }
  const manualOverride = next.manual || (next.rating !== null && current !== next.rating);
  if (manualOverride) next = { version: 1, rating: null, manual: true, pending: null };
  return { owner: next, recovered, manualOverride };
}
function decideRating(result, current, owner, policy, clear) {
  if (!result.totalSongs) return { outcome: "empty", action: "skip_empty", target: null, reason: "no_songs" };
  if (policy === "preserve" && (owner?.manual || (owner?.rating === null || !owner) && current > 0)) {
    return { outcome: "preserved", action: "preserve", target: null,
      reason: owner?.manual ? "manual_override" : "existing_unmanaged_rating" };
  }
  if (!result.meetsThreshold && (!clear || current === 0)) {
    return { outcome: "belowQuota", action: "keep_below_quota", target: null,
      reason: clear ? "already_unrated" : "clearing_disabled" };
  }
  if (current === result.rating) return { outcome: "unchanged", action: "match", target: current, reason: "rating_matches" };
  return { outcome: "updated", action: result.rating === 0 ? "clear" : "update", target: result.rating,
    reason: result.meetsThreshold ? "calculated_from_songs" : "below_quota" };
}

function createPlugin({ host, readConfig, log = () => {}, now = () => Date.now(), maxStateBytes = MAX_STATE_BYTES }) {
  let measuredState = null, reservedBytes = 0;
  let metricsState = null, metrics = null;
  function call(name, input = {}) {
    const response = host(name, input);
    if (!response || typeof response !== "object" || Array.isArray(response)) throw Error(`${name}: invalid response`);
    if (response.error) throw Error(`${name}: ${response.error}`);
    return response;
  }
  function api(endpoint, user, params = {}) {
    const query = Object.entries({ ...params, u: user }).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&");
    const raw = call("subsonicapi_call", { uri: `${endpoint}?${query}` }).responseJson;
    if (typeof raw !== "string") throw Error(`${endpoint}: missing JSON`);
    const response = JSON.parse(raw)?.["subsonic-response"];
    if (!response || response.status !== "ok") throw Error(`${endpoint}: ${response?.error?.message || "API failure"}`);
    if (response.type !== "navidrome" || response.openSubsonic !== true) throw Error("Navidrome OpenSubsonic responses are required");
    return response;
  }
  function get(key) { const r = call("kvstore_get", { key }); return r.exists ? decode(r.value) : null; }
  function put(key, value) { call("kvstore_set", { key, value: encode(value) }); }
  function event(level, eventName, data = {}) {
    log(level, `Automatic Ratings: ${JSON.stringify({ schemaVersion: 1, event: eventName, ...data })}`);
  }
  function assignedUsers() {
    const users = call("users_getusers").result ?? [];
    if (!Array.isArray(users) || users.some(u => !u || !validId(u.userName))) throw Error("Invalid assigned users");
    return [...new Set(users.map(u => u.userName))].sort(compare);
  }
  function grantedLibraries() {
    const libraries = call("library_getalllibraries").result ?? [];
    if (!Array.isArray(libraries) || libraries.some(l => !l || !Number.isSafeInteger(l.id) || l.id < 1)) throw Error("Invalid library grants");
    return [...new Set(libraries.map(l => l.id))].sort((a, b) => a - b);
  }
  function userScope(user, grants) {
    const folders = api("getMusicFolders", user).musicFolders;
    if (!folders || typeof folders !== "object" || !Array.isArray(folders.musicFolder ?? [])) throw Error("Invalid music folders response");
    const ids = (folders.musicFolder ?? []).map(f => {
      if (!f || !Number.isSafeInteger(f.id) || f.id < 1) throw Error("Invalid music folder");
      return f.id;
    });
    return [...new Set(ids.filter(id => grants.includes(id)))].sort((a, b) => a - b);
  }
  function assertNotScanning(user) {
    const status = api("getScanStatus", user).scanStatus;
    if (!status || typeof status.scanning !== "boolean") throw Error("Missing scan status");
    if (status.scanning) throw Error("Library scanner is active; retry after indexing finishes");
  }
  function freshState() {
    return { version: 3, active: false, signature: "", startedAt: 0, completedAt: null,
      users: [], grants: [], userIndex: 0, current: null, usersCompleted: 0,
      sourceReadStartedAt: null, sourceReadCompletedAt: null, sourceVerifiedAt: null, sourceReadMode: "album",
      totals: { albums: emptyCounts(), artists: emptyCounts(), sourceErrors: 0, scannedSongs: 0, ratedSongs: 0,
        preflightSongs: 0, usersSkipped: 0 } };
  }
  function loadState() {
    let state;
    try {
      state = get(STATE_KEY);
      if (!state) return freshState();
      if (state.version === 1 || state.version === 2) {
        event("info", "checkpoint_upgraded", { action: "wait_for_new_request", previousRunActive: state.active === true,
          reason: "snapshot_format_changed_ownership_retained" });
        state = freshState(); put(STATE_KEY, state); return state;
      }
      if (state.version !== 3 || typeof state.active !== "boolean" || typeof state.signature !== "string" ||
          !Array.isArray(state.users) || state.users.some(u => !validId(u)) || !Array.isArray(state.grants) ||
          state.grants.some(id => !Number.isSafeInteger(id) || id < 1) ||
          !Number.isSafeInteger(state.userIndex) || state.userIndex < 0 || state.userIndex > state.users.length ||
          state.usersCompleted !== state.userIndex ||
          ![state.startedAt, state.totals?.sourceErrors, state.totals?.scannedSongs, state.totals?.ratedSongs,
            state.totals?.preflightSongs, state.totals?.usersSkipped].every(n => Number.isSafeInteger(n) && n >= 0) ||
          state.totals.usersSkipped > state.usersCompleted ||
          !["album", "song_pages", "mixed"].includes(state.sourceReadMode) ||
          state.totals.ratedSongs > state.totals.scannedSongs ||
          !validSourceTimes(state) ||
          (state.completedAt !== null && (!Number.isSafeInteger(state.completedAt) || state.completedAt < 0)) ||
          !validCounts(state.totals?.albums) || !validCounts(state.totals?.artists) ||
          (state.active && state.userIndex === state.users.length) ||
          (state.current !== null && (!validCurrent(state.current) || state.current.user !== state.users[state.userIndex]))) {
        throw Error("Invalid saved state");
      }
      return state;
    } catch (error) {
      event("error", "state_reset", { reason: error.message, action: "wait_for_new_request" });
      state = freshState();
      put(STATE_KEY, state);
      return state;
    }
  }
  function validSourceTimes(value) {
    return [value.sourceReadStartedAt, value.sourceReadCompletedAt, value.sourceVerifiedAt].every(n =>
      n === null || (Number.isSafeInteger(n) && n >= 0));
  }
  function validCurrent(c) {
    const validAlbums = albums => Array.isArray(albums) && new Set(albums.map(a => a?.id)).size === albums.length &&
      albums.every(a => a && validId(a.id) && typeof a.name === "string" && Number.isSafeInteger(a.songCount) &&
        a.songCount >= 0 && c.scope.includes(a.libraryId));
    return c && validId(c.user) && ["inventory", "preflight", "preflight_check", "preflight_targets",
      "scan", "check_inventory", "verify", "artists"].includes(c.phase) &&
      Array.isArray(c.scope) && Array.isArray(c.albums) && Array.isArray(c.checkAlbums) &&
      c.scope.every(id => Number.isSafeInteger(id) && id > 0) && validAlbums(c.albums) && validAlbums(c.checkAlbums) &&
      [c.startedAt, c.libraryIndex, c.offset, c.index, c.verifyIndex, c.artistIndex, c.sourceErrors, c.scannedSongs,
        c.ratedSongs, c.preflightSongs].every(n => Number.isSafeInteger(n) && n >= 0) &&
      c.ratedSongs <= c.scannedSongs && validSourceTimes(c) && typeof c.sourceVerified === "boolean" &&
      typeof c.skipped === "boolean" && (c.skipReason === null || typeof c.skipReason === "string") &&
      ["album", "song_pages"].includes(c.sourceReadMode) && validPreflight(c) &&
      c.libraryIndex <= c.scope.length && c.index <= c.albums.length && c.verifyIndex <= c.albums.length &&
      validCounts(c.albumsSummary) && validCounts(c.artistsSummary) &&
      c.groups && typeof c.groups === "object" && !Array.isArray(c.groups) &&
      Object.entries(c.groups).every(([key, group]) => group && validId(group.id) && key === "id:" + group.id &&
        typeof group.name === "string" && Array.isArray(group.histogram) && group.histogram.length === 6 &&
        group.histogram.every(n => Number.isSafeInteger(n) && n >= 0)) &&
      c.seenSongs && typeof c.seenSongs === "object" && !Array.isArray(c.seenSongs) &&
      Object.entries(c.seenSongs).every(([key, value]) => key.startsWith("id:") && value === true) &&
      Array.isArray(c.sources) && c.sources.length === c.index && c.sources.every(s => typeof s === "string" || s === null) &&
      Array.isArray(c.artistIds) && c.artistIndex <= c.artistIds.length && new Set(c.artistIds).size === c.artistIds.length &&
      c.artistIds.every(key => Object.prototype.hasOwnProperty.call(c.groups, key)) &&
      typeof c.complete === "boolean" && (!c.complete || c.sources.every(s => s !== null));
  }
  function validPreflight(c) {
    const f = c.preflight;
    if (f === null) return !c.phase.startsWith("preflight");
    const object = x => x && typeof x === "object" && !Array.isArray(x);
    const count = n => Number.isSafeInteger(n) && n >= 0;
    return object(f) && [f.libraryIndex, f.songOffset, f.artistOffset, f.targetIndex, f.scannedSongs].every(count) &&
      f.libraryIndex <= c.scope.length && typeof f.songsDone === "boolean" && typeof f.artistsDone === "boolean" &&
      typeof f.ownershipChecked === "boolean" &&
      [f.readStartedAt, f.readCompletedAt].every(n => n === null || count(n)) &&
      object(f.counts) && Object.entries(f.counts).every(([key, n]) => key.startsWith("id:") && count(n)) &&
      object(f.seenSongs) && Object.entries(f.seenSongs).every(([key, n]) => key.startsWith("id:") && n === true) &&
      object(f.seenArtists) && Object.entries(f.seenArtists).every(([key, n]) => key.startsWith("lib:") && n === true) &&
      object(f.artistRatings) && Object.entries(f.artistRatings).every(([key, n]) => key.startsWith("id:") && Number.isInteger(n) && n >= 0 && n <= 5) &&
      object(f.expectedArtists) && Object.entries(f.expectedArtists).every(([key, n]) => key.startsWith("id:") && n === true) &&
      Array.isArray(f.targets) && f.targetIndex <= f.targets.length && f.targets.every(t => t && validId(t.id) &&
        ["album", "artist"].includes(t.kind) && Number.isInteger(t.rating) && t.rating > 0 && t.rating <= 5);
  }
  function freshMetrics(state) {
    return { startedAt: state.startedAt, snapshotBytes: 0, peakSnapshotBytes: 0, peakReservedBytes: 0, snapshotLimitBytes: maxStateBytes };
  }
  function loadMetrics(state) {
    if (metricsState === state) return;
    metricsState = state; metrics = freshMetrics(state);
    try {
      const saved = get(METRICS_KEY);
      if (saved && saved.startedAt === state.startedAt && Object.keys(metrics).every(key =>
          Number.isSafeInteger(saved[key]) && saved[key] >= 0)) metrics = { ...saved, snapshotLimitBytes: maxStateBytes };
    } catch (error) { event("warn", "snapshot_metrics_reset", { reason: error.message }); }
  }
  function snapshotMetrics(state) {
    loadMetrics(state);
    const { startedAt, ...sizes } = metrics;
    return { ...sizes, snapshotMetricsScope: "run" };
  }
  function storageLimit(state) {
    loadMetrics(state); metrics.peakReservedBytes = Math.max(metrics.peakReservedBytes, reservedBytes);
    event("error", "storage_limit", { action: "cancel_scan", reason: "Scan state capacity exhausted; no further ratings will be written",
      ...snapshotMetrics(state) });
    // Retain completed-run totals but discard the oversized partial snapshot.
    state.active = false; state.current = null; state.completedAt = now();
    put(METRICS_KEY, metrics); put(STATE_KEY, state);
    throw Error("Scan state limit exceeded; scan cancelled");
  }
  function measureState(state) {
    loadMetrics(state);
    measuredState = state; reservedBytes = asciiJSON(state).length;
  }
  function reserveState(state, bytes) {
    if (measuredState !== state) measureState(state);
    reservedBytes += bytes;
    metrics.peakReservedBytes = Math.max(metrics.peakReservedBytes, reservedBytes);
    if (reservedBytes > maxStateBytes) storageLimit(state);
  }
  function saveState(state) {
    loadMetrics(state);
    const json = asciiJSON(state);
    if (json.length > maxStateBytes) storageLimit(state);
    call("kvstore_set", { key: STATE_KEY, value: btoa(json) });
    metrics.snapshotBytes = json.length; metrics.peakSnapshotBytes = Math.max(metrics.peakSnapshotBytes, json.length);
    metrics.peakReservedBytes = Math.max(metrics.peakReservedBytes, json.length);
    put(METRICS_KEY, metrics);
    measuredState = state; reservedBytes = json.length;
  }
  function cancel(state, reason) {
    state.active = false; state.current = null; state.completedAt = now();
    saveState(state);
    event("warn", "run_cancelled", { reason, action: "wait_for_new_request" });
  }
  function startRun() {
    const settings = readSettings(readConfig), sig = signature(settings);
    let state = loadState();
    if (state.active && state.signature === sig) return { alreadyRunning: true };
    if (state.active) cancel(state, "calculation_or_safety_settings_changed");
    const users = assignedUsers(), grants = grantedLibraries();
    if (!settings.rate_albums && !settings.rate_artists) {
      event("warn", "run_skipped", { reason: "both_outputs_disabled" }); return { disabled: true };
    }
    if (!users.length || !grants.length) {
      event("warn", "run_skipped", { reason: users.length ? "no_library_grants" : "no_user_grants" });
      return { noAccess: true };
    }
    state = freshState();
    Object.assign(state, { active: true, signature: sig, users, grants, startedAt: now() });
    metricsState = state; metrics = freshMetrics(state);
    saveState(state);
    event("info", "run_started", { users: users.length, libraries: grants.length, dryRun: settings.dry_run });
    if (settings.audit_logging) event("info", "audit_config", { settings, sourceFormat: "structured_song_ratings_v1" });
    return { started: true };
  }
  function checkContext(state, settings) {
    if (state.signature !== signature(settings)) { cancel(state, "calculation_or_safety_settings_changed"); return false; }
    if (JSON.stringify(assignedUsers()) !== JSON.stringify(state.users) || JSON.stringify(grantedLibraries()) !== JSON.stringify(state.grants)) {
      cancel(state, "user_or_library_grants_changed"); return false;
    }
    if (state.current && JSON.stringify(userScope(state.current.user, state.grants)) !== JSON.stringify(state.current.scope)) {
      cancel(state, "user_library_access_changed"); return false;
    }
    return true;
  }
  function beginUser(state) {
    const user = state.users[state.userIndex];
    const scope = userScope(user, state.grants);
    state.current = { user, scope, startedAt: now(), phase: "inventory", libraryIndex: 0, offset: 0,
      albums: [], checkAlbums: [], index: 0, verifyIndex: 0, artistIndex: 0,
      groups: {}, seenSongs: {}, sources: [], artistIds: [], complete: true,
      sourceErrors: 0, scannedSongs: 0, ratedSongs: 0, sourceVerified: false, preflightSongs: 0,
      preflight: null, skipped: false, skipReason: null, sourceReadMode: "album",
      sourceReadStartedAt: null, sourceReadCompletedAt: null, sourceVerifiedAt: null,
      albumsSummary: emptyCounts(), artistsSummary: emptyCounts() };
    reserveState(state, asciiJSON(state.current).length);
    if (!scope.length) event("warn", "empty_scope", { user, reason: "no_accessible_granted_libraries" });
    else assertNotScanning(user);
  }
  function finishUser(state, settings) {
    const c = state.current;
    // Measure/checkpoint the full working state before discarding it. The small
    // completed checkpoint must not be mistaken for the active snapshot peak.
    saveState(state);
    event("info", "user_summary", { user: c.user, albums: c.albumsSummary, artists: c.artistsSummary,
      sourceErrors: c.sourceErrors, sourceComplete: c.complete, scannedSongs: c.scannedSongs,
      ratedSongs: c.ratedSongs, sourceVerified: c.sourceVerified, ...sourceTimes(c),
      skipped: c.skipped, skipReason: c.skipReason, preflightSongs: c.preflightSongs, ...snapshotMetrics(state),
      dryRun: settings.dry_run, elapsedMs: Math.max(0, now() - c.startedAt) });
    addCounts(state.totals.albums, c.albumsSummary); addCounts(state.totals.artists, c.artistsSummary);
    state.totals.sourceErrors += c.sourceErrors; state.totals.scannedSongs += c.scannedSongs;
    state.totals.ratedSongs += c.ratedSongs;
    state.totals.preflightSongs += c.preflightSongs;
    if (c.skipped) state.totals.usersSkipped++;
    state.usersCompleted++; state.userIndex++; state.current = null;
    if (state.userIndex === state.users.length) {
      state.active = false; state.completedAt = now();
      saveState(state);
      event("info", "run_summary", { users: state.usersCompleted, ...state.totals,
        ...sourceTimes(state),
        ...snapshotMetrics(state),
        dryRun: settings.dry_run, elapsedMs: Math.max(0, state.completedAt - state.startedAt) });
    }
  }
  function sourceTimes(value) {
    return { ratingsAsOf: value.sourceReadMode === "album" ? "per_album_read_time" :
      value.sourceReadMode === "song_pages" ? "per_song_page_read_time" : "per_source_read_time",
      sourceReadMode: value.sourceReadMode, sourceReadStartedAt: value.sourceReadStartedAt,
      sourceReadCompletedAt: value.sourceReadCompletedAt, sourceVerifiedAt: value.sourceVerifiedAt };
  }
  function inventoryPage(state, checking, settings) {
    const c = state.current;
    const list = checking ? c.checkAlbums : c.albums;
    if (c.libraryIndex === c.scope.length) {
      list.sort((a, b) => compare(a.id, b.id));
      if (checking) {
        if (c.phase === "preflight_check") {
          if (preflightInventorySignature(c.albums, settings) !== preflightInventorySignature(list, settings)) {
            c.albums = list; fallbackPreflight(c, "inventory_or_target_ratings_changed");
          } else { c.checkAlbums = []; c.phase = "preflight_targets"; }
          return;
        }
        if (inventorySignature(list) !== inventorySignature(c.albums)) {
          c.complete = false; c.sourceErrors++;
          event("warn", "artist_source_incomplete", { user: c.user, reason: "album_inventory_changed", action: "defer_artist_writes" });
        }
        c.phase = c.complete ? "verify" : "artists";
      } else {
        c.phase = "scan";
        if (!list.length) event("warn", "empty_inventory", { user: c.user, reason: "no_visible_albums_check_grants_and_scan_status" });
        else if (settings.skip_unrated_users && !settings.audit_logging) beginPreflight(state, settings);
      }
      return;
    }
    const container = api("getAlbumList2", c.user, { type: "alphabeticalByName", size: PAGE_SIZE,
      offset: c.offset, musicFolderId: c.scope[c.libraryIndex] }).albumList2;
    if (!container || typeof container !== "object" || !Array.isArray(container.album ?? [])) throw Error("Invalid album inventory");
    const page = container.album ?? [];
    if (page.length > PAGE_SIZE) throw Error("Oversized album inventory page");
    const seen = new Set(list.map(a => a.id));
    for (const album of page) {
      if (!album || !validId(album.id) || seen.has(album.id) || !Number.isSafeInteger(album.songCount) || album.songCount < 0) {
        throw Error("Invalid or duplicate album in inventory; library may be changing");
      }
      seen.add(album.id);
      const entry = { id: album.id, name: typeof album.name === "string" ? album.name : album.id,
        songCount: album.songCount, libraryId: c.scope[c.libraryIndex] };
      if (c.phase === "preflight_check" || !checking && settings.skip_unrated_users && !settings.audit_logging) {
        entry.rating = Number.isInteger(album.userRating) && album.userRating >= 0 && album.userRating <= 5 ? album.userRating : null;
        try { entry.artistIds = album.songCount ? credits(album.artists).map(a => a.id) : []; }
        catch (_) { entry.artistIds = null; }
      }
      list.push(entry);
      reserveState(state, asciiJSON(list[list.length - 1]).length + 1);
    }
    c.offset += page.length;
    // Continue until an explicit empty page, including after short pages. This
    // also tolerates servers imposing a lower page-size cap.
    if (!page.length) { c.libraryIndex++; c.offset = 0; }
  }
  function inventorySignature(albums) { return JSON.stringify(albums.map(a => [a.id, a.songCount, a.libraryId])); }
  function preflightInventorySignature(albums, settings) {
    return JSON.stringify(albums.map(a => [a.id, a.songCount, a.libraryId,
      settings.rate_albums && settings.album_clear_below_threshold ? a.rating : null,
      settings.rate_artists && settings.artist_clear_below_threshold && settings.artist_attribution === "album_artist" ? a.artistIds : null]));
  }
  function fallbackPreflight(c, reason) {
    c.preflight = null; c.phase = "scan"; c.libraryIndex = 0; c.offset = 0; c.checkAlbums = [];
    for (const album of c.albums) { delete album.rating; delete album.artistIds; }
    event("debug", "preflight_fallback", { user: c.user, reason, action: "full_album_scan" });
  }
  function beginPreflight(state, settings) {
    const c = state.current;
    if (!c.albums.some(a => a.songCount > 0)) return;
    const needArtists = settings.rate_artists && settings.artist_clear_below_threshold;
    const f = { libraryIndex: 0, songOffset: 0, artistOffset: 0, songsDone: false, artistsDone: !needArtists,
      counts: {}, seenSongs: {}, seenArtists: {}, artistRatings: {}, expectedArtists: {},
      targets: [], targetIndex: 0, ownershipChecked: false, scannedSongs: 0, readStartedAt: null, readCompletedAt: null };
    try {
      for (const album of c.albums) {
        if (settings.rate_albums && settings.album_clear_below_threshold &&
            (!Number.isInteger(album.rating) || album.rating < 0 || album.rating > 5)) {
          throw Error("Album inventory ratings are unavailable");
        }
        f.counts["id:" + album.id] = 0;
        if (needArtists && album.songCount && settings.artist_attribution === "album_artist") {
          if (!Array.isArray(album.artistIds) || !album.artistIds.length || album.artistIds.some(id => !validId(id))) throw Error("Album inventory credits are unavailable");
          for (const id of album.artistIds) f.expectedArtists["id:" + id] = true;
        }
      }
    } catch (error) { fallbackPreflight(c, error.message); return; }
    c.preflight = f; c.phase = "preflight";
    reserveState(state, asciiJSON(f).length);
  }
  function preflightPage(state, settings) {
    const c = state.current, f = c.preflight;
    const needArtists = settings.rate_artists && settings.artist_clear_below_threshold;
    try {
      if (f.libraryIndex === c.scope.length) {
        const expected = c.albums.reduce((sum, a) => sum + a.songCount, 0);
        if (expected !== f.scannedSongs || Object.keys(f.seenSongs).length !== expected ||
            c.albums.some(a => f.counts["id:" + a.id] !== a.songCount)) throw Error("Bulk song inventory is incomplete");
        if (needArtists && Object.keys(f.expectedArtists).some(key => !Object.prototype.hasOwnProperty.call(f.artistRatings, key))) {
          throw Error("Bulk artist inventory is incomplete");
        }
        if (settings.rate_albums && settings.album_clear_below_threshold) for (const album of c.albums) {
          if (album.songCount && album.rating > 0) f.targets.push({ kind: "album", id: album.id, rating: album.rating });
        }
        if (needArtists) for (const key of Object.keys(f.expectedArtists)) {
          if (f.artistRatings[key] > 0) f.targets.push({ kind: "artist", id: key.slice(3), rating: f.artistRatings[key] });
        }
        reserveState(state, asciiJSON(f.targets).length);
        c.phase = "preflight_check"; c.libraryIndex = 0; c.offset = 0;
        return;
      }
      const libraryId = c.scope[f.libraryIndex];
      const startedAt = now();
      const result = api("search3", c.user, { query: '""', musicFolderId: libraryId,
        songCount: f.songsDone ? 0 : PAGE_SIZE, songOffset: f.songOffset,
        artistCount: f.artistsDone ? 0 : PAGE_SIZE, artistOffset: f.artistOffset, albumCount: 0 }).searchResult3;
      if (!result || typeof result !== "object" || Array.isArray(result) ||
          !Array.isArray(result.song ?? []) || !Array.isArray(result.artist ?? [])) throw Error("Invalid bulk search response");
      const songs = result.song ?? [], artists = result.artist ?? [];
      if (songs.length > PAGE_SIZE || artists.length > PAGE_SIZE || (f.songsDone && songs.length) ||
          (f.artistsDone && artists.length)) throw Error("Invalid bulk search pagination");
      c.preflightSongs += songs.length;
      if (f.readStartedAt === null) f.readStartedAt = startedAt;
      const scopedAlbums = new Map(c.albums.filter(a => a.libraryId === libraryId).map(a => [a.id, a]));
      let growth = 0;
      for (const song of songs) {
        if (!song || !validId(song.id) || !scopedAlbums.has(song.albumId) || song.isDir === true ||
            Object.prototype.hasOwnProperty.call(f.seenSongs, "id:" + song.id)) throw Error("Invalid, duplicate, or out-of-scope bulk song");
        const rating = starRating(song.userRating, !Object.prototype.hasOwnProperty.call(song, "userRating"));
        if (rating > 0) { fallbackPreflight(c, "rated_song_found"); return; }
        f.seenSongs["id:" + song.id] = true; f.counts["id:" + song.albumId]++; f.scannedSongs++;
        growth += asciiJSON("id:" + song.id).length + 22;
        if (needArtists && settings.artist_attribution === "performing_artist") for (const artist of credits(song.artists)) {
          const key = "id:" + artist.id;
          if (!Object.prototype.hasOwnProperty.call(f.expectedArtists, key)) {
            f.expectedArtists[key] = true; growth += asciiJSON(key).length + 6;
          }
        }
      }
      if (songs.length) f.readCompletedAt = now();
      for (const artist of artists) {
        if (!artist || !validId(artist.id)) throw Error("Invalid bulk artist");
        const rating = starRating(artist.userRating, !Object.prototype.hasOwnProperty.call(artist, "userRating"));
        const key = "id:" + artist.id, seenKey = `lib:${libraryId}:${key}`;
        if (Object.prototype.hasOwnProperty.call(f.seenArtists, seenKey) ||
            Object.prototype.hasOwnProperty.call(f.artistRatings, key) && f.artistRatings[key] !== rating) throw Error("Bulk artist inventory changed");
        f.seenArtists[seenKey] = true; growth += asciiJSON(seenKey).length + 6;
        if (!Object.prototype.hasOwnProperty.call(f.artistRatings, key)) growth += asciiJSON(key).length + 3;
        f.artistRatings[key] = rating;
      }
      reserveState(state, growth);
      f.songOffset += songs.length; f.artistOffset += artists.length;
      if (!songs.length) f.songsDone = true;
      if (!artists.length) f.artistsDone = true;
      if (f.songsDone && f.artistsDone) {
        f.libraryIndex++; f.songOffset = 0; f.artistOffset = 0; f.songsDone = false; f.artistsDone = !needArtists;
      }
    } catch (error) {
      if (!state.active) throw error;
      fallbackPreflight(c, error.message);
    }
  }
  function preflightTarget(state, settings) {
    const c = state.current, f = c.preflight;
    if (!f.ownershipChecked) {
      try {
        const prefix = PREFIX + "owner:" + JSON.stringify([c.user]).slice(0, -1) + ",";
        const listed = call("kvstore_list", { prefix });
        // Navidrome omits an empty keys slice, just like its other omitempty
        // collections. Explicit malformed values must still fall back.
        const keys = Object.prototype.hasOwnProperty.call(listed, "keys") ? listed.keys : [];
        if (!Array.isArray(keys)) throw Error("Ownership inventory is unavailable");
        for (const key of keys) {
          if (typeof key !== "string" || !key.startsWith(prefix)) throw Error("Invalid ownership inventory");
          const tuple = JSON.parse(key.slice((PREFIX + "owner:").length));
          if (!Array.isArray(tuple) || tuple.length !== 3 || tuple[0] !== c.user ||
              !["album", "artist"].includes(tuple[1]) || !validId(tuple[2])) throw Error("Invalid ownership key");
          if (settings[`rate_${tuple[1]}s`]) {
            // Even a currently zero target may be a newly observed manual
            // override or an interrupted write. Do not skip that evidence.
            fallbackPreflight(c, "ownership_history_requires_full_evaluation"); return;
          }
        }
        f.ownershipChecked = true;
      } catch (error) { fallbackPreflight(c, error.message); }
      return;
    }
    if (f.targetIndex < f.targets.length) {
      const target = f.targets[f.targetIndex++];
      try {
        const owner = resolveOwner(get(ownerKey(c.user, target.kind, target.id)), target.rating).owner;
        if (settings[`${target.kind}_rating_policy`] === "replace" || owner && !owner.manual && owner.rating !== null) {
          fallbackPreflight(c, "existing_rating_requires_full_evaluation");
        }
      } catch (error) { fallbackPreflight(c, error.message); }
      return;
    }
    if (!checkContext(state, readSettings(readConfig))) return;
    assertNotScanning(c.user);
    c.skipped = true; c.skipReason = "no_rated_songs_or_eligible_clears"; c.scannedSongs = f.scannedSongs;
    c.sourceReadMode = "song_pages"; c.sourceReadStartedAt = f.readStartedAt; c.sourceReadCompletedAt = f.readCompletedAt;
    state.sourceReadMode = state.sourceReadStartedAt === null || state.sourceReadMode === "song_pages" ? "song_pages" : "mixed";
    state.sourceReadStartedAt = state.sourceReadStartedAt === null ? f.readStartedAt : Math.min(state.sourceReadStartedAt, f.readStartedAt);
    state.sourceReadCompletedAt = Math.max(state.sourceReadCompletedAt ?? 0, f.readCompletedAt ?? 0);
    event("warn", "user_skipped", { user: c.user, reason: c.skipReason, scannedSongs: c.scannedSongs,
      action: "skip_item_evaluations", sourceReadMode: c.sourceReadMode });
    finishUser(state, settings);
  }
  function itemEvent(kind, item, c, result, current, decision, settings, error = null) {
    const data = { action: decision.action, kind, user: c.user, id: item.id, name: item.name,
      existingRating: current, proposedRating: decision.target, score: result?.score ?? null,
      totalSongs: result?.totalSongs ?? null, ratedSongs: result?.ratedSongs ?? null,
      unratedSongs: result?.unratedSongs ?? null, requiredRatedSongs: result?.requiredRatedSongs ?? null,
      meetsThreshold: result?.meetsThreshold ?? null, dryRun: settings.dry_run,
      reason: decision.reason, error };
    const level = decision.action === "failed" ? "error" : settings.audit_logging ? "info" : settings.detail_logging;
    if (level !== "off") event(level, "item", data);
  }
  function countOutcome(summary, result, decision, manualOverride, adopted) {
    summary.processed++; summary[decision.outcome]++;
    if (result?.totalSongs > 0 && !result.meetsThreshold) summary.quotaFailures++;
    if (manualOverride) summary.manualOverrides++;
    if (adopted) summary.adopted++;
    if (decision.outcome === "updated") {
      summary.ratingCounts[decision.target]++;
      if (decision.target === 0) summary.cleared++;
    }
  }
  function processTarget(state, kind, item, histogram, current, settings, fresh) {
    const c = state.current, summary = c[`${kind}sSummary`];
    const result = calculateFor(kind, histogram, settings);
    let decision, manualOverride = false, adopted = false;
    try {
      const key = ownerKey(c.user, kind, item.id), storedOwner = get(key);
      const resolved = resolveOwner(storedOwner, current);
      let owner = resolved.owner;
      manualOverride = resolved.manualOverride;
      decision = decideRating(result, current, owner, settings[`${kind}_rating_policy`], settings[`${kind}_clear_below_threshold`]);
      // A wholly unrated source needs no second pass for no-op decisions. An
      // eligible clear/adoption still requires full inventory/source validation.
      if (kind === "artist" && !c.sourceVerified && decision.target !== null &&
          (decision.outcome === "updated" || settings.artist_rating_policy === "replace")) return { needsVerification: true };
      if (!settings.dry_run && storedOwner && JSON.stringify(owner) !== JSON.stringify(storedOwner)) put(key, owner);
      if (decision.target !== null && (decision.outcome === "updated" || settings[`${kind}_rating_policy`] === "replace")) {
        const before = fresh();
        if (before !== current) throw Error("Rating changed concurrently; deferred");
        if (!checkContext(state, readSettings(readConfig))) throw Error("Scan context changed; deferred");
        assertNotScanning(c.user);
        adopted = decision.outcome === "unchanged" && (owner?.rating !== current || owner?.manual);
        if (!settings.dry_run) {
          if (decision.outcome === "updated") {
            // Persist intent before touching Navidrome. A lost response or crash
            // can then be recovered from the observed rating on the next scan.
            put(key, { version: 1, rating: owner?.rating ?? null, manual: owner?.manual ?? false,
              pending: { before: current, target: decision.target } });
            api("setRating", c.user, { id: item.id, rating: decision.target });
            const endpoint = kind === "album" ? "getAlbum" : "getArtist";
            const verified = api(endpoint, c.user, { id: item.id })[kind];
            if (!verified || verified.id !== item.id || starRating(verified.userRating, kind === "artist") !== decision.target) {
              throw Error("Rating write could not be verified; intent retained for recovery");
            }
          }
          put(key, { version: 1, rating: decision.target, manual: false, pending: null });
        }
        if (settings.dry_run && decision.outcome === "updated") decision.action = decision.target === 0 ? "preview_clear" : "preview_update";
        if (adopted) decision.action = settings.dry_run ? "preview_adopt" : "adopt";
      }
    } catch (error) {
      decision = { outcome: "failed", action: "failed", target: null, reason: "target_failed" };
      itemEvent(kind, item, c, result, current, decision, settings, error.message);
      countOutcome(summary, result, decision, manualOverride, false);
      return;
    }
    countOutcome(summary, result, decision, manualOverride, adopted);
    itemEvent(kind, item, c, result, current, decision, settings);
  }
  function scanAlbum(state, settings) {
    const c = state.current;
    if (c.index === c.albums.length) {
      c.artistIds = Object.keys(c.groups).sort(compare);
      reserveState(state, asciiJSON(c.artistIds).length);
      c.phase = settings.rate_artists && c.ratedSongs > 0 ? "check_inventory" : "artists";
      c.libraryIndex = 0; c.offset = 0;
      if (c.complete && c.scannedSongs > 0 && c.ratedSongs === 0) event("warn", "user_unrated", {
        user: c.user, reason: "no_rated_songs_in_scope", action: "skip_unused_artist_source_verification" });
      return;
    }
    const item = c.albums[c.index++];
    const readStartedAt = now();
    if (c.sourceReadStartedAt === null) c.sourceReadStartedAt = readStartedAt;
    if (state.sourceReadStartedAt === null) { state.sourceReadStartedAt = readStartedAt; state.sourceReadMode = "album"; }
    else if (state.sourceReadMode !== "album") state.sourceReadMode = "mixed";
    let album, validated;
    try {
      album = api("getAlbum", c.user, { id: item.id }).album;
      validated = validateAlbum(album, item);
      for (const song of validated.songs) if (Object.prototype.hasOwnProperty.call(c.seenSongs, "id:" + song.id)) {
        throw Error("Song appears in multiple albums; source is inconsistent");
      }
      for (const song of validated.songs) {
        reserveState(state, asciiJSON("id:" + song.id).length + 6);
        c.seenSongs["id:" + song.id] = true;
      }
      c.scannedSongs += validated.songs.length;
      c.ratedSongs += validated.songs.length - validated.histogram[0];
      c.sourceReadCompletedAt = now(); state.sourceReadCompletedAt = c.sourceReadCompletedAt;
    } catch (error) {
      if (!state.active) throw error;
      c.complete = false; c.sourceErrors++; c.sources[c.index - 1] = null;
      const decision = { outcome: "failed", action: "failed", target: null, reason: "source_album_failed" };
      if (settings.rate_albums) countOutcome(c.albumsSummary, null, decision, false, false);
      itemEvent("album", item, c, null, null, decision, settings, error.message);
      return;
    }
    let growth = 5, attributed = null;
    try {
      attributed = attributedSongs(album, validated.songs, settings);
      c.sources[c.index - 1] = fingerprint(attributed);
      growth += asciiJSON(c.sources[c.index - 1]).length + 1;
      for (const song of attributed) for (const artist of song.artists) {
        const key = "id:" + artist.id;
        if (!Object.prototype.hasOwnProperty.call(c.groups, key)) {
          c.groups[key] = { ...artist, histogram: emptyHistogram() };
          growth += asciiJSON(key).length + asciiJSON(c.groups[key]).length + 2;
        }
        growth += 16; // Worst-case decimal digit growth of a safe-integer bin.
        c.groups[key].histogram[song.rating]++;
      }
    } catch (error) {
      c.complete = false; c.sourceErrors++; c.sources[c.index - 1] = null;
      event("error", "artist_source_incomplete", { user: c.user, id: item.id, reason: error.message, action: "defer_artist_writes" });
    }
    reserveState(state, growth);
    if (settings.audit_logging) event("info", "source_album", { user: c.user, albumId: item.id,
      attribution: settings.artist_attribution, artistSourceComplete: attributed !== null,
      readStartedAt, readCompletedAt: c.sourceReadCompletedAt,
      albumArtistIds: Array.isArray(album.artists) ? album.artists.map(a => a?.id ?? null) : null,
      songs: validated.songs.map(song => [song.id, song.userRating,
        Array.isArray(song.artists) ? song.artists.map(a => a?.id ?? null) : null]) });
    if (settings.rate_albums) {
      const original = JSON.stringify(validated.songs.map(song => [song.id, song.userRating]));
      processTarget(state, "album", item, validated.histogram, album.userRating, settings, () => {
        const latest = api("getAlbum", c.user, { id: item.id }).album;
        const data = validateAlbum(latest, item);
        if (JSON.stringify(data.songs.map(song => [song.id, song.userRating])) !== original) throw Error("Source songs changed before album write");
        return latest.userRating;
      });
    }
  }
  function verifySource(state, settings) {
    const c = state.current;
    if (c.verifyIndex === c.albums.length) {
      c.phase = "artists"; c.sourceVerified = true; c.sourceVerifiedAt = now();
      state.sourceVerifiedAt = c.sourceVerifiedAt; return;
    }
    const i = c.verifyIndex++, item = c.albums[i];
    try {
      const album = api("getAlbum", c.user, { id: item.id }).album;
      const data = validateAlbum(album, item);
      if (fingerprint(attributedSongs(album, data.songs, settings)) !== c.sources[i]) throw Error("Source songs or attribution changed during the scan");
    } catch (error) {
      c.complete = false; c.sourceErrors++; c.phase = "artists";
      event("warn", "artist_source_incomplete", { user: c.user, reason: error.message, action: "defer_artist_writes" });
    }
  }
  function processArtist(state, settings) {
    const c = state.current;
    if (!settings.rate_artists || c.artistIndex === c.artistIds.length) { finishUser(state, settings); return; }
    const item = c.groups[c.artistIds[c.artistIndex++]];
    const result = calculateFor("artist", item.histogram, settings);
    if (!c.complete) {
      const decision = { outcome: "failed", action: "blocked", target: null, reason: "incomplete_artist_source" };
      countOutcome(c.artistsSummary, result, decision, false, false);
      itemEvent("artist", item, c, result, null, decision, settings);
      return;
    }
    try {
      const current = api("getArtist", c.user, { id: item.id }).artist;
      if (!current || current.id !== item.id) throw Error("Invalid artist response");
      const rating = starRating(current.userRating, !Object.prototype.hasOwnProperty.call(current, "userRating"));
      const outcome = processTarget(state, "artist", item, item.histogram, rating, settings, () => {
        const latest = api("getArtist", c.user, { id: item.id }).artist;
        if (!latest || latest.id !== item.id) throw Error("Invalid fresh artist response");
        return starRating(latest.userRating, !Object.prototype.hasOwnProperty.call(latest, "userRating"));
      });
      if (outcome?.needsVerification) {
        c.artistIndex--; c.phase = "check_inventory"; c.libraryIndex = 0; c.offset = 0;
      }
    } catch (error) {
      const decision = { outcome: "failed", action: "failed", target: null, reason: "artist_read_failed" };
      countOutcome(c.artistsSummary, result, decision, false, false);
      itemEvent("artist", item, c, result, null, decision, settings, error.message);
    }
  }
  function refresh(deadline = now() + BUDGET_MS, state = loadState()) {
    const settings = readSettings(readConfig);
    if (!state.active) return { waiting: true };
    if (!checkContext(state, settings)) return { cancelled: true };
    if (measuredState !== state) measureState(state);
    let units = 0;
    try {
      while (state.active && units < settings.batch_size && (units === 0 || now() < deadline)) {
        reserveState(state, UNIT_GROWTH_BYTES);
        if (!state.current) beginUser(state);
        const c = state.current;
        if (!c.scope.length) finishUser(state, settings);
        else if (c.phase === "inventory") inventoryPage(state, false, settings);
        else if (c.phase === "preflight") preflightPage(state, settings);
        else if (c.phase === "preflight_check") inventoryPage(state, true, settings);
        else if (c.phase === "preflight_targets") preflightTarget(state, settings);
        else if (c.phase === "scan") scanAlbum(state, settings);
        else if (c.phase === "check_inventory") inventoryPage(state, true, settings);
        else if (c.phase === "verify") verifySource(state, settings);
        else processArtist(state, settings);
        units++;
        if (state.active && state.signature !== signature(readSettings(readConfig))) {
          cancel(state, "calculation_or_safety_settings_changed"); break;
        }
      }
      saveState(state);
    } catch (error) {
      // A source/inventory failure must not later turn into a partial artist
      // calculation. End the affected user's scan; the next run retries it.
      if (state.current) {
        state.current.complete = false; state.current.sourceErrors++;
        event("error", "user_scan_failed", { user: state.current.user, reason: error.message, action: "retry_next_run" });
        finishUser(state, settings);
        saveState(state);
      }
      throw error;
    }
    return { units, active: state.active };
  }
  function recurringWorker(settings) {
    call("scheduler_schedulerecurring", { cronExpression: `@every ${settings.batch_interval_seconds}s`,
      payload: "worker", scheduleId: WORKER_ID });
  }
  function scheduleDaily(settings, replace = false) {
    if (replace) {
      try { call("scheduler_cancelschedule", { scheduleId: DAILY_ID }); }
      catch (error) { if (!/schedule ID .* not found/.test(error.message)) throw error; }
    }
    const [hour, minute] = settings.run_time_utc.split(":").map(Number);
    call("scheduler_schedulerecurring", { cronExpression: `CRON_TZ=UTC ${minute} ${hour} * * *`, payload: "daily", scheduleId: DAILY_ID });
    put(SCHEDULE_KEY, settings.run_time_utc);
  }
  function initialize() {
    const settings = readSettings(readConfig);
    scheduleDaily(settings); recurringWorker(settings);
    event("info", "enabled", { version: VERSION, runTimeUTC: settings.run_time_utc,
      dryRun: settings.dry_run, attribution: settings.artist_attribution, callbackBudgetMs: BUDGET_MS });
    if (!assignedUsers().length || !grantedLibraries().length) event("warn", "missing_grants", { action: "grant_users_and_libraries_then_restart" });
  }
  function triggers(settings) {
    const wasRequested = get(MANUAL_KEY) === true;
    if (wasRequested !== settings.run_now) {
      if (settings.run_now) event("info", "manual_request", { ...startRun(), action: "consume_once" });
      put(MANUAL_KEY, settings.run_now);
    }
    const request = get(DAILY_KEY), handled = get(HANDLED_KEY);
    if (request && JSON.stringify(request) !== JSON.stringify(handled)) {
      if (!Number.isSafeInteger(request.at) || request.at < 0 || typeof request.signature !== "string") throw Error("Invalid daily request");
      const state = loadState();
      if (request.signature !== signature(settings)) event("warn", "daily_request_cancelled", { reason: "settings_changed" });
      else if (state.completedAt === null || state.completedAt < request.at) startRun();
      put(HANDLED_KEY, request);
    }
  }
  function onSchedule(input) {
    const settings = readSettings(readConfig);
    if (input?.payload === "daily") {
      put(DAILY_KEY, { at: now(), signature: signature(settings) });
      return { requested: true };
    }
    if (input?.payload !== "worker") throw Error("Unknown scheduler payload");
    try { call("scheduler_cancelschedule", { scheduleId: WORKER_ID }); }
    catch (error) { if (/schedule ID .* not found/.test(error.message)) return { busy: true }; throw error; }
    const callbackStartedAt = now(), deadline = callbackStartedAt + BUDGET_MS;
    try {
      if (get(SCHEDULE_KEY) !== settings.run_time_utc) {
        scheduleDaily(settings, true);
        event("info", "schedule_updated", { runTimeUTC: settings.run_time_utc });
      }
      triggers(settings);
      // Navidrome creates a fresh WASM instance per callback. Load/validate the
      // persisted snapshot once, then reuse it across chained checkpoints.
      const state = loadState();
      let batches = 0, units = 0;
      do {
        const result = refresh(deadline, state);
        if (result.waiting || result.cancelled) return { ...result, batches, units };
        batches++; units += result.units;
        if (!result.active) return { batches, units, active: false };
      } while (now() < deadline);
      event("info", "run_progress", { usersCompleted: state.usersCompleted, users: state.users.length,
        user: state.current?.user ?? null, phase: state.current?.phase ?? "next_user",
        scannedAlbums: state.current?.index ?? 0, verifiedAlbums: state.current?.verifyIndex ?? 0,
        totalAlbums: state.current?.albums.length ?? 0, evaluatedArtists: state.current?.artistIndex ?? 0,
        totalArtists: state.current?.artistIds.length ?? 0, batches, units,
        preflightSongs: state.current?.preflightSongs ?? 0, ...snapshotMetrics(state),
        callbackMs: Math.max(0, now() - callbackStartedAt) });
      return { batches, units, active: true };
    } finally { recurringWorker(settings); }
  }
  return { initialize, startRun, refresh, onSchedule };
}

function invokeHost(name, request) {
  const input = Memory.fromString(JSON.stringify(request));
  let output;
  try {
    const offset = Host.getFunctions()[name](input.offset);
    output = Memory.find(offset);
    return JSON.parse(output.readString());
  } finally { if (output) output.free(); input.free(); }
}
function runtimePlugin() {
  return createPlugin({ host: invokeHost, readConfig: key => Config.get(key), log: (level, message) => console[level](message) });
}
function nd_on_init() { runtimePlugin().initialize(); return 0; }
function nd_scheduler_callback() { runtimePlugin().onSchedule(JSON.parse(Host.inputString())); return 0; }
function automatic_ratings_calculate() {
  const input = JSON.parse(Host.inputString());
  Host.outputString(JSON.stringify(calculateRating(input.histogram, input.options))); return 0;
}
module.exports = typeof Host === "undefined" ? { DEFAULTS, VERSION, readSettings, signature, calculateRating,
  validateAlbum, attributedSongs, fingerprint, emptyCounts, validCounts, decideRating, resolveOwner,
  ownerKey, encode, decode, createPlugin } : { nd_on_init, nd_scheduler_callback, automatic_ratings_calculate };
