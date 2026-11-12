"""Independently verify one complete Automatic Ratings audit log, offline.

Accepts plain event JSON, `Automatic Ratings: {...}` lines, Navidrome JSON logs,
or Navidrome's quoted text logs. Requires audit_logging=true for the entire run.
Uses exact fractions for the formula; imports no plugin code or dependencies.
"""
import argparse
import collections
from fractions import Fraction
import json
import math
import re
import sys

PREFIX = "Automatic Ratings: "
OUTCOMES = ("updated", "unchanged", "preserved", "belowQuota", "empty", "failed")
ACTIONS = {"update": "updated", "clear": "updated", "preview_update": "updated", "preview_clear": "updated",
    "match": "unchanged", "adopt": "unchanged", "preview_adopt": "unchanged", "preserve": "preserved",
    "keep_below_quota": "belowQuota", "skip_empty": "empty", "failed": "failed", "blocked": "failed"}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def read_events(lines):
    events = []
    for number, line in enumerate(lines, 1):
        line = line.strip()
        if not line:
            continue
        try:
            if line.startswith("{"):
                value = json.loads(line)
                if isinstance(value, dict) and isinstance(value.get("msg"), str):
                    line = value["msg"]
                elif isinstance(value, dict) and "event" in value:
                    require(value.get("schemaVersion") == 1, "Unsupported event schema")
                    events.append(value)
                    continue
                else:
                    continue
            if PREFIX not in line:
                continue
            match = re.search(r'\bmsg=("(?:\\.|[^"\\])*")', line)
            if match:
                line = json.loads(match[1])
            value, _ = json.JSONDecoder().raw_decode(line.split(PREFIX, 1)[1])
            require(isinstance(value, dict) and value.get("schemaVersion") == 1, "Unsupported event schema")
            events.append(value)
        except (ValueError, TypeError) as error:
            raise ValueError(f"Malformed audit event at line {number}: {error}") from error
    return events


