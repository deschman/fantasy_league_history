"""Reconstruct completed Sleeper season starter-point acquisition sources."""

import argparse
import csv
import json
import logging
import os
import tempfile
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from urllib.request import urlopen

from get_sleeper_data import DEFAULT_OUTPUT, fetch_json
from acquisition_migration import IMPORT_DRAFT


def milliseconds(value):
    return int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000)


def kickoff_window(season, week):
    url = ("https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard"
           f"?dates={season}&seasontype=2&week={week}&limit=100")
    with urlopen(url, timeout=30) as response:
        payload = json.load(response)
    events = payload["events"]
    if not events or any(
        event["season"]["year"] != season or event["season"]["type"] != 2 or
        event["week"]["number"] != week for event in events
    ):
        raise ValueError(f"{season} week {week}: invalid NFL schedule response")
    times = [milliseconds(event["date"]) for event in events]
    return [min(times), max(times)]


def collect_events(season, roster_ids):
    league_id = season["leagueId"]
    events = []
    seen = {}
    counts = defaultdict(int)
    # Sleeper assigns offseason transactions to legs too. Read the entire NFL
    # regular/postseason leg range, not just the fantasy league's scoring weeks.
    for leg in range(23):
        transactions = fetch_json(f"league/{league_id}/transactions/{leg}")
        if not isinstance(transactions, list):
            raise ValueError(f"{season['season']}: invalid transaction response for leg {leg}")
        for transaction in transactions:
            if transaction["status"] != "complete":
                continue
            transaction_id = transaction["transaction_id"]
            if transaction_id in seen:
                if seen[transaction_id] != transaction:
                    raise ValueError(f"Conflicting duplicate transaction {transaction_id}")
                continue
            seen[transaction_id] = transaction
            adds, drops = transaction.get("adds") or {}, transaction.get("drops") or {}
            if not adds and not drops:
                continue
            kind = transaction["type"]
            if kind not in ("trade", "waiver", "free_agent", "commissioner"):
                raise ValueError(f"Unsupported player transaction type: {kind}")
            timestamp = transaction.get("status_updated")
            if not isinstance(timestamp, int) or timestamp <= 0:
                raise ValueError(f"Missing completed transaction time: {transaction_id}")
            if not (set(adds.values()) | set(drops.values())) <= roster_ids:
                raise ValueError(f"Unknown roster in transaction {transaction_id}")
            source = {"trade": "trade", "waiver": "freeAgency", "free_agent": "freeAgency",
                      "commissioner": "unknown"}[kind]
            events.append({"at": timestamp, "id": transaction_id, "kind": kind, "source": source,
                           "adds": adds, "drops": drops, "season": season["season"]})
            counts[kind] += 1
    for draft in fetch_json(f"league/{league_id}/drafts"):
        if draft["status"] != "complete":
            raise ValueError(f"{season['season']}: incomplete historical draft")
        picks = fetch_json(f"draft/{draft['draft_id']}/picks")
        if not picks:
            logging.warning("%s: empty draft %s has no acquisition events",
                            season["season"], draft["draft_id"])
            continue
        timestamp = draft.get("last_picked")
        started = draft.get("start_time")
        if (not isinstance(timestamp, int) or timestamp <= 0 or
                not isinstance(started, int) or started <= 0 or started > timestamp):
            raise ValueError(f"Invalid draft start/completion time: {draft['draft_id']}")
        adds = {}
        for pick in picks:
            if pick["roster_id"] not in roster_ids or pick["player_id"] in adds:
                raise ValueError(f"Invalid or duplicate pick in draft {draft['draft_id']}")
            adds[pick["player_id"]] = pick["roster_id"]
        if draft["draft_id"] == IMPORT_DRAFT:
            counts["import-placeholder"] += 1
            continue
        events.append({"at": timestamp, "id": draft["draft_id"], "kind": "draft", "source": "draft",
                       "adds": adds, "drops": {}, "season": season["season"], "from": started})
        counts["draft"] += 1
    return events, dict(counts)


