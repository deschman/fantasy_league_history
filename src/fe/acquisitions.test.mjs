import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseCSV, buildHistory } from "./history.mjs";
import { buildAnalytics } from "./analytics.mjs";
import { attachAcquisitions as attachSleeper, attachESPN, acquisitionSummary } from "./acquisitions.mjs";
import { renderAcquisitions } from "./acquisition-view.mjs";
import { acquisitionGrade, buildTradeGrades } from "./acquisition-grades.mjs";

const sources = await Promise.all(["espn", "sleeper"].map(async (platform) => {
  const [standings, crosswalk, matchups] = await Promise.all(["standings_all_seasons.csv", "crosswalk.csv", "matchups_all_seasons.csv"]
    .map(async (filename) => parseCSV(await readFile(new URL(`../../data/${platform}/${filename}`, import.meta.url), "utf8"))));
  return { platform, standings, crosswalk, matchups };
}));
const history = buildHistory(sources);
const details = JSON.parse(await readFile(new URL("../../data/sleeper/details.json", import.meta.url), "utf8"));
const payload = JSON.parse(await readFile(new URL("../../data/sleeper/acquisitions.json", import.meta.url), "utf8"));
const analytics = buildAnalytics(history, sources, details);
const espnPayload = JSON.parse(await readFile(new URL("../../data/espn/acquisitions.json", import.meta.url), "utf8"));
const attachAcquisitions = (analytics, sources, payload) => attachSleeper(analytics, sources, payload, espnPayload);
const rows = attachAcquisitions(analytics, sources, payload);
const espnRows = attachESPN(analytics, espnPayload);
const combined = [...rows, ...espnRows];
const tradeGrades = buildTradeGrades(history, sources, combined, payload, espnPayload);
const sum = (groups, field) => groups.reduce((total, group) => total + group[field], 0);

test("real trade assets resolve, grade margins reconcile, and unmade picks use all 40 selections per round", () => {
  assert.equal(tradeGrades.reports.length, 201);
  assert.equal(tradeGrades.averages.length, 5);
  assert.ok(tradeGrades.averages.every((entry) => entry.count === 40));
  assert.ok(tradeGrades.reports.some((report) => report.estimated));
  assert.ok(tradeGrades.reports.some((report) => report.issues.length));
  for (const report of tradeGrades.reports) {
    for (const side of report.sides) {
      assert.equal(side.points, side.assets.reduce((total, asset) => total + (asset.points ?? 0), 0));
      assert.equal(side.grade === null, report.issues.length > 0);
      if (report.sides.length === 2) assert.equal(side.margin, side.points - report.sides.find((other) => other !== side).points);
      for (const asset of side.assets.filter((asset) => asset.estimated)) {
        assert.equal(asset.points, tradeGrades.averages.find((entry) => entry.round === asset.round)?.points ?? 0);
      }
    }
  }
});

test("ESPN-origin trade grades retain the original deal and include cross-era holding returns", () => {
  const allen = rows.find((row) => row.player === "4984" && row.reason === "migration" && row.source === "trade");
  assert.ok(allen);
  const grade = acquisitionGrade(allen, tradeGrades);
  assert.equal(grade.grade, "A-");
  assert.equal(grade.report.platform, "espn");
  assert.equal(grade.report.season, 2020);
  assert.ok(grade.side.points > 100000);
  assert.ok(combined.filter((row) => row.event === allen.event && row.stage === "regular")
    .some((row) => row.platform === "espn"));
  for (const row of rows.filter((row) => row.player === allen.player && row.event === allen.event)) {
    assert.equal(acquisitionGrade(row, tradeGrades).report, grade.report);
  }
});

test("repeat trades for a player remain separate acquisition-grade rows without losing points", () => {
  const first = { ...rows[0], source: "trade", event: "one", acquiredSeason: 2022, points: 100 };
  const second = { ...first, event: "two", points: 200 };
  const group = acquisitionSummary([first, second], [], [first.team])[0];
  assert.equal(group.players.length, 2);
  assert.equal(group.points, 300);
  assert.equal(group.buckets.trade, 300);
});

