# League history

A mobile-first, Sleeper-inspired fantasy football archive combining the ESPN
(2016–2021) and Sleeper (2022–2025) seasons. Uses real exported data, not mocks.

## Run locally

From the project root:

```sh
python3 -m http.server 8000 --bind 127.0.0.1
```

Open <http://127.0.0.1:8000>. HTTP is required for loading CSVs; opening
`index.html` directly from the filesystem will not work.

There are no frontend dependencies, build steps, external fonts, backend, or
live API requests. The page uses native browser JavaScript modules and fetch.

## Views

- **Standings:** all-time wins, win percentage, points for/against, titles,
  finals, podiums, and average final finish. Search by manager or historical team
  name. Expand a manager for title years, finals, best/worst finishes, verified
  Sleeper playoff record, and season results.
- **Champions:** champion, runner-up, and third place for every season.
- **Seasons:** select a season and inspect final playoff standings.
- **Records:** career wins, championships, season points, and season win rate.
- **Rivalries:** two-manager comparison, recent meetings, competitive pairing
  suggestions, and a clickable head-to-head matrix.
- **Highlights:** highest/lowest weekly scores, largest margins, closest
  non-tied finishes, and highest combined scores. Open any listed matchup.
- **Awards:** lighthearted career and weekly superlatives, including all tied
  holders and undefeated head-to-head series with at least four meetings.
- **Player MVPs:** actual starter points, starts, points/start, best week,
  seasons, and managers; filter by position/manager/minimum starts. Choose
  **Rank by → Single-game performances** for the top 50 started-player scores
  (including ties at the cutoff), with manager, season, week, and game type.
  Scope, manager, and position filters apply; minimum starts is hidden and does
  not apply to single-game rankings. Repeated performances by a player are
  separate entries; equal scores share a rank.
- **Drafts:** completed draft picks, rounds, receiving managers, and keeper
  flags, with season, manager, and player-search filters.
- **Roster building:** shares of actual starter points from draft, trade, free
  agency (including waivers), and explicitly unknown acquisitions. Filter by
  season/manager/game scope, expand franchises for player/source totals, and
  inspect each start's acquisition event. Team-total adjustments and standings
  discrepancies are separate from the starter-point denominator.
- **Data coverage:** season coverage, validation checks, and source caveats.
- Filter every view to ESPN, Sleeper, or both. Franchise history is the default;
  switch to actual owners to exclude inherited seasons from the successor.

This is an independent visual interpretation, not a pixel-perfect copy of
Sleeper's app. The layout adapts to mobile and desktop, with native keyboard-
accessible controls. Tabs and wide data tables scroll within their containers.

## Data and identity

The frontend loads `standings_all_seasons.csv`, `matchups_all_seasons.csv`, and `crosswalk.csv` from each
platform's folder under `data/`. Championship placements are derived from
`final_rank` in the same standings, keeping every view consistent. The tests
cross-check those podiums against both `champions.csv` files. Additional Sleeper
bracket, starter, player-name, and draft data is stored in `data/sleeper/details.json`.

The crosswalk key is season + team name (outer whitespace ignored). Its `owner`
is the canonical username, not ESPN's real-name owner field.
`inheriting_owner`, when present, receives that season in franchise mode.
Sleeper usernames link to stable owner IDs; former owners without a Sleeper
mapping retain separate identities. The ESPN Zane username has been corrected
to `ZaneThiry` to match Sleeper. Missing/ambiguous mappings and invalid numbers
produce a visible load error rather than silently dropping data.

Records and points are regular-season totals; titles and average finish use
final playoff results. All-time rankings use wins, then win percentage, then
points for, unless another metric is selected. Scoring rules differ across eras.
The source-specific point discrepancy described in `scripts/README.md` is
preserved. Standings use roster totals; game features use weekly scores with
integer-hundredth arithmetic.

### Historical coverage

- **Regular-season games:** 2016–2025, 660 games. ESPN 2016–2021 weekly records
  and points reconcile exactly with the existing season totals. Sleeper records
  reconcile; the two documented 2023 point discrepancies remain visible.
- **Title-bracket games:** Sleeper 2022–2025, 20 games. Actual bracket winners
  determine records (including official tiebreakers). Byes, third/fifth-place
  games, and consolation games are excluded. Appearances count participating
  bracket rosters, including teams with first-round byes.
- **ESPN playoffs:** unknown. The weekly CSV has no bracket metadata, and
  finish alone does not distinguish wins from byes. Those postseason rows are
  excluded rather than assigned guessed playoff records. Titles/finals/finish
  summaries still use the verified final standings for every season.
- **Starters and drafts:** Sleeper 2022–2025 only, 6,225 starter entries and
  440 draft picks. The API also returns one empty 2022 draft, explicitly labeled.
  Player rankings default to regular-season starts. All-game scope includes
  scored bye weeks; title-bracket scope excludes byes and placement games.
  Individual player scores are not changed by commissioner team-total overrides.
