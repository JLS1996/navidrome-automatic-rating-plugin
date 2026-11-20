"""Exercise the installed plugin against an isolated Navidrome 0.64.2 server.

Requires ffmpeg and a checksum-verified Navidrome binary. Creates only fictional
music, users, and a new temporary database; never connects to an existing server.
"""
import argparse
from collections import Counter
from datetime import datetime, timedelta, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import pty
import secrets
import select
import shutil
import socket
import sqlite3
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request


def check(condition, message):
    if not condition:
        raise AssertionError(message)


def exercise(binary, package, plugin_id="navidrome-automatic-rating-plugin", upgrade_from=None):
    root = Path(tempfile.mkdtemp(prefix="automatic-ratings-navidrome-"))
    music, data = root / "music", root / "data"
    music.mkdir()
    (data / "plugins").mkdir(parents=True)
    shutil.copyfile(upgrade_from or package, data / "plugins" / (plugin_id + ".ndp"))
    password = secrets.token_urlsafe(24)
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    config = root / "navidrome.toml"
    config.write_text(f'Address = "127.0.0.1"\nPort = {port}\nMusicFolder = {json.dumps(str(music))}\n'
        f'DataFolder = {json.dumps(str(data))}\nLogLevel = "info"\n'
        'AutoImportPlaylists = false\nEnableExternalServices = false\n[Plugins]\nEnabled = true\n'
        '[Scanner]\nSchedule = "0"\n')
    command = [str(binary), "--configfile", str(config)]
    log_file = root / "server.log"
    server, log = None, None
    spec = importlib.util.spec_from_file_location("audit", Path(__file__).with_name("verify-audit.py"))
    audit = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(audit)

    def cli(*args):
        result = subprocess.run([*command, *args], capture_output=True, text=True, timeout=90)
        check(result.returncode == 0, result.stdout + result.stderr)
        return result.stdout

    def create_user(user, admin=False):
        master, slave = pty.openpty()
        try:
            process = subprocess.Popen([*command, "user", "create", "--username", user,
                *(["--admin"] if admin else [])], stdin=slave, stdout=slave, stderr=slave)
            output, sent, deadline = b"", 0, time.monotonic() + 60
            while process.poll() is None and time.monotonic() < deadline:
                if select.select([master], [], [], 0.2)[0]:
                    output += os.read(master, 65536)
                    prompts = [b"Enter new password", b"Confirm new password"]
                    if sent < 2 and prompts[sent] in output:
                        os.write(master, (password + "\n").encode())
                        sent += 1
            if process.poll() is None:
                process.kill()
            check(process.wait() == 0 and sent == 2, output.decode(errors="replace"))
        finally:
            os.close(master)
            os.close(slave)

    def stop():
        nonlocal server, log
        if server is not None:
            server.terminate()
            try:
                server.wait(timeout=15)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait()
            server = None
        if log is not None:
            log.close()
            log = None

    def wait_for(predicate, description, timeout=90):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if server is not None and server.poll() is not None:
                raise AssertionError(log_file.read_text()[-12000:])
            value = predicate()
            if value:
                return value
            time.sleep(0.25)
        raise AssertionError(f"Timed out waiting for {description}; fixture: {root}")

    def api(endpoint, user="example-reader", **params):
        salt = secrets.token_hex(8)
        query = urllib.parse.urlencode({"u": user, "t": hashlib.md5((password+salt).encode()).hexdigest(),
            "s": salt, "v": "1.16.1", "c": "automatic-ratings-test", "f": "json", **params})
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/rest/{endpoint}?{query}", timeout=10) as response:
            body = json.load(response)["subsonic-response"]
        check(body["status"] == "ok", str(body))
        return body

    def start(authorized=True):
        nonlocal server, log
        previous = len(events())
        log = log_file.open("a")
        server = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT)
        def ready():
            try:
                if authorized:
                    return api("ping")
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=10) as response:
                    return response.status == 200
            except (OSError, urllib.error.URLError):
                return False
        wait_for(ready, "server startup")
        if authorized:
            wait_for(lambda: any(e["event"] == "enabled" for e in events()[previous:]), "plugin initialization")

    def events():
        return audit.read_events(log_file.read_text().splitlines()) if log_file.exists() else []

    manifest = json.loads((Path(__file__).resolve().parents[1] / "manifest.json").read_text())
    defaults = {key: value["default"] for key, value in manifest["config"]["schema"]["properties"].items()}
    settings = {**defaults, "batch_interval_seconds": 5, "detail_logging": "info", "run_now": False,
        "run_time_utc": (datetime.now(timezone.utc) + timedelta(hours=12)).strftime("%H:%M")}

    def configure(start_server=True, permissions=None):
        if start_server and server is not None:
            previous = len(events())
            request = urllib.request.Request(f"http://127.0.0.1:{port}/auth/login",
                data=json.dumps({"username": "fixture-admin", "password": password}).encode(),
                headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(request, timeout=10) as response:
                token = json.load(response)["token"]
            request = urllib.request.Request(f"http://127.0.0.1:{port}/api/plugin/{plugin_id}",
                method="PUT", data=json.dumps({"config": json.dumps(settings), **(permissions or {})}).encode(),
                headers={"Content-Type": "application/json", "x-nd-authorization": "Bearer " + token})
            with urllib.request.urlopen(request, timeout=30) as response:
                saved_plugin = json.load(response)
                check(saved_plugin["enabled"], "Settings save disabled the plugin")
                if upgrade_from is None or any(e.get("version") == manifest["version"] for e in events()):
                    check(json.loads(saved_plugin["manifest"])["name"] == "navidrome-automatic-rating-plugin", "Wrong plugin display name")
            wait_for(lambda: any(e["event"] == "enabled" for e in events()[previous:]), "live plugin reload", timeout=15)
            return
        stop()
        file = root / "plugin-config.json"
        file.write_text(json.dumps(settings))
        cli("plugin", "edit", plugin_id, "--all-users",
            "--libraries", "1", "--no-write-access", "--config-file", str(file))
        if start_server:
            start()

    def run(**changes):
        before = song_ratings()
        before_annotations = annotation_rows()
        settings.update(changes)
        previous = len([e for e in events() if e["event"] == "run_summary"])
        settings["run_now"] = not settings["run_now"]
        process_id = server.pid
        configure()
        summary = wait_for(lambda: [e for e in events() if e["event"] == "run_summary"][previous:], "plugin run")[0]
        check(server.pid == process_id, "Manual scan restarted Navidrome")
        check(summary["sourceErrors"] == summary["albums"]["failed"] == summary["artists"]["failed"] == 0, str(summary))
        check(song_ratings() == before, "Plugin changed song ratings")
        after_annotations = annotation_rows()
        changed = Counter(key[2] for key in before_annotations.keys() | after_annotations.keys()
            if before_annotations.get(key) != after_annotations.get(key))
        expected = Counter({kind: summary[kind+"s"]["updated"] for kind in ("album", "artist")
            if not summary["dryRun"] and summary[kind+"s"]["updated"]})
        check(changed == expected, f"Annotation rating/timestamp changes {changed} disagree with verified writes {expected}")
        print(json.dumps({"stage": changes, "albums": summary["albums"], "artists": summary["artists"],
            "changedAnnotationsByKind": changed}), flush=True)
        return summary

    def rating(kind, entity_id):
        return api("getAlbum" if kind == "album" else "getArtist", id=entity_id)[kind].get("userRating", 0)

    def song_ratings():
        return {user: sorted((song["id"], song.get("userRating", 0)) for song in api("search3", user=user,
            query='""', songCount=100, albumCount=0, artistCount=0).get("searchResult3", {}).get("song", []))
            for user in ("fixture-admin", "example-reader", "example-unrated")}

    def annotation_rows():
        with sqlite3.connect(f"file:{data}/navidrome.db?mode=ro", uri=True) as db:
            return {tuple(row[:3]): tuple(row[3:]) for row in db.execute(
                "SELECT user_id,item_id,item_type,rating,rated_at FROM annotation")}

    try:
        check(subprocess.check_output([str(binary), "--version"], text=True).strip() == "0.64.2 (10114574)", "Use Navidrome 0.64.2 (10114574)")
        for album, count, catalogue, performer in [("Example Bright", 1, "Example Catalogue", "Example Performer"),
                ("Example Dim", 4, "Example Catalogue", "Example Performer"),
                ("Example Sparse", 4, "Example Other Catalogue", "Example Other Performer")]:
            folder = music / album
            folder.mkdir()
            for track in range(1, count+1):
                subprocess.run(["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-f", "lavfi",
                    "-i", "anullsrc=r=8000:cl=mono", "-t", "0.1", "-metadata", f"album={album}",
                    "-metadata", f"album_artist={catalogue}", "-metadata", f"artist={performer}",
                    "-metadata", f"title=Example Song {track}", "-metadata", f"track={track}",
                    str(folder / f"{track:02}.flac")], check=True, timeout=15)
        start(authorized=False)
        stop()
        file_hashes = {path: hashlib.sha256(path.read_bytes()).digest() for path in music.rglob("*.flac")}
        create_user("fixture-admin", admin=True)
        create_user("example-reader")
        create_user("example-unrated")
        cli("scan", "--full")
        cli("plugin", "rescan")
        configure(start_server=False)
        cli("plugin", "enable", plugin_id)
        start()
        wait_for(lambda: not api("getScanStatus")["scanStatus"]["scanning"], "library scan")
        albums = {a["name"]: api("getAlbum", id=a["id"])["album"] for a in api(
            "getAlbumList2", type="alphabeticalByName", size=100)["albumList2"]["album"]}
        check(len(albums) == 3, str(albums))
        bright, dim, sparse = (albums["Example " + name] for name in ("Bright", "Dim", "Sparse"))
        catalogue = bright["artists"][0]["id"]
        for album, values in [(bright, [5]), (dim, [1]*4), (sparse, [5, 0, 0, 0])]:
            for song, value in zip(album["song"], values):
                api("setRating", id=song["id"], rating=value)
        # Model a foreign plugin's matching and differing ratings. Custom coverage
        # also makes the sparse album qualify, unlike the manifest's 30% default.
        api("setRating", id=bright["id"], rating=5)
        api("setRating", id=dim["id"], rating=4)
        api("setRating", id=catalogue, rating=3)
        run(dry_run=True, audit_logging=True, album_rating_policy="replace", artist_rating_policy="replace",
            album_minimum_rated_percent=25, artist_minimum_rated_percent=25)
        audit.verify(events())
        result = run(dry_run=False, audit_logging=False)
        check(result["albums"]["updated"] == 2 and result["artists"]["updated"] == 1, "Initial writes missing")
        check(result["albums"]["adopted"] == result["artists"]["adopted"] == 1, "Matching foreign values were not adopted")
        check(rating("album", bright["id"]) == 5 and rating("album", dim["id"]) == 1 and
            rating("album", sparse["id"]) == 5 and rating("artist", catalogue) == 3, "Configured migration results differ")
        # Inject only into this temporary store to model lost ownership finalization
        # after a successful host write, then recover through the installed plugin.
        stop()
        if upgrade_from is not None:
            shutil.copyfile(package, data / "plugins" / (plugin_id + ".ndp"))
            cli("plugin", "rescan")
            cli("plugin", "enable", plugin_id)
        key = "automatic-ratings:v1:owner:" + json.dumps(["example-reader", "album", dim["id"]], separators=(",", ":"))
        pending = json.dumps({"version": 1, "rating": None, "manual": False, "pending": {"before": 4, "target": 1}}).encode()
        with sqlite3.connect(data / "plugins" / plugin_id / "kvstore.db") as db:
            check(db.execute("UPDATE kvstore SET value=?,size=? WHERE key=?", (pending, len(pending), key)).rowcount == 1,
                "Missing initial ownership record")
        start()
        result = run()
        check(result["albums"]["updated"] == result["artists"]["updated"] == 0, "Repeated run should converge")
        check(result["albums"]["adopted"] == result["artists"]["adopted"] == 0, "Owned values must not be adopted again")
        check(result["albums"]["unchanged"] == 3 and result["artists"]["unchanged"] == 2, "Expected all migrated ratings to match")
        # Re-saving the same switch and restarting the process must not replay it.
        completed = len([e for e in events() if e["event"] == "run_summary"])
        configure()
        time.sleep(11)
        check(len([e for e in events() if e["event"] == "run_summary"]) == completed, "Unchanged save replayed a scan")
        with sqlite3.connect(f"file:{data}/navidrome.db?mode=ro", uri=True) as db:
            user_ids = [row[0] for row in db.execute("SELECT id FROM user")]
        configure(permissions={"users": json.dumps(user_ids), "allUsers": False,
            "libraries": "[1]", "allLibraries": False})
        configure(permissions={"allUsers": True, "libraries": "[1]", "allLibraries": False})
        run()
        completed = len([e for e in events() if e["event"] == "run_summary"])
        stop()
        start()
        time.sleep(11)
        check(len([e for e in events() if e["event"] == "run_summary"]) == completed, "Restart replayed a consumed request")
        with sqlite3.connect(f"file:{data}/plugins/{plugin_id}/kvstore.db?mode=ro", uri=True) as db:
            owner = json.loads(db.execute("SELECT value FROM kvstore WHERE key=?", (key,)).fetchone()[0])
        check(owner["pending"] is None and owner["rating"] == 1, "Pending intent was not recovered")
        api("setRating", id=bright["id"], rating=2)
        api("setRating", id=catalogue, rating=0)
        result = run(album_rating_policy="preserve", artist_rating_policy="preserve")
        check(rating("album", bright["id"]) == 2 and rating("artist", catalogue) == 0, "Manual override lost")
        check(result["albums"]["manualOverrides"] == result["artists"]["manualOverrides"] == 1, "Overrides not detected")
        run(album_rating_policy="replace", artist_rating_policy="replace")
        check(rating("album", bright["id"]) == 5 and rating("artist", catalogue) == 3, "Replace did not reclaim outputs")
        for album in (bright, dim, sparse):
            for song in album["song"]:
                api("setRating", id=song["id"], rating=0)
        result = run(album_rating_policy="preserve", artist_rating_policy="preserve")
        check(result["albums"]["cleared"] == 3 and result["artists"]["cleared"] == 2, "Owned ratings were not cleared")
        check(rating("album", bright["id"]) == rating("artist", catalogue) == 0, "Cleared ratings remain")
        api("setRating", id=bright["song"][0]["id"], rating=5)
        api("setRating", id=dim["song"][0]["id"], rating=5)
        run(artist_attribution="performing_artist", rate_albums=False)
        performer = bright["song"][0]["artists"][0]["id"]
        check(rating("artist", performer) == 5 and rating("artist", catalogue) == 0, "Performing attribution failed")

        # Exclude 1-star songs without weakening source validation or turning an
        # excluded-only album into a clear, even with replace enabled.
        for song in dim["song"]:
            api("setRating", id=song["id"], rating=1)
        api("setRating", id=dim["id"], rating=4)
        run(rate_albums=True, artist_attribution="album_artist", album_one_star_weight=0, artist_one_star_weight=0,
            album_rating_policy="replace", artist_rating_policy="replace")
        check(rating("album", bright["id"]) == 5 and rating("album", dim["id"]) == 4 and
            rating("artist", catalogue) == 5, "Zero weights did not exclude low-rated songs independently")
        skipped = [event for event in events() if event.get("action") == "skip_excluded" and event.get("id") == dim["id"]][-1]
        check(skipped["totalSongs"] == skipped["excludedSongs"] == 4 and
            skipped["eligibleSongs"] == skipped["contributingRatedSongs"] == 0, "Missing exclusion evidence")
        run(album_one_star_weight=1)
        check(rating("album", dim["id"]) == 1 and rating("artist", catalogue) == 5,
            "Album and artist weights are not independent")
        api("setRating", id=bright["song"][0]["id"], rating=1)
        result = run(album_one_star_weight=0)
        check(result["albums"]["updated"] == result["artists"]["updated"] == 0 and
            result["albums"]["adopted"] == result["artists"]["adopted"] == 0 and
            rating("album", bright["id"]) == 5 and rating("album", dim["id"]) == 1 and
            rating("artist", catalogue) == 5, "Entirely excluded rated sources must retain existing values")
        for album in (bright, dim, sparse):
            for song in album["song"]:
                api("setRating", id=song["id"], rating=0)
        result = run()
        check(result["albums"]["cleared"] == 2 and result["artists"]["cleared"] == 1 and
            rating("album", bright["id"]) == rating("album", dim["id"]) == rating("artist", catalogue) == 0,
            "Zero-weight settings must still clear genuinely unrated eligible outputs")
        check(all(hashlib.sha256(path.read_bytes()).digest() == digest for path, digest in file_hashes.items()), "Music files changed")
        print("Real Navidrome integration passed: live settings/permission reloads, both scan-switch directions without server restarts, no replay on unchanged saves/restarts, audit dry run, custom-quota migration, writes, adoption, pending-intent recovery, zero-write/timestamp convergence, manual overrides, replace, clears, performing attribution, zero-weight exclusions, song/file isolation.", flush=True)
    except BaseException:
        print(f"Fictional integration fixture retained at {root}", flush=True)
        raise
    else:
        stop()
        shutil.rmtree(root)
    finally:
        stop()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--navidrome", type=Path, required=True, help="Checksum-verified Navidrome 0.64.2 binary")
    parser.add_argument("--package", type=Path, default=Path(__file__).resolve().parents[1] / "dist/navidrome-automatic-rating-plugin.ndp")
    parser.add_argument("--plugin-id", choices=["navidrome-automatic-rating-plugin", "automatic-ratings"],
        default="navidrome-automatic-rating-plugin", help="Installed filename/ID; legacy ID verifies upgrade compatibility")
    parser.add_argument("--upgrade-from", type=Path, help="Install this older package first, then verify an in-place upgrade")
    args = parser.parse_args()
    exercise(args.navidrome.resolve(), args.package.resolve(), args.plugin_id,
        args.upgrade_from.resolve() if args.upgrade_from else None)
