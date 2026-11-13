import unittest
from unittest.mock import patch

from get_sleeper_acquisitions import attribute_starts, collect_events, milliseconds, migration_events
from acquisition_migration import IMPORT_DRAFT, handoff_events, match_players


def event(timestamp, source="draft", roster=1, player="p", drops=None, event_id=None, season=2022):
    return {"at": timestamp, "id": event_id or str(timestamp), "source": source, "kind": source,
            "adds": {player: roster} if roster else {}, "drops": drops or {}, "season": season}


class AttributionTests(unittest.TestCase):
    def attribute(self, events, roster=1, season=2022, first=100, last=200):
        return attribute_starts(
            [{"season": season, "starters": [[1, roster, "p", 25.25]]}], events,
            {f"{season}:1": [first, last]},
        )[0]

    def test_draft_credit_carries_across_seasons(self):
        row = self.attribute([event(50)], season=2025)
        self.assertEqual(row["source"], "draft")
        self.assertEqual(row["acquiredSeason"], 2022)
        self.assertEqual(row["points"], 25.25)

    def test_trade_then_drop_and_resign_resets_source(self):
        events = [event(10), event(20, "trade", roster=2, drops={"p": 1}),
                  event(30, roster=None, drops={"p": 2}), event(40, "freeAgency", roster=2)]
        row = self.attribute(events, roster=2)
        self.assertEqual(row["source"], "freeAgency")
        self.assertEqual(row["event"], "40")

    def test_postgame_future_moves_do_not_relabel_prior_points(self):
        events = [event(50), event(250, "trade", roster=2, drops={"p": 1})]
        self.assertEqual(self.attribute(events)["source"], "draft")

    def test_move_during_kickoff_window_is_not_applied_to_the_wrong_team(self):
        events = [event(50), event(150, "trade", roster=2, drops={"p": 1})]
        self.assertEqual(self.attribute(events)["source"], "draft")
        self.assertEqual(self.attribute(events, roster=2)["source"], "trade")

    def test_drop_and_reacquire_during_window_is_ambiguous_for_same_roster(self):
        events = [event(50), event(120, roster=None, drops={"p": 1}), event(150, "freeAgency")]
        row = self.attribute(events)
        self.assertEqual(row["source"], "unknown")
        self.assertEqual(row["reason"], "timing")
        self.assertIsNone(row["event"])

    def test_untraced_and_commissioner_starts_not_guessed(self):
        row = self.attribute([])
        self.assertEqual((row["source"], row["reason"]), ("unknown", "untraced"))
        row = self.attribute([event(50, "unknown")])
        self.assertEqual((row["source"], row["reason"]), ("unknown", "commissioner"))

    def test_ambiguous_simultaneous_events_are_unknown(self):
        events = [event(50, event_id="a"), event(50, "freeAgency", event_id="b")]
        self.assertEqual(self.attribute(events)["source"], "unknown")
        with self.assertRaisesRegex(ValueError, "Duplicate acquisition"):
            self.attribute([events[0], events[0]])

    def test_completion_timestamp_not_week_leg_or_creation_time(self):
        transaction = {"status": "complete", "type": "waiver", "created": 10, "status_updated": 80,
                       "transaction_id": "t", "adds": {"p": 1}, "drops": None}
        draft = {"status": "complete", "draft_id": "d", "last_picked": 50, "start_time": 30}

        def fetch(path):
            if "/transactions/" in path:
                # Duplicate returned by two endpoints must be counted once.
                return [transaction, {**transaction, "status": "failed"}] if path.endswith(("/0", "/1")) else []
            if path.endswith("/drafts"):
                return [draft]
            return [{"player_id": "q", "roster_id": 1}]

        with patch("get_sleeper_acquisitions.fetch_json", side_effect=fetch) as mocked:
            events, counts = collect_events({"season": 2022, "leagueId": "l"}, {1})
        self.assertEqual(counts, {"waiver": 1, "draft": 1})
        waiver = next(row for row in events if row["source"] == "freeAgency")
        self.assertEqual(waiver["at"], 80)
        self.assertTrue(any(call.args[0].endswith("/transactions/22") for call in mocked.call_args_list))

    def test_bad_roster_and_missing_timestamp_fail(self):
        transaction = {"status": "complete", "type": "trade", "status_updated": 80,
                       "transaction_id": "t", "adds": {"p": 9}, "drops": None}
        with patch("get_sleeper_acquisitions.fetch_json", return_value=[transaction]):
            with self.assertRaisesRegex(ValueError, "Unknown roster"):
                collect_events({"season": 2022, "leagueId": "l"}, {1})
        transaction["adds"] = {"p": 1}
        transaction["status_updated"] = None
        with patch("get_sleeper_acquisitions.fetch_json", return_value=[transaction]):
            with self.assertRaisesRegex(ValueError, "Missing completed"):
                collect_events({"season": 2022, "leagueId": "l"}, {1})

    def test_schedule_timestamp_conversion_is_utc(self):
        self.assertEqual(milliseconds("1970-01-01T00:01Z"), 60000)

    def test_move_during_draft_not_silently_overwritten_by_draft_completion(self):
        draft = {**event(80), "from": 20}
        trade = event(50, "trade", roster=2, drops={"p": 1})
        self.assertEqual(self.attribute([draft, trade], roster=1)["source"], "unknown")
        self.assertEqual(self.attribute([draft, trade], roster=2)["source"], "unknown")
        later = event(90, "freeAgency", roster=2)
        self.assertEqual(self.attribute([draft, trade, later], roster=2)["source"], "freeAgency")

    def migration(self):
        payload = {"missingTradePolicy": "ignore", "provenanceStart": 2016,
                   "migration": {"draft": IMPORT_DRAFT, "at": 50, "rows": [{
                       "player": "p", "espnPlayer": "10", "roster": 1, "franchise": "owner",
                       "source": "trade", "acquiredAt": 10, "acquiredBefore": 20,
                       "acquiredSeason": 2020, "event": "espn-trade", "kind": "TRADE_ACCEPT",
                       "match": "espn-id", "reason": "interval"}]}}
        mappings = [{"season": "2022", "roster_id": "1", "owner": "owner", "inheriting_owner": ""}]
        return payload, mappings

    def test_inherited_origin_carries_until_actual_sleeper_acquisition(self):
        payload, mappings = self.migration()
        imported = migration_events(payload, mappings, [event(80, "trade", roster=2)])
        row = self.attribute(imported, season=2025)
        self.assertEqual((row["source"], row["reason"], row["acquiredSeason"]), ("trade", "migration", 2020))
        self.assertEqual(row["espnPlayer"], "10")
        self.assertEqual(row["acquiredAt"], 10)
        actual = event(70, "freeAgency")
        row = self.attribute([*imported, actual])
        self.assertEqual((row["source"], row["reason"]), ("freeAgency", "verified"))
        row = self.attribute([*imported, event(70, "trade", roster=2, drops={"p": 1})], roster=2)
        self.assertEqual((row["source"], row["reason"]), ("trade", "verified"))

    def test_commissioner_restoration_keeps_original_but_true_resigning_resets(self):
        payload, mappings = self.migration()
        imported = migration_events(payload, mappings, [])
        drop = event(60, roster=None, drops={"p": 1})
        restore = {**event(70, "unknown"), "kind": "commissioner"}
        row = self.attribute([*imported, drop, restore])
        self.assertEqual((row["source"], row["reason"]), ("trade", "migration"))
        row = self.attribute([*imported, drop, event(70, "freeAgency")])
        self.assertEqual((row["source"], row["reason"]), ("freeAgency", "verified"))
        row = self.attribute([*imported, {**restore, "adds": {"p": 2}}], roster=2)
        self.assertEqual((row["source"], row["reason"]), ("unknown", "commissioner"))

    def test_other_roster_drop_does_not_clear_inherited_ownership(self):
        payload, mappings = self.migration()
        imported = migration_events(payload, mappings, [])
        row = self.attribute([*imported, event(70, roster=None, drops={"p": 2})])
        self.assertEqual(row["reason"], "migration")

    def test_bad_franchise_stale_and_duplicate_migration_fail(self):
        payload, mappings = self.migration()
        payload["migration"]["rows"][0]["franchise"] = "other"
        with self.assertRaisesRegex(ValueError, "Invalid ESPN migration"):
            migration_events(payload, mappings, [])
        with self.assertRaisesRegex(ValueError, "Regenerate ESPN"):
            migration_events({}, mappings, [])
        payload, mappings = self.migration()
        payload["migration"]["rows"].append(payload["migration"]["rows"][0])
        with self.assertRaisesRegex(ValueError, "Duplicate migration"):
            migration_events(payload, mappings, [])

    def test_startup_import_does_not_create_new_draft_credit(self):
        draft = {"status": "complete", "draft_id": IMPORT_DRAFT, "last_picked": 50, "start_time": 30}
        def fetch(path):
            if "/transactions/" in path:
                return []
            if path.endswith("/drafts"):
                return [draft]
            return [{"player_id": "p", "roster_id": 1}]
        with patch("get_sleeper_acquisitions.fetch_json", side_effect=fetch):
            events, counts = collect_events({"season": 2022, "leagueId": "l"}, {1})
        self.assertEqual(events, [])
        self.assertEqual(counts, {"import-placeholder": 1})


