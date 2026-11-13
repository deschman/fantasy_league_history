import unittest
from unittest.mock import patch

from trade_assets import espn_trade_record, trade_record
from get_sleeper_acquisitions import collect_events


class TradeAssetTests(unittest.TestCase):
    def test_player_and_pick_legs_are_sanitized(self):
        record = trade_record({"id": "t", "season": 2025, "at": 100,
                               "adds": {"p": 2}, "drops": {"p": 1}}, [1, 2],
                              [{"season": "2026", "round": 1, "roster_id": 1,
                                "previous_owner_id": 2, "owner_id": 1}])
        self.assertEqual(len(record["assets"]), 2)
        self.assertEqual(record["issues"], [])
        self.assertEqual(record["assets"][1]["originalRoster"], 1)

    def test_pick_only_trades_are_not_discarded(self):
        transaction = {"transaction_id": "t", "status": "complete", "type": "trade",
                       "status_updated": 100, "roster_ids": [1, 2],
                       "draft_picks": [{"season": "2026", "round": 2, "roster_id": 1,
                                        "previous_owner_id": 1, "owner_id": 2}]}
        trades = []
        with patch("get_sleeper_acquisitions.fetch_json", side_effect=lambda path:
                   [transaction] if path.endswith("/transactions/0") else []):
            events, counts = collect_events({"leagueId": "l", "season": 2025}, {1, 2}, trades)
        self.assertEqual(len(trades), 1)
        self.assertEqual(counts["trade"], 1)
        self.assertEqual(events[0]["adds"], {})

    def test_original_draft_slots_use_owner_order_not_current_pick_owner(self):
        draft = {"status": "complete", "draft_id": "d", "start_time": 50, "last_picked": 100,
                 "draft_order": {"a": 1, "b": 2}}
        picks = [{"player_id": "p", "round": 1, "draft_slot": 1, "roster_id": 2},
                 {"player_id": "q", "round": 1, "draft_slot": 2, "roster_id": 1}]
        drafts = []
        with patch("get_sleeper_acquisitions.fetch_json", side_effect=lambda path:
                   [] if "/transactions/" in path else [draft] if path.endswith("/drafts") else picks):
            collect_events({"leagueId": "l", "season": 2025}, {1, 2}, [], drafts, {"a": 1, "b": 2})
        self.assertEqual(drafts[0]["picks"][0]["originalRoster"], 1)
        self.assertEqual(drafts[0]["picks"][0]["roster"], 2)

    def test_espn_incidental_roster_cut_is_not_a_traded_asset(self):
        transaction = {"id": "t", "proposedDate": 100, "items": [
            {"type": "TRADE", "playerId": 10, "fromTeamId": 1, "toTeamId": 2},
            {"type": "TRADE", "playerId": 20, "fromTeamId": 2, "toTeamId": 1},
            {"type": "DROP", "playerId": 30, "fromTeamId": 1, "toTeamId": 0}]}
        record = espn_trade_record(transaction, 2021)
        self.assertEqual(record["issues"], [])
        self.assertEqual(len(record["assets"]), 2)
        transaction["items"].append({"type": "DRAFT_TRADE", "playerId": 0,
                                     "fromTeamId": 1, "toTeamId": 2, "overallPickNumber": 120})
        self.assertIn("ESPN draft-pick details are unavailable", espn_trade_record(transaction, 2021)["issues"])

    def test_missing_player_legs_are_incomplete_but_multiteam_deals_are_supported(self):
        self.assertTrue(trade_record({"id": "t", "season": 2025, "at": 100,
                                      "adds": {"p": 2}, "drops": {}}, [1, 2])["issues"])
        self.assertEqual(trade_record({"id": "t", "season": 2025, "at": 100,
                                       "adds": {}, "drops": {}}, [1, 2, 3])["issues"], [])


if __name__ == "__main__":
    unittest.main()