def calculate(histogram, kind, settings):
    total = sum(histogram)
    rated = total-histogram[0]
    required = max(settings[f"{kind}_minimum_rated_songs"],
        (total*settings[f"{kind}_minimum_rated_percent"]+99)//100)
    meets = total > 0 and rated >= required
    weights = [Fraction(str(settings[f"{kind}_{name}_star_weight"])) for name in ("one", "two", "three", "four", "five")]
    score = sum(histogram[i]*i*weights[i-1] for i in range(1, 6))/sum(histogram[i]*weights[i-1] for i in range(1, 6)) if meets else None
    rating = math.floor(score+Fraction(1, 2)) if meets else 0
    return {"totalSongs": total, "ratedSongs": rated, "unratedSongs": histogram[0],
        "requiredRatedSongs": required, "meetsThreshold": meets, "score": score, "rating": rating}


def verify(events, explain_artist=None, user_filter=None):
    require(user_filter is None or explain_artist is not None, "--user requires --explain-artist")
    starts = [i for i, e in enumerate(events) if e.get("event") == "run_started"]
    ends = [i for i, e in enumerate(events) if e.get("event") == "run_summary"]
    require(len(starts) == len(ends) == 1 and starts[0] < ends[0], "Supply exactly one complete run from run_started through run_summary")
    events = events[starts[0]:ends[0]+1]
    configs = [e for e in events if e.get("event") == "audit_config"]
    require(len(configs) == 1 and configs[0].get("sourceFormat") == "structured_song_ratings_v1",
        "Enable audit_logging=true, apply settings, then capture one fresh, complete run; detail_logging=info alone does not enable audits")
    settings = configs[0]["settings"]
    require(settings.get("audit_logging") is True, "Audit logging was disabled")
    users, albums, artists, seen_songs = {}, {}, {}, collections.defaultdict(set)
    items = collections.defaultdict(list)
    contributions = collections.defaultdict(dict)
    for event in events:
        name = event.get("event")
        if name == "source_album":
            user, album_id = event["user"], event["albumId"]
            key = user, album_id
            require(key not in albums, "Repeated source album: use a fresh, uninterrupted audit run")
            require(event["attribution"] == settings["artist_attribution"], "Attribution setting changed")
            histogram = [0]*6
            require(isinstance(event["songs"], list), "Missing source songs")
            for song in event["songs"]:
                require(isinstance(song, list) and len(song) == 3, "Invalid source song tuple")
                song_id, rating, performing_ids = song
                credit_ids = (event["albumArtistIds"] if settings["artist_attribution"] == "album_artist" else performing_ids) if settings["rate_artists"] else []
                require(isinstance(song_id, str) and song_id and song_id not in seen_songs[user], "Invalid or duplicate song ID")
                require(type(rating) is int and 0 <= rating <= 5, "Invalid source rating")
                require(isinstance(credit_ids, list) and all(isinstance(a, str) and a for a in credit_ids)
                    and (credit_ids or not settings["rate_artists"]), "Missing structured artist IDs")
                seen_songs[user].add(song_id)
                histogram[rating] += 1
                for artist_id in set(credit_ids):
                    artists.setdefault((user, artist_id), [0]*6)[rating] += 1
                    if artist_id == explain_artist and (user_filter is None or user_filter == user):
                        contribution = contributions[user].setdefault(album_id,
                            {"albumId": album_id, "histogram": [0]*6, "songs": []})
                        contribution["histogram"][rating] += 1
                        contribution["songs"].append({"id": song_id, "rating": rating, "artistIds": sorted(set(credit_ids))})
            albums[key] = histogram
        elif name == "item":
            require(event.get("action") in ACTIONS and event.get("kind") in ("album", "artist"), "Unknown item outcome")
            items[event["user"]].append(event)
        elif name == "user_summary":
            require(event["user"] not in users, "Repeated user summary")
            users[event["user"]] = event
    require(len(users) == events[0]["users"] == events[-1]["users"], "Missing user summaries")
    verified = collections.Counter()
    for user, summary in users.items():
        require(summary.get("skipped") is False, "An audit run must contain full item evaluations")
        require(summary.get("sourceComplete") is True and summary.get("sourceErrors") == 0, "Incomplete source data cannot be independently verified")
        require(summary["scannedSongs"] == len(seen_songs[user]), "Missing source album evidence")
        require(summary["ratedSongs"] == sum(sum(h[1:]) for (u, _), h in albums.items() if u == user), "Rated-song summary mismatch")
        for kind, sources in (("album", albums), ("artist", artists)):
            selected = [e for e in items[user] if e["kind"] == kind]
            counts = summary[kind+"s"]
            require(counts["processed"] == len(selected) == sum(counts[k] for k in OUTCOMES), f"{kind} counter identity mismatch")
            require(counts["updated"] == sum(counts["ratingCounts"]) and counts["cleared"] == counts["ratingCounts"][0], "Rating distribution identity mismatch")
            outcomes = collections.Counter(ACTIONS[e["action"]] for e in selected)
            require(all(outcomes[k] == counts[k] for k in OUTCOMES), "Item outcomes disagree with summary")
            distribution = collections.Counter(e["proposedRating"] for e in selected if ACTIONS[e["action"]] == "updated")
            require([distribution[i] for i in range(6)] == counts["ratingCounts"], "Item distribution disagrees with summary")
            expected_ids = {entity_id for u, entity_id in sources if u == user} if settings[f"rate_{kind}s"] else set()
            require({e["id"] for e in selected} == expected_ids and len(selected) == len(expected_ids), f"Missing, duplicate, or unexpected {kind} events")
            quota_failures = 0
            for item in selected:
                require(ACTIONS[item["action"]] != "failed", "Failed or blocked items cannot be independently verified")
                result = calculate(sources[user, item["id"]], kind, settings)
                quota_failures += int(result["totalSongs"] > 0 and not result["meetsThreshold"])
                for field in ("totalSongs", "ratedSongs", "unratedSongs", "requiredRatedSongs", "meetsThreshold"):
                    require(type(item[field]) is type(result[field]) and item[field] == result[field], f"{kind} {item['id']}: {field} mismatch")
                score = item["score"]
                require((score is None and result["score"] is None) or
                    (type(score) in (int, float) and result["score"] is not None and
                     math.isclose(score, float(result["score"]), rel_tol=1e-12, abs_tol=1e-12)), f"{kind} {item['id']}: score mismatch")
                has_target = ACTIONS[item["action"]] in ("updated", "unchanged")
                require((has_target and type(item["proposedRating"]) is int and item["proposedRating"] == result["rating"])
                    or (not has_target and item["proposedRating"] is None), f"{kind} {item['id']}: proposedRating mismatch")
                verified[kind] += 1
            require(counts["quotaFailures"] == quota_failures, "Quota-failure summary mismatch")
    for plural in ("albums", "artists"):
        for field in ("processed", *OUTCOMES, "quotaFailures", "cleared", "adopted", "manualOverrides"):
            require(events[-1][plural][field] == sum(s[plural][field] for s in users.values()), "Run/user counter mismatch")
        require(events[-1][plural]["ratingCounts"] == [sum(s[plural]["ratingCounts"][i] for s in users.values()) for i in range(6)], "Run/user distribution mismatch")
    for field in ("scannedSongs", "ratedSongs", "sourceErrors"):
        require(events[-1][field] == sum(s[field] for s in users.values()), f"Run/user {field} mismatch")
    report = {"ok": True, "users": len(users), "sourceAlbums": len(albums),
        "verifiedAlbums": verified["album"], "verifiedArtists": verified["artist"]}
    if explain_artist is not None:
        selected = [item for user in sorted(users) for item in items[user]
            if item["kind"] == "artist" and item["id"] == explain_artist and (user_filter is None or user == user_filter)]
        require(selected, "No evaluated artist matches the requested ID and user; use IDs from this audit log")
        report["artistExplanations"] = []
        for item in selected:
            user = item["user"]
            histogram = artists[user, explain_artist]
            result = calculate(histogram, "artist", settings)
            report["artistExplanations"].append({"user": user, "id": explain_artist, "name": item["name"],
                "attribution": settings["artist_attribution"], "histogram": histogram,
                **{key: value for key, value in result.items() if key not in ("score", "rating")},
                "score": float(result["score"]) if result["score"] is not None else None,
                "scoreExact": str(result["score"]) if result["score"] is not None else None,
                "calculatedRating": result["rating"], "existingRating": item["existingRating"],
                "proposedRating": item["proposedRating"], "action": item["action"],
                "contributions": [contributions[user][album_id] for album_id in sorted(contributions[user])]})
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("log", help="Path to one complete local audit log, or - for standard input")
    parser.add_argument("--explain-artist", metavar="ARTIST_ID", help="After verifying the entire run, explain this artist's song contributions")
    parser.add_argument("--user", metavar="USERNAME", help="Limit --explain-artist to one user; otherwise explain every matching user")
    args = parser.parse_args()
    try:
        if args.log == "-":
            result = verify(read_events(sys.stdin), args.explain_artist, args.user)
        else:
            with open(args.log, encoding="utf-8") as source:
                result = verify(read_events(source), args.explain_artist, args.user)
        print(json.dumps(result))
    except (ValueError, KeyError, TypeError, ArithmeticError, OSError) as error:
        print(json.dumps({"ok": False, "error": str(error)}))
        sys.exit(1)
