import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseCSV, buildHistory, aggregate } from "./history.mjs";
import { buildAnalytics, selectGames, rivalries, suggestedRivalries, highlightGames, playerMVPs, playoffResume } from "./analytics.mjs";
import { renderFeature } from "./features.mjs";

const sources = await Promise.all(["espn", "sleeper"].map(async (platform) => {
  const [standings, crosswalk, matchups] = await Promise.all(["standings_all_seasons.csv", "crosswalk.csv", "matchups_all_seasons.csv"]
    .map(async (filename) => parseCSV(await readFile(new URL(`../../data/${platform}/${filename}`, import.meta.url), "utf8"))));
  return { platform, standings, crosswalk, matchups };
}));
const history = buildHistory(sources);
const details = JSON.parse(await readFile(new URL("../../data/sleeper/details.json", import.meta.url), "utf8"));
const analytics = buildAnalytics(history, sources, details);

test("completed-season weekly records reconcile; early ESPN data is usable", () => {
  assert.equal(analytics.coverage.length, 10);
  assert.equal(selectGames(analytics.games).length, 660);
  assert.equal(analytics.games.length, 704);
  assert.ok(analytics.games.every((game) => game.season <= 2025));
  for (const row of analytics.coverage) {
    assert.equal(row.regularGames, row.regularWeeks * 5);
    if (row.platform === "espn") {
      assert.equal(row.notes.length, 0);
      assert.equal(row.excluded, 16);
    }
  }
  const differences = analytics.coverage.flatMap((row) => row.notes);
  assert.equal(differences.length, 2);
  assert.ok(differences.some((note) => note.includes("1602.20")));
  assert.ok(differences.some((note) => note.includes("1456.42")));
});

test("title-bracket wins exclude byes, third-place, fifth-place, and consolation games", () => {
  const titleGames = selectGames(analytics.games, "sleeper", "playoff");
  assert.equal(titleGames.length, 20);
  assert.equal(selectGames(analytics.games, "sleeper", "placement").length, 24);
  for (const meta of details.seasons) {
    const seasonGames = titleGames.filter((game) => game.season === meta.season);
    assert.equal(seasonGames.length, 5);
    assert.equal(new Set(seasonGames.flatMap((game) => [game.home, game.away])).size, 6);
    const champion = history.find((row) => row.season === meta.season && row.finalRank === 1);
    const championWins = seasonGames.filter((game) => game.winner === champion).length;
    assert.equal(championWins, champion.regularRank <= 2 ? 2 : 3);
    assert.equal(seasonGames.find((game) => game.week === meta.lastWeek).winner, champion);
  }
  const manager = history.find((row) => row.owner.name === "deschman").owner;
  const resume = playoffResume(manager.id, analytics.coverage, analytics.games);
  assert.ok(resume.appearances > 0);
  assert.equal(resume.wins, titleGames.filter((game) => game.winner.franchise.id === manager.id).length);
});

test("rivalry aggregation conserves games and scores under both identity modes", () => {
  const games = selectGames(analytics.games);
  for (const mode of ["franchise", "owner"]) {
    const pairs = rivalries(games, mode);
    assert.equal(pairs.reduce((sum, pair) => sum + pair.games.length, 0), games.length);
    assert.equal(pairs.reduce((sum, pair) => sum + pair.aPoints + pair.bPoints, 0),
      games.reduce((sum, game) => sum + game.total, 0));
    for (const pair of pairs) assert.equal(pair.aWins + pair.bWins + pair.ties, pair.games.length);
    const recommended = suggestedRivalries(pairs);
    const managers = recommended.flatMap((pair) => [pair.a.id, pair.b.id]);
    assert.equal(new Set(managers).size, managers.length);
    assert.ok(recommended.every((pair) => pair.games.length >= 4));
  }
});

test("highlights use exact hundredths, preserve ties, and distinguish both scoring teams", () => {
  const games = selectGames(analytics.games);
  const closest = highlightGames(games, "close")[0];
  assert.equal(closest.score, 10);
  assert.equal(closest.game.season, 2023);
  assert.equal(closest.game.week, 7);
  assert.equal(highlightGames(games, "score").length, games.length * 2);
  assert.ok(highlightGames(games, "low")[0].score >= 0);
  for (const category of ["score", "low", "close", "total", "blowout"]) {
    const entries = highlightGames(games, category);
    assert.ok(entries.every((entry) => Number.isInteger(entry.score)));
  }
  const tied = { ...games[0], homeScore: 10000, awayScore: 10000, margin: 0, total: 20000, winner: null };
  assert.equal(highlightGames([tied], "close").length, 0);
  assert.equal(rivalries([tied])[0].ties, 1);
});

