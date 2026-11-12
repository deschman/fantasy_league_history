import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseCSV, buildHistory, aggregate, sortStandings, seasonPodiums } from "./history.mjs";

async function loadCSV(platform, filename) {
  return parseCSV(await readFile(new URL(`../../data/${platform}/${filename}`, import.meta.url), "utf8"));
}

const sources = await Promise.all(["espn", "sleeper"].map(async (platform) => ({
  platform,
  standings: await loadCSV(platform, "standings_all_seasons.csv"),
  crosswalk: await loadCSV(platform, "crosswalk.csv"),
})));
const history = buildHistory(sources);

test("CSV handles commas, escaped quotes, CRLF, BOM, newlines and empty values", () => {
  assert.deepEqual(parseCSV('\uFEFFname,note,empty\r\n"Team, one","A ""quote""\nmore",\r\n'), [
    { name: "Team, one", note: 'A "quote"\nmore', empty: "" },
  ]);
  assert.throws(() => parseCSV('a,b\n"unfinished,b'), /Unclosed/);
  assert.throws(() => parseCSV("a,b\n1,2,3"), /number of columns/);
  assert.throws(() => parseCSV("a,a\n1,2"), /Duplicate/);
});

test("real data combines all 100 team-seasons from 2016 through 2025", () => {
  assert.equal(history.length, 100);
  assert.deepEqual([...new Set(history.map((row) => row.season))], Array.from({ length: 10 }, (_, i) => 2016 + i));
  assert.equal(history.filter((row) => row.platform === "espn").length, 60);
  assert.equal(history.filter((row) => row.platform === "sleeper").length, 40);
  assert.ok(history.some((row) => row.team === "Slingin' Penix, Kickin' D"));
});

test("Zane is joined across platforms with the corrected crosswalk", () => {
  assert.ok(sources[0].crosswalk.every((row) => row.owner !== "ZaneThirty"));
  const zane = aggregate(history).find((group) => group.name === "ZaneThiry");
  assert.equal(zane.seasons.length, 10);
  assert.equal(zane.titles, 2);
  assert.equal(zane.id, "sleeper:842532544766418944");
});

test("franchise inheritance changes attribution without changing league totals", () => {
  const franchises = aggregate(history, "franchise");
  const owners = aggregate(history, "owner");
  const rossFranchise = franchises.find((group) => group.name === "RossMcCloskey");
  const rossOwner = owners.find((group) => group.name === "RossMcCloskey");
  assert.equal(rossFranchise.seasons.length, 10);
  assert.equal(rossOwner.seasons.length, 6);
  assert.equal(rossFranchise.titles, 1);
  assert.equal(rossOwner.titles, 0);
  assert.equal(owners.find((group) => group.name === "Jordan").titles, 1);
  assert.equal(franchises.find((group) => group.name === "xNioiNx").seasons.length, 10);
  assert.equal(franchises.length, 11);
  assert.equal(owners.length, 13);
  for (const metric of ["wins", "losses", "ties", "pointsFor", "pointsAgainst", "titles"]) {
    const sum = (groups) => groups.reduce((total, row) => total + row[metric], 0);
    assert.ok(Math.abs(sum(franchises) - sum(owners)) < 0.000001, metric);
  }
});

test("all podiums match the champion CSVs across both sources", async () => {
  const podiums = seasonPodiums(history);
  assert.equal(podiums.length, 10);
  assert.equal(podiums[0].season, 2025);
  for (const platform of ["espn", "sleeper"]) {
    for (const champion of await loadCSV(platform, "champions.csv")) {
      const { podium } = podiums.find((entry) => entry.season === Number(champion.season));
      for (const [index, field] of ["champion", "runner_up", "third_place"].entries()) {
        assert.equal(podium[index].team, champion[field].trim(), `${champion.season} ${field}`);
      }
    }
  }
  assert.equal(aggregate(history).reduce((sum, group) => sum + group.titles, 0), 10);
});

test("standings metrics sort correctly without mutating their input", () => {
  const groups = aggregate(history);
  const original = groups.map((group) => group.id);
  for (const metric of ["wins", "winPercentage", "pointsFor", "pointsAgainst", "titles", "podiums", "averageFinish"]) {
    const sorted = sortStandings(groups, metric);
    for (let i = 1; i < sorted.length; i++) {
      assert.ok(metric === "averageFinish" ? sorted[i - 1][metric] <= sorted[i][metric] : sorted[i - 1][metric] >= sorted[i][metric]);
    }
  }
  assert.deepEqual(groups.map((group) => group.id), original);
  assert.throws(() => sortStandings(groups, "bad"), /Unknown/);
});

test("missing and invalid data fail explicitly, not as mock or zero totals", () => {
  const missing = structuredClone(sources);
  missing[0].crosswalk.shift();
  assert.throws(() => buildHistory(missing), /Missing espn crosswalk/);
  const bad = structuredClone(sources);
  bad[0].standings[0].wins = "oops";
  assert.throws(() => buildHistory(bad), /Invalid wins/);
  bad[0].standings[0].wins = "";
  assert.throws(() => buildHistory(bad), /Missing wins/);
  const duplicate = structuredClone(sources);
  duplicate[0].crosswalk.push(duplicate[0].crosswalk[0]);
  assert.throws(() => buildHistory(duplicate), /Duplicate crosswalk/);
});

test("win percentage counts ties as half a win; unknown finishes stay unknown", () => {
  const sample = { ...history[0], wins: 3, losses: 2, ties: 1, finalRank: null };
  const [group] = aggregate([sample]);
  assert.equal(group.winPercentage, 3.5 / 6);
  assert.equal(group.averageFinish, null);
  assert.equal(group.titles, 0);
  assert.equal(group.podiums, 0);
  assert.deepEqual(seasonPodiums([sample])[0].podium, [null, null, null]);
});

test("renamed Sleeper users stay joined by stable owner ID", () => {
  const renamed = structuredClone(sources);
  const mapping = renamed[1].crosswalk.find((row) => row.owner === "ZaneThiry" && row.season === "2025");
  mapping.owner = "NewZaneName";
  const zane = aggregate(buildHistory(renamed)).find((group) => group.name === "NewZaneName");
  assert.equal(zane.seasons.length, 10);
});