test("grades and auditable trade reports render in every era and attribution mode", () => {
  for (const era of ["all", "espn", "sleeper"]) {
    for (const mode of ["franchise", "owner"]) {
      const html = renderAcquisitions({ analytics, acquisitions: combined, tradeGrades, rows: history,
        state: { acquisitionSeason: "", acquisitionManager: "", acquisitionScope: "regular" }, era, mode });
      assert.match(html, /<th>Grade<\/th>/);
      assert.match(html, /Trade report cards/);
      assert.match(html, /grade-a">A\+<\/span>/);
      assert.match(html, /grade-a">A<\/span>/);
      assert.match(html, /grade-a">A-<\/span>/);
      assert.match(html, /Grade unavailable/);
      assert.match(html, /Round estimates/);
      assert.match(html, /data-trade-report=/);
      assert.doesNotMatch(html, /NaN|undefined/);
    }
  }
});

test("every starter has matched point-source evidence; only completed seasons are included", () => {
  assert.equal(rows.length, 6225);
  assert.ok(rows.every((row) => row.season >= 2022 && row.season <= 2025));
  assert.ok(rows.some((row) => row.acquiredSeason < row.season));
  assert.ok(rows.some((row) => row.source === "unknown"));
  assert.ok(rows.some((row) => row.source === "trade"));
  assert.ok(rows.some((row) => row.source === "freeAgency"));
  assert.ok(rows.some((row) => row.source === "draft"));
  assert.ok(payload.audit.every((season) => season.queriedLegs[0] === 0 && season.queriedLegs[1] === 22));
});

test("bucket totals and shares reconcile with actual starter points in every scope", () => {
  for (const scope of ["regular", "playoff", "all"]) {
    for (const mode of ["franchise", "owner"]) {
      for (const season of ["", "2022", "2023", "2024", "2025"]) {
        const groups = acquisitionSummary(rows, analytics.games, history, mode, season, scope);
        const eligible = rows.filter((row) => (!season || row.season === Number(season)) &&
          (scope === "all" ? row.stage !== "bye" : row.stage === scope));
        assert.equal(sum(groups, "points"), eligible.reduce((total, row) => total + row.points, 0));
        for (const group of groups) {
          assert.equal(Object.values(group.buckets).reduce((a, b) => a + b, 0), group.points);
          if (group.points) assert.ok(Math.abs(Object.values(group.shares).reduce((a, b) => a + b, 0) - 1) < 1e-10);
          assert.equal(group.points + group.adjustment, group.teamPoints);
          assert.equal(group.players.reduce((total, player) => total + player.points, 0), group.points);
        }
      }
    }
  }
});

test("weekly team reconciliation does not silently substitute roster totals", () => {
  const groups = acquisitionSummary(rows, analytics.games, history);
  assert.equal(sum(groups, "points"), 6133992);
  assert.equal(sum(groups, "teamPoints"), 6133992);
  assert.equal(sum(groups, "adjustment"), 0);
  const ron = groups.find((group) => group.name === "RonnieM20");
  assert.equal(ron.standingPoints - ron.teamPoints, -100);
});

test("team-total overrides and negative contributions remain separate and signed", () => {
  const row = { ...rows[0], points: -100, source: "draft", stage: "regular" };
  const opponent = history.find((team) => team.season === row.season && team !== row.team);
  const game = { ...analytics.games.find((game) => game.platform === "sleeper"),
    season: row.season, home: row.team, away: opponent, homeScore: -50, awayScore: 0 };
  const group = acquisitionSummary([row], [game], [row.team, opponent]).find((group) => group.id === row.team.franchise.id);
  assert.equal(group.buckets.draft, -100);
  assert.equal(group.points, -100);
  assert.equal(group.adjustment, 50);
  assert.equal(group.shares.draft, 1);
});

test("missing, duplicate, stale and future evidence fails explicitly", () => {
  const missing = structuredClone(payload);
  missing.rows.shift();
  assert.throws(() => attachAcquisitions(analytics, sources, missing), /Missing or stale/);
  const duplicate = structuredClone(payload);
  duplicate.rows.push(duplicate.rows[0]);
  assert.throws(() => attachAcquisitions(analytics, sources, duplicate), /Duplicate acquisition/);
  const stale = structuredClone(payload);
  stale.rows[0].points += 1;
  assert.throws(() => attachAcquisitions(analytics, sources, stale), /Missing or stale/);
  const future = structuredClone(payload);
  const known = future.rows.find((row) => row.reason === "verified");
  known.acquiredAt = future.windows[`${known.season}:${known.week}`][1] + 1;
  assert.throws(() => attachAcquisitions(analytics, sources, future), /Invalid acquisition kickoff/);
});

test("Sleeper carries ESPN sources independently of era filters and exposes original evidence", () => {
  const inherited = rows.filter((row) => row.reason === "migration");
  assert.ok(inherited.length > 1000);
  assert.ok(inherited.some((row) => row.season === 2025 && row.acquiredSeason < 2022));
  assert.ok(inherited.every((row) => row.originPlatform === "espn" && row.espnPlayer));
  const allen = rows.filter((row) => row.player === "4984" && row.season === 2025);
  assert.ok(allen.length > 0 && allen.every((row) => row.source === "trade" && row.acquiredSeason === 2020));
  const chase = rows.filter((row) => row.player === "7564" && row.season === 2025);
  assert.ok(chase.length > 0 && chase.every((row) => row.source === "draft" && row.acquiredSeason === 2021));
  for (const era of ["all", "sleeper"]) {
    const groups = acquisitionSummary(combined, analytics.games, history, "franchise", "2025", "regular", era);
    const expected = acquisitionSummary(rows, analytics.games, history, "franchise", "2025");
    assert.deepEqual(groups, expected);
    const html = renderAcquisitions({ analytics, acquisitions: combined, rows: history,
      mode: "franchise", era, state: { acquisitionSeason: "2025" } });
    assert.ok(html.includes("ESPN origin"));
    assert.ok(html.includes("Original ESPN acquisition carried"));
    assert.ok(html.includes("native player ID match") && html.includes("unique name + position match"));
  }
  const groups = acquisitionSummary(rows, analytics.games, history);
  const unknown = groups.reduce((total, group) => total + group.buckets.unknown, 0);
  assert.ok(unknown / sum(groups, "points") < 0.03);
});

test("missing and stale migration evidence cannot silently fall back to startup draft credit", () => {
  assert.throws(() => attachSleeper(analytics, sources, payload), /Unsupported acquisition dataset/);
  const stale = structuredClone(payload);
  const changed = stale.rows.find((row) => row.reason === "migration");
  changed.source = changed.source === "draft" ? "trade" : "draft";
  assert.throws(() => attachAcquisitions(analytics, sources, stale), /stale ESPN migration evidence/);
  const wrongFranchise = structuredClone(payload);
  const inherited = wrongFranchise.rows.find((row) => row.reason === "migration");
  inherited.roster = inherited.roster === 1 ? 2 : 1;
  assert.throws(() => attachAcquisitions(analytics, sources, wrongFranchise), /stale ESPN migration evidence/);
  const absent = structuredClone(espnPayload);
  absent.migration.rows = [];
  assert.throws(() => attachSleeper(analytics, sources, payload, absent), /stale ESPN migration evidence/);
});

test("all modes and filters render source, uncertainty and reconciliation labels", () => {
  for (const mode of ["franchise", "owner"]) {
    for (const scope of ["regular", "playoff", "all"]) {
      const state = { acquisitionSeason: "2025", acquisitionManager: "", acquisitionScope: scope };
      const html = renderAcquisitions({ analytics, acquisitions: rows, rows: history, mode, era: "all", state });
      assert.ok(html.includes("Free agency"));
      assert.ok(html.includes("Unknown"));
      assert.ok(html.includes("actual starter points"));
      assert.ok(html.includes("TEAM ADJUSTMENT"));
      assert.ok(!html.includes("undefined"));
      state.acquisitionManager = acquisitionSummary(rows, analytics.games, history, mode, "2025", scope)[0].id;
      const managerHTML = renderAcquisitions({ analytics, acquisitions: rows, rows: history, mode, era: "sleeper", state });
      assert.equal((managerHTML.match(/<details class="acquisition-card">/g) ?? []).length, 1);
    }
  }
  assert.ok(renderAcquisitions({ analytics, acquisitions: combined, rows: history, mode: "franchise", era: "espn", state: {} })
    .includes("ESPN coverage: 2018–2021 regular season only"));
});

test("ESPN imports every supported regular-season start without expanding existing player leaderboards", () => {
  assert.equal(espnRows.length, 4893);
  assert.ok(espnRows.every((row) => row.platform === "espn" && row.stage === "regular" &&
    row.season >= 2018 && row.season <= 2021 && row.player.startsWith("espn:")));
  assert.equal(analytics.starters.length, rows.length);
  assert.ok(espnRows.some((row) => row.position === "LB"));
  assert.ok(espnRows.some((row) => row.acquiredSeason < row.season));
  assert.equal(espnRows.filter((row) => row.reportedZero).length, 23);
  assert.ok(espnRows.filter((row) => row.reportedZero).every((row) => row.points === 0));
  for (const score of espnPayload.scores) {
    const starts = espnRows.filter((row) => row.season === score.season && row.week === score.week && row.team.team === score.team);
    assert.equal(starts.length, score.starts);
    assert.equal(starts.reduce((total, row) => total + row.points, 0), Math.round(score.starterPoints * 100));
  }
});

test("ESPN keeper provenance reaches the initial draft and ignores missing-detail trades", () => {
  assert.equal(espnPayload.provenanceStart, 2016);
  assert.equal(espnPayload.missingTradePolicy, "ignore");
  assert.deepEqual(espnPayload.historyAudit.map((audit) => audit.season), [2016, 2017]);
  assert.equal(espnPayload.historyAudit[0].counts.draft, 180);
  const ignored = espnPayload.audit.flatMap((audit) => audit.ignoredTrades);
  assert.equal(ignored.length, 3);
  assert.ok(espnRows.every((row) => row.reason !== "opaque" && !ignored.includes(row.event)));
  const retained = espnRows.filter((row) => row.season === 2021 && row.acquiredSeason === 2016);
  assert.ok(retained.length > 0);
  assert.ok(retained.every((row) => row.source === "draft" && row.event.startsWith("draft:2016:")));
  const groups = acquisitionSummary(espnRows, analytics.games, history);
  const unknown = groups.reduce((total, group) => total + group.buckets.unknown, 0);
  assert.equal(unknown, 1205150);
  assert.ok(unknown / sum(groups, "points") < 0.21);
  const stale = structuredClone(espnPayload);
  delete stale.historyAudit;
  assert.throws(() => attachESPN(analytics, stale), /Unsupported ESPN acquisition dataset/);
});

test("combined source totals conserve points and exclude unavailable ESPN years and postseason", () => {
  for (const mode of ["franchise", "owner"]) {
    for (const era of ["all", "espn", "sleeper"]) {
      for (const scope of ["regular", "playoff", "all"]) {
        for (const season of ["", "2018", "2019", "2020", "2021", "2025"]) {
          const groups = acquisitionSummary(combined, analytics.games, history, mode, season, scope, era);
          const eligible = combined.filter((row) => (era === "all" || row.platform === era) &&
            (!season || row.season === Number(season)) && (scope === "all" ? row.stage !== "bye" : row.stage === scope));
          assert.equal(sum(groups, "points"), eligible.reduce((total, row) => total + row.points, 0));
          for (const group of groups) {
            assert.equal(Object.values(group.buckets).reduce((a, b) => a + b, 0), group.points);
            assert.equal(group.points + group.adjustment, group.teamPoints);
            assert.ok(!group.seasons.has(2016) && !group.seasons.has(2017));
          }
        }
      }
    }
  }
  const espn = acquisitionSummary(combined, analytics.games, history, "franchise", "", "regular", "espn");
  assert.equal(sum(espn, "points"), 5812240);
  assert.equal(sum(espn, "teamPoints"), 5812140);
  assert.equal(sum(espn, "adjustment"), -100);
  assert.equal(sum(acquisitionSummary(combined, analytics.games, history), "points"), 11946232);
  assert.equal(sum(acquisitionSummary(combined, analytics.games, history, "franchise", "", "playoff"), "points"),
    sum(acquisitionSummary(rows, analytics.games, history, "franchise", "", "playoff"), "points"));
});

test("ESPN inheritance merges franchises without changing actual-owner totals", () => {
  const inherited = espnRows.find((row) => row.team.owner.id !== row.team.franchise.id);
  assert.ok(inherited);
  const actual = acquisitionSummary(combined, analytics.games, history, "owner", inherited.season, "regular", "espn");
  const franchise = acquisitionSummary(combined, analytics.games, history, "franchise", inherited.season, "regular", "espn");
  assert.equal(sum(actual, "points"), sum(franchise, "points"));
  assert.ok(actual.some((group) => group.id === inherited.team.owner.id));
  assert.ok(franchise.some((group) => group.id === inherited.team.franchise.id));
});

test("ESPN missing, duplicated, stale and future evidence and scores fail visibly", () => {
  const missing = structuredClone(espnPayload);
  missing.rows.splice(missing.rows.findIndex((row) => row.points === 0), 1);
  assert.throws(() => attachESPN(analytics, missing), /Missing or stale ESPN weekly starters/);
  const duplicate = structuredClone(espnPayload);
  duplicate.rows.push(duplicate.rows[0]);
  assert.throws(() => attachESPN(analytics, duplicate), /duplicate ESPN acquisition/);
  const stale = structuredClone(espnPayload);
  stale.rows[0].points += 1;
  assert.throws(() => attachESPN(analytics, stale), /Missing or stale ESPN weekly starters/);
  const future = structuredClone(espnPayload);
  const known = future.rows.find((row) => row.source !== "unknown");
  known.acquiredAt = known.acquiredBefore = future.windows[`${known.season}:${known.week}`][1] + 1;
  assert.throws(() => attachESPN(analytics, future), /kickoff window/);
  const scores = structuredClone(espnPayload);
  scores.scores[0].points += 1;
  assert.throws(() => attachESPN(analytics, scores), /stale ESPN team score/);
  const coverage = structuredClone(espnPayload);
  coverage.audit.pop();
  assert.throws(() => attachESPN(analytics, coverage), /Missing ESPN acquisition seasons/);
});

test("era and game filters show only covered seasons and explicitly disclose ESPN limitations", () => {
  for (const mode of ["franchise", "owner"]) {
    const state = { acquisitionSeason: "2025", acquisitionScope: "playoff", acquisitionManager: "" };
    const html = renderAcquisitions({ analytics, acquisitions: combined, rows: history, mode, era: "espn", state });
    assert.equal(state.acquisitionSeason, "");
    assert.equal(state.acquisitionScope, "regular");
    assert.ok(html.includes("Unknown") && html.includes("keeper origins stay Unknown"));
    assert.ok(!html.includes('<option value="2025"') && !html.includes('<option value="2017"'));
    assert.ok(!html.includes('<option value="playoff"'));
    assert.ok(html.includes("2018–2021") && html.includes("execution interval"));
    assert.ok(html.includes("Trades with missing player details are ignored"));
    assert.ok(html.includes("2016 initial draft"));
    assert.ok(html.includes("best-effort history"));
    assert.ok(!html.includes("invalidates earlier provenance"));
    state.acquisitionSeason = "2018";
    state.acquisitionScope = "playoff";
    const title = renderAcquisitions({ analytics, acquisitions: combined, rows: history, mode, era: "all", state });
    assert.equal(state.acquisitionSeason, "");
    assert.ok(!title.includes('<option value="2018"'));
    state.acquisitionScope = "regular";
    const sleeper = renderAcquisitions({ analytics, acquisitions: combined, rows: history, mode, era: "sleeper", state });
    assert.ok(!sleeper.includes('<option value="2018"'));
    assert.ok(sleeper.includes("61,339.92"));
  }
  assert.throws(() => renderAcquisitions({ analytics, rows: history, mode: "franchise", era: "all", state: {} }), /not loaded/);
});
