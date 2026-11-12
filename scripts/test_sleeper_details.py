import unittest
from unittest.mock import patch

from get_sleeper_details import export_details


class DetailTests(unittest.TestCase):
    def setUp(self):
        self.league = {
            "season": "2025", "league_id": "test", "status": "complete",
            "settings": {"playoff_week_start": 2, "last_scored_leg": 2, "playoff_teams": 2},
        }
        self.responses = {
            "league/test/winners_bracket": [{"p": 1, "r": 1, "t1": 1, "t2": 2, "w": 1, "l": 2}],
            "league/test/matchups/1": [
                {"roster_id": 1, "starters": ["abc", "0"], "starters_points": [10.5, 0]},
                {"roster_id": 2, "starters": ["def"], "starters_points": [-1]},
            ],
            "league/test/matchups/2": [
                {"roster_id": 1, "starters": ["abc"], "starters_points": [20]},
                {"roster_id": 2, "starters": ["def"], "starters_points": [12]},
            ],
            "league/test/drafts": [{"status": "complete", "draft_id": "draft", "type": "snake"}],
            "draft/draft/picks": [{
                "roster_id": 1, "pick_no": 1, "round": 1, "player_id": "abc", "is_keeper": True,
                "metadata": {"first_name": "Test", "last_name": "Player", "position": "QB"},
            }],
        }

    def export(self):
        with patch("get_sleeper_details.fetch_json", side_effect=self.responses.__getitem__):
            return export_details(self.league, {1, 2})

    def test_completed_history_starters_and_keeper_picks(self):
        result = self.export()
        self.assertEqual(result["titleGames"], [{"week": 2, "home": 1, "away": 2, "winner": 1}])
        self.assertEqual(result["starters"], [[1, 1, "abc", 10.5], [1, 2, "def", -1],
                                            [2, 1, "abc", 20], [2, 2, "def", 12]])
        self.assertTrue(result["drafts"][0]["picks"][0]["keeper"])

    def test_current_season_rejected(self):
        self.league["status"] = "in_season"
        with self.assertRaisesRegex(ValueError, "only completed"):
            self.export()

    def test_multiweek_brackets_rejected(self):
        self.league["settings"]["playoff_round_type"] = 1
        with self.assertRaisesRegex(ValueError, "multi-week"):
            self.export()

    def test_incomplete_starter_scores_rejected(self):
        self.responses["league/test/matchups/1"][0]["starters_points"] = [10.5]
        with self.assertRaisesRegex(ValueError, "length mismatch"):
            self.export()

    def test_empty_draft_is_explicit_not_silently_removed(self):
        self.responses["draft/draft/picks"] = []
        with self.assertLogs(level="WARNING"):
            result = self.export()
        self.assertEqual(result["drafts"][0]["picks"], [])


if __name__ == "__main__":
    unittest.main()
