"use strict";

const VERSION = "0.1.0";
const PREFIX = "automatic-ratings:v1:";
const STATE_KEY = PREFIX + "scan";
const MANUAL_KEY = PREFIX + "manual";
const DAILY_KEY = PREFIX + "daily";
const HANDLED_KEY = PREFIX + "daily-handled";
const SCHEDULE_KEY = PREFIX + "schedule";
const WORKER_ID = "automatic-ratings-worker";
const DAILY_ID = "automatic-ratings-daily";
const BUDGET_MS = 20000;
const PAGE_SIZE = 500;
const MAX_STATE_BYTES = 24 * 1024 * 1024;
const STAR_NAMES = ["one", "two", "three", "four", "five"];
const DEFAULTS = {
  rate_albums: true, rate_artists: true, artist_attribution: "album_artist",
  album_rating_policy: "preserve", artist_rating_policy: "preserve",
  album_minimum_rated_percent: 30, artist_minimum_rated_percent: 30,
  album_minimum_rated_songs: 1, artist_minimum_rated_songs: 1,
  album_clear_below_threshold: true, artist_clear_below_threshold: true,
  dry_run: true, run_now: false, run_time_utc: "03:00",
  batch_size: 25, batch_interval_seconds: 10, detail_logging: "debug",
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
  const score = meetsThreshold ? sum / weight : null;
  return { score, rating: meetsThreshold ? Math.round(score) : 0, totalSongs, ratedSongs, unratedSongs,
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
function encode(value) {
  return btoa(JSON.stringify(value).replace(/[\u007f-\uffff]/g,
    ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`));
}
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
    return { version: 1, active: false, signature: "", startedAt: 0, completedAt: null,
      users: [], grants: [], userIndex: 0, current: null, usersCompleted: 0,
      totals: { albums: emptyCounts(), artists: emptyCounts(), sourceErrors: 0, scannedSongs: 0 } };
  }
  function loadState() {
    let state;
    try {
      state = get(STATE_KEY);
      if (!state) return freshState();
      if (state.version !== 1 || typeof state.active !== "boolean" || typeof state.signature !== "string" ||
          !Array.isArray(state.users) || state.users.some(u => !validId(u)) || !Array.isArray(state.grants) ||
          state.grants.some(id => !Number.isSafeInteger(id) || id < 1) ||
          !Number.isSafeInteger(state.userIndex) || state.userIndex < 0 || state.userIndex > state.users.length ||
          state.usersCompleted !== state.userIndex ||
          ![state.startedAt, state.totals?.sourceErrors, state.totals?.scannedSongs].every(n => Number.isSafeInteger(n) && n >= 0) ||
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
  function validCurrent(c) {
    const validAlbums = albums => Array.isArray(albums) && new Set(albums.map(a => a?.id)).size === albums.length &&
      albums.every(a => a && validId(a.id) && typeof a.name === "string" && Number.isSafeInteger(a.songCount) &&
        a.songCount >= 0 && c.scope.includes(a.libraryId));
    return c && validId(c.user) && ["inventory", "scan", "check_inventory", "verify", "artists"].includes(c.phase) &&
      Array.isArray(c.scope) && Array.isArray(c.albums) && Array.isArray(c.checkAlbums) &&
      c.scope.every(id => Number.isSafeInteger(id) && id > 0) && validAlbums(c.albums) && validAlbums(c.checkAlbums) &&
      [c.startedAt, c.libraryIndex, c.offset, c.index, c.verifyIndex, c.artistIndex, c.sourceErrors, c.scannedSongs].every(n => Number.isSafeInteger(n) && n >= 0) &&
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
  function saveState(state) {
    const value = encode(state);
    if (value.length * 3 / 4 > maxStateBytes) {
      event("error", "storage_limit", { action: "cancel_scan", reason: "Scan state exceeds the configured build limit; no artist ratings will be written" });
      // Retain completed-run totals but discard the oversized partial snapshot.
      state.active = false; state.current = null; state.completedAt = now();
      put(STATE_KEY, state);
      throw Error("Scan state limit exceeded; scan cancelled");
    }
    call("kvstore_set", { key: STATE_KEY, value });
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
    saveState(state);
    event("info", "run_started", { users: users.length, libraries: grants.length, dryRun: settings.dry_run });
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
      sourceErrors: 0, scannedSongs: 0, albumsSummary: emptyCounts(), artistsSummary: emptyCounts() };
    if (!scope.length) event("warn", "empty_scope", { user, reason: "no_accessible_granted_libraries" });
    else assertNotScanning(user);
  }
  function finishUser(state, settings) {
    const c = state.current;
    event("info", "user_summary", { user: c.user, albums: c.albumsSummary, artists: c.artistsSummary,
      sourceErrors: c.sourceErrors, sourceComplete: c.complete, scannedSongs: c.scannedSongs,
      dryRun: settings.dry_run, elapsedMs: Math.max(0, now() - c.startedAt) });
    addCounts(state.totals.albums, c.albumsSummary); addCounts(state.totals.artists, c.artistsSummary);
    state.totals.sourceErrors += c.sourceErrors; state.totals.scannedSongs += c.scannedSongs;
    state.usersCompleted++; state.userIndex++; state.current = null;
    if (state.userIndex === state.users.length) {
      state.active = false; state.completedAt = now();
      event("info", "run_summary", { users: state.usersCompleted, ...state.totals,
        dryRun: settings.dry_run, elapsedMs: Math.max(0, state.completedAt - state.startedAt) });
    }
  }
  function inventoryPage(c, checking) {
    const list = checking ? c.checkAlbums : c.albums;
    if (c.libraryIndex === c.scope.length) {
      list.sort((a, b) => compare(a.id, b.id));
      if (checking) {
        if (inventorySignature(list) !== inventorySignature(c.albums)) {
          c.complete = false; c.sourceErrors++;
          event("warn", "artist_source_incomplete", { user: c.user, reason: "album_inventory_changed", action: "defer_artist_writes" });
        }
        c.phase = c.complete ? "verify" : "artists";
      } else {
        c.phase = "scan";
        if (!list.length) event("warn", "empty_inventory", { user: c.user, reason: "no_visible_albums_check_grants_and_scan_status" });
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
      list.push({ id: album.id, name: typeof album.name === "string" ? album.name : album.id,
        songCount: album.songCount, libraryId: c.scope[c.libraryIndex] });
    }
    c.offset += page.length;
    // Continue until an explicit empty page, including after short pages. This
    // also tolerates servers imposing a lower page-size cap.
    if (!page.length) { c.libraryIndex++; c.offset = 0; }
  }
  function inventorySignature(albums) { return JSON.stringify(albums.map(a => [a.id, a.songCount, a.libraryId])); }
  function itemEvent(kind, item, c, result, current, decision, settings, error = null) {
    const data = { action: decision.action, kind, user: c.user, id: item.id, name: item.name,
      existingRating: current, proposedRating: decision.target, score: result?.score ?? null,
      totalSongs: result?.totalSongs ?? null, ratedSongs: result?.ratedSongs ?? null,
      unratedSongs: result?.unratedSongs ?? null, requiredRatedSongs: result?.requiredRatedSongs ?? null,
      meetsThreshold: result?.meetsThreshold ?? null, dryRun: settings.dry_run,
      reason: decision.reason, error };
    const level = decision.action === "failed" ? "error" : settings.detail_logging;
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
    // Refuse rating writes if the in-memory source snapshot could no longer
    // be checkpointed. Checking only at the end of a batch is too late.
    if (encode(state).length * 3 / 4 > maxStateBytes) saveState(state);
    const c = state.current, summary = c[`${kind}sSummary`];
    const result = calculateFor(kind, histogram, settings);
    let decision, manualOverride = false, adopted = false;
    try {
      const key = ownerKey(c.user, kind, item.id), storedOwner = get(key);
      const resolved = resolveOwner(storedOwner, current);
      let owner = resolved.owner;
      manualOverride = resolved.manualOverride;
      if (!settings.dry_run && storedOwner && JSON.stringify(owner) !== JSON.stringify(storedOwner)) put(key, owner);
      decision = decideRating(result, current, owner, settings[`${kind}_rating_policy`], settings[`${kind}_clear_below_threshold`]);
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
      c.phase = settings.rate_artists ? "check_inventory" : "artists";
      c.libraryIndex = 0; c.offset = 0;
      return;
    }
    const item = c.albums[c.index++];
    let album, validated;
    try {
      album = api("getAlbum", c.user, { id: item.id }).album;
      validated = validateAlbum(album, item);
      for (const song of validated.songs) if (Object.prototype.hasOwnProperty.call(c.seenSongs, "id:" + song.id)) {
        throw Error("Song appears in multiple albums; source is inconsistent");
      }
      for (const song of validated.songs) c.seenSongs["id:" + song.id] = true;
      c.scannedSongs += validated.songs.length;
    } catch (error) {
      c.complete = false; c.sourceErrors++; c.sources[c.index - 1] = null;
      const decision = { outcome: "failed", action: "failed", target: null, reason: "source_album_failed" };
      if (settings.rate_albums) countOutcome(c.albumsSummary, null, decision, false, false);
      itemEvent("album", item, c, null, null, decision, settings, error.message);
      return;
    }
    try {
      const attributed = attributedSongs(album, validated.songs, settings);
      c.sources[c.index - 1] = fingerprint(attributed);
      for (const song of attributed) for (const artist of song.artists) {
        const key = "id:" + artist.id;
        if (!Object.prototype.hasOwnProperty.call(c.groups, key)) c.groups[key] = { ...artist, histogram: emptyHistogram() };
        c.groups[key].histogram[song.rating]++;
      }
    } catch (error) {
      c.complete = false; c.sourceErrors++; c.sources[c.index - 1] = null;
      event("error", "artist_source_incomplete", { user: c.user, id: item.id, reason: error.message, action: "defer_artist_writes" });
    }
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
  function verifySource(c, settings) {
    if (c.verifyIndex === c.albums.length) { c.phase = "artists"; return; }
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
      processTarget(state, "artist", item, item.histogram, rating, settings, () => {
        const latest = api("getArtist", c.user, { id: item.id }).artist;
        if (!latest || latest.id !== item.id) throw Error("Invalid fresh artist response");
        return starRating(latest.userRating, !Object.prototype.hasOwnProperty.call(latest, "userRating"));
      });
    } catch (error) {
      const decision = { outcome: "failed", action: "failed", target: null, reason: "artist_read_failed" };
      countOutcome(c.artistsSummary, result, decision, false, false);
      itemEvent("artist", item, c, result, null, decision, settings, error.message);
    }
  }
  function refresh(deadline = now() + BUDGET_MS) {
    const settings = readSettings(readConfig), state = loadState();
    if (!state.active) return { waiting: true };
    if (!checkContext(state, settings)) return { cancelled: true };
    let units = 0;
    try {
      while (state.active && units < settings.batch_size && (units === 0 || now() < deadline)) {
        if (!state.current) beginUser(state);
        const c = state.current;
        if (!c.scope.length) finishUser(state, settings);
        else if (c.phase === "inventory") inventoryPage(c, false);
        else if (c.phase === "scan") scanAlbum(state, settings);
        else if (c.phase === "check_inventory") inventoryPage(c, true);
        else if (c.phase === "verify") verifySource(c, settings);
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
    const deadline = now() + BUDGET_MS;
    try {
      if (get(SCHEDULE_KEY) !== settings.run_time_utc) {
        scheduleDaily(settings, true);
        event("info", "schedule_updated", { runTimeUTC: settings.run_time_utc });
      }
      triggers(settings);
      let batches = 0, units = 0;
      do {
        const result = refresh(deadline);
        if (result.waiting || result.cancelled) return { ...result, batches, units };
        batches++; units += result.units;
        if (!result.active) return { batches, units, active: false };
      } while (now() < deadline);
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