class MigrationIdentityTests(unittest.TestCase):
    def test_native_id_handles_historical_position_change_and_unique_name_fallback(self):
        picks = [{"player": "hill", "name": "Taysom Hill", "position": "TE"},
                 {"player": "chase", "name": "Ja'Marr Chase", "position": "WR"},
                 {"player": "NE", "name": "New England Patriots", "position": "DEF"}]
        metadata = {"1": {"name": "Taysom Hill", "position": "QB"},
                    "2": {"name": "Ja’Marr Chase", "position": "WR"},
                    "-16017": {"name": "Patriots D/ST", "position": "DEF"}}
        matches = match_players(picks, {"hill": {"espn_id": 1}}, metadata)
        self.assertEqual(matches["hill"], {"espnPlayer": "1", "match": "espn-id"})
        self.assertEqual(matches["chase"], {"espnPlayer": "2", "match": "unique-name-position"})
        self.assertEqual(matches["NE"]["espnPlayer"], "-16017")

    def test_ambiguous_names_and_unmatched_players_are_not_guessed(self):
        picks = [{"player": "p", "name": "Same Name", "position": "WR"}]
        metadata = {"1": {"name": "Same Name", "position": "WR"},
                    "2": {"name": "Same Name", "position": "WR"}}
        self.assertEqual(match_players(picks, {}, metadata)["p"]["match"], "unmatched")
        self.assertEqual(match_players(picks, {}, {})["p"]["match"], "unmatched")
        with self.assertRaisesRegex(ValueError, "Duplicate"):
            match_players(picks * 2, {}, {})

    def test_handoff_uses_completed_draft_over_administrative_pre_draft_add(self):
        events = [{"id": "draft", "kind": "draft", "from": 10, "at": 30},
                  {"id": "pre-draft-add", "kind": "FREEAGENT", "from": 20, "at": 80},
                  {"id": "later-trade", "kind": "TRADE_ACCEPT", "from": 40, "at": 40},
                  {"id": "future", "kind": "FREEAGENT", "from": 100, "at": 120}]
        result = handoff_events(events, 50)
        self.assertEqual([event["at"] for event in result], [30, 20, 40])
        self.assertTrue(all(event["from"] == event["at"] for event in result))


if __name__ == "__main__":
    unittest.main()
