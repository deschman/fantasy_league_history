"""Export ESPN 2018-2021 starter sources using acquisition history back to 2016."""

import argparse
import csv
import hashlib
import json
import logging
import math
import os
import tempfile
from collections import Counter, defaultdict
from pathlib import Path
from urllib.request import Request, urlopen

from espn_credentials import load_credentials
from acquisition_migration import IMPORT_DRAFT, handoff_events, match_players
from get_sleeper_acquisitions import kickoff_window
from get_sleeper_data import fetch_json
from trade_assets import espn_trade_record

ROOT = Path(__file__).resolve().parents[1]
BASE = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl"
POSITIONS = {1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 7: "P",
             9: "DT", 10: "DE", 11: "LB", 12: "CB", 13: "S", 14: "HC", 15: "TQB", 16: "DEF"}


def cents(value):
    if not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError("Missing or invalid ESPN score")
    return round(value * 100)


def team_name(team):
    name = team.get("name") or f"{team.get('location', '')} {team.get('nickname', '')}".strip()
    if not name:
        raise ValueError(f"Missing ESPN team name: {team['id']}")
    return name.strip()


def merge_transaction(transactions, transaction):
    if transaction["type"] == "DRAFT":
        return
    current = transactions.get(transaction["id"])
    if current:
        for field in ("type", "scoringPeriodId", "proposedDate", "processDate", "relatedTransactionId"):
            if current.get(field) is not None and transaction.get(field) is not None:
                if current[field] != transaction[field]:
                    raise ValueError(f"Conflicting ESPN transaction {field}: {transaction['id']}")
        if current.get("items") and transaction.get("items"):
            fields = ("playerId", "type", "fromTeamId", "toTeamId")

            def movements(items):
                return sorted(tuple(item.get(field) for field in fields) for item in items)

            if movements(current["items"]) != movements(transaction["items"]):
                raise ValueError(f"Conflicting ESPN player-card movements: {transaction['id']}")
        transactions[transaction["id"]] = {**current, **transaction}
    else:
        transactions[transaction["id"]] = transaction


def collect_events(payload, season, week, windows, roster_ids, ignored_trades=None):
    """Execution is somewhere between proposal and the next scoring week's start."""
    events = []
    for transaction in payload.get("transactions", []):
        if transaction.get("status") != "EXECUTED":
            continue
        if transaction["scoringPeriodId"] != week:
            raise ValueError("ESPN returned transactions for a different scoring period")
        kind = transaction["type"]
        if kind in ("DRAFT", "TRADE_DECLINE", "TRADE_VETO",
                    "TRADE_PROPOSAL"):
            continue
        if kind not in ("FREEAGENT", "WAIVER", "TRADE_UPHOLD", "TRADE_ACCEPT", "ROSTER", "FUTURE_ROSTER"):
            raise ValueError(f"Unsupported executed ESPN transaction: {kind}")
        if not transaction.get("items"):
            if kind != "TRADE_UPHOLD":
                raise ValueError(f"Executed ESPN transaction has no player/pick items: {transaction['id']}")
            logging.warning("%s: ignoring upheld trade %s with no player details",
                            season, transaction["id"])
            if ignored_trades is not None:
                ignored_trades.append(transaction["id"])
            continue
        lower = transaction.get("proposedDate")
        upper = windows.get(f"{season}:{week + 1}", windows[f"{season}:boundary"])[0] - 1
        completed = transaction.get("processDate")
        if completed is not None:
            lower = upper = completed
        if not isinstance(lower, int) or lower <= 0 or lower > upper:
            raise ValueError(f"Invalid ESPN transaction proposal interval: {transaction['id']}")
        adds, drops = {}, {}
        for item in transaction["items"]:
            player = str(item["playerId"])
            action = item["type"]
            if action == "ADD":
                adds[player] = item["toTeamId"]
            elif action == "DROP":
                drops[player] = item["fromTeamId"]
            elif action == "TRADE":
                adds[player] = item["toTeamId"]
                drops[player] = item["fromTeamId"]
            elif action == "DRAFT_TRADE" and item["playerId"] == 0:
                continue
            elif action == "LINEUP" and item["fromTeamId"] == item["toTeamId"]:
                continue
            else:
                raise ValueError(f"Unsupported ESPN player action: {action}")
        if not (set(adds.values()) | set(drops.values())) <= roster_ids:
            raise ValueError(f"Unknown ESPN team in transaction {transaction['id']}")
        if adds or drops:
            events.append({"id": transaction["id"], "season": season, "kind": kind,
                           "source": ("trade" if kind in ("TRADE_UPHOLD", "TRADE_ACCEPT") else
                                      "unknown" if kind in ("ROSTER", "FUTURE_ROSTER") else "freeAgency"),
                           "from": lower, "at": upper, "adds": adds, "drops": drops})
    return events


