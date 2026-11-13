import copy
import unittest

from get_espn_acquisitions import attribute, collect_events, draft_events, extract_starters, merge_transaction


class ESPNTests(unittest.TestCase):
    def setUp(self):
        self.windows = {"2018:1": [1000, 1500], "2018:2": [2000, 2500],
                        "2018:boundary": [5000, 5500]}
        self.start = {"season": 2018, "week": 1, "roster": 1, "player": "10", "points": 5}

    def event(self, source="draft", lower=100, upper=200, roster=1, identifier="draft"):
        return {"id": identifier, "source": source, "season": 2018, "kind": source,
                "from": lower, "at": upper, "adds": {"10": roster}, "drops": {}}

    def test_unknown_keeper_origin_and_carryover(self):
        self.assertEqual(attribute(self.start, [], self.windows)["source"], "unknown")
        event = self.event(source="trade")
        event["season"] = 2017
        result = attribute(self.start, [event], self.windows)
        self.assertEqual(result["source"], "trade")
        self.assertEqual(result["acquiredSeason"], 2017)

    def test_proposal_order_does_not_prove_execution_order(self):
        draft = self.event(upper=500)
        trade = self.event("trade", lower=300, upper=900, identifier="trade")
        result = attribute(self.start, [draft, trade], self.windows)
        self.assertEqual(result["source"], "unknown")
        trade["from"] = 600
        self.assertEqual(attribute(self.start, [draft, trade], self.windows)["source"], "trade")

    def test_future_move_and_in_week_uncertainty(self):
        draft = self.event()
        trade = self.event("trade", lower=1200, upper=1999, identifier="trade")
        self.assertEqual(attribute(self.start, [draft, trade], self.windows)["source"], "unknown")
        trade["from"] = 1600
        self.assertEqual(attribute(self.start, [draft, trade], self.windows)["source"], "draft")

    def test_drop_and_resign_reset(self):
        draft = self.event()
        drop = {**self.event(lower=300, upper=400, identifier="drop"), "adds": {}, "drops": {"10": 1}}
        resign = self.event("freeAgency", lower=500, upper=600, identifier="resign")
        self.assertEqual(attribute(self.start, [draft, drop], self.windows)["source"], "unknown")
        self.assertEqual(attribute(self.start, [draft, drop, resign], self.windows)["source"], "freeAgency")

    def test_missing_trade_is_ignored_without_invalidating_other_players(self):
        transaction = self.transaction("TRADE_UPHOLD")
        transaction.pop("items")
        ignored = []
        with self.assertLogs(level="WARNING") as logs:
            events = collect_events({"transactions": [transaction]}, 2018, 1, self.windows, {1}, ignored)
        self.assertEqual(events, [])
        self.assertEqual(ignored, ["tx"])
        self.assertIn("ignoring upheld trade", logs.output[0])
        self.assertEqual(attribute(self.start, [self.event(), *events], self.windows)["source"], "draft")

    def test_keeper_chain_uses_latest_real_acquisition_back_to_initial_draft(self):
        events = []
        for season in range(2016, 2022):
            keeper = season != 2016
            payload = {"draftDetail": {"drafted": True, "completeDate": (season - 2015) * 100,
                "picks": [{"playerId": 10, "teamId": 1, "keeper": keeper,
                           "reservedForKeeper": keeper, "overallPickNumber": 1}]},
                "settings": {"draftSettings": {"date": (season - 2015) * 100 - 10}}}
            events.extend(draft_events(payload, season, {1}))
        windows = {"2021:1": [2000, 2500]}
        start = {**self.start, "season": 2021}
        result = attribute(start, events, windows)
        self.assertEqual(result["source"], "draft")
        self.assertEqual(result["acquiredSeason"], 2016)
        trade = {**self.event("trade", 700, 800, identifier="trade"), "season": 2019}
        result = attribute(start, [*events, trade], windows)
        self.assertEqual(result["source"], "trade")
        self.assertEqual(result["acquiredSeason"], 2019)
        resign = {**self.event("freeAgency", 900, 1000, identifier="resign"), "season": 2020}
        result = attribute(start, [*events, trade, resign], windows)
        self.assertEqual(result["source"], "freeAgency")
        self.assertEqual(result["acquiredSeason"], 2020)

    def test_new_non_keeper_draft_and_known_other_roster_move_replace_prior_credit(self):
        original = {**self.event(lower=100, upper=200), "season": 2016}
        new_draft = {**self.event(lower=300, upper=400, identifier="new-draft"), "season": 2017}
        result = attribute(self.start, [original, new_draft], self.windows)
        self.assertEqual(result["acquiredSeason"], 2017)
        trade_away = self.event("trade", 500, 600, roster=2, identifier="away")
        self.assertEqual(attribute(self.start, [original, new_draft, trade_away], self.windows)["source"], "unknown")

    def test_keeper_and_empty_pick_do_not_create_draft_acquisition(self):
        payload = {"draftDetail": {"drafted": True, "completeDate": 200, "picks": [
            {"playerId": 10, "teamId": 1, "keeper": True, "overallPickNumber": 1},
            {"playerId": 11, "teamId": 2, "keeper": False, "overallPickNumber": 2},
            {"playerId": -1, "teamId": 1, "keeper": False, "overallPickNumber": 3}]},
            "settings": {"draftSettings": {"date": 100}}}
        events = draft_events(payload, 2018, {1, 2})
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["adds"], {"11": 2})

    def transaction(self, kind="FREEAGENT"):
        return {"id": "tx", "status": "EXECUTED", "type": kind, "scoringPeriodId": 1,
                "proposedDate": 100, "items": [
                    {"playerId": 10, "type": "ADD", "fromTeamId": 0, "toTeamId": 1},
                    {"playerId": 11, "type": "DROP", "fromTeamId": 1, "toTeamId": 0},
                    {"playerId": 12, "type": "LINEUP", "fromTeamId": 1, "toTeamId": 1}]}

    def test_transaction_bounds_actual_completion_and_pending(self):
        transaction = self.transaction("WAIVER")
        events = collect_events({"transactions": [transaction]}, 2018, 1, self.windows, {1})
        self.assertEqual(events[0]["source"], "freeAgency")
        self.assertEqual(events[0]["at"], 1999)
        transaction["processDate"] = 500
        events = collect_events({"transactions": [transaction]}, 2018, 1, self.windows, {1})
        self.assertEqual((events[0]["from"], events[0]["at"]), (500, 500))
        transaction["status"] = "CANCELED"
        self.assertEqual(collect_events({"transactions": [transaction]}, 2018, 1, self.windows, {1}), [])

    def test_trade_legs_and_pick_only(self):
        transaction = self.transaction("TRADE_ACCEPT")
        transaction["items"] = [{"playerId": 10, "type": "TRADE", "fromTeamId": 1, "toTeamId": 2},
                                {"playerId": 0, "type": "DRAFT_TRADE", "fromTeamId": 2, "toTeamId": 1}]
        event = collect_events({"transactions": [transaction]}, 2018, 1, self.windows, {1, 2})[0]
        self.assertEqual(event["adds"], {"10": 2})
        self.assertEqual(event["drops"], {"10": 1})
        transaction["items"] = transaction["items"][1:]
        self.assertEqual(collect_events({"transactions": [transaction]}, 2018, 1, self.windows, {1, 2}), [])

    def test_roster_drop_is_not_silently_ignored(self):
        transaction = self.transaction("ROSTER")
        event = collect_events({"transactions": [transaction]}, 2018, 1, self.windows, {1})[0]
        self.assertEqual(event["drops"], {"11": 1})
        self.assertEqual(event["source"], "unknown")

    def test_cards_enrich_transactions_without_conflicting_or_losing_timestamps(self):
        transaction = self.transaction()
        transaction["processDate"] = 200
        transactions = {}
        merge_transaction(transactions, transaction)
        enriched = self.transaction()
        enriched["items"][0]["acquisitionBudget"] = 0
        merge_transaction(transactions, enriched)
        self.assertEqual(transactions["tx"]["processDate"], 200)
        enriched = copy.deepcopy(enriched)
        enriched["items"][0]["toTeamId"] = 2
        with self.assertRaisesRegex(ValueError, "Conflicting"):
            merge_transaction(transactions, enriched)

    def test_invalid_roster_action_score_and_timestamp_fail(self):
        transaction = self.transaction()
        transaction["items"][0]["toTeamId"] = 5
        with self.assertRaisesRegex(ValueError, "Unknown ESPN team"):
            collect_events({"transactions": [transaction]}, 2018, 1, self.windows, {1})
        transaction = self.transaction()
        transaction["items"][0]["type"] = "MYSTERY"
        with self.assertRaisesRegex(ValueError, "Unsupported"):
            collect_events({"transactions": [transaction]}, 2018, 1, self.windows, {1})
        transaction = self.transaction()
        transaction["proposedDate"] = 6000
        with self.assertRaisesRegex(ValueError, "interval"):
            collect_events({"transactions": [transaction]}, 2018, 1, self.windows, {1})

    def test_starters_exclude_bench_use_actual_points_and_flag_reported_zero(self):
        def entry(player, slot, points, stats=True):
            return {"playerId": player, "lineupSlotId": slot, "playerPoolEntry": {
                "appliedStatTotal": points, "player": {"defaultPositionId": 11, "fullName": "Linebacker",
                    "stats": [{"statSourceId": 0, "seasonId": 2018, "scoringPeriodId": 1,
                               "appliedTotal": points}] if stats else []}}}
        home = {"teamId": 1, "pointsByScoringPeriod": {"1": 5}, "rosterForCurrentScoringPeriod": {
            "entries": [entry(10, 10, 5), entry(11, 20, 99), entry(12, 10, 0, False)]}}
        away = {"teamId": 2, "pointsByScoringPeriod": {"1": -1}, "rosterForCurrentScoringPeriod": {
            "entries": [entry(13, 10, -1)]}}
        payload = {"schedule": [{"matchupPeriodId": 1, "home": home, "away": away}]}
        expected = {(2018, 1, "A"): 500, (2018, 1, "B"): -100}
        rows, scores = extract_starters(payload, 2018, 1, {1: "A", 2: "B"}, expected)
        self.assertEqual([row["points"] for row in rows], [5, 0, -1])
        self.assertTrue(rows[1]["reportedZero"])
        self.assertEqual(rows[0]["position"], "LB")
        expected[(2018, 1, "A")] = 0
        with self.assertRaisesRegex(ValueError, "differs from CSV"):
            extract_starters(payload, 2018, 1, {1: "A", 2: "B"}, expected)


if __name__ == "__main__":
    unittest.main()
