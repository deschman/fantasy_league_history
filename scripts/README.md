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

## Sleeper acquisition sources

```sh
python3 scripts/get_sleeper_acquisitions.py
```

Requires existing `details.json`, `crosswalk.csv`, and a fresh ESPN acquisition
export containing migration evidence (run the ESPN command below first). Writes only
`data/sleeper/acquisitions.json`, atomically after all requests succeed.
Only completed seasons from the details export are fetched; no 2026 season
data is needed. Sources are the latest acquisition by each franchise and carry
across seasons. Drafts credit the receiving roster; waived/free-agent additions
are free agency. Player trades reset the source to trade. Drops clear the source.
Untraceable/unexplained commissioner acquisitions remain unknown, with evidence IDs/times
for traced starts. The file contains no cookie values or transaction messages.

The 240-pick startup draft `843894119532208128` is treated as administrative
import setup, not new draft credit. The separate 50-pick rookie draft remains
a true draft event. ESPN migration evidence seeds each matched franchise's
original source before Sleeper replay; later trades and true drop/re-signings
replace it. Same-franchise commissioner placements/restorations preserve the
last source. Drops from a different roster do not clear that history.

The backend fetches completed transactions on legs 0–22, deduplicates IDs,
and uses completion timestamps (not submission time or transaction leg)
alongside draft completion times. Conflicting duplicate payloads and unsupported
transaction types fail explicitly. All season roster IDs/owner IDs must have
unchanged continuity before cross-season credit is carried.
Individual pick timestamps are absent; when a player also moves during the
draft's start-to-completion window, provenance is unknown until a subsequent
unambiguous acquisition instead of letting draft completion overwrite the move.

Historical NFL kickoff windows are fetched from ESPN's public scoreboard
endpoint (`site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard`).
Individual historical player kickoff times are not available in our starter
export. If a drop/reacquisition leaves multiple possible sources for the same
roster during a kickoff window, the points stay unknown rather than being
assigned using an arbitrary weekly cutoff. Transactions after the last kickoff
are never applied to that week's points.

The frontend validates every exported row against starter points and displays
per-source percentages plus team-total reconciliation. Regenerate this file
whenever historical details are refreshed; stale or missing rows fail visibly.

Offline regression tests:

```sh
python3 -m unittest discover -s scripts -p 'test_sleeper_acquisitions.py'
```

## ESPN acquisition sources

```sh
python3 scripts/get_espn_acquisitions.py
```

Uses the ESPN credentials described above and existing ESPN standings,
crosswalk, and matchup CSVs. Writes only `data/espn/acquisitions.json`, atomically
after validation succeeds. No additional packages are required.

Coverage is **2018–2021 regular seasons**. The exporter fetches every historical
regular-season lineup, including defensive players, and verifies weekly team
scores against the CSVs. Actual starter points and separate team adjustments
are retained. Zero-point starts without an actual stat row are explicitly
flagged, not estimated from projections.

The league's `mTransactions2` responses and `kona_playercard` history supply
executed additions, drops, waivers, and player trades. Player cards recover
many trade legs hidden on the league feed. Per league preference, trades with
no recoverable player legs are ignored; warnings and per-season `ignoredTrades`
IDs in the output audit make this approximation explicit. Lineup moves and
traded draft picks do not count as player acquisitions.
Keepers are retention, not new draft picks. Every prior season back to the
2016 initial draft is searched for the latest non-keeper acquisition. The
2016–2017 drafts/player-card history contribute provenance only; `historyAudit`
records that lookback separately from scored-season `audit`. The 2015 endpoint
is unavailable. Early transaction records are incomplete, so inherited
assignments are best-effort; unmatched keeper origins still remain Unknown.
Sources can carry
across ESPN seasons only while the crosswalk verifies franchise continuity.
The `migration` section supplies origins for Sleeper's 2022 import/draft/start
players, using native ESPN IDs or unique normalized names and positions.
Franchise joins use the crosswalk, not placeholder startup-draft assignments.
Player-card coverage includes imported/bench players, not only historical starts.
The snapshot orders completed drafts by completion time and executed
transactions by execution time, or proposal time when absent. This is a
best-effort migration rule, distinct from conservative per-week ESPN attribution.
After refreshing this file, rerun the Sleeper acquisition exporter; its output
is validated against the ESPN snapshot at load time. Selecting only Sleeper
in the UI still retains the ESPN lookback.

Execution timestamps are used when supplied. Otherwise the conservative
proposal-to-next-scoring-week interval is considered (next season for
late-season records). Overlapping intervals are not arbitrarily ordered.
ESPN 2016–2017 transaction coverage and postseason acquisition points are
unavailable in this export and excluded from the view's denominator.

For repeat exports, optionally supply `--cache-dir /path/to/private-cache`
**outside the workspace/static preview**. The cache contains raw league/player
responses and is not a publishing artifact. The generated acquisition JSON
contains only player/scoring/acquisition evidence, no cookies or member records.
This exporter never rewrites the CSVs or crosswalk.

```sh
python3 -m unittest discover -s scripts -p 'test_espn_acquisitions.py'
```

## Trade-grade inputs

Run the same exporters in order; no separate grading download is required:

```sh
python3 scripts/get_espn_acquisitions.py
python3 scripts/get_sleeper_acquisitions.py
```

Both acquisition JSON files now include sanitized `trades` and `tradePlayers`.
A trade retains its event ID, season/time, participant roster IDs, directed
player/pick assets and explicit completeness issues. Sleeper pick-only deals
are retained even when `adds` and `drops` are empty. Multi-team deals are
supported. ESPN's incidental roster cuts are not exchanged trade assets;
`DRAFT_TRADE` records lack enough pick-year/round detail for reliable resolution
and make that deal's grade unavailable. The previously ignored three trades
without player details remain ignored.

ESPN includes `tradeTeams` to join native team IDs to crosswalk franchises.
Sleeper additionally includes `rookieDrafts`, excluding the startup placeholder,
with completed draft times and picks keyed by season, round and original roster.
The original roster is recovered from `draft_order` plus crosswalk owner IDs,
not the pick's receiving roster. `tradePlayers` retains names for exchanged
players and rookie selections, including those that never started.

The browser computes grades from these assets and the validated starter
acquisition evidence, in integer hundredths. It uses full covered regular-season
holding returns, regardless of UI filters, and carries ESPN returns into
Sleeper. Future picks use mean round returns across completed Sleeper rookie
drafts, including zero-return players; a pick traded away before selection
gets no replacement-asset credit. Missing inputs fail explicitly rather than
silently substituting neutral grades. See the project README for grade bands
and coverage limitations. No current-season data is requested.

```sh
python3 -m unittest discover -s scripts -p 'test_trade_assets.py'
node --test src/fe/acquisition*.test.mjs
```