def draft_events(payload, season, roster_ids):
    draft = payload["draftDetail"]
    lower = payload["settings"]["draftSettings"]["date"]
    upper = draft.get("completeDate")
    if (not draft.get("drafted") or not isinstance(lower, int) or
            not isinstance(upper, int) or lower <= 0 or upper < lower):
        raise ValueError(f"Invalid or incomplete ESPN draft: {season}")
    events, seen = [], set()
    for pick in draft["picks"]:
        if pick["playerId"] in (-1, 0):
            continue
        player = str(pick["playerId"])
        if player in seen or pick["teamId"] not in roster_ids:
            raise ValueError(f"Invalid or duplicate ESPN draft pick: {season}:{player}")
        seen.add(player)
        # Keepers are retention, not a new draft acquisition. Preserve any
        # previously traced source; otherwise their origin remains unknown.
        if pick.get("keeper") or pick.get("reservedForKeeper"):
            continue
        events.append({"id": f"draft:{season}:{pick['overallPickNumber']}", "season": season,
                       "kind": "draft", "source": "draft", "from": lower, "at": upper,
                       "adds": {player: pick["teamId"]}, "drops": {}})
    return events


def attribute(start, events, windows):
    first, last = windows[f"{start['season']}:{start['week']}"]
    player, roster = start["player"], start["roster"]
    relevant = [event for event in events if event["from"] <= last and
                (player in event["adds"] or player in event["drops"])]
    definite = [event for event in relevant if event["at"] < first]
    candidates = [event for event in relevant if event["adds"].get(player) == roster and not any(
        later["from"] > event["at"] for later in definite)]
    # An untraced prior holding is also possible until a move is definitely
    # completed before the kickoff window. Never sort by proposal as execution.
    known = len(candidates) == 1 and bool(definite)
    event = candidates[0] if known else None
    return {**start, "source": event["source"] if event else "unknown",
            "reason": ("commissioner" if event["source"] == "unknown" else
                       "verified" if event["from"] == event["at"] else "interval") if event
            else "timing" if candidates else "untraced",
            "acquiredAt": event["from"] if event else None,
            "acquiredBefore": event["at"] if event else None,
            "acquiredSeason": event["season"] if event else None,
            "event": event["id"] if event else None, "kind": event["kind"] if event else None}


