"""Identity matching for the league's ESPN-to-Sleeper roster import."""

import re
import unicodedata
from collections import defaultdict

IMPORT_DRAFT = "843894119532208128"


def handoff_events(events, cutoff):
    """Best-effort ordering for the completed ESPN roster at migration."""
    result = []
    for event in events:
        timestamp = event["at"] if event["kind"] == "draft" or event["at"] == event["from"] else event["from"]
        if timestamp < cutoff:
            result.append({**event, "at": timestamp, "from": timestamp})
    return result


def identity_key(name, position):
    if position == "DEF":
        name = name.replace(" D/ST", "").split()[-1]
    normalized = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]", "", normalized.lower()), position


def match_players(picks, sleeper_players, espn_players):
    by_name = defaultdict(set)
    for player, info in espn_players.items():
        by_name[identity_key(info["name"], info["position"])].add(str(player))
    result = {}
    seen = set()
    for pick in picks:
        player = pick["player"]
        native = sleeper_players.get(player, {}).get("espn_id")
        if native is not None and str(native) in espn_players:
            match, method = str(native), "espn-id"
        else:
            candidates = by_name[identity_key(pick["name"], pick["position"])]
            match = next(iter(candidates)) if len(candidates) == 1 else None
            method = "unique-name-position" if match else "unmatched"
        if match and match in seen:
            raise ValueError(f"Duplicate ESPN migration player mapping: {match}")
        if match:
            seen.add(match)
        if player in result:
            raise ValueError(f"Duplicate Sleeper import player: {player}")
        result[player] = {"espnPlayer": match, "match": method}
    return result
