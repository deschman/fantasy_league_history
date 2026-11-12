# Sleeper history export

Requires Python 3.9+; no packages, API key, or login are needed.

From the project root:

```sh
python3 scripts/get_sleeper_data.py
```

The default league is `1309648546055610368`. The script follows
`previous_league_id` back to the earliest linked season and exports completed
seasons only (currently 2022–2025). Files are written to `data/sleeper/`,
regardless of your working directory. Re-running replaces these generated files.
Do not manually edit the generated Sleeper crosswalk if you need to preserve edits.
The existing ESPN files are never modified.

```sh
python3 scripts/get_sleeper_data.py --league-id 1309648546055610368
python3 scripts/get_sleeper_data.py --include-current
python3 scripts/get_sleeper_data.py --output-dir /path/to/exports
```

## Outputs

- `standings_all_seasons.csv`: same columns as the ESPN export, including
  regular-season records and points for/against from Sleeper roster totals.
- `champions.csv`: same columns as ESPN; champion, runner-up, and third place
  come from completed playoff placement matches, not regular-season standings.
- `matchups_all_seasons.csv`: same columns as ESPN; regular-season, playoff,
  and consolation matchups through `last_scored_leg`. Commissioner score
  overrides are honored, including an override of zero. Unpaired byes are
  omitted. Sleeper does not define home/away; lower roster ID is labeled home.
- `crosswalk.csv`: the ESPN crosswalk columns plus `league_id`, `roster_id`,
  and `owner_id`. `owner` is Sleeper's display name/username, not a real name.
  `inheriting_owner` is intentionally blank; franchise inheritance is a manual
  decision. Use this file to join ESPN's manually mapped usernames to Sleeper
  user IDs. Roster IDs are only meaningful within a league.

## Interpretation and limitations

- Regular-season rank is calculated by winning percentage (ties count as half
  a win), then points for. Exact record/points ties share a rank. Division and
  custom-seeding leagues are rejected rather than assigned misleading ranks.
- Final ranks come only from explicit bracket placement matches. Standard
  consolation placements are offset by the number of playoff teams. Unresolved
  placements and non-standard consolation formats are warned about and left
  blank, not replaced with regular-season ranks.
- `--include-current` adds in-progress standings and completed weeks only.
  Final ranks remain blank and no champions row is added for that season.
- Weekly CSVs contain actual head-to-head games only. If a league uses
  median-score wins, those are included in Sleeper's roster record but are not
  fabricated as additional opponents.
- Names are the names Sleeper currently returns for each season, not necessarily
  names used in every historical week. Stable owner IDs in the crosswalk help
  reconcile renames. Co-owners are not treated as separate teams.
- Sleeper's stored roster totals can differ from sums of weekly scores. The
  exporter preserves each endpoint's values rather than silently reconciling
  them. In the initial export, 2023's `RIP Takitae ` has 1601.20 roster points
  for versus 1602.20 from weekly games; `Salute the Sun` has 1455.42 roster
  points against versus 1456.42 from weekly games. All regular-season
  win/loss/tie records reconcile. Choose one consistent points source when
  building aggregate statistics.
- Requests have timeouts and bounded retries for transient errors. Failed
  downloads stop the export before any CSV is written. Each CSV is replaced
  atomically after all seasons have been collected; the four-file set is not
  a single filesystem transaction.

API reference: <https://docs.sleeper.com/>

Run the offline regression tests:

```sh
python3 -m unittest discover -s scripts -p 'test_get_sleeper_data.py'
```

## ESPN credentials

The legacy exporter (`get_epsn_data.py`, original filename preserved) reads
`ESPN_S2` and `SWID` from the project-root `.env` file. Existing process
environment variables take precedence. No dotenv package is required.

For a new checkout, copy `.env.example` to `.env` and fill in both cookies
for private ESPN leagues. Leave both empty for public access. Values may be
unquoted or single/double quoted; use one `KEY=value` entry per line.
The loader never executes shell substitutions.

The local `.env` is ignored by Git and excluded from the Pages deployment.
Keep a secure personal backup if needed, and never force-add it. If cookies
were ever pushed or shared, revoke/rotate them even after cleaning history.
Removing a secret from a current file does not remove existing Git copies.

Run the credential loader tests without contacting ESPN:

```sh
python3 -m unittest discover -s scripts -p 'test_espn_credentials.py'
```

## Completed Sleeper season details

```sh
python3 scripts/get_sleeper_details.py
```

This separate, standard-library-only exporter writes `data/sleeper/details.json`
for 2022–2025. It starts at the latest completed league
`1179896124247248896`; it never requests 2026. Override `--league-id` or
`--data-dir` as needed. Non-completed leagues are skipped by the command and
rejected by the season exporter.

Existing standings/crosswalks supply roster IDs and are never modified.
The JSON contains regular-season boundaries, explicit title-bracket winners,
playoff participant rosters, weekly starter IDs/points (including scored bye
weeks), a reduced player-name/position index, and all historical draft picks.
The full Sleeper player index is fetched once but only started-player metadata
is retained. Draft names/positions come from pick metadata.

Only games on the path to the title are marked as title-bracket games:
third/fifth-place and consolation games are not playoff wins. Multi-week
playoff formats and median-win leagues require additional handling and are
rejected instead of guessed. Byes are not wins.

Sleeper returns three completed 2022 draft records: 50 picks, 240 picks, and an
empty draft. The empty one is retained and warned about rather than silently
discarded. A missing starter score, unresolved title result, unknown roster,
missing player metadata, or failed request prevents replacing the output.

This exporter does not add ESPN draft or starter data. All downloaded detail
seasons must already exist in the frontend's standings and crosswalks.
