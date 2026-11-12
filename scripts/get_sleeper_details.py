"""Export completed-season playoff, starter, and draft data without changing crosswalks."""

import argparse
import csv
import json
import logging
import os
import tempfile
from pathlib import Path

from get_sleeper_data import DEFAULT_OUTPUT, fetch_json, season_history

LATEST_COMPLETED_LEAGUE = "1179896124247248896"


def export_details(league, roster_ids):
    season = int(league["season"])
    settings = league["settings"]
    if league["status"] != "complete":
        raise ValueError(f"{season}: only completed seasons can be exported")
    if settings.get("playoff_round_type", 0) != 0:
        raise ValueError(f"{season}: multi-week playoff rounds need explicit week mapping")
    if settings.get("league_average_match", 0):
        raise ValueError(f"{season}: median games need separate record reconciliation")
    bracket = fetch_json(f"league/{league['league_id']}/winners_bracket")
    title_games = []
    participants = set()
    for game in bracket:
        if game.get("p") not in (None, 1):
            continue
        if any(not isinstance(game.get(key), int) for key in ("t1", "t2", "w", "l")):
            raise ValueError(f"{season}: unresolved title-bracket game")
        if {game["w"], game["l"]} != {game["t1"], game["t2"]}:
            raise ValueError(f"{season}: invalid bracket result")
        participants.update((game["t1"], game["t2"]))
        title_games.append({
            "week": settings["playoff_week_start"] + game["r"] - 1,
            "home": game["t1"], "away": game["t2"], "winner": game["w"],
        })
    if not participants <= roster_ids or len(participants) != settings["playoff_teams"]:
        raise ValueError(f"{season}: playoff teams do not match crosswalk rosters")
    starters = []
    for week in range(settings.get("start_week", 1), settings["last_scored_leg"] + 1):
        entries = fetch_json(f"league/{league['league_id']}/matchups/{week}")
        if {entry["roster_id"] for entry in entries} != roster_ids:
            raise ValueError(f"{season} week {week}: incomplete roster data")
        for entry in entries:
            players = entry["starters"]
            points = entry["starters_points"]
            if len(players) != len(points):
                raise ValueError(f"{season} week {week}: starter score length mismatch")
            for player_id, score in zip(players, points):
                if player_id in ("0", None):
                    continue
                if score is None:
                    raise ValueError(f"{season} week {week}: missing starter points")
                starters.append([week, entry["roster_id"], player_id, score])
    drafts = []
    for draft in fetch_json(f"league/{league['league_id']}/drafts"):
        if draft["status"] != "complete":
            raise ValueError(f"{season}: historical draft is incomplete")
        picks = []
        for pick in fetch_json(f"draft/{draft['draft_id']}/picks"):
            if pick["roster_id"] not in roster_ids:
                raise ValueError(f"{season}: draft roster missing from crosswalk")
            metadata = pick["metadata"]
            picks.append({
                "pick": pick["pick_no"], "round": pick["round"],
                "roster": pick["roster_id"], "player": pick["player_id"],
                "name": f"{metadata.get('first_name', '')} {metadata.get('last_name', '')}".strip(),
                "position": metadata["position"], "keeper": bool(pick.get("is_keeper")),
            })
        if not picks:
            logging.warning("%s: draft %s is marked complete but has no picks; retained as empty",
                            season, draft["draft_id"])
        drafts.append({"id": draft["draft_id"], "type": draft["type"], "picks": picks})
    if not drafts:
        raise ValueError(f"{season}: no historical draft found")
    return {
        "season": season, "leagueId": league["league_id"],
        "regularWeeks": settings["playoff_week_start"] - 1,
        "lastWeek": settings["last_scored_leg"], "playoffRosters": sorted(participants),
        "titleGames": title_games, "starters": starters, "drafts": drafts,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--league-id", default=LATEST_COMPLETED_LEAGUE)
    parser.add_argument("--data-dir", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
    with (args.data_dir / "crosswalk.csv").open(newline="", encoding="utf-8") as handle:
        crosswalk = list(csv.DictReader(handle))
    seasons = []
    for league in season_history(args.league_id):
        if league["status"] != "complete":
            logging.info("Skipping %s: not complete", league["season"])
            continue
        roster_ids = {int(row["roster_id"]) for row in crosswalk if row["league_id"] == league["league_id"]}
        if not roster_ids:
            raise ValueError(f"{league['season']}: export standings/crosswalk before details")
        seasons.append(export_details(league, roster_ids))
        logging.info("Exported %s historical details", league["season"])
    if not seasons:
        raise ValueError("No completed seasons found")
    players = fetch_json("players/nfl")
    used = {entry[2] for season in seasons for entry in season["starters"]}
    names = {}
    for player_id in sorted(used):
        player = players.get(player_id)
        if not player:
            raise ValueError(f"Player {player_id} is missing from Sleeper's player index")
        name = player.get("full_name") or f"{player.get('first_name', '')} {player.get('last_name', '')}".strip()
        if not name or not player.get("position"):
            raise ValueError(f"Incomplete player metadata: {player_id}")
        names[player_id] = {"name": name, "position": player["position"]}
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=args.data_dir, delete=False) as handle:
            temporary = Path(handle.name)
            json.dump({"seasons": seasons, "players": names}, handle, separators=(",", ":"), allow_nan=False)
            handle.write("\n")
        os.replace(temporary, args.data_dir / "details.json")
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    logging.info("Wrote details.json: %s seasons, %s started players; crosswalks unchanged", len(seasons), len(names))


if __name__ == "__main__":
    main()