def migration_events(payload, mappings, events):
    migration = payload.get("migration")
    if (payload.get("missingTradePolicy") != "ignore" or payload.get("provenanceStart") != 2016 or
            not migration or migration["draft"] != IMPORT_DRAFT or not migration.get("rows")):
        raise ValueError("Regenerate ESPN acquisitions with cross-platform migration evidence first")
    owners = {int(row["roster_id"]): row["inheriting_owner"].strip() or row["owner"].strip()
              for row in mappings if int(row["season"]) == 2022}
    baseline = min([migration["at"]] + [event["at"] for event in events]) - 1
    result, seen = [], set()
    for row in migration["rows"]:
        if row["player"] in seen:
            raise ValueError("Duplicate migration player")
        seen.add(row["player"])
        if row["source"] == "unknown":
            continue
        if (row["source"] not in ("draft", "trade", "freeAgency") or
                owners.get(row["roster"]) != row["franchise"] or not row.get("espnPlayer") or
                row["acquiredAt"] > row["acquiredBefore"] or row["acquiredAt"] >= baseline):
            raise ValueError(f"Invalid ESPN migration evidence: {row['player']}")
        evidence = {"source": row["source"], "at": row["acquiredAt"],
                    "before": min(row["acquiredBefore"], baseline - 1),
                    "event": row["event"], "kind": row["kind"],
                    "season": row["acquiredSeason"], "platform": "espn", "espnPlayer": row["espnPlayer"],
                    "match": row["match"], "reason": row["reason"]}
        result.append({"at": baseline, "id": f"espn-import:{row['player']}", "kind": "migration",
                       "source": row["source"], "adds": {row["player"]: row["roster"]},
                       "drops": {}, "season": 2022, "evidence": evidence})
    return result


