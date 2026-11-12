import csv
import tempfile
import unittest
from decimal import Decimal
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError

import get_sleeper_data as sleeper


def roster(roster_id, wins, points, ties=0):
    return {
        "roster_id": roster_id, "owner_id": str(roster_id),
        "settings": {
            "wins": wins, "losses": 13 - wins - ties, "ties": ties,
            "fpts": points, "fpts_decimal": 5,
            "fpts_against": 1200, "fpts_against_decimal": 87,
        },
    }


class SleeperTests(unittest.TestCase):
    def test_points_and_ranking(self):
        self.assertEqual(sleeper.total_points(roster(1, 8, 1200)["settings"], "fpts"),
                         Decimal("1200.05"))
        self.assertEqual(sleeper.regular_ranks([
            roster(1, 8, 1200), roster(2, 8, 1300),
            roster(3, 8, 1300), roster(4, 8, 1100, ties=1),
        ]), {4: 1, 2: 2, 3: 2, 1: 4})

    def test_bracket_placements_and_consolation(self):
        league = {"season": "2025", "status": "complete",
                  "settings": {"playoff_teams": 6, "playoff_type": 0}}
        winners = [
            {"p": 1, "w": 4, "l": 8}, {"p": 3, "w": 6, "l": 1},
            {"p": 5, "w": 7, "l": 10}, {"w": 4, "l": 10},
        ]
        losers = [{"p": 1, "w": 2, "l": 5}, {"p": 3, "w": 9, "l": 3}]
        self.assertEqual(sleeper.final_ranks(league, winners, losers),
                         {4: 1, 8: 2, 6: 3, 1: 4, 7: 5, 10: 6, 2: 7, 5: 8, 9: 9, 3: 10})
        league["status"] = "in_season"
        self.assertEqual(sleeper.final_ranks(league, winners, losers), {})
        league["status"] = "complete"
        league["settings"]["playoff_type"] = 1
        with self.assertLogs(level="WARNING"):
            self.assertEqual(len(sleeper.final_ranks(league, winners, losers)), 6)

    def test_scores_byes_and_home_order(self):
        teams = {i: {"team": f"Team {i}"} for i in range(1, 5)}
        entries = [
            {"roster_id": 2, "matchup_id": 1, "points": 100, "custom_points": None},
            {"roster_id": 1, "matchup_id": 1, "points": 90, "custom_points": 0},
            {"roster_id": 3, "matchup_id": None, "points": 50},
            {"roster_id": 4, "matchup_id": 2, "points": 75},
        ]
        self.assertEqual(sleeper.week_matchups(2025, 1, entries, teams), [{
            "season": 2025, "week": 1, "home_team": "Team 1", "home_score": Decimal(0),
            "away_team": "Team 2", "away_score": Decimal(100),
        }])
        with self.assertRaisesRegex(ValueError, "duplicate roster"):
            sleeper.week_matchups(2025, 1, entries + entries[:1], teams)

    def test_history_chain_and_cycle(self):
        leagues = {
            "league/2": {"league_id": "2", "season": "2025", "sport": "nfl",
                         "season_type": "regular", "previous_league_id": "1"},
            "league/1": {"league_id": "1", "season": "2024", "sport": "nfl",
                         "season_type": "regular", "previous_league_id": "0"},
        }
        with patch.object(sleeper, "fetch_json", side_effect=leagues.__getitem__):
            self.assertEqual([x["season"] for x in sleeper.season_history("2")],
                             ["2024", "2025"])
            leagues["league/1"]["previous_league_id"] = "2"
            with self.assertRaisesRegex(ValueError, "Cycle"):
                sleeper.season_history("2")

    def test_export_and_csv_headers(self):
        league = {
            "league_id": "123", "season": "2025", "status": "complete",
            "settings": {"playoff_teams": 4, "last_scored_leg": 1, "start_week": 1},
        }
        responses = {
            "rosters": [roster(i, 10 - i, 1500 - i) for i in range(1, 5)],
            "users": [{"user_id": str(i), "display_name": f"Owner{i}",
                       "metadata": {"team_name": f"Team{i}"}} for i in range(1, 5)],
            "winners_bracket": [{"p": 1, "w": 4, "l": 1}, {"p": 3, "w": 2, "l": 3}],
            "losers_bracket": [],
            "matchups/1": [{"roster_id": i, "matchup_id": (i + 1) // 2, "points": i * 10}
                           for i in range(1, 5)],
        }
        output = {filename: [] for filename in sleeper.FIELDS}
        with patch.object(sleeper, "fetch_json",
                          side_effect=lambda path: responses[path.removeprefix("league/123/")]):
            sleeper.export_season(league, output)
        self.assertEqual(output["champions.csv"][0]["champion"], "Team4")
        self.assertEqual(output["standings_all_seasons.csv"][0]["regular_season_rank"], 1)
        self.assertEqual(output["standings_all_seasons.csv"][0]["final_rank"], 2)
        self.assertEqual(output["crosswalk.csv"][0]["owner_id"], "1")
        with tempfile.TemporaryDirectory() as directory:
            sleeper.write_csvs(Path(directory), output)
            for filename, fields in sleeper.FIELDS.items():
                with (Path(directory) / filename).open(newline="", encoding="utf-8") as handle:
                    reader = csv.DictReader(handle)
                    self.assertEqual(reader.fieldnames, fields)
                    self.assertEqual(len(list(reader)), len(output[filename]))

    def test_request_retries_and_failure(self):
        transient = HTTPError("https://example.test", 503, "Unavailable", None, None)
        with patch.object(sleeper, "urlopen", side_effect=transient) as request, \
                patch.object(sleeper.time, "sleep"), self.assertLogs(level="WARNING"):
            with self.assertRaisesRegex(RuntimeError, "after 3 attempts"):
                sleeper.fetch_json("league/123")
            self.assertEqual(request.call_count, 3)
        permanent = HTTPError("https://example.test", 404, "Not found", None, None)
        with patch.object(sleeper, "urlopen", side_effect=permanent) as request:
            with self.assertRaisesRegex(RuntimeError, "404"):
                sleeper.fetch_json("league/123")
            self.assertEqual(request.call_count, 1)

    def test_default_skips_current_and_failed_exports_do_not_write(self):
        history = [{"status": "complete", "season": "2025"},
                   {"status": "in_season", "season": "2026"}]
        with patch("sys.argv", ["get_sleeper_data.py"]), \
                patch.object(sleeper, "season_history", return_value=history), \
                patch.object(sleeper, "export_season") as export, \
                patch.object(sleeper, "write_csvs") as write:
            sleeper.main()
            self.assertEqual(export.call_count, 1)
            self.assertEqual(export.call_args.args[0]["season"], "2025")
            write.assert_called_once()
        with patch("sys.argv", ["get_sleeper_data.py", "--include-current"]), \
                patch.object(sleeper, "season_history", return_value=history), \
                patch.object(sleeper, "export_season", side_effect=RuntimeError("failed")), \
                patch.object(sleeper, "write_csvs") as write:
            with self.assertRaisesRegex(RuntimeError, "failed"):
                sleeper.main()
            write.assert_not_called()


if __name__ == "__main__":
    unittest.main()
