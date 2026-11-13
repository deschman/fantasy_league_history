"""Sanitized trade legs shared by the historical acquisition exporters."""


def trade_record(event, participants, picks=(), issues=()):
    assets = []
    problems = list(issues)
    for player in sorted(set(event["adds"]) | set(event["drops"])):
        sender, receiver = event["drops"].get(player), event["adds"].get(player)
        if sender is None or receiver is None or sender == receiver:
            problems.append(f"Incomplete player movement: {player}")
        else:
            assets.append({"type": "player", "player": player, "from": sender, "to": receiver})
    for pick in picks:
        assets.append({"type": "pick", "season": int(pick["season"]), "round": pick["round"],
                       "originalRoster": pick["roster_id"],
                       "from": pick["previous_owner_id"], "to": pick["owner_id"]})
    involved = set(participants) | {asset[key] for asset in assets for key in ("from", "to")}
    if len(involved) < 2:
        problems.append("Fewer than two trade participants")
    return {"id": event["id"], "season": event["season"], "at": event["at"],
            "participants": sorted(involved), "assets": assets, "issues": problems}


def espn_trade_record(transaction, season):
    items = transaction["items"]
    movements = [item for item in items if item["type"] == "TRADE"]
    event = {"id": transaction["id"], "season": season,
             "at": transaction.get("processDate") or transaction["proposedDate"],
             "adds": {str(item["playerId"]): item["toTeamId"] for item in movements},
             "drops": {str(item["playerId"]): item["fromTeamId"] for item in movements}}
    participants = {item[key] for item in items if item["type"] in ("TRADE", "DRAFT_TRADE")
                    for key in ("fromTeamId", "toTeamId")}
    issues = ["ESPN draft-pick details are unavailable"] if any(
        item["type"] == "DRAFT_TRADE" for item in items) else []
    return trade_record(event, participants, issues=issues)
