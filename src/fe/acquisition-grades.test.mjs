import test from "node:test";
import assert from "node:assert/strict";
import { gradeTradeMargin, buildTradeGrades, acquisitionGrade } from "./acquisition-grades.mjs";

function fixture() {
  const history = [2022, 2023, 2025].flatMap((season) => [1, 2].map((roster) =>
    ({ platform: "sleeper", season, team: `Team ${roster}`,
      franchise: { id: String(roster), name: `Manager ${roster}` },
      owner: { id: String(roster), name: `Manager ${roster}` } })));
  const sources = [{ platform: "sleeper", crosswalk: history.map((team) =>
    ({ season: String(team.season), roster_id: team.franchise.id, team: team.team })) }];
  const sleeper = { trades: [{ id: "t", season: 2022, at: 100, participants: [1, 2], issues: [],
    assets: [{ type: "player", player: "p", from: 2, to: 1 },
      { type: "player", player: "q", from: 1, to: 2 }] }],
    rookieDrafts: [], tradePlayers: { p: "Player P", q: "Player Q", d: "Drafted player" } };
  const espn = { trades: [], tradeTeams: {}, tradePlayers: {} };
  const start = (player, roster, points, extra = {}) => ({ platform: "sleeper", season: 2022,
    stage: "regular", source: "trade", event: "t", acquiredSeason: 2022, player, points,
    name: `Player ${player}`, team: history.find((team) =>
      team.season === 2022 && team.franchise.id === String(roster)), ...extra });
  const rows = [start("p", 1, 15000), start("q", 2, 15000)];
  const build = () => buildTradeGrades(history, sources, rows, sleeper, espn);
  return { history, sources, sleeper, espn, rows, start, build };
}

test("trade grades have an exactly B-centered neutral band and only permitted letters", () => {
  for (const [margin, grade] of [[10000, "A-"], [9999, "B"], [0, "B"], [-9999, "B"],
    [-10000, "C"], [-24999, "C"], [-25000, "D"], [-49999, "D"], [-50000, "F"]]) {
    assert.equal(gradeTradeMargin(margin), grade);
  }
  assert.throws(() => gradeTradeMargin(NaN), /integer hundredths/);
  assert.throws(() => gradeTradeMargin(1.2), /integer hundredths/);
});

test("fixed acquisition grades and unknown sources", () => {
  assert.equal(acquisitionGrade({ source: "draft" }).grade, "A");
  assert.equal(acquisitionGrade({ source: "freeAgency" }).grade, "A+");
  assert.equal(acquisitionGrade({ source: "unknown" }).grade, null);
});

test("trade returns stop at a different acquisition and exclude bench, byes and postseason", () => {
  const f = fixture();
  f.rows.push(f.start("p", 1, 100000, { source: "freeAgency", event: "resign" }),
    f.start("p", 2, 90000, { event: "later" }),
    f.start("p", 1, 20000, { stage: "bye" }), f.start("p", 1, 5000, { stage: "playoff" }));
  const g = f.build();
  assert.deepEqual(g.reports[0].sides.map((side) => [side.points, side.margin, side.grade]),
    [[15000, 0, "B"], [15000, 0, "B"]]);
  assert.equal(acquisitionGrade(f.rows[0], g).grade, "B");
  f.rows[0].points = 45000;
  assert.deepEqual(f.build().reports[0].sides.map((side) => side.grade), ["A-", "D"]);
});

function withDraft(f) {
  f.sleeper.rookieDrafts = [{ id: "draft", season: 2023, at: 200, picks: [
    { player: "d", round: 1, originalRoster: 2, roster: 1 },
    { player: "zero", round: 1, originalRoster: 1, roster: 2 }] }];
  f.rows.push(f.start("d", 1, 18000, { source: "draft", acquiredSeason: 2023, event: "draft" }));
}

test("unmade picks use round means including zero-return selections, not bench scoring", () => {
  const f = fixture();
  withDraft(f);
  f.sleeper.trades[0].assets.push({ type: "pick", season: 2026, round: 1, originalRoster: 2, from: 2, to: 1 });
  const g = f.build();
  assert.deepEqual(g.averages, [{ round: 1, points: 9000, count: 2 }]);
  const asset = g.reports[0].sides[0].assets.at(-1);
  assert.equal(asset.points, 9000);
  assert.equal(asset.estimated, true);
  assert.equal(g.reports[0].estimated, true);
});

test("used picks resolve by original roster and round, not the drafting team's slot", () => {
  const f = fixture();
  withDraft(f);
  f.rows.splice(0, 2);
  f.sleeper.trades[0].assets = [{ type: "pick", season: 2023, round: 1, originalRoster: 2, from: 2, to: 1 }];
  const report = f.build().reports[0];
  assert.equal(report.sides[0].points, 18000);
  assert.equal(report.sides[0].grade, "A-");
  assert.equal(report.sides[1].grade, "C");
  assert.equal(report.sides[0].assets[0].estimated, false);
  assert.match(report.sides[0].assets[0].name, /Player d/);
});

