import { parseCSV, buildHistory, aggregate, sortStandings, seasonPodiums } from "./history.mjs";
import { buildAnalytics, playoffResume } from "./analytics.mjs";
import { renderFeature } from "./features.mjs";
import { attachAcquisitions, attachESPN } from "./acquisitions.mjs";
import { renderAcquisitions } from "./acquisition-view.mjs";
import { buildTradeGrades } from "./acquisition-grades.mjs";
import { escapeHTML, number, percent, record, ordinal, sectionHeading } from "./ui.mjs";

const $ = (selector) => document.querySelector(selector);
const state = { view: new URLSearchParams(location.search).get("view") === "acquisitions" ? "acquisitions" : "standings",
  era: "all", mode: "franchise", metric: "wins", search: "", season: null,
  scope: "regular", category: "score", rivalA: "", rivalB: "", game: "", playerManager: "", position: "",
  minStarts: "1", playerSort: "points", draftSeason: "", draftManager: "", draftQuery: "",
  acquisitionSeason: "", acquisitionManager: "", acquisitionScope: "regular" };
let history = [];
let analytics;
let acquisitions;
let tradeGrades;

function avatar(name, large = false) {
  let hash = 0;
  for (const character of name) hash = (hash * 31 + character.charCodeAt(0)) | 0;
  const hue = Math.abs(hash) % 360;
  return `<span aria-hidden="true" class="avatar ${large ? "large" : ""}" style="--hue:${hue}">${escapeHTML(name.slice(0, 2).toUpperCase())}</span>`;
}

function platformTag(platform) {
  return `<span class="platform ${platform}">${platform === "espn" ? "ESPN" : "SLEEPER"}</span>`;
}

function renderOverview(rows) {
  const seasons = [...new Set(rows.map((row) => row.season))].sort();
  const groups = aggregate(rows, state.mode);
  const titles = rows.filter((row) => row.finalRank === 1).length;
  $("#overview").innerHTML = [
    ["SEASONS", seasons.length, `${seasons[0]} — ${seasons.at(-1)}`],
    [state.mode === "franchise" ? "FRANCHISES" : "OWNERS", groups.length,
      state.era === "all" ? "Across both eras" : `${state.era === "espn" ? "ESPN" : "Sleeper"} era`],
    ["CHAMPIONS CROWNED", titles, "The ultimate bragging right"],
  ].map(([label, value, note]) => `<div class="overview-stat"><span class="eyebrow">${label}</span><strong>${value}</strong><span>${note}</span></div>`).join("");
}

function seasonTable(rows, showSeason = true) {
  return `<div class="table-scroll"><table class="season-table"><caption class="sr-only">Season results</caption><thead><tr>
    <th>${showSeason ? "Season" : "Finish"}</th><th>Team</th><th>Record</th><th>PF</th><th>PA</th><th>${showSeason ? "Finish" : "Reg. rank"}</th>
    </tr></thead><tbody>${rows.map((row) => `<tr><td>${showSeason ? row.season : ordinal(row.finalRank)}</td>
    <td><strong>${escapeHTML(row.team)}</strong><small>${escapeHTML(row[state.mode].name)}${state.mode === "franchise" && row.owner.id !== row.franchise.id ? ` · Played by ${escapeHTML(row.owner.name)}` : ""}</small></td>
    <td>${record(row)}</td><td>${number(row.pointsFor, 2)}</td><td>${number(row.pointsAgainst, 2)}</td>
    <td>${ordinal(showSeason ? row.finalRank : row.regularRank)}</td></tr>`).join("")}</tbody></table></div>`;
}

