"""Benchmark compiled WASM using native Extism and fictional, in-memory data.

Install scripts/benchmark-requirements.txt in a virtual environment. No server,
database, credentials, or network access are used by this script.
"""
import argparse
import base64
import collections
import json
import time
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import extism


def benchmark(wasm, album_count, batch_size, write, full_scan):
    users = ["example-reader", "example-unrated"]
    storage, schedules, ratings = {}, {}, {}
    calls = collections.Counter()
    checkpoint_bytes = peak_bytes = callbacks = 0
    call_seconds = compilation_seconds = 0
    albums, artists = {}, {}
    for i in range(album_count):
        album_id, artist_id = f"synthetic-album-{i:05}", f"synthetic-artist-{i % 16}"
        credit = {"id": artist_id, "name": f"Synthetic artist {i % 16}"}
        artists[artist_id] = credit
        albums[album_id] = {"id": album_id, "name": f"Synthetic album {i}", "songCount": 12,
            "artists": [credit], "song": [{"id": f"{album_id}-song-{n}", "albumId": album_id,
                "userRating": (i+n) % 6, "artists": [credit]} for n in range(12)]}

    def host(name, request):
        nonlocal checkpoint_bytes, peak_bytes
        calls[name] += 1
        key = request.get("key")
        if name == "kvstore_get":
            return {"exists": key in storage, "value": storage.get(key, "")}
        if name == "kvstore_list":
            return {"keys": sorted(k for k in storage if k.startswith(request["prefix"]))}
        if name == "kvstore_set":
            storage[key] = request["value"]
            if key.endswith(":scan"):
                size = len(base64.b64decode(request["value"]))
                checkpoint_bytes += size
                peak_bytes = max(peak_bytes, size)
            return {}
        if name == "users_getusers":
            return {"result": [{"userName": user} for user in users]}
        if name == "library_getalllibraries":
            return {"result": [{"id": 1, "name": "Synthetic library"}]}
        if name == "scheduler_schedulerecurring":
            assert request["scheduleId"] not in schedules
            schedules[request["scheduleId"]] = request
            return {}
        if name == "scheduler_cancelschedule":
            if schedules.pop(request["scheduleId"], None) is None:
                return {"error": f'schedule ID "{request["scheduleId"]}" not found'}
            return {}
        if name != "subsonicapi_call":
            raise ValueError(name)
        url = urlsplit(request["uri"])
        params = {k: v[0] for k, v in parse_qs(url.query).items()}
        user, entity_id = params["u"], params.get("id")
        assert user in users
        endpoint = url.path
        calls[endpoint] += 1
        if endpoint == "getMusicFolders":
            body = {"musicFolders": {"musicFolder": [{"id": 1}]}}
        elif endpoint == "getScanStatus":
            body = {"scanStatus": {"scanning": False}}
        elif endpoint == "getAlbumList2":
            assert params["musicFolderId"] == "1"
            offset, size = int(params["offset"]), int(params["size"])
            body = {"albumList2": {"album": [{**{k: a[k] for k in ("id", "name", "songCount", "artists")},
                "userRating": ratings.get((user, a["id"]), 0)}
                for a in list(albums.values())[offset:offset+size]]}}
        elif endpoint == "search3":
            assert params["musicFolderId"] == "1" and params["query"] == '""'
            song_offset, song_count = int(params["songOffset"]), int(params["songCount"])
            artist_offset, artist_count = int(params["artistOffset"]), int(params["artistCount"])
            songs = [s for a in albums.values() for s in a["song"]][song_offset:song_offset+song_count]
            body = {"searchResult3": {
                "song": [{k: v for k, v in song.items() if k != "userRating" or (user == users[0] and v)} for song in songs],
                "artist": [{**a, "userRating": ratings.get((user, a["id"]), 0)}
                    for a in list(artists.values())[artist_offset:artist_offset+artist_count]]}}
        elif endpoint == "getAlbum":
            album = {**albums[entity_id], "userRating": ratings.get((user, entity_id), 0)}
            album["song"] = [{k: v for k, v in song.items() if k != "userRating" or (user == users[0] and v)}
                for song in album["song"]]
            body = {"album": album}
        elif endpoint == "getArtist":
            body = {"artist": {**artists[entity_id], "userRating": ratings.get((user, entity_id), 0)}}
        elif endpoint == "setRating":
            assert write and (entity_id in albums or entity_id in artists)
            ratings[user, entity_id] = int(params["rating"])
            body = {}
        else:
            raise ValueError(endpoint)
        return {"responseJson": json.dumps({"subsonic-response": {
            "status": "ok", "type": "navidrome", "openSubsonic": True, **body}})}

    def function(name):
        def invoke(request: str) -> str:
            return json.dumps(host(name, json.loads(request)))
        return extism.host_fn(name=name)(invoke)

    names = ["kvstore_get", "kvstore_set", "kvstore_list", "users_getusers", "library_getalllibraries",
        "scheduler_schedulerecurring", "scheduler_cancelschedule", "subsonicapi_call"]
    config = {"run_now": "true", "detail_logging": "off", "batch_size": str(batch_size),
        "dry_run": "false" if write else "true", "skip_unrated_users": "false" if full_scan else "true"}

    def invoke(name, value=""):
        nonlocal call_seconds, compilation_seconds
        started = time.perf_counter()
        functions = [function(name) for name in names]
        with extism.Plugin(str(wasm), wasi=True, config=config, functions=functions) as plugin:
            compilation_seconds += time.perf_counter()-started
            started = time.perf_counter()
            plugin.call(name, value)
            call_seconds += time.perf_counter()-started

    invoke("nd_on_init")
    while True:
        invoke("nd_scheduler_callback", json.dumps({"payload": "worker"}))
        callbacks += 1
        state = json.loads(base64.b64decode(storage["automatic-ratings:v1:scan"]))
        if not state["active"]:
            break
        assert callbacks < 1000, "Run did not finish"
    totals = state["totals"]
    if state["version"] >= 3:
        assert totals["usersSkipped"] == (0 if full_scan else 1)
        metric = json.loads(base64.b64decode(storage["automatic-ratings:v1:snapshot-metrics"]))
        assert metric["peakSnapshotBytes"] == peak_bytes
    evaluated_users = 2-totals.get("usersSkipped", 0)
    assert totals["sourceErrors"] == 0 and totals["albums"]["processed"] == evaluated_users*album_count
    assert totals["artists"]["processed"] == evaluated_users*min(album_count, 16)
    assert totals["albums"]["updated"] == album_count and totals["artists"]["updated"] == min(album_count, 16)
    assert not any(c["failed"] for c in (totals["albums"], totals["artists"]))
    assert len(ratings) == (album_count+min(album_count, 16) if write else 0)
    print(json.dumps({"runtime": extism.extism_version(), "albumsPerUser": album_count,
        "songsPerUser": album_count*12, "users": 2, "dryRun": not write, "fullScan": full_scan, "callbacks": callbacks,
        "executionMs": round(call_seconds*1000), "compilationMs": round(compilation_seconds*1000),
        "checkpointBytes": checkpoint_bytes, "peakSnapshotBytes": peak_bytes, "calls": calls,
        "totals": totals}), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--wasm", type=Path, default=Path(__file__).resolve().parents[1]/"dist/plugin.wasm")
    parser.add_argument("--albums", type=int, nargs="+", default=[64, 128, 256])
    parser.add_argument("--batch-size", type=int, default=25)
    parser.add_argument("--write", action="store_true", help="Exercise writes to the in-memory fixture only")
    parser.add_argument("--full-scan", action="store_true", help="Disable the unrated-user fast path for comparison")
    args = parser.parse_args()
    if not all(1 <= count <= 20000 for count in args.albums) or not 1 <= args.batch_size <= 100:
        parser.error("albums must be 1–20000 and batch size 1–100")
    extism.set_log_file("stderr", "error")
    for count in args.albums:
        benchmark(args.wasm.resolve(), count, args.batch_size, args.write, args.full_scan)