- **No 2026 data** is used. Scoring and league format changes are not normalized.

Rivalry suggestions use a greedy selection: at least four meetings, closest
win balance first, then most meetings; no manager appears twice. The suggestions
are not an exhaustive optimal matching. Historical ownership switches with the
same franchise/actual-owner control used by standings.

To refresh Sleeper data, see [export instructions](scripts/README.md). Exports
replace Sleeper's crosswalk, so preserve any manual overrides separately before
re-running. Changes to CSV data appear on reload; no build is needed.
The separate historical-details exporter never rewrites standings or crosswalks.
If you change the exported season range, regenerate details for those completed
seasons too; missing/stale details produce an explicit load error.

### Acquisition point shares (local preview)

`data/sleeper/acquisitions.json` is generated by
`python3 scripts/get_sleeper_acquisitions.py`. It joins every historical starter
to its latest acquisition by that roster, replaying completed transactions and
drafts chronologically. Sources carry across seasons. Drops clear ownership;
re-signings reset the source to free agency. Trade credit is for a traded
player, not a player selected using a traded draft pick.

The export is limited to the completed seasons already in `details.json`
(currently 2022–2025) and refuses changes in roster/owner continuity without
explicit mapping. All transaction legs 0–22 are queried for each season;
failed/pending transactions are excluded and duplicate IDs deduplicated.
The 240-pick 2022 Sleeper startup draft is administrative roster setup, not
proof that those players were newly drafted. It is excluded from acquisition
events; the genuine 50-pick rookie draft still counts. The exporter never
rewrites crosswalks.