function renderStandings(rows) {
  const groups = sortStandings(aggregate(rows, state.mode), state.metric);
  const filtered = groups.filter((group) => `${group.name} ${group.seasons.map((row) => row.team).join(" ")}`.toLowerCase().includes(state.search.toLowerCase()));
  const labels = { wins: "Wins", winPercentage: "Win %", pointsFor: "Points for", pointsAgainst: "Points against",
    titles: "Titles", finals: "Finals", podiums: "Podiums", averageFinish: "Avg. finish" };
  const metricValue = (group) => state.metric === "winPercentage" ? percent(group.winPercentage) :
    state.metric === "averageFinish" ? (group.averageFinish === null ? "—" : number(group.averageFinish, 1)) :
      number(group[state.metric], ["pointsFor", "pointsAgainst"].includes(state.metric) ? 2 : 0);
  const maxWins = Math.max(...groups.map((group) => group.wins), 1);
  return sectionHeading("THE LONG GAME", "All-time standings", "A decade of receipts. Tap a manager to explore their seasons.") +
    `<div class="standings-controls"><label class="search-label"><span class="sr-only">Search managers or teams</span>
      <input id="search" type="search" placeholder="Search managers or teams" value="${escapeHTML(state.search)}"></label>
      <label class="sort-label">Rank by <select id="metric">${Object.entries(labels).map(([key, label]) => `<option value="${key}" ${state.metric === key ? "selected" : ""}>${label}</option>`).join("")}</select></label></div>
    <div class="list-heading"><span>RANK / MANAGER</span><span>${labels[state.metric].toUpperCase()}</span></div>
    <div class="standings-list">${filtered.length ? filtered.map((group) => {
      const rank = groups.findIndex((entry) => entry.id === group.id) + 1;
      const playoff = playoffResume(group.id, analytics.coverage, analytics.games.filter((game) =>
        state.era === "all" || game.platform === state.era), state.mode);
      const playoffAvailable = state.era !== "espn" && group.seasons.some((row) => row.platform === "sleeper");
      return `<details class="manager"><summary><span class="rank ${rank <= 3 ? "top-rank" : ""}">${String(rank).padStart(2, "0")}</span>
      ${avatar(group.name)}<span class="manager-info"><strong>${escapeHTML(group.name)} ${group.titles ? `<span class="title-count" aria-label="${group.titles} championships">♛ ${group.titles}</span>` : ""}</strong>
      <small>${record(group)} <span>·</span> ${group.seasons.length} seasons <span>·</span> ${percent(group.winPercentage)}</small>
      <span class="win-track" aria-hidden="true"><span style="width:${group.wins / maxWins * 100}%"></span></span></span>
      <span class="primary-stat">${metricValue(group)}<small>${labels[state.metric]}</small></span><span class="expand-icon" aria-hidden="true">+</span></summary>
      <div class="manager-detail"><div class="detail-stats"><span>POINTS FOR<strong>${number(group.pointsFor, 2)}</strong></span>
      <span>POINTS AGAINST<strong>${number(group.pointsAgainst, 2)}</strong></span><span>PODIUMS<strong>${group.podiums}</strong></span>
      <span>AVG. FINISH<strong>${group.averageFinish === null ? "—" : number(group.averageFinish, 1)}</strong></span></div>
      <div class="resume"><h3>Championship résumé</h3><p>Title years: ${group.titleYears.join(", ") || "None"} · Finals: ${group.finals}</p>
      <p>Best finish: ${ordinal(group.bestFinish)} · Worst finish: ${ordinal(group.worstFinish)}</p>
      <p>Verified title-bracket record (Sleeper 2022–2025 only): ${playoffAvailable ? `${playoff.wins}–${playoff.losses}` : "Unavailable"} ·
      Appearances: ${playoffAvailable ? playoff.appearances : "Unavailable"}</p><p class="section-footnote">ESPN playoff wins and appearances are unknown; final placements and finals above include both platforms. No byes or placement wins counted.</p></div>
      ${seasonTable(group.seasons)}</div></details>`;
    }).join("") : `<p class="empty">No managers or teams match “${escapeHTML(state.search)}”.</p>`}</div>
    <p class="section-footnote">Regular-season records · ${state.mode === "franchise" ? "Inherited history included" : "Actual owners only"} · ${filtered.length} managers</p>`;
}

function renderChampions(rows) {
  const seasons = seasonPodiums(rows);
  return sectionHeading("IMMORTALIZED", "The champions club", "One trophy. A whole year of reminding everyone.") +
    `<div class="champions-grid">${seasons.map(({ season, platform, podium }) => {
      const champion = podium[0];
      return `<article class="champion-card"><div class="card-top"><span class="season-year">${season}</span>${platformTag(platform)}</div>
        <div class="champion-content"><span class="trophy" aria-hidden="true">♛</span><span class="eyebrow gold">LEAGUE CHAMPION</span>
        <h3>${champion ? escapeHTML(champion[state.mode].name) : "Not yet crowned"}</h3>
        <p>${champion ? escapeHTML(champion.team) : "Final placement not available"}</p>
        ${champion ? `<span class="champion-record">${record(champion)} REGULAR SEASON</span>` : ""}</div>
        <div class="podium">${[1, 2].map((index) => `<div><span class="place">${index + 1}</span><span><small>${index === 1 ? "RUNNER-UP" : "THIRD PLACE"}</small><strong>${podium[index] ? escapeHTML(podium[index][state.mode].name) : "Not available"}</strong></span></div>`).join("")}</div></article>`;
    }).join("")}</div>`;
}

