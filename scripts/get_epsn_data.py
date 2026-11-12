"""
Pull season-by-season history for ESPN fantasy football league 130150 (2015-2021).

Setup (once):
    pip install espn-api pandas

If the league was private, grab two cookies while logged in to fantasy.espn.com:
    Chrome: DevTools (F12) > Application > Cookies > https://fantasy.espn.com
    Copy the values of `espn_s2` and `SWID` (SWID includes the curly braces).
Set ESPN_S2 and SWID in the project-root .env file or environment.
For public leagues, leave both unset. Never commit actual cookie values.

Run:
    python scripts/get_epsn_data.py

Outputs (in the current folder):
    standings_all_seasons.csv   - record, points for/against, final rank per team per season
    champions.csv               - one row per season: champion + runner-up
    matchups_all_seasons.csv    - every weekly matchup with scores
"""
from pathlib import Path

import pandas as pd
from espn_api.football import League

from espn_credentials import load_credentials

LEAGUE_ID = 130150
YEARS = range(2016, 2022)
ESPN_S2, SWID = load_credentials(Path(__file__).resolve().parents[1] / ".env")

def owner_name(team):
    owners = getattr(team, "owners", None) or []
    if owners and isinstance(owners[0], dict):
        o = owners[0]
        name = f"{o.get('firstName', '')} {o.get('lastName', '')}".strip()
        return name or o.get("displayName", "")
    return str(owners[0]) if owners else ""


standings, matchups, champs = [], [], []

for year in YEARS:
    try:
        league = League(league_id=LEAGUE_ID, year=year, espn_s2=ESPN_S2, swid=SWID)
    except Exception as e:
        print(f"{year}: could not load ({type(e).__name__}: {e})")
        continue

    print(f"{year}: loaded {len(league.teams)} teams")

    for t in league.teams:
        standings.append({
            "season": year,
            "team": t.team_name,
            "owner": owner_name(t),
            "wins": t.wins,
            "losses": t.losses,
            "ties": t.ties,
            "points_for": round(t.points_for, 2),
            "points_against": round(t.points_against, 2),
            "regular_season_rank": getattr(t, "standing", None),
            "final_rank": getattr(t, "final_standing", None),
        })

    by_rank = {getattr(t, "final_standing", None): t for t in league.teams}
    champ, second, third = by_rank.get(1), by_rank.get(2), by_rank.get(3)
    champs.append({
        "season": year,
        "champion": champ.team_name if champ else None,
        "champion_owner": owner_name(champ) if champ else None,
        "runner_up": second.team_name if second else None,
        "runner_up_owner": owner_name(second) if second else None,
        "third_place": third.team_name if third else None,
        "third_place_owner": owner_name(third) if third else None,
    })

    for week in range(1, 19):
        try:
            games = league.scoreboard(week=week)
        except Exception:
            break
        if not games:
            break
        for g in games:
            home = getattr(g, "home_team", None)
            away = getattr(g, "away_team", None)
            matchups.append({
                "season": year,
                "week": week,
                "home_team": getattr(home, "team_name", None),
                "home_score": getattr(g, "home_score", None),
                "away_team": getattr(away, "team_name", None),
                "away_score": getattr(g, "away_score", None),
            })

pd.DataFrame(standings).sort_values(["season", "regular_season_rank"], na_position="last").to_csv("standings_all_seasons.csv", index=False)
pd.DataFrame(champs).to_csv("champions.csv", index=False)
pd.DataFrame(matchups).to_csv("matchups_all_seasons.csv", index=False)
print("Done. Wrote standings_all_seasons.csv, champions.csv, matchups_all_seasons.csv")