`python3 scripts/get_espn_acquisitions.py` separately generates
`data/espn/acquisitions.json` using the locally saved ESPN credentials. It
exports **2018–2021 regular-season starters**, completed transactions, and
draft evidence. Player-card history fills in trade legs missing from the
league transaction endpoint. Keeper selections retain their prior source
instead of counting as new draft acquisitions; empty draft slots are ignored.
The lookback includes every available prior season to the **2016 initial draft**
(the league's 2015 endpoint returns 404). Drafts and available player-card
history for 2016–2017 contribute provenance only, not scored starts. For example,
a player drafted in 2016 and kept in subsequent seasons retains that original
draft source unless a later recorded trade, drop/re-sign, or non-keeper draft
replaces it. A known move to another roster prevents stale same-roster credit.
Sources carry from ESPN into Sleeper through a separate migration snapshot.
The combined view
supports era, franchise/actual-owner, season, and game filters.

ESPN 2016–2017 and postseason acquisition points are **excluded**, not zero.
Three historical trades still omit player legs even on player cards. Per league
preference, **trades with missing player details are ignored** rather than
invalidating earlier provenance. Their IDs are logged and recorded in the
export audit. The 2016–2017 transaction history is incomplete; carried sources
use the best available evidence and are not a guarantee of exact historical
ownership. Missing origins still remain Unknown.
Records with an execution timestamp use it; otherwise
execution is bounded from proposal until the next scoring week's first kickoff
(next season for late-season records). Overlapping acquisition intervals stay
Unknown rather than assuming proposals executed in submission order.
The exporter verifies weekly team scores against the CSVs and preserves actual
lineup points, including IDP starters and explicit zero scores without stat
rows. The frontend validates per-week starter counts/totals, dataset coverage,
and team scores. ESPN currently contributes 4,893 starts with 58,122.40 starter
points versus 58,121.40 team points; the -1.00 adjustment is shown separately.
These ESPN starts are confined to Roster building, not the Player MVP leaderboard.
The output has no authentication cookies, member records, or transaction messages.

**Migration lookback:** run the ESPN exporter before the Sleeper acquisition
exporter. The ESPN file's `migration` section matches players present in the
2022 import/drafts/starts by native ESPN ID, falling back only to a unique
normalized name and position (including defense names). Stable native IDs
survive historical position changes. Franchises are matched through the
crosswalk, not team names, platform roster numbers, or the startup draft's
placeholder assignments. ESPN player cards include bench and imported players,
so origins do not depend on a player's last scored start.

The handoff is a **best-effort snapshot** of executed ESPN history before
June 2022: completed draft picks use completion time, transactions use execution
time when available and proposal time otherwise. This prevents administrative
pre-draft additions from eclipsing the actual non-keeper draft pick.
Unmatched players or conflicting franchise evidence remain Unknown. Sleeper
replay starts with those original sources and timestamps; later true drafts,
trades, and free-agent/waiver re-signings replace them. Same-franchise
commissioner placements/restorations retain the last source (including an
accidentally dropped player); another franchise's commissioner addition is
Unknown. An unrelated roster's drop never clears the real owner's provenance.
The same ESPN lookback applies to Sleeper-only and All-platform selections;
filters affect scored points, not historical provenance. Expanded evidence
shows the original ESPN event, season, player ID, and match method. The frontend
checks inherited rows against the ESPN snapshot and rejects stale exports.

Historical weekly starters do not include individual kickoff times. Public
ESPN NFL schedule timestamps supply each week's first-to-last kickoff window.
All ownership states in that window are considered; a start is credited only
when the plausible acquisition for its roster is unambiguous. Moves after the
last kickoff cannot rewrite that week's points. Unknown histories, unexplained
commissioner moves, and conflicting/same-time acquisitions stay Unknown.

The denominator is signed net starter points, not bench points or team-total
overrides. All-game scope includes played placement/consolation games but
excludes scored byes. Known/unknown source buckets sum exactly to starter points;
starter points plus the separate adjustment reconcile to weekly team scores.
Regular-season standings discrepancies are shown separately. Negative player
scores are retained; signed percentages may be outside 0–100%, and stacked bars
are omitted for nonpositive totals or negative source buckets.

For review, open the local preview with `?view=acquisitions`. This feature and
the updated deployment allowlist must not be pushed until the preview is approved.

### Acquisition grades

Roster building shows **A** for draft acquisitions, **A+** for free agency
(including waivers), and **N/A** for unknown sources. Trade acquisitions share
the receiving franchise's grade for the entire deal. Repeat trades for the same
player have separate rows; these are acquisition grades, not player talent grades.

Trade return is covered **regular-season starter points** earned by directly
received assets while held, across both eras through the latest exported season
(currently 2025). Drops, genuine re-signings and subsequent trades stop credit;
replacement assets from later trades are not followed. Same-franchise
administrative restorations preserve existing acquisition evidence. Filters
change the displayed starts, never the full-history grade.

Net return subtracts the other team's return; multi-team deals subtract the mean
return of all other teams, rounded to hundredths. The bands are:

| Trade grade | Net starter-point margin |
| --- | --- |
| A- | +100 or more |
| B | Greater than -100 and less than +100 |
| C | -100 through -249.99 |
| D | -250 through -499.99 |
| F | -500 or less |

The measured median absolute trade margin is about 50 points. The 100-point
neutral tolerance on either side avoids overstating modest differences; 250 and 500 distinguish
larger losses and severe outliers. B is centered on even and A- is the ceiling.

Traded picks match by original franchise, year and round, not final draft owner.
Once selected, the pick earns that player's starter points until dropped or
traded. Trading a pick away before selection ends its direct return. Unmade
picks use the mean observed holding return for that round across the 2022–2025
Sleeper rookie drafts: 40 selections per round, including zeros, excluding the
240-pick startup import. Older cohorts have longer scoring histories; these are
transparent historical estimates, not equal-horizon forecasts.

Expandable **Trade report cards** include pick-only and multi-team trades,
per-asset returns, opposing returns, net margins, estimates and missing-detail
warnings. Sleeper-only views retain original ESPN trade grades for inherited
players. ESPN scoring before 2018 and postseason are unavailable; only assigned
regular-season starts count. Incomplete ESPN pick records, unresolved historical
pick ownership and FAAB packages are N/A rather than zero-value assumptions.
The three explicitly ignored missing-detail ESPN trades remain omitted.
All grades are best-effort, to-date returns, not final lifetime verdicts.

## Tests

Requires Node.js 18+:

```sh
node --test src/fe/*.test.mjs
python3 -m unittest discover -s scripts -p 'test_*.py'
```

These tests use the actual CSVs to check identity joins, inheritance, all ten
podiums, sorting, and CSV edge cases. Franchise counts follow the crosswalk
mappings rather than a fixed count; inheritance regression tests verify that
adding a successor preserves actual-owner results and combines franchise totals.
Analytics tests reconcile weekly records, verify title/placement separation,
conserve rivalry and starter totals, check completed-only draft coverage, and
exercise every additional view under era/ownership filters.

## GitHub Pages

The [Pages workflow](.github/workflows/pages.yml) tests the data and deploys
on pushes to `main`, or when manually triggered. Choose **Settings → Pages →
Source → GitHub Actions** once to enable it. Only `index.html`, the allowlisted
frontend runtime files, and `data/` are included in the deployed artifact.
The root `index.html` and relative asset/data paths support project Pages URLs
such as `https://username.github.io/repository/` with no configuration changes.
Do not select `src/fe/` as the deployment root.

**Publishing makes the included CSV data public.** Review the usernames and
historical real names in `data/` before publishing. Do not publish your local
virtual environment or scripts containing private credentials. The included
`.gitignore` excludes `.env` files containing local ESPN authentication cookies.
The ESPN exporter reads them from the project-root `.env` or environment variables;
see [credential setup](scripts/README.md#espn-credentials). Never force-add `.env`. Scripts,
tests, and the virtual environment are not included in the deployed Pages site.