function renderSeasons(rows) {
  const seasons = seasonPodiums(rows);
  if (!seasons.some((entry) => entry.season === state.season)) state.season = seasons[0].season;
  const selected = seasons.find((entry) => entry.season === state.season);
  const champion = selected.podium[0];
  const teams = [...selected.teams].sort((a, b) => (a.finalRank ?? Infinity) - (b.finalRank ?? Infinity));
  return sectionHeading("YEAR BY YEAR", "Season archive", "Different team names. The same familiar competition.") +
    `<div class="season-picker" aria-label="Choose a season">${seasons.map(({ season }) => `<button type="button" data-season="${season}" class="${state.season === season ? "selected" : ""}" aria-pressed="${state.season === season}">${season}</button>`).join("")}</div>
    <div class="season-banner"><div>${platformTag(selected.platform)}<h3>${selected.season} season</h3><p>${teams.length} teams · Final playoff standings</p></div>
    <div class="season-winner"><span class="eyebrow gold">♛ CHAMPION</span><strong>${champion ? escapeHTML(champion[state.mode].name) : "Not yet crowned"}</strong></div></div>
    ${seasonTable(teams, false)}`;
}

function renderRecords(rows) {
  const groups = aggregate(rows, state.mode);
  const best = (key) => [...rows].sort((a, b) => b[key] - a[key] || b.season - a.season)[0];
  const mostWins = sortStandings(groups, "wins")[0];
  const mostTitles = sortStandings(groups, "titles")[0];
  const bestSeason = [...rows].sort((a, b) => (b.wins + b.ties / 2) / (b.wins + b.losses + b.ties || 1) -
    (a.wins + a.ties / 2) / (a.wins + a.losses + a.ties || 1) || b.pointsFor - a.pointsFor)[0];
  const cards = [
    { label: "MOST CAREER WINS", value: number(mostWins.wins), name: mostWins.name, note: `${mostWins.seasons.length} seasons · ${record(mostWins)}`, icon: "↗" },
    { label: "MOST CHAMPIONSHIPS", value: number(mostTitles.titles), name: mostTitles.name, note: "Final playoff placements", icon: "♛" },
    { label: "MOST POINTS IN A SEASON", value: number(best("pointsFor").pointsFor, 2), name: best("pointsFor")[state.mode].name,
      note: `${best("pointsFor").season} · ${best("pointsFor").team}`, icon: "✦" },
    { label: "BEST SEASON WIN RATE", value: percent((bestSeason.wins + bestSeason.ties / 2) / (bestSeason.wins + bestSeason.losses + bestSeason.ties || 1)),
      name: bestSeason[state.mode].name, note: `${bestSeason.season} · ${record(bestSeason)}`, icon: "↗" },
  ];
  return sectionHeading("THE RECORD BOOK", "Setting the standard", "Career milestones and regular-season high-water marks.") +
    `<div class="records-grid">${cards.map((card) => `<article class="record-card"><span class="record-icon" aria-hidden="true">${card.icon}</span>
      <span class="eyebrow">${card.label}</span><strong class="record-value">${card.value}</strong>
      <h3>${escapeHTML(card.name)}</h3><p>${escapeHTML(card.note)}</p></article>`).join("")}</div>
    <p class="section-footnote">Career ties use wins, win percentage, then points for. Season win-rate ties use points for; season point ties use the most recent season. Scoring rules differ across eras.</p>`;
}

function render() {
  const rows = history.filter((row) => state.era === "all" || row.platform === state.era);
  renderOverview(rows);
  const renderers = { standings: renderStandings, champions: renderChampions, seasons: renderSeasons, records: renderRecords };
  const context = { rows, analytics, acquisitions, tradeGrades, state, era: state.era, mode: state.mode };
  $("#view").innerHTML = renderers[state.view] ? renderers[state.view](rows) :
    state.view === "acquisitions" ? renderAcquisitions(context) : renderFeature(state.view, context);
  $("#view").setAttribute("aria-labelledby", "view-title");
  for (const button of document.querySelectorAll("[data-view]")) {
    const selected = button.dataset.view === state.view;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-pressed", String(selected));
  }
}