def attribute_starts(seasons, events, windows):
    """Keep ambiguous kickoff-window acquisitions unknown, never use future moves."""
    by_player = defaultdict(list)
    event_ids = set()
    for event in events:
        event_id = (event["season"], event["id"])
        if event_id in event_ids:
            raise ValueError(f"Duplicate acquisition event: {event_id}")
        event_ids.add(event_id)
        for player in set(event["adds"]) | set(event["drops"]):
            by_player[player].append(event)
    timelines = {}
    for player, player_events in by_player.items():
        states = []
        owner = None
        evidence = None
        last_owner, last_evidence = None, None
        grouped = defaultdict(list)
        for event in player_events:
            grouped[event["at"]].append(event)
        for timestamp, simultaneous in sorted(grouped.items()):
            if len(simultaneous) > 1:
                # The API gives no execution order for equal timestamps.
                affected = {event["adds"][player] for event in simultaneous if player in event["adds"]}
                owner = next(iter(affected)) if len(affected) == 1 else None
                evidence = None
                last_owner, last_evidence = None, None
            else:
                event = simultaneous[0]
                if player in event["drops"] and owner == event["drops"][player]:
                    last_owner, last_evidence = owner, evidence
                    owner, evidence = None, None
                if player in event["adds"]:
                    if (event["kind"] == "commissioner" and owner is None and
                            last_owner == event["adds"][player] and last_evidence is not None):
                        owner, evidence = last_owner, last_evidence
                    administrative_retention = (event["kind"] == "commissioner" and
                                                owner == event["adds"][player] and
                                                evidence is not None)
                    owner = event["adds"][player]
                    if not administrative_retention:
                        evidence = event.get("evidence") or {
                            "source": event["source"], "at": timestamp,
                            "event": event["id"], "kind": event["kind"], "season": event["season"]}
                    last_owner, last_evidence = owner, evidence
                if event["kind"] == "draft" and any(
                    other["id"] != event["id"] and event.get("from", timestamp) <= other["at"] <= timestamp
                    for other in player_events
                ):
                    # Individual pick times are absent. A trade/drop during a
                    # multi-day draft cannot safely be ordered against that pick.
                    owner, evidence = None, None
                    last_owner, last_evidence = None, None
            states.append((timestamp, owner, evidence))
        timelines[player] = states
    result = []
    for season in seasons:
        for week, roster, player, points in season["starters"]:
            first, last = windows[f"{season['season']}:{week}"]
            state = (0, None, None)
            candidates = []
            for entry in timelines.get(player, []):
                if entry[0] < first:
                    state = entry
                elif entry[0] <= last:
                    candidates.append(entry)
                else:
                    break
            candidates.insert(0, state)
            # A weekly starter proves membership at some game's lock, not when
            # within the Thu–Mon window that game occurred.
            plausible = [entry for entry in candidates if entry[1] == roster]
            evidence = plausible[0][2] if plausible else None
            same = evidence is not None and all(entry[2] == evidence for entry in plausible)
            source = evidence["source"] if same else "unknown"
            reason = ("timing" if len(plausible) > 1 and not same else
                      "untraced" if not same else "commissioner" if source == "unknown" else
                      "migration" if evidence.get("platform") == "espn" else "verified")
            result.append({
                "season": season["season"], "week": week, "roster": roster, "player": player,
                "points": points, "source": source, "reason": reason,
                "acquiredAt": evidence["at"] if same else None,
                "event": evidence["event"] if same else None,
                "kind": evidence["kind"] if same else None,
                "acquiredSeason": evidence["season"] if same else None,
                "originPlatform": evidence.get("platform", "sleeper") if same else None,
                "acquiredBefore": evidence.get("before", evidence["at"]) if same else None,
                "espnPlayer": evidence.get("espnPlayer") if same else None,
                "identityMatch": evidence.get("match") if same else None,
            })
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
    details = json.loads((args.data_dir / "details.json").read_text())
    with (args.data_dir / "crosswalk.csv").open(newline="", encoding="utf-8") as handle:
        mappings = list(csv.DictReader(handle))
    seasons = sorted(details["seasons"], key=lambda season: season["season"])
    events, windows, audits = [], {}, []
    previous_owners = {}
    for season in seasons:
        league = fetch_json(f"league/{season['leagueId']}")
        if league["status"] != "complete" or int(league["season"]) != season["season"]:
            raise ValueError("Only completed seasons matching details.json are supported")
        owners = {int(row["roster_id"]): row["owner_id"] for row in mappings
                  if row["league_id"] == season["leagueId"]}
        if len(owners) != league["total_rosters"]:
            raise ValueError("Incomplete crosswalk")
        if previous_owners and owners != previous_owners:
            raise ValueError("Roster ownership changed; explicit franchise continuity mapping required")
        previous_owners = owners
        season_events, counts = collect_events(season, set(owners))
        events.extend(season_events)
        for week in range(1, season["lastWeek"] + 1):
            windows[f"{season['season']}:{week}"] = kickoff_window(season["season"], week)
        audits.append({"season": season["season"], "counts": counts, "queriedLegs": [0, 22]})
        logging.info("%s: collected %s events and NFL kickoff windows", season["season"], len(season_events))
    espn = json.loads((args.data_dir.parent / "espn/acquisitions.json").read_text())
    imported = migration_events(espn, mappings, events)
    events.extend(imported)
    rows = attribute_starts(seasons, events, windows)
    counts = defaultdict(int)
    for row in rows:
        counts[row["source"]] += 1
    payload = {"version": 1, "method": "latest-franchise-acquisition",
               "rows": rows, "audit": audits, "windows": windows,
               "migration": {"draft": IMPORT_DRAFT, "seededPlayers": len(imported),
                             "from": "espn", "provenanceStart": espn["provenanceStart"]}}
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=args.data_dir, delete=False) as handle:
            temporary = Path(handle.name)
            json.dump(payload, handle, separators=(",", ":"), allow_nan=False)
            handle.write("\n")
        os.replace(temporary, args.data_dir / "acquisitions.json")
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    logging.info("Wrote acquisitions.json: %s starters, sources %s", len(rows), dict(counts))


if __name__ == "__main__":
    main()
