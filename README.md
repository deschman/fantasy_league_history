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