document.addEventListener("click", (event) => {
  const tradeLink = event.target.closest("[data-trade-report]");
  if (tradeLink) {
    const report = document.getElementById(`trade-${tradeLink.dataset.tradeReport}`);
    if (report) {
      event.preventDefault();
      report.closest(".trade-ledger").open = true;
      report.open = true;
      const summary = report.querySelector("summary");
      summary.focus();
      summary.scrollIntoView({ block: "start" });
    }
    return;
  }
  const button = event.target.closest("button");
  if (!button) return;
  if (button.dataset.view) {
    state.view = button.dataset.view;
    render();
  } else if (button.dataset.season) {
    state.season = Number(button.dataset.season);
    render();
    document.querySelector(`[data-season="${state.season}"]`)?.focus();
  } else if (button.dataset.game) {
    state.game = button.dataset.game;
    render();
    const detail = $(".game-detail");
    detail.setAttribute("tabindex", "-1");
    detail.focus();
    detail.scrollIntoView({ block: "nearest" });
  } else if (button.dataset.closeGame) {
    state.game = "";
    render();
    $("#view-title").setAttribute("tabindex", "-1");
    $("#view-title").focus();
  } else if (button.dataset.rivalA) {
    state.rivalA = button.dataset.rivalA;
    state.rivalB = button.dataset.rivalB;
    render();
    $("#rivalA").focus();
    $("#rivalA").scrollIntoView({ block: "center" });
  }
});
document.addEventListener("change", (event) => {
  if (!["era", "mode", "metric", "scope", "category", "rivalA", "rivalB", "playerManager",
    "position", "minStarts", "playerSort", "draftSeason", "draftManager", "acquisitionSeason",
    "acquisitionManager", "acquisitionScope"].includes(event.target.id)) return;
  state[event.target.id] = event.target.value;
  const id = event.target.id;
  render();
  $(`#${id}`)?.focus();
});
document.addEventListener("input", (event) => {
  if (!["search", "draftQuery"].includes(event.target.id)) return;
  const id = event.target.id;
  state[id] = event.target.value;
  const position = event.target.selectionStart;
  render();
  $(`#${id}`).focus();
  $(`#${id}`).setSelectionRange(position, position);
});

async function loadArchive() {
  const sources = await Promise.all(["espn", "sleeper"].map(async (platform) => {
    const [standings, crosswalk, matchups] = await Promise.all(["standings_all_seasons.csv", "crosswalk.csv", "matchups_all_seasons.csv"].map(async (filename) => {
      const url = new URL(`../../data/${platform}/${filename}`, import.meta.url);
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Could not load ${platform}/${filename} (HTTP ${response.status})`);
      return parseCSV(await response.text());
    }));
    return { platform, standings, crosswalk, matchups };
  }));
  history = buildHistory(sources);
  const detailResponse = await fetch(new URL("../../data/sleeper/details.json", import.meta.url));
  if (!detailResponse.ok) throw new Error(`Could not load Sleeper historical details (HTTP ${detailResponse.status})`);
  analytics = buildAnalytics(history, sources, await detailResponse.json());
  const [sleeperAcquisitions, espnAcquisitions] = await Promise.all(["sleeper", "espn"].map(async (platform) => {
    const response = await fetch(new URL(`../../data/${platform}/acquisitions.json`, import.meta.url));
    if (!response.ok) throw new Error(`Could not load ${platform} acquisition history (HTTP ${response.status})`);
    return response.json();
  }));
  acquisitions = [...attachAcquisitions(analytics, sources, sleeperAcquisitions, espnAcquisitions),
    ...attachESPN(analytics, espnAcquisitions)];
  tradeGrades = buildTradeGrades(history, sources, acquisitions, sleeperAcquisitions, espnAcquisitions);
  for (const platform of ["espn", "sleeper"]) {
    const seasons = history.filter((row) => row.platform === platform).map((row) => row.season);
    $(`#era option[value="${platform}"]`).textContent =
      `${platform === "espn" ? "ESPN" : "Sleeper"} · ${Math.min(...seasons)}–${Math.max(...seasons)}`;
  }
  $("#status").hidden = true;
  $("#archive").hidden = false;
  render();
}

loadArchive().catch((error) => {
  console.error("League archive failed to load", error);
  $("#archive").hidden = true;
  $("#status").setAttribute("role", "alert");
  $("#status").classList.add("error");
  $("#status").innerHTML = `<strong>The archive couldn’t load.</strong><p>${escapeHTML(error.message)}</p>
    <p>Serve the project through HTTP (not a file:// URL), and check that both data folders are included.</p><button type="button" id="retry">Try again</button>`;
  $("#retry").addEventListener("click", () => location.reload());
});