def extract_starters(payload, season, week, names, expected):
    starts, scores, seen = [], [], set()
    for game in payload["schedule"]:
        if game["matchupPeriodId"] != week:
            continue
        for side in ("home", "away"):
            team = game[side]
            roster = team["teamId"]
            if roster not in names or roster in seen:
                raise ValueError(f"Duplicate or unknown weekly ESPN team: {season}:{week}:{roster}")
            seen.add(roster)
            name = names[roster]
            score = cents(team["pointsByScoringPeriod"][str(week)])
            if expected.get((season, week, name)) != score:
                raise ValueError(f"ESPN weekly score differs from CSV: {season}:{week}:{name}")
            scores.append({"season": season, "week": week, "team": name, "points": score / 100})
            entries = team["rosterForCurrentScoringPeriod"]["entries"]
            players = set()
            starter_points = 0
            for entry in entries:
                if entry["lineupSlotId"] in (20, 21):
                    continue
                player = str(entry["playerId"])
                if player in players:
                    raise ValueError("Duplicate ESPN starter")
                players.add(player)
                pool = entry["playerPoolEntry"]
                info = pool["player"]
                points = cents(pool["appliedStatTotal"])
                starter_points += points
                stats = [stat for stat in info["stats"] if stat["statSourceId"] == 0 and
                         stat["seasonId"] == season and stat["scoringPeriodId"] == week]
                reported_zero = not stats and points == 0
                if not reported_zero and (len(stats) != 1 or cents(stats[0]["appliedTotal"]) != points):
                    raise ValueError(f"Missing or inconsistent actual player score: {season}:{week}:{player}")
                position = POSITIONS.get(info["defaultPositionId"])
                if not position or not info.get("fullName"):
                    raise ValueError(f"Missing ESPN player metadata: {player}")
                starts.append({"season": season, "week": week, "roster": roster, "team": name,
                               "player": player, "name": info["fullName"], "position": position,
                               "points": points / 100, "reportedZero": reported_zero})
            if not players:
                raise ValueError("Missing ESPN weekly starters")
            scores[-1].update({"starts": len(players), "starterPoints": starter_points / 100})
    if seen != set(names):
        raise ValueError(f"Incomplete ESPN weekly matchups: {season}:{week}")
    return starts, scores


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, default=ROOT / "data/espn")
    parser.add_argument("--cache-dir", type=Path, help="Optional private local API cache for repeat exports")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
    s2, swid = load_credentials(ROOT / ".env")
    cookie = "; ".join(f"{key}={value}" for key, value in (("espn_s2", s2), ("SWID", swid)) if value)

    def request(season, key, query, filters=None):
        cached = args.cache_dir / f"{season}-{key}.json" if args.cache_dir else None
        if cached and cached.exists():
            return json.loads(cached.read_text())
        url = (f"{BASE}/leagueHistory/130150?seasonId={season}&{query}" if season < 2018 else
               f"{BASE}/seasons/{season}/segments/0/leagues/130150?{query}")
        headers = {"Cookie": cookie}
        if filters:
            headers["x-fantasy-filter"] = json.dumps(filters)
        with urlopen(Request(url, headers=headers), timeout=30) as response:
            payload = json.load(response)
        if isinstance(payload, list):
            if len(payload) != 1:
                raise ValueError(f"Expected one ESPN historical season: {season}")
            payload = payload[0]
        if cached:
            cached.parent.mkdir(parents=True, exist_ok=True)
            cached.write_text(json.dumps(payload))
        return payload

    def fetch(season, week):
        return request(season, week, f"scoringPeriodId={week}"
               "&view=mTeam&view=mRoster&view=mMatchup&view=mMatchupScore"
               "&view=mTransactions2&view=mDraftDetail&view=mSettings")

    def schedule(season, week):
        cached = args.cache_dir / f"schedule-{season}-{week}.json" if args.cache_dir else None
        if cached and cached.exists():
            return json.loads(cached.read_text())
        window = kickoff_window(season, week)
        if cached:
            cached.parent.mkdir(parents=True, exist_ok=True)
            cached.write_text(json.dumps(window))
        return window

    def read_csv(filename):
        with (args.data_dir / filename).open(newline="", encoding="utf-8") as handle:
            return list(csv.DictReader(handle))

    standings, mappings, matchups = (read_csv(name) for name in (
        "standings_all_seasons.csv", "crosswalk.csv", "matchups_all_seasons.csv"))
    sleeper_dir = ROOT / "data/sleeper"
    details = json.loads((sleeper_dir / "details.json").read_text())
    import_season = next(season for season in details["seasons"] if season["season"] == 2022)
    import_players = {}
    for draft in import_season["drafts"]:
        for pick in draft["picks"]:
            import_players[pick["player"]] = {key: pick[key] for key in ("player", "name", "position")}
    for _, _, player, _ in import_season["starters"]:
        import_players[player] = {"player": player, **details["players"][player]}
    import_picks = list(import_players.values())
    import_draft = next(draft for draft in fetch_json(f"league/{import_season['leagueId']}/drafts")
                        if draft["draft_id"] == IMPORT_DRAFT)
    import_at = import_draft["last_picked"]
    if import_draft["status"] != "complete" or not isinstance(import_at, int):
        raise ValueError("Invalid completed Sleeper migration draft")
    sleeper_players = fetch_json("players/nfl")
    with (sleeper_dir / "crosswalk.csv").open(newline="", encoding="utf-8") as handle:
        import_owners = {int(row["roster_id"]): row["inheriting_owner"].strip() or row["owner"].strip()
                         for row in csv.DictReader(handle) if int(row["season"]) == 2022}
    regular_by_season = {int(row["season"]): int(row["wins"]) + int(row["losses"]) + int(row["ties"])
                         for row in standings if 2018 <= int(row["season"]) <= 2021}
    expected = {}
    for game in matchups:
        if (int(game["season"]) not in regular_by_season or
                int(game["week"]) > regular_by_season[int(game["season"])]):
            continue
        for side in ("home", "away"):
            key = (int(game["season"]), int(game["week"]), game[f"{side}_team"].strip())
            if key in expected:
                raise ValueError(f"Duplicate CSV weekly team: {key}")
            expected[key] = cents(float(game[f"{side}_score"]))
    windows, events, starts, scores, audits, history_audits = {}, [], [], [], [], []
    trades, trade_teams, trade_players = [], {}, {}
    previous_owners = None
    event_ids = {}
    migration_players = {}
    for season in range(2016, 2022):
        lookback_only = season < 2018
        teams = [row for row in standings if int(row["season"]) == season]
        weeks = {int(row["wins"]) + int(row["losses"]) + int(row["ties"]) for row in teams}
        if len(weeks) != 1 or not any(int(row["final_rank"]) == 1 for row in teams):
            raise ValueError(f"Missing or incomplete ESPN season: {season}")
        regular_weeks = weeks.pop()
        for week in range(1, regular_weeks + 2):
            windows[f"{season}:{week}"] = schedule(season, week)
        windows[f"{season}:boundary"] = schedule(season + 1, 1)
        initial = fetch(season, 1)
        if initial["seasonId"] != season or initial["id"] != 130150:
            raise ValueError("ESPN returned the wrong league or season")
        names = {team["id"]: team_name(team) for team in initial["teams"]}
        if set(names.values()) != {row["team"].strip() for row in teams}:
            raise ValueError(f"ESPN teams do not match standings: {season}")
        crosswalk = {row["team"].strip(): row["inheriting_owner"].strip() or row["owner"].strip()
                     for row in mappings if int(row["season"]) == season}
        owners = {roster: crosswalk[name] for roster, name in names.items()}
        trade_teams[str(season)] = {str(roster): name for roster, name in names.items()}
        if previous_owners and owners != previous_owners:
            raise ValueError("ESPN franchise continuity changed; explicit roster mapping required")
        previous_owners = owners
        season_events = draft_events(initial, season, set(names))
        transactions = {}
        player_ids = {pick["playerId"] for pick in initial["draftDetail"]["picks"]
                      if pick["playerId"] not in (-1, 0)}
        if season == 2021:
            player_ids.update(int(sleeper_players[pick["player"]]["espn_id"]) for pick in import_picks
                              if sleeper_players.get(pick["player"], {}).get("espn_id") is not None)
        for week in range(1, (1 if lookback_only else regular_weeks) + 1):
            payload = initial if week == 1 else fetch(season, week)
            if payload["seasonId"] != season or payload["scoringPeriodId"] != week:
                raise ValueError("ESPN returned the wrong scoring period")
            if not lookback_only:
                weekly_starts, weekly_scores = extract_starters(payload, season, week, names, expected)
                starts.extend(weekly_starts)
                scores.extend(weekly_scores)
            player_ids.update(entry["playerId"] for team in payload["teams"]
                              for entry in team["roster"]["entries"])
            for transaction in payload.get("transactions", []):
                merge_transaction(transactions, transaction)
                if transaction.get("status") == "EXECUTED":
                    player_ids.update(item["playerId"] for item in transaction.get("items", [])
                                      if item["playerId"] != 0)
        ids = sorted(player_ids)
        for offset in range(0, len(ids), 40):
            batch = ids[offset:offset + 40]
            digest = hashlib.sha256(json.dumps(batch).encode()).hexdigest()[:12]
            cards = request(season, f"cards-{digest}", "view=kona_playercard", {
                "players": {"filterIds": {"value": batch}}})
            if {player["id"] for player in cards["players"]} != set(batch):
                raise ValueError("ESPN returned incomplete player-card history")
            for player in cards["players"]:
                info = player["player"]
                trade_players[str(player["id"])] = info["fullName"]
                if season == 2021:
                    position = POSITIONS.get(info["defaultPositionId"])
                    if not position or not info.get("fullName"):
                        raise ValueError(f"Missing ESPN migration player metadata: {player['id']}")
                    migration_players[str(player["id"])] = {"name": info["fullName"], "position": position}
                for transaction in player.get("transactions", []):
                    merge_transaction(transactions, transaction)
        accepted = {transaction.get("relatedTransactionId") for transaction in transactions.values()
                    if transaction["type"] == "TRADE_ACCEPT" and transaction.get("status") == "EXECUTED"
                    and transaction.get("items")}
        ignored_trades = []
        for transaction in transactions.values():
            if transaction["type"] == "TRADE_UPHOLD" and transaction.get("relatedTransactionId") in accepted:
                continue
            for event in collect_events({"transactions": [transaction]}, season,
                                        transaction["scoringPeriodId"], windows, set(names), ignored_trades):
                key = (season, event["id"])
                if key in event_ids:
                    if event_ids[key] != event:
                        raise ValueError(f"Conflicting duplicate ESPN transaction: {key}")
                    continue
                event_ids[key] = event
                season_events.append(event)
            if (transaction["type"] in ("TRADE_UPHOLD", "TRADE_ACCEPT") and
                    transaction.get("status") == "EXECUTED" and transaction.get("items")):
                trades.append(espn_trade_record(transaction, season))
        events.extend(season_events)
        audit = {"season": season, "regularWeeks": regular_weeks,
                       "counts": dict(Counter(event["kind"] for event in season_events)),
                       "playerCards": len(ids),
                       "ignoredTrades": ignored_trades,
                       "emptyPicks": sum(p["playerId"] in (-1, 0) for p in initial["draftDetail"]["picks"]),
                       "keepersExcluded": sum(bool(p.get("keeper") or p.get("reservedForKeeper"))
                                              for p in initial["draftDetail"]["picks"])}
        (history_audits if lookback_only else audits).append(audit)
        if lookback_only:
            logging.warning("%s: using draft history for provenance lookback; transaction history "
                            "may be incomplete, so carried sources are best available evidence", season)
        logging.info("%s: collected %s acquisition events%s", season, len(season_events),
                     " (provenance lookback only)" if lookback_only else " and regular-season starters")
    by_player = defaultdict(list)
    for event in events:
        for player in set(event["adds"]) | set(event["drops"]):
            by_player[player].append(event)
    rows = [attribute(start, by_player[start["player"]], windows) for start in starts]
    matches = match_players(import_picks, sleeper_players, migration_players)
    roster_for_owner = {}
    for roster, owner in owners.items():
        if owner in roster_for_owner:
            raise ValueError(f"Ambiguous ESPN migration franchise: {owner}")
        roster_for_owner[owner] = roster
    migration_rows = []
    migration_window = {"2022:0": [import_at, import_at]}
    migration_events = {
        player: handoff_events(player_events, import_at)
        for player, player_events in by_player.items()
    }
    for pick in import_picks:
        match = matches[pick["player"]]
        candidates = []
        for roster, owner in import_owners.items():
            espn_roster = roster_for_owner.get(owner)
            if espn_roster is None:
                raise ValueError(f"No ESPN migration franchise: {owner}")
            start = {"season": 2022, "week": 0, "roster": espn_roster,
                     "player": match["espnPlayer"], "points": 0}
            evidence = attribute(start, migration_events.get(match["espnPlayer"], []), migration_window)
            if evidence["source"] != "unknown":
                candidates.append({**evidence, **match, "player": pick["player"],
                                   "roster": roster, "franchise": owner})
        if len(candidates) == 1:
            migration_rows.extend(candidates)
        else:
            migration_rows.append({**match, "player": pick["player"], "source": "unknown",
                                   "roster": None, "franchise": None,
                                   "reason": "timing" if candidates else "untraced"})
    logging.info("Migration: %s players; matches %s; sources %s", len(migration_rows),
                 dict(Counter(row["match"] for row in migration_rows)),
                 dict(Counter(row["source"] for row in migration_rows)))
    reported_zeros = sum(row["reportedZero"] for row in rows)
    if reported_zeros:
        logging.warning("%s starts have an explicit zero appliedStatTotal but no actual stat row "
                        "(e.g. NFL bye); preserved and flagged, not inferred", reported_zeros)
    result = {"version": 1, "platform": "espn", "method": "latest-franchise-acquisition",
              "provenanceStart": 2016, "missingTradePolicy": "ignore",
              "rows": rows, "scores": scores, "windows": windows, "audit": audits,
              "historyAudit": history_audits, "trades": trades, "tradeTeams": trade_teams,
              "tradePlayers": trade_players,
              "migration": {"draft": IMPORT_DRAFT, "at": import_at, "rows": migration_rows}}
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=args.data_dir, delete=False) as handle:
            temporary = Path(handle.name)
            json.dump(result, handle, separators=(",", ":"), allow_nan=False)
            handle.write("\n")
        os.replace(temporary, args.data_dir / "acquisitions.json")
    finally:
        if temporary:
            temporary.unlink(missing_ok=True)
    logging.info("Wrote ESPN acquisitions.json: %s starters; sources %s",
                 len(rows), dict(Counter(row["source"] for row in rows)))


if __name__ == "__main__":
    main()
