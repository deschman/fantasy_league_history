"""Export Sleeper league history using only the Python standard library.

Run: python scripts/get_sleeper_data.py
See --help for league, destination, and in-progress season options.
API documentation: https://docs.sleeper.com/
"""

import argparse
import csv
import json
import logging
import os
import tempfile
import time
from collections import defaultdict
from decimal import Decimal
from fractions import Fraction
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import urlopen

DEFAULT_LEAGUE_ID = "1309648546055610368"
DEFAULT_OUTPUT = Path(__file__).resolve().parents[1] / "data" / "sleeper"
API_URL = "https://api.sleeper.app/v1"
FIELDS = {
    "standings_all_seasons.csv": [
        "season", "team", "owner", "wins", "losses", "ties", "points_for",
        "points_against", "regular_season_rank", "final_rank",
    ],
    "champions.csv": [
        "season", "champion", "champion_owner", "runner_up", "runner_up_owner",
        "third_place", "third_place_owner",
    ],
    "matchups_all_seasons.csv": [
        "season", "week", "home_team", "home_score", "away_team", "away_score",
    ],
    "crosswalk.csv": [
        "season", "team", "owner", "inheriting_owner", "league_id",
        "roster_id", "owner_id",
    ],
}
Row = dict[str, Any]


def fetch_json(path: str) -> Any:
    url = f"{API_URL}/{path}"
    for attempt in range(3):
        try:
            with urlopen(url, timeout=30) as response:
                return json.load(response)
        except (HTTPError, URLError, TimeoutError) as error:
            if isinstance(error, HTTPError) and error.code != 429 and error.code < 500:
                raise RuntimeError(f"GET {url} failed: {error}") from error
            if attempt == 2:
                raise RuntimeError(f"GET {url} failed after 3 attempts: {error}") from error
            delay = 2 ** (attempt + 1)
            logging.warning("GET %s failed: %s; retrying in %ss", url, error, delay)
            time.sleep(delay)
    raise AssertionError("Unreachable")


def season_history(league_id: str) -> list[Row]:
    history = []
    seen = set()
    while league_id and league_id != "0":
        if league_id in seen:
            raise ValueError(f"Cycle in previous_league_id at {league_id}")
        seen.add(league_id)
        league = fetch_json(f"league/{league_id}")
        if not isinstance(league, dict) or league.get("league_id") != league_id:
            raise ValueError(f"Invalid or missing Sleeper league: {league_id}")
        if league.get("sport") != "nfl" or league.get("season_type") != "regular":
            raise ValueError(f"League {league_id} is not a regular NFL fantasy league")
        history.append(league)
        league_id = str(league.get("previous_league_id") or "")
    history.sort(key=lambda league: int(league["season"]))
    seasons = [league["season"] for league in history]
    if len(seasons) != len(set(seasons)):
        raise ValueError("League chain contains multiple leagues for the same season")
    return history


def total_points(settings: Row, field: str) -> Decimal:
    return Decimal(str(settings[field])) + Decimal(str(settings.get(f"{field}_decimal", 0))) / 100


def record_key(roster: Row) -> tuple[Fraction, Decimal]:
    settings = roster["settings"]
    wins, losses, ties = (settings[key] for key in ("wins", "losses", "ties"))
    games = wins + losses + ties
    percentage = Fraction(2 * wins + ties, 2 * games) if games else Fraction(0)
    return percentage, total_points(settings, "fpts")


def regular_ranks(rosters: list[Row]) -> dict[int, int]:
    ordered = sorted(rosters, key=record_key, reverse=True)
    ranks = {}
    previous = None
    rank = 0
    for index, roster in enumerate(ordered, 1):
        key = record_key(roster)
        if key != previous:
            rank = index
        ranks[roster["roster_id"]] = rank
        previous = key
    return ranks


def final_ranks(league: Row, winners: list[Row], losers: list[Row]) -> dict[int, int]:
    if league["status"] != "complete":
        return {}
    ranks: dict[int, int] = {}

    def apply_placements(bracket: list[Row], offset: int) -> None:
        for match in bracket:
            place = match.get("p")
            if place is None:
                continue
            winner, loser = match.get("w"), match.get("l")
            if winner is None or loser is None:
                logging.warning("%s: unresolved placement match %s", league["season"], match["m"])
                continue
            ranks[winner] = offset + place
            ranks[loser] = offset + place + 1

    apply_placements(winners, 0)
    if league["settings"].get("playoff_type", 0) == 0:
        apply_placements(losers, league["settings"]["playoff_teams"])
    else:
        logging.warning("%s: non-standard consolation bracket; lower final ranks left blank",
                        league["season"])
    if len(ranks) != len(set(ranks.values())):
        raise ValueError(f"{league['season']}: conflicting playoff placements")
    return ranks


