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
  podiums, and average final finish. Search by manager or historical team name.
  Expand a manager to see their season-by-season results.
- **Champions:** champion, runner-up, and third place for every season.
- **Seasons:** select a season and inspect final playoff standings.
- **Records:** career wins, championships, season points, and season win rate.
- Filter every view to ESPN, Sleeper, or both. Franchise history is the default;
  switch to actual owners to exclude inherited seasons from the successor.

This is an independent visual interpretation, not a pixel-perfect copy of
Sleeper's app. The layout adapts to mobile and desktop, with native keyboard-
accessible controls. Wide season tables scroll within their container.

## Data and identity

The frontend loads `standings_all_seasons.csv` and `crosswalk.csv` from each
platform's folder under `data/`. Championship placements are derived from
`final_rank` in the same standings, keeping every view consistent. The tests
cross-check those podiums against both `champions.csv` files.

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
preserved. The app does not load weekly matchup data yet.

To refresh Sleeper data, see [export instructions](scripts/README.md). Exports
replace Sleeper's crosswalk, so preserve any manual overrides separately before
re-running. Changes to CSV data appear on reload; no build is needed.

## Tests

Requires Node.js 18+:

```sh
node --test src/fe/history.test.mjs
```

These tests use the actual CSVs to check identity joins, inheritance, all ten
podiums, sorting, and CSV edge cases.

## GitHub Pages

The [Pages workflow](.github/workflows/pages.yml) tests the data and deploys
on pushes to `main`, or when manually triggered. Choose **Settings → Pages →
Source → GitHub Actions** once to enable it. Only `index.html`, the three
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
