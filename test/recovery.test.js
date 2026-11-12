"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { fixture } = require("./helpers");
const { calculateRating, ownerKey, decode } = require("../src/plugin");
const user = "example-reader", stateKey = "automatic-ratings:v1:scan";
const metricsKey = "automatic-ratings:v1:snapshot-metrics";

test("percentage ceilings remain exact across the safe-integer count range", () => {
  const total = 9007199254739991, required = 900719925474000;
  const result = calculateRating([total - required + 1, 0, 0, 0, 0, required - 1], { minimumRatedPercent: 10 });
  assert.equal(result.requiredRatedSongs, required);
  assert.equal(result.meetsThreshold, false);
});

test("transient or malformed storage reads retain the saved checkpoint and rearm the worker", () => {
  for (const response of [{ error: "temporary storage outage" }, { exists: null }, { exists: "false" }]) {
    const h = fixture({ users: [user] }), config = { batch_size: 1, dry_run: false };
    const p = h.make(config); p.initialize(); p.startRun(); p.refresh();
    const checkpoint = h.storage.get(stateKey);
    h.before = (name, request) => name === "kvstore_get" && request.key === stateKey ? response : undefined;
    assert.throws(() => h.make(config).onSchedule({ payload: "worker" }), /storage/);
    assert.equal(h.storage.get(stateKey), checkpoint);
    assert.equal(h.events("state_reset").length, 0);
    assert.equal(h.schedules.has("automatic-ratings-worker"), true);
    h.before = null;
    while (h.make(config).refresh().active) {}
    assert.equal(h.events("run_summary").length, 1);
  }
});

test("metrics persistence failures neither abort scans nor prevent capacity cancellation", () => {
  const h = fixture({ users: [user] });
  h.before = (name, request) => name === "kvstore_set" && request.key === metricsKey ? { error: "metrics unavailable" } : undefined;
  h.run({ dry_run: false });
  assert.equal(h.events("run_summary")[0].sourceErrors, 0);
  assert.equal(h.events("run_summary")[0].albums.failed, 0);
  assert.ok(h.events("snapshot_metrics_save_failed").length > 0);
  assert.ok(h.writes.length > 0);
  const limited = fixture({ users: [user] }); limited.before = h.before;
  const p = limited.make({}, { maxStateBytes: 2500 }); p.initialize(); p.startRun();
  assert.throws(() => p.refresh(), /state limit/);
  assert.equal(limited.state().active, false);
  assert.deepEqual(limited.writes, []);
});

test("an existing empty checkpoint uses corruption recovery with Navidrome's omitted value field", () => {
  const h = fixture({ users: [user] }), p = h.make(); p.initialize();
  h.before = (name, request) => name === "kvstore_get" && request.key === stateKey ? { exists: true } : undefined;
  assert.equal(p.onSchedule({ payload: "worker" }).waiting, true);
  assert.equal(h.state().active, false);
  assert.equal(h.events("state_reset").length, 1);
  assert.deepEqual(h.writes, []);
});

test("manual edits during intent persistence are deferred for both outputs and policies", () => {
  for (const kind of ["album", "artist"]) for (const policy of ["preserve", "replace"]) {
    const h = fixture({ users: [user] }), id = kind === "album" ? "album-a" : "album-artist";
    const key = ownerKey(user, kind, id);
    h.after = (name, request) => {
      if (name === "kvstore_set" && request.key === key && decode(request.value).pending) h.setRating(user, kind, id, 2);
    };
    h.run({ dry_run: false, rate_albums: kind === "album", rate_artists: kind === "artist", [`${kind}_rating_policy`]: policy });
    assert.equal(h.getRating(user, kind, id), 2);
    assert.equal(h.writes.some(w => w.id === id), false);
    assert.equal(decode(h.storage.get(key)).pending, null);
    assert.ok(h.events("item").some(e => e.id === id && /concurrently/.test(e.error)));
  }
});

test("source edits during intent persistence defer albums without claiming a later manual rating", () => {
  const h = fixture({ users: [user] }), key = ownerKey(user, "album", "album-a");
  h.after = (name, request) => {
    if (name === "kvstore_set" && request.key === key && decode(request.value).pending) h.albums[0].songs[0].userRating = 4;
  };
  h.run({ dry_run: false, rate_artists: false });
  assert.equal(h.writes.some(w => w.id === "album-a"), false);
  assert.equal(decode(h.storage.get(key)).pending, null);
  h.after = null; h.setRating(user, "album", "album-a", 5);
  h.make({ dry_run: false, rate_artists: false }).startRun();
  while (h.make({ dry_run: false, rate_artists: false }).refresh().active) {}
  assert.equal(h.getRating(user, "album", "album-a"), 5);
});