test("starter MVPs conserve player scores, count real starts, and support manager/position/rate filters", () => {
  assert.equal(analytics.starters.length, 6225);
  const starters = analytics.starters.filter((entry) => entry.stage === "regular");
  const players = playerMVPs(starters);
  assert.equal(players.reduce((sum, player) => sum + player.starts, 0), starters.length);
  assert.equal(players.reduce((sum, player) => sum + player.points, 0), starters.reduce((sum, entry) => sum + entry.points, 0));
  assert.equal(players[0].name, "Josh Allen");
  assert.equal(players[0].points, 110502);
  assert.equal(players[0].starts, 48);
  const manager = starters[0].team.franchise.id;
  const filtered = playerMVPs(starters, "franchise", manager, "QB", 10, "average");
  assert.ok(filtered.length > 0);
  assert.ok(filtered.every((player) => player.position === "QB" && player.starts >= 10 && player.managers.length === 1));
  for (let i = 1; i < filtered.length; i++) assert.ok(filtered[i - 1].average >= filtered[i].average);
  assert.ok(analytics.starters.some((entry) => entry.stage === "bye"));
});

test("draft history contains 440 actual picks and retains the explicitly empty draft", () => {
  assert.equal(analytics.drafts.reduce((sum, draft) => sum + draft.picks.length, 0), 440);
  assert.equal(analytics.drafts.filter((draft) => !draft.picks.length).length, 1);
  assert.equal(analytics.drafts.filter((draft) => draft.season === 2022).reduce((sum, draft) => sum + draft.picks.length, 0), 290);
  assert.ok(analytics.drafts.every((draft) => draft.season <= 2025));
  const pick = analytics.drafts.find((draft) => draft.season === 2025).picks.find((pick) => pick.pick === 1);
  assert.equal(pick.name, "Ashton Jeanty");
  assert.equal(pick.team.owner.name, "RossMcCloskey");
});

test("championship resumes include all title years, finals, and finish extrema", () => {
  const caleb = aggregate(history).find((group) => group.name === "Cfenn33");
  assert.deepEqual(caleb.titleYears, [2016, 2020, 2023, 2024]);
  assert.equal(caleb.finals, 5);
  assert.equal(caleb.bestFinish, 1);
  assert.equal(caleb.worstFinish, 6);
});

test("malformed scores, duplicate games, missing games, and stale details fail visibly", () => {
  const duplicate = structuredClone(sources);
  duplicate[0].matchups.push(duplicate[0].matchups[0]);
  assert.throws(() => buildAnalytics(history, duplicate, details), /Duplicate matchup/);
  const missing = structuredClone(sources);
  missing[0].matchups.shift();
  assert.throws(() => buildAnalytics(history, missing, details), /do not reconcile/);
  const invalid = structuredClone(sources);
  invalid[0].matchups[0].home_score = "";
  assert.throws(() => buildAnalytics(history, invalid, details), /invalid weekly score/);
  const stale = structuredClone(details);
  stale.seasons.shift();
  assert.throws(() => buildAnalytics(history, sources, stale), /Missing Sleeper details/);
  const missingStarters = structuredClone(details);
  missingStarters.seasons[0].starters = [];
  assert.throws(() => buildAnalytics(history, sources, missingStarters), /Missing starter or draft/);
});

test("all feature views render for both eras and attribution modes without mutating data", () => {
  const before = JSON.stringify(analytics.drafts);
  for (const era of ["all", "espn", "sleeper"]) {
    for (const mode of ["franchise", "owner"]) {
      const state = { scope: "regular", category: "score", rivalA: "", rivalB: "", game: "",
        playerManager: "", position: "", minStarts: "1", playerSort: "points", draftSeason: "", draftManager: "", draftQuery: "" };
      for (const view of ["rivalries", "highlights", "awards", "players", "drafts", "audit"]) {
        const html = renderFeature(view, { rows: history.filter((row) => era === "all" || row.platform === era), analytics, state, era, mode });
        assert.ok(html.includes('id="view-title"'), `${era}:${mode}:${view}`);
        assert.ok(!html.includes("undefined"), `${era}:${mode}:${view}`);
      }
    }
  }
  assert.equal(JSON.stringify(analytics.drafts), before);
});