def week_matchups(season: int, week: int, entries: list[Row], teams: dict[int, Row]) -> list[Row]:
    groups: dict[int, list[Row]] = defaultdict(list)
    seen = set()
    for entry in entries:
        roster_id = entry["roster_id"]
        if roster_id not in teams or roster_id in seen:
            raise ValueError(f"{season} week {week}: unknown or duplicate roster {roster_id}")
        seen.add(roster_id)
        if entry.get("matchup_id") is not None:
            groups[entry["matchup_id"]].append(entry)
    rows = []
    for matchup_id, pair in sorted(groups.items()):
        if len(pair) == 1:
            continue  # Sleeper can assign a matchup ID to a playoff bye.
        if len(pair) != 2:
            raise ValueError(f"{season} week {week}: matchup {matchup_id} has {len(pair)} teams")
        home, away = sorted(pair, key=lambda entry: entry["roster_id"])

        def score(entry: Row) -> Decimal:
            value = entry.get("custom_points")
            return Decimal(str(entry["points"] if value is None else value))

        rows.append({
            "season": season, "week": week,
            "home_team": teams[home["roster_id"]]["team"], "home_score": score(home),
            "away_team": teams[away["roster_id"]]["team"], "away_score": score(away),
        })
    return rows


def export_season(league: Row, output: dict[str, list[Row]]) -> None:
    season, league_id = int(league["season"]), league["league_id"]
    settings = league["settings"]
    if settings.get("divisions", 0) or settings.get("playoff_seed_type", 0):
        raise ValueError(f"{season}: division/custom seeding is not supported by this exporter")
    rosters = fetch_json(f"league/{league_id}/rosters")
    users = {user["user_id"]: user for user in fetch_json(f"league/{league_id}/users")}
    ranks = regular_ranks(rosters)
    placements = final_ranks(
        league, fetch_json(f"league/{league_id}/winners_bracket"),
        fetch_json(f"league/{league_id}/losers_bracket"),
    )
    teams: dict[int, Row] = {}
    for roster in sorted(rosters, key=lambda roster: (ranks[roster["roster_id"]], roster["roster_id"])):
        roster_id, owner_id = roster["roster_id"], roster.get("owner_id")
        if owner_id and owner_id not in users:
            raise ValueError(f"{season}: owner {owner_id} missing from league users")
        user = users.get(owner_id, {})
        owner = user.get("display_name") or ""
        team = (user.get("metadata") or {}).get("team_name") or owner or f"Roster {roster_id}"
        if not owner_id:
            logging.warning("%s: roster %s is unowned", season, roster_id)
        teams[roster_id] = {"team": team, "owner": owner}
        stats = roster["settings"]
        output["standings_all_seasons.csv"].append({
            "season": season, "team": team, "owner": owner,
            "wins": stats["wins"], "losses": stats["losses"], "ties": stats["ties"],
            "points_for": total_points(stats, "fpts"),
            "points_against": total_points(stats, "fpts_against"),
            "regular_season_rank": ranks[roster_id], "final_rank": placements.get(roster_id),
        })
        output["crosswalk.csv"].append({
            "season": season, "team": team, "owner": owner, "inheriting_owner": "",
            "league_id": league_id, "roster_id": roster_id, "owner_id": owner_id,
        })
    if league["status"] == "complete":
        if set(placements) - set(teams):
            raise ValueError(f"{season}: bracket references an unknown roster")
        missing = set(teams) - set(placements)
        if missing:
            logging.warning("%s: no verified final placement for rosters %s", season, sorted(missing))
        podium = {rank: teams[roster_id] for roster_id, rank in placements.items()}
        if not all(rank in podium for rank in (1, 2, 3)):
            raise ValueError(f"{season}: completed league has no resolved top-three placements")
        champions: Row = {"season": season}
        for field, rank in (("champion", 1), ("runner_up", 2), ("third_place", 3)):
            champions[field] = podium[rank]["team"]
            champions[f"{field}_owner"] = podium[rank]["owner"]
        output["champions.csv"].append(champions)

    last_week = int(settings["last_scored_leg"])
    for week in range(int(settings.get("start_week", 1)), last_week + 1):
        entries = fetch_json(f"league/{league_id}/matchups/{week}")
        if not entries:
            raise ValueError(f"{season}: no matchup data for scored week {week}")
        output["matchups_all_seasons.csv"].extend(week_matchups(season, week, entries, teams))
    logging.info("%s: exported %s teams, weeks through %s (%s)",
                 season, len(teams), last_week, league["status"])


def write_csvs(destination: Path, output: dict[str, list[Row]]) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    for filename, fields in FIELDS.items():
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w", encoding="utf-8", newline="", dir=destination, delete=False,
            ) as handle:
                temporary = Path(handle.name)
                writer = csv.DictWriter(handle, fieldnames=fields)
                writer.writeheader()
                writer.writerows(output[filename])
            os.replace(temporary, destination / filename)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
        logging.info("Wrote %s (%s rows)", destination / filename, len(output[filename]))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--league-id", default=DEFAULT_LEAGUE_ID,
                        help="Latest Sleeper league ID; previous seasons are discovered automatically")
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--include-current", action="store_true",
                        help="Also include in-season leagues, through last_scored_leg; no final ranks")
    args = parser.parse_args()
    if not args.league_id.isdigit():
        parser.error("--league-id must be a numeric Sleeper league ID")
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
    output: dict[str, list[Row]] = {filename: [] for filename in FIELDS}
    exported = 0
    for league in season_history(args.league_id):
        if league["status"] != "complete" and not (
            args.include_current and league["status"] == "in_season"
        ):
            logging.info("Skipping %s (%s)", league["season"], league["status"])
            continue
        export_season(league, output)
        exported += 1
    if not exported:
        raise ValueError("No eligible seasons found; existing CSVs have not been changed")
    write_csvs(args.output_dir, output)


if __name__ == "__main__":
    main()