test("trading a pick away stops direct credit without following replacement assets", () => {
  const f = fixture();
  withDraft(f);
  f.rows.splice(0, 2);
  const pick = { type: "pick", season: 2023, round: 1, originalRoster: 2, from: 2, to: 1 };
  f.sleeper.trades[0].assets = [pick];
  f.sleeper.trades.push({ id: "onward", season: 2022, at: 150, participants: [1, 2], issues: [],
    assets: [{ ...pick, from: 1, to: 2 }] });
  f.sleeper.rookieDrafts[0].picks[0].roster = 2;
  const original = f.build().byKey.get("sleeper:2022:t");
  assert.equal(original.sides[0].points, 0);
  assert.match(original.sides[0].assets[0].note, /Traded away/);
  pick.season = 2026;
  f.sleeper.trades[1].assets[0].season = 2026;
  assert.equal(f.build().byKey.get("sleeper:2022:t").sides[0].points, 0);
});

test("incomplete historical trades and unresolved picks are unavailable, not B or zero-return grades", () => {
  const f = fixture();
  f.sleeper.trades[0].issues = ["Missing pick details"];
  assert.ok(f.build().reports[0].sides.every((side) => side.grade === null));
  f.sleeper.trades[0].issues = [];
  f.sleeper.trades[0].assets.push({ type: "pick", season: 2023, round: 1, originalRoster: 2, from: 2, to: 1 });
  assert.ok(f.build().reports[0].sides.every((side) => side.grade === null));
  assert.equal(f.build().reports[0].sides[0].assets.at(-1).points, null);
  assert.match(acquisitionGrade({ ...f.rows[0], event: "missing" }, f.build()).reason, /unavailable/);
});

test("ESPN trade returns include the same franchise's migrated Sleeper starts", () => {
  const f = fixture();
  const old = [1, 2].map((roster) => ({ ...f.history[roster - 1], platform: "espn", season: 2021 }));
  f.history.push(...old);
  f.sources.push({ platform: "espn", crosswalk: old.map((team) =>
    ({ season: "2021", team: team.team })) });
  f.espn.tradeTeams = { 2021: { 7: "Team 1", 8: "Team 2" } };
  f.espn.tradePlayers = { "123": "Imported P", "456": "Other Q" };
  f.espn.trades = [{ id: "old", season: 2021, at: 10, participants: [7, 8], issues: [],
    assets: [{ type: "player", player: "123", from: 8, to: 7 },
      { type: "player", player: "456", from: 7, to: 8 }] }];
  const migrated = f.start("p", 1, 30000, { originPlatform: "espn", espnPlayer: "123", event: "old", acquiredSeason: 2021 });
  f.rows.push(migrated, { ...migrated, platform: "espn", player: "espn:123", espnPlayer: undefined,
    originPlatform: undefined, points: 10000, team: old[0], season: 2021 });
  const grades = f.build();
  const report = grades.byKey.get("espn:2021:old");
  assert.equal(report.sides[0].points, 40000);
  assert.equal(acquisitionGrade(migrated, grades).grade, "A-");
});

test("malformed trade exports fail explicitly", () => {
  const f = fixture();
  f.sleeper.trades.push(f.sleeper.trades[0]);
  assert.throws(f.build, /duplicate trade/);
  f.sleeper.trades.pop();
  delete f.sleeper.tradePlayers;
  assert.throws(f.build, /Regenerate/);
});

test("three-team trades compare each return with the other teams' average", () => {
  const f = fixture();
  const team = { ...f.history[0], team: "Team 3",
    franchise: { id: "3", name: "Manager 3" }, owner: { id: "3", name: "Manager 3" } };
  f.history.push(team);
  f.sources[0].crosswalk.push({ season: "2022", roster_id: "3", team: "Team 3" });
  f.sleeper.tradePlayers.r = "Player R";
  f.sleeper.trades[0].participants.push(3);
  f.sleeper.trades[0].assets.push({ type: "player", player: "r", from: 1, to: 3 });
  f.rows[0].points = 30000;
  f.rows[1].points = 10000;
  assert.deepEqual(f.build().reports[0].sides.map((side) => [side.opponentPoints, side.margin, side.grade]),
    [[5000, 25000, "A-"], [15000, -5000, "B"], [20000, -20000, "C"]]);
});

test("stale trade player/franchise evidence is rejected instead of grading zero returns", () => {
  const f = fixture();
  f.sleeper.tradePlayers.r = "Wrong player";
  f.sleeper.trades[0].assets[0].player = "r";
  assert.throws(f.build, /Stale player\/franchise/);
});
